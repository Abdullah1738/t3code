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
from offbox_lib import api, cli, lease, prepare, runs, ssh_sync
from offbox_lib.common import OffboxError
from test_capacity import Isolated
from test_exit_and_queue import FakeClock


class PrepareTtlTests(Isolated):
    interval = 0.01

    def setUp(self):
        super().setUp()
        stack = self.stack
        stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        stack.enter_context(patch.object(api, 'call', side_effect=AssertionError('offline: boat called')))
        self.get = stack.enter_context(patch.object(api, 'get', return_value={'state': 'running'}))
        self.threads = {}
        self.real_ensure_ttl = lease.ensure_ttl
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

    def test_seeded_push_refreshes_ttl_inside_push_phase(self):
        self.con.execute("INSERT INTO runs(run_id,box_id,repo_root,remote_dir,start_at) "
                         "VALUES ('seed','bxA',?,'w/sibling-abcdef',1)", (self.tmp.name,))
        self.con.commit()
        blocked = self.block_until_refresh({})

        def push(*args, **kwargs):
            self.assertEqual(kwargs['seed_candidates'], ['w/sibling-abcdef'])
            self.assertTrue(prepare._ACTIVE.get().phase.startswith('push'))
            return blocked(*args, **kwargs)

        self.push.side_effect = push
        with patch.object(runs.identity, 'repo_key', return_value='repo'):
            self.assertEqual(self.runner.start()['box_id'], 'bxA')
        self.assert_stopped()

    def deadline_drain(self, fail_prepare=False):
        clock = FakeClock()
        entered, release = threading.Event(), threading.Event()
        real_join = threading.Thread.join

        def refresh(box, ttl, state):
            self.refresh(box, ttl, state)
            entered.set()
            self.assertTrue(release.wait(2), 'keeper drain was never released')
            return True

        def check(*args):
            self.assertTrue(entered.wait(2), 'keeper did not start')
            if fail_prepare:
                clock.sleep(2)
            return None

        def join(thread, timeout=None):
            if thread in self.threads.values():
                self.assertIsNone(prepare._ACTIVE.get(), 'keeper drain remained inside a preparation deadline')
                self.assertIsNone(api.left())
                # Advance past both readiness and sync budgets while the in-flight refresh drains.
                clock.sleep(4000)
                release.set()
            return real_join(thread, timeout)

        self.rows[0]['_prepare_end'] = clock.t + 1
        self.ttl.side_effect = refresh
        with patch.object(prepare, 'time', clock.time), patch.object(threading.Thread, 'join', join), \
                patch.object(self.runner, '_check_box', side_effect=check), prepare.attempts():
            if fail_prepare:
                prepare.move_once(OffboxError('previous box failed'))
                with self.assertRaises(OffboxError) as raised:
                    self.runner.start()
                self.assertIn('stuck in bring_up on bxA', str(raised.exception))
                self.command.assert_not_called()
            else:
                self.assertEqual(self.runner.start()['box_id'], 'bxA')
                self.assertFalse(self.threads['bxA'].is_alive())
        self.assert_stopped()

    def test_success_drains_keeper_outside_readiness_and_push_deadlines(self):
        self.deadline_drain()

    def test_expiry_drains_keeper_before_replacement_without_another_deadline(self):
        self.deadline_drain(fail_prepare=True)

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

    def delayed_refresh_handoff(self, phase, fail_prepare=False):
        entered, release, joining, exited = (threading.Event() for _ in range(4))
        keepers, assignments, errors = [], [], []
        prepare_error = OffboxError('prepare failed', code=90)
        handoff_ttl = 1200 if fail_prepare else runs.BG_TTL_S
        real_join = threading.Thread.join

        def delayed_request():
            entered.set()
            if not release.wait(2):
                raise AssertionError('test did not release the delayed API request')
            if phase.endswith('_error'):
                raise OffboxError('delayed boat error')

        def get(box):
            keepers.append(threading.current_thread())
            if phase.startswith('get'):
                delayed_request()
            # Snapshot predates the handoff, so it cannot protect the longer background TTL.
            return {'state': 'running'}

        def set_ttl(box, ttl):
            if threading.current_thread() in keepers and phase.startswith('patch'):
                delayed_request()
            assignments.append(ttl)
            return {}

        def observe_join(thread, timeout=None):
            if thread in keepers:
                joining.set()
            return real_join(thread, timeout)

        def prepare_then_handoff():
            try:
                try:
                    with runs._keep_ttl('bxA'):
                        if not entered.wait(2):
                            raise AssertionError('keeper never reached the API')
                        if fail_prepare:
                            raise prepare_error
                except OffboxError as error:
                    if error is not prepare_error:
                        raise
                exited.set()
                api.set_ttl('bxA', handoff_ttl)
            except BaseException as error:
                errors.append(error)

        self.get.side_effect = get
        self.ttl.side_effect = self.real_ensure_ttl
        with patch.object(api, 'set_ttl', side_effect=set_ttl), \
                patch.object(runs, '_KEEPER_JOIN_S', 0), \
                patch.object(threading.Thread, 'join', observe_join):
            owner = threading.Thread(target=prepare_then_handoff)
            owner.start()
            try:
                self.assertTrue(joining.wait(2), 'preparation never began keeper cleanup')
                # Hold the API beyond the old join bound: no next owner may set a TTL yet.
                escaped = exited.wait(0.05)
            finally:
                release.set()
                owner.join(2)
                for keeper in keepers:
                    keeper.join(2)
            self.assertFalse(owner.is_alive())
            self.assertTrue(all(not keeper.is_alive() for keeper in keepers))
            self.assertEqual(errors, [])
            self.assertFalse(escaped, f'preparation exited during its TTL refresh: {assignments}')
            expected = [handoff_ttl] if phase.endswith('_error') else [runs.RUN_TTL_S, handoff_ttl]
            self.assertEqual(assignments, expected)

    def test_delayed_refresh_cannot_overwrite_background_ttl(self):
        for phase in ('get', 'patch', 'get_error', 'patch_error'):
            with self.subTest(phase=phase):
                self.delayed_refresh_handoff(phase)

    def test_failed_prepare_drains_delayed_refresh_before_idle_ttl(self):
        for phase in ('get', 'patch', 'get_error', 'patch_error'):
            with self.subTest(phase=phase):
                self.delayed_refresh_handoff(phase, fail_prepare=True)
