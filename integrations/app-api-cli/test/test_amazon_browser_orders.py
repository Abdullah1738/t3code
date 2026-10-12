"""Synthetic sanitized DOM projections only; no production account fixtures."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import socket
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import amazon_browser_orders as a

OID = '123-1234567-1234567'
OTHER = '123-7654321-7654321'
OBSERVED = '2026-10-08T12:00:00+04:00'
KEY = hashlib.sha256(b'amazon.ae|synthetic-order|synthetic-shipment|0').hexdigest()


def shipment(status='Delivered 6 October', quantity='', asin='B000000001', key=KEY):
    return {'status_texts': [status], 'items': [{'asin': asin, 'quantity_text': quantity}],
            'shipment_keys': [key] if key else []}


def order(oid=OID, shipments=None):
    return {'id_text': 'ORDER # ' + oid, 'placed_text': 'ORDER PLACED\n6 October 2026',
            'total_text': 'TOTAL\nAED\u00a01,234.50', 'unsupported_layout': False,
            'shipments': shipments if shipments is not None else [shipment()]}


def snapshot(orders=None, **kwargs):
    rows = orders if orders is not None else [order()]
    result = {'schema': a.SCHEMA, 'origin': 'https://www.amazon.ae',
              'path': '/gp/your-account/order-history', 'lang': 'en-ae',
              'ready': True, 'challenge': False, 'kind': 'history', 'orders': rows,
              'observed_order_cards': len(rows), 'advertised_count_text': '48 orders placed in',
              'next_page_present': True, 'truncated': False}
    result.update(kwargs)
    return result


def parse(s=None, **kwargs):
    return a.parse_snapshot(s if s is not None else snapshot(),
                            profile_name=kwargs.pop('profile_name', 'Personal'),
                            observed_at=kwargs.pop('observed_at', OBSERVED), **kwargs)


def dia(s=None):
    s = s if s is not None else snapshot()
    return {'profileName': 'Personal', 'diaTabId': 'fixture-tab',
            'target': {'id': 'fixture-target', 'type': 'page',
                       'url': 'https://www.amazon.ae/gp/your-account/order-history'},
            'result': {'result': {'type': 'object', 'value': s}}}


def parse_dia(value):
    return a.parse_dia_result(value, tab_id='fixture-tab', target_id='fixture-target', observed_at=OBSERVED)


class ProjectionParserTests(unittest.TestCase):
    def test_observed_uae_history_shape_date_aed_and_null_quantity(self):
        result = parse()
        row = result['orders'][0]
        self.assertEqual(row['placed_date'], '2026-10-06')
        self.assertEqual(row['total'], {'currency': 'AED', 'amount': '1234.50'})
        self.assertEqual(row['visible_stage'], 'delivered')
        self.assertIsNone(row['shipments'][0]['items'][0]['quantity'])
        self.assertFalse(row['whole_order_delivered'])
        self.assertFalse(row['terminal'])
        self.assertFalse(row['manifest_complete'])

    def test_partial_page_coverage_not_all_48_orders(self):
        result = parse()
        c = result['coverage']
        self.assertEqual((c['parsed_cards'], c['advertised_orders_in_filter']), (1, 48))
        self.assertTrue(c['next_page_present'])
        self.assertFalse(c['scan_complete'])
        self.assertFalse(c['whole_history_complete'])

    def test_last_page_does_not_establish_whole_history_or_manifest(self):
        result = parse(snapshot(next_page_present=False, advertised_count_text='1 order placed in'))
        self.assertFalse(result['coverage']['scan_complete'])
        self.assertFalse(result['orders'][0]['whole_order_delivered'])

    def test_all_delivered_known_quantities_still_not_terminal(self):
        row = order(shipments=[shipment(quantity='2'), shipment(quantity='Qty: 1')])
        result = parse(snapshot([row]))['orders'][0]
        self.assertEqual(result['visible_stage'], 'delivered')
        self.assertFalse(result['whole_order_delivered'])
        self.assertFalse(result['terminal'])
        self.assertTrue(all(not s['manifest_complete'] for s in result['shipments']))

    def test_mixed_shipments_do_not_collapse_to_delivered(self):
        result = parse(snapshot([order(shipments=[shipment(), shipment('Out for delivery')])]))
        self.assertEqual(result['orders'][0]['visible_stage'], 'unknown')
        self.assertEqual([s['stage'] for s in result['orders'][0]['shipments']], ['delivered', 'out for delivery'])

    def test_cancelled_card_has_no_total(self):
        row = order(shipments=[shipment('Cancelled')])
        row['total_text'] = ''
        result = parse(snapshot([row]))['orders'][0]
        self.assertEqual(result['visible_stage'], 'cancelled')
        self.assertIsNone(result['total'])
        self.assertFalse(result['terminal'])

    def test_returns_refunds_not_delivery(self):
        for status, stage in [('Return started', 'return_requested'), ('Return requested', 'return_requested'),
                              ('Return received', 'returned'), ('Refund issued', 'refunded')]:
            with self.subTest(status=status):
                self.assertEqual(a.classify_status(status, observed_at=OBSERVED), stage)

    def test_primary_progress_states(self):
        for status, stage in [('Dispatched', 'shipped'), ('Shipped', 'shipped'),
                              ('Out for delivery', 'out for delivery'), ('Delivered today', 'delivered'),
                              ('Delivered yesterday', 'delivered'), ('Delivered 6 October 2026', 'delivered')]:
            self.assertEqual(a.classify_status(status, observed_at=OBSERVED), stage)

    def test_future_negated_hypothetical_and_progress_rail_not_delivery(self):
        for text in ['Not delivered', 'Your package will be delivered', 'Delivered 9 October',
                     'Delivered 9 October 2026', 'Delivered 31 February 2026',
                     'Expected to be delivered today', 'Delivered to recipient',
                     'Ordered Shipped Out for delivery Delivered', 'If delivered',
                     'Return started Delivered', 'Cancellation requested', 'Cancel order',
                     'Shipped: buy this item']:
            with self.subTest(text=text):
                self.assertEqual(a.classify_status(text, observed_at=OBSERVED), 'unknown')

    def test_yearless_delivery_near_year_boundary_is_conservative(self):
        self.assertEqual(a.classify_status('Delivered 31 December', observed_at='2027-01-01T10:00:00+04:00'), 'unknown')

    def test_observed_uae_delivered_on_date_with_time(self):
        self.assertEqual(a.classify_status('Delivered on 6 October at 8:38 AM', observed_at=OBSERVED), 'delivered')
        for text in ['Delivered on 6 October at 25:38 AM', 'Delivered on 6 October at 8:99 AM',
                     'Delivered on 9 October at 8:38 AM', 'Delivered on 6 October at 8:38 AM to my home']:
            self.assertEqual(a.classify_status(text, observed_at=OBSERVED), 'unknown')

    def test_live_shape_reconstruction_ten_cards_without_account_data(self):
        # Structure and status patterns only. All identities, prices/dates are synthetic.
        statuses = ['Return started', 'Delivered 6 October', 'Cancelled', 'Cancelled',
                    'Arriving Monday', 'Delivered on 6 October at 8:38 AM', 'Delivered today',
                    'Return started', 'Delivered 7 October', 'Amazon Now delivery']
        rows = [order('123-1234567-' + str(1000000 + i), [shipment(status)])
                for i, status in enumerate(statuses)]
        rows[2]['total_text'] = rows[3]['total_text'] = ''
        rows[-1]['unsupported_layout'] = True
        rows[-1]['shipments'][0]['items'][0]['asin'] = None
        result = parse(snapshot(rows))
        self.assertEqual(result['coverage']['parsed_cards'], 10)
        self.assertEqual([x['visible_stage'] for x in result['orders']],
                         ['return_requested', 'delivered', 'cancelled', 'cancelled', 'unknown',
                          'delivered', 'delivered', 'return_requested', 'delivered', 'unknown'])
        self.assertFalse(any(x['whole_order_delivered'] or x['terminal'] for x in result['orders']))

    def test_dubai_date_and_no_invented_delivery_timestamp(self):
        self.assertEqual(a.classify_status('Delivered 9 October', observed_at='2026-10-08T21:00:00Z'), 'delivered')
        result = parse()['orders'][0]['shipments'][0]
        self.assertIsNone(result['evidence_at'])
        self.assertEqual(result['observed_at'], OBSERVED)

    def test_nested_equal_primary_text_dedupes_conflicts_fail_closed(self):
        row = order()
        row['shipments'][0]['status_texts'] *= 2
        self.assertEqual(parse(snapshot([row]))['orders'][0]['visible_stage'], 'delivered')
        row['shipments'][0]['status_texts'].append('Return started')
        result = parse(snapshot([row]))['orders'][0]
        self.assertEqual(result['visible_stage'], 'unknown')
        self.assertIn('missing_or_conflicting_primary_status', result['shipments'][0]['warnings'])

    def test_missing_primary_text_is_not_delivered(self):
        row = order()
        row['shipments'][0]['status_texts'] = []
        self.assertEqual(parse(snapshot([row]))['orders'][0]['visible_stage'], 'unknown')

    def test_detail_shape_supported_but_still_partial(self):
        result = parse(snapshot(kind='details', path='/your-orders/order-details',
                                advertised_count_text='', next_page_present=False))
        self.assertEqual(result['page_kind'], 'details')
        self.assertFalse(result['orders'][0]['whole_order_delivered'])

    def test_package_page_unsupported_even_combined_orders_heading(self):
        with self.assertRaisesRegex(a.BrowserOrdersError, 'UNSUPPORTED_PAGE'):
            parse(snapshot(kind='tracking', path='/progress-tracker/package'))

    def test_exact_order_filter_and_not_found_are_explicit(self):
        result = parse(snapshot([order(), order(OTHER)]), expected_order_id=OTHER)
        self.assertEqual([x['order_id'] for x in result['orders']], [OTHER])
        self.assertEqual(result['coverage']['parsed_cards'], 2)
        with self.assertRaisesRegex(a.BrowserOrdersError, 'ORDER_NOT_ON_THIS_PAGE'):
            parse(expected_order_id=OTHER)

    def test_id_prefix_suffix_and_empty_or_encrypted_cards_not_matched(self):
        for value in [OID + '1', 'x' + OID, OID + '-x', 'ORDER # encrypted', '', OID.replace('1', '\u0661')]:
            row = order()
            row['id_text'] = value
            self.assertEqual(parse(snapshot([row]))['coverage']['invalid_cards'], 1)
        for value in [OID + '1', 'x' + OID, OID + '-x', '']:
            with self.assertRaisesRegex(a.BrowserOrdersError, 'INVALID_ORDER_ID'):
                parse(expected_order_id=value)

    def test_duplicate_order_ids_not_silently_merged(self):
        with self.assertRaisesRegex(a.BrowserOrdersError, 'DUPLICATE_ORDER_ID'):
            parse(snapshot([order(), order()]))

    def test_quantities_only_explicit_positive_integers(self):
        for qty, expected in [('', None), ('Qty: 2', 2), ('Quantity: 3', 3), ('2', 2),
                              ('0', None), ('-1', None), ('1.5', None), ('2 items', None),
                              ('2 of 3', None), ('1,000', None)]:
            result = parse(snapshot([order(shipments=[shipment(quantity=qty)])]))
            self.assertEqual(result['orders'][0]['shipments'][0]['items'][0]['quantity'], expected)

    def test_missing_identity_ambiguous_shipment_and_unknown_layout_warn(self):
        row = order(shipments=[shipment(asin=None, key=None)])
        row['unsupported_layout'] = True
        result = parse(snapshot([row]))['orders'][0]
        self.assertIn('unsupported_item_layout', result['warnings'])
        self.assertIn('missing_or_ambiguous_shipment_identity', result['shipments'][0]['warnings'])
        self.assertIsNone(result['shipments'][0]['shipment_key'])
        row['shipments'][0]['shipment_keys'] = [KEY, '0' * 64]
        self.assertIsNone(parse(snapshot([row]))['orders'][0]['shipments'][0]['shipment_key'])

    def test_invalid_money_or_date_remains_unknown(self):
        for money in ['AED 1,23.45', 'USD 10.00', 'AED 12', 'AED 1.00 AED 2.00', 'TOTAL AED -1.00']:
            row = order()
            row.update(total_text=money, placed_text='ORDER PLACED 31 February 2026')
            result = parse(snapshot([row]))['orders'][0]
            self.assertIsNone(result['total'])
            self.assertIsNone(result['placed_date'])

    def test_truncation_reported_not_complete(self):
        result = parse(snapshot(truncated=True, observed_order_cards=110))
        self.assertTrue(result['coverage']['truncated'])
        self.assertFalse(result['coverage']['scan_complete'])
        with self.assertRaisesRegex(a.BrowserOrdersError, 'INVALID_SNAPSHOT'):
            parse(snapshot(observed_order_cards=2))

    def test_unrecognized_projection_fields_never_echoed(self):
        s = snapshot()
        s['cookies'] = 'synthetic-private-value'
        s['orders'][0]['address'] = 'synthetic-address'
        s['orders'][0]['shipments'][0]['items'][0]['title'] = 'synthetic-title'
        result = json.dumps(parse(s))
        for value in ['synthetic-private-value', 'synthetic-address', 'synthetic-title']:
            self.assertNotIn(value, result)

    def test_no_email_override_or_watcher_ownership(self):
        result = parse()
        self.assertEqual(result['source'], 'amazon_browser_dom')
        self.assertEqual(result['fallback'], 'amazon_email_orders')
        self.assertFalse(result['tracker_integration_enabled'])


class TransportTests(unittest.TestCase):
    def test_bound_supported_dia_response(self):
        self.assertEqual(parse_dia(dia())['orders'][0]['order_id'], OID)

    def test_actual_bridge_targetid_and_optional_merged_id(self):
        response = dia()
        response['target']['targetId'] = response['target'].pop('id')
        self.assertEqual(parse_dia(response)['orders'][0]['order_id'], OID)
        response['target']['id'] = response['target']['targetId']
        self.assertEqual(parse_dia(response)['orders'][0]['order_id'], OID)
        response['target']['id'] = 'conflicting-id'
        with self.assertRaisesRegex(a.BrowserOrdersError, 'DIA_BINDING_MISMATCH'):
            parse_dia(response)

    def test_wrong_profile_tab_or_target_rejected(self):
        for field, value in [('profileName', 'Equicom'), ('diaTabId', 'other-tab')]:
            response = dia()
            response[field] = value
            with self.assertRaisesRegex(a.BrowserOrdersError, 'DIA_BINDING_MISMATCH'):
                parse_dia(response)
        response = dia()
        response['target']['id'] = 'other-target'
        with self.assertRaisesRegex(a.BrowserOrdersError, 'DIA_BINDING_MISMATCH'):
            parse_dia(response)

    def test_evaluation_exception_is_safe_not_content(self):
        response = dia()
        response['result']['exceptionDetails'] = {'text': 'synthetic-private-value'}
        with self.assertRaisesRegex(a.BrowserOrdersError, '^DIA_EVALUATION_FAILED$'):
            parse_dia(response)

    def test_location_race_and_spoofed_hosts_rejected(self):
        for url in ['https://www.amazon.ae.evil.invalid/gp/your-account/order-history',
                    'https://www.amazon.ae/gp/cart/view.html',
                    'http://www.amazon.ae/gp/your-account/order-history',
                    'https://u:p@www.amazon.ae/gp/your-account/order-history',
                    'https://www.amazon.ae:444/gp/your-account/order-history']:
            response = dia()
            response['target']['url'] = url
            with self.assertRaisesRegex(a.BrowserOrdersError, 'DIA_LOCATION_MISMATCH'):
                parse_dia(response)

    def test_auth_challenge_requires_owner_and_unknown_errors_redacted(self):
        for code in ['AUTH_OR_CHALLENGE_REQUIRED', 'PAGE_NOT_READY', 'NO_SUPPORTED_ORDER_CARDS']:
            with self.assertRaisesRegex(a.BrowserOrdersError, '^' + code + '$'):
                parse_dia(dia({'schema': a.SCHEMA, 'error': code}))
        with self.assertRaisesRegex(a.BrowserOrdersError, '^INVALID_SNAPSHOT$'):
            parse({'schema': a.SCHEMA, 'error': 'synthetic-private-value'})

    def test_only_exact_uae_origin_personal_profile_and_english(self):
        for origin in ['https://amazon.com', 'https://fakeamazon.ae', 'https://www.amazon.ae.evil.invalid',
                       'http://www.amazon.ae', 'https://www.amazon.ae:443']:
            with self.assertRaisesRegex(a.BrowserOrdersError, 'UNSUPPORTED_ORIGIN'):
                parse(snapshot(origin=origin))
        with self.assertRaisesRegex(a.BrowserOrdersError, 'PERSONAL_PROFILE_REQUIRED'):
            parse(profile_name='BTZO')
        with self.assertRaisesRegex(a.BrowserOrdersError, 'UNSUPPORTED_LANGUAGE'):
            parse(snapshot(lang='ar-ae'))

    def test_nonorder_or_mutation_paths_rejected(self):
        for path in ['/gp/cart/view.html', '/ap/signin', '/your-orders/order-details/cancel',
                     '/progress-tracker/package/preship/cancel-items', '/gp/your-account/order-history?secret=x']:
            with self.assertRaisesRegex(a.BrowserOrdersError, 'UNSUPPORTED_PAGE'):
                parse(snapshot(path=path))
        self.assertEqual(parse(snapshot(path='/your-orders/orders/ref=fixture'))['page_kind'], 'history')

    def test_unknown_challenge_readiness_schema_and_empty_page_rejected(self):
        for changes, error in [({'ready': False}, 'PAGE_NOT_READY'),
                               ({'challenge': None}, 'AUTH_OR_CHALLENGE_REQUIRED'),
                               ({'schema': 'future'}, 'UNSUPPORTED_SCHEMA'),
                               ({'orders': [], 'observed_order_cards': 0}, 'NO_SUPPORTED_ORDER_CARDS')]:
            with self.assertRaisesRegex(a.BrowserOrdersError, error):
                parse(snapshot(**changes))

    def test_observation_timezone_required(self):
        for value in [None, '', '2026-10-08T12:00:00', '2026-99-99T00:00:00Z']:
            with self.assertRaisesRegex(a.BrowserOrdersError, 'TIMEZONE_AWARE_OBSERVATION_REQUIRED'):
                parse(observed_at=value)

    def test_bounds_and_invalid_identity_fail_without_echo(self):
        values = [snapshot(orders=[order()] * 101), snapshot(advertised_count_text='x' * 513),
                  snapshot(orders='synthetic-private-value'), snapshot(truncated='false')]
        bad_key, bad_asin = snapshot(), snapshot()
        bad_key['orders'][0]['shipments'][0]['shipment_keys'] = ['raw-private-shipment-id']
        bad_asin['orders'][0]['shipments'][0]['items'][0]['asin'] = 'http://example.invalid/private'
        values.extend([bad_key, bad_asin])
        for s in values:
            with self.assertRaisesRegex(a.BrowserOrdersError, '^INVALID_SNAPSHOT$'):
                parse(s)

    def test_parser_no_network_subprocess_or_input_mutation(self):
        value = snapshot()
        before = deepcopy(value)
        with patch.object(socket.socket, 'connect', side_effect=AssertionError('network forbidden')), \
                patch.object(socket, 'create_connection', side_effect=AssertionError('network forbidden')), \
                patch.object(subprocess, 'Popen', side_effect=AssertionError('process forbidden')):
            result = parse(value)
            parse_dia(dia())
        self.assertEqual(value, before)
        self.assertEqual(result['orders'][0]['order_id'], OID)

    def test_extractor_has_no_credentials_requests_clicks_or_page_dumps(self):
        for forbidden in ['document.cookie', 'localStorage', 'sessionStorage', 'fetch(',
                          'XMLHttpRequest', '.click(', '.submit(', 'outerHTML', 'innerHTML',
                          'location.href =', 'location.assign', '.value']:
            self.assertNotIn(forbidden, a.DIA_EXTRACTOR)
        self.assertIn('h4.od-status-message', a.DIA_EXTRACTOR)
        self.assertIn('crypto.subtle.digest', a.DIA_EXTRACTOR)
        self.assertIn('UNSUPPORTED_LANGUAGE', a.DIA_EXTRACTOR)


if __name__ == '__main__':
    unittest.main()
