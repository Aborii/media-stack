// The subtitles page: the original and the Arabic read from disk and paired
// line by line, both offered as downloads, behind the sign-in.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { LibraryStore } from '../src/library.ts';
import { parseSrt } from '../src/srt.ts';
import { Store, type Item } from '../src/store.ts';
import { fileFor, loadPair, machinePath, pairUp, type SubtitleDeps } from '../src/subtitles.ts';
import { startWeb } from '../src/web.ts';
import { mediaDir } from './helpers.ts';

const EN = '1\n00:00:01,000 --> 00:00:02,000\nHello <b>there</b>.\n\n2\n00:00:03,000 --> 00:00:04,000\nSee you.\n';
const AR = '1\n00:00:01,000 --> 00:00:02,000\n‏مرحبا هناك.\n\n2\n00:00:03,000 --> 00:00:04,000\n‏أراك لاحقا.\n';

function files() {
  const root = mediaDir();
  const dir = path.join(root, 'tv', 'Show');
  mkdirSync(dir, { recursive: true });
  const video = path.join(dir, 'Show - S01E01.mkv');
  writeFileSync(video, 'video');
  writeFileSync(path.join(dir, 'Show - S01E01.en.srt'), EN);
  writeFileSync(path.join(dir, 'Show - S01E01.ar.machine.srt'), AR);
  return { root, video, en: path.join(dir, 'Show - S01E01.en.srt'), ar: path.join(dir, 'Show - S01E01.ar.machine.srt') };
}

function item(over: Partial<Item>): Item {
  return {
    key: 'episode:1', kind: 'episode', bazarr_id: 1, title: 'Show 1x01', video_path: '', source_path: null, source_lang: 'en', out_path: null,
    state: 'done', note: null, eligible_at: 0, priority: 0, attempts: 1, first_seen: 0, updated_at: 0, started_at: 0, finished_at: 0,
    held_until: null, node: 'pc', crashes: 0, series_id: 7, inside_track: null, ...over,
  };
}

const deps = (root: string, extract?: SubtitleDeps['extract']): SubtitleDeps => ({ mediaRoot: root, targetCode: 'ar', sourceLanguages: ['en'], extract });

test('lines pair by position when the timings agree, by timing when they do not', () => {
  const a = parseSrt(EN).cues;
  const b = parseSrt(AR).cues;
  assert.deepEqual(
    pairUp(a, b).map((r) => [r.n, r.source?.[0], r.target?.[0]]),
    [
      [1, 'Hello <b>there</b>.', '‏مرحبا هناك.'],
      [2, 'See you.', '‏أراك لاحقا.'],
    ],
  );
  // The original gained a line since: the rest still meet by time.
  const grown = parseSrt(`1\n00:00:00,500 --> 00:00:00,900\nNew.\n\n${EN.replace(/^1\n/, '2\n').replace('\n2\n', '\n3\n')}`).cues;
  assert.deepEqual(
    pairUp(grown, b).map((r) => [r.source?.[0] ?? null, r.target?.[0] ?? null]),
    [
      ['New.', null],
      ['Hello <b>there</b>.', '‏مرحبا هناك.'],
      ['See you.', '‏أراك لاحقا.'],
    ],
  );
  // One side missing: the other alone.
  assert.deepEqual(
    pairUp(null, b).map((r) => r.source),
    [null, null],
  );
});

test('both sides load from disk, the Arabic only from a machine subtitle inside the media folder', async () => {
  const f = files();
  const it = item({ video_path: f.video, source_path: f.en, out_path: f.ar });
  const pair = await loadPair(it, deps(f.root));
  assert.equal(pair.rows.length, 2);
  assert.equal(pair.sourceFrom, 'Show - S01E01.en.srt');
  assert.deepEqual([pair.sourceProblem, pair.targetProblem], [null, null]);
  assert.equal(machinePath(item({ out_path: f.en }), deps(f.root)), null);
  assert.equal(machinePath(item({ out_path: '/etc/x.ar.machine.srt' }), deps(f.root)), null);
  const outside = await loadPair(item({ video_path: f.video, source_path: '/etc/passwd', out_path: f.ar }), deps(f.root));
  assert.match(outside.sourceProblem ?? '', /outside the media folder/);
  assert.equal(outside.rows.length, 2);
  rmSync(f.ar);
  const gone = await loadPair(it, deps(f.root));
  assert.match(gone.targetProblem ?? '', /no longer there/);
  assert.equal(gone.rows[0].target, null);
});

