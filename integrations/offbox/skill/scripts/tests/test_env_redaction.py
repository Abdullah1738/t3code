"""--env NAME=VALUE never reaches offbox.log (31 Oct, Crpko #1057: a LocalStack token was logged four times)."""
import contextlib
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import cli, common, redact  # noqa: E402
from test_capacity import Isolated  # noqa: E402

SECRET = "ls-S3cretValue-123"


class RedactArgvTests(unittest.TestCase):
    def test_values_are_redacted_in_every_form(self):
        argv = ["run", "--env", f"LOCALSTACK_AUTH_TOKEN={SECRET}", f"--env=B={SECRET}", "--en", f"C={SECRET}",
                f"--e=D={SECRET}", "--env", f"E=a={SECRET}", "--", "true"]
        out = redact.redact_argv(argv)
        self.assertNotIn(SECRET, " ".join(out))
        self.assertEqual(out, ["run", "--env", "LOCALSTACK_AUTH_TOKEN=<redacted>", "--env=B=<redacted>", "--en",
                               "C=<redacted>", "--e=D=<redacted>", "--env", "E=<redacted>", "--", "true"])

    def test_by_name_and_other_args_are_unchanged(self):
        argv = ["run", "--env", "LOCALSTACK_AUTH_TOKEN", "--env=GOFLAGS", "--include", "a=b", "--step", "X=1 make",
                "--env"]
        self.assertEqual(redact.redact_argv(argv), argv)


class LogLineTests(Isolated):
    def main(self, argv):
        err = io.StringIO()
        with patch("offbox_lib.identity.whoami", return_value=self.me), \
                patch.object(cli, "cmd_run", return_value=0) as run, contextlib.redirect_stderr(err):
            rc = cli.main(argv)
        return rc, run, err.getvalue()

    def test_name_value_argv_never_reaches_offbox_log(self):
        rc, run, err = self.main(["run", "--remote", "--env", f"LOCALSTACK_AUTH_TOKEN={SECRET}",
                                  f"--env=GOTOOLCHAIN=go1.24.0", "--", "npm", "run", "localstack:environment"])
        self.assertEqual(rc, 0)
        self.assertEqual(run.call_args[0][0].env, [f"LOCALSTACK_AUTH_TOKEN={SECRET}", "GOTOOLCHAIN=go1.24.0"])
        text = Path(common.LOG_PATH).read_text()
        self.assertNotIn(SECRET, text)
        self.assertIn("LOCALSTACK_AUTH_TOKEN=<redacted>", text)
        self.assertIn("--env=GOTOOLCHAIN=<redacted>", text)
        self.assertIn("export LOCALSTACK_AUTH_TOKEN=...; offbox run --env LOCALSTACK_AUTH_TOKEN", err)
        self.assertNotIn(SECRET, err)
        self.assertNotIn("GOTOOLCHAIN", err)

    def test_by_name_form_prints_no_warning(self):
        rc, _, err = self.main(["run", "--env", "LOCALSTACK_AUTH_TOKEN", "--", "true"])
        self.assertEqual(rc, 0)
        self.assertEqual(err, "")
        self.assertIn("'--env', 'LOCALSTACK_AUTH_TOKEN'", Path(common.LOG_PATH).read_text())


if __name__ == "__main__":
    unittest.main()
