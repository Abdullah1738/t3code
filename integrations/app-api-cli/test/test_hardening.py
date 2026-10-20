"""Regressions for the 2026-10-03 hardening pass (no network)."""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import common as c
import talabat_native as t
from native import NativeError
import careem_search as cs
import native


def vendor(i, name, status=0, chain=None, branch=None, cuisine='Sushi'):
    return {'vendor_id': i, 'vendor_name': name, 'vendor_status': status, 'chain_id': chain or i,
            'branch_name': branch or f'{name}, Dubai Marina', 'cuisines': [{'na': cuisine}],
            'time_estimation': '20 - 35 mins', 'delivery_charges': 0, 'rating': 4.5}


class CommonTests(unittest.TestCase):
    def test_float_noise_and_name_tags(self):
        self.assertEqual(c.money(29.990000000000002), 29.99)
        self.assertEqual(c.clean_name('Fusion Mixed Seaweed Salad (ANS)'), 'Fusion Mixed Seaweed Salad')
        self.assertEqual(c.clean_name('<b>Sake</b> Maki 8 Pcs (ANS)'), 'Sake Maki 8 Pcs')

    def test_item_match_is_name_based_not_description(self):
        self.assertEqual(c.item_matches('seaweed salad', 'Wakame Seaweed Salad'), 'name')
        self.assertEqual(c.item_matches('seaweed salad', 'Chuka Wakame'), 'name')
        self.assertIsNone(c.item_matches('seaweed salad', 'Tuna Poke'))  # description mentions seaweed salad
        self.assertEqual(c.item_matches('sushi', 'California Roll 8 pcs'), 'name')
        self.assertIsNone(c.item_matches('sushi', 'Sushi Rice'))
        self.assertIsNone(c.item_matches('sushi', 'Super Salmon Pokerrito'))

    def test_area_from_branch(self):
        self.assertEqual(c.area_from_branch('Sushi Buzz, JLT, Jumeirah Lakes Towers - JLT'), 'Jumeirah Lakes Towers - JLT')
        self.assertIsNone(c.area_from_branch('Deli Sushi', 'Deli Sushi'))

    def test_category_and_punctuation_are_not_item_name_matches(self):
        self.assertIsNone(c.item_matches('seaweed salad', 'Coleslaw', 'Seaweed salads'))
        self.assertIsNone(c.item_matches('!!!', 'Anything'))


class TalabatTests(unittest.TestCase):
    def tb(self):
        return t.Talabat(saved={'templates': {'x': {'url': 'https://api.talabat.com/search/api/v3/vendor',
                                                     'method': 'POST', 'headers': {}, 'body': '{}'}}})

    def test_empty_native_page_retries_then_web_fallback_is_announced(self):
        tb = self.tb()
        empty = {'result': {'vendors': [], 'metadata': {'counts': {'total': 0}, 'pagination': {}}}}
        web = {'vendors': [vendor(1, 'Sushi Hub')], 'metadata': {'counts': {'total': 1}, 'pagination': {}}}
        with patch.object(t, 'request', return_value=empty) as req, patch.object(t.time, 'sleep'), \
             patch.object(t.Talabat, 'web_page', return_value=web):
            rows, total, source = tb.search_vendors('sushi')
        self.assertEqual(req.call_count, 4)
        self.assertEqual(source, 'web_search')
        self.assertEqual(rows[0]['name'], 'Sushi Hub')
        self.assertTrue(any('web_search' in f['reason'] for f in tb.fallbacks))

    def test_all_tiers_failing_is_an_error_not_silent_empty(self):
        tb = self.tb()
        empty = {'result': {'vendors': [], 'metadata': {'counts': {'total': 0}, 'pagination': {}}}}
        with patch.object(t, 'request', return_value=empty), patch.object(t.time, 'sleep'), \
             patch.object(t.Talabat, 'web_page', side_effect=NativeError('WEB_HTTP_429', 'x')), \
             patch.object(t.Talabat, 'dia_page', side_effect=NativeError('DIA_FAILED', 'x')):
            with self.assertRaises(NativeError) as e:
                tb.search_vendors('sushi')
        self.assertEqual(e.exception.code, 'SEARCH_UNAVAILABLE')

    def test_open_filter_uses_live_status_and_dedupes_chain(self):
        tb = self.tb()
        rows = [t.vendor_row(v, 'web_search') for v in [
            vendor(1, 'Sushi Buzz', 0, chain=9, branch='Sushi Buzz, JLT'),   # web says open
            vendor(2, 'Sushi Buzz', 0, chain=9, branch='Sushi Buzz, Marina'),
            vendor(3, 'Pizza Place', 0, cuisine='Pizza')]]
        live = {1: {'status_code': 1, 'status': 'closed', 'status_description': 'Opens at 11:00am', 'eta': '15-30 mins', 'delivery_fee': 0, 'area': 'JLT'},
                2: {'status_code': 0, 'status': 'open', 'status_description': None, 'eta': '20-30 mins', 'delivery_fee': 0, 'area': 'Marina'},
                3: {'status_code': 0, 'status': 'open', 'status_description': None, 'eta': '10-20 mins', 'delivery_fee': 0, 'area': 'JLT'}}
        with patch.object(t.Talabat, 'live_status', return_value=live):
            out, dropped = t.finalize_vendors(tb, rows, 'sushi', open_only=True, limit=10)
        self.assertEqual([v['id'] for v in out], [2])  # irrelevant pizza dropped, closed branch dropped
        self.assertEqual(out[0]['status_source'], 'native_branch_live')

    def test_web_listing_and_search_allowlist(self):
        self.assertTrue(t.allowed('POST', t.WEB_SEARCH))
        self.assertTrue(t.allowed('GET', 'https://www.talabat.com/uae/pharmacies/1308/jumeirah-lakes-towers-jlt?page=2'))
        self.assertFalse(t.allowed('GET', 'https://www.talabat.com/uae/checkout'))
        self.assertFalse(t.allowed('POST', 'https://www.talabat.com/nextCheckoutApi/x'))

    def test_failed_live_status_never_passes_open(self):
        tb = self.tb()
        rows = [t.vendor_row(vendor(1, 'Sushi Hub'), 'web_search')]
        with patch.object(t.Talabat, 'live_status', return_value={1: None}):
            out, _ = t.finalize_vendors(tb, rows, 'sushi', open_only=True, limit=10)
        self.assertEqual(out, [])
        self.assertTrue(tb.fallbacks)

    def test_unrelated_recommendations_are_not_search_hits(self):
        tb = self.tb()
        rows = [t.vendor_row(vendor(1, 'Pizza Place', cuisine='Pizza'), 'native_search')]
        out, _ = t.finalize_vendors(tb, rows, 'zzqvnomatch', open_only=False, limit=10, status_check=False)
        self.assertEqual(out, [])

    def test_menu_projection_cleans_prices_and_tags(self):
        data = {'vendor': {'result': {'restaurant': {'bid': 8, 'na': 'Anime Sushi', 'stt': 0}}},
                'menu': {'result': {'menu': {'menuSection': [{'nm': 'Salads (ANS)', 'itm': [
                    {'id': 1, 'nm': 'Seaweed Salad (ANS)', 'dsc': '', 'pr': 29.990000000000002}]}]}}}}
        r = t.project_menu(data, 8, '', 10)
        self.assertEqual(r['items'][0]['name'], 'Seaweed Salad')
        self.assertEqual(r['items'][0]['price'], 29.99)
        self.assertEqual(r['restaurant']['status'], 'open')


