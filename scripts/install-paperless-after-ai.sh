#!/usr/bin/env bash
# Install the 10-minute fix-up of paperless-gpt's results, and run it once
# now. A user timer: run it as aborii, not with sudo.
set -euo pipefail

DEST=$HOME/.config/systemd/user
SRC=/home/aborii/media-stack/systemd

[ "$(id -u)" -ne 0 ] || { echo "run as aborii, not root - these are user units" >&2; exit 1; }

mkdir -p "$DEST"
for unit in paperless-after-ai.service paperless-after-ai.timer; do
  [ -f "$SRC/$unit" ] || { echo "missing unit file: $SRC/$unit" >&2; exit 1; }
  install -m 644 "$SRC/$unit" "$DEST/$unit"
done
systemctl --user daemon-reload
systemctl --user enable --now paperless-after-ai.timer
systemctl --user start paperless-after-ai.service

echo
echo "== next run =="
systemctl --user list-timers paperless-after-ai.timer --no-pager | head -2
echo
echo "== this run =="
journalctl --user -u paperless-after-ai.service -n 5 --no-pager -o cat
