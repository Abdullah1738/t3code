import copy
import json
import unittest
from unittest.mock import patch

import talabat_checkout as checkout
import talabat_place_contract as p
import talabat_submit_journal as journal
from test import test_talabat_quote as quote_tests


def draft_inputs():
    home, vendor, _ = quote_tests.fixture()
    config, card = quote_tests.card_fixture()
    evidence = quote_tests.QuoteProjectionTests().evidence()
    quote = evidence['response']
    quote['checkout']['deliveryInstructions']['instructions'] = [
        {'id':'synthetic-'+str(i), 'title':title, 'isSelected':selected, 'isEnabled':enabled}
        for i, (title, selected, enabled) in enumerate([
            ('Call on arrival', False, True), ("Don't ring doorbell", True, True),
            ('Leave at reception', False, False), ('Ring doorbell', False, False),
            ('Message on arrival', False, True), ('Leave at my door', True, True)])]
    quote['checkout']['riderTips'] = {'options':[{'value':2, 'isSelected':False}],
                                     'saveTip':{'isSelected':True}}
    return dict(home=home, vendor=vendor, config=config, saved_card=card,
                quote=quote, quote_body=p.q.selected_card_body(home, vendor, config, card),
                cart_id=evidence['cart_id'])


def response():
    return {'placedOrder':{'orderId':'1234567890', 'transactionId':'synthetic-private-txn'}}


