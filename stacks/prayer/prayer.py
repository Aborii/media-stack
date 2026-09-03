#!/usr/bin/env python3
# Prayer times for Dubai, fetched from IACAD and cached a year ahead.
#
# A port of the fetching-and-caching half of the ESP32 prayer clock
# (esp32-st7789-display, src/prayer.cpp) to a container on the Pi, so the
# Homepage dashboard can carry a prayer-times tile without a second device
# doing the same work. Only the IACAD source is ported: it is the official
# Dubai timetable and the one the panel actually runs on. The firmware's other
# two sources - Aladhan and an on-device calculation - exist for travelling,
# which a NAS does not do.
#
# What is kept from the firmware, deliberately:
#
#   A month per request.   IACAD hands over a whole month, so the network is
#                          touched about once every four weeks rather than once
#                          a day, and today's times survive any outage between.
#
#   A rolling window.      A year FORWARD of today, rounded out to whole
#                          months, plus a few days behind. Months that fall off
#                          the back are deleted; months missing from the front
#                          are fetched one at a time, on a timer, so the window
#                          fills itself without ever blocking anything.
#
#   Nothing half-written.  A month is parsed into scratch first and only merged
#                          once at least 28 of its days are complete, so a
#                          short or garbled reply can never replace a good
#                          month with a broken one.
#
#   Stale beats blank.     If today cannot be fetched, the last day that could
#                          be stays on the tile, marked stale, and it retries.
#
#   The official Hijri date rides along in the same rows. It is settled by
#   observation, so it is the one thing no calculation can reproduce.
#
# Standard library only, so it runs from the stock python:3.12-alpine image
# with this file bind-mounted - no image to build, nothing to go stale.
#
#   GET /api/status     everything the tile needs, in one reply
#   GET /api/coverage   the window, month by month
#   GET /health         200 while the process is serving
#   GET /               same as /api/status

import datetime as dt
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------------------
# Configuration, all from the environment
# ---------------------------------------------------------------------------

def env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default

# City 1 is Dubai City. IACAD is a Dubai government body and these four are
# genuinely all it publishes; ids beyond 4 return an error.
IACAD_CITIES = {1: "Dubai City", 2: "Rural areas of Dubai", 3: "Hatta", 4: "Sharjah City"}
CITY = env_int("PRAYER_CITY", 1)
if CITY not in IACAD_CITIES:
    sys.exit(f"PRAYER_CITY must be one of {sorted(IACAD_CITIES)}, not {CITY}")

# Hours east of UTC. The UAE is UTC+4 all year with no daylight saving, so a
# fixed offset is exact - and it does not depend on the container having a
# zoneinfo database, which the alpine image does not ship.
UTC_OFFSET = float(os.environ.get("PRAYER_UTC_OFFSET", "4"))
TZ = dt.timezone(dt.timedelta(hours=UTC_OFFSET))

DATA_DIR = os.environ.get("PRAYER_DATA", "/data")
PORT     = env_int("PRAYER_PORT", 8000)

# A year forward of today, and a week behind it.
WINDOW_MONTHS = env_int("PRAYER_WINDOW_MONTHS", 12)
KEEP_DAYS     = env_int("PRAYER_KEEP_DAYS", 7)

# How the window fills itself in: the gap after fetching one month, how long to
# wait after a month the API does not have yet, how long to idle once the
# window is full, and how long to wait before asking for today again after a
# failure. The firmware's numbers, unchanged.
WINDOW_STEP_S  = env_int("PRAYER_STEP_SECONDS", 20)
WINDOW_RETRY_S = env_int("PRAYER_RETRY_SECONDS", 10 * 60)
WINDOW_IDLE_S  = env_int("PRAYER_IDLE_SECONDS", 60 * 60)
TODAY_RETRY_S  = env_int("PRAYER_TODAY_RETRY_SECONDS", 60)

# 12-hour times with AM/PM, or 24-hour.
CLOCK_12H = env_int("PRAYER_CLOCK_12H", 1) != 0

