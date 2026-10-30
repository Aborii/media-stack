// The hours translation may start in, as "22-7" (wraps past midnight) or
// "1-6". Empty means any hour. A translation that started inside the window
// is allowed to finish after it closes.

export type Hours = { from: number; to: number } | null;

export function parseHours(text: string): Hours {
  const t = text.trim();
  if (!t) return null;
  const m = t.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) throw new Error(`ACTIVE_HOURS must look like 22-7, not "${text}"`);
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (from > 23 || to > 24 || from === to) throw new Error(`ACTIVE_HOURS "${text}" is not a range of hours`);
  return { from, to };
}

export function inHours(hours: Hours, date: Date): boolean {
  if (!hours) return true;
  const h = date.getHours();
  return hours.from < hours.to ? h >= hours.from && h < hours.to : h >= hours.from || h < hours.to;
}
