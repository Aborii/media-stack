import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Bazarr } from '../src/bazarr.ts';
import { parseSrt } from '../src/srt.ts';
import { Store } from '../src/store.ts';
import { ARABIC } from '../src/translate.ts';
import { decode, outPathFor, Worker, type Config } from '../src/worker.ts';
import { arabicModel, episodeOnDisk, fakeBazarr, mediaDir, SRT, type FakeMedia } from './helpers.ts';

function setup(items: FakeMedia[], over: Partial<Config> = {}, generate = arabicModel, fail?: () => boolean) {
  const root = path.dirname(path.dirname(path.dirname(items[0]?.path ?? path.join(mediaDir(), 'tv', 'x', 'x'))));
  const store = new Store(':memory:');
  const bazarr = new Bazarr({ url: 'http://bazarr:6767', apiKey: 'key', fetcher: fakeBazarr(items, { fail }) });
  const config: Config = {
    target: ARABIC,
    sourceLanguages: ['en'],
    waitMs: 0,
    batchSize: 10,
    maxAttempts: 2,
    retryDelayMs: 0,
    mediaRoot: root,
    ...over,
  };
  return { store, worker: new Worker({ store, bazarr, generate, config }) };
}

function episode(root: string, id: number, name: string, extra: Partial<FakeMedia> = {}): FakeMedia {
  const { video, en } = episodeOnDisk(root, name);
  return { kind: 'episode', id, title: name, path: video, subtitles: [{ code2: 'en', path: en }], missing: ['ar'], ...extra };
}

test('an episode Bazarr has no Arabic for is translated beside the video, timing intact', async () => {
  const root = mediaDir();
  const ep = episode(root, 1, 'Show');
  const { store, worker } = setup([ep]);
  await worker.sync();
  assert.equal(store.get('episode:1')!.state, 'eligible');
  assert.equal(await worker.translateNext(), true);

  const item = store.get('episode:1')!;
  assert.equal(item.state, 'done');
  const out = outPathFor(ep.path, ARABIC);
  assert.equal(item.out_path, out);
  assert.ok(out.endsWith('Show - S01E01.ar.machine.srt'));
  const written = parseSrt(readFileSync(out, 'utf8'));
  const source = parseSrt(SRT);
  assert.deepEqual(
    written.cues.map((c) => [c.index, c.timing]),
    source.cues.map((c) => [c.index, c.timing]),
  );
  assert.deepEqual(written.cues[1].lines, ['- ترجمة Who is it?', '- ترجمة Me.']);
  assert.equal(existsSync(`${out}.part`), false);
  assert.equal(await worker.translateNext(), false);
});

test('Bazarr gets its wait first: a new video is waiting, not eligible', async () => {
  const root = mediaDir();
  const { store, worker } = setup([episode(root, 1, 'Show')], { waitMs: 3600_000 });
  await worker.sync();
  assert.equal(store.get('episode:1')!.state, 'waiting');
  assert.equal(await worker.translateNext(), false);
});

test('items with Arabic, with no English, or with only a forced or embedded English are not translated', async () => {
  const root = mediaDir();
  const hasArabic = episode(root, 1, 'Arabic', { missing: [] });
  const noSource = { ...episode(root, 2, 'NoSource'), subtitles: [] };
  const embedded = { ...episode(root, 3, 'Embedded'), subtitles: [{ code2: 'en', path: null }] };
  const forced = { ...episode(root, 4, 'Forced'), subtitles: [{ code2: 'en', path: episodeOnDisk(root, 'Forced').en, forced: true }] };
  const { store, worker } = setup([hasArabic, noSource, embedded, forced]);
  await worker.sync();
  assert.equal(store.get('episode:1'), undefined);
  for (const k of ['episode:2', 'episode:3', 'episode:4']) assert.equal(store.get(k)!.state, 'no_source', k);
});

test('a failed Bazarr read changes nothing', async () => {
  const root = mediaDir();
  let down = false;
  const { store, worker } = setup([episode(root, 1, 'Show')], {}, arabicModel, () => down);
  await worker.sync();
  down = true;
  await assert.rejects(worker.sync(), /Bazarr unreachable/);
  assert.equal(store.get('episode:1')!.state, 'eligible');
});

test('when Bazarr later finds a human Arabic subtitle, ours is deleted and nothing else', async () => {
  const root = mediaDir();
  const ep = episode(root, 1, 'Show');
  const { store, worker } = setup([ep]);
  await worker.sync();
  await worker.translateNext();
  const ours = outPathFor(ep.path, ARABIC);
  const human = ours.replace('.machine.srt', '.srt');
  writeFileSync(human, 'human');
  ep.missing = [];
  ep.subtitles.push({ code2: 'ar', path: human });
  await worker.sync();
  assert.equal(store.get('episode:1')!.state, 'replaced');
  assert.equal(existsSync(ours), false);
  assert.equal(existsSync(human), true);
  assert.equal(existsSync(ep.subtitles[0].path!), true);
});

test('when the video is deleted or replaced, our subtitle goes with it', async () => {
  const root = mediaDir();
  const a = episode(root, 1, 'Deleted');
  const b = episode(root, 2, 'Upgraded');
  const items = [a, b];
  const { store, worker } = setup(items);
  await worker.sync();
  await worker.translateNext();
  await worker.translateNext();
  const oldB = outPathFor(b.path, ARABIC);

  // Deleted in Sonarr: the file goes, and Bazarr drops the episode.
  rmSync(a.path);
  items.splice(0, 1);
  // Upgraded: a new file under a new name, which Bazarr reports.
  b.path = b.path.replace('.mkv', '.Proper.mkv');
  writeFileSync(b.path, 'better video');
  await worker.sync();

  assert.equal(existsSync(outPathFor(a.path, ARABIC)), false);
  assert.equal(existsSync(oldB), false);
  assert.equal(store.get('episode:1')!.state, 'gone');
  // The upgraded video is looked at again, under its new name.
  assert.equal(store.get('episode:2')!.state, 'eligible');
  assert.equal(store.get('episode:2')!.video_path, b.path);
});

