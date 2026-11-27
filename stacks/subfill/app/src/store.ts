// subfill's own record of every episode and film it tracks, in SQLite under
// appdata so the nightly backup takes it along.
//
// One row per item, with a state:
//   waiting      Arabic is missing, a source exists, but Bazarr gets more time first
//   eligible     ready to translate
//   translating  being translated now
//   done         our machine translation sits beside the video
//   replaced     Bazarr found a human Arabic one later, and ours was deleted
//   gone         the video went away, and ours with it
//   failed       gave up after the allowed attempts; Retry puts it back
//   skipped      the owner said not to translate this one
//   no_source    Arabic is missing but there is no usable subtitle to translate from
import { DatabaseSync } from 'node:sqlite';
import { CRASH_PHRASES } from './ollama.ts';

export const STATES = [
  'waiting',
  'eligible',
  'translating',
  'done',
  'replaced',
  'gone',
  'failed',
  'skipped',
  'no_source',
] as const;
export type State = (typeof STATES)[number];

export type Item = {
  key: string;
  kind: 'episode' | 'movie';
  bazarr_id: number;
  title: string;
  video_path: string;
  source_path: string | null;
  source_lang: string | null;
  out_path: string | null;
  state: State;
  note: string | null;
  eligible_at: number;
  priority: number;
  attempts: number;
  first_seen: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
  // Kept for the PC until then: the mini leaves it alone while the owner is
  // asked whether to wake the PC.
  held_until: number | null;
  // The node that last took it: "mini" or "pc".
  node: string | null;
  // Times the model's runner died while translating it. Not attempts: a crash
  // is the machine's trouble, until one episode keeps causing it.
  crashes: number;
  // The show an episode belongs to (Sonarr's id); null for a film, or for an
  // episode not seen by a sync since this column was added.
  series_id: number | null;
  // Translated from the subtitle inside the video instead of a file beside
  // it: 'yes'. 'none:<reason>:<ctime>' once a look inside found nothing it
  // can read, so the sync stops offering that file. null otherwise.
  inside_track: string | null;
};

export type LogLine = { at: number; message: string };

// The note on an item set aside because its show or film is marked not to
// translate. Lifting the mark brings back only items carrying it, so an
// episode the owner skipped on its own stays skipped.
export const EXCLUDED_NOTE = 'not translated: you marked it so';

// Columns added after the first release, so a database made before them gains
// them at start. Each is nullable or has a default, so old rows need nothing.
const ADDED_COLUMNS: [string, string][] = [
  ['held_until', 'INTEGER'],
  ['node', 'TEXT'],
  ['crashes', 'INTEGER NOT NULL DEFAULT 0'],
  ['series_id', 'INTEGER'],
  ['inside_track', 'TEXT'],
];

// An item whose show or film is marked not to translate. The nodes never
// take one, whatever state it reached (an outage or a restart can put a
// marked item back to eligible); the next sync then sets it aside.
const MARKED = `EXISTS (SELECT 1 FROM excluded x WHERE x.key = items.key OR x.key = 'series:' || items.series_id)`;

// The order the nodes take ready items in: an item held for the PC, then a
// "translate now", then the one that crashed the model fewest times, then the
// newest video. Takes `now` once, for the hold.
const QUEUE_ORDER = '(held_until IS NOT NULL AND held_until > ?) DESC, priority DESC, crashes ASC, eligible_at DESC';

// What a failure from a runner crash said, before crashes stopped counting as
// attempts: Ollama's 5xx answer, kept in the note, in Ollama's own words.
const CRASH_NOTES = CRASH_PHRASES.map((p) => `%${p}%`);

