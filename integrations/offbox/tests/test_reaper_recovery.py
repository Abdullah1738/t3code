"""Saved results must survive the reaper's top-level cleanup decisions."""
import contextlib
import io
from pathlib import Path
import sys
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'skill/scripts'
sys.path.insert(0, str(SCRIPTS))
from offbox_lib import api, common, lease, misc, reap, runs
if __package__:
    from .client_fixtures import Isolated
else:
    from client_fixtures import Isolated


RESULTS = [('done', 0), ('failed', 17), ('local_error', 96), ('killed', 130), ('infra', 90), ('busy', 92)]


class ReaperRecovery(Isolated):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(misc, '_catch_up_log', return_value='complete'))
        for module, name in ((api, 'call'), (api, 'stream'), (lease.ssh_sync, 'ssh')):
            transport = self.stack.enter_context(patch.object(
                module, name, side_effect=AssertionError(f'unexpected external transport: {name}')))
            self.addCleanup(transport.assert_not_called)

    def pending_result(self, rid, status, code, *, box=None, mode='bg', age=0):
        self.con.execute("INSERT INTO runs(run_id,box_id,status,mode,process_id,client_pid,start_at,docker) "
                         "VALUES (?,?,'starting',?,?,123,?,0)",
                         (rid, box, mode, 7 if box else None, common.now() - age))
        self.con.execute('BEGIN IMMEDIATE')
        try:
            with patch.object(common, 'DB_TIMEOUT', .001), patch.object(common.time, 'sleep'), \
                    contextlib.redirect_stderr(io.StringIO()):
                runs.finish(rid, code, status)
        finally:
            self.con.rollback()
        self.assertEqual(self.result(rid), ('starting', None))
        self.assertTrue((runs.LOGS_DIR / f'{rid}.state.json').exists())
        (runs.LOGS_DIR / f'{rid}.log').write_text('fixture output\n')

    def result(self, rid):
        return tuple(self.con.execute('SELECT status,exit_code FROM runs WHERE run_id=?', (rid,)).fetchone())

    def test_top_level_cleanup_preserves_saved_results(self):
        # Every cleanup entry point must honor the same set of terminal records.
        for branch in ('local', 'old-no-box', 'dead-client', 'gone-box', 'expired-box', 'stopped-box'):
            for status, code in RESULTS:
                with self.subTest(branch=branch, status=status):
                    rid = f'{branch}-{status}'
                    box = rid if branch in ('gone-box', 'expired-box', 'stopped-box') else None
                    if box:
                        self.box(box, member=True, used=common.now())
                    self.pending_result(rid, status, code, box=box,
                                        mode='local' if branch == 'local' else 'bg',
                                        age=7 * 3600 if branch in ('local', 'old-no-box') else 0)
                    remote = None if branch == 'gone-box' or not box else {'id':box, 'state':'archived'}
                    if branch == 'expired-box':
                        remote['dataExpiredAt'] = '2026-11-01T00:00:00Z'
                    with patch.object(api, 'list_boxes', return_value=[remote] if remote else []), \
                            patch.object(api, 'get', return_value=remote), patch.object(api, 'cmd_status') as probe, \
                            patch.object(misc, '_client_alive', return_value=False), \
                            patch.object(lease, 'touch'), patch.object(lease, 'idle_ttl'):
                        actions = reap._reap(self.con, False, [])
                    self.assertEqual(self.result(rid), (status, code), actions)
                    if box:
                        self.assertEqual(lease.active_runs(self.con, box), 0)
                    probe.assert_not_called()

    def test_wait_repairs_lost_placeholder_from_saved_result(self):
        for status, code in RESULTS:
            for reader in ('wait', 'logs', 'reap'):
                with self.subTest(status=status, reader=reader):
                    rid = f'lost-{status}-{reader}'
                    self.pending_result(rid, status, code)
                    self.con.execute("UPDATE runs SET status='lost', end_at=? WHERE run_id=?", (common.now(), rid))
                    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                        if reader == 'wait':
                            self.assertEqual(misc.wait(rid, None), code)
                        elif reader == 'logs':
                            # #84 s8: no box/process means killed while queued, even after saved-state repair.
                            self.assertEqual(misc.logs(rid, False), 130 if status == 'killed' else 0)
                        else:
                            with patch.object(api, 'list_boxes', return_value=[]):
                                reap._reap(self.con, False, [])
                    self.assertEqual(self.result(rid), (status, code))

    def test_finish_does_not_replace_a_settled_result_or_unknown_lost_result(self):
        for status, code in RESULTS + [('lost', 17), ('lost', None)]:
            with self.subTest(status=status, code=code):
                rid = f'settled-{status}-{code}'
                self.con.execute('INSERT INTO runs(run_id,status,exit_code) VALUES (?,?,?)', (rid, status, code))
                runs.finish(rid, 0 if code is not None else None)
                self.assertEqual(self.result(rid), (status, code))

    def test_settled_database_result_wins_over_conflicting_recovery(self):
        for status, code in RESULTS + [('lost', 17)]:
            for saved_status, saved_code in RESULTS:
                with self.subTest(status=status, saved_status=saved_status):
                    rid = f'conflict-{status}-{saved_status}'
                    self.con.execute('INSERT INTO runs(run_id,status,exit_code,end_at) VALUES (?,?,?,10)',
                                     (rid, status, code))
                    runs.save_run_state(rid, status=saved_status, exit_code=saved_code, end_at=20,
                                        box_id='saved-box', process_id=7, command_id='saved-command')
                    row = self.con.execute('SELECT * FROM runs WHERE run_id=?', (rid,)).fetchone()
                    restored = runs.restore_run_state(row)
                    self.assertEqual((restored['status'], restored['exit_code'], restored['end_at']), (status, code, 10))
                    self.assertEqual((restored['box_id'], restored['process_id'], restored['command_id']),
                                     ('saved-box', 7, 'saved-command'))
                    with contextlib.redirect_stdout(io.StringIO()):
                        self.assertEqual(misc.wait(rid, None), code)
                    self.assertEqual(self.result(rid), (status, code))

    def test_kill_finish_contention_keeps_concurrent_committed_exit(self):
        self.box('kill-race', used=common.now())
        for code in (0, 17):
            with self.subTest(code=code):
                rid = f'kill-race-{code}'
                self.con.execute("INSERT INTO runs(run_id,box_id,status,mode,process_id,docker) "
                                 "VALUES (?,'kill-race','running','fg',7,0)", (rid,))
                def finish_during_kill(box, pid):
                    # kill_run already read the running row, but the foreground finisher wins before its reply.
                    runs.finish(rid, code)
                    self.assertEqual(self.result(rid), ('done' if code == 0 else 'failed', code))
                    self.con.execute('BEGIN IMMEDIATE')
                    return {}
                try:
                    with patch.object(api, 'cmd_kill', side_effect=finish_during_kill) as kill, \
                            patch.object(api, 'cmd_status', return_value={'running':False, 'exitCode':143}), \
                            patch.object(common, 'DB_TIMEOUT', .001), patch.object(common.time, 'sleep'), \
                            patch.object(lease, 'touch'), patch.object(lease, 'idle_ttl'), \
                            contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                        self.assertEqual(misc.kill_run(rid), 0)
                        kill.assert_called_once_with('kill-race', 7)
                        saved = common.read_json(runs.LOGS_DIR / f'{rid}.state.json', {})
                        self.assertEqual((saved['status'], saved['exit_code']), ('killed', 143))
                finally:
                    self.con.rollback()
                for _ in range(2):
                    with contextlib.redirect_stdout(io.StringIO()):
                        self.assertEqual(misc.wait(rid, None), code)
                self.assertEqual(self.result(rid), ('done' if code == 0 else 'failed', code))
                self.assertEqual(lease.active_runs(self.con, 'kill-race'), 0)

    def test_top_level_recovery_dry_run_does_not_write(self):
        self.pending_result('dry-result', 'local_error', 96, age=3 * 3600)
        with patch.object(api, 'list_boxes', return_value=[]):
            actions = reap._reap(self.con, True, [])
        self.assertEqual(self.result('dry-result'), ('starting', None))
        self.assertTrue(any('would repair' in line and 'dry-result' in line for line in actions), actions)
        self.assertFalse(any('lost' in line and 'dry-result' in line for line in actions), actions)
