import os as _os, tempfile as _tempfile
# commerce_cli reads the pause file at import; the owner's real one must not refuse test orders.
_os.environ['ORDERING_PAUSE_FILE'] = _os.path.join(_tempfile.gettempdir(), 'ordering-pause-test-absent', 'ordering-paused')
import contextlib
import copy
import datetime as dt
import json
from pathlib import Path
import sqlite3
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import uuid

import commerce_cli as cli
import commerce_journal as journal
import commerce_receipts as receipts
import commerce_talabat_duplicate as d
from commerce_flow import FlowGate, account_hash
from commerce_talabat import intent_scope, TalabatFlow
import talabat_http_checkout as h
import talabat_restaurant_cart as restaurant
from talabat_place_contract import PlaceObservation, parse_response


class DuplicateTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve() / 'commerce'
        for module in (journal, receipts):
            p = patch.object(module, 'ROOT', self.root); p.start(); self.addCleanup(p.stop)
        self.saved = {'expected_profile':{'id':77}}
        self.flow = str(uuid.uuid4())
        self.items = (h.Item(2, 1, '', ()),)
        self.binding = dict(flow_id=self.flow, app='talabat', vertical='restaurants',
                            account_hash=account_hash(self.saved), scope_hash=intent_scope('restaurants', 10, self.items))
        self.store = receipts.create(**self.binding)
        self.gate = FlowGate(**self.binding, receipt_sink=self.store, request_check=lambda _: True)
        record = dict(version=1, app='talabat', flow_id=self.flow, account_binding=self.binding['account_hash'],
                      request_sha256='3'*64, cart_binding=journal.hashlib.sha256(b'123').hexdigest(),
                      review_sha256='5'*64, currency='AED', payable_minor=3645, state='MAY_HAVE_SENT')
        with patch.object(journal.time, 'time', return_value=time.time()-120):
            self.gate.before_talabat({**record, 'operation':'create_cart'})
            self.gate.talabat_receipt(dict(operation='create_cart', state='SUCCEEDED', http_status=200,
                                         cart_id='123', cart_binding=record['cart_binding'],
                                         manifest_sha256=restaurant.manifest_digest(10,self.items)))
            self.gate.before_talabat({**record, 'operation':'place'})
            self.gate.talabat_receipt(dict(operation='place', http_status=400,
                                         observation=PlaceObservation('REJECTED_DUPLICATE', d.REASON)))
        self.auth = Mock()
        self.auth.fresh_before_mutation.return_value.mutation_account.return_value = self.saved
        self.cart = {'branchInfo':{'restaurant':{'branchId':10}}, 'cart':{'id':123, 'items':[
            {'id':124, 'menuItemId':2, 'name':'Iced coffee', 'quantity':1, 'specialRequest':'', 'choices':[], 'choicesDetails':[]}]}}
        self.history = dict(ok=True, account_verified=True, truncated=False, total_orders=1,
                            checked_at=dt.datetime.now(dt.timezone.utc).isoformat(),
                            pagination={'snapshot_changed':False, 'duplicates_omitted':0},
                            orders=[dict(order='100', branch_id=10, native_delivery_date='2026-01-01T01:00:00+00:00')])

    @contextlib.contextmanager
    def provider(self):
        with patch.object(h, '_wire', return_value=h.WireResponse(200, self.cart)) as wire, \
                patch.object(d.history, '_list_orders', return_value=self.history) as history, \
                patch.object(d, 'exact_lines', return_value={'branch_id':10, 'lines':[{'name':'Hot coffee','quantity':1}]}) as exact:
            yield wire, history, exact

    def close(self):return d.close_duplicate(self.flow, auth=self.auth)

    def assert_fenced(self):
        self.assertEqual(journal.inspect(self.flow)['state'], 'FENCED')
        with self.assertRaisesRegex(journal.JournalError, 'ACCOUNT_RECONCILIATION_REQUIRED'):
            journal.require_account_available('talabat', self.binding['account_hash'])

    def recent(self):
        self.history['orders'][0]['native_delivery_date'] = dt.datetime.now(dt.timezone.utc).isoformat()

    def test_closure_keeps_receipts_reservation_sends_and_frees_account(self):
        before = journal.inspect(self.flow)
        snap = self.store.snapshot()
        with self.provider() as (wire, history, exact), patch.object(journal, 'consume', side_effect=AssertionError('no send')):
            result = self.close()
        self.assertEqual(result['state'], 'REJECTED_DUPLICATE')
        self.assertTrue(result['account_fence_lifted'])
        self.assertFalse(result['financial_retry'])
        self.assertFalse(result['provider_no_charge_proven'])
        self.assertEqual(wire.call_args.args[2:4], ('GET','/cart/v1/123'))
        self.assertEqual(history.call_count, 2)
        after = journal.inspect(self.flow)
        self.assertEqual(after['operations'], before['operations'])
        self.assertEqual(after['reserved_minor'], 3645)
        self.assertEqual(self.store.snapshot(), snap)
        self.assertTrue(after['duplicate_closure']['evidence']['history_complete'])
        self.assertTrue(journal.require_account_available('talabat', self.binding['account_hash']))
        with self.assertRaisesRegex(journal.JournalError, 'FLOW_FENCED'):
            journal.consume(self.flow, 'again', kind='quote', request_hash='6'*64)
        with self.assertRaisesRegex(journal.JournalError, 'FLOW_REJECTED_DUPLICATE'):
            journal.observe(self.flow, 'place', outcome='UNKNOWN', evidence_hash='6'*64)
        with patch.object(d, 'CommerceAuth', side_effect=AssertionError('no network')):
            self.assertTrue(d.close_duplicate(self.flow)['already_closed'])
            self.assertEqual(cli.recover_talabat(self.flow)['state'], 'REJECTED_DUPLICATE')

    def test_recent_different_order_checked_exactly_but_matching_phone_order_blocks(self):
        self.recent()
        with self.provider() as (_, _, exact):
            exact.return_value['lines'][0]['name'] = 'Iced coffee'
            with self.assertRaisesRegex(journal.JournalError, 'MATCHING_ORDER'):
                self.close()
            exact.assert_called_once()
        self.assert_fenced()
        with self.provider():self.close()

    def test_explicit_separate_phone_order_audited_without_attribution(self):
        self.recent()
        args=dict(separate_order='100',separate_after=dt.datetime.fromtimestamp(time.time()-60,dt.timezone.utc).isoformat(),
                  separate_evidence='Caller confirms this exact order was separately placed in the app later.')
        with self.provider() as (_, _, exact):
            exact.return_value['lines'][0]['name']='Iced coffee'
            with self.assertRaisesRegex(journal.JournalError,'MATCHING_ORDER'):
                d.close_duplicate(self.flow,auth=self.auth,**{**args,'separate_order':'999'})
            result=d.close_duplicate(self.flow,auth=self.auth,**args)
        self.assertTrue(result['account_fence_lifted'])
        local=journal.inspect(self.flow)
        self.assertIsNone(local['order_id'])
        self.assertEqual(local['duplicate_closure']['evidence']['separately_placed_order']['order'],'100')
        self.assertEqual(local['duplicate_closure']['evidence']['separately_placed_order']['evidence'],args['separate_evidence'])

    def test_separate_order_requires_full_evidence_and_post_rejection_bound(self):
        for args in ({'separate_order':'100'},
                     {'separate_order':'100','separate_after':'2026-01-01T00:00:00','separate_evidence':'Confirmed independent app order'},
                     {'separate_order':'100','separate_after':'2026-01-01T00:00:00Z','separate_evidence':'Confirmed independent app order'}):
            with self.subTest(args=args), self.provider(), self.assertRaises(journal.JournalError):
                d.close_duplicate(self.flow,auth=self.auth,**args)
        self.assert_fenced()

    def test_separate_order_does_not_exclude_another_match(self):
        self.recent()
        self.history['orders'].append({**self.history['orders'][0],'order':'101'})
        self.history['total_orders']=2
        with self.provider() as (_, _, exact):
            exact.return_value['lines'][0]['name']='Iced coffee'
            with self.assertRaisesRegex(journal.JournalError,'MATCHING_ORDER'):
                d.close_duplicate(self.flow,auth=self.auth,separate_order='100',
                    separate_after=dt.datetime.fromtimestamp(time.time()-60,dt.timezone.utc).isoformat(),
                    separate_evidence='Caller confirms independent app purchase 100.')
        self.assert_fenced()

    def test_unknown_or_changed_history_never_closes(self):
        for change in ('truncated','missing_date','missing_branch','changed'):
            with self.subTest(change=change):
                base = copy.deepcopy(self.history)
                if change=='truncated':self.history['truncated']=True
                if change=='missing_date':self.history['orders'][0]['native_delivery_date']=None
                if change=='missing_branch':self.history['orders'][0]['branch_id']=None
                with self.provider() as (_, history, _):
                    if change=='changed':history.side_effect=[self.history,{**self.history,'orders':[]}]
                    with self.assertRaises(journal.JournalError):self.close()
                self.assert_fenced();self.history=base

    def test_cart_or_account_drift_never_closes(self):
        self.cart['cart']['items'][0]['menuItemId']=3
        with self.provider(), self.assertRaisesRegex(journal.JournalError, 'CART_INTENT_CHANGED'):self.close()
        self.assert_fenced()
        self.auth.fresh_before_mutation.return_value.mutation_account.return_value={'expected_profile':{'id':99}}
        with self.provider(), self.assertRaisesRegex(journal.JournalError, 'ACCOUNT_CHANGED'):self.close()

    def test_settling_window_and_read_failure_retain_fence(self):
        with patch.object(journal,'place_observed_at',return_value=time.time()), self.provider(), \
                self.assertRaisesRegex(journal.JournalError,'SETTLING'):self.close()
        with self.provider() as (_, history, _):
            history.side_effect = h.orders.TalabatError('NATIVE_READ_TIMEOUT')
            with self.assertRaises(h.orders.TalabatError):self.close()
        self.assert_fenced()

    def test_conflicting_payment_and_unobserved_ops_ineligible(self):
        local=journal.inspect(self.flow)
        for op in ({'kind':'payment','state':'OBSERVED'}, {'kind':'quote','state':'MAY_HAVE_SENT'}):
            self.assertFalse(d.eligible(self.binding,{**local,'operations':local['operations']+[op]},self.store.snapshot()))

    def test_legacy_receipt_can_be_reviewed_without_rewriting(self):
        local=journal.inspect(self.flow)
        snapshot=SimpleNamespace(receipts=[receipts.Receipt(operation='place',state='SUBMISSION_UNKNOWN',reason=d.REASON,http_status=400)])
        self.assertFalse(d.eligible(self.binding,local,snapshot))
        self.assertTrue(d.eligible(self.binding,local,snapshot,legacy_attested=True))
        for status in (200,401,500,None):
            snapshot.receipts=[receipts.Receipt(operation='place',state='SUBMISSION_UNKNOWN',reason=d.REASON,http_status=status)]
            self.assertFalse(d.eligible(self.binding,local,snapshot))

    def test_receipt_changed_during_reads_retains_fence(self):
        original = self.store.locked_snapshot
        @contextlib.contextmanager
        def changed(_store):
            with original() as snap:yield SimpleNamespace(receipts=())
        with self.provider(), patch.object(receipts,'load',return_value=self.store):
            snapshot=self.store.snapshot()
            with patch.object(type(self.store),'snapshot',return_value=snapshot), patch.object(type(self.store),'locked_snapshot',changed):
                with self.assertRaisesRegex(journal.JournalError,'RECEIPTS_CHANGED'):self.close()
        self.assert_fenced()

    def test_override_requires_exact_account_branch_and_different_base_items(self):
        menu=SimpleNamespace(entries={1:SimpleNamespace(item_id=1,name='Hot coffee'),2:SimpleNamespace(item_id=2,name='Iced coffee')})
        def check(items=self.items):return d.verify_override(self.saved,order='100',branch=10,items=items,menu=menu,deadline=time.monotonic()+10)
        with self.provider():
            self.assertTrue(check()['different_base_items_verified'])
            with self.assertRaisesRegex(journal.JournalError,'ITEMS_NOT_DIFFERENT'):check((h.Item(1,2,'different note',()),))
            self.history['orders'][0]['branch_id']=99
            with self.assertRaisesRegex(journal.JournalError,'ACCOUNT_OR_BRANCH'):check()

    def test_schema_v2_migrates_exactly_and_preserves_fence(self):
        with sqlite3.connect(self.root/'journal.sqlite') as db:
            db.execute('DROP TABLE duplicate_closures');db.execute('DROP INDEX active_account')
            db.execute(journal.SCHEMA_V2['active_account']);db.execute('PRAGMA user_version=2')
        self.assert_fenced()
        with self.provider():self.close()

    def test_only_definitive_response_is_rejected(self):
        body={'duplicateOrderError':{}}
        self.assertEqual(parse_response(400,body).state,'REJECTED_DUPLICATE')
        for status,data in ((200,body),(500,body),(400,{'duplicateOrderError':False}),
                (400,{**body,'placedOrder':{'orderId':'bad'}}),(400,{**body,'placedOrder':{}}),
                (400,{**body,'genericError':{}}),(400,{**body,'unknownPayment':True})):
            observation=parse_response(status,data)
            self.assertNotEqual(observation.state,'REJECTED_DUPLICATE')
            snap=SimpleNamespace(receipts=[receipts.Receipt(operation='place',state=observation.state,
                reason=observation.reason,http_status=status,order_id=observation.order_id,
                transaction_id=observation.transaction_id)])
            self.assertFalse(d.eligible(self.binding,journal.inspect(self.flow),snap))
            with patch.object(receipts,'load',return_value=SimpleNamespace(snapshot=lambda:snap)), \
                    patch.object(d,'CommerceAuth',side_effect=AssertionError('no reads for ambiguous response')):
                with self.assertRaisesRegex(journal.JournalError,'REJECTION_EVIDENCE_REQUIRED'):
                    d.close_duplicate(self.flow)

    def test_canonical_manifest_survives_split_reorder_and_choice_order(self):
        first=(h.Item(2,1,'',((7,1,(9,8)),(6,1,()))),h.Item(3,1,'',()),h.Item(2,1,'',((6,1,()),(7,1,(8,9)))))
        reordered=(h.Item(3,1,'',()),h.Item(2,2,'',((6,1,()),(7,1,(8,9)))))
        self.assertEqual(restaurant.manifest_digest(10,first),restaurant.manifest_digest(10,reordered))
        snap=self.store.snapshot()
        with self.provider():
            branch,names=d._cart(self.saved,{**self.binding,'scope_hash':'0'*64},snap,time.monotonic()+10)
        self.assertEqual(branch,10)
        self.assertEqual(dict(names),{'iced coffee':1})

    def test_purchase_attempts_closure_once_without_payment_or_resend(self):
        flow=TalabatFlow.__new__(TalabatFlow)
        flow.approved={'payable_minor':3645,'quote_digest':'5'*64}
        flow.flow_id=self.flow;flow.auth=self.auth;flow.allow_duplicate_of=None
        flow.checkout=Mock()
        flow.checkout.submit_place.return_value=PlaceObservation('REJECTED_DUPLICATE',d.REASON)
        with patch.object(d,'close_duplicate',side_effect=journal.JournalError('DUPLICATE_HISTORY_INCOMPLETE')) as close:
            result=flow.purchase()
        self.assertEqual(result['state'],'REJECTED_DUPLICATE')
        self.assertFalse(result['account_fence_lifted'])
        close.assert_called_once_with(self.flow,auth=self.auth,wait_for_history=True)
        flow.checkout.submit_place.assert_called_once()
        flow.checkout.submit_payment.assert_not_called()
        self.assertNotEqual(intent_scope('restaurants',10,self.items),intent_scope('restaurants',10,self.items,'100'))


if __name__=='__main__':unittest.main()
