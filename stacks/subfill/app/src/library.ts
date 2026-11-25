// A copy of Bazarr's library, for the page: every show, every episode with a
// file, every film, and the subtitles beside each. subfill's own items table
// holds only what lacks Arabic; this is what lets the page list whole shows
// and say, for each episode, which Arabic it has and why.
//
// It is only ever read by the page. The sync loop replaces it in one
// transaction after a full read of Bazarr, so a read that fails partway
// leaves the last good copy in place, and the page says how old it is.
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Library as BazarrLibrary, Subtitle } from './bazarr.ts';
import type { Item } from './store.ts';

// Where an episode or film stands for Arabic, the first that fits:
//   human        Bazarr lists an Arabic subtitle (a file or a track in the
//                video) and no longer wants one: the same test the worker uses
//   machine      ours is in use
//   ready        in the queue, its time has come
//   retrying     in the queue, sitting out the delay after a failed try
//   translating  being translated now, marked or not
//   excluded     its show or film is marked not to translate
//   waiting, failed, skipped, no_source   as subfill's item
//   missing      Bazarr wants Arabic and subfill has not looked yet (next sync)
//   not_wanted   no Arabic, and Bazarr's profile for it does not ask for any
export const ARABIC_STATUSES = [
  'human',
  'machine',
  'translating',
  'ready',
  'retrying',
  'waiting',
  'failed',
  'skipped',
  'no_source',
  'missing',
  'not_wanted',
  'excluded',
] as const;
export type ArabicStatus = (typeof ARABIC_STATUSES)[number];

// The one place the status is worked out, used by every list so a show's
// counts and its episode rows can never disagree. `l` is the library row,
// `i` the item joined to it. Takes `now` once, as its first parameter.
const STATUS_SQL = `CASE
  WHEN l.target_human = 1 AND l.target_missing = 0 THEN 'human'
  WHEN i.state = 'done' THEN 'machine'
  WHEN i.state = 'translating' THEN 'translating'
  WHEN EXISTS (SELECT 1 FROM excluded x WHERE x.key = CASE l.kind WHEN 'episode' THEN 'series:' || l.show_id ELSE l.key END) THEN 'excluded'
  WHEN i.state = 'eligible' AND i.eligible_at > ? THEN 'retrying'
  WHEN i.state = 'eligible' THEN 'ready'
  WHEN i.state IN ('translating', 'waiting', 'failed', 'skipped', 'no_source') THEN i.state
  WHEN l.target_missing = 1 THEN 'missing'
  ELSE 'not_wanted' END`;

export type StatusCounts = Record<ArabicStatus, number>;

export type Show = {
  id: number;
  title: string;
  year: string | null;
  // The library folder it lives in: tv, anime, arabic-shows.
  folder: string;
  ended: boolean;
  // Marked by the owner not to translate.
  excluded: boolean;
  episodes: number;
  counts: StatusCounts;
};

export type Entry = {
  key: string;
  kind: 'episode' | 'movie';
  showId: number | null;
  season: number | null;
  episode: number | null;
  title: string;
  path: string;
  subtitles: Subtitle[];
  status: ArabicStatus;
  // Its show or film is marked not to translate.
  marked: boolean;
  // subfill's item for it, when it has one.
  item: Item | null;
};

type EntryRow = {
  key: string;
  kind: 'episode' | 'movie';
  show_id: number | null;
  season: number | null;
  episode: number | null;
  title: string;
  path: string;
  subtitles: string;
  status: ArabicStatus;
  marked: number;
  item_json: string | null;
};

export function emptyCounts(): StatusCounts {
  return Object.fromEntries(ARABIC_STATUSES.map((s) => [s, 0])) as StatusCounts;
}

