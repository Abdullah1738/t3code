"""The retired stub never reaches another executable on PATH."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent.parent


class QuintTest(unittest.TestCase):
    def test_retired_stub_refuses_without_fallthrough(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            marker = root / "called"
            later = root / "bin"
            later.mkdir()
            fake = later / "quint"
            fake.write_text('#!/bin/sh\n: > "$MARKER"\n')
            fake.chmod(0o755)
            result = subprocess.run(
                [str(HERE / "bin/quint"), "verify", "x.qnt"],
                env={**os.environ, "HOME": tmp, "PATH": str(HERE / "bin") + ":" + str(later), "MARKER": str(marker)},
                capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr, "QUINT_RETIRED: owner rule 2026-11-21, use the repo's tests\n")
            self.assertFalse(marker.exists())
