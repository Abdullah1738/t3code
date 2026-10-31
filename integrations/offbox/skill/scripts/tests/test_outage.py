"""Offline tests: boat.dev API outages (Cloudflare 52x) wait before a start, keep runs attached, and stay quiet on
a closed pipe. No boat calls: urlopen, the Keychain key and api's retry sleeps are patched in every test."""
import contextlib
import io
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
import urllib.error
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, cli, common, fallback, lease, misc, outage, runs  # noqa: E402
from offbox_lib.common import OffboxError  # noqa: E402
from test_capacity import Isolated  # noqa: E402
from test_exit_and_queue import FakeClock  # noqa: E402


def http_error(code):
    return urllib.error.HTTPError("https://boat.dev/api/v1/x", code, "x", {}, io.BytesIO(b""))


def cf(code):
    """A urlopen side effect that answers every call with a fresh HTTP error."""
    def fn(*a, **k):
        raise http_error(code)
    return fn


class OutageBase(Isolated):
    def setUp(self):
        super().setUp()
        self.urlopen = self.stack.enter_context(patch("urllib.request.urlopen", side_effect=OSError("offline")))
        self.stack.enter_context(patch.object(api, "_key", return_value="k"))
        self.stack.enter_context(patch.object(api.time, "sleep"))
        self.clock = FakeClock()
        self.stack.enter_context(patch.object(outage, "time", self.clock.time))
        self.stack.enter_context(patch.object(outage, "now", lambda: self.clock.t))
        self.stack.enter_context(patch.object(common, "now", lambda: self.clock.t))
        self.stack.enter_context(patch.object(api, "_DEADLINE", None))


class ApiOutageTests(OutageBase):
    def test_cloudflare_525_is_an_outage_error(self):
        self.urlopen.side_effect = cf(525)
        with self.assertRaises(api.ApiError) as cm:
            api.get("bx")
        e = cm.exception
        self.assertTrue(e.outage)
        self.assertIn("Cloudflare could not reach boat.dev", str(e))

    def test_plain_500_is_not_an_outage(self):
        self.urlopen.side_effect = cf(500)
        with self.assertRaises(api.ApiError) as cm:
            api.get("bx")
        self.assertFalse(cm.exception.outage)

    def test_network_error_is_an_outage(self):
        with self.assertRaises(OffboxError) as cm:
            api.get("bx")
        self.assertTrue(cm.exception.outage)

    def test_start_post_is_not_resent_on_not_delivered_cloudflare(self):
        self.urlopen.side_effect = cf(525)
        with self.assertRaises(api.ApiError):
            api.cmd_start("bx", "true")
        self.assertEqual(self.urlopen.call_count, 1 + api.CONNECT_RETRIES)

    def test_resume_is_sent_once_on_525(self):
        self.urlopen.side_effect = cf(525)
        with self.assertRaises(api.ApiError):
            api.resume("bx", 1200)
        self.assertEqual(self.urlopen.call_count, 1)

    def test_create_and_fork_are_sent_once_on_not_delivered_cloudflare(self):
        # create/fork carry an Idempotency-Key, which the generic 5xx retry would otherwise resend five times.
        for code in api.CF_NOT_DELIVERED:
            for start in (lambda: api.create("large", 1200, "n", "idem-1"),
                          lambda: api.fork("bx", 1200, "idem-2")):
                self.urlopen.reset_mock()
                self.urlopen.side_effect = cf(code)
                with self.assertRaises(api.ApiError):
                    start()
                self.assertEqual(self.urlopen.call_count, 1, f"HTTP {code} resent a start")

    def test_create_500_still_retries_on_its_idempotency_key(self):
        # Not a Cloudflare not-delivered answer: the existing idempotent retry stays.
        self.urlopen.side_effect = cf(500)
        with self.assertRaises(api.ApiError):
            api.create("large", 1200, "n", "idem-3")
        self.assertGreater(self.urlopen.call_count, 1)

    def test_probe_525_is_one_send(self):
        self.urlopen.side_effect = cf(525)
        self.assertEqual(api.probe(), "HTTP 525")
        self.assertEqual(self.urlopen.call_count, 1)

    def test_probe_500_means_boat_answered(self):
        self.urlopen.side_effect = cf(500)
        self.assertIsNone(api.probe())

    def test_probe_network_error_is_no_answer(self):
        self.assertEqual(api.probe(), "no answer")


