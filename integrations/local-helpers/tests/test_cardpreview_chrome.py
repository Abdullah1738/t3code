"""Chrome discovery for card previews, isolated from the user's home."""
import importlib.machinery
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parent.parent
PREVIEW = ROOT / "libexec/card-preview/cardpreview.py"
QCARD = ROOT / "bin/qcard"
NO_CHROME = "cardpreview: no chrome-headless-shell (Robob's ~/.robob/tools/chrome-headless-shell); see taste chrome"


def load(path, name):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class CardPreviewChromeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.env = mock.patch.dict(os.environ, {"HOME": str(self.home)}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.cp = load(PREVIEW, "preview_test")

    def shell(self, version, executable=True):
        path = self.home / ".robob/tools/chrome-headless-shell/mac-arm64" / version / "chrome-headless-shell"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("#!/bin/sh\nexit 0\n")
        path.chmod(0o755 if executable else 0o644)
        return str(path)

    def taste(self, path, status=0):
        taste = self.home / ".local/bin/taste"
        taste.parent.mkdir(parents=True, exist_ok=True)
        taste.write_text("#!/bin/sh\nprintf '%s\\n' '" + str(path) + "'\nexit " + str(status) + "\n")
        taste.chmod(0o755)

    def test_import_runs_no_subprocess(self):
        with mock.patch("subprocess.run", side_effect=AssertionError("import spawned a process")):
            load(PREVIEW, "preview_import_test")

    def test_newest_numeric_version_and_nonexecutable_are_skipped(self):
        self.shell("9.0.1")
        newest = self.shell("154.0.8037.92")
        self.shell("10.0.0")
        self.shell("999.0.0", executable=False)
        self.shell("1000.not-a-version")
        with mock.patch("subprocess.run", side_effect=AssertionError("taste should not run")):
            self.assertEqual(self.cp.chrome(), newest)

    def test_env_overrides_in_priority_order(self):
        self.shell("154.0.8037.92")
        with mock.patch.dict(os.environ, {"CARD_PREVIEW_CHROME": "/preview", "CHROME_PATH": "/generic"}):
            self.assertEqual(self.cp.chrome(), "/preview")
        with mock.patch.dict(os.environ, {"CARD_PREVIEW_CHROME": "", "CHROME_PATH": "/generic"}):
            self.assertEqual(self.cp.chrome(), "/generic")

    def test_taste_result_must_succeed_and_be_executable(self):
        shell = self.home / "alternate-shell"
        shell.write_text("#!/bin/sh\nexit 0\n")
        shell.chmod(0o755)
        self.taste(shell)
        self.assertEqual(self.cp.chrome(), str(shell))
        shell.chmod(0o644)
        with self.assertRaisesRegex(FileNotFoundError, "no chrome-headless-shell"):
            self.cp.chrome()
        shell.chmod(0o755)
        self.taste(shell, status=1)
        with self.assertRaisesRegex(FileNotFoundError, "no chrome-headless-shell"):
            self.cp.chrome()

    def test_no_fallback_to_playwright_even_if_it_exists(self):
        old = self.home / "Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell"
        old.parent.mkdir(parents=True)
        old.write_text("#!/bin/sh\nexit 0\n")
        old.chmod(0o755)
        with self.assertRaises(FileNotFoundError) as error:
            self.cp.chrome()
        self.assertEqual(str(error.exception), NO_CHROME)
        self.taste(old)
        with self.assertRaises(FileNotFoundError) as error:
            self.cp.chrome()
        self.assertEqual(str(error.exception), NO_CHROME)
        alias = self.home / "alternate-shell"
        alias.symlink_to(old)
        self.taste(alias)
        with self.assertRaises(FileNotFoundError) as error:
            self.cp.chrome()
        self.assertEqual(str(error.exception), NO_CHROME)

    def test_legacy_chrome_attribute_is_lazy(self):
        with mock.patch("subprocess.run", side_effect=AssertionError("import spawned a process")):
            preview = load(PREVIEW, "preview_legacy_test")
        with mock.patch.dict(os.environ, {"CARD_PREVIEW_CHROME": "/legacy-consumer"}):
            self.assertEqual(preview.CHROME, "/legacy-consumer")
        with self.assertRaises(AttributeError):
            getattr(preview, "MISSING")

    def test_screenshot_uses_lazy_resolver(self):
        with mock.patch.dict(os.environ, {"CARD_PREVIEW_CHROME": "/chosen/chrome"}), \
             mock.patch.object(subprocess, "run") as run:
            self.cp.screenshot("source.html", "out.png", 1200, 630)
        self.assertEqual(run.call_args.args[0][0], "/chosen/chrome")
        self.assertIn("--window-size=1200,630", run.call_args.args[0])

    def test_qcard_uses_newest_shell_but_not_preview_override(self):
        newest = self.shell("154.0.8037.92")
        self.shell("9.0.1")
        self.shell("999.0.0", executable=False)
        modules = {"cardpreview": self.cp, "render": types.ModuleType("render")}
        with mock.patch.dict(os.environ, {"CARD_PREVIEW_CHROME": "/preview-only"}), \
             mock.patch.dict(sys.modules, modules), mock.patch.object(sys, "path", sys.path.copy()), \
             mock.patch.object(subprocess, "run") as run:
            qcard = load(QCARD, "qcard_chrome_test")
            run.assert_not_called()
            qcard.shot("/in.html", "/out.png", 1200, 630)
            self.assertEqual(run.call_args.args[0][0], newest)
            self.assertEqual(qcard.CHROME, newest)

    def test_qcard_generic_override_wins(self):
        self.shell("154.0.8037.92")
        modules = {"cardpreview": self.cp, "render": types.ModuleType("render")}
        with mock.patch.dict(os.environ, {"CARD_PREVIEW_CHROME": "/preview-only", "CHROME_PATH": "/qcard"}), \
             mock.patch.dict(sys.modules, modules), mock.patch.object(sys, "path", sys.path.copy()), \
             mock.patch.object(subprocess, "run") as run:
            qcard = load(QCARD, "qcard_override_test")
            qcard.shot("/in.html", "/out.png", 1200, 630)
            self.assertEqual(run.call_args.args[0][0], "/qcard")

    def test_qcard_taste_and_playwright_rejection(self):
        modules = {"render": types.ModuleType("render")}
        with mock.patch.dict(sys.modules, modules), mock.patch.object(sys, "path", sys.path.copy()):
            qcard = load(QCARD, "qcard_taste_test")
        old = self.home / "Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell"
        old.parent.mkdir(parents=True)
        old.write_text("#!/bin/sh\nexit 0\n")
        old.chmod(0o755)
        self.taste(old)
        with self.assertRaisesRegex(FileNotFoundError, "no chrome-headless-shell"):
            qcard.chrome()
        alias = self.home / "alternate-shell"
        alias.symlink_to(old)
        self.taste(alias)
        with self.assertRaisesRegex(FileNotFoundError, "no chrome-headless-shell"):
            qcard.chrome()
        patched = self.home / "other-shell"
        patched.write_text("#!/bin/sh\nexit 0\n")
        patched.chmod(0o755)
        self.taste(patched, status=1)
        with self.assertRaisesRegex(FileNotFoundError, "no chrome-headless-shell"):
            qcard.chrome()
        self.taste(patched)
        self.assertEqual(qcard.chrome(), str(patched))


if __name__ == "__main__":
    unittest.main()