export class LibraryStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
    db.exec(`
      CREATE TABLE IF NOT EXISTS shows (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        year TEXT,
        folder TEXT NOT NULL,
        ended INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS library (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        show_id INTEGER,
        season INTEGER,
        episode INTEGER,
        title TEXT NOT NULL,
        path TEXT NOT NULL,
        subtitles TEXT NOT NULL,
        target_human INTEGER NOT NULL,
        target_missing INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS library_show ON library (show_id, season, episode);
      CREATE INDEX IF NOT EXISTS library_kind ON library (kind, title);
    `);
  }

  // Replaces the copy with a fresh read, all or nothing.
  replace(lib: BazarrLibrary, target: string): void {
    const show = this.db.prepare('INSERT INTO shows (id, title, year, folder, ended) VALUES (?, ?, ?, ?, ?)');
    const entry = this.db.prepare(
      `INSERT OR REPLACE INTO library (key, kind, show_id, season, episode, title, path, subtitles, target_human, target_missing)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM shows; DELETE FROM library;');
      for (const s of lib.series) {
        show.run(s.id, s.title, s.year, path.basename(path.dirname(s.path)) || '-', s.ended ? 1 : 0);
      }
      for (const e of lib.entries) {
        const human = e.subtitles.some((s) => s.code2 === target && !s.forced);
        entry.run(
          e.key,
          e.kind,
          e.seriesId,
          e.season,
          e.episode,
          e.title,
          e.path,
          JSON.stringify(e.subtitles),
          human ? 1 : 0,
          e.missing.includes(target) ? 1 : 0,
        );
      }
      this.setMeta('library_at', String(this.now()));
      this.db.prepare("DELETE FROM meta WHERE key = 'library_error'").run();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // Reads the library and keeps it, or keeps the last copy and records why
  // not. Returns the problem, or null.
  async refresh(read: () => Promise<BazarrLibrary>, target: string): Promise<string | null> {
    try {
      this.replace(await read(), target);
      return null;
    } catch (err) {
      const message = (err as Error).message;
      this.setMeta('library_error', message);
      return message;
    }
  }

  // When the copy was last taken, and why the newest read failed, if it did.
  freshness(): { at: number | null; error: string | null } {
    const at = this.getMeta('library_at');
    return { at: at ? Number(at) : null, error: this.getMeta('library_error') };
  }

  // Every show with its episodes counted by Arabic status, by title.
  shows(): Show[] {
    const shows = this.db
      .prepare(
        `SELECT id, title, year, folder, ended, EXISTS (SELECT 1 FROM excluded x WHERE x.key = 'series:' || shows.id) AS excluded
         FROM shows ORDER BY title COLLATE NOCASE`,
      )
      .all() as { id: number; title: string; year: string | null; folder: string; ended: number; excluded: number }[];
    const rows = this.db
      .prepare(
        `SELECT l.show_id AS id, ${STATUS_SQL} AS status, COUNT(*) AS n
         FROM library l LEFT JOIN items i ON i.key = l.key WHERE l.kind = 'episode' GROUP BY l.show_id, status`,
      )
      .all(this.now()) as { id: number; status: ArabicStatus; n: number }[];
    const counts = new Map<number, StatusCounts>();
    for (const r of rows) {
      const c = counts.get(r.id) ?? emptyCounts();
      c[r.status] = Number(r.n);
      counts.set(r.id, c);
    }
    return shows.map((s) => {
      const c = counts.get(s.id) ?? emptyCounts();
      return { ...s, ended: Boolean(s.ended), excluded: Boolean(s.excluded), episodes: Object.values(c).reduce((a, b) => a + b, 0), counts: c };
    });
  }

  show(id: number): { show: Show; episodes: Entry[] } | null {
    const show = this.shows().find((s) => s.id === id);
    if (!show) return null;
    const rows = this.db
      .prepare(`${ENTRY_SELECT} WHERE l.show_id = ? AND l.kind = 'episode' ORDER BY l.season, l.episode`)
      .all(this.now(), id) as EntryRow[];
    return { show, episodes: rows.map(toEntry) };
  }

  // Films, by title, optionally only those with a status and matching a search.
  // `marked` picks the films marked not to translate, or those that are not.
  movies(opts: { statuses?: ArabicStatus[]; marked?: boolean; q?: string; limit: number }): { movies: Entry[]; total: number } {
    const where = [`kind = 'movie'`];
    const args: (string | number)[] = [this.now()];
    if (opts.marked !== undefined) where.push(`marked = ${opts.marked ? 1 : 0}`);
    if (opts.statuses?.length) {
      where.push(`status IN (${opts.statuses.map(() => '?').join(', ')})`);
      args.push(...opts.statuses);
    }
    if (opts.q) {
      where.push('title LIKE ?');
      args.push(`%${opts.q.replace(/[%_]/g, '')}%`);
    }
    const inner = `SELECT * FROM (${ENTRY_SELECT}) WHERE ${where.join(' AND ')}`;
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM (${inner})`).get(...args) as { n: number }).n);
    const rows = this.db.prepare(`${inner} ORDER BY title COLLATE NOCASE LIMIT ?`).all(...args, opts.limit) as EntryRow[];
    return { movies: rows.map(toEntry), total };
  }

  // The whole library counted by Arabic status, episodes and films apart.
  coverage(): { episode: StatusCounts; movie: StatusCounts } {
    const out = { episode: emptyCounts(), movie: emptyCounts() };
    const rows = this.db
      .prepare(`SELECT l.kind AS kind, ${STATUS_SQL} AS status, COUNT(*) AS n FROM library l LEFT JOIN items i ON i.key = l.key GROUP BY l.kind, status`)
      .all(this.now()) as { kind: 'episode' | 'movie'; status: ArabicStatus; n: number }[];
    for (const r of rows) out[r.kind][r.status] = Number(r.n);
    return out;
  }

  // A show's episodes, for marking them all at once.
  episodeKeys(showId: number): string[] {
    return (this.db.prepare(`SELECT key FROM library WHERE show_id = ? AND kind = 'episode'`).all(showId) as { key: string }[]).map((r) => r.key);
  }

  // The library entry behind an item, for its page: which show it is in.
  entry(key: string): Entry | null {
    const row = this.db.prepare(`${ENTRY_SELECT} WHERE l.key = ?`).get(this.now(), key) as EntryRow | undefined;
    return row ? toEntry(row) : null;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  private getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }
}

