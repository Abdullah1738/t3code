"""Node version pick: parser cases, repo lookup, and the real bash block (no boat calls)."""
import json
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import node_version, runs  # noqa: E402

K = node_version._key
TOP = node_version.TOP


class ParserTests(unittest.TestCase):
    def test_nvmrc_cases(self):
        p = node_version.parse_nvmrc
        self.assertEqual(p("22.13"), [(K(22, 13), K(22, 14))])
        self.assertEqual(p("v22.13.0"), [(K(22, 13), K(22, 13) + 1)])
        self.assertEqual(p("22"), [(K(22), K(23))])
        self.assertEqual(p("lts/jod"), [(K(22), K(23))])
        self.assertIsNone(p("lts/*"))
        self.assertIsNone(p("node"))
        self.assertIsNone(p(""))
        self.assertEqual(p("# c\n20.11.1\n"), [(K(20, 11, 1), K(20, 11, 1) + 1)])
        self.assertIsNone(p("abc"))

    def test_engines_cases(self):
        p = node_version.parse_range
        self.assertEqual(p(">=22.13 <23"), [(K(22, 13), K(23))])
        self.assertEqual(p("^24.13.1"), [(K(24, 13, 1), K(25))])
        self.assertEqual(p(">= 18"), [(K(18), TOP)])
        self.assertEqual(p("~22.13.1"), [(K(22, 13, 1), K(22, 14))])
        self.assertEqual(p("~22"), [(K(22), K(23))])
        self.assertEqual(p("^0.2.3"), [(K(0, 2, 3), K(0, 3))])
        self.assertEqual(p("^0.0.3"), [(K(0, 0, 3), K(0, 0, 4))])
        self.assertEqual(p("18 || 20 || >=22"), [(K(18), K(19)), (K(20), K(21)), (K(22), TOP)])
        self.assertEqual(p("20.x"), [(K(20), K(21))])
        self.assertEqual(p("*"), [(0, TOP)])
        self.assertEqual(p(">22"), [(K(23), TOP)])
        self.assertEqual(p(">22.13.1"), [(K(22, 13, 2), TOP)])
        self.assertEqual(p("<=22"), [(0, K(23))])
        self.assertEqual(p("<=22.1.2"), [(0, K(22, 1, 3))])
        self.assertEqual(p("16 - 18"), [(K(16), K(19))])
        self.assertEqual(p("16.2.1 - 18.3"), [(K(16, 2, 1), K(18, 4))])
        self.assertIsNone(p("foo"))
        self.assertEqual(p(">=25 <24"), [])
        self.assertEqual(p("^20.19.4 || ^22.13 || ^24.3"),
                         [(K(20, 19, 4), K(21)), (K(22, 13), K(23)), (K(24, 3), K(25))])
        self.assertIsNone(p(""))


class WantTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'repo'
        (self.root / 'sub').mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, rel, text):
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def pkg(self, node):
        self.write('package.json', json.dumps({'engines': {'node': node}}))

    def test_engines_only_at_root_found_from_sub(self):
        self.pkg('>=22.13 <23')
        w = node_version.want(self.root, self.root / 'sub')
        self.assertEqual(w, ([(K(22, 13), K(23))], 'package.json engines >=22.13 <23'))

    def test_sub_nvmrc_beats_root_engines(self):
        self.pkg('^24.13.1')
        self.write('sub/.nvmrc', '22.13\n')
        ranges, label = node_version.want(self.root, self.root / 'sub')
        self.assertEqual(ranges, [(K(22, 13), K(22, 14))])
        self.assertEqual(label, 'sub/.nvmrc 22.13')

    def test_nvmrc_and_engines_intersect(self):
        self.write('.nvmrc', '22.13.0\n')
        self.pkg('>=22.13 <23')
        ranges, label = node_version.want(self.root, self.root)
        self.assertEqual(ranges, [(K(22, 13), K(22, 13) + 1)])
        self.assertIn('.nvmrc 22.13.0', label)
        self.assertIn('package.json engines >=22.13 <23', label)

    def test_disjoint_constraints_cannot_select_node(self):
        self.write('.nvmrc', '20.11.1\n')
        self.pkg('>=22.13 <23')
        ranges, label = node_version.want(self.root, self.root)
        self.assertEqual(ranges, [])
        self.assertIn('.nvmrc 20.11.1', label)

    def test_node_version_file_used_without_nvmrc(self):
        self.write('.node-version', '22.13.0\n')
        ranges, label = node_version.want(self.root, self.root)
        self.assertEqual(ranges, [(K(22, 13), K(22, 13) + 1)])
        self.assertEqual(label, '.node-version 22.13.0 (exact)')

    def test_unusable_inputs_give_none(self):
        self.write('package.json', '{not json')
        self.assertIsNone(node_version.want(self.root, self.root))
        self.write('package.json', json.dumps({'name': 'x'}))
        self.assertIsNone(node_version.want(self.root, self.root))
        self.write('.nvmrc', 'lts/*\n')
        self.assertIsNone(node_version.want(self.root, self.root))

    def test_cwd_outside_root_checks_root_only(self):
        self.pkg('18')
        other = Path(self.tmp.name) / 'elsewhere'
        other.mkdir()
        self.assertEqual(node_version.want(self.root, other)[0], [(K(18), K(19))])

    def test_ci_literal_forms(self):
        for value, expected in [
            ('22', [(K(22), K(23))]),
            ("'22.x'", [(K(22), K(23))]),
            ('"22.13"', [(K(22, 13), K(22, 14))]),
            ('"22.13.0"', [(K(22, 13), K(22, 13, 1))]),
            ('[20, 22]', [(K(20), K(21)), (K(22), K(23))]),
            ("['20', '22.x'] # supported versions", [(K(20), K(21)), (K(22), K(23))]),
            ('[22]', [(K(22), K(23))]),
            ('[20, "${{ matrix.node }}", 22]', [(K(20), K(21)), (K(22), K(23))]),
            ('22 # CI', [(K(22), K(23))]),
            ('\n          - 20\n          - 22', [(K(20), K(21)), (K(22), K(23))]),
        ]:
            with self.subTest(value=value):
                self.write('.github/workflows/ci.yml', f'        node-version: {value}\n')
                ranges, label = node_version.want(self.root, self.root / 'sub')
                self.assertEqual(ranges, expected)
                self.assertIn('.github/workflows/ci.yml node-version', label)

    def test_matrix_list_layouts(self):
        for layout in [
            '[20, 22]',
            "['20', '22']",
            '\n          - 20\n          - 22',
            '\n        - 20\n        - 22',
            '[\n          20,\n          22\n        ]',
            "[20,\n          '22',\n        ]",
            "[20, ${{ matrix['node'] }}, 22]",
        ]:
            with self.subTest(layout=layout):
                self.write('.github/workflows/ci.yml', f'        node-version: {layout}\n')
                self.assertEqual(node_version.want(self.root, self.root)[0], [(K(20), K(21)), (K(22), K(23))])

    def test_yaml_scalar_bodies_are_not_workflow_keys(self):
        for style in ['|', '|-', '|+', '|2', '>', '>-', '>+']:
            for script_first in [True, False]:
                with self.subTest(style=style, script_first=script_first):
                    script = f'      - run: {style}\n          cat <<EOF\n          node-version: 24\n          EOF\n'
                    setup = '      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n'
                    self.write('.github/workflows/ci.yml', script + setup if script_first else setup + script)
                    self.assertEqual(node_version.want(self.root, self.root)[0], [(K(22), K(23))])

    def test_step_scalar_preserves_sibling_setup_node_keys(self):
        for style in ['|', '|-', '|+', '|2', '>', '>-', '>+']:
            with self.subTest(style=style):
                self.write('.github/workflows/ci.yml',
                           f'      - name: {style}\n          A multiline step name\n          node-version: 24\n'
                           '        uses: actions/setup-node@v4\n        with:\n          node-version: 22\n')
                self.assertEqual(node_version.want(self.root, self.root)[0], [(K(22), K(23))])

    def assert_workflow_selects_22(self, workflow):
        self.write('.github/workflows/ci.yml', workflow)
        wanted = node_version.want(self.root, self.root)
        self.assertIsNotNone(wanted)
        self.assertEqual(wanted[0], [(K(22), K(23))])
        with tempfile.TemporaryDirectory() as home:
            fake_nvm(home, ('v22.13.0', 'v24.1.0'))
            alias = Path(home) / '.nvm/alias/default'
            alias.parent.mkdir(parents=True)
            alias.write_text('24\n')
            result = subprocess.run(['bash', '-c', node_version.block(wanted) + '\nnode --version'],
                                    env={'HOME': home, 'PATH': '/usr/bin:/bin'},
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), 'v22.13.0')

    def test_matrix_include_mapping_entries(self):
        for entry in [
            '          - node-version: 22',
            "          - 'node-version': '22'",
            '          - "node-version": "22"',
            '          - os: ubuntu-latest\n            node-version: 22',
            '          - node-version: 22\n            os: ubuntu-latest',
            '          - node-version: ${{ env.NODE }}\n          - node-version: 22',
            '        - node-version: 22',
        ]:
            with self.subTest(entry=entry):
                self.assert_workflow_selects_22(
                    'jobs:\n  test:\n    strategy:\n      matrix:\n        include:\n' + entry + '\n'
                    '    steps:\n      - uses: actions/setup-node@v4\n        with:\n'
                    '          node-version: ${{ matrix.node-version }}\n')

    def test_multiline_quoted_scalars_ignore_body_keys(self):
        scalars = [
            "'echo \"\n          node-version: 24\n          \"'",
            '\"echo\n          node-version: 24\n          done\"',
            "'echo\n          it''s quoted\n          node-version: 24\n          done'",
            '\"echo\n          a \\\"quoted\\\" value\n          node-version: 24\n          done\"',
            "'echo # quoted text\n          node-version: 24\n          done' # comment",
            "'echo misleading: |\n          node-version: 24\n          done'",
            '"echo misleading: >\n          node-version: 24\n          done"',
            "&script 'echo\n          node-version: 24\n          done'",
            "!!str 'echo\n          node-version: 24\n          done'",
        ]
        setup = '      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n'
        for scalar in scalars:
            for first in [True, False]:
                with self.subTest(scalar=scalar, first=first):
                    run = '      - run: ' + scalar + '\n'
                    self.assert_workflow_selects_22('jobs:\n  test:\n    steps:\n' +
                                                    (run + setup if first else setup + run))

    def test_quoted_step_name_preserves_sibling_setup_node_keys(self):
        for quote in ["'", '\"']:
            with self.subTest(quote=quote):
                self.assert_workflow_selects_22(
                    f'jobs:\n  test:\n    steps:\n      - name: {quote}A multiline name\n'
                    f'          node-version: 24\n          ending{quote}\n'
                    '        uses: actions/setup-node@v4\n        with:\n          node-version: 22\n')

    def test_plain_commands_do_not_start_yaml_quoted_scalars(self):
        for command in ["echo don't", 'echo "shell quote', "echo 'shell quote"]:
            with self.subTest(command=command):
                self.assert_workflow_selects_22(
                    f'jobs:\n  test:\n    steps:\n      - run: {command}\n'
                    '      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n')

    def test_ci_ignored_forms_and_no_files(self):
        self.assertIsNone(node_version.want(self.root, self.root))
        self.assertIn('no pin;', node_version.block(None))
        for content in [
            'node-version: ${{ matrix.node }}',
            'node-version: "${{ env.NODE_VERSION }}"',
            'node-version-file: .nvmrc',
            '# node-version: 22',
            'node-version: not-a-version',
            'node-version: []',
        ]:
            with self.subTest(content=content):
                self.write('.github/workflows/ci.yml', content)
                self.assertIsNone(node_version.want(self.root, self.root))

    def test_repo_pins_beat_ci(self):
        self.write('.github/workflows/ci.yml', 'node-version: 20')
        for name, content in [('.nvmrc', '22'), ('.node-version', '22'),
                              ('package.json', '{"engines":{"node":"22"}}')]:
            with self.subTest(name=name):
                self.write(name, content)
                ranges, label = node_version.want(self.root, self.root)
                self.assertEqual(ranges, [(K(22), K(23))])
                self.assertNotIn('.github/', label)
                (self.root / name).unlink()

    def test_disjoint_pin_does_not_fall_through_to_ci(self):
        self.write('.nvmrc', '20')
        self.pkg('22')
        self.write('.github/workflows/ci.yml', 'node-version: 24')
        self.assertEqual(node_version.want(self.root, self.root)[0], [])

    def test_open_engines_narrow_to_ci(self):
        self.pkg('>=22')
        self.write('.github/workflows/ci.yml', 'node-version: 22')
        self.write('.github/workflows/test.yaml', 'node-version: 22')
        ranges, label = node_version.want(self.root, self.root / 'sub')
        self.assertEqual(ranges, [(K(22), K(23))])
        self.assertEqual(label, 'package.json engines >=22, narrowed by '
                               '.github/workflows/ci.yml node-version 22 (+1 workflows)')
        self.assertNotIn('open range', node_version.block((ranges, label)))

    def test_open_range_forms_and_exclusive_bounds(self):
        self.write('.github/workflows/ci.yml', 'node-version: 22')
        for spec, expected in [
            ('>=22', [(K(22), K(23))]),
            ('>=20 <24', [(K(22), K(23))]),
            ('20 - 24', [(K(22), K(23))]),
            ('20 || 22', [(K(22), K(23))]),
            ('^20 || ^22 || >=24', [(K(22), K(23))]),
            ('>=22.13 <24', [(K(22, 13), K(23))]),
            ('>=22 <=23.0.0', [(K(22), K(23))]),
            ('*', [(K(22), K(23))]),
        ]:
            with self.subTest(spec=spec):
                self.pkg(spec)
                ranges, label = node_version.want(self.root, self.root)
                self.assertEqual(ranges, expected)
                self.assertIn('narrowed by', label)

    def test_closed_range_forms_keep_pin(self):
        for ci in ['24', '22.13.0']:
            self.write('.github/workflows/ci.yml', f'node-version: {ci}')
            for spec in ['^22', '22.x', '~22.13', '22.13.0', '>=22 <23',
                         '>=22.13 <23', '22.13 || 22.23']:
                with self.subTest(ci=ci, spec=spec):
                    self.pkg(spec)
                    self.assertEqual(node_version.want(self.root, self.root),
                                     (node_version.parse_range(spec), f'package.json engines {spec}'))
                    self.assertNotIn('open range', node_version.block(node_version.want(self.root, self.root)))

    def test_version_file_precedence_survives_ci(self):
        self.pkg('>=22')
        self.write('.github/workflows/ci.yml', 'node-version: 24')
        for name in ['.nvmrc', '.node-version', 'sub/.nvmrc']:
            with self.subTest(name=name):
                self.write(name, '22.13.0')
                ranges, label = node_version.want(self.root, self.root / 'sub')
                self.assertEqual(ranges, [(K(22, 13), K(22, 13) + 1)])
                self.assertIn(f'{name} 22.13.0 (exact)', label)
                self.assertNotIn('narrowed', label)
                (self.root / name).unlink()

    def test_open_range_without_compatible_ci_keeps_pin_and_labels_choice(self):
        self.pkg('>=22')
        for ci in [None, '20', '${{ matrix.node }}']:
            with self.subTest(ci=ci):
                if ci is not None:
                    self.write('.github/workflows/ci.yml', f'node-version: {ci}')
                wanted = node_version.want(self.root, self.root)
                self.assertEqual(wanted, ([(K(22), TOP)], 'package.json engines >=22'))
                self.assertIn('package.json engines >=22; open range, newest on this box',
                              node_version.block(wanted))

    def test_ci_matrix_remaining_open_is_labelled(self):
        self.pkg('>=20')
        self.write('.github/workflows/ci.yml', 'node-version: [20, 22]')
        wanted = node_version.want(self.root, self.root)
        self.assertEqual(wanted[0], [(K(20), K(21)), (K(22), K(23))])
        self.assertIn('narrowed by', wanted[1])
        self.assertIn('open range, newest on this box', node_version.block(wanted))

    def test_want_never_raises_on_ci_lookup_failure(self):
        self.pkg('>=22')
        with patch.object(node_version, '_ci_want', side_effect=OSError('unreadable')):
            self.assertEqual(node_version.want(self.root, self.root),
                             ([(K(22), TOP)], 'package.json engines >=22'))

    def test_open_pin_follows_workflow_majority_and_names_minority(self):
        self.pkg('>=22')
        for i in range(15):
            self.write(f'.github/workflows/ci{i:02}.yml', 'node-version: 22')
        self.write('.github/workflows/registry.yml', 'node-version: 24')
        ranges, label = node_version.want(self.root, self.root)
        self.assertEqual(ranges, [(K(22), K(23))])
        self.assertIn('narrowed by .github/workflows/ci00.yml node-version 22', label)
        self.assertIn('(+14 workflows; 1 workflow uses 24)', label)

    def test_no_pin_follows_workflow_majority(self):
        self.write('.github/workflows/ci.yml', 'node-version: 22')
        self.write('.github/workflows/other.yml', 'node-version: 22')
        self.write('.github/workflows/registry.yml', 'node-version: 24')
        ranges, label = node_version.want(self.root, self.root)
        self.assertEqual(ranges, [(K(22), K(23))])
        self.assertIn('(+1 workflows; 1 workflow uses 24)', label)

    def test_open_pin_tied_workflows_choose_highest_major(self):
        self.pkg('>=22')
        self.write('.github/workflows/ci.yml', 'node-version: 22')
        self.write('.github/workflows/registry.yml', 'node-version: 24')
        ranges, label = node_version.want(self.root, self.root)
        self.assertEqual(ranges, [(K(24), K(25))])
        self.assertIn('1 workflow uses 22', label)

    def test_majority_counts_only_workflows_compatible_with_pin(self):
        self.pkg('>=22 <25')
        for i in range(3):
            self.write(f'.github/workflows/old{i}.yml', 'node-version: 20')
        self.write('.github/workflows/ci.yml', 'node-version: 22')
        self.write('.github/workflows/other.yml', 'node-version: 22')
        self.write('.github/workflows/registry.yml', 'node-version: 24')
        ranges, label = node_version.want(self.root, self.root)
        self.assertEqual(ranges, [(K(22), K(23))])
        self.assertIn('1 workflow uses 24', label)
        self.assertNotIn('uses 20', label)

    def test_matrix_entries_are_filtered_before_workflow_vote(self):
        self.pkg('>=22 <25')
        self.write('.github/workflows/ci.yml', 'node-version: [20, 22, 26]')
        self.write('.github/workflows/other.yml', 'node-version: 22')
        self.write('.github/workflows/registry.yml', 'node-version: 24')
        self.assertEqual(node_version.want(self.root, self.root)[0], [(K(22), K(23))])

    def test_workflow_votes_once_per_supported_major(self):
        self.write('.github/workflows/ci.yml', 'node-version: [20, 22, 22, 22]')
        self.write('.github/workflows/other.yml', 'node-version: [20, 22]')
        self.write('.github/workflows/single.yml', 'node-version: 20')
        self.assertEqual(node_version.want(self.root, self.root)[0], [(K(20), K(21))])

    def test_ci_range_boundaries_participate_in_majority(self):
        self.pkg('>=22')
        for majority, minority, expected in [
            ('>=22 <24', '>=22 <25', [(K(23), K(24))]),
            ('22 - 23', '22 - 24', [(K(23), K(24))]),
            ('>=22.13 <24', '>=22.13 <25', [(K(23), K(24))]),
            ('>=22 <23', '>=22 <=23.0.0', [(K(22), K(23))]),
            ('22 || 23', '22 || 24', [(K(22), K(23))]),
        ]:
            with self.subTest(majority=majority, minority=minority):
                self.write('.github/workflows/ci.yml', f'node-version: "{majority}"')
                self.write('.github/workflows/other.yml', f'node-version: "{majority}"')
                self.write('.github/workflows/minority.yml', f'node-version: "{minority}"')
                self.assertEqual(node_version.want(self.root, self.root)[0], expected)

    def test_ci_compares_complete_major_coverage(self):
        for pin in [None, '>=22']:
            for majority, minority, expected in [
                ('22 || 24', '22 - 24', [(K(24), K(25))]),
                ('22 || 24 || 26', '22 - 26', [(K(26), K(27))]),
                ('22 || 23', '22 - 23', [(K(22), K(23)), (K(22), K(24)), (K(23), K(24))]),
            ]:
                with self.subTest(pin=pin, majority=majority, minority=minority):
                    if pin is not None:
                        self.pkg(pin)
                    else:
                        (self.root / 'package.json').unlink(missing_ok=True)
                    self.write('.github/workflows/ci.yml', f'node-version: "{majority}"')
                    self.write('.github/workflows/other.yml', f'node-version: "{majority}"')
                    self.write('.github/workflows/minority.yml', f'node-version: "{minority}"')
                    self.assertEqual(node_version.want(self.root, self.root)[0], expected)

    def test_open_engines_shell_selects_ci_major_over_newest_installed(self):
        self.pkg('>=22')
        self.write('.github/workflows/ci.yml', 'node-version: 22')
        with tempfile.TemporaryDirectory() as home:
            fake_nvm(home, ('v22.23.5', 'v24.22.1'))
            wanted = node_version.want(self.root, self.root)
            result = subprocess.run(['bash', '-c', node_version.block(wanted) +
                                     '\nnode --version; command -v node; printf "%s\\n" "$PATH"'],
                                    env={'HOME': home, 'PATH': '/usr/bin:/bin'},
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.splitlines()[0], 'v22.23.5')
            executable = Path(result.stdout.splitlines()[1])
            self.assertEqual(executable.resolve(), (Path(home) / '.nvm/versions/node/v22.23.5/bin/node').resolve())
            self.assertEqual(result.stdout.splitlines()[2].split(':')[0], str(executable.parent))
            self.assertIn('offbox: node v22.23.5 (package.json engines >=22, narrowed by', result.stderr)

    def test_conflicting_workflows_tie_prefers_highest_major(self):
        self.write('.github/workflows/old.yml', 'node-version: 20')
        self.write('.github/workflows/ci.yaml', "node-version: '22.x'")
        ranges, label = node_version.want(self.root, self.root)
        self.assertEqual(ranges, [(K(22), K(23))])
        self.assertIn('.github/workflows/ci.yaml node-version 22.x', label)
        self.assertIn('1 workflow uses 20', label)

    def test_ci_unreadable_workflow_does_not_hide_other_signals(self):
        self.write('.github/workflows/ci.yml', 'node-version: 22')
        (self.root / '.github/workflows/bad.yaml').write_bytes(b'\xff')
        self.assertEqual(node_version.want(self.root, self.root)[0], [(K(22), K(23))])


