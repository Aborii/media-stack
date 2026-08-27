#!/bin/bash
# Install the offsite flush timer.
#
# Run once:
#
#   sudo /home/aborii/media-stack/scripts/install-offsite-flush.sh
#
# It installs the unit and timer, starts them, and marks the two archives that
# are ALREADY on the PC as delivered so the first tick does not re-upload 1.4GB
# for nothing.
set -euo pipefail

REPO=${REPO:-/home/aborii/media-stack}
UNITS=${UNITS:-/etc/systemd/system}
OFFSITE=${OFFSITE:-/srv/storage/backups/offsite}

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }

note() { printf '  %s\n' "$*"; }

echo "== units =="
install -m 644 "$REPO/systemd/media-stack-offsite-flush.service" "$UNITS/"
install -m 644 "$REPO/systemd/media-stack-offsite-flush.timer" "$UNITS/"
note "installed into $UNITS"

systemctl daemon-reload
systemctl enable --now media-stack-offsite-flush.timer
note "timer enabled and started"

# --------------------------------------------------------------- already sent
# These two were uploaded before the queue existed, so they carry no .sent
# marker and the first flush would send them again - 1.4GB to tell the receiver
# something it already has.
#
# Marking them delivered is only honest if they really did arrive. Both were
# compared on 2026-08-26: the sha256 of the copy sitting in D:\Backups\pi\archives
# on the PC matched the .sha256 the Pi declared for it, byte for byte. The
# receiver's own log records both as "verified" at upload time.
#
# The name check below is deliberately explicit. Marking "everything currently
# staged" as sent would be a guess, and a wrong guess here means an archive that
# never left the Pi is recorded as safely off-box - the precise failure this
# whole queue was built to stop.
echo
echo "== pre-marking verified deliveries =="
for name in media-stack-20260826-002153.tar.gz media-stack-20260826-033321.tar.gz; do
  a="$OFFSITE/$name"
  if [ ! -f "$a" ]; then note "$name  not staged any more - skipping"; continue; fi
  if [ -f "$a.sent" ]; then note "$name  already marked"; continue; fi
  # Re-verify the Pi-side copy against its own checksum first. If the staged file
  # has rotted since, it is not the file that was compared and must not inherit
  # that comparison's result - leave it pending and let the flush re-send it.
  want=$(cat "$a.sha256" 2>/dev/null || true)
  got=$(sha256sum "$a" | awk '{print $1}')
  if [ -n "$want" ] && [ "$want" = "$got" ]; then
    : > "$a.sent"
    note "$name  marked delivered"
  else
    note "$name  CHECKSUM DRIFTED - left pending, the flush will re-send it"
  fi
done

echo
echo "== state =="
systemctl list-timers media-stack-offsite-flush.timer --no-pager | head -3
echo
"$REPO/scripts/flush-offsite.sh" || true
