// Bazarr's API, read only. subfill never asks Bazarr to download, upload or
// rescan anything: Bazarr ignores the files subfill writes (see the compose
// header for why), so it keeps searching for a human subtitle on its own.
import { Unavailable } from './errors.ts';

export type Subtitle = {
  code2: string;
  path: string | null;
  forced: boolean;
  hi: boolean;
};

// One episode or film, as subfill needs it.
export type Media = {
  key: string;
  kind: 'episode' | 'movie';
  id: number;
  path: string;
  subtitles: Subtitle[];
  missing: string[];
};

export type Series = { id: number; title: string; year: string | null; path: string; ended: boolean };

// An episode or film in the library, wanted or not.
export type LibraryEntry = {
  key: string;
  kind: 'episode' | 'movie';
  id: number;
  seriesId: number | null;
  season: number | null;
  episode: number | null;
  title: string;
  path: string;
  subtitles: Subtitle[];
  missing: string[];
};

export type Library = { series: Series[]; entries: LibraryEntry[] };

// seriesId is the show an episode belongs to; null for a film.
export type Wanted = { key: string; kind: 'episode' | 'movie'; id: number; seriesId: number | null; title: string; missing: string[] };

type RawSubtitle = { code2?: string; path?: string | null; forced?: boolean; hi?: boolean };
type RawMissing = { code2?: string; forced?: boolean };

export const episodeKey = (id: number) => `episode:${id}`;
export const movieKey = (id: number) => `movie:${id}`;
export const seriesKey = (id: number) => `series:${id}`;

// Any failure to read Bazarr, a wrong key included, is Bazarr's problem and
// not the item's.
export class BazarrError extends Unavailable {}

export class Bazarr {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: { url: string; apiKey: string; fetcher?: typeof fetch; timeoutMs?: number }) {
    this.base = opts.url.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetcher = opts.fetcher ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  private async get(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetcher(`${this.base}/api${path}`, {
        headers: { 'X-API-KEY': this.apiKey, accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new BazarrError(`Bazarr unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) throw new BazarrError(`Bazarr answered ${res.status} for ${path.split('?')[0]}`);
    return res.json();
  }

  private async data(path: string): Promise<Record<string, unknown>[]> {
    const body = (await this.get(path)) as { data?: unknown };
    if (!Array.isArray(body.data)) throw new BazarrError(`Bazarr sent no list for ${path.split('?')[0]}`);
    return body.data as Record<string, unknown>[];
  }

  async wanted(): Promise<Wanted[]> {
    const [episodes, movies] = await Promise.all([
      this.data('/episodes/wanted?start=0&length=-1'),
      this.data('/movies/wanted?start=0&length=-1'),
    ]);
    const out: Wanted[] = [];
    for (const e of episodes) {
      const id = Number(e.sonarrEpisodeId);
      const title = `${e.seriesTitle} ${e.episode_number} ${e.episodeTitle ?? ''}`.trim();
      const seriesId = Number(e.sonarrSeriesId);
      out.push({ key: episodeKey(id), kind: 'episode', id, seriesId: Number.isFinite(seriesId) ? seriesId : null, title, missing: codes(e.missing_subtitles) });
    }
    for (const m of movies) {
      const id = Number(m.radarrId);
      out.push({ key: movieKey(id), kind: 'movie', id, seriesId: null, title: String(m.title), missing: codes(m.missing_subtitles) });
    }
    return out;
  }

  // The whole library, for the page's shows and films: every series, every
  // episode with a file, every film, each with the subtitles Bazarr knows of.
  // Episodes come a chunk of series per call, which keeps each answer to a
  // few MB. Any failed read throws, so a half-read library is never kept.
  async library(): Promise<Library> {
    const series = (await this.data('/series?start=0&length=-1')).map(
      (s): Series => ({
        id: Number(s.sonarrSeriesId),
        title: String(s.title ?? ''),
        year: s.year ? String(s.year) : null,
        path: String(s.path ?? ''),
        ended: Boolean(s.ended),
      }),
    );
    const entries: LibraryEntry[] = [];
    const ids = series.map((s) => s.id);
    for (let i = 0; i < ids.length; i += 50) {
      const query = ids
        .slice(i, i + 50)
        .map((id) => `seriesid%5B%5D=${id}`)
        .join('&');
      for (const e of await this.data(`/episodes?${query}`)) {
        const id = Number(e.sonarrEpisodeId);
        entries.push({
          key: episodeKey(id),
          kind: 'episode',
          id,
          seriesId: Number(e.sonarrSeriesId),
          season: Number(e.season ?? 0),
          episode: Number(e.episode ?? 0),
          title: String(e.title ?? ''),
          path: String(e.path ?? ''),
          subtitles: subtitles(e.subtitles),
          missing: codes(e.missing_subtitles),
        });
      }
    }
    for (const m of await this.data('/movies?start=0&length=-1')) {
      const id = Number(m.radarrId);
      entries.push({
        key: movieKey(id),
        kind: 'movie',
        id,
        seriesId: null,
        season: null,
        episode: null,
        title: m.year ? `${m.title} (${m.year})` : String(m.title ?? ''),
        path: String(m.path ?? ''),
        subtitles: subtitles(m.subtitles),
        missing: codes(m.missing_subtitles),
      });
    }
    return { series, entries };
  }

  // Details for many items, a chunk of ids per call so the query string stays short.
  async details(items: { kind: 'episode' | 'movie'; id: number }[]): Promise<Map<string, Media>> {
    const out = new Map<string, Media>();
    for (const kind of ['episode', 'movie'] as const) {
      const ids = items.filter((i) => i.kind === kind).map((i) => i.id);
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const param = kind === 'episode' ? 'episodeid' : 'radarrid';
        const query = chunk.map((id) => `${param}%5B%5D=${id}`).join('&');
        const rows = await this.data(`/${kind === 'episode' ? 'episodes' : 'movies'}?${query}`);
        for (const r of rows) {
          const id = Number(kind === 'episode' ? r.sonarrEpisodeId : r.radarrId);
          const key = kind === 'episode' ? episodeKey(id) : movieKey(id);
          out.set(key, {
            key,
            kind,
            id,
            path: String(r.path ?? ''),
            subtitles: subtitles(r.subtitles),
            missing: codes(r.missing_subtitles),
          });
        }
      }
    }
    return out;
  }
}

// The languages missing a full subtitle. A missing forced one (signs and
// foreign lines only) is not what subfill makes, so it does not count.
function codes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawMissing[])
    .filter((m) => !m.forced)
    .map((m) => String(m.code2 ?? ''))
    .filter(Boolean);
}

function subtitles(raw: unknown): Subtitle[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawSubtitle[]).map((s) => ({
    code2: String(s.code2 ?? ''),
    path: s.path ?? null,
    forced: Boolean(s.forced),
    hi: Boolean(s.hi),
  }));
}
