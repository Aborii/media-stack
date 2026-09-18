#!/usr/bin/env python3
# Restarts the VPN stack, so the dashboard can do it without an SSH session.
#
# The tunnel wedges now and then: gluetun keeps answering its control server
# while the public IP stays blank, or Proton hands out an exit that never
# carries traffic. The fix has always been the same - restart gluetun and the
# four containers that live inside its network namespace - and until now that
# meant finding a terminal. This is that same restart, behind one button.
#
# WHY THE WHOLE STACK AND NOT JUST GLUETUN. qBittorrent, Prowlarr, FlareSolverr
# and the port-sync sidecar all run with network_mode: service:gluetun, so they
# have no network stack of their own. When gluetun goes away and comes back
# they keep a namespace whose tun device and routes were rebuilt underneath
# them; qBittorrent in particular stays bound to the old tun0 address and
# announces into nothing. Restarting them after the tunnel is healthy is what
# makes the restart actually take, and the order matters - which is the reason
# this is a script and not a `docker restart` typed into a button.
#
#   GET  /            what each container is doing, plus the running job
#   POST /restart     restart the stack; refuses while one is already running
#
# It talks to the Docker socket directly, because the dashboard's usual way in
# (dockerproxy, in stacks/management) sets POST=0 and refuses every write -
# deliberately, since Dozzle and WUD have no business restarting anything.
# This one does, so it gets the socket and nothing else: the only calls it ever
# makes are inspect and restart, on a fixed list of container names from the
# environment. It cannot create, exec into, or remove anything.
#
# What that trades: anyone who can reach this port can restart the VPN stack
# without a password - the same bargain the Backups tile's Run button and the
# power switch proxy already make. It is LAN-only; do not port-forward it.
#
# Standard library only, on the stock python image, like pcswitch.py.

import json
import os
import socket
import threading
import time
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SOCK = os.environ.get("DOCKER_SOCKET", "/var/run/docker.sock")
PORT = int(os.environ.get("VPNCTL_PORT", "9103"))

# In restart order. gluetun first and alone: everything after it shares its
# network namespace and is only worth restarting once the tunnel is back.
STACK = [c.strip() for c in os.environ.get(
    "VPNCTL_CONTAINERS",
    "gluetun,qbittorrent,qbit-port-sync,prowlarr,flaresolverr",
).split(",") if c.strip()]
LEAD = STACK[0] if STACK else "gluetun"

# How long to wait for gluetun to report healthy before giving up on it and
# restarting the rest anyway. A cold tunnel takes 30-60s here (the healthcheck
# alone has a 45s start period), and a bad server can take a couple of tries,
# so this is deliberately generous.
HEALTH_WAIT_S = float(os.environ.get("VPNCTL_HEALTH_WAIT_S", "240"))

# Dry run: answer the button, restart nothing. Same idea as PCSWITCH_DRY_RUN -
# it exercises the whole path except the last hop, and says so on the tile,
# because a button that silently does nothing is worse than no button.
DRY = os.environ.get("VPNCTL_DRY_RUN", "0").strip().lower() in ("1", "true", "yes", "on")

# The one job at a time, and what it is doing. Read by GET / while it runs, so
# the tile can follow along instead of waiting out a minute of silence.
_lock = threading.Lock()
_job = {"busy": False, "step": "", "message": "", "ok": None,
        "started_at": None, "finished_at": None}


class _UDS(HTTPConnection):
    """An HTTP connection over a unix socket - what the Docker API speaks."""

    def __init__(self, path, timeout):
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(self._path)
        self.sock = s


def docker(method, path, timeout=90):
    """One Docker API call. Returns (status, parsed body or raw text)."""
    c = _UDS(SOCK, timeout)
    try:
        c.request(method, path, headers={"Host": "localhost"})
        r = c.getresponse()
        raw = r.read().decode("utf-8", "replace")
        code = r.status
    finally:
        c.close()
    try:
        return code, json.loads(raw)
    except ValueError:
        return code, raw.strip()


