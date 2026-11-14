"""Template selection and lease diagnostics without backend calls."""
import contextlib
import io
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, common, home, lease, pool
from test_capacity import Isolated


class TemplateSelectionTests(unittest.TestCase):
    def test_manifests_and_reasons(self):
        cases = (
            ({'go.mod': 'module example.com/service'}, 'service', ('crpko-go', 'go.mod')),
            ({'go.mod': 'require github.com/testcontainers/testcontainers-go v0.39.0'}, 'service',
             ('crpko-harness', 'testcontainers')),
            ({}, 'crpko-integration-harness', ('crpko-harness', 'repo_key-harness')),
            ({'package.json': '{}'}, 'service', ('crpko-node', 'package.json')),
            ({}, 'service', ('generic', 'generic')),
            ({'go.mod': 'require github.com/testcontainers/testcontainers-go v0.39.0'}, 'crpko-devops',
             ('crpko-go', 'crpko-devops')),
            ({'go.mod': 'module example.com/service', 'package.json': '{}'}, 'service', ('crpko-go', 'go.mod')),
            ({'go.mod': 'module example.com/service'}, 'harness-worker', ('crpko-harness', 'repo_key-harness')),
        )
        for compose in (None, 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'):
            for manifests, key, expected in cases:
                with self.subTest(compose=compose, manifests=manifests, key=key), tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp)
                    for name, text in manifests.items():
                        (root / name).write_text(text)
                    if compose:
                        (root / compose).write_text('services: {}')
                    self.assertEqual(lease.pick_template(root, key), expected)

    def test_unreadable_go_mod_still_selects_go(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'go.mod').touch()
            with patch.object(Path, 'read_text', side_effect=OSError('unreadable')):
                self.assertEqual(lease.pick_template(root, 'service'), ('crpko-go', 'go.mod'))


class LeaseTemplateLoggingTests(Isolated):
    def setUp(self):
        super().setUp()
        self.root = Path(self.tmp.name) / 'repo'
        self.root.mkdir()
        (self.root / 'go.mod').write_text('module example.com/service')
        (self.root / 'compose.yaml').write_text('services: {}')
        self.me['repo_root'] = str(self.root)
        self.stderr = self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        self.stack.enter_context(patch.object(home, 'only_on_home', return_value=False))
        self.stack.enter_context(patch.object(lease, '_fit_new', side_effect=lambda size, _: size))
        self.create = self.stack.enter_context(patch.object(api, 'create', return_value={'id': 'new'}))

    def assert_pick(self, name, reason):
        lines = [line for line in common.LOG_PATH.read_text().splitlines() if 'template_pick ' in line]
        self.assertEqual(len(lines), 1)
        self.assertIn(f'template_pick repo_key=repo template={name} reason={reason}', lines[0])
        self.assertEqual(self.stderr.getvalue().count(f'template {name} ({reason}; --template to override)'), 1)

    def base(self):
        self.con.execute("INSERT INTO bases(name,repo_key,box_id,size,is_default,saved) "
                         "VALUES ('repo:seed','repo','seed-box','large',1,'seed-snapshot')")
        self.con.commit()

    def test_auto_recipe_logs_reason(self):
        got = lease._new_box(self.con, self.me, None, None, None, False)
        self.assertEqual(got[1], 'recipe:crpko-go')
        self.assert_pick('crpko-go', 'go.mod')

    def test_explicit_template_wins_over_default_base(self):
        self.base()
        got = lease._new_box(self.con, self.me, None, 'generic', None, False)
        self.assertEqual(got[1], 'recipe:generic')
        self.assert_pick('generic', 'explicit')

    def test_default_base_wins_over_auto_pick(self):
        self.base()
        got = lease._new_box(self.con, self.me, None, None, None, False)
        self.assertEqual(got[1], 'base:repo:seed')
        self.assert_pick('base:repo:seed', 'base:repo:seed')

    def test_explicit_base_wins_over_template(self):
        self.base()
        got = lease._new_box(self.con, self.me, None, 'generic', 'seed', False)
        self.assertEqual(got[1], 'base:repo:seed')
        self.assert_pick('base:repo:seed', 'base:repo:seed')

    def test_fresh_ignores_template_and_default_base(self):
        self.base()
        got = lease._new_box(self.con, self.me, None, 'crpko-harness', None, True)
        self.assertEqual(got[1], 'fresh')
        self.assertEqual(got[3], 'large')
        self.assert_pick('fresh', 'explicit')

    def test_reused_pool_box_reports_actual_source(self):
        self.box('old', member=True, source='recipe:crpko-harness')
        with patch.object(lease, '_reuse', side_effect=lambda con, row, size, **kwargs: dict(row)):
            got = pool.acquire(self.me)
        pool.release_guard(got)
        self.assert_pick('crpko-harness', 'reuse:recipe:crpko-harness')
        self.create.assert_not_called()

    def test_reused_private_base_reports_source(self):
        row = {'box_id': 'old', 'source': 'base:repo:seed', 'state': 'running'}
        with patch.object(lease, 'find_lease', return_value=row), patch.object(lease, '_reuse', return_value=row):
            lease.acquire_private(self.me)
        self.assert_pick('base:repo:seed', 'base:repo:seed')
        self.create.assert_not_called()

    def test_reused_explicit_template_reports_explicit(self):
        lease.report_reused_template(self.me, {'source': 'recipe:generic'}, 'generic')
        self.assert_pick('generic', 'explicit')

    def test_warm_peer_handoff_reports_template(self):
        self.box('warm', member=True, source='template:crpko-go')
        with patch.object(lease, 'ensure_ttl', return_value=True), \
                patch.object(api, 'get', return_value={'state': 'running', 'type': 'large'}), \
                patch.object(lease.ssh_sync, 'ssh', return_value=SimpleNamespace(returncode=0)):
            got = pool.try_warm(self.me, 'large', None, set(), None)
        self.assertIsNotNone(got)
        pool.release_guard(got)
        self.assert_pick('crpko-go', 'go.mod')


if __name__ == '__main__':
    unittest.main()
