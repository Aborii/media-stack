#!/usr/bin/env python3
"""Strip release tags from movie titles in .nfo files, so Jellyfin shows clean names.

Why this exists: many downloads (YTS releases especially) ship an .nfo whose
<title> is the release name, e.g. "Ella Enchanted (2004) [BluRay] [720p]".
Jellyfin trusts a local .nfo over TMDB for the title, so that string becomes
the movie's name. It also copies it into its own movie.nfo, so editing the
name inside Jellyfin alone does not stick.

What it does: in every <movies>/*/*.nfo whose <title> contains "[", it drops
every [...] group and a trailing (year). Nothing else in the file changes,
and a UTF-8 BOM is kept if the file had one.

Without --apply it only prints "old -> new" lines. With --apply it first
copies each file it changes into --backup (same folder layout), then
rewrites it. Afterwards, refresh the library in Jellyfin: Refresh metadata >
"Search for missing metadata" (not "Replace all", which re-fetches every
image).

Run on the host as the media user (PUID 1000):

    scripts/jellyfin-nfo-titles.py                # dry run
    scripts/jellyfin-nfo-titles.py --apply
"""

import argparse
import re
import shutil
import sys
import time
from pathlib import Path

TITLE_RE = re.compile(r"<title>([^<]*)</title>")
BOM = b"\xef\xbb\xbf"


def clean(title: str) -> str:
    t = re.sub(r"\s*\[[^\]]*\]", "", title)
    t = re.sub(r"\s*\((19|20)\d{2}\)\s*$", "", t)
    return re.sub(r"\s{2,}", " ", t).strip()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--movies", type=Path,
                    default=Path("/srv/storage/data/media/library/movies"))
    ap.add_argument("--backup", type=Path,
                    default=Path.home() / f"nfo-title-backup-{time.strftime('%Y%m%d-%H%M%S')}")
    ap.add_argument("--apply", action="store_true", help="write the changes (default: dry run)")
    args = ap.parse_args()

    changed = 0
    for nfo in sorted(args.movies.glob("*/*.nfo")):
        raw = nfo.read_bytes()
        text = raw.decode("utf-8-sig")
        m = TITLE_RE.search(text)
        if not m or "[" not in m.group(1):
            continue
        new = clean(m.group(1))
        if not new or new == m.group(1):
            print(f"SKIP\t{nfo}\t{m.group(1)!r}")
            continue
        changed += 1
        print(f"{m.group(1)}\t->\t{new}")
        if args.apply:
            dest = args.backup / nfo.relative_to(args.movies)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(nfo, dest)
            out = text[: m.start(1)] + new + text[m.end(1):]
            nfo.write_bytes((BOM if raw.startswith(BOM) else b"") + out.encode("utf-8"))

    verb = "changed" if args.apply else "would change"
    print(f"{verb}: {changed}", file=sys.stderr)
    if args.apply and changed:
        print(f"backup: {args.backup}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
