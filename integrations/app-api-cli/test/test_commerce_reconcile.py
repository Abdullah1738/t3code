from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import commerce_journal as j

FLOW='10000000-0000-4000-8000-000000000001'


class ReconcileTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        p=patch.object(j,'ROOT',Path(temp.name).resolve()/'commerce');p.start();self.addCleanup(p.stop)
        j.open_flow(flow_id=FLOW,app='noon',vertical='minutes',account_hash='1'*64,scope_hash='2'*64)

    def test_exact_preparation_readback_allows_next_operation_never_replay(self):
        j.consume(FLOW,'sync',kind='cart',request_hash='3'*64,cart_hash='4'*64)
        j.observe(FLOW,'sync',outcome='UNKNOWN',evidence_hash='5'*64)
        with self.assertRaises(j.JournalError):j.reconcile_preparation(FLOW,'sync',request_hash='9'*64,evidence_hash='6'*64)
        self.assertEqual(j.reconcile_preparation(FLOW,'sync',request_hash='3'*64,evidence_hash='6'*64)['state'],'ACTIVE')
        with self.assertRaises(j.JournalError):j.consume(FLOW,'sync',kind='cart',request_hash='3'*64,cart_hash='4'*64)
        self.assertTrue(j.consume(FLOW,'instructions',kind='instructions',request_hash='7'*64,cart_hash='4'*64))

    def test_financial_unknown_and_challenge_cannot_reopen(self):
        j.consume(FLOW,'place',kind='place',request_hash='3'*64,cart_hash='4'*64,review_hash='5'*64,payable_minor=1000)
        j.observe(FLOW,'place',outcome='UNKNOWN',evidence_hash='5'*64)
        with self.assertRaises(j.JournalError):j.reconcile_preparation(FLOW,'place',request_hash='3'*64,evidence_hash='6'*64)
        self.assertEqual(j.inspect(FLOW)['state'],'FENCED')


if __name__=='__main__':unittest.main()
