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
  // The source lines it came from: the whole cue, or one speaker of a dialogue cue.
  first: number;
  count: number;
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

const TAGS = [
  { open: /<i>/gi, close: /<\/i>/gi },
  { open: /<b>/gi, close: /<\/b>/gi },
  { open: /<u>/gi, close: /<\/u>/gi },
  { open: /<font\b[^>]*>/gi, close: /<\/font>/gi },
];

// A tag only stays in the lead or trail when its partner is on the other side.
// "<i>Previously on</i> Lost" and "He's <i>here</i>" italicise part of a line,
// which cannot be placed in a translated sentence, so those tags are dropped
// like inner ones rather than italicising the whole cue or leaving a stray </i>.
function balance(lead: string, trail: string): { lead: string; trail: string } {
  for (const { open, close } of TAGS) {
    if ((lead.match(open) ?? []).length !== (trail.match(close) ?? []).length) {
      lead = lead.replace(open, '');
      trail = trail.replace(close, '');
    }
  }
  return { lead, trail };
}

function split(text: string): { lead: string; body: string; trail: string } {
  const lead = text.match(LEAD)?.[0] ?? '';
  let rest = text.slice(lead.length);
  const trail = rest.match(TRAIL)?.[0] ?? '';
  rest = rest.slice(0, rest.length - trail.length);
  return { ...balance(lead, trail), body: rest.replace(INNER_TAG, '').replace(/\s+/g, ' ').trim() };
}

// A dialogue cue starts with a dash and has more than one speaker. A line
// with no dash continues the speaker above it.
function speakers(lines: string[]): { first: number; count: number }[] | null {
  if (lines.length < 2 || !DASH.test(lines[0])) return null;
  const groups: { first: number; count: number }[] = [];
  lines.forEach((line, j) => {
    if (DASH.test(line)) groups.push({ first: j, count: 1 });
    else groups[groups.length - 1].count++;
  });
  return groups.length > 1 ? groups : null;
}

// The segments to translate, in order. A cue with no letters at all ("♪",
// "...") yields nothing and is copied as it is.
export function segmentsOf(cues: Cue[]): Segment[] {
  const out: Segment[] = [];
  cues.forEach((cue, i) => {
    const groups = speakers(cue.lines);
    for (const { first, count } of groups ?? [{ first: 0, count: cue.lines.length }]) {
      const text = cue.lines.slice(first, first + count).join(' ');
      const dash = groups ? (text.match(DASH)?.[0] ?? '') : '';
      const s = split(text.slice(dash.length));
      if (LETTER.test(s.body)) out.push({ cue: i, first, count, lead: dash + s.lead, body: s.body, trail: s.trail });
    }
  });
  return out;
}

// Breaks a translated sentence back into as many lines as its source had,
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
  const byCue = new Map<number, { seg: Segment; text: string }[]>();
  segments.forEach((seg, k) => {
    const list = byCue.get(seg.cue) ?? [];
    list.push({ seg, text: translations[k] });
    byCue.set(seg.cue, list);
  });
  const cues = parsed.cues.map((c, i) => {
    const parts = byCue.get(i);
    if (!parts) return { ...c, lines: [...c.lines] };
    // Lines no segment covers (a speaker who only sings "♪") go out as they came.
    const lines: string[] = [];
    let at = 0;
    for (const { seg, text } of parts.sort((a, b) => a.seg.first - b.seg.first)) {
      lines.push(...c.lines.slice(at, seg.first));
      const wrapped = wrap(text, seg.count);
      wrapped[0] = seg.lead + wrapped[0];
      wrapped[wrapped.length - 1] += seg.trail.trimEnd();
      lines.push(...wrapped);
      at = seg.first + seg.count;
    }
    lines.push(...c.lines.slice(at));
    return { ...c, lines };
  });
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
