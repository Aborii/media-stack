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
import { seriesKey, type Bazarr, type Media, type Wanted } from './bazarr.ts';
import { extractEmbedded, INSIDE_REASON, NoTextTrack, type InsideReason } from './embedded.ts';
import { Unavailable } from './errors.ts';
import { OllamaCrash } from './ollama.ts';
import { checkAligned, cleanStyled, markRtl, parseSrt, rebuild, segmentsOf, serializeSrt } from './srt.ts';
import { EXCLUDED_NOTE, type Item, type State, type Store } from './store.ts';
import { languageOf, translateAll, type Generate, type Language } from './translate.ts';

export const MARKER = 'machine';

// Crashes of the model on one episode before it is given up on.
export const MAX_CRASHES = 5;

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

// A machine that translates: its name, its model call, and whether it may
// take an item held for the PC.
export type NodeRef = { name: string; generate: Generate; takesHeld: boolean };

// States the sync leaves alone: in progress, settled by the owner, or ours on disk.
const HANDS_OFF: State[] = ['translating', 'failed', 'skipped', 'done'];
// States whose row is dropped once Bazarr no longer wants Arabic for the item.
const DROP_WHEN_FOUND: State[] = ['waiting', 'eligible', 'no_source', 'failed', 'skipped'];

// inside_track for a look inside that found nothing: why, and the file's
// change time, so a new file at the same path is looked at again.
export function emptyInside(reason: InsideReason, ctime: number): string {
  return `none:${reason}:${ctime}`;
}

// The reason a look inside this file (by its change time; null when the
// video path changed) found nothing, or null if it has not looked.
export function lookedInside(insideTrack: string | null, ctime: number | null): InsideReason | null {
  const m = insideTrack?.match(/^none:(pictures|missing):(\d+)$/);
  return m && ctime !== null && Number(m[2]) === ctime ? (m[1] as InsideReason) : null;
}

export function outPathFor(video: string, target: Language): string {
  const ext = path.extname(video);
  return `${video.slice(0, video.length - ext.length)}.${target.code}.${MARKER}.srt`;
}

export class Worker {
  // What each node is translating right now, by node name.
  private readonly working = new Map<string, Current>();
  private readonly store: Store;
  private readonly bazarr: Bazarr;
  private readonly generate: Generate;
  private readonly extract: typeof extractEmbedded;
  private readonly cfg: Config;
  private readonly now: () => number;

  constructor(opts: { store: Store; bazarr: Bazarr; generate: Generate; config: Config; now?: () => number; extract?: typeof extractEmbedded }) {
    this.store = opts.store;
    this.bazarr = opts.bazarr;
    this.generate = opts.generate;
    this.extract = opts.extract ?? extractEmbedded;
    this.cfg = opts.config;
    this.now = opts.now ?? Date.now;
  }

  // The mini, as the worker was built: the node used when none is named.
  get mini(): NodeRef {
    return { name: 'mini', generate: this.generate, takesHeld: false };
  }

  currentOf(node: string): Current | null {
    return this.working.get(node) ?? null;
  }

  // Keeps the next item for the PC for that many minutes, or moves the hold.
  holdForPc(minutes: number): Item | undefined {
    const held = this.store.hold(this.now(), this.now() + minutes * 60_000);
    if (held) this.store.log(held.key, `held for the PC for ${minutes} min`);
    return held;
  }

  releaseHolds(): void {
    this.store.releaseHolds();
  }

  // The owner chose ▶️ Wake PC: for that long, the PC node may hold a lease
  // once it comes up (see nodes.ts for why only then).
  markPcWoken(minutes: number): void {
    this.store.setMeta('pc_woken_until', String(this.now() + minutes * 60_000));
  }

  pcWoken(): boolean {
    return Number(this.store.getMeta('pc_woken_until') ?? 0) > this.now();
  }

