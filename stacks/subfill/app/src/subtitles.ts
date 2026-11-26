// The two subtitles of a translation, for the page: the original it was
// translated from and subfill's Arabic, read fresh from disk and matched line
// by line. Reads only. The original comes from the file beside the video, or
// for one translated from inside the video, from that track again, cleaned
// the same way it was for translating, so the lines meet the Arabic's.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { extractEmbedded } from './embedded.ts';
import { cleanStyled, parseSrt, serializeSrt, type Cue, type Parsed } from './srt.ts';
import type { Item } from './store.ts';
import { decode, MARKER } from './worker.ts';

export type Row = { n: number; timing: string; source: string[] | null; target: string[] | null };

export type Pair = {
  rows: Row[];
  // Where the original came from, in words.
  sourceFrom: string | null;
  // Why one side could not be read, if it could not.
  sourceProblem: string | null;
  targetProblem: string | null;
};

export type SubtitleDeps = {
  mediaRoot: string;
  targetCode: string;
  sourceLanguages: string[];
  extract?: typeof extractEmbedded;
};

function inMedia(root: string, p: string): boolean {
  const r = path.resolve(root);
  const full = path.resolve(p);
  return full.startsWith(r + path.sep);
}

// The machine subtitle of an item, if subfill wrote one where it may read.
export function machinePath(item: Item, deps: SubtitleDeps): string | null {
  const p = item.out_path;
  return p && p.endsWith(`.${deps.targetCode}.${MARKER}.srt`) && inMedia(deps.mediaRoot, p) ? p : null;
}

// `unmerged` is the same track cleaned as before repeats were joined, for an
// Arabic translated then, whose lines follow that cleaning.
type Source = { parsed: Parsed; from: string; lang: string; text: string | null; name: string | null; unmerged?: Parsed };

// Reading a track inside a video means reading the whole video, which can
// take minutes for a large film. The page and its download, a reload, or two
// tabs share one read while it runs, and the last few results are kept, by
// video and its change time, so a new file at the same path is read afresh.
const INSIDE_KEPT = 4;
const insideReads = new Map<string, Promise<Source>>();

function readInside(item: Item, deps: SubtitleDeps, ctime: number): Promise<Source> {
  const from = item.source_lang ?? deps.sourceLanguages[0] ?? 'en';
  const langs = [from, ...deps.sourceLanguages.filter((l) => l !== from)];
  const key = `${item.video_path}|${ctime}|${langs.join(',')}`;
  const known = insideReads.get(key);
  if (known) {
    insideReads.delete(key);
    insideReads.set(key, known);
    return known;
  }
  const read = (deps.extract ?? extractEmbedded)(item.video_path, langs).then((got) => ({
    parsed: cleanStyled(parseSrt(got.srt)).parsed,
    unmerged: cleanStyled(parseSrt(got.srt), { merge: false }).parsed,
    from: `the ${got.lang} subtitle inside the video (track ${got.stream.index}, ${got.stream.codec})`,
    lang: got.lang,
    text: null,
    name: null,
  }));
  insideReads.set(key, read);
  // A failed read is not kept: the next view tries again.
  read.catch(() => insideReads.get(key) === read && insideReads.delete(key));
  while (insideReads.size > INSIDE_KEPT) insideReads.delete(insideReads.keys().next().value!);
  return read;
}

// The original as a parsed subtitle, where it came from, and for a file
// beside the video, the file itself.
export async function loadSource(item: Item, deps: SubtitleDeps): Promise<Source> {
  if (item.source_path) {
    if (!inMedia(deps.mediaRoot, item.source_path)) throw new Error('the original is outside the media folder');
    const text = decode(await readFile(item.source_path));
    const name = path.basename(item.source_path);
    return { parsed: parseSrt(text), from: name, lang: item.source_lang ?? 'en', text, name };
  }
  if (item.inside_track === 'yes') {
    if (!inMedia(deps.mediaRoot, item.video_path)) throw new Error('the video is outside the media folder');
    const ctime = Math.floor((await stat(item.video_path)).ctimeMs);
    return readInside(item, deps, ctime);
  }
  throw new Error('this item has no original to read');
}

