#!/bin/bash
# Back up appdata, including the parts a normal-user copy silently misses.
#
# WHY THIS EXISTS
#
# Both database directories are mode 700 owned by the container's user, not by
# aborii:
#
#   appdata/immich/postgres    owner 999  700
#   appdata/postgres17/data    owner 70   700
#
# An rsync or cp run as a normal user hits permission denied on those two,
# skips them, and produces an appdata backup that looks complete and contains
# no databases at all. That is exactly how Immich arrived on this Pi with 61GB
# of photos and an empty database - the files came across, the database did not,
# and nothing said so.
#
# Copying them as files would not be safe even with permission: a live
# PostgreSQL data directory copied file-by-file can capture a torn state that
# will not replay. Databases get dumped; everything else gets rsynced.
#
# WHAT IS DELIBERATELY NOT BACKED UP
#
# Nearly all of appdata is derived data that any of these apps will rebuild from
# the media files themselves - transcodes, thumbnails, posters, ML models. This
# backup protects CONFIGURATION, which is about 1GB: the databases, config.xml,
# settings, and Immich's uploads. Regenerating artwork costs time after a
# restore; losing a config file costs an evening of remembering what was in it.
#
#   sudo ./backup.sh                 back up
#   sudo DEST=/mnt/x ./backup.sh     somewhere else
#   sudo KEEP=30 ./backup.sh         keep more dumps
#   sudo FULL=1 ./backup.sh          include the derived data too
set -euo pipefail

DEST=${DEST:-/srv/storage/backups}
APPDATA=${APPDATA:-/srv/appdata}
KEEP=${KEEP:-14}
FULL=${FULL:-0}
# Where the archive goes and the key it travels with belong to flush-offsite.sh
# now. Declaring them in both places would let the two defaults drift apart, and
# the one that mattered would be whichever script you happened to read.
STAMP=$(date +%Y%m%d-%H%M%S)

[ "$(id -u)" -eq 0 ] || { echo "run with sudo - the database directories are not readable otherwise" >&2; exit 1; }

# ------------------------------------------------------------------ reporting
# Every run reports to the Telegram "backups" topic: OK, FAILED, or stopped
# early. Stopped early matters most. set -e ends this script on any unexpected
# error, and a backup that quietly stops being taken is exactly the failure this
# script family exists to catch - so the EXIT trap turns it into a message
# naming the stage it died in.
TG_HELPER="$(dirname "$0")/notify-telegram.sh"
if [ -f "$TG_HELPER" ]; then
  # shellcheck source=notify-telegram.sh
  . "$TG_HELPER"
else
  tg_backup() { :; }
  echo "  notify-telegram.sh missing at $TG_HELPER - this run will not be reported" >&2
fi
# The size the archive is meant to stay under. Passing it still delivers - the
# receiver's hard cap is 8 GB - but it posts a warning, so the growth is found
# and trimmed while there is still room. Both earlier times the archive grew
# past 4 GB (a Docker registry cache, then Jellyfin's caches) it was only
# noticed when the receiver was about to refuse it.
WARN_BYTES=${WARN_BYTES:-$((4 * 1024 * 1024 * 1024))}
HOST=$(hostname)
stage="checking the destination"
problems=()
dump_report=()
reported=0
problem() { note "$*"; problems+=("$*"); fail=1; }
on_exit() {
  local rc=$?
  [ "$reported" = "1" ] && return
  tg_backup "Backup FAILED on $HOST - stopped early (exit $rc) while $stage.
Run $STAMP. Details: journalctl -u media-stack-backup.service"
}
trap on_exit EXIT

# The source used to live on the same disk as DEST, so an unmounted data disk
# produced an empty source and the run failed safely. It does not any more:
# appdata is on the NVMe and is always there, so with the disk unmounted this
# would read a complete appdata and write the whole snapshot into a bare
# directory on the root filesystem - succeeding, reporting success, and
# vanishing the moment the disk mounts over it. fstab has nofail, so nothing
# else stops that happening.
#
# Walk to the nearest existing ancestor: on a first run DEST does not exist yet
# and findmnt answers nothing at all for a missing path.
probe=$DEST
while [ ! -d "$probe" ] && [ "$probe" != "/" ]; do probe=$(dirname "$probe"); done
[ "$(findmnt -T "$probe" -no TARGET)" != "/" ] || {
  echo "$DEST resolves to the root filesystem - refusing to back up onto it" >&2
  echo "  the data disk is probably not mounted; check 'findmnt /srv/storage'" >&2
  exit 1
}

