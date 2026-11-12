"""The home offbox server next to Boat: which backend a run uses, owner tokens, failover before a run is accepted,
reconnect after it was accepted, person-box work that never goes to Boat, and the Boat plan limits.

The first class is the hard requirement: with no home server configured the client is exactly the Boat client."""
import contextlib
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(SCRIPTS / "tests"))
from offbox_lib import api, capacity, cli, common, home, lease, runs, spend  # noqa: E402
from test_capacity import Isolated  # noqa: E402
from test_wait_lock import Clock  # noqa: E402

PROBE = r"""
import json, sys
sys.path.insert(0, sys.argv[1])
from offbox_lib import common
if len(sys.argv) > 2:
    common.select_backend(common.entry_backend(sys.argv[2:]))
from offbox_lib import api, capacity, home
print(json.dumps({"backend": common.backend(), "api": api.API, "service": api.KEY_SERVICE, "account": api.KEY_ACCOUNT,
                  "db": common.DB_PATH.name, "windows": [w[2] for w in capacity.WINDOWS],
                  "may_fail_over": home.may_fail_over(), "standby": home.on_standby()}))
"""
BOAT = {"backend": "boat", "api": "https://boat.dev/api/v1", "service": "boat-api", "account": "ardud",
        "db": "offbox.db", "windows": [25, 180, 760], "may_fail_over": False, "standby": False}


def fresh_process(state_dir, *argv, **env):
    """What a new offbox process decides, given only the files in state_dir and the environment."""
    e = {k: v for k, v in os.environ.items() if not k.startswith("OFFBOX_")}
    e.update(OFFBOX_STATE_DIR=str(state_dir), **env)
    p = subprocess.run([sys.executable, "-c", PROBE, str(SCRIPTS), *argv], capture_output=True, text=True, env=e)
    if p.returncode != 0:
        raise AssertionError(p.stderr[-800:])
    return json.loads(p.stdout)


