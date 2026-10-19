"""Verify actual flock exclusion and independent diagnostic locks without network."""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('triage_lock', Path(__file__).with_name('triage.py'))
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)


class LockTests(unittest.TestCase):
    def test_competing_process_is_silent_and_leaves_state_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = Path(tmp)
            state = {'outbox': {'run': 'delivered', 'event': 'already sent'}}
            (wd / 'cursor.json').write_text(json.dumps(state))
            (wd / '.run-ok').write_text('delivered')
            with (wd / 'check.lock').open('a') as held:
                fcntl.flock(held, fcntl.LOCK_EX)
                result = subprocess.run([sys.executable, '-B', t.__file__], env={**os.environ, 'WATCH_DIR': tmp},
                                        capture_output=True, text=True, timeout=3)
            self.assertEqual(result.returncode, 75, result.stderr)
            self.assertEqual(result.stdout, '')
            # The runner acknowledges only exit 0 checks (runner.ts ackRun).
            if result.returncode == 0:
                (wd / '.run-ok').write_text('contending-run')
            self.assertEqual(json.loads((wd / 'cursor.json').read_text()), state)
            self.assertEqual((wd / '.run-ok').read_text(), 'delivered')
            self.assertIsNone(t.replay_outbox(state, wd, 'next-run'))
            self.assertNotIn('outbox', state)

    def test_dry_run_does_not_take_live_check_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            with (Path(tmp) / 'check.lock').open('a') as held:
                fcntl.flock(held, fcntl.LOCK_EX)
                with patch.dict(os.environ, {'WATCH_DIR': tmp}), patch.object(sys, 'argv', ['triage.py', '--dry-run-hours', '2']), patch.object(t, 'run', return_value=0) as run:
                    self.assertEqual(t.main(), 0)
                    run.assert_called_once()

    def test_lock_releases_on_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {'WATCH_DIR': tmp}), patch.object(sys, 'argv', ['triage.py']), patch.object(t, 'run', side_effect=RuntimeError('failure')):
                with self.assertRaises(RuntimeError):
                    t.main()
            with (Path(tmp) / 'check.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)


if __name__ == '__main__':
    unittest.main()