// The item rides along as JSON, so one query gives each row its item.
const ENTRY_SELECT = `SELECT l.key, l.kind, l.show_id, l.season, l.episode, l.title, l.path, l.subtitles, ${STATUS_SQL} AS status,
  EXISTS (SELECT 1 FROM excluded x WHERE x.key = CASE l.kind WHEN 'episode' THEN 'series:' || l.show_id ELSE l.key END) AS marked,
  CASE WHEN i.key IS NULL THEN NULL ELSE json_object(
    'key', i.key, 'kind', i.kind, 'bazarr_id', i.bazarr_id, 'title', i.title, 'video_path', i.video_path,
    'source_path', i.source_path, 'source_lang', i.source_lang, 'out_path', i.out_path, 'state', i.state,
    'note', i.note, 'eligible_at', i.eligible_at, 'priority', i.priority, 'attempts', i.attempts,
    'first_seen', i.first_seen, 'updated_at', i.updated_at, 'started_at', i.started_at,
    'finished_at', i.finished_at, 'held_until', i.held_until, 'node', i.node, 'crashes', i.crashes) END AS item_json
  FROM library l LEFT JOIN items i ON i.key = l.key`;

function toEntry(r: EntryRow): Entry {
  return {
    key: r.key,
    kind: r.kind,
    showId: r.show_id,
    season: r.season,
    episode: r.episode,
    title: r.title,
    path: r.path,
    subtitles: JSON.parse(r.subtitles) as Subtitle[],
    status: r.status,
    marked: Boolean(r.marked),
    item: r.item_json ? (JSON.parse(r.item_json) as Item) : null,
  };
}
