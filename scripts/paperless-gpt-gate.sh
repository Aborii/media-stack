#!/usr/bin/env bash
# Runs paperless-gpt only while the PC's Ollama answers.
#
# The models are on the PC (pc/ollama). When the PC is off, asleep or paused,
# paperless-gpt would fail every document it tried, give up on it after three
# tries, and back off for up to an hour between polls. Stopping it instead
# leaves new documents waiting with their "ai-new" tag, and starting it again
# when the PC answers picks them up within a minute.
#
# Runs as aborii's user service (systemd/paperless-gpt-gate.service, installed
# by install-paperless-gpt-gate.sh). It only starts and stops the one container.
set -uo pipefail

# The same address paperless-gpt uses, from the shared env file.
ENV_FILE=${ENV_FILE:-/home/aborii/media-stack/docker-compose.env}
BASE=$(grep -s '^PAPERLESS_GPT_OLLAMA_URL=' "$ENV_FILE" | tail -1 | cut -d= -f2-)
URL=${OLLAMA_URL:-${BASE:-http://10.10.10.1:11434}/api/version}
CONTAINER=${CONTAINER:-paperless-gpt}
EVERY=${EVERY:-30}
# Down this many checks in a row before stopping: a dropped packet or an
# Ollama restarting should not stop a document halfway.
DOWN_AFTER=${DOWN_AFTER:-2}

log() { echo "$(date '+%F %T') $*"; }

down=0
last=""
while true; do
  if curl -fsS --max-time 5 "$URL" >/dev/null 2>&1; then
    down=0
    state=up
  else
    down=$((down + 1))
    state=down
  fi

  running=$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo missing)
  if [ "$running" = missing ]; then
    [ "$last" = missing ] || log "$CONTAINER does not exist; waiting for it to be created."
    last=missing
  elif [ "$state" = up ] && [ "$running" = false ]; then
    log "The PC's Ollama answers; starting $CONTAINER."
    docker start "$CONTAINER" >/dev/null
    last=up
  elif [ "$state" = down ] && [ "$down" -ge "$DOWN_AFTER" ] && [ "$running" = true ]; then
    log "The PC's Ollama has not answered for $((down * EVERY)) s; stopping $CONTAINER."
    docker stop "$CONTAINER" >/dev/null
    last=down
  fi
  sleep "$EVERY"
done
