# Homepage config

Sanitised copies of the dashboard config. The live files are in
`/srv/storage/appdata/homepage/` and are **not** in this repo, because
`services.yaml` carries API keys.

To use these, copy them across and fill in the placeholders:

| Placeholder | Where to get it |
|---|---|
| Sonarr / Radarr / Prowlarr key | `config.xml` in each service's appdata |
| Bazarr key | `config/config.yaml` in its appdata |
| Jellyfin key | Dashboard → API Keys |
| Immich key | Account Settings → API Keys |
| qBittorrent password | the WebUI password |

Homepage reloads config on change, so no restart is needed.

## The one thing that is easy to get wrong

Prowlarr and qBittorrent are reached at **`gluetun:9696`** and
**`gluetun:8200`**, not at their own container names. They share gluetun's
network namespace, so they have no hostname on the bridge. Using
`prowlarr:9696` looks correct and silently fails.