  clearPcWoken(): void {
    this.store.deleteMeta('pc_woken_until');
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

  // A subtitle file beside the video first. Failing that, a track inside the
  // video that Bazarr lists, unless a look inside this same file (same path
  // and change time) already found nothing readable.
  private async pickSource(media: Media, seenEmpty: InsideReason | null): Promise<{ path: string | null; lang: string; inside: boolean } | null> {
    for (const lang of this.cfg.sourceLanguages) {
      const candidates = media.subtitles
        .filter((s) => s.code2 === lang && s.path && !s.forced && s.path.toLowerCase().endsWith('.srt'))
        .sort((a, b) => Number(a.hi) - Number(b.hi));
      for (const c of candidates) {
        if (c.path && this.inMedia(c.path) && (await this.exists(c.path))) return { path: c.path, lang, inside: false };
      }
    }
    if (seenEmpty) return null;
    for (const lang of this.cfg.sourceLanguages) {
      if (media.subtitles.some((s) => s.code2 === lang && !s.path && !s.forced)) return { path: null, lang, inside: true };
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
      // One row that cannot be cleaned up (a read-only folder) is logged on
      // that row and skipped, so it never stops the rest of the sync.
      try {
        await this.settleDone(row, details.get(row.key));
      } catch (err) {
        this.store.update(row.key, { note: `could not clean up: ${(err as Error).message}` });
        this.store.log(row.key, `could not clean up: ${(err as Error).message}`);
      }
    }

    for (const w of wanted) {
      const media = details.get(w.key);
      if (!media) continue;
      const row = this.store.get(w.key);
      const markKey = w.seriesId !== null ? seriesKey(w.seriesId) : w.key;
      // Hands off, except for what a mark should change: a row its lifted mark
      // left set aside comes back, and a marked row that failed is set aside.
      // A row still under its mark is left as it is, so it does not churn.
      if (
        row &&
        HANDS_OFF.includes(row.state) &&
        !(row.state === 'skipped' && row.note === EXCLUDED_NOTE && !this.store.isExcluded(markKey)) &&
        !(row.state === 'failed' && this.store.isExcluded(markKey))
      ) {
        continue;
      }
      let ctime: number | null = null;
      try {
        // ctime, not mtime: moving or hard-linking the file into the library
        // sets it, so it is when the video arrived, whatever date the release
        // itself carries. A new file at the same path changes it too.
        ctime = Math.floor((await stat(media.path)).ctimeMs);
      } catch {
        // Left null: no_source below, "video file not found".
      }
      const seenEmpty = row && ctime !== null ? lookedInside(row.inside_track, media.path === row.video_path ? ctime : null) : null;
      // No video, nothing to take a source from.
      const source = ctime === null ? null : await this.pickSource(media, seenEmpty);
      const eligibleAt = (ctime ?? this.now()) + this.cfg.waitMs;
      let note: string | null = ctime === null ? 'video file not found' : null;
      let state: State = !source || note ? 'no_source' : eligibleAt <= this.now() ? 'eligible' : 'waiting';
      note ??= source ? null : seenEmpty ? INSIDE_REASON[seenEmpty] : 'no subtitle beside the video or inside it to translate from';
      // A show or film the owner marked not to translate: set aside, new
      // episodes included, until the mark is lifted. Read now, after the
      // awaits above, so a mark set or lifted while this sync waited counts.
      if (this.store.isExcluded(markKey)) {
        state = 'skipped';
        note = EXCLUDED_NOTE;
      }
      const fields = {
        title: w.title,
        video_path: media.path,
        source_path: source?.path ?? null,
        source_lang: source?.lang ?? null,
        // Kept while the file is the same, and through a sync that cannot see
        // it at all: a look inside that found nothing stays found.
        inside_track: source?.inside ? 'yes' : seenEmpty || ctime === null ? (row?.inside_track ?? null) : null,
        // An eligible row keeps its time: "translate now" and the retry delay set it.
        eligible_at: row?.state === 'eligible' ? row.eligible_at : eligibleAt,
        note,
        series_id: w.seriesId,
      };
      if (!row) {
        this.store.insert({ key: w.key, kind: w.kind, bazarr_id: w.id, out_path: null, state, ...fields });
        this.store.log(w.key, `Arabic missing in Bazarr; ${state.replace('_', ' ')}`);
      } else {
        const next: State = row.state === 'eligible' && state === 'waiting' ? 'eligible' : state;
        // Only if the row is still as read: the worker may have claimed it, or
        // the owner skipped it, while this sync was looking at the disk.
        if (this.store.move(w.key, [row.state], next, fields) && next !== row.state) {
          this.store.log(w.key, `now ${next.replace('_', ' ')}`);
        }
      }
    }

    for (const row of this.store.all()) {
      if (DROP_WHEN_FOUND.includes(row.state) && !wantedKeys.has(row.key)) await this.drop(row);
    }
    return { wanted: wanted.length, tracked: this.store.all().length };
  }

  // A row whose machine subtitle is in use: is it still needed?
  private async settleDone(row: Item, media: Media | undefined): Promise<void> {
    const target = this.cfg.target.code;
    if (media && !media.missing.includes(target)) {
      await this.deleteOurs(row);
      const human = media.subtitles.some((s) => s.code2 === target && !s.forced && s.path !== row.out_path);
      const note = human ? 'Bazarr found an Arabic subtitle; ours was deleted' : 'Bazarr no longer wants Arabic for this; ours was deleted';
      this.store.move(row.key, ['done'], human ? 'replaced' : 'gone', { note });
      this.store.log(row.key, note);
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

  // Forgets an item, and the file of a translation that was cut off after
  // writing it, if there is one.
  private async drop(row: Item): Promise<void> {
    if (row.out_path && this.store.sharing(row.out_path, row.key).length === 0) await this.deleteOurs(row);
    this.store.remove(row.key);
  }

  // Translates the next eligible item, if any. Returns false when there was
  // none, or when Bazarr or Ollama is down, so the caller waits before trying.
  async translateNext(node: NodeRef = this.mini): Promise<boolean> {
    const item = this.store.next(this.now(), node.takesHeld);
    if (!item) return false;
    const claim = { started_at: this.now(), attempts: item.attempts + 1, note: null, node: node.name, held_until: null };
    if (!this.store.move(item.key, ['eligible'], 'translating', claim)) return true;
    this.store.log(item.key, `translating from ${item.source_lang} on the ${node.name} (attempt ${item.attempts + 1})`);
    const part = `${outPathFor(item.video_path, this.cfg.target)}.part`;
    try {
      await this.translate({ ...item, attempts: item.attempts + 1 }, node);
    } catch (err) {
      await unlink(part).catch(() => undefined);
      const message = (err as Error).message;
      if (err instanceof OllamaCrash) {
        // The runner died under it. Not an attempt; but an episode that keeps
        // doing it is the likelier cause by then, so it stops after MAX_CRASHES.
        const crashes = item.crashes + 1;
        const final = crashes >= MAX_CRASHES;
        this.store.move(item.key, ['translating'], final ? 'failed' : 'eligible', {
          attempts: item.attempts,
          crashes,
          note: final
            ? `the model crashed ${crashes} times on this episode; giving up`
            : `paused: the model crashed (${crashes} of ${MAX_CRASHES})`,
        });
        this.store.log(item.key, `${final ? 'model crashed again, giving up' : 'model crashed, will start again'}: ${message}`);
        return false;
      }
      if (err instanceof Unavailable) {
        // Not this item's fault: back in the queue as it was, attempt not counted.
        this.store.move(item.key, ['translating'], 'eligible', { attempts: item.attempts, note: `paused: ${message}` });
        this.store.log(item.key, `paused, will start again: ${message}`);
        return false;
      }
      const attempts = item.attempts + 1;
      const final = attempts >= this.cfg.maxAttempts;
      this.store.move(item.key, ['translating'], final ? 'failed' : 'eligible', {
        note: message,
        eligible_at: this.now() + this.cfg.retryDelayMs,
      });
      this.store.log(item.key, `${final ? 'failed, giving up' : 'failed, will try again'}: ${message}`);
    } finally {
      this.working.delete(node.name);
    }
    return true;
  }

  private async translate(item: Item, node: NodeRef): Promise<void> {
    const target = this.cfg.target;
    // Bazarr may have found Arabic since the last sync; never translate over that.
    const media = (await this.bazarr.details([{ kind: item.kind, id: item.bazarr_id }])).get(item.key);
    const out = outPathFor(item.video_path, target);
    const human = `${out.slice(0, out.length - `.${MARKER}.srt`.length)}.srt`;
    if (!media || !media.missing.includes(target.code) || (await this.exists(human))) {
      await this.drop(item);
      return;
    }
    const inside = !item.source_path && item.inside_track === 'yes';
    if (!(inside ? this.inMedia(item.video_path) : item.source_path && this.inMedia(item.source_path)) || !this.inMedia(out)) {
      throw new Error('the subtitle or video is outside the media folder');
    }
    // A file holding several episodes: the first one translated serves them all.
    const sibling = this.store.sharing(out, item.key).find((r) => r.state === 'done');
    if (sibling) {
      const note = `same video as ${sibling.title}, which has the machine subtitle`;
      this.store.move(item.key, ['translating'], 'done', { out_path: out, started_at: null, finished_at: this.now(), note });
      this.store.log(item.key, note);
      return;
    }
    if ((await this.exists(out)) && item.out_path !== out) {
      throw new Error(`${path.basename(out)} already exists and subfill did not write it`);
    }

    let from = item.source_lang ?? 'en';
    let text: string;
    if (inside) {
      // The item's language first, then the others it may translate from.
      const langs = [from, ...this.cfg.sourceLanguages.filter((l) => l !== from)];
      try {
        const got = await this.extract(item.video_path, langs);
        text = got.srt;
        from = got.lang;
        this.store.log(item.key, `read the ${got.lang} subtitle inside the video (track ${got.stream.index}, ${got.stream.codec}${got.stream.title ? `, "${got.stream.title}"` : ''})`);
      } catch (err) {
        if (!(err instanceof NoTextTrack)) throw err;
        // Nothing readable inside: not an attempt, and not offered again until
        // the file changes (or the owner skips and un-skips it).
        const ctime = Math.floor((await stat(item.video_path)).ctimeMs);
        this.store.move(item.key, ['translating'], 'no_source', { attempts: item.attempts - 1, inside_track: emptyInside(err.reason, ctime), note: err.message });
        this.store.log(item.key, err.message);
        return;
      }
    } else {
      text = decode(await readFile(item.source_path!));
    }
    let source = parseSrt(text);
    if (inside) {
      const { parsed, drawings, copies } = cleanStyled(source);
      source = parsed;
      if (drawings || copies) this.store.log(item.key, `left out ${copies} stacked copies of lines and ${drawings} drawings from the track`);
    }
    if (!source.cues.length) throw new Error('the source subtitle has no cues');
    const segments = segmentsOf(source.cues);
    const startedAt = this.now();
    this.working.set(node.name, { key: item.key, title: item.title, done: 0, total: segments.length, startedAt });
    const { texts: translations, kept } = await translateAll(
      segments.map((s) => s.body),
      node.generate,
      {
        from: languageOf(from),
        to: target,
        batchSize: this.cfg.batchSize,
        onProgress: (done, total) => {
          const now = this.working.get(node.name);
          if (now) this.working.set(node.name, { ...now, done, total });
        },
      },
    );
    const rebuilt = rebuild(source, segments, translations);
    const result = target.rtl ? markRtl(rebuilt) : rebuilt;
    const problem = checkAligned(source, result);
    if (problem) throw new Error(problem);

    // Record the path before writing, so a crash after the rename still lets
    // the retry overwrite (and a later cleanup delete) the file it left.
    this.store.update(item.key, { out_path: out });
    const part = `${out}.part`;
    await writeFile(part, serializeSrt(result), 'utf8');
    await rename(part, out);
    const minutes = Math.round((this.now() - startedAt) / 60_000);
    const untranslated = kept ? `, ${kept} left in ${languageOf(from).name}` : '';
    const note = `${source.cues.length} cues in ${minutes} min on the ${node.name}${untranslated}`;
    if (!this.store.move(item.key, ['translating'], 'done', { finished_at: this.now(), note, crashes: 0 })) {
      // The row changed under us, so nothing would ever clean this file up.
      await this.deleteOurs({ ...item, out_path: out });
      this.store.log(item.key, 'the item changed while it was being translated; the result was discarded');
      return;
    }
    this.store.log(item.key, `wrote ${path.basename(out)} (${note})`);
  }

  // The owner marks a show ("series:<id>") or film ("movie:<id>") not to
  // translate, or lifts the mark. `itemKeys` are its episodes, or the film.
  exclude(key: string, on: boolean, itemKeys: string[]): string | null {
    if (!/^(series|movie):\d+$/.test(key)) return 'not a show or film';
    if (on === this.store.isExcluded(key)) return on ? 'it is already marked not to translate' : 'it is not marked';
    const moved = this.store.setExcluded(key, on, itemKeys);
    const word = on ? 'you marked it not to translate' : 'you lifted the mark: translate it again';
    for (const k of itemKeys) if (this.store.get(k)) this.store.log(k, word);
    console.log(`${key}: ${word} (${moved} item(s) moved)`);
    return null;
  }

  // Owner actions from the page.
  act(key: string, op: string): string | null {
    const item = this.store.get(key);
    if (!item) return 'no such item';
    if (['now', 'retry', 'unskip'].includes(op) && this.store.isItemMarked(key)) {
      return 'its show or film is marked not to translate; lift the mark first';
    }
    const ok = (() => {
      switch (op) {
        case 'now':
          return this.store.move(key, ['waiting', 'eligible'], 'eligible', { priority: 1, eligible_at: this.now() });
        case 'retry':
          return this.store.move(key, ['failed'], 'eligible', { attempts: 0, crashes: 0, eligible_at: this.now(), note: null });
        case 'skip':
          return this.store.move(key, ['waiting', 'eligible', 'failed', 'no_source'], 'skipped', { note: 'skipped by you' });
        case 'unskip':
          // Also forgets a look inside that found nothing, so it is looked at again.
          return this.store.move(key, ['skipped'], 'waiting', { note: null, crashes: 0, eligible_at: this.now(), inside_track: null });
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