class StartRefusalTests(OutageBase):
    def start_with(self, err):
        rn = runs.Runner(cli.build_parser().parse_args(["run", "--", "go", "test", "./..."]), self.me)
        rn.a.steps = []
        row = {"box_id": "bx", "remote_dir": "w/r", "size": "large"}
        with patch.object(runs.pool, "acquire", return_value=row), \
                patch.object(runs.ssh_sync, "put_file"), patch.object(runs.ssh_sync, "push", return_value={}), \
                patch.object(runs.ssh_sync, "tracked_secret_matches", return_value=[]), \
                patch.object(runs.ssh_sync, "probe_home", return_value=None), \
                patch.object(api, "cmd_start", side_effect=err), \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(OffboxError) as cm:
                rn.start()
        return rn, cm.exception

    def test_cloudflare_521_to_526_is_not_started(self):
        rn, _ = self.start_with(api.ApiError(525, "http_525", ""))
        self.assertFalse(rn.started)

    def test_524_and_520_stay_started(self):
        rn, _ = self.start_with(api.ApiError(524, "http_524", ""))
        self.assertTrue(rn.started)
        rn, _ = self.start_with(api.ApiError(520, "http_520", ""))
        self.assertTrue(rn.started)


class OutageStateTests(OutageBase):
    def test_wait_until_up_returns_true_when_boat_answers(self):
        with patch.object(outage.api, "probe", side_effect=["HTTP 525", None]), \
                contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertTrue(outage.wait_until_up("HTTP 525", 600))
        self.assertIn("boat.dev is back", err.getvalue())

    def test_wait_until_up_gives_up_after_budget(self):
        probe = patch.object(outage.api, "probe", return_value="HTTP 525")
        with probe as p, contextlib.redirect_stderr(io.StringIO()):
            start = self.clock.t
            self.assertFalse(outage.wait_until_up("HTTP 525", 60))
        self.assertEqual(p.call_count, 4)
        self.assertLessEqual(self.clock.t - start, 60)

    def test_zero_budget_does_not_probe(self):
        with patch.object(outage.api, "probe") as p, contextlib.redirect_stderr(io.StringIO()):
            self.assertFalse(outage.wait_until_up("HTTP 525", 0))
        p.assert_not_called()

    def test_note_down_keeps_first_since_and_note_up_clears(self):
        first = outage.note_down("HTTP 525")
        self.clock.t += 60
        second = outage.note_down("HTTP 525")
        self.assertEqual(first, second)
        self.assertIsNotNone(outage.current())
        with contextlib.redirect_stderr(io.StringIO()):
            outage.note_up()
        self.assertIsNone(outage.current())


class CmdRunOutageTests(OutageBase):
    def run_cli(self, argv, side_effect, wait=None, fallback_rc=0):
        a = cli.build_parser().parse_args(["run", "--"] + argv)
        err = io.StringIO()
        with patch("offbox_lib.localfirst.decide", return_value="test"), \
                patch.object(runs, "run_remote", side_effect=side_effect) as rr, \
                patch.object(outage, "wait_until_up", return_value=wait) as w, \
                patch.object(fallback, "run_local", return_value=fallback_rc) as loc, \
                patch.object(fallback, "note_infra_failure"), \
                contextlib.redirect_stderr(err):
            rc = cli.cmd_run(a, self.me)
        return rc, rr, w, loc, err.getvalue()

    def test_outage_then_recovery_runs_again(self):
        rc, rr, w, _, _ = self.run_cli(["make", "test"],
                                       [OffboxError("down", outage=True), 0], wait=True)
        self.assertEqual(rc, 0)
        self.assertEqual(rr.call_count, 2)

    def test_outage_past_the_window_fails_with_boat_down(self):
        rc, rr, w, _, err = self.run_cli(["make", "test"], OffboxError("down", outage=True), wait=False)
        self.assertEqual(rc, 90)
        self.assertIn("boat.dev is down", err)

    def test_outage_after_start_does_not_wait(self):
        rc, rr, w, _, _ = self.run_cli(["make", "test"], OffboxError("down", outage=True, started=True), wait=True)
        self.assertEqual(rc, 90)
        w.assert_not_called()

    def test_plain_error_does_not_wait(self):
        rc, rr, w, _, _ = self.run_cli(["make", "test"], OffboxError("boom"), wait=True)
        self.assertEqual(rc, 90)
        w.assert_not_called()

    def test_small_command_falls_back_without_waiting(self):
        rc, rr, w, loc, _ = self.run_cli(["echo", "ok"], OffboxError("down", outage=True), wait=True)
        w.assert_not_called()
        loc.assert_called_once()


