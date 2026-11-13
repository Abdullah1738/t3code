"""Real request entry points with only merchant transport and notifications stubbed."""
import contextlib
import io
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

import test_fastpath as delivery
item, t = delivery.item, delivery.t

APP = Path(__file__).resolve().parents[3] / 'app-api-cli'
sys.path.insert(0, str(APP))
sys.path.insert(0, str(APP / 'test'))
import careem_account_auth as careem
import commerce_journal as journal
import commerce_receipts as receipts
import inbox_auth
import test_careem_account_auth as careem_fixture
import test_commerce_main_order as main_fixture


class RequestCallerTests(unittest.TestCase):
    setUp = delivery.DeliveryTests.setUp
    run_items = delivery.DeliveryTests.run_items
    notifications = delivery.DeliveryTests.notifications

    def prepare_registry(self):
        self.stack.enter_context(patch.object(inbox_auth, 'DATA', self.data))
        self.stack.enter_context(patch.object(inbox_auth, 'WATCHERS', self.root))
        t.atomic(self.wd / 'watcher.json', {'paused': False})

    def test_careem_request_records_before_dispatch_and_suppresses_only_its_otp(self):
        self.prepare_registry()
        def transport(method, url, *args):
            if url == careem.ROUTES['pow'][1]:
                return 200, {}
            self.assertEqual(url, careem.ROUTES['otp'][1])
            evidence = t.read_json(self.data / 'inflight-actions.json', [])
            self.assertEqual([a['sender'] for a in evidence], ['careem'])
            self.assertTrue(all(a['at'] <= time.time() for a in evidence))
            return 202, {'retry_in': 30, 'expires_in': 300, 'otp_length': 6}
        with patch.object(careem, 'guest_context', return_value=careem_fixture.context()), \
             patch.object(careem, 'solve_pow', return_value='pow:fixture:0'), \
             patch.object(careem, '_transport', side_effect=transport):
            flow = careem.Bootstrap(careem_fixture.PHONE, mutate=True)
            flow.last_challenge = 'OTP'
            flow.request_otp()
        self.run_items([item('Careem', 'Your verification code is 123 456.', ts=time.time())])
        self.assertEqual(self.notifications(), [])
        self.run_items([item('Apple', 'Your Apple ID Code is 123 456.', id='imsg:other', ts=time.time())])
        self.assertEqual(len(self.notifications()), 2)
        evidence = t.read_json(self.data / 'inflight-actions.json', [])
        self.assertEqual(set(evidence[0]), {'sender', 'account', 'at'})

    def test_noon_real_place_records_selected_bank_before_financial_transport(self):
        self.prepare_registry()
        self.stack.enter_context(patch.object(journal, 'ROOT', self.root.resolve() / 'commerce'))
        self.stack.enter_context(patch.object(receipts, 'ROOT', self.root.resolve() / 'commerce'))
        for last4, sender in (('2342', 'EmiratesNBD'), ('9546', 'Mashreq')):
            with self.subTest(last4=last4), patch.object(journal.order_card, 'LAST4', last4):
                # The actual Main caller validates the selected card before reserving place.
                responses = main_fixture.happy_responses(
                    order_status=[{'status': 'pending', 'clientSecret': 'fixture-intent'},
                                  main_fixture.FIXTURE['status_success']],
                    payment_complete={'status': 'payment_pending'})
                responses['session']['isCvvRequired'] = False
                for method in responses['session']['paymentMethods']:
                    for card in method.get('cards', []):
                        card['id'] = 'fixture-card-token'
                def replace_card(value):
                    if isinstance(value, dict):
                        return {k: replace_card(v) for k, v in value.items()}
                    if isinstance(value, list):
                        return [replace_card(v) for v in value]
                    return value.replace('2342', last4) if isinstance(value, str) else value
                responses = replace_card(responses)
                # Distinct account to retain the previous financial operation's fence.
                if last4 == '9546':
                    self.stack.enter_context(patch.object(journal, 'ROOT', self.root.resolve() / 'commerce2'))
                    self.stack.enter_context(patch.object(receipts, 'ROOT', self.root.resolve() / 'commerce2'))
                flow, wire = main_fixture.make_flow(responses)
                flow.offers = {main_fixture.SKU: main_fixture.OFFER}
                wire.responses['cart'] = main_fixture.cart_state()
                flow.add()
                flow.checkout_session()
                flow.review_session()
                flow.prepare_payment()
                original_request = wire.request
                # Client captured the bound method at construction; wrap that boundary.
                def request(op, *args, **kwargs):
                    if op.name in ('place', 'payment_complete'):
                        evidence = t.read_json(self.data / 'inflight-actions.json', [])
                        self.assertIn(sender.casefold(), [a['sender'] for a in evidence])
                    return original_request(op, *args, **kwargs)
                with patch.object(flow.client, '_request', side_effect=request), contextlib.redirect_stdout(io.StringIO()):
                    flow.place()
                    flow.await_success(notify=None, sleep=lambda _: None)
                evidence = t.read_json(self.data / 'inflight-actions.json', [])
                self.assertEqual(sum(a['sender'] == sender.casefold() for a in evidence), 2)
                self.run_items([item(sender, 'Your OTP for purchase of AED 1200 is 123 456.',
                                     ts=time.time(), id=f'imsg:bank-{last4}')])
                self.assertEqual(self.notifications(), [])

    def test_registry_failure_stops_careem_before_otp_dispatch(self):
        self.prepare_registry()
        with patch.object(careem, 'guest_context', return_value=careem_fixture.context()), \
             patch.object(careem, 'solve_pow', return_value='pow:fixture:0'), \
             patch.object(careem, '_transport', return_value=(200, {})) as transport, \
             patch.object(inbox_auth, 'SOURCE', self.root / 'missing'):
            flow = careem.Bootstrap(careem_fixture.PHONE, mutate=True)
            flow.last_challenge = 'OTP'
            with self.assertRaisesRegex(RuntimeError, 'REGISTRY_UNAVAILABLE'):
                flow.request_otp()
            self.assertEqual(transport.call_count, 1)  # read-only proof of work only

    def test_unknown_card_does_not_register_a_bank_or_suppress_auth(self):
        self.prepare_registry()
        inbox_auth.expect_payment('9999')
        self.assertFalse((self.data / 'inflight-actions.json').exists())
        self.run_items([item('Mashreq', 'Your verification code is 123 456.', ts=time.time())])
        self.assertEqual(len(self.notifications()), 2)

    def test_registry_failure_rolls_back_financial_consume_before_dispatch(self):
        self.prepare_registry()
        self.stack.enter_context(patch.object(journal, 'ROOT', self.root.resolve() / 'commerce'))
        flow_id = '00000000-0000-4000-8000-000000000938'
        journal.open_flow(flow_id=flow_id, app='noon', vertical='main', account_hash='a'*64, scope_hash='b'*64)
        with patch.object(inbox_auth, 'SOURCE', self.root / 'missing'):
            with self.assertRaises(journal.JournalError):
                journal.consume(flow_id, 'place', kind='place', request_hash='c'*64,
                                cart_hash='d'*64, review_hash='e'*64, payable_minor=120000)
        self.assertEqual(journal.inspect(flow_id)['operations'], [])


if __name__ == '__main__':
    unittest.main()
