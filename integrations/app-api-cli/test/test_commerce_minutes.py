from email.message import Message
from pathlib import Path
import base64
import contextlib
import io
import json
import os
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

import commerce_cli as cli
import commerce_minutes as c
from commerce_auth_status import CommerceAuth
from noon_auth_lifecycle import AuthSnapshot
from noon_checkout import fingerprint
from test.test_minutes_payment_chain import FIXTURE, ORDER, TOTAL_MINOR
from test.test_noon_minutes_checkout import Harness, HEADERS, fixture


class MinutesIntegrationTests(unittest.TestCase):
    def setUp(self):
        p=patch.object(c.options,'read_options',return_value={'groups':[]})
        p.start();self.addCleanup(p.stop)

    def test_auth_journal_cookie_order_and_restart_duplicate_fence(self):
        events=[]
        class Auth:
            def fresh_before_mutation(self,*args,**kwargs):
                events.append('auth')
                return AuthSnapshot('minutes',fingerprint('account'),
                    fingerprint(HEADERS['x-addresscode'],HEADERS['x-addresskey']),
                    time.time(),dict(HEADERS),time.monotonic()+30)
            def status(self,*args):return {'maintenance_state':'none'}
            def retain_response_cookies(self,*args,**kwargs):
                self.assert_observed()
                events.append('cookies')
        auth=Auth()
        empty=fixture();empty['items']=[]
        harness=Harness([empty,fixture()])
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(c.j,'ROOT',Path(temp).resolve()/'commerce'), \
                patch.object(c.receipts,'ROOT',Path(temp).resolve()/'commerce'):
            flow=c.MinutesFlow(skus=[c.m.sku_line('SYNTHETIC_SHAKE',1)],auth=auth)
            flow.client._request=harness.request
            def observed():
                self.assertTrue(all(x['state']=='OBSERVED' for x in c.j.inspect(flow.flow_id)['operations']))
            auth.assert_observed=observed
            flow.initial_session();flow.fill_empty()
            self.assertEqual([x[0] for x in harness.calls],['session_get','sync'])
            self.assertEqual(c.j.inspect(flow.flow_id)['reserved_minor'],0)
            with self.assertRaises(c.m.MinutesError):flow.initial_session()
            self.assertEqual(len(harness.calls),2)
            self.assertEqual(events[:3],['auth','auth','cookies'])

    def test_existing_cart_cannot_be_replaced(self):
        flow=object.__new__(c.MinutesFlow)
        flow.current=c.m.Snapshot(fixture(),c.m.project_session(fixture()),time.time())
        with self.assertRaisesRegex(c.j.JournalError,'MUST_NOT_BE_REPLACED'):flow.fill_empty()

    def test_use_current_cart_adopts_matching_cart_without_sync(self):
        flow=object.__new__(c.MinutesFlow)
        flow.use_current_cart=True
        flow.skus=c.m._skus([{'sku':'SYNTHETIC_SHAKE','qty':1,'modifiers':[]}])
        flow.current=c.m.Snapshot(fixture(),c.m.project_session(fixture()),time.time())
        flow.client=unittest.mock.Mock()
        self.assertTrue(flow.fill_empty()['lines'])
        self.assertTrue(flow.adopted_current_cart)
        flow.client.sync.assert_not_called()

    def test_use_current_cart_mismatch_refuses_without_sync(self):
        flow=object.__new__(c.MinutesFlow)
        flow.use_current_cart=True
        flow.skus=c.m._skus([{'sku':'SYNTHETIC_SHAKE','qty':2,'modifiers':[]}])
        flow.current=c.m.Snapshot(fixture(),c.m.project_session(fixture()),time.time())
        flow.client=unittest.mock.Mock()
        with self.assertRaisesRegex(c.m.MinutesError,'MINUTES_CURRENT_CART_MISMATCH'):flow.fill_empty()
        flow.client.sync.assert_not_called()

    def test_fenced_payment_never_reads_auth_or_sends(self):
        flow=object.__new__(c.MinutesFlow)
        flow.flow_id='10000000-0000-4000-8000-000000000001'
        with patch.object(c.j,'inspect',return_value={'state':'FENCED','operations':[]}), \
                patch.object(c,'readback_session',side_effect=AssertionError('must not read')):
            with self.assertRaisesRegex(c.j.JournalError,'CONTINUATION_FENCED'):
                flow.complete()

    def test_failed_exact_order_never_completes_payment(self):
        from unittest.mock import Mock
        flow=object.__new__(c.MinutesFlow)
        flow.flow_id='10000000-0000-4000-8000-000000000001'
        flow.review={'order':'IAEGA123','amount':1725}
        flow.client=Mock()
        flow.client.order_status.return_value=c.m.Snapshot({},
            {'raw_status':'failed','identity_echoed':True,'payment_intent_present':True},time.time())
        with patch.object(c.j,'inspect',return_value={'state':'ACTIVE','operations':[]}):
            with self.assertRaisesRegex(c.j.JournalError,'EXACT_PENDING_INTENT_REQUIRED'):
                flow.complete()
        flow.client.complete_payment.assert_not_called()

    def test_supported_cvv_and_null_fields_reach_single_bound_payment(self):
        from unittest.mock import Mock
        flow=object.__new__(c.MinutesFlow)
        flow.flow_id='10000000-0000-4000-8000-000000000001'
        flow.review={'order':'IAEGA123','amount':1725}
        flow.current=c.m.Snapshot({'isCvvRequired':True,'paymentProviderCode':'NOON_PAY'}, {},time.time())
        flow.card=c.m.SavedCard('synthetic-token','xxxx5542','mastercard')
        flow.client=Mock()
        flow.client.order_status.return_value=c.m.Snapshot({'orderTotal':17.25,
            'paymentIntentToken':'synthetic-intent','installmentCount':None,'paymentType':None,'idEmiPlan':None},
            {'raw_status':'pending','identity_echoed':True,'payment_intent_present':True},time.time())
        flow.client.payment_config.return_value=c.m.Snapshot({'cvv_encryption':{}},{},time.time())
        flow.client.complete_payment.return_value=c.m.Snapshot({}, {'payment_status':'payment_pending'},time.time())
        encrypted={'encCvv':'synthetic-cipher','publicKeyName':'synthetic-key'}
        with patch.object(c.j,'inspect',return_value={'state':'ACTIVE','operations':[]}), \
                patch('noon_cvv.encrypt',return_value=encrypted) as encrypt:
            result=flow.complete(cvv=b'007')
        encrypt.assert_called_once_with({'cvv_encryption':{}},b'007')
        kwargs=flow.client.complete_payment.call_args.kwargs
        self.assertEqual(kwargs['optional_fields'],{'installments':None,'paymentType':None,'idEmiPlan':None})
        self.assertEqual(kwargs['cvv_encryption'],encrypted)
        self.assertEqual(kwargs['order'],'IAEGA123')
        self.assertEqual(result['payment_status'],'payment_pending')

    def test_complete_captures_ram_intent_and_local_timestamps(self):
        from unittest.mock import Mock
        flow=object.__new__(c.MinutesFlow)
        flow.flow_id='10000000-0000-4000-8000-000000000001'
        flow.review={'order':'IAEGA123','amount':1725}
        flow.current=c.m.Snapshot({'isCvvRequired':False,'paymentProviderCode':'NOON_PAY'},{},time.time())
        flow.card=c.m.SavedCard('synthetic-token','xxxx5542','mastercard')
        flow.client=Mock()
        flow.client.order_status.return_value=c.m.Snapshot({'orderTotal':17.25,
            'paymentIntentToken':'synthetic-intent','placedAt':'2026-10-10T13:18:29',
            'estimatedDeliveryAt':'2026-10-10T13:28:57'},
            {'raw_status':'pending','identity_echoed':True,'payment_intent_present':True},time.time())
        flow.client.complete_payment.return_value=c.m.Snapshot({}, {'payment_status':'payment_pending'},time.time())
        with patch.object(c.j,'inspect',return_value={'state':'ACTIVE','operations':[]}):
            flow.complete()
        self.assertEqual(flow.intent,{'secret':'synthetic-intent'})
        self.assertEqual(flow.review['placed_at'],'2026-10-10T13:18:29+04:00')
        self.assertEqual(flow.review['eta'],'2026-10-10T13:28:57+04:00')


