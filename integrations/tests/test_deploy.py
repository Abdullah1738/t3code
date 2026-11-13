"""Exercise deploy.zsh against synthetic source files and an isolated HOME."""

import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import unittest


INTEGRATIONS = Path(__file__).resolve().parents[1]
DEPLOY_SCRIPT = INTEGRATIONS / "deploy.zsh"


@unittest.skipUnless(shutil.which("zsh") and shutil.which("rsync"), "requires zsh and rsync")
class DeployTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="deploy-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.pkg = self.root / "integrations"
        self.pkg.mkdir()
        self.script = self.pkg / "deploy.zsh"
        shutil.copy2(DEPLOY_SCRIPT, self.script)
        self.script.chmod(0o755)
        self.source = self.pkg / "robob-watch"
        self.source.mkdir()
        (self.source / "worker.py").write_text("payload\n")
        for relative in ("meds-nag/check.py", "meds-nag/took.py", "forge-workouts/check.py", "gym-nudge/check.py", "activity-digest/check.sh", "activity-digest/summarize.py"):
            path = self.source / "watchers" / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture\n")
        self.dst = self.home / ".local/share/robob-watch"
        self.dst.mkdir(parents=True)
        self.env = {
            "HOME": str(self.home),
            "ZDOTDIR": str(self.home),
            "PATH": os.pathsep.join(dict.fromkeys([
                str(Path(shutil.which("rsync")).parent), "/usr/bin", "/bin",
            ])),
        }

    def enable_node_hook(self):
        # The real startup hook exposed this bug; a plain DEBUG return does not.
        hook = INTEGRATIONS / "local-helpers/libexec/repo-node-pin/init.sh"
        (self.home / ".zshenv").write_text(f". {shlex.quote(str(hook))}\n")
        self.env["ROBOB_REPO_NODE_HELPER"] = str(hook.parent)

    def run_deploy(self, *args, invocation="zsh"):
        command = {
            "zsh": [shutil.which("zsh"), str(self.script)],
            "zsh-f": [shutil.which("zsh"), "-f", str(self.script)],
            "direct": [str(self.script)],
        }[invocation]
        return subprocess.run(
            [*command, *args], cwd=self.root, env=self.env,
            capture_output=True, text=True, timeout=10,
        )

    def test_real_deploy_and_no_change_run_finish_with_success(self):
        self.enable_node_hook()
        for invocation in ("zsh", "zsh-f", "direct"):
            with self.subTest(invocation=invocation):
                result = self.run_deploy("robob-watch", invocation=invocation)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual((self.dst / "worker.py").read_text(), "payload\n")
                self.assertEqual(result.stdout.splitlines()[-1], f"deployed robob-watch to {self.dst}/")

    def test_dry_run_lists_changes_without_writing(self):
        self.enable_node_hook()
        result = self.run_deploy("robob-watch", "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("worker.py", result.stdout)
        self.assertEqual(result.stdout.splitlines()[-1], "dry run: robob-watch")
        self.assertEqual(list(self.dst.iterdir()), [])

    def test_marker_runs_only_after_success_and_never_blocks_deploy(self):
        bun = self.home / ".bun/bin/bun"
        bun.parent.mkdir(parents=True)
        calls = self.root / "marker-calls"
        bun.write_text('#!/bin/sh\nprintf "%s\\n" "$@" >> "$MARKER_CALLS"\nexit 9\n')
        bun.chmod(0o755)
        self.env["MARKER_CALLS"] = str(calls)
        result = self.run_deploy("robob-watch", "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(calls.exists())
        result = self.run_deploy("robob-watch")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("log-marker\n--service\nrobob-watch\n--sha\n", calls.read_text())
        self.assertIn("--step\ndeploy.complete\n", calls.read_text())
        count = calls.read_text().count("log-marker")
        (self.home / ".local/share/coord").write_text("blocked")
        (self.pkg / "coord").mkdir()
        result = self.run_deploy("coord")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls.read_text().count("log-marker"), count)

    def test_usage_returns_two_for_missing_or_unknown_name(self):
        self.enable_node_hook()
        for args in ((), ("unknown",)):
            with self.subTest(args=args):
                result = self.run_deploy(*args)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("usage: deploy.zsh", result.stderr)
                self.assertEqual(result.stdout, "")

    def test_runtime_files_are_preserved_and_excluded(self):
        for relative in ("data/state.json", "logs/run.log", "watchers/one.json", "cache.sqlite", "README.md"):
            with self.subTest(relative=relative):
                src = self.source / relative
                dst = self.dst / relative
                src.parent.mkdir(parents=True, exist_ok=True)
                dst.parent.mkdir(parents=True, exist_ok=True)
                src.write_text("source\n")
                dst.write_text("live state\n")
        result = self.run_deploy("robob-watch")
        self.assertEqual(result.returncode, 0, result.stderr)
        for relative in ("data/state.json", "logs/run.log", "watchers/one.json", "cache.sqlite", "README.md"):
            self.assertEqual((self.dst / relative).read_text(), "live state\n")

    def test_rsync_failure_has_no_success_line(self):
        (self.home / ".local/share/coord").write_text("not a directory\n")
        (self.pkg / "coord").mkdir()
        (self.pkg / "coord/file").write_text("payload\n")
        result = self.run_deploy("coord")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("deployed ", result.stdout)
        self.assertNotIn("dry run:", result.stdout)

    def test_memory_system_reports_success_only_after_extra_installs(self):
        scripts = self.pkg / "memory-system/scripts"
        scripts.mkdir(parents=True)
        (scripts / "com.abdullah.opencode-readonly.plist").write_text("fixture plist\n")
        (scripts / "recall").write_text("#!/bin/sh\necho recall\n")
        installer = scripts / "install_launchagent.sh"
        installer.write_text('echo "launchagent ${1:-install}"\nexit "${FAKE_INSTALL_RC:-0}"\n')
        (self.home / ".local/share/memory-system").mkdir()
        self.enable_node_hook()
        recall = self.home / ".local/bin/recall"

        result = self.run_deploy("memory-system", "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("would install -m 755", result.stdout)
        self.assertIn("launchagent --dry-run", result.stdout)
        self.assertFalse(recall.exists())
        self.assertEqual(result.stdout.splitlines()[-1], "dry run: memory-system")

        result = self.run_deploy("memory-system")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(recall.read_bytes(), (scripts / "recall").read_bytes())
        self.assertEqual(recall.stat().st_mode & 0o777, 0o755)
        self.assertIn("launchagent install", result.stdout)
        self.assertTrue(result.stdout.splitlines()[-1].startswith("deployed memory-system to "))

        self.env["FAKE_INSTALL_RC"] = "7"
        result = self.run_deploy("memory-system")
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertNotIn("deployed ", result.stdout)


if __name__ == "__main__":
    unittest.main()
