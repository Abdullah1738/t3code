import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


PKG = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("zsh") and shutil.which("rsync"), "installer needs zsh and rsync")
class InstallTests(unittest.TestCase):
    def test_retired_wrappers_removed_only_on_real_install(self):
        with tempfile.TemporaryDirectory() as temp:
            destination = Path(temp) / ".local/share/harness-hooks"
            blockers = destination / "coord-blockers"
            blockers.mkdir(parents=True)
            (blockers / "aws").write_text("stale wrapper")
            shim = destination / "src/coord_shim.py"
            shim.parent.mkdir()
            shim.write_text("stale shim")
            unrelated = destination / "keep.txt"
            unrelated.write_text("preserved")
            env = {**os.environ, "HOME": temp}
            install = [shutil.which("zsh"), "-f", str(PKG / "install.zsh")]
            dry = subprocess.run([*install, "--dry-run"], env=env, capture_output=True, text=True, check=True)
            self.assertIn("remove " + str(blockers), dry.stdout)
            self.assertTrue(blockers.exists())
            self.assertTrue(shim.exists())
            subprocess.run(install, env=env, capture_output=True, text=True, check=True)
            self.assertFalse(blockers.exists())
            self.assertFalse(shim.exists())
            self.assertEqual(unrelated.read_text(), "preserved")
            self.assertTrue((destination / "src/engine.py").exists())
