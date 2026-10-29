"""Card #14: mailsend refuses a real draft or send under a test run, and a stubbed himalaya still runs."""
import os
import subprocess
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, "..", "helpers", "mailsend")


def run_ms(*args, **extra):
    # Start from a clean env (no inherited test markers) so each case controls the guard itself.
    env = {"HOME": HERE, "PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8", **extra}
    return subprocess.run(["/usr/bin/python3", HELPER, *args], env=env, capture_output=True, text=True, timeout=30)


class MailsendSendGuard(unittest.TestCase):
    def test_draft_refused_under_robob_test_without_stub(self):
        r = run_ms("draft", "-a", "icloud", "-t", "a@example.com", "-s", "x", "--body", "y", ROBOB_TEST="1")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("refused: test run", r.stderr)

    def test_send_refused_under_pytest_marker_without_stub(self):
        r = run_ms("send", "--approved", "0123456789", PYTEST_CURRENT_TEST="test_x (call)")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("refused: test run", r.stderr)

    def test_stubbed_himalaya_is_not_refused(self):
        # With MAILSEND_HIMALAYA injected the guard lets the call through; the stub then fails or succeeds on its own.
        r = run_ms("send", "--approved", "0123456789", ROBOB_TEST="1", MAILSEND_HIMALAYA="/usr/bin/false")
        self.assertNotIn("refused: test run", r.stderr)


if __name__ == "__main__":
    unittest.main()
