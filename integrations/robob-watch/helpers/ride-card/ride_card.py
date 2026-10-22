#!/usr/bin/python3
"""ride-card: one live card per Uber trip, shared with the rider and the booker.

    ride-card refresh --trip UUID            read `uber rides status` (exact UUID) and rebuild the card
    ride-card send --trip UUID --session S   share the card once per recipient (idempotent, frozen payload)
         [--from-chat owner|SLUG] [--dry-run]
    ride-card meta --trip UUID --rider WHO [--rider-name NAME] [--booker WHO] [--booker-name NAME]
         [--recipient SLUG]...   WHO = abdullah (owner chat), moni, or another bridge chat slug
    ride-card show --trip UUID               card data + share journal (no side effects)
    ride-card sample --out DIR               render every state for a sample trip (tests, contact sheet)

Card folder (public, sanitized only): ~/.local/share/imessage-apps/ride-<uuid>/
  data.json, index.html, preview.png. The page re-reads data.json every 20s.
Private (never served): ~/.local/state/ride-card/<uuid>.json (share journal) and <uuid>.meta.json
  (rider, booker, extra recipients by bridge chat slug, display names).
Recipients: abdullah + moni + rider + booker + extras, deduped. Abdullah (owner chat) gets the tailnet
URL; everyone else gets the public share URL. From the owner session every recipient is reachable
(--to SLUG); from any other chat only that chat itself.

The ride-share-updates watcher rebuilds the card every 30s; it never sends.
Nothing here infers arrival from an ETA or completion from a missing trip. Arrived needs Uber's
ArrivingAtPickup status and the car within AT_PICKUP_M of the pickup pin.

Env overrides: RIDE_CARD_ROOT, RIDE_CARD_JOURNAL, RIDE_SHARE_HINTS, RIDE_CARD_BRIDGE (bridge CLI
command, space separated), RIDE_CARD_PREVIEW_LIB, RIDE_CARD_NO_IMAGE=1 (skip Chrome, tests), UBER_BIN.
"""
import argparse, fcntl, hashlib, tempfile, html, json, math, os, re, shlex, shutil, subprocess, sys, time
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
    """Per-trip exclusive lock (journal dir) shared by the watcher, refresh and send."""
    def __init__(self, uuid):
        self.path = journal_dir() / f".{check_uuid(uuid)}.lock"
    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.f = open(self.path, "a")
        fcntl.flock(self.f, fcntl.LOCK_EX)
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
    c.update(rider=rider, booker=booker, terminal=False, note=None,
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
    c.update(state=state, terminal=True, pickup_eta=None, arrival_eta=None, checked_at=iso(now), since=iso(now))
    c["step"] = 4 if state == "done" else c.get("step", 0)
    c["note"] = note or ("No driver found" if status == "UNFULFILLED" else None)
    return c


def to_unknown(prev, now, final=False):
    c = dict(prev)
    if c.get("state") != "unknown":
        c["since"] = iso(now)
    c.update(state="unknown", pickup_eta=None, arrival_eta=None, checked_at=iso(now), terminal=bool(final))
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
               "plate", "pickup", "dropoff", "pickup_eta", "arrival_eta", "note", "driver_changed", "checked_at", "since")
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
.who{display:flex;justify-content:space-between;gap:12px;font-size:17px;font-weight:650;line-height:1.3}
.who span:last-child{font-size:14px;font-weight:500;color:var(--field-soft);text-align:right;min-width:0;overflow-wrap:anywhere;align-self:center}
.kick{font-size:15px;font-weight:500;color:var(--field-soft);margin-top:18px}
h1{text-wrap:balance;font-size:76px;line-height:1;letter-spacing:-.045em;font-weight:700;margin-top:18px;overflow-wrap:anywhere}
.kick+h1{margin-top:4px}
h1.long{font-size:clamp(36px,10vw,54px);letter-spacing:-.035em;line-height:1.05}
.sub{font-size:18px;font-weight:500;margin-top:8px;line-height:1.3}
.note{display:inline-block;margin-top:12px;font-size:14px;font-weight:650;padding:5px 12px;border-radius:999px;background:var(--field-ink);color:var(--field)}
.stale{margin:16px 24px 0;padding:10px 14px;border-radius:14px;background:var(--well);font-size:14px;line-height:1.35;color:var(--warn);font-weight:600}
.stale[hidden]{display:none}
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
""".replace("FONT", FONT)

JS = """
const V=%d,TERM=%s;const $=s=>document.querySelector(s);
const q=new URLSearchParams(location.search).get('theme');if(q==='dark'||q==='light')document.documentElement.classList.add(q);
let at=new Date($('time').getAttribute('datetime'));
const fmt=d=>new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit',timeZone:'Asia/Dubai'}).format(d);
function paint(){const s=Math.max(0,Math.round((Date.now()-at)/1000)),m=Math.round(s/60);
$('time').textContent=fmt(at);$('#ago').textContent=s<60?'just now':m+' min ago';
const st=$('#stale');if(!TERM&&s>%d){st.hidden=false;st.innerHTML='No update for '+m+' min<span class="more">. Details may be out of date.</span>';}else st.hidden=true;}
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

