"""Offline regression cases from #423/#2294/#2581/#3048/#3815."""
from http.client import HTTPResponse
import socket
import threading
import time
import urllib.error
import contextlib
import io
import os
from pathlib import Path
from types import SimpleNamespace
import subprocess
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import allocation, api, cli, common, lease, pool, runs, ssh_sync
from test_capacity import Isolated


class Clock:
    def __init__(self):
        self.t = 1000
        self.on_sleep = lambda: None
        self.module = SimpleNamespace(monotonic=lambda: self.t, time=lambda: self.t, sleep=self.sleep)

    def sleep(self, seconds):
        self.t += seconds
        self.on_sleep()


class AffinityTests(Isolated):
    def setUp(self):
        super().setUp()
        self.clock = Clock()
        for mod in (pool, lease, api):
            self.stack.enter_context(patch.object(mod, 'time', self.clock.module))
        self.stack.enter_context(patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS': '120'}))
        self.stack.enter_context(patch.object(api, 'call', side_effect=AssertionError('network forbidden')))
        self.err = self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))

    def own(self, bid='A', state='running', size='large'):
        self.box(bid, state, size=size, member=True)
        self.con.execute('INSERT OR REPLACE INTO pool_callers VALUES (?,?,?,?)',
                         (self.me['owner'], self.me['repo_root'], bid, 'w/own'))
        self.con.commit()

    def acquire(self, **kw):
        row = pool.acquire(self.me, **kw)
        pool.release_guard(row)
        return row

    def test_stopped_own_box_beats_running_foreign_box(self):
        self.own(state='stopped')
        self.box('B', used=900, member=True)
        with patch.object(lease, '_reuse', side_effect=lambda c, r, s, **kw: dict(r)):
            self.assertEqual(self.acquire()['box_id'], 'A')
        self.assertNotIn('your last box', self.err.getvalue())

    def test_two_consecutive_runs_keep_the_same_box(self):
        self.box('A', member=True)
        with patch.object(lease, '_reuse', side_effect=lambda c, r, s, **kw: dict(r)):
            first = self.acquire()
            second = self.acquire()
        self.assertEqual(first['box_id'], second['box_id'])
        self.assertTrue(first['_new_checkout'])
        self.assertFalse(second['_new_checkout'])

    def test_stopped_own_box_beats_foreign_box_when_size_increases(self):
        self.own(state='stopped')
        self.box('B', size='xlarge', member=True)
        with patch.object(lease, '_reuse', side_effect=lambda c, r, s, **kw: dict(r, size=s)) as reuse:
            self.assertEqual(self.acquire(size='xlarge')['box_id'], 'A')
        self.assertEqual(reuse.call_args.args[2], 'xlarge')

    def test_start_pressure_or_supply_preserves_running_first(self):
        self.own(state='stopped')
        self.box('B', member=True)
        for plentiful, supply in ((False, 'large'), (True, None)):
            with self.subTest(plentiful=plentiful, supply=supply), \
                    patch.object(pool.capacity, 'starts_plentiful', return_value=plentiful), \
                    patch.object(lease, 'supply_size', return_value=supply):
                rows, _ = pool.candidates(self.con, 'repo', 'large', None, self.me)
                self.assertEqual(rows[0]['box_id'], 'B')

    def test_brief_lock_is_waited_for_without_holding_pool_lock(self):
        self.own()
        self.box('B', member=True)
        lock = common.file_lock('box-A', timeout=0)
        lock.__enter__()
        def unlock():
            with common.file_lock(pool.lock_name('repo'), timeout=0):
                lock.__exit__(None, None, None)
        self.clock.on_sleep = unlock
        with patch.object(lease, '_reuse', side_effect=lambda c, r, s, **kw: dict(r)):
            self.assertEqual(self.acquire()['box_id'], 'A')
        self.assertEqual(self.clock.t, 1001)

    def test_brief_active_run_is_waited_for(self):
        self.own()
        self.busy('A')
        self.box('B', member=True)
        def finish():
            self.con.execute("UPDATE runs SET status='done' WHERE box_id='A'")
            self.con.commit()
        self.clock.on_sleep = finish
        with patch.object(lease, '_reuse', side_effect=lambda c, r, s, **kw: dict(r)):
            self.assertEqual(self.acquire()['box_id'], 'A')
        self.assertEqual(self.clock.t, 1001)

    def test_busy_timeout_switches_once_with_a_new_checkout_notice(self):
        self.own()
        self.busy('A')
        self.box('B', member=True)
        with patch.object(lease, '_reuse', side_effect=lambda c, r, s, **kw: dict(r)):
            row = self.acquire()
        self.assertEqual(row['box_id'], 'B')
        self.assertTrue(row['_new_checkout'])
        self.assertEqual(self.clock.t, 1060)
        self.assertEqual(self.err.getvalue().count('your last box A is busy; using B (new checkout there, dependencies not carried over)'), 1)

    def test_affinity_wait_does_not_extend_queue_deadline(self):
        self.own()
        self.busy('A')
        self.box('B', member=True)
        with patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS': '3'}), \
                patch.object(lease, '_reuse', side_effect=lambda c, r, s, **kw: dict(r)):
            self.assertEqual(self.acquire()['box_id'], 'B')
        self.assertEqual(self.clock.t, 1003)

    def growing(self, timeout=False, live_state="running"):
        self.me['repo_root'] = self.tmp.name
        (Path(self.tmp.name) / 'package.json').write_text('{}')
        self.own()
        self.box('B', size='xlarge', member=True)
        self.stack.enter_context(patch.object(ssh_sync, 'cfg_path', return_value=Path(self.tmp.name)/'no-cfg'))
        self.stack.enter_context(patch.object(ssh_sync, 'close_master'))
        self.stack.enter_context(patch.object(ssh_sync, 'setup'))
        self.stack.enter_context(patch.object(ssh_sync, 'wait_ssh'))
        self.stack.enter_context(patch.object(lease, 'ensure_ttl'))
        self.stopped, self.resumed = [], []
        def get(bid, **kw):
            if bid == 'B':
                return {'state': 'running', 'type': 'xlarge'}
            if bid in self.resumed:
                return {'state': live_state, 'type': 'xlarge'}
            if bid in self.stopped:
                return {'state': 'archiving' if timeout else 'archived', 'type': 'large'}
            return {'state': 'running', 'type': 'large'}
        self.stack.enter_context(patch.object(api, 'get', side_effect=get))
        self.stack.enter_context(patch.object(api, 'stop', side_effect=lambda b: self.stopped.append(b)))
        self.stack.enter_context(patch.object(lease, '_resume_confirmed', side_effect=lambda c, b, *a, **kw:
                                             (self.resumed.append(b) or get(b), False)))
        def wait(bid, want, **kw):
            if timeout and bid == 'A' and api.STOPPED_STATES == want:
                self.clock.t += max(0, api.left())
                raise common.OffboxError('grow stop timed out')
            state = get(bid)
            self.assertIn(state['state'], want)
            return state
        self.stack.enter_context(patch.object(api, 'wait_state', side_effect=wait))

    def test_autosized_grow_waits_and_runs_on_own_box(self):
        # #2581 checks.log: pnpm typecheck raised large to xlarge.
        self.growing()
        size, why = lease.auto_size(self.con, 'pnpm typecheck', self.me, None)
        self.assertEqual(size, 'xlarge')
        self.assertIn('typecheck', why)
        self.assertEqual(self.acquire(size=size)['box_id'], 'A')
        self.assertEqual(self.stopped, ['A'])
        self.assertEqual(self.resumed, ['A'])
        self.assertNotIn('skipping', self.err.getvalue())

    def test_own_box_already_stopping_for_a_grow_is_waited_for(self):
        self.growing()
        self.con.execute("UPDATE leases SET state='stopped' WHERE box_id='A'")
        self.con.commit()
        self.stopped.append('A')
        def wait(bid, want, **kw):
            if want == api.STOPPED_STATES + api.LIVE_STATES:
                return {'state': 'archived', 'type': 'large'}
            return {'state': 'running', 'type': 'xlarge'}
        get = api.get.side_effect
        def stopping(bid, **kw):
            if bid == 'A' and not self.resumed:
                return {'state': 'archiving', 'type': 'large'}
            return get(bid, **kw)
        with patch.object(api, 'get', side_effect=stopping), patch.object(api, 'wait_state', side_effect=wait):
            self.assertEqual(self.acquire(size='xlarge')['box_id'], 'A')
        self.assertEqual(self.stopped, ['A'])
        self.assertEqual(self.resumed, ['A'])
        self.assertNotIn('skipping', self.err.getvalue())

    def test_own_grow_timeout_falls_through_with_notice(self):
        self.growing(timeout=True)
        self.assertEqual(self.acquire(size='xlarge')['box_id'], 'B')
        self.assertEqual(self.stopped, ['A'])
        self.assertEqual(self.resumed, [])
        self.assertIn('your last box A is stopped; using B', self.err.getvalue())
        self.assertLessEqual(self.clock.t, 1060)

    def test_own_grow_after_resume_readiness_failure_switches_to_ready_box(self):
        # live state x SSH phase: every failure here follows a confirmed successful grow/resume.
        for live_state in api.LIVE_STATES:
            for phase in ('setup', 'wait_ssh'):
                with self.subTest(live_state=live_state, phase=phase):
                    for table in ('leases', 'pool_members', 'pool_callers', 'runs', 'events', 'kv', 'start_requests'):
                        self.con.execute(f'DELETE FROM {table}')
                    self.clock.t = 1000
                    self.err.seek(0); self.err.truncate()
                    self.growing(live_state=live_state)
                    def fail(bid, *args, **kw):
                        if bid == 'A':
                            self.assertEqual(self.resumed, ['A'])
                            self.clock.t += max(0, api.left())
                            raise common.OffboxError('SSH readiness timed out after resume')
                    with patch.object(ssh_sync, phase, side_effect=fail), \
                            patch.object(lease, 'acquire_private') as create:
                        self.assertEqual(self.acquire(size='xlarge')['box_id'], 'B')
                    create.assert_not_called()
                    self.assertEqual(self.stopped, ['A'])
                    self.assertEqual(self.resumed, ['A'])
                    self.assertEqual(self.clock.t, 1060)
                    old = self.con.execute("SELECT state,size,ssh_ready_at FROM leases WHERE box_id='A'").fetchone()
                    self.assertEqual(tuple(old), ('running', 'xlarge', None))
                    self.assertEqual(self.err.getvalue().count('your last box A is busy; using B'), 1)
                    with common.file_lock('box-A', timeout=0):
                        pass

    def test_unanswered_grow_resume_does_not_switch_to_ready_box(self):
        self.growing()
        def unresolved(c, bid, *args, **kw):
            c.execute("INSERT INTO kv VALUES ('resume_unanswered:A','xlarge',1000)")
            c.commit()
            self.clock.t += max(0, api.left())
            raise lease.ResumeUnresolved('resume send could not be confirmed')
        with patch.object(lease, '_resume_confirmed', side_effect=unresolved), \
                patch.object(lease, 'acquire_private') as create:
            with self.assertRaises(lease.ResumeUnresolved):
                self.acquire(size='xlarge')
        create.assert_not_called()
        self.assertEqual(self.stopped, ['A'])
        self.assertIsNotNone(self.con.execute("SELECT 1 FROM kv WHERE k='resume_unanswered:A'").fetchone())
        self.assertNotIn('your last box', self.err.getvalue())
        self.assertNotIn('B', [call.args[0] for call in api.get.call_args_list])

    def test_readiness_failure_with_unresolved_marker_does_not_switch(self):
        for marker in ('resume_unanswered:A', 'resume_provision:A'):
            with self.subTest(marker=marker):
                for table in ('leases', 'pool_members', 'pool_callers', 'runs', 'events', 'kv', 'start_requests'):
                    self.con.execute(f'DELETE FROM {table}')
                self.clock.t = 1000
                self.err.seek(0); self.err.truncate()
                self.growing()
                def fail(bid, *args, **kw):
                    if bid == 'A':
                        self.con.execute('INSERT INTO kv VALUES (?,?,1000)', (marker, '2000' if marker.startswith('resume_provision:') else 'xlarge'))
                        self.con.commit()
                        raise common.OffboxError('SSH readiness failed')
                with patch.object(ssh_sync, 'wait_ssh', side_effect=fail):
                    with self.assertRaises(lease.ResumeUnresolved):
                        self.acquire(size='xlarge')
                self.assertIsNotNone(self.con.execute('SELECT 1 FROM kv WHERE k=?', (marker,)).fetchone())
                self.assertNotIn('your last box', self.err.getvalue())
                self.assertNotIn('B', [call.args[0] for call in api.get.call_args_list])

    def test_running_own_box_readiness_failure_also_uses_ready_alternative(self):
        self.growing()
        self.con.execute("UPDATE leases SET size='xlarge',ssh_ready_at=999 WHERE box_id='A'")
        self.con.commit()
        def fail(bid, *args, **kw):
            if bid == 'A':
                self.clock.t += max(0, api.left())
                raise common.OffboxError('SSH readiness timed out')
        with patch.object(api, 'get', return_value={'state': 'running', 'type': 'xlarge'}), \
                patch.object(ssh_sync, 'wait_ssh', side_effect=fail):
            self.assertEqual(self.acquire(size='xlarge')['box_id'], 'B')
        self.assertEqual(self.stopped, [])
        self.assertEqual(self.resumed, [])
        self.assertEqual(self.clock.t, 1060)
        self.assertIn('your last box A is busy; using B', self.err.getvalue())
        self.assertIsNone(self.con.execute("SELECT ssh_ready_at FROM leases WHERE box_id='A'").fetchone()[0])

    def test_reconciled_own_resume_readiness_timeout_also_switches(self):
        self.growing()
        self.con.execute("INSERT INTO kv VALUES ('resume_unanswered:A','xlarge',1000)")
        self.con.commit()
        def confirmed(c, bid, *args, **kw):
            allocation.clear_resume(c, bid)
            self.resumed.append(bid)
            return {'state': 'running', 'type': 'xlarge'}, False
        def fail(bid, *args, **kw):
            if bid == 'A':
                self.clock.t += 60
                raise common.OffboxError('SSH readiness timed out after reconciliation')
        with patch.object(lease, '_resume_confirmed', side_effect=confirmed), \
                patch.object(ssh_sync, 'wait_ssh', side_effect=fail):
            self.assertEqual(self.acquire(size='xlarge')['box_id'], 'B')
        self.assertEqual(self.resumed, ['A'])
        self.assertEqual(self.clock.t, 1060)
        self.assertIn('your last box A is busy; using B', self.err.getvalue())

    def test_pending_live_own_box_reconciles_with_zero_or_positive_queue_wait(self):
        confirm = lease._resume_confirmed
        for queue_wait in ('0', '1', '120'):
            for live_state in api.LIVE_STATES:
                with self.subTest(queue_wait=queue_wait, live_state=live_state):
                    for table in ('leases', 'pool_members', 'pool_callers', 'runs', 'events', 'kv', 'start_requests'):
                        self.con.execute(f'DELETE FROM {table}')
                    self.clock.t = 1000
                    self.err.seek(0); self.err.truncate()
                    self.growing(live_state=live_state)
                    self.resumed.append('A')
                    self.con.execute("INSERT INTO kv VALUES ('resume_unanswered:A','xlarge',1000)")
                    self.con.commit()
                    with patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS': queue_wait}), \
                            patch.object(lease, '_resume_confirmed', confirm), patch.object(api, 'resume') as resume:
                        self.assertEqual(self.acquire(size='xlarge')['box_id'], 'A')
                    self.assertGreater(api.get.call_count, 0)
                    resume.assert_not_called()
                    self.assertIsNone(self.con.execute("SELECT 1 FROM kv WHERE k='resume_unanswered:A'").fetchone())
                    self.assertNotIn('your last box', self.err.getvalue())

    def test_pass_stops_at_most_one_box(self):
        self.box('A', size='large', member=True, used=900)
        self.box('B', size='large', member=True)
        self.con.execute("INSERT INTO pool_pending VALUES ('pending','repo',?,? ,NULL)", (os.getpid(),common.now()))
        self.con.commit()
        with patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS':'0'}), \
                patch.object(api, 'get', return_value={'state': 'running', 'type': 'large'}), \
                patch.object(api, 'stop') as stop, patch.object(ssh_sync, 'close_master'):
            with self.assertRaises(pool.PoolBusyError):
                self.acquire(size='xlarge')
        stop.assert_called_once_with('A')

    def test_stale_state_does_not_allow_two_actual_grow_stops(self):
        # Stored state/size -> boat state/size. All four forms can hide an in-place grow.
        for state, size in (('running', 'large'), ('running', 'xlarge'),
                            ('stopped', 'large'), ('stopped', 'xlarge')):
            with self.subTest(state=state, size=size):
                for table in ('leases', 'pool_members', 'pool_callers', 'runs', 'events'):
                    self.con.execute(f'DELETE FROM {table}')
                self.own(state=state, size=size)
                self.box('B', size='large', member=True)
                self.clock.t = 1000
                def wait(*a, **kw):
                    self.clock.t += 1
                    raise common.OffboxError('stop timed out')
                with patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS': '1'}), \
                        patch.object(api, 'get', return_value={'state': 'running', 'type': 'large'}), \
                        patch.object(api, 'stop') as stop, patch.object(ssh_sync, 'close_master'), \
                        patch.object(api, 'wait_state', side_effect=wait):
                    with self.assertRaises(common.OffboxError):
                        self.acquire(size='xlarge')
                stop.assert_called_once_with('A')

    def test_background_refresh_stays_inside_affinity_deadline(self):
        self.own()
        self.busy('A')
        self.box('B', member=True)
        def refresh(c, key, pull_artifacts=True):
            if pull_artifacts:
                return  # ordinary refresh before affinity waiting starts
            self.assertFalse(pull_artifacts)
            self.assertLessEqual(api.left(), 2)
            self.clock.t += api.left()
        with patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS': '3'}), \
                patch.object(pool, '_refresh_background', side_effect=refresh), \
                patch.object(lease, '_reuse', side_effect=lambda c,r,s,**kw: dict(r)):
            self.assertEqual(self.acquire()['box_id'], 'B')
        self.assertEqual(self.clock.t, 1003)

    def test_unanswered_resume_obeys_budget_without_retry_or_losing_marker(self):
        self.own(state='stopped')
        with patch.object(api, 'resume', side_effect=api.NetworkError('read timed out')) as resume, \
                patch.object(api, 'get', return_value={'state': 'archived', 'type': 'large'}), api.budget(3):
            with self.assertRaises(lease.ResumeUnresolved):
                lease._resume_confirmed(self.con, 'A', 1800, 'xlarge')
        resume.assert_called_once()
        self.assertLessEqual(self.clock.t, 1003)
        self.assertIsNotNone(self.con.execute("SELECT 1 FROM kv WHERE k='resume_unanswered:A'").fetchone())

    def test_provisioning_wait_obeys_budget_without_clearing_marker(self):
        self.own(state='stopped')
        self.con.execute("INSERT INTO kv VALUES ('resume_unanswered:A','xlarge',1000)")
        self.con.commit()
        with patch.object(api, 'get', return_value={'state': 'provisioning', 'type': 'xlarge'}), api.budget(3):
            with self.assertRaises(lease.ResumeUnresolved):
                lease._wait_unanswered_resume(self.con, 'A')
        self.assertEqual(self.clock.t, 1003)
        self.assertIsNotNone(self.con.execute("SELECT 1 FROM kv WHERE k='resume_unanswered:A'").fetchone())
        self.assertEqual(self.con.execute("SELECT state FROM leases WHERE box_id='A'").fetchone()[0], 'stopped')

    def test_ssh_ready_wait_respects_the_outer_budget(self):
        def ssh(*a, **kw):
            self.clock.t += kw['timeout']
            raise subprocess.TimeoutExpired(a, kw['timeout'])
        with patch.object(ssh_sync, 'time', self.clock.module), patch.object(ssh_sync, 'ssh', side_effect=ssh), api.budget(3):
            with self.assertRaises(common.OffboxError):
                ssh_sync.wait_ssh('A')
        self.assertEqual(self.clock.t, 1003)

    def test_status_refresh_gives_the_http_reader_an_absolute_deadline(self):
        self.own()
        self.busy('A')
        self.con.execute("UPDATE runs SET mode='bg', process_id=7 WHERE box_id='A'")
        self.con.commit()
        def status(*args, deadline=None, **kw):
            self.clock.t += 91 if deadline is None else max(0, deadline - self.clock.t)
            raise api.NetworkError('response body timed out')
        with patch.object(api, 'cmd_status', side_effect=status), api.budget(3):
            pool._refresh_background(self.con, 'repo', pull_artifacts=False)
        self.assertEqual(self.clock.t, 1003)

    def test_grow_cleanup_timeout_keeps_stopped_state_and_uses_ready_box(self):
        close = ssh_sync.close_master
        self.growing()
        cfg = Path(self.tmp.name) / 'ssh-config'
        cfg.touch()
        def stop(bid):
            self.stopped.append(bid)
            self.clock.t += 59
        def cleanup(*a, **kw):
            self.assertEqual(self.con.execute("SELECT state FROM leases WHERE box_id='A'").fetchone()[0], 'stopped')
            self.assertLessEqual(kw['timeout'], 1)
            self.clock.t += kw['timeout']
            raise subprocess.TimeoutExpired(a, kw['timeout'])
        def wait(bid, want, **kw):
            if bid == 'A':
                raise common.OffboxError('grow budget spent')
            return {'state': 'running', 'type': 'xlarge'}
        with patch.object(api, 'stop', side_effect=stop), patch.object(api, 'wait_state', side_effect=wait), \
                patch.object(ssh_sync, 'close_master', close), \
                patch.object(ssh_sync, 'cfg_path', side_effect=lambda bid: cfg if bid == 'A' else cfg.with_name('no-cfg')), \
                patch.object(ssh_sync.subprocess, 'run', side_effect=cleanup):
            self.assertEqual(self.acquire(size='xlarge')['box_id'], 'B')
        self.assertEqual(self.clock.t, 1060)
        self.assertEqual(self.con.execute("SELECT state FROM leases WHERE box_id='A'").fetchone()[0], 'stopped')

    def test_switch_reason_and_existing_checkout(self):
        for state, label in (('stopped','stopped'), ('archived','archived'), ('deleted','gone')):
            with self.subTest(state=state):
                self.con.execute('DELETE FROM pool_callers')
                self.con.execute('DELETE FROM leases')
                self.con.execute('DELETE FROM pool_members')
                self.own(state=state)
                self.box('B', member=False)
                self.con.execute('DELETE FROM runs')
                self.con.commit()
                self.err.seek(0); self.err.truncate()
                row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='B'").fetchone())
                pool._claim(self.con, self.me, row, None)
                self.assertIn(f'your last box A is {label}; using B', self.err.getvalue())


