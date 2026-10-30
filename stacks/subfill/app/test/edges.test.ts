// The cases the review of PR #80 found: outages, a sync racing the worker,
// files left by a cut-off run, shared videos, and words on the page.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { Bazarr } from '../src/bazarr.ts';
import { OllamaDown } from '../src/ollama.ts';
import { Store } from '../src/store.ts';
import { ARABIC } from '../src/translate.ts';
import { safeBack } from '../src/web.ts';
import { outPathFor } from '../src/worker.ts';
import { arabicModel, episode, json, mediaDir, setup, type FakeMedia } from './helpers.ts';

test('an outage while translating puts the item back without using an attempt', async () => {
  const root = mediaDir();
  let down = false;
  const { store, worker } = setup([episode(root, 1, 'Show'), episode(root, 2, 'Other')], { maxAttempts: 1 }, arabicModel, () => down);
  await worker.sync();
  down = true;
  assert.equal(await worker.translateNext(), false);
  for (const k of ['episode:1', 'episode:2']) {
    assert.equal(store.get(k)!.state, 'eligible', k);
    assert.equal(store.get(k)!.attempts, 0, k);
  }
  assert.ok([1, 2].some((n) => /paused: Bazarr unreachable/.test(store.get(`episode:${n}`)!.note ?? '')));
  down = false;
  assert.equal(await worker.translateNext(), true);
  assert.equal(await worker.translateNext(), true);
  assert.deepEqual(
    ['episode:1', 'episode:2'].map((k) => store.get(k)!.state),
    ['done', 'done'],
  );
});

test('Ollama going away mid-translation is an outage, not a failure', async () => {
  const root = mediaDir();
  const gone = async (): Promise<string> => {
    throw new OllamaDown('Ollama call failed: fetch failed');
  };
  const { store, worker } = setup([episode(root, 1, 'Show')], { maxAttempts: 1 }, gone);
  await worker.sync();
  assert.equal(await worker.translateNext(), false);
  assert.equal(store.get('episode:1')!.state, 'eligible');
  assert.equal(store.get('episode:1')!.attempts, 0);
});

test('a restart mid-translation gives the attempt back', async () => {
  const root = mediaDir();
  const { store, worker } = setup([episode(root, 1, 'Show')]);
  await worker.sync();
  store.move('episode:1', ['eligible'], 'translating', { attempts: 1 });
  store.recoverInterrupted();
  assert.equal(store.get('episode:1')!.attempts, 0);
});

test('a sync running during a translation leaves the claimed row alone', async () => {
  const root = mediaDir();
  let release: () => void = () => undefined;
  let started: () => void = () => undefined;
  const begun = new Promise<void>((r) => (started = r));
  const slow = async (p: string) => {
    started();
    await new Promise<void>((r) => (release = r));
    return arabicModel(p);
  };
  const { store, worker } = setup([episode(root, 1, 'Show')], {}, slow);
  await worker.sync();
  const running = worker.translateNext();
  await begun;
  await worker.sync();
  assert.equal(store.get('episode:1')!.state, 'translating');
  assert.match(worker.act('episode:1', 'skip')!, /cannot skip/);
  release();
  await running;
  assert.equal(store.get('episode:1')!.state, 'done');
  assert.equal(store.next(Date.now() + 1000), undefined);
});

test('a claim that lands while the sync is reading the disk is not undone', async () => {
  const root = mediaDir();
  const { store, worker } = setup([episode(root, 1, 'Show')]);
  await worker.sync();
  // The worker claims the row right after the sync reads it, inside the
  // window where the sync is awaiting stat() on the video.
  const get = store.get.bind(store);
  store.get = (key: string) => {
    const row = get(key);
    store.get = get;
    store.move(key, ['eligible'], 'translating');
    return row;
  };
  await worker.sync();
  assert.equal(store.get('episode:1')!.state, 'translating');
});

test('a dropped item takes along the file a cut-off translation left', async () => {
  const root = mediaDir();
  const ep = episode(root, 1, 'Show');
  const { store, worker } = setup([ep]);
  await worker.sync();
  const out = outPathFor(ep.path, ARABIC);
  store.update('episode:1', { out_path: out });
  writeFileSync(out, 'left by a crash');
  ep.missing = [];
  await worker.sync();
  assert.equal(store.get('episode:1'), undefined);
  assert.equal(existsSync(out), false);
});

