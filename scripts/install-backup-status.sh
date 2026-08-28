#!/usr/bin/env bash
# Install and start the backup status service that feeds the Homepage tile.
#
# Separate from the unit file so the command you type stays short. A long
# ssh one-liner full of && and quotes is passed through two shells before it
# runs, and the second one is where an unbalanced quote shows up as a confusing
# "unexpected EOF" from bash rather than from anything you wrote.
set -euo pipefail

UNIT=media-stack-backup-status.service
SRC=/home/aborii/media-stack/systemd/$UNIT

[ "$(id -u)" -eq 0 ] || { echo "run with sudo - this installs a systemd unit" >&2; exit 1; }
[ -f "$SRC" ] || { echo "missing unit file: $SRC" >&2; exit 1; }

install -m 644 "$SRC" /etc/systemd/system/$UNIT
systemctl daemon-reload
systemctl enable --now $UNIT

# Give it a moment to bind before asking whether it works.
sleep 2

echo
echo "== unit =="
systemctl is-active $UNIT
echo
echo "== what it serves =="
if command -v curl >/dev/null 2>&1; then
  curl -s --max-time 5 http://127.0.0.1:9101/ || echo "  no response yet - check: journalctl -u $UNIT -n 20"
else
  python3 -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:9101/',timeout=5).read().decode())"
fi
echo
