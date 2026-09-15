#!/usr/bin/env python3
"""Put a series from a YouTube playlist into Sonarr, and from there into Jellyfin.

For Arabic series that exist on YouTube and nowhere Sonarr can grab them from.
Give it the show's TMDb ID and the playlist, and it does what was done by hand
for Big Dreams (2004):

  1. finds the show in Sonarr by TMDb ID and adds it under arabic-shows, or
     moves it there, with the search for missing episodes turned off
  2. works out which video is which episode
  3. downloads every episode Sonarr does not have yet with yt-dlp, in a
     throwaway container, using the options Pinchflat's Media Center profile used
  4. imports the files with a Sonarr Manual Import, stating series, episode,
     quality and language
  5. scans the Arabic Shows library in Jellyfin

Without --apply it only prints the plan and changes nothing.

    youtube-to-sonarr.py --tmdb 115550 --playlist 'https://www.youtube.com/playlist?list=...'
    youtube-to-sonarr.py --tmdb 115550 --playlist '...' --apply

Safe to run again. Episodes Sonarr already has are skipped, and a finished
download that was not imported yet is imported rather than fetched again.

For a show Sonarr does not have yet, the episode list only exists once the show
is added, so the pairing is checked a second time after that. If it fails
there, the show stays in Sonarr unmonitored and without files: fix the pairing
with --order and run again, or delete the show in Sonarr.

WHERE YT-DLP COMES FROM

A standalone image, not Pinchflat or MeTube, so removing either of those never
breaks this. It carries yt-dlp with the ffmpeg, ffprobe and Deno that YouTube
downloads need, is rebuilt within an hour of every yt-dlp release, and is
pulled at the start of each run. Every call is a `docker run --rm`, so nothing
stays running between runs.

WHY A MANUAL IMPORT

Sonarr cannot match these files alone. Their names carry no series title and no
quality tag, so its own preview says SDTV, Unknown language, "Unknown Series".
Stating the series, episode, quality and language is what makes it take them.

WHICH VIDEO IS WHICH EPISODE

The number in the title comes first: "Ep 12", "Episode 12", "الحلقة 12". A
playlist often runs newest-first and several episodes share one upload date, so
neither playlist position nor upload date can be trusted while titles carry
numbers. Playlist order is used only when they do not, and only when the
playlist holds exactly as many videos as the season has episodes - forwards or
backwards, whichever the numbered titles agree with. The plan lists every
pairing before anything downloads, and --order forces one rule.
"""

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath

ENV_FILE = Path(__file__).resolve().parent.parent / "docker-compose.env"

SONARR_ROOT = "/data/library/arabic-shows"
QUALITY_PROFILE = "HD - 720p/1080p"
LANGUAGE = "Arabic"
JELLYFIN_LIBRARY = "Arabic Shows"

IMAGE = "ghcr.io/jauderho/yt-dlp:latest"
# One staging folder seen two ways. It is inside the media folder, which Sonarr
# mounts as /data, so the import is a rename on one filesystem, not a copy.
STAGING_HOST = "{media}/youtube-import/tmdb-{tmdb}"
STAGING_SONARR = "/data/youtube-import/tmdb-{tmdb}"

# What Pinchflat's Media Center profile passed, minus the loose thumbnail and
# subtitle files it wrote beside the video. Sonarr imports only the video, so
# those would be left behind in staging; both are still embedded in it.
YTDLP_OPTIONS = [
    # The image's own cache folder is root-only, and the container runs as PUID.
    "--cache-dir", "/tmp/yt-dlp",
    "--no-progress", "--no-warnings",
    "--format", "bestvideo*+bestaudio/best",
    "--format-sort", "res:1080,+codec:avc:m4a",
    "--remux-video", "mp4",
    "--embed-metadata",
    "--parse-metadata", "%(upload_date>%Y-%m-%d)s:(?P<meta_date>.+)",
    "--embed-thumbnail", "--convert-thumbnail", "jpg",
    "--embed-subs", "--sub-langs", "en", "--convert-subs", "srt",
    "--sponsorblock-mark", "sponsor",
]

EPISODE_IN_TITLE = re.compile(r"(?:(?<![a-z])ep(?:isode)?\.?|الحلقة)\s*(\d{1,3})(?!\d)", re.IGNORECASE)


