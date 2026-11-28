// The PC's power and subfill's Pause/Resume are separate: the power is known
// whether the node is paused or not, Resume never turns the PC on and takes
// effect at once, and Turn on never resumes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LibraryStore } from '../src/library.ts';
import { NodeRunner } from '../src/nodes.ts';
import { PcPower } from '../src/power.ts';
import { renderNodes } from '../src/views/overview.ts';
import { episode, json, mediaDir, setup } from './helpers.ts';

function powerClient(pc: () => string, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/status') return json({ pc: pc(), wake: { waking: false, lastError: null } });
    if (url.pathname === '/me') return json({ app: 'subfill', can: ['on'] });
    if (url.pathname === '/pc/turn-on') return json({ pc: 'starting' }, 202);
    return json({}, 404);
  }) as typeof fetch;
}

async function pcNode(opts: { pc: () => string; modelUp: () => boolean; paused: boolean; calls?: string[] }) {
  const root = mediaDir();
  const { store, worker } = setup([episode(root, 1, 'One')]);
  await worker.sync();
  if (opts.paused) store.setMeta('paused:pc', '1');
  const power = new PcPower({ url: 'http://pc-power-client:8791', token: 'tok', fetcher: powerClient(opts.pc, opts.calls) });
  let generated = 0;
  const node = new NodeRunner({
    name: 'pc',
    label: 'PC (GPU)',
    store,
    worker,
    power,
    model: {
      problem: async () => (opts.modelUp() ? null : 'Ollama unreachable: fetch failed'),
      generate: async (p) => {
        generated++;
        return (await import('./helpers.ts')).arabicModel(p);
      },
    },
    waitMs: { idle: 60_000, offline: 30_000, paused: 15_000 },
    powerEveryMs: 60_000,
  });
  const card = () => renderNodes({ store, library: new LibraryStore(store.db), now: Date.now(), status: { bazarrError: null, lastSync: null, model: 'm', nodes: [node.status()] } });
  return { store, node, power, card, generated: () => generated };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

test('a paused node still knows, and shows, that the PC is off, with Turn on', async () => {
  const n = await pcNode({ pc: () => 'off', modelUp: () => false, paused: true });
  const running = n.node.run();
  await settle();
  assert.equal(n.node.status().power?.pc, 'off');
  const card = n.card();
  assert.match(card, /PC is off/);
  assert.match(card, /paused by you/);
  assert.match(card, /value="pc-turn-on"/);
  assert.match(card, /value="resume-node"/);
  await n.node.stop();
  await running;
});

test('Resume with the PC off says so at once, claims nothing, and never turns the PC on', async () => {
  const calls: string[] = [];
  const n = await pcNode({ pc: () => 'off', modelUp: () => false, paused: true, calls });
  const running = n.node.run();
  await settle();
  n.node.setPaused(false);
  await settle();
  // No 15 s wait for the paused loop: the card says what is going on now.
  const card = n.card();
  assert.match(card, /PC is off/);
  assert.match(card, /waiting for the PC/);
  assert.ok(!card.includes('paused by you'));
  assert.equal(n.store.get('episode:1')!.state, 'eligible');
  assert.equal(n.generated(), 0);
  assert.ok(!calls.includes('POST /pc/turn-on'), calls.join(','));
  await n.node.stop();
  await running;
});

test('a resumed node starts by itself once the PC and its model come on', async () => {
  let up = false;
  const n = await pcNode({ pc: () => (up ? 'on' : 'off'), modelUp: () => up, paused: false });
  const running = n.node.run();
  await settle();
  assert.match(n.card(), /waiting for the PC/);
  up = true;
  n.node.poke();
  for (let i = 0; i < 40 && n.store.get('episode:1')!.state !== 'done'; i++) await settle();
  assert.equal(n.store.get('episode:1')!.state, 'done');
  await n.node.stop();
  await running;
});

test('Turn on never resumes a paused node: nothing starts until Resume', async () => {
  let on = false;
  const n = await pcNode({ pc: () => (on ? 'on' : 'off'), modelUp: () => on, paused: true });
  const running = n.node.run();
  await settle();
  assert.equal(await n.power.turnOn(), null);
  on = true;
  n.node.poke();
  await settle();
  await settle();
  assert.equal(n.node.status().paused, true);
  assert.equal(n.store.get('episode:1')!.state, 'eligible');
  assert.equal(n.generated(), 0);
  const card = n.card();
  assert.match(card, /PC is on/);
  assert.match(card, /paused by you/);
  assert.ok(!card.includes('value="pc-turn-on"'));
  await n.node.stop();
  await running;
});
