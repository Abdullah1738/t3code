"""wal_truncate.py resets a capture WAL without ever waiting on a reader."""

import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))
import wal_truncate  # noqa: E402


def capture_writer(path):
    """Open a writer configured like the capture scripts (no auto-checkpoint)."""
    con = sqlite3.connect(path, isolation_level=None)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA wal_autocheckpoint=0")
    if hasattr(con, "setconfig") and hasattr(sqlite3, "SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE"):
        con.setconfig(sqlite3.SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, True)
    con.execute("CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, v BLOB)")
    return con


def fill(con, rows=400):
    con.execute("BEGIN")
    con.executemany("INSERT INTO t(v) VALUES(?)", [(os.urandom(4000),) for _ in range(rows)])
    con.execute("COMMIT")


class WalTruncateTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.dir.name, "memory.db")

    def tearDown(self):
        self.dir.cleanup()

    def test_truncates_wal_left_by_capture_writer(self):
        writer = capture_writer(self.db)
        fill(writer)
        writer.close()  # NO_CKPT_ON_CLOSE: WAL survives the writer
        self.assertGreater(wal_truncate.wal_bytes(self.db), 1_000_000)
        result = wal_truncate.truncate(self.db)
        self.assertTrue(result["truncated"], result)
        self.assertEqual(result["wal_after"], 0)
        with sqlite3.connect(self.db) as check:
            self.assertEqual(check.execute("SELECT count(*) FROM t").fetchone()[0], 400)

    def test_reader_snapshot_does_not_block_or_lose_data(self):
        writer = capture_writer(self.db)
        fill(writer, 50)
        reader = sqlite3.connect(self.db, isolation_level=None)
        reader.execute("BEGIN")
        reader.execute("SELECT count(*) FROM t").fetchone()  # pins a snapshot
        fill(writer, 50)  # frames after the reader's mark stay pinned
        started = time.monotonic()
        result = wal_truncate.truncate(self.db)
        self.assertLess(time.monotonic() - started, 2)
        self.assertFalse(result["truncated"], result)
        self.assertGreater(result["wal_after"], 0)
        reader.execute("COMMIT")
        reader.close()
        self.assertTrue(wal_truncate.truncate(self.db)["truncated"])
        self.assertEqual(wal_truncate.wal_bytes(self.db), 0)
        writer.close()
        with sqlite3.connect(self.db) as check:
            self.assertEqual(check.execute("SELECT count(*) FROM t").fetchone()[0], 100)

    def test_open_write_transaction_reports_busy(self):
        writer = capture_writer(self.db)
        fill(writer, 20)
        writer.execute("BEGIN IMMEDIATE")
        writer.execute("INSERT INTO t(v) VALUES(x'00')")
        result = wal_truncate.truncate(self.db)
        self.assertFalse(result["truncated"], result)
        writer.execute("ROLLBACK")
        writer.close()

    def test_cli_never_fails_tick(self):
        missing = os.path.join(self.dir.name, "missing.db")
        not_wal = os.path.join(self.dir.name, "plain.db")
        sqlite3.connect(not_wal).execute("CREATE TABLE x(a)").connection.close()
        out = subprocess.run([sys.executable, str(SRC / "wal_truncate.py"), missing, not_wal],
                             capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        lines = [l for l in out.stdout.splitlines() if l.startswith("WAL ")]
        self.assertEqual(len(lines), 2)
        self.assertIn('"skipped": "missing"', lines[0])
        self.assertIn("journal_mode=delete", lines[1])
        self.assertFalse(os.path.exists(missing))


if __name__ == "__main__":
    unittest.main()
