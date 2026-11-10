"""Bounded monitor checks: synthetic pressure/processes, no live nudges or throttles."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import monitor
import monitor_sample as sample
import monitor_support as support


def _real_ctl(cfg_file, method, path, body=None):
    """support.ctl against a credential file the test wrote (the real HTTP path, no mocked responses)."""
    cfg = json.loads(Path(cfg_file).read_text())
    return support.request(method, cfg["url"].rstrip("/") + "/api/ardud/control" + path,
                           "Bearer " + cfg["token"], body)


def _sustained(*cmds):
    """Previous-sample state that makes each command a sustained (60 s over 50% CPU) process."""
    import hashlib
    return {str(pid) + ":" + hashlib.sha256(cmd.encode()).hexdigest()[:16]: {"since": 900, "last": 990}
            for pid, cmd in cmds}


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

    def test_stale_opencode_id_never_beats_a_concrete_native_id(self):
        # An inherited OPENCODE_SESSION_ID must not name a Claude process that carries its own UUID.
        uuid = "11111111-2222-3333-4444-555555555555"
        plain = f"10001 1 60.0 2048 claude -p work\n"
        raw = (f"10001 1 60.0 2048 claude -p work PWD=/repo OPENCODE_SESSION_ID=ses_stale "
               f"CLAUDE_CODE_SESSION_ID={uuid}\n")
        prev = _sustained((10001, "claude -p work"))
        groups, _, _ = sample.sample_processes(prev, 1000, raw, plain)
        self.assertEqual(set(groups), {"claudeAgent:" + uuid})
        self.assertEqual(groups["claudeAgent:" + uuid]["driver"], "claudeAgent")
        self.assertEqual(groups["claudeAgent:" + uuid]["session"], uuid)

    def test_same_uuid_under_two_drivers_is_two_groups_with_their_own_driver(self):
        # The same UUID in a Claude shell and a Codex shell is two executions: no merged group, no first-driver owner.
        uuid = "66666666-7777-8888-9999-aaaaaaaaaaaa"
        plain = "10001 1 60.0 2048 claude -p a\n10002 1 60.0 2048 codex exec b\n"
        raw = (f"10001 1 60.0 2048 claude -p a PWD=/repo CLAUDE_CODE_SESSION_ID={uuid}\n"
               f"10002 1 60.0 2048 codex exec b PWD=/repo CODEX_THREAD_ID={uuid}\n")
        prev = _sustained((10001, "claude -p a"), (10002, "codex exec b"))
        groups, _, _ = sample.sample_processes(prev, 1000, raw, plain)
        self.assertEqual(set(groups), {"claudeAgent:" + uuid, "codex:" + uuid})
        self.assertEqual(groups["claudeAgent:" + uuid]["pids"], [10001])
        self.assertEqual(groups["codex:" + uuid]["pids"], [10002])

    def test_app_launched_from_agent_shell_is_not_that_agents_work(self):
        # Robob reopened by an installer run from an agent thread: the app, its server and a
        # terminal it started all carry the thread's session id. A real agent shell
        # (opencode-service child) with the same id stays attributed.
        app = " XPC_SERVICE_NAME=application.com.ardud.robob.1.2 OPENCODE_SESSION_ID=ses_stale PWD=/repo"
        plain = ("20001 1 5.0 4096 /Applications/Robob.app/Contents/MacOS/Robob\n"
                 "20002 20001 95.0 2000000 /Applications/Robob.app/Contents/MacOS/Robob --require server.mjs\n"
                 "20003 20001 95.0 2000000 go test ./...\n"
                 "20004 1 0.0 100 /bin/zsh\n"
                 "20005 20004 95.0 2000000 go test ./...\n")
        raw = ("20001 1 5.0 4096 /Applications/Robob.app/Contents/MacOS/Robob" + app + "\n"
               "20002 20001 95.0 2000000 /Applications/Robob.app/Contents/MacOS/Robob --require server.mjs" + app + "\n"
               "20003 20001 95.0 2000000 go test ./..." + app + "\n"
               "20004 1 0.0 100 /bin/zsh XPC_SERVICE_NAME=com.ardud.opencode-service OPENCODE_SESSION_ID=ses_stale PWD=/repo\n"
               "20005 20004 95.0 2000000 go test ./...\n")
        previous, groups = {}, {}
        with patch.object(sample, "run", return_value="n/repo\n"):
            for now in range(1000, 1100, 10):
                groups, previous, _ = sample.sample_processes(previous, now, raw, plain)
        self.assertEqual(set(groups), {"ses_stale"})
        self.assertEqual(groups["ses_stale"]["pids"], [20005])
        # Without the agent's own shell, nothing is attributed at all.
        plain, raw = "".join(plain.splitlines(True)[:3]), "".join(raw.splitlines(True)[:3])
        previous = {}
        with patch.object(sample, "run", return_value="n/repo\n"):
            for now in range(1000, 1100, 10):
                groups, previous, _ = sample.sample_processes(previous, now, raw, plain)
        self.assertEqual(groups, {})

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

    def test_native_child_warning_goes_to_writable_ancestor_and_never_to_opencode(self):
        # A Claude child (no messages) under an app-managed parent: the warning lands on the parent over
        # the control API, and the OpenCode /prompt route is never called with the UUID.
        import test_identity as ti
        stub = ti.StubControl()
        self.addCleanup(stub.close)
        stub.threads["mid"] = {"threadId": "mid", "parentThreadId": ti.PARENT,
                               "relationshipToParent": "subagent", "creationSource": "mcp"}
        stub.threads["leaf"] = {"threadId": "leaf", "parentThreadId": "mid",
                                "relationshipToParent": "subagent", "creationSource": "provider"}
        stub.identities[(ti.CLAUDE_UUID, "claudeAgent")] = ti.resolved("leaf", "mid", kind="provider-native-child",
                                                                       accepts=False)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        cfg = Path(tmp.name) / "offbox.json"
        cfg.write_text(json.dumps({"url": stub.url, "token": "test-token"}))
        cfg.chmod(0o600)
        with patch.object(support, "HOME", Path(tmp.name)), \
                patch.object(support, "_CACHE", {}), \
                patch.object(support, "oc") as oc, \
                patch.object(support, "ctl", side_effect=lambda m, p, b=None: _real_ctl(cfg, m, p, b)):
            sent = []
            with patch.object(support, "thread_send", side_effect=lambda t, text, rid: sent.append(t) or True):
                delivered = support.steer(ti.CLAUDE_UUID, support.PREFIX + " warn", "rid-1", driver="claudeAgent")
        self.assertTrue(delivered)
        # The nearest writable ancestor is the app-managed "mid", not the root above it.
        self.assertEqual(sent, ["mid"])
        oc.assert_not_called()

    def test_writable_app_managed_manager_is_chosen_over_a_skipped_provider_child(self):
        # Leaf: a Claude provider-native child (no messages). Its manager is an app-managed child (creationSource
        # mcp, so it accepts messages). The walk must pick that manager, not skip it for a root.
        import test_identity as ti
        stub = ti.StubControl()
        self.addCleanup(stub.close)
        stub.threads["managed"] = {"threadId": "managed", "parentThreadId": ti.PARENT,
                                   "relationshipToParent": "subagent", "creationSource": "mcp"}
        stub.threads["leaf"] = {"threadId": "leaf", "parentThreadId": "managed",
                                "relationshipToParent": "subagent", "creationSource": "provider"}
        stub.identities[(ti.CLAUDE_UUID, "claudeAgent")] = ti.resolved("leaf", "managed",
                                                                       kind="provider-native-child", accepts=False)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        cfg = Path(tmp.name) / "offbox.json"
        cfg.write_text(json.dumps({"url": stub.url, "token": "test-token"}))
        cfg.chmod(0o600)
        with patch.object(support, "HOME", Path(tmp.name)), \
                patch.object(support, "_CACHE", {}), \
                patch.object(support, "oc") as oc, \
                patch.object(support, "ctl", side_effect=lambda m, p, b=None: _real_ctl(cfg, m, p, b)):
            sent = []
            with patch.object(support, "thread_send", side_effect=lambda t, text, rid: sent.append(t) or True):
                delivered = support.steer(ti.CLAUDE_UUID, support.PREFIX + " warn", "rid-m", driver="claudeAgent")
        self.assertTrue(delivered)
        self.assertEqual(sent, ["managed"])
        oc.assert_not_called()

    def test_lineage_cycle_ends_the_walk_without_a_hop_cap(self):
        # A cycle in the lineage must end the walk (no infinite loop) and deliver nowhere.
        import test_identity as ti
        stub = ti.StubControl()
        self.addCleanup(stub.close)
        stub.threads["a"] = {"threadId": "a", "parentThreadId": "b", "relationshipToParent": "subagent",
                             "creationSource": "provider"}
        stub.threads["b"] = {"threadId": "b", "parentThreadId": "a", "relationshipToParent": "subagent",
                             "creationSource": "provider"}
        stub.identities[(ti.CLAUDE_UUID, "claudeAgent")] = ti.resolved("a", "b", kind="provider-native-child",
                                                                       accepts=False)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        cfg = Path(tmp.name) / "offbox.json"
        cfg.write_text(json.dumps({"url": stub.url, "token": "test-token"}))
        cfg.chmod(0o600)
        with patch.object(support, "HOME", Path(tmp.name)), \
                patch.object(support, "_CACHE", {}), \
                patch.object(support, "oc") as oc, \
                patch.object(support, "ctl", side_effect=lambda m, p, b=None: _real_ctl(cfg, m, p, b)), \
                patch.object(support, "thread_send", return_value=True) as send:
            delivered = support.steer(ti.CLAUDE_UUID, support.PREFIX + " warn", "rid-c", driver="claudeAgent")
        self.assertFalse(delivered)
        send.assert_not_called()
        oc.assert_not_called()

    def test_native_child_without_a_writable_ancestor_is_not_delivered_to_opencode(self):
        import test_identity as ti
        stub = ti.StubControl()
        self.addCleanup(stub.close)
        stub.identities[(ti.CLAUDE_UUID, "claudeAgent")] = ti.resolved(
            "orphan", None, kind="provider-native-child", accepts=False)
        stub.threads["orphan"] = {"threadId": "orphan", "parentThreadId": None,
                                  "relationshipToParent": "subagent"}
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        cfg = Path(tmp.name) / "offbox.json"
        cfg.write_text(json.dumps({"url": stub.url, "token": "test-token"}))
        cfg.chmod(0o600)
        with patch.object(support, "HOME", Path(tmp.name)), \
                patch.object(support, "_CACHE", {}), \
                patch.object(support, "oc") as oc, \
                patch.object(support, "ctl", side_effect=lambda m, p, b=None: _real_ctl(cfg, m, p, b)), \
                patch.object(support, "thread_send", return_value=True) as send:
            delivered = support.steer(ti.CLAUDE_UUID, support.PREFIX + " warn", "rid-2", driver="claudeAgent")
        self.assertFalse(delivered)
        send.assert_not_called()
        oc.assert_not_called()

    def test_uuid_without_a_native_driver_is_never_sent_to_opencode(self):
        with patch.object(support, "oc") as oc, patch.object(support, "thread_send") as send:
            self.assertFalse(support.steer("11111111-2222-3333-4444-555555555555", support.PREFIX, "rid-3"))
        oc.assert_not_called()
        send.assert_not_called()

    def test_opencode_session_still_uses_the_prompt_route(self):
        with patch.object(support, "thread_for", return_value={"threadId": "t"}), \
                patch.object(support, "parent_session", return_value=None), \
                patch.object(support, "thread_send", return_value=False), \
                patch.object(support, "oc", return_value=(200, {})) as oc:
            self.assertTrue(support.steer("ses_top", support.PREFIX, "rid-4"))
        oc.assert_called_once()
        self.assertEqual(oc.call_args.args[1], "ses_top")

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
            # The shim only enforces when offbox is installed (~/.local/bin/offbox); give it a home that has one.
            (root / ".local/bin").mkdir(parents=True)
            (root / ".local/bin/offbox").write_text("#!/bin/sh\n")
            (root / ".local/bin/offbox").chmod(0o755)
            env = dict(os.environ, HOME=directory, PATH=str(shim.parent) + ":" + str(root) + ":/usr/bin:/bin",
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


class SamplerToLadderTests(unittest.TestCase):
    """The real sampler feeds the real ladder, and the real steer and resolve talk to a control stub over HTTP.

    The earlier ladder tests mock steer and live_exemption, so they could not see a native group sent to C1 under its
    driver-qualified key. These tests only pass when the bare native id and its driver reach the wire.
    """

    CLAUDE = "11111111-2222-3333-4444-555555555555"
    CODEX = "66666666-7777-8888-9999-aaaaaaaaaaaa"

    def setUp(self):
        import test_identity as ti
        self.ti = ti
        self.stub = ti.StubControl()
        self.addCleanup(self.stub.close)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        cfg = root / "offbox.json"
        cfg.write_text(json.dumps({"url": self.stub.url, "token": "test-token"}))
        cfg.chmod(0o600)
        # Both native drivers resolve to their own top-level thread, and each thread accepts messages.
        self.stub.threads["thread-claude"] = {"threadId": "thread-claude", "parentThreadId": None,
                                              "relationshipToParent": None}
        self.stub.threads["thread-codex"] = {"threadId": "thread-codex", "parentThreadId": None,
                                             "relationshipToParent": None}
        self.stub.identities[(self.CLAUDE, "claudeAgent")] = ti.resolved("thread-claude", None, driver="claudeAgent")
        self.stub.identities[(self.CODEX, "codex")] = ti.resolved("thread-codex", None, driver="codex")
        patches = [patch.object(support, "HOME", root), patch.object(support, "STATE", root),
                   patch.object(monitor, "STATE", root), patch.object(support, "_CACHE", {}),
                   patch.object(monitor, "throttle", return_value=1),
                   patch.object(monitor, "log"),
                   # The OpenCode parent lookup must never run for a native caller: it would fail the test.
                   patch.object(support, "oc", side_effect=AssertionError("OpenCode called for a native id"))]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.cfg_home = root
        # support.ctl reads ~/.robob/components/offbox.json, so give it that path under the temp HOME.
        (root / ".robob/components").mkdir(parents=True)
        (root / ".robob/components/offbox.json").write_text(cfg.read_text())
        (root / ".robob/components/offbox.json").chmod(0o600)

    def _tick_pair(self, con, *, start, drivers_and_pids, seconds=130):
        """Run the real sampler and ladder every ten seconds for `seconds`, the way tick() does.

        The sampler earns "sustained" over its first minute, and the ladder waits one more minute of resource floor
        before its first warning. So the window has to be longer than two minutes for the first steer to fire.
        Returns the groups from the last tick and every action the ladder produced, in order.
        """
        lines_plain, lines_env = [], []
        for pid, driver, uuid in drivers_and_pids:
            command = "claude -p work" if driver == "claudeAgent" else "codex exec work"
            lines_plain.append(f"{pid} 1 60.0 2048 {command}")
            env = (f"PWD=/repo CLAUDE_CODE_SESSION_ID={uuid}" if driver == "claudeAgent"
                   else f"PWD=/repo CODEX_THREAD_ID={uuid}")
            lines_env.append(f"{pid} 1 60.0 2048 {command} {env}")
        plain = "\n".join(lines_plain) + "\n"
        raw = "\n".join(lines_env) + "\n"
        prev = {}
        all_actions = []
        groups = {}
        for now in range(start, start + seconds, 10):
            # The sampler is handed the previous tick's CPU progress, as tick() does, so sustained is earned per tick.
            groups, progress, _ = sample.sample_processes(prev, now, raw, plain)
            prev = progress
            pressure = {"active": True, "load1": 25, "swap_gb": 7, "free_pct": 20}
            all_actions.extend(monitor.ladder(con, groups, pressure, now))
        return groups, all_actions

    def test_claude_and_codex_each_reach_their_own_thread_under_the_bare_uuid(self):
        con = monitor.connect(":memory:")
        groups, actions = self._tick_pair(con, start=1000, drivers_and_pids=[
            (10001, "claudeAgent", self.CLAUDE), (10002, "codex", self.CODEX)])
        self.assertEqual(set(groups), {"claudeAgent:" + self.CLAUDE, "codex:" + self.CODEX})
        # C1 is asked for the bare native id under its own driver, never the composite key.
        identity_queries = [q for _, p, q in self.stub.calls if p == "/api/ardud/control/identity/resolve"]
        self.assertTrue(identity_queries, self.stub.calls)
        for query in identity_queries:
            self.assertNotIn("claudeAgent%3A", query)
            self.assertNotIn("codex%3A", query)
        self.assertIn(("thread-claude", ), [(t,) for t, _ in self.stub.sends])
        self.assertIn(("thread-codex", ), [(t,) for t, _ in self.stub.sends])
        claude_send = next(body for t, body in self.stub.sends if t == "thread-claude")
        self.assertIn("Local heavy work", claude_send["text"])
        self.assertIn("Session " + self.CLAUDE, claude_send["text"])
        con.close()

    def test_a_native_exemption_for_one_driver_does_not_silence_the_other_driver(self):
        # A Codex exemption on the shared UUID covers the Codex group only. The Claude group still gets its warning.
        con = monitor.connect(":memory:")
        exemptions = Path(self.cfg_home) / "exemptions.json"
        exemptions.write_text(json.dumps([{"session_id": self.CODEX, "driver": "codex",
                                           "expires_at": 9999999999}]))
        with patch.object(support, "STATE", self.cfg_home), patch.object(monitor, "STATE", self.cfg_home):
            _, actions = self._tick_pair(con, start=1000, drivers_and_pids=[
                (10001, "claudeAgent", self.CODEX), (10002, "codex", self.CODEX)])
        by_session = {a["session"]: a["action"] for a in actions}
        self.assertEqual(by_session.get("codex:" + self.CODEX), "exempt")
        self.assertEqual(by_session.get("claudeAgent:" + self.CODEX), "steer")
        con.close()

    def test_a_valid_native_exemption_short_circuits_steering_with_no_send(self):
        con = monitor.connect(":memory:")
        exemptions = Path(self.cfg_home) / "exemptions.json"
        exemptions.write_text(json.dumps([{"session_id": self.CLAUDE, "driver": "claudeAgent",
                                           "expires_at": 9999999999}]))
        with patch.object(support, "STATE", self.cfg_home), patch.object(monitor, "STATE", self.cfg_home):
            _, actions = self._tick_pair(con, start=1000, drivers_and_pids=[(10001, "claudeAgent", self.CLAUDE)])
        self.assertEqual([a["action"] for a in actions], ["exempt"])
        self.assertEqual(self.stub.sends, [], "an exempt native session must not receive a warning")
        con.close()

    def test_the_exemption_writer_records_the_driver_the_monitor_matches_on(self):
        # The real `offbox local` writer: it must store the caller's driver with the bare session id, so the monitor
        # can match that exemption under the same driver and no other.
        import offbox_lib.common as common
        from offbox_lib import misc
        exemptions = Path(self.cfg_home) / "exemptions.json"
        me = {"session": self.CODEX, "thread": None, "driver": "codex", "repo_root": str(self.cfg_home)}
        patches = [patch.object(common, "EXEMPTIONS", exemptions), patch.object(common, "STATE", self.cfg_home),
                   patch.object(common, "LOCKS_DIR", self.cfg_home / "locks"),
                   patch.object(common, "DB_PATH", self.cfg_home / "offbox.db"),
                   patch.object(misc, "EXEMPTIONS", exemptions)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        (self.cfg_home / "locks").mkdir(exist_ok=True)
        misc.local_exempt(me, "a reason long enough to pass", "2h", False, False)
        written = json.loads(exemptions.read_text())
        self.assertEqual(len(written), 1)
        self.assertEqual(written[0]["session_id"], self.CODEX)
        self.assertEqual(written[0]["driver"], "codex")
        with patch.object(support, "STATE", self.cfg_home):
            self.assertTrue(support.live_exemption(self.CODEX, driver="codex"))
            self.assertFalse(support.live_exemption(self.CODEX, driver="claudeAgent"))

    def write_claude_entries(self, *entries):
        exemptions = Path(self.cfg_home) / "exemptions.json"
        exemptions.write_text(json.dumps([dict(session_id=self.CLAUDE, driver="claudeAgent", expires_at=9999999999,
                                               **e) for e in entries]))

    def test_a_claude_child_exemption_does_not_exempt_the_whole_session(self):
        # One in-process child logged an exemption. The session it shares with its parent is still warned.
        self.write_claude_entries({"thread_id": "thread-child", "execution_kind": "provider-native-child"})
        con = monitor.connect(":memory:")
        _, actions = self._tick_pair(con, start=1000, drivers_and_pids=[(10001, "claudeAgent", self.CLAUDE)])
        self.assertEqual([a["action"] for a in actions], ["steer"])
        con.close()
        self.assertFalse(support.live_exemption(self.CLAUDE, driver="claudeAgent"))
        self.assertFalse(support.live_exemption(self.CLAUDE, driver="claudeAgent", thread="thread-sibling"))
        self.assertTrue(support.live_exemption(self.CLAUDE, driver="claudeAgent", thread="thread-child"))

    def test_a_claude_parent_exemption_still_covers_its_session(self):
        self.write_claude_entries({"thread_id": "thread-claude", "execution_kind": "top-level"})
        self.assertTrue(support.live_exemption(self.CLAUDE, driver="claudeAgent"))

    def test_older_claude_entries_without_a_kind_are_read_by_their_thread(self):
        # Written before the kind was recorded. The session's own thread (C1's answer for the bare id) keeps its
        # session-wide meaning; any other thread is a child's and covers that child only.
        self.write_claude_entries({"thread_id": "thread-child"})
        self.assertFalse(support.live_exemption(self.CLAUDE, driver="claudeAgent"))
        self.assertTrue(support.live_exemption(self.CLAUDE, driver="claudeAgent", thread="thread-child"))
        self.write_claude_entries({"thread_id": "thread-claude"})
        self.assertTrue(support.live_exemption(self.CLAUDE, driver="claudeAgent"))
        # No thread at all: an exemption from before Claude callers resolved, still session-wide.
        self.write_claude_entries({"thread_id": None})
        self.assertTrue(support.live_exemption(self.CLAUDE, driver="claudeAgent"))

    def test_older_claude_child_entry_is_not_session_wide_during_a_control_outage(self):
        self.write_claude_entries({"thread_id": "thread-claude"})
        with patch.object(support, "ctl", return_value=(0, {})):
            self.assertFalse(support.live_exemption(self.CLAUDE, driver="claudeAgent"))

    def test_a_codex_exemption_with_a_thread_keeps_its_session_match(self):
        exemptions = Path(self.cfg_home) / "exemptions.json"
        exemptions.write_text(json.dumps([{"session_id": self.CODEX, "driver": "codex", "thread_id": "thread-codex",
                                           "execution_kind": "provider-native-child", "expires_at": 9999999999}]))
        self.assertTrue(support.live_exemption(self.CODEX, driver="codex"))

    def test_an_exemption_recorded_without_a_driver_is_read_as_opencode_only(self):
        # Entries written before native drivers have no driver field. They must not silence a native process.
        con = monitor.connect(":memory:")
        exemptions = Path(self.cfg_home) / "exemptions.json"
        exemptions.write_text(json.dumps([{"session_id": self.CLAUDE, "expires_at": 9999999999}]))
        with patch.object(support, "STATE", self.cfg_home), patch.object(monitor, "STATE", self.cfg_home):
            _, actions = self._tick_pair(con, start=1000, drivers_and_pids=[(10001, "claudeAgent", self.CLAUDE)])
        self.assertEqual([a["action"] for a in actions], ["steer"])
        con.close()


if __name__ == "__main__":
    unittest.main()
