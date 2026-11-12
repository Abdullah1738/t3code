"""The Mac client's own code against boatd's real HTTP handler: what the two say to each other about a run the
server restarted under. boatd's host side (Incus, systemd, ZFS) is test_boatd's fakes; HTTP, SQLite and the
client are real."""
import contextlib
import io
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(SCRIPTS / "tests"))
sys.path.insert(0, str(SCRIPTS.parents[1] / "tests"))
from offbox_lib import api, common, lease, misc, reap, runs, ssh_sync  # noqa: E402
from test_capacity import Isolated  # noqa: E402
import test_boatd  # noqa: E402

boatd = test_boatd.boatd


class Wire(Isolated):
    def setUp(self):
        super().setUp()
        self.srv = test_boatd.Http("call")      # used as a fixture: boatd with fakes behind a real HTTP server
        self.srv.setUp()
        self.addCleanup(self.srv.doCleanups)
        for name, value in (("API", self.srv.url), ("BACKEND", "server"), ("NAME", "offbox server"),
                            ("KEY_SERVICE", "offbox-server-api")):
            self.stack.enter_context(patch.object(api, name, value))
        self.as_owner("ardud")
        self.stack.enter_context(patch.object(runs, "_ttl_keeper"))
        self.log = Path(self.tmp.name) / "run.log"

    def as_owner(self, who):
        self.stack.enter_context(patch.object(api, "_KEY", self.srv.tok[who]))

    def follow(self, box, pid, **kw):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            try:
                return runs.follow(box, pid, self.log, echo=False, run_id="run-wire", stop_evt=threading.Event(), **kw), \
                    err.getvalue()
            except common.OffboxError as e:
                return e, err.getvalue()

    def end(self, box, pid, code):
        self.srv.con.execute("UPDATE commands SET status='exited', exit_code=?, ended_at=? WHERE box_id=? AND pid=?",
                             (code, boatd.now(), box, pid))
        self.srv.f.active_units.clear()

    def test_the_retry_flag_reaches_the_server_only_when_asked(self):
        box = self.srv.make_box("ardud")
        a = api.cmd_start(box, "make test", meta={"repo": "r", "kind": "make test", "run_id": "run-1"}, retry_interrupted=True)
        b = api.cmd_start(box, "make deploy")
        rows = {r["pid"]: r for r in self.srv.con.execute("SELECT * FROM commands WHERE box_id=?", (box,))}
        self.assertEqual((rows[a["processId"]]["retry_interrupted"], rows[b["processId"]]["retry_interrupted"]), (1, 0))
        st = api.cmd_status(box, a["processId"])
        self.assertEqual((st["attempt"], st["retryInterrupted"], st["bootId"]), (1, True, "boot-2"))

    def test_a_run_the_server_retried_is_followed_to_its_end_with_both_attempts_output(self):
        box = self.srv.box(running=False)                 # the machine restarted: its container is down too
        pid = self.srv.cmd(box, retry=1)
        out = boatd.cmd_dir(box) / f"{pid}.out"
        out.write_text("one\n")
        self.assertEqual(boatd.reconcile(self.srv.con)["retry"], 1)
        with out.open("a") as f:
            f.write("one\ntwo\n")
        self.end(box, pid, 0)
        rc, _ = self.follow(box, pid)
        self.assertEqual(rc, 0)
        text = self.log.read_text()
        self.assertEqual(text.replace("\n", " ").count("one"), 2)
        self.assertIn("two", text)
        self.assertIn("queued again as attempt 2", text)
        self.assertEqual(api.cmd_status(box, pid)["attempt"], 2)

    def test_a_client_that_was_at_byte_4_of_attempt_one_gets_only_what_is_new_and_is_told_of_the_retry(self):
        box = self.srv.box(running=False)
        pid = self.srv.cmd(box, retry=1)
        out = boatd.cmd_dir(box) / f"{pid}.out"
        out.write_text("one\n")
        boatd.reconcile(self.srv.con)
        with out.open("a") as f:
            f.write("ONE\nTWO\n")
        self.end(box, pid, 7)
        self.log.write_text("one\n")
        rc, _ = self.follow(box, pid, start_offsets=(4, 0))
        self.assertEqual(rc, 7, "the retried attempt's real exit code")
        text = self.log.read_text()
        self.assertEqual(text.count("one\n"), 1, "nothing it already had is sent twice")
        self.assertIn("ONE\nTWO\n", text)

    def test_a_run_that_was_not_retried_ends_as_interrupted(self):
        box = self.srv.box()
        pid = self.srv.cmd(box)                           # retry_interrupted off
        (boatd.cmd_dir(box) / f"{pid}.out").write_text("half\n")
        boatd.reconcile(self.srv.con)
        e, _ = self.follow(box, pid)
        self.assertIsInstance(e, runs.Interrupted)
        self.assertEqual(e.code, common.EXIT_INTERRUPTED)
        self.assertIn("half", self.log.read_text())
        self.assertEqual(api.cmd_status(box, pid)["status"], "interrupted")

    def test_another_owners_token_gets_404_for_the_box_and_its_run(self):
        box = self.srv.box()
        pid = self.srv.cmd(box)
        self.as_owner("moni")
        self.assertIsNone(api.cmd_status(box, pid), "404: to her token the run does not exist")
        for call in (lambda: api.call("GET", f"/sandboxes/{box}", retries=0), lambda: api.cmd_start(box, "id"),
                     lambda: list(api.cmd_attach(box, pid))):
            with self.assertRaises(api.ApiError) as cm:
                call()
            self.assertEqual(cm.exception.status, 404)

    def test_server_not_ready_reads_as_an_outage_not_a_refusal(self):
        box = self.srv.box()
        boatd.READY.clear()
        boatd.STATE["problem"] = "reconciling runs and boxes after start"
        with self.assertRaises(api.ApiError) as cm:
            api.call("GET", f"/sandboxes/{box}", retries=0)
        self.assertEqual((cm.exception.status, cm.exception.api_code), (503, "server_not_ready"))
        self.assertTrue(cm.exception.outage)

    def test_unfollowed_background_run_keeps_full_server_output_at_settlement(self):
        for code in (0, 7):
            with self.subTest(code=code):
                box = self.srv.box(bid=f'bx_{code:08d}')
                pid = self.srv.cmd(box)
                stdout = 'start\n' + 'x' * (1 << 20) + '\nfinished\n'
                stderr = 'diagnostic\n'
                (boatd.cmd_dir(box) / f'{pid}.out').write_text(stdout)
                (boatd.cmd_dir(box) / f'{pid}.err').write_text(stderr)
                self.end(box, pid, code)
                run_id = f'run-home-{code}'
                log = common.LOGS_DIR / f'{run_id}.log'
                self.con.execute("INSERT INTO runs(run_id,box_id,command_id,process_id,status,mode,pulls,start_at,log_path) "
                                 "VALUES (?,?,?,?,'running','bg','[]',?,?)",
                                 (run_id, box, f'cmd_{pid}', pid, common.now(), str(log)))
                self.con.commit()
                self.assertFalse(log.exists())
                with patch.object(lease, 'touch'), patch.object(lease, 'idle_ttl'), patch.object(runs, 'settle_docker'), \
                        patch.object(api, 'get', side_effect=AssertionError('history needs no live box inspection')), \
                        patch.object(ssh_sync, 'ssh', side_effect=AssertionError('history needs no SSH')):
                    reap._check_stale_runs(self.con, box, 'running', False, [])
                    row = self.con.execute('SELECT * FROM runs WHERE run_id=?', (run_id,)).fetchone()
                    self.assertEqual((row['status'], row['exit_code']), ('failed' if code else 'done', code))
                    self.assertEqual(log.read_text(), stdout + stderr)
                    self.assertEqual(common.checkpoint(log),
                                     dict(stdoutOffset=len(stdout), stderrOffset=len(stderr), logBytes=len(stdout + stderr)))
                    for _ in range(2):
                        out, err = io.StringIO(), io.StringIO()
                        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                            self.assertEqual(misc.logs(run_id, False), 0)
                        self.assertEqual((out.getvalue(), err.getvalue()), (stdout + stderr, ''))
                    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                        self.assertEqual(misc.wait(run_id, None), code)

    def test_empty_home_history_reports_no_output_without_inspecting_the_container(self):
        box = self.srv.box()
        pid = self.srv.cmd(box)
        self.end(box, pid, 0)
        self.con.execute("INSERT INTO runs(run_id,box_id,command_id,process_id,status,mode,exit_code) "
                         "VALUES ('run-silent',?,?,?,'done','bg',0)", (box, f'cmd_{pid}', pid))
        self.con.commit()
        with patch.object(api, 'get', side_effect=AssertionError('full history is on the host disk')):
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                self.assertEqual(misc.logs('run-silent', False), 1)
            self.assertEqual(out.getvalue(), '')
            self.assertIn('offbox server history empty', err.getvalue())
            self.assertEqual(len(err.getvalue().splitlines()), 1)
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(misc.wait('run-silent', None), 0)


if __name__ == "__main__":
    unittest.main()
