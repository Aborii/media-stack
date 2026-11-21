#!/bin/bash
# Prove an OpenCloud snapshot restores: copy it to a scratch folder, boot a
# throwaway OpenCloud on it, and fetch a file back through OpenCloud itself.
#
# A backup nobody has restored is a hope. This never touches the live data or
# the live container: it reads one snapshot, writes only under SCRATCH, and
# runs its own container on its own localhost port, on Docker's default
# network rather than mediastack, so it cannot reach Euro-Office or anything
# else the live one talks to.
#
#   ./restore-test-opencloud.sh                           newest snapshot, boot check
#   RESTORE_USER=admin RESTORE_PASSWORD=... RESTORE_FILE=Documents/a.txt \
#     ./restore-test-opencloud.sh                         also fetch that file and
#                                                         compare it byte for byte
#   KEEP_RUNNING=1 ./restore-test-opencloud.sh            leave it up to look at
#                                                         in a browser
#
# The password is the account's own from the moment of the snapshot - the user
# database is part of what is being restored.
set -euo pipefail

DEST=${DEST:-/srv/backups/opencloud}
SNAPSHOT=${SNAPSHOT:-$DEST/latest}
SCRATCH=${SCRATCH:-$HOME/scratch/opencloud-restore-test}
NAME=${RESTORE_NAME:-opencloud-restore-test}
PORT=${RESTORE_PORT:-29300}
LIVE_DATA=${LIVE_DATA:-/srv/storage/data/opencloud}
LIVE_CONFIG=${LIVE_CONFIG:-/srv/appdata/opencloud/config}
KEEP_RUNNING=${KEEP_RUNNING:-0}

note() { printf '  %s\n' "$*"; }
die() { echo "$*" >&2; exit 1; }

SNAPSHOT=$(readlink -f "$SNAPSHOT")
[ -d "$SNAPSHOT/data" ] && [ -d "$SNAPSHOT/config" ] && [ -f "$SNAPSHOT/image" ] \
  || die "$SNAPSHOT is not a snapshot (needs data/, config/ and image)"

