"""otp-watch skips GitHub/Linear repo notification mail but still alerts on real sign-in mail."""
import datetime
import importlib.machinery
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
OTP_WATCH = os.path.join(HERE, "..", "libexec", "mail", "otp-watch.py")

# otp-watch imports mail_oauth at load time; stub it so the test never touches real accounts.
sys.modules["mail_oauth"] = types.ModuleType("mail_oauth")
sys.modules["mail_oauth"].himalaya_heal = lambda *a, **k: None


def load_otp_watch():
    loader = importlib.machinery.SourceFileLoader("otp_watch_under_test", OTP_WATCH)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


otp = load_otp_watch()


def raw_mail(headers, body):
    lines = [f"{k}: {v}" for k, v in headers]
    return "\n".join(lines) + "\n\n" + body + "\n"


GH_REPO_HEADERS = [
    ("From", '"linear-code[bot]" <notifications@github.com>'),
    ("To", "ardudeisepic@outlook.com"),
    ("List-ID", "Equicom-Crypto/backoffice-frontend <backoffice-frontend.Equicom-Crypto.github.com>"),
    ("Precedence", "list"),
    ("X-GitHub-Reason", "review_requested"),
    ("Content-Type", "text/plain; charset=utf-8"),
]


class OtpWatchTest(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix="otp-watch-test-")
        otp.STATE_DIR = self.state
        otp.LOG_FILE = os.path.join(self.state, "otp-watch.log")
        self.notify = mock.Mock(return_value=True)
        self._notify_patch = mock.patch.object(otp, "notify", self.notify)
        self._notify_patch.start()

    def tearDown(self):
        self._notify_patch.stop()
        shutil.rmtree(self.state, ignore_errors=True)

    def run_one(self, raw, from_name, from_email, subject):
        now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        envelope = {"envelopes": [{
            "id": "1",
            "message-id": "<t@x>",
            "subject": subject,
            "from": [{"name": from_name, "email": from_email}],
            "date": now,
        }]}

        def fake_heal(args, timeout=None):
            if args[0] == "envelope":
                return subprocess.CompletedProcess(args, 0, json.dumps(envelope), "")
            return subprocess.CompletedProcess(args, 0, raw, "")

        with mock.patch.object(otp.mail_oauth, "himalaya_heal", side_effect=fake_heal):
            seen = {}
            otp.scan_account(seen, "outlook", ["Inbox"], False)
        with open(otp.LOG_FILE) as f:
            log_text = f.read() if os.path.exists(otp.LOG_FILE) else ""
        return self.notify, seen, log_text

    def test_a_github_pr_notification_suppressed(self):
        raw = raw_mail(
            GH_REPO_HEADERS,
            "Review requested. See https://linear.app/crpko/review/fixauth-verify-identity-before-submitting",
        )
        notify, seen, log_text = self.run_one(
            raw, "linear-code[bot]", "notifications@github.com",
            "Re: [Equicom-Crypto/backoffice-frontend] fix(auth): verify identity before submitting action requests CRP-13741 (PR #205)",
        )
        notify.assert_not_called()
        self.assertEqual(len(seen), 1)
        self.assertIn("suppressed repo notification", log_text)

    def test_b_github_comment_with_code_suppressed(self):
        raw = raw_mail(
            [
                ("From", '"Furqan Masood" <notifications@github.com>'),
                ("List-ID", "Equicom-Crypto/crpko_mobile_app <crpko_mobile_app.Equicom-Crypto.github.com>"),
                ("Precedence", "list"),
                ("X-GitHub-Reason", "comment"),
            ],
            "verification code 123 456",
        )
        notify, _, log_text = self.run_one(
            raw, "Furqan Masood", "notifications@github.com",
            "Re: [Equicom-Crypto/crpko_mobile_app] feat: otp screen (PR #332)",
        )
        notify.assert_not_called()
        self.assertIn("suppressed repo notification", log_text)

    def test_c_github_ci_mail_suppressed_with_mixed_case_header(self):
        raw = raw_mail(
            [
                ("From", '"Abdullah" <notifications@github.com>'),
                ("X-Github-Reason", "ci_activity"),
                ("List-ID", "Equicom-Crypto/crpko-devops <crpko-devops.Equicom-Crypto.github.com>"),
                ("Precedence", "list"),
            ],
            "Run failed. https://github.com/Equicom-Crypto/crpko-devops/actions/runs/1?auth=1",
        )
        notify, _, log_text = self.run_one(
            raw, "Abdullah", "notifications@github.com",
            "[Equicom-Crypto/crpko-devops] PR run failed: Terraform dev - fix login role",
        )
        notify.assert_not_called()
        self.assertIn("suppressed repo notification", log_text)

    def test_d_real_github_device_code_still_alerts(self):
        raw = raw_mail(
            [("From", "GitHub <noreply@github.com>"), ("Content-Type", "text/plain; charset=utf-8")],
            "Verification code: 482913",
        )
        notify, _, _ = self.run_one(
            raw, "GitHub", "noreply@github.com", "[GitHub] Please verify your device",
        )
        notify.assert_called_once()
        self.assertTrue(notify.call_args[0][1].startswith("OTP 482913"))

    def test_e_real_github_email_verify_link_still_alerts(self):
        raw = raw_mail(
            [("From", "GitHub <noreply@github.com>"), ("Content-Type", "text/plain; charset=utf-8")],
            "Confirm: https://github.com/users/x/emails/1/confirm_verification/abc?token=1",
        )
        notify, _, _ = self.run_one(
            raw, "GitHub", "noreply@github.com", "[GitHub] Please verify your email address",
        )
        notify.assert_called_once()
        self.assertTrue(notify.call_args[0][1].startswith("Sign-in link email"))

    def test_f_linear_digest_suppressed(self):
        raw = raw_mail(
            [
                ("From", "Linear <notifications@linear.app>"),
                ("List-Unsubscribe", "<https://linear.app/api/unsubscribe?token=x>"),
                ("Content-Type", "text/plain; charset=utf-8"),
            ],
            "Open https://linear.app/crpko/issue/CRP-1/verify-login-flow?auth=1 and code 765432",
        )
        notify, _, log_text = self.run_one(
            raw, "Linear", "notifications@linear.app",
            "Verify login flow - CRP-1 was assigned to you",
        )
        notify.assert_not_called()
        self.assertIn("suppressed repo notification", log_text)

    def test_g_login_for_linear_still_alerts(self):
        raw = raw_mail(
            [("From", "Linear <notifications@linear.app>"), ("Content-Type", "text/plain; charset=utf-8")],
            "Click to sign in: https://linear.app/auth/email/magic?token=abc",
        )
        notify, _, _ = self.run_one(
            raw, "Linear", "notifications@linear.app", "Login for Linear",
        )
        notify.assert_called_once()
        self.assertTrue(notify.call_args[0][1].startswith("Sign-in link email"))

    def test_h_header_only_check(self):
        gh_raw = raw_mail(GH_REPO_HEADERS, "body")
        device_raw = raw_mail(
            [("From", "GitHub <noreply@github.com>"), ("Content-Type", "text/plain; charset=utf-8")],
            "Verification code: 482913",
        )
        self.assertTrue(otp.is_repo_notification("", gh_raw))
        self.assertFalse(otp.is_repo_notification("", device_raw))


if __name__ == "__main__":
    unittest.main()
