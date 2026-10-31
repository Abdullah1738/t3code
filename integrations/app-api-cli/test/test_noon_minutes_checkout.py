"""Synthetic fixtures; never loads account storage or makes live requests."""
import copy
from decimal import Decimal
from email.message import Message
import gzip
import hashlib
import io
import json
import time
import unittest
from unittest.mock import patch
import urllib.error

import noon_minutes_checkout as m
from noon_checkout import AccountHome, fingerprint


HEADERS = {'x-addresscode': 'SYNTHETIC_HOME', 'x-addresskey': 'SYNTHETIC_KEY',
           'cookie': 'synthetic-secret', 'x-experience': 'nooninstant'}


def fixture():
    return {'items': [{'sku': 'SYNTHETIC_SHAKE', 'qty': 1, 'title': 'Vanilla shake',
                       'price': 12.5, 'offerPrice': 12.5, 'qtyMax': 4,
                       'selectedModifiers': {}, 'isFreebie': False, 'itemCode': 'SYNTHETIC_SHAKE'}],
            'currencyCode': 'AED', 'orderSubtotal': 12.5, 'orderTotal': 20.5,
            'orderPaymentAmount': 20.5, 'walletAmount': 0, 'paymentMethodCode': 'cc_noonpay',
            'paymentToken': 'synthetic-payment-token', 'creditCardMask': 'xxxx 2342',
            'ccType': 'mastercard', 'isCvvRequired': False, 'verifyDevice': False,
            'idEmiPlan': None, 'isShutdown': False,
            'orderSummary': [{'entries': [{'title': 'Subtotal', 'value': 'AED 12.50'},
                                         {'title': 'Delivery fee', 'value': 'AED 8.00'}]},
                             {'entries': [{'title': 'Total', 'value': '<b>AED 20.50</b>'}]}],
            'deliveryPreferences': [{'code': 'synthetic_leave', 'value': True, 'title': 'Leave at door'},
                                    {'code': 'synthetic_quiet', 'value': True, 'title': 'Do not ring bell'}],
            'driverNotes': m.QUIET_NOTE}


class Harness:
    def __init__(self, responses=None):
        self.calls = []
        self.reservations = []
        self.receipts = []
        self.cookies = []
        self.responses = list(responses or [fixture()])
        self.home = AccountHome('minutes', fingerprint('synthetic-account'),
                                fingerprint(HEADERS['x-addresscode'], HEADERS['x-addresskey']), time.time())
        self.client = m.MinutesCheckout(HEADERS, self.home, request=self.request,
            receipt=self.receipt, response_cookies=self.response_cookies)

    def request(self, route, headers, deadline, payload, *, response_observer):
        self.calls.append((route, copy.deepcopy(payload)))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        response_observer(m.ResponseObservation('https://' + m.ROUTES[route][1] + m.ROUTES[route][2], 200, ()))
        return response

    def receipt(self, value):
        self.receipts.append(copy.deepcopy(value))
        return True

    def response_cookies(self, route, values, **metadata):
        self.cookies.append((route, values, metadata))
        return True

    def reserve(self, route, digest):
        self.reservations.append((route, digest))
        return True


