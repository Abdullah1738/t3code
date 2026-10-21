import copy
import io
import importlib.util
import json
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch, Mock
import urllib.error

SOURCE = Path(__file__).resolve().parents[1]
CATALOG = Path.home() / '.local/share/app-api-cli'
sys.path.insert(0, str(CATALOG / 'capture'))
sys.path.insert(0, str(SOURCE))
import talabat_account_catalog as a
import talabat_http_orders as orders
import talabat_auth as auth
_source_import_path = sys.path[:]
try:
    # Only the catalog lives in the installed tree. Do not let this test's
    # import change which version of later source modules discovery exercises.
    sys.path.append(str(CATALOG))
    import talabat_native as native
finally:
    sys.path[:] = _source_import_path
    del _source_import_path
    # Catalog functions lazily import catalog_schema; keep the catalog
    # available after source paths without letting it shadow source adapters.
    if str(CATALOG) not in sys.path:
        sys.path.append(str(CATALOG))

SAVED = {'expected_profile': {'id': 123, 'mobile_country_code': '971', 'mobile_number': '000000000'},
         'auth': {'access_token': 'test-only', 'customerId': 123}, 'headers': {}}
ADDRESS = {'id': 'private-address', 'profile_name': 'Banyantree Residences Hillside',
           'cust_id': 123, 'suite': '2104', 'country': 4, 'area_id': 1308, 'city_id': 35,
           'latitude': 25.0781, 'longitude': 55.1571, 'phone_number': 'private-phone'}
MENU = {'vendor': {'result': {'restaurant': {'bid': 717327, 'na': 'Cafe', 'stt': 0, 'dch': 0}}},
        'menu': {'result': {'menu': {'menuSection': [{'nm': 'Food', 'itm': [
            {'id': 1, 'nm': 'Pizza', 'pr': 10, 'token': 'secret'}]}]}}}}
UUID = '00000000-0000-0000-0000-000000000001'


def address_data():
    return {'has_error': False, 'result': [copy.deepcopy(ADDRESS)]}


