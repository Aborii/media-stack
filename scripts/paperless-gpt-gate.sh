#!/usr/bin/env bash
# Runs paperless-gpt only while the PC's Ollama answers.
#
# The models are on the PC (pc/ollama). When the PC is off, asleep or paused,
# paperless-gpt would fail every document it tried, give up on it after three
# tries, and back off for up to an hour between polls. Stopping it instead
# leaves new documents waiting with their "ai-new" tag, and starting it again
# when the PC answers picks them up within a minute.
#
# "Answers" means both of paperless-gpt's models are installed, not only that
# Ollama is up: on the first install Ollama starts before its models are
# pulled, and a document tried in that gap failed three times in a second
# ("model not found") and was tagged paperless-gpt-failed.
#
# Runs as aborii's user service (systemd/paperless-gpt-gate.service, installed
# by install-paperless-gpt-gate.sh). It only starts and stops the one container.
set -uo pipefail

# The same address and models paperless-gpt uses, from the shared env file,
# with the same defaults as stacks/paperless/compose.yaml.
ENV_FILE=${ENV_FILE:-/home/aborii/media-stack/docker-compose.env}
setting() { grep -s "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }
BASE=$(setting PAPERLESS_GPT_OLLAMA_URL)
URL=${OLLAMA_URL:-${BASE:-http://10.10.10.1:11434}/api/tags}
VISION=$(setting PAPERLESS_GPT_VISION_MODEL)
LLM=$(setting PAPERLESS_GPT_LLM_MODEL)
MODELS=("${VISION:-qwen2.5vl:7b}" "${LLM:-qwen2.5:14b}")
# Ollama lists every model with a tag; a name given without one means :latest.
for i in "${!MODELS[@]}"; do [[ ${MODELS[$i]} == *:* ]] || MODELS[$i]+=":latest"; done

# True when Ollama answers and lists every model paperless-gpt needs.
ready() {
  local tags model
  tags=$(curl -fsS --max-time 5 "$URL" 2>/dev/null) || return 1
  for model in "${MODELS[@]}"; do
    grep -qF "\"name\":\"$model\"" <<<"$tags" || return 1
  done
}
CONTAINER=${CONTAINER:-paperless-gpt}
EVERY=${EVERY:-30}
# Down this many checks in a row before stopping: a dropped packet or an
# Ollama restarting should not stop a document halfway.
DOWN_AFTER=${DOWN_AFTER:-2}

log() { echo "$(date '+%F %T') $*"; }

down=0
last=""
while true; do
  if ready; then
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