test('an original from inside the video is read again, cleaned as it was for translating', async () => {
  const f = files();
  const stacked = `${EN}\n3\n00:00:01,000 --> 00:00:02,000\nHello there.\n`;
  const asked: string[][] = [];
  const extract: SubtitleDeps['extract'] = async (_video, langs) => {
    asked.push(langs);
    return { srt: stacked, lang: 'en', stream: { index: 3, codec: 'ass', language: 'eng', title: '', forced: false, hi: false } };
  };
  const it = item({ video_path: f.video, inside_track: 'yes', out_path: f.ar });
  const pair = await loadPair(it, deps(f.root, extract));
  assert.equal(pair.sourceFrom, 'the en subtitle inside the video (track 3, ass)');
  assert.equal(pair.rows.length, 2);
  assert.ok(pair.rows.every((r) => r.source && r.target));
  assert.deepEqual(asked, [['en']]);
  const original = await fileFor(it, 'original', deps(f.root, extract));
  assert.equal(original.name, 'Show - S01E01.en.srt');
  assert.equal(parseSrt(original.body).cues.length, 2);
  const arabic = await fileFor(it, 'arabic', deps(f.root));
  assert.equal(arabic.name, 'Show - S01E01.ar.machine.srt');
  assert.equal(arabic.body, AR);
  await assert.rejects(fileFor(item({ video_path: f.video }), 'original', deps(f.root)), /no original/);
  await assert.rejects(fileFor(item({ video_path: f.video }), 'arabic', deps(f.root)), /no Arabic/);
});

// The page, on a loopback port with a fake sign-in gate.
const store = new Store(':memory:');
const f = files();
const server = startWeb(
  {
    store,
    library: new LibraryStore(store.db),
    worker: { act: () => null, exclude: () => null, showFirst: () => null, holdForPc: () => undefined, releaseHolds: () => undefined, markPcWoken: () => undefined },
    status: () => ({ bazarrError: null, lastSync: null, model: 'm', nodes: [] }),
    setNodePaused: () => null,
    loginUrl: 'http://gate',
    subtitles: deps(f.root),
    fetcher: (async (_input: string | URL | Request, init?: RequestInit) =>
      String((init?.headers as Record<string, string>)?.cookie ?? '').includes('s=ok')
        ? new Response('ok')
        : new Response('no', { status: 401, headers: { 'x-login-redirect': '/login' } })) as typeof fetch,
  },
  0,
);
let base = '';
before(async () => {
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  writeFileSync(f.en, EN.replace('See you.', '<script>x</script>'));
  store.insert({ key: 'episode:1', kind: 'episode', bazarr_id: 1, title: 'Show <i>1x01</i>', video_path: f.video, source_path: f.en, source_lang: 'en', out_path: f.ar, state: 'done', note: null, eligible_at: 0 });
});
after(() => server.close());

function get(p: string, cookie = 's=ok'): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(base + p, { headers: { cookie } });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the page shows every line side by side, escaped, the Arabic right to left', async () => {
  assert.equal((await get('/subtitles?key=episode%3A1', '')).status, 302);
  const r = await get('/subtitles?key=episode%3A1');
  assert.equal(r.status, 200);
  assert.ok(r.body.includes('Subtitles: Show &#60;i&#62;1x01&#60;/i&#62;'));
  assert.ok(r.body.includes('&#60;script&#62;x&#60;/script&#62;'));
  assert.ok(!r.body.includes('<script>x</script>'));
  assert.match(r.body, /<td>Hello there\.<\/td><td dir="rtl" lang="ar" class="ar">مرحبا هناك\.<\/td>/);
  assert.match(r.body, /<td class="dim" style="white-space:nowrap" title="00:00:03,000 --&#62; 00:00:04,000">0:03<\/td>/);
  assert.match(r.body, /2 lines/);
  assert.match(r.body, /which=arabic">Download Arabic/);
  assert.equal((await get('/subtitles?key=nope')).status, 404);
  // The item page links to it.
  assert.match((await get('/item?key=episode%3A1')).body, /href="\/subtitles\?key=episode%3A1">View subtitles/);
});

test('both files download with the video\'s name, and nothing else does', async () => {
  const ar = await get('/subtitles/file?key=episode%3A1&which=arabic');
  assert.equal(ar.status, 200);
  assert.equal(ar.body, AR);
  assert.match(String(ar.headers['content-type']), /application\/x-subrip/);
  assert.match(String(ar.headers['content-disposition']), /attachment; filename="Show - S01E01.ar.machine.srt"/);
  const en = await get('/subtitles/file?key=episode%3A1&which=original');
  assert.equal(en.status, 200);
  assert.match(String(en.headers['content-disposition']), /filename="Show - S01E01.en.srt"/);
  for (const bad of ['/subtitles/file?key=episode%3A1&which=../../etc/passwd', '/subtitles/file?key=episode%3A1', '/subtitles/file?key=nope&which=arabic']) {
    assert.equal((await get(bad)).status, 404, bad);
  }
  assert.equal((await get('/subtitles/file?key=episode%3A1&which=arabic', '')).status, 302);
});

