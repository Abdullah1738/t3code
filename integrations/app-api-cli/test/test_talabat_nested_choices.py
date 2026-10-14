"""Latea's captured parent/child wire shape and exact manifest verification."""
import copy
from dataclasses import asdict, replace
import unittest
from unittest.mock import Mock

import talabat_basket as basket
import talabat_http_checkout as h
import talabat_menu_choices as mc
import talabat_restaurant_cart as rc
from commerce_talabat import intent_scope
from test.test_talabat_http_checkout import context

ITEM, SIZE, SUGAR, OTHER_SUGAR, JELLY = 753916565, 1391242560, 1400704784, 1400704785, 1400704776


def catalog():
    sugar = mc.ChoiceSection(3176984, SIZE, 'Sugar', 1, 1, (
        mc.ChoiceOption(SUGAR, 3176984, '50% Sugar', 0, 0, False),
        mc.ChoiceOption(OTHER_SUGAR, 3176984, '25% Sugar', 0, 0, False)))
    extra = mc.ChoiceSection(3176983, SIZE, 'Extras', 0, 10, (
        mc.ChoiceOption(JELLY, 3176983, 'Crystal Jelly', 210, 300, False),))
    size = mc.ChoiceOption(SIZE, 910577506, 'Cold 700 Ml', 1890, 2700, True, (sugar, extra))
    return mc.ItemChoices(ITEM, (mc.ChoiceSection(910577506, ITEM, 'Size', 1, 1, (size,)),))


def native_row():
    # Redacted native POST/GET cart echo captured 2026-10-14, not a seed-row roundtrip.
    return {'id': 101, 'menuItemId': ITEM, 'quantity': 1, 'specialRequest': '',
        'choices': [SIZE, SUGAR, JELLY], 'choicesString': 'Cold 700 Ml, 50% Sugar, Crystal Jelly',
        'choicesDetails': [{'id': SIZE, 'quantity': 1, 'itemChoiceSectionId': 910577506,
            'localeNames': [{'locale': 'en', 'value': 'Cold 700 Ml'}],
            'subChoicesDetails': [
                {'id': SUGAR, 'quantity': 1, 'localeNames': [{'locale': 'en', 'value': '50% Sugar'}]},
                {'id': JELLY, 'quantity': 1, 'localeNames': [{'locale': 'en', 'value': 'Crystal Jelly'}]}]}]}