class AccountCatalogTests(unittest.TestCase):
    def test_runtime_catalog_import_preserves_source_precedence(self):
        self.assertEqual(Path(importlib.util.find_spec('talabat_checkout').origin).parent,
                         SOURCE)
        self.assertEqual(Path(importlib.util.find_spec('catalog_schema').origin).parent,
                         SOURCE)

    def test_home_is_unique_owned_and_not_first(self):
        data = address_data()
        old = {**ADDRESS, 'id': 'old', 'profile_name': 'HDS', 'latitude': 25.09}
        data['result'].insert(0, old)
        home = a.select_home(data, SAVED)
        self.assertEqual(home['latitude'], ADDRESS['latitude'])
        self.assertEqual(set(home), {'latitude', 'longitude', 'area_id', 'city_id'})
        for change in ({'cust_id': 999}, {'country': 3}, {'suite': '9999'}, {'area_id': 1},
                       {'id': ''}, {'latitude': float('nan')}, {'longitude': True}, {'city_id': False}):
            with self.subTest(change=change), self.assertRaises(a.TalabatError):
                a.select_home({'has_error': False, 'result': [{**ADDRESS, **change}]}, SAVED)

    def test_missing_ambiguous_and_unsafe_names(self):
        for rows in ([], [ADDRESS, ADDRESS], [{**ADDRESS, 'profile_name': 'Banyan fake'}],
                     [{**ADDRESS, 'profile_name': 'Default'}]):
            with self.subTest(rows=len(rows)), self.assertRaises(a.TalabatError):
                a.select_home({'has_error': False, 'result': rows}, SAVED)

    def test_address_errors_fail_closed(self):
        for data in ({}, {'has_error': True, 'result': [ADDRESS]}, {'has_error': False, 'result': [None]}):
            with self.assertRaises(a.TalabatError):
                a.select_home(data, SAVED)

    def test_narrow_allowlist(self):
        for method, url in [('GET', a.ADDRESSES + '?countryId=4'),
                            ('POST', a.HOST + a.SEARCH),
                            ('POST', a.HOST + f'/grocery/v1/bff/ae/vendors/{UUID}/products/search'),
                            ('GET', a.HOST + '/menubff/v4/branches/1/menu?branchId=1&areaId=1308&latitude=25&longitude=55&countryId=4')]:
            self.assertTrue(a.allowed(method, url), url)
        for method, url in [('POST', a.ADDRESSES), ('GET', a.ADDRESSES + '?countryId=3'),
                            ('GET', a.ADDRESSES + '?countryId=4&x=1'),
                            ('POST', a.HOST + '/grocery/v2/cart'), ('POST', a.HOST + '/ccx/v1/checkout/1/placeOrder'),
                            ('GET', 'https://www.talabat.com/uae'),
                            ('POST', a.HOST + ':443' + a.SEARCH),
                            ('POST', a.HOST + a.SEARCH + '?x=1'),
                            ('POST', 'https://u@api.talabat.com' + a.SEARCH),
                            ('POST', a.HOST + '.evil.test' + a.SEARCH),
                            ('POST', a.HOST + a.SEARCH + '#fragment')]:
            self.assertFalse(a.allowed(method, url), url)

    def test_wire_headers_no_redirect_and_bounded_response(self):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b'{}'
        opener = Mock()
        opener.open.return_value = response
        with patch.object(a.urllib.request, 'build_opener', return_value=opener) as build:
            a.wire(SAVED, time.monotonic() + 5, a.ADDRESSES, params={'countryId': 4})
        req = opener.open.call_args.args[0]
        self.assertEqual(req.method, 'GET')
        self.assertEqual(req.get_header('Authorization'), 'Bearer test-only')
        self.assertEqual(response.read.call_args.args, (a.MAX_BYTES + 1,))
        self.assertIsInstance(build.call_args.args[1], a.NoRedirect)
        self.assertEqual(build.call_args.args[0].proxies, {})

    def test_wire_error_redaction_and_no_retry(self):
        for status, code in ((401, 'AUTH_EXPIRED_RENEWAL_REQUIRED'), (403, 'AUTH_FORBIDDEN'),
                             (302, 'HTTP_302'), (429, 'RATE_LIMITED')):
            opener = Mock()
            opener.open.side_effect = urllib.error.HTTPError('secret-url', status, 'secret-message', {}, io.BytesIO(b'secret'))
            with patch.object(a.urllib.request, 'build_opener', return_value=opener):
                with self.assertRaisesRegex(a.TalabatError, '^' + code + '$'):
                    a.wire(SAVED, time.monotonic() + 5, a.ADDRESSES, params={'countryId': 4})
            self.assertEqual(opener.open.call_count, 1)

    def test_oversized_malformed_and_timeout(self):
        for payload, code in ((b'x' * (a.MAX_BYTES + 1), 'RESPONSE_TOO_LARGE'),
                              (b'not-json', 'NATIVE_READ_FAILED'), (b'[]', 'SCHEMA_CHANGED')):
            response = Mock()
            response.__enter__ = Mock(return_value=response)
            response.__exit__ = Mock(return_value=False)
            response.read.return_value = payload
            opener = Mock()
            opener.open.return_value = response
            with patch.object(a.urllib.request, 'build_opener', return_value=opener):
                with self.assertRaisesRegex(a.TalabatError, '^' + code + '$'):
                    a.wire(SAVED, time.monotonic() + 5, a.ADDRESSES, params={'countryId': 4})
        with self.assertRaisesRegex(a.TalabatError, 'NATIVE_READ_TIMEOUT'):
            a.wire(SAVED, time.monotonic() - 1, a.ADDRESSES, params={'countryId': 4})

    def run_mocked(self, mode, responses, **kwargs):
        with patch.object(a, 'read_with_renewal', side_effect=lambda op, end: op(SAVED, end)), \
             patch.object(a, 'wire', side_effect=responses) as wire, \
             patch.object(native, 'load', side_effect=AssertionError('guest load')), \
             patch.object(native, 'request', side_effect=AssertionError('guest network')), \
             patch.object(native, 'SharedState', side_effect=AssertionError('shared cache')):
            result = a.run(mode, **kwargs)
        return result, wire

    def test_menu_instance_home_no_private_records_or_guest_cache(self):
        old_home = copy.deepcopy(native.HOME)
        result, wire = self.run_mocked('menu', [address_data(), MENU], branch=717327)
        self.assertEqual(wire.call_args_list[1].kwargs['params']['latitude'], ADDRESS['latitude'])
        self.assertEqual(native.HOME, old_home)
        self.assertTrue(result['account']['profile_verified'])
        self.assertFalse(result['account']['benefits_verified'])
        self.assertFalse(result['checkout_quote_verified'])
        text = json.dumps(result)
        for secret in ('private-address', 'private-phone', 'test-only', 'secret', '25.0781'):
            self.assertNotIn(secret, text)
        self.assertEqual(result['restaurant']['fee_source'], a.FEE_SOURCE)

    def test_menu_branch_mismatch(self):
        with self.assertRaisesRegex(a.TalabatError, 'BRANCH_MISMATCH'):
            self.run_mocked('menu', [address_data(), MENU], branch=999)

    def test_hours(self):
        result, _ = self.run_mocked('hours', [address_data(), MENU], branch=717327)
        self.assertEqual(result['restaurant']['status'], 'open')
        self.assertEqual(result['restaurant']['status_cache_ttl_seconds'], 0)

    def test_mart_account_branch_and_products(self):
        branch = {'vendor': {'talabat_id': native.MART_BRANCH, 'global_id': UUID,
                             'vendor_name': 'Mart', 'delivery_fee': 0, 'minimum_order_value': 10}}
        result, wire = self.run_mocked('mart', [address_data(), branch, {'products': [{'name': 'Milk', 'price': 9}]}], query='milk')
        body = wire.call_args_list[2].kwargs['body']
        self.assertEqual(body['customer_id'], SAVED['expected_profile']['id'])
        self.assertEqual(body['branch_id'], str(native.MART_BRANCH))
        self.assertEqual(result['store']['status'], 'unknown')
        self.assertEqual(len(result['items']), 1)

    def test_mart_wrong_branch_stops(self):
        with self.assertRaisesRegex(a.TalabatError, 'BRANCH_MISMATCH'):
            self.run_mocked('mart', [address_data(), {'vendor': {'talabat_id': 99, 'global_id': UUID}}], query='milk')

    def test_search_sequential_without_benefit_assumption(self):
        search = {'result': {'vendors': [{'vendor_id': 717327, 'vendor_name': 'Cafe', 'vendor_status': 0}]}}
        with patch.object(native.cf, 'ThreadPoolExecutor', side_effect=AssertionError('worker thread')):
            result, wire = self.run_mocked('restaurants', [address_data(), search, MENU], query='Cafe')
        body = wire.call_args_list[1].kwargs['body']
        self.assertNotIn('is_tpro_user', body)
        self.assertEqual(body['areaid'], 1308)
        self.assertEqual(result['items'][0]['fee_source'], a.FEE_SOURCE)
        self.assertEqual(result['items'][0]['status_cache_ttl_seconds'], 0)

    def test_empty_native_search_never_falls_back(self):
        with patch.object(native, 'web_request', side_effect=AssertionError('web')):
            with self.assertRaisesRegex(a.TalabatError, 'NATIVE_EMPTY_UNVERIFIED_NO_FALLBACK'):
                self.run_mocked('restaurants', [address_data(), {'result': {'vendors': []}}], query='Cafe')

    def test_unsupported_and_threads_stop_before_auth(self):
        import concurrent.futures
        with patch.object(a, 'read_with_renewal') as auth_read:
            for mode in ('groceries', 'pharmacies', 'flowers', 'menu-match', 'checkout'):
                with self.assertRaisesRegex(a.TalabatError, 'ACCOUNT_MODE_UNSUPPORTED'):
                    a.run(mode)
            with concurrent.futures.ThreadPoolExecutor(1) as executor:
                with self.assertRaisesRegex(a.TalabatError, 'NATIVE_DEADLINE_UNAVAILABLE'):
                    executor.submit(a.run, 'menu', branch=1).result()
            auth_read.assert_not_called()

    def test_profile_binding_before_addresses(self):
        with patch.object(orders, 'account', return_value=SAVED), patch.object(auth, 'expiry', return_value=time.time()+500), \
             patch.object(orders, 'request', return_value={}), patch.object(a, 'wire') as wire, patch.object(auth, 'refresh') as refresh:
            with self.assertRaisesRegex(a.TalabatError, 'ACCOUNT_IDENTITY_MISMATCH'):
                a.run('menu', branch=717327)
            wire.assert_not_called()
            refresh.assert_not_called()

    def test_at_most_one_renewal_for_entire_operation(self):
        with patch.object(orders, 'account', return_value=SAVED), patch.object(auth, 'expiry', return_value=time.time()+500), \
             patch.object(orders, 'request', return_value=SAVED['expected_profile']), patch.object(auth, 'refresh') as refresh, \
             patch.object(a, 'wire', side_effect=a.TalabatError('AUTH_EXPIRED_RENEWAL_REQUIRED')) as wire:
            with self.assertRaisesRegex(a.TalabatError, 'AUTH_EXPIRED_RENEWAL_REQUIRED'):
                a.run('menu', branch=717327)
            self.assertEqual(refresh.call_count, 1)
            self.assertEqual(wire.call_count, 2)

    def test_renewal_rebinds_profile_and_home_before_retry(self):
        with patch.object(orders, 'account', return_value=SAVED), patch.object(auth, 'expiry', return_value=time.time()+500), \
             patch.object(orders, 'request', return_value=SAVED['expected_profile']) as profile, \
             patch.object(auth, 'refresh') as refresh, patch.object(a, 'wire', side_effect=[
                 address_data(), a.TalabatError('AUTH_EXPIRED_RENEWAL_REQUIRED'), address_data(), MENU]) as wire:
            result = a.run('menu', branch=717327)
        self.assertTrue(result['ok'])
        self.assertEqual(refresh.call_count, 1)
        self.assertEqual(profile.call_count, 2)
        self.assertEqual([call.args[2] for call in wire.call_args_list],
                         [a.ADDRESSES, '/menubff/v4/branches/717327/menu'] * 2)

    def test_non_auth_errors_do_not_refresh(self):
        for code in ('AUTH_FORBIDDEN', 'RATE_LIMITED', 'HOME_MISMATCH', 'NATIVE_READ_TIMEOUT'):
            with patch.object(orders, 'account', return_value=SAVED), patch.object(auth, 'expiry', return_value=time.time()+500), \
                 patch.object(orders, 'request', return_value=SAVED['expected_profile']), patch.object(auth, 'refresh') as refresh, \
                 patch.object(a, 'wire', side_effect=a.TalabatError(code)):
                with self.assertRaisesRegex(a.TalabatError, code):
                    a.run('menu', branch=717327)
                refresh.assert_not_called()

    def test_separate_operations_keep_locations_instance_local(self):
        for lat in (25.0781, 25.0782):
            addresses = address_data()
            addresses['result'][0]['latitude'] = lat
            _, wire = self.run_mocked('menu', [addresses, MENU], branch=717327)
            self.assertEqual(wire.call_args_list[1].kwargs['params']['latitude'], lat)
        self.assertNotEqual(native.HOME_LAT, 25.0782)


if __name__ == '__main__':
    unittest.main()
