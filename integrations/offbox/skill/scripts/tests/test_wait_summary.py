"""A CLI waiter leaves enough evidence in a bounded background-completion notification."""
import contextlib
import io
from pathlib import Path
import sqlite3
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, cli, common, home, lease, misc, runs
from test_capacity import Isolated


class WaitSummaryTests(Isolated):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(misc, '_require_my_run'))
        self.stack.enter_context(patch.object(misc, '_catch_up_log', return_value='complete'))
        self.stack.enter_context(patch.object(lease, 'touch'))
        self.stack.enter_context(patch.object(lease, 'idle_ttl'))
        self.stack.enter_context(patch.object(runs, 'settle_docker'))
        self.stack.enter_context(patch.object(api, 'call', side_effect=AssertionError('no live API')))
        self.stack.enter_context(patch('offbox_lib.identity.whoami', return_value=self.me))
        self.stack.enter_context(patch.object(home, 'person_gate'))
        self.con.execute("INSERT INTO runs(run_id,box_id,process_id,status,mode,exit_code,pulls) "
                         "VALUES ('run-proof','bx_a',7,'done','bg',0,'[]')")
        self.con.commit()
        self.path = common.LOGS_DIR / 'run-proof.log'
        self.path.write_text('checks passed\n')

    def invoke(self, timeout=None):
        output, error = io.StringIO(), io.StringIO()
        args = ['wait', 'run-proof'] + ([] if timeout is None else ['--timeout', str(timeout)])
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
            code = cli.main(args)
        return code, output.getvalue(), error.getvalue()

    def test_cli_summary_exit_matrix_on_both_backends(self):
        for backend in ('server', 'boat'):
            for code, status in ((0, 'done'), (7, 'failed'), (94, 'interrupted'), (130, 'killed')):
                with self.subTest(backend=backend, code=code), patch.object(api, 'BACKEND', backend):
                    self.con.execute('UPDATE runs SET status=?,exit_code=?', (status, code))
                    self.con.commit()
                    Path(str(self.path) + '.delivered').unlink(missing_ok=True)
                    actual, output, _ = self.invoke()
                    self.assertEqual(actual, code)
                    self.assertIn(f'run-proof: backend={backend} exit={code} log={self.path}', output)
                    self.assertIn('Output tail:\nchecks passed', output)
                    self.assertNotIn('checks passed', self.invoke()[1])

    def test_success_preview_is_bounded_and_retains_latest_lines(self):
        self.path.write_text('old output\n' * 10000 + 'x' * 4000 + '\nlatest result\n')
        code, output, _ = self.invoke()
        self.assertEqual(code, 0)
        self.assertLess(len(output), 1000)
        self.assertNotIn('old output', output)
        self.assertTrue(output.endswith('latest result\n'))
        self.assertEqual(common.delivered_bytes(self.path), self.path.stat().st_size)

    def test_unavailable_log_does_not_change_exit(self):
        for missing in (True, False):
            with self.subTest(missing=missing):
                if missing:
                    self.path.unlink(missing_ok=True)
                else:
                    self.path.touch()
                code, output, _ = self.invoke()
                self.assertEqual(code, 0)
                self.assertIn('exit=0 log=', output)
                self.assertNotIn('Output tail:', output)

    def test_timeout_does_not_print_a_completion_summary(self):
        self.con.execute("UPDATE runs SET status='running',exit_code=NULL")
        self.con.commit()
        with patch.object(misc, '_wait_locked', side_effect=common.OffboxError('still running', code=124)):
            code, output, _ = self.invoke(540)
        self.assertEqual((code, output), (124, ''))

    def test_one_wait_covers_queue_and_settlement(self):
        self.con.execute("UPDATE runs SET status='starting',box_id=NULL,process_id=NULL,exit_code=NULL")
        self.con.commit()
        def settle(_seconds):
            self.path.write_text('queued check passed\n')
            self.con.execute("UPDATE runs SET status='done',box_id='bx_a',process_id=7,exit_code=0")
            self.con.commit()
        with patch.object(misc, '_client_alive', return_value=True), \
                patch.object(misc.time, 'sleep', side_effect=settle) as pause:
            code, output, error = self.invoke()
        pause.assert_called_once()
        self.assertEqual(code, 0)
        self.assertIn('waiting for a box', error)
        self.assertIn('exit=0 log=', output)
        self.assertIn('queued check passed', output)

    def test_home_restart_during_follow_keeps_exit_94(self):
        self.con.execute("UPDATE runs SET status='running',exit_code=NULL")
        self.con.commit()
        def interrupted(*args, **kwargs):
            raise runs.Interrupted('run-proof', {'status': 'interrupted', 'interruption': {'cause': 'host_restart'}})
        with patch.object(misc, '_wait_locked', side_effect=interrupted), patch.object(api, 'BACKEND', 'server'):
            code, output, error = self.invoke()
        self.assertEqual(code, 94)
        self.assertIn('backend=server exit=94', output)
        self.assertIn('command ran partly', error)

    def test_post_result_db_failure_does_not_replace_known_exit(self):
        original = misc._run_row
        calls = 0
        def row(run_id):
            nonlocal calls
            calls += 1
            if calls > 1:
                raise sqlite3.OperationalError('state unavailable')
            return original(run_id)
        with patch.object(misc, '_run_row', side_effect=row):
            code, output, _ = self.invoke()
        self.assertEqual(code, 0)
        self.assertIn('exit=0 log=', output)

    def test_forwarded_wait_does_not_add_a_wrong_backend_summary(self):
        self.con.execute("UPDATE runs SET status='forwarded',error='boat'")
        self.con.commit()
        with patch.object(misc, '_follow_forwarded', return_value=7):
            code, output, _ = self.invoke()
        self.assertEqual((code, output), (7, ''))
