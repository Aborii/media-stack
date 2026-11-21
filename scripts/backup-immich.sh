#!/bin/bash
# Snapshot Immich's photos and database onto the NVMe, off the disk the
# photos live on.
#
# The same shape as backup-opencloud.sh, which explains the parts shared with
# it: the on-disk stop marker, problems versus alerts, the background rsync,
# the exact count, the shrink guard and the .partial rename. This header only
# covers what differs.
#
# WHY IT STOPS IMMICH, AND ONLY FOR SECONDS
#
# Immich's backup page: "The best way of dealing with this is to stop the
# immich-server container while you take a backup. If nothing is changing then
# the backup will always be in sync." The photos are 69 GB, though, and a
# first copy of that takes many minutes. So the copy runs twice:
#
#   1. while Immich runs - moves nearly everything, and costs no downtime
#   2. Immich stopped: dump the database, copy again (only what changed in the
#      minutes since), count, start
#
# The database container stays up - pg_dump needs it - but with the server
# stopped nothing writes to it, so the dump and the files match.
#
# WHAT IS COPIED, AND WHAT IS NOT
#
# The originals, per the docs' list of what is critical: library/ (the photo
# library, on the USB disk), upload/ and profile/ (small, in appdata). Not
# thumbs/ or encoded-video/: 24 GB Immich rebuilds from the originals (Jobs >
# Generate Thumbnails, Transcode Videos), and leaving them out keeps that much
# off the SSD every time they change.
#
#   <stamp>/library/  /srv/storage/data/media/gallery
#   <stamp>/upload/   /srv/appdata/immich/server/upload
#   <stamp>/profile/  /srv/appdata/immich/server/profile
#   <stamp>/db/immich-db.sql.gz   pg_dump --clean --if-exists of the one
#                     database, the form Immich's own dumps take and the docs'
#                     command-line restore reads in a single transaction
#   <stamp>/image     the server image, since a dump restores into its version
#   <stamp>/db-image  the database image (Immich's own Postgres build)
#
#   ./backup-immich.sh                   back up (as aborii - docker group)
#   ALLOW_SHRINK=1 ./backup-immich.sh    after a real delete of over half the photos
#   DEST=/x CONTAINER=y DB_CONTAINER=z SRC_LIBRARY=... SRC_SERVER=... ./...
#                                        exercise it against a scratch setup
set -euo pipefail

