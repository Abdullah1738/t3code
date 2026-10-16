import copy
import gzip
import io
import json
import time
import unittest
from unittest.mock import patch
import urllib.error

import talabat_http_checkout as h
from test.test_talabat_quote import fixture, card_fixture
from test.test_talabat_place_contract import draft_inputs


FLOW = '10000000-0000-4000-8000-000000000001'
PRODUCT = '10000000-0000-4000-8000-000000000002'
KEY = '0123456789abcdef'


def context(vertical='mart'):
    home, _, _ = fixture()
    home.update(profile_name='Banyantree Residences Hillside', cust_id=77, delivery_instructions=[])
    config, card = card_fixture()
    event = config['paymentMethods'][0]['events']['payment']
    event.update(platform='talabat', platformType='sync')
    event['method'].update(paymentMethodName='Card', addTPayMethodName='Saved card')
    store = h.Store(vertical, 44444, 0 if vertical == 'restaurants' else 1,
                    vertical == 'mart', None if vertical == 'restaurants' else 'synthetic-vendor',
                    None if vertical == 'restaurants' else 44)
    items = (h.Item(12345 if vertical == 'restaurants' else PRODUCT, 2),)
    cart = ({'branchInfo':{'restaurant':{'branchId':store.branch_id}},'cart': {'id': 900, 'totalValue': 30, 'items': [
        {'id': 333, 'menuItemId': 12345, 'quantity': 2, 'choices': [], 'specialRequest': ''}]}}
        if vertical == 'restaurants' else {'id': 'synthetic-owned-cart', 'items': [
            {'product_id': PRODUCT, 'quantity': 2, 'increment_weight': None}],
            'subtotal_after_discount': 30, 'total': 35})
    parsed = h.parse_cart(cart, store, items)
    quote = draft_inputs()['quote']
    quote['tracking']['cartId'] = parsed.cart_id
    checkout = quote['checkout']
    checkout['branchId'] = store.branch_id
    checkout['amount'] = 35
    checkout['cart']['items'] = [{'id': '333', 'itemGuid': PRODUCT,
                                 'quantity': 2, 'price': '15.00', 'total': '30.00'}]
    checkout['paymentSummary']['items'] = [
        {'type': 'SubTotal', 'amount': 30}, {'type': 'DeliveryFee', 'amount': 3},
        {'type': 'ServiceFee', 'amount': 2}, {'type': 'Total', 'amount': 35}]
    return home, config, card, store, items, cart, parsed, quote


def selected_quote(vertical='mart'):
    home, config, card, store, items, cart, parsed, data = context(vertical)
    selection = h.select_payment(config, card)
    body = h.prepare_body(store, home, selection=selection, instructions=data['checkout']['deliveryInstructions'])
    return h.parse_quote(data, parsed, home, body, selection)


def placed(balance='35.00', **fields):
    return h.place_contract.parse_response(200, {'placedOrder': {
        'orderId': '1234567890', 'transactionId': 'synthetic-encrypted-transaction',
        'balanceAmount': balance, **fields}})


