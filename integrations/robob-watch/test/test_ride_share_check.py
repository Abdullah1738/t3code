import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest

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
import json, os, sys
args = sys.argv[1:]
log = os.environ["FAKE_BRIDGE_LOG"]
with open(log, "a") as f:
    f.write(json.dumps(args) + "\\n")
if os.environ.get("FAKE_BRIDGE_FAIL") == args[0]:
    print("boom", file=sys.stderr); sys.exit(1)
if args[0] == "publish":
    print(json.dumps({"url": "https://host.ts.net:18401/" + args[2] + "/", "metadataWarnings": []}))
elif args[0] == "share":
    print(json.dumps({"url": "https://x.trycloudflare.com/" + args[2] + "/", "created": True, "metadataWarnings": []}))
else:
    print(json.dumps({"ok": True}))
"""


def trip(uuid, status, plate="K 48213", name="Imran Khan", car="Black Lexus ES"):
    t = {
        "uuid": uuid, "status": status, "pickupEta": "4 min", "arrivalEta": "2026-10-19T10:30:00Z",
        "pin": "9731", "fare": "AED 65.89", "headline": "Imran is on the way",
        "stops": [{"type": "Pickup", "title": "Banyan Tree Residences", "location": {"lat": 25.0712, "lng": 55.1401}},
                  {"type": "Dropoff", "title": "Dubai Mall", "location": {"lat": 25.1972, "lng": 55.2797}}],
        "route": [[25.07123, 55.14011]],
    }
    if status not in ("Searching", "Dispatching", "Matching", "Requesting", "WaitingForDispatch"):
        t["driver"] = {"name": name, "rating": 4.9, "photo": "https://cdn.example/photo-secret.jpg"}
        t["vehicle"] = {"description": car, "plate": plate, "location": {"lat": 25.1, "lng": 55.2}}
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
        self.env = dict(
            os.environ, UBER_BIN=self.fake, FAKE_UBER_STATE=self.fixture, RIDE_SHARE_STATE=self.state,
            RIDE_SHARE_HINTS=self.hints, RIDE_CARD_ROOT=self.cards, RIDE_CARD_JOURNAL=self.journal,
            RIDE_CARD_NO_IMAGE="1", RIDE_CARD_BRIDGE=self.bridge, FAKE_BRIDGE_LOG=self.blog,
            RIDE_CARD_ENROLL=self.enroll, WATCH_DIR=self.dir,
        )

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
        for i, (st, want) in enumerate([("ArrivingAtPickup", "arriving"), ("WaitingForPickup", "arrived"), ("OnTrip", "ontrip")]):
            self.set_state(trip(A, st), {})
            self.assertEqual(self.run_check(150 + 30 * i), [])
            self.assertEqual(self.card(A)["state"], want)
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


class SendTest(Base):
    def test_send_publishes_and_shares_once_with_stable_keys(self):
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3")
        self.assertEqual(json.loads(p.stdout), {"abdullah": "sent", "moni": "sent"})
        calls = self.bridge_calls()
        self.assertEqual([c[0] for c in calls], ["publish", "app", "share", "send"])
        app = calls[1]
        self.assertIn(f"uber:{A}:card:abdullah", app)
        self.assertNotIn("--to", app)
        self.assertEqual(app[app.index("--caption") + 1], "Your ride")
        moni = calls[3]
        self.assertEqual(moni[moni.index("--to") + 1], "moni")
        self.assertIn(f"uber:{A}:card:moni", moni)
        self.assertIn("trycloudflare.com", moni[moni.index("--text") + 1])
        self.assertNotIn("ts.net", " ".join(moni))
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
        moni = [c for c in self.bridge_calls() if c[0] == "app" and "--to" in c][0]
        self.assertEqual(moni[moni.index("--caption") + 1], "Abdullah's ride")
        self.assertTrue(moni[moni.index("--url") + 1].startswith("https://x.trycloudflare.com/"))

    def test_from_moni_chat_only_sends_to_moni(self):
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "moni-thread@1", "--from-chat", "moni")
        calls = self.bridge_calls()
        self.assertEqual([c[0] for c in calls], ["share", "send"])
        self.assertNotIn("--to", calls[1])

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
        self.assertFalse(any(c[0] == "app" and "--to" in c for c in self.bridge_calls()))
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
