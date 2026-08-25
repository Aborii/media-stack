# Rebuilding this on a new Pi

The compose files and scripts get you most of the way. This covers the rest —
the settings that live inside an application's own database or config directory,
which no file in this repo can carry, and which are invisible until something
quietly does not work.

**Read the order.** Several steps only work if an earlier one is already done.

---

## Phase 1 — the host

Use [Aborii/pi5-nas-setup](https://github.com/Aborii/pi5-nas-setup). Its
`TROUBLESHOOTING.md` is the important file; the script is short.

```bash
sudo bash pi5-setup.sh --country US --device /dev/sda1
sudo reboot
```

It handles the Wi-Fi ccode-map overlay (without it a Pi 5 cannot see 5 GHz
channels 149-165 and no country setting helps), the memory cgroup, mounting the
data disk by UUID, Docker, and Samba.

**The one that is easy to miss:** `data-root` in `daemon.json` is not enough.
Since Docker 28 the image layers live in **containerd's** store, which has its
own `root` that `daemon.json` does not govern. Miss it and `docker info` reports
the data disk while tens of gigabytes of layers fill the SD card — and `du` will
not show them unless you are root, so the space just looks unaccounted for. The
setup script now does both; on an older copy, check `/etc/containerd/config.toml`
has a `root` line.

Then the network access and Samba hardening scripts from the same repo:

```bash
sudo scripts/lan-access.sh      # LAN reaches the Pi without tailscale
sudo scripts/samba-harden.sh    # SMB3, mandatory signing, required encryption
```

`lan-access.sh` touches **two** chains and that is the whole point. `INPUT`
covers host services; `DOCKER-USER` covers published container ports, which
never traverse `INPUT` because Docker routes them through `FORWARD`. Doing one
and not the other is why "SSH works but every web UI times out".

Tailscale last — see `TAILSCALE.md` in that repo. Two things cannot be set from
the Pi: **approve the subnet route** and **disable key expiry**, both in the
admin console. Key expiry is 180 days, and when it fires the Pi silently leaves
the tailnet.

---

## Phase 2 — the stack

```bash
git clone https://github.com/Aborii/media-stack.git ~/media-stack
cd ~/media-stack
cp docker-compose.env.example docker-compose.env    # then fill it in

docker network create mediastack --driver bridge \
  --subnet 172.28.10.0/24 --gateway 172.28.10.1

for s in vpn arr media immich monitoring management postgres; do
  (cd stacks/$s && docker compose up -d)
done
```

**vpn first.** Everything in it shares gluetun's network namespace and waits on
its healthcheck.

---

## Phase 3 — the settings no file can carry

This is the part that costs a day if it is not written down.

### qBittorrent — bind it to the tunnel

**Options > Advanced > Network Interface > tun0**, and the optional IP address
to `10.2.0.2`.

Without this libtorrent opens a socket on *every* interface including the Docker
bridge. Gluetun routes bridge-sourced traffic out `eth0`, where its firewall only
permits the bridge, the LAN and the VPN endpoint, so those announces are dropped
— and a locally generated packet killed by OUTPUT returns EPERM, which
qBittorrent reports as **"Operation not permitted"** on every UDP tracker.

Symptoms: `dht_nodes` stuck at 0, zero peers, nothing downloads, while the tunnel
itself tests perfectly healthy. It looks like a VPN fault and is not.

It doubles as a kill switch: the interface disappears if the tunnel drops.

### qBittorrent — the rest

- WebUI password: **Options > Web UI > Authentication**. Stored as a PBKDF2 hash,
  so it cannot be recovered, only reset.
- Save path `/data/torrents/complete`, temp `/data/torrents/incomplete`.
- Categories: `radarr` to `/data/torrents/movies`, `tv-sonarr` to `/data/torrents/tv`.

Downloads and library **must** sit under the same mount or imports copy instead
of hardlinking and every file is stored twice. Linux refuses `link()` across
mount points even on one filesystem, and a bind mount counts as a separate mount
— verified, not assumed. That is why there is a single `/data` mount rather than
`/downloads` and `/media`.

### Sonarr and Radarr

- Download client host is **gluetun**, not `qbittorrent`. Anything sharing
  gluetun's namespace has no hostname of its own on the bridge.
- Categories must match the ones set in qBittorrent above.
- Root folders: `/data/library/tv`, `/data/library/anime`, `/data/library/movies`.

**If you restore an old database**, movies, **collections** and **import lists**
each carry their own `rootFolderPath`. Fixing the movies alone leaves Radarr
health complaining — 256 collections and one import list also needed changing.

### Prowlarr

- Apps: Sonarr `http://sonarr:8989`, Radarr `http://radarr:7878`.
- Prowlarr Server field: **`http://gluetun:9696`**, again because it has no name
  of its own.
- FlareSolverr is at `http://localhost:8191` *from Prowlarr* — same namespace.
- The proxy only applies to indexers carrying its **tag**. An untagged indexer
  behind Cloudflare fails while every other one passes, which looks like that
  indexer being down.
- Set the FlareSolverr proxy **requestTimeout to 120**, not the default 60. A Pi
  running headless Chrome through a VPN exiting in another country is slower
  than the desktop that default was chosen for, and a challenge needing 65
  seconds fails purely on the clock. It costs nothing on the fast path.

### gluetun — DNS

`DNS_UPSTREAM_RESOLVER_TYPE=doh` is in the compose file and matters more than it
looks. The default is DoT, and ProtonVPN resets those handshakes on port 853.
Nothing in the namespace can then resolve a hostname, and because gluetun's own
healthcheck resolves a name, it fails and restarts the tunnel in a loop.

That presents as "the VPN keeps dropping" for weeks. It is DNS.

### gluetun — proxies for devices that are not containers

Only the four containers in the `vpn` stack ride the tunnel. `SHADOWSOCKS=on`
and `HTTPPROXY=on` let a phone or a PC do the same without joining it.

Shadowsocks (8388 tcp **and** udp) encrypts the hop from the device to the Pi
and needs a client app on each device. The HTTP proxy is typed straight into
Windows or browser settings with nothing installed, but that hop is plaintext,
so it carries its own password and a different one.

**8888 is already dozzle**, which is why the HTTP proxy is published on 3128.
Compose does not warn about this in advance — gluetun recreates fine and then
fails to start with `Bind for 0.0.0.0:8888 failed: port is already allocated`,
having already torn down qBittorrent, Prowlarr and FlareSolverr with it. Check
`docker ps --format '{{.Ports}}'` before publishing any new port on this host.

Both ports are open to the LAN, so anyone who reaches them and knows the
password sends traffic out of the VPN subscription as you. Long random
passwords, not memorable ones.

Verify by comparing three addresses — the Pi's own, gluetun's, and the proxy's.
The first must differ from the other two:

```bash
curl -s ifconfig.me/ip                                    # the Pi, not the VPN
docker exec gluetun wget -qO- https://ifconfig.me/ip      # the VPN
curl -s -x http://user:pass@<pi>:3128 https://ifconfig.me/ip   # must match gluetun
curl -s -o /dev/null -w '%{http_code}
' -x http://<pi>:3128 https://ifconfig.me/ip  # must fail
```

### gluetun — the control server answers 401 until you write a config

Since v3.40 every control-server route is private by default. With no file at
`/gluetun/auth/config.toml` the whole API returns 401 — including the routes the
dashboard reads — and nothing in the log explains why, because 401 *is* the
configured behaviour.

Grant only what is needed. `PUT /v1/vpn/status` stops the tunnel, so a key that
leaks should not reach it:

```toml
[[roles]]
name = "homepage"
routes = ["GET /v1/publicip/ip", "GET /v1/vpn/status", "GET /v1/portforward",
          "GET /v1/openvpn/portforwarded"]
auth = "apikey"
apikey = "..."
```

`/v1/openvpn/portforwarded` is the old path and **301s** to `/v1/portforward`.
Both are listed because a redirect lands on a route that must itself be granted.
In Homepage this is what `version: 2` on the widget is for — version 1 asks for
the old path, and a redirect the proxy will not follow fails the *entire*
widget, not just the port field. The tile then renders with no numbers and no
error anywhere, which reads as a bad API key.

Validate the file before restarting the real thing, since a bad config takes the
whole stack down with it:

```bash
docker run --rm --cap-add NET_ADMIN -v /path/auth:/gluetun/auth   -e VPN_SERVICE_PROVIDER=custom -e VPN_TYPE=wireguard ... qmcgaw/gluetun
# want: "read 1 roles from authentication file"
```

**Recreating gluetun alone is not enough.** The four containers using
`network_mode: service:gluetun` hold its old container id. Recreate gluetun by
itself and all four keep pointing at a namespace that no longer exists — they
report Up and have no network at all. Recreate the whole stack.

### Immich

The database is **not** in the file store. Backing up `library/` and restoring it
onto a fresh install gives you an empty Immich with all your photos on disk and
no way to see them.

Automatic dumps land in `UPLOAD_LOCATION/backups`. To restore:

1. Pin `IMMICH_VERSION` to the version **in the dump's filename**.
2. Drop and recreate the database, then restore with
   `psql --single-transaction --set ON_ERROR_STOP=on` so a failure rolls back.
3. Start Immich on that version and confirm users and assets are there.
4. Only then move to the current version and let it migrate.

Restoring a 2.x dump straight into 3.x is not worth the gamble.

### Postgres — TLS

Port 5432 is published. On a network you do not control, scram-sha-256 protects
the login but **everything after it is plaintext** without TLS.

Generate the certificate as **uid 70** — postgres in the alpine image, not the
999 a Debian-based image uses:

```bash
docker run --rm -u 70:70 -v <datadir>:/d -w /d alpine/openssl \
  req -new -x509 -days 3650 -nodes -out server.crt -keyout server.key \
  -subj "/CN=aboriis-pi" \
  -addext "subjectAltName=IP:<lan-ip>,IP:<tailscale-ip>,DNS:aboriis-pi"
```

No domain is needed — the SAN carries the addresses, so `verify-full` works.

Then force it, because *offering* TLS only helps clients that remember to ask:

```bash
docker exec -u 0 postgres17 sed -i \
  "s|^host all all all scram-sha-256|hostssl all all all scram-sha-256|" \
  /var/lib/postgresql/data/pg_hba.conf
docker exec postgres17 psql -U postgres -c "select pg_reload_conf();"
```

Both files live in the data directory, so a fresh initdb silently restores
plaintext. Verify with `sslmode=disable` — it must be refused **before** any
password check.

Clients need the cert. libpq reads `%APPDATA%\postgresql\root.crt` on Windows
automatically. Node's `pg` ignores `sslmode` in the URL entirely and needs
`ssl: { ca, rejectUnauthorized: true }` passed explicitly.

### Homepage

Set `HOMEPAGE_AUTH_ENABLED`, `HOMEPAGE_AUTH_PASSWORD`, `HOMEPAGE_AUTH_SECRET`
and `HOMEPAGE_EXTERNAL_URL` in `docker-compose.env`.

Two reasons, not one. Without auth the dashboard answers 200 to anyone who can
reach it — a full index of every service with working links. And Homepage serves
`custom.js` **only to authenticated users**, so the script that makes links
follow the host you arrived on does nothing at all with auth off.

`HOMEPAGE_EXTERNAL_URL` pins the login callback to one hostname. Reach the
dashboard by a different name and the session cookie lands on the wrong host and
you appear logged out.

Widget API keys go in `services.yaml`, which is mode 600 and deliberately not in
this repo. `examples/homepage/` holds sanitised copies. The Immich key needs only
`server.statistics`; Portainer needs the environment id from `/api/endpoints`,
which is not always 2.

### Uptime Kuma

```bash
python3 -m venv ~/.venv-kuma && ~/.venv-kuma/bin/pip install uptime-kuma-api
~/.venv-kuma/bin/python scripts/uptime-kuma-monitors.py <user> <password>
~/.venv-kuma/bin/python scripts/uptime-kuma-status-page.py <user> <password>
```

Pin the image to `:2`. The `1` and `latest` tags are the old branch — `latest`
still points at v1, so following it keeps you on a line last updated in 2025.

`uptime-kuma-api` targets v1 and breaks three ways against v2. All three are
patched inside those scripts; read the comments before "fixing" them.

### Scrutiny

`collector.yaml` needs an explicit device and `type: sat` — autodetection misses
a drive behind a USB bridge. Map the device by its **WWN** path in compose, not
`/dev/sdX`, which changes when a disk moves port.

`S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0` is required or it half-starts on a cold
boot: `s6-rc: fatal: timed out`, after which the container sits there reporting
Up while serving nothing, and `restart: unless-stopped` never fires because it
only reacts to an exit.

### Portainer

Set the admin password within a few minutes of first start or it locks itself.

---

## Phase 4 — verifying

Do not trust "the container is running".

```bash
# containerd really is on the disk, not the card
docker exec homepage grep -oE "upperdir=[^,]*" /proc/mounts

# hardlinks work, so imports do not duplicate
docker exec radarr sh -c "touch /data/torrents/movies/.t && ln /data/torrents/movies/.t /data/library/movies/.t && echo OK; rm -f /data/torrents/movies/.t /data/library/movies/.t"

# torrenting is actually connectable
docker exec gluetun wget -qO- http://127.0.0.1:8200/api/v2/transfer/info
#   want connection_status "connected" and dht_nodes climbing

# the split is right: gluetun on the VPN, the Pi on its own line
docker exec gluetun wget -qO- https://ifconfig.me/ip
curl -s ifconfig.me

# postgres refuses plaintext
psql "postgresql://user@host:5432/db?sslmode=disable"   # must FAIL
```

**Then reboot and check again.** Saved is not the same as proven — the firewall
rules, the mount, the containerd root and qBittorrent's interface binding all
have to survive a boot, and services take about **8 minutes** to fully answer.
Checking at 3 minutes produces false failures.

---

## Things that will bite you

| Symptom | Cause |
|---|---|
| SSH fine, every web UI times out | Only `INPUT` opened, not `DOCKER-USER` |
| VPN "keeps dropping" for weeks | gluetun DoT blocked; use DoH |
| Grabs work, nothing downloads | qBittorrent not bound to `tun0` |
| Imports duplicate every file | Downloads and library on separate mounts |
| `docker info` says disk, SD still fills | containerd root not set |
| Immich asks to create an admin | Database not restored; files alone are not enough |
| Dashboard fine, every link dead remotely | `href` on a `.local` name |
| Container Up but serving nothing | s6 init timed out; needs a healthcheck to notice |
| One indexer fails, the rest fine | FlareSolverr tag missing on that indexer |
