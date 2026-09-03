#!/usr/bin/env python3
# A proxy in front of the ESP32 power switch, so the dashboard can press it.
#
# The switch (I:\Projects\remote-computer-switch, an ESP32-C3 on the desktop's
# front-panel header) guards every route with a shared token. A button in the
# browser cannot use that token: it would have to be printed into the page,
# where anyone who opens the dashboard could read it - and the token is the
# only thing standing between the LAN and a PC that can be powered off.
#
# So the token stays here, on the Pi, and the browser calls this instead. It
# also solves the second problem: the ESP32 sends no CORS headers, so a
# browser on the dashboard's origin cannot read its replies even when the
# request lands. This does send them.
#
# What that trades: anyone who can reach this port can power the PC without
# the token. That is the same bargain the Backups tile's Run button already
# makes with the backup service, and it is LAN-only - see the note in
# stacks/glance/compose.yaml about not exposing it further.
#
#   GET  /            what the switch reports, plus how it was addressed
#   POST /press       300 ms tap: boots an off PC, asks a running one to stop
#   POST /force-off   6 s hold, hard power off
#
# Standard library only, on the stock python image, like prayer.py.
#
# WHY THIS RUNS ON HOST NETWORKING. The switch is addressed by NAME, so a new
# DHCP lease cannot strand it. Only the Pi itself can resolve that name:
# `pcswitch.local` is mDNS, which Docker's embedded resolver does not do, and
# the router's DNS does not answer for the bare name either (both verified
# from a container on the bridge - neither form resolved). On the host's
# network stack the Pi's own resolver answers, mDNS included.

import json
import os
import socket
import struct
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# By name, deliberately. See the note above about why that needs host
# networking, and the fallback below for when the name briefly does not answer.
DEVICE  = os.environ.get("PCSWITCH_URL", "http://pcswitch.local").rstrip("/")
TOKEN   = os.environ.get("PCSWITCH_TOKEN", "")
PORT    = int(os.environ.get("PCSWITCH_PROXY_PORT", "9102"))
TIMEOUT = float(os.environ.get("PCSWITCH_TIMEOUT", "6"))

# Dry run: answer the buttons, send nothing to the switch.
#
# For testing the dashboard end of this on a PC that is doing something. The
# whole path still runs - the click, the POST, the reply, the message on the
# tile - and only the last hop is skipped, so what it proves is everything
# except the press itself. Reading the state is untouched and stays live.
#
# It is deliberately loud rather than a quiet flag: the status reply carries
# `dry`, and the tile prints TEST MODE beside the buttons, because a switch
# that silently does nothing is worse than no switch at all.
DRY = os.environ.get("PCSWITCH_DRY_RUN", "0").strip().lower() in ("1", "true", "yes", "on")

# The address the name last resolved to, and when. mDNS is a broadcast asked
# and answered live, so a single lost packet - or an access point that drops
# multicast for a moment - can make a name that is perfectly fine look gone.
# Falling back to the address it had a minute ago rides that out; a device
# that has genuinely moved answers on the name again and the fallback is
# replaced. It is only ever a stale cache, never the primary answer.
_last_ip = None
_last_at = 0.0
FALLBACK_MAX_S = float(os.environ.get("PCSWITCH_FALLBACK_MAX_S", "86400"))


def _split(url):
    rest = url.split("://", 1)[1]
    host, _, port = rest.partition(":")
    return host, int(port or 80)


def _skip_name(buf, i):
    """Walk past a DNS name, which may end in a compression pointer."""
    while i < len(buf):
        n = buf[i]
        if n == 0:
            return i + 1
        if n & 0xC0 == 0xC0:            # pointer: two bytes, and it ends here
            return i + 2
        i += 1 + n
    return i


def mdns_resolve(name, timeout=1.5):
    """Ask the LAN for a `.local` name, with no resolver library at all.

    Needed because nothing else in this container can. Alpine's musl libc does
    not do mDNS, and host networking hands over the network stack but not the
    host's nss-mdns module - so `pcswitch.local` is unresolvable here by any
    ordinary call, which is exactly what the first deploy showed.
    """
    q = bytearray(struct.pack("!HHHHHH", 0, 0, 1, 0, 0, 0))
    for label in name.rstrip(".").split("."):
        q += bytes([len(label)]) + label.encode()
    q += b"\x00"
    # QTYPE A, and QCLASS IN with the top bit set: "answer me directly".
    # Without that bit the reply goes to the multicast group on port 5353,
    # which this socket is not listening on.
    q += struct.pack("!HH", 1, 0x8001)

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
        s.settimeout(timeout)
        s.sendto(bytes(q), ("224.0.0.251", 5353))
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                data, _ = s.recvfrom(2048)
            except socket.timeout:
                break
            if len(data) < 12:
                continue
            _, _, qd, an, _, _ = struct.unpack("!HHHHHH", data[:12])
            if an == 0:
                continue
            i = 12
            for _ in range(qd):
                i = _skip_name(data, i) + 4
            for _ in range(an):
                i = _skip_name(data, i)
                if i + 10 > len(data):
                    break
                rtype, _, _, rdlen = struct.unpack("!HHIH", data[i:i + 10])
                i += 10
                if rtype == 1 and rdlen == 4:          # an A record
                    return socket.inet_ntoa(data[i:i + 4])
                i += rdlen
    except OSError:
        pass
    finally:
        s.close()
    return None


