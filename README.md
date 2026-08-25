# MediaStack

Self-hosted media stack on a Raspberry Pi 5: acquisition, libraries, and the
apps that serve them. 26 containers across seven Compose stacks.

**Rebuilding on a new Pi? Read [REBUILD.md](REBUILD.md) first.** A lot of what
makes this work lives inside application databases rather than in any file
here, and it is invisible until something quietly does not work.

## Quick start

```bash
cp docker-compose.env.example docker-compose.env   # then fill it in

# the shared network, created once outside every stack
docker network create mediastack --driver bridge   --subnet 172.28.10.0/24 --gateway 172.28.10.1

for s in vpn arr media immich monitoring management postgres; do
  (cd stacks/$s && docker compose up -d)
done
```

Or manage them from **Portainer** at `:9000`. Dockge was used for a while and
removed; the per-stack directory layout it required was kept because it is
useful on its own.

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
| **Libraries** | jellyfin | 8096 | video |
| | kavita | 5000 | books, comics, manga |
| | immich | 2283 | photos and video |
| **Management** | homepage | 80 | dashboard, password protected |
| | portainer | 9000 | container management |
| | tdarr | 8265 | transcoding server, node runs elsewhere |
| **Monitoring** | uptime-kuma | 3001 | 15 service checks |
| | scrutiny | 8081 | drive SMART health |
| | dozzle | 8888 | live container logs |
| | glances | - | host metrics, bound to the docker gateway |
| | diun | - | image update watcher |
| **Database** | postgres17 | 5432 | shared cluster, TLS required |

## Network

Only the acquisition services are tunnelled:

```
          ┌── ProtonVPN ──┐
          │                │
     [ gluetun ] ← qbittorrent, prowlarr, flaresolverr
          │
  ════════╪════════ mediastack bridge ════════
          │
  sonarr radarr bazarr jellyfin kavita
```

qBittorrent is tunnelled because BitTorrent announces your IP to every peer in
the swarm. Prowlarr and FlareSolverr because some indexers are geo-blocked.
Nothing else benefits, and routing a media server through another country only
makes streaming slower.

Those three share gluetun's network namespace, so **they have no hostnames of
their own**. Two addresses that are easy to get wrong:

| From | To | Use |
|---|---|---|
| Sonarr, Radarr | qBittorrent | `gluetun:8200` — not `qbittorrent:8200` |
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

| | |
|---|---|
| `backup.sh` | Nightly, as root. Dumps both databases, snapshots appdata, then packs and uploads an archive to the PC. Root is not optional - see below. |
| `tailscale-https.sh` | Puts every web UI behind a real certificate on the tailnet. |
| `vpn-health.sh` | Tells a genuine VPN drop apart from a reboot. |
| `qbit-port-sync.sh` | Pushes Proton's forwarded port into qBittorrent, which changes on every reconnect. |
| `post-boot-check.sh` | What to run after a reboot, since services take ~8 minutes to fully answer. |
| `sync-homepage-examples.py` | Copies the live dashboard config into `examples/`, stripping secrets. |
| `uptime-kuma-*.py` | Recreate the monitors, notifications and status page. |
| `reorganise-media.sh` | One-off, reshapes a migrated media tree into the layout above. `--dry-run`, and refuses to run during a transfer. |

**`backup.sh` must run as root.** `appdata/immich/postgres` and
`appdata/postgres17/data` are mode 700 owned by the container's user. A copy
running as you hits permission denied, **skips them, and reports success** -
which is how Immich once arrived here with 61 GB of photos and an empty
database.

## Backups

Nightly at 03:30. Databases are dumped rather than copied, because a live
PostgreSQL directory copied file-by-file can capture a state that will not
replay. Regenerable data - transcodes, thumbnails, posters, ML models, 35 of
appdata's 36 GB - is excluded; what is kept is the ~1 GB of configuration.

All of that lands on the same disk it is backing up, which covers a bad delete
but not the disk dying. So the last step packs one dated archive and **uploads
it to the PC**, where a small receiver (`receiver/`) verifies the checksum, the
gzip magic and the tar header before keeping it.

The Pi pushes; the PC never reaches in. That way nothing on the PC holds
standing credentials to the Pi. See `receiver/README.md`.

## Remote access

Tailscale runs on the host, not in a container, so the whole Pi joins the
tailnet and every service is reachable on its normal port. Nothing is exposed to
the internet - only devices signed into the tailnet can reach it that way.

The LAN is **also** allowed through the firewall, deliberately: a Pi reachable
only over Tailscale becomes unreachable from the same room whenever the internet
drops, which is a poor failure mode for local storage.

**Use `http://aboriis-pi` everywhere**, not the long tailnet name and not
`.local`. It is the only form that resolves in all three cases - the router
answers for the DHCP hostname at home, mDNS covers it as a fallback, and
MagicDNS covers it remotely. It also keeps the Homepage auth cookie on one host,
which `HOMEPAGE_EXTERNAL_URL` pins to a single name.

| Reachable at | |
|---|---|
| Dashboard | `http://aboriis-pi` |
| Portainer | `:9000` |
| Immich | `:2283` |
| Jellyfin | `:8096` |
| Uptime Kuma | `:3001` |

`scripts/tailscale-https.sh` can put the same services behind real certificates
on the tailnet, on the normal port plus 10000. It is **switched off** - it worked,
but it gave every service a second URL that only applied from some places, and
the dashboard had no way to tell which. `REBUILD.md` has the reasoning.

`.local` is mDNS - a local broadcast that cannot cross Tailscale - so links
built on it work at home and die remotely.

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
