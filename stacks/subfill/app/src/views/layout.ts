// What every page shares: the frame with its sidebar, the styles, the live
// refresh, and the small pieces (headers, badges, buttons, times) the pages
// are built of.
import type { Subtitle } from '../bazarr.ts';
import { ARABIC_STATUSES, type ArabicStatus, type StatusCounts } from '../library.ts';
import type { NodeState } from '../nodes.ts';
import { EXCLUDED_NOTE, type Item, type State } from '../store.ts';
import type { View } from './view.ts';

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
  retrying: 'trying again later',
  waiting: 'waiting for Bazarr',
  failed: 'failed',
  skipped: 'skipped',
  no_source: 'nothing to translate from',
  missing: 'missing, not looked at yet',
  not_wanted: 'Arabic not wanted',
  excluded: 'not translated, by you',
};

// The statuses gathered the way the filters and the coverage bar use them.
export const GROUPS = {
  has: ['human', 'machine'],
  queue: ['translating', 'ready', 'retrying', 'waiting'],
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
  return chips.length ? `<span class="chips-inline">${chips.join('')}</span>` : '<span class="dim">none</span>';
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
    .map((s) => `<span><i class="s-${s}"></i><b>${counts[s].toLocaleString('en')}</b>${esc(STATUS_LABEL[s])}</span>`)
    .join('')}</div>`;
}

export function button(key: string, op: string, label: string, back: string, kind = ''): string {
  return `<form method="post" action="/action" class="inline"><input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="op" value="${esc(op)}"><input type="hidden" name="back" value="${esc(back)}"><button class="btn${kind ? ` ${kind}` : ''}">${esc(label)}</button></form>`;
}

export function actions(item: Item, back: string): string {
  const ops: [string, string, string][] = [];
  if (item.state === 'waiting' || item.state === 'eligible') ops.push(['now', 'Translate now', '']);
  if (item.state === 'failed') ops.push(['retry', 'Retry', 'primary']);
  if (['waiting', 'eligible', 'failed', 'no_source'].includes(item.state)) ops.push(['skip', 'Skip', '']);
  // One set aside by its show's or film's mark comes back by lifting the mark.
  if (item.state === 'skipped' && item.note !== EXCLUDED_NOTE) ops.push(['unskip', 'Undo skip', '']);
  return ops.length ? `<span class="acts">${ops.map(([op, label, kind]) => button(item.key, op, label, back, kind)).join('')}</span>` : '';
}

// The button that marks a show ("series:<id>") or film ("movie:<id>") not to
// translate, or lifts the mark.
export function excludeButton(key: string, excluded: boolean, back: string, noun: string): string {
  return excluded ? button(key, 'include', `Translate this ${noun} again`, back, 'primary') : button(key, 'exclude', `Don't translate this ${noun}`, back);
}

export function itemLink(item: { key: string; title: string }): string {
  return `<a href="/item?key=${encodeURIComponent(item.key)}">${esc(item.title)}</a>`;
}

