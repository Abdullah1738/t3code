"""health_check native capture per root, and the cleanupPeriodDays assertion.

Temp dirs only; never touches real data or sends Telegram:
  python3 -m unittest discover -s tests -p 'test_health_native.py' -v
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
import transcript_roots as tr  # noqa: E402


class NativeHealth(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.homes = os.path.join(self.tmp.name, "harness-homes")
        self.ledger = os.path.join(self.tmp.name, "memory.db")
        self.settings = os.path.join(self.tmp.name, "settings.json")
        self.now = 1_800_000_000.0
        # fake ledger (D1's native_capture_files stand-in)
        c = sqlite3.connect(self.ledger)
        c.execute("CREATE TABLE native_capture_files (path TEXT PRIMARY KEY, offset INTEGER, "
                  "error_count INTEGER DEFAULT 0, error_since REAL, last_error TEXT, "
                  "consumed_at REAL, alias_refreshed_at REAL)")
        c.commit()
        c.close()
        patches = [
            mock.patch.object(tr, "HARNESS_HOMES", self.homes),
            mock.patch.object(hc, "NATIVE_LEDGER", self.ledger),
            mock.patch.object(hc, "_native_enabled", lambda inst: True),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        # every root exists unless a test removes it
        for d in ("claude/projects", "codex/sessions", "codex/archived_sessions",
                  "codex-cu/sessions", "codex-cu/archived_sessions"):
            os.makedirs(os.path.join(self.homes, d), exist_ok=True)

    def transcript(self, rel, data):
        path = os.path.join(self.homes, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        return path

    def record(self, path, offset, **extra):
        c = sqlite3.connect(self.ledger)
        row = {"path": path, "offset": offset, "error_count": 0, "consumed_at": self.now,
               "alias_refreshed_at": self.now}
        row.update(extra)
        c.execute("INSERT OR REPLACE INTO native_capture_files (path, offset, error_count, error_since, "
                  "last_error, consumed_at, alias_refreshed_at) VALUES (?,?,?,?,?,?,?)",
                  (row["path"], row["offset"], row["error_count"], row.get("error_since"),
                   row.get("last_error"), row["consumed_at"], row["alias_refreshed_at"]))
        c.commit()
        c.close()

    def problems(self):
        _, probs = hc.native_roots_report(now=self.now)
        return probs

    def test_missing_enabled_root_is_unhealthy(self):
        os.rmdir(os.path.join(self.homes, "codex-cu/archived_sessions"))
        os.rmdir(os.path.join(self.homes, "codex-cu/sessions"))
        os.rmdir(os.path.join(self.homes, "codex-cu"))
        self.assertTrue(any("codex-cu: enabled root missing" in p for p in self.problems()))

    def test_missing_root_disabled_instance_is_healthy(self):
        os.rmdir(os.path.join(self.homes, "codex-cu/archived_sessions"))
        os.rmdir(os.path.join(self.homes, "codex-cu/sessions"))
        os.rmdir(os.path.join(self.homes, "codex-cu"))
        with mock.patch.object(hc, "_native_enabled", lambda inst: False if inst == "codex-cu" else True):
            self.assertEqual(self.problems(), [])

    def test_growing_uncaptured_file_with_newline_is_unhealthy(self):
        p = self.transcript("codex/sessions/s.jsonl", b'{"a":1}\n{"a":2}\n')
        self.record(p, 0, consumed_at=self.now - 16 * 60)
        self.assertTrue(any("captured-pending bytes" in x for x in self.problems()), self.problems())

    def test_incomplete_tail_is_healthy(self):
        p = self.transcript("codex/sessions/s.jsonl", b'{"a":1}\n{"partial":')
        # offset ends at the complete line; the tail has no newline yet
        self.record(p, len(b'{"a":1}\n'), consumed_at=self.now - 3600)
        self.assertEqual(self.problems(), [])

    def test_error_quarantine_over_30_min_is_unhealthy(self):
        p = self.transcript("claude/projects/p/s.jsonl", b'{"a":1}\n')
        self.record(p, 0, error_count=2, error_since=self.now - 31 * 60, last_error="parse")
        self.assertTrue(any("quarantined" in x for x in self.problems()))

    def test_error_quarantine_under_30_min_is_healthy(self):
        p = self.transcript("claude/projects/p/s.jsonl", b'{"a":1}\n')
        self.record(p, 0, error_count=1, error_since=self.now - 5 * 60, last_error="parse")
        self.assertEqual(self.problems(), [])

    def test_stale_alias_refresh_is_unhealthy(self):
        p = self.transcript("codex/sessions/s.jsonl", b'{"a":1}\n')
        self.record(p, len(b'{"a":1}\n'), alias_refreshed_at=self.now - 16 * 60)
        self.assertTrue(any("thread_aliases not refreshed" in x for x in self.problems()))

    def test_cleanup_period_30_is_unhealthy(self):
        with open(self.settings, "w") as f:
            json.dump({"cleanupPeriodDays": 30}, f)
        with mock.patch.object(hc, "CLAUDE_SETTINGS", self.settings):
            ok, msg = hc.check_claude_retention()
        self.assertFalse(ok)
        self.assertIn("cleanupPeriodDays is 30", msg)

    def test_cleanup_period_36500_is_healthy(self):
        with open(self.settings, "w") as f:
            json.dump({"cleanupPeriodDays": 36500}, f)
        with mock.patch.object(hc, "CLAUDE_SETTINGS", self.settings):
            ok, _ = hc.check_claude_retention()
        self.assertTrue(ok)


if __name__ == "__main__":
    unittest.main()
