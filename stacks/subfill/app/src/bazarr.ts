// Bazarr's API, read only. subfill never asks Bazarr to download, upload or
// rescan anything: Bazarr ignores the files subfill writes (see the compose
// header for why), so it keeps searching for a human subtitle on its own.

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

export type Wanted = { key: string; kind: 'episode' | 'movie'; id: number; title: string; missing: string[] };

type RawSubtitle = { code2?: string; path?: string | null; forced?: boolean; hi?: boolean };
type RawMissing = { code2?: string };

export const episodeKey = (id: number) => `episode:${id}`;
export const movieKey = (id: number) => `movie:${id}`;

export class BazarrError extends Error {}

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
      out.push({ key: episodeKey(id), kind: 'episode', id, title, missing: codes(e.missing_subtitles) });
    }
    for (const m of movies) {
      const id = Number(m.radarrId);
      out.push({ key: movieKey(id), kind: 'movie', id, title: String(m.title), missing: codes(m.missing_subtitles) });
    }
    return out;
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

function codes(raw: unknown): string[] {
  return Array.isArray(raw) ? (raw as RawMissing[]).map((m) => String(m.code2 ?? '')).filter(Boolean) : [];
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
