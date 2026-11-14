"""A quiet push is bounded even when a child or the stdin writer holds a pipe."""
import contextlib
import io
import re
from pathlib import Path
import subprocess
import sys
import textwrap
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import api, lease, pool, prepare, ssh_sync
from offbox_lib.common import OffboxError
from test_box_owned_files import DENIED
from test_capacity import Isolated

STATS = 'Total bytes sent: 1,234\nNumber of regular files transferred: 1\n'
REMOTE_STALL = ssh_sync._remote_stall


class FailingStderr:
    def __init__(self, error, operation):
        self.error, self.operation, self.attempts = error, operation, 0

    def write(self, text):
        self.attempts += 1
        if self.operation == 'write':
            raise self.error('stderr disappeared')
        return len(text)

    def flush(self):
        if self.operation == 'flush':
            raise self.error('stderr disappeared')

    def fileno(self):
        raise io.UnsupportedOperation('no underlying descriptor')


class SyncStallTests(Isolated):
    def setUp(self):
        super().setUp()
        self.base = Path(self.tmp.name)
        self.fake = self.base / 'rsync'
        self.launches = self.base / 'launches'
        self.box('testbox', member=True)
        self.stack.enter_context(patch.object(ssh_sync, 'RSYNC', str(self.fake)))
        self.stack.enter_context(patch.object(ssh_sync, 'STALL_S', 1))
        self.stack.enter_context(patch.object(ssh_sync, '_progress_args', return_value=()))
        self.close = self.stack.enter_context(patch.object(ssh_sync, 'close_master'))
        self.setup = self.stack.enter_context(patch.object(ssh_sync, 'setup'))
        self.log = self.stack.enter_context(patch.object(ssh_sync, 'log'))
        self.remote = self.stack.enter_context(patch.object(ssh_sync, '_remote_stall', return_value=('remote_rsync_stat=S wchan=do_select', None)))
        self.fs = self.stack.enter_context(patch.object(ssh_sync, '_source_fs', return_value='apfs'))
        self.err = io.StringIO()
        self.stack.enter_context(contextlib.redirect_stderr(self.err))

    def script(self, body):
        self.fake.write_text(f'#!{sys.executable} -S\n' + textwrap.dedent(f'''
import os, pathlib, subprocess, sys, time
launches = pathlib.Path({str(self.launches)!r})
n = len(launches.read_text().splitlines()) if launches.exists() else 0
with launches.open('a') as f: f.write(str(os.getpid())+'\\n')
''') + textwrap.dedent(body))
        self.fake.chmod(0o755)

    def sync(self, **kwargs):
        return ssh_sync._rsync('testbox', 'w/repo-abcdef', [str(self.fake)], kwargs.pop('timeout', 10),
                               source=self.base, **kwargs)

    def quarantined(self):
        return self.con.execute("SELECT state FROM leases WHERE box_id='testbox'").fetchone()[0] == 'quarantined'

    def test_double_stall_quarantines_and_kills_children(self):
        self.script('''
child = subprocess.Popen(['sleep', '600'])
with (launches.parent/'children').open('a') as f: f.write(str(child.pid)+'\\n')
time.sleep(600)
''')
        with self.assertRaisesRegex(OffboxError, 'stalled:.*twice.*quarantined') as cm:
            self.sync()
        self.assertEqual(cm.exception.code, 90)
        self.assertEqual(len(self.launches.read_text().splitlines()), 2)
        self.assertEqual(self.close.call_count, 2)
        self.setup.assert_called_once_with('testbox')
        self.assertTrue(self.quarantined())
        self.assertEqual(pool.members(self.con, 'repo'), [])
        self.assertEqual(self.con.execute("SELECT count(*) FROM events WHERE kind='lease_quarantined'").fetchone()[0], 1)
        for pid in map(int, (self.base/'children').read_text().splitlines()):
            p = subprocess.run(['ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, text=True)
            self.assertTrue(p.returncode or p.stdout.strip().startswith('Z'), p.stdout)

    def test_stall_once_then_stats_and_no_quarantine(self):
        self.script(f'if n == 0: time.sleep(600)\nprint({STATS!r})\n')
        self.assertEqual(ssh_sync._stats(self.sync()), {'sent': 1234, 'files': 1})
        self.assertFalse(self.quarantined())
        self.close.assert_called_once_with('testbox')
        self.setup.assert_called_once_with('testbox')

    def test_progress_keeps_single_file_alive_and_reports_pass_and_bytes(self):
        self.script(f'''
for i in range(7):
    sys.stdout.write('\\r%12d  50%%  1.00MB/s 0:00:01 (xfr#1, to-chk=0/1)' % (i*1000))
    sys.stdout.flush()
    time.sleep(.3)
print('\\r'+{STATS!r})
''')
        with patch.object(ssh_sync, 'SYNC_PROGRESS_S', .2):
            out = self.sync(phase='files2')
        self.assertNotIn('%', out)
        self.assertEqual(ssh_sync._stats(out), {'sent': 1234, 'files': 1})
        self.close.assert_not_called()
        self.assertIn('pass=files2 bytes_sent=', self.err.getvalue())
        self.assertIn('bytes_sent=5000', self.err.getvalue())

    def test_failing_status_output_preserves_healthy_transfer(self):
        for error in (BrokenPipeError, OSError, ValueError):
            for operation in ('write', 'flush'):
                with self.subTest(error=error, operation=operation):
                    self.script(f'''
for i in range(5):
    print('progress', flush=True)
    time.sleep(.04)
print({STATS!r})
''')
                    stderr = FailingStderr(error, operation)
                    with contextlib.redirect_stderr(stderr), patch.object(ssh_sync, 'SYNC_PROGRESS_S', .05):
                        self.assertEqual(ssh_sync._stats(self.sync())['sent'], 1234)
                    self.assertGreater(stderr.attempts, 0)
        self.close.assert_not_called()
        self.setup.assert_not_called()
        self.assertFalse(self.quarantined())
        self.assertEqual(len(self.launches.read_text().splitlines()), 6)

    def test_failing_status_output_preserves_stall_recovery(self):
        for error in (BrokenPipeError, OSError, ValueError):
            for operation in ('write', 'flush'):
                with self.subTest(error=error, operation=operation):
                    before = len(self.launches.read_text().splitlines()) if self.launches.exists() else 0
                    self.script(f'if n == {before}: time.sleep(600)\nprint({STATS!r})\n')
                    stderr = FailingStderr(error, operation)
                    with contextlib.redirect_stderr(stderr), patch.object(ssh_sync, 'STALL_S', .5):
                        self.assertEqual(ssh_sync._stats(self.sync())['sent'], 1234)
                    self.assertGreater(stderr.attempts, 0)
                    self.assertEqual(len(self.launches.read_text().splitlines()), before + 2)
        self.assertEqual(self.close.call_count, 6)
        self.assertEqual(self.setup.call_count, 6)
        self.assertFalse(self.quarantined())

    def test_failing_status_output_preserves_connection_retry(self):
        self.script(f'if n == 0: sys.exit(12)\nprint({STATS!r})\n')
        stderr = FailingStderr(BrokenPipeError, 'write')
        with contextlib.redirect_stderr(stderr), patch.object(ssh_sync, 'RETRY_PAUSES', (0,)), \
                patch.object(api, 'get', return_value={'state': 'running'}):
            self.assertEqual(ssh_sync._stats(self.sync())['sent'], 1234)
        self.assertGreater(stderr.attempts, 0)
        self.close.assert_called_once()
        self.setup.assert_called_once()
        self.assertFalse(self.quarantined())

    def test_stderr_bytes_and_split_utf8_are_drained(self):
        self.script('''
for _ in range(5):
    os.write(2, b'\\xe2'); time.sleep(.08); os.write(2, b'\\x82\\xac'); time.sleep(.08)
print('done')
''')
        with patch.object(ssh_sync, 'STALL_S', .5):
            self.assertIn('done', self.sync())
        self.close.assert_not_called()

    def test_reclaim_rerun_uses_watchdog(self):
        self.script(f'if n == 0:\n    sys.stderr.write({DENIED!r})\n    sys.exit(23)\nprint({STATS!r})\n')
        with patch.object(ssh_sync, '_reclaim', return_value=True) as reclaim:
            self.assertEqual(ssh_sync._stats(self.sync())['sent'], 1234)
        reclaim.assert_called_once_with('testbox', 'w/repo-abcdef')
        self.assertEqual(len(self.launches.read_text().splitlines()), 2)

    def test_git_stall_recovers(self):
        self.script(f'if n == 0: time.sleep(600)\nprint({STATS!r})\n')
        with patch.object(ssh_sync, 'ssh', return_value=subprocess.CompletedProcess([], 0, b'', b'')):
            self.assertEqual(ssh_sync._push_git('testbox', self.base, 'w/repo-abcdef', 10)['sent'], 1234)
        self.assertIn('pass=git', str(self.log.call_args_list))
        self.assertFalse(self.quarantined())

    def test_slow_git_progress_completes_with_growing_byte_heartbeats(self):
        self.script(f'''
for i in range(1, 7):
    print('\\r%d 50%% 1MB/s 0:00:01 (xfr#1, to-chk=1/2)' % (i*1000), end='\\r', flush=True)
    time.sleep(.15)
print({STATS!r})
''')
        with patch.object(ssh_sync, 'ssh', return_value=subprocess.CompletedProcess([], 0, b'', b'')), \
                patch.object(ssh_sync, 'STALL_S', .5), patch.object(ssh_sync, 'SYNC_PROGRESS_S', .1):
            self.assertEqual(ssh_sync._push_git('testbox', self.base, 'w/repo-abcdef', 10)['sent'], 1234)
        sent = list(map(int, re.findall(r'pass=git bytes_sent=(\d+)', self.err.getvalue())))
        self.assertGreater(len(set(sent)), 2)
        self.assertEqual(sent, sorted(sent))
        self.close.assert_not_called()
        self.setup.assert_not_called()
        self.assertFalse(self.quarantined())
        self.assertEqual(len(self.launches.read_text().splitlines()), 1)

    def test_files_to_git_switch_resets_idle_clock(self):
        self.script(f'if n == 0: print("ready", flush=True)\ntime.sleep(.65)\nprint({STATS!r})\n')

        def stage(box, cmd, **kwargs):
            if cmd.startswith('mkdir'):
                time.sleep(.45)
            return subprocess.CompletedProcess([], 0, b'', b'')

        with patch.object(ssh_sync, 'ssh', side_effect=stage), patch.object(ssh_sync, 'STALL_S', 1):
            self.assertEqual(ssh_sync._stats(self.sync())['sent'], 1234)
            self.assertEqual(ssh_sync._push_git('testbox', self.base, 'w/repo-abcdef', 10)['sent'], 1234)
        self.assertEqual(len(self.launches.read_text().splitlines()), 2)
        self.close.assert_not_called()
        self.setup.assert_not_called()

    def test_git_progress_then_silence_retries_and_quarantines(self):
        # No trailing delimiter: rsync can leave its last 100% frame on the terminal while waiting for the box.
        self.script('''
print('1234 100% 1MB/s 0:00:00 (xfr#1, to-chk=0/1)', end='', flush=True)
time.sleep(600)
''')
        with patch.object(ssh_sync, 'ssh', return_value=subprocess.CompletedProcess([], 0, b'', b'')), \
                patch.object(ssh_sync, 'STALL_S', .5), patch.object(ssh_sync, 'SYNC_PROGRESS_S', .1):
            with self.assertRaisesRegex(OffboxError, 'stalled:.*twice.*source sent; waiting on box') as cm:
                ssh_sync._push_git('testbox', self.base, 'w/repo-abcdef', 10)
        self.assertEqual(cm.exception.code, 90)
        self.assertEqual(len(self.launches.read_text().splitlines()), 2)
        self.assertEqual(self.close.call_count, 2)
        self.setup.assert_called_once_with('testbox')
        self.assertTrue(self.quarantined())
        self.assertIn('pass=git bytes_sent=1234', self.err.getvalue())
        self.assertIn('source sent; waiting on box', self.err.getvalue())
        self.assertNotIn('source read stalled', self.err.getvalue())
        self.assertIn("wait='source sent; waiting on box'", str(self.log.call_args_list))

    def test_incomplete_scan_progress_does_not_claim_source_sent(self):
        for frame in ('1234 100% 1MB/s 0:00:00 (xfr#1, ir-chk=0/1)',
                      '1234 100% 1MB/s 0:00:00 (xfr#1, to-chk=1/2)',
                      '1234 50% 1MB/s 0:00:00 (xfr#1, to-chk=0/1)'):
            with self.subTest(frame=frame):
                self.err.seek(0)
                self.err.truncate()
                self.script(f'print({frame!r}, end="", flush=True)\ntime.sleep(600)\n')
                with patch.object(ssh_sync, 'STALL_S', .5), self.assertRaises(OffboxError) as cm:
                    self.sync()
                self.assertIn('waiting for transfer progress', str(cm.exception))
                self.assertNotIn('source sent;', str(cm.exception))
                self.assertNotIn('source read stalled', str(cm.exception))

    def test_outer_prepare_alarm_still_kills_term_ignoring_group(self):
        self.script('''
import signal
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = subprocess.Popen(['sleep', '600'])
(launches.parent/'child').write_text(str(child.pid))
print('ready', flush=True)
time.sleep(600)
''')
        with self.assertRaises(prepare.Stalled), prepare.guard('testbox', seconds=.7):
            self.sync()
        for pid in [*map(int, self.launches.read_text().splitlines()), int((self.base/'child').read_text())]:
            p = subprocess.run(['ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, text=True)
            self.assertTrue(p.returncode or p.stdout.strip().startswith('Z'), p.stdout)

    def test_hard_timeout_never_retries(self):
        self.script('time.sleep(600)')
        started = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired):
            self.sync(timeout=.2)
        self.assertLess(time.monotonic()-started, 1)
        self.close.assert_not_called()
        self.assertFalse(self.quarantined())

    def test_hard_timeout_wins_if_diagnosis_spends_remaining_budget(self):
        self.script('time.sleep(600)')
        with patch.object(ssh_sync, 'STALL_S', .05), \
                patch.object(ssh_sync, '_stall_diagnosis', side_effect=lambda *a: time.sleep(.1) or {}):
            with self.assertRaises(subprocess.TimeoutExpired):
                self.sync(timeout=.1)
        self.close.assert_not_called()

    def test_nfs_source_is_logged_and_explained(self):
        self.script(f'if n == 0: time.sleep(600)\nprint({STATS!r})\n')
        self.fs.return_value = 'nfs'
        with patch.object(ssh_sync, 'STALL_S', .5):
            self.sync()
        self.assertIn('source is on nfs', self.err.getvalue())
        self.assertIn('src_fs=nfs bytes_seen=0', str(self.log.call_args_list))

    def test_remote_disk_and_fuse_block_quarantine_without_retry(self):
        self.script('time.sleep(600)')
        for state, channel, reason in [('D', 'io_schedule', 'box disk I/O blocked'),
                                        ('S', 'request_wait_answer', 'box workspace filesystem (FUSE) blocked'),
                                        ('S', 'fuse_wait_on_page_writeback', 'box workspace filesystem (FUSE) blocked')]:
            with self.subTest(channel=channel):
                output = f'42 1 {state} {channel} 00:10 rsync rsync --server .\n43 1 S do_wait 00:10 mv mv w/old .offbox/trash/old\n'.encode()
                with patch.object(ssh_sync, '_remote_stall', REMOTE_STALL), \
                        patch.object(ssh_sync, '_bounded_command', return_value=subprocess.CompletedProcess([], 0, output, b'')), \
                        patch.object(ssh_sync, 'STALL_S', 1):
                    with self.assertRaises(OffboxError) as cm:
                        self.sync()
                self.assertIn(reason, str(cm.exception))
                self.assertIn('remote receiver blocked', str(cm.exception))
                self.assertNotIn('source read stalled', str(cm.exception))
                self.assertTrue(self.quarantined())
        self.assertEqual(len(self.launches.read_text().splitlines()), 3)
        self.setup.assert_not_called()
        self.assertIn('mv w/old', str(self.log.call_args_list))

    def test_large_stdin_is_fully_sent_and_nonreader_is_bounded(self):
        payload = 'tracked\0' * 200000
        self.script(f'data=sys.stdin.buffer.read()\nassert len(data)=={len(payload)}\nprint({STATS!r})')
        self.assertEqual(ssh_sync._stats(self.sync(files=payload))['sent'], 1234)
        self.script('time.sleep(600)')
        with patch.object(ssh_sync, 'STALL_S', .5), self.assertRaisesRegex(OffboxError, 'stalled'):
            self.sync(files=payload)

    def test_remote_probe_failure_still_retries(self):
        self.script(f'if n == 0: time.sleep(600)\nprint({STATS!r})')
        self.remote.return_value = ('remote_probe=unavailable', None)
        self.close.side_effect = OffboxError('close failed')
        self.setup.side_effect = subprocess.TimeoutExpired('setup', 1)
        with patch.object(ssh_sync, 'STALL_S', .5):
            self.assertEqual(ssh_sync._stats(self.sync())['sent'], 1234)


class QuarantineTests(Isolated):
    def test_cached_running_and_stopped_rows_cannot_reuse_quarantined_box(self):
        for state in ('running', 'stopped'):
            with self.subTest(state=state):
                self.box(state, state=state, member=True)
                cached = dict(self.con.execute('SELECT * FROM leases WHERE box_id=?', (state,)).fetchone())
                lease.quarantine(state, 'push stalled twice')
                with patch.object(api, 'get', side_effect=AssertionError('no box contact after quarantine')):
                    self.assertIsNone(lease._reuse(self.con, cached, None))
                self.assertFalse(any(row['box_id'] == state for row in pool.members(self.con, 'repo')))

    def test_recipe_retirement_shares_quarantine(self):
        self.box('recipe')
        with patch.object(lease, 'delete_box', return_value=False):
            self.assertFalse(lease._retire_recipe_box('recipe', None, 'recipe interrupted'))
        self.assertEqual(self.con.execute("SELECT state FROM leases WHERE box_id='recipe'").fetchone()[0], 'quarantined')


class StallDiagnosisTests(unittest.TestCase):
    def test_sample_and_remote_probe_use_run_id_and_bounded_budgets(self):
        import tempfile
        from offbox_lib import common
        real_exists = Path.exists
        with tempfile.TemporaryDirectory() as tmp, patch.object(common, 'LOGS_DIR', Path(tmp)), \
                patch.object(ssh_sync.sys, 'platform', 'darwin'), \
                patch.object(Path, 'exists', lambda path: str(path) == '/usr/bin/sample' or real_exists(path)), \
                patch.object(ssh_sync, '_source_fs', return_value='apfs'), \
                patch.object(ssh_sync, '_remote_stall', return_value=('remote_rsync_stat=S', None)) as probe, \
                patch.object(ssh_sync, '_bounded_command') as run, patch.object(ssh_sync, 'log') as log:
            def sample(cmd, timeout, **kw):
                self.assertEqual(cmd, ['/usr/bin/sample', '42', '2'])
                self.assertLessEqual(timeout, 5)
                kw['stdout'].write(b'sample write_buf -> poll\n')
            run.side_effect = sample
            result = ssh_sync._stall_diagnosis('box', 42, Path(tmp), 'run-test', 'files1', 123, 15)
            self.assertEqual((Path(tmp)/'run-test.stall.sample').read_text(), 'sample write_buf -> poll\n')
            self.assertEqual(result['src_fs'], 'apfs')
            self.assertLessEqual(probe.call_args.args[1], 10)
            self.assertIn('src_fs=apfs bytes_seen=123', log.call_args.args[0])
            self.assertEqual(result['wait'], 'waiting on remote receiver')

    def test_unreaped_statfs_helper_cannot_hold_diagnosis(self):
        from unittest.mock import MagicMock
        proc = MagicMock(pid=777, returncode=None)
        proc.wait.side_effect = subprocess.TimeoutExpired('statfs', 2)
        proc.poll.return_value = None
        with patch.object(ssh_sync.sys, 'platform', 'darwin'), \
                patch.object(ssh_sync.subprocess, 'Popen', return_value=proc), \
                patch.object(ssh_sync.os, 'killpg') as kill:
            self.assertEqual(ssh_sync._source_fs(Path('/stalled/nfs')), 'unknown')
        self.assertEqual([c.kwargs['timeout'] for c in proc.wait.call_args_list], [2, .1])
        import signal
        kill.assert_called_once_with(777, signal.SIGKILL)

    def test_remote_probe_timeout_is_inconclusive(self):
        with patch.object(ssh_sync, '_bounded_command', return_value=None) as run:
            self.assertEqual(ssh_sync._remote_stall('box', 10), ('remote_probe=unavailable', None))
            self.assertEqual(run.call_args.args[1], 10)
            self.assertIn('ControlPath=none', run.call_args.args[0])


class ProgressFormatTests(unittest.TestCase):
    def test_wait_label_uses_evidence_instead_of_assuming_source_read(self):
        for sent, blocked, sample, expected in (
                (False, None, '', 'waiting for transfer progress'),
                (False, None, 'map_ptr -> read', 'local source read stalled'),
                (False, None, 'map_ptr -> stalled_read -> sleep', 'local source read stalled'),
                (False, None, 'read_ndx_and_attrs -> read_a_msg', 'waiting on remote receiver'),
                (False, None, 'write_buf -> poll', 'waiting on remote receiver'),
                (True, None, '', 'source sent; waiting on box'),
                (True, 'box disk I/O blocked', '', 'remote receiver blocked: box disk I/O blocked'),
                (False, 'box workspace filesystem (FUSE) blocked', 'map_ptr -> read',
                 'remote receiver blocked: box workspace filesystem (FUSE) blocked')):
            with self.subTest(sent=sent, blocked=blocked, sample=sample):
                self.assertEqual(ssh_sync._sync_wait(sent, blocked, sample), expected)

    def test_progress_variants_preserve_items_stats_and_filename_bytes(self):
        for progress in ['\r 1,234 50% 1MB/s 0:01:00', ' 1,234 100% 1MB/s 0:00:00 (xfr#1, to-chk=0/1)',
                         ' 1,234 100% 1MB/s 0:00:00 (xfr#1, ir-chk=0/1)']:
            for sep in ['\r', '\n', '\r\n']:
                with self.subTest(progress=progress, sep=sep):
                    item = '@OFFBOX@>f+++++++++ file\vname\n'
                    out = ssh_sync._without_progress(item+progress+sep+STATS)
                    self.assertIn(item, out)
                    self.assertEqual(ssh_sync._stats(out)['sent'], 1234)
                    self.assertNotIn('%', out)

    def test_items_after_progress_frames_reach_seen_without_pass_two_duplicates(self):
        first = 'offbox-item >f+++++++++ first.txt\n'
        second = 'offbox-item >f+++++++++ second.txt\n'
        for prefix in ('', '\r'):
            for ending in ('\r', '\n', '\r\n'):
                with self.subTest(prefix=prefix, ending=ending):
                    progress = prefix+' 1,234 100% 1MB/s 0:00:00 (xfr#1, to-chk=0/1)'+ending
                    out = ssh_sync._without_progress(first+progress+prefix+second+STATS)
                    self.assertEqual(ssh_sync._seen(out), {'first.txt', 'second.txt'})
                    self.assertEqual(ssh_sync._stats(out)['sent'], 1234)

    def test_only_rsync_3_gets_progress_args_and_version_is_cached(self):
        for banner, expected in [(b'rsync  version 3.5.1  protocol version 33', True),
                                  (b'rsync version 3.4.1', True),
                                  (b'openrsync: protocol version 29\nrsync version 2.6.9 compatible', False)]:
            with self.subTest(banner=banner):
                ssh_sync._progress_args.cache_clear()
                with patch.object(ssh_sync.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, banner, b'')) as run:
                    self.assertEqual(bool(ssh_sync._progress_args('fake')), expected)
                    ssh_sync._progress_args('fake')
                    run.assert_called_once()
        ssh_sync._progress_args.cache_clear()


if __name__ == '__main__':
    unittest.main()
