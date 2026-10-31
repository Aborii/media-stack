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
# is undone by the next run.
#
# Only documents that are not in Paperless's trash are copied, and anything
# else is removed from the copy. A trashed document's file stays in Paperless's
# folder until the trash is emptied (30 days), so mirroring the folder would
# show deleted documents for a month; Paperless is asked for the list instead.
#
# Not Paperless's document_exporter: its manifest.json carries the mail
# account's password, which has no place on a share.
#
# Runs nightly as aborii's user timer (systemd/paperless-library-sync.*,
# installed by install-paperless-library-sync.sh).
set -euo pipefail
export LC_ALL=C

SRC=${SRC:-/srv/appdata/paperless/media/documents}
DEST=${DEST:-/srv/storage/data/paperless-library}
CONTAINER=${CONTAINER:-paperless}

# The share is on the data disk; with it unmounted this would fill the root
# file system under the empty mount point.
mountpoint -q /srv/storage || { echo "/srv/storage is not mounted; nothing copied" >&2; exit 1; }
[ -d "$SRC/originals" ] || { echo "no Paperless library at $SRC" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Every live document and version, as paths relative to originals/ and
# archive/. The END line proves the list is complete: without it (Paperless
# stopped, a database error) nothing is copied or removed, rather than the
# copy being emptied to match an empty list.
docker exec "$CONTAINER" python3 manage.py shell -c '
from documents.models import Document
n = 0
for d in Document.objects.all().only("filename", "archive_filename"):
    n += 1
    if d.filename: print("O\t" + d.filename)
    if d.archive_filename: print("A\t" + d.archive_filename)
print("END\t%d" % n)
' 2>/dev/null >"$work/all" || true
grep -q $'^END\t' "$work/all" || { echo "could not get the document list from $CONTAINER; nothing copied" >&2; exit 1; }
grep $'^O\t' "$work/all" | cut -f2- | sort -u >"$work/originals" || true
grep $'^A\t' "$work/all" | cut -f2- | sort -u >"$work/archive" || true

# Copies the listed files from $1 to $2, then removes every other file in $2.
mirror() {
  local from=$1 to=$2 list=$3
  mkdir -p "$to"
  # --ignore-missing-args: a listed file missing on disk (Paperless renaming it
  # right now) is skipped, instead of failing every night from then on.
  rsync -a --ignore-missing-args --files-from="$list" "$from/" "$to/"
  (cd "$to" && find . -type f | sed 's|^\./||' | sort) | comm -23 - "$list" |
    while IFS= read -r stale; do rm -f -- "$to/$stale"; done
  find "$to" -mindepth 1 -type d -empty -delete
}

mirror "$SRC/originals" "$DEST/Originals" "$work/originals"
mirror "$SRC/archive" "$DEST/Searchable PDFs" "$work/archive"

cat >"$DEST/README.txt" <<'EOF'
A nightly copy of the Paperless library, laid out as Type/Year/Title.
Edits here are not kept: change documents in Paperless instead. Documents
in Paperless's trash are left out.
Originals: the files as uploaded (a locked PDF stays locked; its unlocked
copy is the file ending in _v1). Searchable PDFs: the OCR'd PDFs Paperless
makes for scans and photos; a PDF that already had text has none here.
EOF

echo "$(date '+%F %T') copied $(wc -l <"$work/originals") originals and $(wc -l <"$work/archive") searchable PDFs"
