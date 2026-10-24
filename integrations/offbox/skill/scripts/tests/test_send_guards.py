import os
import subprocess
import tempfile
import unittest
from pathlib import Path

BLOCKERS = Path(__file__).resolve().parent.parent / "blockers"


class SendGuardTest(unittest.TestCase):
    """wacli/himalaya shims: agents can read, but sends go through wa/mailsend."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.real = Path(self.tmp.name)
        for name in ("wacli", "himalaya", "himalaya-heal"):
            fake = self.real / name
            fake.write_text(f"#!/bin/sh\necho real-{name} \"$@\"\n")
            fake.chmod(0o755)
        self.env = dict(os.environ, HOME=self.tmp.name, OPENCODE_SESSION_ID="ses_test",
                        PATH=f"{BLOCKERS}:{self.real}:/usr/bin:/bin")

    def tearDown(self):
        self.tmp.cleanup()

    def run_shim(self, name, *args, env=None):
        return subprocess.run([str(BLOCKERS / name), *args], env=env or self.env,
                              capture_output=True, text=True, timeout=10)

    def assert_blocked(self, name, *args):
        result = self.run_shim(name, *args)
        self.assertEqual(result.returncode, 2, (args, result.stdout, result.stderr))
        self.assertIn("Blocked:", result.stderr)
        self.assertEqual(result.stdout, "")

    def assert_passes(self, name, *args):
        result = self.run_shim(name, *args)
        self.assertEqual(result.returncode, 0, (args, result.stderr))
        self.assertEqual(result.stdout.strip(), " ".join([f"real-{name}", *args]))

    def test_wacli_sends_are_blocked(self):
        for args in (["send", "text", "--to", "x@s.whatsapp.net", "--message", "hi"],
                     ["--json", "send", "file", "--to", "x", "--file", "/tmp/a"],
                     ["--store", "/tmp/s", "--timeout", "5s", "send", "text"],
                     ["poll", "vote", "--chat", "x"],
                     ["messages", "forward", "--id", "1"],
                     ["messages", "edit", "--id", "1"],
                     ["messages", "revoke", "--id", "1"],
                     ["messages", "delete", "--id", "1"]):
            self.assert_blocked("wacli", *args)
        self.assertIn("wa draft", self.run_shim("wacli", "send", "text").stderr)

    def test_wacli_reads_pass(self):
        for args in (["--json", "chats", "list"], ["messages", "list", "--chat", "x"],
                     ["messages", "delete", "--id", "1", "--for-me"], ["--read-only", "media", "download"],
                     ["auth", "status", "--json"], ["--store", "send", "chats", "list"]):
            self.assert_passes("wacli", *args)

    def test_himalaya_sends_are_blocked(self):
        for name in ("himalaya", "himalaya-heal"):
            for args in (["message", "compose", "-a", "icloud", "-t", "a@x.com", "-s", "Hi", "--body", "x", "--send"],
                         ["message", "reply", "-a", "gmail", "-m", "Inbox", "12", "--body=ok", "--send"],
                         ["message", "forward", "12", "-t", "b@x.com", "--send"],
                         ["-a", "fund", "message", "send", "--", "/tmp/m.eml"],
                         ["message", "add", "-m", "Sent", "--send", "--", "/tmp/m.eml"],
                         ["smtp", "send", "--mail-from", "a@x", "--rcpt-to", "b@x"],
                         ["smtp", "raw"],
                         ["gmail", "messages", "send"], ["gmail", "drafts", "send"],
                         ["msgraph", "message", "send"], ["jmap", "submission", "create"],
                         # aliases, prefixes and option aliases himalaya accepts
                         ["msg", "send", "--", "/tmp/f.eml"], ["--log", "off", "message", "send", "--", "/tmp/f.eml"],
                         ["mess", "sen", "--", "/tmp/f.eml"], ["msg", "s"], ["-aicloud", "message", "send"],
                         ["--account=fund", "message", "send"], ["sm", "raw"], ["jm", "query"],
                         ["gmail", "msg", "se"], ["gmail", "draft", "s"], ["msgraph", "msg", "send"],
                         # the hidden plural alias himalaya 2.1 also takes
                         ["messages", "send", "--", "/tmp/f.eml"], ["messages", "s"],
                         ["msg", "save", "-m", "Sent", "--send", "--", "/tmp/f.eml"],
                         ["message", "compose", "--body", "--send", "-t", "a@x.com"], ["--", "message", "send"]):
                self.assert_blocked(name, *args)
        self.assertIn("mailsend", self.run_shim("himalaya", "message", "send").stderr)

    def test_himalaya_reads_and_drafts_pass(self):
        for name in ("himalaya", "himalaya-heal"):
            for args in (["envelope", "list", "-a", "gmail", "-m", "Inbox", "-s", "20", "--json"],
                         ["message", "read", "-a", "icloud", "-m", "Inbox", "70334"],
                         ["message", "compose", "-a", "icloud", "-t", "a@x.com", "-s", "send", "--body", "send"],
                         ["message", "move", "-a", "icloud", "-f", "Inbox", "-t", "Archive", "5"],
                         ["message", "add", "-m", "Sent Messages", "-f", "seen", "--", "/tmp/m.eml"],
                         ["attachment", "download", "-a", "gmail", "-m", "Inbox", "-d", "/tmp", "7"],
                         ["envelope", "list", "-a", "gmail", "subject", "send"], ["msg", "read", "12"],
                         ["messages", "read", "12"],
                         ["--log", "send", "envelope", "list"], ["message", "save", "-m", "Sent", "--", "/tmp/m.eml"],
                         ["message", "compose", "--body=--sendmail", "-t", "a@x.com"]):
                self.assert_passes(name, *args)

    def test_outside_agent_sessions_everything_passes(self):
        env = dict(self.env)
        env.pop("OPENCODE_SESSION_ID")
        result = self.run_shim("wacli", "send", "text", "--to", "x", env=env)
        self.assertEqual(result.returncode, 0)
        self.assertIn("real-wacli send text", result.stdout)
        result = self.run_shim("himalaya", "message", "send", env=env)
        self.assertEqual(result.returncode, 0)

    def test_missing_real_binary(self):
        env = dict(self.env, PATH=f"{BLOCKERS}:/usr/bin:/bin")
        result = self.run_shim("wacli", "chats", "list", env=env)
        self.assertEqual(result.returncode, 127)


if __name__ == "__main__":
    unittest.main()
