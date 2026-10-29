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


class ScriptTests(Isolated):
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
                             ["pruned w/a-aaaaaa", "pruned w/it's-bbbbbb", "skip w/c-cccccc", "skip w/d-dddddd"])
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
            self.assertEqual(p.stdout.decode().splitlines(), ["left w/a-aaaaaa"])
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
            self.assertEqual(p.stdout.decode().splitlines(), ["left w/a-aaaaaa"])
            self.assertTrue((h / "w/a-aaaaaa/f").exists())
            # The stub writes its pid as its first action, so the budget kill always has a live child to reap.
            self.assertTrue(pidf.exists(), "stalled mv never started: the test would prove nothing")
            pid = int(pidf.read_text().strip())
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)  # the stalled child was killed and reaped before the script returned


class RunTests(Isolated):
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


class RunnerHookTests(Isolated):
    def test_prune_runs_after_record_and_before_push(self):
        order = []
        rn = runs.Runner(cli.build_parser().parse_args(["run", "--", "go", "test", "./..."]), self.me)
        rn.a.steps = []
        row = {"box_id": "bx", "remote_dir": "w/r", "size": "large"}
        with patch.object(runs.pool, "acquire", return_value=row), \
                patch.object(runs.ssh_sync, "put_file"), \
                patch.object(runs.ssh_sync, "push", side_effect=lambda *a, **k: order.append("push") or {}), \
                patch.object(runs.ssh_sync, "tracked_secret_matches", return_value=[]), \
                patch.object(runs.prune, "run", side_effect=lambda con, box, d: order.append(("prune", box, d)) or 0) as pr, \
                patch.object(api, "cmd_start", side_effect=api.ApiError(400, "x", "y")), \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(common.OffboxError):
                rn.start()
        self.assertEqual(pr.call_count, 1)
        self.assertEqual(order[0], ("prune", "bx", "w/r"))
