"""API IDs are opaque: a wrapper PID may be absent from the API or belong to another command."""
import contextlib
import io
import json
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import api, common, lease, misc, pool, reap, runs, start_check
from test_capacity import Isolated


class ProcessNamespace(Isolated):
    def setUp(self):
        super().setUp()
        self.box('bx', member=True)
        self.stack.enter_context(patch.object(misc, '_client_alive', return_value=False))
        self.stack.enter_context(patch.object(misc, '_require_my_run'))
        self.stack.enter_context(patch.object(misc, '_catch_up_finished'))
        self.stack.enter_context(patch.object(misc, '_catch_up_log', return_value='complete'))
        self.stack.enter_context(patch.object(runs, 'reconcile_lost'))
        self.stack.enter_context(patch.object(lease, 'idle_ttl'))
        self.stack.enter_context(patch.object(lease, 'ensure_ttl'))
        self.stack.enter_context(patch.object(api, 'get', return_value={'state': 'running'}))
        self.stack.enter_context(patch.object(api, 'history_get', return_value={}))
        self.calls = []
        self.other = {'running': True, 'commandId': 'another-run'}
        self.commands = {1001: {'running': False, 'status': 'exited', 'exitCode': 0, 'commandId': 'cmd-own'},
                         1002: self.other}
        self.stack.enter_context(patch.object(api, 'cmd_status', side_effect=self.status))
        self.stack.enter_context(patch.object(api, 'cmd_kill', side_effect=self.kill))
        self.stack.enter_context(patch.object(api, 'cmd_attach', side_effect=AssertionError('unexpected attach')))
        self.stack.enter_context(patch.object(start_check, 'check', return_value=start_check.Result('started', pid=4242)))

    def status(self, box, pid, **kw):
        self.calls.append(('status', pid))
        return self.commands.get(pid)  # A foreign collision is a valid API response, not a 404.

    def kill(self, box, pid):
        self.calls.append(('kill', pid))
        if pid in self.commands:
            self.commands[pid]['running'] = False

    def row(self):
        return self.con.execute("SELECT * FROM runs WHERE run_id='run-own'").fetchone()

    def seed(self, *, pid=None, wrapper=4242, marker='start_unattached', command=None):
        self.con.execute("DELETE FROM runs WHERE run_id='run-own'")
        self.con.execute("DELETE FROM kv WHERE k LIKE '%:run-own'")
        self.con.execute("INSERT INTO runs(run_id,box_id,process_id,command_id,wrapper_pid,status,mode,start_at,client_pid) "
                         "VALUES ('run-own','bx',?,?,?,'running','bg',?,424242)",
                         (pid, command, wrapper, common.now()-400))
        if marker:
            self.con.execute('INSERT INTO kv(k,v) VALUES (?,?)', (marker+':run-own', 'bx'))
        self.con.execute("INSERT INTO kv(k,v) VALUES ('start_claim:run-own','1')")
        self.con.commit()
        self.calls.clear()
        return self.row()

    def test_settlement_matrix_keeps_namespaces_separate(self):
        for pid, command, marker in ((None, None, None), (1001, 'cmd-own', None),
                                     (4242, None, 'start_unattached'), (1002, None, 'start_unknown')):
            for verdict, code in (('started', 0), ('started', 7), ('fenced', None), ('unknown', None)):
                with self.subTest(pid=pid, verdict=verdict, code=code):
                    row = self.seed(pid=pid, command=command, marker=marker, wrapper=None)
                    start_check.settle(self.con, row, start_check.Result(verdict, code, 4242), 'test')
                    self.assertEqual(self.row()['process_id'], 1001 if command else None)
                    self.assertEqual(self.row()['wrapper_pid'], 4242)
                    self.assertEqual(self.row()['exit_code'], code)
                    self.assertFalse(self.calls)

    def test_recovered_reader_matrix_never_queries_or_kills_wrapper(self):
        routes = ('keep', 'reap-live', 'reap-stopped', 'pool', 'ended', 'follow', 'wait', 'kill')
        for backend in ('boat', 'server'):
            for wrapper in (4242, 1002):
                for legacy in (False, True):
                    for marker in ('start_unattached', 'start_unknown'):
                        for route in routes:
                            with self.subTest(backend=backend, wrapper=wrapper, legacy=legacy, marker=marker, route=route), \
                                    patch.object(api, 'BACKEND', backend):
                                row = self.seed(pid=wrapper if legacy else None, wrapper=wrapper, marker=marker)
                                receipt = start_check.Result('started', pid=wrapper)
                                with patch.object(start_check, 'check', return_value=receipt):
                                    if route == 'keep':
                                        reap._keep_live_runs(self.con, 'bx', {'state': 'running'}, False)
                                    elif route.startswith('reap'):
                                        reap._check_unlocked(self.con, 'bx', 'running' if route == 'reap-live' else 'archived', False, [])
                                    elif route == 'pool':
                                        pool._refresh_background(self.con, 'repo')
                                    elif route == 'ended':
                                        self.assertIsNone(runs._ended('bx', wrapper, None, 'run-own'))
                                    elif route in ('wait', 'follow'):
                                        with patch.object(start_check, 'check', side_effect=[receipt, start_check.Result('started', 7, wrapper)]), \
                                                patch.object(misc.time, 'sleep'), contextlib.redirect_stderr(io.StringIO()):
                                            code = (misc.wait('run-own', 10) if route == 'wait' else
                                                    runs.follow('bx', wrapper, None, run_id='run-own'))
                                        self.assertEqual(code, 7)
                                        self.assertEqual(self.row()['status'], 'failed')
                                    elif route == 'kill':
                                        with contextlib.redirect_stderr(io.StringIO()):
                                            self.assertEqual(misc.kill_run('run-own'), 1)
                                        self.assertGreater(lease.active_runs(self.con, 'bx'), 0)
                                self.assertEqual(self.calls, [])
                                self.assertTrue(self.other['running'])
                                if route in ('keep', 'pool', 'ended', 'kill', 'reap-live'):
                                    self.assertGreater(lease.active_runs(self.con, 'bx'), 0)

    def test_receipt_then_later_reap_uses_no_wrapper_api_id(self):
        self.seed(marker=None, wrapper=None)
        def stop_wait(_):
            self.assertEqual(self.row()['status'], 'running')
            self.assertIsNone(self.row()['process_id'])
            self.assertEqual(self.row()['wrapper_pid'], 4242)
            raise RuntimeError('waiter detached')
        with patch.object(misc.time, 'sleep', side_effect=stop_wait):
            with self.assertRaisesRegex(RuntimeError, 'waiter detached'):
                misc._wait_start_receipt(self.row(), None)
        # The next reaper first retains uncertainty, then picks up the actual receipt.
        reap._check_unlocked(self.con, 'bx', 'running', False, [])
        self.assertGreater(lease.active_runs(self.con, 'bx'), 0)
        with patch.object(start_check, 'check', return_value=start_check.Result('started', 0, 4242)):
            reap._check_unlocked(self.con, 'bx', 'running', False, [])
        self.assertEqual(self.row()['status'], 'done')
        self.assertEqual(lease.active_runs(self.con, 'bx'), 0)
        self.assertFalse(self.calls)

    def test_normal_reader_matrix_uses_only_real_api_id(self):
        for route in ('keep', 'reap-live', 'reap-stopped', 'pool', 'ended', 'follow-reconnect', 'follow-error', 'wait', 'kill'):
            for command in (None, 'cmd-own'):
                # The stopped-history branch only uses process status when command_id exists.
                if route == 'reap-stopped' and not command:
                    continue
                with self.subTest(route=route, command=command):
                    row = self.seed(pid=1001, marker=None, command=command)
                    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                        if route == 'keep':
                            reap._keep_live_runs(self.con, 'bx', {'state': 'running'}, False)
                        elif route.startswith('reap'):
                            reap._check_unlocked(self.con, 'bx', 'running' if route == 'reap-live' else 'archived', False, [])
                        elif route == 'pool':
                            pool._refresh_background(self.con, 'repo')
                        elif route == 'ended':
                            self.assertEqual(runs._ended('bx', 1001, None, 'run-own')['exitCode'], 0)
                        elif route.startswith('follow') or route == 'wait':
                            frames = [{'type': 'reconnect'}] if route != 'follow-error' else []
                            with patch.object(api, 'cmd_attach', side_effect=lambda *a, **kw: iter(frames)), \
                                    patch.object(runs, '_ttl_keeper'), patch.object(runs.time, 'sleep'):
                                code = (misc.wait('run-own', 10) if route == 'wait' else
                                        runs.follow('bx', 1001, None, echo=False, run_id='run-own'))
                            self.assertEqual(code, 0)
                        else:
                            self.assertEqual(misc.kill_run('run-own'), 0)
                    self.assertTrue(self.calls)
                    self.assertTrue(all(pid == 1001 for _, pid in self.calls), self.calls)
                    self.assertTrue(self.other['running'])

    def test_pool_artifact_mode_matrix_preserves_the_reservation_until_pulled(self):
        sources = (('api', 1001, 'cmd-own', None, None, 'running'),
                   ('receipt', None, None, 'start_unattached', 4242, 'running'),
                   ('legacy', 4242, None, 'start_unattached', 4242, 'running'),
                   ('collision', 1002, None, 'start_unattached', 1002, 'running'),
                   ('prior-unknown', None, None, 'start_unknown', 4242, 'infra'))
        for source, pid, command, marker, wrapper, status in sources:
            for pulls in ([], ['build/out.zip']):
                for pull_artifacts in (False, True):
                    for code in (0, 7):
                        with self.subTest(source=source, pulls=pulls, pull_artifacts=pull_artifacts, code=code):
                            self.seed(pid=pid, command=command, marker=marker, wrapper=wrapper)
                            self.con.execute('UPDATE runs SET pulls=?, status=? WHERE run_id=?',
                                             (json.dumps(pulls), status, 'run-own'))
                            self.con.commit()
                            self.commands[1001]['exitCode'] = code
                            receipt = start_check.Result('started', code, wrapper)
                            def pull(box, row, paths, **kwargs):
                                self.assertEqual((box, paths), ('bx', ['build/out.zip']))
                                self.assertEqual(self.row()['status'], status)
                                self.assertGreater(lease.active_runs(self.con, 'bx'), 0)
                            with patch.object(start_check, 'check', return_value=receipt), \
                                    patch.object(runs, 'do_pulls', side_effect=pull) as pulled, \
                                    patch.object(runs, 'settle_docker'):
                                pool._refresh_background(self.con, 'repo', pull_artifacts=pull_artifacts)
                                deferred = bool(pulls and not pull_artifacts)
                                self.assertEqual(pulled.call_count, int(bool(pulls) and pull_artifacts))
                                if deferred:
                                    self.assertEqual((self.row()['status'], self.row()['exit_code']), (status, None))
                                    self.assertGreater(lease.active_runs(self.con, 'bx'), 0)
                                    if marker:
                                        self.assertTrue(start_check.recovery_marked(self.con, self.row()))
                                    pool._refresh_background(self.con, 'repo')
                                    self.assertEqual(pulled.call_count, 1)
                            self.assertEqual((self.row()['status'], self.row()['exit_code']),
                                             ('done' if code == 0 else 'failed', code))
                            self.assertEqual(lease.active_runs(self.con, 'bx'), 0)
                            if source == 'api':
                                self.assertTrue(self.calls)
                                self.assertTrue(all(pid == 1001 for _, pid in self.calls))
                            else:
                                self.assertEqual(self.calls, [])
                                self.assertIsNone(self.row()['process_id'])
                                self.assertEqual(self.row()['wrapper_pid'], wrapper)
                            self.assertTrue(self.other['running'])

    def test_pool_without_artifact_pulls_still_handles_nonexit_receipt_verdicts(self):
        for verdict in ('fenced', 'unknown', 'started'):
            with self.subTest(verdict=verdict):
                self.seed(pid=1002)
                self.con.execute("UPDATE runs SET pulls='[\"build/out.zip\"]'")
                self.con.commit()
                with patch.object(start_check, 'check', return_value=start_check.Result(verdict, pid=4242)), \
                        patch.object(runs, 'do_pulls') as pulled:
                    pool._refresh_background(self.con, 'repo', pull_artifacts=False)
                self.assertEqual(self.row()['status'], 'lost' if verdict == 'fenced' else 'running')
                self.assertEqual(lease.active_runs(self.con, 'bx'), 0 if verdict == 'fenced' else 1)
                self.assertEqual(self.calls, [])
                self.assertIsNone(self.row()['process_id'])
                self.assertEqual(self.row()['wrapper_pid'], 4242)
                pulled.assert_not_called()

    def test_kill_rechecks_every_terminal_transition_while_acquiring_the_box_lock(self):
        for status, code, reservation in (('done', 0, 0), ('failed', 7, 0), ('killed', 143, 0),
                                           ('lost', None, 1), ('infra', None, 0), ('interrupted', 94, 0)):
            for marker in ('start_unattached', 'start_unknown'):
                with self.subTest(status=status, marker=marker):
                    self.seed(pid=4242, marker=marker)
                    @contextlib.contextmanager
                    def complete(*args, **kwargs):
                        self.con.execute('UPDATE runs SET status=?, exit_code=? WHERE run_id=?',
                                         (status, code, 'run-own'))
                        self.con.execute("DELETE FROM kv WHERE k='start_unknown:run-own'")
                        self.con.commit()
                        yield
                    with patch.object(misc, 'file_lock', side_effect=complete), \
                            patch.object(start_check, 'check') as check:
                        with self.assertRaises(common.OffboxError) as error:
                            misc.kill_run('run-own')
                    self.assertEqual(error.exception.code, 2)
                    self.assertEqual((self.row()['status'], self.row()['exit_code']), (status, code))
                    self.assertIsNone(self.con.execute("SELECT 1 FROM kv WHERE k='start_unknown:run-own'").fetchone())
                    self.assertEqual(lease.active_runs(self.con, 'bx'), reservation)
                    check.assert_not_called()
                    self.assertFalse(self.calls)

    def test_no_api_id_kill_preserves_the_current_precommand_cancellation_flow(self):
        for client in (None, 424242):
            for marker in ('start_unattached', 'start_unknown'):
                with self.subTest(client=client, marker=marker):
                    self.seed(marker=marker)
                    self.con.execute('UPDATE runs SET client_pid=? WHERE run_id=?', (client, 'run-own'))
                    self.con.commit()
                    with patch.object(start_check, 'check') as check, contextlib.redirect_stderr(io.StringIO()):
                        if client is None:
                            with self.assertRaises(common.OffboxError) as error:
                                misc.kill_run('run-own')
                            self.assertEqual(error.exception.code, 2)
                        else:
                            self.assertEqual(misc.kill_run('run-own'), 1)
                    self.assertEqual(self.row()['status'], 'running')
                    self.assertGreater(lease.active_runs(self.con, 'bx'), 0)
                    check.assert_not_called()
                    self.assertFalse(self.calls)

    def test_takeover_receipt_uses_the_already_held_box_lock(self):
        row = self.seed(pid=1002)
        with common.file_lock('box-bx'), \
                patch.object(start_check, 'check', return_value=start_check.Result('started', 7, 4242)):
            self.assertEqual(misc._resolve_exit(row, None, common.now()+5, (0, 0), None, echo=False), 7)
        self.assertFalse(self.calls)
        self.assertTrue(self.other['running'])

    def test_reconciliation_verdict_matrix_including_prior_unknown_rows(self):
        for route in ('reap', 'pool', 'wait', 'kill'):
            for status in ('running', 'infra'):
                if route == 'kill' and status == 'infra':
                    continue
                for verdict, code in (('started', 0), ('started', 7), ('fenced', None), ('unknown', None)):
                    with self.subTest(route=route, status=status, verdict=verdict, code=code):
                        self.seed(pid=1002, marker='start_unknown')
                        self.con.execute('UPDATE runs SET status=?', (status,))
                        self.con.commit()
                        result = start_check.Result(verdict, code, 4242)
                        with patch.object(start_check, 'check', return_value=result), \
                                contextlib.redirect_stderr(io.StringIO()):
                            if route == 'reap':
                                reap._check_unlocked(self.con, 'bx', 'running', False, [])
                            elif route == 'pool':
                                pool._refresh_background(self.con, 'repo')
                            elif route == 'kill':
                                self.assertEqual(misc.kill_run('run-own'), 1 if verdict == 'unknown' else 0)
                            elif verdict == 'unknown':
                                with self.assertRaises(common.OffboxError):
                                    misc.wait('run-own', 10)
                            else:
                                self.assertEqual(misc.wait('run-own', 10), code if code is not None else 90)
                        self.assertIsNone(self.row()['process_id'])
                        self.assertEqual(self.row()['wrapper_pid'], 4242)
                        self.assertEqual(self.calls, [])
                        if verdict == 'unknown':
                            self.assertGreater(lease.active_runs(self.con, 'bx'), 0)
                        else:
                            self.assertEqual(self.row()['status'], 'done' if code == 0 else 'failed' if code else 'lost')
                            self.assertEqual(lease.active_runs(self.con, 'bx'), 0)

    def test_wrapper_column_is_added_to_old_schema(self):
        self.seed(pid=4242, wrapper=None)
        self.con.execute("INSERT INTO runs(run_id,process_id,command_id) VALUES ('run-api',1001,'cmd-api')")
        self.con.execute('ALTER TABLE runs DROP COLUMN wrapper_pid')
        self.con.execute('PRAGMA user_version=2')
        self.con.commit()
        with contextlib.closing(common.db()) as upgraded:
            self.assertIn('wrapper_pid', {r[1] for r in upgraded.execute('PRAGMA table_info(runs)')})
            row = upgraded.execute("SELECT * FROM runs WHERE run_id='run-own'").fetchone()
            self.assertEqual((row['process_id'], row['wrapper_pid']), (None, 4242))
            self.assertEqual(upgraded.execute("SELECT process_id FROM runs WHERE run_id='run-api'").fetchone()[0], 1001)

    def test_hint_uses_wrapper_pid_not_api_id(self):
        self.assertIn('.ascii/processes/4242.log', start_check.hint('bx', 'run-own', 4242))
        self.assertNotIn('1001', start_check.hint('bx', 'run-own', 4242))
