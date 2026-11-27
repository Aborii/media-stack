// subfill's page: an overview of the nodes and the library's Arabic, the
// queue in the order it runs, every show with its episodes' subtitles, the
// films, every tracked item with its log, and the activity across them, with
// the buttons to pause a node, retry, skip or translate one now. The live
// parts refresh themselves every few seconds. The pages are in views/.
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
import type { LibraryStore } from './library.ts';
import { fileFor, loadPair, type SubtitleDeps } from './subtitles.ts';
import type { Store } from './store.ts';
import { esc, page, problemPage, renderSideNodes } from './views/layout.ts';
import { renderActivity, renderItem, renderItems, renderMovies } from './views/lists.ts';
import { renderKpis, renderNodes, renderOverview } from './views/overview.ts';
import { renderQueue } from './views/queue.ts';
import { renderShow, renderShows } from './views/shows.ts';
import { renderSubtitles } from './views/subtitles.ts';
import { renderStats } from './views/stats.ts';
import { parseDay } from './stats.ts';
import type { Status, View } from './views/view.ts';
import type { Worker } from './worker.ts';

export { esc };
export type { Status };

export type WebDeps = {
  store: Store;
  library: LibraryStore;
  worker: Pick<Worker, 'act' | 'exclude' | 'showFirst' | 'holdForPc' | 'releaseHolds' | 'markPcWoken'>;
  status: () => Status;
  // Pauses or resumes a node by name; returns a problem, or null.
  setNodePaused: (name: string, paused: boolean) => string | null;
  loginUrl: string;
  // Where to read subtitles from, for the subtitles page; off without it.
  subtitles?: SubtitleDeps;
  apiToken?: string;
  fetcher?: typeof fetch;
  now?: () => number;
};

// The parts of a page /live can send fresh, and the page asking, for the
// buttons inside them to return to.
const LIVE_PARTS: Record<string, (v: View, back: string) => string> = { nodes: renderNodes, kpis: renderKpis, side: renderSideNodes };

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
      // When its Ollama last answered, or null if it never has (a PC whose
      // subtitle Ollama is not installed yet): Malak asks only for one that has.
      lastSeen: n.lastSeen,
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
  const itemsOf = (key: string) => itemsOfWith(deps.library, key);

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
    let parsed: unknown;
    try {
      parsed = JSON.parse((await readBody(req, 4096)) || '{}');
    } catch {
      return sendJson(res, 400, { error: 'the body is not JSON' });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return sendJson(res, 400, { error: 'the body must be a JSON object' });
    }
    const body = parsed as Record<string, unknown>;
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
        // The wake also lets the PC node hold its lease, for a PC that comes
        // up within the half hour.
        const minutes = Number(body.minutes ?? 10);
        deps.worker.markPcWoken(30);
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
        return send(res, 503, problemPage('The sign-in service is not answering, so the page stays closed. Check the subfill-login container.'));
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
          op === 'pause-node' || op === 'resume-node'
            ? deps.setNodePaused(key, op === 'pause-node')
            : op === 'exclude' || op === 'include'
              ? deps.worker.exclude(key, op === 'exclude', itemsOf(key))
              : op === 'show-now'
                ? deps.worker.showFirst(key, itemsOf(key))
                : deps.worker.act(key, op);
        if (problem) return send(res, 409, problemPage(problem, safeBack(form.get('back'))));
        return send(res, 303, '', { location: safeBack(form.get('back')) });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
      const v: View = { store: deps.store, library: deps.library, status: deps.status(), now: (deps.now ?? Date.now)() };
      const q = url.searchParams;
      switch (url.pathname) {
        case '/':
          // The old page was the item list, filtered by these; a bookmark of it lands there.
          if (q.has('state') || q.has('q')) return send(res, 302, '', { location: `/items?${q}` });
          return send(res, 200, renderOverview(v));
        case '/queue':
          return send(res, 200, renderQueue(v));
        case '/shows':
          return send(res, 200, renderShows(v, q));
        case '/show': {
          const id = Number(q.get('id'));
          const html = Number.isSafeInteger(id) ? renderShow(v, id) : null;
          return html ? send(res, 200, html) : send(res, 404, notFound('No such show.', '/shows', 'All shows'));
        }
        case '/movies':
          return send(res, 200, renderMovies(v, q));
        case '/items':
          return send(res, 200, renderItems(v, q));
        case '/item': {
          const html = renderItem(v, q.get('key') ?? '');
          return html ? send(res, 200, html) : send(res, 404, notFound('No such item.', '/items', 'All items'));
        }
        case '/subtitles': {
          const item = deps.store.get(q.get('key') ?? '');
          if (!item || !deps.subtitles) return send(res, 404, notFound('No such item.', '/items', 'All items'));
          // HEAD asks only whether it is there: no reading the video for it.
          if (req.method === 'HEAD') return send(res, 200, '');
          return send(res, 200, renderSubtitles(v, item, await loadPair(item, deps.subtitles)));
        }
        case '/subtitles/file': {
          const item = deps.store.get(q.get('key') ?? '');
          const which = q.get('which');
          if (!item || !deps.subtitles || (which !== 'arabic' && which !== 'original')) {
            return send(res, 404, notFound('No such subtitle.', '/items', 'All items'));
          }
          if (req.method === 'HEAD') return send(res, 200, '', { 'content-type': 'application/x-subrip; charset=utf-8' });
          let file: { name: string; body: string };
          try {
            file = await fileFor(item, which, deps.subtitles);
          } catch (err) {
            return send(res, 404, problemPage(`Could not read that subtitle: ${(err as Error).message}.`, `/subtitles?key=${encodeURIComponent(item.key)}`));
          }
          return send(res, 200, file.body, {
            'content-type': 'application/x-subrip; charset=utf-8',
            'content-disposition': `attachment; filename="${file.name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
          });
        }
        case '/stats': {
          // A day to look at: today unless one is asked for, and never the future.
          const asked = parseDay(q.get('day'));
          return send(res, 200, renderStats(v, asked !== null && asked <= v.now ? asked : v.now));
        }
        case '/activity':
          return send(res, 200, renderActivity(v));
        case '/live': {
          const wanted = (q.get('parts') ?? 'nodes,kpis').split(',').filter((p) => Object.hasOwn(LIVE_PARTS, p));
          const back = safeBack(q.get('back'));
          return sendJson(res, 200, Object.fromEntries(wanted.map((p) => [p, LIVE_PARTS[p](v, back)])));
        }
      }
      return send(res, 404, notFound('Not found.', '/', 'Overview'));
    } catch (err) {
      console.error('request failed', req.method, url.pathname, err);
      if (!res.headersSent) send(res, 500, problemPage(`Something went wrong: ${(err as Error).message}`));
    }
  };
}

// The items a show or film mark covers: the show's episodes, or the film.
function itemsOfWith(library: LibraryStore, key: string): string[] {
  const m = key.match(/^series:(\d+)$/);
  return m ? library.episodeKeys(Number(m[1])) : [key];
}

function notFound(message: string, back: string, label: string): string {
  return page({ title: 'subfill', body: `<p>${esc(message)} <a href="${back}">${esc(label)}</a></p>` });
}

export function startWeb(deps: WebDeps, port: number): Server {
  const handler = makeHandler(deps);
  const server = createServer((req, res) => void handler(req, res));
  server.listen(port);
  return server;
}
