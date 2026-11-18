import contextlib
import copy
import datetime as dt
import hashlib
import io
import json
import unittest
from unittest.mock import patch

import owner_go as go
from owner_go_support import isolated_owner_ledger

NOW = dt.datetime(2026, 11, 18, 12, tzinfo=go.UTC)
QUOTE_AT = (NOW - dt.timedelta(days=30)).isoformat()


class StandingTests(unittest.TestCase):
    def setUp(self):
        self.ledger = isolated_owner_ledger(self)
        self.terms = dict(vendor='run.cloud', item='TorSSH synthetic test', amount=20, currency='USD')

    def standing(self, **changes):
        return self.ledger.standing(**{'vendor': ' Run.Cloud ', 'scope': 'TorSSH test spend',
            'per_run_cap': 20, 'currency': ' usd ', 'quote': 'PRIVATE OWNER QUOTE',
            'source': 'PRIVATE SOURCE', 'at': QUOTE_AT, 'now': NOW, **changes})

    def record(self, standing, **changes):
        args = {k: v for k, v in self.terms.items() if k != 'vendor'}
        return self.ledger.record_standing(**{**args, 'standing': standing, 'now': NOW, **changes})

    def refuse(self, standing, reason, **changes):
        path = self.ledger.root / 'events.jsonl'
        before = path.read_bytes()
        with self.assertRaisesRegex(go.ApprovalError, '^' + reason + ':'):
            self.record(standing, **changes)
        self.assertEqual(path.read_bytes(), before)

    def cli(self, args):
        with patch.object(go, 'Ledger', return_value=self.ledger), contextlib.redirect_stdout(io.StringIO()) as out:
            code = go.main(args)
        return code, json.loads(out.getvalue())

    def test_standing_normalizes_and_preserves_original_quote_time_without_expiry(self):
        row = self.standing()
        self.assertEqual({k: v for k, v in row.items() if k != 'id'}, dict(kind='standing',
            vendor='run.cloud', scope='TorSSH test spend', per_run_cap=20, currency='USD',
            quote='PRIVATE OWNER QUOTE', source='PRIVATE SOURCE', at=QUOTE_AT, logged_at=NOW.isoformat()))
        self.assertEqual(self.ledger.list(), [row])
        self.assertEqual(self.ledger.list(True), [])
        with self.assertRaises(go.ApprovalError):
            self.ledger.verify(**self.terms, now=NOW)

    def test_future_standing_refuses_before_ledger_write(self):
        with self.assertRaisesRegex(go.ApprovalError, 'future standing'):
            self.standing(at=(NOW + dt.timedelta(microseconds=1)).isoformat())
        self.assertFalse(self.ledger.root.exists())

    def test_standing_input_class_refuses_without_writing(self):
        cases = [{'per_run_cap': v} for v in (0, -1, True, 1.5, '20', None)]
        cases += [{'currency': v} for v in ('', None, 'US', 'USDD', '12A')]
        cases += [{field: ''} for field in ('vendor', 'scope', 'quote', 'source')]
        cases += [{'at': '2026-11-18T12:00:00'}]
        for changes in cases:
            with self.subTest(changes=changes), self.assertRaises(go.ApprovalError):
                self.standing(**changes)
            self.assertFalse(self.ledger.root.exists())

    def test_record_is_ordinary_exact_terms_and_verify_is_unchanged(self):
        standing = self.standing()
        row = self.record(standing['id'], currency=' usd ')
        self.assertEqual(row, dict(id=row['id'], kind='record', logged_at=NOW.isoformat(),
            **self.terms, recurring=None, at=NOW.isoformat(),
            expires_at=(NOW + dt.timedelta(hours=2)).isoformat(), standing_id=standing['id'],
            quote=f"standing:{standing['id']}", source=f"standing:{standing['id']}:PRIVATE SOURCE"))
        for amount in (0, 1, 19, 20):
            with self.subTest(amount=amount):
                self.assertEqual(self.ledger.verify(**{**self.terms, 'amount': amount}, now=NOW), row)
        for changes in ({'vendor': 'other'}, {'item': 'another test'}, {'currency': 'AED'},
                        {'amount': 21}, {'recurring': 'monthly'}):
            with self.subTest(changes=changes), self.assertRaises(go.ApprovalError):
                self.ledger.verify(**{**self.terms, **changes}, now=NOW)

    def test_per_run_cap_has_no_total_ceiling(self):
        standing = self.standing()
        records = [self.record(standing['id']) for _ in range(3)]
        self.assertEqual(len({r['id'] for r in records}), 3)
        self.assertEqual(sum(r['amount'] for r in records), 60)

    def test_over_cap_and_currency_mismatch_never_append(self):
        standing = self.standing()
        self.refuse(standing['id'], 'STANDING_CAP_EXCEEDED', amount=21)
        self.refuse(standing['id'], 'STANDING_CURRENCY_MISMATCH', currency='AED')

    def test_amount_input_class_refuses_without_appending(self):
        standing = self.standing()
        for amount in (0, -1, True, 0.5, '20', None):
            with self.subTest(amount=amount):
                self.refuse(standing['id'], 'INVALID_AMOUNT', amount=amount)

    def test_revoked_standing_refuses_new_records_and_record_can_be_revoked(self):
        standing = self.standing()
        row = self.record(standing['id'])
        self.ledger.close('revoke', standing['id'], quote='PRIVATE STOP', source='test/revoke',
                          at=NOW.isoformat(), now=NOW)
        self.refuse(standing['id'], 'STANDING_REVOKED')
        self.assertEqual(self.ledger.verify(**self.terms, now=NOW), row)
        self.ledger.close('revoke', row['id'], quote='stop run', source='test/revoke',
                          at=NOW.isoformat(), now=NOW)
        with self.assertRaises(go.ApprovalError):
            self.ledger.verify(**self.terms, now=NOW)

    def test_missing_id_and_wrong_kind_refuse_without_appending(self):
        standing = self.standing()
        for value in ('unknown', '', None):
            with self.subTest(value=value):
                self.refuse(value, 'STANDING_NOT_FOUND')
        row = self.record(standing['id'])
        self.refuse(row['id'], 'NOT_STANDING')

    def test_expiry_is_anchored_to_run_now_instead_of_old_quote(self):
        standing = self.standing()
        for hours in (0.5, 2, 24):
            with self.subTest(hours=hours):
                row = self.record(standing['id'], hours=hours)
                self.assertEqual(row['at'], NOW.isoformat())
                expires = NOW + dt.timedelta(hours=hours)
                self.assertEqual(row['expires_at'], expires.isoformat())
                self.assertEqual(self.ledger.verify(**self.terms,
                    now=expires - dt.timedelta(microseconds=1)), row)
                with self.assertRaises(go.ApprovalError):
                    self.ledger.verify(**self.terms, now=NOW + dt.timedelta(hours=24))

    def test_lifetime_input_class_refuses_without_appending(self):
        standing = self.standing()
        for hours in (-1, 0, 25, float('nan'), float('inf'), 1e-20, 1e-10):
            with self.subTest(hours=hours):
                self.refuse(standing['id'], 'INVALID_LIFETIME', hours=hours)

    def test_corrupt_standing_shapes_fail_closed(self):
        standing = self.standing()
        cases = [{'per_run_cap': v} for v in (0, -1, True, '20', 0.5)]
        cases += [{'currency': None}, {'scope': ''}, {'quote': ''}, {'source': ''}, {'at': 'bad'}]
        for changes in cases:
            with self.subTest(changes=changes), self.assertRaises((ValueError, TypeError)):
                self.ledger.validate([{**standing, **changes}])
        for field in ('vendor', 'scope', 'per_run_cap', 'currency', 'quote', 'source', 'at', 'logged_at'):
            row = copy.copy(standing)
            del row[field]
            with self.subTest(field=field), self.assertRaises((ValueError, KeyError)):
                self.ledger.validate([row])

    def test_cli_create_list_record_and_over_cap_invalid_exit(self):
        code, standing = self.cli(['standing', '--vendor', 'run.cloud', '--scope', 'test spend',
            '--per-run-cap', '20', '--currency', 'USD', '--quote', 'synthetic yes', '--source',
            'test/message', '--at', QUOTE_AT])
        self.assertEqual(code, 0)
        for args in (['list'], ['list', '--json']):
            self.assertEqual(self.cli(args), (0, [standing]))
        self.assertEqual(self.cli(['list', '--open', '--json']), (0, []))
        args = ['record-standing', '--standing', standing['id'], '--item', self.terms['item'],
                '--amount', '20', '--currency', 'USD']
        code, row = self.cli(args)
        self.assertEqual(code, 0)
        self.assertEqual(go.timestamp(row['expires_at']) - go.timestamp(row['at']), dt.timedelta(hours=2))
        self.assertEqual(self.ledger.verify(**self.terms), row)
        before = self.ledger.list()
        code, failure = self.cli(args + ['--amount', '21'])
        self.assertEqual(code, 2)
        self.assertEqual(failure['error'], 'OWNER_GO_INVALID')
        self.assertTrue(failure['reason'].startswith('STANDING_CAP_EXCEEDED:'))
        self.assertEqual(self.ledger.list(), before)

    def test_cli_rejects_at_vendor_and_recurring_flags(self):
        standing = self.standing()
        args = ['record-standing', '--standing', standing['id'], '--item', 'test',
                '--amount', '20', '--currency', 'USD']
        before = self.ledger.list()
        for flag, value in (('--at', NOW.isoformat()), ('--vendor', 'noon'), ('--recurring', 'monthly')):
            with self.subTest(flag=flag), contextlib.redirect_stderr(io.StringIO()), \
                    self.assertRaises(SystemExit) as raised:
                self.cli(args + [flag, value])
            self.assertEqual(raised.exception.code, 2)
        self.assertEqual(self.ledger.list(), before)

    def test_list_open_remains_about_unanswered_asks(self):
        standing = self.standing()
        ask = self.ledger.ask(**self.terms, thread='synthetic thread', now=NOW)
        self.record(standing['id'])
        self.assertEqual(self.ledger.list(True), [ask])
        self.ledger.close('answer', ask['id'], quote='no', source='test', at=NOW.isoformat(), now=NOW)
        self.assertEqual(self.ledger.list(True), [])

    def test_toollog_preserves_events_reasons_amount_and_hashed_ids_without_quote_text(self):
        import toollog
        standing = self.standing()
        self.record(standing['id'], item='PRIVATE ITEM')
        self.refuse(standing['id'], 'STANDING_CAP_EXCEEDED', item='PRIVATE ITEM', amount=21)
        raw = ''.join(p.read_text() for p in (self.ledger.root.parent / 'logs/orders').glob('*.ndjson'))
        rows = [json.loads(line) for line in raw.splitlines()]
        self.assertEqual([r['name'] for r in rows],
                         ['standing.created', 'standing_record.created', 'standing_record.refused'])
        self.assertEqual(rows[-1]['props'], dict(reason='STANDING_CAP_EXCEEDED', amountMinor=21))
        self.assertEqual(rows[-1]['error']['tag'], 'STANDING_CAP_EXCEEDED')
        for field, value in (('standingId', standing['id']), ('vendorId', 'run.cloud'), ('itemId', 'PRIVATE ITEM')):
            self.assertEqual(rows[-1]['ids'][field], hashlib.sha256(value.encode()).hexdigest()[:16])
        self.assertEqual(toollog.rollup()['errorsByComponent']['owner-go'], {'STANDING_CAP_EXCEEDED': 1})
        self.assertNotIn('PRIVATE', raw)


if __name__ == '__main__':
    unittest.main()