def state_of(name):
    """What one container is doing, in the shape the tile renders."""
    code, body = docker("GET", f"/containers/{name}/json", timeout=10)
    if code != 200 or not isinstance(body, dict):
        return {"name": name, "state": "missing", "health": ""}
    st = body.get("State", {}) or {}
    return {
        "name": name,
        "state": st.get("Status", "unknown"),
        "health": (st.get("Health") or {}).get("Status", ""),
    }


def states():
    return [state_of(n) for n in STACK]


def wait_healthy(name, deadline):
    """Block until the container reports healthy, or the deadline passes.

    A container with no healthcheck never reports anything, so `running` is
    accepted as the answer for those - only gluetun is ever waited on here,
    and it does have one.
    """
    while time.time() < deadline:
        s = state_of(name)
        if s["health"] == "healthy":
            return True
        if s["state"] == "running" and not s["health"]:
            return True
        if s["state"] in ("exited", "dead", "missing"):
            return False
        time.sleep(3)
    return False


def set_step(step, message):
    _job["step"] = step
    _job["message"] = message
    print(f"[job] {step}: {message}", flush=True)


def run_restart():
    """The job itself: gluetun, wait for the tunnel, then its passengers."""
    try:
        set_step("gluetun", f"restarting {LEAD}…")
        code, body = docker("POST", f"/containers/{LEAD}/restart?t=30")
        if code not in (204, 304):
            _job["ok"] = False
            set_step("failed", f"{LEAD} would not restart: {body}")
            return

        set_step("tunnel", "waiting for the tunnel…")
        healthy = wait_healthy(LEAD, time.time() + HEALTH_WAIT_S)
        if not healthy:
            # Not a failure to stop on: the passengers still need restarting,
            # and gluetun may well come healthy a minute later on its own.
            set_step("tunnel", "tunnel is not healthy yet - restarting the rest anyway")

        failed = []
        for name in STACK[1:]:
            set_step("passengers", f"restarting {name}…")
            code, body = docker("POST", f"/containers/{name}/restart?t=10")
            if code not in (204, 304):
                # A container that is not there at all is not an error worth
                # shouting about - the list is a default, not a guarantee.
                if code == 404:
                    continue
                failed.append(name)

        if failed:
            _job["ok"] = False
            set_step("failed", "could not restart " + ", ".join(failed))
        elif healthy:
            _job["ok"] = True
            set_step("done", "stack restarted, tunnel healthy")
        else:
            _job["ok"] = True
            set_step("done", "stack restarted, tunnel still coming up")
    except Exception as e:                      # noqa: BLE001 - never die silently
        _job["ok"] = False
        set_step("failed", f"{type(e).__name__}: {e}")
    finally:
        _job["finished_at"] = time.time()
        _job["busy"] = False


class Handler(BaseHTTPRequestHandler):
    server_version = "vpnctl/1"

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
            cs = states()
            return self.reply(200, {
                "ok": all(c["state"] == "running" for c in cs),
                "dry": DRY,
                "containers": cs,
                "busy": _job["busy"],
                "step": _job["step"],
                "message": _job["message"],
                "last_ok": _job["ok"],
                "started_at": _job["started_at"],
                "finished_at": _job["finished_at"],
            }, head)
        self.reply(404, {"ok": False, "error": "not found"}, head)

    def do_POST(self):
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path != "/restart":
            return self.reply(404, {"ok": False, "error": "not found"})

        if DRY:
            print("[dry] restart requested - nothing was restarted", flush=True)
            return self.reply(200, {"ok": True, "dry": True, "busy": False,
                                    "message": "test mode: nothing was restarted"})

        with _lock:
            if _job["busy"]:
                # A second click while the first is still working. Not an
                # error - the tile just keeps following the job it started.
                return self.reply(200, {"ok": True, "busy": True,
                                        "message": "already restarting"})
            _job.update(busy=True, ok=None, step="starting",
                        message="restarting the VPN stack…",
                        started_at=time.time(), finished_at=None)

        threading.Thread(target=run_restart, daemon=True).start()
        return self.reply(200, {"ok": True, "busy": True, "dry": False,
                                "message": "restarting the VPN stack…"})

    # One line per dashboard poll would bury the job messages.
    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    print(f"[boot] vpn restart control on :{PORT}, stack {', '.join(STACK)}"
          f"{'  *** DRY RUN: nothing is restarted ***' if DRY else ''}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
