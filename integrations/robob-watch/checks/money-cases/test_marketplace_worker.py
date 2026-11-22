"""Detached refresh failures and privacy, using only disposable data and fake children."""
import datetime as dt
import errno
import json
import os
from pathlib import Path
import sys
import time
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import marketplace
import marketplace_worker as worker
from charges import toollog


class WorkerTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.data = Path(tmp.name)
        env = patch.dict(os.environ, {'ROBOB_TOOL_LOG_DIR': str(self.data / 'logs'),
                                     'TOOLLOG_ROOT': str(self.data / 'logs')})
        env.start()
        self.addCleanup(env.stop)

    def test_fresh_watcher_process_uses_sibling_orders_logger(self):
        here = Path(__file__).resolve().parent
        script = """
import json, sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
if sys.argv[3] == 'helper_preloaded':
    sys.path.insert(0, str(Path(sys.argv[1]).parents[2] / 'helpers'))
if sys.argv[3] != 'fresh':
    import toollog
import cases, marketplace
root = Path(sys.argv[2])
wd = root / 'wd'
wd.mkdir()
with patch.object(cases, '_run_check', return_value='fixture_event') as core, patch.object(marketplace, 'launch_refresh'):
    event = cases.run_check(wd, 'fixture', root / 'data')
row = json.loads((wd / 'runs.jsonl').read_text())
print(json.dumps({'event': event, 'core': core.call_count, 'refresh': row['marketplace_refresh']['status']}))
"""
        for mode, disabled in ((mode, disabled) for mode in ('fresh', 'helper_preloaded', 'orders_preloaded')
                               for disabled in ('0', '1')):
            with self.subTest(mode=mode, disabled=disabled):
                path = self.data / (mode + disabled)
                path.mkdir()
                result = subprocess.run([sys.executable, '-I', '-B', '-c', script, str(here), str(path), mode],
                    env={**os.environ, 'MONEY_CASES_REFRESH_DISABLED': disabled, 'HOME': str(self.data)},
                    capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), {'event': 'fixture_event', 'core': 1,
                    'refresh': 'skipped' if disabled == '1' else 'started'})

    def test_optional_refresh_state_unavailable_does_not_poison_check(self):
        import data_io
        original = Path.read_text
        def unavailable(path, *args, **kwargs):
            if path.name == 'marketplace-refresh.json':
                raise OSError(errno.EDEADLK, 'fixture unavailable')
            return original(path, *args, **kwargs)
        with data_io.scope(time.time() + 5):
            with patch.object(Path, 'read_text', unavailable), patch.object(data_io.subprocess, 'run'):
                details = marketplace.refresh_details(self.data, 'skipped')
            self.assertFalse(data_io.current_scope()['failed'])
            self.assertEqual(details['status'], 'skipped')
            self.assertIsNone(details['last_result'])
            from state_json import write_json
            write_json(self.data / 'saved.json', {'ok': True})
        self.assertTrue((self.data / 'saved.json').exists())

    def test_stalled_diagnostic_open_is_bounded_before_launch(self):
        import data_io
        original = os.open
        def stalled(path, *args, **kwargs):
            if Path(path).name == 'marketplace-refresh.err':
                time.sleep(1)
            return original(path, *args, **kwargs)
        with data_io.scope(time.time() + .03), patch.object(os, 'open', stalled), \
                patch.object(marketplace.subprocess, 'Popen') as child:
            with self.assertRaises(data_io.DataUnavailable):
                marketplace.launch_refresh(self.data)
            child.assert_not_called()
            self.assertFalse(data_io.current_scope()['failed'])

    def test_nonzero_child_keeps_bounded_private_safe_error_and_failure_record(self):
        snapshot = json.dumps(dict(marketplace.empty(), walked_at='2026-11-01T00:00:00Z'))
        path = self.data / 'marketplace-placements.json'
        path.write_text(snapshot)
        with patch.object(toollog, 'emit') as emit:
            code = worker.supervise(self.data, [sys.executable, '-I', '-B', '-c',
                "import sys; sys.stderr.write('private order 123 AED 456 2026-11-01 token=secret\\n'*2000 + 'ModuleNotFoundError: secret'); sys.exit(7)"])
        self.assertEqual(code, 7)
        error = (self.data / 'marketplace-refresh.err').read_text()
        self.assertLessEqual(len(error.encode()), 16 * 1024)
        self.assertIn('exit_code=7', error)
        self.assertIn('exception=ModuleNotFoundError', error)
        for private in ('123', '456', '2026-11-01', 'secret', 'private'):
            self.assertNotIn(private, error)
        self.assertEqual(path.read_text(), snapshot)
        state = json.loads((self.data / 'marketplace-refresh.json').read_text())
        self.assertEqual(state['last_result'], 'launch_error')
        self.assertIsNotNone(dt.datetime.fromisoformat(state['last_at']).tzinfo)
        self.assertFalse(emit.call_args.kwargs['ok'])
        self.assertEqual(emit.call_args.kwargs['props']['exitCode'], 7)
        self.assertEqual(marketplace.refresh_details(self.data, 'started')['last_result'], 'launch_error')

    def test_missing_executable_keeps_failure_evidence(self):
        with patch.object(toollog, 'emit') as emit:
            self.assertEqual(worker.supervise(self.data, [str(self.data / 'missing-python')]), 1)
        self.assertIn('failure=spawn_error', (self.data / 'marketplace-refresh.err').read_text())
        self.assertFalse(emit.call_args.kwargs['ok'])

    def test_busy_worker_does_not_launch_or_overwrite_previous_diagnostics(self):
        import fcntl
        path = self.data / 'marketplace-refresh.err'
        path.write_text('previous failure')
        with (self.data / 'marketplace-worker.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            with patch.object(worker.subprocess, 'Popen') as child:
                self.assertEqual(worker.supervise(self.data, ['never-launch']), 0)
                child.assert_not_called()
        self.assertEqual(path.read_text(), 'previous failure')

    def test_launch_failure_keeps_precreated_error_file(self):
        with patch.object(marketplace.subprocess, 'Popen', side_effect=OSError('fixture')):
            with self.assertRaises(OSError):
                marketplace.launch_refresh(self.data)
        self.assertTrue((self.data / 'marketplace-refresh.err').exists())

    def test_refresh_metadata_only_accepts_known_keys_and_values(self):
        value = {'status': 'held_deadline', 'snapshot_age_s': 123, 'last_result': 'launch_error',
                 'last_at': '2026-11-20T00:00:00Z', 'order': 'private', 'amount': 999}
        safe = toollog.marketplace_refresh_fields(value)
        self.assertEqual(set(safe), {'status', 'snapshot_age_s', 'last_result', 'last_at'})
        self.assertEqual(safe['last_at'], '2026-11-20T00:00:00+00:00')
        safe = toollog.marketplace_refresh_fields({k: 'private' for k in value})
        self.assertEqual(safe, {'snapshot_age_s': None, 'last_result': None, 'last_at': None})
