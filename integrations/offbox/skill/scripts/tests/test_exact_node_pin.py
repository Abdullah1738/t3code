"""Exact pins and user-controlled PATH across nvm, cd and nested Bash."""
from pathlib import Path
import shlex
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import node_version, pnpm_version, runs
import test_node_tools
import test_node_version

K = node_version._key


class PrecisionTests(unittest.TestCase):
    def test_pin_precision_table(self):
        cases = [
            ('22.13.0', [(K(22, 13), K(22, 13) + 1)]),
            ('v22.13.0', [(K(22, 13), K(22, 13) + 1)]),
            ('22.13', [(K(22, 13), K(22, 14))]),
            ('22', [(K(22), K(23))]),
            ('lts/jod', [(K(22), K(23))]),
            ('lts/*', None), ('node', None), ('stable', None),
        ]
        for value, expected in cases:
            for text in (value, f'\n # comment\n  {value}  # pin\n'):
                with self.subTest(text=text):
                    self.assertEqual(node_version.parse_nvmrc(text), expected)

    def test_both_pin_files_use_the_same_precision(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'package.json').write_text('{"engines":{"node":">=22.13.0"}}')
            for name in ('.nvmrc', '.node-version'):
                for pin, upper in [('22.13.0', K(22, 13) + 1), ('v22.13.0', K(22, 13) + 1),
                                   ('22.13', K(22, 14)), ('22', K(23))]:
                    with self.subTest(name=name, pin=pin):
                        (root / name).write_text(f'# pin\n {pin} # CI\n')
                        self.assertEqual(node_version.want(root, root)[0], [(K(22, 13), upper)])
                (root / name).unlink()

    def test_exact_installed_and_remote_selection(self):
        for installed in [('v22.23.5',), ('v22.13.0', 'v22.23.5')]:
            with self.subTest(installed=installed):
                result, count = test_node_version.ProvisionTests().run_provision(
                    pin='22.13.0', engine='>=22.13.0', installed=installed)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.splitlines()[-1], 'v22.13.0')
                self.assertEqual(count, 5 if len(installed) == 1 else 0)
                self.assertIn('.nvmrc 22.13.0 (exact)', result.stderr)


