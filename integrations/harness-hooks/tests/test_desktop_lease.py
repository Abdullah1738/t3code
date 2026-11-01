import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


HOOK = Path(__file__).resolve().parents[1] / "desktop_lease.py"
ROOT = "root-thread"
CHILD = "child-thread"
SESSION = "native-session"
CALL = "call-123"
PROOF = "test-proof"
TOKEN = "test-token"


def lease(**updates):
    value = {
        "rootThreadId": ROOT, "childThreadId": CHILD, "taskId": "task-1",
        "scope": "fixture-app", "mode": "native", "state": "held",
        "acquiredAt": "2026-11-01T00:00:00.000Z",
        "heartbeatAt": "2026-11-01T00:00:01.000Z",
    }
    value.update(updates)
    return value


def event(name="mcp__cua-driver__click", arguments=None, **updates):
    value = {
        "session_id": SESSION, "transcript_path": None, "cwd": "/workspace",
        "hook_event_name": "PreToolUse", "tool_name": name,
        "tool_input": {} if arguments is None else arguments, "tool_use_id": CALL,
    }
    value.update(updates)
    return value


class StubServer(ThreadingHTTPServer):
    def __init__(self):
        super().__init__(("127.0.0.1", 0), StubHandler)
        self.daemon_threads = True
        self.requests = []
        self.status = {"lease": lease(), "queue": []}
        self.identity = {
            "caller": {"verified": True, "nativeSessionId": SESSION,
                       "toolUseId": CALL, "agentId": None,
                       "threadId": CHILD, "rootThreadId": ROOT},
        }
        self.identity_code = 200
        self.status_code = 200
        self.identity_body = None
        self.status_body = None


class StubHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, code, value, raw):
        payload = raw if raw is not None else json.dumps(value).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self.server.requests.append(("GET", self.path, self.headers.get("Authorization"), None))
        if self.path != "/api/ardud/control/desktop-lease":
            self.respond(404, {}, None)
        else:
            self.respond(self.server.status_code, self.server.status, self.server.status_body)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.requests.append(("POST", self.path, self.headers.get("Authorization"), body))
        if self.path != "/api/ardud/control/hook-identity/resolve":
            self.respond(404, {}, None)
        else:
            self.respond(self.server.identity_code, self.server.identity, self.server.identity_body)


