"""Offline tests for `offbox kill <run>`, the release refusal message, and the reaper's no-box run cleanup."""
import contextlib
import io
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import api, common, lease, misc, reap, runs  # noqa: E402
from offbox_lib.common import now  # noqa: E402

from test_capacity import Isolated  # noqa: E402


class KillRunTests(Isolated):
    def run_row(self, rid='run-1', box='bx_1', pid=42, status='running', mode='fg', start=None, error=None):
        self.con.execute("INSERT INTO runs(run_id,box_id,process_id,status,mode,start_at,error) VALUES (?,?,?,?,?,?,?)",
                         (rid, box, pid, status, mode, start if start is not None else now() - 60, error))
        self.con.commit()

    def status_of(self, rid):
        return self.con.execute("SELECT status, exit_code FROM runs WHERE run_id=?", (rid,)).fetchone()

    def patched_kill(self, kill_side_effect=None, status_values=(None,)):
        """Patch the boat calls kill_run uses; returns (kill_mock, status_mock) for assertions."""
        kill = patch.object(api, 'cmd_kill', side_effect=kill_side_effect, return_value={})
        st = patch.object(api, 'cmd_status', side_effect=list(status_values))
        self.stack.enter_context(patch.object(lease, 'touch'))
        self.stack.enter_context(patch.object(lease, 'idle_ttl'))
        km = self.stack.enter_context(kill)
        sm = self.stack.enter_context(st)
        return km, sm

    def test_kill_confirms_then_marks_killed(self):
        self.run_row()
        km, sm = self.patched_kill(status_values=({'running': False, 'status': 'exited', 'exitCode': 143},))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = misc.kill_run('run-1')
        self.assertEqual(rc, 0)
        km.assert_called_once_with('bx_1', 42)
        self.assertEqual(tuple(self.status_of('run-1')), ('killed', 143))
        self.assertIn('bx_1', out.getvalue())
        self.assertIn('offbox release', out.getvalue())

    def test_kill_status_none_counts_as_confirmed(self):
        self.run_row()
        self.patched_kill(status_values=(None,))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(misc.kill_run('run-1'), 0)
        self.assertEqual(self.status_of('run-1')['status'], 'killed')

    def test_unconfirmed_kill_leaves_row_running(self):
        self.run_row()
        self.patched_kill(status_values=({'running': True, 'status': 'running'},))
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            rc = misc.kill_run('run-1')
        self.assertEqual(rc, 1)
        self.assertEqual(self.status_of('run-1')['status'], 'running')
        self.assertIn('still reports', err.getvalue())

    def test_status_error_leaves_row_running(self):
        self.run_row()
        self.patched_kill(status_values=(api.OffboxError('status boom'),))
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(misc.kill_run('run-1'), 1)
        self.assertEqual(self.status_of('run-1')['status'], 'running')

    def test_empty_or_unknown_status_never_marks_killed(self):
        # An empty successful response ({}) or one without a running field is not proof the process stopped.
        for i, bogus in enumerate(({}, {'status': 'running'}, {'exitCode': 143})):
            with self.subTest(status=bogus):
                rid = f'run-bogus-{i}'
                self.run_row(rid)
                self.patched_kill(status_values=(bogus,))
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    self.assertEqual(misc.kill_run(rid), 1)
                self.assertEqual(self.status_of(rid)['status'], 'running')
                self.assertIn('returned no clear running state', err.getvalue())

    def test_delete_error_then_404_confirms_stop(self):
        # DELETE timed out but the process is gone: the follow-up GET returning 404 is the accepted confirmation.
        self.run_row()
        self.patched_kill(kill_side_effect=api.OffboxError('DELETE timed out'), status_values=(None,))
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(misc.kill_run('run-1'), 0)
        self.assertEqual(tuple(self.status_of('run-1')), ('killed', 143))
        self.assertIn('kill request failed', out.getvalue())

    def test_delete_error_with_still_running_leaves_row_running(self):
        self.run_row()
        self.patched_kill(kill_side_effect=api.OffboxError('DELETE timed out'),
                          status_values=({'running': True, 'status': 'running'},))
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(misc.kill_run('run-1'), 1)
        self.assertEqual(self.status_of('run-1')['status'], 'running')

    def test_local_and_no_process_rows_refused(self):
        self.run_row('run-local', box=None, pid=None, mode='local')
        self.run_row('run-nopid', box='bx_1', pid=None, mode='fg')
        self.run_row('run-nobox', box=None, pid=None, mode='bg')
        km, _ = self.patched_kill()
        for rid in ('run-local', 'run-nopid', 'run-nobox'):
            with self.assertRaises(api.OffboxError):
                misc.kill_run(rid)
        km.assert_not_called()
        self.assertEqual(self.status_of('run-nopid')['status'], 'running')

    def test_settled_row_refused(self):
        self.run_row('run-done', status='done')
        km, _ = self.patched_kill()
        with self.assertRaises(api.OffboxError):
            misc.kill_run('run-done')
        km.assert_not_called()

    def test_release_refusal_names_runs_and_suggests_kill(self):
        self.box('bx_busy')
        self.run_row('run-hung', box='bx_busy', pid=7)
        r = self.con.execute("SELECT * FROM leases WHERE box_id='bx_busy'").fetchone()
        err = io.StringIO()
        with patch.object(misc, 'db', return_value=self.con), contextlib.redirect_stderr(err):
            misc._release_one(self.con, r, False)
        self.assertIn('run-hung', err.getvalue())
        self.assertIn('offbox kill <run>', err.getvalue())

    def test_public_release_names_runs_when_box_lock_is_held(self):
        # A streaming foreground run holds box-<id>; public release must still name the hung run and suggest kill.
        self.box('bx_held')
        self.run_row('run-streaming', box='bx_held', pid=9)
        held = common.file_lock('box-bx_held', timeout=0)
        held.__enter__()
        try:
            err = io.StringIO()
            with patch.object(misc, 'db', return_value=self.con), contextlib.redirect_stderr(err):
                misc.release(self.me, 'bx_held', False, False)
            self.assertIn('run-streaming', err.getvalue())
            self.assertIn('offbox kill <run>', err.getvalue())
            self.assertEqual(self.con.execute("SELECT state FROM leases WHERE box_id='bx_held'").fetchone()[0],
                             'running')
        finally:
            held.__exit__(None, None, None)

    def test_public_release_busy_lock_without_runs_is_not_run_hint(self):
        self.box('bx_busy2')
        held = common.file_lock('box-bx_busy2', timeout=0)
        held.__enter__()
        try:
            err = io.StringIO()
            with patch.object(misc, 'db', return_value=self.con), contextlib.redirect_stderr(err):
                misc.release(self.me, 'bx_busy2', False, False)
            self.assertIn('box is busy', err.getvalue())
            self.assertNotIn('offbox kill', err.getvalue())
        finally:
            held.__exit__(None, None, None)

    def test_reaper_marks_old_nobox_rows_lost_only(self):
        self.run_row('run-old-nobox', box=None, pid=None, mode='bg', start=now() - 3 * 3600)
        self.run_row('run-new-nobox', box=None, pid=None, mode='fg', start=now() - 600)
        self.run_row('run-old-boxed', box='bx_9', pid=5, mode='fg', start=now() - 3 * 3600)
        self.stack.enter_context(patch.object(api, 'list_boxes', return_value=[]))
        actions = []
        reap._reap(self.con, False, actions)
        old = self.status_of('run-old-nobox')
        self.assertEqual(old['status'], 'lost')
        row = self.con.execute("SELECT error FROM runs WHERE run_id='run-old-nobox'").fetchone()
        self.assertEqual(row['error'], 'client ended before it got a box')
        self.assertEqual(self.status_of('run-new-nobox')['status'], 'running')
        self.assertEqual(self.status_of('run-old-boxed')['status'], 'running')
        self.assertTrue(any('run-old-nobox' in a for a in actions))

    def test_reaper_dry_run_writes_nothing(self):
        self.run_row('run-old-nobox', box=None, pid=None, mode='fg', start=now() - 3 * 3600)
        self.stack.enter_context(patch.object(api, 'list_boxes', return_value=[]))
        actions = []
        reap._reap(self.con, True, actions)
        self.assertEqual(self.status_of('run-old-nobox')['status'], 'running')
        self.assertTrue(any('would mark no-box run run-old-nobox' in a for a in actions))


if __name__ == '__main__':
    unittest.main()
