"""A deliberate kill remains a terminal command result across every client settlement path."""
import contextlib
import io
from pathlib import Path
import sqlite3
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, cli, common, lease, misc, reap, runs
from test_capacity import Isolated
from test_wait_lock import Clock


class KilledResultTests(Isolated):
    def setUp(self):
        super().setUp()
        self.path = common.LOGS_DIR / 'run-kill.log'
        self.path.write_text('offbox step 1 rc=0: one\noffbox step 2 rc=0: two\n'
                             'offbox evidence signal=TERM step=3\n')
        self.con.execute("INSERT INTO runs(run_id,box_id,process_id,status,mode,step_count,pulls,start_at) "
                         "VALUES ('run-kill','bx_test',7,'running','fg',3,'[]',900)")
        self.con.execute("UPDATE runs SET local_cwd=?,remote_dir='w/fixture',rel_cwd='.'", (self.me['repo_root'],))
        self.con.commit()
        self.stack.enter_context(patch.object(lease, 'touch'))
        self.stack.enter_context(patch.object(lease, 'idle_ttl'))
        self.stack.enter_context(patch.object(runs, 'settle_docker'))
        self.stack.enter_context(patch.object(misc, '_catch_up_log', return_value='complete'))
        self.stack.enter_context(patch.object(runs, 'recover_lost_exit', return_value=(None, 'none')))

    def row(self):
        return self.con.execute("SELECT * FROM runs WHERE run_id='run-kill'").fetchone()

    def killed(self, code=143):
        self.con.execute("UPDATE runs SET status='killed',exit_code=?,end_at=1000 WHERE run_id='run-kill'", (code,))
        self.con.commit()

    def assert_killed(self):
        self.assertEqual((self.row()['status'], self.row()['exit_code']), ('killed', 143))

    def foreground(self, stream=None, *, pulls=()):
        a = cli.build_parser().parse_args(['run', '--step', 'one', '--step', 'two', '--step', 'three'])
        a.steps = a.step
        a.pull = list(pulls)
        rn = SimpleNamespace(run_id='run-kill', box='bx_test', pid=7, started=True,
                             root=Path(self.me['repo_root']), log_path=self.path, recovered_code=None,
                             remote_code=None, start=lambda: None, stream=stream or (lambda: None))
        return runs._run_remote(a, rn)

    def assert_output(self, text):
        self.assertIn('killed by offbox kill', text)
        self.assertIn('stopped by offbox kill at step 3 of 3', text)
        self.assertNotIn('steps incomplete', text)
        self.assertNotIn('process was lost', text)
        self.assertNotIn('infra failure', text)

    def test_attached_killed_row_returns_143_on_both_backends(self):
        for backend in ('boat', 'server'):
            for code in (None, 143):
                with self.subTest(backend=backend, streamed_code=code), patch.object(api, 'BACKEND', backend):
                    self.killed()
                    err = io.StringIO()
                    with contextlib.redirect_stderr(err), patch.object(runs, 'finish') as finish:
                        self.assertEqual(self.foreground(lambda: code), 143)
                    finish.assert_not_called()
                    self.assert_output(err.getvalue())
                    self.assert_killed()

    def test_kill_confirmation_wins_after_attached_client_reaches_settlement(self):
        clock = Clock(on_sleep=lambda _: runs.finish('run-kill', 143, 'killed', catch_up=False))
        common.event(self.con, 'bx_test', 'run_kill_requested', 'run-kill owner=worker')
        self.con.execute("UPDATE events SET ts=1000")
        self.con.commit()
        err = io.StringIO()
        with patch.object(runs, 'now', clock.now), patch.object(runs.time, 'sleep', clock.sleep), \
                contextlib.redirect_stderr(err):
            self.assertEqual(self.foreground(), 143)
        self.assertGreater(clock.t, 1000)
        self.assertLess(clock.t, 1045)
        self.assert_output(err.getvalue())
        self.assertIn('owner=worker', err.getvalue())
        self.assert_killed()

    def test_unconfirmed_kill_request_is_not_proof_of_a_kill(self):
        clock = Clock()
        common.event(self.con, 'bx_test', 'run_kill_requested', 'run-kill owner=worker')
        self.con.execute('UPDATE events SET ts=1000')
        self.con.commit()
        with patch.object(runs, 'now', clock.now), patch.object(runs.time, 'sleep', clock.sleep):
            self.assertIsNone(runs.killed_result('run-kill', wait=True))
        self.assertAlmostEqual(clock.t, 1000 + misc.KILL_REQUEST_S + misc.KILL_CONFIRM_S + 5)
        self.assertEqual(self.row()['status'], 'running')

    def test_slow_delete_does_not_consume_the_confirmation_window(self):
        common.event(self.con, 'bx_test', 'run_kill_requested', 'run-kill owner=worker')
        self.con.execute('UPDATE events SET ts=1000')
        self.con.commit()
        def progress(t):
            if t == 1060:
                common.event(self.con, 'bx_test', 'run_kill_confirming', 'run-kill owner=worker')
                self.con.execute("UPDATE events SET ts=1060 WHERE kind='run_kill_confirming'")
                self.con.commit()
            if t >= 1095:
                self.killed()
        clock = Clock(on_sleep=progress)
        with patch.object(runs, 'now', clock.now), patch.object(runs.time, 'sleep', clock.sleep):
            self.assertEqual(runs.killed_result('run-kill', wait=True)['exit_code'], 143)
        self.assertEqual(clock.t, 1095)

    def test_foreground_signal_exits_wait_before_pulling_or_validating_steps(self):
        for code in (137, 143):
            with self.subTest(code=code):
                self.con.execute("UPDATE runs SET status='running',exit_code=NULL")
                self.con.execute('DELETE FROM events')
                self.con.commit()
                common.event(self.con, 'bx_test', 'run_kill_requested', 'run-kill owner=worker')
                self.con.execute('UPDATE events SET ts=1000')
                self.con.commit()
                clock = Clock(on_sleep=lambda _: self.killed())
                def pull(*args, **kwargs):
                    self.assert_killed()
                    raise common.OffboxError('pull disconnected')
                with contextlib.ExitStack() as stack:
                    stack.enter_context(patch.object(runs, 'now', clock.now))
                    stack.enter_context(patch.object(runs.time, 'sleep', clock.sleep))
                    pulls = stack.enter_context(patch.object(runs, 'do_pulls', side_effect=pull))
                    err = stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
                    self.assertEqual(self.foreground(lambda: code, pulls=['reports']), 143)
                pulls.assert_called_once()
                self.assert_output(err.getvalue())

    def test_optional_kill_refresh_failure_keeps_loaded_terminal_results(self):
        for code in (0, 17, 143):
            for entry in ('wait', 'logs', 'holder'):
                with self.subTest(code=code, entry=entry):
                    self.con.execute("UPDATE runs SET status=?,exit_code=?,step_count=0",
                                     ('killed' if code == 143 else 'done' if code == 0 else 'failed', code))
                    self.con.commit()
                    row = self.row()
                    with contextlib.ExitStack() as stack:
                        refresh = stack.enter_context(patch.object(runs, 'db', side_effect=sqlite3.OperationalError('database is locked')))
                        stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                        err = stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
                        if entry == 'wait':
                            result = misc._settled(row)
                        elif entry == 'logs':
                            stack.enter_context(patch.object(misc, '_run_row', return_value=row))
                            result = misc.logs('run-kill', True)
                        else:
                            result = misc._holder_stuck(row, {'status': 'exited', 'exitCode': code}, self.path, 0, False)
                    self.assertEqual(result, code if entry != 'logs' or code == 143 else 0)
                    if code == 143:
                        self.assertIn('killed by offbox kill', err.getvalue())
                    else:
                        refresh.assert_not_called()

    def test_optional_refresh_keeps_known_process_exit_when_row_is_stale(self):
        self.con.execute('UPDATE runs SET step_count=0')
        self.con.commit()
        for code in (0, 17, 143):
            with self.subTest(code=code), patch.object(runs, 'db', side_effect=sqlite3.OperationalError('disk I/O error')), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(misc._holder_stuck(self.row(), {'status': 'exited', 'exitCode': code}, self.path, 0, False), code)

    def test_confirmed_kill_survives_failed_sqlite_write_and_is_repaired(self):
        for entry, previous in (('run', None), ('wait', None), ('run', 137), ('wait', 143)):
            with self.subTest(entry=entry, previous=previous):
                self.con.execute("UPDATE runs SET status=?,exit_code=?", ('running' if previous is None else 'failed', previous))
                self.con.commit()
                with patch.object(runs, 'db', side_effect=sqlite3.OperationalError('database is locked')), \
                        patch.object(runs, 'db_retry', side_effect=lambda operation, **kwargs: operation()), \
                        contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(runs.finish('run-kill', 143, 'killed', catch_up=False), 143)
                self.assertEqual(self.row()['status'], 'running' if previous is None else 'failed')
                # A second reader can still report the saved result while SQLite remains unavailable.
                with patch.object(runs, 'db', side_effect=sqlite3.OperationalError('disk I/O error')), \
                        contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(runs.killed_result('run-kill', row=self.row())['exit_code'], 143)
                with contextlib.redirect_stderr(io.StringIO()) as err, contextlib.redirect_stdout(io.StringIO()):
                    result = self.foreground() if entry == 'run' else misc.wait('run-kill', None)
                self.assertEqual(result, 143)
                self.assert_output(err.getvalue())
                self.assert_killed()

    def test_confirmed_kill_precedes_failing_recovery_on_every_client_path(self):
        self.killed()
        stale = dict(self.row(), status='running', exit_code=None)
        for backend in ('boat', 'server'):
            for entry in ('run', 'holder', 'resolve', 'recover'):
                with self.subTest(backend=backend, entry=entry), contextlib.ExitStack() as stack:
                    stack.enter_context(patch.object(api, 'BACKEND', backend))
                    recovery = stack.enter_context(patch.object(
                        runs, 'recover_lost_exit', side_effect=common.OffboxError('history 404')))
                    follow = stack.enter_context(patch.object(runs, 'follow', side_effect=AssertionError('already killed')))
                    stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                    err = stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
                    if entry == 'run':
                        result = self.foreground()
                    elif entry == 'holder':
                        result = misc._holder_stuck(stale, {'status': 'lost'}, self.path, 0, False)
                    elif entry == 'resolve':
                        result = misc._resolve_exit(stale, self.path, None, (0, 0), None)
                    else:
                        result, _ = misc._recover_by(stale, self.path, None)
                    self.assertEqual(result, 143)
                    recovery.assert_not_called()
                    follow.assert_not_called()
                    if entry in ('run', 'holder'):
                        self.assert_output(err.getvalue())

    def test_kill_committing_during_failed_recovery_still_returns_143(self):
        def recovery(*args, **kwargs):
            self.killed()
            raise common.OffboxError('history 404')
        with patch.object(runs, 'recover_lost_exit', side_effect=recovery), \
                contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(self.foreground(), 143)
        self.assert_output(err.getvalue())

    def test_stream_failure_rechecks_kill_receipt_without_hiding_other_errors(self):
        for entry in ('run', 'follow'):
            for killed in (False, True):
                with self.subTest(entry=entry, killed=killed):
                    self.con.execute("UPDATE runs SET status='running',exit_code=NULL")
                    self.con.commit()
                    stale = self.row()
                    error = common.OffboxError('stream disconnected', code=90)
                    def stream(*args, **kwargs):
                        if killed:
                            self.killed()
                        raise error
                    with patch.object(runs, 'follow', side_effect=stream), contextlib.redirect_stderr(io.StringIO()) as err:
                        if killed:
                            if entry == 'run':
                                result = self.foreground(stream)
                            else:
                                code = misc._resolve_exit(stale, self.path, None, (0, 0), None)
                                result = misc._finalize(stale, code, self.path)
                            self.assertEqual(result, 143)
                            self.assert_output(err.getvalue())
                            self.assert_killed()
                        else:
                            with self.assertRaises(common.OffboxError) as caught:
                                if entry == 'run':
                                    self.foreground(stream)
                                else:
                                    misc._resolve_exit(stale, self.path, None, (0, 0), None)
                            self.assertIs(caught.exception, error)

    def test_unreadable_step_log_does_not_replace_confirmed_kill(self):
        self.killed()
        with patch.object(runs, 'step_results', side_effect=PermissionError('log unreadable')), \
                contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(misc._settled(self.row()), 143)
        self.assertIn('killed by offbox kill', err.getvalue())

    def test_killed_foreground_preserves_artifact_pulls_and_the_kill_exit(self):
        self.killed()
        for failure in (None, common.OffboxError('pull disconnected')):
            with self.subTest(failure=failure), patch.object(runs, 'do_pulls', side_effect=failure) as pull, \
                    contextlib.redirect_stderr(io.StringIO()) as err:
                self.assertEqual(self.foreground(pulls=['reports']), 143)
                self.assertEqual(pull.call_args.args[0], 'bx_test')
                self.assertEqual(pull.call_args.args[2], ['reports'])
                self.assert_output(err.getvalue())
                if failure:
                    self.assertIn('artifact pull after offbox kill failed', err.getvalue())

    def test_saved_kill_without_pull_metadata_still_returns_143_during_db_outage(self):
        runs.save_run_state('run-kill', status='killed', exit_code=143, end_at=1000)
        with patch.object(runs, 'db', side_effect=sqlite3.OperationalError('database is locked')), \
                patch.object(runs, 'do_pulls') as pull, contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(self.foreground(pulls=['reports']), 143)
        pull.assert_not_called()
        self.assertIn('pull metadata unavailable', err.getvalue())
        self.assert_output(err.getvalue())

    def test_missing_pull_metadata_warns_without_losing_kill_result(self):
        self.killed()
        for field in ('local_cwd', 'remote_dir', 'rel_cwd'):
            with self.subTest(field=field):
                row = dict(self.row())
                row.pop(field)
                with patch.object(runs, 'do_pulls') as pull, contextlib.redirect_stderr(io.StringIO()) as err:
                    self.assertEqual(runs.complete_killed(row, self.path, pulls=['reports']), 143)
                pull.assert_not_called()
                self.assertIn('pull metadata unavailable', err.getvalue())

    def test_legacy_killed_null_row_wins_over_stale_saved_results(self):
        for status, code in (('failed', 143), ('failed', 17), ('done', 0), ('lost', None), ('killed', 130)):
            for entry in ('run', 'wait', 'logs'):
                with self.subTest(saved_status=status, saved_code=code, entry=entry):
                    self.killed(None)
                    runs.save_run_state('run-kill', status=status, exit_code=code, end_at=999)
                    with contextlib.redirect_stderr(io.StringIO()) as err, contextlib.redirect_stdout(io.StringIO()):
                        if entry == 'run':
                            result = self.foreground()
                        elif entry == 'wait':
                            result = misc.wait('run-kill', None)
                        else:
                            result = misc.logs('run-kill', True)
                    self.assertEqual(result, 143)
                    self.assert_output(err.getvalue())
                    self.assert_killed()

    def test_saved_kill_does_not_replace_known_natural_results(self):
        for code in (0, 17):
            with self.subTest(code=code):
                self.con.execute("UPDATE runs SET status=?,exit_code=?,step_count=0",
                                 ('done' if code == 0 else 'failed', code))
                self.con.commit()
                runs.save_run_state('run-kill', status='killed', exit_code=143, end_at=1000)
                self.assertIsNone(runs.killed_result('run-kill', row=self.row()))
                self.assertEqual(runs.restore_run_state(self.row())['exit_code'], code)

    def test_killed_wait_keeps_143_when_history_or_artifact_fetch_fails(self):
        self.killed()
        self.con.execute("UPDATE runs SET pulls='[\"reports\"]'")
        self.con.commit()
        for entry in ('wait', 'logs', 'finalize'):
            with self.subTest(entry=entry), contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(misc, '_catch_up_log', side_effect=common.OffboxError('history 404')))
                stack.enter_context(patch.object(runs, 'do_pulls', side_effect=common.OffboxError('pull disconnected')))
                err = stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
                stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                if entry == 'wait':
                    result = misc.wait('run-kill', None)
                elif entry == 'logs':
                    result = misc.logs('run-kill', True)
                else:
                    result = misc._finalize(self.row(), None, self.path)
                self.assertEqual(result, 143)
                self.assert_output(err.getvalue())

    def test_missing_step_signal_exit_waits_for_pending_kill_on_settlement_paths(self):
        for entry in ('finish', 'wait', 'finalize', 'reap'):
            with self.subTest(entry=entry):
                self.con.execute("UPDATE runs SET status='infra',exit_code=NULL,mode='bg'")
                self.con.execute('DELETE FROM events')
                self.con.commit()
                common.event(self.con, 'bx_test', 'run_kill_requested', 'run-kill owner=worker')
                self.con.execute('UPDATE events SET ts=1000')
                self.con.commit()
                clock = Clock(on_sleep=lambda _: runs.finish('run-kill', 143, 'killed', catch_up=False))
                actions = []
                with contextlib.ExitStack() as stack:
                    stack.enter_context(patch.object(runs, 'now', clock.now))
                    stack.enter_context(patch.object(runs.time, 'sleep', clock.sleep))
                    stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                    err = stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
                    if entry == 'finish':
                        result = runs.finish('run-kill', 143, catch_up=False, report=True)
                    elif entry == 'wait':
                        result = misc.wait('run-kill', None)
                    elif entry == 'finalize':
                        result = misc._finalize(self.row(), 143, self.path)
                    else:
                        self.con.execute("UPDATE runs SET status='running'")
                        self.con.commit()
                        stack.enter_context(patch.object(api, 'cmd_status', return_value={
                            'status': 'exited', 'running': False, 'exitCode': 143}))
                        reap._check_stale_runs(self.con, 'bx_test', 'running', False, actions)
                        result = self.row()['exit_code']
                self.assertEqual(result, 143)
                self.assertNotIn('steps incomplete', err.getvalue())
                self.assert_killed()

    def test_finish_never_downgrades_killed_and_repairs_old_null_exit(self):
        for previous in (None, 143):
            for status in (None, 'infra', 'done', 'failed'):
                with self.subTest(previous=previous, status=status):
                    self.killed(previous)
                    self.assertEqual(runs.finish('run-kill', None, status, catch_up=False), 143)
                    self.assert_killed()

    def test_kill_finish_repairs_attached_clients_earlier_unknown_result(self):
        for status in ('running', 'lost', 'infra'):
            with self.subTest(status=status):
                self.con.execute('UPDATE runs SET status=?,exit_code=NULL', (status,))
                self.con.commit()
                self.assertEqual(runs.finish('run-kill', 143, 'killed', catch_up=False), 143)
                self.assert_killed()

    def test_plain_attached_exit_143_before_kill_confirmation_becomes_killed(self):
        self.con.execute('UPDATE runs SET step_count=0')
        self.con.commit()
        self.assertEqual(runs.finish('run-kill', 143, catch_up=False), 143)
        self.assertEqual(self.row()['status'], 'failed')
        self.assertEqual(runs.finish('run-kill', 143, 'killed', catch_up=False), 143)
        self.assert_killed()

    def test_kill_committing_between_validation_and_persist_wins(self):
        def validation(*args, **kwargs):
            self.killed()
            return None
        with patch.object(runs, 'settled_steps_code', side_effect=validation):
            self.assertEqual(runs.finish('run-kill', None, catch_up=False), 143)
        self.assert_killed()

    def test_real_kill_bypasses_missing_step_validation_on_both_backends(self):
        for backend in ('boat', 'server'):
            with self.subTest(backend=backend), patch.object(api, 'BACKEND', backend):
                self.con.execute("UPDATE runs SET status='running',exit_code=NULL")
                self.con.commit()
                with patch.object(api, 'cmd_kill', return_value={}), \
                        patch.object(api, 'cmd_status', return_value={'running': False, 'status': 'exited', 'exitCode': 143}), \
                        contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(misc.kill_run('run-kill'), 0)
                self.assert_killed()

    def test_kill_records_the_confirmation_phase_after_delete(self):
        def delete(*args, **kwargs):
            kinds = [r[0] for r in self.con.execute('SELECT kind FROM events ORDER BY rowid')]
            self.assertEqual(kinds, ['run_kill_requested'])
            self.assertIsNotNone(api.left())
            self.assertLessEqual(api.left(), misc.KILL_REQUEST_S)
        def status(*args, **kwargs):
            kinds = [r[0] for r in self.con.execute('SELECT kind FROM events ORDER BY rowid')]
            self.assertEqual(kinds, ['run_kill_requested', 'run_kill_confirming'])
            return {'running': False, 'status': 'exited', 'exitCode': 143}
        with patch.object(api, 'cmd_kill', side_effect=delete), patch.object(api, 'cmd_status', side_effect=status), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(misc.kill_run('run-kill'), 0)
        self.assert_killed()
        self.assertEqual(self.con.execute('SELECT kind FROM events ORDER BY rowid DESC LIMIT 1').fetchone()[0],
                         'run_kill_finished')

    def test_phase_event_write_failure_does_not_skip_kill_confirmation(self):
        original = misc.event
        def event(con, box, kind, detail):
            if kind == 'run_kill_confirming':
                con.execute('INSERT INTO events VALUES (?,?,?,?)', (1000, box, kind, detail))
                raise sqlite3.OperationalError('database is locked')
            return original(con, box, kind, detail)
        with patch.object(misc, 'event', side_effect=event), patch.object(api, 'cmd_kill', return_value={}), \
                patch.object(api, 'cmd_status', return_value={'running': False, 'status': 'exited', 'exitCode': 143}) as status, \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(misc.kill_run('run-kill'), 0)
        status.assert_called_once()
        self.assert_killed()
        self.assertIn('local bookkeeping failed', err.getvalue())

    def test_wait_logs_and_background_settlement(self):
        for backend in ('boat', 'server'):
            for mode in ('fg', 'bg'):
                for entry in ('wait', 'logs', 'follow', 'finalize', 'holder'):
                    with self.subTest(backend=backend, mode=mode, entry=entry), patch.object(api, 'BACKEND', backend):
                        self.con.execute('UPDATE runs SET mode=?', (mode,))
                        self.con.commit()
                        self.killed(None)
                        err = io.StringIO()
                        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
                            if entry == 'wait':
                                code = misc.wait('run-kill', None)
                            elif entry in ('logs', 'follow'):
                                code = misc.logs('run-kill', entry == 'follow')
                            elif entry == 'finalize':
                                code = misc._finalize(self.row(), None, self.path)
                            else:
                                code = misc._holder_stuck(self.row(), {'status': 'lost'}, self.path, 0, False)
                        self.assertEqual(code, 143)
                        self.assert_output(err.getvalue())
                        self.assert_killed()

    def test_background_killed_at_step_seven_of_seven(self):
        self.con.execute("UPDATE runs SET mode='bg',step_count=7")
        self.con.commit()
        self.killed()
        self.path.write_text(''.join(f'offbox step {n} rc=0: command\n' for n in range(1, 7))
                             + 'offbox evidence signal=TERM step=7\n')
        err = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(misc.wait('run-kill', None), 143)
        self.assertIn('stopped by offbox kill at step 7 of 7 (6 of 7 step results)', err.getvalue())
        self.assertNotIn('steps incomplete', err.getvalue())

    def test_wait_already_following_a_locked_run_observes_the_kill(self):
        clock = Clock(on_sleep=lambda _: self.killed())
        err = io.StringIO()
        with common.file_lock('box-bx_test', timeout=0), \
                patch.object(misc, 'time', clock.time), patch.object(misc, 'now', clock.now), \
                patch.object(misc, '_refresh_running_ttl'), \
                patch.object(runs, '_ended', return_value=None), \
                contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(misc.wait('run-kill', 60), 143)
        self.assert_output(err.getvalue())
        self.assert_killed()

    def test_reaper_with_a_stale_active_row_keeps_killed_result(self):
        self.con.execute("UPDATE runs SET mode='bg',pulls='[\"reports\"]'")
        self.con.commit()
        actions = []
        err = io.StringIO()
        def status(*args, **kwargs):
            self.killed()
            return {'status': 'exited', 'running': False, 'exitCode': 143}
        with patch.object(api, 'cmd_status', side_effect=status), \
                patch.object(runs, 'do_pulls', side_effect=common.OffboxError('pull disconnected')) as pulls, \
                contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            reap._check_stale_runs(self.con, 'bx_test', 'running', False, actions)
        self.assert_killed()
        self.assert_output(err.getvalue())
        self.assertIn('killed by offbox kill exit=143', '\n'.join(actions))
        pulls.assert_called_once()

    def test_reaper_post_finish_read_failure_does_not_skip_cleanup_or_next_run(self):
        self.con.execute("UPDATE runs SET mode='bg',step_count=0")
        self.con.execute("INSERT INTO runs(run_id,box_id,process_id,status,mode,step_count,pulls,start_at) "
                         "VALUES ('run-next','bx_test',8,'running','bg',0,'[]',900)")
        self.con.commit()
        finished = []
        original_finish = runs.finish
        def finish(*args, **kwargs):
            result = original_finish(*args, **kwargs)
            finished.append(args[0])
            return result
        outer = self
        class Connection:
            def execute(self, sql, parameters=()):
                if sql == 'SELECT * FROM runs WHERE run_id=?' and parameters[0] in finished:
                    finished.remove(parameters[0])
                    raise sqlite3.OperationalError('disk I/O error')
                return outer.con.execute(sql, parameters)
            def __getattr__(self, name):
                return getattr(outer.con, name)
        actions = []
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(api, 'cmd_status', return_value={'status': 'exited', 'running': False, 'exitCode': 17}))
            stack.enter_context(patch.object(runs, 'finish', side_effect=finish))
            cleanup = stack.enter_context(patch.object(misc, '_catch_up_finished'))
            idle = stack.enter_context(patch.object(lease, 'idle_ttl'))
            err = stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            reap._check_stale_runs(Connection(), 'bx_test', 'running', False, actions)
        self.assertEqual(sum(isinstance(call.args[0], Connection) for call in cleanup.call_args_list), 2)
        self.assertEqual(idle.call_count, 2)
        self.assertEqual(self.con.execute("SELECT count(*) FROM runs WHERE status='failed' AND exit_code=17").fetchone()[0], 2)
        self.assertEqual(len(actions), 2)
        self.assertIn('local bookkeeping failed', err.getvalue())

    def test_non_killed_missing_exit_keeps_lost_90(self):
        self.con.execute('UPDATE runs SET step_count=0')
        self.con.commit()
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(self.foreground(), 90)
        self.assertIn('remote process was lost (box restarted?); treating as infra failure', err.getvalue())
        self.assertNotIn('killed by offbox kill', err.getvalue())

    def test_queued_kill_retains_130_and_existing_wording(self):
        self.con.execute("UPDATE runs SET box_id=NULL,process_id=NULL,status='killed',exit_code=130")
        self.con.commit()
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(misc.wait('run-kill', None), 130)
        self.assertIn('killed while queued; never started; nothing ran', err.getvalue())


if __name__ == '__main__':
    unittest.main()
