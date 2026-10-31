"""Offline tests: `offbox wait` / `logs --follow` on a run whose own `offbox run` still holds the box lock
(29 Oct, Crpko #455: run-1029-062330-4b76 on bx_ebdpf5qa; `offbox wait --timeout 7200` died on the lock with 90)."""
import contextlib
import http.server
import io
from pathlib import Path
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, cli, common, misc, runs  # noqa: E402
from offbox_lib.common import OffboxError, db  # noqa: E402
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
        # Match the CLI's own lock diagnostic line, not any text in captured stderr (other warnings may mention it).
        self.assertFalse(any(l.startswith('offbox:') and 'timed out waiting for lock' in l
                             for l in err.splitlines()), err)
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

        def fake_follow(box, pid, log_path, echo=True, run_id=None, start_offsets=(0, 0), until=None, **kw):
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

    def test_timeout_before_attach_leaves_a_legacy_log_untouched(self):
        # A running legacy run (no checkpoint) with captured output and a free lock. `wait --timeout 0` must end
        # before any remote attach, leaving the original log bytes and the run exactly as they were.
        log = common.LOGS_DIR / 'run-x.log'
        log.parent.mkdir(parents=True, exist_ok=True)
        original = b'legacy output line\n'
        log.write_bytes(original)
        self.assertIsNone(common.checkpoint(log))
        with patch.object(runs, 'follow', side_effect=AssertionError('no attach before the deadline')):
            rc, out, err = self.cli_wait(['wait', 'run-x', '--timeout', '0'], Clock())
        self.assertEqual(rc, 124)
        self.assertEqual(log.read_bytes(), original)
        self.assertIsNone(common.checkpoint(log))
        self.assertEqual(self.con.execute("SELECT status FROM runs WHERE run_id='run-x'").fetchone()[0], 'running')

    def test_failed_replay_keeps_the_original_log_and_checkpoint(self):
        # A checkpointed run whose takeover replay fails (the stream is lost, no exit code). The original log bytes
        # and checkpoint must survive, and the run must still be running.
        log = common.LOGS_DIR / 'run-x.log'
        log.parent.mkdir(parents=True, exist_ok=True)
        original = b'o1\ncommitted\n'
        log.write_bytes(original)
        runs._commit(log, 3, 0, len(original))
        before_ck = common.checkpoint(log)
        self.hold_box()
        clock = Clock()
        # The replay's stream is lost: follow() returns None (unknown) and nothing can recover the exit. Real code path:
        # _resolve_exit -> follow -> recover_lost_exit, no mock of the takeover internals.
        with patch.object(misc, 'now', clock.now), patch.object(misc, 'time', clock.time), \
                patch.object(runs, 'now', clock.now), \
                patch.object(runs, 'follow', return_value=None) as lost_follow, \
                patch.object(runs, 'recover_lost_exit', return_value=(None, '')), \
                patch.object(runs, 'finish') as finished:
            with self.assertRaises(OffboxError):
                misc._replay_takeover(self.con.execute("SELECT * FROM runs WHERE run_id='run-x'").fetchone(),
                                      False, None, (3, 0), log, len(original))
        self.assertEqual(lost_follow.call_args.kwargs['replay_path'], log.with_name(log.name + '.takeover'))
        finished.assert_not_called()
        self.assertEqual(log.read_bytes(), original)
        self.assertEqual(common.checkpoint(log), before_ck)
        self.assertFalse((log.with_name(log.name + '.takeover')).exists())
        self.assertEqual(self.con.execute("SELECT status FROM runs WHERE run_id='run-x'").fetchone()[0], 'running')

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


    def follow_out(self, argv, clock):
        """cli_wait with streams that have .buffer: a takeover follow echoes bytes through sys.stdout/stderr.buffer."""
        out, err = (io.TextIOWrapper(io.BytesIO(), write_through=True) for _ in range(2))
        with patch.object(misc, 'time', clock.time), patch.object(misc, 'now', clock.now), \
                patch.object(runs, 'now', clock.now), patch.object(runs, '_ttl_keeper'), \
                patch.object(api, 'get', return_value={'state': 'running'}), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = cli.main(argv)
        return rc, out.buffer.getvalue().decode(), err.buffer.getvalue().decode()

    def test_logs_follow_takeover_after_first_chunk_death_has_every_byte_once(self):
        # A holder flushes its first chunk to the local log and dies before committing it. Its follow committed a
        # zero-length checkpoint before writing, so the waiter prints nothing past it, and the takeover cuts the
        # log back and replays the run once: output and stored log each hold every byte exactly once.
        log = common.LOGS_DIR / 'run-x.log'
        log.parent.mkdir(parents=True, exist_ok=True)
        guard = common.file_lock('box-bx_a', timeout=0)
        guard.__enter__()
        real_commit = runs._commit
        calls = {'n': 0}

        def dying_commit(path, out_off, err_off, log_bytes):
            calls['n'] += 1
            if calls['n'] == 2:  # the first chunk's commit: o1 is flushed to the log, then the holder dies
                raise SystemExit('holder died')
            real_commit(path, out_off, err_off, log_bytes)
        with patch.object(runs, '_ttl_keeper'), patch.object(runs, '_commit', dying_commit), \
                patch.object(runs.api, 'cmd_attach', lambda *a, **kw: iter([{'type': 'stdout', 'data': 'o1\n'}])):
            with self.assertRaises(SystemExit):
                runs.follow('bx_a', 7, log, echo=False, run_id='run-x')
        self.assertEqual(log.read_bytes(), b'o1\n')
        self.assertEqual(common.checkpoint(log), {'stdoutOffset': 0, 'stderrOffset': 0, 'logBytes': 0})
        held = [guard]

        def holder_gone(t):
            if held:
                held.pop().__exit__(None, None, None)  # the dead holder's lock is released
        asked = {}

        def takeover_attach(box, pid, o, e, **kw):
            asked.update(o=o, e=e)
            return iter([{'type': 'stdout', 'data': 'o1\n', 'nextOffset': 3},
                         {'type': 'stderr', 'data': 'e1\n', 'nextOffset': 3}, {'type': 'exit', 'exitCode': 0}])
        with patch.object(runs.api, 'cmd_attach', takeover_attach):
            rc, out, err = self.follow_out(['logs', 'run-x', '--follow'], Clock(on_sleep=holder_gone))
        self.assertEqual(rc, 0)
        self.assertEqual(asked, dict(o=0, e=0))
        self.assertEqual(out.count('o1'), 1, out)
        self.assertEqual(err.count('e1'), 1, err)
        self.assertEqual(log.read_bytes(), b'o1\ne1\n')

    def test_logs_follow_legacy_log_without_checkpoint_is_not_printed_twice(self):
        # A run started before checkpoints existed: its holder writes the log with no sidecar. The waiter can't tell
        # which bytes a takeover would replay, so it prints none while the run can still be taken over; the
        # takeover empties the log and replays from offset 0.
        log = common.LOGS_DIR / 'run-x.log'
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_bytes(b'o1\ne1\n')
        guard = common.file_lock('box-bx_a', timeout=0)
        guard.__enter__()
        held = [guard]

        def holder_gone(t):
            if t >= 1010 and held:
                held.pop().__exit__(None, None, None)

        def takeover_attach(box, pid, o, e, **kw):
            self.assertEqual((o, e), (0, 0))
            return iter([{'type': 'stdout', 'data': 'o1\n', 'nextOffset': 3},
                         {'type': 'stderr', 'data': 'e1\n', 'nextOffset': 3},
                         {'type': 'stdout', 'data': 'o2\n', 'nextOffset': 6}, {'type': 'exit', 'exitCode': 0}])
        with patch.object(runs.api, 'cmd_attach', takeover_attach):
            rc, out, err = self.follow_out(['logs', 'run-x', '--follow'], Clock(on_sleep=holder_gone))
        self.assertEqual(rc, 0)
        self.assertEqual((out.count('o1'), out.count('o2'), err.count('e1')), (1, 1, 1), (out, err))
        self.assertEqual(log.read_bytes(), b'o1\ne1\no2\n')

    def test_logs_follow_legacy_log_settled_by_its_holder_prints_it_once(self):
        # Same legacy holder, but it finishes: the whole log is printed once when the run settles.
        log = common.LOGS_DIR / 'run-x.log'
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_bytes(b'o1\n')
        self.hold_box()

        def holder_finishes(t):
            if t >= 1010:
                with open(log, 'ab') as f:
                    f.write(b'o2\n')
                self.end_run(0)
        with patch.object(runs, 'follow', side_effect=AssertionError('no attach')):
            rc, out, _ = self.follow_out(['logs', 'run-x', '--follow'], Clock(on_sleep=holder_finishes))
        self.assertEqual(rc, 0)
        self.assertEqual((out.count('o1'), out.count('o2')), (1, 1), out)
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

        def quiet(box, pid, o, e, timeout=90, **kw):
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

        def broken(box, pid, o, e, timeout=90, **kw):
            clock.t = 1012  # the stream fails with 3 s left
            raise OSError('reset')

        def status(box, pid, timeout=60, retries=2, deadline=None):
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

    def test_mixed_stream_takeover_after_death_between_flush_and_commit(self):
        # End to end: a holder follows stdout and stderr interleaved. It dies after flushing a chunk to the local log
        # but before committing its checkpoint. A waiter takes over: the committed bytes are not repeated, the
        # uncommitted chunk is dropped and replayed once, and the stream offsets resume per stream.
        # A temp dir, not common.LOGS_DIR: this class isn't Isolated, so that would be the live ~/.local/share/offbox.
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        log = Path(tmp.name) / 'run-z.log'
        log.write_bytes(b'')
        frames_holder = [
            {'type': 'stdout', 'data': 'o1\n', 'nextOffset': 3},
            {'type': 'stderr', 'data': 'e1\n', 'nextOffset': 3},
            {'type': 'stdout', 'data': 'o2\n', 'nextOffset': 6},
        ]
        real_commit = runs._commit
        calls = {'n': 0}

        def dying_commit(path, out_off, err_off, log_bytes):
            calls['n'] += 1
            # Call 1 is follow's zero-length checkpoint before any byte; call 4 is the third chunk: flushed to the
            # log, then the holder dies before committing it.
            if calls['n'] == 4:
                raise SystemExit('holder died')
            real_commit(path, out_off, err_off, log_bytes)

        def holder_attach(box, pid, o, e, **kw):
            return iter(frames_holder)
        with patch.object(runs, '_ttl_keeper'), patch.object(runs.api, 'cmd_attach', holder_attach), \
                patch.object(runs, '_commit', dying_commit), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit):
                runs.follow('bx_a', 7, log, echo=False, run_id='run-z')
        # The log holds o2 (flushed) but the checkpoint stops after e1.
        self.assertEqual(log.read_bytes(), b'o1\ne1\no2\n')
        self.assertEqual(common.checkpoint(log), {'stdoutOffset': 3, 'stderrOffset': 3, 'logBytes': 6})

        # Takeover: truncate to the committed 6 bytes, then resume each stream from its committed offset.
        asked = {}
        takeover_frames = [
            {'type': 'stdout', 'data': 'o2\n', 'nextOffset': 6},
            {'type': 'exit', 'exitCode': 0},
        ]

        def takeover_attach(box, pid, o, e, **kw):
            asked.update(o=o, e=e)
            return iter(takeover_frames)
        ck = common.checkpoint(log)
        misc._truncate(log, ck['logBytes'])
        with patch.object(runs, '_ttl_keeper'), patch.object(runs.api, 'cmd_attach', takeover_attach), \
                contextlib.redirect_stdout(io.StringIO()):
            rc = runs.follow('bx_a', 7, log, echo=False, run_id='run-z',
                             start_offsets=(ck['stdoutOffset'], ck['stderrOffset']))
        self.assertEqual(rc, 0)
        self.assertEqual(asked, dict(o=3, e=3))
        # Each line exactly once, in the order it was confirmed.
        self.assertEqual(log.read_bytes(), b'o1\ne1\no2\n')


