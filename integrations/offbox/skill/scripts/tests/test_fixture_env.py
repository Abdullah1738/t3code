"""The shared fixtures must fail loudly before a test can reexec the CLI."""
import contextlib
import os
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests._env import LEAKY_VARS, clean_env, isolate_home
from offbox_lib import common, home


class FixtureEnvironmentTests(unittest.TestCase):
    def test_clean_env_removes_inherited_markers_but_keeps_explicit_overrides(self):
        with patch.dict(os.environ, dict.fromkeys(LEAKY_VARS, "inherited")):
            env = clean_env(CODEX_THREAD_ID="explicit", FIXTURE_VALUE="kept")
        self.assertEqual(env["CODEX_THREAD_ID"], "explicit")
        self.assertEqual(env["FIXTURE_VALUE"], "kept")
        self.assertTrue(all(name not in env for name in LEAKY_VARS if name != "CODEX_THREAD_ID"))

    def test_home_files_are_empty_and_failover_cannot_exec(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.ExitStack() as stack:
            isolate_home(stack, directory)
            for name in ("SERVER_CFG", "BACKEND_STATE", "BACKEND_PATH", "HOME_FAILURES"):
                self.assertTrue(getattr(common, name).is_relative_to(Path(directory)))
                self.assertFalse(getattr(common, name).exists())
            self.assertIsNone(common.home_config())
            self.assertEqual(common.home_state(), {"state": "home_up"})
            self.assertIsNone(home.probe())
            with patch.object(os, "execve", side_effect=AssertionError("real exec reached")) as execute:
                with self.assertRaisesRegex(AssertionError, "test reached home.fail_over"):
                    home.fail_over("down", ["run", "--", "true"])
                execute.assert_not_called()

    def test_failover_fixture_can_opt_out_without_reading_installed_config(self):
        probe, failover = home.probe, home.fail_over
        with tempfile.TemporaryDirectory() as directory, contextlib.ExitStack() as stack:
            isolate_home(stack, directory, guard_failover=False)
            self.assertIs(home.probe, probe)
            self.assertIs(home.fail_over, failover)
            self.assertIsNone(common.home_config())
