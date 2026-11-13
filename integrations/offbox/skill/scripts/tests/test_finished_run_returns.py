"""Offline tests: a remote run that has finished always gives its exit code back to the foreground `offbox run`,
`offbox wait` and `logs --follow`, whatever happens to the caller's output.

31 Oct, Crpko #1209, run-1031-140118-88ca on bx_wfpd7b2d: the caller redirected `offbox run` into a file on
/Volumes/ExternalSSD. That volume unmounted at 14:02:05 and came back at 14:02:24, so every later write to the
redirect failed with EIO. _echo caught only BrokenPipeError, so the EIO went to follow()'s stream retry, which
reattached at the same offsets, got the same chunk, failed the same way, and the `attached` frame at the start of
each attach reset the failure count, so the exited-status return was never reached. The client looped ~30 min
(remote exit file 0), held the box lock so `offbox wait` could only wait, and its SIGTERM ended in a crash in say()."""
import contextlib
import errno
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, cli, common, misc, runs  # noqa: E402
from test_capacity import Isolated  # noqa: E402
from test_wait_lock import Clock, FastEvent  # noqa: E402

SCRIPTS = str(Path(__file__).resolve().parents[1])


class Stuck(Exception):
    """Raised by a fake attach once follow() has clearly looped too long."""


class EioOut:
    """A stdout/stderr whose writes fail like a redirect to a file on a volume that went away."""

    class _Buf:
        def write(self, b):
            raise OSError(errno.EIO, "Input/output error")

        def flush(self):
            pass

    buffer = _Buf()

    def write(self, s):
        raise OSError(errno.EIO, "Input/output error")

    def flush(self):
        pass

    def fileno(self):
        raise ValueError("no descriptor")


def ended(code=0, status="exited", signal=None):
    return {"running": False, "status": status, "exitCode": code, "signal": signal}


RUNNING = {"running": True, "status": "running", "exitCode": None}


class FollowFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.log = Path(self.tmp.name) / "run.log"
        self.clock = Clock()
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(runs, "_ttl_keeper"))
        self.stack.enter_context(patch.object(runs, "now", self.clock.now))
        self.attaches = 0
        self.statuses = []

    def follow(self, attach, status, echo=False, limit=60, **kw):
        def counted_attach(*a, **k):
            self.attaches += 1
            if self.attaches > limit:
                raise Stuck(f"follow() still reattaching after {limit} attaches")
            return attach(*a, **k)

        def counted_status(*a, **k):
            st = status() if callable(status) else status
            self.statuses.append(st)
            return st
        with patch.object(runs.api, "cmd_attach", counted_attach), \
                patch.object(runs.api, "cmd_status", counted_status), \
                contextlib.redirect_stderr(io.StringIO()):
            return runs.follow("bx", 7, self.log, echo=echo, run_id="run-t", stop_evt=FastEvent(), **kw)


class EchoFailureTests(FollowFixture):
    def test_eio_on_the_callers_stdout_still_returns_the_exit_code(self):
        # The incident: every echo fails with EIO. The output still lands in the local log, once.
        def attach(box, pid, o, e, **kw):
            return iter([{"type": "attached", "stdoutOffset": o, "stderrOffset": e},
                         {"type": "stdout", "data": "......\n", "nextOffset": o + 7},
                         {"type": "stdout", "data": "104 passed\n", "nextOffset": o + 18},
                         {"type": "exit", "exitCode": 0}])
        with patch.object(sys, "stdout", EioOut()), patch.object(sys, "stderr", EioOut()):
            rc = self.follow(attach, ended(0), echo=True)
        self.assertEqual(rc, 0)
        self.assertEqual(self.attaches, 1)
        self.assertEqual(self.log.read_bytes(), b"......\n104 passed\n")

    def test_echo_stops_on_any_oserror_but_not_on_success(self):
        self.assertFalse(runs._echo(EioOut(), b"x"))
        buf = io.BytesIO()
        ok = type("Out", (), {"buffer": buf, "flush": lambda self: None})()
        self.assertTrue(runs._echo(ok, b"x"))
        self.assertEqual(buf.getvalue(), b"x")


