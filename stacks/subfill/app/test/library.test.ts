// The library copy behind the shows and films pages: reading it from Bazarr,
// keeping the last good copy when a read fails, and the Arabic status each
// episode gets from the library and subfill's own item.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bazarr, type Library, type Subtitle } from '../src/bazarr.ts';
import { LibraryStore } from '../src/library.ts';
import { renderOverview } from '../src/views/overview.ts';
import { Store } from '../src/store.ts';
import { json } from './helpers.ts';

const sub = (code2: string, extra: Partial<Subtitle> = {}): Subtitle => ({ code2, path: `/data/x.${code2}.srt`, forced: false, hi: false, ...extra });

function episode(id: number, seriesId: number, ep: number, subtitles: Subtitle[], missing: string[]) {
  return { key: `episode:${id}`, kind: 'episode' as const, id, seriesId, season: 1, episode: ep, title: `Ep ${ep}`, path: `/data/tv/s${seriesId}/e${ep}.mkv`, subtitles, missing };
}

function setup(): { store: Store; library: LibraryStore } {
  const store = new Store(':memory:');
  return { store, library: new LibraryStore(store.db, () => 1000) };
}

function addItem(store: Store, key: string, state: Parameters<Store['insert']>[0]['state']): void {
  store.insert({ key, kind: 'episode', bazarr_id: 0, title: key, video_path: `/v/${key}`, source_path: null, source_lang: null, out_path: null, state, note: null, eligible_at: 0 });
}

const LIB: Library = {
  series: [
    { id: 1, title: 'Alpha', year: '2001', path: '/data/library/tv/Alpha', ended: true },
    { id: 2, title: 'beta', year: null, path: '/data/library/anime/beta', ended: false },
  ],
  entries: [
    episode(11, 1, 1, [sub('ar'), sub('en')], []),
    episode(12, 1, 2, [sub('en')], ['ar']),
    episode(13, 1, 3, [sub('en')], ['ar']),
    episode(14, 1, 4, [sub('en')], ['ar']),
    // A forced Arabic subtitle is signs only: it does not count as Arabic.
    episode(15, 1, 5, [sub('ar', { forced: true })], []),
    // An Arabic track inside the video counts.
    episode(21, 2, 1, [sub('ar', { path: null })], []),
    { key: 'movie:5', kind: 'movie', id: 5, seriesId: null, season: null, episode: null, title: 'Zed (2000)', path: '/data/m.mkv', subtitles: [], missing: ['ar'] },
    { key: 'movie:6', kind: 'movie', id: 6, seriesId: null, season: null, episode: null, title: 'Ack (2010)', path: '/data/n.mkv', subtitles: [sub('ar')], missing: [] },
  ],
};

test('each episode gets one Arabic status, and a show counts the same ones its page shows', () => {
  const { store, library } = setup();
  library.replace(LIB, 'ar');
  addItem(store, 'episode:11', 'done'); // a human one arrived: human wins until the sync deletes ours
  addItem(store, 'episode:12', 'done');
  addItem(store, 'episode:13', 'eligible');
  // episode:14 has no item yet: missing, not looked at.
  const page = library.show(1)!;
  assert.deepEqual(
    page.episodes.map((e) => [e.key, e.status]),
    [
      ['episode:11', 'human'],
      ['episode:12', 'machine'],
      ['episode:13', 'ready'],
      ['episode:14', 'missing'],
      ['episode:15', 'not_wanted'],
    ],
  );
  assert.equal(page.episodes[2].item?.state, 'eligible');
  assert.equal(page.episodes[3].item, null);
  const alpha = library.shows().find((s) => s.id === 1)!;
  assert.equal(alpha.episodes, 5);
  assert.deepEqual(
    Object.entries(alpha.counts).filter(([, n]) => n),
    [
      ['human', 1],
      ['machine', 1],
      ['ready', 1],
      ['missing', 1],
      ['not_wanted', 1],
    ],
  );
  const beta = library.shows().find((s) => s.id === 2)!;
  assert.equal(beta.counts.human, 1);
  assert.equal(beta.folder, 'anime');
  // Sorted by title whatever the case.
  assert.deepEqual(
    library.shows().map((s) => s.title),
    ['Alpha', 'beta'],
  );
  assert.equal(library.show(99), null);
});

