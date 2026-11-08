import datetime
from contextlib import closing
import hashlib
import hmac
import json
import os
from pathlib import Path
import shlex
import sqlite3
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
        self.coord = self.root / "coord.db"
        with closing(sqlite3.connect(self.coord)) as db:
            db.execute("CREATE TABLE actors (id TEXT, thread_id TEXT, kind TEXT)")
            db.commit()
        self.coord_config = self.root / "coord-config.json"
        self.coord_config.write_text(json.dumps({"mode": "enforce"}))
        self.allow = self.root / "coord-allow.json"
        self.allow.write_text('{"scripts":[]}')
        env = {
            "HARNESS_HOOKS_STATE_DIR": str(self.root / "hook-state"),
            "HARNESS_HOOKS_CONTROL_URL": f"http://127.0.0.1:{self.server.server_port}",
            "HARNESS_HOOKS_TOKEN_FILE": str(self.root / "unused-credential.json"),
            "HARNESS_HOOKS_CLASSIFIER": str(self.classifier),
            "HARNESS_HOOKS_OFFBOX_BIN": str(self.offbox),
            "HARNESS_HOOKS_COORD_DB": str(self.coord),
            "HARNESS_HOOKS_COORD_CONFIG": str(self.coord_config),
            "HARNESS_HOOKS_COORD_ALLOW": str(self.allow),
            "OFFBOX_STATE_DIR": str(self.root / "offbox-state"),
            "OFFBOX_GATE_MODE": "enforce",
            engine.COMMAND_IDENTITY_ENV: "",
            "AGENT_GUARD_APPROVED": "",
            "HARNESS_COORD_APPROVED": "",
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

    def actor(self, thread="parent"):
        with closing(sqlite3.connect(self.coord)) as db:
            db.execute("INSERT INTO actors VALUES (?, ?, ?)", ("actor", "mcp:" + thread, "thread"))
            db.commit()

    def run_adapter(self, harness, event, **env):
        run = subprocess.run([sys.executable, str(SRC / (harness + ".py"))], input=json.dumps(event),
                             text=True, capture_output=True, env={**os.environ, **env}, timeout=5, check=True)
        self.assertEqual(run.stderr, "")
        return json.loads(run.stdout) if run.stdout else None

    def test_heavy_denied_with_exact_rewrite_and_narrow_allowed(self):
        result = engine.decide(self.event("npm ci"), "claude")
        self.assertEqual(result["decision"], "deny")
        self.assertIn("Why: installation [rule pkg-install].", result["reason"])
        self.assertIn("offbox run -- npm ci", result["reason"])
        self.assertEqual(engine.decide(self.event("pytest tests/a.py::test_one"), "claude")["decision"], "allow")
        os.environ["OFFBOX_GATE_MODE"] = "observe"
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

    def test_coord_haiku_child_vs_opus_and_stdin_model(self):
        self.actor()
        event = self.event("psql -c 'select 1'", model="claude-opus-5-5")
        self.assertEqual(engine.decide(event, "claude")["reason"], engine.COORD_REASON)
        event = self.event("psql", session="root", agent=None, model="claude-haiku-5-5")
        self.assertEqual(engine.decide(event, "claude")["decision"], "allow")
        # A current-model switch must not be masked by the 60-second binding cache.
        self.state.identities[("session", "agent-child")]["model"] = {"model": "claude-opus-5-5"}
        self.assertEqual(engine.decide(self.event("psql"), "claude")["decision"], "allow")

    def test_coord_nonmember_exclusions_and_unresolved(self):
        self.assertEqual(engine.decide(self.event("psql"), "claude")["decision"], "allow")
        self.actor()
        self.coord_config.write_text(json.dumps({"mode": "enforce", "exclude": {"threads": ["parent"]}}))
        self.assertEqual(engine.decide(self.event("psql"), "claude")["decision"], "allow")
        self.coord_config.write_text(json.dumps({"mode": "observe"}))
        self.assertEqual(engine.decide(self.event("psql"), "claude")["decision"], "allow")
        self.coord_config.write_text(json.dumps({"mode": "enforce"}))
        self.state.identities[("session", "agent-child")]["model"] = None
        self.assertEqual(engine.decide(self.event("psql"), "claude")["decision"], "allow")

    def test_coord_single_exact_approval_script_and_sql(self):
        self.actor()
        script, sql = self.root / "scripts/deploy-health.sh", self.root / "replica-health.sql"
        script.parent.mkdir()
        script.write_text("psql -f replica-health.sql\n")
        sql.write_text("SELECT 1;\n")
        digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
        self.allow.write_text(json.dumps({"scripts": [{"path": str(script), "sha256": digest(script),
            "inputs": [{"path": str(sql), "sha256": digest(sql)}]}]}))
        command = "zsh scripts/deploy-health.sh replica-health.sql"
        approved = engine.approval(command, str(self.root))
        self.assertTrue(engine.approval_valid(approved))
        result = engine.decide(self.event(command), "claude")
        self.assertEqual(result["decision"], "allow")
        self.assertEqual(result["context"]["rule"], "approved-sha256")
        self.assertIn("AGENT_GUARD_APPROVED=", result["context"]["updatedInput"]["command"])
        for harness in ("claude", "codex"):
            adapter_event = self.event(command)
            if harness == "codex":
                self.add_identity("codex-child", "child", parent="parent", model="claude-haiku-5-5")
                adapter_event = self.event(command, session="codex-child", agent=None)
            response = self.run_adapter(harness, adapter_event)["hookSpecificOutput"]
            self.assertEqual(response["permissionDecision"], "allow")
            self.assertIn("AGENT_GUARD_APPROVED=", response["updatedInput"]["command"])
        self.assertIsNone(engine.approval(command + "; psql", str(self.root)))
        self.assertEqual(engine.decide(self.event(command + "; psql"), "claude")["decision"], "deny")
        sql.write_text("SELECT 2;\n")
        self.assertFalse(engine.approval_valid(approved))
        self.assertEqual(engine.decide(self.event(command), "claude")["decision"], "deny")
        sql.write_text("SELECT 1;\n")
        script.write_text("psql -c changed\n")
        self.assertIsNone(engine.approval(command, str(self.root)))

    def test_coord_classification_rule_port(self):
        cases = {
            "printf 'psql'": None, "psql -c 'select 1'": "database-direct",
            "bash -n scripts/deploy-x": None, "bash -c 'psql'": "database-direct",
            "echo $(aws ssm get-parameter --with-decryption)": "secret-read",
            "aws ecs run-task": "aws-mutation", "aws ecs describe-services": None,
            "aws logs start-query --log-group-name x; aws ecs run-task": "aws-mutation",
            "terraform state rm item": "terraform-mutation", "git push -f": "force-push",
            "gh api -X POST repos/x": "github-write", "npm run deploy:dev": "deploy-script",
            "offbox run -- bash -c 'psql'": "database-direct",
            "bash <<'EOF'\npsql\nEOF": "database-direct",
            "cat <<'EOF'\npsql\nEOF": None,
        }
        for source, expected in cases.items():
            with self.subTest(source=source):
                self.assertEqual(engine.classify_coord(source), expected)

    def test_betterstack_scope_and_apply_patch(self):
        base = "/Users/ardud/crpko-devops"
        for cwd, expected in [(base, "allow"), (base + "/src", "allow"), (base + "-lane", "allow"),
                              (base + "s", "deny"), (str(self.root), "deny"), ("", "deny")]:
            with self.subTest(cwd=cwd):
                event = self.event("x", tool_name="mcp__betterstack__monitor", cwd=cwd)
                self.assertEqual(engine.decide(event, "claude")["decision"], expected)
        self.actor()
        event = self.event("npm ci\npsql", tool_name="apply_patch")
        with patch.object(engine, "_classify_offbox") as offbox, patch.object(engine, "classify_coord") as coord:
            self.assertEqual(engine.decide(event, "codex")["decision"], "allow")
            offbox.assert_not_called()
            coord.assert_not_called()

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
            cached["at"] = time.time() - 61
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
        env = {**os.environ, "CLAUDE_CODE_SESSION_ID": session}
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
        sys.path.insert(0, str(SRC.parents[1] / "offbox/skill/scripts"))
        from offbox_lib import identity as offbox_identity
        engine.decide(self.identity_probe(), "claude")
        self.age_identity_cache(3600)
        with patch.object(engine, "_get", side_effect=TimeoutError("stalled")):
            token = self.command_token(engine.decide(self.identity_probe(), "claude"))
            env = {engine.COMMAND_IDENTITY_ENV: token, "CLAUDE_CODE_SESSION_ID": "session",
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
        engine.decide(self.identity_probe(), "claude")
        self.age_identity_cache(3600)
        with patch.object(engine, "_get", side_effect=TimeoutError("stalled")):
            self.assertEqual(self.token_identity(engine.decide(self.identity_probe(), "claude"))["robobThreadId"], "child")

    def test_authoritative_miss_invalidates_cache_including_next_call(self):
        for resolution in ("none", "pending", "ambiguous", "unavailable"):
            with self.subTest(resolution=resolution):
                engine.decide(self.identity_probe(), "claude")
                self.age_identity_cache(61)
                with patch.object(engine, "_get", return_value={"identity": {"resolution": resolution}}):
                    result = engine.decide(self.identity_probe(), "claude")
                    self.assertNotIn(engine.COMMAND_IDENTITY_ENV + "=", result["context"].get("updatedInput", {}).get("command", ""))
                with patch.object(engine, "_get", side_effect=TimeoutError("stalled")):
                    self.assertEqual(engine.resolve_identity(self.identity_probe(), "claude")["resolution"], "unavailable")

    def test_claude_cache_expired_or_invalid_is_not_used(self):
        for age in (engine._CLAUDE_IDENTITY_TTL + 1, -60):
            with self.subTest(age=age):
                engine.decide(self.identity_probe(), "claude")
                self.age_identity_cache(age)
                with patch.object(engine, "_get", side_effect=TimeoutError("stalled")):
                    result = engine.decide(self.identity_probe(), "claude")
                    self.assertNotIn(engine.COMMAND_IDENTITY_ENV + "=", result["context"].get("updatedInput", {}).get("command", ""))

    def test_claude_bad_response_or_auth_error_does_not_use_old_cache(self):
        engine.decide(self.identity_probe(), "claude")
        self.age_identity_cache(61)
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
        self.age_identity_cache(engine._CLAUDE_IDENTITY_TTL - 1)
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
        with patch.object(engine, "_get", side_effect=[ConnectionRefusedError("retry"), {"identity": identity}]) as get:
            result = engine.decide(self.identity_probe(), "claude")
            self.assertEqual(get.call_count, 2)
            self.assertEqual(self.token_identity(result)["robobThreadId"], "child")

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

    def test_deep_lineage_intermediate_exempt_and_coord_member(self):
        self.add_identity("deep", "leaf", parent="middle", agent=None)
        self.state.threads["middle"] = {"threadId": "middle", "parentThreadId": "parent", "nativeSessionId": "middle-native"}
        event = self.event("npm ci", session="deep", agent=None)
        (self.offbox_state / "exemptions.json").write_text(json.dumps([{"thread_id": "middle", "expires_at": time.time() + 60}]))
        self.assertEqual(engine.decide(event, "claude")["decision"], "allow")
        self.actor("middle")
        self.assertEqual(engine.decide(self.event("psql", session="deep", agent=None), "claude")["decision"], "deny")
        self.assertTrue(any("/threads/middle" in path for path in self.state.calls))
        self.assertTrue(any("/threads/parent" in path for path in self.state.calls))

    def test_claude_three_native_levels_follow_proven_owners_for_coord_and_exemptions(self):
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
        self.actor("a")
        event = self.event("psql", agent="agent-leaf")
        self.assertEqual(engine.decide(event, "claude")["decision"], "deny")
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

    def test_missing_native_owner_metadata_is_not_replaced_by_flat_shell_parent(self):
        event = self.event("psql")
        del self.state.identities[("session", "agent-child")]["parentNativeAgentId"]
        self.actor()
        self.assertEqual(engine.decide(event, "claude")["context"]["rule"], "coord-unresolved")

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

    def test_exemption_and_coord_share_a_complete_ancestry_walk(self):
        self.add_identity("deep", "leaf", parent="middle", agent=None)
        self.state.threads["middle"] = {"threadId": "middle", "parentThreadId": "parent"}
        (self.offbox_state / "exemptions.json").write_text(json.dumps([{"thread_id": "middle", "expires_at": time.time() + 60}]))
        self.actor("middle")
        event = self.event("npm ci; psql", session="deep", agent=None)
        self.assertEqual(engine.decide(event, "claude")["decision"], "deny")
        paths = [p for p in self.state.calls if "/threads/" in p]
        self.assertEqual(len(paths), 2)

    def test_transient_first_lineage_error_does_not_disable_independent_coord_guard(self):
        self.actor()
        (self.offbox_state / "exemptions.json").write_text(json.dumps([{"thread_id": "other", "expires_at": time.time() + 60}]))
        original = engine._get
        failures = []

        def fail_first_parent(path, **kwargs):
            if "/threads/" in path and not failures:
                failures.append(path)
                raise ValueError("transient")
            return original(path, **kwargs)

        with patch.object(engine, "_get", side_effect=fail_first_parent):
            result = engine.decide(self.event("npm ci; psql"), "claude")
        self.assertEqual(result["decision"], "deny")
        self.assertEqual(result["reason"], engine.COORD_REASON)
        self.assertEqual(len(failures), 1)

    def test_explicit_mcp_shell_schema_and_apply_patch_exclusion(self):
        event = self.event("ignored", tool_name="mcp__test_server__exec_command", tool_input={"cmd": "npm ci"})
        self.assertEqual(engine.decide(event, "claude")["decision"], "deny")
        event["tool_name"] = "mcp__test_server__apply_patch"
        self.assertEqual(engine.decide(event, "claude")["decision"], "allow")

    def test_mcp_shell_rewrites_original_field_and_propagates_child_to_shim(self):
        self.actor()
        self.add_identity("session", "parent", model="claude-opus-5-5")
        self.add_identity("agent-child", "child", parent="parent", model="claude-haiku-5-5")
        script = self.root / "probe.sh"
        script.write_text("#!/bin/sh\npsql\n")
        script.chmod(0o755)
        for harness in ("claude", "codex"):
            for tool in ("exec_command", "shell_command"):
                for field in ("cmd", "command"):
                    with self.subTest(harness=harness, tool=tool, field=field):
                        inp = {field: "./probe.sh", "workdir": str(self.root), "timeout": 123}
                        event = self.event("ignored", tool_name=f"mcp__test_server__{tool}", tool_input=inp)
                        response = self.run_adapter(harness, event)["hookSpecificOutput"]
                        self.assertEqual(response["permissionDecision"], "allow")
                        updated = response["updatedInput"]
                        self.assertEqual(set(updated), set(inp))
                        self.assertEqual(updated["workdir"], inp["workdir"])
                        self.assertEqual(updated["timeout"], 123)
                        self.assertIn(engine.COMMAND_IDENTITY_ENV + "=", updated[field])
                        env = self.shell_environment(**({"CLAUDE_CODE_SESSION_ID": "session"} if harness == "claude"
                                                       else {"CODEX_THREAD_ID": "session"}))
                        result = self.run_shell(updated[field], env)
                        self.assertEqual((result.returncode, result.stdout, result.stderr),
                                         (3, "", engine.COORD_REASON + "\n"))
        event = self.event("ignored", tool_name="mcp__test_server__exec_command",
                           tool_input={"command": "./probe.sh", "cmd": "./other.sh"})
        self.assertNotIn("updatedInput", engine.decide(event, "claude")["context"])

    def test_mcp_rewrite_activates_raw_send_shims_without_native_env(self):
        offbox = SRC.parents[1] / "offbox/skill/scripts/blockers"
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

    def test_mcp_approved_script_is_not_trusted_as_same_host(self):
        self.actor()
        script, sql = self.root / "scripts/deploy-health.sh", self.root / "replica-health.sql"
        script.parent.mkdir()
        script.write_text("psql -f replica-health.sql\n")
        sql.write_text("SELECT 1;\n")
        digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
        self.allow.write_text(json.dumps({"scripts": [{"path": str(script), "sha256": digest(script),
            "inputs": [{"path": str(sql), "sha256": digest(sql)}]}]}))
        command = "scripts/deploy-health.sh replica-health.sql"
        event = self.event(command, tool_name="mcp__test_server__exec_command", tool_input={"cmd": command})
        self.assertEqual(engine.decide(event, "claude")["decision"], "deny")

    def test_missing_intermediate_and_cycle_fail_open(self):
        self.add_identity("deep", "leaf", parent="middle", agent=None)
        self.actor("parent")
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
        with patch.dict(os.environ, {"HARNESS_HOOKS_TOKEN_FILE": str(token_file)}):
            del os.environ["HARNESS_HOOKS_CONTROL_URL"]
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

    def test_classifier_timeout_fails_open_but_independent_coord_still_enforces(self):
        self.classifier.write_text("import sys,time\nsys.stdin.readline()\ntime.sleep(5)\n")
        self.actor()
        start = time.monotonic()
        verdict = engine.decide(self.event("psql"), "claude")
        elapsed = time.monotonic() - start
        self.assertEqual(verdict["decision"], "deny")
        self.assertEqual(verdict["reason"], engine.COORD_REASON)
        self.assertGreaterEqual(elapsed, 3)
        self.assertLess(elapsed, 4.9)
        line = json.loads((self.root / "hook-state/decisions.jsonl").read_text())
        self.assertEqual(line["error"], "TimeoutExpired")

    def test_identity_outage_does_not_use_cached_model_for_coord(self):
        self.actor()
        event = self.event("psql")
        self.assertEqual(engine.resolve_identity(event, "claude")["resolution"], "resolved")
        self.state.fail = True
        self.assertEqual(engine.decide(event, "claude")["decision"], "allow")

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

    def test_nearest_nested_coord_actor_does_not_inherit_other_actor_exclusion(self):
        self.actor("parent")
        with closing(sqlite3.connect(self.coord)) as db:
            db.execute("INSERT INTO actors VALUES (?, ?, ?)", ("child-actor", "mcp:child", "thread"))
            db.commit()
        self.coord_config.write_text(json.dumps({"mode": "enforce", "exclude": {"actors": ["actor"]}}))
        self.assertEqual(engine.decide(self.event("psql"), "claude")["decision"], "deny")

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
                                          HARNESS_HOOKS_OFFBOX_BLOCKERS=str(self.root / "offbox blockers"),
                                          HARNESS_HOOKS_COORD_BLOCKERS=str(self.root / "coord blockers")))
        text = target.read_text()
        self.assertIn("offbox blockers", text)
        self.assertLess(text.index("offbox blockers"), text.index("coord blockers"))
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
        for name in ("CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "ROBOB_HARNESS", "AGENT_GUARD_SESSION",
                     "AGENT_GUARD_APPROVED", "HARNESS_COORD_APPROVED", engine.COMMAND_IDENTITY_ENV):
            env.pop(name, None)
        env.update({"PATH": os.pathsep.join([str(SRC.parent / "coord-blockers"), str(bin_dir), "/usr/bin", "/bin"]),
                    "HARNESS_HOOKS_SRC": str(SRC), **values})
        return env

    def run_shell(self, command, env, shell="/bin/bash"):
        return subprocess.run([shell, "-c", command], cwd=self.root, env=env,
                              text=True, capture_output=True, timeout=10)

    def test_rewrite_identifies_both_native_children_and_scopes_compound_commands(self):
        self.actor()
        # Both native children share this parent session, but have different models.
        self.add_identity("session", "parent", model="claude-opus-5-5")
        self.state.identities[("session", "agent-sibling")]["model"] = {"model": "claude-opus-5-5"}
        script = self.root / "probe.sh"
        script.write_text("#!/bin/sh\nexec /bin/sh -c 'psql -c select'\n")
        script.chmod(0o755)
        env = self.shell_environment(CLAUDE_CODE_SESSION_ID="session", ROBOB_HARNESS="claude")
        commands = ["printf 'head\\n'; true | cat; ./probe.sh", "printf 'head\\n'; ./probe.sh | cat"]
        for agent, code, command in (("agent-child", 3, commands[0]), ("agent-sibling", 0, commands[0]),
                                     ("agent-child", 3, commands[1]), ("agent-sibling", 0, commands[1])):
            with self.subTest(agent=agent, command=command):
                response = self.run_adapter("claude", self.event(command, agent=agent))["hookSpecificOutput"]
                self.assertEqual(response["permissionDecision"], "allow")
                result = self.run_shell("set -o pipefail\n" + response["updatedInput"]["command"], env)
                self.assertEqual(result.returncode, code, result.stderr)
                self.assertEqual(result.stdout, "head\n" + ("real-psql\n" if code == 0 else ""))
                self.assertEqual(result.stderr, engine.COORD_REASON + "\n" if code == 3 else "")

        # Reversing the parent and child models must not incorrectly deny Opus.
        self.state.identities[("session", None)]["model"] = {"model": "claude-haiku-5-5"}
        response = self.run_adapter("claude", self.event(commands[0], agent="agent-sibling"))["hookSpecificOutput"]
        result = self.run_shell(response["updatedInput"]["command"], env)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "head\nreal-psql\n", ""))

    def test_context_fallback_tampering_and_fresh_model(self):
        self.actor()
        self.add_identity("session", "parent", model="claude-opus-5-5")
        env = self.shell_environment(CLAUDE_CODE_SESSION_ID="session", ROBOB_HARNESS="claude")
        script = self.root / "probe.sh"
        script.write_text("#!/bin/sh\npsql\n")
        script.chmod(0o755)
        raw = self.run_shell("./probe.sh", env)
        self.assertEqual((raw.returncode, raw.stdout, raw.stderr), (0, "real-psql\n", ""))
        response = self.run_adapter("claude", self.event("./probe.sh"))["hookSpecificOutput"]
        rewritten = response["updatedInput"]["command"]
        denied = self.run_shell(rewritten, env)
        self.assertEqual((denied.returncode, denied.stderr), (3, engine.COORD_REASON + "\n"))

        # Verification is integrity-only: a changed token or a mismatched
        # session falls back to normal environment attribution, not its child.
        changed = rewritten.replace("HARNESS_HOOKS_COMMAND_IDENTITY=", "HARNESS_HOOKS_COMMAND_IDENTITY=x", 1)
        result = self.run_shell(changed, env)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "real-psql\n", ""))
        self.add_identity("another", "other-parent", model="claude-opus-5-5")
        result = self.run_shell(rewritten, {**env, "CLAUDE_CODE_SESSION_ID": "another"})
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "real-psql\n", ""))

        # Tokens carry native lookup inputs, not a model/authorization snapshot.
        self.state.identities[("session", "agent-child")]["model"] = {"model": "claude-opus-5-5"}
        result = self.run_shell(rewritten, env)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "real-psql\n", ""))
        self.state.fail = True
        result = self.run_shell(rewritten, env)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "real-psql\n")
        self.assertIn("allowing due to guard error", result.stderr)

    def test_codex_child_context_outranks_parent_environment(self):
        self.actor()
        self.add_identity("codex-parent", "parent", model="claude-opus-5-5")
        self.add_identity("codex-child", "child", parent="parent", model="claude-haiku-5-5")
        script = self.root / "probe.sh"
        script.write_text("#!/bin/sh\npsql\n")
        script.chmod(0o755)
        env = self.shell_environment(CODEX_THREAD_ID="codex-parent", ROBOB_HARNESS="codex")
        # A stale app-server environment is unrelated to the hook payload.
        with patch.dict(os.environ, {"CODEX_THREAD_ID": "stale-unrelated"}):
            response = self.run_adapter("codex", self.event("./probe.sh", session="codex-parent", agent="codex-child"))["hookSpecificOutput"]
        result = self.run_shell(response["updatedInput"]["command"], env)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (3, "", engine.COORD_REASON + "\n"))
        self.assertTrue(any("nativeId=codex-child" in call for call in self.state.calls))
        self.state.identities[("codex-parent", None)]["model"] = {"model": "claude-haiku-5-5"}
        self.state.identities[("codex-child", None)]["model"] = {"model": "claude-opus-5-5"}
        response = self.run_adapter("codex", self.event("./probe.sh", session="codex-parent", agent="codex-child"))["hookSpecificOutput"]
        result = self.run_shell(response["updatedInput"]["command"], env)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "real-psql\n", ""))

    def test_top_level_codex_payload_ignores_stale_hook_env_in_shell_context(self):
        self.actor()
        self.add_identity("actual-root", "parent", model="claude-haiku-5-5")
        self.add_identity("stale", "stale-thread", model="claude-opus-5-5")
        script = self.root / "probe.sh"
        script.write_text("#!/bin/sh\npsql\n")
        script.chmod(0o755)
        with patch.dict(os.environ, {"CODEX_THREAD_ID": "stale"}):
            response = self.run_adapter("codex", self.event("./probe.sh", session="actual-root", agent=None))["hookSpecificOutput"]
        env = self.shell_environment(CODEX_THREAD_ID="actual-root", ROBOB_HARNESS="codex")
        result = self.run_shell(response["updatedInput"]["command"], env)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (3, "", engine.COORD_REASON + "\n"))
        shell_event = self.event("./probe.sh", session="actual-root", agent=None, tool_name="shell")
        response = self.run_adapter("codex", shell_event)["hookSpecificOutput"]
        result = self.run_shell(response["updatedInput"]["command"], env)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (3, "", engine.COORD_REASON + "\n"))

    def test_unavailable_policy_emits_no_rewrite_without_inherited_context(self):
        self.state.fail = True
        event = self.event("printf ok")
        self.assertIsNone(self.run_adapter("claude", event))
        self.assertIsNone(self.run_adapter("codex", event))

    def test_fresh_nested_hook_replaces_parent_context_and_approval(self):
        self.actor()
        self.add_identity("session", "parent", model="claude-opus-5-5")
        self.state.identities[("session", "agent-sibling")]["model"] = {"model": "claude-opus-5-5"}
        script = self.root / "probe.sh"
        script.write_text("#!/bin/sh\npsql\n")
        script.chmod(0o755)
        with patch.dict(os.environ, {"CLAUDE_CODE_SESSION_ID": "session"}):
            parent_token = engine._command_identity(self.event("./probe.sh", agent="agent-sibling"), "claude")
        response = self.run_adapter("claude", self.event("./probe.sh"),
                                    CLAUDE_CODE_SESSION_ID="session",
                                    HARNESS_HOOKS_COMMAND_IDENTITY=parent_token,
                                    HARNESS_COORD_APPROVED="stale-pin")["hookSpecificOutput"]
        env = self.shell_environment(CLAUDE_CODE_SESSION_ID="session", ROBOB_HARNESS="claude",
                                     HARNESS_HOOKS_COMMAND_IDENTITY=parent_token,
                                     HARNESS_COORD_APPROVED="stale-pin")
        result = self.run_shell(response["updatedInput"]["command"], env)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (3, "", engine.COORD_REASON + "\n"))

    def test_rewrite_preserves_shell_state_and_does_not_leak_to_siblings(self):
        self.actor()
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
        self.actor()
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

    def test_err_trap_fires_once_with_child_identity_and_no_sibling_leak(self):
        self.actor()
        self.add_identity("session", "parent", model="claude-opus-5-5")
        script = self.root / "probe.sh"
        script.write_text("#!/bin/sh\nprintf 'called\\n' >> calls\npsql\n")
        script.chmod(0o755)
        env = self.shell_environment(CLAUDE_CODE_SESSION_ID="session", ROBOB_HARNESS="claude")
        command = "trap './probe.sh' ERR; false"
        response = self.run_adapter("claude", self.event(command))["hookSpecificOutput"]
        suffix = "\nresult=$?; trap - ERR; printf 'status=%s context=%s\\n' \"$result\" \"${HARNESS_HOOKS_COMMAND_IDENTITY-unset}\"; psql"
        for shell in ("/bin/bash", "/bin/zsh"):
            with self.subTest(shell=shell):
                calls = self.root / "calls"
                calls.unlink(missing_ok=True)
                result = self.run_shell(response["updatedInput"]["command"] + suffix, env, shell=shell)
                self.assertEqual(calls.read_text(), "called\n")
                self.assertEqual((result.returncode, result.stdout, result.stderr),
                                 (0, "status=1 context=unset\nreal-psql\n", engine.COORD_REASON + "\n"))

    def test_exit_trap_uses_executing_child_after_context_cleanup(self):
        self.actor()
        self.add_identity("session", "parent", model="claude-opus-5-5")
        self.state.identities[("session", "agent-sibling")]["model"] = {"model": "claude-opus-5-5"}
        script = self.root / "probe.sh"
        script.write_text("#!/bin/sh\nprintf 'called\\n' >> calls\npsql\n")
        script.chmod(0o755)
        env = self.shell_environment(CLAUDE_CODE_SESSION_ID="session", ROBOB_HARNESS="claude")
        command = "trap './probe.sh' EXIT"
        for shell in ("/bin/bash", "/bin/zsh"):
            for agent, expected in (("agent-child", engine.COORD_REASON + "\n"), ("agent-sibling", "")):
                with self.subTest(shell=shell, agent=agent):
                    (self.root / "calls").unlink(missing_ok=True)
                    response = self.run_adapter("claude", self.event(command, agent=agent))["hookSpecificOutput"]
                    suffix = "\nprintf 'context=%s\\n' \"${HARNESS_HOOKS_COMMAND_IDENTITY-unset}\""
                    result = self.run_shell(response["updatedInput"]["command"] + suffix, env, shell=shell)
                    self.assertEqual((self.root / "calls").read_text(), "called\n")
                    self.assertEqual(result.stderr, expected)
                    self.assertEqual(result.stdout, "context=unset\n" + ("real-psql\n" if not expected else ""))

    def test_exit_trap_reset_and_replacement_use_latest_child(self):
        self.actor()
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
        self.actor()
        self.add_identity("session", "parent", model="claude-opus-5-5")
        env = self.shell_environment(CLAUDE_CODE_SESSION_ID="session", ROBOB_HARNESS="claude")
        command = "trap 'printf \"exit-status=%s\\n\" \"$?\"' EXIT"
        rewritten = self.run_adapter("claude", self.event(command))["hookSpecificOutput"]["updatedInput"]["command"]
        for shell in ("/bin/bash", "/bin/zsh"):
            with self.subTest(shell=shell):
                result = self.run_shell(rewritten + "\nexit 19", env, shell=shell)
                self.assertEqual((result.returncode, result.stdout, result.stderr), (19, "exit-status=19\n", ""))

    def test_failing_exit_action_runs_err_handler_once_per_failure(self):
        self.actor()
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

    def test_exit_trap_remains_attributed_to_codex_child(self):
        self.actor()
        self.add_identity("codex-parent", "parent", model="claude-opus-5-5")
        self.add_identity("codex-child", "child", parent="parent", model="claude-haiku-5-5")
        script = self.root / "probe.sh"
        script.write_text("#!/bin/sh\npsql\n")
        script.chmod(0o755)
        event = self.event("trap './probe.sh' EXIT", session="codex-parent", agent="codex-child")
        rewritten = self.run_adapter("codex", event)["hookSpecificOutput"]["updatedInput"]["command"]
        env = self.shell_environment(CODEX_THREAD_ID="codex-parent", ROBOB_HARNESS="codex")
        for shell in ("/bin/bash", "/bin/zsh"):
            with self.subTest(shell=shell):
                result = self.run_shell(rewritten, env, shell=shell)
                self.assertEqual(result.stdout, "")
                self.assertEqual(result.stderr, engine.COORD_REASON + "\n")

    def test_multiline_exit_trap_retains_child_attribution(self):
        self.actor()
        self.add_identity("session", "parent", model="claude-opus-5-5")
        script = self.root / "probe.sh"
        script.write_text("#!/bin/sh\npsql\n")
        script.chmod(0o755)
        env = self.shell_environment(CLAUDE_CODE_SESSION_ID="session", ROBOB_HARNESS="claude")
        command = "trap 'echo deferred\n./probe.sh' EXIT"
        rewritten = self.run_adapter("claude", self.event(command))["hookSpecificOutput"]["updatedInput"]["command"]
        for shell in ("/bin/bash", "/bin/zsh"):
            with self.subTest(shell=shell):
                result = self.run_shell(rewritten, env, shell=shell)
                self.assertEqual(result.stdout, "deferred\n")
                self.assertEqual(result.stderr, engine.COORD_REASON + "\n")

    def test_multiline_exit_trap_keeps_embedded_terminator_and_trap_text(self):
        self.actor()
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

    def test_zsh_exit_function_retains_child_identity_without_helper_invocations(self):
        self.actor()
        self.add_identity("session", "parent", model="claude-opus-5-5")
        self.add_identity("codex-parent", "parent", model="claude-opus-5-5")
        self.add_identity("codex-child", "child", parent="parent", model="claude-haiku-5-5")
        probe = self.root / "probe.sh"
        probe.write_text("#!/bin/sh\nprintf 'called\\n' >> calls\npsql\n")
        probe.chmod(0o755)
        command = "TRAPEXIT() { ./probe.sh; }"
        for harness in ("claude", "codex"):
            with self.subTest(harness=harness):
                (self.root / "calls").unlink(missing_ok=True)
                if harness == "claude":
                    event = self.event(command)
                    env = self.shell_environment(CLAUDE_CODE_SESSION_ID="session", ROBOB_HARNESS="claude")
                else:
                    event = self.event(command, session="codex-parent", agent="codex-child")
                    env = self.shell_environment(CODEX_THREAD_ID="codex-parent", ROBOB_HARNESS="codex")
                rewritten = self.run_adapter(harness, event)["hookSpecificOutput"]["updatedInput"]["command"]
                suffix = "\nprintf 'context=%s\\n' \"${HARNESS_HOOKS_COMMAND_IDENTITY-unset}\"\nexit 19"
                result = self.run_shell(rewritten + suffix, env, shell="/bin/zsh")
                self.assertEqual((result.returncode, result.stdout, result.stderr),
                                 (19, "context=unset\n", engine.COORD_REASON + "\n"))
                self.assertEqual((self.root / "calls").read_text(), "called\n")

    def test_zsh_exit_function_preserves_status_and_later_replacement_or_reset(self):
        self.actor()
        self.add_identity("session", "parent", model="claude-opus-5-5")
        self.state.identities[("session", "agent-sibling")]["model"] = {"model": "claude-opus-5-5"}
        probe = self.root / "probe.sh"
        probe.write_text("#!/bin/sh\nprintf 'called\\n' >> calls\npsql\n")
        probe.chmod(0o755)
        env = self.shell_environment(CLAUDE_CODE_SESSION_ID="session", ROBOB_HARNESS="claude")
        command = "TRAPEXIT() { printf 'status=%s arg=%s\\n' \"$?\" \"$1\"; ./probe.sh; }"
        first = self.run_adapter("claude", self.event(command))["hookSpecificOutput"]["updatedInput"]["command"]
        cases = (("printf sibling", "siblingstatus=19 arg=0\n", engine.COORD_REASON + "\n", True),
                 (command, "status=19 arg=0\nreal-psql\n", "", True),
                 ("trap - EXIT", "", "", False))
        for second, expected, error, called in cases:
            with self.subTest(second=second):
                (self.root / "calls").unlink(missing_ok=True)
                sibling = self.run_adapter("claude", self.event(second, agent="agent-sibling"))["hookSpecificOutput"]["updatedInput"]["command"]
                result = self.run_shell(first + "\n" + sibling + "\nexit 19", env, shell="/bin/zsh")
                self.assertEqual((result.returncode, result.stdout, result.stderr), (19, expected, error))
                self.assertEqual((self.root / "calls").read_text() if called else "", "called\n" if called else "")
                self.assertEqual((self.root / "calls").exists(), called)

    def test_zsh_inherited_exit_function_is_not_run_by_snapshot_helpers(self):
        self.actor()
        env = self.shell_environment(CLAUDE_CODE_SESSION_ID="session", ROBOB_HARNESS="claude")
        rewritten = self.run_adapter("claude", self.event("printf child"))["hookSpecificOutput"]["updatedInput"]["command"]
        command = "TRAPEXIT() { printf 'called\\n' >> calls; }\n" + rewritten
        result = self.run_shell(command, env, shell="/bin/zsh")
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "child", ""))
        self.assertEqual((self.root / "calls").read_text(), "called\n")

    def test_preexisting_exit_trap_runs_with_original_context(self):
        self.actor()
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

    def test_unchanged_exit_trap_keeps_its_own_context(self):
        self.actor()
        self.add_identity("session", "parent", model="claude-opus-5-5")
        self.state.identities[("session", "agent-sibling")]["model"] = {"model": "claude-opus-5-5"}
        script = self.root / "probe.sh"
        script.write_text("#!/bin/sh\npsql\n")
        script.chmod(0o755)
        env = self.shell_environment(CLAUDE_CODE_SESSION_ID="session", ROBOB_HARNESS="claude")
        first = self.run_adapter("claude", self.event("trap './probe.sh' EXIT"))["hookSpecificOutput"]["updatedInput"]["command"]
        second = self.run_adapter("claude", self.event("printf sibling", agent="agent-sibling"))["hookSpecificOutput"]["updatedInput"]["command"]
        for shell in ("/bin/bash", "/bin/zsh"):
            with self.subTest(shell=shell):
                result = self.run_shell(first + "\n" + second, env, shell=shell)
                self.assertEqual(result.stdout, "sibling")
                self.assertEqual(result.stderr, engine.COORD_REASON + "\n")

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

    def test_approved_script_rewrite_carries_identity_and_approval_once(self):
        self.actor()
        self.add_identity("session", "parent", model="claude-opus-5-5")
        script, sql = self.root / "scripts/check-health.sh", self.root / "replica-health.sql"
        script.parent.mkdir()
        script.write_text("#!/bin/sh\n/bin/sh -c 'psql'\n")
        script.chmod(0o755)
        sql.write_text("SELECT 1;\n")
        digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
        self.allow.write_text(json.dumps({"scripts": [{"path": str(script), "sha256": digest(script),
            "inputs": [{"path": str(sql), "sha256": digest(sql)}]}]}))
        env = self.shell_environment(CLAUDE_CODE_SESSION_ID="session", ROBOB_HARNESS="claude")
        response = self.run_adapter("claude", self.event("scripts/check-health.sh replica-health.sql"))["hookSpecificOutput"]
        rewritten = response["updatedInput"]["command"]
        self.assertEqual(sum(line.startswith("export HARNESS_HOOKS_COMMAND_IDENTITY=") for line in rewritten.splitlines()), 1)
        self.assertEqual(sum(line.startswith("export AGENT_GUARD_APPROVED=") for line in rewritten.splitlines()), 1)
        run = self.run_shell(rewritten, env)
        self.assertEqual((run.returncode, run.stdout, run.stderr), (0, "real-psql\n", ""))
        sql.write_text("SELECT 2;\n")
        run = self.run_shell(rewritten, env)
        self.assertEqual((run.returncode, run.stdout, run.stderr), (3, "", engine.COORD_REASON + "\n"))

    def test_docker_wrapper_uses_command_child_and_not_exempt_parent(self):
        self.actor()
        self.add_identity("session", "parent", model="claude-opus-5-5")
        offbox = SRC.parents[1] / "offbox/skill"
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

    def test_policy_denials_survive_independent_guard_failure(self):
        with patch.object(engine, "decide_coord", side_effect=RuntimeError("not called")) as coord:
            verdict = engine.decide(self.event("npm ci"), "claude")
            self.assertEqual(verdict["decision"], "deny")
            coord.assert_not_called()
        records = (self.root / "hook-state/decisions.jsonl").read_text().splitlines()
        self.assertEqual(len(records), 1)


if __name__ == "__main__":
    unittest.main()
