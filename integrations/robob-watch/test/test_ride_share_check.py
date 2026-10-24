import json
import os
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import unittest.mock

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, "..", "helpers", "ride-share-check.py")
CARD = os.path.join(HERE, "..", "helpers", "ride-card", "ride_card.py")

A = "aaaaaaaa-0000-4000-8000-000000000001"
B = "bbbbbbbb-0000-4000-8000-000000000002"

FAKE_UBER = """#!/usr/bin/python3
import json, os, sys
state = json.load(open(os.environ["FAKE_UBER_STATE"]))
args = [a for a in sys.argv[1:] if a != "--json"]
with open(os.environ["FAKE_UBER_STATE"] + ".calls", "a") as f:
    f.write(" ".join(args) + "\\n")
if args[:2] == ["rides", "status"]:
    out = {"ok": True, "result": {"trip": state.get("trip")}}
elif args[:2] == ["trips", "get"]:
    t = state.get("history", {}).get(args[2])
    out = {"ok": True, "result": t} if t else {"ok": False, "error": "not found"}
else:
    out = {"ok": False, "error": "unexpected args " + " ".join(args)}
print(json.dumps(out))
"""

FAKE_BRIDGE = """#!/usr/bin/python3
import hashlib, json, os, sqlite3, sys
args = sys.argv[1:]
log = os.environ["FAKE_BRIDGE_LOG"]
with open(log, "a") as f:
    f.write(json.dumps(args) + "\\n")

def opt(name):
    return args[args.index(name) + 1] if name in args else None

def queue(state):
    # Like the bridge: --to ops sit in the target chat's store under hash(slug:key) with no session;
    # a chat's own ops sit under hash(key), bound to its route id and generation.
    base = os.environ["RIDE_CARD_BRIDGE_STATE"]
    h = lambda s: hashlib.sha256(s.encode()).hexdigest()
    to, key, session = opt("--to"), opt("--key"), opt("--session")
    dbs = [os.path.join(base, "state.sqlite")] + [os.path.join(base, "chats", c, "state.sqlite")
                                                 for c in sorted(os.listdir(os.path.join(base, "chats")))]
    if to:
        db = dbs[0] if to == "owner" else os.path.join(base, "chats", to, "state.sqlite")
        oid, op = args[0] + ":" + h(to + ":" + key), {}
    else:
        for db in dbs:
            con = sqlite3.connect(db)
            route = json.loads(con.execute("select value from kv where key='route'").fetchone()[0])
            con.close()
            if session in (route["id"], route["id"] + "@" + str(route["generation"])):
                break
        else:
            print('{"error":"Bridge request failed (HTTP 409)"}', file=sys.stderr); sys.exit(1)
        oid, op = args[0] + ":" + h(key), {"sessionId": route["id"], "generation": route["generation"]}
    op["content"] = opt("--text") or opt("--url")
    con = sqlite3.connect(db)
    row = con.execute("select payload from outbox where id = ?", (oid,)).fetchone()
    if row and row[0] != json.dumps(op):
        # Same id, other content (or a session-bound op from another route): the bridge says 409.
        con.close()
        print('{"error":"Bridge request failed (HTTP 409)"}', file=sys.stderr); sys.exit(1)
    if not row:
        con.execute("insert into outbox values (?, ?, ?, 0)", (oid, json.dumps(op), state))
        con.commit()
    con.close()
    return {"id": oid, "created": not row}

if args[0] in ("send", "app") and os.environ.get("FAKE_BRIDGE_PEEK"):
    # What the share journal said while the bridge call was in flight.
    with open(os.environ["FAKE_BRIDGE_PEEK"]) as f, open(os.environ["FAKE_BRIDGE_PEEK"] + ".seen", "a") as g:
        g.write(f.read() + "\\n")
if args[0] in ("send", "app") and os.environ.get("FAKE_BRIDGE_NO_TO") and opt("--to") == "owner":
    print('{"error":"Invalid command arguments"}', file=sys.stderr); sys.exit(1)  # an older bridge
fail = os.environ.get("FAKE_BRIDGE_FAIL") == args[0]
if fail and os.environ.get("FAKE_BRIDGE_QUEUED"):
    queue(os.environ["FAKE_BRIDGE_QUEUED"])  # accepted, but the reply never came back
if fail:
    print(os.environ.get("FAKE_BRIDGE_ERR") or "boom", file=sys.stderr); sys.exit(1)
if args[0] in ("send", "app"):
    print(json.dumps(queue(os.environ.get("FAKE_BRIDGE_ACK_STATE") or "sent")))
elif args[0] == "publish":
    print(json.dumps({"url": "https://host.ts.net:18401/" + args[2] + "/", "metadataWarnings": []}))
elif args[0] == "share":
    print(json.dumps({"url": "https://x.trycloudflare.com/" + args[2] + "/", "created": True, "metadataWarnings": []}))
else:
    print(json.dumps({"ok": True}))
"""


PIN = (25.0712, 55.1401)


