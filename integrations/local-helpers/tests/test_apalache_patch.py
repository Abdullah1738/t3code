"""Check the patch against the unmodified v0.62.4 server source."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


HERE = Path(__file__).resolve().parents[1]


class ApalachePatchTest(unittest.TestCase):
    def test_patch_applies_once_to_pinned_source(self):
        patch = HERE / 'apalache/loopback.patch'
        with tempfile.TemporaryDirectory(prefix='apalache-patch-test-') as temp:
            source = Path(temp) / 'source'
            shutil.copytree(HERE / 'tests/fixtures/apalache', source)
            for args in (['--check'], []):
                result = subprocess.run(['git', 'apply', *args, str(patch)],
                                        cwd=source, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            again = subprocess.run(['git', 'apply', '--check', str(patch)],
                                   cwd=source, capture_output=True, text=True)
            self.assertNotEqual(again.returncode, 0)