class ContractTests(unittest.TestCase):
    def test_async_event_preserves_instrument_and_native_90_interval_list(self):
        _, config, card, *_ = context()
        event = config['paymentMethods'][0]['events']['payment']
        event.update(platformType='async', instrumentId='synthetic-distinct-instrument',
                     paymentStatusPullingInterval=[1.0] * 90)
        event['card']['paymentProvider'] = 1
        selection = h.select_payment(config, card)
        selected = json.loads(selection.event)
        self.assertEqual(selected['instrumentId'], event['instrumentId'])
        self.assertNotEqual(selected['instrumentId'], selected['card']['cardId'])
        self.assertEqual(selected['paymentStatusPullingInterval'], [1.0] * 90)
        self.assertNotIn('paymentProvider', selected['card'])
        from dataclasses import replace
        quote = replace(selected_quote(), selection=selection)
        self.assertEqual(h.payment_body(placed(), quote)['payment'], selected)
        event['card']['paymentProvider'] = True
        with self.assertRaises(h.orders.TalabatError): h.select_payment(config, card)
        event['card']['paymentProvider'] = 1
        for bad in (None, '', 7, False, {}, 'bad\nidentifier'):
            event['instrumentId'] = bad
            with self.subTest(bad=bad), self.assertRaises(h.orders.TalabatError): h.select_payment(config, card)

    def test_async_interval_units_types_and_bounds(self):
        self.assertEqual(h.polling_intervals([1.0, 0.1259]), (1.0, 0.125))
        for values in ([], None, [True], [0], [-1], [float('nan')], [float('inf')], ['1'],
                       [1]*181, [61], [60]*6, [0.0001]):
            with self.subTest(values=values), self.assertRaises(h.orders.TalabatError): h.polling_intervals(values)

    def test_approval_digest_includes_async_route_instrument_and_intervals(self):
        from dataclasses import replace
        quote = selected_quote()
        original = h.project_quote(quote)['quote_digest']
        event = json.loads(quote.selection.event)
        event.update(platformType='async', instrumentId='synthetic-distinct-instrument',
                     paymentStatusPullingInterval=[1.0]*90)
        changed = replace(quote, selection=replace(quote.selection, event=h._json(event)))
        self.assertNotEqual(original, h.project_quote(changed)['quote_digest'])

    def test_async_post_pending_then_transaction_bound_status(self):
        _, config, card, *_ = context()
        config['paymentMethods'][0]['events']['payment'].update(platformType='async',
            instrumentId='synthetic-instrument', paymentStatusPullingInterval=[1.0]*90)
        selection = h.select_payment(config, card)
        observation = placed()
        payment = h.parse_payment(200, {'paymentId': 'synthetic-pay&=', 'metadata': 'synthetic-meta+/='},
                                  observation, platform_type='async')
        self.assertEqual(payment.state, 'PAYMENT_PENDING')
        ctx = h.async_context(observation, selection, FLOW, payment, account_binding='0'*64)
        params = h.payment_status_params(ctx)
        self.assertEqual(params, {'isRedirectionInitiated': 'false', 'encryptedTransactionId': observation.transaction_id,
            'scenario': 'deliveryOrder', 'subscription': 'false', 'metadata': payment.metadata, 'paymentId': payment.payment_id})
        cases = [({'status':'pending'}, 'PAYMENT_PENDING'), ({}, 'PAYMENT_PENDING'),
                 ({'status':'success'}, 'PAYMENT_REPORTED_SUCCESS'), ({'status':'error'}, 'PAYMENT_ERROR_REPORTED'),
                 ({'status':'redirection'}, 'CHALLENGE_REQUIRED'),
                 ({'status':'success', 'redirectUrl':'https://challenge.invalid'}, 'CHALLENGE_REQUIRED'),
                 ({'status':'success', 'fallback':{}}, 'PAYMENT_BLOCKED'),
                 ({'status':'success', 'hyperPayCheckoutId':'sdk'}, 'PAYMENT_BLOCKED'),
                 ({'status':'success', 'error':{}}, 'PAYMENT_ERROR_REPORTED'),
                 ({'status':'Success'}, 'PAYMENT_REPORTED_SUCCESS'), ({'status':'PENDING'}, 'PAYMENT_PENDING'),
                 ({'status':'failed'}, 'PAYMENT_UNKNOWN'),
                 ({'status':True}, 'PAYMENT_UNKNOWN'), ({'status':'success', 'other':True}, 'PAYMENT_UNKNOWN')]
        for body, state in cases:
            with self.subTest(body=body): self.assertEqual(h.parse_async_status(200, body, ctx).state, state)
        for code in (True, None, 307, 401, 403, 422, 500):
            self.assertNotEqual(h.parse_async_status(code, {'status':'success'}, ctx).state, 'PAYMENT_REPORTED_SUCCESS')
        self.assertNotIn('synthetic-', repr(ctx))

    def test_populated_empty_continuations_cannot_report_async_success(self):
        ctx = h.AsyncPaymentContext('12345', 'synthetic-txn', FLOW, (1.0,), '0'*64)
        for value in ('', 'https://challenge.invalid'):
            with self.subTest(value=value):
                self.assertEqual(h.parse_payment(200, {'redirectUrl': value}, placed(),
                    platform_type='async').state, 'CHALLENGE_REQUIRED')
                self.assertEqual(h.parse_async_status(200, {'status':'success', 'redirectUrl':value},
                    ctx).state, 'CHALLENGE_REQUIRED')
        for body in ({'status':'redirection'}, {'status':'redirection','redirectUrl':None},
                     {'status':'redirection','redirectUrl':''}):
            self.assertEqual(h.parse_async_status(200, body, ctx).state, 'CHALLENGE_REQUIRED')
        for body in ({}, {'redirectUrl':None}):
            self.assertEqual(h.parse_payment(200, body, placed(), platform_type='async').state, 'PAYMENT_PENDING')
        self.assertEqual(h.parse_async_status(200, {'status':'success','redirectUrl':None}, ctx).state,
                         'PAYMENT_REPORTED_SUCCESS')

    def test_three_verticals_have_distinct_item_contracts_and_general_ids(self):
        for vertical in ('shops', 'mart', 'restaurants'):
            home, _, _, store, items, *_ = context(vertical)
            body = h.cart_body(store, home, items)
            if vertical == 'restaurants':
                self.assertEqual(body['deliveryInformation']['deliveryMode'], 'Rider')
                self.assertEqual(body['items'], [{'menuItemId': 12345, 'quantity': 2,
                                                 'specialRequest': '', 'choices': [], 'isFromUpsell': False}])
                self.assertNotIn('isGroupOrder', body)
            else:
                self.assertEqual(body['branch_id'], '44444')
                self.assertEqual(body['items'][0]['product_id'], PRODUCT)
                self.assertNotIn(h.shared.QUEST, json.dumps(body))

    def test_strict_manifest_no_bool_zero_or_guessed_id(self):
        home, _, _, store, *_ = context()
        for items in ((h.Item(PRODUCT, True),), (h.Item(PRODUCT, 0),), (h.Item('sku', 1),)):
            with self.subTest(items=items), self.assertRaises(h.orders.TalabatError):
                h.cart_body(store, home, items)
        # Identical duplicate lines merge by summed quantity; the server
        # aggregates them and cannot echo duplicates back.
        self.assertEqual(h.cart_body(store, home,
            (h.Item(PRODUCT, 1), h.Item(PRODUCT, 2)))['items'],
            [{'product_id': PRODUCT, 'quantity': 3, 'increment_weight': None}])

    def test_grocery_store_binding_and_darkstore_distinction(self):
        vendor = {'talabat_id': 55555, 'global_id': 'synthetic-vendor', 'chain_id': 4,
                  'vertical_type': 1, 'is_dark_store': False, 'is_migrated': True}
        self.assertEqual(h.grocery_store({'vendor': vendor}, 55555, 'shops').branch_id, 55555)
        for branch, vertical in ((55555, 'mart'), (44, 'shops')):
            with self.assertRaises(h.orders.TalabatError):
                h.grocery_store({'vendor': vendor}, branch, vertical)

    def test_cart_quantity_extras_and_food_line_id_binding(self):
        for vertical in ('mart', 'restaurants'):
            _, _, _, store, items, data, _, _ = context(vertical)
            for kind in ('qty', 'id', 'extras'):
                bad = copy.deepcopy(data); cart = bad['cart'] if vertical == 'restaurants' else bad
                row = cart['items'][0]
                if kind == 'qty': row['quantity'] = True
                elif kind == 'id': row['menuItemId' if vertical == 'restaurants' else 'product_id'] = 'wrong'
                elif vertical == 'restaurants': row['choices'] = [{'id': 7}]
                else: row['free_quantity'] = 1
                with self.subTest(vertical=vertical, kind=kind), self.assertRaises(h.orders.TalabatError):
                    h.parse_cart(bad, store, items)
        self.assertEqual(selected_quote('restaurants').cart.quote_item_ids, ((12345, '333'),))

    def test_amounts_no_rounding_scaling_or_bool(self):
        self.assertEqual(h.minor('35.01'), 3501)
        self.assertEqual(h.major(3501), '35.01')
        for value in (True, False, -1, '-1.0', '35.001', '1e2', float('nan'), float('inf'), None):
            with self.subTest(value=value), self.assertRaises(h.orders.TalabatError): h.minor(value)

    def test_selected_card_not_token_and_native_null_branches(self):
        quote = selected_quote()
        body = h.payment_body(placed(), quote)
        self.assertEqual(set(body), set(h.PAYMENT_KEYS))
        self.assertEqual(body['remainingAmount'], 35.0)
        self.assertEqual(body['eTransId'], 'synthetic-encrypted-transaction')
        self.assertEqual(body['payment']['card']['cardId'], 'synthetic-token-id')
        self.assertEqual(body['paymentScenario'], 'deliveryOrder')
        for key in ('cardToken', 'keepCard', 'method', 'pu', 'binNumber', 'secondaryPayment',
                    'tokenizedCvv', 'applePay', 'googlePay', 'bnpl', 'paymentMode'):
            self.assertIsNone(body[key])
        draft = h.place_body(quote)
        self.assertEqual(draft['cardTokenId'], 'synthetic-token-id')
        self.assertIs(draft['saveDeliveryInstructionsForLater'], False)
        self.assertIs(draft['saveRiderTipForLater'], False)
        for key in ('walletBalance', 'hasDues', 'amount', 'riderNote', 'saveCard'):
            self.assertNotIn(key, draft)

    def test_payment_no_default_platform_fallback_cvv_or_wallet(self):
        for kind in ('platform', 'async', 'cvv', 'wallet', 'instrument', 'method', 'duplicate', 'card'):
            _, config, card, *_ = context()
            row = config['paymentMethods'][0]; event = row['events']['payment']
            if kind == 'platform': event.pop('platform')
            elif kind == 'async': event['platformType'] = 'async'
            elif kind == 'cvv': row['events']['prePayment'] = {'name': 'ForceCVV'}
            elif kind == 'wallet': row['events']['selected'] = {'talabatPayConfig': {'balance': 0}}
            elif kind == 'instrument': event['instrumentId'] = ''
            elif kind == 'method': event['method']['paymentMethod'] = 2.0
            elif kind == 'card': event['card']['cardId'] = card['token']
            else: config['paymentMethods'].append(copy.deepcopy(row))
            with self.subTest(kind=kind), self.assertRaises(h.orders.TalabatError): h.select_payment(config, card)

    def test_quote_cart_home_items_currency_totals_and_quiet_stops(self):
        for kind in ('cart', 'home', 'currency', 'qty', 'total', 'fee', 'item', 'quiet', 'tip'):
            home, config, card, store, _, _, cart, data = context()
            selection = h.select_payment(config, card)
            body = h.prepare_body(store, home, selection=selection, instructions=data['checkout']['deliveryInstructions'])
            checkout = data['checkout']
            if kind == 'cart': data['tracking']['cartId'] = 'another-cart'
            elif kind == 'home': checkout['address']['latitude'] += .01
            elif kind == 'currency': data['branchInfo']['country']['currencyCode'] = 'USD'
            elif kind == 'qty': checkout['cart']['items'][0]['quantity'] = True
            elif kind == 'total': checkout['amount'] = 35.01
            elif kind == 'fee': checkout['paymentSummary']['items'].append({'type': 'unknown', 'amount': 0})
            elif kind == 'item': checkout['cart']['items'][0]['itemGuid'] = 'other'
            elif kind == 'tip': checkout['riderTips']['options'][0]['isSelected'] = True
            else: checkout['deliveryInstructions']['instructions'][0]['isSelected'] = True
            with self.subTest(kind=kind), self.assertRaises(h.orders.TalabatError):
                h.parse_quote(data, cart, home, body, selection)

    def test_unchosen_quiet_can_be_selected_then_must_be_read_back(self):
        home, config, card, store, _, _, cart, data = context()
        selection = h.select_payment(config, card)
        for row in data['checkout']['deliveryInstructions']['instructions']:
            row['isSelected'] = row['title'] == 'Call on arrival'
        body = h.prepare_body(store, home, selection=selection)
        quote = h.parse_quote(data, cart, home, body, selection)
        self.assertFalse(h.project_quote(quote)['quiet_selected'])
        with self.assertRaises(h.orders.TalabatError): h.place_body(quote)
        selected = h.prepare_body(store, home, selection=selection, instructions=data['checkout']['deliveryInstructions'])
        self.assertEqual(len(selected['deliveryInstructions']), 2)
        with self.assertRaises(h.orders.TalabatError): h.parse_quote(data, cart, home, selected, selection)

    def test_place_balance_pending_missing_and_challenge(self):
        quote = selected_quote()
        for balance in ('34.99', '3500', 'NaN'):
            with self.subTest(balance=balance), self.assertRaises(h.orders.TalabatError):
                h.payment_body(placed(balance), quote)

    def test_native_zero_remaining_amount_is_preserved_not_replaced_by_quote(self):
        quote=selected_quote()
        for value in ('0','0.0','0.00',None):
            body=h.payment_body(placed(value),quote)
            self.assertEqual(body['remainingAmount'],0.0)
            self.assertEqual(body['orderId'],'1234567890')
            self.assertEqual(body['eTransId'],'synthetic-encrypted-transaction')
            self.assertEqual(quote.amount_minor,3500)
        with self.assertRaises(h.orders.TalabatError):
            h.payment_body(placed(redirectUrl='https://challenge.invalid'), quote)
        self.assertEqual(placed().state, 'PAYMENT_PENDING')

    def test_sync_payment_response_not_async_success_alias(self):
        cases = [({}, 200, 'PAYMENT_REPORTED_SUCCESS'), ({'redirectUrl': ''}, 200, 'PAYMENT_REPORTED_SUCCESS'),
                 ({'status': 'success'}, 200, 'PAYMENT_UNKNOWN'), ({}, 422, 'PAYMENT_UNKNOWN'),
                 ({'redirectUrl': 'https://challenge.invalid'}, 200, 'CHALLENGE_REQUIRED'),
                 ({'fallback': {}}, 200, 'PAYMENT_BLOCKED'), ({'error': {}}, 422, 'PAYMENT_ERROR_REPORTED'),
                 ({'hyperPayCheckoutId': 'sdk'}, 200, 'PAYMENT_BLOCKED'), (None, None, 'PAYMENT_UNKNOWN')]
        for body, code, state in cases:
            with self.subTest(body=body, code=code):
                self.assertEqual(h.parse_payment(code, body, placed(), platform_type='sync').state, state)

    def test_private_reprs_and_safe_projection(self):
        quote = selected_quote()
        text = repr(quote) + repr(quote.cart) + repr(quote.selection) + json.dumps(h.project_quote(quote))
        for secret in ('synthetic-token', 'synthetic-address', 'synthetic-owned-cart', PRODUCT):
            self.assertNotIn(secret, text)


