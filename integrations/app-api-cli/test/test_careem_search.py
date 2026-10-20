import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from careem_search import Catalog, SearchError, menu, price, products, restaurants
from unittest.mock import patch


class CareemSearchTests(unittest.TestCase):
    def test_restaurant_rich_card_variant(self):
        card = {'id': '42-', 'trailing_content': {'title': 'Cafe', 'eta': '20 - 30 mins'},
                'event_configuration': {'entity': {'attributes': {'merchant_id': 42, 'merchant_name': 'Cafe'}}}}
        self.assertEqual(restaurants({'body': [card]})[0]['id'], '42')

    def test_capture_missing_fails_closed(self):
        with patch('careem_search.load', return_value=None):
            with self.assertRaisesRegex(SearchError, 'NATIVE_CAPTURE_REQUIRED'):
                Catalog().fetch('food', 'sushi')

    def test_price_markup_and_missing_fee(self):
        self.assertEqual(price("<'style'='labelSmall'>⃎ 5.50</>"), 5.5)
        self.assertIsNone(price(None))

    def test_duplicate_item_telemetry_not_duplicate_results(self):
        item = {'event_configuration': {'entity': {'attributes': {
            'item_id': 123, 'item_name': 'Milk', 'item_price': 7.5, 'item_availability': False}}}}
        result = products({'body': [item, item]})
        self.assertEqual(len(result), 1)
        self.assertFalse(result[0]['available'])

    def test_menu_keeps_description_and_actual_discount(self):
        items, restaurant = menu({'body': {'items': [
            {'id': '1', 'header': {'text': 'Coffee'}, 'description': {'text': '250 ml'},
             'price': {'text': '⃎ 10'}, 'original_price': {'text': '⃎ 20'}}]}})
        self.assertEqual(items[0]['description'], '250 ml')
        self.assertEqual(items[0]['price'], 10)
        self.assertEqual(items[0]['original_price'], 20)
        self.assertIsNone(restaurant['delivery_fee'])


if __name__ == '__main__':
    unittest.main()
