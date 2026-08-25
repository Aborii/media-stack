#!/bin/bash
# Verify everything that must survive a reboot. Run before and after, diff them.
echo "=== uptime ==="
uptime -p
echo
echo "=== storage mounted ==="
findmnt -n -o TARGET,SOURCE,FSTYPE /srv/storage || echo "*** NOT MOUNTED ***"
echo "docker root: $(docker info 2>/dev/null | grep -i 'root dir' | tr -d ' ')"
echo
echo "=== firewall: INPUT wlan0 rules ==="
sudo -n iptables -S INPUT 2>/dev/null | grep -- '-i wlan0' || echo "  (needs sudo)"
echo "=== firewall: DOCKER-USER ==="
sudo -n iptables -S DOCKER-USER 2>/dev/null || echo "  (needs sudo)"
echo "=== docker-firewall.service ==="
systemctl is-active docker-firewall.service
echo
echo "=== containers ==="
echo "running: $(docker ps -q | wc -l) / total: $(docker ps -aq | wc -l)"
docker ps --format '{{.Names}}' | sort | tr '\n' ' '; echo
echo
echo "=== not running (should be empty) ==="
docker ps -a --filter status=exited --filter status=created --format '{{.Names}} {{.Status}}' || true
echo
echo "=== tailscale ==="
tailscale status --json 2>/dev/null | grep -E '"BackendState"' | head -1
echo
echo "=== vpn + torrent ==="
docker exec gluetun wget -qO- -T8 https://ifconfig.me/ip 2>/dev/null | sed 's/^/  exit ip: /'
docker exec gluetun wget -qO- -T8 'http://127.0.0.1:8200/api/v2/transfer/info' 2>/dev/null \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('  qbit: %s  dht=%d  dl=%.0f KB/s' % (d['connection_status'], d['dht_nodes'], d['dl_info_speed']/1024))" 2>/dev/null
docker exec gluetun wget -qO- -T8 'http://127.0.0.1:8200/api/v2/app/preferences' 2>/dev/null \
  | python3 -c "import json,sys; p=json.load(sys.stdin); print('  qbit iface: %r  listen_port: %s' % (p.get('current_interface_address'), p.get('listen_port')))" 2>/dev/null
echo
echo "=== samba ==="
systemctl is-active smbd
echo
echo "=== LAN reachability (from the pi itself, ports listening) ==="
for p in 80 445 3001 9000 8096 2283; do
  printf "  :%-5s " "$p"
  ss -tln 2>/dev/null | grep -q ":$p " && echo "listening" || echo "NOT listening"
done