class HomeFiles(unittest.TestCase):
    """A temp dir standing in for ~/.local/share/offbox's home-server files, with no backend pinned by the caller."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        for name, f in (("SERVER_CFG", "server.json"), ("BACKEND_STATE", "backend-state.json"),
                        ("BACKEND_PATH", "backend"), ("HOME_FAILURES", "home-failures.jsonl")):
            self.stack.enter_context(patch.object(common, name, self.dir / f))
        self.stack.enter_context(patch.object(common, "_BACKEND", None))
        env = {k: v for k, v in os.environ.items() if not k.startswith("OFFBOX_")}
        self.stack.enter_context(patch.dict(os.environ, env, clear=True))
        self.stack.enter_context(patch.object(common, "log", lambda m: None))
        self.stack.enter_context(patch.object(home, "log", lambda m: None))

    def configure(self, **kw):
        (self.dir / "server.json").write_text(json.dumps({"url": "http://100.64.0.9:8443/api/v1", **kw}))

    def monitor_says(self, state, **kw):
        (self.dir / "backend-state.json").write_text(json.dumps({"state": state, "since": 1.0, **kw}))


class Unconfigured(HomeFiles):
    """No server.json (or a disabled one): everything is Boat, as before the home server existed."""

    def test_a_fresh_process_with_no_server_json_is_the_boat_client(self):
        self.assertEqual(fresh_process(self.dir), BOAT)
        for argv in (["run", "--", "make", "test"], ["spend"], ["reap"], ["status"], ["wait", "run-1112-000000-abcd"],
                     ["release", "bx_abcdefgh"], ["stats"]):
            self.assertEqual(fresh_process(self.dir, *argv), BOAT, argv)

    def test_disabled_unreadable_or_url_less_server_json_is_the_same(self):
        for text in ('{"url": "http://100.64.0.9:8443/api/v1", "disabled": true}', "{not json", '{"public_ip": "1.2.3.4"}',
                     "[]", ""):
            (self.dir / "server.json").write_text(text)
            self.assertEqual(fresh_process(self.dir, "run", "--", "true"), BOAT, text)

    def test_nothing_else_can_switch_it_on_without_server_json(self):
        self.monitor_says("home_up")
        self.assertEqual(fresh_process(self.dir), BOAT)
        self.monitor_says("home_down")
        self.assertEqual(fresh_process(self.dir), BOAT)
        # A person's work stays where it is today too (her box is on Boat until the home server exists).
        self.assertEqual(fresh_process(self.dir, "run", "--", "true", OFFBOX_THREAD="person:moni"), BOAT)

    def test_no_home_code_runs(self):
        self.assertIsNone(common.home_config())
        self.assertEqual(common.backend(), "boat")
        self.assertFalse(home.active() or home.may_fail_over() or home.on_standby() or common.standby())
        with patch.object(home, "probe", side_effect=AssertionError("no probe without a home server")):
            home.person_gate()
            with patch.dict(os.environ, {"OFFBOX_THREAD": "person:moni"}):
                home.person_gate()
        self.assertFalse(home.only_on_home("bases", "name=?", ("x:default",)))
        self.assertEqual(common.entry_backend(["wait", "run-1112-000000-abcd"]), "boat")
        self.assertEqual(list(self.dir.iterdir()), [], "nothing was written")

    def test_run_never_probes_or_fails_over(self):
        a = cli.build_parser().parse_args(["run", "--remote", "--", "make", "test"])
        me = {"owner": "t", "repo_root": "/r", "repo_key": "r"}
        boom = AssertionError("home code reached on a Boat-only install")
        with patch.object(home, "probe", side_effect=boom), patch.object(home, "fail_over", side_effect=boom), \
                patch("offbox_lib.localfirst.decide", return_value="not a light command"), \
                patch.object(runs, "run_remote", return_value=7) as rr, patch.object(cli, "log"), \
                contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(cli.cmd_run(a, me), 7)
        rr.assert_called_once()
        self.assertNotIn("home", err.getvalue())

    def test_requests_carry_nothing_new(self):
        sent = []
        with patch.object(api, "call", side_effect=lambda m, p, body=None, **k: sent.append(body) or {"processId": 1}):
            api.cmd_start("bx_a", "true", meta={"repo": "r", "kind": "k", "run_id": "run-1"}, retry_interrupted=True)
            api.cmd_start("bx_a", "true", cwd="/w")
        self.assertEqual(sent, [{"command": "true", "detached": True}, {"command": "true", "detached": True, "cwd": "/w"}])
        self.assertFalse(runs.retry_interrupted(cli.build_parser().parse_args(["run", "--", "true"])))

    def test_reap_does_not_start_a_second_reaper(self):
        with patch("subprocess.run", side_effect=AssertionError("no second reap on a Boat-only install")):
            cli._reap_other_backend(False)


class BackendChoice(HomeFiles):
    def test_configured_and_up_goes_home(self):
        self.configure()
        self.assertEqual(common.default_backend(), "server")        # no monitor file yet counts as up
        self.monitor_says("home_up")
        self.assertEqual(common.default_backend(), "server")
        got = fresh_process(self.dir, "run", "--", "true")
        self.assertEqual((got["backend"], got["api"], got["service"], got["account"], got["db"], got["may_fail_over"]),
                         ("server", "http://100.64.0.9:8443/api/v1", "offbox-server-api", "ardud", "offbox-home.db", True))
        self.assertGreater(got["windows"][0], 1000, "start limits are Boat's, not ours")

    def test_marked_down_new_runs_go_straight_to_boat(self):
        self.configure()
        self.monitor_says("home_down", reason="no answer for 2 checks")
        self.assertEqual(common.default_backend(), "boat")
        self.assertTrue(common.standby())
        got = fresh_process(self.dir, "run", "--", "true")
        self.assertEqual({**got, "standby": False}, BOAT)
        self.assertTrue(got["standby"])

    def test_back_home_as_soon_as_the_monitor_says_up(self):
        self.configure()
        self.monitor_says("home_down")
        self.assertEqual(common.default_backend(), "boat")
        self.monitor_says("home_up", good_streak=3)
        self.assertEqual(common.default_backend(), "server")

    def test_person_work_is_home_whatever_the_monitor_says(self):
        self.configure()
        for state in ("home_up", "home_down"):
            self.monitor_says(state)
            got = fresh_process(self.dir, "run", "--", "true", OFFBOX_THREAD="person:moni")
            self.assertEqual((got["backend"], got["service"], got["account"], got["may_fail_over"]),
                             ("server", "offbox-server-api", "moni", False), state)

    def test_token_account_is_the_owner(self):
        self.assertEqual(common.token_owner(), "ardud")
        with patch.dict(os.environ, {"OFFBOX_THREAD": "person:moni"}):
            self.assertEqual((common.person(), common.token_owner()), ("moni", "moni"))
        for odd in ("person:", "person:../../etc", "person:a b", "thread:abc", "moni"):
            with patch.dict(os.environ, {"OFFBOX_THREAD": odd}):
                self.assertEqual((common.person(), common.token_owner()), (None, "ardud"), odd)

    def test_a_pin_wins_and_switches_failover_off(self):
        self.configure()
        (self.dir / "backend").write_text("boat\n")
        self.assertEqual((common.default_backend(), common.standby()), ("boat", False))
        (self.dir / "backend").write_text("nonsense")
        self.assertEqual(common.default_backend(), "server")
        with patch.dict(os.environ, {"OFFBOX_BACKEND": "boat"}):
            self.assertEqual(common.default_backend(), "boat")
        self.monitor_says("home_down")
        with patch.dict(os.environ, {"OFFBOX_BACKEND": "server"}), patch.object(common, "_BACKEND", "server"):
            self.assertEqual(common.default_backend(), "server")
            self.assertFalse(home.may_fail_over())

    def test_commands_go_to_the_backend_that_knows_the_run_or_box(self):
        self.configure()
        state = self.dir / "state"
        state.mkdir()
        self.stack.enter_context(patch.object(common, "STATE", state))
        for name, run, box in (("boat", "run-1112-010101-aaaa", "bx_boatbox1"), ("server", "run-1112-020202-bbbb", "bx_homebox1")):
            con = sqlite3.connect(common.db_path_for(name))
            con.executescript(common.SCHEMA)
            con.execute("INSERT INTO runs (run_id) VALUES (?)", (run,))
            con.execute("INSERT INTO leases (box_id, owner, repo_root, repo_key, remote_dir) VALUES (?,'o','/r','r','w')", (box,))
            con.commit()
            con.close()
        self.assertEqual(common.entry_backend(["run", "--", "true"]), "server")
        self.assertEqual(common.entry_backend(["wait", "run-1112-010101-aaaa"]), "boat")
        self.assertEqual(common.entry_backend(["logs", "run-1112-020202-bbbb", "--follow"]), "server")
        self.assertEqual(common.entry_backend(["release", "bx_boatbox1", "--delete"]), "boat")
        self.assertEqual(common.entry_backend(["ssh", "bx_homebox1"]), "server")
        self.assertEqual(common.entry_backend(["kill", "run-unknown"]), "server")
        self.assertEqual(common.entry_backend(["spend", "--check"]), "boat", "the meter is Boat's")
        self.assertEqual(common.entry_backend(["stats"]), "server")
        self.monitor_says("home_down")
        self.assertEqual(common.entry_backend(["run", "--", "true"]), "boat")
        self.assertEqual(common.entry_backend(["wait", "run-1112-020202-bbbb"]), "server", "a home run is still a home run")


class Failover(HomeFiles):
    """Before a run is accepted it may move to Boat; after that, never."""

    class Exec(Exception):
        pass

    def setUp(self):
        super().setUp()
        self.configure()
        self.stack.enter_context(patch.object(common, "_BACKEND", "server"))
        self.execs = []

        def execve(path, argv, env):
            self.execs.append((argv, env))
            raise self.Exec()
        self.stack.enter_context(patch.object(os, "execve", execve))
        self.stack.enter_context(patch("offbox_lib.localfirst.decide", return_value="not a light command"))
        self.stack.enter_context(patch.object(cli, "log"))
        self.me = {"owner": "t", "repo_root": "/r", "repo_key": "r"}

    def run_cmd(self, *argv):
        a = cli.build_parser().parse_args(["run", *argv])
        a.argv = ["run", *argv]
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            try:
                return cli.cmd_run(a, self.me), err.getvalue()
            except self.Exec:
                return "exec", err.getvalue()

    def failures(self):
        f = self.dir / "home-failures.jsonl"
        return [json.loads(x) for x in f.read_text().splitlines()] if f.exists() else []

    def test_server_does_not_answer_the_run_goes_to_boat_and_the_monitor_hears_of_it(self):
        with patch.object(home, "probe", return_value="no answer (TimeoutError)"), \
                patch.object(runs, "run_remote", side_effect=AssertionError("nothing may be sent home")):
            rc, err = self.run_cmd("--size", "large", "--", "go", "test", "./...")
        self.assertEqual(rc, "exec")
        argv, env = self.execs[0]
        self.assertEqual(argv[2:], ["run", "--size", "large", "--", "go", "test", "./..."], "the same command")
        self.assertEqual(env["OFFBOX_BACKEND"], "boat")
        self.assertIn("no answer", env[home.FAILOVER_ENV])
        self.assertEqual(err.count("this run goes to Boat instead"), 1)
        f = self.failures()
        self.assertEqual(len(f), 1)
        self.assertIn("no answer", f[0]["reason"])

    def test_server_not_ready_or_unhealthy_counts_as_unreachable(self):
        class Resp(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False
        for body, want in ((b'{"ok": true, "mode": "degraded", "reasons": ["mdraid degraded"]}', None),
                           (b'{"ok": false, "reasons": ["pool offbox is MISSING"]}', "pool offbox is MISSING"),
                           (b"<html>", "no answer")):
            with patch("urllib.request.urlopen", return_value=Resp(body)):
                got = home.probe()
            self.assertTrue(got is None if want is None else want in got, (body, got))
        with patch("urllib.request.urlopen", side_effect=OSError("timed out")):
            self.assertIn("no answer", home.probe())

    def test_unreachable_before_the_command_was_sent_also_fails_over(self):
        gone = api.NetworkError("offbox server API unreachable (POST /sandboxes): timed out")
        with patch.object(home, "probe", return_value=None), patch.object(runs, "run_remote", side_effect=gone):
            rc, _ = self.run_cmd("--", "make", "test")
        self.assertEqual(rc, "exec")
        self.assertEqual(len(self.failures()), 1)
        starting = api.ApiError(503, "server_not_ready", "reconciling runs and boxes after start")
        with patch.object(home, "probe", return_value=None), patch.object(runs, "run_remote", side_effect=starting):
            self.assertEqual(self.run_cmd("--", "make", "test")[0], "exec")

    def test_once_the_run_was_accepted_it_never_moves(self):
        lost = api.NetworkError("offbox server API unreachable")
        lost.started = True
        with patch.object(home, "probe", return_value=None), patch.object(runs, "run_remote", side_effect=lost), \
                patch("offbox_lib.fallback.note_infra_failure"):
            rc, err = self.run_cmd("--", "make", "test")
        self.assertEqual(rc, common.EXIT_INFRA)
        self.assertEqual(self.execs, [], "no second copy of the run anywhere")
        self.assertEqual(self.failures(), [])
        self.assertIn("after the command started", err)

    def test_a_refusal_is_not_a_reason_to_fail_over(self):
        no = api.ApiError(409, "machine_not_running", "bx is archived")
        with patch.object(home, "probe", return_value=None), patch.object(runs, "run_remote", side_effect=no), \
                patch("offbox_lib.fallback.note_infra_failure"):
            rc, _ = self.run_cmd("--remote", "--", "make", "test")
        self.assertEqual((rc, self.execs), (common.EXIT_INFRA, []))

    def test_interrupted_is_its_own_exit_code(self):
        with patch.object(home, "probe", return_value=None), \
                patch.object(runs, "run_remote", side_effect=runs.Interrupted("run-1")):
            rc, err = self.run_cmd("--no-retry", "--", "make", "deploy")
        self.assertEqual(rc, 94)
        self.assertEqual(common.EXIT_INTERRUPTED, 94)
        self.assertIn("was not run again", err)
        self.assertEqual(self.execs, [])

    def test_standby_run_says_once_why_it_is_on_boat(self):
        self.monitor_says("home_down", reason="no answer for 2 checks")
        with patch.object(common, "_BACKEND", "boat"), patch.object(runs, "run_remote", return_value=0), \
                patch.object(home, "probe", side_effect=AssertionError("marked down: no probe, straight to Boat")):
            rc, err = self.run_cmd("--", "make", "test")
        self.assertEqual(rc, 0)
        self.assertEqual(err.count("this run is on Boat"), 1)
        self.assertIn("no answer for 2 checks", err)


class PersonNeverOnBoat(HomeFiles):
    def setUp(self):
        super().setUp()
        self.configure()
        self.stack.enter_context(patch.dict(os.environ, {"OFFBOX_THREAD": "person:moni"}))
        self.stack.enter_context(patch.object(os, "execve", side_effect=AssertionError("her work never goes to Boat")))

    def test_marked_down_fails_fast_without_touching_the_network(self):
        self.monitor_says("home_down", reason="no answer for 2 checks")
        with patch("urllib.request.urlopen", side_effect=AssertionError("no network call")):
            with self.assertRaises(common.OffboxError) as cm:
                home.person_gate()
        self.assertEqual(cm.exception.code, 93)
        self.assertEqual(common.EXIT_HOME_DOWN, 93)
        self.assertIn("moni's tasks wait", str(cm.exception))
        self.assertIn("nothing was sent to Boat", str(cm.exception))
        self.assertEqual(common.default_backend(), "server")

    def test_marked_up_but_not_answering_is_the_same(self):
        self.monitor_says("home_up")
        with patch.object(home, "probe", return_value="no answer (TimeoutError)"):
            with self.assertRaises(common.OffboxError) as cm:
                home.person_gate()
        self.assertEqual(cm.exception.code, 93)
        with patch.object(home, "probe", return_value=None):
            home.person_gate()

    def test_cli_stops_before_any_box_call_and_local_commands_still_work(self):
        self.monitor_says("home_down")
        err = io.StringIO()
        with patch("offbox_lib.identity.whoami", return_value={"owner": "person:moni", "repo_root": "/p", "repo_key": "moni"}), \
                patch.object(cli, "log"), patch.object(cli, "cmd_run", side_effect=AssertionError("run reached")), \
                patch("offbox_lib.misc.release", side_effect=AssertionError("release reached")), \
                patch("offbox_lib.misc.list_leases") as ls, contextlib.redirect_stderr(err):
            self.assertEqual(cli.main(["run", "--no-sync", "--no-fallback", "--remote", "--", "himalaya envelope list"]), 93)
            self.assertEqual(cli.main(["release", "--mine"]), 93)
            self.assertEqual(cli.main(["list"]), 0)
        ls.assert_called_once()
        self.assertIn("moni's tasks wait", err.getvalue())

    def test_unreachable_mid_call_is_93_not_a_failover(self):
        self.stack.enter_context(patch.object(common, "_BACKEND", "server"))
        a = cli.build_parser().parse_args(["run", "--no-fallback", "--remote", "--", "true"])
        gone = api.NetworkError("offbox server API unreachable")
        with patch("offbox_lib.localfirst.decide", return_value="remote"), patch.object(cli, "log"), \
                patch.object(runs, "run_remote", side_effect=gone), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cli.cmd_run(a, {"owner": "person:moni", "repo_root": "/p", "repo_key": "moni"}), 93)

    def test_her_runs_are_never_retried_by_the_server(self):
        a = cli.build_parser().parse_args(["run", "--", "true"])
        with patch.object(api, "BACKEND", "server"):
            self.assertFalse(runs.retry_interrupted(a))
            with patch.dict(os.environ, {"OFFBOX_THREAD": ""}):
                self.assertTrue(runs.retry_interrupted(a))
                self.assertFalse(runs.retry_interrupted(cli.build_parser().parse_args(["run", "--no-retry", "--", "true"])))


class RetryFlag(unittest.TestCase):
    def test_sent_to_the_home_server_only(self):
        sent = []
        with patch.object(api, "call", side_effect=lambda m, p, body=None, **k: sent.append(body) or {"processId": 1}), \
                patch.object(api, "BACKEND", "server"):
            api.cmd_start("bx_a", "true", meta={"kind": "go test"}, retry_interrupted=True)
            api.cmd_start("bx_a", "true")
        self.assertEqual(sent[0], {"command": "true", "detached": True, "meta": {"kind": "go test"}, "retry_interrupted": True})
        self.assertEqual(sent[1], {"command": "true", "detached": True, "retry_interrupted": False})


class StepEvent(threading.Event):
    """follow()'s retry pause advances the fake clock instead of sleeping."""

    def __init__(self, clock):
        super().__init__()
        self.clock = clock

    def wait(self, timeout=None):
        if not self.is_set():
            self.clock.t += timeout or 0
        return self.is_set()


