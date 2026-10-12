"""Offline synthetic contract tests; no credentials, live cart, or order fixtures."""
import copy
from dataclasses import FrozenInstanceError, replace
import sys
from pathlib import Path
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import noon_checkout as n


def home_payload():
    headers = {'x-addresscode': 'SYNTHETIC-HOME', 'x-addresskey': 'SYNTHETIC-KEY'}
    address = {'addressCode': headers['x-addresscode'], 'addressKey': headers['x-addresskey'],
               'addressTitle': 'BanyanTree Hillside - Flat 2104',
               'streetAddress': 'D 61 - Dubai', 'lat': n.HOME_PIN[0], 'lng': n.HOME_PIN[1],
               'phone': 'PRIVATE-DO-NOT-PROJECT'}
    return {'customer': {'customerCode': 'SYNTHETIC-CUSTOMER'},
            'experiences': [{'selectedAddress': address}]}, headers


def sample(service='minutes'):
    data, headers = home_payload()
    home = n.project_home(data, headers, service, checked_at=1000)
    line = n.Line(n.Product(service, 'store-A', 'fulfillment-A', 'shake-vanilla-330ml', 'offer-A'),
                  2, 1295, 2590)
    quiet = n.Quiet('selected', 'selected', 'selected', True, n.QUIET_NOTE, True,
                    n.fingerprint('quiet-schema-and-readback'))
    payment = n.Payment('saved_card', '5542', 'mastercard', n.fingerprint('card-A'), 0, 3390, 'none')
    quote = n.Quote(service, home.account_ref, home.address_ref, n.fingerprint('cart-A'),
                    n.fingerprint('revision-A'), 1000, 1060, 'AED', (line,), True,
                    (('delivery', 800),), True, 3390, payment, quiet,
                    n.fingerprint('delivery-slot-A'), True)
    return quote, home, (line,)


