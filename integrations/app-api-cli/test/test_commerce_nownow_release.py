import copy
import time
from unittest.mock import patch

import commerce_journal as j
import commerce_nownow_release as r
from noon_nownow_checkout import Snapshot
from test import test_commerce_preorder_release as fixtures


class NowNowReleaseTests(fixtures.ReleaseTests):
    def setUp(self):
        super().setUp()
        self.state['review']={'digest':'5'*64,'payable_minor':2670,
                              'projection':{'session':'SESSION','store':'STORE'}}
        self.history={'data':{'orders':[{'orderNr':'NNOLDER','customerCode':'customer','createdAt':'2020-01-01T10:00:00','timeZone':'+04:00'}]}}
        with j._db() as db:
            db.execute('UPDATE flows SET created_at=? WHERE id=?',(time.time()-25*3600,self.flow))

    def release_new(self, dry_run=False):
        def call(operation, payload, timeout, **kwargs):
            return Snapshot(self.data if operation=='payment_status' else self.history,{},time.time())
        self.client._call.side_effect=call
        with patch.object(r,'load',return_value=self.state), patch.object(r,'reader',return_value=self.client):
            return r.release(self.flow,vault=self.vault,dry_run=dry_run)

    def test_expired_zero_capture_no_order_releases_and_never_reuses(self):
        before=j.inspect(self.flow)
        dry=self.release_new(dry_run=True)
        self.assertTrue(dry['eligible']);self.assertEqual(j.inspect(self.flow),before)
        result=self.release_new()
        self.assertEqual(result['state'],'RELEASED')
        self.assertFalse(result['retry_allowed'])
        self.assertEqual(j.inspect(self.flow)['operations'],before['operations'])
        with self.assertRaises(j.JournalError):j.consume(self.flow,'complete_again',kind='cart',request_hash='3'*64)

    def test_evidence_refusal_matrix(self):
        original=copy.deepcopy(self.data)
        for mutation in [dict(status='payment_ready_to_redirect'),dict(captured_amount=1),
                         dict(authorized_amount=1),dict(captured_amount=None),
                         dict(redirect_url='https://bank.example'),dict(transaction_status='PENDING')]:
            with self.subTest(mutation=mutation):
                self.data={**original,**mutation}
                with self.assertRaisesRegex(j.JournalError,'RELEASE_NOWNOW_EVIDENCE_INVALID'):self.release_new()
                self.assertEqual(j.inspect(self.flow)['state'],'FENCED')
        self.data=original
        for key in ['authorized_amount','captured_amount','currency_code','customer_code','id_token']:
            with self.subTest(missing=key):
                self.data=dict(original);self.data.pop(key)
                with self.assertRaisesRegex(j.JournalError,'RELEASE_NOWNOW_EVIDENCE_INVALID'):self.release_new()
        self.data=original

    def test_history_missing_truncated_exact_session_and_equal_amount_refuse(self):
        original=copy.deepcopy(self.history)
        current={'orderNr':'NNNEW','createdAt':time.time(),'customerCode':'customer',
                 'orderTotal':26.70,'storeInfo':{'storeCode':'STORE'}}
        for history in [{'data':{}},{'data':{'orders':[]}}, {'data':{'orders':[current]}},
                        {'data':{'orders':[current]+original['data']['orders']}},
                        {'data':{'orders':[{**current,'orderTotal':1,'checkoutSessionCode':'SESSION'}]+original['data']['orders']}}]:
            with self.subTest(history=history):
                self.history=history
                with self.assertRaisesRegex(j.JournalError,'RELEASE_NOWNOW_EVIDENCE_INVALID'):self.release_new()
                self.assertEqual(j.inspect(self.flow)['state'],'FENCED')

    def test_not_expired_and_wrong_stage_named_codes(self):
        with j._db() as db:db.execute('UPDATE flows SET created_at=? WHERE id=?',(time.time(),self.flow))
        with self.assertRaisesRegex(j.JournalError,'RELEASE_NOWNOW_CHALLENGE_NOT_EXPIRED'):self.release_new()
        with j._db() as db:db.execute("UPDATE observations SET outcome='UNKNOWN' WHERE outcome='CHALLENGE_REQUIRED'")
        with self.assertRaisesRegex(j.JournalError,'RELEASE_NOWNOW_WRONG_STAGE'):self.release_new()

    def test_cli_dry_run_never_closes_other_lanes(self):
        import commerce_cli
        from types import SimpleNamespace
        for lane in ('minutes','main','supermall','food'):
            with self.subTest(lane=lane),patch.object(j,'binding',return_value={'app':'noon','vertical':lane}), \
                 patch.object(j,'release',side_effect=AssertionError('must not close')):
                with self.assertRaisesRegex(j.JournalError,'RELEASE_DRY_RUN_NOWNOW_ONLY'):
                    commerce_cli.release_flow(SimpleNamespace(flow_id=self.flow,dry_run=True))

    def test_terminal_expired_and_cancelled_intents(self):
        for status,transaction in [('payment_expired','EXPIRED'),('payment_cancelled','CANCELLED')]:
            with self.subTest(status=status):
                self.data.update(status=status,transaction_status=transaction)
                self.assertTrue(self.release_new(dry_run=True)['eligible'])

    def test_old_row_reference_and_account_matrix_cannot_prove_no_order(self):
        original=copy.deepcopy(self.history)
        for mutation in [{'checkoutSessionCode':'SESSION'},{'sessionCode':'SESSION'}, {'orderRef':'SESSION'},
                         {'customerCode':None},{'customerCode':'foreign'},{'orderNr':None}]:
            with self.subTest(mutation=mutation):
                self.history=copy.deepcopy(original)
                self.history['data']['orders'][0].update(mutation)
                with self.assertRaisesRegex(j.JournalError,'RELEASE_NOWNOW_EVIDENCE_INVALID'):self.release_new(dry_run=True)

    def test_native_history_time_input_matrix(self):
        expected=1794326400.0
        for value,zone in [('2026-11-10T20:00:00','+04:00'),('2026-11-10T16:00:00Z',None),
                           ('2026-11-10T20:00:00+04:00',None),(expected,None),(expected+0.0,None)]:
            with self.subTest(value=value,zone=zone):self.assertEqual(r.timestamp(value,zone),expected)
        for value,zone in [(None,None),(True,None),(float('nan'),None),(float('inf'),None),
                           ('2026-11-10T20:00:00',None),('bad-date','+04:00')]:
            with self.subTest(value=value,zone=zone),self.assertRaisesRegex(j.JournalError,'RELEASE_NOWNOW_EVIDENCE_INVALID'):
                r.timestamp(value,zone)

    def test_dry_run_reads_schema_three_without_migrating_direct_or_cli(self):
        import hashlib
        import sqlite3
        import commerce_cli
        from types import SimpleNamespace
        with j._db() as db:
            db.execute('DROP TABLE baskets');db.execute('DROP INDEX active_account')
            db.execute(j.SCHEMA_V3['active_account']);db.execute('PRAGMA user_version=3')
        path=j.ROOT/'journal.sqlite'
        before=hashlib.sha256(path.read_bytes()).hexdigest()
        self.assertTrue(self.release_new(dry_run=True)['eligible'])
        def call(operation,payload,timeout,**kwargs):
            return Snapshot(self.data if operation=='payment_status' else self.history,{},time.time())
        self.client._call.side_effect=call
        with patch.object(r,'load',return_value=self.state),patch.object(r,'reader',return_value=self.client), \
             patch.object(r,'IntentVault',return_value=self.vault):
            self.assertTrue(commerce_cli.release_flow(SimpleNamespace(flow_id=self.flow,dry_run=True))['eligible'])
        self.assertEqual(before,hashlib.sha256(path.read_bytes()).hexdigest())
        with sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True) as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0],3)

    def test_rejected_native_response_matrix_is_not_release_evidence(self):
        original_data=copy.deepcopy(self.data);original_history=copy.deepcopy(self.history)
        for source in ('payment','history','history_data'):
            for rejection in ({'success':False},{'error':'rejected'},{'errors':['rejected']},{'error_modal':{'message':'rejected'}}):
                with self.subTest(source=source,rejection=rejection):
                    self.data={**original_data,**rejection} if source=='payment' else copy.deepcopy(original_data)
                    self.history={**original_history,**rejection} if source=='history' else copy.deepcopy(original_history)
                    if source=='history_data':self.history['data'].update(rejection)
                    with self.assertRaisesRegex(j.JournalError,'RELEASE_NOWNOW_EVIDENCE_INVALID'):
                        self.release_new(dry_run=True)
                    self.assertEqual(j.inspect(self.flow)['state'],'FENCED')
        self.data=original_data;self.history=original_history
