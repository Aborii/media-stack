// subfill's page, Tdarr-style: the nodes and what each is doing, the queue,
// and the buttons to pause a node, retry, skip or translate one now. The
// nodes panel and the counters refresh themselves every few seconds.
//
// The sign-in is the same login.py gate as Glances and OmniTools, run as
// subfill-login. Instead of a proxy in front, this server asks the gate itself:
// every request except /healthz and /api is checked with the gate's /auth, and
// /login and /logout are passed through to it. If the gate cannot be reached
// the page stays closed rather than open.
//
// /api is for Malak, which asks the owner whether to wake the PC. It takes a
// bearer token (SUBFILL_API_TOKEN) instead of a session, and is off when the
// token is not set.
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { NodeState, NodeStatus } from './nodes.ts';
import type { Item, State, Store } from './store.ts';
import { STATES } from './store.ts';
import type { Worker } from './worker.ts';

export type Status = {
  bazarrError: string | null;
  lastSync: number | null;
  nodes: NodeStatus[];
  model: string;
};

export type WebDeps = {
  store: Store;
  worker: Pick<Worker, 'act' | 'holdForPc' | 'releaseHolds'>;
  status: () => Status;
  // Pauses or resumes a node by name; returns a problem, or null.
  setNodePaused: (name: string, paused: boolean) => string | null;
  loginUrl: string;
  apiToken?: string;
  fetcher?: typeof fetch;
  now?: () => number;
};

const LABEL: Record<State, string> = {
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

const NODE_LABEL: Record<NodeState, string> = {
  working: 'translating',
  idle: 'idle',
  offline: 'offline',
  paused: 'paused by you',
  outside_hours: 'outside its hours',
};

export function esc(text: unknown): string {
  return String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function ago(ms: number | null, now: number): string {
  if (!ms) return '-';
  const s = Math.round((now - ms) / 1000);
  if (s < 0) return `in ${when(-s)}`;
  return `${when(s)} ago`;
}

function when(s: number): string {
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}

const STYLE = `<style>
:root{color-scheme:light dark;--bg:#0f1216;--card:#181c22;--line:#262c35;--text:#e6e8eb;--dim:#9aa3ad;--accent:#3b82f6;--bad:#ffb4b4;--badbg:#3a1d1d;--ok:#22c55e;--warn:#f59e0b;--off:#6b7280}
@media (prefers-color-scheme:light){:root{--bg:#f6f7f9;--card:#fff;--line:#dde1e6;--text:#16191d;--dim:#5b6470;--accent:#2563eb;--bad:#8a1f1f;--badbg:#fde8e8}}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:20px 16px 40px}
h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:22px 0 8px}
a{color:var(--accent);text-decoration:none} a:hover{text-decoration:underline}
.dim{color:var(--dim)} .row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.nodes{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px;margin:14px 0}
.node h3{margin:0;font-size:15px} .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:var(--off)}
.dot.working{background:var(--accent)} .dot.idle{background:var(--ok)} .dot.paused,.dot.outside_hours{background:var(--warn)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:14px 0}
.stat b{display:block;font-size:20px}
.bad{background:var(--badbg);color:var(--bad);border-radius:8px;padding:8px 11px;margin:8px 0}
.chips a{border:1px solid var(--line);border-radius:999px;padding:3px 10px;color:var(--text)}
.chips a.on{border-color:var(--accent);color:var(--accent)}
table{width:100%;border-collapse:collapse} td,th{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--dim);font-weight:600}
.wrap{overflow-x:auto}
button{font:inherit;padding:3px 9px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}
input[type=search]{font:inherit;padding:5px 9px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--text);min-width:200px}
progress{width:100%}
pre{white-space:pre-wrap;margin:0}
</style>`;

// Replaces the nodes panel and the counters with fresh copies every 5 s. A
// failed refresh leaves the last ones showing; the next one tries again.
const LIVE = `<script>
setInterval(async () => {
  try {
    const r = await fetch('/live', { headers: { accept: 'application/json' } });
    if (!r.ok) return;
    const j = await r.json();
    document.getElementById('nodes').innerHTML = j.nodes;
    document.getElementById('stats').innerHTML = j.stats;
  } catch {}
}, 5000);
</script>`;

function page(title: string, body: string, script = ''): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${STYLE}</head><body><main>${body}</main>${script}</body></html>`;
}

function button(key: string, op: string, label: string, back: string): string {
  return `<form method="post" action="/action" style="display:inline"><input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="op" value="${esc(op)}"><input type="hidden" name="back" value="${esc(back)}"><button>${esc(label)}</button></form>`;
}

function actions(item: Item, back: string): string {
  const ops: [string, string][] = [];
  if (item.state === 'waiting' || item.state === 'eligible') ops.push(['now', 'Translate now']);
  if (item.state === 'failed') ops.push(['retry', 'Retry']);
  if (['waiting', 'eligible', 'failed', 'no_source'].includes(item.state)) ops.push(['skip', 'Skip']);
  if (item.state === 'skipped') ops.push(['unskip', 'Undo skip']);
  return ops.map(([op, label]) => button(item.key, op, label, back)).join(' ');
}

export function renderNodes(nodes: NodeStatus[], held: Item | undefined, now: number): string {
  return nodes
    .map((n) => {
      const doing = n.current
        ? `<div style="margin-top:8px"><b>${esc(n.current.title)}</b><br><progress max="${n.current.total}" value="${n.current.done}"></progress><span class="dim">${n.current.done} of ${n.current.total} lines, started ${ago(n.current.startedAt, now)}</span></div>`
        : '';
      const facts = [
        n.state === 'offline' && n.problem ? esc(n.problem) : '',
        n.lastSeen ? `last answered ${ago(n.lastSeen, now)}` : n.state === 'offline' ? 'not seen since subfill started' : '',
        n.lease?.held ? 'keeping the PC awake while it works' : '',
        n.name !== 'mini' && held ? `${esc(held.title)} is kept for it until ${new Date(held.held_until ?? 0).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : '',
      ].filter(Boolean);
      const problem = n.lease?.error ? `<div class="bad">${esc(n.lease.error)}</div>` : '';
      const toggle = n.state === 'paused' ? button(n.name, 'resume-node', 'Resume', '/') : button(n.name, 'pause-node', 'Pause', '/');
      return `<div class="card node"><div class="row" style="justify-content:space-between"><h3><span class="dot ${n.state}"></span>${esc(n.label)}</h3>${toggle}</div><div class="dim">${esc(NODE_LABEL[n.state])}${facts.length ? ` &middot; ${facts.join(' &middot; ')}` : ''}</div>${problem}${doing}</div>`;
    })
    .join('');
}

