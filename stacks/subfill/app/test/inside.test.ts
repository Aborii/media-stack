// Translating from the subtitle inside the video: choosing the track, pulling
// it out, and what happens when there is nothing readable inside.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { extractEmbedded, NoTextTrack, parseProbe, pickStream, type Run, type Stream } from '../src/embedded.ts';
import { Unavailable } from '../src/errors.ts';
import { ARABIC } from '../src/translate.ts';
import { outPathFor } from '../src/worker.ts';
import { episode, mediaDir, setup, SRT } from './helpers.ts';

const s = (index: number, codec: string, language: string, extra: Partial<Stream> = {}): Stream => ({ index, codec, language, title: '', forced: false, hi: false, ...extra });

test('the probe is read with forced and hearing-impaired tracks told apart by flag or by title', () => {
  const streams = parseProbe(
    JSON.stringify({
      streams: [
        { index: 2, codec_name: 'subrip', tags: { language: 'ENG', title: 'English' }, disposition: { forced: 0, hearing_impaired: 0 } },
        { index: 3, codec_name: 'ass', tags: { language: 'eng', title: 'Signs & Songs' }, disposition: { forced: 0 } },
        { index: 4, codec_name: 'subrip', tags: { language: 'eng', title: 'English SDH' } },
        { index: 5, codec_name: 'subrip', tags: { language: 'eng' }, disposition: { forced: 1 } },
        { index: 6, codec_name: 'subrip', tags: { language: 'eng' }, disposition: { hearing_impaired: 1 } },
        { index: 7, codec_name: 'subrip' },
      ],
    }),
  );
  assert.deepEqual(
    streams.map((x) => [x.index, x.language, x.forced, x.hi]),
    [
      [2, 'eng', false, false],
      [3, 'eng', true, false],
      [4, 'eng', false, true],
      [5, 'eng', true, false],
      [6, 'eng', false, true],
      [7, '', false, false],
    ],
  );
  assert.deepEqual(parseProbe('{}'), []);
});

test('the track picked is full, text, plain before SDH, SubRip before styled, in the first language that has one', () => {
  assert.equal(pickStream([s(2, 'ass', 'eng'), s(3, 'subrip', 'eng', { hi: true }), s(4, 'subrip', 'eng')], ['en'])!.stream.index, 4);
  assert.equal(pickStream([s(2, 'ass', 'eng'), s(3, 'mov_text', 'eng')], ['en'])!.stream.index, 3);
  assert.equal(pickStream([s(2, 'subrip', 'eng', { forced: true }), s(3, 'ass', 'eng')], ['en'])!.stream.index, 3);
  // The order of the source languages decides, then the track kind.
  const both = [s(2, 'subrip', 'fre'), s(3, 'ass', 'eng')];
  assert.deepEqual([pickStream(both, ['en', 'fr'])!.stream.index, pickStream(both, ['en', 'fr'])!.lang], [3, 'en']);
  assert.equal(pickStream(both, ['fr', 'en'])!.lang, 'fr');
  // Nothing in the language at all, or only forced: no track. Only pictures: says so.
  assert.equal(pickStream([s(2, 'subrip', 'spa')], ['en']), null);
  assert.equal(pickStream([s(2, 'subrip', 'eng', { forced: true })], ['en']), null);
  assert.throws(() => pickStream([s(2, 'hdmv_pgs_subtitle', 'eng'), s(3, 'dvd_subtitle', 'eng')], ['en']), NoTextTrack);
  // A picture in one language does not hide text in the next.
  assert.equal(pickStream([s(2, 'hdmv_pgs_subtitle', 'eng'), s(3, 'subrip', 'fre')], ['en', 'fr'])!.lang, 'fr');
});

