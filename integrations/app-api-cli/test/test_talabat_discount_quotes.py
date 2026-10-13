"""Gross/net quote reconciliation with synthetic account and cart identities."""
import copy
from dataclasses import replace
import unittest

import talabat_http_checkout as h
from test.test_talabat_http_checkout import context


def discounted(quantity=1, note=''):
    home, config, card, store, _, raw, _, data = context('restaurants')
    items = (h.Item(12345, quantity, note=note),)
    raw['cart']['items'][0].update(quantity=quantity, specialRequest=note)
    raw['cart']['totalValue'] = 75 * quantity
    # Plain menu items do not fetch or populate a choice catalog.
    cart = h.parse_cart(raw, store, items, item_prices={12345: 10500})
    checkout = data['checkout']
    checkout.update(amount=h.major(7500 * quantity + 490), discountsTotal=30 * quantity)
    checkout['cart']['items'][0].update(quantity=quantity, specialRequest=note,
        price='AED 105.00', total='AED ' + h.major(7500 * quantity))
    checkout['paymentSummary']['items'] = [
        {'type':'SubTotal','amount':105 * quantity,'value':'AED ' + h.major(10500 * quantity)},
        {'type':'AutoAppliedDiscount','amount':30 * quantity,'value':'- AED ' + h.major(3000 * quantity)},
        {'type':'DeliveryFee','amount':0,'value':'AED 4.90'},
        {'type':'ServiceFee','amount':4.9,'value':'AED 4.90'},
        {'type':'Total','amount':h.major(7500 * quantity + 490),'value':'AED ' + h.major(7500 * quantity + 490)}]
    return home, config, card, cart, data


class DiscountQuoteTests(unittest.TestCase):
    def parse(self, home, cart, data, selection=None):
        body = h.prepare_body(cart.store, home, selection=selection,
            features=None if selection else {'paySupportsTPro':False},
            instructions=data['checkout']['deliveryInstructions'] if selection else None)
        return h.parse_quote(data, cart, home, body, selection)

    def test_original_unit_net_total_initial_and_selected_quiet(self):
        for quantity in (1, 2):
            for selected in (False, True):
                with self.subTest(quantity=quantity, selected=selected):
                    home, config, card, cart, data = discounted(quantity, 'No onions please')
                    selection = h.select_payment(config, card) if selected else None
                    quote = self.parse(home, cart, data, selection)
                    self.assertEqual(quote.amount_minor, 7500 * quantity + 490)
                    self.assertEqual(cart.line_undiscounted, (10500 * quantity,))
                    self.assertEqual(h.project_quote(quote)['item_notes'][0]['note'], 'No onions please')
                    # After quoting, the food cart's totalValue can be payable.
                    self.parse(home, replace(cart, route_amount_minor=quote.amount_minor), data, selection)

    def test_original_rows_or_effective_unit_price_both_reconcile(self):
        for field, value in (('total', 'AED 105.00'), ('price', 'AED 75.00')):
            home, _, _, cart, data = discounted()
            data['checkout']['cart']['items'][0][field] = value
            self.assertEqual(self.parse(home, cart, data).amount_minor, 7990)

    def test_mixed_manifest_reordered_lines_keep_catalog_price_binding(self):
        home, _, _, cart, data = discounted(2)
        cart = replace(cart, items=cart.items + (h.Item(12346, 1),),
            quote_item_ids=cart.quote_item_ids + ((12346, '334'),), line_choice_labels=('', ''),
            line_undiscounted=(21000, 1000), route_amount_minor=16000)
        checkout = data['checkout']
        checkout['cart']['items'].insert(0, {'id':'334', 'quantity':1, 'price':'AED 10.00', 'total':'AED 10.00'})
        checkout['paymentSummary']['items'][0]['amount'] = 220
        checkout['paymentSummary']['items'][-1]['amount'] = checkout['amount'] = 164.9
        self.assertEqual(self.parse(home, cart, data).amount_minor, 16490)
        checkout['cart']['items'][0]['price'] = 'AED 11.00'
        with self.assertRaisesRegex(h.orders.TalabatError, 'QUOTE_ITEM_PRICE_MISMATCH'):
            self.parse(home, cart, data)

    def test_unexpected_prices_manifest_or_money_still_reject(self):
        for change in ('unit', 'row', 'above_original', 'subtotal', 'discount', 'amount',
                       'total', 'delivery', 'service', 'duplicate_discount', 'unknown_fee',
                       'quantity', 'note', 'line_id', 'cart_amount', 'no_catalog'):
            with self.subTest(change=change):
                home, _, _, cart, data = discounted(note='No onions please')
                checkout = data['checkout']; row = checkout['cart']['items'][0]
                charges = checkout['paymentSummary']['items']
                if change == 'unit': row['price'] = 'AED 106.00'
                elif change == 'row': row['total'] = 'AED 75.01'
                elif change == 'above_original': row['total'] = 'AED 105.01'
                elif change == 'subtotal': charges[0]['amount'] = 105.01
                elif change == 'discount': charges[1]['amount'] = 29.99
                elif change == 'amount': checkout['amount'] = 79.91
                elif change == 'total': charges[-1]['amount'] = 79.91
                elif change == 'delivery': charges[2]['amount'] = 4.9
                elif change == 'service': charges[3]['amount'] = 4.91
                elif change == 'duplicate_discount': charges.append(copy.deepcopy(charges[1]))
                elif change == 'unknown_fee': charges.append({'type':'UnknownFee','amount':0})
                elif change == 'quantity': row['quantity'] = 2
                elif change == 'note': row['specialRequest'] = ''
                elif change == 'line_id': row['id'] = '999'
                elif change == 'cart_amount': cart = replace(cart, route_amount_minor=7501)
                elif change == 'no_catalog': cart = replace(cart, line_undiscounted=())
                with self.assertRaises(h.orders.TalabatError):
                    self.parse(home, cart, data)

    def test_plain_catalog_anchor_does_not_invent_missing_choice_prices(self):
        _, _, _, cart, _ = discounted()
        item = h.Item(12345, 1, choices=((123, 1, ()),))
        for catalog in (None, {}, {123:{'original_price_minor':None}}):
            self.assertEqual(h._line_undiscounted(cart.store, (item,), catalog, {12345:10500}), ())


if __name__ == '__main__':
    unittest.main()
