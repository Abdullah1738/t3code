"""Whole-cart Minutes edit (show/set) and order --use-current-cart; synthetic fixtures only."""
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import commerce_cli
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
        # Fixture auth at every seam: direct calls, the CLI's CommerceAuth, and no real NoonAuthLifecycle.
        from unittest.mock import Mock
        fake_commerce = Mock()
        fake_commerce.noon = self.auth
        for target in (patch.object(cart, 'NoonAuthLifecycle', return_value=self.auth),
                       patch.object(commerce_cli, 'CommerceAuth', return_value=fake_commerce)):
            target.start()
            self.addCleanup(target.stop)
        # No outbound sockets: any real network call fails the test instead of reaching Noon.
        import socket
        def refuse(*a, **kw):
            raise AssertionError('outbound network blocked in cart tests')
        for name in ('socket', 'create_connection'):
            p = patch.object(socket, name, side_effect=refuse)
            p.start()
            self.addCleanup(p.stop)
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


class FinalReadbackTests(CartTestBase):
    def test_bundle_appearing_after_initial_read_sends_nothing(self):
        # Same sku/qty/modifiers so the hash matches, but the pre-send readback carries bundle metadata.
        cur = [row('SKU_A', 1)]
        expect = cart.manifest_hash(cart.manifest(m.project_session(lines_of(cur))['lines']))
        bundled = lines_of([row('SKU_A', 1, bundle={'id': 1})])
        harness = Harness([lines_of([row('SKU_A', 2)])])
        real = m.MinutesCheckout
        with patch.object(cart, 'readback_session', side_effect=[snap(lines_of(cur)), snap(bundled)]), \
                patch.object(cart, 'readback_active_orders',
                             return_value=m.Snapshot({}, {'count': 0}, time.time())), \
                patch.object(m, 'MinutesCheckout', side_effect=lambda *a, **kw: real(*a, request=harness.request, **kw)):
            with self.assertRaisesRegex(m.MinutesError, 'MINUTES_CART_SPECIAL_LINES'):
                cart.set_cart([{'sku': 'SKU_A', 'qty': 2}], expect_hash=expect, auth=self.auth)
        self.assertEqual(harness.calls, [])


class BundledFreebieTests(CartTestBase):
    def test_bundled_freebie_on_final_readback_sends_nothing(self):
        cur = [row('SKU_A', 1)]
        expect = cart.manifest_hash(cart.manifest(m.project_session(lines_of(cur))['lines']))
        bundled_gift = lines_of([row('SKU_A', 1), row('GIFT', 1, freebie=True, bundle={'id': 7})])
        harness = Harness([lines_of([row('SKU_A', 2)])])
        real = m.MinutesCheckout
        with patch.object(cart, 'readback_session', side_effect=[snap(lines_of(cur)), snap(bundled_gift)]), \
                patch.object(cart, 'readback_active_orders',
                             return_value=m.Snapshot({}, {'count': 0}, time.time())), \
                patch.object(m, 'MinutesCheckout', side_effect=lambda *a, **kw: real(*a, request=harness.request, **kw)):
            with self.assertRaisesRegex(m.MinutesError, 'MINUTES_CART_SPECIAL_LINES'):
                cart.set_cart([{'sku': 'SKU_A', 'qty': 2}], expect_hash=expect, auth=self.auth)
        self.assertEqual(harness.calls, [])