def _wait_until(pred, budget=0.2):
    """Poll a predicate for a bounded time (the owner thread takes the lock and writes its first chunk)."""
    end = time.time() + budget
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.01)
    return False


def _text(stream):
    """Text written through a _bytes_stdout() stand-in."""
    stream.flush()
    return stream.buffer.getvalue().decode("utf-8", errors="replace")


def _bytes_stdout():
    """A stdout stand-in that has a byte buffer, as follow()'s echo writes to it through .buffer."""
    import io as _io
    return _io.TextIOWrapper(_io.BytesIO(), encoding="utf-8")


class TakeoverPublishTests(unittest.TestCase):
    """Round 5: the takeover keeps a checkpointed prefix, never promotes an unknown exit, and publishes the replacement
    log before the run is settled. Uses a temp dir, not the live offbox logs folder."""

    def setUp(self):
        import tempfile
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.logs = Path(self._tmp.name)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(misc, 'LOGS_DIR', self.logs))
        self.stack.enter_context(patch.object(runs, 'LOGS_DIR', self.logs))
        self.stack.enter_context(patch.object(runs, '_ttl_keeper'))
        self.stack.enter_context(patch.object(runs.api, 'cmd_status', return_value=None))
        self.stack.enter_context(patch.object(runs, 'finish'))
        self.stack.enter_context(patch.object(runs, 'go_std_glitch'))
        self.row = {'run_id': 'run-p', 'box_id': 'bx_a', 'process_id': 7, 'pulls': '[]', 'status': 'running',
                    'exit_code': None}

    def test_prefix_survives_a_successful_exit_only_replay(self):
        # A checkpointed holder committed stdout "o1" and stderr "e1" (6 bytes). The takeover replays only the exit:
        # the published log must still hold the committed prefix, not an empty suffix.
        log = self.logs / 'run-p.log'
        committed = b'o1\ne1\n'
        log.write_bytes(committed)
        runs._commit(log, 3, 3, len(committed))
        with patch.object(runs.api, 'cmd_attach', return_value=iter([{'type': 'exit', 'exitCode': 0}])), \
                contextlib.redirect_stdout(_bytes_stdout()):
            rc = misc._replay_takeover(self.row, False, None, (3, 3), log, len(committed))
        self.assertEqual(rc, 0)
        self.assertEqual(log.read_bytes(), committed)
        self.assertEqual(common.checkpoint(log)['logBytes'], len(committed))

    def test_prefix_survives_a_successful_suffix_replay(self):
        # The replay also delivers new output; the published log is the prefix followed by that output, once each.
        log = self.logs / 'run-p.log'
        committed = b'o1\ne1\n'
        log.write_bytes(committed)
        runs._commit(log, 3, 3, len(committed))
        frames = [{'type': 'stdout', 'data': 'o2\n', 'nextOffset': 6}, {'type': 'exit', 'exitCode': 0}]
        with patch.object(runs.api, 'cmd_attach', return_value=iter(frames)), \
                contextlib.redirect_stdout(_bytes_stdout()):
            rc = misc._replay_takeover(self.row, False, None, (3, 3), log, len(committed))
        self.assertEqual(rc, 0)
        self.assertEqual(log.read_bytes(), b'o1\ne1\no2\n')

    def test_unknown_exit_never_promotes_the_temp_log(self):
        # Real lost-process path: the stream yields nothing, the exit cannot be recovered. The original stays.
        log = self.logs / 'run-p.log'
        committed = b'o1\ne1\n'
        log.write_bytes(committed)
        runs._commit(log, 3, 3, len(committed))
        before = common.checkpoint(log)
        with patch.object(runs.api, 'cmd_attach', return_value=iter(())), \
                patch.object(runs, 'recover_lost_exit', return_value=(None, '')), \
                contextlib.redirect_stdout(_bytes_stdout()):
            with self.assertRaises(OffboxError):
                # A deadline that has already passed when follow() starts: it ends at once, with no exit known.
                misc._replay_takeover(self.row, False, time.time() - 1, (3, 3), log, len(committed))
        self.assertEqual(log.read_bytes(), committed)
        self.assertEqual(common.checkpoint(log), before)
        self.assertFalse((self.logs / 'run-p.log.takeover').exists())

    def test_second_waiter_paused_at_completion_sees_every_byte_once(self):
        # The holder's replay publishes the replacement log, then finalizes the run. A second waiter that reads the
        # settled row while the holder is still between publish and finish must drain the new log, not the old one.
        log = self.logs / 'run-p.log'
        committed = b'o1\ne1\n'
        log.write_bytes(committed)
        runs._commit(log, 3, 3, len(committed))
        frames = [{'type': 'stdout', 'data': 'o2\n', 'nextOffset': 6}, {'type': 'exit', 'exitCode': 0}]
        seen = {}

        def pause_at_finish(run_id, code, status=None):
            # Runs after the replacement log is published and before the row is marked settled. The second waiter
            # runs now: it must see the replacement, because the row is not settled yet.
            seen['log_at_finish'] = log.read_bytes()
        with patch.object(runs.api, 'cmd_attach', return_value=iter(frames)), \
                patch.object(runs, 'finish', side_effect=pause_at_finish), \
                contextlib.redirect_stdout(_bytes_stdout()):
            misc._replay_takeover(self.row, False, None, (3, 3), log, len(committed))
        self.assertEqual(seen['log_at_finish'], b'o1\ne1\no2\n')
        self.assertEqual(log.read_bytes(), b'o1\ne1\no2\n')


