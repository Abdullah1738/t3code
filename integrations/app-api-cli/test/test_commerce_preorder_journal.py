from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import commerce_journal as j

FLOW='10000000-0000-4000-8000-000000000001'


class PreorderTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        p=patch.object(j,'ROOT',Path(temp.name).resolve()/'commerce');p.start();self.addCleanup(p.stop)
        j.open_flow(flow_id=FLOW,app='noon',vertical='nownow',account_hash='1'*64,scope_hash='2'*64)
        self.binding=dict(request_hash='3'*64,cart_hash='4'*64,review_hash='5'*64,payable_minor=2500)

    def intent(self):
        j.consume(FLOW,'subscription',kind='preauthorize',**self.binding)
        j.observe(FLOW,'subscription',outcome='PREORDER_INTENT_RECEIVED',evidence_hash='6'*64)

    def test_reserves_full_amount_before_intent_no_order_id_then_attaches_order_once(self):
        self.intent()
        self.assertEqual(j.inspect(FLOW)['reserved_minor'],2500)
        self.assertIsNone(j.inspect(FLOW)['order_id'])
        j.consume(FLOW,'prepay',kind='prepay',payment_intent_hash='6'*64,**self.binding)
        j.observe(FLOW,'prepay',outcome='PREORDER_PAYMENT_CONFIRMED',evidence_hash='7'*64)
        j.consume(FLOW,'place',kind='place',**self.binding)
        j.observe(FLOW,'place',outcome='ORDER_ID_RECEIVED',evidence_hash='8'*64,order_id='NNEXACT')
        j.observe(FLOW,'place',outcome='EXACT_ORDER_CONFIRMED',evidence_hash='9'*64,order_id='NNEXACT')
        j.observe(FLOW,'place',outcome='TRACKER_REGISTERED',evidence_hash='a'*64,order_id='NNEXACT')
        self.assertEqual(j.complete(FLOW)['state'],'COMPLETE')
        self.assertEqual(j.inspect(FLOW)['campaign_reserved_minor'],2500)

    def test_crash_unknown_challenge_never_replays_or_places(self):
        self.intent()
        j.consume(FLOW,'prepay',kind='prepay',payment_intent_hash='6'*64,**self.binding)
        with self.assertRaises(j.JournalError):j.consume(FLOW,'newname',kind='prepay',payment_intent_hash='6'*64,**self.binding)
        j.observe(FLOW,'prepay',outcome='CHALLENGE_REQUIRED',evidence_hash='7'*64)
        with self.assertRaises(j.JournalError):j.consume(FLOW,'place',kind='place',**self.binding)
        self.assertEqual(j.inspect(FLOW)['reserved_minor'],2500)
        self.assertEqual(j.inspect(FLOW)['state'],'FENCED')

    def test_intent_card_review_amount_binding_and_full_campaign_cap(self):
        self.intent()
        for field,value in [('payment_intent_hash','8'*64),('review_hash','8'*64),('cart_hash','8'*64),('payable_minor',2499)]:
            args={**self.binding,'payment_intent_hash':'6'*64,field:value}
            with self.subTest(field=field),self.assertRaises(j.JournalError):j.consume(FLOW,'prepay',kind='prepay',**args)
        with self.assertRaises(j.JournalError):j.consume(FLOW,'place',kind='place',**self.binding)
        with self.assertRaises(j.JournalError):j.consume(FLOW,'another',kind='preauthorize',**self.binding)
        with self.assertRaises(j.JournalError):j.consume(FLOW,'change_card',kind='selection',request_hash='a'*64)


if __name__=='__main__':unittest.main()
