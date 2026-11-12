"""Offline preparation keepalive and stopped-box diagnostics."""
import contextlib
import io
import json
import socket
import sys
import threading
import time
from pathlib import Path
from http.client import HTTPResponse
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
        self.real_get = api.get
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

    def test_expiry_cancels_blocked_keeper_response_before_releasing_box(self):
        for blocked_method in ('GET', 'PATCH'):
            with self.subTest(method=blocked_method):
                self.runner = runs.Runner(self.runner.a, self.me)
                entered, rescued = threading.Event(), threading.Event()
                reader, writer = socket.socketpair()
                self.addCleanup(reader.close)
                self.addCleanup(writer.close)
                writer.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nx')
                response = HTTPResponse(reader)
                response.begin()
                self.addCleanup(response.close)
                keepers, methods = [], []

                def open_response(req, **kwargs):
                    methods.append(req.method)
                    keepers.append(threading.current_thread())
                    if req.method == blocked_method:
                        # This request is deliberately sent before the readiness guard starts.
                        self.assertIsNone(api.left())
                        entered.set()
                        return response
                    return io.BytesIO(b'{"sandbox":{"state":"running"}}')

                original = self.runner._prepare_box

                def prepare_box(*args):
                    self.assertTrue(entered.wait(2))
                    self.rows[0]['_prepare_end'] = time.monotonic() + 0.15
                    return original(*args)

                def rescue():
                    rescued.set()
                    writer.close()

                timer = threading.Timer(1.2, rescue)
                self.acquire.side_effect = None
                self.acquire.return_value = self.rows[0]
                self.get.side_effect = self.real_get
                self.ttl.side_effect = self.real_ensure_ttl
                with patch.object(api, 'call', side_effect=api._call), \
                        patch.object(api, '_key', return_value='offline'), \
                        patch.object(api, '_open', side_effect=open_response), \
                        patch.object(self.runner, '_prepare_box', side_effect=prepare_box), \
                        patch.object(self.runner, '_check_box', side_effect=lambda *a: threading.Event().wait(2)), \
                        patch.object(runs.pool, 'release_guard') as release, prepare.attempts():
                    prepare.move_once(OffboxError('previous box failed'))
                    timer.start()
                    started = time.monotonic()
                    try:
                        with self.assertRaises(OffboxError) as raised:
                            self.runner.start()
                        self.assertIn('stuck in bring_up on bxA', str(raised.exception))
                        self.assertLess(time.monotonic() - started, 0.8)
                        self.assertFalse(rescued.is_set(), 'keeper required manual response release')
                        self.assertTrue(all(not t.is_alive() for t in keepers))
                        self.assertEqual(methods, ['GET'] if blocked_method == 'GET' else ['GET', 'PATCH'])
                        release.assert_called_once_with(self.rows[0])
                        self.command.assert_not_called()
                    finally:
                        timer.cancel()
                        writer.close()
                        timer.join()

    def test_bounded_drain_cancels_a_keeper_stuck_before_api_send(self):
        entered, release = threading.Event(), threading.Event()
        keepers = []

        def key():
            keepers.append(threading.current_thread())
            entered.set()
            if not release.wait(3):
                raise AssertionError('key lookup not released')
            return 'offline'

        self.get.side_effect = self.real_get
        self.ttl.side_effect = self.real_ensure_ttl
        with patch.object(api, 'call', side_effect=api._call), \
                patch.object(api, '_key', side_effect=key), \
                patch.object(api, '_open', side_effect=AssertionError('cancelled keeper sent a request')) as opened:
            started = time.monotonic()
            try:
                with self.assertRaises(KeyboardInterrupt):
                    with runs._keep_ttl('bxA'):
                        self.assertTrue(entered.wait(1))
                        raise KeyboardInterrupt
                self.assertLess(time.monotonic() - started, 1.5)
                self.assertTrue(keepers[0].is_alive(), 'test did not hold the lookup beyond the join bound')
            finally:
                release.set()
                for keeper in keepers:
                    keeper.join(1)
            self.assertTrue(all(not t.is_alive() for t in keepers))
            opened.assert_not_called()
            self.assertFalse(self.con.execute("SELECT 1 FROM events WHERE kind='ttl_unconfirmed'").fetchone())

    def delayed_server_patch(self, resolves, expires=False):
        client, server = socket.socketpair()
        self.addCleanup(client.close)
        self.addCleanup(server.close)
        accepted, cancelling, apply_old = (threading.Event() for _ in range(3))
        assignments, failures = [], []
        original_open, original_cancel = api._open, api.RequestScope.cancel

        def backend():
            try:
                with server.makefile('rb') as stream:
                    self.assertTrue(stream.readline().startswith(b'PATCH '))
                    headers = {}
                    while (line := stream.readline()) != b'\r\n':
                        key, value = line.decode().split(':', 1)
                        headers[key.lower()] = value.strip()
                    ttl = json.loads(stream.read(int(headers['content-length'])))['ttlSeconds']
                    accepted.set()
                    self.assertTrue(cancelling.wait(2))
                    self.assertTrue(apply_old.wait(2))
                    assignments.append(('bxA', ttl))
                    try:
                        server.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}')
                    except OSError:
                        pass
            except BaseException as error:
                failures.append(error)

        def cancel(scope, *args, **kwargs):
            if scope.parent is None:
                cancelling.set()
                if resolves:
                    apply_old.set()
            return original_cancel(scope, *args, **kwargs)

        def opened(request, timeout):
            if threading.current_thread() is threading.main_thread():
                assignments.append((request.full_url.rsplit('/', 1)[-1], json.loads(request.data)['ttlSeconds']))
                return io.BytesIO(b'{"sandbox":{}}')
            return original_open(request, timeout)

        def push(box, *args, **kwargs):
            if box == 'bxA':
                self.assertTrue(accepted.wait(2), 'keeper PATCH never fully reached the server')
            return {}

        self.get.side_effect = lambda box: {'state': 'running'} if box == 'bxA' else {
            'state': 'running', 'archiveAfter': '2099-01-01T00:00:00Z'}
        self.ttl.side_effect = self.real_ensure_ttl
        self.push.side_effect = push
        self.rows[0]['_prepare_end'] = time.monotonic() + 0.3
        if expires:
            self.probe.side_effect = lambda *a, **kw: (accepted.wait(2), threading.Event().wait(2))
        worker = threading.Thread(target=backend)
        with patch.object(api, 'API', 'http://boat.invalid'), patch.object(api, '_key', return_value='offline'), \
                patch.object(api, 'call', side_effect=api._call), patch.object(api, '_open', side_effect=opened), \
                patch.object(api.urllib.request, 'getproxies', return_value={}), \
                patch.object(api._HTTPConnection, 'connect', lambda connection: setattr(connection, 'sock', client)), \
                patch.object(api.RequestScope, 'cancel', cancel), prepare.attempts():
            worker.start()
            started = time.monotonic()
            try:
                if expires:
                    prepare.move_once(OffboxError('previous box failed'))
                    with self.assertRaises(OffboxError) as raised:
                        self.runner.start()
                    self.assertIn('stuck in bring_up on bxA', str(raised.exception))
                    self.assertLess(time.monotonic() - started, 0.8)
                    self.command.assert_not_called()
                    self.assertIsNone(self.con.execute('SELECT box_id FROM runs WHERE run_id=?',
                                                      (self.runner.run_id,)).fetchone()[0])
                    with patch.object(lease, 'idle_ttl') as idle:
                        runs.finish(self.runner.run_id, None, 'infra')
                        idle.assert_not_called()
                    self.assertEqual(self.acquire.call_count, 1, 'unconfirmed TTL bypassed move-once limit')
                    row = self.rows[1]
                else:
                    row = self.runner.start()
                if resolves:
                    self.assertEqual(row['box_id'], 'bxA')
                    self.assertEqual(assignments, [('bxA', runs.RUN_TTL_S)])
                else:
                    self.assertLess(time.monotonic() - started, 0.8)
                    self.assertEqual(row['box_id'], 'bxB', 'unconfirmed PATCH was handed to command start')
                    if not expires:
                        self.assertEqual(self.command.call_args.args[0], 'bxB')
                    self.assertNotIn('bxA', [r['box_id'] for r in runs.pool.members(self.con, 'repo')])
                    old = dict(self.con.execute("SELECT * FROM leases WHERE box_id='bxA'").fetchone())
                    self.assertIsNone(lease._reuse(self.con, old, None), 'stale selection reused fenced box')
                    self.assertTrue(self.con.execute("SELECT 1 FROM events WHERE kind='ttl_unconfirmed' "
                                                     "AND box_id='bxA'").fetchone())
                    lease.idle_ttl('bxA')
                    self.assertEqual(assignments, [], 'idle TTL was assigned to the fenced box')
                self.assertTrue(lease.ensure_ttl(row['box_id'], runs.BG_TTL_S, {'state': 'running'}))
                apply_old.set()
                worker.join(1)
                self.assertFalse(worker.is_alive())
                self.assertEqual(failures, [])
                self.assertEqual(dict(assignments)[row['box_id']], runs.BG_TTL_S)
            finally:
                cancelling.set()
                apply_old.set()
                worker.join(2)

    def test_delivered_patch_is_fenced_before_replacement_and_background_handoff(self):
        self.delayed_server_patch(resolves=False)

    def test_delivered_patch_acknowledged_in_grace_precedes_background_handoff(self):
        self.delayed_server_patch(resolves=True)

    def test_expired_prepare_with_delivered_patch_preserves_failure_and_fence(self):
        self.delayed_server_patch(resolves=False, expires=True)

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
