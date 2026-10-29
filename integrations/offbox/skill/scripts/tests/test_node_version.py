"""Node version pick: parser cases, repo lookup, and the real bash block (no boat calls)."""
import json
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
        self.assertEqual(p("22.13"), [(K(22, 13), K(23))])
        self.assertEqual(p("v22.13.0"), [(K(22, 13), K(23))])
        self.assertEqual(p("22"), [(K(22), K(23))])
        self.assertEqual(p("lts/jod"), [(K(22), K(23))])
        self.assertIsNone(p("lts/*"))
        self.assertIsNone(p("node"))
        self.assertIsNone(p(""))
        self.assertEqual(p("# c\n20.11.1\n"), [(K(20, 11, 1), K(21))])
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
        self.assertIsNone(p(">=25 <24"))
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
        self.assertEqual(ranges, [(K(22, 13), K(23))])
        self.assertEqual(label, 'sub/.nvmrc 22.13')

    def test_nvmrc_and_engines_intersect(self):
        self.write('.nvmrc', '22.13.0\n')
        self.pkg('>=22.13 <23')
        ranges, label = node_version.want(self.root, self.root)
        self.assertEqual(ranges, [(K(22, 13), K(23))])
        self.assertIn('.nvmrc 22.13.0', label)
        self.assertIn('package.json engines >=22.13 <23', label)

    def test_disjoint_uses_engines_alone(self):
        self.write('.nvmrc', '20.11.1\n')
        self.pkg('>=22.13 <23')
        ranges, label = node_version.want(self.root, self.root)
        self.assertEqual(ranges, [(K(22, 13), K(23))])
        self.assertEqual(label, 'package.json engines >=22.13 <23')

    def test_node_version_file_used_without_nvmrc(self):
        self.write('.node-version', '22.13.0\n')
        ranges, label = node_version.want(self.root, self.root)
        self.assertEqual(ranges, [(K(22, 13), K(23))])
        self.assertEqual(label, '.node-version 22.13.0')

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
            blk = node_version.block(w) if w else ''
            with patch.object(runs, 'GO_REPAIR', ':'), patch.object(runs, 'DOCKER_REPAIR', ':'), \
                    patch.object(runs, 'LDCACHE_REPAIR', ':'):
                script = runs.remote_script('w/repo', '.', cmd_argv or ['node --version'], None, 'run-test',
                                            steps=steps, node=blk)
            env = {'HOME': home, 'PATH': '/usr/bin:/bin'}
            return subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True, timeout=60)

    def test_range_picks_newest_fitting(self):
        r = self.run_block('>=22.13 <23')
        self.assertEqual(r.stdout.strip(), 'v22.23.2')
        self.assertIn('offbox: node v22.23.2', r.stderr)

    def test_caret_picks_24(self):
        r = self.run_block('^24.13.1')
        self.assertEqual(r.stdout.strip(), 'v24.21.0')

    def test_no_match_warns_and_keeps_path(self):
        r = self.run_block('18', cmd_argv=['echo ran'])
        self.assertIn('warning', r.stderr)
        self.assertEqual(r.stdout.strip(), 'ran')
        self.assertEqual(r.returncode, 0)

    def test_exit_code_of_command_untouched(self):
        r = self.run_block('>=22.13 <23', cmd_argv=['exit 3'])
        self.assertEqual(r.returncode, 3)
        r = self.run_block('>=22.13 <23', steps=['node --version', 'exit 4'])
        self.assertEqual(r.returncode, 4)
        self.assertIn('v22.23.2', r.stdout)

    def test_no_nvm_dir_warns_and_command_runs(self):
        r = self.run_block('>=22.13 <23', cmd_argv=['echo ran'], nvm=False)
        self.assertIn('warning', r.stderr)
        self.assertEqual(r.stdout.strip(), 'ran')
        self.assertEqual(r.returncode, 0)


if __name__ == '__main__':
    unittest.main()
