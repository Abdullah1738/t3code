import hashlib
import hmac
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch

import test_engine


SRC = Path(__file__).resolve().parents[1] / "src"
engine = test_engine.engine


class AuditKeyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.state = test_engine.State()
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), test_engine.Handler)
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
        self.state.identities[("audit-session", None)] = {
            "resolution": "resolved", "robobThreadId": "audit-thread",
            "parentThreadId": None, "rootThreadId": "audit-thread",
            "model": {"model": "test-model"},
        }
        self.state_dir = self.root / "state"
        self.state_dir.mkdir(mode=0o700)
        self.key = self.state_dir / "command-identity.key"
        classifier = self.root / "classifier.py"
        classifier.write_text(
            'import json,sys\n'
            'cmd=json.loads(sys.stdin.readline())["cmd"]\n'
            'print(json.dumps({"heavy":True,"rule":"pkg-install",'
            '"why":"installation","rewrite":"offbox run -- "+cmd}))\n'
        )
        offbox = self.root / "offbox"
        offbox.touch()
        self.env = {
            **os.environ,
            "HOME": str(self.root),
            "HARNESS_HOOKS_STATE_DIR": str(self.state_dir),
            "HARNESS_HOOKS_CONTROL_URL": f"http://127.0.0.1:{self.server.server_port}",
            "HARNESS_HOOKS_TOKEN_FILE": str(self.root / "absent-token"),
            "HARNESS_HOOKS_CLASSIFIER": str(classifier),
            "HARNESS_HOOKS_OFFBOX_BIN": str(offbox),
            "OFFBOX_STATE_DIR": str(self.root / "offbox-state"),
            "OFFBOX_GATE_MODE": "enforce",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        self.env.pop("HARNESS_HOOKS_PROVIDER_INSTANCE", None)

    def run_adapter(self, harness, command):
        event = {"hook_event_name": "PreToolUse", "tool_name": "Bash",
                 "session_id": "audit-session", "cwd": str(self.root),
                 "tool_input": {"command": command}}
        run = subprocess.run([sys.executable, str(SRC / (harness + ".py"))],
                             input=json.dumps(event), text=True, capture_output=True,
                             env=self.env, timeout=5, check=True)
        self.assertEqual(run.stderr, "")
        self.assertTrue(run.stdout, "adapter swallowed the already-computed denial")
        output = json.loads(run.stdout)["hookSpecificOutput"]
        self.assertEqual(output["permissionDecision"], "deny")
        self.assertIn("offbox run -- npm ci", output["permissionDecisionReason"])

    def records(self):
        path = self.state_dir / "decisions.jsonl"
        self.assertTrue(path.exists(), "decision was not audited")
        raw = path.read_text()
        self.assertNotIn("sensitive-command-argument", raw)
        self.assertNotIn("sensitive-key", raw)
        return [json.loads(line) for line in raw.splitlines()]

    def test_bad_existing_keys_preserve_denial_and_audit_for_both_adapters(self):
        cases = {
            "missing-target": lambda: self.key.symlink_to(self.root / "absent-key"),
            "empty": lambda: self.key.write_bytes(b""),
            "truncated": lambda: self.key.write_bytes(b"sensitive-key"),
            "oversized": lambda: self.key.write_bytes(b"sensitive-key" + b"x" * 25),
            "insecure": lambda: (self.key.write_bytes(b"sensitive-key" + b"x" * 19), self.key.chmod(0o644)),
        }
        for name, setup in cases.items():
            for harness in ("claude", "codex"):
                with self.subTest(key=name, harness=harness):
                    self.key.unlink(missing_ok=True)
                    log = self.state_dir / "decisions.jsonl"
                    log.unlink(missing_ok=True)
                    setup()
                    if name in ("empty", "truncated", "oversized"):
                        self.key.chmod(0o600)
                    self.run_adapter(harness, "npm ci sensitive-command-argument")
                    records = self.records()
                    self.assertEqual(len(records), 1)
                    row = records[0]
                    self.assertEqual(row["decision"], "deny")
                    self.assertEqual(row["rule"], "pkg-install")
                    self.assertEqual(row["harness"], harness)
                    self.assertIsNone(row["cmd"])
                    self.assertIsNone(row["cmd_hmac_sha256"])
                    self.assertEqual(row["audit_error"], "command-key-unavailable")

    def test_missing_key_is_created_and_produces_a_valid_hmac(self):
        command = "npm ci sensitive-command-argument"
        for harness in ("claude", "codex"):
            with self.subTest(harness=harness):
                self.key.unlink(missing_ok=True)
                (self.state_dir / "decisions.jsonl").unlink(missing_ok=True)
                self.run_adapter(harness, command)
                row, = self.records()
                self.assertEqual(row["decision"], "deny")
                self.assertEqual(self.key.stat().st_mode & 0o077, 0)
                self.assertEqual(row["cmd_hmac_sha256"], hmac.new(
                    self.key.read_bytes(), command.encode(), hashlib.sha256).hexdigest())
                self.assertIsNone(row["audit_error"])

    def test_key_error_does_not_discard_policy_error_or_log_exception_text(self):
        for failure in (ValueError("sensitive-key"), FileNotFoundError("sensitive-key"),
                        PermissionError("sensitive-key")):
            with self.subTest(failure=type(failure).__name__):
                (self.state_dir / "decisions.jsonl").unlink(missing_ok=True)
                with patch.dict(os.environ, {"HARNESS_HOOKS_STATE_DIR": str(self.state_dir)}), \
                     patch.object(engine, "_command_identity_key", side_effect=failure):
                    engine._log(harness="claude", event="PreToolUse", tool="Bash",
                                command="npm ci sensitive-command-argument", decision="deny",
                                rule="pkg-install", error="TimeoutExpired")
                row, = self.records()
                self.assertEqual(row["decision"], "deny")
                self.assertEqual(row["error"], "TimeoutExpired")
                self.assertEqual(row["audit_error"], "command-key-unavailable")
                self.assertIsNone(row["cmd_hmac_sha256"])

    def test_unencodable_command_still_audits_without_its_contents(self):
        with patch.dict(os.environ, {"HARNESS_HOOKS_STATE_DIR": str(self.state_dir)}):
            engine._log(harness="codex", event="PreToolUse", tool="Bash",
                        command="sensitive-command-argument\ud800", decision="deny", rule="pkg-install")
        row, = self.records()
        self.assertEqual(row["decision"], "deny")
        self.assertEqual(row["audit_error"], "command-encoding-error")
        self.assertIsNone(row["cmd_hmac_sha256"])


if __name__ == "__main__":
    unittest.main()
