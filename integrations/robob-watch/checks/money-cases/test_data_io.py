"""iCloud hydration, skip bookkeeping and verified Keep Downloaded installation."""
import os

# Before any helper loads: the send guards refuse live sends under this marker, and conftest.py sets it for pytest only.
os.environ.setdefault("ROBOB_TEST", "1")
from contextlib import redirect_stdout, redirect_stderr
from concurrent.futures import ThreadPoolExecutor
import errno
import io
import json
from pathlib import Path
import signal
from types import SimpleNamespace
import tempfile
import time
import unittest
from unittest.mock import patch

import cases
import data_io
import pin_data
import test_install


class MaterializeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / 'data'
        self.wd = Path(self.tmp.name) / 'watcher'
        self.data.mkdir()
        self.wd.mkdir()
        self.book = self.data / 'cases.json'
        self.book.write_text('{"version": 1, "cases": []}')
        self.download = patch.object(data_io.subprocess, 'run')
        self.download_mock = self.download.start()
        self.addCleanup(self.download.stop)

    def flaky_read(self, failures, target=None):
        original = Path.read_text
        calls = []
        def read(path, *args, **kwargs):
            if path == (target or self.book):
                calls.append(path)
                if failures is None or len(calls) <= failures:
                    raise OSError(errno.EDEADLK, 'Resource deadlock avoided')
            return original(path, *args, **kwargs)
        return read

    def test_transient_read_recovers_and_counts_in_pings_timing(self):
        with patch.object(Path, 'read_text', self.flaky_read(2)), \
                patch.dict(os.environ, {'MONEY_CASES_REFRESH_DISABLED': '1'}):
            cases.run_check(self.wd, 'r', self.data, now=cases.dt.datetime(2026, 11, 16, 2, tzinfo=cases.TZ),
                            find=lambda *a, **k: [], said=lambda *a, **k: [])
        timing = json.loads((self.wd / 'pings.json').read_text())['timing']
        self.assertEqual(timing['edeadlk_retries'], 2)
        self.assertGreaterEqual(timing['edeadlk_ms'], 690)
        self.assertEqual(timing['dataless_files'], 0)
        self.assertEqual(sum(call.args[0][:2] == ['brctl', 'download'] for call in self.download_mock.call_args_list), 1)

    def cli_skip(self, first=None):
        if first is not None:
            (self.wd / 'data-skips.json').write_text(json.dumps({'skip_streak': 3, 'first_skip_at': first}))
        pings = self.wd / 'pings.json'
        pings.write_text('{"sent": {}, "outbox": {"run":"retained"}}')
        before = {p: p.read_bytes() for p in (self.book, pings)}
        out, err = io.StringIO(), io.StringIO()
        started = time.monotonic()
        with patch.object(Path, 'read_text', self.flaky_read(None)), \
                patch.object(cases, 'DATA', self.data), patch.object(cases, 'LIVE', self.wd), \
                patch.object(cases, 'CHECK_BUDGET', 0.08), \
                patch.dict(os.environ, {'WATCH_DIR': str(self.wd)}), \
                patch.object(cases.faulthandler, 'enable'), patch.object(cases.faulthandler, 'dump_traceback_later'), \
                redirect_stdout(out), redirect_stderr(err):
            rc = cases.main(['check'])
        self.assertLess(time.monotonic() - started, 0.3)
        self.assertEqual(out.getvalue(), '')
        self.assertEqual(err.getvalue(), 'money-cases: data file not downloaded (EDEADLK): cases.json\n')
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertFalse((self.data / 'questions.json').exists())
        self.assertFalse((self.data / 'data-skips.json').exists())
        state = json.loads((self.wd / 'data-skips.json').read_text())
        self.assertEqual(state['last_file'], 'cases.json')
        self.assertIn('edeadlk_ms', state)
        return rc, state

    def test_quiet_skip_preserves_books_and_outbox_inside_budget(self):
        rc, state = self.cli_skip()
        self.assertEqual(rc, 0)
        self.assertEqual(state['skip_streak'], 1)

    def test_two_hour_skip_streak_escalates(self):
        for age, expected in ((7190, 0), (7200, 1), (7300, 1)):
            with self.subTest(age=age):
                rc, state = self.cli_skip(time.time() - age)
                self.assertEqual(rc, expected)
                self.assertEqual(state['skip_streak'], 4)

    def test_clean_run_resets_skip_streak_and_records_recovery(self):
        state = self.wd / 'data-skips.json'
        state.write_text('{"skip_streak": 4}')
        with patch.dict(os.environ, {'MONEY_CASES_REFRESH_DISABLED': '1'}):
            cases.run_check(self.wd, 'r', self.data, now=cases.dt.datetime(2026, 11, 16, 2, tzinfo=cases.TZ),
                            find=lambda *a, **k: [], said=lambda *a, **k: [])
        self.assertFalse(state.exists())
        self.assertEqual(json.loads((self.wd / 'pings.json').read_text())['timing']['edeadlk_skips_before'], 4)

    def test_lock_open_and_flock_are_retried(self):
        original = Path.open
        for operation in ('open', 'flock'):
            with self.subTest(operation=operation):
                calls = []
                def opened(path, *a, **k):
                    if path.name == 'cases.lock':
                        calls.append(path)
                        if len(calls) == 1:
                            raise OSError(errno.EDEADLK, 'deadlock')
                    return original(path, *a, **k)
                stats = {}
                target = patch.object(Path, 'open', opened) if operation == 'open' else \
                    patch.object(cases.fcntl, 'flock', side_effect=[OSError(errno.EDEADLK, 'deadlock'), None])
                with target, data_io.scope(time.time() + 2, stats):
                    with cases.Locked(self.data) as book:
                        book['version'] = 1
                self.assertEqual(stats['edeadlk_retries'], 1)

    def test_atomic_write_retries_without_overwriting_on_failed_read(self):
        with patch.object(Path, 'read_text', self.flaky_read(None)), \
                data_io.scope(time.time() + 0.05), self.assertRaises(data_io.DataUnavailable):
            with cases.Locked(self.data) as book:
                book['cases'].append({'bad': True})
        self.assertEqual(json.loads(self.book.read_text())['cases'], [])
        real = os.replace
        calls = []
        def replace(src, dst):
            calls.append(dst)
            if len(calls) == 1:
                raise OSError(errno.EDEADLK, 'deadlock')
            return real(src, dst)
        with patch.object(os, 'replace', replace), data_io.scope(time.time() + 2):
            cases.write_json(self.book, {'cases': [], 'new': True})
        self.assertTrue(json.loads(self.book.read_text())['new'])

    def test_cleanup_deadlock_preserves_hydration_abort(self):
        original = self.book.read_bytes()
        with patch.object(os, 'write', side_effect=OSError(errno.EDEADLK, 'deadlock')), \
                patch.object(os, 'unlink', side_effect=OSError(errno.EDEADLK, 'cleanup deadlock')), \
                data_io.scope(time.time() + 0.05), self.assertRaises(data_io.DataUnavailable):
            cases.write_json(self.book, {'cases': [{'bad': True}]})
        self.assertEqual(self.book.read_bytes(), original)

    def test_startup_count_ignores_files_renamed_after_scandir(self):
        calls = []
        (self.data / '.cases.json.temporary').touch()
        original = os.stat
        def stat(path, **kw):
            calls.append(path)
            if str(path).endswith('.temporary'):
                raise FileNotFoundError(path)
            return original(path, **kw)
        with patch.object(os, 'stat', stat):
            self.assertEqual(data_io.dataless_files(self.data), 0)
        self.assertEqual(len(calls), 2)

    def test_retry_never_runs_after_deadline_even_with_slow_download(self):
        attempts = []
        def unavailable():
            attempts.append(time.time())
            raise OSError(errno.EDEADLK, 'deadlock')
        def download(*a, **k):
            time.sleep(0.3)
        start = time.time()
        with patch.object(data_io.subprocess, 'run', download), data_io.scope(start + 0.04), \
                self.assertRaises(data_io.DataUnavailable):
            data_io.materialize_io(unavailable, self.book)
        self.assertEqual(len(attempts), 1)
        self.assertLess(time.time() - start, 0.12)

    def test_initial_stalled_read_quietly_skips_inside_budget(self):
        original = Path.read_text
        def stalled(path, *a, **kw):
            if path == self.book:
                time.sleep(1)
            return original(path, *a, **kw)
        start = time.monotonic()
        out, err = io.StringIO(), io.StringIO()
        with patch.object(Path, 'read_text', stalled), patch.object(cases, 'CHECK_BUDGET', 0.06), \
                patch.object(cases, 'DATA', self.data), patch.object(cases, 'LIVE', self.wd), \
                patch.dict(os.environ, {'WATCH_DIR': str(self.wd)}), \
                patch.object(cases.faulthandler, 'enable'), patch.object(cases.faulthandler, 'dump_traceback_later'), \
                redirect_stdout(out), redirect_stderr(err):
            self.assertEqual(cases.main(['check']), 0)
        self.assertLess(time.monotonic() - start, 0.2)
        self.assertEqual(out.getvalue(), '')
        self.assertIn('data file not downloaded', err.getvalue())
        self.assertFalse((self.wd / 'pings.json').exists())
        self.assertEqual(json.loads((self.wd / 'data-skips.json').read_text())['skip_streak'], 1)

    def test_cleanup_failure_does_not_lose_committed_event(self):
        now = cases.dt.datetime(2026, 11, 16, 12, tzinfo=cases.TZ)
        cases.add(self.data, 'acme', 'Acme', '12', 'AED', 'pending', 'check refund', '2026-11-16', 'Abdullah', at=now)
        skip = self.wd / 'data-skips.json'
        skip.write_text('{"skip_streak": 2}')
        original = Path.unlink
        def unlink(path, *a, **kw):
            if path == skip:
                raise PermissionError('no')
            return original(path, *a, **kw)
        with patch.object(Path, 'unlink', unlink), patch.dict(os.environ, {'MONEY_CASES_REFRESH_DISABLED': '1'}), \
                redirect_stderr(io.StringIO()):
            event = cases.run_check(self.wd, 'r', self.data, now=now,
                                    find=lambda *a, **k: [], said=lambda *a, **k: [])
        self.assertTrue(event)
        pings = json.loads((self.wd / 'pings.json').read_text())
        self.assertEqual(pings['outbox']['event'], event)
        self.assertEqual(pings['timing']['edeadlk_skips_before'], 2)

    def test_missing_brctl_does_not_prevent_retry(self):
        stats = {}
        with patch.object(Path, 'read_text', self.flaky_read(1)), \
                patch.object(data_io.subprocess, 'run', side_effect=FileNotFoundError('brctl')), \
                data_io.scope(time.time() + 2, stats):
            self.assertEqual(cases.load(self.data)['cases'], [])
        self.assertEqual(stats['edeadlk_retries'], 1)

    def test_worker_thread_cache_reader_retries_without_owning_process_alarm(self):
        def read():
            stats = {}
            with data_io.scope(time.time() + 2, stats):
                book = cases.load(self.data)
            return book, stats
        handler = signal.getsignal(signal.SIGALRM)
        with patch.object(Path, 'read_text', self.flaky_read(1)), ThreadPoolExecutor(max_workers=1) as pool:
            book, stats = pool.submit(read).result(timeout=3)
        self.assertEqual(book['cases'], [])
        self.assertEqual(stats['edeadlk_retries'], 1)
        self.assertIs(signal.getsignal(signal.SIGALRM), handler)

    def test_other_errno_is_unchanged(self):
        with patch.object(Path, 'read_text', side_effect=PermissionError(errno.EACCES, 'no')), \
                self.assertRaises(PermissionError):
            cases.load(self.data)
        self.download_mock.assert_not_called()

    def test_dataless_is_metadata_only_and_one_stat_per_file(self):
        (self.data / 'cases.lock').touch()
        calls = []
        def stat(path, **kw):
            calls.append(path)
            return SimpleNamespace(st_mode=0o100600, st_flags=data_io.SF_DATALESS if str(path).endswith('.lock') else 0)
        with patch.object(os, 'stat', stat), patch.object(Path, 'read_text', side_effect=AssertionError('read')):
            self.assertEqual(data_io.dataless_files(self.data), 1)
        self.assertEqual(len(calls), 2)


