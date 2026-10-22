"""health_check msgs: the message archive stops reading chat.db.

Runs on the system python, touches no real data and never sends Telegram:
  python3 -m unittest discover -s tests -p 'test_*.py'
"""
import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest import mock

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
sys.path.insert(0, SRC)

import health_check as hc  # noqa: E402


class Msgs(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = os.path.join(self.tmp.name, "index.db")
        self.log = os.path.join(self.tmp.name, "daemon.log")
        c = sqlite3.connect(self.db)
        c.execute("CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT, updated_at INT)")
        c.commit()
        c.close()
        self.seen = os.path.join(self.tmp.name, "msgs_seen.json")
        self.boot, self.up = "boot-a", 50000.0
        self.state = os.path.join(self.tmp.name, "health_state.json")
        patches = [mock.patch.object(hc, "MSGS_DB", self.db),
                   mock.patch.object(hc, "MSGS_LOG", self.log),
                   mock.patch.object(hc, "MSGS_SEEN", self.seen),
                   mock.patch.object(hc, "STATE", self.state),
                   mock.patch.object(hc, "_boot_id", lambda: self.boot),
                   mock.patch.object(hc, "_uptime", lambda: self.up),
                   mock.patch.object(hc, "launchd_exit", return_value=(None, 1, True)),
                   mock.patch.object(hc.os.path, "ismount", return_value=True)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def set_last_ok(self, age_s):
        self.last_ok = time.time() - age_s
        c = sqlite3.connect(self.db)
        c.execute("INSERT OR REPLACE INTO sync_state VALUES ('imessage', ?, 0)",
                  (json.dumps({"rowid": 5, "last_ok": self.last_ok}),))
        c.commit()
        c.close()

    def seen_for(self, secs, boot="boot-a", carried=0):
        """Earlier runs have watched the current last_ok for secs awake seconds
        of boot (plus carried from earlier boots)."""
        up = self.up if boot == self.boot else secs  # an earlier boot's uptime clock
        with open(self.seen, "w") as f:
            json.dump({"last_ok": self.last_ok, "boot": boot, "start": up - secs, "seen": up,
                       "carried": carried, "up": up}, f)

    def awake(self, secs):
        self.up += secs

    def mark_failing(self):
        with open(self.state, "w") as f:
            json.dump({"failing": {"msgs": {"since": 1, "msg": "x", "notified_day": "20261022"}}}, f)

    def write_log(self, *lines):
        with open(self.log, "w") as f:
            f.write("\n".join(lines) + "\n")

    def test_recent_pass_is_ok(self):
        self.set_last_ok(120)
        ok, msg = hc.check_msgs()
        self.assertTrue(ok, msg)

    def test_stale_with_permission_error_names_full_disk_access(self):
        self.set_last_ok(3 * 3600)
        self.seen_for(3700)
        self.write_log("2026-10-22 10:00:00 imessage: {'added': 3}",
                       "2026-10-22 10:05:00 imessage: ERROR OperationalError: unable to open database file",
                       "2026-10-22 10:06:00 whatsapp: ERROR OperationalError: other")
        ok, msg = hc.check_msgs()
        self.assertFalse(ok)
        self.assertIn("unable to open database file", msg)
        self.assertIn("Full Disk Access", msg)

    def test_stale_without_error_says_stuck(self):
        self.set_last_ok(3 * 3600)
        self.seen_for(3700)
        self.write_log("2026-10-22 10:00:00 imessage: {'added': 3}")
        ok, msg = hc.check_msgs()
        self.assertFalse(ok)
        self.assertIn("no error logged", msg)
        self.assertNotIn("Full Disk Access", msg)

    def test_never_synced(self):
        ok, msg = hc.check_msgs()
        self.assertFalse(ok)
        self.assertIn("never", msg)

    def test_stale_after_wake_waits_then_alerts(self):
        # last pass hours ago by the wall clock, but the Mac slept: only awake time counts
        self.set_last_ok(10 * 3600)
        ok, msg = hc.check_msgs()
        self.assertTrue(ok, msg)
        self.assertIn("waiting", msg)
        self.awake(hc.MSGS_MAX_AGE + 60)
        ok, msg = hc.check_msgs()
        self.assertFalse(ok)
        self.assertIn("no error logged", msg)

    def test_paused_state_changes_dont_restart_the_count(self):
        self.set_last_ok(3 * 3600)
        self.seen_for(hc.MSGS_MAX_AGE + 60)
        with mock.patch.object(hc, "launchd_exit", return_value=(None, 0, False)):
            ok, msg = hc.check_msgs()
        self.assertFalse(ok)
        self.assertIn("not loaded", msg)
        ok, msg = hc.check_msgs()
        self.assertFalse(ok)
        self.assertIn("no error logged", msg)

    def test_reboot_carries_the_count(self):
        self.set_last_ok(3 * 3600)
        self.seen_for(20 * 60, boot="boot-old")
        self.up = 20 * 60.0  # 20 min into the new boot
        ok, msg = hc.check_msgs()
        self.assertTrue(ok, msg)
        self.assertIn("40 of 60", msg)  # 20 min before the reboot plus 20 after
        self.awake(25 * 60)
        ok, msg = hc.check_msgs()
        self.assertFalse(ok)

    def test_boot_id_lookup_failing_is_not_a_reboot(self):
        # r3: boot lookups alternating with None reset the count every run
        self.set_last_ok(3 * 3600)
        for i in range(5):
            self.boot = None if i % 2 else "boot-a"
            ok, msg = hc.check_msgs()
            self.awake(15 * 60)
        self.assertFalse(ok)  # 4 x 15 awake min on the same pass
        self.assertIn("no error logged", msg)

    def test_uptime_going_back_counts_as_a_reboot(self):
        self.set_last_ok(3 * 3600)
        hc.check_msgs()
        self.awake(50 * 60)
        hc.check_msgs()
        self.boot, self.up = None, 15 * 60.0  # rebooted, boot id unknown
        ok, msg = hc.check_msgs()
        self.assertFalse(ok)  # 50 min before plus 15 since boot

    def test_clock_set_back_doesnt_make_a_stuck_pass_fresh(self):
        # r3: the wall clock moving back made an old pass look new and "recovered"
        self.set_last_ok(3 * 3600)
        self.seen_for(9000)
        ok, msg = hc.check_msgs()
        self.assertFalse(ok)
        self.last_ok = time.time() + 600  # same pass, the clock now reads it as future/recent
        with open(self.seen) as f:
            rec = json.load(f)
        rec["last_ok"] = self.last_ok
        with open(self.seen, "w") as f:
            json.dump(rec, f)
        c = sqlite3.connect(self.db)
        c.execute("UPDATE sync_state SET value=? WHERE key='imessage'",
                  (json.dumps({"rowid": 5, "last_ok": self.last_ok}),))
        c.commit()
        c.close()
        ok, msg = hc.check_msgs()
        self.assertFalse(ok)

    def test_new_pass_after_a_failure_gets_the_wake_allowance(self):
        # r3: failure reported, archive recovers, Mac sleeps overnight
        self.set_last_ok(3 * 3600)
        self.seen_for(hc.MSGS_MAX_AGE + 60)
        ok, _ = hc.check_msgs()
        self.assertFalse(ok)
        self.mark_failing()
        self.set_last_ok(8 * 3600)  # a pass the earlier runs didn't see, hours old by the wall clock
        ok, msg = hc.check_msgs()
        self.assertTrue(ok, msg)
        self.assertIn("waiting", msg)

    def test_a_new_pass_starts_over(self):
        self.set_last_ok(3 * 3600)
        self.seen_for(hc.MSGS_MAX_AGE + 60)
        self.set_last_ok(2 * 3600)  # a pass the earlier runs didn't see
        ok, msg = hc.check_msgs()
        self.assertTrue(ok, msg)
        self.assertIn("waiting", msg)

    def test_unsaved_record_gives_no_allowance(self):
        self.set_last_ok(3 * 3600)
        with mock.patch.object(hc, "MSGS_SEEN", os.path.join(self.tmp.name, "missing", "seen.json")):
            ok, msg = hc.check_msgs()
        self.assertFalse(ok)
        self.assertIn("can't save", msg)

    def test_reported_failure_stays_until_a_new_pass(self):
        self.set_last_ok(3 * 3600)
        self.mark_failing()
        ok, msg = hc.check_msgs()  # no record (lost, or a wake): still failing
        self.assertFalse(ok)
        self.awake(60)
        ok, msg = hc.check_msgs()  # same pass: still failing
        self.assertFalse(ok)
        self.set_last_ok(60)
        ok, msg = hc.check_msgs()
        self.assertTrue(ok, msg)

    def test_older_record_layouts_count_from_now(self):
        # r4/r6: a numeric boot (kern.boottime) or a record without "up" can't
        # say which boot its last sample was on; counting it could double count
        self.set_last_ok(3 * 3600)
        old = [{"boot": 1792178451, "up": self.up}, {"boot": "boot-a"}]
        for fields in old:
            rec = {"last_ok": self.last_ok, "start": self.up - 50 * 60, "seen": self.up, "carried": 0}
            rec.update(fields)
            with open(self.seen, "w") as f:
                json.dump(rec, f)
            ok, msg = hc.check_msgs()
            self.assertTrue(ok, msg)
            self.assertIn("0 of 60", msg)
        self.awake(61 * 60)
        ok, msg = hc.check_msgs()
        self.assertFalse(ok)

    def test_save_failure_keeps_an_exhausted_budget(self):
        # r4: with the record unsaveable, a clock set back made a stuck pass fresh
        self.set_last_ok(120)
        self.seen_for(3900)
        with mock.patch.object(hc, "_msgs_save", side_effect=OSError("disk full")):
            ok, msg = hc.check_msgs()
        self.assertFalse(ok)
        self.assertIn("can't save", msg)

    def test_unknown_boot_after_reboot_isnt_counted_twice(self):
        # r5: an unknown boot id sample saved under the old boot was carried
        # over and then counted again as the new boot's uptime
        self.set_last_ok(3 * 3600)
        with open(self.seen, "w") as f:  # 5 min watched on boot A
            json.dump({"last_ok": self.last_ok, "boot": "boot-a", "start": 300, "seen": 600, "carried": 0,
                       "up": 600}, f)
        self.boot, self.up = None, 1800.0  # rebooted into B, id lookup failing
        ok, msg = hc.check_msgs()
        self.assertTrue(ok, msg)
        self.boot, self.up = "boot-b", 2700.0
        ok, msg = hc.check_msgs()
        self.assertTrue(ok, msg)
        self.assertIn("50 of 60", msg)  # 5 before the reboot plus 45 since
        self.awake(11 * 60)
        ok, msg = hc.check_msgs()
        self.assertFalse(ok)

    def test_corrupt_timing_record_counts_from_now(self):
        # r5: a bad field crashed every run until a new pass
        self.set_last_ok(3 * 3600)
        bad = [{"start": "bad"}, {"start": self.up + 9999}, {"carried": -9999}, {"seen": None},
               {"carried": float("inf")}, {"up": float("nan")}]  # json reads 1e309 as inf
        for fields in bad:
            rec = {"last_ok": self.last_ok, "boot": "boot-a", "start": self.up - 60, "seen": self.up, "carried": 0,
                   "up": self.up}
            rec.update(fields)
            with open(self.seen, "w") as f:
                json.dump(rec, f)
            ok, msg = hc.check_msgs()
            self.assertTrue(ok, msg)
            self.assertIn("0 of 60", msg)

    def run_main(self, *args):
        self.addCleanup(setattr, hc, "DRY_RUN", False)
        with mock.patch.object(hc, "CHECKS", [("msgs", hc.check_msgs)]), \
                mock.patch.object(hc, "LOGS", self.tmp.name), \
                mock.patch.object(hc, "LAST", os.path.join(self.tmp.name, "health_last.json")), \
                mock.patch.object(hc, "notify", return_value=True) as notify, \
                mock.patch.object(sys, "argv", ["health_check.py", *args]), \
                mock.patch("builtins.print"):
            hc.main()
        return [c.args[0] for c in notify.call_args_list]

    def test_dry_run_keeps_no_state(self):
        # r5: a dry run saved the new pass, so the next real run missed the recovery
        self.set_last_ok(3 * 3600)
        self.seen_for(hc.MSGS_MAX_AGE + 60)
        self.assertEqual(self.run_main(), ["attention"])
        with open(self.seen) as f:
            before = f.read()
        self.set_last_ok(60)
        self.assertEqual(self.run_main("--dry-run"), [])
        with open(self.seen) as f:
            self.assertEqual(f.read(), before)
        self.assertEqual(self.run_main(), ["info"])

    def test_main_read_error_isnt_followed_by_a_false_recovery(self):
        # r4: a crash reported by main() was cleared by the record's failed:false
        self.set_last_ok(3 * 3600)
        self.seen_for(100)
        self.assertEqual(self.run_main(), [])
        with mock.patch.object(hc, "_msgs_last_ok", side_effect=sqlite3.OperationalError("disk I/O error")):
            self.assertEqual(self.run_main(), ["attention"])
        self.awake(60)
        self.assertEqual(self.run_main(), [])  # same pass, still within the awake allowance
        ok, msg = hc.check_msgs()
        self.assertFalse(ok)
        self.set_last_ok(30)
        self.assertEqual(self.run_main(), ["info"])  # a new pass recovers

    def test_main_save_error_isnt_followed_by_a_false_recovery(self):
        self.set_last_ok(3 * 3600)
        self.seen_for(100)
        self.assertEqual(self.run_main(), [])
        with mock.patch.object(hc, "_msgs_save", side_effect=OSError("read-only")):
            self.assertEqual(self.run_main(), ["attention"])
        self.awake(60)
        self.assertEqual(self.run_main(), [])
        with open(self.state) as f:
            self.assertIn("msgs", json.load(f)["failing"])

    def test_unmounted_volume(self):
        self.set_last_ok(600)
        hc.check_msgs()  # remember the last pass while the SSD is there
        with mock.patch.object(hc.os.path, "ismount", return_value=False):
            ok, msg = hc.check_msgs()
            self.assertTrue(ok, msg)  # an unplug or a wake: wait
            self.assertIn("paused", msg)
            self.awake(hc.MSGS_MAX_AGE + 60)
            ok, msg = hc.check_msgs()
        self.assertFalse(ok)
        self.assertIn("not mounted", msg)

    def test_unmounted_from_the_start(self):
        with mock.patch.object(hc.os.path, "ismount", return_value=False):
            ok, msg = hc.check_msgs()
        self.assertTrue(ok, msg)
        self.assertIn("no iMessage pass seen", msg)


if __name__ == "__main__":
    unittest.main()
