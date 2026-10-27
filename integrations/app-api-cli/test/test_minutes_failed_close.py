from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

import commerce_journal as j
import commerce_minutes_disposition as d
import noon_minutes_checkout as m

FLOW = '10000000-0000-4000-8000-0000000000aa'
ORDER = 'IAEGTEST1482FAILED'
ACCOUNT = '1' * 64
AMOUNT = 48265


def order_snap(status='failed', total=0, echoed=ORDER, token='PRIVATE-INTENT'):
    wire = {'orderNr': echoed, 'statusCode': status, 'orderTotal': total, 'paymentIntentToken': token,
            'paymentErrorMsg': 'payment failed', 'isPaymentSubscriptionUsed': False}
    return m.Snapshot(wire, m.project_order_get(wire, ORDER), time.time())


def intent(status='payment_ready_to_redirect', txn='3DS_ENROLL_INITIATED', authorized=0, captured=0):
    wire = {'status': status, 'transaction_status': txn, 'reference': ORDER, 'error_code': None,
            'is_3ds_failure': False, 'authorized_amount': authorized, 'captured_amount': captured}
    return m.Snapshot(wire, m.project_payment_status(wire, ORDER, AMOUNT), time.time())


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

    def test_cancelled_passes(self):
        self.assertEqual(self.gate(snap=order_snap(status='cancelled'))['order_status'], 'cancelled')


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
        c = Mock()
        c.order_status.return_value = kw.get('snap', order_snap())
        c.active_orders.return_value = SimpleNamespace(projection=kw.get('act', active()))
        c.payment_intent_status.return_value = kw.get('pay', intent())
        return c

    def test_reads_then_closes_without_sends(self):
        self.placed()
        c = self.client()
        out = self.run_close(c)
        self.assertEqual(out['state'], 'RELEASED')
        self.assertFalse(out['financial_send'] or out['financial_retry'])
        c.payment_intent_status.assert_called_once_with(order=ORDER, client_secret='PRIVATE-INTENT',
                                                        total_minor=AMOUNT, timeout=25)
        for name in ('complete_payment', 'place_order', 'sync'):
            getattr(c, name).assert_not_called()
        self.assertNotIn('PRIVATE-INTENT', str(out))
        self.assertNotIn(ACCOUNT, str(out))

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
        c.order_status.assert_not_called()

    def test_live_paid_order_keeps_flow(self):
        self.placed()
        with self.assertRaisesRegex(j.JournalError, 'MINUTES_FAILED_CLOSE_ORDER_NOT_FAILED'):
            self.run_close(self.client(snap=order_snap(status='confirmed')))
        self.assertEqual(j.inspect(FLOW)['state'], 'ACTIVE')


if __name__ == '__main__':
    unittest.main()
