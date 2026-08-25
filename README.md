# MediaStack

Self-hosted media stack on a Raspberry Pi 5: acquisition, libraries, and the
apps that serve them. 14 services, one Compose project.

## Quick start

```bash
cp docker-compose.env.example docker-compose.env   # then fill it in

# the shared network, created once outside every stack
docker network create mediastack --driver bridge   --subnet 172.28.10.0/24 --gateway 172.28.10.1

for s in vpn arr media immich monitoring management dockge; do
  (cd stacks/$s && docker compose up -d)
done
```

Or manage them from **Dockge** at `:5001`, which edits the compose files
directly so the browser and git stay in sync.

Per stack:

```bash
cd stacks/arr
docker compose up -d          # start
docker compose pull           # update images
docker compose logs -f sonarr
```

Everything is included from `docker-compose.yml`, so ordinary Compose commands
operate on the whole stack:

```bash
docker compose up -d              # start everything
docker compose up -d sonarr       # just one service
docker compose logs -f jellyfin
docker compose pull               # update images
docker compose down
```

## Services

| | Service | Port | Notes |
|---|---|---|---|
| **VPN** | gluetun | 8320 | ProtonVPN over WireGuard |
| | qbittorrent | 8200 | inside the tunnel |
| | prowlarr | 9696 | inside the tunnel |
| | flaresolverr | 8191 | inside the tunnel |
| **Automation** | sonarr | 8989 | TV |
| | radarr | 7878 | films |
| | bazarr | 6767 | subtitles |
| | mylar | 8090 | comics |
| **Libraries** | jellyfin | 8096 | video |
| | kavita | 5000 | books, comics, manga |
| | audiobookshelf | 13378 | audiobooks, podcasts |
| | immich | 2283 | photos and video |
| **Management** | homepage | 3000 | dashboard |

## Network

Only the acquisition services are tunnelled:

```
          ┌── ProtonVPN ──┐
          │                │
     [ gluetun ] ← qbittorrent, prowlarr, flaresolverr
          │
  ════════╪════════ mediastack bridge ════════
          │
  sonarr radarr bazarr mylar jellyfin kavita
```

qBittorrent is tunnelled because BitTorrent announces your IP to every peer in
the swarm. Prowlarr and FlareSolverr because some indexers are geo-blocked.
Nothing else benefits, and routing a media server through another country only
makes streaming slower.

Those three share gluetun's network namespace, so **they have no hostnames of
their own**. Two addresses that are easy to get wrong:

| From | To | Use |
|---|---|---|
| Sonarr, Radarr, Mylar | qBittorrent | `gluetun:8200` — not `qbittorrent:8200` |
| Sonarr, Radarr | Prowlarr | `gluetun:9696` |
| Prowlarr | FlareSolverr | `http://localhost:8191` — same namespace |

If the tunnel drops, those three lose all connectivity rather than falling back
to the real connection. That is the kill switch working.

## Storage

```
/srv/storage/
├── appdata/                 container configs
└── data/                    Samba share
    └── media/               FOLDER_FOR_MEDIA
        ├── library/         tv, anime, movies, comics
        ├── torrents/        watch, incomplete, categories
        ├── books/           Kavita
        ├── audiobooks/      Audiobookshelf
        └── gallery/         Immich - app-managed, do not reorganise
```

**`library/` and `torrents/` must stay siblings under one parent.** That is what
lets the *arr apps hardlink an import instead of copying it — the file exists in
both places while using the disk space once. Mount the parent as a single volume
(`/data`), never the subfolders separately: two mounts look like two filesystems
inside the container and hardlinking silently degrades to copying.

Verify it works:

```bash
touch data/media/torrents/.t && ln data/media/torrents/.t data/media/library/.t
stat -c %h data/media/torrents/.t     # 2 means hardlinks work
```

Deleting the downloads copy of a hardlinked file frees no space until every link
is gone. That is correct, not a bug.

## Raspberry Pi notes

**No hardware video encoder.** The Pi 5 decodes H.265 but cannot encode at all,
so Jellyfin transcoding runs on CPU and is slow. Prefer direct play. This is also
why Tdarr is not in the stack.

**Immich machine learning runs on CPU.** Its accelerated images target Mali,
NVIDIA, Intel and Rockchip; the Pi 5's VideoCore VII matches none of them.

**`IMMICH_VERSION` is pinned.** Immich's database migrations are one-way — an
accidental major upgrade cannot be rolled back without restoring a dump. Read
the release notes before changing it.

## Configuration

`docker-compose.env` holds everything, and is gitignored because it contains
WireGuard keys and the Immich database password. `docker-compose.env.example`
lists what must be set.

Notable gluetun settings, and why:

- **No `VPN_ENDPOINT_IP`.** Pinning one server by IP leaves nothing to fail over
  to when the provider retires or overloads it, and it silently overrides
  `SERVER_COUNTRIES`. Name countries instead.
- **`VPN_PORT_FORWARDING=on`.** Without an inbound port no peer can initiate a
  connection, and transfers crawl. The UP command pushes each newly assigned
  port into qBittorrent, since a new one is issued on every reconnect.
- **`FIREWALL_OUTBOUND_SUBNETS` / `EXTRA_SUBNETS`.** Without these the firewall
  drops LAN traffic and every WebUI behind the tunnel becomes unreachable.

## Scripts

`scripts/reorganise-media.sh` is a one-off that reshapes a migrated media tree
into the layout above. It takes `--dry-run` and refuses to run while a transfer
is active.

## Remote access

Tailscale runs on the host, not in a container, so the whole Pi joins the
tailnet and every service is reachable on its normal port. No open ports, no
domain, no certificates, nothing exposed to the internet - only devices signed
into the tailnet can reach it.

| From anywhere | |
|---|---|
| Dashboard | `http://aboriis-pi.tail54d520.ts.net` |
| Immich | `:2283` |
| Jellyfin | `:8096` |
| Dockge | `:5001` |

MagicDNS resolves the name, so the URLs differ from the LAN ones only in the
hostname.

**Homepage needs every name added to `HOMEPAGE_ALLOWED_HOSTS`.** It rejects any
Host header it does not recognise with a blank 400, which looks like the
service being down. The tailnet IP and MagicDNS name are both listed there.

**Subnet routing is advertised but needs approving** in the Tailscale admin
console under Machines → aboriis-pi → Edit route settings. Until then the Pi
itself is reachable but other devices on the home LAN are not. It also needs
IP forwarding enabled on the host to work properly.

**Consider disabling key expiry** for this machine. Tailscale expires device
keys every 180 days by default, and a headless server then silently drops off
the tailnet until someone re-authenticates it.
