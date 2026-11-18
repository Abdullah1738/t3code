"""Offline file-provider faults, shared run budget and metadata readback."""
import os

# Before any helper loads: the send guards refuse live sends under this marker, and conftest.py sets it for pytest only.
os.environ.setdefault("ROBOB_TEST", "1")
import contextlib
import errno
import json
from pathlib import Path
import tempfile
import threading
import types
import unittest
from unittest.mock import Mock, patch

import test_logging as logging_fixtures
from test_triage import t

io = t.expected_auth


class Clock:
    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class DataRetryTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.path = self.root / 'noise.json'
        self.logs = self.root / 'logs'
        self.stack.enter_context(patch.dict(os.environ, {'ROBOB_TEST': '1', 'TOOLLOG_DIR': str(self.logs),
                                                        'WATCH_ID': 'inbox-triage-fastpath', 'WATCH_RUN': 'fixture'}))
        self.clock = Clock()
        self.stack.enter_context(patch.object(io.time, 'monotonic', side_effect=lambda: self.clock.now))
        self.stack.enter_context(patch.object(io.time, 'sleep', side_effect=self.clock.sleep))
        io.reset_retry_budget()

    def rows(self, name):
        return [row for path in self.logs.glob('*.ndjson') for line in path.read_text().splitlines()
                if (row := json.loads(line))['name'] == name]

    def test_read_recovers_after_two_failures_for_every_transient_errno(self):
        for code in io.TRANSIENT_ERRNOS:
            io.reset_retry_budget()
            with self.subTest(errno=code), patch.object(Path, 'read_bytes', side_effect=[
                    OSError(code, 'private body'), OSError(code, 'private body'), b'{"rules":[]}']) as read, \
                    patch.object(io, 'is_dataless', return_value=True):
                self.assertEqual(t.read_json(self.path), {'rules': []})
                self.assertEqual(read.call_count, 3)
        rows = self.rows('data_read.retried')
        self.assertEqual(len(rows), len(io.TRANSIENT_ERRNOS))
        self.assertEqual({r['props']['errnoCode'] for r in rows}, set(io.TRANSIENT_ERRNOS.values()))
        for row in rows:
            self.assertEqual(row['props']['path'], str(self.path))
            self.assertEqual(row['props']['attempts'], 3)
            self.assertEqual(row['props']['ms'], 750)
            self.assertTrue(row['props']['dataless'])
            self.assertEqual(row['ids']['watcher'], 'inbox-triage-fastpath')
        self.assertNotIn('private body', json.dumps(rows))

    def test_exhausted_attempts_raise_short_error_with_path_errno_and_dataless(self):
        for dataless in (False, True):
            io.reset_retry_budget()
            with self.subTest(dataless=dataless), patch.object(Path, 'read_bytes', side_effect=OSError(errno.EDEADLK, 'private')) as read, \
                    patch.object(io, 'is_dataless', return_value=dataless):
                with self.assertRaises(OSError) as caught:
                    t.read_json(self.path)
                self.assertEqual(read.call_count, 4)
                self.assertEqual(caught.exception.errno, errno.EDEADLK)
                message = str(caught.exception)
                for value in (str(self.path), 'EDEADLK', 'attempts=4', f'dataless={str(dataless).lower()}'):
                    self.assertIn(value, message)
                self.assertLess(len(message), 200)
        self.assertEqual(len(self.rows('data_read.failed')), 2)
        self.assertEqual(self.rows('data_read.retried'), [])

    def test_errno_names_are_stable_across_platform_aliases(self):
        for code, alias, expected in ((errno.EDEADLK, 'EDEADLOCK', 'EDEADLK'),
                                      (errno.EAGAIN, 'EWOULDBLOCK', 'EAGAIN')):
            with self.subTest(alias=alias), patch.dict(errno.errorcode, {code: alias}):
                self.assertEqual(io.errno_name(code), expected)

    def test_permanent_errors_are_not_retried(self):
        for code in (errno.EACCES, errno.EIO, errno.ENOSPC):
            with self.subTest(errno=code), patch.object(Path, 'read_bytes', side_effect=OSError(code, 'private')) as read:
                with self.assertRaises(OSError) as caught:
                    t.read_json(self.path)
                self.assertEqual(read.call_count, 1)
                self.assertIn(errno.errorcode[code], str(caught.exception))
        self.assertEqual(self.clock.sleeps, [])
        self.assertEqual(len(self.rows('data_read.failed')), 3)

    def test_missing_json_still_returns_independent_default(self):
        default = {'rules': []}
        result = t.read_json(self.path, default)
        result['rules'].append('fixture')
        self.assertEqual(default, {'rules': []})
        self.assertIsNone(t.read_json(self.path))
        self.assertEqual(self.clock.sleeps, [])
        self.assertEqual(self.rows('data_read.failed'), [])

    def test_dataless_stat_handles_macos_linux_and_stat_failure(self):
        for flags, expected in ((0x40000000, True), (0x20, False), (0x40000020, True)):
            with patch.object(io.os, 'stat', return_value=types.SimpleNamespace(st_flags=flags)):
                self.assertIs(io.is_dataless(self.path), expected)
        with patch.object(io.os, 'stat', return_value=types.SimpleNamespace()):
            self.assertFalse(io.is_dataless(self.path))
        with patch.object(io.os, 'stat', side_effect=OSError(errno.EACCES, 'private')):
            self.assertFalse(io.is_dataless(self.path))

    def test_atomic_retries_write_and_replace_without_partial_json(self):
        original = io.os.replace
        calls = []
        def replace(source, target):
            calls.append(target)
            if len(calls) < 3:
                raise OSError(errno.EAGAIN, 'private')
            original(source, target)
        with patch.object(io.os, 'replace', side_effect=replace):
            t.atomic(self.path, {'private': 'payload'})
        self.assertEqual(json.loads(self.path.read_bytes()), {'private': 'payload'})
        row, = self.rows('data_write.retried')
        self.assertEqual(row['props']['attempts'], 3)
        self.assertNotIn('payload', json.dumps(row))

    def test_runs_append_recovers_after_open_and_partial_append_failure(self):
        original_open = Path.open
        wd = self.root / 'watcher'
        path = wd / 'diagnostics/runs.jsonl'
        path.parent.mkdir(parents=True)
        path.write_text('{"previous":true}\n')
        attempts = []
        @contextlib.contextmanager
        def faulty_open(target, *args, **kwargs):
            attempts.append(target)
            if len(attempts) == 1:
                raise OSError(errno.EDEADLK, 'private')
            with original_open(target, *args, **kwargs) as stream:
                yield stream
                if len(attempts) == 2:
                    raise OSError(errno.EINTR, 'private')
        with patch.object(Path, 'open', faulty_open):
            t.log_run(wd, {'classified': True})
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        self.assertEqual(len(attempts), 3)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0], {'previous': True})
        self.assertTrue(rows[1]['classified'])

    def test_failed_runs_append_does_not_fail_classified_run(self):
        fixture = logging_fixtures.TriageLoggingTests()
        self.addCleanup(fixture.doCleanups)
        fixture.setUp()
        original_open = Path.open
        attempts = []
        def faulty_open(target, *args, **kwargs):
            if target.name == 'runs.jsonl':
                attempts.append(target)
                raise OSError(errno.ETIMEDOUT, 'private body')
            return original_open(target, *args, **kwargs)
        with patch.object(Path, 'open', faulty_open):
            state = fixture.run_batch([fixture.item()])
        self.assertEqual(state['queue'], [])
        self.assertEqual(len(attempts), 4)
        row, = fixture.rows('runs_log.write_failed')
        self.assertEqual(row['props']['errnoCode'], 'ETIMEDOUT')
        self.assertEqual(row['props']['attempts'], 4)
        self.assertNotIn('private body', json.dumps(row))

    def test_whole_run_shared_budget_includes_blocking_reads_and_writes(self):
        names = ('settings.json', 'noise.json', 'prefs.md', 'activity-log.md', 'inflight-actions.json', 'runs.jsonl')
        attempts = {}
        def stalled(name):
            attempts[name] = attempts.get(name, 0) + 1
            self.clock.now += 3.0
            raise OSError(errno.EDEADLK, 'materialising')
        for name in names:
            with self.assertRaises(OSError):
                io.retry_file(self.root / name, lambda: stalled(name),
                              event='data_write' if name == 'runs.jsonl' else 'data_read')
        self.assertEqual(attempts[names[0]], 2)
        self.assertTrue(all(attempts[name] == 1 for name in names[1:]))
        # Six unavoidable initial reads at 3 s each + one in-flight retry and its sleep.
        self.assertAlmostEqual(self.clock.now, 21.25)
        self.assertLess(self.clock.now, 38)
        self.assertLess(sum(self.clock.sleeps), io.RETRY_BUDGET_SECONDS)
        source = Path(t.__file__).read_text()
        self.assertIn('end = min(now + 38,', source)

    def test_instant_failures_and_write_retries_share_six_seconds_across_files(self):
        for n in range(10):
            with self.assertRaises(OSError):
                io.retry_file(self.root / str(n), Mock(side_effect=OSError(errno.EAGAIN, 'private')),
                              event='data_read' if n % 2 else 'data_write')
        self.assertLessEqual(self.clock.now, io.RETRY_BUDGET_SECONDS)
        self.assertEqual(self.rows('data_read.failed')[-1]['props']['attempts'], 1)
        self.assertEqual(self.rows('data_write.failed')[-1]['props']['attempts'], 1)

    def test_still_blocked_collector_is_counted_before_another_read_retries(self):
        started, release = threading.Event(), threading.Event()
        errors = []
        def blocked():
            started.set()
            if not release.wait(5):
                raise AssertionError('test did not release blocked collector')
            raise OSError(errno.EDEADLK, 'private')
        def collect():
            try:
                io.retry_file(self.root / 'settings.json', blocked)
            except OSError as error:
                errors.append(error)
        worker = threading.Thread(target=collect)
        worker.start()
        try:
            self.assertTrue(started.wait(5))
            def other_read():
                self.clock.now += 4
                raise OSError(errno.EDEADLK, 'private')
            read = Mock(side_effect=other_read)
            with self.assertRaises(OSError):
                io.retry_file(self.path, read)
            self.assertEqual(read.call_count, 1)
            self.assertEqual(self.clock.sleeps, [])
        finally:
            release.set()
            worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertEqual(io._active_waits, {})

    def test_run_budget_resets_only_at_run_entry(self):
        with io.account_wait():
            self.clock.now += 6
        self.assertFalse(io.backoff(0.25))
        io.reset_retry_budget()
        self.assertTrue(io.backoff(0.25))

    def test_auth_evidence_read_and_atomic_write_share_retry_helper(self):
        path = self.root / 'inflight-actions.json'
        path.write_text('[]')
        original_read, original_replace = Path.read_bytes, io.os.replace
        reads, writes = [], []
        def read(target):
            reads.append(target)
            if len(reads) < 3:
                raise OSError(errno.EDEADLK, 'private')
            return original_read(target)
        def replace(source, target):
            writes.append(target)
            if len(writes) < 3:
                raise OSError(errno.EAGAIN, 'private')
            original_replace(source, target)
        with patch.object(Path, 'read_bytes', read), patch.object(io.os, 'replace', side_effect=replace):
            io.record(('fixture@example.invalid',), data=self.root)
        self.assertEqual(len(json.loads(path.read_text())), 1)
        self.assertEqual((len(reads), len(writes)), (3, 3))
        self.assertEqual(len(self.rows('data_read.retried')), 1)
        self.assertEqual(len(self.rows('data_write.retried')), 1)

    def test_activity_log_keeps_tolerant_utf8_decode(self):
        assistant = self.root / 'Documents/assistant'
        assistant.mkdir(parents=True)
        (assistant / 'activity-log.md').write_bytes(b'2099-01-01 activity \xff\n')
        (self.root / 'prefs.md').write_text('preferences')
        with patch.object(t, 'HOME', self.root), patch.object(t, 'DATA', self.root), \
                patch.object(t, 'live_work', return_value={}), patch.object(t, 'open_money_questions', return_value=[]):
            result = t.build_context([], [], t.time.time())
        self.assertIn('activity \ufffd', result['recent_activity_newest_first'])

    def test_optional_icloud_callers_read_without_stat_precheck_and_retry(self):
        assistant = self.root / 'Documents/assistant'
        assistant.mkdir(parents=True)
        activity = assistant / 'activity-log.md'
        activity.write_text('2099-01-01 activity')
        (self.root / 'prefs.md').write_text('preferences')
        books = assistant / 'money-cases'
        books.mkdir()
        (books / 'cases.json').write_text('{"cases":[]}')
        original_read, original_stat = Path.read_bytes, Path.stat
        targets = (activity, books / 'cases.json')
        attempts = {path: 0 for path in targets}
        def read(target):
            if target in targets:
                attempts[target] += 1
                if attempts[target] < 3:
                    raise OSError(errno.EDEADLK, 'materialising')
            return original_read(target)
        def stat(target, *args, **kwargs):
            if target in targets:
                raise OSError(errno.EDEADLK, 'stat precheck must not run')
            return original_stat(target, *args, **kwargs)
        with patch.object(Path, 'read_bytes', read), patch.object(Path, 'stat', stat), \
                patch.object(t, 'HOME', self.root), patch.object(t, 'DATA', self.root), \
                patch.object(t, 'live_work', return_value={}), patch.object(t, 'open_money_questions', return_value=[]):
            context = t.build_context([], [], t.time.time())
            copied = t.money_books(self.root / 'watcher', types.SimpleNamespace(DATA=books))
        self.assertIn('activity', context['recent_activity_newest_first'])
        self.assertEqual(json.loads((copied / 'cases.json').read_text()), {'cases': []})
        self.assertFalse((copied / 'questions.json').exists())
        self.assertEqual(list(attempts.values()), [3, 3])
        self.assertEqual(len(self.rows('data_read.retried')), 2)

    def test_missing_activity_log_keeps_context_usable(self):
        (self.root / 'prefs.md').write_text('preferences')
        with patch.object(t, 'HOME', self.root), patch.object(t, 'DATA', self.root), \
                patch.object(t, 'live_work', return_value={}), patch.object(t, 'open_money_questions', return_value=[]):
            result = t.build_context([], [], t.time.time())
        self.assertEqual(result['recent_activity_newest_first'], '')


if __name__ == '__main__':
    unittest.main()