class LiveAndEchoTests(unittest.TestCase):
    """Round 6: a quiet wait does not echo remote output; a concurrent logs --follow sees the owner's new chunks before
    the owner's exit frame. Real frames through follow(); temp dir, not the live offbox logs."""

    def setUp(self):
        import tempfile
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.logs = Path(self._tmp.name)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(misc, 'LOGS_DIR', self.logs))
        self.stack.enter_context(patch.object(runs, 'LOGS_DIR', self.logs))
        self.stack.enter_context(patch.object(runs, '_ttl_keeper'))
        self.stack.enter_context(patch.object(runs.api, 'cmd_status', return_value=None))
        self.stack.enter_context(patch.object(runs, 'finish'))
        self.stack.enter_context(patch.object(runs, 'go_std_glitch'))
        self.row = {'run_id': 'run-l', 'box_id': 'bx_a', 'process_id': 7, 'pulls': '[]', 'status': 'running',
                    'exit_code': None}

    def test_quiet_takeover_prints_no_remote_output(self):
        # echo=False (a plain offbox wait): the remote stdout must not reach stdout, even through a takeover replay.
        log = self.logs / 'run-l.log'
        committed = b'o1\n'
        log.write_bytes(committed)
        runs._commit(log, 3, 0, len(committed))
        frames = [{'type': 'stdout', 'data': 'o2\n', 'nextOffset': 6}, {'type': 'exit', 'exitCode': 0}]
        out = io.TextIOWrapper(io.BytesIO(), encoding='utf-8')
        self.addCleanup(out.close)
        with patch.object(runs.api, 'cmd_attach', return_value=iter(frames)), \
                contextlib.redirect_stdout(out):
            rc = misc._replay_takeover(self.row, False, None, (3, 0), log, len(committed))
        self.assertEqual(rc, 0)
        out.flush()
        # Remote output must not be echoed. The exit line ("run-l: exit=0") is the wait's own status, not remote output.
        self.assertNotIn(b'o2', out.buffer.getvalue())
        self.assertEqual(log.read_bytes(), b'o1\no2\n')

    def test_echoing_follow_still_prints_remote_output(self):
        # The same takeover with echo=True (logs --follow) prints the new remote chunk.
        log = self.logs / 'run-l.log'
        committed = b'o1\n'
        log.write_bytes(committed)
        runs._commit(log, 3, 0, len(committed))
        frames = [{'type': 'stdout', 'data': 'o2\n', 'nextOffset': 6}, {'type': 'exit', 'exitCode': 0}]
        out = io.TextIOWrapper(io.BytesIO(), encoding='utf-8')
        self.addCleanup(out.close)
        with patch.object(runs.api, 'cmd_attach', return_value=iter(frames)), \
                contextlib.redirect_stdout(out):
            rc = misc._replay_takeover(self.row, True, None, (3, 0), log, len(committed), has_checkpoint=True)
        self.assertEqual(rc, 0)
        out.flush()
        self.assertIn(b'o2\n', out.buffer.getvalue())

    def test_follower_sees_owner_chunks_before_its_exit_frame(self):
        # Owner A replays the run: chunk 'o2' arrives, then the stream is held before its exit frame. Follower B
        # reads the original log at that moment and must already see 'o2'.
        log = self.logs / 'run-l.log'
        committed = b'o1\n'
        log.write_bytes(committed)
        runs._commit(log, 3, 0, len(committed))
        seen_by_follower = {}

        def held_stream(box, pid, o, e, **kw):
            yield {'type': 'stdout', 'data': 'o2\n', 'nextOffset': 6}
            # Pause before the exit frame: this is the moment follower B reads.
            seen_by_follower['bytes'] = log.read_bytes()
            seen_by_follower['ck'] = common.checkpoint(log)
            yield {'type': 'exit', 'exitCode': 0}
        out = io.TextIOWrapper(io.BytesIO(), encoding='utf-8')
        self.addCleanup(out.close)
        with patch.object(runs.api, 'cmd_attach', held_stream), contextlib.redirect_stdout(out):
            misc._replay_takeover(self.row, True, None, (3, 0), log, len(committed), has_checkpoint=True)
        self.assertEqual(seen_by_follower['bytes'], b'o1\no2\n')
        self.assertEqual(seen_by_follower['ck']['logBytes'], len(b'o1\no2\n'))


