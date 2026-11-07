import unittest
from unittest.mock import patch
import native


class FoodChoicesTests(unittest.TestCase):
    def menu(self):
        return {'data': {'outletCode': 'OUTLET', 'menu': {
            'items': [{'itemCode': 'MAIN', 'itemType': 'main', 'name': 'Coffee',
                       'price': 12, 'noteType': 'optional', 'modifiers': ['MILK']},
                      {'itemCode': 'OAT', 'itemType': 'modifier', 'name': 'Oat milk',
                       'price': 3, 'isOos': True, 'modifiers': []}],
            'modifiers': [{'modifierCode': 'MILK', 'name': 'Milk', 'minTotalOptions': 1,
                           'maxTotalOptions': 1, 'maxSingleOption': 1,
                           'options': [{'itemCode': 'OAT', 'price': 3, 'defaultValue': 0}]}]}}}

    def test_required_choices_and_notes(self):
        with patch.object(native, 'call', return_value=self.menu()):
            _, items = native.food_menu_raw('OUTLET', {}, 10)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['note_type'], 'optional')
        group = items[0]['choice_groups'][0]
        self.assertEqual((group['min'], group['max']), (1, 1))
        self.assertEqual(group['options'][0]['price'], 3)
        self.assertFalse(group['options'][0]['available'])

    def test_missing_and_recursive_choices_fail_closed(self):
        for mode in ('missing', 'recursive'):
            menu = self.menu()
            if mode == 'missing':
                menu['data']['menu']['items'].pop()
            else:
                menu['data']['menu']['items'][1]['modifiers'] = ['MILK']
            with patch.object(native, 'call', return_value=menu), self.assertRaises(native.NativeError):
                native.food_menu_raw('OUTLET', {}, 10)


if __name__ == '__main__':
    unittest.main()
