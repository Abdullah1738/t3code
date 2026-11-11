"""Offline settled-log recovery, including independent stream offsets and large retained histories."""
import contextlib
import hashlib
import io
from pathlib import Path
import sys
import tracemalloc
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import api, common, misc, pool, reap, runs
from offbox_lib.common import OffboxError
from test_capacity import Isolated

HISTORY_LOGS = api.history_logs


class LogCatchupTests(Isolated):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(api, 'call', side_effect=AssertionError('offline: no API calls')))
        self.stack.enter_context(patch.object(api, 'get', side_effect=AssertionError('must not inspect or wake box')))
        self.stack.enter_context(patch.object(runs.lease, 'touch'))
        self.stack.enter_context(patch.object(runs.lease, 'idle_ttl'))
        self.stack.enter_context(patch.object(runs, 'settle_docker'))
        self.history = self.stack.enter_context(patch.object(api, 'history_logs'))
        self.con.execute("INSERT INTO runs(run_id,box_id,command_id,process_id,status,mode,exit_code,pulls,start_at) "
                         "VALUES ('run-x','bx_a','cmd_a',7,'done','bg',0,'[]',900)")
        self.con.commit()
        self.path = common.LOGS_DIR / 'run-x.log'
        self.prefix(b'prefix\n')
        self.streams(b'prefix\nrest\n', b'')

    def row(self):
        return self.con.execute("SELECT * FROM runs WHERE run_id='run-x'").fetchone()

    def state(self, status, code):
        self.con.execute("UPDATE runs SET status=?,exit_code=? WHERE run_id='run-x'", (status, code))
        self.con.commit()

    def prefix(self, data, out=None, err=0):
        self.path.write_bytes(data)
        common.atomic_write_json(common.offsets_path(self.path),
                                 dict(stdoutOffset=len(data) if out is None else out,
                                      stderrOffset=err, logBytes=len(data)))

    def streams(self, stdout, stderr, page=4096):
        def history(box, cmd, which, offset, **kwargs):
            self.assertEqual((box, cmd), ('bx_a', 'cmd_a'))
            self.assertIn('deadline', kwargs)
            source = stdout if which == 'stdout' else stderr
            data = source[offset:offset + page]
            nxt = offset + len(data)
            return dict(data=data.decode(), nextOffset=nxt, size=len(source), done=nxt == len(source))
        self.history.side_effect = history

    def invoke(self, wait=False, follow=False):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = misc.wait('run-x', None) if wait else misc.logs('run-x', follow)
        return code, out.getvalue(), err.getvalue()

    def test_logs_completes_and_repeated_logs_do_not_duplicate(self):
        self.assertEqual(self.invoke(), (0, 'prefix\nrest\n', ''))
        self.assertEqual(self.path.read_bytes(), b'prefix\nrest\n')
        self.assertEqual(common.checkpoint(self.path), dict(stdoutOffset=12, stderrOffset=0, logBytes=12))
        self.history.reset_mock()
        inode = self.path.stat().st_ino
        self.assertEqual(self.invoke(), (0, 'prefix\nrest\n', ''))
        self.assertEqual([c.args[3] for c in self.history.call_args_list], [12, 0])
        self.assertEqual(self.path.stat().st_ino, inode)

    def test_wait_completes_and_preserves_exit_code(self):
        self.state('failed', 7)
        code, out, err = self.invoke(wait=True)
        self.assertEqual(code, 7)
        self.assertEqual(self.path.read_bytes(), b'prefix\nrest\n')
        self.assertIn('failed exit=7', out)
        self.assertEqual(err, '')

    def test_uncommitted_suffix_is_removed_before_appending(self):
        with self.path.open('ab') as f:
            f.write(b'rest\nuncommitted')
        self.assertEqual(self.invoke(), (0, 'prefix\nrest\n', ''))
        self.assertEqual(self.path.read_bytes(), b'prefix\nrest\n')

    def test_history_error_leaves_original_and_warns(self):
        ck = common.offsets_path(self.path).read_bytes()
        self.history.side_effect = OffboxError('history unavailable')
        code, out, err = self.invoke()
        self.assertEqual((code, out), (0, 'prefix\n'))
        self.assertIn("local log stops at 7 bytes", err)
        self.assertIn('history unavailable', err)
        self.assertIn('output is incomplete', err)
        self.assertEqual(self.path.read_bytes(), b'prefix\n')
        self.assertEqual(common.offsets_path(self.path).read_bytes(), ck)
        self.assertFalse(list(self.path.parent.glob('*.catchup.*')))
        self.assertEqual(self.invoke(wait=True)[0], 0)

    def test_no_checkpoint_does_not_guess_stream_offsets(self):
        common.offsets_path(self.path).unlink()
        code, out, err = self.invoke()
        self.assertEqual((code, out), (0, 'prefix\n'))
        self.assertIn('no checkpoint', err)
        self.assertIn('output is incomplete', err)
        self.assertEqual(self.path.read_bytes(), b'prefix\n')

    def test_held_lock_skips_fetch_and_write(self):
        with common.file_lock('box-bx_a', timeout=0):
            self.assertEqual(misc._catch_up_log(self.row()), 'n/a')
        self.history.assert_not_called()
        self.assertEqual(self.path.read_bytes(), b'prefix\n')

    def test_running_plain_logs_never_fetch_or_write(self):
        for status in ('starting', 'running'):
            with self.subTest(status=status):
                self.state(status, None)
                ck = common.offsets_path(self.path).read_bytes()
                before = self.path.stat()
                code, out, err = self.invoke()
                self.assertEqual((code, out), (0, 'prefix\n'))
                self.assertIn('is still running', err)
                self.assertIn('7 bytes, last written ', err)
                self.assertIn('only grows while someone follows it', err)
                self.assertIn('offbox logs --follow run-x', err)
                self.assertEqual(self.path.stat().st_mtime_ns, before.st_mtime_ns)
                self.assertEqual(common.offsets_path(self.path).read_bytes(), ck)
        self.history.assert_not_called()

    def test_running_with_no_local_log_says_never(self):
        self.state('running', None)
        self.path.unlink()
        ck = common.offsets_path(self.path).read_bytes()
        code, out, err = self.invoke()
        self.assertEqual((code, out), (0, ''))
        self.assertIn('0 bytes, last written never', err)
        self.assertFalse(self.path.exists())
        self.assertEqual(common.offsets_path(self.path).read_bytes(), ck)
        self.history.assert_not_called()

    def test_already_complete_does_not_replace_log(self):
        self.streams(b'prefix\n', b'')
        inode = self.path.stat().st_ino
        ck = common.offsets_path(self.path).stat().st_mtime_ns
        self.assertEqual(misc._catch_up_log(self.row()), 'complete')
        self.assertEqual(self.path.stat().st_ino, inode)
        self.assertEqual(common.offsets_path(self.path).stat().st_mtime_ns, ck)

    def test_stderr_only_prefix_with_stdout_zero_and_stderr_tail(self):
        prefix = b'e' * 4082
        tail = b'\n' + b'x' * 53 + b'\noffbox step 2 rc=0\n'
        stdout = b'399/399 stdout\n' * 300
        self.prefix(prefix, out=0, err=4082)
        self.streams(stdout, prefix + tail, page=1000)
        self.state('failed', 1)
        self.assertEqual(self.invoke(wait=True)[0], 1)
        self.assertEqual(self.path.read_bytes(), prefix + stdout + tail)
        self.assertEqual(common.checkpoint(self.path),
                         dict(stdoutOffset=len(stdout), stderrOffset=4082 + len(tail),
                              logBytes=4082 + len(stdout) + len(tail)))
        self.assertEqual([c.args[3] for c in self.history.call_args_list if c.args[2] == 'stderr'], [4082])

    def test_more_than_200_pages_and_settled_follow(self):
        stdout = b'prefix\n' + b'x' * (300 * 4096)
        for follow in (False, True):
            with self.subTest(follow=follow):
                self.prefix(b'prefix\n')
                self.streams(stdout, b'')
                self.history.reset_mock()
                with patch.object(misc.time, 'time', return_value=1000):
                    code, out, err = self.invoke(follow=follow)
                self.assertEqual((code, out, err), (0, stdout.decode(), ''))
                self.assertGreater(self.history.call_count, 300)
                self.assertEqual(self.path.stat().st_size, len(stdout))

    def test_45_mb_tail_has_bounded_memory_and_no_page_cap(self):
        pages = 11_520
        chunk = 'x' * 4096
        size = 7 + pages * 4096
        calls = [0]
        def history(box, cmd, which, offset, **kw):
            calls[0] += 1
            if which == 'stderr' or offset == size:
                return dict(data='', nextOffset=offset, size=0 if which == 'stderr' else size, done=True)
            nxt = offset + 4096
            return dict(data=chunk, nextOffset=nxt, size=size, done=nxt == size)
        # Avoid Mock retaining 11,520 calls: the producer and the consumer both keep one page at a time.
        with patch.object(api, 'history_logs', history), patch.object(misc.time, 'time', lambda: 1000):
            tracemalloc.start()
            try:
                self.assertEqual(misc._catch_up_log(self.row()), 'caught_up')
                peak = tracemalloc.get_traced_memory()[1]
            finally:
                tracemalloc.stop()
        self.assertEqual(calls[0], pages + 1)
        self.assertEqual(self.path.stat().st_size, size)
        self.assertLess(peak, 5 * 1024 * 1024)
        digest = hashlib.sha256(b'prefix\n')
        for _ in range(pages):
            digest.update(chunk.encode())
        with self.path.open('rb') as f:
            self.assertEqual(hashlib.file_digest(f, 'sha256').digest(), digest.digest())

    def test_no_progress_preserves_original(self):
        self.history.side_effect = None
        self.history.return_value = dict(data='', nextOffset=7, done=False, size=100)
        self.assertEqual(misc._catch_up_log(self.row()), 'incomplete:no progress')
        self.assertEqual(self.path.read_bytes(), b'prefix\n')

    def test_partial_second_stream_error_does_not_publish_stdout_tail(self):
        original = self.history.side_effect
        def history(box, cmd, which, offset, **kw):
            if which == 'stderr':
                raise OffboxError('stderr unavailable')
            return original(box, cmd, which, offset, **kw)
        self.history.side_effect = history
        self.assertIn('incomplete:', misc._catch_up_log(self.row()))
        self.assertEqual(self.path.read_bytes(), b'prefix\n')
        self.assertEqual(common.checkpoint(self.path)['stdoutOffset'], 7)

    def test_timeout_preserves_original_and_is_forwarded_to_transport(self):
        clock = [1000.0]
        def history(*args, **kwargs):
            self.assertEqual(kwargs['deadline'], 1010)
            clock[0] = 1011
            raise OffboxError('deadline expired')
        self.history.side_effect = history
        with patch.object(misc.time, 'time', side_effect=lambda: clock[0]):
            self.assertEqual(misc._catch_up_log(self.row(), budget=10), 'incomplete:timeout')
        self.assertEqual(self.path.read_bytes(), b'prefix\n')

    def test_stale_takeover_cannot_shrink_completed_log(self):
        takeover = self.path.with_name(self.path.name + '.takeover')
        takeover.write_bytes(self.path.read_bytes())
        common.offsets_path(takeover).write_bytes(common.offsets_path(self.path).read_bytes())
        self.assertEqual(misc._catch_up_log(self.row()), 'caught_up')
        self.assertFalse(takeover.exists())
        self.assertFalse(common.offsets_path(takeover).exists())
        ck = common.checkpoint(self.path)
        with patch.object(misc, '_resolve_exit', return_value=0), patch.object(misc, '_finalize', return_value=0):
            misc._replay_takeover(self.row(), False, None, (ck['stdoutOffset'], ck['stderrOffset']),
                                  self.path, ck['logBytes'], has_checkpoint=True)
        self.assertEqual(self.path.read_bytes(), b'prefix\nrest\n')

    def test_reaper_and_pool_best_effort_settlement(self):
        self.box('bx_a', member=True)
        for caller in ('reaper', 'pool'):
            for error in (False, True):
                with self.subTest(caller=caller, error=error):
                    self.prefix(b'prefix\n')
                    self.streams(b'prefix\nrest\n', b'')
                    if error:
                        self.history.side_effect = OffboxError('history unavailable')
                    self.state('running', None)
                    with patch.object(api, 'cmd_status', return_value=dict(running=False,status='exited',exitCode=3)):
                        if caller == 'reaper':
                            reap._check_stale_runs(self.con, 'bx_a', 'running', False, [])
                        else:
                            pool._refresh_background(self.con, 'repo')
                    self.assertEqual((self.row()['status'], self.row()['exit_code']), ('failed', 3))
                    self.assertEqual(self.path.read_bytes(), b'prefix\n' if error else b'prefix\nrest\n')
        self.assertGreaterEqual(self.con.execute("SELECT count(*) FROM events WHERE kind='log_catchup_failed'").fetchone()[0], 2)

    def test_reaper_dry_run_leaves_log_and_run_alone(self):
        self.state('running', None)
        with patch.object(api, 'cmd_status', return_value=dict(running=False,status='exited',exitCode=0)):
            reap._check_stale_runs(self.con, 'bx_a', 'running', True, [])
        self.history.assert_not_called()
        self.assertEqual(self.row()['status'], 'running')
        self.assertEqual(self.path.read_bytes(), b'prefix\n')

    def test_missing_settled_log_starts_from_zero_for_logs_and_wait(self):
        for wait in (False, True):
            with self.subTest(wait=wait):
                self.path.unlink(missing_ok=True)
                common.offsets_path(self.path).unlink(missing_ok=True)
                self.assertEqual(self.invoke(wait=wait)[0], 0)
                self.assertEqual(self.path.read_bytes(), b'prefix\nrest\n')
                self.assertEqual(common.checkpoint(self.path)['stdoutOffset'], 12)

    def test_held_lock_with_missing_log_does_not_create_it(self):
        self.path.unlink()
        with common.file_lock('box-bx_a', timeout=0):
            self.assertEqual(misc._catch_up_log(self.row()), 'n/a')
        self.assertFalse(self.path.exists())
        self.history.assert_not_called()

    def test_size_extends_budget_but_maintenance_budget_stays_tight(self):
        for budget in (None, 10):
            with self.subTest(budget=budget):
                self.prefix(b'prefix\n')
                clock = [1000.0]
                page_size = 128 * 1024
                total = 7 + 360 * page_size
                def history(box, cmd, which, offset, **kw):
                    clock[0] += 0.15
                    if which == 'stderr':
                        return dict(data='', nextOffset=0, size=0, done=True)
                    nxt = min(total, offset + page_size)
                    return dict(data='x' * (nxt - offset), nextOffset=nxt, size=total, done=nxt == total)
                with patch.object(api, 'history_logs', history), patch.object(misc.time, 'time', lambda: clock[0]):
                    result = misc._catch_up_log(self.row(), budget=budget)
                self.assertEqual(result, 'caught_up' if budget is None else 'incomplete:timeout')
                self.assertEqual(self.path.stat().st_size, total if budget is None else 7)

    def test_deadline_is_capped_at_180_seconds(self):
        clock = [1000.0]
        def history(box, cmd, which, offset, **kw):
            if offset == 7:
                return dict(data='x', nextOffset=8, size=300_000_000, done=False)
            self.assertEqual(kw['deadline'], 1180)
            clock[0] = 1181
            return dict(data='', nextOffset=8, size=300_000_000, done=False)
        self.history.side_effect = history
        with patch.object(misc.time, 'time', lambda: clock[0]):
            self.assertEqual(misc._catch_up_log(self.row()), 'incomplete:timeout')
        self.assertEqual(self.path.read_bytes(), b'prefix\n')

    def test_streaming_log_preserves_utf8_across_file_chunks(self):
        content = 'x' * 65535 + '€' + 'y' * 65535 + 'é'
        data = content.encode()
        self.prefix(data)
        self.streams(data, b'')
        self.assertEqual(self.invoke(), (0, content, ''))

    def test_history_transport_uses_deadline(self):
        with patch.object(api, 'call', return_value={}) as call:
            HISTORY_LOGS('bx_a', 'cmd_a', 'stderr', 4082, deadline=1010)
        self.assertEqual(call.call_args.kwargs['deadline'], 1010)
        self.assertIn('stream=stderr&offset=4082', call.call_args.args[1])


if __name__ == '__main__':
    unittest.main()
