import contextlib
from concurrent.futures import ThreadPoolExecutor
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import owner_go as go

NOW = dt.datetime(2026, 11, 13, 12, tzinfo=go.UTC)


class OwnerGoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ledger = go.Ledger(Path(self.temp.name) / 'ledger')
        self.terms = dict(vendor='Hetzner', item='AX102-3', amount=53400, currency='USD')

    def record(self, **changes):
        return self.ledger.record(**{**self.terms, 'quote':'Yes, order AX102-3 at USD 534 monthly',
            'source':'thread/message', 'at':NOW.isoformat(), 'now':NOW, **changes})

    def verify(self, **changes):
        return self.ledger.verify(**{**self.terms, 'now':NOW, **changes})

    def test_matching_exact_vendor_item_and_budget(self):
        row = self.record()
        self.assertEqual(self.verify(vendor=' hetzner ', amount=50000)['id'], row['id'])
        cases = [('vendor', 'Scaleway'), ('item', 'AX102'), ('item', 'AX102 3'), ('item', 'ax102-3'),
                 ('amount', 53401), ('currency', 'EUR'), ('recurring', 'monthly')]
        for field, value in cases:
            with self.subTest(field=field, value=value), self.assertRaises(go.ApprovalError):
                self.verify(**{field:value})

    def test_expiry_future_times_and_recurring_never_extend_lifetime(self):
        self.record(recurring='monthly')
        self.verify(recurring='monthly', now=NOW + dt.timedelta(hours=23))
        for cadence in (None, 'yearly'):
            with self.assertRaises(go.ApprovalError): self.verify(recurring=cadence)
        for when in (NOW + dt.timedelta(hours=24), NOW - dt.timedelta(seconds=1)):
            with self.assertRaises(go.ApprovalError): self.verify(recurring='monthly', now=when)
        for changes in ({'at':(NOW + dt.timedelta(seconds=1)).isoformat()}, {'at':'2026-11-13'},
                        {'hours':25}, {'hours':0}, {'hours':float('nan')}):
            with self.subTest(changes=changes), self.assertRaises(ValueError): self.record(**changes)

    def test_expired_record_refuses_before_opening_ledger_and_logs_metadata(self):
        for age in (dt.timedelta(hours=25), dt.timedelta(hours=24),
                    dt.timedelta(hours=24, microseconds=1)):
            with self.subTest(age=age):
                at = (NOW - age).isoformat()
                expires = (NOW - age + go.MAX_AGE).isoformat()
                logs = Path(self.temp.name) / 'logs'
                with patch.dict(os.environ, {'ROBOB_TOOL_LOG_DIR': str(logs)}), \
                        patch.object(self.ledger, 'events', wraps=self.ledger.events) as events, \
                        self.assertRaisesRegex(go.ApprovalError, 'approval already expired at') as raised:
                    self.record(at=at, quote='PRIVATE OWNER QUOTE', source='PRIVATE SOURCE')
                events.assert_not_called()
                self.assertFalse(self.ledger.root.exists())
                self.assertIn(expires, str(raised.exception))
                self.assertIn('get a fresh yes from the owner', str(raised.exception))
                raw = ''.join(p.read_text() for p in (logs / 'orders').glob('*.ndjson'))
                logged = json.loads(raw.splitlines()[-1])
                self.assertEqual((logged['component'], logged['name'], logged['kind'], logged['ok']),
                                 ('owner-go', 'record.refused', 'error', False))
                self.assertEqual(logged['props'], dict(reason='expired_at_write', amountMinor=53400,
                    currency='USD', hours=24, at=at, expiresAt=expires))
                self.assertEqual(logged['ids'], {field: hashlib.sha256(value.encode()).hexdigest()[:16]
                    for field, value in [('vendorId', self.terms['vendor']), ('itemId', self.terms['item'])]})
                self.assertEqual(logged['error']['tag'], 'OWNER_GO_INVALID')
                self.assertNotIn('PRIVATE', raw)

    def test_backdated_record_with_remaining_lifetime_verifies(self):
        for age in (dt.timedelta(hours=23), dt.timedelta(hours=24) - dt.timedelta(microseconds=1)):
            with self.subTest(age=age):
                row = self.record(at=(NOW - age).isoformat())
                self.assertEqual(row['expires_at'], (NOW - age + go.MAX_AGE).isoformat())
                self.assertEqual(self.verify(), row)

    def test_expired_short_lifetime_record_leaves_ledger_unchanged(self):
        original = self.record()
        path = self.ledger.root / 'events.jsonl'
        before = path.read_bytes()
        for age, hours in ((25, 24), (2, 1), (1, 1)):
            with self.subTest(age=age, hours=hours), \
                    self.assertRaisesRegex(go.ApprovalError, 'already expired'):
                self.record(at=(NOW - dt.timedelta(hours=age)).isoformat(), hours=hours)
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(self.verify(), original)

    def test_cli_expired_record_returns_invalid_without_writing(self):
        at = (dt.datetime.now(go.UTC) - dt.timedelta(hours=26)).isoformat()
        args = ['record', '--vendor', 'run.cloud', '--item', 'synthetic test', '--amount', '20',
                '--currency', 'USD', '--quote', 'yes', '--source', 'test/message', '--at', at]
        with patch.object(go, 'Ledger', return_value=self.ledger), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(go.main(args), 2)
        result = json.loads(out.getvalue())
        self.assertFalse(result['ok'])
        self.assertEqual(result['error'], 'OWNER_GO_INVALID')
        self.assertIn('already expired', result['reason'])
        self.assertFalse(self.ledger.root.exists())

    def test_amount_input_class(self):
        for amount in (-1, True, '53400', 5.34, None):
            with self.subTest(amount=amount), self.assertRaises(go.ApprovalError): self.record(amount=amount)
        self.record(amount=0)
        self.verify(amount=0)

    def test_currency_omitted_only_when_unambiguous(self):
        self.record()
        self.verify(currency=None)
        self.record(currency='EUR')
        with self.assertRaisesRegex(go.ApprovalError, 'ambiguous'): self.verify(currency=None)

    def test_ask_deduplicates_across_threads_answer_does_not_authorize(self):
        args = {**self.terms, 'thread':'one', 'now':NOW}
        question = self.ledger.ask(**args)
        self.assertEqual(self.ledger.ask(**{**args, 'thread':'two'})['id'], question['id'])
        self.assertEqual(self.ledger.list(True), [question])
        answer = self.ledger.close('answer', question['id'], quote='No, evaluate alternatives first',
            source='thread/message', at=NOW.isoformat(), now=NOW)
        self.assertEqual(answer['quote'], 'No, evaluate alternatives first')
        self.assertEqual(self.ledger.list(True), [])
        self.assertEqual(len(self.ledger.list()), 2)
        with self.assertRaises(go.ApprovalError): self.verify()
        with self.assertRaisesRegex(go.ApprovalError, 'already closed'):
            self.ledger.close('answer', question['id'], quote='Yes', source='new', at=NOW.isoformat(), now=NOW)

    def test_revoke_append_only_and_private(self):
        row = self.record()
        path = self.ledger.root / 'events.jsonl'
        before = path.read_bytes()
        self.ledger.close('revoke', row['id'], quote='Stop', source='thread/message2', at=NOW.isoformat(), now=NOW)
        self.assertTrue(path.read_bytes().startswith(before))
        with self.assertRaises(go.ApprovalError): self.verify()
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.ledger.root.stat().st_mode & 0o777, 0o700)

    def test_missing_and_corrupt_fail_closed(self):
        with self.assertRaises(go.ApprovalError): self.verify()
        self.assertFalse(self.ledger.root.exists())
        self.record()
        with (self.ledger.root / 'events.jsonl').open('a') as out: out.write('{broken')
        with self.assertRaisesRegex(go.ApprovalError, 'unreadable'): self.verify()

    def test_cli_no_record_exit_code_and_open_json(self):
        with patch.object(go, 'Ledger', return_value=self.ledger), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(go.main(['verify', '--vendor','v','--item','i','--amount','100']), 4)
        self.assertEqual(json.loads(out.getvalue())['error'], 'OWNER_GO_REQUIRED')
        with patch.object(go, 'Ledger', return_value=self.ledger), contextlib.redirect_stdout(io.StringIO()):
            self.assertNotEqual(go.main(['list','--open','--json']), 0)
        with self.ledger.events(True):
            pass
        with patch.object(go, 'Ledger', return_value=self.ledger), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(go.main(['list','--open','--json']), 0)
        self.assertEqual(json.loads(out.getvalue()), [])

    def test_concurrent_asks_deduplicate_under_the_append_lock(self):
        def ask(index):
            return self.ledger.ask(**self.terms, thread=str(index), now=NOW)['id']
        with ThreadPoolExecutor(max_workers=4) as pool:
            ids = list(pool.map(ask, range(8)))
        self.assertEqual(len(set(ids)), 1)
        self.assertEqual(len(self.ledger.list(True)), 1)


if __name__ == '__main__': unittest.main()
