import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Store } from '../src/store.ts';
import { esc, startWeb, type Status } from '../src/web.ts';

// The page runs on a loopback port; the sign-in gate is a fake fetch, so
// nothing leaves the machine.
const store = new Store(':memory:');
const acted: [string, string][] = [];
let gateUp = true;

const gate = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (!gateUp) throw new Error('connect ECONNREFUSED');
  const cookie = (init?.headers as Record<string, string>)?.cookie ?? '';
  if (url.pathname === '/auth') {
    return cookie.includes('subfill_session=good')
      ? new Response('ok', { status: 200 })
      : new Response('no', { status: 401, headers: { 'x-login-redirect': '/login?next=%2F' } });
  }
  if (url.pathname === '/login' && init?.method === 'POST') {
    return new Response('', { status: 302, headers: { location: '/', 'set-cookie': 'subfill_session=good; Path=/' } });
  }
  return new Response('<form>sign in</form>', { status: 200, headers: { 'content-type': 'text/html' } });
}) as typeof fetch;

const status: Status = {
  bazarrError: null,
  lastSync: null,
  model: 'translategemma:12b',
  nodes: [
    { name: 'mini', label: 'Mini (CPU)', state: 'working', problem: null, current: { key: 'episode:9', title: 'Busy <i>one</i>', done: 3, total: 10, startedAt: 0 }, lease: null, lastSeen: 1 },
    { name: 'pc', label: 'PC (GPU)', state: 'offline', problem: 'model translategemma:12b is not pulled into Ollama', current: null, lease: { held: false, error: null }, lastSeen: null },
  ],
};
const paused: [string, boolean][] = [];
const holds: number[] = [];
let released = 0;
export const API_TOKEN = 'secret-token';
const server = startWeb(
  {
    store,
    worker: {
      act: (key: string, op: string) => (acted.push([key, op]), key === 'bad' ? 'cannot do that' : null),
      holdForPc: (minutes: number) => (holds.push(minutes), store.get('episode:1')),
      releaseHolds: () => void released++,
    },
    status: () => status,
    setNodePaused: (name: string, p: boolean) => (paused.push([name, p]), name === 'nope' ? 'no node called nope' : null),
    loginUrl: 'http://subfill-login:8000',
    apiToken: API_TOKEN,
    fetcher: gate,
  },
  0,
);
let base = '';

before(async () => {
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  store.insert({ key: 'episode:1', kind: 'episode', bazarr_id: 1, title: 'Show <b>1x01</b>', video_path: '/data/v.mkv', source_path: null, source_lang: null, out_path: null, state: 'failed', note: 'boom', eligible_at: 0 });
  store.log('episode:1', 'failed, giving up: boom');
});
after(() => server.close());

// The loopback page itself is reached with Node's own http client, since the
// global fetch is the no-network guard.
function call(path: string, opts: { method?: string; cookie?: string; body?: string; origin?: string; token?: string; json?: boolean } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(base + path, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.origin ? { origin: opts.origin } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body ? { 'content-type': opts.json ? 'application/json' : 'application/x-www-form-urlencoded' } : {}),
      },
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

test('/healthz answers without a session', async () => {
  const r = await call('/healthz');
  assert.equal(r.status, 200);
});

test('everything else sends a stranger to the sign-in form', async () => {
  const r = await call('/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/login?next=%2F');
  assert.equal((await call('/item?key=episode:1')).status, 302);
  assert.equal((await call('/action', { method: 'POST', body: 'key=episode:1&op=retry' })).status, 302);
  assert.equal(acted.length, 0);
});

test('the sign-in form and its answer pass through to the gate, cookie included', async () => {
  assert.match((await call('/login?next=%2F')).body, /sign in/);
  const r = await call('/login', { method: 'POST', body: 'username=a&password=b' });
  assert.equal(r.status, 302);
  assert.match(String(r.headers['set-cookie']), /subfill_session=good/);
});

test('signed in, the page lists items with titles escaped and problems shown', async () => {
  const r = await call('/', { cookie: 'subfill_session=good' });
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('Show &#60;b&#62;1x01&#60;/b&#62;'));
  assert.ok(!r.body.includes('<b>1x01</b>'));
  assert.match(r.body, /is not pulled into Ollama/);
  assert.match(r.body, />Retry</);
  // The nodes panel: each node, its state, and what it is translating.
  assert.match(r.body, /Mini \(CPU\)/);
  assert.match(r.body, /PC \(GPU\)/);
  assert.ok(r.body.includes('Busy &#60;i&#62;one&#60;/i&#62;'));
  assert.match(r.body, /3 of 10 lines/);
  const filtered = await call('/?state=done', { cookie: 'subfill_session=good' });
  assert.match(filtered.body, /Nothing here/);
  const item = await call('/item?key=episode%3A1', { cookie: 'subfill_session=good' });
  assert.match(item.body, /failed, giving up: boom/);
  assert.equal((await call('/item?key=nope', { cookie: 'subfill_session=good' })).status, 404);
});

