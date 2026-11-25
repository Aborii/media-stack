// Getting the PC node ready to be the main worker: a crash of the model is
// not the episode's fault, old crash failures go back in the queue, and the
// node remembers across restarts whether its Ollama has ever answered.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Lease } from '../src/lease.ts';
import { CRASHES_HELD, NodeRunner, SEEN_SAVE_MS, type Model } from '../src/nodes.ts';
import { Ollama, OllamaCrash, OllamaError } from '../src/ollama.ts';
import { Store } from '../src/store.ts';
import { MAX_CRASHES } from '../src/worker.ts';
import { arabicModel, episode, episodeOnDisk, json, mediaDir, setup, type FakeMedia } from './helpers.ts';

const CRASH_TEXTS = [
  '{"error":"model runner has unexpectedly stopped, this may be due to resource limitations or an internal error, check ollama server logs for details"}',
  '{"error":"an error was encountered while running the model: unexpected EOF"}',
  // Killed while it was loading the model, the usual case on a mini short of memory.
  '{"error":"llama runner process has terminated: signal: killed"}',
  '{"error":"llama runner process no longer running: -1 "}',
];

const crashing = async (): Promise<string> => {
  throw new OllamaCrash('Ollama answered 500: model runner has unexpectedly stopped');
};

function powerClient(calls: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method} ${new URL(String(input)).pathname}`);
    return json({ ok: true });
  }) as typeof fetch;
}

test('Ollama: a runner that died is a crash; any other error answer is still an error', async () => {
  for (const text of CRASH_TEXTS) {
    const o = new Ollama({ url: 'http://o', model: 'm', fetcher: (async () => new Response(text, { status: 500 })) as typeof fetch });
    await assert.rejects(o.generate('p'), (e) => e instanceof OllamaCrash);
  }
  const plain = new Ollama({ url: 'http://o', model: 'm', fetcher: (async () => new Response('{"error":"out of context"}', { status: 500 })) as typeof fetch });
  await assert.rejects(plain.generate('p'), (e) => e instanceof OllamaError && !(e instanceof OllamaCrash));
  // Crash words in a 4xx are the request's own problem, not a crash.
  const four = new Ollama({ url: 'http://o', model: 'm', fetcher: (async () => new Response(CRASH_TEXTS[1], { status: 400 })) as typeof fetch });
  await assert.rejects(four.generate('p'), (e) => !(e instanceof OllamaCrash));
});

test('a crash puts the episode back without using an attempt, and counts it', async () => {
  const root = mediaDir();
  const crash = async (): Promise<string> => {
    throw new OllamaCrash('Ollama answered 500: model runner has unexpectedly stopped');
  };
  const { store, worker } = setup([episode(root, 1, 'Show')], { maxAttempts: 1 }, crash);
  await worker.sync();
  assert.equal(await worker.translateNext(), false);
  const row = store.get('episode:1')!;
  assert.equal(row.state, 'eligible');
  assert.equal(row.attempts, 0);
  assert.equal(row.crashes, 1);
  assert.match(row.note!, /the model crashed \(1 of 5\)/);
});

test(`an episode that crashes the model ${MAX_CRASHES} times is given up on, and Retry clears that`, async () => {
  const root = mediaDir();
  const crash = async (): Promise<string> => {
    throw new OllamaCrash('Ollama answered 500: unexpected EOF');
  };
  const { store, worker } = setup([episode(root, 1, 'Show')], {}, crash);
  await worker.sync();
  for (let i = 0; i < MAX_CRASHES; i++) await worker.translateNext();
  const row = store.get('episode:1')!;
  assert.equal(row.state, 'failed');
  assert.equal(row.crashes, MAX_CRASHES);
  assert.equal(row.attempts, 0);
  assert.match(row.note!, /crashed 5 times on this episode/);
  assert.equal(worker.act('episode:1', 'retry'), null);
  assert.equal(store.get('episode:1')!.crashes, 0);
});

test('episodes that failed only from crashes go back in the queue, once; other failures stay', () => {
  const s = new Store(':memory:');
  const base = { kind: 'episode' as const, bazarr_id: 1, title: 't', video_path: '/v', source_path: null, source_lang: null, out_path: null, eligible_at: 0 };
  s.insert({ ...base, key: 'a', state: 'failed', note: `Ollama answered 500: ${CRASH_TEXTS[0]}` });
  s.insert({ ...base, key: 'b', state: 'failed', note: `Ollama answered 500: ${CRASH_TEXTS[1]}` });
  s.insert({ ...base, key: 'c', state: 'failed', note: 'no usable Arabic for 3 lines, the last: Hi' });
  s.insert({ ...base, key: 'e', state: 'failed', note: `Ollama answered 500: ${CRASH_TEXTS[2]}` });
  // The words alone are not enough: it has to be Ollama's 5xx.
  s.insert({ ...base, key: 'f', state: 'failed', note: 'Ollama answered 400: unexpected EOF in the prompt' });
  s.insert({ ...base, key: 'd', state: 'eligible', note: 'unexpected EOF, but not failed' });
  s.update('a', { attempts: 3 });
  assert.deepEqual(s.requeueCrashFailures().sort(), ['a', 'b', 'e']);
  assert.equal(s.get('f')!.state, 'failed');
  assert.deepEqual(
    ['a', 'b', 'c', 'd'].map((k) => [s.get(k)!.state, s.get(k)!.attempts]),
    [
      ['eligible', 0],
      ['eligible', 0],
      ['failed', 0],
      ['eligible', 0],
    ],
  );
  assert.match(s.get('a')!.note!, /failed only because the model crashed/);
  assert.deepEqual(s.requeueCrashFailures(), []);
});

test('a node remembers across a restart that its Ollama has answered, and saves that sparingly', async () => {
  let now = 1_000_000_000;
  const { store, worker } = setup([episode(mediaDir(), 1, 'Show')]);
  const model: Model = { problem: async () => null, generate: arabicModel };
  const fresh = new NodeRunner({ name: 'pc', label: 'PC', model, worker, store, waitMs: { idle: 0, offline: 0, paused: 0 }, now: () => now });
  assert.equal(fresh.status().lastSeen, null);
  store.setMeta('paused:pc', '1');
  await fresh.step();
  // Paused: its Ollama was not asked, so it has still never answered.
  assert.equal(fresh.status().lastSeen, null);
  store.deleteMeta('paused:pc');
  await fresh.step();
  assert.equal(fresh.status().lastSeen, now);
  assert.equal(store.getMeta('seen:pc'), String(now));
  // A minute later it answers again; the database is not written every time.
  now += 60_000;
  await fresh.step();
  assert.equal(fresh.status().lastSeen, now);
  assert.equal(store.getMeta('seen:pc'), String(now - 60_000));
  now += SEEN_SAVE_MS;
  await fresh.step();
  assert.equal(store.getMeta('seen:pc'), String(now));
  // A restart reads it back.
  const restarted = new NodeRunner({ name: 'pc', label: 'PC', model: { problem: async () => 'asleep', generate: arabicModel }, worker, store, now: () => now });
  assert.equal(restarted.status().lastSeen, now);
});

test('a database from before crash counting gains the column, every row at 0', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'subfill-db-')), 'subfill.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE items (key TEXT PRIMARY KEY, kind TEXT NOT NULL, bazarr_id INTEGER NOT NULL, title TEXT NOT NULL,
    video_path TEXT NOT NULL, source_path TEXT, source_lang TEXT, out_path TEXT, state TEXT NOT NULL, note TEXT,
    eligible_at INTEGER NOT NULL, priority INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
    held_until INTEGER, node TEXT);
    INSERT INTO items (key, kind, bazarr_id, title, video_path, state, eligible_at, first_seen, updated_at)
      VALUES ('episode:1', 'episode', 1, 'Old', '/v', 'failed', 0, 0, 0);`);
  old.close();
  const store = new Store(file);
  assert.equal(store.get('episode:1')!.crashes, 0);
  store.close();
});