def _session_wire(cvv_required):
    """A fixture-based cart session that satisfies approve()'s fee and arithmetic gates."""
    import copy
    from test.test_noon_minutes_checkout import fixture as _fixture
    session=copy.deepcopy(_fixture())
    session['isCvvRequired']=cvv_required
    for key in ('orderDeliveryFee','orderServiceFee','orderSmallOrderFee','orderGiftBagFee',
                'orderPaymentFee','orderCodFee','orderBulkyOrderFee','orderConvenienceFee',
                'orderLateNightFee'):
        session[key]=0
    # Captured basket figures (order_get_pending): subtotal 6.25 + delivery 8 + small-order 3 = 17.25.
    session['orderSubtotal']=6.25
    session['orderTotal']=17.25
    session['orderPaymentAmount']=17.25
    session['orderDeliveryFee']=8.0
    session['orderSmallOrderFee']=3.0
    # complete() requires the session's payment provider (captured session: NOON_PAY).
    session['paymentProviderCode']='NOON_PAY'
    # The real quiet codes the flow requires (select_quiet/approve); the fixture's
    # synthetic codes are not these.
    session['deliveryPreferences']=[
        {'code':'dont_ring_the_bell','value':False,'title':'Do not ring bell'},
        {'code':'leave_it_at_my_door','value':False,'title':'Leave at door'}]
    session['driverNotes']=c.m.QUIET_NOTE
    return session


def _quiet_session_wire(cvv_required):
    import copy
    q=copy.deepcopy(_session_wire(cvv_required))
    q['deliveryPreferences']=[
        {'code':'dont_ring_the_bell','value':True,'title':'Do not ring bell'},
        {'code':'leave_it_at_my_door','value':True,'title':'Leave at door'}]
    return q


def _empty_session_wire(cvv_required):
    import copy
    empty=copy.deepcopy(_session_wire(cvv_required))
    empty['items']=[]
    return empty


def _saved_cards():
    # The saved card's id is the same token the session's paymentToken fingerprints to.
    return {'data':[{'id':'synthetic-payment-token','ccMasked':'xxxx5542','ccType':'mastercard',
                     'isDefault':True,'isDeleted':False}]}


class _NoonAuth:
    """Stands in for NoonAuthLifecycle (Keychain account storage and whoami).

    Every call hands out a fresh single-use snapshot, as the real lifecycle does.
    """
    def __init__(self, events):
        self.events=events

    def _snap(self):
        return AuthSnapshot('minutes',fingerprint('synthetic-account'),
            fingerprint(HEADERS['x-addresscode'],HEADERS['x-addresskey']),
            time.time(),dict(HEADERS),time.monotonic()+30)

    def status(self,*args,**kwargs):return {'maintenance_state':'none'}
    def fresh_before_mutation(self,*args,**kwargs):return self._snap()
    def reconcile(self,*args,**kwargs):return self._snap()

    def revalidate(self,*args,**kwargs):
        self.events.append('revalidate')
        return self._snap()

    def retain_response_cookies(self,*args,**kwargs):return True


class _NoonResponse:
    code=200

    def __init__(self, url, body):
        self.url=url;self.body=json.dumps(body).encode();self.headers=Message()

    def geturl(self):return self.url
    def read(self,_):return self.body
    def __enter__(self):return self
    def __exit__(self,*_):return False


class _NoonTransport:
    """noon's HTTP behind urllib's opener: serves the scripted bodies in call order."""
    def __init__(self, script, events):
        self.script=list(script);self.calls=[];self.events=events

    def build_opener(self,*handlers):return self

    def open(self, req, timeout=None):
        url=req.full_url.split('?')[0]
        route=next((name for name,(method,host,path) in c.m.ROUTES.items()
                    if req.get_method()==method and url=='https://'+host+path),url)
        self.calls.append((route,json.loads(req.data) if req.data else None))
        self.events.append(route)
        expected,body=self.script.pop(0) if self.script else (None,None)
        if route!=expected:
            raise OSError('unscripted noon request')
        return _NoonResponse(req.full_url,body)


