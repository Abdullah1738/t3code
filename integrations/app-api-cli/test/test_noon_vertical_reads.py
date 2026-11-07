import time
import copy
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import noon_vertical_reads as v

SUPERMALL_LIVE = json.loads((Path(__file__).parent
                             / 'fixture_supermall_order_detail_live.json').read_text())
SUPERMALL_FRESH = json.loads((Path(__file__).parent
                             / 'fixture_supermall_order_detail_fresh_live.json').read_text())


class VerticalReadsTest(unittest.TestCase):
    def test_quantity_two_line_reconciles_invoice_units(self):
        data=self.manifest();data['itemGroups'][0]['items'][0]['quantity']=2
        data['invoice']['sections'][0]['entries'][0]['title']='Subtotal (2 items)'
        data['invoice']['sections'][0]['groups'][0]['entries'][0]['title']='Subtotal (2 items)'
        result=v.manifest_projection(data,self.order)
        self.assertTrue(result['manifest_complete']);self.assertTrue(result['whole_order_complete'])
        self.assertEqual(len(result['items']),1)

    def test_full_cancelled_inventory_is_terminal_with_native_provenance(self):
        data=self.manifest();data['itemGroups'][0]['subStatus']['highStatusCode']='cancelled'
        data['itemGroups'][0]['text']='Cancelled today, 06:18 PM'
        result=v.manifest_projection(data,self.order)
        self.assertEqual(result['status'],'cancelled');self.assertTrue(result['whole_order_complete'])
        self.assertEqual(result['terminal_evidence']['source'],'native_order_detail_item_groups')
        self.assertIn('06:18 PM',result['terminal_evidence']['provider_text'][0])

    def test_full_cancellation_wins_over_cached_processing(self):
        import native_orders
        data=self.manifest();data['itemGroups'][0]['subStatus']['highStatusCode']='cancelled'
        manifest=v.manifest_projection(data,self.order)
        scoped={'status':'unknown','raw_status':'processing','whole_order_complete':False,'items':[]}
        with patch.object(v.core,'track',return_value=scoped), patch.object(v,'track',return_value=manifest):
            result=native_orders.noon_marketplace_track(self.order,10)
        self.assertEqual(result['status'],'cancelled');self.assertTrue(result['whole_order_complete'])
        self.assertEqual(result['terminal_evidence']['order'],self.order)

    def test_food_live_window_and_unknown_status(self):
        data = {'status': 'success', 'data': {'orderNr': 'FTEST', 'status': 'delivering',
                'estimate': {'time': '05:45 PM - 05:55 PM', 'timestamp': '2026-11-07T17:45:00'}}}
        result = v.food_projection(data, 'FTEST')
        self.assertEqual(result['status'], 'out for delivery')
        self.assertEqual(result['eta'], '2026-11-07T17:55:00+04:00')
        data['data']['estimate']['timestamp'] = '2026-11-07T16:45:00'
        self.assertIsNone(v.food_projection(data, 'FTEST')['eta'])
        data['data']['status'] = 'future_status'
        self.assertEqual(v.food_projection(data, 'FTEST')['status'], 'unknown')

    order = 'NAEIA0002358740'

    def manifest(self):
        return {'orderNr': self.order, 'createdAt': '2026-10-08T00:00:00',
            'shippingAddress': {}, 'trackActions': {}, 'shippingPreferences': {},
            'metadata': {'pageRefreshSec': None}, 'payment': {},
            'invoice': {'sections': [{'entries': [{'title': 'Subtotal (1 item)'}],
                                     'groups': [{'entries': [{'title': 'Subtotal (1 item)'}]}]}]},
            'itemGroups': [{'orderNr': self.order,
            'itemNr': self.order + '-1', 'shipmentNr': self.order + '-S1',
            'subStatus': {'highStatusCode': 'delivered'},
            'items': [{'itemNr': self.order + '-1', 'shipmentNr': self.order + '-S1', 'quantity': 1}]}]}

    def test_count_reconciled_manifest_can_prove_delivery(self):
        result = v.manifest_projection(self.manifest(), self.order)
        self.assertEqual(result['items'][0]['status'], 'delivered')
        self.assertEqual(result['status'], 'delivered')
        self.assertTrue(result['manifest_complete'])
        self.assertTrue(result['whole_order_complete'])

    def test_inherited_deadline_not_restarted_at_vertical_entry(self):
        with patch('time.monotonic', return_value=9), patch.object(v, '_headers') as headers:
            with self.assertRaisesRegex(v.NoonError, 'NATIVE_READ_TIMEOUT'):
                v.track(self.order, 'marketplace', timeout=8, deadline=8)
            headers.assert_not_called()

    def test_manifest_projection_must_finish_before_inherited_deadline(self):
        clock = [7]
        original = v.manifest_projection
        def project(*args):
            result = original(*args)
            clock[0] = 9
            return result
        with patch('time.monotonic', side_effect=lambda: clock[0]), \
                patch.object(v, '_headers', return_value={}) as headers, \
                patch.object(v, '_read', return_value=self.manifest()) as read, \
                patch.object(v, 'manifest_projection', side_effect=project):
            with self.assertRaisesRegex(v.NoonError, 'NATIVE_READ_TIMEOUT'):
                v.track(self.order, 'marketplace', timeout=8, deadline=8)
        self.assertEqual(headers.call_args.args[1], 8)
        self.assertEqual(read.call_args.args[2], 8)

    def test_partial_count_missing_invoice_and_new_pagination_fail_closed(self):
        for change in ('partial', 'missing_invoice', 'conflicting_counts', 'pagination',
                       'missing_envelope', 'quantity', 'bundle', 'no_shipment', 'unknown_status'):
            data = self.manifest()
            if change == 'partial':
                for entries in [data['invoice']['sections'][0]['entries'], data['invoice']['sections'][0]['groups'][0]['entries']]:
                    entries[0]['title'] = 'Subtotal (2 items)'
            if change == 'missing_invoice': data.pop('invoice')
            if change == 'conflicting_counts': data['invoice']['sections'][0]['entries'][0]['title'] = 'Subtotal (2 items)'
            if change == 'pagination': data['pagination'] = {'hasMore': True}
            if change == 'missing_envelope': data.pop('metadata')
            if change == 'quantity': data['itemGroups'][0]['items'][0]['quantity'] = 2
            if change == 'bundle': data['itemGroups'][0]['items'][0]['virtualBundleCode'] = 'BUNDLE'
            if change == 'no_shipment':
                data['itemGroups'][0]['shipmentNr'] = None
                data['itemGroups'][0]['items'][0]['shipmentNr'] = None
            if change == 'unknown_status': data['itemGroups'][0]['subStatus']['highStatusCode'] = 'new_state'
            with self.subTest(change=change):
                result = v.manifest_projection(data, self.order)
                self.assertEqual(result['status'], 'unknown')
                self.assertFalse(result['whole_order_complete'])

    def test_multi_item_and_split_shipment(self):
        data = self.manifest()
        other = copy.deepcopy(data['itemGroups'][0])
        other['itemNr'] = other['items'][0]['itemNr'] = self.order + '-2'
        other['shipmentNr'] = other['items'][0]['shipmentNr'] = self.order + '-S2'
        data['itemGroups'].append(other)
        for entries in [data['invoice']['sections'][0]['entries'], data['invoice']['sections'][0]['groups'][0]['entries']]:
            entries[0]['title'] = 'Subtotal (2 items)'
        self.assertEqual(v.manifest_projection(data, self.order)['status'], 'delivered')
        other['subStatus']['highStatusCode'] = 'cancelled'
        self.assertEqual(v.manifest_projection(data, self.order)['status'], 'unknown')
        data['itemGroups'].pop()
        self.assertEqual(v.manifest_projection(data, self.order)['status'], 'unknown')

    def test_bad_manifest(self):
        for change in ('duplicate', 'empty', 'wrong_order', 'wrong_shipment', 'bad_quantity', 'conflict'):
            data = self.manifest()
            if change == 'duplicate': data['itemGroups'] *= 2
            if change == 'empty': data['itemGroups'] = []
            if change == 'wrong_order': data['orderNr'] += 'X'
            if change == 'wrong_shipment': data['itemGroups'][0]['items'][0]['shipmentNr'] = 'NOTHER-S1'
            if change == 'bad_quantity': data['itemGroups'][0]['items'][0]['quantity'] = True
            if change == 'conflict': data['itemGroups'][0]['items'][0]['status'] = {'highStatusCode': 'cancelled'}
            with self.subTest(change=change), self.assertRaises(v.NoonError):
                v.manifest_projection(data, self.order)


