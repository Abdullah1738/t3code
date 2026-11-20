"""History uses disposable watcher dirs, never live case books."""
import os

# Before any helper loads: the send guards refuse live sends under this marker, and conftest.py sets it for pytest only.
os.environ.setdefault("ROBOB_TEST", "1")
from contextlib import redirect_stdout
import datetime as dt
import fcntl
import io
import json
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

import run_history as history
from test_cases import Base, at, finder, nobody, mc as cases


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.wd = Path(self.tmp.name)
        self.path = self.wd / 'runs.jsonl'
        self.row = {'at': '2026-11-16T10:00:00Z', 'exit': 0, 'total_s': 22, 'slowest': 'follow',
                    'owner_result': 'incomplete', 'owner_timeouts': 2, 'owner_threads_fetched': 3,
                    'owner_list_ms': 123, 'lookups': 5, 'writes_n': 3,
                    'question_errors': ['his threads: Robob control: request failed or timed out']}

    def test_append_retains_counts_and_bounded_safe_errors(self):
        self.row.update(question_errors=self.row['question_errors'] * 12, text='private owner message',
                        password='test-secret', secret_detail={'text': 'private receipt'})
        self.assertTrue(history.append(self.wd, self.row))
        row = json.loads(self.path.read_text())
        for key in ('at', 'exit', 'total_s', 'slowest', 'owner_result', 'owner_timeouts',
                    'owner_threads_fetched', 'owner_list_ms', 'lookups', 'writes_n'):
            self.assertEqual(row[key], self.row[key])
        self.assertEqual(len(row['question_errors']), 10)
        self.assertTrue(all(len(e) <= 300 for e in row['question_errors']))
        self.assertNotIn('private', self.path.read_text())
        self.assertNotIn('test-secret', self.path.read_text())
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_summary_reports_snapshot_age_and_last_refresh(self):
        self.row['marketplace_refresh'] = {'status': 'started', 'snapshot_age_s': 7200,
                                          'last_result': 'list_error', 'last_at': '2026-11-16T09:00:00Z',
                                          'order': 'private'}
        self.assertTrue(history.append(self.wd, self.row))
        result = history.summary(self.wd, now=dt.datetime(2026, 11, 16, 11, tzinfo=dt.timezone.utc))
        self.assertEqual(result['marketplace_refresh']['snapshot_age_s'], 7200)
        self.assertIn('marketplace snapshot age: 7200 s; last refresh: list_error', history.format_summary(result))
        self.assertNotIn('private', self.path.read_text())

    def test_untrusted_errors_never_retain_messages_or_secrets(self):
        for text in ('msgs exit 1: I paid Acme, password: test-secret',
                     'refund mail private-case: 4111 1111 1111 1111 OTP 123456',
                     'his threads: Robob control: request failed or timed out\nI paid Acme', 'private ' * 1000):
            self.row['question_errors'] = [text]
            self.assertTrue(history.append(self.wd, self.row))
        for text in ('I paid', 'test-secret', '4111', '123456', 'private'):
            self.assertNotIn(text, self.path.read_text())

    def test_skip_metadata_projection_is_bounded_and_idempotent(self):
        values = {**self.row, 'skipped': True, 'skip_file': 'questions.json', 'skip_reason': 'deadline',
                  'skip_phase': 'loads', 'skip_last_file': 'cases.json', 'skip_last_reason': 'edeadlk',
                  'skip_first_at': 42.5, 'dataless_files': None, 'dataless_error': 'DataUnavailable errno=None'}
        row = history.run_row(values)
        self.assertEqual(history.run_row(row), row)
        for key in values:
            self.assertEqual(row[key], values[key])
        for key in ('skip_file', 'skip_last_file', 'skip_reason', 'skip_last_reason', 'dataless_error'):
            with self.subTest(key=key):
                row = history.run_row({**self.row, key: '/private/source text'})
                self.assertNotIn(key, row)

    def test_case_error_normalization(self):
        timeout = str(subprocess.TimeoutExpired(
            ['/Users/ardud/.local/bin/msgs', 'search', '("Logic Utilities" OR "Acme Merchant")'], 2))
        numeric_timeout = str(subprocess.TimeoutExpired(
            ['/Users/ardud/.local/bin/msgs', 'search', '"4111111111111111" OR "Acme Merchant"'], 0.5))
        forms = [
            ('refund mail logic-utilities-nov: msgs: ' + timeout, 'refund mail: msgs: timed out'),
            ('msgs: ' + timeout, 'msgs: timed out'),
            ('refund mail some-case: out of time', 'refund mail: out of time'),
            ('receipt abc-1: out of time', 'receipt: out of time'),
            ('merchant history some-case: out of time', 'merchant history: out of time'),
            ('refund mail x: hello <body text>', 'unclassified error (details omitted)'),
            ('refund mail x: msgs: ' + numeric_timeout, 'refund mail: msgs: timed out'),
            ('msgs: ' + numeric_timeout, 'msgs: timed out'),
            ('q-ab12: receipt abc-1: out of time', 'receipt: out of time'),
            ('receipt 0: out of time', 'receipt: out of time'),
            ('refund mail ' + 'a' * 81 + ': out of time', 'refund mail: out of time'),
            ('refund mail: out of time; the rest next check', 'refund mail: out of time; the rest next check'),
            ('msgs: unreadable search output', 'msgs: unreadable search output'),
        ]
        forms += [(prefix + 'msgs: ' + timeout, prefix + 'msgs: timed out') for prefix in (
            'refund mail: ', 'receipt: ', 'merchant history: ', 'his threads: ', 'orders: ',
            'noon orders: ', 'careem orders: ', 'his threads: receipt: ')]
        for raw, expected in forms:
            with self.subTest(raw=raw):
                self.assertEqual(history.safe_error(raw), expected)
                self.assertEqual(history.safe_error(expected), expected)
                self.row['question_errors'] = [raw]
                self.assertTrue(history.append(self.wd, self.row))
        rows = [json.loads(line) for line in self.path.read_text().splitlines()]
        self.assertEqual([row['question_errors'] for row in rows], [[expected] for _, expected in forms])
        for private in ('Logic Utilities', 'Acme Merchant', '4111111111111111', 'body text', '/Users/',
                        'logic-utilities-nov', 'some-case', 'abc-1'):
            self.assertNotIn(private, self.path.read_text())

    def test_case_error_normalization_rejects_unknown_shapes(self):
        timeout = "msgs: Command '['msgs', 'search', 'private query']' timed out after 2 seconds"
        forms = [
            'refund mail Upper: out of time',
            'receipt under_score: out of time',
            'merchant history -leading: out of time',
            'refund mail ' + 'a' * 82 + ': out of time',
            'refund mail : out of time',
            'refund mail x:out of time',
            'unknown x: out of time',
            'receipt x: private message',
            'merchant history x: private message',
            'refund mail x: out of time\nprivate message',
            timeout + ' private message',
            'private message ' + timeout,
            'unknown: ' + timeout,
            "msgs: Command 'private message' timed out after 2 seconds",
        ]
        for raw in forms:
            with self.subTest(raw=raw):
                self.assertEqual(history.safe_error(raw), 'unclassified error (details omitted)')

    def test_summary_groups_normalized_case_errors(self):
        timeout = "msgs: Command '['msgs', 'search', 'private query']' timed out after 2 seconds"
        self.row['question_errors'] = ['refund mail first-case: ' + timeout,
                                       'refund mail second-case: ' + timeout,
                                       'refund mail first-case: out of time',
                                       'refund mail second-case: out of time']
        self.assertTrue(history.append(self.wd, self.row))
        now = dt.datetime(2026, 11, 16, 12, tzinfo=dt.timezone.utc)
        result = history.summary(self.wd, now=now)
        self.assertEqual(result['question_errors'], {'refund mail: msgs: timed out': 2,
                                                    'refund mail: out of time': 2})
        text = history.format_summary(result)
        self.assertIn('2x refund mail: msgs: timed out', text)
        self.assertIn('2x refund mail: out of time', text)

    def test_rotation_at_boundary_keeps_one_previous_file(self):
        size = len((json.dumps({**history.run_row(self.row), 'history_append_errors': history.APPEND_ERRORS},
                              ensure_ascii=True, separators=(',', ':')) + '\n').encode())
        self.path.write_bytes(b'x' * (history.MAX_BYTES - size - 1) + b'\n')
        previous = self.wd / 'runs.jsonl.1'
        previous.write_text('older generation')
        self.assertTrue(history.append(self.wd, self.row))
        self.assertEqual(self.path.stat().st_size, history.MAX_BYTES)
        self.assertEqual(previous.read_text(), 'older generation')
        self.assertTrue(history.append(self.wd, self.row))
        self.assertEqual(previous.stat().st_size, history.MAX_BYTES)
        self.assertEqual(json.loads(self.path.read_text())['total_s'], 22)
        self.assertEqual(sorted(p.name for p in self.wd.iterdir()), ['runs.jsonl', 'runs.jsonl.1', 'runs.lock'])

    def test_append_and_rotation_failures_are_counted(self):
        for operation in ('open', 'write', 'replace'):
            with self.subTest(operation=operation):
                self.path.write_bytes(b'x' * (history.MAX_BYTES - 1) + b'\n')
                before = history.APPEND_ERRORS
                with patch.object(history.os, operation, side_effect=OSError('private error')):
                    self.assertFalse(history.append(self.wd, self.row))
                self.assertEqual(history.APPEND_ERRORS, before + 1)
                self.assertEqual(self.row['history_append_errors'], before + 1)
        self.assertTrue(history.append(self.wd, self.row))
        self.assertEqual(json.loads(self.path.read_text())['history_append_errors'], history.APPEND_ERRORS)

    def test_slow_append_is_interrupted_and_prior_timer_survives(self):
        with patch.object(history.os, 'write', side_effect=lambda *_: time.sleep(1)):
            started = time.monotonic()
            self.assertFalse(history.append(self.wd, self.row))
            self.assertLess(time.monotonic() - started, .2)
        signal.setitimer(signal.ITIMER_REAL, 1)
        try:
            self.assertTrue(history.append(self.wd, self.row))
            self.assertGreater(signal.getitimer(signal.ITIMER_REAL)[0], .5)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)

    def test_symlink_not_followed(self):
        target = self.wd / 'book'
        target.write_text('preserve')
        self.path.symlink_to(target)
        self.assertFalse(history.append(self.wd, self.row))
        self.assertEqual(target.read_text(), 'preserve')

    def test_summary_fixture_and_cli(self):
        lines = Path(__file__).with_name('test_runs.fixture.jsonl').read_text().splitlines(keepends=True)
        (self.wd / 'runs.jsonl.1').write_text(''.join(lines[:3]))
        self.path.write_text(''.join(lines[3:]) + '{partial\n')
        now = dt.datetime(2026, 11, 16, 12, tzinfo=dt.timezone.utc)
        result = history.summary(self.wd, '24h', now)
        self.assertEqual(result['run_count'], 4)
        self.assertEqual(result['over_40_count'], 2)
        self.assertEqual(result['total_s'], {'p50': 45, 'p95': 75.5, 'max': 80})
        self.assertEqual([r['slowest'] for r in result['slow_runs']], ['follow', 'build_write'])
        self.assertEqual(result['owner_results'], {'ok': 2, 'incomplete': 1, 'list_failed': 1})
        self.assertEqual(result['question_errors'], {'his threads: Robob control: request failed or timed out': 2,
                                                    'Robob control: invalid response': 1})
        self.assertEqual(result['invalid_lines'], 1)
        with patch.dict(os.environ, {'WATCH_DIR': str(self.wd)}), \
                patch.object(history, 'summary', return_value=result) as summary, redirect_stdout(io.StringIO()) as out:
            self.assertEqual(cases.main(['runs', '--since', '24h', '--json']), 0)
            self.assertEqual(json.loads(out.getvalue()), result)
            summary.assert_called_once_with(self.wd, '24h')
        text = history.format_summary(result)
        self.assertIn('over 40 s: 2', text)
        self.assertIn('2x his threads: Robob control', text)
        self.assertIn('slowest=build_write', text)

    def test_nonblocking_lock_prevents_interleaved_rotation(self):
        self.path.write_bytes(b'x' * (history.MAX_BYTES - 1) + b'\n')
        replace = history.os.replace
        nested = []

        def interleave(*args):
            nested.append(history.append(self.wd, self.row.copy()))
            return replace(*args)

        with patch.object(history.os, 'replace', side_effect=interleave):
            self.assertTrue(history.append(self.wd, self.row))
        self.assertEqual(nested, [False])
        self.assertEqual((self.wd / 'runs.jsonl.1').stat().st_size, history.MAX_BYTES)
        self.assertEqual(json.loads(self.path.read_text())['total_s'], 22)
        # A stable lock inode is retained and reusable after rotation.
        with (self.wd / 'runs.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertFalse(history.append(self.wd, self.row))
            with self.assertRaises(BlockingIOError):
                history.summary(self.wd)
        self.assertTrue(history.append(self.wd, self.row))

    def test_short_writes_and_interrupted_tails_keep_the_next_run(self):
        write = history.os.write
        # Tail forms: no prior row, a previous complete row, a killed append.
        for prefix, interrupt in ((b'', False), (b'{"prior":true}\n', False), (b'', True)):
            with self.subTest(prefix=prefix, interrupt=interrupt):
                self.path.write_bytes(prefix)

                def partial(fd, payload):
                    if fd == 2:
                        return write(fd, payload)
                    n = write(fd, payload[:15])
                    if interrupt:
                        raise history.AppendTimeout('interrupted')
                    return n

                with patch.object(history.os, 'write', side_effect=partial):
                    self.assertFalse(history.append(self.wd, self.row))
                self.assertTrue(history.append(self.wd, self.row))
                rows = [json.loads(line) for line in self.path.read_text().splitlines()]
                self.assertEqual(rows[-1]['total_s'], 22)
                self.assertEqual(len(rows), 2 if prefix else 1)

    def test_caller_timer_race_propagates_its_exception(self):
        # The initial guard sees a later caller deadline, but within() sees it
        # earlier after scheduling delay. Both caller timeout classes must escape.
        for error in (cases.CheckTimeout('caller'), cases.charges.Lookup('caller')):
            with self.subTest(error=type(error).__name__):
                def expired(*_):
                    error._money_cases_timeout = True
                    raise error

                previous = signal.getsignal(signal.SIGALRM)
                signal.signal(signal.SIGALRM, expired)
                signal.setitimer(signal.ITIMER_REAL, .01)
                try:
                    with patch.object(history.signal, 'getitimer', side_effect=[(.1, 0), (.005, 0)]), \
                            patch.object(history.os, 'open', side_effect=lambda *_: time.sleep(.1)):
                        with self.assertRaises(type(error)):
                            history.append(self.wd, self.row)
                finally:
                    signal.setitimer(signal.ITIMER_REAL, 0)
                    signal.signal(signal.SIGALRM, previous)

    def test_error_projection_is_idempotent_for_the_whole_error_class(self):
        forms = [
            ('msgs exit 1: private stderr', 'msgs: lookup failed (details omitted)'),
            ('msgs show: private message', 'msgs: lookup failed (details omitted)'),
            ('Robob control: unexpected private details', 'Robob control: error (details omitted)'),
            ('private arbitrary error', 'unclassified error (details omitted)'),
            ('q-ab12: receipt: out of time', 'receipt: out of time'),
            ('his threads: Robob control: request failed or timed out',
             'his threads: Robob control: request failed or timed out'),
            ('Robob control: owner read incomplete (1 of 2 threads); continuing next check: '
             'Robob control: request failed or timed out',
             'Robob control: owner read incomplete (1 of 2 threads); continuing next check: '
             'Robob control: request failed or timed out'),
        ]
        for raw, expected in forms:
            with self.subTest(raw=raw):
                self.assertEqual(history.safe_error(raw), expected)
                self.assertEqual(history.safe_error(expected), expected)
        self.row['question_errors'] = [raw for raw, _ in forms]
        self.assertTrue(history.append(self.wd, self.row))
        now = dt.datetime(2026, 11, 16, 12, tzinfo=dt.timezone.utc)
        self.assertEqual(history.summary(self.wd, now=now)['question_errors'][
            'msgs: lookup failed (details omitted)'], 2)

    def test_since_input_forms_and_empty_history(self):
        now = dt.datetime(2026, 11, 16, 12, tzinfo=dt.timezone.utc)
        forms = [('24h', 86400), ('1d', 86400), ('90m', 5400), ('30s', 30), ('1.5h', 5400),
                 ('2026-11-15T12:00:00Z', 86400), ('2026-11-15T16:00:00+04:00', 86400)]
        for text, seconds in forms:
            with self.subTest(text=text):
                self.assertEqual((now - history.since_time(text, now)).total_seconds(), seconds)
        for text in ('-1h', 'tomorrow', '2026-11-15', '2026-11-15T12:00:00', '24'):
            with self.subTest(text=text), self.assertRaises(ValueError):
                history.since_time(text, now)
        result = history.summary(self.wd, now=now)
        self.assertEqual(result['run_count'], 0)
        self.assertEqual(result['total_s'], {'p50': None, 'p95': None, 'max': None})
        self.assertEqual(result['question_errors'], {})


class CheckHistoryTests(Base):
    def test_final_save_skip_records_build_write_on_every_path(self):
        import data_io
        from contextlib import ExitStack
        forms = (
            ('quiet', '2026-10-25T02:00', None),
            ('retained_outbox', '2026-10-25T12:00', None),
            ('reconcile_timeout', '2026-10-25T12:00', 'load'),
            ('follow_timeout', '2026-10-25T12:00', 'reconcile_merchants'),
        )
        self.case()
        for name, clock, timeout_target in forms:
            with self.subTest(path=name), ExitStack() as stack:
                real = cases.write_json
                def fail_pings(path, *args, **kwargs):
                    if path == self.wd / 'pings.json':
                        raise data_io.DataUnavailable(path)
                    return real(path, *args, **kwargs)
                if name == 'retained_outbox':
                    (self.wd / 'pings.json').write_text(json.dumps({'sent': {}, 'outbox': {
                        'run': 'old', 'keys': [], 'at': '2026-10-25T10:00:00+04:00', 'event': 'retained'}}))
                    stack.enter_context(patch.object(cases, 'runner_owns', return_value=True))
                if timeout_target:
                    stack.enter_context(patch.object(cases, timeout_target, side_effect=cases.CheckTimeout('out of time')))
                stack.enter_context(patch.object(cases, 'write_json', fail_pings))
                with self.assertRaises(data_io.DataUnavailable):
                    cases.run_check(self.wd, name, self.data, self.root, at(clock), finder(), nobody)
                row = json.loads((self.wd / 'runs.jsonl').read_text().splitlines()[-1])
                self.assertEqual(row['skip_phase'], 'build_write')
                self.assertEqual(row['skip_file'], 'pings.json')
                self.assertEqual(row['skip_reason'], 'edeadlk')
                self.assertEqual(row['exit'], 0)

    def test_check_history_and_append_failure_preserve_run(self):
        self.case()
        now = at('2026-10-25T12:00')
        event = cases.run_check(self.wd, 'r', self.data, self.root, now, finder(), nobody)
        row = json.loads((self.wd / 'runs.jsonl').read_text())
        self.assertEqual(row['exit'], 0)
        (self.wd / 'runs.jsonl').rename(self.wd / 'saved-history')
        (self.wd / 'runs.jsonl').mkdir()
        before = history.APPEND_ERRORS
        event2 = cases.run_check(self.wd, 'r2', self.data, self.root, now, finder(), nobody)
        self.assertEqual(history.APPEND_ERRORS, before + 1)
        self.assertEqual(event2, '')
        self.assertTrue(event)
        self.assertEqual(len((self.wd / 'saved-history').read_text().splitlines()), 1)

    def test_nested_check_command_appends_once(self):
        self.case()
        with patch.object(cases, 'LIVE', self.wd):
            cases.check_command(self.wd, 'r', self.data)
        self.assertEqual(len((self.wd / 'runs.jsonl').read_text().splitlines()), 1)

    def test_timeout_keeps_question_errors(self):
        self.case()
        with patch.object(cases, 'attention', side_effect=cases.CheckTimeout('out of time; the rest next check')):
            cases.run_check(self.wd, 'r', self.data, self.root, at('2026-10-25T12:00'), finder(), nobody)
        row = json.loads((self.wd / 'runs.jsonl').read_text())
        self.assertEqual(row['question_errors'], ['out of time; the rest next check'])

    def test_timeout_before_owner_read_never_reports_ok(self):
        self.case()
        clock = [time.time()]

        def timeout(*_args, **_kwargs):
            clock[0] += 39.5
            raise cases.CheckTimeout('out of time; the rest next check')

        with patch.object(cases.time, 'time', side_effect=lambda: clock[0]), \
                patch.object(cases, 'reconcile_merchants', side_effect=timeout):
            cases.run_check(self.wd, 'r', self.data, self.root, at('2026-10-25T12:00'), finder(), nobody)
        row = json.loads((self.wd / 'runs.jsonl').read_text())
        self.assertEqual(row['owner_result'], 'not_read')
        self.assertEqual(row['stop_reason'], 'out_of_budget')
        self.assertEqual(row['owner_queries'], 0)

    def test_skip_before_owner_read_has_no_false_ok(self):
        import data_io
        with patch.object(data_io, 'read_text', side_effect=data_io.DataUnavailable(self.data / 'cases.json')):
            with self.assertRaises(data_io.DataUnavailable):
                cases.run_check(self.wd, 'r', self.data, self.root)
        row = json.loads((self.wd / 'runs.jsonl').read_text())
        self.assertEqual(row['exit'], 0)
        self.assertTrue(row['skipped'])
        self.assertEqual(row['skip_file'], 'cases.json')
        self.assertEqual(row['skip_reason'], 'edeadlk')
        self.assertEqual(row['skip_phase'], 'loads')
        self.assertEqual(row['owner_result'], 'not_read')
        self.assertEqual(row['stop_reason'], 'data_unavailable')


if __name__ == '__main__':
    unittest.main()
