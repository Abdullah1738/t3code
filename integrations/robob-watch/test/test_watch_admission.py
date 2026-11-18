import os

# Before any helper loads: the send guards refuse live sends under this marker, and conftest.py sets it for pytest only.
os.environ.setdefault("ROBOB_TEST", "1")
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest


class ReplayProducerAdmissionTest(unittest.TestCase):
    def test_private_check_state_is_not_written_by_replaced_attempts(self):
        root = Path(__file__).resolve().parents[1]
        producers = [("assist-offers/offers.py", "atomic"), ("inbox-triage/triage.py", "atomic"),
                     ("money-cases/cases.py", "write_json"), ("python-shadow/check.py", "save")]
        for relative, writer in producers:
            with self.subTest(producer=relative), tempfile.TemporaryDirectory() as scratch:
                wdir = Path(scratch) / "watchers" / "fixture"
                wdir.mkdir(parents=True)
                sqlite3.connect(str(Path(scratch) / "relay-lock.sqlite")).close()
                output = wdir / "private-outbox.json"
                env = dict(os.environ, ROBOB_TEST="1", WATCH_DIR=str(wdir), WATCH_RUN="original", WATCH_ATTEMPT="original-attempt")
                program = ("import importlib.util; from pathlib import Path; "
                           f"spec=importlib.util.spec_from_file_location('fixture', {str(root / 'checks' / relative)!r}); "
                           "module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); "
                           f"module.{writer}(Path({str(output)!r}), {{'event':'PRIVATE'}})")
                for admitted in [None, {"run": "replacement", "attempt": "replacement-attempt"},
                                 {"run": "original", "attempt": "original-attempt", "accepted": True}]:
                    (wdir / "state.json").write_text(json.dumps({"admitted_run": admitted}))
                    result = subprocess.run(["/usr/bin/python3", "-I", "-c", program], env=env,
                                            capture_output=True, text=True, timeout=15)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertFalse(output.exists(), relative)
                (wdir / "state.json").write_text(json.dumps({"admitted_run": {"run": "original", "attempt": "original-attempt"}}))
                result = subprocess.run(["/usr/bin/python3", "-I", "-c", program], env=env,
                                        capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(output.read_text()), {"event": "PRIVATE"})
