"""Offline regression tests: a box whose systemd broke (transient scope failure) and boat's 409 "is stopped" (no boat calls)."""
import contextlib
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, cli, common, lease, pool, runs, ssh_sync  # noqa: E402
from offbox_lib.common import OffboxError, db  # noqa: E402
from test_capacity import Isolated  # noqa: E402

SCOPE_LINE = "Failed to start transient scope unit: Transport endpoint is not connected"


def fake_start(self):
    self.box, self.pid, self.started = 'bx_fake', 7, True
    return {'box_id': 'bx_fake'}


class ScopeFailedHelperTests(Isolated):
    def write(self, text):
        p = Path(self.tmp.name) / 'run.log'
        p.write_text(text)
        return p

    def test_only_scope_line_is_scope_failure(self):
        self.assertTrue(runs.scope_failed(self.write(SCOPE_LINE + "\n")))
        self.assertTrue(runs.scope_failed(self.write(SCOPE_LINE + "\n\n")))

    def test_scope_line_with_our_output_is_not_scope_failure(self):
        self.assertFalse(runs.scope_failed(self.write(SCOPE_LINE + "\noffbox: node v24.1.0\n")))

    def test_empty_missing_or_ordinary_log_is_not_scope_failure(self):
        self.assertFalse(runs.scope_failed(self.write("")))
        self.assertFalse(runs.scope_failed(Path(self.tmp.name) / 'absent.log'))
        self.assertFalse(runs.scope_failed(None))
        self.assertFalse(runs.scope_failed(self.write("FAIL TestX\n")))


class BrokenBoxRunTests(Isolated):
    def setUp(self):
        super().setUp()
        self.me = dict(owner='worker', repo_key='repo', repo_root='/checkout/repo', session='s', thread='t')

    def run_cli_full(self, follow_text, code):
        """Run `offbox run --remote` where the remote follow exits `code` and writes `follow_text` to the run log."""
        def follow(box, pid, log_path, **kw):
            Path(log_path).write_text(follow_text)
            return code

        a = cli.build_parser().parse_args(['run', '--remote', '--', 'go', 'test', './...'])
        err = io.StringIO()
        stop = MagicMock(return_value=True)
        finish = MagicMock()
        with patch.object(runs.Runner, 'start', fake_start), patch.object(runs, 'follow', side_effect=follow), \
                patch.object(runs, 'recorded_exit', return_value=None), patch.object(lease, 'stop_box', stop), \
                patch.object(runs, 'finish', finish), contextlib.redirect_stderr(err):
            rc = cli.cmd_run(a, self.me)
        return rc, err.getvalue(), stop, finish

    def test_scope_only_log_returns_90_stops_box_and_says_nothing_ran(self):
        rc, out, stop, finish = self.run_cli_full(SCOPE_LINE + "\n", 1)
        self.assertEqual(rc, 90)
        self.assertIn('nothing ran', out)
        stop.assert_called_once()
        args, kw = stop.call_args
        self.assertEqual(args[1], 'bx_fake')
        self.assertIs(kw.get('images'), False)
        self.assertIs(kw.get('locked'), True)
        finish.assert_called_once()
        self.assertEqual(finish.call_args.args[1:], (None, 'infra'))

    def test_scope_only_log_writes_box_broken_event(self):
        self.run_cli_full(SCOPE_LINE + "\n", 1)
        kinds = [r[0] for r in db().execute("SELECT kind FROM events WHERE box_id='bx_fake'").fetchall()]
        self.assertIn('box_broken', kinds)

    def test_ordinary_failure_is_not_treated_as_broken_box(self):
        rc, out, stop, finish = self.run_cli_full("FAIL TestX\n", 1)
        self.assertEqual(rc, 1)
        stop.assert_not_called()

    def test_stop_failure_still_returns_90_and_names_release(self):
        with patch.object(lease, 'stop_box', side_effect=OffboxError("boom")):
            def follow(box, pid, log_path, **kw):
                Path(log_path).write_text(SCOPE_LINE + "\n")
                return 1
            a = cli.build_parser().parse_args(['run', '--remote', '--', 'go', 'test', './...'])
            err = io.StringIO()
            with patch.object(runs.Runner, 'start', fake_start), patch.object(runs, 'follow', side_effect=follow), \
                    patch.object(runs, 'recorded_exit', return_value=None), contextlib.redirect_stderr(err):
                rc = cli.cmd_run(a, self.me)
        self.assertEqual(rc, 90)
        self.assertIn('offbox release bx_fake', err.getvalue())


class RefusedStartTests(Isolated):
    def setUp(self):
        super().setUp()
        self.me = dict(owner='worker', repo_key='repo', repo_root='/checkout/repo', session='s', thread='t')
        self.con.execute("""INSERT INTO leases(box_id,owner,repo_root,repo_key,remote_dir,state,size,last_used_at,source)
            VALUES ('bx_fake','worker','/checkout/repo','repo','w/fake','running',?,?,'template:crpko-go')""",
                         ('large', 100))
        self.con.commit()

    def start_with(self, err):
        row = {'box_id': 'bx_fake', 'remote_dir': 'w/fake', 'size': 'large'}
        a = cli.build_parser().parse_args(['run', '--remote', '--', 'go', 'test', './...'])
        a.steps, a.env, a.no_sync, a.git, a.bg, a.pull, a.size, a.template, a.base, a.fresh = None, [], True, False, False, None, 'large', None, None, False
        rn = runs.Runner(a, self.me)
        with patch.object(pool, 'acquire', return_value=row), patch.object(ssh_sync, 'put_file'), \
                patch.object(ssh_sync, 'push'), patch.object(ssh_sync, 'tracked_secret_matches', return_value=[]), \
                patch.object(runs.prune, 'run'), patch.object(api, 'cmd_start', side_effect=err), \
                patch.object(ssh_sync, 'close_master') as close, patch.object(runs.lease, 'typecheck_size', return_value='large'):
            with self.assertRaises(OffboxError) as cm:
                rn.start()
        return rn, cm.exception, close

    def lease_state(self):
        return self.con.execute("SELECT state FROM leases WHERE box_id='bx_fake'").fetchone()[0]

    def test_409_sandbox_not_ready_marks_lease_stopped(self):
        err = api.ApiError(409, 'sandbox_not_ready', 'Sandbox bx_fake is stopped. Run `boat resume bx_fake`, then retry.')
        rn, exc, close = self.start_with(err)
        self.assertEqual(self.lease_state(), 'stopped')
        close.assert_called_once_with('bx_fake')
        kinds = [r[0] for r in db().execute("SELECT kind FROM events WHERE box_id='bx_fake'").fetchall()]
        self.assertIn('lease_not_ready', kinds)
        self.assertEqual(exc.code, 90)
        self.assertFalse(rn.started)
        self.assertIn("don't run `boat resume` by hand", str(exc))

    def test_409_rate_limited_leaves_lease_running(self):
        err = api.ApiError(409, 'rate_limited', 'slow down')
        rn, exc, close = self.start_with(err)
        self.assertEqual(self.lease_state(), 'running')
        close.assert_not_called()
        self.assertFalse(rn.started)


if __name__ == '__main__':
    unittest.main()
