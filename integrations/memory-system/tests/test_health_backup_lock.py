"""health_check backup_lock: a hung or dead backup run holding logs/backup.lock.

Runs on the system python, touches no real data and never sends Telegram:
  python3 -m unittest discover -s tests -p 'test_*.py'
"""
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
sys.path.insert(0, SRC)

import health_check as hc  # noqa: E402


class BackupLock(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.logs = self.tmp.name
        self.lock = os.path.join(self.logs, "backup.lock")
        self.procs = []
        patches = [mock.patch.object(hc, "LOGS", self.logs),
                   mock.patch.object(hc, "STATE", os.path.join(self.logs, "health_state.json")),
                   mock.patch.object(hc, "LAST", os.path.join(self.logs, "health_last.json"))]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        for p in self.procs:
            p.kill()
            p.wait()
        self.tmp.cleanup()

    def make_lock(self, pid, age_s):
        os.mkdir(self.lock)
        if pid is not None:
            with open(os.path.join(self.lock, "pid"), "w") as f:
                f.write(f"{pid}\n")
        t = time.time() - age_s
        os.utime(self.lock, (t, t))

    def fake_backup(self):
        # argv contains memory_backup.sh, like the real `bash memory_backup.sh`
        p = subprocess.Popen(["bash", "-c", "sleep 60; :", "memory_backup.sh"])
        self.procs.append(p)
        return p.pid

    def dead_pid(self):
        p = subprocess.Popen(["true"])
        p.wait()
        return p.pid

    def test_no_lock_ok(self):
        self.assertTrue(hc.check_backup_lock()[0])

    def test_live_run_under_limit_ok(self):
        self.make_lock(self.fake_backup(), 30 * 60)
        self.assertTrue(hc.check_backup_lock()[0])

    def test_live_run_between_old_and_new_limits_ok(self):
        self.make_lock(self.fake_backup(), 3 * 3600 + 30 * 60)
        self.assertTrue(hc.check_backup_lock()[0])

    def test_live_run_over_limit_fails_and_is_not_killed(self):
        pid = self.fake_backup()
        self.make_lock(pid, 5 * 3600)
        ok, msg = hc.check_backup_lock()
        self.assertFalse(ok)
        self.assertIn(f"PID {pid} still running", msg)
        self.assertIn("should have timed out by itself", msg)
        self.assertIn("logs/backup-YYYYMM.log", msg)
        self.assertIsNone(self.procs[0].poll())
        self.assertTrue(os.path.isdir(self.lock))

    def test_dead_holder_fails(self):
        self.make_lock(self.dead_pid(), 10 * 60)
        ok, msg = hc.check_backup_lock()
        self.assertFalse(ok)
        self.assertIn("died without releasing", msg)

    def test_reused_pid_counts_as_dead(self):
        # a live process that is not a backup run (pid reuse)
        p = subprocess.Popen(["sleep", "60"])
        self.procs.append(p)
        self.make_lock(p.pid, 10 * 60)
        self.assertFalse(hc.check_backup_lock()[0])

    def test_lock_being_taken_ok(self):
        self.make_lock(None, 5)
        self.assertTrue(hc.check_backup_lock()[0])

    def test_alerts_once_per_day_while_stuck(self):
        self.make_lock(self.fake_backup(), 5 * 3600)
        with mock.patch.object(hc, "CHECKS", [("backup_lock", hc.check_backup_lock)]), \
                mock.patch.object(hc, "notify", return_value=True) as notify, \
                mock.patch.object(sys, "argv", ["health_check.py"]):
            hc.main()
            hc.main()
            hc.main()
        self.assertEqual(notify.call_count, 1)
        severity, text, key = notify.call_args.args
        self.assertEqual(severity, "error")
        self.assertIn("backup_lock", text)
        self.assertIn("backup_lock@", key)


if __name__ == "__main__":
    unittest.main()
