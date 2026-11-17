"""Offline coverage for control API execution, including CLI parsing and log privacy."""

import contextlib
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import unittest
import urllib.error
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, cli, common, home, identity, lease, ssh_sync
from test_capacity import Isolated
import toollog

API_CALL = api.call


class ExecTests(Isolated):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(common, "_BACKEND", "server"))
        self.stack.enter_context(patch.object(api, "BACKEND", "server"))
        self.stack.enter_context(patch.object(api, "NAME", "offbox server"))
        self.stack.enter_context(patch.object(identity, "whoami", return_value=self.me))
        self.box("bx_own")
        self.con.execute("UPDATE leases SET owner=?, repo_root=? WHERE box_id='bx_own'",
                         (self.me["owner"], self.me["repo_root"]))
        self.con.commit()
        self.result = {"exitCode": 0, "stdout": "hello\n", "stderr": "warning\n", "processId": 123}
        self.call = self.stack.enter_context(patch.object(api, "call", return_value=self.result))
        self.stack.enter_context(patch.dict(os.environ, {"OFFBOX_TOOL_LOG_DIR": str(Path(self.tmp.name) / "tools")}))
        self.ssh = self.stack.enter_context(patch.object(ssh_sync, "ssh", side_effect=AssertionError("no SSH")))
        self.setup = self.stack.enter_context(patch.object(ssh_sync, "setup", side_effect=AssertionError("no SSH setup")))
        self.base = self.stack.enter_context(patch.object(ssh_sync, "ssh_base", side_effect=AssertionError("no known_hosts")))
        self.proc = self.stack.enter_context(patch.object(subprocess, "Popen", side_effect=AssertionError("no subprocess")))
        self.log = self.stack.enter_context(patch.object(cli, "log"))
        self.addCleanup(self.proc.assert_not_called)
        self.addCleanup(self.ssh.assert_not_called)
        self.addCleanup(self.setup.assert_not_called)
        self.addCleanup(self.base.assert_not_called)

    def invoke(self, *args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = cli.main(["exec", *args])
        return code, stdout.getvalue(), stderr.getvalue()

    def rows(self):
        return [json.loads(line) for path in (Path(self.tmp.name) / "tools").glob("*.ndjson")
                for line in path.read_text().splitlines()]

    def test_streams_and_remote_exit_codes(self):
        for code in (0, 3, 90, 255):
            with self.subTest(code=code):
                self.result["exitCode"] = code
                self.assertEqual(self.invoke("bx_own", "--", "echo hello"), (code, "hello\n", "warning\n"))
                event = self.rows()[-1]
                self.assertEqual(event["name"], "exec.error" if code else "exec.done")
                if code:
                    self.assertEqual(event["props"]["errorClass"], "RemoteExit")

    def test_streams_preserve_output_without_adding_newlines(self):
        self.result.update(stdout="hello", stderr="warning")
        self.assertEqual(self.invoke("bx_own", "--", "printf hello"), (0, "hello", "warning"))

    def test_json_preserves_the_result_instead_of_printing_streams(self):
        self.result["exitCode"] = 3
        code, stdout, stderr = self.invoke("bx_own", "--json", "--", "true")
        self.assertEqual((code, json.loads(stdout), stderr), (3, self.result, ""))

    def test_other_owner_is_refused_before_api(self):
        self.con.execute("UPDATE leases SET token_owner='moni' WHERE box_id='bx_own'")
        self.con.commit()
        code, stdout, stderr = self.invoke("bx_own", "--", "true")
        self.assertEqual((code, stdout), (2, ""))
        self.assertIn("belongs to moni", stderr)
        self.call.assert_not_called()
        self.assertEqual(self.rows()[0]["props"]["errorClass"], "NotYours")

    def test_require_mine_precedes_every_api_call(self):
        order = []
        original = common.require_mine
        def require(con, bid):
            order.append("owner")
            original(con, bid)
        def call(*args, **kwargs):
            order.append("api")
            return self.result
        self.call.side_effect = call
        with patch.object(common, "require_mine", side_effect=require):
            self.assertEqual(self.invoke("bx_own", "--", "true")[0], 0)
        self.assertEqual(order, ["owner", "api"])

    def test_unknown_box_is_refused_without_api(self):
        code, _, stderr = self.invoke("bx_unknown", "--", "true")
        self.assertEqual(code, 2)
        self.assertIn("no local record for bx_unknown on the home backend", stderr)
        self.call.assert_not_called()

    def test_no_box_uses_current_lease_without_acquiring_or_using_ssh(self):
        with patch.object(lease, "acquire", side_effect=AssertionError("must not acquire")):
            self.assertEqual(self.invoke("--", "true")[0], 0)
        self.assertEqual(self.call.call_args.args[1], "/sandboxes/bx_own/commands")

    def test_no_lease_is_a_clear_local_refusal(self):
        self.con.execute("DELETE FROM leases")
        self.con.commit()
        code, _, stderr = self.invoke("--", "true")
        self.assertEqual(code, 2)
        self.assertIn("no lease for this thread + repo", stderr)
        self.call.assert_not_called()

    def test_unproven_identity_never_selects_or_calls_api(self):
        self.me.update(proven=False, driver="codex", resolution="pending")
        with patch.object(lease, "find_lease") as find:
            self.assertEqual(self.invoke("--", "true")[0], 2)
        find.assert_not_called()
        self.call.assert_not_called()

    def test_404_names_each_backend_and_does_not_fail_over(self):
        for backend, name in (("server", "home"), ("boat", "boat")):
            with self.subTest(backend=backend), patch.object(api, "BACKEND", backend), \
                    patch.object(common, "_BACKEND", backend), patch.object(home, "fail_over") as failover:
                self.call.reset_mock()
                self.call.side_effect = api.ApiError(404, "not_found", "missing")
                code, _, stderr = self.invoke("bx_own", "--", "true")
                self.assertEqual(code, 90)
                self.assertIn(f"box not found on the {name} backend", stderr)
                self.call.assert_called_once()
                failover.assert_not_called()

    def test_api_and_transport_errors_map_to_infra(self):
        for error in (api.NetworkError("connection refused"), api.ApiError(503, "unavailable", "try later"),
                      api.ApiError(408, "other_timeout", "not a command timeout"),
                      ConnectionError("secret command could be echoed"), TimeoutError("timed out")):
            with self.subTest(error=type(error).__name__):
                self.call.side_effect = error
                code, stdout, stderr = self.invoke("bx_own", "--", "true")
                self.assertEqual((code, stdout), (90, ""))
                self.assertTrue(stderr)
                self.assertIn("exec has no local fallback", stderr)
                self.assertEqual(self.rows()[-1]["props"]["errorClass"], type(error).__name__)

    def test_timeout_preserves_partial_output_and_structured_metadata(self):
        data = {"code": "command_timeout", "processId": 1002, "stdout": "partial output\n",
                "stderr": "partial error\n", "queuedMs": 0, "runMs": 20000, "killed": True}
        for as_json in (False, True):
            with self.subTest(as_json=as_json):
                self.call.side_effect = api.ApiError(408, "command_timeout", "command 1002 timed out", data=data)
                code, stdout, stderr = self.invoke("bx_own", "--timeout", "20", *(["--json"] if as_json else []),
                                                   "--", "private command")
                self.assertEqual(code, 124)
                if as_json:
                    envelope = json.loads(stdout)
                    self.assertEqual({k: envelope[k] for k in data}, data)
                    self.assertEqual(envelope["offbox"], {
                        "code": "command_timeout", "box": "bx_own", "timeoutSeconds": 20, "pid": 1002,
                        "queueMs": 0, "runMs": 20000, "killed": True, "outcome": "stopped"})
                else:
                    self.assertEqual(stdout, data["stdout"])
                    self.assertTrue(stderr.startswith(data["stderr"]))
                self.assertIn("offbox exec: command ran past --timeout 20s on bx_own "
                              "(server command 1002: waited 0.0s in the server's run queue, ran 20.0s, killed); "
                              "nothing fell back locally\n", stderr)
                self.assertTrue(stderr.endswith("offbox exec: it started and was stopped after 20.0s; "
                                                "any side effects up to then may have happened, and it will not run again.\n"))
                self.assertEqual({k: self.rows()[-1]["props"][k] for k in ("queueMs", "runMs", "pid", "killed")},
                                 {"queueMs": 0, "runMs": 20000, "pid": 1002, "killed": True})
                self.assertNotIn("partial output", json.dumps(self.rows()))

    def test_timeout_explains_queue_run_and_outcome_without_echoing_input(self):
        never_started = "it never started; the server cancelled it and it will not run later."
        old_server = ("the server cancels timed-out commands, so it will not run later; "
                      "check with offbox ssh bx_own if a partial run matters.")
        def stopped(seconds):
            return (f"it started and was stopped after {seconds}s; any side effects up to then "
                    "may have happened, and it will not run again.")
        cases = [
            ({"processId": 1007, "queuedMs": 58200, "runMs": 1800, "killed": True},
             "server command 1007: waited 58.2s in the server's run queue, ran 1.8s, killed", True, stopped("1.8")),
            ({"processId": 1007, "queuedMs": 60000, "runMs": 0},
             "server command 1007: waited 60.0s in the server's run queue, ran 0.0s", True, never_started),
            ({"processId": 1007, "queuedMs": 0, "runMs": 0, "killed": True},
             "server command 1007: waited 0.0s in the server's run queue, ran 0.0s, killed", False, never_started),
            ({"processId": 1007, "queuedMs": 0, "runMs": 60000, "killed": True},
             "server command 1007: waited 0.0s in the server's run queue, ran 60.0s, killed", False, stopped("60.0")),
            ({}, "the server sent no command id or timings: the home server is older than the exec queue fix",
             False, old_server),
            ({"processId": 1007}, "server command 1007", False, old_server),
            ({"queuedMs": 30000, "killed": False}, "waited 30.0s in the server's run queue", True, never_started),
            ({"queuedMs": 29999}, "waited 30.0s in the server's run queue", False, never_started),
            ({"runMs": 1250}, "ran 1.2s", False, stopped("1.2")),
            ({"runMs": 0}, "ran 0.0s", False, old_server),
            ({"processId": "private-command", "queuedMs": -1, "runMs": "private-command", "killed": "private-command"},
             "the server sent no command id or timings: the home server is older than the exec queue fix", False, old_server),
        ]
        for data, detail, hint, outcome in cases:
            with self.subTest(data=data):
                self.call.side_effect = api.ApiError(408, "command_timeout", "private-command", data={
                    **data, "message": "private-command"})
                code, stdout, stderr = self.invoke("bx_own", "--timeout", "60", "--", "private-command")
                expected = [f"offbox exec: command ran past --timeout 60s on bx_own ({detail}); nothing fell back locally"]
                if hint:
                    expected.append("offbox exec: the command was waiting behind other runs on the home server, not running; "
                                    "retry, or use offbox ssh bx_own '<cmd>' for a quick read.")
                expected.append(f"offbox exec: {outcome}")
                self.assertEqual((code, stdout, stderr.splitlines()), (124, "", [f"offbox: {line}" for line in expected]))
                self.assertNotIn("private-command", stderr)
                self.assertNotIn("unknown", stderr)

    def test_timeout_json_always_writes_one_envelope_preserving_server_keys(self):
        full = {"code": "command_timeout", "processId": 1007, "queuedMs": 58200, "runMs": 1800,
                "killed": True, "stdout": "partial output\n", "stderr": "partial error\n",
                "timeoutSeconds": 99, "message": "private-command", "extra": {"kept": [1, "value"]}}
        cases = [
            (full, (1007, 58200, 1800, True, "stopped")),
            ({"queuedMs": 60000, "runMs": 0}, (None, 60000, 0, None, "never_started")),
            ({"queuedMs": 0, "runMs": 0}, (None, 0, 0, None, "never_started")),
            ({"queuedMs": 60000}, (None, 60000, None, None, "never_started")),
            ({"queuedMs": 30000.5}, (None, 30000, None, None, "never_started")),
            ({"runMs": 1500.5}, (None, None, 1500, None, "stopped")),
            ({"processId": 1007}, (1007, None, None, None, "cancelled_old_server")),
            ({}, (None, None, None, None, "cancelled_old_server")),
            (None, (None, None, None, None, "cancelled_old_server")),
            ("private-command", (None, None, None, None, "cancelled_old_server")),
            (["private-command"], (None, None, None, None, "cancelled_old_server")),
            ({"processId": True, "queuedMs": -1, "runMs": "private-command", "killed": 1},
             (None, None, None, None, "cancelled_old_server")),
        ]
        for data, (pid, queue_ms, run_ms, killed, outcome) in cases:
            with self.subTest(data=data):
                error = api.ApiError(408, "command_timeout", "private-command")
                error.data = data  # Exercise None too: ApiError's constructor currently replaces it with {}.
                self.call.side_effect = error
                code, stdout, stderr = self.invoke("bx_own", "--timeout", "60", "--json", "--", "private-command")
                envelope = json.loads(stdout)
                self.assertEqual(code, 124)
                self.assertEqual(envelope, {**(data if isinstance(data, dict) else {}), "offbox": {
                    "code": "command_timeout", "box": "bx_own", "timeoutSeconds": 60, "pid": pid,
                    "queueMs": queue_ms, "runMs": run_ms, "killed": killed, "outcome": outcome}})
                self.assertTrue(stderr.startswith("offbox: offbox exec: command ran past --timeout 60s on bx_own "))
                self.assertNotIn("private-command", stderr)
                self.assertNotIn("partial output", stderr)
                self.assertNotIn("partial error", stderr)
                if isinstance(data, dict):
                    self.assertNotIn("offbox", data)

    def test_timeout_json_uses_clamped_timeout(self):
        self.call.side_effect = api.ApiError(408, "command_timeout", "private-command")
        code, stdout, stderr = self.invoke("bx_own", "--timeout", "9999", "--json", "--", "private-command")
        self.assertEqual((code, json.loads(stdout)["offbox"]["timeoutSeconds"]), (124, 600))
        self.assertIn("command ran past --timeout 600s", stderr)

    def test_timeout_json_flushes_before_human_diagnostics(self):
        stdout = io.StringIO()
        self.call.side_effect = api.ApiError(408, "command_timeout", "private-command")
        with contextlib.redirect_stdout(stdout), patch.object(stdout, "flush") as flush:
            def say(line):
                flush.assert_called_once_with()
                self.assertEqual(json.loads(stdout.getvalue())["offbox"]["outcome"], "cancelled_old_server")
            with patch.object(common, "say", side_effect=say) as diagnostics:
                self.assertEqual(cli.main(["exec", "bx_own", "--json", "--", "private-command"]), 124)
        self.assertEqual(diagnostics.call_count, 2)

    def test_timeout_json_preserves_exit_and_diagnostics_when_stdout_fails(self):
        self.call.side_effect = api.ApiError(408, "command_timeout", "private-command")
        for failure in (BrokenPipeError, OSError, ValueError):
            for operation in ("write", "flush"):
                with self.subTest(failure=failure, operation=operation):
                    stdout, stderr = io.StringIO(), io.StringIO()
                    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr), \
                            patch.object(stdout, operation, side_effect=failure("gone")):
                        code = cli.main(["exec", "bx_own", "--json", "--", "private-command"])
                    self.assertEqual(code, 124)
                    self.assertIn("the server sent no command id or timings", stderr.getvalue())
                    self.assertIn("it will not run later", stderr.getvalue())
                    self.assertNotIn("internal error", stderr.getvalue())

    def test_timeout_non_json_ignores_non_object_body(self):
        for data in (None, "private-command", ["private-command"]):
            with self.subTest(data=data):
                error = api.ApiError(408, "command_timeout", "private-command")
                error.data = data
                self.call.side_effect = error
                code, stdout, stderr = self.invoke("bx_own", "--", "private-command")
                self.assertEqual((code, stdout), (124, ""))
                self.assertIn("the server sent no command id or timings", stderr)
                self.assertNotIn("private-command", stderr)

    def test_success_includes_timing_metadata(self):
        self.result.update(queuedMs=0, runMs=15, killed=False)
        self.assertEqual(self.invoke("bx_own", "--", "true")[0], 0)
        self.assertEqual(self.rows()[-1]["props"]["queueMs"], 0)
        self.assertEqual(self.rows()[-1]["props"]["runMs"], 15)

    def test_api_timeout_log_retains_only_status_code_id_and_timing(self):
        secret = "private-command-value-123"
        data = {"code": "command_timeout", "message": secret, "processId": 1002,
                "queuedMs": 0, "runMs": 20000, "stdout": secret, "stderr": secret, "killed": True}
        error = urllib.error.HTTPError("https://example.invalid", 408, "timeout", {},
                                       io.BytesIO(json.dumps(data).encode()))
        self.call.side_effect = API_CALL
        with patch.object(api, "_open", side_effect=error), patch.object(api, "_key", return_value="fixture-key"), \
                patch.object(api, "_own_box"), patch.object(api, "log") as log:
            self.assertEqual(self.invoke("bx_own", "--timeout", "20", "--", secret)[0], 124)
        log.assert_called_once_with("api POST /sandboxes/bx_own/commands -> "
                                    "408 command_timeout command 1002 (queued 0.0s, ran 20.0s)")
        self.assertNotIn(secret, str(log.call_args_list) + json.dumps(self.rows()))

    def test_api_success_log_has_timing_without_command_or_output(self):
        data = {**self.result, "queuedMs": 0, "runMs": 10}
        self.call.side_effect = API_CALL
        with contextlib.ExitStack() as stack:
            response = stack.enter_context(patch.object(api, "_open")).return_value.__enter__.return_value
            response.read.return_value = json.dumps(data).encode()
            stack.enter_context(patch.object(api, "_key", return_value="fixture-key"))
            stack.enter_context(patch.object(api, "_own_box"))
            log = stack.enter_context(patch.object(api, "log"))
            self.assertEqual(self.invoke("bx_own", "--", "private command")[0], 0)
        log.assert_called_once_with("api POST /sandboxes/bx_own/commands -> 200 command 123 (queued 0.0s, ran 0.0s)")

    def test_command_log_rejects_untrusted_codes_ids_and_timings(self):
        self.assertEqual(api._command_summary(400, "private_command", {
            "processId": "private command", "queuedMs": float("nan"), "runMs": "private command"}), "400 http_400")

    def test_log_write_failure_preserves_remote_results_and_api_errors(self):
        cases = [(200, "", 0), (200, "", 7), (408, "command_timeout", 124), (503, "server_not_ready", 90)]
        for status, tag, expected in cases:
            with self.subTest(status=status, expected=expected), contextlib.ExitStack() as stack:
                data = {"exitCode": expected, "stdout": "partial\n", "stderr": "warning\n", "processId": 1002,
                        "code": tag, "queuedMs": 0, "runMs": 1000}
                opener = stack.enter_context(patch.object(api, "_open"))
                if status == 200:
                    opener.return_value.__enter__.return_value.read.return_value = json.dumps(data).encode()
                else:
                    opener.side_effect = urllib.error.HTTPError("https://example.invalid", status, "error", {},
                                                                io.BytesIO(json.dumps(data).encode()))
                self.call.side_effect = API_CALL
                stack.enter_context(patch.object(api, "_key", return_value="fixture-key"))
                stack.enter_context(patch.object(api, "_own_box"))
                stack.enter_context(patch.object(api, "log", side_effect=OSError("disk full")))
                code, stdout, _ = self.invoke("bx_own", "--", "true")
                self.assertEqual(code, expected)
                self.assertEqual(stdout, "" if status == 503 else data["stdout"])

    def test_timeout_default_and_clamps_reach_api_with_cwd(self):
        for requested, expected in ((None, 60), (9999, 600), (0, 1), (-10, 1), (600, 600)):
            with self.subTest(requested=requested):
                options = [] if requested is None else ["--timeout", str(requested)]
                self.assertEqual(self.invoke("bx_own", *options, "--cwd", "/work dir", "--", "true")[0], 0)
                self.assertEqual(self.call.call_args.args[2], {"command": "true", "timeoutSeconds": expected,
                                                              "cwd": "/work dir"})
                self.assertEqual(self.call.call_args.kwargs["timeout"], expected + 30)
                self.assertEqual(self.rows()[-1]["props"]["timeoutSeconds"], expected)

    def test_options_work_before_box_and_in_equals_form(self):
        self.assertEqual(self.invoke("--timeout=10", "--cwd=/work", "--json", "bx_own", "--", "true")[0], 0)
        self.assertEqual(self.call.call_args.args[2], {"command": "true", "timeoutSeconds": 10, "cwd": "/work"})

    def test_command_joining_and_separator_forms(self):
        cases = [(["echo hi; exit 3"], "echo hi; exit 3"),
                 (["printf", "%s", "two words", "a'b", "$TOKEN", ""], shlex.join(["printf", "%s", "two words", "a'b", "$TOKEN", ""])),
                 (["echo", "--json", "--timeout", "9999"], "echo --json --timeout 9999"),
                 (["--", "flag"], "-- flag")]
        for args, expected in cases:
            for prefix in (["bx_own", "--"], ["--"], []):
                with self.subTest(args=args, prefix=prefix):
                    if not prefix and any(arg.startswith("--") for arg in args):
                        continue
                    self.assertEqual(self.invoke(*prefix, *args)[0], 0)
                    self.assertEqual(self.call.call_args.args[2]["command"], expected)

    def test_missing_command_is_refused(self):
        for args in ([], ["bx_own"], ["bx_own", "--"], ["--", ""]):
            with self.subTest(args=args):
                self.assertEqual(self.invoke(*args)[0], 2)
        self.call.assert_not_called()

    def test_malformed_results_never_report_success(self):
        for result in ({}, None, {"exitCode": None}, {"exitCode": True}, {"exitCode": -1},
                       {"exitCode": "0"}, {"exitCode": 0, "stdout": {"unexpected": "data"}}):
            with self.subTest(result=result):
                self.call.return_value = result
                self.assertEqual(self.invoke("bx_own", "--", "true")[0], 90)

    def test_exactly_one_metadata_event_without_command_or_output(self):
        secret = "private-command-value-123"
        self.result["stdout"] = "private output"
        self.invoke("bx_own", "--timeout", "9999", "--", f"echo {secret}")
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual((row["name"], row["component"]), ("exec.done", "cli"))
        self.assertEqual(row["ids"], {"box": "bx_own", "owner": "worker", "thread": "t"})
        self.assertEqual(row["props"], {"backend": "home", "exitCode": 0, "timeoutSeconds": 600,
                                        "commandLength": len(f"echo {secret}"), "pid": 123})
        self.assertGreaterEqual(row["durationMs"], 0)
        self.assertNotIn(secret, json.dumps(rows))
        self.assertNotIn("private output", json.dumps(rows))
        self.assertEqual(self.log.call_count, 1)
        self.assertIn('client_command ', self.log.call_args.args[0])
        self.assertNotIn(secret, self.log.call_args.args[0])

    def test_exception_body_never_enters_error_event_or_cli_log(self):
        secret = "private-command-value-123"
        self.call.side_effect = api.NetworkError(secret)
        self.invoke("bx_own", "--", secret)
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["name"], "exec.error")
        self.assertEqual(rows[0]["props"]["exitCode"], 90)
        self.assertNotIn(secret, json.dumps(rows))
        self.assertEqual(self.log.call_count, 1)
        self.assertIn('client_command ', self.log.call_args.args[0])
        self.assertNotIn(secret, self.log.call_args.args[0])

    def test_http_errors_that_echo_command_do_not_log_it(self):
        secret = "private-command-value-123"
        error = urllib.error.HTTPError("https://example.invalid", 400, "bad request", {},
                                       io.BytesIO(json.dumps({"message": secret}).encode()))
        self.call.side_effect = API_CALL
        with patch.object(api, "_open", side_effect=error), patch.object(api, "_key", return_value="fixture-key"), \
                patch.object(api, "_own_box"), patch.object(api, "log") as log:
            self.assertEqual(self.invoke("bx_own", "--", secret)[0], 90)
        log.assert_called_once()
        self.assertNotIn(secret, str(log.call_args_list))

    def test_exec_backend_selection_uses_only_box_position(self):
        with patch.object(common, "backend_pinned", return_value=None), \
                patch.object(common, "home_config", return_value={"url": "fixture"}), \
                patch.object(common, "default_backend", return_value="server"), \
                patch.object(common, "_known", side_effect=lambda name, ident, **kw: name == "boat") as known:
            self.assertEqual(common.entry_backend(["exec", "bx_own", "--cwd", "bx_directory", "--", "bx_command"]), "boat")
            self.assertEqual({c.args[1] for c in known.call_args_list}, {"bx_own"})
            known.reset_mock()
            self.assertEqual(common.entry_backend(["exec", "--cwd", "bx_directory", "--", "echo", "bx_other"]), "server")
            known.assert_not_called()

    def test_boat_success_uses_the_same_api_contract(self):
        with patch.object(api, "BACKEND", "boat"), patch.object(common, "_BACKEND", "boat"):
            self.assertEqual(self.invoke("bx_own", "--", "true")[0], 0)
        self.call.assert_called_once_with("POST", "/sandboxes/bx_own/commands",
                                          {"command": "true", "timeoutSeconds": 60}, timeout=90, retries=0)
        self.assertEqual(self.rows()[0]["props"]["backend"], "boat")


if __name__ == "__main__":
    unittest.main()
