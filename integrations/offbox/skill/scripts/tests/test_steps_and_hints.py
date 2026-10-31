"""Offline tests: --step runs, step summary, trailing-grep hint, box setup failure (exit 97) mapped to infra 90."""
import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import cli, lease, runs  # noqa: E402
from offbox_lib.common import EXIT_INFRA, OffboxError  # noqa: E402
from offbox_lib.runs import GO_STD_GLITCH  # noqa: E402
from test_capacity import Isolated  # noqa: E402


class GoStdGlitchMatcherTests(unittest.TestCase):

    def test_go_std_glitch_matcher(self):
        for line in ('internal/abi/abi.go:9:2: package unsafe is not in std (/usr/local/go/src/unsafe)',
                     'package internal/fmtsort is not in std (/usr/local/go/src/internal/fmtsort)',
                     'build constraints exclude all Go files in /usr/local/go/src/internal/syscall/execenv'):
            with self.subTest(line=line):
                self.assertIsNotNone(GO_STD_GLITCH.search(line))
        for line in ('package risk-liquidation/internal/x is not in std '
                     '(/usr/local/go/src/risk-liquidation/internal/x)', 'FAIL TestX'):
            with self.subTest(line=line):
                self.assertIsNone(GO_STD_GLITCH.search(line))


def fake_start(self):
    self.box, self.pid, self.started = 'bx_fake', 7, True
    return {'box_id': 'bx_fake'}


class StepScriptTests(unittest.TestCase):

    def run_steps(self, steps):
        with tempfile.TemporaryDirectory() as home:
            (Path(home) / 'w/repo/sub').mkdir(parents=True)
            with patch.object(runs, 'GO_REPAIR', ':'), patch.object(runs, 'DOCKER_REPAIR', ':'), \
                patch.object(runs, 'LDCACHE_REPAIR', ':'):
                script = runs.remote_script('w/repo', 'sub', [], None, 'run-test', steps=steps)
            env = {'HOME': home, 'PATH': os.environ.get('PATH', '/usr/bin:/bin')}
            p = subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True)
            return p.returncode, p.stdout, p.stderr

    def test_script_has_one_marker_per_step_and_pipefail(self):
        with patch.object(runs, 'GO_REPAIR', ':'), patch.object(runs, 'DOCKER_REPAIR', ':'), \
                patch.object(runs, 'LDCACHE_REPAIR', ':'):
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
        self.assertEqual(lines[0], 'offbox: exit 1 may be from the trailing grep (no match) or an earlier stage. '
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

    def run_cli(self, argv, code, log_text='', recorded=None):
        a = cli.build_parser().parse_args(['run'] + argv)

        def fake_follow(box, pid, log_path, echo=True, run_id=None, start_offsets=(0, 0)):
            if log_path:
                Path(log_path).write_text(log_text)
            return code

        err = io.StringIO()
        with patch.object(runs.Runner, 'start', fake_start), patch.object(runs, 'follow', fake_follow), \
                patch.object(runs, 'recorded_exit', return_value=recorded), contextlib.redirect_stderr(err):
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

    def glitch_events(self):
        return self.con.execute("SELECT box_id, detail FROM events WHERE kind='go_std_glitch'").fetchall()

    def test_go_std_glitch_prints_hint_and_records_event(self):
        log = 'internal/abi/abi.go:9:2: package unsafe is not in std (/usr/local/go/src/unsafe)\n'
        rc, lines = self.run_cli(['go', 'test', './...'], 1, log)
        self.assertEqual(rc, 1)
        self.assertTrue(any('not your code' in x for x in lines))
        self.assertEqual(lines[-1], 'offbox: remote exit 1')
        rows = self.glitch_events()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0], 'bx_fake')
        self.assertIn('unknown', rows[0][1])

    def test_go_std_glitch_reports_seconds_after_resume(self):
        self.con.execute("INSERT INTO events VALUES (?,?,?,?)", (time.time() - 90, 'bx_fake', 'lease_resume', ''))
        self.con.commit()
        log = 'package internal/fmtsort is not in std (/usr/local/go/src/internal/fmtsort)\n'
        rc, lines = self.run_cli(['go', 'test', './...'], 1, log)
        self.assertEqual(rc, 1)
        self.assertRegex(self.glitch_events()[0][1], r'\d+s after resume')

    def test_no_glitch_hint_on_success_or_other_failures(self):
        std_log = 'package unsafe is not in std (/usr/local/go/src/unsafe)\n'
        rc, lines = self.run_cli(['go', 'vet', './...'], 0, std_log)
        self.assertEqual(rc, 0)
        self.assertFalse(any('not your code' in x for x in lines))
        rc, lines = self.run_cli(['go', 'test', './...'], 1, '--- FAIL TestX\n')
        self.assertFalse(any('not your code' in x for x in lines))
        user_log = 'package risk-liquidation/internal/x is not in std (/usr/local/go/src/risk-liquidation/internal/x)\n'
        rc, lines = self.run_cli(['go', 'test', './...'], 1, user_log)
        self.assertFalse(any('not your code' in x for x in lines))
        self.assertEqual(self.glitch_events(), [])

    def test_plain_cmd_still_has_no_step_summary(self):
        rc, lines = self.run_cli(['go', 'test', './...'], 0)
        self.assertEqual(rc, 0)
        self.assertFalse(any('offbox steps' in x for x in lines))

    def test_lost_step_run_with_every_step_reported_takes_steps_code(self):
        steps = ['--step', 'a', '--step', 'b']
        rc, lines = self.run_cli(steps, None, 'offbox step 1 rc=0: a\noffbox step 2 rc=0: b\n')
        self.assertEqual(rc, 0)
        self.assertEqual(lines[-1], 'offbox: remote exit 0')
        rc, lines = self.run_cli(steps, None, 'offbox step 1 rc=0: a\noffbox step 2 rc=3: b\n')
        self.assertEqual(rc, 3)

    def test_lost_step_run_with_missing_step_line_stays_90(self):
        rc, lines = self.run_cli(['--step', 'a', '--step', 'b'], None, 'offbox step 1 rc=0: a\n')
        self.assertEqual(rc, 90)
        self.assertTrue(any('remote exit unknown' in ln for ln in lines))

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


