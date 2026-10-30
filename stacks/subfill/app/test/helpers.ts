// Shared fakes for the tests: a Bazarr that answers from an in-memory list,
// an Ollama that answers in Arabic, and a temp media folder.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export type FakeMedia = {
  kind: 'episode' | 'movie';
  id: number;
  title: string;
  path: string;
  subtitles: { code2: string; path: string | null; forced?: boolean; hi?: boolean }[];
  missing: string[];
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function fakeBazarr(items: FakeMedia[], opts: { fail?: () => boolean; calls?: string[] } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    opts.calls?.push(url.pathname + url.search);
    if (opts.fail?.()) throw new Error('connect ECONNREFUSED');
    if ((init?.headers as Record<string, string>)?.['X-API-KEY'] !== 'key') return json({ message: 'unauthorized' }, 401);
    const missing = (m: FakeMedia) => m.missing.map((code2) => ({ code2 }));
    const subs = (m: FakeMedia) => m.subtitles.map((s) => ({ forced: false, hi: false, ...s }));
    if (url.pathname === '/api/episodes/wanted') {
      const data = items
        .filter((m) => m.kind === 'episode' && m.missing.length)
        .map((m) => ({ sonarrEpisodeId: m.id, seriesTitle: m.title, episode_number: '1x01', episodeTitle: 'Pilot', missing_subtitles: missing(m) }));
      return json({ data, total: data.length });
    }
    if (url.pathname === '/api/movies/wanted') {
      const data = items.filter((m) => m.kind === 'movie' && m.missing.length).map((m) => ({ radarrId: m.id, title: m.title, missing_subtitles: missing(m) }));
      return json({ data, total: data.length });
    }
    if (url.pathname === '/api/episodes') {
      const ids = url.searchParams.getAll('episodeid[]').map(Number);
      const data = items
        .filter((m) => m.kind === 'episode' && ids.includes(m.id))
        .map((m) => ({ sonarrEpisodeId: m.id, path: m.path, subtitles: subs(m), missing_subtitles: missing(m) }));
      return json({ data });
    }
    if (url.pathname === '/api/movies') {
      const ids = url.searchParams.getAll('radarrid[]').map(Number);
      const data = items
        .filter((m) => m.kind === 'movie' && ids.includes(m.id))
        .map((m) => ({ radarrId: m.id, path: m.path, subtitles: subs(m), missing_subtitles: missing(m) }));
      return json({ data });
    }
    return json({ message: 'not found' }, 404);
  }) as typeof fetch;
}

// Answers every numbered line with Arabic.
export async function arabicModel(prompt: string): Promise<string> {
  const text = prompt.split('\n\n\n')[1];
  return text
    .split('\n')
    .map((l) => l.replace(/^(\d+)\. (.*)$/, '$1. ترجمة $2'))
    .join('\n');
}

export function mediaDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'subfill-'));
}

export const SRT = '1\r\n00:00:01,000 --> 00:00:02,000\r\nHello there.\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,500\r\n- Who is it?\r\n- Me.\r\n';

// A video with an English subtitle beside it, as Sonarr and Bazarr leave them.
export function episodeOnDisk(root: string, name: string, srt: string | null = SRT): { video: string; en: string } {
  const dir = path.join(root, 'tv', name);
  mkdirSync(dir, { recursive: true });
  const video = path.join(dir, `${name} - S01E01.mkv`);
  writeFileSync(video, 'video');
  const en = path.join(dir, `${name} - S01E01.en.srt`);
  if (srt !== null) writeFileSync(en, srt);
  return { video, en };
}