class LifecycleTests(unittest.TestCase):
    def submit(self, client, amount=3500):
        return client.submit_place(approved_amount_minor=amount,
                                   approved_quote_digest=h.project_quote(client.quote)['quote_digest'])

    def client(self, vertical='mart', fail_phase=None, async_route=False):
        home, config, card, store, items, cart, parsed, quote = context(vertical)
        if async_route:
            config['paymentMethods'][0]['events']['payment'].update(platformType='async',
                instrumentId='synthetic-private-instrument', paymentStatusPullingInterval=[1.0]*90)
        self.records, self.calls = [], []
        self.receipts = []
        saved = {'account_verified': True, 'country': 'AE', 'headers': {},
                 'auth': {'access_token': 'synthetic-secret', 'customerId': 77}, 'expected_profile': {
            'id': 77, 'mobile_country_code': '971', 'mobile_number': '500000000'}}
        def journal(record):
            self.records.append(copy.deepcopy(record))
            return True
        def receipt(record):
            self.receipts.append(record)
            return True
        def wire(saved, deadline, method, path, **kwargs):
            self.calls.append((method, path, copy.deepcopy(kwargs)))
            if method == 'POST':
                self.assertTrue(self.records)
                self.assertEqual(self.records[-1]['state'], 'MAY_HAVE_SENT')
                if self.records[-1]['operation'] == fail_phase:
                    return h.WireResponse(401, None)
            if path == '/api/v2/user/addresses':
                return h.WireResponse(200, {'has_error': False, 'result': [home]})
            if path == '/pay/v1/cards': return h.WireResponse(200, {'data': [card]})
            if path == '/pay/v2/payments': return h.WireResponse(200, config)
            if path == '/grocery/v2/cart' and method == 'GET':
                if any(x[0] == 'POST' and x[1] == '/grocery/v2/cart' for x in self.calls):
                    return h.WireResponse(200, cart)
                return h.WireResponse(200, {'id': 'synthetic-new-empty', 'items': [], 'subtotal_after_discount': 0})
            if path in ('/cart/v2', '/grocery/v2/cart'): return h.WireResponse(200, cart)
            if path=='/cart/v1/900' and method=='GET':
                self.assertEqual(kwargs['params'],{'hasOutstandingPayments':'false'})
                self.assertNotIn('body',kwargs)
                return h.WireResponse(200,cart)
            if path.endswith('/placeOrder'):
                return h.WireResponse(200, {'placedOrder': {'orderId': '1234567890',
                    'transactionId': 'synthetic-transaction', 'balanceAmount': '35.00'}})
            if path == '/pay/v1/payments':
                return h.WireResponse(200, {'error': None, 'redirectUrl': None,
                                            'paymentId': 'synthetic-payment', 'metadata': 'synthetic-metadata'})
            if path == '/pay/v2/payment/status': return h.WireResponse(200, {'status': 'success'})
            if path.startswith('/ccx/v1/checkout/'):
                return h.WireResponse(200, quote)
            self.fail('unrecognized path')
        self.wire_patch = patch.object(h, '_wire', side_effect=wire)
        self.wire_patch.start(); self.addCleanup(self.wire_patch.stop)
        p = patch.object(h.auth, 'expiry', return_value=time.time()+3600); p.start(); self.addCleanup(p.stop)
        p = patch.object(h.orders, 'request', return_value=saved['expected_profile']); p.start(); self.addCleanup(p.stop)
        client = h.Checkout(saved, flow_id=FLOW, journal=journal, receipt=receipt)
        return client, store, items

    def quote_flow(self, client, store, items):
        client.create_cart(store, items, verticals_key=KEY)
        client.payment_config()
        first = client.prepare(selected=False)
        client.payment_config(first.amount_minor)
        return client.prepare(quiet_from=first)

    def test_native_lifecycle_each_vertical_and_exact_tracking(self):
        for vertical in ('mart', 'shops', 'restaurants'):
            with self.subTest(vertical=vertical):
                client, store, items = self.client(vertical)
                quote = self.quote_flow(client, store, items)
                self.assertEqual(quote.amount_minor, 3500)
                observation = self.submit(client)
                self.assertEqual(observation.state, 'PAYMENT_PENDING')
                result = client.submit_payment()
                self.assertEqual(result.state, 'PAYMENT_REPORTED_SUCCESS')
                with patch.object(h.orders, 'request', side_effect=[client.saved['expected_profile'],
                        {'type': 'OrderTrackingScreen', 'common_tracking_event_attributes':
                         {'order_id': '1234567890', 'delivery_status': 'order_delivered'}}]) as tracking, \
                        patch('talabat_http_list.page_request', return_value={'orders':[
                            {'id':'1234567890','status':'Delivered'}],'is_last_page':True,'total_orders':1}):
                    self.assertEqual(client.track()['status'], 'delivered')
                    self.assertEqual(tracking.call_args.args[0], h.orders.TRACKING + '1234567890')
                self.assertEqual([x['operation'] for x in self.records],
                                 ['create_cart', 'quote_initial', 'quote_selected_quiet', 'place', 'payment'])
                with self.assertRaises(h.orders.TalabatError): client.submit_payment()
                self.assertEqual(len([x for x in self.calls if x[1] == '/pay/v1/payments']), 1)
                self.wire_patch.stop()

    def test_restaurant_owned_native_get_uses_created_id_not_branch_and_checks_line(self):
        client,store,items=self.client(vertical='restaurants')
        client.create_cart(store,items)
        current=client.read_owned_cart()
        self.assertEqual(current.cart_id,'900')
        self.assertEqual(current.lines,((12345,333,2),))
        self.assertEqual(self.calls[-1][0:2],('GET','/cart/v1/900'))
        original=h._wire.side_effect
        def changed(saved,deadline,method,path,**kwargs):
            result=original(saved,deadline,method,path,**kwargs)
            if path=='/cart/v1/900':
                data=copy.deepcopy(result.data);data['cart']['items'][0]['id']=334
                return h.WireResponse(200,data)
            return result
        with patch.object(h,'_wire',side_effect=changed):
            with self.assertRaisesRegex(h.orders.TalabatError,'OWNED_FOOD_CART_CHANGED'):
                client.read_owned_cart()

    def test_post_401_is_consumed_and_never_renews(self):
        client, store, items = self.client(fail_phase='place')
        self.quote_flow(client, store, items)
        with patch.object(h.auth, 'refresh') as refresh:
            result = self.submit(client)
            self.assertEqual(result.state, 'SUBMISSION_UNKNOWN')
            with self.assertRaises(h.orders.TalabatError): self.submit(client)
            with self.assertRaises(h.orders.TalabatError): client.submit_payment()
            refresh.assert_not_called()
        self.assertEqual(sum(x[1].endswith('/placeOrder') for x in self.calls), 1)

    def test_fresh_account_is_verified_before_journal_and_never_replays(self):
        client, store, items = self.client()
        events = []
        original = client.journal
        def fresh():
            events.append('auth')
            return copy.deepcopy(client.saved)
        def journal(record):
            events.append('journal')
            return original(record)
        client.fresh_account, client.journal = fresh, journal
        client.create_cart(store, items, verticals_key=KEY)
        self.assertEqual(events, ['auth', 'journal'])
        before = len(self.calls)
        def wrong():
            saved = copy.deepcopy(client.saved)
            saved['expected_profile']['id'] = 'another-account'
            return saved
        client.fresh_account = wrong
        with self.assertRaisesRegex(h.orders.TalabatError, 'IDENTITY'):
            client._mutate('quote_initial', '/ccx/v1/checkout/synthetic', {})
        self.assertEqual(len(self.calls), before)
        self.assertNotIn('quote_initial', client.consumed)

    def test_parent_journal_failure_prevents_send_but_consumes_local_attempt(self):
        client, store, items = self.client()
        client.journal = lambda record: False
        with self.assertRaises(h.orders.TalabatError): client.create_cart(store, items, verticals_key=KEY)
        self.assertFalse(any(x[0] == 'POST' for x in self.calls))
        self.assertIn('create_cart', client.consumed)

    def test_orphan_cart_never_overwritten(self):
        client, store, items = self.client()
        original = h._wire.side_effect
        def wire(saved, deadline, method, path, **kwargs):
            if path == '/grocery/v2/cart' and method == 'GET':
                return h.WireResponse(200, {'items': [{'product_id': h.shared.QUEST, 'quantity': 1}], 'subtotal_after_discount': 20.25})
            return original(saved, deadline, method, path, **kwargs)
        with patch.object(h, '_wire', side_effect=wire):
            with self.assertRaisesRegex(h.orders.TalabatError, 'MUST_NOT_BE_REPLACED'):
                client.create_cart(store, items, verticals_key=KEY)
        self.assertEqual(self.records, [])

    def test_wrong_approval_config_drift_and_expiry_stop_before_place(self):
        client, store, items = self.client()
        self.quote_flow(client, store, items)
        with self.assertRaises(h.orders.TalabatError): self.submit(client, 3501)
        with self.assertRaisesRegex(h.orders.TalabatError, 'EXACT_QUOTE_APPROVAL'):
            client.submit_place(approved_amount_minor=3500, approved_quote_digest='wrong')
        client.config_amount_minor = 3499
        with self.assertRaises(h.orders.TalabatError): self.submit(client)
        client.config_amount_minor = 3500
        with patch.object(h.auth, 'expiry', return_value=0):
            with self.assertRaisesRegex(h.orders.TalabatError, 'AUTH_EXPIRED'):
                self.submit(client)
        self.assertNotIn('place', client.consumed)

    def test_unsupported_payment_does_not_disable_initial_quote(self):
        client, store, items = self.client()
        client.create_cart(store, items, verticals_key=KEY)
        client.payment_config()
        client.config['paymentMethods'][0]['events']['payment']['platform'] = 'hyperPay'
        first = client.prepare(selected=False)
        self.assertEqual(first.amount_minor, 3500)
        with self.assertRaisesRegex(h.orders.TalabatError, 'PLATFORM_BRANCH'):
            client.prepare(quiet_from=first)
        self.assertNotIn('place', client.consumed)

    def test_changed_cart_and_failed_quote_invalidate_before_place(self):
        client, store, items = self.client()
        self.quote_flow(client, store, items)
        original = h._wire.side_effect
        def changed(saved, deadline, method, path, **kwargs):
            if path == '/grocery/v2/cart' and method == 'GET':
                data = context()[5]
                data['items'][0]['quantity'] = 3
                return h.WireResponse(200, data)
            return original(saved, deadline, method, path, **kwargs)
        with patch.object(h, '_wire', side_effect=changed):
            with self.assertRaises(h.orders.TalabatError): self.submit(client)
        self.assertNotIn('place', client.consumed)
        with patch.object(h, '_wire', return_value=h.WireResponse(503, None)):
            with self.assertRaises(h.orders.TalabatError): client.prepare()
        self.assertIsNone(client.quote)

    def test_changed_observed_cart_total_stops_before_place_even_same_items(self):
        client, store, items = self.client()
        self.quote_flow(client, store, items)
        original = h._wire.side_effect
        def changed(saved, deadline, method, path, **kwargs):
            if path == '/grocery/v2/cart' and method == 'GET':
                data = context()[5]
                data['total'] = 36
                return h.WireResponse(200, data)
            return original(saved, deadline, method, path, **kwargs)
        with patch.object(h, '_wire', side_effect=changed):
            with self.assertRaisesRegex(h.orders.TalabatError, 'OWNED_CART_CHANGED'):
                self.submit(client)
        self.assertNotIn('place', client.consumed)
        self.assertFalse(any(x[1].endswith('/placeOrder') for x in self.calls))

    def test_missing_native_total_uses_explicit_zero_context_then_final_amount(self):
        client, store, items = self.client()
        client.create_cart(store, items, verticals_key=KEY)
        from dataclasses import replace
        client.cart = replace(client.cart, route_amount_minor=None)
        client.payment_config()
        call = next(x for x in reversed(self.calls) if x[1] == '/pay/v2/payments')
        self.assertEqual(call[2]['params']['amount'], '0.00')
        first = client.prepare(selected=False)
        client.payment_config(first.amount_minor)
        client.prepare(quiet_from=first)
        original = h._wire.side_effect
        def same_missing_total(saved, deadline, method, path, **kwargs):
            response = original(saved, deadline, method, path, **kwargs)
            if path == '/grocery/v2/cart' and method == 'GET':
                data = copy.deepcopy(response.data)
                data.pop('total', None)
                return h.WireResponse(response.status, data)
            return response
        with patch.object(h, '_wire', side_effect=same_missing_total):
            self.assertEqual(self.submit(client).state, 'PAYMENT_PENDING')

    def test_actual_async_lifecycle_journals_then_polls_exact_ids_once(self):
        client, store, items = self.client(async_route=True)
        self.quote_flow(client, store, items)
        self.submit(client)
        pending = client.submit_payment()
        self.assertEqual(pending.state, 'PAYMENT_PENDING')
        self.assertEqual([r['operation'] for r in self.receipts],
                         ['create_cart', 'quote_initial', 'quote_selected_quiet', 'place', 'payment'])
        payment_record = next(r for r in self.records if r['operation'] == 'payment')
        place_record = next(r for r in self.records if r['operation'] == 'place')
        self.assertEqual(payment_record['payment_order_id'], client.placed.order_id)
        for key in ('cart_binding', 'review_sha256', 'currency', 'payable_minor'):
            self.assertEqual(payment_record[key], place_record[key])
        native = next(c for c in self.calls if c[1] == '/pay/v1/payments')
        self.assertEqual(native[2]['body']['payment']['platformType'], 'async')
        self.assertEqual(native[2]['body']['payment']['instrumentId'], 'synthetic-private-instrument')
        with patch.object(h.time, 'sleep') as sleep:
            result = client.poll_payment()
            self.assertEqual(result.state, 'PAYMENT_REPORTED_SUCCESS')
            sleep.assert_called_once_with(1.0)
            client.poll_payment()
            sleep.assert_called_once()
        status = next(c for c in self.calls if c[1] == '/pay/v2/payment/status')
        self.assertEqual(status[2]['params']['encryptedTransactionId'], client.placed.transaction_id)
        self.assertEqual(status[2]['params']['paymentId'], 'synthetic-payment')
        self.assertEqual(status[2]['params']['metadata'], 'synthetic-metadata')
        self.assertEqual(status[2]['headers']['x-acceptance-request-id'], FLOW)
        self.assertEqual(self.receipts[-1]['next_index'], 1)
        with self.assertRaises(h.orders.TalabatError): client.submit_payment()
        self.assertEqual(sum(c[1] == '/pay/v1/payments' for c in self.calls), 1)

    def test_zero_balance_continuation_retains_full_quote_reservation(self):
        client, store, items = self.client(async_route=True)
        self.quote_flow(client, store, items)
        original=h._wire.side_effect
        def zero(saved,deadline,method,path,**kwargs):
            result=original(saved,deadline,method,path,**kwargs)
            if path.endswith('/placeOrder'):
                data=copy.deepcopy(result.data)
                data['placedOrder']['balanceAmount']='0'
                return h.WireResponse(result.status,data)
            return result
        with patch.object(h,'_wire',side_effect=zero):
            self.submit(client)
            result=client.submit_payment()
        self.assertEqual(result.state,'PAYMENT_PENDING')
        payment=next(x for x in self.records if x['operation']=='payment')
        self.assertEqual(payment['payable_minor'],3500)
        body=next(x[2]['body'] for x in self.calls if x[1]=='/pay/v1/payments')
        self.assertEqual(body['remainingAmount'],0.0)
        self.assertEqual(body['orderId'],client.placed.order_id)
        with self.assertRaises(h.orders.TalabatError):client.submit_payment()

    def test_async_poll_budget_and_recovery_cursor_never_send_payment(self):
        client, store, items = self.client(async_route=True)
        self.quote_flow(client, store, items); self.submit(client); client.submit_payment()
        with patch.object(h, '_wire', return_value=h.WireResponse(200, {'status':'pending'})) as wire, \
             patch.object(h.time, 'sleep') as sleep:
            self.assertEqual(client.poll_payment(max_reads=2).state, 'PAYMENT_PENDING')
            self.assertEqual(client.payment_poller.next_index, 2)
            self.assertEqual(wire.call_count, 2)
            recovered = h.AsyncPaymentPoller(client.saved, client.payment_poller.context,
                receipt=client.receipt, next_index=89)
            self.assertEqual(recovered.poll().reason, 'ASYNC_POLL_SCHEDULE_EXHAUSTED')
            self.assertEqual(wire.call_count, 3)
            self.assertTrue(all(call.args[2] == 'GET' for call in wire.call_args_list))
            self.assertEqual(sleep.call_count, 3)

    def test_lost_async_payment_response_can_only_read_exact_transaction(self):
        client, store, items = self.client(async_route=True, fail_phase='payment')
        self.quote_flow(client, store, items); self.submit(client)
        self.assertEqual(client.submit_payment().state, 'PAYMENT_UNKNOWN')
        self.assertIsNone(client.payment_poller.context.payment_id)
        self.assertIsNone(client.payment_poller.context.metadata)
        with patch.object(h.time, 'sleep'):
            self.assertEqual(client.poll_payment(max_reads=1).state, 'PAYMENT_REPORTED_SUCCESS')
        status = next(c for c in self.calls if c[1] == '/pay/v2/payment/status')
        self.assertNotIn('paymentId', status[2]['params'])
        with self.assertRaises(h.orders.TalabatError): client.submit_payment()

    def test_async_stops_on_redirect_fallback_unknown_and_auth_without_callbacks(self):
        client, store, items = self.client(async_route=True)
        self.quote_flow(client, store, items); self.submit(client); client.submit_payment()
        ctx = client.payment_poller.context
        for response in (h.WireResponse(200, {'status':'redirection', 'redirectUrl':'https://challenge.invalid'}),
                         h.WireResponse(200, {'status':'success', 'fallback':{}}),
                         h.WireResponse(401, None), h.WireResponse(None, None)):
            poller = h.AsyncPaymentPoller(client.saved, ctx, receipt=client.receipt)
            with patch.object(h, '_wire', return_value=response) as wire, patch.object(h.time, 'sleep'), \
                 patch.object(h.auth, 'refresh') as refresh:
                poller.poll(); poller.poll()
                self.assertEqual(wire.call_count, 1)
                refresh.assert_not_called()
        poller = h.AsyncPaymentPoller(client.saved, ctx, receipt=client.receipt)
        with patch.object(h.auth, 'expiry', return_value=0), patch.object(h, '_wire') as wire, patch.object(h.time, 'sleep') as sleep:
            self.assertEqual(poller.poll().reason, 'ASYNC_READ_AUTH_RENEWAL_REQUIRED')
            wire.assert_not_called(); sleep.assert_not_called()

    def test_private_receipt_failure_stops_financial_continuation(self):
        client, store, items = self.client(async_route=True)
        self.quote_flow(client, store, items)
        client.receipt = lambda record: False
        with self.assertRaisesRegex(h.orders.TalabatError, 'RECEIPT_PERSIST_FAILED'):
            self.submit(client)
        self.assertEqual(client.placed.order_id, '1234567890')
        with self.assertRaises(h.orders.TalabatError): client.submit_payment()
        self.assertFalse(any(c[1] == '/pay/v1/payments' for c in self.calls))

    def test_place_challenge_receipt_keeps_ids_but_omits_redirect(self):
        client, store, items = self.client(async_route=True)
        self.quote_flow(client, store, items)
        original = h._wire.side_effect
        def challenged(saved, deadline, method, path, **kwargs):
            if path.endswith('/placeOrder'):
                return h.WireResponse(200, {'placedOrder': {'orderId':'1234567890', 'transactionId':'synthetic-txn',
                    'balanceAmount':'35.00', 'redirectUrl':'https://challenge.invalid/private'}})
            return original(saved, deadline, method, path, **kwargs)
        with patch.object(h, '_wire', side_effect=challenged):
            self.assertEqual(self.submit(client).state, 'CHALLENGE_REQUIRED')
        receipt = self.receipts[-1]['observation']
        self.assertEqual(receipt.order_id, '1234567890')
        self.assertEqual(receipt.state, 'CHALLENGE_REQUIRED')
        self.assertIsNone(receipt.redirect_url)
        with self.assertRaises(h.orders.TalabatError): client.submit_payment()

    def test_async_recovery_account_mismatch_and_receipt_failure_stop(self):
        client, store, items = self.client(async_route=True)
        self.quote_flow(client, store, items); self.submit(client); client.submit_payment()
        saved = copy.deepcopy(client.saved); saved['expected_profile']['id'] = 88; saved['auth']['customerId'] = 88
        with self.assertRaisesRegex(h.orders.TalabatError, 'ACCOUNT_MISMATCH'):
            h.AsyncPaymentPoller(saved, client.payment_poller.context, receipt=client.receipt)
        client.payment_poller.receipt = lambda record: False
        with patch.object(h, '_wire', return_value=h.WireResponse(200, {'status':'pending'})) as wire, patch.object(h.time, 'sleep'):
            with self.assertRaisesRegex(h.orders.TalabatError, 'RECEIPT_PERSIST_FAILED'): client.poll_payment()
            client.payment_poller.poll()
            self.assertEqual(wire.call_count, 1)

    def test_cart_quote_success_receipts_are_minimal_and_precede_return(self):
        client, store, items = self.client(async_route=True)
        quote = self.quote_flow(client, store, items)
        self.assertEqual([r['state'] for r in self.receipts], ['SUCCEEDED']*3)
        self.assertEqual([r['operation'] for r in self.receipts],
                         ['create_cart', 'quote_initial', 'quote_selected_quiet'])
        self.assertEqual(set(self.receipts[0]), {'flow_id','operation','state','http_status','cart_id','cart_binding'})
        self.assertEqual(set(self.receipts[-1]), {'flow_id','operation','state','http_status','cart_binding',
                                               'currency','payable_minor','review_sha256'})
        self.assertEqual(self.receipts[-1]['review_sha256'], h.project_quote(quote)['quote_digest'])
        for value in ('synthetic-token', 'synthetic-address', 'synthetic-private-instrument', PRODUCT):
            self.assertNotIn(value, json.dumps(self.receipts))

    def test_bad_cart_fences_but_bad_quote_is_nonfinancial_failure(self):
        for phase in ('create_cart', 'quote_initial'):
            for response in (h.WireResponse(200, {}), h.WireResponse(503, None), h.WireResponse(200, None)):
                with self.subTest(phase=phase, response=response):
                    client, store, items = self.client()
                    if phase == 'quote_initial':
                        client.create_cart(store, items, verticals_key=KEY); client.payment_config()
                    original = h._wire.side_effect
                    def wire(saved, deadline, method, path, **kwargs):
                        return response if method == 'POST' else original(saved, deadline, method, path, **kwargs)
                    with patch.object(h, '_wire', side_effect=wire):
                        error = 'UNKNOWN_NO_CONTINUATION' if phase == 'create_cart' else 'PREPARATION_FAILED:'
                        with self.assertRaisesRegex(h.orders.TalabatError, error):
                            if phase == 'create_cart': client.create_cart(store, items, verticals_key=KEY)
                            else: client.prepare(selected=False)
                    self.assertEqual(self.receipts[-1]['state'],
                                     'SUBMISSION_UNKNOWN' if phase == 'create_cart' else 'PREPARATION_FAILED')
                    if phase != 'create_cart':
                        self.assertTrue(h.quote_diagnostics.valid(self.receipts[-1]['diagnostic']))
                    self.assertEqual(self.receipts[-1]['operation'], phase)
                    count = len(self.calls)
                    with self.assertRaises(h.orders.TalabatError): client._mutate('another_phase', '/denied', {})
                    self.assertEqual(len(self.calls), count)
                    self.wire_patch.stop()

    def test_cart_quote_failed_receipt_fences_following_mutation(self):
        for phase in ('create_cart', 'quote_initial'):
            with self.subTest(phase=phase):
                client, store, items = self.client()
                if phase == 'quote_initial':
                    client.create_cart(store, items, verticals_key=KEY); client.payment_config()
                client.receipt = lambda record: False
                with self.assertRaisesRegex(h.orders.TalabatError, 'RECEIPT_PERSIST_FAILED'):
                    if phase == 'create_cart': client.create_cart(store, items, verticals_key=KEY)
                    else: client.prepare(selected=False)
                self.assertIsNone(client.quote)
                if phase == 'create_cart': self.assertIsNone(client.cart)
                with self.assertRaisesRegex(h.orders.TalabatError, 'RECEIPT_PERSIST_FAILED'):
                    client._mutate('another_phase', '/denied', {})
                self.wire_patch.stop()

    def test_tracking_after_async_deadline_uses_fresh_read_budget_only(self):
        client, store, items = self.client(async_route=True)
        self.quote_flow(client, store, items); self.submit(client); client.submit_payment()
        old_deadline = time.monotonic() - 130
        client.deadline = old_deadline
        client.created_at = time.monotonic() - 200
        with patch.object(h.orders, 'request', side_effect=[client.saved['expected_profile'],
                {'type':'OrderTrackingScreen', 'common_tracking_event_attributes':
                 {'order_id':'1234567890','delivery_status':'order_delivered'}}]) as read, \
                patch('talabat_http_list.page_request', return_value={'orders':[
                    {'id':'1234567890','status':'Delivered'}],'is_last_page':True,'total_orders':1}):
            before = time.monotonic()
            self.assertEqual(client.track(timeout=7)['status'], 'delivered')
            self.assertGreaterEqual(read.call_args.args[2], before + 7)
            self.assertLessEqual(read.call_args.args[2], time.monotonic() + 7)
        self.assertEqual(client.deadline, old_deadline)
        with self.assertRaises(h.orders.TalabatError): client._mutate('anything', '/denied', {})
        with patch.object(h.auth, 'expiry', return_value=0), patch.object(h.orders, 'request') as read:
            with self.assertRaisesRegex(h.orders.TalabatError, 'AUTH_EXPIRED'): client.track()
            read.assert_not_called()


