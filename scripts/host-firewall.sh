#!/usr/bin/env bash
# The host firewall: the home network and the tailnet get in, nothing else does.
#
# Two chains, and both are needed. INPUT covers what runs on the host itself
# (ssh, Samba, Caddy, the backup and pcswitch services). DOCKER-USER covers
# published container ports, which never pass through INPUT because Docker
# routes them through FORWARD. Doing only one is how "SSH is closed but every
# web UI is still open" happens.
#
# Only the uplink is filtered. Tailscale, the docker bridges (Glance reaches the
# host services at 172.28.10.1) and a direct cable are left alone, which is the
# same shape the Pi had with wlan0.
#
# Safe to run any number of times: each run flushes and refills its own chain
# and adds the jump only if it is missing. Run by media-stack-firewall.service
# after docker starts, and again whenever docker restarts.
set -euo pipefail

# The uplink, named rather than guessed: at boot the Wi-Fi may not have a
# default route yet, and a rule on an interface name works before it is up.
WAN_IF=${WAN_IF:-$(ip route show default | awk '{print $5; exit}')}
LAN_CIDR=${LAN_CIDR:-192.168.0.0/24}
[ -n "$WAN_IF" ] || { echo "no WAN_IF and no default route - set WAN_IF" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

# $1 = iptables or ip6tables
host_in() {
  local ipt=$1
  $ipt -N HOST-IN 2>/dev/null || true
  $ipt -F HOST-IN
  $ipt -A HOST-IN -i lo -j ACCEPT
  $ipt -A HOST-IN -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  $ipt -A HOST-IN ! -i "$WAN_IF" -j RETURN
  # Tailscale's own direct connections, and ssh from anywhere as the way back in.
  $ipt -A HOST-IN -p udp --dport 41641 -j ACCEPT
  $ipt -A HOST-IN -p tcp --dport 22 -j ACCEPT
  if [ "$ipt" = iptables ]; then
    $ipt -A HOST-IN -p icmp -j ACCEPT
    $ipt -A HOST-IN -s "$LAN_CIDR" -j ACCEPT
  else
    # Neighbour discovery and router adverts are ICMPv6; block them and IPv6
    # stops working. DHCPv6 answers come from the router's link-local address.
    $ipt -A HOST-IN -p ipv6-icmp -j ACCEPT
    $ipt -A HOST-IN -s fe80::/10 -p udp --dport 546 -j ACCEPT
  fi
  $ipt -A HOST-IN -j DROP
  # Appended, so tailscale's ts-input (which it keeps first) still runs first.
  $ipt -C INPUT -j HOST-IN 2>/dev/null || $ipt -A INPUT -j HOST-IN
}

# Docker creates DOCKER-USER and jumps to it first in FORWARD; its contents are
# ours. NEW connections only: replies to what containers opened still pass.
docker_user() {
  local ipt=$1
  $ipt -L DOCKER-USER -n >/dev/null 2>&1 || return 0
  $ipt -F DOCKER-USER
  if [ "$ipt" = iptables ]; then
    $ipt -A DOCKER-USER -i "$WAN_IF" -s "$LAN_CIDR" -j RETURN
  fi
  $ipt -A DOCKER-USER -i "$WAN_IF" -m conntrack --ctstate NEW -j DROP
  $ipt -A DOCKER-USER -j RETURN
}

for ipt in iptables ip6tables; do
  host_in "$ipt"
  docker_user "$ipt"
done
echo "firewall applied on $WAN_IF (LAN $LAN_CIDR)"