def _noon_script(cvv_required):
    track={'csHelpLabels':{'orderNumber':ORDER},'status':'confirmed','title':'Order confirmed',
           'rider':{'showRiderDetails':False}}
    page={'orders':[{'orderNr':ORDER,'statusCode':'confirmed','placedAt':'2026-10-10T13:18:29',
                     'estimatedDeliveryText':'Arrives between: 01:20 - 01:30 PM'}]}
    return [
        # CLI active-order guard, then prepare_only(): options, cart, quiet, readback, review.
        ('order_get_active',FIXTURE['get_active']['resp']),
        ('catalog_search',{'hits':[{'sku':'SYNTHETIC_SHAKE','title':'Vanilla shake','isCustomizable':False}]}),
        ('session_get',_empty_session_wire(cvv_required)),
        ('sync',_session_wire(cvv_required)),
        ('instructions',_quiet_session_wire(cvv_required)),
        ('session_get',_quiet_session_wire(cvv_required)),
        ('payment_cards',_saved_cards()),
        # place(): readback, re-review, active-order guard, place.
        ('session_get',_quiet_session_wire(cvv_required)),
        ('payment_cards',_saved_cards()),
        ('order_get_active',FIXTURE['get_active']['resp']),
        ('place',FIXTURE['place']['resp']),
        # complete(cvv), the 3DS wait, then exact tracking.
        ('order_get',FIXTURE['order_get_pending']),
        ('payment_config',FIXTURE['config']),
        ('payment_complete',FIXTURE['complete']['resp']),
        ('payment_status',FIXTURE['status_confirmed']),
        ('track',track),
        ('orders',page),
    ]


PREPARE_SENDS=7


class OrderMinutesEndToEndTests(unittest.TestCase):
    """`commerce order minutes --cvv-from-keychain` through the real CLI, MinutesFlow
    constructor and client. Only the outside world is faked: noon's HTTP (urllib
    opener), the noon auth lifecycle, the Keychain CVV read and the Telegram /
    order-watch subprocesses. Journal, receipts, watcher files and card status
    live in a temp dir. CVV encryption is real, with the captured public key.
    """
    def order(self, *, cvv_required, seconds_before_place=0):
        events=[];commands=[]
        auth=_NoonAuth(events)
        transport=_NoonTransport(_noon_script(cvv_required),events)
        real_time=time.time;offset=[0.0]
        def keychain():
            events.append('keychain')
            offset[0]+=seconds_before_place
            return b'123'
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve()
            def run(command,**kwargs):
                commands.append(command)
                if command[:len(c.TELEGRAM_CLI)]==c.TELEGRAM_CLI:
                    return subprocess.CompletedProcess(command,0,b'',b'')
                if command[:2]==[c.WATCH_BIN,'add']:
                    name='order-noon-'+command[command.index('--order')+1].lower()
                    (root/'orders').mkdir(exist_ok=True)
                    (root/'orders'/f'{name}.json').write_text(json.dumps(
                        {'order':command[command.index('--order')+1],'active':True,'watcher':name}))
                    (root/'watchers'/name).mkdir(parents=True,exist_ok=True)
                    (root/'watchers'/name/'watcher.json').write_text(json.dumps({'watcher':True}))
                    return subprocess.CompletedProcess(command,0,
                        (json.dumps({'moni_notified':'skipped'})+'\n').encode(),b'')
                raise AssertionError('unexpected subprocess')
            with patch.object(c.j,'ROOT',root/'commerce'), \
                    patch.object(c.receipts,'ROOT',root/'commerce'), \
                    patch.object(c,'WATCH_ORDERS',root/'orders'), \
                    patch.object(c,'WATCH_WATCHERS',root/'watchers'), \
                    patch.dict(os.environ,{'CARD_STATUS_FILE':str(root/'card-status.json')}), \
                    patch.object(cli,'CommerceAuth',lambda:CommerceAuth(noon=auth)), \
                    patch.object(cli,'cvv_from_keychain',side_effect=keychain) as cvv, \
                    patch.object(c.m.urllib.request,'build_opener',transport.build_opener), \
                    patch.object(c.m.urllib.request,'urlopen',side_effect=AssertionError('network')), \
                    patch.object(c.subprocess,'run',run), \
                    patch.object(c.time,'time',lambda:real_time()+offset[0]), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                code=cli.main(['order','minutes','--sku','SYNTHETIC_SHAKE','--cvv-from-keychain',
                               '--label','minutes e2e test'])
                lines=[json.loads(x) for x in output.getvalue().splitlines() if x] or [{}]
                journal=c.j.inspect(lines[-1]['flow_id']) if lines[-1].get('flow_id') else None
        self.assertEqual(code,0,lines[-1])
        self.assertEqual([x[0] for x in transport.calls],[x[0] for x in _noon_script(cvv_required)])
        cvv.assert_called_once_with()
        return {'result':lines[-1],'lines':lines,'events':events,'calls':transport.calls,
                'commands':commands,'journal':journal}

    def test_order_minutes_cvv_basket_prepares_places_and_pays(self):
        """Done-when path 1: noon asks for CVV; the CLI reads it after preparation
        and before any place-phase send, and the order is placed and paid."""
        run=self.order(cvv_required=True)
        result=run['result']
        review=next(x for x in run['lines'] if x.get('phase')=='review')['review']
        self.assertTrue(review['cvv_required'])
        self.assertEqual((result['ok'],result['order'],result['payable_minor']),(True,ORDER,TOTAL_MINOR))
        self.assertEqual(result['paid']['payment_status'],'payment_confirmed')
        self.assertEqual(result['paid']['transaction_status'],'CAPTURED')
        self.assertEqual(result['paid']['captured_minor'],TOTAL_MINOR)
        self.assertEqual(result['paid']['authorized_minor'],TOTAL_MINOR)
        self.assertEqual(run['journal']['state'],'COMPLETE')
        routes=[x for x in run['events'] if x in c.m.ROUTES or x=='keychain']
        self.assertEqual(routes.index('keychain'),PREPARE_SENDS)
        # No clock gap: the verified home never needed a refresh after preparation.
        self.assertNotIn('revalidate',run['events'][run['events'].index('keychain'):])
        body=next(payload for route,payload in run['calls'] if route=='payment_complete')
        self.assertEqual(body['cvvEncryption']['publicKeyName'],'key_1')
        self.assertEqual(len(base64.b64decode(body['cvvEncryption']['encCvv'],validate=True)),256)
        alerts=[x for x in run['commands'] if x[:len(c.TELEGRAM_CLI)]==c.TELEGRAM_CLI]
        self.assertEqual(len(alerts),1)
        self.assertEqual(alerts[0][alerts[0].index('--key')+1],f'minutes-cli-3ds-{ORDER}')

    def test_order_minutes_places_and_pays_300s_after_preparation(self):
        """Done-when path 2: 300 s pass between real preparation and place. The home
        verified at flow creation is then too old, so the client refreshes it through
        the flow's own home provider before place goes out."""
        run=self.order(cvv_required=False,seconds_before_place=300)
        result=run['result']
        self.assertEqual((result['ok'],result['order']),(True,ORDER))
        self.assertEqual(result['paid']['transaction_status'],'CAPTURED')
        self.assertEqual(run['journal']['state'],'COMPLETE')
        events=run['events']
        self.assertIn('revalidate',events[events.index('keychain'):events.index('place')])


