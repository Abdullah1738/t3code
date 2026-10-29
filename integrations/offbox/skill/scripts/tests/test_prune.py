"""Offline tests for pruning old checkout dirs on pooled boxes (offbox_lib/prune.py)."""
import contextlib
import io
import os
import stat
import subprocess
import sys
import tempfile
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
            p = subprocess.run(["bash", "-c", prune.script(dirs)],
                               env={"HOME": home, "PATH": f"{bindir}:/usr/bin:/bin"},
                               capture_output=True, timeout=10)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertEqual(p.stdout.decode().splitlines(), ["pruned w/a-aaaaaa", "pruned w/it's-bbbbbb"])
            self.assertFalse((h / "w/a-aaaaaa").exists())
            self.assertFalse((h / "w/it's-bbbbbb").exists())
            self.assertTrue((h / "w/c-cccccc").is_symlink())
            self.assertTrue(target.is_dir())

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
                body = prune.script(["w/a-aaaaaa"])
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
