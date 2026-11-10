"""Sanitized live shapes plus mocked transport; never access account data."""
import datetime as dt
import http.client
import json
from pathlib import Path
import signal
import sys
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import noon_http_orders as n

# Projected from live 2026-10-08 14:03/14:09 UTC. No addresses, account IDs,
# card/tip metadata, phone numbers, rider names, cookies or headers retained.
MINUTES_ID = 'IAEGA8148M1PBI5LTA'
MARKET_ID = 'NAEIA0002358740'
SHIPMENT_ID = MARKET_ID + '-S1'
MINUTES_PICKED_UP = {
    'csHelpLabels': {'orderNumber': MINUTES_ID}, 'status': 'picked_up',
    'title': 'Out for delivery', 'estimate': None,
    'etaMsgConfig': {'deliveryTime': 7, 'tagText': None, 'tagStatus': 'default'},
    'rider': {'showRiderDetails': True},
}
MINUTES_NEARBY = {**MINUTES_PICKED_UP, 'status': 'arrived_at_delivery', 'title': 'Our rider is nearby'}
MINUTES_DELIVERED = {'csHelpLabels': {'orderNumber': MINUTES_ID}, 'status': 'delivered',
                     'title': 'Woah! That was quick!', 'rider': {'showRiderDetails': False}}
MINUTES_PAGE = {'orders': [{'orderNr': MINUTES_ID, 'statusCode': 'picked_up',
                          'placedAt': '2026-10-08T17:58:35',
                          'estimatedDeliveryText': 'Arrives between:<br><b>06:11 - 06:16 PM</b>'}],
                'totalPages': 21, 'totalOrders': 200}
MARKET_ACTIVE = {'data': [{'orderNr': MARKET_ID, 'shipmentNr': SHIPMENT_ID,
                         'level': 'rocket_shipment', 'itemCount': 1,
                         'items': [{'itemNr': MARKET_ID + '-1', 'quantity': 1}],
                         'status': {'highStatusCode': 'out_for_delivery'},
                         'delivery': {'message': 'Arriving 5 Mins'}}]}
SHIPMENT_NEARBY = {
    'orderNr': MARKET_ID, 'shipmentNr': SHIPMENT_ID,
    'deliveryMessage': 'Arrived at your location',
    'timeline': [
        {'key': 'confirmed', 'text': 'Confirmed', 'status': None},
        {'key': 'packed', 'text': 'Packed', 'status': None},
        {'key': 'out_for_delivery', 'status': {'highStatusCode': 'out_for_delivery',
                                             'subStatusCode': 'out_for_delivery_arrive_rocket'}},
        {'key': 'delivered', 'text': 'Delivered', 'status': None},
    ],
}
MARKET_DELIVERED_HISTORY = {'data': [{'orderNr': MARKET_ID, 'shipmentNr': SHIPMENT_ID,
    'itemNr': MARKET_ID + '-1', 'status': {'highStatusCode': 'delivered'}}]}
ITEM_DELIVERED = {'orderNr': MARKET_ID, 'itemNr': MARKET_ID + '-1',
    'item': {'itemNr': MARKET_ID + '-1', 'shipmentNr': SHIPMENT_ID},
    'timeline': [{'key': 'delivered', 'text': 'Delivered', 'status': {'highStatusCode': 'delivered',
                  'subStatusCode': 'delivered_rocket'}}], 'deliveryMessage': 'today, 06:10 PM'}


