"""Offline tests: --step runs, step summary, trailing-grep hint, box setup failure (exit 97) mapped to infra 90."""
import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import cli, runs  # noqa: E402
from offbox_lib.common import EXIT_INFRA, OffboxError  # noqa: E402
from test_capacity import Isolated  # noqa: E402


def fake_start(self):
    self.box, self.pid, self.started = 'bx_fake', 7, True
    return {'box_id': 'bx_fake'}


class StepScriptTests(unittest.TestCase):

    def run_steps(self, steps):
        with tempfile.TemporaryDirectory() as home:
            (Path(home) / 'w/repo/sub').mkdir(parents=True)
            with patch.object(runs, 'GO_REPAIR', ':'):
                script = runs.remote_script('w/repo', 'sub', [], None, 'run-test', steps=steps)
            env = {'HOME': home, 'PATH': os.environ.get('PATH', '/usr/bin:/bin')}
            p = subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True)
            return p.returncode, p.stdout, p.stderr

    def test_script_has_one_marker_per_step_and_pipefail(self):
        with patch.object(runs, 'GO_REPAIR', ':'):
            script = runs.remote_script('w/repo', '.', [], None, 'r', steps=['true', 'false | cat'])
        self.assertEqual(script.count('offbox step '), 2)
        self.assertEqual(script.count('set -o pipefail'), 2)

    def test_all_pass_exits_zero_and_reports_each_step(self):
        rc, _, err = self.run_steps(['true', 'echo hi'])
        self.assertEqual(rc, 0)
        self.assertIn('offbox step 1 rc=0: true', err)
        self.assertIn('offbox step 2 rc=0: echo hi', err)

    def test_keeps_going_and_returns_first_nonzero(self):
        rc, out, err = self.run_steps(['false', 'echo second', 'exit 4'])
        self.assertEqual(rc, 1)
        self.assertIn('offbox step 1 rc=1: false', err)
        self.assertIn('offbox step 2 rc=0: echo second', err)
        self.assertIn('offbox step 3 rc=4: exit 4', err)
        self.assertIn('second', out)

    def test_pipe_failure_inside_step_counts(self):
        rc, _, err = self.run_steps(['false | cat', 'true'])
        self.assertEqual(rc, 1)
        self.assertIn('offbox step 1 rc=1', err)

    def test_step_cannot_exit_the_wrapper_early(self):
        rc, _, err = self.run_steps(['exit 2', 'echo still-running'])
        self.assertEqual(rc, 2)
        self.assertIn('offbox step 2 rc=0', err)


class SummaryAndHintTests(unittest.TestCase):

    def test_summary_counts_and_first_failure(self):
        s = runs.steps_summary([(1, 0), (2, 1), (3, 0), (4, 2)], 4)
        self.assertEqual(s, 'offbox steps: 2 ok, 2 failed (step 2 rc=1, step 4 rc=2)')

    def test_summary_mentions_steps_not_run(self):
        self.assertEqual(runs.steps_summary([(1, 0)], 3), 'offbox steps: 1 ok, 0 failed, 2 not run')

    def test_grep_hint_only_for_exit_1_from_trailing_grep(self):
        self.assertTrue(runs.last_stage_is_grep('go test ./... 2>&1 | tee /tmp/l | tail -40; grep -c FAIL /tmp/l'))
        self.assertTrue(runs.last_stage_is_grep('go test ./... | grep FAIL'))
        self.assertFalse(runs.last_stage_is_grep('go test ./... | tail -5'))
        self.assertFalse(runs.last_stage_is_grep('grep FAIL /tmp/l; go test ./...'))

    def test_report_exit_prints_grep_hint_before_exit_line(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            runs.report_exit('go test ./... 2>&1 | tee /tmp/l | tail -40; grep -c FAIL /tmp/l', 1)
        lines = err.getvalue().strip().splitlines()
        self.assertEqual(lines[0], 'offbox: exit 1 came from the trailing grep (no match), not necessarily your tests. '
                                   'Use --step for each command.')
        self.assertEqual(lines[-1], 'offbox: remote exit 1')

    def test_report_exit_prints_step_summary_before_exit_line(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            runs.report_exit('', 1, [(1, 0), (2, 1)], 2)
        lines = err.getvalue().strip().splitlines()
        self.assertEqual(lines[0], 'offbox: offbox steps: 1 ok, 1 failed (step 2 rc=1)')
        self.assertEqual(lines[-1], 'offbox: remote exit 1')

    def test_setup_marker_detected_in_log(self):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / 'run.log'
            log.write_text('offbox: Go repair: cannot acquire repair lock\noffbox-setup-failed\n')
            self.assertTrue(runs.setup_failed(log))
            log.write_text('FAIL TestX\n')
            self.assertFalse(runs.setup_failed(log))

    def test_go_repair_preamble_prints_marker_on_97(self):
        self.assertIn('offbox-setup-failed', runs.GO_REPAIR)
        self.assertTrue(runs.GO_REPAIR.rstrip().endswith("|| { echo offbox-setup-failed >&2; exit 97; }"))


class CliStepTests(Isolated):

    def run_cli(self, argv, code, log_text=''):
        a = cli.build_parser().parse_args(['run'] + argv)

        def fake_follow(box, pid, log_path, echo=True, run_id=None, start_offsets=(0, 0)):
            if log_path:
                Path(log_path).write_text(log_text)
            return code

        err = io.StringIO()
        with patch.object(runs.Runner, 'start', fake_start), patch.object(runs, 'follow', fake_follow), \
                contextlib.redirect_stderr(err):
            rc = cli.cmd_run(a, self.me)
        return rc, err.getvalue().strip().splitlines()

    def test_step_and_trailing_cmd_is_an_error(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            rc = cli.cmd_run(cli.build_parser().parse_args(['run', '--step', 'true', '--', 'echo', 'x']), self.me)
        self.assertEqual(rc, 2)
        self.assertIn('either --step', err.getvalue())

    def test_steps_summary_and_exit_line(self):
        log = 'offbox step 1 rc=0: go vet ./...\noffbox step 2 rc=1: go test ./...\n'
        rc, lines = self.run_cli(['--step', 'go vet ./...', '--step', 'go test ./...'], 1, log)
        self.assertEqual(rc, 1)
        self.assertEqual(lines[-2], 'offbox: offbox steps: 1 ok, 1 failed (step 2 rc=1)')
        self.assertEqual(lines[-1], 'offbox: remote exit 1')

    def test_plain_cmd_still_has_no_step_summary(self):
        rc, lines = self.run_cli(['go', 'test', './...'], 0)
        self.assertEqual(rc, 0)
        self.assertFalse(any('offbox steps' in x for x in lines))

    def test_setup_97_maps_to_infra_90(self):
        rc, lines = self.run_cli(['--no-fallback', 'go', 'test', './...'], 97,
                                 'offbox: Go repair: lock\noffbox-setup-failed\n')
        self.assertEqual(rc, 90)
        self.assertIn('offbox: box setup failed (exit 97), not your command', lines)

    def test_user_97_without_marker_stays_97(self):
        rc, lines = self.run_cli(['go', 'test', './...'], 97, 'FAIL\n')
        self.assertEqual(rc, 97)
        self.assertEqual(lines[-1], 'offbox: remote exit 97')

    def test_setup_failure_error_is_infra_code(self):
        self.assertEqual(OffboxError('x', code=EXIT_INFRA).code, 90)


if __name__ == '__main__':
    unittest.main()
