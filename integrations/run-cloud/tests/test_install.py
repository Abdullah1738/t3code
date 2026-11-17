"""Installer backups stay outside skill discovery, including in dry runs."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


PACKAGE = Path(__file__).resolve().parents[1]


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def fixture(self, name, override):
        home = self.root / name / "home with spaces"
        live = home / ".config/opencode/skills/run-cloud"
        (live / "scripts").mkdir(parents=True)
        (live / "SKILL.md").write_text("old skill\n")
        (live / "scripts/rcsim.py").write_text("old script\n")
        env = {"HOME": str(home), "PATH": os.environ["PATH"]}
        backup_root = home / ".local/share/run-cloud/backups"
        if override is not None:
            env["RUN_CLOUD_BACKUP_ROOT"] = override
            if override:
                backup_root = Path(override)
        return home, live, env, backup_root

    def install(self, env, *args):
        proc = subprocess.run(["/bin/zsh", "-f", str(PACKAGE / "install.zsh"), *args],
                              env=env, capture_output=True, text=True, timeout=15)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        return proc.stdout

    def snapshot(self):
        return {str(path.relative_to(self.root)): (
                    path.stat().st_mode, path.stat().st_mtime_ns,
                    path.read_bytes() if path.is_file() else None)
                for path in [self.root, *self.root.rglob("*")]}

    def test_install_keeps_old_skill_outside_skills_and_prints_restore_path(self):
        for name, override in [("default", None), ("empty", ""),
                               ("custom", str(self.root / "custom backup root"))]:
            with self.subTest(backup_root=name):
                home, live, env, backup_root = self.fixture(name, override)
                output = self.install(env)
                backups = list(backup_root.glob("skill-*"))
                self.assertEqual(len(backups), 1)
                backup = backups[0]
                self.assertRegex(backup.name, r"^skill-\d{8}-\d{6}$")
                self.assertEqual((backup / "SKILL.md").read_text(), "old skill\n")
                self.assertEqual((backup / "scripts/rcsim.py").read_text(), "old script\n")
                self.assertEqual(list((home / ".config/opencode/skills").glob("*.bak*")), [])
                for path in ["SKILL.md", "scripts/rcsim.py"]:
                    self.assertEqual((live / path).read_bytes(), (PACKAGE / "skill" / path).read_bytes())
                self.assertIn(f"Previous copy kept at {backup}\n", output)
                if override:
                    self.assertFalse((home / ".local/share/run-cloud/backups").exists())

    def test_dry_run_prints_backup_path_without_writing(self):
        for name, override in [("default", None), ("empty", ""),
                               ("custom", str(self.root / "dry run backup root"))]:
            with self.subTest(backup_root=name):
                _, _, env, backup_root = self.fixture(name, override)
                before = self.snapshot()
                output = self.install(env, "--dry-run")
                self.assertEqual(self.snapshot(), before)
                self.assertIn("--dry-run, nothing written", output)
                self.assertRegex(output, r"skill-\d{8}-\d{6}")
                self.assertIn(f"Previous copy would be kept at {backup_root}/skill-", output)

    def test_matching_skill_does_not_create_another_backup(self):
        _, _, env, _ = self.fixture("matching", None)
        self.install(env)
        before = self.snapshot()
        output = self.install(env)
        self.assertIn("nothing to install (live skill already matches)", output)
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
