"""Offline HTTP fixtures through the owned cart, verification and CLI error paths."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch, Mock

os.environ.setdefault('ORDERING_PAUSE_FILE', '/nonexistent/935-ordering-pause')
import commerce_cli as cli
import commerce_journal as j
import commerce_nownow_order as lane
import commerce_preorder as pre
import commerce_nownow as reads
import order_card
from test import test_commerce_nownow_order as f

CASES = json.loads((Path(__file__).parent / 'fixture_nownow_postauth_states.json').read_text())


class StateFixtures(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        for mod, key, value in ((j, 'ROOT', Path(temp.name).resolve()/'commerce'),
                (lane.receipts, 'ROOT', Path(temp.name).resolve()/'commerce'),
                (order_card, 'LAST4', '2342'), (order_card, 'NETWORK', 'mastercard')):
            p = patch.object(mod, key, value); p.start(); self.addCleanup(p.stop)

    def clear_response(self, harness):
        original = harness.request
        def request(operation, *args, **kwargs):
            if operation == 'cart_delete':
                harness.responses.update(cart_delete={'data': None, 'status': 'success'},
                    cart_get={'data': None}, carts_recent={'data': {'carts': []}})
            return original(operation, *args, **kwargs)
        return request

    def test_notice_and_stale_cart_fixtures(self):
        for case in CASES:
            if 'patch' not in case and case['state'] != 'stale_store_cart': continue
            with self.subTest(state=case['state']):
                responses = f.happy_responses()
                if case['state'] == 'stale_store_cart':
                    responses['carts_recent'] = {'data': {'carts': [f.nn_state()['data']]}}
                else:
                    responses['cart_get']['data'].update(copy.deepcopy(case['patch']))
                flow, harness = f.make_flow(responses)
                flow.client._request = self.clear_response(harness)
                if case.get('error'):
                    with self.assertRaisesRegex(j.JournalError, case['error']) as caught:
                        flow.prepare_only()
                    # This is the caller's terminal message, plus cleanup evidence.
                    self.assertEqual(str(caught.exception), case['error'])
                    cleanup = flow.stop_unsent()
                    if flow.opened:
                        self.assertTrue(cleanup['cart_empty'])
                    else:
                        self.assertFalse(cleanup['cart_checked'])
                else:
                    result = flow.prepare_only()
                    self.assertEqual(result['reviewed_total_minor'], 3145)
                    self.assertLess(result['flow_age_seconds'], 60)
                    self.assertTrue(result['prepared_only'])
                if flow.opened:
                    self.assertEqual(j.inspect(flow.flow_id)['state'], case['journal'])
                    if case['journal'] == 'ACTIVE': flow.stop_unsent()
                self.assertFalse(any(op in ('place', 'payment_complete') for op, _ in harness.calls))

    def test_expired_fixture_clears_retained_cart(self):
        flow, harness = f.make_flow(f.happy_responses()); flow.prepare_only()
        with patch.object(j, 'flow_created_at', return_value=time.time()-25*3600):
            with self.assertRaisesRegex(j.JournalError, 'NOWNOW_FLOW_EXPIRED_24H'):
                lane.NowNowOrderFlow.resume_active(flow.flow_id, store_code=f.STORE,
                    product_code=f.PRODUCT, quantity=1, auth=f.FakeAuth(), request=harness.request)
        flow.client._request = self.clear_response(harness)
        self.assertTrue(flow.stop_unsent()['cart_empty'])
        self.assertEqual(j.inspect(flow.flow_id)['state'], 'RELEASED')

    def test_verification_fixtures_and_alerts(self):
        for case in CASES:
            if 'status' not in case: continue
            with self.subTest(state=case['state']), tempfile.TemporaryDirectory() as temp, \
                    patch.object(j, 'ROOT', Path(temp).resolve()/'commerce'), \
                    patch.object(lane.receipts, 'ROOT', Path(temp).resolve()/'commerce'):
                wire = {'status': case['status'], 'amount': 1, 'currency_code': 'AED',
                    'customer_code': 'synthetic-account', 'id_token': f.SYNTHETIC_TOKEN,
                    'cc_masked': 'xxxx2342', 'authorized_amount': 0, 'captured_amount': 0,
                    'reversed_amount': 0, 'refunded_amount': 0}
                if case.get('redirect'): wire['redirect_url'] = 'https://bank.example/challenge'
                responses = f.happy_responses(payment_config={}, payment_subscription={'data':'fixture-intent'},
                    payment_complete=wire, payment_status=wire)
                responses['cart_get']['data']['prepaidPaymentMisc']['isCvvRequired'] = True
                flow, harness = f.make_flow(responses); flow.prepare_only()
                storage = {}
                class Store:
                    def load(self, key): return copy.deepcopy(storage.get(key))
                    def store(self, key, value): storage[key] = copy.deepcopy(value)
                vault = pre.IntentVault(Store())
                with patch.object(pre, 'IntentVault', return_value=vault), \
                        patch('noon_cvv.encrypt', return_value={'encCvv':'fixture','publicKeyName':'fixture'}):
                    if case['status'] == 'payment_confirmed':
                        self.assertIsNone(flow.prepare_payment(lambda: b'123'))
                        message = 'verification_confirmed'
                    else:
                        with self.assertRaises(j.PaymentError) as caught:
                            flow.prepare_payment(lambda: b'123')
                        self.assertEqual(caught.exception.code, 'NOWNOW_BANK_APPROVAL_OR_PAYMENT_PENDING')
                        message = caught.exception.code
                    client = reads.reader(auth=f.FakeAuth()); client._request = harness.request
                    # Pending without an open redirect must still alert on the exact verification amount.
                    with patch.object(reads, 'reader', return_value=client), \
                            patch.object(pre, 'notify_owner', return_value=True) as notify, \
                            patch('commerce_redirect.open_once', return_value=True) as opened:
                        result = pre.await_payment(flow.flow_id, open_redirect=case.get('redirect', False), wait_seconds=0)
                    if case['status'] == 'payment_ready_to_redirect':
                        notify.assert_called_once_with(flow.flow_id, 100, '2342')
                        self.assertEqual(opened.call_count, int(case.get('redirect', False)))
                        self.assertTrue(result['notified']); self.assertFalse(result['verification_confirmed'])
                    else:
                        self.assertEqual(result['verification_confirmed'], case['status'] == 'payment_confirmed')
                    self.assertEqual(j.inspect(flow.flow_id)['state'], case['journal'])
                    self.assertEqual(message, 'verification_confirmed' if result['verification_confirmed'] else
                                     'NOWNOW_BANK_APPROVAL_OR_PAYMENT_PENDING')
                    self.assertEqual(sum(op == 'payment_complete' for op, _ in harness.calls), 1)
                    self.assertNotIn('place', [op for op, _ in harness.calls])
                    if case['journal'] == 'FENCED':
                        self.assertFalse(j.open_payments()[0]['in_flight'])
                        self.assertEqual(flow.stop_unsent()['reason'], 'NOWNOW_STOP_RECONCILIATION_REQUIRED')

    def test_gate_input_class_at_every_financial_boundary(self):
        for kind in ('place', 'payment', 'preauthorize', 'prepay'):
            for age, prep_age, review, allowed in (
                    (0, None, '5'*64, False), (0, 3600.01, '5'*64, False),
                    (43200.01, 0, '5'*64, False), (86400, 0, '5'*64, False),
                    (0, -1, '5'*64, False), (0, 0, '6'*64, False),
                    (43200, 3600, '5'*64, True)):
                with self.subTest(kind=kind, age=age, prep_age=prep_age, review=review), \
                        tempfile.TemporaryDirectory() as temp, patch.object(j, 'ROOT', Path(temp).resolve()/'commerce'):
                    flow = '10000000-0000-4000-8000-000000000001'
                    with patch.object(j.time, 'time', return_value=100000):
                        j.open_flow(flow_id=flow, app='noon', vertical='nownow', account_hash='1'*64, scope_hash='2'*64)
                        if prep_age is not None or kind == 'payment': j.record_nownow_prepared(flow, '5'*64)
                        if kind == 'payment':
                            j.consume(flow, 'place', kind='place', request_hash='3'*64, cart_hash='4'*64, review_hash='5'*64, payable_minor=3145)
                            j.observe(flow, 'place', outcome='ORDER_ID_RECEIVED', evidence_hash='8'*64, order_id='NNTEST1')
                    with j._db() as db:
                        db.execute('UPDATE flows SET created_at=?', (100000-age,))
                        if prep_age is not None: db.execute('UPDATE observations SET observed_at=?', (100000-prep_age,))
                        else: db.execute("DELETE FROM observations WHERE outcome='NOWNOW_PREPARED'")
                    before = j.inspect(flow)
                    with patch.object(j.time, 'time', return_value=100000):
                        if allowed:
                            j.require_nownow_prepared(flow, review)
                            if kind == 'prepay': continue  # Prepay also needs an exact retained preauthorization.
                            j.consume(flow, 'send', kind=kind, request_hash='3'*64,
                                cart_hash='4'*64, review_hash=review, payable_minor=3145,
                                **({'payment_order_id':'NNTEST1'} if kind == 'payment' else {}))
                        else:
                            with self.assertRaises(j.PaymentError) as caught:
                                j.consume(flow, 'send', kind=kind, request_hash='3'*64,
                                    cart_hash='4'*64, review_hash=review, payable_minor=3145,
                                    **({'payment_intent_hash':'7'*64} if kind == 'prepay' else {}),
                                    **({'payment_order_id':'NNTEST1'} if kind == 'payment' else {}))
                            self.assertIn('re-run --prepare-only', caught.exception.details['next_action'])
                            self.assertEqual(j.inspect(flow)['operations'], before['operations'])
                            self.assertEqual(j.inspect(flow)['reserved_minor'], before['reserved_minor'])

    def test_live_cli_cannot_prepare_itself_and_clear_errors_are_specific(self):
        with patch.object(cli, 'CommerceAuth') as auth:
            with self.assertRaises(j.PaymentError) as caught:
                cli.order_nownow(SimpleNamespace(prepare_only=False, resume_flow=None))
            self.assertEqual(caught.exception.code, 'NOWNOW_FRESH_PREPARE_REQUIRED')
            auth.assert_not_called()
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = cli.main(['clear-cart', 'nownow', '--flow', '10000000-0000-4000-8000-000000000099'])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output.getvalue())['error'], 'JOURNAL_FLOW_UNKNOWN')

    def test_wrong_lane_stop_never_releases_preparation(self):
        for app, vertical in (('noon', 'food'), ('noon', 'minutes'), ('noon', 'main'), ('noon', 'supermall'), ('talabat', 'shops')):
            with self.subTest(app=app, vertical=vertical), tempfile.TemporaryDirectory() as temp, patch.object(j, 'ROOT', Path(temp).resolve()/'commerce'):
                flow = '10000000-0000-4000-8000-000000000001'
                j.open_flow(flow_id=flow, app=app, vertical=vertical, account_hash='1'*64, scope_hash='2'*64)
                j.consume(flow, 'cart', kind='cart', request_hash='3'*64)
                j.observe(flow, 'cart', outcome='RESPONSE_RECEIVED', evidence_hash='4'*64)
                with self.assertRaisesRegex(j.PaymentError, 'NOWNOW_FLOW_REQUIRED'):
                    cli.order_nownow(SimpleNamespace(prepare_only=False, resume_flow=flow))
                self.assertEqual(j.inspect(flow)['state'], 'ACTIVE')
                self.assertEqual(len(j.inspect(flow)['operations']), 1)

    def test_verification_settles_only_until_the_purchase_send(self):
        flow = '10000000-0000-4000-8000-000000000001'
        j.open_flow(flow_id=flow, app='noon', vertical='nownow', account_hash='1'*64, scope_hash='2'*64)
        j.record_nownow_prepared(flow, '5'*64)
        args = dict(request_hash='3'*64, cart_hash='4'*64, review_hash='5'*64, payable_minor=2675)
        j.consume(flow, 'subscription', kind='preauthorize', **args)
        j.observe(flow, 'subscription', outcome='PREORDER_INTENT_RECEIVED', evidence_hash='6'*64)
        j.consume(flow, 'complete', kind='prepay', payment_intent_hash='6'*64, **args)
        j.observe(flow, 'complete', outcome='PREORDER_PAYMENT_CONFIRMED', evidence_hash='7'*64)
        j.observe(flow, 'complete', outcome='PREORDER_ZERO_AMOUNTS', evidence_hash='7'*64)
        self.assertFalse(j.open_payments()[0]['in_flight'])
        j.consume(flow, 'place', kind='place', **args)
        j.observe(flow, 'place', outcome='UNKNOWN', evidence_hash='8'*64)
        self.assertTrue(j.open_payments()[0]['in_flight'])
        j.observe(flow, 'place', outcome='ORDER_ID_RECEIVED', evidence_hash='8'*64, order_id='NNTEST1')
        self.assertTrue(j.open_payments()[0]['in_flight'])
        j.observe(flow, 'place', outcome='UNKNOWN', evidence_hash='8'*64, order_id='NNTEST1')
        self.assertTrue(j.open_payments()[0]['in_flight'])
        j.observe(flow, 'place', outcome='PAYMENT_REPORTED_SUCCESS', evidence_hash='9'*64, order_id='NNTEST1')
        self.assertFalse(j.open_payments()[0]['in_flight'])

    def test_ambiguous_delete_stays_fenced_and_cannot_repeat(self):
        flow, harness = f.make_flow(f.happy_responses()); flow.prepare_only()
        harness.responses['cart_delete'] = TimeoutError('private-body')
        with self.assertRaises(Exception): flow.stop_unsent()
        self.assertEqual(j.inspect(flow.flow_id)['state'], 'FENCED')
        self.assertEqual(flow.stop_unsent()['reason'], 'NOWNOW_STOP_RECONCILIATION_REQUIRED')
        self.assertEqual(sum(op == 'cart_delete' for op, _ in harness.calls), 1)

    def test_replacement_sessions_are_never_deleted_on_cli_resume(self):
        import commerce_nownow_cleanup as cleanup
        import commerce_preorder_release as release
        original_resume = lane.NowNowOrderFlow.resume_active
        original_clear = cleanup.clear_cart
        for complete, replacement_read in ((True, 1), (True, 2), (False, 1), (False, 2)):
            with self.subTest(complete=complete, replacement_read=replacement_read), tempfile.TemporaryDirectory() as temp, \
                    patch.object(j, 'ROOT', Path(temp).resolve()/'commerce'), \
                    patch.object(lane.receipts, 'ROOT', Path(temp).resolve()/'commerce'):
                flow, harness = f.make_flow(f.happy_responses())
                if complete: flow.prepare_only()
                else:
                    flow.guard(); flow.create_session()
                foreign = copy.deepcopy(harness.responses['cart_get']['data'])
                foreign['checkoutSessionCode'] = 'FOREIGN-SAME-BASKET'
                calls = 0
                base_request = self.clear_response(harness)
                def request(operation, *args, **kwargs):
                    nonlocal calls
                    if operation == 'cart_get':
                        calls += 1
                        if calls >= replacement_read:
                            harness.responses['cart_get'] = {'data':copy.deepcopy(foreign)}
                            harness.responses['carts_recent'] = {'data':{'carts':[copy.deepcopy(foreign)]}}
                    return base_request(operation, *args, **kwargs)
                reader = reads.reader(auth=f.FakeAuth()); reader._request = request
                args = SimpleNamespace(resume_flow=flow.flow_id, store_code=f.STORE,
                    prepare_only=not complete, cvv_from_keychain=False, label='fixture', recipient='owner')
                with patch.object(cli,'CommerceAuth',return_value=SimpleNamespace(noon=f.FakeAuth())), \
                        patch.object(cli,'input_items',return_value=flow.items), \
                        patch.object(lane.NowNowOrderFlow,'resume_active',side_effect=lambda fid, **kw: original_resume(fid, request=request, **kw)), \
                        patch.object(cleanup,'clear_cart',side_effect=lambda fid: original_clear(fid, auth=f.FakeAuth(), request=request)), \
                        patch.object(release,'reader',return_value=reader), patch.object(reads,'reader',return_value=reader):
                    with self.assertRaises(j.PaymentError) as caught:
                        cli.order_nownow(args)
                self.assertEqual(caught.exception.code,'NOWNOW_SESSION_OWNERSHIP_UNPROVEN')
                self.assertNotIn('cart_delete',[op for op, _ in harness.calls])
                self.assertEqual(harness.responses['cart_get']['data']['checkoutSessionCode'],'FOREIGN-SAME-BASKET')
                self.assertEqual(j.inspect(flow.flow_id)['reserved_minor'],0)

    def test_retention_and_closed_cleanup_require_creation_provenance(self):
        import commerce_nownow_capture as capture
        import commerce_nownow_cleanup as cleanup
        flow, harness = f.make_flow(f.happy_responses()); flow.prepare_only()
        original_hash = j.digest({'session': flow.session_code})
        with self.assertRaisesRegex(j.JournalError, 'NOWNOW_SESSION_ALREADY_BOUND'):
            j.bind_nownow_session(flow.flow_id, j.digest({'session':'FOREIGN-SAME-BASKET'}))
        j.require_nownow_session(flow.flow_id, original_hash)
        flow.review['projection']['session'] = 'FOREIGN-SAME-BASKET'
        flow.review['digest'] = j.digest(flow.review['projection'])
        with self.assertRaisesRegex(j.JournalError, 'NOWNOW_SESSION_OWNERSHIP_UNPROVEN'):
            capture.retain(flow)
        path = j.ROOT/'nownow'/(flow.flow_id+'.json')
        retained = json.loads(path.read_text())
        self.assertEqual(retained['review']['projection']['session'],'S-SESSION-1')
        # Reproduce a retained review written by the old adoption path.
        retained['review'] = flow.review
        path.write_text(json.dumps(retained))
        j.abandon(flow.flow_id)
        request = Mock()
        with self.assertRaisesRegex(j.JournalError, 'NOWNOW_SESSION_OWNERSHIP_UNPROVEN'):
            cleanup.clear_cart(flow.flow_id, auth=f.FakeAuth(), request=request)
        request.assert_not_called()

    def test_cleanup_never_trusts_an_adopted_session_without_ownership(self):
        flow, harness = f.make_flow(f.happy_responses()); flow.prepare_only()
        for owned in (None, 'S-SESSION-1'):
            with self.subTest(owned=owned):
                flow.owned_session_code = owned
                flow.session_code = 'FOREIGN-SAME-BASKET'
                before = len(harness.calls)
                self.assertEqual(flow.stop_unsent()['reason'],'NOWNOW_STOP_OWNERSHIP_UNPROVEN')
                self.assertEqual(len(harness.calls),before)
                self.assertEqual(j.inspect(flow.flow_id)['state'],'ACTIVE')

    def test_retracted_capture_reopens_in_flight_context(self):
        flow = '10000000-0000-4000-8000-000000000001'
        j.open_flow(flow_id=flow, app='noon', vertical='food', account_hash='1'*64, scope_hash='2'*64)
        j.consume(flow, 'place', kind='place', request_hash='3'*64, cart_hash='4'*64,
                  review_hash='5'*64, payable_minor=2675)
        for outcome in ('ORDER_ID_RECEIVED', 'PAYMENT_REPORTED_SUCCESS', 'EXACT_ORDER_CONFIRMED', 'TRACKER_REGISTERED'):
            j.observe(flow, 'place', outcome=outcome, evidence_hash='6'*64, order_id='FSYNTHETIC1')
        j.complete(flow)
        self.assertEqual(j.open_payments(), [])
        j.retract_food_capture_claim(flow, evidence_hash='7'*64)
        reopened = j.open_payments()[0]
        self.assertEqual(reopened['state'], 'FENCED')
        self.assertTrue(reopened['in_flight'])
        self.assertGreater(reopened['settlement_epoch'], 0)


if __name__ == '__main__': unittest.main()
