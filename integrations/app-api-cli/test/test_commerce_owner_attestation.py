import contextlib
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock, patch
import uuid

import commerce_cli as cli
import commerce_journal as journal
import commerce_receipts as receipts
import commerce_reconcile as reconcile
from commerce_flow import FlowGate, account_hash
import talabat_http_checkout as h
from talabat_place_contract import PlaceObservation


class OwnerAttestationTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve() / 'commerce'
        for module in (journal, receipts):
            patcher = patch.object(module, 'ROOT', self.root)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.flow = str(uuid.uuid4())
        self.saved = {'expected_profile': {'id': 77}}
        self.binding = dict(flow_id=self.flow, app='talabat', vertical='restaurants',
                            account_hash=account_hash(self.saved), scope_hash='2' * 64)
        self.store = receipts.create(**self.binding)
        self.gate = FlowGate(**self.binding, receipt_sink=self.store, request_check=lambda _: True)
        self.record = dict(version=1, app='talabat', flow_id=self.flow,
                           account_binding=self.binding['account_hash'], request_sha256='3' * 64,
                           cart_binding='4' * 64, review_sha256='5' * 64, currency='AED',
                           payable_minor=6975, state='MAY_HAVE_SENT', operation='place')
        self.gate.before_talabat(self.record)
        self.gate.talabat_receipt({'operation': 'place', 'observation': PlaceObservation(
            'PAYMENT_PENDING', 'PAYMENT_COMPLETION_UNPROVEN', '12345', 'PRIVATE-TXN', '69.75'),
            'http_status': 200})
        self.gate.before_talabat({**self.record, 'operation': 'payment', 'payment_order_id': '12345'})
        self.ctx = h.AsyncPaymentContext('12345', 'PRIVATE-TXN', self.flow, (1.0, 1.0, 1.0),
                                         self.binding['account_hash'], 'PRIVATE-PAYMENT', 'PRIVATE-METADATA')
        self.gate.talabat_receipt({'operation': 'payment', 'context': self.ctx, 'next_index': 0,
            'http_status': 202, 'result': h.PaymentResult('PAYMENT_PENDING', 'TALABAT_ASYNC_STATUS_REQUIRED',
                '12345', 'PRIVATE-TXN', 'PRIVATE-PAYMENT', 'PRIVATE-METADATA')})
        self.poll_receipt('PAYMENT_UNKNOWN', 'STATUS_READ_FAILED_NO_RETRY', 1)
        self.evidence = 'Owner checked card statement on 2026-10-16: no AED 69.75 charge for order 12345.'
        self.auth = Mock()
        self.auth.fresh_before_mutation.return_value.mutation_account.return_value = self.saved
        self.tracking = {'type': 'OrderTrackingScreen', 'common_tracking_event_attributes':
                         {'order_id': '12345', 'delivery_status': 'order_confirmingdelayed'}}
        self.error = {'type': 'error', 'title': 'Payment error', 'subtitle': '', 'exception': '', 'cta': ''}
        self.response = h.WireResponse(200, {'status': 'Error', 'error': self.error, 'errors': self.error})

    def poll_receipt(self, state, reason, index):
        self.gate.talabat_receipt({'operation': 'payment_status', 'context': self.ctx,
            'next_index': index, 'http_status': 200, 'result': h.PaymentResult(state, reason,
                '12345', 'PRIVATE-TXN', 'PRIVATE-PAYMENT', 'PRIVATE-METADATA')})

    def close(self, **kwargs):
        return reconcile.owner_attest_no_charge(self.flow, evidence=self.evidence,
                                                attested_by='owner', auth=self.auth, **kwargs)

    @contextlib.contextmanager
    def provider(self):
        with patch.object(h.orders, 'request', return_value=self.tracking) as tracking, \
                patch.object(h, '_wire', return_value=self.response) as payment:
            yield tracking, payment

    def assert_fenced(self):
        state = journal.inspect(self.flow)
        self.assertEqual(state['state'], 'FENCED')
        self.assertNotIn('owner_attestation', state)
        with self.assertRaisesRegex(journal.JournalError, 'ACCOUNT_RECONCILIATION_REQUIRED'):
            journal.require_account_available('talabat', self.binding['account_hash'])

    def test_cli_close_audits_owner_and_provider_and_frees_only_account_slot(self):
        before = journal.inspect(self.flow)
        with self.provider() as (tracking, payment), \
                patch.object(reconcile, 'CommerceAuth', return_value=self.auth), \
                patch.object(journal, 'consume', side_effect=AssertionError('no sends')), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            code = cli.main(['reconcile-order', self.flow, '--owner-attest-no-charge',
                             '--evidence', self.evidence, '--attested-by', 'owner'])
        self.assertEqual(code, 0, output.getvalue())
        result = json.loads(output.getvalue())
        self.assertEqual(result['state'], 'OWNER_ATTESTED_UNCHARGED')
        self.assertTrue(result['account_fence_lifted'])
        for key in ('financial_send', 'financial_retry', 'retry_allowed', 'provider_no_charge_proven'):
            self.assertFalse(result[key])
        tracking.assert_called_once()
        self.assertEqual(tracking.call_args.args[0], h.orders.TRACKING + '12345')
        payment.assert_called_once()
        self.assertEqual(payment.call_args.args[2:4], ('GET', '/pay/v2/payment/status'))
        self.assertEqual(payment.call_args.kwargs['params'], h.payment_status_params(self.ctx))
        after = journal.inspect(self.flow)
        self.assertEqual(after['operations'], before['operations'])
        self.assertEqual(after['reserved_minor'], 6975)
        audit = after['owner_attestation']
        self.assertEqual(audit['evidence'], self.evidence)
        self.assertEqual(audit['attested_by'], 'owner')
        self.assertEqual(audit['order_id'], '12345')
        self.assertEqual(audit['attested_at'], result['attested_at'])
        self.assertGreater(audit['attested_at'], 0)
        checks = audit['provider_evidence']['checks']
        self.assertEqual(checks[0]['projection']['raw_status'], 'order_confirmingdelayed')
        self.assertEqual(checks[0]['projection']['status'], 'pending confirmation')
        self.assertEqual(checks[1]['projection']['status'], 'error')
        self.assertTrue(checks[1]['projection']['errors_present'])
        self.assertTrue(all(check['checked_at'] and check['projection_hash'] for check in checks))
        for secret in ('PRIVATE-TXN', 'PRIVATE-PAYMENT', 'PRIVATE-METADATA'):
            self.assertNotIn(secret, json.dumps(after))
        with sqlite3.connect(self.root / 'journal.sqlite') as db:
            self.assertEqual(db.execute('SELECT outcome,evidence_hash FROM observations WHERE flow_id=? '
                'ORDER BY sequence DESC LIMIT 1', (self.flow,)).fetchone(),
                ('OWNER_ATTESTED_UNCHARGED', result['evidence_hash']))
        self.assertTrue(journal.require_account_available('talabat', self.binding['account_hash']))
        new_flow = str(uuid.uuid4())
        journal.open_flow(**{**self.binding, 'flow_id': new_flow, 'vertical': 'mart'})
        self.assertEqual(journal.inspect(new_flow)['state'], 'ACTIVE')
        # A new intent cannot steal the old order/cart or reuse an old send.
        with self.assertRaisesRegex(journal.JournalError, 'CART_ALREADY_OWNED'):
            journal.consume(new_flow, 'quote', kind='quote', request_hash='6'*64, cart_hash='4'*64)
        with self.assertRaisesRegex(journal.JournalError, 'FLOW_FENCED'):
            journal.consume(self.flow, 'retry', kind='quote', request_hash='6'*64)
        with self.assertRaisesRegex(journal.JournalError, 'FLOW_OWNER_ATTESTED_UNCHARGED'):
            journal.observe(self.flow, 'payment', outcome='PAYMENT_REPORTED_SUCCESS',
                            order_id='12345', evidence_hash='6'*64)
        with patch.object(cli, 'CommerceAuth', side_effect=AssertionError('no recovery')):
            with self.assertRaisesRegex(journal.JournalError, 'FLOW_OWNER_ATTESTED_UNCHARGED'):
                cli.recover_talabat(self.flow)
        with self.provider() as (tracking, payment):
            with self.assertRaisesRegex(journal.JournalError, 'FENCED_TALABAT_PAYMENT_REQUIRED'):
                self.close()
            tracking.assert_not_called()
            payment.assert_not_called()

    def test_all_required_cli_evidence_flags_fail_before_network(self):
        for flags in (['--owner-attest-no-charge'],
                      ['--owner-attest-no-charge', '--evidence', self.evidence],
                      ['--owner-attest-no-charge', '--attested-by', 'owner'],
                      ['--owner-attest-no-charge', '--attested-by', 'owner', '--evidence', '  '],
                      ['--evidence', self.evidence, '--attested-by', 'owner']):
            with self.subTest(flags=flags), self.provider() as (tracking, payment), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(cli.main(['reconcile-order', self.flow, *flags]), 1)
                tracking.assert_not_called()
                payment.assert_not_called()
                self.assertIn('OWNER_ATTESTATION_', output.getvalue())
        self.assert_fenced()

    def test_provider_active_delivered_and_new_order_states_refuse(self):
        for status in ('order_confirming', 'order_preparing', 'order_almostready', 'order_delivering',
                       'order_delivered', 'future_unmapped_status'):
            self.tracking['common_tracking_event_attributes']['delivery_status'] = status
            with self.subTest(status=status), self.provider() as (_, payment):
                with self.assertRaisesRegex(journal.JournalError, 'ORDER_ACTIVE_OR_DELIVERED|ORDER_STATE_UNSUPPORTED'):
                    self.close()
                payment.assert_not_called()
                self.assert_fenced()

    def test_provider_paid_pending_captured_unknown_and_continuations_refuse(self):
        cases = [(200, {'status': status}) for status in
                 ('success', ' SUCCESS ', 'captured', 'paid', 'authorized', 'pending', 'redirection', 'new')]
        cases += [(200, {'status': 'Error', **extra}) for extra in (
            {'capturedAmount': 69.75}, {'payment': {'status': 'CAPTURED'}},
            {'errors': {'captured': True}}, {'error': {'status': 'success'}},
            {'fallback': {}}, {'redirectUrl': ''}, {'hyperPayCheckoutId': ''}, {'errors': []})]
        cases += [(401, {'status': 'Error'}), (500, {'status': 'Error'}), (None, None)]
        for status, data in cases:
            self.response = h.WireResponse(status, data)
            with self.subTest(status=status, data=data), self.provider():
                with self.assertRaisesRegex(journal.JournalError, 'PAYMENT_SUCCESS_OR_AUTHORIZATION|PAYMENT_STATE_UNSUPPORTED'):
                    self.close()
                self.assert_fenced()

    def test_exact_account_and_order_binding_are_required(self):
        self.auth.fresh_before_mutation.return_value.mutation_account.return_value = {'expected_profile': {'id': 88}}
        with self.provider() as (tracking, payment):
            with self.assertRaisesRegex(journal.JournalError, 'RECOVERY_ACCOUNT_CHANGED'):
                self.close()
            tracking.assert_not_called()
            payment.assert_not_called()
        self.auth.fresh_before_mutation.return_value.mutation_account.return_value = self.saved
        self.tracking['common_tracking_event_attributes']['order_id'] = '99999'
        with self.provider() as (_, payment):
            with self.assertRaisesRegex(h.orders.TalabatError, 'ORDER_MISMATCH'):
                self.close()
            payment.assert_not_called()
        self.assert_fenced()

    def test_failed_provider_read_retains_fence(self):
        with self.provider() as (tracking, _):
            tracking.side_effect = h.orders.TalabatError('NATIVE_READ_TIMEOUT')
            with self.assertRaisesRegex(h.orders.TalabatError, 'NATIVE_READ_TIMEOUT'):
                self.close()
        with self.provider() as (_, payment):
            payment.side_effect = h.orders.TalabatError('NATIVE_READ_FAILED')
            with self.assertRaisesRegex(h.orders.TalabatError, 'NATIVE_READ_FAILED'):
                self.close()
        self.assert_fenced()

    def test_other_lanes_states_and_unobserved_payments_refuse_before_reads(self):
        for column, value in (('app', 'noon'), ('state', 'ACTIVE'), ('order_id', None), ('reserved_minor', 0)):
            with sqlite3.connect(self.root / 'journal.sqlite') as db:
                original = db.execute(f'SELECT {column} FROM flows WHERE id=?', (self.flow,)).fetchone()[0]
                db.execute(f'UPDATE flows SET {column}=? WHERE id=?', (value, self.flow))
            with self.subTest(column=column), self.provider() as (tracking, payment):
                with self.assertRaisesRegex(journal.JournalError, 'FENCED_TALABAT_PAYMENT_REQUIRED'):
                    self.close()
                tracking.assert_not_called()
                payment.assert_not_called()
            with sqlite3.connect(self.root / 'journal.sqlite') as db:
                db.execute(f'UPDATE flows SET {column}=? WHERE id=?', (original, self.flow))
        with sqlite3.connect(self.root / 'journal.sqlite') as db:
            db.execute("UPDATE operations SET state='MAY_HAVE_SENT' WHERE flow_id=? AND name='payment'", (self.flow,))
        with self.provider() as (tracking, payment):
            with self.assertRaisesRegex(journal.JournalError, 'PAYMENT_HISTORY_INVALID'):
                self.close()
            tracking.assert_not_called()
            payment.assert_not_called()
        self.assert_fenced()

    def test_preexisting_success_and_concurrent_success_both_refuse(self):
        def success(*args, **kwargs):
            self.poll_receipt('PAYMENT_REPORTED_SUCCESS', 'EXACT_TRANSACTION_ASYNC_STATUS_SUCCESS', 2)
            return self.response
        with self.provider() as (_, payment):
            payment.side_effect = success
            with self.assertRaisesRegex(journal.JournalError, 'RECEIPTS_CHANGED'):
                self.close()
        self.assert_fenced()
        with self.provider() as (tracking, payment):
            with self.assertRaisesRegex(journal.JournalError, 'PROVIDER_SUCCESS_ALREADY_OBSERVED'):
                self.close()
            tracking.assert_not_called()
            payment.assert_not_called()

    def test_success_receipt_without_journal_observation_also_refuses(self):
        self.store({'operation': 'payment_status', 'context': self.ctx, 'next_index': 2, 'http_status': 200,
            'result': h.PaymentResult('PAYMENT_REPORTED_SUCCESS', 'EXACT_TRANSACTION_ASYNC_STATUS_SUCCESS',
                '12345', 'PRIVATE-TXN', 'PRIVATE-PAYMENT', 'PRIVATE-METADATA')})
        self.assertFalse(journal.payment_reported(self.flow))
        with self.provider() as (tracking, payment):
            with self.assertRaisesRegex(journal.JournalError, 'PROVIDER_SUCCESS_ALREADY_OBSERVED'):
                self.close()
            tracking.assert_not_called()
            payment.assert_not_called()
        self.assert_fenced()

    def test_journal_rechecks_success_before_atomic_commit(self):
        close = journal.close_owner_attested_uncharged
        def race(*args, **kwargs):
            journal.observe(self.flow, 'payment', outcome='PAYMENT_REPORTED_SUCCESS',
                            order_id='12345', evidence_hash='7'*64)
            return close(*args, **kwargs)
        with self.provider(), patch.object(journal, 'close_owner_attested_uncharged', side_effect=race):
            with self.assertRaisesRegex(journal.JournalError, 'PROVIDER_SUCCESS_ALREADY_OBSERVED'):
                self.close()
        self.assert_fenced()

    def test_v1_schema_migrates_once_preserving_operations_and_fence(self):
        before = journal.inspect(self.flow)
        with sqlite3.connect(self.root / 'journal.sqlite') as db:
            db.execute('DROP TABLE owner_attestations')
            db.execute('DROP TABLE duplicate_closures')
            db.execute('DROP INDEX active_account')
            db.execute(journal.SCHEMA_V1['active_account'])
            db.execute('PRAGMA user_version=1')
        self.assertEqual(journal.inspect(self.flow), before)
        with sqlite3.connect(self.root / 'journal.sqlite') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 3)
        with self.provider():
            self.close()
        self.assertEqual(journal.inspect(self.flow)['state'], 'OWNER_ATTESTED_UNCHARGED')

    def test_failed_atomic_close_leaves_no_attestation_or_release(self):
        original_db = journal._db
        @contextlib.contextmanager
        def failing_db():
            with original_db() as db:
                class Proxy:
                    def execute(self, sql, params=()):
                        if sql.startswith('UPDATE flows SET state=') and params[0] == journal.OWNER_ATTESTED_UNCHARGED:
                            raise sqlite3.OperationalError('synthetic write failure')
                        return db.execute(sql, params)
                yield Proxy()
        with self.provider(), patch.object(journal, '_db', failing_db):
            with self.assertRaisesRegex(journal.JournalError, 'BUSY_OR_UNAVAILABLE'):
                self.close()
        self.assert_fenced()


if __name__ == '__main__':
    unittest.main()