class RecurringFailureTests(FollowFixture):
    def test_failure_after_the_attached_frame_on_every_attach_ends_with_the_exit_code(self):
        # Before: `attached` reset the failure count on every attach, so the exited status never ended the follow.
        def attach(box, pid, o, e, **kw):
            def frames():
                yield {"type": "attached", "stdoutOffset": o, "stderrOffset": e}
                raise OSError("connection reset")
            return frames()
        rc = self.follow(attach, ended(0))
        self.assertEqual(rc, 0)
        self.assertLessEqual(self.attaches, 5)

    def test_recurring_failure_keeps_following_while_the_process_runs(self):
        # The same failures on a running process are ordinary stream trouble: no exit code is made up.
        def attach(box, pid, o, e, **kw):
            def frames():
                yield {"type": "attached", "stdoutOffset": o, "stderrOffset": e}
                raise OSError("connection reset")
            return frames()
        with self.assertRaises(Stuck):
            self.follow(attach, RUNNING, limit=30)

    def test_output_still_arriving_after_exit_is_followed_to_the_exit_frame(self):
        # boat already says exited, but each attach still delivers new output before failing: progress resets the
        # count, so nothing is cut off, and the exit frame decides.
        chunks = [f"line {i}\n" for i in range(6)]

        def attach(box, pid, o, e, **kw):
            i = self.attaches - 1

            def frames():
                yield {"type": "attached", "stdoutOffset": o, "stderrOffset": e}
                if i < len(chunks):
                    yield {"type": "stdout", "data": chunks[i], "nextOffset": o + len(chunks[i])}
                    raise OSError("connection reset")
                yield {"type": "exit", "exitCode": 4}
            return frames()
        rc = self.follow(attach, ended(4))
        self.assertEqual(rc, 4)
        self.assertEqual(self.log.read_text(), "".join(chunks))

    def test_lost_status_still_returns_none_for_recovery(self):
        def attach(box, pid, o, e, **kw):
            raise OSError("connection reset")
        with patch.object(runs, 'confirmed_lost', return_value=ended(None, status='lost')):
            self.assertIsNone(self.follow(attach, ended(None, status="lost")))


class ReconnectAndHeartbeatTests(FollowFixture):
    def test_reconnect_loop_after_exit_returns_the_status_code(self):
        # A stream that keeps answering reconnect at the same offsets after the process ended.
        def attach(box, pid, o, e, **kw):
            return iter([{"type": "attached", "stdoutOffset": o, "stderrOffset": e},
                         {"type": "reconnect", "stdoutOffset": o, "stderrOffset": e}])
        rc = self.follow(attach, ended(3))
        self.assertEqual(rc, 3)
        self.assertEqual(self.attaches, 2)

    def test_reconnects_on_a_running_process_keep_following(self):
        def attach(box, pid, o, e, **kw):
            if self.attaches == 4:
                return iter([{"type": "exit", "exitCode": 0}])
            return iter([{"type": "attached"}, {"type": "reconnect", "stdoutOffset": o, "stderrOffset": e}])
        self.assertEqual(self.follow(attach, RUNNING), 0)
        self.assertEqual(self.attaches, 4)

    def test_heartbeat_only_stream_after_exit_returns_within_two_probe_windows(self):
        # A stream that stays open on heartbeats alone (one per 15 s) after the process ended.
        start = self.clock.t

        def attach(box, pid, o, e, **kw):
            def frames():
                yield {"type": "attached", "stdoutOffset": o, "stderrOffset": e}
                while True:
                    self.clock.t += 15
                    yield {"type": "heartbeat"}
            return frames()
        rc = self.follow(attach, ended(5))
        self.assertEqual(rc, 5)
        self.assertLessEqual(self.clock.t - start, 2 * runs.QUIET_PROBE_S + 30)

    def test_heartbeats_on_a_running_process_probe_rarely(self):
        def attach(box, pid, o, e, **kw):
            def frames():
                yield {"type": "attached"}
                for _ in range(240):  # one hour of heartbeats
                    self.clock.t += 15
                    yield {"type": "heartbeat"}
                yield {"type": "exit", "exitCode": 0}
            return frames()
        self.assertEqual(self.follow(attach, RUNNING), 0)
        self.assertLessEqual(len(self.statuses), 3600 // runs.QUIET_PROBE_S + 1)

    def test_deadline_still_wins_over_the_probe(self):
        def attach(box, pid, o, e, **kw):
            return iter([{"type": "attached"}, {"type": "reconnect", "stdoutOffset": o, "stderrOffset": e}])

        def status():
            self.clock.t += 40
            return RUNNING
        with self.assertRaises(common.OffboxError) as cm:
            self.follow(attach, status, until=self.clock.t + 100)
        self.assertEqual(cm.exception.code, common.EXIT_WAIT_TIMEOUT)

    def test_ended_status_answered_after_the_deadline_is_not_accepted(self):
        # The reconnect's probe gets "exited 7" only after --timeout: the follow must raise 124, not return 7.
        def attach(box, pid, o, e, **kw):
            return iter([{"type": "attached"}, {"type": "reconnect", "stdoutOffset": o, "stderrOffset": e}])

        def status():
            self.clock.t += 200
            return ended(7)
        with self.assertRaises(common.OffboxError) as cm:
            self.follow(attach, status, until=self.clock.t + 100)
        self.assertEqual(cm.exception.code, common.EXIT_WAIT_TIMEOUT)

    def test_status_code_reads_like_an_exit_frame(self):
        self.assertEqual(runs._status_code(ended(0)), 0)
        self.assertEqual(runs._status_code(ended(2)), 2)
        self.assertEqual(runs._status_code(ended(None, signal="SIGTERM")), 143)
        self.assertIsNone(runs._status_code(ended(None, status="lost")))
        self.assertIsNone(runs._status_code(ended(None)))


class StuckHolderWaitTests(Isolated):
    """`offbox wait` / `logs --follow` while another client holds the box lock and never records the end."""

    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(misc, "LOGS_DIR", common.LOGS_DIR))
        self.stack.enter_context(patch.object(runs, "LOGS_DIR", common.LOGS_DIR))
        self.con.execute("INSERT INTO runs(run_id,box_id,status,process_id,pulls,start_at) "
                         "VALUES ('run-s','bx_a','running',7,'[]',900)")
        self.con.commit()
        guard = common.file_lock("box-bx_a", timeout=0)
        guard.__enter__()
        self.addCleanup(guard.__exit__, None, None, None)

    def cli(self, argv, status, clock):
        out, err = io.StringIO(), io.StringIO()
        with patch.object(misc, "time", clock.time), patch.object(misc, "now", clock.now), \
                patch.object(runs, "now", clock.now), patch.object(runs.api, "cmd_status", side_effect=status), \
                patch.object(api, "get", return_value={"state": "running"}), \
                patch.object(runs, "follow", side_effect=AssertionError("must not attach while the lock is held")), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = cli.main(argv)
        return rc, out.getvalue(), err.getvalue()

    def row(self):
        return tuple(self.con.execute("SELECT status, exit_code FROM runs WHERE run_id='run-s'").fetchone())

    def test_wait_returns_boats_exit_code_when_the_holder_looks_stuck(self):
        clock = Clock()
        rc, out, err = self.cli(["wait", "run-s"], lambda *a, **k: ended(6), clock)
        self.assertEqual(rc, 6)
        self.assertIn("run-s: exit=6", out)
        self.assertIn("looks stuck", err)
        self.assertLessEqual(clock.t - 1000, misc.HOLDER_GRACE_S + misc.STATUS_POLL_S + misc.WAIT_POLL_S)
        self.assertEqual(self.row(), ("running", None))  # the row stays with its holder / the reaper

    def test_a_holder_with_pulls_gets_the_longer_grace(self):
        self.con.execute("UPDATE runs SET pulls='[\"out.txt\"]' WHERE run_id='run-s'")
        self.con.commit()
        clock = Clock()
        rc, _, _ = self.cli(["wait", "run-s"], lambda *a, **k: ended(0), clock)
        self.assertEqual(rc, 0)
        self.assertGreaterEqual(clock.t - 1000, misc.PULL_GRACE_S)

    def test_logs_follow_returns_too_and_prints_the_local_log(self):
        log = common.LOGS_DIR / "run-s.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text("first lines\n")
        rc, out, _ = self.cli(["logs", "run-s", "--follow"], lambda *a, **k: ended(0), Clock())
        self.assertEqual(rc, 0)
        self.assertEqual(out.count("first lines"), 1)

    def test_wait_keeps_waiting_while_boat_says_running(self):
        clock = Clock(on_sleep=lambda t: t >= 1600 and (self.con.execute(
            "UPDATE runs SET status='failed', exit_code=1 WHERE run_id='run-s'"), self.con.commit()))
        rc, out, _ = self.cli(["wait", "run-s"], lambda *a, **k: RUNNING, clock)
        self.assertEqual(rc, 1)
        self.assertIn("run-s: failed exit=1", out)
        self.assertGreaterEqual(clock.t, 1600)

    def test_wait_status_error_is_not_an_end(self):
        def status(*a, **k):
            raise common.OffboxError("boat API unreachable")
        rc, _, err = self.cli(["wait", "run-s", "--timeout", "300"], status, Clock())
        self.assertEqual(rc, common.EXIT_WAIT_TIMEOUT)


