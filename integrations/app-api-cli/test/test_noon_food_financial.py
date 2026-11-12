import copy
import json
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import commerce_journal as j
import noon_food_financial as f
import noon_food_recovery as recovery
import commerce_food as food
from noon_checkout import fingerprint


ORDER='FSYNTHETIC1'
CARD='161'
INTENT='synthetic-secret-never-persist'


class Reader:
    def __init__(self):
        self.session_data={'account_hash':'a'*64,'scope_hash':'b'*64,'session_id':'SESSION1',
            'review_hash':'c'*64,'amount_minor':4585,'card_hash':j.digest(CARD),'order_id':None}
        self.order_data={'order_id':ORDER,'account_hash':'a'*64,'scope_hash':'b'*64,'amount_minor':4585,
            'card_hash':j.digest(CARD),'card_last4':'2342','intent':INTENT,'accepted':False,'cvv_required':False}
        self.payment_data={'reference':ORDER,'currency_code':'AED','amount':45.85,'cc_masked':'****2342',
            'payment_method_code':'cc_noonpay','id_token':CARD,'status':'synthetic_pending',
            'transaction_status':'SYNTHETIC_PENDING','error_code':'0','authorized_amount':0,'captured_amount':0}

    def session(self):return copy.deepcopy(self.session_data)
    def order(self, order):return copy.deepcopy(self.order_data)
    def payment(self, intent):return copy.deepcopy(self.payment_data)
    def card_token(self):return CARD
    def continuation_verified(self, row, payment):return True
    def capture(self):
        self.payment_data.update(status='payment_confirmed',transaction_status='CAPTURED',
                                 authorized_amount=45.85,captured_amount=45.85)


class FoodFinancialTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        self.root=Path(temp.name)/"commerce"
        p=patch.object(j,'ROOT',self.root);p.start();self.addCleanup(p.stop)
        self.flow=str(uuid.uuid4())
        j.open_flow(flow_id=self.flow,app='noon',vertical='food',account_hash='a'*64,scope_hash='b'*64)
        self.reader=Reader();self.calls=[];self.registrations=[]
        self.fail_send=None
        def send(operation,payload):
            self.calls.append((operation,copy.deepcopy(payload)))
            if operation=='place':self.reader.session_data['order_id']=ORDER
            if self.fail_send==operation:raise TimeoutError('synthetic')
        self.transport=SimpleNamespace(assert_enabled=lambda:None,send=send)
        def register(order,*,paid):
            self.registrations.append((order,paid))
            return {'registered':True,'order':order,'held':not paid}
        self.co=f.Coordinator(self.flow,self.reader,register,transport=self.transport)

    def test_automatic_bank_capture_completes_without_payment_send(self):
        self.reader.order_data.update(intent=None,accepted=True,automatic_payment_processed=True)
        self.reader.bank_capture=lambda order:{'paid':True,'order':order,'source':'native_and_bank'}
        result=self.co.place()
        self.assertTrue(result['capture_verified'])
        self.assertEqual(j.inspect(self.flow)['state'],'COMPLETE')
        self.assertEqual([call[0] for call in self.calls],['place'])
        self.co.recover()
        self.assertEqual(len(self.calls),1)

    def test_bank_receipt_cannot_be_claimed_by_another_order(self):
        self.co.place()
        bank={'source_id':516800,'amount_minor':4585}
        j.claim_food_bank_purchase(self.flow,bank)
        j.claim_food_bank_purchase(self.flow,bank)
        other=str(uuid.uuid4())
        j.open_flow(flow_id=other,app='noon',vertical='food',account_hash='d'*64,scope_hash='e'*64)
        j.consume(other,'place',kind='place',request_hash='f'*64,cart_hash='f'*64,review_hash='f'*64,payable_minor=4585)
        j.observe(other,'place',outcome='ORDER_ID_RECEIVED',evidence_hash='f'*64,order_id='FOTHER')
        with self.assertRaisesRegex(j.JournalError,'ALREADY_CLAIMED'):j.claim_food_bank_purchase(other,bank)

    def test_response_order_survives_first_detail_read_failure(self):
        self.transport.send=lambda *args:{'candidate_order_id':ORDER}
        self.reader.retained_session=lambda state,order:{**self.reader.session_data,'order_id':order}
        original=self.reader.order
        self.reader.order=Mock(side_effect=TimeoutError('private error'))
        with self.assertRaises(j.PaymentError) as error:self.co.place()
        self.assertEqual(error.exception.details['order'],ORDER)
        self.assertEqual(error.exception.details['charge'],'unknown')
        self.assertEqual(json.loads(self.co.path.read_text())['candidate_order_id'],ORDER)
        self.reader.session=Mock(side_effect=AssertionError('expired'))
        self.reader.order=original
        self.assertEqual(self.co.recover()['order'],ORDER)
        with self.assertRaises(j.JournalError):self.co.place()

    def test_native_bank_capture_uses_journal_placement_timestamp(self):
        self.co.place()
        reader=recovery.NativeReader.__new__(recovery.NativeReader)
        reader.flow_id=self.flow
        reader.state={'review':{'payable_minor':4585,'card_last4':'2342'}}
        bank={'source_id':516800,'amount_minor':4585}
        with patch('commerce_food_capture.find_bank_capture',return_value=bank) as lookup:
            self.assertTrue(reader.bank_capture(ORDER)['paid'])
            lookup.assert_called_once_with(j.food_capture_placed_at(self.flow),4585,'2342')

    def test_bank_pending_keeps_order_held(self):
        self.reader.order_data.update(intent=None,accepted=True,automatic_payment_processed=True)
        self.reader.bank_capture=Mock(side_effect=j.JournalError('pending'))
        result=self.co.place()
        self.assertFalse(result['paid'])
        self.assertTrue(result['tracker']['held'])
        self.assertNotEqual(j.inspect(self.flow)['state'],'COMPLETE')

    def test_automatic_transport_requires_explicit_eligibility(self):
        self.co.transport=f.AutomaticTransport(self.reader)
        with patch.object(self.co.transport,'send') as send:
            with self.assertRaisesRegex(j.JournalError,'NEEDS_APP'):self.co.place()
            with self.assertRaisesRegex(j.JournalError,'NEEDS_APP'):self.co.complete_payment()
            send.assert_not_called()
        self.assertEqual(j.inspect(self.flow)['operations'],[])

    def test_retained_order_recovery_skips_expired_session(self):
        self.co.place()
        self.reader.retained_session=lambda state,order:{**self.reader.session_data,'order_id':order}
        self.reader.session=Mock(side_effect=AssertionError('expired session must not be read'))
        self.reader.order_data.update(intent=None,accepted=True,automatic_payment_processed=True)
        self.reader.bank_capture=lambda order:{'paid':True,'order':order}
        self.assertTrue(self.co.recover()['paid'])
        self.assertEqual(len(self.calls),1)

    def test_default_transport_refuses_before_reads_or_journal(self):
        reader=Mock()
        co=f.Coordinator(self.flow,reader,Mock())
        for method in (co.place,co.complete_payment):
            with self.assertRaisesRegex(j.JournalError,'FOOD_LIVE_FINANCIAL_TRANSPORT_DISABLED'):method()
        self.assertEqual(j.inspect(self.flow)['operations'],[])
        self.assertEqual(reader.mock_calls,[])

    def test_ambiguous_place_bound_recovery_never_resends(self):
        self.fail_send='place'
        self.assertEqual(self.co.place()['state'],'PLACE_OUTCOME_UNKNOWN')
        self.assertEqual(j.inspect(self.flow)['state'],'FENCED')
        before=self.co.path.read_text()
        with self.assertRaises(j.JournalError):self.co.place()
        self.assertEqual(self.co.path.read_text(),before)
        result=self.co.recover()
        self.assertEqual(result['state'],'NEEDS_APP_PAYMENT_REQUIREMENT')
        self.assertEqual(result['order'],ORDER)
        self.assertTrue(result['tracker']['held'])
        self.assertEqual(len(self.calls),1)
        self.reader.capture();self.reader.order_data['accepted']=True
        self.assertEqual(self.co.recover()['state'],'PAID_AND_ACCEPTED')
        self.assertEqual(j.inspect(self.flow)['state'],'COMPLETE')
        self.assertEqual(self.co.recover()['state'],'PAID_AND_ACCEPTED')
        self.assertEqual(len(self.calls),1)

    def test_place_without_exact_session_order_retains_reservation(self):
        self.fail_send='place';self.co.place();self.reader.session_data['order_id']=None
        self.assertEqual(self.co.recover()['state'],'PLACE_OUTCOME_UNKNOWN')
        unknown=self.co.recover()
        self.assertIs(unknown['ok'],False)
        self.assertEqual(unknown['flow_id'],self.flow)
        self.assertEqual(unknown['charge'],'unknown')
        self.assertEqual(j.inspect(self.flow)['reserved_minor'],4585)
        self.assertEqual(self.registrations,[])
        with self.assertRaises(j.JournalError):
            j.open_flow(flow_id=str(uuid.uuid4()),app='noon',vertical='food',account_hash='a'*64,scope_hash='e'*64)

    def test_automatic_processing_does_not_claim_capture_or_release(self):
        self.reader.order_data.update(intent=None,accepted=True,automatic_payment_processed=True)
        result=self.co.place()
        self.assertEqual(result['state'],'MERCHANT_PROCESSED_CAPTURE_UNVERIFIED')
        self.assertFalse(result['paid'])
        self.assertFalse(result['capture_verified'])
        self.assertTrue(result['tracker']['held'])
        self.assertEqual(j.inspect(self.flow)['state'],'ACTIVE')
        self.assertEqual(j.inspect(self.flow)['reserved_minor'],4585)
        with self.assertRaises(j.JournalError):self.co.place()

    def test_retract_capture_claim_only_adds_fence_and_keeps_history(self):
        self.reader.capture();self.reader.order_data['accepted']=True
        self.co.place()
        j.retract_food_capture_claim(self.flow,evidence_hash=j.digest('correction'))
        state=j.inspect(self.flow)
        self.assertEqual(state['state'],'FENCED')
        self.assertEqual(state['reserved_minor'],4585)
        self.assertEqual(state['order_id'],ORDER)
        with self.assertRaises(j.JournalError):self.co.place()
        with self.assertRaises(j.JournalError):
            j.open_flow(flow_id=str(uuid.uuid4()),app='noon',vertical='food',account_hash='a'*64,scope_hash='e'*64)

    def test_ambiguous_complete_recovery_and_repeat_are_read_only(self):
        self.co.place();self.fail_send='complete'
        self.assertEqual(self.co.complete_payment()['state'],'PAYMENT_OUTCOME_UNKNOWN')
        with self.assertRaises(j.JournalError):self.co.complete_payment()
        self.assertEqual([r[0] for r in self.calls],['place','complete'])
        self.reader.capture();self.reader.order_data['accepted']=True
        self.assertEqual(self.co.recover()['state'],'PAID_AND_ACCEPTED')
        self.assertEqual(j.inspect(self.flow)['state'],'COMPLETE')
        self.co.recover()
        self.assertEqual(len(self.calls),2)

    def test_crash_after_reservation_before_response_is_recovery_only(self):
        def crash(operation,payload):raise SystemExit('simulated process exit')
        self.transport.send=crash
        with self.assertRaises(SystemExit):self.co.place()
        self.assertEqual(j.inspect(self.flow)['operations'][0]['state'],'MAY_HAVE_SENT')
        with self.assertRaises(j.JournalError):self.co.place()
        self.assertEqual(self.co.recover()['state'],'PLACE_OUTCOME_UNKNOWN')
        unknown=self.co.recover()
        self.assertIs(unknown['ok'],False)
        self.assertEqual(unknown['flow_id'],self.flow)
        self.assertEqual(unknown['charge'],'unknown')
        self.reader.session_data['order_id']=ORDER;self.reader.capture();self.reader.order_data['accepted']=True
        self.assertEqual(self.co.recover()['state'],'PAID_AND_ACCEPTED')

    def test_two_workers_can_dispatch_place_only_once(self):
        from concurrent.futures import ThreadPoolExecutor
        other=f.Coordinator(self.flow,self.reader,self.co.registrar,transport=self.transport)
        def place(co):
            try:return co.place()['state']
            except j.JournalError:return 'blocked'
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(place,[self.co,other]))
        self.assertEqual(sorted(results),['NEEDS_APP_PAYMENT_REQUIREMENT','blocked'])
        self.assertEqual(len(self.calls),1)

    def test_retained_state_must_match_journal_quote(self):
        self.co.place()
        state=json.loads(self.co.path.read_text());state['amount_minor']=4586
        self.co.save(state);self.reader.session_data['amount_minor']=4586
        with self.assertRaisesRegex(j.JournalError,'JOURNAL_BINDING_MISMATCH'):self.co.recover()

    def test_successful_complete_ack_is_not_capture(self):
        self.co.place()
        self.assertEqual(self.co.complete_payment()['state'],'NEEDS_APP_PAYMENT_REQUIREMENT')
        with self.assertRaises(j.JournalError):self.co.complete_payment()
        self.assertNotEqual(j.inspect(self.flow)['state'],'COMPLETE')
        self.assertEqual(len(self.calls),2)

    def test_captured_but_not_accepted_keeps_card_held(self):
        self.co.place();self.reader.capture()
        result=self.co.recover()
        self.assertEqual(result['state'],'PAID_AWAITING_ACCEPTANCE')
        self.assertTrue(result['paid']);self.assertFalse(result['accepted'])
        self.assertTrue(result['tracker']['held'])
        self.assertEqual(j.inspect(self.flow)['state'],'ACTIVE')
        self.co.complete_payment()
        self.assertEqual(len(self.calls),1)

    def test_registration_failure_cannot_finish_or_trigger_payment(self):
        self.co.place();self.reader.capture();self.reader.order_data['accepted']=True
        self.co.registrar=lambda *a,**kw:{'registered':False,'order':ORDER}
        with self.assertRaises(j.JournalError):self.co.recover()
        self.assertNotEqual(j.inspect(self.flow)['state'],'COMPLETE')
        self.assertEqual(len(self.calls),1)

    def test_payment_outage_still_registers_exact_order_held(self):
        self.reader.payment=Mock(side_effect=TimeoutError('do not persist me'))
        result=self.co.place()
        self.assertEqual(result['order'],ORDER)
        self.assertTrue(result['tracker']['held'])
        self.assertEqual(result['state'],'NEEDS_APP_PAYMENT_REQUIREMENT')
        self.assertIsNotNone(result['payment_error'])

    def test_different_session_review_amount_card_or_account_block_recovery(self):
        self.co.place()
        for key,value in [('session_id','SESSION2'),('review_hash','d'*64),('amount_minor',4586),
                          ('card_hash','e'*64),('account_hash','f'*64),('scope_hash','e'*64)]:
            old=self.reader.session_data[key];self.reader.session_data[key]=value
            with self.subTest(key=key),self.assertRaises(j.JournalError):self.co.recover()
            self.reader.session_data[key]=old
        self.assertEqual(len(self.calls),1)

    def test_order_and_intent_replacement_refused(self):
        self.co.place()
        self.reader.order_data['intent']='replacement'
        with self.assertRaisesRegex(j.JournalError,'INTENT_CHANGED'):self.co.recover()
        self.reader.order_data['intent']=INTENT;self.reader.session_data['order_id']='FOTHER'
        with self.assertRaisesRegex(j.JournalError,'ORDER_ID_CHANGED'):self.co.recover()

    def test_unknown_pending_and_missing_cvv_never_send(self):
        self.co.place();self.reader.continuation_verified=lambda *a:False
        with self.assertRaisesRegex(j.JournalError,'UNPAID_INTENT_CONTRACT'):self.co.complete_payment()
        self.reader.continuation_verified=lambda *a:True;self.reader.order_data['cvv_required']=None
        with self.assertRaisesRegex(j.JournalError,'CVV_REQUIREMENT_UNKNOWN'):self.co.complete_payment()
        self.reader.order_data['cvv_required']=True
        with self.assertRaisesRegex(j.JournalError,'ENCRYPTED_CVV_REQUIRED'):self.co.complete_payment()
        self.assertEqual(len(self.calls),1)

    def test_challenge_and_failed_payment_never_replayed(self):
        self.co.place();self.reader.payment_data['redirect_url']='https://example.invalid/challenge'
        with self.assertRaisesRegex(j.JournalError,'CHALLENGE_ALREADY_ACTIVE'):self.co.complete_payment()
        self.reader.payment_data.pop('redirect_url');self.reader.payment_data['status']='payment_failed'
        with self.assertRaisesRegex(j.JournalError,'PAYMENT_FAILED_NO_RETRY'):self.co.complete_payment()
        self.assertEqual(len(self.calls),1)

    def test_cvv_and_secrets_absent_from_durable_files(self):
        self.co.place();self.reader.order_data['cvv_required']=True
        encrypted={'encCvv':'synthetic-encrypted-cvv-private','publicKeyName':'key-name'}
        self.co.complete_payment(cvv_encryption=encrypted)
        self.assertEqual(self.calls[-1][1]['cvvEncryption'],encrypted)
        for path in self.root.rglob('*'):
            if path.is_file():
                for secret in (INTENT,encrypted['encCvv']):self.assertNotIn(secret.encode(),path.read_bytes())
        self.assertEqual(self.co.path.stat().st_mode & 0o777,0o600)

    def test_payment_proof_requires_exact_capture_currency_card_reference(self):
        self.reader.capture();raw=self.reader.payment(INTENT)
        self.assertTrue(f.payment_projection(raw,ORDER,4585,j.digest(CARD),'2342')['paid'])
        for key,value in [('reference','FOTHER'),('currency_code','USD'),('amount',45.86),
                          ('cc_masked','****5542'),('cc_masked','****9546'),('id_token','162')]:
            with self.subTest(key=key),self.assertRaises(j.JournalError):
                f.payment_projection({**raw,key:value},ORDER,4585,j.digest(CARD),'2342')
        for key,value in [('captured_amount',1),('authorized_amount',1),('transaction_status','AUTHORIZED'),
                          ('error_code','1'),('refunded_amount',1),('reversed_amount',1)]:
            self.assertFalse(f.payment_projection({**raw,key:value},ORDER,4585,j.digest(CARD),'2342')['paid'])

    def test_capture_with_other_supported_card_stays_held(self):
        self.co.place();self.reader.capture();self.reader.order_data['accepted']=True
        self.reader.payment_data['cc_masked']='****9546'
        result=self.co.recover()
        self.assertFalse(result['paid'])
        self.assertTrue(result['tracker']['held'])
        self.assertNotEqual(j.inspect(self.flow)['state'],'COMPLETE')
        with self.assertRaisesRegex(j.JournalError,'CARD_MISMATCH'):
            self.co.complete_payment()
        self.assertEqual(len(self.calls),1)

    def test_visa_capture_requires_matching_bound_card(self):
        self.reader.capture();raw=self.reader.payment(INTENT)
        raw['cc_masked']='****9546'
        self.assertTrue(f.payment_projection(raw,ORDER,4585,j.digest(CARD),'9546')['paid'])
        for last4 in ('2342', None, '5542'):
            with self.subTest(last4=last4),self.assertRaises(j.JournalError):
                f.payment_projection(raw,ORDER,4585,j.digest(CARD),last4)

    def test_native_adapter_does_not_guess_unpaid_contract(self):
        self.assertFalse(recovery.NativeReader.__new__(recovery.NativeReader).continuation_verified({},{}))

    def test_food_paid_reconciliation_cannot_lift_nonfinancial_fence(self):
        j.consume(self.flow,'cart',kind='cart',request_hash='e'*64)
        j.observe(self.flow,'cart',outcome='UNKNOWN',evidence_hash='e'*64)
        with self.assertRaises(j.JournalError):j.reconcile_food_paid(self.flow,evidence_hash='a'*64)


