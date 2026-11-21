#!/bin/bash
# Snapshot OpenCloud onto the NVMe, off the disk its files live on.
#
# WHY THIS EXISTS
#
# OpenCloud keeps its files on the big USB disk (/srv/storage/data/opencloud),
# and backup.sh writes to that same disk. A copy there survives a bad delete,
# not the disk dying - and this disk has dropped offline under load before. So
# this copy goes to the NVMe, and the run refuses outright if the destination
# turns out to be on the same filesystem as the files.
#
# WHY IT STOPS OPENCLOUD
#
# OpenCloud's own backup page: "To create a consistent backup, the OpenCloud
# instance must be stopped before starting the backup process." There is no
# maintenance or read-only mode. The files, their metadata (.oc-nodes, the .mpk
# files under storage/), the user database (idm/idm.boltdb) and the event
# streams (nats/) are written separately; a copy taken while it runs can hold a
# file whose metadata says something else, or a user database older than the
# shares pointing into it. So: stop the one container, copy, check, start.
# Euro-Office stays up; it only waits on OpenCloud for those seconds.
#
# The search index is copied too. The docs say a restore without it has to be
# re-indexed, and it is small.
#
# WHAT A SNAPSHOT HOLDS
#
#   <stamp>/data/     /srv/storage/data/opencloud, extended attributes kept -
#                     storage/users keeps user.oc.id and friends on its folders,
#                     and a copy without them is a tree OpenCloud cannot read
#   <stamp>/config/   /srv/appdata/opencloud/config: the secrets the data was
#                     written with. backup.sh copies this too, but a restore
#                     needs the pair from the SAME moment, so it comes along
#   <stamp>/image     the image the data was written by; the docs warn that
#                     restoring into another version can fail
#
# Snapshots are hard-linked to the previous one (rsync --link-dest), so only
# changed files take new space. Each is built under .partial-<stamp> and renamed
# only once it has passed every check. A crash, a full disk or a failed check
# therefore never leaves something that looks like a snapshot, and rotation
# never counts one.
#
#   ./backup-opencloud.sh                 back up (as aborii - docker group)
#   KEEP=30 ./backup-opencloud.sh         keep more snapshots
#   ALLOW_SHRINK=1 ./backup-opencloud.sh  after a real delete of over half the data
#   DEST=/x CONTAINER=y ./...             exercise it against a scratch setup
set -euo pipefail

