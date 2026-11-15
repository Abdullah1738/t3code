"""Pull messages and events belong to the run whose worktree receives the files. Offline."""
import json
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, common, lease, misc, pool, reap, runs, ssh_sync, start_check
from test_capacity import Isolated


class PullAttributionTests(Isolated):
    def setUp(self):
        super().setUp()
        self.row = dict(run_id='run-owner', box_id='bx_owner', remote_dir='w/owner',
                        rel_cwd='nested', local_cwd=str(Path(self.tmp.name) / 'owner' / 'nested'))
        self.path = 'artifacts/out.json'

    def events(self):
        return [tuple(row) for row in self.con.execute(
            "SELECT box_id,kind,detail FROM events WHERE kind IN ('run_pulled','run_pull_failed')")]

    def seed_run(self):
        self.con.execute("""INSERT OR REPLACE INTO runs
            (run_id,box_id,status,mode,process_id,pulls,remote_dir,rel_cwd,local_cwd,start_at)
            VALUES (:run_id,:box_id,'running','bg',42,:pulls,:remote_dir,:rel_cwd,:local_cwd,0)""",
                         {**self.row, 'pulls': json.dumps([self.path])})
        self.con.commit()
        return dict(self.con.execute("SELECT * FROM runs WHERE run_id='run-owner'").fetchone())

    def test_own_and_foreign_result_messages_and_events(self):
        cases = [
            ({'ok': True, 'files': 2}, 'run_pulled', 'files=2',
             f'pulled {self.path} (2 files)',
             f'settled background run run-owner (not this run) and pulled {self.path} '
             f'into {self.row["local_cwd"]} (2 files)'),
            ({'ok': False, 'error': 'permission denied'}, 'run_pull_failed', 'error=permission denied',
             f'pull {self.path} failed: permission denied',
             f'settled background run run-owner (not this run): pull {self.path} '
             f'into {self.row["local_cwd"]} failed: permission denied'),
            ({'ok': False, 'missing': True, 'error': 'No such file'}, 'run_pull_failed',
             'error=not created on the box: No such file',
             f'pull {self.path}: not created on the box',
             f'settled background run run-owner (not this run): pull {self.path} '
             f'into {self.row["local_cwd"]}: not created on the box'),
        ]
        for foreign in (False, True):
            for result, kind, suffix, own_line, foreign_line in cases:
                with self.subTest(foreign=foreign, result=result):
                    self.con.execute('DELETE FROM events')
                    self.con.commit()
                    log = common.LOGS_DIR / 'run-owner.log'
                    log.write_text('remote command output\n')
                    with patch.object(ssh_sync, 'pull', return_value=result) as pull, \
                            patch.object(runs, 'say') as say:
                        runs.do_pulls('bx_owner', self.row, [self.path], foreign=foreign)
                    pull.assert_called_once_with('bx_owner', 'w/owner', 'nested', self.path,
                                                 Path(self.row['local_cwd']))
                    say.assert_called_once_with(foreign_line if foreign else own_line)
                    detail = f'run-owner {self.path} -> {self.row["local_cwd"]} {suffix}'
                    self.assertEqual(self.events(), [('bx_owner', kind, detail)])
                    self.assertEqual(log.read_text(), 'remote command output\n')

    def test_raised_pull_failures_are_recorded_and_propagated(self):
        for foreign in (False, True):
            for error in (common.OffboxError('ssh unavailable'), OSError('rsync missing'),
                          subprocess.TimeoutExpired('rsync', 1)):
                with self.subTest(foreign=foreign, error=error):
                    self.con.execute('DELETE FROM events')
                    self.con.commit()
                    with patch.object(ssh_sync, 'pull', side_effect=error), patch.object(runs, 'say') as say:
                        with self.assertRaises(type(error)) as raised:
                            runs.do_pulls('bx_owner', self.row, [self.path], foreign=foreign)
                    self.assertIs(raised.exception, error)
                    self.assertEqual(self.events(), [('bx_owner', 'run_pull_failed',
                        f'run-owner {self.path} -> {self.row["local_cwd"]} error={error}')])
                    if foreign:
                        say.assert_called_once_with(
                            f'settled background run run-owner (not this run): pull {self.path} '
                            f'into {self.row["local_cwd"]} failed: {error}')
                    else:
                        say.assert_not_called()

    def test_timeout_keeps_wait_exit_code_and_records_failed_pull(self):
        with patch.object(runs, 'now', return_value=10), \
                patch.object(ssh_sync, 'pull', side_effect=subprocess.TimeoutExpired('rsync', 1)) as pull:
            with self.assertRaises(common.OffboxError) as raised:
                runs.do_pulls('bx_owner', self.row, [self.path], until=11)
        self.assertEqual(raised.exception.code, common.EXIT_WAIT_TIMEOUT)
        self.assertTrue(raised.exception.started)
        self.assertEqual(pull.call_args.kwargs, {'timeout': 1})
        self.assertEqual(self.events()[0][:2], ('bx_owner', 'run_pull_failed'))

    def test_each_pull_records_its_own_result(self):
        with patch.object(ssh_sync, 'pull', side_effect=[{'ok': True, 'files': 1},
                                                      {'ok': False, 'error': 'denied'}]), \
                patch.object(runs, 'say'):
            runs.do_pulls('bx_owner', self.row, ['one', 'two'])
        self.assertEqual([(row[1], row[2].split()[1]) for row in self.events()],
                         [('run_pulled', 'one'), ('run_pull_failed', 'two')])

    def test_pool_and_reaper_settle_foreign_pulls(self):
        self.box('bx_owner', member=True)
        self.seed_run()
        for caller in ('pool', 'reaper'):
            with self.subTest(caller=caller):
                with patch.object(api, 'cmd_status', return_value=dict(running=False, status='exited', exitCode=0)), \
                        patch.object(runs, 'do_pulls') as pull, patch.object(runs, 'finish'), \
                        patch.object(runs, 'settle_docker'), patch.object(lease, 'idle_ttl'), \
                        patch.object(misc, '_catch_up_finished'):
                    if caller == 'pool':
                        pool._refresh_background(self.con, 'repo')
                    else:
                        reap._check_unlocked(self.con, 'bx_owner', 'running', False, [])
                pull.assert_called_once()
                args, kwargs = pull.call_args
                self.assertEqual((args[0], args[1]['run_id'], args[1]['local_cwd'], args[2]),
                                 ('bx_owner', 'run-owner', self.row['local_cwd'], [self.path]))
                self.assertEqual(kwargs, {'foreign': True})

    def test_start_settlement_forwards_foreign_and_defaults_to_own(self):
        for foreign in (False, True):
            with self.subTest(foreign=foreign):
                row = self.seed_run()
                with patch.object(runs, 'do_pulls') as pull, patch.object(misc, '_catch_up_finished'), \
                        patch.object(runs, 'emit_terminal'):
                    opts = {'foreign': True} if foreign else {}
                    start_check.settle(self.con, row, start_check.Result('started', 0, 42), 'test', **opts)
                pull.assert_called_once_with('bx_owner', row, [self.path], until=None, foreign=foreign)

    def test_recovered_lost_run_forwards_foreign_and_defaults_to_own(self):
        for foreign in (False, True):
            with self.subTest(foreign=foreign):
                self.seed_run()
                self.con.execute("UPDATE runs SET status='lost' WHERE run_id='run-owner'")
                self.con.commit()
                with patch.object(runs, 'confirmed_lost', return_value=dict(status='exited', exitCode=0)), \
                        patch.object(runs, 'do_pulls') as pull, patch.object(runs, 'finish', return_value=0), \
                        patch.object(runs, 'settle_docker'), patch.object(misc, '_catch_up_finished'):
                    opts = {'foreign': True} if foreign else {}
                    runs.reconcile_lost(self.con, 'bx_owner', state='running', **opts)
                self.assertEqual(pull.call_args.kwargs, {'until': None, 'foreign': foreign})

    def test_pool_and_reaper_mark_recovery_calls_foreign(self):
        self.box('bx_owner', member=True)
        for caller in ('pool', 'reaper'):
            with self.subTest(caller=caller):
                self.seed_run()
                self.con.execute("UPDATE runs SET process_id=NULL WHERE run_id='run-owner'")
                self.con.execute("INSERT OR REPLACE INTO kv(k,v) VALUES ('start_unattached:run-owner','bx_owner')")
                self.con.commit()
                with patch.object(start_check, 'check', return_value=start_check.Result('started', 0, 42)), \
                        patch.object(start_check, 'settle') as settle, patch.object(runs, 'reconcile_lost') as lost, \
                        patch.object(misc, '_client_alive', return_value=False):
                    if caller == 'pool':
                        pool._refresh_background(self.con, 'repo')
                    else:
                        reap._check_unlocked(self.con, 'bx_owner', 'running', False, [])
                settle.assert_called_once()
                self.assertIs(settle.call_args.kwargs['foreign'], True)
                lost.assert_called_once()
                self.assertIs(lost.call_args.kwargs['foreign'], True)