test('films filter by status and title, and say how many matched in all', () => {
  const { library } = setup();
  library.replace(LIB, 'ar');
  assert.deepEqual(
    library.movies({ limit: 10 }).movies.map((m) => m.title),
    ['Ack (2010)', 'Zed (2000)'],
  );
  assert.deepEqual(
    library.movies({ statuses: ['missing'], limit: 10 }).movies.map((m) => m.title),
    ['Zed (2000)'],
  );
  assert.equal(library.movies({ q: 'ack', limit: 10 }).total, 1);
  // A LIKE wildcard in the search is taken out, not obeyed.
  assert.equal(library.movies({ q: '%', limit: 10 }).total, 2);
  const capped = library.movies({ limit: 1 });
  assert.equal(capped.movies.length, 1);
  assert.equal(capped.total, 2);
  const cov = library.coverage();
  assert.equal(cov.movie.human, 1);
  assert.equal(cov.movie.missing, 1);
  assert.equal(cov.episode.human, 2);
});

test('a refresh that fails keeps the last good copy and says why', async () => {
  const { library } = setup();
  assert.deepEqual(library.freshness(), { at: null, error: null });
  assert.equal(await library.refresh(async () => LIB, 'ar'), null);
  assert.deepEqual(library.freshness(), { at: 1000, error: null });
  const problem = await library.refresh(async () => {
    throw new Error('Bazarr unreachable');
  }, 'ar');
  assert.equal(problem, 'Bazarr unreachable');
  assert.equal(library.shows().length, 2);
  assert.deepEqual(library.freshness(), { at: 1000, error: 'Bazarr unreachable' });
  // The next good read clears the problem.
  await library.refresh(async () => LIB, 'ar');
  assert.equal(library.freshness().error, null);
});

test('a replace that breaks partway leaves the old copy whole', () => {
  const { library } = setup();
  library.replace(LIB, 'ar');
  const broken: Library = { series: [LIB.series[0], LIB.series[0]], entries: [] };
  assert.throws(() => library.replace(broken, 'ar'));
  assert.equal(library.shows().length, 2);
  assert.equal(library.show(1)!.episodes.length, 5);
});

test('shows and films that left the library leave the copy', () => {
  const { library } = setup();
  library.replace(LIB, 'ar');
  library.replace({ series: [LIB.series[1]], entries: [LIB.entries[5]] }, 'ar');
  assert.deepEqual(
    library.shows().map((s) => s.id),
    [2],
  );
  assert.equal(library.movies({ limit: 10 }).total, 0);
  assert.equal(library.entry('episode:11'), null);
  assert.equal(library.entry('episode:21')?.showId, 2);
});

test('Bazarr.library reads every series, their episodes a chunk at a time, and the films', async () => {
  const calls: string[] = [];
  const series = Array.from({ length: 60 }, (_, i) => ({ sonarrSeriesId: i + 1, title: `S${i + 1}`, year: 2000, path: `/data/library/tv/S${i + 1}`, ended: i % 2 === 0 }));
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (url.pathname === '/api/series') return json({ data: series });
    if (url.pathname === '/api/episodes') {
      const ids = url.searchParams.getAll('seriesid[]').map(Number);
      return json({ data: ids.map((id) => ({ sonarrEpisodeId: id * 100, sonarrSeriesId: id, season: 2, episode: 3, title: 'T', path: `/p/${id}.mkv`, subtitles: [{ code2: 'en', path: null }], missing_subtitles: [{ code2: 'ar' }, { code2: 'fr', forced: true }] })) });
    }
    if (url.pathname === '/api/movies') return json({ data: [{ radarrId: 9, title: 'Film', year: 1999, path: '/m.mkv', subtitles: [], missing_subtitles: [] }] });
    return json({}, 404);
  }) as typeof fetch;
  const lib = await new Bazarr({ url: 'http://bazarr:6767', apiKey: 'key', fetcher }).library();
  assert.equal(lib.series.length, 60);
  assert.equal(lib.series[0].ended, true);
  assert.equal(calls.filter((c) => c.startsWith('/api/episodes')).length, 2);
  const ep = lib.entries.find((e) => e.key === 'episode:100')!;
  assert.deepEqual([ep.seriesId, ep.season, ep.episode, ep.missing], [1, 2, 3, ['ar']]);
  assert.equal(ep.subtitles[0].path, null);
  const film = lib.entries.find((e) => e.kind === 'movie')!;
  assert.deepEqual([film.key, film.title, film.seriesId], ['movie:9', 'Film (1999)', null]);
});