class NoPinTests(unittest.TestCase):
    def run_no_pin(self, home, before=''):
        bindir = Path(home) / 'box/bin'
        bindir.mkdir(parents=True)
        node = bindir / 'node'
        node.write_text('#!/bin/sh\necho v24.22.1\n')
        node.chmod(0o755)
        path = f'{bindir}:/usr/bin:/bin'
        script = before + node_version.block(None) + '\nprintf "%s\\n" "$PATH"; node --version; compgen -A variable | /usr/bin/grep ^__offbox_ || :'
        return subprocess.run(['bash', '-c', script], env={'HOME': home, 'PATH': path},
                              capture_output=True, text=True, timeout=15), path

    def test_default_alias_or_newest_nvm(self):
        for alias, expected, reason in [('22', 'v22.13.0', 'nvm default'),
                                         ('v22.13.0', 'v22.13.0', 'nvm default'),
                                         ('22.x', 'v22.13.0', 'nvm default'),
                                         (None, 'v24.1.0', 'newest nvm'),
                                         ('18', 'v24.1.0', 'newest nvm')]:
            with self.subTest(alias=alias), tempfile.TemporaryDirectory() as home:
                fake_nvm(home, ('v22.13.0', 'v24.1.0', 'v24.1.0-rc'))
                if alias:
                    path = Path(home) / '.nvm/alias/default'
                    path.parent.mkdir(parents=True)
                    path.write_text(alias + '\n')
                result, original = self.run_no_pin(home, before='hash node 2>/dev/null || :\n')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.splitlines(), [f'{home}/.nvm/versions/node/{expected}/bin:{original}', expected])
                self.assertIn(f'offbox: node {expected} (no pin; {reason})', result.stderr)

    def test_alias_chain_and_cycle(self):
        for target, expected in [('lts/jod', 'v22.13.0'), ('default', 'v24.1.0')]:
            with self.subTest(target=target), tempfile.TemporaryDirectory() as home:
                fake_nvm(home, ('v22.13.0', 'v24.1.0'))
                alias = Path(home) / '.nvm/alias'
                (alias / 'lts').mkdir(parents=True)
                (alias / 'default').write_text(target + '\n')
                (alias / 'lts/jod').write_text('v22.13.0\n')
                result, _ = self.run_no_pin(home)
                self.assertEqual(result.stdout.splitlines()[-1], expected)

    def test_system_default_removes_inherited_nvm_paths(self):
        for inherited in [False, True]:
            with self.subTest(inherited=inherited), tempfile.TemporaryDirectory() as home:
                fake_nvm(home, ('v22.13.0', 'v24.1.0'))
                alias = Path(home) / '.nvm/alias/default'
                alias.parent.mkdir(parents=True)
                alias.write_text('system\n')
                before = f'export PATH="{home}/.nvm/versions/node/v22.13.0/bin:$PATH"\n' if inherited else ''
                result, original = self.run_no_pin(home, before=before)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.splitlines(), [original, 'v24.22.1'])
                self.assertIn(f'(no pin; nvm default system {home}/box/bin/node)', result.stderr)

    def test_box_default_keeps_path_and_names_executable(self):
        with tempfile.TemporaryDirectory() as home:
            result, original = self.run_no_pin(home)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.splitlines(), [original, 'v24.22.1'])
            self.assertIn(f'offbox: node v24.22.1 (no pin; box default {home}/box/bin/node)', result.stderr)


