"""Regression simulations for the 17 November five-hour backend outage."""
import json
import os
from pathlib import Path
import tempfile
import signal
import subprocess
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import Mock, patch

import guard
from hold import Holds


class RecoveryTests(unittest.TestCase):
    desktop = dict(pid=42, identity="fixture-birth", startedAt=9000)

    def test_orphaned_workers_do_not_prevent_absent_desktop_reopen(self):
        for missing_credential in [False, True]:
            with self.subTest(missing_credential=missing_credential), tempfile.TemporaryDirectory() as directory:
                home = Path(directory)
                probe = guard.backend_ready if missing_credential else lambda home: False
                with patch("guard.process_up", return_value=True), patch("quit_reason.desktop_pid", return_value=None), \
                        patch("guard.backend_ready", side_effect=probe), patch("guard.boot_epoch", return_value=0), \
                        patch("guard.stop_unready_desktop") as stopped, patch("guard.reopen") as opened:
                    for now in [10000, 10030, 10060, 10120]:
                        with patch("guard.time.time", return_value=now):
                            guard.check(home)
                    opened.assert_called_once_with(home)
                    stopped.assert_not_called()
                state = guard.read_state(home / ".local/state/robob-guard/state.json")
                self.assertEqual(state["last_reopen"], 10030)
                self.assertEqual(state["failed_reopens"], 1)
                self.assertEqual(state["next_retry"], 10240)

    def test_young_desktop_appearing_during_final_recheck_cancels_open(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            state_path = home / ".local/state/robob-guard/state.json"
            guard.atomic_json(state_path, dict(guard.initial_state(), down_count=1))
            identity = "Mon Nov 16 07:24:59 2026"
            started = time.mktime(time.strptime(identity, "%a %b %d %H:%M:%S %Y"))
            with patch("guard.backend_ready", return_value=False), patch("guard.process_up", return_value=True), \
                    patch("quit_reason.desktop_pid", side_effect=[None, 42]), \
                    patch("guard.desktop_identity", return_value=identity), patch("guard.time.time", return_value=started+30), \
                    patch("guard.boot_epoch", return_value=0), patch("guard.reopen") as opened, \
                    patch("guard.stop_unready_desktop") as stopped:
                guard.check(home)
                opened.assert_not_called()
                stopped.assert_not_called()
            self.assertEqual(guard.read_state(state_path)["history"], [])

    def test_discovery_failure_and_unverified_target_never_replace(self):
        for lookup in [OSError("discovery"), 42]:
            with self.subTest(lookup=lookup), tempfile.TemporaryDirectory() as directory:
                with patch("guard.backend_ready", return_value=False), patch("guard.process_up", return_value=True), \
                        patch("quit_reason.desktop_pid", side_effect=lookup if isinstance(lookup, Exception) else None,
                              return_value=lookup), patch("guard.desktop_identity", return_value=None), \
                        patch("guard.reopen") as opened, patch("guard.stop_unready_desktop") as stopped:
                    guard.check(Path(directory))
                    opened.assert_not_called()
                    stopped.assert_not_called()

    def test_live_desktop_with_dead_backend_is_relaunched(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            with patch("guard.desktop_snapshot", return_value=self.desktop), \
                    patch("guard.backend_ready", return_value=False, create=True), \
                    patch("guard.stop_unready_desktop", create=True) as stopped, \
                    patch("guard.boot_epoch", return_value=0), \
                    patch("guard.time.time", return_value=10000), \
                    patch("guard.reopen") as opened:
                for now in range(10000, 10180, 30):
                    with patch("guard.time.time", return_value=now):
                        guard.check(home)
                    opened.assert_not_called()
                with patch("guard.time.time", return_value=10180):
                    guard.check(home)
                stopped.assert_called_once_with(home, self.desktop)
                opened.assert_called_once_with(home)
            state = guard.read_state(home / ".local/state/robob-guard/state.json")
            self.assertEqual(state["last_reopen"], 10180)
            self.assertEqual(state["last_replace"], 10180)
            self.assertTrue(state["awaiting_reopen"])

    def test_two_misses_then_recovery_never_replace_a_slow_backend(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            with patch("guard.desktop_snapshot", return_value=self.desktop), \
                    patch("guard.backend_ready", side_effect=[False, False, True]), \
                    patch("guard.boot_epoch", return_value=0), \
                    patch("guard.reopen") as opened, patch("guard.stop_unready_desktop") as stopped:
                for now in [10000, 10030, 10060]:
                    with patch("guard.time.time", return_value=now):
                        guard.check(home)
                stopped.assert_not_called()
                opened.assert_not_called()
            state = guard.read_state(home / ".local/state/robob-guard/state.json")
            self.assertEqual(state["history"], [])
            self.assertIsNone(state["unready_since"])

    def test_startup_grace_then_full_unready_window(self):
        state = guard.initial_state()
        desktop = dict(self.desktop, startedAt=10000)
        actions = []
        for now in range(10000, 10361, 30):
            state, _, action = guard.decide(state, now=now, up=False, boot_time=9999, desktop=desktop)
            if action == "replace":
                actions.append(now)
        self.assertEqual(actions, [10360])

    def test_replace_cooldown_survives_health_holds_and_new_desktop(self):
        state = guard.initial_state()
        replaced = []
        cooldown_seen = False
        for now in range(10000, 13001, 30):
            desktop = dict(self.desktop, pid=42 + len(replaced))
            recovered = now in [10300, 10330]
            hold = dict(by="test", pid=99, startedAt=10400, beatAt=now) if 10420 <= now < 10480 else None
            state, statuses, action = guard.decide(state, now=now, up=recovered, boot_time=0,
                desktop=desktop, hold=hold, hold_pid_alive=True)
            if action == "replace":
                replaced.append(now)
            cooldown_seen |= any(s.startswith("replace-cooldown:") for s in statuses)
        self.assertTrue(cooldown_seen)
        self.assertGreaterEqual(len(replaced), 2)
        self.assertTrue(all(b - a >= 900 for a, b in zip(replaced, replaced[1:])))

    def test_unknown_checks_or_changed_desktop_reset_unready_window(self):
        for interruption in ["gap", "identity", "unverified"]:
            with self.subTest(interruption=interruption):
                state = guard.initial_state()
                for now in [10000, 10090]:
                    state, _, _ = guard.decide(state, now=now, up=False, boot_time=0, desktop=self.desktop)
                now = 10181 if interruption == "gap" else 10180
                desktop = dict(self.desktop, pid=43) if interruption == "identity" else self.desktop
                if interruption == "unverified":
                    desktop = {}
                state, _, action = guard.decide(state, now=now, up=False, boot_time=0, desktop=desktop)
                self.assertEqual(action, "backoff")
                self.assertEqual(state["history"], [])

    def test_fresh_beats_cannot_hold_guard_past_creation_cap(self):
        state = guard.initial_state()
        actions = []
        for elapsed in range(0, 1831, 30):
            now = 10000 + elapsed
            state, _, action = guard.decide(
                state, now=now, up=False, boot_time=0,
                hold=dict(by="overload-restart", pid=42, startedAt=10000, beatAt=now),
                hold_pid_alive=True)
            if action == "reopen":
                actions.append(elapsed)
        self.assertEqual(actions, [1830])

    def test_stuck_desktop_is_replaced_after_hold_cap_and_observation_window(self):
        state = guard.initial_state()
        actions = []
        for elapsed in range(0, 2101, 30):
            now = 10000 + elapsed
            state, _, action = guard.decide(state, now=now, up=False, boot_time=0,
                desktop=self.desktop, hold=dict(by="overload-restart", pid=42, startedAt=10000, beatAt=now),
                hold_pid_alive=True)
            if action == "replace":
                actions.append(elapsed)
        self.assertEqual(actions, [1980])

    def test_cooldown_is_persisted_and_logged(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            state_path = home / ".local/state/robob-guard/state.json"
            guard.atomic_json(state_path, dict(guard.initial_state(), last_replace=10000,
                unready_since=10120, unready_last=10270, unready_ticks=6, unready_desktop="42:fixture-birth"))
            with patch("guard.backend_ready", return_value=False), \
                    patch("guard.desktop_snapshot", return_value=self.desktop), \
                    patch("guard.time.time", return_value=10300), patch("guard.boot_epoch", return_value=0), \
                    patch("guard.reopen") as opened, patch("guard.stop_unready_desktop") as stopped:
                guard.check(home)
                stopped.assert_not_called()
                opened.assert_not_called()
            self.assertEqual(guard.read_state(state_path)["last_replace"], 10000)
            self.assertIn("replace-cooldown:600s", (state_path.parent / "guard.log").read_text())

    def test_beater_stops_at_cap_without_refreshing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            holds = Holds(Path(directory))
            hold = dict(by="test", pid=os.getpid(), startedAt=10000, beatAt=11780)
            guard.atomic_json(holds.path, hold)
            with patch("hold.time.time", return_value=11800):
                self.assertFalse(holds.beat("test", os.getpid()))
            self.assertEqual(json.loads(holds.path.read_text()), hold)

    def test_expired_hold_cannot_be_renewed_by_start(self):
        with tempfile.TemporaryDirectory() as directory:
            holds = Holds(Path(directory))
            with patch("hold.time.time", return_value=10000), patch("hold.subprocess.Popen", return_value=Mock(pid=99)):
                holds.start("test", os.getpid())
            with patch("hold.time.time", return_value=10060), \
                    patch.object(holds, "beater_is_ours", return_value=False), \
                    patch("hold.subprocess.Popen", return_value=Mock(pid=100)):
                holds.start("test", os.getpid())
            self.assertEqual(json.loads(holds.path.read_text())["startedAt"], 10000)
            with patch("hold.time.time", return_value=11800), self.assertRaisesRegex(ValueError, "expired"):
                holds.start("test", os.getpid())

    def test_creation_timestamp_corpus(self):
        for started, expected in [(8200, False), (8200.001, True), (10000, True), (10001, False),
                                  (None, False), (True, False), ("10000", False),
                                  (float("inf"), False), (float("nan"), False)]:
            with self.subTest(started=started):
                self.assertEqual(guard.valid_hold(dict(by="test", pid=42, startedAt=started, beatAt=10000),
                                                 10000, True), expected)

    def test_backend_recovery_during_recheck_cancels_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            state_path = home / ".local/state/robob-guard/state.json"
            guard.atomic_json(state_path, dict(guard.initial_state(), down_count=1))
            with patch("guard.backend_ready", side_effect=[False, True]), \
                    patch("guard.desktop_snapshot", return_value=None), \
                    patch("guard.boot_epoch", return_value=0), patch("guard.reopen") as opened, \
                    patch("guard.stop_unready_desktop") as stopped:
                guard.check(home)
                opened.assert_not_called()
                stopped.assert_not_called()
            self.assertEqual(guard.read_state(state_path)["history"], [])

    def test_starting_desktop_does_not_consume_reopen_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            state_path = home / ".local/state/robob-guard/state.json"
            previous = dict(guard.initial_state(), down_count=1)
            guard.atomic_json(state_path, previous)
            with patch("guard.backend_ready", return_value=False), \
                    patch("guard.desktop_snapshot", return_value=dict(self.desktop, startedAt=time.time())), \
                    patch("guard.stop_unready_desktop") as stopped, \
                    patch("guard.boot_epoch", return_value=0), patch("guard.reopen") as opened:
                guard.check(home)
                opened.assert_not_called()
                stopped.assert_not_called()
            state = guard.read_state(state_path)
            self.assertEqual(state["history"], [])
            self.assertIsNone(state["last_replace"])

    def test_replaced_desktop_at_final_recheck_is_left_alone(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            previous = dict(guard.initial_state(), unready_since=10000, unready_last=10150,
                            unready_ticks=6, unready_desktop="42:fixture-birth")
            state_path = home / ".local/state/robob-guard/state.json"
            guard.atomic_json(state_path, previous)
            with patch("guard.backend_ready", return_value=False), \
                    patch("guard.desktop_snapshot", side_effect=[self.desktop, dict(self.desktop, pid=43)]), \
                    patch("guard.time.time", return_value=10180), patch("guard.boot_epoch", return_value=0), \
                    patch("guard.reopen") as opened, patch("guard.stop_unready_desktop") as stopped:
                guard.check(home)
                stopped.assert_not_called()
                opened.assert_not_called()
            self.assertEqual(guard.read_state(state_path)["history"], [])


class HealthTests(unittest.TestCase):
    def test_existing_t3ctl_component_credential_is_supported(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config = home / ".robob/components/t3ctl.json"
            guard.atomic_json(config, dict(url="http://127.0.0.1:3773", token="fixture-component"))
            config.chmod(0o600)
            with patch("guard.subprocess.run", return_value=Mock(returncode=0, stdout='{"ok":true,"status":"healthy"}\n200')) as run:
                self.assertTrue(guard.backend_ready(home))
                self.assertIn("fixture-component", run.call_args.kwargs["input"])
                self.assertNotIn("fixture-component", " ".join(run.call_args.args[0]))
    def test_authenticated_local_health_response_corpus(self):
        responses = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                responses.append((self.path, self.headers.get("Authorization")))
                self.send_response(self.server.code)
                self.end_headers()
                self.wfile.write(self.server.body)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config = home / ".robob/ardud-control.json"
            guard.atomic_json(config, dict(url="http://127.0.0.1:" + str(server.server_port), token="fixture-token"))
            config.chmod(0o600)
            for code, body, expected in [
                (200, '{"ok":true,"status":"healthy"}', True),
                (200, '{"ok":true,"status":"degraded"}', True),
                (200, '{"ok":true,"status":"recovered-unverified"}', True),
                (503, '{"ok":false,"status":"starting"}', False),
                (200, '{"ok":true,"status":"starting"}', False),
                (200, '{"ok":"true","status":"healthy"}', False),
                (200, '{"ok":false,"status":"healthy"}', False),
                (200, "null", False), (200, "[]", False), (200, "<html>login</html>", False),
            ]:
                with self.subTest(code=code, body=body):
                    server.code, server.body = code, body.encode()
                    self.assertEqual(guard.backend_ready(home), expected)
            server.code, server.body = 401, b"{}"
            with self.assertRaisesRegex(ValueError, "credential rejected"):
                guard.backend_ready(home)
        self.assertTrue(responses)
        self.assertEqual(set(responses), {("/api/ardud/control/health", "Bearer fixture-token")})

    def test_network_timeout_and_refusal_are_down_without_credentials_in_argv(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config = home / ".robob/ardud-control.json"
            guard.atomic_json(config, dict(url="http://127.0.0.1:3773", token="fixture-token"))
            config.chmod(0o600)
            for failure in [subprocess.TimeoutExpired("curl", 5), Mock(returncode=7)]:
                with self.subTest(failure=failure), patch("guard.subprocess.run") as run:
                    if isinstance(failure, Exception):
                        run.side_effect = failure
                    else:
                        run.return_value = failure
                    self.assertFalse(guard.backend_ready(home))
                    self.assertNotIn("fixture-token", " ".join(run.call_args.args[0]))
                    self.assertIn("--max-time", run.call_args.args[0])
                    self.assertEqual(run.call_args.kwargs["timeout"], 5)

    def test_whole_http_exchange_has_a_deadline(self):
        release = threading.Event()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                release.wait(5)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                home = Path(directory)
                config = home / ".robob/ardud-control.json"
                guard.atomic_json(config, dict(url="http://127.0.0.1:%s" % server.server_port, token="test"))
                config.chmod(0o600)
                with patch("guard.HEALTH_DEADLINE", 0.1):
                    started = time.monotonic()
                    self.assertFalse(guard.backend_ready(home))
                    self.assertLess(time.monotonic() - started, 3)
        finally:
            release.set()
            server.shutdown()
            server.server_close()
            thread.join()

    def test_bad_or_remote_credentials_do_not_trigger_recovery(self):
        for value in [[], {}, {"url": "http://remote.example", "token": "test"}]:
            with self.subTest(value=value), tempfile.TemporaryDirectory() as directory:
                home = Path(directory)
                config = home / ".robob/ardud-control.json"
                guard.atomic_json(config, value)
                config.chmod(0o600)
                guard.atomic_json(home / ".local/state/robob-guard/state.json",
                                  dict(guard.initial_state(), down_count=1))
                with patch("guard.reopen") as opened, patch("guard.stop_unready_desktop") as stopped:
                    guard.check(home)
                    opened.assert_not_called()
                    stopped.assert_not_called()

    def test_missing_credential_never_replaces_a_present_desktop(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch("guard.desktop_snapshot", return_value={}), \
                    patch("guard.reopen") as opened, patch("guard.stop_unready_desktop") as stopped:
                guard.check(Path(directory))
                opened.assert_not_called()
                stopped.assert_not_called()
            with patch("guard.process_up", return_value=False):
                self.assertFalse(guard.backend_ready(Path(directory)))


class LateRecoveryTests(unittest.TestCase):
    identity = "Mon Nov 16 07:24:59 2026"

    def seed(self, home):
        started = time.mktime(time.strptime(self.identity, "%a %b %d %H:%M:%S %Y"))
        self.now = started + 1000
        self.desktop = dict(pid=42, identity=self.identity, startedAt=started)
        self.path = home / ".local/state/robob-guard/state.json"
        guard.atomic_json(self.path, dict(guard.initial_state(), down_count=6, unready_since=self.now-180,
            unready_last=self.now-30, unready_ticks=6, unready_desktop="42:"+self.identity))

    def test_health_returning_during_handoff_cancels_signals_and_open(self):
        for status in ["healthy", "degraded", "recovered-unverified"]:
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                home = Path(directory)
                self.seed(home)
                config = home / ".robob/components/t3ctl.json"
                guard.atomic_json(config, dict(url="http://127.0.0.1:3773", token="fixture"))
                config.chmod(0o600)
                recovered = []
                def response(*args, **kwargs):
                    return Mock(returncode=0, stdout=(json.dumps(dict(ok=True, status=status))+"\n200"
                        if recovered else '{"ok":false,"status":"starting"}\n503'))
                child = Mock(wait=Mock(side_effect=lambda **kwargs: recovered.append(True) or 0))
                with patch("guard.desktop_snapshot", return_value=self.desktop), \
                        patch("quit_reason.desktop_pid", return_value=42), patch("guard.desktop_identity", return_value=self.identity), \
                        patch("guard.subprocess.run", side_effect=response), patch("guard.subprocess.Popen", return_value=child), \
                        patch("guard.boot_epoch", return_value=0), patch("guard.time.time", return_value=self.now), \
                        patch("guard.os.kill") as kill, patch("guard.reopen") as opened:
                    guard.check(home)
                    child.wait.assert_called_once_with(timeout=3)
                    kill.assert_not_called()
                    opened.assert_not_called()
                state = guard.read_state(self.path)
                self.assertIsNone(state["unready_since"])
                self.assertEqual(state["history"], [])
                self.assertIsNone(state["last_replace"])

    def test_late_identity_change_cancels_but_an_exited_desktop_can_reopen(self):
        for kind in ["new-pid", "new-birth", "exited"]:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                home = Path(directory)
                self.seed(home)
                final = None if kind == "exited" else dict(self.desktop,
                    pid=43 if kind == "new-pid" else 42,
                    identity="Tue Nov 17 07:24:59 2026" if kind == "new-birth" else self.identity)
                with patch("guard.backend_ready", return_value=False), \
                        patch("guard.desktop_snapshot", side_effect=[self.desktop, self.desktop, final]), \
                        patch("quit_reason.desktop_pid", return_value=42), patch("guard.desktop_identity", return_value=self.identity), \
                        patch("guard.subprocess.Popen", return_value=Mock(wait=Mock(return_value=0))), \
                        patch("guard.boot_epoch", return_value=0), patch("guard.time.time", return_value=self.now), \
                        patch("guard.os.kill") as kill, patch("guard.reopen") as opened:
                    guard.check(home)
                    kill.assert_not_called()
                    self.assertEqual(opened.call_count, int(kind == "exited"))
                state = guard.read_state(self.path)
                self.assertEqual(len(state["history"]), int(kind == "exited"))
                self.assertIsNone(state["unready_since"])

    def test_health_recovery_after_sigterm_keeps_attempt_cooldown(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            self.seed(home)
            with patch("guard.backend_ready", side_effect=[False, False, False, True]), \
                    patch("guard.desktop_snapshot", return_value=self.desktop), \
                    patch("quit_reason.desktop_pid", return_value=42), patch("guard.desktop_identity", return_value=self.identity), \
                    patch("guard.subprocess.Popen", return_value=Mock(wait=Mock(return_value=0))), \
                    patch("guard.boot_epoch", return_value=0), patch("guard.time.time", return_value=self.now), \
                    patch("guard.time.monotonic", side_effect=[0, 3]), \
                    patch("guard.os.kill") as kill, patch("guard.reopen") as opened:
                guard.check(home)
                kill.assert_called_once_with(42, signal.SIGTERM)
                opened.assert_not_called()
            self.assertEqual(guard.read_state(self.path)["last_replace"], self.now)

    def test_disappearance_rechecks_health_before_reopen_and_keeps_attempt(self):
        for stage in ["before-handoff", "before-signal", "signal-missing", "after-sigterm"]:
            for status in [None, "healthy", "degraded", "recovered-unverified"]:
                with self.subTest(stage=stage, status=status), tempfile.TemporaryDirectory() as directory:
                    home = Path(directory)
                    self.seed(home)
                    config = home / ".robob/components/t3ctl.json"
                    guard.atomic_json(config, dict(url="http://127.0.0.1:3773", token="fixture"))
                    config.chmod(0o600)
                    exited = []
                    identity_reads = []

                    def registered_pid():
                        if stage == "before-handoff":
                            exited.append(True)
                            return None
                        return 42

                    def identity(pid):
                        identity_reads.append(pid)
                        if stage == "before-signal" and len(identity_reads) == 2:
                            exited.append(True)
                        return None if exited else self.identity

                    def signal_target(pid, sig):
                        exited.append(True)
                        if stage == "signal-missing":
                            raise ProcessLookupError("target exited before signal")

                    def response(*args, **kwargs):
                        ready = bool(exited) and status is not None
                        body = dict(ok=ready, status=status if ready else "starting")
                        return Mock(returncode=0, stdout=json.dumps(body)+("\n200" if ready else "\n503"))

                    with patch("guard.desktop_snapshot", side_effect=lambda: None if exited else self.desktop), \
                            patch("quit_reason.desktop_pid", side_effect=registered_pid), \
                            patch("guard.desktop_identity", side_effect=identity), \
                            patch("guard.subprocess.run", side_effect=response), \
                            patch("guard.subprocess.Popen", return_value=Mock(wait=Mock(return_value=0))), \
                            patch("guard.boot_epoch", return_value=0), patch("guard.time.time", return_value=self.now), \
                            patch("guard.time.monotonic", side_effect=[0, 0]), \
                            patch("guard.os.kill", side_effect=signal_target) as kill, patch("guard.reopen") as opened:
                        guard.check(home)
                        self.assertEqual(kill.call_args_list, [unittest.mock.call(42, signal.SIGTERM)]
                            if stage in ("signal-missing", "after-sigterm") else [])
                        self.assertEqual(opened.call_count, int(status is None))
                    state = guard.read_state(self.path)
                    self.assertIsNone(state["unready_since"])
                    self.assertEqual(state["last_replace"], self.now)
                    self.assertEqual(state["history"], [self.now])


class NestedHoldTests(unittest.TestCase):
    def test_delayed_beats_resume_only_before_creation_deadline(self):
        for token in [None, "generation"]:
            with self.subTest(token=token), tempfile.TemporaryDirectory() as directory:
                holds = Holds(Path(directory))
                original = dict(by="parent", pid=os.getpid(), startedAt=10000, beatAt=10000)
                guard.atomic_json(holds.path, original)
                guard.atomic_json(holds.meta, dict(token="generation"))
                with patch("hold.time.time", return_value=11799):
                    self.assertTrue(holds.beat("parent", os.getpid(), token))
                self.assertEqual(json.loads(holds.path.read_text())["startedAt"], 10000)
                with patch("hold.time.time", return_value=11800):
                    self.assertFalse(holds.beat("parent", os.getpid(), token))
                self.assertEqual(json.loads(holds.path.read_text())["beatAt"], 11799)

    def test_explicit_stop_allows_a_new_cycle(self):
        with tempfile.TemporaryDirectory() as directory:
            holds = Holds(Path(directory))
            guard.atomic_json(holds.path, dict(by="old", pid=os.getpid(), startedAt=10000, beatAt=11800))
            self.assertTrue(holds.stop("old", os.getpid()))
            with patch("hold.time.time", return_value=11800), patch("hold.subprocess.Popen", return_value=Mock(pid=99)):
                holds.start("new", os.getpid())
            self.assertEqual(json.loads(holds.path.read_text())["startedAt"], 11800)

    def test_shell_and_node_inherited_hold_lifecycle(self):
        source = Path(__file__).resolve().parent
        library = source / "scripts/install-hold.zsh"
        module = source.parents[1] / "apps/desktop/scripts/robob-install-hold.mjs"
        for wrapper in ["shell", "node"]:
            for age, alive in [(1799, True), (1800, True), (1800, False)]:
                with self.subTest(wrapper=wrapper, age=age, alive=alive), tempfile.TemporaryDirectory() as directory:
                    home = Path(directory)
                    helper = home / ".local/bin/robob-install-hold"
                    helper.parent.mkdir(parents=True)
                    # The production CLI runs with an injected clock in an isolated test home.
                    helper.write_text('#!/usr/bin/python3 -I\nimport os,sys\nsys.path.insert(0,'+repr(str(source))+')\n'
                        'import hold\nhold.time.time=lambda:10000\nsys.exit(hold.main())\n')
                    helper.chmod(0o755)
                    owner = os.getpid() if alive else 2147483647
                    old = dict(by="parent", pid=owner, startedAt=10000-age, beatAt=9980)
                    path = home / ".robob/install-hold.json"
                    guard.atomic_json(path, old)
                    env = dict(os.environ, HOME=directory, ROBOB_INSTALL_HOLD_BY="parent",
                               ROBOB_INSTALL_HOLD_PID=str(owner), PYTHONDONTWRITEBYTECODE="1")
                    if wrapper == "shell":
                        command = ["/bin/zsh", "-f", "-c",
                            'source "$1"; robob_hold_begin nested >/dev/null || exit $?; '
                            'cat "$HOME/.robob/install-hold.json"; exit 0',
                            "test", str(library)]
                    else:
                        script = home / "acquire.mjs"
                        script.write_text('import {acquireInstallHold} from '+json.dumps(module.as_uri())+';\n'
                            'import fs from "node:fs";\nconst h=await acquireInstallHold({home:process.env.HOME});\n'
                            'console.log(fs.readFileSync(process.env.HOME+"/.robob/install-hold.json","utf8"));\nawait h.release();\n')
                        command = ["node", str(script)]
                    result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=10)
                    if alive and age == 1800:
                        self.assertNotEqual(result.returncode, 0)
                        self.assertEqual(json.loads(path.read_text()), old)
                        self.assertFalse(guard.valid_hold(old, 10000, True))
                    else:
                        self.assertEqual(result.returncode, 0, result.stderr)
                        observed = json.loads(result.stdout)
                        self.assertEqual(observed["startedAt"], old["startedAt"] if alive else 10000)
                        self.assertEqual(observed["by"], "parent" if alive else ("nested" if wrapper == "shell" else "release-install"))
                        self.assertEqual(path.exists(), alive)


class DesktopRecoveryTests(unittest.TestCase):
    identity = "Mon Nov 16 07:24:59 2026"

    def setUp(self):
        self.snapshot_patch = patch("guard.desktop_snapshot", side_effect=[dict(pid=42, identity=self.identity), None])
        self.snapshot_mock = self.snapshot_patch.start()
        self.addCleanup(self.snapshot_patch.stop)
        self.health_patch = patch("guard.backend_ready", return_value=False)
        self.health_patch.start()
        self.addCleanup(self.health_patch.stop)

    def test_only_registered_desktop_with_same_birth_time_is_signalled(self):
        for replaced in [False, True]:
            with self.subTest(replaced=replaced):
                self.snapshot_mock.side_effect = [dict(pid=42, identity=self.identity), None]
                identities = [self.identity, "Tue Nov 17 07:24:59 2026" if replaced else self.identity, None]
                with patch("quit_reason.desktop_pid", return_value=42), \
                        patch("guard.desktop_identity", side_effect=identities), \
                        patch("guard.time.time", return_value=time.mktime(time.strptime(self.identity, "%a %b %d %H:%M:%S %Y")) + 200), \
                        patch("guard.subprocess.Popen", return_value=Mock(wait=Mock(return_value=0))), \
                        patch("guard.os.kill") as kill:
                    self.assertEqual(guard.stop_unready_desktop(Path("/fake"), dict(pid=42, identity=self.identity)), not replaced)
                    self.assertEqual(kill.call_args_list, [] if replaced else [unittest.mock.call(42, signal.SIGTERM)])

    def test_young_desktop_is_given_startup_grace(self):
        started = time.mktime(time.strptime(self.identity, "%a %b %d %H:%M:%S %Y"))
        with patch("quit_reason.desktop_pid", return_value=42), patch("guard.desktop_identity", return_value=self.identity), \
                patch("guard.time.time", return_value=started + 179), patch("guard.os.kill") as kill:
            self.assertFalse(guard.stop_unready_desktop(Path("/fake"), dict(pid=42, identity=self.identity)))
            kill.assert_not_called()

    def test_unavailable_provenance_cannot_block_desktop_recovery(self):
        started = time.mktime(time.strptime(self.identity, "%a %b %d %H:%M:%S %Y"))
        for failure in ["timeout", "nonzero-exit", "spawn-failed"]:
            with self.subTest(failure=failure):
                self.snapshot_mock.side_effect = [dict(pid=42, identity=self.identity), None]
                child = Mock(wait=Mock(return_value=1 if failure == "nonzero-exit" else 0))
                if failure == "timeout":
                    child.wait.side_effect = subprocess.TimeoutExpired("reason", 3)
                with patch("quit_reason.desktop_pid", return_value=42), \
                        patch("guard.desktop_identity", side_effect=[self.identity, self.identity, None]), \
                        patch("guard.time.time", return_value=started + 200), \
                        patch("guard.subprocess.Popen", return_value=child,
                              side_effect=OSError("unavailable") if failure == "spawn-failed" else None), \
                        patch("guard.append_log") as logged, patch("guard.os.kill") as kill:
                    self.assertTrue(guard.stop_unready_desktop(Path("/fake"), dict(pid=42, identity=self.identity)))
                    kill.assert_called_once_with(42, signal.SIGTERM)
                    self.assertIn(failure, logged.call_args.args[2][0])
                    if failure == "timeout":
                        child.terminate.assert_called_once_with()

    def test_stuck_desktop_escalation_is_bounded(self):
        started = time.mktime(time.strptime(self.identity, "%a %b %d %H:%M:%S %Y"))
        with patch("quit_reason.desktop_pid", return_value=42), patch("guard.desktop_identity", return_value=self.identity), \
                patch("guard.time.time", return_value=started + 200), \
                patch("guard.time.monotonic", side_effect=[0, 3, 3, 5]), \
                patch("guard.subprocess.Popen", return_value=Mock(wait=Mock(return_value=0))), \
                patch("guard.os.kill") as kill:
            with self.assertRaises(subprocess.TimeoutExpired):
                guard.stop_unready_desktop(Path("/fake"), dict(pid=42, identity=self.identity))
            self.assertEqual(kill.call_args_list, [unittest.mock.call(42, signal.SIGTERM),
                                                  unittest.mock.call(42, signal.SIGKILL)])


if __name__ == "__main__":
    unittest.main()