test('one subtitle that cannot be deleted does not stop the sync', async () => {
  const root = mediaDir();
  const a = episode(root, 1, 'Stuck');
  const items: FakeMedia[] = [a];
  const { store, worker } = setup(items);
  await worker.sync();
  await worker.translateNext();
  const out = outPathFor(a.path, ARABIC);
  rmSync(out);
  mkdirSync(out); // unlink on a directory fails, and not with ENOENT
  a.missing = [];
  a.subtitles.push({ code2: 'ar', path: out.replace('.machine.srt', '.srt') });
  items.push(episode(root, 2, 'New'));
  await worker.sync();
  assert.equal(store.get('episode:1')!.state, 'done');
  assert.match(store.get('episode:1')!.note!, /could not clean up/);
  assert.equal(store.get('episode:2')!.state, 'eligible');
});

test('Arabic dropped from the profile is not reported as a human replacement', async () => {
  const root = mediaDir();
  const ep = episode(root, 1, 'Show');
  const { store, worker } = setup([ep]);
  await worker.sync();
  await worker.translateNext();
  ep.missing = [];
  await worker.sync();
  assert.equal(store.get('episode:1')!.state, 'gone');
  assert.match(store.get('episode:1')!.note!, /no longer wants Arabic/);
  assert.equal(existsSync(outPathFor(ep.path, ARABIC)), false);
});

test('two episodes in one video file share one machine subtitle', async () => {
  const root = mediaDir();
  const first = episode(root, 1, 'Double');
  const second: FakeMedia = { ...first, id: 2, subtitles: [...first.subtitles], missing: [...first.missing] };
  const { store, worker } = setup([first, second]);
  await worker.sync();
  await worker.translateNext();
  await worker.translateNext();
  const rows = ['episode:1', 'episode:2'].map((k) => store.get(k)!);
  assert.deepEqual(
    rows.map((r) => r.state),
    ['done', 'done'],
  );
  assert.ok(rows.some((r) => /same video as Double/.test(r.note ?? '')));
  // Bazarr drops Arabic for both: the shared file goes, and neither row errors.
  first.missing = [];
  second.missing = [];
  await worker.sync();
  assert.equal(existsSync(outPathFor(first.path, ARABIC)), false);
  assert.deepEqual(
    ['episode:1', 'episode:2'].map((k) => store.get(k)!.state),
    ['gone', 'gone'],
  );
});

test('a Latin-script line does not sink the episode, and the note says so', async () => {
  const root = mediaDir();
  const latinFirst = async (p: string) => (await arabicModel(p)).replace(/^1\. ترجمة Hello there\.$/m, '1. Hello there.');
  const { store, worker } = setup([episode(root, 1, 'Show')], {}, latinFirst);
  await worker.sync();
  await worker.translateNext();
  assert.equal(store.get('episode:1')!.state, 'done');
  assert.match(store.get('episode:1')!.note!, /1 left in English/);
});

test('Bazarr: a missing forced subtitle is not a missing language', async () => {
  const fetcher = (async (input: string | URL | Request) => {
    const p = new URL(String(input)).pathname;
    if (p === '/api/episodes/wanted') {
      return json({ data: [{ sonarrEpisodeId: 1, seriesTitle: 'S', episode_number: '1x01', missing_subtitles: [{ code2: 'ar', forced: true }, { code2: 'en' }] }] });
    }
    return json({ data: [] });
  }) as typeof fetch;
  const [w] = await new Bazarr({ url: 'http://b', apiKey: 'key', fetcher }).wanted();
  assert.deepEqual(w.missing, ['en']);
});

test('store: ready means eligible and due; sharing finds the other episode', () => {
  const s = new Store(':memory:');
  const base = { kind: 'episode' as const, bazarr_id: 1, title: 't', video_path: '/v', source_path: null, source_lang: null, out_path: '/x.ar.machine.srt', note: null, state: 'eligible' as const };
  s.insert({ ...base, key: 'now', eligible_at: 0 });
  s.insert({ ...base, key: 'later', eligible_at: 10_000 });
  assert.equal(s.readyCount(5_000), 1);
  assert.deepEqual(
    s.sharing('/x.ar.machine.srt', 'now').map((r) => r.key),
    ['later'],
  );
});

test('safeBack refuses anything a browser would take off-site', () => {
  assert.equal(safeBack('/item?key=1'), '/item?key=1');
  for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', '', null]) assert.equal(safeBack(bad), '/', String(bad));
});