class NativeOrderTests(unittest.TestCase):
    def fixture(self):
        flow=SimpleNamespace(account=fingerprint('synthetic-customer'),scope='b'*64,outlet='OUTLET1',
            headers={'x-addresscode':'ADDRESS','x-addresskey':'ADDRESS-1'},
            rows=food.manifest([{'item_code':'I1','qty':1,'modifiers':{'MD1':{'I2':1}},'notes':'Extra crispy'}]))
        state={'review':{'card_last4':'2342','payable_minor':4585},'card_hash':j.digest(CARD)}
        raw={'orderNr':ORDER,'customerCode':'synthetic-customer','outletInfo':{'outletCode':'OUTLET1'},
            'addressCode':'ADDRESS','addressVersion':1,'items':flow.rows,'currencyCode':'AED',
            'orderTotal':45.85,'orderPaymentAmount':45.85,'orderWalletAmount':0,
            'creditCardMask':'****2342','paymentMethodCode':'prepaid','prepaidPaymentMethodCode':'cc_noonpay',
            'paymentProviderCode':'NOON_PAY','deliveryPreferenceInfo':[{'code':k,'choice':True} for k in food.QUIET],
            'driverNotes':food.QUIET_NOTE,'paymentClientSecret':INTENT,'orderStatusCode':'delivered'}
        return flow,state,raw

    def test_nov9_captured_automatic_payment_shape(self):
        captured=json.loads((Path(__file__).parent/'fixture_food_automatic_20261109.json').read_text())
        flow,state,raw=self.fixture()
        state['review'].update(card_last4=captured['card_last4'],payable_minor=17280)
        raw.update({k:captured[k] for k in ('orderStatusCode','outletStatusCode','orderTotal','orderPaymentAmount','orderWalletAmount','paymentProcessedAt')})
        raw.update(creditCardMask='****9546',paymentClientSecret=None,miscInfo={'isPaymentAutoCapture':captured['automatic_capture']},
                   orderRefundToWallet=0,orderIssuedCredit=0,orderAdjustments=0,failedErrorMsg=None)
        reader=recovery.NativeReader.__new__(recovery.NativeReader)
        reader.flow=flow;reader.state=state;reader.session_data={}
        with patch.object(recovery.vertical,'_read',return_value=raw),patch.object(recovery.vertical,'_food_data',side_effect=lambda v:v):
            self.assertTrue(reader.order(ORDER)['automatic_payment_processed'])
            raw['paymentClientSecret']='unexpected-intent'
            self.assertFalse(reader.order(ORDER)['automatic_payment_processed'])

    def test_native_order_projection_and_mismatch_guards(self):
        flow,state,raw=self.fixture()
        self.assertTrue(recovery.project_order(raw,ORDER,flow,state)['accepted'])
        for key,value in [('orderNr','FOTHER'),('customerCode','other'),('outletInfo',{}),('addressVersion',2),
                          ('items',[]),('orderTotal',46),('orderWalletAmount',1),('creditCardMask','****5542'),
                          ('driverNotes',''),('deliveryPreferenceInfo',[])]:
            with self.subTest(key=key),self.assertRaises(j.JournalError):
                recovery.project_order({**raw,key:value},ORDER,flow,state)

    def test_unknown_order_acceptance_is_not_inferred_from_paid(self):
        flow,state,raw=self.fixture();raw['orderStatusCode']='unseen_state'
        self.assertFalse(recovery.project_order(raw,ORDER,flow,state)['accepted'])

    def test_observed_early_acceptance_requires_both_statuses(self):
        flow,state,raw=self.fixture()
        raw.update(orderStatusCode='accepted',outletStatusCode='accepted')
        self.assertTrue(recovery.project_order(raw,ORDER,flow,state)['accepted'])
        raw['outletStatusCode']='not_synced'
        self.assertFalse(recovery.project_order(raw,ORDER,flow,state)['accepted'])

    def test_automatic_native_processing_requires_observed_fields(self):
        flow,state,raw=self.fixture()
        state['card_hash']=j.digest(CARD)
        reader=recovery.NativeReader.__new__(recovery.NativeReader)
        reader.flow=flow;reader.state=state
        reader.session_data={'paymentRequireCompletion':False,'paymentRequireCvv':False,
            'paymentToken':CARD,'orderPaymentFinalTotal':45.85}
        raw.update(orderStatusCode='accepted',outletStatusCode='accepted',paymentClientSecret=None,
            paymentProcessedAt='2026-11-07T21:46:25',miscInfo={'isPaymentAutoCapture':True},
            orderRefundToWallet=0,orderIssuedCredit=0,orderAdjustments=0,failedErrorMsg=None)
        with patch.object(recovery.vertical,'_read',return_value=raw),\
             patch.object(recovery.vertical,'_food_data',side_effect=lambda value:value):
            self.assertTrue(reader.order(ORDER)['automatic_payment_processed'])
            self.assertIs(reader.order(ORDER)['cvv_required'], False)
            reader.session_data['paymentRequireCvv']=True
            raw.pop('paymentRequireCvv', None)
            self.assertIs(reader.order(ORDER)['cvv_required'], True)
            raw['paymentRequireCvv']=False
            self.assertIsNone(reader.order(ORDER)['cvv_required'])
            reader.session_data['paymentRequireCvv']=False
            for key in ('paymentRequireCompletion','paymentRequireCvv'):
                for value in (None,0,'false',True):
                    reader.session_data[key]=value
                    self.assertFalse(reader.order(ORDER)['automatic_payment_processed'])
                reader.session_data[key]=False
            for key,value in (('paymentProcessedAt',None),('failedErrorMsg','failed'),('orderAdjustments',1),
                              ('paymentClientSecret',INTENT),('miscInfo',{})):
                old=raw[key];raw[key]=value
                self.assertFalse(reader.order(ORDER)['automatic_payment_processed'])
                raw[key]=old

    def test_native_session_binding_preserves_all_preparation_guards(self):
        flow=food.FoodFlow.__new__(food.FoodFlow);flow.card_last4='2342'
        flow.outlet='OUTLET1';flow.account='a'*64;flow.scope='b'*64
        flow.headers={'x-addresscode':'ADDRESS','x-addresskey':'ADDRESS-1'}
        flow.rows=food.manifest([{'item_code':'I1'}]);flow.state={'session':'SESSION1'}
        data={'checkoutSessionCode':'SESSION1','outletCode':'OUTLET1','addressCode':'ADDRESS','addressVersion':1,
            'items':flow.rows,'deliveryPreferenceInfo':[{'code':k,'value':True} for k in food.QUIET],
            'driverNotes':food.QUIET_NOTE,'creditCardMask':'****2342','paymentMethodCode':'prepaid',
            'prepaidPaymentMethodCode':'cc_noonpay','orderWalletAmount':0,'orderPaymentAmount':45.85,'orderTotal':45.85,
            'paymentToken':CARD,'orderPaymentFinalTotal':45.85}
        review=flow.review(data)
        reader=recovery.NativeReader.__new__(recovery.NativeReader);reader.flow_id='synthetic'
        reader.state={'outlet':flow.outlet,'items':flow.rows,'session':'SESSION1',
            'review':review,'review_hash':j.digest(review),'card_hash':j.digest(CARD)}
        flow.read=lambda:data
        with patch.object(recovery.vertical,'food_orders',return_value={'orders':[]}),patch.object(food,'FoodFlow',return_value=flow),patch.object(food,'request',side_effect=lambda *a:data),patch.object(j,'inspect',return_value={
                'operations':[{'name':'set_payment_method','state':'OBSERVED','kind':'cart'}]}):
            self.assertIsNone(reader.session()['order_id'])
            data['orderNr']=ORDER
            self.assertEqual(reader.session()['order_id'],ORDER)
            data['paymentToken']='other'
            with self.assertRaisesRegex(j.JournalError,'FOOD_FRESH_CARD_TOKEN_CHANGED'):reader.session()
            data['paymentToken']=CARD
            data['orderTotal']=46
            with self.assertRaises(j.JournalError):reader.session()

    def test_financial_recovery_cli_dispatch_never_calls_preparation(self):
        with patch.object(j,'binding',return_value={'app':'noon','vertical':'food'}),\
             patch.object(j,'inspect',return_value={'operations':[{'kind':'place'}]}),\
             patch.object(recovery,'NativeReader') as reader,patch.object(recovery,'TrackerRegistrar'),\
             patch.object(f,'Coordinator') as coordinator,patch.object(food,'FoodFlow') as prep:
            coordinator.return_value.recover.return_value={'financial_send':False}
            self.assertEqual(food.recover('synthetic'),{'financial_send':False})
            reader.assert_called_once_with('synthetic');prep.assert_not_called()


