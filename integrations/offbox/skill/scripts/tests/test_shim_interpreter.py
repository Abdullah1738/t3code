"""Missing shim interpreters should name the prerequisite, not look like missing sync files."""
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests._env import require_shim_interpreter


class ShimInterpreterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.shim = self.root / 'wacli'

    def test_available_interpreter_with_shebang_arguments_runs(self):
        self.shim.write_text('#!/bin/sh -e\nexit 0\n')
        require_shim_interpreter(self, self.shim)

    def test_missing_or_nonexecutable_interpreter_names_the_fix(self):
        for kind in ('missing', 'nonexecutable'):
            with self.subTest(kind=kind):
                interpreter = self.root / kind
                if kind == 'nonexecutable':
                    interpreter.write_text('#!/bin/sh\n')
                    interpreter.chmod(0o600)
                self.shim.write_text(f'#!{interpreter} -e\nexit 0\n')
                with self.assertRaises(unittest.SkipTest) as skipped:
                    require_shim_interpreter(self, self.shim)
                self.assertEqual(str(skipped.exception),
                                 f"blockers/wacli needs {interpreter}, which this box doesn't have "
                                 "(offbox-base built before Offbox #206; rebuild is #265; or use --template generic)")

    def test_missing_shim_is_not_hidden_as_an_interpreter_skip(self):
        with self.assertRaises(FileNotFoundError):
            require_shim_interpreter(self, self.shim)

    def test_missing_shebang_is_a_failure(self):
        for header in ('', '#!\n', 'echo no-shebang\n'):
            with self.subTest(header=header):
                self.shim.write_text(header)
                with self.assertRaisesRegex(AssertionError, 'has no shebang'):
                    require_shim_interpreter(self, self.shim)