class DesktopLeaseHookTest(unittest.TestCase):
    def setUp(self):
        self.server = StubServer()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.temp = tempfile.TemporaryDirectory(dir=HOOK.parent)
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.close_server)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("T3_")}
        self.env.update({
            "HOME": self.temp.name,
            "T3_CONTROL_URL": "http://127.0.0.1:%d" % self.server.server_port,
            "T3_CONTROL_TOKEN": TOKEN,
            "T3_HOOK_IDENTITY_PROOF": PROOF,
        })

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def run_hook(self, payload, env=None):
        raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        result = subprocess.run(
            [sys.executable, str(HOOK)], input=raw, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=self.env if env is None else env, timeout=8,
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(result.stderr, b"")
        self.assertNotIn(TOKEN.encode(), result.stdout)
        self.assertNotIn(PROOF.encode(), result.stdout)
        return json.loads(result.stdout) if result.stdout else None

    def assert_denied(self, result):
        self.assertIsInstance(result, dict)
        output = result["hookSpecificOutput"]
        self.assertEqual(output["hookEventName"], "PreToolUse")
        self.assertEqual(output["permissionDecision"], "deny")
        self.assertTrue(output["permissionDecisionReason"])

    def test_claude_action_resolves_identity_and_checks_lease(self):
        self.assertIsNone(self.run_hook(event()))
        self.assertEqual(self.server.requests, [
            ("POST", "/api/ardud/control/hook-identity/resolve", "Bearer " + TOKEN,
             {"proof": PROOF, "nativeSessionId": SESSION, "toolUseId": CALL, "agentId": None}),
            ("GET", "/api/ardud/control/desktop-lease", "Bearer " + TOKEN, None),
        ])

    def test_codex_mcp_action_hook_payload(self):
        payload = event("mcp__cua_driver__type_text", {"pid": 42, "text": "fixture"},
                        turn_id="turn-123", model="cx/gpt-6.1-terra", permission_mode="bypassPermissions")
        self.assertIsNone(self.run_hook(payload))
        self.assertEqual(len(self.server.requests), 2)

    def test_top_level_thread_can_hold_lease(self):
        self.server.identity["caller"]["threadId"] = ROOT
        self.server.status["lease"] = lease(childThreadId=ROOT)
        self.assertIsNone(self.run_hook(event()))

    def test_identity_is_not_taken_from_tool_arguments(self):
        self.server.identity["caller"]["threadId"] = "other-child"
        payload = event(arguments={"threadId": CHILD, "rootThreadId": ROOT})
        self.assert_denied(self.run_hook(payload))

    def test_missing_proof_never_falls_back_to_native_session(self):
        env = self.env.copy()
        del env["T3_HOOK_IDENTITY_PROOF"]
        self.assert_denied(self.run_hook(event(), env))
        self.assertEqual(self.server.requests, [])

    def test_missing_native_session_or_call_id_is_denied(self):
        for field in ("session_id", "tool_use_id"):
            with self.subTest(field=field):
                payload = event()
                del payload[field]
                self.assert_denied(self.run_hook(payload))
        self.assertEqual(self.server.requests, [])

    def test_nested_agent_identity_must_be_resolved_exactly(self):
        payload = event(agent_id="native-child")
        self.assert_denied(self.run_hook(payload))
        self.server.identity["caller"]["agentId"] = "native-child"
        self.assertIsNone(self.run_hook(payload))
        self.assertEqual(self.server.requests[-2][3]["agentId"], "native-child")

    def test_identity_verification_failure_is_closed(self):
        for changes in (
            {"verified": False}, {"nativeSessionId": "other"}, {"toolUseId": "other"},
            {"agentId": "other"}, {"threadId": ""}, {"rootThreadId": ""},
        ):
            with self.subTest(changes=changes):
                before = self.server.identity["caller"].copy()
                self.server.identity["caller"].update(changes)
                self.assert_denied(self.run_hook(event()))
                self.server.identity["caller"] = before

    def test_status_requires_exact_owner_and_held_well_formed_lease(self):
        for invalid in (
            None, lease(childThreadId=ROOT), lease(rootThreadId="other"),
            lease(state="stopping"), lease(state="quarantined"), lease(state="queued"),
            lease(taskId=""), lease(scope=""), lease(mode="bogus"),
            lease(acquiredAt="not-a-date"), lease(heartbeatAt=None),
        ):
            with self.subTest(lease=invalid):
                self.server.status = {"lease": invalid, "queue": []}
                self.assert_denied(self.run_hook(event()))
        self.server.status = {"lease": lease(), "queue": None}
        self.assert_denied(self.run_hook(event()))

    def test_api_errors_and_malformed_responses_deny(self):
        for code in (401, 403, 404, 500):
            with self.subTest(identity_status=code):
                self.server.identity_code = code
                self.assert_denied(self.run_hook(event()))
        self.server.identity_code = 200
        self.server.identity_body = b"<html>not json</html>"
        self.assert_denied(self.run_hook(event()))
        self.server.identity_body = None
        self.server.status_body = b"<html>not json</html>"
        self.assert_denied(self.run_hook(event()))
        self.server.status_body = None
        self.server.status_code = 404
        self.assert_denied(self.run_hook(event()))

    def test_connection_error_and_failed_resolver_deny(self):
        self.server.identity = {"ok": False, "caller": self.server.identity["caller"]}
        self.assert_denied(self.run_hook(event()))
        env = self.env.copy()
        env["T3_CONTROL_URL"] = "http://127.0.0.1:1"
        self.assert_denied(self.run_hook(event(), env))

    def test_bad_events_are_denied(self):
        self.assert_denied(self.run_hook(b"not-json"))
        self.assert_denied(self.run_hook(b" " * (1024 * 1024 + 1)))
        self.assert_denied(self.run_hook({}))
        self.assert_denied(self.run_hook(event(hook_event_name="PostToolUse")))

    def test_cua_reads_bypass_unavailable_identity_and_api(self):
        env = {"PATH": os.environ.get("PATH", ""), "HOME": self.temp.name}
        for tool, args in (
            ("get_window_state", {"pid": 1, "window_id": 2}),
            ("list_windows", {}), ("clipboard_read", {}),
            ("page", {"action": "get_text"}), ("page", {"action": "query_dom"}),
            ("check_permissions", {"prompt": False}), ("check_permissions", {}),
            ("browser_dialog", {"action": "inspect"}),
        ):
            with self.subTest(tool=tool, args=args):
                self.assertIsNone(self.run_hook(event("mcp__cua-driver__" + tool, args), env))
        self.assertEqual(self.server.requests, [])

    def test_cua_actions_and_conditional_mutations_are_guarded(self):
        self.server.status = {"lease": None, "queue": []}
        for tool, args in (
            ("click", {}), ("launch_app", {}), ("clipboard_write", {}),
            ("set_window_frame", {}), ("move_cursor", {}), ("new_future_tool", {}),
            ("page", {"action": "execute_javascript"}),
            ("page", {"action": "click_element"}), ("page", {}),
            ("browser_dialog", {"action": "accept"}),
            ("check_permissions", {"prompt": True}),
        ):
            with self.subTest(tool=tool, args=args):
                self.assert_denied(self.run_hook(event("mcp__cua-driver__" + tool, args)))

    def test_plain_literal_repl_expressions_need_no_lease(self):
        env = {"PATH": os.environ.get("PATH", ""), "HOME": self.temp.name}
        for source in ("1 + 2", "'hello' + \" world\"", "(42 * 3) / 2", "true ? 5 : 6", "-0.5 + .2"):
            with self.subTest(source=source):
                self.assertIsNone(self.run_hook(event("mcp__node_repl__js", {"code": source}), env))
        self.assertEqual(self.server.requests, [])

    def test_repl_risky_or_unknown_source_is_conservatively_guarded(self):
        self.server.status = {"lease": None, "queue": []}
        examples = (
            'await import("@oai/sky")',
            'await import(["@oai", "sky"].join("/"))',
            "await savedAlias.click({})", "savedAlias['click']({})",
            "await require('node:child_process').exec('osascript ...')",
            "await import('node:net').then(n => n.connect('/some/socket'))",
            "globalThis.saved = (await import('@oai/sky')).sky",
            'setTimeout(() => sky.click({}), 1000)',
            'Promise.resolve().then(() => sky.click({}))',
            "new Worker(scriptPath)",
            "require('node:child_process').spawn(command, args, { detached: true })",
            "process._linkedBinding('native')", "eval(savedCode)",
            "console.log(1)", "x + 1", "`hello`", "", "/regex/",
        )
        for source in examples:
            with self.subTest(source=source):
                self.assert_denied(self.run_hook(event("mcp__node_repl__js", {"code": source})))
        self.assert_denied(self.run_hook(event("mcp__node_repl__js", {})))
        self.assert_denied(self.run_hook(event("mcp__node_repl__js_reset", {})))
        self.assert_denied(self.run_hook(event("mcp__node_repl__js_add_node_module_dir", {})))

    def test_repl_desktop_source_with_held_lease_passes_check(self):
        source = 'var sky = (await import("@oai/sky")).sky; await sky.list_apps();'
        self.assertIsNone(self.run_hook(event("mcp__node_repl__js", {"code": source})))

    def test_unrelated_tool_is_unaffected(self):
        env = {"PATH": os.environ.get("PATH", ""), "HOME": self.temp.name}
        self.assertIsNone(self.run_hook(event("Read", {"file_path": "/example"}), env))
        self.assertEqual(self.server.requests, [])

    def test_named_credential_file_and_permissions(self):
        credential = Path(self.temp.name) / "control.json"
        credential.write_text(json.dumps({"url": self.env["T3_CONTROL_URL"], "token": TOKEN}))
        credential.chmod(0o600)
        env = self.env.copy()
        del env["T3_CONTROL_URL"]
        del env["T3_CONTROL_TOKEN"]
        env["T3_CONTROL_TOKEN_FILE"] = str(credential)
        self.assertIsNone(self.run_hook(event(), env))
        credential.chmod(0o644)
        self.assert_denied(self.run_hook(event(), env))
        env["T3_CONTROL_TOKEN_FILE"] = str(credential) + "-missing"
        self.assert_denied(self.run_hook(event(), env))


if __name__ == "__main__":
    unittest.main()