test('views and a download of the same inside track share one read of the video', async () => {
  const f = files();
  let calls = 0;
  let finish: () => void = () => undefined;
  const gate = new Promise<void>((r) => (finish = r));
  const extract: SubtitleDeps['extract'] = async () => {
    calls++;
    await gate;
    return { srt: EN, lang: 'en', stream: { index: 2, codec: 'subrip', language: 'eng', title: '', forced: false, hi: false } };
  };
  const it = item({ video_path: f.video, inside_track: 'yes', out_path: f.ar });
  const d = deps(f.root, extract);
  const all = Promise.all([loadPair(it, d), loadPair(it, d), loadPair(it, d), fileFor(it, 'original', d)]);
  await new Promise((r) => setTimeout(r, 20));
  finish();
  const [a, , , file] = await all;
  assert.equal(calls, 1);
  assert.equal(a.rows.length, 2);
  assert.equal(file.name, 'Show - S01E01.en.srt');
  // Kept afterwards too; a new file at the same path is read afresh.
  await loadPair(it, d);
  assert.equal(calls, 1);
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(`${f.video}.new`, 'new video');
  rmSync(f.video);
  (await import('node:fs')).renameSync(`${f.video}.new`, f.video);
  await loadPair(it, d);
  assert.equal(calls, 2);
});

test('a failed read inside the video is not kept: the next view tries again', async () => {
  const f = files();
  let calls = 0;
  const extract: SubtitleDeps['extract'] = async () => {
    calls++;
    if (calls === 1) throw new Error('ffmpeg failed: busy');
    return { srt: EN, lang: 'en', stream: { index: 2, codec: 'subrip', language: 'eng', title: '', forced: false, hi: false } };
  };
  const it = item({ video_path: f.video, inside_track: 'yes', out_path: f.ar });
  assert.match((await loadPair(it, deps(f.root, extract))).sourceProblem ?? '', /busy/);
  assert.equal((await loadPair(it, deps(f.root, extract))).sourceProblem, null);
  assert.equal(calls, 2);
});

test('the original downloads byte for byte under its own name', async () => {
  const f = files();
  const odd = 'Release notes, not a cue\n\n1\n00:00:01,000 --> 00:00:02,000\nHello.\n';
  const sdh = f.en.replace('.en.srt', '.en.sdh.srt');
  writeFileSync(sdh, odd);
  const file = await fileFor(item({ video_path: f.video, source_path: sdh, out_path: f.ar }), 'original', deps(f.root));
  assert.equal(file.name, 'Show - S01E01.en.sdh.srt');
  assert.equal(file.body, odd);
  // An inside track is named for the language actually read.
  const fr: SubtitleDeps['extract'] = async () => ({ srt: EN, lang: 'fr', stream: { index: 2, codec: 'subrip', language: 'fre', title: '', forced: false, hi: false } });
  const inside = await fileFor(item({ video_path: f.video, inside_track: 'yes', source_lang: 'en' }), 'original', { ...deps(f.root, fr), sourceLanguages: ['en', 'fr'] });
  assert.equal(inside.name, 'Show - S01E01.fr.srt');
});

test('an original with no readable lines says so instead of blaming a change', async () => {
  const f = files();
  writeFileSync(f.en, 'not a subtitle at all');
  const pair = await loadPair(item({ video_path: f.video, source_path: f.en, out_path: f.ar }), deps(f.root));
  assert.equal(pair.sourceProblem, 'the original has no lines subfill can read');
  assert.equal(pair.rows.length, 2);
  assert.ok(pair.rows.every((r) => r.source === null && r.target));
});

test('no subtitles link once the Arabic is deleted, and HEAD reads nothing', async () => {
  store.insert({ key: 'episode:2', kind: 'episode', bazarr_id: 2, title: 'Replaced', video_path: f.video, source_path: f.en, source_lang: 'en', out_path: f.ar, state: 'replaced', note: null, eligible_at: 0 });
  assert.ok(!(await get('/item?key=episode%3A2')).body.includes('href="/subtitles'));
  const head = await new Promise<number>((resolve, reject) => {
    const req = request(`${base}/subtitles?key=episode%3A1`, { method: 'HEAD', headers: { cookie: 's=ok' } });
    req.on('response', (res) => resolve(res.statusCode ?? 0));
    req.on('error', reject);
    req.end();
  });
  assert.equal(head, 200);
});

