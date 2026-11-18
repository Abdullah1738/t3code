"""Preflight rejects missing deployed dependencies before it stages a config."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

PKG = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('install_preflight', PKG / 'shared/install_preflight.py')
pre = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pre)


class PreflightTests(unittest.TestCase):
    def test_each_missing_plugin_and_lib_reports_install_order_without_writes(self):
        manifest = pre.gh.load_manifest()
        required = [spec for specs in manifest['paritySources'].values() for spec in specs
                    if isinstance(spec, dict) and '/.config/opencode/' in spec['installed']
                    and '/skills/' not in spec['installed']]
        for dep in required:
            with self.subTest(path=dep['installed']), tempfile.TemporaryDirectory() as tmp:
                home = Path(tmp)
                stage = home / 'stage.jsonc'
                item = json.loads(json.dumps(manifest))
                item['paritySources'] = {'fixture': [dep]}
                with mock.patch.dict(os.environ, {'HOME': tmp}), mock.patch.object(pre.gh, 'load_manifest', return_value=item):
                    with self.assertRaisesRegex(pre.gh.HomeError, 'install opencode-plugins first: missing (plugin|lib)/'):
                        pre.preflight(stage, home / 'original.jsonc')
                self.assertEqual(list(home.iterdir()), [])

    def test_valid_preflight_stages_migration_without_writing_native_homes(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {'HOME': tmp}):
            home = Path(tmp)
            manifest = pre.gh.load_manifest()
            manifest['paritySources'] = {}
            manifest['homes'] = {name: str(home / 'homes' / name) for name in pre.gh.HARNESSES}
            manifest['mcpServers'] = [server for server in manifest['mcpServers'] if server['id'] in ('flighty', 'inbody')]
            manifest['skillRoots'] = [str(home / 'skills')]
            (home / 'skills').mkdir()
            canonical = home / 'AGENTS.md'
            canonical.write_text('Fixture rules')
            manifest['instructions']['canonical'] = str(canonical)
            binary = home / 'bin/safe-chain'
            binary.parent.mkdir()
            binary.write_text('#!/bin/sh\nexit 0\n')
            binary.chmod(0o755)
            manifest['shellPathPrefix'] = []
            manifest['shellPath'] = [str(binary.parent)]
            start = home / '.local/share/opencode-service/start.zsh'
            start.parent.mkdir(parents=True)
            start.write_text('export PATH=' + str(binary.parent) + '\n')
            config = home / '.config/opencode/opencode.jsonc'
            config.parent.mkdir(parents=True)
            config.write_text(json.dumps({'mcp': {name: {'type': 'remote', 'url': 'http://old'}
                                                 for name in ('flighty', 'inbody')}}))
            before = config.stat()
            stage = home / 'staged.jsonc'
            with mock.patch.object(pre.gh, 'load_manifest', return_value=manifest):
                pre.preflight(stage, home / 'original.jsonc')
            self.assertEqual(json.loads(stage.read_text())['mcp'], pre.remote_entries(manifest))
            self.assertEqual((home / 'original.jsonc').read_bytes(), config.read_bytes())
            self.assertEqual(config.stat().st_ino, before.st_ino)
            self.assertEqual(config.stat().st_mtime_ns, before.st_mtime_ns)
            self.assertFalse((home / 'homes').exists())

    def test_invalid_config_fails_without_staging_or_touching_installed_files(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {'HOME': tmp}):
            home = Path(tmp)
            manifest = pre.gh.load_manifest()
            manifest['paritySources'] = {}
            config = home / '.config/opencode/opencode.jsonc'
            config.parent.mkdir(parents=True)
            config.write_text('{invalid')
            before = config.stat()
            with mock.patch.object(pre.gh, 'load_manifest', return_value=manifest):
                with self.assertRaises((ValueError, pre.gh.HomeError)):
                    pre.preflight(home / 'staged')
            self.assertEqual((config.stat().st_ino, config.stat().st_mtime_ns), (before.st_ino, before.st_mtime_ns))
            self.assertFalse((home / 'staged').exists())


if __name__ == '__main__':
    unittest.main()
