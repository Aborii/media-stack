#!/usr/bin/env python3
"""Backup state as JSON for Homepage, plus a small page with a Run button.

WHY THIS SITS ON THE PI

Pointing Homepage straight at the receiver on the PC breaks the moment the PC
sleeps, which is most of the time - the tile would read as an error when the
backups are perfectly healthy and simply waiting. So the Pi answers instead. It
knows everything about the queue, and asks the PC only for what it cannot know
(how many archives are kept there, and how far a transfer has actually got). An
unreachable PC becomes a FIELD, not a failure.

TWO DIFFERENT "LAST"S

These are not the same event and conflating them is confusing:

  last_backup - when backup.sh built the archive (the nightly 03:30 run)
  last_sent   - when an archive most recently reached the PC

An archive can be hours old and only just delivered, which is exactly what
happened on 28 August. The dashboard shows both.

Routes:  GET /  JSON for the widget    GET /ui  page with the button
         POST /run  start a backup now
"""
import json
import os
import subprocess
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OFFSITE = os.environ.get("OFFSITE", "/srv/storage/backups/offsite")
KEY_FILE = os.environ.get("BACKUP_KEY_FILE", "/srv/storage/appdata/backup-receiver.key")
RECEIVER = os.environ.get("RECEIVER_URL", "http://100.72.210.100:8899/status")
CACHE = os.environ.get("STATUS_CACHE", "/srv/storage/appdata/backup-status-cache.json")
PORT = int(os.environ.get("STATUS_PORT", "9101"))
BACKUP_UNIT = "media-stack-backup.service"
FLUSH_UNIT = "media-stack-offsite-flush.service"
# Creating this file is how an unprivileged service asks for a backup. A
# systemd .path unit watches it and does the privileged part; nothing here
# escalates. It lives under appdata because that is the one directory this
# service is allowed to write (see ReadWritePaths in the unit).
TRIGGER = os.environ.get("BACKUP_TRIGGER", "/srv/storage/appdata/backup-trigger")

TIMEOUT = 2          # the PC either answers at once or is asleep
COOLDOWN = 300       # seconds between manual triggers

_last_trigger = 0.0


def unit_running(unit):
    """True while a unit is executing.

    A Type=oneshot unit reports "activating" for the WHOLE of its run and only
    passes through "active" on its way out. Testing for "active" alone reports
    "not running" during the entire backup - precisely when you want to see it.
    """
    try:
        out = subprocess.run(["systemctl", "is-active", unit],
                             capture_output=True, text=True, timeout=3)
        return out.stdout.strip() in ("active", "activating")
    except Exception:
        return False


def queue_state():
    """Counts and the newest archive, read from the staging directory.

    The queue IS the directory - an archive with no .sent beside it has not been
    accepted - so there is no separate state to drift out of sync with reality.
    """
    pending = sent = bad = 0
    newest_at = newest_name = None
    try:
        for f in sorted(os.listdir(OFFSITE)):
            if not (f.startswith("media-stack-") and f.endswith(".tar.gz")):
                continue
            full = os.path.join(OFFSITE, f)
            if os.path.exists(full + ".sent"):
                sent += 1
            elif os.path.exists(full + ".bad"):
                bad += 1
            else:
                pending += 1
            mt = os.path.getmtime(full)
            if newest_at is None or mt > newest_at:
                newest_at, newest_name = mt, f
    except OSError:
        pass
    return pending, sent, bad, newest_at, newest_name


def receiver_state():
    """Ask the PC. Returns (data, online). Never raises - offline is normal."""
    try:
        key = open(KEY_FILE).read().strip()
        req = urllib.request.Request(RECEIVER, headers={"X-Backup-Key": key})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            data = json.loads(r.read().decode())
        try:
            with open(CACHE, "w") as fh:
                json.dump({"at": time.time(), "data": data}, fh)
        except OSError:
            pass
        return data, True
    except Exception:
        try:
            with open(CACHE) as fh:
                return json.load(fh).get("data", {}), False
        except Exception:
            return {}, False


def build():
    pending, sent, bad, newest_at, newest_name = queue_state()
    rx, online = receiver_state()
    uploading = bool(rx.get("uploading")) and online
    flushing = unit_running(FLUSH_UNIT)
    backing_up = unit_running(BACKUP_UNIT)

    # Order matters. Local facts are checked before anything that needs the PC
    # to answer: a transfer can be healthy while the receiver is unreachable,
    # and saying "PC off" mid-upload is worse than saying nothing.
    if backing_up:
        state = "backing up"
    elif bad:
        state = f"{bad} refused"
    elif uploading:
        state = f"sending {rx.get('uploadPercent', 0)}%"
    elif flushing:
        state = "sending"
    elif pending and not online:
        state = f"{pending} waiting - PC off"
    elif pending:
        state = f"{pending} pending"
    else:
        state = "up to date"

    return {
        "state": state,
        # When the archive was BUILT - not when it was delivered.
        "last_backup": (time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(newest_at))
                        if newest_at else None),
        "last_backup_name": newest_name,
        # When something most recently ARRIVED on the PC. Often much later.
        "last_sent": rx.get("newestAt"),
        "queue_pending": pending,
        "queue_sent": sent,
        "queue_bad": bad,
        "backing_up": backing_up,
        "flush_running": flushing,
        "pc_online": online,
        "pc_archives": rx.get("archives", 0),
        "pc_bytes": rx.get("bytes", 0),
        "pc_newest": rx.get("newest"),
        "uploading": uploading,
        "upload_name": rx.get("uploadName") if uploading else None,
        "upload_percent": rx.get("uploadPercent", 0) if uploading else 0,
        "upload_received": rx.get("uploadReceived", 0) if uploading else 0,
        "upload_total": rx.get("uploadTotal", 0) if uploading else 0,
    }