class WireTests(unittest.TestCase):
    def test_plain_null_modifiers_follow_native_empty_projection(self):
        data=fixture();data['items'][0]['selectedModifiers']=None
        self.assertEqual(m.project_session(data)['lines'][0]['modifiers'],[])
        for value in ([], False, 'unknown'):
            data['items'][0]['selectedModifiers']=value
            with self.assertRaises(m.MinutesError):m.project_session(data)
        data['items'][0]['selectedModifiers']=None
        data['items'][0]['isCustomizable']=True
        with self.assertRaises(m.MinutesError):m.project_session(data)

    def test_payment_preserves_observed_null_optional_fields(self):
        h=Harness([{'status':'payment_pending'}])
        h.client.complete_payment(order='IAEGA123',client_secret='synthetic-secret',
            card=m.SavedCard('synthetic-token','xxxx2342','mastercard'),provider_code='NOON_PAY',
            cvv_encryption=None,optional_fields={'installments':None,'paymentType':None,'idEmiPlan':None},
            before_send=h.reserve)
        body=h.calls[0][1]
        self.assertIsNone(body['installments']);self.assertIsNone(body['paymentType'])
        self.assertNotIn('applePayToken',body)
        with self.assertRaises(m.MinutesError):
            h.client.complete_payment(order='IAEGA123',client_secret='synthetic-secret',
                card=m.SavedCard('synthetic-token','xxxx2342','mastercard'),provider_code='NOON_PAY',
                cvv_encryption=None,optional_fields={'installments':3},before_send=h.reserve)

    def test_session_get_empty_and_refresh_body(self):
        h = Harness([fixture(), fixture()])
        h.client.get_session(before_send=h.reserve)
        h.client.get_session(refresh=True, before_send=h.reserve)
        self.assertEqual(h.calls, [('session_get', {}), ('session_get', {'refresh': True})])

    def test_full_sku_and_bundle_body(self):
        h = Harness()
        sku = m.sku_line('SKU1', 2, modifiers=['MOD1'], atc_source='organic')
        bundles = [{'campaign': 'CAMPAIGN1', 'qty': 1,
                    'items': [{'code': 'SLOT1', 'sku': 'SKU2', 'modifiers': []}]}]
        h.client.sync(skus=[sku], bundles=bundles, refresh=True, before_send=h.reserve)
        self.assertEqual(h.calls[0], ('sync', {'skus': [sku], 'bundles': bundles, 'refresh': True}))
        self.assertNotIn('whCode', h.calls[0][1])
        self.assertNotIn('offerCode', h.calls[0][1]['skus'][0])

    def test_deal_wire_has_one_quantity(self):
        self.assertEqual(m.sku_line('S', 1, deal_code='D')['dealCode'], 'D')
        with self.assertRaisesRegex(m.MinutesError, 'DEAL_QUANTITY'):
            m.sku_line('S', 2, deal_code='D')

    def test_no_unmapped_line_fields(self):
        h = Harness()
        with self.assertRaisesRegex(m.MinutesError, 'INVALID_LINE'):
            h.client.sync(skus=[{'sku':'S', 'qty':1, 'modifiers':[], 'offerCode':'GUESSED'}],
                          bundles=[], refresh=True, before_send=h.reserve)
        self.assertEqual(h.calls, [])

    def test_boolean_quantity_and_duplicate_line_denied(self):
        with self.assertRaisesRegex(m.MinutesError, 'INVALID_QUANTITY'):
            m.sku_line('S', True)
        h = Harness()
        with self.assertRaisesRegex(m.MinutesError, 'DUPLICATE_LINE'):
            h.client.sync(skus=[m.sku_line('S',1)]*2, bundles=[], refresh=True, before_send=h.reserve)

    def test_instruction_codes_and_notes_roundtrip(self):
        h = Harness()
        snap = h.client.set_delivery_instructions(preferences={'synthetic_quiet': True},
            driver_notes=m.QUIET_NOTE, save=False, before_send=h.reserve)
        self.assertEqual(h.calls[0][1], {'deliveryPreferences': {'synthetic_quiet': True},
                                       'driverNotes': m.QUIET_NOTE, 'save': False})
        self.assertEqual(snap.projection['driver_notes'], m.QUIET_NOTE)

    def test_exact_saved_card_and_no_wallet(self):
        h = Harness()
        card = m.SavedCard('synthetic-payment-token', 'xxxx 2342', 'mastercard')
        snap = h.client.set_payment_method(card=card, before_send=h.reserve)
        self.assertEqual(h.calls[0][1], {'paymentMethodCode': 'cc_noonpay',
            'paymentToken': card.token, 'creditCardMask': card.mask, 'walletAmount': 0, 'idEmiPlan': None})
        self.assertEqual(snap.selected_card(), card)
        self.assertNotIn(card.token, repr(card))
        self.assertNotIn(card.token, repr(snap))

    def test_wrong_card_denied_before_reservation(self):
        h = Harness()
        for mask, network in [('xxxx 1234','mastercard'), ('xxxx 2342','visa'), ('123456782342','mastercard')]:
            with self.assertRaisesRegex(m.MinutesError, 'CARD_MISMATCH'):
                h.client.set_payment_method(card=m.SavedCard('token',mask,network), before_send=h.reserve)
        self.assertEqual(h.calls, [])
        self.assertEqual(h.reservations, [])

    def test_native_cards_shape_selects_unique_order_card(self):
        data={'data':[{'id':'synthetic-id','ccMasked':'54321098xxxx2342','ccType':'MASTERCARD',
                       'isDefault':True,'isDeleted':False},
                      {'id':'other','ccMasked':'xxxx1111','ccType':'VISA','isDeleted':False}]}
        card=m.saved_order_card(data)
        self.assertEqual(card.token,'synthetic-id')
        self.assertNotIn('543210',repr(card))
        self.assertNotIn('synthetic-id',json.dumps(m.project_cards(data)))
        data['data'].append(data['data'][0])
        with self.assertRaisesRegex(m.MinutesError,'SAVED_CARD_NOT_UNIQUE'):
            m.saved_order_card(data)

    def test_payload_detached_before_journal_callback(self):
        h=Harness([{'status':'PENDING'}])
        encryption={'encCvv':'synthetic-ciphertext','publicKeyName':'key-name'}
        def reserve(*_):
            encryption['encCvv']='changed-after-binding'
            return True
        h.client.complete_payment(order='ISYNTHETIC1',client_secret='intent',
            card=m.SavedCard('token','xxxx2342','mastercard'),provider_code='NOON_PAY',
            cvv_encryption=encryption,before_send=reserve)
        self.assertEqual(h.calls[0][1]['cvvEncryption']['encCvv'],'synthetic-ciphertext')

    def test_order_place_exact_total_body(self):
        h = Harness([{'success':True,'order_nr':'ISYNTHETIC1'}])
        result = h.client.place_order(total_minor=2050, before_send=h.reserve)
        self.assertEqual(h.calls, [('place', {'total':20.5})])
        self.assertTrue(result['accepted'])
        self.assertEqual(result['state'],'order_created_payment_unconfirmed')

    def test_order_creation_failure_keeps_order_identity(self):
        out = m.project_place({'success':False, 'order_nr':'ISYNTHETIC1', 'error_modal':{'title':'private'}})
        self.assertFalse(out['accepted'])
        self.assertEqual(out['order'],'ISYNTHETIC1')
        self.assertFalse(out['resend_allowed'])
        self.assertNotIn('private',json.dumps(out))

    def test_timeout_no_retry_and_ambiguous_flag(self):
        h = Harness([TimeoutError('synthetic-secret')])
        with self.assertRaises(m.MinutesError) as raised:
            h.client.place_order(total_minor=2050, before_send=h.reserve)
        self.assertTrue(raised.exception.may_have_sent)
        self.assertEqual(str(raised.exception),'REQUEST_FAILED')
        self.assertEqual(len(h.calls),1)

    def test_401_no_refresh_or_retry(self):
        h = Harness([m.MinutesError('AUTH_EXPIRED')])
        with self.assertRaises(m.MinutesError) as raised:
            h.client.set_payment_method(card=m.SavedCard('token','****2342','mastercard'), before_send=h.reserve)
        self.assertEqual(str(raised.exception),'AUTH_EXPIRED')
        self.assertTrue(raised.exception.may_have_sent)
        self.assertEqual(len(h.calls),1)

    def test_journal_consumed_before_send_and_denied_replay(self):
        h = Harness([{'success':True,'order_nr':'ISYNTHETIC1'}])
        consumed = set()
        def durable_seam(route, digest):
            self.assertEqual(h.calls, [])
            if route in consumed:
                return False
            consumed.add(route)
            return True
        h.client.place_order(total_minor=2050, before_send=durable_seam)
        with self.assertRaisesRegex(m.MinutesError,'SEND_RESERVATION_DENIED'):
            h.client.place_order(total_minor=2050,before_send=lambda *_:False)
        self.assertEqual(len(h.calls),1)

    def test_missing_or_failed_journal_never_sends(self):
        h = Harness()
        with self.assertRaisesRegex(m.MinutesError,'SEND_JOURNAL_REQUIRED'):
            h.client.get_session(before_send=None)
        def bad(*_):
            raise RuntimeError('secret')
        with self.assertRaisesRegex(m.MinutesError,'SEND_RESERVATION_FAILED'):
            h.client.get_session(before_send=bad)
        self.assertEqual(h.calls, [])

    def test_parse_failure_after_send_is_ambiguous(self):
        h = Harness([{'items':'invalid'}])
        with self.assertRaises(m.MinutesError) as raised:
            h.client.get_session(before_send=h.reserve)
        self.assertTrue(raised.exception.may_have_sent)

    def test_verified_account_age_and_address_binding(self):
        h = Harness()
        for home in [AccountHome('main',h.home.account_ref,h.home.address_ref,time.time()),
                     AccountHome('minutes',h.home.account_ref,h.home.address_ref,time.time()-121),
                     AccountHome('minutes',h.home.account_ref,fingerprint('wrong'),time.time())]:
            client = m.MinutesCheckout(HEADERS,home,request=h.request,
                                      receipt=h.receipt,response_cookies=h.response_cookies)
            code = 'ADDRESS_BINDING_MISMATCH' if home.address_ref != h.home.address_ref else 'VERIFIED_ACCOUNT_REQUIRED'
            with self.assertRaisesRegex(m.MinutesError, code):
                client.get_session(before_send=h.reserve)
        self.assertEqual(h.calls, [])

    def test_pending_payment_has_separate_explicit_continuation(self):
        h = Harness([{'statusCode':'pending','paymentIntentToken':'private-intent'},
                     {'status':'PENDING','redirect_url':'https://challenge.invalid/private'}])
        status = h.client.order_status('ISYNTHETIC1')
        self.assertEqual(status.projection['state'],'payment_action_required')
        self.assertNotIn('private-intent',repr(status))
        payment = h.client.complete_payment(order='ISYNTHETIC1',client_secret=status.wire['paymentIntentToken'],
            card=m.SavedCard('token','****2342','mastercard'),provider_code='NOON_PAY',
            cvv_encryption=None,before_send=h.reserve)
        self.assertEqual(payment.projection['state'],'human_payment_challenge')
        self.assertNotIn('https://',repr(payment))
        self.assertEqual([x[0] for x in h.calls],['order_get','payment_complete'])
        self.assertEqual(h.calls[1][1],{'clientSecret':'private-intent','paymentMethodCode':'cc_noonpay',
            'idCustomerToken':'token','cvvEncryption':None,'paymentProviderCode':'NOON_PAY'})

    def test_plain_cvv_denied(self):
        h = Harness()
        with self.assertRaisesRegex(m.MinutesError,'ENCRYPTED_CVV_REQUIRED'):
            h.client.complete_payment(order='ISYNTHETIC1',client_secret='intent',
                card=m.SavedCard('token','****2342','mastercard'), provider_code='NOON_PAY',
                cvv_encryption='123',before_send=h.reserve)
        self.assertEqual(h.calls, [])

    def test_order_echo_mismatch(self):
        with self.assertRaisesRegex(m.MinutesError,'ORDER_MISMATCH'):
            m.project_order_get({'statusCode':'confirmed','orderNr':'IWRONG'},'ISYNTHETIC1')


