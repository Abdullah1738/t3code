"""Regenerate fixtures/statev2-denied-commands.json; runs the Python suite once."""
from pathlib import Path
import hashlib
import json
import sys
import unittest
from unittest.mock import patch

tests = Path(__file__).resolve().parents[2] / "harness-hooks" / "tests"
sys.path.insert(0, str(tests))
import test_statev2_guard


def main():
    denied = set()
    classify = test_statev2_guard.guard.classify_detail

    def capture(command, cwd):
        verdict = classify(command, cwd)
        if verdict[0]:
            denied.add(command)
        return verdict

    suite = unittest.defaultTestLoader.loadTestsFromModule(test_statev2_guard)
    with patch.object(test_statev2_guard.guard, "classify_detail", capture):
        result = unittest.TextTestRunner(stream=sys.stderr).run(suite)
    if not result.wasSuccessful():
        return 1
    repo = Path(__file__).resolve().parents[3]
    sources = ["integrations/harness-hooks/src/statev2_guard.py",
               "integrations/harness-hooks/tests/test_statev2_guard.py"]
    fixture = {
        "_regenerate": "bash scripts/release-gate-env.sh python3 -I integrations/opencode-plugins/test/statev2-denied-corpus.py",
        "sourceHashes": {name: hashlib.sha256((repo / name).read_bytes()).hexdigest() for name in sources},
        "testsRun": result.testsRun,
        "skipped": len(result.skipped),
        "commands": sorted(denied),
    }
    target = Path(__file__).with_name("fixtures") / "statev2-denied-commands.json"
    target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(fixture, indent=2) + "\n")
    print(f"Captured {len(denied)} distinct denied commands in {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