class TransportFailureTests(CartTestBase):
    def run_failing_sync(self, error):
        cur = [row('SKU_A', 1)]
        expect = cart.manifest_hash(cart.manifest(m.project_session(lines_of(cur))['lines']))
        harness = Harness([error])
        real = m.MinutesCheckout
        with patch.object(cart, 'readback_session', side_effect=[snap(lines_of(cur)), snap(lines_of(cur))]), \
                patch.object(cart, 'readback_active_orders',
                             return_value=m.Snapshot({}, {'count': 0}, time.time())), \
                patch.object(m, 'MinutesCheckout', side_effect=lambda *a, **kw: real(*a, request=harness.request, **kw)):
            with self.assertRaises(cart.OutcomeUnverified) as ctx:
                cart.set_cart([{'sku': 'SKU_A', 'qty': 2}], expect_hash=expect, auth=self.auth)
        return ctx.exception, harness

    def test_transport_timeout_after_consumed_send_is_unverified_and_not_retried(self):
        exc, harness = self.run_failing_sync(m.MinutesError('REQUEST_FAILED'))
        self.assertEqual(exc.code, 'MINUTES_CART_SET_OUTCOME_UNVERIFIED')
        self.assertEqual([x[0] for x in harness.calls], ['sync'])  # exactly one send, never retried
        self.assertEqual(j.inspect(exc.flow_id)['state'], 'FENCED')
        self.assertIn('minutes reconcile --flow ' + exc.flow_id, exc.details['recovery'])

    def test_cli_prints_flow_id_and_recovery_for_transport_failure(self):
        import io, contextlib, json, tempfile as tf
        cur = [row('SKU_A', 1)]
        expect = cart.manifest_hash(cart.manifest(m.project_session(lines_of(cur))['lines']))
        harness = Harness([m.MinutesError('REQUEST_FAILED')])
        real = m.MinutesCheckout
        with patch.object(cart, 'readback_session', side_effect=[snap(lines_of(cur)), snap(lines_of(cur))]), \
                patch.object(cart, 'readback_active_orders',
                             return_value=m.Snapshot({}, {'count': 0}, time.time())), \
                patch.object(m, 'MinutesCheckout', side_effect=lambda *a, **kw: real(*a, request=harness.request, **kw)):
            with tf.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
                json.dump([{'sku': 'SKU_A', 'qty': 2, 'modifiers': []}], f)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = commerce_cli.main(['cart', 'minutes', 'set', '--items-file', f.name, '--expect-hash', expect])
        self.assertEqual(rc, 1)
        payload = json.loads(out.getvalue().strip().splitlines()[-1])
        self.assertEqual(payload['error'], 'MINUTES_CART_SET_OUTCOME_UNVERIFIED')
        self.assertTrue(payload['flow_id'])
        self.assertIn('minutes reconcile --flow ' + payload['flow_id'], payload['recovery'])
        self.assertEqual(len(harness.calls), 1)


class SnapshotRefreshTests(CartTestBase):
    def test_snapshot_is_retaken_after_option_discovery_and_before_flow_opens(self):
        cur = [row('SKU_A', 1)]
        expect = cart.manifest_hash(cart.manifest(m.project_session(lines_of(cur))['lines']))
        after = lines_of([row('SKU_A', 1), row('SKU_B', 1, ['a'])])
        harness = Harness([after])
        real = m.MinutesCheckout
        self.read_options.return_value = {'groups': [{'min_selection': 0, 'max_selection': 2,
                                                      'options': [{'code': 'a'}]}]}
        order = []
        orig_fresh = self.auth.fresh_before_mutation
        def fresh(*a, **kw):
            order.append('fresh')
            return orig_fresh(*a, **kw)
        self.auth.fresh_before_mutation = fresh
        def read(*a, **kw):
            order.append('options')
            return self.read_options.return_value
        self.read_options.side_effect = read
        real_open = j.open_flow
        def opened(**kw):
            order.append('open_flow')
            return real_open(**kw)
        with patch.object(cart, 'readback_session', side_effect=[snap(lines_of(cur)), snap(lines_of(cur)), snap(after)]), \
                patch.object(cart, 'readback_active_orders',
                             return_value=m.Snapshot({}, {'count': 0}, time.time())), \
                patch.object(cart.j, 'open_flow', side_effect=opened), \
                patch.object(m, 'MinutesCheckout', side_effect=lambda *a, **kw: real(*a, request=harness.request, **kw)):
            cart.set_cart([{'sku': 'SKU_A', 'qty': 1}, {'sku': 'SKU_B', 'qty': 1, 'modifiers': ['a']}],
                          expect_hash=expect, auth=self.auth)
        # Discovery happens, then a fresh snapshot is taken, and only then does the flow open.
        opened_at = order.index('open_flow')
        refreshed_before_open = [i for i, x in enumerate(order[:opened_at]) if x == 'fresh']
        self.assertTrue(refreshed_before_open)
        self.assertLess(order.index('options'), refreshed_before_open[-1])
        self.assertLess(refreshed_before_open[-1], opened_at)
        self.assertEqual([x[0] for x in harness.calls], ['sync'])


