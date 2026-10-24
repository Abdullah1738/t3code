from pathlib import Path
import tempfile
import unittest
import contextlib
import json
import io
from unittest.mock import patch

import commerce_cli as c
from commerce_flow import FlowGate
from talabat_place_contract import PlaceObservation
from talabat_http_checkout import AsyncPaymentContext, PaymentResult

_card_state=tempfile.TemporaryDirectory()
_card_env=patch.dict('os.environ',{'CARD_STATUS_FILE':str(Path(_card_state.name)/'card-status.json')})


def setUpModule():
    # The live card-status record must never decide these tests.
    _card_env.start()


def tearDownModule():
    _card_env.stop()
    _card_state.cleanup()


class MarketplacePaymentCLITests(unittest.TestCase):
    def test_both_lanes_prepare_cvv_before_single_place_and_wait(self):
        from unittest.mock import Mock
        for lane, target in (('main','commerce_main_order.MainOrderFlow'),
                             ('supermall','commerce_supermall_order.SupermallOrderFlow')):
            with self.subTest(lane=lane):
                flow = Mock()
                flow.flow_id, flow.order = 'fixture-flow', 'NAEFIxture'
                flow.review = {'payable_minor': 1980}
                flow.prepare_only.return_value = {'flow_id': flow.flow_id, 'prepared_only': True,
                    'review': {}, 'readback': {'verified': True}}
                flow.place.return_value = {'order': flow.order}
                flow.await_success.return_value = {'paid': True}
                flow.verify_tracking.return_value = {'status': 'placed'}
                flow.register_tracker.return_value = {'watcher': 'fixture-watcher', 'registered': True}
                with patch(target,return_value=flow), patch.object(c,'CommerceAuth'), \
                     patch.object(c,'cvv_from_keychain',return_value=b'123') as cvv, \
                     patch.object(c.journal,'complete') as complete, \
                     contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(c.main(['order',lane,'--sku-config','Z1','--cvv-from-keychain']),0)
                cvv.assert_called_once()
                flow.prepare_payment.assert_called_once_with(cvv=b'123')
                flow.place.assert_called_once()
                flow.await_success.assert_called_once()
                names = [call[0] for call in flow.mock_calls]
                self.assertLess(names.index('prepare_payment'), names.index('place'))
                self.assertLess(names.index('await_success'), names.index('register_tracker'))
                complete.assert_called_once_with(flow.flow_id)

    def test_marketplace_await_routes_readonly_resume_then_tracker(self):
        from unittest.mock import Mock
        for lane, target in (('main','commerce_main_order.MainOrderFlow'),
                             ('supermall','commerce_supermall_order.SupermallOrderFlow')):
            with self.subTest(lane=lane), patch(target) as cls, \
                 patch.object(c.journal,'binding',return_value={'app':'noon','vertical':lane}), \
                 patch.object(c.journal,'payment_reported',return_value=False), \
                 patch.object(c.journal,'complete') as complete, \
                 patch.object(c,'cvv_from_keychain',side_effect=AssertionError('no CVV in recovery')), \
                 contextlib.redirect_stdout(io.StringIO()):
                flow=cls.resume_payment.return_value
                flow.order='NAE123'
                flow.await_success.return_value={'paid':True}
                flow.verify_tracking.return_value={'status':'placed'}
                flow.register_tracker.return_value={'watcher':'fixture-watcher'}
                self.assertEqual(c.main(['await-payment','fixture-flow','--no-notify']),0)
                cls.resume_payment.assert_called_once_with('fixture-flow')
                flow.await_success.assert_called_once_with(wait_seconds=600,notify=None)
                flow.place.assert_not_called()
                complete.assert_called_once_with('fixture-flow')

    def test_any_stop_after_the_payment_send_prints_charge_unknown(self):
        from unittest.mock import Mock
        from noon_marketplace_checkout import MarketplaceError
        for lane, target in (('main','commerce_main_order.MainOrderFlow'),
                             ('supermall','commerce_supermall_order.SupermallOrderFlow')):
            with self.subTest(lane=lane):
                flow = Mock()
                flow.flow_id, flow.order = 'fixture-flow', 'NAEFIxture'
                flow.review = {'payable_minor': 1980}
                flow.prepare_only.return_value = {'flow_id': flow.flow_id, 'prepared_only': True,
                    'review': {}, 'readback': {'verified': True}}
                flow.place.return_value = {'order': flow.order}
                for error, code in ((MarketplaceError('REQUEST_TIMEOUT'), 'REQUEST_TIMEOUT'),
                                    (KeyError('status'), 'COMMERCE_OPERATION_FAILED')):
                    flow.await_success.side_effect = error
                    with patch(target,return_value=flow), patch.object(c,'CommerceAuth'), \
                         patch.object(c,'cvv_from_keychain',return_value=b'123'), \
                         contextlib.redirect_stdout(io.StringIO()) as output:
                        self.assertEqual(c.main(['order',lane,'--sku-config','Z1','--cvv-from-keychain']),1)
                    result = json.loads(output.getvalue().strip().splitlines()[-1])
                    self.assertEqual((result['error'], result['charge'], result['financial_retry']),
                                     (code, 'unknown', False))
                    self.assertIn('AED 19.80 went out but I lost its status', result['tell'])

    def test_lost_place_answer_says_charge_unknown_but_a_refusal_does_not(self):
        from unittest.mock import Mock
        from noon_marketplace_checkout import MarketplaceError
        for lane, target in (('main','commerce_main_order.MainOrderFlow'),
                             ('supermall','commerce_supermall_order.SupermallOrderFlow')):
            for error, guidance in ((MarketplaceError('TRANSPORT_OUTCOME_UNKNOWN', may_have_sent=True), True),
                                    (MarketplaceError('READ_FAILED'), False),
                                    (MarketplaceError('AUTH_EXPIRED', may_have_sent=True), False)):
                with self.subTest(lane=lane, error=error.code):
                    flow = Mock()
                    flow.flow_id, flow.order = 'fixture-flow', None
                    flow.review = {'payable_minor': 1980}
                    flow.prepare_only.return_value = {'flow_id': flow.flow_id, 'prepared_only': True,
                        'review': {}, 'readback': {'verified': True}}
                    flow.place.side_effect = error
                    with patch(target,return_value=flow), patch.object(c,'CommerceAuth'), \
                         patch.object(c,'cvv_from_keychain',return_value=b'123'), \
                         contextlib.redirect_stdout(io.StringIO()) as output:
                        self.assertEqual(c.main(['order',lane,'--sku-config','Z1','--cvv-from-keychain']),1)
                    result = json.loads(output.getvalue().strip().splitlines()[-1])
                    if error.code == 'AUTH_EXPIRED':
                        self.assertEqual(result['error'], lane.upper() + '_AUTH_EXPIRED_NEEDS_APP_REBIND')
                    else:
                        self.assertEqual(result['error'], error.code)
                    self.assertEqual('charge' in result, guidance)
                    if guidance:
                        self.assertEqual(result['charge'], 'unknown')
                        self.assertIn('AED 19.80 went out but I lost its status', result['tell'])
                        # No command can find an order without its number: say so, keep the fence.
                        steps = ' '.join(result['next'])
                        self.assertIn("Orders page; its order number never came back", steps)
                        self.assertIn('leave flow fixture-flow fenced', steps)
                        self.assertNotIn('order-status', steps)
                        self.assertNotIn('commerce reconcile-order', steps)

    def test_already_paid_marketplace_resume_does_not_need_checkout_record(self):
        from unittest.mock import Mock
        from noon_marketplace_checkout import MarketplaceError
        for lane, target in (('main','commerce_main_order.MainOrderFlow'),
                             ('supermall','commerce_supermall_order.SupermallOrderFlow')):
            with self.subTest(lane=lane), patch(target) as cls, \
                 patch.object(c.journal,'binding',return_value={'app':'noon','vertical':lane}), \
                 patch.object(c.journal,'payment_reported',return_value=True), \
                 patch.object(c.journal,'inspect',return_value={'state':'ACTIVE'}), \
                 patch.object(c.journal,'complete') as complete, \
                 contextlib.redirect_stdout(io.StringIO()):
                flow=cls.resume_payment.return_value
                flow.order='NAE123'
                flow.await_success.side_effect=MarketplaceError('CHECKOUT_ORDER_NOT_FOUND')
                flow.verify_tracking.return_value={'status':'placed'}
                flow.register_tracker.return_value={'watcher':'fixture-watcher'}
                self.assertEqual(c.main(['await-payment','fixture-flow']),0)
                flow.await_success.assert_not_called()
                flow.verify_tracking.assert_called_once()
                flow.register_tracker.assert_called_once()
                complete.assert_called_once_with('fixture-flow')


