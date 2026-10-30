// SRT parsing and rebuilding for subfill. The rule this file exists to keep:
// only the words change. Every index and timing line goes back out byte for
// byte, and the parts of a cue that are formatting rather than speech - tags,
// {\an8} positions, song markers, dialogue dashes - are lifted off before the
// model sees the text and put back after.

export type Cue = {
  index: string;
  timing: string;
  lines: string[];
};

export type Parsed = {
  cues: Cue[];
  newline: '\n' | '\r\n';
};

// A piece of text the model translates, and how to put it back.
export type Segment = {
  cue: number;
  // Which line of a dialogue cue this is; null when the whole cue is one segment.
  line: number | null;
  lead: string;
  body: string;
  trail: string;
};

const TIMING = /^\s*\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}/;
const INDEX = /^\s*\d+\s*$/;

export function parseSrt(text: string): Parsed {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const cues: Cue[] = [];
  let current: Cue | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (INDEX.test(line) && TIMING.test(lines[i + 1] ?? '')) {
      current = { index: line, timing: lines[i + 1], lines: [] };
      cues.push(current);
      i++;
      continue;
    }
    if (current && line.trim() !== '') current.lines.push(line);
  }
  return { cues, newline };
}

export function serializeSrt(parsed: Parsed): string {
  const nl = parsed.newline;
  return parsed.cues.map((c) => [c.index, c.timing, ...c.lines].join(nl)).join(nl + nl) + nl;
}

// Leading formatting: ASS-style overrides, opening tags, song markers.
const LEAD = /^(?:\s|\{\\[^}]*\}|<(?:i|b|u|font\b[^>]*)>|[♪♫#*])+/i;
// Trailing formatting: closing tags and song markers.
const TRAIL = /(?:\s|<\/(?:i|b|u|font)>|[♪♫#*])+$/i;
// Tags in the middle of a line cannot be placed in a translated sentence, whose
// word order differs; they are dropped and the words kept.
const INNER_TAG = /<\/?(?:i|b|u|font\b[^>]*)>|\{\\[^}]*\}/gi;
const DASH = /^(\s*(?:\{\\[^}]*\}|<(?:i|b|u|font\b[^>]*)>)*\s*-+\s*)/i;
const LETTER = /\p{L}/u;

function split(text: string): { lead: string; body: string; trail: string } {
  const lead = text.match(LEAD)?.[0] ?? '';
  let rest = text.slice(lead.length);
  const trail = rest.match(TRAIL)?.[0] ?? '';
  rest = rest.slice(0, rest.length - trail.length);
  return { lead, body: rest.replace(INNER_TAG, '').replace(/\s+/g, ' ').trim(), trail };
}

function isDialogue(lines: string[]): boolean {
  return lines.length > 1 && lines.every((l) => DASH.test(l));
}

// The segments to translate, in order. A cue with no letters at all ("♪",
// "...") yields nothing and is copied as it is.
export function segmentsOf(cues: Cue[]): Segment[] {
  const out: Segment[] = [];
  cues.forEach((cue, i) => {
    if (isDialogue(cue.lines)) {
      cue.lines.forEach((line, j) => {
        const dash = line.match(DASH)?.[0] ?? '';
        const s = split(line.slice(dash.length));
        if (LETTER.test(s.body)) out.push({ cue: i, line: j, lead: dash + s.lead, body: s.body, trail: s.trail });
      });
      return;
    }
    const s = split(cue.lines.join(' '));
    if (LETTER.test(s.body)) out.push({ cue: i, line: null, ...s });
  });
  return out;
}

// Breaks a translated sentence back into as many lines as the source cue had,
// at spaces, keeping the lines close to even.
export function wrap(text: string, count: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (count <= 1 || words.length <= 1) return [words.join(' ')];
  const lines: string[] = [];
  let rest = words;
  for (let left = Math.min(count, words.length); left > 1; left--) {
    const target = rest.join(' ').length / left;
    let length = rest[0].length;
    let take = 1;
    while (take < rest.length - (left - 1) && length + 1 + rest[take].length / 2 <= target) {
      length += 1 + rest[take].length;
      take++;
    }
    lines.push(rest.slice(0, take).join(' '));
    rest = rest.slice(take);
  }
  lines.push(rest.join(' '));
  return lines;
}

// Puts the translations back into copies of the cues. `translations` is
// indexed like `segments`.
export function rebuild(parsed: Parsed, segments: Segment[], translations: string[]): Parsed {
  if (segments.length !== translations.length) {
    throw new Error(`have ${translations.length} translations for ${segments.length} segments`);
  }
  const cues = parsed.cues.map((c) => ({ ...c, lines: [...c.lines] }));
  const whole = new Map<number, { seg: Segment; text: string }>();
  segments.forEach((seg, k) => {
    const text = translations[k];
    if (seg.line === null) whole.set(seg.cue, { seg, text });
    else cues[seg.cue].lines[seg.line] = seg.lead + text + seg.trail.trimEnd();
  });
  for (const [i, { seg, text }] of whole) {
    const lines = wrap(text, parsed.cues[i].lines.length);
    lines[0] = seg.lead + lines[0];
    lines[lines.length - 1] = lines[lines.length - 1] + seg.trail.trimEnd();
    cues[i].lines = lines;
  }
  return { cues, newline: parsed.newline };
}

// The output must line up with the source cue for cue: same count, the same
// index and timing lines, and no cue left empty.
export function checkAligned(source: Parsed, output: Parsed): string | null {
  if (source.cues.length !== output.cues.length) {
    return `cue count changed: ${source.cues.length} -> ${output.cues.length}`;
  }
  for (let i = 0; i < source.cues.length; i++) {
    const a = source.cues[i];
    const b = output.cues[i];
    if (a.index !== b.index || a.timing !== b.timing) return `timing changed at cue ${a.index.trim()}`;
    if (a.lines.join('').trim() !== '' && b.lines.join('').trim() === '') return `cue ${a.index.trim()} came back empty`;
  }
  return null;
}
