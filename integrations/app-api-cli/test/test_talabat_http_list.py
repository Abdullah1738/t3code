import io
import json
import time
import unittest
from unittest.mock import patch

import talabat_http_list as listing
from test.test_talabat_http_orders import saved


def page(start=1, count=75, last=False, total=85):
    return {'orders': [{'id': i, 'status': 'Delivered', 'branch_name': 'Test branch',
                        'encrypted_id': 'private', 'items_description': 'private',
                        'action_button_type': 'reorder'} for i in range(start, start + count)],
            'is_last_page': last, 'total_orders': total,
            'lazy_load_calls': [{'method': 'POST', 'url': 'https://example.invalid/private'}]}


class ListingTest(unittest.TestCase):
    def setUp(self):
        self.saved = saved()
        self.saved['headers'] = {'authorization': 'old', 'cookie': 'private', 'x-device-id': 'synthetic-device'}
        for target, replacement in [('account', lambda **kw: self.saved),
                                    ('request', lambda *a: {'id': 123}), ('verify_profile', lambda *a: None)]:
            p = patch.object(listing.http, target, replacement)
            p.start()
            self.addCleanup(p.stop)

    def test_default_bound_and_allowlisted_projection(self):
        with patch.object(listing, 'page_request', return_value=page()) as request:
            result = listing.list_orders()
        self.assertEqual(request.call_count, 1)
        self.assertEqual(len(result['orders']), 20)
        self.assertTrue(result['truncated'])
        self.assertTrue(result['pagination']['output_truncated'])
        self.assertEqual(result['pagination']['next_page'], 1)
        self.assertNotIn('private', json.dumps(result))
        self.assertNotIn('reorder', json.dumps(result))

    def test_two_pages_complete_only_when_native_last_and_total_agree(self):
        with patch.object(listing, 'page_request', side_effect=[page(), page(76, 10, True)]) as request:
            result = listing.list_orders(pages=2, limit=150)
        self.assertFalse(result['truncated'])
        self.assertEqual(len(result['orders']), 85)
        self.assertEqual([c.args[1] for c in request.call_args_list], [0, 1])
        self.assertIsNone(result['pagination']['next_page'])

    def test_nonzero_page_explicitly_omits_earlier(self):
        with patch.object(listing, 'page_request', return_value=page(76, 10, True)):
            result = listing.list_orders(page=1)
        self.assertTrue(result['truncated'])
        self.assertTrue(result['pagination']['earlier_pages_omitted'])

    def test_unknown_status_not_guessed_and_eta_never_extracted(self):
        row = {'id': 1, 'status': 'AlmostDelivered', 'eta': 'fake', 'rider': 'private'}
        result = listing.project_order(row)
        self.assertEqual(result['status'], 'unknown')
        self.assertIsNone(result['eta'])
        self.assertIsNone(result['rider'])

    def test_schema_errors_are_closed(self):
        for change in [{'orders': {}}, {'is_last_page': 'true'}, {'total_orders': True},
                       {'orders': [{'id': True, 'status': 'Delivered'}]}, {'total_orders': -1},
                       {'orders': [{'id': 1, 'status': 'https://secret.invalid'}]}, {'orders': page(count=76)['orders']}]:
            with self.subTest(change=change), patch.object(listing, 'page_request', return_value={**page(), **change}):
                with self.assertRaisesRegex(listing.http.TalabatError, 'SCHEMA_CHANGED'):
                    listing.list_orders()

    def test_bounds_before_account_or_network(self):
        for args in [{'page': -1}, {'page': True}, {'pages': 6}, {'limit': 0}, {'limit': 376},
                     {'pages': 0}, {'page': 999, 'pages': 2}, {'timeout': float('nan')}, {'timeout': -1}]:
            with self.subTest(args=args), patch.object(listing.http, 'account') as account, patch.object(listing, 'page_request') as request:
                with self.assertRaises(listing.http.TalabatError):
                    listing.list_orders(**args)
                account.assert_not_called()
                request.assert_not_called()

    def test_profile_mismatch_prevents_listing(self):
        with patch.object(listing.http, 'verify_profile', side_effect=listing.http.TalabatError('ACCOUNT_IDENTITY_MISMATCH')), \
                patch.object(listing, 'page_request') as request:
            with self.assertRaisesRegex(listing.http.TalabatError, 'MISMATCH'):
                listing.list_orders()
        request.assert_not_called()

    def test_duplicates_and_changed_totals_disclose_incomplete_snapshot(self):
        with patch.object(listing, 'page_request', side_effect=[page(), page(75, 10, True, total=84)]):
            result = listing.list_orders(pages=2, limit=150)
        self.assertTrue(result['truncated'])
        self.assertTrue(result['pagination']['snapshot_changed'])
        self.assertEqual(result['pagination']['duplicates_omitted'], 1)
        self.assertEqual(len(result['orders']), 84)

    def test_short_page_not_used_to_infer_completion(self):
        with patch.object(listing, 'page_request', return_value=page(1, 3, False, 3)):
            result = listing.list_orders()
        self.assertTrue(result['truncated'])

    def test_empty_last_page_is_complete_empty_history(self):
        with patch.object(listing, 'page_request', return_value=page(1, 0, True, 0)):
            result = listing.list_orders()
        self.assertFalse(result['truncated'])
        self.assertEqual(result['orders'], [])

    def test_empty_nonlast_page_stops(self):
        with patch.object(listing, 'page_request', return_value=page(1, 0, False, 85)):
            with self.assertRaisesRegex(listing.http.TalabatError, 'PAGINATION_STALLED'):
                listing.list_orders(pages=2)

    def test_transport_route_auth_and_response_limit(self):
        from unittest.mock import MagicMock
        response = MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = json.dumps(page()).encode()
        opener = MagicMock()
        opener.open.return_value = response
        with patch.object(listing.urllib.request, 'build_opener', return_value=opener):
            data = listing.page_request(self.saved, 1, time.monotonic() + 3)
            request = opener.open.call_args.args[0]
            self.assertEqual(request.method, 'GET')
            self.assertIn('page_number=1&page_size=75', request.full_url)
            self.assertTrue(request.full_url.startswith('https://api.talabat.com/vendor-list/v1/orders/country/4?'))
            self.assertIsNone(request.get_header('Cookie'))
            self.assertEqual(request.get_header('Authorization'), 'Bearer ' + self.saved['auth']['access_token'])
            self.assertEqual(data['total_orders'], 85)
            response.read.return_value = b'x' * (listing.http.MAX_BYTES + 1)
            with self.assertRaisesRegex(listing.http.TalabatError, 'RESPONSE_TOO_LARGE'):
                listing.page_request(self.saved, 0, time.monotonic() + 3)

    def test_second_page_failure_not_partial_success(self):
        with patch.object(listing, 'page_request', side_effect=[page(), listing.http.TalabatError('RATE_LIMITED')]):
            with self.assertRaisesRegex(listing.http.TalabatError, 'RATE_LIMITED'):
                listing.list_orders(pages=2, limit=150)

    def test_preparing_mapping_verified_on_exact_active_order(self):
        self.assertEqual(listing.project_order({'id': 123, 'status': 'Preparing'})['status'], 'preparing')
        self.assertEqual(listing.project_order({'id': 123, 'status': 'Delivering'})['status'], 'out for delivery')

    def test_page_401_restarts_profile_and_whole_pagination_once(self):
        error = listing.http.TalabatError('AUTH_EXPIRED_RENEWAL_REQUIRED')
        with patch.object(listing, 'page_request', side_effect=[page(), error, page(), page(76, 10, True)]) as request, \
                patch.object(listing.http, 'verify_profile') as profile, patch.object(listing.auth, 'refresh') as refresh:
            result = listing.list_orders(pages=2, limit=150)
        self.assertEqual(len(result['orders']), 85)
        self.assertEqual([c.args[1] for c in request.call_args_list], [0, 1, 0, 1])
        self.assertEqual(profile.call_count, 2)
        refresh.assert_called_once()

    def test_forbidden_never_renews(self):
        with patch.object(listing, 'page_request', side_effect=listing.http.TalabatError('AUTH_FORBIDDEN')), \
                patch.object(listing.auth, 'refresh') as refresh:
            with self.assertRaisesRegex(listing.http.TalabatError, 'FORBIDDEN'):
                listing.list_orders()
        refresh.assert_not_called()

    def test_cli_unexpected_error_is_sanitized(self):
        with patch.object(listing, 'list_orders', side_effect=RuntimeError('secret')), patch('sys.stdout', new_callable=io.StringIO) as out:
            self.assertEqual(listing.main([]), 1)
        self.assertNotIn('secret', out.getvalue())


if __name__ == '__main__':
    unittest.main()
