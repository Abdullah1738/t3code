import contextlib
import fcntl
import importlib.util
import os
from pathlib import Path
import plistlib
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.modules.setdefault("mail_oauth", types.ModuleType("mail_oauth"))

import common
import gmail_sync
import imap_sync
import msgs
import store
import timing


class FairLockTest(unittest.TestCase):
    def test_abandoned_ticket_does_not_wedge_later_fifo_waiters(self):
        lock = store.FairLock()
        lock.acquire()
        queued = {name: threading.Event() for name in ("abandon", "second", "third")}
        order, errors = [], []
        original_wait = lock._cv.wait

        def wait(timeout=None):
            queued[threading.current_thread().name].set()
            return original_wait(timeout)

        def run(name, timeout):
            try:
                lock.acquire(timeout=timeout)
                order.append(name)
                lock.release()
            except store.LockTimeout:
                errors.append(name)

        threads = []
        with patch.object(lock._cv, "wait", side_effect=wait):
            try:
                for name, timeout in (("abandon", .05), ("second", 1), ("third", 1)):
                    thread = threading.Thread(target=run, args=(name, timeout), name=name)
                    thread.start()
                    threads.append(thread)
                    self.assertTrue(queued[name].wait(1))
                threads[0].join(1)
                self.assertEqual(errors, ["abandon"])
            finally:
                lock.release()
                for thread in threads:
                    thread.join(1)
        self.assertEqual(order, ["second", "third"])
        self.assertTrue(lock.acquire(timeout=0))
        lock.release()
        self.assertEqual(lock._abandoned, set())

    def test_interrupted_waiter_also_abandons_its_ticket(self):
        lock = store.FairLock()
        lock.acquire()
        with patch.object(lock._cv, "wait", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                lock.acquire(timeout=1)
        lock.release()
        self.assertTrue(lock.acquire(timeout=0))
        lock.release()

    def test_long_hold_logged_once_while_held_and_longest_hold_in_stats(self):
        clock = [0]
        metrics = timing.Pass("imessage")
        token = timing.CURRENT.set(metrics)
        lock = store.FairLock()
        try:
            with patch.object(store.time, "monotonic", side_effect=lambda: clock[0]), patch.object(common, "log") as log:
                with timing.write_lock(lock, timeout=1):
                    clock[0] = 61
                    lock.check_hold()
                    clock[0] = 90
                    lock.check_hold()
                log.assert_called_once()
                self.assertIn("write lock held 61.0s by imessage in db_write", log.call_args.args[0])
                with timing.write_lock(lock, timeout=1):
                    clock[0] += 2
                self.assertEqual(metrics.summary()["lock_hold_secs"], 90)
        finally:
            timing.CURRENT.reset(token)

    def test_holder_phase_ignores_concurrent_fetch_and_release_reports_write_phase(self):
        clock, ready, finish = [0], threading.Event(), threading.Event()
        metrics = timing.Pass("outlook")
        token = timing.CURRENT.set(metrics)
        lock = store.FairLock()
        def fetch():
            with timing.phase("fetch"):
                ready.set()
                finish.wait(1)
        thread = threading.Thread(target=timing.worker(fetch))
        thread.start()
        try:
            self.assertTrue(ready.wait(1))
            with patch.object(store.time, "monotonic", side_effect=lambda: clock[0]), patch.object(common, "log") as log:
                with timing.write_lock(lock, timeout=1):
                    clock[0] = 61
                    with timing.phase("db_read"):
                        lock.check_hold()
                self.assertIn("by outlook in db_read", log.call_args.args[0])
                with timing.write_lock(lock, timeout=1):
                    clock[0] += 61
                self.assertIn("by outlook in db_write", log.call_args.args[0])
                self.assertEqual(log.call_count, 2)
        finally:
            finish.set()
            thread.join(1)
            timing.CURRENT.reset(token)

    def test_release_also_reports_long_hold_if_watchdog_has_not_run(self):
        clock = [0]
        lock = store.FairLock()
        with patch.object(store.time, "monotonic", side_effect=lambda: clock[0]), patch.object(common, "log") as log:
            lock.acquire()
            clock[0] = 61
            lock.release()
        log.assert_called_once()


class WriterTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        root = self.root.name
        for target, attr, value in [(common, "ROOT", root), (common, "DB_PATH", root + "/index.db"),
                                     (store, "WRITE", store.FairLock())]:
            self.enterContext(patch.object(target, attr, value))
        self.enterContext(patch.dict(os.environ, MSGS_ROOT=root))
        self.db = store.connect()
        self.addCleanup(self.db.close)

    def test_writing_and_connect_timeout_identify_holder_and_later_writes_work(self):
        held, release = threading.Event(), threading.Event()

        def holder():
            token = timing.CURRENT.set(timing.Pass("gmail"))
            try:
                store.WRITE.acquire()
                held.set()
                release.wait(1)
                store.WRITE.release()
            finally:
                timing.CURRENT.reset(token)

        thread = threading.Thread(target=holder, name="gmail")
        thread.start()
        try:
            self.assertTrue(held.wait(1))
            with patch.object(store, "LOCK_WAIT_SECONDS", .02):
                for operation in (lambda: store.writing(self.db).__enter__(), store.connect):
                    with self.subTest(operation=operation):
                        with self.assertRaises(store.LockTimeout) as raised:
                            operation()
                        self.assertEqual(raised.exception.holder, "gmail")
                        self.assertGreaterEqual(raised.exception.waited, .015)
                        self.assertGreaterEqual(raised.exception.held, .015)
        finally:
            release.set()
            thread.join(1)
        with store.writing(self.db):
            store.set_state(self.db, "after", True)
        self.assertTrue(store.get_state(self.db, "after"))

    def test_sqlite_busy_maps_to_lock_timeout_and_rolls_back(self):
        self.db.execute("PRAGMA busy_timeout=20")
        other = sqlite3.connect(common.DB_PATH)
        try:
            other.execute("BEGIN IMMEDIATE")
            with self.assertRaises(store.LockTimeout) as raised:
                with store.writing(self.db):
                    self.fail("entered a locked database")
            self.assertEqual(raised.exception.holder, "unknown")
            self.assertGreaterEqual(raised.exception.waited, .015)
            self.assertFalse(self.db.in_transaction)
        finally:
            other.rollback()
            other.close()
        with store.writing(self.db):
            store.set_state(self.db, "after", True)
        self.assertTrue(store.get_state(self.db, "after"))

    def test_startup_pragma_contention_maps_to_lock_timeout_and_closes_connection(self):
        self.db.close()
        other = sqlite3.connect(common.DB_PATH)
        self.addCleanup(other.close)
        other.execute("PRAGMA locking_mode=EXCLUSIVE")
        other.execute("BEGIN EXCLUSIVE")
        opened, statements = [], []

        class TrackedConnection(timing.Connection):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                opened.append(self)

            def execute(self, sql, parameters=()):
                statements.append(sql)
                return super().execute(sql, parameters)

        with patch.object(store, "SQLITE_WAIT_SECONDS", .02), \
                patch.object(timing, "Connection", TrackedConnection):
            with self.assertRaises(store.LockTimeout) as raised:
                store.connect()
        self.assertEqual(raised.exception.holder, "unknown")
        self.assertGreaterEqual(raised.exception.waited, .015)
        self.assertIn("PRAGMA cache_size=-131072", statements)
        self.assertNotIn("PRAGMA mmap_size=1073741824", statements)
        self.assertEqual(len(opened), 1)
        with self.assertRaises(sqlite3.ProgrammingError):
            opened[0].execute("SELECT 1")
        self.assertEqual(store.WRITE.snapshot()["source"], "unknown")
        other.close()
        with contextlib.closing(store.connect()) as recovered:
            with store.writing(recovered):
                store.set_state(recovered, "after_startup", True)
            self.assertTrue(store.get_state(recovered, "after_startup"))

    def test_sqlite_error_in_body_rolls_back_and_non_lock_errors_keep_type(self):
        for message, error in [("database is locked", store.LockTimeout),
                               ("database table is locked", store.LockTimeout),
                               ("database is busy", store.LockTimeout),
                               ("no such table", sqlite3.OperationalError)]:
            with self.subTest(message=message):
                with self.assertRaises(error):
                    with store.writing(self.db):
                        store.set_state(self.db, "rollback", True)
                        raise sqlite3.OperationalError(message)
                self.assertIsNone(store.get_state(self.db, "rollback"))
                self.assertEqual(store.WRITE.snapshot()["source"], "unknown")

    def test_writer_and_reader_use_separate_busy_timeouts(self):
        self.assertEqual(self.db.execute("PRAGMA busy_timeout").fetchone()[0], 30000)
        with contextlib.closing(store.connect(readonly=True)) as reader:
            self.assertEqual(reader.execute("PRAGMA busy_timeout").fetchone()[0], 250)

    def test_upsert_point_lookup_uses_unique_key_instead_of_scanning_items(self):
        queries = []
        db = self.db
        class Capture:
            def execute(self, sql, args):
                queries.append((sql, args))
                return db.execute(sql, args)
        with store.writing(self.db):
            store.upsert(Capture(), dict(source="imessage", account="imessage", ext_id="guid", ts=1))
        sql, args = queries[0]
        plan = [row[3] for row in self.db.execute("EXPLAIN QUERY PLAN " + sql, args)]
        self.assertTrue(any("SEARCH items USING INDEX sqlite_autoindex_items_1" in row for row in plan), plan)
        self.assertFalse(any("SCAN items" in row for row in plan), plan)

    def test_batches_yield_between_rows_when_io_is_slow_and_preserve_all_rows(self):
        clock, transactions = [0], []
        self.db.set_trace_callback(lambda sql: transactions.append(sql) if sql == "BEGIN IMMEDIATE" else None)

        def apply(n):
            store.set_state(self.db, str(n), n)
            clock[0] += 6

        with patch.object(store.time, "monotonic", side_effect=lambda: clock[0]), patch.object(common, "log"):
            store.write_batches(self.db, range(5), apply)
        self.assertEqual(len(transactions), 5)
        self.assertEqual([store.get_state(self.db, str(n)) for n in range(5)], list(range(5)))

    def test_upsert_batches_keep_rows_and_counts_and_cap_transaction_size(self):
        statements = []
        self.db.set_trace_callback(statements.append)
        items = [dict(source="imessage", account="imessage", ext_id=str(n), ts=n, body="hello") for n in range(205)]
        stats = dict(added=0, updated=0, same=0)
        store.upsert_many(self.db, items, stats)
        self.assertEqual(stats, dict(added=205, updated=0, same=0))
        sizes, count = [], 0
        for sql in statements:
            if sql == "BEGIN IMMEDIATE":
                count = 0
            elif sql.startswith("SELECT id, "):
                count += 1
            elif sql == "COMMIT":
                sizes.append(count)
        self.assertEqual(sizes, [100, 100, 5])
        store.upsert_many(self.db, items, stats)
        self.assertEqual(stats, dict(added=205, updated=0, same=205))
        self.assertEqual(self.db.execute("SELECT count(*) FROM items").fetchone()[0], 205)


class LoopTest(unittest.TestCase):
    def run_loop(self, errors):
        class Stop:
            waits = []
            def is_set(self):
                return len(self.waits) == len(errors)
            def wait(self, seconds):
                self.waits.append(seconds)
        stop = Stop()
        with patch.object(common, "volume_ready", return_value=True), patch.object(common, "log") as log, \
                patch.object(msgs, "sync_one", side_effect=errors):
            msgs._loop("gmail", 180, stop)
        return stop.waits, [call.args[0] for call in log.call_args_list]

    def test_lock_giveup_logs_and_resets_backoff_to_normal_interval(self):
        waits, logs = self.run_loop([RuntimeError("error"), store.LockTimeout(120, "imessage", 300),
                                     store.LockTimeout(120), {}])
        self.assertEqual(waits, [360, 180, 180, 180])
        self.assertIn("gmail: LOCK_GIVEUP waited=120.0s holder=imessage held=300.0s", logs)

    def test_source_flock_busy_is_logged_and_retried(self):
        waits, logs = self.run_loop([msgs.Locked("gmail")])
        self.assertEqual(waits, [180])
        self.assertIn("LOCK_GIVEUP", logs[0])

    def test_subprocess_timeout_is_transient_and_other_errors_cap_at_ten_minutes(self):
        waits, _ = self.run_loop([RuntimeError("error")] * 5 + [subprocess.TimeoutExpired("ortie", 30)] * 3)
        self.assertEqual(waits, [360, 600, 600, 600, 600, 180, 180, 180])

    def test_imap_does_not_swallow_lock_or_token_timeouts_as_skipped_folder(self):
        for error in [store.LockTimeout(120), subprocess.TimeoutExpired("ortie", 30)]:
            with self.subTest(error=error), patch.object(imap_sync, "Pool") as pool, \
                    patch.object(imap_sync, "ThreadPoolExecutor"), patch.object(imap_sync, "folders", return_value=["INBOX"]), \
                    patch.object(imap_sync, "_sync_folder", side_effect=error):
                with self.assertRaises(type(error)):
                    imap_sync.sync("outlook", Mock())
                pool.return_value.close.assert_called_once()

    def test_gmail_token_mutex_is_bounded_and_lock_timeout_is_not_a_skipped_message(self):
        api = gmail_sync.Api("gmail")
        with patch.object(store, "LOCK_WAIT_SECONDS", .01):
            api.lock.acquire()
            try:
                with self.assertRaises(store.LockTimeout):
                    api._token()
            finally:
                api.lock.release()
        api.get = Mock(side_effect=store.LockTimeout(120, "gmail"))
        with self.assertRaises(store.LockTimeout):
            gmail_sync._fetch(api, "gmail", "1", {}, "me")


class OAuthLockTest(unittest.TestCase):
    def setUp(self):
        path = Path(__file__).resolve().parents[2] / "local-helpers/libexec/mail/mail_oauth.py"
        spec = importlib.util.spec_from_file_location("fixture_mail_oauth", path)
        self.oauth = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.oauth)
        root = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(patch.object(self.oauth, "STATE_DIR", root))
        self.enterContext(patch.object(self.oauth, "seconds_left", return_value=None))
        self.enterContext(patch.object(self.oauth, "token_age", return_value=None))
        self.enterContext(patch.object(self.oauth, "get_token", return_value="fixture-token"))
        self.enterContext(patch.object(self.oauth, "log"))
        self.refresh_command = self.enterContext(patch.object(self.oauth.subprocess, "run",
                                                              return_value=Mock(returncode=0)))
        self.enterContext(patch.object(gmail_sync, "mail_oauth", self.oauth))
        self.enterContext(patch.object(imap_sync, "mail_oauth", self.oauth))
        self.enterContext(patch.object(store, "LOCK_WAIT_SECONDS", .02))

    def held_refresh_lock(self, acct, operation, error_type=store.LockTimeout):
        done, errors = threading.Event(), []
        def run():
            try:
                operation()
            except BaseException as e:
                errors.append(e)
            finally:
                done.set()

        with open(f"{self.oauth.STATE_DIR}/{acct}.lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            worker = threading.Thread(target=run)
            worker.start()
            try:
                self.assertTrue(done.wait(.5), "refresh lock wait was not bounded")
                self.assertEqual(len(errors), 1)
                self.assertIsInstance(errors[0], error_type)
                self.assertEqual(getattr(errors[0], "holder", "unknown"), "unknown")
                self.assertGreaterEqual(errors[0].waited, .015)
                self.refresh_command.assert_not_called()
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)
                worker.join(1)
        self.assertFalse(worker.is_alive())
        return errors[0]

    def test_gmail_proactive_and_401_refresh_give_up_and_can_retry(self):
        for acct in ("gmail", "fund", "juno"):
            for method in ("_token", "_renew"):
                with self.subTest(acct=acct, method=method):
                    self.refresh_command.reset_mock()
                    api = gmail_sync.Api(acct)
                    if method == "_renew":
                        api.token = "stale"
                    operation = api._token if method == "_token" else lambda: api._renew("stale")
                    self.held_refresh_lock(acct, operation)
                    self.assertEqual(api.checked, 0)
                    self.assertFalse(api.lock.locked())
                    operation()
                    self.assertEqual(api.token, "fixture-token")
                    self.refresh_command.assert_called_once()

    def test_outlook_auth_heal_refresh_gives_up_and_can_retry(self):
        with patch.object(self.oauth, "_v4_addrs", return_value=[]), \
                patch.object(self.oauth.os.path, "expanduser", return_value=f"{self.oauth.STATE_DIR}/good-ip"), \
                patch.object(self.oauth.imaplib, "IMAP4_SSL") as connection:
            connection.return_value.authenticate.side_effect = imap_sync.imaplib.IMAP4.error("auth failed")
            self.held_refresh_lock("outlook", lambda: imap_sync.connect("outlook"))
            connection.return_value.shutdown.assert_called()
            connection.return_value.authenticate.side_effect = None
            self.assertIs(imap_sync.connect("outlook"), connection.return_value)

    def test_refresh_deadline_takes_precedence_over_longer_timeout(self):
        self.held_refresh_lock("gmail", lambda: self.oauth.refresh("gmail", lock_timeout=10,
                               deadline=time.monotonic() + .02), self.oauth.RefreshLockTimeout)

    def test_refresh_timeout_reaches_loop_giveup_and_normal_retry(self):
        error = self.held_refresh_lock("gmail", gmail_sync.Api("gmail")._token)
        waits, logs = LoopTest().run_loop([RuntimeError("earlier error"), error])
        self.assertEqual(waits, [360, 180])
        self.assertTrue(any("gmail: LOCK_GIVEUP waited=" in line and "holder=unknown" in line for line in logs))