test('extracting asks ffprobe, then has ffmpeg write the picked track as SRT to its output', async () => {
  const calls: [string, string[]][] = [];
  const run: Run = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'ffprobe') return JSON.stringify({ streams: [{ index: 2, codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng' } }, { index: 5, codec_name: 'subrip', tags: { language: 'eng' } }] });
    return SRT;
  };
  const got = await extractEmbedded('/data/tv/a b.mkv', ['en'], run);
  assert.equal(got.srt, SRT);
  assert.equal(got.stream.index, 5);
  assert.equal(calls[0][0], 'ffprobe');
  assert.equal(calls[0][1].at(-1), '/data/tv/a b.mkv');
  // The path is one argument, never through a shell, and the output goes to stdout.
  assert.deepEqual(calls[1], ['ffmpeg', ['-v', 'error', '-nostdin', '-i', '/data/tv/a b.mkv', '-map', '0:5', '-f', 'srt', '-']]);
  const none: Run = async () => JSON.stringify({ streams: [] });
  await assert.rejects(extractEmbedded('/v.mkv', ['en'], none), NoTextTrack);
});

test('a missing ffmpeg is an outage, not the item\'s fault; a failing one is an error', async () => {
  const { runFile } = await import('../src/embedded.ts');
  await assert.rejects(runFile('subfill-no-such-program', [], { timeoutMs: 5000, maxBytes: 1024 }), Unavailable);
  await assert.rejects(runFile('sh', ['-c', 'echo bad input >&2; exit 1'], { timeoutMs: 5000, maxBytes: 1024 }), /sh failed: bad input/);
  assert.equal(await runFile('sh', ['-c', 'printf ok'], { timeoutMs: 5000, maxBytes: 1024 }), 'ok');
});

test('an episode with English only inside the video is translated from it', async () => {
  const root = mediaDir();
  const ep = { ...episode(root, 1, 'Inside'), subtitles: [{ code2: 'en', path: null }] };
  const asked: [string, string[]][] = [];
  const extract = async (video: string, langs: string[]) => {
    asked.push([video, langs]);
    return { srt: SRT, lang: 'en', stream: s(2, 'subrip', 'eng', { title: 'English' }) };
  };
  const { store, worker } = setup([ep], {}, undefined, undefined, extract);
  await worker.sync();
  assert.equal(store.get('episode:1')!.source_path, null);
  assert.equal(await worker.translateNext(), true);
  const out = outPathFor(ep.path, ARABIC);
  assert.equal(store.get('episode:1')!.state, 'done');
  assert.ok(existsSync(out));
  assert.match(readFileSync(out, 'utf8'), /ترجمة Hello there\./);
  assert.deepEqual(asked, [[ep.path, ['en']]]);
  assert.ok(store.logFor('episode:1').some((l) => /read the en subtitle inside the video \(track 2, subrip, "English"\)/.test(l.message)));
});

test('a subtitle file beside the video is still preferred over the one inside it', async () => {
  const root = mediaDir();
  const ep = episode(root, 1, 'Both');
  ep.subtitles.push({ code2: 'en', path: null });
  let used = false;
  const { store, worker } = setup([ep], {}, undefined, undefined, async () => ((used = true), { srt: SRT, lang: 'en', stream: s(2, 'subrip', 'eng') }));
  await worker.sync();
  assert.equal(store.get('episode:1')!.inside_track, null);
  await worker.translateNext();
  assert.equal(used, false);
  assert.equal(store.get('episode:1')!.state, 'done');
});

test('nothing readable inside sends the item back to nothing-to-translate, uses no attempt, and is not offered again', async () => {
  const root = mediaDir();
  const items = [{ ...episode(root, 1, 'Pictures'), subtitles: [{ code2: 'en', path: null }] }];
  let looks = 0;
  const extract = async () => {
    looks++;
    throw new NoTextTrack('the subtitle inside the video is a picture of text, which cannot be translated');
  };
  const { store, worker } = setup(items, { maxAttempts: 1 }, undefined, undefined, extract);
  await worker.sync();
  assert.equal(await worker.translateNext(), true);
  const row = store.get('episode:1')!;
  assert.deepEqual([row.state, row.attempts, row.inside_track], ['no_source', 0, 'none']);
  assert.match(row.note ?? '', /picture of text/);
  await worker.sync();
  assert.equal(store.get('episode:1')!.state, 'no_source');
  assert.match(store.get('episode:1')!.note ?? '', /picture of text/);
  assert.equal(await worker.translateNext(), false);
  assert.equal(looks, 1);
  // A new video is looked at again.
  const next = { ...episode(root, 1, 'Pictures2'), subtitles: [{ code2: 'en', path: null }] };
  items[0] = next;
  await worker.sync();
  assert.equal(store.get('episode:1')!.state, 'eligible');
  assert.equal(store.get('episode:1')!.inside_track, 'yes');
});

test('ffmpeg missing puts the item back without using an attempt', async () => {
  const root = mediaDir();
  const ep = { ...episode(root, 1, 'NoFfmpeg'), subtitles: [{ code2: 'en', path: null }] };
  const { store, worker } = setup([ep], { maxAttempts: 1 }, undefined, undefined, async () => {
    throw new Unavailable('ffprobe is not installed in the container');
  });
  await worker.sync();
  assert.equal(await worker.translateNext(), false);
  const row = store.get('episode:1')!;
  assert.deepEqual([row.state, row.attempts], ['eligible', 0]);
  assert.match(row.note ?? '', /not installed/);
});

test('stacked copies of a line in a styled track are translated and shown once', async () => {
  const { parseSrt, withoutCopies } = await import('../src/srt.ts');
  const srt = '1\n00:00:01,000 --> 00:00:02,000\n{\\an8}Sign\n\n2\n00:00:01,000 --> 00:00:02,000\n{\\an8}Sign\n\n3\n00:00:01,000 --> 00:00:02,000\nHello\n\n4\n00:00:03,000 --> 00:00:04,000\nSign\n';
  const { parsed, dropped } = withoutCopies(parseSrt(srt));
  assert.equal(dropped, 1);
  assert.deepEqual(
    parsed.cues.map((c) => [c.index, c.lines.join('|')]),
    [
      ['1', '{\\an8}Sign'],
      ['2', 'Hello'],
      ['3', 'Sign'],
    ],
  );
  const plain = parseSrt(SRT);
  assert.equal(withoutCopies(plain).parsed, plain);
  // Through the worker: the output has one cue per distinct line.
  const root = mediaDir();
  const ep = { ...episode(root, 1, 'Stacked'), subtitles: [{ code2: 'en', path: null }] };
  const { store, worker } = setup([ep], {}, undefined, undefined, async () => ({ srt, lang: 'en', stream: s(3, 'ass', 'eng') }));
  await worker.sync();
  await worker.translateNext();
  assert.equal(store.get('episode:1')!.state, 'done');
  assert.equal(parseSrt(readFileSync(outPathFor(ep.path, ARABIC), 'utf8')).cues.length, 3);
  assert.ok(store.logFor('episode:1').some((l) => /left out 1 stacked copies/.test(l.message)));
});
