"""Home template prerequisites without apt, network access or a running database service."""
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests._env import clean_env
from offbox_lib import bases, common, toolchain  # noqa: E402

TEMPLATES = Path(__file__).resolve().parents[2] / "templates"
FETCH = (TEMPLATES / "tools/fetch.sh").read_text()


class TemplateTools(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "calls"
        self.env = clean_env(HOME=str(self.root), NVM_DIR=str(self.root / ".nvm"),
                        PATH=f"{self.bin}:/usr/bin:/bin", CALLS=str(self.log))
        self.env.pop('BASH_ENV', None)

    def shim(self, name, body):
        path = self.bin / name
        path.write_text("#!/bin/bash\nset -eu\n" + body)
        path.chmod(0o755)

    def calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def run_fdb(self, client="7.3.63-1", server="7.3.63", version="7.3.63", fail=False, banner=None):
        self.shim("dpkg-query", 'printf "%s" "$CLIENT"\n')
        self.shim("fdbserver", 'printf "%s\\n" "$BANNER"\n')
        self.shim("curl", 'echo "$*" >> "$CALLS"\n[ "$FAIL" = no ] || exit 22\n')
        self.shim("dpkg-deb", 'echo "$*" >> "$CALLS"\n')
        self.shim("sudo", 'echo "$*" >> "$CALLS"\n')
        env = dict(self.env, CLIENT=client, BANNER=banner if banner is not None else f"FoundationDB 7.3 (v{server})",
                   OFFBOX_FDB_VERSION=version, FAIL="yes" if fail else "no")
        script = FETCH + "\n" + (TEMPLATES / "tools/foundationdb.sh").read_text() + "\noffbox_foundationdb\n"
        return subprocess.run(["/bin/bash", "-c", script], env=env, text=True, capture_output=True, timeout=10)

    def test_matching_fdb_binaries_need_no_download_or_install(self):
        result = self.run_fdb()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls(), [])

    def test_server_banner_version_forms(self):
        cases = (
            ("FoundationDB 7.3 (v7.3.63)", False),
            ("FoundationDB 7.3 (v7.3.63)\nsource version abc\nprotocol fdb00b073000000", False),
            ("FoundationDB 7.3 (v7.3.62)", True),
            ("FoundationDB 7.3 (v7.3.630)", True),
            ("FoundationDB 7.3 (v7.3.63-prerelease)", True),
            ("", True),
        )
        for banner, download in cases:
            with self.subTest(banner=banner):
                self.log.write_text("")
                result = self.run_fdb(banner=banner)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(any("foundationdb-server_" in c for c in self.calls()), download)
                self.assertFalse(any("foundationdb-clients_" in c for c in self.calls()))

    def test_missing_fdb_installs_client_and_extracts_server_without_apt_installing_it(self):
        result = self.run_fdb(client="", server="")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = "\n".join(self.calls())
        for package in ("clients", "server"):
            self.assertIn(f"/7.3.63/foundationdb-{package}_7.3.63-1_amd64.deb", calls)
        self.assertIn("apt-get install -y -qq", calls)
        self.assertIn("/clients.deb", calls)
        self.assertIn("-x ", calls)
        self.assertIn("install -m 0755", calls)
        self.assertIn("/usr/local/bin/fdbserver", calls)
        self.assertFalse(any("apt-get" in c and "server.deb" in c for c in self.calls()))

    def test_fdb_version_override_updates_mismatched_client_and_server(self):
        result = self.run_fdb(version="7.3.64")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sum("--retry 2" in c for c in self.calls()), 2)
        self.assertIn("/7.3.64/foundationdb-clients_7.3.64-1_amd64.deb", "\n".join(self.calls()))

    def test_fdb_download_failure_stops_setup(self):
        result = self.run_fdb(client="", server="", fail=True)
        self.assertEqual(result.returncode, 98)
        self.assertIn('offbox: download failed (curl exit 22)', result.stderr)
        self.assertFalse(any("apt-get" in c or "install -m" in c for c in self.calls()))

    def run_node(self, nvm_exists):
        nvm = 'nvm() { echo "nvm $*" >> "$CALLS"; }\n'
        if nvm_exists:
            (self.root / ".nvm").mkdir()
            (self.root / ".nvm/nvm.sh").write_text(nvm)
        self.shim("curl", 'echo "curl $*" >> "$CALLS"\n'
                  'while [ "$1" != -o ]; do shift; done\nshift\n'
                  f"printf '%s' {shlex.quote('printf %s ' + shlex.quote(nvm) + ' > "$NVM_DIR/nvm.sh"')} > \"$1\"\n")
        for tool in ("corepack", "node", "npm"):
            self.shim(tool, f'echo "{tool} $*" >> "$CALLS"\n')
        script = FETCH + "\n" + (TEMPLATES / "crpko-node.sh").read_text().split("sudo apt-get update -qq", 1)[0]
        return subprocess.run(["/bin/bash", "-c", script], env=self.env, text=True, capture_output=True, timeout=10)

    def test_node_recipe_activates_builder_provisioned_versions_without_reinstalling(self):
        result = self.run_node(True)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertFalse(any(c.startswith("curl ") for c in calls))
        for major in (20, 22, 24):
            self.assertFalse(any(c.startswith("nvm install ") for c in calls))
            self.assertIn(f"nvm use {major}", calls)
        self.assertEqual(calls.count("corepack prepare pnpm@10 --activate"), 3)
        self.assertEqual(calls[-1], "nvm use default")

    def test_node_reuses_existing_nvm(self):
        result = self.run_node(True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(c.startswith("curl ") for c in self.calls()))

    def test_composed_recipes_have_their_required_tools_and_valid_shell(self):
        with patch.object(bases, "TEMPLATES_DIR", TEMPLATES):
            for name in common.TEMPLATES:
                with self.subTest(name=name):
                    body, _ = bases.recipe(name)
                    self.assertTrue(body.startswith(FETCH + '\n'))
                    uses = list(re.finditer(r'^\s*(?:offbox_fetch|__offbox_curl)\s+', body, re.M))
                    self.assertTrue(uses)
                    self.assertLess(body.index('offbox_fetch()'), uses[0].start())
                    self.assertIn("UV_LINK_MODE=copy", body)
                    self.assertIn("zsh openjdk-21-jdk-headless", body)
                    self.assertIn("javac -version 2>&1 | grep -q '^javac 21\\.'", body)
                    self.assertIn("--set javac /usr/lib/jvm/java-21-openjdk-amd64/bin/javac", body)
                    self.assertEqual(body.count('FDB_VERSION="${OFFBOX_FDB_VERSION:-7.3.63}"'),
                                     int(name in ("crpko-go", "crpko-harness")))
                    result = subprocess.run(["/bin/bash", "-n"], input=body, text=True, capture_output=True)
                    self.assertEqual(result.returncode, 0, result.stderr)

    def test_toolchain_downloads_use_shared_bounds_and_retry_count(self):
        self.assertTrue(toolchain.SHELL.startswith(FETCH))
        self.shim('curl', 'echo "$*" >> "$CALLS"\nexit 18\n')
        script = toolchain.SHELL + '''
OFFBOX_FETCH_BOUNDS=(--connect-timeout 7 --speed-limit 30 --speed-time 2 --max-time 9 --retry 1)
__offbox_curl -fsSL https://example.invalid/node.tar.xz -o /tmp/fixture
'''
        result = subprocess.run(['/bin/bash', '-c', script], env=self.env,
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 18)
        self.assertEqual(len(self.calls()), 2)
        for call in self.calls():
            self.assertIn('--connect-timeout 7 --speed-limit 30 --speed-time 2 --max-time 9', call)
            self.assertIn('--retry 1 --retry 0', call)
        self.assertIn('attempt 2/2 failed (curl exit 18)', result.stderr)

    def test_home_base_has_a_verified_full_jdk(self):
        body = (TEMPLATES.parents[1] / 'server/base-image.sh').read_text()
        self.assertIn('openjdk-21-jdk-headless', body)
        self.assertNotIn('openjdk-21-jre-headless', body)
        self.assertIn('--set java /usr/lib/jvm/java-21-openjdk-amd64/bin/java', body)
        self.assertIn('--set javac /usr/lib/jvm/java-21-openjdk-amd64/bin/javac', body)
        self.assertIn("javac -version 2>&1 | grep -q '^javac 21\\.'", body)

    def test_system_toolchain_archives_never_import_archive_owners(self):
        body = (TEMPLATES.parents[1] / 'server/base-image.sh').read_text()
        self.assertIn('NODE=v24.22.3\n', body)
        for line in body.splitlines():
            if '| tar ' in line:
                self.assertIn('--no-same-owner', line)
        for name in ('generic', 'crpko-go', 'crpko-harness'):
            body = (TEMPLATES / (name + '.sh')).read_text()
            extraction = next(line for line in body.splitlines() if 'sudo tar -C /usr/local' in line)
            self.assertIn('--no-same-owner', extraction)

    def test_base_and_stack_templates_install_the_shim_interpreter(self):
        base = TEMPLATES.parents[1] / 'server/base-image.sh'
        paths = [base, *(TEMPLATES / (name + '.sh') for name in common.TEMPLATES)]
        for path in paths:
            with self.subTest(path=path.name):
                body = path.read_text().replace('\\\n', ' ')
                installs = re.findall(r'^\s*(?:sudo )?apt-get install\s+([^\n]+)', body, re.M)
                self.assertTrue(any('zsh' in shlex.split(args) for args in installs), path)
        self.assertIn("test -x /bin/zsh || { echo 'offbox base: /bin/zsh missing' >&2; exit 1; }",
                      base.read_text())

    def test_java_checks_fail_template_builds_without_a_21_compiler(self):
        paths = [TEMPLATES / (name + '.sh') for name in common.TEMPLATES]
        paths.append(TEMPLATES.parents[1] / 'server/base-image.sh')
        for path in paths:
            check = next(line for line in path.read_text().splitlines() if line.startswith('javac -version'))
            for version, code in (('javac 21.0.13', 0), ('javac 11.0.1', 1), ('', 1)):
                with self.subTest(path=path.name, version=version):
                    self.shim('javac', 'printf "%s\\n" "$COMPILER_VERSION"\n')
                    result = subprocess.run(['/bin/bash', '-c', 'set -euo pipefail\n' + check],
                                            env=dict(self.env, COMPILER_VERSION=version),
                                            text=True, capture_output=True, timeout=10)
                    self.assertEqual(result.returncode, code, result.stderr)

    def test_no_download_curl_bypasses_fetch(self):
        downloads = []
        for path in TEMPLATES.rglob('*.sh'):
            for number, line in enumerate(path.read_text().replace('\\\n', ' ').splitlines(), 1):
                if re.search(r'\bcurl\b', line) and re.search(r'(?:\s-o\b|\|\s*tar\b)', line):
                    downloads.append((path.relative_to(TEMPLATES).as_posix(), number))
        self.assertEqual([path for path, _ in downloads], ['tools/fetch.sh'], downloads)

    def test_fetch_applies_bounds_and_maps_curl_failure(self):
        self.shim('curl', 'printf "%s\\n" "$@" > "$CALLS"\nexit "$CURL_RC"\n')
        snippet = next(line for line in (TEMPLATES / 'generic.sh').read_text().splitlines()
                       if re.match(r'\s*(?:curl|offbox_fetch)\s+', line))
        for rc in (28, 0):
            with self.subTest(curl_exit=rc):
                result = subprocess.run(['/bin/bash', '-c', FETCH + '\nset -eu\n' + snippet],
                                        env=dict(self.env, CURL_RC=str(rc), GO_VERSION='1.26.9'),
                                        text=True, capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 98 if rc else 0, result.stderr)
                if rc:
                    self.assertIn('offbox: download failed (curl exit 28)', result.stderr)
                else:
                    self.assertEqual(result.stderr, '')
                args = self.calls()
                for option, value in (('--connect-timeout', '20'), ('--speed-limit', '30720'),
                                      ('--speed-time', '60'), ('--max-time', '600'), ('--retry', '2')):
                    self.assertIn(option, args)
                    self.assertEqual(args[args.index(option) + 1], value)
                self.assertEqual(args[-3:], ['https://go.dev/dl/go1.26.9.linux-amd64.tar.gz', '-o', '/tmp/go.tgz'])


if __name__ == "__main__":
    unittest.main()