DEAD_TTY_CHILD = r'''
import os, sys
sys.path.insert(0, sys.argv[1])
from pathlib import Path
from unittest.mock import patch
from offbox_lib import common, runs
# stdout and stderr on a pty whose other end is gone: every write fails with EIO, like the incident's redirect.
master, slave = os.openpty()
os.close(master)
os.dup2(slave, 1)
os.dup2(slave, 2)
os.close(slave)
frames = iter([{"type": "attached"}, {"type": "stdout", "data": "x\n", "nextOffset": 2},
               {"type": "exit", "exitCode": 3}])
with patch.object(runs, "_ttl_keeper"), patch.object(runs.api, "cmd_attach", return_value=frames):
    rc = runs.follow("bx", 1, Path(sys.argv[2]), echo=True, run_id="r")
common.say("remote exit 3")
common.out("r: exit=3")
sys.exit(rc)
'''


class DeadTerminalSubprocessTests(unittest.TestCase):
    def test_exit_code_survives_eio_on_stdout_and_stderr(self):
        with tempfile.TemporaryDirectory() as d:
            p = subprocess.run([sys.executable, "-W", "ignore", "-c", DEAD_TTY_CHILD, SCRIPTS, str(Path(d) / "r.log")],
                               capture_output=True, timeout=60, stdin=subprocess.DEVNULL)
            self.assertEqual(p.returncode, 3, p.stderr.decode(errors="replace")[-800:])
            self.assertEqual((Path(d) / "r.log").read_bytes(), b"x\n")


if __name__ == "__main__":
    unittest.main()