# How long a prayer reads as "now" once its time arrives, before the tile
# moves on to counting down the next one.
ALERT_SECONDS = env_int("PRAYER_ALERT_SECONDS", 60)

# "minutes:colour" pairs. The tightest one already crossed sets `phase` in the
# status reply, which is what the panel colours its countdown with.
def parse_warnings(spec):
    out = []
    for item in spec.split(","):
        item = item.strip()
        if not item:
            continue
        minutes, _, colour = item.partition(":")
        try:
            out.append((int(minutes), colour.strip() or "yellow"))
        except ValueError:
            pass
    return out

WARNINGS = parse_warnings(os.environ.get("PRAYER_WARNINGS", "30:yellow,15:red"))

IACAD_URL = ("https://api-crm.iacad.gov.ae/api//prayertime/getprayerfromlink"
             "?month={month}&year={year}&cityid={city}")
HTTP_TIMEOUT_S = 20

# The six, in the order they happen. Sunrise is not a prayer, but it is the
# end of Fajr's window and so a deadline like the rest.
NAMES  = ["Fajr", "Sunrise", "Dhuhr", "Asr", "Maghrib", "Isha"]
ARABIC = ["الفجر", "الشروق", "الظهر", "العصر", "المغرب", "العشاء"]
FIELDS = ["fajr", "sunrise", "dhuhr", "asr", "maghrib", "isha"]
T_FAJR = 0

HIJRI_MONTHS = ["Muharram", "Safar", "Rabi al-Awwal", "Rabi al-Thani",
                "Jumada al-Ula", "Jumada al-Akhirah", "Rajab", "Sha'ban",
                "Ramadan", "Shawwal", "Dhu al-Qi'dah", "Dhu al-Hijjah"]

STARTED = time.monotonic()


def log(tag, msg):
    print(f"[{tag}] {msg}", flush=True)


def local_now():
    return dt.datetime.now(TZ)


# ---------------------------------------------------------------------------
# Months as a single number, so window arithmetic needs no calendar rules
# ---------------------------------------------------------------------------

def month_index(year, month):
    return year * 12 + (month - 1)


def index_year(mi):
    return mi // 12


def index_month(mi):
    return mi % 12 + 1


def window_bounds(today):
    """The window in month indices, inclusive at both ends.

    The back edge sits KEEP_DAYS behind today so a few days of history survive
    a month boundary: on the 3rd with a week kept, that is still last month.
    """
    back = today - dt.timedelta(days=KEEP_DAYS)
    first = month_index(back.year, back.month)
    last = month_index(today.year, today.month) + WINDOW_MONTHS
    return first, last


# ---------------------------------------------------------------------------
# The store: one JSON file per calendar year, named for the city it came from
# ---------------------------------------------------------------------------
# Named for the city so switching Dubai to Sharjah can never read back a file
# full of the other one's minutes. Days are keyed "MM-DD", so a day that was
# never fetched is simply absent and leap years need no arithmetic.
#
# A day is {"t": [six minutes past midnight], "h": [hijri year, month, day]}.

FILE_RE = re.compile(r"^t(\d{4})-i(\d+)\.json$")