class RecoveryTests(unittest.TestCase):
    def test_capabilities_are_explicit_and_auth_failure_sets_exit_status(self):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(c.main(['capabilities']),0)
        import json
        data=json.loads(out.getvalue())
        self.assertIsNone(data['order_cap_minor'])
        self.assertIsNone(data['campaign_cap_minor'])
        self.assertEqual(len(data['verticals']),7)
        for vertical in ('shops','mart','restaurants'):
            self.assertEqual(data['verticals']['talabat.'+vertical]['payment'],'native_async_live_paid')
            self.assertEqual(data['verticals']['talabat.'+vertical]['place'],'live_order_created')
        food=data['verticals']['talabat.restaurants']
        self.assertIn('cart_quote_readback_live_verified',food['item_notes'])
        self.assertTrue(food['item_note_purchase_live_verified'])
        self.assertTrue(food['food_choices_supported'])
        self.assertTrue(food['food_choices_cart_live_verified'])
        self.assertTrue(food['food_choices_purchase_live_verified'])
        self.assertTrue(food['nested_subchoices_supported'])
        self.assertEqual(food['nested_subchoices_depth'],1)
        self.assertTrue(food['nested_subchoices_cart_live_verified'])
        self.assertFalse(food['nested_subchoices_purchase_live_verified'])
        self.assertTrue(food['multi_item_baskets'])
        self.assertTrue(food['multi_item_purchase_live_verified'])
        for vertical in ('mart','shops'):
            self.assertFalse(data['verticals']['talabat.'+vertical]['multi_item_purchase_live_verified'])
        self.assertEqual(data['talabat_order_scope'],'arbitrary_catalog_items_and_multiple_lines')
        self.assertEqual(data['spending_policy'],'caller_managed_no_cli_order_or_campaign_cap')
        for vertical in ('minutes','nownow','main','supermall'):
            self.assertTrue(data['verticals']['noon.'+vertical]['multi_item_baskets'])
            self.assertTrue(data['verticals']['noon.'+vertical]['multi_item_cart_live_verified'])
            self.assertTrue(data['verticals']['noon.'+vertical]['multi_item_purchase_live_verified'])
        self.assertTrue(data['verticals']['noon.nownow']['quiet_driver_note_live_verified'])
        self.assertTrue(data['verticals']['noon.minutes']['multi_item_cart_live_verified'])
        self.assertIn('peer_cookie_adoption',data['noon_session_recovery'])
        self.assertFalse(data['noon_refresh_grant_verified'])
        self.assertIn('no_place_or_payment',data['prepare_only'])
        self.assertFalse(data['financial_retry'])
        with patch.object(c,'CommerceAuth') as auth,contextlib.redirect_stdout(io.StringIO()):
            auth.return_value.status.return_value={'ok':False,'error':'AUTH_FORBIDDEN'}
            self.assertEqual(c.main(['auth','noon','minutes']),1)

    def test_exact_tracking_selects_declared_vertical_without_mutation(self):
        with patch('commerce_nownow.reader') as reader:
            reader.return_value.track.return_value={'status':'unknown'}
            self.assertEqual(c.track_exact('noon','nownow','NNEXACT')['status'],'unknown')
            reader.return_value.track.assert_called_once_with('NNEXACT')
        with patch.object(c.talabat.orders,'track',return_value={'status':'preparing'}) as track:
            c.track_exact('talabat','restaurants','12345')
            track.assert_called_once_with('12345')
        with self.assertRaises(c.journal.JournalError):c.track_exact('noon','invented','12345')

    def test_noon_recovery_is_exact_order_readback_never_payment_replay(self):
        with patch.object(c.journal,'binding',return_value={'app':'noon','vertical':'minutes'}), \
                patch('commerce_order_status.status',return_value={'state':'failed','order':'IAEGA123'}) as status:
            result=c.recover_payment('flow')
        status.assert_called_once_with('flow')
        self.assertEqual(result['state'],'failed')
        self.assertFalse(result['financial_retry'])

    def test_checkout_check_exposes_account_fence_but_can_read_empty_cart(self):
        with patch.object(c,'CommerceAuth') as auth, \
                patch.object(c.journal,'require_account_available',side_effect=c.journal.JournalError('JOURNAL_ACCOUNT_RECONCILIATION_REQUIRED')), \
                patch('commerce_marketplace.MarketplaceFlow') as flow:
            auth.return_value.noon.status.return_value={'maintenance_state':'none'}
            flow.return_value.cart.return_value={'empty':True,'count':0}
            result=c.checkout_check('supermall')
        self.assertFalse(result['account_available']);self.assertTrue(result['cart_empty'])
        self.assertFalse(result['financial_send'])
        self.assertEqual(result['blocker'],'JOURNAL_ACCOUNT_RECONCILIATION_REQUIRED')

    def test_reconcile_order_routes_exact_id_and_does_not_imply_permission(self):
        with patch('commerce_reconcile.reconcile',return_value={'ok':True,'liability':'unresolved',
                'financial_retry':False,'reservation_release_allowed':False}) as reconcile, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(c.main(['reconcile-order','flow']),0)
        reconcile.assert_called_once_with('flow')
        self.assertIn('unresolved',output.getvalue())

    def test_noon_readonly_auth_diagnostic_has_distinct_nonwriting_dispatch(self):
        with patch.object(c,'CommerceAuth') as manager,contextlib.redirect_stdout(io.StringIO()):
            manager.return_value.noon.diagnose_readonly.return_value={'ok':True,'storage_writes':0}
            self.assertEqual(c.main(['auth','noon','main','--diagnose-readonly']),0)
        manager.return_value.noon.diagnose_readonly.assert_called_once_with('main')
        manager.return_value.recover.assert_not_called()

    def test_restaurant_contract_reports_proven_get_and_verified_ccx(self):
        import json
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(c.main(['restaurant-cart-contract']),0)
        result=json.loads(out.getvalue())
        self.assertEqual(result['path'],'/cart/v1/{exact_owned_cart_id}')
        self.assertEqual(result['query'],{'hasOutstandingPayments':'false'})
        self.assertTrue(result['ccx_correspondence_verified'])
        self.assertFalse(result['mutation'])

    def test_restart_reads_exact_pending_context_without_financial_transport(self):
        flow='10000000-0000-4000-8000-000000000001'
        account=c.account_hash({'expected_profile':{'id':77}})
        binding=dict(flow_id=flow,app='talabat',vertical='shops',account_hash=account,scope_hash='2'*64)
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(c.journal,'ROOT',Path(temp).resolve()/'commerce'), \
                patch.object(c.receipts,'ROOT',Path(temp).resolve()/'commerce'):
            store=c.receipts.create(**binding)
            gate=FlowGate(**binding,receipt_sink=store,request_check=lambda r:True)
            record={'version':1,'app':'talabat','flow_id':flow,'account_binding':account,
                'request_sha256':'3'*64,'cart_binding':'4'*64,'review_sha256':'5'*64,
                'currency':'AED','payable_minor':2000,'state':'MAY_HAVE_SENT','operation':'place'}
            gate.before_talabat(record)
            gate.talabat_receipt({'operation':'place','observation':PlaceObservation(
                'PAYMENT_PENDING','PAYMENT_COMPLETION_UNPROVEN','12345','txn','20.00'),'http_status':200})
            gate.before_talabat({**record,'operation':'payment','payment_order_id':'12345'})
            ctx=AsyncPaymentContext('12345','txn',flow,(1.0,1.0),account)
            gate.talabat_receipt({'operation':'payment','context':ctx,'next_index':0,'http_status':200,
                'result':PaymentResult('PAYMENT_PENDING','TALABAT_ASYNC_STATUS_REQUIRED','12345','txn')})
            saved={'expected_profile':{'id':77}}
            class Auth:
                def fresh_before_mutation(self,*a,**kw):return self
                def mutation_account(self,*a):return saved
            class Poller:
                def __init__(self,received,context,*,receipt,next_index,timeout):
                    self.next_index=next_index
                    self.receipt=receipt
                    self.context=context
                    assert context==ctx and received==saved
                def poll(self,*,max_reads):
                    self.next_index+=1
                    result=PaymentResult('PAYMENT_REPORTED_SUCCESS','EXACT_TRANSACTION_ASYNC_STATUS_SUCCESS','12345','txn')
                    self.receipt({'operation':'payment_status','context':self.context,'next_index':self.next_index,
                                  'http_status':200,'result':result})
                    return result
            with patch.object(c,'CommerceAuth',Auth),patch.object(c.talabat,'AsyncPaymentPoller',Poller), \
                    patch.object(c.talabat,'_wire',side_effect=AssertionError('financial wire forbidden')):
                result=c.recover_talabat(flow)
            self.assertEqual(result['state'],'PAYMENT_REPORTED_SUCCESS')
            self.assertEqual(result['next_index'],1)
            self.assertEqual(len(c.journal.inspect(flow)['operations']),2)


