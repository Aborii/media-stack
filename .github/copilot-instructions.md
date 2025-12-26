# MediaStack Copilot Instructions

## Project Overview

MediaStack is a Docker-based media management system orchestrating 20+ containerized services (Jellyfin, Plex, Sonarr, Radarr, etc.) with VPN routing through Gluetun. This is an enhanced fork of [geekau/mediastack](https://github.com/geekau/mediastack) with unified management tooling.

## Architecture

### VPN-First Network Design

**Critical**: All *ARR services (Radarr, Sonarr, Prowlarr, etc.) and download clients route through the `gluetun` VPN container using `network_mode: "container:gluetun"`. This means:
- Services have NO independent network stack - they share Gluetun's network namespace
- Port mappings are defined ONLY in `compose/docker-compose-gluetun.yaml`
- Services cannot have their own `ports:` sections (they're commented out)
- WebUI access is via ports forwarded through Gluetun

**Example** ([docker-compose-radarr.yaml](compose/docker-compose-radarr.yaml)):
```yaml
network_mode: "container:gluetun"
# ports:
#   - "${WEBUI_PORT_RADARR:?err}:7878"  # Configured in Gluetun instead
```

**Standalone services** like Immich, Portainer, SWAG use the `mediastack` bridge network directly.

### Service Orchestration

The [scripts/mediastack.sh](scripts/mediastack.sh) wrapper implements:
- **Gluetun-first startup**: Always starts Gluetun before VPN-dependent services, with VPN connection verification (waits for "Public IP address is" log message)
- **Whitelist filtering**: Only services in [services.whitelist](services.whitelist) are managed (use `--all` to override)
- **Dynamic compose loading**: Iterates `compose/docker-compose-*.yaml` files, filtering by whitelist

### Stack Grouping

Services are organized into logical Docker Compose stacks using the `name:` field:

- **Media Stack** (`${MEDIA_STACK_PROJECT_NAME:-media-stack}`): Core media management services
  - *ARR applications (Radarr, Sonarr, Lidarr, etc.)
  - VPN and networking (Gluetun)
  - Download clients (qBittorrent, SABnzbd)
  - Media servers (Jellyfin, Plex)
  - Dashboards (Homarr, Heimdall, Homepage)
  - Supporting services (Portainer, SWAG, Flaresolverr)

- **Immich Stack** (`${IMMICH_PROJECT_NAME:-immich-stack}`): Photo/video management
  - Immich server, ML, Redis, PostgreSQL

## Configuration System

### Environment Variables

All configuration in [docker-compose.env](docker-compose.env) (gitignored, copy from `.example`):
- **Required placeholders**: `${VAR:?err}` syntax fails immediately if undefined
- **VPN credentials**: `VPN_SERVICE_PROVIDER`, `VPN_USERNAME`, `VPN_PASSWORD`, `WIREGUARD_*` keys
- **Path mappings**: `FOLDER_FOR_MEDIA`, `FOLDER_FOR_DATA` (must exist before docker compose up)
- **Port definitions**: `WEBUI_PORT_*` variables reference service WebUI ports

### Service Whitelist

[services.whitelist](services.whitelist) controls bulk operations:
- One service name per line (matches `docker-compose-{name}.yaml` filename)
- Comments with `#`, empty lines ignored
- Delete file or use `--all` flag to manage all services

## Development Workflows

### Adding New Services

1. Create `compose/docker-compose-{service}.yaml` following existing patterns
2. **Choose appropriate stack**:
   - Use `name: ${MEDIA_STACK_PROJECT_NAME:-media-stack}` for media-related services
   - Use `name: ${IMMICH_PROJECT_NAME:-immich-stack}` for Immich ecosystem services  
   - Create new stack variables for unrelated service groups (e.g., `${MONITORING_STACK_NAME:-monitoring}`)
3. For VPN-routed services:
   - Use `network_mode: "container:gluetun"`
   - Add port mappings to `docker-compose-gluetun.yaml` ports section
   - Define `WEBUI_PORT_{SERVICE}` in `docker-compose.env.example`
4. For standalone services:
   - Use `networks: [mediastack]` or dedicated network
   - Define ports in service's own compose file
5. Add service to [services.whitelist](services.whitelist) for default management

### Hardware Acceleration

For Immich ML, use the `extends:` pattern with [hwaccel.ml.yml](compose/hwaccel.ml.yml):
```yaml
extends:
  file: hwaccel.ml.yml
  service: cuda  # or openvino, rocm, armnn
```
Set `runtime: nvidia` and env vars (`NVIDIA_VISIBLE_DEVICES`, `NVIDIA_DRIVER_CAPABILITIES`) directly in the service definition.

### Essential Commands

```bash
# Setup (run once)
./mediastack.sh setup     # Creates FOLDER_FOR_DATA subdirectories

# Daily operations  
./mediastack.sh start     # Gluetun-first startup with VPN wait
./mediastack.sh status    # HTTP health checks on WEBUI_PORT_* endpoints
./mediastack.sh logs <service>

# Development
./mediastack.sh restart <service>  # Single service
./mediastack.sh start --all        # Ignore whitelist
```

**Health checks**: The `status` command performs HTTP requests to `localhost:${WEBUI_PORT_*}` and validates responses (200/302/401/403 = healthy, 5xx/000 = unhealthy).

## Code Conventions

### Shell Scripts (shellcheck-compliant)

- Use `#!/bin/bash` shebang
- Quote all variables: `"$var"` not `$var`
- Error handling: Check command success, provide colored output
- Absolute paths: Scripts use `SCRIPT_DIR` resolution for workspace-relative paths
- Color constants: `RED`, `GREEN`, `YELLOW`, `BLUE`, `NC` from [scripts/mediastack.sh](scripts/mediastack.sh#L38-L42)

### Docker Compose Files

- **Standardized headers**: 11-line comment block with service name, function, documentation links
- **Name field**: Use `${MEDIA_STACK_PROJECT_NAME:-media-stack}` or `${IMMICH_PROJECT_NAME:-immich-stack}` for project grouping
- **Required env vars**: Use `:?err` suffix for mandatory variables
- **Volume patterns**: `${FOLDER_FOR_DATA}/service:/config` and `${FOLDER_FOR_MEDIA}:/data`
- **Theme Park**: *ARR services use `DOCKER_MODS` for UI theming via `TP_THEME` env var

## Project Structure

```
compose/                      # Individual service compose files
scripts/                      # Bash management utilities
  mediastack.sh              # Main orchestration script (770 lines)
  setup-directories.sh       # First-time directory scaffolding
data/                        # Service persistent volumes (gitignored)
docker-compose.env           # Environment config (gitignored)
services.whitelist           # Service enable/disable list
```

## Common Pitfalls

1. **VPN service ports**: Never add `ports:` to services using `network_mode: "container:gluetun"` - define them in Gluetun's compose file
2. **Startup order**: Always start Gluetun first for VPN-dependent services or use `./mediastack.sh start` which handles this
3. **Missing directories**: Run `./mediastack.sh setup` before first `docker compose up` to create `FOLDER_FOR_DATA` structure
4. **Environment validation**: Use `:?err` suffix on all critical env vars to fail fast on missing config
5. **Whitelist confusion**: If bulk commands skip services, check [services.whitelist](services.whitelist) or use `--all` flag

## External Documentation

- Original MediaStack guide: https://MediaStack.Guide
- Gluetun VPN setup: https://github.com/qdm12/gluetun-wiki
- LinuxServer.io images: https://docs.linuxserver.io/
- Immich docs: https://docs.immich.app/