export class Store {
  readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.db = new DatabaseSync(path);
    this.now = now;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS items (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        bazarr_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        video_path TEXT NOT NULL,
        source_path TEXT,
        source_lang TEXT,
        out_path TEXT,
        state TEXT NOT NULL,
        note TEXT,
        eligible_at INTEGER NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        first_seen INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        held_until INTEGER,
        node TEXT,
        crashes INTEGER NOT NULL DEFAULT 0,
        series_id INTEGER,
        inside_track TEXT
      );
      CREATE INDEX IF NOT EXISTS items_state ON items (state, priority, eligible_at);
      CREATE TABLE IF NOT EXISTS log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_key TEXT NOT NULL,
        at INTEGER NOT NULL,
        message TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS log_item ON log (item_key, id);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- Shows ("series:<id>") and films ("movie:<id>") the owner said never
      -- to translate.
      CREATE TABLE IF NOT EXISTS excluded (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
    `);
    const have = new Set((this.db.prepare('PRAGMA table_info(items)').all() as { name: string }[]).map((c) => c.name));
    for (const [name, type] of ADDED_COLUMNS) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE items ADD COLUMN ${name} ${type}`);
    }
  }

  close(): void {
    this.db.close();
  }

  // A translation the process was killed in the middle of starts over, and the
  // attempt it was on is given back: a restart is not the item's fault. Its
  // out_path stays, so the retry may overwrite the file it may have written.
  recoverInterrupted(): number {
    const r = this.db
      .prepare(
        `UPDATE items SET state = 'eligible', attempts = MAX(attempts - 1, 0), note = 'interrupted, will start again', updated_at = ?
         WHERE state = 'translating'`,
      )
      .run(this.now());
    return Number(r.changes);
  }

  // Episodes that gave up only because the model's runner kept dying under
  // them, from before crashes stopped counting as attempts: back in the queue
  // with their attempts cleared. Returns their keys. A later failure says
  // something else in its note, so this finds nothing once they have run.
  requeueCrashFailures(): string[] {
    const where = `state = 'failed' AND note LIKE 'Ollama answered 5%' AND (${CRASH_NOTES.map(() => 'note LIKE ?').join(' OR ')})`;
    const keys = (this.db.prepare(`SELECT key FROM items WHERE ${where}`).all(...CRASH_NOTES) as { key: string }[]).map((r) => r.key);
    this.db
      .prepare(
        `UPDATE items SET state = 'eligible', attempts = 0, crashes = 0, eligible_at = ?, updated_at = ?,
           note = 'tried again: it failed only because the model crashed' WHERE ${where}`,
      )
      .run(this.now(), this.now(), ...CRASH_NOTES);
    return keys;
  }

  // Other items that recorded the same subtitle path: episodes sharing one file.
  sharing(outPath: string, exceptKey: string): Item[] {
    return this.db.prepare('SELECT * FROM items WHERE out_path = ? AND key != ?').all(outPath, exceptKey) as Item[];
  }

  // Eligible items whose time has come, as opposed to ones waiting out a retry delay.
  readyCount(now: number): number {
    return Number(
      (this.db.prepare(`SELECT COUNT(*) AS n FROM items WHERE state = 'eligible' AND eligible_at <= ? AND NOT ${MARKED}`).get(now) as { n: number }).n,
    );
  }

  get(key: string): Item | undefined {
    return this.db.prepare('SELECT * FROM items WHERE key = ?').get(key) as Item | undefined;
  }

  all(): Item[] {
    return this.db.prepare('SELECT * FROM items').all() as Item[];
  }

  insert(
    item: Omit<
      Item,
      'priority' | 'attempts' | 'first_seen' | 'updated_at' | 'started_at' | 'finished_at' | 'held_until' | 'node' | 'crashes' | 'series_id' | 'inside_track'
    > & { series_id?: number | null; inside_track?: string | null },
  ): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO items (key, kind, bazarr_id, title, video_path, source_path, source_lang, out_path, state, note, eligible_at, first_seen, updated_at, series_id, inside_track)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.key,
        item.kind,
        item.bazarr_id,
        item.title,
        item.video_path,
        item.source_path,
        item.source_lang,
        item.out_path,
        item.state,
        item.note,
        item.eligible_at,
        now,
        now,
        item.series_id ?? null,
        item.inside_track ?? null,
      );
  }

  update(key: string, fields: Partial<Omit<Item, 'key'>>): void {
    const names = Object.keys(fields);
    if (!names.length) return;
    const sets = names.map((n) => `${n} = ?`).join(', ');
    const values = names.map((n) => (fields as Record<string, string | number | null>)[n]);
    this.db.prepare(`UPDATE items SET ${sets}, updated_at = ? WHERE key = ?`).run(...values, this.now(), key);
  }

  // Moves an item between states only if it is still in the one expected, so
  // two callers can never both act on it. True when this caller won.
  move(key: string, from: State[], to: State, fields: Partial<Omit<Item, 'key' | 'state'>> = {}): boolean {
    const names = Object.keys(fields);
    const sets = names.map((n) => `, ${n} = ?`).join('');
    const values = names.map((n) => (fields as Record<string, string | number | null>)[n]);
    const marks = from.map(() => '?').join(', ');
    const r = this.db
      .prepare(`UPDATE items SET state = ?${sets}, updated_at = ? WHERE key = ? AND state IN (${marks})`)
      .run(to, ...values, this.now(), key, ...from);
    return Number(r.changes) === 1;
  }

  remove(key: string): void {
    this.db.prepare('DELETE FROM items WHERE key = ?').run(key);
    this.db.prepare('DELETE FROM log WHERE item_key = ?').run(key);
  }

  // The next item to translate: a "translate now" first, then the one that
  // crashed the model fewest times, then the newest video. Crashes last: when
  // the machine keeps crashing (the mini short of memory), each crash lands on
  // a different episode instead of five in a row failing the same one, and
  // only an episode that really does crash the model reaches MAX_CRASHES. An item that failed waits out its retry delay first. An item held
  // for the PC is the PC's first pick, and the mini's only once the hold ends.
  // A video another node is already translating is skipped: the episodes of a
  // two-episode file share one subtitle, which the first to finish writes.
  next(now: number, takesHeld = false): Item | undefined {
    return this.db
      .prepare(
        `SELECT * FROM items WHERE state = 'eligible' AND eligible_at <= ?
           AND (held_until IS NULL OR held_until <= ? OR ?)
           AND video_path NOT IN (SELECT video_path FROM items WHERE state = 'translating')
           AND NOT ${MARKED}
         ORDER BY ${QUEUE_ORDER} LIMIT 1`,
      )
      .get(now, now, takesHeld ? 1 : 0, now) as Item | undefined;
  }

  // The ready items in the order the nodes will take them, for the page. The
  // same order and filter as next(), so what the queue shows first is what
  // runs first. An episode sharing its video with one being translated is
  // left out: it is done when that one is.
  queue(now: number, limit: number): Item[] {
    return this.db
      .prepare(
        `SELECT * FROM items WHERE state = 'eligible' AND eligible_at <= ?
           AND video_path NOT IN (SELECT video_path FROM items WHERE state = 'translating')
           AND NOT ${MARKED}
         ORDER BY ${QUEUE_ORDER} LIMIT ?`,
      )
      .all(now, now, limit) as Item[];
  }

  // The ready items the queue page shows, in their order, for moving by hand.
  private readyOrder(now: number): { key: string; priority: number }[] {
    return this.db
      .prepare(
        `SELECT key, priority FROM items WHERE state = 'eligible' AND eligible_at <= ?
           AND video_path NOT IN (SELECT video_path FROM items WHERE state = 'translating')
           AND NOT ${MARKED} ORDER BY ${QUEUE_ORDER}`,
      )
      .all(now, now) as { key: string; priority: number }[];
  }

  // Moves a ready item by hand: to the top, one up, one down, or to the
  // bottom. The order is the priority (higher first), so the items from the
  // top down to where it lands are renumbered in their new order, above
  // every item after them; the rest keep theirs. An item held for the PC
  // stays first whatever its priority. False when the item is not ready.
  place(key: string, where: 'top' | 'up' | 'down' | 'bottom', now: number): boolean {
    this.db.exec('BEGIN');
    try {
      const order = this.readyOrder(now);
      const from = order.findIndex((r) => r.key === key);
      if (from < 0) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const to = where === 'top' ? 0 : where === 'up' ? Math.max(0, from - 1) : where === 'down' ? Math.min(order.length - 1, from + 1) : order.length - 1;
      const [moved] = order.splice(from, 1);
      order.splice(to, 0, moved);
      const set = this.db.prepare('UPDATE items SET priority = ?, updated_at = ? WHERE key = ?');
      if (where === 'bottom') {
        // Below every other ready item, without renumbering them all.
        const lowest = Math.min(0, ...order.slice(0, -1).map((r) => r.priority));
        set.run(lowest - 1, this.now(), key);
      } else {
        const head = order.slice(0, Math.max(from, to) + 1);
        const rest = order.slice(head.length);
        const base = Math.max(0, ...rest.map((r) => r.priority)) + 1;
        head.forEach((r, i) => set.run(base + head.length - 1 - i, this.now(), r.key));
      }
      this.db.exec('COMMIT');
      return true;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // Puts these items first, in this order: the ones ready or waiting for
  // Bazarr become ready now, a failed one starts over, a skipped or done one
  // is left as it is. Returns the keys it moved.
  putFirst(keys: string[], now: number): string[] {
    this.db.exec('BEGIN');
    try {
      const top = Math.max(0, ...this.readyOrder(now).map((r) => r.priority));
      const take = this.db.prepare(
        `UPDATE items SET state = 'eligible', priority = ?, eligible_at = ?, held_until = NULL,
           attempts = CASE WHEN state = 'failed' THEN 0 ELSE attempts END,
           crashes = CASE WHEN state = 'failed' THEN 0 ELSE crashes END,
           note = CASE WHEN state = 'failed' THEN NULL ELSE note END, updated_at = ?
         WHERE key = ? AND state IN ('waiting', 'eligible', 'failed') AND NOT ${MARKED}`,
      );
      const moved = keys.filter((k, i) => Number(take.run(top + keys.length - i, now, this.now(), k).changes) === 1);
      this.db.exec('COMMIT');
      return moved;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // Items in a state, the most recently changed first.
  inState(state: State, limit: number): Item[] {
    return this.db.prepare('SELECT * FROM items WHERE state = ? ORDER BY updated_at DESC LIMIT ?').all(state, limit) as Item[];
  }

  // Machine subtitles written most recently.
  recentlyFinished(limit: number): Item[] {
    return this.db
      .prepare(`SELECT * FROM items WHERE state = 'done' AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT ?`)
      .all(limit) as Item[];
  }

  // Eligible items sitting out a retry delay, the soonest first.
  retrying(now: number, limit: number): Item[] {
    return this.db
      .prepare(`SELECT * FROM items WHERE state = 'eligible' AND eligible_at > ? ORDER BY eligible_at ASC LIMIT ?`)
      .all(now, limit) as Item[];
  }

  // Waiting items, the ones whose wait ends soonest first.
  waitingSoonest(limit: number): Item[] {
    return this.db.prepare(`SELECT * FROM items WHERE state = 'waiting' ORDER BY eligible_at ASC LIMIT ?`).all(limit) as Item[];
  }

  // Keeps the item the mini would take next for the PC until `until`, or
  // moves an existing hold to the new time. Returns the held item.
  hold(now: number, until: number): Item | undefined {
    const held = this.db.prepare('SELECT * FROM items WHERE state = ? AND held_until > ? LIMIT 1').get('eligible', now) as Item | undefined;
    const item = held ?? this.next(now);
    if (!item) return undefined;
    this.db.prepare('UPDATE items SET held_until = ? WHERE key = ?').run(until, item.key);
    return { ...item, held_until: until };
  }

  // Ends every hold: the mini may take those items again.
  releaseHolds(): number {
    return Number(this.db.prepare('UPDATE items SET held_until = NULL WHERE held_until IS NOT NULL').run().changes);
  }

  // The item held for the PC right now, if any.
  heldNow(now: number): Item | undefined {
    return this.db.prepare(`SELECT * FROM items WHERE state = 'eligible' AND held_until > ? LIMIT 1`).get(now) as Item | undefined;
  }

  log(key: string, message: string): void {
    this.db.prepare('INSERT INTO log (item_key, at, message) VALUES (?, ?, ?)').run(key, this.now(), message);
  }

  logFor(key: string, limit = 200): LogLine[] {
    return (
      this.db.prepare('SELECT at, message FROM log WHERE item_key = ? ORDER BY id DESC LIMIT ?').all(key, limit) as LogLine[]
    ).reverse();
  }

  counts(): Record<State, number> {
    const out = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<State, number>;
    for (const r of this.db.prepare('SELECT state, COUNT(*) AS n FROM items GROUP BY state').all() as { state: State; n: number }[]) {
      out[r.state] = Number(r.n);
    }
    return out;
  }

  list(opts: { state?: State; q?: string; limit: number }): { items: Item[]; total: number } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.state) {
      where.push('state = ?');
      args.push(opts.state);
    }
    if (opts.q) {
      where.push('title LIKE ?');
      args.push(`%${opts.q.replace(/[%_]/g, '')}%`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM items ${clause}`).get(...args) as { n: number }).n);
    const items = this.db
      .prepare(`SELECT * FROM items ${clause} ORDER BY updated_at DESC LIMIT ?`)
      .all(...args, opts.limit) as Item[];
    return { items, total };
  }

  // The newest log lines across every item, with the item's title when it is
  // still tracked.
  recentLog(limit: number): (LogLine & { key: string; title: string | null })[] {
    return this.db
      .prepare(
        `SELECT log.item_key AS key, log.at, log.message, items.title FROM log
         LEFT JOIN items ON items.key = log.item_key ORDER BY log.id DESC LIMIT ?`,
      )
      .all(limit) as (LogLine & { key: string; title: string | null })[];
  }

  // Finished translations since a time, per node: how many and how long each took.
  finishedByNode(since: number): { node: string; count: number; avgSeconds: number }[] {
    return (
      this.db
        .prepare(
          `SELECT node, COUNT(*) AS n, AVG((finished_at - started_at) / 1000.0) AS avg FROM items
           WHERE finished_at >= ? AND started_at IS NOT NULL AND node IS NOT NULL AND state IN ('done', 'replaced', 'gone')
           GROUP BY node`,
        )
        .all(since) as { node: string; n: number; avg: number }[]
    ).map((r) => ({ node: r.node, count: Number(r.n), avgSeconds: Number(r.avg) }));
  }

  // Finished translations since a time, and their average length in seconds.
  finishedSince(since: number): { count: number; avgSeconds: number | null } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n, AVG((finished_at - started_at) / 1000.0) AS avg FROM items
         WHERE finished_at >= ? AND started_at IS NOT NULL AND state IN ('done', 'replaced', 'gone')`,
      )
      .get(since) as { n: number; avg: number | null };
    return { count: Number(r.n), avgSeconds: r.avg === null ? null : Number(r.avg) };
  }

  isExcluded(key: string): boolean {
    return this.db.prepare('SELECT 1 FROM excluded WHERE key = ?').get(key) !== undefined;
  }

  isItemMarked(key: string): boolean {
    return this.db.prepare(`SELECT 1 FROM items WHERE key = ? AND ${MARKED}`).get(key) !== undefined;
  }

  // Marks a show or film as not to translate, or lifts the mark, and moves its
  // items with it in one transaction: on, the ones not yet translated are
  // set aside; off, the ones the mark set aside go back to waiting, for the
  // next sync to sort out. Items being translated finish, and machine
  // subtitles already written stay. The items are found by their own show id
  // and by `itemKeys` (the library's list, for rows not synced since the
  // show id was recorded). Returns how many items moved.
  setExcluded(key: string, on: boolean, itemKeys: string[]): number {
    const series = key.match(/^series:(\d+)$/);
    const match = `(key = ? OR series_id = ?${itemKeys.length ? ` OR key IN (${itemKeys.map(() => '?').join(', ')})` : ''})`;
    const args = [key, series ? Number(series[1]) : -1, ...itemKeys];
    this.db.exec('BEGIN');
    try {
      let moved: number;
      if (on) {
        this.db.prepare('INSERT OR IGNORE INTO excluded (key, at) VALUES (?, ?)').run(key, this.now());
        moved = Number(
          this.db
            .prepare(
              `UPDATE items SET state = 'skipped', note = ?, priority = 0, held_until = NULL, updated_at = ?
               WHERE state IN ('waiting', 'eligible', 'failed', 'no_source') AND ${match}`,
            )
            .run(EXCLUDED_NOTE, this.now(), ...args).changes,
        );
      } else {
        this.db.prepare('DELETE FROM excluded WHERE key = ?').run(key);
        moved = Number(
          this.db
            .prepare(
              `UPDATE items SET state = 'waiting', note = NULL, crashes = 0, eligible_at = ?, updated_at = ?
               WHERE state = 'skipped' AND note = ? AND ${match}`,
            )
            .run(this.now(), this.now(), EXCLUDED_NOTE, ...args).changes,
        );
      }
      this.db.exec('COMMIT');
      return moved;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  deleteMeta(key: string): void {
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
  }
}
