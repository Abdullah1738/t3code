"""Deploy only source, keep case data, ping state and pause state, and link the CLI."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('money_cases_install', Path(__file__).with_name('install.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def dirs(self, tmp):
        return Path(tmp) / 'live', Path(tmp) / 'data', Path(tmp) / 'bin' / 'money-cases'

    def test_upgrade_keeps_data_state_and_lock_inode(self):
        with tempfile.TemporaryDirectory() as tmp:
            live, data, link = self.dirs(tmp)
            live.mkdir()
            data.mkdir()
            kept = {}
            for path in (live / 'pings.json', live / 'state.json', live / 'check.lock', live / '.run-ok',
                         data / 'cases.json', data / 'cases.lock'):
                path.write_text('private ' + path.name)
                kept[path] = path.read_bytes()
            inode = (live / 'check.lock').stat().st_ino
            (live / 'watcher.json').write_text(json.dumps({'paused': False, 'created_by_session': 'ses-owner'}))
            with patch.object(installer.subprocess, 'run') as run, patch.dict(os.environ, {'BUN_INSPECT': 'x'}):
                installer.install(live=live, data=data, link=link)
            self.assertEqual(run.call_count, 2)
            args, kwargs = run.call_args_list[0]
            self.assertIn('--replace', args[0])
            self.assertIn('--no-prime', args[0])
            self.assertNotIn('BUN_INSPECT', kwargs['env'])
            definition = json.loads(kwargs['input'])
            self.assertEqual((definition['id'], definition['interval_s'], definition['max_fires']), ('money-cases', 900, 0))
            self.assertTrue(definition['paused'])
            self.assertIsNone(definition['expires_at'])
            self.assertEqual(definition['created_by_session'], 'ses-owner')
            self.assertEqual(run.call_args_list[1].args[0][1:], ['resume', 'money-cases'])
            for path, value in kept.items():
                self.assertEqual(path.read_bytes(), value)
            self.assertEqual((live / 'check.lock').stat().st_ino, inode)
            for name in installer.SOURCE_FILES:
                self.assertEqual((live / name).read_bytes(), (installer.SOURCE / name).read_bytes())
            self.assertTrue(os.access(live / 'check.sh', os.X_OK))
            self.assertEqual(os.readlink(link), str(live / 'cases.py'))

    def test_paused_watcher_stays_paused_and_fresh_install_has_no_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            live, data, link = self.dirs(tmp)
            with patch.object(installer.subprocess, 'run') as run:
                installer.install(live=live, data=data, link=link)
            self.assertNotIn('--replace', run.call_args_list[0].args[0])
            self.assertEqual(run.call_count, 2)
            self.assertEqual(list(data.iterdir()), [])
            (live / 'watcher.json').write_text(json.dumps({'paused': True}))
            with patch.object(installer.subprocess, 'run') as run:
                installer.install(live=live, data=data, link=link)
            self.assertEqual(run.call_count, 1)

    def test_failed_resume_is_retried_by_the_next_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            live, data, link = self.dirs(tmp)
            live.mkdir()
            (live / 'watcher.json').write_text(json.dumps({'paused': False}))

            def resume_fails(command, **_):
                if command[1] == 'add':
                    (live / 'watcher.json').write_text(json.dumps({'paused': True}))
                    return None
                raise installer.subprocess.CalledProcessError(1, command)
            with patch.object(installer.subprocess, 'run', side_effect=resume_fails), \
                    self.assertRaises(installer.subprocess.CalledProcessError):
                installer.install(live=live, data=data, link=link)
            self.assertTrue((live / '.install-paused').exists())
            with patch.object(installer.subprocess, 'run') as run:
                installer.install(live=live, data=data, link=link)
            self.assertEqual(run.call_args_list[-1].args[0][1:], ['resume', 'money-cases'])
            self.assertFalse((live / '.install-paused').exists())

    def test_cli_path_that_is_a_real_file_is_left_alone(self):
        with tempfile.TemporaryDirectory() as tmp:
            live, data, link = self.dirs(tmp)
            link.parent.mkdir(parents=True)
            link.write_text('someone else')
            with patch.object(installer.subprocess, 'run') as run, self.assertRaises(FileExistsError):
                installer.install(live=live, data=data, link=link)
            self.assertEqual(link.read_text(), 'someone else')
            self.assertEqual(run.call_count, 0)
            self.assertFalse(live.exists())


    def test_a_second_install_waits_for_the_first_to_finish_its_resume(self):
        with tempfile.TemporaryDirectory() as tmp:
            live, data, link = self.dirs(tmp)
            live.mkdir()
            (live / 'watcher.json').write_text(json.dumps({'paused': False}))
            seen = []

            def first(command, **_):
                if command[1] == 'resume':
                    # While A resumes, B must not get past the install lock.
                    probe = (live / 'install.lock').open('a')
                    try:
                        installer.fcntl.flock(probe, installer.fcntl.LOCK_EX | installer.fcntl.LOCK_NB)
                        seen.append('free')
                    except BlockingIOError:
                        seen.append('held')
                    finally:
                        probe.close()
                    check = (live / 'check.lock').open('a')
                    try:
                        installer.fcntl.flock(check, installer.fcntl.LOCK_EX | installer.fcntl.LOCK_NB)
                        seen.append('check free')
                    finally:
                        check.close()
            with patch.object(installer.subprocess, 'run', side_effect=first):
                installer.install(live=live, data=data, link=link)
            self.assertEqual(seen, ['held', 'check free'])
            self.assertFalse((live / '.install-paused').exists())

if __name__ == '__main__':
    unittest.main()
