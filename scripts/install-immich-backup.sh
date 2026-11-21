#!/bin/bash
# Install the nightly Immich snapshot.
#
#   sudo /home/aborii/media-stack/scripts/install-immich-backup.sh
#
# Creates the destination on the NVMe for aborii, installs the unit and timer,
# and enables the timer. It does NOT take a snapshot: that copies the whole
# photo library the first time and stops Immich for a few seconds, so the first
# one is yours to start, with the command it prints.
set -euo pipefail

REPO=${REPO:-/home/aborii/media-stack}
UNITS=${UNITS:-/etc/systemd/system}
DEST=${DEST:-/srv/backups/immich}
OWNER=${OWNER:-aborii}

[ "$(id -u)" -eq 0 ] || { echo "run with sudo - this installs systemd units and creates $DEST" >&2; exit 1; }

note() { printf '  %s\n' "$*"; }

echo "== destination =="
# /srv/backups is root's, like /srv. Only the Immich folder inside belongs
# to aborii, and only aborii can read it: it holds your photos and database.
install -d -m 755 -o root -g root "$(dirname "$DEST")"
install -d -m 700 -o "$OWNER" -g "$OWNER" "$DEST"
note "$DEST  $(stat -c '%U %a' "$DEST"), on $(findmnt -T "$DEST" -no SOURCE)"

echo
echo "== units =="
install -m 644 "$REPO/systemd/media-stack-immich-backup.service" "$UNITS/"
install -m 644 "$REPO/systemd/media-stack-immich-backup.timer" "$UNITS/"
systemctl daemon-reload
systemctl enable --now media-stack-immich-backup.timer
systemctl list-timers media-stack-immich-backup.timer --no-pager | head -2

echo
echo "First snapshot (copies the library while Immich runs, then stops it for seconds):"
echo "  sudo systemctl start media-stack-immich-backup.service"
echo "  journalctl -u media-stack-immich-backup.service -n 20"
