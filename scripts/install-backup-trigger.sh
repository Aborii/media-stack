#!/usr/bin/env bash
# Install the manual-backup trigger, and remove the sudo grant it replaces.
#
# The first attempt at the Run button had the status service call sudo. That
# could never work: the service sets NoNewPrivileges=true, which blocks exactly
# that - and rightly so, since it listens on the LAN with no authentication.
#
# So the escalation is gone entirely. The service creates a file; a .path unit
# owned by root notices and starts the backup. The web service gains no ability
# to run anything, and the hardening stays on.
set -euo pipefail

SYS=/home/aborii/media-stack/systemd
[ "$(id -u)" -eq 0 ] || { echo "run with sudo - this installs systemd units" >&2; exit 1; }

for u in media-stack-backup-trigger.path media-stack-backup-trigger.service; do
  [ -f "$SYS/$u" ] || { echo "missing unit: $SYS/$u" >&2; exit 1; }
  install -m 644 "$SYS/$u" /etc/systemd/system/$u
done

# The sudoers grant is now dead weight. Leaving a NOPASSWD rule in place for a
# path nothing uses is exactly the sort of thing nobody revisits later.
if [ -f /etc/sudoers.d/media-stack-backup-status ]; then
  rm -f /etc/sudoers.d/media-stack-backup-status
  echo "removed the sudoers grant - no longer needed"
fi

systemctl daemon-reload
systemctl enable --now media-stack-backup-trigger.path
systemctl restart media-stack-backup-status.service

sleep 2
echo
echo "== units =="
printf '  %-42s %s\n' media-stack-backup-trigger.path "$(systemctl is-active media-stack-backup-trigger.path)"
printf '  %-42s %s\n' media-stack-backup-status.service "$(systemctl is-active media-stack-backup-status.service)"
echo
echo "== the button endpoint =="
curl -s -X POST --max-time 30 http://127.0.0.1:9101/run || echo "  no response"
echo
echo "== did a backup actually start? =="
sleep 2
printf '  %-42s %s\n' media-stack-backup.service "$(systemctl is-active media-stack-backup.service)"
echo
echo "  (that was a REAL backup - it is the same unit the 03:30 timer runs)"