SRC_LIBRARY=${SRC_LIBRARY:-/srv/storage/data/media/gallery}
SRC_SERVER=${SRC_SERVER:-/srv/appdata/immich/server}
DEST=${DEST:-/srv/backups/immich}
CONTAINER=${CONTAINER:-immich_server}
DB_CONTAINER=${DB_CONTAINER:-immich_postgres}
KEEP=${KEEP:-14}
STOP_TIMEOUT=${STOP_TIMEOUT:-60}
STATUS_URL=${STATUS_URL:-http://127.0.0.1:2283/api/server/ping}
MIN_FREE_GB=${MIN_FREE_GB:-50}
SHRINK_MIN_BYTES=${SHRINK_MIN_BYTES:-$((1024 * 1024 * 1024))}
STAMP=$(date +%Y%m%d-%H%M%S)
HOST=$(hostname)

# name -> source. library is the one on the USB disk, and the one the
# same-disk and shrink checks are about.
PARTS=(library upload profile)
declare -A SRC=(
  [library]=$SRC_LIBRARY
  [upload]=$SRC_SERVER/upload
  [profile]=$SRC_SERVER/profile
)

note() { printf '  %s\n' "$*"; }

TG_HELPER="$(dirname "$0")/notify-telegram.sh"
if [ -f "$TG_HELPER" ]; then
  # shellcheck source=notify-telegram.sh
  . "$TG_HELPER"
else
  tg_backup() { :; }
  echo "  notify-telegram.sh missing at $TG_HELPER - this run will not be reported" >&2
fi

stage="checking the destination"
problems=()
alerts=()
problem() { note "$*"; problems+=("$*"); }
alert() { note "$*"; alerts+=("$*"); }
# Refusing before anything started: the reason goes into the report too, not
# only to stderr, so Telegram and the dashboard say why.
refuse() { problems+=("$*"); echo "$*" >&2; exit 1; }
stopped_by_us=0
down_at=0
downtime=0
snap_name=""
stats_line=""
reported=0
rsync_pid=""

write_status() {
  local result=$1
  [ -d "$DEST" ] || return 0
  RESULT=$result STAMP=$STAMP SNAP=$snap_name DOWNTIME=$downtime \
  STATS=$stats_line DEST=$DEST PROBLEMS=$(printf '%s\n' "${problems[@]+"${problems[@]}"}" "${alerts[@]+"${alerts[@]}"}") \
  python3 -I - <<'PY' > "$DEST/.status.json.tmp" && mv -f "$DEST/.status.json.tmp" "$DEST/status.json"
import json, os, re
e = os.environ
snaps = sorted(n for n in os.listdir(e["DEST"]) if re.fullmatch(r"\d{8}-\d{6}", n))
files, size = (e["STATS"].split() + ["0", "0"])[:2]
print(json.dumps({
    "result": e["RESULT"],
    "run": e["STAMP"],
    "snapshot": e["SNAP"] or None,
    "snapshots": len(snaps),
    "newest": snaps[-1] if snaps else None,
    "files": int(files), "bytes": int(size),
    "downtime_seconds": int(e["DOWNTIME"]),
    "problems": [p for p in e["PROBLEMS"].split("\n") if p],
}))
PY
}

MARK="$DEST/.stopped-by-backup"
running() { [ "$(docker inspect "$1" --format '{{.State.Running}}' 2>/dev/null)" = "true" ]; }
restart_if_ours() {
  [ "$stopped_by_us" = "1" ] || return 0
  # stopped_by_us stays 1 until the container is confirmed running: a signal
  # that kills `docker start` before the daemon acts must leave the trap
  # something to retry.
  local up=0
  for _ in 1 2; do
    docker start "$CONTAINER" >/dev/null 2>&1 || true
    # Immich takes the better part of a minute to answer after a start.
    for _ in $(seq 1 90); do
      if curl -ksf --max-time 3 "$STATUS_URL" >/dev/null; then up=1; break; fi
      running "$CONTAINER" || break
      sleep 2
    done
    running "$CONTAINER" && break
    up=0
  done
  downtime=$(( $(date +%s) - down_at ))
  if ! running "$CONTAINER"; then
    stopped_by_us=0
    alert "$CONTAINER DID NOT START AGAIN - start it: docker start $CONTAINER"
    return 0
  fi
  stopped_by_us=0
  rm -f -- "$MARK"
  if [ "$up" = "1" ]; then
    note "$CONTAINER answering again after ${downtime}s"
  else
    alert "$CONTAINER started but not answering at $STATUS_URL after ${downtime}s"
  fi
}
on_exit() {
  local rc=$?
  if [ -n "$rsync_pid" ]; then
    kill "$rsync_pid" 2>/dev/null || true
    wait "$rsync_pid" 2>/dev/null || true
  fi
  restart_if_ours
  [ "$reported" = "1" ] && return
  [ -n "${WORK:-}" ] && rm -rf -- "$WORK"
  problems+=("stopped early (exit $rc) while $stage")
  write_status failed || true
  tg_backup "Immich backup FAILED on $HOST - stopped early (exit $rc) while $stage.
Run $STAMP.${problems[0]:+ ${problems[0]}}${alerts[0]:+ ${alerts[0]}}"
}
trap on_exit EXIT
trap 'exit 143' TERM INT HUP

# Files and bytes. Immich sets no extended attributes, so unlike OpenCloud's
# count this one does not look for them.
tree_stats() {
  python3 -I - "$@" <<'PY'
import os, sys
files = size = 0
for top in sys.argv[1:]:
    for root, dirs, names in os.walk(top):
        for n in names:
            p = os.path.join(root, n)
            if os.path.isfile(p) and not os.path.islink(p):
                files += 1
                size += os.lstat(p).st_size
print(files, size)
PY
}

copy() {
  rsync "$@" & rsync_pid=$!
  wait "$rsync_pid"
}

# Copies every part into WORK. $1 names the pass for the log.
copy_parts() {
  local pass=$1 name rc
  for name in "${PARTS[@]}"; do
    rc=0
    copy -aHAX --numeric-ids --delete ${PREV:+--link-dest="$PREV/$name"} \
      "${SRC[$name]}/" "$WORK/$name/" || rc=$?
    rsync_pid=""
    if [ "$rc" -ne 0 ]; then
      # 24 is "files vanished during the copy": normal while Immich runs, and
      # the stopped pass picks up whatever moved.
      if [ "$pass" = "live" ]; then
        [ "$rc" -eq 24 ] || note "live copy of $name exited $rc - the stopped pass redoes it"
      else
        problem "rsync of $name exited $rc"
      fi
    fi
  done
}

# ------------------------------------------------------------ preconditions
probe=$DEST
while [ ! -d "$probe" ] && [ "$probe" != "/" ]; do probe=$(dirname "$probe"); done
if [ "$(stat -c %d "$probe")" = "$(stat -c %d "$SRC_LIBRARY" 2>/dev/null || echo none)" ]; then
  refuse "$DEST is on the same disk as $SRC_LIBRARY - refusing, that protects nothing"
fi

# Immich writes a .immich marker into each folder it uses, so a missing one
# means an unmounted disk or a wrong path, not an empty library.
for need in "$SRC_LIBRARY/.immich" "$SRC_SERVER/upload/.immich" "$SRC_SERVER/profile"; do
  [ -e "$need" ] || refuse "$need is missing - is /srv/storage mounted? refusing"
done

mkdir -p "$DEST"
chmod 700 "$DEST"

exec 9>"$DEST/.lock"
flock -n 9 || { echo "another Immich backup is running - leaving it"; reported=1; exit 0; }

find "$DEST" -maxdepth 1 -mindepth 1 -type d -name '.partial-*' -exec rm -rf -- {} +

if [ -f "$MARK" ]; then
  if running "$CONTAINER"; then
    rm -f -- "$MARK"
  else
    stage="starting $CONTAINER, left stopped by an earlier run"
    down_at=$(stat -c %Y "$MARK")
    stopped_by_us=1
    restart_if_ours
    alert "$CONTAINER had been left stopped by an earlier run that died - started it again"
  fi
fi

PREV=$(find "$DEST" -maxdepth 1 -mindepth 1 -type d -regextype posix-extended \
  -regex '.*/[0-9]{8}-[0-9]{6}' | sort | tail -1 || true)
WORK="$DEST/.partial-$STAMP"
mkdir -p "$WORK/db"

prev_bytes=""
[ -n "$PREV" ] && prev_bytes=$(tree_stats "$PREV/library" | cut -d' ' -f2)

stage="checking free space"
src_bytes=$(tree_stats "${SRC[@]}" | cut -d' ' -f2)
# Room for the WHOLE source, not just what grew: --link-dest matches by path,
# so a storage-template change that moves photos copies every moved one in
# full while the total size has not changed at all.
avail=$(df --output=avail -B1 "$DEST" | tail -1 | tr -d ' ')
need=$(( src_bytes + MIN_FREE_GB * 1024 * 1024 * 1024 ))
if [ "$avail" -lt "$need" ]; then
  refuse "NOT ENOUGH SPACE on $DEST: $(numfmt --to=iec "$avail") free, needs $(numfmt --to=iec "$need") (the whole $(numfmt --to=iec "$src_bytes") plus ${MIN_FREE_GB}G kept free) - Immich was not stopped"
fi

image=$(docker inspect "$CONTAINER" --format '{{.Config.Image}}' 2>/dev/null || true)
[ -n "$image" ] || refuse "no container named $CONTAINER"
printf '%s\n' "$image" > "$WORK/image"
running "$DB_CONTAINER" || refuse "$DB_CONTAINER is not running - cannot dump the database"
docker inspect "$DB_CONTAINER" --format '{{.Config.Image}}' > "$WORK/db-image"

# ------------------------------------------------------ pass 1, Immich running
echo "== Immich snapshot $STAMP =="
stage="copying while Immich runs"
t0=$(date +%s)
copy_parts live
note "copy while running: $(( $(date +%s) - t0 ))s"

# ------------------------------------------------------------------- stop
stage="stopping $CONTAINER"
if running "$CONTAINER"; then
  down_at=$(date +%s)
  : > "$MARK"
  stopped_by_us=1
  docker stop --time "$STOP_TIMEOUT" "$CONTAINER" >/dev/null
  note "$CONTAINER stopped"
else
  alert "$CONTAINER was already stopped - copied, and left stopped"
fi

# --------------------------------------------- pass 2, Immich stopped: dump
stage="dumping the database"
cvars=$(docker inspect "$DB_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}')
db_user=$(sed -n 's/^POSTGRES_USER=//p' <<<"$cvars")
db_name=$(sed -n 's/^POSTGRES_DB=//p' <<<"$cvars")
dump="$WORK/db/immich-db.sql.gz"
rc=0
docker exec "$DB_CONTAINER" pg_dump --clean --if-exists -U "$db_user" -d "$db_name" | gzip > "$dump" || rc=$?
# A truncated gzip still leaves a file. A tiny one is a dump of nothing.
if [ "$rc" -ne 0 ] || ! gzip -t "$dump" 2>/dev/null || [ "$(stat -c %s "$dump")" -lt 10240 ]; then
  problem "DATABASE DUMP FAILED or is empty (exit $rc, $(stat -c %s "$dump" 2>/dev/null || echo 0) bytes)"
else
  note "database $(numfmt --to=iec "$(stat -c %s "$dump")")"
fi

stage="copying while Immich is stopped"
copy_parts stopped

stage="checking the copy"
for name in "${PARTS[@]}"; do
  s=$(tree_stats "${SRC[$name]}")
  d=$(tree_stats "$WORK/$name")
  [ "$s" = "$d" ] || problem "COPY OF $name DIFFERS from the source (source: $s, copy: $d - files bytes)"
done
stats_line=$(tree_stats "$WORK/library" "$WORK/upload" "$WORK/profile")
read -r files bytes <<<"$stats_line"
lib_bytes=$(tree_stats "$WORK/library" | cut -d' ' -f2)
note "photos $files files, $(numfmt --to=iec "$bytes")"

stage="starting $CONTAINER again"
restart_if_ours

if [ -n "$prev_bytes" ] && [ "${ALLOW_SHRINK:-0}" != "1" ]; then
  if [ "$lib_bytes" -lt $(( prev_bytes / 2 )) ] && [ $(( prev_bytes - lib_bytes )) -ge "$SHRINK_MIN_BYTES" ]; then
    problem "LIBRARY SHRANK by more than half since the last snapshot ($(numfmt --to=iec "$prev_bytes") to $(numfmt --to=iec "$lib_bytes")) - not kept, nothing rotated. If the delete was real, run once: sudo -u aborii ALLOW_SHRINK=1 $0"
  fi
fi

# ------------------------------------------------------------ keep, rotate
stage="keeping the snapshot"
if [ ${#problems[@]} -eq 0 ]; then
  mv "$WORK" "$DEST/$STAMP"
  ln -sfn "$STAMP" "$DEST/latest"
  snap_name=$STAMP

  stage="rotating old snapshots"
  mapfile -t snaps < <(find "$DEST" -maxdepth 1 -mindepth 1 -type d -regextype posix-extended \
    -regex '.*/[0-9]{8}-[0-9]{6}' | sort)
  if [ ${#snaps[@]} -gt "$KEEP" ]; then
    for s in "${snaps[@]:0:$(( ${#snaps[@]} - KEEP ))}"; do rm -rf -- "$s"; done
    note "removed $(( ${#snaps[@]} - KEEP )), $KEEP kept"
  else
    note "${#snaps[@]} snapshot(s) kept"
  fi
else
  rm -rf -- "$WORK"
  note "snapshot NOT kept"
fi

# ------------------------------------------------------------------ report
reported=1
if [ ${#problems[@]} -eq 0 ] && [ ${#alerts[@]} -eq 0 ]; then
  write_status ok
  tg_backup "Immich backup OK on $HOST - snapshot $STAMP
$files files, $(numfmt --to=iec "$bytes"), Immich down ${downtime}s"
  echo "  OK"
else
  write_status failed
  msg="Immich backup FAILED on $HOST - run $STAMP"
  [ -n "$snap_name" ] && msg+=$'\nThe snapshot itself was kept: '"$snap_name"
  for p in "${problems[@]}" "${alerts[@]}"; do [ -n "$p" ] && msg+=$'\n- '"$p"; done
  msg+=$'\nDetails: journalctl -u media-stack-immich-backup.service'
  tg_backup "$msg"
  echo "  FINISHED WITH ERRORS" >&2
  exit 1
fi