test('a download name with quotes, brackets and accents is encoded for both header forms', async () => {
  const dir = path.dirname(f.video);
  const name = "Amélie's (Cut) - S01E01";
  writeFileSync(path.join(dir, `${name}.mkv`), 'v');
  writeFileSync(path.join(dir, `${name}.ar.machine.srt`), AR);
  store.insert({ key: 'episode:3', kind: 'episode', bazarr_id: 3, title: 'Amelie', video_path: path.join(dir, `${name}.mkv`), source_path: null, source_lang: 'en', out_path: path.join(dir, `${name}.ar.machine.srt`), state: 'done', note: null, eligible_at: 0 });
  const r = await get('/subtitles/file?key=episode%3A3&which=arabic');
  const cd = String(r.headers['content-disposition']);
  assert.match(cd, /filename="Am_lie's \(Cut\) - S01E01\.ar\.machine\.srt"/);
  const star = cd.split("filename*=UTF-8''")[1];
  assert.match(star, /^[A-Za-z0-9!#$&+\-.^_`|~%]+$/);
  assert.equal(decodeURIComponent(star), `${name}.ar.machine.srt`);
});

test('an Arabic translated before repeats were joined still pairs line for line', async () => {
  const f = files();
  const frames = '1\n00:00:01,000 --> 00:00:01,042\nSIGN\n\n2\n00:00:01,042 --> 00:00:01,083\nSIGN\n\n3\n00:00:02,000 --> 00:00:03,000\nHello.\n';
  const oldArabic = '1\n00:00:01,000 --> 00:00:01,042\nلافتة\n\n2\n00:00:01,042 --> 00:00:01,083\nلافتة\n\n3\n00:00:02,000 --> 00:00:03,000\nمرحبا.\n';
  const newArabic = '1\n00:00:01,000 --> 00:00:01,083\nلافتة\n\n2\n00:00:02,000 --> 00:00:03,000\nمرحبا.\n';
  const extract: SubtitleDeps['extract'] = async () => ({ srt: frames, lang: 'en', stream: { index: 3, codec: 'ass', language: 'eng', title: '', forced: false, hi: false } });
  for (const [arabic, lines] of [
    [oldArabic, 3],
    [newArabic, 2],
  ] as const) {
    writeFileSync(f.ar, arabic);
    // A fresh video file each round, so the kept read is not reused across them.
    writeFileSync(f.video, `video ${lines}`);
    await new Promise((r) => setTimeout(r, 15));
    const pair = await loadPair(item({ video_path: f.video, inside_track: 'yes', out_path: f.ar }), deps(f.root, extract));
    assert.equal(pair.rows.length, lines);
    assert.ok(pair.rows.every((r) => r.source && r.target), `${lines} lines all paired`);
  }
});

test('the original downloaded beside an older Arabic is cleaned the same way, cue for cue', async () => {
  const f = files();
  const frames = '1\n00:00:01,000 --> 00:00:01,042\nSIGN\n\n2\n00:00:01,042 --> 00:00:01,083\nSIGN\n\n3\n00:00:02,000 --> 00:00:03,000\nHello.\n';
  writeFileSync(f.ar, '1\n00:00:01,000 --> 00:00:01,042\nلافتة\n\n2\n00:00:01,042 --> 00:00:01,083\nلافتة\n\n3\n00:00:02,000 --> 00:00:03,000\nمرحبا.\n');
  writeFileSync(f.video, 'video older');
  const extract: SubtitleDeps['extract'] = async () => ({ srt: frames, lang: 'en', stream: { index: 3, codec: 'ass', language: 'eng', title: '', forced: false, hi: false } });
  const it = item({ video_path: f.video, inside_track: 'yes', out_path: f.ar });
  assert.equal(parseSrt((await fileFor(it, 'original', deps(f.root, extract))).body).cues.length, 3);
  writeFileSync(f.ar, '1\n00:00:01,000 --> 00:00:01,083\nلافتة\n\n2\n00:00:02,000 --> 00:00:03,000\nمرحبا.\n');
  assert.equal(parseSrt((await fileFor(it, 'original', deps(f.root, extract))).body).cues.length, 2);
});

test('an Arabic from any earlier cleaning pairs with the matching one', async () => {
  const f = files();
  const track = '1\n00:00:01,000 --> 00:00:01,042\nR\n\n2\n00:00:01,042 --> 00:00:01,083\nR\n\n3\n00:00:02,000 --> 00:00:03,000\nHello.\n';
  const extract: SubtitleDeps['extract'] = async () => ({ srt: track, lang: 'en', stream: { index: 3, codec: 'ass', language: 'eng', title: '', forced: false, hi: false } });
  const ar = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}\n00:00:0${i + 1},000 --> 00:00:0${i + 1},500\nس\n`).join('\n');
  // Today 1 line; joined but with fragments 2; before joining 3.
  for (const n of [1, 2, 3]) {
    writeFileSync(f.ar, ar(n));
    writeFileSync(f.video, `video ${n}`);
    await new Promise((r) => setTimeout(r, 15));
    const it = item({ video_path: f.video, inside_track: 'yes', out_path: f.ar });
    const original = await fileFor(it, 'original', deps(f.root, extract));
    assert.equal(parseSrt(original.body).cues.length, n, `original for an Arabic of ${n}`);
  }
});
