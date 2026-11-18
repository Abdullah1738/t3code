"""Node version pick: parser cases, repo lookup, and the real bash block (no boat calls)."""
import contextlib
import io
import json
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, base_catalog, cli, common, home, lease, misc, node_version, pool, runs, resources  # noqa: E402
from test_capacity import Isolated
from test_bg_empty_logs import _BackgroundOutputFixture

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

    def selected_label(self, wanted):
        with tempfile.TemporaryDirectory() as home:
            fake_nvm(home, ('v20.18.0', 'v22.13.0', 'v22.23.5', 'v24.22.1'))
            result = subprocess.run(['bash', '-c', node_version.block(wanted)],
                                    env={'HOME': home, 'PATH': '/usr/bin:/bin'},
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            return next(line for line in result.stderr.splitlines() if line.startswith('offbox: node '))

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
        self.assertNotIn('open range', self.selected_label((ranges, label)))

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
                    self.assertNotIn('open range', self.selected_label(node_version.want(self.root, self.root)))

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
                              self.selected_label(wanted))

    def test_ci_matrix_remaining_open_is_labelled(self):
        self.pkg('>=20')
        self.write('.github/workflows/ci.yml', 'node-version: [20, 22]')
        wanted = node_version.want(self.root, self.root)
        self.assertEqual(wanted[0], [(K(20), K(21)), (K(22), K(23))])
        self.assertIn('narrowed by', wanted[1])
        self.assertIn('open range, newest on this box', self.selected_label(wanted))

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

    def run_block(self, engines, cmd_argv=None, steps=None, nvm=True, override=None, pin=None, versions=('v22.23.2', 'v24.18.1', 'v24.21.0', 'v22.1.0-rc')):
        with tempfile.TemporaryDirectory() as home:
            repo = Path(home) / 'w/repo'
            repo.mkdir(parents=True)
            (repo / 'package.json').write_text(json.dumps({'engines': {'node': engines}}))
            if nvm:
                fake_nvm(home, versions)
            if pin:
                (repo / '.nvmrc').write_text(pin)
            w = node_version.want(repo, repo, override=override)
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
            result = subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True, timeout=60)
            receipt = Path(home) / '.offbox/exit/run-test.node.json'
            result.node = json.loads(receipt.read_text()) if receipt.exists() else None
            return result

    def test_caret_records_candidates_and_choice(self):
        result = self.run_block('^24.13.1', versions=('v24.22.1', 'v24.22.3'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'v24.22.3')
        self.assertIn('newest of 2 fitting on this box (v24.22.3, v24.22.1)', result.stderr)
        self.assertEqual(result.node['version'], 'v24.22.3')
        self.assertTrue(result.node['path'].endswith('/.nvm/versions/node/v24.22.3/bin/node'))
        self.assertEqual(result.node['pin'], 'package.json engines ^24.13.1')
        self.assertEqual(result.node['choice'], 'newest nvm')
        self.assertEqual(result.node['candidates'], ['v24.22.3', 'v24.22.1'])

    def test_exact_override_replaces_repo_pin(self):
        for override in ('24.22.1', 'v24.22.1'):
            with self.subTest(override=override):
                result = self.run_block('^24.13.1', override=override, versions=('v24.22.1', 'v24.22.3'))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), 'v24.22.1')
                self.assertIn(f'OFFBOX_NODE={override} (override)', result.stderr)
                self.assertNotIn('newest of', result.stderr)
                self.assertEqual(result.node['candidates'], ['v24.22.1'])

    def test_exact_pin_has_no_newest_suffix(self):
        result = self.run_block('>=22 <23', pin='22.13.0', versions=('v22.13.0', 'v22.13.1'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('newest of', result.stderr)
        self.assertEqual(result.node['version'], 'v22.13.0')

    def test_override_input_forms_fail_before_registration(self):
        for value in ('24', '24.22', '^24.22.1', '>=24', '24.22.1-rc.1', '24.22.1+build',
                      '', ' 24.22.1', '24.22.1\n', '024.22.1', '24.1000.0', '$(echo unsafe)'):
            with self.subTest(value=value), patch.object(runs, 'db') as db, \
                    patch.dict(os.environ, {'OFFBOX_NODE': value}):
                with self.assertRaises(runs.OffboxError) as raised:
                    runs.Runner(SimpleNamespace(env=[]), {})
                self.assertEqual(raised.exception.code, 99)
                self.assertIn('OFFBOX_NODE', str(raised.exception))
                db.assert_not_called()
                self.assertIsNone(node_version.want(Path('/missing'), Path('/missing'), override=value))
                for explicit in (False, True):
                    args = ['run', '--bg'] + (['--env', f'OFFBOX_NODE={value}'] if explicit else []) + ['--', 'true']
                    a = cli.build_parser().parse_args(args)
                    with patch.object(home, 'before_run') as preflight, patch.object(home, 'run_identity') as identity:
                        with self.assertRaises(runs.OffboxError) as raised:
                            cli.cmd_run(a, {})
                        self.assertEqual(raised.exception.code, 99)
                        preflight.assert_not_called()
                        identity.assert_not_called()
                    with patch.object(home, 'person_gate') as person_gate, \
                            patch('offbox_lib.identity.whoami') as whoami, \
                            patch.object(api, 'probe_backend') as probe, contextlib.redirect_stderr(io.StringIO()) as errors:
                        self.assertEqual(cli.main(args), 99)
                        self.assertIn('OFFBOX_NODE', errors.getvalue())
                        self.assertEqual(len(errors.getvalue().splitlines()), 1)
                        person_gate.assert_not_called()
                        whoami.assert_not_called()
                        probe.assert_not_called()
                    for base in (['--base', 'warm'], ['--base=warm'], ['--bas=warm'], ['--fresh']):
                        routed = args[:1] + base + args[1:]
                        with patch.object(base_catalog, 'rows') as rows, patch.object(common, 'home_config') as config:
                            with self.assertRaises(runs.OffboxError) as raised:
                                common.entry_backend(routed)
                            self.assertEqual(raised.exception.code, 99)
                            rows.assert_not_called()
                            config.assert_not_called()

    def test_override_env_and_explicit_env_precedence(self):
        with patch.dict(os.environ, {'OFFBOX_NODE': '24.22.3'}):
            self.assertEqual(runs.build_env([])[0]['OFFBOX_NODE'], '24.22.3')
            self.assertEqual(runs.build_env(['OFFBOX_NODE=24.22.1'])[0]['OFFBOX_NODE'], '24.22.1')

    def test_record_collects_facts_and_client_label_once(self):
        result = self.run_block('^24.13.1', versions=('v24.22.1', 'v24.22.3'))
        with tempfile.TemporaryDirectory() as directory, patch.object(runs, 'LOGS_DIR', Path(directory)):
            path = Path(directory) / 'run-test.log'
            path.write_text(result.stderr)
            for _ in range(2):
                node_version.record({'run_id': 'run-test'}, path)
            self.assertEqual(json.loads(path.with_suffix('.state.json').read_text())['node'], result.node)
            label = path.with_suffix('.client.log').read_text()
            self.assertEqual(label.count('offbox: node'), 1)
            self.assertIn('newest of 2 fitting', label)

    def test_completed_run_metadata_collects_on_later_wait(self):
        result = self.run_block('^24.13.1', versions=('v24.22.1', 'v24.22.3'))
        with tempfile.TemporaryDirectory() as directory, patch.object(runs, 'LOGS_DIR', Path(directory)), \
                patch.object(resources, 'PREFIX', 'unused-resources: '):
            path = Path(directory) / 'run-test.log'
            path.write_text(result.stderr)
            runs.save_run_state('run-test', node=None)
            node_version.capture_stderr(path, result.stderr.encode(), 0)
            # A waiter can see a terminal row saved by an older/different client.
            resources.finalize(dict(run_id='run-test', mode='bg', status='done', exit_code=0))
            self.assertEqual(json.loads(path.with_suffix('.state.json').read_text())['node'], result.node)
            self.assertIn('newest of 2 fitting', path.with_suffix('.client.log').read_text())

    def test_missing_or_malformed_facts_are_null(self):
        for body in ('', 'offbox-node: {}\n', 'offbox-node: null\n', 'offbox-node: broken{\n'):
            with self.subTest(body=body), tempfile.TemporaryDirectory() as directory, \
                    patch.object(runs, 'LOGS_DIR', Path(directory)):
                path = Path(directory) / 'run-test.log'
                path.write_text(body)
                runs.save_run_state('run-test', node=None)
                node_version.record({'run_id': 'run-test'}, path)
                self.assertIsNone(json.loads(path.with_suffix('.state.json').read_text())['node'])

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
                      'open range, newest on this box; newest of 2 fitting on this box (v24.22.1, v22.23.5))', r.stderr)

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
    def run_provision(self, pin='v20', engine='^20.19.0 || >=22.12.0 <23', installed=(), fail=False, retry='once', system='v24.22.1', checksum_bad=False, require_nvm=False, workflow=None, nvm_hook='', override=None):
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
            (root / 'index.tab').write_text('version date\nv24.99.0 1\nv24.22.1 1\nv22.23.5 1\nv22.23.2 1\nv22.13.9 1\nv22.13.0 1\nv22.12.0 1\nv20.20.2 1\nv20.18.0 1\n')
            body = b'node archive fixture'
            (root / 'archive').write_bytes(body)
            digest = '0' * 64 if checksum_bad else hashlib.sha256(body).hexdigest()
            (root / 'sums').write_text(''.join(f'{digest}  node-{v}-linux-x64.tar.xz\n' for v in ('v24.99.0', 'v20.20.2', 'v22.13.0', 'v22.13.9', 'v22.23.2', 'v22.23.5', 'v24.22.1')))
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
            script = node_version.block(node_version.want(repo, repo, override=override), require_nvm=require_nvm) + '\necho COMMAND_MARKER\nnode --version'
            result = subprocess.run(['bash', '-c', script], env={'HOME': tmp, 'PATH': f'{bindir}:/usr/bin:/bin',
                'NVM_FAIL': str(int(fail)), 'CURL_FAIL': retry, 'OFFBOX_BOX_ID': 'bx_fixture'}, capture_output=True, text=True, timeout=15)
            count = int((root / 'count').read_text()) if (root / 'count').exists() else 0
            if fail:
                self.assertFalse((root / '.nvm/versions/node/v20.20.2').exists())
                self.assertFalse(list((root / '.nvm').glob('.offbox-stage.*')))
            return result, count

    def test_missing_override_uses_verified_installer(self):
        result, count = self.run_provision(override='24.99.0', retry='never')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('node v24.99.0 (installed: OFFBOX_NODE=24.99.0 (override))', result.stderr)
        self.assertIn('COMMAND_MARKER', result.stdout)
        self.assertGreater(count, 0)
        result, _ = self.run_provision(override='24.99.0', checksum_bad=True)
        self.assertEqual(result.returncode, 99)
        self.assertNotIn('COMMAND_MARKER', result.stdout)
        self.assertIn('checksum mismatch', result.stderr)

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


def node_receipt(version, run_id='run-test'):
    facts = dict(version=version, path=f'/home/user/.nvm/versions/node/{version}/bin/node',
                 pin='package.json engines ^24.13.1', choice='newest nvm', candidates=[version])
    return facts, 'offbox-node: ' + json.dumps(dict(facts, label=facts['pin'], run_id=run_id)) + '\n'


class NodeCollectionTests(Isolated):
    def test_executable_rejects_override_before_backend_routing(self):
        scripts = Path(__file__).resolve().parents[1]
        program = '''import runpy, sys
sys.path.insert(0, sys.argv.pop(1))
from offbox_lib import common
def forbidden(*args, **kwargs):
    raise AssertionError('backend lookup happened before Node validation')
common.home_config = forbidden
sys.argv[0] = sys.path[0] + '/offbox.py'
runpy.run_path(sys.argv[0], run_name='__main__')
'''
        forms = ([], ['--env', 'OFFBOX_NODE=24'], ['--env=OFFBOX_NODE=24'], ['--en=OFFBOX_NODE=24'],
                 ['--env=OFFBOX_NODE=24.22.1', '--env=OFFBOX_NODE=24'])
        for extra in forms:
            with self.subTest(extra=extra):
                result = subprocess.run([sys.executable, '-I', '-c', program, str(scripts),
                                         'run', '--base=warm', *extra, '--', 'true'],
                                        env=dict(os.environ, OFFBOX_NODE='24'), capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 99, result.stderr)
                self.assertIn('OFFBOX_NODE must be an exact', result.stderr)
                self.assertEqual(len(result.stderr.splitlines()), 1)

    def test_collector_skips_unchanged_log_and_handles_rewrites(self):
        first, receipt = node_receipt('v24.22.1')
        path = runs.LOGS_DIR / 'run-test.log'
        path.write_text(receipt + 'offbox-command-started: run-test\n' + 'output\n' * 10000)
        real_open, reads = Path.open, []
        def tracked_open(p, *args, **kwargs):
            stream = real_open(p, *args, **kwargs)
            if p == path and args == ('rb',):
                readline = stream.readline
                def tracked_readline(*args):
                    reads.append(1)
                    return readline(*args)
                stream.readline = tracked_readline
            return stream
        with patch.object(Path, 'open', tracked_open):
            node_version.record(dict(run_id='run-test'), path)
            self.assertEqual(len(reads), 10002)
            node_version.record(dict(run_id='run-test'), path)
            self.assertEqual(len(reads), 10002)
            final, receipt = node_receipt('v24.22.3')
            path.write_text(receipt + 'offbox-command-started: run-test\n')
            node_version.record(dict(run_id='run-test'), path)
            self.assertEqual(json.loads(path.with_suffix('.state.json').read_text())['node'], final)
            # Rewrites/truncation and a trailing partial line must not reuse the old attempt.
            path.write_text(receipt[:-2])
            node_version.record(dict(run_id='run-test'), path)
            self.assertIsNone(json.loads(path.with_suffix('.state.json').read_text())['node'])
            with path.open('a') as stream:
                stream.write(receipt[-2:])
            node_version.record(dict(run_id='run-test'), path)
            self.assertEqual(json.loads(path.with_suffix('.state.json').read_text())['node'], final)
        for mutation in ('larger in-place rewrite', 'same-size rewrite', 'truncate', 'replace inode'):
            with self.subTest(mutation=mutation):
                _, original = node_receipt('v24.22.1')
                prefix = 'offbox-command-started: run-test\n'
                suffix = 'identical output suffix\n' * 1000
                path.write_text(original + prefix + suffix)
                node_version.record(dict(run_id='run-test'), path)
                body = receipt + prefix + ('' if mutation == 'truncate' else suffix)
                if mutation == 'larger in-place rewrite':
                    body += 'larger\n'
                if mutation == 'replace inode':
                    replacement = path.with_suffix('.replacement')
                    replacement.write_text(body)
                    replacement.replace(path)
                else:
                    path.write_text(body)
                node_version.record(dict(run_id='run-test'), path)
                self.assertEqual(json.loads(path.with_suffix('.state.json').read_text())['node'], final)

    def test_background_admission_and_active_logs_collect_node(self):
        self.box('bx', member=True)
        a = cli.build_parser().parse_args(['run', '--bg', '--', 'echo hello'])
        runner = runs.Runner(a, self.me)
        first, receipt = node_receipt('v24.22.1', runner.run_id)
        marker = f'{runs.COMMAND_STARTED_MARKER} {runner.run_id}\n'
        initial = 'offbox evidence wrapper pid=1\n' + receipt + marker
        with patch.object(pool, 'acquire', return_value=dict(box_id='bx', remote_dir='w/r', size='large')), \
                patch.object(runs.Runner, '_prepare_box', return_value=None), patch.object(runs, '_ttl_keeper'), \
                patch.object(lease, 'touch'), patch.object(lease, 'ensure_ttl'), patch.object(lease, 'idle_ttl'), \
                patch.object(api, 'get', return_value=dict(state='running')), \
                patch.object(api, 'cmd_start', return_value=dict(processId=7, commandId='cmd_a')), \
                patch.object(api, 'cmd_attach', return_value=iter([dict(type='stderr', data=initial)])), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(runs._run_remote(a, runner), 0)
            state = runner.log_path.with_suffix('.state.json')
            self.assertEqual(json.loads(state.read_text())['node'], first)
            self.assertIn('offbox: node v24.22.1', runner.log_path.with_suffix('.client.log').read_text())
            self.assertNotIn('box pressure', runner.log_path.read_text())
            final, receipt = node_receipt('v24.22.3', runner.run_id)
            retained = (initial + 'offbox-server: the server restarted while this run was going (attempt 1 is lost); '
                        'it is queued again as attempt 2\noffbox evidence wrapper pid=2\n' + receipt + marker)
            def history(box, cmd, which, offset, **kw):
                data = retained if which == 'stderr' else ''
                return dict(data=data[offset:], nextOffset=len(data), size=len(data), done=False,
                            attempt=2, nodeSetup=dict(stderrOffset=len(initial.encode())))
            with patch.object(api, 'history_logs', side_effect=history):
                self.assertEqual(misc.logs(runner.run_id, False), 0)
            self.assertEqual(json.loads(state.read_text())['node'], final)
            self.assertIn('offbox: node v24.22.3', runner.log_path.with_suffix('.client.log').read_text())
            self.assertNotIn('box pressure', runner.log_path.read_text())

    def test_latest_attempt_replaces_receipt_and_ignores_user_output(self):
        _, first = node_receipt('v24.22.1')
        final, receipt = node_receipt('v24.22.3')
        marker = 'offbox-command-started: run-test\n'
        retry = ('offbox-server: the server restarted while this run was going (attempt 1 is lost); '
                 'it is queued again as attempt 2\n')
        for boundary in (retry, retry + 'offbox evidence wrapper pid=2\n'):
            for tail, expected in ((receipt + marker + first, final), ('', None),
                                   ('offbox-node: {}\n' + marker, None)):
                with self.subTest(boundary=boundary, tail=tail):
                    path = runs.LOGS_DIR / 'run-test.log'
                    path.write_text('offbox evidence wrapper pid=1\n' + first + marker)
                    node_version.record(dict(run_id='run-test'), path)
                    with path.open('a') as stream:
                        stream.write(boundary + tail)
                    node_version.observe_attempt(path, dict(attempt=2, nodeSetup=dict(
                        stderrOffset=len(('offbox evidence wrapper pid=1\n' + first + marker).encode()))))
                    node_version.capture_stderr(path, path.read_bytes(), 0)
                    for _ in range(2):
                        resources.finalize(dict(run_id='run-test', mode='bg'), node_only=True)
                    self.assertEqual(json.loads(path.with_suffix('.state.json').read_text())['node'], expected)

    def test_attach_uses_attempt_envelope_not_workload_retry_lines(self):
        _, receipt = node_receipt('v24.22.1')
        final, latest = node_receipt('v24.22.3')
        initial = receipt + 'offbox-command-started: run-test\n'
        current = latest + 'offbox-command-started: run-test\n'
        path = runs.LOGS_DIR / 'run-test.log'
        frames = [dict(type='hello', attempt=1), dict(type='stderr', data=initial),
                  dict(type='attempt', attempt=2),
                  dict(type='stderr', data=current, attempt=2,
                       nodeSetup=dict(stderrOffset=len(initial.encode()))), dict(type='exit', exitCode=0)]
        with patch.object(api, 'BACKEND', 'server'), patch.object(api, 'cmd_attach', return_value=iter(frames)), \
                patch.object(runs, '_ttl_keeper'):
            self.assertEqual(runs.follow('bx', 7, path, echo=False, run_id='run-test'), 0)
        resources.finalize(dict(run_id='run-test', mode='bg'), node_only=True)
        self.assertEqual(json.loads(path.with_suffix('.state.json').read_text())['node'], final)

    def test_receipt_must_name_this_run_before_command_start(self):
        path = runs.LOGS_DIR / 'run-test.log'
        runs.save_run_state('run-test', node=None)
        for run_id in ('another-run', None, 'run-test'):
            with self.subTest(run_id=run_id):
                facts, receipt = node_receipt('v24.22.3', run_id)
                path.write_text(receipt + 'offbox-command-started: run-test\n')
                node_version.record(dict(run_id='run-test'), path)
                self.assertEqual(json.loads(path.with_suffix('.state.json').read_text())['node'],
                                 facts if run_id == 'run-test' else None)

    def test_status_retains_retry_provenance_for_recovered_stderr(self):
        _, first = node_receipt('v24.22.1')
        facts, latest = node_receipt('v24.22.3')
        prefix = first + 'offbox-command-started: run-test\n'
        path = runs.LOGS_DIR / 'run-test.log'
        path.write_text(prefix + latest + 'offbox-command-started: run-test\n')
        metadata = dict(status='exited', running=False, exitCode=0, attempt=2,
                        nodeSetup=dict(stderrOffset=len(prefix.encode())))
        with patch.object(api, 'cmd_status', return_value=metadata):
            self.assertEqual(runs._ended('bx', 7, None, 'run-test'), metadata)
        node_version.record(dict(run_id='run-test'), path)
        self.assertEqual(common.read_json(path.with_suffix('.state.json'), {})['node'], facts)

    def test_old_server_retried_setup_clears_previous_node_without_history(self):
        facts, receipt = node_receipt('v24.22.1')
        path = runs.LOGS_DIR / 'run-test.log'
        path.write_text(receipt + 'offbox-command-started: run-test\n')
        node_version.capture_stderr(path, path.read_bytes(), 0)
        row = dict(run_id='run-test', mode='bg')
        resources.finalize(row, node_only=True)
        self.assertEqual(common.read_json(path.with_suffix('.state.json'), {})['node'], facts)
        runs.remember_interruption('run-test', dict(attempt=2))
        for _ in range(2):
            resources.finalize(row, node_only=True)
        self.assertIsNone(common.read_json(path.with_suffix('.state.json'), {})['node'])

    def test_remote_command_identity_scopes_attempt_order(self):
        path = runs.LOGS_DIR / 'run-test.log'
        old = dict(commandId='cmd_old', attempt=2, nodeSetup=dict(stderrOffset=375))
        for reported_id in ('cmd_new', None):
            with self.subTest(reported_id=reported_id):
                runs.save_run_state('run-test', command_id='cmd_old')
                node_version.observe_attempt(path, old)
                runs.save_run_state('run-test', command_id='cmd_new')
                node_version.observe_attempt(path, old)
                self.assertEqual(common.read_json(path.with_suffix('.node-attempt.json'), {})['command_id'], 'cmd_old')
                current = dict(attempt=1, nodeSetup=dict(stderrOffset=0))
                if reported_id:
                    current['commandId'] = reported_id
                node_version.observe_attempt(path, current)
                expected = dict(command_id='cmd_new', attempt=1, stderrOffset=0)
                self.assertEqual(common.read_json(path.with_suffix('.node-attempt.json'), {}), expected)
                node_version.observe_attempt(path, old)
                self.assertEqual(common.read_json(path.with_suffix('.node-attempt.json'), {}), expected)

    def test_nested_wrapper_and_receipt_are_user_output(self):
        facts, receipt = node_receipt('v24.22.1')
        _, nested = node_receipt('v24.99.0')
        path = runs.LOGS_DIR / 'run-test.log'
        path.write_text('offbox evidence wrapper pid=1\n' + receipt + 'offbox-command-started: run-test\n' +
                        'offbox evidence wrapper pid=2\n' + nested + 'offbox-command-started: another-run\n')
        for _ in range(2):
            node_version.record(dict(run_id='run-test'), path)
        self.assertEqual(json.loads(path.with_suffix('.state.json').read_text())['node'], facts)

    def test_long_user_line_keeps_later_retry_visible(self):
        _, first = node_receipt('v24.22.1')
        final, receipt = node_receipt('v24.22.3')
        path = runs.LOGS_DIR / 'run-test.log'
        path.write_text(first + 'offbox-command-started: run-test\n' + 'x' * 131072 + '\n' +
                        'offbox-server: the server restarted while this run was going (attempt 1 is lost); '
                        'it is queued again as attempt 2\n' + receipt + 'offbox-command-started: run-test\n')
        node_version.observe_attempt(path, dict(attempt=2, nodeSetup=dict(stderrOffset=
            len((first + 'offbox-command-started: run-test\n' + 'x' * 131072 + '\n').encode()))))
        source = Path(str(path) + '.remote')
        source.write_bytes(path.read_bytes())
        node_version.record(dict(run_id='run-test'), path, source=source)
        self.assertEqual(json.loads(path.with_suffix('.state.json').read_text())['node'], final)


class NodeHistoryTests(unittest.TestCase):
    def test_metadata_replay_does_not_repeat_display_or_recovery_hash_bytes(self):
        from test_log_catchup import LogCatchupTests
        _, old = node_receipt('v24.22.1', 'run-x')
        facts, current = node_receipt('v24.22.3', 'run-x')
        first = (old + 'offbox-command-started: run-x\n').encode()
        raw = first + (current + 'offbox-command-started: run-x\n').encode()
        final = dict(attempt=2, nodeSetup=dict(stderrOffset=len(first)))
        for live in (False, True):
            for initial in (dict(attempt=1), dict(attempt=2)):
                for recovered in (False, True):
                    if live and recovered:
                        continue  # Recovered-copy verification runs to terminal history, not a live snapshot.
                    with self.subTest(live=live, initial=initial, recovered=recovered):
                        case = LogCatchupTests('test_logs_completes_and_repeated_logs_do_not_duplicate')
                        case.setUp()
                        try:
                            case.prefix(b'')
                            case.state('running' if live else 'done', None if live else 0)
                            if recovered:
                                Path(str(case.path) + '.remote').write_bytes(raw)
                                common.atomic_write_json(Path(str(case.path) + '.remote.json'), dict(
                                    merged=True, lengths=[0, len(raw)], hashes=[hashlib.sha256(b'').hexdigest(),
                                                                             hashlib.sha256(raw).hexdigest()]))
                            calls = []
                            def changing_history(box, command, stream, offset, **kw):
                                if stream == 'stdout':
                                    return dict(data='', nextOffset=0, size=0, done=True, **initial)
                                calls.append(offset)
                                before = len(calls) == 1
                                source = first if before else raw
                                data = source[offset:offset + 37]
                                return dict(data=data.decode(), nextOffset=offset + len(data), size=len(source),
                                            done=offset + len(data) == len(source), **(initial if before else final))
                            case.history.side_effect = changing_history
                            with patch.object(api, 'BACKEND', 'server'):
                                self.assertIn(misc._catch_up_log(case.row(), live=live), ('complete', 'caught_up'))
                                case.state('done', 0)
                                case.streams(b'', raw, page=37)
                                ordinary = case.history.side_effect
                                case.history.side_effect = lambda *a, **kw: dict(ordinary(*a, **kw), **final)
                                for _ in range(2):
                                    self.assertIn(misc._catch_up_log(case.row()), ('complete', 'caught_up'))
                            self.assertEqual(case.path.read_bytes(), raw)
                            self.assertEqual(common.checkpoint(case.path),
                                             dict(stdoutOffset=0, stderrOffset=len(raw), logBytes=len(raw)))
                            self.assertEqual(common.read_json(case.path.with_suffix('.state.json'), {})['node'], facts)
                        finally:
                            case.doCleanups()

    def test_replacement_remote_command_resets_node_provenance(self):
        from test_log_catchup import LogCatchupTests
        case = LogCatchupTests('test_logs_completes_and_repeated_logs_do_not_duplicate')
        case.setUp()
        try:
            old_facts, old = node_receipt('v24.22.1', 'run-x')
            facts, current = node_receipt('v24.22.3', 'run-x')
            prefix = b'previous invocation\n' * 15
            runs.save_run_state('run-x', command_id='cmd_old')
            metadata = dict(commandId='cmd_old', attempt=2, nodeSetup=dict(stderrOffset=len(prefix)))
            runs.remember_interruption('run-x', metadata)
            node_version.capture_stderr(case.path, prefix + old.encode(), 0)
            resources.finalize(case.row(), node_only=True)
            self.assertEqual(common.read_json(case.path.with_suffix('.state.json'), {})['node'], old_facts)
            case.con.execute("UPDATE runs SET status='running',client_pid=?,command_id='cmd_old' WHERE run_id='run-x'",
                             (os.getpid(),))
            case.con.commit()
            runs.reset_disk_retry(SimpleNamespace(started=False, run_id='run-x'))
            self.assertFalse(case.path.with_suffix('.node-attempt.json').exists())
            self.assertIsNone(common.read_json(case.path.with_suffix('.state.json'), {})['node'])
            runs.remember_interruption('run-x', metadata)  # A late reply during replacement cannot restore it.
            self.assertFalse(case.path.with_suffix('.node-attempt.json').exists())
            case.con.execute("UPDATE runs SET status='done',exit_code=0,box_id='bx_a',process_id=7,"
                             "command_id='cmd_a' WHERE run_id='run-x'")
            case.con.commit()
            runs.save_run_state('run-x', status='done', box_id='bx_a', process_id=7, command_id='cmd_a', exit_code=0)
            case.prefix(b'')
            raw = (current + 'offbox-command-started: run-x\n').encode()
            case.streams(b'', raw, page=37)
            ordinary = case.history.side_effect
            case.history.side_effect = lambda *a, **kw: dict(ordinary(*a, **kw), commandId='cmd_a',
                                                           attempt=1, nodeSetup=dict(stderrOffset=0))
            with patch.object(api, 'BACKEND', 'server'):
                self.assertEqual(case.invoke(wait=True)[0], 0)
            context = common.read_json(case.path.with_suffix('.node-attempt.json'), {})
            runs.remember_interruption('run-x', metadata)
            self.assertEqual(common.read_json(case.path.with_suffix('.node-attempt.json'), {}), context)
            self.assertEqual(common.read_json(case.path.with_suffix('.state.json'), {})['node'], facts)
            self.assertEqual(case.path.read_bytes(), raw)
        finally:
            case.doCleanups()

    def test_stale_node_clear_respects_caller_deadline(self):
        from test_log_catchup import LogCatchupTests
        for budget in (0, 1):
            with self.subTest(budget=budget):
                case = LogCatchupTests('test_logs_completes_and_repeated_logs_do_not_duplicate')
                case.setUp()
                try:
                    facts, _ = node_receipt('v24.22.1', 'run-x')
                    runs.save_run_state('run-x', node=facts)
                    clock, calls = [1000.0], []
                    @contextlib.contextmanager
                    def busy_lock(name, timeout=600):
                        calls.append(timeout)
                        clock[0] += timeout
                        raise common.OffboxError('isolated state lock contention')
                        yield
                    def advance(seconds):
                        clock[0] += seconds
                    with patch.object(runs, 'file_lock', busy_lock), \
                            patch.object(runs, 'now', side_effect=lambda: clock[0]), \
                            patch.object(runs.time, 'sleep', side_effect=advance):
                        runs.remember_interruption('run-x', dict(attempt=2, nodeSetup=dict(stderrOffset=300)),
                                                   until=1000 + budget)
                    self.assertTrue(calls)
                    self.assertEqual(set(calls), {0})
                    self.assertLessEqual(clock[0], 1000 + budget)
                finally:
                    case.doCleanups()

    def test_final_node_collection_cannot_extend_history_deadline(self):
        from test_log_catchup import LogCatchupTests
        for update in ('clear stale facts', 'save fresh facts'):
            with self.subTest(update=update):
                case = LogCatchupTests('test_logs_completes_and_repeated_logs_do_not_duplicate')
                case.setUp()
                try:
                    facts, receipt = node_receipt('v24.22.1', 'run-x')
                    initial = (receipt + 'offbox-command-started: run-x\n').encode()
                    runs.save_run_state('run-x', command_id='cmd_a', node=None)
                    runs.remember_interruption('run-x', dict(commandId='cmd_a', attempt=1,
                                                            nodeSetup=dict(stderrOffset=0)))
                    case.prefix(initial, out=0, err=len(initial))
                    node_version.capture_stderr(case.path, initial, 0)
                    if update == 'clear stale facts':
                        resources.finalize(case.row(), node_only=True)
                    case.state('running', None)
                    clock, calls = [1000.0], []
                    actual_lock = runs.file_lock
                    @contextlib.contextmanager
                    def contention(name, timeout=600):
                        if name != 'run-state-run-x':
                            with actual_lock(name, timeout=timeout) as acquired:
                                yield acquired
                            return
                        calls.append(timeout)
                        clock[0] += timeout
                        raise common.OffboxError('modeled isolated state lock contention')
                        yield
                    def page(box, command, stream, offset, **kw):
                        source = b'' if stream == 'stdout' else initial
                        return dict(data=source[offset:].decode(), nextOffset=len(source), size=len(source),
                                    done=False, commandId='cmd_a', attempt=2 if update == 'clear stale facts' else 1,
                                    nodeSetup=dict(stderrOffset=len(initial) if update == 'clear stale facts' else 0))
                    case.history.side_effect = page
                    def advance(seconds):
                        clock[0] += seconds
                    checkpoint = common.checkpoint(case.path)
                    with patch.object(api, 'BACKEND', 'server'), patch.object(runs, 'file_lock', contention), \
                            patch.object(misc.time, 'time', side_effect=lambda: clock[0]), \
                            patch.object(runs, 'now', side_effect=lambda: clock[0]), \
                            patch.object(runs.time, 'sleep', side_effect=advance):
                        result = misc._catch_up_log(case.row(), budget=1, live=True)
                    self.assertEqual(result, 'incomplete:timeout' if update == 'clear stale facts' else 'complete')
                    self.assertTrue(calls)
                    self.assertEqual(set(calls), {0})
                    self.assertLessEqual(clock[0], 1001)
                    self.assertEqual(case.path.read_bytes(), initial)
                    self.assertEqual(common.checkpoint(case.path), checkpoint)
                    resources.finalize(case.row(), node_only=True)
                    self.assertEqual(common.read_json(case.path.with_suffix('.state.json'), {})['node'],
                                     None if update == 'clear stale facts' else facts)
                finally:
                    case.doCleanups()

    def test_recovered_node_collection_never_waits_for_state_writer(self):
        from test_log_catchup import LogCatchupTests
        for update in ('clear stale facts', 'save fresh facts'):
            with self.subTest(update=update):
                case = LogCatchupTests('test_logs_completes_and_repeated_logs_do_not_duplicate')
                case.setUp()
                try:
                    facts, receipt = node_receipt('v24.22.3', 'run-x')
                    raw = receipt.encode() if update == 'save fresh facts' else b'no receipt\n'
                    runs.save_run_state('run-x', node=None if update == 'save fresh facts' else facts)
                    Path(str(case.path) + '.remote').write_bytes(raw)
                    common.atomic_write_json(Path(str(case.path) + '.remote.json'), dict(
                        merged=True, lengths=[0, len(raw)], hashes=[hashlib.sha256(b'').hexdigest(),
                                                                  hashlib.sha256(raw).hexdigest()]))
                    actual_lock, calls = runs.file_lock, []
                    @contextlib.contextmanager
                    def contention(name, timeout=600):
                        if name != 'run-state-run-x':
                            with actual_lock(name, timeout=timeout) as acquired:
                                yield acquired
                            return
                        calls.append(timeout)
                        raise common.OffboxError('modeled isolated state lock contention')
                        yield
                    with patch.object(runs, 'file_lock', contention):
                        resources.finalize(case.row(), node_only=True)
                    self.assertEqual(calls, [0])
                    resources.finalize(case.row(), node_only=True)
                    self.assertEqual(common.read_json(case.path.with_suffix('.state.json'), {})['node'],
                                     facts if update == 'save fresh facts' else None)
                finally:
                    case.doCleanups()

    def test_metadata_repair_never_rewinds_committed_display_offsets(self):
        from test_log_catchup import LogCatchupTests
        facts, receipt = node_receipt('v24.22.3', 'run-x')
        stdout = b'workload stdout\n'
        stderr = ('offbox evidence wrapper pid=1\n' + receipt + 'offbox-command-started: run-x\nresult\n').encode()
        for live in (False, True):
            for available in (0, 50, len(stderr) - 1):
                with self.subTest(live=live, available=available):
                    case = LogCatchupTests('test_logs_completes_and_repeated_logs_do_not_duplicate')
                    case.setUp()
                    try:
                        case.prefix(stdout + stderr, out=len(stdout), err=len(stderr))
                        original, checkpoint = case.path.read_bytes(), common.checkpoint(case.path)
                        case.state('running' if live else 'done', None if live else 0)
                        case.streams(stdout, stderr[:available])
                        with patch.object(api, 'BACKEND', 'server'):
                            misc._catch_up_log(case.row(), live=live)
                            self.assertEqual(common.checkpoint(case.path), checkpoint)
                            self.assertEqual(case.path.read_bytes(), original)
                            case.streams(stdout, stderr)
                            misc._catch_up_log(case.row(), live=live)
                            case.state('done', 0)
                            self.assertEqual(case.invoke(wait=True)[0], 0)
                        self.assertEqual(common.checkpoint(case.path), checkpoint)
                        self.assertEqual(case.path.read_bytes(), original)
                        self.assertEqual(common.read_json(case.path.with_suffix('.state.json'), {})['node'], facts)
                    finally:
                        case.doCleanups()

    def test_stdout_cannot_supply_or_suppress_setup_facts_on_logs_then_wait(self):
        from test_log_catchup import LogCatchupTests
        facts, receipt = node_receipt('v24.22.1', 'run-x')
        _, other = node_receipt('v24.22.3', 'run-x')
        forms = {
            'older log': 'offbox evidence wrapper pid=99\n' + other + 'offbox-command-started: older-run\n',
            'older marker': 'offbox-command-started: older-run\n',
            'same-run marker': 'offbox-command-started: run-x\n',
            'receipt only': other,
            'nested retry': ('offbox-server: the server restarted while this run was going (attempt 1 is lost); '
                             'it is queued again as attempt 2\n' + other),
        }
        for form, stdout in forms.items():
            with self.subTest(form=form):
                case = LogCatchupTests('test_logs_completes_and_repeated_logs_do_not_duplicate')
                case.setUp()
                try:
                    case.prefix(b'')
                    case.state('running', None)
                    stderr = ('offbox evidence wrapper pid=1\n' + receipt +
                              'offbox-command-started: run-x\n').encode()
                    case.streams(stdout.encode(), stderr, page=37)
                    with patch.object(misc, '_refresh_running_ttl'), patch.object(api, 'BACKEND', 'server'):
                        self.assertEqual(case.invoke()[0], 0)
                        state = case.path.with_suffix('.state.json')
                        self.assertEqual(json.loads(state.read_text())['node'], facts)
                        saved, checkpoint = case.path.read_bytes(), common.checkpoint(case.path)
                        case.state('done', 0)
                        self.assertEqual(case.invoke(wait=True)[0], 0)
                        self.assertEqual(json.loads(state.read_text())['node'], facts)
                        self.assertEqual(case.path.read_bytes(), saved)
                        self.assertEqual(common.checkpoint(case.path), checkpoint)
                        client = case.path.with_suffix('.client.log').read_text()
                        self.assertEqual(client.count('offbox: node v24.22.1'), 1)
                        self.assertNotIn('v24.22.3', client)
                finally:
                    case.doCleanups()

    def test_stderr_replayed_logs_cannot_reopen_setup(self):
        from test_log_catchup import LogCatchupTests
        facts, receipt = node_receipt('v24.22.1', 'run-x')
        retry = ('offbox-server: the server restarted while this run was going (attempt 1 is lost); '
                 'it is queued again as attempt 2\n')
        for mode in ('history', 'recovered'):
            for identity in ('older-run', 'run-x', None):
                for body in ('receipt', 'missing', 'malformed'):
                    with self.subTest(mode=mode, identity=identity, body=body):
                        _, nested = node_receipt('v24.22.3', identity)
                        if body == 'missing':
                            nested = ''
                        elif body == 'malformed':
                            nested = 'offbox-node: {}\n'
                        stderr = ('offbox evidence wrapper pid=1\n' + receipt +
                                  'offbox-command-started: run-x\n' + retry +
                                  'offbox evidence wrapper pid=99\n' + nested +
                                  'offbox-command-started: older-run\n').encode()
                        case = LogCatchupTests('test_logs_completes_and_repeated_logs_do_not_duplicate')
                        case.setUp()
                        try:
                            case.prefix(b'')
                            case.state('running', None)
                            if mode == 'history':
                                case.streams(b'', stderr, page=37)
                                with patch.object(misc, '_refresh_running_ttl'), patch.object(api, 'BACKEND', 'server'):
                                    self.assertEqual(case.invoke()[0], 0)
                                    case.state('done', 0)
                                    self.assertEqual(case.invoke(wait=True)[0], 0)
                            else:
                                remote = Path(str(case.path) + '.remote')
                                remote.write_bytes(stderr)
                                Path(str(case.path) + '.remote.json').write_text(json.dumps(dict(
                                    merged=True, lengths=[0, len(stderr)], hashes=[
                                        hashlib.sha256(b'').hexdigest(), hashlib.sha256(stderr).hexdigest()])))
                                for _ in range(2):
                                    resources.finalize(dict(case.row()), node_only=True)
                            self.assertEqual(common.read_json(case.path.with_suffix('.state.json'), {})['node'], facts)
                            client = case.path.with_suffix('.client.log').read_text()
                            self.assertEqual(client.count('offbox: node v24.22.1'), 1)
                            self.assertNotIn('v24.22.3', client)
                        finally:
                            case.doCleanups()

    def test_retry_provenance_selects_setup_without_trusting_retry_text(self):
        from test_log_catchup import LogCatchupTests
        _, old = node_receipt('v24.22.1', 'run-x')
        final, receipt = node_receipt('v24.22.3', 'run-x')
        first = (old + 'offbox-command-started: run-x\n').encode()
        current = (receipt + 'offbox-command-started: run-x\n').encode()
        for mode in ('history', 'recovered'):
            for boundary in (len(first), None):
                with self.subTest(mode=mode, boundary=boundary):
                    case = LogCatchupTests('test_logs_completes_and_repeated_logs_do_not_duplicate')
                    case.setUp()
                    try:
                        case.prefix(b'')
                        raw = first + current
                        metadata = (dict(attempt=2) if boundary is None else
                                    dict(attempt=2, nodeSetup=dict(stderrOffset=boundary)))
                        if mode == 'history':
                            def history(box, command, stream, offset, **kw):
                                data = raw if stream == 'stderr' else b''
                                return dict(data=data[offset:].decode(), nextOffset=len(data), size=len(data),
                                            done=True, **metadata)
                            with patch.object(api, 'history_logs', side_effect=history):
                                self.assertEqual(case.invoke(wait=True)[0], 0)
                        else:
                            node_version.observe_attempt(case.path, metadata)
                            remote = Path(str(case.path) + '.remote')
                            remote.write_bytes(raw)
                            Path(str(case.path) + '.remote.json').write_text(json.dumps(dict(
                                merged=True, lengths=[0, len(raw)], hashes=[
                                    hashlib.sha256(b'').hexdigest(), hashlib.sha256(raw).hexdigest()])))
                            resources.finalize(dict(case.row()), node_only=True)
                        state = common.read_json(case.path.with_suffix('.state.json'), {})
                        self.assertEqual(state.get('node'), final if boundary is not None else None)
                    finally:
                        case.doCleanups()

    def test_old_server_without_setup_retry_still_records_node(self):
        from test_log_catchup import LogCatchupTests
        facts, receipt = node_receipt('v24.22.1', 'run-x')
        stderr = (receipt + 'offbox-command-started: run-x\n').encode()
        case = LogCatchupTests('test_logs_completes_and_repeated_logs_do_not_duplicate')
        case.setUp()
        try:
            case.prefix(b'')
            def history(box, command, stream, offset, **kw):
                data = stderr if stream == 'stderr' else b''
                return dict(data=data[offset:].decode(), nextOffset=len(data), size=len(data),
                            done=True, attempt=1)
            with patch.object(api, 'history_logs', side_effect=history):
                self.assertEqual(case.invoke(wait=True)[0], 0)
            self.assertEqual(common.read_json(case.path.with_suffix('.state.json'), {})['node'], facts)
        finally:
            case.doCleanups()

    def test_old_waiter_display_log_is_repaired_only_from_stderr_history(self):
        from test_log_catchup import LogCatchupTests
        facts, receipt = node_receipt('v24.22.1', 'run-x')
        _, other = node_receipt('v24.22.3', 'run-x')
        case = LogCatchupTests('test_logs_completes_and_repeated_logs_do_not_duplicate')
        case.setUp()
        try:
            stdout = (other + 'offbox-command-started: older-run\n').encode()
            stderr = (receipt + 'offbox-command-started: run-x\n').encode()
            case.prefix(stdout + stderr, out=len(stdout), err=len(stderr))
            case.streams(stdout, stderr, page=37)
            runs.save_run_state('run-x', node=None)
            resources.finalize(dict(case.row()), node_only=True)
            self.assertIsNone(common.read_json(case.path.with_suffix('.state.json'), {})['node'])
            saved, checkpoint = case.path.read_bytes(), common.checkpoint(case.path)
            self.assertEqual(case.invoke(wait=True)[0], 0)
            self.assertEqual(common.read_json(case.path.with_suffix('.state.json'), {})['node'], facts)
            self.assertEqual(case.path.read_bytes(), saved)
            self.assertEqual(common.checkpoint(case.path), checkpoint)
        finally:
            case.doCleanups()


class RecoveredNodeTests(_BackgroundOutputFixture):
    def test_verified_recovered_stderr_collects_for_logs_and_wait(self):
        facts, receipt = node_receipt('v24.22.3', 'run-x')
        _, forged = node_receipt('v24.99.0', 'older-run')
        stdout, stderr = forged.encode(), receipt.encode()
        self.box_get.return_value = dict(state='running')
        self.history.side_effect = runs.OffboxError('history unavailable')
        def ssh(argv, **kw):
            kw['stdout'].write(stdout + stderr)
            return subprocess.CompletedProcess(argv, 0, stderr=f'streams {len(stdout)} {len(stderr)}\n'.encode())
        runs.save_run_state('run-x', node=None)
        with patch.object(misc.subprocess, 'run', side_effect=ssh):
            self.assertEqual(self.invoke()[0], 0)
            self.assertEqual(self.invoke(wait=True)[0], 0)
        self.assertEqual(json.loads(self.path.with_suffix('.state.json').read_text())['node'], facts)
        label = self.path.with_suffix('.client.log').read_text()
        self.assertEqual(label.count('offbox: node v24.22.3'), 1)
        self.assertNotIn('v24.99.0', label)

    def test_unverified_or_changed_recovered_copy_cannot_supply_facts(self):
        _, receipt = node_receipt('v24.22.3', 'run-x')
        raw = receipt.encode()
        remote = Path(str(self.path) + '.remote')
        self.path.write_text('')
        remote.write_bytes(raw)
        for meta in (dict(merged=False), dict(merged=True, lengths=[0, len(raw) + 1], hashes=['0'*64]*2),
                     dict(merged=True, lengths=[0, len(raw)], hashes=['0'*64]*2)):
            with self.subTest(meta=meta):
                runs.save_run_state('run-x', node=None)
                Path(str(self.path) + '.remote.json').write_text(json.dumps(meta))
                resources.finalize(self.row(), node_only=True)
                self.assertIsNone(json.loads(self.path.with_suffix('.state.json').read_text())['node'])


if __name__ == '__main__':
    unittest.main()