class PinTests(unittest.TestCase):
    def test_pin_requires_provider_confirmation_and_is_idempotent(self):
        result = SimpleNamespace(stdout='isKeepDownloaded = 1;')
        with patch.object(pin_data.sys, 'platform', 'darwin'), \
                patch.object(pin_data.subprocess, 'run', side_effect=[SimpleNamespace(stdout='isKeepDownloaded = 0;'),
                    SimpleNamespace(stdout=''), result]) as run:
            self.assertEqual(pin_data.pin_data_dir(Path('/scratch')), 'pinned')
        self.assertEqual(run.call_args_list[1].args[0], ['xattr', '-w', pin_data.PIN, '1', '/scratch'])
        with patch.object(pin_data.sys, 'platform', 'darwin'), \
                patch.object(pin_data.subprocess, 'run', return_value=result) as run:
            self.assertEqual(pin_data.pin_data_dir(Path('/scratch')), 'already pinned')
            self.assertEqual(run.call_count, 1)

    def test_successful_xattr_without_confirmation_reports_failure(self):
        with patch.object(pin_data.sys, 'platform', 'darwin'), \
                patch.object(pin_data.time, 'monotonic', side_effect=[0, 9]), \
                patch.object(pin_data.subprocess, 'run', side_effect=[
                    SimpleNamespace(stdout='isKeepDownloaded = 0;'), SimpleNamespace(stdout='')]):
            self.assertIn('pin failed:', pin_data.pin_data_dir(Path('/scratch')))

    def test_check_reports_provider_state_and_dataless_count(self):
        with patch.object(pin_data.sys, 'platform', 'darwin'), \
                patch.object(pin_data.subprocess, 'run', return_value=SimpleNamespace(stdout='isKeepDownloaded = 1;')), \
                patch.object(pin_data, 'dataless_files', return_value=0):
            self.assertEqual(pin_data.pin_status(Path('/scratch')), 'pinned; dataless 0')

    def test_failing_pin_does_not_fail_install(self):
        installer = test_install.installer
        with tempfile.TemporaryDirectory() as tmp, patch.object(pin_data.sys, 'platform', 'darwin'):
            root = Path(tmp)
            def command(cmd, **kw):
                if cmd[0] == 'fileproviderctl':
                    raise FileNotFoundError('no provider command')
                return SimpleNamespace(returncode=0)
            out = io.StringIO()
            with patch.object(installer.subprocess, 'run', side_effect=command), redirect_stdout(out):
                installer.install(live=root / 'live', data=root / 'data', link=root / 'bin' / 'money-cases')
            self.assertIn('pin failed:', out.getvalue())
            self.assertTrue((root / 'bin' / 'money-cases').is_symlink())


if __name__ == '__main__':
    unittest.main()
