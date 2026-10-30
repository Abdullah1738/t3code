"""Offline tests: the environment box runs get from build_env (no network, no real AWS state)."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import runs  # noqa: E402


def build(extra, mac_env):
    with patch.dict("os.environ", mac_env, clear=True):
        return runs.build_env(extra)


class BoxEnvTest(unittest.TestCase):
    def test_default_sets_ci_and_disables_imds(self):
        env, explicit = build([], {})
        self.assertEqual(env.get("CI"), "1")
        self.assertEqual(env.get("AWS_EC2_METADATA_DISABLED"), "true")
        self.assertEqual(explicit, [])

    def test_explicit_value_overrides_default(self):
        env, explicit = build(["AWS_EC2_METADATA_DISABLED=false"], {})
        self.assertEqual(env["AWS_EC2_METADATA_DISABLED"], "false")
        self.assertEqual(explicit, ["AWS_EC2_METADATA_DISABLED"])

    def test_bare_name_uses_mac_value(self):
        env, explicit = build(["AWS_EC2_METADATA_DISABLED"], {"AWS_EC2_METADATA_DISABLED": "false"})
        self.assertEqual(env["AWS_EC2_METADATA_DISABLED"], "false")
        self.assertEqual(explicit, ["AWS_EC2_METADATA_DISABLED"])

    def test_bare_name_unset_on_mac_keeps_default(self):
        env, explicit = build(["AWS_EC2_METADATA_DISABLED"], {})
        self.assertEqual(env["AWS_EC2_METADATA_DISABLED"], "true")
        self.assertEqual(explicit, [])

    def test_mac_aws_credentials_not_forwarded_without_env(self):
        mac = {"AWS_PROFILE": "work", "AWS_SECRET_ACCESS_KEY": "s3cret", "AWS_ACCESS_KEY_ID": "AKIAEXAMPLE"}
        env, explicit = build([], mac)
        for k in mac:
            self.assertNotIn(k, env)
        self.assertEqual(explicit, [])

    def test_explicit_list_holds_only_user_named_vars(self):
        mac = {"AWS_PROFILE": "work", "TZ": "Asia/Dubai"}
        env, explicit = build(["GOFLAGS=-count=1", "AWS_PROFILE"], mac)
        self.assertEqual(explicit, ["GOFLAGS", "AWS_PROFILE"])
        self.assertNotIn("AWS_EC2_METADATA_DISABLED", explicit)
        self.assertEqual(env["AWS_PROFILE"], "work")
        self.assertEqual(env["TZ"], "Asia/Dubai")

    def test_allowlisted_var_is_forwarded(self):
        env, _ = build([], {"TZ": "Asia/Dubai"})
        self.assertEqual(env["TZ"], "Asia/Dubai")


if __name__ == "__main__":
    unittest.main()
