import contextlib
import io
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.modules.setdefault("mail_oauth", types.ModuleType("mail_oauth"))

import common
import msgs
import search
import store
import timing
import whatsapp_sync


class DeletedIndexTest(unittest.TestCase):
    def test_upgrade_keeps_results_and_covers_deleted_queries(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, MSGS_ROOT=root), \
                patch.object(common, "ROOT", root), patch.object(common, "DB_PATH", root + "/index.db"):
            db = store.connect()
            db.execute("DROP INDEX items_deleted")
            for account, ext, deleted in [("icloud", "INBOX:7:1", None), ("icloud", "INBOX:7:2", 1),
                                          ("icloud", "Archive:8:3", 2), ("icloud", "INBOX:7:é", 3),
                                          ("outlook", "INBOX:7:2", 1)]:
                store.upsert(db, dict(source="email", account=account, ext_id=ext,
                                     body="needle", ts=1, deleted_at=deleted))
            db.commit()
            before = {q: [r["id"] for r in search.run(db, q)]
                      for q in ("needle", "needle is:deleted", "account:icloud needle")}
            db.close()
            db = store.connect()
            try:
                for prefix, expected in [(None, {"INBOX:7:2", "Archive:8:3", "INBOX:7:é"}),
                                         ("", {"INBOX:7:2", "Archive:8:3", "INBOX:7:é"}),
                                         ("INBOX:7:", {"INBOX:7:2", "INBOX:7:é"}),
                                         ("INBOX:8:", set())]:
                    with self.subTest(prefix=prefix):
                        statements = []
                        # Capture the actual helper query, then use its bound values for EQP.
                        class Capture:
                            def execute(self, sql, args):
                                statements.append((sql, args))
                                return db.execute(sql, args)
                        self.assertEqual(store.deleted_ext_ids(Capture(), "email", "icloud", prefix), expected)
                        sql, args = statements[0]
                        plan = db.execute("EXPLAIN QUERY PLAN " + sql, args).fetchall()
                        self.assertTrue(any("items_deleted" in r[3] for r in plan), plan)
                        ops = db.execute("EXPLAIN " + sql, args).fetchall()
                        table_root = db.execute("SELECT rootpage FROM sqlite_master WHERE name='items'").fetchone()[0]
                        table_cursors = {r[2] for r in ops if r[1] == "OpenRead" and r[3] == table_root}
                        self.assertFalse(any(r[1] == "Column" and r[2] in table_cursors for r in ops))
                for q, ids in before.items():
                    self.assertEqual([r["id"] for r in search.run(db, q)], ids)
                with store.writing(db):
                    store.undelete(db, "email", "icloud", {"INBOX:7:2"})
                    store.mark_deleted(db, "email", "icloud", {"INBOX:7:1"})
                self.assertEqual(store.deleted_ext_ids(db, "email", "icloud", "INBOX:7:"),
                                 {"INBOX:7:1", "INBOX:7:é"})
            finally:
                db.close()
            # A second startup is idempotent; older SQLite readers can still open the DB.
            store.connect().close()
            with contextlib.closing(sqlite3.connect(root + "/index.db")) as old:
                self.assertEqual(old.execute("SELECT count(*) FROM items").fetchone()[0], 5)


