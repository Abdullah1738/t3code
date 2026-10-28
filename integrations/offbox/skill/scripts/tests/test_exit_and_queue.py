"""Offline regression tests: remote exit-code fidelity and pool-busy queueing (no boat calls)."""
import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import capacity, cli, common, fallback, lease, pool, runs  # noqa: E402
from test_capacity import Isolated  # noqa: E402


def fake_start(self):
    self.box, self.pid, self.started = 'bx_fake', 7, True
    return {'box_id': 'bx_fake'}


class ExitFidelityTests(Isolated):
    """17 Oct, cell-risk2 (ses_eb894feb, run-1017-102938-6a57): the remote string ended in `; echo EXIT=$?`,
    so the remote shell's status was echo's 0 while go test failed. offbox must return exactly what the remote
    shell returned and say so on its last line."""

    def run_cli(self, argv, code):
        a = cli.build_parser().parse_args(['run', '--'] + argv)
        err = io.StringIO()
        with patch.object(runs.Runner, 'start', fake_start), patch.object(runs, 'follow', return_value=code), \
                contextlib.redirect_stderr(err):
            rc = cli.cmd_run(a, self.me)
        return rc, err.getvalue().strip().splitlines()[-1]

    def test_nonzero_remote_exit_is_returned_and_printed_last(self):
        for code in (1, 2, 3, 97, 143):
            rc, last = self.run_cli(['go', 'test', './...'], code)
            self.assertEqual(rc, code)
            self.assertEqual(last, f'offbox: remote exit {code}')

    def test_zero_from_trailing_echo_is_flagged(self):
        rc, last = self.run_cli(['set -o pipefail; go test -count=1 -v ./... 2>&1; echo EXIT=$?'], 0)
        self.assertEqual(rc, 0)
        self.assertIn('offbox: remote exit 0 (status of the final `echo', last)
        self.assertIn('exit $rc', last)

    def test_successful_pipe_needs_no_masking_hint(self):
        rc, last = self.run_cli(['go test ./... 2>&1 | tail -5'], 0)
        self.assertEqual(rc, 0)
        self.assertEqual(last, 'offbox: remote exit 0')

    def test_lost_process_is_90_with_explicit_line(self):
        rc, last = self.run_cli(['go', 'test', './...'], None)
        self.assertEqual(rc, 90)
        self.assertIn('remote exit unknown', last)

    def test_hint_only_when_status_can_be_masked(self):
        h = runs.masked_status_hint
        for cmd in ('go test ./...', "go test -run '^(TestA|TestB)$' ./pkg", 'go vet ./... && echo ok',
                    'set -o pipefail; go test ./... | tail -5', 'go test ./... |& tee out.txt; exit ${PIPESTATUS[0]}',
                    'go test ./... | grep -E "^(ok|FAIL)"', 'go vet ./x 2>&1 | head -4',
                    'echo "a | b; c"', ''):
            self.assertEqual(h(cmd), '', cmd)
        for cmd in ('go test ./...; echo EXIT=$?', 'go test ./...\necho done', 'make check || true'):
            self.assertNotEqual(h(cmd), '', cmd)


