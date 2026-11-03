import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

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
        self.send_response(status)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

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
        self.server.state.update(calls=[], status=200, body=b'{"lease":{},"queue":[]}')
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
