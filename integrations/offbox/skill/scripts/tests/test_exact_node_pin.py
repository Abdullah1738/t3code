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
        selected, node = self.activation(pnpm=True)
        other = self.home / '.nvm/versions/node/v22.23.5/bin'
        for name in ('node', 'npm', 'npx', 'corepack'):
            self.tool(other, name, 'v22.23.5')
        self.tool(other, 'vp', 'global-vp')
        self.env['PATH'] += ':' + str(other)
        (self.home / '.nvm/nvm.sh').write_text(r'''
nvm() {
  local target="$HOME/.nvm/versions/node/v${2#v}/bin"
  if [ "$1" = exec ]; then
    (nvm use "$2"; shift 2; "$@")
  else
    local entry tail=$PATH rest= sep=
    while :; do
      entry=${tail%%:*}
      case "$entry" in "$HOME"/.nvm/.offbox-*/bin|"$HOME"/.nvm/versions/node/*/bin) entry=$target ;; esac
      rest="$rest$sep$entry"; sep=:
      [[ $tail == *:* ]] || break
      tail=${tail#*:}
    done
    export PATH=$rest
    export NVM_BIN="$target"
  fi
}
''')
        command = ('export NVM_DIR="$HOME/.nvm" NVM_BIN=' + shlex.quote(str(selected)) +
                   '; . "$NVM_DIR/nvm.sh"; nvm exec 22.23.5 node --version; '
                   'nvm use 22.23.5; cd apps/server; node --version; '
                   'npm --version; npx --version; corepack --version; '
                   'for name in node npm npx corepack; do dirname "$(command -v "$name")"; done; vp')
        p = self.run_script([command], node=node)
        self.assertEqual(p.returncode, 0, p.stderr)
        lines = p.stdout.splitlines()
        self.assertEqual(lines[:5], ['v22.23.5'] * 5)
        self.assertEqual(len(set(lines[5:9])), 1)
        self.assertEqual(lines[9:], ['global-vp'])

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
        _, node = self.activation(pnpm=True)
        p = self.run_script(['node --version; cd apps/server; npm --version; npx --version; corepack --version; pnpm; vp'], node=node)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout.splitlines(), ['v22.13.0'] * 4 + ['11.10.0', 'server'])

    def test_colocated_globals_lose_to_repo_tools(self):
        # Both sources can carry globally installed CLIs alongside Node.
        for system in (True, False):
            for pnpm in (False, True):
                with self.subTest(system=system, pnpm=pnpm):
                    selected, node = self.activation(system=system, pnpm=pnpm)
                    for name in ('vp', 'tsc-rs'):
                        self.tool(selected, name, 'global-' + name)
                        self.tool(self.root / 'node_modules/.bin', name, 'repo-' + name)
                        self.tool(self.root / 'apps/server/node_modules/.bin', name, 'server-' + name)
                    # Exercise direct commands, child shells and steps, retaining
                    # repo Node shadows to check the toolchain at the same time.
                    probe = 'node --version; npm --version; npx --version; corepack --version; vp; tsc-rs'
                    expected = ['v22.13.0'] * 4 + ['repo-vp', 'repo-tsc-rs']
                    server = ['v22.13.0'] * 4 + ['server-vp', 'server-tsc-rs']
                    bash = shlex.quote(shutil.which('bash'))
                    children = [bash + ' -c ', 'env -u BASH_ENV ' + bash + ' -c ',
                                'env -i HOME="$HOME" PATH="$PATH" ' + bash + ' -c ']
                    for stepped in (False, True):
                        for child in children:
                            with self.subTest(stepped=stepped, child=child):
                                command = probe + '; cd apps/server; ' + probe + '; ' + child + shlex.quote(probe)
                                p = self.run_script([] if stepped else [command],
                                                    steps=[probe, 'cd apps/server; ' + probe,
                                                           'cd apps/server; ' + child + shlex.quote(probe)] if stepped else None,
                                                    node=node)
                                self.assertEqual(p.returncode, 0, p.stderr)
                                self.assertEqual(p.stdout.splitlines(), expected + server + server)

    def test_inherited_nvm_bin_without_node_pin_keeps_repo_tools_first(self):
        selected = self.home / '.nvm/versions/node/v22.13.0/bin'
        self.tool(selected, 'node', 'v22.13.0')
        self.env['PATH'] = str(selected) + ':' + self.env['PATH']
        self.env['NVM_BIN'] = str(selected)
        self.assertIsNone(node_version.want(self.root, self.root))
        for name in ('vp', 'tsc-rs'):
            self.tool(selected, name, 'global-' + name)
            self.tool(self.root / 'node_modules/.bin', name, 'repo-' + name)
            self.tool(self.root / 'apps/server/node_modules/.bin', name, 'server-' + name)
        self.tool(self.global_bin, 'pnpm', '11.10.0')
        self.tool(self.home / '.offbox/toolchains/pnpm/11.10.0/bin', 'pnpm', '11.10.0')
        self.tool(self.root / 'node_modules/.bin', 'pnpm', 'repo-pnpm')
        bash = shlex.quote(shutil.which('bash'))
        for pnpm in (False, True):
            node = pnpm_version.block(('11.10.0', 'packageManager')) if pnpm else ''
            probe = 'vp; tsc-rs; node --version' + ('; pnpm --version' if pnpm else '')
            root = ['repo-vp', 'repo-tsc-rs', 'v22.13.0'] + (['11.10.0'] if pnpm else [])
            server = ['server-vp', 'server-tsc-rs', 'v22.13.0'] + (['11.10.0'] if pnpm else [])
            for stepped in (False, True):
                for child in (bash + ' -c ', 'env -u BASH_ENV ' + bash + ' -c ',
                              'env -i HOME="$HOME" PATH="$PATH" ' + bash + ' -c '):
                    with self.subTest(pnpm=pnpm, stepped=stepped, child=child):
                        commands = [probe, 'cd apps/server; ' + probe,
                                    'cd apps/server; ' + child + shlex.quote(probe)]
                        p = self.run_script([] if stepped else [
                            probe + '; cd apps/server; ' + probe + '; ' + child + shlex.quote(probe)],
                            steps=commands if stepped else None, node=node)
                        self.assertEqual(p.returncode, 0, p.stderr)
                        self.assertEqual(p.stdout.splitlines(), root + server + server)

    def test_exact_pin_hint_names_version(self):
        self.activation()
        self.assertIn('Use Node v22.13.0 exactly', runs.missing_deps_hint(self.root))

    def test_reactivation_refreshes_filtered_commands(self):
        for system in (True, False):
            with self.subTest(system=system):
                selected, node = self.activation(system=system, pnpm=True)
                self.tool(selected, 'vp', 'global-vp')
                self.tool(self.root / 'node_modules/.bin', 'vp', 'repo-vp')
                repeat = node + '\nrm -f ' + shlex.quote(str(selected / 'corepack')) + '\n' + node
                p = self.run_script(['node --version; vp; '
                                     'test ! -e "$__offbox_node_commands/corepack" && printf "%s\\n" "$PATH"'], node=repeat)
                self.assertEqual(p.returncode, 0, p.stderr)
                lines = p.stdout.splitlines()
                self.assertEqual(lines[:2], ['v22.13.0', 'repo-vp'])
                expected = (self.home / '.offbox/toolchains/node/r/bin' if system else
                            self.home / '.nvm/.offbox-r/bin')
                self.assertEqual(lines[2].split(':').count(str(expected)), 1)

    def test_selected_directory_path_forms(self):
        initial_path = self.env['PATH']
        selected, _ = self.activation(system=True)
        alias = self.home / 'node alias'
        alias.symlink_to(selected, target_is_directory=True)
        (self.root / 'selected').symlink_to(selected.parent, target_is_directory=True)
        cases = [
            ('absolute', str(selected)),
            ('relative descendant', 'selected/bin'),
            ('relative', '../../selected/bin'),
            ('dot segments', './../../selected/./bin'),
            ('absolute symlink', str(alias)),
            ('relative symlink', '../../node alias'),
            ('current directory', '.'),
            ('empty entry', ''),
        ]
        for name, entry in cases:
            for cdpath in ('', '.'):
                with self.subTest(name=name, cdpath=cdpath):
                    if entry in ('', '.'):
                        for command in ('node', 'npm', 'npx', 'corepack'):
                            self.tool(self.root, command, 'v22.13.0')
                    self.env['PATH'] = entry + ':' + initial_path
                    self.env['CDPATH'] = cdpath
                    node = node_version.block(node_version.want(self.root, self.root))
                    probe = 'node --version; npm --version; npx --version; corepack --version'
                    p = self.run_script([probe + '; cd apps/server; ' + probe], node=node)
                    self.assertEqual(p.returncode, 0, p.stderr)
                    # cd itself may print with CDPATH set; activation must not.
                    self.assertEqual([line for line in p.stdout.splitlines() if line.startswith(('v', 'repo-'))],
                                     ['v22.13.0'] * 8)


