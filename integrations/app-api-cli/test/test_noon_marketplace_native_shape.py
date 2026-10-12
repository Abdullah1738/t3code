"""Populated offline examples: native paths from HBC, values NOT live captures."""
from copy import deepcopy
import unittest

from noon_marketplace_native_shape import (
    ADDRESS_SHAPE, NATIVE_SHAPE, UNRESOLVED, WHOAMI_SHAPE,
    native_normalize, native_selected_address, native_context_binding,
    native_aed_display_minor, native_invoice_observations, native_credit_state,
    native_addon_observations,
)
from noon_marketplace_review import ReviewError, digest


def fixture():
    cart = {'groups': [
        {'items': [{'offerCode': 'fixture-offer-a', 'variantKey': 'fixture-variant',
                    'quantity': 3, 'unitPrice': '12.35', 'isSelectedForCheckout': True}]},
        {'items': [{'offerCode': 'fixture-offer-b', 'variantKey': None,
                    'quantity': 1, 'unitPrice': '7.00', 'isSelectedForCheckout': False}]}]}
    session = {'shipments': [
        {'items': [{'offerCode': 'fixture-offer-a', 'quantity': 2, 'unitPrice': '12.35'}]},
        {'items': [{'offerCode': 'fixture-offer-a', 'quantity': 1, 'unitPrice': '12.35'}]}],
        'subtotal': '37.05', 'total': '42.05', 'orderPaymentAmount': '42.05',
        'addressCode': 'fixture-home-code', 'walletAmount': '100.00', 'useCredits': False,
        'deliveryOptions': {'fixture-option': {'status': 'active', 'message': 'Fixture copy'}},
        'invoice': {'sections': [{'entries': [
            {'title': 'Fixture charge', 'amount': '<b>AED 5.00</b>'}]}]}}
    return cart, session