class Store:
    def __init__(self, root, city):
        self.root = root
        self.city = city
        self.years = {}          # year -> {"MM-DD": day}
        os.makedirs(root, exist_ok=True)

    def path(self, year):
        return os.path.join(self.root, f"t{year:04d}-i{self.city}.json")

    def load_year(self, year):
        if year in self.years:
            return True
        path = self.path(year)
        if not os.path.exists(path):
            return False
        try:
            with open(path, encoding="utf-8") as f:
                doc = json.load(f)
            if doc.get("year") != year or doc.get("city") != self.city:
                raise ValueError("header does not match the file name")
            days = doc["days"]
            for key, day in days.items():
                if len(day["t"]) != 6 or len(day["h"]) != 3:
                    raise ValueError(f"day {key} is malformed")
        except (OSError, ValueError, KeyError, TypeError) as e:
            # The firmware removes a file of the wrong size for the same
            # reason: a store that cannot be read is worse than an empty one,
            # because it blocks the refetch that would fix it.
            log("cal", f"{path} unreadable ({e}), removed")
            try:
                os.remove(path)
            except OSError:
                pass
            return False
        self.years[year] = days
        log("cal", f"loaded {os.path.basename(path)}, {len(days)} days")
        return len(days) > 0

    def save_year(self, year):
        days = self.years.get(year)
        if days is None:
            return
        path = self.path(year)
        # Written beside the file and renamed over it, so a power cut mid-write
        # leaves the old file intact rather than a truncated one.
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"year": year, "city": self.city, "days": days}, f,
                      ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, path)

    def day(self, year, month, day):
        if not self.load_year(year):
            return None
        return self.years[year].get(f"{month:02d}-{day:02d}")

    def month_days(self, year, month):
        if not self.load_year(year):
            return 0
        prefix = f"{month:02d}-"
        return sum(1 for k in self.years[year] if k.startswith(prefix))

    def month_complete(self, year, month):
        return self.month_days(year, month) >= 28

    def merge_month(self, year, month, days):
        """Merge one month into whatever the year already holds.

        Merged rather than replaced: the window spans two calendar years for
        most of its life, and one month arriving is no reason to forget the
        others.
        """
        self.load_year(year)
        held = self.years.setdefault(year, {})
        for d, entry in days.items():
            held[f"{month:02d}-{d:02d}"] = entry
        self.save_year(year)

    def files(self):
        out = []
        try:
            names = os.listdir(self.root)
        except OSError:
            return out
        for name in names:
            m = FILE_RE.match(name)
            if m and int(m.group(2)) == self.city:
                out.append(int(m.group(1)))
        return out

    def prune(self, first, last):
        """Drop everything the window no longer covers, from RAM and disk.

        A year still partly inside the window keeps its file and loses only
        the months that fell off; a year entirely outside loses the file.
        """
        for year in sorted(set(self.files()) | set(self.years)):
            first_of_year = month_index(year, 1)
            last_of_year = month_index(year, 12)
            if last_of_year < first or first_of_year > last:
                path = self.path(year)
                if os.path.exists(path):
                    os.remove(path)
                    log("cal", f"{os.path.basename(path)} is outside the window, removed")
                self.years.pop(year, None)
                continue
            if not self.load_year(year):
                continue
            days = self.years[year]
            doomed = [k for k in days
                      if not first <= month_index(year, int(k[:2])) <= last]
            if doomed:
                for k in doomed:
                    del days[k]
                self.save_year(year)
                log("cal", f"trimmed {year} to the window, dropped {len(doomed)} days")


# ---------------------------------------------------------------------------
# IACAD
# ---------------------------------------------------------------------------
# The awkward part, handled: every row repeats TODAY'S date in its fajr/asr/...
# fields whatever day the row describes. Only the time is meaningful; the day
# comes from listDateGreg.

iacad_status = "not tried"


def iso_minutes(s):
    """'2026-09-03T04:40:00' -> 280. -1 for anything that does not parse."""
    if not isinstance(s, str) or len(s) < 16 or s[13] != ":":
        return -1
    try:
        h, m = int(s[11:13]), int(s[14:16])
    except ValueError:
        return -1
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return -1
    return h * 60 + m


def parse_month(rows):
    """Rows from the API -> {day: {"t": [...], "h": [...]}} for complete days."""
    days = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        greg = row.get("listDateGreg") or ""
        if len(greg) < 10:
            continue
        try:
            day = int(greg[8:10])
        except ValueError:
            continue
        if not 1 <= day <= 31:
            continue
        t = [iso_minutes(row.get(f)) for f in FIELDS]
        if any(m < 0 for m in t):
            continue
        h = [0, 0, 0]                                  # "1448/2/17"
        parts = str(row.get("hijriDateString") or "").split("/")
        if len(parts) == 3 and all(p.strip().isdigit() for p in parts):
            h = [int(p) for p in parts]
        days[day] = {"t": t, "h": h}
    return days