test('items Bazarr stops wanting are dropped unless subfill wrote a file for them', async () => {
  const root = mediaDir();
  const a = episode(root, 1, 'Found');
  const b = episode(root, 2, 'Skipped');
  const { store, worker } = setup([a, b]);
  await worker.sync();
  assert.equal(worker.act('episode:2', 'skip'), null);
  a.missing = [];
  b.missing = [];
  await worker.sync();
  assert.equal(store.get('episode:1'), undefined);
  assert.equal(store.get('episode:2'), undefined);
});

test('a file subfill did not write is never overwritten', async () => {
  const root = mediaDir();
  const ep = episode(root, 1, 'Show');
  const { store, worker } = setup([ep], { maxAttempts: 1 });
  await worker.sync();
  writeFileSync(outPathFor(ep.path, ARABIC), 'someone else');
  await worker.translateNext();
  assert.equal(store.get('episode:1')!.state, 'failed');
  assert.match(store.get('episode:1')!.note!, /did not write it/);
  assert.equal(readFileSync(outPathFor(ep.path, ARABIC), 'utf8'), 'someone else');
});

test('a translation cut off after writing is redone over its own file', async () => {
  const root = mediaDir();
  const ep = episode(root, 1, 'Show');
  const { store, worker } = setup([ep]);
  await worker.sync();
  const out = outPathFor(ep.path, ARABIC);
  // As the store looks after a crash between the rename and the final update.
  store.update('episode:1', { out_path: out });
  store.move('episode:1', ['eligible'], 'translating');
  writeFileSync(out, 'half');
  assert.equal(store.recoverInterrupted(), 1);
  await worker.translateNext();
  assert.equal(store.get('episode:1')!.state, 'done');
  assert.match(readFileSync(out, 'utf8'), /ترجمة/);
});

test('Arabic found between the sync and the translation stops it', async () => {
  const root = mediaDir();
  const ep = episode(root, 1, 'Show');
  const { store, worker } = setup([ep]);
  await worker.sync();
  writeFileSync(outPathFor(ep.path, ARABIC).replace('.machine.srt', '.srt'), 'human, not indexed yet');
  await worker.translateNext();
  assert.equal(store.get('episode:1'), undefined);
  assert.equal(existsSync(outPathFor(ep.path, ARABIC)), false);
});

test('a model that will not translate fails the item, retries, then gives up', async () => {
  const root = mediaDir();
  const echo = async (p: string) => p.split('\n\n\n')[1];
  const { store, worker } = setup([episode(root, 1, 'Show')], { maxAttempts: 2 }, echo);
  await worker.sync();
  await worker.translateNext();
  assert.equal(store.get('episode:1')!.state, 'eligible');
  assert.match(store.get('episode:1')!.note!, /no usable Arabic/);
  await worker.translateNext();
  assert.equal(store.get('episode:1')!.state, 'failed');
  assert.equal(worker.act('episode:1', 'retry'), null);
  assert.equal(store.get('episode:1')!.state, 'eligible');
  assert.equal(store.get('episode:1')!.attempts, 0);
});

test('paths outside the media folder are refused', async () => {
  const root = mediaDir();
  const ep = episode(root, 1, 'Show');
  const elsewhere = episodeOnDisk(mediaDir(), 'Elsewhere');
  const { store, worker } = setup([ep], { mediaRoot: path.join(root, 'tv', 'Show') });
  ep.subtitles = [{ code2: 'en', path: elsewhere.en }];
  await worker.sync();
  assert.equal(store.get('episode:1')!.state, 'no_source');
});

test('films are followed the same way', async () => {
  const root = mediaDir();
  const { video, en } = episodeOnDisk(root, 'Film');
  const movie: FakeMedia = { kind: 'movie', id: 7, title: 'Film', path: video, subtitles: [{ code2: 'en', path: en }], missing: ['ar', 'en'] };
  const { store, worker } = setup([movie]);
  await worker.sync();
  await worker.translateNext();
  assert.equal(store.get('movie:7')!.state, 'done');
});

test('owner actions only apply in the states they make sense in', async () => {
  const root = mediaDir();
  const { store, worker } = setup([episode(root, 1, 'Show')], { waitMs: 3600_000 });
  await worker.sync();
  assert.match(worker.act('episode:1', 'retry')!, /cannot retry/);
  assert.equal(worker.act('episode:1', 'now'), null);
  assert.equal(store.get('episode:1')!.state, 'eligible');
  // The next sync does not push a "translate now" back to waiting.
  await worker.sync();
  assert.equal(store.get('episode:1')!.state, 'eligible');
  assert.equal(worker.act('episode:1', 'skip'), null);
  assert.equal(worker.act('episode:1', 'unskip'), null);
  assert.equal(worker.act('nope', 'skip'), 'no such item');
  assert.match(worker.act('episode:1', 'explode')!, /cannot explode/);
});

test('an old Windows-1252 subtitle is read, not mangled', () => {
  assert.equal(decode(new Uint8Array([0x63, 0x61, 0x66, 0xe9])), 'café');
  assert.equal(decode(new TextEncoder().encode('café')), 'café');
});
