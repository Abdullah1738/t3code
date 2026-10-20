import copy
import unittest
from unittest.mock import patch

import talabat_delivery_address as address
import talabat_http_orders as http
import talabat_http_list as listing
from test.test_talabat_http_orders import saved


HOME = 'Banyan Tree Residences • Hillside, 21, 2104, Banyantree, Jumeirah Lakes Towers - JLT'
OFFICE = '901, 9, Example Office Tower, JLT, Dubai'


def screen(text=HOME, label='Apartment', order='123'):
    return {'type': 'OrderTrackingScreen', 'common_tracking_event_attributes': {
        'order_id': order, 'delivery_status': 'order_delivered'},
        'layouts': [{'name': 'body', 'column': ['tlb_app_bff_passthrough']}],
        'widgets': {'tlb_app_bff_passthrough': {'type': 'FluidComponent', 'data': {
            'component': {'properties': {'children': [{'template_id': 'delivery_address', 'properties': {
                'title': label, 'address_text': text, 'header': 'Delivered to', 'tracking_key': '',
                'change_address_deeplink': 'private-action-never-follow'}}]}},
            'templates': {'private': 'never inspect'}}}}}


def children(data):
    return data['widgets']['tlb_app_bff_passthrough']['data']['component']['properties']['children']


class AddressTest(unittest.TestCase):
    def test_real_shaped_home_and_office_differentiate_without_search_pin(self):
        home = http.project(screen(), '123')
        office = http.project(screen(OFFICE, 'Work'), '123')
        self.assertIs(home['is_home'], True)
        self.assertIs(office['is_home'], False)
        self.assertEqual(office['delivery_address']['text'], OFFICE)
        self.assertEqual(office['delivery_address']['label'], 'Work')
        self.assertIsNone(home['delivery_address']['lat'])
        self.assertIsNone(home['delivery_address']['address_id'])
        self.assertNotIn('private', str(home))

    def test_generic_label_flat_or_nearby_name_cannot_prove_home(self):
        for text in [None, '', 'Home', '2104', 'Banyantree Hillside', HOME.replace('2104', '21040')]:
            with self.subTest(text=text):
                self.assertIsNone(address.project(screen(text, 'Home'), '123')['is_home'])
        self.assertIs(address.project(screen(HOME.replace('2104', 'Flat 2105')), '123')['is_home'], False)

    def test_hidden_unreferenced_duplicate_and_foreign_addresses_are_unknown(self):
        for mode in ['hidden', 'unreferenced', 'duplicate', 'foreign', 'templates_only', 'wrong_order']:
            data = screen()
            if mode == 'hidden': children(data)[0]['properties']['hidden'] = True
            if mode == 'unreferenced': data['layouts'][0]['column'] = []
            if mode == 'duplicate': children(data).append(copy.deepcopy(children(data)[0]))
            if mode == 'foreign': children(data)[0]['properties']['tracking_key'] = '456'
            if mode == 'templates_only':
                data['widgets']['tlb_app_bff_passthrough']['data']['templates']['address'] = children(data).pop()
            if mode == 'wrong_order': data['common_tracking_event_attributes']['order_id'] = '456'
            with self.subTest(mode=mode):
                self.assertIsNone(address.project(data, '123')['delivery_address'])

    def test_list_only_adds_detail_requests_when_requested(self):
        account = saved()
        page = {'orders': [{'id': 123, 'status': 'Delivered'}], 'total_orders': 1, 'is_last_page': True}
        with patch.object(http, 'account', return_value=account), patch.object(listing, 'page_request', return_value=page), \
                patch.object(http, 'request', side_effect=[account['expected_profile'], account['expected_profile'], screen(OFFICE)]) as request:
            bare = listing.list_orders()
            enriched = listing.list_orders(with_addresses=True)
        self.assertIsNone(bare['orders'][0]['is_home'])
        self.assertEqual(bare['orders'][0]['home_match_reason'], 'detail_read_required')
        self.assertIs(enriched['orders'][0]['is_home'], False)
        self.assertEqual([c.args[0] for c in request.call_args_list], [http.PROFILE, http.PROFILE, http.TRACKING + '123'])

    def test_missing_order_detail_preserves_list_row_as_unknown(self):
        account = saved()
        page = {'orders': [{'id': 123, 'status': 'Delivered'}], 'total_orders': 1, 'is_last_page': True}
        with patch.object(http, 'account', return_value=account), patch.object(listing, 'page_request', return_value=page), \
                patch.object(http, 'request', side_effect=[account['expected_profile'], http.TalabatError('ORDER_NOT_FOUND')]):
            result = listing.list_orders(with_addresses=True)
        self.assertIsNone(result['orders'][0]['is_home'])
        self.assertEqual(result['orders'][0]['delivery_address_error'], 'ORDER_NOT_FOUND')