class PostSendFailureTests(CartTestBase):
    def test_cli_reports_fixed_code_flow_id_and_recovery_when_readback_mismatches(self):
        import io, contextlib, json
        import commerce_cli as cli
        cur = [row('SKU_A', 1)]
        expect = cart.manifest_hash(cart.manifest(m.project_session(lines_of(cur))['lines']))
        wrong_after = lines_of([row('SKU_A', 9)])  # independent readback disagrees with the sent list
        harness = Harness([lines_of([row('SKU_A', 2)])])
        real = m.MinutesCheckout
        self.read_options.return_value = {'groups': []}
        # Reads: initial current, pre-send check in headers(), post-sync readback (mismatched).
        with patch.object(cart, 'readback_session', side_effect=[snap(lines_of(cur)), snap(lines_of(cur)),
                                                              snap(wrong_after)]), \
                patch.object(cart, 'readback_active_orders',
                             return_value=m.Snapshot({}, {'count': 0}, time.time())), \
                patch.object(m, 'MinutesCheckout', side_effect=lambda *a, **kw: real(*a, request=harness.request, **kw)):
            with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
                json.dump([{'sku': 'SKU_A', 'qty': 2, 'modifiers': []}], f)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = cli.main(['cart', 'minutes', 'set', '--items-file', f.name, '--expect-hash', expect])
        self.assertEqual(rc, 1)
        payload = json.loads(out.getvalue().strip().splitlines()[-1])
        self.assertEqual(payload['error'], 'MINUTES_CART_SET_OUTCOME_UNVERIFIED')
        self.assertTrue(payload['flow_id'])
        self.assertTrue(payload['cart_mutation_sent'])
        self.assertIn('minutes reconcile --flow ' + payload['flow_id'], payload['recovery'])
        self.assertEqual(j.inspect(payload['flow_id'])['state'], 'ACTIVE')


class RoundTripTests(CartTestBase):
    def test_show_edit_set_set_then_order_use_current_cart_round_trip(self):
        # show output is directly usable as the items file (title is display-only).
        import json, io, contextlib
        import commerce_cli as cli
        cur = lines_of([row('SKU_A', 1, title='Shake A')])
        shown = cart.manifest(m.project_session(cur)['lines'])
        items = [{**r, 'title': 'Shake A'} for r in shown]
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
            json.dump(items, f)
        self.assertEqual(cart.manifest_hash(shown), cart.manifest_hash(cart.manifest(m.project_session(cur)['lines'])))
        rows = cli.input_items if False else None
        from commerce_basket_input import read_items
        read_back = read_items(f.name)
        new_rows = [{k: v for k, v in r.items() if k != 'title'} for r in read_back]
        self.assertEqual(m._skus(c._rows(new_rows)), m._skus(c._rows(new_rows)))
        # The order path must accept the same file: _rows leaves no title and _skus accepts the row.
        flow_skus = m._skus(c._rows([{'sku': 'SKU_A', 'qty': 1, 'modifiers': []}]))
        self.assertEqual(flow_skus[0]['sku'], 'SKU_A')


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