class MinutesOrderTests(unittest.TestCase):
    def test_order_minutes_requires_wiring_and_cvv_flag(self):
        import argparse
        # Missing --sku exits with usage error before any dispatch.
        with self.assertRaises(SystemExit),contextlib.redirect_stderr(io.StringIO()):
            c.main(['order','minutes'])
        with patch.object(c,'order_minutes',return_value={'ok':True}) as order_minutes, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(c.main(['order','minutes','--sku','SKU1','--quantity','2',
                '--cvv-from-keychain','--label','minutes test']),0)
        kwargs=order_minutes.call_args.args[0]
        self.assertEqual(kwargs.sku,'SKU1')
        self.assertEqual(kwargs.quantity,2)
        self.assertTrue(kwargs.cvv_from_keychain)
        self.assertEqual(kwargs.label,'minutes test')

    def test_cvv_from_keychain_stays_in_ram_and_validates(self):
        from unittest.mock import Mock
        good=Mock(returncode=0,stdout=b'007\n')
        with patch.object(c.subprocess,'run',return_value=good) as run:
            self.assertEqual(c.cvv_from_keychain(),b'007')
        command=run.call_args.args[0]
        self.assertEqual(command,['security','find-generic-password','-s','robob-card',
                                   '-a','Marriott.card_cvc','-w'])
        # stdout/stderr are captured pipes; the CVV never becomes an argument.
        self.assertTrue(run.call_args.kwargs['stdout'] is not None)
        for bad in (Mock(returncode=1,stdout=b''),Mock(returncode=0,stdout=b'12x\n'),
                    Mock(returncode=0,stdout=b'')):
            with patch.object(c.subprocess,'run',return_value=bad), \
                    self.assertRaisesRegex(c.journal.JournalError,'CVV_KEYCHAIN'):
                c.cvv_from_keychain()
        with patch.object(c.subprocess,'run',side_effect=OSError), \
                self.assertRaisesRegex(c.journal.JournalError,'CVV_KEYCHAIN_UNAVAILABLE'):
            c.cvv_from_keychain()

    def test_order_minutes_surfaces_active_orders_before_any_send(self):
        import json
        from unittest.mock import Mock
        import commerce_minutes as cm
        snapshot=Mock()
        snapshot.projection={'count':1,'active':[{'order':'IAEGAUNPAID1','raw_status':'pending',
            'payment_intent_present':True}],'resend_allowed':False}
        with patch.object(c,'CommerceAuth'), \
                patch.object(cm,'readback_active_orders',return_value=snapshot), \
                patch.object(cm,'MinutesFlow',side_effect=AssertionError('flow must not start')):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(c.main(['order','minutes','--sku','SKU1']),1)
        result=json.loads(output.getvalue().strip().splitlines()[-1])
        self.assertEqual(result['error'],'MINUTES_ACTIVE_ORDER_PRESENT')
        self.assertFalse(result['financial_retry'])
        self.assertIn('IAEGAUNPAID1',output.getvalue())

    def test_order_minutes_auth_loss_reports_app_rebind(self):
        import json
        from unittest.mock import Mock
        import noon_minutes_checkout as mt
        import commerce_minutes as cm
        snapshot=Mock();snapshot.projection={'count':0,'active':[],'resend_allowed':False}
        with patch.object(c,'CommerceAuth'), \
                patch.object(cm,'readback_active_orders',return_value=snapshot), \
                patch.object(cm,'MinutesFlow') as flow, \
                patch.object(c,'cvv_from_keychain',return_value=b'007'):
            flow.return_value.flow_id='10000000-0000-4000-8000-000000000009'
            flow.return_value.prepare_only.side_effect=mt.MinutesError('AUTH_EXPIRED')
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(c.main(['order','minutes','--sku','SKU1',
                    '--cvv-from-keychain']),1)
        result=json.loads(output.getvalue().strip().splitlines()[-1])
        self.assertEqual(result['error'],'MINUTES_AUTH_EXPIRED_NEEDS_APP_REBIND')

    def minutes_order(self, complete=None, complete_error=None, paid=None, notify=None, flows=None):
        from unittest.mock import Mock
        import commerce_minutes as cm
        snapshot=Mock();snapshot.projection={'count':0,'active':[],'resend_allowed':False}
        with patch.object(c,'CommerceAuth'), \
                patch.object(cm,'readback_active_orders',return_value=snapshot), \
                patch.object(cm,'MinutesFlow') as flow, \
                patch.object(cm,'telegram_3ds_notify',**(notify or {'return_value':{'notified':True}})), \
                patch.object(c,'cvv_from_keychain',return_value=b'007'):
            if flows is not None:flows.append(flow.return_value)
            f=flow.return_value
            f.flow_id='10000000-0000-4000-8000-000000000009'
            f.review={'order':'IAEGA123','amount':1725}
            f.prepare_only.return_value={'flow_id':f.flow_id,'prepared_only':True,'review':{'payable_minor':1725},
                                         'readback':{'verified':True}}
            f.place.return_value={'order':'IAEGA123'}
            if complete_error is not None:
                f.complete.side_effect=complete_error
            else:
                f.complete.return_value=complete
            f.await_payment.return_value=paid
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(c.main(['order','minutes','--sku','SKU1','--cvv-from-keychain']),1)
        return json.loads(output.getvalue().strip().splitlines()[-1])

    def test_minutes_card_send_that_may_have_landed_or_was_refused_says_charge_unknown(self):
        import noon_minutes_checkout as mt
        result=self.minutes_order(complete_error=mt.MinutesError('REQUEST_TIMEOUT',may_have_sent=True))
        self.assertEqual((result['error'],result['charge']),('REQUEST_TIMEOUT','unknown'))
        self.assertIn('AED 17.25 went out but I lost its status',result['tell'])
        result=self.minutes_order(complete={'payment_status':'payment_failed'})
        self.assertEqual((result['error'],result['charge']),('MINUTES_PAYMENT_NOT_PENDING','unknown'))
        self.assertIn("AED 17.25 didn't go through",result['tell'])
        result=self.minutes_order(complete_error=mt.MinutesError('MINUTES_EXACT_PENDING_INTENT_REQUIRED'))
        self.assertNotIn('charge',result)

    def test_minutes_lost_3ds_alert_still_waits_and_any_stop_says_charge_unknown(self):
        import commerce_minutes as cm
        paid={'paid':False,'payment_status':'payment_pending','transaction_status':'CREATED',
              'polls':40,'timed_out':True}
        flows=[]
        with patch.object(cm.subprocess,'run',side_effect=OSError):
            result=self.minutes_order(complete={'payment_status':'payment_pending'},paid=paid,
                                      notify={'wraps':cm.telegram_3ds_notify},flows=flows)
        flows[0].await_payment.assert_called_once_with()
        self.assertEqual((result['error'],result['charge']),('MINUTES_PAYMENT_WINDOW_ELAPSED_NO_RETRY','unknown'))
        result=self.minutes_order(complete={'payment_status':'payment_pending'},paid=paid,
                                  notify={'side_effect':RuntimeError('telegram down')})
        self.assertEqual((result['error'],result['charge']),('COMMERCE_OPERATION_FAILED','unknown'))
        self.assertIn('AED 17.25 went out but I lost its status',result['tell'])

    def test_minutes_bank_approved_but_not_captured_says_treat_as_charged(self):
        result=self.minutes_order(complete={'payment_status':'payment_pending'},paid={
            'paid':False,'payment_status':'payment_confirmed','transaction_status':'AUTHORIZED',
            'polls':40,'timed_out':True})
        self.assertEqual((result['error'],result['charge']),('MINUTES_PAYMENT_WINDOW_ELAPSED_NO_RETRY','unknown'))
        self.assertIn('The bank approved the payment for AED 17.25',result['tell'])

    def test_await_payment_dispatches_resume_path(self):
        import commerce_minutes as cm
        with patch.object(cm,'MinutesFlow') as flow, \
                patch.object(c.journal,'binding',return_value={'app':'noon','vertical':'minutes'}), \
                patch.object(c.journal,'payment_reported',return_value=False), \
                patch.object(cm,'telegram_3ds_notify',return_value={'notified':True}) as notify, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            flow.resume_payment.return_value.flow_id='flow'
            flow.resume_payment.return_value.review={'order':'IAEGA123','amount':1725}
            flow.resume_payment.return_value.await_payment.return_value={
                'paid':False,'payment_status':'payment_pending',
                'transaction_status':'CREATED','polls':1,'timed_out':True}
            self.assertEqual(c.main(['await-payment','flow','--no-notify']),1)
        flow.resume_payment.assert_called_once_with('flow')
        flow.resume_payment.return_value.await_payment.assert_called_once_with(notify=None,wait_seconds=600.0)
        notify.assert_not_called()
        # Unconfirmed is never reported as uncharged.
        result=json.loads(output.getvalue().strip().splitlines()[-1])
        self.assertEqual((result['error'],result['charge']),('MINUTES_PAYMENT_WINDOW_ELAPSED_NO_RETRY','unknown'))
        self.assertIn('AED 17.25 is still waiting on the bank',result['tell'])

    def test_minutes_wait_with_every_read_lost_still_says_charge_unknown(self):
        import commerce_minutes as cm
        from unittest.mock import Mock
        flow=object.__new__(cm.MinutesFlow)
        flow.flow_id='10000000-0000-4000-8000-000000000001'
        flow.review={'order':'IAEGA123','amount':1725,'digest':'a'*64}
        flow.intent={'secret':'synthetic-intent'}
        flow.client=Mock()
        flow.client.payment_intent_status.side_effect=cm.m.MinutesError('REQUEST_TIMEOUT')
        flow.store=Mock()
        clock=iter([0,5,601])
        real=cm.MinutesFlow.await_payment
        def wait(self,**kw):
            return real(self,**{**kw,'sleep':lambda _:None,'clock':clock.__next__})
        with patch.object(cm.MinutesFlow,'resume_payment',return_value=flow), \
                patch.object(cm.MinutesFlow,'await_payment',wait), \
                patch.object(c.journal,'binding',return_value={'app':'noon','vertical':'minutes'}), \
                patch.object(c.journal,'payment_reported',return_value=False), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(c.main(['await-payment',flow.flow_id,'--no-notify']),1)
        result=json.loads(output.getvalue().strip().splitlines()[-1])
        self.assertEqual((result['error'],result['charge']),('MINUTES_PAYMENT_WINDOW_ELAPSED_NO_RETRY','unknown'))
        self.assertIn('AED 17.25 is still waiting on the bank',result['tell'])

    def test_minutes_bank_approval_seen_before_a_lost_last_read_still_counts(self):
        import commerce_minutes as cm
        from unittest.mock import Mock
        flow=object.__new__(cm.MinutesFlow)
        flow.flow_id='10000000-0000-4000-8000-000000000001'
        flow.review={'order':'IAEGA123','amount':1725,'digest':'a'*64}
        flow.intent={'secret':'synthetic-intent'}
        flow.client=Mock()
        approved=Mock(projection={'paid':False,'state':'payment_in_progress','payment_status':'payment_confirmed',
                                  'transaction_status':'AUTHORIZED'})
        flow.client.payment_intent_status.side_effect=[approved,cm.m.MinutesError('REQUEST_TIMEOUT')]
        flow.store=Mock()
        clock=iter([0,5,601])
        real=cm.MinutesFlow.await_payment
        def wait(self,**kw):
            return real(self,**{**kw,'sleep':lambda _:None,'clock':clock.__next__})
        with patch.object(cm.MinutesFlow,'resume_payment',return_value=flow), \
                patch.object(cm.MinutesFlow,'await_payment',wait), \
                patch.object(c.journal,'binding',return_value={'app':'noon','vertical':'minutes'}), \
                patch.object(c.journal,'payment_reported',return_value=False), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(c.main(['await-payment',flow.flow_id,'--no-notify']),1)
        result=json.loads(output.getvalue().strip().splitlines()[-1])
        self.assertEqual((result['error'],result['charge']),('MINUTES_PAYMENT_WINDOW_ELAPSED_NO_RETRY','unknown'))
        self.assertIn('The bank approved the payment for AED 17.25',result['tell'])

    def test_release_flow_is_minutes_only_and_evidence_gated(self):
        import json
        import commerce_minutes as cm
        from unittest.mock import Mock
        binding={'flow_id':'flow','app':'noon','vertical':'minutes',
                 'account_hash':'a'*64,'scope_hash':'b'*64}
        state={'state':'FENCED','order_id':'IAEGAFAILED1','reserved_minor':1725,
               'operations':[{'name':'place','kind':'place','state':'OBSERVED'}]}
        with patch.object(c.journal,'binding',return_value=binding), \
                patch.object(c.journal,'inspect',return_value=state), \
                patch.object(c.journal,'release',return_value={'state':'RELEASED',
                    'reservation_minor_retained':True,'retry_allowed':False}), \
                patch.object(c,'CommerceAuth'), \
                patch.object(cm,'exact_failed_evidence',return_value={
                    'order_get':{'raw_status':'failed','identity_echoed':True,
                                 'payment_intent_present':True,'total_minor':0},
                    'active_orders':[]}) as evidence:
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(c.main(['release-flow','flow']),0)
        evidence.assert_called_once()
        result=json.loads(output.getvalue())
        self.assertEqual(result['state'],'RELEASED')
        self.assertEqual(result['order'],'IAEGAFAILED1')
        self.assertEqual(result['evidence']['order_get']['raw_status'],'failed')
        self.assertFalse(result['financial_retry'])
        # Non-minutes bindings and non-fenced states refuse before any read.
        talabat=dict(binding,app='talabat',vertical='shops')
        with patch.object(c.journal,'binding',return_value=talabat), \
                patch.object(c.journal,'inspect',return_value=state), \
                patch.object(cm,'exact_failed_evidence',side_effect=AssertionError), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(c.main(['release-flow','flow']),1)
        with patch.object(c.journal,'binding',return_value=binding), \
                patch.object(c.journal,'inspect',return_value={**state,'state':'ACTIVE'}), \
                patch.object(cm,'exact_failed_evidence',side_effect=AssertionError), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(c.main(['release-flow','flow']),1)


    def test_await_payment_finishes_already_paid_flow_without_reobserving(self):
        import argparse
        import commerce_minutes as cm
        from unittest.mock import Mock
        flow=Mock()
        flow.review={'order':'IAEGA123'}
        flow.await_payment.return_value={'paid':False,'payment_status':'payment_pending',
            'transaction_status':'CREATED','polls':1,'timed_out':True}
        flow.verify_tracking.return_value={'order':'IAEGA123','status':'preparing',
            'identity_verified':True,'account_verified':True,'source':'native_order_api',
            'eta':'2026-10-10T14:44:00+04:00'}
        flow.register_tracker.return_value={'watcher':'order-noon-iaega123','registered':True}
        paid={'paid':True,'payment_status':'payment_confirmed','transaction_status':'CAPTURED',
              'polls':0,'timed_out':False,'already_observed':True}
        with patch.object(cm,'MinutesFlow') as flow_cls, \
                patch.object(c.journal,'binding',return_value={'app':'noon','vertical':'minutes'}), \
                patch.object(c.journal,'payment_reported',return_value=True) as reported, \
                patch.object(c.journal,'complete',return_value={'state':'COMPLETE'}) as complete, \
                patch.object(cm,'telegram_3ds_notify') as notify, \
                contextlib.redirect_stdout(io.StringIO()):
            flow_cls.resume_payment.return_value=flow
            result=c.await_payment_flow(argparse.Namespace(
                flow_id='f',minutes=4,no_notify=False))
        reported.assert_called_once_with('f')
        notify.assert_not_called()
        flow.await_payment.assert_not_called()
        self.assertEqual(result['delivery_status'],'preparing')
        self.assertEqual(result['watcher'],'order-noon-iaega123')
        # register_tracker received the tracking eta through review seeding
        self.assertEqual(flow.review['eta'],'2026-10-10T14:44:00+04:00')
        complete.assert_called_once_with('f')


if __name__=='__main__':unittest.main()
