#!/bin/bash
# Prove an Immich snapshot restores: boot a throwaway Immich on it, and fetch a
# photo back through Immich itself.
#
# Nothing live is touched. It runs its own database, Redis and server on its
# own Docker network and its own localhost port, and never joins mediastack.
#
# The photos are NOT copied for the test: a full copy would write the whole
# library to the SSD again for every test. Immich will not start on a
# read-only library (it writes a .immich marker into it), so the snapshot's
# library/ is the lower layer of an overlay volume: Immich sees a normal
# folder, every write lands in SCRATCH, and the snapshot is never written. The
# Docker daemon does the mount, so this needs no root of its own. Only
# upload/, profile/ and the database (small) are copied to SCRATCH.
#
#   ./restore-test-immich.sh                         newest snapshot, boot check
#   RESTORE_API_KEY=... ./restore-test-immich.sh     also fetch a photo through
#                                                    the restored Immich and
#                                                    compare it byte for byte
#   KEEP_RUNNING=1 ./restore-test-immich.sh          leave it up to look at
#
# The API key is one from the snapshot's own database - the restored Immich
# knows only the keys that existed when it was taken.
set -euo pipefail

DEST=${DEST:-/srv/backups/immich}
SNAPSHOT=${SNAPSHOT:-$DEST/latest}
SCRATCH=${SCRATCH:-$HOME/scratch/immich-restore-test}
PREFIX=${RESTORE_NAME:-immich-restore-test}
PORT=${RESTORE_PORT:-29500}
DB_USER=${RESTORE_DB_USER:-immich}
LIVE_PATHS=(/srv/storage/data/media/gallery /srv/appdata/immich "$DEST")
KEEP_RUNNING=${KEEP_RUNNING:-0}

note() { printf '  %s\n' "$*"; }
die() { echo "$*" >&2; exit 1; }

SNAPSHOT=$(readlink -f "$SNAPSHOT")
for need in library upload profile db/immich-db.sql.gz image db-image; do
  [ -e "$SNAPSHOT/$need" ] || die "$SNAPSHOT is not a snapshot (no $need)"
done

