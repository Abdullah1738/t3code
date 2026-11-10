import os
import tempfile
os.environ['ORDERING_PAUSE_FILE'] = os.path.join(tempfile.gettempdir(), 'ordering-pause-test-absent', 'ordering-paused')
import contextlib
import copy
import io
import json
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import commerce_cli as cli
import commerce_food as food
import commerce_food_capture as capture
import commerce_journal as j
import noon_food_financial as financial
import noon_food_recovery as recovery

ORDER = 'FSYNTHETIC1'
PLACED = 1794073580


class CaptureCloseTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()/'commerce'
        for module in (j, food):
            p = patch.object(module, 'ROOT', self.root if module is j else self.root/'food')
            p.start(); self.addCleanup(p.stop)
        self.flow = str(uuid.uuid4())
        self.account = 'a'*64
        j.open_flow(flow_id=self.flow, app='noon', vertical='food', account_hash=self.account, scope_hash='b'*64)
        (self.root/'food').mkdir(mode=0o700)
        (self.root/'food'/(self.flow+'.json')).write_text(json.dumps({'review':{'card_last4':'2342'}}))
        self.record = dict(session_id='SESSION1', review_hash='c'*64, amount_minor=11590,
                           card_hash=j.digest('161'), cart_hash=j.digest('SESSION1'))
        path = self.root/'food-financial'; path.mkdir(mode=0o700,exist_ok=True)
        self.path = path/(self.flow+'.json'); self.save_record()
        with patch.object(j.time, 'time', return_value=PLACED):
            j.consume(self.flow, 'place', kind='place', request_hash=j.digest(financial.place_payload('SESSION1', 11590)),
                      cart_hash=self.record['cart_hash'], review_hash='c'*64, payable_minor=11590)
            j.observe(self.flow, 'place', outcome='ORDER_ID_RECEIVED', evidence_hash=j.digest(ORDER), order_id=ORDER)
            j.observe(self.flow, 'place', outcome='UNKNOWN', evidence_hash=j.digest('automatic unverified'))
        self.bank = dict(source='msgs', source_id=1234, sender='EmiratesNBD', timestamp=PLACED+9,
                         **capture.parse_purchase('Purchase of AED 115.90 with Credit Card ending 2342 at Noon, Dubai.'))
        self.automatic = dict(order=ORDER, account_hash=self.account, scope_hash='b'*64, amount_minor=11590,
                              card_hash=j.digest('161'), payment_client_secret_null=True,
                              automatic_capture=True, processed_at='2026-11-07T21:46:25')
        self.tracking = dict(ok=True, app='noon', service='food', order=ORDER, scope='order',
                             source='native_order_api', identity_verified=True, account_verified=True,
                             saved_home_verified=True, raw_status='delivered', status='delivered',
                             automatic_payment=self.automatic)

    def test_mashreq_exact_card_amount_and_sender(self):
        text='Your Mashreq noon Card ending with 9546 was used for a purchase of AED 172.80 at Noon 80038888 AE on 09-NOV-2026 05:48 PM.'
        bank=dict(source='msgs',source_id=516800,sender='MashreqAlerts@mashreq.com',
                  timestamp=1794232140,**capture.parse_purchase(text))
        capture.validate_bank(bank,17280,1794232131,'9546')
        for change in ({'card_last4':'2342'},{'amount_minor':6780},{'sender':'someone@example.com'}):
            with self.assertRaises(j.JournalError):capture.validate_bank({**bank,**change},17280,1794232131,'9546')
        with self.assertRaises(j.JournalError):capture.validate_bank(bank,17280,1794232131,'2342')

    def test_bank_read_failure_cannot_prove_uniqueness(self):
        rows=[{'id':1234,'ts':PLACED+9},{'id':1235,'ts':PLACED+10}]
        result=SimpleNamespace(stdout='\n'.join(json.dumps(r) for r in rows))
        with patch.object(capture.subprocess,'run',return_value=result),patch.object(capture,'bank_message',
                side_effect=[self.bank,j.JournalError('FOOD_CAPTURE_CLOSE_BANK_READ_FAILED')]):
            with self.assertRaisesRegex(j.JournalError,'BANK_READ_FAILED'):
                capture.find_bank_capture(PLACED,11590,'2342')
        with patch.object(capture.subprocess,'run',return_value=result),patch.object(capture,'bank_message',
                side_effect=[self.bank,{**self.bank,**capture.parse_purchase('Purchase of AED 9.00 with Credit Card ending 2342 at Noon, Dubai.')}]):
            self.assertEqual(capture.find_bank_capture(PLACED,11590,'2342')['source_id'],1234)

    def test_malformed_bank_candidate_prevents_capture(self):
        rows=[{'id':1234,'ts':PLACED+9},{'id':1235,'ts':None}]
        result=SimpleNamespace(stdout='\n'.join(json.dumps(r) for r in rows))
        with patch.object(capture.subprocess,'run',return_value=result),patch.object(capture,'bank_message',return_value=self.bank):
            with self.assertRaisesRegex(j.JournalError,'BANK_SEARCH_ROW_INVALID'):
                capture.find_bank_capture(PLACED,11590,'2342')
        placed=1794232131
        text='Your Mashreq noon Card ending with 9546 was used for a purchase of AED 172.80 at Noon 80038888 AE on 09-NOV-2026 05:48 PM.'
        bank=dict(source='msgs',source_id=1234,sender='MashreqAlerts@mashreq.com',timestamp=placed+9,**capture.parse_purchase(text))
        bad={**bank,'source_id':1235,**capture.parse_purchase(text.replace('09-NOV','99-NOV'))}
        rows=[{'id':1234,'ts':placed+9},{'id':1235,'ts':placed+10}]
        result.stdout='\n'.join(json.dumps(r) for r in rows)
        with patch.object(capture.subprocess,'run',return_value=result),patch.object(capture,'bank_message',side_effect=[bank,bad]):
            with self.assertRaisesRegex(j.JournalError,'BANK_TIME_UNPARSEABLE'):
                capture.find_bank_capture(placed,17280,'9546')

    def save_record(self):
        self.path.write_text(json.dumps(self.record)); self.path.chmod(0o600)

    def kwargs(self):
        return dict(order_id=ORDER, reserved_minor=11590, bank_evidence=self.bank,
                    tracking_evidence=self.tracking, attested_by=None)

    def close(self, **kw):
        return j.close_food_automatic_captured(self.flow, **{**self.kwargs(), **kw})

    def test_close_lifts_prepare_fence_preserves_consumed_sends_and_audit(self):
        before = j.inspect(self.flow)
        with self.assertRaisesRegex(j.JournalError, 'JOURNAL_ACCOUNT_RECONCILIATION_REQUIRED'):
            j.require_account_available('noon', self.account)
        with patch.object(j, 'consume', side_effect=AssertionError('no sends')):
            result = self.close()
        self.assertEqual(result['state'], 'COMPLETE')
        self.assertTrue(j.require_account_available('noon', self.account))
        after = j.inspect(self.flow)
        for key in ('operations', 'reserved_minor', 'order_id'):
            self.assertEqual(before[key], after[key])
        self.assertEqual(after['owner_attestation']['provider_evidence']['bank'], self.bank)
        self.assertEqual(after['owner_attestation']['evidence_hash'], result['evidence_hash'])
        j.open_flow(flow_id=str(uuid.uuid4()), app='noon', vertical='food', account_hash=self.account, scope_hash='d'*64)
        with self.assertRaises(j.JournalError):
            j.consume(self.flow, 'anything', kind='cart', request_hash='a'*64)
        with self.assertRaises(j.JournalError):
            j.observe(self.flow, 'place', outcome='RESPONSE_RECEIVED', evidence_hash='a'*64)
        remaining = j.open_payments(since_seconds=1e10)
        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0]['state'], 'ACTIVE')
        self.assertFalse(remaining[0]['financial_send'])

    def test_active_delivered_automatic_flow_can_close(self):
        with j._db() as db:db.execute("UPDATE flows SET state='ACTIVE' WHERE id=?",(self.flow,))
        self.assertEqual(self.close()['state'],'COMPLETE')

    def test_idempotent_and_conflicting_repeat(self):
        first = self.close()
        second = self.close()
        self.assertTrue(second['already_closed'])
        self.assertEqual(first['attested_at'], second['attested_at'])
        self.assertEqual(first['evidence_hash'], second['evidence_hash'])
        self.bank['source_id'] += 1
        with self.assertRaisesRegex(j.JournalError, 'FOOD_CAPTURE_CLOSE_EVIDENCE_CONFLICT'):
            self.close()
        with j._db() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM owner_attestations').fetchone()[0], 1)

    def test_bank_rejections(self):
        rows = [('amount_minor', 1, 'AMOUNT_MISMATCH'), ('card_last4', '5542', 'CARD_MISMATCH'),
                ('merchant', 'Careem, Dubai', 'MERCHANT_MISMATCH'),
                ('timestamp', PLACED-1, 'BANK_TIME_INVALID'), ('timestamp', PLACED, 'BANK_TIME_INVALID'),
                ('timestamp', PLACED+1801, 'BANK_TIME_INVALID'), ('timestamp', True, 'BANK_TIME_INVALID'),
                ('sender', 'OtherBank', 'BANK_SENDER_INVALID'), ('source_id', None, 'BANK_SOURCE_INVALID'),
                ('source_id', True, 'BANK_SOURCE_INVALID'), ('source', 'chat', 'BANK_SOURCE_INVALID')]
        for key, value, code in rows:
            with self.subTest(key=key, value=value):
                bank = {**self.bank, key:value}
                if key in ('amount_minor','card_last4','merchant'):
                    bank['evidence'] = f"Purchase of AED {bank['amount_minor']/100:.2f} with Credit Card ending {bank['card_last4']} at {bank['merchant']}."
                with self.assertRaisesRegex(j.JournalError, 'FOOD_CAPTURE_CLOSE_'+code):
                    self.close(bank_evidence=bank)
        self.assertEqual(j.inspect(self.flow)['state'], 'FENCED')

    def test_time_upper_boundary_accepted(self):
        self.bank['timestamp'] = PLACED+1800
        self.close()

    def test_missing_or_inconsistent_text_refused_even_for_owner(self):
        for text in ('', 'Refund of AED 115.90', self.bank['evidence'].replace('115.90', '11.59')):
            with self.subTest(text=text), self.assertRaises(j.JournalError):
                self.close(bank_evidence={**self.bank,'evidence':text}, attested_by='owner')
        with self.assertRaises(j.JournalError): self.close(bank_evidence=None, attested_by='owner')
        with self.assertRaisesRegex(j.JournalError, 'ATTESTER_INVALID'): self.close(attested_by='agent')

    def test_delivery_and_automatic_rejections(self):
        for key, value in [('status','preparing'), ('raw_status','preparing'), ('order','FOTHER'),
                           ('identity_verified',False), ('account_verified',False), ('saved_home_verified',False),
                           ('source','history'), ('service','minutes'), ('ok',False), ('scope','shipment')]:
            with self.subTest(key=key), self.assertRaisesRegex(j.JournalError, 'DELIVERY_UNVERIFIED'):
                self.close(tracking_evidence={**self.tracking,key:value})
        for key, value in [('payment_client_secret_null',False), ('automatic_capture',False), ('order','FOTHER'),
                           ('card_hash','d'*64), ('scope_hash','d'*64), ('account_hash','d'*64), ('processed_at',None)]:
            automatic = {**self.automatic,key:value}
            with self.subTest(key=key), self.assertRaisesRegex(j.JournalError,'AUTOMATIC_PATH_REQUIRED'):
                self.close(tracking_evidence={**self.tracking,'automatic_payment':automatic})

    def test_local_rejections(self):
        for kw, code in [({'order_id':'FOTHER'}, 'ORDER_MISMATCH'), ({'reserved_minor':1},'AMOUNT_MISMATCH'),
                         ({'reserved_minor':True},'AMOUNT_MISMATCH')]:
            with self.subTest(kw=kw), self.assertRaisesRegex(j.JournalError, code): self.close(**kw)
        for key,value,code in [('vertical','minutes','FOOD_FLOW_REQUIRED'), ('app','talabat','FOOD_FLOW_REQUIRED'),
                               ('state','RELEASED','FENCED_FLOW_REQUIRED')]:
            with j._db() as db: db.execute('UPDATE flows SET '+key+'=? WHERE id=?',(value,self.flow))
            with self.assertRaisesRegex(j.JournalError,code): self.close()
            with j._db() as db: db.execute('UPDATE flows SET '+key+'=? WHERE id=?',({'vertical':'food','app':'noon','state':'FENCED'}[key],self.flow))
        self.record['intent_hash'] = j.digest('intent'); self.save_record()
        with self.assertRaisesRegex(j.JournalError,'AUTOMATIC_PATH_REQUIRED'): self.close()

    def test_completion_consumed_even_unknown_or_misnamed_refused(self):
        for name,kind in [('payment','payment'),('payment_complete','selection'),('prepay','prepay')]:
            with self.subTest(name=name):
                with j._db() as db:
                    db.execute('INSERT INTO operations VALUES (?,?,?,?,?,?)',(self.flow,name,kind,'d'*64,'MAY_HAVE_SENT',PLACED+1))
                with self.assertRaisesRegex(j.JournalError,'PAYMENT_ALREADY_SENT'): self.close()
                with j._db() as db: db.execute('DELETE FROM operations WHERE name=?',(name,))

    def test_cli_dry_run_then_confirm_under_ordering_pause(self):
        self.root.joinpath('pause').touch()
        raw = {k:v for k,v in self.tracking.items() if k!='automatic_payment'}
        args = ['close-food-captured', self.flow, '--bank-msg-id','1234']
        with patch.object(capture,'bank_message',return_value=self.bank), patch.object(capture,'automatic_order',return_value=self.automatic), \
             patch.object(cli,'track_exact',return_value=raw) as track, patch.object(cli,'PAUSE_FILE',self.root/'pause'):
            output=io.StringIO()
            with contextlib.redirect_stdout(output): self.assertEqual(cli.main(args),0)
            result=json.loads(output.getvalue()); self.assertTrue(result['dry_run'])
            self.assertEqual(result['to_state'],'COMPLETE')
            self.assertEqual(j.inspect(self.flow)['state'],'FENCED')
            track.assert_called_once_with('noon','food',ORDER)
            with contextlib.redirect_stdout(io.StringIO()): self.assertEqual(cli.main(args+['--confirm']),0)
        self.assertEqual(j.inspect(self.flow)['state'],'COMPLETE')
        with patch.object(food,'FoodFlow',side_effect=AssertionError('no reads/writes needed')):
            self.assertEqual(food.recover(self.flow)['state'],'COMPLETE')

    def test_bank_cli_json_record_binds_id_and_drops_balance(self):
        row=dict(id=1234,source='imessage',from_me=0,sender='EmiratesNBD',ts=PLACED+9,deleted_at=None,
                 snip=self.bank['evidence']+' Avl Cr. Limit is AED 5,785.23')
        shown=f">   1234 2026-11-07 21:46 EmiratesNBD: {row['snip']}\n"
        def run_cli(command, **kwargs):
            return SimpleNamespace(stdout=json.dumps(row) if command[1]=='search' else shown)
        with patch.object(capture.subprocess,'run',side_effect=run_cli) as run:
            self.assertEqual(capture.bank_message(1234,PLACED),self.bank)
            self.assertIn('--json',run.call_args_list[0].args[0])
            with self.assertRaisesRegex(j.JournalError,'BANK_MESSAGE_NOT_FOUND'): capture.bank_message(5678,PLACED)
        for field,value in [('from_me',1),('deleted_at',PLACED),('source','email')]:
            with patch.object(capture.subprocess,'run',return_value=SimpleNamespace(stdout=json.dumps({**row,field:value}))), \
                 self.assertRaisesRegex(j.JournalError,'BANK_SOURCE_INVALID'):
                capture.bank_message(1234,PLACED)

    def test_purchase_forms(self):
        rows=[('115.90','11590'),('1,115.90','111590'),('0.01','1')]
        for amount,expected in rows:
            with self.subTest(amount=amount):
                self.assertEqual(capture.parse_purchase(f'Purchase of AED {amount} with Credit Card ending 2342 at Noon, Dubai.')['amount_minor'],int(expected))
        for text in ('Purchase of AED 115.9 with Credit Card ending 2342 at Noon.',
                     'Purchase of USD 115.90 with Credit Card ending 2342 at Noon.',
                     'Refund of AED 115.90 with Credit Card ending 2342 at Noon.'):
            with self.subTest(text=text), self.assertRaises(j.JournalError): capture.parse_purchase(text)

    def test_recovery_error_names_sanctioned_close(self):
        reader=object.__new__(recovery.NativeReader)
        reader.flow_id=self.flow
        reader.state={'items':[dict(itemCode='ITEM',qty=1,modifiers={},notes=None)],'outlet':'OUTLET'}
        flow=Mock(); flow.read.side_effect=j.JournalError('FOOD_RESPONSE_UNVERIFIED')
        with patch.object(food,'FoodFlow',return_value=flow), self.assertRaises(j.PaymentError) as caught:
            reader.session()
        self.assertIn('close-food-captured',caught.exception.details['next'][0])

    def test_native_automatic_detail_numeric_zero_forms_and_missing_secret(self):
        from test.test_noon_food_financial import NativeOrderTests
        import noon_vertical_reads as vertical
        flow,state,raw=NativeOrderTests().fixture()
        state.update(outlet='OUTLET1',items=flow.rows)
        path=self.root/'food'; path.mkdir(mode=0o700,exist_ok=True)
        path.joinpath(self.flow+'.json').write_text(json.dumps(state))
        state['review']['card_last4']='5542'
        path.joinpath(self.flow+'.json').write_text(json.dumps(state))
        with self.assertRaisesRegex(j.JournalError,'CARD_MISMATCH'):
            capture.automatic_order(self.flow,ORDER)
        state['review']['card_last4']='2342'
        path.joinpath(self.flow+'.json').write_text(json.dumps(state))
        raw.update(paymentClientSecret=None,paymentProcessedAt='2026-11-07T21:46:25',
                   miscInfo={'isPaymentAutoCapture':True},orderRefundToWallet=0,
                   orderIssuedCredit=0,orderAdjustments=0,failedErrorMsg=None)
        with patch.object(food,'FoodFlow',return_value=flow), \
             patch.object(vertical,'_read',side_effect=lambda *a:{'status':'success','data':raw}):
            for zero in (0,0.0):
                for key in ('orderRefundToWallet','orderIssuedCredit','orderAdjustments'): raw[key]=zero
                self.assertTrue(capture.automatic_order(self.flow,ORDER)['payment_client_secret_null'])
            for key,value in [('paymentClientSecret','intent'),('paymentProcessedAt',None),('miscInfo',{}),
                              ('orderRefundToWallet',1),('orderIssuedCredit',True),('orderAdjustments','0'),
                              ('failedErrorMsg','failed')]:
                old=raw[key]; raw[key]=value
                with self.subTest(key=key), self.assertRaisesRegex(j.JournalError,'AUTOMATIC_PATH_REQUIRED'):
                    capture.automatic_order(self.flow,ORDER)
                raw[key]=old
            del raw['paymentClientSecret']
            with self.assertRaisesRegex(j.JournalError,'AUTOMATIC_PATH_REQUIRED'):
                capture.automatic_order(self.flow,ORDER)

    def test_evidence_schema_class_rejects_extra_and_missing_fields_without_persistence(self):
        rows=[('bank',capture.BANK_FIELDS,'BANK_SCHEMA_INVALID'),
              ('tracking',capture.TRACKING_FIELDS,'TRACKING_SCHEMA_INVALID'),
              ('automatic',capture.AUTOMATIC_FIELDS,'AUTOMATIC_SCHEMA_INVALID')]
        for level,fields,code in rows:
            for field in [*sorted(fields),'balance','paymentClientSecret','raw_response']:
                bank=copy.deepcopy(self.bank); tracking=copy.deepcopy(self.tracking)
                target={'bank':bank,'tracking':tracking,'automatic':tracking['automatic_payment']}[level]
                if field in fields: del target[field]
                else: target[field]='private-extra-must-not-persist'
                with self.subTest(level=level,field=field), self.assertRaisesRegex(j.JournalError,code):
                    self.close(bank_evidence=bank,tracking_evidence=tracking)
        state=j.inspect(self.flow)
        self.assertEqual(state['state'],'FENCED')
        self.assertNotIn('owner_attestation',state)
        self.assertNotIn(b'private-extra-must-not-persist',(self.root/'journal.sqlite').read_bytes())

    def test_bank_and_merchant_identity_forms(self):
        for sender in ('EmiratesNBD','emiratesnbd',' Emirates NBD '):
            with self.subTest(sender=sender):
                capture.validate_bank({**self.bank,'sender':sender},11590,PLACED)
        for sender in ('Not EmiratesNBD','EmiratesNBD Support','FakeEmiratesNBD','EmiratesNBD.com',''):
            with self.subTest(sender=sender), self.assertRaisesRegex(j.JournalError,'BANK_SENDER_INVALID'):
                self.close(bank_evidence={**self.bank,'sender':sender})
        for merchant,accepted in [('Noon, Dubai',True),('noon',True),('NOON, DUBAI',True),
                                   ('Afternoon Cafe, Dubai',False),('Not Noon',False),('Noonish',False),
                                   ('Noon, London',False),('Noon Support',False)]:
            bank={**self.bank,**capture.parse_purchase(f'Purchase of AED 115.90 with Credit Card ending 2342 at {merchant}.')}
            with self.subTest(merchant=merchant):
                if accepted: capture.validate_bank(bank,11590,PLACED)
                else:
                    with self.assertRaisesRegex(j.JournalError,'MERCHANT_MISMATCH'): self.close(bank_evidence=bank)

    def test_processed_timestamp_class_validates_calendar_in_both_entrypoints(self):
        rows=[('2026-11-07T21:46:25',True),('2028-02-29T00:00:00',True),('2026-12-31T23:59:59',True),
              ('0000-99-99T99:99:99',False),('2026-02-29T12:00:00',False),('2026-13-01T12:00:00',False),
              ('2026-04-31T12:00:00',False),('2026-11-07T24:00:00',False),('2026-11-07T21:60:00',False),
              ('2026-11-07T21:46:60',False),('2026-11-07',False),('2026-11-07T21:46:25+04:00',False)]
        for value,accepted in rows:
            with self.subTest(value=value):
                self.assertEqual(capture.valid_processed_at(value),accepted)
                automatic={**self.automatic,'processed_at':value}
                kw={**self.kwargs(),'tracking_evidence':{**self.tracking,'automatic_payment':automatic}}
                if accepted: j.preview_food_automatic_captured(self.flow,**kw)
                else:
                    with self.assertRaisesRegex(j.JournalError,'AUTOMATIC_PATH_REQUIRED'):
                        j.preview_food_automatic_captured(self.flow,**kw)
