"""Offline tests: `offbox wait` / `logs --follow` on a run whose own `offbox run` still holds the box lock
(29 Oct, Crpko #455: run-1029-062330-4b76 on bx_ebdpf5qa; `offbox wait --timeout 7200` died on the lock with 90)."""
import contextlib
import io
from pathlib import Path
import sys
import threading
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, cli, common, misc, runs  # noqa: E402
from test_capacity import Isolated  # noqa: E402


class FastEvent(threading.Event):
    """An Event whose wait() does not sleep: follow()'s retry pause must not burn real time in a patched-clock test."""

    def wait(self, timeout=None):
        return self.is_set()


class Clock:
    def __init__(self, on_sleep=None):
        self.t = 1000.0
        self.on_sleep = on_sleep
        self.time = types.SimpleNamespace(sleep=self.sleep, time=lambda: self.t, monotonic=lambda: self.t)

    def now(self):
        return self.t

    def sleep(self, s):
        self.t += s
        if self.on_sleep:
            self.on_sleep(self.t)


class WaitLockTests(Isolated):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(misc, 'LOGS_DIR', common.LOGS_DIR))
        self.stack.enter_context(patch.object(runs, 'LOGS_DIR', common.LOGS_DIR))
        self.stack.enter_context(patch.object(runs.lease, 'touch'))
        self.stack.enter_context(patch.object(runs.lease, 'idle_ttl'))
        self.con.execute("INSERT INTO runs(run_id,box_id,status,process_id,pulls,start_at) "
                         "VALUES ('run-x','bx_a','running',7,'[]',900)")
        self.con.commit()

    def hold_box(self):
        guard = common.file_lock('box-bx_a', timeout=0)
        guard.__enter__()
        self.addCleanup(guard.__exit__, None, None, None)

    def end_run(self, code):
        self.con.execute("UPDATE runs SET status=?, exit_code=? WHERE run_id='run-x'",
                         ('done' if code == 0 else 'failed', code))
        self.con.commit()

    def cli_wait(self, argv, clock):
        out, err = io.StringIO(), io.StringIO()
        with patch.object(misc, 'time', clock.time), patch.object(misc, 'now', clock.now), \
                patch.object(runs, 'now', clock.now), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = cli.main(argv)
        return rc, out.getvalue(), err.getvalue()

    def test_wait_waits_for_the_lock_holder_to_record_the_end(self):
        self.hold_box()
        clock = Clock(on_sleep=lambda t: t >= 1300 and self.end_run(1))
        with patch.object(runs, 'follow', side_effect=AssertionError('must not attach while the run is followed')):
            rc, out, err = self.cli_wait(['wait', 'run-x'], clock)
        self.assertEqual(rc, 1)
        self.assertIn('run-x: failed exit=1', out)
        self.assertNotIn('timed out waiting for lock', err)
        self.assertEqual(err.count('still followed by another offbox process'), 1)

    def test_wait_timeout_while_lock_held_is_124_and_run_untouched(self):
        self.hold_box()
        with patch.object(runs, 'follow', side_effect=AssertionError('no attach')):
            rc, out, err = self.cli_wait(['wait', 'run-x', '--timeout', '30'], Clock())
        self.assertEqual(rc, 124)
        self.assertIn('--timeout reached', err)
        self.assertIn('offbox wait run-x', err)
        self.assertEqual(self.con.execute("SELECT status FROM runs WHERE run_id='run-x'").fetchone()[0], 'running')

    def test_wait_follows_itself_when_lock_is_free(self):
        seen = {}

        def fake_follow(box, pid, log_path, echo=True, run_id=None, start_offsets=(0, 0), until=None):
            seen.update(box=box, pid=pid, until=until, run_id=run_id)
            return 0
        clock = Clock()
        with patch.object(runs, 'follow', fake_follow):
            rc, out, _ = self.cli_wait(['wait', 'run-x', '--timeout', '60'], clock)
        self.assertEqual(rc, 0)
        self.assertEqual(seen, dict(box='bx_a', pid=7, until=1060.0, run_id='run-x'))
        self.assertEqual(self.con.execute("SELECT status, exit_code FROM runs WHERE run_id='run-x'").fetchone()[:], ('done', 0))
        # the box lock is released afterwards
        with common.file_lock('box-bx_a', timeout=0):
            pass

    def test_wait_on_a_settled_run_prints_its_code(self):
        self.end_run(3)
        rc, out, _ = self.cli_wait(['wait', 'run-x'], Clock())
        self.assertEqual(rc, 3)
        self.assertIn('run-x: failed exit=3', out)

    def test_logs_follow_tails_the_holders_log(self):
        self.hold_box()
        log = common.LOGS_DIR / 'run-x.log'
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text('step 1 output\n')

        def progress(t):
            if t >= 1010:
                with open(log, 'a') as f:
                    f.write('offbox step 1 rc=0: a\n')
                self.end_run(0)
        clock = Clock(on_sleep=progress)
        with patch.object(api, 'get', return_value={'state': 'running'}), \
                patch.object(runs, 'follow', side_effect=AssertionError('no attach')):
            rc, out, _ = self.cli_wait(['logs', 'run-x', '--follow'], clock)
        self.assertEqual(rc, 0)
        self.assertEqual(out.count('step 1 output'), 1)
        self.assertIn('offbox step 1 rc=0: a', out)
        self.assertIn('run-x: done exit=0', out)

    def test_wait_drains_the_holders_last_output_before_settling(self):
        # The holder writes its final output, records the end and releases the lock between two polls. The waiter
        # must print that tail when it settles, so logs --follow loses nothing.
        guard = common.file_lock('box-bx_a', timeout=0)
        guard.__enter__()
        log = common.LOGS_DIR / 'run-x.log'
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text('first\n')

        def holder_finishes(t):
            if t >= 1010 and guard is not None:
                with open(log, 'a') as f:
                    f.write('last line\n')
                self.end_run(0)
                guard.__exit__(None, None, None)
        clock = Clock(on_sleep=holder_finishes)
        with patch.object(api, 'get', return_value={'state': 'running'}), \
                patch.object(runs, 'follow', side_effect=AssertionError('no attach')):
            rc, out, _ = self.cli_wait(['logs', 'run-x', '--follow'], clock)
        self.assertEqual(rc, 0)
        self.assertEqual(out.count('first'), 1)
        self.assertIn('last line', out)
        self.assertIn('run-x: done exit=0', out)


