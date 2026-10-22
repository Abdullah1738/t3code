import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import talabat_http_orders as http
import talabat_order_items as items


def tracking(order='3969819746', lines=None, referenced=True):
    lines = lines if lines is not None else [
        {'template_id': 'order_item', 'properties': {'choices': 'No Jalapenos', 'has_special_request': False,
         'name': 'Spicy Chicken Ranch Pizza\U0001f336\ufe0f', 'quantity': 1, 'special_request': None}},
        {'template_id': 'order_item', 'properties': {'choices': 'Hot Honey Sauce (Cal:97 P:1g F:2g C:18g)',
         'has_special_request': True, 'name': 'Crispy Chicken Strips', 'quantity': 2,
         'special_request': 'Extra crispy'}}]
    return {'type': 'OrderTrackingScreen',
            'common_tracking_event_attributes': {'order_id': order, 'delivery_status': 'order_delivered'},
            'layouts': [{'name': 'body', 'column': ['tlb_app_bff_passthrough'] if referenced else []}],
            'widgets': {'tlb_app_bff_passthrough': {'type': 'FluidComponent', 'data': {'component': {
                'properties': {'children': [
                    {'template_id': 'order_details', 'properties': {
                        'shop_id': '34467', 'chain_id': '17138', 'vendor_name': 'Under500',
                        'has_special_requests': True, 'special_requests_descriptor': 'No cutlery.',
                        'items': lines}}]}}}}}}


MENU = {'vendor': {'result': {'restaurant': {'bid': 34467}}}, 'menu': {'result': {'menu': {'menuSection': [
    {'nm': 'Healthy Pizzas', 'itm': [
        {'id': 2967884793, 'nm': 'Spicy Chicken Ranch Pizza\U0001f336\ufe0f', 'icc': True, 'pr': 44,
         'dsc': 'Cal: 495 P: 30 F: 19 C: 56 - Spicy chicken topped with jalapenos.'}]},
    {'nm': 'Mains', 'itm': [
        {'id': 3178472353, 'nm': 'Crispy Chicken Strips', 'icc': True, 'pr': 39,
         'dsc': 'Cal: 256 P: 42 F: 2 C: 14 - Oven baked tenders.'}]},
    {'nm': 'Order again', 'itm': [
        {'id': 2967884795, 'nm': 'Crispy Chicken Strips', 'icc': True, 'pr': 39,
         'dsc': 'Cal: 256 P: 42 F: 2 C: 14 - Oven baked tenders.'}]}]}}}}

CHOICES = {
    2967884793: [{'name': 'Remove Ingredients?', 'options': [
        {'option_id': 1, 'name': 'No Chives', 'price_minor': 0, 'sub_categories': ()},
        {'option_id': 2, 'name': 'No Jalapenos', 'price_minor': 0, 'sub_categories': ()}]}],
    3178472353: [{'name': 'Choose your Sauce', 'options': [
        {'option_id': 3, 'name': 'Dynamite Sauce  (Cal:72 P:0g F:4g C:8g)', 'price_minor': 0, 'sub_categories': ()},
        {'option_id': 4, 'name': 'Hot Honey Sauce (Cal:97 P:1g F:2g C:18g)', 'price_minor': 0, 'sub_categories': ()}]}],
}


class FakeMenu:
    def __init__(self, raw=MENU, fail=None):
        self.raw, self.fail, self.choice_calls = raw, fail, []

    def items(self, branch):
        if self.fail:
            raise http.TalabatError(self.fail)
        return items.menu_items(self.raw), None

    def choices(self, branch, item_id):
        self.choice_calls.append(item_id)
        return CHOICES[item_id]


