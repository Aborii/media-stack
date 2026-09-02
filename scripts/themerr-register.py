#!/usr/bin/env python3
"""Tell Themerr's database about themes downloaded outside the plugin.

Without this, every theme the backfill fetched is invisible to Themerr: it
skips an item only when its own row already holds the same YouTube URL and
a matching file hash. A theme.mp3 it did not record is a theme.mp3 it will
try to download again on every run, failing and filling the log each time.

Run this with Jellyfin STOPPED. Themerr uses EF Core over sqlite in WAL
mode and holds rows in memory, so a write underneath a running server can
be silently overwritten on its next save.

Two steps, because the item GUIDs only exist while Jellyfin is up:

    themerr-register.py --dump-items      # Jellyfin running
    docker stop jellyfin
    themerr-register.py --apply           # Jellyfin stopped
    docker start jellyfin
"""

import argparse
import hashlib
import json
import posixpath
import sqlite3
import subprocess
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DB = Path("/srv/appdata/jellyfin/data/data/Themerr/themerr.db")
MOVIES = Path("/srv/storage/data/media/library/movies")
ITEMS = Path("/srv/appdata/themerr-jellyfin-items.json")
STATE = Path("/srv/appdata/themerr-backfill-state.json")

# The library is bind-mounted into the container, and every path Themerr
# stores is the container's view of it. Writing host paths here would make
# rows that never match anything.
HOST_PREFIX = "/srv/storage/data/media/library"
CONTAINER_PREFIX = "/data/media"
CONTAINER_MOVIES = "/data/media/movies"

JELLYFIN = "http://127.0.0.1:8096"
API_KEY = "6545ac98160f41aa9963647a8d2a3f88"

# Values Themerr itself writes - see ThemerrThemeHasher.CurrentAlgorithm
# and ThemerrThemeProvider in the plugin source.
HASH_ALGO = "SHA256"
PROVIDER = "themerr"


