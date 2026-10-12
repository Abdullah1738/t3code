import copy
import datetime as dt
from dataclasses import FrozenInstanceError, replace
import hashlib
import io
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch
import urllib.error
import urllib.parse

import talabat_checkout as checkout
from test.test_talabat_http_orders import saved


def card(**changes):
    return {'cardNumber': '**** **** **** 5542', 'CountryId': 4, 'isExpired': False,
            'isValidCard': True, 'isForceCvv': False, 'expireYear': '40', 'expireMonth': '12',
            'token': 'synthetic-private-token', 'tokenId': 'synthetic-private-token-id',
            'holderName': 'synthetic-private-name', **changes}


def home(**changes):
    return {'id': 'synthetic-private-address', 'cust_id': 123, 'country': 4, 'area_id': 1308,
            'profile_name': 'Banyantree', 'suite': '2104', 'latitude': 25.0778, 'longitude': 55.1569,
            'delivery_instructions': [], 'mobile_number': 'synthetic-private-mobile', **changes}


def vendor(**changes):
    return {'talabat_id': checkout.BRANCH, 'global_id': 'synthetic-private-vendor', 'chain_id': 99,
            'is_dark_store': True, 'is_tpro': True, 'delivery_fee': 0, **changes}


def cart(**changes):
    return {'id': 'synthetic-private-cart', 'subtotal_after_discount': 0, 'items': [],
            'lazy_banners': {'url': 'https://example.invalid/submit'}, **changes}


