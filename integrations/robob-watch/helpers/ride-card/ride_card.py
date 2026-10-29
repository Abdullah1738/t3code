#!/usr/bin/python3
"""ride-card: one live card per Uber trip, shared with the rider and the booker.

    ride-card refresh --trip UUID            read `uber rides status` (exact UUID) and rebuild the card
    ride-card send --trip UUID --session S   share the card once per recipient (idempotent, frozen payload)
         [--chat SLUG]... [--dry-run]     S = the CURRENT session id of the chat you are in
    ride-card meta --trip UUID --rider WHO [--rider-name NAME] [--booker WHO] [--booker-name NAME]
         [--recipient SLUG]...   WHO = abdullah (owner chat), moni, or another bridge chat slug
    ride-card show --trip UUID               card data + share journal (no side effects)
    ride-card sample --out DIR               render every state for a sample trip (tests, contact sheet)

Card folder (public, sanitized only): ~/.local/share/imessage-apps/ride-<uuid>/
  data.json, index.html, preview.png. The page re-reads data.json every 20s.
Private (never served): ~/.local/state/ride-card/<uuid>.json (share journal) and <uuid>.meta.json
  (rider, booker, extra recipients by bridge chat slug, display names).
Recipients: abdullah + moni + rider + booker + extras, deduped. Abdullah (owner chat) gets the tailnet
URL; everyone else gets the public share URL (group chats always get it as a link: the bridge has no
app cards in groups). The caller's chat comes from the bridge's own route for --session, never from a
flag. From the owner session every recipient is reachable (--to SLUG), and --chat SLUG sends only to
those chats and adds them to the ride. From any other chat only that chat itself, which is always
allowed. Session ids rotate, so never store one in a watcher: wakes land in the owner thread, which
sends with its current session and --chat SLUG.

The ride-share-updates watcher rebuilds the card every 30s; it never sends.
Nothing here infers arrival from an ETA or completion from a missing trip. Arrived needs Uber's
ArrivingAtPickup status and the car within AT_PICKUP_M of the pickup pin.

Env overrides: RIDE_CARD_ROOT, RIDE_CARD_JOURNAL, RIDE_SHARE_HINTS, RIDE_CARD_BRIDGE (bridge CLI
command, space separated), RIDE_CARD_BRIDGE_STATE (bridge state dir, read only), RIDE_CARD_PREVIEW_LIB,
RIDE_CARD_NO_IMAGE=1 (skip Chrome, tests), UBER_BIN.
"""
import argparse, fcntl, hashlib, tempfile, html, json, math, os, re, shlex, shutil, sqlite3, subprocess, sys, time
import unicodedata
from datetime import datetime, timezone, timedelta
from pathlib import Path

HOME = Path.home()
DXB = timezone(timedelta(hours=4))
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
STEPS = ["Booked", "Arriving", "Arrived", "On trip", "Dropped off"]
SEARCHING = {"Searching", "Dispatching", "Matching", "Requesting", "WaitingForDispatch"}
# Uber's names read backwards: WaitingForPickup is the rider waiting while the driver drives over
# (ETA counts down), ArrivingAtPickup starts when the driver is about there. Recorded trips (Oct 2026)
# sat in ArrivingAtPickup at "0 mins" both a few hundred metres out and parked at the pin, so the
# status alone never shows Arrived: it also needs the car within AT_PICKUP_M of the pickup pin.
LIVE = {"Accepted": ("assigned", 0), "WaitingForPickup": ("arriving", 1),
        "ArrivingAtPickup": ("arriving", 1), "OnTrip": ("ontrip", 3)}
AT_PICKUP = {"ArrivingAtPickup"}
AT_PICKUP_M = 100
LEAVE_PICKUP_M = 250
TERMINAL = {"COMPLETED": "done", "CANCELED": "cancelled", "CANCELLED": "cancelled",
            "UNFULFILLED": "failed", "FAILED": "failed"}
STALE_S = 120
NAMES = {"abdullah": "Abdullah", "moni": "Moni"}
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,99}$")
BASE_RECIPIENTS = ("abdullah", "moni")


def root():
    return Path(os.environ.get("RIDE_CARD_ROOT") or HOME / ".local/share/imessage-apps")


def journal_dir():
    return Path(os.environ.get("RIDE_CARD_JOURNAL") or HOME / ".local/state/ride-card")


def hints_dir():
    return Path(os.environ.get("RIDE_SHARE_HINTS") or HOME / ".local/share/rides-notify")


def bridge_cmd():
    v = os.environ.get("RIDE_CARD_BRIDGE")
    if v:
        return shlex.split(v)
    return ["/Users/ardud/.bun/bin/bun", str(HOME / ".local/share/spectrum-bridge/src/cli.ts")]


def bridge_state():
    return Path(os.environ.get("RIDE_CARD_BRIDGE_STATE") or HOME / ".config/spectrum-bridge")


def check_uuid(u):
    u = (u or "").strip().lower()
    if not UUID_RE.match(u):
        raise SystemExit(f"ride-card: not an exact trip UUID: {u!r}")
    return u


def slug(uuid):
    return f"ride-{check_uuid(uuid)}"


def card_dir(uuid):
    return root() / slug(uuid)


def clean(s, n=80):
    if s is None:
        return None
    s = re.sub(r"[\x00-\x1f\x7f]", " ", str(s))
    s = re.sub(r"\s+", " ", s).strip()
    return s[:n] or None


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z")


def atomic_write(path, data, mode="w"):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix="." + path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, mode) as f:
            f.write(data)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        try: os.unlink(tmp)
        except OSError: pass
        raise


class trip_lock:
    """Per-trip exclusive lock (journal dir) shared by the watcher, refresh and send.
    wait=False raises BlockingIOError at once when someone else holds it."""
    def __init__(self, uuid, wait=True):
        self.path = journal_dir() / f".{check_uuid(uuid)}.lock"
        self.wait = wait
    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.f = open(self.path, "a")
        try:
            fcntl.flock(self.f, fcntl.LOCK_EX | (0 if self.wait else fcntl.LOCK_NB))
        except OSError:
            self.f.close()
            raise
        return self
    def __exit__(self, *a):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return default


# ---------- people ----------

def _hint(kind, uuid):
    try:
        v = (hints_dir() / f"{kind}-{uuid}").read_text().strip().lower()
        return "moni" if v.startswith("mon") else "abdullah", True
    except Exception:
        return "abdullah", False


def person(v):
    """Normalise a recipient id: the owner chat is 'abdullah'; others are bridge chat slugs."""
    v = (v or "").strip().lower()
    if v in ("owner", "abdullah", "me"):
        return "abdullah"
    if not SLUG_RE.match(v):
        raise SystemExit(f"ride-card: not a bridge chat slug: {v!r} (list them with `cli.ts chats`)")
    return v


def safe_name(v):
    v = clean(v, 30)
    if not v or not re.match(r"^[^\W\d_][\w .'-]*$", v, re.U) or re.search(r"\d", v):
        return None
    return v


def meta_path(uuid):
    return journal_dir() / f"{check_uuid(uuid)}.meta.json"


def load_meta(uuid):
    return read_json(meta_path(uuid), {}) or {}


def rider_for(uuid):
    m = load_meta(uuid)
    if m.get("rider"):
        return m["rider"], True
    return _hint("rider", uuid)


def booker_for(uuid):
    m = load_meta(uuid)
    return m.get("booker") or _hint("booker", uuid)[0]


def display(who, uuid=None):
    if who in NAMES:
        return NAMES[who]
    names = load_meta(uuid).get("names", {}) if uuid else {}
    return names.get(who)


def recipients_for(uuid):
    m = load_meta(uuid)
    rider, _ = rider_for(uuid)
    out = []
    for r in (*BASE_RECIPIENTS, rider, booker_for(uuid), *(m.get("extras") or [])):
        if r and r not in out:
            out.append(r)
    return out


# ---------- card model (sanitized; this is what goes public) ----------

def blank(uuid, rider, booker):
    return {"trip": uuid, "v": 0, "state": "searching", "step": 0, "terminal": False,
            "rider": rider, "booker": booker, "driver": None, "rating": None, "car": None,
            "plate": None, "pickup": None, "dropoff": None, "pickup_eta": None,
            "arrival_eta": None, "note": None, "checked_at": None, "since": None}


def latlng(loc):
    """(lat, lng) from the CLI's {latitude, longitude} (or {lat, lng}); None when absent or junk."""
    if not isinstance(loc, dict):
        return None
    la, ln = loc.get("latitude", loc.get("lat")), loc.get("longitude", loc.get("lng"))
    try:
        la, ln = float(la), float(ln)
    except (TypeError, ValueError):
        return None
    if not (-90 <= la <= 90 and -180 <= ln <= 180) or (la == 0 and ln == 0):
        return None
    return la, ln


