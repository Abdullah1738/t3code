"""Deploy only source while preserving private files, runtime state and pause state."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('triage_install', Path(__file__).with_name('install.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def test_upgrade_preserves_state_preferences_and_lock_inode(self):
        with tempfile.TemporaryDirectory() as tmp:
            live, data = Path(tmp) / 'live', Path(tmp) / 'data'
            live.mkdir()
            data.mkdir()
            preserved = {}
            for name in ('cursor.json', 'state.json', 'check.lock', 'outbox.json', 'runs.jsonl'):
                path = live / name
                path.write_text('private runtime ' + name)
                preserved[path] = path.read_bytes()
            for name in ('prefs.md', 'noise.json', 'settings.json'):
                path = data / name
                path.write_text('private preferences ' + name)
                preserved[path] = path.read_bytes()
            inode = (live / 'check.lock').stat().st_ino
            old = {'paused': False, 'created_by_session': 'private-session'}
            (live / 'watcher.json').write_text(json.dumps(old))
            with patch.object(installer.subprocess, 'run') as run, patch.dict(os.environ, {'BUN_INSPECT': 'remove-me'}):
                installer.install(live=live, data=data)
            self.assertEqual(run.call_count, 2)
            args, kwargs = run.call_args_list[0]
            self.assertIn('--replace', args[0])
            self.assertIn('--no-prime', args[0])
            self.assertNotIn('BUN_INSPECT', kwargs['env'])
            definition = json.loads(kwargs['input'])
            self.assertEqual(definition['interval_s'], 300)
            self.assertTrue(definition['paused'])
            self.assertIsNone(definition['expires_at'])
            self.assertEqual(definition['created_by_session'], 'private-session')
            for path, value in preserved.items():
                self.assertEqual(path.read_bytes(), value)
            self.assertEqual((live / 'check.lock').stat().st_ino, inode)
            for name in installer.SOURCE_FILES:
                self.assertEqual((live / name).read_bytes(), (installer.SOURCE / name).read_bytes())

    def test_fresh_install_seeds_templates_without_runtime_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            live, data = Path(tmp) / 'live', Path(tmp) / 'data'
            with patch.object(installer.subprocess, 'run') as run:
                installer.install(live=live, data=data)
            self.assertNotIn('--replace', run.call_args_list[0].args[0])
            self.assertTrue(json.loads(run.call_args_list[0].kwargs['input'])['paused'])
            self.assertFalse((live / 'cursor.json').exists())
            for name, ext in [('prefs', 'md'), ('noise', 'json'), ('settings', 'json')]:
                self.assertEqual((data / f'{name}.{ext}').read_bytes(), (installer.SOURCE / f'{name}.template.{ext}').read_bytes())

    def test_paused_install_does_not_resume(self):
        with tempfile.TemporaryDirectory() as tmp:
            live, data = Path(tmp) / 'live', Path(tmp) / 'data'
            live.mkdir()
            (live / 'watcher.json').write_text('{"paused":true}')
            with patch.object(installer.subprocess, 'run') as run:
                installer.install(live=live, data=data)
            run.assert_called_once()
            self.assertTrue(json.loads(run.call_args.kwargs['input'])['paused'])


if __name__ == '__main__':
    unittest.main()
