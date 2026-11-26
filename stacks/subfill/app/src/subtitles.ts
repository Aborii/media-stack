// The two subtitles of a translation, for the page: the original it was
// translated from and subfill's Arabic, read fresh from disk and matched line
// by line. Reads only. The original comes from the file beside the video, or
// for one translated from inside the video, from that track again, cleaned
// the same way it was for translating, so the lines meet the Arabic's.
import { readFile } from 'node:fs/promises';
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

// The original as a parsed subtitle, and where it came from.
export async function loadSource(item: Item, deps: SubtitleDeps): Promise<{ parsed: Parsed; from: string }> {
  if (item.source_path) {
    if (!inMedia(deps.mediaRoot, item.source_path)) throw new Error('the original is outside the media folder');
    return { parsed: parseSrt(decode(await readFile(item.source_path))), from: path.basename(item.source_path) };
  }
  if (item.inside_track === 'yes') {
    if (!inMedia(deps.mediaRoot, item.video_path)) throw new Error('the video is outside the media folder');
    const from = item.source_lang ?? deps.sourceLanguages[0] ?? 'en';
    const got = await (deps.extract ?? extractEmbedded)(item.video_path, [from, ...deps.sourceLanguages.filter((l) => l !== from)]);
    return {
      parsed: cleanStyled(parseSrt(got.srt)).parsed,
      from: `the ${got.lang} subtitle inside the video (track ${got.stream.index}, ${got.stream.codec})`,
    };
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
  let source: { parsed: Parsed; from: string } | null = null;
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
  const s = source as { parsed: Parsed; from: string } | null;
  const t = target as Parsed | null;
  return { rows: pairUp(s?.parsed.cues ?? null, t?.cues ?? null), sourceFrom: s?.from ?? null, sourceProblem, targetProblem };
}

// A subtitle as a file to download: the Arabic, or the original (written out
// as SRT when it came from inside the video). The name is the video's.
export async function fileFor(item: Item, which: 'arabic' | 'original', deps: SubtitleDeps): Promise<{ name: string; body: string }> {
  const base = path.basename(item.video_path).replace(/\.[^.]+$/, '');
  if (which === 'arabic') {
    const p = machinePath(item, deps);
    if (!p) throw new Error('subfill has written no Arabic for this item');
    return { name: path.basename(p), body: decode(await readFile(p)) };
  }
  const { parsed } = await loadSource(item, deps);
  return { name: `${base}.${item.source_lang ?? 'en'}.srt`, body: serializeSrt(parsed) };
}
