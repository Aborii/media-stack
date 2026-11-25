// Marking a show or film not to translate: what it sets aside, what it
// leaves, what a sync does with it afterwards, and lifting the mark.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LibraryStore } from '../src/library.ts';
import { OllamaDown } from '../src/ollama.ts';
import { EXCLUDED_NOTE } from '../src/store.ts';
import { actions } from '../src/views/layout.ts';
import { arabicModel, episode, mediaDir, setup } from './helpers.ts';

function show(root: string) {
  return [
    episode(root, 1, 'One', { seriesId: 7 }),
    episode(root, 2, 'Two', { seriesId: 7 }),
    episode(root, 3, 'Three', { seriesId: 7 }),
    episode(root, 4, 'Other', { seriesId: 8 }),
  ];
}

test('marking a show sets aside what is not translated yet, and leaves the rest', async () => {
  const root = mediaDir();
  const { store, worker } = setup(show(root));
  await worker.sync();
  store.move('episode:2', ['eligible'], 'translating');
  store.update('episode:3', { priority: 1 });
  assert.equal(worker.exclude('series:7', true, ['episode:1', 'episode:2', 'episode:3']), null);
  assert.equal(store.get('episode:1')!.state, 'skipped');
  assert.equal(store.get('episode:1')!.note, EXCLUDED_NOTE);
  // The one being translated finishes; the other show is untouched.
  assert.equal(store.get('episode:2')!.state, 'translating');
  assert.equal(store.get('episode:3')!.state, 'skipped');
  assert.equal(store.get('episode:3')!.priority, 0);
  assert.equal(store.get('episode:4')!.state, 'eligible');
  assert.equal(store.next(Date.now() + 1000)?.key, 'episode:4');
  assert.match(store.logFor('episode:1').at(-1)!.message, /marked it not to translate/);
  // Twice is refused, and so is anything that is not a show or a film.
  assert.match(worker.exclude('series:7', true, []) ?? '', /already/);
  assert.match(worker.exclude('episode:1', true, []) ?? '', /not a show or film/);
  assert.match(worker.exclude('series:9', false, []) ?? '', /not marked/);
});

test('a sync keeps a marked show set aside, new episodes included', async () => {
  const root = mediaDir();
  const items = show(root);
  const { store, worker } = setup(items);
  await worker.sync();
  worker.exclude('series:7', true, ['episode:1', 'episode:2', 'episode:3']);
  items.push(episode(root, 5, 'New', { seriesId: 7 }));
  await worker.sync();
  assert.equal(store.get('episode:5')!.state, 'skipped');
  assert.equal(store.get('episode:5')!.note, EXCLUDED_NOTE);
  assert.equal(store.get('episode:1')!.state, 'skipped');
  // Nothing of the marked show gets translated.
  assert.equal(await worker.translateNext(), true);
  assert.equal(store.get('episode:4')!.state, 'done');
  assert.equal(await worker.translateNext(), false);
});

test('lifting the mark brings back what it set aside, but not an episode skipped on its own', async () => {
  const root = mediaDir();
  const { store, worker } = setup(show(root));
  await worker.sync();
  worker.act('episode:3', 'skip');
  worker.exclude('series:7', true, ['episode:1', 'episode:2', 'episode:3']);
  assert.equal(worker.exclude('series:7', false, ['episode:1', 'episode:2', 'episode:3']), null);
  assert.equal(store.get('episode:1')!.state, 'waiting');
  assert.equal(store.get('episode:3')!.state, 'skipped');
  assert.equal(store.get('episode:3')!.note, 'skipped by you');
  await worker.sync();
  assert.equal(store.get('episode:1')!.state, 'eligible');
  assert.equal(store.isExcluded('series:7'), false);
});

test('a film is marked on its own key', async () => {
  const root = mediaDir();
  const film = { ...episode(root, 9, 'Film'), kind: 'movie' as const };
  const { store, worker } = setup([film]);
  await worker.sync();
  worker.exclude('movie:9', true, ['movie:9']);
  assert.equal(store.get('movie:9')!.state, 'skipped');
  await worker.sync();
  assert.equal(store.get('movie:9')!.state, 'skipped');
});