class ParseMacrosTest(unittest.TestCase):
    def test_published_formats(self):
        cases = {
            'Cal: 495 P: 30 F: 19 C: 56 - Spicy': (495, 30, 56, 19),
            'Hot Honey Sauce (Cal:97 P:1g F:2g C:18g)': (97, 1, 18, 2),
            '[556 cal \u2013 P 48g, C 14g, F 35g] Romaine': (556, 48, 14, 35),
            'Cal:72.4 P:0.3g F:4.2g C:8.3g': (72.4, 0.3, 8.3, 4.2),
            'Super Bird Omelette (442 kcal, 54P/16C/18F)': (442, 54, 16, 18),
            'Transfat 0g | Healthy Fats 34g | Protein 53g | Carbs 110g': (None, 53, 110, 34),
        }
        for text, want in cases.items():
            got = items.parse_macros(text)
            self.assertEqual(tuple(got[k] for k in items.FIELDS), want, text)

    def test_non_macro_numbers_ignored(self):
        for text in ['Chicken High Protein 2x*', 'Extra Turkey Ham - 30g', '70 Grams.', 'Cold 700 Ml',
                     '12 Pcs', 'Fresh tomato salsa', None, '']:
            self.assertIsNone(items.parse_macros(text), text)

    def test_first_value_wins_for_side_breakdowns(self):
        got = items.parse_macros('Cal:570 P:50g F:24g C:39g burger. Potato wedges: Cal:143 P:2g F:5g C:22g')
        self.assertEqual(got, {'kcal': 570, 'protein_g': 50, 'carbs_g': 39, 'fat_g': 24})


class OrderLinesTest(unittest.TestCase):
    def test_projects_lines_notes_and_branch(self):
        info = items.order_lines(tracking(), '3969819746')
        self.assertEqual(info['branch_id'], 34467)
        self.assertEqual(info['order_note'], 'No cutlery.')
        self.assertEqual([l['quantity'] for l in info['lines']], [1, 2])
        self.assertEqual(info['lines'][1]['note'], 'Extra crispy')
        self.assertIsNone(info['lines'][0]['note'])

    def test_tracking_items_carry_choices_but_never_notes(self):
        with patch.object(http, 'visible_details', return_value={'status_text': None, 'status_text_source': None}), \
                patch('talabat_delivery_address.project', return_value={}):
            result = http.project(tracking(), '3969819746')
        self.assertEqual(result['items'], [
            {'name': 'Spicy Chicken Ranch Pizza\U0001f336\ufe0f', 'quantity': 1, 'choices': 'No Jalapenos'},
            {'name': 'Crispy Chicken Strips', 'quantity': 2, 'choices': 'Hot Honey Sauce (Cal:97 P:1g F:2g C:18g)'}])
        self.assertNotIn('Extra crispy', str(result['items']))

    def test_unreferenced_widget_fails_closed(self):
        with self.assertRaisesRegex(http.TalabatError, 'ORDER_DETAILS_UNAVAILABLE'):
            items.order_lines(tracking(referenced=False), '1')

    def test_bad_quantity_is_schema_change(self):
        bad = [{'template_id': 'order_item', 'properties': {'name': 'X', 'quantity': 0}}]
        with self.assertRaisesRegex(http.TalabatError, 'SCHEMA'):
            items.order_lines(tracking(lines=bad), '1')


