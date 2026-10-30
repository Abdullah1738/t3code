"""A server order ID is not proof of payment or account-order-list membership."""
import os as _os, tempfile as _tempfile
# commerce_cli reads the pause file at import; the owner's real one must not refuse test orders.
_os.environ['ORDERING_PAUSE_FILE'] = _os.path.join(_tempfile.gettempdir(), 'ordering-pause-test-absent', 'ordering-paused')
import contextlib
import io
import unittest
import os as _os, tempfile as _tempfile
# The live card-status record must never decide these tests.
_os.environ['CARD_STATUS_FILE']=_os.path.join(_tempfile.mkdtemp(prefix='card-status-test-'),'card-status.json')
from types import SimpleNamespace
from unittest.mock import Mock, patch

import commerce_cli as cli
import talabat_http_list as listing
import talabat_http_orders as http
from test.test_talabat_http_orders import saved, screen


class AccountOrderConfirmationTest(unittest.TestCase):
    def track(self, *, present, status='order_confirmingdelayed'):
        account = saved()
        rows = [{'id': '123' if present else '456', 'status': 'Delivered'}]
        with patch.object(http, 'load', return_value=account), \
                patch.object(http, 'request', side_effect=[account['expected_profile'], screen(status=status)]), \
                patch.object(listing, 'page_request', return_value={
                    'orders': rows, 'is_last_page': True, 'total_orders': 1}):
            return http.track('123')

    def test_hidden_unpaid_order_is_never_placed_or_account_order_verified(self):
        result = self.track(present=False)
        self.assertEqual(result['status'], 'pending confirmation')
        self.assertTrue(result['profile_verified'])
        self.assertTrue(result['order_id_verified'])
        self.assertFalse(result['account_verified'])
        self.assertFalse(result['order_account_verified'])
        self.assertFalse(result['order_list_present'])
        self.assertFalse(result['purchase_confirmed'])

    def test_matching_account_list_order_proves_ownership_not_payment_capture(self):
        result = self.track(present=True, status='order_delivered')
        self.assertTrue(result['account_verified'])
        self.assertTrue(result['order_account_verified'])
        self.assertTrue(result['order_list_present'])
        self.assertIsNone(result['payment_capture_verified'])

    def test_tracking_delivered_echo_for_unlisted_order_is_not_delivery_proof(self):
        result = self.track(present=False, status='order_delivered')
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['raw_status'], 'order_delivered')
        self.assertFalse(result['account_verified'])

    def test_pure_projector_cannot_claim_it_verified_an_account(self):
        result = http.project(screen(), '123')
        self.assertFalse(result['account_verified'])
        self.assertFalse(result['profile_verified'])

    def test_list_read_failure_preserves_delay_without_fabricating_membership(self):
        account = saved()
        with patch.object(http, 'load', return_value=account), \
                patch.object(http, 'request', side_effect=[account['expected_profile'], screen(status='order_confirmingdelayed')]), \
                patch.object(listing, 'page_request', side_effect=http.TalabatError('RATE_LIMITED')):
            result = http.track('123')
        self.assertEqual(result['status'], 'pending confirmation')
        self.assertIsNone(result['order_list_present'])
        self.assertFalse(result['account_verified'])
        self.assertEqual(result['order_list_error'], 'RATE_LIMITED')

    def test_truncated_history_cannot_prove_absence(self):
        account = saved()
        with patch.object(http, 'load', return_value=account), \
                patch.object(http, 'request', side_effect=[account['expected_profile'], screen(status='order_confirming')]), \
                patch.object(listing, 'page_request', side_effect=lambda _saved, page, _deadline: {
                    'orders': [{'id': str(1000 + page), 'status': 'Delivered'}],
                    'is_last_page': False, 'total_orders': 1000}):
            result = http.track('123')
        self.assertIsNone(result['order_list_present'])
        self.assertEqual(result['order_list_verification'], 'not_found_in_bounded_history')

    def paged_track(self, pages):
        account = saved()
        with patch.object(http, 'load', return_value=account), \
                patch.object(http, 'request', side_effect=[account['expected_profile'], screen(status='order_preparing')]), \
                patch.object(listing, 'page_request', side_effect=lambda _saved, page, _deadline: pages[page]) as request:
            return http.track('123'), request.call_count

    def test_listed_order_stops_paging_and_survives_a_shifting_snapshot(self):
        def page(ids, total, last=False):
            return {'orders': [{'id': i, 'status': 'Delivered'} for i in ids],
                    'is_last_page': last, 'total_orders': total}
        cases = {'first page': ([page(['123', '9'], 1000)], 1),
                 'new order shifted pages': ([page(['8', '9'], 1000), page(['9', '123'], 1001)], 2)}
        for name, (pages, calls) in cases.items():
            with self.subTest(name):
                result, count = self.paged_track(pages)
                self.assertTrue(result['order_list_present'])
                self.assertTrue(result['order_account_verified'])
                self.assertEqual(result['status'], 'preparing')
                self.assertEqual(count, calls)

    def test_shifting_snapshot_without_the_order_cannot_prove_absence(self):
        def page(ids, total, last):
            return {'orders': [{'id': i, 'status': 'Delivered'} for i in ids],
                    'is_last_page': last, 'total_orders': total}
        result, _ = self.paged_track([page(['8', '9'], 3, False), page(['9', '7'], 3, True)])
        self.assertIsNone(result['order_list_present'])
        self.assertFalse(result['order_account_verified'])
        self.assertEqual(result['status'], 'unknown')


