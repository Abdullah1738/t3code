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

    def test_interrupted_io_retries_immediately_and_counts(self):
        for error in (InterruptedError(errno.EINTR, 'interrupted'), OSError(errno.EINTR, 'interrupted')):
            with self.subTest(error=error):
                stats = {}
                fn = unittest.mock.Mock(side_effect=[error, error, 'ready'])
                with data_io.scope(time.time() + 2, stats), patch.object(data_io.time, 'sleep') as sleep:
                    self.assertEqual(data_io.materialize_io(fn, self.book), 'ready')
                self.assertEqual(stats['eintr_retries'], 2)
                self.assertNotIn('edeadlk_retries', stats)
                sleep.assert_not_called()
        self.download_mock.assert_not_called()

    def test_interrupted_io_has_a_bound_and_preserves_original_error(self):
        first = InterruptedError(errno.EINTR, 'first')
        fn = unittest.mock.Mock(side_effect=[first] + [InterruptedError(errno.EINTR, 'again')] * 10)
        stats = {}
        with data_io.scope(time.time() + 2, stats), self.assertRaises(InterruptedError) as caught:
            data_io.materialize_io(fn, self.book)
        self.assertIs(caught.exception, first)
        self.assertEqual(fn.call_count, 4)
        self.assertEqual(stats['eintr_retries'], 3)
        self.download_mock.assert_not_called()

    def test_interrupted_io_never_retries_after_deadline(self):
        clock = [time.time()]
        error = InterruptedError(errno.EINTR, 'interrupted')
        def interrupted():
            clock[0] += 2
            raise error
        stats = {}
        with patch.object(data_io.time, 'time', side_effect=lambda: clock[0]), \
                data_io.scope(clock[0] + 1, stats), self.assertRaises(InterruptedError) as caught:
            data_io.materialize_io(interrupted, self.book)
        self.assertIs(caught.exception, error)
        self.assertEqual(stats.get('eintr_retries', 0), 0)

    def test_stalled_eintr_retry_preserves_owned_and_caller_timeouts(self):
        # The same retry can be bounded by our timer or an earlier caller's.
        # Only our own deadline may become the original interruption.
        for caller in ('none', 'check_timeout', 'data_unavailable'):
            with self.subTest(caller=caller):
                error = InterruptedError(errno.EINTR, 'first')
                calls = []
                def interrupted_then_stalled():
                    calls.append(1)
                    if len(calls) == 1:
                        raise error
                    time.sleep(1)
                stats = {}
                caller_error = cases.CheckTimeout('caller') if caller == 'check_timeout' else \
                    data_io.DataUnavailable(self.book, 'deadline')
                deadline = time.time() + 0.04
                with data_io.scope(deadline if caller == 'none' else deadline + 1, stats):
                    with self.assertRaises(BaseException) as caught:
                        if caller == 'none':
                            data_io.materialize_io(interrupted_then_stalled, self.book)
                        else:
                            with data_io._within(deadline, caller_error):
                                data_io.materialize_io(interrupted_then_stalled, self.book)
                    self.assertIs(caught.exception, error if caller == 'none' else caller_error)
                    self.assertEqual(data_io.current_scope()['failed'], caller == 'data_unavailable')
                self.assertEqual(len(calls), 2)
                self.assertEqual(stats['eintr_retries'], 1)
        self.download_mock.assert_not_called()

    def test_data_unavailable_reasons(self):
        for reason in ('deadline', 'edeadlk'):
            stats = {}
            fn = unittest.mock.Mock(side_effect=OSError(errno.EDEADLK, 'deadlock'))
            end = time.time() + (0.05 if reason == 'edeadlk' else -1)
            with self.subTest(reason=reason), data_io.scope(end, stats), \
                    self.assertRaises(data_io.DataUnavailable) as caught:
                data_io.materialize_io(fn, self.book)
            self.assertEqual(caught.exception.reason, reason)
            self.assertEqual(fn.call_count, int(reason == 'edeadlk'))

    def test_dataless_failures_do_not_poison_scope_or_save(self):
        for error in (InterruptedError(errno.EINTR, 'interrupted'), PermissionError(errno.EACCES, 'no'),
                      OSError(errno.EDEADLK, 'deadlock')):
            with self.subTest(error=error):
                stats = {}
                with data_io.scope(time.time() + 2, stats):
                    with patch.object(os, 'scandir', side_effect=error):
                        self.assertIsNone(data_io.dataless_files(self.data))
                    self.assertFalse(data_io.current_scope()['failed'])
                    cases.write_json(self.wd / 'saved.json', {'ok': True})
                self.assertIsNone(stats['dataless_files'])
                self.assertRegex(stats['dataless_error'], r'^\w+ (errno=\d+|reason=(deadline|edeadlk))$')
                self.assertTrue(json.loads((self.wd / 'saved.json').read_text())['ok'])

    def test_dataless_stat_failure_returns_unknown(self):
        stats = {}
        with data_io.scope(time.time() + 2, stats), \
                patch.object(os, 'stat', side_effect=PermissionError(errno.EACCES, 'private details')):
            self.assertIsNone(data_io.dataless_files(self.data))
        self.assertEqual(stats['dataless_error'], 'PermissionError errno=13')
        self.assertIsNone(stats['dataless_files'])

    def test_recursive_scan_failure_is_unknown_and_stalled_scan_is_bounded(self):
        nested = self.data / 'nested'
        nested.mkdir()
        real = os.scandir
        def scandir(path):
            if Path(path) == nested:
                raise PermissionError(errno.EACCES, 'private path')
            return real(path)
        stats = {}
        with data_io.scope(time.time() + 2, stats), patch.object(os, 'scandir', scandir):
            self.assertIsNone(data_io.dataless_files(self.data))
            self.assertFalse(data_io.current_scope()['failed'])
        self.assertEqual(stats['dataless_error'], 'PermissionError errno=13')
        def stalled(path):
            time.sleep(.12)
            return real(path)
        started = time.monotonic()
        with data_io.scope(time.time() + 2, stats), patch.object(os, 'scandir', stalled):
            self.assertIsNone(data_io.dataless_files(self.data))
            self.assertFalse(data_io.current_scope()['failed'])
            self.assertEqual(data_io.read_text(self.book), self.book.read_text())
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertEqual(stats['dataless_error'], 'DataUnavailable reason=deadline')

    def test_census_timeout_never_installs_or_rearms_an_alarm(self):
        original_handler = signal.getsignal(signal.SIGALRM)
        previous = signal.getitimer(signal.ITIMER_REAL)
        real_scan = os.scandir
        clock = [time.time()]
        stats = {}

        def slow_scan(path):
            clock[0] += .2
            return real_scan(path)

        def pending_at_arm(which, delay, interval=0):
            # Replay delivery before _within reaches its try/finally.
            if delay:
                signal.getsignal(signal.SIGALRM)(signal.SIGALRM, None)
            return (0., 0.)

        signal.setitimer(signal.ITIMER_REAL, 2)
        started = time.monotonic()
        try:
            with data_io.scope(clock[0] + 40, stats):
                with patch.object(os, 'scandir', slow_scan), \
                        patch.object(data_io.time, 'time', side_effect=lambda: clock[0]), \
                        patch.object(signal, 'setitimer', side_effect=pending_at_arm) as timer:
                    self.assertIsNone(data_io.dataless_files(self.data))
                self.assertIs(signal.getsignal(signal.SIGALRM), original_handler)
                timer.assert_not_called()
                remaining = signal.getitimer(signal.ITIMER_REAL)[0]
                self.assertAlmostEqual(remaining, 2 - (time.monotonic() - started), delta=.02)
                self.assertFalse(data_io.current_scope()['failed'])
                self.assertEqual(data_io.read_text(self.book), self.book.read_text())
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, original_handler)
            if previous[0]:
                signal.setitimer(signal.ITIMER_REAL, previous[0], previous[1])
        self.assertEqual(stats['dataless_error'], 'DataUnavailable reason=deadline')

    def test_census_stops_after_slow_stat_and_check_still_saves(self):
        real = os.stat
        clock = [time.time()]

        def slow_stat(path, **kwargs):
            if str(path) == str(self.book) and kwargs.get('follow_symlinks') is False:
                clock[0] += .2
            return real(path, **kwargs)

        with patch.object(os, 'stat', slow_stat), \
                patch.object(data_io.time, 'time', side_effect=lambda: clock[0]), \
                patch.dict(os.environ, {'MONEY_CASES_REFRESH_DISABLED': '1'}):
            cases.run_check(self.wd, 'slow-census', self.data,
                            now=cases.dt.datetime(2026, 11, 16, 2, tzinfo=cases.TZ),
                            find=lambda *a, **k: [], said=lambda *a, **k: [])
        row = json.loads((self.wd / 'runs.jsonl').read_text())
        timing = json.loads((self.wd / 'pings.json').read_text())['timing']
        for values in (row, timing):
            self.assertIsNone(values['dataless_files'])
            self.assertEqual(values['dataless_error'], 'DataUnavailable reason=deadline')
        self.assertEqual(row['exit'], 0)
        self.assertFalse(row.get('skipped'))
        self.assertFalse((self.wd / 'data-skips.json').exists())

    def test_directory_deadline_can_come_from_book_lock_without_a_census(self):
        with data_io.scope(time.time() - 1), \
                patch.object(os, 'scandir') as scan, self.assertRaises(data_io.DataUnavailable) as caught:
            with cases.Locked(self.data):
                self.fail('expired data scope entered a book lock')
        self.assertEqual(caught.exception.path, self.data)
        self.assertEqual(caught.exception.reason, 'deadline')
        scan.assert_not_called()

    def test_census_error_paths_leave_the_caller_alarm_untouched(self):
        forms = (InterruptedError(errno.EINTR, 'fixture'), OSError(errno.EDEADLK, 'fixture'),
                 PermissionError(errno.EACCES, 'fixture'), FileNotFoundError(errno.ENOENT, 'fixture'))
        for error in forms:
            with self.subTest(error=type(error).__name__), data_io.scope(time.time() + 40, {}), \
                    patch.object(os, 'scandir', side_effect=error), \
                    patch.object(signal, 'setitimer', side_effect=AssertionError('census touched alarm')), \
                    patch.object(signal, 'signal', side_effect=AssertionError('census changed handler')):
                result = data_io.dataless_files(self.data)
                self.assertEqual(result, 0 if isinstance(error, FileNotFoundError) else None)
                self.assertFalse(data_io.current_scope()['failed'])

    def test_census_never_replaces_an_external_timeout_after_its_deadline(self):
        for error in (cases.CheckTimeout('caller'), cases.charges.Lookup('caller'), OSError('caller'),
                      FileNotFoundError('caller'), data_io.DataUnavailable(self.book, 'deadline')):
            for overdue in (False, True):
                with self.subTest(error=type(error).__name__, overdue=overdue):
                    clock = [time.time()]
                    error._money_cases_timeout = True

                    def interrupted(_):
                        if overdue:
                            clock[0] += .2
                        raise error

                    with data_io.scope(clock[0] + 40, {}), \
                            patch.object(data_io.time, 'time', side_effect=lambda: clock[0]), \
                            patch.object(os, 'scandir', interrupted), \
                            self.assertRaises(type(error)) as caught:
                        data_io.dataless_files(self.data)
                    self.assertIs(caught.exception, error)

    def test_skip_bookkeeping_outcomes_match_the_single_history_row(self):
        original = data_io.DataUnavailable(self.book, 'deadline')
        again = data_io.DataUnavailable(self.wd / 'data-skips.json', 'deadline')
        forms = (
            ('retry_quiet', [again, 0], 0, None),
            ('retry_backstop', [again, 1], 1, None),
            ('retry_fails', [again, again], 1, data_io.DataUnavailable),
            ('os_error', [OSError('fixture')], 1, OSError),
            ('case_error', [cases.CaseError('fixture')], 2, None),
            ('lookup_error', [cases.charges.Lookup('fixture')], 4, None),
        )
        for index, (name, outcomes, expected, raised) in enumerate(forms, 1):
            with self.subTest(name=name), \
                    patch.object(cases, 'check_command', side_effect=original), \
                    patch.object(cases, 'record_data_skip', side_effect=outcomes) as bookkeeping, \
                    patch.dict(os.environ, {'WATCH_DIR': str(self.wd)}), \
                    patch.object(cases.faulthandler, 'enable'), patch.object(cases.faulthandler, 'dump_traceback_later'), \
                    redirect_stderr(io.StringIO()):
                if raised:
                    with self.assertRaises(raised):
                        cases.main(['check'])
                else:
                    self.assertEqual(cases.main(['check']), expected)
                self.assertEqual(bookkeeping.call_count, len(outcomes))
            rows = [json.loads(line) for line in (self.wd / 'runs.jsonl').read_text().splitlines()]
            self.assertEqual(len(rows), index)
            self.assertTrue(rows[-1]['skipped'])
            self.assertEqual(rows[-1]['skip_file'], 'cases.json')
            self.assertEqual(rows[-1]['skip_reason'], 'deadline')
            self.assertEqual(rows[-1]['exit'], expected)

    def test_skip_state_failure_keeps_original_skip_in_history(self):
        error = data_io.DataUnavailable(self.book, 'deadline')
        with patch.object(cases, 'check_command', side_effect=error), \
                patch.object(cases, 'record_data_skip', side_effect=OSError('fixture state failure')), \
                patch.dict(os.environ, {'WATCH_DIR': str(self.wd)}), \
                patch.object(cases.faulthandler, 'enable'), patch.object(cases.faulthandler, 'dump_traceback_later'), \
                redirect_stderr(io.StringIO()), self.assertRaises(OSError):
            cases.main(['check'])
        row = json.loads((self.wd / 'runs.jsonl').read_text())
        self.assertTrue(row['skipped'])
        self.assertEqual(row['skip_file'], 'cases.json')
        self.assertEqual(row['skip_reason'], 'deadline')
        self.assertEqual(row['skip_phase'], 'loads')
        self.assertEqual(row['exit'], 1)

    def test_check_saves_normally_when_scandir_is_interrupted(self):
        with patch.object(os, 'scandir', side_effect=InterruptedError(errno.EINTR, 'interrupted')), \
                patch.dict(os.environ, {'MONEY_CASES_REFRESH_DISABLED': '1'}):
            cases.run_check(self.wd, 'r', self.data, now=cases.dt.datetime(2026, 11, 16, 2, tzinfo=cases.TZ),
                            find=lambda *a, **k: [], said=lambda *a, **k: [])
        timing = json.loads((self.wd / 'pings.json').read_text())['timing']
        row = json.loads((self.wd / 'runs.jsonl').read_text())
        for values in (timing, row):
            self.assertIsNone(values['dataless_files'])
            self.assertEqual(values['dataless_error'], 'InterruptedError errno=4')
            self.assertEqual(values['eintr_retries'], 3)
            self.assertEqual(values['edeadlk_skips_before'], 0)
        self.assertEqual(row['exit'], 0)
        self.assertFalse(row.get('skipped'))
        self.assertFalse((self.wd / 'data-skips.json').exists())

    def test_check_saves_normally_when_entry_stat_is_denied(self):
        real = os.stat
        def stat(path, **kwargs):
            if str(path) == str(self.book) and kwargs.get('follow_symlinks') is False:
                raise PermissionError(errno.EACCES, 'private path')
            return real(path, **kwargs)
        with patch.object(os, 'stat', stat), patch.dict(os.environ, {'MONEY_CASES_REFRESH_DISABLED': '1'}):
            cases.run_check(self.wd, 'r', self.data, now=cases.dt.datetime(2026, 11, 16, 2, tzinfo=cases.TZ),
                            find=lambda *a, **k: [], said=lambda *a, **k: [])
        timing = json.loads((self.wd / 'pings.json').read_text())['timing']
        row = json.loads((self.wd / 'runs.jsonl').read_text())
        for values in (timing, row):
            self.assertIsNone(values['dataless_files'])
            self.assertEqual(values['dataless_error'], 'PermissionError errno=13')
        self.assertEqual(row['exit'], 0)
        self.assertFalse(row.get('skipped'))
        self.assertFalse((self.wd / 'data-skips.json').exists())

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
        self.assertEqual(err.getvalue(), 'money-cases: data file unavailable (edeadlk): cases.json\n')
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertFalse((self.data / 'questions.json').exists())
        self.assertFalse((self.data / 'data-skips.json').exists())
        state = json.loads((self.wd / 'data-skips.json').read_text())
        self.assertEqual(state['last_file'], 'cases.json')
        self.assertEqual(state['last_reason'], 'edeadlk')
        self.assertIn('edeadlk_ms', state)
        row = json.loads((self.wd / 'runs.jsonl').read_text().splitlines()[-1])
        self.assertTrue(row['skipped'])
        self.assertEqual(row['skip_file'], 'cases.json')
        self.assertEqual(row['skip_reason'], 'edeadlk')
        self.assertEqual(row['skip_phase'], 'loads')
        self.assertEqual(row['exit'], rc)
        for key in ('edeadlk_retries', 'edeadlk_ms'):
            self.assertIn(key, row)
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
        state.write_text('{"skip_streak": 4, "last_file": "questions.json", "last_reason": "deadline", "first_skip_at": 42}')
        with patch.dict(os.environ, {'MONEY_CASES_REFRESH_DISABLED': '1'}):
            cases.run_check(self.wd, 'r', self.data, now=cases.dt.datetime(2026, 11, 16, 2, tzinfo=cases.TZ),
                            find=lambda *a, **k: [], said=lambda *a, **k: [])
        self.assertFalse(state.exists())
        timing = json.loads((self.wd / 'pings.json').read_text())['timing']
        row = json.loads((self.wd / 'runs.jsonl').read_text())
        for values in (timing, row):
            self.assertEqual(values['edeadlk_skips_before'], 4)
            self.assertEqual(values['skip_last_file'], 'questions.json')
            self.assertEqual(values['skip_last_reason'], 'deadline')
            self.assertEqual(values['skip_first_at'], 42)

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
        self.assertIn('data file unavailable (deadline): cases.json', err.getvalue())
        self.assertFalse((self.wd / 'pings.json').exists())
        state = json.loads((self.wd / 'data-skips.json').read_text())
        self.assertEqual(state['skip_streak'], 1)
        self.assertEqual(state['last_reason'], 'deadline')
        row = json.loads((self.wd / 'runs.jsonl').read_text())
        self.assertEqual(row['exit'], 0)
        self.assertTrue(row['skipped'])
        self.assertEqual(row['skip_reason'], 'deadline')

    def test_skip_in_follow_records_actual_phase_and_recovery(self):
        with patch.object(cases, 'reconcile_merchants', side_effect=data_io.DataUnavailable(self.book)), \
                patch.object(cases, 'DATA', self.data), patch.object(cases, 'LIVE', self.wd), \
                patch.dict(os.environ, {'WATCH_DIR': str(self.wd), 'MONEY_CASES_REFRESH_DISABLED': '1'}), \
                patch.object(cases.faulthandler, 'enable'), patch.object(cases.faulthandler, 'dump_traceback_later'), \
                redirect_stderr(io.StringIO()), redirect_stdout(io.StringIO()):
            self.assertEqual(cases.main(['check']), 0)
        first = json.loads((self.wd / 'data-skips.json').read_text())['first_skip_at']
        with patch.dict(os.environ, {'MONEY_CASES_REFRESH_DISABLED': '1'}):
            cases.run_check(self.wd, 'r', self.data, now=cases.dt.datetime(2026, 11, 16, 2, tzinfo=cases.TZ),
                            find=lambda *a, **k: [], said=lambda *a, **k: [])
        rows = [json.loads(line) for line in (self.wd / 'runs.jsonl').read_text().splitlines()]
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['skip_phase'], 'follow')
        self.assertEqual(rows[0]['skip_file'], 'cases.json')
        self.assertTrue(rows[0]['skipped'])
        self.assertEqual(rows[1]['skip_last_file'], 'cases.json')
        self.assertEqual(rows[1]['skip_last_reason'], 'edeadlk')
        self.assertEqual(rows[1]['skip_first_at'], first)
        self.assertFalse((self.wd / 'data-skips.json').exists())

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
