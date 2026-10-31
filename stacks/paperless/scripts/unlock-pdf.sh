#!/usr/bin/env bash
# Paperless pre-consume script: unlocks a password-protected PDF before it is
# stored, so the locked copy is never kept and the document is read, searched
# and named like any other.
#
# Paperless's own "Password removal" workflow action cannot do this: it adds
# the unlocked file as a second version and keeps the locked one as the
# document's original, which cannot be deleted. Here the working copy is
# replaced before consumption starts, so the unlocked file is the original.
#
# - Not a PDF, or not encrypted: left alone.
# - Encrypted but opens without a password (copy or print restrictions, common
#   on bank statements): the restrictions are removed.
# - Needs a password: each line of the password list is tried in order. A
#   blank line or one starting with # is skipped. Passwords are passed to qpdf
#   on stdin, never on its command line or in this log.
# - No password works: stored locked, as before. The AI fails on it and tags
#   it paperless-gpt-failed; unlock it later from the document's Actions menu.
#
# It always exits 0: a non-zero exit would stop Paperless filing the file.
set -uo pipefail

IN=${DOCUMENT_WORKING_PATH:?}
LIST=${PDF_PASSWORDS_FILE:-/usr/src/paperless/secrets/pdf-passwords.txt}
OUT="$IN.unlocked"

[ "$(file -b --mime-type "$IN")" = application/pdf ] || exit 0
# 0 encrypted, 2 not encrypted.
qpdf --is-encrypted "$IN"
[ $? -eq 0 ] || exit 0

decrypt() {
  # --deterministic-id: the same file always unlocks to the same bytes, so
  # Paperless's duplicate check still works. --warning-exit-0: a PDF qpdf
  # repairs on the way through still counts as unlocked.
  qpdf --password-file=- --decrypt --deterministic-id --warning-exit-0 "$IN" "$OUT" 2>/dev/null &&
    mv -f "$OUT" "$IN"
}

# 0 means a password is needed; 3 means it opens without one.
qpdf --requires-password "$IN"
if [ $? -ne 0 ]; then
  if printf '' | decrypt; then
    echo "unlock-pdf: removed copy and print restrictions."
  else
    rm -f "$OUT"
    echo "unlock-pdf: could not remove the restrictions; storing it as it came."
  fi
  exit 0
fi

if [ ! -r "$LIST" ]; then
  echo "unlock-pdf: password-protected, and no password list at $LIST; storing it locked."
  exit 0
fi

n=0
while IFS= read -r password || [ -n "$password" ]; do
  password=${password%$'\r'}
  case "$password" in '' | '#'*) continue ;; esac
  n=$((n + 1))
  if printf '%s\n' "$password" | decrypt; then
    echo "unlock-pdf: unlocked with password $n of the list."
    exit 0
  fi
  rm -f "$OUT"
done <"$LIST"

echo "unlock-pdf: password-protected, and none of the $n passwords in the list opened it; storing it locked."
exit 0
