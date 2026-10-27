from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from decimal import Decimal
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

import commerce_journal as j
import commerce_minutes_disposition as d
import noon_minutes_checkout as m
from noon_checkout import fingerprint

FLOW = '10000000-0000-4000-8000-0000000000aa'
ORDER = 'IAEGTEST1482FAILED'
ACCOUNT = '1' * 64
AMOUNT = 48265


def order_snap(status='failed', total=Decimal('0.00'), echoed=ORDER, token='PRIVATE-INTENT'):
    wire = {'orderNr': echoed, 'statusCode': status, 'orderTotal': total, 'paymentIntentToken': token,
            'paymentErrorMsg': 'payment failed', 'isPaymentSubscriptionUsed': False}
    return m.Snapshot(wire, m.project_order_get(wire, ORDER), time.time())


def intent(status='payment_failed', txn='FAILED', authorized=Decimal('0.00'), captured=Decimal('0.00')):
    wire = {'status': status, 'transaction_status': txn, 'reference': ORDER, 'error_code': None,
            'is_3ds_failure': False, 'authorized_amount': authorized, 'captured_amount': captured}
    return m.Snapshot(wire, m.project_payment_status(wire, ORDER, AMOUNT), time.time())


def order_wire(status='failed', total=Decimal('0.00'), token='PRIVATE-INTENT'):
    return {'orderNr': ORDER, 'statusCode': status, 'orderTotal': total, 'paymentIntentToken': token,
            'paymentErrorMsg': 'payment failed', 'isPaymentSubscriptionUsed': False, 'success': True}


def intent_wire(status='payment_failed', txn='FAILED', authorized=Decimal('0.00'), captured=Decimal('0.00')):
    return {'status': status, 'transaction_status': txn, 'reference': ORDER, 'error_code': None,
            'is_3ds_failure': False, 'authorized_amount': authorized, 'captured_amount': captured, 'success': True}


def active(*orders):
    return {'active': [{'order': o, 'raw_status': 'confirmed', 'payment_intent_present': False} for o in orders],
            'count': len(orders), 'resend_allowed': False}


