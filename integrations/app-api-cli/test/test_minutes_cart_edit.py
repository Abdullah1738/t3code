"""Whole-cart Minutes edit (show/set) and order --use-current-cart; synthetic fixtures only."""
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import commerce_journal as j
import commerce_minutes as c
import commerce_minutes_cart as cart
import noon_minutes_checkout as m
import noon_minutes_options as options
from test import test_commerce_minutes as flow_tests
from test.test_noon_minutes_checkout import fixture, Harness


def lines_of(items):
    data = fixture()
    data['items'] = items
    return data


def row(sku, qty=1, modifiers=(), *, title=None, freebie=False, bundle=None):
    entry = {'sku': sku, 'qty': qty, 'title': title or sku, 'price': 12.5, 'offerPrice': 12.5,
             'selectedModifiers': {'size': list(modifiers)} if modifiers else {},
             'isFreebie': freebie, 'itemCode': sku}
    if bundle is not None:
        entry['bundle'] = bundle
    return entry


def snap(data):
    return m.Snapshot(data, m.project_session(data), time.time())


class CartTestBase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        for mod in (j, c.receipts):
            p = patch.object(mod, 'ROOT', Path(self.temp.name) / 'commerce')
            p.start()
            self.addCleanup(p.stop)
        self.auth = flow_tests.ResumeActiveTests().auth()
        p = patch.object(options, 'read_options', return_value={'groups': []})
        self.read_options = p.start()
        self.addCleanup(p.stop)


class ShowTests(CartTestBase):
    def test_show_sorts_modifiers_drops_freebies_and_is_hash_stable(self):
        a = lines_of([row('SKU_B', 2, ['z', 'a']), row('SKU_A', 1), row('GIFT', 1, freebie=True)])
        b = lines_of([row('SKU_A', 1), row('SKU_B', 2, ['a', 'z']), row('GIFT', 1, freebie=True)])
        with patch.object(cart, 'readback_session', return_value=snap(a)) as read:
            first = cart.show(auth=self.auth)
        with patch.object(cart, 'readback_session', return_value=snap(b)):
            second = cart.show(auth=self.auth)
        self.assertEqual(first['items'], [
            {'sku': 'SKU_A', 'qty': 1, 'modifiers': [], 'title': 'SKU_A'},
            {'sku': 'SKU_B', 'qty': 2, 'modifiers': ['a', 'z'], 'title': 'SKU_B'}])
        self.assertEqual([x['sku'] for x in first['freebies']], ['GIFT'])
        self.assertEqual(first['cart_hash'], second['cart_hash'])
        self.assertFalse(first['financial_send'])
        self.assertFalse(first['cart_mutation_sent'])
        self.assertEqual(read.call_count, 1)

    def test_show_on_empty_cart_is_empty_and_writes_nothing(self):
        with patch.object(cart, 'readback_session', return_value=snap(lines_of([]))), \
                patch.object(m.MinutesCheckout, 'sync', side_effect=AssertionError('no write')):
            result = cart.show(auth=self.auth)
        self.assertEqual(result['items'], [])
        self.assertEqual(result['special_lines'], 0)


