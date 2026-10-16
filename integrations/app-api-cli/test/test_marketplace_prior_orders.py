"""Expired checkout records must not block a paid, still-delivering old order."""
import copy
from contextlib import ExitStack, redirect_stdout
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import commerce_journal as journal
import commerce_main_order as main
import commerce_supermall_order as supermall
import noon_marketplace_checkout as market
import test_commerce_main_order as main_test
import test_commerce_supermall_order as supermall_test


PRIOR_ORDER = 'NOLDPAID1'


def paid_detail():
    # Sanitized projection of the 2026-10-16 live order-v2 response. The
    # active-list "confirmed" state alone is deliberately not payment proof.
    return {'orderNr': PRIOR_ORDER, 'paymentMethodCode': 'cc_noonpay',
            'payment': {'title': 'Paid with', 'paymentMethodCode': 'cc_noonpay',
                        'paymentMethods': [{'code': 'mastercard', 'amount': '248.56'}]},
            'invoice': {'sections': [{'entries': [
                {'title': 'Subtotal (3 items)', 'amount': '\ue001 238.56'},
                {'title': 'Shipping fee', 'amount': '\ue001 10.00'}]},
                {'entries': [{'title': '<strong>Total paid</strong> <small>(inc. VAT)</small>',
                              'amount': '<strong>\ue001 248.56</strong>'}]}]},
            'itemGroups': [{'subStatus': {'highStatusCode': 'confirmed'}},
                           {'subStatus': {'highStatusCode': 'delivered'}}]}


class PriorOrderTests(unittest.TestCase):
    def make_flow(self, stack, lane, *, detail=None, status_error=None):
        temp = stack.enter_context(tempfile.TemporaryDirectory())
        stack.enter_context(patch.object(journal, 'ROOT', Path(temp).resolve() / 'commerce'))
        module, fixture = ((main, main_test) if lane == 'main'
                           else (supermall, supermall_test))
        stack.enter_context(patch.object(module.receipts, 'ROOT', Path(temp).resolve() / 'commerce'))
        responses = fixture.happy_responses(
            cart=[fixture.cart_state(empty=True), fixture.cart_state(), fixture.cart_state()],
            order_status=status_error or market.MarketplaceError('CHECKOUT_ORDER_NOT_FOUND',
                                                                 http_status=400),
            order_detail=paid_detail() if detail is None else detail)
        flow, harness = fixture.make_flow(responses)
        stack.enter_context(patch.object(module, 'active_marketplace_orders', return_value=[
            {'order': PRIOR_ORDER, 'raw_status': 'confirmed'}]))
        stack.enter_context(patch.object(module.urllib.request, 'build_opener',
            return_value=fixture.patched_resolve(fixture.FIXTURE['search'])()))
        stack.enter_context(redirect_stdout(io.StringIO()))
        return flow, harness

    def test_expired_paid_prior_order_allows_prepare_but_never_places(self):
        for lane in ('main', 'supermall'):
            with self.subTest(lane=lane), ExitStack() as stack:
                flow, harness = self.make_flow(stack, lane)
                result = flow.prepare_only()
                self.assertTrue(result['prepared_only'])
                names = [name for name, _, _ in harness.calls]
                self.assertEqual(names[:2], ['order_status', 'order_detail'])
                self.assertNotIn('place', names)
                self.assertNotIn('payment_complete', names)
                self.assertEqual(journal.inspect(flow.flow_id)['state'], 'ACTIVE')

    def test_guard_and_prepare_share_the_paid_prior_order_check(self):
        for lane in ('main', 'supermall'):
            with self.subTest(lane=lane), ExitStack() as stack:
                flow, harness = self.make_flow(stack, lane)
                result = flow.guard()
                self.assertEqual(result['prior_orders_paid'], [
                    {'order': PRIOR_ORDER, 'status': 'success'}])
                self.assertEqual([name for name, _, _ in harness.calls],
                                 ['cart', 'order_status', 'order_detail'])
                self.assertFalse(flow.opened)

    def test_unproved_or_conflicting_detail_blocks_before_any_mutation(self):
        changes = [
            lambda d: d.update(orderNr='NOTHER1'),
            lambda d: d.pop('payment'),
            lambda d: d['payment'].update(title='Pay with'),
            lambda d: d.update(paymentMethodCode='cod'),
            lambda d: d['payment'].update(paymentMethodCode='cod'),
            lambda d: d['payment']['paymentMethods'][0].update(amount='1.00'),
            lambda d: d['payment']['paymentMethods'][0].update(amount='0.00'),
            lambda d: d['payment'].update(paymentMethods=[]),
            lambda d: d.pop('invoice'),
            lambda d: d['invoice']['sections'][-1]['entries'][0].update(title='Total'),
            lambda d: d['invoice']['sections'][-1]['entries'][0].update(amount='USD 248.56'),
            lambda d: d['invoice']['sections'].append(copy.deepcopy(d['invoice']['sections'][-1])),
            lambda d: d.update(paymentError='declined'),
        ]
        for lane in ('main', 'supermall'):
            for index, change in enumerate(changes):
                with self.subTest(lane=lane, change=index), ExitStack() as stack:
                    detail = paid_detail()
                    change(detail)
                    flow, harness = self.make_flow(stack, lane, detail=detail)
                    with self.assertRaisesRegex((journal.JournalError, market.MarketplaceError),
                                                'ACTIVE_ORDER_PRESENT|ORDER_MISMATCH'):
                        flow.prepare_only()
                    self.assertFalse(flow.opened)
                    self.assertEqual([name for name, _, _ in harness.calls],
                                     ['order_status', 'order_detail'])

    def test_generic_http_or_auth_failure_does_not_use_detail_fallback(self):
        for lane in ('main', 'supermall'):
            for code in ('HTTP_400', 'HTTP_500', 'AUTH_EXPIRED', 'READ_FAILED'):
                with self.subTest(lane=lane, code=code), ExitStack() as stack:
                    flow, harness = self.make_flow(stack, lane,
                        status_error=market.MarketplaceError(code))
                    with self.assertRaisesRegex(market.MarketplaceError, code):
                        flow.prepare_only()
                    self.assertEqual([name for name, _, _ in harness.calls], ['order_status'])
                    self.assertFalse(flow.opened)

    def test_pending_checkout_does_not_fall_back_to_old_paid_detail(self):
        for lane in ('main', 'supermall'):
            for data in ({'status': 'pending'}, {'status': 'failed'},
                         {'status': 'success', 'paymentErrorMsg': 'declined'}):
                with self.subTest(lane=lane, data=data), ExitStack() as stack:
                    flow, harness = self.make_flow(stack, lane)
                    harness.responses['order_status'] = data
                    with self.assertRaisesRegex(journal.JournalError, 'ACTIVE_ORDER_PRESENT'):
                        flow.prepare_only()
                    self.assertEqual([name for name, _, _ in harness.calls], ['order_status'])
                    self.assertFalse(flow.opened)

    def test_new_placement_confirmation_never_uses_prior_order_fallback(self):
        for lane in ('main', 'supermall'):
            with self.subTest(lane=lane), ExitStack() as stack:
                flow, harness = self.make_flow(stack, lane)
                flow.order = PRIOR_ORDER
                flow.review = {'payable_minor': 24856}
                with self.assertRaisesRegex(market.MarketplaceError, 'CHECKOUT_ORDER_NOT_FOUND'):
                    flow.await_success(attempts=1, sleep=lambda _: None)
                self.assertEqual([name for name, _, _ in harness.calls], ['order_status'])


if __name__ == '__main__':
    unittest.main()