test('the summary tells Malak when each node last answered', async () => {
  const { summary } = await import('../src/web.ts');
  const s = new Store(':memory:');
  const { LibraryStore } = await import('../src/library.ts');
  const out = summary({
    store: s,
    library: new LibraryStore(s.db),
    worker: {} as never,
    setNodePaused: () => null,
    loginUrl: 'http://x',
    status: () => ({
      bazarrError: null,
      lastSync: null,
      model: 'm',
      nodes: [
        { name: 'pc', label: 'PC', state: 'offline', paused: false, problem: 'asleep', current: null, lease: null, lastSeen: 42 },
        { name: 'mini', label: 'Mini', state: 'paused', paused: true, problem: null, current: null, lease: null, lastSeen: null },
      ],
    }),
  }) as { nodes: { name: string; lastSeen: number | null }[] };
  assert.deepEqual(
    out.nodes.map((n) => [n.name, n.lastSeen]),
    [
      ['pc', 42],
      ['mini', null],
    ],
  );
});

test('a machine that keeps crashing spreads the crashes over the queue, failing no episode', async () => {
  const root = mediaDir();
  const { store, worker } = setup([episode(root, 1, 'A'), episode(root, 2, 'B'), episode(root, 3, 'C')], {}, crashing);
  await worker.sync();
  for (let i = 0; i < 7; i++) await worker.translateNext();
  const rows = ['episode:1', 'episode:2', 'episode:3'].map((k) => store.get(k)!);
  assert.deepEqual(rows.map((r) => r.state), ['eligible', 'eligible', 'eligible']);
  assert.deepEqual(rows.map((r) => r.crashes).sort(), [2, 2, 3]);
});