class LockBlockedFollowerTests(unittest.TestCase):
    """Round 7: a lock-blocked logs --follow (the real _wait_locked poll loop) receives an owner's chunk before the
    owner's exit frame, for a fresh run with no checkpoint, with a zero checkpoint, and with an empty original log.
    The owner is a real takeover in a background thread, paused between its chunk and its exit frame."""

    def setUp(self):
        import tempfile
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.logs = Path(self._tmp.name)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(misc, 'LOGS_DIR', self.logs))
        self.stack.enter_context(patch.object(runs, 'LOGS_DIR', self.logs))
        self.stack.enter_context(patch.object(runs, '_ttl_keeper'))
        self.stack.enter_context(patch.object(runs.api, 'cmd_status', return_value=None))
        self.stack.enter_context(patch.object(runs, 'finish'))
        self.stack.enter_context(patch.object(runs, 'go_std_glitch'))
        self.stack.enter_context(patch.object(misc, 'WAIT_POLL_S', 0))
        # logs --follow only enters the lock-blocked path for a live box.
        self.stack.enter_context(patch.object(runs.api, 'get', return_value={'state': 'running'}))
        self.stack.enter_context(patch.object(api, 'get', return_value={'state': 'running'}))
        self.con = db()
        self.con.execute("INSERT OR REPLACE INTO runs(run_id,box_id,status,process_id,pulls,start_at) "
                         "VALUES ('run-f','bx_a','running',7,'[]',900)")
        self.con.commit()
        self.row = {'run_id': 'run-f', 'box_id': 'bx_a', 'process_id': 7, 'pulls': '[]', 'status': 'running',
                    'exit_code': None}

    def _settle_run(self):
        self.con.execute("UPDATE runs SET status='done', exit_code=0 WHERE run_id='run-f'")
        self.con.commit()

    def _run_owner(self, frames_before_exit):
        """Owner takeover in a thread: it yields chunk frames, then blocks on `gate` before its exit frame."""
        gate = threading.Event()

        def stream(box, pid, o, e, **kw):
            for fr in frames_before_exit:
                yield fr
            gate.wait(10)  # the follower reads the original log here, before the owner's exit frame
            yield {'type': 'exit', 'exitCode': 0}

        self.owner_holds = threading.Event()

        def owner():
            # The owner is the lock holder: it holds the box lock for the whole replay, as _wait_locked does.
            guard = common.file_lock('box-bx_a', timeout=0)
            guard.__enter__()
            self.owner_holds.set()  # from here on the follower can only poll, never replay
            try:
                with patch.object(runs.api, 'cmd_attach', stream):
                    misc._replay_takeover(self.row, False, None, (0, 0), self.logs / 'run-f.log',
                                          0, has_checkpoint=False)
            except BaseException as e:  # noqa: BLE001  (recorded, and the test fails on it below)
                self.owner_error = e
            finally:
                guard.__exit__(None, None, None)
        self.owner_error = None
        t = threading.Thread(target=owner, daemon=True)
        t.start()
        self.addCleanup(lambda: (gate.set(), t.join(5)))
        return gate, t

    def test_follower_sees_chunk_with_no_checkpoint(self):
        # Fresh --bg run (never followed): no log, no sidecar. The owner's first chunk must reach a lock-blocked
        # follower before the owner's exit frame.
        log = self.logs / 'run-f.log'
        self.assertIsNone(common.checkpoint(log))
        self.assertFalse(log.exists())
        gate, owner = self._run_owner([{'type': 'stdout', 'data': 'first\n', 'nextOffset': 6}])
        # The owner holds the lock and is blocked before its exit frame; the follower can only poll.
        self.assertTrue(_wait_until(lambda: log.exists() and log.read_bytes() == b'first\n', 5),
                        'owner never wrote its first chunk to the original log')
        self.assertTrue(self.owner_holds.wait(5), 'owner never took the box lock')
        seen = _bytes_stdout()
        with patch.object(misc, 'WAIT_POLL_S', 0), contextlib.redirect_stdout(seen):
            result = {}

            def follower():
                result['rc'] = misc.logs('run-f', do_follow=True)
            f = threading.Thread(target=follower, daemon=True)
            f.start()
            # The follower polls the lock; join it however this test ends so its lock never outlives the test.
            # Settle the run the way the owner's finish() does, so the follower's poll loop returns (a real run
            # settles through finish(); this test patches finish out). Then join.
            self.addCleanup(lambda: (gate.set(), owner.join(5), self._settle_run(), f.join(10)))
            # Poll until the follower has printed the chunk, while the owner is still before its exit frame.
            for _ in range(200):
                if 'first' in _text(seen):
                    break
                time.sleep(0.02)
            seen_before_exit = 'first' in _text(seen)
            gate.set()
            owner.join(5)
            # The owner has exited. Settle the run the way its finish() does, so the follower's poll returns.
            self._settle_run()
            f.join(10)
        self.assertFalse(owner.is_alive(), 'owner thread must end')
        self.assertFalse(f.is_alive(), 'follower thread must end')
        self.assertIsNone(self.owner_error, f'owner failed: {self.owner_error!r}')
        self.assertTrue(seen_before_exit, 'follower must receive the owner chunk before its exit frame')
        self.assertEqual(log.read_bytes(), b'first\n')
        self.assertEqual(_text(seen).count('first'), 1)

    def test_follower_sees_chunk_with_zero_checkpoint_and_empty_log(self):
        # A holder died before its first committed chunk: an empty log and a zero-length checkpoint.
        log = self.logs / 'run-f.log'
        log.write_bytes(b'')
        runs._commit(log, 0, 0, 0)
        self.assertEqual(common.checkpoint(log)['logBytes'], 0)
        gate, owner = self._run_owner([{'type': 'stdout', 'data': 'second\n', 'nextOffset': 7}])
        self.assertTrue(self.owner_holds.wait(5), 'owner never took the box lock')
        self.assertTrue(_wait_until(lambda: log.exists() and log.read_bytes() == b'second\n', 5),
                        'owner never wrote its first chunk to the original log')
        seen = _bytes_stdout()
        with contextlib.redirect_stdout(seen):
            result = {}

            def follower():
                result['rc'] = misc.logs('run-f', do_follow=True)
            f = threading.Thread(target=follower, daemon=True)
            f.start()
            # The follower polls the lock; join it however this test ends so its lock never outlives the test.
            # Settle the run the way the owner's finish() does, so the follower's poll loop returns (a real run
            # settles through finish(); this test patches finish out). Then join.
            self.addCleanup(lambda: (gate.set(), owner.join(5), self._settle_run(), f.join(10)))
            for _ in range(200):
                if 'second' in _text(seen):
                    break
                time.sleep(0.02)
            seen_before_exit = 'second' in _text(seen)
            gate.set()
            owner.join(5)
            # The owner has exited. Settle the run the way its finish() does, so the follower's poll returns.
            self._settle_run()
            f.join(10)
        self.assertFalse(owner.is_alive(), 'owner thread must end')
        self.assertFalse(f.is_alive(), 'follower thread must end')
        self.assertIsNone(self.owner_error, f'owner failed: {self.owner_error!r}')
        self.assertTrue(seen_before_exit, 'follower must receive the owner chunk before its exit frame')
        self.assertEqual(log.read_bytes(), b'second\n')
        self.assertEqual(_text(seen).count('second'), 1)


