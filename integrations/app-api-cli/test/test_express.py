import unittest
from unittest.mock import patch
from talabat_native import Talabat, NativeError, mode_stores


class ExpressRegression(unittest.TestCase):
    def test_grocery_404_is_unknown_not_open(self):
        tb = Talabat(saved={'templates': {}})
        with patch.object(tb, 'menu_raw', side_effect=NativeError('HTTP_404', 'missing')), patch.object(tb, 'grocery_branch', return_value={'vendor_name': 'Carrefour express', 'delivery_fee': 0, 'minimum_order_value': 30}):
            result = tb.status(1115312)
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['minimum_order'], 30)
        self.assertEqual(result['delivery_fee'], 0)

    def test_express_beyond_page_three_and_duplicate_tiles(self):
        tb = Talabat(saved={'templates': {}})
        def page(url, timeout):
            number = int(url.split('page=')[1]) if 'page=' in url else 1
            return {'metadata': {'size': 20, 'totalVendors': 80}, 'vendors': [{'branchId': 1115312 if number == 4 else 746471, 'name': 'Carrefour express' if number == 4 else 'Carrefour'}]}
        with patch('talabat_native.web_request', side_effect=page):
            rows = tb.store_listing('groceries')
        self.assertEqual([r['id'] for r in rows], [746471, 1115312])

    def test_unknown_express_excluded_by_open(self):
        tb = Talabat(saved={'templates': {}})
        with patch.object(tb, 'store_listing', return_value=[{'id': 1115312, 'name': 'Carrefour express'}]), patch.object(tb, 'live_status', return_value={1115312: {'status': 'unknown', 'status_description': 'unavailable', 'eta': None, 'delivery_fee': 0}}):
            result = mode_stores(tb, 'groceries', 'Carrefour express', limit=10, stores=12, open_only=True)
        self.assertEqual(result['stores'], [])
        self.assertEqual(result['coverage']['status_checks_failed'], 1)