def pickup_distance(trip):
    """Metres from the driver's car to the pickup pin, or None when either point is missing."""
    car = latlng((trip.get("vehicle") or {}).get("location"))
    pin = latlng(next((s.get("location") for s in trip.get("stops") or [] if s.get("type") == "Pickup"), None))
    if not car or not pin:
        return None
    (a, b), (c, d) = map(lambda p: (math.radians(p[0]), math.radians(p[1])), (car, pin))
    h = math.sin((c - a) / 2) ** 2 + math.cos(a) * math.cos(c) * math.sin((d - b) / 2) ** 2
    return round(2 * 6371000 * math.asin(math.sqrt(h)))


def plate_key(plate):
    """Plate identity ignoring case, spaces and punctuation, any script; empty when there's no
    plate. Letters stay in, so plates that differ only in an Arabic letter stay different."""
    raw = unicodedata.normalize("NFKC", str(plate or "")).casefold()
    return "".join(str(unicodedata.decimal(ch)) if ch.isdecimal() else ch for ch in raw if ch.isalnum())


def at_pickup(status, dist, was_arrived):
    """Arrived only on Uber's at-pickup status plus the car at the pin. Once shown it holds through
    GPS jitter until the car is clearly elsewhere or Uber moves on."""
    if status not in AT_PICKUP or dist is None:
        return False
    return dist <= (LEAVE_PICKUP_M if was_arrived else AT_PICKUP_M)


def from_live(trip, prev, rider, booker, now):
    """Card for a live `rides status` trip. Driver/car/plate come ONLY from this trip read."""
    uuid = check_uuid(trip.get("uuid"))
    c = dict(prev) if prev and prev.get("trip") == uuid else blank(uuid, rider, booker)
    veh = trip.get("vehicle") or {}
    # The looser hold only applies to the car that arrived; a replacement driver (or a car we
    # can't identify) starts over.
    held = plate_key(c.get("plate"))
    was_arrived = c.get("state") == "arrived" and bool(held) and held == plate_key(clean(veh.get("plate"), 16))
    c.update(rider=rider, booker=booker, terminal=False, note=None, ended_at=None,
             rider_name=display(rider, uuid), booker_name=display(booker, uuid))
    status = trip.get("status") or ""
    drv = trip.get("driver") or {}
    has_driver = bool(drv.get("name")) and status not in SEARCHING
    if status in SEARCHING or not has_driver:
        state, step = ("searching", 0)
    elif at_pickup(status, pickup_distance(trip), was_arrived):
        state, step = ("arrived", 2)
    else:
        state, step = LIVE.get(status, ("assigned", 0))
    old_plate = c.get("plate") or c.get("last_plate")
    c["driver"] = clean((drv.get("name") or "").split(" ")[0], 30) if has_driver else None
    r = drv.get("rating") if has_driver else None
    c["rating"] = f"{float(r):.2f}" if isinstance(r, (int, float)) or (isinstance(r, str) and re.match(r"^\d(\.\d+)?$", r)) else None
    c["car"] = clean(veh.get("description"), 40) if has_driver else None
    c["plate"] = clean(veh.get("plate"), 16) if has_driver else None
    if c["plate"]:
        c["last_plate"] = c["plate"]
    if old_plate and c["plate"] and plate_key(old_plate) != plate_key(c["plate"]):
        c["note"] = "New driver"
        c["driver_changed"] = True
    elif c.get("driver_changed") and c["plate"]:
        c["note"] = "New driver"
    stops = trip.get("stops") or []
    c["pickup"] = clean(next((s.get("title") for s in stops if s.get("type") == "Pickup"), None)) or c.get("pickup")
    c["dropoff"] = clean(next((s.get("title") for s in stops if s.get("type") == "Dropoff"), None)) or c.get("dropoff")
    c["pickup_eta"] = clean(trip.get("pickupEta"), 16) if state in ("assigned", "arriving") else None
    c["arrival_eta"] = clean(trip.get("arrivalEta"), 40) if state == "ontrip" else None
    if c.get("state") != state:
        c["since"] = iso(now)
    c["state"], c["step"] = state, step
    c["checked_at"] = iso(now)
    return c


def to_terminal(prev, status, now, note=None):
    c = dict(prev)
    state = TERMINAL[status]
    c.update(state=state, terminal=True, pickup_eta=None, arrival_eta=None, checked_at=iso(now), since=iso(now),
             ended_at=iso(now))
    c["step"] = 4 if state == "done" else c.get("step", 0)
    c["note"] = note or ("No driver found" if status == "UNFULFILLED" else None)
    return c


def to_unknown(prev, now, final=False):
    c = dict(prev)
    if c.get("state") != "unknown":
        c["since"] = iso(now)
    c.update(state="unknown", pickup_eta=None, arrival_eta=None, checked_at=iso(now), terminal=bool(final),
             ended_at=iso(now) if final else None)
    c["note"] = "Uber never confirmed the end" if final else "Waiting for Uber to confirm"
    return c


def possessive(who, recipient=None, name=None):
    if recipient and who == recipient:
        return "Your"
    name = name or NAMES.get(who)
    return f"{name}'s" if name else "The"


def rider_pos(c, recipient=None):
    return possessive(c["rider"], recipient, c.get("rider_name"))


def clock(isots):
    try:
        return datetime.fromisoformat(isots.replace("Z", "+00:00")).astimezone(DXB).strftime("%H:%M")
    except Exception:
        return None


def texts(c):
    """Big status, sub line and the short og title/description (no times in title/desc)."""
    s = c["state"]
    dest = c.get("dropoff") or "the drop-off"
    kick = ""
    if s == "searching":
        big, sub, word = "Finding a driver", "Uber is matching a car", "Finding a driver"
    elif s in ("assigned", "arriving"):
        eta = c.get("pickup_eta")
        sub, word = "Driver heading to pickup", "Driver on the way"
        if eta and re.match(r"^0\s*min", eta):
            # Uber shows "0 mins" for minutes before the car reaches the pin; it is not arrival
            big, sub = "Nearly there", "Driver is close to pickup"
        else:
            big = eta or "On the way"
            kick = "Driver arrives in" if eta else ""
    elif s == "arrived":
        big, sub, word = "Arrived", "Driver is waiting at pickup", "Driver arrived"
    elif s == "ontrip":
        t = clock(c.get("arrival_eta")) if c.get("arrival_eta") else None
        big = t or "On trip"
        sub = f"Expected at {dest}" if t else f"Heading to {dest}"
        kick = "Arriving at" if t else ""
        word = "On trip"
    elif s == "done":
        big, sub, word = "Dropped off", f"At {dest}", "Dropped off"
    elif s == "cancelled":
        big, sub, word = "Cancelled", c.get("note") or "This ride was cancelled", "Cancelled"
    elif s == "failed":
        big, sub, word = "Ride failed", c.get("note") or "Uber could not complete it", "Ride failed"
    else:
        big, sub, word = "Checking", c.get("note") or "Waiting for Uber to confirm", "Status unconfirmed"
    title = f"{rider_pos(c)} ride · {word}"
    bits = [x for x in (c.get("car"), c.get("plate")) if x] if s in ("assigned", "arriving", "arrived", "ontrip") else []
    bits.append(f"To {dest}")
    return {"big": big, "sub": sub, "word": word, "kick": kick, "og_title": title, "og_desc": " · ".join(bits)}


def signature(c):
    keep = {k: v for k, v in c.items() if k not in ("checked_at", "v")}
    return hashlib.sha256(json.dumps(keep, sort_keys=True).encode()).hexdigest()[:16]


def public(c):
    """Exactly the fields allowed into the public folder."""
    allowed = ("trip", "v", "state", "step", "terminal", "rider", "booker", "driver", "rating", "car",
               "plate", "pickup", "dropoff", "pickup_eta", "arrival_eta", "note", "driver_changed", "checked_at", "since",
               "ended_at")
    out = {k: c.get(k) for k in allowed}
    out["rider"] = c.get("rider_name") or NAMES.get(c.get("rider")) or None
    out["booker"] = c.get("booker_name") or NAMES.get(c.get("booker")) or None
    return out


# ---------- rendering ----------

FONT = '-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Helvetica,sans-serif'