class CareemTests(unittest.TestCase):
    def test_candidate_failure_is_not_no_match(self):
        catalog = unittest.mock.Mock()
        catalog.fetch.side_effect = cs.SearchError('HTTP_503')
        with self.assertRaises(cs.SearchError):
            cs.run_menu_match(catalog, ['sushi', 'seaweed salad'], 10, True)

    def test_shops_open_filter_and_fee_eta_provenance(self):
        catalog = unittest.mock.Mock()
        catalog.merchant_info.return_value = {'delivery_fee': 6, 'delivery_fee_careem_plus': 0,
                                              'area': 'JLT', 'eta': '10 - 20 mins'}
        groups = [{'merchant_id': '1', 'store': 'X', 'status': 'closed', 'eta': '20 mins',
                   'items': [{'name': 'Milk', 'price': 5}]}]
        with patch.object(cs, 'shop_groups', return_value=groups):
            r = cs.run_shops(catalog, 'milk', 10, False, 20, [], open_only=True)
        self.assertEqual(r['stores'], [])

    def test_shop_groups_mark_irrelevant_items(self):
        card = lambda i, n, p: {'event_configuration': {'entity': {'attributes': {'item_id': i, 'item_name': n, 'item_price': p, 'item_availability': True}}}}
        data = {'body': {'content': [{'id': 'global-search-shops__1', 'type': 'item-card-carousel-v3',
                 'header': {'id': '1', 'title': 'Geant', 'eta': '25 - 35 mins', 'event_configuration': {'entity': {'attributes': {
                     'merchant_id': '1', 'merchant_availability': True, 'distance': 6000}}}},
                 'content': [card(1, 'Nespresso Buenos Aires Lungo', 43.95), card(2, 'Apple AirPods Pro', 899)]}]}}
        g = cs.shop_groups(data)
        self.assertEqual(g[0]['store'], 'Geant')
        self.assertEqual(len(g[0]['items']), 2)
        self.assertEqual(g[0]['distance_km'], 6.0)

    def test_restaurant_status_from_availability(self):
        node = {'trailing_content': {'title': 'X', 'eta': '20 - 30 mins'},
                'event_configuration': {'entity': {'attributes': {'merchant_id': 5, 'merchant_name': 'X', 'merchant_availability': False}}}}
        self.assertEqual(cs.restaurants({'body': [node]})[0]['status'], 'closed')


class NoonTests(unittest.TestCase):
    def test_open_label_without_accepting_orders_is_not_open(self):
        data = {'data': {'outletCode': 'TEST', 'name': 'Test', 'operatingStatusCode': 'open',
                         'isAcceptingOrders': False, 'menu': {}}}
        with patch.object(native, 'call', return_value=data):
            info, _ = native.food_menu_raw('TEST', {}, 10)
        self.assertEqual(info['status'], 'not_accepting_orders')


if __name__ == '__main__':
    unittest.main()