class AccountReadTests(unittest.TestCase):
    def test_exact_home_all_services_private_projection(self):
        for service in n.SERVICES:
            data, headers = home_payload()
            result = n.project_home(data, headers, service, checked_at=1000)
            self.assertEqual(result.service, service)
            self.assertEqual(len(result.account_ref), 64)
            self.assertNotIn('SYNTHETIC', repr(result))
            self.assertNotIn('PRIVATE', repr(result))

    def test_guest_rejected(self):
        data, headers = home_payload()
        data['customer'] = {}
        with self.assertRaisesRegex(n.CheckoutError, 'AUTH_EXPIRED'):
            n.project_home(data, headers, 'minutes', checked_at=1000)

    def test_wrong_address_code_and_key_rejected(self):
        for field in ('addressCode', 'addressKey'):
            data, headers = home_payload()
            data['experiences'][0]['selectedAddress'][field] = 'WORK'
            with self.assertRaisesRegex(n.CheckoutError, 'HOME_MISMATCH'):
                n.project_home(data, headers, 'minutes', checked_at=1000)

    def test_wrong_flat_banyan_substring_insufficient(self):
        for title in ('BanyanTree Hillside Flat 21040', 'Banyan office Flat 2104',
                      'BanyanTree Other Flat 2104'):
            data, headers = home_payload()
            data['experiences'][0]['selectedAddress']['addressTitle'] = title
            with self.assertRaisesRegex(n.CheckoutError, 'HOME_MISMATCH'):
                n.project_home(data, headers, 'minutes', checked_at=1000)

    def test_pin_exact_integer_not_old_pin(self):
        for lat in (250778835, 25.0778251, str(n.HOME_PIN[0]), True):
            data, headers = home_payload()
            data['experiences'][0]['selectedAddress']['lat'] = lat
            with self.assertRaisesRegex(n.CheckoutError, 'HOME_PIN_MISMATCH'):
                n.project_home(data, headers, 'minutes', checked_at=1000)

    def test_conflicting_matching_experience_fails(self):
        data, headers = home_payload()
        other = copy.deepcopy(data['experiences'][0])
        other['selectedAddress']['lat'] += 1
        data['experiences'].append(other)
        with self.assertRaisesRegex(n.CheckoutError, 'HOME_PIN_MISMATCH'):
            n.project_home(data, headers, 'main', checked_at=1000)

    def test_missing_address_identifier_cannot_match_stringified_none(self):
        for address_field, header in (('addressCode', 'x-addresscode'), ('addressKey', 'x-addresskey')):
            data, headers = home_payload()
            del data['experiences'][0]['selectedAddress'][address_field]
            headers[header] = 'None'
            with self.assertRaisesRegex(n.CheckoutError, 'HOME_MISMATCH'):
                n.project_home(data, headers, 'main', checked_at=1000)

    def test_reader_narrow_get_seam(self):
        data, headers = home_payload()
        loader, getter = Mock(return_value=headers), Mock(return_value=data)
        reader = n.ReadOnlyCheckout(headers_loader=loader, whoami_get=getter)
        for service in sorted(n.SERVICES):
            self.assertEqual(reader.account_home(service).service, service)
        self.assertEqual(loader.call_count, 4)
        self.assertEqual(getter.call_count, 4)
        self.assertTrue(all(call.args[0] == headers for call in getter.call_args_list))
        self.assertTrue(all(call.args[1] > time.monotonic() for call in getter.call_args_list))

    def test_default_route_is_literal_whoami(self):
        data, headers = home_payload()
        with patch.object(n.tracking, 'request', return_value=data) as request:
            n.ReadOnlyCheckout(headers_loader=lambda _: headers).account_home('main')
        self.assertEqual(request.call_count, 1)
        self.assertEqual(request.call_args.args[0], 'whoami')
        self.assertEqual(len(request.call_args.args), 3)

    def test_failure_never_retries(self):
        data, headers = home_payload()
        getter = Mock(side_effect=n.tracking.NoonError('AUTH_EXPIRED'))
        with self.assertRaisesRegex(n.CheckoutError, 'AUTH_EXPIRED'):
            n.ReadOnlyCheckout(headers_loader=lambda _: headers, whoami_get=getter).account_home('main')
        getter.assert_called_once()

    def test_unexpected_exceptions_never_expose_response_or_headers(self):
        data, headers = home_payload()
        for error in (ValueError('PRIVATE response'), n.tracking.NoonError('SECRET raw payload')):
            getter = Mock(side_effect=error)
            with self.assertRaisesRegex(n.CheckoutError, '^ACCOUNT_READ_FAILED$'):
                n.ReadOnlyCheckout(headers_loader=lambda _: headers, whoami_get=getter).account_home('main')
            getter.assert_called_once()

    def test_expired_storage_budget_never_calls_get(self):
        data, headers = home_payload()
        getter = Mock(return_value=data)
        # Start budget 1s, enter alarm at 1s, storage returns at 2s: no HTTP call.
        with patch.object(n.tracking.time, 'monotonic', side_effect=(1000, 1000, 1002)):
            with self.assertRaisesRegex(n.CheckoutError, 'NATIVE_READ_TIMEOUT'):
                n.ReadOnlyCheckout(headers_loader=lambda _: headers, whoami_get=getter).account_home('main', timeout=1)
        getter.assert_not_called()

    def test_invalid_service_and_timeout_before_storage(self):
        loader, getter = Mock(), Mock()
        reader = n.ReadOnlyCheckout(headers_loader=loader, whoami_get=getter)
        for service in ('marketplace', 'food', '', None, []):
            with self.assertRaises(n.CheckoutError):
                reader.account_home(service)
        for timeout in (True, -1, 0, 61, float('inf'), float('nan')):
            with self.assertRaises(n.CheckoutError):
                reader.account_home('minutes', timeout=timeout)
        loader.assert_not_called()
        getter.assert_not_called()

    def test_all_cart_quote_write_entrypoints_fail_before_io(self):
        loader, getter = Mock(), Mock()
        reader = n.ReadOnlyCheckout(headers_loader=loader, whoami_get=getter)
        for service in n.SERVICES:
            for fn in (reader.cart, reader.quote):
                with self.assertRaises(n.CheckoutError):
                    fn(service)
            for operation in ('add', 'set_quantity', 'quote', 'place_order', 'cancel', 'refresh_auth'):
                with self.assertRaisesRegex(n.CheckoutError, 'CHECKOUT_MUTATIONS_DISABLED'):
                    reader.mutate(service, operation, enabled=True, force=True)
        loader.assert_not_called()
        getter.assert_not_called()

    def test_nownow_template_not_noon_or_order_url(self):
        _, headers = home_payload()
        headers.update({'Host': 'do-not-forward', 'Cookie': 'SYNTHETIC-SECRET'})
        record = {'templates': {'GET api-app-fd.noon.com/_svc/mp-shop-api-ctnoon/v2/content/search':
                                {'headers': headers}}}
        with patch.object(n.tracking, 'load', return_value=record) as load:
            result = n._load_headers('nownow')
        load.assert_called_once_with('nownow')
        self.assertNotIn('host', result)
        self.assertEqual(result['cookie'], 'SYNTHETIC-SECRET')


