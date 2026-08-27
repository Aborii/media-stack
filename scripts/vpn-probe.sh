#!/bin/bash
# Ping 1.1.1.1 from two places every 5s - the Pi directly, and from inside
# gluetun so the packet crosses the tunnel - recording which Proton endpoint was
# in use at the time.
#
# WHY
#
# The tunnel was rebuilding every 1-2 hours and two plausible explanations (DNS,
# then MTU) both died on contact with evidence. Measuring settled it: over 9.5
# hours there were 166 tunnel-only losses against 11 shared with the wifi, and
# during a 2.5 minute total tunnel outage the Pi's own connection lost nothing
# and averaged 9ms. It is Proton's side.
#
# The endpoint column answers what comes next - whether specific servers are the
# bad ones, which turns "Proton is flaky" into a change worth making.
#
# WHERE IT WRITES
#
# /srv/storage/appdata/vpn-measure - on the data disk, so it survives an SD card
# reflash, and inside appdata, so the nightly backup ships it to the PC with
# everything else. One file per day, kept indefinitely; it is ~700KB a day.
#
# The endpoint comes from gluetun's log, not `wg show`: there is no wg binary in
# the image, wg0.conf is not readable, and the control server costs 1.7s a call
# because it needs a container. The log tail costs 33ms.
set -u
DIR=${DIR:-/srv/storage/appdata/vpn-measure}
EP="?"
i=0

while true; do
  # Re-read once a minute. It only changes on reconnect, and the reconnect is
  # timestamped in gluetun's own log anyway.
  if [ $((i % 12)) -eq 0 ]; then
    e=$(docker logs gluetun --tail 3000 2>&1 | grep "Connecting to" | tail -1 | grep -oE "[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+" || true)
    [ -n "$e" ] && EP="$e"
  fi
  i=$((i+1))

  OUT="$DIR/probe-$(date +%F).log"
  if [ ! -f "$OUT" ]; then
    echo "# time host_ms tunnel_ms endpoint   (LOSS = no reply in 3s)" >> "$OUT"
    # A new day started. Compress the finished ones. This directory sits inside
    # appdata, so every uncompressed byte is re-tarred and re-uploaded by the
    # nightly backup for as long as it exists - a year of plain text would be
    # ~250MB carried in every archive. gzip is about 10:1 on data this
    # repetitive, and nothing is discarded.
    find "$DIR" -maxdepth 1 -name 'probe-*.log' ! -name "$(basename "$OUT")"          -exec gzip -q {} \; 2>/dev/null || true
  fi

  ts=$(date +%H:%M:%S)
  h=$(ping -c1 -W3 -q 1.1.1.1 2>/dev/null | awk -F'/' '/rtt/{printf "%.1f", $5}')
  # Distinguish "gluetun could not be reached" from "the tunnel dropped the
  # packet". Recording the first as LOSS would corrupt the very number this
  # exists to measure - a docker restart would read as a VPN outage.
  if docker exec gluetun true 2>/dev/null; then
    t=$(docker exec gluetun ping -c1 -W3 -q 1.1.1.1 2>/dev/null | awk -F'/' '/round-trip|rtt/{printf "%.1f", $5}')
    t=${t:-LOSS}
  else
    t=NOGLUETUN
  fi
  printf '%s %-7s %-7s %s\n' "$ts" "${h:-LOSS}" "${t:-LOSS}" "$EP" >> "$OUT"
  sleep 5
done
