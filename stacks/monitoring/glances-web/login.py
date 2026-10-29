#!/usr/bin/env python3
"""glances-login - a small form-login gate for Caddy's forward_auth.

Why this exists instead of an off-the-shelf tool: every ready-made login
gate (Tinyauth, Authelia, caddy-security...) scopes its session cookie to a
DOMAIN, because they are built for subdomain single-sign-on. They refuse a
bare hostname outright - Tinyauth will not even start on http://aboriis-pi.
This gate sets a HOST-ONLY cookie (no Domain attribute), so the same instance
works on aboriis-pi, on the raw IP, and on the tailscale name, each with its
own session. That was the requirement, and it is the one thing the big tools
cannot do.

Standard library only. No pip, no build step, nothing to go stale.

Routes (all reached through Caddy, on the same host as the protected app):
  GET  /auth     forward_auth check. 200 + Remote-User when the cookie is
                 valid, else 401 + X-Login-Redirect (Caddy turns that into a
                 302 to the login page, carrying the original URL as ?next=).
  GET  /login    the form.        POST /login    check credentials, set cookie.
  GET  /logout   clear the cookie.               GET /healthz   liveness.

Credentials live in DATA/users as   username:scrypt$<salt>$<hash>
Make a line with:   python3 login.py hash          (password on stdin)
The signing secret is created on first start in DATA/secret and reused.
"""
import base64
import hashlib
import hmac
import html
import os
import secrets
import sys
import time
import urllib.parse
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA = os.environ.get("LOGIN_DATA", "/data")
USERS_FILE = os.path.join(DATA, "users")
SECRET_FILE = os.path.join(DATA, "secret")
COOKIE = os.environ.get("LOGIN_COOKIE", "glances_session")
TTL = int(os.environ.get("LOGIN_TTL_SECONDS", str(7 * 24 * 3600)))
PORT = int(os.environ.get("LOGIN_PORT", "8000"))
TITLE = os.environ.get("LOGIN_TITLE", "Glances")
FAIL_DELAY = 1.0  # seconds; blunt but effective against online guessing
SCRYPT = dict(n=2 ** 14, r=8, p=1, dklen=32)


