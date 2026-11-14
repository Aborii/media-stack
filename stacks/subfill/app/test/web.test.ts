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

const status: Status = { bazarrError: null, ollamaProblem: 'model translategemma:12b is not pulled into Ollama', outsideHours: false, lastSync: null, current: null, model: 'translategemma:12b' };
const server = startWeb(
  {
    store,
    worker: { act: (key: string, op: string) => (acted.push([key, op]), key === 'bad' ? 'cannot do that' : null) },
    status: () => status,
    loginUrl: 'http://subfill-login:8000',
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
function call(path: string, opts: { method?: string; cookie?: string; body?: string; origin?: string } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(base + path, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.origin ? { origin: opts.origin } : {}),
        ...(opts.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
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
