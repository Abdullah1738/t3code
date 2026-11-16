"""Run identities survive retries without escaping their invocation or test fixture."""
import contextlib
import io
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import cli, common, home, identity, runs
from test_capacity import Isolated


class FixtureIdentityTests(unittest.TestCase):
    def test_isolation_clears_inherited_identity_and_restores_it_after_success_or_error(self):
        for fail in (False, True):
            with self.subTest(fail=fail), patch.dict(os.environ, {
                    runs.BACKGROUND_RUN_ENV: 'outer-background', home.RUN_ID_ENV: 'outer-preflight'}):
                token = home.INVOCATION_RUN.set('outer-context')
                self.addCleanup(home.INVOCATION_RUN.reset, token)

                class Probe(Isolated):
                    def runTest(probe):
                        probe.assertNotIn(runs.BACKGROUND_RUN_ENV, os.environ)
                        probe.assertNotIn(home.RUN_ID_ENV, os.environ)
                        probe.assertEqual(home.INVOCATION_RUN.get(), '')
                        args = cli.build_parser().parse_args(['run', '--', 'true'])
                        with patch.object(runs, 'new_id', side_effect=['fresh-first', 'fresh-second']):
                            for expected in ('fresh-first', 'fresh-second'):
                                runner = runs.Runner(args, probe.me)
                                runner.register_pending()
                                probe.assertEqual(runner.run_id, expected)
                        os.environ[runs.BACKGROUND_RUN_ENV] = 'leaked-background'
                        os.environ[home.RUN_ID_ENV] = 'leaked-preflight'
                        home.INVOCATION_RUN.set('leaked-context')
                        if fail:
                            raise RuntimeError('fixture aborted')

                result = unittest.TestResult()
                with contextlib.redirect_stderr(io.StringIO()):
                    Probe().run(result)
                self.assertEqual(result.failures, [])
                self.assertEqual(len(result.errors), int(fail), result.errors)
                if fail:
                    self.assertIn('RuntimeError: fixture aborted', result.errors[0][1])
                self.assertEqual(os.environ[runs.BACKGROUND_RUN_ENV], 'outer-background')
                self.assertEqual(os.environ[home.RUN_ID_ENV], 'outer-preflight')
                self.assertEqual(home.INVOCATION_RUN.get(), 'outer-context')


class RunnerIdentityTests(Isolated):
    def args(self, *, background=False):
        argv = ['run', '--bg', '--', 'true'] if background else ['run', '--', 'true']
        return cli.build_parser().parse_args(argv)

    def test_foreground_candidate_is_consumed_once_from_environment_or_context(self):
        for source in ('environment', 'context', 'both'):
            with self.subTest(source=source), patch.dict(os.environ):
                token = home.INVOCATION_RUN.set('reserved' if source != 'environment' else '')
                try:
                    if source != 'context':
                        os.environ[home.RUN_ID_ENV] = 'reserved'
                    first = runs.Runner(self.args(), self.me)
                    self.assertEqual(first.run_id, 'reserved')
                    with patch.object(runs, 'new_id', return_value='fresh'):
                        second = runs.Runner(self.args(), self.me)
                        self.assertEqual(second.run_id, 'fresh')
                    self.assertNotIn(home.RUN_ID_ENV, os.environ)
                    self.assertEqual(home.INVOCATION_RUN.get(), '')
                finally:
                    home.INVOCATION_RUN.reset(token)

    def test_cli_wait_logs_and_kill_accept_old_and_new_run_ids(self):
        for run_id in ('run-1116-105555-c75c', 'run-1116-105555-1111c75c'):
            with self.subTest(run_id=run_id):
                path = common.LOGS_DIR / f'{run_id}.log'
                path.write_text(f'output for {run_id}\n')
                self.con.execute("INSERT INTO runs(run_id,owner,status,mode,exit_code,log_path) "
                                 "VALUES (?,?,'done','local',17,?)", (run_id, self.me['owner'], str(path)))
                out, err = io.StringIO(), io.StringIO()
                with patch.object(identity, 'whoami', return_value=dict(self.me, proven=True)), \
                        contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    self.assertEqual(cli.main(['wait', run_id]), 17)
                    self.assertEqual(cli.main(['logs', run_id]), 0)
                    self.assertEqual(cli.main(['kill', run_id]), 2)
                self.assertIn(f'output for {run_id}', out.getvalue())
                self.assertIn(f'run {run_id} is already done; nothing to kill', err.getvalue())
