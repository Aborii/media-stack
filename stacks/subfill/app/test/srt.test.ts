import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAligned, parseSrt, rebuild, segmentsOf, serializeSrt, wrap } from '../src/srt.ts';

// Shaped like the real Malcolm in the Middle file the model was tested on:
// CRLF, a speaker label, a sound cue, a song marker, two-line cues.
const SAMPLE = [
  '1',
  '00:00:01,535 --> 00:00:03,471',
  "You're only going to take",
  'off a quarter-inch on the sides,',
  '',
  '2',
  '00:00:05,339 --> 00:00:07,708',
  'LOIS:',
  "Reese, I've done this",
  'a million times.',
  '',
  '3',
  '00:00:07,741 --> 00:00:09,810',
  '(grunts)',
  '',
  '4',
  '00:00:10,000 --> 00:00:11,000 X1:100 X2:200',
  '* Life is unfair.',
  '',
  '5',
  '00:00:12,000 --> 00:00:13,500',
  '- Hi, Mom.',
  '- <i>Not now.</i>',
  '',
  '6',
  '00:00:14,000 --> 00:00:15,000',
  '{\\an8}<i>Previously on...</i>',
  '',
  '7',
  '00:00:16,000 --> 00:00:17,000',
  '♪ ♪',
  '',
].join('\r\n');

const arabic = (body: string) => `عربي ${body.length}`;

test('parse keeps CRLF, a leading BOM out, and every index and timing line as written', () => {
  const p = parseSrt('﻿' + SAMPLE);
  assert.equal(p.newline, '\r\n');
  assert.equal(p.cues.length, 7);
  assert.equal(p.cues[3].timing, '00:00:10,000 --> 00:00:11,000 X1:100 X2:200');
  assert.deepEqual(p.cues[1].lines, ['LOIS:', "Reese, I've done this", 'a million times.']);
});

test('a cue with no letters is not sent to the model', () => {
  const segs = segmentsOf(parseSrt(SAMPLE).cues);
  assert.ok(!segs.some((s) => s.cue === 6));
});

test('formatting comes off before translation and goes back on after', () => {
  const p = parseSrt(SAMPLE);
  const segs = segmentsOf(p.cues);
  const song = segs.find((s) => s.cue === 3)!;
  assert.equal(song.body, 'Life is unfair.');
  assert.equal(song.lead, '* ');
  const top = segs.find((s) => s.cue === 5)!;
  assert.equal(top.lead, '{\\an8}<i>');
  assert.equal(top.trail, '</i>');
  assert.equal(top.body, 'Previously on...');

  const out = rebuild(p, segs, segs.map((s) => arabic(s.body)));
  assert.deepEqual(out.cues[3].lines, ['* عربي 15']);
  assert.deepEqual(out.cues[5].lines, ['{\\an8}<i>عربي 16</i>']);
  assert.deepEqual(out.cues[6].lines, ['♪ ♪']);
});

test('dialogue lines are translated one by one and keep their dashes', () => {
  const p = parseSrt(SAMPLE);
  const segs = segmentsOf(p.cues).filter((s) => s.cue === 4);
  assert.equal(segs.length, 2);
  assert.deepEqual(
    segs.map((s) => s.body),
    ['Hi, Mom.', 'Not now.'],
  );
  const all = segmentsOf(p.cues);
  const out = rebuild(p, all, all.map((s) => arabic(s.body)));
  assert.deepEqual(out.cues[4].lines, ['- عربي 8', '- <i>عربي 8</i>']);
});

