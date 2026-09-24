# Post backup news into the Telegram "backups" forum topic.
#
# SOURCED, not run: backup.sh and flush-offsite.sh both load it and call
# tg_backup "text". Same bot and group as wud and the arr apps
# (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID), with its own topic,
# TELEGRAM_TOPIC_BACKUPS, so backup news does not bury grab notices or image
# updates and vice versa.
#
# IT NEVER FAILS THE CALLER. A backup that worked has not failed because
# Telegram was unreachable - the message is a report about the backup, not part
# of it. When a post does not go through it prints one line saying so, and the
# journal still holds the full run.
#
# THE ENV FILE IS READ, NOT SOURCED. docker-compose.env is Compose syntax, not
# shell. A password holding '$' or a space is fine to Compose and would be
# expanded or split by `source` - and sourcing it would also execute whatever is
# in it, as root, on every nightly run.
#
#   TG_ENV_FILE=/path/to.env    read the keys from somewhere else
#   TG_DISABLE=1                post nothing (tests, manual reruns)

TG_ENV_FILE=${TG_ENV_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/docker-compose.env}

# Last assignment wins, as it does for Compose. One pair of surrounding quotes
# is stripped, because Compose strips them too.
tg_env() {
  local v
  v=$(grep -E "^$1=" "$TG_ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r')
  v=${v%\"}; v=${v#\"}; v=${v%\'}; v=${v#\'}
  printf '%s' "$v"
}

tg_backup() {
  local text=$1 token chat topic err
  [ "${TG_DISABLE:-0}" = "1" ] && return 0

  token=$(tg_env TELEGRAM_BOT_TOKEN)
  chat=$(tg_env TELEGRAM_CHAT_ID)
  topic=$(tg_env TELEGRAM_TOPIC_BACKUPS)
  if [ -z "$token" ] || [ -z "$chat" ] || [ -z "$topic" ]; then
    printf '  %s\n' "telegram: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID or TELEGRAM_TOPIC_BACKUPS missing in $TG_ENV_FILE - not posted"
    return 0
  fi

  # -o /dev/null and -f: on failure curl reports only the status or the
  # connection error, never the URL, so the bot token stays out of the journal.
  if ! err=$(curl -fsS -o /dev/null --max-time 20 \
      "https://api.telegram.org/bot${token}/sendMessage" \
      --data-urlencode "chat_id=${chat}" \
      --data-urlencode "message_thread_id=${topic}" \
      --data-urlencode "text=${text}" 2>&1); then
    printf '  %s\n' "telegram: post failed (${err:-no detail}) - this log is the only report"
  fi
  return 0
}
