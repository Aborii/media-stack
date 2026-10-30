import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bazarr } from '../src/bazarr.ts';
import { readSettings } from '../src/config.ts';
import { inHours, parseHours } from '../src/hours.ts';
import { Ollama } from '../src/ollama.ts';
import { Store } from '../src/store.ts';
import { fakeBazarr, json } from './helpers.ts';

test('hours: a window that wraps midnight, a plain one, and none', () => {
  const night = parseHours('22-7');
  assert.equal(inHours(night, new Date(2026, 0, 1, 23)), true);
  assert.equal(inHours(night, new Date(2026, 0, 1, 3)), true);
  assert.equal(inHours(night, new Date(2026, 0, 1, 12)), false);
  const day = parseHours('1-6');
  assert.equal(inHours(day, new Date(2026, 0, 1, 5)), true);
  assert.equal(inHours(day, new Date(2026, 0, 1, 6)), false);
  assert.equal(inHours(parseHours(''), new Date()), true);
  assert.throws(() => parseHours('nights'), /must look like/);
  assert.throws(() => parseHours('5-5'), /not a range/);
});

test('settings: defaults, and refusals for what would break later', () => {
  const s = readSettings({ BAZARR_API_KEY: 'k' });
  assert.equal(s.model, 'translategemma:12b');
  assert.deepEqual(s.sourceLanguages, ['en']);
  assert.equal(s.waitHours, 72);
  assert.equal(s.activeHours, null);
  assert.deepEqual(readSettings({ BAZARR_API_KEY: 'k', SOURCE_LANGUAGES: 'EN, fr' }).sourceLanguages, ['en', 'fr']);
  assert.throws(() => readSettings({}), /BAZARR_API_KEY/);
  assert.throws(() => readSettings({ BAZARR_API_KEY: 'k', SOURCE_LANGUAGES: 'english' }), /two-letter/);
  assert.throws(() => readSettings({ BAZARR_API_KEY: 'k', BATCH_SIZE: '0' }), /BATCH_SIZE/);
});

test('Bazarr: a wrong key or a broken answer is an error, never an empty list', async () => {
  const wrongKey = new Bazarr({ url: 'http://bazarr:6767/', apiKey: 'nope', fetcher: fakeBazarr([]) });
  await assert.rejects(wrongKey.wanted(), /answered 401/);
  const odd = new Bazarr({ url: 'http://bazarr:6767', apiKey: 'key', fetcher: (async () => json({ message: 'x' })) as typeof fetch });
  await assert.rejects(odd.wanted(), /no list/);
});

test('Bazarr: ids are looked up in chunks of 100', async () => {
  const calls: string[] = [];
  const b = new Bazarr({ url: 'http://bazarr:6767', apiKey: 'key', fetcher: fakeBazarr([], { calls }) });
  const many = Array.from({ length: 250 }, (_, i) => ({ kind: 'episode' as const, id: i }));
  await b.details(many);
  assert.equal(calls.filter((c) => c.startsWith('/api/episodes?')).length, 3);
});

test('Ollama: finds the model under its tag, and says what is wrong otherwise', async () => {
  const tags = (names: string[]) => (async () => json({ models: names.map((name) => ({ name })) })) as typeof fetch;
  assert.equal(await new Ollama({ url: 'http://o', model: 'translategemma:12b', fetcher: tags(['translategemma:12b']) }).problem(), null);
  assert.equal(await new Ollama({ url: 'http://o', model: 'mymodel', fetcher: tags(['mymodel:latest']) }).problem(), null);
  assert.match((await new Ollama({ url: 'http://o', model: 'translategemma:12b', fetcher: tags(['nomic-embed-text:latest']) }).problem())!, /not pulled/);
  assert.match((await new Ollama({ url: 'http://o', model: 'm', fetcher: (async () => json({}, 500)) as typeof fetch }).problem())!, /answered 500/);
  assert.match((await new Ollama({ url: 'http://o', model: 'm' }).problem())!, /unreachable/);
});

test('Ollama: generate sends a deterministic request and returns the text', async () => {
  let sent: Record<string, unknown> = {};
  const fetcher = (async (_: unknown, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return json({ response: '1. مرحبا' });
  }) as typeof fetch;
  const o = new Ollama({ url: 'http://o/', model: 'translategemma:12b', fetcher });
  assert.equal(await o.generate('p'), '1. مرحبا');
  assert.equal(sent.model, 'translategemma:12b');
  assert.equal(sent.stream, false);
  assert.equal((sent.options as { temperature: number }).temperature, 0);
  await assert.rejects(new Ollama({ url: 'http://o', model: 'm', fetcher: (async () => new Response('oom', { status: 500 })) as typeof fetch }).generate('p'), /answered 500: oom/);
  await assert.rejects(new Ollama({ url: 'http://o', model: 'm' }).generate('p'), /call failed/);
});

test('store: two claims on one item, one winner', () => {
  const s = new Store(':memory:');
  s.insert({ key: 'k', kind: 'episode', bazarr_id: 1, title: 't', video_path: '/v', source_path: null, source_lang: null, out_path: null, state: 'eligible', note: null, eligible_at: 0 });
  const wins = [s.move('k', ['eligible'], 'translating'), s.move('k', ['eligible'], 'translating')];
  assert.deepEqual(wins, [true, false]);
});

test('store: counts, search, the week\'s numbers and meta', () => {
  let now = 1_000_000;
  const s = new Store(':memory:', () => now);
  const base = { kind: 'episode' as const, bazarr_id: 1, video_path: '/v', source_path: null, source_lang: null, out_path: null, note: null, eligible_at: 0 };
  s.insert({ ...base, key: 'a', title: 'Alpha 1x01', state: 'done' });
  s.insert({ ...base, key: 'b', title: 'Beta 50%', state: 'waiting' });
  s.update('a', { started_at: now - 600_000, finished_at: now });
  assert.equal(s.counts().done, 1);
  assert.equal(s.counts().waiting, 1);
  assert.equal(s.list({ q: 'alp', limit: 10 }).items[0].key, 'a');
  assert.equal(s.list({ q: '%', limit: 10 }).total, 2);
  assert.equal(s.list({ state: 'waiting', limit: 1 }).total, 1);
  assert.deepEqual(s.finishedSince(0), { count: 1, avgSeconds: 600 });
  assert.equal(s.next(now), undefined);
  s.setMeta('x', '1');
  s.setMeta('x', '2');
  assert.equal(s.getMeta('x'), '2');
  s.deleteMeta('x');
  assert.equal(s.getMeta('x'), null);
  s.log('a', 'one');
  now += 1;
  s.log('a', 'two');
  assert.deepEqual(s.logFor('a').map((l) => l.message), ['one', 'two']);
  s.remove('a');
  assert.equal(s.get('a'), undefined);
  assert.deepEqual(s.logFor('a'), []);
  s.close();
});