class TimingTest(unittest.TestCase):
    def setUp(self):
        self.metrics = timing.Pass("whatsapp")
        self.token = timing.CURRENT.set(self.metrics)

    def tearDown(self):
        timing.CURRENT.reset(self.token)

    def test_fetch_time_and_rows_include_all_cursor_consumption(self):
        db = sqlite3.connect(":memory:", factory=timing.SourceConnection)
        with patch.object(timing.time, "monotonic", side_effect=range(1000)):
            cur = db.execute("SELECT ? UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4", ("private body",))
            self.assertEqual(cur.fetchone(), ("private body",))
            self.assertEqual(cur.fetchmany(1), [(2,)])
            self.assertEqual(cur.fetchall(), [(3,), (4,)])
        self.assertEqual(list(db.execute("SELECT 5 UNION ALL SELECT 6")), [(5,), (6,)])
        summary = self.metrics.summary()
        self.assertEqual(summary["rows_read"], 6)
        self.assertEqual(summary["slow_sql"]["rows"], 4)
        self.assertGreater(summary["slow_sql"]["ms"], 0)
        self.assertGreater(summary["fetch_secs"], 0)
        self.assertNotIn("private body", str(summary))
        db.close()

    def test_overlapping_phase_intervals_count_once(self):
        with patch.object(timing.time, "monotonic", side_effect=[10, 17]):
            a, b = self.metrics.phase("fetch"), self.metrics.phase("fetch")
            a.__enter__()
            b.__enter__()
            a.__exit__(None, None, None)
            b.__exit__(None, None, None)
        self.assertEqual(self.metrics.summary()["fetch_secs"], 7)

    def test_pool_worker_inherits_pass_and_resets_context(self):
        @timing.timed("parse")
        def parse():
            self.assertIs(timing.CURRENT.get(), self.metrics)
        with ThreadPoolExecutor(1) as pool:
            pool.submit(timing.worker(parse)).result()
            self.assertIsNone(pool.submit(timing.CURRENT.get).result())
        self.assertIn("parse", self.metrics.phases)

    def test_lock_wait_is_separate_and_logged_over_sixty_seconds(self):
        class Lock:
            def acquire(self):
                clock[0] += 61
            def release(self):
                released.append(True)
        clock, released = [0], []
        with patch.object(timing.time, "monotonic", side_effect=lambda: clock[0]), \
                patch.object(common, "log") as log:
            with timing.write_lock(Lock()):
                clock[0] += 2
        self.assertEqual(self.metrics.summary()["lock_wait_secs"], 61)
        self.assertEqual(self.metrics.summary()["db_write_secs"], 2)
        log.assert_called_once_with("whatsapp: lock wait 61.0s")
        self.assertEqual(released, [True])

    def test_fast_empty_pass_is_logged_with_all_phases(self):
        stop = threading.Event()
        def sync(*args, **kwargs):
            stop.set()
            return dict(added=0, updated=0, deleted=0, same=0, **self.metrics.summary())
        output = io.StringIO()
        with patch.object(msgs, "sync_one", side_effect=sync), patch.object(common, "volume_ready", return_value=True), \
                contextlib.redirect_stderr(output):
            msgs._loop("whatsapp", 30, stop)
        lines = output.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        for field in ("whatsapp:", "lock_wait_secs", "fetch_secs", "parse_secs", "db_write_secs", "slow_sql", "rows_read"):
            self.assertIn(field, lines[0])

    def test_connection_failure_releases_source_lock_and_context(self):
        lk = unittest.mock.Mock()
        with patch.object(msgs, "lock", return_value=lk), patch.object(common, "require_volume"), \
                patch.object(store, "connect", side_effect=RuntimeError("offline")):
            with self.assertRaisesRegex(RuntimeError, "offline"):
                msgs.sync_one("whatsapp")
        lk.close.assert_called_once()
        self.assertIs(timing.CURRENT.get(), self.metrics)

    def test_failed_pass_logs_phases_and_restores_context(self):
        stop = threading.Event()
        def fail(*args, **kwargs):
            stop.set()
            raise RuntimeError("offline")
        with patch.object(msgs, "sync_one", side_effect=fail), patch.object(common, "volume_ready", return_value=True), \
                patch.object(common, "log") as log:
            msgs._loop("whatsapp", 30, stop)
        line = log.call_args.args[0]
        self.assertIn("ERROR RuntimeError: offline", line)
        self.assertIn("slow_sql", line)
        self.assertIn("lock_wait_secs", line)
        self.assertIs(timing.CURRENT.get(), self.metrics)

    def test_sync_wall_time_includes_connection_close(self):
        clock = [0]
        def close():
            clock[0] += 3
        db = unittest.mock.Mock()
        db.close.side_effect = close
        with patch.object(common, "require_volume"), patch.object(msgs, "lock"), \
                patch.object(store, "connect", return_value=db), \
                patch.object(whatsapp_sync, "sync", return_value={"added": 0}), \
                patch.object(timing.time, "monotonic", side_effect=lambda: clock[0]):
            metrics = timing.Pass("whatsapp")
            token = timing.CURRENT.set(metrics)
            try:
                result = msgs.sync_one("whatsapp")
            finally:
                timing.CURRENT.reset(token)
        self.assertEqual(result["secs"], 3)
        self.assertEqual(result["db_write_secs"], 3)


if __name__ == "__main__":
    unittest.main()
