// Stats: how much subfill has translated and when. Totals, a bar per day for
// the last 30 days and a bar per hour of the chosen day (each split by node),
// each node's pace, and a day's log: what was translated, what failed, what
// Bazarr found, and what you did.
import { completions, dayBounds, dayEvents, dayKey, perDay, perHour, type Done } from '../stats.ts';
import { esc, itemLink, page, pageHeader, span } from './layout.ts';
import type { View } from './view.ts';

// The nodes in a fixed order, each with its own colour (validated for both
// themes against the card surfaces); any other node falls back to grey.
const NODES = ['pc', 'mini'] as const;
const NODE_NAME: Record<string, string> = { pc: 'PC (GPU)', mini: 'Mini (CPU)' };

// "27 Nov" and "Thu 27 Nov".
const short = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const long = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
const time = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

type Column = { label: string; tip: string; href?: string; values: Record<string, number>; on?: boolean };

// A stacked bar chart in SVG: one column per entry, the nodes stacked from
// the baseline in NODES order, a 2px gap between parts, a rounded top, faint
// gridlines, a hover tooltip per column, and every `labelEvery`th label.
function bars(columns: Column[], opts: { height: number; labelEvery: number; aria: string }): string {
  const W = 1000;
  const H = opts.height;
  const top = 10;
  const bottom = 22;
  const left = 34;
  const plotH = H - top - bottom;
  const max = Math.max(1, ...columns.map((c) => Object.values(c.values).reduce((a, b) => a + b, 0)));
  // A round step for the gridlines.
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500].find((s) => max / s <= 4) ?? Math.ceil(max / 4);
  const yMax = Math.ceil(max / step) * step;
  const y = (v: number) => top + plotH - (v / yMax) * plotH;
  const slot = (W - left) / columns.length;
  const bw = Math.max(2, Math.min(28, slot * 0.62));
  const grid: string[] = [];
  for (let v = 0; v <= yMax; v += step) {
    grid.push(`<line x1="${left}" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid${v === 0 ? ' base' : ''}"/><text x="${left - 8}" y="${(y(v) + 4).toFixed(1)}" class="tick" text-anchor="end">${v}</text>`);
  }
  const cols = columns.map((c, i) => {
    const x = left + slot * i + (slot - bw) / 2;
    const parts: string[] = [];
    let base = top + plotH;
    const present = [...NODES, ...Object.keys(c.values).filter((k) => !(NODES as readonly string[]).includes(k))].filter((n) => c.values[n]);
    present.forEach((n, j) => {
      const h = (c.values[n] / yMax) * plotH;
      const gap = j > 0 ? 2 : 0;
      const yTop = base - h;
      const hh = Math.max(0, h - gap);
      const cls = `bar-${(NODES as readonly string[]).includes(n) ? n : 'other'}`;
      if (j === present.length - 1) {
        // The top part gets the rounded data end.
        const r = Math.min(4, hh, bw / 2);
        parts.push(
          `<path class="${cls}" d="M${x.toFixed(1)},${(base - gap).toFixed(1)}V${(yTop + r).toFixed(1)}Q${x.toFixed(1)},${yTop.toFixed(1)} ${(x + r).toFixed(1)},${yTop.toFixed(1)}H${(x + bw - r).toFixed(1)}Q${(x + bw).toFixed(1)},${yTop.toFixed(1)} ${(x + bw).toFixed(1)},${(yTop + r).toFixed(1)}V${(base - gap).toFixed(1)}Z"/>`,
        );
      } else {
        parts.push(`<rect class="${cls}" x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}"/>`);
      }
      base = yTop;
    });
    // The last label ends at its bar's right edge, so it is not cut off.
    const lx = i === columns.length - 1 ? x + bw : x + bw / 2;
    const label = i % opts.labelEvery === 0 || i === columns.length - 1 ? `<text x="${lx.toFixed(1)}" y="${H - 6}" class="tick${c.on ? ' on' : ''}" text-anchor="${i === columns.length - 1 ? 'end' : 'middle'}">${esc(c.label)}</text>` : '';
    // The hit area is the whole column, taller and wider than the bar.
    const hit = `<rect class="hit" x="${(left + slot * i).toFixed(1)}" y="${top}" width="${slot.toFixed(1)}" height="${plotH}"/>`;
    const body = `<title>${esc(c.tip)}</title>${hit}${parts.join('')}${label}`;
    return c.href ? `<a href="${esc(c.href)}" class="col${c.on ? ' on' : ''}">${body}</a>` : `<g class="col">${body}</g>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.aria)}">${grid.join('')}${cols.join('')}</svg>`;
}

function legend(): string {
  return `<div class="legend">${NODES.map((n) => `<span><i class="bar-${n}"></i>${esc(NODE_NAME[n])}</span>`).join('')}</div>`;
}

function tip(label: string, values: Record<string, number>): string {
  const total = Object.values(values).reduce((a, b) => a + b, 0);
  const parts = Object.entries(values)
    .filter(([, n]) => n)
    .map(([k, n]) => `${NODE_NAME[k] ?? k}: ${n}`);
  return `${label}: ${total} translated${parts.length > 1 ? ` (${parts.join(', ')})` : parts.length ? ` on the ${parts[0].split(':')[0]}` : ''}`;
}

// The same numbers as a table, for reading without the chart.
function asTable(rows: { label: string; values: Record<string, number> }[], first: string): string {
  return `<details class="as-table"><summary>Show as a table</summary><div class="wrap"><table><thead><tr><th>${first}</th>${NODES.map((n) => `<th class="num">${esc(NODE_NAME[n])}</th>`).join('')}<th class="num">Total</th></tr></thead><tbody>${rows
    .map((r) => `<tr><td>${esc(r.label)}</td>${NODES.map((n) => `<td class="num">${r.values[n] ?? 0}</td>`).join('')}<td class="num">${Object.values(r.values).reduce((a, b) => a + b, 0)}</td></tr>`)
    .join('')}</tbody></table></div></details>`;
}

function kpi(label: string, value: string, sub: string): string {
  return `<div class="card kpi"><span class="l">${esc(label)}</span><b>${esc(value)}</b><span class="sub">${esc(sub)}</span></div>`;
}

const sum = (list: Done[], f: (d: Done) => number) => list.reduce((a, d) => a + f(d), 0);

export function renderStats(v: View, day: number): string {
  const all = completions(v.store.db);
  const [today] = dayBounds(v.now);
  const [dayStart, dayEnd] = dayBounds(day);
  const isToday = dayStart === today;
  const within = (from: number, to = Number.MAX_SAFE_INTEGER) => all.filter((d) => d.at >= from && d.at < to);
  const onDay = within(dayStart, dayEnd);
  const week = within(v.now - 7 * 86400_000);
  const month = within(v.now - 30 * 86400_000);
  const avg = week.length ? Math.round((sum(week, (d) => d.minutes) / week.length) * 60) : null;

  const days = perDay(all, v.now, 30);
  const dayCols: Column[] = days.map((d) => ({
    label: short(d.day),
    tip: tip(long(d.day), d.byNode),
    href: `/stats?day=${dayKey(d.day)}`,
    values: d.byNode,
    on: d.day === dayStart,
  }));
  const hours = perHour(all, day);
  const hourCols: Column[] = hours.map((h, i) => ({ label: `${String(i).padStart(2, '0')}:00`, tip: tip(`${String(i).padStart(2, '0')}:00 to ${String(i + 1).padStart(2, '0')}:00`, h), values: h }));

  const nodes = [...new Set([...NODES, ...week.map((d) => d.node)])].map((n) => {
    const mine = week.filter((d) => d.node === n);
    const last = all.filter((d) => d.node === n).at(-1);
    return `<tr><td><i class="key bar-${(NODES as readonly string[]).includes(n) ? n : 'other'}"></i>${esc(NODE_NAME[n] ?? n)}</td><td class="num">${mine.length}</td><td class="num">${mine.length ? span(Math.round((sum(mine, (d) => d.minutes) / mine.length) * 60)) : '-'}</td><td class="num">${sum(mine, (d) => d.cues).toLocaleString('en')}</td><td class="num dim">${last ? `${short(last.at)} ${time(last.at)}` : '-'}</td></tr>`;
  });

  const ev = dayEvents(v.store.db, day);
  const doneRows = [...ev.done]
    .reverse()
    .map(
      (d) =>
        `<tr><td class="dim num">${time(d.at)}</td><td>${itemLink({ key: d.key, title: d.title })}</td><td><i class="key bar-${(NODES as readonly string[]).includes(d.node) ? d.node : 'other'}"></i>${esc(NODE_NAME[d.node] ?? d.node)}</td><td class="num">${d.cues}</td><td class="num">${d.minutes} min</td><td class="num"><a href="/subtitles?key=${encodeURIComponent(d.key)}">view</a></td></tr>`,
    )
    .join('');
  const listOf = (rows: { key: string; title: string; at: number; message: string }[]) =>
    rows
      .slice(-50)
      .reverse()
      .map((r) => `<tr><td class="dim num">${time(r.at)}</td><td>${itemLink({ key: r.key, title: r.title })}</td><td class="dim">${esc(r.message)}</td></tr>`)
      .join('');

  const prev = dayKey(new Date(new Date(dayStart).getFullYear(), new Date(dayStart).getMonth(), new Date(dayStart).getDate() - 1).getTime());
  const next = dayEnd <= today ? dayKey(dayEnd) : null;
  const picker = `<a class="btn" href="/stats?day=${prev}" title="The day before">&larr;</a><form method="get" action="/stats" class="inline"><input type="date" name="day" value="${dayKey(dayStart)}" max="${dayKey(today)}" onchange="this.form.submit()"></form>${next ? `<a class="btn" href="/stats?day=${next}" title="The day after">&rarr;</a>` : '<span class="btn ghost">&rarr;</span>'}${isToday ? '' : '<a class="btn" href="/stats">Today</a>'}`;

  const body = `${pageHeader('Stats', 'Every translation subfill has finished, from its own log, by day and by node. Pick a bar or a date to see that day.', picker)}
<div class="kpis">
${kpi(isToday ? 'Translated today' : `Translated on ${short(dayStart)}`, String(onDay.length), `${sum(onDay, (d) => d.cues).toLocaleString('en')} lines`)}
${kpi('Last 7 days', String(week.length), `${(week.length / 7).toFixed(1)} a day`)}
${kpi('Last 30 days', String(month.length), `${sum(month, (d) => d.cues).toLocaleString('en')} lines`)}
${kpi('Since the start', all.length.toLocaleString('en'), all.length ? `first on ${short(all[0].at)}` : 'nothing yet')}
${kpi('Average time', avg === null ? '-' : span(avg), 'per translation, last 7 days')}
</div>
<h2>Per day <span class="dim">the last 30 days</span></h2>
<div class="card">${legend()}${bars(dayCols, { height: 220, labelEvery: 5, aria: 'Translations per day for the last 30 days, by node' })}${asTable(days.map((d) => ({ label: long(d.day), values: d.byNode })).reverse(), 'Day')}</div>
<h2>Per hour <span class="dim">${esc(long(dayStart))}</span></h2>
<div class="card">${legend()}${bars(hourCols, { height: 160, labelEvery: 3, aria: `Translations per hour on ${long(dayStart)}, by node` })}${asTable(hours.map((h, i) => ({ label: `${String(i).padStart(2, '0')}:00`, values: h })), 'Hour')}</div>
<h2>Per node <span class="dim">the last 7 days</span></h2>
<div class="card flush wrap"><table><thead><tr><th>Node</th><th class="num">Translated</th><th class="num">Average time</th><th class="num">Lines</th><th class="num">Last one</th></tr></thead><tbody>${nodes.join('')}</tbody></table></div>
<h2>${esc(long(dayStart))}${isToday ? ' <span class="dim">today</span>' : ''}</h2>
<div class="row" style="margin-bottom:12px">
<span class="badge s-machine">${ev.done.length} translated</span>
<span class="badge s-failed">${ev.failed.length} failures</span>
<span class="badge s-human">${ev.found} found by Bazarr, ours removed</span>
<span class="badge s-missing">${ev.added} newly missing Arabic</span>
<span class="badge s-ready">${ev.yours.length} things you did</span>
</div>
<div class="card flush wrap"><table class="stack"><thead><tr><th class="num">Time</th><th>Translated</th><th>Node</th><th class="num">Lines</th><th class="num">Took</th><th></th></tr></thead><tbody>${doneRows || '<tr><td colspan="6" class="dim">Nothing translated on this day.</td></tr>'}</tbody></table></div>
${ev.failed.length ? `<h2>Failures</h2><div class="card flush wrap"><table class="stack"><tbody>${listOf(ev.failed)}</tbody></table></div>` : ''}
${ev.yours.length ? `<h2>What you did</h2><div class="card flush wrap"><table class="stack"><tbody>${listOf(ev.yours)}</tbody></table></div>` : ''}`;
  return page({ title: 'subfill - stats', tab: 'stats', body, v });
}
