"""Real native adapters against an isolated fake decision server; no owner data."""
from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / "hooks/recall_hook.py"
sys.path.insert(0, str(ROOT / "src"))
spec = importlib.util.spec_from_file_location("native_recall_hook", HOOK)
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)
from recall_hook_state import Store


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, value):
        data = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        self.server.identity_calls.append(self.path)
        self.reply({"identity": {"resolution": "resolved", "robobThreadId": "fixture-root", "rootThreadId": "fixture-root",
                    "executionKind": "top-level", "driver": "claudeAgent" if "claudeAgent" in self.path else "codex",
                    "providerInstanceId": "fixture", "parentThreadId": None}})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.requests.append(body)
        if self.server.real_engine:
            from acceptance_engine import evaluate
            result = evaluate(body)
            self.server.engine_results.append(result)
            self.reply(result)
            return
        if self.server.delay:
            time.sleep(self.server.delay)
        command = body.get("arguments", {}).get("command", "")
        deny = body["trigger"] == "tool" and command == "git push origin HEAD:main"
        result = {"decision": "deny" if deny else "allow", "reason": "Push trading-core to main-dev, never main" if deny else "",
                  "note": "<recall>\nHistorical fixture: use main-dev [fixture#e1]\n</recall>" if deny or body["trigger"] != "tool" or self.server.notes else None,
                  "sources": [{"session_id": "fixture", "event_id": 1}] if self.server.cited else [],
                  "recall_ran": command != "git status"}
        if result["recall_ran"]:
            self.server.recall_runs.append(body)
        self.reply(result)


class NativeAdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from acceptance_engine import evaluate
        cls.evaluate = staticmethod(evaluate)
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.transcript = self.root / "session.jsonl"
        self.transcript.write_text("")
        self.cfg = self.root / "recall.json"
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.cfg.write_text(json.dumps({"url": self.url}))
        self.env = {**os.environ, "HOME": str(self.root), "RECALL_PLUGIN_CONFIG": str(self.cfg),
                    "RECALL_HOOK_STATE": str(self.root / "state.db"), "RECALL_HOOK_LOG": str(self.root / "log.jsonl"),
                    "T3_CONTROL_URL": self.url, "T3_CONTROL_TOKEN": "fixture-not-secret", "ROBOB_PROVIDER_INSTANCE_ID": "fixture"}
        from test_recall_rules import RulesFixture
        index = RulesFixture(self.root).index()
        index.remember('Keep PR comments brief.', actions=['comment'], source_session='owner')
        self.env['RECALL_RULES_DB'] = str(index.path)
        # Adapter tests below exercise the dormant rule path; the default is off.
        self.env['RECALL_RULE_PREFLIGHT'] = '1'
        self.flag = patch.dict(os.environ, RECALL_RULE_PREFLIGHT='1')  # in-process fixture engine
        self.flag.start()
        self.env.pop("CODEX_THREAD_ID", None)
        self.server.requests, self.server.identity_calls, self.server.recall_runs = [], [], []
        self.server.real_engine, self.server.engine_results = False, []
        self.server.delay, self.server.notes, self.server.cited = 0, False, True

    def tearDown(self):
        self.flag.stop()
        self.tmp.cleanup()

    def event(self, kind="UserPromptSubmit", **values):
        return {"hook_event_name": kind, "session_id": "native-fixture", "cwd": "/fixture/trading-core",
                "transcript_path": str(self.transcript), "prompt": "Investigate the deployment", "prompt_id": "p1",
                "tool_name": "Bash", "tool_use_id": "call1", "tool_input": {"command": "git status"}, **values}

    def call(self, harness="claude", **event):
        result = subprocess.run([sys.executable, str(HOOK), "--harness", harness], input=json.dumps(self.event(**event)),
                                env=self.env, text=True, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        return json.loads(result.stdout)["hookSpecificOutput"] if result.stdout.strip() else None

    def test_default_hooks_never_deny_or_note_from_the_rule_index(self):
        from test_recall_project import Layouts
        repos = Layouts(self.root / "layouts")
        self.env.pop('RECALL_RULE_PREFLIGHT')
        os.environ.pop('RECALL_RULE_PREFLIGHT')
        self.server.real_engine = True
        cases = [(str(repos.fork), "git push origin HEAD:main"),
                 (str(repos.checkout), "git push origin HEAD:refs/heads/main"),
                 (str(self.root), f"cd {repos.checkout} && git push --dry-run origin HEAD:main"),
                 # Denied by the fixture corpus when the flag is on.
                 ("/Users/test/trading-core", "git push origin HEAD:main")]
        for harness in ("claude", "codex"):
            for cwd, command in cases:
                with self.subTest(harness=harness, command=command):
                    self.assertIsNone(self.call(harness, kind="PreToolUse", cwd=cwd, tool_input={"command": command}))
                    self.assertIsNone(self.call(harness, kind="PostToolUse", cwd=cwd, tool_input={"command": command}))
        self.assertEqual([], self.server.requests)

    def test_acceptance_real_native_adapters(self):
        for harness in ("claude", "codex"):
            with self.subTest(harness=harness):
                blocked = self.call(harness, kind="PreToolUse", tool_input={"command": "git push origin HEAD:main"})
                self.assertEqual(blocked["permissionDecision"], "deny")
                self.assertIn("main-dev", blocked["permissionDecisionReason"])
                self.assertIsNone(self.call(harness, kind="PreToolUse", tool_input={"command": "git push origin HEAD:main-dev"}))
                before = len(self.server.recall_runs)
                self.assertIsNone(self.call(harness, kind="PreToolUse", tool_input={"command": "git status"}))
                self.assertEqual(len(self.server.recall_runs), before)
                self.assertEqual([r["arguments"]["command"] for r in self.server.requests], ["git push origin HEAD:main-dev"] * (1 if harness == "claude" else 2))

    def test_acceptance_real_corpus_to_claude_and_codex_adapters(self):
        self.server.real_engine = True
        for harness in ("claude", "codex"):
            with self.subTest(harness=harness):
                denied = self.call(harness, kind="PreToolUse", cwd="/Users/test/trading-core", tool_input={"command": "git push origin HEAD:main"})
                self.assertEqual(denied["permissionDecision"], "deny")
                self.assertIn("push to main-dev", denied["permissionDecisionReason"])
                self.assertIn("SKILL.md#L7", denied["permissionDecisionReason"])
                allowed = self.call(harness, kind="PreToolUse", cwd="/Users/test/trading-core", tool_input={"command": "git push origin HEAD:main-dev"})
                self.assertNotEqual((allowed or {}).get("permissionDecision"), "deny")
                before = len(self.server.engine_results)
                self.assertIsNone(self.call(harness, kind="PreToolUse", cwd="/Users/test/trading-core", tool_input={"command": "git status"}))
                self.assertEqual(len(self.server.engine_results), before)

    def test_standalone_native_tool_checks_rules_without_guessed_history_identity(self):
        self.server.real_engine = True
        self.env.pop("T3_CONTROL_TOKEN")
        for harness in ("claude", "codex"):
            denied = self.call(harness, kind="PreToolUse", cwd="/Users/test/trading-core", tool_input={"command": "git push origin HEAD:main"})
            self.assertEqual(denied["permissionDecision"], "deny")
            self.assertIn("main-dev", denied["permissionDecisionReason"])
            self.assertEqual(self.server.requests, [])
            self.assertEqual(self.server.identity_calls, [])

    def test_uncited_service_cannot_override_cited_local_deny(self):
        self.server.cited = False
        for harness in ("claude", "codex"):
            result = self.call(harness, kind="PreToolUse", tool_input={"command": "git push origin HEAD:main"})
            self.assertEqual(result["permissionDecision"], "deny")

    def test_first_once_across_processes_and_later_turns(self):
        self.assertIn("additionalContext", self.call())
        self.assertIsNone(self.call())
        self.assertIsNone(self.call(prompt_id="p2", prompt="Investigate another thing"))
        self.assertEqual([r["trigger"] for r in self.server.requests], ["first_prompt"])

    def test_old_or_missing_transcript_does_not_request(self):
        self.transcript.write_text(json.dumps({"type": "assistant", "message": {"role": "assistant", "content": "old"}}) + "\n")
        self.assertIsNone(self.call())
        self.transcript.unlink()
        self.assertIsNone(self.call(session_id="missing-transcript"))
        self.assertEqual(self.server.requests, [])

    def test_children_board_first_skip_but_outward_checks_remain(self):
        for prompt in ("You are a subagent spawned by another session", 'You are the reviewer for a card on the "Example" Missions board.', 'You are an evaluator on the "Example" Missions board.'):
            self.assertIsNone(self.call(session_id=prompt[:20], prompt=prompt))
        self.assertEqual(self.server.requests, [])
        self.assertIn("permissionDecision", self.call(kind="PreToolUse", agent_id="child", tool_input={"command": "git push origin HEAD:main"}))

    def test_compaction_each_generation_once(self):
        self.call()
        self.server.requests.clear()
        for count in range(2):
            self.assertIsNone(self.call(kind="PreCompact"))
            self.assertIn("additionalContext", self.call(kind="SessionStart", source="compact"))
            self.assertIsNone(self.call(kind="PostToolUse"))
        requests = self.server.requests
        self.assertEqual([r["trigger"] for r in requests], ["compaction", "compaction"])
        self.assertNotEqual(requests[0]["compaction_id"], requests[1]["compaction_id"])

    def test_codex_postcompact_defers_context_to_next_tool(self):
        self.call("codex")
        self.server.requests.clear()
        self.assertIsNone(self.call("codex", kind="PreCompact"))
        self.assertIsNone(self.call("codex", kind="PostCompact"))
        self.assertEqual(self.server.requests, [])
        self.assertIn("additionalContext", self.call("codex", kind="PostToolUse"))
        self.assertEqual([r["trigger"] for r in self.server.requests], ["compaction"])

    def test_codex_allowed_tool_note_delivers_posttool_without_new_check(self):
        self.server.notes = True
        self.assertIsNone(self.call("codex", kind="PreToolUse", tool_input={"command": "gh pr comment 1 --body hello"}))
        self.assertIn("additionalContext", self.call("codex", kind="PostToolUse"))
        self.assertIsNone(self.call("codex", kind="PostToolUse"))
        self.assertEqual(len(self.server.requests), 1)

    def test_real_engine_local_calls_emit_nothing_on_both_harnesses(self):
        self.server.real_engine = True
        for harness in ("claude", "codex"):
            for tool, args in (("Bash", {"command": "echo ok"}), ("Bash", {"command": "ls"}),
                               ("Read", {"file_path": "README"}), ("Edit", {"file_path": "README", "new_string": "hello"})):
                self.assertIsNone(self.call(harness, kind="PreToolUse", tool_name=tool, tool_input=args))
                self.assertIsNone(self.call(harness, kind="PostToolUse", tool_name=tool, tool_input=args))
        self.assertTrue(all(not r["recall_ran"] and not r["note"] for r in self.server.engine_results))

    def test_local_and_unknown_tools_without_candidates_skip_server(self):
        for tool in ("Read", "Glob", "Grep", "Edit", "mcp__generic__execute", "functions.execute"):
            self.assertIsNone(self.call(kind="PreToolUse", tool_name=tool))
        self.assertEqual(self.server.requests, [])
        for tool in ("mcp__generic__execute", "functions.execute"):
            self.assertIsNone(self.call(kind="PreToolUse", tool_name=tool, tool_input={"code":"run()"}))
        self.assertEqual(self.server.requests, [])

    def test_no_periodic_work_or_posttool_requests(self):
        for _ in range(12):
            self.assertIsNone(self.call(kind="PostToolUse", tool_input={"command": "failed tool"}))
        self.assertEqual(self.server.requests, [])
        self.assertEqual(self.server.identity_calls, [])

    def test_deadline_is_terminal_for_first_prompt(self):
        self.server.delay = 0.7
        start = time.monotonic()
        self.assertIsNone(self.call())
        self.assertLess(time.monotonic() - start, 0.8)
        self.server.delay = 0
        self.assertIsNone(self.call())
        self.assertEqual(len(self.server.requests), 1)

    def test_optional_preaction_timeout_fails_open_within_two_seconds(self):
        self.server.delay = 3.3
        start = time.monotonic()
        self.assertIsNone(self.call(kind="PreToolUse", tool_input={"command": "gh pr comment 1 --body hello"}))
        # Optional notes must leave headroom under the native 2s timeout.
        self.assertLess(time.monotonic() - start, 2.0)

    def test_old_workers_cannot_run_against_new_state_schema(self):
        result = subprocess.run([sys.executable, str(HOOK), "--worker", "legacy-job"], env=self.env,
                                text=True, capture_output=True, timeout=2)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.server.requests, [])

    def test_claim_first_is_process_safe_and_has_no_ttl_reset(self):
        path = str(self.root / "latches.db")
        Store(path).close()
        def claim(_):
            db = Store(path)
            try:
                return db.claim_first("native", "task", True)
            finally:
                db.close()
        with ThreadPoolExecutor(max_workers=4) as pool:
            values = list(pool.map(claim, range(4)))
        self.assertEqual(sum(v is not None for v in values), 1)
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)

    def test_control_origin_rejects_credential_redirect_and_remote(self):
        for url in ("http://evil.example", "http://localhost@evil.example", "https://127.0.0.1", "http://127.0.0.1/path"):
            self.assertIsNone(hook.control_origin(url))