class SetTests(CartTestBase):
    def current(self, items):
        return snap(lines_of(items))

    def run_set(self, *, current, rows, expect_hash, readbacks=None, active=0, harness=None):
        harness = harness or Harness([lines_of([row('SKU_A', 1)])])
        real = m.MinutesCheckout
        reads = readbacks or [self.current(current), self.current(current), self.current(current)]
        def client(*a, **kw):
            return real(*a, request=harness.request, **kw)
        with patch.object(cart, 'readback_session', side_effect=reads), \
                patch.object(cart, 'readback_active_orders',
                             return_value=m.Snapshot({}, {'count': active}, time.time())), \
                patch.object(m, 'MinutesCheckout', side_effect=client):
            return cart.set_cart(rows, expect_hash=expect_hash, auth=self.auth), harness

    def test_wrong_expect_hash_refuses_with_zero_sync(self):
        cur = [row('SKU_A', 1)]
        with self.assertRaisesRegex(j.JournalError, 'MINUTES_CART_CHANGED_SINCE_SHOW'):
            self.run_set(current=cur, rows=[{'sku': 'SKU_A', 'qty': 2}], expect_hash='0' * 64)
        self.assertEqual(self.read_options.call_count, 0)

    def test_missing_expect_hash_is_refused_before_any_read(self):
        with patch.object(cart, 'readback_session', side_effect=AssertionError('no read')):
            with self.assertRaisesRegex(m.MinutesError, 'MINUTES_CART_EXPECT_HASH_REQUIRED'):
                cart.set_cart([{'sku': 'SKU_A', 'qty': 1}], expect_hash='', auth=self.auth)

    def test_happy_path_sends_one_full_sync_flow_releases_and_hash_matches(self):
        cur = [row('SKU_A', 1)]
        expect = cart.manifest_hash(cart.manifest(m.project_session(lines_of(cur))['lines']))
        new_rows = [{'sku': 'SKU_A', 'qty': 1, 'modifiers': []},
                    {'sku': 'SKU_B', 'qty': 2, 'modifiers': ['z', 'a']}]
        after = lines_of([row('SKU_A', 1), row('SKU_B', 2, ['z', 'a'])])
        harness = Harness([after])
        catalog = {'groups': [{'min_selection': 0, 'max_selection': 2,
                               'options': [{'code': 'a'}, {'code': 'z'}]}]}
        self.read_options.return_value = catalog
        result, harness = self.run_set(current=cur, rows=new_rows, expect_hash=expect,
            readbacks=[self.current(cur), self.current(cur), snap(after)], harness=harness)
        self.assertTrue(result['cart_mutation_sent'])
        self.assertFalse(result['financial_send'])
        self.assertEqual([x[0] for x in harness.calls], ['sync'])
        sent = harness.calls[0][1]['skus']
        # The sync carries the caller's full list as given; only the manifest hash is order-free.
        self.assertEqual(sent, [{'sku': 'SKU_A', 'qty': 1, 'modifiers': []},
                                {'sku': 'SKU_B', 'qty': 2, 'modifiers': ['z', 'a']}])
        self.assertEqual(result['cart_hash'], cart.manifest_hash(result['items']))
        self.assertEqual(j.inspect(result['flow_id'])['state'], 'RELEASED')
        self.assertEqual(self.read_options.call_count, 1)
        self.assertEqual(self.read_options.call_args[0][0], 'SKU_B')

    def test_active_order_refuses_before_any_write(self):
        cur = [row('SKU_A', 1)]
        expect = cart.manifest_hash(cart.manifest(m.project_session(lines_of(cur))['lines']))
        with patch.object(m.MinutesCheckout, 'sync', side_effect=AssertionError('no write')):
            with self.assertRaisesRegex(m.MinutesError, 'MINUTES_ACTIVE_ORDER_PRESENT'):
                self.run_set(current=cur, rows=[{'sku': 'SKU_A', 'qty': 2}], expect_hash=expect, active=1)

    def test_bundle_line_in_cart_refuses_as_special(self):
        cur = [row('SKU_A', 1, bundle={'id': 1})]
        expect = cart.manifest_hash(cart.manifest(m.project_session(lines_of([row('SKU_A', 1)]))['lines']))
        with patch.object(m.MinutesCheckout, 'sync', side_effect=AssertionError('no write')):
            with self.assertRaisesRegex(m.MinutesError, 'MINUTES_CART_SPECIAL_LINES'):
                self.run_set(current=cur, rows=[{'sku': 'SKU_A', 'qty': 2}], expect_hash=expect)

    def test_same_list_is_unchanged_and_sends_nothing(self):
        cur = [row('SKU_A', 1)]
        expect = cart.manifest_hash(cart.manifest(m.project_session(lines_of(cur))['lines']))
        with patch.object(m.MinutesCheckout, 'sync', side_effect=AssertionError('no write')):
            result, _ = self.run_set(current=cur, rows=[{'sku': 'SKU_A', 'qty': 1}], expect_hash=expect)
        self.assertEqual(result, {'ok': True, 'unchanged': True, 'cart_hash': result['cart_hash'],
                                  'financial_send': False, 'cart_mutation_sent': False})
        self.assertEqual(self.read_options.call_count, 0)


class OrderUseCurrentCartTests(CartTestBase):
    def flow(self, skus, *, use_current, lines=None):
        f = object.__new__(c.MinutesFlow)
        f.skus = c.m._skus(skus)
        f.catalog_queries = {}
        f.current = snap(lines_of(lines or []))
        f.use_current_cart = use_current
        f.opened = False
        return f

    def test_digest_without_flag_equals_old_dict_digest(self):
        skus = c.m._skus([{'sku': 'SKU_A', 'qty': 1, 'modifiers': []}])
        old = j.digest({'skus': skus, 'home': 'HOME', 'card': '5542', 'quiet': True, 'extras': False})
        self.assertEqual(c._scope_hash(skus, 'HOME', None), old)
        self.assertEqual(c._scope_hash(skus, 'HOME', None, False), old)
        self.assertNotEqual(c._scope_hash(skus, 'HOME', None, True), old)

    def test_matching_current_cart_skips_sync_and_is_adopted(self):
        f = self.flow([{'sku': 'SKU_A', 'qty': 1, 'modifiers': []}], use_current=True,
                      lines=[row('SKU_A', 1)])
        with patch.object(m.MinutesCheckout, 'sync', side_effect=AssertionError('no sync')):
            projection = f.fill_empty()
        self.assertTrue(projection['lines'])
        self.assertTrue(f.adopted_current_cart)

    def test_different_current_cart_refuses_without_writes(self):
        f = self.flow([{'sku': 'SKU_A', 'qty': 2, 'modifiers': []}], use_current=True,
                      lines=[row('SKU_A', 1)])
        with patch.object(m.MinutesCheckout, 'sync', side_effect=AssertionError('no sync')):
            with self.assertRaisesRegex(m.MinutesError, 'MINUTES_CURRENT_CART_MISMATCH'):
                f.fill_empty()

    def test_empty_cart_still_fills_normally_with_flag(self):
        # Empty cart + flag: the normal fill runs (one sync), no adoption is recorded.
        from unittest.mock import Mock
        f = self.flow([{'sku': 'SKU_A', 'qty': 1, 'modifiers': []}], use_current=True, lines=[])
        f.client = Mock()
        f.client.sync.return_value = snap(lines_of([row('SKU_A', 1)]))
        with patch.object(f, 'validate_options'):
            f.fill_empty()
        f.client.sync.assert_called_once()
        self.assertFalse(getattr(f, 'adopted_current_cart', False))

    def test_no_flag_non_empty_cart_keeps_old_refusal(self):
        f = self.flow([{'sku': 'SKU_A', 'qty': 1, 'modifiers': []}], use_current=False,
                      lines=[row('SKU_A', 1)])
        with self.assertRaisesRegex(j.JournalError, 'EXISTING_MINUTES_CART_MUST_NOT_BE_REPLACED'):
            f.fill_empty()


if __name__ == '__main__':
    unittest.main()
