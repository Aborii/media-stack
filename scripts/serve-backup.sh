#!/bin/bash
# The only thing the backup key is allowed to do.
#
# This runs as a FORCED COMMAND from authorized_keys, so the key that invokes it
# cannot get a shell, cannot run anything else, and cannot forward a port. If
# the machine holding that key is compromised, all it can do is read a backup it
# already has a copy of.
#
# Three modes, chosen by what the client asked for:
#   name   print the newest archive's filename
#   sha    print its sha256
#   data   stream the archive itself to stdout
set -euo pipefail

OFFSITE=${OFFSITE:-/srv/storage/backups/offsite}

newest=$(ls -1t "$OFFSITE"/media-stack-*.tar.gz 2>/dev/null | head -1 || true)
[ -n "$newest" ] || { echo "no archive staged" >&2; exit 1; }

case "${SSH_ORIGINAL_COMMAND:-name}" in
  name) basename "$newest" ;;
  sha)  cat "$newest.sha256" ;;
  data) cat "$newest" ;;
  # Anything else is either a mistake or someone poking at the key. Neither
  # gets to fall through to a shell.
  *)    echo "refused: this key only serves backups" >&2; exit 1 ;;
esac
