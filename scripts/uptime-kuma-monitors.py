#!/usr/bin/env python3
"""Create the media-stack monitors in Uptime Kuma and put them on the status page.

Every URL was verified with curl FROM INSIDE the uptime-kuma container before
being added, so none of them 404. Container names are used rather than
aboriis-pi because Uptime Kuma sits on the same bridge - checking via the host
would bounce off the firewall and test the wrong path.
"""
import sys, time
from uptime_kuma_api import UptimeKumaApi, MonitorType

# uptime-kuma-api 1.2.1 targets Uptime Kuma v1. v2.5.3 added monitor.conditions
# as NOT NULL, which the library never sends, so every insert fails with a
# SQLITE_CONSTRAINT error. Supply the field it does not know about.
_orig = UptimeKumaApi._build_monitor_data
def _patched(self, **kwargs):
    d = _orig(self, **kwargs)
    d.setdefault("conditions", [])
    return d
UptimeKumaApi._build_monitor_data = _patched

OK2XX = ["200-299"]
# Ranges must be individual buckets - "200-399" is rejected as one value.
OK3XX = ["200-299", "300-399"]   # services that redirect to a login page
OK4XX = ["200-299", "300-399", "400-499"]   # Bazarr API needs a key

HTTP = [
    ("Jellyfin",       "http://jellyfin:8096/health",               OK2XX),
    ("Immich",         "http://immich_server:2283/api/server/ping", OK2XX),
    ("Sonarr",         "http://sonarr:8989/ping",                   OK2XX),
    ("Radarr",         "http://radarr:7878/ping",                   OK2XX),
    ("Prowlarr",       "http://gluetun:9696/ping",                  OK2XX),
    ("Kavita",         "http://kavita:5000/api/health",             OK2XX),
    ("Portainer",      "http://portainer:9000/api/system/status",   OK2XX),
    ("Tdarr",          "http://tdarr:8265/",                        OK2XX),
    ("Dozzle",         "http://dozzle:8080/healthcheck",            OK2XX),
    ("qBittorrent",    "http://gluetun:8200/",                      OK2XX),
    ("Scrutiny",       "http://scrutiny:8080/",                     OK3XX),
    ("Bazarr",         "http://bazarr:6767/",                       OK4XX),
]
# Homepage rejects unknown Host headers with 400, so an HTTP check would report
# it permanently down. A TCP check on the port is the honest signal.
PORT = [("Homepage", "homepage", 3000)]

api = UptimeKumaApi("http://127.0.0.1:3001", wait_events=0.5)
api.login(sys.argv[1], sys.argv[2])
try:
    existing = {m["name"]: m["id"] for m in api.get_monitors()}

    # Remove the throwaway monitor left by the compatibility test.
    if "ZZ-test" in existing:
        api.delete_monitor(existing.pop("ZZ-test"))
        print("  removed ZZ-test")

    ids = []
    for name, url, codes in HTTP:
        if name in existing:
            print("  skip   %s (exists)" % name); ids.append(existing[name]); continue
        r = api.add_monitor(type=MonitorType.HTTP, name=name, url=url,
                            interval=60, retryInterval=60, maxretries=2,
                            accepted_statuscodes=codes)
        ids.append(r["monitorID"]); time.sleep(0.3)
        print("  added  %-16s %s" % (name, url))

    for name, host, port in PORT:
        if name in existing:
            print("  skip   %s (exists)" % name); ids.append(existing[name]); continue
        r = api.add_monitor(type=MonitorType.PORT, name=name, hostname=host,
                            port=port, interval=60, retryInterval=60, maxretries=2)
        ids.append(r["monitorID"]); time.sleep(0.3)
        print("  added  %-16s tcp %s:%d" % (name, host, port))

    print("")
    print("  %d monitors" % len(ids))

    page = api.get_status_page("home-services")
    api.save_status_page(
        slug="home-services",
        title=page.get("title") or "Home Services",
        description=page.get("description"),
        theme=page.get("theme") or "auto",
        published=True,
        showTags=page.get("showTags", False),
        domainNameList=page.get("domainNameList", []),
        customCSS=page.get("customCSS", ""),
        footerText=page.get("footerText"),
        showPoweredBy=page.get("showPoweredBy", True),
        icon=page.get("icon", "/icon.svg"),
        publicGroupList=[{
            "name": "Media Stack",
            "weight": 1,
            "monitorList": [{"id": i} for i in ids],
        }],
    )
    print("  status page home-services updated")
finally:
    api.disconnect()