FAKE = '#!/bin/sh\necho "{v}"\n'


def fake_nvm(home, versions):
    for v in versions:
        bin_dir = Path(home) / '.nvm/versions/node' / v / 'bin'
        bin_dir.mkdir(parents=True)
        node = bin_dir / 'node'
        node.write_text(FAKE.format(v=v))
        node.chmod(0o755)


class BlockRunTests(unittest.TestCase):
    """Run remote_script with the real bash and a fake nvm tree."""

    def run_block(self, engines, cmd_argv=None, steps=None, nvm=True, versions=('v22.23.2', 'v24.18.1', 'v24.21.0', 'v22.1.0-rc')):
        with tempfile.TemporaryDirectory() as home:
            repo = Path(home) / 'w/repo'
            repo.mkdir(parents=True)
            (repo / 'package.json').write_text(json.dumps({'engines': {'node': engines}}))
            if nvm:
                fake_nvm(home, versions)
            w = node_version.want(repo, repo)
            blk = node_version.block(w)
            with patch.object(runs, 'GO_REPAIR', ':'), patch.object(runs, 'DOCKER_REPAIR', ':'), \
                    patch.multiple(runs, LDCACHE_REPAIR=':', SQLITE_SETUP=':'), patch.object(runs.userns, 'setup', return_value=':'):
                script = runs.remote_script('w/repo', '.', cmd_argv or ['node --version'], None, 'run-test',
                                            steps=steps, node=blk)
            bindir = Path(home) / 'bin'
            bindir.mkdir()
            curl = bindir / 'curl'
            curl.write_text('#!/bin/sh\nexit 18\n')
            curl.chmod(0o755)
            env = {'HOME': home, 'PATH': str(bindir) + ':/usr/bin:/bin'}
            return subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True, timeout=60)

    def test_range_picks_newest_fitting(self):
        r = self.run_block('>=22.13 <23')
        self.assertEqual(r.stdout.strip(), 'v22.23.2')
        self.assertIn('offbox: node v22.23.2', r.stderr)

    def test_caret_picks_24(self):
        r = self.run_block('^24.13.1')
        self.assertEqual(r.stdout.strip(), 'v24.21.0')

    def test_open_range_without_ci_picks_newest_and_labels_choice(self):
        r = self.run_block('>=22', versions=('v22.23.5', 'v24.22.1'))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), 'v24.22.1')
        self.assertIn('offbox: node v24.22.1 (package.json engines >=22; '
                      'open range, newest on this box)', r.stderr)

    def test_no_match_stops_before_command(self):
        r = self.run_block('18', cmd_argv=['echo ran'])
        self.assertIn('nothing ran', r.stderr)
        self.assertEqual(r.stdout.strip(), '')
        self.assertEqual(r.returncode, 99)

    def test_exit_code_of_command_untouched(self):
        r = self.run_block('>=22.13 <23', cmd_argv=['exit 3'])
        self.assertEqual(r.returncode, 3)
        r = self.run_block('>=22.13 <23', steps=['node --version', 'exit 4'])
        self.assertEqual(r.returncode, 4)
        self.assertIn('v22.23.2', r.stdout)

    def test_no_nvm_dir_stops_before_command(self):
        r = self.run_block('>=22.13 <23', cmd_argv=['echo ran'], nvm=False)
        self.assertIn('nothing ran', r.stderr)
        self.assertEqual(r.stdout.strip(), '')
        self.assertEqual(r.returncode, 99)

