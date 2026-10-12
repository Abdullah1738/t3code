import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import native_orders as orders
import order_tracker as tracker


class NativeOrdersTest(unittest.TestCase):
    def test_exact_identity_and_no_payment_leak(self):
        data = {'status': 'delivered', 'csHelpLabels': {'orderNumber': 'I123'},
                'rider': {'name': 'Rider', 'showRiderDetails': False,
                          'postOrderTipDetails': {'paymentToken': 'secret'}}}
        result = orders.minutes_track(data, 'I123')
        self.assertEqual(result['status'], 'delivered')
        self.assertIsNone(result['rider'])
        self.assertNotIn('secret', str(result))
        with self.assertRaises(orders.OrderError):
            orders.minutes_track(data, 'I456')

    def test_unknown_and_future_text_never_delivered(self):
        for value in ['delivery expected', 'will be delivered', 'new_enum', None]:
            self.assertEqual(orders.stage(value), 'unknown')

    def test_guest_fails_without_network(self):
        with patch.object(orders, 'request') as request, patch('talabat_http_orders.load', return_value=None):
            for app in ('talabat', 'careem'):
                with self.assertRaisesRegex(orders.OrderError, 'GUEST'):
                    orders.track(app, '123')
            request.assert_not_called()

    def test_native_success_skips_fallback(self):
        native = orders.minutes_track({'status': 'delivered',
                                      'csHelpLabels': {'orderNumber': 'I123'}}, 'I123')
        with patch.object(orders, 'track', return_value=native), \
             patch.object(tracker, 'mail_evidence') as mail, patch.object(tracker, 'run') as adb:
            result = tracker.fetch({'app': 'noon', 'order': 'I123'}, {}, 100)
        self.assertEqual(result['status'], 'delivered')
        mail.assert_not_called()
        adb.assert_not_called()

    def test_stage_changes_deduplicate(self):
        state = {'primed': True, 'status': 'placed'}
        cfg = {'registered_at': tracker.stamp(100)}
        result = {'status': 'preparing', 'errors': []}
        first = tracker.transition(result, state, cfg, 101)
        self.assertEqual(first[0]['kind'], 'stage_change')
        self.assertEqual(tracker.transition(result, state, cfg, 102), [])

    def test_partial_marketplace_never_certifies_delivered(self):
        from test.test_noon_http_orders import MARKET_ACTIVE, SHIPMENT_NEARBY, MARKET_ID
        data = {'timeline': [{'status': {'highStatusCode': 'delivered'}}],
                **{k: v for k, v in SHIPMENT_NEARBY.items() if k != 'timeline'}}
        with patch('noon_vertical_reads.track', side_effect=__import__('noon_http_orders').NoonError('UNAVAILABLE')), \
             patch('noon_http_orders.verified_session', return_value={}), \
             patch('noon_http_orders.request', side_effect=lambda route, *a, **k:
                   MARKET_ACTIVE if route == 'marketplace_active' else
                   {'data': []} if route == 'marketplace_history' else data):
            self.assertEqual(orders.track('noon', MARKET_ID)['status'], 'unknown')

    def test_noon_dispatch_and_sanitized_errors(self):
        import noon_http_orders as n
        with patch.object(n, 'track', return_value={'status': 'unknown'}) as track:
            self.assertEqual(orders.track('noon', 'I123')['status'], 'unknown')
            track.assert_called_once_with('I123', 10)
        with patch.object(n, 'orders', side_effect=n.NoonError('AUTH_EXPIRED')):
            with self.assertRaisesRegex(orders.OrderError, '^AUTH_EXPIRED$'):
                orders.orders('noon')

    def test_talabat_list_one_based_cli_adapter(self):
        with patch('talabat_http_list.list_orders', return_value={'ok': True}) as listing:
            orders.orders('talabat', page=2, pages=3, limit=80, timeout=9)
            listing.assert_called_once_with(page=1, pages=3, limit=80, timeout=9)

    def test_food_dispatch_is_explicit_and_default_does_not_expand(self):
        with patch('noon_vertical_reads.track', return_value={'status': 'delivered'}) as track:
            self.assertEqual(orders.track('noon', 'F123')['status'], 'delivered')
            track.assert_called_once_with('F123', 'food', 10)
        with patch('noon_vertical_reads.food_orders', return_value={'ok': True}) as listing:
            orders.orders('noon', service='food', timeout=7)
            listing.assert_called_once_with(7)
            with self.assertRaisesRegex(orders.OrderError, 'PAGINATION'):
                orders.orders('noon', service='food', page=2)

    def test_nownow_precedes_marketplace_and_listing_is_explicit(self):
        with patch('noon_vertical_reads.track', return_value={'status': 'delivered'}) as track, \
             patch.object(orders, 'noon_marketplace_track') as market:
            self.assertEqual(orders.track('noon', 'NN123')['status'], 'delivered')
            track.assert_called_once_with('NN123', 'nownow', 10)
            market.assert_not_called()
        with patch('noon_vertical_reads.nownow_orders', return_value={'ok': True}) as listing:
            orders.orders('noon', service='nownow', timeout=7)
            listing.assert_called_once_with(7)
            with self.assertRaisesRegex(orders.OrderError, 'PAGINATION'):
                orders.orders('noon', service='nownow', page=2)

    def test_marketplace_full_manifest_closes_only_without_scoped_conflict(self):
        manifest = {'status': 'delivered', 'whole_order_complete': True, 'manifest_complete': True,
                    'coverage': 'full_manifest', 'items': [{'scope': 'item', 'item_id': 'N1-1',
                    'shipment_id': 'N1-S1', 'status': 'delivered'}]}
        for stage, expected in [('unknown', 'delivered'), ('out for delivery', 'unknown'), ('cancelled', 'unknown')]:
            with self.subTest(stage=stage), patch('noon_http_orders.track', return_value={
                    'status': 'unknown', 'whole_order_complete': False, 'shipments': [
                    {'scope': 'shipment', 'shipment_id': 'N1-S1', 'status': stage}]}), \
                 patch('noon_vertical_reads.track', return_value=manifest):
                result = orders.track('noon', 'N1')
                self.assertEqual(result['status'], expected)
                self.assertEqual(result['whole_order_complete'], expected == 'delivered')
                self.assertEqual(len(result['shipments']), 2)

    def test_marketplace_manifest_failure_keeps_prior_proof_and_budget(self):
        import noon_http_orders as core
        with patch.object(core, 'track', return_value={'status': 'unknown', 'shipments': [
                {'scope': 'item', 'item_id': 'N1-1', 'shipment_id': 'N1-S1', 'status': 'delivered'}]}), \
             patch('noon_vertical_reads.track', side_effect=core.NoonError('HTTP_TIMEOUT')):
            out = orders.track('noon', 'N1')
            self.assertFalse(out['whole_order_complete'])
            self.assertEqual(out['shipments'][0]['status'], 'delivered')
            self.assertTrue(out['partial'])
        with patch.object(core, 'track', side_effect=core.NoonError('HTTP_TIMEOUT')), \
             patch('noon_vertical_reads.track') as manifest, \
             patch('time.monotonic', side_effect=[0, 0, 20]):
            with self.assertRaises(orders.OrderError):
                orders.track('noon', 'N1', timeout=8)
            manifest.assert_not_called()