SRC_DATA=${SRC_DATA:-/srv/storage/data/opencloud}
SRC_CONFIG=${SRC_CONFIG:-/srv/appdata/opencloud/config}
DEST=${DEST:-/srv/backups/opencloud}
CONTAINER=${CONTAINER:-opencloud}
KEEP=${KEEP:-14}
STOP_TIMEOUT=${STOP_TIMEOUT:-60}
STATUS_URL=${STATUS_URL:-http://127.0.0.1:9200/status.php}
# The NVMe also holds Docker and every database. A copy that fills it takes
# them down too, so the run refuses before it starts if less than this would
# be left.
MIN_FREE_GB=${MIN_FREE_GB:-50}
# The shrink guard below only trips on a drop at least this large, so deleting
# a few files from a small OpenCloud does not stop every later snapshot.
SHRINK_MIN_BYTES=${SHRINK_MIN_BYTES:-$((1024 * 1024 * 1024))}
STAMP=$(date +%Y%m%d-%H%M%S)
HOST=$(hostname)

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
# Two lists. A problem means the copy cannot be trusted, so it is not kept. An
# alert fails the report but keeps a copy that passed every check - a slow
# restart afterwards says nothing about the copy taken while it was stopped.
problems=()
alerts=()
problem() { note "$*"; problems+=("$*"); }
alert() { note "$*"; alerts+=("$*"); }
stopped_by_us=0
down_at=0
downtime=0
snap_name=""
stats_line=""
reported=0
rsync_pid=""

# The dashboard reads this. Written to a temp name and renamed, so a reader
# never sees half a file.
write_status() {
  local result=$1
  [ -d "$DEST" ] || return 0
  RESULT=$result STAMP=$STAMP SNAP=$snap_name DOWNTIME=$downtime \
  STATS=$stats_line DEST=$DEST PROBLEMS=$(printf '%s\n' "${problems[@]+"${problems[@]}"}" "${alerts[@]+"${alerts[@]}"}") \
  python3 -I - <<'PY' > "$DEST/.status.json.tmp" && mv -f "$DEST/.status.json.tmp" "$DEST/status.json"
import json, os, re
e = os.environ
snaps = sorted(n for n in os.listdir(e["DEST"]) if re.fullmatch(r"\d{8}-\d{6}", n))
files, size, xattrs = (e["STATS"].split() + ["0", "0", "0"])[:3]
print(json.dumps({
    "result": e["RESULT"],
    "run": e["STAMP"],
    "snapshot": e["SNAP"] or None,
    "snapshots": len(snaps),
    "newest": snaps[-1] if snaps else None,
    "files": int(files), "bytes": int(size), "xattr_entries": int(xattrs),
    "downtime_seconds": int(e["DOWNTIME"]),
    "problems": [p for p in e["PROBLEMS"].split("\n") if p],
}))
PY
}

# The one thing this script must never do is leave OpenCloud stopped. set -e
# can end the run anywhere, so the EXIT trap starts it again, and reports.
#
# Memory is not enough for that: a power cut or a SIGKILL between the stop and
# the start skips every trap, and the container's unless-stopped policy then
# keeps it down through the reboot. So the stop is also written to disk
# (MARK), and the next run finishes the job - see "left stopped" below.
MARK="$DEST/.stopped-by-backup"
running() { [ "$(docker inspect "$CONTAINER" --format '{{.State.Running}}' 2>/dev/null)" = "true" ]; }
restart_if_ours() {
  [ "$stopped_by_us" = "1" ] || return 0
  stopped_by_us=0
  local up=0
  # Twice: a SIGTERM during `docker stop` ends the client but not the stop the
  # daemon is carrying out, so the first start can land on a container that is
  # still running and about to go down. Checking afterwards catches that.
  for _ in 1 2; do
    docker start "$CONTAINER" >/dev/null 2>&1 || true
    # Downtime runs until it answers again, not until the container starts:
    # OpenCloud takes several seconds more to come up.
    for _ in $(seq 1 60); do
      if curl -ksf --max-time 3 "$STATUS_URL" >/dev/null; then up=1; break; fi
      running || break
      sleep 2
    done
    running && break
    up=0
  done
  downtime=$(( $(date +%s) - down_at ))
  if ! running; then
    alert "$CONTAINER DID NOT START AGAIN - start it: docker start $CONTAINER"
    return 0
  fi
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
  # A copy that never reached its checks is litter, not a snapshot, and on the
  # NVMe it is space Docker and the databases need.
  [ -n "${WORK:-}" ] && rm -rf -- "$WORK"
  problems+=("stopped early (exit $rc) while $stage")
  write_status failed || true
  tg_backup "OpenCloud backup FAILED on $HOST - stopped early (exit $rc) while $stage.
Run $STAMP.${problems[0]:+ ${problems[0]}}${alerts[0]:+ ${alerts[0]}}"
}
trap on_exit EXIT
# bash skips the EXIT trap when a signal it does not handle kills it, and
# systemd stops a unit with SIGTERM. Without this, a stop or a timeout in the
# middle of the copy would leave OpenCloud down.
trap 'exit 143' TERM INT HUP

# Files, bytes and entries carrying extended attributes. rsync does not treat a
# skipped file as an error worth failing on, which is how backups here have
# looked complete and held nothing; so the copy is counted, not trusted.
tree_stats() {
  python3 -I - "$1" <<'PY'
import os, sys
files = size = xattrs = 0
for root, dirs, names in os.walk(sys.argv[1]):
    for n in dirs + names:
        p = os.path.join(root, n)
        try:
            if os.listxattr(p, follow_symlinks=False):
                xattrs += 1
        except OSError:
            pass
    for n in names:
        p = os.path.join(root, n)
        if os.path.isfile(p) and not os.path.islink(p):
            files += 1
            size += os.lstat(p).st_size
print(files, size, xattrs)
PY
}

# ------------------------------------------------------------ preconditions
# Off the data disk, or this is no protection at all. Walk to the nearest
# existing ancestor, since on a first run DEST does not exist yet.
probe=$DEST
while [ ! -d "$probe" ] && [ "$probe" != "/" ]; do probe=$(dirname "$probe"); done
if [ "$(stat -c %d "$probe")" = "$(stat -c %d "$SRC_DATA" 2>/dev/null || echo none)" ]; then
  echo "$DEST is on the same disk as $SRC_DATA - refusing, that protects nothing" >&2
  exit 1
fi

# An unmounted data disk leaves an empty directory (or none) at SRC_DATA.
# Snapshotting that would "succeed", and fourteen of them would rotate every
# real snapshot away. These two exist in any OpenCloud that has ever started.
for need in idm/idm.boltdb storage/users; do
  [ -e "$SRC_DATA/$need" ] || {
    echo "$SRC_DATA/$need is missing - is /srv/storage mounted? refusing" >&2
    exit 1
  }
done

mkdir -p "$DEST"
chmod 700 "$DEST"   # config/ holds OpenCloud's secrets

# One run at a time: a manual run and the timer must not race on .partial.
exec 9>"$DEST/.lock"
flock -n 9 || { echo "another OpenCloud backup is running - leaving it"; reported=1; exit 0; }

# Leftovers from a run that died. Never complete, so never a snapshot.
find "$DEST" -maxdepth 1 -mindepth 1 -type d -name '.partial-*' -exec rm -rf -- {} +

# Left stopped: an earlier run stopped OpenCloud and died before starting it.
if [ -f "$MARK" ]; then
  if running; then
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
mkdir -p "$WORK"
# Measured before the stop, so it costs no downtime.
prev_bytes=""
[ -n "$PREV" ] && prev_bytes=$(tree_stats "$PREV/data" | cut -d' ' -f2)

# Room for what is new since the last snapshot (the rest is hard-linked), plus
# the floor. Checked before the stop, so a full disk costs no downtime either.
stage="checking free space"
src_bytes=$(tree_stats "$SRC_DATA" | cut -d' ' -f2)
growth=$(( src_bytes - ${prev_bytes:-0} ))
[ "$growth" -gt 0 ] || growth=0
avail=$(df --output=avail -B1 "$DEST" | tail -1 | tr -d ' ')
need=$(( growth + MIN_FREE_GB * 1024 * 1024 * 1024 ))
if [ "$avail" -lt "$need" ]; then
  problems+=("NOT ENOUGH SPACE on $DEST: $(numfmt --to=iec "$avail") free, needs $(numfmt --to=iec "$need") ($(numfmt --to=iec "$growth") new plus ${MIN_FREE_GB}G kept free) - OpenCloud was not stopped")
  echo "${problems[-1]}" >&2
  exit 1
fi

# ------------------------------------------------------------------- stop
stage="stopping $CONTAINER"
echo "== OpenCloud snapshot $STAMP =="
image=$(docker inspect "$CONTAINER" --format '{{.Config.Image}}' 2>/dev/null || true)
[ -n "$image" ] || { echo "no container named $CONTAINER" >&2; exit 1; }
printf '%s\n' "$image" > "$WORK/image"
if running; then
  down_at=$(date +%s)
  : > "$MARK"
  stopped_by_us=1
  docker stop --time "$STOP_TIMEOUT" "$CONTAINER" >/dev/null
  note "$CONTAINER stopped"
else
  # Someone stopped it on purpose, so it is not this script's place to bring
  # it back. The copy is just as consistent - but an OpenCloud that is down
  # must not read as a quiet "OK" night after night.
  alert "$CONTAINER was already stopped - copied, and left stopped"
fi

# ------------------------------------------------------------------- copy
stage="copying OpenCloud"
rsync_args=(-aHAX --numeric-ids --delete)
# In the background and waited on: bash holds a signal until a foreground
# command finishes, so a stop during a long copy would keep OpenCloud down
# until the copy ended. `wait` returns at once, and the EXIT trap ends rsync.
copy() {
  rsync "$@" & rsync_pid=$!
  wait "$rsync_pid"
}
rc=0
copy "${rsync_args[@]}" ${PREV:+--link-dest="$PREV/data"} "$SRC_DATA/" "$WORK/data/" || rc=$?
[ "$rc" -eq 0 ] || problem "rsync of the data exited $rc"
rc=0
copy "${rsync_args[@]}" ${PREV:+--link-dest="$PREV/config"} "$SRC_CONFIG/" "$WORK/config/" || rc=$?
rsync_pid=""
[ "$rc" -eq 0 ] || problem "rsync of the config exited $rc"

# Counted while OpenCloud is still stopped: nothing is writing, so source and
# copy must agree EXACTLY. Any difference means something was skipped.
stage="checking the copy"
src_stats=$(tree_stats "$SRC_DATA")
dst_stats=$(tree_stats "$WORK/data")
cfg_src=$(tree_stats "$SRC_CONFIG")
cfg_dst=$(tree_stats "$WORK/config")
stats_line=$dst_stats
read -r files bytes xattrs <<<"$dst_stats"
note "data   $files files, $(numfmt --to=iec "$bytes"), $xattrs with extended attributes"
[ "$src_stats" = "$dst_stats" ] || problem "COPY DIFFERS from the source (source: $src_stats, copy: $dst_stats - files bytes xattrs)"
[ "$cfg_src" = "$cfg_dst" ] || problem "CONFIG COPY DIFFERS (source: $cfg_src, copy: $cfg_dst)"

stage="starting $CONTAINER again"
restart_if_ours

# A copy far smaller than the last kept snapshot is more likely a disk that
# came up half-mounted or a sync gone wrong than a real mass delete. It is not
# kept as a snapshot and nothing is rotated, so it cannot push the good ones
# out. Both halves must hold: less than half, AND a large drop - at a few MB,
# deleting one file halves the size and must not stop every later snapshot.
# Measured from the snapshot itself, not from status.json, which a failed run
# rewrites.
if [ -n "$prev_bytes" ] && [ "${ALLOW_SHRINK:-0}" != "1" ]; then
  if [ "$bytes" -lt $(( prev_bytes / 2 )) ] && [ $(( prev_bytes - bytes )) -ge "$SHRINK_MIN_BYTES" ]; then
    problem "SHRANK by more than half since the last snapshot ($(numfmt --to=iec "$prev_bytes") to $(numfmt --to=iec "$bytes")) - not kept, nothing rotated. If the delete was real, run once: sudo -u aborii ALLOW_SHRINK=1 $0"
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
  # Deleted now rather than left for the next run: it shares the NVMe with
  # Docker and the databases, and the journal already says what was wrong.
  rm -rf -- "$WORK"
  note "snapshot NOT kept"
fi

# ------------------------------------------------------------------ report
reported=1
if [ ${#problems[@]} -eq 0 ] && [ ${#alerts[@]} -eq 0 ]; then
  write_status ok
  tg_backup "OpenCloud backup OK on $HOST - snapshot $STAMP
$files files, $(numfmt --to=iec "$bytes"), OpenCloud down ${downtime}s"
  echo "  OK"
else
  write_status failed
  msg="OpenCloud backup FAILED on $HOST - run $STAMP"
  [ -n "$snap_name" ] && msg+=$'\nThe snapshot itself was kept: '"$snap_name"
  for p in "${problems[@]}" "${alerts[@]}"; do [ -n "$p" ] && msg+=$'\n- '"$p"; done
  msg+=$'\nDetails: journalctl -u media-stack-opencloud-backup.service'
  tg_backup "$msg"
  echo "  FINISHED WITH ERRORS" >&2
  exit 1
fi