def fetch_iacad_month(year, month):
    global iacad_status
    url = IACAD_URL.format(month=month, year=year, city=CITY)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "media-stack prayer tile"})
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as r:
            body = r.read()
    except urllib.error.HTTPError as e:
        iacad_status = f"HTTP {e.code}"
        log("iacad", f"{year:04d}-{month:02d}: {iacad_status}")
        return None
    except (urllib.error.URLError, OSError) as e:
        iacad_status = f"unreachable: {getattr(e, 'reason', e)}"
        log("iacad", f"{year:04d}-{month:02d}: {iacad_status}")
        return None

    try:
        rows = json.loads(body)
    except ValueError as e:
        iacad_status = f"bad json: {e}"
        log("iacad", f"{year:04d}-{month:02d}: {iacad_status}")
        return None
    if not isinstance(rows, list):
        iacad_status = "reply was not a list"
        log("iacad", f"{year:04d}-{month:02d}: {iacad_status}")
        return None

    days = parse_month(rows)
    if len(days) < 28:
        first = rows[0].get("listDateGreg") if rows and isinstance(rows[0], dict) else None
        iacad_status = (f"only {len(days)} days; {len(rows)} elements, "
                        f"{len(body)} json bytes, first greg '{first}'")
        log("iacad", f"{year:04d}-{month:02d}: {iacad_status}")
        return None

    iacad_status = f"ok, {len(days)} days"
    return days


# ---------------------------------------------------------------------------
# State shared between the fetching thread and the web server
# ---------------------------------------------------------------------------

LOCK = threading.Lock()
store = Store(DATA_DIR, CITY)

today_date  = None     # the date `today_entry` was fetched for
today_entry = None     # {"t": [...], "h": [...]}
today_retry = 0.0      # monotonic time before which today is not asked for again

fill_month  = ""       # "YYYY-MM" in flight, for the coverage reply
last_first  = None     # window back edge, for pruning on change
next_window = 0.0      # monotonic time of the next window step


def fetch_and_merge(year, month):
    """One month: the network outside the lock, the merge inside it."""
    global fill_month
    with LOCK:
        fill_month = f"{year:04d}-{month:02d}"
    days = fetch_iacad_month(year, month)
    with LOCK:
        fill_month = ""
        if days is None:
            return False
        store.merge_month(year, month, days)
    log("iacad", f"{year:04d}-{month:02d} loaded, {len(days)} days")
    return True


def refresh_today(now):
    """Today's times, from the store; from the network only if the store cannot
    answer. With the window filled this never reaches for the network."""
    global today_date, today_entry, today_retry
    date = now.date()
    with LOCK:
        if today_entry is not None and today_date == date:
            return
        entry = store.day(date.year, date.month, date.day)
    if entry is None:
        if time.monotonic() < today_retry:
            return
        if not fetch_and_merge(date.year, date.month):
            today_retry = time.monotonic() + TODAY_RETRY_S
            return
        with LOCK:
            entry = store.day(date.year, date.month, date.day)
        if entry is None:
            today_retry = time.monotonic() + TODAY_RETRY_S
            return
    with LOCK:
        today_entry, today_date = entry, date
    h = entry["h"]
    times = " ".join(f"{NAMES[i]} {m // 60:02d}:{m % 60:02d}" for i, m in enumerate(entry["t"]))
    log("today", f"{date} = {h[2]}/{h[1]}/{h[0]} H: {times}")


def next_missing_month(first, last):
    """The first month in the window not fully held, oldest first, so the days
    about to be needed arrive before the ones a year out."""
    for mi in range(first, last + 1):
        y, m = index_year(mi), index_month(mi)
        if not store.month_complete(y, m):
            return y, m
    return None


