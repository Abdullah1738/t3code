"""health_check health_backup / person_backup: stalled health and offbox-person backups.

Runs on the system python, touches no real data and never sends Telegram:
  python3 -m unittest discover -s tests -p 'test_*.py'
"""
import json
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
sys.path.insert(0, SRC)

import health_check as hc  # noqa: E402


def write_status(path, last_success_ts, ok=True, stage="unchanged", message="fine"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump({"ok": ok, "stage": stage, "message": message,
                   "last_success_ts": last_success_ts, "ts": last_success_ts}, f)


class OtherBackups(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = self.tmp.name
        self.health = os.path.join(root, "health-backup", "backup_last.json")
        self.person_dir = os.path.join(root, "offbox-person", "state")
        patches = [mock.patch.object(hc, "HEALTH_BACKUP_STATUS", self.health),
                   mock.patch.object(hc, "PERSON_BACKUP_DIR", self.person_dir)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def now(self):
        return time.time()

    def test_health_fresh_ok(self):
        write_status(self.health, self.now() - 600)
        ok, msg = hc.check_health_backup()
        self.assertTrue(ok)
        self.assertIn("health ok", msg)

    def test_health_stale_fails_and_names_health(self):
        write_status(self.health, self.now() - 14 * 3600)
        ok, msg = hc.check_health_backup()
        self.assertFalse(ok)
        self.assertIn("health", msg)

    def test_health_missing_fails(self):
        ok, msg = hc.check_health_backup()
        self.assertFalse(ok)
        self.assertIn("no health backup status", msg)

    def test_health_ok_false_with_recent_success_passes(self):
        # the backup script alerts its own failures; this check only watches for stalls
        write_status(self.health, self.now() - 3600, ok=False, stage="dropbox", message="boom")
        self.assertTrue(hc.check_health_backup()[0])

    def test_person_fresh_and_stale_names_only_stale(self):
        write_status(os.path.join(self.person_dir, "moni-backup.json"), self.now() - 600)
        write_status(os.path.join(self.person_dir, "other-backup.json"), self.now() - 14 * 3600,
                     ok=True, stage="unchanged", message="old")
        ok, msg = hc.check_person_backups()
        self.assertFalse(ok)
        self.assertIn("other", msg)
        self.assertNotIn("moni", msg)

    def test_person_empty_dir_fails(self):
        os.makedirs(self.person_dir)
        ok, msg = hc.check_person_backups()
        self.assertFalse(ok)
        self.assertIn("no offbox-person backup status", msg)

    def test_person_missing_dir_passes(self):
        ok, msg = hc.check_person_backups()
        self.assertTrue(ok)
        self.assertEqual(msg, "no offbox-person backups")

    def test_person_ignores_lock_and_log_files(self):
        write_status(os.path.join(self.person_dir, "moni-backup.json"), self.now() - 600)
        os.makedirs(os.path.join(self.person_dir, "moni-backup.lock"))
        with open(os.path.join(self.person_dir, "moni-backup.log"), "w") as f:
            f.write("not json\n")
        with open(os.path.join(self.person_dir, "moni-backup.stamp"), "w") as f:
            f.write("0\n")
        ok, msg = hc.check_person_backups()
        self.assertTrue(ok)
        self.assertIn("moni ok", msg)


if __name__ == "__main__":
    unittest.main()
