"""Run the real reminder commands against private state and a fixed Dubai clock."""
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest

SOURCE = Path(__file__).resolve().parents[2] / "watchers/meds-nag"


class HourlyFoldSnoozeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="meds-hourly-fold-")
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
        value = json.loads((self.root / (name + ".json")).read_text())
        if name == "nagstate": value.pop("outcomes", None)
        return value

    def run_script(self, script, *args, ok=True):
        env = dict(self.env, MEDS_NOW=self.now)
        result = subprocess.run(["/usr/bin/python3", script, *args], cwd=self.root,
                                env=env, capture_output=True, text=True,
                                timeout=15)
        if args[:1] == ("--fold",):
            self.assertEqual(result.stderr, "")
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def check(self, *args):
        return self.run_script("check.py", *args).stdout

    def took(self, *args, **kw):
        return self.run_script("took.py", *args, **kw)

    def advance(self, hours=1):
        self.now = (dt.datetime.fromisoformat(self.now) + dt.timedelta(hours=hours)).isoformat()

    def test_hourly_sends_keep_going(self):
        for _ in range(5):
            text = self.check()
            self.assertIn("Meds check", text)
            self.assertNotIn("Last reminder", text)
            self.assertTrue(text.endswith(". Text me when done and I'll stop.\n"))
            self.advance()
        self.assertEqual(self.read("nagstate"), {"last": "2026-11-13T13:00:00+04:00"})

    def test_reply_removes_taken_label(self):
        self.assertIn("Dutasteride", self.check())
        self.took("dutasteride")
        self.advance()
        text = self.check()
        self.assertIn("Meds check", text)
        self.assertNotIn("Dutasteride", text)

    def test_reply_does_not_bypass_hourly_gap(self):
        self.check()
        self.took("dutasteride")
        self.assertEqual(self.check(), "")
        self.advance()
        self.assertIn("Meds check", self.check())

    def test_legacy_last_only_state_keeps_gap(self):
        self.write("nagstate", {"last": self.now})
        self.assertEqual(self.check(), "")
        self.advance()
        self.assertIn("Meds check", self.check())

    def test_next_day_has_carried_doses(self):
        self.check()
        self.now = "2026-11-14T09:00:00+04:00"
        text = self.check()
        self.assertIn("Reta 3mg (from Thu 12 Nov, missed)", text)
        self.assertIn("Test E 100mg = 0.4ml (cruise) (from Fri 13 Nov, missed)", text)

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

    def test_snooze_all_hides_everything_without_recording_a_send(self):
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

    def test_all_taken_is_silent_in_both_modes(self):
        self.took("all")
        self.assertEqual(self.check(), "")
        self.assertEqual(self.check("--fold"), "")
        self.assertEqual(self.read("nagstate"), {})

    def test_fold_fastest_of_three_runs_is_under_1_5_seconds(self):
        elapsed = []
        for _ in range(3):
            self.write("nagstate", {})
            started = time.monotonic()
            text = self.check("--fold")
            elapsed.append(time.monotonic() - started)
            self.assertIn("Still need", text)
        self.assertLess(min(elapsed), 1.5, f"--fold wall-clock times: {elapsed}")

    def test_fold_exact_line_and_half_hour_gap(self):
        # Fold uses labels verbatim, including carried doses, without injection-site advice.
        self.write("taken", {"2026-11-13": ["dutasteride", "tadalafil", "arimidex", "reta"]})
        expected = "💊 Still need: Test E 100mg = 0.4ml (cruise). Text me when done.\n"
        self.assertEqual(self.check("--fold"), expected)
        self.assertEqual(self.read("nagstate"), {"fold_last": self.now})
        self.now = "2026-11-13T09:10:00+04:00"
        self.assertEqual(self.check("--fold"), "")
        self.now = "2026-11-13T09:31:00+04:00"
        self.assertEqual(self.check("--fold"), expected)
        self.assertEqual(self.read("nagstate"), {"fold_last": self.now})

    def test_fold_respects_named_and_blanket_snooze(self):
        self.took("snooze", "reta")
        text = self.check("--fold")
        self.assertNotIn("Reta", text)
        self.assertIn("Test E", text)
        self.advance()
        self.took("snooze", "all")
        self.assertEqual(self.check("--fold"), "")

    def test_standalone_yields_to_latest_fold(self):
        self.check()
        self.now = "2026-11-13T09:30:00+04:00"
        self.assertIn("Still need", self.check("--fold"))
        self.now = "2026-11-13T09:50:00+04:00"
        self.assertEqual(self.check(), "")
        self.now = "2026-11-13T10:31:00+04:00"
        self.assertIn("Meds check", self.check())
        self.assertEqual(self.read("nagstate"), {"last": self.now, "fold_last": "2026-11-13T09:30:00+04:00"})

    def test_last_standalone_still_controls_gap_when_newer_than_fold(self):
        self.check("--fold")
        self.now = "2026-11-13T10:01:00+04:00"
        self.assertIn("Meds check", self.check())
        self.now = "2026-11-13T10:30:00+04:00"
        self.assertEqual(self.check(), "")

    def test_continuous_folds_keep_standalone_silent(self):
        for _ in range(5):
            self.assertIn("Still need", self.check("--fold"))
            self.assertEqual(self.check(), "")
            self.advance(hours=0.5)

    def test_night_fold_never_uses_awake_databases_or_network(self):
        guard = self.root / "sitecustomize.py"
        guard.write_text('''import os, sqlite3, subprocess, socket
def forbidden(*args, **kwargs):
    with open(os.path.join(os.environ['HOME'], 'forbidden-call'), 'w') as f: f.write('called')
    raise RuntimeError('external IO in fold')
sqlite3.connect = forbidden
subprocess.run = forbidden
socket.socket = forbidden
''')
        self.env["PYTHONPATH"] = str(self.root)
        self.now = "2026-11-14T02:00:00+04:00"
        text = self.check("--fold")
        self.assertIn("Still need", text)
        self.assertIn("Test E 100mg = 0.4ml (cruise)", text)
        self.assertNotIn("from Fri 13 Nov", text)
        self.assertIn("from Thu 12 Nov, missed", text)
        self.assertFalse((self.root / "forbidden-call").exists())

    def test_fold_outside_hours_is_silent(self):
        self.now = "2026-11-14T07:00:00+04:00"
        self.assertEqual(self.check("--fold"), "")
        self.assertEqual(self.read("nagstate"), {})

    def test_corrupt_state_is_safe_in_fold(self):
        for value in ("{broken", "[]", '{"fold_last":"invalid"}', '{"fold_last":null}'):
            with self.subTest(value=value):
                (self.root / "nagstate.json").write_text(value)
                self.assertIn("Still need", self.check("--fold"))
                self.assertEqual(self.read("nagstate"), {"fold_last": self.now})

    def test_fold_errors_still_exit_zero_without_a_line(self):
        self.write("taken", {"2026-11-13": 7})
        self.assertEqual(self.check("--fold"), "")
        self.write("taken", {})
        self.env["MEDS_NOW"] = "invalid"
        self.now = "invalid"
        self.assertEqual(self.check("--fold"), "")

    def test_state_write_failure_is_silent_in_fold(self):
        (self.root / "nagstate.json.tmp").mkdir()
        self.assertEqual(self.check("--fold"), "")
        self.assertEqual(self.read("nagstate"), {})

    def test_unreadable_nagstate_is_silent_in_fold(self):
        path = self.root / "nagstate.json"
        path.unlink(); path.mkdir()
        self.assertEqual(self.check("--fold"), "")
        self.assertTrue(path.is_dir())

    def test_fold_input_errors_are_silent_without_advancing_clock(self):
        rows = [
            ("taken", "{broken"), ("taken", "[]"), ("taken", '{"2026-11-13":7}'),
            ("snooze", "{broken"), ("snooze", "[]"), ("snooze", '{"all":"invalid"}'),
            ("snooze", '{"all":"2026-11-14T05:00:00"}'),
            ("moved", "{broken"), ("moved", "[]"), ("moved", '{"2026-11-13":7}'),
        ]
        wrong_map_types = [None, [], "text", 7, 1.5, True]
        wrong_list_types = [None, {}, "dutasteride", 7, 1.5, True]
        for name in ("taken", "snooze", "moved"):
            rows += [(name, json.dumps(value)) for value in wrong_map_types]
        rows += [("taken", json.dumps({"2026-11-13": value})) for value in wrong_list_types]
        rows += [("taken", json.dumps({"2026-11-13": [value]})) for value in [None, {}, [], 7, 1.5, True]]
        for field in ("skip", "add"):
            rows += [("moved", json.dumps({"2026-11-13": {field: value}})) for value in wrong_list_types]
            rows += [("moved", json.dumps({"2026-11-13": {field: [value]}})) for value in [None, {}, [], 7, 1.5, True]]
        rows += [("snooze", json.dumps({"all": value})) for value in [None, {}, [], 7, 1.5, True]]
        for name, value in rows:
            with self.subTest(name=name, value=value):
                path = self.root / (name + ".json")
                path.write_text(value)
                try:
                    self.assertEqual(self.check("--fold"), "")
                    self.assertEqual(self.read("nagstate"), {})
                finally: self.write(name, {})
        for name in ("taken", "snooze", "moved"):
            with self.subTest(unreadable=name):
                path = self.root / (name + ".json")
                path.unlink(); path.mkdir()
                try:
                    self.assertEqual(self.check("--fold"), "")
                    self.assertEqual(self.read("nagstate"), {})
                finally: path.rmdir(); self.write(name, {})

    def test_missing_confirmation_file_is_silent_but_optional_files_may_be_absent(self):
        path = self.root / "taken.json"
        path.unlink()
        self.assertEqual(self.check("--fold"), "")
        self.assertEqual(self.read("nagstate"), {})
        self.write("taken", {})
        for name in ("snooze", "moved"):
            (self.root / (name + ".json")).unlink()
        self.assertIn("Still need", self.check("--fold"))

    def test_legacy_keys_are_removed_on_either_write(self):
        for args in ((), ("--fold",)):
            with self.subTest(args=args):
                self.write("nagstate", {"day": "2026-11-13", "count": 99, "seen": [], "other": "keep"})
                self.assertTrue(self.check(*args))
                self.assertEqual(self.read("nagstate"), {"other": "keep", "fold_last" if args else "last": self.now})

    def test_fold_does_not_wait_for_concurrent_reminder(self):
        with (self.root / "nagstate.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.check("--fold"), "")
        self.assertEqual(self.read("nagstate"), {})
        self.assertIn("Still need", self.check("--fold"))


if __name__ == "__main__":
    unittest.main()