export function renderStats(store: Store, now: number): string {
  const counts = store.counts();
  const week = store.finishedSince(now - 7 * 86400_000);
  return [
    ['Machine subtitles in use', counts.done],
    ['Translated this week', week.count],
    ['Replaced by human', counts.replaced],
    ['Average time', week.avgSeconds === null ? '-' : `${Math.round(week.avgSeconds / 60)} min`],
    ['Ready', counts.eligible],
    ['Waiting for Bazarr', counts.waiting],
    ['Failed', counts.failed],
  ]
    .map(([label, value]) => `<div class="card stat"><b>${esc(value)}</b><span class="dim">${esc(label)}</span></div>`)
    .join('');
}

export function renderHome(deps: WebDeps, query: URLSearchParams): string {
  const now = (deps.now ?? Date.now)();
  const s = deps.status();
  const counts = deps.store.counts();
  const state = STATES.find((x) => x === query.get('state'));
  const q = (query.get('q') ?? '').slice(0, 100);
  const { items, total } = deps.store.list({ state, q, limit: 200 });
  const back = `/?${query.toString()}`;

  const problems = s.bazarrError ? `<div class="bad">${esc(s.bazarrError)}</div>` : '';
  const chip = (value: State | '', label: string, n: number) => {
    const p = new URLSearchParams(q ? { q } : {});
    if (value) p.set('state', value);
    return `<a class="${(state ?? '') === value ? 'on' : ''}" href="/?${p.toString()}">${esc(label)} ${n}</a>`;
  };
  const all = Object.values(counts).reduce((a, b) => a + b, 0);
  const chips = [chip('', 'all', all), ...STATES.map((x) => chip(x, LABEL[x], counts[x]))].join(' ');
  const rows = items
    .map(
      (i) =>
        `<tr><td><a href="/item?key=${encodeURIComponent(i.key)}">${esc(i.title)}</a><div class="dim">${esc(i.note ?? '')}</div></td><td>${esc(LABEL[i.state])}${i.node && i.state !== 'waiting' ? `<div class="dim">${esc(i.node)}</div>` : ''}</td><td class="dim">${ago(i.updated_at, now)}</td><td>${actions(i, back)}</td></tr>`,
    )
    .join('');

  return page(
    'subfill',
    `<div class="row" style="justify-content:space-between"><div><h1>subfill</h1><div class="dim">Arabic subtitles from ${esc(s.model)} when Bazarr finds none. Last sync ${ago(s.lastSync, now)}.</div></div><a href="/logout">Sign out</a></div>
${problems}<h2>Nodes</h2><div class="nodes" id="nodes">${renderNodes(s.nodes, deps.store.heldNow(now), now)}</div><div class="stats" id="stats">${renderStats(deps.store, now)}</div>
<h2>Queue</h2><form class="row" method="get" action="/">${state ? `<input type="hidden" name="state" value="${esc(state)}">` : ''}<input type="search" name="q" value="${esc(q)}" placeholder="Search titles"><button>Search</button></form>
<p class="chips row">${chips}</p>
<div class="wrap"><table><thead><tr><th>Title</th><th>State</th><th>Changed</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="dim">Nothing here.</td></tr>'}</tbody></table></div>
${total > items.length ? `<p class="dim">Showing the ${items.length} most recently changed of ${total}. Search or filter to find the rest.</p>` : ''}`,
    LIVE,
  );
}