class ProvisionTests(unittest.TestCase):
    def run_provision(self, pin='v20', engine='^20.19.0 || >=22.12.0 <23', installed=(), fail=False, retry='once', system='v24.22.1', checksum_bad=False, require_nvm=False, workflow=None, nvm_hook=''):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); repo = root / 'repo'; repo.mkdir()
            if workflow is None:
                (repo / '.nvmrc').write_text(pin)
                (repo / 'package.json').write_text(json.dumps({'engines': {'node': engine}}))
            else:
                (repo / 'package.json').write_text('{}')
                workflows = repo / '.github/workflows'
                workflows.mkdir(parents=True)
                (workflows / 'terraform-dev.yml').write_text(workflow)
            fake_nvm(tmp, installed)
            bindir = root / 'bin'; bindir.mkdir()
            node = bindir / 'node'; node.write_text(FAKE.format(v=system)); node.chmod(0o755)
            (root / 'index.tab').write_text('version date\nv24.22.1 1\nv22.23.5 1\nv22.23.2 1\nv22.13.9 1\nv22.13.0 1\nv22.12.0 1\nv20.20.2 1\nv20.18.0 1\n')
            body = b'node archive fixture'
            (root / 'archive').write_bytes(body)
            digest = '0' * 64 if checksum_bad else hashlib.sha256(body).hexdigest()
            (root / 'sums').write_text(''.join(f'{digest}  node-{v}-linux-x64.tar.xz\n' for v in ('v20.20.2', 'v22.13.0', 'v22.13.9', 'v22.23.2', 'v22.23.5', 'v24.22.1')))
            (root / 'nvm-fixture.sh').write_text(r'''
nvm_get_download_slug() { echo node-$3-linux-x64; }
nvm_get_artifact_compression() { echo tar.xz; }
nvm() {
  [ "$1" = install ] || return 88
  [ "$2" = -b ] || return 89
  @NVM_HOOK@
  mkdir -p "$NVM_DIR/versions/node/$3/bin"
  [ "$NVM_FAIL" = 1 ] && return 1
  printf '#!/bin/sh\necho %s\n' "$3" > "$NVM_DIR/versions/node/$3/bin/node"
  chmod +x "$NVM_DIR/versions/node/$3/bin/node"
}
'''.replace('@NVM_HOOK@', nvm_hook))
            curl = bindir / 'curl'; curl.write_text(r'''#!/bin/bash
count=$(cat "$HOME/count" 2>/dev/null || echo 0); count=$((count+1)); echo "$count" > "$HOME/count"
case " $* " in *" --connect-timeout 20 --speed-limit 30720 --speed-time 60 --max-time 600 "*) ;; *) exit 88 ;; esac
if [ "$CURL_FAIL" = always ] || { [ "$CURL_FAIL" = once ] && [ "$count" = 1 ]; }; then exit 18; fi
while [ $# -gt 0 ]; do
  case "$1" in https://*) url=$1 ;; -o) shift; out=$1 ;; esac
  shift
done
case "$url" in */nvm.sh) cp "$HOME/nvm-fixture.sh" "$out" ;; */index.tab) cp "$HOME/index.tab" "$out" ;; */SHASUMS256.txt) cp "$HOME/sums" "$out" ;; *.tar.xz) cp "$HOME/archive" "$out" ;; *) exit 88 ;; esac
'''); curl.chmod(0o755)
            script = node_version.block(node_version.want(repo, repo), require_nvm=require_nvm) + '\necho COMMAND_MARKER\nnode --version'
            result = subprocess.run(['bash', '-c', script], env={'HOME': tmp, 'PATH': f'{bindir}:/usr/bin:/bin',
                'NVM_FAIL': str(int(fail)), 'CURL_FAIL': retry, 'OFFBOX_BOX_ID': 'bx_fixture'}, capture_output=True, text=True, timeout=15)
            count = int((root / 'count').read_text()) if (root / 'count').exists() else 0
            if fail:
                self.assertFalse((root / '.nvm/versions/node/v20.20.2').exists())
                self.assertFalse(list((root / '.nvm').glob('.offbox-stage.*')))
            return result, count

    def test_pin_provision_corpus(self):
        for pin, engine, installed, expected in [
            ('v20', '^20.19.0 || >=22.12.0 <23', ('v22.23.2', 'v24.22.1'), 'v20.20.2'),
            ('v20', '^20.19.0 || >=22.12.0 <23', (), 'v20.20.2'),
            ('22.13', '>=22.13 <23', (), 'v22.13.9'),
        ]:
            with self.subTest(pin=pin, installed=installed):
                result, count = self.run_provision(pin, engine, installed)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f'node {expected} (installed:', result.stderr)
                self.assertIn('COMMAND_MARKER', result.stdout)
                self.assertEqual(result.stdout.splitlines()[-1], expected)
                self.assertEqual(count, 5)

    def test_crpko_devops_ci_only_provisions_22_over_box_24(self):
        for pin, expected in [('22', 'v22.23.5'), ('22.23', 'v22.23.5'),
                              ('22.13', 'v22.13.9'), ('22.13.0', 'v22.13.0')]:
            with self.subTest(pin=pin):
                result, count = self.run_provision(workflow='jobs:\n  test:\n    steps:\n'
                    '      - uses: actions/setup-node@v4\n        with:\n'
                    f'          node-version: {pin}\n')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f'offbox: node {expected} (installed: .github/workflows/terraform-dev.yml node-version {pin})', result.stderr)
                self.assertEqual(result.stdout.splitlines(), ['COMMAND_MARKER', expected])
                self.assertEqual(count, 5)

    def test_ci_unpublished_version_stops_before_command(self):
        result, _ = self.run_provision(workflow='node-version: 19')
        self.assertEqual(result.returncode, 99)
        self.assertIn('no published Node satisfies', result.stderr)
        self.assertNotIn('COMMAND_MARKER', result.stdout)

    def test_ci_install_failure_stops_before_command(self):
        result, _ = self.run_provision(workflow='node-version: 22', fail=True)
        self.assertEqual(result.returncode, 99)
        self.assertNotIn('COMMAND_MARKER', result.stdout)

    def test_checksum_mismatch_cannot_reach_nvm_or_command(self):
        result, _ = self.run_provision(checksum_bad=True)
        self.assertEqual(result.returncode, 99)
        self.assertIn('checksum mismatch', result.stderr)
        self.assertNotIn('COMMAND_MARKER', result.stdout)

    def test_recipe_installs_nvm_node_even_if_system_matches(self):
        result, count = self.run_provision(system='v20.20.2', require_nvm=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('(installed:', result.stderr)
        self.assertEqual(count, 5)

    def test_only_system_20_needs_no_network(self):
        result, count = self.run_provision(system='v20.20.2', retry='always')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(count, 0)

    def test_nvm_failure_stops_before_command(self):
        result, _ = self.run_provision(fail=True)
        self.assertEqual(result.returncode, 99)
        self.assertIn('nvm install v20.20.2 failed', result.stderr)
        self.assertNotIn('COMMAND_MARKER', result.stdout)

    def test_download_exhaustion_stops_before_command(self):
        result, count = self.run_provision(retry='always')
        self.assertEqual(result.returncode, 99)
        self.assertEqual(count, 3)
        self.assertNotIn('COMMAND_MARKER', result.stdout)

    def test_impossible_or_disjoint_pin_stops_before_command(self):
        for pin, engine in [('v19.999', '>=18'), ('v20', '>=22.13 <23'), ('v20', '>=22 <20'), ('v20', '^22 <20'), ('v20', '>=22.13 <22.12')]:
            result, _ = self.run_provision(pin, engine)
            self.assertEqual(result.returncode, 99)
            self.assertNotIn('COMMAND_MARKER', result.stdout)
            self.assertIn('no published Node satisfies', result.stderr)


class RecipeTests(unittest.TestCase):
    def test_crpko_node_uses_the_run_provisioner_for_all_required_versions(self):
        from offbox_lib import bases
        templates = Path(__file__).resolve().parents[2] / 'templates'
        with patch.object(bases, 'TEMPLATES_DIR', templates):
            script, _ = bases.recipe('crpko-node')
        for label in ('crpko-node recipe 20', 'crpko-node recipe >=22.13 <23', 'crpko-node recipe 24'):
            self.assertIn(label, script)
        self.assertLess(script.index('nvm install -b'), script.index('# ---- recipe ----'))
        self.assertIn('__offbox_archive_ok()', script)
        self.assertIn('mv "$NVM_DIR/versions/node/', script)


if __name__ == '__main__':
    unittest.main()
