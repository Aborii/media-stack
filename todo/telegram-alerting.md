# Telegram alerting

**Status:** not started. This is the oldest outstanding item in the project — it
was the first question asked when the Pi was still bare, and monitoring got
built first instead.

## Why this matters

Everything is watched and nothing reports.

| | |
|---|---|
| Uptime Kuma monitors | 15, all green |
| Uptime Kuma notification providers | **0** |
| Monitors with an alert attached | **0 of 15** |
| Diun containers watched | 24 |
| Diun notifier | **none** |

Uptime Kuma checks every service every 60 seconds and Diun watches every image
for updates. Neither can tell anyone anything, so the only way to learn that
Jellyfin died is to open the dashboard and notice. That is not monitoring, it is
a status page.

This is worth more than it sounds on this setup specifically: gluetun restarted
its tunnel in a loop for weeks and nobody knew, and Immich ran with an empty
database from the day it was migrated until someone happened to open it.

## Step 1 — create the bot

In Telegram, message **@BotFather**:

```
/newbot
```

Give it a name and a username. It replies with a token like
`8123456789:AAH...`. Keep it — it is the only credential involved.

Then **send your new bot any message** (it cannot message you first), and read
your chat id back:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | python3 -m json.tool | grep -A3 '"chat"'
```

The `id` under `chat` is what both tools need. It is a plain integer, negative
for a group.

## Step 2 — Uptime Kuma

Two ways in. The UI is fine for a one-off:

**Settings → Notifications → Setup Notification → Telegram.** Paste the token
and chat id, tick **Default enabled** and **Apply on all existing monitors** so
all 15 are covered without clicking through each.

Or script it, which is worth doing because it also re-attaches after a rebuild.
The venv and helpers already exist from the monitor setup:

```python
# ~/.venv-kuma/bin/python
from uptime_kuma_api import UptimeKumaApi, NotificationType
api = UptimeKumaApi("http://127.0.0.1:3001", wait_events=0.8)
api.login("aborii", "<password>")
n = api.add_notification(
    name="Telegram",
    type=NotificationType.TELEGRAM,
    isDefault=True,
    applyExisting=True,
    telegramBotToken="<TOKEN>",
    telegramChatID="<CHAT_ID>",
)
api.disconnect()
```

**Note:** `uptime-kuma-api` targets Uptime Kuma v1 and this instance is v2.5.3.
Adding monitors needed three patches for that mismatch — see
`scripts/uptime-kuma-monitors.py`. Notifications may need the same treatment; if
`add_notification` throws about a missing column or an unexpected keyword, reuse
the patch pattern from that script rather than downgrading Uptime Kuma.

## Step 3 — Diun

Environment variables on the container, in `stacks/monitoring/compose.yaml`:

```yaml
      - DIUN_NOTIF_TELEGRAM_TOKEN=<TOKEN>
      - DIUN_NOTIF_TELEGRAM_CHATIDS=<CHAT_ID>
```

Put the real values in `docker-compose.env` (gitignored, it already holds the
WireGuard key) and reference them, rather than inline in the compose file which
is committed.

Recreate the container and force a check:

```bash
docker compose up -d diun
docker exec diun diun image list
```

## Step 4 — decide what actually alerts

The failure mode here is noise. An alert that fires constantly gets muted, and
then it may as well not exist.

Suggested:

- **Alert:** any of the 15 services down for 2 consecutive checks. The monitors
  are already set to `retries: 2`, so this is the default behaviour.
- **Alert:** Diun image updates — but consider weekly rather than on every
  push. 24 containers on `:latest` will generate a lot of chatter otherwise.
- **Do not alert on gluetun.** Containers inside its namespace keep answering
  locally when the tunnel drops, so it would be both noisy and misleading.
  There is deliberately no gluetun monitor for this reason.

Worth adding later, none of which exists yet:

- Drive temperature. It hit 68 °C before the enclosure change and sits at 49 °C
  now. Scrutiny knows the number but alerts nobody.
- SD card free space. The dashboard shows it since the containerd move, but
  nothing warns.
- Immich backup age. Its nightly dump is the only thing standing between you and
  re-uploading 61 GB. A dump that silently stops is invisible until you need it.

## Verifying

Pause a monitor in Uptime Kuma and resume it, or stop a harmless container:

```bash
docker stop dozzle && sleep 90 && docker start dozzle
```

You should get a down message and then a recovery message. If nothing arrives,
check that you messaged the bot first — Telegram will not deliver to a chat that
has never spoken to it.