class Reconnect(unittest.TestCase):
    """A run the home server accepted is followed across a server restart, from the byte it had reached."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.log = Path(self.tmp.name) / "run.log"
        self.clock = Clock()
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(runs, "_ttl_keeper"))
        self.stack.enter_context(patch.object(runs, "now", self.clock.now))
        self.stack.enter_context(patch.object(api, "BACKEND", "server"))
        self.stack.enter_context(patch.object(api, "NAME", "offbox server"))
        self.offsets = []

    def follow(self, attach, status):
        def counted(box, pid, o, e, **kw):
            self.offsets.append((o, e))
            if len(self.offsets) > 400:
                raise AssertionError("follow() never gave up")
            return attach(o, e)
        err = io.StringIO()
        with patch.object(runs.api, "cmd_attach", counted), patch.object(runs.api, "cmd_status", status), \
                contextlib.redirect_stderr(err):
            try:
                return runs.follow("bx_h", 1001, self.log, echo=False, run_id="run-h", stop_evt=StepEvent(self.clock)), \
                    err.getvalue()
            except common.OffboxError as e:
                return e, err.getvalue()

    @staticmethod
    def down(*a, **k):
        raise api.NetworkError("offbox server API unreachable (GET ...): connection refused")

    def test_server_restart_resumes_from_the_byte_offset_and_follows_the_retry(self):
        script = [
            lambda o, e: iter([{"type": "hello", "attempt": 1, "bootId": "boot-1", "serverStartedAt": "t1"},
                               {"type": "stdout", "data": "one\ntwo\n", "nextOffset": 8}, OSError("connection reset")]),
            *[self.down] * 6,
            lambda o, e: iter([{"type": "hello", "attempt": 2, "bootId": "boot-2", "serverStartedAt": "t2"},
                               {"type": "stderr", "data": "queued again as attempt 2\n", "nextOffset": 26},
                               {"type": "stdout", "data": "one\ntwo\nthree\n", "nextOffset": 22},
                               {"type": "exit", "exitCode": 0, "status": "exited", "attempt": 2}]),
        ]

        def frames(o, e):
            step = script.pop(0)
            for fr in step(o, e):
                if isinstance(fr, Exception):
                    raise fr
                yield fr
        rc, err = self.follow(frames, self.down)
        self.assertEqual(rc, 0)
        self.assertEqual(self.offsets[0], (0, 0))
        self.assertTrue(all(o == (8, 0) for o in self.offsets[1:]), "every reconnect asks from byte 8, where it stopped")
        self.assertEqual(self.log.read_text(), "one\ntwo\nqueued again as attempt 2\none\ntwo\nthree\n")
        self.assertEqual(err.count("the offbox server restarted while this run was going"), 1)
        self.assertIn("the machine restarted", err)
        self.assertEqual(err.count("running it again from the start (attempt 2)"), 1)
        self.assertEqual(err.count("lost the connection to the offbox server"), 1)

    def test_boatd_restart_alone_is_said_differently_and_nothing_is_retried(self):
        script = [[{"type": "hello", "attempt": 1, "bootId": "b", "serverStartedAt": "t1"},
                   {"type": "stdout", "data": "abc", "nextOffset": 3}, OSError("reset")],
                  [{"type": "hello", "attempt": 1, "bootId": "b", "serverStartedAt": "t2"},
                   {"type": "stdout", "data": "def", "nextOffset": 6}, {"type": "exit", "exitCode": 5, "status": "exited"}]]

        def frames(o, e):
            for fr in script.pop(0):
                if isinstance(fr, Exception):
                    raise fr
                yield fr
        rc, err = self.follow(frames, lambda *a, **k: {"running": True, "status": "running"})
        self.assertEqual(rc, 5)
        self.assertEqual(self.log.read_text(), "abcdef")
        self.assertIn("its service restarted", err)
        self.assertNotIn("attempt", err)

    def test_keeps_reconnecting_for_fifteen_minutes_then_gives_up_without_running_it_elsewhere(self):
        t0 = self.clock.t

        def frames(o, e):
            raise api.NetworkError("offbox server API unreachable")
            yield
        e, err = self.follow(frames, self.down)
        self.assertIsInstance(e, common.OffboxError)
        self.assertTrue(e.started, "started: the caller must not run it again anywhere")
        self.assertEqual(e.code, common.EXIT_INFRA)
        waited = self.clock.t - t0
        self.assertGreaterEqual(waited, 15 * 60 - 15)
        self.assertLess(waited, 16 * 60)
        self.assertEqual(runs.HOME_RECONNECT_S, 900)
        self.assertIn("Reconnecting for up to 15 min", err)

    def test_interrupted_and_not_retried_is_exit_94(self):
        def frames(o, e):
            yield {"type": "hello", "attempt": 1, "bootId": "boot-2", "serverStartedAt": "t2"}
            yield {"type": "exit", "exitCode": None, "signal": None, "status": "interrupted", "attempt": 1}
        e, _ = self.follow(frames, self.down)
        self.assertIsInstance(e, runs.Interrupted)
        self.assertEqual((e.code, e.started), (94, True))

    def test_status_saying_interrupted_ends_the_wait_too(self):
        def frames(o, e):
            raise OSError("reset")
            yield
        e, _ = self.follow(frames, lambda *a, **k: {"running": False, "status": "interrupted", "exitCode": None})
        self.assertIsInstance(e, runs.Interrupted)

    def test_on_boat_the_outage_window_is_what_it_was(self):
        self.stack.enter_context(patch.object(api, "BACKEND", "boat"))
        t0 = self.clock.t

        def frames(o, e):
            raise api.NetworkError("boat API unreachable")
            yield
        e, err = self.follow(frames, self.down)
        self.assertGreaterEqual(self.clock.t - t0, runs.OUTAGE_FOLLOW_S - 15)
        self.assertNotIn("offbox server", err)


class BoatPlan(Isolated):
    """Boat as the standby on its $20 plan: 12/60/200 starts, no xlarge (numbers from Boat's /limits)."""

    def plan(self, **kw):
        common.kv_set(self.con, capacity.PLAN_KEY, kw)
        self.con.commit()

    def test_without_plan_data_nothing_changes(self):
        self.assertEqual(capacity.windows(self.con), capacity.WINDOWS)
        self.assertTrue(all(capacity.plan_allows(self.con, s) for s in common.SIZES))
        self.assertEqual(lease.plan_size(self.con, "xlarge"), "xlarge")

    def test_the_100_dollar_plan_changes_nothing(self):
        self.plan(key="box_100", dollars=100, starts={"perMinute": 30, "perHour": 210, "perDay": 840},
                  types={s: True for s in common.SIZES})
        self.assertEqual([w[2] for w in capacity.windows(self.con)], [25, 180, 760])
        self.assertEqual(lease.plan_size(self.con, "xlarge"), "xlarge")

    def test_the_20_dollar_plan_lowers_the_start_windows_and_drops_xlarge(self):
        self.plan(key="box_20", dollars=20, starts={"perMinute": 12, "perHour": 60, "perDay": 200},
                  types={"small": True, "default": True, "large": True, "xlarge": False})
        self.assertEqual([w[2] for w in capacity.windows(self.con)], [10, 51, 170])
        self.assertFalse(capacity.plan_allows(self.con, "xlarge"))
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(lease.plan_size(self.con, "xlarge"), "large")
            self.assertEqual(lease.plan_size(self.con, "large"), "large")
        self.assertEqual(err.getvalue().count("no xlarge machines"), 1)
        snap = capacity.snapshot(self.con)
        self.assertEqual([c["cap"] for c in snap["counts"]], [10, 51, 170])

    def test_plan_price_alone_is_enough_to_know_xlarge_is_out(self):
        self.plan(key="box_20", dollars=20)
        self.assertFalse(capacity.plan_allows(self.con, "xlarge"))
        self.assertTrue(capacity.plan_allows(self.con, "large"))

    def test_spend_is_boats_meter_and_never_reads_the_home_server(self):
        with patch.object(api, "BACKEND", "server"), patch.object(api, "limits", side_effect=AssertionError("no call")):
            with self.assertRaises(common.OffboxError) as cm:
                spend.compute()
        self.assertEqual(cm.exception.code, 2)
        with patch.object(api, "BACKEND", "server"):
            lease.cap_check()   # no cap on our own server, whatever cap.json says


class HomeOnlyState(HomeFiles):
    def test_a_base_or_template_that_exists_only_at_home_is_noticed_on_standby_only(self):
        self.configure()
        state = self.dir / "state"
        state.mkdir()
        self.stack.enter_context(patch.object(common, "STATE", state))
        con = sqlite3.connect(common.db_path_for("server"))
        con.executescript(common.SCHEMA)
        con.execute("INSERT INTO bases (name, repo_key, is_default) VALUES ('repo:warm', 'repo', 1)")
        con.execute("INSERT INTO templates (name) VALUES ('crpko-go')")
        con.commit()
        con.close()
        args = ("bases", "repo_key=? AND is_default=1", ("repo",))
        self.assertFalse(home.only_on_home(*args), "home is up: this process is not a standby")
        self.monitor_says("home_down")
        with patch.object(common, "_BACKEND", "boat"):
            self.assertTrue(home.only_on_home(*args))
            self.assertTrue(home.only_on_home("templates", "name=?", ("crpko-go",)))
            self.assertFalse(home.only_on_home("bases", "name=?", ("repo:other",)))
            self.assertFalse(home.only_on_home("leases", "1=1", ()))
        with patch.object(common, "_BACKEND", "boat"), patch.dict(os.environ, {"OFFBOX_BACKEND": "boat"}):
            self.assertFalse(home.only_on_home(*args), "pinned to Boat on purpose: not a standby")
            with patch.dict(os.environ, {home.FAILOVER_ENV: "no answer"}):
                self.assertTrue(home.only_on_home(*args), "this very run failed over")


class ReapBothBackends(HomeFiles):
    def test_the_other_backend_gets_its_own_reaper_process(self):
        self.configure()
        calls = []
        with patch("subprocess.run", side_effect=lambda argv, **kw: calls.append((argv, kw["env"]))), \
                patch.object(common, "_BACKEND", "server"):
            cli._reap_other_backend(False)
        self.assertEqual(calls[0][0][2:], ["reap"])
        self.assertEqual((calls[0][1]["OFFBOX_BACKEND"], calls[0][1]["OFFBOX_REAP_CHILD"]), ("boat", "1"))
        with patch("subprocess.run", side_effect=AssertionError("a child does not start another")), \
                patch.dict(os.environ, {"OFFBOX_REAP_CHILD": "1", "OFFBOX_BACKEND": "boat"}):
            cli._reap_other_backend(False)
        self.monitor_says("home_down")
        with patch("subprocess.run", side_effect=AssertionError("home is down: nothing to reap there")), \
                patch.object(common, "_BACKEND", "boat"):
            cli._reap_other_backend(False)


if __name__ == "__main__":
    unittest.main()
