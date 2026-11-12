"""Offline regressions for retrying only the idempotent SSH key setup."""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.error
from unittest.mock import call, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import api, lease, misc, ssh_sync
from offbox_lib.common import OffboxError


READY = {"sshEndpoint": "host.example:2222", "hostKey": "ssh-ed25519 fixture", "sshUser": "user"}
TIMEOUT = "Request timeout after 19999ms"


class SshKeyRetryTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.stack.enter_context(patch.object(ssh_sync, "SSH_DIR", root))
        self.stack.enter_context(patch.object(ssh_sync, "CM_DIR", root / "cm"))
        self.stack.enter_context(patch.object(ssh_sync, "KEY_PATH", root / "key"))
        self.stack.enter_context(patch.object(ssh_sync, "ensure_dirs"))
        self.stack.enter_context(patch.object(ssh_sync, "pubkey", return_value="ssh-ed25519 public-fixture"))
        self.log = self.stack.enter_context(patch.object(ssh_sync, "log"))
        self.stack.enter_context(patch.object(api, "log"))
        self.stack.enter_context(patch.object(api, "_key", side_effect=AssertionError("unexpected Keychain call")))
        self.urlopen = self.stack.enter_context(patch("urllib.request.urlopen",
                                                   side_effect=AssertionError("unexpected network call")))
        self.send = self.stack.enter_context(patch.object(api, "call",
                                                         side_effect=AssertionError("unexpected API call")))
        self.stack.enter_context(patch.object(api, "_DEADLINE", None))
        self.sleep = self.stack.enter_context(patch.object(ssh_sync.time, "sleep"))
        self.sshkey = self.stack.enter_context(patch.object(api, "sshkey"))

    def test_gateway_timeouts_then_success(self):
        for status in (500, 504):
            for code, message in ((TIMEOUT, ""), (f"http_{status}", TIMEOUT)):
                with self.subTest(status=status, code=code, message=message):
                    self.sleep.reset_mock()
                    self.sshkey.reset_mock()
                    self.log.reset_mock()
                    self.sshkey.side_effect = [api.ApiError(status, code, message),
                                               api.ApiError(status, code, message), READY]
                    cfg = ssh_sync.setup("bx")
                    self.assertEqual(cfg, ssh_sync.cfg_path("bx"))
                    self.assertIn("HostName host.example", cfg.read_text())
                    self.assertEqual(self.sshkey.call_args_list,
                                     [call("bx", "ssh-ed25519 public-fixture")] * 3)
                    self.assertEqual(self.sleep.call_args_list, [call(1), call(2)])
                    retries = [c.args[0] for c in self.log.call_args_list
                               if c.args[0].startswith("ssh_setup_retry ")]
                    self.assertEqual(len(retries), 2)
                    self.assertIn("ssh_setup_retry bx attempt=1", retries[0])
                    self.assertIn("ssh_setup_retry bx attempt=2", retries[1])

    def test_network_outage_then_success(self):
        self.sshkey.side_effect = [OffboxError("connection reset by peer", outage=True), READY]
        self.assertEqual(ssh_sync.setup("bx"), ssh_sync.cfg_path("bx"))
        self.assertEqual(self.sshkey.call_count, 2)
        self.sleep.assert_called_once_with(1)

    def test_eight_failures_keep_the_last_errors_outage_flag(self):
        timeout = api.ApiError(500, TIMEOUT, TIMEOUT)
        network = api.NetworkError("SSL EOF")
        for errors in ([timeout] * 8, [network] * 8, [network] * 7 + [timeout], [timeout] * 7 + [network]):
            last = errors[-1]
            with self.subTest(first=str(errors[0]), last=str(last)):
                self.sshkey.reset_mock()
                self.sleep.reset_mock()
                self.sshkey.side_effect = errors
                with self.assertRaisesRegex(OffboxError, "ssh key setup failed for bx") as caught:
                    ssh_sync.setup("bx")
                self.assertEqual(caught.exception.code, 90)
                self.assertFalse(caught.exception.started)
                self.assertEqual(caught.exception.outage, last.outage)
                self.assertIn(str(last), str(caught.exception))
                self.assertEqual(self.sshkey.call_count, 8)
                self.assertEqual(self.sleep.call_args_list, [call(n) for n in range(1, 8)])

    def test_unrelated_4xx_fail_immediately(self):
        for status, code in ((400, "invalid_key"), (401, "unauthorized"), (404, "not_found"),
                             (429, "rate_limited"), (400, TIMEOUT)):
            with self.subTest(status=status, code=code):
                self.sshkey.reset_mock()
                error = api.ApiError(status, code, "")
                self.sshkey.side_effect = error
                with self.assertRaises(api.ApiError) as caught:
                    ssh_sync.setup("bx")
                self.assertIs(caught.exception, error)
                self.sshkey.assert_called_once()
        self.sleep.assert_not_called()

    def test_unrelated_5xx_fail_immediately(self):
        for status in (500, 504, 505, 525):
            with self.subTest(status=status):
                self.sshkey.reset_mock()
                error = api.ApiError(status, "internal_error", "internal_error")
                self.sshkey.side_effect = error
                with self.assertRaises(api.ApiError) as caught:
                    ssh_sync.setup("bx")
                self.assertIs(caught.exception, error)
                self.sshkey.assert_called_once()
        self.sleep.assert_not_called()

    def test_non_outage_error_fails_immediately(self):
        error = OffboxError("missing key")
        self.sshkey.side_effect = error
        with self.assertRaises(OffboxError) as caught:
            ssh_sync.setup("bx")
        self.assertIs(caught.exception, error)
        self.sshkey.assert_called_once()
        self.sleep.assert_not_called()

    def test_resume_bring_up_recovers_from_sshkey_timeout(self):
        self.sshkey.side_effect = [api.ApiError(500, TIMEOUT, TIMEOUT), READY]
        state = {"state": "running", "type": "large"}
        with patch.object(api, "wait_state", return_value=state), patch.object(ssh_sync, "wait_ssh") as wait:
            got = lease._bring_up_resumed(None, "bx", state, False)
        self.assertEqual(got, state)
        self.assertEqual(self.sshkey.call_count, 2)
        wait.assert_called_once_with("bx")

    def test_exhausted_resume_setup_keeps_network_outage(self):
        self.sshkey.side_effect = api.NetworkError("connection reset")
        state = {"state": "running", "type": "large"}
        with patch.object(api, "wait_state", return_value=state), patch.object(ssh_sync, "wait_ssh") as wait:
            with self.assertRaises(lease.BoxNotReady) as caught:
                lease._bring_up_resumed(None, "bx", state, False)
        self.assertTrue(caught.exception.outage)
        self.assertEqual(caught.exception.code, 90)
        self.assertIn("ssh key setup failed for bx", str(caught.exception))
        self.assertEqual(self.sshkey.call_count, 8)
        wait.assert_not_called()

    def test_resume_unresolved_wrap_keeps_outage(self):
        self.sshkey.side_effect = api.NetworkError("connection reset")
        with self.assertRaises(OffboxError) as setup_error:
            ssh_sync.setup("bx")
        with patch.object(lease, "_bring_up", side_effect=setup_error.exception):
            with self.assertRaises(lease.ResumeUnresolved) as caught:
                lease._bring_up_resumed(None, "bx", None, False)
        self.assertTrue(caught.exception.outage)
        self.assertEqual(caught.exception.code, 90)
        self.assertIn("ssh key setup failed for bx", str(caught.exception))

    def test_explicit_ssh_command_recovers_before_running(self):
        self.sshkey.side_effect = [api.ApiError(500, TIMEOUT, TIMEOUT), READY]
        with patch.object(misc, "require_proven"), patch.object(api, "get", return_value={"state": "running"}), \
                patch.object(lease, "touch"), patch.object(misc.subprocess, "call", return_value=0) as run:
            self.assertEqual(misc.ssh_shell({}, "bx", ["true"]), 0)
        self.assertEqual(self.sshkey.call_count, 2)
        run.assert_called_once_with(ssh_sync.ssh_base("bx") + ["bx", "true"])

    def test_api_post_does_not_retry_gateway_timeout(self):
        self.stack.enter_context(patch.object(api, "_key", return_value="fixture"))
        for operation in (lambda: api._call("POST", "/sandboxes/bx/sshkey", {}, retries=6),
                          lambda: api.cmd_start("bx", "true")):
            with self.subTest(operation=operation):
                self.urlopen.reset_mock()
                self.urlopen.side_effect = urllib.error.HTTPError(
                    "https://example.invalid", 500, "timeout", {},
                    io.BytesIO(json.dumps({"code": TIMEOUT, "message": TIMEOUT}).encode()))
                # cmd_start uses call(), while setup owns the sshkey retry.
                with patch.object(api, "call", api._call):
                    with self.assertRaises(api.ApiError):
                        operation()
                self.urlopen.assert_called_once()
        self.sleep.assert_not_called()