class HintAndPullTests(Isolated):
    def test_api_budget_bounds_success_and_error_response_bodies(self):
        for status in (200, 503):
            with self.subTest(status=status):
                reader, writer = socket.socketpair()
                self.addCleanup(reader.close)
                self.addCleanup(writer.close)
                writer.sendall(f'HTTP/1.1 {status} Test\r\nContent-Length: 100\r\n\r\nx'.encode())
                response = HTTPResponse(reader)
                response.begin()
                self.addCleanup(response.close)
                error = urllib.error.HTTPError('https://boat.dev', status, 'slow', {}, response)
                rescue = threading.Timer(0.7, writer.close)
                rescue.start()
                started = time.monotonic()
                try:
                    with patch.object(api, '_key', return_value='fake'), \
                            patch.object(api.urllib.request, 'urlopen', return_value=response,
                                         side_effect=error if status >= 400 else None), api.budget(0.1):
                        with self.assertRaises(common.OffboxError):
                            api.get('A')
                    self.assertLess(time.monotonic() - started, 0.5)
                finally:
                    rescue.cancel()
                    rescue.join()

    def test_new_checkout_hint_precedes_any_remote_exit(self):
        root = Path(self.tmp.name)
        (root/'package.json').write_text('{}')
        row = {'box_id': 'B', '_new_checkout': True}
        for lock, install in (('pnpm-lock.yaml','pnpm install --frozen-lockfile'),
                              ('yarn.lock','yarn install'), ('package-lock.json','npm ci')):
            with self.subTest(lock=lock):
                (root/lock).touch()
                err=io.StringIO()
                with contextlib.redirect_stderr(err):
                    runs.new_checkout_hint(row, root)
                self.assertIn(f'node_modules missing on new box B; prefix your command with {install} &&',err.getvalue())
                (root/lock).unlink()
        (root / 'package.json').write_text('{"devDependencies":{"vite-plus":"1.0.0"}}')
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            runs.new_checkout_hint(row, root)
        self.assertIn('with vp i &&', err.getvalue())
        (root / 'package.json').write_text('{}')
        (root / 'vite.config.ts').touch()
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            runs.new_checkout_hint(row, root)
        self.assertIn('with npm install &&', err.getvalue())
        err=io.StringIO()
        with contextlib.redirect_stderr(err):
            runs.new_checkout_hint(dict(row, _new_checkout=False), root)
        self.assertEqual(err.getvalue(), '')

    def test_switched_pnpm_run_hints_before_command_even_when_exit_is_one(self):
        root = Path(self.tmp.name)
        (root/'package.json').write_text('{}')
        (root/'pnpm-lock.yaml').touch()
        me = dict(self.me, repo_root=str(root))
        self.box('A', state='deleted', member=True)
        self.box('B', member=True)
        self.con.execute('INSERT INTO pool_callers VALUES (?,?,?,?)', (me['owner'], str(root), 'A', 'w/old'))
        self.con.commit()
        args = cli.build_parser().parse_args(['run','--remote','--no-fallback','--','pnpm','test'])
        args.cmd = ['pnpm', 'test']
        runner = runs.Runner(args, me)
        err = io.StringIO()
        def start(*a):
            self.assertIn('prefix your command with pnpm install --frozen-lockfile &&', err.getvalue())
            return {'processId': 7}
        with patch.object(lease, '_reuse', side_effect=lambda c,r,s,**kw: dict(r)), \
                patch.object(runs.Runner, '_prepare_box'), patch.object(api, 'cmd_start', side_effect=start), \
                patch.object(runs.node_version, 'want', return_value=None), contextlib.redirect_stderr(err):
            try:
                runner.start()
                runs.finish(runner.run_id, 1)
            finally:
                pool.release_guard(runner.lease_row)
        self.assertIn('your last box A is gone; using B', err.getvalue())
        record = self.con.execute('SELECT exit_code FROM runs WHERE run_id=?', (runner.run_id,)).fetchone()
        self.assertEqual(record[0], 1)

    def test_pull_missing_file_is_one_line_but_other_failures_stay_loud(self):
        missing = ('rsync: [sender] link_stat "/home/user/w/repo/out.txt" failed: No such file or directory (2)\n'
                   'rsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1) [Receiver=3.5.1]\n'
                   'rsync: [Receiver] write error: Broken pipe (32)\n')
        for code, error, quiet in (
                (23, missing, True),
                (23, missing.replace('[sender] ', ''), True),
                (23, missing + 'Permission denied (13)\n', False),
                (23, missing + 'rsync: [Receiver] read error: Connection reset by peer (104)\n', False),
                (23, missing + 'rsync: [Receiver] connection unexpectedly closed (0 bytes)\n', False),
                (12, 'connection unexpectedly closed', False),
                (24, missing, False)):
            with self.subTest(code=code,error=error):
                p=subprocess.CompletedProcess([],code,'',error)
                err=io.StringIO()
                with patch.object(ssh_sync.subprocess,'run',return_value=p), contextlib.redirect_stderr(err):
                    runs.do_pulls('B',{'remote_dir':'/home/user/w/repo','rel_cwd':'.','local_cwd':self.tmp.name},['out.txt'])
                if quiet:
                    self.assertEqual(err.getvalue(),'offbox: pull out.txt: not created on the box\n')
                else:
                    self.assertIn('pull out.txt failed:',err.getvalue())
