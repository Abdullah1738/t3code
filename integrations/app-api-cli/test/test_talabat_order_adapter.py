import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import talabat_order_adapter as adapter
from test import test_talabat_fresh_review as fixtures
from test import test_talabat_payment_route as route_fixtures


def snapshot():
    data = fixtures.snapshot()
    data['payment_config'] = route_fixtures.inputs()['config']
    return data


def freeze(data=None, wall=1000):
    return adapter.prepare_review(snapshot() if data is None else data,
                                  observed_at=wall, now=wall+5,
                                  started_monotonic=wall+1000, now_monotonic=wall+1005)


def run_rehearsal(original=None, data=None, **responses):
    original = freeze() if original is None else original
    ack = fixtures.acknowledgement(original)
    return adapter.rehearse(original, ack, snapshot() if data is None else data,
                            observed_at=1010, started_monotonic=2010,
                            now=1015, now_monotonic=2015, **responses)


class OrderAdapterTests(unittest.TestCase):
    def test_complete_no_send_rehearsal_even_success_and_delivery_never_paid(self):
        tracking = {'type':'OrderTrackingScreen', 'common_tracking_event_attributes':{
            'order_id':'1234567890', 'delivery_status':'order_delivered'}}
        out = run_rehearsal(place_status=200, place_response=fixtures.fixtures.response(),
                            payment_status=200, payment_response={'status':'success'},
                            tracking_response=tracking)
        self.assertEqual(out['mode'], 'NO_SEND_REHEARSAL')
        self.assertTrue(out['approval']['approval_binding_matches'])
        self.assertTrue(out['selected_payment_candidate_validated'])
        self.assertEqual(out['place_observation']['state'], 'PAYMENT_PENDING')
        self.assertEqual(out['payment_observation']['state'], 'UNBOUND_PAYMENT_SUCCESS')
        self.assertTrue(out['order_observation']['order_identity_matches'])
        self.assertEqual(out['order_observation']['fulfilment_stage'], 'delivered')
        for key in ('effective_native_route_verified', 'supplied_result_transport_binding_verified',
                    'server_precharge_amount_binding_verified', 'request_id_idempotency_verified',
                    'owner_authorization_verified', 'fresh_server_provenance_verified',
                    'payment_completion_verified', 'journal_consumed', 'request_sent',
                    'retry_allowed', 'ready_to_order', 'commit_enabled'):
            self.assertIs(out[key], False, key)

    def test_legacy_minimal_config_is_not_routable(self):
        with self.assertRaisesRegex(adapter.review.q.c.http.TalabatError, 'PLATFORM'):
            freeze(fixtures.snapshot())

    def test_raw_precheck_blocks_before_any_possible_send(self):
        data = snapshot()
        data['payment_config']['paymentMethods'][0]['events']['prePayment'] = {'name':'ForceCVV'}
        self.assertIsNone(data['payment_requirement'])
        with self.assertRaisesRegex(adapter.review.q.c.http.TalabatError, 'CVV'):
            freeze(data)

    def test_candidate_drift_requires_new_ack_even_same_price_card(self):
        original = freeze(); data = snapshot()
        event = data['payment_config']['paymentMethods'][0]['events']['payment']
        event['routingCriteria'] = {'pu':'different-private-routing'}
        with self.assertRaisesRegex(adapter.review.q.c.http.TalabatError, 'CHANGED'):
            run_rehearsal(original, data)

    def test_unknown_effective_route_cannot_be_asserted_by_input(self):
        data = snapshot(); data['effective_native_route_verified'] = True
        with self.assertRaises(adapter.review.q.c.http.TalabatError): freeze(data)

    def test_unchanged_input_detached_and_safe_projection_only(self):
        data = snapshot(); before = copy.deepcopy(data)
        out = run_rehearsal(data=data, place_status=200, place_response={
            'placedOrder':{'orderId':'1234567890', 'transactionId':'secret-transaction',
                           'redirectUrl':'https://private.invalid/secret'}})
        self.assertEqual(data, before)
        text = json.dumps(out)
        for value in ('1234567890', 'secret-transaction', 'private.invalid', '500000000',
                      'synthetic-token', 'synthetic-address', 'synthetic-fingerprint'):
            self.assertNotIn(value, text)
        self.assertEqual(out['place_observation']['state'], 'CHALLENGE_REQUIRED')

    def test_missing_response_cannot_reconcile_from_tracking_history(self):
        out = run_rehearsal(tracking_response={'type':'OrderTrackingScreen',
            'common_tracking_event_attributes':{'order_id':'1234567890', 'delivery_status':'order_delivered'}})
        self.assertEqual(out['place_observation']['state'], 'SUBMISSION_UNKNOWN')
        self.assertFalse(out['order_observation']['order_identity_matches'])
        self.assertFalse(out['retry_allowed'])

    def test_no_auth_transport_journal_or_any_live_toggle(self):
        with patch.object(adapter.review.q.c.http, 'account', side_effect=AssertionError('auth')), \
                patch.object(adapter.review.q, '_json_request', side_effect=AssertionError('http')), \
                patch.object(adapter.review.journal, 'consume', side_effect=AssertionError('journal')):
            run_rehearsal()
            for options in ({}, {'enabled':True}, {'send':True, 'approved':True},
                            {'force':True, 'payment_proven':True, 'dry_run':False}):
                with self.assertRaisesRegex(adapter.review.q.c.http.TalabatError, 'ADAPTER_DISABLED'):
                    adapter.submit(snapshot(), **options)

    def test_expired_or_preapproval_observations_stop(self):
        original = freeze(); ack = fixtures.acknowledgement(original)
        for wall, now in ((1005,1010), (1115,1120)):
            with self.assertRaises(adapter.review.q.c.http.TalabatError):
                adapter.rehearse(original, ack, snapshot(), observed_at=wall,
                                 started_monotonic=wall+1000, now=now, now_monotonic=now+1000)

    def test_test_only_journal_composition_all_results_permanently_fenced(self):
        # Neither adapter function consumes a journal. This deliberately simulates
        # the post-send crash boundary in a temporary test-only state root.
        journal = adapter.review.journal
        for body in (None, {}, {'duplicateOrderError':{}}, {'smsVerificationError':{}},
                     fixtures.fixtures.response()):
            with self.subTest(body=body), tempfile.TemporaryDirectory() as directory, \
                    patch.object(journal, 'ROOT', Path(directory)/'journal'), \
                    patch.object(journal.time, 'time', return_value=1015):
                original = freeze()
                operation = journal.consume(json.loads(original._review), original.digest)
                out = run_rehearsal(original, place_status=200, place_response=body)
                safe = out['place_observation']
                journal.record_observation(operation['operation'], safe['state'],
                                           adapter.review._hash('test-response', safe))
                self.assertFalse(out['retry_allowed'])
                with self.assertRaisesRegex(adapter.review.q.c.http.TalabatError, 'ALREADY_FENCED'):
                    journal.consume(json.loads(original._review), original.digest)


if __name__ == '__main__': unittest.main()
