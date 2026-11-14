import contextlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'skill/scripts'
sys.path.insert(0, str(SCRIPTS))
import active_sessions as active
import dev_janitor as janitor
import worktree_reaper as reaper

GOOD = dict(complete=True, threads={}, opencode=set(), workspaces={'native': '/work/app'}, problems=[])


class LivenessTests(unittest.TestCase):
    def test_both_scripts_use_same_api_workspaces_and_service_directories(self):
        with patch.object(active, 'snapshot', return_value={**GOOD, 'opencode': {'ses_test'}}), \
                patch.object(active, 'opencode_directories', return_value=({'ses_test': '/work/service'}, None)):
            ids, dirs, error = janitor.running_sessions()
            self.assertIsNone(error)
            self.assertEqual(ids, {'ses_test'})
            self.assertEqual(dirs, {'thread:native': '/work/app', 'ses_test': '/work/service'})
            self.assertEqual(reaper.running_dirs(), {'/work/app', '/work/service'})

    def test_api_down_truncation_and_unexpected_exception_fail_closed_for_both(self):
        failures = [{**GOOD, 'complete': False, 'problems': [cause]} for cause in
                    ['API down', 'control api native truncated 500/700']]
        failures.append(RuntimeError('timeout'))
        for failure in failures:
            with self.subTest(failure=failure), contextlib.ExitStack() as stack:
                kw = {'side_effect': failure} if isinstance(failure, Exception) else {'return_value': failure}
                stack.enter_context(patch.object(active, 'snapshot', **kw))
                ids, dirs, error = janitor.running_sessions()
                self.assertIsNone(ids)
                self.assertEqual(dirs, {})
                self.assertTrue(error)
                with self.assertRaisesRegex(RuntimeError, 'liveness_unavailable'):
                    reaper.running_dirs()
                stack.enter_context(patch.object(janitor, 'procs', return_value=[]))
                stack.enter_context(patch.object(janitor, 'keep_list', return_value=[]))
                stack.enter_context(patch.object(janitor.leftover_processes, 'scan', return_value={}))
                stack.enter_context(patch.object(janitor, 'sh', side_effect=lambda cmd, **kw: (0, json.dumps({'devices': {'ios': [{'state': 'Booted', 'udid': 'x', 'name': 'phone'}]}}), '') if cmd[0] == 'xcrun' else (1, '', '')))
                report = janitor.scan()
                self.assertEqual(report['candidates'], [])
                self.assertIn('liveness_unavailable', report['resources'][0]['keep_reasons'][0])
                self.assertTrue(report['liveness_unavailable'])

    def test_service_directory_failure_keeps_both(self):
        with patch.object(active, 'snapshot', return_value={**GOOD, 'opencode': {'ses_test'}}), \
                patch.object(active, 'opencode_directories', return_value=(None, 'session directory missing')):
            self.assertIsNone(janitor.running_sessions()[0])
            with self.assertRaisesRegex(RuntimeError, 'directory missing'):
                reaper.running_dirs()

    def test_history_gap_keeps_worktree_and_legacy_resources_report_only(self):
        with patch.object(active, 'session_history', return_value=(None, {}, 'history API missing')), \
                patch.object(active, 'project_roots', return_value=({}, None)):
            history = reaper.session_activity()
        self.assertEqual(reaper.activity_for_repo('/git', history, 100), (None, 'history API missing'))
        with patch.object(reaper.os.path, 'isdir', return_value=True), \
                patch.object(reaper, 'git', return_value=(1, '', 'unavailable')):
            report = reaper.evaluate({'worktree': '/old', 'common': '/git', 'main': False}, 100, set(), None, [], [])
        self.assertIn('activity_history_unavailable: report_only', report['reasons'])
        with patch.object(active, 'snapshot', return_value=GOOD), \
                patch.object(janitor, 'procs', return_value=[]), \
                patch.object(janitor, 'sh', return_value=(1, '', '')), \
                patch.object(janitor, 'keep_list', return_value=[]), \
                patch.object(janitor.leftover_processes, 'scan', return_value={}):
            self.assertEqual(janitor.scan()['candidates'], [])

    def test_process_candidate_cannot_reach_resource_action(self):
        with patch.object(janitor, 'scan', return_value={'resources': [], 'processes': {'candidates': [{'pid': 42}]}}), \
                patch.object(janitor, 'sh', return_value=(1, '', '')), patch.object(janitor, 'act') as act:
            janitor.apply('process:42')
        act.assert_not_called()

    def test_scripts_never_reference_live_databases(self):
        for script in SCRIPTS.rglob("*"):
            if not script.is_file() or script.suffix not in {'.py', '.sh', '.zsh'} or '.bak-' in script.name:
                continue
            text = script.read_text()
            for forbidden in ('opencode.db', 'statev2.sqlite'):
                with self.subTest(script=script.name, forbidden=forbidden):
                    self.assertNotIn(forbidden, text)

    def test_no_write_cli_emits_no_logs_or_report_files(self):
        with patch.object(sys, 'argv', ['janitor', 'scan', '--no-write']), \
                patch.object(janitor, 'scan', return_value={'resources': []}), \
                patch.object(janitor, 'record_report') as record, patch.object(janitor, 'log_run') as log, \
                contextlib.redirect_stdout(io.StringIO()):
            janitor.main()
        record.assert_not_called()
        log.assert_not_called()

    def test_process_rotation_state_only_advances_when_report_is_recorded(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp, patch.object(janitor, 'LAST', str(Path(tmp) / 'last.json')), \
                patch.object(janitor, 'LOG_DIR', tmp), patch.object(janitor, 'audit') as audit:
            self.assertEqual(janitor.process_cursor(), 0)
            report = dict(ts=1, liveness_unavailable=None, processes=dict(next_cursor={"priority": 0, "pid": 30}, checked=1,
                          skipped=2, budget_skipped=2, candidates=[], problems=[]))
            janitor.record_report(report)
            self.assertEqual(janitor.process_cursor(), {"priority": 0, "pid": 30})
            self.assertEqual(audit.call_args.args[0]['processes']['checked'], 1)

    def test_roster_malformed_rows_and_duplicate_ids_fail_closed(self):
        for threads, total in [([{}], 1), ([{'threadId': 'a'}] * 2, 2), ([], -1)]:
            with self.subTest(threads=threads), patch.object(active, '_control_get', return_value=(200, {'ok': True, 'threads': threads, 'total': total})):
                rows, err = active._control_threads('/threads', 1, 'test')
                self.assertIsNone(rows)
                self.assertTrue(err)

    def test_reaper_main_incomplete_api_does_not_discover_archive_or_remove(self):
        for cause in ['API down', 'native truncated']:
            with self.subTest(cause=cause), patch.object(active, 'snapshot', return_value={**GOOD, 'complete': False, 'problems': [cause]}), \
                    patch.object(sys, 'argv', ['reaper', '--dry-run']), \
                    patch.object(reaper, 'discover') as discover, patch.object(reaper, 'archive_ignored') as archive, \
                    contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(reaper.main(), 1)
            self.assertIn(cause, out.getvalue())
            discover.assert_not_called()
            archive.assert_not_called()


if __name__ == '__main__':
    unittest.main()