CSS = """
:root{--ground:#f4f4f1;--card:#fff;--ink:#16160f;--soft:#5d5d55;--well:#ecece6;--done:#16160f;--field:#000;--field-ink:#fff;--field-soft:#b8b8b2;
--warn:#8a5a00;color-scheme:light dark;font-family:FONT}
@media (prefers-color-scheme:dark){:root:not(.light){--ground:#0d0d0b;--card:#1a1a17;--ink:#f3f3ee;--soft:#b6b6ac;--well:#35352e;--done:#f3f3ee;
--field:#000;--warn:#e5a93b}}
:root.dark{--ground:#0d0d0b;--card:#1a1a17;--ink:#f3f3ee;--soft:#b6b6ac;--well:#35352e;--done:#f3f3ee;--field:#000;--warn:#e5a93b;color-scheme:dark}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%;touch-action:manipulation}
body{background:var(--ground);color:var(--ink);min-height:100svh;display:flex;justify-content:center;
padding:max(16px,env(safe-area-inset-top)) 16px calc(env(safe-area-inset-bottom) + 72px);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
main{width:100%;max-width:420px;align-self:flex-start;background:var(--card);border-radius:28px;overflow:hidden}
.hero{background:var(--field);color:var(--field-ink);padding:20px 24px 22px}
.who{display:flex;flex-wrap:wrap;justify-content:space-between;column-gap:12px;font-size:17px;font-weight:650;line-height:1.3}
.who span{min-width:0;overflow-wrap:anywhere}
.who span:last-child{font-size:14px;font-weight:500;color:var(--field-soft);text-align:right;margin-left:auto;align-self:center}
.kick{font-size:15px;font-weight:500;color:var(--field-soft);margin-top:18px}
h1{text-wrap:balance;font-size:76px;line-height:1;letter-spacing:-.045em;font-weight:700;margin-top:18px;overflow-wrap:anywhere}
.kick+h1{margin-top:4px}
h1.long{font-size:clamp(36px,10vw,54px);letter-spacing:-.035em;line-height:1.05}
.sub{font-size:18px;font-weight:500;margin-top:8px;line-height:1.3}
.note{display:inline-block;margin-top:12px;font-size:14px;font-weight:650;padding:5px 12px;border-radius:999px;background:var(--field-ink);color:var(--field)}
.stale{margin:16px 24px 0;padding:10px 14px;border-radius:14px;background:var(--well);font-size:14px;line-height:1.35;color:var(--warn);font-weight:600}
.stale[hidden]{display:none}.stale .tag{display:none}
ol.rail{list-style:none;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;column-gap:8px;padding:20px 24px 4px}
ol.rail li{font-size:12px;line-height:1.35;color:var(--soft);font-weight:500;min-width:0}
ol.rail li::before{content:"";display:block;height:6px;border-radius:3px;background:var(--well);margin-bottom:9px}
ol.rail li.on{color:var(--ink)}
ol.rail li.on::before{background:var(--done)}
ol.rail li.now{font-weight:700}
ol.rail.live li.now::before{animation:pulse 1.8s ease-in-out infinite}
@keyframes pulse{50%{opacity:.4}}
.car{margin:20px 24px 0;padding:16px;border-radius:20px;background:var(--well);display:grid;grid-template-columns:auto 1fr;gap:4px 16px;align-items:center}
.plate{grid-row:span 2;font-size:22px;font-weight:760;letter-spacing:.06em;padding:9px 13px;border-radius:10px;background:var(--card);
color:var(--ink);white-space:nowrap}
.model{font-size:17px;font-weight:650;min-width:0;overflow-wrap:anywhere}
.driver{font-size:15px;color:var(--soft);min-width:0}
.route{padding:22px 24px 4px;list-style:none;display:grid;gap:14px}
.route li{display:grid;grid-template-columns:14px 1fr;gap:14px;align-items:start;font-size:16px;line-height:1.35}
.route li::before{content:"";width:10px;height:10px;margin:5px 2px 0;border-radius:50%;background:var(--well);box-sizing:border-box;border:3px solid var(--ink)}
.route li.to::before{border-radius:2px;background:var(--ink)}
.route small{display:block;font-size:14px;color:var(--soft);font-weight:500}
.route span{overflow-wrap:anywhere}
footer{margin:16px 24px 8px;padding:12px 0;font-size:12px;color:var(--soft);display:flex;justify-content:space-between;gap:12px}
@media (max-width:360px){body{padding-left:8px;padding-right:8px}.hero,.route{padding-left:18px;padding-right:18px}.car{margin-left:18px;margin-right:18px}
ol.rail{padding-left:18px;padding-right:18px;gap:4px}ol.rail li{font-size:11px}h1{font-size:64px}footer{margin:16px 18px 8px}.stale{margin:16px 18px 0}}
@media (max-width:430px){ol.rail li{font-size:11px}}
@media (max-width:340px){.car{grid-template-columns:1fr}.plate{grid-row:auto;justify-self:start}}
@media (prefers-reduced-motion:reduce){ol.rail.live li.now::before{animation:none}}
/* Bubble fit: Robob Cards shows this page live in a non-scrolling iMessage bubble (~345x310 CSS px).
   Short viewports get a compact first screen: time, status, bar, car/plate and driver. */
@media (max-height:480px){body{min-height:0;padding:8px 8px 16px}main{border-radius:22px}
.hero{padding:12px 16px 12px}.who{font-size:14px;line-height:1.25}.who span:last-child{font-size:12px}
.kick{font-size:13px;margin-top:8px;line-height:1.25}h1{font-size:44px;margin-top:6px;letter-spacing:-.04em}.kick+h1{margin-top:0}
h1.long{font-size:30px;line-height:1.1;letter-spacing:-.03em}
.sub{font-size:14px;margin-top:4px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.note{margin-top:6px;font-size:12px;padding:3px 9px}
.stale{margin:8px 16px 0;padding:4px 10px;border-radius:10px;font-size:12px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.stale .more{display:none}
ol.rail{padding:10px 16px 0;gap:4px;column-gap:4px}ol.rail li,ol.rail li.now{font-size:0;line-height:0}ol.rail li::before{height:5px;margin:0}
.car{margin:10px 16px 0;padding:10px 12px;border-radius:14px;gap:2px 12px}.plate{font-size:17px;padding:6px 9px;border-radius:8px}
.model{font-size:14px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;overflow-wrap:normal}.driver{font-size:13px;line-height:1.25}
.route{padding:12px 16px 0;gap:8px}.route li{font-size:14px;gap:10px}.route small{font-size:12px}
footer{margin:8px 16px 4px;padding:6px 0;font-size:11px}}
@media (max-height:300px){.hero{padding:10px 14px}.who{font-size:13px}.kick{font-size:12px;margin-top:4px}h1{font-size:38px;margin-top:4px}
h1.long{font-size:26px}.sub{font-size:13px;margin-top:2px}.stale{margin:6px 14px 0}ol.rail{padding:8px 14px 0}
.car{margin:8px 14px 0;padding:8px 10px}.plate{font-size:16px;padding:5px 8px}.route{padding:10px 14px 0}footer{margin:6px 14px 4px}}
@media (max-height:480px) and (max-width:340px){.car{grid-template-columns:auto 1fr}.plate{grid-row:span 2;justify-self:auto}}
/* In the bubble the card runs edge to edge (Messages rounds the corners itself), so every inset is
   the same 16px. Messages draws the app icon over the top-left corner: the first line starts past it.
   The bubble doesn't scroll, so the route is one line per stop (the dots tell them apart), the
   footer goes, names stay on one line (a booker that doesn't fit wraps out of sight), and a New driver tag
   takes the sub line's place (a stale banner takes both and leads with the tag), so pickup and
   drop-off always fit. */
@media (max-height:480px) and (max-width:480px){html,body{background:var(--card)}body{padding:0}
main{max-width:none;border-radius:0}.hero{padding-top:6px}.who{min-height:24px;padding-left:30px;align-items:center}
.route{padding-top:10px;gap:4px}.route li{align-items:center}.route li::before{margin-top:0}.route small{display:none}
.route span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;overflow-wrap:normal}footer{display:none}
.who{flex-wrap:wrap;height:24px;line-height:24px;overflow:hidden;white-space:nowrap}.who span{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.note{margin-top:4px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:top}
.hero:has(.note) .sub,.hero:has(+.stale:not([hidden])) :is(.sub,.note){display:none}.stale .tag{display:inline}.driver{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
@media (max-height:480px) and (max-width:340px){.who span:last-child{display:none}}
""".replace("FONT", FONT)

JS = """
const V=%d,TERM=%s;const $=s=>document.querySelector(s);
const q=new URLSearchParams(location.search).get('theme');if(q==='dark'||q==='light')document.documentElement.classList.add(q);
let at=new Date($('time').getAttribute('datetime'));
const fmt=d=>new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit',timeZone:'Asia/Dubai'}).format(d);
function paint(){const s=Math.max(0,Math.round((Date.now()-at)/1000)),m=Math.round(s/60);
$('time').textContent=fmt(at);$('#ago').textContent=s<60?'just now':m+' min ago';
const st=$('#stale');if(!TERM&&s>%d){st.hidden=false;const nd=$('.hero .note');
st.innerHTML=(nd?'<span class="tag"></span>':'')+'No update for '+m+' min<span class="more">. Details may be out of date.</span>';
if(nd)st.firstChild.textContent=nd.textContent+' · ';}else st.hidden=true;}
async function poll(){try{const r=await fetch('data.json',{cache:'no-store'});if(!r.ok)return;const d=await r.json();
if(d.v!==V){location.reload();return;}if(d.checked_at)at=new Date(d.checked_at);}catch(e){}paint();}
paint();if(!TERM){setInterval(poll,20000);setInterval(paint,15000);}
"""


