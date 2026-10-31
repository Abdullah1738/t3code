"""Cart-only fixtures: no native requests, credentials or financial sends."""
import os as _os, tempfile as _tempfile
# commerce_cli reads the pause file at import; the owner's real one must not refuse test orders.
_os.environ['ORDERING_PAUSE_FILE'] = _os.path.join(_tempfile.gettempdir(), 'ordering-pause-test-absent', 'ordering-paused')
import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid

import commerce_cli as cli
import commerce_journal as j
import commerce_marketplace_cleanup as cleanup
import commerce_main_order as main
import commerce_supermall_order as rocket
import noon_marketplace_checkout as market
from test import test_commerce_main_order as mt
from test import test_commerce_supermall_order as rt


class CleanupTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        for module in (j, main.receipts):
            patcher = patch.object(module, 'ROOT', Path(temp.name).resolve() / 'commerce')
            patcher.start(); self.addCleanup(patcher.stop)

    def source(self, vertical='supermall', *, legacy=False, two=False, reversed_rows=False):
        module, fixture = (rocket, rt) if vertical == 'supermall' else (main, mt)
        items = [{'sku_config': fixture.SKU, 'quantity': 1}]
        data = fixture.cart_state(quantity=1)
        if two:
            items.append({'sku_config': 'SECOND', 'quantity': 2})
            second = fixture.cart_state(sku='SECOND', offer='second_offer', quantity=2)
            data['items'] += second['items']; data['offers'] += second['offers']; data['count'] += 2
        if reversed_rows:
            data['items'].reverse(); data['offers'].reverse()
        harness = fixture.Harness({'cart': data, 'add_rocket': data, 'add': data,
                                   'session': fixture.session_state()})
        flow = (module.SupermallOrderFlow if vertical == 'supermall' else module.MainOrderFlow)(
            items=items, auth=fixture.FakeAuth(), request=harness.request)
        flow.offers = {fixture.SKU: fixture.OFFER, **({'SECOND': 'second_offer'} if two else {})}
        flow.offer = fixture.OFFER if not two else None
        real_observe = j.observe
        def observe(*args, **kwargs):
            if not (legacy and kwargs['outcome'] == 'CART_READBACK'):
                return real_observe(*args, **kwargs)
        with patch.object(j, 'observe', side_effect=observe):
            flow.add()
        flow.checkout_session()
        j.abandon(flow.flow_id)
        return flow, data, fixture

    def invoke(self, flow, data, fixture, *, reads=None, remove=None, active=None):
        empty = fixture.cart_state(empty=True)
        harness = fixture.Harness({'cart': reads if reads is not None else [data, data, empty],
                                   'remove': remove if remove is not None else empty})
        with patch.object(cleanup, 'active_marketplace_orders', return_value=active or []):
            result = cleanup.clear_cart(flow.flow_id, 'supermall' if fixture is rt else 'main',
                                        auth=flow.auth, request=harness.request)
        return result, harness

    def test_both_lanes_clear_only_owned_rows_and_verify_empty(self):
        for vertical in ('main', 'supermall'):
            with self.subTest(vertical=vertical):
                flow, data, fixture = self.source(vertical)
                result, harness = self.invoke(flow, data, fixture)
                self.assertTrue(result['cart_empty'])
                self.assertFalse(result['financial_send'])
                calls = [(name, path) for name, path, _ in harness.calls]
                self.assertEqual([name for name, _ in calls], ['cart', 'cart', 'remove', 'cart'])
                self.assertIn('/0?showCart=true&isPageCart=true&variantKey=', calls[2][1])
                self.assertEqual(j.inspect(result['cleanup_flow_id'])['state'], 'RELEASED')
                with self.assertRaisesRegex(j.JournalError, 'OWNERSHIP_SUPERSEDED'):
                    self.invoke(flow, data, fixture)

    def test_multiple_removals_each_use_fresh_readback(self):
        flow, data, fixture = self.source(two=True)
        left = fixture.cart_state(sku='SECOND', offer='second_offer', quantity=2)
        empty = fixture.cart_state(empty=True)
        result, harness = self.invoke(flow, data, fixture,
            reads=[data, data, left, left, empty], remove=[left, empty])
        self.assertTrue(result['cart_empty'])
        self.assertEqual([name for name, _, _ in harness.calls].count('remove'), 2)

    def test_legacy_add_receipt_requires_entire_response_and_home_scope(self):
        flow, data, fixture = self.source(legacy=True)
        changed = copy.deepcopy(data); changed['version'] = 99
        with self.assertRaisesRegex(j.JournalError, 'READBACK_MISMATCH'):
            self.invoke(flow, data, fixture, reads=[changed, changed])
        result, _ = self.invoke(flow, data, fixture)
        self.assertTrue(result['cart_empty'])

    def test_legacy_server_row_order_does_not_change_manifest_scope(self):
        flow, data, fixture = self.source(legacy=True, two=True, reversed_rows=True)
        left = fixture.cart_state(quantity=1)
        empty = fixture.cart_state(empty=True)
        result, _ = self.invoke(flow, data, fixture,
            reads=[data, data, left, left, empty], remove=[left, empty])
        self.assertTrue(result['cart_empty'])

    def test_surviving_row_changes_after_first_removal_stop_the_second(self):
        flow, data, fixture = self.source(two=True)
        changed = fixture.cart_state(sku='SECOND', offer='second_offer', quantity=2)
        changed['items'][0]['isSelectedForCheckout'] = False
        harness = fixture.Harness({'cart': [data, data, changed], 'remove': changed})
        with patch.object(cleanup, 'active_marketplace_orders', return_value=[]):
            with self.assertRaisesRegex(j.JournalError, 'CLEAR_READBACK_MISMATCH'):
                cleanup.clear_cart(flow.flow_id, 'supermall', auth=flow.auth, request=harness.request)
        self.assertEqual([name for name, _, _ in harness.calls].count('remove'), 1)
        with self.assertRaisesRegex(j.JournalError, 'ACCOUNT_RECONCILIATION_REQUIRED'):
            j.require_account_available('noon', flow.account_hash)

    def test_cookie_rotation_reconciles_before_next_read(self):
        flow, data, fixture = self.source()
        class RotatingAuth(rt.FakeAuth):
            pending = True
            reconciled = 0
            def status(self, service, **_):
                return {'maintenance_state': 'pending' if self.pending else 'none'}
            def revalidate(self, service, **kwargs):
                if self.pending:
                    raise RuntimeError('PENDING_AUTH_RECONCILE_REQUIRED')
                return super().revalidate(service, **kwargs)
            def reconcile(self, service, **kwargs):
                self.pending = False
                self.reconciled += 1
                return self.revalidate(service, **kwargs)
            def retain_response_cookies(self, *args, **kwargs):
                self.pending = True
                return True
        flow.auth = RotatingAuth()
        result, _ = self.invoke(flow, data, fixture)
        self.assertTrue(result['cart_empty'])
        self.assertEqual(flow.auth.reconciled, 4)

    def test_foreign_extra_line_or_quantity_never_clears(self):
        flow, data, fixture = self.source()
        for changed in (fixture.cart_state(quantity=2), fixture.cart_state(offer='FOREIGN')):
            with self.assertRaisesRegex(j.JournalError, 'CART_NOT_OWNED'):
                self.invoke(flow, data, fixture, reads=[changed, changed])

    def test_changed_cart_at_send_releases_only_unsent_claim(self):
        flow, data, fixture = self.source()
        changed = copy.deepcopy(data); changed['version'] = 99
        with self.assertRaisesRegex(j.JournalError, 'READBACK_MISMATCH'):
            self.invoke(flow, data, fixture, reads=[data, changed])
        j.require_account_available('noon', flow.account_hash)

    def test_unknown_or_unverified_removal_stays_fenced(self):
        flow, data, fixture = self.source()
        with self.assertRaisesRegex(market.MarketplaceError, 'TRANSPORT_OUTCOME_UNKNOWN'):
            self.invoke(flow, data, fixture, remove=TimeoutError())
        with self.assertRaisesRegex(j.JournalError, 'ACCOUNT_RECONCILIATION_REQUIRED'):
            j.require_account_available('noon', flow.account_hash)

    def test_successful_transport_but_still_populated_stays_fenced(self):
        flow, data, fixture = self.source()
        with self.assertRaisesRegex(j.JournalError, 'CLEAR_READBACK_MISMATCH'):
            self.invoke(flow, data, fixture, reads=[data, data, data], remove=data)
        with self.assertRaisesRegex(j.JournalError, 'ACCOUNT_RECONCILIATION_REQUIRED'):
            j.require_account_available('noon', flow.account_hash)

    def test_active_order_and_local_flow_block(self):
        flow, data, fixture = self.source()
        with self.assertRaisesRegex(j.JournalError, 'ACTIVE_ORDER_PRESENT'):
            self.invoke(flow, data, fixture, active=[{'order': 'NACTIVE'}])
        j.open_flow(flow_id=str(uuid.uuid4()), app='noon', vertical='minutes',
                    account_hash=flow.account_hash, scope_hash='a'*64)
        with self.assertRaisesRegex(j.JournalError, 'ACCOUNT_RECONCILIATION_REQUIRED'):
            self.invoke(flow, data, fixture)

    def test_other_lane_writer_supersedes_even_if_released(self):
        flow, data, fixture = self.source()
        other = str(uuid.uuid4())
        j.open_flow(flow_id=other, app='noon', vertical='minutes',
                    account_hash=flow.account_hash, scope_hash='a'*64)
        j.consume(other, 'sync', kind='cart', request_hash='b'*64)
        j.observe(other, 'sync', outcome='RESPONSE_RECEIVED', evidence_hash='c'*64)
        j.abandon(other)
        with self.assertRaisesRegex(j.JournalError, 'OWNERSHIP_SUPERSEDED'):
            self.invoke(flow, data, fixture)

    def test_no_financial_or_active_source_can_authorize_cleanup(self):
        flow, data, fixture = self.source()
        with self.assertRaisesRegex(j.JournalError, 'CLOSED_CART_ONLY'):
            cleanup.clear_cart(flow.flow_id, 'main', auth=flow.auth)
        active = str(uuid.uuid4())
        j.open_flow(flow_id=active, app='noon', vertical='supermall',
                    account_hash=flow.account_hash, scope_hash='a'*64)
        with self.assertRaisesRegex(j.JournalError, 'CLOSED_CART_ONLY'):
            cleanup.clear_cart(active, 'supermall', auth=flow.auth)
        j.consume(active, 'place', kind='place', request_hash='a'*64,
                  cart_hash='b'*64, review_hash='c'*64, payable_minor=10)
        j.observe(active, 'place', outcome='UNKNOWN', evidence_hash='d'*64)
        j.release_orderless(active, evidence_hash='e'*64)
        with self.assertRaisesRegex(j.JournalError, 'CLOSED_CART_ONLY'):
            cleanup.clear_cart(active, 'supermall', auth=flow.auth)

    def closed_uncharged(self, vertical):
        """Place, time out at noon, reconcile as uncharged. Returns (flow, cart data, fixture)."""
        from test import test_marketplace_payment as pay
        from commerce_marketplace_disposition import reconcile
        fixture = mt if vertical == 'main' else rt
        quantity = 2 if vertical == 'main' else 1
        amount = 1980 if vertical == 'main' else 2549
        failed = pay.failed_responses(fixture.ORDER, amount)
        flow, wire = pay.PaymentTests.placed(self, fixture, **failed)
        pay.PaymentTests.setup_cvv(self, flow, wire)
        flow.place()
        timed_out = copy.deepcopy(failed)
        timed_out['order_status'] = {'status': 'failed', 'statusMessage': 'Payment timed out',
                                     'paymentError': None, 'paymentErrorMsg': None}
        reconcile(flow.flow_id, client=self.canned_client(flow, timed_out))
        self.assertEqual(j.inspect(flow.flow_id)['state'], 'RELEASED')
        return flow, fixture.cart_state(quantity=quantity), fixture

    def canned_client(self, flow, responses):
        client = flow.client
        original = client.call
        def call(name, **kwargs):
            if name in ('order_status', 'order_detail', 'order_refund'):
                return type('R', (), {'data': responses[name]})()
            return original(name, **kwargs)
        client.call = call
        return client

    def test_closed_uncharged_source_clears_owned_row_for_both_lanes(self):
        for vertical in ('main', 'supermall'):
            with self.subTest(vertical=vertical):
                flow, data, fixture = self.closed_uncharged(vertical)
                result, _ = self.invoke(flow, data, fixture)
                self.assertTrue(result['cart_empty'])
                self.assertFalse(result['financial_send'])
                self.assertEqual(j.inspect(result['cleanup_flow_id'])['state'], 'RELEASED')

    def test_closed_uncharged_refusals_send_no_remove(self):
        for case in ('foreign_row', 'quantity_changed', 'older_than_24h', 'fenced_not_closed',
                     'later_noon_writer', 'second_payment_op'):
            with self.subTest(case=case), self.fresh_journal():
                flow, data, fixture = self.closed_uncharged('main')
                reads = [data, data]
                clock = None
                if case == 'foreign_row':
                    reads = [fixture.cart_state(offer='FOREIGN', quantity=2)] * 2
                elif case == 'quantity_changed':
                    reads = [fixture.cart_state(quantity=1)] * 2
                elif case == 'older_than_24h':
                    clock = time.time() + 25 * 60 * 60
                elif case == 'fenced_not_closed':
                    with j._db() as db:
                        db.execute("UPDATE flows SET state='FENCED' WHERE id=?", (flow.flow_id,))
                elif case == 'later_noon_writer':
                    self.add_later_noon_writer(flow)
                elif case == 'second_payment_op':
                    # The closure already has one payment-kind op at most; a second is refused.
                    with j._db() as db:
                        for n in ('payment_one', 'payment_two'):
                            db.execute("INSERT INTO operations(flow_id,name,kind,state,created_at,request_hash) "
                                       "VALUES (?,?,?,?,?,?)", (flow.flow_id, n, 'payment', 'OBSERVED',
                                       time.time(), 'e' * 64))
                harness = fixture.Harness({'cart': reads, 'remove': fixture.cart_state(empty=True)})
                clock_patch = patch.object(time, 'time', return_value=clock) if clock else contextlib.nullcontext()
                with clock_patch, patch.object(cleanup, 'active_marketplace_orders', return_value=[]), \
                        self.assertRaises(j.JournalError):
                    cleanup.clear_cart(flow.flow_id, 'main', auth=flow.auth, request=harness.request)
                self.assertNotIn('remove', [name for name, _, _ in harness.calls])

    @contextlib.contextmanager
    def fresh_journal(self):
        """Each subTest gets its own journal: an open flow locks the account for the next one."""
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'), \
                    patch.object(main.receipts, 'ROOT', Path(temp).resolve() / 'commerce'):
                yield

    def add_later_noon_writer(self, flow):
        other = str(uuid.uuid4())
        j.open_flow(flow_id=other, app='noon', vertical='minutes',
                    account_hash=flow.account_hash, scope_hash='a' * 64)
        j.consume(other, 'sync', kind='cart', request_hash='b' * 64)
        j.observe(other, 'sync', outcome='RESPONSE_RECEIVED', evidence_hash='c' * 64)
        j.abandon(other)

    def test_cli_routes_both_marketplace_lanes(self):
        for vertical in ('main', 'supermall'):
            with patch.object(cleanup, 'clear_cart', return_value={'ok': True}) as clear, \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(['clear-cart', vertical, '--flow', 'FLOW']), 0)
                clear.assert_called_once_with('FLOW', vertical)