class QuoteSafetyTests(unittest.TestCase):
    def setUp(self):
        self.quote, self.home, self.items = sample()

    def check(self, **updates):
        return n.validate_quote(replace(self.quote, **updates), self.home, self.items, now=1001)

    def fails(self, code, **updates):
        with self.assertRaisesRegex(n.CheckoutError, code):
            self.check(**updates)

    def test_valid_synthetic_quote_each_service(self):
        for service in n.SERVICES:
            quote, home, items = sample(service)
            self.assertIsNone(n.validate_quote(quote, home, items, now=1001))
            self.assertFalse(n.readiness(service)['ready_to_order'])

    def test_immutable(self):
        with self.assertRaises(FrozenInstanceError):
            self.quote.total_minor = 1
        with self.assertRaises(FrozenInstanceError):
            self.items[0].quantity = 50

    def test_cross_service_and_same_sku_different_offer(self):
        self.fails('CROSS_SERVICE', service='supermall')
        product = self.items[0].product
        for field, value in (('service', 'main'), ('merchant_ref', 'store-B'),
                             ('fulfillment_ref', 'warehouse-B'), ('offer_ref', 'offer-B'),
                             ('sku', 'same-title-different-size')):
            line = replace(self.items[0], product=replace(product, **{field: value}))
            self.fails('CROSS_SERVICE|CART_ITEMS_OR_PRICES_CHANGED', items=(line,))

    def test_account_address_cart_revision_binding_required(self):
        for field in ('account_ref', 'address_ref', 'cart_ref', 'server_revision'):
            self.fails('BINDING_INCOMPLETE', **{field: ''})
        self.fails('ACCOUNT_OR_HOME_MISMATCH', account_ref=n.fingerprint('different-account'))
        self.fails('ACCOUNT_OR_HOME_MISMATCH', address_ref=n.fingerprint('different-home'))

    def test_unknown_manifest_extra_item_duplicate_or_empty(self):
        self.fails('CART_MANIFEST_INCOMPLETE', items_complete=False)
        self.fails('CART_MANIFEST_INCOMPLETE', items=())
        self.fails('CART_MANIFEST_INCOMPLETE', items=list(self.items))
        self.fails('DUPLICATE_PRODUCT', items=self.items * 2)
        extra = replace(self.items[0], product=replace(self.items[0].product, sku='unexpected-gift'))
        self.fails('CART_ITEMS_OR_PRICES_CHANGED', items=self.items + (extra,))

    def test_quantity_price_exact_and_nonboolean(self):
        for value in (True, 0, -1, 2.0, '2'):
            self.fails('INVALID_QUANTITY', items=(replace(self.items[0], quantity=value),))
        self.fails('LINE_TOTAL_MISMATCH', items=(replace(self.items[0], total_minor=1),))
        self.fails('INVALID_PRICE', items=(replace(self.items[0], unit_minor=True),))
        self.fails('CART_ITEMS_OR_PRICES_CHANGED', items=(replace(self.items[0], unit_minor=1300, total_minor=2600),))

    def test_single_store_for_quick_commerce(self):
        for service in ('minutes', 'nownow'):
            quote, home, items = sample(service)
            extra = replace(items[0], product=replace(items[0].product, merchant_ref='store-B'))
            with self.assertRaisesRegex(n.CheckoutError, 'MIXED_STORE_CART'):
                n.validate_quote(replace(quote, items=items + (extra,)), home, items + (extra,), now=1001)

    def test_freshness_nan_future_expired_and_stale_home(self):
        for updates in ({'observed_at': 1002}, {'expires_at': 1001}, {'observed_at': float('nan')},
                        {'expires_at': float('inf')}, {'observed_at': 900}, {'expires_at': 2000},
                        {'observed_at': 10 ** 1000}):
            self.fails('QUOTE_EXPIRED_OR_INVALID', **updates)
        with self.assertRaisesRegex(n.CheckoutError, 'HOME_READ_STALE'):
            n.validate_quote(self.quote, replace(self.home, checked_at=900), self.items, now=1001)

    def test_totals_require_complete_reconciliation(self):
        self.fails('TOTALS_INCOMPLETE', totals_complete=False)
        self.fails('FINAL_TOTAL_MISMATCH', total_minor=3400)
        self.fails('FINAL_TOTAL_MISMATCH', adjustments=())
        self.fails('INVALID_TOTAL', currency='USD')
        self.fails('INVALID_TOTAL', total_minor=True)
        self.fails('INVALID_ADJUSTMENT', adjustments=(('fee', 400), ('fee', 400)))
        self.fails('INVALID_ADJUSTMENT', adjustments=(('fee', True),))
        self.fails('INVALID_ADJUSTMENT', adjustments=((' ', 800),))
        self.fails('TOTALS_INCOMPLETE', adjustments=(('fee', 800),) * 101)

    def test_blank_or_control_character_product_references_rejected(self):
        for value in ('   ', '\x7f', 'sku\n'):
            line = replace(self.items[0], product=replace(self.items[0].product, offer_ref=value))
            self.fails('PRODUCT_IDENTITY_INCOMPLETE', items=(line,))

    def test_discounts_not_mistaken_for_zero_fee(self):
        self.check(adjustments=(('delivery', 900), ('discount', -100)))

    def test_saved_card_5542_exact_network_and_allocation(self):
        for update in ({'last4': '1111'}, {'last4': '****5542'}, {'network': 'visa'},
                       {'method': 'cash'}, {'selected_card_ref': ''}):
            self.fails('CARD_MISMATCH', payment=replace(self.quote.payment, **update))
        for update in ({'credits_minor': 1}, {'credits_minor': False}, {'card_charge_minor': 1}):
            self.fails('PAYMENT_ALLOCATION_MISMATCH', payment=replace(self.quote.payment, **update))

    def test_payment_challenge_parent_not_silent_downgrade(self):
        for challenge in ('cvv', '3ds', 'unknown', None):
            self.fails('PAYMENT_CHALLENGE_REQUIRES_PARENT',
                       payment=replace(self.quote.payment, challenge=challenge))

    def test_all_quiet_toggles_and_note_required(self):
        for field in ('leave_at_door', 'dont_ring_bell', 'dont_call'):
            for value in ('unknown', 'unselected', True):
                self.fails('QUIET_TOGGLE_NOT_VERIFIED', quiet=replace(self.quote.quiet, **{field: value}))
        self.fails('QUIET_CONTROLS_UNKNOWN', quiet=replace(self.quote.quiet, inventory_complete=False))
        self.fails('QUIET_CONTROLS_UNKNOWN', quiet=replace(self.quote.quiet, evidence_ref=''))
        self.fails('QUIET_NOTE_MISMATCH', quiet=replace(self.quote.quiet, note='Leave at door.'))
        self.fails('QUIET_NOTE_SUPPORT_UNKNOWN', quiet=replace(self.quote.quiet, note_supported=None))

    def test_unsupported_control_needs_complete_inventory_and_text(self):
        self.check(quiet=replace(self.quote.quiet, dont_call='unsupported'))
        self.check(quiet=replace(self.quote.quiet, note_supported=False, note=None))
        self.fails('QUIET_INSTRUCTIONS_UNREPRESENTABLE', quiet=replace(
            self.quote.quiet, dont_call='unsupported', note_supported=False, note=None))

    def test_delivery_choice_must_be_bound(self):
        self.fails('DELIVERY_SELECTION_UNKNOWN', delivery_complete=False)
        self.fails('DELIVERY_SELECTION_UNKNOWN', delivery_ref='')

    def test_binding_round_trip(self):
        binding = n.bind_quote(self.quote, self.home, self.items, now=1001)
        self.assertTrue(n.verify_binding(binding, self.quote, self.home, self.items, now=1002))
        self.assertEqual(len(binding.digest), 64)

    def test_immutable_binding_all_critical_fields(self):
        binding = n.bind_quote(self.quote, self.home, self.items, now=1001)
        for update in ({'cart_ref': n.fingerprint('other-cart')},
                       {'server_revision': n.fingerprint('new-revision')},
                       {'delivery_ref': n.fingerprint('slower-slot')},
                       {'payment': replace(self.quote.payment, selected_card_ref=n.fingerprint('other-card'))},
                       {'quiet': replace(self.quote.quiet, evidence_ref=n.fingerprint('new-quiet'))},
                       {'observed_at': 1001}, {'expires_at': 1059}):
            with self.assertRaisesRegex(n.CheckoutError, 'QUOTE_CHANGED'):
                n.verify_binding(binding, replace(self.quote, **update), self.home, self.items, now=1002)