def page(c, t):
    e = lambda s: html.escape("" if s is None else str(s), quote=True)
    s = c["state"]
    step = c.get("step", 0)
    show_rail = s not in ("cancelled", "failed")
    live = not c.get("terminal") and s != "unknown"
    rail = "".join(
        f'<li class="{"on" if i <= step else ""}{" now" if i == step and s != "done" else ""}">{x}</li>'
        for i, x in enumerate(STEPS)) if show_rail else ""
    car = ""
    if c.get("plate") or c.get("car"):
        drv = " · ".join(x for x in (c.get("driver"), (f"{c['rating']} rating" if c.get("rating") else None)) if x)
        car = (f'<section class="car" aria-label="Car"><div class="plate" translate="no" aria-label="Plate {e(c.get("plate") or "")}">{e(c.get("plate") or "No plate")}</div>'
               f'<div class="model">{e(c.get("car") or "Car")}</div><div class="driver">{e(drv)}</div></section>')
    route = ""
    if c.get("pickup") or c.get("dropoff"):
        route = ('<ol class="route" aria-label="Route">'
                 + (f'<li><span><small>Pickup</small>{e(c.get("pickup"))}</span></li>' if c.get("pickup") else "")
                 + (f'<li class="to"><span><small>Drop-off</small>{e(c.get("dropoff"))}</span></li>' if c.get("dropoff") else "")
                 + "</ol>")
    checked = c.get("checked_at") or iso(time.time())
    local = clock(checked) or ""
    big_cls = ' class="long"' if len(t["big"]) > 7 else ""
    bname = c.get("booker_name") or NAMES.get(c.get("booker"))
    booker = "" if c["booker"] == c["rider"] or not bname else f"Booked by {bname}"
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#f4f4f1" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0d0d0b" media="(prefers-color-scheme: dark)">
<title>{e(t['og_title'])}</title>
<meta property="og:title" content="{e(t['og_title'])}">
<meta property="og:description" content="{e(t['og_desc'])}">
<meta property="og:image" content="preview.png?v={c['v']}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<style>{CSS}</style>
</head><body><main>
<section class="hero" aria-live="polite">
<div class="who"><span><b>{e(rider_pos(c))} Uber</b></span><span>{e(booker)}</span></div>
{f'<p class="kick">{e(t["kick"])}</p>' if t.get("kick") else ''}<h1{big_cls}>{e(t['big'])}</h1>
<p class="sub">{e(t['sub'])}</p>
{f'<span class="note">{e(c["note"])}</span>' if c.get("note") and s not in ("cancelled", "failed", "unknown") else ''}
</section>
<p class="stale" id="stale" role="status" hidden></p>
{f'<ol class="rail{" live" if live else ""}" aria-label="Progress">{rail}</ol>' if rail else ''}
{car}{route}
<footer><span>Updated <time datetime="{e(checked)}">{e(local)}</time></span><span id="ago"></span></footer>
</main>
<script>{JS % (c['v'], 'true' if c.get('terminal') else 'false', STALE_S)}</script>
</body></html>"""


def og_doc(c, t):
    e = lambda s: html.escape("" if s is None else str(s), quote=True)
    step = c.get("step", 0)
    s = c["state"]
    rail = "".join(f'<i class="{"on" if i <= step else ""}"></i>' for i in range(5)) if s not in ("cancelled", "failed") else ""
    n = len(t["big"])
    size = 220 if n <= 6 else 170 if n <= 9 else 128 if n <= 13 else 104
    vehicle = ""
    if c.get("plate") and s in ("assigned", "arriving", "arrived", "ontrip"):
        vehicle = f'<div class="veh"><b>{e(c["plate"])}</b><span>{e(c.get("car") or "")}</span></div>'
    else:
        vehicle = f'<div class="line">{e(t["sub"])}</div>'
    kicker = f"{rider_pos(c)} Uber · To {c.get('dropoff') or 'drop-off'}"
    if t.get("kick"):
        kicker = f"{rider_pos(c)} Uber · {t['kick']}"
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
*{{box-sizing:border-box;margin:0}}
html,body{{width:1200px;height:630px;overflow:hidden}}
body{{background:#000;color:#f5f5f3;font-family:{FONT};padding:56px 72px 56px;display:flex;flex-direction:column;-webkit-font-smoothing:antialiased}}
.k{{font-size:44px;font-weight:600;color:#a9a9a5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
.b{{font-size:{size}px;font-weight:740;letter-spacing:-.045em;line-height:1.05;margin-top:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}}
.line{{font-size:54px;font-weight:560;margin-top:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
.veh{{display:flex;align-items:center;gap:30px;margin-top:26px;min-width:0}}
.veh b{{flex:none;background:#f5f5f3;color:#000;font-size:70px;font-weight:780;letter-spacing:.05em;padding:8px 26px;border-radius:18px}}
.veh span{{font-size:50px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}}
.rail{{margin-top:auto;display:grid;grid-template-columns:repeat(5,1fr);gap:14px}}
.rail i{{height:16px;border-radius:8px;background:#2e2e2e}}
.rail i.on{{background:#f5f5f3}}
</style></head><body>
<div class="k">{e(kicker)}</div><div class="b">{e(t['big'])}</div>{vehicle}
{f'<div class="rail">{rail}</div>' if rail else ''}
</body></html>"""


def _cp():
    sys.path.insert(0, str(Path(os.environ.get("RIDE_CARD_PREVIEW_LIB") or HOME / ".local/libexec/card-preview")))
    import cardpreview
    return cardpreview


def write_card(c, outdir=None, force=False):
    """Write data.json always; index.html + preview.png only when the visible card changed.
    Returns the card with v set. Terminal cards are frozen: later writes are ignored."""
    d = Path(outdir) if outdir else card_dir(c["trip"])
    old = read_json(d / "data.json")
    meta = read_json(d / ".sig.json", {}) or {}
    old_sig = meta.get("sig")
    if old and old.get("terminal") and not force:
        # frozen, but a preview that failed to render is still retried (same version)
        if meta.get("preview") != old_sig or not (d / "preview.png").exists():
            card = _unpublic(old, old["trip"]) if not outdir else dict(old, rider_name=old.get("rider"),
                                                                     booker_name=old.get("booker"))
            if render_preview(card, d):
                atomic_write(d / ".sig.json", json.dumps({"sig": old_sig, "preview": old_sig}))
        return old
    sig = signature(public(c))
    c = dict(c)
    changed = sig != old_sig or not (d / "index.html").exists()
    c["v"] = (old or {}).get("v", 0) + (1 if changed else 0)
    pub = public(c)
    preview_sig = meta.get("preview") if not changed else None
    d.mkdir(parents=True, exist_ok=True)
    if changed or force:
        atomic_write(d / "index.html", page(c, texts(c)))
    if changed or force or preview_sig != sig or not (d / "preview.png").exists():
        preview_sig = sig if render_preview(c, d) else None
    if c.get("last_plate") and not outdir:
        atomic_write(journal_dir() / f".{c['trip']}.card.json", json.dumps({"last_plate": c["last_plate"]}))
    atomic_write(d / "data.json", json.dumps(pub, indent=1))
    atomic_write(d / ".sig.json", json.dumps({"sig": sig, "preview": preview_sig}))
    return c


def preview_pending(uuid):
    """True when the card's preview.png is missing or older than its current state."""
    d = card_dir(uuid)
    if not (d / "data.json").exists():
        return False
    meta = read_json(d / ".sig.json", {}) or {}
    return meta.get("preview") != meta.get("sig") or not (d / "preview.png").exists()


def render_preview(c, d):
    """Render preview.png for the card as it is now. False (and no partial file) on failure."""
    if os.environ.get("RIDE_CARD_NO_IMAGE") == "1":
        return True
    tmp_png = d / f".preview-{os.getpid()}.png"
    try:
        _cp().render_html(og_doc(c, texts(c)), str(tmp_png))
        os.replace(tmp_png, d / "preview.png")
        return True
    except Exception as ex:  # keep the page current even if Chrome hiccups; retried next check
        try: os.unlink(tmp_png)
        except OSError: pass
        print(f"ride-card: preview render failed: {ex}", file=sys.stderr)
        return False


# ---------- live read ----------

def fixed_uber():
    """~/.local/bin/uber: the local-helpers wrapper that pins node, so a short watcher PATH still runs it."""
    p = os.path.expanduser("~/.local/bin/uber")
    return p if os.access(p, os.X_OK) else None


def uber_status(timeout=20):
    uber = os.environ.get("UBER_BIN") or fixed_uber() or shutil.which("uber") or "/Users/ardud/.nvm/versions/node/v26.2.0/bin/uber"
    env = dict(os.environ, PATH="/Users/ardud/.nvm/versions/node/v26.2.0/bin:" + os.environ.get("PATH", ""))
    p = subprocess.run([uber, "rides", "status", "--json"], capture_output=True, text=True, timeout=timeout,
                       env=env, stdin=subprocess.DEVNULL)
    return json.loads((p.stdout.strip().splitlines() or ["{}"])[-1])


