"""Stale SSH masters fall back to lease recovery before any push or command."""
import contextlib
import io
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, lease, ssh_sync  # noqa: E402
from test_capacity import Isolated  # noqa: E402


class SSHMasterTimeoutTests(Isolated):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        self.stack.enter_context(patch.object(api, 'call', side_effect=AssertionError('offline test reached API')))
        self.stack.enter_context(patch.object(api, 'left', return_value=None))
        self.stack.enter_context(patch.object(lease, 'ensure_ttl'))
        self.stack.enter_context(patch.object(ssh_sync, 'SSH_DIR', Path(self.tmp.name) / 'ssh'))
        # Unix socket paths have a small platform limit; keep the %C directory short.
        cm = self.stack.enter_context(tempfile.TemporaryDirectory(prefix='offbox-cm-', dir='/tmp'))
        self.stack.enter_context(patch.object(ssh_sync, 'CM_DIR', Path(cm)))
        ssh_sync.SSH_DIR.mkdir()
        self.setup = self.stack.enter_context(patch.object(ssh_sync, 'setup'))
        self.wait_ssh = self.stack.enter_context(patch.object(ssh_sync, 'wait_ssh'))

    def running(self, bid='bxA'):
        self.box(bid)
        ssh_sync.cfg_path(bid).write_text(
            f'Host {bid}\n  HostName {bid}.old.example\n  User user\n  Port 22\n'
            f'  ControlPath {ssh_sync.CM_DIR}/%C\n')
        return self.con.execute('SELECT * FROM leases WHERE box_id=?', (bid,)).fetchone()

    def stale_events(self, bid='bxA'):
        return [r[0] for r in self.con.execute(
            "SELECT detail FROM events WHERE box_id=? AND kind='ssh_master_stale'", (bid,))]

    def test_probe_exception_falls_back_to_live_box(self):
        for bid, failure, reason in (
                ('bxA', subprocess.TimeoutExpired('ssh', 10), 'timeout'),
                ('bxB', OSError('ssh unavailable'), 'oserror')):
            with self.subTest(reason=reason):
                row = self.running(bid)
                live = {'state': 'running', 'type': 'large'}
                with patch.object(subprocess, 'run', side_effect=failure), \
                        patch.object(ssh_sync, 'close_master') as close, \
                        patch.object(api, 'get', return_value=live) as get, \
                        patch.object(api, 'wait_state', return_value=live):
                    got = lease._reuse(self.con, row, None)
                self.assertEqual(got['box_id'], bid)
                self.assertEqual(got['state'], 'running')
                close.assert_called_once_with(bid)
                get.assert_called_once_with(bid)
                self.setup.assert_called_with(bid)
                self.assertEqual(self.stale_events(bid), [reason])

    def test_failed_round_trip_resumes_stopped_box_and_refreshes_endpoint(self):
        row = self.running()
        live = {'state': 'running', 'type': 'large'}

        def refresh(bid):
            self.assertEqual(resume.call_count, 1)
            close.assert_called_once_with(bid)
            ssh_sync.cfg_path(bid).write_text('Host bxA\n  HostName new.example\n  Port 2222\n')

        self.setup.side_effect = refresh
        with patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], 255)) as probe, \
                patch.object(ssh_sync, 'close_master') as close, \
                patch.object(api, 'get', return_value={'state': 'archived', 'type': 'large'}) as get, \
                patch.object(api, 'resume', return_value={}) as resume, \
                patch.object(api, 'wait_state', return_value=live):
            got = lease._reuse(self.con, row, None)
        self.assertEqual(got['state'], 'running')
        resume.assert_called_once_with('bxA', lease.RUN_TTL_S, None)
        get.assert_called_once_with('bxA')
        self.setup.assert_called_once_with('bxA')
        self.wait_ssh.assert_called_once_with('bxA')
        self.assertEqual(ssh_sync._endpoint('bxA'), 'new.example:2222')
        self.assertEqual(self.stale_events(), ['rc=255'])
        self.assertEqual(probe.call_args.args[0], ssh_sync.ssh_base('bxA') +
                         ['-o', 'ConnectTimeout=5', 'bxA', 'true'])
        self.assertEqual(probe.call_args.kwargs['timeout'], 10)
        self.assertEqual(self.con.execute(
            "SELECT COUNT(*) FROM events WHERE box_id='bxA' AND kind='lease_resume'").fetchone()[0], 1)

    def test_probe_timeout_discards_gone_or_failed_box(self):
        for bid, state in (('gone', None), ('failed', {'state': 'error'}), ('cancelled', {'state': 'cancelled'})):
            with self.subTest(state=state):
                row = self.running(bid)
                with patch.object(subprocess, 'run', side_effect=subprocess.TimeoutExpired('ssh', 10)), \
                        patch.object(ssh_sync, 'close_master') as close, \
                        patch.object(api, 'get', return_value=state) as get:
                    self.assertIsNone(lease._reuse(self.con, row, None))
                close.assert_called_once_with(bid)
                get.assert_called_once_with(bid)
                updated = self.con.execute('SELECT * FROM leases WHERE box_id=?', (bid,)).fetchone()
                self.assertEqual(updated['state'], 'deleted')
                self.assertIsNotNone(updated['deleted_at'])
                self.assertEqual(self.stale_events(bid), ['timeout'])
        self.setup.assert_not_called()

    def test_failed_master_exit_removes_only_its_socket(self):
        self.running()
        self.running('bxB')
        real_run = subprocess.run

        def control_path(bid):
            config = real_run(ssh_sync.ssh_base(bid) + ['-G', bid], capture_output=True, text=True, check=True)
            return Path(next(line.split(' ', 1)[1] for line in config.stdout.splitlines()
                             if line.startswith('controlpath ')))

        target, other = control_path('bxA'), control_path('bxB')
        with socket.socket(socket.AF_UNIX) as sibling:
            sibling.bind(str(other))
            for failure in (subprocess.TimeoutExpired('ssh', 10), OSError('ssh unavailable'), 255):
                with self.subTest(failure=failure), socket.socket(socket.AF_UNIX) as stale:
                    target.unlink(missing_ok=True)
                    stale.bind(str(target))
                    remaining = [10]

                    def run(cmd, **kwargs):
                        if '-O' in cmd:
                            remaining[0] = 0
                            if isinstance(failure, Exception):
                                raise failure
                            return subprocess.CompletedProcess(cmd, failure)
                        self.assertIn('-G', cmd)
                        return real_run(cmd, **kwargs)

                    with patch.object(subprocess, 'run', side_effect=run), \
                            patch.object(api, 'left', side_effect=lambda: remaining[0]):
                        ssh_sync.close_master('bxA')
                    self.assertFalse(target.exists())
                    self.assertTrue(other.is_socket())

    def test_successful_round_trip_keeps_fast_path(self):
        row = self.running()
        with patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as probe, \
                patch.object(ssh_sync, 'close_master') as close, patch.object(api, 'get') as get:
            self.assertEqual(lease._reuse(self.con, row, None), dict(row))
        probe.assert_called_once_with(ssh_sync.ssh_base('bxA') +
                                      ['-o', 'ConnectTimeout=5', 'bxA', 'true'], capture_output=True, timeout=10)
        get.assert_not_called()
        close.assert_not_called()
        self.setup.assert_not_called()
        self.assertEqual(self.stale_events(), [])
