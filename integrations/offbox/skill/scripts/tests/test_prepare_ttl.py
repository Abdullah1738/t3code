"""Offline preparation keepalive and stopped-box diagnostics."""
import contextlib
import io
import sys
import threading
import time
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, cli, lease, runs, ssh_sync
from offbox_lib.common import OffboxError
from test_capacity import Isolated


class PrepareTtlTests(Isolated):
    interval = 0.01

    def setUp(self):
        super().setUp()
        stack = self.stack
        stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        stack.enter_context(patch.object(api, 'call', side_effect=AssertionError('offline: boat called')))
        self.get = stack.enter_context(patch.object(api, 'get', return_value={'state': 'running'}))
        self.threads = {}
        self.ttl = stack.enter_context(patch.object(lease, 'ensure_ttl', side_effect=self.refresh))
        stack.enter_context(patch.object(runs, 'TTL_REFRESH_S', self.interval))
        stack.enter_context(patch.object(runs, 'TTL_RETRY_S', self.interval))
        self.rows = []
        for box in ('bxA', 'bxB'):
            self.box(box, member=True)
            row = dict(self.con.execute('SELECT * FROM leases WHERE box_id=?', (box,)).fetchone())
            self.rows.append(dict(row, remote_dir='w/r'))
        self.acquire = stack.enter_context(patch.object(runs.pool, 'acquire', side_effect=self.rows))
        self.probe = stack.enter_context(patch.object(ssh_sync, 'probe_home', return_value=(None, None)))
        self.prune = stack.enter_context(patch.object(runs.prune, 'run', return_value=runs.prune.Result()))
        self.put = stack.enter_context(patch.object(ssh_sync, 'put_file'))
        self.push = stack.enter_context(patch.object(ssh_sync, 'push', return_value={}))
        stack.enter_context(patch.object(ssh_sync, 'tracked_secret_matches', return_value=[]))
        stack.enter_context(patch.object(runs, 'new_checkout_hint'))
        stack.enter_context(patch.object(runs.node_version, 'want', return_value=None))
        self.command = stack.enter_context(patch.object(api, 'cmd_start', return_value={'processId': 7}))
        args = cli.build_parser().parse_args(['run', '--', 'true'])
        self.runner = runs.Runner(args, self.me)
        self.runner.box, self.runner.lease_row = 'bxA', self.rows[0]

    def refresh(self, box, ttl, state):
        self.threads[box] = threading.current_thread()
        return True

    def assert_stopped(self):
        self.assertTrue(self.threads)
        self.assertTrue(all(not thread.is_alive() for thread in self.threads.values()))
        count = self.ttl.call_count
        # Observe beyond the refresh interval to catch a keeper left behind on either exit path.
        time.sleep(2 * self.interval)
        self.assertEqual(self.ttl.call_count, count)

    def block_until_refresh(self, operation):
        preparing, refreshed = threading.Event(), threading.Event()

        def refresh(box, ttl, state):
            self.refresh(box, ttl, state)
            if not preparing.wait(2):
                return False
            refreshed.set()
            return True

        self.ttl.side_effect = refresh

        def blocked(*args, **kwargs):
            preparing.set()
            self.assertTrue(refreshed.wait(2), 'no TTL refresh during preparation')
            self.ttl.assert_called_with('bxA', runs.RUN_TTL_S, {'state': 'running'})
            return operation

        return blocked

    def test_push_refreshes_ttl_and_keeper_stops_before_remote_start(self):
        self.push.side_effect = self.block_until_refresh({})

        def start(*args):
            self.assert_stopped()
            return {'processId': 7}

        self.command.side_effect = start
        self.assertEqual(self.runner.start()['box_id'], 'bxA')
        self.assert_stopped()

    def test_probe_prune_and_no_sync_env_upload_are_kept_alive(self):
        for stage, result in ((self.probe, (None, None)), (self.prune, runs.prune.Result()), (self.put, None)):
            with self.subTest(stage=stage):
                self.acquire.side_effect = None
                self.acquire.return_value = self.rows[0]
                args = cli.build_parser().parse_args(['run', '--no-sync', '--', 'true'])
                self.runner = runs.Runner(args, self.me)
                stage.side_effect = self.block_until_refresh(result)
                self.runner.start()
                self.assert_stopped()
                stage.side_effect = None
        self.push.assert_not_called()

    def test_failing_push_stops_keeper(self):
        blocked = self.block_until_refresh(None)
        original = OffboxError('rsync to bxA failed (23)', code=90)

        def fail(*args, **kwargs):
            blocked(*args, **kwargs)
            raise original

        self.push.side_effect = fail
        with self.assertRaises(OffboxError) as raised:
            self.runner.start()
        self.assertIs(raised.exception, original)
        self.assert_stopped()
        self.command.assert_not_called()
        self.assertFalse(self.runner.started)

    def test_stopped_box_error_forms_and_transfer_sources(self):
        messages = (
            'rsync to bxA failed (255): rsync: [sender] write error: Broken pipe (32)',
            'Git history sync to bxA failed (255): Broken pipe (32)',
            'ssh bxA failed: code 255',
            'rsync to bxA failed (255)',
            'write error: Broken pipe (32)',
        )
        for transfer in (self.push, self.put):
            for message in messages:
                with self.subTest(transfer=transfer, message=message), patch.object(runs, '_ttl_keeper'):
                    original = OffboxError(message, code=90)
                    transfer.side_effect = original
                    self.get.return_value = {'state': 'archived'}
                    self.get.reset_mock()
                    with self.assertRaises(OffboxError) as raised:
                        self.runner._prepare_box(self.con, self.runner.a, 'w/r', '/env', b'')
                    self.assertEqual(raised.exception.code, 90)
                    self.assertIn('box bxA was stopped by boat during the sync (archived); nothing ran',
                                  str(raised.exception))
                    self.assertIs(raised.exception.__cause__, original)
                    self.get.assert_called_once_with('bxA')
                    transfer.side_effect = None

    def test_live_or_unknown_state_preserves_original_error(self):
        self.runner.box, self.runner.lease_row = 'bxA', self.rows[0]
        for state in ({'state': 'running'}, {'state': 'ready'}, {'state': 'idle'}, {}, None,
                      OffboxError('boat unavailable')):
            with self.subTest(state=state):
                original = OffboxError('Git history sync to bxA failed (255): Broken pipe (32)', code=90)
                self.push.side_effect = original
                self.get.reset_mock()
                self.get.side_effect = state if isinstance(state, Exception) else None
                self.get.return_value = state
                with self.assertRaises(OffboxError) as raised:
                    self.runner._prepare_box(self.con, self.runner.a, 'w/r', '/env', b'')
                self.assertIs(raised.exception, original)
                self.get.assert_called_once_with('bxA')

    def test_other_error_and_success_do_not_check_boat_state(self):
        self.runner.box, self.runner.lease_row = 'bxA', self.rows[0]
        for original in (OffboxError('rsync to bxA failed (23)', code=90), ValueError('bad input')):
            with self.subTest(error=original):
                self.push.side_effect = original
                with self.assertRaises(type(original)) as raised:
                    self.runner._prepare_box(self.con, self.runner.a, 'w/r', '/env', b'')
                self.assertIs(raised.exception, original)
        self.push.side_effect = None
        self.runner._prepare_box(self.con, self.runner.a, 'w/r', '/env', b'')
        self.get.assert_not_called()

    def test_dead_mount_stops_old_keeper_before_move_and_starts_new_one(self):
        refreshed = {box: threading.Event() for box in ('bxA', 'bxB')}

        def refresh(box, ttl, state):
            self.refresh(box, ttl, state)
            refreshed[box].set()
            return True

        self.ttl.side_effect = refresh

        def push(box, *args, **kwargs):
            self.assertTrue(refreshed[box].wait(2))
            if box == 'bxA':
                raise OffboxError('rsync failed (23): Transport endpoint is not connected')
            self.assertFalse(self.threads['bxA'].is_alive())
            return {}

        def set_aside(*args):
            self.assertFalse(self.threads['bxA'].is_alive())

        self.push.side_effect = push
        with patch.object(lease, 'set_aside_dead_mount', side_effect=set_aside):
            self.assertEqual(self.runner.start()['box_id'], 'bxB')
        self.assertEqual(set(self.threads), {'bxA', 'bxB'})
        self.assertIsNot(self.threads['bxA'], self.threads['bxB'])
        self.assert_stopped()

    def test_cold_box_replacement_stops_keeper_before_releasing_old_guard(self):
        refreshed = {box: threading.Event() for box in ('bxA', 'bxB')}

        def refresh(box, ttl, state):
            self.refresh(box, ttl, state)
            refreshed[box].set()
            return True

        def prepare(*args):
            box = self.runner.box
            self.assertTrue(refreshed[box].wait(2))
            return self.rows[1] if box == 'bxA' else None

        def release(row):
            self.assertFalse(self.threads[row['box_id']].is_alive())

        self.ttl.side_effect = refresh
        with patch.object(self.runner, '_prepare_box', side_effect=prepare), \
                patch.object(runs.pool, 'release_guard', side_effect=release):
            self.assertEqual(self.runner.start()['box_id'], 'bxB')
        self.acquire.assert_called_once()
        self.assertEqual(set(self.threads), {'bxA', 'bxB'})
        self.assert_stopped()

    def test_boat_state_helper_is_standalone(self):
        self.assertEqual(runs._boat_state('bxA'), 'running')
        self.get.assert_called_once_with('bxA')