def refresh(uuid):
    uuid = check_uuid(uuid)
    d = uber_status()
    if not d.get("ok"):
        raise SystemExit(f"ride-card: uber rides status failed: {json.dumps(d.get('error'))[:200]}")
    trip = (d.get("result") or {}).get("trip")
    if not trip or (trip.get("uuid") or "").lower() != uuid:
        raise SystemExit(f"ride-card: current trip is {trip and trip.get('uuid')}, not {uuid}")
    with trip_lock(uuid):
        prev_raw = load_card(uuid)
        rider, _ = rider_for(uuid)
        return write_card(from_live(trip, prev_raw, rider, booker_for(uuid), time.time()))


def _unpublic(p, uuid):
    """Public card -> working card. Identities come from private metadata, never the public file."""
    c = dict(p)
    c["rider"], _ = rider_for(uuid)
    c["booker"] = booker_for(uuid)
    c["rider_name"], c["booker_name"] = display(c["rider"], uuid), display(c["booker"], uuid)
    return c


def load_card(uuid):
    p = read_json(card_dir(uuid) / "data.json")
    if not p:
        return None
    c = _unpublic(p, uuid)
    priv = read_json(journal_dir() / f".{check_uuid(uuid)}.card.json", {}) or {}
    if priv.get("last_plate"):
        c["last_plate"] = priv["last_plate"]
    return c


# ---------- sharing ----------

def journal_path(uuid):
    return journal_dir() / f"{check_uuid(uuid)}.json"


def load_journal(uuid):
    return read_json(journal_path(uuid), {"trip": uuid, "recipients": {}})


def sent_to(uuid):
    """Recipients whose card the bridge took, minus any the bridge's outbox shows it later dropped."""
    j = read_json(journal_path(uuid), {}) or {}
    return {who for who, r in (j.get("recipients") or {}).items()
            if r.get("status") == "sent" and not dropped(who, r)}


def bridge(*args, timeout=60):
    env = {k: v for k, v in os.environ.items() if k != "BUN_INSPECT"}
    p = subprocess.run([*bridge_cmd(), *args], capture_output=True, text=True, timeout=timeout, env=env,
                       stdin=subprocess.DEVNULL)
    out = p.stdout.strip()
    try:
        data = json.loads(out.splitlines()[-1]) if out else {}
    except Exception:
        data = {"raw": out[:300]}
    if p.returncode != 0:
        raise RuntimeError(f"bridge {args[0]} failed ({p.returncode}): {(p.stderr or out).strip()[:300]}")
    return data


UNSHARE_AFTER_S = 3600  # an ended ride's page stays up this long, then its public link goes


def unshared_path(uuid):
    return journal_dir() / f".{check_uuid(uuid)}.unshared"


def public_link(uuid):
    """True once someone other than the owner got this trip's public share link. The owner's card
    is a tailnet page (publish), not a share, so it never counts against the bridge's share cap."""
    j = read_json(journal_path(uuid), {}) or {}
    return any(who != "abdullah" and (r.get("payload") or {}).get("url")
               for who, r in (j.get("recipients") or {}).items())


UNCONFIRMED_UNSHARE_AFTER_S = 12 * 3600  # frozen as "never confirmed": the trip might come back


def ended_at(card):
    """When a frozen card froze; None while the card is live. Cards frozen before `ended_at` was
    written fall back to checked_at, the frozen write itself. `since` only stands in for an end Uber
    confirmed: on a card frozen as "never confirmed" it is when "Checking" began, hours earlier."""
    if not card or not card.get("terminal"):
        return None
    unknown = card.get("state") == "unknown"
    for field in ("ended_at", "checked_at") if unknown else ("ended_at", "checked_at", "since"):
        try:
            return datetime.fromisoformat(str(card.get(field)).replace("Z", "+00:00")).timestamp()
        except ValueError:
            continue
    return None


def link_done(card, now, grace=UNSHARE_AFTER_S):
    """True when a frozen card's public link can go: `grace` after the end Uber confirmed (the share
    cap passes 0), or UNCONFIRMED_UNSHARE_AFTER_S after a card froze as "never confirmed" either way.
    That ride may still be going (its card reopens if Uber shows it again), and a quick tunnel's
    link can't be given back once it's gone."""
    end = ended_at(card)
    if end is None:
        return False
    return now - end >= (UNCONFIRMED_UNSHARE_AFTER_S if card.get("state") == "unknown" else grace)


def unshare(uuid):
    """Take a trip's public link down. Idempotent: the bridge answers removed:false once it's gone."""
    res = bridge("unshare", "--app", slug(uuid), timeout=10)
    atomic_write(unshared_path(uuid), json.dumps({"at": iso(time.time()), "removed": res.get("removed")}))
    return res


def permanent_apps():
    """Slugs whose public link is a stable-origin link (bridge `shares`, permanent: true). Automatic
    cleanup never retires those: the URL already sent would break, and sharing again mints a new one.
    None when the bridge's list can't be read, so the caller retires nothing."""
    try:
        records = bridge("shares", timeout=10).get("shares")
    except Exception:
        return None
    if not isinstance(records, list):
        return None
    return {r["app"] for r in records
            if isinstance(r, dict) and isinstance(r.get("app"), str) and r.get("permanent") is True}


def free_ended_shares(exclude=None):
    """The bridge's live-share cap is hit: every trip Uber confirmed ended loses its public link now,
    without the hour's grace. The trip Uber shows right now keeps its link whatever its card says,
    and when Uber can't be read nothing goes: a card frozen as "never confirmed" may be that trip.
    A stable-origin link is never retired, and when the bridge's share list can't be read nothing
    goes either. Returns how many the bridge really removed."""
    try:
        d = uber_status()
    except Exception:
        return 0
    if not isinstance(d, dict) or not d.get("ok"):
        return 0
    live = str(((d.get("result") or {}).get("trip") or {}).get("uuid") or "").lower()
    permanent = permanent_apps()
    if permanent is None:
        return 0
    freed, now = 0, time.time()
    for p in sorted(journal_dir().glob("*.json")):
        uuid = p.stem
        if uuid in (exclude, live) or not UUID_RE.match(uuid) or slug(uuid) in permanent:
            continue
        try:
            # Under the trip's own lock, so a send re-sharing it can't race the unshare. A trip
            # someone else holds is skipped, not waited on.
            with trip_lock(uuid, wait=False):
                if (unshared_path(uuid).exists() or not link_done(load_card(uuid), now, grace=0)
                        or not public_link(uuid)):
                    continue
                freed += bool(unshare(uuid).get("removed"))
        except Exception:
            continue
    return freed


def share_card(uuid):
    try:
        pub = bridge("share", "--app", slug(uuid), "--days", "2")
    except RuntimeError as ex:
        # At most 10 live shares: ended rides' links are past use, so they go first, then one retry.
        if "live shares" not in str(ex) or not free_ended_shares(exclude=uuid):
            raise
        pub = bridge("share", "--app", slug(uuid), "--days", "2")
    unshared_path(uuid).unlink(missing_ok=True)  # shared again: the watcher takes it down again later
    return pub


def relink(uuid):
    """A ride whose public link was taken down shows up live again. That link is gone for good (a
    quick tunnel's URL can't be given back), so everyone who got it needs a new one: their records
    move to `retired` and restart on a key family of their own, and the next `send` shares the card
    again and sends the new link. The caller holds trip_lock. Returns who needs it."""
    j = load_journal(uuid)
    recips = j.setdefault("recipients", {})
    n = int(j.get("relinks") or 0) + 1
    moved = []
    for who, r in list(recips.items()):
        if who == "abdullah" or not (r.get("payload") or {}).get("url"):
            continue  # the owner's card is a tailnet page, not a share
        j.setdefault("retired", []).append({**r, "who": who, "retired_at": iso(time.time())})
        recips[who] = {"relink": n, "mode": r["payload"].get("mode")}
        moved.append(who)
    if moved:
        j["relinks"] = n
        _save_journal(uuid, j)
    return moved


def bridge_app_to():
    """True only once `app --to` is deployed AND the bridge server was restarted onto it.
    The CLI alone isn't enough: an old server would ignore `to` and post Moni's card in the
    caller's chat. Whoever restarts com.abdullah.agent-bridges creates the marker file."""
    if os.environ.get("RIDE_CARD_BRIDGE"):
        return True
    marker = journal_dir() / "app-to-live"
    try:
        src = (HOME / ".local/share/spectrum-bridge/src/cli.ts").read_text()
        return marker.exists() and bool(re.search(r'app:\s*\[[^\]]*"to"', src))
    except Exception:
        return False


def moni_has_cards():
    if not bridge_app_to():
        return False
    tool = os.environ.get("RIDE_CARD_ENROLL") or "/Volumes/ExternalSSD/t3code-fork/integrations/robob-cards/bin/robob-cards-enroll"
    try:
        p = subprocess.run([tool, "status", "moni"], capture_output=True, text=True, timeout=20, stdin=subprocess.DEVNULL)
        first = (p.stdout.strip().splitlines() or [""])[0].lower()
        return first.startswith("moni: installed")
    except Exception:
        return False