def maintain_window(now):
    """Keeps the window full, a month per call, on a timer.

    One month per call rather than a loop: the firmware did that so the
    display never froze, and here it means a container restart never turns
    into twelve back-to-back requests to a government API.
    """
    global last_first, next_window
    if time.monotonic() < next_window:
        return
    first, last = window_bounds(now.date())

    # The back edge only moves when a month turns over, so pruning on that
    # edge rather than on a timer means it runs about twelve times a year.
    with LOCK:
        if first != last_first:
            last_first = first
            store.prune(first, last)
        missing = next_missing_month(first, last)

    if missing is None:
        next_window = time.monotonic() + WINDOW_IDLE_S
        return
    ok = fetch_and_merge(*missing)
    if not ok:
        log("cal", f"{missing[0]:04d}-{missing[1]:02d} not available yet")
    next_window = time.monotonic() + (WINDOW_STEP_S if ok else WINDOW_RETRY_S)


def fetcher():
    while True:
        try:
            now = local_now()
            refresh_today(now)
            maintain_window(now)
        except Exception as e:          # a bug here must not kill the thread
            log("fetch", f"unexpected: {e!r}")
            time.sleep(WINDOW_RETRY_S)
            continue
        time.sleep(1)


# ---------------------------------------------------------------------------
# Which prayer is next
# ---------------------------------------------------------------------------

def fmt_hm(minutes):
    if minutes is None or minutes < 0:
        return "--:--"
    h, m = divmod(minutes, 60)
    if not CLOCK_12H:
        return f"{h:02d}:{m:02d}"
    return f"{(h + 11) % 12 + 1}:{m:02d} {'PM' if h >= 12 else 'AM'}"


def fmt_countdown(sec):
    """'1h 12m' over an hour, '12m 05s' under it - spelled out so it cannot be
    misread as a clock time sitting next to one."""
    if sec is None or sec < 0:
        return "--"
    h, rest = divmod(sec, 3600)
    m, s = divmod(rest, 60)
    return f"{h}h {m:02d}m" if h else f"{m}m {s:02d}s"


def tomorrow_fajr(now):
    """A lookup, not a fetch - the month is cached. -1 when tomorrow is
    genuinely unknown, and the caller falls back to today's Fajr, which is a
    minute out rather than absurd."""
    t = (now + dt.timedelta(days=1)).date()
    entry = store.day(t.year, t.month, t.day)
    return entry["t"][T_FAJR] if entry else -1


def next_prayer(now, times):
    """(index, seconds until, the minute to show, tomorrow's Fajr or -1).

    After Isha the next one is tomorrow's Fajr, so the count wraps past
    midnight rather than going negative.
    """
    now_sec = now.hour * 3600 + now.minute * 60 + now.second
    for i, m in enumerate(times):
        at = m * 60
        if at > now_sec:
            return i, at - now_sec, m, -1
    fajr = tomorrow_fajr(now)
    if fajr < 0:
        fajr = times[T_FAJR]
    return T_FAJR, (24 * 3600 - now_sec) + fajr * 60, fajr, fajr


def in_alert_window(now, times):
    now_sec = now.hour * 3600 + now.minute * 60 + now.second
    for i, m in enumerate(times):
        at = m * 60
        if at <= now_sec < at + ALERT_SECONDS:
            return i
    return -1


