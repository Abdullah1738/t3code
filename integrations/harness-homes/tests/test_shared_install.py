"""Exercise install failure recovery with fake launchctl and isolated HOME."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

PKG = Path(__file__).resolve().parent.parent
LABELS = ["com.ardud.shared-mcp-flighty", "com.ardud.shared-mcp-inbody"]


def write(path, text, executable=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    if executable:
        path.chmod(0o755)


def flighty_fixture(home):
    base = home / ".local/share/uv/python/fake-cpython-3.12.99"
    binary = base / "bin/python3.12"
    write(binary, "fixture interpreter\n", executable=True)
    (base / "bin/python").symlink_to("python3.12")
    write(base / "lib/python3.12/stdlib.py", "fixture stdlib\n")
    venv = home / ".local/share/flighty-mcp/.venv"
    write(venv / "pyvenv.cfg", f"home = {base / 'bin'}\nversion_info = 3.12.99\n")
    (venv / "bin").mkdir()
    (venv / "bin/python").symlink_to(binary)
    return base, home / ".local/share/shared-mcp-flighty/python"


@unittest.skipUnless(shutil.which("zsh") and shutil.which("rsync"), "requires installer shell and rsync")
class SharedInstallTests(unittest.TestCase):
    def test_prepare_only_copies_base_and_preserves_unchanged_binary(self):
        with tempfile.TemporaryDirectory(prefix="flighty python ") as tmp:
            root = Path(tmp).resolve()
            home = root / "home"
            base, destination = flighty_fixture(home)
            source_binary = base / "bin/python3.12"
            source_stat = source_binary.stat()
            bin_dir = root / "bin"
            launchctl_log = root / "launchctl.log"
            write(bin_dir / "launchctl", '#!/bin/sh\ntouch "$LAUNCHCTL_LOG"\nexit 99\n', executable=True)
            rsync_log = root / "rsync.log"
            write(bin_dir / "rsync", f"#!{sys.executable}\n" +
                  "import os, subprocess, sys\nfrom pathlib import Path\n" +
                  "with Path(os.environ['RSYNC_LOG']).open('a') as log: log.write(repr(sys.argv[1:])+'\\n')\n" +
                  f"raise SystemExit(subprocess.call([{shutil.which('rsync')!r}, *sys.argv[1:]]))\n", executable=True)
            env = {**os.environ, "HOME": str(home), "TMPDIR": str(root), "RSYNC_LOG": str(rsync_log),
                   "LAUNCHCTL_LOG": str(launchctl_log),
                   "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"]}

            def run():
                result = subprocess.run(["/bin/zsh", "-f", str(PKG / "install.zsh"), "--flighty-python"],
                                        env=env, capture_output=True, text=True, timeout=20)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(result.stdout, f"FULL_DISK_ACCESS_PATH={destination / 'bin/python3.12'}\n")

            run()
            binary = destination / "bin/python3.12"
            self.assertFalse(binary.is_symlink())
            self.assertEqual(binary.read_bytes(), source_binary.read_bytes())
            self.assertEqual((destination / "lib/python3.12/stdlib.py").read_text(), "fixture stdlib\n")
            self.assertTrue((destination / "bin/python").is_symlink())
            before = binary.stat()
            rsync_log.write_text("")
            run()
            self.assertEqual(binary.stat(), before)
            calls = rsync_log.read_text().splitlines()
            self.assertEqual(len(calls), 1)
            self.assertIn("--dry-run", calls[0])
            # Checksum comparison catches drift even with identical sizes/mtimes.
            binary.write_bytes(b"x" * source_binary.stat().st_size)
            os.utime(binary, ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns))
            write(destination / "obsolete", "remove on sync")
            run()
            self.assertEqual(binary.read_bytes(), source_binary.read_bytes())
            self.assertFalse((destination / "obsolete").exists())
            self.assertEqual(source_binary.stat().st_mtime_ns, source_stat.st_mtime_ns)
            self.assertEqual(source_binary.stat().st_ino, source_stat.st_ino)
            self.assertEqual(source_binary.read_text(), "fixture interpreter\n")
            self.assertFalse((home / ".local/share/harness-homes").exists())
            self.assertFalse((home / "Library/LaunchAgents").exists())
            self.assertFalse((home / ".config/opencode").exists())
            self.assertFalse(launchctl_log.exists())

    def test_failure_restores_services_code_and_config(self):
        # Every phase can fail during a reinstall after clients already use HTTP.
        for failure in ("bootstrap", "health", "migration", "generation", "check", "none"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp).resolve()
                home = root / "home"
                pkg = root / "source"
                dst = home / ".local/share/harness-homes"
                state = root / "launchd-state"
                state.mkdir()
                binary_dir = root / "bin"
                oc = home / ".config/opencode/opencode.jsonc"
                write(oc, 'original config with private fixture value\n')
                write(pkg / "install.zsh", (PKG / "install.zsh").read_text())
                write(pkg / "shared/flighty_python.py", (PKG / "shared/flighty_python.py").read_text())
                base, dedicated = flighty_fixture(home)
                for label in LABELS:
                    write(home / f"Library/LaunchAgents/{label}.plist", "old " + label)
                    write(pkg / f"launchd/{label}.plist", "new " + label)
                    write(state / label, "running old service")
                # These fixtures stand in for the package's generation/migration
                # phases, so no native homes or actual server processes are used.
                helpers = '''import os
from pathlib import Path
def load_manifest(): return {}
def opencode_config_path(*args): return str(Path.home()/'.config/opencode/opencode.jsonc')
'''
                old_generator = helpers + "\nif __name__ == '__main__': print('old generation restored')\n"
                write(dst / "generate_homes.py", old_generator)
                write(dst / "manifest.json", "old manifest")
                write(dst / "shared/serve.py", "old working server code")
                write(pkg / "generate_homes.py", helpers + '''
if __name__ == '__main__':
 import sys
 raise SystemExit(int(os.environ['FAILURE'] == {'generate':'generation','check':'check'}.get(sys.argv[1])))
''')
                write(pkg / "manifest.json", "new manifest")
                write(pkg / "shared/serve.py", "new server code")
                write(pkg / "shared/check.py", "import os\nraise SystemExit(int(os.environ['FAILURE']=='health'))\n")
                write(pkg / "shared/opencode.py", '''import os
from pathlib import Path
(Path.home()/'.config/opencode/opencode.jsonc').write_text('migrated config')
raise SystemExit(int(os.environ['FAILURE']=='migration'))
''')
                write(binary_dir / "sleep", "#!/bin/sh\nexit 0\n", executable=True)
                write(binary_dir / "launchctl", f"#!{sys.executable}\n" + '''import os,sys
from pathlib import Path
state=Path(os.environ['FAKE_LAUNCHD'])
command=sys.argv[1]
if command in ('print','bootout'):
 label=sys.argv[2].split('/')[-1]
 marker=state/label
 if command=='print': raise SystemExit(0 if marker.exists() else 1)
 marker.unlink(missing_ok=True)
elif command=='bootstrap':
 plist=Path(sys.argv[3])
 if os.environ['FAILURE']=='bootstrap' and plist.read_text().startswith('new'):
  raise SystemExit(1)
 (state/plist.stem).write_text(plist.read_text())
else: raise SystemExit(2)
''', executable=True)
                env = {**os.environ, "HOME": str(home), "TMPDIR": str(root),
                       "PATH": str(binary_dir) + os.pathsep + os.environ["PATH"],
                       "FAILURE": failure, "FAKE_LAUNCHD": str(state)}
                result = subprocess.run(["zsh", str(pkg / "install.zsh")], env=env,
                                        capture_output=True, text=True, timeout=20)
                self.assertEqual((dedicated / "bin/python3.12").read_bytes(), (base / "bin/python3.12").read_bytes())
                if failure == "none":
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertEqual((dst / "shared/serve.py").read_text(), "new server code")
                    self.assertEqual((dst / "manifest.json").read_text(), "new manifest")
                    self.assertEqual(oc.read_text(), "migrated config")
                    self.assertEqual(list(root.glob("harness-homes-install.*")), [])
                    for label in LABELS:
                        self.assertTrue((state / label).read_text().startswith("new "))
                    continue
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("recovery failures: 0", result.stderr, result.stdout + result.stderr)
                self.assertEqual((dst / "shared/serve.py").read_text(), "old working server code")
                self.assertEqual((dst / "manifest.json").read_text(), "old manifest")
                self.assertEqual((dst / "generate_homes.py").read_text(), old_generator)
                self.assertEqual(oc.read_text(), 'original config with private fixture value\n')
                for label in LABELS:
                    self.assertEqual((home / f"Library/LaunchAgents/{label}.plist").read_text(), "old " + label)
                    self.assertTrue((state / label).read_text().startswith("old "))


if __name__ == "__main__":
    unittest.main()
