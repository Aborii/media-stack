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
printf "  forwarded port    : %s (written %s)\n" \
  "$(cat /srv/storage/appdata/gluetun/forwarded_port 2>/dev/null)" \
  "$(stat -c %y /srv/storage/appdata/gluetun/forwarded_port 2>/dev/null | cut -d. -f1)"
docker exec gluetun wget -qO- -T8 "http://127.0.0.1:8200/api/v2/transfer/info" 2>/dev/null \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('  qbittorrent       : %s, dht %d' % (d['connection_status'], d['dht_nodes']))" 2>/dev/null

echo
if [ "$drops" -eq 0 ] && [ "$health" -eq 0 ]; then
  echo "  VERDICT: no drops since this container started."
else
  echo "  VERDICT: it dropped $drops time(s). Check the DNS errors above first -"
  echo "           that was the cause last time, not the VPN provider."
fi
