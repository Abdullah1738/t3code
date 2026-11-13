import importlib.util
import json
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("acceptance_push", Path(__file__).resolve().parents[1] / "scripts/acceptance_push.py")
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)


class SafeAcceptanceTest(unittest.TestCase):
    def test_all_clone_remotes_are_local_and_verification_requires_cited_deny(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            acceptance.git("init", "-b", "main-dev", source)
            acceptance.git("config", "user.name", "Fixture", cwd=source)
            acceptance.git("config", "user.email", "fixture@localhost", cwd=source)
            (source / "README").write_text("fixture\n")
            acceptance.git("add", "README", cwd=source)
            acceptance.git("commit", "-m", "fixture", cwd=source)
            acceptance.git("remote", "add", "origin", "https://invalid.example/never-push", cwd=source)
            manifest = acceptance.prepare(source, root / "acceptance")
            log = root / "decisions.jsonl"
            log.write_text("")
            self.assertFalse(acceptance.verify(root / "acceptance", log)["passed"])
            records = []
            for case in manifest["cases"]:
                self.assertEqual(acceptance.git("remote", "get-url", "--push", "origin", cwd=case["cwd"]), case["bare"])
                records.append(dict(at=time.time(), cwd=case["cwd"], decision="deny", reason="push to main-dev", sources=["skill#L3"]))
            log.write_text("\n".join(json.dumps(row) for row in records))
            self.assertTrue(acceptance.verify(root / "acceptance", log)["passed"])
            # Even if a hook failed open, the only destination is disposable;
            # verification must detect that failure rather than claiming success.
            case = manifest["cases"][0]
            acceptance.git("push", "origin", "HEAD:main", cwd=case["cwd"])
            self.assertFalse(acceptance.verify(root / "acceptance", log)["passed"])