test('a tag around part of a line is dropped, never left unpaired', () => {
  const cues = parseSrt(
    "1\n00:00:01,000 --> 00:00:02,000\nHe's <i>here</i>\n\n2\n00:00:03,000 --> 00:00:04,000\n<i>Previously on</i> Lost\n\n3\n00:00:05,000 --> 00:00:06,000\n<i>All of it</i>\n",
  );
  const segs = segmentsOf(cues.cues);
  assert.deepEqual(
    segs.map((s) => [s.lead, s.body, s.trail]),
    [
      ['', "He's here", ''],
      ['', 'Previously on Lost', ''],
      ['<i>', 'All of it', '</i>'],
    ],
  );
  const out = rebuild(cues, segs, ['أ', 'ب', 'ج']);
  assert.deepEqual(
    out.cues.map((c) => c.lines.join('|')),
    ['أ', 'ب', '<i>ج</i>'],
  );
});

test('a dialogue cue whose speaker wraps onto a second line keeps the speakers apart', () => {
  const p = parseSrt('1\n00:00:01,000 --> 00:00:03,000\n- Hi.\n- Hello there, how\nare you?\n');
  const segs = segmentsOf(p.cues);
  assert.deepEqual(
    segs.map((s) => [s.first, s.count, s.body]),
    [
      [0, 1, 'Hi.'],
      [1, 2, 'Hello there, how are you?'],
    ],
  );
  const out = rebuild(p, segs, ['مرحبا.', 'أهلا بك، كيف حالك؟']);
  assert.deepEqual(out.cues[0].lines, ['- مرحبا.', '- أهلا بك،', 'كيف حالك؟']);
  assert.equal(checkAligned(p, out), null);
});

test('a speaker line with no letters goes out untouched beside a translated one', () => {
  const p = parseSrt('1\n00:00:01,000 --> 00:00:03,000\n- ♪ ♪\n- Stop singing.\n');
  const segs = segmentsOf(p.cues);
  assert.equal(segs.length, 1);
  assert.deepEqual(rebuild(p, segs, ['توقف عن الغناء.']).cues[0].lines, ['- ♪ ♪', '- توقف عن الغناء.']);
});

test('only the words change: index and timing lines come back byte for byte', () => {
  const p = parseSrt(SAMPLE);
  const segs = segmentsOf(p.cues);
  const out = rebuild(p, segs, segs.map((s) => arabic(s.body)));
  assert.equal(checkAligned(p, out), null);
  const text = serializeSrt(out);
  const timing = (t: string) => t.split(/\r?\n/).filter((l) => l.includes('-->'));
  assert.deepEqual(timing(text), timing(SAMPLE));
  assert.ok(text.includes('\r\n'));
  assert.equal(parseSrt(text).cues.length, 7);
});

test('the translation is wrapped into as many lines as the source cue had', () => {
  assert.deepEqual(wrap('واحد اثنان ثلاثة أربعة', 2), ['واحد اثنان', 'ثلاثة أربعة']);
  assert.deepEqual(wrap('كلمة', 3), ['كلمة']);
  assert.deepEqual(wrap('a b c', 1), ['a b c']);
  assert.equal(wrap('one two three four five six', 3).length, 3);
});

test('checkAligned names what broke', () => {
  const p = parseSrt(SAMPLE);
  const fewer = { ...p, cues: p.cues.slice(1) };
  assert.match(checkAligned(p, fewer)!, /cue count changed/);
  const moved = { ...p, cues: p.cues.map((c, i) => (i === 2 ? { ...c, timing: '00:00:00,000 --> 00:00:01,000' } : c)) };
  assert.match(checkAligned(p, moved)!, /timing changed at cue 3/);
  const emptied = { ...p, cues: p.cues.map((c, i) => (i === 0 ? { ...c, lines: [] } : c)) };
  assert.match(checkAligned(p, emptied)!, /came back empty/);
});

test('rebuild refuses a translation list of the wrong length', () => {
  const p = parseSrt(SAMPLE);
  assert.throws(() => rebuild(p, segmentsOf(p.cues), []), /translations/);
});

test('an LF file stays LF', () => {
  const p = parseSrt('1\n00:00:01,000 --> 00:00:02,000\nHello\n');
  assert.equal(p.newline, '\n');
  assert.equal(serializeSrt(p), '1\n00:00:01,000 --> 00:00:02,000\nHello\n');
});
