from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import Mock,patch

import commerce_nownow as c
from noon_auth_lifecycle import AuthSnapshot
from noon_checkout import fingerprint


class NowNowFlowTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        for module in (c.journal,c.receipts):
            p=patch.object(module,'ROOT',Path(temp.name).resolve()/'commerce');p.start();self.addCleanup(p.stop)
        self.auth=Mock();self.auth.status.return_value={'maintenance_state':'none'}
        self.auth.revalidate.side_effect=lambda *a,**k:AuthSnapshot('nownow','1'*64,fingerprint('HOME','KEY'),
            time.time(),{'cookie':'synthetic=secret','x-addresscode':'HOME','x-addresskey':'KEY'},time.monotonic()+30)

    def test_existing_account_fence_prevents_new_flow_before_wire(self):
        flow='10000000-0000-4000-8000-000000000001'
        c.journal.open_flow(flow_id=flow,app='noon',vertical='minutes',account_hash='1'*64,scope_hash='2'*64)
        wire=Mock()
        with self.assertRaisesRegex(c.journal.JournalError,'RECONCILIATION_REQUIRED'):
            c.NowNowFlow(store_code='STORE',products=(('PRODUCT',1),),auth=self.auth,request=wire)
        wire.assert_not_called()

    def test_existing_store_cart_never_adopted_or_changed(self):
        flow=c.NowNowFlow(store_code='STORE',products=(('PRODUCT',1),),auth=self.auth,request=Mock())
        flow.client=Mock()
        flow.client.recent_carts.return_value=Mock(projection={'carts':[{'store_code':'STORE'}]})
        with self.assertRaisesRegex(c.journal.JournalError,'MUST_NOT_BE_ADOPTED'):flow.create()
        flow.client.create_cart.assert_not_called()
        self.assertFalse(flow.opened)

    def test_live_shape_quiet_map_requires_both_supported_controls(self):
        flow=c.NowNowFlow(store_code='STORE',products=(('PRODUCT',1),),auth=self.auth,request=Mock())
        flow.session_code='SESSION'
        flow.current=Mock(wire={'data':{'deliveryPreference':{'dont_ring_the_bell':True}}})
        with self.assertRaisesRegex(c.journal.JournalError,'PREFERENCE_SCHEMA'):flow.quiet()

    def test_unreviewed_financial_request_never_consumed(self):
        flow=c.NowNowFlow(store_code='STORE',products=(('PRODUCT',1),),auth=self.auth,request=Mock())
        flow._expect('place',{'sessionCode':'SESSION','total':20})
        with self.assertRaisesRegex(c.journal.JournalError,'FRESH_REVIEW_REQUIRED'):
            flow._before(*flow.expected)
        self.assertFalse(flow.opened)

    def test_current_controller_finalize_with_exact_review_journals_once(self):
        import json
        from test import test_noon_nownow_review as fixtures
        from noon_nownow_checkout import Snapshot,SavedCard
        fixture=fixtures.ReviewTests();fixture.setUp()
        flow=c.NowNowFlow(store_code='shop',products=(('p',2),),auth=self.auth,request=Mock())
        # Independently known synthetic account for the native row.
        flow.account_hash=fingerprint('customer');flow.address_hash=fingerprint('home','key')
        flow.snapshot=AuthSnapshot('nownow',flow.account_hash,flow.address_hash,time.time(),
            {'x-addresscode':'home','x-addresskey':'key','cookie':'synthetic=secret'},time.monotonic()+30)
        flow.session_code='owned';flow.card=SavedCard('synthetic-token','xxxx2342','mastercard')
        flow.controller_card={'id':'synthetic-token','ccMasked':'xxxx2342','ccType':'mastercard','isDeleted':False}
        from noon_nownow_controller import CardSyncBinding
        flow.card_binding=CardSyncBinding(flow.account_hash,flow.address_hash,fingerprint('owned'),
            fingerprint('synthetic-token'),'1'*64,'2'*64,time.time())
        flow.current=Snapshot({'data':fixture.row},{},time.time())
        flow.review_cart(financials_minor=fixture.args['expected_financials_minor'],
                         price_breakdown=fixture.args['expected_price_breakdown'])
        c.journal.open_flow(flow_id=flow.flow_id,app='noon',vertical='nownow',
            account_hash=flow.account_hash,scope_hash=flow.scope_hash)
        flow.receipt_store=c.receipts.create(flow_id=flow.flow_id,app='noon',vertical='nownow',
            account_hash=flow.account_hash,scope_hash=flow.scope_hash)
        flow.opened=True
        controller={'observed_at':time.time(),'review_digest':flow.review.digest,'status':'idle',
            'orderPaymentAmount':25,'selection':{'kind':'card','cardId':'synthetic-token'},
            'wallet':{'enabled':False},'requiresCardSubscription':False,'isCvvRequired':False}
        validation={'review_digest':flow.review.digest,'observed_at':time.time(),'checkoutWarningPopup':None}
        flow.validation=validation
        def place(**kwargs):
            body=c.native.place_payload(kwargs['session_code'],kwargs['order_payment_minor'])
            kwargs['before_send']('place',c.hashlib.sha256(c.native.seam._json(body)).hexdigest())
            flow._receipt({'service':'nownow','operation':'place','outcome':'ORDER_ID_RECEIVED',
                'http_status':200,'order_id':'NNTEST123','evidence_hash':'1'*64})
            return Snapshot({}, {'order':'NNTEST123','state':'order_id_received_payment_unconfirmed'},time.time())
        flow.client=Mock();flow.client.place_order.side_effect=place
        result=flow.finalize_reviewed(controller,validation=validation)
        self.assertEqual(result['order'],'NNTEST123')
        self.assertEqual(c.journal.inspect(flow.flow_id)['reserved_minor'],2500)
        with self.assertRaises(c.journal.JournalError):flow.finalize_reviewed(controller,validation=validation)


if __name__=='__main__':unittest.main()