def paid_projection(status='payment_confirmed',txn='CAPTURED',authorized=1725,captured=1725,
                    error_code='0',failure=False):
    return {'order':'IAEGA123','payment_status':status,'transaction_status':txn,
            'authorized_minor':authorized,'captured_minor':captured,'error_code':error_code,
            'is_3ds_failure':failure,'paid':status=='payment_confirmed' and txn=='CAPTURED'
            and authorized==captured==1725 and error_code=='0',
            'redirect_required':False,
            'state':('paid' if (status=='payment_confirmed' and txn=='CAPTURED'
                    and error_code=='0' and authorized==captured==1725)
                    else 'payment_failed' if status in ('payment_failed','payment_error') or failure
                    else 'payment_in_progress'),
            'resend_allowed':False}


class PaymentAwaitTests(unittest.TestCase):
    def flow(self):
        from unittest.mock import Mock
        flow=object.__new__(c.MinutesFlow)
        flow.flow_id='10000000-0000-4000-8000-000000000001'
        flow.review={'order':'IAEGA123','amount':1725,'digest':'a'*64}
        flow.intent={'secret':'synthetic-intent'}
        flow.client=Mock()
        flow.store=Mock()
        return flow

    def test_paid_after_3ds_transitions_notifies_once_and_journals_success(self):
        import json as jsonlib
        flow=self.flow()
        flow.client.payment_intent_status.side_effect=[
            c.m.Snapshot({},paid_projection('payment_pending','CREATED',0,0,None),time.time()),
            c.m.Snapshot({},paid_projection('payment_ready_to_redirect','3DS_ENROLL_INITIATED',0,0,'0'),time.time()),
            c.m.Snapshot({},paid_projection(),time.time())]
        notified=[];clock=[0,0,5,10]
        def sleep(_):clock.append(clock[-1]+5)
        with patch.object(c.j,'observe') as observe, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            result=flow.await_payment(notify=lambda order,total:notified.append((order,total)),
                sleep=sleep,clock=lambda:clock.pop(0) if len(clock)>1 else clock[-1])
        self.assertEqual(notified,[('IAEGA123',1725)])
        self.assertTrue(result['paid']);self.assertFalse(result['timed_out'])
        self.assertEqual(result['polls'],3)
        observe.assert_called_once()
        self.assertEqual(observe.call_args.kwargs['outcome'],'PAYMENT_REPORTED_SUCCESS')
        self.assertEqual(observe.call_args.kwargs['order_id'],'IAEGA123')
        receipt=flow.store.append.call_args.args[0]
        self.assertEqual((receipt.operation,receipt.state),('payment_status','PAYMENT_REPORTED_SUCCESS'))
        polls=[jsonlib.loads(x)['payment_status'] for x in output.getvalue().splitlines() if x]
        self.assertEqual(polls,['payment_pending','payment_ready_to_redirect','payment_confirmed'])

    def test_window_elapsed_is_reported_not_retried(self):
        flow=self.flow()
        flow.client.payment_intent_status.return_value=c.m.Snapshot({},
            paid_projection('payment_pending','CREATED',0,0,None),time.time())
        with patch.object(c.j,'observe') as observe:
            result=flow.await_payment(notify=lambda *_:None,sleep=lambda _:None,
                clock=iter([0,240,241]).__next__)
        self.assertFalse(result['paid']);self.assertTrue(result['timed_out'])
        self.assertEqual(result['state'],'payment_window_elapsed')
        receipt=flow.store.append.call_args.args[0]
        self.assertEqual((receipt.operation,receipt.state),('payment_status','PAYMENT_PENDING'))
        observe.assert_not_called()

    def test_terminal_failure_is_reported_without_success_observation(self):
        flow=self.flow()
        flow.client.payment_intent_status.return_value=c.m.Snapshot({},
            paid_projection('payment_failed','FAILED',0,0,'1'),time.time())
        with patch.object(c.j,'observe') as observe:
            result=flow.await_payment(notify=lambda *_:None,sleep=lambda _:None,
                clock=lambda:0)
        self.assertEqual(result['state'],'payment_failed')
        receipt=flow.store.append.call_args.args[0]
        self.assertEqual((receipt.operation,receipt.state),('payment_status','PAYMENT_UNKNOWN'))
        observe.assert_not_called()

    def test_transient_read_failure_waits_but_auth_loss_surfaces(self):
        flow=self.flow()
        flow.client.payment_intent_status.side_effect=[
            c.m.MinutesError('REQUEST_TIMEOUT'),
            c.m.Snapshot({},paid_projection(),time.time())]
        with patch.object(c.j,'observe'):
            result=flow.await_payment(notify=lambda *_:None,sleep=lambda _:None,
                clock=iter([0,5,10]).__next__)
        self.assertTrue(result['paid'])
        flow.client.payment_intent_status.side_effect=c.m.MinutesError('AUTH_EXPIRED')
        with patch.object(c.j,'observe'),self.assertRaises(c.m.MinutesError):
            flow.await_payment(notify=lambda *_:None,sleep=lambda _:None,
                clock=iter([0,5]).__next__)

    def test_missing_intent_requires_exact_pending_order_readback(self):
        flow=self.flow();flow.intent=None
        flow.client.order_status.return_value=c.m.Snapshot({'paymentIntentToken':'x'},
            {'raw_status':'cancelled','identity_echoed':True,'payment_intent_present':True},time.time())
        with self.assertRaisesRegex(c.j.JournalError,'PENDING_INTENT_REQUIRED'):
            flow.await_payment(notify=lambda *_:None,sleep=lambda _:None,clock=lambda:0)
        flow.client.order_status.return_value=c.m.Snapshot({'paymentIntentToken':'synthetic-intent'},
            {'raw_status':'pending','identity_echoed':True,'payment_intent_present':True},time.time())
        flow.client.payment_intent_status.return_value=c.m.Snapshot({},paid_projection(),time.time())
        with patch.object(c.j,'observe'):
            self.assertTrue(flow.await_payment(notify=lambda *_:None,
                sleep=lambda _:None,clock=iter([0,5]).__next__)['paid'])

    def test_stall_alert_fires_once_after_300s_and_not_when_paid(self):
        flow=self.flow()
        stalls=[]
        # Unpaid for 320 s of fake clock time: stall once at >=300 s, never twice.
        flow.client.payment_intent_status.return_value=c.m.Snapshot({},
            paid_projection(status='payment_in_progress',txn='AUTHORIZED',authorized=0,captured=0,error_code='0'),time.time())
        now=[0.0]
        def clock():return now[0]
        def sleep(s):now[0]+=s
        with patch.object(c.j,'observe'):
            result=flow.await_payment(notify=lambda *_:None,stall=lambda o,t:stalls.append((o,t)),
                wait_seconds=320,poll_seconds=5,sleep=sleep,clock=clock)
        self.assertTrue(result['timed_out'])
        self.assertEqual(stalls,[('IAEGA123',1725)])
        # Paid before 300 s: the stall never fires.
        flow2=self.flow()
        flow2.client.payment_intent_status.return_value=c.m.Snapshot({},paid_projection(),time.time())
        quiet=[]
        now=[0.0]
        with patch.object(c.j,'observe'):
            paid=flow2.await_payment(notify=lambda *_:None,stall=lambda o,t:quiet.append((o,t)),
                wait_seconds=600,poll_seconds=5,sleep=sleep,clock=clock)
        self.assertTrue(paid['paid'])
        self.assertEqual(quiet,[])

    def test_place_refuses_cvv_asking_review_without_cvv_and_journals_nothing(self):
        from unittest.mock import Mock
        flow=object.__new__(c.MinutesFlow)
        flow.review={'amount':1725,'digest':'a'*64,'cvv_required':True}
        flow.client=Mock()
        flow.approve=Mock(side_effect=AssertionError('no approve before the CVV gate'))
        with patch.object(c.j,'consume',side_effect=AssertionError('no consume')) as consume, \
                patch.object(c.j,'fail',side_effect=c.j.JournalError('MINUTES_CVV_REQUIRED_USE_CVV_FROM_KEYCHAIN')):
            with self.assertRaisesRegex(c.j.JournalError,'MINUTES_CVV_REQUIRED_USE_CVV_FROM_KEYCHAIN'):
                flow.place()
        consume.assert_not_called()
        flow.client.place_order.assert_not_called()

    def test_fresh_home_returns_reverified_home_and_refuses_moved_address(self):
        # _fresh_home is what the client's home_provider calls once a home is >90 s
        # old: it re-verifies live auth and must refuse a moved account or address.
        from unittest.mock import Mock
        flow=object.__new__(c.MinutesFlow)
        flow.snapshot=AuthSnapshot('minutes',fingerprint('account'),
            fingerprint(HEADERS['x-addresscode'],HEADERS['x-addresskey']),
            time.time()-300,dict(HEADERS),time.monotonic()+30)
        flow.auth=Mock()
        flow.auth.status.return_value={'maintenance_state':'none'}
        fresh=AuthSnapshot('minutes',fingerprint('account'),
            fingerprint(HEADERS['x-addresscode'],HEADERS['x-addresskey']),
            time.time(),dict(HEADERS),time.monotonic()+30)
        flow.auth.revalidate.return_value=fresh
        home=flow._fresh_home(time.monotonic()+30)
        self.assertEqual(home.service,'minutes')
        self.assertEqual(home.account_ref,flow.snapshot.account_ref)
        self.assertGreater(home.checked_at,time.time()-5)
        moved=AuthSnapshot('minutes',fingerprint('account'),fingerprint('moved'),
            time.time(),dict(HEADERS),time.monotonic()+30)
        flow.auth.revalidate.return_value=moved
        with self.assertRaisesRegex(c.j.JournalError,'MINUTES_ACCOUNT_HOME_CHANGED'):
            flow._fresh_home(time.monotonic()+30)

    def test_place_rechecks_cvv_after_refresh_and_places_with_cvv_ready(self):
        from unittest.mock import Mock
        flow=object.__new__(c.MinutesFlow)
        flow.review={'amount':1725,'digest':'a'*64,'cvv_required':True}
        flow.client=Mock()
        flow.client.active_orders.return_value=c.m.Snapshot({},{'active':[],'count':0,'resend_allowed':False},time.time())
        flow.client.place_order.return_value={'order':'IAEGA123'}
        flow._expect=Mock()
        with patch.object(c.MinutesFlow,'approve',lambda self:self.review), \
                patch.object(c.MinutesFlow,'refresh_cart_readback',return_value={}), \
                patch.object(c.j,'consume',return_value=True):
            result=flow.place(cvv_ready=True)
        self.assertEqual(result['order'],'IAEGA123')
        self.assertEqual(flow.client.place_order.call_count,1)

    def test_telegram_notify_shape_and_failure(self):
        flow=self.flow()
        with patch.object(c.subprocess,'run') as run:
            run.return_value.returncode=0
            result=c.telegram_3ds_notify('IAEGA123',1725)
        self.assertEqual(result,{'notified':True,'key':'minutes-cli-3ds-IAEGA123'})
        command=run.call_args.args[0]
        self.assertIn('minutes-cli-3ds-IAEGA123',command)
        text=command[command.index('--text')+1]
        self.assertEqual(text,'this is ours: approve noon Minutes AED 17.25 in ENBD X now (order IAEGA123)')
        self.assertEqual(command[command.index('--source')+1],'Noon payment')
        self.assertEqual(command[command.index('--severity')+1],'attention')
        env=run.call_args.kwargs['env']
        self.assertNotIn('BUN_INSPECT',env)
        # Sent after the card went out: a failed alert is reported, never raised.
        failed={'notified':False,'key':'minutes-cli-3ds-IAEGA123','error':'MINUTES_3DS_NOTIFY_FAILED'}
        with patch.object(c.subprocess,'run',side_effect=OSError):
            self.assertEqual(c.telegram_3ds_notify('IAEGA123',1725),failed)
        with patch.object(c.subprocess,'run') as run:
            run.return_value.returncode=1
            self.assertEqual(c.telegram_3ds_notify('IAEGA123',1725),failed)