NO_TIME = re.compile(r"\b(\d{1,2}[:.]\d{2}|\d{1,2}\s?(am|pm)|today|tonight|tomorrow|yesterday|"
                     r"(mon|tues|wednes|thurs|fri|satur|sun)day|morning|evening|afternoon|"
                     r"jan(uary)?|feb(ruary)?|march|april|june|july|august|sept(ember)?|october|november|december)\b", re.I)


def card_words(text):
    return re.sub(r"\s+", " ", NO_TIME.sub("", text or "")).strip(" ·,-") or "Ride"


def payload_for(c, recipient, url, mode):
    caption = f"{rider_pos(c, recipient)} ride"
    place = card_words(c.get("dropoff")) if c.get("dropoff") else None
    sub = f"To {place}" if place and place != "Ride" else None
    p = {"url": url, "mode": mode, "caption": caption, "subcaption": sub, "summary": "Live ride card"}
    if mode == "link":
        p["text"] = f"{caption}, live: {url}"
    return p


def read_route(db):
    """One chat's current bridge route, read only; None when the store is missing or unreadable."""
    try:
        con = sqlite3.connect(f"{db.absolute().as_uri()}?mode=ro", uri=True, timeout=5)
        try:
            row = con.execute("select value from kv where key = 'route'").fetchone()
        finally:
            con.close()
        return json.loads(row[0]) if row and row[0] else None
    except (OSError, ValueError, sqlite3.Error):
        return None


def session_matches(route, session):
    """Same rule as the bridge's sessionMatches: the bare route id or id@generation."""
    if not isinstance(route, dict) or not isinstance(route.get("id"), str):
        return False
    g = route.get("generation")
    if not isinstance(g, int) or isinstance(g, bool) or g < 0:
        return False
    return session in (route["id"], f"{route['id']}@{g}")


def chat_stores():
    base = bridge_state()
    yield "abdullah", base / "state.sqlite"
    for db in sorted((base / "chats").glob("*/state.sqlite")):
        if SLUG_RE.match(db.parent.name):
            yield db.parent.name, db


def chat_for_session(session):
    """The chat whose live route is this session, as the bridge will see it; None when stale."""
    return next((slug for slug, db in chat_stores() if session_matches(read_route(db), session)), None)


def known_chat(slug):
    return slug == "abdullah" or (bridge_state() / "chats" / slug / "state.sqlite").is_file()


def bridge_slug(who):
    return "owner" if who == "abdullah" else who


def op_ids(who, mode, key):
    """The bridge's outbox ids for one key: the chat's own route and the owner's --to route."""
    prefix = "app" if mode == "card" else "send"
    h = lambda s: hashlib.sha256(s.encode()).hexdigest()
    return {"self": f"{prefix}:{h(key)}", "to": f"{prefix}:{h(bridge_slug(who) + ':' + key)}"}


def chat_db(who):
    base = bridge_state()
    return base / "state.sqlite" if who == "abdullah" else base / "chats" / who / "state.sqlite"


# One statement is one read snapshot: the op rows, the route and the fallback marks can't be
# read across a send or a route rotation that happens between two queries. The route comes
# back even when none of the ops exist yet.
OUTBOX_SQL = ("select r.route, o.id, o.state, o.attempts, o.payload, "
              "(select value from kv where key = 'firstAttempt:' || o.id), "
              "(select value from kv where key = 'fallback:' || o.id) "
              "from (select (select value from kv where key = 'route') as route) r "
              "left join outbox o on o.id in ({})")


def op_kind(oid, state, attempts, stale, first=None, fell=None, owner=False):
    """How a bridge outbox op stands. live: out, or still queued and deliverable; maybe: the bridge
    itself can't tell ("uncertain"), the op was cancelled or is about to be after an attempt that
    may have reached the phone, or a failed card the owner chat's Telegram fallback may have sent
    (only the owner chat has one; it takes failed app ops it has tried, and marks them only after
    its own send returns, so only its "skipped" mark proves it never went); dead: never went
    (refused, or cancelled by a route rotation before any attempt)."""
    if state in ("sent", "fallback", "sending") or (state == "pending" and not stale):
        return "live"
    if state == "uncertain" or (state in ("pending", "cancelled") and attempts):
        return "maybe"
    skipped = isinstance(fell, dict) and "skipped" in fell
    if owner and state == "failed" and oid.startswith("app:") and not skipped and isinstance(first, (int, float)):
        return "maybe"
    return "dead"


def _kv(value):
    try:
        return json.loads(value) if value else None
    except ValueError:
        return value


def outbox(who, ids):
    """(route, {id: (kind, state)}) for these ops in the recipient chat's bridge store, read only;
    (None, None) if unreadable."""
    db = chat_db(who)
    if not ids or not db.is_file():
        return None, None
    try:
        con = sqlite3.connect(f"{db.absolute().as_uri()}?mode=ro", uri=True, timeout=5)
        try:
            rows = con.execute(OUTBOX_SQL.format(",".join("?" * len(ids))), list(ids)).fetchall()
        finally:
            con.close()
    except (OSError, ValueError, sqlite3.Error):
        return None, None
    route, out = _kv(rows[0][0]) if rows else None, {}
    if route is not None and not isinstance(route, dict):
        return None, None
    for _, oid, state, attempts, payload, first, fell in rows:
        if oid is None:
            continue
        op = _kv(payload) or {}
        if not isinstance(op, dict):
            return None, None
        # Session-bound ops (a chat's own route) die with their route; --to ops carry no session.
        stale = (op.get("generation") is not None
                 and (op.get("sessionId"), op.get("generation")) != ((route or {}).get("id"), (route or {}).get("generation")))
        out[oid] = (op_kind(oid, state, attempts, stale, _kv(first), _kv(fell), owner=who == "abdullah"), state)
    return route, out


def refused(err):
    """True when the bridge said no, or the CLI never sent the request: nothing was queued."""
    return bool(re.search(r"\(HTTP (4\d\d|503)\)|Invalid command arguments", err or ""))


def no_to(err):
    """An older bridge that doesn't know `--to` for this command (CLI or server refused it)."""
    return bool(re.search(r"Invalid command arguments|\(HTTP 400\)", err or ""))


def _ops(who, r):
    keys = r.get("keys") or ([r["key"]] if r.get("key") else [])
    mode = (r.get("payload") or {}).get("mode")
    if not keys or not mode:
        return keys, {}, None, None
    route, states = outbox(who, {op for k in keys for op in op_ids(who, mode, k).values()})
    return keys, {(k, via): op for k in keys for via, op in op_ids(who, mode, k).items()}, route, states


def open_attempts(r):
    """Bridge calls that got no answer: each may still be queued later, until something proves it can't."""
    if "open" in r:
        return list(r["open"])
    # A journal from before per-attempt records: only its last attempt can still be open.
    keys = r.get("keys") or ([r["key"]] if r.get("key") else [])
    if r.get("attempts") and keys and r.get("status") != "sent" and not r.get("refused"):
        return [{"via": r.get("via"), "key": r.get("key") or keys[-1], "session": None}]
    return []


def waiting(r, ids, route, states):
    """Open attempts that may still land. One that left an op is settled by that op. One on the
    chat's own route is dead once the live route no longer takes its session: the bridge checks the
    route when it queues, and a route never goes back to an older id or generation. Nothing settles
    an unanswered --to request except an op, so only the same op may carry its retry."""
    out = []
    for a in open_attempts(r):
        vias = [a.get("via")] if a.get("via") in ("self", "to") else ["self", "to"]
        if any(ids.get((a.get("key"), v)) in states for v in vias):
            continue
        if vias == ["self"] and a.get("session") and isinstance(route, dict) and not session_matches(route, a["session"]):
            continue
        out.append(a)
    return out


def dropped(who, r):
    """A card the bridge took and later dropped unsent: its last op is dead, nothing else is live,
    and no unanswered attempt may still land."""
    keys, ids, route, states = _ops(who, r)
    if not states:
        return False
    if any(kind != "dead" for kind, _ in states.values()) or waiting(r, ids, route, states):
        return False
    last = [ids.get((r.get("key") or keys[-1], r["via"]))] if r.get("via") else list(ids.values())
    return any(op in states for op in last)


