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
};

export type LogLine = { at: number; message: string };

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
        finished_at INTEGER
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
    `);
  }

  close(): void {
    this.db.close();
  }

  // A translation the process was killed in the middle of starts over. Its
  // out_path stays, so the retry may overwrite the file it may have written.
  recoverInterrupted(): number {
    const r = this.db
      .prepare(`UPDATE items SET state = 'eligible', note = 'interrupted, will start again', updated_at = ? WHERE state = 'translating'`)
      .run(this.now());
    return Number(r.changes);
  }

  get(key: string): Item | undefined {
    return this.db.prepare('SELECT * FROM items WHERE key = ?').get(key) as Item | undefined;
  }

  all(): Item[] {
    return this.db.prepare('SELECT * FROM items').all() as Item[];
  }

  insert(item: Omit<Item, 'priority' | 'attempts' | 'first_seen' | 'updated_at' | 'started_at' | 'finished_at'>): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO items (key, kind, bazarr_id, title, video_path, source_path, source_lang, out_path, state, note, eligible_at, first_seen, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  // The next item to translate: a "translate now" first, then the newest
  // video. An item that failed waits out its retry delay first.
  next(now: number): Item | undefined {
    return this.db
      .prepare(`SELECT * FROM items WHERE state = 'eligible' AND eligible_at <= ? ORDER BY priority DESC, eligible_at DESC LIMIT 1`)
      .get(now) as Item | undefined;
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