class NestedChoices(unittest.TestCase):
    def setUp(self):
        self.choices = ((SIZE, 1, (JELLY, SUGAR)),)
        self.item = h.Item(ITEM, 1, choices=self.choices)
        self.catalog = mc.choice_catalog(catalog())
        self.store = h.Store('restaurants', 745022, 0, False)

    def test_manifest_wire_discovery_and_scope(self):
        parsed = basket.parse_items([{'item_id': ITEM, 'choices': [
            {'choice_id': SIZE, 'sub_choice_ids': [SUGAR, JELLY]}]}], vertical='restaurants')
        self.assertEqual(parsed, (self.item,))
        home = context('restaurants')[0]
        self.assertEqual(h.cart_body(self.store, home, parsed)['items'][0]['choices'], [
            {'choiceId': SIZE, 'quantity': 1, 'subChoiceIds': [JELLY, SUGAR]}])
        discovery = asdict(catalog())['sections'][0]['options'][0]['sub_categories']
        self.assertEqual(discovery[0]['min_select'], 1)
        self.assertEqual(discovery[0]['options'][0]['option_id'], SUGAR)
        other = h.Item(ITEM, 1, choices=((SIZE, 1, (OTHER_SUGAR,)),))
        self.assertNotEqual(intent_scope('restaurants', 745022, parsed),
                            intent_scope('restaurants', 745022, (other,)))

    def test_invalid_ids_duplicate_children_and_aliases(self):
        for subs in ([True], [0], [-1], ['1'], [1.0], [{}], [1, 1], [2**63]):
            with self.subTest(subs=subs), self.assertRaises(h.orders.TalabatError):
                basket.parse_items([{'item_id': ITEM, 'choices': [
                    {'choice_id': SIZE, 'sub_choice_ids': subs}]}], vertical='restaurants')

    def test_membership_required_optional_and_bounds(self):
        self.assertEqual(mc.validate_line_choices(catalog(), self.choices), self.choices)
        self.assertEqual(mc.validate_line_choices(catalog(), ((SIZE, 1, (SUGAR,)),)), ((SIZE, 1, (SUGAR,)),))
        for selected, error in (((), 'SECTION_BOUNDS'), ((JELLY,), 'SECTION_BOUNDS'),
                                ((SUGAR, OTHER_SUGAR), 'SECTION_BOUNDS'), ((123,), 'UNKNOWN_FOR_PARENT')):
            with self.subTest(selected=selected), self.assertRaisesRegex(h.orders.TalabatError, error):
                mc.validate_line_choices(catalog(), ((SIZE, 1, selected),))
        with self.assertRaisesRegex(h.orders.TalabatError, 'SECTION_BOUNDS'):
            mc.validate_line_choices(catalog(), ())
        with self.assertRaisesRegex(h.orders.TalabatError, 'QUANTITY_UNPROVEN'):
            mc.validate_line_choices(catalog(), ((SIZE, 2, (SUGAR,)),))

    def test_deeper_descendants_fail_closed(self):
        root = catalog().sections[0]
        size = root.options[0]
        sugar = size.sub_categories[0]
        child = replace(sugar.options[0], sub_categories=(mc.ChoiceSection(999, SUGAR, 'More', 0, 1, ()),))
        nested = replace(catalog(), sections=(replace(root, options=(replace(size,
            sub_categories=(replace(sugar, options=(child,)),)),)),))
        with self.assertRaisesRegex(h.orders.TalabatError, 'DEPTH_UNSUPPORTED'):
            mc.validate_line_choices(nested, ((SIZE, 1, (SUGAR,)),))

    def test_catalog_children_cannot_move_between_selected_parents(self):
        root = catalog().sections[0]
        size = root.options[0]
        second = replace(size, option_id=77, sub_categories=(
            mc.ChoiceSection(78, 77, 'Other children', 0, 1, (
                mc.ChoiceOption(79, 78, 'Other child', 0, 0, False),)),))
        choices = replace(catalog(), sections=(replace(root, max_select=2, options=(size, second)),))
        with self.assertRaisesRegex(h.orders.TalabatError, 'UNKNOWN_FOR_PARENT'):
            mc.validate_line_choices(choices, ((SIZE, 1, (SUGAR, 79)), (77, 1, ())))
        row = native_row()
        moved = row['choicesDetails'][0]['subChoicesDetails'].pop()
        row['choicesDetails'].append({'id':77,'quantity':1,'subChoicesDetails':[moved]})
        row['choices'].append(77)
        self.assertFalse(rc.choices_echo_matches(row, self.choices+((77,1,()),)))

    def test_checkout_validates_required_choices_even_when_manifest_omits_them(self):
        checkout = object.__new__(h.Checkout)
        checkout.home = context('restaurants')[0]
        checkout._choice_catalog = checkout._item_prices = None
        menu = {'vendor': {'result': {'restaurant': {'bid':745022}}},
                'menu': {'result': {'menu': {'menuSection': [{'nm':'Drinks','itm': [
                    {'id':ITEM,'nm':'Brown Sugar Boba With Milk','pr':0,'opr':0,'icc':True}]}]}}}}
        checkout._read = Mock(return_value=menu)
        from unittest.mock import patch
        with patch.object(mc, 'fetch_item_choices', return_value=catalog()):
            with self.assertRaisesRegex(h.orders.TalabatError, 'SECTION_BOUNDS'):
                checkout.verify_restaurant_items(745022, (h.Item(ITEM,1),))

    def test_native_echo_matches_both_representations(self):
        self.assertTrue(rc.choices_echo_matches(native_row(), self.choices, self.catalog))
        for change in ('flat_missing', 'flat_extra', 'child_missing', 'child_extra', 'child_qty',
                       'child_name', 'parent_section', 'deeper', 'duplicate', 'null', 'wrong_parent'):
            row = native_row()
            detail = row['choicesDetails'][0]
            children = detail['subChoicesDetails']
            if change == 'flat_missing': row['choices'].remove(SUGAR)
            elif change == 'flat_extra': row['choices'].append(99)
            elif change == 'child_missing': children.pop()
            elif change == 'child_extra': children.append({'id': 99, 'quantity': 1})
            elif change == 'child_qty': children[0]['quantity'] = 2
            elif change == 'child_name': children[0]['localeNames'][0]['value'] = '100% Sugar'
            elif change == 'parent_section': detail['itemChoiceSectionId'] = 12
            elif change == 'deeper': children[0]['subChoicesDetails'] = [{'id': 99}]
            elif change == 'duplicate': children.append(copy.deepcopy(children[0]))
            elif change == 'null': detail['subChoicesDetails'] = None
            elif change == 'wrong_parent':
                row['choicesDetails'].append({'id': 88, 'quantity': 1, 'subChoicesDetails': children[:]})
                row['choices'].append(88)
                detail['subChoicesDetails'] = []
            with self.subTest(change=change):
                try:
                    matches = rc.choices_echo_matches(row, self.choices, self.catalog)
                except h.orders.TalabatError:
                    matches = False
                self.assertFalse(matches)

    def test_distinct_sugars_never_merge_and_fresh_readback_is_exact(self):
        second = h.Item(ITEM, 1, choices=((SIZE, 1, (OTHER_SUGAR,)),))
        items = (self.item, second, replace(self.item, choices=((SIZE, 1, (SUGAR, JELLY)),)))
        merged = h._items(self.store, items)
        self.assertEqual(len(merged), 2)
        self.assertEqual(merged[0].quantity, 2)
        first_row = native_row(); first_row['quantity'] = 2
        second_row = native_row(); second_row.update(id=102, choices=[SIZE, OTHER_SUGAR], choicesString='Cold 700 Ml, 25% Sugar')
        second_row['choicesDetails'][0]['subChoicesDetails'] = [
            {'id': OTHER_SUGAR, 'quantity': 1, 'localeNames': [{'locale':'en','value':'25% Sugar'}]}]
        raw = {'branchInfo': {'restaurant': {'branchId':745022}},
               'cart': {'id':100, 'items':[first_row,second_row], 'totalValue':87}}
        owned = rc.project_cart(raw,cart_id='100',branch_id=745022,items=items,choice_catalog=self.catalog)
        self.assertEqual(len(owned.lines), 2)
        self.assertEqual(rc.read_owned_cart(Mock(return_value=raw),owned,choice_catalog=self.catalog),owned)
        bad = copy.deepcopy(raw)
        bad['cart']['items'][1]['choicesDetails'][0]['subChoicesDetails'][0]['id'] = SUGAR
        bad['cart']['items'][1]['choices'] = [SIZE,SUGAR]
        with self.assertRaises(h.orders.TalabatError):
            rc.read_owned_cart(Mock(return_value=bad),owned,choice_catalog=self.catalog)
        cart = h.parse_cart(raw,self.store,items,choice_catalog=self.catalog,item_prices={ITEM:0})
        self.assertEqual(cart.line_undiscounted,(6000,2700))

    def test_paid_child_cost_unknown_is_not_guessed(self):
        self.assertEqual(h._line_undiscounted(self.store,(replace(self.item,quantity=2),),self.catalog,{ITEM:0}), (6000,))
        self.catalog[SIZE]['sub_choices'][JELLY]['original_price_minor'] = None
        self.assertEqual(h._line_undiscounted(self.store,(self.item,),self.catalog,{ITEM:0}), ())

    def test_nested_initial_and_quiet_quotes_review_exact_children_and_label(self):
        from test.test_talabat_paid_choices import paid_size
        home, config, card, cart, data = paid_size(quantity=2, base=0, choice_price=30)
        label = native_row()['choicesString']
        items = (replace(cart.items[0], choices=self.choices),)
        cart = replace(cart,items=items,line_choice_labels=(label,))
        data['checkout']['cart']['items'][0]['choicesString'] = label
        for selected in (False,True):
            selection = h.select_payment(config,card) if selected else None
            body = h.prepare_body(cart.store,home,selection=selection,
                features=None if selected else {'paySupportsTPro':False},
                instructions=data['checkout']['deliveryInstructions'] if selected else None)
            quote = h.parse_quote(data,cart,home,body,selection)
            review = h.project_quote(quote)['item_choices'][0]
            self.assertEqual(review['choices'][0]['sub_choice_ids'],[JELLY,SUGAR])
            self.assertEqual(review['choices_label'],label)
            bad = copy.deepcopy(data)
            bad['checkout']['cart']['items'][0]['choicesString'] = 'Cold 700 Ml, 25% Sugar'
            with self.assertRaises(h.orders.TalabatError):
                h.parse_quote(bad,cart,home,body,selection)


if __name__ == '__main__':
    unittest.main()