# Regenerable, and large. Every one of these is rebuilt by its own application
# from the originals on the media disk.
# Patterns here are shared with du via du_args below, and the two tools
# disagree about a leading slash: rsync honours it, du ignores the entry
# entirely. So a single-component pattern cannot be anchored. Anchoring
# 'registry/' as '/registry/' makes rsync drop the directory while du keeps
# counting it, and the size check below then fails the run with
# "COPY IS SHORT - something was skipped" when nothing was skipped.
# Multi-component patterns like 'immich/postgres/' work in both.
EXCLUDES=(
  'immich/postgres/'              # dumped below, and unsafe to copy live
  'postgres17/data/'              # dumped below, and unsafe to copy live
  'dawarich/db/'                  # dumped below, and unsafe to copy live
  'immich/server/encoded-video/'  # 19G  video transcodes
  'jellyfin/data/data/trickplay/' # 1.0G scrub-bar preview images, rebuilt by Jellyfin's scheduled task
  'jellyfin/data/data/subtitles/' # 840M subtitles pulled out of the video files, re-extracted on demand
  'ollama/models/'                # 260M embedding model, re-pulled by ollama
  'jellyfin/data/metadata/'       # 12G  posters, fanart, backdrops
  'registry/'                     # 2.1G pull-through cache of Docker Hub, re-pulled on demand
  'radarr/MediaCover/'            # 2.1G movie posters
  'immich/server/thumbs/'         # 1.8G photo thumbnails
  'immich/model-cache/'           # 786M ML models, re-downloaded
  'immich/server/backups/'        # 613M immich's own dumps - we dump separately
  'sonarr/MediaCover/'            # 167M series posters
  'jellyfin/cache/'
  'jellyfin/log/'
  'tdarr/logs/'
)

mkdir -p "$DEST/dumps" "$DEST/appdata"
fail=0
note() { printf '  %s\n' "$*"; }

# ------------------------------------------------------------------ databases
stage="dumping the databases"
echo "== database dumps =="

# One function for every database, so the next one added cannot get a subtly
# different copy of the logic. Each Postgres here runs in its own container
# and owns its data directory, which is excluded from the appdata copy above:
# a live data directory copied file by file can capture a torn state that will
# not replay. Dawarich ran for weeks with its data directory copied that way
# and no dump at all, because each database used to be spelled out by hand.
#
# $3 is the tool. pg_dump for a database that owns its container; pg_dumpall
# for the shared cluster, where roles and grants matter as much as the data -
# a per-database dump restored into a cluster with no matching roles fails on
# every GRANT.
dump_db() {
  local name=$1 container=$2 tool=$3 cvars U D out
  if ! docker ps --format '{{.Names}}' | grep -qx "$container"; then
    note "$(printf '%-11s' "$name") container not running - skipped"
    dump_report+=("$name skipped (not running)")
    return 0
  fi
  cvars=$(docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}')
  U=$(sed -n 's/^POSTGRES_USER=//p' <<<"$cvars")
  D=$(sed -n 's/^POSTGRES_DB=//p' <<<"$cvars")
  out="$DEST/dumps/$name-$STAMP.sql.gz"
  if [ "$tool" = pg_dumpall ]; then
    set -- pg_dumpall -U "$U"
  else
    set -- pg_dump -U "$U" -d "$D"
  fi
  if docker exec "$container" "$@" 2>/dev/null | gzip > "$out"; then
    note "$(printf '%-11s' "$name") $(du -h "$out" | cut -f1)"
    dump_report+=("$name $(du -h "$out" | cut -f1)")
  else
    problem "$(printf '%-11s' "$name") dump FAILED"
    dump_report+=("$name FAILED")
  fi
}

dump_db immich     immich_postgres pg_dump
dump_db postgres17 postgres17      pg_dumpall
dump_db dawarich   dawarich_db     pg_dump