class SupermallRocketManifestTest(unittest.TestCase):
    """Live rocket orders (both 2026-10-10/11 paid orders, hygiene-redacted).

    Fresh (NAEIA0070666081, confirmed): the group binds a `-U1` fulfillment
    unit with the item row's shipmentNr null — this exact shape raised
    ORDER_MISMATCH_OR_SCHEMA_CHANGED before the fix. Packed/out-for-delivery
    (NAEIA0000960441): group `itemNr` null, rows carry `-S1`.
    """
    order = 'NAEIA0000960441'
    fresh_order = 'NAEIA0070666081'

    def test_live_rocket_manifest_projects(self):
        result = v.manifest_projection(SUPERMALL_LIVE, self.order)
        raw = SUPERMALL_LIVE['itemGroups'][0]['subStatus']['highStatusCode']
        self.assertEqual(result['items'][0]['item_id'], self.order + '-1')
        self.assertEqual(result['items'][0]['shipment_id'], self.order + '-S1')
        self.assertEqual(result['items'][0]['raw_status'], raw)
        self.assertEqual(result['items'][0]['status'], 'out for delivery')
        self.assertTrue(result['manifest_complete'])
        self.assertFalse(result['whole_order_complete'])
        self.assertEqual(result['status'], 'out for delivery')

    def test_live_fresh_rocket_unit_shipment_projects(self):
        """The captured track-exact failure: -U1 group binding, null row id."""
        result = v.manifest_projection(SUPERMALL_FRESH, self.fresh_order)
        self.assertEqual(result['items'][0]['item_id'], self.fresh_order + '-1')
        self.assertEqual(result['items'][0]['shipment_id'], self.fresh_order + '-U1')
        self.assertEqual(result['items'][0]['raw_status'], 'confirmed')
        self.assertEqual(result['manifest_source'], 'native_order_detail_item_groups')

    def test_shipment_regex_accepts_rocket_unit_ids(self):
        match = v.core.SHIPMENT.fullmatch(self.fresh_order + '-U1')
        self.assertEqual(match[1], self.fresh_order)
        self.assertIsNone(v.core.SHIPMENT.fullmatch(self.fresh_order + '-X1'))
        self.assertIsNone(v.core.SHIPMENT.fullmatch(self.fresh_order + '-U1X'))
        self.assertEqual(v.core.SHIPMENT.fullmatch(self.order + '-S12')[1], self.order)

    def test_active_cards_accept_fresh_rocket_unit_row(self):
        """The guard read (/orders/active) sees -U1 with null row shipment ids."""
        page = {'data': [{'orderNr': self.fresh_order, 'shipmentNr': self.fresh_order + '-U1',
                          'status': {'highStatusCode': 'confirmed'},
                          'items': [{'itemNr': self.fresh_order + '-1', 'shipmentNr': None}],
                          'delivery': {}}]}
        rows = v.core.marketplace_cards(page)
        self.assertEqual(rows[0]['order'], self.fresh_order)
        self.assertEqual(rows[0]['shipment_id'], self.fresh_order + '-U1')
        bad = copy.deepcopy(page)
        bad['data'][0]['shipmentNr'] = 'NOTHER-U1'
        with self.assertRaises(v.core.NoonError):
            v.core.marketplace_cards(bad)

    def test_group_only_shipment_binding_is_inherited_not_rejected(self):
        data = copy.deepcopy(SUPERMALL_LIVE)
        data['itemGroups'][0]['items'][0]['shipmentNr'] = None
        result = v.manifest_projection(data, self.order)
        self.assertEqual(result['items'][0]['shipment_id'], self.order + '-S1')
        self.assertTrue(result['manifest_complete'])

    def test_inherited_group_shipment_must_belong_to_the_order(self):
        data = copy.deepcopy(SUPERMALL_LIVE)
        data['itemGroups'][0]['items'][0]['shipmentNr'] = None
        data['itemGroups'][0]['shipmentNr'] = 'NOTHER-S1'
        with self.assertRaises(v.NoonError):
            v.manifest_projection(data, self.order)

    def test_inherited_rocket_unit_shipment_must_belong_to_the_order(self):
        data = copy.deepcopy(SUPERMALL_FRESH)
        data['itemGroups'][0]['shipmentNr'] = 'NOTHER-U1'
        with self.assertRaises(v.NoonError):
            v.manifest_projection(data, self.fresh_order)

    def test_conflicting_group_and_row_shipment_still_rejected(self):
        data = copy.deepcopy(SUPERMALL_LIVE)
        data['itemGroups'][0]['shipmentNr'] = self.order + '-S2'
        with self.assertRaises(v.NoonError):
            v.manifest_projection(data, self.order)

    def test_fixture_hygiene_has_no_personal_data(self):
        for doc in (SUPERMALL_LIVE, SUPERMALL_FRESH):
            raw = json.dumps(doc)
            for banned in ('971', 'phone', 'lat', 'lng', 'token', 'secret', '@'):
                self.assertNotIn(banned, raw)

    def test_food_identity_unknown_and_privacy(self):
        order = 'FE96NN7V0AOPFGA'
        data = {'status': 'success', 'data': {'orderNr': order, 'status': 'delivered',
                'rider': {'phone': 'PRIVATE'}, 'customer': {'name': 'PRIVATE'}, 'estimate': 'PRIVATE'}}
        result = v.food_projection(data, order)
        self.assertEqual(result['status'], 'delivered')
        self.assertNotIn('PRIVATE', str(result))
        self.assertIsNone(result['rider'])
        data['data']['status'] = 'future_state'
        self.assertEqual(v.food_projection(data, order)['status'], 'unknown')
        with self.assertRaises(v.NoonError): v.food_projection(data, 'FOTHER')

    def test_deny_before_network(self):
        with patch.object(v.urllib.request, 'build_opener') as network:
            for route, order in [('cancel', self.order), ('food_track', '../bad'), ('marketplace_manifest', 'FOTHER')]:
                with self.assertRaises(v.NoonError): v._read(route, {}, time.monotonic()+5, order)
            for timeout in (False, 0, 61, float('nan')):
                with self.assertRaises(v.NoonError): v.track(self.order, 'marketplace', timeout)
            network.assert_not_called()

    def test_food_list_delivered_requires_agreement(self):
        row = {'orderNr': 'FE96NN7V0AOPFGA', 'orderStatusCode': 'delivered',
               'isDelivered': True, 'logisticsStatusCode': 'delivered'}
        with patch.object(v, '_headers', return_value={}), patch.object(v, '_read') as read:
            read.return_value = {'status': 'success', 'data': {'orders': [row], 'pages': 1}}
            self.assertEqual(v.food_orders()['orders'][0]['status'], 'delivered')
            row['isDelivered'] = False
            result = v.food_orders()
            self.assertEqual(result['orders'][0]['status'], 'unknown')
            self.assertFalse(result['coverage']['food']['exhaustive'])

    def test_http_error_sanitized_and_closed(self):
        error = v.urllib.error.HTTPError('https://private.invalid/SECRET', 403, 'SECRET', {}, None)
        with patch.object(v.urllib.request, 'build_opener') as build:
            build.return_value.open.side_effect = error
            with self.assertRaisesRegex(v.NoonError, '^AUTH_FORBIDDEN$'):
                v._read('food_track', {}, time.monotonic()+5, 'FE96NN7V0AOPFGA')

    def test_deadline_and_oversize(self):
        with self.assertRaisesRegex(v.NoonError, '^NATIVE_READ_TIMEOUT$'):
            v._read('food_track', {}, time.monotonic()-1, 'FE96NN7V0AOPFGA')
        with patch.object(v.urllib.request, 'build_opener') as build:
            response = build.return_value.open.return_value.__enter__.return_value
            response.read.return_value = b'x' * (v.core.MAX_BYTES + 1)
            with self.assertRaisesRegex(v.NoonError, '^RESPONSE_TOO_LARGE$'):
                v._read('food_track', {}, time.monotonic()+5, 'FE96NN7V0AOPFGA')

    def test_nownow_identity_agreement_privacy_and_unverified_states(self):
        order = 'NNG9UNNZOHP800MA'
        detail = {'data': {'orderNr': order, 'orderStatusCode': 'delivered',
                          'logisticsStatusCode': 'delivered', 'customerStatusCode': 'delivered',
                          'paymentClientSecret': 'PRIVATE'}}
        tracking = {'data': {'status': 'delivered', 'orderStatusCode': 'delivered',
                            'rider': {'phone': 'PRIVATE'}}}
        out = v.nownow_projection(detail, tracking, order)
        self.assertEqual(out['status'], 'delivered')
        self.assertNotIn('PRIVATE', str(out))
        with self.assertRaises(v.NoonError): v.nownow_projection(detail, tracking, 'NNOTHER')
        tracking['data']['status'] = 'canceled'
        self.assertEqual(v.nownow_projection(detail, tracking, order)['status'], 'unknown')
        for state, expected in [('canceled', 'cancelled'), ('preparing', 'unknown')]:
            for k in ('orderStatusCode', 'logisticsStatusCode', 'customerStatusCode'): detail['data'][k] = state
            tracking['data'].update(status=state, orderStatusCode=state)
            self.assertEqual(v.nownow_projection(detail, tracking, order)['status'], expected)

    def test_nownow_requires_detail_before_tracking(self):
        with patch.object(v, '_headers', return_value={}), patch.object(v, '_read') as read:
            read.return_value = {'data': {'orderNr': 'NNOTHER'}}
            with self.assertRaises(v.NoonError): v.track('NNG9UNNZOHP800MA', 'nownow')
            self.assertEqual(read.call_count, 1)
            self.assertEqual(read.call_args.args[0], 'nownow_detail')

    def test_nownow_list_unknown_on_conflict_and_duplicate_rejected(self):
        row = {'orderNr': 'NNG9UNNZOHP800MA', 'orderStatusCode': 'delivered',
               'logisticsStatusCode': 'delivered', 'customerStatusCode': 'delivered'}
        with patch.object(v, '_headers', return_value={}), patch.object(v, '_read') as read:
            read.return_value = {'data': {'orders': [row], 'pages': 1}}
            self.assertEqual(v.nownow_orders()['orders'][0]['status'], 'delivered')
            row['customerStatusCode'] = 'canceled'
            self.assertEqual(v.nownow_orders()['orders'][0]['status'], 'unknown')
            read.return_value['data']['orders'].append(dict(row))
            with self.assertRaises(v.NoonError): v.nownow_orders()

    def test_duplicate_json_keys_and_truncated_json(self):
        for raw, code in [(b'{"data":{},"data":{}}', 'DUPLICATE_JSON_KEY'),
                          (b'{"data":', 'NATIVE_READ_FAILED')]:
            with patch.object(v.urllib.request, 'build_opener') as build:
                build.return_value.open.return_value.__enter__.return_value.read.return_value = raw
                with self.assertRaisesRegex(v.NoonError, '^' + code + '$'):
                    v._read('nownow_orders', {}, time.monotonic()+5)

    def test_nownow_routes_are_literal_read_only(self):
        with patch.object(v.urllib.request, 'build_opener') as build:
            build.return_value.open.return_value.__enter__.return_value.read.return_value = b'{"data":{}}'
            for route, suffix, method, body in [
                ('nownow_track', 'tracking/NNG9UNNZOHP800MA', 'GET', None),
                ('nownow_detail', 'details', 'POST', {'orderNr': 'NNG9UNNZOHP800MA'}),
                ('nownow_orders', 'history', 'POST', {})]:
                v._read(route, {}, time.monotonic()+5, None if route == 'nownow_orders' else 'NNG9UNNZOHP800MA')
                req = build.return_value.open.call_args.args[0]
                self.assertEqual(req.full_url, 'https://api-app-fd.noon.com/_svc/mp-shop-api-mpnoon/v1/order/' + suffix)
                self.assertEqual(req.method, method)
                self.assertEqual(json.loads(req.data) if req.data else None, body)


if __name__ == '__main__':
    unittest.main()