test('Bazarr.library fails whole when any read fails, so no half library is kept', async () => {
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/series') return json({ data: [{ sonarrSeriesId: 1, title: 'S', path: '/data/library/tv/S' }] });
    if (url.pathname === '/api/episodes') return json({ data: [] });
    return json({ message: 'boom' }, 500);
  }) as typeof fetch;
  const { library } = setup();
  library.replace(LIB, 'ar');
  const problem = await library.refresh(() => new Bazarr({ url: 'http://bazarr:6767', apiKey: 'key', fetcher }).library(), 'ar');
  assert.match(problem ?? '', /Bazarr answered 500 for \/movies/);
  assert.equal(library.shows().length, 2);
});

test('the queue the page shows runs in the order the nodes take it', () => {
  const store = new Store(':memory:');
  const add = (key: string, eligibleAt: number, extra: Parameters<Store['update']>[1] = {}) => {
    store.insert({ key, kind: 'episode', bazarr_id: 0, title: key, video_path: `/v/${key}`, source_path: null, source_lang: null, out_path: null, state: 'eligible', note: null, eligible_at: eligibleAt });
    store.update(key, extra);
  };
  add('old', 100);
  add('new', 200);
  add('crashed', 300, { crashes: 2 });
  add('now', 50, { priority: 1 });
  add('held', 10, { held_until: 10_000 });
  add('later', 5_000);
  const order = store.queue(1000, 10).map((i) => i.key);
  assert.deepEqual(order, ['held', 'now', 'new', 'old', 'crashed']);
  assert.equal(store.next(1000, true)?.key, order[0]);
  assert.deepEqual(
    store.retrying(1000, 10).map((i) => i.key),
    ['later'],
  );
});

test('an Arabic subtitle Bazarr still counts as missing is not shown as having Arabic', () => {
  const { store, library } = setup();
  library.replace({ series: [LIB.series[0]], entries: [episode(31, 1, 1, [sub('ar')], ['ar'])] }, 'ar');
  addItem(store, 'episode:31', 'eligible');
  assert.equal(library.entry('episode:31')?.status, 'ready');
});

test('an item sitting out its retry delay is "retrying", so the overview counts ready once', () => {
  const store = new Store(':memory:');
  const library = new LibraryStore(store.db, () => 1000);
  library.replace({ series: [LIB.series[0]], entries: [episode(41, 1, 1, [sub('en')], ['ar']), episode(42, 1, 2, [sub('en')], ['ar'])] }, 'ar');
  addItem(store, 'episode:41', 'eligible');
  addItem(store, 'episode:42', 'eligible');
  store.update('episode:42', { eligible_at: 5000 });
  assert.equal(library.entry('episode:41')?.status, 'ready');
  assert.equal(library.entry('episode:42')?.status, 'retrying');
  assert.equal(library.coverage().episode.ready, store.readyCount(1000));
});

test('a library that has never been read says so, with no empty date', async () => {
  const store = new Store(':memory:');
  const library = new LibraryStore(store.db);
  await library.refresh(async () => {
    throw new Error('Bazarr unreachable');
  }, 'ar');
  const html = renderOverview({ store, library, now: Date.now(), status: { bazarrError: null, lastSync: null, model: 'm', nodes: [] } });
  assert.match(html, /Could not read the library from Bazarr: Bazarr unreachable\./);
  assert.ok(!html.includes(' from -'));
  assert.match(html, /has not been read from Bazarr yet/);
});

test('the queue leaves out an episode whose shared video is being translated, as the nodes do', () => {
  const store = new Store(':memory:');
  const add = (key: string, video: string, state: 'eligible' | 'translating', eligibleAt: number) =>
    store.insert({ key, kind: 'episode', bazarr_id: 0, title: key, video_path: video, source_path: null, source_lang: null, out_path: null, state, note: null, eligible_at: eligibleAt });
  add('a', '/v/double.mkv', 'translating', 0);
  add('b', '/v/double.mkv', 'eligible', 500);
  add('c', '/v/single.mkv', 'eligible', 100);
  assert.deepEqual(
    store.queue(1000, 10).map((i) => i.key),
    ['c'],
  );
  assert.equal(store.next(1000)?.key, 'c');
});