def standing(uuid, who, r, planned):
    """What the bridge outbox says about the earlier attempts for one recipient.

    Returns (outcome, key): outcome ("sent"|"failed", text) when nothing may be sent now, else None
    and the key the send on the planned route ("self"|"to") must use. An earlier attempt that may
    still land can only be retried as the same bridge op (same route and key); once every attempt
    is settled, a dead op lets any route go again on a key it never used."""
    keys, ids, route, states = _ops(who, r)
    sent = r.get("status") == "sent"
    # A relinked recipient's old keys are retired with the dead link: a new key family, so the
    # bridge can't answer "already had it" for the new one.
    base = f"uber:{uuid}:card:{who}" + (f":relink{r['relink']}" if r.get("relink") else "")
    fresh = lambda: (keys[-1] if ids.get((keys[-1], planned)) not in (states or {})
                     else f"{base}:{len(keys) + 1}")
    if not ids:
        if sent:
            return ("sent", "already sent"), None
        return None, (keys[-1] if keys else base)
    if states is None:
        if sent:
            return ("sent", "already sent"), None
        if r.get("attempts"):
            return ("failed", f"failed: can't read the bridge outbox for {who}, and an earlier attempt "
                              "may have gone through; not sending again"), None
        return None, keys[-1]
    seen = {}
    for kind, state in states.values():
        seen.setdefault(kind, set()).add(state)
    if "live" in seen:
        return ("sent", "already sent" if sent
                else f"already queued (bridge: {', '.join(sorted(seen['live']))})"), None
    if "maybe" in seen:
        if sent:
            return ("sent", f"already sent (bridge: {', '.join(sorted(seen['maybe']))})"), None
        return ("failed", f"failed: an earlier attempt may have reached {who} (bridge: "
                          f"{', '.join(sorted(seen['maybe']))}); check the chat before sending again"), None
    held = waiting(r, ids, route, states)
    if held:
        ops = {(a.get("key"), a.get("via")) for a in held}
        if len(ops) == 1 and next(iter(ops))[1] == planned:
            return None, held[0]["key"]
        gone = {"to": "over the owner chat", "self": "from that chat itself"}.get(held[-1].get("via"), "by another route")
        return ("failed", f"failed: an earlier attempt for {who} went {gone}, got no answer and may still land; "
                          "retry the same way, or check the chat first"), None
    last_key, last_via = r.get("key") or keys[-1], r.get("via")
    last = [ids[(last_key, last_via)]] if last_via in ("self", "to") else [ids[(last_key, v)] for v in ("self", "to")]
    if any(op in states for op in last):
        return None, fresh()  # the bridge took the last one and dropped it unsent
    if sent:
        return ("sent", "already sent"), None  # nothing shows it was lost
    return None, fresh()


def deliver(uuid, recipient, p, session, to, key):
    if p["mode"] == "card":
        args = ["app", "--url", p["url"], "--caption", p["caption"], "--summary", p["summary"],
                "--session", session, "--key", key]
        if p.get("subcaption"):
            args += ["--subcaption", p["subcaption"]]
    else:
        args = ["send", "--text", p["text"], "--session", session, "--key", key]
    if to:
        args += ["--to", to]
    return bridge(*args)


def send(uuid, session, from_chat=None, dry_run=False, modes=None, force=False, chats=()):
    """Share the card once per recipient. Frozen payload per trip+recipient; same bridge key on retries."""
    uuid = check_uuid(uuid)
    if not session or not re.match(r"^[A-Za-z0-9:_@.-]{6,200}$", session):
        raise SystemExit("ride-card: --session must be the current iMessage session id")
    caller = chat_for_session(session)
    if not caller:
        raise SystemExit(f"ride-card: {session} is not the live session of any chat (sessions rotate). "
                         "Use the current session id of the chat you are in; from a watcher wake that is "
                         "the owner thread's, with --chat SLUG for another chat.")
    if from_chat and person(from_chat) != caller:
        raise SystemExit(f"ride-card: this session is in chat {caller!r}, not {person(from_chat)!r}")
    targets = []
    for x in map(person, chats or ()):
        if x not in targets:
            targets.append(x)
    for x in targets:
        if caller != "abdullah" and x != caller:
            raise SystemExit(f"ride-card: only the owner's chat can send to other chats; this session is in {caller!r}")
        if not known_chat(x):
            raise SystemExit(f"ride-card: no bridge chat {x!r} (list them with `cli.ts chats` from the owner session)")
    if dry_run:
        # Read only: no Uber refresh, no lock file, no journal.
        return _send_locked(uuid, load_card(uuid), session, caller, True, modes, force, targets)
    c = load_card(uuid)
    if not c:
        c = refresh(uuid)
    with trip_lock(uuid):
        return _send_locked(uuid, c, session, caller, dry_run, modes, force, targets)


def _add_extras(uuid, slugs):
    """Record chats a card went to as ride recipients. The caller already holds trip_lock."""
    m = load_meta(uuid)
    ex = list(m.get("extras") or [])
    new = [s for s in slugs if s not in ex]
    if not new:
        return
    m.update(trip=uuid, extras=ex + new)
    p = meta_path(uuid)
    atomic_write(p, json.dumps(m, indent=1))
    os.chmod(p, 0o600)


def _send_locked(uuid, c, session, caller, dry_run, modes, force, targets=()):
    result, failed = {}, False
    if c is None:
        result["note"] = "no card yet; a real send builds it from `uber rides status` first"
    elif c.get("terminal") and not force:
        if not dry_run:
            raise SystemExit(f"ride-card: trip {uuid} already ended ({c['state']}); not sending a new card")
        result["note"] = f"trip already ended ({c['state']}); a real send would be refused"
    modes = modes or {}
    j = load_journal(uuid)
    recips = j.setdefault("recipients", {})
    everyone = recipients_for(uuid)
    # The owner sends every card over --to (the owner chat's own slug is "owner"): those ops carry no
    # session, so a route rotation never cancels or refuses them. Other chats can only use their own.
    if caller != "abdullah":
        plan = [(caller, None)]  # a non-owner chat can only reach itself, and always can
    else:
        plan = [(r, bridge_slug(r)) for r in (targets or everyone)]
    if not dry_run:
        _add_extras(uuid, [who for who, _ in plan if who != "abdullah" and who not in everyone])
    for who, to in plan:
        r = recips.setdefault(who, {})
        mode = (r.get("payload") or {}).get("mode") or r.get("mode") or modes.get(who) or (
            "card" if who == "abdullah" else "card" if who == "moni" and moni_has_cards() else "link")
        if who == "abdullah" and r.get("via") == "self" and r.get("no_to"):
            to = None  # this bridge refused `--to owner` before: the owner session reaches itself
        via = "to" if to else "self"
        where = f" --to {to}" if to else " to this chat"
        outcome, key = standing(uuid, who, r, via)
        if outcome:
            kind, text = outcome
            result[who] = text
            if kind == "failed":
                failed = True
            elif not dry_run and r.get("status") != "sent":
                r.update(status="sent", sent_at=r.get("sent_at") or iso(time.time()), error=None)
                _save_journal(uuid, j)
            continue
        try:
            if "payload" not in r:
                if dry_run:
                    result[who] = f"would publish+send {mode}{where}"
                    continue
                if mode == "card" and to and who != "abdullah" and not bridge_app_to():
                    # An old server ignores `to` and posts in the caller's chat. For the owner's own
                    # card that is the same chat, so only other recipients need the new server.
                    raise RuntimeError("bridge has no `app --to` yet; use link mode for this recipient")
                if who == "abdullah":
                    pub = bridge("publish", "--app", slug(uuid))
                else:
                    pub = share_card(uuid)
                url = pub.get("publicURL") or pub.get("url")
                warn = pub.get("metadataWarnings") or []
                if warn:
                    raise RuntimeError(f"page metadata warnings: {warn}")
                if not url or not str(url).startswith("https://"):
                    raise RuntimeError(f"no https URL from bridge: {str(pub)[:200]}")
                r["payload"] = payload_for(c, who, url, mode)
                r["created_at"] = iso(time.time())
                _save_journal(uuid, j)
            if dry_run:
                result[who] = f"would send {r['payload']['mode']} {r['payload']['url']}{where}"
                continue
            keys = r.get("keys") or ([r["key"]] if r.get("key") else [])
            r["open"] = open_attempts(r)
            for attempt in (1, 2):
                # On disk before the bridge call, so a cut process is reconciled from the outbox next time.
                if key not in keys:
                    keys.append(key)
                entry = {"via": via, "key": key, "session": session, "at": iso(time.time())}
                r["open"].append(entry)
                r.update(key=key, keys=keys, via=via, status="attempting", attempts=r.get("attempts", 0) + 1,
                         attempted_at=entry["at"])
                _save_journal(uuid, j)
                try:
                    ack = deliver(uuid, who, r["payload"], session, to, key)
                except Exception as ex:
                    if refused(str(ex)):
                        r["open"].remove(entry)  # the bridge said no to this one: it queued nothing
                    if attempt == 1 and who == "abdullah" and to and no_to(str(ex)):
                        # An older bridge. From the owner session the owner's own route reaches the
                        # same chat, but that route may hold an earlier op under this key.
                        to, via, where = None, "self", " to this chat"
                        r["no_to"] = True
                        outcome, key = standing(uuid, who, r, via)
                        if outcome and outcome[0] == "failed":
                            raise RuntimeError(outcome[1].removeprefix("failed: "))
                        if outcome:
                            done = outcome[1]
                            break
                        continue
                    raise
                r["open"] = [a for a in r["open"] if (a.get("key"), a.get("via")) != (key, via)]
                if isinstance(ack, dict) and ack.get("created") is False:
                    # The bridge already had this op; that is only a send if the op is still going.
                    _, ids, _, states = _ops(who, r)
                    had = (states or {}).get(ids.get((key, via)))
                    if not had:
                        raise RuntimeError("the bridge says it already had this card, but its outbox doesn't "
                                           "show it; check the chat first")
                    if had[0] == "dead":
                        raise RuntimeError("the bridge already had this card under that key and dropped it; "
                                           "send again for a fresh key")
                done = "sent"
                break
            r.update(status="sent", sent_at=iso(time.time()), error=None)
            result[who] = done
        except Exception as ex:
            err = str(ex)[:300]
            r.update(status="failed", error=err)
            result[who] = f"failed: {err[:200]}"
            failed = True
        if not dry_run:
            _save_journal(uuid, j)
    return result, failed


