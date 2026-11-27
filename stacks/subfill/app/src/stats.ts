// The history behind the stats page, read from the log subfill already
// keeps: every finished translation logs "wrote <file> (<n> cues in <m> min
// on the <node>...)", so nothing new is recorded and the history goes back
// to the first translation. Days are the server's local days, which compose
// sets to the owner's zone.
import type { DatabaseSync } from 'node:sqlite';

export type Done = { key: string; title: string; at: number; cues: number; minutes: number; node: string };

export type DayEvents = {
  done: Done[];
  failed: { key: string; title: string; at: number; message: string }[];
  found: number;
  added: number;
  yours: { key: string; title: string; at: number; message: string }[];
};

const WROTE = /\((\d+) cues in (\d+) min on the (\w+)/;

type LogRow = { key: string; at: number; message: string; title: string | null };

// Every finished translation, oldest first.
export function completions(db: DatabaseSync, since = 0, until = Number.MAX_SAFE_INTEGER): Done[] {
  const rows = db
    .prepare(
      `SELECT log.item_key AS key, log.at, log.message, items.title FROM log LEFT JOIN items ON items.key = log.item_key
       WHERE log.message LIKE 'wrote %' AND log.at >= ? AND log.at < ? ORDER BY log.at`,
    )
    .all(since, until) as LogRow[];
  return rows.map((r) => {
    const m = r.message.match(WROTE);
    return { key: r.key, title: r.title ?? r.key, at: r.at, cues: m ? Number(m[1]) : 0, minutes: m ? Number(m[2]) : 0, node: m ? m[3] : '?' };
  });
}

// Local midnight of the day holding `ms`, and the next one.
export function dayBounds(ms: number): [number, number] {
  const d = new Date(ms);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return [start, next];
}

// "2026-11-27" for a local day, and back. A string that is not a real date gives null.
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function parseDay(text: string | null): number | null {
  const m = text?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return dayKey(d.getTime()) === text ? d.getTime() : null;
}

// Finished translations per local day for the `days` days ending with the
// one holding `now`, counted per node.
export function perDay(done: Done[], now: number, days: number): { day: number; byNode: Record<string, number> }[] {
  const out: { day: number; byNode: Record<string, number> }[] = [];
  const [today] = dayBounds(now);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    out.push({ day: new Date(d.getFullYear(), d.getMonth(), d.getDate() - i).getTime(), byNode: {} });
  }
  const index = new Map(out.map((o, i) => [dayKey(o.day), i]));
  for (const c of done) {
    const i = index.get(dayKey(c.at));
    if (i !== undefined) out[i].byNode[c.node] = (out[i].byNode[c.node] ?? 0) + 1;
  }
  return out;
}

// Finished translations per hour of one day, per node.
export function perHour(done: Done[], day: number): Record<string, number>[] {
  const [start, next] = dayBounds(day);
  const out: Record<string, number>[] = Array.from({ length: 24 }, () => ({}));
  for (const c of done) {
    if (c.at < start || c.at >= next) continue;
    const h = new Date(c.at).getHours();
    out[h][c.node] = (out[h][c.node] ?? 0) + 1;
  }
  return out;
}

// What happened on one day besides the translations: failures, Arabic
// Bazarr found (so ours went), items newly missing Arabic, and the owner's
// own actions.
export function dayEvents(db: DatabaseSync, day: number): DayEvents {
  const [start, next] = dayBounds(day);
  const rows = db
    .prepare(`SELECT log.item_key AS key, log.at, log.message, items.title FROM log LEFT JOIN items ON items.key = log.item_key WHERE log.at >= ? AND log.at < ? ORDER BY log.at`)
    .all(start, next) as LogRow[];
  const ev: DayEvents = { done: completions(db, start, next), failed: [], found: 0, added: 0, yours: [] };
  for (const r of rows) {
    const title = r.title ?? r.key;
    if (r.message.startsWith('failed')) ev.failed.push({ key: r.key, title, at: r.at, message: r.message });
    else if (r.message.startsWith('Bazarr found an Arabic')) ev.found++;
    else if (r.message.startsWith('Arabic missing in Bazarr')) ev.added++;
    else if (/^you (chose|marked|lifted)/.test(r.message)) ev.yours.push({ key: r.key, title, at: r.at, message: r.message });
  }
  return ev;
}