def status():
    now = local_now()
    with LOCK:
        entry, fetched_for = today_entry, today_date
        first, last = window_bounds(now.date())
        total = last - first + 1
        have = sum(1 for mi in range(first, last + 1)
                   if store.month_complete(index_year(mi), index_month(mi)))
        if entry is None:
            times, hijri = [-1] * 6, [0, 0, 0]
            nxt, until, next_at, fajr_tmrw, alert = -1, -1, -1, -1, -1
        else:
            times, hijri = entry["t"], entry["h"]
            nxt, until, next_at, fajr_tmrw = next_prayer(now, times)
            alert = in_alert_window(now, times)

    have_times = entry is not None
    stale = have_times and fetched_for != now.date()
    alerting = alert >= 0
    shown = alert if alerting else nxt

    # The colour comes from the TIGHTEST warning already crossed, so a list in
    # any order behaves as expected: an hour out is overridden by half an hour.
    phase, tightest = "green", None
    if have_times and not alerting:
        for minutes, colour in WARNINGS:
            at = minutes * 60
            if until <= at and (tightest is None or at < tightest):
                tightest, phase = at, colour

    if not have_times:
        next_name, next_time, next_in = "--", "--", "no times yet"
    elif alerting:
        next_name, next_time, next_in = NAMES[shown], fmt_hm(times[shown]), "now"
    else:
        next_name, next_time, next_in = NAMES[shown], fmt_hm(next_at), fmt_countdown(until)

    listing = []
    for i in range(6):
        # After Isha the Fajr row shows TOMORROW's Fajr - the one still ahead.
        m = fajr_tmrw if (i == T_FAJR and fajr_tmrw >= 0) else times[i]
        listing.append({"name": NAMES[i], "arabic": ARABIC[i], "minutes": m,
                        "time": fmt_hm(m), "next": i == shown and not alerting})

    hijri_date = (f"{hijri[2]} {HIJRI_MONTHS[hijri[1] - 1]} {hijri[0]}"
                  if 1 <= hijri[1] <= 12 and hijri[0] else "--")

    return {
        "clock": True,
        "time": now.strftime("%H:%M:%S"),
        "date": now.strftime("%Y-%m-%d"),
        "wday": (now.weekday() + 1) % 7,           # Sunday = 0, as the firmware
        "hijri": {"d": hijri[2], "m": hijri[1], "y": hijri[0]},
        "hijriDate": hijri_date,
        "haveTimes": have_times,
        "stale": stale,
        "fetchedFor": fetched_for.isoformat() if fetched_for else None,
        "times": times,
        "today": {FIELDS[i]: fmt_hm(times[i]) for i in range(6)},
        "list": listing,
        "next": shown,
        "nextName": next_name,
        "nextArabic": ARABIC[shown] if shown >= 0 else "",
        "nextTime": next_time,
        "nextIn": next_in,
        "nextLabel": f"{next_name} at {next_time}" if have_times else "no times yet",
        "nextAt": times[shown] if alerting else next_at,
        "until": until,
        "alerting": alerting,
        "fajrTomorrow": fajr_tmrw,
        "phase": phase,
        "warned": phase != "green",
        "source": "iacad",
        "city": CITY,
        "cityName": IACAD_CITIES[CITY],
        "clock12": CLOCK_12H,
        "windowHave": have,
        "windowTotal": total,
        "stored": f"{have} of {total} months",
        "iacadStatus": iacad_status,
        "uptime": int(time.monotonic() - STARTED),
    }


def coverage():
    now = local_now()
    with LOCK:
        first, last = window_bounds(now.date())
        months, have, days = [], 0, 0
        for mi in range(first, last + 1):
            y, m = index_year(mi), index_month(mi)
            n = store.month_days(y, m)
            ok = n >= 28
            have += ok
            days += n
            months.append({"y": y, "m": m, "have": ok, "d": n})
        total = last - first + 1
        return {
            "months": months, "have": have, "total": total, "days": days,
            "complete": have == total, "keepDays": KEEP_DAYS,
            "windowMonths": WINDOW_MONTHS, "stepSec": WINDOW_STEP_S,
            "fillMonth": fill_month, "iacadStatus": iacad_status,
            "files": sorted(f"t{y}-i{CITY}.json" for y in store.files()),
        }


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "prayer/1"

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/api/status"):
            self.reply(200, status())
        elif path == "/api/coverage":
            self.reply(200, coverage())
        elif path == "/health":
            with LOCK:
                have = today_entry is not None
            self.reply(200, {"ok": True, "haveTimes": have})
        else:
            self.reply(404, {"ok": False, "error": "not found"})

    def reply(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    # Homepage polls every few seconds; a line per poll would bury the lines
    # that matter. Fetches and failures log themselves above.
    def log_message(self, fmt, *args):
        pass


def main():
    log("boot", f"prayer times for {IACAD_CITIES[CITY]} (city {CITY}), "
                f"UTC{UTC_OFFSET:+g}, window {WINDOW_MONTHS} months + {KEEP_DAYS} days, "
                f"store {DATA_DIR}")
    threading.Thread(target=fetcher, name="fetcher", daemon=True).start()
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    httpd.daemon_threads = True
    log("http", f"listening on :{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
