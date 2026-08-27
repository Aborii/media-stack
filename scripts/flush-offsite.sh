#!/bin/bash
# Send any backup archive that has not reached the offsite receiver yet.
#
# WHY THIS EXISTS
#
# backup.sh used to upload inline, once, and treat a failure as fine because
# "the PC is often off". Two things were wrong with that.
#
# The retry only came around at the NEXT nightly run. A PC that is off at 03:30
# but on all day therefore never received a single archive - not late, never.
# The one machine holding an off-disk copy was the one machine least likely to
# be awake at half three in the morning.
#
# Worse, the staging pruner kept "the 3 newest" without asking whether they had
# been sent. So a run of offline nights quietly deleted un-uploaded archives to
# make room for newer un-uploaded archives. The queue ate itself, and the log
# said "3 kept" either way.
#
# WHY A TIMER AND A QUEUE, NOT A PINGER
#
# The obvious shape is a process that wakes on failure and polls until the PC
# answers. That process is state: it has to be started, stopped, and brought
# back after a reboot, and when it dies the uploads stop with nothing to say so.
# This whole script family exists because rsync reported success while silently
# skipping directories - a daemon that silently stops retrying is the same
# failure wearing a different hat.
#
# So there is no daemon. The queue is the offsite directory itself: an archive
# with no `.sent` marker beside it has not been accepted, and a timer tries the
# unsent ones every 30 minutes. Nothing to start, nothing to leak, and a reboot
# resumes exactly where it left off because the state was never in memory.
#
# MARKERS
#
#   media-stack-<stamp>.tar.gz          the archive
#   media-stack-<stamp>.tar.gz.sha256   its checksum, made by backup.sh
#   media-stack-<stamp>.tar.gz.sent     receiver accepted it - stop trying
#   media-stack-<stamp>.tar.gz.bad      receiver REFUSED the contents - never
#                                       retry, and say so loudly
#
# `.bad` matters. Without it a corrupt archive is re-offered every 30 minutes
# forever, burying every other line in the log and blocking nothing usefully.
#
#   sudo ./flush-offsite.sh              send whatever is pending
#   sudo DRY=1 ./flush-offsite.sh        show what would be sent
#   DEST=/tmp/t ./flush-offsite.sh       exercise it against a scratch queue
set -euo pipefail

DEST=${DEST:-/srv/storage/backups}
OFFSITE="$DEST/offsite"
UPLOAD_URL=${UPLOAD_URL:-http://100.72.210.100:8899/upload}
UPLOAD_KEY_FILE=${UPLOAD_KEY_FILE:-/srv/storage/appdata/backup-receiver.key}
# Resolved archives (sent or bad) are staging litter - the real retention lives
# on the receiver, which keeps 7. Pending archives are NOT litter and are capped
# separately and far higher.
KEEP_RESOLVED=${KEEP_RESOLVED:-3}
# At ~1GB an archive this is ~14GB against 5.6TB free, so the cap exists to stop
# a runaway, not to save space. Reaching it means the PC has been off a
# fortnight and that deserves a loud line, not a silent delete.
MAX_PENDING=${MAX_PENDING:-14}
DRY=${DRY:-0}

note() { printf '  %s\n' "$*"; }

# Writability, not uid. The offsite directory is root-owned so in practice this
# means sudo - but testing the queue logic against a scratch DEST you own should
# not need root, and a uid check would refuse that for no reason. It also gives a
# better failure: "cannot write here" is the actual problem, where "not root" is
# only usually the cause.
mkdir -p "$OFFSITE" 2>/dev/null || true
[ -w "$OFFSITE" ] || { echo "cannot write $OFFSITE - run with sudo" >&2; exit 1; }
fail=0

# One flush at a time. A gigabyte over Tailscale can outlast the 30 minute tick,
# and two overlapping runs would send the same archive twice and race on the
# markers. A tick that finds the lock held has nothing to do - the running flush
# is already handling the queue - so it leaves quietly rather than erroring.
exec 9>"$OFFSITE/.flush.lock"
if ! flock -n 9; then
  echo "a flush is already running - leaving it to finish"
  exit 0
fi

shopt -s nullglob
archives=("$OFFSITE"/media-stack-*.tar.gz)
shopt -u nullglob

pending=()
for a in "${archives[@]}"; do
  [ -f "$a.sent" ] && continue
  [ -f "$a.bad" ] && continue
  pending+=("$a")
done

echo "== offsite flush =="
if [ ${#pending[@]} -eq 0 ]; then
  note "nothing pending (${#archives[@]} archive(s) staged)"
else
  # Newest first, deliberately. If the PC is only briefly awake we want the most
  # recent data across before the link goes away; the older archives it
  # supersedes can wait for the next tick. Out-of-order arrival costs nothing on
  # the receiver, which rotates by the timestamp in the FILENAME, not by when
  # the bytes turned up.
  mapfile -t pending < <(printf '%s\n' "${pending[@]}" | sort -r)
  note "${#pending[@]} pending"
fi

if [ ! -f "$UPLOAD_KEY_FILE" ] && [ ${#pending[@]} -gt 0 ]; then
  note "NO KEY at $UPLOAD_KEY_FILE - cannot upload"
  exit 1
fi

sent=0
for a in "${pending[@]}"; do
  name=$(basename "$a")
  sha=$(cat "$a.sha256" 2>/dev/null || true)

  if [ -z "$sha" ]; then
    # backup.sh writes the checksum immediately after the tar. Missing means the
    # archive was interrupted mid-build, and the receiver would refuse it on the
    # checksum header anyway - so refuse it here and save the gigabyte.
    note "$name  NO CHECKSUM - marking bad"
    : > "$a.bad"
    fail=1
    continue
  fi

  if [ "$DRY" = "1" ]; then
    note "$name  would send ($(du -h "$a" | cut -f1))"
    continue
  fi

  # No --fail: it collapses every HTTP error into exit 22 and the code is the
  # whole point. A 400 means this archive is bad and must stop being retried; a
  # 401 means the KEY is wrong and every archive will fail, so marking them bad
  # would destroy the queue over a config mistake. Those must not read alike.
  err=$(mktemp)
  code=$(curl -sS --max-time 3600 -o /dev/null -w '%{http_code}' -T "$a" \
    -H "X-Backup-Key: $(cat "$UPLOAD_KEY_FILE")" \
    -H "X-Backup-Name: $name" \
    -H "X-Backup-Sha256: $sha" \
    "$UPLOAD_URL" 2>"$err") && rc=0 || rc=$?
  detail=$(tr -d '\r' < "$err" | tail -1)
  rm -f "$err"

  case "$code" in
    200)
      : > "$a.sent"
      sent=$((sent + 1))
      note "$name  sent ($(du -h "$a" | cut -f1))"
      ;;
    000)
      # Never connected. Expected whenever the PC is off, and NOT an error - the
      # local backup is intact and the next tick is 30 minutes away. Stop the
      # run: if this archive could not reach the receiver, neither will the rest.
      note "receiver unreachable - PC is probably off (${#pending[@]} still pending)"
      break
      ;;
    400|413)
      # The receiver inspected the archive and rejected it: checksum mismatch,
      # not a gzipped tar, too small, too large. All permanent properties of
      # this file. Retrying costs a gigabyte of upload to be told the same thing.
      note "$name  REFUSED ($code ${detail:-no detail}) - marking bad, will not retry"
      : > "$a.bad"
      fail=1
      ;;
    401)
      note "REFUSED: receiver rejected the key - fix $UPLOAD_KEY_FILE"
      fail=1
      break
      ;;
    *)
      note "$name  upload failed (http ${code:-?}, curl $rc) ${detail:-}"
      fail=1
      break
      ;;
  esac
