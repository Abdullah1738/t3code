"""Run the repository setup preamble under real bash without root or network access."""
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import runs
from offbox_lib import common, misc, pool
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_capacity import Isolated

KEY = 'usdtwallet-android'
RECIPE = r'''set -euo pipefail
echo run >> "$HOME/calls"
[ "${FAIL_SETUP:-0}" = 0 ] || { echo INSTALL_FAILED; exit 7; }
mkdir -p "$HOME/.offbox/repo-env" "$HOME/mobile/bin"
printf '#!/bin/sh\nexit 0\n' > "$HOME/mobile/bin/gomobile"
chmod +x "$HOME/mobile/bin/gomobile"
printf 'export JAVA_HOME="$HOME/java"\nexport PATH="$HOME/mobile/bin:$PATH"\n' > "$HOME/.offbox/repo-env/usdtwallet-android.sh"
'''


class RepoSetupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.root = self.home / 'w/repo'
        (self.root / 'core').mkdir(parents=True)
        (self.root / 'android').mkdir()
        self.mod = self.root / 'core/go.mod'
        self.mod.write_text('module wallet\nrequire (\n golang.org/x/mobile v1.0.0\n)\n')
        self.recipes = self.home / 'recipes'
        self.recipes.mkdir()
        self.recipe = self.recipes / f'{KEY}.sh'
        self.recipe.write_text(RECIPE)
        bins = self.home / 'bin'
        bins.mkdir()
        # flock uses an inherited descriptor, so the lock stays held by bash after this shim exits.
        flock = bins / 'flock'
        flock.write_text(f'#!{sys.executable}\nimport fcntl, os, sys\n'
                         'if os.environ.get("FAIL_LOCK"): sys.exit(1)\n'
                         'fcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX)\n')
        flock.chmod(0o755)
        python = bins / 'python3'
        python.symlink_to(sys.executable)
        self.env = dict(os.environ, HOME=str(self.home), PATH=f'{bins}:/usr/bin:/bin:/usr/sbin:/sbin')
        self.stamp = self.home / f'.offbox/repo-setup-{KEY}.stamp'

    def script(self, key=KEY):
        with patch.object(runs, 'REPO_RECIPES_DIR', self.recipes), \
             patch.object(runs, 'DOCKER_REPAIR', ':'), patch.object(runs, 'LDCACHE_REPAIR', ':'), \
             patch.object(runs, 'GO_REPAIR', 'echo GO_REPAIR'):
            return runs.remote_script('w/repo', 'android', [], None, 'run-test', repo_key=key,
                                      steps=['echo USER_COMMAND; echo "$JAVA_HOME"; command -v gomobile'])

    def run_script(self, **env):
        return subprocess.run(['bash', '-c', self.script()], env=dict(self.env, **env),
                              capture_output=True, text=True, timeout=15)

    def calls(self):
        return (self.home / 'calls').read_text().splitlines()

    def test_unknown_repo_has_no_setup(self):
        self.assertNotIn('# offbox-repo-setup', self.script('other-repo'))
        self.assertNotIn('# offbox-repo-setup', self.script('../usdtwallet-android'))

    def test_first_run_writes_stamp_and_sources_environment_from_subdirectory(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls(), ['run'])
        expected = hashlib.sha256(RECIPE.encode() + b'\0v1.0.0').hexdigest()
        self.assertEqual(self.stamp.read_text().strip(), expected)
        self.assertIn(str(self.home / 'java'), result.stdout)
        self.assertIn(str(self.home / 'mobile/bin/gomobile'), result.stdout)
        self.assertLess(result.stdout.index('GO_REPAIR'), result.stdout.index('USER_COMMAND'))
        self.assertIn('setting up usdtwallet-android toolchain', result.stderr)

    def test_matching_stamp_skips_recipe(self):
        self.assertEqual(self.run_script().returncode, 0)
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls(), ['run'])
        self.assertNotIn('setting up', result.stderr)
        self.assertIn(str(self.home / 'mobile/bin/gomobile'), result.stdout)

    def test_changed_mobile_version_invalidates_stamp_for_both_require_forms(self):
        self.assertEqual(self.run_script().returncode, 0)
        for text in ('require golang.org/x/mobile v1.0.1 // indirect\n',
                     'require (\n\tgolang.org/x/mobile v1.0.2\n)\n'):
            with self.subTest(mod=text):
                old = self.stamp.read_text()
                self.mod.write_text(text)
                result = self.run_script()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('setting up', result.stderr)
                self.assertNotEqual(old, self.stamp.read_text())
        self.assertEqual(len(self.calls()), 3)

    def test_changed_recipe_and_missing_env_each_trigger_setup(self):
        self.assertEqual(self.run_script().returncode, 0)
        self.recipe.write_text(RECIPE + '\necho changed\n')
        self.assertEqual(self.run_script().returncode, 0)
        (self.home / f'.offbox/repo-env/{KEY}.sh').unlink()
        self.assertEqual(self.run_script().returncode, 0)
        self.assertEqual(len(self.calls()), 3)

    def test_recipe_failure_never_writes_stamp_or_runs_user_command(self):
        result = self.run_script(FAIL_SETUP='1')
        self.assertEqual(result.returncode, runs.EXIT_REPO_SETUP, result.stderr)
        self.assertFalse(self.stamp.exists())
        self.assertIn('INSTALL_FAILED', result.stderr)
        self.assertIn('toolchain setup failed on this box; nothing ran', result.stderr)
        self.assertNotIn('USER_COMMAND', result.stdout)
        self.assertNotIn('GO_REPAIR', result.stdout)
        self.assertEqual(self.run_script().returncode, 0)

    def test_lock_failure_never_runs_recipe_or_command(self):
        result = self.run_script(FAIL_LOCK='1')
        self.assertEqual(result.returncode, runs.EXIT_REPO_SETUP)
        self.assertFalse(self.stamp.exists())
        self.assertFalse((self.home / 'calls').exists())
        self.assertNotIn('USER_COMMAND', result.stdout)

    def test_failed_upgrade_invalidates_the_previous_success_stamp(self):
        self.assertEqual(self.run_script().returncode, 0)
        self.mod.write_text('require golang.org/x/mobile v1.0.1\n')
        result = self.run_script(FAIL_SETUP='1')
        self.assertEqual(result.returncode, runs.EXIT_REPO_SETUP)
        self.assertFalse(self.stamp.exists())
        self.assertNotIn('USER_COMMAND', result.stdout)

    def test_real_recipe_syntax_and_wrapped_script_size(self):
        recipe = runs.REPO_RECIPES_DIR / f'{KEY}.sh'
        result = subprocess.run(['bash', '-n', str(recipe)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        script = runs.remote_script('w/repo', '.', [], None, 'run-test', repo_key=KEY,
                                    wait_images=True, steps=['java -version'])
        result = subprocess.run(['bash', '-n', '-c', script], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        wrapped = runs.exit_recording_command(script, 'run-test')
        # Linux MAX_ARG_STRLEN is 128 KiB, including the terminating NUL. Leave room for user commands.
        self.assertLess(len(wrapped.encode()) + 1, 64 * 1024)

    def test_real_recipe_provisions_bare_home_then_skips_installed_pieces(self):
        java_home = self.home / 'jdk17'
        bins = self.home / 'bin'
        tools = {
            'sudo': '#!/bin/bash\necho JDK >> "$HOME/installs"\nmkdir -p "$HOME/jdk17/bin"\n'
                    'touch "$HOME/jdk17/bin/java"\nchmod +x "$HOME/jdk17/bin/java"\n',
            'curl': '#!/bin/bash\necho TOOLS >> "$HOME/installs"\n',
            'unzip': '#!/bin/bash\nmkdir -p "$4/cmdline-tools/bin"\n'
                     'cp "$HOME/sdkmanager" "$4/cmdline-tools/bin/sdkmanager"\n',
            'go': '#!/bin/bash\necho "$*" >> "$HOME/go-installs"\nmkdir -p "$GOBIN"\n'
                  'touch "$GOBIN/gomobile" "$GOBIN/gobind"\nchmod +x "$GOBIN/"*\n',
        }
        for name, body in tools.items():
            tool = bins / name
            tool.write_text(body)
            tool.chmod(0o755)
        sdk = self.home / 'sdkmanager'
        sdk.write_text('#!/bin/bash\nset -e\nread -r accepted\nshift\n'
                       'for package in "$@"; do\n echo "$package" >> "$HOME/packages"\n'
                       ' mkdir -p "$ANDROID_HOME/${package//;///}"\n'
                       ' touch "$ANDROID_HOME/${package//;///}/package.xml"\ndone\n')
        sdk.chmod(0o755)
        recipe = (runs.REPO_RECIPES_DIR / f'{KEY}.sh').read_text()
        recipe = recipe.replace('/usr/lib/jvm/java-17-openjdk-amd64', str(java_home))
        recipe = recipe.replace('/usr/local/go/bin', str(bins))
        path = self.home / 'real-recipe.sh'
        path.write_text(recipe)
        env = dict(self.env, OFFBOX_REPO_ROOT=str(self.root))
        for _ in range(2):
            result = subprocess.run(['bash', str(path)], env=env, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.home / 'installs').read_text().splitlines(), ['JDK', 'TOOLS'])
        self.assertEqual((self.home / 'packages').read_text().splitlines(), [
            'platform-tools', 'platforms;android-37.1', 'platforms;android-36',
            'build-tools;36.0.0', 'ndk;26.3.11579264'])
        installs = (self.home / 'go-installs').read_text().splitlines()
        self.assertEqual(installs, ['install golang.org/x/mobile/cmd/gomobile@v1.0.0 '
                                    'golang.org/x/mobile/cmd/gobind@v1.0.0'])
        env_file = self.home / f'.offbox/repo-env/{KEY}.sh'
        result = subprocess.run(['bash', '-c', '. "$1"; echo "$JAVA_HOME"; command -v gomobile', 'test', str(env_file)],
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(str(java_home), result.stdout)
        self.assertIn('x-mobile-v1.0.0/bin/gomobile', result.stdout)


class RepoSetupExitTests(Isolated):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(runs.lease, 'touch'))
        self.stack.enter_context(patch.object(runs.lease, 'idle_ttl'))
        self.box('bx_setup', member=True)
        self.con.execute("INSERT INTO runs(run_id,box_id,status,process_id,pulls,mode) "
                         "VALUES ('run-setup','bx_setup','running',1,'[]','bg')")
        self.con.commit()
        self.log = common.LOGS_DIR / 'run-setup.log'
        self.log.write_text(runs.REPO_SETUP_FAILED_MARKER + '\n')

    def row(self):
        return self.con.execute("SELECT * FROM runs WHERE run_id='run-setup'").fetchone()

    def test_wait_finalizes_setup_failure_as_infra_without_pulls(self):
        with patch.object(runs, 'do_pulls') as pull:
            self.assertEqual(misc._finalize(self.row(), 98, self.log), 90)
        pull.assert_not_called()
        self.assertEqual(self.row()['status'], 'infra')
        self.assertEqual(misc._settled(self.row()), 90)

    def test_settled_legacy_failure_uses_marker_but_user_98_is_preserved(self):
        self.con.execute("UPDATE runs SET status='failed',exit_code=98 WHERE run_id='run-setup'")
        self.con.commit()
        self.assertEqual(misc._settled(self.row()), 90)
        self.log.write_text('user failure\n')
        self.assertEqual(misc._settled(self.row()), 98)

    def test_background_reclamation_maps_only_marked_setup_failure(self):
        status = dict(running=False, status='exited', exitCode=98, stderr=runs.REPO_SETUP_FAILED_MARKER + '\n')
        with patch.object(runs.api, 'cmd_status', return_value=status), patch.object(runs, 'do_pulls') as pull:
            pool._refresh_background(self.con, 'repo')
        self.assertEqual(self.row()['status'], 'infra')
        self.assertEqual(self.row()['exit_code'], 90)
        pull.assert_not_called()


if __name__ == '__main__':
    unittest.main()
