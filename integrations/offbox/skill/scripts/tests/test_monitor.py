"""Bounded monitor checks: synthetic pressure/processes, no live nudges or throttles."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import monitor
import monitor_sample as sample
import monitor_support as support


class MonitorTests(unittest.TestCase):
    def test_pressure_boundaries_and_sample_gap(self):
        prev = {}
        for now in range(1000, 1180, 10):
            prev = sample.pressure(prev, now, 25, "used = 0M", "System-wide memory free percentage: 50%")
            self.assertFalse(prev["active"])
        state = sample.pressure(prev, 1180, 25, "used = 0M", "free percentage: 50%")
        self.assertTrue(state["active"])
        self.assertFalse(sample.pressure(state, 1300, 25, "used = 0M", "free percentage: 50%")["active"])
        self.assertFalse(sample.pressure({}, 1000, 24, "used = 6144M", "free percentage: 25%")["active"])
        # Static high swap is not pressure (macOS never reclaims it).
        self.assertFalse(sample.pressure({}, 1000, 0, "used = 12000M", "free percentage: 50%")["active"])
        grow = sample.pressure({}, 1000, 0, "used = 10000M", "free percentage: 50%")
        grow = sample.pressure(grow, 1010, 0, "used = 10500M", "free percentage: 50%")
        self.assertFalse(grow["active"])
        grow = sample.pressure(grow, 1020, 0, "used = 11100M", "free percentage: 50%")
        self.assertTrue(grow["active"])
        # Growth older than 10 minutes falls out of the window.
        stale = {"sampled": 1590, "swap_hist": [[900, 9.0], [1590, 11.0]]}
        self.assertFalse(sample.pressure(stale, 1600, 0, "used = 11264M", "free percentage: 50%")["active"])
        self.assertTrue(sample.pressure({}, 1000, 0, "used = 0M", "free percentage: 24%")["active"])

    def test_process_attribution_and_no_command_env_spoof(self):
        plain = ("10001 1 1.0 2048 go test ./...\n"
                 "10002 10001 40.0 1024 /tmp/test-binary\n"
                 "10003 1 0.0 100 zsh -c 'echo OPENCODE_SESSION_ID=ses_wrong'\n")
        raw = ("10001 1 1.0 2048 go test ./... PWD=/repo OPENCODE_SESSION_ID=ses_real\n"
               "10002 10001 40.0 1024 /tmp/test-binary\n"
               "10003 1 0.0 100 zsh -c 'echo OPENCODE_SESSION_ID=ses_wrong' PWD=/repo\n")
        groups, _, total = sample.sample_processes({}, 1000, raw, plain)
        self.assertEqual(total, 3)
        self.assertEqual(set(groups), {"ses_real"})
        self.assertEqual(groups["ses_real"]["pids"], [10001, 10002])
        self.assertEqual(groups["ses_real"]["rss"], 3072)
        self.assertEqual(groups["ses_real"]["cpu"], 41)

    def test_high_cpu_requires_continuity(self):
        plain = "10001 1 51.0 2048 python crunch.py\n"
        raw = plain.rstrip() + " OPENCODE_SESSION_ID=ses_cpu PWD=/repo\n"
        previous = {}
        for now in range(1000, 1060, 10):
            groups, previous, _ = sample.sample_processes(previous, now, raw, plain)
            self.assertFalse(groups)
        groups, previous, _ = sample.sample_processes(previous, 1060, raw, plain)
        self.assertIn("ses_cpu", groups)
        groups, _, _ = sample.sample_processes(previous, 1100, raw, plain)
        self.assertFalse(groups)

    def test_offbox_tree_is_never_local_heavy(self):
        for command in ("/Users/ardud/.local/bin/offbox run --fresh --size small -- go test ./...",
                        "python3 /skills/scripts/offbox.py run -- docker compose up",
                        "python3 /skills/scripts/offbox_lib/worker.py"):
            plain = (f"10001 1 80.0 2000000 {command}\n"
                     "10002 10001 90.0 2000000 rsync -az /repo remote:/repo\n"
                     "10003 10002 90.0 2000000 ssh remote go test ./...\n")
            raw = plain.replace("\n", " OPENCODE_SESSION_ID=ses_remote PWD=/repo\n")
            previous = {}
            for now in range(1000, 1100, 10):
                groups, previous, _ = sample.sample_processes(previous, now, raw, plain)
                self.assertEqual(groups, {})

    def test_local_first_run_is_visible_even_under_offbox(self):
        # offbox.py -> sandbox-exec bash marked offbox-local -> go test child that cleared its env.
        plain = ("10001 1 1.0 2000000 python3 /skills/scripts/offbox.py run -- go test -run X ./pkg\n"
                 "10002 10001 1.0 2000000 bash -c go test -run X ./pkg offbox-local:run-1020-000000-abcd\n"
                 "10003 10002 90.0 2000000 /tmp/go-build1/pkg.test -test.run X\n")
        raw = ("10001 1 1.0 2000000 python3 /skills/scripts/offbox.py run -- go test -run X ./pkg"
               " OPENCODE_SESSION_ID=ses_local PWD=/repo\n"
               "10002 10001 1.0 2000000 bash -c go test -run X ./pkg offbox-local:run-1020-000000-abcd"
               " OPENCODE_SESSION_ID=ses_local PWD=/repo OFFBOX_LOCAL_RUN=run-1020-000000-abcd\n"
               "10003 10002 90.0 2000000 /tmp/go-build1/pkg.test -test.run X\n")
        previous, groups = {}, {}
        for now in range(1000, 1100, 10):
            groups, previous, _ = sample.sample_processes(previous, now, raw, plain)
        self.assertEqual(groups["ses_local"]["pids"], [10003])

    def test_exemptions_expiry_and_parent(self):
        with patch.object(support, "read_json", return_value=[
                {"session_id": "ses_parent", "expires_at": "2030-01-01T00:00:00Z"},
                {"session_id": "ses_expired", "expires_at": 900}]), \
                patch.object(support, "parent_session", return_value="ses_parent"):
            self.assertTrue(support.live_exemption("ses_child", 1000))
        with patch.object(support, "read_json", return_value=[
                {"session_id": "ses_expired", "expires_at": 900}]), \
                patch.object(support, "parent_session", return_value=None):
            self.assertFalse(support.live_exemption("ses_expired", 1000))

    def test_native_steering_and_second_nudge_parent_fyi(self):
        with patch.object(support, "thread_for", return_value={"threadId": "thread-child"}), \
                patch.object(support, "thread_send", return_value=False) as thread_send, \
                patch.object(support, "parent_session", side_effect=lambda s: "ses_parent" if s == "ses_child" else None), \
                patch.object(support, "oc", return_value=(200, {})) as oc:
            self.assertTrue(support.steer("ses_child", support.PREFIX + " test", "stable-id"))
            self.assertEqual([c.args[1] for c in oc.call_args_list], ["ses_child"])
            thread_send.assert_not_called()
            self.assertTrue(support.steer("ses_child", support.PREFIX + " second", "second-id", include_parent=True))
            self.assertEqual([c.args[1] for c in oc.call_args_list], ["ses_child", "ses_child", "ses_parent"])
            self.assertIn("FYI", oc.call_args_list[-1].args[3]["text"])
            self.assertTrue(all(c.args[3]["delivery"] == "steer" for c in oc.call_args_list))

    def test_native_relationship_without_parent_and_top_level_fallback(self):
        with patch.object(support, "thread_for", return_value={"threadId": "child", "relationshipToParent": "subagent"}), \
                patch.object(support, "parent_session", return_value=None), \
                patch.object(support, "thread_send", return_value=True) as send, \
                patch.object(support, "oc", return_value=(200, {})) as oc:
            self.assertTrue(support.steer("ses_child", support.PREFIX, "request"))
            send.assert_not_called()
            oc.assert_called_once()
        with patch.object(support, "thread_for", return_value={"threadId": "top"}), \
                patch.object(support, "parent_session", return_value=None), \
                patch.object(support, "thread_send", return_value=True) as send, \
                patch.object(support, "oc", return_value=(200, {})) as oc:
            self.assertTrue(support.steer("ses_top", support.PREFIX, "request"))
            send.assert_called_once()
            oc.assert_not_called()
            send.return_value = False
            self.assertTrue(support.steer("ses_top", support.PREFIX, "request2"))
            oc.assert_called_once()

    def test_ladder_timing_dedupe_and_exemption(self):
        con = monitor.connect(":memory:")
        group = {"cpu": 100, "rss": 2048, "pids": [10001], "keys": ["fake"]}
        state = {"active": True, "load1": 25, "swap_gb": 7, "free_pct": 20}
        with patch.object(monitor, "live_exemption", return_value=False) as exempt, \
                patch.object(monitor, "steer", return_value=True) as steer, \
                patch.object(monitor, "throttle", return_value=1) as throttle, \
                patch.object(monitor, "telegram", return_value=True) as telegram, \
                patch.object(monitor, "log"):
            for now in range(1000, 1970, 10):
                monitor.ladder(con, {"ses_heavy": dict(group)}, state, now)
            self.assertEqual(steer.call_count, 2)
            self.assertEqual(throttle.call_count, 1)
            self.assertEqual(telegram.call_count, 1)
            self.assertTrue(all(c.args[1].startswith(support.PREFIX) for c in steer.call_args_list))
            self.assertEqual([c.kwargs["include_parent"] for c in steer.call_args_list], [False, True])
            monitor.ladder(con, {}, state, 1980)
            monitor.ladder(con, {"ses_heavy": dict(group)}, state, 1990)
            self.assertEqual(steer.call_count, 2)
            for now in range(2870, 2940, 10):
                monitor.ladder(con, {"ses_heavy": dict(group)}, state, now)
            self.assertEqual(steer.call_count, 3)
            exempt.return_value = True
            monitor.ladder(con, {"ses_heavy": dict(group)}, state, 2940)
            self.assertIsNone(monitor.get(con, "sessions", {})["ses_heavy"]["start"])
        con.close()

    def test_dry_run_has_no_effects(self):
        con = monitor.connect(":memory:")
        group = {"cpu": 100, "rss": 2048, "pids": [10001], "keys": ["fake"]}
        with patch.object(monitor, "live_exemption", return_value=False), \
                patch.object(monitor, "steer") as steer, \
                patch.object(monitor, "throttle") as throttle, \
                patch.object(monitor, "telegram") as telegram:
            for now in range(1000, 1070, 10):
                actions = monitor.ladder(con, {"ses_heavy": group}, {"active": True}, now, True)
            self.assertEqual(actions[0]["action"], "steer")
            steer.assert_not_called()
            throttle.assert_not_called()
            telegram.assert_not_called()
        con.close()

    def test_resource_floor_sustains_and_resets(self):
        for cpu, rss in ((1.6, 34000), (50, 34000), (0, 1572864)):
            con = monitor.connect(":memory:")
            group = {"cpu": cpu, "rss": rss, "pids": [10001], "keys": ["fake"]}
            with patch.object(monitor, "live_exemption", return_value=False), \
                    patch.object(monitor, "steer", return_value=True) as steer, \
                    patch.object(monitor, "log"):
                state = {"active": True, "load1": 25, "swap_gb": 7, "free_pct": 20}
                for now in range(1000, 1060, 10):
                    monitor.ladder(con, {"ses_floor": dict(group)}, state, now)
                steer.assert_not_called()
                monitor.ladder(con, {"ses_floor": dict(group)}, state, 1060)
                self.assertEqual(steer.call_count, int(cpu >= 50 or rss >= 1572864))
                monitor.ladder(con, {"ses_floor": dict(group, cpu=0, rss=0)}, state, 1070)
                self.assertIsNone(monitor.get(con, "sessions", {})["ses_floor"]["start"])
            con.close()

    def test_shim_exemption_passthrough_and_expiry(self):
        import os
        import subprocess
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake = root / "docker"
            fake.write_text("#!/bin/zsh\nprint -r -- fake-real-docker \"$@\"\n")
            fake.chmod(0o755)
            shim = Path(monitor.__file__).parent / "blockers/docker"
            env = dict(os.environ, PATH=str(shim.parent) + ":" + str(root) + ":/usr/bin:/bin",
                       OPENCODE_SESSION_ID="ses_test", OFFBOX_STATE_DIR=directory, OFFBOX_GATE_MODE="enforce")
            for expiry, expected in (("2030-01-01T00:00:00Z", 0), ("2000-01-01T00:00:00Z", 3)):
                (root / "exemptions.json").write_text(json.dumps([{"session_id": "ses_test", "expires_at": expiry}]))
                result = subprocess.run([str(shim), "run", "image"], env=env, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, expected)
            env.pop("OPENCODE_SESSION_ID")
            result = subprocess.run([str(shim), "run", "image"], env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0)
            self.assertIn("fake-real-docker", result.stdout)

    def test_control_credential_prefers_own_file_and_refuses_loose_ones(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home / ".robob/components").mkdir(parents=True)
            shared = home / ".robob/ardud-control.json"
            own = home / ".robob/components/offbox.json"
            for path, token in ((shared, "shared"), (own, "own")):
                path.write_text(json.dumps({"url": "http://127.0.0.1:1/", "token": token}))
                path.chmod(0o600)
            with patch.object(support, "HOME", home), \
                    patch.object(support, "request", return_value=(200, {})) as request:
                self.assertEqual(support.ctl("GET", "/health"), (200, {}))
                self.assertEqual(request.call_args.args[1:3],
                                 ("http://127.0.0.1:1/api/ardud/control/health", "Bearer own"))
                own.chmod(0o644)
                self.assertEqual(support.ctl("GET", "/health"), (0, {}))
                own.unlink()
                support.ctl("GET", "/health")
                self.assertEqual(request.call_args.args[2], "Bearer shared")


if __name__ == "__main__":
    unittest.main()