class AttemptAndReadinessTests(unittest.TestCase):
    def setUp(self):
        quote, home, items = sample()
        self.binding = n.bind_quote(quote, home, items, now=1001)
        self.attempt = n.reserve_attempt(n.fingerprint('owner-intent-A'), self.binding)

    def reconcile(self, attempt, refs):
        return n.reconcile_attempt(attempt, matched_intent_ref=attempt.intent_ref,
                                   matched_digest=attempt.binding.digest, order_refs=refs)

    def test_dispatch_always_enters_reconcile_before_result(self):
        pending = n.mark_dispatched(self.attempt)
        self.assertEqual(pending.state, 'reconcile_required')
        with self.assertRaisesRegex(n.CheckoutError, 'NO_BLIND_RETRY'):
            n.mark_dispatched(pending)

    def test_empty_or_multiple_history_never_unlock_retry(self):
        pending = n.mark_dispatched(self.attempt)
        for refs in ((), (n.fingerprint('order-A'), n.fingerprint('order-B'))):
            result = self.reconcile(pending, refs)
            self.assertEqual(result.state, 'reconcile_required')
            self.assertIsNone(result.order_ref)
            with self.assertRaisesRegex(n.CheckoutError, 'NO_BLIND_RETRY'):
                n.mark_dispatched(result)

    def test_exact_single_order_resolves_without_retry(self):
        confirmed = self.reconcile(n.mark_dispatched(self.attempt), (n.fingerprint('order-A'),))
        self.assertEqual(confirmed.state, 'confirmed')
        with self.assertRaisesRegex(n.CheckoutError, 'NO_BLIND_RETRY'):
            n.mark_dispatched(confirmed)

    def test_reconcile_identity_mismatch(self):
        for intent, digest in ((n.fingerprint('other'), self.binding.digest),
                               (self.attempt.intent_ref, n.fingerprint('other'))):
            with self.assertRaisesRegex(n.CheckoutError, 'RECONCILE_IDENTITY_MISMATCH'):
                n.reconcile_attempt(n.mark_dispatched(self.attempt), matched_intent_ref=intent,
                                    matched_digest=digest, order_refs=(n.fingerprint('order-A'),))

    def test_no_reconcile_before_dispatch(self):
        with self.assertRaisesRegex(n.CheckoutError, 'INVALID_ATTEMPT_STATE'):
            self.reconcile(self.attempt, ())

    def test_no_cancellation_guess_from_status_or_url(self):
        for service in n.SERVICES:
            status = n.cancellation_eligibility(service)
            self.assertIsNone(status['eligible'])
            self.assertFalse(status['executable'])

    def test_nothing_is_checkout_ready(self):
        for service in n.SERVICES:
            report = n.readiness(service)
            self.assertFalse(report['ready_to_order'])
            self.assertFalse(report['mutations_enabled'])
            self.assertIn('server_idempotency_and_reconcile', report['missing'])


if __name__ == '__main__':
    unittest.main()