class RecallManifestTests(unittest.TestCase):
    def test_recall_triggers_for_both_generated_codex_homes(self):
        package = ROOT.parent / "harness-homes"
        spec = importlib.util.spec_from_file_location("generate_homes_for_recall", package / "generate_homes.py")
        generator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(generator)
        manifest = json.loads((package / "manifest.json").read_text())
        generator.validate_manifest(manifest)
        recall = [h for h in manifest["hooks"] if "/recall_hook.py" in h["command"]]
        claude = generator.claude_hooks(generator.hooks_for_harness(recall, "claude"))
        codex = generator.codex_hooks_json(generator.hooks_for_harness(recall, "codex"))["hooks"]
        self.assertEqual(codex, generator.codex_hooks_json(generator.hooks_for_harness(recall, "codex-cu"))["hooks"])
        self.assertEqual(set(claude), {"UserPromptSubmit", "PreToolUse", "PreCompact", "SessionStart", "PostToolUse", "PostToolUseFailure"})
        self.assertEqual(set(codex), {"UserPromptSubmit", "PreToolUse", "PreCompact", "PostCompact", "SessionStart", "PostToolUse"})
        for hook in recall:
            self.assertEqual(hook["timeoutSec"], 4 if hook["event"] == "PreToolUse" else 2)