class CatalogPreflightTests(unittest.TestCase):
    def test_bad_second_item_fails_before_any_cart_write(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(j, 'ROOT', Path(temp) / 'commerce'):
            flow = rocket.SupermallOrderFlow(items=[{'sku_config': rt.SKU, 'quantity': 1},
                {'sku_config': 'BAD', 'quantity': 1}], auth=rt.FakeAuth(),
                request=lambda *a, **kw: self.fail('cart touched'))
            with patch.object(rocket, 'active_marketplace_orders', return_value=[]), \
                    patch.object(rocket, 'resolve_rocket_offer', side_effect=[
                        {'offer': rt.OFFER, 'stock_minimum_quantity': 1},
                        rocket.CatalogError('SUPERMALL_ITEM_NOT_ROCKET', 'BAD')]):
                with self.assertRaises(rocket.CatalogError) as error:
                    flow.prepare_only()
            self.assertEqual(error.exception.details, {'sku_config': 'BAD'})
            self.assertFalse(flow.opened)

    def test_cli_names_failed_sku(self):
        error = rocket.CatalogError('SUPERMALL_ITEM_NOT_ROCKET', 'BAD')
        with patch.object(cli, 'order_supermall', side_effect=error), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(cli.main(['order', 'supermall', '--sku-config', 'BAD', '--prepare-only']), 1)
        self.assertEqual(json.loads(out.getvalue())['details'], {'sku_config': 'BAD'})


if __name__ == '__main__':
    unittest.main()