class WireTests(unittest.TestCase):
    def decoded_wire(self, raw, encoding=''):
        response = io.BytesIO(raw)
        response.code = 200
        response.headers = {'Content-Encoding': encoding}
        with patch.object(h.auth, 'native_headers', return_value={'Accept-Encoding':'br, gzip'}), \
             patch.object(h.urllib.request, 'build_opener') as factory:
            factory.return_value.open.return_value = response
            result = h._wire({'auth':{'access_token':'synthetic'}}, time.monotonic()+30,
                             'POST', '/ccx/v1/checkout/synthetic', body={})
            self.assertEqual(factory.return_value.open.call_count, 1)
            self.assertEqual(factory.return_value.open.call_args.args[0].get_header('Accept-encoding'), 'gzip')
            return result

    def test_strict_json_rejects_duplicate_totals_status_and_nonfinite(self):
        for raw in (b'{"total":35,"total":1}', b'{"status":"pending","status":"success"}',
                    b'{"checkout":{"amount":35,"amount":1}}', b'{"value":NaN}',
                    b'{"value":Infinity}', b'{"value":-Infinity}', b'{"value":1e999}',
                    b'{"value":"\xff"}', b'[]'):
            for encoding in ('', 'gzip'):
                with self.subTest(raw=raw, encoding=encoding):
                    result = self.decoded_wire(gzip.compress(raw) if encoding else raw, encoding)
                    self.assertEqual(result.status, 200)
                    self.assertIsNone(result.data)

    def test_gzip_success_and_bounded_compressed_expansion(self):
        raw = b'{"status":"success","redirectUrl":null}'
        self.assertEqual(self.decoded_wire(raw).data, json.loads(raw))
        self.assertEqual(self.decoded_wire(gzip.compress(raw), ' GZIP ').data, json.loads(raw))
        with patch.object(h, 'MAX_BYTES', 128):
            bomb = gzip.compress(b'{"padding":"' + b'a'*20000 + b'"}')
            self.assertLess(len(bomb), 128)
            self.assertIsNone(self.decoded_wire(bomb, 'gzip').data)
            self.assertIsNone(self.decoded_wire(b' '*129).data)
            exact = b'{"padding":"' + b'a'*114 + b'"}'
            self.assertEqual(len(exact), 128)
            self.assertEqual(self.decoded_wire(gzip.compress(exact), 'gzip').data, json.loads(exact))
        for payload, encoding in ((gzip.compress(raw)[:-1], 'gzip'), (b'not gzip', 'gzip'),
                                  (gzip.compress(raw) + gzip.compress(b'{}'), 'gzip'),
                                  (gzip.compress(raw) + b'extra', 'gzip'), (raw, 'br'), (raw, 'gzip, gzip')):
            with self.subTest(encoding=encoding, payload_length=len(payload)):
                self.assertIsNone(self.decoded_wire(payload, encoding).data)

    def test_status_query_escapes_opaque_values_without_changing_identity(self):
        from urllib.parse import urlsplit, parse_qs
        saved = {'auth': {'access_token': 'synthetic-secret'}}
        ctx = h.AsyncPaymentContext('12345', 'synthetic+encrypted/==&foo', FLOW, (1.0,), '0'*64,
                                    'synthetic+pay&x=', 'synthetic metadata+/&=')
        with patch.object(h.auth, 'native_headers', return_value={}), patch.object(h.urllib.request, 'build_opener') as factory:
            factory.return_value.open.side_effect = TimeoutError()
            h._wire(saved, time.monotonic()+30, 'GET', '/pay/v2/payment/status',
                    params=h.payment_status_params(ctx), headers={'x-acceptance-request-id': FLOW})
            req = factory.return_value.open.call_args.args[0]
            self.assertEqual(parse_qs(urlsplit(req.full_url).query),
                             {k:[v] for k,v in h.payment_status_params(ctx).items()})
            self.assertEqual(req.get_method(), 'GET')
            self.assertIsNone(req.data)
            self.assertEqual(req.get_header('X-acceptance-request-id'), FLOW)

    def test_redirect_auth_error_timeout_malformed_never_repeat(self):
        saved = {'auth': {'access_token': 'synthetic-secret'}}
        for error in (urllib.error.HTTPError('https://api.talabat.com', 307, 'redirect', {}, io.BytesIO(b'{}')),
                      urllib.error.HTTPError('https://api.talabat.com', 401, 'expired', {}, io.BytesIO(b'{}')),
                      TimeoutError('private-secret'), h.orders.TalabatError('NATIVE_READ_TIMEOUT')):
            with patch.object(h.auth, 'native_headers', return_value={'Authorization': 'old', 'X-User-Flow': 'old'}), \
                 patch.object(h.urllib.request, 'build_opener') as factory, patch.object(h.auth, 'refresh') as refresh:
                factory.return_value.open.side_effect = error
                result = h._wire(saved, time.monotonic()+30, 'POST', '/pay/v1/payments', body={})
                self.assertIn(result.status, (None, 307, 401))
                self.assertEqual(factory.return_value.open.call_count, 1)
                self.assertTrue(any(isinstance(x, h.orders.NoRedirect) for x in factory.call_args.args))
                request = factory.return_value.open.call_args.args[0]
                self.assertEqual(request.get_header('Authorization'), 'Bearer synthetic-secret')
                self.assertIsNone(request.get_header('X-user-flow'))
                refresh.assert_not_called()