class ProjectionTests(unittest.TestCase):
    def snapshot(self, data=None):
        data = data or fixture()
        return m.Snapshot(data,m.project_session(data),time.time())

    def review(self,snapshot):
        return m.review_snapshot(snapshot,expected_skus=[m.sku_line('SYNTHETIC_SHAKE',1)],
            expected_total_minor=2050,required_preferences=['synthetic_leave','synthetic_quiet'],
            card=m.SavedCard('synthetic-payment-token','xxxx 2342','mastercard'))

    def test_complete_lines_summary_and_private_token_hash(self):
        p = self.snapshot().projection
        self.assertEqual(len(p['lines']),1)
        self.assertEqual(len(p['summary']),3)
        self.assertEqual(p['summary'][-1]['value'],'AED 20.50')
        self.assertEqual(p['total_minor'],2050)
        self.assertNotIn('synthetic-payment-token',json.dumps(p))
        self.assertFalse(p['complete_fee_arithmetic_verified'])

    def test_review_exact_bindings(self):
        self.assertRegex(self.review(self.snapshot()),r'^[a-f0-9]{64}$')
        for key,value in [('walletAmount',1),('orderPaymentAmount',19.5),('paymentToken','wrong'),
                          ('isCvvRequired',True),('verifyDevice',True),('driverNotes','Ring bell'),('orderTotal',21)]:
            data=fixture();data[key]=value
            with self.subTest(key=key), self.assertRaises(m.MinutesError):
                self.review(self.snapshot(data))

    def review_quiet(self, data, required, note=m.QUIET_NOTE):
        return m.review_snapshot(self.snapshot(data),expected_skus=[m.sku_line('SYNTHETIC_SHAKE',1)],
            expected_total_minor=2050,required_preferences=required,
            card=m.SavedCard('synthetic-payment-token','xxxx 2342','mastercard'),driver_note=note)

    def test_only_dont_ring_bell_offered_passes_with_note(self):
        data=fixture();data['deliveryPreferences']=[{'code':'dont_ring_the_bell','value':True,'title':'Do not ring bell'}]
        self.assertRegex(self.review_quiet(data,('dont_ring_the_bell',)),r'^[a-f0-9]{64}$')

    def test_offered_toggle_not_true_refuses(self):
        data=fixture();data['deliveryPreferences']=[{'code':'dont_ring_the_bell','value':True,'title':None},
                                                    {'code':'leave_it_at_my_door','value':False,'title':None}]
        with self.assertRaisesRegex(m.MinutesError,'QUIET_PREFERENCE_MISMATCH'):
            self.review_quiet(data,('dont_ring_the_bell','leave_it_at_my_door'))

    def test_empty_required_preferences_refuses(self):
        with self.assertRaisesRegex(m.MinutesError,'QUIET_PREFERENCE_MISMATCH'):
            self.review_quiet(fixture(),())

    def test_driver_note_tolerates_curly_quotes_and_whitespace(self):
        data=fixture();data['driverNotes']="Leave at door. Don\u2019t ring bell.  Don't  call. "
        self.assertRegex(self.review_quiet(data,('synthetic_quiet',)),r'^[a-f0-9]{64}$')

    def test_driver_note_ring_bell_still_refuses(self):
        data=fixture();data['driverNotes']='Ring bell'
        with self.assertRaisesRegex(m.MinutesError,'QUIET_NOTES_MISMATCH'):
            self.review_quiet(data,('synthetic_quiet',))

    def test_extra_note_passes_only_when_included(self):
        extra=m.quiet_note('Gate code 1234')
        data=fixture();data['driverNotes']=extra
        self.assertRegex(self.review_quiet(data,('synthetic_quiet',),note=extra),r'^[a-f0-9]{64}$')
        with self.assertRaisesRegex(m.MinutesError,'QUIET_NOTES_MISMATCH'):
            self.review_quiet(data,('synthetic_quiet',))

    def test_quiet_note_extra_validation(self):
        self.assertEqual(m.quiet_note(),m.QUIET_NOTE)
        self.assertEqual(m.quiet_note('  Gate 1 '),m.QUIET_NOTE+' Gate 1')
        for bad in ('', '   ', 'x'*201, 'a\nb', 'a\rb', 5):
            with self.subTest(bad=bad), self.assertRaisesRegex(m.MinutesError,'DRIVER_NOTE_INVALID'):
                m.quiet_note(bad)

    def test_cvv_ask_refused_by_default_and_allowed_only_when_asked(self):
        data=fixture();data['isCvvRequired']=True
        with self.assertRaisesRegex(m.MinutesError,'PAYMENT_CHALLENGE_REQUIRED'):
            self.review(self.snapshot(data))
        digest=m.review_snapshot(self.snapshot(data),expected_skus=[m.sku_line('SYNTHETIC_SHAKE',1)],
            expected_total_minor=2050,required_preferences=['synthetic_leave','synthetic_quiet'],
            card=m.SavedCard('synthetic-payment-token','xxxx 2342','mastercard'),allow_cvv=True)
        self.assertRegex(digest,r'^[a-f0-9]{64}$')

    def test_verify_device_and_unknown_cvv_flag_always_refuse(self):
        for key,value,allow in [('verifyDevice',True,False),('verifyDevice',True,True),
                                ('isCvvRequired',None,True),('isCvvRequired',None,False)]:
            data=fixture();data[key]=value
            with self.subTest(key=key,value=value,allow=allow), self.assertRaises(m.MinutesError):
                m.review_snapshot(self.snapshot(data),expected_skus=[m.sku_line('SYNTHETIC_SHAKE',1)],
                    expected_total_minor=2050,required_preferences=['synthetic_leave','synthetic_quiet'],
                    card=m.SavedCard('synthetic-payment-token','xxxx 2342','mastercard'),allow_cvv=allow)

    def test_home_provider_refreshes_old_home_and_refuses_address_move(self):
        h=Harness([fixture()])
        old=AccountHome('minutes',h.home.account_ref,h.home.address_ref,time.time()-200)
        calls=[]
        def provider(deadline):
            calls.append(deadline)
            return AccountHome('minutes',h.home.account_ref,h.home.address_ref,time.time())
        client=m.MinutesCheckout(HEADERS,old,request=h.request,receipt=h.receipt,
            response_cookies=h.response_cookies,home_provider=provider)
        client.get_session(before_send=h.reserve)
        self.assertEqual(len(calls),1)
        self.assertEqual(len(h.calls),1)
        h2=Harness([fixture()])
        old2=AccountHome('minutes',h2.home.account_ref,h2.home.address_ref,time.time()-200)
        moved=AccountHome('minutes',h2.home.account_ref,fingerprint('moved-address'),time.time())
        client2=m.MinutesCheckout(HEADERS,old2,request=h2.request,receipt=h2.receipt,
            response_cookies=h2.response_cookies,home_provider=lambda deadline:moved)
        with self.assertRaisesRegex(m.MinutesError,'VERIFIED_ACCOUNT_CHANGED'):
            client2.get_session(before_send=h2.reserve)
        self.assertEqual(h2.calls,[])

    def test_unexpected_cart_item_never_ignored(self):
        data=fixture();data['items'].append(dict(data['items'][0],sku='UNOWNED_SKU'))
        snapshot=self.snapshot(data)
        self.assertEqual(len(snapshot.projection['lines']),2)
        with self.assertRaisesRegex(m.MinutesError,'MANIFEST_MISMATCH'):
            self.review(snapshot)

    def test_missing_totals_or_preferences_are_unknown(self):
        data=fixture();del data['orderSummary'];del data['deliveryPreferences'];del data['walletAmount']
        p=self.snapshot(data).projection
        self.assertIsNone(p['summary'])
        self.assertIsNone(p['delivery_preferences'])
        self.assertIsNone(p['payment']['wallet_minor'])

    def test_v2_summary_preserves_all_entries(self):
        data=fixture();data['orderSummaryRows']=data.pop('orderSummary')
        snapshot=self.snapshot(data)
        self.assertIsNone(snapshot.projection['summary'])
        self.assertEqual(len(snapshot.projection['summary_v2']),3)
        self.assertRegex(self.review(snapshot),r'^[a-f0-9]{64}$')

    def test_application_error_and_duplicate_preferences(self):
        data=fixture();data['error']={'message':'private'}
        with self.assertRaisesRegex(m.MinutesError,'APPLICATION_REJECTED'):
            self.snapshot(data)
        data=fixture();data['deliveryPreferences']*=2
        with self.assertRaisesRegex(m.MinutesError,'DUPLICATE_PREFERENCE'):
            self.snapshot(data)

    def test_money_precision_nonfinite_and_boolean(self):
        self.assertEqual(m.amount_minor(Decimal('20.50')),2050)
        for value in [True,'NaN',float('inf'),'1.001']:
            with self.subTest(value=value),self.assertRaises(m.MinutesError):
                m.amount_minor(value)

    def test_active_exact_tracking_and_eta(self):
        h=Harness([{'status':'picked_up','csHelpLabels':{'orderNumber':'ISYNTHETIC1'},
                    'title':'On the way','deliveryTime':7},
                   {'orders':[{'orderNr':'IOTHER','statusCode':'confirmed','placedAt':'2026-10-09T19:00:00+04:00',
                               'estimatedDeliveryText':'Arrives between: 09:00 - 09:10 PM'},
                              {'orderNr':'ISYNTHETIC1','statusCode':'picked_up','placedAt':'2026-10-09T19:00:00+04:00',
                               'estimatedDeliveryText':'Arrives between: 07:10 - 07:20 PM'}]}])
        out=h.client.track('ISYNTHETIC1')
        self.assertEqual(out['status'],'out for delivery')
        self.assertEqual(out['eta'],'2026-10-09T19:20:00+04:00')
        self.assertEqual(h.reservations,[])

    def test_eta_failure_preserves_exact_status(self):
        h=Harness([{'status':'confirmed','csHelpLabels':{'orderNumber':'ISYNTHETIC1'}},TimeoutError()])
        out=h.client.track('ISYNTHETIC1')
        self.assertEqual(out['status'],'placed')
        self.assertIn('eta_enrichment_unavailable',out['warnings'])

    def test_tracking_mismatch_does_not_enrich(self):
        h=Harness([{'status':'delivered','csHelpLabels':{'orderNumber':'IOTHER'}}])
        with self.assertRaisesRegex(m.MinutesError,'ORDER_MISMATCH'):
            h.client.track('ISYNTHETIC1')
        self.assertEqual(len(h.calls),1)