done

[ "$sent" -gt 0 ] && note "$sent archive(s) delivered"

# ------------------------------------------------------------------ retention
# Two classes, two rules. This is the bug the old inline pruner had: it counted
# archives without looking at whether they had been delivered.
if [ "$DRY" != "1" ]; then
  shopt -s nullglob
  resolved=()
  still_pending=()
  for a in "$OFFSITE"/media-stack-*.tar.gz; do
    if [ -f "$a.sent" ] || [ -f "$a.bad" ]; then
      resolved+=("$a")
    else
      still_pending+=("$a")
    fi
  done
  shopt -u nullglob

  # Delivered (or permanently rejected) - safe to drop, the receiver holds these.
  if [ ${#resolved[@]} -gt "$KEEP_RESOLVED" ]; then
    n=0
    while IFS= read -r a; do
      n=$((n + 1))
      [ "$n" -le "$KEEP_RESOLVED" ] && continue
      rm -f -- "$a" "$a.sha256" "$a.sent" "$a.bad"
    done < <(printf '%s\n' "${resolved[@]}" | sort -r)
    note "staged: removed $(( ${#resolved[@]} - KEEP_RESOLVED )) delivered, $KEEP_RESOLVED kept"
  fi

  # Undelivered. These are the only copy outside the running system, so the cap
  # is a backstop and dropping one is worth a shout. Oldest goes first: the
  # newest archive holds the most recent data and is the one worth keeping if we
  # can only keep some.
  if [ ${#still_pending[@]} -gt "$MAX_PENDING" ]; then
    over=$(( ${#still_pending[@]} - MAX_PENDING ))
    note "PENDING CAP HIT: $over undelivered archive(s) dropped - the PC has not"
    note "  accepted a backup in ${#still_pending[@]} runs. Bring it online."
    while IFS= read -r a; do
      rm -f -- "$a" "$a.sha256"
      note "  dropped $(basename "$a")"
      over=$((over - 1))
      [ "$over" -le 0 ] && break
    done < <(printf '%s\n' "${still_pending[@]}" | sort)
    fail=1
  elif [ ${#still_pending[@]} -gt 0 ]; then
    note "${#still_pending[@]} archive(s) still waiting for the receiver"
  fi

  # Counted AFTER the prune, not before. A count taken earlier would name a bad
  # archive that this very run had just deleted - the sort of true-once line that
  # sends you looking for a file that is not there.
  shopt -s nullglob
  bad=("$OFFSITE"/media-stack-*.tar.gz.bad)
  shopt -u nullglob
  [ ${#bad[@]} -gt 0 ] && note "${#bad[@]} archive(s) marked BAD - refused, not sent"
fi

exit "$fail"