class JournalCase(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        p = patch.object(j, 'ROOT', Path(temp.name).resolve() / 'commerce'); p.start(); self.addCleanup(p.stop)
        j.open_flow(flow_id=FLOW, app='noon', vertical='minutes', account_hash=ACCOUNT, scope_hash='2' * 64)

    def placed(self, *, payment=True, payment_outcome='RESPONSE_RECEIVED'):
        j.consume(FLOW, 'sync', kind='cart', request_hash='3' * 64, cart_hash='4' * 64)
        j.observe(FLOW, 'sync', outcome='RESPONSE_RECEIVED', evidence_hash='5' * 64)
        j.consume(FLOW, 'place', kind='place', request_hash='6' * 64, cart_hash='4' * 64,
                  review_hash='7' * 64, payable_minor=AMOUNT)
        j.observe(FLOW, 'place', outcome='ORDER_ID_RECEIVED', evidence_hash='8' * 64, order_id=ORDER)
        if payment:
            self.pay()
            j.observe(FLOW, 'payment_complete', outcome=payment_outcome, evidence_hash='a' * 64, order_id=ORDER)

    def pay(self):
        j.consume(FLOW, 'payment_complete', kind='payment', request_hash='9' * 64, cart_hash='4' * 64,
                  review_hash='7' * 64, payable_minor=AMOUNT, payment_order_id=ORDER)

    def later(self):
        return time.time() + j.MINUTES_FAILED_CLOSE_MIN_AGE + 1

    def evidence(self, **over):
        ev = d.failed_uncaptured_evidence(order_snap(), active(), intent(), order=ORDER, reserved_minor=AMOUNT)
        ev.update({'account_hash': ACCOUNT, **over})
        return ev


class JournalCloseTests(JournalCase):
    def test_active_flow_with_observed_payment_closes_and_frees_account(self):
        self.placed()
        local = j.inspect(FLOW)
        self.assertEqual(local['state'], 'ACTIVE')
        with self.assertRaisesRegex(j.JournalError, 'JOURNAL_ACCOUNT_RECONCILIATION_REQUIRED'):
            j.require_account_available('noon', ACCOUNT)
        out = j.close_minutes_failed_uncaptured(FLOW, evidence=self.evidence(), expected_local=local, now=self.later())
        self.assertEqual(out['state'], 'RELEASED')
        self.assertFalse(out['retry_allowed'])
        after = j.inspect(FLOW)
        self.assertEqual(after['reserved_minor'], AMOUNT)
        self.assertEqual(after['order_id'], ORDER)
        self.assertTrue(j.require_account_available('noon', ACCOUNT))
        # Terminal: no further observation, resume or second close.
        with self.assertRaisesRegex(j.JournalError, 'JOURNAL_FLOW_RELEASED'):
            j.observe(FLOW, 'payment_complete', outcome='PAYMENT_REPORTED_SUCCESS', evidence_hash='b' * 64, order_id=ORDER)
        with self.assertRaisesRegex(j.JournalError, 'MINUTES_FAILED_FLOW_REQUIRED'):
            j.close_minutes_failed_uncaptured(FLOW, evidence=self.evidence(), expected_local=local, now=self.later())
        with self.assertRaises(j.JournalError):
            self.pay()

    def test_fenced_payment_failed_flow_also_closes(self):
        self.placed(payment_outcome='PAYMENT_FAILED')
        local = j.inspect(FLOW)
        self.assertEqual(local['state'], 'FENCED')
        self.assertEqual(j.close_minutes_failed_uncaptured(FLOW, evidence=self.evidence(),
                         expected_local=local, now=self.later())['state'], 'RELEASED')

    def test_too_early_refuses(self):
        self.placed()
        with self.assertRaisesRegex(j.JournalError, 'MINUTES_FAILED_CLOSE_TOO_EARLY'):
            j.minutes_failed_close_precheck(FLOW)
        with self.assertRaisesRegex(j.JournalError, 'MINUTES_FAILED_CLOSE_TOO_EARLY'):
            j.close_minutes_failed_uncaptured(FLOW, evidence=self.evidence(), expected_local=j.inspect(FLOW))

    def test_old_place_recent_payment_refuses(self):
        # place is long past the grace, but the payment was sent moments ago: still in its 3DS window.
        self.placed(payment=False)
        place_time = time.time() - 3 * j.MINUTES_FAILED_CLOSE_MIN_AGE
        with j._db() as db:
            db.execute("UPDATE observations SET observed_at=? WHERE flow_id=? AND operation='place'", (place_time, FLOW))
        self.pay()
        j.observe(FLOW, 'payment_complete', outcome='PAYMENT_FAILED', evidence_hash='a' * 64, order_id=ORDER)
        recent = time.time()
        with self.assertRaisesRegex(j.JournalError, 'MINUTES_FAILED_CLOSE_TOO_EARLY'):
            j.minutes_failed_close_precheck(FLOW, now=recent)
        with self.assertRaisesRegex(j.JournalError, 'MINUTES_FAILED_CLOSE_TOO_EARLY'):
            j.close_minutes_failed_uncaptured(FLOW, evidence=self.evidence(), expected_local=j.inspect(FLOW), now=recent)
        self.assertEqual(j.inspect(FLOW)['state'], 'FENCED')

    def test_success_observation_vetoes(self):
        self.placed(payment_outcome='PAYMENT_REPORTED_SUCCESS')
        with self.assertRaisesRegex(j.JournalError, 'MINUTES_FAILED_CLOSE_SUCCESS_ALREADY_OBSERVED'):
            j.close_minutes_failed_uncaptured(FLOW, evidence=self.evidence(), expected_local=j.inspect(FLOW), now=self.later())

    def test_unobserved_send_refuses(self):
        self.placed(payment=False)
        self.pay()
        with self.assertRaisesRegex(j.JournalError, 'MINUTES_FAILED_CLOSE_FINANCIAL_HISTORY_INVALID'):
            j.minutes_failed_close_precheck(FLOW, now=self.later())

    def test_mismatched_evidence_or_changed_local_refuses(self):
        self.placed()
        local = j.inspect(FLOW)
        for bad in ({'order': 'IAEGOTHER'}, {'account_hash': '9' * 64}, {'amount_minor': AMOUNT - 1}):
            with self.assertRaisesRegex(j.JournalError, 'MINUTES_FAILED_CLOSE_CHANGED'):
                j.close_minutes_failed_uncaptured(FLOW, evidence=self.evidence(**bad), expected_local=local, now=self.later())
        for bad in ({'captured_minor': 1}, {'provider_order_failed': False}, {'order_active': True}):
            with self.assertRaisesRegex(j.JournalError, 'MINUTES_FAILED_CLOSE_EVIDENCE_REQUIRED'):
                j.close_minutes_failed_uncaptured(FLOW, evidence=self.evidence(**bad), expected_local=local, now=self.later())
        stale = {**local, 'operations': local['operations'][:-1]}
        with self.assertRaisesRegex(j.JournalError, 'MINUTES_FAILED_CLOSE_CHANGED'):
            j.close_minutes_failed_uncaptured(FLOW, evidence=self.evidence(), expected_local=stale, now=self.later())
        self.assertEqual(j.inspect(FLOW)['state'], 'ACTIVE')

    def test_other_verticals_refuse(self):
        other = '10000000-0000-4000-8000-0000000000bb'
        j.open_flow(flow_id=other, app='noon', vertical='nownow', account_hash='3' * 64, scope_hash='2' * 64)
        with self.assertRaisesRegex(j.JournalError, 'MINUTES_FAILED_FLOW_REQUIRED'):
            j.minutes_failed_close_precheck(other)


class EvidenceGateTests(unittest.TestCase):
    def gate(self, snap=None, act=None, pay='default'):
        return d.failed_uncaptured_evidence(snap or order_snap(), act or active(),
                                            intent() if pay == 'default' else pay, order=ORDER, reserved_minor=AMOUNT)

    def test_live_shape_passes(self):
        ev = self.gate(act=active('IAEGANOTHERORDER'))
        j.digest(ev)  # Decimal wire amounts must not break the journal evidence hash
        self.assertTrue(ev['provider_order_failed'] and ev['uncaptured_at_check'])
        self.assertNotIn('PRIVATE-INTENT', str(ev))

    def test_refusals(self):
        cases = {
            'MINUTES_FAILED_CLOSE_ORDER_NOT_FAILED': dict(snap=order_snap(status='confirmed')),
            'MINUTES_FAILED_CLOSE_ORDER_TOTAL_NOT_ZERO': dict(snap=order_snap(total=482.65)),
            'MINUTES_FAILED_CLOSE_EXACT_ORDER_REQUIRED': dict(snap=order_snap(echoed=None)),
            'MINUTES_FAILED_CLOSE_ORDER_STILL_ACTIVE': dict(act=active(ORDER)),
            'MINUTES_FAILED_CLOSE_INTENT_READ_REQUIRED': dict(pay=None),
        }
        for code, kw in cases.items():
            with self.subTest(code), self.assertRaisesRegex(j.JournalError, code):
                self.gate(**kw)
        for pay in (intent(status='payment_confirmed', txn='CAPTURED', authorized=482.65, captured=482.65),
                    intent(txn='AUTHORIZED', authorized=482.65), intent(captured=1),
                    intent(txn='AUTHORISATION_PENDING'), intent(authorized=None)):
            with self.subTest(pay.projection), self.assertRaisesRegex(j.JournalError, 'MINUTES_FAILED_CLOSE_INTENT_NOT_UNCAPTURED'):
                self.gate(pay=pay)

    def test_in_progress_intent_with_zero_amounts_refuses(self):
        # A live intent can still settle; zero amounts alone must not release the flow.
        for pay in (intent(status='payment_pending', txn='CREATED'),
                    intent(status='payment_ready_to_redirect', txn='3DS_ENROLL_INITIATED'),
                    intent(status='payment_confirmed', txn='NEUTRAL')):
            with self.subTest(pay.projection), self.assertRaisesRegex(j.JournalError, 'MINUTES_FAILED_CLOSE_INTENT_NOT_UNCAPTURED'):
                self.gate(pay=pay)

    def test_payment_confirmed_alone_refuses_with_zero_amounts(self):
        with self.assertRaisesRegex(j.JournalError, 'MINUTES_FAILED_CLOSE_INTENT_NOT_UNCAPTURED'):
            self.gate(pay=intent(status='payment_confirmed', txn='NEUTRAL'))

    def test_captured_txn_alone_refuses_with_zero_amounts(self):
        with self.assertRaisesRegex(j.JournalError, 'MINUTES_FAILED_CLOSE_INTENT_NOT_UNCAPTURED'):
            self.gate(pay=intent(status='payment_failed', txn='CAPTURED'))

    def test_cancelled_passes(self):
        self.assertEqual(self.gate(snap=order_snap(status='cancelled'))['order_status'], 'cancelled')

    def test_pending_status_and_echo_mismatch_refuse(self):
        with self.assertRaisesRegex(j.JournalError, 'MINUTES_FAILED_CLOSE_ORDER_NOT_FAILED'):
            self.gate(snap=order_snap(status='pending'))
        with self.assertRaisesRegex(Exception, 'ORDER_MISMATCH'):
            order_snap(echoed='IAEGOTHERORDER')

    def test_authorized_or_captured_alone_refuses(self):
        for pay in (intent(authorized=Decimal('1.00')), intent(captured=Decimal('1.00'))):
            with self.subTest(pay.wire), self.assertRaisesRegex(j.JournalError, 'MINUTES_FAILED_CLOSE_INTENT_NOT_UNCAPTURED'):
                self.gate(pay=pay)


class CloseFailedFlowTests(JournalCase):
    def run_close(self, client, receipts_list=None, changed=False):
        receipts_list = receipts_list if receipts_list is not None else [
            SimpleNamespace(operation='place', order_id=ORDER, currency='AED', payable_minor=AMOUNT, state='ORDER_ID_RECEIVED')]
        store = Mock()
        store.snapshot.return_value = SimpleNamespace(receipts=receipts_list)

        @contextmanager
        def locked():
            yield SimpleNamespace(receipts=receipts_list + ([SimpleNamespace(state='PAYMENT_REPORTED_SUCCESS')] if changed else []))
        store.locked_snapshot = locked
        later = time.time() + j.MINUTES_FAILED_CLOSE_MIN_AGE + 1
        with patch.object(d.receipts, 'load', return_value=store), patch.object(j.time, 'time', return_value=later), \
                patch.object(j, 'consume', side_effect=AssertionError('no sends')):
            return d.close_failed(FLOW, client=client)

    def client(self, **kw):
        # Real MinutesCheckout over a fake transport; the transport records every route it sees.
        self.routes = []
        bodies = {
            'order_get': kw.get('order_body', order_wire()),
            'order_get_active': kw.get('active_body', {'activeOrders': [], 'success': True}),
            'payment_status': kw.get('payment_body', intent_wire()),
        }

        def transport(route, headers, deadline, payload, *, response_observer):
            self.routes.append(route)
            response_observer(m.ResponseObservation('https://' + m.ROUTES[route][1] + m.ROUTES[route][2], 200, ()))
            return bodies[route]
        # run_close patches the global clock to the future; the home must share that clock.
        headers = {'x-addresscode': 'C', 'x-addresskey': 'K'}
        home = m.AccountHome('minutes', ACCOUNT, fingerprint('C', 'K'), time.time() + j.MINUTES_FAILED_CLOSE_MIN_AGE + 1)
        return m.MinutesCheckout(headers, home, request=transport,
                                 receipt=lambda record: True,
                                 response_cookies=lambda *a, **k: True)

    def test_reads_then_closes_without_sends(self):
        self.placed()
        c = self.client()
        out = self.run_close(c)
        self.assertEqual(out['state'], 'RELEASED')
        self.assertFalse(out['financial_send'] or out['financial_retry'])
        # Only the three reads reached the transport; no write route, no send.
        self.assertEqual(sorted(self.routes), ['order_get', 'order_get_active', 'payment_status'])
        self.assertFalse(set(self.routes) & m.WRITES)
        self.assertNotIn('PRIVATE-INTENT', str(out))
        self.assertNotIn(ACCOUNT, str(out))

    def test_second_close_refuses_and_writes_once(self):
        self.placed()
        self.run_close(self.client())
        with self.assertRaisesRegex(j.JournalError, 'MINUTES_FAILED_FLOW_REQUIRED'):
            self.run_close(self.client())
        with j._db() as db:
            rows = db.execute("SELECT COUNT(*) FROM observations WHERE flow_id=? AND outcome='MINUTES_CLOSED_FAILED_UNCAPTURED'",
                              (FLOW,)).fetchone()[0]
        self.assertEqual(rows, 1)

    def test_receipt_change_during_reads_vetoes(self):
        self.placed()
        with self.assertRaisesRegex(j.JournalError, 'MINUTES_FAILED_CLOSE_RECEIPTS_CHANGED'):
            self.run_close(self.client(), changed=True)
        self.assertEqual(j.inspect(FLOW)['state'], 'ACTIVE')

    def test_paid_receipt_or_missing_place_refuses_before_reads(self):
        self.placed()
        c = self.client()
        for rec in ([], [SimpleNamespace(operation='place', order_id=ORDER, currency='AED', payable_minor=AMOUNT, state='ORDER_ID_RECEIVED'),
                         SimpleNamespace(operation='payment', order_id=ORDER, currency='AED', payable_minor=AMOUNT,
                                         state='PAYMENT_REPORTED_SUCCESS')]):
            with self.assertRaisesRegex(j.JournalError, 'EXACT_PLACE_RECEIPT_REQUIRED'):
                self.run_close(c, receipts_list=rec)
        self.assertEqual(self.routes, [])

    def test_live_paid_order_keeps_flow(self):
        self.placed()
        with self.assertRaisesRegex(j.JournalError, 'MINUTES_FAILED_CLOSE_ORDER_NOT_FAILED'):
            self.run_close(self.client(order_body=order_wire(status='confirmed')))
        self.assertEqual(j.inspect(FLOW)['state'], 'ACTIVE')


if __name__ == '__main__':
    unittest.main()