class _Boat(http.server.BaseHTTPRequestHandler):
    """A local ndjson stream that misbehaves on purpose: /quiet sends one frame late, then goes silent; /trickle sends
    a line one byte at a time and never finishes it. ?plain=1 answers HTTP/1.0 without chunking."""
    protocol_version = 'HTTP/1.1'
    stop = threading.Event()
    frame_at = 0.0

    def log_message(self, *a):
        pass

    def do_GET(self):
        plain = 'plain=1' in self.path
        if plain:
            self.protocol_version = 'HTTP/1.0'
        self.send_response(200)
        self.send_header('Content-Type', 'application/x-ndjson')
        if not plain:
            self.send_header('Transfer-Encoding', 'chunked')
        self.end_headers()

        def send(b):
            self.wfile.write(b if plain else b'%x\r\n%s\r\n' % (len(b), b))
            self.wfile.flush()
        try:
            if '/trickle' in self.path:
                send(b'{')
                for _ in range(100):  # 10 s of one byte per 0.1 s, never a newline
                    if self.stop.wait(0.1):
                        return
                    send(b' ')
            else:
                if self.stop.wait(self.frame_at):
                    return
                send(b'{"type": "stdout", "data": "hi\\n", "nextOffset": 3}\n')
                self.stop.wait(10)
        except OSError:
            pass