class NoonHttpTest(unittest.TestCase):
    def test_minutes_live_preparing_status_is_confirmed_tracking(self):
        # Exact paid multi-item order readback, 2026-10-11: native preparing
        # accompanies "Packing your order" (not ready_for_pickup yet).
        result, _ = self.track_routes(MINUTES_ID, {
            'minutes_track': {
                'csHelpLabels': {'orderNumber': MINUTES_ID},
                'status': 'preparing', 'title': 'Packing your order',
                'rider': {'showRiderDetails': False}},
            'minutes_list': MINUTES_PAGE})
        self.assertEqual(result['status'], 'preparing')
        self.assertEqual(result['raw_status'], 'preparing')
        self.assertTrue(result['identity_verified'])

    def test_successful_shipment_detail_keeps_card_membership(self):
        result, _ = self.track_routes(MARKET_ID, {
            'marketplace_active': MARKET_ACTIVE, 'marketplace_history': {'data': []},
            'marketplace_shipment': SHIPMENT_NEARBY})
        self.assertEqual(result['shipments'][0].get('item_ids'), [MARKET_ID + '-1'])
        self.assertIsNot(result['shipments'][0]['item_ids'], result['items'][0]['item_ids'])

    def test_current_timeline_conflicts_keep_explicit_veto(self):
        for data, project, identity in [(SHIPMENT_NEARBY, n.shipment_track, SHIPMENT_ID),
                                        (ITEM_DELIVERED, n.item_track, MARKET_ID + '-1')]:
            conflict = {**data, 'timeline': [{'status': {'highStatusCode': raw}}
                                           for raw in ('delivered', 'cancelled')]}
            result = project(conflict, MARKET_ID, identity)
            self.assertEqual(result['status'], 'unknown')
            self.assertIn('timeline_status_conflict', result.get('warnings', []))

    def test_inherited_expired_deadline_stops_before_session(self):
        with patch.object(n.time, 'monotonic', return_value=9), \
                patch.object(n, 'verified_session') as session:
            with self.assertRaisesRegex(n.NoonError, 'NATIVE_READ_TIMEOUT'):
                n.track(MARKET_ID, timeout=8, deadline=8)
            session.assert_not_called()

    def test_inherited_deadline_rejects_late_detail_keeps_completed_card(self):
        clock = [7]
        def respond(route, *_args, **_kwargs):
            if route == 'marketplace_active':
                return MARKET_ACTIVE
            if route == 'marketplace_history':
                return {'data': []}
            clock[0] = 9
            return {**SHIPMENT_NEARBY, 'timeline': [{'status': {'highStatusCode': 'delivered'}}]}
        with patch.object(n.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(n, 'verified_session', return_value={}), \
                patch.object(n, 'request', side_effect=respond) as request:
            result = n.track(MARKET_ID, timeout=8, deadline=8)
        self.assertEqual(result['shipments'][0]['status'], 'out for delivery')
        self.assertTrue(result['partial'])
        self.assertTrue(all(call.args[2] == 8 for call in request.call_args_list))
        self.assertEqual(result['read_coverage']['failed'],
                         {'marketplace_shipment:' + SHIPMENT_ID: 'NATIVE_READ_TIMEOUT'})

    def track_routes(self, order, routes):
        """Route-keyed mocks keep active/history/detail sequencing explicit."""
        def respond(route, *_args, **_kwargs):
            value = routes[route]
            if isinstance(value, Exception):
                raise value
            return value
        with patch.object(n, 'verified_session', return_value={}), \
                patch.object(n, 'request', side_effect=respond) as request:
            result = n.track(order)
        return result, [c.args[0] for c in request.call_args_list]

    def test_active_and_history_merge_keeps_delivered_sibling(self):
        sid = MARKET_ID + '-S2'
        active = {'data': [{**MARKET_ACTIVE['data'][0], 'shipmentNr': sid,
                            'items': [{'itemNr': MARKET_ID + '-2'}]}]}
        result, calls = self.track_routes(MARKET_ID, {
            'marketplace_active': active, 'marketplace_history': MARKET_DELIVERED_HISTORY,
            'marketplace_shipment': {**SHIPMENT_NEARBY, 'shipmentNr': sid},
            'marketplace_item': ITEM_DELIVERED})
        self.assertIn('marketplace_history', calls)
        self.assertEqual({s['shipment_id']: s['status'] for s in result['shipments']},
                         {sid: 'out for delivery', SHIPMENT_ID: 'delivered'})
        self.assertEqual(len(result['items']), 2)
        self.assertEqual(result['status'], 'out for delivery')
        self.assertFalse(result['whole_order_complete'])

    def test_minutes_eta_timeout_preserves_completed_primary(self):
        clock = [0]
        def respond(route, *_args, **_kwargs):
            if route == 'minutes_track':
                return MINUTES_PICKED_UP
            clock[0] = 11
            raise n.NoonError('NATIVE_READ_TIMEOUT')
        with patch.object(n.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(n, 'verified_session', return_value={}), \
                patch.object(n, 'request', side_effect=respond):
            result = n.track(MINUTES_ID, timeout=10)
        self.assertEqual(result['status'], 'out for delivery')
        self.assertIsNone(result['eta'])
        self.assertTrue(result['partial'])
        self.assertIn('eta_enrichment_native_read_timeout', result['warnings'])
        self.assertIn('minutes_track', result['read_coverage']['completed'])

    def test_minutes_late_eta_response_is_not_accepted(self):
        clock = [0]
        def respond(route, *_args, **_kwargs):
            if route == 'minutes_track':
                return MINUTES_PICKED_UP
            clock[0] = 11
            return MINUTES_PAGE
        with patch.object(n.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(n, 'verified_session', return_value={}), \
                patch.object(n, 'request', side_effect=respond):
            result = n.track(MINUTES_ID, timeout=10)
        self.assertEqual(result['status'], 'out for delivery')
        self.assertIsNone(result['eta'])
        self.assertIsNone(result['eta_text'])
        self.assertEqual(result['read_coverage']['failed']['minutes_list'], 'NATIVE_READ_TIMEOUT')

    def test_primary_response_after_deadline_still_fails_closed(self):
        clock = [0]
        def respond(*_args, **_kwargs):
            clock[0] = 11
            return MINUTES_DELIVERED
        with patch.object(n.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(n, 'verified_session', return_value={}), \
                patch.object(n, 'request', side_effect=respond):
            with self.assertRaisesRegex(n.NoonError, 'NATIVE_READ_TIMEOUT'):
                n.track(MINUTES_ID, timeout=10)

    def test_history_failure_preserves_active_card_and_detail(self):
        result, _ = self.track_routes(MARKET_ID, {
            'marketplace_active': MARKET_ACTIVE,
            'marketplace_history': n.NoonError('HTTP_503'),
            'marketplace_shipment': SHIPMENT_NEARBY})
        self.assertEqual(result['status'], 'out for delivery')
        self.assertEqual(len(result['shipments']), 1)
        self.assertTrue(result['partial'])
        self.assertIn('marketplace_history_http_503', result['warnings'])

    def test_active_failure_preserves_independent_history(self):
        result, _ = self.track_routes(MARKET_ID, {
            'marketplace_active': n.NoonError('HTTP_503'),
            'marketplace_history': MARKET_DELIVERED_HISTORY, 'marketplace_item': ITEM_DELIVERED})
        self.assertEqual(result['shipments'][0]['status'], 'delivered')
        self.assertEqual(result['status'], 'unknown')
        self.assertTrue(result['partial'])
        self.assertFalse(result['whole_order_complete'])

    def test_later_detail_failure_keeps_completed_detail_and_cards(self):
        sid = MARKET_ID + '-S2'
        active = {'data': [MARKET_ACTIVE['data'][0], {**MARKET_ACTIVE['data'][0],
                         'shipmentNr': sid, 'items': [{'itemNr': MARKET_ID + '-2'}]}]}
        delivered = {**SHIPMENT_NEARBY, 'timeline': [{'status': {'highStatusCode': 'delivered'}}]}
        def respond(route, *_args, **kwargs):
            if route == 'marketplace_active':
                return active
            if route == 'marketplace_history':
                return {'data': []}
            if kwargs['shipment'] == SHIPMENT_ID:
                return delivered
            raise n.NoonError('HTTP_503')
        with patch.object(n, 'verified_session', return_value={}), patch.object(n, 'request', side_effect=respond):
            result = n.track(MARKET_ID)
        self.assertEqual([s['status'] for s in result['shipments']], ['delivered', 'out for delivery'])
        self.assertEqual(len(result['items']), 2)
        self.assertTrue(result['partial'])
        self.assertIn('detail_http_503', result['shipments'][1]['warnings'])
        self.assertFalse(result['whole_order_complete'])

    def test_detail_timeout_skips_remaining_reads_but_retains_cards(self):
        clock = [0]
        active = {'data': [{**MARKET_ACTIVE['data'][0], 'shipmentNr': MARKET_ID + '-S' + str(i),
                           'items': [{'itemNr': MARKET_ID + '-' + str(i)}]} for i in range(1, 4)]}
        def respond(route, *_args, **kwargs):
            if route == 'marketplace_active':
                return active
            if route == 'marketplace_history':
                return {'data': []}
            if kwargs['shipment'] == SHIPMENT_ID:
                return {**SHIPMENT_NEARBY, 'timeline': [{'status': {'highStatusCode': 'delivered'}}]}
            clock[0] = 11
            return {**SHIPMENT_NEARBY, 'shipmentNr': kwargs['shipment'],
                    'timeline': [{'status': {'highStatusCode': 'delivered'}}]}
        with patch.object(n.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(n, 'verified_session', return_value={}), \
                patch.object(n, 'request', side_effect=respond) as request:
            result = n.track(MARKET_ID)
        self.assertEqual(request.call_count, 4)
        self.assertEqual([s['status'] for s in result['shipments']],
                         ['delivered', 'out for delivery', 'out for delivery'])
        self.assertTrue(result['partial'])
        self.assertEqual(len(result['read_coverage']['skipped']), 1)

    def test_orders_all_keeps_minutes_when_marketplace_fails(self):
        with patch.object(n, 'verified_session', return_value={}), patch.object(n, 'request', side_effect=[
                MINUTES_PAGE, n.NoonError('HTTP_503'), n.NoonError('HTTP_503')]):
            result = n.orders('all')
        self.assertEqual([r['order'] for r in result['orders']], [MINUTES_ID])
        self.assertTrue(result['partial'])
        self.assertTrue(result['orders'][0]['account_verified'])
        self.assertIn('marketplace_active_http_503', result['warnings'])

    def test_orders_all_keeps_marketplace_when_minutes_auth_fails(self):
        with patch.object(n, 'verified_session', side_effect=[n.NoonError('AUTH_EXPIRED'), {}]), \
                patch.object(n, 'request', side_effect=[MARKET_ACTIVE, MARKET_DELIVERED_HISTORY]):
            result = n.orders('all')
        self.assertEqual(len(result['orders']), 2)
        self.assertTrue(all(r['service'] == 'marketplace' for r in result['orders']))
        self.assertTrue(result['partial'])
        self.assertIn('minutes_session_auth_expired', result['warnings'])

    def test_orders_deadline_skips_next_vertical_without_keychain_or_request(self):
        clock = [0]
        def now():
            value = clock[0]
            clock[0] += 1
            return value
        # Exhaust budget immediately after a successfully accepted Minutes list.
        def project(data):
            result = original(data)
            clock[0] = 9
            return result
        original = n.minutes_list
        with patch.object(n.time, 'monotonic', side_effect=now), \
                patch.object(n, 'verified_session', return_value={}) as verify, \
                patch.object(n, 'request', return_value=MINUTES_PAGE) as request, \
                patch.object(n, 'minutes_list', side_effect=project):
            result = n.orders('all', timeout=10)
        self.assertEqual(len(result['orders']), 1)
        self.assertEqual(verify.call_count, 1)
        self.assertEqual(request.call_count, 1)
        self.assertTrue(result['partial'])
        self.assertIn('marketplace_session', result['read_coverage']['skipped'])

    def test_orders_marketplace_history_failure_keeps_active(self):
        with patch.object(n, 'verified_session', return_value={}), patch.object(n, 'request', side_effect=[
                MARKET_ACTIVE, n.NoonError('HTTP_503')]):
            result = n.orders('marketplace')
        self.assertEqual(len(result['orders']), 1)
        self.assertEqual(result['orders'][0]['status'], 'out for delivery')
        self.assertTrue(result['partial'])

    def test_late_history_rejected_and_details_skipped(self):
        clock = [0]
        def respond(route, *_args, **_kwargs):
            if route == 'marketplace_active':
                return MARKET_ACTIVE
            clock[0] = 11
            return MARKET_DELIVERED_HISTORY
        with patch.object(n.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(n, 'verified_session', return_value={}), \
                patch.object(n, 'request', side_effect=respond) as request:
            result = n.track(MARKET_ID)
        self.assertEqual(request.call_count, 2)
        self.assertEqual(len(result['shipments']), 1)
        self.assertEqual(result['status'], 'out for delivery')
        self.assertTrue(result['partial'])
        self.assertEqual(result['read_coverage']['failed'], {'marketplace_history': 'NATIVE_READ_TIMEOUT'})
        self.assertEqual(result['read_coverage']['skipped'],
                         {'marketplace_shipment:' + SHIPMENT_ID: 'NATIVE_READ_TIMEOUT'})

    def test_order_list_late_vertical_never_overwrites_completed_vertical(self):
        clock = [0]
        def respond(route, *_args, **_kwargs):
            if route == 'minutes_list':
                return MINUTES_PAGE
            clock[0] = 11
            return MARKET_ACTIVE
        with patch.object(n.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(n, 'verified_session', return_value={}), \
                patch.object(n, 'request', side_effect=respond) as request:
            result = n.orders('all')
        self.assertEqual(request.call_count, 2)
        self.assertEqual([r['order'] for r in result['orders']], [MINUTES_ID])
        self.assertFalse(result['coverage']['marketplace']['active_fetched'])
        self.assertFalse(result['coverage']['marketplace']['history_fetched'])
        self.assertTrue(result['partial'])

    def test_order_list_all_failed_still_raises(self):
        with patch.object(n, 'verified_session', return_value={}), \
                patch.object(n, 'request', side_effect=n.NoonError('HTTP_503')):
            with self.assertRaisesRegex(n.NoonError, 'HTTP_503'):
                n.orders('all')
            with self.assertRaisesRegex(n.NoonError, 'HTTP_503'):
                n.track(MARKET_ID)
        with patch.object(n, 'verified_session', return_value={}), \
                patch.object(n, 'request', return_value={'data': []}):
            with self.assertRaisesRegex(n.NoonError, 'ORDER_NOT_IN_FETCHED_PAGE'):
                n.track(MARKET_ID)

    def test_empty_successful_page_is_valid_partial_list(self):
        with patch.object(n, 'verified_session', return_value={}), patch.object(n, 'request', side_effect=[
                {'orders': [], 'totalPages': 0}, n.NoonError('HTTP_503'), n.NoonError('HTTP_503')]):
            result = n.orders('all')
        self.assertEqual(result['orders'], [])
        self.assertTrue(result['partial'])
        self.assertIn('minutes_list', result['read_coverage']['completed'])

    def test_merge_dedupes_same_scope_without_hiding_conflict(self):
        history = {'data': [{**MARKET_ACTIVE['data'][0], 'status': {'highStatusCode': 'delivered'}}]}
        result, calls = self.track_routes(MARKET_ID, {
            'marketplace_active': {'data': MARKET_ACTIVE['data'] * 2}, 'marketplace_history': history,
            'marketplace_shipment': n.NoonError('HTTP_302')})
        self.assertEqual(calls.count('marketplace_shipment'), 1)
        self.assertEqual(len(result['items']), 1)
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['shipments'][0]['status'], 'unknown')
        self.assertIn('card_status_conflict', result['warnings'])

    def test_detail_bound_retains_fifth_card_instead_of_dropping_evidence(self):
        active = {'data': [{**MARKET_ACTIVE['data'][0], 'shipmentNr': MARKET_ID + '-S' + str(i),
                           'items': [{'itemNr': MARKET_ID + '-' + str(i)}]} for i in range(1, 5)]}
        result, calls = self.track_routes(MARKET_ID, {
            'marketplace_active': active, 'marketplace_history': MARKET_DELIVERED_HISTORY,
            'marketplace_shipment': n.NoonError('HTTP_302')})
        self.assertEqual(calls.count('marketplace_shipment'), 4)
        self.assertNotIn('marketplace_item', calls)
        self.assertEqual(len(result['items']), 5)
        self.assertEqual(len(result['shipments']), 5)
        self.assertEqual(result['shipments'][-1]['status'], 'delivered')
        self.assertEqual(result['shipments'][-1]['scope'], 'item')
        self.assertTrue(result['truncated'])
        self.assertTrue(result['partial'])
        self.assertEqual(result['read_coverage']['skipped']['marketplace_item:' + MARKET_ID + '-1'], 'DETAIL_LIMIT')

    def test_live_minutes_shapes_and_identity(self):
        self.assertEqual(n.minutes_track(MINUTES_PICKED_UP, MINUTES_ID)['status'], 'out for delivery')
        self.assertEqual(n.minutes_track(MINUTES_NEARBY, MINUTES_ID)['status'], 'nearby')
        self.assertEqual(n.minutes_track(MINUTES_DELIVERED, MINUTES_ID)['status'], 'delivered')
        with self.assertRaisesRegex(n.NoonError, 'MISMATCH'):
            n.minutes_track(MINUTES_PICKED_UP, 'IOTHER')
        unknown = {**MINUTES_PICKED_UP, 'status': 'new_enum'}
        self.assertEqual(n.minutes_track(unknown, MINUTES_ID)['status'], 'unknown')
        self.assertIsNone(n.minutes_track(MINUTES_PICKED_UP, MINUTES_ID)['eta'])

    def test_rider_opt_in_and_private_data_projection(self):
        rider = {'showRiderDetails': False, 'name': 'Fixture Rider', 'phone': '000',
                 'postOrderTipDetails': {'paymentToken': 'private'}}
        data = {**MINUTES_PICKED_UP, 'rider': rider, 'customerAddress': 'private'}
        self.assertIsNone(n.minutes_track(data, MINUTES_ID)['rider'])
        rider['showRiderDetails'] = True
        result = n.minutes_track(data, MINUTES_ID)
        self.assertEqual(result['rider'], {'name': 'Fixture Rider', 'phone': '000'})
        self.assertNotIn('private', json.dumps(result))

    def test_minutes_native_eta_window(self):
        with patch.object(n, 'verified_session', return_value={}), patch.object(n, 'request', side_effect=[MINUTES_PICKED_UP, MINUTES_PAGE]):
            result = n.track(MINUTES_ID)
        self.assertEqual(result['eta'], '2026-10-08T18:16:00+04:00')
        self.assertTrue(result['account_verified'])
        self.assertEqual(result['eta_source'], 'native_minutes_list_window')
        self.assertIsNone(n.eta_window('2026-10-08T23:58:00', 'Arrives between: 11:59 - 12:10 AM'))
        self.assertIsNone(n.eta_window('2026-10-08T17:58:35', 'Arrives tomorrow'))

    def test_marketplace_future_delivered_node_is_not_delivery(self):
        result = n.shipment_track(SHIPMENT_NEARBY, MARKET_ID, SHIPMENT_ID)
        self.assertEqual(result['status'], 'out for delivery')
        self.assertEqual(result['scope'], 'shipment')
        with self.assertRaisesRegex(n.NoonError, 'MISMATCH'):
            n.shipment_track(SHIPMENT_NEARBY, 'NOTHER', SHIPMENT_ID)
        conflict = {**SHIPMENT_NEARBY, 'timeline': [*SHIPMENT_NEARBY['timeline'],
                       {'status': {'highStatusCode': 'delivered'}}]}
        self.assertEqual(n.shipment_track(conflict, MARKET_ID, SHIPMENT_ID)['status'], 'unknown')

    def test_bounded_shipment_delivery_never_closes_order(self):
        delivered = {**SHIPMENT_NEARBY, 'timeline': [{'status': {'highStatusCode': 'delivered'}}]}
        with patch.object(n, 'verified_session', return_value={}), patch.object(n, 'request', side_effect=[
                MARKET_ACTIVE, {'data': []}, delivered]):
            result = n.track(MARKET_ID)
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['shipments'][0]['status'], 'delivered')
        self.assertFalse(result['whole_order_complete'])
        self.assertEqual(result['items'][0]['item_ids'], [MARKET_ID + '-1'])

    def test_delivered_item_history_and_detail_still_not_whole_order(self):
        with patch.object(n, 'verified_session', return_value={}), patch.object(n, 'request', side_effect=[
                {'data': []}, MARKET_DELIVERED_HISTORY, ITEM_DELIVERED]):
            result = n.track(MARKET_ID)
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['shipments'][0]['status'], 'delivered')
        self.assertEqual(result['shipments'][0]['scope'], 'item')
        self.assertFalse(result['whole_order_complete'])
        self.assertTrue(result['items'][0]['account_verified'])

    def test_completed_shipment_redirect_keeps_card_evidence(self):
        with patch.object(n, 'verified_session', return_value={}), patch.object(n, 'request', side_effect=[
                MARKET_ACTIVE, {'data': []}, n.NoonError('HTTP_302')]):
            result = n.track(MARKET_ID)
        self.assertEqual(result['status'], 'out for delivery')
        self.assertIn('detail_http_302', result['shipments'][0]['warnings'])

    def test_profile_and_home_required_before_order_request(self):
        h = {'x-addresscode': 'fixture-code', 'x-addresskey': 'fixture-key'}
        identity = {'customer': {'customerCode': 'fixture'}, 'experiences': [
            {'selectedAddress': {'addressCode': 'fixture-code', 'addressKey': 'fixture-key', 'name': 'BanyanTree'}}]}
        n.verify_home(identity, h)
        with self.assertRaisesRegex(n.NoonError, 'HOME_MISMATCH'):
            n.verify_home(identity, {**h, 'x-addresskey': 'other'})
        with patch.object(n, 'session', return_value=h), patch.object(n, 'request', return_value={}) as request:
            with self.assertRaisesRegex(n.NoonError, 'AUTH_EXPIRED'):
                n.track(MINUTES_ID)
            self.assertEqual(request.call_count, 1)

    def test_route_allowlist_prevents_mutation_or_credential_redirect(self):
        with patch.object(n.urllib.request, 'build_opener') as opener:
            for route in ['checkout', 'https://other.example', 'order_cancel']:
                with self.assertRaisesRegex(n.NoonError, 'ENDPOINT_DENIED'):
                    n.request(route, {}, time.monotonic()+1)
            with self.assertRaises(n.NoonError):
                n.request('minutes_track', {}, time.monotonic()+1, {'order_nr': '../checkout'})
            with self.assertRaises(n.NoonError):
                n.request('marketplace_shipment', {}, time.monotonic()+1, shipment='../order')
            opener.assert_not_called()
        self.assertIsNone(n.NoRedirect().redirect_request(None, None, None, None, None, None))

    def test_transport_truncation_and_deadline(self):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.side_effect = http.client.IncompleteRead(b'private', 3)
        opener = Mock(); opener.open.return_value = response
        old = signal.getsignal(signal.SIGALRM)
        with patch.object(n.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(n.NoonError, 'NATIVE_READ_FAILED'):
                n.request('whoami', {}, time.monotonic()+2)
        self.assertEqual(signal.getsignal(signal.SIGALRM), old)
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))
        response.read.side_effect = None
        response.read.return_value = b'{}'
        with patch.object(n.urllib.request, 'build_opener', return_value=opener), \
             patch.object(n.time, 'monotonic', side_effect=[0, 0, 20]):
            with self.assertRaisesRegex(n.NoonError, 'TIMEOUT'):
                n.request('whoami', {}, 8)

    def test_response_bound(self):
        response = Mock(); response.__enter__ = Mock(return_value=response); response.__exit__ = Mock(return_value=False)
        response.read.return_value = b'x' * (n.MAX_BYTES+1)
        opener = Mock(); opener.open.return_value = response
        with patch.object(n.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(n.NoonError, 'RESPONSE_TOO_LARGE'):
                n.request('whoami', {}, time.monotonic()+2)

    def test_list_dispatch_retains_scope_and_verifies_each_vertical(self):
        with patch.object(n, 'verified_session', return_value={}) as verify, patch.object(n, 'request', side_effect=[
                MINUTES_PAGE, MARKET_ACTIVE, MARKET_DELIVERED_HISTORY]):
            result = n.orders('all')
        self.assertEqual(verify.call_count, 2)
        self.assertEqual(len(result['orders']), 3)
        self.assertEqual(result['orders'][-1]['scope'], 'item')
        self.assertTrue(all(x['account_verified'] for x in result['orders']))
        self.assertFalse(result['coverage']['marketplace']['whole_order_completion_verified'])


if __name__ == '__main__':
    unittest.main()
