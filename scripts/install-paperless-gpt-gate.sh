#!/usr/bin/env bash
# Install and start the gate that runs paperless-gpt only while the PC's
# Ollama answers. A user unit: run it as aborii, not with sudo.
set -euo pipefail

UNIT=paperless-gpt-gate.service
SRC=/home/aborii/media-stack/systemd/$UNIT
DEST=$HOME/.config/systemd/user

[ "$(id -u)" -ne 0 ] || { echo "run as aborii, not root - this is a user unit" >&2; exit 1; }
[ -f "$SRC" ] || { echo "missing unit file: $SRC" >&2; exit 1; }
[ "$(loginctl show-user "$USER" -p Linger --value)" = yes ] ||
  echo "warning: lingering is off for $USER, so the gate stops when you log out" >&2

mkdir -p "$DEST"
install -m 644 "$SRC" "$DEST/$UNIT"
systemctl --user daemon-reload
systemctl --user enable --now $UNIT
systemctl --user restart $UNIT

sleep 3
echo
echo "== unit =="
systemctl --user is-active $UNIT
echo
echo "== log =="
journalctl --user -u $UNIT -n 5 --no-pager
