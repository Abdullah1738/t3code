import datetime
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
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


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        state = self.server.state
        parsed = urlsplit(self.path)
        state.calls.append(self.path)
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
        self.wfile.write(raw)

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
            "nativeSessionId": native, "nativeAgentId": agent, "model": {"model": model}}

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

    def test_codex_child_uses_agent_id_as_concrete_native(self):
        self.add_identity("codex-child", "child", parent="parent", model="gpt-6-astra")
        event = self.event("printf ok", session="codex-shared", agent="codex-child")
        result = engine.resolve_identity(event, "codex")
        self.assertEqual(result["robobThreadId"], "child")
        self.assertIn("nativeId=codex-child", self.state.calls[-1])
        self.assertNotIn("agentId", self.state.calls[-1])

    def test_codex_uses_thread_env_before_shared_session_but_event_agent_first(self):
        self.add_identity("codex-env", "env-child", parent="parent", model="gpt-6-astra")
        self.add_identity("codex-agent", "agent-child", parent="parent", model="gpt-6-astra")
        with patch.dict(os.environ, {"CODEX_THREAD_ID": "codex-env"}):
            event = self.event("echo", session="codex-shared", agent=None)
            self.assertEqual(engine.resolve_identity(event, "codex")["robobThreadId"], "env-child")
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

    def test_lineage_has_no_100_parent_cap(self):
        self.add_identity("deep", "leaf", parent="n0", agent=None)
        for number in range(105):
            self.state.threads[f"n{number}"] = {"threadId": f"n{number}", "parentThreadId": f"n{number + 1}" if number < 104 else None}
        self.actor("n104")
        self.assertEqual(engine.decide(self.event("psql", session="deep", agent=None), "claude")["decision"], "deny")
        self.assertTrue(any("/threads/n104" in path for path in self.state.calls))

    def test_explicit_mcp_shell_schema_and_apply_patch_exclusion(self):
        event = self.event("ignored", tool_name="mcp__test_server__exec_command", tool_input={"cmd": "npm ci"})
        self.assertEqual(engine.decide(event, "claude")["decision"], "deny")
        event["tool_name"] = "mcp__test_server__apply_patch"
        self.assertEqual(engine.decide(event, "claude")["decision"], "allow")

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

    def test_outages_fail_open_and_log_each_event_with_hash_and_truncated_command(self):
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
            self.assertEqual(record["cmd"], "npm ci private-argument")
            self.assertEqual(record["cmd_sha1"], hashlib.sha1(record["cmd"].encode()).hexdigest())
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

    def test_log_includes_identity_and_limits_command_to_200_characters(self):
        command = "printf " + "x" * 240
        engine.decide(self.event(command), "claude")
        line = json.loads((self.root / "hook-state/decisions.jsonl").read_text())
        self.assertEqual(line["cmd"], command[:200])
        self.assertEqual(line["cmd_sha1"], hashlib.sha1(command.encode()).hexdigest())
        self.assertEqual(line["robobThreadId"], "child")
        self.assertEqual(line["event"], "PreToolUse")
        self.assertEqual(line["harness"], "claude")

    def test_heavy_identity_outage_allows_even_with_cached_identity_and_no_exemption(self):
        event = self.event("npm ci")
        self.assertEqual(engine.resolve_identity(event, "claude")["resolution"], "resolved")
        self.state.fail = True
        self.assertEqual(engine.decide(event, "claude")["decision"], "allow")
        records = (self.root / "hook-state/decisions.jsonl").read_text().splitlines()
        self.assertEqual(len(records), 1)
        self.assertIsNotNone(json.loads(records[0])["error"])

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
        self.assertIsNone(self.run_adapter("codex", self.event("printf ok", session="codex-child", agent=None)))
        self.assertIsNone(self.run_adapter("claude", self.event("printf ok")))
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
