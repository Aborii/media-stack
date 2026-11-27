// The stats page: history read from the log, counted per day, per hour and
// per node, and one day's events.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completions, dayBounds, dayEvents, dayKey, parseDay, perDay, perHour } from '../src/stats.ts';
import { LibraryStore } from '../src/library.ts';
import { Store } from '../src/store.ts';
import { renderStats } from '../src/views/stats.ts';

function at(y: number, m: number, d: number, h = 12, min = 0) {
  return new Date(y, m - 1, d, h, min).getTime();
}

function storeWith(entries: [number, string][]) {
  let clock = 0;
  const store = new Store(':memory:', () => clock);
  store.insert({ key: 'episode:1', kind: 'episode', bazarr_id: 1, title: 'Show <b>1x01</b>', video_path: '/v', source_path: null, source_lang: 'en', out_path: null, state: 'done', note: null, eligible_at: 0 });
  for (const [when, message] of entries) {
    clock = when;
    store.log('episode:1', message);
  }
  return store;
}

test('every finished translation is read from its log line, with lines, minutes and node', () => {
  const store = storeWith([
    [at(2026, 11, 26, 9), 'wrote a.ar.machine.srt (700 cues in 3 min on the pc)'],
    [at(2026, 11, 26, 23, 30), 'wrote b.ar.machine.srt (450 cues in 52 min on the mini, 2 left in English)'],
    [at(2026, 11, 27, 0, 15), 'translating from en on the pc (attempt 1)'],
    [at(2026, 11, 27, 1), 'wrote c.ar.machine.srt (300 cues in 2 min on the pc)'],
  ]);
  const all = completions(store.db);
  assert.deepEqual(
    all.map((d) => [d.cues, d.minutes, d.node, d.title]),
    [
      [700, 3, 'pc', 'Show <b>1x01</b>'],
      [450, 52, 'mini', 'Show <b>1x01</b>'],
      [300, 2, 'pc', 'Show <b>1x01</b>'],
    ],
  );
  // Days are local days; the late-night one counts on its own day.
  const days = perDay(all, at(2026, 11, 27, 15), 3);
  assert.deepEqual(
    days.map((d) => [dayKey(d.day), d.byNode]),
    [
      ['2026-11-25', {}],
      ['2026-11-26', { pc: 1, mini: 1 }],
      ['2026-11-27', { pc: 1 }],
    ],
  );
  const hours = perHour(all, at(2026, 11, 26));
  assert.deepEqual([hours[9], hours[23], hours[1]], [{ pc: 1 }, { mini: 1 }, {}]);
});

test('a day is read from a date, and anything else is refused', () => {
  assert.equal(dayKey(parseDay('2026-11-27')!), '2026-11-27');
  for (const bad of ['2026-02-30', '27-11-2026', '', null, '2026-11-27x']) assert.equal(parseDay(bad), null, String(bad));
  const [start, next] = dayBounds(at(2026, 11, 27, 18));
  assert.deepEqual([dayKey(start), dayKey(next)], ['2026-11-27', '2026-11-28']);
});

test('a day\'s events: translated, failed, found by Bazarr, newly missing, and what you did', () => {
  const store = storeWith([
    [at(2026, 11, 27, 8), 'Arabic missing in Bazarr; eligible'],
    [at(2026, 11, 27, 9), 'failed, will try again: Ollama answered 500'],
    [at(2026, 11, 27, 10), 'you chose: now'],
    [at(2026, 11, 27, 11), 'wrote a.srt (10 cues in 1 min on the pc)'],
    [at(2026, 11, 27, 12), 'Bazarr found an Arabic subtitle; ours was deleted'],
    [at(2026, 11, 28, 1), 'wrote b.srt (10 cues in 1 min on the pc)'],
  ]);
  const ev = dayEvents(store.db, at(2026, 11, 27));
  assert.deepEqual([ev.done.length, ev.failed.length, ev.found, ev.added, ev.yours.length], [1, 1, 1, 1, 1]);
});

test('the page shows the totals, both charts with their tables, and the day, escaped', () => {
  const store = storeWith([
    [at(2026, 11, 27, 9), 'wrote a.srt (700 cues in 3 min on the pc)'],
    [at(2026, 11, 27, 9, 30), 'failed, giving up: <boom>'],
  ]);
  const html = renderStats({ store, library: new LibraryStore(store.db), now: at(2026, 11, 27, 15), status: { bazarrError: null, lastSync: null, model: 'm', nodes: [] } }, at(2026, 11, 27));
  assert.match(html, /Translated today<\/span><b>1<\/b><span class="sub">700 lines/);
  assert.equal(html.match(/<svg class="chart"/g)?.length, 2);
  assert.equal(html.match(/Show as a table/g)?.length, 2);
  assert.match(html, /<title>Friday 27 November: 1 translated on the PC \(GPU\)<\/title>/);
  assert.match(html, /href="\/stats\?day=2026-11-26"/);
  assert.ok(html.includes('Show &#60;b&#62;1x01&#60;/b&#62;'));
  assert.ok(html.includes('&#60;boom&#62;'));
  assert.ok(!html.includes('<boom>'));
  assert.match(html, /aria-current="page">.*Stats/);
});