def trigger():
    """Start a backup now. Returns (http code, message).

    Guarded rather than open: a backup is heavy on the same USB disk everything
    else reads from, so a page someone leaves open and clicks twice should not
    be able to queue two of them.
    """
    global _last_trigger
    if unit_running(BACKUP_UNIT):
        return 409, "a backup is already running"
    left = int(COOLDOWN - (time.time() - _last_trigger))
    if left > 0:
        return 429, f"just ran - try again in {left}s"
    # Ask by creating a file, do not escalate. A systemd .path unit running as
    # root notices it and starts the backup, so this service - which listens on
    # the LAN with no auth - never gains the ability to run anything itself.
    # This is also why NoNewPrivileges can stay on: sudo would have been
    # blocked by it anyway, and rightly so.
    try:
        with open(TRIGGER, "w") as fh:
            fh.write(str(int(time.time())))
    except OSError as e:
        return 500, f"could not request a backup: {e}"
    _last_trigger = time.time()

    # Confirm systemd actually picked it up rather than reporting optimistically.
    for _ in range(20):
        time.sleep(0.25)
        if unit_running(BACKUP_UNIT) or not os.path.exists(TRIGGER):
            return 200, "backup started"
    return 202, "requested - systemd has not picked it up yet"


PAGE = """<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Backups</title>
<style>
:root{color-scheme:light dark}
body{font:15px/1.55 ui-sans-serif,system-ui,sans-serif;margin:0;padding:2rem 1.25rem;
     display:flex;justify-content:center}
.card{width:100%;max-width:30rem}
h1{font-size:1.25rem;margin:0 0 1.25rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.4rem 1rem;margin:0 0 1.5rem}
dt{opacity:.65;font-size:.85rem}
dd{margin:0;font-variant-numeric:tabular-nums}
button{font:inherit;padding:.6rem 1.1rem;border-radius:4px;cursor:pointer;
       border:1px solid currentColor;background:transparent}
button[disabled]{opacity:.5;cursor:not-allowed}
#msg{margin-top:.9rem;font-size:.9rem;min-height:1.3em}
</style>
<div class=card>
<h1>Backups</h1>
<dl id=fields></dl>
<button id=run>Run backup now</button>
<div id=msg></div>
</div>
<script>
const F=[["state","State"],["last_backup","Archive built"],["last_sent","Last delivered"],
         ["queue_pending","Pending"],["pc_archives","On the PC"],["pc_online","PC reachable"]];
async function load(){
  const d=await (await fetch('/')).json();
  document.getElementById('fields').innerHTML=F.map(([k,l])=>
    `<dt>${l}</dt><dd>${d[k]===null||d[k]===undefined?'-':d[k]}</dd>`).join('');
  document.getElementById('run').disabled=d.backing_up;
}
document.getElementById('run').onclick=async()=>{
  const b=document.getElementById('run'),m=document.getElementById('msg');
  b.disabled=true; m.textContent='starting...';
  const r=await fetch('/run',{method:'POST'});
  m.textContent=await r.text();
  setTimeout(load,1500);
};
load(); setInterval(load,5000);
</script>
"""


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype):
        raw = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        # The Glance dashboard carries the same Run button as /ui, but on
        # another origin, so the browser will only hand it this reply with
        # this header. Wide open on purpose: there is nothing to protect in a
        # status line, and the POST itself needs no permission - a browser
        # sends a plain cross-origin POST whether asked or not.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path = self.path.rstrip("/") or "/"
        if path in ("/", "/status"):
            return self._send(200, json.dumps(build()), "application/json")
        if path == "/ui":
            return self._send(200, PAGE, "text/html; charset=utf-8")
        self._send(404, "no\n", "text/plain")

    def do_POST(self):
        if self.path.rstrip("/") != "/run":
            return self._send(404, "no\n", "text/plain")
        code, msg = trigger()
        self._send(code, msg + "\n", "text/plain")

    # The default handler logs every request, which in a systemd unit means the
    # journal fills with one line per dashboard refresh, forever.
    def log_message(self, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
