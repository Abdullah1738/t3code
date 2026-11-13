"""Database safety remains distinct from home-server failures after the merge."""
import contextlib
import io
import json
from pathlib import Path
import sqlite3
import sys
from unittest.mock import patch
from types import SimpleNamespace

SCRIPTS = Path(__file__).resolve().parents[1] / 'skill/scripts'
sys.path[:0] = [str(SCRIPTS), str(SCRIPTS / 'tests')]
from offbox_lib import api, common, containers, home, lease, misc, pool, reap, runs
from test_capacity import Isolated


class DatabaseMerge(Isolated):
    def test_quarantine_uses_database_or_sidecar_handles_at_every_entry(self):
        for entry in ('foreground', 'wait', 'lost', 'pool', 'reaper'):
            for source in ('database', 'sidecar'):
                with self.subTest(entry=entry, source=source):
                    rid, bid = f'{entry}-{source}', f'wedge-{entry}-{source}'
                    self.box(bid, member=True, used=common.now())
                    log = runs.LOGS_DIR / (rid + '.log')
                    log.write_text('offbox-box-wedged: docker-info-timeout\n')
                    self.con.execute("INSERT INTO runs(run_id,box_id,status,mode,process_id,command_id,log_path,docker) "
                                     "VALUES (?,?,?,'bg',7,?,?,0)",
                                     (rid,bid,'lost' if entry == 'lost' else 'running',
                                      'command' if source == 'database' else None,str(log)))
                    if source == 'sidecar':
                        runs.save_run_state(rid, command_id='command')
                    row = self.con.execute('SELECT * FROM runs WHERE run_id=?', (rid,)).fetchone()
                    runner = SimpleNamespace(run_id=rid, box=bid, started=True, registered=True, remote_code=None,
                                             lease_row=None, recovered_code=None, log_path=log,
                                             start=lambda: None, stream=lambda: 97)
                    with patch.object(api, '_request', side_effect=AssertionError('unexpected API transport')), \
                            patch.object(api, 'get', return_value={'state':'running'}), \
                            patch.object(api, 'history_get', return_value={'exitCode':97}), \
                            patch.object(api, 'cmd_status', return_value={'status':'exited', 'exitCode':97}), \
                            patch.object(api, 'history_logs', return_value={'data':log.read_text(), 'done':True}), \
                            patch.object(lease, 'stop_box', return_value=True), \
                            patch.object(runs, 'Runner', return_value=runner), \
                            contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
                        if entry == 'foreground':
                            with self.assertRaises(runs.BoxWedged):
                                runs._run_attempt(SimpleNamespace(bg=False,pull=[],cmd=['true'],steps=[]),self.me)
                        elif entry == 'wait':
                            self.assertEqual(misc._finalize(row,97,log),common.EXIT_INFRA)
                        elif entry == 'lost':
                            runs.reconcile_lost(self.con,bid)
                        elif entry == 'pool':
                            pool._refresh_background(self.con,'repo')
                        else:
                            reap._check_unlocked(self.con,bid,'running',False,[])
                    self.assertTrue(self.con.execute('SELECT note FROM leases WHERE box_id=?', (bid,)).fetchone()[0].startswith('box-wedged:'))
                    self.assertEqual(lease.active_runs(self.con,bid),0)
                    self.assertEqual(tuple(self.con.execute('SELECT status,exit_code FROM runs WHERE run_id=?',
                                                           (rid,)).fetchone()),('infra',None))

    def test_quarantine_write_failure_stays_active_until_reaper_repairs_it(self):
        for entry in ('foreground', 'wait'):
            with self.subTest(entry=entry):
                rid, bid = 'quarantine-' + entry, 'box-' + entry
                self.box(bid, used=common.now())
                log = runs.LOGS_DIR / (rid + '.log')
                log.write_text('offbox-box-wedged: docker-info-timeout\n')
                self.con.execute("INSERT INTO runs(run_id,box_id,status,mode,process_id,command_id,log_path,docker) "
                                 "VALUES (?,?,'running','fg',7,'command',?,0)", (rid, bid, str(log)))
                row = self.con.execute('SELECT * FROM runs WHERE run_id=?', (rid,)).fetchone()
                real_set_aside = lease.set_aside
                def fail_event(con, *args, **kwargs):
                    execute = con.execute
                    def busy(sql, *params):
                        if sql.startswith('INSERT INTO events'):
                            raise sqlite3.OperationalError('database is locked')
                        return execute(sql, *params)
                    with patch.object(con, 'execute', side_effect=busy):
                        return real_set_aside(con, *args, **kwargs)
                runner = SimpleNamespace(run_id=rid, box=bid, started=True, registered=True, remote_code=None,
                                         lease_row=None, recovered_code=None, log_path=log,
                                         start=lambda: None, stream=lambda: 97)
                args = SimpleNamespace(bg=False, pull=[], cmd=['true'], steps=[])
                with patch.object(api, '_request', side_effect=AssertionError('unexpected API transport')), \
                        patch.object(api, 'history_logs', return_value={'data':log.read_text(), 'done':True}), \
                        patch.object(lease, 'set_aside', side_effect=fail_event), \
                        patch.object(lease, 'stop_box') as stop, patch.object(runs, 'Runner', return_value=runner), \
                        patch.object(runs, 'finish', wraps=runs.finish) as finish, \
                        contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
                    code = (runs._run_attempt(args, self.me) if entry == 'foreground'
                            else misc._finalize(row, 97, log))
                self.assertEqual(code, 97)
                finish.assert_not_called()
                stop.assert_not_called()
                self.assertEqual(tuple(self.con.execute('SELECT status,exit_code FROM runs WHERE run_id=?',
                                                       (rid,)).fetchone()), ('running', None))
                self.assertFalse(runs.terminal_result(runs.restore_run_state(row)))
                self.assertEqual(lease.active_runs(self.con, bid), 1)
                self.assertIsNone(self.con.execute('SELECT note FROM leases WHERE box_id=?', (bid,)).fetchone()[0])
                with patch.object(api, 'cmd_status', return_value={'status':'exited', 'exitCode':97}), \
                        patch.object(api, 'history_logs', return_value={'data':log.read_text(), 'done':True}), \
                        patch.object(lease, 'stop_box', return_value=True):
                    reap._check_unlocked(self.con, bid, 'running', False, [])
                self.assertEqual(lease.active_runs(self.con, bid), 0)
                self.assertTrue(self.con.execute('SELECT note FROM leases WHERE box_id=?', (bid,)).fetchone()[0].startswith('box-wedged:'))

    def test_lost_confirmation_recovers_sidecar_only_history_for_pool_and_reaper(self):
        for reader in ('pool', 'reaper'):
            for code in (0, 17):
                with self.subTest(reader=reader, code=code):
                    rid, bid = f'{reader}-{code}', f'history-{reader}-{code}'
                    self.box(bid, member=True, used=common.now())
                    self.con.execute("INSERT INTO runs(run_id,box_id,status,mode,docker) VALUES (?,?,'running','bg',0)", (rid,bid))
                    runs.save_run_state(rid, process_id=7, command_id='saved-command')
                    with patch.object(api, '_request', side_effect=AssertionError('unexpected API transport')), \
                            patch.object(api, 'cmd_status', return_value={'status':'lost', 'running':False}), \
                            patch.object(api, 'history_get', return_value={'exitCode':code}) as history, \
                            patch.object(runs, 'recorded_exit', side_effect=common.OffboxError('SSH unavailable')) as ssh, \
                            patch.object(misc, '_catch_up_finished'), patch.object(lease, 'touch'), patch.object(lease, 'idle_ttl'):
                        if reader == 'pool':
                            pool._refresh_background(self.con, 'repo')
                        else:
                            reap._check_unlocked(self.con, bid, 'running', False, [])
                    history.assert_called_once_with(bid, 'saved-command')
                    ssh.assert_not_called()
                    self.assertEqual(self.con.execute('SELECT exit_code FROM runs WHERE run_id=?', (rid,)).fetchone()[0], code)
                    self.assertEqual(lease.active_runs(self.con, bid), 0)

    def test_person_server_down_and_local_database_errors_have_distinct_codes(self):
        self.assertEqual(common.EXIT_HOME_DOWN, 93)
        self.assertEqual(common.EXIT_LOCAL, 96)
        with patch.object(common, 'person', return_value='moni'), \
                patch.object(common, 'home_config', return_value={'url':'https://unused.invalid/api/v1'}), \
                patch.object(common, 'backend_pinned', return_value=None), \
                patch.object(common, 'home_state', return_value={'state':'home_down'}), \
                patch.object(home, 'probe') as probe, self.assertRaises(common.OffboxError) as error:
            home.person_gate()
        self.assertEqual(error.exception.code, 93)
        probe.assert_not_called()
        local = common.local_error(sqlite3.OperationalError('database is locked'))
        self.assertEqual(local.code, 96)
        self.assertIn('nothing ran, safe to retry', str(local))

    def test_quarantine_marker_and_run_result_rollback_together(self):
        self.box('quarantine', used=common.now())
        self.con.execute("INSERT INTO runs(run_id,box_id,status) VALUES ('wedged','quarantine','running')")
        execute = self.con.execute
        def busy(sql, *args):
            if sql.startswith('INSERT INTO events'):
                raise sqlite3.OperationalError('database is locked')
            return execute(sql, *args)
        with patch.object(self.con, 'execute', side_effect=busy), \
                patch.object(lease, 'stop_box') as stop, self.assertRaises(sqlite3.OperationalError):
            lease.set_aside(self.con, 'quarantine', 'box-wedged', 'test', 'wedged')
        self.assertIsNone(self.con.execute("SELECT note FROM leases WHERE box_id='quarantine'").fetchone()[0])
        self.assertEqual(self.con.execute("SELECT status FROM runs WHERE run_id='wedged'").fetchone()[0], 'running')
        self.assertFalse(self.con.in_transaction)
        stop.assert_not_called()

    def test_quarantine_releases_writer_before_network_stop(self):
        self.box('stop', used=common.now())
        self.con.execute("INSERT INTO runs(run_id,box_id,status) VALUES ('stop-run','stop','running')")
        def stop(con, *args, **kwargs):
            self.assertFalse(con.in_transaction)
            with contextlib.closing(common.db()) as other:
                other.execute("INSERT INTO kv VALUES ('stop-probe','ok',0)")
            return True
        with patch.object(lease, 'stop_box', side_effect=stop), contextlib.redirect_stderr(io.StringIO()):
            self.assertTrue(lease.set_aside(self.con, 'stop', 'box-wedged', 'test', 'stop-run'))
        self.assertEqual(self.con.execute("SELECT v FROM kv WHERE k='stop-probe'").fetchone()[0], 'ok')

    def test_container_receipt_and_event_rollback_together_after_network(self):
        self.con.execute("INSERT INTO runs(run_id,box_id,status) VALUES ('containers','box','killed')")
        self.con.execute("INSERT INTO kv(k,v) VALUES ('containers_expected:containers','1')")
        row = self.con.execute("SELECT * FROM runs WHERE run_id='containers'").fetchone()
        execute = self.con.execute
        def busy(sql, *args):
            if sql.startswith('INSERT INTO events'):
                raise sqlite3.OperationalError('database is locked')
            return execute(sql, *args)
        def ssh(*args, **kwargs):
            self.assertFalse(self.con.in_transaction)
            with contextlib.closing(common.db()) as other:
                other.execute("INSERT INTO kv VALUES ('receipt-probe','ok',0)")
            return SimpleNamespace(returncode=0, stdout=json.dumps({'initial':['old'], 'left':[], 'post_checked':True}))
        with patch.object(self.con, 'execute', side_effect=busy), patch.object(containers.ssh_sync, 'ssh', side_effect=ssh):
            containers.record(self.con, row, '')
        self.assertFalse(self.con.in_transaction)
        self.assertFalse(self.con.execute("SELECT 1 FROM kv WHERE k LIKE 'containers_%recorded:%'").fetchone())
        self.assertEqual(self.con.execute("SELECT v FROM kv WHERE k='receipt-probe'").fetchone()[0], 'ok')

    def test_unknown_box_reconciliation_does_not_reopen_a_concurrent_known_result(self):
        self.box('reconcile', used=common.now())
        self.con.execute("INSERT INTO runs(run_id,box_id,status,docker) VALUES ('known','reconcile','lost',0)")
        def unreachable(*args, **kwargs):
            runs.finish('known', 17, 'lost', catch_up=False)
            raise common.OffboxError('unavailable')
        with patch.object(api, 'get', side_effect=unreachable), patch.object(lease, 'touch'), patch.object(lease, 'idle_ttl'):
            runs.reconcile_lost(self.con, 'reconcile')
        row = self.con.execute("SELECT status,exit_code,end_at FROM runs WHERE run_id='known'").fetchone()
        self.assertEqual(tuple(row)[:2], ('lost', 17))
        self.assertIsNotNone(row['end_at'])

    def test_home_reaper_skips_other_person_no_box_cleanup(self):
        for mode in ('local', 'bg'):
            self.con.execute("INSERT INTO runs(run_id,owner,repo_root,status,mode,start_at,client_pid) "
                             "VALUES (?,'person:moni','/person/moni','starting',?,?,-1)",
                             (mode, mode, common.now()-8*3600))
        with patch.object(common, '_BACKEND', 'server'), patch.object(common, 'token_owner', return_value='ardud'), \
                patch.object(api, 'list_boxes', return_value=[]), patch.object(runs, 'restore_run_state') as restore:
            reap._reap(self.con, False, [])
        self.assertEqual([r[0] for r in self.con.execute('SELECT status FROM runs')], ['starting', 'starting'])
        restore.assert_not_called()