def _save_journal(uuid, j):
    p = journal_path(uuid)
    atomic_write(p, json.dumps(j, indent=1))
    os.chmod(p, 0o600)


def set_meta(uuid, rider, booker=None, rider_name=None, booker_name=None, extras=()):
    """Private ride metadata. Adding extras later keeps the earlier ones; names must look like names."""
    uuid = check_uuid(uuid)
    rider = person(rider)
    booker = person(booker) if booker else None
    extras = [person(x) for x in extras]
    with trip_lock(uuid):
        m = load_meta(uuid)
        booker = booker or m.get("booker") or "abdullah"
        names = dict(m.get("names") or {})
        for who, name in ((rider, rider_name), (booker, booker_name)):
            if name is not None:
                n = safe_name(name)
                if not n:
                    raise SystemExit(f"ride-card: unsafe display name {name!r} (plain first name only)")
                if who not in NAMES:
                    names[who] = n
        ex = list(m.get("extras") or [])
        for x in extras:
            if x not in ex:
                ex.append(x)
        m.update(trip=uuid, rider=rider, booker=booker, names=names, extras=ex)
        p = meta_path(uuid)
        atomic_write(p, json.dumps(m, indent=1))
        os.chmod(p, 0o600)
    if rider in NAMES:  # legacy hint for older readers
        hints_dir().mkdir(parents=True, exist_ok=True)
        atomic_write(hints_dir() / f"rider-{uuid}", rider + "\n")
    return m


# ---------- sample (design checks, never touches live dirs unless --out says so) ----------

SAMPLE_UUID = "00000000-0000-4000-8000-000000000001"


SAMPLE_PIN = (25.0702, 55.1405)


def sample_trip(status, plate="K 48213", car="Black Lexus ES", name="Imran Khan", eta="4 mins", north_m=1500):
    """Same shape as `uber rides status --json`: coordinates are {latitude, longitude}."""
    t = {"uuid": SAMPLE_UUID, "status": status, "pickupEta": eta, "arrivalEta": "2026-10-22T10:42:00Z",
         "pin": "4821", "fare": "AED 65.89", "cancelable": True,
         "stops": [{"type": "Pickup", "title": "Banyan Tree Residences • Hillside",
                    "location": {"latitude": SAMPLE_PIN[0], "longitude": SAMPLE_PIN[1]}},
                   {"type": "Dropoff", "title": "ARKHE Club, Silverene Tower",
                    "location": {"latitude": 25.0811, "longitude": 55.1403}}],
         "route": "sample"}
    if status not in SEARCHING:
        t["driver"] = {"name": name, "rating": 4.93, "photo": "https://example.invalid/p.jpg"}
        t["vehicle"] = {"description": car, "plate": plate,
                        "location": {"latitude": SAMPLE_PIN[0] + north_m / 111195, "longitude": SAMPLE_PIN[1]}}
    return t


def sample_states(rider="moni"):
    """The order a real Uber ride goes through, plus the end states."""
    now = time.time()
    seq, c = [], None
    for name, st, eta, north in (("Searching", "Searching", None, 0), ("Accepted", "Accepted", "6 mins", 3000),
                                 ("WaitingForPickup", "WaitingForPickup", "4 mins", 1500),
                                 ("Nearby", "ArrivingAtPickup", "0 mins", 400),
                                 ("AtPickup", "ArrivingAtPickup", "0 mins", 20), ("OnTrip", "OnTrip", None, 0)):
        c = from_live(sample_trip(st, eta=eta, north_m=north), c, rider, "abdullah", now)
        seq.append((name, dict(c)))
    seq.append(("Unknown", to_unknown(c, now)))
    seq.append(("Completed", to_terminal(c, "COMPLETED", now)))
    seq.append(("Cancelled", to_terminal(seq[1][1], "CANCELED", now)))
    seq.append(("Failed", to_terminal(seq[0][1], "UNFULFILLED", now)))
    return seq


LONG_DRIVER, LONG_CAR = "Mohammed Abdulrahman Al Mansoori", "White Mercedes-Benz S-Class"


def acceptance_states(rider="moni"):
    """Every state plus the cases that broke the compact bubble before: a new driver, a stale
    read, long driver/car/rider/booker names, and those combined."""
    now = time.time()
    old = iso(now - 600)

    def card(status, eta="4 mins", north=1500, prev=None, **kw):
        return from_live(sample_trip(status, eta=eta, north_m=north, **kw), prev, rider, "abdullah", now)

    first = card("WaitingForPickup")
    new = card("WaitingForPickup", prev=first, plate="Z 777", name=LONG_DRIVER, car=LONG_CAR)
    names = {"rider_name": "Chandrashekharasubramaniam", "booker_name": "Christopher Montgomery"}
    return sample_states(rider) + [
        ("NewDriver", new),
        ("Stale", dict(card("WaitingForPickup", name=LONG_DRIVER), checked_at=old)),
        ("StaleNewDriver", dict(new, checked_at=old)),
        ("OnTripStale", dict(card("OnTrip", eta=None, north=0, name=LONG_DRIVER), checked_at=old)),
        ("ArrivedNewDriver", dict(card("ArrivingAtPickup", eta="0 mins", north=20, prev=first, plate="Z 777"),
                                  checked_at=old)),
        ("LongRider", dict(new, rider_name="Muhammad Abdullah")),
        ("LongNames", dict(card("Accepted", eta="6 mins", north=3000), **names)),
        ("LongNamesNewDriverStale", dict(new, checked_at=old, **names)),
    ]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)
    a = sp.add_parser("refresh"); a.add_argument("--trip", required=True)
    a = sp.add_parser("send"); a.add_argument("--trip", required=True); a.add_argument("--session", required=True)
    a.add_argument("--chat", action="append", default=[],
                   help="from the owner session: send only to this bridge chat slug and add it to the ride (repeatable)")
    a.add_argument("--from-chat", help="optional check: the chat this session is in (it is read from the bridge)")
    a.add_argument("--dry-run", action="store_true", help="show the plan; publishes, sends and writes nothing")
    a.add_argument("--moni-mode", choices=["card", "link"]); a.add_argument("--abdullah-mode", choices=["card", "link"])
    a = sp.add_parser("meta"); a.add_argument("--trip", required=True)
    a.add_argument("--rider", required=True); a.add_argument("--booker")
    a.add_argument("--rider-name"); a.add_argument("--booker-name")
    a.add_argument("--recipient", action="append", default=[], help="extra bridge chat slug (repeatable)")
    a = sp.add_parser("show"); a.add_argument("--trip", required=True)
    a = sp.add_parser("sample"); a.add_argument("--out", required=True); a.add_argument("--rider", default="moni")
    a.add_argument("--acceptance", action="store_true", help="add the compact-bubble hard cases (card-check set)")
    a = ap.parse_args(argv)
    if a.cmd == "refresh":
        c = refresh(a.trip)
        print(json.dumps({"dir": str(card_dir(c["trip"])), "state": c["state"], "v": c["v"]}))
    elif a.cmd == "send":
        modes = {k: v for k, v in (("moni", a.moni_mode), ("abdullah", a.abdullah_mode)) if v}
        res, failed = send(a.trip, a.session, a.from_chat, a.dry_run, modes, chats=a.chat)
        print(json.dumps(res))
        return 1 if failed else 0
    elif a.cmd == "meta":
        m = set_meta(a.trip, a.rider, a.booker, a.rider_name, a.booker_name, a.recipient)
        print(json.dumps({"recipients": recipients_for(a.trip), "rider": m["rider"], "booker": m["booker"]}))
    elif a.cmd == "show":
        print(json.dumps({"card": read_json(card_dir(a.trip) / "data.json"), "recipients": recipients_for(a.trip),
                          "journal": read_json(journal_path(a.trip))}, indent=1))
    elif a.cmd == "sample":
        out = Path(a.out)
        for name, c in (acceptance_states if a.acceptance else sample_states)(a.rider):
            print(json.dumps({"state": name, "dir": str(write_card(c, out / name.lower(), force=True) and out / name.lower())}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
