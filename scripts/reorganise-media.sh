#!/bin/bash
#
# One-off: reshape the copied F:\Media tree into the layout the compose
# files expect. Run ONLY when no copy is in progress - it renames the
# directory a transfer may be writing into.
#
#     bash scripts/reorganise-media.sh --dry-run    # show what would happen
#     bash scripts/reorganise-media.sh
#
# Every step is a rename within one filesystem, so it is a metadata
# operation: 2.4TB moves instantly, nothing is copied.
#
set -euo pipefail
M=/srv/storage/data/media
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
run() { if [ "$DRY" -eq 1 ]; then echo "  would: $*"; else echo "  $*"; "$@"; fi; }

[ -d "$M" ] || { echo "ABORT: $M does not exist"; exit 1; }
mountpoint -q /srv/storage || { echo "ABORT: /srv/storage is not mounted"; exit 1; }

# Refuse to run while anything is still being written.
recent=$(find "$M" -type f -mmin -5 2>/dev/null | wc -l)
smb=$(ss -tn state established 2>/dev/null | grep -c ':445' || true)
if [ "$recent" -gt 0 ] || [ "$smb" -gt 0 ]; then
  echo "ABORT: transfer still active ($recent files written in the last 5 min, $smb SMB sessions)"
  echo "       Wait for the copy to finish, or pass --dry-run to preview."
  [ "$DRY" -eq 0 ] && exit 1
fi

echo "=== 1. remove the empty folders created in error ==="
for d in tv anime comics movies; do
  if [ -d "$M/$d" ] && [ -z "$(ls -A "$M/$d" 2>/dev/null)" ]; then
    run rmdir "$M/$d"
  fi
done

echo "=== 2. media/media -> media/library ==="
if [ -d "$M/media" ] && [ ! -e "$M/library" ]; then
  run mv "$M/media" "$M/library"
else
  echo "  skipped (already done, or library exists)"
fi

echo "=== 3. cloud-backup -> gallery  (Immich, app-managed) ==="
if [ -d "$M/cloud-backup" ] && [ ! -e "$M/gallery" ]; then
  run mv "$M/cloud-backup" "$M/gallery"
else
  echo "  skipped"
fi

echo "=== 4. watch/ moves under torrents/ ==="
if [ -d "$M/watch" ] && [ ! -e "$M/torrents/watch" ]; then
  run mv "$M/watch" "$M/torrents/watch"
else
  run mkdir -p "$M/torrents/watch"
fi

echo "=== 5. folders the kept services need ==="
for d in library/comics torrents/incomplete books audiobooks gallery; do
  run mkdir -p "$M/$d"
done

echo "=== 6. drop empty folders belonging to dropped services ==="
for d in photos audio music usenet filebot; do
  if [ -d "$M/$d" ] && [ -z "$(ls -A "$M/$d" 2>/dev/null)" ]; then
    run rmdir "$M/$d"
  elif [ -d "$M/$d" ]; then
    echo "  KEPT $d - not empty, check it by hand"
  fi
done

echo "=== 7. ownership ==="
run chown -R aborii:aborii "$M"

echo
echo "=== result ==="
ls -A "$M" | sed 's/^/  /'
