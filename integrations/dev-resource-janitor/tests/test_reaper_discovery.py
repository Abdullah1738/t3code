import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

from janitor_test_safety import JanitorTestCase

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skill/scripts'))
import worktree_reaper as reaper


class ReaperDiscoveryTests(JanitorTestCase):
    def test_child_timeout_preserves_other_sources_and_scan_depth(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve()
            home, external = base / 'home', base / 'ssd'
            slow = home / 'slow'
            slow.mkdir(parents=True)
            repos = [home, home / 'good/repo', external / 'repo', base / 'session', base / 'project']
            for repo in repos:
                repo.mkdir(parents=True, exist_ok=True)
                (repo / '.git').mkdir()
            for excluded in [home / 'good/too/deep', home / 'Library/hidden', home / 'node_modules/pkg']:
                (excluded / '.git').mkdir(parents=True)
            (home / 'linked').symlink_to(base / 'session', target_is_directory=True)
            tracker, calls = reaper.Timeouts(), []
            original = subprocess.run

            def run(cmd, **kwargs):
                calls.append(cmd)
                if cmd[0] == 'find':
                    if cmd[1] == str(slow):
                        raise subprocess.TimeoutExpired(cmd, kwargs['timeout'])
                    return original(cmd, **kwargs)
                return subprocess.CompletedProcess(cmd, 0, str(Path(cmd[2]) / '.git') + '\n', '')

            with patch.object(reaper, 'SCAN_ROOTS', [(str(home), 3), (str(external), 3)]), \
                    patch.object(reaper.subprocess, 'run', side_effect=run), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                found = reaper.discover({str(base / 'session'), str(base / 'project')}, tracker)
            self.assertEqual(found, sorted(str(repo / '.git') for repo in repos))
            self.assertEqual([row['path'] for row in tracker.skipped], [str(slow)])
            rows = {row['root']: row for row in tracker.discover_roots}
            self.assertTrue(rows[str(slow)]['timed_out'])
            self.assertEqual(rows[str(slow)]['found'], 0)
            self.assertEqual(rows[str(home / 'good')]['found'], 1)
            self.assertFalse(rows[str(home / 'good')]['timed_out'])
            for row in rows.values():
                self.assertGreaterEqual(row['duration_s'], 0)
            finds = [cmd for cmd in calls if cmd[0] == 'find']
            self.assertTrue(all(cmd[1] not in [str(home), str(external)] for cmd in finds))
            self.assertTrue(all(cmd[2:4] == ['-maxdepth', '2'] for cmd in finds))
            commands = [json.loads(line.split(' ', 1)[1]) for line in output.getvalue().splitlines()
                        if line.startswith('worktree_reaper_command ')]
            self.assertEqual(len(commands), len(finds))
            self.assertTrue(all('duration_s' in row for row in commands))

    def test_immediate_git_entry_is_discovered(self):
        for kind in ['directory', 'file', 'symlink']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as tmp:
                entry = Path(tmp) / '.git'
                if kind == 'directory':
                    entry.mkdir()
                elif kind == 'file':
                    entry.write_text('gitdir: elsewhere')
                else:
                    entry.symlink_to('elsewhere')
                with patch.object(reaper, 'SCAN_ROOTS', [(tmp, 3)]), \
                        patch.object(reaper, 'common_dir', return_value='/common.git') as binding, \
                        contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(reaper.discover(set()), ['/common.git'])
                binding.assert_called_once()
                self.assertEqual(binding.call_args.args[0], tmp)
