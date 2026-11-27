// The queue's order by hand: moving one item, and a whole show first.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store, type State } from '../src/store.ts';
import { episode, mediaDir, setup } from './helpers.ts';

function queueOf(keys: [string, number][]) {
  const store = new Store(':memory:');
  // Newest video first by default: a has the latest eligible_at, e the earliest.
  for (const [k, at] of keys) store.insert({ key: k, kind: 'episode', bazarr_id: 0, title: k, video_path: `/v/${k}`, source_path: null, source_lang: null, out_path: null, state: 'eligible', note: null, eligible_at: at });
  return store;
}
const order = (s: Store) => s.queue(10_000, 50).map((i) => i.key);

test('an item moves to the top, one up, one down, or to the bottom, and the rest keep their order', () => {
  const s = queueOf([['a', 50], ['b', 40], ['c', 30], ['d', 20], ['e', 10]]);
  assert.deepEqual(order(s), ['a', 'b', 'c', 'd', 'e']);
  assert.ok(s.place('d', 'top', 10_000));
  assert.deepEqual(order(s), ['d', 'a', 'b', 'c', 'e']);
  assert.ok(s.place('c', 'up', 10_000));
  assert.deepEqual(order(s), ['d', 'a', 'c', 'b', 'e']);
  assert.ok(s.place('d', 'down', 10_000));
  assert.deepEqual(order(s), ['a', 'd', 'c', 'b', 'e']);
  assert.ok(s.place('a', 'bottom', 10_000));
  assert.deepEqual(order(s), ['d', 'c', 'b', 'e', 'a']);
  // Moving past the ends changes nothing; an item not ready cannot move.
  assert.ok(s.place('d', 'up', 10_000));
  assert.ok(s.place('a', 'down', 10_000));
  assert.deepEqual(order(s), ['d', 'c', 'b', 'e', 'a']);
  assert.equal(s.place('nope', 'top', 10_000), false);
  // What the page shows first is what a node takes first.
  assert.equal(s.next(10_000)?.key, 'd');
});

test('an item kept for the PC stays first, whatever is moved', () => {
  const s = queueOf([['a', 50], ['b', 40], ['c', 30]]);
  s.update('b', { held_until: 99_999 });
  s.place('c', 'top', 10_000);
  assert.deepEqual(order(s), ['b', 'c', 'a']);
});

test('a show goes first in episode order: waiting and failed ones too, done and skipped ones not', () => {
  const s = queueOf([['other', 90], ['e1', 10], ['e2', 20], ['e3', 30], ['e4', 40], ['e5', 50]]);
  const set = (k: string, state: State, extra = {}) => s.update(k, { state, ...extra } as never);
  set('e2', 'waiting', { eligible_at: 99_999 });
  set('e3', 'failed', { attempts: 3, note: 'boom' });
  set('e4', 'done');
  set('e5', 'skipped');
  s.place('other', 'top', 10_000);
  const moved = s.putFirst(['e1', 'e2', 'e3', 'e4', 'e5'], 10_000);
  assert.deepEqual(moved, ['e1', 'e2', 'e3']);
  assert.deepEqual(order(s), ['e1', 'e2', 'e3', 'other']);
  assert.deepEqual([s.get('e3')!.state, s.get('e3')!.attempts, s.get('e3')!.note], ['eligible', 0, null]);
  assert.deepEqual([s.get('e4')!.state, s.get('e5')!.state], ['done', 'skipped']);
});

test('Translate this show now refuses a marked show, or one with nothing to do; Translate now goes to the top', async () => {
  const root = mediaDir();
  const { store, worker } = setup([episode(root, 1, 'One', { seriesId: 7 }), episode(root, 2, 'Two', { seriesId: 7 }), episode(root, 3, 'Other', { seriesId: 8 })]);
  await worker.sync();
  const top = () => store.next(Date.now() + 5000)?.key;
  assert.equal(worker.showFirst('series:7', ['episode:2', 'episode:1']), null);
  assert.equal(top(), 'episode:2');
  assert.match(store.logFor('episode:1').at(-1)!.message, /translate this show now/);
  assert.equal(worker.act('episode:3', 'now'), null);
  assert.equal(top(), 'episode:3');
  assert.match(worker.showFirst('series:8', []) ?? '', /nothing in this show/);
  assert.match(worker.showFirst('episode:1', []) ?? '', /not a show/);
  worker.exclude('series:7', true, ['episode:1', 'episode:2']);
  assert.match(worker.showFirst('series:7', ['episode:1']) ?? '', /marked not to translate/);
  assert.equal(worker.act('episode:3', 'bottom'), null);
});

test('the arrows move within the list the page shows, skipping an episode hidden behind a shared video', () => {
  const s = queueOf([['a', 50], ['b', 40], ['c', 30]]);
  s.insert({ key: 'busy', kind: 'episode', bazarr_id: 0, title: 'busy', video_path: '/v/b', source_path: null, source_lang: null, out_path: null, state: 'translating', note: null, eligible_at: 0 });
  // b shares its video with the one being translated: hidden from the page.
  assert.deepEqual(order(s), ['a', 'c']);
  s.place('c', 'up', 10_000);
  assert.deepEqual(order(s), ['c', 'a']);
});
