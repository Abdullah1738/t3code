"""Native health tests use temporary roots and D1's capture/identity ledger shape."""
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from unittest import mock

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
sys.path.insert(0, SRC)
import health_check as hc
import transcript_roots as roots

PRODUCTION_SETTINGS = hc.ROBOB_SETTINGS
DDL = """
CREATE TABLE native_capture_files (
 rep_id INTEGER PRIMARY KEY, path TEXT, inode INTEGER, offset INTEGER, phys_size INTEGER,
 complete INTEGER, error_count INTEGER, retired INTEGER DEFAULT 0);
CREATE TABLE thread_aliases (alias_key TEXT PRIMARY KEY, last_seen INTEGER);
"""



def fake_entries(homes):
    """D1 manifest entries (transcript_roots.json shape) rooted in a temp dir."""
    return [{"driver": "claudeAgent", "instance": "claudeAgent", "root": os.path.join(homes, "claude")},
            {"driver": "codex", "instance": "codex", "root": os.path.join(homes, "codex")},
            {"driver": "codex", "instance": "codex-cu", "root": os.path.join(homes, "codex-cu")}]

class NativeHealth(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.homes = os.path.join(self.tmp.name, "homes")
        self.ledger = os.path.join(self.tmp.name, "memory.db")
        self.settings = os.path.join(self.tmp.name, "settings.json")
        self.claude_settings = os.path.join(self.tmp.name, "claude.json")
        self.now = 1_800_000_000
        self.seen = {}
        self.write_settings()
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.executescript(DDL)
            con.execute("INSERT INTO thread_aliases VALUES ('alias', ?)", (self.now,))
        patches = [mock.patch.object(roots, "load", return_value=fake_entries(self.homes)),
                   mock.patch.object(hc, "NATIVE_LEDGER", self.ledger),
                   mock.patch.object(hc, "ROBOB_SETTINGS", self.settings),
                   mock.patch.object(hc, "CLAUDE_SETTINGS", self.claude_settings)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        for directory in ("claude/projects", "codex/sessions", "codex/archived_sessions",
                          "codex-cu/sessions", "codex-cu/archived_sessions"):
            os.makedirs(os.path.join(self.homes, directory), exist_ok=True)
        # An empty ledger is not evidence that the enabled captures have run.
        for rel in ("claude/projects/p/base.jsonl", "codex/sessions/base.jsonl",
                    "codex-cu/sessions/base.jsonl"):
            path = self.write(rel, b"{}\n")
            self.capture(path, 3)

    def write_settings(self, claude=True, codex=True, codex_cu=True):
        with open(self.settings, "w") as f:
            json.dump({"providerInstances": {
                "claudeAgent": {"driver": "claudeAgent", "enabled": claude, "config": {}},
                "codex": {"driver": "codex", "enabled": codex, "config": {}},
                "codex-cu": {"driver": "codex", "enabled": codex_cu, "config": {}},
            }}, f)

    def write(self, rel, data):
        path = os.path.join(self.homes, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        return path

    def capture(self, path, offset, size=None, complete=1, errors=0):
        st = os.stat(path)
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.execute("DELETE FROM native_capture_files WHERE path=?", (path,))
            con.execute("INSERT INTO native_capture_files(path,inode,offset,phys_size,complete,error_count) "
                        "VALUES (?,?,?,?,?,?)", (path, st.st_ino, offset, st.st_size if size is None else size,
                                                 complete, errors))

    def report(self, now=None):
        return hc.native_roots_report(now=self.now if now is None else now, seen=self.seen)

    def problems(self, now=None):
        return self.report(now)[1]

    def test_real_settings_path(self):
        self.assertEqual(PRODUCTION_SETTINGS, os.path.join(os.path.expanduser("~"), ".robob/userdata/settings.json"))

    def test_enabled_missing_root_fails(self):
        missing = os.path.join(self.homes, "new-codex")
        with mock.patch.object(roots, "resolve", return_value=[
                {"instance": "codex", "driver": "codex", "root": missing, "exists": False}]):
            self.assertTrue(any("root missing" in p for p in self.problems()))

    def test_disabled_never_created_root_from_real_settings_is_exempt(self):
        self.write_settings(codex_cu=False)
        missing = os.path.join(self.homes, "never-created")
        with mock.patch.object(roots, "resolve", return_value=[
                {"instance": "codex-cu", "driver": "codex", "root": missing, "exists": False}]):
            self.assertEqual(self.problems(), [])

    def test_disappeared_disabled_root_is_not_exempt(self):
        root = os.path.realpath(os.path.join(self.homes, "was-here"))
        self.seen["roots"] = [root]
        self.write_settings(codex_cu=False)
        with mock.patch.object(roots, "resolve", return_value=[
                {"instance": "codex-cu", "driver": "codex", "root": root, "exists": False}]):
            self.assertTrue(any("root missing" in p for p in self.problems()))

    def test_missing_and_empty_ledger_fail(self):
        with mock.patch.object(hc, "NATIVE_LEDGER", os.path.join(self.tmp.name, "missing.db")):
            self.assertTrue(any("ledger missing" in p for p in self.problems()))
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.execute("DELETE FROM native_capture_files")
        self.assertTrue(any("no capture ledger entries" in p for p in self.problems()))

    def test_alias_watermark_read_from_real_table(self):
        self.assertEqual(self.problems(), [])
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.execute("UPDATE thread_aliases SET last_seen=?", (self.now - 901,))
        self.assertTrue(any("thread_aliases refresh stale" in p for p in self.problems()))
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.execute("DELETE FROM thread_aliases")
        self.assertTrue(any("no thread_aliases refresh" in p for p in self.problems()))

    def test_untracked_growing_complete_file_fails_immediately(self):
        path = self.write("codex/sessions/growing.jsonl", b"{}\n")
        os.utime(path, (self.now, self.now))
        self.assertTrue(any("pending bytes" in p for p in self.problems()))
        with open(path, "ab") as f:
            f.write(b"{}\n")
        os.utime(path, (self.now + 901, self.now + 901))
        self.assertTrue(any("pending bytes" in p for p in self.problems(self.now + 901)))

    def test_incomplete_tail_is_healthy(self):
        path = self.write("codex/sessions/incomplete.jsonl", b'{}\n{"partial"')
        self.capture(path, 3)
        self.assertEqual(self.problems(), [])

    def test_fresh_append_after_idle_is_not_old(self):
        path = self.write("codex/sessions/idle.jsonl", b"{}\n")
        self.capture(path, 3)
        self.assertEqual(self.problems(), [])
        with open(path, "ab") as f:
            f.write(b"{}\n")
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.execute("UPDATE thread_aliases SET last_seen=?", (self.now + 3600,))
        self.assertEqual(self.problems(self.now + 3600), [])

    def test_partial_progress_does_not_reset_oldest_pending_time(self):
        path = self.write("codex/sessions/partial.jsonl", b"{}\n")
        self.capture(path, 3)
        self.problems()
        with open(path, "ab") as f:
            f.write(b"{}\n{}\n")
        self.problems(self.now + 1)
        self.capture(path, 6)  # consumed one line, old observed boundary still outstanding
        with open(path, "ab") as f:
            f.write(b"{}\n")
        self.assertTrue(any("pending bytes" in p for p in self.problems(self.now + 902)))

    def test_error_quarantine_older_than_30_minutes(self):
        path = self.write("claude/projects/p/error.jsonl", b"{}\n")
        self.capture(path, 3, errors=1)
        self.problems()
        self.assertTrue(any("capture errors" in p for p in self.problems(self.now + 1801)))

    def test_compressed_pending_and_error_are_checked(self):
        path = self.write("codex/sessions/rollout.jsonl.zst", b"compressed bytes")
        self.capture(path, 0, complete=0, errors=1)
        self.assertTrue(any("pending bytes" in p for p in self.problems()))
        self.assertTrue(any("capture errors" in p for p in self.problems(self.now + 1801)))
        self.capture(path, 100, complete=1, errors=0)
        self.assertFalse(any("rollout.jsonl.zst" in p for p in self.problems()))

    def test_cleanup_period(self):
        with open(self.claude_settings, "w") as f:
            json.dump({"cleanupPeriodDays": 30}, f)
        self.assertFalse(hc.check_claude_retention()[0])
        with open(self.claude_settings, "w") as f:
            json.dump({"cleanupPeriodDays": 36500}, f)
        self.assertTrue(hc.check_claude_retention()[0])


if __name__ == "__main__":
    unittest.main()