test('actions run, and only send the browser back to this site', async () => {
  const r = await call('/action', { method: 'POST', cookie: 'subfill_session=good', body: 'key=episode%3A1&op=retry&back=https%3A%2F%2Fevil.example' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/');
  assert.deepEqual(acted.at(-1), ['episode:1', 'retry']);
  const refused = await call('/action', { method: 'POST', cookie: 'subfill_session=good', body: 'key=bad&op=retry' });
  assert.equal(refused.status, 409);
  assert.match(refused.body, /cannot do that/);
});

test('a post from another site is refused even with the cookie', async () => {
  const before = acted.length;
  const r = await call('/action', { method: 'POST', cookie: 'subfill_session=good', origin: 'http://evil.example', body: 'key=episode%3A1&op=skip' });
  assert.equal(r.status, 403);
  assert.equal(acted.length, before);
});

test('with the gate down the page stays closed', async () => {
  gateUp = false;
  try {
    const r = await call('/', { cookie: 'subfill_session=good' });
    assert.equal(r.status, 503);
    assert.match(r.body, /stays closed/);
  } finally {
    gateUp = true;
  }
});

test('esc covers the HTML specials', () => {
  assert.equal(esc(`<a href="x">'&'</a>`), '&#60;a href=&#34;x&#34;&#62;&#39;&#38;&#39;&#60;/a&#62;');
});

test('the live refresh sends fresh nodes and counters, behind the sign-in', async () => {
  assert.equal((await call('/live')).status, 302);
  const r = await call('/live', { cookie: 'subfill_session=good' });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body) as { nodes: string; stats: string };
  assert.match(j.nodes, /PC \(GPU\)/);
  assert.match(j.stats, /Ready/);
});

test('a node is paused and resumed from the page', async () => {
  const p = await call('/action', { method: 'POST', cookie: 'subfill_session=good', body: 'key=pc&op=pause-node&back=%2F' });
  assert.equal(p.status, 303);
  await call('/action', { method: 'POST', cookie: 'subfill_session=good', body: 'key=pc&op=resume-node&back=%2F' });
  assert.deepEqual(paused.slice(-2), [['pc', true], ['pc', false]]);
  const bad = await call('/action', { method: 'POST', cookie: 'subfill_session=good', body: 'key=nope&op=pause-node' });
  assert.equal(bad.status, 409);
});

test('the API wants its token, not a session', async () => {
  assert.equal((await call('/api/summary')).status, 401);
  assert.equal((await call('/api/summary', { cookie: 'subfill_session=good' })).status, 401);
  assert.equal((await call('/api/summary', { token: 'wrong' })).status, 401);
  assert.equal((await call('/api/summary', { token: `${API_TOKEN}x` })).status, 401);
  const r = await call('/api/summary', { token: API_TOKEN });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body) as { ready: number; nodes: { name: string; state: string }[] };
  assert.equal(typeof j.ready, 'number');
  assert.deepEqual(
    j.nodes.map((n) => [n.name, n.state]),
    [
      ['mini', 'working'],
      ['pc', 'offline'],
    ],
  );
});

test('the API holds an item for the PC and lets it go', async () => {
  const ask = await call('/api/ask', { method: 'POST', token: API_TOKEN, json: true, body: JSON.stringify({ minutes: 10 }) });
  assert.equal(ask.status, 200);
  assert.equal(holds.at(-1), 10);
  const wake = await call('/api/answer', { method: 'POST', token: API_TOKEN, json: true, body: JSON.stringify({ answer: 'wake' }) });
  assert.equal(wake.status, 200);
  assert.equal(holds.at(-1), 10);
  const before = released;
  await call('/api/answer', { method: 'POST', token: API_TOKEN, json: true, body: JSON.stringify({ answer: 'later' }) });
  assert.equal(released, before + 1);
  assert.equal((await call('/api/ask', { method: 'POST', token: API_TOKEN, json: true, body: JSON.stringify({ minutes: -1 }) })).status, 400);
  assert.equal((await call('/api/answer', { method: 'POST', token: API_TOKEN, json: true, body: JSON.stringify({ answer: 'maybe' }) })).status, 400);
  assert.equal((await call('/api/ask', { method: 'POST', token: API_TOKEN, json: true, body: 'not json' })).status, 400);
  assert.equal((await call('/api/summary', { method: 'POST', token: API_TOKEN, json: true, body: '{}' })).status, 404);
  assert.equal((await call('/api/ask', { token: API_TOKEN })).status, 405);
});
