#!/usr/bin/env python3
"""Attach every monitor to the published status page.

uptime-kuma-api 1.2.1 targets Uptime Kuma v1 and breaks against v2.5.3 three
times, all patched below rather than downgrading to the stale v1 line:
  1. get_status_page reads r2["incident"], which v2 omits when there is none
  2. save_status_page forwards every field to a builder predating v2, so new
     fields like autoRefreshInterval raise TypeError
  3. the builder omits v2-only config keys entirely, and the server rejects
     an undefined analyticsType with "Invalid analytics type"
"""
import sys, requests
from uptime_kuma_api import UptimeKumaApi
from uptime_kuma_api.api import parse_incident_style, int_to_bool

ALLOWED = {
    "slug", "id", "title", "description", "theme", "published", "showTags",
    "domainNameList", "googleAnalyticsId", "customCSS", "footerText",
    "showPoweredBy", "showCertificateExpiry", "icon", "publicGroupList",
}
# Config keys v2 knows about that the v1 builder never emits. Carried across
# from the live page so saving does not silently blank them.
V2_KEYS = ("analyticsType", "analyticsId", "analyticsScriptUrl",
           "autoRefreshInterval", "showOnlyLastHeartbeat", "rssTitle")


def _live_config(self, slug):
    return requests.get(f"{self.url}/api/status-page/{slug}",
                        timeout=self.timeout).json().get("config", {})


def get_status_page(self, slug):
    r1 = self._call("getStatusPage", slug)
    r2 = requests.get(f"{self.url}/api/status-page/{slug}", timeout=self.timeout).json()
    config = r1["config"]
    config.update(r2.get("config", {}))
    data = {
        **config,
        "incident": r2.get("incident"),
        "publicGroupList": r2.get("publicGroupList", []),
        "maintenanceList": r2.get("maintenanceList", []),
    }
    if data["incident"]:
        parse_incident_style(data["incident"])
    for i in data["publicGroupList"]:
        for j in i.get("monitorList", []):
            int_to_bool(j, ["sendUrl"])
    return data


def save_status_page(self, slug, **kwargs):
    page = self.get_status_page(slug)
    page.pop("incident", None)
    page.pop("maintenanceList", None)
    page.update(kwargs)
    filtered = {k: v for k, v in page.items() if k in ALLOWED}
    filtered["slug"] = slug

    data = list(self._build_status_page_data(**filtered))
    live = _live_config(self, slug)
    for k in V2_KEYS:
        data[1][k] = page.get(k, live.get(k))
    return self._call("saveStatusPage", tuple(data))


UptimeKumaApi.get_status_page = get_status_page
UptimeKumaApi.save_status_page = save_status_page

api = UptimeKumaApi("http://127.0.0.1:3001", wait_events=0.5)
api.login(sys.argv[1], sys.argv[2])
try:
    mons = sorted(api.get_monitors(), key=lambda m: m["name"].lower())
    print("  attaching %d monitors" % len(mons))
    api.save_status_page("home-services", publicGroupList=[{
        "name": "Media Stack",
        "weight": 1,
        "monitorList": [{"id": m["id"]} for m in mons],
    }])
    page = api.get_status_page("home-services")
    listed = [m.get("name", m.get("id")) for g in page["publicGroupList"]
              for m in g.get("monitorList", [])]
    print("  status page lists %d monitors:" % len(listed))
    print("   ", ", ".join(str(x) for x in listed))
finally:
    api.disconnect()