export async function loadTarget(item: Item, deps: SubtitleDeps): Promise<Parsed> {
  const p = machinePath(item, deps);
  if (!p) throw new Error('subfill has written no Arabic for this item');
  try {
    return parseSrt(decode(await readFile(p)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('the Arabic file is no longer there');
    throw err;
  }
}

// Line by line. The Arabic keeps the original's cues and timing, so they
// normally pair by position; if the original has changed since, they pair by
// timing instead, and a line with no partner shows one side only.
export function pairUp(source: Cue[] | null, target: Cue[] | null): Row[] {
  const s = source ?? [];
  const t = target ?? [];
  const same = s.length === t.length && s.every((c, i) => c.timing.trim() === t[i].timing.trim());
  if (same || !source || !target) {
    const n = Math.max(s.length, t.length);
    return Array.from({ length: n }, (_, i) => ({
      n: i + 1,
      timing: (s[i] ?? t[i]).timing.trim(),
      source: source ? (s[i]?.lines ?? null) : null,
      target: target ? (t[i]?.lines ?? null) : null,
    }));
  }
  const byTiming = new Map<string, Cue[]>();
  for (const c of t) byTiming.set(c.timing.trim(), [...(byTiming.get(c.timing.trim()) ?? []), c]);
  const rows: Row[] = [];
  for (const c of s) {
    const match = byTiming.get(c.timing.trim())?.shift();
    rows.push({ n: 0, timing: c.timing.trim(), source: c.lines, target: match?.lines ?? null });
  }
  for (const rest of byTiming.values()) for (const c of rest) rows.push({ n: 0, timing: c.timing.trim(), source: null, target: c.lines });
  rows.sort((a, b) => a.timing.localeCompare(b.timing));
  return rows.map((r, i) => ({ ...r, n: i + 1 }));
}

export async function loadPair(item: Item, deps: SubtitleDeps): Promise<Pair> {
  let source: Source | null = null;
  let target: Parsed | null = null;
  let sourceProblem: string | null = null;
  let targetProblem: string | null = null;
  await Promise.all([
    loadSource(item, deps).then(
      (r) => void (source = r),
      (err: Error) => void (sourceProblem = err.message),
    ),
    loadTarget(item, deps).then(
      (r) => void (target = r),
      (err: Error) => void (targetProblem = err.message),
    ),
  ]);
  let s = source as Source | null;
  const t = target as Parsed | null;
  // An Arabic made before repeats were joined has one line per unjoined cue.
  if (s?.unmerged && t && s.parsed.cues.length !== t.cues.length && s.unmerged.cues.length === t.cues.length) {
    s = { ...s, parsed: s.unmerged };
  }
  if (s && !s.parsed.cues.length) {
    sourceProblem = 'the original has no lines subfill can read';
    s = null;
  }
  return { rows: pairUp(s?.parsed.cues ?? null, t?.cues ?? null), sourceFrom: s?.from ?? (source as Source | null)?.from ?? null, sourceProblem, targetProblem };
}

// A subtitle as a file to download: the Arabic, or the original, byte for
// byte under its own name when it is a file beside the video, and written out
// as SRT under the video's name when it came from inside it.
export async function fileFor(item: Item, which: 'arabic' | 'original', deps: SubtitleDeps): Promise<{ name: string; body: string }> {
  const base = path.basename(item.video_path).replace(/\.[^.]+$/, '');
  if (which === 'arabic') {
    const p = machinePath(item, deps);
    if (!p) throw new Error('subfill has written no Arabic for this item');
    return { name: path.basename(p), body: decode(await readFile(p)) };
  }
  const source = await loadSource(item, deps);
  if (source.text !== null && source.name) return { name: source.name, body: source.text };
  return { name: `${base}.${source.lang}.srt`, body: serializeSrt(source.parsed) };
}
