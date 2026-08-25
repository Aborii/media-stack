#!/bin/sh
# Keep qBittorrent's listen port matching the port Proton is forwarding.
#
# gluetun's UP command already pushes the port whenever the TUNNEL changes.
# This covers the other direction, which nothing else did: qBittorrent
# restarting on its own comes back on TORRENTING_PORT (6881) from the compose
# file, while gluetun still holds whatever Proton last handed out. Peers are
# then directed at a port nothing is listening on, so nobody can reach us -
# transfers still trickle outbound but connection_status drops to "firewalled"
# and swarms stay slow. It self-corrected only at the next VPN reconnect, which
# could be hours.
#
# Runs inside gluetun's network namespace, so 127.0.0.1 is qBittorrent and
# LocalHostAuth=false means no credentials are needed or stored here.

API=http://127.0.0.1:8200/api/v2
FILE=/gluetun/forwarded_port
INTERVAL=30

echo "[port-sync] watching $FILE every ${INTERVAL}s"

while true; do
  want=$(cat "$FILE" 2>/dev/null)

  # Skip while the port file is absent, empty, zero or not a number - that is
  # simply the tunnel not having a forward yet, not an error worth logging.
  case "$want" in
    ''|0|*[!0-9]*) sleep "$INTERVAL"; continue ;;
  esac

  have=$(wget -qO- --timeout=5 "$API/app/preferences" 2>/dev/null \
         | sed -n 's/.*"listen_port":\([0-9]*\).*/\1/p')

  # Empty means the API is not up yet (qBittorrent waits on gluetun's
  # healthcheck, so this is normal for the first few seconds after a start).
  if [ -n "$have" ] && [ "$have" != "$want" ]; then
    if wget -qO- --timeout=5 \
         --post-data="json={\"listen_port\":${want},\"random_port\":false,\"upnp\":false}" \
         "$API/app/setPreferences" >/dev/null 2>&1; then
      echo "[port-sync] corrected qBittorrent ${have} -> ${want}"
    else
      echo "[port-sync] failed to set ${want} (API refused)"
    fi
  fi

  sleep "$INTERVAL"
done