class MarketplaceIntegrationTest(unittest.TestCase):
    """Real projections and tracker transitions; all I/O boundaries are mocked."""

    def setUp(self):
        import noon_http_orders
        import noon_vertical_reads
        from test import test_noon_http_orders
        from test.test_noon_vertical_reads import VerticalReadsTest
        self.core, self.vertical, self.f = noon_http_orders, noon_vertical_reads, test_noon_http_orders
        self.order = self.f.MARKET_ID
        self.manifest = VerticalReadsTest().manifest()

    def delivered_routes(self):
        active = copy.deepcopy(self.f.MARKET_ACTIVE)
        active['data'][0]['status']['highStatusCode'] = 'delivered'
        detail = copy.deepcopy(self.f.SHIPMENT_NEARBY)
        detail['timeline'] = [{'status': {'highStatusCode': 'delivered'}}]
        return {'marketplace_active': active, 'marketplace_history': {'data': []},
                'marketplace_shipment': detail}

    def track_routes(self, routes):
        def respond(route, *_args, **_kwargs):
            value = routes[route]
            if isinstance(value, Exception):
                raise value
            return value
        with patch.object(self.core, 'verified_session', return_value={}), \
                patch.object(self.core, 'request', side_effect=respond), \
                patch.object(self.vertical, '_headers', return_value={}), \
                patch.object(self.vertical, '_read', return_value=self.manifest):
            return orders.track('noon', self.order)

    def assert_conflict(self, result):
        self.assertEqual(result['status'], 'unknown')
        self.assertFalse(result['whole_order_complete'])
        self.assertIn('MANIFEST_SCOPED_EVIDENCE_CONFLICT', result['warnings'])

    def test_raw_unmapped_item_status_vetoes_delivered_manifest(self):
        for raw in ('cancelled', 'returned', 'new_state'):
            history = copy.deepcopy(self.f.MARKET_DELIVERED_HISTORY)
            history['data'][0]['status']['highStatusCode'] = raw
            detail = copy.deepcopy(self.f.ITEM_DELIVERED)
            detail['timeline'][0]['status']['highStatusCode'] = raw
            with self.subTest(raw=raw):
                result = self.track_routes({'marketplace_active': {'data': []},
                    'marketplace_history': history, 'marketplace_item': detail})
                self.assertEqual(result['shipments'][0]['raw_status'], raw)
                self.assert_conflict(result)

    def test_conflicting_card_status_survives_successful_delivered_detail(self):
        routes = self.delivered_routes()
        routes['marketplace_history'] = copy.deepcopy(routes['marketplace_active'])
        routes['marketplace_history']['data'][0]['status']['highStatusCode'] = 'cancelled'
        result = self.track_routes(routes)
        self.assertEqual(result['items'][0]['raw_status'], None)
        self.assert_conflict(result)

    def test_conflicting_current_timeline_statuses_veto_manifest(self):
        routes = self.delivered_routes()
        routes['marketplace_shipment']['timeline'].append({'status': {'highStatusCode': 'cancelled'}})
        self.assert_conflict(self.track_routes(routes))

    def test_card_members_missing_from_invoice_reconciled_manifest_veto(self):
        routes = self.delivered_routes()
        card = routes['marketplace_active']['data'][0]
        card['items'].append({'itemNr': self.order + '-2', 'quantity': 1})
        card['itemCount'] = 2
        result = self.track_routes(routes)
        self.assertEqual(result['manifest_item_count'], 1)
        self.assertEqual(result['items'][0]['item_ids'], [self.order + '-1', self.order + '-2'])
        self.assert_conflict(result)

    def test_all_scoped_collections_reconcile_identity_and_raw_state(self):
        manifest = self.vertical.manifest_projection(self.manifest, self.order)
        part = {'scope': 'item', 'item_id': self.order + '-1',
                'shipment_id': self.order + '-S1', 'status': 'unknown'}
        for collection in ('items', 'shipments'):
            for change in ({'item_id': self.order + '-2'}, {'item_ids': [self.order + '-2']},
                           {'shipment_id': self.order + '-S2'}, {'raw_status': 'cancelled'}):
                with self.subTest(collection=collection, change=change), \
                        patch.object(self.core, 'track', return_value={'status': 'unknown',
                            'whole_order_complete': False, collection: [{**part, **change}]}), \
                        patch.object(self.vertical, 'track', return_value=manifest):
                    self.assert_conflict(orders.track('noon', self.order))

    def test_scoped_item_shipment_association_must_match_manifest(self):
        second = copy.deepcopy(self.manifest['itemGroups'][0])
        second['itemNr'] = second['items'][0]['itemNr'] = self.order + '-2'
        second['shipmentNr'] = second['items'][0]['shipmentNr'] = self.order + '-S2'
        self.manifest['itemGroups'].append(second)
        section = self.manifest['invoice']['sections'][0]
        section['entries'][0]['title'] = section['groups'][0]['entries'][0]['title'] = 'Subtotal (2 items)'
        routes = self.delivered_routes()
        routes['marketplace_active']['data'][0]['items'] = [{'itemNr': self.order + '-2'}]
        self.assert_conflict(self.track_routes(routes))

    def test_agreeing_scoped_inventory_allows_whole_delivery(self):
        result = self.track_routes(self.delivered_routes())
        self.assertEqual(result['status'], 'delivered')
        self.assertTrue(result['whole_order_complete'])
        self.assertTrue(result['manifest_complete'])
        self.assertEqual(result['warnings'], [])

    def test_item_then_shipment_notifies_once_through_actual_tracker(self):
        section = self.manifest['invoice']['sections'][0]
        section['entries'][0]['title'] = section['groups'][0]['entries'][0]['title'] = 'Subtotal (2 items)'
        manifest = self.vertical.manifest_projection(self.manifest, self.order)
        cfg = {'app': 'noon', 'order': self.order, 'placed_at': tracker.stamp(900),
               'registered_at': tracker.stamp(1000)}
        state = {'primed': True}
        routes = self.delivered_routes()
        with patch.object(tracker, 'mail_evidence', return_value=([], [])), \
                patch.object(tracker.store, 'evidence', return_value=([], [])), \
                patch.object(tracker, 'single_allowed', return_value=False):
            with patch.object(self.core, 'track', side_effect=self.core.NoonError('HTTP_503')), \
                    patch.object(self.vertical, 'track', return_value=manifest):
                first = tracker.fetch(cfg, state, 1000)
            events = tracker.transition(first, state, cfg, 1000)
            self.assertEqual([e['kind'] for e in events], ['shipment_delivered'])
            with patch.object(self.core, 'verified_session', return_value={}), \
                    patch.object(self.core, 'request', side_effect=lambda route, *a, **kw: routes[route]), \
                    patch.object(self.vertical, 'track', side_effect=self.core.NoonError('HTTP_503')):
                second = tracker.fetch(cfg, state, 1001)
            self.assertEqual(tracker.transition(second, state, cfg, 1001), [])
            self.assertEqual(second['partial_evidence'][0]['item_ids'], [self.order + '-1'])
            self.assertFalse(second['whole_order_complete'])

    def test_absolute_deadline_survives_delayed_vertical_entry(self):
        clock = [0]
        scoped = {'status': 'unknown', 'whole_order_complete': False, 'shipments': [
            {'scope': 'item', 'item_id': self.order + '-1', 'shipment_id': self.order + '-S1',
             'status': 'delivered'}]}
        real_track = self.vertical.track
        def core_done(*args, **kwargs):
            clock[0] = 7
            return scoped
        def delayed_entry(*args, **kwargs):
            clock[0] = 9
            return real_track(*args, **kwargs)
        with patch('time.monotonic', side_effect=lambda: clock[0]), \
                patch.object(self.core, 'track', side_effect=core_done) as core_track, \
                patch.object(self.vertical, 'track', side_effect=delayed_entry) as vertical_track, \
                patch.object(self.vertical, '_headers', return_value={}) as headers, \
                patch.object(self.vertical, '_read', return_value=self.manifest):
            result = orders.track('noon', self.order, timeout=8)
        self.assertEqual(result['status'], 'unknown')
        self.assertFalse(result['whole_order_complete'])
        self.assertEqual(result['shipments'], scoped['shipments'])
        self.assertIn('manifest_NATIVE_READ_TIMEOUT', result['warnings'])
        headers.assert_not_called()
        self.assertEqual(core_track.call_args.kwargs['deadline'], 8)
        self.assertEqual(vertical_track.call_args.kwargs['deadline'], 8)

    def test_late_manifest_return_rejected_without_erasing_scoped_proof(self):
        clock = [0]
        scoped = {'status': 'unknown', 'whole_order_complete': False, 'shipments': [
            {'scope': 'item', 'item_id': self.order + '-1', 'shipment_id': self.order + '-S1',
             'status': 'delivered'}]}
        def late(*args, **kwargs):
            clock[0] = 9
            return self.vertical.manifest_projection(self.manifest, self.order)
        with patch('time.monotonic', side_effect=lambda: clock[0]), \
                patch.object(self.core, 'track', return_value=scoped), \
                patch.object(self.vertical, 'track', side_effect=late):
            result = orders.track('noon', self.order, timeout=8)
        self.assertEqual(result['status'], 'unknown')
        self.assertFalse(result['whole_order_complete'])
        self.assertEqual(result['shipments'], scoped['shipments'])
        self.assertNotIn('manifest_items', result)
        self.assertIn('manifest_NATIVE_READ_TIMEOUT', result['warnings'])


if __name__ == '__main__':
    unittest.main()
