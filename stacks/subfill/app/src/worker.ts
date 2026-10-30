// What subfill does: follow Bazarr's wanted lists, translate what Bazarr
// could not find, and clean up after itself.
//
// The file it writes is <video>.<lang>.machine.srt. Jellyfin reads that as an
// Arabic track titled "machine". Bazarr's scanner skips it, because only
// <video>.<lang>.srt matches its strict file-name rule, so Arabic stays
// "missing" there and Bazarr goes on searching for a human subtitle. When one
// arrives, the next sync sees Arabic is no longer missing and deletes ours.
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Bazarr, Media, Wanted } from './bazarr.ts';
import { checkAligned, parseSrt, rebuild, segmentsOf, serializeSrt } from './srt.ts';
import type { Item, State, Store } from './store.ts';
import { languageOf, translateAll, type Generate, type Language } from './translate.ts';

export const MARKER = 'machine';

export type Config = {
  target: Language;
  sourceLanguages: string[];
  waitMs: number;
  batchSize: number;
  maxAttempts: number;
  retryDelayMs: number;
  mediaRoot: string;
};

export type Current = { key: string; title: string; done: number; total: number; startedAt: number };

// States the sync leaves alone: in progress, settled by the owner, or ours on disk.
const HANDS_OFF: State[] = ['translating', 'failed', 'skipped', 'done'];
// States whose row is dropped once Bazarr no longer wants Arabic for the item.
const DROP_WHEN_FOUND: State[] = ['waiting', 'eligible', 'no_source', 'failed', 'skipped'];

export function outPathFor(video: string, target: Language): string {
  const ext = path.extname(video);
  return `${video.slice(0, video.length - ext.length)}.${target.code}.${MARKER}.srt`;
}

export class Worker {
  current: Current | null = null;
  private readonly store: Store;
  private readonly bazarr: Bazarr;
  private readonly generate: Generate;
  private readonly cfg: Config;
  private readonly now: () => number;

  constructor(opts: { store: Store; bazarr: Bazarr; generate: Generate; config: Config; now?: () => number }) {
    this.store = opts.store;
    this.bazarr = opts.bazarr;
    this.generate = opts.generate;
    this.cfg = opts.config;
    this.now = opts.now ?? Date.now;
  }

  private inMedia(p: string): boolean {
    const root = path.resolve(this.cfg.mediaRoot);
    const full = path.resolve(p);
    return full === root || full.startsWith(root + path.sep);
  }

