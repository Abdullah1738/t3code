if __package__:
    from . import test_environment
else:
    import test_environment

import datetime
import hashlib
import hmac
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib.parse import parse_qs, unquote, urlsplit

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))
import engine

class State:
    def __init__(self):
        self.calls = []
        self.fail = False
        self.identities = {}
        self.threads = {}
        self.delays = []

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        state = self.server.state
        parsed = urlsplit(self.path)
        state.calls.append(self.path)
        if state.delays:
            threading.Event().wait(state.delays.pop(0))
        if state.fail:
            self.send_error(503)
            return
        if parsed.path.endswith("/identity/resolve"):
            query = parse_qs(parsed.query)
            key = (query.get("nativeId", [""])[0], query.get("agentId", [None])[0])
            identity = state.identities.get(key, {"resolution": "unavailable"})
            body = {"ok": True, "identity": identity}
        elif "/threads/" in parsed.path:
            key = unquote(parsed.path.split("/threads/", 1)[1])
            body = {"ok": True, "thread": state.threads.get(key)}
        else:
            self.send_error(404)
            return
        raw = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *_args):
        pass

class EngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.state = State()
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.state = cls.state
        cls.worker = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.worker.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.worker.join()
        cls.server.server_close()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state.calls.clear()
        self.state.fail = False
        self.state.identities.clear()
        self.state.threads.clear()
        self.state.delays.clear()
        self.classifier = self.root / "classifier.py"
        self.classifier.write_text('''import json,sys\nx=json.loads(sys.stdin.readline())\nc=x["cmd"]\nif "npm ci" in c or "docker run" in c:\n print(json.dumps({"heavy":True,"rule":"pkg-install","why":"installation","rewrite":"offbox run -- "+c}))\nelse:\n print(json.dumps({"heavy":False}))\n''')
        self.offbox = self.root / "offbox"
        self.offbox.touch()
        env = {
            "HARNESS_HOOKS_STATE_DIR": str(self.root / "hook-state"),
            "HARNESS_HOOKS_CONTROL_URL": f"http://127.0.0.1:{self.server.server_port}",
            "HARNESS_HOOKS_TOKEN_FILE": str(self.root / "unused-credential.json"),
            "HARNESS_HOOKS_CLASSIFIER": str(self.classifier),
            "HARNESS_HOOKS_OFFBOX_BIN": str(self.offbox),
            "OFFBOX_STATE_DIR": str(self.root / "offbox-state"),
            "OFFBOX_TOOL_LOG_DIR": str(self.root / "shared-logs"),
            "OFFBOX_GATE_MODE": "enforce",
            engine.COMMAND_IDENTITY_ENV: "",
            "AGENT_GUARD_APPROVED": "",
        }
        self.env = patch.dict(os.environ, env)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.offbox_state = Path(env["OFFBOX_STATE_DIR"])
        self.offbox_state.mkdir()
        self.add_identity("root", "parent", model="claude-opus-5-5")
        self.add_identity("session", "child", parent="parent", agent="agent-child")
        self.add_identity("session", "sibling", parent="parent", agent="agent-sibling")
        self.state.threads["parent"] = {"threadId": "parent", "parentThreadId": None, "nativeSessionId": "root"}

    def add_identity(self, native, thread, parent=None, agent=None, model="claude-haiku-5-5"):
        self.state.identities[(native, agent)] = {"resolution": "resolved", "robobThreadId": thread,
            "parentThreadId": parent, "rootThreadId": parent or thread,
            "nativeSessionId": native, "nativeAgentId": agent, "model": {"model": model},
            **({"driver": "claudeAgent", "providerInstanceId": "claudeAgent", "parentNativeAgentId": None,
                "nativeOwnerThreadId": parent} if agent else {})}

    def event(self, command, session="session", agent="agent-child", **extra):
        event = {"hook_event_name": "PreToolUse", "tool_name": "Bash", "session_id": session,
                 "cwd": str(self.root), "tool_input": {"command": command}}
        if agent:
            event["agent_id"] = agent
        event.update(extra)
        return event

    def run_adapter(self, harness, event, **env):
        child_env = {k: v for k, v in os.environ.items() if k not in ("BASH_ENV", "ENV")}
        child_env.update(env)
        run = subprocess.run([sys.executable, str(SRC / (harness + ".py"))], input=json.dumps(event),
                             text=True, capture_output=True, env=child_env, timeout=5, check=True)
        self.assertEqual(run.stderr, "")
        return json.loads(run.stdout) if run.stdout else None

    def test_haiku_mutations_need_no_policy_database(self):
        self.add_identity("codex-child", "child", parent="parent")
        config = self.root / ".config/opencode/agent-guard.json"
        config.parent.mkdir(parents=True)
        config.write_text('{"mode":"enforce"}')
        for harness in ("claude", "codex"):
            for tool, field in (("Bash", "command"), ("mcp__test__exec_command", "cmd")):
                for command in ("terraform apply -auto-approve", "aws ecs run-task --cluster fixture"):
                    with self.subTest(harness=harness, tool=tool, command=command), \
                         patch.object(engine, "HOME", self.root), \
                         patch("sqlite3.connect", side_effect=AssertionError("unexpected database lookup")) as connect, \
                         patch.object(engine, "_read_json", wraps=engine._read_json) as read:
                        event = self.event(command, tool_name=tool, tool_input={field: command})
                        if harness == "codex":
                            event.update(session_id="codex-child")
                            event.pop("agent_id", None)
                        result = engine.decide(event, harness)
                        self.assertEqual(result["decision"], "allow")
                        self.assertEqual(result["context"]["rule"], "no-policy")
                        connect.assert_not_called()
                        self.assertNotIn(str(config), [str(c.args[0]) for c in read.call_args_list])
                        self.assertFalse(any("/.local/share/coord" in str(c.args[0]) for c in read.call_args_list))
                        self.assertFalse(any("/threads/" in path for path in self.state.calls))

    def test_heavy_denied_with_exact_rewrite_and_narrow_allowed(self):
        result = engine.decide(self.event("npm ci"), "claude")
        self.assertEqual(result["decision"], "deny")
        self.assertIn("Why: installation [rule pkg-install].", result["reason"])
        self.assertIn("offbox run -- npm ci", result["reason"])
        self.assertEqual(engine.decide(self.event("pytest tests/a.py::test_one"), "claude")["decision"], "allow")
        with patch.dict(os.environ, {"OFFBOX_GATE_MODE": "observe"}):
            self.assertEqual(engine.decide(self.event("npm ci"), "claude")["decision"], "allow")

    def test_parent_exemption_does_not_grant_sibling(self):
        entry = {"session_id": "shared", "thread_id": "sibling", "expires_at": time.time() + 120}
        (self.offbox_state / "exemptions.json").write_text(json.dumps([entry]))
        self.assertEqual(engine.decide(self.event("npm ci"), "claude")["decision"], "deny")
        entry["thread_id"] = "parent"
        (self.offbox_state / "exemptions.json").write_text(json.dumps([entry]))
        self.assertEqual(engine.decide(self.event("npm ci"), "claude")["decision"], "allow")
        entry["expires_at"] = time.time() - 1
        (self.offbox_state / "exemptions.json").write_text(json.dumps([entry]))
        self.assertEqual(engine.decide(self.event("npm ci"), "claude")["decision"], "deny")

    def test_parent_native_session_exemption_is_ancestor_not_sibling(self):
        (self.offbox_state / "exemptions.json").write_text(json.dumps([{"session_id": "session", "expires_at": time.time() + 60}]))
        self.assertEqual(engine.decide(self.event("npm ci"), "claude")["decision"], "deny")
        (self.offbox_state / "exemptions.json").write_text(json.dumps([{"session_id": "root", "expires_at": time.time() + 60}]))
        self.assertEqual(engine.decide(self.event("npm ci"), "claude")["decision"], "allow")

    def test_shared_claude_session_is_not_child_exemption_even_if_registry_omits_agent(self):
        del self.state.identities[("session", "agent-child")]["nativeAgentId"]
        (self.offbox_state / "exemptions.json").write_text(json.dumps([{"session_id": "session", "expires_at": time.time() + 60}]))
        self.assertEqual(engine.decide(self.event("npm ci"), "claude")["decision"], "deny")

    def test_betterstack_scope_and_apply_patch(self):
        base = "/Users/ardud/crpko-devops"
        for cwd, expected in [(base, "allow"), (base + "/src", "allow"), (base + "-lane", "allow"),
                              (base + "s", "deny"), (str(self.root), "deny"), ("", "deny")]:
            with self.subTest(cwd=cwd):
                event = self.event("x", tool_name="mcp__betterstack__monitor", cwd=cwd)
                self.assertEqual(engine.decide(event, "claude")["decision"], expected)
        event = self.event("npm ci\npsql", tool_name="apply_patch")
        with patch.object(engine, "_classify_offbox") as offbox:
            self.assertEqual(engine.decide(event, "codex")["decision"], "allow")
            offbox.assert_not_called()

    def test_identity_cache_only_resolved_and_separates_children(self):
        one = self.event("echo x")
        two = self.event("echo x", agent="agent-sibling")
        self.assertEqual(engine.resolve_identity(one, "claude")["robobThreadId"], "child")
        self.assertEqual(engine.resolve_identity(two, "claude")["robobThreadId"], "sibling")
        count = len(self.state.calls)
        self.assertEqual(engine.resolve_identity(one, "claude")["robobThreadId"], "child")
        self.assertEqual(len(self.state.calls), count)
        unknown = self.event("echo x", agent="later")
        self.assertEqual(engine.resolve_identity(unknown, "claude")["resolution"], "unavailable")
        self.add_identity("session", "later-thread", parent="parent", agent="later")
        self.assertEqual(engine.resolve_identity(unknown, "claude")["robobThreadId"], "later-thread")
        for file in (self.root / "hook-state/identity").glob("*.json"):
            cached = json.loads(file.read_text())
            cached["at"] = time.time() - 1801
            file.write_text(json.dumps(cached))
        count = len(self.state.calls)
        engine.resolve_identity(one, "claude")
        self.assertGreater(len(self.state.calls), count)

    def test_fresh_identity_refreshes_cached_binding(self):
        event = self.event("echo x")
        engine.resolve_identity(event, "claude")
        self.state.identities[("session", "agent-child")]["model"] = {"model": "claude-opus-5-5"}
        engine.resolve_identity(event, "claude", fresh=True)
        cached = engine.resolve_identity(event, "claude")
        self.assertEqual(cached["model"]["model"], "claude-opus-5-5")

    def command_token(self, result, session="session"):
        command = result["context"].get("updatedInput", {}).get("command", "")
        # Read the token through the shell exactly as offbox does, including the
        # wrapper's per-command export and restoration of inherited context.
        env = {k: v for k, v in os.environ.items() if k not in ("BASH_ENV", "ENV")}
        env["CLAUDE_CODE_SESSION_ID"] = session
        run = subprocess.run(["/bin/bash", "-c", command], env=env, text=True, capture_output=True, check=True)
        return run.stdout.strip()

    def token_identity(self, result, session="session"):
        token = self.command_token(result, session)
        with patch.dict(os.environ, {engine.COMMAND_IDENTITY_ENV: token, "CLAUDE_CODE_SESSION_ID": session}):
            parsed = engine.command_identity_from_env()
            self.assertIsNotNone(parsed)
            self.assertEqual(parsed[0], "claude")
            return engine.resolve_identity(parsed[1], "claude")

    def identity_probe(self, **kwargs):
        return self.event('printf "%s" "$HARNESS_HOOKS_COMMAND_IDENTITY"', **kwargs)

    def age_identity_cache(self, age):
        for file in (self.root / "hook-state/identity").glob("*.json"):
            cached = json.loads(file.read_text())
            cached["at"] = time.time() - age
            file.write_text(json.dumps(cached))

    def test_claude_cached_command_is_signed_without_waiting_on_control(self):
        event = self.identity_probe()
        engine.decide(event, "claude")
        files = list((self.root / "hook-state/identity").glob("*.json"))
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].stat().st_mode & 0o777, 0o600)
        with patch.object(engine, "_get", side_effect=TimeoutError("stalled")) as get:
            result = engine.decide(event, "claude")
            self.assertEqual(self.token_identity(result)["robobThreadId"], "child")
            get.assert_not_called()
        row = json.loads((self.root / "hook-state/decisions.jsonl").read_text().splitlines()[-1])
        self.assertEqual(row["identity_source"], "cache")

    def test_claude_old_binding_survives_transport_outage_but_not_model_policy(self):
        event = self.identity_probe()
        engine.decide(event, "claude")
        self.age_identity_cache(3600)
        for error in (TimeoutError("stalled"), ConnectionRefusedError("offline"),
                      engine.urllib.error.URLError("offline"),
                      engine.urllib.error.HTTPError("http://test", 503, "unavailable", {}, None)):
            with self.subTest(error=type(error).__name__), patch.object(engine, "_get", side_effect=error):
                result = engine.decide(event, "claude")
                identity = self.token_identity(result)
                self.assertEqual(identity["robobThreadId"], "child")
                self.assertNotIn("model", identity)
        row = json.loads((self.root / "hook-state/decisions.jsonl").read_text().splitlines()[-1])
        self.assertEqual(row["identity_source"], "cache")

    def test_cached_hook_token_proves_offbox_child_owner_during_stall(self):
        # Offbox's command-identity lookup can also prepend a hooks source path.
        self.enterContext(patch.object(sys, "path", sys.path.copy()))
        sys.path.insert(0, str(SRC.parents[1] / "offbox/skill/scripts"))
        from offbox_lib import identity as offbox_identity
        engine.decide(self.identity_probe(), "claude")
        self.age_identity_cache(3600)
        with patch.object(engine, "_get", side_effect=TimeoutError("stalled")):
            token = self.command_token(engine.decide(self.identity_probe(), "claude"))
            env = {engine.COMMAND_IDENTITY_ENV: token, "HARNESS_HOOKS_SRC": str(SRC),
                   "CLAUDE_CODE_SESSION_ID": "session",
                   "CODEX_THREAD_ID": "", "CODEX_SESSION_ID": "", "OPENCODE_SESSION_ID": "", "OFFBOX_THREAD": ""}
            with patch.dict(os.environ, env), \
                 patch.object(offbox_identity, "identity_for", return_value={"resolution": "unavailable"}), \
                 patch.object(offbox_identity, "repo_root", return_value=self.root), \
                 patch.object(offbox_identity, "repo_key", return_value="repo"):
                me = offbox_identity.whoami(str(self.root))
                self.assertEqual(me["resolution"], "resolved")
                self.assertEqual(me["owner"], "child")
                self.assertTrue(me["proven"])
                offbox_identity.require_proven(me, "run")

    def test_native_child_never_uses_parent_or_sibling_cache(self):
        self.add_identity("session", "parent", model="claude-opus-5-5")
        engine.decide(self.identity_probe(agent=None), "claude")
        engine.decide(self.identity_probe(agent="agent-sibling"), "claude")
        with patch.object(engine, "_get", side_effect=TimeoutError("stalled")):
            result = engine.decide(self.identity_probe(), "claude")
            wrapped = result["context"].get("updatedInput", {}).get("command", "")
            self.assertNotIn(engine.COMMAND_IDENTITY_ENV + "=", wrapped)
        with patch.object(engine.time, "time", return_value=time.time() + engine._IDENTITY_UNAVAILABLE_TTL):
            engine.decide(self.identity_probe(), "claude")
        self.age_identity_cache(3600)
        with patch.object(engine, "_get", side_effect=TimeoutError("stalled")):
            self.assertEqual(self.token_identity(engine.decide(self.identity_probe(), "claude"))["robobThreadId"], "child")

    def test_authoritative_miss_invalidates_cache_including_next_call(self):
        for resolution in ("none", "pending", "ambiguous", "unavailable"):
            with self.subTest(resolution=resolution):
                engine.decide(self.identity_probe(), "claude")
                self.age_identity_cache(1801)
                with patch.object(engine, "_get", return_value={"identity": {"resolution": resolution}}):
                    result = engine.decide(self.identity_probe(), "claude")
                    self.assertNotIn(engine.COMMAND_IDENTITY_ENV + "=", result["context"].get("updatedInput", {}).get("command", ""))
                with patch.object(engine, "_get", side_effect=TimeoutError("stalled")):
                    self.assertEqual(engine.resolve_identity(self.identity_probe(), "claude")["resolution"], "unavailable")

    def test_claude_cache_expired_or_invalid_is_not_used(self):
        for age in (engine._IDENTITY_FALLBACK_TTL + 1, -60):
            with self.subTest(age=age):
                engine.decide(self.identity_probe(), "claude")
                self.age_identity_cache(age)
                with patch.object(engine, "_get", side_effect=TimeoutError("stalled")):
                    result = engine.decide(self.identity_probe(), "claude")
                    self.assertNotIn(engine.COMMAND_IDENTITY_ENV + "=", result["context"].get("updatedInput", {}).get("command", ""))

    def test_claude_bad_response_or_auth_error_does_not_use_old_cache(self):
        engine.decide(self.identity_probe(), "claude")
        self.age_identity_cache(1801)
        for error in (ValueError("bad response"), PermissionError("private credential"),
                      engine.urllib.error.HTTPError("http://test", 403, "forbidden", {}, None)):
            with self.subTest(error=type(error).__name__), patch.object(engine, "_get", side_effect=error):
                self.assertEqual(engine.resolve_identity(self.identity_probe(), "claude")["resolution"], "unavailable")

    def test_cached_binding_does_not_mint_token_for_denied_heavy_command(self):
        engine.decide(self.identity_probe(), "claude")
        result = engine.decide(self.event("npm ci"), "claude")
        self.assertEqual(result["decision"], "deny")
        self.assertNotIn("updatedInput", result["context"])

    def test_fresh_t3_delegated_claude_child_resolves_first_slow_command(self):
        # A T3 child has its own session, unlike a native child sharing one.
        self.add_identity("t3-delegated-session", "t3-delegated-child", parent="parent", model="claude-opus-5-5")
        self.state.delays = [1.35]
        output = self.run_adapter("claude", self.identity_probe(session="t3-delegated-session", agent=None))["hookSpecificOutput"]
        self.assertEqual(output["permissionDecision"], "allow")
        result = {"context": {"updatedInput": output["updatedInput"]}}
        identity = self.token_identity(result, session="t3-delegated-session")
        self.assertEqual(identity["robobThreadId"], "t3-delegated-child")
        self.assertIsNone(identity["nativeAgentId"])

    def test_claude_binding_expiring_during_lookup_is_not_used(self):
        engine.decide(self.identity_probe(), "claude")
        self.age_identity_cache(engine._IDENTITY_FALLBACK_TTL - 1)
        now = time.time()
        with patch.object(engine.time, "time", side_effect=[now, now + 5]), \
             patch.object(engine, "_lookup_identity", side_effect=TimeoutError("stalled")):
            self.assertEqual(engine.resolve_identity(self.identity_probe(), "claude")["resolution"], "unavailable")

    def test_claude_cache_separates_provider_instances_and_rejects_foreign_agent(self):
        engine.decide(self.identity_probe(), "claude")
        with patch.dict(os.environ, {"HARNESS_HOOKS_PROVIDER_INSTANCE": "another-claude"}), \
             patch.object(engine, "_get", side_effect=TimeoutError("stalled")):
            self.assertEqual(engine.resolve_identity(self.identity_probe(), "claude")["resolution"], "unavailable")
        for file in (self.root / "hook-state/identity").glob("*.json"):
            cached = json.loads(file.read_text())
            cached["identity"]["nativeAgentId"] = "agent-sibling"
            file.write_text(json.dumps(cached))
        with patch.object(engine, "_get", side_effect=TimeoutError("stalled")):
            self.assertEqual(engine.resolve_identity(self.identity_probe(), "claude")["resolution"], "unavailable")

    def test_claude_lookup_retries_transport_failure_with_shared_budget(self):
        clock = [100.0]
        deadlines = []
        def stalled(path, *, deadline, timeout):
            deadlines.append(deadline)
            self.assertEqual(timeout, 3)
            clock[0] = deadline
            raise TimeoutError("stalled")
        with patch.object(engine.time, "monotonic", side_effect=lambda: clock[0]), patch.object(engine, "_get", side_effect=stalled):
            self.assertEqual(engine.resolve_identity(self.identity_probe(), "claude")["resolution"], "unavailable")
        self.assertEqual(deadlines, [103.0, 104.5])
        identity = self.state.identities[("session", "agent-child")]
        with patch.object(engine.time, "time", return_value=time.time() + engine._IDENTITY_UNAVAILABLE_TTL), \
             patch.object(engine, "_get", side_effect=[ConnectionRefusedError("retry"), {"identity": identity}]) as get:
            result = engine.decide(self.identity_probe(), "claude")
            self.assertEqual(get.call_count, 2)
            self.assertEqual(self.token_identity(result)["robobThreadId"], "child")

    def test_binding_cache_avoids_control_for_30_minutes_without_stale_model(self):
        for harness in ("claude", "codex"):
            event = self.identity_probe()
            if harness == "codex":
                self.add_identity("agent-child", "codex-thread", model="gpt-6-astra")
            engine.resolve_identity(event, harness)
            self.age_identity_cache(1799)
            with patch.object(engine, "_get", side_effect=AssertionError("control called")):
                result = engine.resolve_identity(event, harness)
                self.assertEqual(result["resolution"], "resolved")
                self.assertNotIn("model", result)

    def test_codex_identity_has_longer_budget_without_changing_other_calls(self):
        with patch.object(engine, "_get", return_value={"identity": {"resolution": "unavailable"}}) as get:
            engine.resolve_identity(self.identity_probe(), "codex")
            self.assertEqual(get.call_args.kwargs["timeout"], 3.0)

    def test_codex_child_uses_agent_id_as_concrete_native(self):
        self.add_identity("codex-child", "child", parent="parent", model="gpt-6-astra")
        event = self.event("printf ok", session="codex-shared", agent="codex-child")
        result = engine.resolve_identity(event, "codex")
        self.assertEqual(result["robobThreadId"], "child")
        self.assertIn("nativeId=codex-child", self.state.calls[-1])
        self.assertNotIn("agentId", self.state.calls[-1])

    def test_codex_never_uses_stale_hook_thread_environment(self):
        self.add_identity("codex-env", "env-child", parent="parent", model="gpt-6-astra")
        self.add_identity("codex-agent", "agent-child", parent="parent", model="gpt-6-astra")
        self.add_identity("codex-shared", "root", model="gpt-6-astra")
        with patch.dict(os.environ, {"CODEX_THREAD_ID": "codex-env"}):
            event = self.event("echo", session="codex-shared", agent=None)
            self.assertEqual(engine.resolve_identity(event, "codex")["robobThreadId"], "root")
            event["agent_id"] = "codex-agent"
            self.assertEqual(engine.resolve_identity(event, "codex")["robobThreadId"], "agent-child")

    def test_deep_lineage_intermediate_exempt(self):
        self.add_identity("deep", "leaf", parent="middle", agent=None)
        self.state.threads["middle"] = {"threadId": "middle", "parentThreadId": "parent", "nativeSessionId": "middle-native"}
        event = self.event("npm ci", session="deep", agent=None)
        (self.offbox_state / "exemptions.json").write_text(json.dumps([{"thread_id": "middle", "expires_at": time.time() + 60}]))
        self.assertEqual(engine.decide(event, "claude")["decision"], "allow")
        self.assertTrue(any("/threads/middle" in path for path in self.state.calls))
        self.assertTrue(any("/threads/parent" in path for path in self.state.calls))

    def test_claude_three_native_levels_follow_proven_owners_for_exemptions(self):
        self.state.threads["parent"].update(parentThreadId=None, nativeSessionId="session")
        for thread in ("a", "b"):
            # Old Claude child shells all report the root as parent.
            self.state.threads[thread] = {"threadId": thread, "parentThreadId": "parent", "nativeSessionId": None}
        self.add_identity("session", "a", parent="parent", agent="agent-a")
        self.add_identity("session", "b", parent="a", agent="agent-b")
        self.add_identity("session", "leaf", parent="b", agent="agent-leaf")
        for agent, owner in (("agent-leaf", "agent-b"), ("agent-b", "agent-a"), ("agent-a", None)):
            self.state.identities[("session", agent)].update(
                driver="claudeAgent", providerInstanceId="claudeAgent", parentNativeAgentId=owner,
                nativeOwnerThreadId="parent")
        entry = {"thread_id": "a", "expires_at": time.time() + 60}
        (self.offbox_state / "exemptions.json").write_text(json.dumps([entry]))
        self.assertEqual(engine.decide(self.event("npm ci", agent="agent-leaf"), "claude")["decision"], "allow")
        entry["thread_id"] = "sibling"
        (self.offbox_state / "exemptions.json").write_text(json.dumps([entry]))
        self.assertEqual(engine.decide(self.event("npm ci", agent="agent-leaf"), "claude")["decision"], "deny")
        self.assertTrue(any("agentId=agent-b" in path for path in self.state.calls))
        self.assertTrue(any("agentId=agent-a" in path for path in self.state.calls))

    def test_native_chain_requires_the_proven_provider_owner_endpoint(self):
        self.add_identity("session", "leaf", parent=None, agent="agent-leaf")
        leaf = self.state.identities[("session", "agent-leaf")]
        leaf.update(parentNativeAgentId="agent-b", nativeOwnerThreadId="parent")
        with self.assertRaisesRegex(ValueError, "lineage-native-unresolved"):
            engine._lineage(leaf)

    def test_claude_parent_lookup_rejects_wrong_sibling_cycles_and_unresolved(self):
        self.add_identity("session", "leaf", parent="b", agent="agent-leaf")
        leaf = self.state.identities[("session", "agent-leaf")]
        leaf.update(parentNativeAgentId="agent-b", nativeOwnerThreadId="parent")
        self.add_identity("session", "b", parent="parent", agent="agent-b")
        owner = self.state.identities[("session", "agent-b")]
        for changed in ({"robobThreadId": "sibling"}, {"providerInstanceId": "other"},
                        {"resolution": "unavailable"}, {"nativeOwnerThreadId": "other"},
                        {"parentNativeAgentId": "agent-leaf"}):
            with self.subTest(changed=changed):
                old = dict(owner)
                owner.update(changed)
                if changed.get("parentNativeAgentId") == "agent-leaf":
                    owner["parentThreadId"] = "a"
                with self.assertRaises(ValueError):
                    engine._lineage(leaf)
                owner.clear()
                owner.update(old)

    def test_claude_native_owner_can_be_an_app_managed_child(self):
        self.add_identity("session", "leaf", parent="app-child", agent="agent-leaf")
        leaf = self.state.identities[("session", "agent-leaf")]
        leaf.update(parentNativeAgentId=None, nativeOwnerThreadId="app-child", rootThreadId="parent")
        self.state.threads["app-child"] = {"threadId": "app-child", "parentThreadId": "parent", "nativeSessionId": "session"}
        self.assertEqual([n["threadId"] for n in engine._lineage(leaf)], ["leaf", "app-child", "parent"])

    def test_lineage_depth_limit_never_trusts_partial_ancestry(self):
        self.add_identity("deep", "leaf", parent="n0", agent=None)
        for number in range(105):
            self.state.threads[f"n{number}"] = {"threadId": f"n{number}", "parentThreadId": f"n{number + 1}" if number < 104 else None}
        identity = self.state.identities[("deep", None)]
        with self.assertRaisesRegex(ValueError, "lineage-limit"):
            engine._lineage(identity)
        self.assertLessEqual(len(self.state.calls), 64)
        self.assertFalse(any("/threads/n104" in path for path in self.state.calls))

    def test_slow_lineage_has_a_total_budget_not_a_timeout_per_ancestor(self):
        identity = {"resolution": "resolved", "robobThreadId": "leaf", "parentThreadId": "n0"}
        clock = [100.0]
        timeouts = []

        def slow_get(path, *, deadline=None):
            timeout = min(1.2, deadline - clock[0]) if deadline is not None else 1.2
            timeouts.append(timeout)
            clock[0] += min(timeout, 0.4)
            if timeout < 0.4:
                raise TimeoutError("deadline")
            n = int(path.rsplit("n", 1)[1])
            if n >= 20:
                raise TimeoutError("test safety limit")
            return {"thread": {"threadId": f"n{n}", "parentThreadId": f"n{n+1}"}}

        with patch.object(engine.time, "monotonic", side_effect=lambda: clock[0]), patch.object(engine, "_get", side_effect=slow_get):
            with self.assertRaises((TimeoutError, ValueError)):
                engine._lineage(identity)
        self.assertLessEqual(clock[0] - 100.0, 1.6)
        self.assertLessEqual(len(timeouts), 5)

    def test_control_deadline_applies_to_a_slow_streaming_response(self):
        class SlowHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                try:
                    for byte in b'{"ok":true,"thread":null}':
                        self.wfile.write(bytes([byte]))
                        self.wfile.flush()
                        time.sleep(0.05)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), SlowHandler)
        server.daemon_threads = True
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            with patch.dict(os.environ, {"HARNESS_HOOKS_CONTROL_URL": f"http://127.0.0.1:{server.server_port}"}):
                start = time.monotonic()
                with self.assertRaises((TimeoutError, OSError, ValueError)):
                    engine._get("/threads/slow", deadline=start + 0.2)
                self.assertLess(time.monotonic() - start, 0.6)
        finally:
            server.shutdown()
            worker.join()
            server.server_close()

    def test_exemption_uses_a_complete_ancestry_walk(self):
        self.add_identity("deep", "leaf", parent="middle", agent=None)
        self.state.threads["middle"] = {"threadId": "middle", "parentThreadId": "parent"}
        (self.offbox_state / "exemptions.json").write_text(json.dumps([{"thread_id": "middle", "expires_at": time.time() + 60}]))
        event = self.event("npm ci", session="deep", agent=None)
        self.assertEqual(engine.decide(event, "claude")["decision"], "allow")
        paths = [p for p in self.state.calls if "/threads/" in p]
        self.assertEqual(len(paths), 2)

    def test_explicit_mcp_shell_schema_and_apply_patch_exclusion(self):
        event = self.event("ignored", tool_name="mcp__test_server__exec_command", tool_input={"cmd": "npm ci"})
        self.assertEqual(engine.decide(event, "claude")["decision"], "deny")
        event["tool_name"] = "mcp__test_server__apply_patch"
        self.assertEqual(engine.decide(event, "claude")["decision"], "allow")

    def test_shared_offbox_logs_for_native_harnesses_and_classifier_failure(self):
        for harness in ("claude", "codex"):
            engine.decide(self.event("echo private-message", session="root", agent=None), harness)
            engine.decide(self.event("npm ci", session="root", agent=None), harness)
            with patch.object(engine, "_classify_offbox", side_effect=ValueError("private-token")):
                engine.decide(self.event("echo private-message", session="root", agent=None), harness)
        text = "".join(p.read_text() for p in (self.root / "shared-logs").glob("*.ndjson"))
        rows = [json.loads(line) for line in text.splitlines()]
        self.assertEqual({r["props"]["harness"] for r in rows}, {"claudeAgent", "codex"})
        self.assertEqual({r["props"]["decision"] for r in rows}, {"allowed", "denied"})
        self.assertEqual({r["ok"] for r in rows}, {True, False})
        self.assertNotIn("private-message", text)
        self.assertNotIn("private-token", text)

    def test_native_and_mcp_shell_aliases_enforce_offbox(self):
        self.add_identity("codex-child", "child", parent="parent", model="claude-haiku-5-5")
        tools = ("Bash", "bash", "shell", "exec_command", "shell_command", "mcp__test__shell", "mcp__test__bash")
        for harness in ("claude", "codex"):
            for tool in tools:
                for field in ("command", "cmd"):
                    for command, reason in (("npm ci", "offbox gate:"),):
                        with self.subTest(harness=harness, tool=tool, field=field, command=command):
                            event = self.event(command, tool_name=tool, tool_input={field: command})
                            if harness == "codex":
                                event.update(session_id="codex-child")
                                event.pop("agent_id", None)
                            response = self.run_adapter(harness, event)["hookSpecificOutput"]
                            self.assertEqual(response["permissionDecision"], "deny")
                            self.assertIn(reason, response["permissionDecisionReason"])

    def test_mcp_rewrite_activates_raw_send_shims_without_native_env(self):
        offbox = self.offbox_fixture() / "scripts/blockers"
        self.add_identity("agent-child", "child", parent="parent", model="gpt-6-astra")
        real = self.root / "mcp-bin"
        real.mkdir()
        for name, arguments in (("wacli", "send text"), ("himalaya", "message send"),
                                ("himalaya-heal", "message send")):
            binary = real / name
            binary.write_text("#!/bin/sh\nprintf 'SHOULD_NOT_SEND\\n'\n")
            binary.chmod(0o755)
            for harness in ("claude", "codex"):
                for tool in ("exec_command", "shell_command"):
                    with self.subTest(name=name, harness=harness, tool=tool):
                        command = f"{name} {arguments}"
                        event = self.event(command, tool_name=f"mcp__test__{tool}", tool_input={"cmd": command})
                        response = self.run_adapter(harness, event)["hookSpecificOutput"]
                        env = self.shell_environment()
                        env["PATH"] = os.pathsep.join([str(offbox), str(real), "/usr/bin", "/bin"])
                        result = self.run_shell(response["updatedInput"]["cmd"], env)
                        self.assertEqual(result.returncode, 2, result.stderr)
                        self.assertEqual(result.stdout, "")
                        self.assertIn("Blocked:", result.stderr)

    def test_missing_intermediate_and_cycle_fail_open(self):
        self.add_identity("deep", "leaf", parent="middle", agent=None)
        (self.offbox_state / "exemptions.json").write_text(json.dumps([{"thread_id": "other", "expires_at": time.time() + 60}]))
        event = self.event("npm ci", session="deep", agent=None)
        self.assertEqual(engine.decide(event, "claude")["decision"], "allow")
        self.state.threads["middle"] = {"threadId": "middle", "parentThreadId": "middle"}
        self.assertEqual(engine.decide(self.event("psql", session="deep", agent=None), "claude")["decision"], "allow")

    def test_component_credential_auth_and_base_prefix(self):
        self.add_identity("cred", "cred-thread", model="claude-haiku-5-5")
        token_file = self.root / "credential.json"
        token_file.write_text(json.dumps({"url": f"http://127.0.0.1:{self.server.server_port}", "token": "synthetic-token"}))
        token_file.chmod(0o600)
        with patch.dict(os.environ, {"HARNESS_HOOKS_TOKEN_FILE": str(token_file), "HARNESS_HOOKS_CONTROL_URL": ""}):
            self.assertEqual(engine.resolve_identity(self.event("echo", session="cred", agent=None), "claude")["robobThreadId"], "cred-thread")
            self.assertTrue(self.state.calls[-1].startswith("/api/ardud/control/identity/resolve?"))

    def test_outages_fail_open_and_log_each_event_with_hash_and_no_command(self):
        self.state.fail = True
        (self.offbox_state / "exemptions.json").write_text(json.dumps([{"thread_id": "some-thread", "expires_at": time.time() + 60}]))
        result = engine.decide(self.event("npm ci private-argument"), "claude")
        self.assertEqual(result["decision"], "allow")
        self.classifier.write_text("import sys; sys.exit(4)\n")
        self.assertEqual(engine.decide(self.event("npm ci private-argument"), "claude")["decision"], "allow")
        records = (self.root / "hook-state/decisions.jsonl").read_text().splitlines()
        self.assertEqual(len(records), 2)
        for line in records:
            record = json.loads(line)
            self.assertIsNone(record["cmd"])
            self.assertEqual(record["cmd_hmac_sha256"], hmac.new(engine._command_identity_key(), b"npm ci private-argument", hashlib.sha256).hexdigest())
            self.assertEqual(record["decision"], "allow")
            self.assertIsNotNone(record["error"])
            self.assertGreaterEqual(record["ms"], 0)

    def test_classifier_timeout_fails_open(self):
        self.classifier.write_text("import sys,time\nsys.stdin.readline()\ntime.sleep(5)\n")
        start = time.monotonic()
        verdict = engine.decide(self.event("psql"), "claude")
        elapsed = time.monotonic() - start
        self.assertEqual(verdict["decision"], "allow")
        self.assertGreaterEqual(elapsed, 3)
        self.assertLess(elapsed, 4.9)
        line = json.loads((self.root / "hook-state/decisions.jsonl").read_text())
        self.assertEqual(line["error"], "TimeoutExpired")

    def test_log_never_includes_secret_even_as_first_word_or_metadata(self):
        secret = "sk-test-0123456789abcdef0123456789abcdef"
        command = secret + " --credential " + secret
        engine.decide(self.event(command), "claude")
        path = self.root / "hook-state/decisions.jsonl"
        self.assertNotIn(secret, path.read_text())
        line = json.loads(path.read_text())
        self.assertIsNone(line["cmd"])
        self.assertEqual(line["cmd_hmac_sha256"], hmac.new(engine._command_identity_key(), command.encode(), hashlib.sha256).hexdigest())
        self.assertEqual(line["robobThreadId_sha256"], hashlib.sha256(b"child").hexdigest())
        self.assertEqual(line["event"], "PreToolUse")
        self.assertEqual(line["harness"], "claude")
        self.state.identities[("session", "agent-child")]["robobThreadId"] = secret
        event = self.event(command, tool_name=secret, hook_event_name=secret)
        engine.decide(event, "claude")
        self.assertNotIn(secret, path.read_text())

    def test_log_keeps_native_docker_failure_metadata_without_arguments(self):
        engine._log(harness="claude", event="shim", tool="docker", decision="allow",
                    rule="native-check-unavailable", error="ValueError")
        line = json.loads((self.root / "hook-state/decisions.jsonl").read_text())
        self.assertEqual(line["tool"], "docker")
        self.assertEqual(line["rule"], "native-check-unavailable")
        self.assertEqual(line["error"], "ValueError")

    def test_heavy_identity_outage_denies_with_cached_identity_and_no_exemption(self):
        event = self.event("npm ci")
        self.assertEqual(engine.resolve_identity(event, "claude")["resolution"], "resolved")
        self.state.fail = True
        self.assertEqual(engine.decide(event, "claude")["decision"], "deny")
        records = (self.root / "hook-state/decisions.jsonl").read_text().splitlines()
        self.assertEqual(len(records), 1)
        self.assertEqual(json.loads(records[0])["identity_source"], "cache")

    def test_betterstack_scope_is_literal_and_not_realpath(self):
        with patch.object(engine, "CRPKO_ROOTS", [str(self.root / "repo")]):
            repo, outside = self.root / "repo", self.root / "outside"
            repo.mkdir()
            outside.mkdir()
            (repo / "escape").symlink_to(outside, target_is_directory=True)
            (self.root / "alias").symlink_to(repo, target_is_directory=True)
            self.assertTrue(engine._betterstack_directory(str(repo / "escape")))
            self.assertFalse(engine._betterstack_directory(str(self.root / "alias")))

    def test_adapter_json_and_claude_session_exports(self):
        event = self.event("npm ci")
        output = self.run_adapter("claude", event)["hookSpecificOutput"]
        self.assertEqual(output["permissionDecision"], "deny")
        self.assertIn("offbox run -- npm ci", output["permissionDecisionReason"])
        self.add_identity("codex-child", "child", parent="parent", model="gpt-6-astra")
        codex = self.run_adapter("codex", self.event("npm ci", session="codex-child", agent=None))["hookSpecificOutput"]
        self.assertEqual(codex["permissionDecision"], "deny")
        for harness, allowed_event in (("codex", self.event("printf ok", session="codex-child", agent=None)),
                                       ("claude", self.event("printf ok"))):
            allowed = self.run_adapter(harness, allowed_event)["hookSpecificOutput"]
            self.assertEqual(allowed["permissionDecision"], "allow")
            self.assertIn(engine.COMMAND_IDENTITY_ENV + "=", allowed["updatedInput"]["command"])
        target = self.root / "claude-env"
        self.assertIsNone(self.run_adapter("claude", {"hook_event_name": "SessionStart"}, CLAUDE_ENV_FILE=str(target),
                                          HARNESS_HOOKS_OFFBOX_BLOCKERS=str(self.root / "offbox blockers")))
        text = target.read_text()
        self.assertIn("offbox blockers", text)
        self.assertIn("export OFFBOX_GATE=1", text)
        self.assertEqual(len(text.splitlines()), 3)
        self.assertNotIn("BUN_INSPECT", text)
        self.assertNotIn("AGENT_GUARD_APPROVED", text)
        self.assertNotIn("AGENT_GUARD_SESSION", text)

    def shell_environment(self, **values):
        bin_dir = self.root / "bin"
        bin_dir.mkdir(exist_ok=True)
        real_psql = bin_dir / "psql"
        real_psql.write_text("#!/bin/sh\nprintf 'real-psql\\n'\n")
        real_psql.chmod(0o755)
        env = dict(os.environ)
        # Agent shells export the repo-node pin; fake HOMEs make its startup noisy.
        for name in ("BASH_ENV", "ENV", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "ROBOB_HARNESS", "AGENT_GUARD_SESSION",
                     engine.COMMAND_IDENTITY_ENV):
            env.pop(name, None)
        env.update({"PATH": os.pathsep.join([str(bin_dir), "/usr/bin", "/bin"]),
                    "HARNESS_HOOKS_SRC": str(SRC), **values})
        return env

    def offbox_fixture(self):
        source = SRC.parents[1] / "offbox/skill"
        fixture = self.root / "offbox-skill"
        if not fixture.exists():
            shutil.copytree(source / "scripts/blockers", fixture / "scripts/blockers")
            shutil.copy2(source / "heavy-rules.json", fixture / "heavy-rules.json")
            for name in ("classify.py", "monitor_support.py"):
                shutil.copy2(source / "scripts" / name, fixture / "scripts" / name)
            for shim in (fixture / "scripts/blockers").iterdir():
                if shim.is_file():
                    shim.write_text(shim.read_text().replace("/opt/homebrew/bin/python3", shlex.quote(sys.executable)))
        return fixture

    def run_shell(self, command, env, shell="/bin/bash"):
        return subprocess.run([shell, "-c", command], cwd=self.root, env=env,
                              text=True, capture_output=True, timeout=10)

    def test_unavailable_policy_emits_no_rewrite_without_inherited_context(self):
        self.state.fail = True
        event = self.event("printf ok")
        self.assertIsNone(self.run_adapter("claude", event))
        self.assertIsNone(self.run_adapter("codex", event))

    def test_rewrite_preserves_shell_state_and_does_not_leak_to_siblings(self):
        self.add_identity("session", "parent", model="claude-opus-5-5")
        env = self.shell_environment(CLAUDE_CODE_SESSION_ID="session", ROBOB_HARNESS="claude")
        child = self.root / "dir with space"
        child.mkdir()
        command = """cd 'dir with space'; set -- 'a b' c; export SAMPLE='x y'; printf '%s|%s|%s\\n' "$1" "$SAMPLE" "$PWD"; cat <<'END'
quoted $HOME
END
printf done | cat"""
        response = self.run_adapter("claude", self.event(command, tool_input={"command": command, "timeout": 123, "description": "test"}))["hookSpecificOutput"]
        rewritten = response["updatedInput"]
        self.assertEqual((rewritten["timeout"], rewritten["description"]), (123, "test"))
        suffix = "\nprintf '\\n%s|%s|%s|%s\\n' \"$PWD\" \"$1\" \"$SAMPLE\" \"${HARNESS_HOOKS_COMMAND_IDENTITY-unset}\"; psql"
        for shell in ("/bin/bash", "/bin/zsh"):
            with self.subTest(shell=shell):
                result = self.run_shell(rewritten["command"] + suffix, env, shell=shell)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, f"a b|x y|{child.resolve()}\nquoted $HOME\ndone\n{child.resolve()}|a b|x y|unset\nreal-psql\n")
                self.assertEqual(result.stderr, "")

    def test_wrapper_preserves_status_and_handles_bad_syntax(self):
        env = self.shell_environment(CLAUDE_CODE_SESSION_ID="session", ROBOB_HARNESS="claude")
        for command in ("false", "true; false", "printf 'unterminated", "cat <<EOF\nunterminated"):
            with self.subTest(command=command):
                response = self.run_adapter("claude", self.event(command))["hookSpecificOutput"]
                self.assertIn("updatedInput", response)
                for shell in ("/bin/bash", "/bin/zsh"):
                    raw = self.run_shell(command, env, shell=shell)
                    rewritten = self.run_shell(response["updatedInput"]["command"], env, shell=shell)
                    self.assertEqual(rewritten.returncode, raw.returncode, (shell, rewritten.stderr))
                    self.assertEqual(rewritten.stdout, raw.stdout, shell)

    def test_exit_trap_reset_and_replacement_use_latest_child(self):
        self.add_identity("session", "parent", model="claude-opus-5-5")
        self.state.identities[("session", "agent-sibling")]["model"] = {"model": "claude-opus-5-5"}
        script = self.root / "probe.sh"
        script.write_text("#!/bin/sh\nprintf 'called\\n' >> calls\npsql\n")
        script.chmod(0o755)
        env = self.shell_environment(CLAUDE_CODE_SESSION_ID="session", ROBOB_HARNESS="claude")
        for shell in ("/bin/bash", "/bin/zsh"):
            for second, expected in (("trap - EXIT", ""), ("trap './probe.sh' EXIT", "real-psql\n")):
                with self.subTest(shell=shell, second=second):
                    (self.root / "calls").unlink(missing_ok=True)
                    first = self.run_adapter("claude", self.event("trap './probe.sh' EXIT"))["hookSpecificOutput"]["updatedInput"]["command"]
                    last = self.run_adapter("claude", self.event(second, agent="agent-sibling"))["hookSpecificOutput"]["updatedInput"]["command"]
                    result = self.run_shell(first + "\n" + last, env, shell=shell)
                    self.assertEqual(result.stderr, "")
                    self.assertEqual(result.stdout, expected)
                    self.assertEqual((self.root / "calls").exists(), bool(expected))

    def test_exit_trap_sees_original_exit_status(self):
        self.add_identity("session", "parent", model="claude-opus-5-5")
        env = self.shell_environment(CLAUDE_CODE_SESSION_ID="session", ROBOB_HARNESS="claude")
        command = "trap 'printf \"exit-status=%s\\n\" \"$?\"' EXIT"
        rewritten = self.run_adapter("claude", self.event(command))["hookSpecificOutput"]["updatedInput"]["command"]
        for shell in ("/bin/bash", "/bin/zsh"):
            with self.subTest(shell=shell):
                result = self.run_shell(rewritten + "\nexit 19", env, shell=shell)
                self.assertEqual((result.returncode, result.stdout, result.stderr), (19, "exit-status=19\n", ""))

    def test_failing_exit_action_runs_err_handler_once_per_failure(self):
        self.add_identity("codex-child", "child", parent="parent", model="claude-haiku-5-5")
        for harness in ("claude", "codex"):
            for shell in ("/bin/bash", "/bin/zsh"):
                for action in ("false", "false; false", "false; true", "false || :"):
                    for exit_status in (0, 19):
                        with self.subTest(harness=harness, shell=shell, action=action, status=exit_status):
                            command = "trap 'echo cleanup >> calls' ERR; trap " + shlex.quote(action) + " EXIT"
                            event = self.event(command, session="codex-child", agent=None) if harness == "codex" else self.event(command)
                            env = self.shell_environment(**({"CODEX_THREAD_ID": "codex-child", "ROBOB_HARNESS": "codex"} if harness == "codex" else {"CLAUDE_CODE_SESSION_ID": "session", "ROBOB_HARNESS": "claude"}))
                            rewritten = self.run_adapter(harness, event)["hookSpecificOutput"]["updatedInput"]["command"]
                            suffix = f"\nexit {exit_status}"
                            calls = self.root / "calls"
                            calls.unlink(missing_ok=True)
                            raw = self.run_shell(command + suffix, env, shell=shell)
                            expected_calls = calls.read_text() if calls.exists() else ""
                            calls.unlink(missing_ok=True)
                            actual = self.run_shell(rewritten + suffix, env, shell=shell)
                            actual_calls = calls.read_text() if calls.exists() else ""
                            self.assertEqual((actual.returncode, actual.stdout, actual.stderr, actual_calls),
                                             (raw.returncode, raw.stdout, raw.stderr, expected_calls))

    def test_multiline_exit_trap_keeps_embedded_terminator_and_trap_text(self):
        env = self.shell_environment(CLAUDE_CODE_SESSION_ID="session", ROBOB_HARNESS="claude")
        action = "echo cleanup EXIT\n# trap -- 'pretend' EXIT\nprintf cleaned > cleanup-marker"
        command = "trap " + shlex.quote(action) + " EXIT; trap 'true' USR1"
        rewritten = self.run_adapter("claude", self.event(command))["hookSpecificOutput"]["updatedInput"]["command"]
        for shell in ("/bin/bash", "/bin/zsh"):
            with self.subTest(shell=shell):
                (self.root / "cleanup-marker").unlink(missing_ok=True)
                result = self.run_shell(rewritten + "\nexit 19", env, shell=shell)
                self.assertEqual((result.returncode, result.stdout, result.stderr), (19, "cleanup EXIT\n", ""))
                self.assertEqual((self.root / "cleanup-marker").read_text(), "cleaned")

    def test_zsh_inherited_exit_function_is_not_run_by_snapshot_helpers(self):
        env = self.shell_environment(CLAUDE_CODE_SESSION_ID="session", ROBOB_HARNESS="claude")
        rewritten = self.run_adapter("claude", self.event("printf child"))["hookSpecificOutput"]["updatedInput"]["command"]
        command = "TRAPEXIT() { printf 'called\\n' >> calls; }\n" + rewritten
        result = self.run_shell(command, env, shell="/bin/zsh")
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "child", ""))
        self.assertEqual((self.root / "calls").read_text(), "called\n")

    def test_preexisting_exit_trap_runs_with_original_context(self):
        self.add_identity("session", "parent", model="claude-opus-5-5")
        script = self.root / "probe.sh"
        script.write_text("#!/bin/sh\npsql\n")
        script.chmod(0o755)
        env = self.shell_environment(CLAUDE_CODE_SESSION_ID="session", ROBOB_HARNESS="claude")
        rewritten = self.run_adapter("claude", self.event("printf child"))["hookSpecificOutput"]["updatedInput"]["command"]
        for shell in ("/bin/bash", "/bin/zsh"):
            with self.subTest(shell=shell):
                result = self.run_shell("trap './probe.sh' EXIT\n" + rewritten, env, shell=shell)
                self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "childreal-psql\n", ""))

    def test_heredocs_at_eof_preserve_behavior_and_cleanup(self):
        self.add_identity("session", "parent", model="claude-opus-5-5")
        env = self.shell_environment(CLAUDE_CODE_SESSION_ID="session", ROBOB_HARNESS="claude")
        commands = (
            "echo first;<<EOF\nIt's data",
            "cat <<EOF\nIt's data\nEOF",
            "cat <<'EOF'\nIt's data",
            "cat <<EOF;<<OTHER\nIt's first\nEOF\nIt's second",
            "cat <<-EOF\n\tIt's data\n\tEOF",
        )
        suffix = "\nresult=$?; printf 'status=%s context=%s\\n' \"$result\" \"${HARNESS_HOOKS_COMMAND_IDENTITY-unset}\""
        for shell in ("/bin/bash", "/bin/zsh"):
            for command in commands:
                with self.subTest(shell=shell, command=command):
                    raw = self.run_shell(command, env, shell=shell)
                    response = self.run_adapter("claude", self.event(command))["hookSpecificOutput"]
                    rewritten = self.run_shell(response["updatedInput"]["command"] + suffix, env, shell=shell)
                    self.assertEqual(rewritten.returncode, 0, rewritten.stderr)
                    self.assertEqual(rewritten.stdout, raw.stdout + f"status={raw.returncode} context=unset\n")

    def test_heredoc_does_not_duplicate_err_traps(self):
        env = self.shell_environment(CLAUDE_CODE_SESSION_ID="session", ROBOB_HARNESS="claude")
        for command in ("trap 'echo trapped' ERR; cat <<EOF\nIt's data\nEOF\nfalse",
                        "trap 'echo trapped' ERR; false <<EOF\nIt's data"):
            for shell in ("/bin/bash", "/bin/zsh"):
                with self.subTest(shell=shell, command=command):
                    raw = self.run_shell(command, env, shell=shell)
                    response = self.run_adapter("claude", self.event(command))["hookSpecificOutput"]
                    rewritten = self.run_shell(response["updatedInput"]["command"], env, shell=shell)
                    self.assertEqual((rewritten.returncode, rewritten.stdout), (raw.returncode, raw.stdout))

    def test_docker_wrapper_uses_command_child_and_not_exempt_parent(self):
        self.add_identity("session", "parent", model="claude-opus-5-5")
        offbox = self.offbox_fixture()
        blocker = offbox / "scripts/blockers"
        env = self.shell_environment(CLAUDE_CODE_SESSION_ID="session", ROBOB_HARNESS="claude",
                                     OFFBOX_RULES=str(offbox / "heavy-rules.json"))
        bin_dir = self.root / "bin"
        docker = bin_dir / "docker"
        docker.write_text("#!/bin/sh\nprintf 'real-docker\\n'\n")
        docker.chmod(0o755)
        env["PATH"] = str(blocker) + os.pathsep + env["PATH"]
        # Docker uses the user's executable offbox path for its availability check.
        fake_home = self.root / "home"
        offbox_bin = fake_home / ".local/bin/offbox"
        offbox_bin.parent.mkdir(parents=True)
        offbox_bin.write_text("#!/bin/sh\nexit 0\n")
        offbox_bin.chmod(0o755)
        env["HOME"] = str(fake_home)
        (self.offbox_state / "exemptions.json").write_text(json.dumps([{"thread_id": "parent-only", "expires_at": time.time() + 60}]))
        self.state.identities[("session", None)]["robobThreadId"] = "parent-only"
        script = self.root / "docker-probe.sh"
        script.write_text("#!/bin/sh\n/bin/sh -c 'docker run alpine'\n")
        script.chmod(0o755)
        response = self.run_adapter("claude", self.event("./docker-probe.sh"))["hookSpecificOutput"]
        run = self.run_shell(response["updatedInput"]["command"], env)
        self.assertEqual(run.returncode, 3, run.stderr)
        self.assertEqual(run.stdout, "")
        import importlib.util
        with patch.dict(os.environ, {"OFFBOX_RULES": str(offbox / "heavy-rules.json")}):
            spec = importlib.util.spec_from_file_location("docker_test_classifier", offbox / "scripts/classify.py")
            classifier = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(classifier)
            self.assertEqual(run.stderr, engine._offbox_denial(classifier.classify("docker run alpine", str(self.root))) + "\n")
        raw = self.run_shell("./docker-probe.sh", env)
        self.assertEqual((raw.returncode, raw.stdout, raw.stderr), (0, "real-docker\n", ""))
        # Classifier failures are fail-open for native shells but retain the
        # legacy fail-closed result for an OpenCode-only environment.
        env["OFFBOX_RULES"] = str(self.root / "missing-rules.json")
        failed = self.run_shell("./docker-probe.sh", env)
        self.assertEqual((failed.returncode, failed.stdout), (0, "real-docker\n"))
        self.assertIn("native Docker check unavailable; allowing due to guard error", failed.stderr)
        for name in ("CLAUDE_CODE_SESSION_ID", "ROBOB_HARNESS"):
            env.pop(name)
        env["OPENCODE_SESSION_ID"] = "oc-session"
        failed = self.run_shell("./docker-probe.sh", env)
        self.assertEqual((failed.returncode, failed.stdout), (3, ""))
        self.assertIn("Docker policy check failed", failed.stderr)

    def test_sessionstart_export_failure_is_logged_once(self):
        missing = self.root / "does-not-exist" / "env"
        output = self.run_adapter("claude", {"hook_event_name": "SessionStart"}, CLAUDE_ENV_FILE=str(missing))
        self.assertIsNone(output)
        records = (self.root / "hook-state/decisions.jsonl").read_text().splitlines()
        self.assertEqual(len(records), 1)
        self.assertEqual(json.loads(records[0])["rule"], "session-export-error")

if __name__ == "__main__":
    unittest.main()