class InstallerTests(unittest.TestCase):
    def test_dry_run_is_read_only_and_real_install_preserves_mode_with_backups(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "recall.json"
            config.write_text(json.dumps({"mode": "observe", "wait_ms": 12000, "custom": "keep"}))
            plugin = root / "plugin/recall.ts"
            plugin.parent.mkdir()
            plugin.write_text("original")
            installer = ROOT / "plugin/install.zsh"
            before = sorted((str(p.relative_to(root)), p.read_bytes()) for p in root.rglob("*") if p.is_file())
            command = ["zsh", str(installer), "--config-dir", str(root)]
            result = subprocess.run(command + ["--dry-run"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(before, sorted((str(p.relative_to(root)), p.read_bytes()) for p in root.rglob("*") if p.is_file()))
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            value = json.loads(config.read_text())
            self.assertEqual((value["mode"], value["custom"]), ("observe", "keep"))
            self.assertEqual((value["wait_ms"], value["timeout_ms"], value["preaction_ms"]), (500, 500, 3000))
            self.assertFalse(value["work"])
            self.assertEqual(plugin.read_bytes(), (ROOT / "plugin/recall.ts").read_bytes())
            self.assertEqual(len(list(root.glob("recall.json.bak-*"))), 1)
            self.assertEqual(len(list(plugin.parent.glob("recall.ts.bak-*"))), 1)
            skill = ROOT / "skill/remember-this-next-time/SKILL.md"
            if skill.exists():
                self.assertEqual((root / "skills/remember-this-next-time/SKILL.md").read_bytes(), skill.read_bytes())


if __name__ == "__main__":
    unittest.main()
