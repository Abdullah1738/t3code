from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch,Mock
from noon_checkout import AccountHome,fingerprint
from noon_auth_lifecycle import AuthSnapshot
from noon_nownow_checkout import SavedCard,Snapshot
from noon_nownow_controller import CardSyncBinding
import commerce_nownow as c
import commerce_preorder as p
from test import test_noon_nownow_review as fixtures


class Store:
    def __init__(self):self.data={}
    def load(self,key):return self.data.get(key)
    def store(self,key,value):self.data[key]=value


class PreorderFlowTests(unittest.TestCase):
    def test_native_preorder_reserves_before_wire_and_recovery_never_replays(self):
        fixture=fixtures.ReviewTests();fixture.setUp();fixture.row['prepaidPaymentMisc']['isCvvRequired']=True
        with tempfile.TemporaryDirectory() as temp,patch.object(c.journal,'ROOT',Path(temp).resolve()/'commerce'), \
                patch.object(c.receipts,'ROOT',Path(temp).resolve()/'commerce'):
            auth=Mock();auth.status.return_value={'maintenance_state':'none'}
            auth.revalidate.side_effect=lambda *a,**k:AuthSnapshot('nownow',fingerprint('customer'),fingerprint('home','key'),
                time.time(),{'cookie':'synthetic=x','x-addresscode':'home','x-addresskey':'key'},time.monotonic()+30)
            flow=c.NowNowFlow(store_code='shop',products=(('p',2),),auth=auth,request=Mock())
            flow.session_code='owned';flow.card=SavedCard('synthetic-token','xxxx2342','mastercard')
            flow.controller_card={'id':flow.card.token,'ccMasked':flow.card.mask,'ccType':'mastercard','isDeleted':False}
            flow.current=Snapshot({'data':fixture.row},{},time.time())
            flow.card_binding=CardSyncBinding(flow.account_hash,flow.address_hash,fingerprint('owned'),fingerprint(flow.card.token),'1'*64,'2'*64,time.time())
            flow.review_cart(financials_minor=fixture.args['expected_financials_minor'],price_breakdown=fixture.args['expected_price_breakdown'])
            c.journal.open_flow(flow_id=flow.flow_id,app='noon',vertical='nownow',account_hash=flow.account_hash,scope_hash=flow.scope_hash)
            flow.receipt_store=c.receipts.create(flow_id=flow.flow_id,app='noon',vertical='nownow',account_hash=flow.account_hash,scope_hash=flow.scope_hash)
            flow.opened=True
            original_card=flow.card
            flow.card=SavedCard('other-token','xxxx2342','mastercard')
            with self.assertRaises(Exception):flow.authorize_preorder(cvv=b'007',vault=p.IntentVault(Store()))
            self.assertEqual(c.journal.inspect(flow.flow_id)['reserved_minor'],0)
            flow.card=original_card
            calls=[]
            def wire(operation,headers,deadline,payload,*,response_observer,order):
                calls.append(operation)
                response_observer(c.native.ResponseObservation(c.native.endpoint(operation,payload,order)[1],200,()))
                if operation=='payment_config':return {'cvv_encryption':{}}
                if operation=='cart_validate':
                    self.assertEqual(payload,{'sessionCode':'owned'})
                    return {'data':fixture.row}
                state=c.journal.inspect(flow.flow_id)
                if operation in ('payment_subscription','payment_complete'):
                    self.assertEqual(state['reserved_minor'],2500)
                    self.assertIsNone(state['order_id'])
                    self.assertEqual(state['operations'][-1]['state'],'MAY_HAVE_SENT')
                if operation=='payment_subscription':return {'status':'success','data':'synthetic-secret'}
                return {'status':'payment_pending' if operation=='payment_complete' else 'payment_confirmed'}
            flow.client._request=wire
            vault=p.IntentVault(Store())
            flow.validate_reviewed()
            with patch('noon_cvv.encrypt',return_value={'encCvv':'synthetic-encrypted','publicKeyName':'test'}):
                result=flow.authorize_preorder(cvv=b'007',vault=vault)
            self.assertEqual(result['payment_status'],'payment_pending')
            # Fresh process-shaped recovery loads only vault+journal and calls
            # native status; it cannot reconstruct an authorization or pay send.
            status_client=Mock()
            status_client._call.return_value=Snapshot({}, {'payment_status':'payment_pending','redirect_required':False},time.time())
            with patch('commerce_nownow.reader',return_value=status_client):
                recovered=p.recover(flow.flow_id,auth=Mock(),vault=vault)
            self.assertFalse(recovered['financial_retry'])
            self.assertEqual(status_client._call.call_args.args[0],'payment_status')
            self.assertEqual(status_client._call.call_args.args[1],{'clientSecret':'synthetic-secret'})
            alternate=p.IntentVault(Store())
            alternate.retain(flow.flow_id,secret='different-secret',review_hash=flow.review.digest,
                cart_hash=c.journal.digest({'flow':flow.flow_id,'store':flow.store_code}),
                card_hash=fingerprint(flow.card.token),payable_minor=2500)
            with self.assertRaises(c.journal.JournalError):flow.read_preorder_payment(vault=alternate)
            self.assertEqual(flow.read_preorder_payment(vault=vault)['payment_status'],'payment_confirmed')
            self.assertTrue(c.journal.preorder_status(flow.flow_id)['payment_confirmed'])
            with patch('noon_cvv.encrypt',return_value={'encCvv':'synthetic-encrypted','publicKeyName':'test'}):
                with self.assertRaises(c.native.NowNowError):flow.authorize_preorder(cvv=b'007',vault=vault)
            self.assertEqual(calls.count('payment_subscription'),1)
            self.assertEqual(calls.count('payment_complete'),1)
            disk=''.join(x.read_text() for x in (Path(temp)/'commerce'/'receipts').glob('*.json'))
            self.assertNotIn('synthetic-secret',disk)

    def test_vault_has_exact_binding_and_never_overwrites(self):
        vault=p.IntentVault(Store());flow='10000000-0000-4000-8000-000000000001'
        fields=dict(secret='synthetic',review_hash='1'*64,cart_hash='2'*64,card_hash='3'*64,payable_minor=2500)
        token=vault.retain(flow,**fields)
        self.assertEqual(vault.load(flow)['intent_hash'],token)
        with self.assertRaises(c.journal.JournalError):vault.retain(flow,**fields)

    def test_crash_status_success_keeps_unknown_financial_fence(self):
        flow='10000000-0000-4000-8000-000000000001'
        with tempfile.TemporaryDirectory() as temp,patch.object(c.journal,'ROOT',Path(temp).resolve()/'commerce'):
            c.journal.open_flow(flow_id=flow,app='noon',vertical='nownow',account_hash='1'*64,scope_hash='2'*64)
            args=dict(request_hash='3'*64,cart_hash='4'*64,review_hash='5'*64,payable_minor=2500)
            c.journal.consume(flow,'subscription',kind='preauthorize',**args)
            vault=p.IntentVault(Store());intent=vault.retain(flow,secret='synthetic',review_hash='5'*64,
                cart_hash='4'*64,card_hash='6'*64,payable_minor=2500)
            c.journal.observe(flow,'subscription',outcome='PREORDER_INTENT_RECEIVED',evidence_hash=intent)
            c.journal.consume(flow,'prepay',kind='prepay',payment_intent_hash=intent,**args)
            client=Mock();client._call.return_value=Snapshot({}, {'payment_status':'payment_confirmed','redirect_required':False},time.time())
            with patch('commerce_nownow.reader',return_value=client):
                with self.assertRaisesRegex(c.journal.JournalError, 'NOWNOW_PREORDER_RECONCILIATION_UNPROVEN'):
                    p.recover(flow,auth=Mock(),vault=vault)
            self.assertEqual(c.journal.inspect(flow)['state'],'FENCED')
            self.assertEqual(client._call.call_count, 1)
            with self.assertRaises(c.journal.JournalError):c.journal.consume(flow,'place',kind='place',**args)
            self.assertEqual(c.journal.inspect(flow)['reserved_minor'],2500)


if __name__=='__main__':unittest.main()
