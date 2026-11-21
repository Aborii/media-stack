#!/bin/bash
# Install the nightly OpenCloud snapshot.
#
#   sudo /home/aborii/media-stack/scripts/install-opencloud-backup.sh
#
# Creates the destination on the NVMe for aborii, installs the unit and timer,
# and enables the timer. It does NOT take a snapshot: that stops OpenCloud for
# a few seconds, so the first one is yours to start, with the command it prints.
set -euo pipefail

REPO=${REPO:-/home/aborii/media-stack}
UNITS=${UNITS:-/etc/systemd/system}
DEST=${DEST:-/srv/backups/opencloud}
OWNER=${OWNER:-aborii}

[ "$(id -u)" -eq 0 ] || { echo "run with sudo - this installs systemd units and creates $DEST" >&2; exit 1; }

note() { printf '  %s\n' "$*"; }

echo "== destination =="
# /srv/backups is root's, like /srv. Only the OpenCloud folder inside belongs
# to aborii, and only aborii can read it: config/ holds OpenCloud's secrets.
install -d -m 755 -o root -g root "$(dirname "$DEST")"
install -d -m 700 -o "$OWNER" -g "$OWNER" "$DEST"
note "$DEST  $(stat -c '%U %a' "$DEST"), on $(findmnt -T "$DEST" -no SOURCE)"

echo
echo "== units =="
install -m 644 "$REPO/systemd/media-stack-opencloud-backup.service" "$UNITS/"
install -m 644 "$REPO/systemd/media-stack-opencloud-backup.timer" "$UNITS/"
systemctl daemon-reload
systemctl enable --now media-stack-opencloud-backup.timer
systemctl list-timers media-stack-opencloud-backup.timer --no-pager | head -2

echo
echo "First snapshot (OpenCloud is down for a few seconds):"
echo "  sudo systemctl start media-stack-opencloud-backup.service"
echo "  journalctl -u media-stack-opencloud-backup.service -n 20"