class PlaceBodyTests(unittest.TestCase):
    def test_exact_wire_allowlist_not_prepare_body(self):
        body = p.place_body(**draft_inputs())
        self.assertEqual(set(body), {
            'countryCode', 'paymentMethod', 'addTPayMethod', 'binNumber',
            'allowDuplicateOrder', 'riderTipAmount', 'isCustomRiderTip',
            'saveRiderTipForLater', 'proSubscribeChecked', 'cardTokenId', 'proPlanId',
            'isMigrated', 'branchId', 'verticalId', 'priorityLevel', 'quickCheckout',
            'flow', 'selectedAddressId', 'addressV2', 'cardFingerPrint',
            'deliveryInstructions', 'saveDeliveryInstructionsForLater'})
        self.assertEqual(body['priorityLevel'], '')
        self.assertIsNone(body['flow'])
        for key in ('walletBalance', 'hasDues', 'deviceLatitude', 'deviceLongitude',
                    'paySupportsTPro', 'supportedFeatures', 'amount', 'parentOrderId',
                    'firstName', 'lastName', 'address', 'isCurbsidePickup', 'vehicle',
                    'riderNote', 'saveCard', 'cvv', *p.q.CARD_FEATURES):
            self.assertNotIn(key, body)

    def test_no_save_flags_are_false_even_if_quote_defaults_true(self):
        data = draft_inputs()
        body = json.loads(json.dumps(p.place_body(**data)))
        self.assertIs(body['saveDeliveryInstructionsForLater'], False)
        self.assertIs(body['saveRiderTipForLater'], False)
        self.assertTrue(data['quote']['checkout']['deliveryInstructions']['saveForLater']['isPreSaved'])
        self.assertTrue(data['quote']['checkout']['riderTips']['saveTip']['isSelected'])

    def test_no_extra_spend_and_no_duplicate_branch(self):
        body = p.place_body(**draft_inputs())
        for key in ('allowDuplicateOrder', 'proSubscribeChecked', 'quickCheckout'):
            self.assertIs(body[key], False)
        for key in ('riderTipAmount', 'isCustomRiderTip', 'proPlanId'):
            self.assertIsNone(body[key])

    def test_exact_tokenid_not_token_and_same_selected_event(self):
        data = draft_inputs(); body = p.place_body(**data)
        event = data['config']['paymentMethods'][0]['events']['payment']
        self.assertEqual(body['cardTokenId'], data['saved_card']['tokenId'])
        self.assertNotEqual(body['cardTokenId'], data['saved_card']['token'])
        self.assertEqual(body['cardTokenId'], event['card']['cardId'])
        self.assertEqual(body['binNumber'], event['card']['binNumber'])
        self.assertEqual(body['cardFingerPrint'], event['card']['cardFingerPrint'])
        self.assertEqual([body['paymentMethod'], body['addTPayMethod']], [2, 7])

    def test_wrong_card_identity_duplicate_disabled_and_expired_stop(self):
        for kind in ('token', 'wrong', 'duplicate', 'disabled', 'expired', 'cvv', 'other-method'):
            data = draft_inputs(); row = data['config']['paymentMethods'][0]
            if kind in ('token', 'wrong'):
                row['events']['payment']['card']['cardId'] = data['saved_card']['token'] if kind == 'token' else 'other'
            elif kind == 'duplicate': data['config']['paymentMethods'].append(copy.deepcopy(row))
            elif kind == 'disabled': row['isEnabled'] = False
            elif kind == 'expired': data['saved_card']['isExpired'] = True
            elif kind == 'cvv': data['saved_card']['isForceCvv'] = True
            else: row['events']['payment']['method']['addTPayMethod'] = 11
            with self.subTest(kind=kind), self.assertRaises(p.q.c.http.TalabatError):
                p.place_body(**data)

    def test_wallet_selected_event_blocks_even_zero(self):
        for selected in ({}, {'talabatPayConfig':{'balance':0}}):
            data = draft_inputs(); data['config']['paymentMethods'][0]['events']['selected'] = selected
            with self.assertRaises(p.q.c.http.TalabatError): p.place_body(**data)

    def test_force_cvv_unknown_requirements_block_without_alias_guessing(self):
        for requirement in ('ForceCVV', '3DS', '', False, {}, {'type':'ForceCVV'}):
            with self.subTest(requirement=requirement), self.assertRaises(p.q.c.http.TalabatError):
                p.place_body(**draft_inputs(), payment_requirement=requirement)
        p.require_no_payment_challenge(None)

    def test_instruction_ids_follow_native_order_not_labels(self):
        data = draft_inputs(); body = p.place_body(**data)
        self.assertEqual(body['deliveryInstructions'], ['synthetic-1', 'synthetic-5'])
        self.assertNotIn('Leave at my door', json.dumps(body))
        data['quote']['checkout']['deliveryInstructions']['instructions'].reverse()
        self.assertEqual(p.place_body(**data)['deliveryInstructions'], ['synthetic-5', 'synthetic-1'])

    def test_instructions_missing_changed_duplicate_unknown_or_disabled_stop(self):
        for kind in ('missing', 'door-off', 'call-on', 'bell-on', 'duplicate-id', 'duplicate-title', 'unknown', 'disabled'):
            data = draft_inputs(); rows = data['quote']['checkout']['deliveryInstructions']['instructions']
            if kind == 'missing': rows.pop(0)
            elif kind == 'door-off': rows[5]['isSelected'] = False
            elif kind == 'call-on': rows[0]['isSelected'] = True
            elif kind == 'bell-on': rows[3]['isSelected'] = True
            elif kind == 'duplicate-id': rows[5]['id'] = rows[1]['id']
            elif kind == 'duplicate-title': rows[4]['title'] = rows[0]['title']
            elif kind == 'unknown': rows[4]['title'] = 'private unknown instruction'
            else: rows[5]['isEnabled'] = False
            with self.subTest(kind=kind), self.assertRaises(p.q.c.http.TalabatError): p.place_body(**data)

    def test_address_unchanged_exact_native_country_alias(self):
        data = draft_inputs(); before = copy.deepcopy(data)
        body = p.place_body(**data)
        expected = {k:data['home'][k] for k in p.q.ADDRESS_KEYS}
        expected['country'] = '971'
        self.assertTrue(p.q._same_json(body['addressV2'], expected))
        self.assertEqual(data, before)
        body['addressV2']['extra_directions'] = 'mutated synthetic'
        body['deliveryInstructions'].append('mutated synthetic')
        self.assertEqual(data, before)

    def test_quote_cart_home_country_branch_manifest_binding(self):
        for kind in ('cart', 'lat', 'area', 'unit', 'country', 'currency', 'branch', 'item', 'qty', 'price'):
            data = draft_inputs(); quote = data['quote']; checkout = quote['checkout']
            if kind == 'cart': quote['tracking']['cartId'] = 'wrong'
            elif kind == 'lat': checkout['address']['latitude'] += 0.01
            elif kind == 'area': checkout['address']['areaId'] = 99
            elif kind == 'unit': checkout['address']['description'] = 'Unit 12104'
            elif kind == 'country': quote['branchInfo']['country']['id'] = 1
            elif kind == 'currency': quote['branchInfo']['country']['currencyCode'] = 'USD'
            elif kind == 'branch': checkout['branchId'] = 1
            elif kind == 'item': checkout['cart']['items'][0]['itemGuid'] = 'wrong'
            elif kind == 'qty': checkout['cart']['items'][0]['quantity'] = 2
            else: checkout['cart']['items'][0]['price'] = '-20.25'
            with self.subTest(kind=kind), self.assertRaises(p.q.c.http.TalabatError): p.place_body(**data)

    def test_quote_type_coercion_never_counts_as_exact_binding(self):
        for kind in ('branch', 'country', 'area', 'qty'):
            data = draft_inputs(); quote = data['quote']; checkout = quote['checkout']
            if kind == 'branch': checkout['branchId'] = float(checkout['branchId'])
            elif kind == 'country': quote['branchInfo']['country']['id'] = 4.0
            elif kind == 'area': checkout['address']['areaId'] = float(checkout['address']['areaId'])
            else: checkout['cart']['items'][0]['quantity'] = True
            with self.subTest(kind=kind), self.assertRaises(p.q.c.http.TalabatError): p.place_body(**data)

    def test_prepare_request_must_be_bound_not_reconstructed_as_evidence(self):
        for key, value in (('paymentMethod', None), ('addTPayMethod', 7.0),
                           ('binNumber', '654321'), ('cardFingerPrint', 'different-private'),
                           ('selectedAddressId', 'different-private'), ('walletBalance', 0)):
            data = draft_inputs(); data['quote_body'][key] = value
            with self.subTest(key=key), self.assertRaisesRegex(p.q.c.http.TalabatError, 'PREPARE_BINDING'):
                p.place_body(**data)

    def test_quote_malformed_extra_charge_must_not_be_silently_ignored(self):
        for extra in (None, '', [], 0):
            data = draft_inputs(); data['quote']['checkout']['paymentSummary']['items'].append(extra)
            with self.subTest(extra=extra), self.assertRaisesRegex(p.q.c.http.TalabatError, 'CHARGES_SCHEMA'):
                p.place_body(**data)

    def test_empty_identifier_text_not_accepted_in_draft(self):
        for kind in ('home', 'fingerprint', 'instruction'):
            data = draft_inputs()
            if kind == 'home': data['home']['id'] = ' '
            elif kind == 'fingerprint':
                data['config']['paymentMethods'][0]['events']['payment']['card']['cardFingerPrint'] = ' '
            else: data['quote']['checkout']['deliveryInstructions']['instructions'][1]['id'] = ' '
            data['quote_body'] = p.q.selected_card_body(data['home'], data['vendor'], data['config'], data['saved_card'])
            with self.subTest(kind=kind), self.assertRaises(p.q.c.http.TalabatError): p.place_body(**data)

    def test_quote_tip_subscription_or_unrecognized_charges_block(self):
        for kind in ('tip', 'pro', 'unknown-charge', 'charge-bool', 'over-budget'):
            data = draft_inputs(); checkout = data['quote']['checkout']
            if kind == 'tip': checkout['riderTips']['options'][0]['isSelected'] = True
            elif kind == 'pro': checkout['subscription'] = {}
            elif kind == 'unknown-charge': checkout['paymentSummary']['items'].append({'type':'Dues', 'amount':'0.00'})
            elif kind == 'charge-bool': checkout['paymentSummary']['items'][0]['amount'] = True
            else:
                checkout['amount'] = '60.25'
                checkout['paymentSummary']['items'][1]['amount'] = '39.10'
                checkout['paymentSummary']['items'][3]['amount'] = '60.25'
            with self.subTest(kind=kind), self.assertRaises(p.q.c.http.TalabatError): p.place_body(**data)

    def test_malformed_quote_yields_fixed_diagnostic(self):
        for key in ('address', 'paymentSummary', 'deliveryInstructions', 'cart'):
            data = draft_inputs(); data['quote']['checkout'][key] = 'synthetic-private-value'
            with self.subTest(key=key), self.assertRaises(p.q.c.http.TalabatError) as caught:
                p.place_body(**data)
            self.assertNotIn('synthetic-private-value', str(caught.exception))

    def test_pure_builder_never_calls_io_or_journal(self):
        with patch.object(p.q.c.http, 'account', side_effect=AssertionError('auth')), \
                patch.object(p.q, '_json_request', side_effect=AssertionError('network')), \
                patch.object(journal, 'consume', side_effect=AssertionError('journal')):
            p.place_body(**draft_inputs())

    def test_existing_and_new_submission_gates_always_disabled(self):
        with patch.object(p.q.c.http, 'account') as auth, patch.object(journal, 'consume') as consume:
            with self.assertRaisesRegex(p.q.c.http.TalabatError, 'SUBMIT_DISABLED'):
                p.require_submission_enabled()
            with self.assertRaises(p.q.c.http.TalabatError): checkout.commit()
            auth.assert_not_called(); consume.assert_not_called()