def fail(message):
    sys.exit(f"stopped: {message}")


def load_env(path):
    env = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = re.split(r"\s+#", value, maxsplit=1)[0].strip().strip("'\"")
    return env


class Api:
    def __init__(self, base, headers):
        self.base = base
        self.headers = {**headers, "Content-Type": "application/json"}

    def call(self, method, path, body=None, **query):
        url = self.base + path + ("?" + urllib.parse.urlencode(query) if query else "")
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(url, data=data, method=method, headers=self.headers)
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                raw = response.read()
        except urllib.error.HTTPError as e:
            fail(f"{method} {path} answered {e.code}: {e.read()[:300].decode(errors='replace')}")
        return json.loads(raw) if raw else None


def run_image(user, *args, entrypoint=None, mount=None, check=True):
    """Run yt-dlp (or another tool in the image) once, as PUID:PGID, in a
    container that is deleted when it exits. mount becomes /downloads."""
    command = ["docker", "run", "--rm", "--user", user]
    if mount is not None:
        command += ["--volume", f"{mount}:/downloads"]
    if entrypoint:
        command += ["--entrypoint", entrypoint]
    result = subprocess.run([*command, IMAGE, *args], stdin=subprocess.DEVNULL, capture_output=True, text=True)
    if check and result.returncode != 0:
        fail(f"{entrypoint or 'yt-dlp'} exited {result.returncode}: {result.stderr.strip()[-400:]}")
    return result


def pull_image():
    pulled = subprocess.run(["docker", "pull", "-q", IMAGE], stdin=subprocess.DEVNULL, capture_output=True, text=True)
    if pulled.returncode == 0:
        return
    # A failed pull is fine as long as an older copy is here: it is only the
    # freshness of yt-dlp at stake, not whether the run can happen.
    have = subprocess.run(["docker", "image", "inspect", IMAGE], stdin=subprocess.DEVNULL, capture_output=True)
    if have.returncode != 0:
        fail(f"could not pull {IMAGE}: {pulled.stderr.strip()[-300:]}")
    print(f"image:    pull failed, using the copy already here ({pulled.stderr.strip()[-120:]})")


def wait_until(condition, seconds, step=5):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(step)
    return condition()


def named(items, name, what):
    for item in items:
        if item.get("name") == name:
            return item
    fail(f"Sonarr has no {what} named {name!r}")


def playlist_entries(user, url):
    out = run_image(user, "--cache-dir", "/tmp/yt-dlp", "--flat-playlist", "--dump-single-json", "--no-warnings", url).stdout
    data = json.loads(out)
    entries, skipped = [], []
    for entry in data.get("entries") or []:
        if not entry or not entry.get("id"):
            continue
        title = entry.get("title") or ""
        # Private and deleted videos stay in a playlist under a bracketed
        # placeholder title, with no duration.
        if entry.get("duration") is None and title.startswith("["):
            skipped.append(title)
            continue
        entries.append({"id": entry["id"], "title": title})
    return data.get("title") or url, entries, skipped


def pair_episodes(entries, wanted, order):
    """Pair each video with an episode number. wanted is None for a show not
    in Sonarr yet, whose episodes are unknown until it is added."""
    numbers = []
    for entry in entries:
        match = EPISODE_IN_TITLE.search(entry["title"])
        numbers.append(int(match.group(1)) if match else None)

    if order in ("auto", "title"):
        if all(n is not None for n in numbers):
            dupes = sorted({n for n in numbers if numbers.count(n) > 1})
            stray = sorted(set(numbers) - set(wanted)) if wanted is not None else []
            if not dupes and not stray:
                return list(zip(entries, numbers)), "episode numbers in the titles"
            # Every title has a number but they do not fit the season: they may
            # be part numbers or a different numbering. Guessing from playlist
            # order here would pair silently wrong.
            fail(f"every title has a number, but they do not fit the season "
                 f"(duplicates {dupes}, not in the season {stray}); pass --order forward or reverse to ignore them")
        elif order == "title":
            bare = next(e["title"] for e, n in zip(entries, numbers) if n is None)
            fail(f"{numbers.count(None)} titles carry no episode number, for example {bare!r}")

    count = len(entries)
    expected = list(range(1, count + 1))
    if wanted is not None and sorted(wanted) != expected:
        fail(f"cannot pair by playlist order: {count} videos, but the season's episodes are "
             f"{sorted(wanted)[:5]}{'...' if len(wanted) > 5 else ''} ({len(wanted)} in all)")

    note = ""
    if order == "auto":
        hits = [(i, n) for i, n in enumerate(numbers) if n is not None]
        if not hits:
            order, note = "forward", " (no numbered titles to check it against)"
        elif all(n == i + 1 for i, n in hits):
            order = "forward"
        elif all(n == count - i for i, n in hits):
            order = "reverse"
        else:
            fail("the numbered titles agree with neither playlist order; pass --order to choose")
    paired = expected if order == "forward" else expected[::-1]
    return list(zip(entries, paired)), f"playlist order, {order}{note}"


