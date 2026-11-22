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

    def test_additive_schema_and_unknown_measurements(self):
        values = {**self.row, 'receipt_eligible': 5, 'receipt_result': {'none': 2, 'error': 1},
                  'budget_stop_reason': 'follow_deadline', 'merchants_calls': 1,
                  'order_charges_calls': 2, 'questions_calls': 3,
                  'loadavg_start': [1.5, 2, 3], 'loadavg_end': [2, 3, 4]}
        history.receipt_coverage(values)
        self.assertTrue(history.append(self.wd, values))
        row = json.loads(self.path.read_text())
        for key, value in self.row.items():
            self.assertEqual(row[key], value)
        self.assertEqual(row['receipt_unattempted'], 2)
        for key in history.COUNTS:
            self.assertIs(type(row[key]), int)
        for key in (*history.COUNTS, 'loadavg_start', 'loadavg_end', 'budget_stop_reason'):
            self.assertIsNone(history.run_row(self.row)[key])
        self.assertEqual(history.run_row(row), row)
        for value in ('PRIVATE', [1, 2], [1, float('nan'), 3], [-1, 2, 3]):
            self.assertIsNone(history.run_row({**self.row, 'loadavg_start': value})['loadavg_start'])
        self.assertIsNone(history.run_row({**self.row, 'budget_stop_reason': 'PRIVATE'})['budget_stop_reason'])

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

    def test_health_fixture_day_boundary_and_cli_are_read_only(self):
        rows = [
            {**self.row, 'at': '2026-11-15T23:59:59Z', 'total_s': 100},
            {**self.row, 'at': '2026-11-16T00:00:00Z', 'total_s': 10, 'owner_result': 'ok',
             'receipt_eligible': 4, 'receipt_unattempted': 1,
             'receipt_result': {'found': 1, 'none': 1, 'out_of_time': 1, 'error': 0},
             'budget_stop_reason': 'follow_deadline', 'loadavg_start': [1, 2, 3], 'loadavg_end': [2, 3, 4]},
            {**self.row, 'at': '2026-11-16T23:59:59Z', 'total_s': 40, 'owner_result': 'list_failed',
             'receipt_eligible': 6, 'receipt_unattempted': 3,
             'receipt_result': {'found': 1, 'none': 1, 'out_of_time': 0, 'error': 1},
             'budget_stop_reason': 'follow_deadline', 'loadavg_start': [3, 4, 5], 'loadavg_end': [4, 5, 6]},
            {**self.row, 'at': '2026-11-17T02:00:00+04:00', 'total_s': 30},
            {**self.row, 'at': '2026-11-17T00:00:00Z', 'total_s': 200},
        ]
        (self.wd / 'runs.jsonl.1').write_text('\n'.join(json.dumps(row) for row in rows[:2]) + '\n')
        self.path.write_text('\n'.join(json.dumps(row) for row in rows[2:]) + '\n{partial\n')
        before = {p.name: p.read_bytes() for p in self.wd.iterdir()}
        result = history.health(self.wd, '2026-11-16')
        self.assertEqual(result['runs'], 3)
        self.assertEqual(result['total_s'], {'p50': 30, 'p95': 39, 'max': 40})
        self.assertEqual(result['over_35_count'], 1)
        self.assertEqual(result['owner_results'], {'ok': 1, 'list_failed': 1, 'incomplete': 1})
        receipt = result['receipt']
        self.assertEqual((receipt['known_runs'], receipt['unknown_runs'], receipt['eligible']), (2, 1, 10))
        self.assertEqual(receipt['counts'], dict(found=2, none=2, out_of_time=1, error=1, unattempted=4))
        self.assertEqual(receipt['share']['unattempted'], .4)
        self.assertEqual(sum(receipt['share'].values()), 1)
        self.assertEqual(result['top_budget_stop_reason'], 'follow_deadline')
        self.assertEqual(result['loadavg_p95'], {'start': [2.9, 3.9, 4.9], 'end': [3.9, 4.9, 5.9]})
        self.assertEqual(result['loadavg_samples'], dict(start=2, end=2))
        self.assertEqual(result['invalid_lines'], 1)
        for mode in ([], ['--json'], ['--one-line']):
            with patch.dict(os.environ, {'WATCH_DIR': str(self.wd)}), redirect_stdout(io.StringIO()) as out:
                self.assertEqual(cases.main(['health', '--day', '2026-11-16', *mode]), 0)
            if mode == ['--json']:
                self.assertEqual(json.loads(out.getvalue()), result)
            else:
                self.assertIn(result['one_line'], out.getvalue())
        self.assertEqual({p.name: p.read_bytes() for p in self.wd.iterdir()}, before)

    def test_health_missing_old_zero_and_invalid_days(self):
        result = history.health(self.wd, '2026-11-16')
        self.assertEqual(result['runs'], 0)
        self.assertIsNone(result['receipt']['eligible'])
        self.assertEqual(result['loadavg_p95']['end'], [None, None, None])
        self.path.write_text(json.dumps(self.row) + '\n')
        result = history.health(self.wd, '2026-11-16')
        self.assertEqual(result['receipt']['unknown_runs'], 1)
        self.assertIsNone(result['receipt']['counts']['unattempted'])
        self.path.write_text(json.dumps({**self.row, 'receipt_eligible': 0, 'receipt_unattempted': 0}) + '\n')
        result = history.health(self.wd, '2026-11-16')
        self.assertEqual(result['receipt']['eligible'], 0)
        self.assertIsNone(result['receipt']['share']['found'])
        for day in ('2026-11-31', '2026-1-1', 'yesterday', '2026-11-16T00:00:00Z'):
            with self.subTest(day=day), self.assertRaises(ValueError):
                history.health(self.wd, day)
        now = dt.datetime(2026, 11, 17, 2, tzinfo=dt.timezone(dt.timedelta(hours=4)))
        self.assertEqual(history.health(self.wd, now=now)['day'], '2026-11-16')

    def test_health_validates_raw_receipt_counter_shapes_before_projection(self):
        forms = [
            ('text', {'error': 'malformed'}), ('negative', {'error': -1}),
            ('boolean', {'error': True}), ('fraction', {'error': .5}),
            ('nonfinite', {'error': float('nan')}), ('nested', {'error': {'count': 0}}),
            ('list-counter', {'error': []}), ('null-counter', {'error': None}),
            ('null-container', None), ('list-container', []), ('text-container', 'malformed'),
            ('inconsistent-total', {'none': 1}),
        ]
        for label, counters in forms:
            with self.subTest(shape=label):
                row = {**self.row, 'receipt_eligible': 1, 'receipt_unattempted': 1,
                       'receipt_result': counters}
                self.path.write_text(json.dumps(row) + '\n')
                result = history.health(self.wd, '2026-11-16')
                self.assertEqual(result['runs'], 1)
                self.assertEqual(result['receipt']['known_runs'], 0)
                self.assertEqual(result['receipt']['unknown_runs'], 1)
                self.assertIsNone(result['receipt']['eligible'])

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
    def test_loadavg_failure_still_writes_successful_check_row(self):
        self.case()
        with patch.object(history.os, 'getloadavg', side_effect=OSError('fixture unavailable')), \
                patch.dict(os.environ, {'WATCH_DIR': str(self.wd), 'WATCH_RUN_ID': 'fixture'}), \
                patch.object(cases, 'DATA', self.data), redirect_stdout(io.StringIO()):
            self.assertEqual(cases.main(['check']), 0)
        row = json.loads((self.wd / 'runs.jsonl').read_text())
        self.assertEqual(row['exit'], 0)
        self.assertIsNone(row['loadavg_start'])
        self.assertIsNone(row['loadavg_end'])

    def test_successful_load_samples_and_zero_work_counts(self):
        with patch.object(history.os, 'getloadavg', side_effect=[(1, 2, 3), (4, 5, 6)]):
            cases.run_check(self.wd, 'fixture', self.data, self.root,
                            at('2026-10-25T12:00'), finder(), nobody)
        row = json.loads((self.wd / 'runs.jsonl').read_text())
        self.assertEqual(row['loadavg_start'], [1, 2, 3])
        self.assertEqual(row['loadavg_end'], [4, 5, 6])
        self.assertEqual(row['receipt_eligible'], 0)
        self.assertEqual(row['receipt_unattempted'], 0)
        self.assertEqual(row['questions_calls'], 0)
        self.assertEqual(row['order_charges_calls'], 0)

    def test_receipt_census_counts_questions_skipped_at_follow_deadline(self):
        from test_cases import CheckBudget
        now = at('2026-10-25T12:00')
        CheckBudget.seed(self, [now - dt.timedelta(days=3, hours=n) for n in range(3)])
        stats = {'lookups': 0, 'owner_queries': 0, 'msgs_calls': 0}
        clock = [1000.0]
        def receipt(*args, **kwargs):
            clock[0] += 3
            return None
        with history.recording(self.wd) as row, patch.object(cases.time, 'time', lambda: clock[0]), \
                patch.object(cases, 'FOLLOW_EACH', 3), \
                patch.object(cases.charges, 'receipt', receipt), \
                patch.object(cases.charges, 'known', return_value=None):
            row['stats'] = stats
            cases.follow(self.data, now, self.root, clock[0] + 5, finder(), nobody, stats=stats)
        row = json.loads((self.wd / 'runs.jsonl').read_text())
        self.assertEqual(row['receipt_eligible'], 3)
        self.assertEqual(sum(row['receipt_result'].values()), 1)
        self.assertEqual(row['receipt_unattempted'], 2)
        self.assertEqual(row['questions_calls'], 1)
        self.assertEqual(row['budget_stop_reason'], 'follow_deadline')

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