class ResumeActiveTests(unittest.TestCase):
    def setUp(self):
        p=patch.object(c.options,'read_options',return_value={'groups':[]})
        p.start();self.addCleanup(p.stop)

    def auth(self):
        snapshot_holder=[]
        class Auth:
            def _snap(self):
                return AuthSnapshot('minutes',fingerprint('account'),
                    fingerprint(HEADERS['x-addresscode'],HEADERS['x-addresskey']),
                    time.time(),dict(HEADERS),time.monotonic()+30)
            def fresh_before_mutation(self,*args,**kwargs):return self._snap()
            def revalidate(self,*args,**kwargs):return self._snap()
            def reconcile(self,*args,**kwargs):return self._snap()
            def status(self,*args):return {'maintenance_state':'none'}
            def retain_response_cookies(self,*args,**kwargs):return True
        return Auth()

    def test_select_quiet_tolerates_extra_nonquiet_codes(self):
        data=fixture()
        data['deliveryPreferences']=[
            {'code':'dont_ring_the_bell','value':False,'title':None},
            {'code':'leave_it_at_my_door','value':False,'title':None},
            {'code':'delivery_instructions','value':False,'title':None}]
        flow=object.__new__(c.MinutesFlow)
        flow.flow_id='10000000-0000-4000-8000-000000000005'
        flow.current=c.m.Snapshot(data,c.m.project_session(data),time.time())
        flow.expected=None;flow.review=None;flow.opened=True
        flow.snapshot=None;flow.cookies_in_ram=[];flow.store=None;flow.skus=[]
        flow.cart_hash='a'*64
        harness=Harness([fixture()])
        flow.client=harness.client
        from unittest.mock import Mock
        with patch.object(c.j,'consume',return_value=True) as consume, \
                patch.object(c.j,'observe',return_value={'outcome':'RESPONSE_RECEIVED'}):
            flow.store=Mock()
            flow.select_quiet()
        body=harness.calls[0][1]
        self.assertEqual(body['deliveryPreferences'],{'dont_ring_the_bell':True,'leave_it_at_my_door':True})
        self.assertNotIn('delivery_instructions',body['deliveryPreferences'])
        consume.assert_called_once()
        missing=fixture();missing['deliveryPreferences']=[{'code':'delivery_instructions','value':False,'title':None}]
        flow.current=c.m.Snapshot(missing,c.m.project_session(missing),time.time())
        with self.assertRaisesRegex(c.j.JournalError,'QUIET_CODES_UNSUPPORTED'):
            flow.select_quiet()

    def test_select_quiet_sends_only_offered_toggle_with_note(self):
        data=fixture()
        data['deliveryPreferences']=[{'code':'dont_ring_the_bell','value':False,'title':None}]
        flow=object.__new__(c.MinutesFlow)
        flow.flow_id='10000000-0000-4000-8000-000000000006'
        flow.current=c.m.Snapshot(data,c.m.project_session(data),time.time())
        flow.expected=None;flow.review=None;flow.opened=True;flow.driver_note=c.m.quiet_note()
        flow.snapshot=None;flow.cookies_in_ram=[];flow.store=None;flow.skus=[]
        flow.cart_hash='a'*64
        harness=Harness([fixture()])
        flow.client=harness.client
        from unittest.mock import Mock
        with patch.object(c.j,'consume',return_value=True), \
                patch.object(c.j,'observe',return_value={'outcome':'RESPONSE_RECEIVED'}):
            flow.store=Mock()
            flow.select_quiet()
        body=harness.calls[0][1]
        self.assertEqual(body['deliveryPreferences'],{'dont_ring_the_bell':True})
        self.assertEqual(body['driverNotes'],c.m.QUIET_NOTE)
        self.assertFalse(body['save'])

    def test_select_quiet_neither_toggle_offered_still_refuses(self):
        data=fixture()
        data['deliveryPreferences']=[{'code':'delivery_instructions','value':False,'title':None}]
        flow=object.__new__(c.MinutesFlow)
        flow.current=c.m.Snapshot(data,c.m.project_session(data),time.time())
        flow.expected=None;flow.review=None;flow.opened=True;flow.driver_note=c.m.quiet_note()
        with self.assertRaisesRegex(c.j.JournalError,'QUIET_CODES_UNSUPPORTED'):
            flow.select_quiet()

    def test_scope_digest_unchanged_without_extra_and_differs_with_extra(self):
        skus=[{'sku':'SYNTHETIC_SHAKE','qty':1,'modifiers':()}]
        home=fingerprint('home')
        old=c.j.digest({'skus':skus,'home':home,'card':'5542','quiet':True,'extras':False})
        self.assertEqual(c._scope_hash(skus,home,None),old)
        self.assertNotEqual(c._scope_hash(skus,home,'Gate 1'),old)

    def test_prepare_only_flags_quiet_toggle_not_offered(self):
        data=fixture()
        for key in ('orderDeliveryFee','orderServiceFee','orderSmallOrderFee','orderGiftBagFee',
                    'orderPaymentFee','orderCodFee','orderBulkyOrderFee','orderConvenienceFee','orderLateNightFee'):
            data[key]=0
        data['orderDeliveryFee']=8
        data['deliveryPreferences']=[{'code':'dont_ring_the_bell','value':True,'title':None}]
        flow=object.__new__(c.MinutesFlow)
        flow.current=c.m.Snapshot(data,c.m.project_session(data),time.time())
        flow.skus=[c.m.sku_line('SYNTHETIC_SHAKE',1)]
        flow.driver_note=c.m.quiet_note()
        from unittest.mock import Mock
        flow.client=Mock()
        with patch.object(c.m,'saved_card_5542',return_value=c.m.SavedCard('synthetic-payment-token','xxxx 5542','mastercard')):
            review=flow.approve()
        self.assertEqual(review['quiet_codes_set'],['dont_ring_the_bell'])
        self.assertEqual(review['quiet_codes_not_offered'],['leave_it_at_my_door'])
        self.assertTrue(review['quiet'])
        import commerce_cli
        self.assertEqual(commerce_cli.quiet_notice(review),commerce_cli.QUIET_NOT_OFFERED_NOTICE)

    def test_resume_active_continues_exact_cart_without_resending(self):
        from unittest.mock import patch
        auth=self.auth()
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(c.j,'ROOT',Path(temp).resolve()/'commerce'), \
                patch.object(c.receipts,'ROOT',Path(temp).resolve()/'commerce'):
            skus=[c.m.sku_line('SYNTHETIC_SHAKE',1)]
            flow=c.MinutesFlow(skus=skus,auth=auth)
            empty=fixture();empty['items']=[]
            flow.client._request=Harness([empty]).request
            flow.initial_session()
            flow.client._request=Harness([fixture()]).request
            flow.fill_empty()
            # Simulate a crash after the observed sync, then continue exactly.
            real=fixture()
            real['deliveryPreferences']=[
                {'code':'dont_ring_the_bell','value':False,'title':None},
                {'code':'leave_it_at_my_door','value':False,'title':None},
                {'code':'delivery_instructions','value':False,'title':None}]
            with patch.object(c,'readback_session',
                    return_value=c.m.Snapshot(real,c.m.project_session(real),time.time())):
                resumed=c.MinutesFlow.resume_active(flow.flow_id,skus=skus,auth=auth)
            self.assertEqual(resumed.flow_id,flow.flow_id)
            self.assertTrue(resumed.opened)
            harness=Harness([real])
            resumed.client._request=harness.request
            resumed.select_quiet()
            self.assertEqual([x[0] for x in harness.calls],['instructions'])
            # A flow that already placed or is fenced refuses this resume.
            state=c.j.inspect(flow.flow_id)
            with patch.object(c.j,'inspect',return_value={**state,'state':'FENCED'}), \
                    patch.object(c,'readback_session',side_effect=AssertionError), \
                    self.assertRaisesRegex(c.j.JournalError,'ACTIVE_PREPARATION_REQUIRED'):
                c.MinutesFlow.resume_active(flow.flow_id,skus=skus,auth=auth)
            with patch.object(c.j,'inspect',return_value={**state,'operations':
                    state['operations']+[{'name':'place','kind':'place','state':'OBSERVED'}]}), \
                    patch.object(c,'readback_session',side_effect=AssertionError), \
                    self.assertRaisesRegex(c.j.JournalError,'ACTIVE_PREPARATION_REQUIRED'):
                c.MinutesFlow.resume_active(flow.flow_id,skus=skus,auth=auth)
        # A mismatched server cart is never adopted.
        with patch.object(c.j,'binding',return_value={'app':'noon','vertical':'minutes',
                'flow_id':'f','account_hash':'a'*64,'scope_hash':'b'*64}), \
                patch.object(c.j,'inspect',return_value={'state':'ACTIVE','order_id':None,
                    'operations':[{'name':'sync','kind':'cart','state':'OBSERVED'}]}), \
                patch.object(c,'readback_session',side_effect=c.m.MinutesError('AUTH_EXPIRED')):
            with self.assertRaises(c.m.MinutesError):
                c.MinutesFlow.resume_active('f',skus=skus,auth=auth)


