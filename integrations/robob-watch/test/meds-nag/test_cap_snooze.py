"""Run the real reminder commands against private state and a fixed Dubai clock."""
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[2] / "watchers/meds-nag"


class CapSnoozeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="meds-cap-snooze-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for name in ("check.py", "took.py"):
            shutil.copy2(SOURCE / name, self.root / name)
        for name in ("taken", "moved", "doses", "sites", "nagstate", "snooze", "state"):
            self.write(name, {})
        self.now = "2026-11-13T09:00:00+04:00"
        self.env = dict(os.environ, MEDS_NOW=self.now, WATCH_DIR=str(self.root),
                        HOME=str(self.root), PYTHONDONTWRITEBYTECODE="1",
                        HEALTH_TOOLLOG_DIR=str(self.root / "logs"))
        # Keep late-night awake() deterministic without consulting this Mac.
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        ioreg = bin_dir / "ioreg"
        ioreg.write_text('#!/bin/sh\nprintf \'"HIDIdleTime" = 0\\n\'\n')
        ioreg.chmod(0o700)
        self.env["PATH"] = str(bin_dir) + ":" + self.env.get("PATH", "")

    def write(self, name, value):
        (self.root / (name + ".json")).write_text(json.dumps(value))

    def read(self, name):
        return json.loads((self.root / (name + ".json")).read_text())

    def run_script(self, script, *args, ok=True):
        env = dict(self.env, MEDS_NOW=self.now)
        result = subprocess.run(["/usr/bin/python3", script, *args], cwd=self.root,
                                env=env, capture_output=True, text=True, timeout=10)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def check(self):
        return self.run_script("check.py").stdout

    def took(self, *args, **kw):
        return self.run_script("took.py", *args, **kw)

    def advance(self, hours=1):
        self.now = (dt.datetime.fromisoformat(self.now) + dt.timedelta(hours=hours)).isoformat()

    def exhaust(self):
        for index in range(3):
            text = self.check()
            self.assertIn("Meds check", text)
            self.assertEqual("Last reminder today; text me when you take it." in text, index == 2)
            self.advance()

    def test_three_sends_then_silence(self):
        self.exhaust()
        before = self.read("nagstate")
        for _ in range(12):
            self.assertEqual(self.check(), "")
            self.advance()
        self.assertEqual(self.read("nagstate"), before)
        self.assertEqual(before["count"], 3)
        self.assertEqual(before["day"], "2026-11-13")
        self.assertEqual(before["seen"], [])

    def test_reply_resets_count_and_seen(self):
        self.exhaust()
        self.took("dutasteride")
        self.assertIn("Meds check", self.check())
        self.assertEqual(self.read("nagstate")["count"], 1)
        self.assertEqual(self.read("nagstate")["seen"], ["dutasteride"])
        self.advance()
        self.check()
        self.advance()
        self.assertIn("Last reminder today", self.check())
        self.advance()
        self.assertEqual(self.check(), "")

    def test_reply_does_not_bypass_hourly_gap(self):
        self.check()
        self.took("dutasteride")
        self.assertEqual(self.check(), "")
        self.advance()
        self.assertIn("Meds check", self.check())
        self.assertEqual(self.read("nagstate")["count"], 1)

    def test_legacy_last_only_state_keeps_gap(self):
        self.write("nagstate", {"last": self.now})
        self.assertEqual(self.check(), "")
        self.advance()
        self.assertIn("Meds check", self.check())
        self.assertEqual(self.read("nagstate")["count"], 1)

    def test_next_day_has_fresh_count_and_carried_doses(self):
        self.exhaust()
        self.now = "2026-11-14T09:00:00+04:00"
        text = self.check()
        self.assertIn("Reta 3mg (from Thu 12 Nov, missed)", text)
        self.assertIn("Test E 100mg = 0.4ml (cruise) (from Fri 13 Nov, missed)", text)
        self.assertEqual(self.read("nagstate")["count"], 1)
        self.assertEqual(self.read("nagstate")["day"], "2026-11-14")

    def test_after_midnight_still_uses_previous_day_cap(self):
        self.exhaust()
        self.now = "2026-11-14T00:30:00+04:00"
        self.assertEqual(self.check(), "")
        self.assertEqual(self.read("nagstate")["day"], "2026-11-13")

    def test_late_night_gap_and_day_for_confirmation(self):
        self.now = "2026-11-14T00:00:00+04:00"
        self.assertIn("Meds check", self.check())
        self.now = "2026-11-14T00:29:00+04:00"
        self.assertEqual(self.check(), "")
        self.now = "2026-11-14T00:30:00+04:00"
        self.assertIn("Meds check", self.check())
        self.took("dutasteride")
        self.assertEqual(self.read("taken"), {"2026-11-13": ["dutasteride"]})
        self.now = "2026-11-14T05:00:00+04:00"
        self.assertEqual(self.check(), "")

    def test_one_snooze_hides_only_that_med(self):
        self.took("snooze", "reta")
        text = self.check()
        self.assertNotIn("Reta", text)
        self.assertIn("Dutasteride", text)
        self.assertIn("Test E", text)
        self.assertEqual(self.read("snooze"), {"reta": "2026-11-14T05:00:00+04:00"})
        output = self.took("tadalafil").stdout
        self.assertIn("snoozed: reta until Sat 14 Nov 05:00", output)

    def test_snooze_all_hides_everything_without_consuming_cap(self):
        self.took("snooze", "all")
        self.assertEqual(self.check(), "")
        self.assertEqual(self.read("nagstate"), {})

    def test_expiry_is_ignored_then_pruned_on_confirmation(self):
        self.took("snooze", "reta", "--until", "10:00")
        self.assertNotIn("Reta", self.check())
        self.now = "2026-11-13T10:00:00+04:00"
        self.assertIn("Reta", self.check())
        self.assertIn("reta", self.read("snooze"))
        self.assertEqual(self.took("snoozed").stdout, "snoozed: nothing\n")
        self.took("dutasteride")
        self.assertEqual(self.read("snooze"), {})

    def test_expiry_pruned_on_skip_or_snooze_write(self):
        for args in (("skip", "reta"), ("snooze", "tadalafil"), ("unsnooze", "reta")):
            with self.subTest(args=args):
                self.write("snooze", {"dutasteride": "2026-11-13T08:00:00+04:00"})
                self.took(*args)
                self.assertNotIn("dutasteride", self.read("snooze"))

    def test_snooze_until_and_days_forms(self):
        rows = [
            (("--days", "2"), "2026-11-15T09:00:00+04:00"),
            (("--until", "18:30"), "2026-11-13T18:30:00+04:00"),
            (("--until", "08:30"), "2026-11-14T08:30:00+04:00"),
            (("--until", "2026-11-15T05:00"), "2026-11-15T05:00:00+04:00"),
        ]
        for args, expected in rows:
            with self.subTest(args=args):
                self.took("snooze", "reta", *args)
                self.assertEqual(self.read("snooze")["reta"], expected)

    def test_days_two_stays_active_until_exact_expiry(self):
        self.took("snooze", "all", "--days", "2")
        self.now = "2026-11-15T08:59:00+04:00"
        self.assertEqual(self.check(), "")
        self.now = "2026-11-15T09:00:00+04:00"
        self.assertIn("Meds check", self.check())

    def test_meds_now_converts_offset_to_dubai(self):
        self.now = "2026-11-13T23:30:00+00:00"
        self.took("snooze", "reta")
        self.assertEqual(self.read("snooze")["reta"], "2026-11-15T05:00:00+04:00")

    def test_snoozed_lists_only_active(self):
        self.write("snooze", {"reta": "2026-11-14T05:00:00+04:00",
                              "test": "2026-11-12T05:00:00+04:00"})
        self.assertEqual(self.took("snoozed").stdout, "snoozed: reta until Sat 14 Nov 05:00\n")

    def test_unsnooze_one_and_all(self):
        self.took("snooze", "reta")
        self.took("snooze", "test")
        self.took("unsnooze", "reta")
        self.assertEqual(set(self.read("snooze")), {"test"})
        self.assertIn("Reta", self.check())
        self.took("unsnooze", "all")
        self.assertEqual(self.read("snooze"), {})
        self.advance()
        self.assertIn("Test E", self.check())

    def test_unsnooze_named_med_after_all(self):
        self.took("snooze", "all")
        self.took("unsnooze", "reta")
        text = self.check()
        self.assertIn("Reta", text)
        self.assertNotIn("Dutasteride", text)
        self.assertNotIn("Test E", text)

    def test_names_use_schedule_key(self):
        for value, key in [("Reta", "reta"), ("RETA", "reta"), ("Reta 3mg", "reta"),
                           ("Test E 100mg = 0.4ml (cruise)", "test"), ("all", "all")]:
            with self.subTest(value=value):
                self.write("snooze", {})
                self.took("snooze", value)
                self.assertEqual(set(self.read("snooze")), {key})
                self.took("unsnooze", value)
                self.assertEqual(self.read("snooze"), {})

    def test_invalid_input_never_changes_state(self):
        rows = [("snooze", "bogus"), ("unsnooze", "bogus"), ("bogus",),
                ("dutasteride", "bogus"), ("skip", "bogus"), ("snooze", ""),
                ("snooze",), ("unsnooze",), ("snoozed", "reta"),
                ("snooze", "reta", "--days", "0"), ("snooze", "reta", "--days", "-1"),
                ("snooze", "reta", "--days", "1.5"), ("snooze", "reta", "--days", "many"),
                ("snooze", "reta", "--until", "25:00"),
                ("snooze", "reta", "--until", "2026-11-12T12:00"),
                ("snooze", "reta", "--until", "2026-02-30T12:00"),
                ("snooze", "reta", "--until", "tomorrow"),
                ("snooze", "reta", "--until"),
                ("snooze", "reta", "--days", "1", "--until", "15:00"),
                ("unsnooze", "reta", "--days", "2")]
        self.write("snooze", {"test": "2026-11-12T05:00:00+04:00"})
        before = {p.name: p.read_bytes() for p in self.root.glob("*.json")}
        for args in rows:
            with self.subTest(args=args):
                result = self.took(*args, ok=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("usage:", result.stderr)
                self.assertEqual({p.name: p.read_bytes() for p in self.root.glob("*.json")}, before)
                self.assertFalse(list(self.root.glob("*.tmp")))


if __name__ == "__main__":
    unittest.main()