class RestaurantBFFQuoteTests(unittest.TestCase):
    """Live-captured CalculEat BFF shape (2026-10-11): int line ids equal to
    cart_id+1, display-string charges (no raw amount), AutoAppliedDiscount =
    account-level pro booster."""

    def test_parse_quote_accepts_restaurant_bff_shape(self):
        home, config, card, store, items, cart, parsed0, data = context()
        rstore = h.Store('restaurants', 667942, 0, False)
        ritems = (h.Item(1922796571, 1),)
        parsed = h.parse_cart({'cart': {'id': 12345, 'totalValue': 24.5, 'items': [
            {'menuItemId': 1922796571, 'id': 12346, 'quantity': 1,
             'specialRequest': '', 'choices': []}]}}, rstore, ritems)
        self.assertEqual(parsed.quote_item_ids, ((1922796571, '12346'),))
        checkout = data['checkout']
        data['tracking']['cartId'] = '12345'
        checkout['branchId'] = 667942
        checkout['amount'] = '31.15'
        checkout['discountsTotal'] = '10.5'
        checkout['cart']['items'] = [{'id': 12346, 'name': 'Vanilla Raspberry Protein Shake',
            'quantity': 1, 'price': 'AED 35.00', 'total': 'AED 35.00',
            'specialRequest': '', 'choicesString': ''}]
        checkout['paymentSummary']['items'] = [
            {'type': 'SubTotal', 'title': 'Subtotal', 'value': 'AED 35.00'},
            {'type': 'AutoAppliedDiscount', 'title': 'Exclusive discount', 'value': 'AED 10.50'},
            {'type': 'DeliveryFee', 'title': 'Delivery fee', 'value': 'AED 4.90'},
            {'type': 'ServiceFee', 'title': 'Service fee', 'value': 'AED 1.75'},
            {'type': 'Total', 'title': 'Total amount', 'value': 'AED 31.15'}]
        body = h.prepare_body(rstore, home, selection=None, features={'paySupportsTPro': False})
        quote = h.parse_quote(data, parsed, home, body, None)
        self.assertEqual(quote.amount_minor, 3115)

    def test_parse_quote_rejects_foreign_restaurant_line_id(self):
        home, config, card, store, items, cart, parsed0, data = context()
        rstore = h.Store('restaurants', 667942, 0, False)
        ritems = (h.Item(1922796571, 1),)
        parsed = h.parse_cart({'cart': {'id': 12345, 'totalValue': 24.5, 'items': [
            {'menuItemId': 1922796571, 'id': 12346, 'quantity': 1,
             'specialRequest': '', 'choices': []}]}}, rstore, ritems)
        checkout = data['checkout']
        data['tracking']['cartId'] = '12345'
        checkout['branchId'] = 667942
        checkout['amount'] = '31.15'
        checkout['cart']['items'] = [{'id': 99999, 'name': 'Vanilla Raspberry Protein Shake',
            'quantity': 1, 'price': 'AED 35.00', 'total': 'AED 35.00',
            'specialRequest': '', 'choicesString': ''}]
        checkout['paymentSummary']['items'] = [
            {'type': 'SubTotal', 'title': 'Subtotal', 'value': 'AED 35.00'},
            {'type': 'AutoAppliedDiscount', 'title': 'Exclusive discount', 'value': 'AED 10.50'},
            {'type': 'DeliveryFee', 'title': 'Delivery fee', 'value': 'AED 4.90'},
            {'type': 'ServiceFee', 'title': 'Service fee', 'value': 'AED 1.75'},
            {'type': 'Total', 'title': 'Total amount', 'value': 'AED 31.15'}]
        body = h.prepare_body(rstore, home, selection=None, features={'paySupportsTPro': False})
        with self.assertRaises(Exception) as caught:
            h.parse_quote(data, parsed, home, body, None)
        self.assertEqual(str(caught.exception), 'QUOTE_ITEM_MANIFEST_MISMATCH')


