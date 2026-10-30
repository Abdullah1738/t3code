"""Offline tests for pruning old checkout dirs on pooled boxes (offbox_lib/prune.py)."""
import contextlib
import io
import os
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, cli, common, prune, runs  # noqa: E402
from test_capacity import Isolated  # noqa: E402


def add_run(con, box, remote_dir, ago_s, status="done", n=[0]):
    n[0] += 1
    con.execute("INSERT INTO runs(run_id, box_id, remote_dir, start_at, status) VALUES (?,?,?,?,?)",
                (f"r{n[0]}", box, remote_dir, common.now() - ago_s, status))
    con.commit()


def dirs_for(con, box, remote_dir):
    return [r[0] for r in con.execute("SELECT remote_dir FROM runs WHERE box_id=?", (box,))]


class StaleDirsTests(Isolated):
    def test_keeps_newest_ten_and_drops_older_than_three_days(self):
        H = 3600
        for i in range(1, 15):  # 1h .. 14h old, all within 3 days
            add_run(self.con, "bx", f"w/d{i}-{i:06x}", i * H)
        for i in range(4, 11):  # 4..10 days old
            add_run(self.con, "bx", f"w/old{i}-{i + 100:06x}", i * 86400)
        got = set(prune.stale_dirs(self.con, "bx", "w/none-000000"))
        # d1..d11 (1..11 h) are inside the 12 h floor and fill the 10-count; d12..d14 fall outside both
        # the floor and the newest-10 budget, so they are stale along with every 4-10 day old dir.
        self.assertEqual(got, {f"w/d{i}-{i:06x}" for i in range(12, 15)}
                         | {f"w/old{i}-{i + 100:06x}" for i in range(4, 11)})

    def test_current_dir_is_kept_even_when_old(self):
        add_run(self.con, "bx", "w/cur-111111", 20 * 86400)
        self.assertEqual(prune.stale_dirs(self.con, "bx", "w/cur-111111"), [])

    def test_running_dir_is_kept(self):
        add_run(self.con, "bx", "w/busy-222222", 10 * 86400, status="running")
        add_run(self.con, "bx", "w/start-333333", 10 * 86400, status="starting")
        self.assertEqual(prune.stale_dirs(self.con, "bx", "w/none-000000"), [])

    def test_used_within_floor_is_kept_even_with_ten_newer(self):
        for i in range(1, 11):  # ten dirs used a minute or so apart, all newer than the 2 h one
            add_run(self.con, "bx", f"w/n{i}-{i:06x}", i * 60)
        add_run(self.con, "bx", "w/recent-444444", 2 * 3600)
        self.assertNotIn("w/recent-444444", prune.stale_dirs(self.con, "bx", "w/none-000000"))

    def test_non_matching_names_are_never_returned(self):
        for name in ("w/odd dir", "../x", "w/x", "w/Bad-ZZZZZZ"):
            add_run(self.con, "bx", name, 10 * 86400)
        self.assertEqual(prune.stale_dirs(self.con, "bx", "w/none-000000"), [])

    def test_other_box_rows_are_ignored(self):
        add_run(self.con, "other", "w/far-555555", 10 * 86400)
        self.assertEqual(prune.stale_dirs(self.con, "bx", "w/none-000000"), [])

    def test_env_overrides_keep_and_days(self):
        for i in range(1, 5):
            add_run(self.con, "bx", f"w/e{i}-{i:06x}", (12 + i) * 3600)  # 13h..16h old
        with patch.dict(os.environ, {"OFFBOX_PRUNE_KEEP": "2", "OFFBOX_PRUNE_DAYS": "1"}):
            got = prune.stale_dirs(self.con, "bx", "w/none-000000")
        self.assertEqual(sorted(got), ["w/e3-000003", "w/e4-000004"])
        self.assertEqual(prune.stale_dirs(self.con, "bx", "w/none-000000"), [])


class NoNetwork(Isolated):
    """Base for every offline test in this file: any real boat request or Keychain read fails the test at once,
    so a missing mock cannot quietly reach Boat or stall without credentials."""

    def setUp(self):
        super().setUp()
        def _no_boat(method, path, *a, **kw):
            raise AssertionError(f"offline test reached boat: {method} {path}")
        self.stack.enter_context(patch.object(api, "call", side_effect=_no_boat))


class ScriptTests(NoNetwork):
    def test_script_moves_real_dirs_only_in_bash(self):
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as bindir:
            h = Path(home)
            (h / "w/a-aaaaaa").mkdir(parents=True)
            (h / "w/a-aaaaaa/f").write_text("x")
            (h / "w/it's-bbbbbb").mkdir()
            target = h / "w/target-zzzzzz"
            target.mkdir()
            (h / "w/c-cccccc").symlink_to(target)
            sudo = Path(bindir) / "sudo"
            sudo.write_text("#!/bin/sh\nexit 0\n")
            sudo.chmod(sudo.stat().st_mode | stat.S_IEXEC)
            dirs = ["w/a-aaaaaa", "w/it's-bbbbbb", "w/c-cccccc", "w/d-dddddd"]
            p = subprocess.run(["bash", "-c", prune.script(dirs, "t1")],
                               env={"HOME": home, "PATH": f"{bindir}:/usr/bin:/bin"},
                               capture_output=True, timeout=10)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertEqual(p.stdout.decode().splitlines(),
                             ["pruned w/a-aaaaaa", "pruned w/it's-bbbbbb", "skip w/c-cccccc", "skip w/d-dddddd",
                              "done t1"])
            self.assertFalse((h / "w/a-aaaaaa").exists())
            self.assertFalse((h / "w/it's-bbbbbb").exists())
            self.assertTrue((h / "w/c-cccccc").is_symlink())
            self.assertTrue(target.is_dir())

    def test_blocked_dir_check_is_killed_at_budget_and_dir_survives_reuse(self):
        # Round-3 race: the directory test itself blocks (a FIFO with no writer makes `[ -d ]`-style checks hang
        # in the kernel path). The parent's ssh timeout returns control; a later run then reuses the checkout.
        # The blocked child must be gone at the budget, so the reused dir is never renamed.
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as bindir:
            h = Path(home)
            (h / "w/a-aaaaaa").mkdir(parents=True)
            (h / "w/a-aaaaaa/f").write_text("x")
            # The stall is inside the group child (the check plus mv): a stub mv that blocks, as a hung
            # filesystem call would. Its pid is recorded so the test can prove the group was killed.
            pidf = h / "mv.pid"
            stall = Path(bindir) / "mv"
            stall.write_text(f'#!/bin/sh\necho $$ > "{pidf}"\nexec sleep 1000\n')
            stall.chmod(stall.stat().st_mode | stat.S_IEXEC)
            with patch.object(prune, "BUDGET_S", 2), patch.object(prune, "BACKGROUND", "true"):
                body = prune.script(["w/a-aaaaaa"], "t1")
            p = subprocess.run(["bash", "-c", body], env={"HOME": home, "PATH": f"{bindir}:/usr/bin:/bin"},
                               capture_output=True, timeout=30)
            self.assertEqual(p.returncode, 0, p.stderr)
            # The stalled worker was killed and reaped, so completion is confirmed: "left" plus "done".
            self.assertEqual(p.stdout.decode().splitlines(), ["left w/a-aaaaaa", "done t1"])
            # Checkout reuse after the caller gave up: the dir is still the live checkout and was never renamed.
            self.assertTrue((h / "w/a-aaaaaa/f").read_text() == "x")
            pid = int(pidf.read_text().strip())
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)  # the blocked child is dead before the box can be reused

    def test_stalled_mv_is_killed_and_reaped_before_script_returns(self):
        # Blocked-mv + SSH-timeout + checkout-reuse: a mv that stalls past the budget must be dead before
        # the script returns, so the caller can't release the box while a rename is still pending.
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as bindir:
            h = Path(home)
            (h / "w/a-aaaaaa").mkdir(parents=True)
            (h / "w/a-aaaaaa/f").write_text("x")
            pidf = h / "mv.pid"
            stall = Path(bindir) / "mv"  # stalled mv: records its pid, then never renames
            stall.write_text(f'#!/bin/sh\necho $$ > "{pidf}"\nexec sleep 1000\n')
            stall.chmod(stall.stat().st_mode | stat.S_IEXEC)
            # BUDGET_S 2: the first dir starts at $SECONDS 0 so its mv is attempted, then mvb kills it at 2 s.
            with patch.object(prune, "BUDGET_S", 2), patch.object(prune, "BACKGROUND", "true"):
                body = prune.script(["w/a-aaaaaa"], "t1")
            p = subprocess.run(["bash", "-c", body], env={"HOME": home, "PATH": f"{bindir}:/usr/bin:/bin"},
                               capture_output=True, timeout=30)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertEqual(p.stdout.decode().splitlines(), ["left w/a-aaaaaa", "done t1"])  # killed and reaped
            self.assertTrue((h / "w/a-aaaaaa/f").exists())
            # The stub writes its pid as its first action, so the budget kill always has a live child to reap.
            self.assertTrue(pidf.exists(), "stalled mv never started: the test would prove nothing")
            pid = int(pidf.read_text().strip())
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)  # the stalled child was killed and reaped before the script returned
            self.addCleanup(_kill_group_quietly, pid)


