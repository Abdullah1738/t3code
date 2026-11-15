import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from janitor_test_safety import JanitorTestCase
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'skill/scripts'
sys.path.insert(0, str(SCRIPTS))
import worktree_reaper as reaper


class ReaperTimeoutTests(JanitorTestCase):
    def test_discovery_timeout_does_not_abort_other_repos(self):
        def run(cmd, **kwargs):
            if '/slow' in cmd:
                raise subprocess.TimeoutExpired(cmd, kwargs['timeout'])
            return subprocess.CompletedProcess(cmd, 0, '/repo.git\n', '')

        roster = [{'worktree': f'/good/{i}', 'common': '/repo.git', 'main': True} for i in range(20)]
        with patch.object(sys, 'argv', ['reaper', '--dry-run']), \
                patch.object(reaper, 'running_dirs', return_value={'/slow', '/good'}), \
                patch.object(reaper, 'session_activity', return_value={}), \
                patch.object(reaper, 'process_cwds', return_value=[]), \
                patch.object(reaper, 'keep_list', return_value=[]), \
                patch.object(reaper, 'SCAN_ROOTS', []), \
                patch.object(reaper.os.path, 'isdir', return_value=True), \
                patch.object(reaper.subprocess, 'run', side_effect=run), \
                patch.object(reaper, 'worktrees', return_value=(roster, None)), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            rc = reaper.main()
        self.assertEqual(rc, 0, output.getvalue())
        # Timeout lines precede the final, indented status JSON.
        status = json.loads(output.getvalue()[output.getvalue().index('{\n'):])
        self.assertEqual(status['kept']['main_worktree'], 20)
        self.assertEqual(status['skipped_timeouts'][0]['path'], '/slow')
        self.assertEqual(status['skipped_timeouts'][0]['phase'], 'discover')
        self.assertEqual(status['timeouts'], 1)

    def run_fixture(self, fail=None, *, dry_run=True, count=20, history=None, listing=False, commons=None,
                    archive_error=None, real_cwds=False):
        import tempfile
        from types import SimpleNamespace
        calls = []
        now = 200 * 86400
        roster = [{'worktree': f'/work/{i}', 'common': '/repo.git', 'main': False, 'HEAD': 'abc'}
                  for i in range(count)]

        def run(cmd, **kwargs):
            calls.append(cmd)
            if fail and fail(cmd, calls):
                raise subprocess.TimeoutExpired(cmd, kwargs['timeout'])
            if cmd[0] == 'lsof':
                output = 'p123\nn/unrelated\n'
            elif 'log' in cmd:
                output = '1\n'
            elif 'rev-list' in cmd:
                output = '0\n'
            elif 'rev-parse' in cmd:
                output = '/repo.git/worktrees/w\n'
            elif 'status' in cmd and 'submodule' not in cmd:
                output = '!! notes/\n' if fail and getattr(fail, 'size_check', False) else ''
            elif 'list' in cmd:
                output = '\n\n'.join(f"worktree {w['worktree']}\nHEAD abc" for w in roster) + '\n\n'
            elif cmd[0] == 'du':
                output = '0\n'
            else:
                output = ''
            return subprocess.CompletedProcess(cmd, 0, output, '')

        with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as stack:
            for obj, attr, kwargs in [
                (sys, 'argv', {'new': ['reaper'] + (['--dry-run'] if dry_run else [])}),
                (reaper, 'running_dirs', {'return_value': set()}),
                (reaper, 'session_activity', {'return_value': history if history is not None else {}}),
                (reaper, 'removal_activity', {'return_value': {}}),
                (reaper, 'keep_list', {'return_value': []}),
                (reaper, 'discover', {'return_value': commons or ['/repo.git']}),
                (reaper.os.path, 'isdir', {'return_value': True}),
                (reaper.os, 'stat', {'return_value': SimpleNamespace(st_birthtime=1)}),
                (reaper.time, 'time', {'return_value': now}),
                (reaper.subprocess, 'run', {'side_effect': run}),
                (reaper, 'LOG_DIR', {'new': tmp}),
                (reaper, 'STATUS', {'new': str(Path(tmp) / 'status.json')}),
                (reaper, 'AUDIT', {'new': str(Path(tmp) / 'audit.jsonl')}),
            ]:
                stack.enter_context(patch.object(obj, attr, **kwargs))
            if not real_cwds:
                stack.enter_context(patch.object(reaper, 'process_cwds', return_value=[]))
            if not listing:
                stack.enter_context(patch.object(reaper, 'worktrees', return_value=(roster, None)))
            archive = stack.enter_context(patch.object(reaper, 'archive_ignored', return_value=None, side_effect=archive_error))
            output = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            rc = reaper.main()
            status = json.loads(output.getvalue()[output.getvalue().index('{\n'):])
            if not dry_run:
                self.assertEqual(json.loads(Path(reaper.STATUS).read_text()), status)
            return rc, status, calls, archive.call_args_list, output.getvalue()

    def test_every_check_timeout_keeps_item_in_dry_run_and_apply(self):
        for operation in ['log', 'rev-list', 'rev-parse', 'status', 'submodule', 'find', 'du']:
            for dry_run in [True, False]:
                with self.subTest(operation=operation, dry_run=dry_run):
                    def fail(cmd, calls):
                        return ('/work/0' in cmd or any('/work/0/notes' in arg for arg in cmd)) and (
                            cmd[0] == operation or operation in cmd)
                    fail.size_check = operation in ['find', 'du']
                    rc, status, calls, archive, _ = self.run_fixture(fail, dry_run=dry_run)
                    self.assertEqual(rc, 0, status)
                    self.assertEqual(status['kept']['git_timeout'], 1)
                    self.assertEqual(status['timeouts'], 1)
                    self.assertEqual(status['skipped_timeouts'][0]['phase'], 'check')
                    self.assertNotIn('/work/0', [item['path'] for item in status['would_remove'] + status['removed']])
                    self.assertFalse(any('remove' in cmd and '/work/0' in cmd for cmd in calls))
                    self.assertFalse(any(call.args[0]['path'] == '/work/0' for call in archive))
                    expected = 1 if operation in ['find', 'du'] else 2
                    self.assertEqual(status['timeout_attempts'], expected)

    def test_retry_success_uses_normal_result_and_logs_both_durations(self):
        def fail(cmd, calls):
            return 'rev-list' in cmd and '/work/0' in cmd and calls.count(cmd) == 1
        rc, status, _, _, stdout = self.run_fixture(fail)
        self.assertEqual(rc, 0)
        self.assertEqual(len(status['would_remove']), 20)
        self.assertEqual(status['timeouts'], 0)
        self.assertEqual(status['timeout_attempts'], 1)
        self.assertEqual([row['event'] for row in status['timeout_events']], ['timeout', 'retry_complete'])
        self.assertEqual([row['attempt'] for row in status['timeout_events']], [1, 2])
        for row in status['timeout_events']:
            self.assertIn('duration_s', row)
        self.assertIn('retry_complete', stdout)

    def test_remove_timeout_is_not_retried_and_later_items_continue(self):
        def fail(cmd, calls):
            return 'remove' in cmd and '/work/0' in cmd
        rc, status, calls, _, _ = self.run_fixture(fail, dry_run=False)
        self.assertEqual(rc, 0, status)
        self.assertEqual(len(status['removed']), 19)
        self.assertNotIn('/work/0', [row['path'] for row in status['removed']])
        self.assertEqual(sum('remove' in cmd and '/work/0' in cmd for cmd in calls), 1)
        self.assertEqual(status['skipped_timeouts'][0]['phase'], 'remove')
        self.assertIn('worktree remove timed out', status['errors'][0])

    def test_systemic_thresholds_count_items_not_attempts(self):
        for count, failed, expected in [(200, 9, 0), (200, 10, 1), (20, 1, 0), (19, 1, 1)]:
            with self.subTest(count=count, failed=failed):
                def fail(cmd, calls):
                    return 'rev-list' in cmd and int(cmd[2].split('/')[-1]) < failed
                rc, status, _, _, _ = self.run_fixture(fail, count=count)
                self.assertEqual(rc, expected, status)
                self.assertEqual(status['timeouts'], failed)
                self.assertEqual(status['timeout_attempts'], failed * 2)
                self.assertEqual(status['state'], 'error' if expected else 'done')

    def test_listing_timeout_continues_to_another_repo(self):
        def fail(cmd, calls):
            return 'list' in cmd and '/repo.git' in cmd
        original = reaper.worktrees
        def listed(common, timeouts=None):
            return original(common, timeouts) if common == '/repo.git' else (
                [{'worktree': f'/good/{i}', 'common': common, 'main': True} for i in range(20)], None)
        with patch.object(reaper, 'worktrees', side_effect=listed):
            rc, status, _, _, _ = self.run_fixture(fail, listing=True, commons=['/repo.git', '/other.git'])
        self.assertEqual(status['kept']['main_worktree'], 20)
        self.assertEqual(rc, 0, status)
        self.assertEqual(status['skipped_timeouts'][0]['path'], '/repo.git')

    def test_timeout_wait_includes_only_failed_attempts(self):
        tracker = reaper.Timeouts()
        cmd = ['git', 'status']
        with patch.object(reaper.time, 'monotonic', side_effect=[1, 4, 5, 7]), \
                patch.object(reaper.subprocess, 'run', side_effect=[
                    subprocess.TimeoutExpired(cmd, 3), subprocess.CompletedProcess(cmd, 0, '', '')]), \
                contextlib.redirect_stdout(io.StringIO()):
            tracker.run(cmd, '/work', 'check', 3, retry=True)
        self.assertEqual(tracker.wait_s, 3)
        self.assertEqual([row['duration_s'] for row in tracker.events], [3, 2])

    def test_project_binding_timeout_cannot_turn_history_into_empty(self):
        history = reaper.Activity({}, {'p': '/project'}, {}, None)
        tracker = reaper.Timeouts()
        with patch.object(reaper.os.path, 'isdir', return_value=True), \
                patch.object(reaper.subprocess, 'run', side_effect=lambda cmd, **kw: (
                    _ for _ in ()).throw(subprocess.TimeoutExpired(cmd, kw['timeout']))), \
                patch.object(reaper.active_sessions, 'project_activity') as activity, \
                contextlib.redirect_stdout(io.StringIO()):
            result, error = reaper.activity_for_repo('/repo.git', history, 100, ['/old'], tracker)
        self.assertIsNone(result)
        self.assertIn('git_timeout', error)
        activity.assert_not_called()

    def test_discovery_timeout_path_is_kept_even_if_roster_finds_it(self):
        tracker = reaper.Timeouts()
        tracker.skip('/work/0/subdir', 'discover', subprocess.TimeoutExpired(['git', 'rev-parse'], 20))
        with patch.object(reaper, '_evaluate') as evaluate:
            result = reaper.evaluate({'worktree': '/work/0'}, 0, set(), {}, [], [], tracker)
        self.assertTrue(result['reasons'][0].startswith('git_timeout:'))
        evaluate.assert_not_called()

    def test_final_recheck_timeout_prevents_archive_and_removal(self):
        def fail(cmd, calls):
            return 'rev-list' in cmd and '/work/0' in cmd and calls.count(cmd) > 1
        rc, status, calls, archive, _ = self.run_fixture(fail, dry_run=False)
        self.assertEqual(rc, 0, status)
        self.assertEqual(status['kept']['git_timeout'], 1)
        self.assertFalse(any('remove' in cmd and '/work/0' in cmd for cmd in calls))
        self.assertFalse(any(call.args[0]['path'] == '/work/0' for call in archive))
        self.assertEqual(len(status['removed']), 19)

    def test_five_remove_timeouts_are_not_five_non_timeout_errors(self):
        def fail(cmd, calls):
            return 'remove' in cmd and int(cmd[-1].split('/')[-1]) < 5
        rc, status, _, _, _ = self.run_fixture(fail, count=100, dry_run=False)
        self.assertEqual(rc, 0, status)
        self.assertEqual(status['timeouts'], 5)
        self.assertEqual(len(status['errors']), 5)

    def test_five_other_errors_still_fail_run(self):
        rc, status, _, _, _ = self.run_fixture(count=20, dry_run=False, archive_error=RuntimeError('archive failed'))
        self.assertEqual(rc, 1)
        self.assertEqual(status['timeouts'], 0)
        self.assertEqual(len(status['errors']), 20)

    def test_discovery_retries_successfully_and_deduplicates_directories(self):
        calls = []
        def run(cmd, **kwargs):
            calls.append(cmd)
            if calls.count(cmd) == 1 and cmd[0] == 'git':
                raise subprocess.TimeoutExpired(cmd, kwargs['timeout'])
            return subprocess.CompletedProcess(cmd, 0, '/repo.git\n' if cmd[0] == 'git' else '/work/.git\n', '')
        tracker = reaper.Timeouts()
        with patch.object(reaper, 'SCAN_ROOTS', [('/scan', 3)]), \
                patch.object(reaper.os.path, 'isdir', return_value=True), \
                patch.object(reaper.subprocess, 'run', side_effect=run), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(reaper.discover({'/work'}, tracker), ['/repo.git'])
        self.assertEqual(len([cmd for cmd in calls if cmd[0] == 'git']), 2)
        self.assertEqual(tracker.skipped, [])

    def test_no_usable_roster_with_timeouts_is_error(self):
        def fail(cmd, calls):
            return 'list' in cmd
        rc, status, _, _, _ = self.run_fixture(fail, listing=True)
        self.assertEqual(rc, 1, status)
        self.assertEqual(status['state'], 'error')
        self.assertEqual(status['worktrees'], 0)
        self.assertEqual(status['timeouts'], 1)
        self.assertIn('systemic timeouts', status['errors'][0])

    def test_empty_inventory_without_timeouts_is_done(self):
        rc, status, _, _, _ = self.run_fixture(count=0)
        self.assertEqual(rc, 0, status)
        self.assertEqual(status['worktrees'], 0)
        self.assertEqual(status['timeouts'], 0)

    def test_final_process_check_timeout_is_kept_and_fully_accounted(self):
        import itertools
        def fail(cmd, calls):
            return cmd[0] == 'lsof' and calls.count(cmd) == 2
        with patch.object(reaper.time, 'monotonic', side_effect=itertools.count()):
            rc, status, calls, archive, stdout = self.run_fixture(fail, dry_run=False, real_cwds=True)
        self.assertEqual(rc, 0, status)
        self.assertEqual(status['timeouts'], 1)
        self.assertEqual(status['timeout_attempts'], 1)
        self.assertEqual(status['timeout_wait_s'], 1)
        event, = status['timeout_events']
        self.assertEqual(event['path'], '/work/0')
        self.assertEqual(event['cmd'], 'lsof -n -P -d cwd -Fpn')
        self.assertEqual(event['phase'], 'check')
        self.assertEqual(event['attempt'], 1)
        self.assertEqual(event['timeout_s'], 120)
        self.assertEqual(event['duration_s'], 1)
        self.assertIn('worktree_reaper_command', stdout)
        self.assertEqual(status['kept']['git_timeout'], 1)
        self.assertEqual(len(status['removed']), 19)
        self.assertFalse(any('remove' in cmd and '/work/0' in cmd for cmd in calls))
        self.assertFalse(any(call.args[0]['path'] == '/work/0' for call in archive))
