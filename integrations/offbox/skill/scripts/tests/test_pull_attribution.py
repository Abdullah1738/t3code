"""Pull messages and events belong to the run whose worktree receives the files. Offline."""
import contextlib
import json
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, common, lease, misc, pool, pulls, reap, runs, ssh_sync, start_check
from test_capacity import Isolated


class PullAttributionTests(Isolated):
    def setUp(self):
        super().setUp()
        self.row = dict(run_id='run-owner', box_id='bx_owner', remote_dir='w/owner',
                        rel_cwd='nested', local_cwd=str(Path(self.tmp.name) / 'owner' / 'nested'))
        Path(self.row['local_cwd']).mkdir(parents=True)
        self.path = 'artifacts/out.json'

    def events(self):
        return [tuple(row) for row in self.con.execute(
            "SELECT box_id,kind,detail FROM events WHERE kind IN ('run_pulled','run_pull_failed')")]

    def seed_run(self):
        self.con.execute("""INSERT OR REPLACE INTO runs
            (run_id,box_id,status,mode,process_id,pulls,remote_dir,rel_cwd,local_cwd,start_at)
            VALUES (:run_id,:box_id,'running','bg',42,:pulls,:remote_dir,:rel_cwd,:local_cwd,0)""",
                         {**self.row, 'pulls': json.dumps([self.path])})
        for suffix in ('pulls.jsonl', 'log'):
            (common.LOGS_DIR / f'run-owner.{suffix}').unlink(missing_ok=True)
        pulls.record_baseline('run-owner', Path(self.row['local_cwd']), [self.path])
        return dict(self.con.execute("SELECT * FROM runs WHERE run_id='run-owner'").fetchone())

    def test_own_and_foreign_result_messages_and_events(self):
        cases = [
            ({'ok': True, 'files': 1}, 'run_pulled', 'files=1',
             f'run-owner: pulled {self.path} (1 files)',
             f'settled background run run-owner (not this run) and pulled {self.path} '
             f'into {self.row["local_cwd"]} (1 files)'),
            ({'ok': False, 'error': 'permission denied'}, 'run_pull_failed', 'error=permission denied',
             f'run-owner: pull {self.path} failed: permission denied',
             f'settled background run run-owner (not this run): pull {self.path} '
             f'into {self.row["local_cwd"]} failed: permission denied'),
            ({'ok': False, 'missing': True, 'error': 'No such file'}, 'run_pull_failed', 'error=not created on the box: No such file',
             f'run-owner: pull {self.path}: not created on the box',
             f'settled background run run-owner (not this run): pull {self.path} '
             f'into {self.row["local_cwd"]}: not created on the box'),
        ]
        for foreign in (False, True):
            for result, kind, suffix, own_line, foreign_line in cases:
                with self.subTest(foreign=foreign, result=result):
                    self.seed_run()
                    self.con.execute('DELETE FROM events')
                    def transfer(box, remote, rel, path, stage, **opts):
                        target = stage / path
                        target.parent.mkdir(parents=True)
                        target.write_text('{}')
                        return result
                    with patch.object(ssh_sync, 'pull', side_effect=transfer) as pull, patch.object(common, 'say') as say:
                        runs.settle_pulls('run-owner', 'refresh' if foreign else 'wait', foreign=foreign)
                    args, kwargs = pull.call_args
                    self.assertEqual(args[:4], ('bx_owner', 'w/owner', 'nested', self.path))
                    self.assertNotEqual(args[4], Path(self.row['local_cwd']))
                    self.assertEqual(kwargs, {'relative': True})
                    self.assertIn((foreign_line if foreign else own_line,), [call.args for call in say.call_args_list])
                    detail = f'run-owner {self.path} -> {self.row["local_cwd"]} {suffix}'
                    self.assertEqual(self.events(), [('bx_owner', kind, detail)])
                    (common.LOGS_DIR / 'run-owner.log').write_text('command output\n')
                    pulls.footer('run-owner')
                    self.assertIn('pull_end', (common.LOGS_DIR / 'run-owner.log').read_text())

    def test_raised_pull_failures_are_recorded_without_losing_command_exit(self):
        for foreign in (False, True):
            for error in (common.OffboxError('ssh unavailable'), OSError('rsync missing'),
                          subprocess.TimeoutExpired('rsync', 1)):
                with self.subTest(foreign=foreign, error=error):
                    self.seed_run()
                    self.con.execute('DELETE FROM events')
                    self.con.execute("UPDATE runs SET status='failed',exit_code=7")
                    with patch.object(ssh_sync, 'pull', side_effect=error), patch.object(common, 'say'):
                        runs.settle_pulls('run-owner', 'reap' if foreign else 'wait', foreign=foreign)
                    row = self.con.execute("SELECT * FROM runs WHERE run_id='run-owner'").fetchone()
                    self.assertEqual((row['exit_code'], row['pull_state']), (7, 'failed'))
                    self.assertEqual(self.events()[0][:2], ('bx_owner', 'run_pull_failed'))
                    self.assertIn(str(error), self.events()[0][2])

    def test_pool_and_reaper_settle_foreign_pulls(self):
        self.box('bx_owner', member=True)
        for caller in ('pool', 'reaper'):
            with self.subTest(caller=caller), contextlib.ExitStack() as stack:
                self.seed_run()
                stack.enter_context(patch.object(api, 'cmd_status', return_value=dict(running=False, status='exited', exitCode=0)))
                pull = stack.enter_context(patch.object(runs, 'settle_pulls', return_value=True))
                stack.enter_context(patch.object(runs, 'finish'))
                stack.enter_context(patch.object(runs, 'settle_docker'))
                stack.enter_context(patch.object(lease, 'idle_ttl'))
                stack.enter_context(patch.object(misc, '_catch_up_finished'))
                if caller == 'pool':
                    pool._refresh_background(self.con, 'repo')
                else:
                    reap._check_unlocked(self.con, 'bx_owner', 'running', False, [])
                pull.assert_called_once_with('run-owner', 'refresh' if caller == 'pool' else 'reap', foreign=True)

    def test_start_settlement_routes_foreign_claim_or_wait(self):
        for foreign in (False, True):
            with self.subTest(foreign=foreign), contextlib.ExitStack() as stack:
                row = self.seed_run()
                claim = stack.enter_context(patch.object(runs, 'settle_pulls', return_value=True))
                wait = stack.enter_context(patch.object(pulls, 'wait'))
                stack.enter_context(patch.object(misc, '_catch_up_finished'))
                stack.enter_context(patch.object(runs, 'emit_terminal'))
                start_check.settle(self.con, row, start_check.Result('started', 0, 42), 'test',
                                   foreign=foreign, role='reap' if foreign else 'wait')
                if foreign:
                    claim.assert_called_once_with('run-owner', 'reap', until=None, foreign=True)
                    wait.assert_not_called()
                else:
                    wait.assert_called_once_with('run-owner', 'wait', until=None)
                    claim.assert_not_called()

    def test_recovered_lost_run_routes_foreign_claim_or_wait(self):
        for foreign in (False, True):
            with self.subTest(foreign=foreign), contextlib.ExitStack() as stack:
                self.seed_run()
                self.con.execute("UPDATE runs SET status='lost' WHERE run_id='run-owner'")
                stack.enter_context(patch.object(runs, 'confirmed_lost', return_value=dict(status='exited', exitCode=0)))
                claim = stack.enter_context(patch.object(runs, 'settle_pulls', return_value=True))
                wait = stack.enter_context(patch.object(pulls, 'wait'))
                stack.enter_context(patch.object(runs, 'finish', return_value=0))
                stack.enter_context(patch.object(runs, 'settle_docker'))
                stack.enter_context(patch.object(misc, '_catch_up_finished'))
                runs.reconcile_lost(self.con, 'bx_owner', state='running', foreign=foreign,
                                    role='refresh' if foreign else 'wait')
                if foreign:
                    claim.assert_called_once_with('run-owner', 'refresh', until=None, foreign=True)
                else:
                    wait.assert_called_once_with('run-owner', 'wait', until=None)

    def test_pool_and_reaper_mark_recovery_calls_foreign(self):
        self.box('bx_owner', member=True)
        for caller in ('pool', 'reaper'):
            with self.subTest(caller=caller), contextlib.ExitStack() as stack:
                self.seed_run()
                self.con.execute("UPDATE runs SET process_id=NULL WHERE run_id='run-owner'")
                self.con.execute("INSERT OR REPLACE INTO kv(k,v) VALUES ('start_unattached:run-owner','bx_owner')")
                stack.enter_context(patch.object(start_check, 'check', return_value=start_check.Result('started', 0, 42)))
                settle = stack.enter_context(patch.object(start_check, 'settle'))
                lost = stack.enter_context(patch.object(runs, 'reconcile_lost'))
                stack.enter_context(patch.object(misc, '_client_alive', return_value=False))
                if caller == 'pool':
                    pool._refresh_background(self.con, 'repo')
                else:
                    reap._check_unlocked(self.con, 'bx_owner', 'running', False, [])
                settle.assert_called_once()
                self.assertIs(settle.call_args.kwargs['foreign'], True)
                self.assertEqual(settle.call_args.kwargs['role'], 'refresh' if caller == 'pool' else 'reap')
                lost.assert_called_once()
                self.assertIs(lost.call_args.kwargs['foreign'], True)