class RealNvmTests(unittest.TestCase):
    def install_nvm(self, fixture):
        (fixture.home / '.nvm').mkdir(exist_ok=True)
        for name in ('nvm.sh', 'nvm-exec'):
            shutil.copyfile(Path(__file__).parent / 'fixtures/nvm-0.40.3' / name,
                            fixture.home / '.nvm' / name)
        (fixture.home / '.nvm/nvm-exec').chmod(0o755)

    def test_symlinked_nvm_installations(self):
        for component in ('.nvm', 'versions', 'node versions', 'version', 'bin', 'executable'):
            for alias_root in (False, True):
                with self.subTest(component=component, alias_root=alias_root):
                    fixture = ActivationTests()
                    fixture.setUp()
                    self.addCleanup(fixture.doCleanups)
                    selected, node = fixture.activation(pnpm=True)
                    self.install_nvm(fixture)
                    original = {
                        '.nvm': fixture.home / '.nvm',
                        'versions': fixture.home / '.nvm/versions',
                        'node versions': fixture.home / '.nvm/versions/node',
                        'version': selected.parent,
                        'bin': selected,
                        'executable': selected / 'node',
                    }[component]
                    external = fixture.home / 'external/cache'
                    external.parent.mkdir()
                    original.rename(external)
                    original.symlink_to(external, target_is_directory=component != 'executable')
                    alias = fixture.home / 'nvm alias'
                    alias.symlink_to(fixture.home / '.nvm', target_is_directory=True)
                    fixture.env['NVM_DIR'] = str(alias if alias_root else fixture.home / '.nvm')
                    other = fixture.home / '.nvm/versions/node/v25.0.0/bin'
                    for directory, version in ((selected, 'v22.13.0'), (other, 'v25.0.0')):
                        fixture.tool(directory, 'npm', version)
                        (directory / 'npm').write_text(
                            '#!/bin/sh\n[ "$1" = --version ] && echo ' + version + '\nexit 0\n')
                    fixture.tool(other, 'node', 'v25.0.0')
                    bash = shlex.quote(shutil.which('bash'))
                    command = ('. "$NVM_DIR/nvm.sh" --no-use; node --version; nvm current; '
                               'nvm exec --silent current node --version; '
                               'nvm use --silent 25.0.0; node --version; '
                               'cd apps/server; node --version; ' + bash + ' -c "node --version"; '
                               'rm -f "$__offbox_repo_root/node_modules/.bin/node"; '
                               'nvm use --silent system; nvm current; node --version; '
                               'cd .; node --version; ' + bash + ' -c "node --version"')
                    p = fixture.run_script([command], node=node, timeout=60)
                    self.assertEqual(p.returncode, 0, p.stderr)
                    self.assertEqual(p.stdout.splitlines(), ['v22.13.0'] * 3 + ['v25.0.0'] * 3 +
                                     ['system'] + ['v24.0.0'] * 3)

    def test_nvm_directory_path_forms(self):
        cases = ('absolute', 'trailing slash', 'trailing slashes', 'relative', 'relative trailing slash',
                 'dot segments', 'absolute symlink', 'relative symlink')
        for custom in (False, True):
            for name in cases:
                with self.subTest(custom=custom, name=name):
                    fixture = ActivationTests()
                    fixture.setUp()
                    self.addCleanup(fixture.doCleanups)
                    selected, node = fixture.activation(pnpm=True)
                    self.install_nvm(fixture)
                    nvm_dir = fixture.home / ('custom nvm' if custom else '.nvm')
                    if custom:
                        (fixture.home / '.nvm').rename(nvm_dir)
                        selected = nvm_dir / 'versions/node/v22.13.0/bin'
                    alias = fixture.home / 'nvm alias'
                    alias.symlink_to(nvm_dir, target_is_directory=True)
                    fixture.env['NVM_DIR'] = {
                        'absolute': str(nvm_dir),
                        'trailing slash': str(nvm_dir) + '/',
                        'trailing slashes': str(nvm_dir) + '///',
                        'relative': '../../' + nvm_dir.name,
                        'relative trailing slash': '../../' + nvm_dir.name + '/',
                        'dot segments': str(nvm_dir) + '/../' + nvm_dir.name + '/.',
                        'absolute symlink': str(alias),
                        'relative symlink': '../../nvm alias',
                    }[name]
                    # nvm may already be active using this unnormalized spelling.
                    fixture.env['PATH'] = (fixture.env['NVM_DIR'] + '/versions/node/v22.13.0/bin:' +
                                           fixture.env['PATH'])
                    fixture.env['CDPATH'] = '.'
                    other = nvm_dir / 'versions/node/v25.0.0/bin'
                    for directory, version in ((selected, 'v22.13.0'), (other, 'v25.0.0')):
                        fixture.tool(directory, 'node', version)
                        fixture.tool(directory, 'npm', version)
                        (directory / 'npm').write_text(
                            '#!/bin/sh\n[ "$1" = --version ] && echo ' + version + '\nexit 0\n')
                    bash = shlex.quote(shutil.which('bash'))
                    command = ('node --version; npm --version; . "$NVM_DIR/nvm.sh" --no-use; '
                               'nvm current; nvm exec --silent current node --version; '
                               'nvm use --silent 25.0.0; node --version; npm --version; '
                               'cd apps/server >/dev/null; node --version; ' + bash +
                               ' -c "node --version"; nvm current; '
                               'rm -f "$__offbox_repo_root/node_modules/.bin/node"; '
                               'nvm use --silent system; nvm current; node --version; '
                               'cd "$__offbox_repo_root" >/dev/null; node --version; ' + bash +
                               ' -c "node --version"')
                    p = fixture.run_script([command], node=node, timeout=60)
                    self.assertEqual(p.returncode, 0, p.stderr)
                    self.assertEqual(p.stdout.splitlines(), ['v22.13.0'] * 4 + ['v25.0.0'] * 5 +
                                     ['system'] + ['v24.0.0'] * 3)

    def test_current_switches_and_optional_tools_with_real_nvm(self):
        for system in (False, True):
            for old_corepack in (False, True):
                for new_corepack in (False, True):
                    with self.subTest(system=system, old_corepack=old_corepack, new_corepack=new_corepack):
                        fixture = ActivationTests()
                        fixture.setUp()
                        self.addCleanup(fixture.doCleanups)
                        selected, node = fixture.activation(system=system, pnpm=True)
                        if not old_corepack:
                            (selected / 'corepack').unlink()
                        (fixture.root / 'node_modules/.bin/corepack').unlink()
                        fixture.tool(fixture.global_bin, 'corepack', 'fallback-corepack')
                        other = fixture.home / '.nvm/versions/node/v25.0.0/bin'
                        for name in ('node', 'npm', 'npx'):
                            fixture.tool(other, name, 'v25.0.0')
                        if new_corepack:
                            fixture.tool(other, 'corepack', 'v25.0.0')
                        self.install_nvm(fixture)
                        # npm's prefix probe should behave like an unconfigured install.
                        for directory, version in ((selected, 'v22.13.0'), (other, 'v25.0.0')):
                            (directory / 'npm').write_text(
                                '#!/bin/sh\n[ "$1" = --version ] && echo ' + version + '\nexit 0\n')
                        bash = shlex.quote(shutil.which('bash'))
                        command = ('export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" --no-use; '
                                   'nvm current; ' + ('' if system else 'nvm exec --silent current node --version; ') +
                                   'nvm use --silent 25.0.0; node --version; nvm current; '
                                   'cd apps/server; node --version; npm --version; npx --version; '
                                   'corepack --version; pnpm --version; ' + bash + ' -c "node --version"; '
                                   'rm -f "$__offbox_repo_root/node_modules/.bin/node"; '
                                   'nvm use --silent system; nvm current; node --version; '
                                   'nvm use --silent 25.0.0; cd .; node --version')
                        p = fixture.run_script([command], node=node, timeout=60)
                        self.assertEqual(p.returncode, 0, p.stderr)
                        fallback = 'v22.13.0' if old_corepack else 'fallback-corepack'
                        expected = ['system' if system else 'v22.13.0']
                        if not system:
                            expected += ['v22.13.0']
                        expected += ['v25.0.0'] * 5 + [
                            'v25.0.0' if new_corepack else fallback,
                            '11.10.0', 'v25.0.0', 'system',
                            'v22.13.0' if system else 'v24.0.0', 'v25.0.0']
                        self.assertEqual(p.stdout.splitlines(), expected)
