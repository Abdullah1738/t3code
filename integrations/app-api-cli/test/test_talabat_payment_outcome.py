import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import talabat_payment_outcome as p
import talabat_fresh_review as review
from test import test_talabat_fresh_review as review_fixtures
from test import test_talabat_place_contract as fixtures


def tracking(order='1234567890', status='order_delivered'):
    return {'type':'OrderTrackingScreen', 'common_tracking_event_attributes':{
        'order_id':order, 'delivery_status':status}}


def placed(order='1234567890'):
    return p.place.parse_response(200,{'placedOrder':{'orderId':order,'transactionId':'synthetic-private-transaction'}})


class PaymentOutcomeTests(unittest.TestCase):
    def assert_blocked(self, result):
        for key in ('retry_allowed','payment_completion_verified','charged_card_verified',
                    'charged_amount_verified','settlement_verified','merchant_acceptance_verified',
                    'ready_to_order','commit_enabled'):
            self.assertIs(result[key],False)

    def test_exact_success_only_unbound_native_signal_not_paid(self):
        result=p.project_payment_status(200,{'status':'success'})
        self.assertEqual(result['state'],'UNBOUND_PAYMENT_SUCCESS')
        self.assertFalse(result['request_response_binding_verified'])
        self.assert_blocked(result)

    def test_null_missing_and_pending_never_completion(self):
        for body in ({},{'status':None},{'status':'pending'}):
            result=p.project_payment_status(200,body)
            self.assertEqual(result['state'],'PAYMENT_PENDING')
            self.assert_blocked(result)

    def test_error_never_no_charge_or_safe_retry(self):
        for body in ({'status':'error'},{'status':'success','error':{}},
                     {'error':{'type':'declined','title':'private','subtitle':'private'}}):
            result=p.project_payment_status(200,body)
            self.assertEqual(result['state'],'PAYMENT_ERROR_REPORTED')
            self.assertFalse(result['no_charge_verified'])
            self.assertFalse(result['rollback_verified'])
            self.assert_blocked(result)

    def test_redirect_even_success_and_missing_url_stops(self):
        for body in ({'status':'redirection'}, {'status':'success','redirectUrl':'https://private.invalid'},
                     {'redirectUrl':' '},{'redirectUrl':'javascript:private'}):
            result=p.project_payment_status(200,body)
            self.assertEqual(result['state'],'CHALLENGE_REQUIRED')
            self.assert_blocked(result)

    def test_fallback_never_switches_payment_method(self):
        for fallback in ({},{'paymentMethod':{'id':'cash'}},{'paymentMethod':{'last4':'1111'}}):
            result=p.project_payment_status(200,{'status':'success','fallback':fallback})
            self.assertEqual(result['reason'],'ALTERNATE_PAYMENT_UNSUPPORTED')
            self.assert_blocked(result)

    def test_hyperpay_continuation_stops(self):
        result=p.project_payment_status(200,{'status':'success','hyperPayCheckoutId':'private-checkout'})
        self.assertEqual(result['state'],'PAYMENT_BLOCKED')
        self.assert_blocked(result)

    def test_present_empty_continuation_fields_do_not_bypass_stop(self):
        for key,state in (('redirectUrl','CHALLENGE_REQUIRED'),('hyperPayCheckoutId','PAYMENT_BLOCKED')):
            with self.subTest(key=key):
                result=p.project_payment_status(200,{'status':'success',key:''})
                self.assertEqual(result['state'],state)
                self.assert_blocked(result)

    def test_schema_types_strict(self):
        for key in ('status','redirectUrl','hyperPayCheckoutId','error','fallback'):
            for value in (True,42,[],0.0):
                result=p.project_payment_status(200,{key:value})
                self.assertEqual(result['state'],'PAYMENT_UNKNOWN')
                self.assert_blocked(result)

    def test_http_errors_and_lost_response_unknown(self):
        for status in (None,True,'200',200.0,201,202,400,401,403,404,409,429,500):
            result=p.project_payment_status(status,{'status':'success'})
            self.assertEqual(result['state'],'PAYMENT_UNKNOWN')
            self.assert_blocked(result)
        for body in (None,[],True,'private'):
            self.assertEqual(p.project_payment_status(200,body)['state'],'PAYMENT_UNKNOWN')

    def test_no_normalization_or_invented_failure_cancel_alias(self):
        for status in ('SUCCESS',' success ','Success','failed','cancelled','aborted','dioError','paymentCanceled'):
            result=p.project_payment_status(200,{'status':status})
            self.assertEqual(result['state'],'PAYMENT_UNKNOWN')
            self.assert_blocked(result)

    def test_v1_empty_response_not_success(self):
        self.assertEqual(p.project_payment_status(200,{'error':None,'fallback':None})['state'],'PAYMENT_PENDING')

    def test_telemetry_success_and_financial_fields_never_promoted(self):
        result=p.project_payment_status(200,{'status':'success','totalAmount':30.14,
            'transactionId':'private-transaction','orderId':'private-order','currency':'AED',
            'card':'5542','settled':True,'captured':True,'merchantAccepted':True})
        self.assert_blocked(result)
        self.assertFalse(result['request_response_binding_verified'])

    def test_input_immutable_projection_contains_no_raw_values(self):
        body={'status':'success','redirectUrl':'private-url','hyperPayCheckoutId':'private-id',
              'error':{'messages':['private-error']},'fallback':{'paymentMethod':'private-method'}}
        before=copy.deepcopy(body);result=p.project_payment_status(200,body)
        self.assertEqual(body,before)
        text=json.dumps(result)
        for value in ('private-url','private-id','private-error','private-method'):
            self.assertNotIn(value,text)

    def test_received_order_identity_and_progress_are_separate_from_payment(self):
        for raw,stage in (('order_almostready','preparing'),('order_delivering','out for delivery'),
                          ('order_delivered','delivered')):
            result=p.project_order_readback(placed(),tracking(status=raw))
            self.assertTrue(result['order_identity_matches'])
            self.assertTrue(result['fulfilment_progress_reported'])
            self.assertEqual(result['fulfilment_stage'],stage)
            self.assertFalse(result['fresh_server_provenance_verified'])
            self.assertFalse(result['exact_order_readback_verified'])
            self.assert_blocked(result)

    def test_integer_tracking_identity_supported_but_no_coercions(self):
        self.assertTrue(p.project_order_readback(placed(),tracking(1234567890))['order_identity_matches'])
        for order in (True,1234567890.0,None,[],{},'1234567890 ','01234567890','12345678900','private'):
            result=p.project_order_readback(placed(),tracking(order))
            self.assertFalse(result['order_identity_matches'])
            self.assert_blocked(result)

    def test_extreme_tracking_integer_fails_without_string_conversion(self):
        for value in (-1,10**20,10**5000):
            result=p.project_order_readback(placed(),tracking(value))
            self.assertFalse(result['order_identity_matches'])
            self.assertEqual(result['reason'],'ORDER_IDENTITY_MISMATCH')

    def test_no_lost_response_recovery_from_history_or_plausible_order(self):
        missing=p.place.parse_response(None,None)
        result=p.project_order_readback(missing,tracking())
        self.assertFalse(result['order_id_received'])
        self.assertFalse(result['order_identity_matches'])
        self.assertEqual(result['reason'],'NO_RECEIVED_ORDER_ID_FOR_EXACT_READBACK')
        self.assert_blocked(result)

    def test_valid_id_retained_on_place_parser_error_can_be_compared(self):
        observation=p.place.parse_response(200,{'placedOrder':{'orderId':'1234567890','transactionId':False}})
        result=p.project_order_readback(observation,tracking())
        self.assertTrue(result['order_identity_matches'])
        self.assert_blocked(result)

    def test_unknown_fulfilment_not_acceptance(self):
        for raw in ('order_pending','order_accepted','order_cancelled','payment_success','unknown'):
            result=p.project_order_readback(placed(),tracking(status=raw))
            self.assertTrue(result['order_identity_matches'])
            self.assertFalse(result['fulfilment_progress_reported'])
            self.assertEqual(result['fulfilment_stage'],'unknown')
            self.assert_blocked(result)

    def test_malformed_tracking_and_status_safe(self):
        for body in (None,[],{}, {'type':'Other'}, {'type':'OrderTrackingScreen',
                      'common_tracking_event_attributes':'private'}):
            result=p.project_order_readback(placed(),body)
            self.assertFalse(result['order_identity_matches'])
            self.assert_blocked(result)
        for value in (True,None,1,[], 'private value','order-delivered'):
            result=p.project_order_readback(placed(),tracking(status=value))
            self.assertFalse(result['fulfilment_progress_reported'])
            self.assert_blocked(result)

    def test_tracking_projection_never_emits_private_id_or_metadata(self):
        raw=tracking();raw['rider']='private rider';raw['amount']=30.14
        result=p.project_order_readback(placed(),raw)
        text=json.dumps(result)
        for private in ('1234567890','private rider','synthetic-private-transaction','30.14'):
            self.assertNotIn(private,text)

    def test_no_auth_network_challenge_or_journal_side_effects(self):
        with patch.object(p.place.q.c.http,'account',side_effect=AssertionError('auth')), \
                patch.object(p.place.q,'_json_request',side_effect=AssertionError('network')):
            p.project_payment_status(200,{'status':'redirection','redirectUrl':'https://private.invalid'})
            p.project_order_readback(placed(),tracking())
            with self.assertRaises(p.place.q.c.http.TalabatError):p.require_payment_enabled()

    def test_complete_synthetic_review_to_outcomes_never_enables_or_retries(self):
        original=review_fixtures.freeze()
        acknowledgement=review_fixtures.acknowledgement(original)
        current=review_fixtures.freeze(wall=1010,mono=2010)
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(review.journal,'ROOT',Path(directory)/'journal'), \
                patch.object(review.journal.time,'time',return_value=1015):
            approval=review.check_approval_binding(original,current,acknowledgement,
                                                  now=1015,now_monotonic=2015)
            self.assertFalse(approval['commit_enabled'])
            operation=review.journal.consume(json.loads(original._review),original.digest)
            observation=placed()
            pending=p.place.project_response(observation)
            review.journal.record_observation(operation['operation'],pending['state'],
                                              review._hash('synthetic-pending',pending))
            success=p.project_payment_status(200,{'status':'success'})
            delivered=p.project_order_readback(observation,tracking())
            self.assertEqual(success['state'],'UNBOUND_PAYMENT_SUCCESS')
            self.assertEqual(delivered['fulfilment_stage'],'delivered')
            for result in (success,delivered):self.assert_blocked(result)
            with self.assertRaisesRegex(p.place.q.c.http.TalabatError,'ALREADY_FENCED'):
                review.journal.consume(json.loads(current._review),current.digest)


if __name__=='__main__':unittest.main()
