"""Synthetic history contracts; no account, network or Keychain access."""
import json
import time
import unittest
import urllib.parse
from unittest.mock import patch

import careem_http_orders
import noon_http_orders as core
import noon_vertical_reads as vertical


class History(unittest.TestCase):
    def test_separate_zone_is_required_for_legacy_wall_time(self):
        for value, zone, expected in (
            ('2026-11-01T10:20:30', '+04:00', '2026-11-01T10:20:30+04:00'),
            ('2026-11-01T10:20:30.123', '+04:00', '2026-11-01T10:20:30.123000+04:00'),
            ('2026-11-01T10:20:30Z', None, '2026-11-01T10:20:30+00:00'),
            ('2026-11-01T10:20:30+04:00', None, '2026-11-01T10:20:30+04:00'),
            ('2026-11-01T10:20:30', None, None),
            ('2026-11-01T10:20:30', 'Asia/Dubai', None),
            ('2026-11-01T10:20:30', '+03:00', None),
            ('2026-11-01', '+04:00', None),
            ('2026-02-30T10:20:30', '+04:00', None),
            (False, '+04:00', None),
        ):
            with self.subTest(value=value, zone=zone):
                self.assertEqual(vertical.placed_time({'createdAt': value, 'timeZone': zone}), expected)

    def test_page_payload_and_invalid_forms(self):
        for lane in ('food', 'nownow'):
            with patch.object(vertical.urllib.request, 'build_opener') as build:
                response = build.return_value.open.return_value.__enter__.return_value
                response.read.return_value = b'{"data":{}}'
                vertical._read(lane + '_orders', {}, time.monotonic()+5, page=2)
                req = build.return_value.open.call_args.args[0]
                self.assertEqual(json.loads(req.data), {'page': 2, 'limit': 10})
                self.assertEqual(req.method, 'POST')
            for page in (0, -1, True, 1.5, '2', 101):
                with self.subTest(lane=lane, page=page), patch.object(vertical, '_headers') as headers:
                    with self.assertRaises(core.NoonError):
                        getattr(vertical, lane+'_orders')(page=page)
                    headers.assert_not_called()

    def test_last_page_and_schema_fail_closed(self):
        self.assertFalse(vertical.list_coverage({'pages': 4}, 2, 10)['exhaustive'])
        self.assertTrue(vertical.list_coverage({'pages': 4}, 4, 3)['exhaustive'])
        self.assertTrue(vertical.list_coverage({'pages': 4}, 5, 0)['exhaustive'])
        for pages, page, count in ((True, 1, 1), (None, 1, 1), (0, 1, 1), (4, 2, 3), (4, 5, 1)):
            with self.subTest(pages=pages, page=page, count=count), self.assertRaises(core.NoonError):
                vertical.list_coverage({'pages': pages}, page, count)

    @staticmethod
    def page(oid, more, cursor):
        return {'data': [{'orderNr': oid, 'itemNr': oid+'-1', 'shipmentNr': oid+'-S1',
                          'status': {'highStatusCode': 'delivered'}}],
                'pagination': {'hasMore': more, 'nextCursor': cursor}}

    def test_marketplace_cursor_chain_and_terminal_page(self):
        pages = [self.page('NTEST1', True, 'cursor-one'), self.page('NTEST2', False, None)]
        with patch.object(core, 'verified_session', return_value={}), patch.object(core, 'request', side_effect=pages) as request:
            result = core.orders('marketplace', page=2)
        self.assertEqual([r['order'] for r in result['orders']], ['NTEST2'])
        self.assertEqual([c.kwargs['cursor'] for c in request.call_args_list], ['', 'cursor-one'])
        self.assertTrue(result['coverage']['marketplace']['exhaustive'])
        self.assertFalse(result['coverage']['marketplace']['history_first_page_only'])
        self.assertFalse(result['coverage']['marketplace']['ordered_by_placed_at'])

    def test_cursor_wire_scope_and_standalone_out_of_range(self):
        with patch.object(core.urllib.request, 'build_opener') as build:
            response = build.return_value.open.return_value.__enter__.return_value
            response.read.return_value = b'{"data":[]}'
            core.request('marketplace_history', {}, time.monotonic()+5, cursor='opaque+/=')
            req = build.return_value.open.call_args.args[0]
            url = urllib.parse.urlsplit(req.full_url)
            self.assertEqual(url.netloc, 'api-app.noon.com')
            self.assertEqual(url.path, '/_svc/order-v2/orders/history')
            self.assertEqual(urllib.parse.parse_qs(url.query), {'limit':['10'], 'cursor':['opaque+/=']})
            self.assertEqual(req.method, 'GET')
        for service, page, cursor in (('minutes', 2, 'c'), ('marketplace', 1, 'c'),
                                       ('marketplace', 2, ''), ('marketplace', 2, True)):
            with patch.object(core, 'verified_session') as session, self.assertRaises(core.NoonError):
                core.orders(service, page=page, cursor=cursor)
            session.assert_not_called()
        with patch.object(core, 'verified_session', return_value={}), \
                patch.object(core, 'request', return_value=self.page('NTEST1', False, None)), \
                self.assertRaisesRegex(core.NoonError, 'HISTORY_PAGE_OUT_OF_RANGE'):
            core.orders('marketplace', page=2)

    def test_default_read_preserves_unpaged_contract(self):
        with patch.object(core, 'verified_session', return_value={}), \
                patch.object(core, 'request', return_value={'data': []}) as request:
            result = core.orders('marketplace')
        self.assertTrue(result['coverage']['marketplace']['history_first_page_only'])
        self.assertTrue(all(not call.kwargs for call in request.call_args_list))

    def test_repeated_history_and_invalid_cursor_metadata_fail_closed(self):
        for second in (self.page('NTEST1', False, None), self.page('NTEST2', True, 'cursor-one'),
                       {'data': [], 'pagination': {'hasMore': 'false'}}):
            with patch.object(core, 'verified_session', return_value={}), patch.object(core, 'request', side_effect=[
                    self.page('NTEST1', True, 'cursor-one'), second]):
                with self.assertRaises(core.NoonError):
                    core.orders('marketplace', page=2)

    def test_careem_list_stays_gated_without_auth_calls(self):
        with patch.object(careem_http_orders.auth, 'account') as account, \
                patch.object(careem_http_orders.auth, '_transport') as transport:
            with self.assertRaisesRegex(careem_http_orders.CareemError, 'ORDER_LIST_HOST_BINDING_UNVERIFIED'):
                careem_http_orders.orders()
            account.assert_not_called()
            transport.assert_not_called()