class CheckoutTest(unittest.TestCase):
    def setUp(self):
        self.saved = saved()
        self.saved['expected_profile']['id'] = 123
        self.saved['auth']['customerId'] = 123
        self.saved['headers'] = {'authorization': 'old-private', 'cookie': 'old-private',
                                 'x-device': 'old-private', 'x-device-id': 'synthetic-device'}
        self.body = [{'data': [card()], 'error': ''}, {'has_error': False, 'result': [home()]},
                     {'vendor': vendor()}, cart()]
        self.patches = [patch.object(checkout, 'verticals_key', return_value='synthetic-apikey'),
                        patch.object(checkout.http, 'account', return_value=self.saved),
                        patch.object(checkout.http, 'request', return_value={'id': 123}),
                        patch.object(checkout.http, 'verify_profile'),
                        patch.object(checkout.auth, 'refresh', side_effect=AssertionError('no renewal allowed')),
                        patch.object(checkout.auth, 'write_store', side_effect=AssertionError('no persistence allowed'))]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)

    def run_read(self, body=None):
        with patch.object(checkout, 'get_json', side_effect=copy.deepcopy(body or self.body)) as get:
            result = checkout.readiness('public-pool')
        return result, get

    def test_parent_probe_dry_run_builds_exact_wire_without_marker_or_post(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(checkout, 'get_json', side_effect=copy.deepcopy(self.body)) as get, \
                patch.object(checkout, '_probe_post') as post:
            result = checkout.parent_cart_probe('pool', directory)
            self.assertFalse(result['sent'])
            self.assertEqual(result['request_schema']['branch_id'], 'string')
            self.assertEqual(result['request_schema']['chain_id'], 'string')
            self.assertEqual(result['item_schema']['increment_weight'], 'null')
            self.assertEqual(get.call_args.kwargs['probe_context'], True)
            self.assertEqual(get.call_args.args[3]['campaign_progress_required'], 'true')
            self.assertEqual(list(Path(directory).iterdir()), [])
            post.assert_not_called()
            self.assertNotIn('synthetic-private', json.dumps(result))
        body = checkout._quest_body(home(), vendor())
        self.assertEqual(body['items'], [{'product_id': checkout.QUEST, 'quantity': 1, 'increment_weight': None}])
        self.assertEqual(body['branch_id'], '798285')
        self.assertEqual(body['chain_id'], '99')
        self.assertIs(body['campaign_progress_required'], True)
        self.assertIs(body['has_outstanding_payments'], False)

    def test_parent_probe_no_send_without_fresh_phone_attestation(self):
        for stamp, verified in [(None, False), (time.time(), False), (True, True),
                                (time.time()-121, True), (time.time()+10, True)]:
            with self.subTest(stamp=stamp), patch.object(checkout, 'get_json') as get:
                with self.assertRaisesRegex(checkout.http.TalabatError, 'FRESH_PARENT_PHONE'):
                    checkout.parent_cart_probe('pool', '/not-used', send=True,
                        phone_checked_at=stamp, phone_empty_home_account_verified=verified)
                get.assert_not_called()

    def test_parent_probe_refuses_existing_cart_without_consuming_intent(self):
        body = copy.deepcopy(self.body)
        body[-1] = cart(items=[{'product_id': 'unrelated', 'quantity': 1}], subtotal_after_discount=5)
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(checkout, 'get_json', side_effect=body), patch.object(checkout, '_probe_post') as post:
            with self.assertRaisesRegex(checkout.http.TalabatError, 'SERVER_CART_NOT_EMPTY'):
                checkout.parent_cart_probe('pool', directory, send=True, phone_checked_at=time.time(),
                                           phone_empty_home_account_verified=True)
            self.assertEqual(list(Path(directory).iterdir()), [])
            post.assert_not_called()

    def test_parent_probe_marker_precedes_send_and_blocks_reuse(self):
        response = cart(branch_id=checkout.BRANCH, items=[{'product_id': checkout.QUEST, 'quantity': 1}],
                        subtotal_after_discount=20.25)
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / checkout.PROBE_MARKER
            def dispatch(*args):
                intent = json.loads(marker.read_text())
                self.assertEqual(intent['state'], 'MAY_HAVE_SENT')
                self.assertEqual(marker.stat().st_mode & 0o777, 0o600)
                return response
            with patch.object(checkout, 'get_json', side_effect=copy.deepcopy(self.body + [response])), \
                    patch.object(checkout, '_probe_post', side_effect=dispatch) as post:
                result = checkout.parent_cart_probe('pool', directory, send=True,
                    phone_checked_at=time.time(), phone_empty_home_account_verified=True)
                self.assertEqual(post.call_count, 1)
                self.assertTrue(result['response']['sole_quest_quantity_one'])
                self.assertTrue(result['readback']['same_cart_id_as_preflight'])
                self.assertTrue(result['readback']['sole_quest_quantity_one'])
                self.assertFalse(result['quote_sent'])
                self.assertFalse(result['cleanup_sent'])
            text = marker.read_text()
            self.assertEqual(len(text.splitlines()), 3)
            self.assertNotIn('synthetic-private', text)
            with patch.object(checkout, 'get_json') as get:
                with self.assertRaisesRegex(checkout.http.TalabatError, 'ALREADY_CONSUMED'):
                    checkout.parent_cart_probe('pool', directory, send=True,
                        phone_checked_at=time.time(), phone_empty_home_account_verified=True)
                get.assert_not_called()

    def test_parent_probe_ambiguous_submission_keeps_intent_never_cleans(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(checkout, 'get_json', side_effect=copy.deepcopy(self.body)), \
                patch.object(checkout, '_probe_post', side_effect=OSError('private-network-body')) as post, \
                patch.object(checkout, 'prepare_quote') as quote:
            with self.assertRaisesRegex(checkout.http.TalabatError, '^CART_PROBE_SUBMISSION_UNKNOWN_INTENT_CONSUMED$'):
                checkout.parent_cart_probe('pool', directory, send=True,
                    phone_checked_at=time.time(), phone_empty_home_account_verified=True)
            self.assertEqual(post.call_count, 1)
            quote.assert_not_called()
            self.assertEqual(len((Path(directory)/checkout.PROBE_MARKER).read_text().splitlines()), 1)

    def test_parent_probe_readback_failure_does_not_repeat_or_hide_post(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(checkout, 'get_json', side_effect=copy.deepcopy(self.body) + [OSError('private')]), \
                patch.object(checkout, '_probe_post', return_value=cart()) as post:
            result = checkout.parent_cart_probe('pool', directory, send=True,
                phone_checked_at=time.time(), phone_empty_home_account_verified=True)
            self.assertTrue(result['sent'])
            self.assertEqual(result['readback']['error'], 'CART_READBACK_UNAVAILABLE')
            self.assertEqual(post.call_count, 1)

    def test_parent_probe_failed_intent_fsync_prevents_dispatch(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(checkout, 'get_json', side_effect=copy.deepcopy(self.body)), \
                patch.object(checkout.os, 'fsync', side_effect=OSError('private')), \
                patch.object(checkout, '_probe_post') as post:
            with self.assertRaisesRegex(checkout.http.TalabatError, 'INTENT_CONSUMED'):
                checkout.parent_cart_probe('pool', directory, send=True,
                    phone_checked_at=time.time(), phone_empty_home_account_verified=True)
            post.assert_not_called()
            self.assertTrue((Path(directory)/checkout.PROBE_MARKER).exists())

    def test_probe_response_only_safe_allowlisted_projection(self):
        response = cart(branch_id=checkout.BRANCH, items=[{'product_id': checkout.QUEST, 'quantity': 1}],
                        subtotal_after_discount=20.25, token='private-secret', **{'private-key-secret': 'value'})
        result = checkout.project_probe_cart(response, response['id'])
        self.assertTrue(result['sole_quest_quantity_one'])
        self.assertTrue(result['same_cart_id_as_preflight'])
        self.assertEqual(result['subtotal_after_discount'], 20.25)
        self.assertNotIn('private', json.dumps(result))
        for rows in ([{'product_id': 'other', 'quantity': 1}],
                     [{'product_id': checkout.QUEST, 'quantity': True}],
                     [{'product_id': checkout.QUEST, 'quantity': 2}],
                     [{'product_id': checkout.QUEST, 'quantity': 1, 'free_quantity': 1}],
                     [{'product_id': checkout.QUEST, 'quantity': 1}, {'product_id': 'other', 'quantity': 1}],
                     [None], None):
            with self.subTest(rows=rows):
                self.assertFalse(checkout.project_probe_cart(cart(items=rows), 'id')['sole_quest_quantity_one'])

    def test_probe_transport_is_one_post_no_redirect_refresh_or_retry(self):
        response = MagicMock()
        response.__enter__.return_value = response
        response.code = 201
        response.read.return_value = b'{"items":[]}'
        opener = MagicMock()
        opener.open.return_value = response
        with patch.object(checkout.urllib.request, 'build_opener', return_value=opener):
            checkout._probe_post(self.saved, 'synthetic-apikey', checkout._quest_body(home(), vendor()),
                                 checkout.auth.new_deadline(30))
            request = opener.open.call_args.args[0]
            self.assertEqual(request.get_method(), 'POST')
            self.assertEqual(request.full_url, checkout.API + checkout.CART)
            self.assertEqual(json.loads(request.data)['branch_id'], '798285')
            headers = {k.lower(): v for k,v in request.header_items()}
            self.assertNotIn('cookie', headers)
            self.assertEqual(headers['x-tpro-deals-enabled'], 'true')
            self.assertEqual(headers['x-weightables-enabled'], 'true')
            self.assertNotIn('x-user-flow', headers)
            opener.open.reset_mock()
            opener.open.side_effect = urllib.error.HTTPError(request.full_url, 401, 'secret', {}, io.BytesIO())
            with self.assertRaisesRegex(checkout.http.TalabatError, '^CART_PROBE_SUBMISSION_UNKNOWN$'):
                checkout._probe_post(self.saved, 'synthetic-apikey', checkout._quest_body(home(), vendor()),
                                     checkout.auth.new_deadline(30))
            self.assertEqual(opener.open.call_count, 1)

    def test_probe_missing_branch_echo_is_unknown_not_scope_mismatch(self):
        # Matches the parent-observed response shape, with wholly synthetic IDs.
        response = cart(items=[{'product_id': checkout.QUEST, 'quantity': 1}],
                        subtotal_after_discount=20.25)
        result = checkout.project_probe_cart(response, response['id'])
        self.assertFalse(result['branch_id_present'])
        self.assertIsNone(result['branch_matches'])
        self.assertTrue(result['sole_quest_quantity_one'])
        self.assertTrue(result['same_cart_id_as_preflight'])
        self.assertFalse(result['checkout_binding_verified'])
        for branch, matches in ((checkout.BRANCH, True), (str(checkout.BRANCH), True),
                                (None, False), (True, False), (1, False), (798285.0, False)):
            with self.subTest(branch=branch):
                projected = checkout.project_probe_cart({**response, 'branch_id': branch}, response['id'])
                self.assertTrue(projected['branch_id_present'])
                self.assertIs(projected['branch_matches'], matches)

    def test_probe_transport_rejects_any_other_body(self):
        for change in ({'items': []}, {'branch_id': checkout.BRANCH}, {'chain_id': 99},
                       {'campaign_progress_required': False}, {'lat': 25.06},
                       {'has_outstanding_payments': True}, {'extra': 'field'},
                       {'items': [{'product_id': checkout.QUEST, 'quantity': True, 'increment_weight': None}]}):
            with self.subTest(change=change), patch.object(checkout.urllib.request, 'build_opener') as opener:
                body = {**checkout._quest_body(home(), vendor()), **change}
                with self.assertRaisesRegex(checkout.http.TalabatError, 'BODY_DENIED'):
                    checkout._probe_post(self.saved, 'synthetic-apikey', body, checkout.auth.new_deadline(30))
                opener.assert_not_called()

    def test_readiness_bound_to_profile_home_card_branch_but_not_quote(self):
        result, get = self.run_read()
        self.assertTrue(result['ok'])
        self.assertTrue(result['profile_verified'])
        self.assertTrue(result['saved_home_verified'])
        self.assertTrue(result['payment']['not_expired'])
        self.assertTrue(result['cart']['empty'])
        for key in ('commit_enabled', 'cart_mutation_enabled', 'checkout_quote_verified',
                    'quiet_instructions_verified', 'benefits_verified', 'cancel_enabled'):
            self.assertIs(result[key], False)
        self.assertIs(result['payment']['selected_for_checkout'], False)
        self.assertIsNone(result['cart']['payable_total'])
        self.assertFalse(result['cart']['response_owner_binding_verified'])
        self.assertFalse(result['cart']['app_cart_sync_verified'])
        self.assertEqual(get.call_count, 4)
        calls = get.call_args_list
        self.assertEqual([c.args[2] for c in calls],
                         [checkout.CARDS, checkout.ADDRESSES, checkout.VENDOR, checkout.CART])
        self.assertEqual(len({c.args[4] for c in calls}), 1)
        self.assertEqual(calls[-1].args[3]['lat'], 25.0778)
        self.assertEqual(calls[-1].args[3]['lon'], 55.1569)
        self.assertEqual(calls[-1].args[3]['dh_vendor_id'], vendor()['global_id'])
        self.assertEqual(calls[-1].args[3]['has_outstanding_payments'], 'false')
        output = json.dumps(result)
        for value in ['synthetic-private', 'synthetic-apikey', 'old-private', 'example.invalid', '2104']:
            self.assertNotIn(value, output)

    def test_cart_not_empty_is_readable_but_never_overwritten(self):
        body = copy.deepcopy(self.body)
        body[-1] = cart(items=[{'product_id': 'private-item', 'quantity': 2}], subtotal_after_discount=15)
        result, get = self.run_read(body)
        self.assertFalse(result['cart']['empty'])
        self.assertEqual(result['cart']['item_rows'], 1)
        self.assertIn('CART_NOT_EMPTY', result['blockers'])
        self.assertFalse(result['commit_enabled'])
        self.assertEqual(get.call_count, 4)
        self.assertNotIn('private-item', json.dumps(result))

    def test_profile_mismatch_blocks_all_followon_reads(self):
        with patch.object(checkout.http, 'verify_profile', side_effect=checkout.http.TalabatError('IDENTITY_MISMATCH')), \
                patch.object(checkout, 'get_json') as get:
            with self.assertRaisesRegex(checkout.http.TalabatError, 'IDENTITY_MISMATCH'):
                checkout.readiness('pool')
            get.assert_not_called()

    def test_expired_auth_never_renews_or_requests_sms(self):
        with patch.object(checkout.http, 'account', side_effect=checkout.http.TalabatError('AUTH_EXPIRED_RENEWAL_REQUIRED')), \
                patch.object(checkout, 'get_json') as get, patch.object(checkout.auth, 'login_request') as login:
            with self.assertRaisesRegex(checkout.http.TalabatError, 'AUTH_EXPIRED'):
                checkout.readiness('pool')
            get.assert_not_called()
            login.assert_not_called()

    def test_card_flags_and_material_fail_closed(self):
        changes = [{'isExpired': True}, {'isExpired': None}, {'isValidCard': False}, {'isForceCvv': True},
                   {'isForceCvv': None}, {'isForceCvv': 0}, {'CountryId': '4'}, {'CountryId': 1},
                   {'token': None}, {'tokenId': ''}, {'cardNumber': '5555'}, {'cardNumber': 'junk5542'},
                   {'expireYear': '3'}, {'expireMonth': '13'}, {'expireMonth': '0'}, {'expireYear': '2000'}]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(checkout.http.TalabatError):
                checkout.select_card({'data': [card(**change)]})
        for rows in ([], [card(), card()], [None]):
            with self.subTest(rows=rows), self.assertRaises(checkout.http.TalabatError):
                checkout.select_card({'data': rows})

    def test_card_two_and_four_digit_expiry_end_of_month(self):
        now = dt.datetime(2026, 10, 31, tzinfo=dt.timezone.utc)
        for year in ('26', '2026'):
            with self.subTest(year=year):
                checkout.select_card({'data': [card(expireYear=year, expireMonth='10')]}, now)
                with self.assertRaisesRegex(checkout.http.TalabatError, 'EXPIRED'):
                    checkout.select_card({'data': [card(expireYear=year, expireMonth='09')]}, now)

    def test_card_failure_does_not_continue_to_home_or_cart(self):
        with patch.object(checkout, 'get_json', return_value={'data': [card(isForceCvv=True)]}) as get:
            with self.assertRaises(checkout.http.TalabatError):
                checkout.readiness('pool')
        self.assertEqual(get.call_count, 1)

    def test_home_strict_owner_country_name_unit_and_coordinates(self):
        changes = [{'cust_id': 999}, {'country': 3}, {'country': '4'}, {'suite': '9999'},
                   {'profile_name': 'Not Banyantree'}, {'profile_name': 'HDS'}, {'id': ''},
                   {'area_id': True}, {'latitude': float('nan')}, {'longitude': 190},
                   {'latitude': '25.0'}, {'delivery_instructions': None}]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(checkout.http.TalabatError):
                checkout.select_home({'result': [home(**change)], 'has_error': False}, self.saved)
        for rows in ([], [home(), home()], [None]):
            with self.subTest(rows=rows), self.assertRaises(checkout.http.TalabatError):
                checkout.select_home({'result': rows, 'has_error': False}, self.saved)
        self.assertEqual(checkout.select_home({'result': [home(profile_name='HDS'), home()],
                                             'has_error': False}, self.saved)['suite'], '2104')

    def test_saved_instructions_never_assumed_verified(self):
        body = copy.deepcopy(self.body)
        body[1]['result'][0]['delivery_instructions'] = [{'id': 'private', 'text': 'leave at door'}]
        result, _ = self.run_read(body)
        self.assertFalse(result['quiet_instructions_verified'])

    def test_wrong_home_locality_blocks_vendor_and_cart_reads(self):
        for change in ({'area_id': 1}, {'latitude': 24.45, 'longitude': 54.37},
                       {'latitude': 25.06}, {'longitude': 55.18}):
            body = copy.deepcopy(self.body)
            body[1]['result'][0].update(change)
            with self.subTest(change=change), patch.object(checkout, 'get_json', side_effect=body) as get:
                with self.assertRaisesRegex(checkout.http.TalabatError, 'SAVED_HOME_BINDING_INVALID'):
                    checkout.readiness('pool')
                self.assertEqual(get.call_count, 2)

    def test_vendor_schema_and_branch_mismatch(self):
        for change in ({'talabat_id': 99}, {'global_id': ''}, {'chain_id': '99'},
                       {'chain_id': -1}, {'is_dark_store': False}):
            with self.subTest(change=change), self.assertRaises(checkout.http.TalabatError):
                checkout.select_vendor({'vendor': vendor(**change)})

    def test_cart_malformed_or_inconsistent_empty_never_implies_quote(self):
        for change in ({'id': ''}, {'items': None}, {'items': [1]}, {'subtotal_after_discount': True},
                       {'subtotal_after_discount': float('nan')}, {'subtotal_after_discount': -1},
                       {'subtotal_after_discount': '0'}):
            with self.subTest(change=change), self.assertRaises(checkout.http.TalabatError):
                checkout.project_cart(cart(**change))
        result = checkout.project_cart(cart(subtotal_after_discount=1))
        self.assertFalse(result['empty'])
        self.assertIsNone(result['payable_total'])

    def test_deadline_input_checked_before_credentials_or_network(self):
        for timeout in (False, 0, -1, float('nan'), float('inf'), 121, '30'):
            with self.subTest(timeout=timeout), patch.object(checkout.http, 'account') as account, \
                    patch.object(checkout, 'get_json') as get:
                with self.assertRaisesRegex(checkout.http.TalabatError, 'INVALID_TIMEOUT'):
                    checkout.readiness('pool', timeout)
                account.assert_not_called()
                get.assert_not_called()

    def test_final_expired_deadline_is_failure(self):
        with patch.object(checkout, 'get_json', side_effect=self.body), \
                patch.object(checkout.http, 'remaining_time', side_effect=checkout.http.TalabatError('NATIVE_READ_TIMEOUT')):
            with self.assertRaisesRegex(checkout.http.TalabatError, 'TIMEOUT'):
                checkout.readiness('pool')

    def test_no_mutation_entrypoint_even_when_arguments_claim_approval(self):
        with patch.object(checkout, 'get_json') as get, patch.object(checkout.http, 'account') as account:
            for operation in (checkout.prepare_quote, checkout.replace_cart,
                              checkout.commit, checkout.cancel_order):
                with self.assertRaisesRegex(checkout.http.TalabatError, 'DISABLED'):
                    operation(approved=True, cart_id='synthetic', allowDuplicateOrder=True)
            get.assert_not_called()
            account.assert_not_called()

    def test_route_rejects_arbitrary_host_path_query_and_key(self):
        calls = [('https://example.invalid', checkout.CARDS, {'countryId': 4}, None),
                 (checkout.API, '/ccx/v1/checkout/1/placeOrder', {}, None),
                 (checkout.API, checkout.CARDS, {'countryId': 3}, None),
                 (checkout.API, checkout.CARDS, {'countryId': 4, 'url': 'private'}, None),
                 (checkout.API, checkout.CARDS, {'countryId': 4}, 'private')]
        with patch.object(checkout.urllib.request, 'build_opener') as opener:
            for host, path, query, key in calls:
                with self.subTest(path=path), self.assertRaisesRegex(checkout.http.TalabatError, 'DENIED'):
                    checkout.get_json(self.saved, host, path, query, time.monotonic() + 3, key)
            opener.assert_not_called()

    def test_transport_get_only_exact_headers_no_redirect_proxy_and_size_limit(self):
        response, opener = MagicMock(), MagicMock()
        response.__enter__.return_value = response
        response.code = 200
        response.read.return_value = json.dumps(cart()).encode()
        opener.open.return_value = response
        query = {'branch_id': checkout.BRANCH, 'dh_vendor_id': 'synthetic', 'global_entity_id': 'TB_AE',
                 'chain_id': 99, 'lat': 25.0778, 'lon': 55.1569, 'campaign_progress_required': 'false',
                 'has_outstanding_payments': 'false'}
        with patch.object(checkout.urllib.request, 'build_opener', return_value=opener) as build:
            checkout.get_json(self.saved, checkout.API, checkout.CART, query, time.monotonic() + 3, 'synthetic-apikey')
            req = opener.open.call_args.args[0]
            self.assertEqual(req.method, 'GET')
            self.assertIsNone(req.data)
            self.assertEqual(req.get_header('X-api-key'), 'synthetic-apikey')
            self.assertEqual(req.get_header('X-customer-id'), '123')
            self.assertEqual(req.get_header('X-platform'), 'android')
            self.assertEqual(req.get_header('Authorization'), 'Bearer ' + self.saved['auth']['access_token'])
            self.assertIsNone(req.get_header('Cookie'))
            self.assertIsNone(req.get_header('X-device'))
            self.assertEqual(urllib.parse.urlsplit(req.full_url).netloc, 'api.talabat.com')
            self.assertEqual(build.call_args.args[0].proxies, {})
            self.assertIsInstance(build.call_args.args[1], checkout.http.NoRedirect)
            response.read.assert_called_with(checkout.MAX_BYTES + 1)
            for body, error in [(b'x' * (checkout.MAX_BYTES + 1), 'RESPONSE_TOO_LARGE'),
                                (b'not json private', 'CHECKOUT_READ_FAILED'), (b'[]', 'SCHEMA_CHANGED')]:
                response.read.return_value = body
                with self.subTest(error=error), self.assertRaisesRegex(checkout.http.TalabatError, error):
                    checkout.get_json(self.saved, checkout.API, checkout.CARDS, {'countryId': 4}, time.monotonic() + 3)

    def test_http_errors_do_not_follow_redirect_retry_or_leak_body(self):
        for code, expected in [(302, 'HTTP_302'), (401, 'AUTH_EXPIRED'), (403, 'AUTH_FORBIDDEN'), (429, 'RATE_LIMITED')]:
            error = urllib.error.HTTPError('https://api.talabat.com/pay/v1/cards', code, 'private error', {}, io.BytesIO(b'private'))
            opener = MagicMock()
            opener.open.side_effect = error
            with self.subTest(code=code), patch.object(checkout.urllib.request, 'build_opener', return_value=opener):
                with self.assertRaisesRegex(checkout.http.TalabatError, expected) as ctx:
                    checkout.get_json(self.saved, checkout.API, checkout.CARDS, {'countryId': 4}, time.monotonic() + 3)
                self.assertNotIn('private', str(ctx.exception))
                self.assertEqual(opener.open.call_count, 1)

    def test_cli_sanitizes_unexpected_errors(self):
        with patch.object(checkout, 'readiness', side_effect=RuntimeError('private token')), \
                patch('sys.stdout', new_callable=io.StringIO) as out:
            self.assertEqual(checkout.main(['readiness', '--apk-pool', 'pool']), 1)
        self.assertNotIn('private', out.getvalue())
        self.assertFalse(json.loads(out.getvalue())['commit_enabled'])

    def test_route_rejects_wrong_vendor_locality_types_and_boundary(self):
        query = {'areaId': 1308, 'lat': 25.0778, 'lon': 55.1569}
        changes = [{'areaId': 1308.0}, {'areaId': 999}, {'lat': 25.06}, {'lat': 25.10},
                   {'lon': 55.14}, {'lon': 55.18}, {'lat': True}, {'lat': '25.0778'},
                   {'lat': float('nan')}, {'lon': float('inf')}]
        with patch.object(checkout.auth, 'native_headers') as headers, \
                patch.object(checkout.urllib.request, 'build_opener') as opener:
            for change in changes:
                with self.subTest(change=change), self.assertRaisesRegex(checkout.http.TalabatError, 'DENIED'):
                    checkout.get_json(self.saved, checkout.API, checkout.VENDOR,
                                      {**query, **change}, time.monotonic() + 3)
            headers.assert_not_called()
            opener.assert_not_called()
        checkout._route(checkout.API, checkout.VENDOR, query, None)

    def test_route_rejects_cart_identity_and_flag_coercions(self):
        query = {'branch_id': checkout.BRANCH, 'dh_vendor_id': 'synthetic', 'global_entity_id': 'TB_AE',
                 'chain_id': 99, 'lat': 25.0778, 'lon': 55.1569, 'campaign_progress_required': 'false',
                 'has_outstanding_payments': 'false'}
        changes = [{'branch_id': float(checkout.BRANCH)}, {'branch_id': 1}, {'dh_vendor_id': ''},
                   {'dh_vendor_id': 'bad\nheader'}, {'chain_id': True}, {'chain_id': 0},
                   {'global_entity_id': 'TB_KW'}, {'campaign_progress_required': False},
                   {'has_outstanding_payments': True}, {'lat': 25}, {'lon': 55}]
        for change in changes:
            with self.subTest(change=change), self.assertRaisesRegex(checkout.http.TalabatError, 'DENIED'):
                checkout._route(checkout.API, checkout.CART, {**query, **change}, 'synthetic-apikey')
        for key in ('short', 'x' * 17, 'x' * 15 + '\n', None):
            with self.subTest(key=key), self.assertRaisesRegex(checkout.http.TalabatError, 'DENIED'):
                checkout._route(checkout.API, checkout.CART, query, key)
        for bad_query in (None, [], {'countryId': 4.0}, {'countryId': '4'}):
            with self.subTest(query=bad_query), self.assertRaisesRegex(checkout.http.TalabatError, 'DENIED'):
                checkout._route(checkout.API, checkout.CARDS, bad_query, None)


def instructions():
    # Synthetic IDs, deliberately NOT Talabat wire values or mappings.
    return {'instructions': [
        {'id': 'synthetic-door', 'title': 'Fixture leave at door', 'isSelected': True, 'isEnabled': True},
        {'id': 'synthetic-bell', 'title': 'Fixture no bell', 'isSelected': True, 'isEnabled': True},
        {'id': 'synthetic-call', 'title': 'Fixture no call', 'isSelected': True, 'isEnabled': True},
        {'id': 'synthetic-extra', 'title': 'Fixture extra', 'isSelected': False, 'isEnabled': True},
    ], 'saveForLater': {'isPreSaved': False}, 'untrusted': 'https://example.invalid/action'}


def instruction_bindings():
    return {name: {'id': row['id'], 'title': row['title'], 'selected': True} for name, row in
             zip(('leave_at_door', 'no_bell', 'no_call'), instructions()['instructions'])}


def local_review(**changes):
    # A proposed LOCAL format; none of these bindings has been observed live.
    return {'schema_version': 1, 'branch_id': checkout.BRANCH,
            'bindings': {name: hashlib.sha256(('synthetic-' + name).encode()).hexdigest()
                         for name in checkout.REVIEW_BINDINGS},
            'currency': 'AED', 'payable_minor': 1234, 'observed_at': 1000, 'expires_at': 1100,
            **changes}


class OfflineSafetyTest(unittest.TestCase):
    def setUp(self):
        # Offline helpers must never become a sneaky capture, renewal or request path.
        for target, name in ((checkout.http, 'account'), (checkout.auth, 'refresh'),
                             (checkout.auth, 'write_store'), (checkout, 'get_json'),
                             (checkout.urllib.request, 'build_opener')):
            p = patch.object(target, name, side_effect=AssertionError('offline helper performed I/O'))
            p.start()
            self.addCleanup(p.stop)

    def test_instruction_parser_is_immutable_and_ignores_action_urls(self):
        source = instructions()
        result = checkout.instruction_choices(source)
        self.assertIsInstance(result, tuple)
        self.assertEqual(result[0].id, 'synthetic-door')
        with self.assertRaises(FrozenInstanceError):
            result[0].id = 'changed'
        source['instructions'][0]['id'] = 'changed'
        self.assertEqual(result[0].id, 'synthetic-door')
        self.assertNotIn('example.invalid', repr(result))

    def test_instruction_parser_requires_explicit_typed_flags_and_unique_ids(self):
        for field, values in {'isSelected': [None, 1, 'true'], 'isEnabled': [None, 0, 'false'],
                              'id': [None, '', 7, 'bad\nvalue', 'x' * 513, ' '],
                              'title': [None, '', True, ' '],}.items():
            for value in values:
                source = instructions()
                source['instructions'][0][field] = value
                with self.subTest(field=field, value=value), self.assertRaisesRegex(
                        checkout.http.TalabatError, 'SCHEMA_UNVERIFIED'):
                    checkout.instruction_choices(source)
        for field in ('id', 'title', 'isSelected', 'isEnabled'):
            source = instructions()
            del source['instructions'][0][field]
            with self.subTest(missing=field), self.assertRaises(checkout.http.TalabatError):
                checkout.instruction_choices(source)
        source = instructions()
        source['instructions'].append(source['instructions'][0])
        with self.assertRaisesRegex(checkout.http.TalabatError, 'SCHEMA_UNVERIFIED'):
            checkout.instruction_choices(source)

    def test_instruction_parser_does_not_guess_outer_quote_or_address_schema(self):
        for source in (None, [], {}, {'delivery_instructions': []}, {'instructions': []},
                       {'instructions': [None]}, {'instructions': instructions()['instructions'] * 20},
                       {'quote': instructions()}):
            with self.subTest(source=source), self.assertRaises(checkout.http.TalabatError):
                checkout.instruction_choices(source)

    def test_positive_quiet_controls_require_exact_state_and_notes(self):
        source = instructions()
        original = copy.deepcopy(source)
        self.assertEqual(checkout.quiet_instruction_ids(source, instruction_bindings(), note_readback=checkout.QUIET_NOTE),
                          ('synthetic-door', 'synthetic-bell', 'synthetic-call'))
        self.assertEqual(source, original)  # no selected/default/save-for-later mutation
        source['instructions'].reverse()
        self.assertEqual(checkout.quiet_instruction_ids(source, instruction_bindings(), note_readback=checkout.QUIET_NOTE),
                          ('synthetic-call', 'synthetic-bell', 'synthetic-door'))

    def test_observed_mart_controls_allow_unselected_call_and_no_door_toggle(self):
        # Parent-observed UI shape; synthetic IDs, NOT a recovered wire mapping.
        source = {'instructions': [
            {'id': 'fixture-call', 'title': 'Call on arrival', 'isSelected': False, 'isEnabled': True},
            {'id': 'fixture-bell', 'title': "Don't ring doorbell", 'isSelected': True, 'isEnabled': True},
            {'id': 'fixture-reception', 'title': 'Leave at reception', 'isSelected': False, 'isEnabled': False},
            {'id': 'fixture-ring', 'title': 'Ring doorbell', 'isSelected': False, 'isEnabled': False},
        ], 'saveForLater': {'isPreSaved': True}}
        bindings = {'leave_at_door': {'control_absent': True},
                    'no_bell': {'id': 'fixture-bell', 'title': "Don't ring doorbell", 'selected': True},
                    'no_call': {'id': 'fixture-call', 'title': 'Call on arrival', 'selected': False}}
        original = copy.deepcopy(source)
        self.assertEqual(checkout.quiet_instruction_ids(source, bindings, note_readback=checkout.QUIET_NOTE),
                         ('fixture-bell',))
        self.assertEqual(source, original)  # helper does not uncheck/save a default
        source['instructions'][0]['isSelected'] = True
        with self.assertRaisesRegex(checkout.http.TalabatError, 'READBACK_MISMATCH'):
            checkout.quiet_instruction_ids(source, bindings, note_readback=checkout.QUIET_NOTE)

    def test_absent_control_must_be_explicit_and_note_readback_complete(self):
        source = instructions()
        for row in source['instructions']:
            row['isSelected'] = False
        bindings = {key: {'control_absent': True} for key in checkout.QUIET_CHOICES}
        self.assertEqual(checkout.quiet_instruction_ids(source, bindings, note_readback=checkout.QUIET_NOTE), ())
        for note in (None, '', 'Leave at door', 'Please be quiet', True):
            with self.subTest(note=note), self.assertRaisesRegex(checkout.http.TalabatError, 'NOTE_READBACK'):
                checkout.quiet_instruction_ids(source, bindings, note_readback=note)
        for absent in (False, 1, 'true', None):
            changed = {**bindings, 'leave_at_door': {'control_absent': absent}}
            with self.subTest(absent=absent), self.assertRaisesRegex(checkout.http.TalabatError, 'BINDINGS_REQUIRED'):
                checkout.quiet_instruction_ids(source, changed, note_readback=checkout.QUIET_NOTE)

    def test_notes_alone_unknown_disabled_unselected_or_additional_choice_block(self):
        for change in ({'id': 'another-id'}, {'title': 'Changed localized label'},
                       {'isSelected': False}, {'isEnabled': False}):
            source = instructions()
            source['instructions'][0].update(change)
            source['notes'] = "Leave at door; don't ring bell; don't call"
            with self.subTest(change=change), self.assertRaisesRegex(
                    checkout.http.TalabatError, 'READBACK_MISMATCH'):
                checkout.quiet_instruction_ids(source, instruction_bindings(), note_readback=checkout.QUIET_NOTE)
        source = instructions()
        source['instructions'][3]['isSelected'] = True
        with self.assertRaisesRegex(checkout.http.TalabatError, 'READBACK_MISMATCH'):
            checkout.quiet_instruction_ids(source, instruction_bindings(), note_readback=checkout.QUIET_NOTE)

    def test_mapping_cannot_be_incomplete_duplicate_or_invented_from_notes(self):
        duplicate = instruction_bindings()
        duplicate['no_call'] = duplicate['no_bell']
        missing = instruction_bindings()
        del missing['no_call']
        malformed = instruction_bindings()
        malformed['no_call'] = {'id': 'synthetic-call'}
        coerced = instruction_bindings()
        coerced['no_call']['selected'] = 1
        for bindings in (None, {}, missing, duplicate, malformed, coerced,
                          {**instruction_bindings(), 'notes': 'please be quiet'}):
            with self.subTest(bindings=bindings), self.assertRaises(checkout.http.TalabatError):
                checkout.quiet_instruction_ids(instructions(), bindings, note_readback=checkout.QUIET_NOTE)

    def test_review_hash_is_canonical_detached_and_immutable(self):
        source = local_review()
        frozen = checkout.freeze_local_review(source, now=1001)
        reversed_source = dict(reversed(list(source.items())))
        reversed_source['bindings'] = dict(reversed(list(source['bindings'].items())))
        self.assertEqual(checkout.freeze_local_review(reversed_source, now=1002), frozen)
        self.assertEqual(len(frozen.digest), 64)
        self.assertNotIn('bindings', repr(frozen))
        with self.assertRaises(FrozenInstanceError):
            frozen.digest = 'changed'
        source['bindings']['items_sha256'] = '0' * 64
        self.assertNotEqual(checkout.freeze_local_review(source, now=1002).digest, frozen.digest)

    def test_review_no_unknown_raw_private_fields_or_missing_bindings(self):
        for raw_key in ('token', 'cardTokenId', 'address', 'items', 'headers', 'approved', 'one_shot'):
            source = local_review()
            source[raw_key] = 'private-canary'
            with self.subTest(raw_key=raw_key), self.assertRaises(checkout.http.TalabatError) as ctx:
                checkout.freeze_local_review(source, now=1001)
            self.assertNotIn('private-canary', str(ctx.exception))
        for key in checkout.REVIEW_BINDINGS:
            source = local_review()
            del source['bindings'][key]
            with self.subTest(missing=key), self.assertRaises(checkout.http.TalabatError):
                checkout.freeze_local_review(source, now=1001)
        for value in (None, False, 42, 'private-canary', 'a' * 63, 'A' * 64):
            source = local_review()
            source['bindings']['payment_sha256'] = value
            with self.subTest(value=value), self.assertRaises(checkout.http.TalabatError) as ctx:
                checkout.freeze_local_review(source, now=1001)
            self.assertNotIn('private-canary', str(ctx.exception))

    def test_review_money_currency_branch_and_time_strict_types(self):
        changes = [{'schema_version': True}, {'branch_id': float(checkout.BRANCH)},
                   {'branch_id': 1}, {'currency': 'USD'}, {'currency': 'aed'},
                   {'payable_minor': True}, {'payable_minor': 12.34}, {'payable_minor': '1234'},
                   {'payable_minor': 0}, {'payable_minor': -1}, {'payable_minor': 10**9},
                   {'observed_at': 1002}, {'observed_at': True}, {'observed_at': 0},
                   {'expires_at': 1001}, {'expires_at': 1001.5}, {'expires_at': 2**63}]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(checkout.http.TalabatError):
                checkout.freeze_local_review(local_review(**change), now=1001)
        for now in (True, 0, -1, 1001.0, '1001', 999, 1100, 1101):
            with self.subTest(now=now), self.assertRaises(checkout.http.TalabatError):
                checkout.freeze_local_review(local_review(), now=now)

    def test_review_rechecks_expiry_and_explicit_digest_without_granting_permission(self):
        current = local_review()
        frozen = checkout.freeze_local_review(current, now=1001)
        self.assertEqual(checkout.require_same_local_review(frozen, current, frozen.digest, now=1002), frozen)
        for digest in (None, '', '0' * 64, frozen.digest.upper()):
            with self.subTest(digest=digest), self.assertRaises(checkout.http.TalabatError):
                checkout.require_same_local_review(frozen, current, digest, now=1002)
        with self.assertRaisesRegex(checkout.http.TalabatError, 'EXPIRED'):
            checkout.require_same_local_review(frozen, current, frozen.digest, now=1100)

    def test_every_review_component_change_invalidates_original_digest(self):
        initial = local_review()
        frozen = checkout.freeze_local_review(initial, now=1001)
        for key in checkout.REVIEW_BINDINGS:
            changed = copy.deepcopy(initial)
            changed['bindings'][key] = '0' * 64
            with self.subTest(binding=key), self.assertRaisesRegex(checkout.http.TalabatError, 'CHANGED'):
                checkout.require_same_local_review(frozen, changed, frozen.digest, now=1002)
        for change in ({'payable_minor': 1235}, {'observed_at': 1001}, {'expires_at': 1101}):
            with self.subTest(change=change), self.assertRaisesRegex(checkout.http.TalabatError, 'CHANGED'):
                checkout.require_same_local_review(frozen, {**initial, **change}, frozen.digest, now=1002)

    def test_manually_constructed_fingerprint_does_not_skip_revalidation(self):
        current = local_review()
        frozen = checkout.freeze_local_review(current, now=1001)
        for changed in (None, replace(frozen, digest=None), replace(frozen, expires_at=9999),
                        replace(frozen, _canonical=b'changed')):
            with self.subTest(changed=changed), self.assertRaises(checkout.http.TalabatError):
                checkout.require_same_local_review(changed, current, frozen.digest, now=1002)

    def test_valid_synthetic_review_cannot_unlock_any_mutation(self):
        frozen = checkout.freeze_local_review(local_review(), now=1001)
        for operation in (checkout.prepare_quote, checkout.replace_cart, checkout.commit, checkout.cancel_order):
            with self.subTest(operation=operation.__name__), self.assertRaisesRegex(
                    checkout.http.TalabatError, 'DISABLED'):
                operation(review=frozen, quote_digest=frozen.digest, approved=True,
                          one_shot_authorization='synthetic', observed_contract=True)


class PublicConstantTest(unittest.TestCase):
    def test_exact_production_pool_offset_not_other_constants(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'public-pool.txt'
            path.write_text('[pp+0x7b80] String: "wrongdebugvalue1"\n'
                            '[pp+0x7c80] String: "0123456789abcdef"\n')
            self.assertEqual(checkout.verticals_key(path), '0123456789abcdef')
            path.write_text('[pp+0x7b80] String: "wrongdebugvalue1"\n')
            with self.assertRaisesRegex(checkout.http.TalabatError, 'UNAVAILABLE'):
                checkout.verticals_key(path)


if __name__ == '__main__':
    unittest.main()