if __name__ == '__main__':
    unittest.main()


class ParkFailedReceiptTest(unittest.TestCase):
    def test_retain_parks_record_before_raising(self):
        import tempfile, os, json
        import talabat_http_checkout as h
        record = {'flow_id': 'f' * 8, 'operation': 'place', 'observation': None,
                  'http_status': 200}
        saved = {}
        real_makedirs, real_open = os.makedirs, os.fdopen

        def bomb(rec):
            raise RuntimeError('store down')

        with tempfile.TemporaryDirectory() as tmp:
            home = os.path.join(tmp, 'home')
            os.makedirs(home)
            import commerce_journal as journal_mod
            with patch.object(journal_mod, 'ROOT', type(journal_mod.ROOT)(home)):
                try:
                    h._retain(bomb, record)
                    raised = False
                except h.orders.TalabatError as e:
                    raised = str(e) == 'RECEIPT_PERSIST_FAILED_NO_MUTATION_RETRY'
                self.assertTrue(raised)
                pending = os.path.join(home, 'pending')
                files = os.listdir(pending) if os.path.isdir(pending) else []
                self.assertEqual(len(files), 1)
                data = json.load(open(os.path.join(pending, files[0])))
                self.assertEqual(data['operation'], 'place')

    def test_retain_parking_failure_still_raises(self):
        import talabat_http_checkout as h

        def bomb(rec):
            raise RuntimeError('store down')

        with patch('os.makedirs', side_effect=OSError('disk')):
            with self.assertRaises(h.orders.TalabatError):
                h._retain(bomb, {'operation': 'place'})