export function renderItem(deps: WebDeps, key: string): string | null {
  const now = (deps.now ?? Date.now)();
  const item = deps.store.get(key);
  if (!item) return null;
  const log = deps.store
    .logFor(key)
    .map((l) => `<tr><td class="dim" style="white-space:nowrap">${esc(new Date(l.at).toLocaleString('en-GB'))}</td><td><pre>${esc(l.message)}</pre></td></tr>`)
    .join('');
  const facts: [string, string | null][] = [
    ['State', LABEL[item.state]],
    ['Note', item.note],
    ['Node', item.node],
    ['Video', item.video_path],
    ['Translated from', item.source_path],
    ['Machine subtitle', item.out_path],
    ['Eligible', ago(item.eligible_at, now)],
    ['Attempts', String(item.attempts)],
  ];
  return page(
    `subfill - ${item.title}`,
    `<p><a href="/">&larr; All items</a></p><h1>${esc(item.title)}</h1><p>${actions(item, `/item?key=${encodeURIComponent(key)}`)}</p>
<div class="card wrap"><table>${facts.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v ?? '-')}</td></tr>`).join('')}</table></div>
<h2>Log</h2><div class="card wrap"><table>${log || '<tr><td class="dim">No entries.</td></tr>'}</table></div>`,
  );
}

// What Malak reads to decide whether to ask about waking the PC.
export function summary(deps: WebDeps): Record<string, unknown> {
  const now = (deps.now ?? Date.now)();
  const counts = deps.store.counts();
  const held = deps.store.heldNow(now);
  return {
    ready: deps.store.readyCount(now),
    waiting: counts.waiting,
    translating: counts.translating,
    failed: counts.failed,
    held: held ? { key: held.key, title: held.title, until: held.held_until } : null,
    nodes: deps.status().nodes.map((n) => ({
      name: n.name,
      state: n.state,
      current: n.current ? { title: n.current.title, done: n.current.done, total: n.current.total } : null,
    })),
  };
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, code: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  send(res, code, JSON.stringify(body), { 'content-type': 'application/json; charset=utf-8' });
}

// Only ever send the browser back to a path on this site. Browsers read a
// backslash as a slash, so "/\evil.example" would leave it too.
export function safeBack(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : '/';
}

// The bearer token, compared in constant time.
export function tokenMatches(header: string | undefined, token: string | undefined): boolean {
  if (!token || !header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length));
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

export function makeHandler(deps: WebDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const fetcher = deps.fetcher ?? fetch;
  const gate = deps.loginUrl.replace(/\/+$/, '');

  async function passToGate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = req.method === 'POST' ? await readBody(req, 65536) : undefined;
    const headers: Record<string, string> = {};
    for (const h of ['cookie', 'content-type']) if (req.headers[h]) headers[h] = String(req.headers[h]);
    const r = await fetcher(`${gate}${req.url}`, { method: req.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    const out: Record<string, string> = { 'content-type': r.headers.get('content-type') ?? 'text/html; charset=utf-8' };
    for (const h of ['location', 'set-cookie']) {
      const v = r.headers.get(h);
      if (v) out[h] = v;
    }
    send(res, r.status, await r.text(), out);
  }

  async function signedIn(req: IncomingMessage): Promise<{ ok: true } | { ok: false; redirect: string }> {
    const r = await fetcher(`${gate}/auth`, {
      headers: { cookie: String(req.headers.cookie ?? ''), 'x-forwarded-uri': req.url ?? '/' },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 200) return { ok: true };
    return { ok: false, redirect: safeBack(r.headers.get('x-login-redirect')) };
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (!deps.apiToken) return sendJson(res, 404, { error: 'the API is off: SUBFILL_API_TOKEN is not set' });
    if (!tokenMatches(req.headers.authorization, deps.apiToken)) return sendJson(res, 401, { error: 'wrong or missing token' });
    if (req.method === 'GET' && path === '/api/summary') return sendJson(res, 200, summary(deps));
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await readBody(req, 4096)) || '{}') as Record<string, unknown>;
    } catch {
      return sendJson(res, 400, { error: 'the body is not JSON' });
    }
    if (path === '/api/ask') {
      const minutes = Number(body.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) return sendJson(res, 400, { error: 'minutes must be between 0 and 1440' });
      const held = deps.worker.holdForPc(minutes);
      return sendJson(res, 200, { held: held ? { key: held.key, title: held.title, until: held.held_until } : null });
    }
    if (path === '/api/answer') {
      if (body.answer === 'later') {
        deps.worker.releaseHolds();
        return sendJson(res, 200, { held: null });
      }
      if (body.answer === 'wake') {
        // The PC takes a minute or two to come up: the hold runs on from now.
        const minutes = Number(body.minutes ?? 10);
        const held = deps.worker.holdForPc(Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 1440) : 10);
        return sendJson(res, 200, { held: held ? { key: held.key, title: held.title, until: held.held_until } : null });
      }
      return sendJson(res, 400, { error: 'answer must be "wake" or "later"' });
    }
    return sendJson(res, 404, { error: 'no such route' });
  }

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://subfill.local');
    try {
      if (url.pathname === '/healthz') return send(res, 200, 'ok', { 'content-type': 'text/plain; charset=utf-8' });
      if (url.pathname.startsWith('/api/')) return await api(req, res, url.pathname);
      if (url.pathname.startsWith('/login') || url.pathname === '/logout') return await passToGate(req, res);

      let auth: Awaited<ReturnType<typeof signedIn>>;
      try {
        auth = await signedIn(req);
      } catch {
        return send(res, 503, page('subfill', '<div class="bad">The sign-in service is not answering, so the page stays closed. Check the subfill-login container.</div>'));
      }
      if (!auth.ok) return send(res, 302, '', { location: auth.redirect });

      if (req.method === 'POST' && url.pathname === '/action') {
        // The session cookie is SameSite=Lax, which already keeps other sites'
        // forms from posting here signed in; this refuses any that try.
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, 'cross-site request refused');
        const form = new URLSearchParams(await readBody(req, 8192));
        const key = form.get('key') ?? '';
        const op = form.get('op') ?? '';
        const problem =
          op === 'pause-node' || op === 'resume-node' ? deps.setNodePaused(key, op === 'pause-node') : deps.worker.act(key, op);
        if (problem) return send(res, 409, page('subfill', `<div class="bad">${esc(problem)}</div><p><a href="${esc(safeBack(form.get('back')))}">Back</a></p>`));
        return send(res, 303, '', { location: safeBack(form.get('back')) });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
      if (url.pathname === '/') return send(res, 200, renderHome(deps, url.searchParams));
      if (url.pathname === '/live') {
        const now = (deps.now ?? Date.now)();
        return sendJson(res, 200, { nodes: renderNodes(deps.status().nodes, deps.store.heldNow(now), now), stats: renderStats(deps.store, now) });
      }
      if (url.pathname === '/item') {
        const html = renderItem(deps, url.searchParams.get('key') ?? '');
        return html ? send(res, 200, html) : send(res, 404, page('subfill', '<p>No such item. <a href="/">All items</a></p>'));
      }
      return send(res, 404, page('subfill', '<p>Not found. <a href="/">All items</a></p>'));
    } catch (err) {
      console.error('request failed', req.method, url.pathname, err);
      if (!res.headersSent) send(res, 500, page('subfill', `<div class="bad">Something went wrong: ${esc((err as Error).message)}</div>`));
    }
  };
}

export function startWeb(deps: WebDeps, port: number): Server {
  const handler = makeHandler(deps);
  const server = createServer((req, res) => void handler(req, res));
  server.listen(port);
  return server;
}
