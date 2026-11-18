"""Every Python test module marks the run as a test under plain unittest, before it loads a helper or spawns."""
import os

# Before any helper loads: the send guards refuse live sends under this marker, and conftest.py sets it for pytest only.
os.environ.setdefault("ROBOB_TEST", "1")
import json
from pathlib import Path
import subprocess
import sys
import unittest

PACKAGE = Path(__file__).resolve().parent.parent
TEST_DIR = PACKAGE / "test"

# Loads one module the way `python3 -m unittest` does and runs none of its tests. An audit hook records every
# package file other than the module itself that is opened, and every process started, while the marker is unset.
PROBE = r"""
import json, os, sys
package, own, name = sys.argv[1:4]
early = []
def hook(event, args):
    if os.environ.get("ROBOB_TEST") == "1":
        return
    if event == "open" and isinstance(args[0], str):
        path = os.path.abspath(args[0])
        if path.startswith(package + os.sep) and os.path.basename(path).split(".")[0] not in (own, "__init__"):
            early.append(path)
    elif event in ("subprocess.Popen", "os.posix_spawn", "os.exec", "os.system"):
        early.append(event)
sys.addaudithook(hook)
import unittest
unittest.main(module=None, argv=["probe", name, "-k", "robob_marker_probe_matches_nothing"], exit=False)
print("__PROBE__" + json.dumps({"loaded": name in sys.modules, "marker": os.environ.get("ROBOB_TEST"), "early": early}))
"""


def test_modules():
    for path in sorted(PACKAGE.rglob("test_*.py")):
        if "node_modules" in path.parts or "__pycache__" in path.parts:
            continue
        # Top-level suites import as the repo's `test` package; other dirs are their own discover top.
        if path.parent == TEST_DIR:
            yield path, PACKAGE, "test." + path.stem
        else:
            yield path, path.parent, path.stem


class RobobTestMarker(unittest.TestCase):
    def test_each_module_sets_the_marker_before_helpers_load(self):
        modules = list(test_modules())
        self.assertGreater(len(modules), 30)
        env = {k: v for k, v in os.environ.items() if k not in ("ROBOB_TEST", "NODE_ENV", "PYTEST_CURRENT_TEST")}
        for path, cwd, name in modules:
            with self.subTest(module=str(path.relative_to(PACKAGE))):
                r = subprocess.run([sys.executable, "-c", PROBE, str(PACKAGE), path.stem, name], cwd=cwd, env=env,
                                   capture_output=True, text=True, timeout=60)
                line = next((l for l in r.stdout.splitlines() if l.startswith("__PROBE__")), None)
                self.assertIsNotNone(line, r.stderr)
                result = json.loads(line[len("__PROBE__"):])
                self.assertTrue(result["loaded"], r.stderr)
                self.assertEqual(result["marker"], "1")
                self.assertEqual(result["early"], [])


if __name__ == "__main__":
    unittest.main()
