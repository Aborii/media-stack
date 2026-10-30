// subfill's status page: what is waiting, translating, done or stuck, and the
// buttons to retry, skip or translate one now.
//
// The sign-in is the same login.py gate as Glances and OmniTools, run as
// subfill-login. Instead of a proxy in front, this server asks the gate itself:
// every request except /healthz is checked with the gate's /auth, and /login
// and /logout are passed through to it. If the gate cannot be reached the page
// stays closed rather than open.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Item, State, Store } from './store.ts';
import { STATES } from './store.ts';
import type { Current, Worker } from './worker.ts';

export type Status = {
  bazarrError: string | null;
  ollamaProblem: string | null;
  outsideHours: boolean;
  lastSync: number | null;
  current: Current | null;
  model: string;
};

export type WebDeps = {
  store: Store;
  worker: Pick<Worker, 'act'>;
  status: () => Status;
  loginUrl: string;
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
:root{color-scheme:light dark;--bg:#0f1216;--card:#181c22;--line:#262c35;--text:#e6e8eb;--dim:#9aa3ad;--accent:#3b82f6;--bad:#ffb4b4;--badbg:#3a1d1d}
@media (prefers-color-scheme:light){:root{--bg:#f6f7f9;--card:#fff;--line:#dde1e6;--text:#16191d;--dim:#5b6470;--accent:#2563eb;--bad:#8a1f1f;--badbg:#fde8e8}}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:20px 16px 40px}
h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:22px 0 8px}
a{color:var(--accent);text-decoration:none} a:hover{text-decoration:underline}
.dim{color:var(--dim)} .row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
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
progress{width:220px;max-width:100%}
pre{white-space:pre-wrap;margin:0}
</style>`;

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${STYLE}</head><body><main>${body}</main></body></html>`;
}

function actions(item: Item, back: string): string {
  const ops: [string, string][] = [];
  if (item.state === 'waiting' || item.state === 'eligible') ops.push(['now', 'Translate now']);
  if (item.state === 'failed') ops.push(['retry', 'Retry']);
  if (['waiting', 'eligible', 'failed', 'no_source'].includes(item.state)) ops.push(['skip', 'Skip']);
  if (item.state === 'skipped') ops.push(['unskip', 'Undo skip']);
  return ops
    .map(
      ([op, label]) =>
        `<form method="post" action="/action" style="display:inline"><input type="hidden" name="key" value="${esc(item.key)}"><input type="hidden" name="op" value="${op}"><input type="hidden" name="back" value="${esc(back)}"><button>${label}</button></form>`,
    )
    .join(' ');
}

export function renderHome(deps: WebDeps, query: URLSearchParams): string {
  const now = (deps.now ?? Date.now)();
  const s = deps.status();
  const counts = deps.store.counts();
  const state = STATES.find((x) => x === query.get('state'));
  const q = (query.get('q') ?? '').slice(0, 100);
  const { items, total } = deps.store.list({ state, q, limit: 200 });
  const week = deps.store.finishedSince(now - 7 * 86400_000);
  const back = `/?${query.toString()}`;

  const problems = [s.bazarrError, s.ollamaProblem].filter(Boolean).map((p) => `<div class="bad">${esc(p)}</div>`).join('');
  const working = s.current
    ? `<div class="card">Translating <b>${esc(s.current.title)}</b><br><progress max="${s.current.total}" value="${s.current.done}"></progress> <span class="dim">${s.current.done} of ${s.current.total} lines, started ${ago(s.current.startedAt, now)}</span></div>`
    : `<div class="card dim">${s.outsideHours ? 'Outside the translation hours; waiting.' : counts.eligible ? 'Starting the next one shortly.' : 'Nothing to translate right now.'}</div>`;

  const stats = [
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
        `<tr><td><a href="/item?key=${encodeURIComponent(i.key)}">${esc(i.title)}</a><div class="dim">${esc(i.note ?? '')}</div></td><td>${esc(LABEL[i.state])}</td><td class="dim">${ago(i.updated_at, now)}</td><td>${actions(i, back)}</td></tr>`,
    )
    .join('');

  return page(
    'subfill',
    `<div class="row" style="justify-content:space-between"><div><h1>subfill</h1><div class="dim">Arabic subtitles from ${esc(s.model)} when Bazarr finds none. Last sync ${ago(s.lastSync, now)}.</div></div><a href="/logout">Sign out</a></div>
${problems}${working}<div class="stats">${stats}</div>
<form class="row" method="get" action="/">${state ? `<input type="hidden" name="state" value="${esc(state)}">` : ''}<input type="search" name="q" value="${esc(q)}" placeholder="Search titles"><button>Search</button></form>
<p class="chips row">${chips}</p>
<div class="wrap"><table><thead><tr><th>Title</th><th>State</th><th>Changed</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="dim">Nothing here.</td></tr>'}</tbody></table></div>
${total > items.length ? `<p class="dim">Showing the ${items.length} most recently changed of ${total}. Search or filter to find the rest.</p>` : ''}`,
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

// Only ever send the browser back to a path on this site.
function safeBack(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/';
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

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://subfill.local');
    try {
      if (url.pathname === '/healthz') return send(res, 200, 'ok', { 'content-type': 'text/plain; charset=utf-8' });
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
        const problem = deps.worker.act(form.get('key') ?? '', form.get('op') ?? '');
        if (problem) return send(res, 409, page('subfill', `<div class="bad">${esc(problem)}</div><p><a href="${esc(safeBack(form.get('back')))}">Back</a></p>`));
        return send(res, 303, '', { location: safeBack(form.get('back')) });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
      if (url.pathname === '/') return send(res, 200, renderHome(deps, url.searchParams));
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