class ResumeAndCloseTests(unittest.TestCase):
    def test_exact_failed_evidence_accepts_rejected_dead_intent_only(self):
        from unittest.mock import Mock
        auth=Mock()
        auth.status.return_value={'maintenance_state':'none'}
        snap=c.m.Snapshot({'orderNr':'IAEGAFAILED1','statusCode':'failed',
            'orderTotal':0,'paymentIntentToken':'synthetic-intent'},
            {'raw_status':'failed','identity_echoed':True,'payment_intent_present':True},time.time())
        active=c.m.Snapshot({},{'active':[],'count':0,'resend_allowed':False},time.time())
        dead=c.m.Snapshot({'status':'unavailable'},{},time.time())
        client=Mock()
        client.order_status.return_value=snap
        client.active_orders.return_value=active
        client.payment_status.return_value=c.m.Snapshot({'status':'payment_confirmed',
            'transaction_status':'CAPTURED','authorized_amount':5,'captured_amount':5},
            {'order':'IAEGAFAILED1','payment_status':'payment_confirmed',
             'redirect_required':False,'state':'exact_order_readback_required',
             'resend_allowed':False},time.time())
        with patch.object(c.m,'MinutesCheckout',return_value=client), \
                patch.object(c.AccountHome,'__init__',return_value=None):
            with self.assertRaisesRegex(c.j.JournalError,'INTENT_NOT_CLEARED'):
                c.exact_failed_evidence(auth,'IAEGAFAILED1')
            # A 400/404 intent read corroborates closure; auth loss surfaces.
            client.payment_status.side_effect=c.m.MinutesError('HTTP_400')
            evidence=c.exact_failed_evidence(auth,'IAEGAFAILED1')
            self.assertEqual(evidence['payment_intent']['status'],None)
            client.payment_status.side_effect=c.m.MinutesError('AUTH_EXPIRED')
            with self.assertRaises(c.m.MinutesError):
                c.exact_failed_evidence(auth,'IAEGAFAILED1')

    def test_place_stops_on_active_order_before_consumption(self):
        import json as jsonlib
        from unittest.mock import Mock
        flow=object.__new__(c.MinutesFlow)
        flow.review={'amount':1725,'digest':'a'*64}
        flow.client=Mock()
        flow.client.active_orders.return_value=c.m.Snapshot({},
            {'active':[{'order':'IAEGAUNPAID1','raw_status':'pending','payment_intent_present':True}],
             'count':1,'resend_allowed':False},time.time())
        flow.client.place_order=Mock(side_effect=AssertionError('place must not run'))
        with patch.object(c.MinutesFlow,'approve',lambda self:self.review), \
                patch.object(c.MinutesFlow,'refresh_cart_readback',return_value={}), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            with self.assertRaisesRegex(c.j.JournalError,'MINUTES_ACTIVE_ORDER_PRESENT'):
                flow.place()
        surfaced=jsonlib.loads(output.getvalue().splitlines()[0])
        self.assertEqual(surfaced['active_orders'][0]['order'],'IAEGAUNPAID1')

    def test_paid_flow_closes_journal_with_tracking_and_watcher(self):
        from unittest.mock import Mock
        import json as jsonlib
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(c.j,'ROOT',Path(temp).resolve()/'commerce'), \
                patch.object(c.receipts,'ROOT',Path(temp).resolve()/'commerce'):
            flow=object.__new__(c.MinutesFlow)
            flow.flow_id='10000000-0000-4000-8000-000000000002'
            flow.review={'order':'IAEGA123','amount':1725,'digest':'b'*64,
                         'placed_at':'2026-10-10T13:18:29+04:00','eta':'2026-10-10T13:28:57+04:00'}
            c.j.open_flow(flow_id=flow.flow_id,app='noon',vertical='minutes',
                          account_hash='a'*64,scope_hash='b'*64)
            c.j.consume(flow.flow_id,'place',kind='place',request_hash='c'*64,
                        cart_hash='d'*64,review_hash='b'*64,payable_minor=1725)
            c.j.observe(flow.flow_id,'place',outcome='ORDER_ID_RECEIVED',
                        evidence_hash='e'*64,order_id='IAEGA123')
            c.j.consume(flow.flow_id,'payment_complete',kind='payment',request_hash='f'*64,
                        cart_hash='d'*64,review_hash='b'*64,payable_minor=1725,
                        payment_order_id='IAEGA123')
            c.j.observe(flow.flow_id,'payment_complete',outcome='RESPONSE_RECEIVED',
                        evidence_hash='1'*64,order_id='IAEGA123')
            flow.store=Mock()
            flow.client=Mock()
            flow.client.track.return_value={'order':'IAEGA123','status':'placed',
                'identity_verified':True,'account_verified':True,'saved_home_verified':True,
                'source':'native_order_api','eta':'2026-10-10T13:28:57+04:00'}
            # Journal completion is impossible before the paid observation.
            with self.assertRaises(c.j.JournalError):
                c.j.complete(flow.flow_id)
            c.j.observe(flow.flow_id,'payment_complete',outcome='PAYMENT_REPORTED_SUCCESS',
                        evidence_hash='1'*64,order_id='IAEGA123')
            tracking=flow.verify_tracking()
            self.assertEqual(tracking['status'],'placed')
            watcher_root=Path(temp)
            with patch.object(c,'WATCH_ORDERS',watcher_root/'orders'), \
                    patch.object(c,'WATCH_WATCHERS',watcher_root/'watchers'), \
                    patch.object(c.subprocess,'run') as run:
                run.return_value.returncode=0
                (watcher_root/'orders').mkdir()
                (watcher_root/'watchers'/'order-noon-iaega123').mkdir(parents=True)
                (watcher_root/'orders'/'order-noon-iaega123.json').write_text(
                    jsonlib.dumps({'order':'IAEGA123','active':True}))
                (watcher_root/'watchers'/'order-noon-iaega123'/'watcher.json').write_text(
                    jsonlib.dumps({'watcher':True}))
                registration=flow.register_tracker('minutes Grenade white chocolate x1 (CLI E2E test)')
            self.assertEqual(registration,{'watcher':'order-noon-iaega123','registered':True,
                'for':'owner','tracker_id':'order-noon-iaega123','watcher_registered':True,
                'moni_notified':'skipped','moni_notice_failed':False,'moni_notice_held':False,
                'delivery_card':None,'chat':None})
            command=run.call_args.args[0]
            self.assertEqual(command[command.index('--placed-at')+1],'2026-10-10T13:18:29+04:00')
            self.assertEqual(command[command.index('--eta')+1],'2026-10-10T13:28:57+04:00')
            self.assertEqual(command[command.index('--label')+1],
                             'minutes Grenade white chocolate x1 (CLI E2E test)')
            state=c.j.inspect(flow.flow_id)
            self.assertEqual(state['state'],'ACTIVE')
            self.assertEqual(c.j.complete(flow.flow_id)['state'],'COMPLETE')

    def test_tracking_mismatch_never_certifies(self):
        from unittest.mock import Mock
        flow=object.__new__(c.MinutesFlow)
        flow.flow_id='10000000-0000-4000-8000-000000000003'
        flow.review={'order':'IAEGA123'}
        flow.client=Mock()
        flow.client.track.return_value={'order':'IAEGAOTHER','status':'placed',
            'identity_verified':True,'account_verified':True,'source':'native_order_api'}
        with self.assertRaisesRegex(c.j.JournalError,'EXACT_TRACKING_NOT_CONFIRMED'):
            flow.verify_tracking()

    def test_registration_requires_durable_readback(self):
        from unittest.mock import Mock
        flow=object.__new__(c.MinutesFlow)
        flow.flow_id='10000000-0000-4000-8000-000000000004'
        flow.review={'order':'IAEGA123','placed_at':'2026-10-10T13:18:29+04:00'}
        with patch.object(c.subprocess,'run',side_effect=OSError):
            with self.assertRaisesRegex(c.j.JournalError,'TRACKER_REGISTRATION_UNCONFIRMED'):
                flow.register_tracker('label')


if __name__=='__main__':unittest.main()
