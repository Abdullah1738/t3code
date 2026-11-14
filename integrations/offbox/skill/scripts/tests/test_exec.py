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
                      ConnectionError("secret command could be echoed"), TimeoutError("timed out")):
            with self.subTest(error=type(error).__name__):
                self.call.side_effect = error
                code, stdout, stderr = self.invoke("bx_own", "--", "true")
                self.assertEqual((code, stdout), (90, ""))
                self.assertTrue(stderr)
                self.assertEqual(self.rows()[-1]["props"]["errorClass"], type(error).__name__)

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
                                        "commandLength": len(f"echo {secret}")})
        self.assertGreaterEqual(row["durationMs"], 0)
        self.assertNotIn(secret, json.dumps(rows))
        self.assertNotIn("private output", json.dumps(rows))
        self.log.assert_not_called()

    def test_exception_body_never_enters_error_event_or_cli_log(self):
        secret = "private-command-value-123"
        self.call.side_effect = api.NetworkError(secret)
        self.invoke("bx_own", "--", secret)
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["name"], "exec.error")
        self.assertEqual(rows[0]["props"]["exitCode"], 90)
        self.assertNotIn(secret, json.dumps(rows))
        self.log.assert_not_called()

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