test('an episode that is itself what crashes the model is given up on, and the rest get done', async () => {
  const root = mediaDir();
  const SRT = (text: string) => `1\n00:00:01,000 --> 00:00:02,000\n${text}\n`;
  const media = (id: number, name: string, text: string): FakeMedia => {
    const { video, en } = episodeOnDisk(root, name, SRT(text));
    return { kind: 'episode', id, title: name, path: video, subtitles: [{ code2: 'en', path: en }], missing: ['ar'] };
  };
  const poisoned = async (prompt: string): Promise<string> => {
    if (prompt.includes('POISON')) throw new OllamaCrash('Ollama answered 500: unexpected EOF');
    return arabicModel(prompt);
  };
  const { store, worker } = setup([media(1, 'Bad', 'POISON'), media(2, 'Good', 'Hello'), media(3, 'Fine', 'Bye')], {}, poisoned);
  await worker.sync();
  for (let i = 0; i < 10; i++) await worker.translateNext();
  assert.equal(store.get('episode:1')!.state, 'failed');
  assert.equal(store.get('episode:1')!.crashes, MAX_CRASHES);
  assert.equal(store.get('episode:2')!.state, 'done');
  assert.equal(store.get('episode:3')!.state, 'done');
});

test('an episode done after a crash starts its count again', async () => {
  const root = mediaDir();
  let crashNext = true;
  const once = async (prompt: string): Promise<string> => {
    if (crashNext) {
      crashNext = false;
      throw new OllamaCrash('Ollama answered 500: unexpected EOF');
    }
    return arabicModel(prompt);
  };
  const { store, worker } = setup([episode(root, 1, 'A')], {}, once);
  await worker.sync();
  await worker.translateNext();
  assert.equal(store.get('episode:1')!.crashes, 1);
  await worker.translateNext();
  assert.equal(store.get('episode:1')!.state, 'done');
  assert.equal(store.get('episode:1')!.crashes, 0);
});

test('Undo skip starts the crash count again', async () => {
  const root = mediaDir();
  const { store, worker } = setup([episode(root, 1, 'A')], {}, crashing);
  await worker.sync();
  for (let i = 0; i < MAX_CRASHES; i++) await worker.translateNext();
  assert.equal(worker.act('episode:1', 'skip'), null);
  assert.equal(worker.act('episode:1', 'unskip'), null);
  assert.equal(store.get('episode:1')!.crashes, 0);
});

test(`a woken PC keeps its lease through ${CRASHES_HELD} crashes in a row, then lets go`, async () => {
  const root = mediaDir();
  const calls: string[] = [];
  const { store, worker } = setup([episode(root, 1, 'A'), episode(root, 2, 'B')]);
  await worker.sync();
  worker.markPcWoken(30);
  const lease = new Lease({ url: 'http://pc', token: 'tok', fetcher: powerClient(calls) });
  const model: Model = { problem: async () => null, generate: crashing };
  const pc = new NodeRunner({ name: 'pc', label: 'PC', model, worker, store, lease, takesHeld: true, waitMs: { idle: 1, offline: 1000, paused: 1 } });
  const waits: number[] = [];
  for (let i = 0; i < CRASHES_HELD; i++) waits.push(await pc.step());
  // Backs off, but the wake stands: pc-power is not told the work is over.
  assert.deepEqual(waits, [2000, 4000, 8000]);
  assert.equal(lease.state.held, true);
  assert.equal(worker.pcWoken(), true);
  assert.deepEqual(calls, ['PUT /apps/subfill']);
  await pc.step();
  assert.equal(lease.state.held, false);
  assert.equal(worker.pcWoken(), false);
  assert.deepEqual(calls, ['PUT /apps/subfill', 'DELETE /apps/subfill']);
});

test('a crash, then work again, keeps the wake going', async () => {
  const root = mediaDir();
  const calls: string[] = [];
  let crashNext = true;
  const once = async (prompt: string): Promise<string> => {
    if (crashNext) {
      crashNext = false;
      throw new OllamaCrash('Ollama answered 500: unexpected EOF');
    }
    return arabicModel(prompt);
  };
  const { store, worker } = setup([episode(root, 1, 'A'), episode(root, 2, 'B')]);
  await worker.sync();
  worker.markPcWoken(30);
  const lease = new Lease({ url: 'http://pc', token: 'tok', fetcher: powerClient(calls) });
  const pc = new NodeRunner({ name: 'pc', label: 'PC', model: { problem: async () => null, generate: once }, worker, store, lease, takesHeld: true, waitMs: { idle: 1, offline: 1, paused: 1 } });
  await pc.step();
  await pc.step();
  await pc.step();
  assert.deepEqual(['episode:1', 'episode:2'].map((k) => store.get(k)!.state), ['done', 'done']);
  assert.deepEqual(calls, ['PUT /apps/subfill']);
});