def b64(raw):
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def unb64(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def load_secret():
    try:
        with open(SECRET_FILE, "rb") as fh:
            raw = fh.read().strip()
        if len(raw) >= 32:
            return raw
    except FileNotFoundError:
        pass
    raw = secrets.token_bytes(32)
    os.makedirs(DATA, exist_ok=True)
    with open(SECRET_FILE, "wb") as fh:
        fh.write(raw)
    os.chmod(SECRET_FILE, 0o600)
    return raw


def hash_password(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, **SCRYPT)
    return "scrypt$" + b64(salt) + "$" + b64(digest)


def load_users():
    users = {}
    try:
        with open(USERS_FILE) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                name, _, stored = line.partition(":")
                users[name.strip()] = stored.strip()
    except FileNotFoundError:
        pass
    return users


def verify(username, password):
    stored = load_users().get(username)
    if not stored:
        hash_password(password)  # spend the same time for unknown users
        return False
    try:
        algo, salt, digest = stored.split("$")
        if algo != "scrypt":
            return False
        calc = hashlib.scrypt(password.encode(), salt=unb64(salt), **SCRYPT)
        return hmac.compare_digest(calc, unb64(digest))
    except Exception:
        return False


SECRET = b""


def make_token(username):
    payload = (username + "|" + str(int(time.time()) + TTL)).encode()
    sig = hmac.new(SECRET, payload, hashlib.sha256).digest()
    return b64(payload) + "." + b64(sig)


def check_token(token):
    try:
        p, s = token.split(".")
        payload, sig = unb64(p), unb64(s)
        good = hmac.new(SECRET, payload, hashlib.sha256).digest()
        if not hmac.compare_digest(good, sig):
            return None
        username, _, exp = payload.decode().partition("|")
        if int(exp) < time.time():
            return None
        return username
    except Exception:
        return None


def safe_next(value):
    # only ever redirect to a path on this same host
    if not value or not value.startswith("/") or value.startswith("//"):
        return "/"
    return value


# LAYOUT IS LOAD-BEARING - do not "tidy" it. This template is the qBittorrent login page
# skeleton on purpose. Proton Pass (Firefox) would NOT show its autofill icon on the
# earlier, cleaner version. A bisect against the qBittorrent page (which it autofills)
# pinned the cause: the <h1>/<p> text sat INSIDE the <form>. Put any text block back
# inside the form and autofill silently stops. CSS, the action attribute, the port
# and the button label were each tested and are NOT factors. The ?plain=1 and
# ?action=1 query switches on GET /login exist only to re-run that bisect.
PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="color-scheme" content="light dark">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>__TITLE__ - sign in</title>
__STYLE__
</head>
<body>
<div id="main">
<h1>__TITLE__</h1>
<p>Sign in to continue</p>
__ERROR__
<form id="loginform" method="post"__ACTION__>
<div class="row">
<label for="username">Username</label><br>
<input type="text" class="login-input" id="username" name="username" autocomplete="username" autocapitalize="none" autofocus required>
</div>
<div class="row">
<label for="password">Password</label><br>
<input type="password" class="login-input" id="password" name="password" autocomplete="current-password" required>
</div>
<div class="row">
<input type="submit" id="loginButton" value="Login">
</div>
</form>
</div>
</body>
</html>
"""


STYLE_FULL = """<style>
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1216;
      font:15px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e6e8eb}
 #main{width:min(92vw,340px);background:#181c22;border:1px solid #262c35;border-radius:12px;
      padding:28px 26px 22px;box-shadow:0 10px 40px rgba(0,0,0,.45)}
 h1{margin:0 0 4px;font-size:20px} p{margin:0 0 18px;color:#9aa3ad;font-size:13px}
 label{display:inline-block;font-size:12px;color:#9aa3ad;margin:0 0 5px} .row{margin-top:12px}
 input{width:100%;box-sizing:border-box;padding:10px 11px;border-radius:8px;border:1px solid #303845;
       background:#0f1216;color:#e6e8eb;font-size:15px} input:focus{outline:2px solid #3b82f6;border-color:#3b82f6}
 input[type=submit]{margin-top:6px;width:100%;padding:11px;border:0;border-radius:8px;background:#3b82f6;color:#fff;
        font-size:15px;font-weight:600;cursor:pointer} input[type=submit]:hover{background:#2f6fd6}
 .err{background:#3a1d1d;border:1px solid #7a2e2e;color:#ffb4b4;border-radius:8px;padding:9px 11px;font-size:13px;margin-top:8px}
</style>"""
STYLE_NOGRID = """<style>
 body{margin:0;padding:12vh 0;background:#0f1216;
      font:15px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e6e8eb}
 #main{width:min(92vw,340px);margin:0 auto;background:#181c22;border:1px solid #262c35;border-radius:12px;
      padding:28px 26px 22px;box-shadow:0 10px 40px rgba(0,0,0,.45)}
 h1{margin:0 0 4px;font-size:20px} p{margin:0 0 18px;color:#9aa3ad;font-size:13px}
 label{display:inline-block;font-size:12px;color:#9aa3ad;margin:0 0 5px} .row{margin-top:12px}
 input{width:100%;box-sizing:border-box;padding:10px 11px;border-radius:8px;border:1px solid #303845;
       background:#0f1216;color:#e6e8eb;font-size:15px} input:focus{outline:2px solid #3b82f6;border-color:#3b82f6}
 input[type=submit]{margin-top:6px;width:100%;padding:11px;border:0;border-radius:8px;background:#3b82f6;color:#fff;
        font-size:15px;font-weight:600;cursor:pointer} input[type=submit]:hover{background:#2f6fd6}
 .err{background:#3a1d1d;border:1px solid #7a2e2e;color:#ffb4b4;border-radius:8px;padding:9px 11px;font-size:13px;margin-top:8px}
</style>"""

def render(next_path, error="", plain=False, action=False):
    err = '<div class="err">' + html.escape(error) + "</div>" if error else ""
    style = "" if plain else STYLE_NOGRID
    act = (" action=" + chr(34) + "/login?next=" + urllib.parse.quote(next_path, safe="") + chr(34)) if action else ""
    return (PAGE.replace("__STYLE__", style).replace("__ACTION__", act).replace("__TITLE__", html.escape(TITLE))
                .replace("__ERROR__", err)).encode()


class Handler(BaseHTTPRequestHandler):
    server_version = "glances-login"
    sys_version = ""

    def log_message(self, fmt, *args):
        sys.stdout.write(time.strftime("%Y-%m-%d %H:%M:%S ") + (fmt % args) + os.linesep)
        sys.stdout.flush()

    # ---- helpers -----------------------------------------------------
    def cookie_user(self):
        jar = cookies.SimpleCookie(self.headers.get("Cookie", ""))
        morsel = jar.get(COOKIE)
        return check_token(morsel.value) if morsel else None

    def send(self, code, body=b"", ctype="text/plain; charset=utf-8", extra=()):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in extra:
            self.send_header(k, v)
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def set_cookie(self, value, max_age):
        # NO Domain attribute on purpose: host-only cookie (see module doc).
        # NO Secure attribute: the LAN path is plain http by the owner's choice.
        return ("Set-Cookie", COOKIE + "=" + value + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + str(max_age))

    def path_and_query(self):
        parsed = urllib.parse.urlsplit(self.path)
        return parsed.path, urllib.parse.parse_qs(parsed.query)

    # ---- routes ------------------------------------------------------
    def do_GET(self):
        path, query = self.path_and_query()
        if path == "/healthz":
            return self.send(200, b"ok")
        if path == "/auth":
            user = self.cookie_user()
            if user:
                return self.send(200, b"ok", extra=[("Remote-User", user)])
            original = safe_next(self.headers.get("X-Forwarded-Uri", "/"))
            loc = "/login?next=" + urllib.parse.quote(original, safe="")
            return self.send(401, b"unauthorized", extra=[("X-Login-Redirect", loc)])
        if path == "/login":
            nxt = safe_next(query.get("next", ["/"])[0])
            if self.cookie_user():
                return self.send(302, extra=[("Location", nxt)])
            return self.send(200, render(nxt, "", plain="plain" in query, action="action" in query), "text/html; charset=utf-8")
        if path == "/logout":
            return self.send(302, extra=[("Location", "/login"), self.set_cookie("", 0)])
        self.send(404, b"not found")

    def do_POST(self):
        path, query = self.path_and_query()
        if path != "/login":
            return self.send(404, b"not found")
        length = int(self.headers.get("Content-Length", "0") or 0)
        form = urllib.parse.parse_qs(self.rfile.read(min(length, 65536)).decode(errors="replace"))
        username = form.get("username", [""])[0].strip()
        password = form.get("password", [""])[0]
        nxt = safe_next(query.get("next", form.get("next", ["/"]))[0])
        if verify(username, password):
            self.log_message("login ok user=%s from=%s", username, self.client_address[0])
            return self.send(302, extra=[("Location", nxt), self.set_cookie(make_token(username), TTL)])
        time.sleep(FAIL_DELAY)
        self.log_message("login FAILED user=%s from=%s", username, self.client_address[0])
        return self.send(200, render(nxt, "Wrong username or password."), "text/html; charset=utf-8")

    do_HEAD = do_GET


def main():
    global SECRET
    cmd = sys.argv[1] if len(sys.argv) > 1 else "serve"
    if cmd == "hash":
        pw = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.readline().rstrip(os.linesep)
        print(hash_password(pw))
        return
    SECRET = load_secret()
    print("glances-login listening on :" + str(PORT) + " users=" + str(len(load_users())), flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