export function epCode(season: number | null, episode: number | null): string {
  if (season === null || episode === null) return '';
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

// Line icons, drawn inline so nothing is fetched from outside.
const ICONS: Record<string, string> = {
  overview: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  queue: '<path d="M10 6h11M10 12h11M10 18h11"/><path d="M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
  shows: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="m17 2-5 5-5-5"/>',
  movies: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 7.5h4M3 12h18M3 16.5h4M17 7.5h4M17 16.5h4"/>',
  items: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
};

export function icon(name: string): string {
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
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

// A page's title row: the title, a line under it, and anything on the right.
// All three are HTML, so any text in them must already be through esc().
export function pageHeader(title: string, sub = '', right = ''): string {
  return `<div class="ph"><div><h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div>${right ? `<div class="ph-right">${right}</div>` : ''}</div>`;
}

const NODE_SHORT: Record<NodeState, string> = {
  working: 'translating',
  idle: 'idle',
  offline: 'offline',
  paused: 'paused',
  outside_hours: 'off hours',
};

// The nodes in brief, at the foot of the sidebar on every page.
export function renderSideNodes(v: View): string {
  return v.status.nodes
    .map((n) => {
      const pct = n.current?.total ? Math.round((n.current.done / n.current.total) * 100) : null;
      return `<div class="sn"><span class="dot ${n.state}"></span><span class="sn-name">${esc(n.label)}</span><span class="sn-state">${pct !== null ? `${pct}%` : esc(n.paused && n.state === 'working' ? 'pausing' : NODE_SHORT[n.state])}</span></div>`;
    })
    .join('');
}

const STYLE = `<style>
:root{color-scheme:dark;
--bg:#0a0c0f;--side:#0d1014;--card:#12161b;--card2:#181d23;--hover:#1a2028;--line:#1f252d;--line2:#2a313a;
--text:#e4e7eb;--muted:#8a94a0;--faint:#5c6672;--accent:#5b8def;--accent2:#3b6fd8;--ok:#3fb950;--warn:#d29922;--off:#6b7280;--bad:#f85149;--badbg:rgba(248,81,73,.08);
--human:#3fb950;--machine:#a371f7;--translating:#5b8def;--ready:#39c5cf;--retrying:#8b8ff8;--waiting:#768390;--failed:#f85149;--skipped:#545d68;--no_source:#d29922;--missing:#db6d28;--not_wanted:#2d333b;--excluded:#3d444d;
--r:10px;--font:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f6f7f9;--side:#fbfbfc;--card:#fff;--card2:#f6f8fa;--hover:#f3f5f8;--line:#e4e7eb;--line2:#d5dae0;--text:#1c2128;--muted:#59636e;--faint:#8c959f;--accent:#2f6fdb;--accent2:#1f5fc9;--badbg:#fff1f0;--not_wanted:#dfe3e8;--excluded:#c4cbd3;--skipped:#9aa4ae;--waiting:#8c959f}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:13.5px/1.5 var(--font);-webkit-font-smoothing:antialiased;font-feature-settings:"cv11","ss01"}
a{color:var(--accent);text-decoration:none} a:hover{text-decoration:underline}
.ico{width:16px;height:16px;flex:none}
.shell{display:grid;grid-template-columns:232px 1fr;min-height:100vh}
aside{position:sticky;top:0;height:100vh;background:var(--side);border-right:1px solid var(--line);display:flex;flex-direction:column;padding:16px 12px}
.brand{display:flex;align-items:center;gap:10px;padding:2px 8px 18px;color:var(--text);font-weight:650;font-size:15px;letter-spacing:-.01em}
.brand:hover{text-decoration:none} .logo{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,var(--accent),var(--machine));display:grid;place-items:center;color:#fff;font-size:12px;font-weight:700}
.brand small{display:block;font-size:11.5px;font-weight:400;color:var(--muted);letter-spacing:0}
.navlabel{font-size:11px;font-weight:600;color:var(--faint);text-transform:uppercase;letter-spacing:.06em;padding:10px 10px 6px}
.side-nav a{display:flex;align-items:center;gap:10px;padding:7px 10px;margin:1px 0;border-radius:7px;color:var(--muted);font-weight:500}
.side-nav a:hover{background:var(--hover);color:var(--text);text-decoration:none}
.side-nav a.on{background:var(--card2);color:var(--text);box-shadow:inset 2px 0 0 var(--accent)}
.side-nav .n{margin-left:auto;font-size:11px;font-weight:600;color:var(--muted);background:var(--card2);border:1px solid var(--line2);border-radius:999px;padding:0 7px;line-height:18px}
.side-nav .n.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,var(--line2))}
.side-foot{margin-top:auto;border-top:1px solid var(--line);padding-top:12px}
.sn{display:flex;align-items:center;gap:8px;padding:4px 10px;font-size:12.5px} .sn-name{color:var(--text)} .sn-state{margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums}
.side-foot .out{display:flex;align-items:center;gap:10px;padding:7px 10px;margin-top:8px;border-radius:7px;color:var(--muted)} .side-foot .out:hover{background:var(--hover);color:var(--text);text-decoration:none}
.topbar{display:none}
main{min-width:0;padding:28px 40px 56px;width:100%}
.ph{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin:0 0 22px}
h1{font-size:20px;font-weight:650;letter-spacing:-.015em;margin:0;line-height:1.3} h1 .dim{font-weight:400}
.sub{margin:4px 0 0;color:var(--muted);font-size:13px;max-width:760px}
.ph-right{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12.5px}
h2{font-size:13px;font-weight:600;margin:30px 0 10px;display:flex;align-items:center;gap:8px;color:var(--text)} h2 .dim{font-weight:400}
h2 a{font-size:12.5px;font-weight:500;margin-left:auto}
.dim{color:var(--muted)} small{font-size:11px} .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center} .grow{flex:1}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:16px 18px}
.card.flush{padding:0;overflow:hidden}
.card-h{display:flex;align-items:center;gap:8px;margin-bottom:10px;font-weight:600} .card-h a{margin-left:auto;font-weight:500;font-size:12.5px}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(360px,100%),1fr));gap:16px}
.nodes{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));gap:16px;align-items:start}
.node h3{margin:0;font-size:14px;font-weight:600;display:flex;align-items:center}
.node .meta{color:var(--muted);font-size:12.5px;margin-top:4px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;background:var(--off);flex:none}
.dot.working{background:var(--accent);animation:pulse 1.8s infinite} .dot.idle{background:var(--ok)} .dot.paused,.dot.outside_hours{background:var(--warn)} .dot.offline{background:var(--faint)}
@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--accent) 55%,transparent)}70%{box-shadow:0 0 0 6px transparent}100%{box-shadow:0 0 0 0 transparent}}
.doing{margin-top:14px;padding-top:14px;border-top:1px solid var(--line)} .doing a{color:var(--text);font-weight:600}
.meter{height:6px;border-radius:999px;background:var(--card2);overflow:hidden;margin:8px 0 6px} .meter i{display:block;height:100%;background:var(--accent);border-radius:999px;transition:width .6s}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(170px,100%),1fr));gap:16px;margin:0 0 6px}
.kpi .l{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:500;color:var(--muted)}
.kpi .l i{width:8px;height:8px;border-radius:2px;background:var(--c,var(--line2))}
.kpi b{display:block;font-size:26px;font-weight:650;letter-spacing:-.02em;line-height:1.15;margin:8px 0 2px;font-variant-numeric:tabular-nums}
.kpi .sub{display:block;font-size:12px;color:var(--muted);margin:0}
.kpi .meter{margin:10px 0 0;height:4px}
.bad{background:var(--badbg);color:var(--bad);border:1px solid color-mix(in srgb,var(--bad) 30%,transparent);border-radius:8px;padding:10px 14px;margin:0 0 16px}
.note{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin:0 0 16px;color:var(--muted)}
.toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:0 0 14px}
.seg{display:inline-flex;flex-wrap:wrap;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:3px;gap:2px}
.seg a{padding:4px 11px;border-radius:6px;color:var(--muted);font-weight:500;font-size:12.5px;white-space:nowrap} .seg a:hover{color:var(--text);text-decoration:none;background:var(--hover)}
.seg a.on{background:var(--card2);color:var(--text);box-shadow:0 0 0 1px var(--line2)} .seg a .c{color:var(--faint);margin-left:5px;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse}
th{font-size:11px;font-weight:600;color:var(--faint);text-transform:uppercase;letter-spacing:.05em;text-align:left;padding:9px 14px;background:var(--card2);border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:10px 14px;border-bottom:1px solid var(--line);vertical-align:middle;text-align:left}
tbody tr:last-child td{border-bottom:0} tbody tr:hover td{background:var(--hover)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td .dim{font-size:12.5px}
td a{color:var(--text);font-weight:500} td a:hover{color:var(--accent)}
.wrap{overflow-x:auto}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;border-radius:6px;padding:1px 8px;white-space:nowrap;border:1px solid var(--line2);background:var(--card2);color:var(--text)}
.badge::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--c,var(--off))}
.s-human{--c:var(--human)} .s-machine{--c:var(--machine)} .s-translating{--c:var(--translating)} .s-ready{--c:var(--ready)} .s-retrying{--c:var(--retrying)} .s-waiting{--c:var(--waiting)} .s-failed{--c:var(--failed)} .s-skipped{--c:var(--skipped)} .s-no_source{--c:var(--no_source)} .s-missing{--c:var(--missing)} .s-not_wanted{--c:var(--not_wanted)} .s-excluded{--c:var(--excluded)}
.st-done{--c:var(--machine)} .st-eligible{--c:var(--ready)} .st-translating{--c:var(--translating)} .st-waiting{--c:var(--waiting)} .st-failed{--c:var(--failed)} .st-skipped{--c:var(--skipped)} .st-no_source{--c:var(--no_source)} .st-replaced{--c:var(--human)} .st-gone{--c:var(--off)}
.chips-inline{display:inline-flex;flex-wrap:wrap;gap:4px}
.chip{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;font-weight:600;border:1px solid var(--line2);background:transparent;border-radius:5px;padding:0 6px;line-height:19px;white-space:nowrap;color:var(--muted)}
.chip.ar{color:var(--text);border-color:color-mix(in srgb,var(--human) 50%,var(--line2))} .chip.machine{color:var(--text);border-color:color-mix(in srgb,var(--machine) 55%,var(--line2))} .chip small{font-weight:500;color:var(--faint)}
.bar{display:flex;height:6px;border-radius:999px;overflow:hidden;background:var(--card2);min-width:120px;gap:1px} .bar i{display:block;height:100%;background:var(--c)}
.bar.big{height:8px}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:12px;font-size:12px;color:var(--muted)} .legend span{display:inline-flex;align-items:center} .legend b{color:var(--text);font-weight:600;margin-right:4px;font-variant-numeric:tabular-nums}
.legend i{display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--c);margin-right:7px}
.cov-sub{display:block;font-size:11.5px;color:var(--faint);margin-top:5px}
.tag{font-size:11px;font-weight:500;color:var(--muted);border:1px solid var(--line2);border-radius:5px;padding:0 6px;margin-left:8px;white-space:nowrap;vertical-align:1px}
.btn{font:inherit;font-size:12px;font-weight:500;padding:3px 10px;border-radius:6px;border:1px solid var(--line2);background:var(--card);color:var(--text);cursor:pointer;white-space:nowrap;line-height:18px}
.btn:hover{background:var(--hover);border-color:var(--faint)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff} .btn.primary:hover{background:var(--accent2)}
.acts{display:inline-flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}
form.inline{display:inline}
input[type=search],select{font:inherit;font-size:13px;height:32px;padding:0 11px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text);outline:none}
input[type=search]:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 20%,transparent)}
input[type=search]{min-width:240px}
pre{white-space:pre-wrap;margin:0;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--muted)}
.list{list-style:none;margin:0;padding:0} .list li{padding:10px 18px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:baseline} .list li:last-child{border-bottom:0}
.list li a{color:var(--text);font-weight:500} .list li a:hover{color:var(--accent)}
.rank{color:var(--faint);font-variant-numeric:tabular-nums;min-width:18px;text-align:right;font-size:12px}
.facts th{width:170px;background:transparent;text-transform:none;letter-spacing:0;font-size:12.5px;font-weight:500;color:var(--muted);border-bottom:1px solid var(--line)} .facts td{word-break:break-all}
.live{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--ok)}
.live.stale{background:var(--warn)}
.crumb{font-size:12.5px;margin:0 0 8px;color:var(--muted)} .crumb a{color:var(--muted)} .crumb a:hover{color:var(--text)}
#nav-toggle{display:none} .scrim{display:none}
@media (max-width:900px){
  .shell{display:block}
  aside{position:fixed;inset:0 auto 0 0;width:260px;z-index:20;transform:translateX(-100%);transition:transform .2s;box-shadow:0 0 40px rgba(0,0,0,.4)}
  #nav-toggle:checked ~ .shell aside{transform:none}
  #nav-toggle:checked ~ .shell .scrim{display:block}
  .scrim{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:15}
  .topbar{display:flex;align-items:center;gap:10px;position:sticky;top:0;z-index:10;background:color-mix(in srgb,var(--bg) 90%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:10px 14px}
  .topbar label{display:grid;place-items:center;width:34px;height:34px;border-radius:8px;border:1px solid var(--line);cursor:pointer;color:var(--text)}
  main{padding:18px 14px 48px}
  input[type=search]{min-width:0;flex:1}
  table.stack thead{display:none} table.stack tr{display:block;padding:10px 14px;border-bottom:1px solid var(--line)} table.stack tbody tr:last-child{border-bottom:0}
  table.stack td{display:block;border:0;padding:2px 0} table.stack td.num{text-align:left}
  table.stack td.inl{display:inline-block;vertical-align:middle;margin-right:8px}
  table.stack tbody tr:hover td{background:transparent}
  table.stack td[data-label]::before{content:attr(data-label) ": ";color:var(--faint);font-size:12px}
  .kpi b{font-size:22px}
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
      const back = encodeURIComponent(location.pathname + location.search);
      const r = await fetch('/live?parts=' + parts.join(',') + '&back=' + back, { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      for (const p of parts) if (j[p] !== undefined) document.querySelector('[data-live="' + p + '"]').innerHTML = j[p];
      dot && dot.classList.remove('stale');
    } catch { dot && dot.classList.add('stale'); }
  }, 5000);
})();
</script>`;

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%235b8def'/%3E%3Crect x='7' y='17' width='18' height='3' rx='1.5' fill='white'/%3E%3Crect x='10' y='22' width='12' height='3' rx='1.5' fill='white'/%3E%3C/svg%3E";

// `v` fills the sidebar's counts and nodes; a page without one (an error) gets
// the plain sidebar.
export function page(opts: { title: string; tab?: Tab; body: string; v?: View; live?: boolean }): string {
  const v = opts.v;
  const queued = v ? v.store.readyCount(v.now) : 0;
  const failed = v ? v.store.counts().failed : 0;
  const nav = TABS.map(([id, href, label]) => {
    const n = id === 'queue' && queued ? `<span class="n">${queued}</span>` : id === 'items' && failed ? `<span class="n bad" title="failed">${failed}</span>` : '';
    return `<a href="${href}"${opts.tab === id ? ' class="on" aria-current="page"' : ''}>${icon(id)}${label}${n}</a>`;
  }).join('');
  const nodes = v ? `<div class="navlabel">Nodes</div><div data-live="side">${renderSideNodes(v)}</div>` : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title)}</title><link rel="icon" href="${FAVICON}">${STYLE}</head><body>
<input type="checkbox" id="nav-toggle" aria-hidden="true">
<div class="shell">
<label class="scrim" for="nav-toggle"></label>
<aside><a class="brand" href="/"><span class="logo">sf</span><span>subfill<small>Arabic subtitles</small></span></a>
<div class="navlabel">Menu</div><nav class="side-nav">${nav}</nav>
<div class="side-foot">${nodes}<a class="out" href="/logout">${icon('logout')}Sign out</a></div></aside>
<div><div class="topbar"><label for="nav-toggle" title="Menu">${icon('menu')}</label><a class="brand" href="/" style="padding:0"><span class="logo">sf</span>subfill</a><span class="grow"></span>${opts.live ? '<span class="live" title="refreshes every 5 s"></span>' : ''}</div>
<main>${opts.body}</main></div>
</div>${v ? LIVE : ''}</body></html>`;
}

// The live dot and its words, for the right of a live page's header.
export function liveMark(): string {
  return '<span class="live" id="live" title="refreshes every 5 s"></span>Live';
}

// A short page for a problem, with the way back.
export function problemPage(message: string, back = '/'): string {
  return page({ title: 'subfill', body: `<div class="bad">${esc(message)}</div><p><a href="${esc(back)}">Back</a></p>` });
}
