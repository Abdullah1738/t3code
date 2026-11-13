import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

import commerce_journal as j
import commerce_pending as p
from owner_go_support import approve_test_flows


class PendingTests(unittest.TestCase):
    def setUp(self):
        approve_test_flows(self)
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.patch = patch.object(j, 'ROOT', Path(self.temp.name).resolve()/'commerce')
        self.patch.start(); self.addCleanup(self.patch.stop)
        self.account = '1'*64
        import card_status, order_card
        for fixture in (patch.object(order_card,'LAST4','2342'),patch.object(order_card,'NETWORK','mastercard'),
                        patch.dict(os.environ,CARD_STATUS_FILE=str(Path(self.temp.name)/'cards.json'),ORDERING_PAUSE_FILE=str(Path(self.temp.name)/'paused'))):
            fixture.start();self.addCleanup(fixture.stop)
        card_status.record_declined('9546',reason='synthetic issuer decline',source='test')

    def flow(self, vertical='nownow', items=None, *, scope=None):
        flow = str(uuid.uuid4())
        j.open_flow(flow_id=flow, app='noon', vertical=vertical,
                    account_hash=self.account, scope_hash=scope or '2'*64)
        if items:
            p.register(flow, vertical, self.account, items, card_last4='9546')
        return flow

    def send(self, flow, outcome='CHALLENGE_REQUIRED'):
        j.consume(flow, 'place', kind='place', request_hash='3'*64,
            review_hash='4'*64, cart_hash=j.digest(flow), payable_minor=2675)
        if outcome:
            j.observe(flow, 'place', outcome=outcome, evidence_hash='6'*64)

    def test_fenced_nownow_allows_new_flow_each_lane_and_keeps_own_fence(self):
        old = self.flow(); self.send(old)
        for lane in ('main', 'minutes', 'food', 'nownow', 'supermall'):
            with self.subTest(lane=lane):
                self.assertTrue(j.require_account_available('noon', self.account))
                new = self.flow(lane)
                j.consume(new, 'prepare', kind='cart', request_hash='3'*64)
        with self.assertRaisesRegex(j.JournalError, 'JOURNAL_FLOW_FENCED'):
            self.send(old)
        with self.assertRaisesRegex(j.JournalError, 'JOURNAL_FLOW_FENCED'):
            j.require_account_available('noon',self.account,flow_id=old)

    def test_basket_order_quantity_duplicates_and_time_window(self):
        items = [{'product_code':'A','quantity':2}, {'product_code':'B','quantity':1}]
        old = self.flow(items=items); self.send(old)
        for rows, count in [(items[::-1],1), ([{'product_code':'A','quantity':1}]*2 + [items[1]],1),
                            ([{**items[0],'quantity':1},items[1]],0), ([{'product_code':'C','quantity':2}],0)]:
            with self.subTest(rows=rows):
                new = self.flow(items=rows)
                warnings = p.warnings(new)
                self.assertEqual(len(warnings), count)
                if count:
                    self.assertEqual(warnings[0]['flow_id'],old)
                    self.assertEqual(warnings[0]['card_last4'],'9546')
                    self.assertIn('AED 26.75',warnings[0]['message'])
        with j._db() as db:db.execute('UPDATE flows SET created_at=? WHERE id=?',(time.time()-49*3600,old))
        self.assertFalse(p.warnings(new))

    def test_warning_prepare_and_ack_at_financial_boundary_for_every_lane(self):
        keys={'main':'sku_config','minutes':'sku','food':'itemCode','nownow':'product_code','supermall':'sku_config'}
        for lane,key in keys.items():
            with self.subTest(lane=lane):
                items=[{key:'ITEM','quantity':1}]
                old=self.flow(lane,items); self.send(old)
                new=self.flow(lane,items)
                from types import SimpleNamespace
                with contextlib.redirect_stdout(io.StringIO()) as output:
                    result=p.cli_review(SimpleNamespace(flow_id=new),SimpleNamespace())
                self.assertEqual(result[0]['warning'],'SAME_BASKET_PENDING')
                self.assertIn(old,output.getvalue())
                with self.assertRaisesRegex(j.JournalError,'SAME_BASKET_PENDING_ACK_REQUIRED'):
                    self.send(new)
                p.acknowledge(new,[str(uuid.uuid4())])
                with self.assertRaisesRegex(j.JournalError,'SAME_BASKET_PENDING_ACK_REQUIRED'): self.send(new)
                p.acknowledge(new,[old]);self.send(new)

    def test_may_have_sent_and_released_and_different_account(self):
        items=[{'product_code':'A','quantity':1}]
        old=self.flow(items=items); self.send(old,outcome=None)
        new=self.flow(items=items);self.assertEqual(len(p.warnings(new)),1)
        with j._db() as db:db.execute("UPDATE flows SET state='RELEASED' WHERE id=?",(old,))
        self.assertFalse(p.warnings(new))

    def test_migration_v3_preserves_operations_reservations_and_cart_ownership(self):
        old=self.flow();self.send(old)
        before=j.inspect(old)
        with j._db() as db:
            db.execute('DROP TABLE baskets');db.execute('DROP INDEX active_account')
            db.execute(j.SCHEMA_V3['active_account']);db.execute('PRAGMA user_version=3')
        self.flow('main')
        after=j.inspect(old)
        self.assertEqual(after['operations'],before['operations'])
        self.assertEqual(after['reserved_minor'],2675)
        self.assertEqual(after['state'],'FENCED')

    def test_real_marketplace_and_nownow_preparations_ignore_other_flow_fence(self):
        import commerce_receipts
        import order_card
        from test import test_commerce_main_order as main
        from test import test_commerce_supermall_order as supermall
        from test import test_commerce_nownow_order as nownow
        from noon_checkout import fingerprint
        self.account=fingerprint('synthetic-account')
        old=self.flow();self.send(old)
        with patch.object(commerce_receipts,'ROOT',j.ROOT), patch.object(order_card,'LAST4','2342'), patch.object(order_card,'NETWORK','mastercard'):
            for fixture in (main,supermall):
                with self.subTest(lane=fixture.c.__name__), patch.object(fixture.c,'active_marketplace_orders',return_value=[]), \
                     patch.object(fixture.c.urllib.request,'build_opener',return_value=fixture.patched_resolve(fixture.FIXTURE['search'])()):
                    responses=fixture.happy_responses()
                    responses['cart'].append(fixture.cart_state())
                    flow,wire=fixture.make_flow(responses)
                    prepared=flow.prepare_only()
                    self.assertTrue(prepared['prepared_only'])
                    self.assertFalse(any(op[0]=='place' for op in wire.calls))
            flow,wire=nownow.make_flow(nownow.happy_responses())
            prepared=flow.prepare_only()
            self.assertTrue(prepared['prepared_only'])
            self.assertNotIn('place',[op for op,_ in wire.calls])

    def test_real_minutes_preparation_ignores_other_flow_fence(self):
        import commerce_minutes as minutes
        import commerce_receipts
        import order_card
        from test import test_commerce_minutes as fixture
        from noon_checkout import fingerprint
        self.account=fingerprint('account');old=self.flow();self.send(old)
        transport=fixture._NoonTransport(fixture._noon_script(False)[2:7],[])
        with patch.object(commerce_receipts,'ROOT',j.ROOT),patch.object(order_card,'LAST4','2342'),patch.object(order_card,'NETWORK','mastercard'), \
             patch.object(minutes.options,'read_options',return_value={'groups':[]}), \
             patch.object(minutes.m.urllib.request,'build_opener',transport.build_opener):
            flow=minutes.MinutesFlow(items=[{'sku':'SYNTHETIC_SHAKE','qty':1}],auth=fixture._NoonAuth([]))
            self.assertTrue(flow.prepare_only()['prepared_only'])
            self.assertNotIn('place',[op for op,_ in transport.calls])

    def test_real_food_preparation_opens_flow_despite_nownow_fence(self):
        import commerce_food as food
        from types import SimpleNamespace
        old=self.flow();self.send(old)
        items=food.manifest([{'item_code':'I1'}])
        home=SimpleNamespace(account_ref=self.account,address_ref='2'*64)
        data={'checkoutSessionCode':'SESSION','outletCode':'OUTLET','addressCode':'ADDR','addressVersion':1,
              'items':items,'deliveryPreferenceInfo':[{'code':k,'value':True} for k in food.QUIET],
              'driverNotes':food.QUIET_NOTE,'creditCardMask':'****9546','paymentMethodCode':'prepaid',
              'prepaidPaymentMethodCode':'cc_noonpay','orderWalletAmount':0,'orderPaymentAmount':10,'orderTotal':10}
        with patch.object(food,'ROOT',j.ROOT/'food'),patch.object(food,'project_home',return_value=home), \
             patch.object(food.vertical,'_headers',return_value={'x-addresscode':'ADDR','x-addresskey':'ADDR-1'}), \
             patch.object(food.core,'request',return_value={}),patch.object(food.vertical,'food_orders',return_value={'orders':[]}), \
             patch.object(food.native,'food_menu_raw',return_value=({'menu_code':'MENU','menu_version':1,'status':'open','serviceable':True,'name':'Store'},[])), \
             patch.object(food,'validate_choices'),patch.object(food.FoodFlow,'read',return_value=data), \
             patch.object(food.FoodFlow,'write',return_value=data), \
             patch('noon_nownow_checkout.native_request',return_value={'data':[{'ccMasked':'****9546','isDeleted':False,'id':1}]}):
            # Menu rows supply display names after the independently tested choice validation.
            with patch.object(food.native,'food_menu_raw',return_value=({'menu_code':'MENU','menu_version':1,'status':'open','serviceable':True,'name':'Store'},[{'id':'I1','name':'Item'}])):
                flow=food.FoodFlow('OUTLET',[{'item_code':'I1'}]);flow.card_last4='9546'
                result=flow.prepare()
                self.assertEqual(result['state'],'PREPARED_NOT_ORDERED')
                self.assertFalse(result['financial_send'])

    def test_legacy_scope_matrix_requires_ack_without_retained_manifest_files(self):
        for lane,key in [('main','sku_config'),('supermall','sku_config'),('minutes','sku')]:
            for card in ('2342','9546'):
                with self.subTest(lane=lane,card=card):
                    items=[{key:'LEGACY_'+card,'quantity':2}] if lane!='minutes' else [{'sku':'LEGACY_'+card,'qty':2,'modifiers':[]}]
                    scopes=p.legacy_scopes(lane,items,'7'*64)
                    old=self.flow(lane,scope=next(scope for scope,last4 in scopes.items() if last4==card))
                    self.send(old)
                    new=self.flow(lane,items)
                    p.register(new,lane,self.account,items,legacy=scopes)
                    warning=p.warnings(new)[0]
                    self.assertEqual(warning['card_last4'],card)
                    with self.assertRaisesRegex(j.JournalError,'SAME_BASKET_PENDING_ACK_REQUIRED'):self.send(new)
                    p.acknowledge(new,[old]);self.send(new)
                    with j._db() as db:db.execute("UPDATE flows SET state='RELEASED' WHERE id IN (?,?)",(old,new))

    def test_legacy_native_hydration_matches_reordered_items_despite_changed_notes(self):
        from types import SimpleNamespace
        items=[{'sku_config':'A','quantity':2},{'sku_config':'B','quantity':1}]
        old=self.flow('main');self.send(old)
        j.observe(old,'place',outcome='ORDER_ID_RECEIVED',evidence_hash='6'*64,order_id='NLEGACY')
        new=self.flow('main',items[::-1])
        data={'order':'NLEGACY','account_verified':True,'items_complete':True,'card_last4':'2342',
              'items':[{'item_code':'A-1','sku_config':'A','qty':2},{'item_code':'B-1','sku_config':'B','qty':1}]}
        with patch('commerce_auth_status.CommerceAuth') as auth,patch('noon_order_details.details',return_value=data):
            auth.return_value.noon.revalidate.return_value=SimpleNamespace(account_ref=self.account,address_ref='7'*64)
            p.refresh_legacy('main',self.account)
        self.assertEqual(p.warnings(new)[0]['flow_id'],old)
        self.assertEqual(p.warnings(new)[0]['card_last4'],'2342')
        with self.assertRaisesRegex(j.JournalError,'SAME_BASKET_PENDING_ACK_REQUIRED'):self.send(new)

    def test_verification_amount_is_separate_from_reserved_basket(self):
        items=[{'product_code':'A','quantity':1}]
        old=self.flow(items=items);self.send(old)
        p.record_approval(old,{'amount':1})
        new=self.flow(items=items)
        warning=p.warnings(new)[0]
        self.assertEqual(warning['amount_minor'],100)
        self.assertEqual(warning['basket_minor'],2675)
        self.assertIn('AED 1.00',warning['message'])
        self.assertNotIn('AED 26.75',warning['message'])

    def test_inspection_only_constructors_do_not_migrate_or_write_journal(self):
        from test import test_commerce_main_order as main
        from test import test_commerce_supermall_order as supermall
        from test import test_commerce_nownow_order as nownow
        with patch.object(j,'_db',side_effect=AssertionError('constructor must not open journal for writing')):
            for fixture in (main,supermall,nownow):
                with self.subTest(lane=fixture.c.__name__):
                    flow,_=fixture.make_flow(fixture.happy_responses())
                    self.assertFalse(flow.opened)


    def test_open_payments_reads_old_and_new_schema_without_migration(self):
        import hashlib
        old=self.flow();self.send(old)
        path=j.ROOT/'journal.sqlite'
        for version in (4,3):
            if version==3:
                with j._db() as db:
                    db.execute('DROP TABLE baskets');db.execute('DROP INDEX active_account')
                    db.execute(j.SCHEMA_V3['active_account']);db.execute('PRAGMA user_version=3')
            before=hashlib.sha256(path.read_bytes()).hexdigest()
            rows=j.open_payments()
            self.assertEqual(rows[0]['flow_id'],old)
            self.assertEqual(rows[0]['state'],'FENCED')
            self.assertEqual(before,hashlib.sha256(path.read_bytes()).hexdigest())


    def test_observed_pending_financial_operations_still_need_ack(self):
        items=[{'product_code':'A','quantity':1}]
        for kind in ('place','payment','preauthorize','prepay'):
            with self.subTest(kind=kind):
                old=self.flow(items=items)
                args=dict(request_hash='3'*64,cart_hash=j.digest(old),review_hash='4'*64,payable_minor=2675)
                if kind in ('preauthorize','prepay'):
                    j.consume(old,'subscription',kind='preauthorize',**args)
                    j.observe(old,'subscription',outcome='PREORDER_INTENT_RECEIVED',evidence_hash='5'*64)
                    if kind=='prepay':
                        j.consume(old,'complete',kind='prepay',payment_intent_hash='5'*64,**args)
                        j.observe(old,'complete',outcome='RESPONSE_RECEIVED',evidence_hash='6'*64)
                else:
                    j.consume(old,'place',kind='place',**args)
                    j.observe(old,'place',outcome='ORDER_ID_RECEIVED',order_id='NPENDING'+kind,evidence_hash='6'*64)
                    if kind=='payment':
                        j.consume(old,'complete',kind='payment',payment_order_id='NPENDING'+kind,**args)
                        j.observe(old,'complete',outcome='RESPONSE_RECEIVED',evidence_hash='7'*64)
                new=self.flow(items=items)
                self.assertTrue(any(w['flow_id']==old for w in p.warnings(new)))
                with self.assertRaisesRegex(j.JournalError,'SAME_BASKET_PENDING_ACK_REQUIRED'):self.send(new)
                with j._db() as db:db.execute("UPDATE flows SET state='RELEASED' WHERE id=?",(old,))

    def test_captured_native_marketplace_config_is_not_suffixed_sku(self):
        import noon_order_details as detail
        from types import SimpleNamespace
        raw=json.loads((Path(__file__).parent/'fixture_supermall_order_detail_fresh_live.json').read_text())
        order=raw['orderNr']
        with patch.object(detail.vertical,'_headers',return_value={}),patch.object(detail.vertical,'_read',return_value=raw):
            native=detail.details(order,'supermall')
        self.assertNotEqual(native['items'][0]['item_code'],native['items'][0]['sku_config'])
        rows=[{'sku_config':item['sku_config'],'quantity':item['qty']} for item in native['items']]
        old=self.flow('supermall');self.send(old)
        j.observe(old,'place',outcome='ORDER_ID_RECEIVED',evidence_hash='6'*64,order_id=order)
        new=self.flow('supermall',rows)
        with patch('commerce_auth_status.CommerceAuth') as auth,patch.object(detail,'details',return_value=native):
            auth.return_value.noon.revalidate.return_value=SimpleNamespace(account_ref=self.account,address_ref='7'*64)
            p.refresh_legacy('supermall',self.account)
        self.assertEqual(p.warnings(new)[0]['flow_id'],old)
        with self.assertRaisesRegex(j.JournalError,'SAME_BASKET_PENDING_ACK_REQUIRED'):self.send(new)

    def test_read_only_scope_prevents_writes_and_creates_no_journal(self):
        old=self.flow()
        with j.read_only():
            self.assertEqual(j.binding(old)['flow_id'],old)
            with self.assertRaisesRegex(j.JournalError,'JOURNAL_READ_ONLY_OR_UNAVAILABLE'):
                j.open_flow(flow_id=str(uuid.uuid4()),app='noon',vertical='main',account_hash=self.account,scope_hash='2'*64)
        self.assertEqual(len(j.open_payments()),1)


    def test_orderless_legacy_scope_order_note_and_address_matrix_needs_ack(self):
        import order_card
        import commerce_main_order as main
        import commerce_minutes as minutes
        forms=[('main',[{'sku_config':'A','quantity':1},{'sku_config':'B','quantity':2}],
                [{'sku_config':'B','quantity':2},{'sku_config':'A','quantity':1}],None,None,'7'*64,'7'*64),
               ('minutes',[{'sku':'A','qty':1,'modifiers':[]}],[{'sku':'A','qty':1,'modifiers':[]}],
                'Gate one','Gate two','7'*64,'7'*64),
               ('main',[{'sku_config':'A','quantity':1}],[{'sku_config':'A','quantity':1}],
                None,None,'7'*64,'8'*64)]
        for lane,old_items,new_items,old_note,new_note,old_home,new_home in forms:
            with self.subTest(lane=lane,old_note=old_note,old_home=old_home,new_home=new_home):
                if lane=='main':scope=main._scope_hash(old_items,old_home)
                else:scope=minutes._scope_hash(old_items,old_home,old_note)
                old=self.flow(lane,scope=scope)
                self.send(old,outcome=None)
                new=self.flow(lane,new_items)
                p.register(new,lane,self.account,new_items,legacy=p.legacy_scopes(lane,new_items,new_home,extra=new_note))
                warning=p.warnings(new)[0]
                self.assertEqual(warning['flow_id'],old)
                self.assertEqual(warning['basket_match'],'unresolved_legacy_manifest')
                with self.assertRaisesRegex(j.JournalError,'SAME_BASKET_PENDING_ACK_REQUIRED'):self.send(new)
                p.acknowledge(new,[old]);self.send(new)
                with j._db() as db:db.execute("UPDATE flows SET state='RELEASED' WHERE id IN (?,?)",(old,new))


    def test_malformed_legacy_json_matrix_falls_back_and_ack_still_proceeds(self):
        cases=[[],None,True,42,'scalar',{}, {'items':None,'card_last4':'9546'},{'items':{},'card_last4':'9546'},{'items':[None],'card_last4':'9546'},
               {'items':['row'],'card_last4':'9546'},{'items':[42],'card_last4':'9546'}, {'items':[{'product_code':'A','quantity':True}],'card_last4':'9546'},
               {'items':[{'product_code':'A','quantity':1}],'review':[],'card_last4':'9546'},
               {'items':[{'product_code':'A','quantity':1}],'review':None,'card_last4':'9546'},
               {'items':[{'product_code':'A','quantity':1}],'card_last4':{'bad':'shape'}},
               {'items':[{'product_code':'A','quantity':1}],'card_last4':'not-a-card'}]
        items=[{'product_code':'A','quantity':1}]
        for data in cases:
            with self.subTest(data=data):
                old=self.flow();self.send(old)
                root=j.ROOT/'nownow';root.mkdir(exist_ok=True,mode=0o700)
                (root/(old+'.json')).write_text(json.dumps(data))
                new=self.flow(items=items)
                warning=p.warnings(new)[0]
                self.assertEqual(warning['flow_id'],old)
                self.assertEqual(warning['basket_match'],'unresolved_legacy_manifest')
                with self.assertRaisesRegex(j.JournalError,'SAME_BASKET_PENDING_ACK_REQUIRED'):self.send(new)
                p.acknowledge(new,[old]);self.send(new)
                with j._db() as db:db.execute("UPDATE flows SET state='RELEASED' WHERE id IN (?,?)",(old,new))

    def test_unavailable_placed_legacy_merchandise_is_acknowledgeable(self):
        from types import SimpleNamespace
        from noon_http_orders import NoonError
        cases = [
            ('incomplete', {'items_complete': False}),
            ('unknown_completeness', {'items_complete': None}),
            ('scalar_response', None),
            ('array_response', []),
            ('missing_items', {'items': None}),
            ('empty_items', {'items': []}),
            ('missing_sku', {'items': [{'qty': 1}]}),
            ('null_sku', {'items': [{'sku_config': None, 'item_code': None, 'qty': 1}]}),
            ('malformed_row', {'items': [None]}),
            ('invalid_quantity', {'items': [{'sku_config': 'A', 'item_code': 'A', 'qty': True}]}),
            ('fractional_quantity', {'items': [{'sku_config': 'A', 'item_code': 'A', 'qty': 1.5}]}),
            ('missing_quantity', {'items': [{'sku_config': 'A', 'item_code': 'A'}]}),
            ('order_missing', NoonError('ORDER_NOT_FOUND')),
            ('read_unavailable', NoonError('NATIVE_READ_FAILED')),
            ('read_timeout', TimeoutError()),
            ('schema_changed', NoonError('ORDER_ITEM_SCHEMA_CHANGED')),
        ]
        for lane, key in [('main', 'sku_config'), ('minutes', 'sku'), ('supermall', 'sku_config')]:
            for case, result in cases:
                with self.subTest(lane=lane, case=case):
                    old = self.flow(lane); self.send(old)
                    order = 'N'+old.replace('-', '')
                    j.observe(old, 'place', outcome='ORDER_ID_RECEIVED', evidence_hash='6'*64, order_id=order)
                    current = self.flow(lane)
                    items = [{key: 'DIFFERENT_ITEM', 'quantity': 1}] if lane != 'minutes' else [{'sku': 'DIFFERENT_ITEM', 'qty': 1, 'modifiers': []}]
                    flow = SimpleNamespace(flow_id=current, account_hash=self.account, items=items, skus=items,
                                           snapshot=SimpleNamespace(account_ref=self.account, address_ref='7'*64))
                    valid = {'order': order, 'account_verified': True, 'items_complete': True,
                             'items': [{'sku_config': 'A', 'item_code': 'A', 'qty': 1}]}
                    response = ({'side_effect': result} if isinstance(result, Exception) else
                                {'return_value': {**valid, **result} if type(result) is dict else result})
                    with patch('commerce_auth_status.CommerceAuth') as auth, patch('noon_order_details.details', **response), \
                            contextlib.redirect_stdout(io.StringIO()):
                        auth.return_value.noon.revalidate.return_value = flow.snapshot
                        warnings = p.cli_review(flow, SimpleNamespace(order_command=lane, ack_pending=[]))
                        self.assertEqual(warnings[0]['basket_match'], 'unresolved_legacy_manifest')
                        self.assertEqual(warnings[0]['flow_id'], old)
                        with self.assertRaisesRegex(j.JournalError, 'SAME_BASKET_PENDING_ACK_REQUIRED'):
                            self.send(current)
                        warnings = p.cli_review(flow, SimpleNamespace(order_command=lane, ack_pending=[old]))
                        self.assertEqual(warnings[0]['flow_id'], old)
                        self.send(current)
                    with j._db() as db:
                        self.assertIsNone(db.execute('SELECT 1 FROM baskets WHERE flow_id=?', (old,)).fetchone())
                        db.execute("UPDATE flows SET state='RELEASED' WHERE id IN (?,?)", (old, current))

    def test_legacy_hydration_keeps_current_auth_and_account_checks(self):
        from types import SimpleNamespace
        from noon_auth_lifecycle import AuthError
        from noon_http_orders import NoonError
        from noon_minutes_checkout import MinutesError
        for lane in ('main', 'minutes', 'supermall'):
            old = self.flow(lane); self.send(old)
            order = 'N'+old.replace('-', '')
            j.observe(old, 'place', outcome='ORDER_ID_RECEIVED', evidence_hash='6'*64, order_id=order)
            for error in (AuthError('AUTH_EXPIRED'), AuthError('ACCOUNT_IDENTITY_MISMATCH')):
                with self.subTest(lane=lane, error=str(error)), patch('commerce_auth_status.CommerceAuth') as auth, \
                        patch('noon_order_details.details') as details:
                    auth.return_value.noon.revalidate.side_effect = error
                    with self.assertRaises(type(error)):
                        p.refresh_legacy(lane, self.account)
                    details.assert_not_called()
            for error in (NoonError('AUTH_EXPIRED'), NoonError('AUTH_FORBIDDEN'), NoonError('ACCOUNT_HEADERS_INVALID'),
                          NoonError('HOME_MISMATCH'), MinutesError('AUTH_EXPIRED')):
                with self.subTest(lane=lane, error=str(error)), patch('commerce_auth_status.CommerceAuth') as auth, \
                        patch('noon_order_details.details', side_effect=error):
                    auth.return_value.noon.revalidate.return_value = SimpleNamespace(account_ref=self.account, address_ref='7'*64)
                    with self.assertRaises(type(error)):
                        p.refresh_legacy(lane, self.account)
            for invalid in ({'order': 'NWRONG', 'account_verified': True},
                            {'order': order, 'account_verified': False}):
                with self.subTest(lane=lane, identity=invalid), patch('commerce_auth_status.CommerceAuth') as auth, \
                        patch('noon_order_details.details', return_value=invalid):
                    auth.return_value.noon.revalidate.return_value = SimpleNamespace(account_ref=self.account, address_ref='7'*64)
                    with self.assertRaisesRegex(j.JournalError, 'PENDING_LEGACY_BASKET_EVIDENCE_INVALID'):
                        p.refresh_legacy(lane, self.account)
            with patch('commerce_auth_status.CommerceAuth') as auth, patch('noon_order_details.details') as details:
                auth.return_value.noon.revalidate.return_value = SimpleNamespace(account_ref='8'*64)
                with self.assertRaisesRegex(j.JournalError, 'RECOVERY_ACCOUNT_CHANGED'):
                    p.refresh_legacy(lane, self.account)
                details.assert_not_called()
            with j._db() as db:
                db.execute("UPDATE flows SET state='RELEASED' WHERE id=?", (old,))

    def test_food_registration_uses_retained_card_instead_of_current_default(self):
        from types import SimpleNamespace
        import order_card
        items = [{'itemCode': 'I1', 'qty': 1}]
        with patch.object(order_card, 'LAST4', '9546'):
            for retained in ('2342', '9546'):
                with self.subTest(retained=retained):
                    old = self.flow('food')
                    flow = SimpleNamespace(flow_id=old, account=self.account, rows=items, card_last4=retained,
                                           home=SimpleNamespace(address_ref='7'*64))
                    with contextlib.redirect_stdout(io.StringIO()):
                        p.cli_review(flow, SimpleNamespace(order_command='food', ack_pending=[]))
                    p.register(old, 'food', self.account, items, card_last4=retained)
                    self.send(old)
                    new = self.flow('food', items)
                    warning = p.warnings(new)[0]
                    self.assertEqual(warning['flow_id'], old)
                    self.assertEqual(warning['card_last4'], retained)
                    self.assertIn('••'+retained, warning['message'])
                    with j._db() as db:
                        db.execute("UPDATE flows SET state='RELEASED' WHERE id=?", (old,))


    def test_legacy_wrong_native_order_identity_is_not_acknowledgeable(self):
        from types import SimpleNamespace
        import noon_order_details as detail
        from noon_http_orders import NoonError
        raw = json.loads((Path(__file__).parent/'fixture_supermall_order_detail_fresh_live.json').read_text())
        cases = [('complete', {**raw, 'orderNr': 'NWRONG'}, {'orderNr': 'NWRONG', 'items': []}),
                 ('missing_merchandise', {'orderNr': 'NWRONG'}, {'orderNr': 'NWRONG'}),
                 ('malformed_merchandise', {'orderNr': 'NWRONG', 'itemGroups': [None]}, {'orderNr': 'NWRONG', 'items': [None]})]
        for lane, key in [('main', 'sku_config'), ('minutes', 'sku'), ('supermall', 'sku_config')]:
            for case, marketplace, minutes in cases:
                with self.subTest(lane=lane, case=case):
                    old = self.flow(lane); self.send(old)
                    order = 'N'+old.replace('-', '')
                    j.observe(old, 'place', outcome='ORDER_ID_RECEIVED', evidence_hash='6'*64, order_id=order)
                    current = self.flow(lane)
                    items = [{key: 'DIFFERENT_ITEM', 'quantity': 1}]
                    flow = SimpleNamespace(flow_id=current, account_hash=self.account, items=items, skus=items,
                                           snapshot=SimpleNamespace(account_ref=self.account, address_ref='7'*64))
                    with patch('commerce_auth_status.CommerceAuth') as auth, \
                            patch.object(detail.vertical, '_headers', return_value={}), \
                            patch.object(detail.core, 'verified_session', return_value={}), \
                            patch.object(detail.vertical, '_read', return_value=marketplace), \
                            patch('noon_minutes_checkout.native_request', return_value=minutes), \
                            contextlib.redirect_stdout(io.StringIO()):
                        auth.return_value.noon.revalidate.return_value = flow.snapshot
                        with self.assertRaisesRegex(NoonError, '^ORDER_MISMATCH$'):
                            p.cli_review(flow, SimpleNamespace(order_command=lane, ack_pending=[old]))
                    with j._db() as db:
                        self.assertIsNone(db.execute('SELECT 1 FROM operations WHERE flow_id=?', (current,)).fetchone())
                        db.execute("UPDATE flows SET state='RELEASED' WHERE id=?", (old,))

    def test_legacy_real_parser_missing_merchandise_remains_acknowledgeable(self):
        from types import SimpleNamespace
        import noon_order_details as detail
        for lane, key in [('main', 'sku_config'), ('minutes', 'sku'), ('supermall', 'sku_config')]:
            with self.subTest(lane=lane):
                old = self.flow(lane); self.send(old)
                order = 'N'+old.replace('-', '')
                j.observe(old, 'place', outcome='ORDER_ID_RECEIVED', evidence_hash='6'*64, order_id=order)
                current = self.flow(lane)
                items = [{key: 'DIFFERENT_ITEM', 'quantity': 1}]
                flow = SimpleNamespace(flow_id=current, account_hash=self.account, items=items, skus=items,
                                       snapshot=SimpleNamespace(account_ref=self.account, address_ref='7'*64))
                with patch('commerce_auth_status.CommerceAuth') as auth, \
                        patch.object(detail.vertical, '_headers', return_value={}), \
                        patch.object(detail.core, 'verified_session', return_value={}), \
                        patch.object(detail.vertical, '_read', return_value={'orderNr': order}), \
                        patch('noon_minutes_checkout.native_request', return_value={'orderNr': order}), \
                        contextlib.redirect_stdout(io.StringIO()):
                    auth.return_value.noon.revalidate.return_value = flow.snapshot
                    warnings = p.cli_review(flow, SimpleNamespace(order_command=lane, ack_pending=[old]))
                    self.assertEqual(warnings[0]['basket_match'], 'unresolved_legacy_manifest')
                    self.send(current)
                with j._db() as db:
                    db.execute("UPDATE flows SET state='RELEASED' WHERE id IN (?,?)", (old, current))
