"""NowNow active-order attribution against an isolated, real journal."""
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import commerce_journal as j
import commerce_nownow_order as c
from test.test_commerce_nownow_order import (
    ADDRESS_REF, FakeAuth, Harness, PRODUCT, STORE, happy_responses, make_flow,
)


ORDER = 'NNGACONCURRENT01'
ACCOUNT = FakeAuth().revalidate('nownow').account_ref


class ActiveOrderTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name).resolve() / 'commerce'
        for module in (j, c.receipts):
            patched = patch.object(module, 'ROOT', root)
            patched.start()
            self.addCleanup(patched.stop)

    def prior(self, *, order=ORDER, store='OTHERSTORE', product=PRODUCT,
              quantity=1, account=ACCOUNT, app='noon', vertical='nownow',
              outcome='COMPLETE'):
        flow = str(uuid.uuid4())
        scope = c._scope_hash(store, [{'product_code': product, 'quantity': quantity}],
                              ADDRESS_REF)
        j.open_flow(flow_id=flow, app=app, vertical=vertical,
                    account_hash=account, scope_hash=scope)
        j.consume(flow, 'place', kind='place', request_hash=j.digest('place'),
                  cart_hash=j.digest({'flow': flow, 'store': store}),
                  review_hash=j.digest('review'), payable_minor=5185)
        if outcome == 'MAY_HAVE_SENT':
            return flow
        j.observe(flow, 'place', outcome='ORDER_ID_RECEIVED',
                  evidence_hash=j.digest('placed'), order_id=order)
        if outcome == 'COMPLETE':
            for signal in ('PAYMENT_REPORTED_SUCCESS', 'EXACT_ORDER_CONFIRMED',
                           'TRACKER_REGISTERED'):
                j.observe(flow, 'place', outcome=signal,
                          evidence_hash=j.digest(signal), order_id=order)
            j.complete(flow)
        elif outcome in ('UNKNOWN', 'CHALLENGE_REQUIRED', 'RELEASED'):
            j.observe(flow, 'place', outcome='UNKNOWN' if outcome == 'RELEASED' else outcome,
                      evidence_hash=j.digest(outcome), order_id=order)
            if outcome == 'RELEASED':
                j.release(flow, evidence_hash=j.digest('released'))
        return flow

    def responses(self, *orders, **overrides):
        return happy_responses(home={'data': {'active': [
            {'orderNr': order, 'status': 'pending_acceptance'} for order in orders
        ]}}, **overrides)

    def assert_blocked(self, flow, harness, method):
        with self.assertRaisesRegex(j.JournalError, 'NOWNOW_ACTIVE_ORDER_PRESENT'):
            getattr(flow, method)()
        self.assertEqual([op for op, _ in harness.calls], ['home'])
        self.assertFalse(flow.opened)

    def test_completed_different_store_order_allows_guard_and_preparation(self):
        prior = self.prior()
        before = j.inspect(prior)
        flow, harness = make_flow(self.responses(ORDER))
        self.assertEqual(flow.guard()['active_orders'], 1)
        prepared = flow.prepare_only()
        self.assertTrue(prepared['prepared_only'])
        self.assertEqual(j.inspect(prior), before)
        self.assertEqual(j.inspect(flow.flow_id)['reserved_minor'], 0)
        self.assertNotIn('place', [op for op, _ in harness.calls])

    def test_completed_same_store_different_scope_allows_guard(self):
        self.prior(store=STORE, product='POTHER0000000000A', quantity=2)
        flow, _ = make_flow(self.responses(ORDER))
        self.assertTrue(flow.guard()['store_cart_clear'])

    def test_completed_same_scope_blocks_both_entrypoints(self):
        self.prior(store=STORE)
        for method in ('guard', 'prepare_only'):
            with self.subTest(method=method):
                flow, harness = make_flow(self.responses(ORDER))
                self.assert_blocked(flow, harness, method)

    def test_unattributed_or_partially_attributed_active_list_blocks(self):
        self.prior()
        for orders in (('NNGAUNKNOWN01',), (ORDER, 'NNGAUNKNOWN01')):
            for method in ('guard', 'prepare_only'):
                with self.subTest(orders=orders, method=method):
                    flow, harness = make_flow(self.responses(*orders))
                    self.assert_blocked(flow, harness, method)

    def test_completed_other_account_or_lane_cannot_attribute_order(self):
        self.prior(account=j.digest('other-account'))
        self.prior(order='NNGAOTHERLANE01', vertical='minutes')
        self.prior(order='NNGAOTHERAPP01', app='talabat', vertical='mart')
        for order in (ORDER, 'NNGAOTHERLANE01', 'NNGAOTHERAPP01'):
            with self.subTest(order=order):
                flow, harness = make_flow(self.responses(order))
                self.assert_blocked(flow, harness, 'prepare_only')

    def test_released_flow_cannot_attribute_active_order(self):
        prior = self.prior(outcome='RELEASED')
        before = j.inspect(prior)
        flow, harness = make_flow(self.responses(ORDER))
        self.assert_blocked(flow, harness, 'prepare_only')
        self.assertEqual(j.inspect(prior), before)

    def test_existing_store_cart_still_blocks_with_completed_active_order(self):
        from test.test_commerce_nownow_order import nn_state
        self.prior()
        flow, harness = make_flow(self.responses(
            ORDER, carts_recent={'data': {'carts': [nn_state()['data']]}}))
        with self.assertRaisesRegex(j.JournalError, 'NOWNOW_STORE_CART_PRESENT'):
            flow.prepare_only()
        self.assertFalse(flow.opened)
        self.assertFalse((set(c.native.WRITES) - {'cart_get'}) &
                         {op for op, _ in harness.calls})

    def test_completed_order_allows_resume_without_replaying_preparation(self):
        self.prior()
        flow, _ = make_flow(happy_responses())
        flow.prepare_only()
        harness = Harness(self.responses(ORDER))
        resumed = c.NowNowOrderFlow.resume_active(
            flow.flow_id, store_code=STORE, product_code=PRODUCT, quantity=1,
            auth=FakeAuth(), request=harness.request)
        self.assertTrue(resumed.prepare_only()['prepared_only'])
        self.assertFalse((set(c.native.WRITES) - {'cart_get'}) &
                         {op for op, _ in harness.calls})

    def test_completed_orders_all_must_have_distinct_scopes(self):
        self.prior()
        self.prior(order='NNGACONCURRENT02', store=STORE, quantity=2)
        flow, _ = make_flow(self.responses(ORDER, 'NNGACONCURRENT02'))
        self.assertEqual(flow.guard()['active_orders'], 2)
        self.prior(order='NNGADUPLICATE01', store=STORE)
        flow, harness = make_flow(self.responses(ORDER, 'NNGACONCURRENT02', 'NNGADUPLICATE01'))
        self.assert_blocked(flow, harness, 'prepare_only')

    def test_journal_lookup_failure_stops_before_any_cart_access(self):
        self.prior()
        flow, harness = make_flow(self.responses(ORDER))
        with patch.object(j, '_db', side_effect=j.JournalError('JOURNAL_BUSY_OR_UNAVAILABLE')):
            with self.assertRaisesRegex(j.JournalError, 'JOURNAL_BUSY_OR_UNAVAILABLE'):
                flow.prepare_only()
        self.assertEqual([op for op, _ in harness.calls], ['home'])

    def test_order_attribution_requires_completed_flow(self):
        for outcome in ('ACTIVE', 'MAY_HAVE_SENT', 'UNKNOWN', 'CHALLENGE_REQUIRED',
                        'RELEASED', 'COMPLETE'):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as temp, \
                    patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'):
                prior = self.prior(outcome=outcome)
                before = j.inspect(prior)
                binding = j.completed_order_binding(
                    app='noon', vertical='nownow', account_hash=ACCOUNT, order_id=ORDER)
                if outcome == 'COMPLETE':
                    self.assertEqual(binding, {'flow_id': prior,
                                              'scope_hash': j.binding(prior)['scope_hash']})
                else:
                    self.assertIsNone(binding)
                self.assertEqual(j.inspect(prior), before)

    def test_unfinished_financial_flow_still_fences_new_flow(self):
        for outcome in ('ACTIVE', 'MAY_HAVE_SENT', 'UNKNOWN', 'CHALLENGE_REQUIRED'):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as temp, \
                    patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'):
                prior = self.prior(outcome=outcome)
                before = j.inspect(prior)
                with self.assertRaisesRegex(j.JournalError, 'ACCOUNT_RECONCILIATION_REQUIRED'):
                    make_flow(self.responses(ORDER))
                self.assertEqual(j.inspect(prior), before)


if __name__ == '__main__':
    unittest.main()