  // Deletes a subtitle only when it is the one this item recorded writing,
  // carries our marker, and lies inside the media folder.
  private async deleteOurs(item: Item): Promise<void> {
    const p = item.out_path;
    if (!p || !p.endsWith(`.${this.cfg.target.code}.${MARKER}.srt`) || !this.inMedia(p)) return;
    try {
      await unlink(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  }

  private async pickSource(media: Media): Promise<{ path: string; lang: string } | null> {
    for (const lang of this.cfg.sourceLanguages) {
      const candidates = media.subtitles
        .filter((s) => s.code2 === lang && s.path && !s.forced && s.path.toLowerCase().endsWith('.srt'))
        .sort((a, b) => Number(a.hi) - Number(b.hi));
      for (const c of candidates) {
        if (c.path && this.inMedia(c.path) && (await this.exists(c.path))) return { path: c.path, lang };
      }
    }
    return null;
  }

  // One pass over Bazarr's wanted lists. Throws when Bazarr cannot be read,
  // and in that case changes nothing: a failed read is never taken as "nothing
  // is wanted any more".
  async sync(): Promise<{ wanted: number; tracked: number }> {
    const target = this.cfg.target.code;
    const wanted = (await this.bazarr.wanted()).filter((w) => w.missing.includes(target));
    const wantedKeys = new Map<string, Wanted>(wanted.map((w) => [w.key, w]));
    const tracked = this.store.all();
    const done = tracked.filter((r) => r.state === 'done');
    const details = await this.bazarr.details([...wanted, ...done.map((r) => ({ kind: r.kind, id: r.bazarr_id }))]);

    for (const row of done) {
      const media = details.get(row.key);
      if (media && !media.missing.includes(target)) {
        await this.deleteOurs(row);
        this.store.move(row.key, ['done'], 'replaced', { note: 'Bazarr found an Arabic subtitle; ours was deleted' });
        this.store.log(row.key, 'Bazarr now has Arabic, deleted the machine translation');
      } else if (media && media.path !== row.video_path) {
        await this.deleteOurs(row);
        this.store.move(row.key, ['done'], 'gone', { note: 'the video was replaced; it will be looked at again' });
        this.store.log(row.key, `video replaced by ${path.basename(media.path)}, deleted the old machine translation`);
      } else if (!(await this.exists(row.video_path))) {
        await this.deleteOurs(row);
        this.store.move(row.key, ['done'], 'gone', { note: 'the video is no longer there' });
        this.store.log(row.key, 'video removed, deleted the machine translation');
      }
    }

    for (const w of wanted) {
      const media = details.get(w.key);
      if (!media) continue;
      const row = this.store.get(w.key);
      if (row && HANDS_OFF.includes(row.state)) continue;
      const source = await this.pickSource(media);
      let eligibleAt = this.now() + this.cfg.waitMs;
      let note: string | null = null;
      try {
        // ctime, not mtime: moving or hard-linking the file into the library
        // sets it, so it is when the video arrived, whatever date the release
        // itself carries.
        eligibleAt = (await stat(media.path)).ctimeMs + this.cfg.waitMs;
      } catch {
        note = 'video file not found';
      }
      const state: State = !source || note ? 'no_source' : eligibleAt <= this.now() ? 'eligible' : 'waiting';
      note ??= source ? null : 'no external subtitle to translate from';
      const fields = {
        title: w.title,
        video_path: media.path,
        source_path: source?.path ?? null,
        source_lang: source?.lang ?? null,
        // An eligible row keeps its time: "translate now" and the retry delay set it.
        eligible_at: row?.state === 'eligible' ? row.eligible_at : eligibleAt,
        note,
      };
      if (!row) {
        this.store.insert({ key: w.key, kind: w.kind, bazarr_id: w.id, out_path: null, state, ...fields });
        this.store.log(w.key, `Arabic missing in Bazarr; ${state.replace('_', ' ')}`);
      } else {
        const next: State = row.state === 'eligible' && state === 'waiting' ? 'eligible' : state;
        if (next !== row.state) this.store.log(w.key, `now ${next.replace('_', ' ')}`);
        this.store.update(w.key, { ...fields, state: next });
      }
    }

    for (const row of this.store.all()) {
      if (DROP_WHEN_FOUND.includes(row.state) && !wantedKeys.has(row.key)) this.store.remove(row.key);
    }
    return { wanted: wanted.length, tracked: this.store.all().length };
  }

  // Translates the next eligible item, if any. Returns false when there was none.
  async translateNext(): Promise<boolean> {
    const item = this.store.next(this.now());
    if (!item) return false;
    if (!this.store.move(item.key, ['eligible'], 'translating', { started_at: this.now(), attempts: item.attempts + 1, note: null })) {
      return true;
    }
    this.store.log(item.key, `translating from ${item.source_lang} (attempt ${item.attempts + 1})`);
    const part = `${outPathFor(item.video_path, this.cfg.target)}.part`;
    try {
      await this.translate({ ...item, attempts: item.attempts + 1 });
    } catch (err) {
      await unlink(part).catch(() => undefined);
      const message = (err as Error).message;
      const attempts = item.attempts + 1;
      const final = attempts >= this.cfg.maxAttempts;
      this.store.move(item.key, ['translating'], final ? 'failed' : 'eligible', {
        note: message,
        eligible_at: this.now() + this.cfg.retryDelayMs,
      });
      this.store.log(item.key, `${final ? 'failed, giving up' : 'failed, will try again'}: ${message}`);
    } finally {
      this.current = null;
    }
    return true;
  }

  private async translate(item: Item): Promise<void> {
    const target = this.cfg.target;
    // Bazarr may have found Arabic since the last sync; never translate over that.
    const media = (await this.bazarr.details([{ kind: item.kind, id: item.bazarr_id }])).get(item.key);
    const out = outPathFor(item.video_path, target);
    const human = `${out.slice(0, out.length - `.${MARKER}.srt`.length)}.srt`;
    if (!media || !media.missing.includes(target.code) || (await this.exists(human))) {
      this.store.remove(item.key);
      return;
    }
    if (!item.source_path || !this.inMedia(item.source_path) || !this.inMedia(out)) {
      throw new Error('the subtitle or video is outside the media folder');
    }
    if ((await this.exists(out)) && item.out_path !== out) {
      throw new Error(`${path.basename(out)} already exists and subfill did not write it`);
    }

    const source = parseSrt(decode(await readFile(item.source_path)));
    if (!source.cues.length) throw new Error('the source subtitle has no cues');
    const segments = segmentsOf(source.cues);
    this.current = { key: item.key, title: item.title, done: 0, total: segments.length, startedAt: this.now() };
    const translations = await translateAll(
      segments.map((s) => s.body),
      this.generate,
      {
        from: languageOf(item.source_lang ?? 'en'),
        to: target,
        batchSize: this.cfg.batchSize,
        onProgress: (done, total) => {
          if (this.current) this.current = { ...this.current, done, total };
        },
      },
    );
    const result = rebuild(source, segments, translations);
    const problem = checkAligned(source, result);
    if (problem) throw new Error(problem);

    // Record the path before writing, so a crash after the rename still lets
    // the retry overwrite (and a later cleanup delete) the file it left.
    this.store.update(item.key, { out_path: out });
    const part = `${out}.part`;
    await writeFile(part, serializeSrt(result), 'utf8');
    await rename(part, out);
    const minutes = Math.round((this.now() - (this.current?.startedAt ?? this.now())) / 60_000);
    this.store.move(item.key, ['translating'], 'done', {
      finished_at: this.now(),
      note: `${source.cues.length} cues in ${minutes} min`,
    });
    this.store.log(item.key, `wrote ${path.basename(out)} (${source.cues.length} cues, ${minutes} min)`);
  }

  // Owner actions from the page.
  act(key: string, op: string): string | null {
    const item = this.store.get(key);
    if (!item) return 'no such item';
    const ok = (() => {
      switch (op) {
        case 'now':
          return this.store.move(key, ['waiting', 'eligible'], 'eligible', { priority: 1, eligible_at: this.now() });
        case 'retry':
          return this.store.move(key, ['failed'], 'eligible', { attempts: 0, eligible_at: this.now(), note: null });
        case 'skip':
          return this.store.move(key, ['waiting', 'eligible', 'failed', 'no_source'], 'skipped', { note: 'skipped by you' });
        case 'unskip':
          return this.store.move(key, ['skipped'], 'waiting', { note: null, eligible_at: this.now() });
        default:
          return false;
      }
    })();
    if (!ok) return `cannot ${op} an item that is ${item.state.replace('_', ' ')}`;
    this.store.log(key, `you chose: ${op}`);
    return null;
  }
}

// Bazarr stores subtitles as UTF-8, but an older file may be Windows-1252.
export function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
