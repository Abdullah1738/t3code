import sys
import unittest
from unittest.mock import patch
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nownow_native import status_fields, parse_results, search, TEMPLATE, HOST, PATH
from native import NativeError


class NowNowStatusTests(unittest.TestCase):
    def test_open_with_optional_scheduling(self):
        s = status_fields({'operationality': {'isOperational': True, 'operationalStatusCode': 'always_open'},
                           'schedulingInfo': {'title': 'Delivery in 45 - 60 mins', 'slots': {'today': ['08:00']}}})
        self.assertEqual(s['status'], 'open')
        self.assertFalse(s['scheduled_only'])

    def test_closed_scheduled_and_opening_time(self):
        s = status_fields({'operationality': {'isOperational': False, 'operationalStatusCode': 'closed',
            'operationalMsg': 'Opens Today at 08:00 AM', 'schedule': {'activatesAt': '2026-10-03T08:00:00'}},
            'schedulingInfo': {'title': 'Schedule your order', 'slots': {'today': ['08:00']}}})
        self.assertEqual(s['status'], 'closed')
        self.assertTrue(s['scheduled_only'])
        self.assertEqual(s['opens_at'], '2026-10-03T08:00:00')

    def test_fail_closed_for_missing_or_conflicting_status(self):
        for store in [{}, {'estimatedDeliveryTime': 30},
                      {'operationality': {'isOperational': True, 'operationalStatusCode': 'closed'}},
                      {'operationality': {'isOperational': 'true', 'operationalStatusCode': 'open'}}]:
            self.assertNotEqual(status_fields(store)['status'], 'open')

    def test_open_filter_does_not_trust_eta_or_add_buttons(self):
        rows = []
        for code, op in [('a', {'isOperational': True, 'operationalStatusCode': 'always_open'}),
                         ('b', {'isOperational': False, 'operationalStatusCode': 'closed'}), ('c', {})]:
            rows.append({'storeDetails': {'storeCode': code, 'name': code, 'estimatedDeliveryTime': 30, 'operationality': op},
                         'products': [{'productCode': 'p', 'name': 'Milk', 'discountedPrice': 5, 'isOos': False}]})
        self.assertEqual([s['store_id'] for s in parse_results({'results': rows}, 'milk', True)], ['a'])

    def test_unknown_and_unrelated_products(self):
        d = {'results': [{'storeDetails': {'storeCode': 's'}, 'products': [
            {'productCode': 'p', 'name': 'Eggs', 'price': 5}]}]}
        self.assertEqual(parse_results(d, 'milk', False), [])

    def test_home_failure_prevents_catalog_request(self):
        template = {'templates': {TEMPLATE: {'url': 'https://'+HOST+PATH, 'method': 'GET', 'headers': {}}}}
        with patch('nownow_native.load', return_value=template), \
             patch('nownow_native.verify_home', side_effect=NativeError('HOME_MISMATCH', 'wrong home')), \
             patch('nownow_native.get') as get:
            with self.assertRaises(NativeError): search('milk', open_only=True)
            get.assert_not_called()

    def test_out_of_stock_is_not_buyable_and_no_tracking_leaks(self):
        data = {'results': [{'storeDetails': {'storeCode': 's', 'analytics': {'token': 'secret'}},
                            'products': [{'productCode': 'p', 'name': 'Milk', 'price': 5,
                                          'isOos': True, 'trackingToken': 'secret'}]}]}
        result = parse_results(data, 'milk')
        self.assertFalse(result[0]['items'][0]['buyable'])
        self.assertNotIn('secret', str(result))


if __name__ == '__main__': unittest.main()
