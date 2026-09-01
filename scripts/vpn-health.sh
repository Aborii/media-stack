#!/bin/bash
# Has the VPN tunnel actually dropped, or did the Pi just reboot?
#
# The forwarded port alone cannot answer that: Proton issues a new one on every
# reconnect AND on every fresh start, so a changed port file looks identical
# either way.
#
# gluetun logs "Connecting to" once per tunnel establishment. Within one
# container lifetime that count IS the number of drops:
#
#   1  = connected at startup and never again
#   >1 = it reconnected, and the count-1 is how many times
#
# A reboot starts a new container, so the count resets to 1 - which is correct,
# not a blind spot. Read it together with the uptime below.
set -u

echo "== gluetun =="
printf "  container up      : %s\n" "$(docker ps --filter name=gluetun --format '{{.Status}}')"
printf "  container restarts: %s\n" "$(docker inspect gluetun --format '{{.RestartCount}}')"
printf "  host uptime       : %s\n" "$(uptime -p)"
echo

connects=$(docker logs gluetun 2>&1 | grep -c "Connecting to")
drops=$(( connects > 0 ? connects - 1 : 0 ))
health=$(docker logs gluetun 2>&1 | grep -c "failed to pass the healthcheck")
dnserr=$(docker logs gluetun 2>&1 | grep -ciE "dns.*(error|fail|timeout)")

echo "== since this container started =="
printf "  tunnel connects   : %s\n" "$connects"
printf "  DROPS             : %s%s\n" "$drops" \
  "$( [ "$drops" -eq 0 ] && echo '   <- clean' || echo '   <- it reconnected' )"
printf "  healthcheck fails : %s\n" "$health"
printf "  DNS errors        : %s%s\n" "$dnserr" \
  "$( [ "$dnserr" -gt 0 ] && echo '   <- the old failure mode was DNS' || echo '' )"
echo

echo "== now =="
printf "  resolver          : %s\n" \
  "$(docker inspect gluetun --format '{{range .Config.Env}}{{println .}}{{end}}' \
     | grep DNS_UPSTREAM_RESOLVER_TYPE | cut -d= -f2)"
printf "  exit ip           : %s\n" \
  "$(docker exec gluetun wget -qO- -T8 https://ifconfig.me/ip 2>/dev/null)"
# Ask the container where its own /gluetun is rather than naming a host path.
# This file moved when appdata moved to the NVMe, and the hardcoded path went on
# reporting a port that had been stale for days - silently, because cat on a
# missing file is empty and the 2>/dev/null hid it. An unreadable file now says
# so instead of printing a blank. The check is -r AND -s: the abandoned file was
# readable and empty, so testing readability alone would have stayed quiet in
# exactly the way this is meant to prevent.
gluetun_dir=$(docker inspect gluetun \
  --format '{{range .Mounts}}{{if eq .Destination "/gluetun"}}{{.Source}}{{end}}{{end}}' \
  2>/dev/null)
if [ -z "$gluetun_dir" ]; then
  printf "  forwarded port    : cannot resolve - gluetun has no /gluetun mount, or is gone\n"
elif [ -r "$gluetun_dir/forwarded_port" ] && [ -s "$gluetun_dir/forwarded_port" ]; then
  printf "  forwarded port    : %s (written %s)\n" \
    "$(cat "$gluetun_dir/forwarded_port")" \
    "$(stat -c %y "$gluetun_dir/forwarded_port" | cut -d. -f1)"
else
  printf "  forwarded port    : UNREADABLE OR EMPTY at %s/forwarded_port\n" "$gluetun_dir"
fi
docker exec gluetun wget -qO- -T8 "http://127.0.0.1:8200/api/v2/transfer/info" 2>/dev/null \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('  qbittorrent       : %s, dht %d' % (d['connection_status'], d['dht_nodes']))" 2>/dev/null

echo
if [ "$drops" -eq 0 ] && [ "$health" -eq 0 ]; then
  echo "  VERDICT: no drops since this container started."
else
  echo "  VERDICT: it dropped $drops time(s). Check the DNS errors above first -"
  echo "           that was the cause last time, not the VPN provider."
fi
