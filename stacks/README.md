# Stacks

One directory per stack, each with its own `compose.yaml`, managed either by
Dockge at `:5001` or by `docker compose` from inside the directory.

| Stack | Contains |
|---|---|
| `vpn` | gluetun, qbittorrent, prowlarr, flaresolverr |
| `arr` | sonarr, radarr, bazarr |
| `media` | jellyfin, kavita |
| `immich` | server, machine-learning, postgres, valkey |
| `monitoring` | uptime-kuma, scrutiny, dozzle, glances, wud |
| `dockge` | the UI itself |

## Three things that are load-bearing

**The `vpn` four cannot be separated.** `network_mode: service:gluetun` only
resolves within one Compose project. Split them and it degrades to
`container:gluetun`, which creates no startup ordering and silently kills
networking in all three whenever gluetun restarts.

**`mediastack` is created outside every stack**, so no single stack owns it and
bringing one down cannot take the others' networking with it:

```bash
docker network create mediastack --driver bridge \
  --subnet 172.28.10.0/24 --gateway 172.28.10.1
```

**Do not set `COMPOSE_PROJECT_NAME`.** With it set, every directory resolves to
the same project and Compose merges them back into one - Dockge would show a
single stack. Each directory takes its own name as the project instead.

## The env file

One real file at the repo root, symlinked into each stack:

```
docker-compose.env          <- the only real copy, gitignored
stacks/*/.env               -> symlink to it
```

Compose only reads `.env` from the compose file's own directory; it does not
search parent directories. Editing the real file changes every stack at once.

## Addresses that look wrong and are not

qBittorrent and Prowlarr share gluetun's network namespace and have no
hostname on the bridge. From other stacks they are reached at:

| Service | Address |
|---|---|
| qBittorrent | `gluetun:8200` |
| Prowlarr | `gluetun:9696` |
| FlareSolverr, from Prowlarr | `http://localhost:8191` |