def _targets():
    """Where to try, in order: the name, then the address it last had."""
    global _last_ip, _last_at
    host, port = _split(DEVICE)
    out = []

    ip = None
    try:
        # Ordinary DNS first: if the router ever learns the name, or someone
        # adds a hosts entry, that should win over a broadcast question.
        ip = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)[0][4][0]
    except OSError:
        if host.endswith(".local"):
            ip = mdns_resolve(host)

    if ip:
        _last_ip, _last_at = ip, time.time()
        out.append((f"http://{ip}:{port}" if port != 80 else f"http://{ip}", host))
    elif _last_ip and time.time() - _last_at < FALLBACK_MAX_S:
        out.append((f"http://{_last_ip}:{port}" if port != 80 else f"http://{_last_ip}",
                    f"{_last_ip} (cached)"))
    return out


def call(path, method="GET"):
    """One request to the switch. Returns (http status, body, how it was found)."""
    tried = _targets()
    if not tried:
        host, _ = _split(DEVICE)
        return 504, {"error": f"cannot resolve {host}"}, None

    last = None
    for base, how in tried:
        req = urllib.request.Request(base + path, method=method,
                                     headers={"X-Auth": TOKEN})
        # A POST with no body still needs a length, or the ESP32's web server
        # waits for one that never arrives.
        if method == "POST":
            req.data = b""
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                raw, code = r.read().decode("utf-8", "replace"), r.status
        except urllib.error.HTTPError as e:
            raw, code = e.read().decode("utf-8", "replace"), e.code
        except (urllib.error.URLError, OSError) as e:
            last = getattr(e, "reason", e)
            continue                      # try the cached address
        try:
            return code, json.loads(raw), how
        except ValueError:
            return code, {"raw": raw.strip()}, how

    # Unplugged, or its USB power went away with the PC it is wired to.
    return 504, {"error": f"switch unreachable: {last}"}, None


class Handler(BaseHTTPRequestHandler):
    server_version = "pcswitch-proxy/1"

    def reply(self, code, obj, head=False):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        # The dashboard is served from another origin, so without this the
        # browser makes the request and then refuses to let the page read it.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self):
        self.route(head=False)

    def do_HEAD(self):
        self.route(head=True)

    def route(self, head):
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path in ("/", "/status"):
            if not TOKEN:
                return self.reply(500, {"ok": False, "error": "PCSWITCH_TOKEN is not set"}, head)
            code, body, how = call("/api/status")
            body["ok"] = code == 200
            body["via"] = how or ""
            body["dry"] = DRY
            # 200 either way: the tile reads `ok`, and an error body it can
            # render beats a status code it cannot.
            return self.reply(200, body, head)
        self.reply(404, {"ok": False, "error": "not found"}, head)

    def do_POST(self):
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if not TOKEN:
            return self.reply(500, {"ok": False, "error": "PCSWITCH_TOKEN is not set"})
        if path not in ("/press", "/force-off"):
            return self.reply(404, {"ok": False, "error": "not found"})

        if DRY:
            print(f"[dry] {path} requested - NOT sent to the switch", flush=True)
            return self.reply(200, {"ok": True, "dry": True, "action": path.lstrip("/"),
                                    "message": "test mode: nothing sent to the switch"})

        if path == "/press":
            code, body, how = call("/api/press", "POST")
        else:
            code, body, how = call("/api/force-off", "POST")
        body["ok"] = code == 200
        body["via"] = how or ""
        body["dry"] = False
        # 409 is the switch saying a press is already running, which is a
        # normal answer to a double click rather than a failure.
        if code == 409:
            body["error"] = "already pressing"
        self.reply(200, body)

    # One line per dashboard poll would bury anything worth reading.
    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    print(f"[boot] power switch proxy for {DEVICE} on :{PORT}, token "
          f"{'set' if TOKEN else 'MISSING'}"
          f"{'  *** DRY RUN: presses are NOT sent ***' if DRY else ''}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