scratch_abs=$(readlink -m "$SCRATCH")
for live in "${LIVE_PATHS[@]}"; do
  live_abs=$(readlink -m "$live")
  case "$scratch_abs/" in "$live_abs"/*) die "SCRATCH $scratch_abs is inside $live_abs - refusing";; esac
  case "$live_abs/" in "$scratch_abs"/*) die "SCRATCH $scratch_abs contains $live_abs - refusing";; esac
done
[ ! -e "$scratch_abs" ] || [ -z "$(ls -A "$scratch_abs")" ] || die "$scratch_abs is not empty - pick another SCRATCH"
for c in "$PREFIX-db" "$PREFIX-redis" "$PREFIX-server"; do
  docker inspect "$c" >/dev/null 2>&1 && die "a container named $c already exists"
done
docker network inspect "$PREFIX" >/dev/null 2>&1 && die "a network named $PREFIX already exists"
docker volume inspect "$PREFIX-library" >/dev/null 2>&1 && die "a volume named $PREFIX-library already exists"
ss -ltnH "sport = :$PORT" | grep -q . && die "port $PORT is taken - pick another RESTORE_PORT"

cleanup() {
  [ "$KEEP_RUNNING" = "1" ] && return
  docker rm -f "$PREFIX-server" "$PREFIX-redis" "$PREFIX-db" >/dev/null 2>&1 || true
  docker network rm "$PREFIX" >/dev/null 2>&1 || true
  docker volume rm "$PREFIX-library" >/dev/null 2>&1 || true
  # The database files are written by the container's root; removing them
  # from inside one avoids needing sudo here.
  if [ -d "$scratch_abs" ]; then
    docker run --rm -v "$scratch_abs:/s" "$(cat "$SNAPSHOT/db-image")" sh -c 'rm -rf /s/* /s/.[!.]*' >/dev/null 2>&1 || true
    rm -rf -- "$scratch_abs"
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM INT HUP

image=$(cat "$SNAPSHOT/image")
db_image=$(cat "$SNAPSHOT/db-image")
echo "== restore test of $(basename "$SNAPSHOT") with $image =="

# --------------------------------------------------------------- scratch copy
mkdir -p "$scratch_abs/server" "$scratch_abs/pg" "$scratch_abs/library-upper" "$scratch_abs/library-work"
chmod 700 "$scratch_abs"
rsync -aH "$SNAPSHOT/upload/" "$scratch_abs/server/upload/"
rsync -aH "$SNAPSHOT/profile/" "$scratch_abs/server/profile/"
# Immich checks a marker in every folder it uses; thumbs and encoded-video
# were left out of the backup, so they start empty with their marker.
for d in thumbs encoded-video backups; do
  mkdir -p "$scratch_abs/server/$d"
  printf '%s' "$(date +%s)" > "$scratch_abs/server/$d/.immich"
done

docker volume create --driver local --opt type=overlay --opt device=overlay \
  --opt "o=lowerdir=$SNAPSHOT/library,upperdir=$scratch_abs/library-upper,workdir=$scratch_abs/library-work" \
  "$PREFIX-library" >/dev/null

# ------------------------------------------------------------------ database
docker network create "$PREFIX" >/dev/null
db_pw=$(openssl rand -hex 16)
docker run -d --name "$PREFIX-db" --network "$PREFIX" --memory 1g --shm-size 128m \
  -e POSTGRES_PASSWORD="$db_pw" -e POSTGRES_USER="$DB_USER" -e POSTGRES_DB=immich \
  -e POSTGRES_INITDB_ARGS=--data-checksums \
  -v "$scratch_abs/pg:/var/lib/postgresql/data" "$db_image" >/dev/null
ok=0
for _ in $(seq 1 60); do
  if docker exec "$PREFIX-db" pg_isready -U "$DB_USER" -d immich >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ "$ok" = "1" ] || die "the throwaway database never became ready"
sleep 3   # the entrypoint restarts Postgres once after initdb

# The docs' command-line restore, search_path line and all.
gunzip --stdout "$SNAPSHOT/db/immich-db.sql.gz" \
  | sed "s/SELECT pg_catalog.set_config('search_path', '', false);/SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', true);/g" \
  | docker exec -i "$PREFIX-db" psql --dbname=immich --username="$DB_USER" \
      --single-transaction --set ON_ERROR_STOP=on >/dev/null \
  || die "the database dump did not restore"
assets=$(docker exec "$PREFIX-db" psql -U "$DB_USER" -d immich -tAc 'select count(*) from asset' 2>/dev/null \
  || docker exec "$PREFIX-db" psql -U "$DB_USER" -d immich -tAc 'select count(*) from assets')
note "database restored: $assets assets"

# -------------------------------------------------------------------- server
docker run -d --name "$PREFIX-redis" --network "$PREFIX" --memory 256m docker.io/valkey/valkey:9 >/dev/null
docker run -d --name "$PREFIX-server" --network "$PREFIX" --memory 3g \
  -p "127.0.0.1:$PORT:2283" \
  -e DB_HOSTNAME="$PREFIX-db" -e DB_USERNAME="$DB_USER" -e DB_PASSWORD="$db_pw" -e DB_DATABASE_NAME=immich \
  -e REDIS_HOSTNAME="$PREFIX-redis" \
  -e IMMICH_MACHINE_LEARNING_ENABLED=false \
  -v "$scratch_abs/server:/data" \
  -v "$PREFIX-library:/data/library" \
  "$image" >/dev/null
url="http://127.0.0.1:$PORT"
note "started $PREFIX-server on $url"
ok=0
for _ in $(seq 1 90); do
  if curl -sf "$url/api/server/ping" >/dev/null; then ok=1; break; fi
  sleep 2
done
[ "$ok" = "1" ] || { docker logs --tail 30 "$PREFIX-server" >&2; die "restored Immich never answered"; }
note "it answers: Immich $(curl -s "$url/api/server/version" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print("%s.%s.%s" % (d["major"], d["minor"], d["patch"]))')"

# -------------------------------------------------------------- fetch a photo
if [ -n "${RESTORE_API_KEY:-}" ]; then
  found=$(curl -s -H "x-api-key: $RESTORE_API_KEY" -H 'Content-Type: application/json' \
    -d '{"size": 1, "type": "IMAGE"}' "$url/api/search/metadata" \
    | python3 -I -c 'import json,sys; a=json.load(sys.stdin)["assets"]["items"][0]; print(a["id"], a["originalPath"], a["originalFileName"], sep="\t")') \
    || die "could not list photos through the restored Immich - is RESTORE_API_KEY from this snapshot?"
  # Tabs, not spaces: photo names have spaces in them.
  IFS=$'\t' read -r id path filename <<<"$found"
  case "$path" in
    /data/library/*) orig="$SNAPSHOT/library/${path#/data/library/}" ;;
    /data/upload/*)  orig="$scratch_abs/server/upload/${path#/data/upload/}" ;;
    *) die "unexpected path $path" ;;
  esac
  fetched=$(mktemp)
  code=$(curl -s -o "$fetched" -w '%{http_code}' -H "x-api-key: $RESTORE_API_KEY" "$url/api/assets/$id/original")
  [ "$code" = "200" ] || { rm -f "$fetched"; die "fetching $filename through the restored Immich: http $code"; }
  if cmp -s "$fetched" "$orig"; then
    note "$filename fetched through Immich matches the snapshot ($(stat -c %s "$fetched") bytes)"
    echo "$id" > "$scratch_abs/checked-asset-id"
  else
    rm -f "$fetched"; die "$filename fetched through Immich DIFFERS from the snapshot"
  fi
  rm -f "$fetched"
fi

if [ "$KEEP_RUNNING" = "1" ]; then
  note "left running at $url - remove with: docker rm -f $PREFIX-server $PREFIX-redis $PREFIX-db; docker network rm $PREFIX; docker volume rm $PREFIX-library; then delete $scratch_abs"
fi
echo "  RESTORE OK"
