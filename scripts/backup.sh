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
# 35 of appdata's 36GB is derived data that any of these apps will rebuild from
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
APPDATA=${APPDATA:-/srv/storage/appdata}
KEEP=${KEEP:-14}
FULL=${FULL:-0}
# Where the archive goes and the key it travels with belong to flush-offsite.sh
# now. Declaring them in both places would let the two defaults drift apart, and
# the one that mattered would be whichever script you happened to read.
STAMP=$(date +%Y%m%d-%H%M%S)

[ "$(id -u)" -eq 0 ] || { echo "run with sudo - the database directories are not readable otherwise" >&2; exit 1; }

# Regenerable, and large. Every one of these is rebuilt by its own application
# from the originals on the media disk.
EXCLUDES=(
  'immich/postgres/'              # dumped below, and unsafe to copy live
  'postgres17/data/'              # dumped below, and unsafe to copy live
  'immich/server/encoded-video/'  # 19G  video transcodes
  'jellyfin/data/metadata/'       # 12G  posters, fanart, backdrops
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
echo "== database dumps =="

if docker ps --format '{{.Names}}' | grep -qx immich_postgres; then
  U=$(docker inspect immich_postgres --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_USER=//p')
  D=$(docker inspect immich_postgres --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_DB=//p')
  out="$DEST/dumps/immich-$STAMP.sql.gz"
  if docker exec immich_postgres pg_dump -U "$U" -d "$D" 2>/dev/null | gzip > "$out"; then
    note "immich      $(du -h "$out" | cut -f1)"
  else
    note "immich      FAILED"; fail=1
  fi
else
  note "immich      container not running - skipped"
fi

if docker ps --format '{{.Names}}' | grep -qx postgres17; then
  U=$(docker inspect postgres17 --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_USER=//p')
  out="$DEST/dumps/postgres17-$STAMP.sql.gz"
  # pg_dumpall, not pg_dump: this is a shared cluster, so roles and grants
  # matter as much as the data. A per-database dump restored into a cluster
  # with no matching roles fails on every GRANT.
  if docker exec postgres17 pg_dumpall -U "$U" 2>/dev/null | gzip > "$out"; then
    note "postgres17  $(du -h "$out" | cut -f1)"
  else
    note "postgres17  FAILED"; fail=1
  fi
else
  note "postgres17  container not running - skipped"
fi

# A truncated gzip still leaves a file behind, and a backup you cannot restore
# is worse than none because you stop worrying about it.
echo
echo "== verifying dumps =="
for f in "$DEST"/dumps/*-"$STAMP".sql.gz; do
  [ -e "$f" ] || continue
  if gzip -t "$f" 2>/dev/null && [ "$(stat -c %s "$f")" -gt 10240 ]; then
    note "$(basename "$f")  OK"
  else
    note "$(basename "$f")  CORRUPT OR EMPTY"; fail=1
  fi
done

# ------------------------------------------------------------------- appdata
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
  for e in 'immich/postgres/' 'postgres17/data/'; do
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
  note "COPY IS SHORT - something was skipped"; fail=1
elif [ "$dst" -gt $(( src * 120 / 100 )) ]; then
  note "COPY IS LARGER THAN THE SOURCE - stale excluded paths are lingering"; fail=1
fi

# ------------------------------------------------------------------- rotate
echo
echo "== rotation (keeping $KEEP of each) =="
for p in immich postgres17; do
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
tar_args=(-C "$DEST/appdata" "$STAMP")
shopt -s nullglob
dumps=("$DEST"/dumps/*-"$STAMP".sql.gz)
shopt -u nullglob
if [ ${#dumps[@]} -gt 0 ]; then
  tar_args+=(-C "$DEST")
  for d in "${dumps[@]}"; do tar_args+=("dumps/$(basename "$d")"); done
else
  note "no dumps for this run - archiving the snapshot only"
fi

if tar czf "$ARCHIVE" "${tar_args[@]}" 2>/dev/null; then
  sha256sum "$ARCHIVE" | awk '{print $1}' > "$ARCHIVE.sha256"
  chown "$OWNER":"$OWNER" "$ARCHIVE" "$ARCHIVE.sha256"
  chmod 640 "$ARCHIVE"; chmod 644 "$ARCHIVE.sha256"
  note "$(basename "$ARCHIVE")  $(du -h "$ARCHIVE" | cut -f1)"
else
  note "ARCHIVE FAILED"; fail=1
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
FLUSH=${FLUSH:-$(dirname "$0")/flush-offsite.sh}
if [ -x "$FLUSH" ]; then
  echo
  "$FLUSH" || fail=1
else
  echo
  note "flush-offsite.sh missing at $FLUSH - archive is staged but NOT sent"
  fail=1
fi

echo
echo "== total =="
note "$(du -sh "$DEST" | cut -f1) in $DEST"

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