# A truncated gzip still leaves a file behind, and a backup you cannot restore
# is worse than none because you stop worrying about it.
stage="verifying the dumps"
echo
echo "== verifying dumps =="
for f in "$DEST"/dumps/*-"$STAMP".sql.gz; do
  [ -e "$f" ] || continue
  if gzip -t "$f" 2>/dev/null && [ "$(stat -c %s "$f")" -gt 10240 ]; then
    note "$(basename "$f")  OK"
  else
    problem "$(basename "$f")  CORRUPT OR EMPTY"
  fi
done

# ------------------------------------------------------------------- appdata
stage="copying appdata"
echo
echo "== appdata =="

# --delete-excluded, not just --delete. Plain --delete leaves anything matching
# an --exclude alone in the DESTINATION, so paths excluded after an earlier run
# stay there forever, unmaintained and growing. First observed as a 590MB source
# producing a 2.9GB copy.
rsync_args=(-aHAX --delete --delete-excluded)
du_args=()
if [ "$FULL" = "1" ]; then
  note "FULL=1 - including derived data, this will be tens of GB"
  # even then, never copy a live database directory
  for e in 'immich/postgres/' 'postgres17/data/' 'dawarich/db/'; do
    rsync_args+=(--exclude "$e"); du_args+=(--exclude "${e%/}")
  done
else
  for e in "${EXCLUDES[@]}"; do
    rsync_args+=(--exclude "$e"); du_args+=(--exclude "${e%/}")
  done
fi

# Dated snapshots, not one overwritten mirror. A mirror has no history: a
# config file that gets corrupted is faithfully copied over the last good one
# and the original is gone. The databases keep 14 days; the configs kept none.
#
# --link-dest hardlinks anything unchanged since the previous snapshot, so 14
# dailies of a 591MB tree cost barely more than one. Only what actually changed
# consumes new space.
SNAP="$DEST/appdata/$STAMP"
mkdir -p "$SNAP"
# || true matters: on the FIRST run there are no previous snapshots, ls fails,
# and under pipefail that failure propagates out of the assignment and set -e
# kills the script silently, right after printing the appdata header.
PREV=$(find "$DEST/appdata" -maxdepth 1 -mindepth 1 -type d ! -name "$STAMP" 2>/dev/null | sort | tail -1 || true)
[ -n "$PREV" ] && rsync_args+=(--link-dest="${PREV%/}")

rsync "${rsync_args[@]}" "$APPDATA/" "$SNAP/" 2>&1 | tail -3
ln -sfn "$SNAP" "$DEST/appdata/latest"

src=$(du -sb "${du_args[@]}" "$APPDATA" | cut -f1)
dst=$(du -sb "$SNAP" | cut -f1)
note "source $(numfmt --to=iec "$src")  copy $(numfmt --to=iec "$dst")"
# Compare sizes rather than trusting rsync's exit code: a skipped directory is
# not an error to rsync, which is the whole reason this script exists.
# Check BOTH directions. Too small means something was skipped - a permission
# denied is not an error to rsync, which is why this script exists. Too large
# means excluded paths are lingering in the destination.
if [ "$dst" -lt $(( src * 95 / 100 )) ]; then
  problem "COPY IS SHORT - something was skipped"
elif [ "$dst" -gt $(( src * 120 / 100 )) ]; then
  problem "COPY IS LARGER THAN THE SOURCE - stale excluded paths are lingering"
fi

# ------------------------------------------------------------------- rotate
stage="rotating old backups"
echo
echo "== rotation (keeping $KEEP of each) =="
for p in immich postgres17 dawarich; do
  n=$(ls -1t "$DEST"/dumps/$p-*.sql.gz 2>/dev/null | wc -l || true)
  if [ "$n" -gt "$KEEP" ]; then
    ls -1t "$DEST"/dumps/$p-*.sql.gz | tail -n +$((KEEP + 1)) | xargs -r rm --
    note "$p: removed $(( n - KEEP )), $KEEP kept"
  else
    note "$p: $n kept"
  fi
done

n=$(find "$DEST/appdata" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l || true)
if [ "$n" -gt "$KEEP" ]; then
  find "$DEST/appdata" -maxdepth 1 -mindepth 1 -type d | sort | head -n -"$KEEP" | xargs -r rm -rf --
  note "appdata: removed $(( n - KEEP )), $KEEP kept"
else
  note "appdata: $n snapshot(s) kept"
fi

# --------------------------------------------------------------- offsite
# Everything above lands on the SAME disk it is backing up. That covers a bad
# delete or a corrupted database - what has actually gone wrong here - but not
# the disk dying, and this one has already dropped offline once under load.
#
# So one dated archive gets staged for another machine to collect.
#
# It has to be a TARBALL, and it has to be built here as root. The snapshot
# tree contains files a normal user cannot read - scrutiny's influxdb, diun's
# database, both database directories - because rsync -aHAX faithfully kept
# their ownership. Anything assembling this archive as an ordinary user reads
# what it can, skips the rest without complaint, and produces a backup missing
# precisely the data this script exists to protect. That is the same silent-skip
# failure Immich already arrived here with once.
#
# Tar as root, then hand ownership to the login user so the archive can be read
# and checked without privilege afterwards.
stage="building the offsite archive"
echo
echo "== offsite archive =="
OFFSITE="$DEST/offsite"
OWNER=${OWNER:-aborii}
mkdir -p "$OFFSITE"
ARCHIVE="$OFFSITE/media-stack-$STAMP.tar.gz"

# Only the newest snapshot and this run's dumps. The older snapshots are
# hardlinked to it, so tarring them all would expand every hardlink into a full
# copy and multiply the size by the retention count.
# Build the file list explicitly. An unquoted glob that matches nothing would
# leave tar with a -C and no operands, which fails with a message about tar
# rather than about the missing dumps.
# The SD card holds /etc, the login home and /boot/firmware, and NOTHING else
# here protects them - everything above lives on the data disk. That card is a
# counterfeit (its CID reports product name "asdfg", serial 472), so treating
# it as expendable is the only safe posture.
#
# Some of what matters is not a file at all, so capture it first.
STATE="$DEST/system-state"
mkdir -p "$STATE"
dpkg --get-selections > "$STATE/dpkg-selections.txt" 2>/dev/null || true
# The boot order lives in EEPROM, not on any filesystem. A card image alone
# would not record that NVMe boot had ever been configured.
command -v rpi-eeprom-config >/dev/null 2>&1 && rpi-eeprom-config > "$STATE/eeprom-config.txt" 2>/dev/null
# UUIDs and PARTUUIDs, needed to rebuild fstab and cmdline.txt correctly.
lsblk -o NAME,SIZE,FSTYPE,UUID,PARTUUID,MOUNTPOINT > "$STATE/blkid.txt" 2>/dev/null || true

tar_args=(-C "$DEST/appdata" "$STAMP")
# Root filesystem config, relative to / so members are stored as etc/... rather
# than /etc/... - tar strips the leading slash anyway and warns when it does.
tar_args+=(-C / etc home/aborii boot/firmware)
tar_args+=(-C "$DEST" system-state)

shopt -s nullglob
dumps=("$DEST"/dumps/*-"$STAMP".sql.gz)
shopt -u nullglob
if [ ${#dumps[@]} -gt 0 ]; then
  tar_args+=(-C "$DEST")
  for d in "${dumps[@]}"; do tar_args+=("dumps/$(basename "$d")"); done
else
  note "no dumps for this run - archiving the snapshot only"
fi

# .vscode-server alone is 1.7G of regenerable remote-server install; it would
# dominate both the archive and the nightly upload for no benefit. The kuma
# venv and the caches rebuild themselves too. media-stack itself is only 4M
# and is deliberately kept - it carries docker-compose.env, which is gitignored
# and therefore exists nowhere else.
sys_excludes=(
  --exclude=home/aborii/.vscode-server
  --exclude=home/aborii/.venv-kuma
  --exclude=home/aborii/.cache
  --exclude=home/aborii/.npm
  --exclude=home/aborii/.local/share/Trash
)
# --warning=no-file-changed: /home is live and files WILL move under tar. That
# is a warning, not a failure, and letting it set a non-zero exit would hide
# the failures that do matter.
archive_line="not built"
if tar czf "$ARCHIVE" "${sys_excludes[@]}" --warning=no-file-changed "${tar_args[@]}" 2>/dev/null; then
  sha256sum "$ARCHIVE" | awk '{print $1}' > "$ARCHIVE.sha256"
  chown "$OWNER":"$OWNER" "$ARCHIVE" "$ARCHIVE.sha256"
  chmod 640 "$ARCHIVE"; chmod 644 "$ARCHIVE.sha256"
  size=$(stat -c %s "$ARCHIVE")
  archive_line="$(basename "$ARCHIVE"), $(numfmt --to=iec "$size")"
  note "$(basename "$ARCHIVE")  $(numfmt --to=iec "$size")"
  # Posted now, not folded into the summary, so it arrives even if the upload
  # below hangs for an hour.
  if [ "$size" -gt "$WARN_BYTES" ]; then
    note "ARCHIVE IS OVER $(numfmt --to=iec "$WARN_BYTES") - find what grew"
    tg_backup "Backup WARNING on $HOST: the archive is $(numfmt --to=iec "$size"), over the $(numfmt --to=iec "$WARN_BYTES") line.
$(basename "$ARCHIVE")
It will still be delivered - the PC accepts up to 8G - but something in appdata grew. Compare it with an older archive and exclude whatever its app can rebuild."
  fi
else
  problem "ARCHIVE FAILED"
fi

# --- hand it to the offsite flush -------------------------------------------
# The Pi uploads; the PC never reaches in here. That way nothing on the PC holds
# standing credentials to this machine, and this machine holds nothing but a
# key that can only POST a backup to one endpoint.
#
# Sending used to happen inline, right here, exactly once. The only retry was
# therefore tomorrow's run - so a PC that is off at 03:30 but awake all day
# received nothing, ever. Staging retention lived here too and pruned to "the 3
# newest" without asking whether they had been sent, so a run of offline nights
# deleted un-uploaded archives to make room for newer un-uploaded ones.
#
# Both jobs moved to flush-offsite.sh, which a timer also runs every 30 minutes.
# Calling it here keeps the common case identical - PC awake, archive delivered
# before this script exits - while an offline PC just leaves the archive queued
# for whichever tick finds the receiver answering.
#
# Its exit status reports on the QUEUE, not on this backup. A refused archive is
# worth surfacing; the PC being off is not, and the flush already exits 0 for
# that case precisely because the local backup has succeeded by this point.
#
# FLUSH_QUIET_NAME: the flush posts to Telegram when it delivers an archive the
# timer picked up later, but this run's own delivery goes in the summary below,
# so it is told not to post that one twice. Refusals it always posts itself.
stage="handing the archive to the offsite flush"
FLUSH=${FLUSH:-$(dirname "$0")/flush-offsite.sh}
if [ -x "$FLUSH" ]; then
  echo
  FLUSH_QUIET_NAME=$(basename "$ARCHIVE") "$FLUSH" || problem "offsite flush reported a problem - see its lines above"
else
  echo
  problem "flush-offsite.sh missing at $FLUSH - archive is staged but NOT sent"
fi

# Read from the markers the flush leaves, rather than from its exit code: 0
# covers both "delivered" and "the PC is off", and those are different news.
# A failed tar is checked first: it leaves a partial archive with no checksum,
# which the flush marks bad, and reading that marker would blame the PC for a
# file it never saw.
if [ "$archive_line" = "not built" ]; then
  delivery="Nothing delivered - the archive was not built."
elif [ -f "$ARCHIVE.sent" ]; then
  delivery="Delivered to the PC."
elif [ -f "$ARCHIVE.bad" ]; then
  delivery="REFUSED by the PC - it will not be retried."
else
  delivery="Not delivered yet - the PC did not answer. Retried every 30 minutes."
fi

echo
echo "== total =="
note "$(du -sh "$DEST" | cut -f1) in $DEST"

# ------------------------------------------------------------------- report
dumps_line=$(printf '%s, ' "${dump_report[@]}"); dumps_line=${dumps_line%, }
if [ "$fail" -eq 0 ]; then status="Backup OK"; else status="Backup FAILED"; fi
msg="$status on $HOST - run $STAMP
Archive: $archive_line
$delivery
Dumps: ${dumps_line:-none}
appdata: source $(numfmt --to=iec "$src"), copy $(numfmt --to=iec "$dst")"
if [ ${#problems[@]} -gt 0 ]; then
  msg+=$'\nProblems:'
  for p in "${problems[@]}"; do msg+=$'\n- '"$(echo "$p" | tr -s ' ')"; done
  msg+=$'\nDetails: journalctl -u media-stack-backup.service'
fi
reported=1
tg_backup "$msg"

echo
if [ "$fail" -eq 0 ]; then
  echo "  OK"
else
  echo "  FINISHED WITH ERRORS - read the FAILED lines above" >&2
  exit 1
fi

# WHERE THIS WRITES
#
# The default destination is the SAME disk as the source. That covers a bad
# delete, a broken migration or a corrupted database - which is what actually
# went wrong here - but NOT the disk failing. For that, point DEST elsewhere.
