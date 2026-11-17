"""Closed-window archive reuse; every archive response is a stub."""
import datetime as dt
import json
import stat
import subprocess
import time
from unittest.mock import patch

from test_cases import Base, at, mc, nobody, ALERT, BANK

ch = mc.charges


class MsgsCache(Base):
    def setUp(self):
        super().setUp()
        self.path = self.data / 'msgs-searches.json'
        self.memo = {('msgs_cache',): self.path}
        self.row = dict(id=1, ts=at('2026-10-24T09:00').timestamp(), source='email',
                        sender='Acme', subject='invoice', from_me=0)
        self.archive = patch.object(ch.subprocess, 'run', return_value=subprocess.CompletedProcess(
            [], 0, json.dumps({**self.row, 'snip': 'private snippet', 'body': 'never cache a body'}), ''))
        self.calls = self.archive.start()
        self.addCleanup(self.archive.stop)

    def search(self, until='2026-10-26', memo=None, **kwargs):
        return ch.search('PRIVATE', '2026-10-24', until=until, source='email', n=60,
                         memo=self.memo if memo is None else memo, **kwargs)

    def test_closed_window_survives_next_check_and_only_keeps_evidence_fields(self):
        self.search()
        stats = {'msgs_calls': 0}
        rows = self.search(memo={('msgs_cache',): self.path}, stats=stats)
        self.assertEqual(rows, [self.row])
        self.assertEqual(self.calls.call_count, 1)
        self.assertEqual((stats['msgs_cache_hits'], stats['msgs_calls']), (1, 0))
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        contents = self.path.read_text()
        self.assertNotIn('PRIVATE', contents)
        self.assertNotIn('snippet', contents)
        self.assertNotIn('body', contents)
        self.assertEqual(list(self.path.parent.glob('.msgs-searches.json.*')), [])

    def test_open_today_future_missing_and_relative_bounds_are_never_cached(self):
        today = dt.datetime.now(ch.TZ).date()
        for until in (None, today.isoformat(), (today+dt.timedelta(days=1)).isoformat(), '7d', 'broken'):
            with self.subTest(until=until):
                self.search(until, memo={('msgs_cache',): self.path})
                self.search(until, memo={('msgs_cache',): self.path})
        self.assertEqual(self.calls.call_count, 10)
        self.assertFalse(self.path.exists())

    def test_dubai_midnight_controls_closure(self):
        class DateTime(dt.datetime):
            @classmethod
            def now(cls, tz=None):
                return at('2026-11-16T00:01').astimezone(tz)
        with patch.object(ch.dt, 'datetime', DateTime):
            self.search('2026-11-15')
            self.search('2026-11-15', memo={('msgs_cache',): self.path})
        self.assertEqual(self.calls.call_count, 1)

    def test_corrupt_cache_and_expired_rows_are_empty_and_pruned(self):
        self.data.mkdir(parents=True)
        for contents in ('{', '[]', '{"x":null}'):
            self.path.write_text(contents)
            self.search(memo={('msgs_cache',): self.path})
        cache = json.loads(self.path.read_text())
        old_key = '0'*64
        cache[old_key] = {'saved': time.time()-15*86400, 'rows': []}
        self.path.write_text(json.dumps(cache))
        ch.search('DIFFERENT', '2026-10-24', until='2026-10-26', n=60,
                  memo={('msgs_cache',): self.path})
        self.assertNotIn(old_key, self.path.read_text())
        self.assertEqual(self.calls.call_count, 4)

    def test_failed_malformed_or_truncated_searches_never_enter_cache(self):
        for outcome in (subprocess.TimeoutExpired('fake', 2),
                        subprocess.CompletedProcess([], 1, '', 'failed'),
                        subprocess.CompletedProcess([], 0, '[broken', '')):
            with self.subTest(outcome=type(outcome).__name__):
                self.calls.side_effect = outcome if isinstance(outcome, Exception) else None
                self.calls.return_value = outcome
                with self.assertRaises(ch.Lookup):
                    self.search(memo={('msgs_cache',): self.path})
                self.assertFalse(self.path.exists())
        self.calls.side_effect = None
        self.calls.return_value = subprocess.CompletedProcess([], 0, json.dumps(self.row), '')
        ch.search('PRIVATE', '2026-10-24', until='2026-10-26', n=1, memo=self.memo)
        self.assertFalse(self.path.exists())

    def test_numeric_corruption_is_a_cache_miss(self):
        self.search()
        valid = json.loads(self.path.read_text())
        key = next(iter(valid))
        invalid = (10**400, -(10**400), float('inf'), float('-inf'), float('nan'), True, '1', None)
        for field in ('saved', 'ts'):
            for value in invalid:
                with self.subTest(field=field, value_type=type(value).__name__):
                    entry = {'saved': valid[key]['saved'], 'rows': [dict(self.row)]}
                    if field == 'saved':
                        entry[field] = value
                    else:
                        entry['rows'][0][field] = value
                    self.path.write_text(json.dumps({key: entry}))
                    before = self.calls.call_count
                    rows = self.search(memo={('msgs_cache',): self.path})
                    self.assertEqual([{key: row[key] for key in self.row} for row in rows], [self.row])
                    self.assertEqual(self.calls.call_count, before + 1)

    def test_raw_copy_limit_cannot_be_hidden_by_message_deduplication(self):
        for n in (10, 60):
            for copies in (1, 2, 5):
                def archive(argv, **kwargs):
                    self.assertIn('--all-copies', argv)
                    rows = [{**self.row, 'id': i, 'msgid': '<copy-' + str(i//copies) + '>'} for i in range(n)]
                    return subprocess.CompletedProcess(argv, 0, '\n'.join(json.dumps(row) for row in rows), '')
                with self.subTest(limit=n, copies=copies), patch.object(ch.subprocess, 'run', archive):
                    rows = ch.search('PRIVATE', '2026-10-24', until='2026-10-26', n=n, memo={('msgs_cache',): self.path})
                    self.assertEqual(len(rows), n//copies)
                    self.assertEqual(rows.raw_count, n)
                    self.assertFalse(self.path.exists())
        self.case()
        errors = mc.refund_mails(self.data, at('2026-11-15T12:00'), time.time()+8,
                                find=lambda *args, **kw: rows)
        self.assertIn('search limit reached', str(errors))
        self.assertNotIn('refund_mail', mc.load(self.data)['cases'][0])

    def test_folder_copies_are_folded_before_fresh_and_cached_receipt_reads(self):
        clock, sequence = [1000.0], []
        charge = dict(kind='charge', merchant='Acme', currency='EUR', amount='12.34', card='1111')
        rows = [{**self.row, 'id': i, 'msgid': '<COPY>' if i % 2 else '<copy>'} for i in range(1, 6)]
        rows.append({**self.row, 'id': 6, 'msgid': '<receipt>'})
        def archive(argv, **kwargs):
            sequence.append((argv[1], argv[2]))
            clock[0] += 1
            text = ('\n'.join(json.dumps(row) for row in rows) if argv[1] == 'search' else
                    'Acme invoice EUR 12.34' if argv[2] == '6' else 'Usage notice')
            return subprocess.CompletedProcess(argv, 0, text, '')
        with patch.object(ch.time, 'time', lambda: clock[0]), \
                patch.object(ch.time, 'monotonic', lambda: clock[0]), \
                patch.object(ch.subprocess, 'run', archive):
            for _ in range(2):
                stats = {'msgs_calls': 0}
                before = clock[0]
                result = ch.found(charge, at('2026-10-24T09:00'), at('2026-11-15T12:00'),
                    deadline=clock[0]+6, said=nobody, memo={('msgs_cache',): self.path}, stats=stats)
                self.assertEqual((result['verdict'], result['msgs']), ('receipt', 6))
                self.assertLessEqual(clock[0]-before, 3)
                self.assertEqual(ch.receipt_timing(stats)['receipt_result']['out_of_time'], 0)
        self.assertEqual([step[0] for step in sequence], ['search', 'show', 'show', 'show', 'show'])
        self.assertEqual([step[1] for step in sequence[1:]], ['1', '6', '1', '6'])
        cached = next(iter(json.loads(self.path.read_text()).values()))['rows']
        self.assertEqual([row['id'] for row in cached], [1, 6])

    def test_capped_mail_and_bank_history_cannot_ask_from_partial_results(self):
        charge = ch.parse(ALERT, BANK)
        now = at('2026-11-15T12:00')
        for phase in ('mail', 'bank'):
            def archive(argv, **kwargs):
                self.assertIn('--all-copies', argv)
                rows = ([{**self.row, 'id': i, 'msgid': '<copy>'} for i in range(30)]
                        if phase == 'mail' or '--in' not in argv else [])
                return subprocess.CompletedProcess(argv, 0, '\n'.join(json.dumps(row) for row in rows), '')
            with self.subTest(phase=phase), patch.object(ch.subprocess, 'run', archive), \
                    patch.object(ch, 'found', return_value=None):
                result = ch.explain(charge, now, now, memo={('msgs_cache',): self.path})
                self.assertEqual(result['verdict'], 'unverified')
                self.assertIn('merchant history incomplete', str(result['errors']))
                self.assertTrue(all(not entry['rows'] for entry in ch.search_cache(self.path, time.time()).values()))

    def test_other_search_clients_keep_existing_cli_copy_folding(self):
        ch.search('OTHER', '2026-11-15')
        self.assertNotIn('--all-copies', self.calls.call_args.args[0])
        ch.search('EVIDENCE', '2026-11-15', all_copies=True)
        self.assertIn('--all-copies', self.calls.call_args.args[0])

    def test_argv_changes_and_unwritable_cache_do_not_alias_or_hide_results(self):
        self.search()
        for options in ({'source': None}, {'n': 10}, {'since': '2026-10-23'}, {'query': 'ANOTHER'}):
            args = dict(query='PRIVATE', since='2026-10-24', until='2026-10-26', source='email', n=60)
            args.update(options)
            ch.search(**args, memo={('msgs_cache',): self.path})
        self.assertEqual(self.calls.call_count, 5)
        with patch.object(ch, 'write_json', side_effect=OSError('fixture')):
            self.assertTrue(ch.search('NEW', '2026-10-24', until='2026-10-26', memo=self.memo))

    def test_one_second_receipt_reads_reuse_closed_search_on_next_check(self):
        clock, sequence = [1000.0], []
        now, charge_at = at('2026-11-15T12:00'), at('2026-10-24T09:00')
        charge = dict(kind='charge', merchant='Acme', currency='EUR', amount='12.34', card='1111')
        def archive(argv, **kwargs):
            sequence.append(argv[1])
            clock[0] += 1
            text = json.dumps(self.row) if argv[1] == 'search' else 'Acme invoice EUR 12.34'
            return subprocess.CompletedProcess(argv, 0, text, '')
        with patch.object(ch.time, 'time', lambda: clock[0]), \
                patch.object(ch.time, 'monotonic', lambda: clock[0]), \
                patch.object(ch.subprocess, 'run', archive):
            for _ in range(2):
                stats = {'msgs_calls': 0}
                result = ch.found(charge, charge_at, now, deadline=clock[0]+6,
                                  said=nobody, memo={('msgs_cache',): self.path}, stats=stats)
                self.assertEqual(result['verdict'], 'receipt')
                self.assertEqual(ch.receipt_timing(stats)['receipt_result']['out_of_time'], 0)
        self.assertEqual(sequence, ['search', 'show', 'show'])

    def test_check_attempts_receipt_before_two_second_refund_calls(self):
        charge_at, now = at('2026-10-24T09:00'), at('2026-11-15T12:00')
        charge = ch.parse(ALERT, BANK)
        book = {'version': 1, 'questions': []}
        question = mc.new_question(book, charge, ALERT, charge_at, charge_at, 'sms')
        mc.write_json(self.data / 'questions.json', book)
        for n in range(5):
            self.case('refund-' + str(n), amount=str(120+n))
        clock, sequence = [1000.0], []
        def owner(*args, **kwargs):
            sequence.append('owner')
            return []
        def archive(argv, **kwargs):
            if argv[1] == 'search' and ' refund OR credited' in argv[2]:
                sequence.append('refund')
                clock[0] += kwargs['timeout']
                raise subprocess.TimeoutExpired('fake', kwargs['timeout'])
            sequence.append('receipt')
            clock[0] += 1
            text = json.dumps(self.row) if argv[1] == 'search' else 'Acme invoice EUR 12.34'
            return subprocess.CompletedProcess(argv, 0, text, '')
        with patch.object(ch.time, 'time', lambda: clock[0]), \
                patch.object(ch.time, 'monotonic', lambda: clock[0]), \
                patch.object(ch.subprocess, 'run', archive):
            mc.run_check(self.wd, 'slow-archive', self.data, self.root, now, said=owner)
        timing = json.loads((self.wd / 'pings.json').read_text())['timing']
        self.assertEqual(sequence[:3], ['owner', 'receipt', 'receipt'])
        self.assertIn('refund', sequence)
        self.assertEqual(timing['receipt_result']['found'], 1)
        self.assertEqual(timing['receipt_result']['out_of_time'], 0)
        self.assertGreater(timing['msgs_by_kind']['refund']['count'], 0)
        self.assertTrue(all('refund_mail' not in case for case in mc.load(self.data)['cases']))
        self.assertEqual(mc.find_question(mc.load_questions(self.data), question['id'])['status'], 'closed')

    def test_refund_window_is_bounded_and_partial_search_cannot_update_case(self):
        self.case()
        seen = []
        def find(*args, **kwargs):
            seen.append(kwargs)
            return [self.row]*10
        errors = mc.refund_mails(self.data, at('2026-11-15T12:00'), time.time()+8, find=find)
        self.assertEqual(seen[0]['until'], '2026-11-16')
        self.assertIn('search limit reached', str(errors))
        self.assertNotIn('refund_mail', mc.load(self.data)['cases'][0])