class RemoteWrapperTests(unittest.TestCase):
    """The generated remote script must not swallow the user's status (run with the real bash, Go repair off)."""

    def run_script(self, argv):
        with tempfile.TemporaryDirectory() as home:
            (Path(home) / 'w/repo/sub').mkdir(parents=True)
            with patch.object(runs, 'GO_REPAIR', ':'), patch.object(runs, 'DOCKER_REPAIR', ':'), \
                patch.object(runs, 'LDCACHE_REPAIR', ':'):
                script = runs.remote_script('w/repo', 'sub', argv, None, 'run-test')
            env = {'HOME': home, 'PATH': os.environ.get('PATH', '/usr/bin:/bin')}
            return subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True,
                                  timeout=10).returncode

    def test_statuses_pass_through(self):
        self.assertEqual(self.run_script(['false']), 1)
        self.assertEqual(self.run_script(['exit 3']), 3)
        self.assertEqual(self.run_script(['sh', '-c', 'exit 5']), 5)
        self.assertEqual(self.run_script(['set -o pipefail; false | cat']), 1)
        self.assertEqual(self.run_script(['false; rc=$?; echo EXIT=$rc; exit $rc']), 1)

    def test_failed_pipeline_stage_is_not_hidden_by_output_filters(self):
        for cmd, code in [('false | tail -1', 1), ('(exit 7) | tee /dev/null | tail -1', 7),
                          ('true | (exit 3) | tail -1', 3), ('(exit 2) | (exit 4) | cat', 4)]:
            with self.subTest(cmd=cmd):
                self.assertEqual(self.run_script([cmd]), code)

    def test_sigpipe_from_early_reader_is_success(self):
        for cmd in ('yes | head -1', 'yes | head -1 | cat', '(exit 141) | (exit 141) | true',
                    'yes | exit 0', 'yes 2>&1 | head -1'):
            with self.subTest(cmd=cmd):
                self.assertEqual(self.run_script([cmd]), 0)

    def test_sigpipe_does_not_hide_real_failures(self):
        for cmd, code in [('(exit 7) | (exit 141) | cat', 7), ('yes | head -1 | (exit 3)', 3),
                          ('true | (exit 141)', 141), ('exit 141', 141),
                          ('yes | head -1; exit 7', 7), ('yes | head -1; exit 141', 141),
                          (r'yes | head -1; \exit 141', 141), ("yes | head -1; 'exit' 141", 141),
                          ('! true | cat', 1), ('! false | cat', 0)]:
            with self.subTest(cmd=cmd):
                self.assertEqual(self.run_script([cmd]), code)

    def test_compound_script_cannot_pass_after_skipping_checks(self):
        for cmd in ('yes | head -1 && false', 'set -e; yes | head -1; false',
                    'yes | head -1\nexit 141', 'yes | head -1;:;exit 141',
                    "yes | head -1 | grep -v '(' && false ')'",
                    'true | cat # comment\n(exit 141) | cat',
                    "true | printf '|'\n(exit 141) | cat", 'yes |\nhead -1'):
            with self.subTest(cmd=cmd):
                self.assertEqual(self.run_script([cmd]), 141)

    def test_readonly_caller_variables_cannot_mask_failures(self):
        self.assertEqual(self.run_script(['readonly rc=0; false']), 1)
        self.assertEqual(self.run_script(['readonly rc=0; (exit 97) | cat']), 97)

    def test_incomplete_pipeline_stays_a_syntax_error(self):
        for cmd in ('false |', 'true | # missing last stage', 'true |&'):
            self.assertEqual(self.run_script([cmd]), 2)

    def test_grep_no_match_remains_nonzero(self):
        cmd = 'printf "ok\\n" | grep FAIL'
        rc = self.run_script([cmd])
        self.assertEqual(rc, 1)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            runs.report_exit(cmd, rc)
        self.assertIn('trailing grep (no match)', err.getvalue())
        self.assertEqual(err.getvalue().splitlines()[-1], 'offbox: remote exit 1')

    def test_grep_hint_does_not_blame_a_successful_grep(self):
        cmd = '(printf "ok\\n"; exit 1) | grep ok'
        rc = self.run_script([cmd])
        self.assertEqual(rc, 1)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            runs.report_exit(cmd, rc)
        self.assertIn('or an earlier stage', err.getvalue())

    def test_caller_masking_is_the_callers_choice(self):
        self.assertEqual(self.run_script(['false; echo EXIT=$?']), 0)
        self.assertEqual(self.run_script(['false | tail -1; echo EXIT=$?']), 0)
        self.assertEqual(self.run_script(['false | tail -1 || true']), 0)

    def test_reserved_command_statuses_pass_through(self):
        for code in (90, 91, 92, 97):
            self.assertEqual(self.run_script([f'(exit {code}) | tail -1']), code)


class FakeClock:
    def __init__(self):
        self.t = 1000.0
        self.time = types.SimpleNamespace(monotonic=lambda: self.t, sleep=self.sleep)

    def sleep(self, s):
        self.t += s


