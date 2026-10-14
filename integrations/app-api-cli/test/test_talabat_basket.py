"""talabat_basket.parse_items: CLI JSON rows -> exact normalized Item lines."""
import unittest

import talabat_http_checkout as h
import talabat_http_orders as orders
from talabat_basket import parse_items

UUID = '9bc5c169-1d79-4d94-821f-e18542669426'


class BasketShapeTests(unittest.TestCase):
    def test_list_and_wrapper_shapes_with_alias_keys(self):
        rows = [{'item_id': 157740044, 'quantity': 2, 'note': 'No onions',
                 'choices': [{'choiceId': 549025015, 'quantity': 1, 'subChoiceIds': []}]},
                {'id': '12346', 'qty': 1, 'specialRequest': ''}]
        for data in (rows, {'items': rows}, tuple(rows)):
            items = parse_items(data, vertical='restaurants')
            self.assertEqual(items, (
                h.Item(157740044, 2, 'No onions', ((549025015, 1, ()),)),
                h.Item(12346, 1, '', ())))
        self.assertEqual(parse_items([{'item_id': UUID.upper(), 'quantity': 1}],
                                     vertical='mart'), (h.Item(UUID, 1),))

    def test_invalid_shapes_and_unknown_keys_refused(self):
        for data in (None, 'x', 7, {}, {'items': []}, [], {'items': 'x'}, {'items': None, 'extra': 1}):
            with self.subTest(data=data), self.assertRaisesRegex(orders.TalabatError, 'BASKET_'):
                parse_items(data, vertical='restaurants')
        for row in ({'item_id': 12345, 'wishlist': True},
                    {'item_id': 12345, 'quantity': 1, 'note': 'x', 'nonsense': 1}):
            with self.subTest(row=row), self.assertRaisesRegex(orders.TalabatError, 'BASKET_ROW_INVALID'):
                parse_items([row], vertical='restaurants')

    def test_restaurant_ids_and_quantities_normalized_or_refused(self):
        self.assertEqual(parse_items([{'item_id': '157740044', 'quantity': 1}],
                                     vertical='restaurants'), (h.Item(157740044, 1),))
        for row in ({'item_id': 0}, {'item_id': -3}, {'item_id': True}, {'item_id': 12.5},
                    {'item_id': 'abc'}, {'item_id': None}, {'item_id': '12 3'},
                    {'item_id': '007'}, {'item_id': 12345, 'quantity': 0},
                    {'item_id': 12345, 'quantity': True},
                    {'item_id': 12345, 'quantity': 'x'}, {'item_id': 12345, 'quantity': None},
                    {'item_id': 12345, 'quantity': 1.5}, {'item_id': 12345, 'note': None}):
            with self.subTest(row=row), self.assertRaises(orders.TalabatError):
                parse_items([row], vertical='restaurants')

    def test_grocery_requires_exact_uuid(self):
        self.assertEqual(parse_items([{'item_id': UUID}], vertical='shops'),
                         (h.Item(UUID, 1),))
        for bad in (157740044, '12345', UUID[:-1], UUID + '0', UUID.upper() + '-X'):
            with self.subTest(bad=bad), self.assertRaisesRegex(orders.TalabatError, 'BASKET_ITEM_ID_INVALID'):
                parse_items([{'item_id': bad}], vertical='mart')

    def test_notes_exact_unicode_no_length_cap_and_restaurants_only(self):
        long_note = 'please 😀 ' * 500
        self.assertEqual(parse_items([{'item_id': 1, 'note': long_note}], vertical='restaurants'),
                         (h.Item(1, 1, long_note),))
        for note in (None, 7, True, ['x'], 'bad\x00note', 'bad\x1fnote'):
            with self.subTest(note=note), self.assertRaises(orders.TalabatError):
                parse_items([{'item_id': 1, 'note': note}], vertical='restaurants')
        for vertical in ('mart', 'shops'):
            with self.assertRaisesRegex(orders.TalabatError, 'ITEM_NOTES_RESTAURANTS_ONLY'):
                parse_items([{'item_id': UUID, 'note': 'x'}], vertical=vertical)

    def test_choices_restaurants_only_normalized_and_validated(self):
        self.assertEqual(
            parse_items([{'item_id': 1, 'choices': [{'choice_id': '549025015'},
                                                    {'id': 42, 'quantity': 3, 'sub_choice_ids': []}]}],
                       vertical='restaurants'),
            (h.Item(1, 1, '', ((549025015, 1, ()), (42, 3, ()))),))
        for row in ({'item_id': 1, 'choices': []}, {'item_id': 1, 'choices': None}):
            self.assertEqual(parse_items([row], vertical='restaurants'), (h.Item(1, 1),))
        for choices in (549025015, [{'choice_id': 549025015, 'oops': 1}], ['549025015'],
                        [{'choice_id': 'x'}], [{'choice_id': 0}], [{'choice_id': 549025015, 'quantity': 0}],
                        [{'choice_id': 549025015, 'sub_choice_ids': [True]}],
                        [{'choice_id': 549025015}, {'choiceId': 549025015}]):
            with self.subTest(choices=choices), self.assertRaises(orders.TalabatError):
                parse_items([{'item_id': 1, 'choices': choices}], vertical='restaurants')
        for vertical in ('mart', 'shops'):
            with self.assertRaisesRegex(orders.TalabatError, 'CHOICES_GROCERY_UNSUPPORTED'):
                parse_items([{'item_id': UUID, 'choices': [{'choice_id': 1}]}], vertical=vertical)

    def test_duplicate_lines_preserved_until_wire_merging(self):
        # Distinct note/choices stay distinct rows for the caller (per-line
        # identity); identical rows are merged later at the wire layer only.
        items = parse_items([
            {'item_id': 1, 'quantity': 1, 'note': 'No onions'},
            {'item_id': 1, 'quantity': 1, 'note': 'Extra spicy',
             'choices': [{'choice_id': 549025015}]},
            {'item_id': 1, 'quantity': 1}], vertical='restaurants')
        self.assertEqual(len(items), 3)
        store = h.Store('restaurants', 44444, 0, False)
        # The plain third row has distinct (empty) note/choices identity.
        self.assertEqual(h._items(store, items), items)

    def test_aliases_never_silently_override_requested_data(self):
        for row in (
                {'item_id': 1, 'id': 2},
                {'item_id': 1, 'quantity': 1, 'qty': 2},
                {'item_id': 1, 'note': 'No onions', 'specialRequest': 'Extra spicy'},
                {'item_id': 1, 'choices': [{'choice_id': 5, 'choiceId': 6}]},
                {'item_id': 1, 'choices': [{'choice_id': 5, 'quantity': 1, 'qty': 2}]},
                {'item_id': 1, 'choices': [{'choice_id': 5, 'sub_choice_ids': [], 'subChoiceIds': [7]}]}):
            with self.subTest(row=row), self.assertRaisesRegex(orders.TalabatError, 'BASKET_ALIAS_AMBIGUOUS'):
                parse_items([row], vertical='restaurants')

    def test_malformed_subchoices_and_null_choice_quantity_not_dropped(self):
        for subs in (None, 7, '7', {'id': 7}, True):
            with self.subTest(subs=subs), self.assertRaisesRegex(orders.TalabatError, 'FOOD_ITEM_CHOICES_INVALID'):
                parse_items([{'item_id': 1, 'choices': [{'choice_id': 5, 'sub_choice_ids': subs}]}],
                            vertical='restaurants')
        with self.assertRaisesRegex(orders.TalabatError, 'FOOD_ITEM_CHOICES_INVALID'):
            parse_items([{'item_id': 1, 'choices': [{'choice_id': 5, 'quantity': None}]}],
                        vertical='restaurants')


if __name__ == '__main__':
    unittest.main()