# The scratch folder is wiped at the end, so it must never be, or sit inside,
# the live folders - one wrong variable would otherwise delete OpenCloud.
scratch_abs=$(readlink -m "$SCRATCH")
for live in "$LIVE_DATA" "$LIVE_CONFIG" "$DEST"; do
  live_abs=$(readlink -m "$live")
  case "$scratch_abs/" in "$live_abs"/*) die "SCRATCH $scratch_abs is inside $live_abs - refusing";; esac
  case "$live_abs/" in "$scratch_abs"/*) die "SCRATCH $scratch_abs contains $live_abs - refusing";; esac
done
[ ! -e "$scratch_abs" ] || [ -z "$(ls -A "$scratch_abs")" ] || die "$scratch_abs is not empty - pick another SCRATCH"
docker inspect "$NAME" >/dev/null 2>&1 && die "a container named $NAME already exists"
ss -ltnH "sport = :$PORT" | grep -q . && die "port $PORT is taken - pick another RESTORE_PORT"

cleanup() {
  [ "$KEEP_RUNNING" = "1" ] && return
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  # The copy holds the snapshot's secrets and files; it goes with the test.
  rm -rf -- "$scratch_abs"
}
trap cleanup EXIT

image=$(cat "$SNAPSHOT/image")
echo "== restore test of $(basename "$SNAPSHOT") with $image =="

# --------------------------------------------------------------------- copy
mkdir -p "$scratch_abs"
chmod 700 "$scratch_abs"
rsync -aHAX --numeric-ids "$SNAPSHOT/data/" "$scratch_abs/data/"
rsync -aHAX --numeric-ids "$SNAPSHOT/config/" "$scratch_abs/config/"

count() {
  python3 -I - "$1" <<'PY'
import os, sys
files = size = xattrs = 0
for root, dirs, names in os.walk(sys.argv[1]):
    for n in dirs + names:
        try:
            if os.listxattr(os.path.join(root, n), follow_symlinks=False):
                xattrs += 1
        except OSError:
            pass
    for n in names:
        p = os.path.join(root, n)
        if os.path.isfile(p) and not os.path.islink(p):
            files += 1
            size += os.lstat(p).st_size
print(files, size, xattrs)
PY
}
want=$(count "$SNAPSHOT/data")
got=$(count "$scratch_abs/data")
[ "$want" = "$got" ] || die "scratch copy differs from the snapshot ($want vs $got)"
note "copied: $got (files bytes xattrs)"

# The sign-in client list was generated for the live address. Removed from the
# COPY only, so OpenCloud writes one for this test's address on start.
rm -f "$scratch_abs/data/idp/tmp/identifier-registration.yaml"

# ---------------------------------------------------------------------- boot
url="https://localhost:$PORT"
# The same port inside and out: OpenCloud checks every sign-in against its own
# OC_URL from inside the container, so the address has to work there too.
docker run -d --name "$NAME" \
  --user "$(id -u):$(id -g)" \
  --memory 2g \
  -p "127.0.0.1:$PORT:$PORT" \
  -e PROXY_HTTP_ADDR="0.0.0.0:$PORT" \
  -e OC_URL="$url" \
  -e OC_INSECURE=true \
  -e PROXY_ENABLE_BASIC_AUTH=true \
  -e IDM_CREATE_DEMO_USERS=false \
  -e FRONTEND_CHECK_FOR_UPDATES=false \
  -e OC_LOG_LEVEL=warn \
  -v "$scratch_abs/config:/etc/opencloud" \
  -v "$scratch_abs/data:/var/lib/opencloud" \
  --entrypoint /bin/sh "$image" -c 'opencloud server' >/dev/null
note "started $NAME on $url"

ok=0
for _ in $(seq 1 90); do
  if curl -ksf "$url/status.php" >/dev/null; then ok=1; break; fi
  sleep 2
done
[ "$ok" = "1" ] || { docker logs --tail 30 "$NAME" >&2; die "restored OpenCloud never answered"; }
note "it answers: $(curl -ks "$url/status.php" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(d.get("productname"), d.get("productversion"))')"

# --------------------------------------------------------------- fetch a file
if [ -n "${RESTORE_USER:-}" ] && [ -n "${RESTORE_FILE:-}" ]; then
  fetched=$(mktemp)
  # status.php answers before the user directory is up, and sign-ins fail with
  # 401 until it is. So a 401 is retried for a minute before it counts.
  for _ in $(seq 1 30); do
    code=$(curl -ks -o "$fetched" -w '%{http_code}' -u "$RESTORE_USER:${RESTORE_PASSWORD:-}" \
      "$url/remote.php/webdav/$RESTORE_FILE")
    [ "$code" = "401" ] || break
    sleep 2
  done
  [ "$code" = "200" ] || { rm -f "$fetched"; die "fetching $RESTORE_FILE through the restored OpenCloud: http $code"; }
  # The same file as it sits in the snapshot. Files are stored under their own
  # names in the user's folder, so this is a plain path.
  orig=$(find "$SNAPSHOT/data/storage/users/users" -path "*/$RESTORE_FILE" -type f | head -1)
  [ -n "$orig" ] || { rm -f "$fetched"; die "$RESTORE_FILE not found in the snapshot"; }
  if cmp -s "$fetched" "$orig"; then
    note "$RESTORE_FILE fetched through OpenCloud matches the snapshot ($(stat -c %s "$fetched") bytes)"
  else
    rm -f "$fetched"; die "$RESTORE_FILE fetched through OpenCloud DIFFERS from the snapshot"
  fi
  rm -f "$fetched"
fi

if [ "$KEEP_RUNNING" = "1" ]; then
  note "left running at $url - remove with: docker rm -f $NAME && rm -rf $scratch_abs"
fi
echo "  RESTORE OK"