class TransportTests(unittest.TestCase):
    def native_client(self, h, *, body=b'{}', status=200, failure=None, events=None):
        events = events if events is not None else []
        values = ('a=one; Expires=Wed, 21 Oct 2026 07:28:00 GMT', 'a=two; Path=/')
        headers = Message()
        for value in values:
            headers.add_header('Set-Cookie', value)
        class Response:
            code = status
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def geturl(self): return 'https://api-app-instant.noon.com/_svc/instant/session/get'
            def read(self, _):
                events.append('read')
                if failure:
                    raise failure
                return body
        response = Response()
        response.headers = headers
        opener = unittest.mock.Mock()
        if status >= 300:
            error = urllib.error.HTTPError(response.geturl(), status, 'private', headers, io.BytesIO(body))
            opener.open.side_effect = error
        else:
            opener.open.return_value = response
        def receipt(record):
            events.append('receipt')
            return h.receipt(record)
        def cookies(*args, **kwargs):
            events.append('cookies')
            return h.response_cookies(*args, **kwargs)
        h.client = m.MinutesCheckout(HEADERS, h.home, receipt=receipt, response_cookies=cookies)
        return opener, events, values

    def test_native_decode_read_and_http_failures_receipted_before_cookies(self):
        for status, body, failure, code in [
            (200, b'{bad', None, 'INVALID_JSON'),
            (200, b'', OSError('private'), 'REQUEST_FAILED'),
            (401, b'private', None, 'AUTH_EXPIRED'),
            (403, b'private', None, 'AUTH_FORBIDDEN'),
            (302, b'private', None, 'HTTP_302'),
        ]:
            with self.subTest(status=status, code=code):
                h = Harness()
                opener, events, values = self.native_client(h, body=body, status=status, failure=failure)
                with patch.object(m.urllib.request, 'build_opener', return_value=opener):
                    with self.assertRaisesRegex(m.MinutesError, code) as raised:
                        h.client.get_session(before_send=h.reserve)
                    with self.assertRaisesRegex(m.MinutesError, 'MUTATION_FENCED'):
                        h.client.get_session(before_send=h.reserve)
                self.assertEqual(opener.open.call_count, 1)
                self.assertEqual(events[-2:], ['receipt', 'cookies'])
                self.assertEqual(h.receipts[0]['outcome'], 'UNKNOWN')
                self.assertEqual(h.receipts[0]['http_status'], status)
                self.assertEqual(h.cookies[0][1], values)
                self.assertTrue(h.cookies[0][2]['outcome_journaled'])
                self.assertEqual(h.cookies[0][2]['response_url'],
                                 'https://api-app-instant.noon.com/_svc/instant/session/get')
                self.assertEqual(raised.exception.receipt, h.receipts[0])
                self.assertTrue(raised.exception.outcome_journaled)
                self.assertNotIn('private', str(raised.exception))
                self.assertNotIn('a=one', repr(raised.exception.__dict__))

    def test_success_receipt_is_minimal_and_hash_bound(self):
        h = Harness()
        opener, events, values = self.native_client(h, body=json.dumps(fixture()).encode())
        with patch.object(m.urllib.request, 'build_opener', return_value=opener):
            h.client.get_session(before_send=h.reserve)
        self.assertEqual(events, ['read', 'receipt', 'cookies'])
        record = h.receipts[0]
        self.assertEqual(record['outcome'], 'RESPONSE_RECEIVED')
        self.assertEqual(record['request_sha256'], h.reservations[0][1])
        canonical = dict(record)
        evidence = canonical.pop('evidence_hash')
        self.assertEqual(evidence, hashlib.sha256(m._json(canonical)).hexdigest())
        encoded = json.dumps(record)
        for private in ('synthetic-payment-token', 'synthetic-secret', 'a=one', 'Vanilla', '2342', 'driverNotes'):
            self.assertNotIn(private, encoded)
        self.assertEqual(h.cookies[0][1], values)

    def test_timeout_without_response_journals_unknown_without_fabricated_metadata(self):
        h = Harness([TimeoutError('private')])
        with self.assertRaises(m.MinutesError):
            h.client.get_session(before_send=h.reserve)
        self.assertEqual(h.receipts[0]['outcome'], 'UNKNOWN')
        self.assertIsNone(h.receipts[0]['http_status'])
        self.assertEqual(h.cookies, [])
        with self.assertRaisesRegex(m.MinutesError, 'MUTATION_FENCED'):
            h.client.get_session(before_send=h.reserve)

    def test_receipt_exception_still_delivers_actual_rotation_in_ram(self):
        h = Harness()
        opener, _, values = self.native_client(h, body=json.dumps(fixture()).encode())
        def broken(_):
            raise OSError('private')
        h.client._receipt = broken
        with patch.object(m.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(m.MinutesError, 'RESPONSE_RECEIPT_FAILED') as raised:
                h.client.get_session(before_send=h.reserve)
        self.assertEqual(h.cookies[0][1], values)
        self.assertFalse(h.cookies[0][2]['outcome_journaled'])
        self.assertFalse(raised.exception.outcome_journaled)
        self.assertEqual(raised.exception.receipt['outcome'], 'RESPONSE_RECEIVED')

    def test_cookie_callback_failure_fences_after_durable_receipt(self):
        for fail in (False, RuntimeError('private')):
            h = Harness()
            def cookies(*args, **kwargs):
                self.assertEqual(len(h.receipts), 1)
                self.assertTrue(kwargs['outcome_journaled'])
                if isinstance(fail, Exception):
                    raise fail
                return fail
            h.client._response_cookies = cookies
            with self.assertRaisesRegex(m.MinutesError, 'RESPONSE_COOKIES_FAILED') as raised:
                h.client.get_session(before_send=h.reserve)
            self.assertTrue(raised.exception.outcome_journaled)
            with self.assertRaisesRegex(m.MinutesError, 'MUTATION_FENCED'):
                h.client.get_session(before_send=h.reserve)

    def test_missing_hooks_deny_before_consumption(self):
        for attr, code in [('_receipt', 'RESPONSE_RECEIPT_REQUIRED'),
                           ('_response_cookies', 'RESPONSE_COOKIES_REQUIRED')]:
            h = Harness()
            setattr(h.client, attr, None)
            with self.assertRaisesRegex(m.MinutesError, code):
                h.client.get_session(before_send=h.reserve)
            self.assertEqual(h.calls, [])
            self.assertEqual(h.reservations, [])

    def test_injected_transport_must_surface_response_observation(self):
        h = Harness()
        h.client._request = lambda *args, **kwargs: fixture()
        with self.assertRaisesRegex(m.MinutesError, 'RESPONSE_OBSERVATION_REQUIRED'):
            h.client.get_session(before_send=h.reserve)
        self.assertEqual(h.receipts[0]['outcome'], 'UNKNOWN')

    def test_fresh_headers_per_operation_before_reservation(self):
        h = Harness([fixture(), fixture()])
        events, received = [], []
        def provide(route, deadline):
            events.append('headers')
            self.assertGreater(deadline, time.monotonic())
            return dict(HEADERS, cookie='rotation-' + str(len(received)))
        def reserve(*args):
            events.append('reserve')
            return h.reserve(*args)
        def request(route, headers, deadline, payload, **kwargs):
            events.append('send')
            received.append(headers)
            return h.request(route, headers, deadline, payload, **kwargs)
        h.client = m.MinutesCheckout(HEADERS, h.home, request=request, header_provider=provide,
                                    receipt=h.receipt, response_cookies=h.response_cookies)
        h.client.get_session(before_send=reserve)
        h.client.get_session(before_send=reserve)
        self.assertEqual(events, ['headers', 'reserve', 'send']*2)
        self.assertEqual([x['cookie'] for x in received], ['rotation-0', 'rotation-1'])
        self.assertEqual(HEADERS['cookie'], 'synthetic-secret')

    def test_fresh_header_address_mismatch_or_failure_never_consumes(self):
        h = Harness()
        h.client._header_provider = lambda *_: dict(HEADERS, **{'x-addresscode': 'OTHER'})
        with self.assertRaisesRegex(m.MinutesError, 'ADDRESS_BINDING_MISMATCH'):
            h.client.get_session(before_send=h.reserve)
        def broken(*_):
            raise RuntimeError('private')
        h.client._header_provider = broken
        with self.assertRaisesRegex(m.MinutesError, 'AUTH_HEADERS_FAILED'):
            h.client.get_session(before_send=h.reserve)
        self.assertEqual(h.calls, [])
        self.assertEqual(h.reservations, [])

    def test_place_and_payment_receipts_keep_exact_order_binding(self):
        h = Harness([{'success': True, 'order_nr': 'ISYNTHETIC1'}, {'status': 'PENDING'}])
        h.client.place_order(total_minor=2050, before_send=h.reserve)
        h.client.complete_payment(order='ISYNTHETIC1', client_secret='private',
            card=m.SavedCard('token', 'xxxx2342', 'mastercard'), provider_code='NOON_PAY',
            cvv_encryption=None, before_send=h.reserve)
        self.assertEqual([r['order_id'] for r in h.receipts], ['ISYNTHETIC1']*2)
        self.assertEqual([r['outcome'] for r in h.receipts], ['ORDER_ID_RECEIVED', 'RESPONSE_RECEIVED'])
        self.assertNotIn('private', json.dumps(h.receipts))

    def test_unknown_place_keeps_id_and_readback_remains_available(self):
        h = Harness([{'success': False, 'order_nr': 'ISYNTHETIC1'}, {'statusCode': 'pending'}])
        h.client.place_order(total_minor=2050, before_send=h.reserve)
        self.assertEqual(h.receipts[0]['outcome'], 'UNKNOWN')
        self.assertEqual(h.receipts[0]['order_id'], 'ISYNTHETIC1')
        with self.assertRaisesRegex(m.MinutesError, 'MUTATION_FENCED'):
            h.client.place_order(total_minor=2050, before_send=h.reserve)
        h.client.order_status('ISYNTHETIC1')
        self.assertFalse(h.cookies[-1][2]['outcome_journaled'])
        self.assertEqual(len(h.receipts), 1)

    def test_payment_challenge_fences_with_bound_receipt(self):
        h = Harness([{'status': 'PENDING', 'redirect_url': 'https://private.invalid/secret'}])
        h.client.complete_payment(order='ISYNTHETIC1', client_secret='private',
            card=m.SavedCard('token', 'xxxx2342', 'mastercard'), provider_code='NOON_PAY',
            cvv_encryption=None, before_send=h.reserve)
        self.assertEqual(h.receipts[0]['outcome'], 'CHALLENGE_REQUIRED')
        self.assertNotIn('private', json.dumps(h.receipts))
        with self.assertRaisesRegex(m.MinutesError, 'MUTATION_FENCED'):
            h.client.get_session(before_send=h.reserve)

    def test_receipt_sink_cannot_rewrite_unknown_to_unfence(self):
        h = Harness([{'success': False, 'order_nr': 'ISYNTHETIC1'}])
        def receipt(record):
            record['outcome'] = 'RESPONSE_RECEIVED'
            return True
        h.client._receipt = receipt
        h.client.place_order(total_minor=2050, before_send=h.reserve)
        with self.assertRaisesRegex(m.MinutesError, 'MUTATION_FENCED'):
            h.client.get_session(before_send=h.reserve)

    def test_response_observed_before_invalid_body_with_repeated_cookies(self):
        observations = []
        headers = Message()
        values = ('a=one; Expires=Wed, 21 Oct 2026 07:28:00 GMT', 'a=two; Path=/')
        for value in values:
            headers.add_header('Set-Cookie', value)
        class Response:
            code = 200
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def geturl(self): return 'https://api-app-instant.noon.com/_svc/instant/session/get'
            def read(self, _):
                self_test.assertEqual(observations[0].set_cookies, values)
                return b'{broken'
        self_test = self
        response = Response()
        response.headers = headers
        opener = unittest.mock.Mock()
        opener.open.return_value = response
        with patch.object(m.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(m.MinutesError, 'INVALID_JSON'):
                m.native_request('session_get', HEADERS, time.monotonic()+5, {},
                                 response_observer=observations.append)
        self.assertEqual(observations[0].http_status, 200)
        self.assertEqual(observations[0].response_url, response.geturl())
        self.assertNotIn('a=one', repr(observations[0]))

    def test_projection_failure_journals_unknown_then_retains_and_fences(self):
        h = Harness([{'items': 'invalid'}, fixture()])
        with self.assertRaises(m.MinutesError) as raised:
            h.client.get_session(before_send=h.reserve)
        self.assertTrue(raised.exception.may_have_sent)
        self.assertEqual(h.receipts[0]['outcome'], 'UNKNOWN')
        self.assertEqual(h.receipts[0]['error_code'], 'ITEMS_SCHEMA_CHANGED')
        self.assertTrue(h.cookies[0][2]['outcome_journaled'])
        with self.assertRaisesRegex(m.MinutesError, 'MUTATION_FENCED'):
            h.client.get_session(before_send=h.reserve)
        self.assertEqual(len(h.calls), 1)

    def test_receipt_failure_delivers_ram_cookies_without_auth_permission(self):
        h = Harness()
        h.client._receipt = lambda _: False
        with self.assertRaisesRegex(m.MinutesError, 'RESPONSE_RECEIPT_FAILED'):
            h.client.get_session(before_send=h.reserve)
        self.assertFalse(h.cookies[0][2]['outcome_journaled'])
        with self.assertRaisesRegex(m.MinutesError, 'MUTATION_FENCED'):
            h.client.get_session(before_send=h.reserve)
        self.assertEqual(len(h.calls), 1)

    def test_strict_json_and_gzip(self):
        self.assertEqual(m.decode_response(gzip.compress(b'{"total":20.5}'))['total'],Decimal('20.5'))
        for raw in [b'{"a":1,"a":2}',b'{"a":NaN}',b'[]',gzip.compress(b'{}')+b'extra']:
            with self.subTest(raw=raw),self.assertRaises(m.MinutesError):
                m.decode_response(raw)

    def test_gzip_bomb_bounded(self):
        with self.assertRaisesRegex(m.MinutesError,'RESPONSE_TOO_LARGE'):
            m.decode_response(gzip.compress(b' '*(m.MAX_BYTES+1)))

    def test_header_injection_and_duplicate_case_denied(self):
        for headers in [{'cookie':'a\r\nb'}, {'Cookie':'a','cookie':'b'}]:
            with self.assertRaises(m.MinutesError):
                m.MinutesCheckout(headers,None)

    def test_native_request_builds_fixed_endpoint_and_one_send(self):
        class Response:
            code = 200
            headers = Message()
            def __enter__(self):return self
            def __exit__(self,*_):pass
            def geturl(self):return 'https://api-app-instant.noon.com/_svc/instant/order/place'
            def read(self,n):return b'{"success":true,"order_nr":"ISYNTHETIC1"}'
        class Opener:
            def __init__(self):self.calls=[]
            def open(self,req,timeout):self.calls.append(req);return Response()
        opener=Opener()
        with patch.object(m.urllib.request,'build_opener',return_value=opener) as build:
            out=m.native_request('place',HEADERS,time.monotonic()+5,{'total':20.5},
                                 response_observer=lambda _: None)
        self.assertEqual(out['order_nr'],'ISYNTHETIC1')
        self.assertEqual(opener.calls[0].full_url,'https://api-app-instant.noon.com/_svc/instant/order/place')
        self.assertEqual(opener.calls[0].data,b'{"total":20.5}')
        self.assertEqual(len(opener.calls),1)
        self.assertEqual(build.call_args.args[0].proxies,{})
        self.assertIsNone(build.call_args.args[1].redirect_request(None,None,None,None,None,None))

    def test_http_exception_does_not_expose_body_or_url(self):
        opener=unittest.mock.Mock()
        opener.open.side_effect=urllib.error.HTTPError('https://private.invalid/secret',403,'private',Message(),None)
        with patch.object(m.urllib.request,'build_opener',return_value=opener):
            with self.assertRaisesRegex(m.MinutesError,'AUTH_FORBIDDEN') as raised:
                m.native_request('place',HEADERS,time.monotonic()+5,{'total':20.5},
                                 response_observer=lambda _: None)
        self.assertNotIn('private',str(raised.exception))

    def test_unknown_route_denied(self):
        with self.assertRaisesRegex(m.MinutesError,'ENDPOINT_DENIED'):
            m.native_request('cancel',HEADERS,time.monotonic()+5,{},response_observer=lambda _: None)


if __name__ == '__main__':
    unittest.main()
