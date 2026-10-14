"""Paid size prices from native menu truth through exact quote reconciliation."""
from dataclasses import replace
import unittest
from unittest.mock import Mock

import talabat_http_checkout as h
import talabat_menu_choices as mc
from test.test_talabat_http_checkout import context


def paid_size(quantity=1, choice_quantity=1, base=19, choice_price=2,
              original=-1, choice_original=-1):
    home, config, card, store, _, raw, _, data = context('restaurants')
    items = (h.Item(12345, quantity, choices=((123, choice_quantity, ()),)),)
    menu = {'vendor': {'result': {'restaurant': {'bid': store.branch_id}}},
            'menu': {'result': {'menu': {'menuSection': [{'nm': 'Drinks', 'itm': [
                {'id': 12345, 'nm': 'Iced Tea', 'pr': base, 'opr': original, 'icc': True}]}]}}}}
    choices = {'result': {'choiceForItem': [{'choiceSections': [{
        'id': 456, 'iid': 12345, 'nm': 'Size', 'mnq': 1, 'mxq': 1, 'ich': [
            {'id': 123, 'nm': 'Large', 'pr': choice_price, 'opr': choice_original,
             'subCategories': None}]}]}]}}
    c = object.__new__(h.Checkout)
    c.home, c._choice_catalog, c._item_prices = home, None, None
    c._read = Mock(side_effect=[menu, choices])
    c.verify_restaurant_items(store.branch_id, items)
    total = (base + choice_price * choice_quantity) * quantity
    raw['cart']['totalValue'] = total
    raw['cart']['items'][0].update(quantity=quantity, choices=[123], choicesString='Large',
        choicesDetails=[{'id': 123, 'quantity': choice_quantity, 'itemChoiceSectionId': 456,
                        'localeNames': [{'locale': 'en', 'value': 'Large'}]}])
    cart = h.parse_cart(raw, store, items, choice_catalog=c._choice_catalog, item_prices=c._item_prices)
    checkout = data['checkout']
    checkout['cart']['items'][0].update(quantity=quantity, price=f'AED {base:.2f}',
                                      total=f'AED {total:.2f}', choicesString='Large')
    checkout['amount'] = total + 6.55
    checkout['paymentSummary']['items'] = [
        {'type': 'SubTotal', 'amount': total}, {'type': 'DeliveryFee', 'amount': 5.5},
        {'type': 'ServiceFee', 'amount': 1.05}, {'type': 'Total', 'amount': total + 6.55}]
    return home, config, card, cart, data


class PaidChoiceQuotes(unittest.TestCase):
    def parse(self, home, cart, data, selection=None):
        body = h.prepare_body(cart.store, home, selection=selection,
            features=None if selection else {'paySupportsTPro': False},
            instructions=data['checkout']['deliveryInstructions'] if selection else None)
        return h.parse_quote(data, cart, home, body, selection)

    def test_negative_original_sentinel_paid_size_initial_and_quiet(self):
        # Live monetary shape: base 19, Large +2, total 21, payable 27.55.
        for base in (19, 21):
            for quantity, choice_quantity in ((1, 1), (2, 1), (2, 2)):
                for selected in (False, True):
                    with self.subTest(base=base, quantity=quantity, choice_quantity=choice_quantity,
                                      selected=selected):
                        home, config, card, cart, data = paid_size(quantity, choice_quantity, base)
                        selection = h.select_payment(config, card) if selected else None
                        quote = self.parse(home, cart, data, selection)
                        expected = (base + 2 * choice_quantity) * quantity * 100
                        self.assertEqual(cart.line_undiscounted, (expected,))
                        self.assertEqual(quote.amount_minor, expected + 655)
                        self.parse(home, replace(cart, route_amount_minor=quote.amount_minor), data, selection)

    def test_paid_choice_discount_keeps_original_anchor(self):
        home, _, _, cart, data = paid_size(2, base=18, choice_price=1.5,
                                          original=20, choice_original=2)
        checkout = data['checkout']
        checkout['paymentSummary']['items'][0]['amount'] = 44
        checkout['paymentSummary']['items'].append({'type': 'AutoAppliedDiscount', 'amount': 5})
        self.assertEqual(cart.line_undiscounted, (4400,))
        self.assertEqual(self.parse(home, cart, data).amount_minor, 4555)

    def test_changed_size_price_or_total_is_not_accepted(self):
        for change in ('row', 'subtotal', 'fees', 'total', 'choice', 'quantity'):
            with self.subTest(change=change):
                home, _, _, cart, data = paid_size()
                checkout = data['checkout']; row = checkout['cart']['items'][0]
                charges = checkout['paymentSummary']['items']
                if change == 'row': row['total'] = 'AED 21.01'
                elif change == 'subtotal':
                    # Internally consistent increase must still fail menu truth.
                    row['total'] = 'AED 22.00'
                    charges[0]['amount'] = 22
                    charges[-1]['amount'] = checkout['amount'] = 28.55
                elif change == 'fees': charges[1]['amount'] = 5.51
                elif change == 'total': checkout['amount'] = 27.56
                elif change == 'choice': row['choicesString'] = 'Medium'
                elif change == 'quantity': row['quantity'] = 2
                with self.assertRaises(h.orders.TalabatError):
                    self.parse(home, cart, data)


