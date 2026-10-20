"""Native Error/errors responses must remain exact, durable, non-retryable evidence."""
import copy
from pathlib import Path
import tempfile
import time
import unittest
import os as _os, tempfile as _tempfile
# The live card-status record must never decide these tests.
_os.environ['CARD_STATUS_FILE']=_os.path.join(_tempfile.mkdtemp(prefix='card-status-test-'),'card-status.json')
from unittest.mock import patch

import commerce_cli as cli
import talabat_http_checkout as h
from commerce_flow import FlowGate


FLOW = '10000000-0000-4000-8000-000000000001'
ACCOUNT = cli.account_hash({'expected_profile': {'id': 77}})
CONTEXT = h.AsyncPaymentContext('12345', 'synthetic-transaction', FLOW,
                                (1.0, 1.0, 1.0), ACCOUNT, 'synthetic-payment')
DECLINE = {'type': 'retry', 'title': "Couldn't complete payment",
           'subtitle': 'Try again or choose a different payment method',
           'exception': '20051 - Insufficient funds, please try again with another card.',
           'cta': 'Try again'}
BODY = {'status': 'Error', 'error': DECLINE, 'errors': DECLINE}
REASON = 'PAYMENT_DECLINED_INSUFFICIENT_FUNDS_NO_RETRY'


class PaymentStatusTests(unittest.TestCase):
    def test_live_dual_error_shape_reports_decline_not_unknown(self):
        body = copy.deepcopy(BODY)
        result = h.parse_async_status(200, body, CONTEXT)
        self.assertEqual((result.state, result.reason), ('PAYMENT_ERROR_REPORTED', REASON))
        self.assertEqual((result.order_id, result.transaction_id, result.payment_id),
                         (CONTEXT.order_id, CONTEXT.transaction_id, CONTEXT.payment_id))
        self.assertEqual(body, BODY)

    def test_each_error_alias_blocks_success_and_unknown_error_text_stays_private(self):
        for key in ('error', 'errors'):
            with self.subTest(key=key):
                result = h.parse_async_status(200, {'status': 'Error', key: DECLINE}, CONTEXT)
                self.assertEqual(result.reason, REASON)
                result = h.parse_async_status(200, {'status': 'Success', key: DECLINE}, CONTEXT)
                self.assertEqual((result.state, result.reason),
                                 ('PAYMENT_ERROR_REPORTED', 'NO_ROLLBACK_OR_RETRY_ASSUMED'))
                result = h.parse_async_status(200, {'status': 'Error', key: {
                    'exception': 'private server diagnostic with a payment token'}}, CONTEXT)
                self.assertEqual(result.reason, 'NO_ROLLBACK_OR_RETRY_ASSUMED')
                self.assertNotIn('private', str(vars(result)))
        for signal in ('Error', 'ERROR', ' error '):
            self.assertEqual(h.parse_async_status(200, {'status': signal}, CONTEXT).state,
                             'PAYMENT_ERROR_REPORTED')
        # Conflicting details must not manufacture a specific processor decline.
        result = h.parse_async_status(200, {**BODY, 'errors': {'exception': 'another error'}}, CONTEXT)
        self.assertEqual(result.reason, 'NO_ROLLBACK_OR_RETRY_ASSUMED')

    def test_success_pending_continuations_and_unknown_schemas_remain_distinct(self):
        for signal, expected in (('Success', 'PAYMENT_REPORTED_SUCCESS'), ('Pending', 'PAYMENT_PENDING')):
            result = h.parse_async_status(200, {'status': signal, 'error': None, 'errors': None}, CONTEXT)
            self.assertEqual(result.state, expected)
        for key, value, expected in (('fallback', {}, 'PAYMENT_BLOCKED'),
                                     ('redirectUrl', '', 'CHALLENGE_REQUIRED'),
                                     ('hyperPayCheckoutId', '', 'PAYMENT_BLOCKED')):
            self.assertEqual(h.parse_async_status(200, {**BODY, key: value}, CONTEXT).state, expected)
        for body in ({'status': 'Redirection'}, {'status': ' REDIRECTION '}):
            self.assertEqual(h.parse_async_status(200, body, CONTEXT).state, 'CHALLENGE_REQUIRED')
        for key in ('error', 'errors'):
            for value in ('error', [], False, 1):
                with self.subTest(key=key, value=value):
                    self.assertEqual(h.parse_async_status(200, {'status': 'Success', key: value}, CONTEXT).state,
                                     'PAYMENT_UNKNOWN')
        for body in ({**BODY, 'captured': True}, {'status': 'authorized', 'errors': None}):
            self.assertEqual(h.parse_async_status(200, body, CONTEXT).state, 'PAYMENT_UNKNOWN')
        for code in (None, True, 401, 403, 500):
            self.assertEqual(h.parse_async_status(code, BODY, CONTEXT).state, 'PAYMENT_UNKNOWN')
        self.assertEqual(h.parse_async_status(422, BODY, CONTEXT).reason, REASON)


