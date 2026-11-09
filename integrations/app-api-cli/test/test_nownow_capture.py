import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import commerce_journal as j
import commerce_nownow_order as c
import commerce_nownow_capture as capture
from test.test_commerce_nownow_order import make_flow, happy_responses, FakeAuth, STORE, PRODUCT


class CaptureTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        for module in (j, c.receipts):
            p = patch.object(module, 'ROOT', Path(temp.name) / 'commerce')
            p.start()
            self.addCleanup(p.stop)

    def test_tracking_alone_never_confirms_capture(self):
        flow, harness = make_flow(happy_responses())
        flow.prepare_only()
        flow.place()
        with patch('commerce_food_capture.find_bank_capture', side_effect=j.JournalError('pending')):
            with self.assertRaisesRegex(j.JournalError, 'pending'):
                flow.confirm_paid(flow.poll_tracking())
        with self.assertRaises(j.JournalError):
            j.complete(flow.flow_id)
        self.assertEqual(sum(op == 'place' for op, _ in harness.calls), 1)

    def test_cvv_completion_consumed_once_and_no_secret_on_disk(self):
        responses = happy_responses(payment_config={}, payment_subscription={'data': 'secret-intent'},
                                    payment_complete={'status': 'payment_confirmed'})
        responses['cart_get']['data']['prepaidPaymentMisc']['isCvvRequired'] = True
        flow, harness = make_flow(responses)
        flow.prepare_only()
        with patch('noon_cvv.encrypt', return_value={'encCvv': 'encrypted', 'publicKeyName': 'key'}), \
                patch('commerce_preorder.IntentVault.retain', return_value=j.digest('intent')):
            flow.prepare_payment(lambda: b'123')
            flow.prepare_payment(lambda: b'123')
        self.assertEqual(sum(op == 'payment_complete' for op, _ in harness.calls), 1)
        self.assertEqual(j.inspect(flow.flow_id)['reserved_minor'], 3145)
        retained = (j.ROOT / 'nownow' / (flow.flow_id + '.json')).read_text()
        self.assertNotIn('secret-intent', retained)
        self.assertNotIn('encrypted', retained)

    def test_device_verification_stops_before_financial_send(self):
        responses = happy_responses()
        responses['cart_get']['data']['isVerifyDeviceRequired'] = True
        flow, harness = make_flow(responses)
        flow.prepare_only()
        with self.assertRaisesRegex(j.JournalError, 'DEVICE_VERIFICATION'):
            flow.prepare_payment(lambda: b'123')
        self.assertFalse(any(op in ('place', 'payment_complete', 'payment_subscription') for op, _ in harness.calls))

    def test_changed_total_before_place_is_not_sent(self):
        flow, harness = make_flow(happy_responses())
        flow.prepare_only()
        harness.responses['cart_get']['data']['orderTotal'] = 50
        with self.assertRaises(j.JournalError):
            flow.place()
        self.assertNotIn('place', [op for op, _ in harness.calls])

    def test_contradictory_token_or_method_blocks_review(self):
        for key, value in [('paymentToken', 'another-token'), ('prepaidPaymentMisc', {'isCvvRequired': False, 'prepaidPaymentMethodCode': 'cash'})]:
            with self.subTest(key=key):
                responses = happy_responses()
                responses['cart_get']['data'][key] = value
                flow, harness = make_flow(responses)
                with self.assertRaisesRegex(j.JournalError, 'PAYMENT_READBACK'):
                    flow.prepare_only()
                self.assertNotIn('place', [op for op, _ in harness.calls])
                j.abandon(flow.flow_id)

    def test_mashreq_visa_selected_without_old_subscription(self):
        responses = happy_responses(payment_subscription_list={'data': []})
        responses['payment_cards']['data'][0].update(ccMasked='xxxx9546', ccType='VISA')
        for value in responses.values():
            row = value.get('data')
            if isinstance(row, dict) and row.get('creditCardMask'):
                row['creditCardMask'] = 'xxxx9546'
                row['hasPaymentSubscription'] = False
        with patch.object(c.order_card, 'LAST4', '9546'), patch.object(c.order_card, 'NETWORK', 'visa'):
            flow, _ = make_flow(responses)
            self.assertEqual(flow.prepare_only()['review']['card_last4'], '9546')

    def test_challenge_status_success_resumes_without_recompletion(self):
        responses = happy_responses(payment_config={}, payment_subscription={'data': 'secret-intent'},
                                    payment_complete={'status': 'payment_ready_to_redirect', 'redirect_url': 'https://bank.test'})
        responses['cart_get']['data']['prepaidPaymentMisc']['isCvvRequired'] = True
        flow, harness = make_flow(responses)
        flow.prepare_only()
        with patch('noon_cvv.encrypt', return_value={'encCvv': 'encrypted', 'publicKeyName': 'key'}), \
                patch('commerce_preorder.IntentVault.retain', return_value=j.digest('intent')):
            with self.assertRaises(j.PaymentError):
                flow.prepare_payment(lambda: b'123')
        self.assertEqual(j.inspect(flow.flow_id)['state'], 'FENCED')
        j.observe(flow.flow_id, 'payment_complete', outcome='PREORDER_PAYMENT_CONFIRMED', evidence_hash=j.digest('exact-status'))
        j.reconcile_nownow_preorder(flow.flow_id)
        flow = c.NowNowOrderFlow.resume_active(flow.flow_id, store_code=STORE,
            product_code=PRODUCT, quantity=1, auth=FakeAuth(), request=harness.request)
        flow.prepare_only()
        flow.prepare_payment(lambda: self.fail('must not reread CVV'))
        flow.place()
        self.assertEqual(sum(op == 'payment_complete' for op, _ in harness.calls), 1)
        self.assertEqual(sum(op == 'place' for op, _ in harness.calls), 1)
        for outcome in ('EXACT_ORDER_CONFIRMED', 'TRACKER_REGISTERED'):
            j.observe(flow.flow_id, 'place', outcome=outcome, evidence_hash=j.digest(outcome), order_id=flow.order)
        with self.assertRaisesRegex(j.JournalError, 'FULL_ORDER_CAPTURE_REQUIRED'):
            j.complete(flow.flow_id)
        j.observe(flow.flow_id, 'place', outcome='UNKNOWN', evidence_hash=j.digest('lost-place'), order_id=flow.order)
        harness.responses['cart_get']['data']['prepaidPaymentMisc']['isCvvRequired'] = False
        with patch('commerce_food_capture.find_bank_capture', return_value={'source_id': 123, 'source': 'msgs'}):
            capture.confirm(flow.flow_id, client=flow.client)
        self.assertEqual(j.inspect(flow.flow_id)['state'], 'ACTIVE')
        j.complete(flow.flow_id)
        with patch.object(capture, 'load', side_effect=AssertionError('must not require new retained file')):
            self.assertEqual(capture.recover(flow.flow_id)['state'], 'COMPLETE')

    def test_exact_capture_reconciles_ambiguous_place(self):
        flow, _ = make_flow(happy_responses())
        flow.prepare_only()
        flow.place()
        j.observe(flow.flow_id, 'place', outcome='UNKNOWN', evidence_hash=j.digest('lost-response'), order_id=flow.order)
        with patch('commerce_food_capture.find_bank_capture', return_value={'source_id': 123, 'source': 'msgs'}):
            capture.confirm(flow.flow_id, client=flow.client)
        self.assertEqual(j.inspect(flow.flow_id)['state'], 'ACTIVE')

    def test_tracking_failure_after_capture_still_registers(self):
        flow, _ = make_flow(happy_responses())
        flow.prepare_only()
        flow.place()
        def register(instance, *args, **kwargs):
            j.observe(instance.flow_id, 'place', outcome='TRACKER_REGISTERED',
                      evidence_hash=j.digest('tracker'), order_id=instance.order)
            return {'registered': True}
        with patch('commerce_nownow.reader', return_value=flow.client), \
                patch('commerce_food_capture.find_bank_capture', return_value={'source_id': 123, 'source': 'msgs'}), \
                patch.object(flow.client, 'tracking', side_effect=TimeoutError), \
                patch.object(c.NowNowOrderFlow, 'register_tracker', autospec=True, side_effect=register) as tracker:
            result = capture.recover(flow.flow_id)
        self.assertEqual(tracker.call_count, 1)
        self.assertTrue(result['tracking']['read_failed'])
        self.assertEqual(j.inspect(flow.flow_id)['state'], 'COMPLETE')