class ReceiptFailureRecoveryTests(CartTestBase):
    SENT = [{'sku': 'SKU_A', 'qty': 2}]

    def send_with_failed_receipt(self):
        cur = [row('SKU_A', 1)]
        expect = cart.manifest_hash(cart.manifest(m.project_session(lines_of(cur))['lines']))
        after = lines_of([row('SKU_A', 2)])
        harness = Harness([after])
        real = m.MinutesCheckout
        with patch.object(cart, 'readback_session', side_effect=[snap(lines_of(cur)), snap(lines_of(cur))]), \
                patch.object(cart, 'readback_active_orders',
                             return_value=m.Snapshot({}, {'count': 0}, time.time())), \
                patch.object(cart.j, 'observe', side_effect=j.JournalError('JOURNAL_DOWN')), \
                patch.object(m, 'MinutesCheckout', side_effect=lambda *a, **kw: real(*a, request=harness.request, **kw)):
            with self.assertRaises(cart.OutcomeUnverified) as ctx:
                cart.set_cart(self.SENT, expect_hash=expect, auth=self.auth)
        return ctx.exception, harness, after

    @staticmethod
    def hash_of(session):
        # session: a wire session dict (what the readback returns), e.g. lines_of([...]) or `after`.
        return cart.manifest_hash(cart.manifest(m.project_session(session)['lines']))

    def test_receipt_failure_leaves_consumed_send_and_reconcile_closes_after_exact_readback(self):
        exc, harness, after = self.send_with_failed_receipt()
        self.assertEqual(exc.code, 'MINUTES_CART_SET_OUTCOME_UNVERIFIED')
        self.assertEqual([x[0] for x in harness.calls], ['sync'])  # one send, never retried
        self.assertEqual(j.inspect(exc.flow_id)['operations'][0]['state'], 'MAY_HAVE_SENT')
        self.assertIn('minutes reconcile --flow ' + exc.flow_id, exc.details['recovery'])
        with self.assertRaisesRegex(j.JournalError, 'JOURNAL_ABANDON_UNSENT_ONLY'):
            j.abandon(exc.flow_id)
        with patch.object(cart, 'readback_session', return_value=snap(after)):
            result = cart.reconcile(exc.flow_id, rows=self.SENT, expect_hash=self.hash_of(after), auth=self.auth)
        self.assertEqual(result['state'], 'RELEASED')
        self.assertFalse(result['cart_mutation_sent'])
        self.assertEqual(j.inspect(exc.flow_id)['state'], 'RELEASED')
        self.assertEqual([x[0] for x in harness.calls], ['sync'])

    def test_reconcile_refuses_basket_that_was_not_sent_and_leaves_flow_unchanged(self):
        exc, harness, after = self.send_with_failed_receipt()
        other = [{'sku': 'SKU_A', 'qty': 9}]
        # The readback matches the other basket, so only the sent-basket binding can refuse it.
        with patch.object(cart, 'readback_session', return_value=snap(lines_of([row('SKU_A', 9)]))):
            with self.assertRaisesRegex(m.MinutesError, 'MINUTES_CART_RECONCILE_BASKET_NOT_SENT'):
                cart.reconcile(exc.flow_id, rows=other, expect_hash=self.hash_of(lines_of([row('SKU_A', 9)])),
                               auth=self.auth)
        self.assertEqual(j.inspect(exc.flow_id)['operations'][0]['state'], 'MAY_HAVE_SENT')
        self.assertNotEqual(j.inspect(exc.flow_id)['state'], 'RELEASED')
        self.assertEqual([x[0] for x in harness.calls], ['sync'])

    def test_reconcile_refuses_when_readback_differs_and_leaves_flow_unreleased(self):
        exc, harness, after = self.send_with_failed_receipt()
        with patch.object(cart, 'readback_session', return_value=snap(lines_of([row('SKU_A', 9)]))):
            with self.assertRaisesRegex(j.JournalError, 'MINUTES_CART_RECONCILE_CART_MISMATCH'):
                cart.reconcile(exc.flow_id, rows=self.SENT, expect_hash=self.hash_of(after), auth=self.auth)
        self.assertNotEqual(j.inspect(exc.flow_id)['state'], 'RELEASED')
        self.assertEqual([x[0] for x in harness.calls], ['sync'])

    def test_reconcile_refuses_another_account_and_leaves_flow_unchanged(self):
        from unittest.mock import Mock
        from noon_checkout import fingerprint
        exc, harness, after = self.send_with_failed_receipt()
        other = Mock()
        other.revalidate.return_value = Mock(account_ref=fingerprint('someone-else'))
        with patch.object(cart, 'readback_session', return_value=snap(after)):
            with self.assertRaisesRegex(m.MinutesError, 'MINUTES_CART_RECONCILE_ACCOUNT_MISMATCH'):
                cart.reconcile(exc.flow_id, rows=self.SENT, expect_hash=self.hash_of(after), auth=other)
        self.assertNotEqual(j.inspect(exc.flow_id)['state'], 'RELEASED')
        self.assertEqual([x[0] for x in harness.calls], ['sync'])

    def test_cli_reconcile_after_receipt_failure(self):
        import io, contextlib, json, tempfile as tf
        exc, harness, after = self.send_with_failed_receipt()
        with tf.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
            json.dump(self.SENT, f)
        with patch.object(cart, 'readback_session', return_value=snap(after)):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = commerce_cli.main(['cart', 'minutes', 'reconcile', '--flow', exc.flow_id,
                                        '--items-file', f.name, '--expect-hash', self.hash_of(after)])
        self.assertEqual(rc, 0)
        payload = json.loads(out.getvalue().strip().splitlines()[-1])
        self.assertTrue(payload['ok'])
        self.assertFalse(payload['cart_mutation_sent'])
        self.assertEqual(len(harness.calls), 1)

    def test_cli_reconcile_refuses_unrelated_hash_and_leaves_flow_unchanged(self):
        import io, contextlib, json, tempfile as tf
        exc, harness, after = self.send_with_failed_receipt()
        with tf.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
            json.dump([{'sku': 'SKU_A', 'qty': 9}], f)
        out = io.StringIO()
        with patch.object(cart, 'readback_session', return_value=snap(lines_of([row('SKU_A', 9)]))), \
                contextlib.redirect_stdout(out):
            rc = commerce_cli.main(['cart', 'minutes', 'reconcile', '--flow', exc.flow_id,
                                    '--items-file', f.name, '--expect-hash', self.hash_of(lines_of([row('SKU_A', 9)]))])
        self.assertEqual(rc, 1)
        payload = json.loads(out.getvalue().strip().splitlines()[-1])
        self.assertEqual(payload['error'], 'MINUTES_CART_RECONCILE_BASKET_NOT_SENT')
        self.assertNotEqual(j.inspect(exc.flow_id)['state'], 'RELEASED')
        self.assertEqual([x[0] for x in harness.calls], ['sync'])
