"""Capture budget tests use only scratch SQLite connections and fake clocks."""
import os
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), "src"))
from capture_budget import Budget, Exhausted, checkpoint, setup_writer, with_retry


class CaptureBudgetTest(unittest.TestCase):
    def test_writer_settings_and_callback_compatibility(self):
        con = setup_writer(sqlite3.connect(":memory:"))
        self.addCleanup(con.close)
        con.execute("CREATE TABLE t(value)")
        self.assertEqual(con.execute("PRAGMA busy_timeout").fetchone(), (100,))
        self.assertEqual(con.execute("PRAGMA wal_autocheckpoint").fetchone(), (0,))
        self.assertEqual(with_retry(con, lambda: 42), 42)

    def test_expiry_before_commit_rolls_back(self):
        clock = [0]
        budget = Budget(1, clock=lambda: clock[0])
        con = setup_writer(sqlite3.connect(":memory:"), budget)
        self.addCleanup(con.close)
        con.execute("CREATE TABLE t(value)")
        def write():
            con.execute("INSERT INTO t VALUES(1)")
            clock[0] = 2
        with self.assertRaises(Exhausted):
            with_retry(con, write, budget=budget)
        con.set_progress_handler(None, 0)
        self.assertFalse(con.in_transaction)
        self.assertEqual(con.execute("SELECT * FROM t").fetchall(), [])

    def test_source_query_is_interrupted_at_budget(self):
        clock = [0]
        budget = Budget(1, clock=lambda: clock[0])
        con = sqlite3.connect(":memory:")
        self.addCleanup(con.close)
        with self.assertRaises(Exhausted), budget.sql(con):
            clock[0] = 2
            con.execute("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000) SELECT sum(x) FROM n").fetchone()
        self.assertEqual(con.execute("SELECT 1").fetchone(), (1,))

    def test_busy_retry_obeys_budget_without_real_sleep(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "fixture.sqlite")
            first = setup_writer(sqlite3.connect(path))
            second = setup_writer(sqlite3.connect(path))
            try:
                first.execute("CREATE TABLE t(value)")
                first.execute("BEGIN IMMEDIATE")
                clock = [0]
                budget = Budget(1, clock=lambda: clock[0])
                with patch("capture_budget.time.sleep", side_effect=lambda _: clock.__setitem__(0, 2)):
                    with self.assertRaises(Exhausted):
                        with_retry(second, lambda: second.execute("INSERT INTO t VALUES(1)"), budget=budget)
                self.assertFalse(second.in_transaction)
            finally:
                first.close()
                second.close()

    def test_checkpoint_does_not_wait_for_reader(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "fixture.sqlite")
            writer = setup_writer(sqlite3.connect(path))
            reader = sqlite3.connect(path)
            try:
                writer.execute("PRAGMA journal_mode=WAL")
                with_retry(writer, lambda: writer.execute("CREATE TABLE t(value)"))
                reader.execute("BEGIN")
                reader.execute("SELECT * FROM t").fetchall()
                with_retry(writer, lambda: writer.execute("INSERT INTO t VALUES(1)"))
                result = checkpoint(writer)
                self.assertLess(result[2], result[1])
                reader.rollback()
                checkpoint(writer)
                self.assertEqual(os.path.getsize(path + "-wal"), 0)
            finally:
                reader.close()
                writer.close()