class PoolQueueTests(Isolated):
    def full_pool(self):
        for bid in ('one', 'two'):
            self.box(bid, member=True)
            self.busy(bid)

    def test_default_wait_is_600_and_capped(self):
        env = dict(os.environ)
        env.pop('OFFBOX_POOL_WAIT_SECONDS', None)
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(pool.wait_seconds(), 600)
        with patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS': '5000'}):
            self.assertEqual(pool.wait_seconds(), 1200)

    def test_busy_timeout_is_distinct_92_and_says_nothing_ran(self):
        self.full_pool()
        with patch.object(lease, 'acquire_private') as new:
            with self.assertRaises(pool.PoolBusyError) as caught:
                pool.acquire(self.me)
            new.assert_not_called()
        e = caught.exception
        self.assertEqual(e.code, common.EXIT_BUSY)
        self.assertEqual(e.code, 92)
        self.assertFalse(e.started)
        self.assertIsInstance(e, capacity.CapacityError)
        self.assertIn('busy/full', str(e))
        self.assertIn('remote queue timed out', str(e))
        self.assertIn('Nothing ran', str(e))

    def test_start_limit_timeout_stays_90(self):
        capacity.cooldown({}, {'message': 'day limit'})
        self.box('stopped', 'stopped')
        with self.assertRaises(capacity.CapacityError) as caught:
            pool.acquire(self.me)
        self.assertNotIsInstance(caught.exception, pool.PoolBusyError)
        self.assertEqual(caught.exception.code, 90)

    def test_queue_prints_position_progress_and_hint(self):
        self.full_pool()
        self.con.execute("INSERT INTO runs(run_id,status,repo_root,start_at) VALUES ('waiter','starting','/old/worktree',?)",
                         (common.now(),))
        self.con.execute("INSERT INTO runs(run_id,status,repo_root,start_at) VALUES ('mine','starting','/old/worktree',?)",
                         (common.now(),))
        self.con.commit()
        clock, err = FakeClock(), io.StringIO()
        with patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS': '130'}), patch.object(pool, 'time', clock.time), \
                patch.object(lease, 'acquire_private'), contextlib.redirect_stderr(err):
            with self.assertRaises(pool.PoolBusyError) as caught:
                pool.acquire(self.me, run_id='mine')
        lines = err.getvalue().splitlines()
        self.assertIn('queued for a repo pool box: 2/2 busy, 1 other caller(s) waiting; will wait up to 130s', lines[0])
        self.assertIn('tool timeout above 130s', lines[0])
        self.assertIn('background', lines[0])
        progress = [ln for ln in lines if 'still queued' in ln]
        self.assertEqual(len(progress), 2)
        self.assertIn('waited 60s of 130s', progress[0])
        self.assertIn('stayed busy for 130s', str(caught.exception))

    def test_box_freed_while_queued_is_taken(self):
        self.full_pool()
        clock = FakeClock()

        def sleep(s):
            clock.t += s
            if clock.t > 1010:
                self.con.execute("UPDATE runs SET status='done' WHERE box_id='one'")
                self.con.commit()
        clock.time.sleep = sleep
        with patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS': '600'}), patch.object(pool, 'time', clock.time), \
                patch.object(lease, '_reuse', side_effect=lambda c, r, s: dict(r)), contextlib.redirect_stderr(io.StringIO()):
            row = pool.acquire(self.me)
        try:
            self.assertEqual(row['box_id'], 'one')
            self.assertLess(clock.t, 1020)
        finally:
            pool.release_guard(row)

    def test_cli_busy_returns_92_no_infra_alert_no_heavy_fallback(self):
        a = cli.build_parser().parse_args(['run', '--', 'go', 'test', './...'])
        err = io.StringIO()
        with patch.object(runs, 'run_remote', side_effect=pool.PoolBusyError('repository pool busy/full for repo')), \
                patch.object(fallback, 'run_local') as local, patch.object(fallback, 'note_infra_failure') as infra, \
                contextlib.redirect_stderr(err):
            self.assertEqual(cli.cmd_run(a, self.me), 92)
            local.assert_not_called()
            infra.assert_not_called()
        self.assertIn('exit 92', err.getvalue())

    def test_cli_busy_with_no_fallback_and_bg_returns_92(self):
        for flags in (['--no-fallback'], ['--bg']):
            a = cli.build_parser().parse_args(['run'] + flags + ['--', 'echo', 'ok'])
            with patch.object(runs, 'run_remote', side_effect=pool.PoolBusyError('busy')), \
                    patch.object(fallback, 'run_local') as local, contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(cli.cmd_run(a, self.me), 92, flags)
                local.assert_not_called()

    def test_small_command_keeps_local_fallback_on_busy(self):
        a = cli.build_parser().parse_args(['run', '--', 'echo', 'ok'])
        err = io.StringIO()
        with patch.object(runs, 'run_remote', side_effect=pool.PoolBusyError('busy')), \
                patch.object(fallback, 'run_local', return_value=4) as local, contextlib.redirect_stderr(err):
            self.assertEqual(cli.cmd_run(a, self.me), 4)
        self.assertIn('repository pool busy', local.call_args.args[1])
        self.assertEqual(err.getvalue().strip().splitlines()[-1], 'offbox: local fallback exit 4')


if __name__ == '__main__':
    unittest.main()
