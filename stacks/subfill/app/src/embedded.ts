// Subtitles stored inside the video file. Most of the library's "nothing to
// translate from" episodes carry an English track in the .mkv or .mp4 itself;
// Bazarr lists it (with no path) but never writes it out. ffprobe finds the
// best text track and ffmpeg writes it out as SRT, into memory only: nothing
// is saved beside the video.
//
// Only text tracks can be read: SubRip, ASS/SSA (ffmpeg drops the styling),
// MP4 text and WebVTT. Blu-ray and DVD tracks are pictures of text; an item
// whose only track is one of those is given up with that reason, not retried.
import { execFile } from 'node:child_process';
import { Unavailable } from './errors.ts';

export const TEXT_CODECS = ['subrip', 'mov_text', 'ass', 'ssa', 'webvtt', 'text'] as const;

// The language tags a track may carry, by subfill's two-letter code.
const TAGS: Record<string, string[]> = {
  en: ['en', 'eng'],
  fr: ['fr', 'fre', 'fra'],
  es: ['es', 'spa'],
  de: ['de', 'ger', 'deu'],
  it: ['it', 'ita'],
  pt: ['pt', 'por'],
  tr: ['tr', 'tur'],
  ru: ['ru', 'rus'],
  ja: ['ja', 'jpn'],
  ko: ['ko', 'kor'],
  zh: ['zh', 'chi', 'zho'],
};

export type Stream = { index: number; codec: string; language: string; title: string; forced: boolean; hi: boolean };

// The video has a track in a source language, but none of them is text.
export class NoTextTrack extends Error {}

type RawStream = {
  index?: number;
  codec_name?: string;
  tags?: { language?: string; title?: string };
  disposition?: { forced?: number; hearing_impaired?: number };
};

export function parseProbe(json: string): Stream[] {
  const body = JSON.parse(json) as { streams?: RawStream[] };
  return (body.streams ?? []).map((s) => {
    const title = String(s.tags?.title ?? '');
    return {
      index: Number(s.index),
      codec: String(s.codec_name ?? ''),
      language: String(s.tags?.language ?? '').toLowerCase(),
      title,
      // A "Signs & Songs" or "Forced" track holds only the foreign lines.
      forced: s.disposition?.forced === 1 || /forced|signs/i.test(title),
      hi: s.disposition?.hearing_impaired === 1 || /\b(sdh|cc|hi)\b/i.test(title),
    };
  });
}

// The track to translate from: the first source language that has a full
// text track, plain before hearing-impaired, SubRip before styled formats.
// null when no track is in a source language at all; NoTextTrack when one
// is, but only as pictures.
export function pickStream(streams: Stream[], languages: string[]): { stream: Stream; lang: string } | null {
  let pictureOnly = false;
  for (const lang of languages) {
    const tags = TAGS[lang] ?? [lang];
    const full = streams.filter((s) => tags.includes(s.language) && !s.forced);
    const text = full
      .filter((s) => (TEXT_CODECS as readonly string[]).includes(s.codec))
      .sort((a, b) => Number(a.hi) - Number(b.hi) || TEXT_CODECS.indexOf(a.codec as never) - TEXT_CODECS.indexOf(b.codec as never));
    if (text.length) return { stream: text[0], lang };
    if (full.length) pictureOnly = true;
  }
  if (pictureOnly) throw new NoTextTrack('the subtitle inside the video is a picture of text, which cannot be translated');
  return null;
}

export type Run = (cmd: string, args: string[], opts: { timeoutMs: number; maxBytes: number }) => Promise<string>;

export const runFile: Run = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeoutMs, maxBuffer: opts.maxBytes, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      // Missing ffmpeg is the machine's trouble, not the item's.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Unavailable(`${cmd} is not installed in the container`));
      reject(new Error(`${cmd} failed: ${(stderr || err.message).trim().split('\n').slice(-2).join(' ')}`));
    });
  });

// Reading a track means reading the whole file, which on the USB disk can
// take a minute or more for a large film.
const TIMEOUT_MS = 10 * 60_000;

// The best text track inside `video` in one of `languages`, as SRT text.
export async function extractEmbedded(
  video: string,
  languages: string[],
  run: Run = runFile,
): Promise<{ srt: string; lang: string; stream: Stream }> {
  const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 's', '-show_entries', 'stream=index,codec_name:stream_tags=language,title:stream_disposition=forced,hearing_impaired', '-of', 'json', video], {
    timeoutMs: 60_000,
    maxBytes: 4 << 20,
  });
  const picked = pickStream(parseProbe(probe), languages);
  if (!picked) throw new NoTextTrack(`the video has no ${languages.join(' or ')} subtitle inside it`);
  const srt = await run('ffmpeg', ['-v', 'error', '-nostdin', '-i', video, '-map', `0:${picked.stream.index}`, '-f', 'srt', '-'], {
    timeoutMs: TIMEOUT_MS,
    maxBytes: 32 << 20,
  });
  return { srt, ...picked };
}
