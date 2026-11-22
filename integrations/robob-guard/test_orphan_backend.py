"""Orphan ownership and recovery simulations; no host processes are queried."""
import datetime
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import guard
notify = guard.notify


class OrphanTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.state_path = self.home / ".local/state/robob-guard/state.json"
        self.runtime_path = self.home / ".robob/userdata/server-runtime.json"
        self.child_log = self.home / ".robob/userdata/logs/server-child.log"
        self.desktop = dict(pid=42, identity="birth", startedAt=9000)
        self.registration = {42}
        self.parent = 42
        self.args = guard.EXECUTABLE + " --require compileCache.cjs /app/" + guard.BACKEND_ENTRY
        self.alive = True
        self.listening = True
        self.runtime = dict(pid=43, port=3773, startedAt="1970-01-01T02:30:00Z")
        guard.atomic_json(self.runtime_path, self.runtime)
        for name, options in [
            ("guard.protected_tier_tick", {}),
            ("guard.subprocess.run", dict(side_effect=self.process_run)),
            ("quit_reason.registered_desktop_pids", dict(side_effect=lambda: self.registration.copy())),
            ("guard.desktop_snapshot", dict(side_effect=lambda: self.desktop)),
            ("guard.backend_ready", dict(return_value=False)),
            ("guard.boot_epoch", dict(return_value=0)),
            ("guard.notify", dict(return_value=False)),
            ("guard.reopen", {}),
            ("guard.stop_unready_desktop", dict(side_effect=self.stop)),
            ("guard.os.kill", dict(side_effect=AssertionError("unexpected process signal"))),
        ]:
            patcher = patch(name, **options)
            mocked = patcher.start()
            self.addCleanup(patcher.stop)
            setattr(self, name.rsplit(".", 1)[1] + "_mock", mocked)

    def process_run(self, command, **kwargs):
        if command == ["/bin/ps", "-p", "43", "-o", "pid=,ppid=,args="]:
            return subprocess.CompletedProcess(command, 0 if self.alive else 1,
                                               stdout="43 %s %s" % (self.parent, self.args) if self.alive else "")
        if command == ["/bin/ps", "-p", "42", "-o", "comm="]:
            return subprocess.CompletedProcess(command, 0, stdout=guard.EXECUTABLE)
        if command == ["/bin/ps", "-axo", "pid=,ppid=,comm=,args="]:
            output = "42 1 /Applications/Ro %s\n43 %s /Applications/Ro %s\n" % (
                guard.EXECUTABLE, self.parent, self.args)
            output += "\n".join("%s 42 /Applications/Ro %s -e worker" % (n, guard.EXECUTABLE)
                                for n in range(44, 52))
            output += "\n99 1 /bin/echo /bin/echo " + guard.EXECUTABLE
            return subprocess.CompletedProcess(command, 0, stdout=output)
        if command == ["/usr/sbin/lsof", "-nP", "-a", "-iTCP@127.0.0.1:3773", "-sTCP:LISTEN", "-t"]:
            self.assertEqual(kwargs["timeout"], 2)
            return subprocess.CompletedProcess(command, 0 if self.listening else 1,
                                               stdout="43\n" if self.listening else "")
        self.fail("unexpected external command: %s" % command)

    def stop(self, home, desktop):
        self.desktop, self.registration, self.parent = None, set(), 1
        return True

    def tick(self, now):
        with patch("guard.time.time", return_value=now):
            guard.check(self.home)
        return guard.read_state(self.state_path)

    def log(self):
        return (self.state_path.parent / "guard.log").read_text()

    def replacement_due(self):
        state = guard.initial_state()
        state.update(down_count=8, unready_since=9700, unready_last=9970,
                     unready_ticks=8, unready_desktop="42:birth")
        guard.atomic_json(self.state_path, state)

    def conflict_line(self, at):
        stamp = datetime.datetime.fromtimestamp(at, datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        return json.dumps(dict(timestamp=stamp, annotations=dict(
            component="desktop-backend-child", text="ServerAlreadyRunningError: already owns userdata"))) + "\n"

    def test_truncated_comm_diagnostics_roles_bound_and_null_desktop(self):
        detail = json.loads(guard.process_diagnostics().split("=", 1)[1])
        self.assertEqual(detail["lsappinfo_pid"], 42)
        self.assertIs(detail["lsappinfo_alive"], True)
        self.assertEqual(len(detail["robob_processes"]), 5)
        self.assertEqual([p["role"] for p in detail["robob_processes"]],
                         ["desktop", "backend", "other", "other", "other"])
        self.registration = set()
        detail = json.loads(guard.process_diagnostics().split("=", 1)[1])
        self.assertIsNone(detail["lsappinfo_pid"])
        self.assertIsNone(detail["lsappinfo_alive"])

    def test_runtime_process_corpus(self):
        rows = [
            (42, {42}, True, self.args, False),
            (1, {42}, True, self.args, True),
            (99, {42}, True, self.args, True),
            (42, set(), True, self.args, True),
            (1, set(), False, self.args, False),
            (1, set(), True, "/bin/echo " + self.args, False),
            (1, set(), True, guard.EXECUTABLE + "Extra " + guard.BACKEND_ENTRY, False),
            (1, set(), True, guard.EXECUTABLE + " -e worker", False),
        ]
        for parent, registration, alive, args, expected in rows:
            with self.subTest(parent=parent, registration=registration, alive=alive, args=args):
                self.parent, self.registration, self.alive, self.args = parent, registration, alive, args
                errors = []
                orphan = guard.orphan_backend(self.home, errors)
                self.assertEqual(orphan is not None, expected)
                self.assertEqual(errors, [])
                if expected:
                    self.assertEqual(orphan, dict(self.runtime, ppid=parent, listening=True))

    def test_stop_leaves_orphan_blocks_open_alerts_once_then_retries_without_cooldown(self):
        self.replacement_due()
        state = self.tick(10000)
        self.stop_unready_desktop_mock.assert_called_once()
        self.reopen_mock.assert_not_called()
        self.assertEqual(state["last_replace"], 10000)
        self.assertTrue(state["orphan_blocked"])
        key = "robob-guard:10000:orphan-backend"
        self.assertEqual(list(state["pending_alerts"]), [key])
        self.assertEqual(state["pending_alerts"][key]["kind"], "orphan-backend")
        self.notify_mock.return_value = True
        for now in [10030, 10060, 10090, 10120]:
            state = self.tick(now)
        self.assertEqual(self.notify_mock.call_count, 2)  # One failed send, then delivery.
        self.assertIn(key, state["alerts_sent"])
        self.assertIn("replace-blocked:orphan-backend pid=43 action=backoff", self.log())
        self.assertIn('orphan_backend={"pid":43,"ppid":1,"port":3773', self.log())
        self.reopen_mock.assert_not_called()
        self.alive = False
        state = self.tick(10150)
        self.reopen_mock.assert_called_once_with(self.home)
        self.assertLess(10150 - 10000, guard.REPLACE_COOLDOWN)
        self.assertFalse(state["orphan_blocked"])
        self.assertIn("orphan-backend-cleared action=reopen", self.log())
        self.kill_mock.assert_not_called()

    def test_orphan_on_next_tick_after_open_is_blocked(self):
        self.desktop, self.registration, self.alive = None, set(), False
        self.tick(10000)
        self.tick(10030)
        self.reopen_mock.assert_called_once()
        self.alive, self.parent = True, 1
        state = self.tick(10060)
        self.assertTrue(state["orphan_blocked"])
        self.assertEqual(len(state["pending_alerts"]), 1)
        self.tick(10090)
        self.reopen_mock.assert_called_once()

    def test_owned_backend_is_never_orphan_and_keeps_normal_replace_window(self):
        for now in [10000, 10030, 10060]:
            state = self.tick(now)
        self.assertFalse(state["orphan_blocked"])
        self.assertEqual(state["pending_alerts"], {})
        self.reopen_mock.assert_not_called()
        self.assertNotIn("replace-blocked", self.log())
        self.assertIn("orphan_backend=null", self.log())

    def test_conflict_newer_than_replace_or_reopen_fails_once_older_is_ignored(self):
        self.desktop, self.registration, self.alive = None, set(), False
        for attempt_key in ["last_replace", "last_reopen"]:
            for offset, expected in [(-1, False), (0, False), (1, True)]:
                with self.subTest(attempt=attempt_key, offset=offset):
                    state = guard.initial_state()
                    state.update(last_reopen=10000, awaiting_reopen=True, down_count=4)
                    state[attempt_key] = 10000
                    guard.atomic_json(self.state_path, state)
                    self.child_log.parent.mkdir(parents=True, exist_ok=True)
                    self.child_log.write_text("x" * 70000 + "\n" + self.conflict_line(10000 + offset))
                    state = self.tick(10030)
                    self.assertEqual(state["orphan_blocked"], expected)
                    self.assertEqual(len(state["pending_alerts"]), int(expected))
                    if expected:
                        self.reopen_mock.reset_mock()
                        state = self.tick(10060)
                        self.reopen_mock.assert_called_once()
                        self.assertFalse(state["orphan_blocked"])

    def test_unknown_observation_does_not_release_blocked_attempt(self):
        self.replacement_due()
        self.tick(10000)
        self.runtime_path.write_text("broken runtime JSON")
        state = self.tick(10030)
        self.assertTrue(state["orphan_blocked"])
        self.reopen_mock.assert_not_called()
        self.assertIn("orphan_backend_error=JSONDecodeError", self.log())
        self.assertIn("orphan-backend-unverified action=backoff", self.log())

    def test_runtime_owner_changed_releases_block_and_replaces_desktop(self):
        self.replacement_due()
        self.tick(10000)
        self.desktop, self.registration = dict(pid=42, identity="birth", startedAt=10010), {42}
        self.args = guard.EXECUTABLE + " -e worker"
        self.tick(10030)
        self.assertEqual(self.stop_unready_desktop_mock.call_count, 2)
        self.reopen_mock.assert_called_once()

    def test_ready_clears_orphan_pending_alert_and_episode(self):
        self.replacement_due()
        self.tick(10000)
        self.backend_ready_mock.return_value = True
        state = self.tick(10030)
        self.assertIsNone(state["orphan_episode"])
        self.assertFalse(state["orphan_blocked"])
        self.assertEqual(state["pending_alerts"], {})
        self.assertIn("up action=none backend-ready orphan_backend=null", self.log())

    def test_recovered_conflict_is_not_replayed_on_later_outage(self):
        state = guard.initial_state()
        state.update(last_replace=10000, last_reopen=10000)
        guard.atomic_json(self.state_path, state)
        self.child_log.parent.mkdir(parents=True, exist_ok=True)
        self.child_log.write_text(self.conflict_line(10001))
        self.desktop, self.registration, self.alive = None, set(), False
        self.tick(10030)
        self.backend_ready_mock.return_value = True
        state = self.tick(10060)
        self.assertEqual(state["ownership_conflict_at"], 10060)
        self.backend_ready_mock.return_value = False
        self.desktop, self.registration = dict(pid=42, identity="birth", startedAt=9000), {42}
        for now in [10090, 10120]:
            state = self.tick(now)
        self.assertFalse(state["orphan_blocked"])
        self.assertEqual(state["pending_alerts"], {})
        self.stop_unready_desktop_mock.assert_not_called()
        self.reopen_mock.assert_not_called()

    def test_ready_clears_orphan_even_during_install_hold(self):
        self.replacement_due()
        self.tick(10000)
        self.backend_ready_mock.return_value = True
        guard.atomic_json(self.home / ".robob/install-hold.json",
                          dict(by="install", pid=99, startedAt=10030, beatAt=10030))
        self.notify_mock.reset_mock()
        with patch("guard.pid_alive", return_value=True):
            state = self.tick(10030)
        self.assertIsNone(state["orphan_episode"])
        self.assertFalse(state["orphan_blocked"])
        self.assertEqual(state["pending_alerts"], {})
        self.notify_mock.assert_not_called()
        self.assertIn("hold:install action=none", self.log())

    def test_repeated_ownership_read_errors_alert_then_clear_on_valid_observation(self):
        rows = [
            ("malformed-json", "not JSON"),
            ("invalid-shape", "[]"),
            ("missing-fields", "{}"),
            ("oversize", "x" * 65537),
            ("permission", PermissionError("fixture")),
            ("timeout", TimeoutError("fixture")),
        ]
        for label, error in rows:
            with self.subTest(label=label):
                guard.atomic_json(self.state_path, guard.initial_state())
                self.notify_mock.reset_mock()
                for now in range(10000, 10211, 30):
                    if isinstance(error, Exception):
                        with patch("guard.bounded_read", side_effect=error):
                            state = self.tick(now)
                    else:
                        self.runtime_path.write_text(error)
                        state = self.tick(now)
                self.assertEqual(state["check_error_count"], 8)
                self.assertEqual(len(state["pending_alerts"]), 1)
                self.assertEqual(next(iter(state["pending_alerts"].values()))["kind"], "check-error")
                self.reopen_mock.assert_not_called()
                self.stop_unready_desktop_mock.assert_not_called()
                guard.atomic_json(self.runtime_path, self.runtime)
                state = self.tick(10240)
                self.assertEqual(state["check_error_count"], 0)

    def test_delivered_check_error_alert_does_not_requeue_without_reopen_history(self):
        self.runtime_path.write_text("bad JSON")
        self.notify_mock.return_value = True
        for now in range(10000, 10301, 30):
            state = self.tick(now)
        self.notify_mock.assert_called_once()
        self.assertEqual(state["alerts_sent"], ["robob-guard:10000:check-error"])
        self.assertEqual(state["pending_alerts"], {})
        self.assertEqual(state["history"], [])

    def test_runtime_disappearance_keeps_known_orphan_until_process_exits(self):
        for delivered in [False, True]:
            with self.subTest(delivered=delivered):
                guard.atomic_json(self.runtime_path, self.runtime)
                self.desktop, self.registration, self.parent, self.alive = None, set(), 1, True
                guard.atomic_json(self.state_path, guard.initial_state())
                self.notify_mock.return_value = delivered
                state = self.tick(10000)
                self.assertEqual(state["orphan_owner"]["pid"], 43)
                self.runtime_path.unlink()
                self.reopen_mock.reset_mock()
                for now in [10030, 10060, 10090]:
                    state = self.tick(now)
                    self.assertTrue(state["orphan_blocked"])
                    self.assertEqual(state["orphan_owner"]["pid"], 43)
                self.reopen_mock.assert_not_called()
                self.alive = False
                state = self.tick(10120)
                self.reopen_mock.assert_called_once()
                self.assertFalse(state["orphan_blocked"])
                self.assertIsNone(state["orphan_owner"])

    def test_missing_runtime_without_known_owner_allows_ordinary_reopen(self):
        self.runtime_path.unlink()
        self.desktop, self.registration = None, set()
        self.tick(10000)
        state = self.tick(10030)
        self.reopen_mock.assert_called_once()
        self.assertFalse(state["orphan_blocked"])

    def test_log_tail_boundary_corpus_preserves_complete_conflict_rows(self):
        self.child_log.parent.mkdir(parents=True, exist_ok=True)
        complete = self.conflict_line(10001).encode("utf-8")
        for char in ["a", "é", "€", "🛠"]:
            encoded = char.encode("utf-8")
            for cut in range(len(encoded)):
                with self.subTest(char=char, cut=cut):
                    suffix = encoded + b"x" * (65536 + cut - len(encoded) - 1 - len(complete))
                    data = b"header " + suffix + b"\n" + complete
                    self.child_log.write_bytes(data)
                    errors = []
                    self.assertEqual(guard.ownership_conflict(self.home, 10000, errors), dict(at=10001))
                    self.assertEqual(errors, [])
        self.child_log.write_text(self.conflict_line(10001))
        self.assertEqual(guard.ownership_conflict(self.home, 10000), dict(at=10001))

    def test_check_error_row_has_orphan_and_is_one_line(self):
        self.parent, self.registration = 1, set()
        self.desktop_snapshot_mock.side_effect = ValueError("bad\nobservation")
        self.tick(10000)
        self.assertEqual(len(self.log().splitlines()), 1)
        self.assertIn("check-error:ValueError", self.log())
        self.assertIn('orphan_backend={"pid":43', self.log())

    def test_check_error_persists_confirmed_ownership_and_alert_before_runtime_disappears(self):
        rows = [(step, signal, delivered) for step in ["backend_ready", "desktop_snapshot"]
                for signal in ["orphan", "conflict", "older-conflict"] for delivered in [False, True]]
        for step, observation, delivered in rows:
            with self.subTest(step=step, observation=observation, delivered=delivered):
                self.desktop, self.registration, self.parent = None, set(), 1
                self.alive = observation == "orphan"
                guard.atomic_json(self.runtime_path, self.runtime)
                state = guard.initial_state()
                state.update(last_replace=10000, last_reopen=10000, awaiting_reopen=True)
                guard.atomic_json(self.state_path, state)
                self.child_log.parent.mkdir(parents=True, exist_ok=True)
                self.child_log.write_text(self.conflict_line(9999 if observation == "older-conflict" else 10001)
                                          if observation != "orphan" else "")
                self.notify_mock.reset_mock()
                self.notify_mock.return_value = delivered
                self.reopen_mock.reset_mock()
                with patch("guard." + step, side_effect=subprocess.TimeoutExpired(step, 10)):
                    state = self.tick(10030)
                self.assertEqual(state["check_error_count"], 1)
                self.assertEqual(state["orphan_blocked"], observation != "older-conflict")
                key = "robob-guard:10030:orphan-backend"
                if observation == "older-conflict":
                    self.notify_mock.assert_not_called()
                    self.assertIsNone(state["orphan_owner"])
                    continue
                self.notify_mock.assert_called_once()
                if delivered:
                    self.assertIn(key, state["alerts_sent"])
                else:
                    self.assertEqual(state["pending_alerts"][key]["kind"], "orphan-backend")
                self.assertIn("check-error:TimeoutExpired replace-blocked:orphan-backend", self.log())
                self.reopen_mock.assert_not_called()
                self.stop_unready_desktop_mock.assert_not_called()
                if observation == "orphan":
                    self.assertEqual(state["orphan_owner"], dict(self.runtime, ppid=1, listening=True))
                    self.runtime_path.unlink()
                    state = self.tick(10060)
                    self.assertTrue(state["orphan_blocked"])
                    self.reopen_mock.assert_not_called()
                    self.assertEqual(self.notify_mock.call_count, 1 if delivered else 2)
                    self.alive = False
                    state = self.tick(10090)
                else:
                    self.assertIsNone(state["orphan_owner"])
                    self.assertEqual(state["ownership_conflict_at"], 10001)
                    state = self.tick(10060)
                self.reopen_mock.assert_called_once()
                self.assertFalse(state["orphan_blocked"])
                self.kill_mock.assert_not_called()

    def test_notify_orphan_text_and_key(self):
        alert = dict(kind="orphan-backend", at=10000, backend=dict(self.runtime, ppid=1, listening=True))
        with patch("guard.subprocess.run", return_value=subprocess.CompletedProcess([], 0)) as run:
            self.assertTrue(notify(self.home, "episode-key", alert))
        command = run.call_args.args[0]
        text = command[command.index("--text") + 1]
        self.assertIn("pid=43 age=1000s holds :3773", text)
        self.assertIn("can't start until the old backend is gone", text)
        self.assertEqual(command[-1], "episode-key")

    def test_backend_hook_never_signals(self):
        self.assertEqual(guard.recover_orphan_backend(self.home, self.runtime), "not allowed")
        self.kill_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