class FollowUntilTests(unittest.TestCase):
    def test_follow_stops_at_until_without_killing(self):
        clock = Clock()
        frames = iter([{'type': 'stdout', 'data': 'hello\n', 'nextOffset': 6}])

        def attach(box, pid, o, e, **kw):
            for fr in frames:
                clock.t = 2000
                yield fr
        with patch.object(runs, '_ttl_keeper'), patch.object(runs, 'now', clock.now), \
                patch.object(runs.api, 'cmd_attach', attach), patch.object(runs.api, 'cmd_status') as st, \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(common.OffboxError) as caught:
                runs.follow('bx_a', 7, None, echo=False, run_id='run-x', until=1500)
        self.assertEqual(caught.exception.code, 124)
        self.assertIn('offbox wait run-x', str(caught.exception))
        st.assert_not_called()

    def test_quiet_stream_is_bounded_by_the_deadline(self):
        # A stream that goes quiet must not hold the waiter past --timeout: the socket read gets the time left, and
        # the read's timeout error (the only way a quiet stream ends) returns control at the deadline, not after 90 s.
        seen = {}
        clock = Clock()

        def quiet(box, pid, o, e, timeout=90):
            seen.setdefault('timeouts', []).append(timeout)
            clock.t += timeout  # a socket read that times out after `timeout` seconds
            raise TimeoutError('read timed out')
        with patch.object(runs, '_ttl_keeper'), patch.object(runs, 'now', clock.now), \
                patch.object(runs.api, 'cmd_attach', quiet), patch.object(runs.api, 'cmd_status', return_value=None), \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(common.OffboxError) as caught:
                runs.follow('bx_a', 7, None, echo=False, run_id='run-x', until=1015, stop_evt=FastEvent())
        self.assertEqual(caught.exception.code, 124)
        self.assertLessEqual(seen['timeouts'][0], 15)
        self.assertLessEqual(clock.t, 1015 + 1)

    def test_blocked_status_is_bounded_by_the_deadline(self):
        # A stream error sends follow() to cmd_status; that request must use the time left, with no retries.
        seen = {}
        clock = Clock()

        def broken(box, pid, o, e, timeout=90):
            clock.t = 1012  # the stream fails with 3 s left
            raise OSError('reset')

        def status(box, pid, timeout=60, retries=2):
            seen.update(timeout=timeout, retries=retries)
            clock.t = 1020  # a status request that runs out the clock
            return None
        with patch.object(runs, '_ttl_keeper'), patch.object(runs, 'now', clock.now), \
                patch.object(runs.api, 'cmd_attach', broken), patch.object(runs.api, 'cmd_status', status), \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(common.OffboxError) as caught:
                runs.follow('bx_a', 7, None, echo=False, run_id='run-x', until=1015, stop_evt=FastEvent())
        self.assertEqual(caught.exception.code, 124)
        self.assertLessEqual(seen['timeout'], 3.0)
        self.assertEqual(seen['retries'], 0)

    def test_takeover_resumes_from_the_holders_offsets(self):
        # A holder wrote stdout up to 6 and stderr up to 4 before it died; a takeover must ask for exactly those
        # offsets, so neither stream's delivered bytes are replayed into the echo or the local log.
        log = common.LOGS_DIR / 'run-y.log'
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_bytes(b'')
        runs._save_offsets(log, 6, 4)
        self.assertEqual(misc_offsets(log), (6, 4))
        asked = {}

        def attach(box, pid, o, e, **kw):
            asked.update(o=o, e=e)
            return iter([{'type': 'exit', 'exitCode': 0}])
        with patch.object(runs, '_ttl_keeper'), patch.object(runs.api, 'cmd_attach', attach), \
                contextlib.redirect_stdout(io.StringIO()):
            rc = runs.follow('bx_a', 7, log, echo=False, run_id='run-y', start_offsets=misc_offsets(log))
        self.assertEqual(rc, 0)
        self.assertEqual(asked, dict(o=6, e=4))


def misc_offsets(log):
    return runs.load_offsets(log)


if __name__ == '__main__':
    unittest.main()
