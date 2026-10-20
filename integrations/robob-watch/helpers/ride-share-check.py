#!/usr/bin/python3
"""ride-share-updates: tell the other person (Abdullah <-> Moni) where a ride is
going and when it arrives. Polls `uber rides status --json` on Abdullah's Uber
account. Prints one event line per new happening; state in the state file so
each trip fires BOOKED once and ENDED once.

Env overrides (all optional):
  WATCH_DIR          directory for rides.json (default: current working dir)
  RIDE_SHARE_STATE   full path of the state file
  RIDE_SHARE_HINTS   rider hint directory (default ~/.local/share/rides-notify)
  UBER_BIN           uber binary (default: PATH lookup, then the fixed path)
  RIDE_SHARE_NOW     epoch seconds to use as "now" (tests only)

Rider hint: whoever books a ride for Moni writes
~/.local/share/rides-notify/rider-<TRIP_UUID> containing "moni" (or "abdullah").
No hint -> rider assumed Abdullah (the woken agent double-checks).

BOOKED needs a driver on two checks at least 60s apart. A trip that was announced
as BOOKED and then CANCELED is held for 180s; a new BOOKED for the same rider in
that window prints one REBOOKED line and no cancel line.
"""
import json, os, shutil, subprocess, sys, time
from datetime import datetime, timezone, timedelta

WD = os.environ.get("WATCH_DIR", os.getcwd())
STATE = os.environ.get("RIDE_SHARE_STATE") or os.path.join(WD, "rides.json")
HINTS = os.environ.get("RIDE_SHARE_HINTS") or os.path.expanduser("~/.local/share/rides-notify")
UBER = os.environ.get("UBER_BIN") or shutil.which("uber") or "/Users/ardud/.nvm/versions/node/v26.2.0/bin/uber"
ENV = dict(os.environ, PATH="/Users/ardud/.nvm/versions/node/v26.2.0/bin:" + os.environ.get("PATH", ""))
DXB = timezone(timedelta(hours=4))
FAIL_ALERT_S = 600
BOOK_CONFIRM_S = 60
REBOOK_WINDOW_S = 180
ACTIVE_NO_DRIVER = {"Searching", "Dispatching", "Matching", "Requesting", "WaitingForDispatch"}


def now_ts():
    v = os.environ.get("RIDE_SHARE_NOW")
    return float(v) if v else time.time()


def load():
    try:
        with open(STATE) as f:
            return json.load(f)
    except Exception:
        return {"trips": {}, "active": None, "fail_since": None}


def save(s):
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f, indent=1)
    os.replace(tmp, STATE)


def uber(*args, timeout=25):
    p = subprocess.run([UBER, *args, "--json"], capture_output=True, text=True, timeout=timeout, env=ENV)
    return json.loads(p.stdout)


def rider_for(uuid):
    try:
        with open(os.path.join(HINTS, f"rider-{uuid}")) as f:
            v = f.read().strip().lower()
            return ("moni" if v.startswith("mon") else "abdullah"), True
    except Exception:
        return "abdullah", False


def hhmm(iso):
    if not iso:
        return "unknown"
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(DXB).strftime("%H:%M")
    except Exception:
        return str(iso)


