import os

# Before any helper loads: the send guards refuse live sends under this marker, and conftest.py sets it for pytest only.
os.environ.setdefault("ROBOB_TEST", "1")
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import warnings
from unittest import mock


class ArchiveBusy(unittest.TestCase):
    def setUp(self):
        warning_filter = warnings.catch_warnings()
        warning_filter.__enter__()
        self.addCleanup(warning_filter.__exit__, None, None, None)
        warnings.simplefilter("ignore", ResourceWarning)
        temp = tempfile.TemporaryDirectory(prefix="ultra-lift-test-")
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        (root / "accounts.json").write_text(json.dumps([{"email": "fixture@example.invalid", "conn": "fixture"}]))
        env = mock.patch.dict(os.environ, {"WATCH_DIR": str(root)})
        env.start(); self.addCleanup(env.stop)
        spec = importlib.util.spec_from_file_location("ultra_under_test", Path(__file__).resolve().parents[1] / "watchers/claude-ultra-5h-lift/check.py")
        self.check = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.check)
        self.state = root / "lift-state.json"
        self.state.write_text('{"lifted":{},"fail_runs":0}')
        self.before = self.state.read_bytes()
        for name, value in {"tokens": {}, "usage": {"five_hour": {}, "limits": [{"kind": "session"}]}}.items():
            patch = mock.patch.object(self.check, name, return_value=value)
            patch.start(); self.addCleanup(patch.stop)

    def test_msgs_timeout_returns_busy_without_advancing_state(self):
        error = io.StringIO()
        with mock.patch.object(self.check.subprocess, "run", side_effect=subprocess.TimeoutExpired("fixture", 20)), contextlib.redirect_stderr(error):
            self.assertEqual(self.check.main(), 75)
        self.assertEqual(error.getvalue(), "busy: msgs: search gave up after 20s\n")
        self.assertEqual(self.state.read_bytes(), self.before)

    def test_other_search_errors_keep_existing_behavior(self):
        with mock.patch.object(self.check.subprocess, "run", side_effect=OSError("fixture")):
            self.assertEqual(self.check.main(), 0)
        self.assertEqual(json.loads(self.state.read_text())["fail_runs"], 1)


if __name__ == "__main__":
    unittest.main()
