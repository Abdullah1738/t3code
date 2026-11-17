"""Loop failures and watchdog recovery with a deterministic clock, no real sleeps."""
import contextlib
import json
import sqlite3
import unittest
from unittest.mock import Mock, patch

if __package__:
    from .test_boatd import Base, boatd
else:
    from test_boatd import Base, boatd


class UnusualFailure(BaseException):
    pass


class LoopTests(Base):
    def drive(self, db, fn, count, name="reaper"):
        stamp, delays, snapshots, logs = [1000.0], [], [], []
        def sleep(delay):
            delays.append(delay)
            snapshots.append(dict(boatd.STATE["loops"][name]))
            stamp[0] += delay
            if len(delays) == count:
                raise SystemExit
        with patch.object(boatd, "db", db), patch.object(boatd, "log", logs.append):
            with self.assertRaises(SystemExit):
                boatd.loop(fn, 15, name, clock=lambda: stamp[0], sleep=sleep)
        # The real reaper also writes ordinary stop messages.
        return delays, snapshots, [json.loads(line) for line in logs if line.startswith("{")]

    def test_db_failures_back_off_then_recover(self):
        con = Mock()
        fn = Mock()
        delays, rows, logs = self.drive(Mock(side_effect=[sqlite3.OperationalError("disk I/O error")] * 3 + [con, con]), fn, 5)
        self.assertEqual(delays, [30, 60, 120, 15, 15])
        self.assertEqual([row["consecutive_failures"] for row in rows], [1, 2, 3, 0, 0])
        self.assertEqual([row["passes"] for row in rows], [0, 0, 0, 1, 2])
        self.assertGreater(rows[-1]["last_ok"], rows[-2]["last_ok"])
        self.assertEqual(fn.call_count, 2)
        self.assertEqual(con.close.call_count, 2)
        self.assertEqual([line["event"] for line in logs], ["loop.failed", "loop.recovered"])
        self.assertIn("Traceback", logs[0]["traceback"])
        self.assertEqual(logs[1]["failures"], 3)

    def test_fn_and_close_baseexceptions_are_contained(self):
        for source in ("fn", "close"):
            with self.subTest(source=source), patch.dict(boatd.STATE, loops={}):
                con = Mock()
                fn = Mock()
                getattr(con, "close").side_effect = [UnusualFailure("close"), None] if source == "close" else None
                fn.side_effect = [UnusualFailure("fn"), None] if source == "fn" else None
                delays, rows, logs = self.drive(Mock(return_value=con), fn, 2)
                self.assertEqual(delays, [30, 15])
                self.assertEqual(rows[-1]["consecutive_failures"], 0)
                self.assertEqual(rows[-1]["passes"], 1)
                self.assertEqual(con.close.call_count, 2)

    def test_sampler_and_reaper_resume_real_work_after_db_failure(self):
        for name, callback in (("sampler", boatd.sample_once), ("reaper", boatd.reap_once)):
            with self.subTest(name=name), contextlib.ExitStack() as stack:
                stack.enter_context(patch.dict(boatd.STATE, loops={}))
                stack.enter_context(patch.object(boatd, "now", return_value=1000))
                for key, value in {"disk_maintenance": {"level": "ok", "boxes": {}}, "read_cg": {}, "box_mem": 1234,
                                   "host_cpu_busy": 0, "psi": 0, "mem_available": 10000}.items():
                    stack.enter_context(patch.object(boatd, key, return_value=value))
                stack.enter_context(patch.object(boatd.os, "statvfs", return_value=Mock(f_bavail=100, f_frsize=4096)))
                bid = self.box("bx_" + name.ljust(8, "0"))
                self.con.execute("UPDATE boxes SET last_active=-1000, ttl=1800 WHERE id=?", (bid,))
                real_db = boatd.db
                calls = [0]
                def db():
                    calls[0] += 1
                    if calls[0] == 1:
                        raise sqlite3.OperationalError("disk I/O error")
                    return real_db()
                _, rows, _ = self.drive(db, callback, 2, name)
                self.assertEqual(rows[-1]["passes"], 1)
                if name == "sampler":
                    self.assertEqual(self.con.execute("SELECT COUNT(*) FROM samples WHERE box_id=?", (bid,)).fetchone()[0], 1)
                    self.assertEqual(self.con.execute("SELECT COUNT(*) FROM host_samples").fetchone()[0], 1)
                else:
                    self.assertEqual(self.con.execute("SELECT state FROM boxes WHERE id=?", (bid,)).fetchone()[0], "archived")

    def test_process_exit_signals_are_not_swallowed(self):
        for error in (SystemExit(), KeyboardInterrupt()):
            with self.subTest(error=type(error).__name__):
                con = Mock()
                with patch.object(boatd, "db", return_value=con):
                    with self.assertRaises(type(error)):
                        boatd.loop(Mock(side_effect=error), 15, "reaper", sleep=Mock())
                con.close.assert_called_once()

    def test_respawned_loop_recovers_existing_failure_episode(self):
        boatd.STATE["loops"]["reaper"] = {
            "every": 15, "started_at": 0, "last_ok": None, "last_error": "disk", "last_error_at": 50,
            "consecutive_failures": 3, "passes": 0, "failure_since": 0}
        _, rows, logs = self.drive(Mock(return_value=Mock()), Mock(), 1)
        self.assertEqual(rows[0]["consecutive_failures"], 0)
        self.assertEqual(logs[0]["duration_s"], 1000)

    def test_repeat_logs_are_bounded_and_backoff_caps(self):
        delays, rows, logs = self.drive(Mock(side_effect=sqlite3.OperationalError("disk full")), Mock(), 9)
        self.assertEqual(delays, [30, 60, 120, 240, 300, 300, 300, 300, 300])
        self.assertEqual(logs[0]["event"], "loop.failed")
        self.assertTrue(all(line["event"] == "loop.failure_repeat" and "traceback" not in line for line in logs[1:]))
        self.assertLess(len(logs), 9)
        self.assertEqual(rows[-1]["consecutive_failures"], 9)

    def test_failed_logging_cannot_kill_loop(self):
        stamp = [0]
        def sleep(delay):
            stamp[0] += 1
            if stamp[0] == 2:
                raise KeyboardInterrupt
        with patch.object(boatd, "db", side_effect=UnusualFailure("disk")), \
                patch.object(boatd, "log", side_effect=OSError("disk")):
            with self.assertRaises(KeyboardInterrupt):
                boatd.loop(Mock(), 15, "reaper", clock=lambda: 1000, sleep=sleep)
        self.assertEqual(boatd.STATE["loops"]["reaper"]["consecutive_failures"], 2)

    def test_stalled_health_is_fresh_and_recovers(self):
        boatd.READY.set()
        boatd._HEALTH.update(ts=1000, v={"ok": True, "mode": "ok", "reasons": []})
        with patch.object(boatd, "now", return_value=1000):
            state = boatd.loop_state("reaper", 15, 800)
            state.update(last_ok=800, last_error="OperationalError: disk full")
            boatd.LOOP_SPECS["reaper"] = (Mock(), 15)
            boatd.LOOP_THREADS["reaper"] = Mock(is_alive=Mock(return_value=True))
            boatd.refresh_health(fresh=True)
            with patch.object(boatd, "loop_health", side_effect=AssertionError("HTTP reads only a published snapshot")):
                h = boatd.health()
            self.assertTrue(h["ok"])
            self.assertTrue(h["degraded"])
            self.assertIn("200 s (OperationalError: disk full)", h["problem"])
            self.assertTrue(h["loops"]["reaper"]["stalled"])
            state["last_ok"] = 1000
            boatd.refresh_health(fresh=True)
            self.assertFalse(boatd.health()["degraded"])

    def test_threshold_first_pass_and_dead_thread_respawn(self):
        boatd.READY.set()
        fn = Mock()
        with patch.object(boatd, "now", return_value=1000), patch.object(boatd.threading, "Thread") as factory:
            factory.return_value.is_alive.return_value = True
            boatd.start_loop(fn, 40, "sampler")
            self.assertFalse(boatd.loop_health()["sampler"]["stalled"])
            state = boatd.STATE["loops"]["sampler"]
            state["started_at"] = 840
            self.assertFalse(boatd.loop_health()["sampler"]["stalled"])
            state["started_at"] = 839
            self.assertTrue(boatd.loop_health()["sampler"]["stalled"])
            factory.return_value.is_alive.return_value = False
            self.assertFalse(boatd.loop_health()["sampler"]["alive"])
            self.assertEqual(factory.call_count, 2)
            self.assertEqual(state["last_ok"], None)
