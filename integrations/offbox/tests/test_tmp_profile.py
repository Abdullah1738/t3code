"""Exercise the profile-only installer path without changing a host or running box."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


INSTALLER = Path(__file__).resolve().parents[1] / "server/install-host.sh"
ENTRY = "lxc.mount.entry = tmpfs tmp tmpfs rw,nosuid,nodev,mode=1777,size=8G,create=dir 0 0"


class TmpProfile(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config = self.root / "raw.lxc"
        self.config.write_text("")
        self.log = self.root / "calls.jsonl"
        incus = self.root / "incus"
        incus.write_text("""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
with open(os.environ['CALLS'], 'a') as f:
    f.write(json.dumps(args) + '\\n')
if os.environ.get('FAIL_AT') == args[1]:
    sys.exit(42)
config = Path(os.environ['RAW_CONFIG'])
if args == ['profile', 'get', 'offbox', 'raw.lxc']:
    print(config.read_text(), end='')
elif args[:4] == ['profile', 'set', 'offbox', 'raw.lxc'] and len(args) == 5:
    config.write_text(args[4])
else:
    raise AssertionError(args)
""")
        incus.chmod(0o755)

    def apply(self, fail_at=""):
        return subprocess.run(
            ["bash", str(INSTALLER), "tmp-profile"], capture_output=True, text=True,
            env={**os.environ, "PATH": str(self.root) + os.pathsep + os.environ["PATH"],
                 "RAW_CONFIG": str(self.config), "CALLS": str(self.log), "FAIL_AT": fail_at},
        )

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_configures_bounded_executable_sticky_tmp_without_restarting_anything(self):
        result = self.apply()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config.read_text(), ENTRY)
        self.assertEqual(self.calls(), [
            ["profile", "get", "offbox", "raw.lxc"],
            ["profile", "set", "offbox", "raw.lxc", ENTRY],
        ])
        result = self.apply()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config.read_text(), ENTRY)
        self.assertEqual(len([c for c in self.calls() if c[1] == "set"]), 1)

    def test_preserves_other_settings_mounts_and_comments(self):
        before = "lxc.log.level = warn\nlxc.mount.entry=/data var/tmp none bind 0 0\n# lxc.mount.entry=x tmp none bind 0 0\n"
        self.config.write_text(before)
        result = self.apply()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config.read_text(), before + ENTRY)

    def test_refuses_existing_tmp_mounts_without_changing_them(self):
        for target in (
            "tmp", "/tmp", "tmp/", "/tmp/", "//tmp//", "./tmp", "tmp/.", "./tmp/./",
            "/tmp/.", "var/../tmp", "/var/../tmp", "var/tmp/../../tmp", "tmp/../tmp",
            "tmp/sub", "/tmp/sub/child", "tmp/sub/../child", "./tmp/sub",
        ):
            for separator in ("=", " = ", "\t=\t"):
                with self.subTest(target=target, separator=separator):
                    before = f"  lxc.mount.entry{separator}/data\t{target} none bind 0 0"
                    self.config.write_text(before)
                    result = self.apply()
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("already mounts /tmp", result.stderr)
                    self.assertEqual(self.config.read_text(), before)
        self.assertTrue(all(c[1] == "get" for c in self.calls()))

    def test_other_normalized_destinations_are_preserved(self):
        for target in ("var/tmp", "var/tmp/sub", "tmp/../var/tmp", "tmpfile", ".tmp", "tmp/.."):
            with self.subTest(target=target):
                before = f"lxc.mount.entry = /data {target} none bind 0 0"
                self.config.write_text(before)
                result = self.apply()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.config.read_text(), before + "\n" + ENTRY)

    def test_own_entry_does_not_hide_a_second_conflicting_mount(self):
        before = ENTRY + "\nlxc.mount.entry = /data /tmp none bind 0 0"
        self.config.write_text(before)
        result = self.apply()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.config.read_text(), before)
        self.assertTrue(all(c[1] == "get" for c in self.calls()))

    def test_conflict_check_consumes_large_configs_under_pipefail(self):
        for padding in ("", "# existing config\n" * 20000):
            with self.subTest(bytes=len(padding)):
                before = "lxc.mount.entry = /data tmp none bind 0 0\n" + padding
                self.config.write_text(before)
                result = self.apply()
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.config.read_text(), before)
        self.assertTrue(all(c[1] == "get" for c in self.calls()))

    def test_read_or_write_errors_are_not_success(self):
        for operation in ("get", "set"):
            with self.subTest(operation=operation):
                result = self.apply(fail_at=operation)
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertEqual(self.config.read_text(), "")


if __name__ == "__main__":
    unittest.main()
