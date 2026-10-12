from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import commerce_journal as j

FLOW='10000000-0000-4000-8000-000000000001'
OTHER='10000000-0000-4000-8000-000000000002'


class AccountFenceTests(unittest.TestCase):
    def test_existing_account_cannot_create_new_flow_or_reopen_fenced_one(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(j,'ROOT',Path(temp).resolve()/'commerce'):
            self.assertTrue(j.require_account_available('noon','1'*64))
            j.open_flow(flow_id=FLOW,app='noon',vertical='minutes',account_hash='1'*64,scope_hash='2'*64)
            with self.assertRaisesRegex(j.JournalError,'RECONCILIATION_REQUIRED'):
                j.require_account_available('noon','1'*64,flow_id=OTHER)
            self.assertTrue(j.require_account_available('noon','1'*64,flow_id=FLOW))
            j.consume(FLOW,'place',kind='place',request_hash='3'*64,cart_hash='4'*64,
                      review_hash='5'*64,payable_minor=1725)
            j.observe(FLOW,'place',outcome='UNKNOWN',evidence_hash='6'*64)
            with self.assertRaisesRegex(j.JournalError,'RECONCILIATION_REQUIRED'):
                j.require_account_available('noon','1'*64,flow_id=FLOW)
            self.assertEqual(j.inspect(FLOW)['campaign_reserved_minor'],1725)


if __name__=='__main__':unittest.main()