def main():
    s = load()
    now = now_ts()
    try:
        d = uber("rides", "status")
        if not d.get("ok"):
            raise RuntimeError(json.dumps(d.get("error"))[:200])
        s["fail_since"] = None
    except Exception as e:
        s["fail_since"] = s.get("fail_since") or now
        save(s)
        if now - s["fail_since"] > FAIL_ALERT_S:
            print(f"uber rides status failing for {int((now - s['fail_since'])/60)} min: {e}", file=sys.stderr)
            sys.exit(1)
        return

    out = []
    trip = (d.get("result") or {}).get("trip")
    cur = trip.get("uuid") if trip else None
    trips = s.setdefault("trips", {})
    pending = s.setdefault("pending_cancel", {})
    ready = None

    if trip and cur:
        t = trips.setdefault(cur, {"first_seen": now})
        stops = trip.get("stops") or []
        dest = next((x.get("title") for x in stops if x.get("type") == "Dropoff"), None)
        t.update(status=trip.get("status"), dest=dest or t.get("dest"), eta=trip.get("arrivalEta"), last_seen=now)
        rider, hinted = rider_for(cur)
        t["rider"], t["rider_hinted"] = rider, hinted
        if trip.get("driver") and trip.get("status") not in ACTIVE_NO_DRIVER:
            if t.get("driver_seen") is None:
                t["driver_seen"] = now
            elif not t.get("booked_fired") and now - t["driver_seen"] >= BOOK_CONFIRM_S:
                ready = cur
        else:
            t["driver_seen"] = None

    prev = s.get("active")
    if prev and prev != cur:
        s.setdefault("ending", {})[prev] = s.get("ending", {}).get(prev, now)
        if prev in trips:
            trips[prev]["driver_seen"] = None
    s["active"] = cur

    for uuid, since in list(s.get("ending", {}).items()):
        t = trips.get(uuid, {})
        status, ended = None, None
        try:
            g = uber("trips", "get", uuid)
            if g.get("ok"):
                status = ((g.get("result") or {}).get("status") or "").upper() or None
                ended = (g.get("result") or {}).get("endedAt")
        except Exception:
            pass
        terminal = status in ("COMPLETED", "CANCELED", "CANCELLED", "UNFULFILLED", "FAILED")
        if not terminal:
            # history lags the live status by a few minutes; after 5 min without
            # an active trip, treat it as ended (most likely completed)
            if now - since < 300:
                continue
            status = f"{status or 'not-in-history'}; no longer active for 5+ min (likely completed)"
        del s["ending"][uuid]
        if t.get("ended_fired"):
            continue
        t["ended_fired"] = now
        if not t.get("booked_fired"):
            continue  # never had a driver: nothing was announced, nothing to close
        rider, hinted = rider_for(uuid)
        if status in ("CANCELED", "CANCELLED"):
            pending[uuid] = {"since": now, "rider": rider, "rider_hinted": hinted, "dest": t.get("dest")}
            continue
        out.append(f"ENDED trip={uuid} rider={rider}{'' if hinted else '(assumed)'} result={status} "
                   f"dest=\"{t.get('dest')}\" ended_at={hhmm(ended) if ended else hhmm(datetime.fromtimestamp(now, timezone.utc).isoformat())} (Dubai)")

    if ready:
        t = trips[ready]
        rider, hinted = t["rider"], t["rider_hinted"]
        t["booked_fired"] = now
        match = sorted((p["since"], u) for u, p in pending.items()
                       if p["rider"] == rider and now - p["since"] < REBOOK_WINDOW_S)
        if match:
            old = match[0][1]
            pending.pop(old, None)
            out.append(f"REBOOKED trip={ready} replaces={old} rider={rider}{'' if hinted else '(assumed)'} "
                       f"dest=\"{t['dest']}\" arrive_eta={hhmm(t['eta'])} (Dubai) status={t['status']}")
        else:
            out.append(f"BOOKED trip={ready} rider={rider}{'' if hinted else '(assumed)'} dest=\"{t['dest']}\" "
                       f"arrive_eta={hhmm(t['eta'])} (Dubai) status={t['status']}")

    for uuid, p in list(pending.items()):
        if now - p["since"] >= REBOOK_WINDOW_S:
            del pending[uuid]
            out.append(f"ENDED trip={uuid} rider={p['rider']}{'' if p['rider_hinted'] else '(assumed)'} result=CANCELED "
                       f"dest=\"{p['dest']}\" ended_at={hhmm(datetime.fromtimestamp(p['since'], timezone.utc).isoformat())} (Dubai)")

    # prune old trip records
    for uuid in [u for u, t in trips.items() if now - t.get("last_seen", t.get("first_seen", now)) > 14 * 86400]:
        trips.pop(uuid, None)
    save(s)
    if out:
        print("\n".join(out))


if __name__ == "__main__":
    main()