def season_episodes(sonarr, series_id, season):
    episodes = sonarr.call("GET", "/episode", seriesId=series_id)
    return {e["episodeNumber"]: e for e in episodes if e["seasonNumber"] == season}


def put_series_in_place(sonarr, show, profile_id):
    """Add the show under the Arabic root, or move it there. Returns the series id."""
    roots = sonarr.call("GET", "/rootfolder")
    if not any(r["path"].rstrip("/") == SONARR_ROOT for r in roots):
        sonarr.call("POST", "/rootfolder", {"path": SONARR_ROOT})
        print(f"sonarr:   added root folder {SONARR_ROOT}")

    if show.get("id"):
        series = sonarr.call("GET", f"/series/{show['id']}")
        path = f"{SONARR_ROOT}/{PurePosixPath(series['path']).name}"
        if series["path"] != path or series["qualityProfileId"] != profile_id:
            series.update(path=path, rootFolderPath=SONARR_ROOT, qualityProfileId=profile_id)
            sonarr.call("PUT", f"/series/{series['id']}", series, moveFiles="true")
            print(f"sonarr:   moved to {path}, profile {QUALITY_PROFILE}")
        return series["id"]

    # Unmonitored until the import is done: a monitored show with every episode
    # missing is exactly what an RSS sync goes looking for on the indexers.
    body = {**show, "rootFolderPath": SONARR_ROOT, "qualityProfileId": profile_id,
            "monitored": False, "seasonFolder": True,
            "addOptions": {"monitor": "all", "searchForMissingEpisodes": False,
                           "searchForCutoffUnmetEpisodes": False}}
    series = sonarr.call("POST", "/series", body)
    print(f"sonarr:   added as {series['path']}, profile {QUALITY_PROFILE}")
    return series["id"]


def import_files(sonarr, series_id, staged, episodes, user, host_dir, sonarr_dir):
    language = named(sonarr.call("GET", "/language"), LANGUAGE, "language")
    qualities = {q["quality"]["name"]: q["quality"] for q in sonarr.call("GET", "/qualitydefinition")}
    files = []
    for name, number in staged:
        out = run_image(user, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height",
                        "-of", "csv=p=0", f"/downloads/{name}.mp4", entrypoint="ffprobe", mount=host_dir).stdout
        height = int(out.strip() or 0)
        resolution = 2160 if height >= 1800 else 1080 if height >= 900 else 720 if height >= 600 else 480
        quality = qualities[f"WEBDL-{resolution}p"]
        print(f"  {name}  {height}p, imported as {quality['name']}")
        files.append({"path": f"{sonarr_dir}/{name}.mp4", "seriesId": series_id,
                      "episodeIds": [episodes[number]["id"]],
                      "quality": {"quality": quality, "revision": {"version": 1, "real": 0, "isRepack": False}},
                      "languages": [{"id": language["id"], "name": language["name"]}],
                      "releaseGroup": "", "indexerFlags": 0, "releaseType": "singleEpisode", "downloadId": ""})

    command = sonarr.call("POST", "/command", {"name": "ManualImport", "importMode": "move", "files": files})
    state = {}

    def finished():
        state.update(sonarr.call("GET", f"/command/{command['id']}"))
        return state.get("status") in ("completed", "failed", "aborted", "cancelled")

    if not wait_until(finished, 1800):
        fail(f"Sonarr's import is still running after 30 minutes (command {command['id']})")
    print(f"sonarr:   import {state['status']}: {state.get('message', '')}")
    if state["status"] != "completed":
        fail("Sonarr's import did not complete")