class TtlKeeperTests(OutageBase):
    class Evt:
        def __init__(self, stop_after=3):
            self.waits, self.stop_after = [], stop_after

        def wait(self, t):
            self.waits.append(t)
            return len(self.waits) >= self.stop_after

    def test_retry_after_failed_get_then_refresh(self):
        evt = self.Evt()
        with patch.object(runs.lease, "ensure_ttl", return_value=True), \
                patch.object(runs.api, "get", side_effect=[OffboxError("down"), {}, {}]), \
                contextlib.redirect_stderr(io.StringIO()):
            runs._ttl_keeper("bx", evt)
        self.assertEqual(evt.waits, [runs.TTL_RETRY_S, runs.TTL_REFRESH_S, runs.TTL_REFRESH_S])

    def test_failed_refresh_retries_soon(self):
        evt = self.Evt(stop_after=1)
        with patch.object(runs.lease, "ensure_ttl", return_value=False), \
                patch.object(runs.api, "get", return_value={}), \
                contextlib.redirect_stderr(io.StringIO()):
            runs._ttl_keeper("bx", evt)
        self.assertEqual(evt.waits, [runs.TTL_RETRY_S])

    def test_ttl_window_survives_a_25_minute_outage(self):
        self.assertGreaterEqual(common.RUN_TTL_S - common.TTL_REFRESH_S, 25 * 60)

    def test_ensure_ttl_far_deadline_skips_patch(self):
        with patch.object(lease.api, "set_ttl") as st:
            from datetime import datetime, timezone
            import time as real_time
            # lease.now is real time (only outage/common.now is faked), so build the deadline from real time.
            iso_z = datetime.fromtimestamp(real_time.time() + 7200, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            self.assertTrue(lease.ensure_ttl("bx", 1800, {"archiveAfter": iso_z}))
            st.assert_not_called()

    def test_ensure_ttl_patch_ok_is_true(self):
        with patch.object(lease.api, "set_ttl", return_value={}):
            self.assertTrue(lease.ensure_ttl("bx", 1800, {}))

    def test_ensure_ttl_patch_failure_is_false(self):
        with patch.object(lease.api, "set_ttl", side_effect=OffboxError("down")), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertFalse(lease.ensure_ttl("bx", 1800, {}))


class BrokenPipeTests(Isolated):
    def test_say_and_warn_loud_ignore_closed_stderr(self):
        class Closed(io.StringIO):
            def write(self, s):
                raise BrokenPipeError()

            def flush(self):
                raise BrokenPipeError()
        with patch.object(sys, "stderr", Closed()):
            common.say("hello")
            common.warn_loud("careful")

    def test_follow_echo_stops_on_closed_stdout_but_log_keeps_output(self):
        class ClosedBuffer:
            def write(self, b):
                raise BrokenPipeError()

            def flush(self):
                pass

        class ClosedOut:
            buffer = ClosedBuffer()

            def flush(self):
                pass

        frames = iter([{"type": "stdout", "data": "a\n", "nextOffset": 2},
                       {"type": "stdout", "data": "b\n", "nextOffset": 4},
                       {"type": "exit", "exitCode": 3}])
        with tempfile.TemporaryDirectory() as d, \
                patch.object(sys, "stdout", ClosedOut()), \
                patch.object(runs, "_ttl_keeper", return_value=None), \
                patch.object(runs.api, "cmd_attach", return_value=frames), \
                patch.object(runs.lease, "ensure_ttl"), patch.object(runs.api, "get", return_value={}):
            log = Path(d) / "run.log"
            rc = runs.follow("bx", 1, log, echo=True, run_id="r")
            self.assertEqual(rc, 3)
            self.assertEqual(log.read_bytes(), b"a\nb\n")


CLOSED_PIPE_CHILD = r'''
import os, sys
sys.path.insert(0, sys.argv[1])
from pathlib import Path
from unittest.mock import patch
from offbox_lib import runs
frames = iter([{"type": "stdout", "data": "x" * 65536 + "\n", "nextOffset": 65537},
               {"type": "stdout", "data": "tail\n", "nextOffset": 65542},
               {"type": "exit", "exitCode": 3}])
r, w = os.pipe()
os.close(r)  # the reader is gone: the first echo write raises BrokenPipeError
os.dup2(w, 1)
os.close(w)
with patch.object(runs, "_ttl_keeper", return_value=None), \
        patch.object(runs.api, "cmd_attach", return_value=frames), \
        patch.object(runs.lease, "ensure_ttl"), patch.object(runs.api, "get", return_value={}):
    rc = runs.follow("bx", 1, Path(sys.argv[2]), echo=True, run_id="r")
sys.stdout.write("")  # what the caller's own code does before exiting
sys.exit(rc)
'''


class HealthyStreamClearsOutageTests(OutageBase):
    def test_outage_then_healthy_output_then_disconnect_reattaches(self):
        # One brief 525, then the stream recovers and runs an hour. A later ordinary socket timeout must reattach
        # normally, not fail as "API was down for 1800s" from the earlier outage's start.
        clock = {"t": 1000.0}
        attaches = []

        def attach(box, pid, o, e, timeout=90, deadline=None):
            attaches.append(clock["t"])
            if len(attaches) == 1:
                clock["t"] += 5
                raise api.ApiError(525, "http_525", "")
            if len(attaches) == 2:
                # healthy stream: frames for an hour, then a socket timeout mid-run
                def frames():
                    yield {"type": "stdout", "data": "ok\n", "nextOffset": 3}
                    clock["t"] += 3600
                    raise OSError("timed out")
                return frames()
            return iter([{"type": "exit", "exitCode": 0}])

        def status(box, pid, timeout=60, retries=2, deadline=None):
            return {"running": True, "status": "running"}

        with patch.object(runs, "_ttl_keeper", return_value=None), \
                patch.object(runs.api, "cmd_attach", side_effect=attach), \
                patch.object(runs.api, "cmd_status", side_effect=status), \
                patch.object(runs, "now", lambda: clock["t"]), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            rc = runs.follow("bx", 1, None, echo=False, stop_evt=FollowOutageTests.Evt())
        self.assertEqual(rc, 0)
        self.assertEqual(len(attaches), 3)


class StatusConnectRetryTests(OutageBase):
    def test_status_inside_the_window_sends_a_52x_once_through_the_real_call(self):
        # Real api.cmd_status -> api.call (no cmd_status mock). A not-delivered 525 must not get connect retries
        # or their sleeps once the outage window is what bounds the request.
        import time as real_time
        self.urlopen.side_effect = cf(525)
        # api deadlines are real time.time(): an outage window that started now has its whole length left.
        with self.assertRaises(api.ApiError):
            api.cmd_status("bx", 1, timeout=60, retries=0, deadline=real_time.time() + runs.OUTAGE_FOLLOW_S)
        self.assertEqual(self.urlopen.call_count, 1)

    def test_status_without_absolute_end_still_bounded_by_connect_retries_only_when_asked(self):
        # Documents the reason for the deadline: no deadline keeps the connect retries (5 extra sends).
        self.urlopen.side_effect = cf(525)
        with self.assertRaises(api.ApiError):
            api.cmd_status("bx", 1, timeout=60, retries=0)
        self.assertGreater(self.urlopen.call_count, 1)


class ClosedStderrSubprocessTests(Isolated):
    def test_say_then_exit_code_survives_a_closed_stderr_pipe(self):
        code = (
            "import os, sys\n"
            "sys.path.insert(0, sys.argv[1])\n"
            "from offbox_lib import common\n"
            "r, w = os.pipe(); os.close(r); os.dup2(w, 2); os.close(w)\n"
            "common.say('hello'); common.warn_loud('careful')\n"
            "sys.exit(3)\n"
        )
        import subprocess
        scripts = str(Path(__file__).resolve().parents[1])
        p = subprocess.run([sys.executable, "-W", "ignore", "-c", code, scripts], capture_output=True, timeout=60)
        self.assertEqual(p.returncode, 3, p.stderr.decode(errors="replace")[-500:])
        self.assertNotIn(b"BrokenPipeError", p.stderr)


class ClosedPipeSubprocessTests(Isolated):
    def test_exit_code_survives_a_closed_stdout_pipe(self):
        # A real closed pipe: the interpreter's shutdown flush must not raise and replace the remote exit code.
        import subprocess
        scripts = str(Path(__file__).resolve().parents[1])
        with tempfile.TemporaryDirectory() as d:
            p = subprocess.run([sys.executable, "-W", "ignore", "-c", CLOSED_PIPE_CHILD, scripts,
                                str(Path(d) / "run.log")], capture_output=True, timeout=60)
            self.assertEqual(p.returncode, 3, p.stderr.decode(errors="replace")[-500:])
            self.assertNotIn(b"BrokenPipeError", p.stderr)
            self.assertEqual((Path(d) / "run.log").read_bytes()[:5], b"xxxxx")


class FollowOutageTests(OutageBase):
    class Evt:
        def is_set(self):
            return False

        def wait(self, t):
            return False

        def set(self):
            pass

    def follow(self, status_error, attach_error=None):
        if attach_error is None:
            attach_error = api.ApiError(525, "http_525", "")
        clock_calls = {"n": 0}

        def fake_now():
            clock_calls["n"] += 10
            return 1000.0 + clock_calls["n"]
        with patch.object(runs, "_ttl_keeper", return_value=None), \
                patch.object(runs.api, "cmd_attach", side_effect=attach_error) as att, \
                patch.object(runs.api, "cmd_status", side_effect=status_error), \
                patch.object(runs, "now", fake_now), \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(OffboxError) as cm:
                runs.follow("bx", 1, None, echo=False, stop_evt=self.Evt())
        return att, cm.exception

    def test_follow_rides_out_an_outage(self):
        att, e = self.follow(api.ApiError(525, "http_525", ""))
        self.assertGreater(att.call_count, 25)
        self.assertIn("lost the output stream", str(e))
        self.assertTrue(e.started)

    def test_outage_window_holds_on_a_slow_request_clock(self):
        # Each attach hangs 90 s and each status 60 s before failing (the reported slow-timeout pattern). The
        # 30-minute outage window must end the follow near 30 min of wall clock, not after the 21-failure count.
        clock = {"t": 1000.0, "first_fail": None}

        # Each request hangs for its whole timeout, then fails: the fake clock advances by the timeout it was given.
        # The outage window opens at the first failure, so the first attach's own 90 s is before it.
        def slow_attach(*a, **k):
            clock["t"] += min(90.0, k.get("timeout", 90))
            if clock["first_fail"] is None:
                clock["first_fail"] = clock["t"]
            raise api.ApiError(525, "http_525", "")

        def slow_status(*a, **k):
            clock["t"] += min(60.0, k.get("timeout", 60))
            raise api.ApiError(525, "http_525", "")

        def fake_now():
            return clock["t"]

        with patch.object(runs, "_ttl_keeper", return_value=None), \
                patch.object(runs.api, "cmd_attach", side_effect=slow_attach) as att, \
                patch.object(runs.api, "cmd_status", side_effect=slow_status), \
                patch.object(runs, "now", fake_now), \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(OffboxError) as cm:
                runs.follow("bx", 1, None, echo=False, stop_evt=self.Evt())
        outage_s = clock["t"] - clock["first_fail"]
        self.assertIn("lost the output stream", str(cm.exception))
        self.assertLessEqual(outage_s, runs.OUTAGE_FOLLOW_S + 2)  # holds to within one second of the window
        self.assertGreater(outage_s, runs.OUTAGE_FOLLOW_S - 120)  # and it does use the window, not gives up early
        self.assertGreater(att.call_count, 5)

    def test_follow_gives_up_after_21_non_outage_failures(self):
        att, e = self.follow(OffboxError("x"), attach_error=OffboxError("x"))
        self.assertEqual(att.call_count, 21)


class StatusTests(OutageBase):
    def test_status_is_bounded_and_says_when_boat_is_down(self):
        calls = []

        def limits():
            calls.append(api.left())
            raise OffboxError("boat API unreachable")

        def boxes(*a, **k):
            calls.append(api.left())
            raise OffboxError("boat API unreachable")
        outage.note_down("HTTP 525")
        out = io.StringIO()
        with patch.object(misc.api, "limits", side_effect=limits), \
                patch.object(misc.api, "list_boxes", side_effect=boxes), \
                contextlib.redirect_stdout(out):
            misc.status({"owner": "w", "repo_root": "/r"})
        text = out.getvalue()
        self.assertIn("account: boat API unreachable", text)
        self.assertIn("boxes: boat API unreachable", text)
        self.assertIn("boat.dev: DOWN since", text)
        self.assertEqual(len(calls), 2)
        for left in calls:
            self.assertIsNotNone(left)
            self.assertLessEqual(left, misc.STATUS_CALL_S)


if __name__ == "__main__":
    unittest.main()
