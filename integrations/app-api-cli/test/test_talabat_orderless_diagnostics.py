"""Orderless place failures remain fenced and expose their retained cause."""
import os as _os, tempfile as _tempfile
# commerce_cli reads the pause file at import; the owner's real one must not refuse test orders.
_os.environ['ORDERING_PAUSE_FILE'] = _os.path.join(_tempfile.gettempdir(), 'ordering-pause-test-absent', 'ordering-paused')
import contextlib
import io
import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import commerce_cli as cli
import commerce_order_status as status
import commerce_reconcile as reconcile
import commerce_receipts as receipts


class OrderlessDiagnosticsTest(unittest.TestCase):
    def setUp(self):
        self.flow = '10000000-0000-4000-8000-000000000001'
        self.binding = dict(flow_id=self.flow, app='talabat', vertical='restaurants',
                            account_hash='a' * 64, scope_hash='b' * 64)
        self.local = dict(order_id=None, state='FENCED', reserved_minor=3645,
                          operations=[dict(name='place', kind='place', state='OBSERVED')])
        self.place = receipts.Receipt(operation='place', state='REJECTED_DUPLICATE',
                                      reason='DUPLICATE_ORDER_ERROR_NO_RETRY', http_status=400)
        self.snapshot = SimpleNamespace(receipts=[self.place])
        self.store = Mock()
        self.store.snapshot.return_value = self.snapshot
        for patcher in (
                patch.object(cli.journal, 'binding', return_value=self.binding),
                patch.object(cli.journal, 'inspect', return_value=self.local),
                patch.object(receipts, 'load', return_value=self.store),
                patch.object(cli.journal, 'consume', side_effect=AssertionError('no sends')),
                patch.object(cli.journal, 'observe', side_effect=AssertionError('no journal edits')),
                patch.object(cli.journal, 'release_orderless', side_effect=AssertionError('no release')),
                patch.object(cli, 'CommerceAuth', side_effect=AssertionError('local evidence only')),
                patch.object(status, 'CommerceAuth', side_effect=AssertionError('local evidence only')),
                patch.object(reconcile, 'CommerceAuth', side_effect=AssertionError('local evidence only')),
                patch.object(cli, 'register_tracking', side_effect=AssertionError('no notification'))):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_all_readback_commands_report_duplicate_receipt_without_recovery_or_success(self):
        for command in ('order-status', 'recover-payment', 'reconcile-order'):
            with self.subTest(command=command), contextlib.redirect_stdout(io.StringIO()) as out:
                code = cli.main([command, self.flow])
                result = json.loads(out.getvalue())
            self.assertEqual(code, 1)
            self.assertEqual(result['error'], 'TALABAT_REJECTED_DUPLICATE')
            self.assertEqual(result['state'], 'REJECTED_DUPLICATE')
            self.assertEqual(result['reason'], 'DUPLICATE_ORDER_ERROR_NO_RETRY')
            self.assertEqual(result['place_http_status'], 400)
            self.assertEqual(result['journal_state'], 'FENCED')
            self.assertEqual(result['reserved_minor'], 3645)
            self.assertIsNone(result['order'])
            self.assertFalse(result['payment_operation_recorded'])
            self.assertFalse(result['purchase_confirmed'])
            self.assertFalse(result['provider_no_charge_proven'])
            self.assertIsNone(result['payment_capture_verified'])
            self.assertFalse(result['financial_retry'])
            self.assertFalse(result['reservation_release_allowed'])
            self.assertIn('--close-duplicate', result['next_action'])
            self.assertNotIn('recover-payment', result['next_action'])

    def test_unknown_transport_and_server_errors_are_not_called_duplicate_or_uncharged(self):
        for http_status, reason in ((None, 'RESPONSE_MISSING_OR_MALFORMED'),
                                    (503, 'HTTP_STATUS_UNSUPPORTED_NO_RETRY'),
                                    (400, 'GENERIC_ERROR_NO_RETRY')):
            with self.subTest(reason=reason):
                self.snapshot.receipts = [receipts.Receipt(operation='place', state='SUBMISSION_UNKNOWN',
                                                           reason=reason, http_status=http_status)]
                result = status.status(self.flow)
                self.assertEqual(result['reason'], reason)
                self.assertEqual(result['place_http_status'], http_status)
                self.assertFalse(result['provider_no_charge_proven'])
                self.assertFalse(result['reservation_release_allowed'])

    def test_missing_place_receipt_keeps_original_failure(self):
        self.snapshot.receipts = []
        with self.assertRaisesRegex(cli.journal.JournalError, 'EXACT_ORDER_ID_UNAVAILABLE'):
            status.status(self.flow)

    def test_recorded_payment_is_not_reported_as_unsent(self):
        self.local['operations'].append(dict(name='payment', kind='payment', state='MAY_HAVE_SENT'))
        result = status.status(self.flow)
        self.assertTrue(result['payment_operation_recorded'])
        self.assertFalse(result['provider_no_charge_proven'])


if __name__ == '__main__':
    unittest.main()