def jellyfin_scan(jellyfin, new_episodes):
    library = next((l for l in jellyfin.call("GET", "/Library/VirtualFolders")
                    if l.get("Name") == JELLYFIN_LIBRARY), None)
    if library is None:
        print(f"jellyfin: no library named {JELLYFIN_LIBRARY!r}, not scanning")
        return

    def count():
        return jellyfin.call("GET", "/Items", ParentId=library["ItemId"], IncludeItemTypes="Episode",
                             Recursive="true", Limit=0)["TotalRecordCount"]

    target = count() + new_episodes
    jellyfin.call("POST", f"/Items/{library['ItemId']}/Refresh", Recursive="true",
                  MetadataRefreshMode="Default", ImageRefreshMode="Default",
                  ReplaceAllMetadata="false", ReplaceAllImages="false")
    # Refreshing the one library does not always notice new files; the full
    # scan always has, so it is the fallback rather than the first move.
    if not wait_until(lambda: count() >= target, 120, step=10):
        jellyfin.call("POST", "/Library/Refresh")
        wait_until(lambda: count() >= target, 300, step=10)
    print(f"jellyfin: {JELLYFIN_LIBRARY} has {count()} episodes (wanted at least {target})")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tmdb", type=int, required=True, help="the show's TMDb ID")
    parser.add_argument("--playlist", required=True, help="YouTube playlist URL")
    parser.add_argument("--season", type=int, default=1, help="season the playlist holds (default 1)")
    parser.add_argument("--order", choices=("auto", "title", "forward", "reverse"), default="auto",
                        help="how videos become episodes (default auto, see above)")
    parser.add_argument("--apply", action="store_true", help="do it; without this only the plan is printed")
    args = parser.parse_args()

    env = load_env(ENV_FILE)
    for key in ("SONARR_API_KEY", "JELLYFIN_API_KEY", "FOLDER_FOR_MEDIA", "PUID", "PGID"):
        if not env.get(key):
            fail(f"{key} is not set in {ENV_FILE}")
    sonarr = Api(f"http://127.0.0.1:{env.get('WEBUI_PORT_SONARR', '8989')}/api/v3",
                 {"X-Api-Key": env["SONARR_API_KEY"]})
    jellyfin = Api(f"http://127.0.0.1:{env.get('WEBUI_PORT_JELLYFIN', '8096')}",
                   {"X-Emby-Token": env["JELLYFIN_API_KEY"]})
    user = f"{env['PUID']}:{env['PGID']}"
    host_dir = Path(STAGING_HOST.format(media=env["FOLDER_FOR_MEDIA"], tmdb=args.tmdb))
    sonarr_dir = STAGING_SONARR.format(tmdb=args.tmdb)

    found = sonarr.call("GET", "/series/lookup", term=f"tmdb:{args.tmdb}")
    if len(found) != 1:
        fail(f"Sonarr's lookup found {len(found)} shows for TMDb {args.tmdb}")
    show = found[0]
    print(f"show:     {show['title']} ({show.get('year')}), TVDB {show['tvdbId']}, TMDb {args.tmdb}, "
          f"{'in Sonarr as series ' + str(show['id']) if show.get('id') else 'not in Sonarr yet'}")

    pull_image()
    title, entries, skipped = playlist_entries(user, args.playlist)
    print(f"playlist: {title}, {len(entries)} videos" + (f", skipping {len(skipped)} private or deleted" if skipped else ""))
    if not entries:
        fail("the playlist has no videos")

    episodes = season_episodes(sonarr, show["id"], args.season) if show.get("id") else None
    if episodes is not None and not episodes:
        fail(f"Sonarr lists no episodes in season {args.season}")
    pairs, how = pair_episodes(entries, list(episodes) if episodes is not None else None, args.order)
    print(f"pairing:  {how}")

    def status(number, name):
        if episodes is not None and episodes[number]["hasFile"]:
            return "has a file"
        return "downloaded, not imported" if (host_dir / f"{name}.mp4").exists() else "to download"

    for entry, number in sorted(pairs, key=lambda p: p[1]):
        name = f"s{args.season:02d}e{number:02d}"
        print(f"  {name}  {status(number, name):<24}  {entry['title'][:70]}")
    if episodes is not None:
        uncovered = sorted(set(episodes) - {n for _, n in pairs})
        if uncovered:
            print(f"  not in the playlist: episodes {uncovered}")
    else:
        print("  the episode count is checked against Sonarr once the show is added")

    if not args.apply:
        print("plan only - nothing changed. Run again with --apply to do it.")
        return

    profile = named(sonarr.call("GET", "/qualityprofile"), QUALITY_PROFILE, "quality profile")
    series_id = put_series_in_place(sonarr, show, profile["id"])
    if episodes is None:
        # Sonarr fills in a new show's episodes in the background after adding it.
        deadline = time.monotonic() + 180
        while not (episodes := season_episodes(sonarr, series_id, args.season)):
            if time.monotonic() > deadline:
                fail(f"Sonarr has not listed season {args.season}'s episodes after 3 minutes")
            time.sleep(5)
        pairs, how = pair_episodes(entries, list(episodes), args.order)
        print(f"pairing:  {how}, checked against {len(episodes)} episodes in Sonarr")

    todo = [(entry, number) for entry, number in pairs if not episodes[number]["hasFile"]]
    failed = []
    if todo:
        host_dir.mkdir(parents=True, exist_ok=True)
        print(f"download: {len(todo)} episodes into {host_dir}")
    for i, (entry, number) in enumerate(todo, 1):
        name = f"s{args.season:02d}e{number:02d}"
        if (host_dir / f"{name}.mp4").exists():
            print(f"  [{i}/{len(todo)}] {name}  already downloaded")
            continue
        print(f"  [{i}/{len(todo)}] {name}  {entry['title'][:70]}", flush=True)
        result = run_image(user, *YTDLP_OPTIONS, "--output", f"/downloads/{name}.%(ext)s",
                           f"https://www.youtube.com/watch?v={entry['id']}", mount=host_dir, check=False)
        if not (host_dir / f"{name}.mp4").exists():
            failed.append(name)
            print(f"    failed: {result.stderr.strip()[-300:]}")
        elif result.returncode != 0:
            # The video is there; a step after it (SponsorBlock, the thumbnail)
            # complained. The file is still worth importing.
            print(f"    downloaded, with a complaint: {result.stderr.strip()[-200:]}")

    staged = [(f"s{args.season:02d}e{n:02d}", n) for _, n in todo if (host_dir / f"s{args.season:02d}e{n:02d}.mp4").exists()]
    imported = 0
    if staged:
        print(f"import:   {len(staged)} files")
        import_files(sonarr, series_id, staged, episodes, user, host_dir, sonarr_dir)
        episodes = season_episodes(sonarr, series_id, args.season)
        imported = sum(1 for _, n in staged if episodes[n]["hasFile"])
        missed = [name for name, n in staged if not episodes[n]["hasFile"]]
        if missed:
            failed += missed
            print(f"sonarr:   still no file for {missed}")
    else:
        print("import:   nothing to import")

    # Monitored once every episode in the playlist has a file, on whichever run
    # gets there - so a first run with a failed download ends monitored on the next.
    series = sonarr.call("GET", f"/series/{series_id}")
    if not series["monitored"] and all(episodes[n]["hasFile"] for _, n in pairs):
        series["monitored"] = True
        sonarr.call("PUT", f"/series/{series_id}", series)
        print("sonarr:   monitored now that every episode in the playlist has a file")

    for folder in (host_dir, host_dir.parent):
        try:
            folder.rmdir()
        except OSError:
            break

    if imported:
        jellyfin_scan(jellyfin, imported)
    have = sum(1 for e in episodes.values() if e["hasFile"])
    print(f"done:     Sonarr has {have} of {len(episodes)} episodes in season {args.season}")
    if failed:
        fail(f"{len(failed)} episodes did not make it: {failed}. Run again to retry them.")


if __name__ == "__main__":
    main()