def trip(uuid, status, plate="K 48213", name="Imran Khan", car="Black Lexus ES", eta="4 mins", north_m=5000):
    """`uber rides status --json` shape; the car sits north_m metres due north of the pickup pin."""
    t = {
        "uuid": uuid, "status": status, "pickupEta": eta, "arrivalEta": "2026-10-19T10:30:00Z",
        "pin": "9731", "fare": "AED 65.89", "headline": "Meet at Banyan Tree Residences", "detail": "",
        "stops": [{"type": "Pickup", "title": "Banyan Tree Residences",
                   "location": {"latitude": PIN[0], "longitude": PIN[1]}},
                  {"type": "Dropoff", "title": "Dubai Mall", "location": {"latitude": 25.1972, "longitude": 55.2797}}],
        "route": "encoded-polyline",
    }
    if status not in ("Searching", "Dispatching", "Matching", "Requesting", "WaitingForDispatch"):
        t["driver"] = {"name": name, "rating": 4.9, "photo": "https://cdn.example/photo-secret.jpg"}
        t["vehicle"] = {"description": car, "plate": plate,
                        "location": {"latitude": PIN[0] + north_m / 111195, "longitude": PIN[1]}}
    return t


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.fake = self._exe("uber", FAKE_UBER)
        self.bridge = self._exe("bridge", FAKE_BRIDGE)
        self.enroll = self._exe("enroll", "#!/bin/sh\necho 'moni: preparing'\n")
        self.fixture = os.path.join(self.dir, "fixture.json")
        self.set_state(None, {})
        self.hints = os.path.join(self.dir, "hints")
        os.makedirs(self.hints)
        self.state = os.path.join(self.dir, "rides.json")
        self.cards = os.path.join(self.dir, "cards")
        self.journal = os.path.join(self.dir, "journal")
        self.blog = os.path.join(self.dir, "bridge.log")
        self.bstate = os.path.join(self.dir, "bridge-state")
        self.route("abdullah", "thread-1", 3)
        self.route("moni", "moni-thread", 1)
        self.route("omar", "omar-thread", 1)
        self.route("group-run_club", "group-thread", 1)
        self.env = dict(
            os.environ, UBER_BIN=self.fake, FAKE_UBER_STATE=self.fixture, RIDE_SHARE_STATE=self.state,
            RIDE_SHARE_HINTS=self.hints, RIDE_CARD_ROOT=self.cards, RIDE_CARD_JOURNAL=self.journal,
            RIDE_CARD_NO_IMAGE="1", RIDE_CARD_BRIDGE=self.bridge, FAKE_BRIDGE_LOG=self.blog,
            RIDE_CARD_ENROLL=self.enroll, WATCH_DIR=self.dir, RIDE_CARD_BRIDGE_STATE=self.bstate,
        )

    def route(self, chat, rid, generation):
        """A bridge chat store with its live route, laid out like ~/.config/spectrum-bridge."""
        d = self.bstate if chat == "abdullah" else os.path.join(self.bstate, "chats", chat)
        os.makedirs(d, exist_ok=True)
        con = sqlite3.connect(os.path.join(d, "state.sqlite"))
        con.execute("create table if not exists kv (key text primary key, value text not null)")
        con.execute("create table if not exists outbox (id text primary key, payload text not null, "
                    "state text not null, attempts integer not null default 0)")
        con.execute("insert or replace into kv values ('route', ?)", (json.dumps({"id": rid, "generation": generation}),))
        con.commit()
        con.close()

    def outbox(self, chat):
        d = self.bstate if chat == "abdullah" else os.path.join(self.bstate, "chats", chat)
        con = sqlite3.connect(os.path.join(d, "state.sqlite"))
        rows = con.execute("select id, state, attempts from outbox order by rowid").fetchall()
        con.close()
        return rows

    def kv(self, chat, key, value):
        d = self.bstate if chat == "abdullah" else os.path.join(self.bstate, "chats", chat)
        con = sqlite3.connect(os.path.join(d, "state.sqlite"))
        con.execute("insert or replace into kv values (?, ?)", (key, json.dumps(value)))
        con.commit()
        con.close()

    def ops(self, chat):
        return [row[0] for row in self.outbox(chat)]

    def journal_edit(self, who, **fields):
        path = os.path.join(self.journal, f"{A}.json")
        with open(path) as f:
            j = json.load(f)
        j["recipients"][who].update(fields)
        with open(path, "w") as f:
            json.dump(j, f)

    def rc(self):
        sys.path.insert(0, os.path.dirname(CARD))
        import ride_card
        return ride_card

    def set_op(self, chat, state, attempts=None):
        """Move every op in a chat's outbox, as the bridge would."""
        d = self.bstate if chat == "abdullah" else os.path.join(self.bstate, "chats", chat)
        con = sqlite3.connect(os.path.join(d, "state.sqlite"))
        con.execute("update outbox set state = ?, attempts = coalesce(?, attempts)", (state, attempts))
        con.commit()
        con.close()

    def _exe(self, name, body):
        p = os.path.join(self.dir, name)
        with open(p, "w") as f:
            f.write(body)
        os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)
        return p

    def set_state(self, trip, history):
        with open(self.fixture, "w") as f:
            json.dump({"trip": trip, "history": history}, f)

    def run_check(self, now, **extra):
        env = dict(self.env, RIDE_SHARE_NOW=str(now), **extra)
        p = subprocess.run([sys.executable, HELPER], capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        return [line for line in p.stdout.splitlines() if line.strip()]

    def card_cli(self, *args, ok=True, **extra):
        p = subprocess.run([sys.executable, CARD, *args], capture_output=True, text=True,
                           env=dict(self.env, **extra), timeout=60)
        if ok:
            self.assertEqual(p.returncode, 0, p.stderr + p.stdout)
        return p

    def card(self, uuid):
        with open(os.path.join(self.cards, f"ride-{uuid}", "data.json")) as f:
            return json.load(f)

    def page(self, uuid):
        with open(os.path.join(self.cards, f"ride-{uuid}", "index.html")) as f:
            return f.read()

    def bridge_calls(self):
        if not os.path.exists(self.blog):
            return []
        with open(self.blog) as f:
            return [json.loads(x) for x in f]

    def mark_sent(self, uuid):
        self.set_state(trip(uuid, "Accepted"), {})
        self.card_cli("send", "--trip", uuid, "--session", "thread-1@3")


class WatcherTest(Base):
    def test_lifecycle_one_card_ready_then_quiet_updates_and_dropoff(self):
        self.set_state(trip(A, "Searching"), {})
        self.assertEqual(self.run_check(0), [])
        self.assertEqual(self.card(A)["state"], "searching")
        self.set_state(trip(A, "Accepted"), {})
        self.assertEqual(self.run_check(30), [])
        out = self.run_check(90)
        self.assertEqual(len(out), 1, out)
        self.assertTrue(out[0].startswith(f"CARD_READY trip={A} rider=abdullah(assumed) missing=abdullah,moni"), out[0])
        v = self.card(A)["v"]
        self.assertEqual(self.run_check(120), [])
        self.assertEqual(self.card(A)["v"], v, "unchanged state must not bump the version")
        # the order Uber really uses: WaitingForPickup while the driver drives over, then ArrivingAtPickup
        for i, (st, north, want) in enumerate([("WaitingForPickup", 1500, "arriving"), ("ArrivingAtPickup", 300, "arriving"),
                                               ("ArrivingAtPickup", 20, "arrived"), ("OnTrip", 0, "ontrip")]):
            self.set_state(trip(A, st, eta="0 mins", north_m=north), {})
            self.assertEqual(self.run_check(150 + 30 * i), [])
            self.assertEqual(self.card(A)["state"], want, (st, north))
        self.assertGreater(self.card(A)["v"], v)
        self.set_state(None, {})
        self.assertEqual(self.run_check(300), [])
        self.assertEqual(self.card(A)["state"], "ontrip", "one empty poll keeps the live card")
        self.assertEqual(self.run_check(330), [])
        self.assertEqual(self.card(A)["state"], "unknown", "missing trip must not become completed")
        self.assertEqual(self.run_check(900), [])
        self.assertEqual(self.card(A)["state"], "unknown")
        self.set_state(None, {A: {"status": "COMPLETED"}})
        self.assertEqual(self.run_check(930), [])
        c = self.card(A)
        self.assertEqual((c["state"], c["terminal"], c["step"]), ("done", True, 4))
        self.assertEqual(self.run_check(960), [])
        with open(self.fixture + ".calls") as f:
            self.assertNotIn(f"trips get {A}", f.read().splitlines()[-1])

    def test_no_card_ready_when_already_sent_by_booking_flow(self):
        self.mark_sent(A)
        self.run_check(0)
        self.assertEqual(self.run_check(70), [])

    def test_card_ready_lists_only_missing_recipient(self):
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "thread-1@3", ok=False, FAKE_BRIDGE_FAIL="share")
        self.run_check(0)
        out = self.run_check(70)
        self.assertEqual(len(out), 1)
        self.assertIn("missing=moni", out[0])

    def test_quick_cancel_before_sharing_is_silent(self):
        self.set_state(trip(A, "Accepted"), {})
        self.assertEqual(self.run_check(0), [])
        self.set_state(None, {A: {"status": "CANCELED"}})
        self.assertEqual(self.run_check(30), [])
        self.assertEqual(self.run_check(400), [])
        self.assertEqual(self.card(A)["state"], "cancelled")

    def test_shared_cancel_prints_once_after_window(self):
        self.mark_sent(A)
        self.run_check(0)
        self.set_state(None, {A: {"status": "CANCELED"}})
        self.assertEqual(self.run_check(30), [])
        self.assertEqual(self.run_check(150), [])
        self.assertEqual(self.run_check(240), [f"CANCELED trip={A} rider=abdullah(assumed)"])
        self.assertEqual(self.run_check(270), [])

    def test_cancel_then_rebook_new_card_no_cancel_line(self):
        self.mark_sent(A)
        self.run_check(0)
        self.set_state(trip(B, "Searching"), {A: {"status": "CANCELED"}})
        self.assertEqual(self.run_check(30), [])
        self.set_state(trip(B, "Accepted", plate="J 11111"), {A: {"status": "CANCELED"}})
        self.assertEqual(self.run_check(60), [])
        out = self.run_check(120)
        self.assertEqual(len(out), 1, out)
        self.assertTrue(out[0].startswith(f"CARD_READY trip={B}"))
        self.assertEqual(self.run_check(400), [])
        self.assertEqual(self.card(A)["state"], "cancelled")
        self.assertEqual(self.card(B)["plate"], "J 11111")

    def test_late_cancel_history_after_rebook_card_ready_is_silent(self):
        self.mark_sent(A)
        self.run_check(0)
        self.set_state(trip(B, "Accepted", plate="J 1"), {})
        self.run_check(30)
        out = self.run_check(90)
        self.assertTrue(out and out[0].startswith(f"CARD_READY trip={B}"), out)
        self.set_state(trip(B, "Accepted", plate="J 1"), {A: {"status": "CANCELED"}})
        for t in (120, 200, 300, 400):
            self.assertEqual(self.run_check(t), [])

    def test_legacy_state_migrates_without_duplicate_events(self):
        legacy = {"trips": {A: {"first_seen": 0, "status": "OnTrip", "dest": "X", "last_seen": 0, "rider": "abdullah",
                                "rider_hinted": False, "booked_fired": 0, "driver_seen": 0}},
                  "active": A, "fail_since": None, "ending": {}, "pending_cancel": {}}
        with open(self.state, "w") as f:
            json.dump(legacy, f)
        self.set_state(trip(A, "OnTrip"), {})
        self.assertEqual(self.run_check(100), [], "already announced trip must not get CARD_READY")
        self.assertEqual(self.run_check(1000), [])
        self.set_state(None, {A: {"status": "CANCELED"}})
        self.run_check(1030)
        self.assertEqual(self.run_check(1300), [f"CANCELED trip={A} rider=abdullah(assumed)"])

    def test_card_ready_retries_once_if_still_missing(self):
        self.set_state(trip(A, "Accepted"), {})
        self.run_check(0)
        self.assertEqual(len(self.run_check(70)), 1)
        self.assertEqual(self.run_check(400), [])
        self.assertEqual(len(self.run_check(700)), 1)
        self.assertEqual(self.run_check(2000), [])

    def test_new_driver_note_survives_searching_gap(self):
        self.set_state(trip(A, "Accepted"), {})
        self.run_check(0)
        self.set_state(trip(A, "Searching"), {})
        self.run_check(30)
        self.set_state(trip(A, "Accepted", plate="Z 9", name="Omar"), {})
        self.run_check(60)
        c = self.card(A)
        self.assertEqual((c["plate"], c["note"]), ("Z 9", "New driver"))
        self.assertNotIn("last_plate", c)

    def test_malformed_uuid_leaves_cards_alone(self):
        self.set_state(trip(A, "OnTrip"), {})
        self.run_check(0)
        self.set_state(trip("not-a-uuid", "OnTrip"), {})
        self.run_check(30)
        self.run_check(60)
        self.assertEqual(self.card(A)["state"], "ontrip")

    def test_dest_with_quotes_is_quoted(self):
        t = trip(A, "Accepted")
        t["stops"][1]["title"] = 'The "Q" Bar'
        self.set_state(t, {})
        self.run_check(0)
        out = self.run_check(70)
        self.assertIn('dest="The \\"Q\\" Bar"', out[0])

    def test_failed_after_share_prints_failed(self):
        self.mark_sent(A)
        self.run_check(0)
        self.set_state(None, {A: {"status": "UNFULFILLED"}})
        self.assertEqual(self.run_check(30), [f"FAILED trip={A} rider=abdullah(assumed) result=UNFULFILLED"])
        self.assertEqual(self.card(A)["state"], "failed")

    def test_driver_replacement_clears_old_car(self):
        self.set_state(trip(A, "Accepted"), {})
        self.run_check(0)
        self.set_state(trip(A, "Searching"), {})
        self.run_check(30)
        c = self.card(A)
        self.assertEqual((c["state"], c["plate"], c["car"], c["driver"]), ("searching", None, None, None))
        self.set_state(trip(A, "Accepted", plate="Z 777", name="Omar", car="White Genesis G80"), {})
        self.run_check(60)
        c = self.card(A)
        self.assertEqual((c["plate"], c["driver"], c["car"]), ("Z 777", "Omar", "White Genesis G80"))
        self.assertNotIn("48213", self.page(A))

    def test_direct_driver_swap_marks_new_driver(self):
        self.set_state(trip(A, "ArrivingAtPickup"), {})
        self.run_check(0)
        self.set_state(trip(A, "ArrivingAtPickup", plate="Z 777", name="Omar", car=""), {})
        self.run_check(30)
        c = self.card(A)
        self.assertEqual((c["plate"], c["car"], c["note"]), ("Z 777", None, "New driver"))

    def test_unknown_gives_up_after_three_hours_without_completion(self):
        self.set_state(trip(A, "OnTrip"), {})
        self.run_check(0)
        self.set_state(None, {})
        self.run_check(30)
        self.run_check(60)
        self.run_check(30 + 3 * 3600)
        c = self.card(A)
        self.assertEqual((c["state"], c["terminal"]), ("unknown", True))
        self.assertNotEqual(c["step"], 4)

    def test_sensitive_fields_never_public(self):
        self.set_state(trip(A, "OnTrip"), {})
        self.run_check(0)
        blob = json.dumps(self.card(A)) + self.page(A)
        for bad in ("9731", "photo-secret", "25.0712", "55.1401", "AED 65.89", "Khan"):
            self.assertNotIn(bad, blob)

    def test_poll_log_keeps_raw_status_and_distance_not_coordinates(self):
        self.set_state(trip(A, "WaitingForPickup", eta="3 mins", north_m=900), {})
        self.run_check(0)
        self.set_state(trip(A, "ArrivingAtPickup", eta="0 mins", north_m=10), {})
        self.run_check(30)
        with open(os.path.join(self.dir, "polls.jsonl")) as f:
            raw = f.read()
        rows = [json.loads(x) for x in raw.splitlines()]
        self.assertEqual([(r["status"], r["eta"], r["dist_m"], r["card"]) for r in rows],
                         [("WaitingForPickup", "3 mins", 900, "arriving"), ("ArrivingAtPickup", "0 mins", 10, "arrived")])
        self.assertEqual(rows[0]["headline"], "Meet at Banyan Tree Residences")
        for bad in ("25.07", "55.14", "Khan", "9731"):
            self.assertNotIn(bad, raw)

    def test_poll_log_failure_never_stops_the_watcher(self):
        # a lone surrogate in Uber's text used to raise while logging, after the card but before state
        t = trip(A, "WaitingForPickup")
        t["headline"] = "Meet at \ud800 Banyan"
        self.set_state(t, {})
        self.run_check(0)
        self.assertEqual(self.run_check(90)[0].split()[:2], ["CARD_READY", f"trip={A}"])
        with open(os.path.join(self.dir, "polls.jsonl")) as f:
            self.assertEqual(json.loads(f.readline())["status"], "WaitingForPickup")
        os.remove(os.path.join(self.dir, "polls.jsonl"))
        os.mkdir(os.path.join(self.dir, "polls.jsonl"))
        self.set_state(trip(B, "Accepted"), {})
        self.run_check(120)
        self.assertEqual(self.run_check(180)[0].split()[:2], ["CARD_READY", f"trip={B}"])

    def test_scratch_watch_dir_writes_cards_inside_watch_dir(self):
        env = {k: v for k, v in self.env.items() if k not in ("RIDE_CARD_ROOT", "RIDE_CARD_JOURNAL")}
        self.set_state(trip(A, "Accepted"), {})
        p = subprocess.run([sys.executable, HELPER], capture_output=True, text=True,
                           env=dict(env, RIDE_SHARE_NOW="0"), timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertTrue(os.path.exists(os.path.join(self.dir, "cards", f"ride-{A}", "data.json")))
        self.assertTrue(os.path.exists(os.path.join(self.dir, "journal", f".{A}.lock")))
        self.assertEqual(self.bridge_calls(), [], "the check must never call the bridge")

    def test_check_never_calls_bridge(self):
        self.set_state(trip(A, "Accepted"), {})
        for t in (0, 30, 90, 120):
            self.run_check(t)
        self.assertEqual(self.bridge_calls(), [])

    def test_rider_hint_moni(self):
        with open(os.path.join(self.hints, f"rider-{A}"), "w") as f:
            f.write("moni\n")
        self.set_state(trip(A, "Accepted"), {})
        self.run_check(0)
        self.assertIn("rider=moni ", self.run_check(70)[0])
        self.assertEqual(self.card(A)["rider"], "Moni")
        self.assertIn("Moni&#x27;s ride", self.page(A))


FAKE_PREVIEW = """
import os
def render_html(doc, out, width=1200, height=630):
    flag = os.environ["FAKE_PREVIEW_FAIL"]
    if os.path.exists(flag):
        os.unlink(flag)
        raise RuntimeError("chrome hiccup")
    with open(out, "wb") as f:
        f.write(b"png")
    with open(os.environ["FAKE_PREVIEW_LOG"], "a") as f:
        f.write("render\\n")
"""


class ArrivalTest(unittest.TestCase):
    """Arrived needs Uber's ArrivingAtPickup plus the car at the pickup pin (recorded trips, Oct 2026)."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, os.path.dirname(CARD))
        import ride_card
        cls.rc = ride_card

    def live(self, *polls):
        c = None
        for st, eta, north in polls:
            c = self.rc.from_live(trip(A, st, eta=eta, north_m=north), c, "abdullah", "abdullah", 0)
        return c

    def test_waiting_for_pickup_is_on_the_way_even_near_the_pin(self):
        # 22 Oct: the card said Arrived at booking while the driver was ~5 min out
        for north in (5000, 40, 0):
            c = self.live(("WaitingForPickup", "5 mins", north))
            self.assertEqual((c["state"], c["step"]), ("arriving", 1), north)
            self.assertEqual(self.rc.texts(c)["big"], "5 mins")

    def test_arriving_at_pickup_far_from_pin_is_not_arrived(self):
        # 14 Oct trip 034e1320: ArrivingAtPickup "0 mins" for minutes while still driving in
        c = self.live(("WaitingForPickup", "2 mins", 900), ("ArrivingAtPickup", "0 mins", 400))
        self.assertEqual(c["state"], "arriving")
        t = self.rc.texts(c)
        self.assertEqual((t["big"], t["kick"]), ("Nearly there", ""))
        self.assertNotIn("rriv", t["og_title"].split("·")[-1])

    def test_arrived_at_the_pin_and_holds_through_gps_jitter(self):
        c = self.live(("ArrivingAtPickup", "0 mins", 60))
        self.assertEqual((c["state"], c["step"]), ("arrived", 2))
        self.assertEqual(self.rc.texts(c)["big"], "Arrived")
        c = self.rc.from_live(trip(A, "ArrivingAtPickup", eta="0 mins", north_m=180), c, "abdullah", "abdullah", 30)
        self.assertEqual(c["state"], "arrived", "a jitter past 100 m keeps Arrived")
        c = self.rc.from_live(trip(A, "ArrivingAtPickup", eta="1 min", north_m=600), c, "abdullah", "abdullah", 60)
        self.assertEqual(c["state"], "arriving", "a car clearly elsewhere drops back")

    def test_replacement_driver_must_reach_the_pin_itself(self):
        c = self.live(("ArrivingAtPickup", "0 mins", 30))
        self.assertEqual(c["state"], "arrived")
        swap = lambda north, now: self.rc.from_live(
            trip(A, "ArrivingAtPickup", plate="Z 777", name="Omar", eta="1 min", north_m=north), c, "abdullah", "abdullah", now)
        c = swap(180, 30)
        self.assertEqual((c["state"], c["note"]), ("arriving", "New driver"))
        c = swap(60, 60)
        self.assertEqual((c["state"], c["since"]), ("arrived", self.rc.iso(60)))

    def test_hold_needs_a_known_plate(self):
        t = lambda north, name: trip(A, "ArrivingAtPickup", plate=None, name=name, eta="0 mins", north_m=north)
        c = self.rc.from_live(t(30, "Imran"), None, "abdullah", "abdullah", 0)
        self.assertEqual(c["state"], "arrived")
        c = self.rc.from_live(t(180, "Omar"), c, "abdullah", "abdullah", 30)
        self.assertEqual(c["state"], "arriving")

    def test_hold_survives_plate_formatting(self):
        c = self.live(("ArrivingAtPickup", "0 mins", 30))
        self.assertEqual(c["state"], "arrived")
        for plate in ("K48213", "k 48213", "K-48213"):
            t = trip(A, "ArrivingAtPickup", plate=plate, eta="0 mins", north_m=180)
            n = self.rc.from_live(t, c, "abdullah", "abdullah", 30)
            self.assertEqual((n["state"], n["note"]), ("arrived", None), plate)

    def test_plates_in_any_script_keep_their_letters(self):
        t = trip(A, "ArrivingAtPickup", plate="أ 12345", eta="0 mins", north_m=30)
        c = self.rc.from_live(t, None, "abdullah", "abdullah", 0)
        self.assertEqual(c["state"], "arrived")
        held = self.rc.from_live(trip(A, "ArrivingAtPickup", plate="أ-12345", eta="0 mins", north_m=180),
                                 c, "abdullah", "abdullah", 30)
        self.assertEqual((held["state"], held["note"]), ("arrived", None))
        swap = self.rc.from_live(trip(A, "ArrivingAtPickup", plate="ب 12345", eta="0 mins", north_m=180),
                                 c, "abdullah", "abdullah", 30)
        self.assertEqual((swap["state"], swap["note"]), ("arriving", "New driver"))
        self.assertEqual(self.rc.plate_key("دبي ١٢٣٤٥"), self.rc.plate_key("دبي 12345"))

    def test_no_location_never_shows_arrived(self):
        t = trip(A, "ArrivingAtPickup", eta="0 mins", north_m=0)
        t["vehicle"]["location"] = None
        self.assertEqual(self.rc.from_live(t, None, "abdullah", "abdullah", 0)["state"], "arriving")
        t = trip(A, "ArrivingAtPickup", eta="0 mins", north_m=0)
        t["stops"][0]["location"] = None
        self.assertEqual(self.rc.from_live(t, None, "abdullah", "abdullah", 0)["state"], "arriving")
        t = trip(A, "ArrivingAtPickup", eta="0 mins", north_m=0)
        t["vehicle"]["location"] = {"latitude": 0, "longitude": 0}
        self.assertIsNone(self.rc.pickup_distance(t))

    def test_distance_reads_both_coordinate_shapes(self):
        t = trip(A, "ArrivingAtPickup", north_m=250)
        self.assertEqual(self.rc.pickup_distance(t), 250)
        t["vehicle"]["location"] = {"lat": PIN[0], "lng": PIN[1] + 0.001}
        self.assertAlmostEqual(self.rc.pickup_distance(t), 101, delta=2)

    def test_sample_states_follow_real_uber_order(self):
        got = [(n, c["state"]) for n, c in self.rc.sample_states()][:6]
        self.assertEqual(got, [("Searching", "searching"), ("Accepted", "assigned"), ("WaitingForPickup", "arriving"),
                               ("Nearby", "arriving"), ("AtPickup", "arrived"), ("OnTrip", "ontrip")])


class RecipientTest(Base):
    def meta(self, *args, ok=True):
        return self.card_cli("meta", "--trip", A, *args, ok=ok)

    def test_extras_deduped_and_each_non_owner_gets_public_url(self):
        p = self.meta("--rider", "sara-k", "--rider-name", "Sara", "--recipient", "moni",
                      "--recipient", "omar", "--recipient", "sara-k", "--recipient", "omar")
        self.assertEqual(json.loads(p.stdout)["recipients"], ["abdullah", "moni", "sara-k", "omar"])
        self.route("sara-k", "sara-thread", 1)
        self.set_state(trip(A, "Accepted"), {})
        res = json.loads(self.card_cli("send", "--trip", A, "--session", "thread-1@3").stdout)
        self.assertEqual(res, {"abdullah": "sent", "moni": "sent", "sara-k": "sent", "omar": "sent"})
        calls = self.bridge_calls()
        self.assertEqual([c[0] for c in calls].count("publish"), 1)
        for c in calls:
            if c[0] in ("send", "app"):
                to = c[c.index("--to") + 1] if "--to" in c else None
                body = " ".join(c)
                if to == "owner":
                    self.assertIn("ts.net", body)
                else:
                    self.assertNotIn("ts.net", body)
                    self.assertIn("trycloudflare.com", body)
        texts = {c[c.index("--to") + 1]: c[c.index("--text") + 1] for c in calls if c[0] == "send"}
        self.assertEqual(set(texts), {"moni", "sara-k", "omar"})
        self.assertTrue(texts["sara-k"].startswith("Your ride"))
        self.assertTrue(texts["omar"].startswith("Sara's ride"))
        app = [c for c in calls if c[0] == "app"][0]
        self.assertEqual(app[app.index("--caption") + 1], "Sara's ride")
        self.route("abdullah", "thread-1", 4)
        again = json.loads(self.card_cli("send", "--trip", A, "--session", "thread-1@4").stdout)
        self.assertEqual(set(again.values()), {"already sent"})

    def test_recipient_metadata_private_and_not_in_public_files(self):
        self.meta("--rider", "sara-k", "--rider-name", "Sara", "--recipient", "group-run-club-abc123")
        self.set_state(trip(A, "OnTrip"), {})
        self.run_check(0)
        blob = json.dumps(self.card(A)) + self.page(A)
        self.assertIn("Sara", blob)
        for bad in ("sara-k", "group-run-club", "abdullah\"", "moni\""):
            self.assertNotIn(bad, blob)
        meta = os.path.join(self.journal, f"{A}.meta.json")
        self.assertEqual(oct(os.stat(meta).st_mode & 0o777), "0o600")
        self.assertFalse(any(f.endswith("meta.json") for f in os.listdir(os.path.join(self.cards, f"ride-{A}"))))

    def test_unnamed_extra_rider_shows_no_slug(self):
        self.meta("--rider", "lina-2")
        self.set_state(trip(A, "Accepted"), {})
        self.run_check(0)
        c, page = self.card(A), self.page(A)
        self.assertIsNone(c["rider"])
        self.assertNotIn("lina", page)
        self.assertIn("The Uber", page)

    def test_invalid_recipient_and_names_rejected(self):
        for args in (["--rider", "moni", "--recipient", "Bad Slug!"],
                     ["--rider", "+971501234567"],
                     ["--rider", "sara-k", "--rider-name", "+971 50 123 4567"],
                     ["--rider", "sara-k", "--rider-name", "<b>x</b>"]):
            p = self.meta(*args, ok=False)
            self.assertNotEqual(p.returncode, 0, args)
        self.assertFalse(os.path.exists(os.path.join(self.journal, f"{A}.meta.json")))

    def test_watcher_missing_lists_extras(self):
        self.meta("--rider", "moni", "--recipient", "omar")
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "moni-thread@1", "--from-chat", "moni")
        self.run_check(0)
        out = self.run_check(70)
        self.assertIn("missing=abdullah,omar", out[0])

    def test_non_owner_chat_reaches_only_itself(self):
        self.meta("--rider", "omar", "--rider-name", "Omar")
        self.set_state(trip(A, "Accepted"), {})
        res = json.loads(self.card_cli("send", "--trip", A, "--session", "omar-thread@1", "--from-chat", "omar").stdout)
        self.assertEqual(res, {"omar": "sent"})
        self.assertTrue(all("--to" not in c for c in self.bridge_calls()))
        p = self.card_cli("send", "--trip", A, "--session", "x-thread@1", "--from-chat", "stranger", ok=False)
        self.assertIn("not the live session of any chat", p.stderr)

    def test_non_moni_recipient_gets_link_even_when_cards_installed(self):
        installed = self._exe("enroll-ok", "#!/bin/sh\necho 'moni: installed'\n")
        self.meta("--rider", "omar", "--rider-name", "Omar")
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "thread-1@3", RIDE_CARD_ENROLL=installed)
        calls = self.bridge_calls()
        moni = [c for c in calls if "--to" in c and c[c.index("--to") + 1] == "moni"][0]
        omar = [c for c in calls if "--to" in c and c[c.index("--to") + 1] == "omar"][0]
        self.assertEqual(moni[0], "app", "Moni keeps her Robob Cards readiness")
        self.assertEqual(omar[0], "send", "other people get a plain public link")

    def test_display_name_with_digits_rejected(self):
        p = self.meta("--rider", "sara-k", "--rider-name", "Al 50 12 34", ok=False)
        self.assertNotEqual(p.returncode, 0)

    def test_adding_extras_later_keeps_rider_booker_and_earlier_extras(self):
        self.meta("--rider", "moni", "--booker", "moni", "--recipient", "omar")
        p = self.meta("--rider", "moni", "--recipient", "lina")
        self.assertEqual(json.loads(p.stdout)["booker"], "moni")
        self.assertEqual(json.loads(p.stdout)["recipients"], ["abdullah", "moni", "omar", "lina"])


class PreviewRetryTest(Base):
    def test_failed_preview_retried_next_check_without_version_bump(self):
        lib = os.path.join(self.dir, "plib")
        os.makedirs(lib)
        with open(os.path.join(lib, "cardpreview.py"), "w") as f:
            f.write(FAKE_PREVIEW)
        flag = os.path.join(self.dir, "fail-once")
        open(flag, "w").close()
        log = os.path.join(self.dir, "renders")
        env = dict(RIDE_CARD_NO_IMAGE="0", RIDE_CARD_PREVIEW_LIB=lib, FAKE_PREVIEW_FAIL=flag, FAKE_PREVIEW_LOG=log)
        png = os.path.join(self.cards, f"ride-{A}", "preview.png")
        self.set_state(trip(A, "Accepted"), {})
        self.run_check(0, **env)
        self.assertFalse(os.path.exists(png))
        v = self.card(A)["v"]
        self.run_check(30, **env)
        self.assertTrue(os.path.exists(png), "preview retried on the next check")
        self.assertEqual(self.card(A)["v"], v, "a preview retry must not bump the version")
        self.run_check(60, **env)
        with open(log) as f:
            self.assertEqual(f.read().count("render"), 1, "no re-render once the preview is current")
        self.assertFalse([x for x in os.listdir(os.path.dirname(png)) if x.startswith(".preview-")])

    def test_terminal_card_preview_retried_by_watcher(self):
        lib = os.path.join(self.dir, "plib")
        os.makedirs(lib)
        with open(os.path.join(lib, "cardpreview.py"), "w") as f:
            f.write(FAKE_PREVIEW)
        flag = os.path.join(self.dir, "fail-once")
        log = os.path.join(self.dir, "renders")
        env = dict(RIDE_CARD_NO_IMAGE="0", RIDE_CARD_PREVIEW_LIB=lib, FAKE_PREVIEW_FAIL=flag, FAKE_PREVIEW_LOG=log)
        self.set_state(trip(A, "OnTrip"), {})
        self.run_check(0, **env)
        self.set_state(None, {A: {"status": "COMPLETED"}})
        open(flag, "w").close()
        self.run_check(30, **env)  # terminal transition, preview render fails
        c = self.card(A)
        self.assertEqual(c["state"], "done")
        self.set_state(None, {})
        self.run_check(60, **env)  # watcher retries the frozen card's preview
        self.assertEqual(self.card(A)["v"], c["v"])
        self.run_check(90, **env)
        with open(log) as f:
            self.assertEqual(f.read().count("render"), 2, "initial + one retry, then nothing")
        with open(self.state) as f:
            self.assertEqual(json.load(f)["preview_retry"], {})


class SendTest(Base):
    def test_send_publishes_and_shares_once_with_stable_keys(self):
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3")
        self.assertEqual(json.loads(p.stdout), {"abdullah": "sent", "moni": "sent"})
        calls = self.bridge_calls()
        self.assertEqual([c[0] for c in calls], ["publish", "app", "share", "send"])
        app = calls[1]
        self.assertIn(f"uber:{A}:card:abdullah", app)
        self.assertEqual(app[app.index("--to") + 1], "owner", "the owner's card rides --to, which no rotation cancels")
        self.assertEqual(app[app.index("--caption") + 1], "Your ride")
        moni = calls[3]
        self.assertEqual(moni[moni.index("--to") + 1], "moni")
        self.assertIn(f"uber:{A}:card:moni", moni)
        self.assertIn("trycloudflare.com", moni[moni.index("--text") + 1])
        self.assertNotIn("ts.net", " ".join(moni))
        self.route("abdullah", "thread-1", 4)  # the owner route moved on; the old marker is stale now
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", ok=False)
        self.assertIn("not the live session", p.stderr)
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@4")
        self.assertEqual(json.loads(p.stdout), {"abdullah": "already sent", "moni": "already sent"})
        self.assertEqual(len(self.bridge_calls()), 4)

    def test_retry_after_failure_reuses_frozen_payload_and_key(self):
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", ok=False, FAKE_BRIDGE_FAIL="app")
        self.assertEqual(p.returncode, 1)
        first = [c for c in self.bridge_calls() if c[0] == "app"][0]
        self.set_state(trip(A, "OnTrip"), {})
        self.card_cli("refresh", "--trip", A)
        self.card_cli("send", "--trip", A, "--session", "thread-1@3")
        apps = [c for c in self.bridge_calls() if c[0] == "app"]
        self.assertEqual(len(apps), 2)
        self.assertEqual(apps[0], apps[1], "retry must send the identical payload under the same key")
        self.assertEqual([c[0] for c in self.bridge_calls()].count("publish"), 1)
        self.assertNotIn("?v=", json.dumps(apps))

    def test_card_mode_for_moni_uses_app_to(self):
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--moni-mode", "card")
        moni = [c for c in self.bridge_calls() if c[0] == "app" and c[c.index("--to") + 1] == "moni"][0]
        self.assertEqual(moni[moni.index("--caption") + 1], "Abdullah's ride")
        self.assertTrue(moni[moni.index("--url") + 1].startswith("https://x.trycloudflare.com/"))

    def test_from_moni_chat_only_sends_to_moni(self):
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "moni-thread@1", "--from-chat", "moni")
        calls = self.bridge_calls()
        self.assertEqual([c[0] for c in calls], ["share", "send"])
        self.assertNotIn("--to", calls[1])

    def tree(self):
        snap = {}
        for top in (self.cards, self.journal):
            for d, _, files in os.walk(top):
                for f in files:
                    path = os.path.join(d, f)
                    with open(path, "rb") as fh:
                        snap[path] = (fh.read(), os.stat(path).st_mtime_ns)
        return snap

    def share_log(self):
        p = os.path.join(self.journal, f"{A}.json")
        if not os.path.exists(p):
            return None
        with open(p) as f:
            return json.load(f)

    def test_group_from_owner_session_gets_one_public_link_and_joins_the_ride(self):
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "sent"})
        calls = self.bridge_calls()
        self.assertEqual([c[0] for c in calls], ["share", "send"], "a group gets a link, never an app card")
        send = calls[1]
        self.assertEqual(send[send.index("--to") + 1], "group-run_club")
        self.assertEqual(send[send.index("--session") + 1], "thread-1@3")
        self.assertIn(f"uber:{A}:card:group-run_club", send)
        self.assertIn("trycloudflare.com", send[send.index("--text") + 1])
        self.assertTrue(send[send.index("--text") + 1].startswith("Abdullah's ride"))
        meta = json.loads(self.card_cli("show", "--trip", A).stdout)
        self.assertEqual(meta["recipients"], ["abdullah", "moni", "group-run_club"])
        # A later full send skips the group and still reaches the others once.
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3")
        self.assertEqual(json.loads(p.stdout), {"abdullah": "sent", "moni": "sent", "group-run_club": "already sent"})
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "already sent"})
        self.assertEqual(len([c for c in self.bridge_calls() if c[0] == "send" and "group-run_club" in c]), 1)

    def test_group_own_session_reaches_itself_without_meta(self):
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "group-thread@1")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "sent"})
        calls = self.bridge_calls()
        self.assertEqual([c[0] for c in calls], ["share", "send"])
        self.assertNotIn("--to", calls[1])
        self.assertIn(f"uber:{A}:card:group-run_club", calls[1])
        p = self.card_cli("send", "--trip", A, "--session", "group-thread@1", "--chat", "group-run_club")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "already sent"})

    def test_stale_session_refused_before_anything_is_written(self):
        self.set_state(trip(A, "Accepted"), {})
        self.route("group-run_club", "group-thread-2", 1)  # the group moved to a new thread overnight
        p = self.card_cli("send", "--trip", A, "--session", "group-thread@1", ok=False)
        self.assertEqual(p.returncode, 1)
        self.assertIn("not the live session of any chat", p.stderr)
        self.assertIn("--chat SLUG", p.stderr)
        self.assertEqual(self.bridge_calls(), [])
        self.assertIsNone(self.share_log())
        # The owner thread, which every watcher wake lands in, sends with its current session.
        p = self.card_cli("send", "--trip", A, "--session", "thread-1", "--chat", "group-run_club")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "sent"})

    def test_non_owner_session_cannot_name_another_chat(self):
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "moni-thread@1", "--chat", "group-run_club", ok=False)
        self.assertIn("only the owner's chat can send to other chats", p.stderr)
        p = self.card_cli("send", "--trip", A, "--session", "moni-thread@1", "--from-chat", "group-run_club", ok=False)
        self.assertIn("this session is in chat 'moni'", p.stderr)
        self.assertEqual(self.bridge_calls(), [])
        self.assertIsNone(self.share_log())

    def test_unknown_chat_refused(self):
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-nobody", ok=False)
        self.assertIn("no bridge chat 'group-nobody'", p.stderr)
        self.assertEqual(self.bridge_calls(), [])

    def test_dry_run_writes_nothing_and_shows_routes(self):
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club", "--dry-run")
        out = json.loads(p.stdout)
        self.assertEqual(out["group-run_club"], "would publish+send link --to group-run_club")
        self.assertIn("no card yet", out["note"])
        self.assertEqual(self.bridge_calls(), [])
        # No card yet: nothing is built, locked or read from Uber.
        self.assertFalse(os.path.exists(self.cards))
        self.assertFalse(os.path.exists(self.journal))
        self.assertFalse(os.path.exists(self.fixture + ".calls"))
        self.mark_sent(A)
        before = self.share_log()
        end = ("import sys, time; sys.path.insert(0, sys.argv[1]); import ride_card as rc; "
               "rc.write_card(rc.to_terminal(rc.load_card(sys.argv[2]), 'COMPLETED', time.time()), force=True)")
        subprocess.run([sys.executable, "-c", end, os.path.dirname(CARD), A], env=self.env, check=True, timeout=60)
        self.assertTrue(self.card(A)["terminal"])
        before = self.tree()
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club", "--dry-run")
        out = json.loads(p.stdout)
        self.assertIn("a real send would be refused", out["note"])
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--dry-run")
        self.assertEqual(json.loads(p.stdout)["abdullah"], "already sent")
        self.assertEqual(self.tree(), before, "a dry run leaves the card and the journal byte for byte")
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club", ok=False)
        self.assertIn("already ended", p.stderr)

    def sends(self):
        return [c for c in self.bridge_calls() if c[0] in ("send", "app")]

    def test_accepted_but_unacked_send_is_not_resent_by_any_route(self):
        # The group's own session queues the link, the reply is lost, then the group's route rotates
        # (its own retry now gets 409). The owner retrying over --to must not post a second link.
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "group-thread@1", ok=False, FAKE_BRIDGE_FAIL="send",
                          FAKE_BRIDGE_QUEUED="pending", FAKE_BRIDGE_ERR='{"error":"Bridge request timed out"}')
        self.assertEqual(p.returncode, 1)
        self.set_op("group-run_club", "sent", attempts=1)
        self.route("group-run_club", "group-thread-2", 1)
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "already queued (bridge: sent)"})
        self.assertEqual(len(self.sends()), 1)
        self.assertEqual(self.share_log()["recipients"]["group-run_club"]["status"], "sent")

    def test_attempt_is_on_disk_before_the_bridge_call(self):
        self.set_state(trip(A, "Accepted"), {})
        peek = os.path.join(self.journal, f"{A}.json")
        self.card_cli("send", "--trip", A, "--session", "group-thread@1", FAKE_BRIDGE_PEEK=peek)
        with open(peek + ".seen") as f:
            seen = json.loads(f.read().strip())["recipients"]["group-run_club"]
        self.assertEqual((seen["status"], seen["via"], seen["attempts"]), ("attempting", "self", 1))
        self.assertEqual(seen["keys"], [f"uber:{A}:card:group-run_club"])

    def test_queued_op_after_a_cut_process_counts_as_sent(self):
        # Killed between the bridge accepting the op and the journal update: the next run reads the outbox.
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club", ok=False,
                      FAKE_BRIDGE_FAIL="send", FAKE_BRIDGE_QUEUED="pending")
        p = self.card_cli("send", "--trip", A, "--session", "group-thread@1")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "already queued (bridge: pending)"})
        self.assertEqual(len(self.sends()), 1)

    def test_maybe_delivered_op_is_never_resent(self):
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "group-thread@1", ok=False, FAKE_BRIDGE_FAIL="send",
                      FAKE_BRIDGE_QUEUED="pending")
        for state, attempts in (("uncertain", 1), ("cancelled", 1)):
            self.set_op("group-run_club", state, attempts=attempts)
            p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club", ok=False)
            self.assertEqual(p.returncode, 1)
            self.assertIn("may have reached group-run_club", p.stdout)
        self.assertEqual(len(self.sends()), 1)

    def test_rotation_before_any_attempt_retries_under_a_fresh_key(self):
        # The group's session-bound op was cancelled by a rotation before the bridge tried it:
        # nothing went out, and the same key would be a silent no-op, so the retry gets a new one.
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "group-thread@1", ok=False, FAKE_BRIDGE_FAIL="send",
                      FAKE_BRIDGE_QUEUED="pending")
        self.route("group-run_club", "group-thread-2", 1)
        p = self.card_cli("send", "--trip", A, "--session", "group-thread-2@1")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "sent"})
        first, second = self.sends()
        self.assertEqual(first[first.index("--key") + 1], f"uber:{A}:card:group-run_club")
        self.assertEqual(second[second.index("--key") + 1], f"uber:{A}:card:group-run_club:2")
        self.assertEqual(first[first.index("--text") + 1], second[second.index("--text") + 1])
        r = self.share_log()["recipients"]["group-run_club"]
        self.assertEqual(r["keys"], [f"uber:{A}:card:group-run_club", f"uber:{A}:card:group-run_club:2"])
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "already sent"})

    def test_refused_attempt_can_switch_route(self):
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "group-thread@1", ok=False, FAKE_BRIDGE_FAIL="send",
                          FAKE_BRIDGE_ERR='{"error":"Bridge request failed (HTTP 409)"}')
        self.assertEqual(p.returncode, 1)
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "sent"})
        first, second = self.sends()
        self.assertEqual(first[first.index("--key") + 1], second[second.index("--key") + 1])
        self.assertEqual(first[first.index("--text") + 1], second[second.index("--text") + 1])
        self.assertEqual(second[second.index("--to") + 1], "group-run_club")
        self.assertEqual(len(self.outbox("group-run_club")), 1)

    def test_owner_card_survives_owner_route_rotation(self):
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "thread-1@3", ok=False, FAKE_BRIDGE_FAIL="app",
                      FAKE_BRIDGE_QUEUED="pending", FAKE_BRIDGE_ERR='{"error":"Bridge request timed out"}')
        self.route("abdullah", "thread-1", 4)
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@4")
        self.assertEqual(json.loads(p.stdout), {"abdullah": "already queued (bridge: pending)", "moni": "already sent"})
        self.assertEqual([c[0] for c in self.sends()], ["app", "send"])

    def test_unreadable_outbox_after_an_attempt_refuses(self):
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "group-thread@1", ok=False, FAKE_BRIDGE_FAIL="send")
        os.unlink(os.path.join(self.bstate, "chats", "group-run_club", "state.sqlite"))
        self.route("group-run_club", "group-thread", 1)
        con = sqlite3.connect(os.path.join(self.bstate, "chats", "group-run_club", "state.sqlite"))
        con.execute("drop table outbox")
        con.commit()
        con.close()
        p = self.card_cli("send", "--trip", A, "--session", "group-thread@1", ok=False)
        self.assertIn("can't read the bridge outbox", p.stdout)
        self.assertEqual(len(self.sends()), 1)

    def test_outbox_reads_ops_and_route_in_one_snapshot(self):
        # The bridge sends the op and rotates the route between two reads: a pending self op read
        # against the new route would look cancelled-before-send, and the retry would post twice.
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "group-thread@1", ok=False, FAKE_BRIDGE_FAIL="send",
                      FAKE_BRIDGE_QUEUED="pending", FAKE_BRIDGE_ERR='{"error":"Bridge request timed out"}')
        rc, db = self.rc(), os.path.join(self.bstate, "chats", "group-run_club", "state.sqlite")
        real = rc.sqlite3.connect

        class Racing:
            def __init__(self, con):
                self.con = con

            def execute(self, *a):
                cur = self.con.execute(*a)
                rows = cur.fetchall()
                w = real(db)  # the bridge moves on right after the first statement
                w.execute("update outbox set state = 'sent', attempts = 1")
                w.execute("update kv set value = ? where key = 'route'",
                          (json.dumps({"id": "group-thread-2", "generation": 1}),))
                w.commit()
                w.close()
                return Fixed(rows)

            def close(self):
                self.con.close()

        class Fixed:
            def __init__(self, rows):
                self.rows = rows

            def fetchall(self):
                return self.rows

            def fetchone(self):
                return self.rows[0] if self.rows else None

        env = {"RIDE_CARD_BRIDGE_STATE": self.bstate, "RIDE_CARD_JOURNAL": self.journal}
        with unittest.mock.patch.dict(os.environ, env), \
                unittest.mock.patch.object(rc.sqlite3, "connect", lambda *a, **k: Racing(real(*a, **k))):
            with open(os.path.join(self.journal, f"{A}.json")) as f:
                r = json.load(f)["recipients"]["group-run_club"]
            outcome, _ = rc.standing(A, "group-run_club", r, "to")
            self.assertEqual(outcome, ("sent", "already queued (bridge: pending)"))

    def test_failed_owner_card_waits_while_the_telegram_fallback_may_send_it(self):
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "thread-1@3", ok=False, FAKE_BRIDGE_FAIL="app",
                      FAKE_BRIDGE_QUEUED="failed", FAKE_BRIDGE_ERR='{"error":"Bridge request timed out"}')
        (oid,) = [o for o in self.ops("abdullah") if o.startswith("app:")]
        self.kv("abdullah", f"firstAttempt:{oid}", int(time.time() * 1000) - 60_000)
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", ok=False)
        self.assertIn("may have reached abdullah (bridge: failed)", p.stdout)
        # Past the bridge's 24h window, an unmarked fallback still proves nothing.
        self.kv("abdullah", f"firstAttempt:{oid}", int(time.time() * 1000) - 25 * 3600 * 1000)
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", ok=False)
        self.assertIn("may have reached abdullah (bridge: failed)", p.stdout)
        self.kv("abdullah", f"fallback:{oid}", {"skipped": 1})  # the fallback gave up on it
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3")
        self.assertEqual(json.loads(p.stdout)["abdullah"], "sent")
        first, second = [c for c in self.sends() if c[0] == "app"]
        self.assertEqual(second[second.index("--key") + 1], f"uber:{A}:card:abdullah:2")

    def test_cut_attempt_with_no_op_is_only_retried_the_same_way(self):
        # The group's own request died without a reply and left nothing in the outbox yet; it can
        # still land, so the owner's --to route (another op id) must not race it.
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "group-thread@1", ok=False, FAKE_BRIDGE_FAIL="send",
                      FAKE_BRIDGE_ERR='{"error":"Bridge request timed out"}')
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club", ok=False)
        self.assertIn("may still land", p.stdout)
        self.assertEqual(len(self.sends()), 1)
        p = self.card_cli("send", "--trip", A, "--session", "group-thread@1")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "sent"})
        first, second = self.sends()
        self.assertEqual(first[first.index("--key") + 1], second[second.index("--key") + 1])
        self.assertNotIn("--to", second)
        self.assertEqual(len(self.outbox("group-run_club")), 1)

    def test_cut_attempt_settles_only_when_its_route_moves_on(self):
        # Time alone proves nothing: a held request can still be queued long after the CLI gave up.
        # Once the chat's live route has another session, the bridge refuses that old request.
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "group-thread@1", ok=False, FAKE_BRIDGE_FAIL="send",
                      FAKE_BRIDGE_ERR='{"error":"Bridge request timed out"}')
        self.journal_edit("group-run_club", attempted_at="2026-01-01T00:00:00Z")
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club", ok=False)
        self.assertIn("may still land", p.stdout)
        self.route("group-run_club", "group-thread", 2)
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "sent"})
        self.assertEqual(self.sends()[-1][self.sends()[-1].index("--to") + 1], "group-run_club")
        self.assertEqual(len(self.sends()), 2)

    def test_later_refusal_keeps_an_earlier_unanswered_attempt_open(self):
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "group-thread@1", ok=False, FAKE_BRIDGE_FAIL="send",
                      FAKE_BRIDGE_ERR='{"error":"Bridge request timed out"}')
        p = self.card_cli("send", "--trip", A, "--session", "group-thread@1", ok=False, FAKE_BRIDGE_FAIL="send",
                          FAKE_BRIDGE_ERR='{"error":"Bridge request failed (HTTP 503): Bridge is not ready"}')
        self.assertIn("503", p.stdout)
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club", ok=False)
        self.assertIn("may still land", p.stdout)
        self.assertEqual(len(self.sends()), 2)
        self.assertEqual(len(self.share_log()["recipients"]["group-run_club"]["open"]), 1)

    def test_owner_route_fallback_reconciles_the_owner_chats_own_queue(self):
        # An older bridge refuses `--to owner`. The owner's own route already holds a dead op under
        # this key (cancelled by a rotation), and re-sending it would only get created:false.
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "abdullah", ok=False,
                          FAKE_BRIDGE_FAIL="app", FAKE_BRIDGE_ERR='{"error":"Bridge request failed (HTTP 503)"}')
        key = f"uber:{A}:card:abdullah"
        rc = self.rc()
        con = sqlite3.connect(os.path.join(self.bstate, "state.sqlite"))
        con.execute("insert into outbox values (?, ?, 'cancelled', 0)",
                    (rc.op_ids("abdullah", "card", key)["self"], json.dumps({"sessionId": "thread-1", "generation": 2})))
        con.commit()
        con.close()
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "abdullah", FAKE_BRIDGE_NO_TO="1")
        self.assertEqual(json.loads(p.stdout), {"abdullah": "sent"})
        last = [c for c in self.sends() if c[0] == "app"][-1]
        self.assertNotIn("--to", last)
        self.assertEqual(last[last.index("--key") + 1], key + ":2")

    def test_ack_for_an_op_the_bridge_already_dropped_is_not_a_send(self):
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club", ok=False,
                          FAKE_BRIDGE_FAIL="send", FAKE_BRIDGE_QUEUED="failed",
                          FAKE_BRIDGE_ERR='{"error":"Bridge request timed out"}')
        self.journal_edit("group-run_club", keys=[], key=None, open=[], attempts=0)  # the journal lost it
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club", ok=False)
        self.assertIn("already had this card", p.stdout)
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "sent"})
        last = self.sends()[-1]
        self.assertEqual(last[last.index("--key") + 1], f"uber:{A}:card:group-run_club:2")

    def test_queued_card_the_bridge_drops_counts_as_missing_again(self):
        # Accepted (pending), then a route rotation cancels it before any attempt: not sent after all.
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "group-thread@1", FAKE_BRIDGE_ACK_STATE="pending")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "sent"})
        rc = self.rc()
        env = {"RIDE_CARD_BRIDGE_STATE": self.bstate, "RIDE_CARD_JOURNAL": self.journal}
        with unittest.mock.patch.dict(os.environ, env):
            self.assertEqual(rc.sent_to(A), {"group-run_club"})
            self.set_op("group-run_club", "cancelled", attempts=0)
            self.assertEqual(rc.sent_to(A), set())
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "sent"})
        first, second = self.sends()
        self.assertEqual(first[first.index("--text") + 1], second[second.index("--text") + 1])
        self.assertEqual(second[second.index("--to") + 1], "group-run_club")
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "already sent"})

    def test_owner_card_falls_back_to_its_own_route_on_an_older_bridge(self):
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "abdullah", FAKE_BRIDGE_NO_TO="1")
        self.assertEqual(json.loads(p.stdout), {"abdullah": "sent"})
        refused, sent = [c for c in self.bridge_calls() if c[0] == "app"]
        self.assertEqual(refused[refused.index("--to") + 1], "owner")
        self.assertNotIn("--to", sent)
        self.assertEqual(refused[refused.index("--key") + 1], sent[sent.index("--key") + 1])
        self.assertEqual(len(self.outbox("abdullah")), 1)
        r = self.share_log()["recipients"]["abdullah"]
        self.assertEqual((r["via"], r["no_to"]), ("self", True))
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "abdullah", FAKE_BRIDGE_NO_TO="1")
        self.assertEqual(json.loads(p.stdout), {"abdullah": "already sent"})

    def test_send_refuses_mismatched_trip(self):
        self.set_state(trip(B, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", ok=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(self.bridge_calls(), [])

    def test_send_rejects_uuid_prefix(self):
        p = self.card_cli("send", "--trip", A[:8], "--session", "thread-1@3", ok=False)
        self.assertIn("exact trip UUID", p.stderr)

    def test_caption_has_no_time_words(self):
        sys.path.insert(0, os.path.dirname(CARD))
        import ride_card as rc
        c = {"rider": "abdullah", "dropoff": "Today Cafe 12:30 Tower"}
        p = rc.payload_for(c, "moni", "https://x/", "card")
        for s in (p["caption"], p["subcaption"], p["summary"]):
            self.assertNotRegex(s, r"(?i)\b(today|\d{1,2}:\d{2})")
        self.assertEqual(rc.payload_for({"rider": "moni", "dropoff": "Sunset Mall"}, "abdullah", "https://x/", "card")["caption"], "Moni's ride")
        for place in ("Sunset Mall", "Satwa", "Monaco Tower", "Thunder Bowl", "Friends Avenue"):
            p = rc.payload_for({"rider": "moni", "dropoff": place}, "abdullah", "https://x/", "card")
            self.assertEqual(p["subcaption"], f"To {place}")
        self.assertEqual(rc.payload_for({"rider": "moni", "dropoff": "x"}, "moni", "https://x/", "card")["caption"], "Your ride")

    def test_explicit_moni_card_mode_refused_without_bridge_support(self):
        self.set_state(trip(A, "Accepted"), {})
        env = {k: v for k, v in self.env.items()}
        p = subprocess.run([sys.executable, "-c", f"""
import sys, json; sys.path.insert(0, {os.path.dirname(CARD)!r})
import ride_card as rc
rc.bridge_app_to = lambda: False
res, failed = rc.send({A!r}, "thread-1@3", modes={{"moni": "card"}})
print(json.dumps(res))
"""], capture_output=True, text=True, env=env, timeout=60)
        res = json.loads(p.stdout.strip().splitlines()[-1])
        self.assertEqual(res["abdullah"], "sent")
        self.assertIn("app --to", res["moni"])
        self.assertFalse(any(c[0] == "app" and c[c.index("--to") + 1] == "moni" for c in self.bridge_calls()))
        with open(os.path.join(self.journal, f"{A}.json")) as f:
            self.assertNotIn("payload", json.load(f)["recipients"]["moni"])

    def test_og_text_carries_state_without_times(self):
        sys.path.insert(0, os.path.dirname(CARD))
        import ride_card as rc
        for name, c in rc.sample_states():
            t = rc.texts(c)
            self.assertNotRegex(t["og_title"] + t["og_desc"], r"\d{1,2}:\d{2}", name)
            self.assertLessEqual(len(t["og_title"]), 40)


if __name__ == "__main__":
    unittest.main()