class NativeShapeTests(unittest.TestCase):
    def test_populated_paths_and_exact_unit_multiplication(self):
        cart, session = fixture()
        out = native_normalize(cart, session)
        self.assertEqual(out['cart_items'][0]['derived_line_minor'], 3705)
        self.assertEqual([x['derived_line_minor'] for x in out['session_items']], [2470, 1235])
        self.assertEqual(out['cart_items'][1]['isSelected'], False)
        self.assertEqual(out['source_hashes'], (digest(cart), digest(session)))
        self.assertEqual(NATIVE_SHAPE.get('cart_rows', cart),
                         [g['items'][0] for g in cart['groups']])
        self.assertEqual(NATIVE_SHAPE.get('session_rows', session),
                         [g['items'][0] for g in session['shipments']])

    def test_every_shipment_preserved_with_provenance(self):
        cart, session = fixture()
        out = native_normalize(cart, session)
        self.assertEqual(len(out['session_items']), 2)
        self.assertEqual(out['session_items'][1]['source_path'], ('shipments', 1, 'items', 0))
        # Split shipments are not silently deduplicated or keyed solely by offer.
        self.assertEqual(out['session_items'][0]['offerCode'], out['session_items'][1]['offerCode'])

    def test_do_not_accept_flat_cart_decoy_or_request_selected_flag(self):
        cart, session = fixture()
        with self.assertRaisesRegex(ReviewError, 'SCHEMA_CART_ROWS'):
            native_normalize({'items': cart['groups'][0]['items']}, session)
        row = cart['groups'][0]['items'][0]
        row['isSelected'] = row.pop('isSelectedForCheckout')
        with self.assertRaisesRegex(ReviewError, 'SCHEMA_CART_SELECTED'):
            native_normalize(cart, session)

    def test_missing_and_null_variant_are_not_filled(self):
        cart, session = fixture()
        del cart['groups'][0]['items'][0]['variantKey']
        out = native_normalize(cart, session)
        self.assertNotIn('variantKey', out['cart_items'][0])
        self.assertIsNone(out['cart_items'][1]['variantKey'])
        self.assertNotIn('variantKey', out['session_items'][0])

    def test_no_fabricated_semantic_fields(self):
        cart, session = fixture()
        out = native_normalize(cart, session)
        for name in ('seller', 'fulfillment', 'linePrice'):
            self.assertNotIn(name, out['cart_items'][0])
        for name in ('wallet', 'fee_rows', 'extras', 'tip', 'discount', 'currency',
                     'address_key', 'delivery_note', 'cart_seller', 'session_variant'):
            with self.subTest(name=name), self.assertRaisesRegex(ReviewError, 'UNSUPPORTED_'):
                NATIVE_SHAPE.get(name, session)
        self.assertEqual(out['unresolved'], UNRESOLVED)

    def test_wallet_balance_and_html_invoice_not_spend_or_numeric_fees(self):
        cart, session = fixture()
        out = native_normalize(cart, session)
        self.assertEqual(out['session_values']['wallet_balance'], '100.00')
        self.assertIs(out['session_values']['use_credits'], False)
        self.assertNotIn('wallet_spend', out['session_values'])
        self.assertEqual(out['invoice_entries'][0]['amount'], '<b>AED 5.00</b>')
        self.assertNotIn('fee_inventory', out)

    def test_options_use_object_key_and_exact_active_status(self):
        cart, session = fixture()
        session['deliveryOptions']['second-fixture'] = {'status': 'disabled'}
        out = native_normalize(cart, session)
        self.assertEqual([(r['code'], r['active']) for r in out['delivery_options']],
                         [('fixture-option', True), ('second-fixture', False)])
        self.assertNotIn('semantic', out['delivery_options'][0])
        session['deliveryOptions'] = [{'code': 'fixture-option', 'active': True}]
        with self.assertRaisesRegex(ReviewError, 'SCHEMA_DELIVERY_OPTIONS'):
            native_normalize(cart, session)

    def test_absence_cannot_establish_zero_false_empty(self):
        cart, _ = fixture()
        session = {'shipments': []}
        out = native_normalize(cart, session)
        self.assertEqual(out['session_values'], {})
        self.assertNotIn('delivery_options', out)
        self.assertNotIn('invoice_entries', out)
        self.assertIn('fee_inventory', dict(out['unresolved']))

    def test_malformed_later_shipment_is_not_dropped(self):
        cart, session = fixture()
        session['shipments'].append({})
        with self.assertRaisesRegex(ReviewError, 'SCHEMA_SESSION_ROWS'):
            native_normalize(cart, session)

    def test_strict_quantity_and_amount(self):
        for key, values in [('quantity', [True, 0, -1, '3', 1.5]),
                            ('unitPrice', [True, '-1', '.001', 'NaN'])]:
            for value in values:
                with self.subTest(key=key, value=value):
                    cart, session = fixture()
                    cart['groups'][0]['items'][0][key] = value
                    with self.assertRaises(ReviewError):
                        native_normalize(cart, session)

    def test_large_manifest_and_quantity_preserve_every_line(self):
        cart, session = fixture()
        row = cart['groups'][0]['items'][0]
        row['quantity'] = 1000001
        cart['groups'][0]['items'] = [deepcopy(row) for _ in range(1001)]
        out = native_normalize(cart, session)
        self.assertEqual(len(out['cart_items']), 1002)
        self.assertEqual(out['cart_items'][1000]['quantity'], 1000001)
        self.assertEqual(out['cart_items'][1000]['derived_line_minor'], 1235 * 1000001)
        self.assertEqual(out['cart_items'][1000]['source_path'], ('groups', 0, 'items', 1000))

    def test_large_invoice_preserves_all_rows(self):
        _, session = fixture()
        session['invoice']['sections'] = [
            {'entries': [{'title': f'Line {i}', 'amount': 'AED 1.00'}]}
            for i in range(1001)]
        rows = native_invoice_observations(session)
        self.assertEqual(len(rows), 1001)
        self.assertEqual(rows[-1]['source_path'], ('invoice', 'sections', 1000, 'entries', 0))

    def test_source_and_output_do_not_alias(self):
        cart, session = fixture()
        before = deepcopy((cart, session))
        out = native_normalize(cart, session)
        out['invoice_entries'][0]['amount'] = 'changed'
        self.assertEqual((cart, session), before)

    def test_home_binding_uses_exact_code_not_default_shipping(self):
        _, session = fixture()
        addresses = [{'addressCode': 'other', 'defaultShipping': True},
                     {'addressCode': 'fixture-home-code', 'addressKey': 'fixture-key',
                      'streetAddress': 'Fixture street', 'lat': 1, 'lng': 2}]
        address = native_selected_address(session, addresses)
        self.assertEqual(ADDRESS_SHAPE.get('address_key', address), 'fixture-key')
        for bad in (addresses[:1], addresses + [deepcopy(address)]):
            with self.assertRaisesRegex(ReviewError, 'SESSION_ADDRESS_MATCH_REQUIRED'):
                native_selected_address(session, bad)

    def test_currency_is_whoami_scoped(self):
        self.assertEqual(WHOAMI_SHAPE.get('currency',
                         {'config': {'country': {'currencyCode': 'AED'}}}), 'AED')
        with self.assertRaisesRegex(ReviewError, 'SCHEMA_CURRENCY'):
            WHOAMI_SHAPE.get('currency', {'currency': 'AED'})

    def test_native_context_binding_preserves_splits_and_cart_only_variant(self):
        cart, session = fixture()
        cart['groups'][0].update(type='fixture-group', analytics={'serviceMode': 'fixture-mode'})
        session['shipments'][0].update(id='fixture-shipment', promises=[{'isSelected': True}])
        out = native_context_binding(cart, session)
        self.assertEqual(out['links'][0]['cart_item']['variantKey'], 'fixture-variant')
        self.assertEqual(out['links'][0]['session_paths'],
                         (('shipments', 0, 'items', 0), ('shipments', 1, 'items', 0)))
        self.assertEqual(out['shipment_contexts'][0]['values']['id'], 'fixture-shipment')
        self.assertNotIn('seller', out['links'][0])
        self.assertNotIn('fulfillment', out['shipment_contexts'][0])
        self.assertNotIn('revision', out)
        self.assertEqual(out['binding_hash'], digest({k: v for k, v in out.items()
                                                     if k != 'binding_hash'}))

    def test_opaque_context_and_owner_unselected_changes_change_binding(self):
        cart, session = fixture()
        first = native_context_binding(cart, session)['binding_hash']
        cart['groups'][1]['items'][0]['quantity'] = 2
        second = native_context_binding(cart, session)['binding_hash']
        self.assertNotEqual(first, second)
        session['shipments'][0]['id'] = 'fixture-new-shipment'
        third = native_context_binding(cart, session)['binding_hash']
        self.assertNotEqual(second, third)
        session['shipments'][0]['promises'] = [{'isSelected': True, 'message': 'Fixture promise'}]
        self.assertNotEqual(third, native_context_binding(cart, session)['binding_hash'])

    def test_context_binding_rejects_ambiguous_variants_even_if_unselected(self):
        for selected in (True, False):
            cart, session = fixture()
            row = deepcopy(cart['groups'][0]['items'][0])
            row.update(variantKey='fixture-other-variant', isSelectedForCheckout=selected)
            cart['groups'][1]['items'].append(row)
            with self.assertRaisesRegex(ReviewError, 'AMBIGUOUS_CART_OFFER_CONTEXT'):
                native_context_binding(cart, session)

    def test_context_binding_checks_every_shipment(self):
        for key, value, error in [('offerCode', 'fixture-unexpected', 'OFFER'),
                                   ('quantity', 2, 'QUANTITY'),
                                   ('unitPrice', '12.36', 'UNIT')]:
            cart, session = fixture()
            session['shipments'][1]['items'][0][key] = value
            with self.subTest(key=key), self.assertRaisesRegex(ReviewError, 'SESSION_' + error):
                native_context_binding(cart, session)

    def test_exact_html_amount_without_fee_classification(self):
        for value, expected in [('<b>AED 5.00</b>', 500), ('<span>AED&nbsp;1,234.50</span>', 123450),
                                ('<strong>-2.25 AED</strong>', -225), ('AED 0', 0)]:
            with self.subTest(value=value):
                self.assertEqual(native_aed_display_minor(value), expected)
        _, session = fixture()
        session['invoice']['sections'][0]['entries'][0]['breakdown'] = {'analyticsFeeType': 'fixture-kind'}
        session['invoice']['sections'].append({'entries': [{'title': 'Fixture total', 'amount': 'AED 42.05'}]})
        out = native_invoice_observations(session)
        self.assertEqual(out[1]['source_path'], ('invoice', 'sections', 1, 'entries', 0))
        self.assertEqual(out[0]['display_amount_minor'], 500)
        self.assertEqual(NATIVE_SHAPE.get('invoice_analytics_fee_type', out[0]['native_entry']), 'fixture-kind')
        for entry in out:
            self.assertNotIn('fee_code', entry)
            self.assertNotIn('role', entry)

    def test_html_ambiguities_and_hidden_alternate_amounts_rejected(self):
        for value in ('Free', '5.00', 'USD 5.00', 'AED 1,23.45', 'AED 5.001',
                      'AED 1e2', 'AED 5.00 7.00', '<s>AED 10</s>AED 5',
                      '<span style="display:none">AED 10</span>AED 5',
                      '<b>AED 5</span>', '<b>AED 5', 'AED 5<!-- ignored -->',
                      '<script>AED 5</script>', '<img alt="AED 5">', True):
            with self.subTest(value=value), self.assertRaises(ReviewError):
                native_aed_display_minor(value)
        _, session = fixture()
        session['invoice']['sections'][0]['entries'][0]['amount'] = 'Free'
        entry = native_invoice_observations(session)[0]
        self.assertEqual(entry['native_entry']['amount'], 'Free')
        self.assertIn('amount_parse_error', entry)
        self.assertNotIn('display_amount_minor', entry)

    def test_invoice_does_not_hide_malformed_later_section(self):
        _, session = fixture()
        session['invoice']['sections'].append({})
        with self.assertRaisesRegex(ReviewError, 'SCHEMA_INVOICE_ENTRIES'):
            native_invoice_observations(session)

    def test_credit_controls_balance_sufficiency_and_actual_payment(self):
        _, session = fixture()
        out = native_credit_state(session)
        self.assertIs(out['useCredits'], False)
        self.assertTrue(out['balance_covers_total'])
        self.assertEqual(out['derived_payment_difference_minor'], 0)
        self.assertEqual(out['wallet_balance_minor'], 10000)
        self.assertNotIn('wallet_spend', out)
        session.update(useCredits=True, walletAmount='10.00', orderPaymentAmount='32.05')
        out = native_credit_state(session)
        self.assertFalse(out['balance_covers_total'])
        self.assertEqual(out['derived_payment_difference_minor'], 1000)
        session['useCredits'] = 0
        with self.assertRaisesRegex(ReviewError, 'SCHEMA_USE_CREDITS'):
            native_credit_state(session)
        del session['useCredits']
        with self.assertRaisesRegex(ReviewError, 'SCHEMA_USE_CREDITS'):
            native_credit_state(session)

    def test_actual_installation_selection_warranty_plan_and_donation(self):
        cart, session = fixture()
        row = cart['groups'][0]['items'][0]
        row['installation'] = {'isSelected': False, 'price': '<b>AED 25.00</b>'}
        row['extendedWarranty'] = {'code': 'fixture-plan', 'unitPrice': '9.50',
                                   'providerName': 'fixture-provider'}
        session['donation'] = '2.00'
        out = native_addon_observations(cart, session)
        self.assertEqual(out[0]['display_price_minor'], 2500)
        self.assertIs(out[0]['isSelected'], False)
        self.assertEqual(out[1]['code'], 'fixture-plan')
        self.assertEqual(out[1]['unit_price_minor'], 950)
        self.assertEqual(out[2]['amount_minor'], 200)
        self.assertEqual(NATIVE_SHAPE.get('cart_warranty_provider', row), 'fixture-provider')
        self.assertNotIn('isSelected', out[1])
        self.assertNotIn('tip', out[2])
        row['installation']['isSelected'] = 'false'
        with self.assertRaisesRegex(ReviewError, 'SCHEMA_INSTALLATION_SELECTED'):
            native_addon_observations(cart, session)

    def test_addon_null_and_absence_are_not_zero_or_unselected(self):
        cart, session = fixture()
        self.assertEqual(native_addon_observations(cart, session), [])
        cart['groups'][0]['items'][0]['installation'] = None
        session['donation'] = None
        out = native_addon_observations(cart, session)
        self.assertNotIn('isSelected', out[0])
        self.assertNotIn('amount_minor', out[1])

    def test_delivery_native_action_type_and_disabled_are_not_quiet_codes(self):
        cart, session = fixture()
        session['deliveryOptions'] = {'fixture-receiver': {
            'status': 'disabled', 'action': 'receiver_phone', 'type': 'checkbox',
            'message': 'Fixture alternate recipient'}}
        out = native_normalize(cart, session)['delivery_options'][0]
        self.assertTrue(out['disabled'])
        self.assertFalse(out['active'])
        self.assertEqual(out['action'], 'receiver_phone')
        self.assertEqual(out['type'], 'checkbox')
        self.assertNotIn('semantic', out)


if __name__ == '__main__':
    unittest.main()