class RecoveryTests(unittest.TestCase):
    def test_unknown_cursor_recovers_decline_via_get_and_retains_fence_after_restart(self):
        binding = dict(flow_id=FLOW, app='talabat', vertical='shops',
                       account_hash=ACCOUNT, scope_hash='2' * 64)
        saved = {'account_verified': True, 'country': 'AE', 'headers': {},
                 'auth': {'access_token': 'synthetic-auth', 'customerId': 77},
                 'expected_profile': {'id': 77, 'mobile_country_code': '971', 'mobile_number': '500000000'}}
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(cli.journal, 'ROOT', Path(temp).resolve() / 'commerce'), \
                patch.object(cli.receipts, 'ROOT', Path(temp).resolve() / 'commerce'):
            store = cli.receipts.create(**binding)
            gate = FlowGate(**binding, receipt_sink=store, request_check=lambda _: True)
            record = {'version': 1, 'app': 'talabat', 'flow_id': FLOW, 'account_binding': ACCOUNT,
                      'request_sha256': '3' * 64, 'cart_binding': '4' * 64, 'review_sha256': '5' * 64,
                      'currency': 'AED', 'payable_minor': 2000, 'state': 'MAY_HAVE_SENT', 'operation': 'place'}
            gate.before_talabat(record)
            gate.talabat_receipt({'operation': 'place', 'http_status': 200, 'observation':
                h.place_contract.PlaceObservation('PAYMENT_PENDING', 'PAYMENT_COMPLETION_UNPROVEN',
                                                  CONTEXT.order_id, CONTEXT.transaction_id, '20.00')})
            gate.before_talabat({**record, 'operation': 'payment', 'payment_order_id': CONTEXT.order_id})
            gate.talabat_receipt({'operation': 'payment', 'context': CONTEXT, 'next_index': 0, 'http_status': 200,
                'result': h.PaymentResult('PAYMENT_PENDING', 'TALABAT_ASYNC_STATUS_REQUIRED',
                                          CONTEXT.order_id, CONTEXT.transaction_id, CONTEXT.payment_id)})
            gate.talabat_receipt({'operation': 'payment_status', 'context': CONTEXT, 'next_index': 1,
                'http_status': 200, 'result': h.PaymentResult('PAYMENT_UNKNOWN', 'STATUS_READ_FAILED_NO_RETRY',
                    CONTEXT.order_id, CONTEXT.transaction_id, CONTEXT.payment_id)})
            before = cli.journal.inspect(FLOW)

            def wire(account, deadline, method, path, **kwargs):
                self.assertEqual(account, saved)
                self.assertEqual((method, path), ('GET', '/pay/v2/payment/status'))
                self.assertEqual(kwargs, {'params': h.payment_status_params(CONTEXT),
                                         'headers': {'x-acceptance-request-id': FLOW}})
                return h.WireResponse(200, copy.deepcopy(BODY))

            with patch.object(cli, 'CommerceAuth') as auth, \
                    patch.object(h, '_wire', side_effect=wire) as request, \
                    patch.object(h.orders, 'request', return_value=saved['expected_profile']) as profile, \
                    patch.object(h.auth, 'expiry', return_value=time.time() + 3600), \
                    patch.object(h.time, 'sleep'), \
                    patch.object(cli.subprocess, 'run', side_effect=AssertionError('no tracker or payment writes')):
                auth.return_value.fresh_before_mutation.return_value.mutation_account.return_value = saved
                result = cli.recover_payment(FLOW, max_reads=1)
                self.assertEqual((result['state'], result['reason']), ('PAYMENT_ERROR_REPORTED', REASON))
                self.assertFalse(result['financial_retry'])
                self.assertFalse(result['completed'])
                self.assertEqual(result['next_index'], 2)
                self.assertEqual(cli.recover_payment(FLOW, max_reads=1), result)
                self.assertEqual(request.call_count, 1)
                profile.assert_called_once()
                self.assertEqual(profile.call_args.args[0], h.orders.PROFILE)

            after = cli.journal.inspect(FLOW)
            self.assertEqual(after['state'], 'FENCED')
            self.assertEqual(after['reserved_minor'], before['reserved_minor'])
            self.assertEqual(after['operations'], before['operations'])
            self.assertFalse(cli.journal.payment_reported(FLOW))
            cursor = cli.receipts.load(**binding).snapshot().talabat_readback()
            self.assertEqual(cursor.result.reason, REASON)
            self.assertTrue(cursor.stopped)
            persisted = b''.join(p.read_bytes() for p in (Path(temp) / 'commerce' / 'receipts').glob('*.json'))
            for text in (b'20051', b'Insufficient funds', b'exception', b"Couldn't complete payment"):
                self.assertNotIn(text, persisted)


if __name__ == '__main__':
    unittest.main()
