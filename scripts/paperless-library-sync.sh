#!/usr/bin/env bash
# Copies the Paperless library to the storage share, where it can be browsed
# from the PC or a phone without Paperless:
#
#   storage/paperless-library/Originals/        the files as uploaded
#   storage/paperless-library/Searchable PDFs/  the OCR'd PDFs Paperless made
#
# both laid out as Type/Year/Title.pdf (PAPERLESS_FILENAME_FORMAT). It is a
# copy: Paperless's own files stay in appdata on the NVMe, which backup.sh
# covers. Changing or deleting something here changes nothing in Paperless and
# is undone by the next run; deleting a document in Paperless removes it from
# here on the next run.
#
# Not Paperless's document_exporter: its manifest.json carries the mail
# account's password, which has no place on a share.
#
# Runs nightly as aborii's user timer (systemd/paperless-library-sync.*,
# installed by install-paperless-library-sync.sh).
set -euo pipefail

SRC=${SRC:-/srv/appdata/paperless/media/documents}
DEST=${DEST:-/srv/storage/data/paperless-library}

# The share is on the data disk; with it unmounted this would fill the root
# file system under the empty mount point.
mountpoint -q /srv/storage || { echo "/srv/storage is not mounted; nothing copied" >&2; exit 1; }
[ -d "$SRC/originals" ] || { echo "no Paperless library at $SRC" >&2; exit 1; }

mkdir -p "$DEST/Originals" "$DEST/Searchable PDFs"
cat >"$DEST/README.txt" <<'EOF'
A nightly copy of the Paperless library, laid out as Type/Year/Title.
Edits here are not kept: change documents in Paperless instead.
Originals: the files as uploaded (a locked PDF stays locked; its unlocked
copy is the file ending in _v1). Searchable PDFs: the copies Paperless made,
with text you can search and copy.
EOF

rsync -a --delete "$SRC/originals/" "$DEST/Originals/"
[ -d "$SRC/archive" ] && rsync -a --delete "$SRC/archive/" "$DEST/Searchable PDFs/"
echo "$(date '+%F %T') copied $(find "$DEST/Originals" -type f | wc -l) originals"
