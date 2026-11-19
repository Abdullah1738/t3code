"""Exercise install failure recovery with fake launchctl and isolated HOME."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

PKG = Path(__file__).resolve().parent.parent
LABELS = ["com.ardud.shared-mcp-flighty", "com.ardud.shared-mcp-inbody"]
sys.path.insert(0, str(PKG / 'shared'))
import inbody_python


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


class InstallFixture:
    def __init__(self, root, *, failure="none", bootout_prints=0, bootstrap_codes=None,
                 check_failures=0, ready_secs="6", with_agent=False):
        self.root = root
        self.home = root / "home"
        self.pkg = root / "integrations/harness-homes"
        self.dst = self.home / ".local/share/harness-homes"
        self.state = root / "launchd-state"
        self.state.mkdir()
        self.log = root / "launchctl.log"
        self.sleeps = root / "sleep.log"
        self.checks = root / "check-count"
        self.config = self.home / ".config/opencode/opencode.jsonc"
        self.labels = [*LABELS, *(["com.ardud.harness-homes"] if with_agent else [])]
        self.with_agent = with_agent
        binary_dir = root / "bin"
        write(self.config, 'original config with private fixture value\n')
        write(self.pkg / "install.zsh", (PKG / "install.zsh").read_text())
        write(self.pkg / "shared/flighty_python.py", (PKG / "shared/flighty_python.py").read_text())
        write(self.pkg / 'shared/inbody_python.py', '''import sys
from pathlib import Path
if '--dry-run' not in sys.argv:
 (Path.home()/'inbody-prepared').touch()
''')
        helper = PKG.parent / 'local-helpers/libexec'
        for directory in ('opencode-reload', 'toollog'):
            shutil.copytree(helper / directory, root / 'integrations/local-helpers/libexec' / directory)
        guard = root / 'integrations/local-helpers/libexec/opencode-reload/opencode_reload.py'
        guard.write_text(guard.read_text() + "\nif os.environ.get('FAILURE') == 'config-commit' and 'harness-homes' in sys.argv and '--dry-run' not in sys.argv: raise SystemExit(1)\n")
        write(self.pkg / 'shared/install_preflight.py', """import os, sys
from pathlib import Path
if os.environ['FAILURE'] == 'preflight':
 raise SystemExit('install opencode-plugins first: missing plugin/phone-adb-guard.ts')
