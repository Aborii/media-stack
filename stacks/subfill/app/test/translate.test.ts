import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARABIC, believable, languageOf, parseNumbered, promptFor, translateAll } from '../src/translate.ts';

const EN = languageOf('en');

// A stand-in for the model: answers each numbered line with Arabic.
function numberedLines(prompt: string): { n: number; body: string }[] {
  const text = prompt.split('\n\n\n')[1];
  return text.split('\n').map((l) => {
    const m = l.match(/^(\d+)\. (.*)$/)!;
    return { n: Number(m[1]), body: m[2] };
  });
}
const good = async (prompt: string) => numberedLines(prompt).map(({ n, body }) => `${n}. ترجمة ${body}`).join('\n');

test('the prompt is TranslateGemma\'s, with the text after two blank lines', () => {
  const p = promptFor(EN, ARABIC, '1. Hello');
  assert.match(p, /^You are a professional English \(en\) to Arabic \(ar\) translator\./);
  assert.ok(p.endsWith('into Arabic:\n\n\n1. Hello'));
});

test('numbered replies are read in order, Arabic-Indic digits included', () => {
  assert.deepEqual(parseNumbered('1. أ\n2. ب', 2), ['أ', 'ب']);
  assert.deepEqual(parseNumbered('٢. ب\n١. أ', 2), ['أ', 'ب']);
  assert.deepEqual(parseNumbered('1) أ\n2: ب', 2), ['أ', 'ب']);
  assert.equal(parseNumbered('1. أ', 2), null);
  assert.equal(parseNumbered('1. أ\n1. ب', 2), null);
  assert.equal(parseNumbered('1. أ\n3. ب', 2), null);
});

test('believable: Arabic script, and not far longer than the source', () => {
  assert.equal(believable('Hi', 'مرحبا', ARABIC), true);
  assert.equal(believable('Hi', 'Hi', ARABIC), false);
  assert.equal(believable('Hi', '', ARABIC), false);
  assert.equal(believable('Hi', 'م'.repeat(100), ARABIC), false);
});

test('batches go out numbered and come back in order', async () => {
  const calls: string[] = [];
  const out = await translateAll(['a', 'b', 'c', 'd', 'e'], async (p) => (calls.push(p), good(p)), {
    from: EN,
    to: ARABIC,
    batchSize: 2,
  });
  assert.deepEqual(out, ['ترجمة a', 'ترجمة b', 'ترجمة c', 'ترجمة d', 'ترجمة e']);
  assert.equal(calls.length, 3);
});

test('a misnumbered batch is split and retried, and only that batch', async () => {
  let calls = 0;
  const progress: number[] = [];
  const merging = async (p: string) => {
    calls++;
    const lines = numberedLines(p);
    // Merges lines 1 and 2 whenever it is given more than two at once.
    if (lines.length > 2) return [`1. ترجمة ${lines[0].body} ${lines[1].body}`, ...lines.slice(2).map((l, k) => `${k + 2}. ترجمة ${l.body}`)].join('\n');
    return good(p);
  };
  const out = await translateAll(['a', 'b', 'c', 'd'], merging, { from: EN, to: ARABIC, batchSize: 4, onProgress: (d) => progress.push(d) });
  assert.deepEqual(out, ['ترجمة a', 'ترجمة b', 'ترجمة c', 'ترجمة d']);
  assert.equal(calls, 3);
  assert.deepEqual(progress, [2, 4]);
});

test('a single line the model will not translate fails the episode', async () => {
  const echo = async (p: string) => numberedLines(p).map(({ n, body }) => `${n}. ${body}`).join('\n');
  await assert.rejects(translateAll(['Hello there'], echo, { from: EN, to: ARABIC, batchSize: 5 }), /no usable Arabic for: Hello there/);
});

test('a single line answered without its number is still used', async () => {
  const bare = async () => 'مرحبا';
  assert.deepEqual(await translateAll(['Hello'], bare, { from: EN, to: ARABIC, batchSize: 5 }), ['مرحبا']);
});

test('languageOf names the common ones and falls back to the code', () => {
  assert.equal(languageOf('fr').name, 'French');
  assert.equal(languageOf('xx').name, 'xx');
});
