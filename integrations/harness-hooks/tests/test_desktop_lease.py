if __package__:
    from . import test_environment
else:
    import test_environment

import json
import fcntl
import os
from pathlib import Path
import socket
import select
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))
import desktop_lease
import engine


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        state = self.server.state
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        state["calls"].append((self.path, data))
        status, raw = state["status"], state["body"]
        outcomes = state.get("outcomes")
        if outcomes is not None:
            call_id = data["toolUseId"]
            if self.path.endswith("call-start"):
                outcomes.setdefault(call_id, None)
            elif self.path.endswith("call-end"):
                if outcomes.get(call_id) not in (None, data["outcome"]):
                    status, raw = 409, b'{"error":{"message":"Different outcome."}}'
                else:
                    outcomes[call_id] = data["outcome"]
        gate = state.get("gate")
        if gate and (state.get("hang_all") or len(state["calls"]) == 1):
            gate.wait(2)
        self.send_response(status)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        self.server.state["calls"].append((self.path, None))
        self.send_error(500)

    def log_message(self, *_):
        pass


class DesktopLeaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.state = {}
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
        self.server.state = dict(calls=[], status=200, body=b'{"lease":{},"queue":[]}')
        env = {"HARNESS_HOOKS_CONTROL_URL": f"http://127.0.0.1:{self.server.server_port}",
               "HARNESS_HOOKS_STATE_DIR": self.temp.name,
               "HARNESS_HOOKS_TOKEN_FILE": str(Path(self.temp.name) / "absent")}
        self.env = patch.dict(os.environ, env)
        self.env.start()
        self.addCleanup(self.env.stop)

    def event(self, tool="mcp__cua-driver__click", input=None, kind="PreToolUse"):
        return {"hook_event_name": kind, "tool_name": tool, "tool_input": input or {},
                "session_id": "parent-session", "agent_id": "child-id", "tool_use_id": "call-1"}

    def invoke(self, event, harness="claude", args=()):
        result = subprocess.run([sys.executable, str(SRC / (harness + ".py")), *args],
                                input=json.dumps(event), text=True, capture_output=True, timeout=8, check=True)
        self.assertEqual(result.stderr, "")
        return json.loads(result.stdout) if result.stdout else None

    def calls(self):
        return self.server.state["calls"]

    def last_row(self):
        return json.loads((Path(self.temp.name) / "decisions.jsonl").read_text().splitlines()[-1])

    def slow_server(self, hang_all=False):
        gate = threading.Event()
        self.addCleanup(gate.set)
        self.server.state.update(gate=gate, hang_all=hang_all)
        return gate

    def test_slow_first_attempt_retries_same_admission_and_logs_response_time(self):
        self.slow_server()
        with patch.object(desktop_lease, "START_ATTEMPT", 0.1), patch.object(desktop_lease, "START_BUDGET", 0.4):
            result = engine.decide(self.event(), "codex")
        self.assertEqual(result["decision"], "allow")
        self.assertEqual(len(self.calls()), 2)
        self.assertEqual(self.calls()[0], self.calls()[1])
        row = self.last_row()
        self.assertEqual((row["phase"], row["attempts"]), ("response", 2))
        first, second = row["attempt_timings"]
        self.assertEqual(first["error"], "TimeoutError")
        self.assertGreaterEqual(first["response_ms"], 80)
        self.assertLess(first["connect_ms"], 80)
        self.assertNotIn("error", second)

    def test_hanging_server_denies_within_total_budget_and_logs_attempts(self):
        self.slow_server(hang_all=True)
        with patch.object(desktop_lease, "START_ATTEMPT", 0.1), patch.object(desktop_lease, "START_BUDGET", 0.15):
            result = engine.decide(self.event(), "claude")
        self.assertEqual(result["decision"], "deny")
        self.assertEqual(result["reason"], desktop_lease.UNAVAILABLE)
        self.assertIn("Retry this call once", result["reason"])
        row = self.last_row()
        self.assertEqual((row["phase"], row["attempts"], row["error"]), ("response", 2, "TimeoutError"))
        self.assertTrue(row["error_message"])
        self.assertGreaterEqual(row["total_ms"], 140)
        self.assertLess(row["total_ms"], 350)

    def test_409_is_not_retried(self):
        self.server.state.update(status=409, body=b'{"error":{"message":"Not held."}}')
        self.assertEqual(engine.decide(self.event(), "codex")["decision"], "deny")
        self.assertEqual(len(self.calls()), 1)
        self.assertEqual(self.last_row()["attempts"], 1)

    def test_connection_refused_is_not_retried(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        with patch.dict(os.environ, {"HARNESS_HOOKS_CONTROL_URL": f"http://127.0.0.1:{port}"}):
            result = engine.decide(self.event(), "codex")
        self.assertEqual(result["decision"], "deny")
        row = self.last_row()
        self.assertEqual((row["attempts"], row["phase"]), (1, "connect"))
        self.assertEqual(row["error"], "ConnectionRefusedError")

    def test_slow_completion_is_bounded_and_retained_for_turn_end(self):
        self.assertIsNone(self.invoke(self.event(), "codex"))
        self.server.state["calls"].clear()
        gate = self.slow_server(hang_all=True)
        with patch.object(desktop_lease, "DEADLINE", 0.1):
            self.assertEqual(engine.decide(self.event(kind="PostToolUse"), "codex")["decision"], "allow")
        self.assertEqual(self.last_row()["attempts"], 1)
        self.assertEqual(self.last_row()["rule"], "desktop-end-error")
        gate.set()
        self.server.state.pop("gate")
        self.assertIsNone(self.invoke({"hook_event_name": "Stop", "session_id": "parent-session", "agent_id": "child-id"}, "codex"))
        self.assertEqual(self.calls()[-1][1]["outcome"], "completed")

    def test_lost_completion_reply_retries_the_committed_outcome_and_clears_pending(self):
        self.server.state["outcomes"] = {}
        for harness, kind, outcome in [("codex", "PostToolUse", "completed"),
                                       ("codex", "PostToolUse", "failed"),
                                       ("claude", "PostToolUse", "completed"),
                                       ("claude", "PostToolUseFailure", "failed")]:
            with self.subTest(harness=harness, outcome=outcome):
                call_id = harness + "-" + outcome
                event = {**self.event(), "tool_use_id": call_id}
                self.assertEqual(engine.decide(event, harness)["decision"], "allow")
                gate = self.slow_server(hang_all=True)
                completed = {**event, "hook_event_name": kind,
                             "tool_response": {"isError": outcome == "failed"}}
                with patch.object(desktop_lease, "DEADLINE", 0.1):
                    self.assertEqual(engine.decide(completed, harness)["decision"], "allow")
                self.assertEqual(self.server.state["outcomes"][call_id], outcome)
                gate.set()
                self.server.state.pop("gate")
                stop = {**event, "hook_event_name": "Stop"}
                engine.decide(stop, harness)
                self.assertEqual(self.calls()[-1][1], {"toolUseId": call_id, "outcome": outcome})
                self.assertEqual(self.last_row()["rule"], "desktop-flush")
                pending = desktop_lease._pending_file(self.temp.name, desktop_lease._native_key(event, harness))
                self.assertEqual(json.loads(pending.read_text()), {})
                before = len(self.calls())
                engine.decide(stop, harness)
                self.assertEqual(len(self.calls()), before)

    def test_legacy_pending_ids_still_close_as_failed(self):
        event = self.event()
        pending = desktop_lease._pending_file(self.temp.name, desktop_lease._native_key(event, "codex"))
        pending.parent.mkdir()
        pending.write_text('["old-call"]')
        engine.decide({**event, "hook_event_name": "Stop"}, "codex")
        self.assertEqual(self.calls()[-1][1], {"toolUseId": "old-call", "outcome": "failed"})
        self.assertEqual(json.loads(pending.read_text()), {})

    def test_other_process_cannot_overwrite_a_lost_completion_outcome(self):
        self.server.state["outcomes"] = {}
        event = self.event()
        self.assertIsNone(self.invoke(event, "codex"))
        # Hold the competing writer after its read, where an unlocked writer could save stale state.
        script = '''
import json, sys
sys.path.insert(0, sys.argv[1])
import desktop_lease
load = json.load
def paused(file):
    value = load(file)
    print("read", flush=True)
    sys.stdin.readline()
    return value
json.load = paused
desktop_lease._pending_update(sys.argv[2], "child-id", add="other-call")
'''
        writer = subprocess.Popen([sys.executable, "-I", "-c", script, str(SRC), self.temp.name],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertTrue(select.select([writer.stdout], [], [], 5)[0])
            self.assertEqual(writer.stdout.readline().strip(), "read")
            blocked = threading.Event()
            flock = fcntl.flock
            def observe_lock(*args):
                try:
                    return flock(*args)
                except BlockingIOError:
                    blocked.set()
                    raise
            gate = self.slow_server(hang_all=True)
            with patch.object(desktop_lease.fcntl, "flock", observe_lock), \
                    patch.object(desktop_lease, "PENDING_LOCK_WAIT", 2), \
                    patch.object(desktop_lease, "DEADLINE", 0.1), ThreadPoolExecutor() as pool:
                completion = pool.submit(engine.decide, self.event(kind="PostToolUse"), "codex")
                try:
                    self.assertTrue(blocked.wait(2), "completion must wait for the other process's update")
                finally:
                    writer.stdin.write("\n")
                    writer.stdin.flush()
                _, errors = writer.communicate(timeout=5)
                self.assertEqual(writer.returncode, 0, errors)
                self.assertEqual(completion.result(timeout=5)["decision"], "allow")
            pending = desktop_lease._pending_file(self.temp.name, "child-id")
            self.assertEqual(json.loads(pending.read_text()), {"call-1": "completed", "other-call": "failed"})
            self.assertEqual(self.server.state["outcomes"]["call-1"], "completed")
            gate.set()
            self.server.state.pop("gate")
            self.assertIsNone(self.invoke({**event, "hook_event_name": "Stop"}, "codex"))
            self.assertEqual(json.loads(pending.read_text()), {})
        finally:
            if writer.poll() is None:
                writer.communicate(input="\n", timeout=5)

    def test_completion_does_not_commit_if_its_outcome_cannot_be_saved(self):
        event = self.event()
        self.assertIsNone(self.invoke(event, "codex"))
        pending = desktop_lease._pending_file(self.temp.name, "child-id")
        with open(pending.with_suffix(".lock"), "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            with patch.object(desktop_lease, "PENDING_LOCK_WAIT", 0.02):
                engine.decide(self.event(kind="PostToolUse"), "codex")
            self.assertEqual(self.last_row()["rule"], "desktop-end-error")
            self.assertEqual(len(self.calls()), 1)
        self.assertIsNone(self.invoke({**event, "hook_event_name": "Stop"}, "codex"))
        self.assertEqual(self.calls()[-1][1]["outcome"], "failed")

    def test_registered_turn_end_hooks_retry_retained_completions(self):
        manifest = json.loads((SRC.parents[1] / "harness-homes" / "manifest.json").read_text())
        for harness in ("claude", "codex"):
            for kind in ("Stop", "SubagentStop", "SessionEnd"):
                with self.subTest(harness=harness, event=kind):
                    hooks = [h for h in manifest["hooks"] if h["harness"] == harness and h["event"] == kind
                             and "/harness-hooks/src/" in h["command"]]
                    self.assertEqual(len(hooks), 1)
                    self.assertTrue(hooks[0]["command"].endswith("/" + harness + ".py"))
                    event = {**self.event(), "tool_use_id": harness + "-" + kind}
                    self.assertIsNone(self.invoke(event, harness))
                    self.server.state.update(status=500, body=b'{}')
                    self.assertIsNone(self.invoke({**event, "hook_event_name": "PostToolUse"}, harness))
                    self.server.state.update(status=200, body=b'{}')
                    self.assertIsNone(self.invoke({**event, "hook_event_name": kind}, harness))
                    self.assertEqual(self.calls()[-1][1], {"toolUseId": event["tool_use_id"], "outcome": "completed"})
                    pending = desktop_lease._pending_file(self.temp.name, desktop_lease._native_key(event, harness))
                    self.assertEqual(json.loads(pending.read_text()), {})

    def test_start_budget_fits_both_desktop_hook_timeouts(self):
        manifest = json.loads((SRC.parents[1] / "harness-homes" / "manifest.json").read_text())
        hooks = [h for h in manifest["hooks"] if h["event"] == "PreToolUse" and "mcp__node_repl__js" in h.get("matcher", "")]
        self.assertEqual({h["harness"] for h in hooks}, {"claude", "codex"})
        for hook in hooks:
            self.assertGreaterEqual(hook["timeoutSec"] - desktop_lease.START_BUDGET, 6)

    def test_read_only_cua_and_plain_javascript_do_not_call_server(self):
        for tool, args in [("list_windows", {}), ("get_window_state", {}),
                           ("check_permissions", {}), ("check_permissions", {"prompt": False}),
                           ("browser_dialog", {"action": "inspect"}),
                           ("page", {"action": "get_text"}), ("page", {"action": "query_dom"})]:
            with self.subTest(tool=tool, args=args):
                self.assertEqual(engine.decide(self.event("mcp__cua_driver__" + tool, args), "claude")["decision"], "allow")
        self.assertIsNone(self.invoke(self.event("mcp__node_repl__js", {"code": "const x = 1; x + 1"}), "codex"))
        self.assertEqual(self.calls(), [])

    def test_actions_admit_with_exact_child_identity(self):
        for harness, expected in [("claude", {"driver": "claudeAgent", "nativeId": "parent-session", "agentId": "child-id", "toolUseId": "call-1"}),
                                  ("codex", {"driver": "codex", "nativeId": "child-id", "toolUseId": "call-1"})]:
            with self.subTest(harness=harness):
                self.assertIsNone(self.invoke(self.event(), harness))
                self.assertEqual(self.calls()[-1], ("/api/ardud/control/desktop-lease/call-start", expected))
        event = self.event()
        del event["agent_id"]
        self.assertIsNone(self.invoke(event, "codex"))
        self.assertEqual(self.calls()[-1][1]["nativeId"], "parent-session")

    def test_actions_include_unknown_and_state_changing_variants(self):
        for tool, args in [("future_action", {}), ("check_permissions", {"prompt": True}),
                           ("browser_dialog", {"action": "accept"}), ("page", {"action": "click"})]:
            self.assertEqual(engine.decide(self.event("mcp__cua-driver__" + tool, args), "claude")["decision"], "allow")
        self.assertEqual(len(self.calls()), 4)

    def test_desktop_js_including_comment_calls_start(self):
        for code in ['globalThis.sky = (await import("@oai/sky")).sky', "// sky.click\n1+1",
                     "SkyComputerUse", "computeruse.sock", "nativePipe", "launchServices"]:
            self.assertIsNone(self.invoke(self.event("mcp__node_repl__js", {"code": code}), "codex"))
        self.assertEqual(len(self.calls()), 6)

    def test_409_denies_exact_adapter_shapes(self):
        self.server.state.update(status=409, body=b'{"ok":false,"error":{"message":"Not held."}}')
        expected = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                           "permissionDecisionReason": desktop_lease.NO_LEASE + "Not held."}}
        for harness in ("claude", "codex"):
            self.assertEqual(self.invoke(self.event(), harness), expected)

    def test_outage_invalid_responses_missing_identity_all_deny(self):
        for status, body in [(500, b'{}'), (404, b'{}'), (200, b'not json'),
                             (200, b'{"ok":false}'), (409, b'not json')]:
            self.server.state.update(status=status, body=body)
            self.assertEqual(engine.decide(self.event(), "claude")["reason"], desktop_lease.UNAVAILABLE)
        self.server.state.update(status=200, body=b'{}')
        for field, value in [("tool_use_id", None), ("session_id", ""), ("agent_id", " ")]:
            event = self.event()
            event[field] = value
            before = len(self.calls())
            self.assertEqual(engine.decide(event, "claude")["decision"], "deny")
            self.assertEqual(len(self.calls()), before)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        with patch.dict(os.environ, {"HARNESS_HOOKS_CONTROL_URL": f"http://127.0.0.1:{port}"}):
            self.assertEqual(self.invoke(self.event(), "codex")["hookSpecificOutput"]["permissionDecisionReason"], desktop_lease.UNAVAILABLE)

    def test_completion_and_failure_are_silent_even_on_404_or_outage(self):
        cases = [("claude", "PostToolUse", {}, "completed"),
                 ("claude", "PostToolUseFailure", {}, "failed"),
                 ("codex", "PostToolUse", {"tool_response": {"isError": True}}, "failed"),
                 ("codex", "PostToolUse", {"tool_response": {"error": "bad"}}, "failed"),
                 ("codex", "PostToolUse", {"tool_response": {"isError": False}}, "completed")]
        for harness, kind, extra, outcome in cases:
            event = {**self.event(kind=kind), **extra}
            self.assertIsNone(self.invoke(event, harness))
            self.assertEqual(self.calls()[-1], ("/api/ardud/control/desktop-lease/call-end",
                                               {"toolUseId": "call-1", "outcome": outcome}))
        self.server.state.update(status=404, body=b'not-json')
        self.assertIsNone(self.invoke(self.event(kind="PostToolUse"), "codex"))
        self.server.state.update(status=500, body=b'{}')
        self.assertIsNone(self.invoke(self.event(kind="PostToolUseFailure"), "claude"))
        rows = [json.loads(line) for line in (Path(self.temp.name) / "decisions.jsonl").read_text().splitlines()]
        self.assertEqual(rows[-2]["rule"], "desktop-end")
        self.assertEqual(rows[-1]["rule"], "desktop-end-error")

    def test_codex_turn_end_closes_calls_that_never_got_post_tool_use(self):
        # Codex sends no PostToolUse when an MCP call fails, which used to leave the lease stuck in `stopping`.
        self.assertIsNone(self.invoke({**self.event(), "tool_use_id": "call-a"}, "codex"))
        self.assertIsNone(self.invoke({**self.event(), "tool_use_id": "call-b"}, "codex"))
        self.assertIsNone(self.invoke({**self.event(kind="PostToolUse"), "tool_use_id": "call-b"}, "codex"))
        before = len(self.calls())
        stop = {"hook_event_name": "Stop", "session_id": "parent-session", "agent_id": "child-id"}
        self.assertIsNone(self.invoke(stop, "codex"))
        self.assertEqual(self.calls()[before:], [("/api/ardud/control/desktop-lease/call-end",
                                                  {"toolUseId": "call-a", "outcome": "failed"})])
        # Already flushed: a second turn end sends nothing.
        self.assertIsNone(self.invoke(stop, "codex"))
        self.assertEqual(len(self.calls()), before + 1)

    def test_turn_end_keeps_calls_the_server_could_not_close_and_ignores_other_callers(self):
        self.assertIsNone(self.invoke({**self.event(), "tool_use_id": "call-x"}, "codex"))
        other = {"hook_event_name": "Stop", "session_id": "parent-session", "agent_id": "other-child"}
        before = len(self.calls())
        self.assertIsNone(self.invoke(other, "codex"))
        self.assertEqual(len(self.calls()), before)
        self.server.state.update(status=500, body=b'{}')
        mine = {"hook_event_name": "SubagentStop", "session_id": "parent-session", "agent_id": "child-id"}
        self.assertIsNone(self.invoke(mine, "codex"))
        self.server.state.update(status=200, body=b'{}')
        self.assertIsNone(self.invoke({**mine, "hook_event_name": "SessionEnd"}, "codex"))
        self.assertEqual(self.calls()[-1], ("/api/ardud/control/desktop-lease/call-end",
                                            {"toolUseId": "call-x", "outcome": "failed"}))

    def test_read_only_completion_has_no_requests(self):
        self.assertIsNone(self.invoke(self.event("mcp__node_repl__js", {"code": "1+1"}, "PostToolUse"), "codex"))
        self.assertEqual(self.calls(), [])

    def test_overlapping_shell_matcher_does_not_admit_twice(self):
        event = self.event("mcp__cua-driver__exec_command")
        self.assertIsNone(self.invoke(event, "codex", ("--shell-mcp",)))
        self.assertEqual(self.calls(), [])
        self.assertIsNone(self.invoke(event, "codex"))
        self.assertEqual(len(self.calls()), 1)

    def test_unexpected_policy_exception_still_fails_closed_and_logs(self):
        with patch.object(desktop_lease, "admit", side_effect=RuntimeError("broken")):
            result = engine.decide(self.event(), "claude")
        self.assertEqual(result["decision"], "deny")
        rows = (Path(self.temp.name) / "decisions.jsonl").read_text().splitlines()
        self.assertEqual(json.loads(rows[-1])["decision"], "deny")


if __name__ == "__main__":
    unittest.main()
