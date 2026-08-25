#!/bin/bash
# Serve every web UI over HTTPS on the tailnet.
#
# WHY THIS EXISTS
#
# Everything here is published as plain HTTP. Reached over the LAN that means
# passwords cross a wifi we do not control in the clear. Reached over Tailscale
# it is already encrypted by WireGuard, so the transport was never the problem
# there - but the browser does not know that. It shows "Not secure", refuses to
# offer the password manager, and withholds every API that needs a secure
# context, which is why some of Immich's features quietly do not work remotely.
#
# Tailscale issues a real Let's Encrypt certificate for this node's own name and
# renews it itself. `tailscale serve` terminates TLS with it and forwards to the
# app over localhost.
#
# WHY PORTS RATHER THAN PATHS
#
# The certificate covers exactly one name - there are no wildcards - so every
# service has to live on that one hostname. Two ways to split them:
#
#   paths    https://host/sonarr      needs each app to support a base URL.
#                                     Immich and Portainer do not, and half the
#                                     others need a settings change to match.
#   ports    https://host:18989       works with every app, unchanged.
#
# Ports win. The rule is simply the HTTP port plus 10000, so anything you
# already know still applies. Homepage is the exception and takes 443, since it
# is the front door and should answer at the bare hostname.
#
# The same port cannot be reused: Docker publishes on 0.0.0.0, which already
# includes the Tailscale address, so serve would collide with the container.
#
# HOMEPAGE IS DELIBERATELY ABSENT
#
# It pins its login callback to one hostname, HOMEPAGE_EXTERNAL_URL, and that is
# http://aboriis-pi. Serve it under a second name and signing in silently
# bounces back to the login page - the session cookie is set for a host the
# browser is not on, so nothing reports an error, you just never log in.
#
# It also gains nothing. `aboriis-pi` already resolves in both places: router
# DNS and mDNS on the LAN, MagicDNS over the tailnet. One name, working
# everywhere, is exactly what a pinned callback needs.
#
# THIS IS TAILNET ONLY. The LAN keeps talking plain HTTP on the original ports,
# which is deliberate - local access must not depend on Tailscale being up.
#
#   ./tailscale-https.sh          apply
#   ./tailscale-https.sh --off    remove all of it
set -euo pipefail

# name           http  https
SERVICES=(
  "jellyfin      8096  18096"
  "immich        2283  12283"
  "kavita        5000  15000"
  "audiobookshelf 13378 23378"
  "sonarr        8989  18989"
  "radarr        7878  17878"
  "bazarr        6767  16767"
  "mylar         8090  18090"
  "prowlarr      9696  19696"
  "qbittorrent   8200  18200"
  "portainer     9000  19000"
  "scrutiny      8081  18081"
  "uptime-kuma   3001  13001"
  "dozzle        8888  18888"
  "tdarr         8265  18265"
)

if [ "${1:-}" = "--off" ]; then
  tailscale serve reset
  echo "removed - everything is HTTP again"
  exit 0
fi

# Fails loudly rather than serving a name nothing trusts. HTTPS certificates are
# an admin-console toggle and cannot be turned on from here.
FQDN=$(tailscale status --json | python3 -c 'import sys,json;print((json.load(sys.stdin).get("CertDomains") or [""])[0])')
[ -n "$FQDN" ] || { echo "no cert domain - enable HTTPS Certificates at https://login.tailscale.com/admin/dns" >&2; exit 1; }

tailscale serve reset
for row in "${SERVICES[@]}"; do
  read -r name http https <<<"$row"
  # serve never connects to the target, so a wrong or dead port is accepted
  # silently and only shows up as a browser error when you click the link.
  # The ports here also duplicate docker-compose.env and can drift from it.
  if ! timeout 2 bash -c "</dev/tcp/127.0.0.1/$http" 2>/dev/null; then
    printf '  %-15s SKIPPED - nothing listening on %s
' "$name" "$http"
    continue
  fi
  tailscale serve --bg --https="$https" "http://127.0.0.1:$http" >/dev/null
  printf '  %-15s https://%s:%s\n' "$name" "$FQDN" "$https"
done

echo
echo "done. LAN is unchanged and still HTTP."