def uber_status(timeout=20):
    uber = os.environ.get("UBER_BIN") or shutil.which("uber") or "/Users/ardud/.nvm/versions/node/v26.2.0/bin/uber"
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
    j = read_json(journal_path(uuid), {}) or {}
    return {r for r, v in (j.get("recipients") or {}).items() if v.get("status") == "sent"}


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


def send(uuid, session, from_chat="owner", dry_run=False, modes=None, force=False):
    """Share the card once per recipient. Frozen payload per trip+recipient; same bridge key on retries."""
    uuid = check_uuid(uuid)
    from_chat = person(from_chat)
    if not session or not re.match(r"^[A-Za-z0-9:_@.-]{6,200}$", session):
        raise SystemExit("ride-card: --session must be the current iMessage session id")
    c = load_card(uuid)
    if not c:
        c = refresh(uuid)
    with trip_lock(uuid):
        return _send_locked(uuid, c, session, from_chat, dry_run, modes, force)


def _send_locked(uuid, c, session, from_chat, dry_run, modes, force):
    if c.get("terminal") and not force:
        raise SystemExit(f"ride-card: trip {uuid} already ended ({c['state']}); not sending a new card")
    modes = modes or {}
    j = load_journal(uuid)
    recips = j.setdefault("recipients", {})
    everyone = recipients_for(uuid)
    if from_chat == "abdullah":
        plan = [(r, None if r == "abdullah" else r) for r in everyone]
    elif from_chat in everyone:
        plan = [(from_chat, None)]  # a non-owner chat can only reach itself
    else:
        raise SystemExit(f"ride-card: chat {from_chat!r} is not a recipient of this ride")
    result, failed = {}, False
    for who, to in plan:
        r = recips.setdefault(who, {})
        if r.get("status") == "sent":
            result[who] = "already sent"
            continue
        key = f"uber:{uuid}:card:{who}"
        try:
            if "payload" not in r:
                if dry_run:
                    result[who] = "would publish+send"
                    continue
                mode = modes.get(who) or ("card" if who == "abdullah"
                                          else "card" if who == "moni" and moni_has_cards() else "link")
                if mode == "card" and to and not bridge_app_to():
                    raise RuntimeError("bridge has no `app --to` yet; use link mode for this recipient")
                if who == "abdullah":
                    pub = bridge("publish", "--app", slug(uuid))
                else:
                    pub = bridge("share", "--app", slug(uuid), "--days", "2")
                url = pub.get("publicURL") or pub.get("url")
                warn = pub.get("metadataWarnings") or []
                if warn:
                    raise RuntimeError(f"page metadata warnings: {warn}")
                if not url or not str(url).startswith("https://"):
                    raise RuntimeError(f"no https URL from bridge: {str(pub)[:200]}")
                r["payload"] = payload_for(c, who, url, mode)
                r["key"] = key
                r["created_at"] = iso(time.time())
                _save_journal(uuid, j)
            if dry_run:
                result[who] = f"would send {r['payload']['mode']} {r['payload']['url']}"
                continue
            r["attempts"] = r.get("attempts", 0) + 1
            deliver(uuid, who, r["payload"], session, to, r.get("key", key))
            r.update(status="sent", sent_at=iso(time.time()), error=None)
            result[who] = "sent"
        except Exception as ex:
            r.update(status="failed", error=str(ex)[:300])
            result[who] = f"failed: {str(ex)[:200]}"
            failed = True
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


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)
    a = sp.add_parser("refresh"); a.add_argument("--trip", required=True)
    a = sp.add_parser("send"); a.add_argument("--trip", required=True); a.add_argument("--session", required=True)
    a.add_argument("--from-chat", default="owner", help="owner (default) or the bridge chat slug this session is in")
    a.add_argument("--dry-run", action="store_true")
    a.add_argument("--moni-mode", choices=["card", "link"]); a.add_argument("--abdullah-mode", choices=["card", "link"])
    a = sp.add_parser("meta"); a.add_argument("--trip", required=True)
    a.add_argument("--rider", required=True); a.add_argument("--booker")
    a.add_argument("--rider-name"); a.add_argument("--booker-name")
    a.add_argument("--recipient", action="append", default=[], help="extra bridge chat slug (repeatable)")
    a = sp.add_parser("show"); a.add_argument("--trip", required=True)
    a = sp.add_parser("sample"); a.add_argument("--out", required=True); a.add_argument("--rider", default="moni")
    a = ap.parse_args(argv)
    if a.cmd == "refresh":
        c = refresh(a.trip)
        print(json.dumps({"dir": str(card_dir(c["trip"])), "state": c["state"], "v": c["v"]}))
    elif a.cmd == "send":
        modes = {k: v for k, v in (("moni", a.moni_mode), ("abdullah", a.abdullah_mode)) if v}
        res, failed = send(a.trip, a.session, a.from_chat, a.dry_run, modes)
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
        for name, c in sample_states(a.rider):
            print(json.dumps({"state": name, "dir": str(write_card(c, out / name.lower(), force=True) and out / name.lower())}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