def now():
    """Themerr's timestamp shape: sqlite text, 7 fractional digits, no zone."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f") + "0"


def container_path(p):
    s = str(p)
    if not s.startswith(HOST_PREFIX):
        raise ValueError(f"path outside the library: {s}")
    return CONTAINER_PREFIX + s[len(HOST_PREFIX):]


def sha256(path):
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def issue_url(name, year, tmdb_id):
    title = urllib.parse.quote(f"{name} ({year})") if year else urllib.parse.quote(name)
    return (
        "https://github.com/LizardByte/ThemerrDB/issues/new?assignees=&labels=request-theme"
        f"&template=theme.yml&title=[MOVIE]:%20{title}"
        f"&database_url=https://www.themoviedb.org/movie/{tmdb_id}"
    )


def dump_items():
    """Cache folder -> (jellyfin id, name, year, tmdb id) while the server is up.

    Jellyfin reports Path as the VIDEO FILE, not the directory, so the key
    here is its parent. A loose file sitting directly in the movies root has
    no folder of its own and is skipped rather than colliding with every
    other such file.
    """
    url = (f"{JELLYFIN}/Items?IncludeItemTypes=Movie&Recursive=true&Limit=5000"
           f"&fields=ProviderIds,Path,ProductionYear&api_key={API_KEY}")
    with urllib.request.urlopen(url, timeout=120) as r:
        data = json.load(r)

    out = {}
    loose = 0
    for it in data["Items"]:
        path = it.get("Path")
        if not path:
            continue
        folder = posixpath.dirname(path) if posixpath.basename(path).count(".") else path
        if folder.rstrip("/") == CONTAINER_MOVIES.rstrip("/"):
            loose += 1
            continue
        out[folder] = {
            "id": it["Id"],
            "name": it["Name"],
            "year": it.get("ProductionYear"),
            "tmdb": (it.get("ProviderIds") or {}).get("Tmdb"),
        }
    ITEMS.write_text(json.dumps(out, indent=1))
    print(f"cached {len(out)} items to {ITEMS}" + (f" ({loose} loose files skipped)" if loose else ""))


def jellyfin_running():
    try:
        p = subprocess.run(
            ["docker", "ps", "--filter", "name=jellyfin", "--format", "{{.Names}}"],
            capture_output=True, text=True, timeout=30)
        return "jellyfin" in p.stdout
    except OSError:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump-items", action="store_true", help="step 1, Jellyfin running")
    ap.add_argument("--apply", action="store_true", help="step 2, Jellyfin stopped")
    ap.add_argument("--force", action="store_true", help="write even if Jellyfin is up")
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would change, touching nothing (safe while Jellyfin runs)")
    args = ap.parse_args()

    if args.dump_items:
        dump_items()
        return

    if not ITEMS.exists():
        sys.exit(f"{ITEMS} missing - run --dump-items first, with Jellyfin running")

    if jellyfin_running() and not (args.force or args.dry_run):
        sys.exit("Jellyfin is running. Stop it first (docker stop jellyfin), or pass "
                 "--force if you accept that Themerr may overwrite these rows.")

    items = json.loads(ITEMS.read_text())
    # Jellyfin reports container paths, which is what we want to key on.
    by_container_dir = {v_path: v for v_path, v in items.items()}

    urls = {}
    if STATE.exists():
        for tmdb, rec in json.loads(STATE.read_text()).get("done", {}).items():
            urls[str(tmdb)] = rec.get("url")

    # Immutable open for a dry run so a busy Jellyfin cannot be disturbed.
    if args.dry_run:
        con = sqlite3.connect(f"file:{DB}?immutable=1", uri=True)
    else:
        con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    existing = {r["ItemKey"]: dict(r) for r in con.execute("SELECT * FROM ThemerrMediaItems")}

    inserted = updated = skipped = unmatched = 0

    for theme in sorted(MOVIES.glob("*/theme.mp3")):
        folder = theme.parent
        cdir = container_path(folder)
        info = by_container_dir.get(cdir)
        if not info:
            unmatched += 1
            continue

        tmdb = str(info["tmdb"]) if info["tmdb"] else None
        url = urls.get(tmdb) if tmdb else None
        item_key = f"Movie:jellyfin:{info['id']}"
        row = existing.get(item_key)
        digest = sha256(theme)

        # Already recorded with this exact file and URL - nothing to do.
        if row and row["ThemeHash"] == digest and row["ThemeHashAlgorithm"] == HASH_ALGO \
                and (url is None or row["YoutubeThemeUrl"] == url):
            skipped += 1
            continue

        ts = now()
        cpath = container_path(theme)
        values = {
            "ItemKey": item_key,
            "ItemId": info["id"],
            "ItemType": "Movie",
            "ItemName": info["name"],
            "ProductionYear": info["year"],
            "ItemPath": cdir,
            "ThemePath": cpath,
            "TmdbId": tmdb,
            "ThemeHash": digest,
            "ThemeHashAlgorithm": HASH_ALGO,
            "ThemeProvider": PROVIDER,
            "InThemerrDb": 1,
            "InThemerrDbCheckedUtc": ts,
            "IssueUrl": issue_url(info["name"], info["year"], tmdb) if tmdb else None,
            # Keep whatever URL the row already had when the backfill state
            # does not know one - better than nulling a good value.
            "YoutubeThemeUrl": url or (row["YoutubeThemeUrl"] if row else None),
            "DownloadedTimestampUtc": ts,
            "UpdatedUtc": ts,
        }

        if row:
            updated += 1
            if not args.dry_run:
                sets = ", ".join(f'"{k}" = :{k}' for k in values if k != "ItemKey")
                con.execute(f'UPDATE ThemerrMediaItems SET {sets} WHERE "ItemKey" = :ItemKey', values)
            elif updated <= 3:
                print(f"  would UPDATE {item_key}  {info['name'][:40]}")
        else:
            inserted += 1
            if not args.dry_run:
                values["CreatedUtc"] = ts
                cols = ", ".join(f'"{k}"' for k in values)
                binds = ", ".join(f":{k}" for k in values)
                con.execute(f"INSERT INTO ThemerrMediaItems ({cols}) VALUES ({binds})", values)
            elif inserted <= 3:
                print(f"  would INSERT {item_key}  {info['name'][:40]}")

    if args.dry_run:
        print("DRY RUN - nothing written")
    else:
        con.commit()
    total = con.execute("SELECT COUNT(*) FROM ThemerrMediaItems").fetchone()[0]
    hashed = con.execute(
        "SELECT COUNT(*) FROM ThemerrMediaItems WHERE ThemeHash IS NOT NULL AND ThemeHash <> ''"
    ).fetchone()[0]
    con.close()

    print(f"inserted={inserted} updated={updated} already_current={skipped} "
          f"unmatched_folders={unmatched}")
    print(f"database now: {total} rows, {hashed} with a theme hash")


if __name__ == "__main__":
    main()