class GroceryDiscountQuoteTests(unittest.TestCase):
    """Split-fee era quotes: GroceryDiscountType promo, undiscounted SubTotal."""

    def test_parse_quote_accepts_grocery_discount_split_fees(self):
        for vertical in ('mart', 'shops'):
            with self.subTest(vertical=vertical):
                home, config, card, store, items, cart, parsed0, data = context(vertical)
                parsed = h.parse_cart({'id': 'synthetic-owned-cart', 'items': [
                    {'product_id': PRODUCT, 'quantity': 2, 'increment_weight': None}],
                    'subtotal_after_discount': 21.6, 'total': 31.56}, store, items)
                checkout = data['checkout']
                data['tracking']['cartId'] = parsed.cart_id
                checkout['branchId'] = store.branch_id
                checkout['amount'] = 31.56
                checkout['cart']['items'] = [{'id': '333', 'itemGuid': PRODUCT,
                                              'quantity': 2, 'price': '10.80', 'total': '21.60'}]
                checkout['paymentSummary']['items'] = [
                    {'type': 'SubTotal', 'amount': 24}, {'type': 'GroceryDiscountType', 'amount': 2.4},
                    {'type': 'DeliveryFee', 'amount': 9}, {'type': 'ServiceFee', 'amount': 0.96},
                    {'type': 'Total', 'amount': 31.56}]
                body = h.prepare_body(store, home, selection=None, features={'paySupportsTPro': False})
                quote = h.parse_quote(data, parsed, home, body, None)
                self.assertEqual(quote.amount_minor, 3156)
                # Exact net cart truth still stops a coherent but changed quote.
                checkout['cart']['items'][0].update(price='10.90', total='21.80')
                checkout['paymentSummary']['items'][1]['amount'] = 2.2
                checkout['paymentSummary']['items'][-1]['amount'] = checkout['amount'] = 31.76
                with self.assertRaisesRegex(h.orders.TalabatError, 'QUOTE_AMOUNT_RECONCILIATION_FAILED'):
                    h.parse_quote(data, parsed, home, body, None)

    def test_parse_quote_still_accepts_undiscounted_shape(self):
        home, config, card, store, items, cart, parsed0, data = context()
        parsed = h.parse_cart(cart, store, items)
        data['tracking']['cartId'] = parsed0.cart_id
        body = h.prepare_body(store, home, selection=None, features={'paySupportsTPro': False})
        quote = h.parse_quote(data, parsed, home, body, None)
        self.assertEqual(quote.amount_minor, 3500)
