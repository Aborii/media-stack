// Turns a list of English segments into Arabic, in batches, through whatever
// `generate` function it is handed (Ollama in the app, a fake in tests).
//
// Batches are numbered lines so the model sees the cues around each one; that
// context is what keeps a sentence split across two cues readable. The model
// sometimes merges or drops a numbered line. A batch that comes back
// misnumbered is split in half and tried again, down to single segments, so
// one bad answer costs a few extra calls rather than the whole episode.

export type Generate = (prompt: string) => Promise<string>;

export type Language = { name: string; code: string };

export const ARABIC: Language = { name: 'Arabic', code: 'ar' };

const NAMES: Record<string, string> = {
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  tr: 'Turkish',
  ru: 'Russian',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
};

export function languageOf(code: string): Language {
  return { name: NAMES[code] ?? code, code };
}

// TranslateGemma's own prompt, from its model card, with one sentence added
// about the numbering. The two blank lines before the text are part of it.
export function promptFor(from: Language, to: Language, text: string): string {
  return (
    `You are a professional ${from.name} (${from.code}) to ${to.name} (${to.code}) translator. ` +
    `Your goal is to accurately convey the meaning and nuances of the original ${from.name} text ` +
    `while adhering to ${to.name} grammar, vocabulary, and cultural sensitivities.\n` +
    `Produce only the ${to.name} translation, without any additional explanations or commentary. ` +
    'Keep every line number exactly as given, one numbered line out for each numbered line in.\n' +
    `Please translate the following ${from.name} text into ${to.name}:\n\n\n` +
    text
  );
}

const NUMBERED = /^\s*([0-9٠-٩۰-۹]+)\s*[.:)\-،]\s*(.*)$/;

function westernDigits(text: string): string {
  return text.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0));
}

export function parseNumbered(reply: string, count: number): string[] | null {
  const found = new Map<number, string>();
  for (const line of reply.split(/\r?\n/)) {
    const m = line.match(NUMBERED);
    if (!m) continue;
    const n = Number(westernDigits(m[1]));
    if (found.has(n)) return null;
    found.set(n, m[2].trim());
  }
  if (found.size !== count) return null;
  const out: string[] = [];
  for (let n = 1; n <= count; n++) {
    const text = found.get(n);
    if (!text) return null;
    out.push(text);
  }
  return out;
}

const ARABIC_LETTER = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

// A translation is believable when it is in the target script and not wildly
// longer than its source, which is what a model that starts explaining or
// repeating itself looks like.
export function believable(source: string, translation: string, to: Language): boolean {
  if (!translation.trim()) return false;
  if (to.code === 'ar' && !ARABIC_LETTER.test(translation)) return false;
  return translation.length <= source.length * 4 + 40;
}

export type Progress = (done: number, total: number) => void;

export async function translateAll(
  bodies: string[],
  generate: Generate,
  opts: { from: Language; to: Language; batchSize: number; onProgress?: Progress },
): Promise<string[]> {
  const out = new Array<string>(bodies.length);
  let done = 0;

  async function run(start: number, end: number): Promise<void> {
    const slice = bodies.slice(start, end);
    if (slice.length === 1) {
      const reply = (await generate(promptFor(opts.from, opts.to, `1. ${slice[0]}`))).trim();
      const text = (parseNumbered(reply, 1)?.[0] ?? reply.replace(NUMBERED, '$2')).trim();
      if (!believable(slice[0], text, opts.to)) {
        throw new Error(`no usable ${opts.to.name} for: ${slice[0].slice(0, 80)}`);
      }
      out[start] = text;
    } else {
      const input = slice.map((b, k) => `${k + 1}. ${b}`).join('\n');
      const reply = await generate(promptFor(opts.from, opts.to, input));
      const parts = parseNumbered(reply, slice.length);
      if (!parts || parts.some((p, k) => !believable(slice[k], p, opts.to))) {
        const mid = start + Math.ceil(slice.length / 2);
        await run(start, mid);
        await run(mid, end);
        return;
      }
      parts.forEach((p, k) => (out[start + k] = p));
    }
    done += end - start;
    opts.onProgress?.(done, bodies.length);
  }

  for (let start = 0; start < bodies.length; start += opts.batchSize) {
    await run(start, Math.min(start + opts.batchSize, bodies.length));
  }
  return out;
}
