"""Offline tests for dead-mount boxes (home filesystem ENOTCONN): set aside, out of the pool, one retry, and
--fresh failing fast in a full pool."""
import contextlib
import io
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, cli, common, lease, misc, pool, runs, ssh_sync  # noqa: E402
from offbox_lib.common import OffboxError  # noqa: E402
from test_capacity import Isolated  # noqa: E402

ENOTCONN_MKSTEMP = ('rsync: [receiver] mkstemp "/home/user/w/crpko_mobile_app-pr369-fefc2e/x.go" failed: '
                    'Transport endpoint is not connected (107)')
ENOTCONN_CHDIR = "Could not chdir to home directory /home/user: Transport endpoint is not connected"
ECONNABORT = "rsync: write failed on \"/home/user/w/x\": Software caused connection abort (103)"


class DeadMountTests(Isolated):
    def setUp(self):
        super().setUp()
        self.quiet = self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))

        def no_boat(method, path, *a, **kw):
            raise AssertionError(f"offline test reached boat: {method} {path}")
        self.stack.enter_context(patch.object(api, "call", side_effect=no_boat))
        self.stack.enter_context(patch.object(api, "get", return_value={'state': 'stopped'}))

    def lease_row(self, bid):
        return self.con.execute("SELECT * FROM leases WHERE box_id=?", (bid,)).fetchone()

    def runner(self):
        rn = runs.Runner(cli.build_parser().parse_args(["run", "--", "go", "test", "./..."]), self.me)
        rn.a.steps = []
        return rn

    def run_start(self, pushes, probes, acquire_rows=None):
        """Runs Runner.start() with two pool boxes bxA/bxB (rows as pool.acquire would return them)."""
        self.box('bxA', member=True)
        self.box('bxB', member=True)
        rows = acquire_rows or [dict(self.lease_row('bxA')), dict(self.lease_row('bxB'))]
        rows = [dict(r, remote_dir='w/r') for r in rows]
        rn = self.runner()
        stack = self.stack
        acquire = stack.enter_context(patch.object(runs.pool, "acquire", side_effect=rows))
        stack.enter_context(patch.object(runs.ssh_sync, "probe_home", side_effect=[(reason, None) for reason in probes]))
        prune = stack.enter_context(patch.object(runs.prune, "run", return_value=runs.prune.Result()))
        push = stack.enter_context(patch.object(runs.ssh_sync, "push", side_effect=pushes))
        stack.enter_context(patch.object(runs.ssh_sync, "put_file"))
        stack.enter_context(patch.object(runs.ssh_sync, "tracked_secret_matches", return_value=[]))
        stack.enter_context(patch.object(lease.ssh_sync, "close_master"))
        stop = stack.enter_context(patch.object(lease.api, "stop", return_value={}))
        cmd = stack.enter_context(patch.object(api, "cmd_start", return_value={"processId": 7, "commandId": "c"}))
        return rn, acquire, prune, push, stop, cmd

    def test_dead_mount_matches_known_errors(self):
        self.assertIsNotNone(ssh_sync.dead_mount(ENOTCONN_MKSTEMP))
        self.assertIsNotNone(ssh_sync.dead_mount(ENOTCONN_CHDIR))
        self.assertIsNotNone(ssh_sync.dead_mount(ECONNABORT))
        self.assertIsNone(ssh_sync.dead_mount("Permission denied"))
        self.assertIsNone(ssh_sync.dead_mount("connection unexpectedly closed"))

    def test_probe_home(self):
        ok = subprocess.CompletedProcess([], 0, b"OFFBOX_PROBE_OK\n", b"")
        dead = subprocess.CompletedProcess([], 1, b"", ENOTCONN_CHDIR.encode())
        denied = subprocess.CompletedProcess([], 1, b"", b"Permission denied")
        with patch.object(ssh_sync, "ssh", return_value=ok):
            self.assertIsNone(ssh_sync.probe_home("bxA")[0])
        with patch.object(ssh_sync, "ssh", return_value=dead):
            self.assertIn("Transport endpoint is not connected", ssh_sync.probe_home("bxA")[0])
        with patch.object(ssh_sync, "ssh", return_value=denied):
            self.assertIsNone(ssh_sync.probe_home("bxA")[0])
        with patch.object(ssh_sync, "ssh", side_effect=subprocess.TimeoutExpired("ssh", 45)):
            self.assertIsNone(ssh_sync.probe_home("bxA")[0])

    def test_probe_failure_sets_box_aside_and_uses_next_box(self):
        rn, acquire, prune, push, stop, cmd = self.run_start(
            pushes=[{}], probes=[ENOTCONN_CHDIR, None])
        row = rn.start()
        self.assertEqual(row["box_id"], "bxB")
        self.assertEqual(push.call_count, 1)
        self.assertEqual(push.call_args[0][0], "bxB")
        self.assertTrue(self.lease_row("bxA")["note"].startswith("dead-mount:"))
        self.assertEqual(self.lease_row("bxA")["state"], "stopped")
        stop.assert_called_once_with("bxA")
        self.assertIsNotNone(self.con.execute(
            "SELECT 1 FROM events WHERE box_id='bxA' AND kind='lease_dead_mount'").fetchone())
        self.assertNotIn(("prune", "bxA", "w/r"), [c.args for c in prune.call_args_list])
        err = self.quiet.getvalue() if hasattr(self.quiet, "getvalue") else ""
        self.assertEqual(self.con.execute("SELECT box_id FROM runs WHERE run_id=?", (rn.run_id,)).fetchone()[0], "bxB")
        self.assertIn("dead filesystem", err)
        self.assertIn("Trying another box", err)

    def test_push_enotconn_sets_box_aside_and_retries(self):
        rn, acquire, prune, push, stop, cmd = self.run_start(
            pushes=[OffboxError(f"rsync to bxA failed (23): {ENOTCONN_MKSTEMP}"), {}], probes=[None, None])
        row = rn.start()
        self.assertEqual(row["box_id"], "bxB")
        self.assertTrue(self.lease_row("bxA")["note"].startswith("dead-mount:"))
        self.assertEqual(push.call_args_list[-1][0][0], "bxB")

    def test_git_metadata_enotconn_is_classified_dead_mount(self):
        # rsync's stderr from the --git transfer must reach the error text, or the dead box is not set aside.
        rsync_fail = subprocess.CompletedProcess([], 23, "", ENOTCONN_MKSTEMP)
        ok = subprocess.CompletedProcess([], 0, b"", b"")
        with patch.object(ssh_sync, "ssh", return_value=ok), \
                patch.object(ssh_sync.subprocess, "run", return_value=rsync_fail):
            with self.assertRaises(OffboxError) as cm:
                ssh_sync._push_git("bxA", Path(self.tmp.name), "w/r", 60)
        self.assertIn("Transport endpoint is not connected", str(cm.exception))
        self.assertIsNotNone(ssh_sync.dead_mount(str(cm.exception)))

    def test_simultaneous_push_error_and_env_enotconn_still_sets_aside(self):
        # The env upload hit the dead mount while push failed with an ordinary error: the dead box must still go.
        self.box('bxA', member=True)
        self.box('bxB', member=True)
        rows = [dict(self.lease_row('bxA'), remote_dir='w/r'), dict(self.lease_row('bxB'), remote_dir='w/r')]
        env_dead = OffboxError("ssh bxA failed (255): Transport endpoint is not connected")
        push_plain = OffboxError("rsync to bxA failed (12): connection unexpectedly closed")
        rn = self.runner()
        with patch.object(runs.pool, "acquire", side_effect=rows), \
                patch.object(runs.ssh_sync, "probe_home", return_value=(None, None)), \
                patch.object(runs.prune, "run", return_value=runs.prune.Result()), \
                patch.object(runs.ssh_sync, "put_file", side_effect=[env_dead, None]), \
                patch.object(runs.ssh_sync, "push", side_effect=[push_plain, {}]), \
                patch.object(runs.ssh_sync, "tracked_secret_matches", return_value=[]), \
                patch.object(lease.ssh_sync, "close_master"), \
                patch.object(lease.api, "stop", return_value={}) as stop, \
                patch.object(api, "cmd_start", return_value={"processId": 7, "commandId": "c"}):
            row = rn.start()
        self.assertEqual(row["box_id"], "bxB")
        self.assertTrue(self.lease_row('bxA')["note"].startswith("dead-mount:"))
        stop.assert_called_once_with("bxA")

    def test_two_dead_boxes_fail_90_nothing_started(self):
        rn, acquire, prune, push, stop, cmd = self.run_start(
            pushes=[], probes=[ENOTCONN_CHDIR, ENOTCONN_CHDIR])
        with self.assertRaises(OffboxError) as cm:
            rn.start()
        self.assertEqual(cm.exception.code, 90)
        self.assertIn("both are set aside", str(cm.exception))
        self.assertFalse(rn.started)
        cmd.assert_not_called()
        self.assertTrue(self.lease_row("bxA")["note"].startswith("dead-mount:"))
        self.assertTrue(self.lease_row("bxB")["note"].startswith("dead-mount:"))

    def test_other_sync_errors_unchanged(self):
        self.box('bxA', member=True)
        err = OffboxError("rsync to bxA failed (12): connection unexpectedly closed")
        rn = self.runner()
        row = dict(self.lease_row('bxA'), remote_dir='w/r')
        with patch.object(runs.pool, "acquire", return_value=row) as acquire, \
                patch.object(runs.ssh_sync, "probe_home", return_value=(None, None)), \
                patch.object(runs.prune, "run", return_value=runs.prune.Result()), \
                patch.object(runs.ssh_sync, "put_file"), \
                patch.object(runs.ssh_sync, "push", side_effect=err), \
                patch.object(lease.api, "stop") as stop:
            with self.assertRaises(OffboxError) as cm:
                rn.start()
        self.assertIs(cm.exception, err)
        acquire.assert_called_once()
        self.assertIsNone(self.lease_row('bxA')["note"])
        stop.assert_not_called()

    def test_stop_failure_still_marks(self):
        self.box('bxA', member=True)
        with patch.object(lease.ssh_sync, "close_master"), \
                patch.object(lease.api, "stop", side_effect=OffboxError("boom")):
            lease.set_aside_dead_mount(self.con, 'bxA', 'Transport endpoint is not connected')
        self.assertTrue(self.lease_row('bxA')["note"].startswith("dead-mount:"))
        self.assertIsNotNone(self.con.execute(
            "SELECT 1 FROM events WHERE box_id='bxA' AND kind='lease_dead_mount_stop_failed'").fetchone())

    def test_dead_mount_box_leaves_pool(self):
        self.box('dead', state='stopped', member=True)
        self.box('busy', member=True)
        self.busy('busy')
        self.con.execute("UPDATE leases SET note=? WHERE box_id='dead'", ("dead-mount: x",))
        self.con.commit()
        self.assertNotIn('dead', [r["box_id"] for r in pool.members(self.con, 'repo')])
        self.assertNotIn('dead', [r["box_id"] for r in pool.candidates(self.con, 'repo', None, None)[0]])
        fresh = lambda me, size, template, base, fresh: dict(self.con.execute(
            "SELECT * FROM leases WHERE box_id='dead'").fetchone())
        with patch.object(lease, "acquire_private", side_effect=fresh) as new, \
                patch.object(lease, "_reuse") as reuse:
            pool.acquire(self.me)
        new.assert_called_once()
        reuse.assert_not_called()

    def test_fresh_in_full_pool_fails_fast(self):
        self.box('a', state='stopped', member=True)
        self.box('b', state='stopped', member=True)
        with patch.object(lease, "acquire_private") as new, patch.object(lease, "_reuse") as reuse:
            with self.assertRaises(OffboxError) as cm:
                pool.acquire(self.me, fresh=True)
        self.assertEqual(cm.exception.code, 2)
        self.assertIn("pool is full", str(cm.exception))
        self.assertIn("Nothing ran", str(cm.exception))
        new.assert_not_called()
        reuse.assert_not_called()

    def test_fresh_waits_when_a_fresh_member_is_busy(self):
        self.box('f', member=True, source='fresh')
        self.box('g', member=True)
        self.busy('f')
        with patch.object(lease, "acquire_private") as new, patch.object(lease, "_reuse") as reuse:
            with self.assertRaises(pool.PoolBusyError) as cm:
                pool.acquire(self.me, fresh=True)
        self.assertEqual(cm.exception.code, 92)
        new.assert_not_called()

    def test_list_shows_dead_mount_note(self):
        self.box('bxA', member=True)
        self.con.execute("UPDATE leases SET note=? WHERE box_id='bxA'", ("dead-mount: Transport endpoint",))
        self.con.commit()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            misc.list_leases(self.me, True, False)
        self.assertIn("[dead-mount: Transport endpoint]", out.getvalue())


if __name__ == "__main__":
    unittest.main()
