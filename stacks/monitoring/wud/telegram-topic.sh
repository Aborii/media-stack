#!/bin/sh
# Posts one WUD update notice into the Telegram "status" forum topic.
#
# Why this exists: WUD's built-in Telegram trigger takes a chat id and nothing
# else - it has no message_thread_id, so it can only post to the group's
# General topic. The status topic is where Diun posted and where image updates
# belong, away from the Radarr/Sonarr grab notices. The command trigger hands
# every update to this script as environment variables (simple mode, one run
# per update), and curl does the one thing the trigger cannot.
#
# Runs INSIDE the wud container, which ships curl for its own healthcheck.
# Mounted read-only from the repo; invoked as `sh /wud/telegram-topic.sh` so
# the exec bit does not matter.
set -eu

: "${TELEGRAM_BOT_TOKEN:?}" "${TELEGRAM_CHAT_ID:?}" "${TELEGRAM_TOPIC_STATUS:?}"

# WUD sets these for the child process: display_name, image_name,
# image_tag_value, update_kind_kind (tag|digest), update_kind_remote_value,
# update_kind_semver_diff (major|minor|patch, semver tags only).
case "${update_kind_kind:-}" in
  digest) what="new build of ${image_name}:${image_tag_value}" ;;
  *)      what="${image_tag_value} -> ${update_kind_remote_value:-?} (${update_kind_semver_diff:-tag})" ;;
esac

text="Image update: ${display_name:-$name}
${what}
Nothing was pulled. Open http://aboriis-pi:3002 to review."

# -o /dev/null and -f: a failure prints only "The requested URL returned error"
# with the status code, never the URL, so the bot token stays out of the logs.
curl -fsS -o /dev/null --max-time 20 \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "message_thread_id=${TELEGRAM_TOPIC_STATUS}" \
  --data-urlencode "text=${text}"
