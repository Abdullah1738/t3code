"""Contract tests against the live-captured minutes payment chain (paid order
IAEGAA148ODSUNJWBA, AED 17.25). Fixture is hygiene-redacted: field paths and
non-sensitive values are real, secret values are '<secret>' placeholders.
Never loads account storage; no network."""
import base64
import json
from pathlib import Path
import unittest

import noon_minutes_checkout as m
import noon_cvv

FIXTURE = json.loads((Path(__file__).parent / 'fixture_minutes_payment_chain.json').read_text())
ORDER = FIXTURE['captured_order']
TOTAL_MINOR = 1725


class CapturedContractTests(unittest.TestCase):
    def test_place_request_body_is_exact_total(self):
        self.assertEqual(FIXTURE['place']['req'], {'total': 17.25})
        self.assertEqual(m.wire_amount(TOTAL_MINOR), 17.25)

    def test_place_response_contract(self):
        resp = FIXTURE['place']['resp']
        self.assertEqual(resp['order_nr'], ORDER)
        self.assertIs(resp['success'], True)
        self.assertEqual(resp['error_modal'], {})
        projection = m.project_place(resp)
        self.assertTrue(projection['accepted'])
        self.assertEqual(projection['order'], ORDER)
        self.assertEqual(projection['state'], 'order_created_payment_unconfirmed')

    def test_order_get_request_and_top_level_client_secret(self):
        # clientSecret lives in the TOP-LEVEL paymentIntentToken field, never nested.
        for body in (FIXTURE['order_get_pending'], FIXTURE['order_get_after_payment']):
            self.assertIn('paymentIntentToken', body)
            self.assertNotIn('paymentIntent', body)
        pending = FIXTURE['order_get_pending']
        self.assertEqual(pending['orderNr'], ORDER)
        self.assertEqual(pending['statusCode'], 'pending')
        self.assertEqual(m.amount_minor(pending['orderTotal']), TOTAL_MINOR)
        self.assertEqual(m.amount_minor(pending['orderPaymentAmount']), TOTAL_MINOR)
        projection = m.project_order_get(pending, ORDER)
        self.assertEqual(projection['raw_status'], 'pending')
        self.assertTrue(projection['payment_intent_present'])
        self.assertTrue(projection['identity_echoed'])
        self.assertEqual(projection['state'], 'payment_action_required')
        self.assertEqual(m.project_order_get(FIXTURE['order_get_after_payment'], ORDER)['state'],
                         'confirmed')

    def test_order_get_fee_and_card_field_paths(self):
        for body in (FIXTURE['order_get_pending'], FIXTURE['order_get_after_payment']):
            for key in ('orderSubtotal', 'orderDeliveryFee', 'orderSmallOrderFee', 'orderTotal',
                        'orderPaymentAmount', 'currencyCode', 'initialOrderDetails',
                        'paymentMethodCode', 'creditCardMask', 'creditCardBin', 'creditCardType'):
                self.assertIn(key, body, key)
        pending = FIXTURE['order_get_pending']
        self.assertEqual(pending['currencyCode'], 'AED')
        self.assertEqual(pending['paymentMethodCode'], 'cc_noonpay')
        self.assertEqual(pending['creditCardBin'], '522873')
        self.assertTrue(pending['creditCardMask'].endswith('5542'))
        self.assertEqual(pending['creditCardType'], 'MASTERCARD')
        # Fee arithmetic from the captured paid order: subtotal + delivery + small order.
        self.assertEqual(m.amount_minor(pending['orderSubtotal'])
                         + m.amount_minor(pending['orderDeliveryFee'])
                         + m.amount_minor(pending['orderSmallOrderFee']), TOTAL_MINOR)

    def test_complete_request_exact_shape(self):
        req = FIXTURE['complete']['req']
        self.assertEqual(set(req), {'clientSecret', 'paymentMethodCode', 'idCustomerToken',
                                    'cvvEncryption', 'paymentProviderCode', 'installments',
                                    'paymentType', 'adcbTokenCode', 'idEmiPlan', 'tenorMonth',
                                    'applePayToken', 'googlePayToken'})
        self.assertEqual(req['paymentMethodCode'], 'cc_noonpay')
        self.assertEqual(req['paymentProviderCode'], 'NOON_PAY')
        self.assertEqual(set(req['cvvEncryption']), {'encCvv', 'publicKeyName'})
        self.assertEqual(req['cvvEncryption']['publicKeyName'], 'key_1')
        for key in ('installments', 'paymentType', 'adcbTokenCode', 'idEmiPlan', 'tenorMonth',
                    'applePayToken', 'googlePayToken'):
            self.assertIsNone(req[key])

    def test_wire_complete_reproduces_captured_body(self):
        from test.test_noon_minutes_checkout import Harness
        h = Harness([{'status': 'payment_pending'}])
        card = m.SavedCard(FIXTURE['complete']['req']['idCustomerToken'],
                          '522873xxxxxx5542', 'mastercard')
        h.client.complete_payment(order=ORDER, client_secret='<secret>', card=card,
            provider_code='NOON_PAY',
            cvv_encryption={'encCvv': '<secret>', 'publicKeyName': 'key_1'},
            optional_fields={'installments': None, 'paymentType': None, 'adcbTokenCode': None,
                             'idEmiPlan': None, 'tenorMonth': None, 'applePayToken': None,
                             'googlePayToken': None},
            before_send=h.reserve)
        self.assertEqual(h.calls[0], ('payment_complete', FIXTURE['complete']['req']))

    def test_complete_response_contract(self):
        resp = FIXTURE['complete']['resp']
        self.assertEqual(resp['status'], 'payment_pending')
        self.assertEqual(resp['transaction_status'], 'CREATED')
        self.assertEqual(m.amount_minor(resp['authorized_amount']), 0)
        self.assertEqual(resp['reference'], ORDER)
        self.assertEqual(resp['cc_masked'], '522873xxxxxx5542')
        self.assertEqual(resp['cc_type'], 'MASTERCARD')
        self.assertFalse(resp['is_3ds_failure'])

    def test_status_request_body(self):
        # Captured status calls post only the clientSecret.
        from test.test_noon_minutes_checkout import Harness
        h = Harness([{'status': 'payment_confirmed', 'transaction_status': 'CAPTURED',
                      'authorized_amount': 17.25, 'captured_amount': 17.25, 'error_code': '0'}])
        h.client.payment_status(order=ORDER, client_secret='<secret>')
        self.assertEqual(h.calls[0], ('payment_status', {'clientSecret': '<secret>'}))

    def test_captured_status_transition_sequence(self):
        pending = FIXTURE['status_pending_created']
        enroll = FIXTURE['status_3ds_enroll']
        confirmed = FIXTURE['status_confirmed']
        self.assertEqual((pending['status'], pending['transaction_status']),
                         ('payment_pending', 'CREATED'))
        self.assertEqual(m.amount_minor(pending['authorized_amount']), 0)
        self.assertEqual((enroll['status'], enroll['transaction_status']),
                         ('payment_ready_to_redirect', '3DS_ENROLL_INITIATED'))
        self.assertEqual(enroll['error_code'], '0')
        self.assertEqual(confirmed['status'], 'payment_confirmed')
        self.assertEqual(confirmed['transaction_status'], 'CAPTURED')
        self.assertEqual(m.amount_minor(confirmed['authorized_amount']), TOTAL_MINOR)
        self.assertEqual(m.amount_minor(confirmed['captured_amount']), TOTAL_MINOR)
        self.assertEqual(confirmed['error_code'], '0')

    def test_paid_signal_requires_the_exact_terminal_triple(self):
        confirmed = FIXTURE['status_confirmed']
        self.assertTrue(m.project_payment_status(confirmed, ORDER, TOTAL_MINOR)['paid'])
        for wrong in (FIXTURE['status_pending_created'], FIXTURE['status_3ds_enroll']):
            self.assertFalse(m.project_payment_status(wrong, ORDER, TOTAL_MINOR)['paid'])
        # Wrong expected amount never certifies paid.
        self.assertFalse(m.project_payment_status(confirmed, ORDER, 1726)['paid'])
        for field, value in (('transaction_status', 'AUTHORIZED'), ('error_code', '1')):
            mutated = dict(confirmed)
            mutated[field] = value
            self.assertFalse(m.project_payment_status(mutated, ORDER, TOTAL_MINOR)['paid'], field)
        # The captured paid signal is exactly the confirmed/CAPTURED/equal-amounts
        # triple; is_3ds_failure is not part of it (a capture IS the money fact).
        self.assertTrue(m.project_payment_status(dict(confirmed, is_3ds_failure=True),
                                                 ORDER, TOTAL_MINOR)['paid'])
        with self.assertRaises(m.MinutesError):
            m.project_payment_status(dict(confirmed, reference='IAEGAAOTHER'), ORDER, TOTAL_MINOR)

    def test_payment_intent_status_projection_fields(self):
        projection = m.project_payment_status(FIXTURE['status_confirmed'], ORDER, TOTAL_MINOR)
        self.assertEqual(projection['order'], ORDER)
        self.assertEqual(projection['payment_status'], 'payment_confirmed')
        self.assertEqual(projection['transaction_status'], 'CAPTURED')
        self.assertEqual(projection['authorized_minor'], TOTAL_MINOR)
        self.assertEqual(projection['captured_minor'], TOTAL_MINOR)
        self.assertEqual(projection['error_code'], '0')
        self.assertIs(projection['paid'], True)
        self.assertEqual(projection['state'], 'paid')
        self.assertFalse(projection['redirect_required'])
        pending = m.project_payment_status(FIXTURE['status_pending_created'], ORDER, TOTAL_MINOR)
        self.assertEqual(pending['state'], 'payment_in_progress')

    def test_get_active_contract(self):
        body = FIXTURE['get_active']
        self.assertEqual(body['req'], {})
        self.assertEqual(body['resp'], {'activeOrders': []})
        self.assertEqual(m.project_active(body['resp']), {'active': [], 'count': 0,
                                                           'resend_allowed': False})

    def test_project_active_surfaces_unpaid_orders(self):
        row = {'orderNr': 'IAEGAUNPAID1', 'statusCode': 'pending'}
        active = m.project_active({'activeOrders': [row]})
        self.assertEqual(active['count'], 1)
        self.assertEqual(active['active'][0]['order'], 'IAEGAUNPAID1')
        self.assertEqual(active['active'][0]['raw_status'], 'pending')
        with self.assertRaises(m.MinutesError):
            m.project_active({'activeOrders': [{'statusCode': 'pending'}]})

    def test_config_contract_and_real_cvv_encryption(self):
        config = FIXTURE['config']
        self.assertEqual(config['cvv_encryption']['public_key_name'], 'key_1')
        self.assertIn('BEGIN PUBLIC KEY', config['cvv_encryption']['public_key'])
        self.assertIn('cc_noonpay', config['available_payment_methods'])
        self.assertIs(config['new_algorithm'], True)
        # Round-trip against the real captured public key: RSA-2048 OAEP-SHA256
        # ciphertext is 256 bytes -> 344 base64 chars.
        encrypted = noon_cvv.encrypt(config, b'123')
        self.assertEqual(encrypted['publicKeyName'], 'key_1')
        decoded = base64.b64decode(encrypted['encCvv'], validate=True)
        self.assertEqual(len(decoded), 256)

    def test_config_payment_config_readback(self):
        from test.test_noon_minutes_checkout import Harness
        h = Harness([FIXTURE['config']])
        snap = h.client.payment_config()
        self.assertTrue(snap.projection['payment_config_received'])
        # The private wire (RAM only) still carries the public key for noon_cvv.
        self.assertEqual(snap.wire['cvv_encryption']['public_key_name'], 'key_1')


    def test_minutes_stage_map_covers_observed_live_stages(self):
        import noon_http_orders as native
        # Live E2E observation 2026-10-10: a just-paid minutes order reports
        # status ready_for_pickup ("Packing your order") before rider pickup.
        self.assertEqual(native.MINUTES_STAGES['ready_for_pickup'],'preparing')
        self.assertEqual(native.MINUTES_STAGES['confirmed'],'placed')
        self.assertEqual(native.MINUTES_STAGES['picked_up'],'out for delivery')
        self.assertEqual(native.MINUTES_STAGES['arrived_at_delivery'],'nearby')
        self.assertEqual(native.MINUTES_STAGES['delivered'],'delivered')


if __name__ == '__main__':
    unittest.main()