Path(sys.argv[1]).write_text('migrated config')
Path(sys.argv[3]).write_bytes((Path.home()/'.config/opencode/opencode.jsonc').read_bytes())
""")
        self.base, self.dedicated = flighty_fixture(self.home)
        for label in self.labels:
            write(self.home / f"Library/LaunchAgents/{label}.plist", "old " + label)
            write(self.pkg / f"launchd/{label}.plist", "new " + label)
            write(self.state / label, "old " + label)
        # Generation/migration fixtures never touch native homes or real servers.
        helpers = '''import os
from pathlib import Path
def load_manifest(): return {}
def opencode_config_path(*args): return str(Path.home()/'.config/opencode/opencode.jsonc')
'''
        self.old_generator = helpers + "\nif __name__ == '__main__': print('old generation restored')\n"
        write(self.dst / "generate_homes.py", self.old_generator)
        write(self.dst / "manifest.json", "old manifest")
        write(self.dst / "shared/serve.py", "old working server code")
        write(self.pkg / "generate_homes.py", helpers + '''
if __name__ == '__main__':
 import sys
 if os.environ['FAILURE'] in ('concurrent-config', 'same-config') and sys.argv[1] == 'check':
  Path.home().joinpath('.config/opencode/opencode.jsonc').write_text('migrated config' if os.environ['FAILURE'] == 'same-config' else 'concurrent edit')
 raise SystemExit(int(os.environ['FAILURE'] == {'generate':'generation','check':'check'}.get(sys.argv[1])))
''')
        write(self.pkg / "manifest.json", "new manifest")
        write(self.pkg / "shared/serve.py", "new server code")
        write(self.pkg / "shared/check.py", '''import os, sys
from pathlib import Path
counter = Path(os.environ['CHECK_COUNT'])
count = int(counter.read_text()) + 1 if counter.exists() else 1
counter.write_text(str(count))
print(f'check output {count}')
print(f'check error {count}', file=sys.stderr)
raise SystemExit(int(os.environ['FAILURE']=='health' or count <= int(os.environ['CHECK_FAILURES'])))
''')
        write(self.pkg / "shared/opencode.py", '''import os
from pathlib import Path
(Path.home()/'.config/opencode/opencode.jsonc').write_text('migrated config')
raise SystemExit(int(os.environ['FAILURE']=='migration'))
''')
        write(binary_dir / "launchctl", f"#!{sys.executable}\n" + '''import json, os, sys
from pathlib import Path
state = Path(os.environ['FAKE_LAUNCHD'])
command = sys.argv[1]
label = Path(sys.argv[3]).stem if command == 'bootstrap' else sys.argv[2].split('/')[-1]
version = Path(sys.argv[3]).read_text().split()[0] if command == 'bootstrap' else None
with Path(os.environ['LAUNCHCTL_LOG']).open('a') as log:
 log.write(json.dumps({'command': command, 'label': label, 'version': version}) + '\\n')
marker = state / label
pending = state / (label + '.pending')
if command == 'print':
 if pending.exists():
  remaining = int(pending.read_text())
  if remaining:
   pending.write_text(str(remaining - 1))
   raise SystemExit(0)
  pending.unlink()
  marker.unlink(missing_ok=True)
 raise SystemExit(0 if marker.exists() else 1)
elif command == 'bootout':
 if marker.exists() and int(os.environ['BOOTOUT_PRINTS']):
  pending.write_text(os.environ['BOOTOUT_PRINTS'])
 else:
  marker.unlink(missing_ok=True)
elif command == 'bootstrap':
 counter = state / (label + '.' + version + '.count')
 count = int(counter.read_text()) + 1 if counter.exists() else 1
 counter.write_text(str(count))
 codes = json.loads(os.environ['BOOTSTRAP_CODES']).get(version + ' ' + label, [])
 code = codes[count - 1] if count <= len(codes) else 0
 if code: raise SystemExit(code)
 if marker.exists(): raise SystemExit(5)
 if os.environ['FAILURE']=='bootstrap' and version == 'new': raise SystemExit(1)
 marker.write_text(Path(sys.argv[3]).read_text())
else: raise SystemExit(2)
''', executable=True)
        self.env = {**os.environ, "HARNESS_HOMES_PYTHON": sys.executable, "HOME": str(self.home), "TMPDIR": str(root),
                    "PATH": str(binary_dir) + os.pathsep + os.environ["PATH"],
                    "OPENCODE_RELOAD_INSTANCES": '[{"name":"HOME","url":"http://127.0.0.1:1"},{"name":"BTSE","url":"http://127.0.0.1:1"}]',
                    "FAILURE": failure, "FAKE_LAUNCHD": str(self.state),
                    "LAUNCHCTL_LOG": str(self.log), "SLEEP_LOG": str(self.sleeps),
                    "BOOTOUT_PRINTS": str(bootout_prints), "BOOTSTRAP_CODES": json.dumps(bootstrap_codes or {}),
                    "CHECK_FAILURES": str(check_failures), "CHECK_COUNT": str(self.checks)}
        self.env.pop("SHARED_MCP_READY_SECS", None)
        if ready_secs is not None:
            self.env["SHARED_MCP_READY_SECS"] = ready_secs

    def run(self, *args):
        # Advance the shell's elapsed clock instead of sleeping through 90 s.
        wrapper = '''typeset -F SECONDS
sleep() {
 print -r -- "$1" >> "$SLEEP_LOG"
 (( SECONDS += $1 ))
 return 0
}
installer=$1
shift
source "$installer" "$@"
'''
        return subprocess.run(["/bin/zsh", "-f", "-c", wrapper, "installer-test", str(self.pkg / "install.zsh"),
                               *(["--with-agent"] if self.with_agent else []), *args],
                              env=self.env, capture_output=True, text=True, timeout=20)

    def calls(self, command, label=None, version=None):
        return [call for call in map(json.loads, self.log.read_text().splitlines())
                if call["command"] == command and (label is None or call["label"] == label)
                and (version is None or call["version"] == version)]


class InbodyPythonTests(unittest.TestCase):
    def test_build_dry_run_idempotence_and_source_changes_in_temp_home(self):
        with tempfile.TemporaryDirectory(prefix='inbody runtime ') as tmp:
            root = Path(tmp).resolve()
            home, source = root / 'home', root / 'source'
            write(source / 'pyproject.toml', '[project]\nname = "inbody-api-mcp"\nversion = "0.1.0"\n')
            write(source / 'uv.lock', '[[package]]\nname = "inbody-api-mcp"\nversion = "0.1.0"\n')
            write(source / 'README.md', 'fixture')
            write(source / 'src/inbody_api_mcp/__init__.py', '')
            write(source / 'src/inbody_api_mcp/server.py', 'VALUE = "installed"\n')
            write(source / '.env', 'never stage this')
            uv = root / 'bin/uv'
            # Exercise a real isolated venv and imports without network or macOS Python.
            write(uv, f'#!{sys.executable}\n' + '''import json, os, shutil, subprocess, sys
from pathlib import Path
dest = Path(os.environ['UV_PROJECT_ENVIRONMENT'])
stage = Path(sys.argv[sys.argv.index('--project') + 1])
assert not (stage/'.env').exists()
assert not (stage/'.venv').exists()
subprocess.run([sys.executable, '-m', 'venv', '--without-pip', str(dest)], check=True)
site = next((dest/'lib').glob('python*/site-packages'))
shutil.copytree(stage/'src/inbody_api_mcp', site/'inbody_api_mcp', dirs_exist_ok=True)
with (dest.parent/'uv-calls').open('a') as log:
 log.write(json.dumps(sys.argv[1:])+'\\n')
''', executable=True)
            destination = home / '.local/share/shared-mcp-inbody/python'
            real_output = subprocess.check_output

            def base_info(args, **kwargs):
                if args[1:3] == ['-I', '-c']:
                    return json.dumps([[3, 14, 7], str(Path(sys.executable).parent.parent)])
                return real_output(args, **kwargs)

            with mock.patch.dict(os.environ, {'HOME': str(home)}), \
                    mock.patch.object(inbody_python.subprocess, 'check_output', side_effect=base_info):
                options = dict(source=source, python=Path(sys.executable), uv=str(uv))
                inbody_python.prepare(**options, dry_run=True)
                self.assertFalse(home.exists())
                inbody_python.prepare(**options)
                python = destination / 'bin/python'
                before = {p: (p.stat().st_ino, p.stat().st_mtime_ns) for p in destination.rglob('*') if p.is_file()}
                inbody_python.prepare(**options)
                self.assertEqual({p: (p.stat().st_ino, p.stat().st_mtime_ns) for p in before}, before)
                calls = (destination.parent / 'uv-calls').read_text().splitlines()
                self.assertEqual(len(calls), 1)
                flags = json.loads(calls[0])
                for flag in ('--frozen', '--no-dev', '--no-editable', '--no-managed-python', '--no-python-downloads'):
                    self.assertIn(flag, flags)
                self.assertEqual(flags[flags.index('--link-mode') + 1], 'copy')
                write(source / 'src/inbody_api_mcp/server.py', 'VALUE = "changed package"\n')
                inbody_python.prepare(**options)
                self.assertEqual(len((destination.parent / 'uv-calls').read_text().splitlines()), 2)
                shutil.rmtree(source)
                output = real_output([str(python), '-I', '-c',
                    'from inbody_api_mcp.server import VALUE; print(VALUE)'], text=True)
                self.assertEqual(output.strip(), 'changed package')
                self.assertEqual(list(destination.parent.glob('inbody-build-*')), [])
                self.assertFalse((home / 'Library').exists())
                self.assertFalse((home / '.local/share/shared-mcp-flighty').exists())

    def test_rejects_external_python_destination_and_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            link = Path(tmp) / 'mounted'
            link.symlink_to('/Volumes/ExternalSSD/runtime')
            for kwargs in ({'python': Path('/Volumes/ExternalSSD/python')},
                           {'destination': Path('/Volumes/Data/runtime')}, {'destination': link}):
                with self.subTest(kwargs=kwargs), self.assertRaisesRegex(ValueError, '/Volumes/'):
                    inbody_python.prepare(**kwargs, dry_run=True)


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
            env = {**os.environ, "HARNESS_HOMES_PYTHON": sys.executable, "HOME": str(home), "TMPDIR": str(root), "RSYNC_LOG": str(rsync_log),
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

    def assert_installed(self, fixture, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((fixture.dst / "shared/serve.py").read_text(), "new server code")
        self.assertEqual((fixture.dst / "manifest.json").read_text(), "new manifest")
        self.assertEqual(fixture.config.read_text(), "migrated config")
        self.assertTrue((fixture.home / 'inbody-prepared').exists())
        self.assertEqual(list(fixture.root.glob("harness-homes-install.*")), [])
        for label in fixture.labels:
            self.assertEqual((fixture.state / label).read_text(), "new " + label)

    def assert_restored(self, fixture, result):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("recovery failures: 0", result.stderr, result.stdout + result.stderr)
        self.assertEqual((fixture.dst / "shared/serve.py").read_text(), "old working server code")
        self.assertEqual((fixture.dst / "manifest.json").read_text(), "old manifest")
        self.assertEqual((fixture.dst / "generate_homes.py").read_text(), fixture.old_generator)
        self.assertEqual(fixture.config.read_text(), 'original config with private fixture value\n')
        for label in fixture.labels:
            self.assertEqual((fixture.home / f"Library/LaunchAgents/{label}.plist").read_text(), "old " + label)
            self.assertEqual((fixture.state / label).read_text(), "old " + label)

    def test_failure_restores_services_code_and_config(self):
        for failure in ("bootstrap", "health", "generation", "check", "none"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                fixture = InstallFixture(Path(tmp).resolve(), failure=failure)
                result = fixture.run()
                self.assertEqual((fixture.dedicated / "bin/python3.12").read_bytes(),
                                 (fixture.base / "bin/python3.12").read_bytes())
                if failure == "none":
                    self.assert_installed(fixture, result)
                else:
                    self.assert_restored(fixture, result)

    def test_waits_for_bootout_including_agent_and_rollback(self):
        for failure in ("none", "generation"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                fixture = InstallFixture(Path(tmp).resolve(), bootout_prints=3, with_agent=True, failure=failure)
                result = fixture.run()
                if failure == "none":
                    self.assert_installed(fixture, result)
                    for label in fixture.labels:
                        self.assertEqual(len(fixture.calls("bootstrap", label, "new")), 1)
                else:
                    self.assert_restored(fixture, result)
                    for label in fixture.labels:
                        self.assertEqual(len(fixture.calls("bootstrap", label, "old")), 1)
                self.assertGreaterEqual(len(fixture.calls("print", LABELS[0])), 5)

    def test_bootstrap_retries_only_exit_five(self):
        cases = (([5, 0], 2, True), ([5, 5], 2, False), ([1], 1, False), ([37], 1, False))
        for codes, expected_calls, success in cases:
            with self.subTest(codes=codes), tempfile.TemporaryDirectory() as tmp:
                fixture = InstallFixture(Path(tmp).resolve(), bootstrap_codes={"new " + LABELS[0]: codes})
                result = fixture.run()
                if success:
                    self.assert_installed(fixture, result)
                else:
                    self.assert_restored(fixture, result)
                    self.assertEqual(result.returncode, codes[-1])
                self.assertEqual(len(fixture.calls("bootstrap", LABELS[0], "new")), expected_calls)
                if codes[0] == 5:
                    self.assertIn(2.0, map(float, fixture.sleeps.read_text().splitlines()))

    def test_bootout_wait_is_bounded_when_label_never_disappears(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = InstallFixture(Path(tmp).resolve(), bootout_prints=1000)
            result = fixture.run()
            self.assertEqual(result.returncode, 5, result.stdout + result.stderr)
            calls = list(map(json.loads, fixture.log.read_text().splitlines()))
            bootstrap = next(i for i, call in enumerate(calls) if call["command"] == "bootstrap")
            prints = [call for call in calls[:bootstrap] if call["command"] == "print" and call["label"] == LABELS[0]]
            self.assertGreater(len(prints), 2)
            self.assertLessEqual(len(prints), 31)  # Includes the snapshot before bootout.
            self.assertEqual(len(fixture.calls("bootstrap", LABELS[0], "new")), 2)
            self.assertIn("previous package/config/jobs restoration attempted", result.stderr)

    def test_bootstrap_retry_covers_agent_and_rollback(self):
        for version, label in (("new", "com.ardud.harness-homes"), ("old", LABELS[0])):
            with self.subTest(version=version, label=label), tempfile.TemporaryDirectory() as tmp:
                fixture = InstallFixture(Path(tmp).resolve(), with_agent=True,
                                         failure="generation" if version == "old" else "none",
                                         bootstrap_codes={version + " " + label: [5, 0]})
                result = fixture.run()
                if version == "new":
                    self.assert_installed(fixture, result)
                else:
                    self.assert_restored(fixture, result)
                self.assertEqual(len(fixture.calls("bootstrap", label, version)), 2)

    def test_readiness_deadline_allows_slow_checks_and_reports_last_failure(self):
        for failures, success in ((1, True), (100, False)):
            with self.subTest(failures=failures), tempfile.TemporaryDirectory() as tmp:
                fixture = InstallFixture(Path(tmp).resolve(), check_failures=failures, ready_secs="5")
                log = fixture.home / 'Library/Logs/com.ardud.shared-mcp-inbody.err.log'
                write(log, ''.join(f'crash {i}\n' for i in range(50)))
                before = log.stat()
                result = fixture.run()
                if success:
                    self.assert_installed(fixture, result)
                    self.assertEqual(int(fixture.checks.read_text()), failures + 1)
                    self.assertEqual(float(fixture.sleeps.read_text().splitlines()[0]), 2)
                else:
                    self.assert_restored(fixture, result)
                    checks = int(fixture.checks.read_text())
                    self.assertLess(checks, failures)
                    self.assertIn(f"check output {checks}", result.stderr)
                    self.assertIn(f"check error {checks}", result.stderr)
                    self.assertNotIn("check error 1\n", result.stderr)
                    self.assertIn("Shared MCP startup failed; configs were not switched", result.stderr)
                    self.assertIn('crash 30\n', result.stderr)
                    self.assertIn('crash 49\n', result.stderr)
                    self.assertNotIn('crash 29\n', result.stderr)
                self.assertEqual(log.stat().st_mtime_ns, before.st_mtime_ns)
                self.assertEqual(log.stat().st_size, before.st_size)

    def test_default_readiness_window_exceeds_fifteen_checks(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = InstallFixture(Path(tmp).resolve(), check_failures=16, ready_secs=None)
            self.assert_installed(fixture, fixture.run())
            self.assertEqual(int(fixture.checks.read_text()), 17)

    def test_dry_run_does_not_prepare_python_or_change_package_config_and_jobs(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = InstallFixture(Path(tmp).resolve())
            before = {p: (p.read_bytes(), p.stat().st_ino, p.stat().st_mtime_ns)
                      for p in fixture.home.rglob('*') if p.is_file()}
            result = fixture.run('--dry-run')
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertFalse(fixture.dedicated.exists())
            self.assertFalse((fixture.home / 'inbody-prepared').exists())
            self.assertFalse(fixture.log.exists())
            self.assertNotIn('opencode-reload:', result.stdout)
            for path, expected in before.items():
                self.assertEqual((path.read_bytes(), path.stat().st_ino, path.stat().st_mtime_ns), expected)

    def test_mode_flags_are_exclusive_in_every_order(self):
        modes = ('--dry-run', '--check', '--flighty-python', '--inbody-python')
        for first in modes:
            for second in modes:
                with self.subTest(first=first, second=second), tempfile.TemporaryDirectory() as tmp:
                    fixture = InstallFixture(Path(tmp).resolve())
                    before = fixture.config.stat()
                    result = fixture.run(first, second)
                    self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                    self.assertIn('choose --check, --dry-run, --flighty-python or --inbody-python', result.stderr)
                    self.assertFalse(fixture.dedicated.exists())
                    self.assertFalse(fixture.log.exists())
                    self.assertEqual(fixture.config.stat().st_ino, before.st_ino)
                    self.assertEqual(fixture.config.stat().st_mtime_ns, before.st_mtime_ns)

    def test_inbody_only_mode_does_not_prepare_flighty_or_touch_jobs(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = InstallFixture(Path(tmp).resolve())
            result = fixture.run('--inbody-python')
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue((fixture.home / 'inbody-prepared').exists())
            self.assertFalse(fixture.dedicated.exists())
            self.assertFalse(fixture.log.exists())
            self.assertEqual(fixture.config.read_text(), 'original config with private fixture value\n')

    def test_guard_preflight_rejects_invalid_settings_and_symlink_before_setup(self):
        cases = [(key, value) for key, values in (
            ('OPENCODE_RELOAD_WAIT', ('invalid', '-1', '86401', 'nan', 'inf')),
            ('OPENCODE_RELOAD_INSTANCES', ('[]', '{}', '[null]')))
                 for value in values] + [('symlink', '')]
        for key, value in cases:
            with self.subTest(key=key, value=value), tempfile.TemporaryDirectory() as tmp:
                fixture = InstallFixture(Path(tmp).resolve())
                if key == 'symlink':
                    original = fixture.home / 'original-config'
                    fixture.config.rename(original)
                    fixture.config.symlink_to(original)
                else:
                    fixture.env[key] = value
                before = {p: (p.read_bytes(), p.stat().st_ino, p.stat().st_mtime_ns)
                          for p in fixture.home.rglob('*') if p.is_file()}
                result = fixture.run()
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertFalse(fixture.dedicated.exists())
                self.assertFalse(fixture.log.exists())
                self.assertNotIn('opencode-reload:', result.stdout)
                for path, expected in before.items():
                    self.assertEqual((path.read_bytes(), path.stat().st_ino, path.stat().st_mtime_ns), expected)

    def test_edit_during_flighty_preparation_preserves_original_preflight_baseline(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = InstallFixture(Path(tmp).resolve())
            flighty = fixture.pkg / 'shared/flighty_python.py'
            flighty.write_text(flighty.read_text() + "\nif '--dry-run' not in __import__('sys').argv: (Path.home()/'.config/opencode/opencode.jsonc').write_text('early concurrent edit')\n")
            result = fixture.run()
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(fixture.config.read_text(), 'early concurrent edit')
            self.assertNotIn('opencode-reload:', result.stdout)

    def test_another_writer_matching_staged_config_is_not_owned_for_rollback(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = InstallFixture(Path(tmp).resolve(), failure='same-config')
            result = fixture.run()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('config changed during installation', result.stderr)
            self.assertEqual(fixture.config.read_text(), 'migrated config')
            self.assertNotIn('opencode-reload:', result.stdout)

    def test_concurrent_config_edit_is_not_overwritten_or_rolled_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = InstallFixture(Path(tmp).resolve(), failure="concurrent-config")
            result = fixture.run()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('config changed during installation', result.stderr)
            self.assertEqual(fixture.config.read_text(), 'concurrent edit')
            self.assertNotIn('opencode-reload:', result.stdout)

    def test_changed_rollback_is_guarded_and_logs_its_own_reload(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = InstallFixture(Path(tmp).resolve(), failure="config-commit")
            result = fixture.run()
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(fixture.config.read_text(), 'original config with private fixture value\n')
            self.assertEqual(result.stdout.count('opencode-reload:'), 2)
            events = [json.loads(line) for path in fixture.home.rglob('*.ndjson') for line in path.read_text().splitlines()]
            reloads = [e for e in events if e['kind'] == 'opencode-reload']
            self.assertEqual([e['props']['installer'] for e in reloads], ['harness-homes', 'harness-homes-rollback'])
            self.assertEqual(reloads[0]['props']['files'][0]['sha256_before'], reloads[1]['props']['files'][0]['sha256_after'])

    def test_failed_identical_config_keeps_inode_and_mtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = InstallFixture(Path(tmp).resolve(), failure="bootstrap")
            before = fixture.config.stat()
            result = fixture.run()
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((fixture.config.stat().st_ino, fixture.config.stat().st_mtime_ns),
                             (before.st_ino, before.st_mtime_ns))
            self.assertNotIn('opencode-reload:', result.stdout)

    def test_missing_plugin_preflight_precedes_every_install_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = InstallFixture(Path(tmp).resolve(), failure="preflight")
            before = {p: (p.read_bytes(), p.stat().st_ino, p.stat().st_mtime_ns)
                      for root in (fixture.home, fixture.dst) for p in root.rglob('*') if p.is_file()}
            result = fixture.run()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('install opencode-plugins first: missing plugin/phone-adb-guard.ts', result.stderr)
            self.assertFalse(fixture.log.exists())
            self.assertFalse(fixture.dedicated.exists())
            for path, expected in before.items():
                self.assertEqual((path.read_bytes(), path.stat().st_ino, path.stat().st_mtime_ns), expected)

    def test_second_install_preserves_watched_config_and_reload_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = InstallFixture(Path(tmp).resolve())
            first = fixture.run()
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            self.assertEqual(first.stdout.count('opencode-reload:'), 1)
            before = fixture.config.stat()
            logs = list(fixture.home.rglob('*.ndjson'))
            events = {p: p.read_bytes() for p in logs}
            second = fixture.run()
            self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
            self.assertNotIn('opencode-reload:', second.stdout)
            self.assertEqual((fixture.config.stat().st_ino, fixture.config.stat().st_mtime_ns), (before.st_ino, before.st_mtime_ns))
            self.assertEqual({p: p.read_bytes() for p in logs}, events)

    def test_invalid_readiness_window_fails_before_changing_files_or_jobs(self):
        for value in ("0", "-1", "1.5", "invalid"):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as tmp:
                fixture = InstallFixture(Path(tmp).resolve(), ready_secs=value)
                result = fixture.run()
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn("SHARED_MCP_READY_SECS must be a positive integer", result.stderr)
                self.assertFalse(fixture.log.exists())
                self.assertEqual(fixture.config.read_text(), 'original config with private fixture value\n')


if __name__ == "__main__":
    unittest.main()
