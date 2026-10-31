#!/usr/bin/env bash
# Install the nightly copy of the Paperless library to the storage share, and
# run it once now. A user timer: run it as aborii, not with sudo.
set -euo pipefail

DEST=$HOME/.config/systemd/user
SRC=/home/aborii/media-stack/systemd

[ "$(id -u)" -ne 0 ] || { echo "run as aborii, not root - these are user units" >&2; exit 1; }

mkdir -p "$DEST"
for unit in paperless-library-sync.service paperless-library-sync.timer; do
  [ -f "$SRC/$unit" ] || { echo "missing unit file: $SRC/$unit" >&2; exit 1; }
  install -m 644 "$SRC/$unit" "$DEST/$unit"
done
systemctl --user daemon-reload
systemctl --user enable --now paperless-library-sync.timer
systemctl --user start paperless-library-sync.service

echo
echo "== next run =="
systemctl --user list-timers paperless-library-sync.timer --no-pager | head -2
echo
echo "== this run =="
journalctl --user -u paperless-library-sync.service -n 3 --no-pager -o cat
