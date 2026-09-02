#!/usr/bin/env python3
"""Bulk-download Themerr theme songs with yt-dlp, slowly enough to survive.

Why this exists rather than letting the plugin do it: Themerr fetches
through YoutubeExplode, which YouTube's bot checks reject outright
(VideoUnavailableException on videos that play fine in a browser). yt-dlp
gets through. The plugin has no cookie, proxy or rate-limit setting, so
there is nothing to tune inside it.

Two things worth knowing before changing this:

  * Themerr's "theme.mp3" is not an MP3. It writes YouTube's audio stream
    straight to disk, so the files are DASH m4a with an .mp3 name. This
    script does the same - verified byte-identical output on a test file -
    which is why no ffmpeg is needed anywhere.

  * The bottleneck is requests per IP, not per video. A burst of a thousand
    gets throttled; a slow drip does not. Hence the sleeps, which are the
    entire point of the script and should not be tuned down casually.

Resumable: state lives in the state file, and an existing theme.mp3 is
always skipped, so re-running after any interruption is safe and cheap.
"""

import argparse
import json
import random
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

MOVIES = Path("/srv/storage/data/media/library/movies")
YTDLP = Path("/srv/appdata/bin/yt-dlp")
STATE = Path("/srv/appdata/themerr-backfill-state.json")
LOG = Path("/srv/appdata/themerr-backfill.log")
THEMERRDB = "https://app.lizardbyte.dev/ThemerrDB/movies/themoviedb/{}.json"


def log(msg):
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S}  {msg}"
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def load_state():
    if STATE.exists():
        return json.loads(STATE.read_text())
    return {"done": {}, "no_theme": {}, "failed": {}}


def save_state(state):
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1))
    tmp.replace(STATE)


def tmdb_id_of(folder):
    """Read <tmdbid> out of the folder's movie.nfo."""
    nfo = folder / "movie.nfo"
    if not nfo.exists():
        return None
    m = re.search(r"<tmdbid>(\d+)</tmdbid>", nfo.read_text(encoding="utf-8", errors="replace"))
    return m.group(1) if m else None


def themerrdb_url(tmdb_id):
    """The YouTube URL ThemerrDB has for this movie, or None.

    Returns the string "MISSING" when ThemerrDB has no entry at all, so the
    caller can record that permanently instead of asking again every run.
    """
    try:
        with urllib.request.urlopen(THEMERRDB.format(tmdb_id), timeout=30) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        return "MISSING" if e.code == 404 else None
    except Exception:
        return None
    return data.get("youtube_theme_url") or "MISSING"


def download(url, dest, args):
    """Fetch the audio stream to dest. Returns (ok, message)."""
    cmd = [
        str(YTDLP),
        "-f", "bestaudio[ext=m4a]/bestaudio",
        "-o", str(dest),
        "--no-playlist",
        "--no-progress",
        "--retries", "3",
        "--socket-timeout", "30",
    ]
    if args.cookies:
        cmd += ["--cookies", args.cookies]
    cmd.append(url)

    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        return False, "yt-dlp timed out after 300s"

    if p.returncode == 0 and dest.exists() and dest.stat().st_size > 0:
        return True, f"{dest.stat().st_size} bytes"

    # Keep the last meaningful line - the full stderr is noisy and repetitive.
    err = [ln for ln in (p.stderr or "").splitlines() if ln.strip()]
    return False, err[-1][:200] if err else f"exit {p.returncode}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="stop after N downloads")
    ap.add_argument("--min-sleep", type=float, default=8.0)
    ap.add_argument("--max-sleep", type=float, default=20.0)
    ap.add_argument("--cookies", default="", help="optional cookies.txt (not normally needed)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--retry-failed", action="store_true", help="reattempt previous failures")
    args = ap.parse_args()

    if not YTDLP.exists():
        sys.exit(f"yt-dlp not found at {YTDLP}")

    state = load_state()
    if args.retry_failed:
        log(f"clearing {len(state['failed'])} previous failures for retry")
        state["failed"] = {}

    folders = sorted(p for p in MOVIES.iterdir() if p.is_dir())
    todo = []
    skipped_have = skipped_known = no_tmdb = 0

    for folder in folders:
        if (folder / "theme.mp3").exists():
            skipped_have += 1
            continue
        tmdb = tmdb_id_of(folder)
        if not tmdb:
            no_tmdb += 1
            continue
        if tmdb in state["no_theme"] or tmdb in state["failed"]:
            skipped_known += 1
            continue
        todo.append((folder, tmdb))

    log("=" * 62)
    log(f"folders={len(folders)} have_theme={skipped_have} no_tmdbid={no_tmdb} "
        f"known_skip={skipped_known} todo={len(todo)}")
    est = len(todo) * (args.min_sleep + args.max_sleep) / 2 / 3600
    log(f"pace {args.min_sleep}-{args.max_sleep}s -> roughly {est:.1f} hours")
    if args.dry_run:
        for folder, tmdb in todo[:20]:
            log(f"  would fetch {folder.name}  (tmdb {tmdb})")
        log(f"dry run, nothing downloaded ({len(todo)} candidates)")
        return

    done = failed = nodb = 0
    consecutive_failures = 0

    for i, (folder, tmdb) in enumerate(todo, 1):
        if args.limit and done >= args.limit:
            log(f"reached --limit {args.limit}")
            break

        url = themerrdb_url(tmdb)
        if url is None:
            log(f"[{i}/{len(todo)}] {folder.name[:44]}: ThemerrDB unreachable, leaving for next run")
            time.sleep(5)
            continue
        if url == "MISSING":
            state["no_theme"][tmdb] = folder.name
            nodb += 1
            save_state(state)
            continue

        dest = folder / "theme.mp3"
        ok, msg = download(url, dest, args)

        if ok:
            state["done"][tmdb] = {
                "folder": folder.name,
                "url": url,
                "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
            done += 1
            consecutive_failures = 0
            log(f"[{i}/{len(todo)}] OK   {folder.name[:44]} ({msg})")
        else:
            state["failed"][tmdb] = {"folder": folder.name, "url": url, "error": msg}
            failed += 1
            consecutive_failures += 1
            log(f"[{i}/{len(todo)}] FAIL {folder.name[:44]}: {msg}")
            # Back off hard on a run of failures - that is what being
            # throttled looks like, and hammering through it makes it worse.
            if consecutive_failures and consecutive_failures % 5 == 0:
                cool = min(60 * 2 ** (consecutive_failures // 5), 1800)
                log(f"  {consecutive_failures} failures in a row, cooling off {cool}s")
                time.sleep(cool)

        save_state(state)
        time.sleep(random.uniform(args.min_sleep, args.max_sleep))

    log(f"finished: downloaded={done} failed={failed} not_in_themerrdb={nodb}")
    log(f"totals so far: done={len(state['done'])} no_theme={len(state['no_theme'])} "
        f"failed={len(state['failed'])}")


if __name__ == "__main__":
    main()
