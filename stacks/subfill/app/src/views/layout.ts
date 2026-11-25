// What every page shares: the frame with its tabs, the styles, the live
// refresh, and the small pieces (badges, buttons, times) the pages are built of.
import type { Subtitle } from '../bazarr.ts';
import { ARABIC_STATUSES, type ArabicStatus, type StatusCounts } from '../library.ts';
import type { Item, State } from '../store.ts';

export function esc(text: unknown): string {
  return String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function ago(ms: number | null, now: number): string {
  if (!ms) return '-';
  const s = Math.round((now - ms) / 1000);
  if (s < 0) return `in ${span(-s)}`;
  return `${span(s)} ago`;
}

export function span(s: number): string {
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}

// A time of day on the server's clock, which compose sets to the owner's zone.
export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function dateTime(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export const STATE_LABEL: Record<State, string> = {
  waiting: 'waiting for Bazarr',
  eligible: 'ready',
  translating: 'translating',
  done: 'machine subtitle in use',
  replaced: 'replaced by human',
  gone: 'video gone',
  failed: 'failed',
  skipped: 'skipped',
  no_source: 'nothing to translate from',
};

export const STATUS_LABEL: Record<ArabicStatus, string> = {
  human: 'Arabic',
  machine: 'machine Arabic',
  translating: 'translating',
  ready: 'in the queue',
  waiting: 'waiting for Bazarr',
  failed: 'failed',
  skipped: 'skipped',
  no_source: 'nothing to translate from',
  missing: 'missing, not looked at yet',
  not_wanted: 'Arabic not wanted',
};

// The statuses gathered the way the filters and the coverage bar use them.
export const GROUPS = {
  has: ['human', 'machine'],
  queue: ['translating', 'ready', 'waiting'],
  needs: ['failed', 'no_source', 'missing', 'skipped'],
} as const satisfies Record<string, readonly ArabicStatus[]>;

export function sum(counts: StatusCounts, statuses: readonly ArabicStatus[]): number {
  return statuses.reduce((a, s) => a + counts[s], 0);
}

export function badge(status: ArabicStatus): string {
  return `<span class="badge s-${status}">${esc(STATUS_LABEL[status])}</span>`;
}

export function stateBadge(state: State): string {
  return `<span class="badge st-${state}">${esc(STATE_LABEL[state])}</span>`;
}

// One chip per kind of subtitle Bazarr knows of (two English files show as
// "EN ×2", every path in the tooltip), and one for ours when it is in use.
export function subtitleChips(subs: Subtitle[], machine: boolean): string {
  const kinds = new Map<string, { code2: string; marks: string; paths: string[] }>();
  for (const s of subs) {
    const marks = [s.hi ? 'HI' : '', s.forced ? 'forced' : '', s.path ? '' : 'in video'].filter(Boolean).join(' ');
    const k = `${s.code2}|${marks}`;
    const kind = kinds.get(k) ?? { code2: s.code2, marks, paths: [] };
    kind.paths.push(s.path ?? 'a track inside the video');
    kinds.set(k, kind);
  }
  const chips = [...kinds.values()].map(
    (c) =>
      `<span class="chip${c.code2 === 'ar' ? ' ar' : ''}" title="${esc(c.paths.join('\n'))}">${esc(c.code2.toUpperCase())}${c.marks ? ` <small>${esc(c.marks)}</small>` : ''}${c.paths.length > 1 ? ` <small>&times;${c.paths.length}</small>` : ''}</span>`,
  );
  if (machine) chips.push('<span class="chip machine" title="written by subfill">AR <small>machine</small></span>');
  return chips.length ? chips.join('') : '<span class="dim">none</span>';
}

// A bar split by status, widest first, with the numbers in its tooltip.
export function coverageBar(counts: StatusCounts): string {
  const total = ARABIC_STATUSES.reduce((a, s) => a + counts[s], 0);
  if (!total) return '<div class="bar empty"></div>';
  const parts = ARABIC_STATUSES.filter((s) => counts[s] > 0).map(
    (s) => `<i class="s-${s}" style="width:${((counts[s] / total) * 100).toFixed(2)}%" title="${esc(`${counts[s]} ${STATUS_LABEL[s]}`)}"></i>`,
  );
  return `<div class="bar">${parts.join('')}</div>`;
}

export function legend(counts: StatusCounts): string {
  return `<div class="legend">${ARABIC_STATUSES.filter((s) => counts[s] > 0)
    .map((s) => `<span><i class="s-${s}"></i>${counts[s]} ${esc(STATUS_LABEL[s])}</span>`)
    .join('')}</div>`;
}

export function button(key: string, op: string, label: string, back: string, kind = ''): string {
  return `<form method="post" action="/action" class="inline"><input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="op" value="${esc(op)}"><input type="hidden" name="back" value="${esc(back)}"><button${kind ? ` class="${kind}"` : ''}>${esc(label)}</button></form>`;
}

export function actions(item: Item, back: string): string {
  const ops: [string, string, string][] = [];
  if (item.state === 'waiting' || item.state === 'eligible') ops.push(['now', 'Translate now', '']);
  if (item.state === 'failed') ops.push(['retry', 'Retry', 'primary']);
  if (['waiting', 'eligible', 'failed', 'no_source'].includes(item.state)) ops.push(['skip', 'Skip', '']);
  if (item.state === 'skipped') ops.push(['unskip', 'Undo skip', '']);
  return ops.map(([op, label, kind]) => button(item.key, op, label, back, kind)).join(' ');
}

export function itemLink(item: { key: string; title: string }): string {
  return `<a href="/item?key=${encodeURIComponent(item.key)}">${esc(item.title)}</a>`;
}

export function epCode(season: number | null, episode: number | null): string {
  if (season === null || episode === null) return '';
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

export const TABS = [
  ['overview', '/', 'Overview'],
  ['queue', '/queue', 'Queue'],
  ['shows', '/shows', 'Shows'],
  ['movies', '/movies', 'Films'],
  ['items', '/items', 'All items'],
  ['activity', '/activity', 'Activity'],
] as const;
export type Tab = (typeof TABS)[number][0];

const STYLE = `<style>
:root{color-scheme:light dark;--bg:#0d1014;--card:#161a20;--card2:#1c2129;--line:#272e38;--text:#e7e9ec;--dim:#97a0ab;--accent:#4f8cff;--bad:#ffb4b4;--badbg:#3a1d1d;--ok:#22c55e;--warn:#f59e0b;--off:#6b7280;
--human:#22c55e;--machine:#a78bfa;--translating:#4f8cff;--ready:#38bdf8;--waiting:#64748b;--failed:#ef4444;--skipped:#475569;--no_source:#f59e0b;--missing:#fb923c;--not_wanted:#2a313b}
@media (prefers-color-scheme:light){:root{--bg:#f5f6f8;--card:#fff;--card2:#f1f3f6;--line:#dde1e6;--text:#16191d;--dim:#5b6470;--accent:#2563eb;--bad:#8a1f1f;--badbg:#fde8e8;--not_wanted:#d9dee5;--skipped:#94a3b8;--waiting:#94a3b8}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.top{max-width:1180px;margin:0 auto;padding:10px 16px 0;display:flex;align-items:center;justify-content:space-between;gap:12px}
.brand{font-weight:700;font-size:16px;color:var(--text)} .brand small{font-weight:400;color:var(--dim);margin-left:8px}
nav{max-width:1180px;margin:0 auto;padding:0 10px;display:flex;gap:2px;overflow-x:auto;scrollbar-width:none}
nav a{padding:9px 10px 8px;color:var(--dim);border-bottom:2px solid transparent;white-space:nowrap}
nav a.on{color:var(--text);border-bottom-color:var(--accent)} nav a:hover{color:var(--text);text-decoration:none}
nav .n{font-size:11px;background:var(--card2);border:1px solid var(--line);border-radius:999px;padding:0 6px;margin-left:4px}
main{max-width:1180px;margin:0 auto;padding:18px 16px 48px}
h1{font-size:22px;margin:0 0 4px} h2{font-size:15px;margin:26px 0 10px;display:flex;align-items:center;gap:8px} h2 a{font-size:13px;font-weight:400;margin-left:auto}
a{color:var(--accent);text-decoration:none} a:hover{text-decoration:underline}
.dim{color:var(--dim)} small{font-size:11px} .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center} .grow{flex:1}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px}
.nodes{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.node h3{margin:0;font-size:15px} .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;background:var(--off)}
.dot.working{background:var(--accent);box-shadow:0 0 0 0 var(--accent);animation:pulse 1.6s infinite} .dot.idle{background:var(--ok)} .dot.paused,.dot.outside_hours{background:var(--warn)}
@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--accent) 60%,transparent)}70%{box-shadow:0 0 0 7px transparent}100%{box-shadow:0 0 0 0 transparent}}
.doing{margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}
.meter{height:8px;border-radius:999px;background:var(--card2);overflow:hidden;margin:6px 0 4px} .meter i{display:block;height:100%;background:var(--accent);border-radius:999px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:14px 0 0}
.kpi b{display:block;font-size:24px;line-height:1.2;font-variant-numeric:tabular-nums} .kpi span{color:var(--dim);font-size:13px} .kpi .sub{display:block;font-size:12px;color:var(--dim);margin-top:2px}
.kpi.good b{color:var(--human)} .kpi.warn b{color:var(--warn)} .kpi.bad b{color:var(--failed)}
.bad{background:var(--badbg);color:var(--bad);border-radius:10px;padding:9px 12px;margin:0 0 12px}
.note{background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:9px 12px;margin:0 0 12px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}
.chips a{border:1px solid var(--line);border-radius:999px;padding:3px 11px;color:var(--text);background:var(--card)} .chips a.on{border-color:var(--accent);color:var(--accent)} .chips a:hover{text-decoration:none;border-color:var(--dim)}
table{width:100%;border-collapse:collapse} td,th{text-align:left;padding:8px 8px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
th{font-size:12px;color:var(--dim);font-weight:600;white-space:nowrap} td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.wrap{overflow-x:auto} .card.flush{padding:4px 8px}
.badge{display:inline-block;font-size:12px;border-radius:999px;padding:1px 9px;white-space:nowrap;border:1px solid transparent;background:color-mix(in srgb,var(--c,var(--off)) 18%,transparent);color:color-mix(in srgb,var(--c,var(--off)) 70%,var(--text))}
.s-human{--c:var(--human)} .s-machine{--c:var(--machine)} .s-translating{--c:var(--translating)} .s-ready{--c:var(--ready)} .s-waiting{--c:var(--waiting)} .s-failed{--c:var(--failed)} .s-skipped{--c:var(--skipped)} .s-no_source{--c:var(--no_source)} .s-missing{--c:var(--missing)} .s-not_wanted{--c:var(--not_wanted)}
.st-done{--c:var(--machine)} .st-eligible{--c:var(--ready)} .st-translating{--c:var(--translating)} .st-waiting{--c:var(--waiting)} .st-failed{--c:var(--failed)} .st-skipped{--c:var(--skipped)} .st-no_source{--c:var(--no_source)} .st-replaced{--c:var(--human)} .st-gone{--c:var(--off)}
.chip{display:inline-block;font-size:12px;border:1px solid var(--line);background:var(--card2);border-radius:6px;padding:0 6px;margin:0 4px 3px 0;white-space:nowrap}
.chip.ar{border-color:color-mix(in srgb,var(--human) 55%,var(--line))} .chip.machine{border-color:color-mix(in srgb,var(--machine) 65%,var(--line))} .chip small{color:var(--dim)}
.bar{display:flex;height:10px;border-radius:999px;overflow:hidden;background:var(--card2);min-width:120px} .bar i{display:block;height:100%;background:var(--c)} .bar.big{height:14px}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:8px;font-size:12px;color:var(--dim)} .legend i{display:inline-block;width:9px;height:9px;border-radius:3px;background:var(--c);margin-right:5px}
.show-title{font-weight:600;color:var(--text)} .tag{font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:5px;padding:0 5px;margin-left:6px;white-space:nowrap}
button{font:inherit;font-size:13px;padding:3px 10px;border-radius:7px;border:1px solid var(--line);background:var(--card2);color:var(--text);cursor:pointer} button:hover{border-color:var(--dim)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
form.inline{display:inline}
input[type=search],select{font:inherit;padding:6px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text)} input[type=search]{min-width:220px}
pre{white-space:pre-wrap;margin:0;font:inherit}
.list{list-style:none;margin:0;padding:0} .list li{padding:8px 0;border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:baseline} .list li:last-child{border-bottom:0}
.rank{color:var(--dim);font-variant-numeric:tabular-nums;min-width:26px;text-align:right}
.facts th{width:150px} .facts td{word-break:break-all}
.live{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--ok);margin-right:6px;vertical-align:middle}
.live.stale{background:var(--warn)}
@media (max-width:700px){
  main{padding:14px 12px 40px} .top{padding:8px 12px 0} .brand small{display:none}
  input[type=search]{min-width:0;flex:1}
  table.stack thead{display:none} table.stack tr{display:block;padding:8px 0;border-bottom:1px solid var(--line)} table.stack tr:last-child{border-bottom:0}
  table.stack td{display:block;border:0;padding:2px 4px} table.stack td.num{text-align:left}
  table.stack td[data-label]::before{content:attr(data-label) ": ";color:var(--dim);font-size:12px}
  table.stack td.inl{display:inline-block;vertical-align:middle}
  .kpi b{font-size:20px}
}
</style>`;

// Replaces each live part of the page (an element with data-live) with a
// fresh copy every 5 s. A failed refresh leaves the last copy and turns the
// header's dot amber; the next one tries again.
const LIVE = `<script>
(() => {
  const dot = document.getElementById('live');
  const parts = [...document.querySelectorAll('[data-live]')].map((e) => e.dataset.live);
  if (!parts.length) return;
  setInterval(async () => {
    try {
      const r = await fetch('/live?parts=' + parts.join(','), { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      for (const p of parts) if (j[p] !== undefined) document.querySelector('[data-live="' + p + '"]').innerHTML = j[p];
      dot && dot.classList.remove('stale');
    } catch { dot && dot.classList.add('stale'); }
  }, 5000);
})();
</script>`;

const ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%234f8cff'/%3E%3Crect x='6' y='18' width='20' height='3' rx='1.5' fill='white'/%3E%3Crect x='9' y='23' width='14' height='3' rx='1.5' fill='white'/%3E%3C/svg%3E";

export function page(opts: { title: string; tab?: Tab; body: string; queued?: number; live?: boolean }): string {
  const tabs = TABS.map(
    ([id, href, label]) =>
      `<a href="${href}"${opts.tab === id ? ' class="on"' : ''}>${label}${id === 'queue' && opts.queued ? `<span class="n">${opts.queued}</span>` : ''}</a>`,
  ).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title)}</title><link rel="icon" href="${ICON}">${STYLE}</head><body>
<header><div class="top"><a class="brand" href="/">subfill<small>Arabic subtitles where Bazarr finds none</small></a><span>${opts.live ? '<span class="live" id="live" title="refreshes every 5 s"></span>' : ''}<a href="/logout">Sign out</a></span></div><nav>${tabs}</nav></header>
<main>${opts.body}</main>${opts.live ? LIVE : ''}</body></html>`;
}

// A short page for a problem, with the way back.
export function problemPage(message: string, back = '/'): string {
  return page({ title: 'subfill', body: `<div class="bad">${esc(message)}</div><p><a href="${esc(back)}">Back</a></p>` });
}