class RegistrarTests(unittest.TestCase):
    def test_registration_requires_receipt_exact_config_watcher_and_hold(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(Path,'home',return_value=Path(temp)):
            root=Path(temp);name='order-noon-'+ORDER.lower()
            config={'app':'noon','order':ORDER,'watcher':name,'vertical':'food','delivery_card':{'held':True}}
            cfgpath=root/'.local/state/order-tracker/orders'/f'{name}.json'
            watchpath=root/'.local/share/robob-watch/watchers'/name/'watcher.json'
            cfgpath.parent.mkdir(parents=True);watchpath.parent.mkdir(parents=True)
            cfgpath.write_text(json.dumps(config));watchpath.write_text(json.dumps({'id':name}))
            reader=SimpleNamespace(flow_id='synthetic',state={'review':{'store':'Restaurant'}})
            registrar=recovery.TrackerRegistrar(reader)
            receipt={'tracker_id':name,'watcher_registered':True,'moni_notified':'skipped','delivery_card':{'status':'sent'}}
            result=SimpleNamespace(returncode=0,stdout=json.dumps(receipt).encode())
            with patch.object(j,'inspect',return_value={'order_id':ORDER,'reserved_minor':4585}),\
                 patch.object(recovery.subprocess,'run',return_value=result) as run:
                self.assertTrue(registrar(ORDER,paid=False)['registered'])
                self.assertIn('--hold-placed-text',run.call_args.args[0])
                with self.assertRaises(j.JournalError):registrar(ORDER,paid=True)
                config['delivery_card']['held']=False;cfgpath.write_text(json.dumps(config))
                self.assertTrue(registrar(ORDER,paid=True)['registered'])
                self.assertIn('--payment-confirmed',run.call_args.args[0])
                result.stdout=json.dumps({**receipt,'watcher_registered':False}).encode()
                with self.assertRaises(j.JournalError):registrar(ORDER,paid=True)
                result.stdout=json.dumps(receipt).encode();config['order']='FOTHER';cfgpath.write_text(json.dumps(config))
                with self.assertRaises(j.JournalError):registrar(ORDER,paid=True)


if __name__=='__main__':unittest.main()