class ResolveTest(unittest.TestCase):
    def test_under500_matches_screenshot_macros(self):
        info = items.order_lines(tracking(), '3969819746')
        menu = FakeMenu()
        lines, total, missing, error = items.resolve(info, menu)
        self.assertIsNone(error)
        pizza, strips = lines
        self.assertEqual(pizza['menu_item_id'], 2967884793)
        self.assertEqual(pizza['macros'], {'kcal': 495, 'protein_g': 30, 'carbs_g': 56, 'fat_g': 19})
        self.assertEqual(pizza['choices'][0]['option_id'], 2)
        self.assertIsNone(pizza['choices'][0]['macros'])
        # Cross-listed duplicate rows with identical text are one item, not ambiguous.
        self.assertTrue(strips['resolved'])
        self.assertEqual(strips['choices'][0]['macros'], {'kcal': 97, 'protein_g': 1, 'carbs_g': 18, 'fat_g': 2})
        # strips x2 with sauce x2
        self.assertEqual(total, {'kcal': 495 + 2 * 256 + 2 * 97, 'protein_g': 30 + 84 + 2,
                                 'carbs_g': 56 + 28 + 36, 'fat_g': 19 + 4 + 4})
        self.assertEqual(missing, [])
        self.assertEqual(sorted(menu.choice_calls), [2967884793, 3178472353])

    def test_choice_labels_containing_commas_rejoin(self):
        options = [{'option_id': 9, 'name': 'Rice, Light', 'section': 's', 'price_minor': 0, 'path': ()},
                   {'option_id': 8, 'name': 'Cheese', 'section': 's', 'price_minor': 0, 'path': ()}]
        out = items.resolve_choices('Rice, Light, Cheese', options)
        self.assertEqual([c['option_id'] for c in out], [9, 8])

    def test_product_prefixed_option_label(self):
        options = [{'option_id': 7, 'name': 'Large', 'section': 'Size', 'price_minor': 200, 'path': ()}]
        out = items.resolve_choices('Iced Latte Large', options)
        self.assertEqual(out[0]['option_id'], 7)

    def test_unknown_item_and_menu_outage_are_explicit(self):
        lines = [{'template_id': 'order_item', 'properties': {'name': 'Gone Dish', 'quantity': 1}},
                 {'template_id': 'order_item', 'properties': {'name': '', 'quantity': 2}}]
        info = items.order_lines(tracking(lines=lines), '1')
        out, total, missing, error = items.resolve(info, FakeMenu())
        self.assertEqual([l['match'] for l in out], ['not_on_current_menu', 'unnamed_order_line'])
        self.assertIn('Gone Dish:unresolved', missing)
        self.assertEqual(total, {k: None for k in items.FIELDS})
        out, _, _, error = items.resolve(items.order_lines(tracking(), '1'), FakeMenu(fail='RATE_LIMITED'))
        self.assertEqual(error, 'RATE_LIMITED')
        self.assertFalse(any(l['resolved'] for l in out))

    def test_conflicting_same_name_is_ambiguous(self):
        raw = {'menu': {'result': {'menu': {'menuSection': [{'nm': 'a', 'itm': [
            {'id': 1, 'nm': 'Bowl', 'dsc': 'Cal: 400'}, {'id': 2, 'nm': 'Bowl', 'dsc': 'Cal: 600'}]}]}}}}
        item, how, cands = items.match_item('Bowl', items.menu_items(raw))
        self.assertIsNone(item)
        self.assertEqual(how, 'ambiguous_name')
        self.assertEqual(len(cands), 2)


class EntryTest(unittest.TestCase):
    def test_read_only_endpoints_and_order_validation(self):
        with self.assertRaisesRegex(http.TalabatError, 'INVALID_ORDER_ID'):
            items.order_items('abc')
        with self.assertRaisesRegex(http.TalabatError, 'INVALID_TIMEOUT'):
            items.order_items('1', timeout=500)

    def test_end_to_end_with_stubbed_reads(self):
        def fake_renewal(operation, deadline):
            with patch.object(http, 'request', return_value=tracking()):
                return operation({}, deadline)
        with patch.object(http, 'read_with_renewal', side_effect=fake_renewal), \
             patch.object(items, 'Menu', return_value=FakeMenu()):
            result = items.order_items('3969819746', timeout=20)
        self.assertTrue(result['ok'])
        self.assertFalse(result['cart_mutation'])
        self.assertFalse(result['financial_send'])
        self.assertTrue(result['totals']['complete'])
        text = items.summary(result)
        self.assertIn('Cal 495 P30g C56g F19g', text)
        self.assertIn('+ Hot Honey Sauce', text)

    def test_choices_endpoint_allowlisted_get_only(self):
        import talabat_native as native
        url = 'https://api.talabat.com/menubff/v3/branches/34467/menu/3178472353/choices?countryId=4'
        self.assertTrue(native.allowed('GET', url))
        self.assertFalse(native.allowed('POST', url))
        self.assertFalse(native.allowed('GET', 'https://api.talabat.com/menubff/v3/branches/1/menu/2/cart'))


if __name__ == '__main__':
    unittest.main()
