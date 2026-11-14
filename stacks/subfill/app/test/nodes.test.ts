// Two nodes on one queue, the hold for the PC, the PC's lease, and a database
// made before the node columns existed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Lease } from '../src/lease.ts';
import { NodeRunner, type Model } from '../src/nodes.ts';
import { Store } from '../src/store.ts';
import { arabicModel, episode, json, mediaDir, setup } from './helpers.ts';

const up = (generate = arabicModel): Model => ({ problem: async () => null, generate });
const down: Model = { problem: async () => 'Ollama unreachable: fetch failed', generate: arabicModel };
const FAST = { idle: 0, offline: 0, paused: 0 };

function fakePowerClient(calls: string[], fail = false): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method} ${new URL(String(input)).pathname} ${(init?.headers as Record<string, string>).authorization}`);
    return fail ? json({ error: 'nope' }, 500) : json({ ok: true });
  }) as typeof fetch;
}

test('two nodes on one queue never take the same item', async () => {
  const root = mediaDir();
  const items = [episode(root, 1, 'One'), episode(root, 2, 'Two'), episode(root, 3, 'Three')];
  const { store, worker } = setup(items);
  await worker.sync();
  // Each model waits a tick, so both nodes are mid-item at the same time.
  const slow = async (p: string) => (await new Promise((r) => setTimeout(r, 5)), arabicModel(p));
  const mini = new NodeRunner({ name: 'mini', label: 'Mini', model: up(slow), worker, store, waitMs: FAST });
  const pc = new NodeRunner({ name: 'pc', label: 'PC', model: up(slow), worker, store, takesHeld: true, waitMs: FAST });
  await Promise.all([mini.step(), pc.step()]);
  await Promise.all([mini.step(), pc.step()]);
  const rows = ['episode:1', 'episode:2', 'episode:3'].map((k) => store.get(k)!);
  assert.deepEqual(
    rows.map((r) => r.state),
    ['done', 'done', 'done'],
  );
  assert.deepEqual(new Set(rows.map((r) => r.node)), new Set(['mini', 'pc']));
  assert.ok(rows.every((r) => r.attempts === 1));
});

test('an item held for the PC is skipped by the mini until the hold ends', async () => {
  const root = mediaDir();
  let now = Date.now() + 1000;
  const items = [episode(root, 1, 'Older'), episode(root, 2, 'Newer')];
  const { store, worker } = setup(items, {}, arabicModel);
  await worker.sync();
  const clock = () => now;
  const held = store.hold(clock(), clock() + 10 * 60_000)!;
  // The mini takes the other one, and then nothing while the hold lasts.
  assert.notEqual(store.next(clock())?.key, held.key);
  store.move(store.next(clock())!.key, ['eligible'], 'done');
  assert.equal(store.next(clock()), undefined);
  // The PC takes the held one first.
  assert.equal(store.next(clock(), true)?.key, held.key);
  // Ten minutes on, the mini may take it too.
  now += 10 * 60_000 + 1;
  assert.equal(store.next(clock())?.key, held.key);
  void worker;
});

test('holdForPc moves an existing hold instead of holding a second item', async () => {
  const root = mediaDir();
  const { store, worker } = setup([episode(root, 1, 'A'), episode(root, 2, 'B')]);
  await worker.sync();
  const first = worker.holdForPc(10)!;
  const again = worker.holdForPc(20)!;
  assert.equal(again.key, first.key);
  assert.ok(again.held_until! > first.held_until!);
  worker.releaseHolds();
  assert.equal(store.heldNow(Date.now()), undefined);
});

test('claiming a held item clears the hold and records the node', async () => {
  const root = mediaDir();
  const { store, worker } = setup([episode(root, 1, 'A')]);
  await worker.sync();
  worker.holdForPc(10);
  const pc = new NodeRunner({ name: 'pc', label: 'PC', model: up(), worker, store, takesHeld: true, waitMs: FAST });
  await pc.step();
  const row = store.get('episode:1')!;
  assert.equal(row.state, 'done');
  assert.equal(row.node, 'pc');
  assert.equal(row.held_until, null);
  assert.match(row.note!, /on the pc/);
});

test('the PC holds its lease only while it has work, and never asks for a wake', async () => {
  const root = mediaDir();
  const calls: string[] = [];
  const { store, worker } = setup([episode(root, 1, 'A')]);
  await worker.sync();
  const lease = new Lease({ url: 'http://pc-power-client:8791/', token: 'tok', fetcher: fakePowerClient(calls) });
  const pc = new NodeRunner({ name: 'pc', label: 'PC', model: up(), worker, store, lease, takesHeld: true, waitMs: FAST });
  await pc.step();
  assert.equal(lease.state.held, true);
  assert.deepEqual(calls, ['PUT /apps/subfill Bearer tok']);
  await pc.step(); // nothing left
  assert.equal(lease.state.held, false);
  assert.deepEqual(calls, ['PUT /apps/subfill Bearer tok', 'DELETE /apps/subfill Bearer tok']);
  await pc.step(); // still nothing: no second release
  assert.equal(calls.length, 2);
});

test('the lease renews itself while held, and a failure is shown, not thrown', async () => {
  const calls: string[] = [];
  const lease = new Lease({ url: 'http://pc', token: 't', fetcher: fakePowerClient(calls, true), renewMs: 10 });
  await lease.hold();
  await new Promise((r) => setTimeout(r, 35));
  await lease.release();
  assert.ok(calls.filter((c) => c.startsWith('PUT')).length >= 2);
  assert.match(lease.state.error!, /release failed: power client answered 500/);
  const quiet: string[] = [];
  const ok = new Lease({ url: 'http://pc', token: 't', fetcher: fakePowerClient(quiet) });
  await ok.hold();
  await ok.hold();
  assert.equal(quiet.length, 1);
  await ok.release();
  const broken = new Lease({ url: 'http://pc', token: 't', fetcher: (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch });
  await broken.hold();
  assert.match(broken.state.error!, /renewal failed: ECONNREFUSED/);
  await broken.release();
});

test('a node that is offline, paused or outside its hours takes nothing', async () => {
  const root = mediaDir();
  const calls: string[] = [];
  const { store, worker } = setup([episode(root, 1, 'A')]);
  await worker.sync();
  const lease = new Lease({ url: 'http://pc', token: 't', fetcher: fakePowerClient(calls) });
  const pc = new NodeRunner({ name: 'pc', label: 'PC', model: down, worker, store, lease, takesHeld: true, waitMs: FAST });
  await pc.step();
  assert.equal(pc.status().state, 'offline');
  assert.match(pc.status().problem!, /unreachable/);
  assert.equal(pc.status().lastSeen, null);

  const mini = new NodeRunner({ name: 'mini', label: 'Mini', model: up(), worker, store, waitMs: FAST });
  mini.setPaused(true);
  assert.equal(mini.paused, true);
  await mini.step();
  assert.equal(mini.status().state, 'paused');
  mini.setPaused(false);

  const hour = new Date().getHours();
  const night = new NodeRunner({ name: 'mini', label: 'Mini', model: up(), worker, store, hours: { from: (hour + 1) % 24, to: (hour + 2) % 24 }, waitMs: FAST });
  await night.step();
  assert.equal(night.status().state, 'outside_hours');
  assert.equal(store.get('episode:1')!.state, 'eligible');
  assert.equal(calls.length, 0);
});

test('a PC that drops mid-item hands it to the mini with no attempt used', async () => {
  const root = mediaDir();
  const { OllamaDown } = await import('../src/ollama.ts');
  const { store, worker } = setup([episode(root, 1, 'A')], { maxAttempts: 1 });
  await worker.sync();
  const asleep = async (): Promise<string> => {
    throw new OllamaDown('Ollama call failed: aborted');
  };
  const pc = new NodeRunner({ name: 'pc', label: 'PC', model: up(asleep), worker, store, takesHeld: true, waitMs: FAST });
  await pc.step();
  assert.equal(store.get('episode:1')!.state, 'eligible');
  assert.equal(store.get('episode:1')!.attempts, 0);
  const mini = new NodeRunner({ name: 'mini', label: 'Mini', model: up(), worker, store, waitMs: FAST });
  await mini.step();
  assert.equal(store.get('episode:1')!.state, 'done');
  assert.equal(store.get('episode:1')!.node, 'mini');
});

test('a node loop survives a step that throws, and stops when told', async () => {
  const root = mediaDir();
  const { store, worker } = setup([episode(root, 1, 'A')]);
  let calls = 0;
  const flaky: Model = {
    problem: async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return 'gone';
    },
    generate: arabicModel,
  };
  const node = new NodeRunner({ name: 'pc', label: 'PC', model: flaky, worker, store, waitMs: { idle: 1, offline: 1, paused: 1 } });
  const running = node.run();
  await new Promise((r) => setTimeout(r, 20));
  await node.stop();
  await running;
  assert.ok(calls >= 2);
});

test('a database from before the node columns gains them, rows kept', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'subfill-db-')), 'subfill.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE items (key TEXT PRIMARY KEY, kind TEXT NOT NULL, bazarr_id INTEGER NOT NULL, title TEXT NOT NULL,
    video_path TEXT NOT NULL, source_path TEXT, source_lang TEXT, out_path TEXT, state TEXT NOT NULL, note TEXT,
    eligible_at INTEGER NOT NULL, priority INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER);
    INSERT INTO items (key, kind, bazarr_id, title, video_path, state, eligible_at, first_seen, updated_at)
      VALUES ('episode:1', 'episode', 1, 'Old', '/v', 'eligible', 0, 0, 0);`);
  old.close();
  const store = new Store(file);
  const row = store.get('episode:1')!;
  assert.equal(row.title, 'Old');
  assert.equal(row.held_until, null);
  assert.equal(row.node, null);
  assert.equal(store.next(1, false)?.key, 'episode:1');
  store.close();
  // Opening it again changes nothing.
  new Store(file).close();
});