class TypecheckSizeTests(unittest.TestCase):

    def repo(self, with_package=True):
        d = tempfile.TemporaryDirectory()
        if with_package:
            Path(d.name, 'package.json').write_text('{}')
        return d

    def test_typecheck_gets_xlarge(self):
        with self.repo() as r:
            self.assertEqual(lease.typecheck_size('cd apps/server && vp run typecheck', r, None), 'xlarge')
            self.assertEqual(lease.typecheck_size('npx tsc --noEmit -p apps/server', r, None), 'xlarge')

    def test_explicit_size_wins(self):
        with self.repo() as r:
            self.assertEqual(lease.typecheck_size('cd apps/server && vp run typecheck', r, 'large'), 'large')

    def test_non_typecheck_keeps_default(self):
        with self.repo() as r:
            self.assertIsNone(lease.typecheck_size('vp test run src/x', r, None))

    def test_no_package_json_keeps_default(self):
        with self.repo(with_package=False) as r:
            self.assertIsNone(lease.typecheck_size('npx tsc --noEmit', r, None))


class AutoSizeTests(Isolated):

    def ident(self, d, key="repo"):
        return {'repo_root': d, 'repo_key': key}

    def size(self, cmd, d, key='repo', explicit=None):
        return lease.auto_size(self.con, cmd, self.ident(d, key), explicit)[0]

    def test_ordinary_runs_take_the_template_size(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, 'package.json').write_text('{}')
            for cmd in ('npm ci', 'npx jest', 'go test ./...', 'uv run pytest -q tests', 'make test',
                        'docker run --rm alpine true'):
                self.assertIsNone(self.size(cmd, d), cmd)

    def test_explicit_size_wins(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(self.size('docker compose up -d', d, explicit='large'), 'large')
            self.assertEqual(self.size('go test ./...', d, explicit='xlarge'), 'xlarge')

    def test_container_stacks_get_xlarge(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(self.size('docker compose up -d && ./health.sh', d), 'xlarge')
            self.assertEqual(self.size('localstack start -d', d), 'xlarge')
            self.assertEqual(self.size('bash tmp/hc-005/check.sh', d, key='crpko-integration-harness'), 'xlarge')

    def test_whole_suite_in_testcontainers_repo_gets_xlarge(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, 'go.mod').write_text('module x\nrequire github.com/testcontainers/testcontainers-go v0.1\n')
            self.assertEqual(self.size('go test ./...', d), 'xlarge')
            self.assertIsNone(self.size('go test -run TestX ./internal/pkg', d))
            self.assertIsNone(self.size('go vet ./internal/a ./internal/b', d))

    def test_typecheck_still_xlarge(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, 'package.json').write_text('{}')
            self.assertEqual(self.size('npx tsc --noEmit -p apps/server', d), 'xlarge')

    def test_recent_oom_in_repo_gets_xlarge(self):
        with tempfile.TemporaryDirectory() as d:
            self.con.execute("INSERT INTO leases(box_id,owner,repo_root,repo_key,remote_dir) VALUES ('bx_o','o',?,'repo','r')", (d,))
            self.con.execute("INSERT INTO runs(run_id,box_id,size,exit_code,start_at) VALUES ('r1','bx_o','large',137,?)",
                             (time.time() - 3600,))
            self.con.commit()
            self.assertEqual(self.size('npx vitest run', d), 'xlarge')
            self.assertIsNone(self.size('npx vitest run', d, key='other'))


class ExitHintTests(unittest.TestCase):

    def test_137_prints_memory_hint_before_exit_line(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            runs.report_exit('', 137)
        lines = err.getvalue().strip().splitlines()
        self.assertEqual(lines[-2], 'offbox: exit 137 = the box killed the command for memory. Rerun with --size xlarge.')
        self.assertEqual(lines[-1], 'offbox: remote exit 137')

    def test_137_in_steps_prints_summary_hint_then_exit_line(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            runs.report_exit('', 137, [(1, 0), (2, 137)], 2)
        lines = err.getvalue().strip().splitlines()
        self.assertEqual(lines[0], 'offbox: offbox steps: 1 ok, 1 failed (step 2 rc=137)')
        self.assertEqual(lines[1], 'offbox: exit 137 = the box killed the command for memory. Rerun with --size xlarge.')
        self.assertEqual(lines[-1], 'offbox: remote exit 137')

    def test_plain_failure_has_no_memory_hint(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            runs.report_exit('', 1)
        self.assertNotIn('killed the command for memory', err.getvalue())


if __name__ == '__main__':
    unittest.main()
