import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import commerce_flow as f
import commerce_journal as j
from talabat_http_checkout import PaymentResult
from talabat_place_contract import PlaceObservation

FLOW = '10000000-0000-4000-8000-000000000001'
ORDER = '1234567890'


class FlowTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        p = patch.object(j, 'ROOT', Path(temp.name) / 'commerce')
        p.start(); self.addCleanup(p.stop)
        self.receipts = []
        self.gate = f.FlowGate(flow_id=FLOW, app='talabat', vertical='shops',
            account_hash='1'*64, scope_hash='2'*64,
            receipt_sink=lambda r: self.receipts.append(r) is None,
            request_check=lambda r: r['request_sha256'] == '3'*64)

    def record(self, operation):
        result = {'version': 1, 'app': 'talabat', 'flow_id': FLOW,
                  'account_binding': '1'*64, 'operation': operation,
                  'state': 'MAY_HAVE_SENT', 'request_sha256': '3'*64,
                  'cart_binding': '4'*64}
        if operation in ('place', 'payment'):
            result.update(currency='AED', payable_minor=2000, review_sha256='5'*64)
        if operation == 'payment':
            result['payment_order_id'] = ORDER
        return result

    def place(self):
        self.gate.before_talabat(self.record('place'))
        self.gate.talabat_receipt({'operation':'place', 'observation':
            PlaceObservation('PAYMENT_PENDING','PAYMENT_COMPLETION_UNPROVEN',ORDER,'txn','20.00'),
            'http_status':200})

    def test_real_budget_journal_and_receipts_close_only_after_exact_tracking(self):
        self.place()
        self.gate.before_talabat(self.record('payment'))
        self.gate.talabat_receipt({'operation':'payment', 'result':
            PaymentResult('PAYMENT_PENDING','TALABAT_ASYNC_STATUS_REQUIRED',ORDER,'txn'),
            'http_status':200, 'context':None, 'next_index':0})
        with self.assertRaises(j.JournalError): j.complete(FLOW)
        self.gate.talabat_receipt({'operation':'payment_status', 'result':
            PaymentResult('PAYMENT_REPORTED_SUCCESS','EXACT_TRANSACTION_ASYNC_STATUS_SUCCESS',ORDER,'txn'),
            'http_status':200, 'next_index':1})
        self.gate.exact_order({'order':ORDER,'source':'native_order_api','identity_verified':True,
                              'account_verified':True,'status':'preparing',
                              'order_account_verified':True,'order_list_present':True})
        self.gate.tracker_registered(ORDER, {'watcher_id':'order-talabat-'+ORDER})
        self.assertEqual(j.complete(FLOW)['state'], 'COMPLETE')
        self.assertEqual(j.inspect(FLOW)['campaign_reserved_minor'],2000)

    def test_sink_failure_leaves_previous_send_unobserved(self):
        self.gate.before_talabat(self.record('create_cart'))
        self.gate.receipt_sink = lambda r: False
        with self.assertRaises(j.JournalError):
            self.gate.talabat_receipt({'operation':'create_cart','state':'SUCCEEDED','http_status':200})
        with self.assertRaisesRegex(j.JournalError,'UNOBSERVED'):
            self.gate.before_talabat(self.record('quote_initial'))

    def test_scope_and_request_mismatch_never_open_real_flow(self):
        bad = self.record('place'); bad['request_sha256']='9'*64
        with self.assertRaises(j.JournalError): self.gate.before_talabat(bad)
        self.assertFalse(self.gate.opened)
        bad = self.record('place'); bad['account_binding']='9'*64
        with self.assertRaises(j.JournalError): self.gate.before_talabat(bad)
        self.assertFalse(self.gate.opened)

    def test_lost_financial_response_remains_fenced_even_after_get_success(self):
        self.place(); self.gate.before_talabat(self.record('payment'))
        for state in ('PAYMENT_UNKNOWN','PAYMENT_REPORTED_SUCCESS'):
            self.gate.talabat_receipt({'operation':'payment_status','result':
                PaymentResult(state,'SYNTHETIC_REASON',ORDER,'txn'),'http_status':200,'next_index':1})
        self.assertEqual(j.inspect(FLOW)['state'],'FENCED')
        with self.assertRaises(j.JournalError): j.complete(FLOW)

    def test_false_tracking_and_duplicate_payment_are_rejected(self):
        self.place()
        with self.assertRaises(j.JournalError): self.gate.exact_order({'order':ORDER,'status':'delivered'})
        self.gate.before_talabat(self.record('payment'))
        with self.assertRaises(j.JournalError): self.gate.before_talabat(self.record('payment'))

    def test_tracking_echo_and_profile_cannot_close_unpaid_or_unlisted_order(self):
        self.place()
        tracking={'order':ORDER,'source':'native_order_api','identity_verified':True,
                  'account_verified':True,'status':'pending confirmation',
                  'order_account_verified':True,'order_list_present':True}
        with self.assertRaisesRegex(j.JournalError,'PAYMENT_AND_ACCOUNT_ORDER_LIST_REQUIRED'):
            self.gate.exact_order(tracking)
        self.gate.before_talabat(self.record('payment'))
        self.gate.talabat_receipt({'operation':'payment','result':
            PaymentResult('PAYMENT_REPORTED_SUCCESS','TALABAT_SYNC_NORMAL_RETURN',ORDER,'txn'),
            'http_status':200})
        for changes in ({'order_list_present':False},{'order_account_verified':False}):
            with self.subTest(changes=changes), self.assertRaisesRegex(
                    j.JournalError,'PAYMENT_AND_ACCOUNT_ORDER_LIST_REQUIRED'):
                self.gate.exact_order({**tracking,**changes})


if __name__ == '__main__':
    unittest.main()
