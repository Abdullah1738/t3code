import contextlib
from concurrent.futures import ThreadPoolExecutor
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import agent_bus_read as bus
from agent_bus_support import REQUEST, create_bus, update_bus
import owner_go as go

NOW = dt.datetime(2026, 11, 15, 12, tzinfo=go.UTC)


class DelegationTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.db = self.root / 'bus.sqlite'
        create_bus(self.db, NOW)
        env = patch.dict(os.environ, {'AGENT_BUS_DB': str(self.db),
                                      'ROBOB_TOOL_LOG_DIR': str(self.root / 'logs')})
        env.start(); self.addCleanup(env.stop)
        self.ledger = go.Ledger(self.root / 'ledger')
        self.terms = dict(vendor='noon', item='commerce:noon:minutes:' + 'b' * 64,
                          amount=200, currency='AED')

    def delegate(self, **changes):
        return self.ledger.delegate(**{'principal':'moni', 'channel':'agent-bus', 'quote':'Yes',
            'source':'owner/message', 'at':NOW.isoformat(), 'now':NOW, **changes})

    def record(self, **changes):
        return self.ledger.record_delegated(**{**self.terms, 'principal': 'moni',
                                               'bus_request': REQUEST, 'now': NOW, **changes})

    def refuse(self, reason, **changes):
        before = self.ledger.list()
        with self.assertRaisesRegex(go.ApprovalError, '^' + reason + ':'):
            self.record(**changes)
        self.assertEqual(self.ledger.list(), before)

    def test_delegate_idempotent_and_list_open_still_only_asks(self):
        delegate = self.delegate()
        self.assertEqual(self.delegate(), delegate)
        self.assertNotIn('expires_at', delegate)
        self.assertEqual(self.ledger.list(), [delegate])
        ask = self.ledger.ask(**self.terms, thread='thread', now=NOW)
        self.record()
        self.assertEqual(self.ledger.list(True), [ask])

    def test_record_is_ordinary_exact_terms_and_never_retains_request_text(self):
        delegate = self.delegate()
        row = self.record()
        self.assertEqual(row['kind'], 'record')
        self.assertEqual(row['delegation'], delegate['id'])
        self.assertEqual(row['quote'], f'delegated:moni:agent-bus:{REQUEST}')
        self.assertEqual(row['source'], f'agent-bus:{REQUEST}')
        self.assertEqual(row['expires_at'], (NOW + dt.timedelta(hours=2)).isoformat())
        self.assertEqual(set(row), {'id', 'kind', 'logged_at', 'vendor', 'item', 'amount', 'currency',
            'recurring', 'at', 'expires_at', 'quote', 'source', 'principal', 'bus_request', 'delegation'})
        self.assertEqual(self.ledger.verify(**self.terms, now=NOW), row)
        for change in ({'amount': 201}, {'currency': 'USD'}, {'item': 'other'},
                       {'recurring': 'monthly'}, {'vendor': 'amazon'}):
            with self.subTest(change=change), self.assertRaises(go.ApprovalError):
                self.ledger.verify(**{**self.terms, 'now': NOW, **change})
        with self.assertRaises(go.ApprovalError):
            self.ledger.verify(**self.terms, now=NOW + dt.timedelta(hours=2))

    def test_no_or_revoked_delegate_refuses_but_issued_records_keep_window(self):
        with self.assertRaisesRegex(go.ApprovalError, '^NO_STANDING_DELEGATION:'):
            self.record()
        delegate = self.delegate()
        record = self.record()
        self.ledger.close('revoke', delegate['id'], quote='stop delegation', source='owner/msg',
                          at=NOW.isoformat(), now=NOW)
        self.refuse('NO_STANDING_DELEGATION', item='second')
        self.assertEqual(self.ledger.verify(**self.terms, now=NOW)['id'], record['id'])
        replacement = self.delegate()
        self.assertNotEqual(delegate['id'], replacement['id'])
        self.refuse('DUPLICATE_DELEGATED_RECORD')

    def test_delegation_only_supports_moni_on_bus(self):
        for principal, channel in [('owner', 'agent-bus'), ('moni', 'chat'), ('group-test', 'agent-bus')]:
            with self.subTest(principal=principal, channel=channel), self.assertRaises(go.ApprovalError):
                self.delegate(principal=principal, channel=channel)
        self.assertFalse(self.ledger.root.exists())
        self.delegate()
        self.refuse('UNSUPPORTED_DELEGATION', principal='owner')

    def test_bus_refusal_matrix(self):
        self.delegate()
        cases = [({'from_slug': 'owner'}, 'BUS_WRONG_SENDER'),
                 ({'from_slug': 'group-test'}, 'BUS_WRONG_SENDER'),
                 ({'to_slug': 'moni'}, 'BUS_WRONG_TARGET')]
        cases += [({'status': status}, 'BUS_REQUEST_CLOSED')
                  for status in ('done', 'declined', 'done_late', 'unknown', '')]
        cases += [({'created_at': int((NOW + delta).timestamp() * 1000)}, 'BUS_REQUEST_STALE')
                  for delta in (dt.timedelta(hours=-25), dt.timedelta(milliseconds=1))]
        cases += [({'created_at': value}, 'BUS_UNREADABLE') for value in ('invalid', 1.5)]
        for changes, reason in cases:
            with self.subTest(changes=changes):
                update_bus(self.db, from_slug='moni', to_slug='owner', status='open',
                           created_at=int(NOW.timestamp() * 1000))
                update_bus(self.db, **changes)
                self.refuse(reason)

    def test_missing_id_and_invalid_id_forms(self):
        self.delegate()
        for value in ('areq_missing', '', 'areq_', 'areq_x\n', 'areq_x OR 1=1', '../secret'):
            with self.subTest(value=value):
                self.refuse('BUS_REQUEST_MISSING', bus_request=value)

    def test_missing_db_table_and_each_consumed_column_fail_closed(self):
        self.delegate()
        missing = self.root / 'missing.sqlite'
        with patch.dict(os.environ, {'AGENT_BUS_DB': str(missing)}):
            self.refuse('BUS_UNREADABLE')
        self.assertFalse(missing.exists())
        for column in (None, 'id', 'from_slug', 'to_slug', 'status', 'created_at'):
            with self.subTest(column=column):
                path = self.root / f'{column}.sqlite'
                with contextlib.closing(sqlite3.connect(path)) as connection, connection:
                    if column:
                        names = ['id', 'from_slug', 'to_slug', 'status', 'created_at']
                        connection.execute('CREATE TABLE agent_requests (' +
                                           ','.join(n for n in names if n != column) + ')')
                with patch.dict(os.environ, {'AGENT_BUS_DB': str(path)}):
                    self.refuse('BUS_UNREADABLE')

    def test_locked_and_corrupt_db_fail_closed(self):
        self.delegate()
        with contextlib.closing(sqlite3.connect(self.db)) as connection, connection:
            connection.execute('BEGIN EXCLUSIVE')
            self.refuse('BUS_UNREADABLE')
        corrupt = self.root / 'corrupt.sqlite'
        corrupt.write_text('not a database')
        with patch.dict(os.environ, {'AGENT_BUS_DB': str(corrupt)}):
            self.refuse('BUS_UNREADABLE')

    def test_open_pending_timeout_and_exact_24h_boundary(self):
        self.delegate()
        for status in ('open', 'pending', 'timed_out'):
            update_bus(self.db, status=status, created_at=int(NOW.timestamp() * 1000) - bus.MAX_AGE_MS)
            row = self.record(item=status, hours=24)
            self.assertEqual(row['expires_at'], (NOW + dt.timedelta(hours=24)).isoformat())

    def test_duplicate_normalized_vendor_second_item_and_individual_revocation(self):
        self.delegate()
        first = self.record()
        self.refuse('DUPLICATE_DELEGATED_RECORD', vendor=' NOON ')
        self.record(item='second')
        self.refuse('DUPLICATE_DELEGATED_RECORD', now=NOW + dt.timedelta(hours=3))
        self.ledger.close('revoke', first['id'], quote='stop', source='owner/msg', at=NOW.isoformat(), now=NOW)
        self.assertNotEqual(first['id'], self.record()['id'])

    def test_concurrent_delegate_and_record_deduplicate_under_lock(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            ids = list(pool.map(lambda _: self.delegate()['id'], range(8)))
        self.assertEqual(len(set(ids)), 1)
        def record(_):
            try:
                return self.record()['id']
            except go.ApprovalError as exc:
                self.assertTrue(str(exc).startswith('DUPLICATE_DELEGATED_RECORD:'))
                return None
        with ThreadPoolExecutor(max_workers=4) as pool:
            self.assertEqual(sum(r is not None for r in pool.map(record, range(8))), 1)

    def test_cli_lifetimes_refusal_json_and_list(self):
        self.delegate()
        update_bus(self.db, created_at=int(dt.datetime.now(go.UTC).timestamp() * 1000))
        args = ['record-delegated', '--principal', 'moni', '--bus-request', REQUEST,
                '--vendor', 'noon', '--item', self.terms['item'], '--amount', '200', '--currency', 'AED']
        for hours in ('0', '25', 'nan', 'inf', '-1', '1e-10', '1e-20'):
            with self.subTest(hours=hours), patch.object(go, 'Ledger', return_value=self.ledger), \
                    contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(go.main(args + ['--hours', hours]), 2)
                result = json.loads(out.getvalue())
                self.assertEqual(result['error'], 'OWNER_GO_INVALID')
                self.assertTrue(result['reason'].startswith('INVALID_LIFETIME:'))
        with patch.object(go, 'Ledger', return_value=self.ledger), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(go.main(args), 0)
            self.assertEqual(json.loads(out.getvalue())['bus_request'], REQUEST)

    def test_subresolution_lifetime_never_poisons_existing_approvals(self):
        self.delegate()
        original = self.ledger.record(**self.terms, quote='yes', source='test', at=NOW.isoformat(), now=NOW)
        for hours in (-1, 0, 1e-20, 1e-10, 25, float('nan'), float('inf')):
            with self.subTest(hours=hours):
                self.refuse('INVALID_LIFETIME', hours=hours)
                self.assertEqual(self.ledger.verify(**self.terms, now=NOW), original)
        for hours in (1e-9, 0.5, 24):
            with self.subTest(hours=hours):
                row = self.record(item=str(hours), hours=hours)
                self.assertGreater(go.timestamp(row['expires_at']), go.timestamp(row['at']))

    def test_refusal_rollup_preserves_component_and_reason(self):
        import toollog
        with self.assertRaisesRegex(go.ApprovalError, '^NO_STANDING_DELEGATION:'):
            self.record()
        summary = toollog.rollup()
        self.assertEqual(summary['errorsByComponent']['owner-go'], {'NO_STANDING_DELEGATION': 1})
        self.assertEqual(summary['topErrors'][0]['tag'], 'NO_STANDING_DELEGATION')

    def test_logs_keep_metadata_and_hash_ids_without_text(self):
        delegate = self.delegate(quote='PRIVATE OWNER QUOTE')
        self.record(item='PRIVATE ITEM')
        self.refuse('DUPLICATE_DELEGATED_RECORD', item='PRIVATE ITEM')
        self.ledger.close('revoke', delegate['id'], quote='PRIVATE STOP', source='msg', at=NOW.isoformat(), now=NOW)
        raw = ''.join(p.read_text() for p in (self.root / 'logs/orders').glob('*.ndjson'))
        rows = [json.loads(line) for line in raw.splitlines()]
        self.assertEqual([r['name'] for r in rows], ['delegate.created', 'delegated_record.created',
                                                   'delegated_record.refused', 'delegate.revoked'])
        self.assertEqual(rows[1]['ids']['requestId'], hashlib.sha256(REQUEST.encode()).hexdigest()[:16])
        self.assertEqual(rows[1]['props'], dict(merchant='noon', amountMinor=200, currency='AED', hours=2))
        self.assertEqual(rows[2]['props']['reason'], 'DUPLICATE_DELEGATED_RECORD')
        self.assertNotIn('PRIVATE', raw)


if __name__ == '__main__':
    unittest.main()
