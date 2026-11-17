"""Offline tests for `offbox kill <run>`, the release refusal message, and the reaper's no-box run cleanup."""
import contextlib
import io
import itertools
import json
import os
import signal
import subprocess
import threading
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import ANY, call, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests._env import clean_env
from offbox_lib import api, cli, common, home, identity, lease, misc, pool, reap, runs, ssh_sync, start_check  # noqa: E402
from offbox_lib.common import now  # noqa: E402

from test_capacity import Isolated  # noqa: E402


class KillRunTests(Isolated):
    def setUp(self):
        super().setUp()
        # The fake boxes have no start claim: the SSH check fences any late start by default.
        self.real_start_check = start_check.check
        self.start_check = self.stack.enter_context(patch.object(start_check, 'check',
                                                                return_value=start_check.Result('fenced')))
        self.elapsed = 0.0
        self.stack.enter_context(patch.object(misc, 'monotonic', side_effect=lambda: self.elapsed, create=True))
        self.sleep = self.stack.enter_context(patch.object(misc, 'sleep', side_effect=self.advance, create=True))

    def advance(self, seconds):
        self.elapsed += seconds

    def run_row(self, rid='run-1', box='bx_1', pid=42, status='running', mode='fg', start=None, error=None,
                client=None, owner=None, remote_dir=None, claim=True):
        self.con.execute("""INSERT INTO runs(run_id,box_id,process_id,status,mode,start_at,error,client_pid,owner,remote_dir)
                            VALUES (?,?,?,?,?,?,?,?,?,?)""",
                         (rid, box, pid, status, mode, start if start is not None else now() - 60, error, client, owner, remote_dir))
        if claim:
            self.con.execute("INSERT OR REPLACE INTO kv(k,v) VALUES (?, '1')", (f'start_claim:{rid}',))
        self.con.commit()

    def status_of(self, rid):
        return self.con.execute("SELECT status, exit_code FROM runs WHERE run_id=?", (rid,)).fetchone()

    def patched_kill(self, kill_side_effect=None, status_values=(None,)):
        """Patch the boat calls kill_run uses; returns (kill_mock, status_mock) for assertions."""
        kill = patch.object(api, 'cmd_kill', side_effect=kill_side_effect, return_value={})
        st = patch.object(api, 'cmd_status', side_effect=itertools.chain(status_values, itertools.repeat(status_values[-1])))
        self.stack.enter_context(patch.object(lease, 'touch'))
        self.stack.enter_context(patch.object(lease, 'idle_ttl'))
        km = self.stack.enter_context(kill)
        sm = self.stack.enter_context(st)
        return km, sm

    def test_kill_confirms_then_marks_killed(self):
        self.run_row()
        km, sm = self.patched_kill(status_values=({'running': False, 'status': 'exited', 'exitCode': 143},))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = misc.kill_run('run-1')
        self.assertEqual(rc, 0)
        km.assert_called_once_with('bx_1', 42)
        self.assertEqual(tuple(self.status_of('run-1')), ('killed', 143))
        self.assertIn('bx_1', out.getvalue())
        self.assertIn('offbox release', out.getvalue())
        sm.assert_called_once()
        self.sleep.assert_not_called()

    def test_home_kill_waits_for_delayed_stop_and_clears_quarantine(self):
        self.run_row()
        self.con.execute("UPDATE runs SET command_id='cmd-42'")
        self.con.execute("INSERT INTO kv(k,v) VALUES ('start_unknown:run-1','bx_1')")
        self.con.commit()
        km, sm = self.patched_kill()
        def status(*args, **kwargs):
            return {'running': self.elapsed < 15, 'commandId': 'cmd-42'}
        sm.side_effect = status
        err = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
            self.assertEqual(misc.kill_run('run-1'), 0)
        self.assertGreaterEqual(self.elapsed, 15)
        self.assertLessEqual(self.elapsed, 17)
        km.assert_called_once_with('bx_1', 42)
        self.assertEqual(tuple(self.status_of('run-1')), ('killed', 143))
        self.assertIsNone(self.con.execute("SELECT 1 FROM kv WHERE k='start_unknown:run-1'").fetchone())
        self.assertEqual(err.getvalue().count('waiting up to 40 s'), 1)

    def test_kill_preserves_confirmed_command_result(self):
        for code in (0,1,200):
            with self.subTest(code=code):
                rid=f'run-completed-{code}'
                self.run_row(rid)
                with patch.object(api,'cmd_kill',return_value={}), \
                     patch.object(api,'cmd_status',return_value=dict(status='exited',running=False,exitCode=code)), \
                     patch.object(lease,'idle_ttl'), \
                     contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(misc.kill_run(rid),0)
                self.assertEqual(tuple(self.status_of(rid)),('done' if code==0 else 'failed',code))

    def test_kill_404_on_third_poll_confirms_stop(self):
        self.run_row()
        km, sm = self.patched_kill(status_values=({'running': True}, {'running': True}, None))
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(misc.kill_run('run-1'), 0)
        self.assertEqual(sm.call_count, 3)
        self.assertEqual(self.elapsed, 2)
        km.assert_called_once_with('bx_1', 42)
        self.assertEqual(tuple(self.status_of('run-1')), ('killed', 143))

    def test_lost_mid_poll_keeps_existing_confirmation_rules(self):
        for i, confirmation in enumerate(({'running': False, 'status': 'lost'}, None,
                                          api.OffboxError('confirmation failed'))):
            with self.subTest(confirmation=confirmation):
                rid = f'run-lost-{i}'
                self.run_row(rid)
                km, sm = self.patched_kill(status_values=({'running': True}, {'status': 'lost', 'running': False}))
                with patch.object(runs, 'confirmed_lost', side_effect=(
                        confirmation if isinstance(confirmation, Exception) else None),
                        return_value=confirmation) as confirm, contextlib.redirect_stdout(io.StringIO()), \
                        contextlib.redirect_stderr(io.StringIO()):
                    expected = 0 if isinstance(confirmation, dict) else 1
                    self.assertEqual(misc.kill_run(rid), expected)
                self.assertEqual(sm.call_count, 2)
                self.assertEqual(confirm.call_args.args, ('bx_1', rid))
                self.assertLessEqual(confirm.call_args.kwargs['timeout'], 39)
                km.assert_called_once_with('bx_1', 42)
                self.assertEqual(self.status_of(rid)['status'], 'running' if expected else 'killed')

    def test_status_errors_are_retried_until_stop(self):
        self.run_row()
        km, sm = self.patched_kill(status_values=(api.OffboxError('GET one'), api.OffboxError('GET two'),
                                                  {'running': False}))
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(misc.kill_run('run-1'), 0)
        self.assertEqual(sm.call_count, 3)
        self.assertEqual(self.elapsed, 2)
        km.assert_called_once_with('bx_1', 42)
        self.assertEqual(tuple(self.status_of('run-1')), ('killed', 143))

    def test_kill_rerun_settles_after_previous_confirmation_timed_out(self):
        self.run_row()
        km, sm = self.patched_kill(status_values=({'running': True},))
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(misc.kill_run('run-1'), 1)
            self.assertEqual(self.status_of('run-1')['status'], 'running')
            elapsed = self.elapsed
            self.sleep.reset_mock()
            sm.side_effect = None
            sm.return_value = {'running': False}
            sm.reset_mock()
            self.assertEqual(misc.kill_run('run-1'), 0)
        self.assertEqual(self.elapsed, elapsed)
        self.sleep.assert_not_called()
        sm.assert_called_once()
        self.assertEqual(km.call_args_list, [call('bx_1', 42), call('bx_1', 42)])
        self.assertEqual(tuple(self.status_of('run-1')), ('killed', 143))

    def test_cli_still_running_returns_failure_after_bound(self):
        self.run_row(owner=self.me['owner'])
        km, sm = self.patched_kill(status_values=({'running': True},))
        err = io.StringIO()
        with patch.object(identity, 'whoami', return_value=dict(self.me, proven=True)), \
                patch.object(home, 'person_gate'), patch.object(cli, 'log'), contextlib.redirect_stderr(err):
            self.assertEqual(cli.main(['kill', 'run-1']), 1)
        self.assertEqual(self.elapsed, 40)
        self.assertEqual(self.status_of('run-1')['status'], 'running')
        self.assertIn('still reports it running after 40 s', err.getvalue())
        self.assertIn('offbox kill run-1` (safe to repeat)', err.getvalue())
        self.assertIn('offbox logs run-1', err.getvalue())
        km.assert_called_once_with('bx_1', 42)
        self.assertGreater(sm.call_count, 1)
        for poll in sm.call_args_list:
            self.assertEqual(poll.kwargs['retries'], 0)
            self.assertLessEqual(poll.kwargs['timeout'], 5)

    def test_slow_get_errors_cannot_extend_confirmation_bound(self):
        self.run_row()
        _, sm = self.patched_kill()
        def timeout(*args, **kwargs):
            self.advance(kwargs['timeout'])
            raise api.OffboxError('GET timed out')
        sm.side_effect = timeout
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(misc.kill_run('run-1'), 1)
        self.assertEqual(self.elapsed, 40)
        self.assertEqual(self.status_of('run-1')['status'], 'running')
        self.assertIn('could not read process', err.getvalue())
        self.assertIn('GET timed out', err.getvalue())

    def test_kill_status_none_counts_as_confirmed(self):
        self.run_row()
        self.patched_kill(status_values=(None,))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(misc.kill_run('run-1'), 0)
        self.assertEqual(self.status_of('run-1')['status'], 'killed')

    def test_unconfirmed_kill_leaves_row_running(self):
        self.run_row()
        self.patched_kill(status_values=({'running': True, 'status': 'running'},))
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            rc = misc.kill_run('run-1')
        self.assertEqual(rc, 1)
        self.assertEqual(self.status_of('run-1')['status'], 'running')
        self.assertIn('still reports', err.getvalue())

    def test_status_error_leaves_row_running(self):
        self.run_row()
        km, sm = self.patched_kill(status_values=(api.OffboxError('status boom'),))
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(misc.kill_run('run-1'), 1)
        self.assertEqual(self.elapsed, 40)
        self.assertGreater(sm.call_count, 1)
        km.assert_called_once_with('bx_1', 42)
        self.assertIn('could not read process', err.getvalue())
        self.assertIn('status boom', err.getvalue())
        self.assertEqual(self.status_of('run-1')['status'], 'running')

    def test_empty_or_unknown_status_never_marks_killed(self):
        # An empty successful response ({}) or one without a running field is not proof the process stopped.
        for i, bogus in enumerate(({}, {'status': 'running'}, {'exitCode': 143},
                                   {'running': 0}, {'running': None}, {'running': 'false'})):
            with self.subTest(status=bogus):
                rid = f'run-bogus-{i}'
                self.run_row(rid)
                self.patched_kill(status_values=(bogus,))
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    self.assertEqual(misc.kill_run(rid), 1)
                self.assertEqual(self.status_of(rid)['status'], 'running')
                self.assertIn('row left as running', err.getvalue())
                self.assertEqual(self.elapsed, 40 * (i + 1))

    def test_delete_error_then_404_confirms_stop(self):
        # DELETE timed out but the process is gone: the follow-up GET returning 404 is the accepted confirmation.
        self.run_row()
        self.patched_kill(kill_side_effect=api.OffboxError('DELETE timed out'), status_values=(None,))
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(misc.kill_run('run-1'), 0)
        self.assertEqual(tuple(self.status_of('run-1')), ('killed', 143))
        self.assertIn('kill request failed', out.getvalue())

    def test_delete_error_with_still_running_leaves_row_running(self):
        self.run_row()
        self.patched_kill(kill_side_effect=api.OffboxError('DELETE timed out'),
                          status_values=({'running': True, 'status': 'running'},))
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(misc.kill_run('run-1'), 1)
        self.assertEqual(self.status_of('run-1')['status'], 'running')

    def test_local_and_no_process_rows_refused(self):
        self.run_row('run-local', box=None, pid=None, mode='local')
        self.run_row('run-nopid', box='bx_1', pid=None, mode='fg')
        self.run_row('run-nobox', box=None, pid=None, mode='bg')
        km, _ = self.patched_kill()
        for rid in ('run-local', 'run-nopid', 'run-nobox'):
            with self.assertRaises(api.OffboxError):
                misc.kill_run(rid)
        km.assert_not_called()
        self.assertEqual(self.status_of('run-nopid')['status'], 'running')

    def client(self, rid, action='killed'):
        # The ready pipe proves the handler is installed before kill_run can signal this child.
        script = """
import signal, sqlite3, sys, time

def on_term(sig, frame):
    if sys.argv[3] == 'ignore':
        return
    con = sqlite3.connect(sys.argv[1], timeout=5)
    if sys.argv[3] == 'killed':
        con.execute("UPDATE runs SET status='killed', exit_code=130, end_at=? WHERE run_id=?",
                    (time.time(), sys.argv[2]))
    elif sys.argv[3] == 'started':
        con.execute("UPDATE runs SET box_id='bx_test', process_id=99, command_id='cmd-99', status='running' "
                    "WHERE run_id=?", (sys.argv[2],))
    con.commit()
    con.close()
    sys.exit(130)

signal.signal(signal.SIGTERM, on_term)
print('ready', flush=True)
while True:
    signal.pause()
"""
        child = subprocess.Popen([sys.executable, '-I', '-c', script, str(common.DB_PATH), rid, action],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        waiter = threading.Thread(target=child.wait)
        waiter.start()
        def cleanup():
            if child.poll() is None:
                child.kill()
            waiter.join(timeout=5)
            child.stdout.close()
            child.stderr.close()
        self.addCleanup(cleanup)
        self.assertEqual(child.stdout.readline().strip(), 'ready')
        self.con.execute("UPDATE runs SET client_pid=?, start_at=? WHERE run_id=?", (child.pid, now(), rid))
        self.con.commit()
        return child

    def no_remote_actions(self):
        stack = contextlib.ExitStack()
        for module, name in ((api, '_call'), (api, '_request'), (api, 'cmd_kill'), (api, 'cmd_status'),
                             (lease, 'touch'), (lease, 'idle_ttl'), (pool, 'release_guard')):
            stack.enter_context(patch.object(module, name, side_effect=AssertionError(name)))
        return stack

    def test_prestart_live_client_settles_queued_and_boxed_runs(self):
        for i, (box, mode, status) in enumerate(((None, 'fg', 'starting'), (None, 'bg', 'running'),
                                                ('bx_test', 'fg', 'starting'), ('bx_test', 'bg', 'running'))):
            with self.subTest(box=box, mode=mode, status=status):
                rid = f'run-live-{i}'
                self.run_row(rid, box=box, pid=None, mode=mode, status=status, owner=self.me['owner'])
                if box:
                    self.box(box, member=True)
                child = self.client(rid)
                tables = {t: [tuple(r) for r in self.con.execute(f'SELECT * FROM {t}')]
                          for t in ('leases', 'pool_members', 'kv')}
                output = io.StringIO()
                with self.no_remote_actions(), patch.object(os, 'kill', wraps=os.kill) as kill, \
                        patch.object(os, 'killpg') as killpg, contextlib.redirect_stdout(output):
                    self.assertEqual(misc.kill_run(rid, self.me), 0)
                self.assertEqual(child.wait(timeout=5), 130)
                self.assertEqual(tuple(self.status_of(rid)), ('killed', 130))
                self.assertEqual([c for c in kill.call_args_list if c.args[1] != 0],
                                 [call(child.pid, signal.SIGTERM)])
                killpg.assert_not_called()
                self.start_check.assert_not_called()
                self.assertIsNotNone(misc._run_row(rid)['end_at'])
                self.assertIn('before its command started', output.getvalue())
                self.assertIn('box bx_test returned to the pool' if box else 'queued, no box used', output.getvalue())
                for table, rows in tables.items():
                    self.assertEqual([tuple(r) for r in self.con.execute(f'SELECT * FROM {table}')], rows)
                if box:
                    self.con.execute('DELETE FROM leases WHERE box_id=?', (box,))
                    self.con.execute('DELETE FROM pool_members WHERE box_id=?', (box,))
                    self.con.commit()

    def test_prestart_dead_or_reused_client_settles_lost_without_signal(self):
        for box in (None, 'bx_test'):
            for reused in (False, True):
                with self.subTest(box=box, reused=reused):
                    rid = f'run-gone-{box}-{reused}'
                    self.run_row(rid, box=box, pid=None, client=12345, start=now() - 60, owner=self.me['owner'])
                    with self.no_remote_actions(), patch.object(os, 'kill',
                            side_effect=None if reused else ProcessLookupError) as kill, \
                            patch.object(misc, '_pid_started_at', return_value=now()), \
                            contextlib.redirect_stdout(io.StringIO()) as output:
                        self.assertEqual(misc.kill_run(rid, self.me), 0)
                    self.assertEqual(kill.call_args_list, [call(12345, 0)])
                    row = misc._run_row(rid)
                    self.assertEqual(row['status'], 'lost')
                    self.assertIsNotNone(row['end_at'])
                    self.assertEqual(row['error'], 'client ended before its command started' if box else
                                     'client ended before it got a box')
                    self.assertIn('nothing was stopped', output.getvalue())
                    if box:
                        self.assertIn('returns to the pool via the reaper', output.getvalue())

    def test_prestart_missing_pid_or_unproven_start_time_refused(self):
        for box in (None, 'bx_test'):
            for client, start in ((None, now()), (12345, now()), (12345, None)):
                with self.subTest(box=box, client=client, start=start):
                    rid = f'run-unproven-{box}-{client}-{start}'
                    self.run_row(rid, box=box, pid=None, client=client, owner=self.me['owner'])
                    self.con.execute('UPDATE runs SET start_at=? WHERE run_id=?', (start, rid))
                    self.con.commit()
                    before = tuple(misc._run_row(rid))
                    with self.no_remote_actions(), patch.object(os, 'kill') as kill, \
                            patch.object(misc, '_pid_started_at', return_value=None):
                        with self.assertRaisesRegex(api.OffboxError,
                                                    'no client pid is recorded' if not client else 'cannot prove') as exc:
                            misc.kill_run(rid, self.me)
                    self.assertEqual(exc.exception.code, 2)
                    self.assertFalse(any(c.args[1] != 0 for c in kill.call_args_list))
                    self.assertEqual(tuple(misc._run_row(rid)), before)

    def test_prestart_owner_and_proven_guards_run_before_any_signal(self):
        for box in (None, 'bx_test'):
            for owner, proven in (('someone-else', False), ('someone-else', True), (self.me['owner'], False)):
                with self.subTest(box=box, proven=proven, owner=owner):
                    rid = f'run-owner-{box}-{owner}-{proven}'
                    self.run_row(rid, box=box, pid=None, client=12345, owner=owner, status='starting')
                    with self.no_remote_actions(), patch.object(misc, '_client_alive') as alive, \
                            patch.object(os, 'kill') as kill:
                        with self.assertRaisesRegex(api.OffboxError, 'another caller' if proven else 'proven') as exc:
                            misc.kill_run(rid, dict(self.me, proven=proven))
                    self.assertEqual(exc.exception.code, 2)
                    alive.assert_not_called()
                    kill.assert_not_called()
                    self.assertEqual(self.status_of(rid)['status'], 'starting')

    def test_prestart_ignores_sigterm_times_out_without_escalation(self):
        for box in (None, 'bx_test'):
            with self.subTest(box=box):
                rid = f'run-ignore-{box}'
                self.run_row(rid, box=box, pid=None, owner=self.me['owner'])
                child = self.client(rid, 'ignore')
                before = tuple(misc._run_row(rid))
                began = time.monotonic()
                with self.no_remote_actions(), patch.object(misc, 'CANCEL_WAIT_S', 0.15), \
                        patch.object(os, 'kill', wraps=os.kill) as kill, patch.object(os, 'killpg') as killpg, \
                        contextlib.redirect_stderr(io.StringIO()) as err:
                    self.assertEqual(misc.kill_run(rid, self.me), 1)
                self.assertLess(time.monotonic() - began, 3)
                self.assertIsNone(child.poll())
                self.assertEqual(tuple(misc._run_row(rid)), before)
                self.assertIn(f'sent SIGTERM to client {child.pid}; it has not settled the row yet', err.getvalue())
                self.assertEqual([c for c in kill.call_args_list if c.args[1] != 0],
                                 [call(child.pid, signal.SIGTERM)])
                killpg.assert_not_called()

    def test_prestart_client_exits_without_settling_row(self):
        for box in (None, 'bx_test'):
            with self.subTest(box=box):
                rid = f'run-exit-{box}'
                self.run_row(rid, box=box, pid=None, owner=self.me['owner'])
                child = self.client(rid, 'exit')
                with self.no_remote_actions(), patch.object(misc, 'CANCEL_WAIT_S', 0.15), \
                        contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(misc.kill_run(rid, self.me), 0)
                self.assertEqual(child.wait(timeout=5), 130)
                self.assertEqual(self.status_of(rid)['status'], 'lost')

    def test_prestart_command_starts_mid_wait_uses_fresh_remote_id(self):
        for box in (None, 'bx_test'):
            with self.subTest(box=box):
                rid = f'run-start-race-{box}'
                self.run_row(rid, box=box, pid=None, owner=self.me['owner'])
                child = self.client(rid, 'started')
                km, sm = self.patched_kill(status_values=({'running': True, 'commandId': 'cmd-99'},
                                                         {'running': False}))
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(misc.kill_run(rid, self.me), 0)
                self.assertEqual(child.wait(timeout=5), 130)
                km.assert_called_once_with('bx_test', 99)
                self.assertEqual(sm.call_args_list, [call('bx_test', 99),
                                                       call('bx_test', 99, timeout=5, retries=0, deadline=ANY)])
                self.assertEqual(tuple(self.status_of(rid)), ('killed', 143))

    def test_prestart_command_race_uses_delayed_remote_confirmation_and_retry(self):
        self.box('bx_test', member=True)
        for box in (None, 'bx_test'):
            for outcome in ('delayed', 'timeout'):
                with self.subTest(box=box, outcome=outcome):
                    rid = f'run-confirm-race-{box}-{outcome}'
                    self.run_row(rid, box=box, pid=None, owner=self.me['owner'])
                    child = self.client(rid, 'started')
                    proof = {'running': True, 'commandId': 'cmd-99'}
                    states = (proof, {'running': True}, {'running': True}, {'running': False}) if outcome == 'delayed' else (
                        proof, {'running': True})
                    km, sm = self.patched_kill(status_values=states)
                    responses = sm.side_effect
                    def still_reserved(*args, **kwargs):
                        self.assertEqual(self.status_of(rid)['status'], 'running')
                        self.assertEqual(lease.active_runs(self.con, 'bx_test'), 1)
                        return next(responses)
                    sm.side_effect = still_reserved
                    began = self.elapsed
                    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                        self.assertEqual(misc.kill_run(rid, self.me), 0 if outcome == 'delayed' else 1)
                    self.assertEqual(child.wait(timeout=5), 130)
                    self.assertEqual(sm.call_args_list[0], call('bx_test', 99))
                    for poll in sm.call_args_list[1:]:
                        self.assertEqual(poll.args, ('bx_test', 99))
                        self.assertEqual(poll.kwargs['retries'], 0)
                        self.assertLessEqual(poll.kwargs['timeout'], 5)
                        self.assertIn('deadline', poll.kwargs)
                    km.assert_called_once_with('bx_test', 99)
                    self.assertEqual(self.elapsed - began, 2 if outcome == 'delayed' else misc.KILL_CONFIRM_S)
                    if outcome == 'timeout':
                        self.assertEqual(tuple(self.status_of(rid)), ('running', None))
                        self.assertEqual(lease.active_runs(self.con, 'bx_test'), 1)
                        sm.side_effect = None
                        sm.return_value = {'running': False}
                        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                            self.assertEqual(misc.kill_run(rid, self.me), 0)
                        self.assertEqual(km.call_args_list, [call('bx_test', 99), call('bx_test', 99)])
                    self.assertEqual(tuple(self.status_of(rid)), ('killed', 143))
                    self.assertEqual(lease.active_runs(self.con, 'bx_test'), 0)

    def test_prestart_box_assignment_keeps_waiting_for_handler(self):
        self.run_row(box=None, pid=None, client=12345, owner=self.me['owner'], start=now())
        sleeps = []
        def progress(dt):
            sleeps.append(dt)
            if len(sleeps) == 1:
                self.con.execute("UPDATE runs SET box_id='bx_test' WHERE run_id='run-1'")
            else:
                self.con.execute("UPDATE runs SET status='killed', exit_code=130 WHERE run_id='run-1'")
            self.con.commit()
        with self.no_remote_actions(), patch.object(os, 'kill') as kill, \
                patch.object(misc, '_pid_started_at', return_value=now()), \
                patch.object(misc.time, 'sleep', side_effect=progress), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(misc.kill_run('run-1', self.me), 0)
        self.assertEqual(sleeps, [0.5, 0.5])
        self.assertEqual([c for c in kill.call_args_list if c.args[1] != 0], [call(12345, signal.SIGTERM)])
        self.assertIn('box bx_test returned to the pool', out.getvalue())

    def test_prestart_lost_update_does_not_overwrite_command_or_terminal_race(self):
        for box in (None, 'bx_test'):
            for outcome in ('started', 'done', 'boxed'):
                with self.subTest(box=box, outcome=outcome):
                    rid = f'run-update-race-{box}-{outcome}'
                    self.run_row(rid, box=box, pid=None, client=12345, owner=self.me['owner'])
                    read = misc._run_row
                    reads = 0
                    def race(run_id):
                        nonlocal reads
                        row = read(run_id)
                        reads += 1
                        if reads == 2:
                            updates = {'started': "box_id='bx_test', process_id=99, command_id='cmd-99'",
                                       'done': "status='done', exit_code=0", 'boxed': "box_id='bx_test'"}
                            self.con.execute(f"UPDATE runs SET {updates[outcome]} WHERE run_id=?", (run_id,))
                            self.con.commit()
                        return row
                    km, _ = self.patched_kill(status_values=({'running': True, 'commandId': 'cmd-99'},
                                                           {'running': False}))
                    with patch.object(misc, '_run_row', side_effect=race), \
                            patch.object(misc, '_client_alive', return_value=False), patch.object(os, 'kill') as kill, \
                            contextlib.redirect_stdout(io.StringIO()):
                        self.assertEqual(misc.kill_run(rid, self.me), 0)
                    self.assertEqual(self.status_of(rid)['status'],
                                     {'started': 'killed', 'done': 'done', 'boxed': 'lost'}[outcome])
                    if outcome == 'started':
                        km.assert_called_once_with('bx_test', 99)
                    else:
                        km.assert_not_called()
                    kill.assert_not_called()

    def test_prestart_invalid_pids_are_never_probed_or_signalled(self):
        for i, pid in enumerate((-1, 1, os.getpid())):
            with self.subTest(pid=pid):
                rid = f'run-invalid-{i}'
                self.run_row(rid, pid=None, client=pid, owner=self.me['owner'])
                with self.no_remote_actions(), patch.object(os, 'kill') as kill:
                    with self.assertRaisesRegex(api.OffboxError, 'invalid client pid') as exc:
                        misc.kill_run(rid, self.me)
                self.assertEqual(exc.exception.code, 2)
                kill.assert_not_called()

    def test_prestart_pid_reused_between_liveness_and_proof_is_not_signalled(self):
        started = now()
        self.run_row(pid=None, client=12345, start=started)
        with self.no_remote_actions(), patch.object(misc, '_pid_started_at', side_effect=(started, started + 10)), \
                patch.object(os, 'kill') as kill, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(misc.kill_run('run-1'), 0)
        self.assertEqual(kill.call_args_list, [call(12345, 0)])
        self.assertEqual(self.status_of('run-1')['status'], 'lost')

    def test_prestart_client_identity_tolerance_boundary(self):
        for i, offset in enumerate((2, 2.01)):
            with self.subTest(offset=offset):
                rid = f'run-tolerance-{i}'
                started = now()
                self.run_row(rid, pid=None, client=12345, start=started)
                def settle(pid, sig):
                    if sig == signal.SIGTERM:
                        self.con.execute("UPDATE runs SET status='killed', exit_code=130 WHERE run_id=?", (rid,))
                        self.con.commit()
                with self.no_remote_actions(), patch.object(misc, '_pid_started_at', return_value=started + offset), \
                        patch.object(os, 'kill', side_effect=settle) as kill, contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(misc.kill_run(rid), 0)
                self.assertEqual(self.status_of(rid)['status'], 'killed' if offset == 2 else 'lost')
                self.assertEqual([c for c in kill.call_args_list if c.args[1] != 0],
                                 [call(12345, signal.SIGTERM)] if offset == 2 else [])

    def test_prestart_disappears_before_signal_settles_lost(self):
        self.run_row(pid=None, client=12345, start=now())
        with self.no_remote_actions(), patch.object(misc, '_pid_started_at', return_value=now()), \
                patch.object(os, 'kill', side_effect=(None, ProcessLookupError)) as kill, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(misc.kill_run('run-1'), 0)
        self.assertEqual(kill.call_args_list, [call(12345, 0), call(12345, signal.SIGTERM)])
        self.assertEqual(self.status_of('run-1')['status'], 'lost')

    def test_prestart_dead_client_keeps_box_pool_and_uncertain_start_hold(self):
        self.box('bx_test', member=True)
        self.run_row(box='bx_test', pid=None, client=12345)
        self.con.execute("INSERT INTO kv(k,v) VALUES ('start_unknown:run-1','bx_test')")
        self.con.commit()
        tables = {t: [tuple(r) for r in self.con.execute(f'SELECT * FROM {t}')]
                  for t in ('leases', 'pool_members', 'kv')}
        with self.no_remote_actions(), patch.object(os, 'kill', side_effect=ProcessLookupError), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(misc.kill_run('run-1'), 1)
        self.assertEqual(self.status_of('run-1')['status'], 'running')
        for table, rows in tables.items():
            self.assertEqual([tuple(r) for r in self.con.execute(f'SELECT * FROM {table}')], rows)
        self.assertEqual(lease.active_runs(self.con, 'bx_test'), 1)

    def test_prestart_start_evidence_is_preserved_including_update_races(self):
        cases = (
            # name, box, error, start marker, command_id, expected kill result
            ('queued', None, None, None, None, 0),
            ('prepared', 'bx_test', None, None, None, 0),
            ('empty-error', 'bx_test', '', None, None, 0),
            ('interrupted', 'bx_test', 'interrupted; awaiting confirmed remote termination', None, None, 1),
            ('start-error', 'bx_test', 'start unknown: connection reset', None, None, 1),
            ('unknown', 'bx_test', None, 'start_unknown', None, 1),
            ('unattached', 'bx_test', None, 'start_unattached', None, 1),
            ('start-boundary', 'bx_test', None, 'containers_expected', None, 1),
            ('command-id', 'bx_test', None, None, 'cmd-pending', 1),
        )
        self.box('bx_test', member=True)
        for name, box, error, marker, command_id, expected in cases:
            for status in ('starting', 'running'):
                for race in ('before', 'read', 'update'):
                    with self.subTest(evidence=name, status=status, race=race):
                        rid = f'run-evidence-{name}-{status}-{race}'
                        self.run_row(rid, box=box, pid=None, client=12345, owner=self.me['owner'], status=status)
                        def evidence():
                            self.con.execute('UPDATE runs SET error=?, command_id=? WHERE run_id=?',
                                             (error, command_id, rid))
                            if marker:
                                self.con.execute('INSERT INTO kv(k,v) VALUES (?,?)', (f'{marker}:{rid}', box))
                            self.con.commit()
                        if race == 'before':
                            evidence()
                        read = misc._run_row
                        reads = 0
                        def read_before_evidence(run_id):
                            nonlocal reads
                            row = read(run_id)
                            reads += 1
                            if race == 'read' and reads == 2:
                                evidence()
                            return row
                        con = self.con
                        class UpdateRace:
                            def execute(self, sql, *args):
                                if race == 'update' and sql.startswith("UPDATE runs SET status='lost'"):
                                    evidence()
                                return con.execute(sql, *args)

                            def __getattr__(self, name):
                                return getattr(con, name)
                        with self.no_remote_actions(), patch.object(misc, 'db', return_value=UpdateRace()), \
                                patch.object(misc, '_run_row', side_effect=read_before_evidence), \
                                patch.object(misc, '_client_alive', return_value=False), patch.object(os, 'kill') as kill, \
                                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                            self.assertEqual(misc.kill_run(rid, self.me), expected)
                        row = read(rid)
                        self.assertEqual(row['status'], status if expected else 'lost')
                        self.assertEqual(row['command_id'], command_id)
                        if expected:
                            self.assertEqual(row['error'], error)
                            self.assertIsNone(row['end_at'])
                            self.assertEqual(lease.active_runs(self.con, 'bx_test'), 1)
                        if marker:
                            self.assertEqual(self.con.execute('SELECT v FROM kv WHERE k=?', (f'{marker}:{rid}',)).fetchone()[0], box)
                        kill.assert_not_called()
                        self.start_check.assert_not_called()
                        self.con.execute('DELETE FROM runs WHERE run_id=?', (rid,))
                        self.con.execute('DELETE FROM kv WHERE k IN (?,?)', (f'{marker}:{rid}', f'start_claim:{rid}'))
                        self.con.commit()

    def test_sigterm_during_cmd_start_keeps_run_reserved_until_reaper_fences(self):
        self.box('bx_test', member=True)
        rid = 'run-pending-start'
        remote_home = Path(self.tmp.name) / 'remote-home'
        remote_home.mkdir()
        remote_env = clean_env(HOME=str(remote_home))
        pending = []
        def deliver_later(box, command, **kw):
            pending.append(command)
            signal.raise_signal(signal.SIGTERM)
            self.fail('SIGTERM should interrupt the pending start response')
        def ssh(box, command, **kw):
            return subprocess.run(['bash', '-c', command], env=remote_env, capture_output=True, timeout=5)
        args = cli.build_parser().parse_args(['run', '--remote', '--', 'echo test'])
        with patch.object(runs, 'new_id', return_value=rid), \
                patch.object(pool, 'acquire', return_value=dict(box_id='bx_test', remote_dir='w/test', size='large')), \
                patch.object(pool, 'release_guard') as release, \
                patch.object(runs.Runner, '_prepare_box', return_value=None), \
                patch.object(runs, '_ttl_keeper'), patch.object(runs, '_host_restarting', return_value=False), \
                patch.object(runs, 'remote_script', return_value='touch "$HOME/side-effect"'), \
                patch.object(lease, 'auto_size', return_value=('large', None)), \
                patch.object(lease, 'touch'), patch.object(lease, 'idle_ttl'), \
                patch.object(api, '_call', side_effect=AssertionError('unexpected backend call')), \
                patch.object(api, 'cmd_start', side_effect=deliver_later), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(runs._run_attempt(args, dict(self.me, repo_root=self.tmp.name)), 130)
        release.assert_called_once()
        row = misc._run_row(rid)
        interrupted = 'interrupted; awaiting confirmed remote termination'
        self.assertEqual((row['status'], row['process_id'], row['error']), ('starting', None, interrupted))
        # Model the client exiting after _run_attempt, without signalling this test's own process.
        self.con.execute('UPDATE runs SET client_pid=12345 WHERE run_id=?', (rid,))
        self.con.commit()
        with self.no_remote_actions(), patch.object(misc, '_client_alive', return_value=False), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(misc.kill_run(rid, self.me), 1)
        row = misc._run_row(rid)
        self.assertEqual((row['status'], row['process_id'], row['error'], row['end_at']),
                         ('starting', None, interrupted, None))
        self.assertIn('remote start unconfirmed', err.getvalue())
        with patch.object(runs, 'confirmed_lost', return_value={'status': 'lost'}) as lost:
            runs.reconcile_lost(self.con, 'bx_test', state='running')
        lost.assert_not_called()
        self.assertEqual(lease.active_runs(self.con, 'bx_test'), 1)
        self.assertIsNone(self.con.execute('SELECT 1 FROM kv WHERE k=?', (f'lost_confirmed:{rid}',)).fetchone())
        with patch.object(ssh_sync, 'ssh', side_effect=ssh), \
                patch.object(start_check, 'check', side_effect=self.real_start_check) as check, \
                patch.object(reap, 'now', return_value=now() + reap.START_GRACE_S + 1):
            reap._check_unlocked(self.con, 'bx_test', 'running', False, [])
        check.assert_called_once_with('bx_test', rid, claim=True)
        self.assertEqual(lease.active_runs(self.con, 'bx_test'), 0)
        self.assertEqual(self.con.execute('SELECT v FROM kv WHERE k=?', (f'lost_confirmed:{rid}',)).fetchone()[0], 'fenced')
        self.assertEqual(len(pending), 1)
        late = ssh('bx_test', pending[0])
        self.assertEqual(late.returncode, start_check.REFUSED_RC, late.stderr)
        self.assertFalse((remote_home / 'side-effect').exists())

    def test_prestart_api_id_provenance_failure_never_sends_remote_kill(self):
        for i, status in enumerate((None, {}, {'commandId': 'other-command'}, api.OffboxError('status failed'))):
            with self.subTest(status=status):
                rid = f'run-id-proof-{i}'
                self.run_row(rid, pid=None, client=12345, status='starting', start=now())
                km, sm = self.patched_kill(kill_side_effect=AssertionError('unproven API ID'), status_values=(status, status))
                def start(pid, sig):
                    if sig != signal.SIGTERM:
                        return
                    self.con.execute("UPDATE runs SET process_id=4242, command_id='cmd-1001', status='running' "
                                     "WHERE run_id=?", (rid,))
                    self.con.commit()
                with patch.object(misc, '_pid_started_at', return_value=now()), \
                        patch.object(os, 'kill', side_effect=start), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(misc.kill_run(rid), 1)
                    self.assertEqual(misc.kill_run(rid), 1)
                km.assert_not_called()
                self.assertEqual(sm.call_args_list, [call('bx_1', 4242), call('bx_1', 4242)])
                self.assertEqual(self.status_of(rid)['status'], 'running')

    def test_settled_row_refused(self):
        self.run_row('run-done', status='done')
        km, _ = self.patched_kill()
        with self.assertRaises(api.OffboxError):
            misc.kill_run('run-done')
        km.assert_not_called()

    def test_home_settled_cleanup_calls_delete_and_preserves_terminal_result(self):
        for status, code in (('done', 0), ('failed', 7), ('interrupted', 94), ('killed', 143), ('lost', None)):
            rid = 'run-' + status
            self.run_row(rid, status=status)
            self.con.execute('UPDATE runs SET exit_code=?,end_at=123 WHERE run_id=?', (code, rid))
            self.con.commit()
            info = dict(cleanup='stopped', leftover_killed=3, remaining=0)
            with self.subTest(status=status), patch.object(api, 'BACKEND', 'server'), \
                    patch.object(api, 'call', return_value={'cleanup': info}) as delete, \
                    patch.object(api, 'cmd_status', side_effect=AssertionError('terminal status cannot prove cleanup')), \
                    contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(misc.kill_run(rid), 0)
            delete.assert_called_once_with('DELETE', '/sandboxes/bx_1/commands/42', ok404=True, retries=1)
            row = self.con.execute('SELECT status,exit_code,end_at FROM runs WHERE run_id=?', (rid,)).fetchone()
            self.assertEqual(tuple(row), (status, code, 123))
            self.assertIn('cleanup: 3 stopped', out.getvalue())
            saved = json.loads((runs.LOGS_DIR / f'{rid}.state.json').read_text())
            self.assertEqual(saved['cleanup'], info)

    def test_home_settled_cleanup_reports_clean_or_unknown(self):
        cases = [(dict(cleanup='clean', leftover_killed=0, remaining=0), 0, 'clean'),
                 (dict(cleanup='unknown', leftover_killed=None, remaining=None, reason='box_unreadable'), 1, 'unknown'),
                 (dict(cleanup='stopped', leftover_killed=None, remaining=0), 1, 'unknown'),
                 ({}, 1, 'unknown')]
        for index, (info, code, text) in enumerate(cases):
            rid = f'run-cleanup-{index}'
            self.run_row(rid, status='failed')
            with self.subTest(info=info), patch.object(api, 'BACKEND', 'server'), \
                    patch.object(api, 'cmd_kill', return_value={'cleanup': info}) as delete, \
                    contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(misc.kill_run(rid), code)
            delete.assert_called_once_with('bx_1', 42)
            self.assertIn('cleanup: ' + text, out.getvalue())
            self.assertEqual(self.status_of(rid)['status'], 'failed')

    def test_home_settled_cleanup_still_requires_proven_caller_and_owner(self):
        self.run_row('run-done', status='done', owner=self.me['owner'])
        with patch.object(api, 'BACKEND', 'server'), patch.object(api, 'cmd_kill') as delete:
            for me in (dict(self.me, proven=False), dict(self.me, proven=True, owner='another-worker')):
                with self.subTest(me=me), self.assertRaises(api.OffboxError):
                    misc.kill_run('run-done', me)
            delete.assert_not_called()

    def test_home_settled_cleanup_still_refuses_untrusted_wrapper_pid(self):
        self.run_row('run-done', status='done')
        self.con.execute("INSERT INTO kv(k,v) VALUES ('start_unknown:run-done','bx_1')")
        self.con.commit()
        with patch.object(api, 'BACKEND', 'server'), patch.object(api, 'cmd_kill') as delete, \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(misc.kill_run('run-done'), 1)
        delete.assert_not_called()

    def test_home_settled_without_remote_process_is_still_refused(self):
        self.run_row('run-no-process', status='done', pid=None)
        self.run_row('run-local-done', status='done', mode='local')
        with patch.object(api, 'BACKEND', 'server'), patch.object(api, 'cmd_kill') as delete:
            for rid in ('run-no-process', 'run-local-done'):
                with self.subTest(rid=rid), self.assertRaises(api.OffboxError):
                    misc.kill_run(rid)
            delete.assert_not_called()

    def test_release_refusal_names_runs_and_suggests_kill(self):
        self.box('bx_busy')
        self.run_row('run-hung', box='bx_busy', pid=7)
        r = self.con.execute("SELECT * FROM leases WHERE box_id='bx_busy'").fetchone()
        err = io.StringIO()
        with patch.object(misc, 'db', return_value=self.con), contextlib.redirect_stderr(err):
            misc._release_one(self.con, r, False)
        self.assertIn('run-hung', err.getvalue())
        self.assertIn('offbox kill <run>', err.getvalue())

    def test_public_release_names_runs_when_box_lock_is_held(self):
        # A streaming foreground run holds box-<id>; public release must still name the hung run and suggest kill.
        self.box('bx_held')
        self.run_row('run-streaming', box='bx_held', pid=9)
        held = common.file_lock('box-bx_held', timeout=0)
        held.__enter__()
        try:
            err = io.StringIO()
            with patch.object(misc, 'db', return_value=self.con), contextlib.redirect_stderr(err):
                misc.release(self.me, 'bx_held', False, False)
            self.assertIn('run-streaming', err.getvalue())
            self.assertIn('offbox kill <run>', err.getvalue())
            self.assertEqual(self.con.execute("SELECT state FROM leases WHERE box_id='bx_held'").fetchone()[0],
                             'running')
        finally:
            held.__exit__(None, None, None)

    def test_public_release_busy_lock_without_runs_is_not_run_hint(self):
        self.box('bx_busy2')
        held = common.file_lock('box-bx_busy2', timeout=0)
        held.__enter__()
        try:
            err = io.StringIO()
            with patch.object(misc, 'db', return_value=self.con), contextlib.redirect_stderr(err):
                misc.release(self.me, 'bx_busy2', False, False)
            self.assertIn('box is busy', err.getvalue())
            self.assertNotIn('offbox kill', err.getvalue())
        finally:
            held.__exit__(None, None, None)

    def test_reaper_marks_old_nobox_rows_lost_only(self):
        self.run_row('run-old-nobox', box=None, pid=None, mode='bg', start=now() - 3 * 3600)
        self.run_row('run-new-nobox', box=None, pid=None, mode='fg', start=now() - 600)
        self.run_row('run-old-boxed', box='bx_9', pid=5, mode='fg', start=now() - 3 * 3600)
        self.stack.enter_context(patch.object(api, 'list_boxes', return_value=[]))
        actions = []
        reap._reap(self.con, False, actions)
        old = self.status_of('run-old-nobox')
        self.assertEqual(old['status'], 'lost')
        row = self.con.execute("SELECT error FROM runs WHERE run_id='run-old-nobox'").fetchone()
        self.assertEqual(row['error'], 'client ended before it got a box')
        self.assertEqual(self.status_of('run-new-nobox')['status'], 'running')
        self.assertEqual(self.status_of('run-old-boxed')['status'], 'running')
        self.assertTrue(any('run-old-nobox' in a for a in actions))

    def test_reaper_dry_run_writes_nothing(self):
        self.run_row('run-old-nobox', box=None, pid=None, mode='fg', start=now() - 3 * 3600)
        self.stack.enter_context(patch.object(api, 'list_boxes', return_value=[]))
        actions = []
        reap._reap(self.con, True, actions)
        self.assertEqual(self.status_of('run-old-nobox')['status'], 'running')
        self.assertTrue(any('would mark no-box run run-old-nobox' in a for a in actions))


if __name__ == '__main__':
    unittest.main()