class StreamDeadlineTests(unittest.TestCase):
    """Through the real api.stream / cmd_attach over a local socket: the deadline cuts a blocked read itself."""

    def setUp(self):
        _Boat.stop = threading.Event()
        self.srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), _Boat)
        self.srv.daemon_threads = True
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.addCleanup(self.srv.server_close)
        self.addCleanup(self.srv.shutdown)
        self.addCleanup(_Boat.stop.set)
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(api, 'API', f'http://127.0.0.1:{self.srv.server_address[1]}'))
        stack.enter_context(patch.object(api, '_key', return_value='k'))

    def read_until(self, path, deadline_in):
        t0 = time.time()
        got = []
        with self.assertRaises(api.StreamDeadline):
            for fr in api.stream(path, timeout=90, deadline=t0 + deadline_in):
                got.append(fr)
        return got, time.time() - t0

    def test_output_near_the_deadline_then_silence(self):
        # Before: the socket timeout was fixed at open (3 s), so a frame at 2.5 s let the next read block to ~5.5 s.
        _Boat.frame_at = 2.5
        for path in ('/quiet', '/quiet?plain=1'):
            got, took = self.read_until(path, 3.0)
            self.assertEqual([f.get('data') for f in got], ['hi\n'], path)
            self.assertLess(took, 3.8, path)

    def test_partial_line_trickling_bytes(self):
        # Before: every byte restarted the socket timeout, so the read never ended while bytes kept coming.
        for path in ('/trickle', '/trickle?plain=1'):
            got, took = self.read_until(path, 2.0)
            self.assertEqual(got, [], path)
            self.assertLess(took, 2.8, path)

    def test_follow_wait_timeout_ends_on_time_through_the_real_stream(self):
        # offbox wait --timeout 3 on a run whose output stops just before the deadline: 124 at the deadline, the
        # frame logged once, nothing stopped.
        _Boat.frame_at = 2.5
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / 'run-q.log'
            t0 = time.time()
            with patch.object(runs, '_ttl_keeper'), patch.object(runs.api, 'cmd_status', return_value=None), \
                    patch.object(runs.api, 'cmd_kill', side_effect=AssertionError('must not stop the run')):
                with self.assertRaises(common.OffboxError) as caught:
                    runs.follow('bx_a', 7, log, echo=False, run_id='run-q', until=t0 + 3.0)
            took = time.time() - t0
            self.assertEqual(caught.exception.code, 124)
            self.assertLess(took, 3.8)
            self.assertEqual(log.read_bytes(), b'hi\n')
            self.assertEqual(common.checkpoint(log), {'stdoutOffset': 3, 'stderrOffset': 0, 'logBytes': 3})


if __name__ == '__main__':
    unittest.main()