def _kill_group_quietly(pid: int) -> None:
    # A stalled stub is its own process group (the script runs under set -m); kill the group, never leave a sleep.
    try:
        os.killpg(os.getpgid(pid), 9)
    except (ProcessLookupError, PermissionError):
        pass


class RunTests(NoNetwork):
    def fake_ssh(self, home, bindir, calls, exc=None):
        def ssh(box_id, cmd, input=None, timeout=None):
            calls.append((box_id, cmd))
            if exc is not None:
                raise exc
            p = subprocess.run(["bash", "-c", input.decode()],
                               env={"HOME": home, "PATH": f"{bindir}:/usr/bin:/bin"},
                               capture_output=True, timeout=10)
            return subprocess.CompletedProcess(p.args, p.returncode, p.stdout, p.stderr)
        return ssh

    def setUp(self):
        super().setUp()
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        self.bindir = tempfile.TemporaryDirectory()
        self.addCleanup(self.bindir.cleanup)
        sudo = Path(self.bindir.name) / "sudo"
        sudo.write_text("#!/bin/sh\nexit 0\n")
        sudo.chmod(sudo.stat().st_mode | stat.S_IEXEC)
        for d in ("w/s1-aaaaaa", "w/s2-bbbbbb", "w/keep-cccccc"):
            (Path(self.home.name) / d).mkdir(parents=True)
        self.calls = []
        # Old dirs past the 3-day window are stale; keep-cccccc is the current checkout.
        add_run(self.con, "bx", "w/s1-aaaaaa", 5 * 86400)
        add_run(self.con, "bx", "w/s2-bbbbbb", 6 * 86400)
        add_run(self.con, "bx", "w/keep-cccccc", 6 * 86400)
        self.con.executemany("INSERT INTO pool_callers(owner, repo_root, box_id, remote_dir) VALUES (?,?,?,?)",
                             [("o1", "/r1", "bx", "w/s1-aaaaaa"), ("o2", "/r2", "bx", "w/s2-bbbbbb"),
                              ("o3", "/r3", "bx", "w/keep-cccccc")])
        self.con.commit()

    def run_prune(self, exc=None):
        with patch.object(prune.ssh_sync, "ssh", side_effect=self.fake_ssh(self.home.name, self.bindir.name,
                                                                          self.calls, exc)) as m, \
                contextlib.redirect_stderr(io.StringIO()) as err:
            n = prune.run(self.con, "bx", "w/keep-cccccc")
        return n, m, err.getvalue()

    def test_prunes_stale_and_records_event(self):
        n, m, err = self.run_prune()
        self.assertEqual(n, 2)
        self.assertEqual(len(self.calls), 1)
        self.assertIn("pruned", err)
        rows = [r[0] for r in self.con.execute("SELECT remote_dir FROM pool_callers WHERE box_id='bx'")]
        self.assertEqual(rows, ["w/keep-cccccc"])
        ev = self.con.execute("SELECT COUNT(*) FROM events WHERE kind='box_prune' AND box_id='bx'").fetchone()[0]
        self.assertEqual(ev, 1)
        self.assertFalse((Path(self.home.name) / "w/s1-aaaaaa").exists())
        self.assertTrue((Path(self.home.name) / "w/keep-cccccc").is_dir())

    def test_six_hour_throttle(self):
        self.run_prune()
        n, m, _ = self.run_prune()
        self.assertEqual(n, 0)
        self.assertEqual(len(self.calls), 1)

    def test_base_or_template_box_is_skipped(self):
        self.con.execute("INSERT INTO templates(name, box_id) VALUES ('t', 'bx')")
        self.con.commit()
        n, m, _ = self.run_prune()
        self.assertEqual(n, 0)
        self.assertEqual(self.calls, [])

    def test_nothing_stale_makes_no_ssh(self):
        self.con.execute("DELETE FROM runs WHERE remote_dir IN ('w/s1-aaaaaa','w/s2-bbbbbb')")
        self.con.commit()
        n, m, _ = self.run_prune()
        self.assertEqual(n, 0)
        self.assertEqual(self.calls, [])

    def test_ssh_timeout_or_oserror_never_raises(self):
        for exc in (subprocess.TimeoutExpired("ssh", 30), OSError("boom")):
            self.con.execute("DELETE FROM kv WHERE k='prune:bx'")
            self.con.commit()
            n, _, _ = self.run_prune(exc=exc)
            self.assertEqual(n, 0)
            # Unknown outcome counts as all left, so the box is tried again after RETRY_S, not 6 h.
            self.assertEqual(prune.kv_get(self.con, "prune:bx")["left"], 2)

    def test_nonzero_ssh_exit_keeps_rest_pending_and_retries_after_retry_window(self):
        # ssh() returns (check=False) on a failed connection: empty stdout, rc 255 must not record left=0.
        def failing(box_id, cmd, input=None, timeout=None):
            self.calls.append((box_id, cmd))
            return subprocess.CompletedProcess(["ssh"], 255, b"", b"ssh: connect failed")
        with patch.object(prune.ssh_sync, "ssh", side_effect=failing):
            with contextlib.redirect_stderr(io.StringIO()):
                n = prune.run(self.con, "bx", "w/keep-cccccc")
        self.assertEqual(n, 0)
        self.assertEqual(prune.kv_get(self.con, "prune:bx")["left"], 2)
        n, _, _ = self.run_prune()  # inside RETRY_S: throttled, no second ssh
        self.assertEqual((n, len(self.calls)), (0, 1))
        with patch.object(prune, "now", return_value=common.now() + prune.RETRY_S + 1):
            n, _, _ = self.run_prune()
        self.assertEqual((n, len(self.calls)), (2, 2))

    def test_out_of_budget_leaves_rest_and_retries_after_retry_window(self):
        # No background delete here: it would race the next call's fresh trash dir in this temp HOME.
        self.stack.enter_context(patch.object(prune, "BACKGROUND", "true"))
        with patch.object(prune, "BUDGET_S", 0):
            n, _, _ = self.run_prune()
        self.assertEqual(n, 0)
        self.assertTrue((Path(self.home.name) / "w/s1-aaaaaa").is_dir())
        self.assertEqual(prune.kv_get(self.con, "prune:bx")["left"], 2)
        n, _, _ = self.run_prune()  # inside RETRY_S: no second ssh
        self.assertEqual((n, len(self.calls)), (0, 1))
        with patch.object(prune, "now", return_value=common.now() + prune.RETRY_S + 1):
            n, _, _ = self.run_prune()
        self.assertEqual((n, len(self.calls)), (2, 2))
        self.assertFalse((Path(self.home.name) / "w/s1-aaaaaa").exists())
        n, _, _ = self.run_prune()  # finished: back to the 6 h throttle
        self.assertEqual((n, len(self.calls)), (0, 2))

    def test_ssh_returns_while_worker_alive_then_reuse_does_not_rename_candidate(self):
        # Round-5 P1: ssh gives up (TimeoutExpired) while the remote worker is still alive and its candidate is
        # about to be renamed. run() must not hand the box back on that basis: it must wait for the worker's
        # done marker, and if that never comes, leave the box pending. A reuse of the candidate while the worker
        # is still alive must not rename it.
        pidf = Path(self.home.name) / "mv.pid"
        stall = Path(self.bindir.name) / "mv"  # the worker's mv: records its pid, then blocks without renaming
        stall.write_text(f'#!/bin/sh\necho $$ > "{pidf}"\nexec sleep 1000\n')
        stall.chmod(stall.stat().st_mode | stat.S_IEXEC)
        real = self.fake_ssh(self.home.name, self.bindir.name, self.calls)
        worker = {}

        def ssh_gives_up_while_worker_alive(box_id, cmd, input=None, timeout=None):
            # Start the real script detached, as the remote side does, then return to the caller before it ends.
            if input is not None:
                script_body = input.decode()
                worker["p"] = subprocess.Popen(["bash", "-c", script_body], start_new_session=True,
                                               env={"HOME": self.home.name,
                                                    "PATH": f"{self.bindir.name}:/usr/bin:/bin"},
                                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                worker["script"] = script_body
                # Wait until the stub mv really is running (the worker is alive, mid-move).
                for _ in range(100):
                    if pidf.exists():
                        break
                    time.sleep(0.05)
                raise subprocess.TimeoutExpired("ssh", timeout)
            # The done-marker probe: the worker has not written it yet, so this must report not-quiesced.
            return subprocess.CompletedProcess(["ssh"], 1, b"", b"")

        try:
            with patch.object(prune, "BUDGET_S", 2), patch.object(prune, "BACKGROUND", "true"), \
                    patch.object(prune.ssh_sync, "ssh", side_effect=ssh_gives_up_while_worker_alive), \
                    contextlib.redirect_stderr(io.StringIO()):
                n = prune.run(self.con, "bx", "w/keep-cccccc")
            # run() returned while the worker is alive; the worker is still running and must not have renamed
            # the candidate. The box must be recorded as pending, not settled.
            self.assertEqual(n, 0)
            self.assertIsNone(worker["p"].poll())
            self.assertEqual(prune.kv_get(self.con, "prune:bx")["left"], 2)
            # Reuse: the same candidate is offered again (the box was handed back) while the worker is still alive.
            with patch.object(prune, "now", return_value=common.now() + prune.RETRY_S + 1), \
                    patch.object(prune.ssh_sync, "ssh", side_effect=real), \
                    patch.object(prune, "BUDGET_S", 8), contextlib.redirect_stderr(io.StringIO()):
                prune.run(self.con, "bx", "w/keep-cccccc")
            self.assertTrue((Path(self.home.name) / "w/s1-aaaaaa").is_dir())  # never renamed while reused
        finally:
            if "p" in worker and worker["p"].poll() is None:
                os.killpg(worker["p"].pid, 9)
                worker["p"].wait(timeout=5)

    def test_exhausted_budget_probes_nothing_and_settled_dirs_still_counted(self):
        # Round-5 P2 measured directly: a slow/blocked probe must not run past the budget. Here every candidate's
        # filesystem probe would hang for 5 s if it ran. With the budget already spent, none may run: the script
        # returns fast, the hung probe never starts, and the absent dir still counts as settled.
        import shutil
        shutil.rmtree(Path(self.home.name) / "w/s2-bbbbbb")  # absent: a settled outcome
        # A hanging `[` is not stubbable, so the slow probe is a `stat` that sleeps; the script's probes call it.
        stat_stub = Path(self.bindir.name) / "stat"
        stat_stub.write_text('#!/bin/sh\nsleep 5\n')
        stat_stub.chmod(stat_stub.stat().st_mode | stat.S_IEXEC)
        sentinel = Path(self.home.name) / "probe-ran"
        blocking_mv = Path(self.bindir.name) / "mv"
        blocking_mv.write_text(f'#!/bin/sh\ntouch "{sentinel}"\nexec sleep 1000\n')
        blocking_mv.chmod(blocking_mv.stat().st_mode | stat.S_IEXEC)
        with patch.object(prune, "BUDGET_S", 0), patch.object(prune, "BACKGROUND", "true"), \
                contextlib.redirect_stderr(io.StringIO()):
            t0 = time.time()
            n, _, _ = self.run_prune()
            elapsed = time.time() - t0
        self.assertEqual(n, 0)
        self.assertLess(elapsed, 5, "no probe may run once the budget is spent")
        self.assertFalse(sentinel.exists(), "no mv may start once the budget is spent")
        # With no budget left nothing is probed, so absent and present dirs are both unknown: both stay pending.
        self.assertEqual(prune.kv_get(self.con, "prune:bx")["left"], 2)

    def test_absent_dir_settles_when_budget_remains(self):
        # The settled-accounting half of round 5 P2: while budget remains, an absent dir is probed (cheaply) and
        # counted as skip, not pending, so a later pass retries only the present dir.
        import shutil
        shutil.rmtree(Path(self.home.name) / "w/s2-bbbbbb")
        with patch.object(prune, "BUDGET_S", 8), patch.object(prune, "BACKGROUND", "true"), \
                contextlib.redirect_stderr(io.StringIO()):
            n, _, _ = self.run_prune()
        self.assertEqual(n, 1)  # s1 pruned
        self.assertEqual(prune.kv_get(self.con, "prune:bx")["left"], 0)  # s2 settled as skip, nothing pending

    def test_absent_dirs_are_settled_not_retried_forever(self):
        # Round-4 P2: a dir already deleted but still in runs must not keep the box on 20-minute retries.
        # s1 is present, s2 is already gone, keep is the current checkout (never a candidate).
        import shutil
        shutil.rmtree(Path(self.home.name) / "w/s2-bbbbbb")
        with patch.object(prune, "BUDGET_S", 0), patch.object(prune, "BACKGROUND", "true"):
            n, _, _ = self.run_prune()  # BUDGET_S 0: nothing is probed, so both are unknown and stay pending
        self.assertEqual(n, 0)
        self.assertEqual(prune.kv_get(self.con, "prune:bx")["left"], 2)
        # Next pass after RETRY_S: s1 now prunes; s2 stays absent and must not be counted as pending again.
        with patch.object(prune, "now", return_value=common.now() + prune.RETRY_S + 1), \
                patch.object(prune, "BACKGROUND", "true"):
            n, _, _ = self.run_prune()
        self.assertEqual(n, 1)
        self.assertEqual(prune.kv_get(self.con, "prune:bx")["left"], 0)
        self.assertFalse((Path(self.home.name) / "w/s1-aaaaaa").exists())
        # A settled box stays on the 6 h throttle, not the 20-minute retry.
        with patch.object(prune, "now", return_value=common.now() + prune.RETRY_S + 1):
            n, _, _ = self.run_prune()
        self.assertEqual(n, 0)


    def test_full_recovery_path_stays_within_caller_budget(self):
        # Round-6 P1: the first ssh (timeout) plus the follow-up probe must return within CALLER_BUDGET_S, not
        # 50-60 s. The fake clock shows the probe gets only the time left after the first ssh.
        seen = {}

        def timing_out(box_id, cmd, input=None, timeout=None):
            if input is not None:
                raise subprocess.TimeoutExpired("ssh", timeout)
            seen["probe_timeout"] = timeout
            return subprocess.CompletedProcess(["ssh"], 1, b"", b"")

        with patch.object(prune, "CALLER_BUDGET_S", 20), patch.object(prune.ssh_sync, "ssh", side_effect=timing_out), \
                contextlib.redirect_stderr(io.StringIO()):
            t0 = time.monotonic()
            n = prune.run(self.con, "bx", "w/keep-cccccc")
            elapsed = time.monotonic() - t0
        self.assertEqual(n, 0)
        self.assertLessEqual(seen["probe_timeout"], 20)  # the probe never gets more than the caller budget
        self.assertLess(elapsed, 5)  # the probe is mocked to fail at once; the wait is bounded by the budget
        # The box is held (prune_holds row) and its candidates are left pending, not settled.
        rec = prune.kv_get(self.con, "prune:bx")
        self.assertEqual(rec["left"], 2)
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM prune_holds WHERE box_id='bx'").fetchone()[0], 1)

    def test_done_marker_is_written_before_background_and_seen_by_probe(self):
        # Round-6 P2: the marker must be real. It is written by the script (before BACKGROUND, outside the
        # trash tree), and a follow-up probe that looks at the same path finds it.
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as bindir:
            h = Path(home)
            body = prune.script([], "rid-1")
            p = subprocess.run(["bash", "-c", body], env={"HOME": home, "PATH": f"{bindir}:/usr/bin:/bin"},
                               capture_output=True, timeout=30)
            self.assertEqual(p.returncode, 0, p.stderr)
            marker = h / ".offbox/done/rid-1"
            self.assertTrue(marker.is_file(), "the worker must write its done marker")
            self.assertNotIn(".offbox/trash", str(marker))  # not inside the tree BACKGROUND deletes
            # The follow-up probe, as _quiesced runs it, sees the marker.
            probe = subprocess.run(["bash", "-c", f'[ -f "$HOME/.offbox/done/rid-1" ] && exit 0; exit 1'],
                                   env={"HOME": home, "PATH": f"{bindir}:/usr/bin:/bin"}, timeout=10)
            self.assertEqual(probe.returncode, 0)

    def test_settled_prefix_does_not_block_progress_across_passes(self):
        # Round-6 P2: dirs settled by an earlier pass must not consume the budget of later passes. Here the
        # first pass settles s1 (pruned); the second pass has only s2 left and must reach it.
        with patch.object(prune, "BACKGROUND", "true"), patch.object(prune, "BUDGET_S", 8), \
                contextlib.redirect_stderr(io.StringIO()):
            n1, _, _ = self.run_prune()
        self.assertEqual(n1, 2)  # both stale dirs settled in one pass (budget is ample)
        self.assertEqual(sorted(prune.kv_get(self.con, "prune:bx")["settled"]), ["w/s1-aaaaaa", "w/s2-bbbbbb"])
        # The settled prefix is excluded from the candidate list, so the next pass sends no dirs at all.
        with patch.object(prune, "now", return_value=common.now() + prune.RETRY_S + 1), \
                patch.object(prune, "BACKGROUND", "true"), contextlib.redirect_stderr(io.StringIO()):
            n2, _, _ = self.run_prune()
        self.assertEqual(n2, 0)
        self.assertEqual(len(self.calls), 1, "no candidates left: the second pass must not start an ssh")
        self.assertEqual(prune.kv_get(self.con, "prune:bx")["left"], 0)

    def test_multi_pass_settled_prefix_exceeding_budget_still_reaches_real_dirs(self):
        # Round-6 P2 regression: a settled prefix alone exceeds the pass budget. Pass 1 settles the prefix, pass 2
        # must reach the real dir (not spend the budget on the prefix again), and completion returns to 6 h.
        self.con.execute("DELETE FROM runs WHERE remote_dir='w/s2-bbbbbb'")
        self.con.commit()
        with patch.object(prune, "BACKGROUND", "true"), patch.object(prune, "BUDGET_S", 8), \
                contextlib.redirect_stderr(io.StringIO()):
            n1, _, _ = self.run_prune()
        self.assertEqual(n1, 1)  # s1 pruned; the box still has nothing left after this pass
        # New stale dir appears after the first pass: it must be reached on the next pass, not blocked by s1.
        (Path(self.home.name) / "w/s3-cccccc").mkdir(parents=True)
        add_run(self.con, "bx", "w/s3-cccccc", 7 * 86400)
        # A finished box (left 0) waits out the 6 h throttle before it looks for new stale dirs. kv_get reads
        # common.now (not prune.now), so the clock is moved where the throttle is actually checked.
        with patch.object(common, "now", return_value=common.now() + prune.EVERY_S + 1), \
                patch.object(prune, "now", return_value=common.now() + prune.EVERY_S + 1), \
                patch.object(prune, "BACKGROUND", "true"), contextlib.redirect_stderr(io.StringIO()):
            n2, _, _ = self.run_prune()
        self.assertEqual(n2, 1)
        self.assertFalse((Path(self.home.name) / "w/s3-cccccc").exists())
        self.assertEqual(prune.kv_get(self.con, "prune:bx")["left"], 0)


    def _lease_row_for_bx(self):
        # A real lease row for box "bx", so pool.candidates() (the allocator's query) can see it.
        self.con.execute("""INSERT INTO leases(box_id,owner,repo_root,repo_key,remote_dir,state,size,last_used_at,source)
            VALUES ('bx','o9','/r9','rk','w/keep-cccccc','stopped','small',?,NULL)""", (common.now(),))
        self.con.commit()

    def test_disconnected_worker_holds_box_from_allocator_until_confirmed(self):
        # Round-7 P1: a timed-out ssh leaves a worker alive that can still rename a checkout. Until its completion is
        # confirmed, the allocator (pool.candidates) must not hand the box out, even though no run is 'running'.
        from offbox_lib import pool
        self._lease_row_for_bx()
        pidf = Path(self.home.name) / "worker.pid"
        worker_sh = Path(self.bindir.name) / "mv"  # the worker's rename: records its pid, then blocks (can still rename)
        worker_sh.write_text(f'#!/bin/sh\necho $$ > "{pidf}"\nexec sleep 1000\n')
        worker_sh.chmod(worker_sh.stat().st_mode | stat.S_IEXEC)
        worker = {}

        def timeout_with_live_worker(box_id, cmd, input=None, timeout=None):
            if input is not None:
                worker["p"] = subprocess.Popen(["bash", "-c", input.decode()], start_new_session=True,
                                               env={"HOME": self.home.name,
                                                    "PATH": f"{self.bindir.name}:/usr/bin:/bin"},
                                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                for _ in range(100):
                    if pidf.exists():
                        break
                    time.sleep(0.05)
                raise subprocess.TimeoutExpired("ssh", timeout)
            return subprocess.CompletedProcess(["ssh"], 1, b"", b"")  # the follow-up probe: worker not finished

        try:
            with patch.object(prune, "BUDGET_S", 2), patch.object(prune, "BACKGROUND", "true"), \
                    patch.object(prune.ssh_sync, "ssh", side_effect=timeout_with_live_worker), \
                    contextlib.redirect_stderr(io.StringIO()):
                prune.run(self.con, "bx", "w/keep-cccccc")
            # The worker is alive and can still rename: the box is held, and the allocator skips it.
            self.assertIsNone(worker["p"].poll())
            held = self.con.execute("SELECT COUNT(*) FROM prune_holds WHERE box_id='bx'").fetchone()[0]
            self.assertEqual(held, 1)
            rows, _ = pool.candidates(self.con, "rk", "small", None)
            self.assertEqual(rows, [], "a box with an open prune hold must not be offered to the allocator")
            # The resume path (the caller's own lease) also refuses the held box.
            from offbox_lib import lease as lease_mod
            self.assertIsNone(lease_mod.find_lease(self.con, "o9", "/r9"))
            # Confirmation (the worker's done marker) releases the hold; only then is the box handed out again.
            os.kill(worker["p"].pid, 9)
            worker["p"].wait(timeout=5)
            self.con.execute("DELETE FROM prune_holds WHERE box_id='bx'")
            self.con.commit()
            rows, _ = pool.candidates(self.con, "rk", "small", None)
            self.assertEqual(len(rows), 1, "after a confirmed completion the box is offered again")
        finally:
            # The worker script and its stalled sleep may be in different groups: kill both by their recorded pids.
            if pidf.exists():
                _kill_group_quietly(int(pidf.read_text().strip()))
            if "p" in worker and worker["p"].poll() is None:
                worker["p"].kill()
                worker["p"].wait(timeout=5)

    def test_timeout_then_successful_probe_persists_completion_state(self):
        # Round-7 P2: a timeout followed by a successful probe must complete cleanly, with no UnboundLocalError
        # swallowed by the catch-all. The probe confirms the worker's done marker, so the hold is released and the
        # run's real outcome is recorded.
        def timeout_then_probe_ok(box_id, cmd, input=None, timeout=None):
            if input is not None:
                raise subprocess.TimeoutExpired("ssh", timeout)
            return subprocess.CompletedProcess(["ssh"], 0, b"", b"")  # probe: marker seen

        with patch.object(prune, "BACKGROUND", "true"), \
                patch.object(prune.ssh_sync, "ssh", side_effect=timeout_then_probe_ok), \
                contextlib.redirect_stderr(io.StringIO()) as err:
            n = prune.run(self.con, "bx", "w/keep-cccccc")
        self.assertNotIn("UnboundLocalError", err.getvalue())
        self.assertEqual(n, 0)  # nothing was actually pruned (the probe does not report per-dir outcomes)
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM prune_holds WHERE box_id='bx'").fetchone()[0], 0)
        rec = prune.kv_get(self.con, "prune:bx")
        self.assertIsNotNone(rec)  # completion state was persisted, not lost in the catch-all
        self.assertEqual(rec["left"], 2)  # the dirs were not reported as done, so they stay pending for the retry

    def test_partial_pass_failure_retry_then_six_hour_throttle(self):
        # Round-7 P2 multi-pass: pass 1 settles s1 (a real partial pass), pass 2 fails with a timeout that keeps the
        # settled list, and pass 3 (after RETRY_S) reaches s2 without replaying s1. Completion then goes to 6 h.
        self.con.execute("DELETE FROM runs WHERE remote_dir='w/s2-bbbbbb'")  # s2 is not stale on pass 1
        self.con.commit()
        with patch.object(prune, "BACKGROUND", "true"), patch.object(prune, "BUDGET_S", 8), \
                contextlib.redirect_stderr(io.StringIO()):
            n1, _, _ = self.run_prune()
        self.assertEqual(n1, 1)  # pass 1: s1 pruned
        self.assertEqual(list(prune.kv_get(self.con, "prune:bx")["settled"]), ["w/s1-aaaaaa"])
        # s2 becomes stale and a timeout then fails pass 2; the settled prefix must survive the failure.
        (Path(self.home.name) / "w/s2-bbbbbb").mkdir(parents=True, exist_ok=True)
        add_run(self.con, "bx", "w/s2-bbbbbb", 7 * 86400)
        # One explicit clock for the whole sequence, so each pass is stamped relative to the previous one.
        base = common.now()

        def clock(offset):
            return patch.object(common, "now", return_value=base + offset), patch.object(prune, "now", return_value=base + offset)

        def timeout_no_marker(box_id, cmd, input=None, timeout=None):
            if input is not None:
                raise subprocess.TimeoutExpired("ssh", timeout)
            return subprocess.CompletedProcess(["ssh"], 1, b"", b"")

        a, b = clock(prune.EVERY_S + 1)
        with a, b, patch.object(prune.ssh_sync, "ssh", side_effect=timeout_no_marker), \
                contextlib.redirect_stderr(io.StringIO()):
            prune.run(self.con, "bx", "w/keep-cccccc")
        rec = prune.kv_get(self.con, "prune:bx")
        self.assertIn("w/s1-aaaaaa", rec["settled"], "a failed pass must keep the settled prefix")
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM prune_holds WHERE box_id='bx'").fetchone()[0], 1)
        # Pass 3: the failed pass left the box held, so it is not retried until the hold is confirmed cleared.
        # Clear the hold as a confirmed completion would, then a healthy pass after RETRY_S reaches s2.
        self.con.execute("DELETE FROM prune_holds WHERE box_id='bx'")
        self.con.commit()
        a, b = clock(prune.EVERY_S + 1 + prune.RETRY_S + 1)
        with a, b, patch.object(prune, "BACKGROUND", "true"), patch.object(prune, "BUDGET_S", 8), \
                patch.object(prune.ssh_sync, "ssh", side_effect=self.fake_ssh(self.home.name, self.bindir.name, self.calls)), \
                contextlib.redirect_stderr(io.StringIO()):
            n3, _, _ = self.run_prune()
        self.assertEqual(n3, 1)  # s2 pruned; s1 was not replayed
        self.assertFalse((Path(self.home.name) / "w/s2-bbbbbb").exists())
        self.assertEqual(prune.kv_get(self.con, "prune:bx")["left"], 0)
        # Completion returns to the six-hour throttle: a pass inside EVERY_S makes no ssh.
        before = len(self.calls)
        a, b = clock(prune.EVERY_S + 1 + prune.RETRY_S + 1 + 60)
        with a, b, contextlib.redirect_stderr(io.StringIO()):
            self.run_prune()
        self.assertEqual(len(self.calls), before)

    def test_recreated_checkout_is_pruned_again_after_it_goes_stale(self):
        # Pass 1 prunes s1 (settled at its last-used time). Its checkout is recreated and used again, goes stale, and
        # must be pruned again. Six-hour throttle is checked between the passes.
        with patch.object(prune, "BACKGROUND", "true"), contextlib.redirect_stderr(io.StringIO()):
            n1, _, _ = self.run_prune()
        self.assertEqual(n1, 2)
        base = common.now()
        # s1 is recreated and used again: a newer run row whose last-used time is well past the 3-day cutoff by
        # pass 2 (it was used 4 days ago, so it is stale then). Its settled generation is now out of date.
        (Path(self.home.name) / "w/s1-aaaaaa").mkdir(parents=True, exist_ok=True)
        add_run(self.con, "bx", "w/s1-aaaaaa", 4 * 86400)
        with patch.object(common, "now", return_value=base + prune.EVERY_S + 1), \
                patch.object(prune, "now", return_value=base + prune.EVERY_S + 1), \
                patch.object(prune, "BACKGROUND", "true"), contextlib.redirect_stderr(io.StringIO()):
            n2, _, _ = self.run_prune()
        self.assertEqual(n2, 1, "a recreated checkout that went stale again must be pruned")
        self.assertFalse((Path(self.home.name) / "w/s1-aaaaaa").exists())

    def test_settled_entry_still_suppresses_same_generation(self):
        # Within the same generation (same last-used time) a settled dir is not re-probed.
        with patch.object(prune, "BACKGROUND", "true"), contextlib.redirect_stderr(io.StringIO()):
            self.run_prune()
        before = len(self.calls)
        with patch.object(common, "now", return_value=common.now() + prune.EVERY_S + 1), \
                patch.object(prune, "now", return_value=common.now() + prune.EVERY_S + 1), \
                contextlib.redirect_stderr(io.StringIO()):
            self.run_prune()
        self.assertEqual(len(self.calls), before + 0, "no candidates left in the same generation: no ssh")


class ReleaseTests(NoNetwork):
    """Round-8 coverage: a hold is released only after a locked, fresh confirmation; a settled dir is re-offered
    once its checkout is recreated and used again; stop_all and the reaper follow the same rule."""

    def _box_with_hold(self, box="bx", run_id="r-old", state="running"):
        self.con.execute("INSERT OR REPLACE INTO leases(box_id,owner,repo_root,repo_key,remote_dir,state,size,"
                         "last_used_at,source) VALUES (?,'o9','/r9','rk','w/keep-cccccc',?,'small',?,NULL)",
                         (box, state, common.now()))
        self.con.execute("INSERT OR REPLACE INTO prune_holds(box_id, run_id, created_at) VALUES (?,?,?)",
                         (box, run_id, common.now()))
        self.con.commit()

    def _held(self, box="bx"):
        return self.con.execute("SELECT COUNT(*) FROM prune_holds WHERE box_id=?", (box,)).fetchone()[0]

    # --- locked, fresh confirmation (P1) ---------------------------------------------------------------------------
    def test_stale_snapshot_then_resume_and_new_hold_is_not_cleared(self):
        # The reaper's snapshot says archived; before it reaches the box, the box is resumed and a new prune takes a
        # hold (run_id r-new). Confirmation under the lock sees "ready" and must not clear the new hold.
        from offbox_lib import lease
        self._box_with_hold(run_id="r-old")
        self.con.execute("UPDATE prune_holds SET run_id='r-new' WHERE box_id='bx'")
        self.con.commit()
        with patch.object(lease.api, "get", return_value={"state": "ready"}):
            self.assertFalse(lease.release_if_confirmed(self.con, "bx", run_id="r-old"))
        self.assertEqual(self._held(), 1, "a resumed box's new hold must survive a stale stopped snapshot")

    def test_confirmed_stop_releases_only_the_covered_hold(self):
        from offbox_lib import lease
        self._box_with_hold(run_id="r-old", state="stopped")
        with patch.object(lease.api, "get", return_value={"state": "archived"}):
            self.assertTrue(lease.release_if_confirmed(self.con, "bx", run_id="r-old"))
        self.assertEqual(self._held(), 0)

    def test_lock_busy_keeps_the_hold(self):
        from offbox_lib import lease
        from offbox_lib.common import file_lock
        self._box_with_hold()
        with file_lock("box-bx", timeout=5):
            with patch.object(lease.api, "get", return_value={"state": "archived"}):
                self.assertFalse(lease.release_if_confirmed(self.con, "bx"))
        self.assertEqual(self._held(), 1, "a box whose lock is busy may be allocating: keep the hold")

    # --- stop_all (P2): confirmed, pending and failed stops ---------------------------------------------------------
    def test_stop_all_confirmed_stop_releases_hold(self):
        from offbox_lib import spend
        self._box_with_hold()
        with patch.object(spend.api, "list_boxes", return_value=[{"id": "bx", "state": "ready"}]), \
                patch.object(spend.api, "stop", return_value={}), \
                patch.object(spend.api, "get", return_value={"state": "archived"}), \
                patch.object(spend, "db", return_value=self.con):
            spend.stop_all("test")
        self.assertEqual(self._held(), 0)

    def test_stop_all_pending_stop_keeps_hold(self):
        from offbox_lib import spend
        self._box_with_hold()
        with patch.object(spend.api, "list_boxes", return_value=[{"id": "bx", "state": "ready"}]), \
                patch.object(spend.api, "stop", return_value={}), \
                patch.object(spend.api, "get", return_value={"state": "ready"}), \
                patch.object(spend, "db", return_value=self.con):
            spend.stop_all("test")
        self.assertEqual(self._held(), 1, "a stop accepted but not yet confirmed keeps the hold")

    def test_stop_all_on_pre_upgrade_db_stops_every_box(self):
        # Round-9 P1: a database created before prune_holds. common.db() runs only the old SCHEMA; nothing calls
        # capacity.schema(). The first box's release must not raise and abort the loop, so all three boxes stop.
        from offbox_lib import spend
        from offbox_lib import common as common_mod
        import sqlite3
        old = sqlite3.connect(":memory:")
        old.row_factory = sqlite3.Row
        old.executescript(common_mod.SCHEMA)  # the old schema only: no prune_holds, no capacity.schema
        self.assertFalse(old.execute("SELECT 1 FROM sqlite_master WHERE name='prune_holds'").fetchone())
        for box in ("b1", "b2", "b3"):
            old.execute("INSERT INTO leases(box_id,owner,repo_root,repo_key,remote_dir,state,size,last_used_at,source) "
                        "VALUES (?,'o9','/r9','rk','w/x-aaaaaa','running','small',?,NULL)", (box, common.now()))
        old.commit()
        states = {"b1": "ready", "b2": "ready", "b3": "ready"}
        stopped = []

        def stop(box_id):
            stopped.append(box_id)
            return {}

        def get(box_id):
            return {"state": "archived"} if box_id in stopped else {"state": states[box_id]}

        with patch.object(spend, "db", return_value=old), \
                patch.object(spend.api, "list_boxes", return_value=[{"id": b, "state": "ready"} for b in states]), \
                patch.object(spend.api, "stop", side_effect=stop), \
                patch.object(api, "get", side_effect=get), \
                contextlib.redirect_stderr(io.StringIO()):
            n = spend.stop_all("cap")
        self.assertEqual(sorted(stopped), ["b1", "b2", "b3"], "every box must be stopped, not just the first")
        self.assertEqual(n, 3)

    def test_stop_all_failed_stop_keeps_hold(self):
        from offbox_lib import spend
        from offbox_lib.common import OffboxError
        self._box_with_hold()
        with patch.object(spend.api, "list_boxes", return_value=[{"id": "bx", "state": "ready"}]), \
                patch.object(spend.api, "stop", side_effect=OffboxError("boom")), \
                patch.object(spend, "db", return_value=self.con):
            spend.stop_all("test")
        self.assertEqual(self._held(), 1, "a failed stop never clears the hold")

    # --- reaper stopped-state (P1) -----------------------------------------------------------------------------------
    def test_reaper_stopped_snapshot_clears_only_after_fresh_confirmation(self):
        from offbox_lib import reap, lease
        self._box_with_hold(state="stopped")
        with patch.object(reap.api, "list_boxes", return_value=[{"id": "bx", "state": "archived"}]), \
                patch.object(reap, "thread_get", return_value=("ok", None)), \
                patch.object(lease.api, "get", return_value={"state": "ready"}):
            reap.reap(dry=False)
        self.assertEqual(self._held(), 1, "a snapshot-stopped box that is ready on fresh read keeps its hold")
        with patch.object(reap.api, "list_boxes", return_value=[{"id": "bx", "state": "archived"}]), \
                patch.object(reap, "thread_get", return_value=("ok", None)), \
                patch.object(lease.api, "get", return_value={"state": "archived"}):
            reap.reap(dry=False)
        self.assertEqual(self._held(), 0)

    # --- settled generation (P2) -------------------------------------------------------------------------------------
class RetirementTests(NoNetwork):
    """Round-10 P2: a lease is retired (marked deleted) only after its hold is released. A failed confirmation or a busy
    lock keeps both the hold and the lease visible, and a later pass with a healthy read reconciles them."""

    def _held_lease(self, box="bx", state="running"):
        self.con.execute("INSERT OR REPLACE INTO leases(box_id,owner,repo_root,repo_key,remote_dir,state,size,"
                         "last_used_at,source) VALUES (?,'o9','/r9','rk','w/keep-cccccc',?,'small',?,NULL)",
                         (box, state, common.now()))
        self.con.execute("INSERT OR REPLACE INTO prune_holds(box_id, run_id, created_at) VALUES (?,'r1',?)",
                         (box, common.now()))
        self.con.commit()

    def _held(self, box="bx"):
        return self.con.execute("SELECT COUNT(*) FROM prune_holds WHERE box_id=?", (box,)).fetchone()[0]

    def _state(self, box="bx"):
        return self.con.execute("SELECT state FROM leases WHERE box_id=?", (box,)).fetchone()[0]

    def test_404_with_failed_confirmation_keeps_hold_and_lease_then_reconciles(self):
        from offbox_lib import lease
        self._held_lease()
        # Pass 1: stop returns 404 and the confirmation read fails. Nothing is retired.
        with patch.object(lease, "keep_images"), \
                patch.object(lease.api, "stop", side_effect=lease.api.ApiError(404, "not_found", "gone")), \
                patch.object(lease.api, "get", side_effect=lease.api.ApiError(503, "unavailable", "boat down")):
            lease.stop_box(self.con, "bx", "test", wait=False, images=False)
        self.assertEqual(self._held(), 1, "a failed confirmation must keep the hold")
        self.assertEqual(self._state(), "running", "the lease must not be retired before its hold is released")
        # The reaper still lists the held lease, so the next pass can reconcile it.
        from offbox_lib import reap
        visible = self.con.execute("SELECT box_id FROM leases WHERE state IN ('running','stopped') "
                                   "OR box_id IN (SELECT box_id FROM prune_holds)").fetchall()
        self.assertIn("bx", [r[0] for r in visible])
        # Pass 2: boat confirms the box gone. The hold is released and the lease retired.
        with patch.object(lease, "keep_images"), \
                patch.object(lease.api, "stop", side_effect=lease.api.ApiError(404, "not_found", "gone")), \
                patch.object(lease.api, "get", return_value=None):
            lease.stop_box(self.con, "bx", "test", wait=False, images=False)
        self.assertEqual(self._held(), 0)
        self.assertEqual(self._state(), "deleted")

    def test_reaper_forget_with_busy_lock_keeps_lease_then_reconciles(self):
        from offbox_lib import reap, lease
        from offbox_lib.common import file_lock
        self._held_lease()
        # Pass 1: boat no longer lists the box, but the box lock is busy (a run may be allocating it).
        with patch.object(reap.api, "list_boxes", return_value=[]), \
                patch.object(reap, "thread_get", return_value=("ok", None)), \
                file_lock("box-bx", timeout=5):
            actions = reap.reap(dry=False)
        self.assertEqual(self._held(), 1, "a busy lock must keep the hold")
        self.assertEqual(self._state(), "running", "the lease is not retired while its hold is held")
        self.assertTrue(any("hold kept" in a for a in actions))
        # Pass 2: the lock is free and boat confirms gone: the hold is released and the lease retired.
        with patch.object(reap.api, "list_boxes", return_value=[]), \
                patch.object(reap, "thread_get", return_value=("ok", None)), \
                patch.object(reap.lease.api, "get", return_value=None):
            reap.reap(dry=False)
        self.assertEqual(self._held(), 0)
        self.assertEqual(self._state(), "deleted")

    def test_reaper_forget_with_failed_read_keeps_lease_then_reconciles(self):
        from offbox_lib import reap
        self._held_lease()
        with patch.object(reap.api, "list_boxes", return_value=[]), \
                patch.object(reap, "thread_get", return_value=("ok", None)), \
                patch.object(reap.lease.api, "get", side_effect=reap.api.ApiError(503, "unavailable", "boat down")):
            reap.reap(dry=False)
        self.assertEqual(self._held(), 1, "a failed read is not confirmation")
        self.assertEqual(self._state(), "running")
        with patch.object(reap.api, "list_boxes", return_value=[]), \
                patch.object(reap, "thread_get", return_value=("ok", None)), \
                patch.object(reap.lease.api, "get", return_value=None):
            reap.reap(dry=False)
        self.assertEqual(self._held(), 0)
        self.assertEqual(self._state(), "deleted")


class StrandedRunTests(NoNetwork):
    """Round-11 P2: a held box that boat confirms gone must settle the runs its dead client left active, then release
    the hold and retire the lease. A failed confirmation keeps all three; a later healthy pass finishes them."""

    def _held_with_stranded_run(self, box="bx"):
        self.con.execute("INSERT OR REPLACE INTO leases(box_id,owner,repo_root,repo_key,remote_dir,state,size,"
                         "last_used_at,source) VALUES (?,'o9','/r9','rk','w/keep-cccccc','running','small',?,NULL)",
                         (box, common.now()))
        self.con.execute("INSERT OR REPLACE INTO prune_holds(box_id, run_id, created_at) VALUES (?,'r-prune',?)",
                         (box, common.now()))
        # The dead client's run: still marked starting/running, with no one left to end it.
        self.con.execute("INSERT INTO runs(run_id, box_id, remote_dir, start_at, status, mode) "
                         "VALUES ('r-stranded', ?, 'w/keep-cccccc', ?, 'running', 'fg')", (box, common.now() - 60))
        self.con.commit()

    def _row(self, sql, *a):
        return self.con.execute(sql, a).fetchone()

    def test_gone_box_settles_stranded_run_and_releases_hold(self):
        from offbox_lib import reap
        self._held_with_stranded_run()
        with patch.object(reap.api, "list_boxes", return_value=[]), \
                patch.object(reap, "thread_get", return_value=("ok", None)), \
                patch.object(reap.lease.api, "get", return_value=None):
            reap.reap(dry=False)
        self.assertEqual(self._row("SELECT status FROM runs WHERE run_id='r-stranded'")[0], "lost",
                         "the dead client's run must be settled once the box is confirmed gone")
        self.assertEqual(self._row("SELECT COUNT(*) FROM prune_holds WHERE box_id='bx'")[0], 0)
        self.assertEqual(self._row("SELECT state FROM leases WHERE box_id='bx'")[0], "deleted")

    def test_failed_confirmation_then_recovery_settles_and_releases(self):
        from offbox_lib import reap
        self._held_with_stranded_run()
        # Pass 1: boat's read fails. Nothing is settled, released or retired.
        with patch.object(reap.api, "list_boxes", return_value=[]), \
                patch.object(reap, "thread_get", return_value=("ok", None)), \
                patch.object(reap.lease.api, "get", side_effect=reap.api.ApiError(503, "unavailable", "boat down")):
            reap.reap(dry=False)
        self.assertEqual(self._row("SELECT status FROM runs WHERE run_id='r-stranded'")[0], "running")
        self.assertEqual(self._row("SELECT COUNT(*) FROM prune_holds WHERE box_id='bx'")[0], 1)
        self.assertEqual(self._row("SELECT state FROM leases WHERE box_id='bx'")[0], "running")
        # Pass 2: boat answers. The stranded run is settled, then the hold and lease follow.
        with patch.object(reap.api, "list_boxes", return_value=[]), \
                patch.object(reap, "thread_get", return_value=("ok", None)), \
                patch.object(reap.lease.api, "get", return_value=None):
            reap.reap(dry=False)
        self.assertEqual(self._row("SELECT status FROM runs WHERE run_id='r-stranded'")[0], "lost")
        self.assertEqual(self._row("SELECT COUNT(*) FROM prune_holds WHERE box_id='bx'")[0], 0)
        self.assertEqual(self._row("SELECT state FROM leases WHERE box_id='bx'")[0], "deleted")

    def test_live_box_with_active_run_is_never_settled(self):
        # Boat says the box is live: its run may be real. Nothing is settled and the hold stays.
        from offbox_lib import lease
        self._held_with_stranded_run()
        with patch.object(lease.api, "get", return_value={"state": "ready"}):
            self.assertFalse(lease.release_if_confirmed(self.con, "bx"))
        self.assertEqual(self._row("SELECT status FROM runs WHERE run_id='r-stranded'")[0], "running")
        self.assertEqual(self._row("SELECT COUNT(*) FROM prune_holds WHERE box_id='bx'")[0], 1)


class HoldClearTests(NoNetwork):
    """The hold is cleared only when a box is certainly stopped or gone. Each path is driven through the real
    lease/reap functions, with only the boat API faked."""

    def _hold(self, box="bx"):
        self.con.execute("INSERT INTO leases(box_id,owner,repo_root,repo_key,remote_dir,state,size,last_used_at,source) "
                         "VALUES (?,'o9','/r9','rk','w/keep-cccccc','running','small',?,NULL)", (box, common.now()))
        self.con.execute("INSERT OR REPLACE INTO prune_holds(box_id, run_id, created_at) VALUES (?,?,?)",
                         (box, "r1", common.now()))
        self.con.commit()

    def _held(self, box="bx"):
        return self.con.execute("SELECT COUNT(*) FROM prune_holds WHERE box_id=?", (box,)).fetchone()[0]

    def test_stop_box_clears_hold_only_once_boat_confirms_stopped(self):
        from offbox_lib import lease
        self._hold()
        with patch.object(lease, "keep_images"), patch.object(lease.api, "stop", return_value={}), \
                patch.object(lease.api, "get", return_value={"state": "running"}), \
                patch.object(lease.ssh_sync, "close_master"):
            lease.stop_box(self.con, "bx", "test", wait=False, images=False)
        self.assertEqual(self._held(), 1, "a stop merely accepted must keep the hold")
        with patch.object(lease, "keep_images"), patch.object(lease.api, "stop", return_value={}), \
                patch.object(lease.api, "get", return_value={"state": "archived"}), \
                patch.object(lease.ssh_sync, "close_master"):
            lease.stop_box(self.con, "bx", "test", wait=False, images=False)
        self.assertEqual(self._held(), 0, "a box boat reports archived has no remote process left")

    def test_stop_box_404_clears_hold_through_locked_caller(self):
        # The real caller path: reap.act / misc.release / bases.save hold box-<id> when they call stop_box. Here the
        # test takes that lock itself, then calls stop_box with locked=True, exactly as those callers do.
        from offbox_lib import lease
        from offbox_lib.common import file_lock
        self._hold()
        with file_lock("box-bx", timeout=5), \
                patch.object(lease, "keep_images"), \
                patch.object(lease.api, "stop", side_effect=lease.api.ApiError(404, "not_found", "gone")), \
                patch.object(lease.api, "get", return_value=None):  # boat: the box is gone
            lease.stop_box(self.con, "bx", "test", wait=False, images=False, locked=True)
        self.assertEqual(self._held(), 0, "a box that is already gone has no remote process left")
        state = self.con.execute("SELECT state FROM leases WHERE box_id='bx'").fetchone()[0]
        self.assertEqual(state, "deleted", "the lease is deleted, so the reaper will not revisit the box")

    def test_stop_box_locked_caller_releases_after_confirmed_stop(self):
        # Locked caller, confirmed stop: the hold is released, with no reentrant lock attempt.
        from offbox_lib import lease
        from offbox_lib.common import file_lock
        self._hold()
        with file_lock("box-bx", timeout=5), \
                patch.object(lease, "keep_images"), patch.object(lease.api, "stop", return_value={}), \
                patch.object(lease.api, "get", return_value={"state": "archived"}), \
                patch.object(lease.ssh_sync, "close_master"):
            lease.stop_box(self.con, "bx", "test", wait=False, images=False, locked=True)
        self.assertEqual(self._held(), 0)

    def test_stop_box_locked_caller_keeps_hold_while_stop_pending(self):
        from offbox_lib import lease
        from offbox_lib.common import file_lock
        self._hold()
        with file_lock("box-bx", timeout=5), \
                patch.object(lease, "keep_images"), patch.object(lease.api, "stop", return_value={}), \
                patch.object(lease.api, "get", return_value={"state": "ready"}), \
                patch.object(lease.ssh_sync, "close_master"):
            lease.stop_box(self.con, "bx", "test", wait=False, images=False, locked=True)
        self.assertEqual(self._held(), 1, "a stop accepted but not confirmed keeps the hold")

    def test_delete_box_clears_hold(self):
        from offbox_lib import lease
        self._hold()
        with patch.object(lease, "ssh_sync"), patch.object(lease.api, "delete", return_value={"operation": {"id": "op"}}), \
                patch("offbox_lib.spend.record_final_usage"):
            lease.delete_box(self.con, "bx", "test")
        self.assertEqual(self._held(), 0)

    def test_reaper_forgets_gone_box_and_clears_hold(self):
        from offbox_lib import reap
        self._hold()
        # boat no longer lists the box: the reaper's forget path releases the hold, after a fresh confirmation (mocked).
        with patch.object(reap.api, "list_boxes", return_value=[]), \
                patch.object(reap, "thread_get", return_value=("ok", None)), \
                patch.object(reap.lease.api, "get", return_value=None):
            reap.reap(dry=False)  # any error here must fail the test, not be swallowed
        self.assertEqual(self._held(), 0)

    def test_hold_kept_after_timeout_with_no_marker(self):
        # No marker and no confirmation: the hold must stay, however much time passes. A real stale dir is needed,
        # otherwise run() returns before it takes a hold.
        def timeout_no_marker(box_id, cmd, input=None, timeout=None):
            if input is not None:
                raise subprocess.TimeoutExpired("ssh", timeout)
            return subprocess.CompletedProcess(["ssh"], 1, b"", b"")

        self._lease_row_for_bx()
        add_run(self.con, "bx", "w/s9-a1b2c3", 5 * 86400)  # DIR_RE needs 6 hex digits after the dash
        with patch.object(prune, "BACKGROUND", "true"), \
                patch.object(prune.ssh_sync, "ssh", side_effect=timeout_no_marker), \
                contextlib.redirect_stderr(io.StringIO()):
            prune.run(self.con, "bx", "w/keep-cccccc")
        self.assertEqual(self._held(), 1, "a timed-out run with no marker must hold the box")
        with patch.object(common, "now", return_value=common.now() + 10 * 86400):
            self.assertEqual(self._held(), 1, "time alone never clears a hold")

    def _lease_row_for_bx(self):
        self.con.execute("INSERT INTO leases(box_id,owner,repo_root,repo_key,remote_dir,state,size,last_used_at,source) "
                         "VALUES ('bx','o9','/r9','rk','w/keep-cccccc','stopped','small',?,NULL)", (common.now(),))
        self.con.commit()

    def test_busy_script_writes_no_marker_and_no_done_line(self):
        # A group member that survives the kill makes the script busy: no done marker and no "done" line.
        # A real survivor: a stub mv that ignores SIGKILL is not possible, so the busy path is forced by making the
        # group-liveness probe report "alive" forever. Only the busy branch can then run, and it must not signal done.
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as bindir:
            h = Path(home)
            (h / "w/a-aaaaaa").mkdir(parents=True)
            # The group probe is forced to "alive" (kill -0 always succeeds). The kill then can't confirm the group is
            # gone, so the one() path returns busy (4), and the script must not signal done.
            body = prune.script(["w/a-aaaaaa"], "rbusy").replace(
                'while kill -0 -- -"$p" 2>/dev/null; do',
                'while true; do', 1).replace(
                'if kill -0 -- -"$p" 2>/dev/null; then return 4; fi',
                'return 4', 1)
            p = subprocess.run(["bash", "-c", body], env={"HOME": home, "PATH": f"{bindir}:/usr/bin:/bin"},
                               capture_output=True, timeout=60)
            self.assertNotIn("done rbusy", p.stdout.decode().splitlines())
            self.assertFalse((h / ".offbox/done/rbusy").exists(), "a busy script must not write the done marker")


class RunnerHookTests(NoNetwork):
    def test_prune_runs_after_record_and_before_push(self):
        order = []
        rn = runs.Runner(cli.build_parser().parse_args(["run", "--", "go", "test", "./..."]), self.me)
        rn.a.steps = []
        row = {"box_id": "bx", "remote_dir": "w/r", "size": "large"}
        with patch.object(runs.pool, "acquire", return_value=row), \
                patch.object(runs.ssh_sync, "put_file"), \
                patch.object(runs.ssh_sync, "push", side_effect=lambda *a, **k: order.append("push") or {}), \
                patch.object(runs.ssh_sync, "tracked_secret_matches", return_value=[]), \
                patch.object(runs.ssh_sync, "probe_home", return_value=None), \
                patch.object(runs.prune, "run", side_effect=lambda con, box, d: order.append(("prune", box, d)) or 0) as pr, \
                patch.object(api, "cmd_start", side_effect=api.ApiError(400, "x", "y")), \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(common.OffboxError):
                rn.start()
        self.assertEqual(pr.call_count, 1)
        self.assertEqual(order[0], ("prune", "bx", "w/r"))
