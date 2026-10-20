import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, "..", "helpers", "ride-share-check.py")

FAKE_UBER = """#!/usr/bin/python3
import json, os, sys
state = json.load(open(os.environ["FAKE_UBER_STATE"]))
args = [a for a in sys.argv[1:] if a != "--json"]
if args[:2] == ["rides", "status"]:
    out = {"ok": True, "result": {"trip": state.get("trip")}}
elif args[:2] == ["trips", "get"]:
    t = state.get("history", {}).get(args[2])
    out = {"ok": True, "result": t} if t else {"ok": False, "error": "not found"}
else:
    out = {"ok": False, "error": "unexpected args " + " ".join(args)}
print(json.dumps(out))
"""

DROPOFF = [{"type": "Dropoff", "title": "Dubai Mall"}]


def trip(uuid, status, driver=True):
    return {
        "uuid": uuid,
        "status": status,
        "driver": {"name": "x"} if driver else None,
        "stops": DROPOFF,
        "arrivalEta": "2026-10-19T10:30:00Z",
    }


class RideShareCheckTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.fake = os.path.join(self.dir, "uber")
        with open(self.fake, "w") as f:
            f.write(FAKE_UBER)
        os.chmod(self.fake, os.stat(self.fake).st_mode | stat.S_IEXEC)
        self.fixture = os.path.join(self.dir, "fixture.json")
        self.set_state(trip=None, history={})
        self.hints = os.path.join(self.dir, "hints")
        os.makedirs(self.hints)
        self.state = os.path.join(self.dir, "rides.json")

    def set_state(self, trip, history):
        with open(self.fixture, "w") as f:
            json.dump({"trip": trip, "history": history}, f)

    def run_check(self, now):
        env = dict(
            os.environ,
            UBER_BIN=self.fake,
            FAKE_UBER_STATE=self.fixture,
            RIDE_SHARE_STATE=self.state,
            RIDE_SHARE_HINTS=self.hints,
            RIDE_SHARE_NOW=str(now),
        )
        p = subprocess.run(
            [sys.executable, HELPER], capture_output=True, text=True, env=env, timeout=60
        )
        self.assertEqual(p.returncode, 0, p.stderr)
        return [line for line in p.stdout.splitlines() if line.strip()]

    def test_quick_cancel_produces_no_output(self):
        self.set_state(trip(
            "A", "Accepted"), {})
        self.assertEqual(self.run_check(0), [])
        self.set_state(None, {"A": {"status": "CANCELED", "endedAt": None}})
        self.assertEqual(self.run_check(30), [])
        self.assertEqual(self.run_check(400), [])

    def test_normal_ride_one_booked_then_ended(self):
        self.set_state(trip("A", "Accepted"), {})
        self.assertEqual(self.run_check(0), [])
        self.assertEqual(self.run_check(30), [])
        out = self.run_check(60)
        self.assertEqual(len(out), 1)
        self.assertTrue(out[0].startswith("BOOKED trip=A rider=abdullah(assumed) dest=\"Dubai Mall\""), out[0])
        self.assertEqual(self.run_check(90), [])
        self.set_state(None, {"A": {"status": "COMPLETED", "endedAt": "2026-10-19T10:25:00Z"}})
        out = self.run_check(600)
        self.assertEqual(len(out), 1)
        self.assertTrue(out[0].startswith("ENDED trip=A rider=abdullah(assumed) result=COMPLETED"), out[0])
        self.assertEqual(self.run_check(630), [])

    def test_cancel_then_rebook_within_window_prints_only_rebooked(self):
        self.set_state(trip("A", "Accepted"), {})
        self.run_check(0)
        out = self.run_check(60)
        self.assertEqual(len(out), 1)
        self.assertTrue(out[0].startswith("BOOKED trip=A"), out[0])
        self.set_state(trip("B", "Searching", driver=False), {"A": {"status": "CANCELED", "endedAt": None}})
        self.assertEqual(self.run_check(100), [])
        self.set_state(trip("B", "Accepted"), {"A": {"status": "CANCELED", "endedAt": None}})
        self.assertEqual(self.run_check(130), [])
        out = self.run_check(190)
        self.assertEqual(len(out), 1, out)
        self.assertTrue(out[0].startswith("REBOOKED trip=B replaces=A rider=abdullah(assumed)"), out[0])
        self.assertIn("dest=\"Dubai Mall\"", out[0])
        self.assertIn("arrive_eta=", out[0])
        self.assertEqual(self.run_check(400), [])

    def test_cancel_without_rebook_prints_canceled_after_window(self):
        self.set_state(trip("A", "Accepted"), {})
        self.run_check(0)
        out = self.run_check(60)
        self.assertTrue(out[0].startswith("BOOKED trip=A"), out)
        self.set_state(None, {"A": {"status": "CANCELED", "endedAt": None}})
        self.assertEqual(self.run_check(100), [])
        self.assertEqual(self.run_check(160), [])
        out = self.run_check(280)
        self.assertEqual(len(out), 1, out)
        self.assertTrue(out[0].startswith("ENDED trip=A rider=abdullah(assumed) result=CANCELED"), out[0])
        self.assertEqual(self.run_check(310), [])


if __name__ == "__main__":
    unittest.main()
