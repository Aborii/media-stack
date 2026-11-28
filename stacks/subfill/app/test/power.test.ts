// The PC's power on its card: on with the model down, asleep or off with a
// Turn on button when the power client allows it, and the button itself.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LibraryStore } from '../src/library.ts';
import type { NodeStatus } from '../src/nodes.ts';
import { PcPower } from '../src/power.ts';
import { Store } from '../src/store.ts';
import { renderSideNodes } from '../src/views/layout.ts';
import { renderNodes } from '../src/views/overview.ts';
import { json } from './helpers.ts';

function client(answers: Record<string, () => Response>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    calls.push(key);
    if ((init?.headers as Record<string, string>)?.authorization !== 'Bearer tok') return json({ error: 'no' }, 401);
    return (answers[key] ?? (() => json({ error: 'no such route' }, 404)))();
  }) as typeof fetch;
}

test('the power client is asked how the PC is and whether subfill may turn it on', async () => {
  const p = new PcPower({ url: 'http://pc-power-client:8791/', token: 'tok', now: () => 5, fetcher: client({ 'GET /status': () => json({ pc: 'asleep' }), 'GET /me': () => json({ app: 'subfill', can: ['on'] }) }) });
  assert.deepEqual(await p.refresh(), { pc: 'asleep', canTurnOn: true, checkedAt: 5, error: null, wakeError: null });
  // An older power client with no /me: the state, but no button.
  const old = new PcPower({ url: 'http://x', token: 'tok', fetcher: client({ 'GET /status': () => json({ pc: 'on' }) }) });
  assert.equal((await old.refresh()).canTurnOn, false);
  // Unreachable after a good reading: the old reading is dropped, the reason kept, nothing thrown.
  let up = true;
  const flaky = new PcPower({ url: 'http://x', token: 'tok', fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
    if (!up) throw new Error('connect ECONNREFUSED');
    return client({ 'GET /status': () => json({ pc: 'on' }), 'GET /me': () => json({ can: ['on'] }) })(input, init);
  }) as typeof fetch });
  assert.equal((await flaky.refresh()).pc, 'on');
  up = false;
  const after = await flaky.refresh();
  assert.deepEqual([after.pc, after.canTurnOn], [null, false]);
  assert.match(after.error ?? '', /ECONNREFUSED/);
  // A wake under way reads as starting; a wake that gave up says why.
  const waking = new PcPower({ url: 'http://x', token: 'tok', fetcher: client({ 'GET /status': () => json({ pc: 'off', wake: { waking: true, lastError: null } }), 'GET /me': () => json({ can: ['on'] }) }) });
  assert.equal((await waking.refresh()).pc, 'starting');
  const gaveUp = new PcPower({ url: 'http://x', token: 'tok', fetcher: client({ 'GET /status': () => json({ pc: 'off', wake: { waking: false, lastError: 'the PC did not come up in 300 s' } }), 'GET /me': () => json({ can: ['on'] }) }) });
  assert.equal((await gaveUp.refresh()).wakeError, 'the PC did not come up in 300 s');
});

test('Turn on calls the power client, and says plainly when it is not allowed', async () => {
  const calls: string[] = [];
  const ok = new PcPower({ url: 'http://x', token: 'tok', fetcher: client({ 'POST /pc/turn-on': () => json({ pc: 'starting' }, 202) }, calls) });
  assert.equal(await ok.turnOn(), null);
  assert.deepEqual(calls, ['POST /pc/turn-on']);
  assert.equal(ok.state.pc, 'starting');
  const refused = new PcPower({ url: 'http://x', token: 'tok', fetcher: client({ 'POST /pc/turn-on': () => json({ error: 'no' }, 403) }) });
  assert.match((await refused.turnOn()) ?? '', /does not allow subfill/);
  const broken = new PcPower({ url: 'http://x', token: 'tok', fetcher: client({ 'POST /pc/turn-on': () => json({ error: 'the switch did not answer' }, 502) }) });
  assert.match((await broken.turnOn()) ?? '', /the switch did not answer/);
});

function card(power: NodeStatus['power']): { card: string; side: string } {
  const store = new Store(':memory:');
  const pc: NodeStatus = { name: 'pc', label: 'PC (GPU)', state: 'offline', paused: false, problem: 'Ollama call failed: fetch failed', current: null, lease: null, lastSeen: 1, power };
  const v = { store, library: new LibraryStore(store.db), now: 60_000, status: { bazarrError: null, lastSync: null, model: 'm', nodes: [pc] } };
  return { card: renderNodes(v, '/queue'), side: renderSideNodes(v) };
}

test('the PC card says whether the PC or only its model is off, and offers Turn on only when it can help', () => {
  const on = card({ pc: 'on', canTurnOn: true, checkedAt: 30_000, error: null });
  assert.match(on.card, /PC is on, but its subtitle model is not running/);
  assert.match(on.card, /class="dot model-down"/);
  assert.ok(!on.card.includes('pc-turn-on'));
  assert.match(on.side, /model off/);
  const asleep = card({ pc: 'asleep', canTurnOn: true, checkedAt: 30_000, error: null });
  assert.match(asleep.card, /PC is asleep/);
  assert.match(asleep.card, /name="op" value="pc-turn-on"><input type="hidden" name="back" value="\/queue"><button class="btn primary">Turn on/);
  assert.match(asleep.side, /asleep/);
  // Not allowed by the power client: the state, but no button.
  assert.ok(!card({ pc: 'off', canTurnOn: false, checkedAt: 30_000, error: null }).card.includes('pc-turn-on'));
  assert.match(card({ pc: 'starting', canTurnOn: true, checkedAt: 30_000, error: null }).card, /PC is starting/);
  // No reading yet: the plain offline line, as before.
  assert.match(card(null).card, /offline &middot; Ollama call failed/);
  // The power client unreachable: says it cannot tell, and no button.
  const unknown = card({ pc: null, canTurnOn: false, checkedAt: 30_000, error: 'could not ask the power client: timeout' });
  assert.match(unknown.card, /the power client cannot be asked about the PC/);
  assert.ok(!unknown.card.includes('pc-turn-on'));
  // A wake that gave up is shown, with the button to try again.
  const gave = card({ pc: 'off', canTurnOn: true, checkedAt: 30_000, error: null, wakeError: 'the PC did not come up in 300 s' });
  assert.match(gave.card, /The last wake gave up: the PC did not come up in 300 s/);
  assert.match(gave.card, /pc-turn-on/);
});