class PurchaseReportingTest(unittest.TestCase):
    def purchase(self, payment, listed=True, track_error=None, order='123'):
        flow = Mock()
        flow.flow_id = 'synthetic-flow'
        flow.prepare.return_value = {'payable_minor': 25790}
        flow.purchase.return_value = {'state': payment, 'reason': 'SYNTHETIC_PAYMENT_REASON',
                                      'flow_id': flow.flow_id}
        flow.checkout.track.return_value = {
            'order': '123', 'status': 'preparing', 'order_list_present': listed,
            'order_account_verified': listed, 'account_verified': listed,
            'identity_verified': True, 'source': 'native_order_api'}
        flow.checkout.track.side_effect = track_error
        args = SimpleNamespace(vertical='shops', branch=44444, apk_pool='unused',
                               resume_flow=None, prepare_only=False, label='test', recipient='moni')
        with patch.object(cli, 'input_items', return_value=[{'item_id': '10000000-0000-4000-8000-000000000002', 'quantity': 1}]), \
                patch.object(cli.talabat.shared, 'verticals_key', return_value='0123456789abcdef'), \
                patch('commerce_talabat.TalabatFlow', return_value=flow), \
                patch.object(cli.journal, 'inspect', return_value={'order_id': order}), \
                patch.object(cli.journal, 'complete') as complete, \
                patch.object(cli, 'register_tracking', return_value={'registered': True}) as register, \
                contextlib.redirect_stdout(io.StringIO()):
            result = cli.purchase_talabat(args)
        return result, complete, register

    def test_orderless_place_does_not_suggest_unavailable_payment_polling(self):
        result, complete, register = self.purchase('SUBMISSION_UNKNOWN', order=None)
        self.assertFalse(result['ok'])
        self.assertFalse(result['purchase_confirmed'])
        self.assertEqual(result['error'], 'TALABAT_PLACE_NOT_CONFIRMED')
        self.assertIn('talabat-search orders', result['next_action'])
        self.assertNotIn('recover-payment', result['next_action'])
        self.assertIn('Do not place another order', result['next_action'])
        complete.assert_not_called()
        register.assert_not_called()

    def test_declined_or_unknown_payment_is_explicit_nonzero_failure(self):
        for state in ('PAYMENT_ERROR_REPORTED', 'PAYMENT_UNKNOWN', 'PAYMENT_PENDING'):
            result, complete, register = self.purchase(state)
            self.assertFalse(result['ok'])
            self.assertFalse(result['purchase_confirmed'])
            self.assertEqual(result['order'], '123')
            self.assertEqual(result['delivery_status'], 'pending confirmation')
            self.assertIn('Do not place another order', result['next_action'])
            self.assertIn('recover-payment synthetic-flow', result['next_action'])
            complete.assert_not_called()
            self.assertFalse(register.call_args.kwargs['paid'])
            with patch.object(cli, 'purchase_talabat', return_value=result), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(['order','talabat','--vertical','shops',
                    '--branch','44444','--item','10000000-0000-4000-8000-000000000002',
                    '--apk-pool','unused']), 1)

    def test_payment_success_without_account_list_membership_cannot_announce_placement(self):
        result, complete, register = self.purchase('PAYMENT_REPORTED_SUCCESS', listed=False)
        self.assertFalse(result['ok'])
        self.assertFalse(result['purchase_confirmed'])
        self.assertEqual(result['error'], 'TALABAT_ORDER_LIST_CONFIRMATION_REQUIRED')
        self.assertIn('Do not place another order', result['next_action'])
        complete.assert_not_called()
        self.assertFalse(register.call_args.kwargs['paid'])

    def test_verification_read_failure_keeps_reported_payment_and_order(self):
        coded = RuntimeError('raw upstream text')
        coded.code = 503
        for error in (http.TalabatError('NATIVE_READ_TIMEOUT'), RuntimeError('raw upstream text'), coded):
            with self.subTest(error=error):
                result, complete, register = self.purchase('PAYMENT_REPORTED_SUCCESS', track_error=error)
                self.assertFalse(result['ok'])
                self.assertFalse(result['purchase_confirmed'])
                self.assertTrue(result['payment_reported_success'])
                self.assertEqual(result['order'], '123')
                self.assertEqual(result['error'], 'TALABAT_ORDER_VERIFICATION_FAILED')
                self.assertIn(result['verification_error'],
                              ('NATIVE_READ_TIMEOUT', 'ORDER_VERIFICATION_READ_FAILED'))
                self.assertNotIn('raw upstream text', str(result))
                self.assertIn('recover-payment synthetic-flow', result['next_action'])
                self.assertFalse(result['financial_retry'])
                complete.assert_not_called()
                self.assertFalse(register.call_args.kwargs['paid'])

    def test_payment_success_and_membership_report_exact_supported_evidence(self):
        result, complete, register = self.purchase('PAYMENT_REPORTED_SUCCESS')
        self.assertTrue(result['ok'])
        self.assertTrue(result['purchase_confirmed'])
        self.assertTrue(result['payment_reported_success'])
        self.assertIsNone(result['payment_capture_verified'])
        self.assertNotIn('next_action', result)
        complete.assert_called_once()
        self.assertTrue(register.call_args.kwargs['paid'])

    def test_recovered_success_still_requires_membership_before_notice_or_completion(self):
        import commerce_flow
        binding={'flow_id':'flow','app':'talabat','vertical':'shops',
                 'account_hash':'a'*64,'scope_hash':'b'*64}
        local={'order_id':'123','state':'ACTIVE','app':'talabat'}
        cursor=SimpleNamespace(stopped=True,next_index=1,context=None,
            result=SimpleNamespace(state='PAYMENT_REPORTED_SUCCESS',reason='EXACT_TRANSACTION_ASYNC_STATUS_SUCCESS'))
        store=Mock()
        store.snapshot.return_value.talabat_readback.return_value=cursor
        auth=Mock()
        tracking={'order':'123','order_list_present':False,'order_account_verified':False}
        with patch.object(cli.journal,'binding',return_value=binding), \
                patch.object(cli.journal,'inspect',return_value=local), \
                patch.object(cli.receipts,'load',return_value=store), \
                patch.object(cli,'CommerceAuth',return_value=auth), \
                patch.object(cli,'account_hash',return_value='a'*64), \
                patch.object(cli.talabat_orders,'track_bound',return_value=tracking), \
                patch.object(commerce_flow.journal,'payment_reported',return_value=True), \
                patch.object(cli.journal,'complete') as complete, \
                patch.object(cli.subprocess,'run',side_effect=AssertionError('no notice')):
            result=cli.recover_talabat('flow')
        self.assertFalse(result['ok'])
        self.assertFalse(result['completed'])
        self.assertEqual(result['completion_error'],'TALABAT_PAYMENT_AND_ACCOUNT_ORDER_LIST_REQUIRED')
        self.assertIn('Do not place another order',result['next_action'])
        self.assertIn('reconcile-order flow',result['next_action'])
        complete.assert_not_called()


if __name__ == '__main__':
    unittest.main()