class WatchdogTest(unittest.TestCase):
    def test_reports_stalled_phases_holder_once_per_ten_minutes_and_resets_on_activity(self):
        clock = [0]
        with patch.object(timing.time, "monotonic", side_effect=lambda: clock[0]), \
                patch.object(common, "volume_ready", return_value=True), patch.object(common, "log") as log:
            progress = msgs.DaemonProgress()
            metrics = timing.Pass("gmail")
            progress.begin("gmail", metrics)
            with metrics.phase("fetch"):
                clock[0] = 599
                progress.check()
                log.assert_not_called()
                clock[0] = 600
                progress.check()
                self.assertIn("no pass finished in 10 min (threads: gmail=fetch", log.call_args.args[0])
                self.assertIn("write lock: unknown for 0.0s", log.call_args.args[0])
                clock[0] = 1199
                progress.check()
                self.assertEqual(log.call_count, 1)
                token = timing.CURRENT.set(metrics)
                try:
                    timing.log("gmail: fetched 100/200")
                finally:
                    timing.CURRENT.reset(token)
                clock[0] = 1200
                progress.check()
                self.assertEqual(log.call_count, 2)  # only the fetch progress line
                progress.finish("gmail")
                clock[0] = 1800
                progress.check()
                self.assertEqual(log.call_count, 3)

    def test_missing_volume_does_not_report_stall_or_count_unmounted_time(self):
        clock = [0]
        with patch.object(timing.time, "monotonic", side_effect=lambda: clock[0]), patch.object(common, "log") as log:
            progress = msgs.DaemonProgress()
            clock[0] = 3600
            with patch.object(common, "volume_ready", return_value=False):
                progress.check()
            with patch.object(common, "volume_ready", return_value=True):
                progress.check()
                log.assert_not_called()
                clock[0] += 600
                progress.check()
                log.assert_called_once()


class PlistTest(unittest.TestCase):
    def test_standard_priority_keeps_nice_ten(self):
        path = Path(__file__).resolve().parents[1] / "scripts/com.ardud.message-archive.plist"
        with path.open("rb") as file:
            config = plistlib.load(file)
        self.assertEqual(config["ProcessType"], "Standard")
        self.assertEqual(config["Nice"], 10)
        self.assertTrue(config["KeepAlive"])
        self.assertEqual(config["ThrottleInterval"], 60)


if __name__ == "__main__":
    unittest.main()
