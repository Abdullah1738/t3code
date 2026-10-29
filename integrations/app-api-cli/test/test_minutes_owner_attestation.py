from contextlib import contextmanager
from decimal import Decimal
from types import SimpleNamespace
import io
import contextlib
import json
import time
import unittest
from unittest.mock import Mock, patch

import commerce_cli as cli
import commerce_journal as j
import commerce_minutes_disposition as d
import noon_minutes_checkout as m
from noon_checkout import fingerprint
from test_minutes_failed_close import (FLOW, ORDER, ACCOUNT, AMOUNT, JournalCase, order_wire,
                                       intent_wire, active)

EVIDENCE = 'Abdullah checked his card statement on 27 Oct: no AED 482.65 charge for this order.'
READS = ['order_get', 'order_get_active', 'payment_status']


class OwnerAttestFailedTests(JournalCase):
    def setUp(self):
        super().setUp()
        self.routes = []

    def client(self, order_body=None, active_body=None, payment_body=None):
        self.routes = []
        bodies = {
            'order_get': order_body if order_body is not None else order_wire(status='failed'),
            'order_get_active': active_body if active_body is not None else {'activeOrders': [], 'success': True},
            'payment_status': payment_body if payment_body is not None else intent_wire(
                status='payment_ready_to_redirect', txn='3DS_ENROLL_INITIATED'),
        }

        def transport(route, headers, deadline, payload, *, response_observer):
            self.routes.append(route)
            response_observer(m.ResponseObservation('https://' + m.ROUTES[route][1] + m.ROUTES[route][2], 200, ()))
            return bodies[route]
        home = m.AccountHome('minutes', ACCOUNT, fingerprint('C', 'K'), time.time() + j.MINUTES_FAILED_CLOSE_MIN_AGE + 1)
        return m.MinutesCheckout({'x-addresscode': 'C', 'x-addresskey': 'K'}, home, request=transport,
                                 receipt=lambda record: True, response_cookies=lambda *a, **k: True)

    def run_attest(self, client=None, evidence=EVIDENCE, attested_by='owner', changed=False, receipts_list=None):
        receipts_list = receipts_list if receipts_list is not None else [
            SimpleNamespace(operation='place', order_id=ORDER, currency='AED', payable_minor=AMOUNT, state='ORDER_ID_RECEIVED')]
        store = Mock()
        store.snapshot.return_value = SimpleNamespace(receipts=receipts_list)

        @contextmanager
        def locked():
            yield SimpleNamespace(receipts=receipts_list + ([SimpleNamespace(state='PAYMENT_REPORTED_SUCCESS')] if changed else []))
        store.locked_snapshot = locked
        client = client or self.client()
        later = time.time() + j.MINUTES_FAILED_CLOSE_MIN_AGE + 1
        with patch.object(d.receipts, 'load', return_value=store), patch.object(j.time, 'time', return_value=later), \
                patch.object(j, 'consume', side_effect=AssertionError('no sends')):
            return d.owner_attest_failed(FLOW, evidence=evidence, attested_by=attested_by, client=client)

    def test_live_shape_closes_frees_account_and_keeps_reservation(self):
        self.placed()
        out = self.run_attest()
        self.assertEqual(out['state'], 'OWNER_ATTESTED_UNCHARGED')
        self.assertTrue(out['account_fence_lifted'])
        self.assertEqual(out['evidence']['intent_transaction_status'], '3DS_ENROLL_INITIATED')
        self.assertTrue(out['evidence']['redirect_required'] in (True, False))
        for key in ('financial_send', 'financial_retry', 'retry_allowed', 'provider_no_charge_proven', 'reservation_release_allowed'):
            self.assertFalse(out[key])
        self.assertEqual(sorted(self.routes), READS)
        self.assertFalse(set(self.routes) & m.WRITES)
        self.assertTrue(j.require_account_available('noon', ACCOUNT))
        after = j.inspect(FLOW)
        self.assertEqual(after['state'], 'OWNER_ATTESTED_UNCHARGED')
        self.assertEqual(after['reserved_minor'], AMOUNT)
        self.assertEqual(after['order_id'], ORDER)
        self.assertEqual(after['owner_attestation']['evidence'], EVIDENCE)
        self.assertNotIn('PRIVATE-INTENT', str(out))
        self.assertNotIn(ACCOUNT, str(out))

    def test_missing_or_bad_evidence_refuses_before_any_route(self):
        self.placed()
        for ev, by in ((None, 'owner'), ('   ', 'owner'), ('ok\x00', 'owner'), (EVIDENCE, 'agent')):
            c = self.client()
            with self.subTest(ev=ev, by=by), self.assertRaisesRegex(j.JournalError, 'OWNER_ATTESTATION_EVIDENCE_REQUIRED'):
                self.run_attest(client=c, evidence=ev, attested_by=by)
            self.assertEqual(self.routes, [])
        self.assertEqual(j.inspect(FLOW)['state'], 'ACTIVE')

    def test_confirmed_active_or_total_or_echo_mismatch_refuses(self):
        self.placed()
        cases = {
            'MINUTES_OWNER_ATTEST_ORDER_NOT_FAILED': dict(order_body=order_wire(status='confirmed')),
            'MINUTES_OWNER_ATTEST_ORDER_STILL_ACTIVE': dict(active_body={'activeOrders': [{'orderNr': ORDER, 'statusCode': 'confirmed'}], 'success': True}),
            'MINUTES_OWNER_ATTEST_ORDER_TOTAL_NOT_ZERO': dict(order_body=order_wire(status='failed', total=Decimal('482.65'))),
            'ORDER_MISMATCH': dict(order_body={**order_wire(status='failed'), 'orderNr': 'IAEGOTHER'}),
            'ACTIVE_SCHEMA_CHANGED': dict(active_body={'activeOrders': 'not-a-list', 'success': True}),
        }
        for code, kw in cases.items():
            with self.subTest(code):
                with self.assertRaises(Exception) as ctx:
                    self.run_attest(client=self.client(**kw))
                self.assertIn(code, str(ctx.exception))
                self.assertEqual(j.inspect(FLOW)['state'], 'ACTIVE')

    def test_paid_captured_authorized_or_missing_intent_refuses(self):
        self.placed()
        cases = {
            'MINUTES_OWNER_ATTEST_INTENT_PAID': dict(payment_body=intent_wire(status='payment_confirmed', txn='NEUTRAL')),
            'MINUTES_OWNER_ATTEST_MONEY_MOVED': dict(payment_body=intent_wire(status='payment_failed', txn='CAPTURED')),
            'MINUTES_OWNER_ATTEST_AMOUNT_NOT_ZERO': dict(payment_body=intent_wire(status='payment_failed', txn='CREATED', authorized=Decimal('1.00'))),
            'MINUTES_OWNER_ATTEST_INTENT_READ_REQUIRED': dict(order_body={**order_wire(status='failed'), 'paymentIntentToken': None}),
        }
        for code, kw in cases.items():
            with self.subTest(code), self.assertRaises(j.JournalError) as ctx:
                self.run_attest(client=self.client(**kw))
            self.assertIn(code, str(ctx.exception))
        self.assertEqual(j.inspect(FLOW)['state'], 'ACTIVE')

    def test_inside_grace_window_refuses_before_reads(self):
        self.placed()
        c = self.client()
        with patch.object(d.receipts, 'load', return_value=Mock(snapshot=Mock(return_value=SimpleNamespace(receipts=[
                SimpleNamespace(operation='place', order_id=ORDER, currency='AED', payable_minor=AMOUNT, state='ORDER_ID_RECEIVED')])))), \
                self.assertRaisesRegex(j.JournalError, 'MINUTES_FAILED_CLOSE_TOO_EARLY'):
            d.owner_attest_failed(FLOW, evidence=EVIDENCE, attested_by='owner', client=c)
        self.assertEqual(self.routes, [])

    def test_receipts_changing_during_reads_refuses(self):
        self.placed()
        with self.assertRaisesRegex(j.JournalError, 'MINUTES_OWNER_ATTEST_RECEIPTS_CHANGED'):
            self.run_attest(changed=True)
        self.assertEqual(j.inspect(FLOW)['state'], 'ACTIVE')

    def test_second_attest_refuses_and_writes_one_row(self):
        self.placed()
        self.run_attest()
        with self.assertRaisesRegex(j.JournalError, 'MINUTES_FAILED_FLOW_REQUIRED'):
            self.run_attest()
        with j._db() as db:
            rows = db.execute('SELECT COUNT(*) FROM owner_attestations WHERE flow_id=?', (FLOW,)).fetchone()[0]
        self.assertEqual(rows, 1)

    def test_cli_dispatch_picks_minutes_path_for_noon_minutes(self):
        self.placed()
        out = {'ok': True, 'state': 'OWNER_ATTESTED_UNCHARGED'}
        with patch('commerce_minutes_disposition.owner_attest_failed', return_value=out) as minutes, \
                patch('commerce_reconcile.owner_attest_no_charge', side_effect=AssertionError('talabat path')), \
                contextlib.redirect_stdout(io.StringIO()) as buf:
            code = cli.main(['reconcile-order', FLOW, '--owner-attest-no-charge', '--evidence', EVIDENCE, '--attested-by', 'owner'])
        self.assertEqual(code, 0, buf.getvalue())
        minutes.assert_called_once_with(FLOW, evidence=EVIDENCE, attested_by='owner')
        self.assertEqual(json.loads(buf.getvalue())['state'], 'OWNER_ATTESTED_UNCHARGED')


if __name__ == '__main__':
    unittest.main()