test('the page shows marked titles as not translated, and lists them apart', async () => {
  const root = mediaDir();
  const { store, worker } = setup(show(root));
  const library = new LibraryStore(store.db);
  const sub = { code2: 'en', path: '/x.srt', forced: false, hi: false };
  const ep = (id: number, seriesId: number) => ({ key: `episode:${id}`, kind: 'episode' as const, id, seriesId, season: 1, episode: id, title: `E${id}`, path: `/v${id}`, subtitles: [sub], missing: ['ar'] });
  library.replace(
    {
      series: [
        { id: 7, title: 'Seven', year: null, path: '/data/library/tv/Seven', ended: false },
        { id: 8, title: 'Eight', year: null, path: '/data/library/tv/Eight', ended: false },
      ],
      entries: [ep(1, 7), ep(2, 7), ep(4, 8), { ...ep(9, 0), key: 'movie:9', kind: 'movie', seriesId: null, season: null, episode: null, title: 'Film' }],
    },
    'ar',
  );
  await worker.sync();
  store.move('episode:2', ['eligible'], 'translating');
  worker.exclude('series:7', true, library.episodeKeys(7));
  worker.exclude('movie:9', true, ['movie:9']);
  assert.deepEqual(library.episodeKeys(7), ['episode:1', 'episode:2']);
  const seven = library.show(7)!;
  assert.equal(seven.show.excluded, true);
  // Being translated wins over the mark until it finishes.
  assert.deepEqual(
    seven.episodes.map((e) => e.status),
    ['excluded', 'translating'],
  );
  assert.equal(library.shows().find((s) => s.id === 8)!.excluded, false);
  assert.equal(library.movies({ marked: true, limit: 10 }).total, 1);
  assert.equal(library.movies({ marked: false, limit: 10 }).total, 0);
  // An item set aside by the mark offers no Undo skip: lifting the mark does that.
  assert.ok(!actions(store.get('episode:1')!, '/').includes('unskip'));
  worker.act('episode:4', 'skip');
  assert.ok(actions(store.get('episode:4')!, '/').includes('unskip'));
});

test('lifting the mark while a sync waits on Bazarr does not leave the episodes set aside', async () => {
  const root = mediaDir();
  let calls = 0;
  let onDetails: () => void = () => undefined;
  const { store, worker } = setup(show(root), {}, arabicModel, () => {
    if (++calls === 3) onDetails();
    return false;
  });
  await worker.sync();
  worker.exclude('series:7', true, []);
  // A sync calls Bazarr twice for the wanted lists, then for the details:
  // lift the mark during that third call.
  calls = 0;
  onDetails = () => void worker.exclude('series:7', false, []);
  await worker.sync();
  assert.equal(store.isExcluded('series:7'), false);
  assert.equal(store.get('episode:1')!.state, 'eligible');
});

test('a row the lifted mark missed comes back at the next sync', async () => {
  const root = mediaDir();
  const { store, worker } = setup(show(root));
  await worker.sync();
  worker.exclude('series:7', true, []);
  // As if the mark had been lifted with no record of the episodes at all.
  store.db.prepare('DELETE FROM excluded').run();
  store.update('episode:2', { series_id: null });
  assert.equal(store.get('episode:2')!.state, 'skipped');
  await worker.sync();
  assert.equal(store.get('episode:2')!.state, 'eligible');
  assert.equal(store.get('episode:2')!.series_id, 7);
});

test('the mark finds an episode by its own show id, even one the library copy does not list', async () => {
  const root = mediaDir();
  const { store, worker } = setup(show(root));
  await worker.sync();
  assert.equal(worker.exclude('series:7', true, []), null);
  assert.equal(store.get('episode:2')!.state, 'skipped');
  worker.exclude('series:7', false, []);
  assert.equal(store.get('episode:2')!.state, 'waiting');
});

test('an item marked while it is translated is never taken again after an outage', async () => {
  const root = mediaDir();
  let worker!: ReturnType<typeof setup>['worker'];
  const down = async (): Promise<string> => {
    worker.exclude('series:7', true, []);
    throw new OllamaDown('Ollama call failed: fetch failed');
  };
  const made = setup([episode(root, 1, 'One', { seriesId: 7 })], {}, down);
  worker = made.worker;
  const { store } = made;
  await worker.sync();
  assert.equal(await worker.translateNext(), false);
  // Back to eligible by the outage, but marked: no node takes it, and the queue does not count it.
  assert.equal(store.get('episode:1')!.state, 'eligible');
  assert.equal(store.next(Date.now() + 5000, true), undefined);
  assert.equal(store.readyCount(Date.now() + 5000), 0);
  assert.equal(store.queue(Date.now() + 5000, 10).length, 0);
  // Retry and Translate now are refused while it is marked, and the next sync sets it aside.
  assert.match(worker.act('episode:1', 'now') ?? '', /marked not to translate/);
  await worker.sync();
  assert.equal(store.get('episode:1')!.state, 'skipped');
});

test('a marked item that failed is set aside by the next sync, and its Retry is refused', async () => {
  const root = mediaDir();
  const { store, worker } = setup(show(root));
  await worker.sync();
  store.move('episode:1', ['eligible'], 'failed', { note: 'boom' });
  store.db.prepare("INSERT INTO excluded (key, at) VALUES ('series:7', 0)").run();
  assert.match(worker.act('episode:1', 'retry') ?? '', /lift the mark first/);
  await worker.sync();
  assert.equal(store.get('episode:1')!.state, 'skipped');
  assert.equal(store.get('episode:1')!.note, EXCLUDED_NOTE);
});
