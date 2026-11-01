"""Native hook contract tests: all HTTP and state are isolated fixtures."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / "hooks/recall_hook.py"
sys.path.insert(0, str(ROOT / "src"))
spec = importlib.util.spec_from_file_location("native_recall_hook", HOOK)
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)
from recall_hook_state import Store


class FixtureHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path == "/credential-sink":
            self.server.redirected.append(self.headers.get("Authorization"))
            self.send_response(204)
            self.end_headers()
            return
        query = parse_qs(urlsplit(self.path).query)
        self.server.queries.append(query)
        self.server.authorizations.append(self.headers.get("Authorization"))
        if self.server.redirect:
            self.send_response(302)
            self.send_header("Location", self.server.redirect)
            self.end_headers()
            return
        driver = query["driver"][0]
        child = "agentId" in query or query["nativeId"][0] == "codex-child"
        value = {"identity": {"resolution": self.server.resolution,
            "robobThreadId": "child" if child else "root", "rootThreadId": "root",
            "parentThreadId": "root" if child else None,
            "executionKind": "provider-native-child" if child else "top-level",
            "driver": driver, "providerInstanceId": "cu" if driver == "codex" else "claude-instance"}}
        data = json.dumps(value).encode()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        self.server.requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
        data = json.dumps(self.server.answer).encode()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(data)


class RecallHookTests(unittest.TestCase):
    def setUp(self):
        base = ROOT / "tmp-recall-hook-tests"
        base.mkdir(exist_ok=True)
        self.tmp = Path(tempfile.mkdtemp(dir=base))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
        self.server.requests, self.server.queries = [], []
        self.server.authorizations, self.server.redirected, self.server.redirect = [], [], None
        self.server.resolution = "resolved"
        self.server.answer = {"note": "past fact", "sources": [{"session_id": "old"}]}
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.config_file = self.tmp / "recall.json"
        self.config_file.write_text("{}")
        self.state_file = self.tmp / "state.db"
        self.env = {"HOME": str(self.tmp), "T3_CONTROL_URL": self.url, "T3_CONTROL_TOKEN": "dummy-control-token",
                    "RECALL_INJECT_URL": self.url + "/api/inject", "RECALL_HOOK_STATE": str(self.state_file),
                    "RECALL_PLUGIN_CONFIG": str(self.config_file)}
        self.env_patch = mock.patch.dict(os.environ, self.env, clear=True)
        self.env_patch.start()
        self.jobs = []

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.env_patch.stop()
        shutil.rmtree(self.tmp)
        try:
            self.tmp.parent.rmdir()
        except OSError:
            pass

    def event(self, name="UserPromptSubmit", harness="claude", **extra):
        event = {"hook_event_name": name, "session_id": "native-root", "cwd": "/work/repo",
                 "prompt_id" if harness == "claude" else "turn_id": "turn-1"}
        if name == "UserPromptSubmit":
            event["prompt"] = "Investigate the old deployment failure"
        return {**event, **extra}

    def call(self, event, harness="claude", now=1000):
        out = io.StringIO()
        def start(job, kind="work"):
            if kind == "prompt":
                hook.worker(job)
            else:
                self.jobs.append(job)
        with mock.patch.object(hook.time, "time", return_value=now), \
             mock.patch.object(hook, "launch", side_effect=start), \
             contextlib.redirect_stdout(out):
            hook.handle(harness, event)
        return json.loads(out.getvalue()) if out.getvalue() else None

    def state(self, identity=None):
        identity = identity or {"driver": "claudeAgent", "providerInstanceId": "claude-instance",
                                "robobThreadId": "root", "_agent": None}
        db = Store(str(self.state_file))
        try:
            return db.get(hook.key_of(identity))
        finally:
            db.close()

    def work(self, steps, start=1100, harness="claude", **extra):
        for i in range(steps):
            self.call(self.event("PostToolUse", harness, tool_name="Bash", tool_use_id=f"{start}-{i}",
                                 tool_input={"command": "make thing"}, tool_response="ok", **extra),
                      harness, start + i * 3)

    def test_prompt_subprocess_exact_body_and_wrapped_json(self):
        process = subprocess.run([sys.executable, str(HOOK), "--harness", "claude"],
            input=json.dumps(self.event()), text=True, capture_output=True, env=os.environ, timeout=5)
        self.assertEqual(process.returncode, 0)
        self.assertEqual(process.stderr, "")
        self.assertEqual(json.loads(process.stdout), {"hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit", "additionalContext": "<recall>\npast fact\n</recall>"}})
        self.assertEqual(self.server.requests, [{"mode": "prompt", "prompt": "Investigate the old deployment failure",
            "session_id": "root", "parent_id": None, "cwd": "/work/repo", "context": "",
            "known": [], "already": [], "timeout": 12, "caller_thread": "root",
            "caller_native": "native-root", "caller_driver": "claudeAgent", "caller_agent": None}])

    def test_prompt_gates_resolve_children_automation_and_duplicates(self):
        self.server.resolution = "pending"
        self.assertIsNone(self.call(self.event()))
        self.server.resolution = "resolved"
        self.assertIsNone(self.call(self.event(agent_id="a1")))
        for prompt in ("/compact", "ok", "[coord] 1 unacked delivery for lane x",
                       "This session is being continued from a previous conversation"):
            self.assertIsNone(self.call(self.event(prompt=prompt)))
        self.assertEqual(len(self.server.requests), 0)
        self.assertIsNotNone(self.call(self.event()))
        self.assertIsNone(self.call(self.event()))
        self.assertEqual(len(self.server.requests), 1)

    def test_parallel_batch_counts_one_and_dedupes_tool_id(self):
        self.call(self.event())
        for i in range(8):
            self.call(self.event("PostToolUse", tool_use_id=f"t{i}", tool_name="Bash"), now=1100 + i / 10)
        self.call(self.event("PostToolUse", tool_use_id="t7", tool_name="Bash"), now=1110)
        self.assertEqual(self.state()["calls"], 1)
        self.assertEqual(self.jobs, [])

    def test_distinct_failure_signatures_keep_only_safe_diagnostic_markers(self):
        self.call(self.event())
        self.call(self.event("PostToolUseFailure", tool_use_id="err-a", tool_name="Bash",
                             error="ECONNREFUSED password=fixtureSuperSecret"), now=1100)
        self.call(self.event("PostToolUseFailure", tool_use_id="err-b", tool_name="Bash",
                             error="ModuleNotFoundError token=fixtureOtherSecret"), now=1103)
        errors = self.state()["errors"]
        self.assertNotEqual(errors[-2][0], errors[-1][0])
        self.assertIn("ECONNREFUSED", errors[-2][1])
        self.assertIn("ModuleNotFoundError", errors[-1][1])
        self.assertNotIn("fixture", json.dumps(errors))

    def test_first_work_mailbox_next_hook_and_known_cited(self):
        self.call(self.event())
        self.work(8)
        self.assertEqual(len(self.jobs), 1)
        hook.worker(self.jobs.pop())
        body = self.server.requests[-1]
        self.assertEqual(body["mode"], "work")
        self.assertEqual(body["known"], ["past fact"])
        self.assertEqual(body["already"], ["old"])
        self.assertEqual(body["session_id"], "root")
        self.assertIn("[tool input omitted]", body["activity"])
        self.assertIn("[tool output omitted]", body["activity"])
        self.assertNotIn("make thing", body["activity"])
        output = self.call(self.event("PostToolUse", tool_use_id="next"), now=1200)
        self.assertEqual(output["hookSpecificOutput"]["additionalContext"], "<recall>\npast fact\n</recall>")
        self.assertIsNone(self.call(self.event("PostToolUse", tool_use_id="next2"), now=1201))

    def test_stale_work_result_and_pending_cannot_cross_turns(self):
        self.call(self.event())
        self.work(8)
        job = self.jobs.pop()
        self.call(self.event(prompt_id="turn-2", prompt="Please investigate another task"), now=1130)
        hook.worker(job)
        self.assertIsNone(self.call(self.event("PostToolUse", prompt_id="turn-2", tool_use_id="x"), now=1140))
        self.assertEqual(self.state()["task"], "Please investigate another task")

    def test_superseded_prompt_cannot_consume_its_previously_queued_note(self):
        self.config_file.write_text(json.dumps({"wait_ms": 0}))
        self.call(self.event())
        self.assertIsNone(self.call(self.event(prompt_id="turn-2", prompt="Investigate another task"), now=1010))
        out = self.call(self.event("PostToolUse", prompt_id="turn-2", tool_use_id="new"), now=1020)
        self.assertIn("past fact", out["hookSpecificOutput"]["additionalContext"])

    def test_failed_prompt_resolution_quarantines_only_matching_native_identity(self):
        for harness in ("claude", "codex"):
            with self.subTest(harness=harness):
                self.config_file.write_text(json.dumps({"wait_ms": 0}))
                parent = self.event(harness=harness, session_id=f"native-{harness}")
                child = self.event(harness=harness, session_id=f"native-{harness}",
                                   agent_id="agent-other" if harness == "claude" else "codex-child")
                self.call(parent, harness)
                self.call(child, harness)
                self.work(8, harness=harness, session_id=f"native-{harness}")
                job = self.jobs.pop()
                hook.worker(job)
                self.server.resolution = "pending"
                next_prompt = {**parent, "prompt": "Investigate the next task",
                               ("prompt_id" if harness == "claude" else "turn_id"): "turn-2"}
                self.assertIsNone(self.call(next_prompt, harness, now=1200))
                self.server.resolution = "resolved"
                tool = self.event("PostToolUse", harness, session_id=f"native-{harness}", tool_use_id="later")
                tool.pop("prompt_id" if harness == "claude" else "turn_id")
                self.assertIsNone(self.call(tool, harness, now=1210))
                self.assertIsNone(self.call(tool, harness, now=1213))
                # The other agent's active state was not quarantined.
                child_identity = {"driver": "claudeAgent" if harness == "claude" else "codex",
                                  "providerInstanceId": "claude-instance" if harness == "claude" else "cu",
                                  "robobThreadId": "child", "_agent": "agent-other" if harness == "claude" else None}
                self.assertFalse(self.state(child_identity).get("invalidated", False))
                # A later prompt which resolves may start a fresh turn normally.
                out = self.call(next_prompt, harness, now=1220)
                self.assertIsNone(out)  # wait_ms=0 leaves the new note queued
                tool["tool_use_id"] = "new"
                self.assertIn("past fact", self.call(tool, harness, now=1230)["hookSpecificOutput"]["additionalContext"])

    def test_prompt_guard_blocks_tools_while_identity_lookup_is_in_flight(self):
        self.config_file.write_text(json.dumps({"wait_ms": 0}))
        self.call(self.event())
        actual_resolve = hook.resolve
        def pending_resolve(harness, event):
            if event.get("hook_event_name") == "UserPromptSubmit":
                tool = self.event("PostToolUse", tool_use_id="during-lookup")
                tool.pop("prompt_id")
                self.assertIsNone(self.call(tool, now=1010))
                return None
            return actual_resolve(harness, event)
        with mock.patch.object(hook, "resolve", side_effect=pending_resolve):
            self.assertIsNone(self.call(self.event(prompt_id="turn-2"), now=1005))
        self.assertNotIn("during-lookup", self.state()["seen_tools"])

    def test_tool_content_is_never_persisted_or_sent_in_work_payload(self):
        self.call(self.event())
        dummy_secrets = ["dummy-password-abc", "dummy-otp-741983", "dummy-token-qwerty",
                         "dummy-output-secret", "dummy-raw-code-390872"]
        self.call(self.event("PostToolUseFailure", tool_use_id="private", tool_name="Bash",
                             tool_input={"password": dummy_secrets[0], "otpCode": dummy_secrets[1],
                                         "nested": {"accessToken": dummy_secrets[2]}},
                             tool_response="error: " + " ".join(dummy_secrets[3:])), now=1100)
        self.work(7, start=1103)
        hook.worker(self.jobs.pop())
        self.assertEqual(self.server.requests[-1]["mode"], "work")
        self.assertEqual(self.server.requests[-1]["errors"][0], "Bash: tool failure")
        db = sqlite3.connect(self.state_file)
        try:
            persisted = " ".join(str(cell) for table in ("sessions", "jobs", "notes", "mailbox", "seeds")
                                 for row in db.execute(f"SELECT * FROM {table}") for cell in row)
        finally:
            db.close()
        for secret in dummy_secrets:
            self.assertNotIn(secret, persisted)
            self.assertNotIn(secret, json.dumps(self.server.requests))

    def test_backoff_error_trigger_limit_and_compaction(self):
        self.server.answer = {"note": None, "sources": []}
        self.call(self.event())
        self.work(8)
        hook.worker(self.jobs.pop())
        self.assertEqual(self.state()["backoff"], 2)
        self.work(8, start=1200)
        self.assertFalse(self.jobs)
        self.work(2, start=1422)
        self.assertEqual(len(self.jobs), 1)
        hook.worker(self.jobs.pop())
        self.assertEqual(self.state()["backoff"], 4)
        # A new error after two steps and the shorter error interval triggers early.
        self.call(self.event("PostToolUseFailure", tool_use_id="err", tool_name="Bash", error="panic: x"), now=1790)
        self.call(self.event("PostToolUse", tool_use_id="after", tool_name="Bash"), now=1793)
        self.assertEqual(len(self.jobs), 1)
        hook.worker(self.jobs.pop())
        self.assertEqual(self.state()["backoff"], 8)
        self.work(8, start=3000)
        hook.worker(self.jobs.pop())
        self.assertEqual(self.state()["backoff"], 8)
        self.config_file.write_text(json.dumps({"work_max_checks": 4}))
        self.work(8, start=5000)
        self.assertFalse(self.jobs)

    def test_observe_off_dirs_and_errors_never_print(self):
        self.config_file.write_text(json.dumps({"mode": "off"}))
        self.assertIsNone(self.call(self.event()))
        self.assertFalse(self.state_file.exists())
        self.config_file.write_text(json.dumps({"mode": "on", "only_dirs": ["/other"]}))
        self.assertIsNone(self.call(self.event()))
        self.config_file.write_text(json.dumps({"mode": "observe"}))
        self.assertIsNone(self.call(self.event()))
        self.work(8)
        hook.worker(self.jobs.pop())
        self.assertIsNone(self.call(self.event("PostToolUse", tool_use_id="later"), now=1200))
        self.assertEqual(len(self.server.requests), 2)
        self.server.shutdown()
        process = subprocess.run([sys.executable, str(HOOK), "--harness", "codex"],
            input=json.dumps(self.event(harness="codex")), text=True, capture_output=True,
            env=os.environ, timeout=5)
        self.assertEqual((process.returncode, process.stdout, process.stderr), (0, "", ""))
        self.assertIn("hook:", (self.tmp / "hook.log").read_text())

    def test_codex_identity_uses_agent_concrete_id_and_child_seed(self):
        # Codex emits SubagentStart from the child without a task field.
        transcript = self.tmp / "codex-child.jsonl"
        transcript.write_text(json.dumps({"type": "event_msg", "payload":
                                         {"type": "user_message", "message": "Find the earlier exception"}}) + "\n")
        self.assertIsNone(self.call(self.event("SubagentStart", "codex", agent_id="codex-child",
                                              transcript_path=str(transcript)), "codex"))
        self.assertNotIn("agentId", self.server.queries[-1])
        child_event = self.event("PostToolUse", "codex", agent_id="codex-child", tool_use_id="t1",
                                 transcript_path=str(transcript))
        self.assertIsNone(self.call(child_event, "codex", now=1100))
        self.assertEqual(self.server.queries[-1]["nativeId"], ["codex-child"])
        identity = {"driver": "codex", "providerInstanceId": "cu", "robobThreadId": "child", "_agent": None}
        self.assertEqual(self.state(identity)["task"], "Find the earlier exception")
        self.assertEqual(self.state(identity)["calls"], 1)

    def test_omitted_turn_id_delivers_only_active_mailbox(self):
        self.call(self.event())
        self.work(8)
        hook.worker(self.jobs.pop())
        event = self.event("PostToolUse", tool_name="Bash", tool_use_id="no-prompt-id")
        event.pop("prompt_id")
        self.assertIn("past fact", self.call(event, now=1200)["hookSpecificOutput"]["additionalContext"])

    def test_subagent_no_task_does_not_invent_one_and_retries_transcript(self):
        transcript = self.tmp / "claude.jsonl"
        transcript.write_text("")
        start = {"hook_event_name": "SubagentStart", "session_id": "native-root", "cwd": "/work/repo",
                 "agent_id": "agent-abc", "agent_type": "Explore", "transcript_path": str(transcript)}
        self.call(start)
        child = {"hook_event_name": "PostToolUse", "session_id": "native-root", "cwd": "/work/repo",
                 "agent_id": "agent-abc", "transcript_path": str(transcript),
                 "tool_name": "Bash", "tool_input": {"command": "echo hi"}, "tool_use_id": "x"}
        self.call(child, now=1100)
        ident = {"driver": "claudeAgent", "providerInstanceId": "claude-instance", "robobThreadId": "child", "_agent": "agent-abc"}
        self.assertEqual(self.state(ident)["task"], "")
        transcript.write_text(json.dumps({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Agent", "input": {"resume": "agent-abc", "prompt": "Find the old logs"}}]}}) + "\n")
        self.call({**child, "tool_use_id": "y"}, now=1103)
        self.assertEqual(self.state(ident)["task"], "Find the old logs")

    def test_prompt_wait_timeout_then_next_hook_delivers_once(self):
        self.config_file.write_text(json.dumps({"wait_ms": 0}))
        self.assertIsNone(self.call(self.event()))
        # call() runs the prompt worker before returning, but wait_ms=0 leaves
        # its completed result in the mailbox for the next same-turn event.
        out = self.call(self.event("PostToolUse", tool_use_id="later"), now=1100)
        self.assertIn("past fact", out["hookSpecificOutput"]["additionalContext"])
        self.assertIsNone(self.call(self.event("PostToolUse", tool_use_id="later2"), now=1103))

    def test_concurrent_tool_processes_are_serialized(self):
        self.call(self.event(), now=time.time())
        def one(n):
            return subprocess.run([sys.executable, str(HOOK), "--harness", "claude"],
                input=json.dumps(self.event("PostToolUse", tool_name="Bash", tool_use_id=f"c{n}")),
                text=True, capture_output=True, env=os.environ, timeout=6)
        with ThreadPoolExecutor(max_workers=8) as executor:
            results = list(executor.map(one, range(8)))
        self.assertTrue(all(x.returncode == 0 and not x.stdout and not x.stderr for x in results))
        self.assertEqual(len(self.state()["seen_tools"]), 8)
        self.assertEqual(self.state()["calls"], 1)

    def test_skipped_prompt_invalidates_slow_jobs_and_queued_notes(self):
        for i, prompt in enumerate(("ok", "/compact", "[coord] 1 unacked delivery for lane x")):
            with self.subTest(prompt=prompt):
                n = i * 1000
                self.call(self.event(prompt_id=f"old-{i}"), now=1000 + n)
                self.work(8, start=1100 + n, prompt_id=f"old-{i}")
                job = self.jobs.pop()
                self.call(self.event(prompt_id=f"skip-{i}", prompt=prompt), now=1130 + n)
                count = len(self.server.requests)
                hook.worker(job)
                self.assertEqual(len(self.server.requests), count)
                self.assertIsNone(self.call(self.event("PostToolUse", prompt_id=f"skip-{i}",
                                                      tool_use_id=f"next-{i}"), now=1140 + n))
                self.assertEqual(self.state()["task"], "")
                self.assertEqual(len(self.server.requests), count)

    def test_provisional_turn_adopts_real_id_and_rejects_stale_events(self):
        self.config_file.write_text(json.dumps({"wait_ms": 0}))
        prompt = self.event()
        prompt.pop("prompt_id")
        self.call(prompt)
        out = self.call(self.event("PostToolUse", prompt_id="real-1", tool_use_id="x"), now=1100)
        self.assertIn("past fact", out["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(self.state()["turn"], "real-1")
        self.assertFalse(self.state()["provisional"])
        self.call(self.event(prompt_id="real-2", prompt="Investigate a new problem"), now=1110)
        self.assertIsNone(self.call(self.event("PostToolUse", prompt_id="real-1", tool_use_id="stale"), now=1111))
        self.assertNotIn("stale", self.state()["seen_tools"])

    def test_provisional_inflight_job_follows_adopted_turn(self):
        self.config_file.write_text(json.dumps({"wait_ms": 0}))
        prompt = self.event()
        prompt.pop("prompt_id")
        with mock.patch.object(hook, "launch", side_effect=lambda job, kind="work": self.jobs.append(job)):
            hook.handle("claude", prompt)
        job = self.jobs.pop()
        self.call(self.event("PostToolUse", prompt_id="native-turn", tool_use_id="x"), now=time.time())
        hook.worker(job)
        out = self.call(self.event("PostToolUse", prompt_id="native-turn", tool_use_id="y"), now=time.time())
        self.assertIn("past fact", out["hookSpecificOutput"]["additionalContext"])

    def test_skipped_prompt_without_id_rejects_previous_native_turn(self):
        self.call(self.event())
        skipped = self.event(prompt="ok")
        skipped.pop("prompt_id")
        self.call(skipped, now=1010)
        self.assertIsNone(self.call(self.event("PostToolUse", tool_use_id="old"), now=1020))
        self.assertTrue(self.state()["provisional"])
        self.assertNotIn("old", self.state()["seen_tools"])
        self.call(self.event("PostToolUse", prompt_id="new-native", tool_use_id="new"), now=1023)
        self.assertEqual(self.state()["turn"], "new-native")

    def test_late_prompt_note_is_consumed_when_work_disabled(self):
        self.config_file.write_text(json.dumps({"wait_ms": 0, "work": False}))
        self.assertIsNone(self.call(self.event()))
        out = self.call(self.event("PostToolUse", tool_use_id="x"), now=1100)
        self.assertIn("past fact", out["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(self.state()["calls"], 0)
        self.assertIsNone(self.call(self.event("PostToolUse", tool_use_id="y"), now=1103))

    def test_fresh_claude_child_task_retries_pending_start_and_late_transcript(self):
        parent = self.tmp / "native-root.jsonl"
        parent.write_text("")
        child_path = self.tmp / "native-root" / "subagents" / "agent-agent-abc.jsonl"
        child_path.parent.mkdir(parents=True)
        start = self.event("SubagentStart", agent_id="agent-abc", transcript_path=str(parent))
        self.server.resolution = "pending"
        self.call(start)
        self.server.resolution = "resolved"
        child = self.event("PostToolUse", agent_id="agent-abc", transcript_path=str(parent),
                           tool_use_id="first", tool_name="Bash")
        self.call(child, now=1100)
        ident = {"driver": "claudeAgent", "providerInstanceId": "claude-instance",
                 "robobThreadId": "child", "_agent": "agent-abc"}
        self.assertEqual(self.state(ident)["task"], "")
        child_path.write_text(json.dumps({"type": "user", "sessionId": "native-root",
            "agentId": "agent-abc", "isSidechain": True, "parentUuid": None,
            "message": {"role": "user", "content": "Find the old deploy failure"}}) + "\n")
        self.call({**child, "tool_use_id": "second"}, now=1103)
        self.assertEqual(self.state(ident)["task"], "Find the old deploy failure")
        self.work(6, start=1106, agent_id="agent-abc", transcript_path=str(parent))
        self.assertEqual(len(self.jobs), 1)
        hook.worker(self.jobs.pop())
        self.assertEqual(self.server.requests[-1]["prompt"], "Find the old deploy failure")
        self.assertEqual(self.server.requests[-1]["session_id"], "child")

    def test_claude_child_rejects_parent_or_other_agent_prompt(self):
        parent = self.tmp / "native-root.jsonl"
        parent.write_text(json.dumps({"type": "user", "message": {"role": "user", "content": "parent"}}) + "\n")
        child = self.tmp / "native-root" / "subagents" / "agent-agent-abc.jsonl"
        child.parent.mkdir(parents=True)
        for changes in ({"agentId": "other"}, {"sessionId": "other"}, {"isSidechain": False},
                        {"parentUuid": "not-root"}, {"message": {"role": "user", "content": [{"type": "tool_result", "content": "not a task"}]}}):
            entry = {"type": "user", "sessionId": "native-root", "agentId": "agent-abc",
                     "isSidechain": True, "parentUuid": None,
                     "message": {"role": "user", "content": "child task"}, **changes}
            child.write_text(json.dumps(entry) + "\n")
            self.assertIsNone(hook.transcript_task("claude", str(parent), "agent-abc", "native-root"))

    def test_control_token_only_uses_localhost_and_missing_token_fails_closed(self):
        event = self.event()
        with mock.patch.dict(os.environ, {"HOME": str(self.tmp), "T3_CONTROL_TOKEN": "dummy-control-token"}, clear=True), \
             mock.patch.object(hook.urllib.request, "build_opener") as build_opener:
            open_url = build_opener.return_value.open
            open_url.return_value.__enter__.return_value.read.return_value = json.dumps({"identity": {
                "resolution": "resolved", "robobThreadId": "root", "rootThreadId": "root",
                "executionKind": "top-level", "driver": "claudeAgent", "providerInstanceId": "claude-instance"}}).encode()
            self.assertIsNotNone(hook.resolve("claude", event))
            request = open_url.call_args.args[0]
            self.assertTrue(request.full_url.startswith("http://127.0.0.1:3773/"))
            self.assertEqual(request.get_header("Authorization"), "Bearer dummy-control-token")
        with mock.patch.dict(os.environ, {"HOME": str(self.tmp), "T3_CONTROL_URL": self.url}, clear=True), \
             mock.patch.object(hook.urllib.request, "build_opener") as open_url:
            self.assertIsNone(hook.resolve("claude", event))
            open_url.assert_not_called()

    def test_control_url_rejects_untrusted_origins_before_sending_token(self):
        remote_urls = ("http://example.com:3773", "https://localhost:3773", "http://127.0.0.2:3773",
                       "http://localhost.example.com", "http://localhost@evil.example",
                       "http://user@localhost:3773", "http://127.0.0.1:3773/path",
                       "http://[::ffff:127.0.0.1]:3773", "http://127.0.0.1:99999", "http://localhost:0")
        for url in remote_urls:
            with self.subTest(url=url), mock.patch.dict(os.environ, {"T3_CONTROL_URL": url}), \
                 mock.patch.object(hook.urllib.request, "build_opener") as opener:
                self.assertIsNone(hook.resolve("claude", self.event()))
                opener.assert_not_called()
        for url in ("http://localhost:3773", "http://127.0.0.1:3773/", "http://[::1]:3773"):
            self.assertEqual(hook.control_origin(url), url.rstrip("/"))

    def test_identity_resolution_never_follows_credentialed_redirect(self):
        sink = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
        sink.redirected = []
        thread = threading.Thread(target=sink.serve_forever, daemon=True)
        thread.start()
        try:
            self.server.redirect = f"http://127.0.0.1:{sink.server_port}/credential-sink"
            self.assertIsNone(hook.resolve("claude", self.event()))
            self.assertEqual(self.server.authorizations, ["Bearer dummy-control-token"])
            self.assertEqual(sink.redirected, [])
        finally:
            sink.shutdown()
            sink.server_close()
            thread.join()

    def test_unidentified_consecutive_turns_fail_closed_on_ambiguous_id(self):
        first = self.event()
        first.pop("prompt_id")
        self.call(first)
        second = self.event(prompt="ok")
        second.pop("prompt_id")
        self.call(second, now=1010)
        self.assertIsNone(self.call(self.event("PostToolUse", prompt_id="unknown-old", tool_use_id="stale"), now=1020))
        self.assertTrue(self.state()["adoption_blocked"])
        self.assertNotIn("stale", self.state()["seen_tools"])


class RecallManifestTests(unittest.TestCase):
    def test_harness_specific_events_cover_every_codex_home(self):
        package = ROOT.parent / "harness-homes"
        spec = importlib.util.spec_from_file_location("generate_homes_for_recall", package / "generate_homes.py")
        generator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(generator)
        manifest = json.loads((package / "manifest.json").read_text())
        generator.validate_manifest(manifest)
        claude = generator.claude_hooks(manifest["hooks"], "claude")
        codex = generator.codex_hooks_json(manifest["hooks"])["hooks"]
        self.assertEqual(set(claude), {"UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "SubagentStart"})
        self.assertEqual(set(codex), {"UserPromptSubmit", "PostToolUse", "SubagentStart"})
        self.assertEqual(manifest["homeHarnesses"]["codex-cu"], "codex")
        for event, groups in claude.items():
            self.assertTrue(all("--harness claude" in g["hooks"][0]["command"] for g in groups))
        for event, groups in codex.items():
            self.assertTrue(all("--harness codex" in g["hooks"][0]["command"] for g in groups))


if __name__ == "__main__":
    unittest.main()