class ResponseTests(unittest.TestCase):
    def assert_stopped(self, observation, state):
        safe = p.project_response(observation)
        self.assertEqual(safe['state'], state)
        for key in ('retry_allowed', 'payment_completion_verified', 'merchant_acceptance_verified',
                    'exact_order_readback_verified', 'ready_to_order', 'commit_enabled'):
            self.assertIs(safe[key], False)
        self.assertIs(safe['submission_may_have_occurred'], True)
        return safe

    def test_http_200_is_pending_even_with_empty_redirect_and_zero_balance(self):
        value = p.parse_response(200, response())
        self.assert_stopped(value, 'PAYMENT_PENDING')
        self.assertEqual(value.order_id, '1234567890')
        self.assertEqual(value.transaction_id, 'synthetic-private-txn')
        self.assertEqual(value.balance_amount, '0.0')
        self.assertEqual(value.redirect_url, '')

    def test_null_optional_defaults_match_native(self):
        body = response(); body['placedOrder'].update(balanceAmount=None, redirectUrl=None)
        body.update(tracking=None, trackingInfo=None)
        value = p.parse_response(200, body)
        self.assert_stopped(value, 'PAYMENT_PENDING')
        self.assertEqual((value.balance_amount, value.redirect_url), ('0.0', ''))

    def test_server_paid_or_accepted_claim_does_not_override_native_pending(self):
        body = response(); body['placedOrder'].update(paid=True, accepted=True, paymentPending=False)
        body.update(paid=True, accepted=True)
        self.assert_stopped(p.parse_response(200, body), 'PAYMENT_PENDING')

    def test_balance_string_is_opaque_not_charged_or_wallet_amount(self):
        body = response(); body['placedOrder']['balanceAmount'] = 'synthetic-private-opaque-value'
        value = p.parse_response(200, body)
        safe = self.assert_stopped(value, 'PAYMENT_PENDING')
        self.assertNotIn('synthetic-private-opaque-value', json.dumps(safe))

    def test_nonempty_redirect_stops_and_never_follows_url(self):
        for url in ('https://private.invalid/challenge?token=private', 'javascript:private', ' '):
            body = response(); body['placedOrder']['redirectUrl'] = url
            safe = self.assert_stopped(p.parse_response(200, body), 'CHALLENGE_REQUIRED')
            self.assertTrue(safe['redirect_present'])
            self.assertNotIn(url, json.dumps(safe, separators=(',', ':')))

    def test_missing_dropped_and_malformed_response_unknown(self):
        for body in (None, '', [], {}, {'placedOrder':None}, {'placedOrder':[]}):
            self.assert_stopped(p.parse_response(None, body), 'SUBMISSION_UNKNOWN')

    def test_only_exact_http_200_supported_and_no_status_authorizes_retry(self):
        for status in (None, 0, 201, 202, 204, 301, 302, 400, 401, 403, 409, 429, 500, True, 200.0, '200'):
            safe = self.assert_stopped(p.parse_response(status, response()), 'SUBMISSION_UNKNOWN')
            self.assertTrue(safe['order_id_received'])

    def test_order_id_strict_numeric_tracking_contract(self):
        for order in (None, '', 123, True, 'abc', '1/2', '1\n', '1'*21, '１２３'):
            body = response(); body['placedOrder']['orderId'] = order
            safe = self.assert_stopped(p.parse_response(200, body), 'SUBMISSION_UNKNOWN')
            self.assertFalse(safe['order_id_received'])

    def test_transaction_required_string_and_order_retained_on_bad_continuation(self):
        for txn in (None, '', 123, True, ' ', '\n', 'x'*513):
            body = response(); body['placedOrder']['transactionId'] = txn
            value = p.parse_response(200, body)
            safe = self.assert_stopped(value, 'SUBMISSION_UNKNOWN')
            self.assertTrue(safe['order_id_received'])
            self.assertEqual(value.order_id, '1234567890')

    def test_native_string_optional_types_and_telemetry_containers(self):
        for key, bad in (('balanceAmount', 0.0), ('balanceAmount', 0), ('redirectUrl', False),
                         ('redirectUrl', {}), ('trackingInfo', []), ('tracking', 'private')):
            body = response()
            (body if key.startswith('tracking') else body['placedOrder'])[key] = bad
            safe = self.assert_stopped(p.parse_response(200, body), 'SUBMISSION_UNKNOWN')
            self.assertTrue(safe['order_id_received'])

    def test_sms_requirement_on_200_and_400_stops_even_malformed(self):
        for status in (200, 400):
            for sms in ({}, False, 'private', {'mobileNumber':'private', 'mobileNumberCountryCode':'private'}):
                body = response(); body['smsVerificationError'] = sms
                value = p.parse_response(status, body)
                self.assert_stopped(value, 'CHALLENGE_REQUIRED')
                self.assertEqual(value.reason, 'MOBILE_VERIFICATION_REQUIRED')

    def test_mobile_generic_code_or_exact_message_blocks(self):
        for generic in ({'errorCode':107}, {'errorMessage':'Mobile Number cant be empty'}):
            body = response(); body['genericError'] = generic
            self.assert_stopped(p.parse_response(200, body), 'CHALLENGE_REQUIRED')

    def test_duplicate_error_never_confirms_or_retries(self):
        body = {'duplicateOrderError':{'description':'private',
                'actions':[{'name':'Retry', 'actionType':'private-action'}]}}
        safe = self.assert_stopped(p.parse_response(400, body), 'SUBMISSION_UNKNOWN')
        self.assertEqual(safe['reason'], 'DUPLICATE_ORDER_ERROR_NO_RETRY')
        self.assertFalse(safe['order_id_received'])

    def test_generic_and_conflicting_success_error_fail_closed(self):
        for status in (200, 400):
            for generic in ({}, False, {'errorCode':'107'}, {'errorMessage':'declined private'}):
                body = response(); body['genericError'] = generic
                self.assert_stopped(p.parse_response(status, body), 'SUBMISSION_UNKNOWN')

    def test_private_fields_telemetry_and_error_actions_never_projected_or_repr(self):
        body = response(); body['placedOrder'].update(balanceAmount='private-balance',
                                                      redirectUrl='https://private.invalid')
        body.update(trackingInfo={'private-account':'private-address'}, tracking={'private':'private-token'})
        value = p.parse_response(200, body)
        text = json.dumps(p.project_response(value)) + repr(value)
        for private in ('1234567890', 'synthetic-private-txn', 'private-balance', 'private.invalid',
                        'private-account', 'private-address', 'private-token'):
            self.assertNotIn(private, text)

    def test_projection_rejects_arbitrary_state_or_reason(self):
        for state, reason in (('PAID', 'PAYMENT_COMPLETION_UNPROVEN'),
                              ('PAYMENT_PENDING', 'private-message'),
                              ('SUBMISSION_UNKNOWN', 'PAYMENT_COMPLETION_UNPROVEN')):
            with self.assertRaises(p.q.c.http.TalabatError):
                p.project_response(p.PlaceObservation(state, reason))

    def test_no_io_in_parser_projector_or_challenge(self):
        with patch.object(p.q.c.http, 'account', side_effect=AssertionError('auth')), \
                patch.object(p.q, '_json_request', side_effect=AssertionError('network')), \
                patch.object(journal, 'consume', side_effect=AssertionError('journal')):
            self.assert_stopped(p.parse_response(200, response()), 'PAYMENT_PENDING')


if __name__ == '__main__': unittest.main()