class ActivationTests(unittest.TestCase):
    # Share the shell fixture without inheriting its unrelated tests.
    setUp = test_node_tools.RepoToolTests.setUp
    manifest = test_node_tools.RepoToolTests.manifest
    tool = test_node_tools.RepoToolTests.tool
    run_script = test_node_tools.RepoToolTests.run_script

    def activation(self, *, system=False, pnpm=False):
        selected = self.home / ('.nvm/versions/node/v22.13.0/bin' if not system else 'selected/bin')
        if system:
            self.env['PATH'] = str(selected) + ':' + self.env['PATH']
        for name in ('node', 'npm', 'npx', 'corepack'):
            self.tool(selected, name, 'v22.13.0')
            self.tool(self.global_bin, name, 'v24.0.0')
            self.tool(self.root / 'node_modules/.bin', name, 'repo-shadow')
        self.tool(self.root / 'apps/server/node_modules/.bin', 'vp', 'server')
        (self.root / '.nvmrc').write_text('22.13.0')
        node = node_version.block(node_version.want(self.root, self.root))
        if pnpm:
            self.tool(self.global_bin, 'pnpm', '11.10.0')
            self.tool(self.home / '.offbox/toolchains/pnpm/11.10.0/bin', 'pnpm', '11.10.0')
            self.tool(self.root / 'node_modules/.bin', 'pnpm', 'repo-pnpm')
            node += '\n' + pnpm_version.block(('11.10.0', 'packageManager'))
        return selected, node

    def test_nvm_use_and_exec_replace_selected_bin_in_place(self):
        selected, node = self.activation()
        other = self.home / '.nvm/versions/node/v22.23.5/bin'
        for name in ('node', 'npm', 'npx', 'corepack'):
            self.tool(other, name, 'v22.23.5')
        self.env['PATH'] += ':' + str(other)
        (self.home / '.nvm/nvm.sh').write_text(r'''
nvm() {
  local target="$HOME/.nvm/versions/node/v${2#v}/bin"
  if [ "$1" = exec ]; then
    (nvm use "$2"; shift 2; "$@")
  else
    export PATH="${PATH/$NVM_BIN/$target}"
    export NVM_BIN="$target"
  fi
}
''')
        command = ('export NVM_DIR="$HOME/.nvm" NVM_BIN=' + shlex.quote(str(selected)) +
                   '; . "$NVM_DIR/nvm.sh"; nvm exec 22.23.5 node --version; '
                   'nvm use 22.23.5; cd apps/server; node --version; '
                   'command -v node npm npx corepack')
        p = self.run_script([command], node=node)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout.splitlines(), ['v22.23.5', 'v22.23.5'] +
                         [str(other / name) for name in ('node', 'npm', 'npx', 'corepack')])

    def test_fixture_path_survives_cd_and_child_bash(self):
        for system in (True, False):
            with self.subTest(system=system):
                _, node = self.activation(system=system, pnpm=True)
                for name in ('node', 'npm', 'npx', 'corepack'):
                    (self.root / 'node_modules/.bin' / name).unlink()
                fixture = self.home / 'fixture/bin'
                self.tool(fixture, 'node', 'fixture-node')
                bash = shlex.quote(shutil.which('bash'))
                cases = {
                    'outside': 'cd /; command -v node',
                    'inside': 'cd apps/server; command -v node; vp',
                    'no BASH_ENV': f'env -u BASH_ENV {bash} -c "cd /; command -v node"',
                    'BASH_ENV': f'{bash} -c "command -v node"',
                    'BASH_ENV cd': f'{bash} -c "cd /; command -v node"',
                    'leave repo': 'cd apps/server; cd /; command -v node; printf "%s\\n" "$PATH"',
                }
                for label, command in cases.items():
                    with self.subTest(case=label):
                        p = self.run_script(['export PATH=' + shlex.quote(str(fixture)) + ':"$PATH"; ' + command], node=node)
                        self.assertEqual(p.returncode, 0, p.stderr)
                        lines = p.stdout.splitlines()
                        self.assertEqual(lines[0], str(fixture / 'node'))
                        if label == 'inside':
                            self.assertEqual(lines[1], 'server')
                        if label == 'leave repo':
                            self.assertNotIn('node_modules/.bin', lines[1])
                            self.assertTrue(lines[1].startswith(str(fixture) + ':'))
                # Reuse fixture paths on the next iteration.
                (self.root / '.nvmrc').unlink()

    def test_owned_entries_keep_order_and_empty_path_segments(self):
        _, node = self.activation(pnpm=True)
        fixture = self.home / 'fixture/bin'
        self.tool(fixture, 'node', 'fixture-node')
        command = ('cd /; export PATH=' + shlex.quote(str(fixture)) +
                   ':"$PATH"; export PATH=":$PATH:"; before=$PATH; '
                   'cd "$__offbox_repo_root/apps/server"; cd /; '
                   '[ "$PATH" = "$before" ] && command -v node')
        p = self.run_script([command], node=node)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout.strip(), str(fixture / 'node'))

    def test_selected_tools_beat_box_and_repo_defaults(self):
        selected, node = self.activation(pnpm=True)
        p = self.run_script(['node --version; cd apps/server; command -v node npm npx corepack; pnpm; vp'], node=node)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout.splitlines(), ['v22.13.0'] +
                         [str(selected / name) for name in ('node', 'npm', 'npx', 'corepack')] +
                         ['11.10.0', 'server'])

    def test_exact_pin_hint_names_version(self):
        self.activation()
        self.assertIn('Use Node v22.13.0 exactly', runs.missing_deps_hint(self.root))
