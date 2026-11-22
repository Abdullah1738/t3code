if __package__:
    from . import test_environment
else:
    import test_environment  # noqa: F401

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))
import antigravity
import engine

CID = "11111111-2222-3333-4444-555555555555"


def pre(call, step=7, **extra):
    return {"toolCall": call, "stepIdx": step, "conversationId": CID, "workspacePaths": ["/work"], **extra}


def run(argv, payload):
    out = io.StringIO()
    with redirect_stdout(out), patch.object(sys, "stdin", io.StringIO(payload if isinstance(payload, str) else json.dumps(payload))):
        antigravity.main(argv)
    return json.loads(out.getvalue())


class MappingTests(unittest.TestCase):
    def test_run_command_maps_to_bash_with_cwd(self):
        event = antigravity.map_pre(pre({"name": "run_command", "args": {"CommandLine": "go test ./...", "Cwd": "/repo"}}))
        self.assertEqual(event["tool_name"], "Bash")
        self.assertEqual(event["tool_input"], {"command": "go test ./...", "cwd": "/repo"})
        self.assertEqual(event["session_id"], CID)
        self.assertEqual(event["tool_use_id"], f"agy:{CID}:7")
        self.assertEqual(event["hook_event_name"], "PreToolUse")

    def test_cwd_falls_back_to_the_workspace(self):
        event = antigravity.map_pre(pre({"name": "run_command", "args": {"CommandLine": "ls"}}))
        self.assertEqual(event["cwd"], "/work")

    def test_mcp_calls_get_native_style_names(self):
        event = antigravity.map_pre(pre({"name": "query", "args": {
            "ServerName": "betterstack", "ToolName": "query", "Arguments": {"q": 1}}}))
        self.assertEqual(event["tool_name"], "mcp__betterstack__query")
        self.assertEqual(event["tool_input"], {"q": 1})
        cua = antigravity.map_pre(pre({"name": "click", "args": {"ServerName": "cua-driver", "ToolName": "click"}}))
        self.assertTrue(engine.desktop_lease.matches(cua["tool_name"]))

    def test_builtin_file_tools_have_no_guard(self):
        self.assertIsNone(antigravity.map_pre(pre({"name": "view_file", "args": {"AbsolutePath": "/etc/hosts"}})))
        self.assertIsNone(antigravity.map_pre(pre({"name": "run_command", "args": {}})))
        self.assertIsNone(antigravity.map_pre({"stepIdx": 1}))


class DecisionTests(unittest.TestCase):
    def test_deny_and_allow_pass_through(self):
        with patch.object(engine, "decide", return_value={"decision": "deny", "reason": "offbox gate: no", "context": {}}) as decide:
            out = run(["--event", "pre"], pre({"name": "run_command", "args": {"CommandLine": "npm install"}}))
        self.assertEqual(out, {"decision": "deny", "reason": "offbox gate: no"})
        self.assertEqual(decide.call_args.args[1], "antigravity")
        with patch.object(engine, "decide", return_value={"decision": "allow", "reason": "", "context": {"updatedInput": {}}}):
            out = run(["--event", "pre"], pre({"name": "run_command", "args": {"CommandLine": "ls"}}))
        self.assertEqual(out, {"decision": "allow"})

    def test_unguarded_tools_never_load_the_engine(self):
        with patch.object(engine, "decide", side_effect=AssertionError("called")):
            self.assertEqual(run(["--event", "pre"], pre({"name": "view_file", "args": {}})), {"decision": "allow"})

    def test_failures_still_print_a_decision(self):
        # A hook that prints nothing or exits non-zero denies every tool in this runtime.
        self.assertEqual(run(["--event", "pre"], "not json"), {"decision": "allow"})
        with patch.object(engine, "decide", side_effect=RuntimeError("boom")):
            out = run(["--event", "pre"], pre({"name": "run_command", "args": {"CommandLine": "ls"}}))
        self.assertEqual(out, {"decision": "allow"})
        with patch.object(engine, "decide", side_effect=RuntimeError("boom")):
            out = run(["--event", "pre"], pre({"name": "click", "args": {"ServerName": "cua-driver", "ToolName": "click"}}))
        self.assertEqual(out["decision"], "deny")
        self.assertEqual(out["reason"], engine.desktop_lease.UNAVAILABLE)

    def test_an_engine_that_cannot_load_still_denies_desktop_calls(self):
        # Review of 3e27b87ce3: `import engine` failing allowed a mutating CUA call.
        click = pre({"name": "click", "args": {"ServerName": "cua-driver", "ToolName": "click"}})
        with patch.dict(sys.modules, {"engine": None}):
            self.assertEqual(run(["--event", "pre"], click)["decision"], "deny")
            self.assertEqual(run(["--event", "pre"], pre({"name": "run_command", "args": {"CommandLine": "ls"}})),
                             {"decision": "allow"})
        with patch.object(antigravity, "pre", side_effect=RuntimeError("boom")):
            self.assertEqual(run(["--event", "pre"], click)["decision"], "deny")
        for name in ("mcp__cua-driver__click", "mcp__cua_driver__type_text", "mcp__node_repl__js",
                     "mcp__cua-driver__", "mcp__dia__dia_tab_create", "Bash"):
            self.assertEqual(antigravity._DESKTOP.match(name) is not None, engine.desktop_lease.matches(name), name)

    def test_post_finishes_only_admitted_desktop_calls(self):
        with tempfile.TemporaryDirectory() as state, patch.dict(os.environ, {"HARNESS_HOOKS_STATE_DIR": state}):
            with patch.object(engine, "decide") as decide:
                self.assertEqual(run(["--event", "post"], {"stepIdx": 7, "conversationId": CID, "error": ""}), {})
                decide.assert_not_called()
                engine.desktop_lease._pending_update(Path(state), CID, add=f"agy:{CID}:7")
                run(["--event", "post"], {"stepIdx": 7, "conversationId": CID, "error": "exit status 1"})
            event = decide.call_args.args[0]
            self.assertEqual(event["hook_event_name"], "PostToolUseFailure")
            self.assertEqual(event["tool_use_id"], f"agy:{CID}:7")
            self.assertTrue(engine.desktop_lease.needs_lease(event))

    def test_stop_flushes_as_session_end(self):
        with patch.object(engine, "decide") as decide:
            self.assertEqual(run(["--event", "stop"], {"conversationId": CID, "terminationReason": "session_end"}), {})
        self.assertEqual(decide.call_args.args[0]["hook_event_name"], "SessionEnd")


class EngineTests(unittest.TestCase):
    def test_engine_accepts_the_antigravity_harness(self):
        self.assertEqual(engine._native({"session_id": CID, "agent_id": "x"}, "antigravity"), (CID, None, "antigravity"))
        with tempfile.TemporaryDirectory() as state, patch.dict(os.environ, {"HARNESS_HOOKS_STATE_DIR": state}):
            result = engine.decide({"hook_event_name": "PreToolUse", "tool_name": "mcp__betterstack__query",
                                    "tool_input": {}, "cwd": "/tmp/not-crpko"}, "antigravity")
        self.assertEqual(result["decision"], "deny")
        self.assertEqual(result["context"]["rule"], "betterstack-scope")

    def test_script_runs_as_a_hooks_json_command(self):
        out = subprocess.run([sys.executable, str(SRC / "antigravity.py"), "--event", "pre"],
                             input=json.dumps(pre({"name": "view_file", "args": {}})), capture_output=True, text=True)
        self.assertEqual(out.returncode, 0)
        self.assertEqual(json.loads(out.stdout), {"decision": "allow"})


if __name__ == "__main__":
    unittest.main()
