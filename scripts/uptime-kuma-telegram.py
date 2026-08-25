#!/usr/bin/env python3
"""Attach a Telegram notification to every Uptime Kuma monitor.

Reuses the bot already configured in Radarr/Sonarr/Prowlarr rather than making a
second one, and posts into its own forum topic so service up/down does not mix
with grab notifications.

uptime-kuma-api targets Uptime Kuma v1 and this instance is v2, so the same
compatibility patches as uptime-kuma-monitors.py may be needed. Read the
comments there before "fixing" anything here.

    uptime-kuma-telegram.py <user> <password> <token> <chat_id> [thread_id]
"""
import sys
from uptime_kuma_api import UptimeKumaApi, NotificationType

user, password, token, chat = sys.argv[1:5]
thread = sys.argv[5] if len(sys.argv) > 5 else None

# 60s: the default socket timeout is short and this instance regularly
# exceeds it on login when the monitors are mid-check.
api = UptimeKumaApi("http://127.0.0.1:3001", wait_events=1.0, timeout=60)
api.login(user, password)
try:
    existing = {n["name"]: n["id"] for n in api.get_notifications()}
    if "Telegram" in existing:
        print("  a notification named Telegram already exists - leaving it alone")
    else:
        kwargs = dict(
            name="Telegram",
            type=NotificationType.TELEGRAM,
            isDefault=True,        # new monitors get it automatically
            applyExisting=True,    # and so do all 15 that already exist
            telegramBotToken=token,
            telegramChatID=chat,
        )
        if thread:
            # Forum supergroups need the topic id or messages land in General.
            kwargs["telegramMessageThreadID"] = thread
        api.add_notification(**kwargs)
        print("  notification created and applied to existing monitors")

    mons = api.get_monitors()
    without = [m["name"] for m in mons if not m.get("notificationIDList")]
    print("  monitors: %d total, %d without an alert" % (len(mons), len(without)))
    for n in without:
        print("    still unattached:", n)
finally:
    api.disconnect()