class OriginalPriceSentinel(unittest.TestCase):
    def test_only_explicit_sentinel_uses_valid_current_price(self):
        for price in (0, 2, '2.25'):
            with self.subTest(price=price):
                current, original = mc._prices({'pr': price, 'opr': -1})
                self.assertEqual(original, current)
                self.assertIsNotNone(original)
        for price in (None, True, -1, 'invalid'):
            with self.subTest(price=price):
                self.assertEqual(mc._prices({'pr': price, 'opr': -1}), (None, None))
        for original in (None, -2, False, '-1', 'invalid'):
            with self.subTest(original=original):
                self.assertEqual(mc._prices({'pr': 2, 'opr': original}), (200, None))
        self.assertEqual(mc._prices({'pr': 2, 'opr': 3}), (200, 300))


class NestedChoiceBounds(unittest.TestCase):
    def catalog(self, minimum=1):
        # Dunkin sizes have required milk and optional syrup/espresso sections.
        return {'result': {'choiceForItem': [{'choiceSections': [{
            'id': 456, 'iid': 12345, 'nm': 'Size', 'mnq': 1, 'mxq': 1, 'ich': [
                {'id': 123, 'nm': 'Large', 'pr': 2, 'opr': -1, 'subCategories': [{
                    'id': 789, 'iid': 123, 'nm': 'Milk', 'mnq': minimum, 'mxq': 1,
                    'ich': [{'id': 321, 'nm': 'Full Fat Milk', 'pr': 0, 'opr': -1,
                             'subCategories': None}]}]}]}]}]}}

    def test_required_nested_milk_refused_before_cart(self):
        choices = mc.parse_choices(self.catalog(), 12345)
        with self.assertRaisesRegex(h.orders.TalabatError, 'MENU_SUBCHOICE_SECTION_BOUNDS_FAILED'):
            mc.validate_line_choices(choices, ((123, 1, ()),))
        option = choices.options_by_id()[123]
        self.assertEqual(option.sub_categories[0].name, 'Milk')
        self.assertEqual(option.sub_categories[0].min_select, 1)
        self.assertEqual(option.sub_categories[0].options[0].name, 'Full Fat Milk')

    def test_optional_nested_choices_empty_or_selected(self):
        choices = mc.parse_choices(self.catalog(0), 12345)
        self.assertEqual(mc.validate_line_choices(choices, ((123, 1, ()),)), ((123, 1, ()),))
        self.assertEqual(mc.validate_line_choices(choices, ((123, 1, (321,)),)), ((123, 1, (321,)),))

    def test_unknown_nested_bounds_not_treated_as_optional(self):
        for value in (None, True, -1, '0'):
            data = self.catalog()
            data['result']['choiceForItem'][0]['choiceSections'][0]['ich'][0]['subCategories'][0]['mnq'] = value
            with self.subTest(value=value), self.assertRaises(h.orders.TalabatError):
                mc.parse_choices(data, 12345)


if __name__ == '__main__':
    unittest.main()
