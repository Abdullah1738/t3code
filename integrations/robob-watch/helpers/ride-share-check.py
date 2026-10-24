#!/usr/bin/python3
"""ride-share-updates: keep one live ride card per Uber trip current, and wake the agent only when
a card has to be shared or a shared ride really got cancelled/failed.

Polls `uber rides status --json` (Abdullah's account, incl. rides booked for Moni) every run, rebuilds
the trip's card (ride_card.py: data.json, index.html, preview.png) and prints at most:

  CARD_READY trip=<uuid> rider=<who>[(assumed)] missing=<recipients>   driver assigned ~60s, card not yet sent to everyone
  CANCELED trip=<uuid> rider=<who>[(assumed)]                          a shared ride was cancelled and not rebooked within 180s
  FAILED trip=<uuid> rider=<who>[(assumed)] result=<STATUS>            a shared ride ended UNFULFILLED/FAILED

Completion is quiet (the card turns to Dropped off). Completion is only ever taken from trip history;
a trip that disappears without a terminal history status shows "Checking" and is retried for
UNKNOWN_GIVE_UP_S, then frozen as unconfirmed. It never sends anything itself; the only bridge call
it makes is `unshare`, an hour after a ride ended, for that ride's public share link.

Env overrides (all optional):
  WATCH_DIR          directory for rides.json and polls.jsonl (one line per poll: raw Uber status,
                     headline, pickup ETA, car-to-pickup metres, card state; default: current dir)
  RIDE_SHARE_STATE   full path of the state file
  RIDE_SHARE_HINTS   rider/booker hint directory (default ~/.local/share/rides-notify)
  RIDE_CARD_ROOT     where cards are written. Unset: the live imessage-apps folder only when WATCH_DIR
                     is the live watcher dir, otherwise WATCH_DIR/cards (so `robob-watch test` scratch
                     runs never touch live cards)
  RIDE_CARD_JOURNAL  share journal dir (default ~/.local/state/ride-card), read only here
  UBER_BIN           uber binary
  RIDE_SHARE_NOW     epoch seconds to use as "now" (tests only)
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "ride-card"))

WD = os.environ.get("WATCH_DIR", os.getcwd())
STATE = os.environ.get("RIDE_SHARE_STATE") or os.path.join(WD, "rides.json")
LIVE_DIR = Path.home() / ".local/share/robob-watch/watchers/ride-share-updates"
if not os.environ.get("RIDE_CARD_ROOT"):
    if Path(WD).resolve() != LIVE_DIR.resolve():
        os.environ["RIDE_CARD_ROOT"] = os.path.join(WD, "cards")
        os.environ.setdefault("RIDE_CARD_JOURNAL", os.path.join(WD, "journal"))
import ride_card as rc  # noqa: E402  (after RIDE_CARD_ROOT is settled)

UBER = os.environ.get("UBER_BIN") or rc.fixed_uber() or shutil.which("uber") or "/Users/ardud/.nvm/versions/node/v26.2.0/bin/uber"
ENV = dict(os.environ, PATH="/Users/ardud/.nvm/versions/node/v26.2.0/bin:" + os.environ.get("PATH", ""))
FAIL_ALERT_S = 600
BOOK_CONFIRM_S = 60
REBOOK_WINDOW_S = 180
UNKNOWN_GIVE_UP_S = 3 * 3600
CARD_RETRY_S = 600          # one more CARD_READY if someone still lacks the card 10 min later
MISSES_BEFORE_UNKNOWN = 2   # a single empty poll doesn't flip a live card to "Checking"
PREVIEW_RETRIES = 10        # checks spent re-rendering a frozen card's failed preview
UNSHARES_PER_RUN = 3        # ended rides' links taken down per check


def now_ts():
    v = os.environ.get("RIDE_SHARE_NOW")
    return float(v) if v else time.time()


def load():
    try:
        with open(STATE) as f:
            s = json.load(f)
    except Exception:
        s = {}
    s.setdefault("trips", {})
    s.setdefault("active", None)
    s.setdefault("fail_since", None)
    s.setdefault("ending", {})
    s.setdefault("pending_cancel", {})
    s.setdefault("preview_retry", {})
    # migrate the old text-era state: an announced trip counts as shared and requested
    for t in s["trips"].values():
        if t.get("booked_fired") is not None and t.get("card_requested") is None:
            t["card_requested"] = t["booked_fired"]
            t["legacy_shared"] = True
    for p in s["pending_cancel"].values():
        p.setdefault("label", p.get("rider"))
    return s


def save(s):
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f, indent=1)
    os.replace(tmp, STATE)


def uber(*args, timeout=25):
    p = subprocess.run([UBER, *args, "--json"], capture_output=True, text=True, timeout=timeout, env=ENV,
                       stdin=subprocess.DEVNULL)
    return json.loads((p.stdout.strip().splitlines() or ["{}"])[-1])


POLL_LOG_MAX = 2_000_000    # bytes; polls.jsonl keeps its newest half past this


def log_poll(trip, card, now):
    """One line per poll of a live trip with Uber's raw status, so the at-pickup rule can be checked
    against real rides. Distance only, never the car's coordinates."""
    path = Path(WD) / "polls.jsonl"
    try:  # diagnostics only: never let a bad row stop the watcher's real work
        row = {"ts": rc.iso(now), "trip": card["trip"], "status": trip.get("status"),
               "headline": rc.clean(trip.get("headline")), "detail": rc.clean(trip.get("detail")),
               "eta": rc.clean(trip.get("pickupEta"), 16), "dist_m": rc.pickup_distance(trip), "card": card["state"]}
        line = json.dumps(row) + "\n"
        if path.exists() and path.stat().st_size > POLL_LOG_MAX:
            keep = path.read_bytes()[-POLL_LOG_MAX // 2:]
            rc.atomic_write(path, keep[keep.find(b"\n") + 1:], "wb")
        with open(path, "a") as f:
            f.write(line)
    except Exception as e:
        print(f"ride-share: poll log failed: {e!r}", file=sys.stderr)


def who(uuid):
    rider, hinted = rc.rider_for(uuid)
    return rider, hinted, f"{rider}{'' if hinted else '(assumed)'}"


def card_shared(uuid, t=None):
    """A card counts as shared once any recipient got it (or the old text flow announced the trip)."""
    return bool(rc.sent_to(uuid)) or bool((t or {}).get("legacy_shared"))


def q(v):
    return json.dumps(v if v is None else str(v), ensure_ascii=False)


def recently_requested(trips, rider, now, exclude):
    return any(u != exclude and t.get("rider") == rider and t.get("card_requested")
               and now - t["card_requested"] < REBOOK_WINDOW_S for u, t in trips.items())


def unshare_ended(now, live=None):
    """An hour after a ride ends, its public share link goes: the bridge caps live shares at 10 and
    old ride links used them all up (trip e44d36f9). Reads the share journal, so rides this state
    file no longer tracks are covered too. A bridge that fails is tried again next run. The trip Uber
    shows right now is never touched, whatever its card says."""
    if not os.environ.get("RIDE_CARD_BRIDGE") and Path(WD).resolve() != LIVE_DIR.resolve():
        return  # a scratch run's journal isn't the real one: never touch real shares from it
    done = 0
    for p in sorted(rc.journal_dir().glob("*.json")):
        if done >= UNSHARES_PER_RUN:
            return  # the rest go next run; the check has a 60s budget
        uuid = p.stem
        if uuid == live or not rc.UUID_RE.match(uuid) or rc.unshared_path(uuid).exists() \
                or not rc.public_link(uuid):
            continue
        try:
            with rc.trip_lock(uuid, wait=False):
                if not rc.link_done(rc.load_card(uuid), now) or rc.unshared_path(uuid).exists():
                    continue
                try:
                    rc.unshare(uuid)
                    done += 1
                except Exception as e:
                    print(f"ride-share: unshare {uuid} failed: {e}"[:300], file=sys.stderr)
                    return  # the bridge is down or busy: no point trying the rest this run
        except BlockingIOError:
            continue  # a send or refresh holds it: next run


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
    trips, ending, pending = s["trips"], s["ending"], s["pending_cancel"]
    trip = (d.get("result") or {}).get("trip")
    cur = None
    if trip and trip.get("uuid"):
        try:
            cur = rc.check_uuid(trip["uuid"])
        except SystemExit:
            print(f"ride-share: ignoring malformed trip uuid {str(trip.get('uuid'))[:60]!r}", file=sys.stderr)
            save(s)
            return  # can't bind a card to it; leave every other trip untouched this run
    if cur:
        t = trips.setdefault(cur, {"first_seen": now})
        rider, hinted, label = who(cur)
        with rc.trip_lock(cur):
            prev = rc.load_card(cur)
            card = rc.from_live(trip, prev, rider, rc.booker_for(cur), now)
            # A card frozen as "Uber never confirmed the end" whose trip Uber shows again was live
            # all along: it reopens. Cards Uber's history ended stay frozen.
            frozen = bool(prev and prev.get("terminal")) and prev.get("state") != "unknown"
            if not frozen:
                reopened = bool(prev and prev.get("terminal"))
                rc.write_card(card, force=reopened)
                if reopened and rc.unshared_path(cur).exists() and rc.relink(cur):
                    # Its public link went while it looked over: whoever had it gets a new one.
                    t.pop("card_requested", None)
                    t.pop("card_retried", None)
            elif rc.preview_pending(cur):
                s["preview_retry"].setdefault(cur, 0)
        log_poll(trip, prev if frozen else card, now)
        t.pop("misses", None)
        t.update(status=trip.get("status"), dest=card.get("dropoff") or t.get("dest"), last_seen=now,
                 rider=rider, rider_hinted=hinted)
        ending.pop(cur, None)
        has_driver = card["state"] not in ("searching",)
        if has_driver:
            if t.get("driver_seen") is None:
                t["driver_seen"] = now
            elif now - t["driver_seen"] >= BOOK_CONFIRM_S and (
                    t.get("card_requested") is None
                    or (not t.get("card_retried") and not t.get("legacy_shared")
                        and now - t["card_requested"] >= CARD_RETRY_S)):
                missing = [r for r in rc.recipients_for(cur) if r not in rc.sent_to(cur)]
                if t.get("card_requested") is not None:
                    t["card_retried"] = now
                else:
                    t["card_requested"] = now
                if missing:
                    out.append(f"CARD_READY trip={cur} rider={label} missing={','.join(missing)} "
                               f"state={card['state']} dest={q(card.get('dropoff'))}")
                # a rebook inside the window replaces the old trip's cancel line
                for old, p in list(pending.items()):
                    if p.get("rider") == rider and now - p["since"] < REBOOK_WINDOW_S:
                        pending.pop(old, None)
        else:
            t["driver_seen"] = None

    prev_active = s.get("active")
    if prev_active and prev_active != cur and prev_active not in ending:
        ending[prev_active] = now
        trips.setdefault(prev_active, {"first_seen": now})["misses"] = 0
    s["active"] = cur

    for uuid, since in list(ending.items()):
        status = None
        try:
            g = uber("trips", "get", uuid)
            if g.get("ok"):
                status = ((g.get("result") or {}).get("status") or "").upper() or None
        except Exception:
            pass
        with rc.trip_lock(uuid):
            card = rc.load_card(uuid)
            if status in rc.TERMINAL and card and not card.get("terminal"):
                rc.write_card(rc.to_terminal(card, status, now))
                if rc.preview_pending(uuid):
                    s["preview_retry"][uuid] = 0
        if status in rc.TERMINAL:
            del ending[uuid]
            t = trips.setdefault(uuid, {"first_seen": since})
            if t.get("ended_fired"):
                continue
            t["ended_fired"] = now
            t["result"] = status
            if not card_shared(uuid, t):
                continue  # nothing was shared: nothing to correct
            rider, _, label = who(uuid)
            if rc.TERMINAL[status] == "cancelled":
                if recently_requested(trips, rider, now, uuid):
                    continue  # already rebooked: the new card says it all
                pending[uuid] = {"since": now, "rider": rider, "label": label}
            elif rc.TERMINAL[status] == "failed":
                out.append(f"FAILED trip={uuid} rider={label} result={status}")
            continue
        # no terminal history yet: never assume completion
        t = trips.setdefault(uuid, {"first_seen": since})
        t["misses"] = t.get("misses", 0) + 1
        if card and not card.get("terminal") and t["misses"] < MISSES_BEFORE_UNKNOWN \
                and now - since < UNKNOWN_GIVE_UP_S:
            continue  # one empty poll: keep the live card as is
        if card and not card.get("terminal"):
            final = now - since >= UNKNOWN_GIVE_UP_S
            with rc.trip_lock(uuid):
                if card.get("state") != "unknown" or final:
                    rc.write_card(rc.to_unknown(card, now, final=final))
                else:
                    rc.write_card(dict(card, checked_at=rc.iso(now)))
            if final:
                del ending[uuid]
        elif now - since >= UNKNOWN_GIVE_UP_S:
            del ending[uuid]

    # frozen cards whose final preview failed to render: retry (same version) for a few checks
    for uuid, n in list(s["preview_retry"].items()):
        with rc.trip_lock(uuid):
            card = rc.load_card(uuid)
            if card and rc.preview_pending(uuid) and n < PREVIEW_RETRIES:
                rc.write_card(card)
        if not card or not rc.preview_pending(uuid) or n + 1 >= PREVIEW_RETRIES:
            s["preview_retry"].pop(uuid, None)
        else:
            s["preview_retry"][uuid] = n + 1

    unshare_ended(now, live=cur)

    for uuid, p in list(pending.items()):
        if now - p["since"] >= REBOOK_WINDOW_S:
            del pending[uuid]
            out.append(f"CANCELED trip={uuid} rider={p.get('label') or p.get('rider')}")

    for uuid in [u for u, t in trips.items() if now - t.get("last_seen", t.get("first_seen", now)) > 14 * 86400]:
        trips.pop(uuid, None)
    save(s)
    if out:
        print("\n".join(out))


if __name__ == "__main__":
    main()
