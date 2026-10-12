"""Journalled Minutes native operations with response-cookie lifecycle binding."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid

import commerce_journal as j
import commerce_receipts as receipts
import noon_minutes_checkout as m
from noon_auth_lifecycle import NoonAuthLifecycle
from noon_checkout import AccountHome

TELEGRAM_CLI = [str(Path.home() / '.bun' / 'bin' / 'bun'),
                str(Path.home() / '.local/share/telegram-bridge/src/cli.ts'), 'notify']
WATCH_BIN = str(Path.home() / '.local/bin/order-watch')
WATCH_ORDERS = Path.home() / '.local/state/order-tracker/orders'
WATCH_WATCHERS = Path.home() / '.local/share/robob-watch/watchers'
LOCAL_ISO = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$')


def readback_session(auth, *, timeout=25):
    """Native existing-session readback `{}`; never sync/reset/place/pay."""
    status=auth.status('minutes')
    snap=auth.reconcile('minutes') if status['maintenance_state']!='none' else auth.revalidate('minutes')
    observations=[]
    data=None
    try:
        data=m.native_request('session_get',snap.read_headers(),time.monotonic()+timeout,{},
            response_observer=observations.append)
        return m.Snapshot(data,m.project_session(data),time.time())
    finally:
        for observed in observations:
            auth.retain_response_cookies('minutes',snap,observed.set_cookies,
                response_url=observed.response_url,http_status=observed.http_status)


def readback_active_orders(auth, *, timeout=25):
    """Native order/get-active readback `{}`; any active order blocks a new place."""
    status=auth.status('minutes')
    snap=auth.reconcile('minutes') if status['maintenance_state']!='none' else auth.revalidate('minutes')
    observations=[]
    data=None
    try:
        data=m.native_request('order_get_active',snap.read_headers(),time.monotonic()+timeout,{},
            response_observer=observations.append)
        return m.Snapshot(data,m.project_active(data),time.time())
    finally:
        for observed in observations:
            auth.retain_response_cookies('minutes',snap,observed.set_cookies,
                response_url=observed.response_url,http_status=observed.http_status)


def exact_failed_evidence(auth, order, *, timeout=25):
    """Exact merchant proof that a minutes order is dead and unpaid.

    Requires order/get failed-or-cancelled with echoed identity, absence from
    order/get-active, and — when an intent token is still returned — an
    unconsumed, uncaptured paymentintent/status. Any other state refuses.
    """
    manager=auth
    current=None
    def headers(operation,deadline):
        nonlocal current
        state=manager.status('minutes')
        current=manager.reconcile('minutes') if state['maintenance_state']!='none' else manager.revalidate('minutes',deadline=deadline)
        return current.read_headers()
    first=headers('order_get',time.monotonic()+timeout)
    def cookies(operation,values,*,response_url,http_status,outcome_journaled):
        manager.retain_response_cookies('minutes',current,values,response_url=response_url,
            http_status=http_status)
        return True
    client=m.MinutesCheckout(first,AccountHome('minutes',current.account_ref,current.address_ref,time.time()),
        header_provider=headers,response_cookies=cookies)
    order_snap=client.order_status(order,timeout=timeout)
    active=client.active_orders(timeout=timeout).projection
    evidence={'order_get':{'raw_status':order_snap.projection['raw_status'],
        'identity_echoed':order_snap.projection['identity_echoed'],
        'payment_intent_present':order_snap.projection['payment_intent_present'],
        'total_minor':m.amount_minor(order_snap.wire['orderTotal'])},
        'active_orders':[row['order'] for row in active['active']]}
    intent=order_snap.wire.get('paymentIntentToken')
    if type(intent) is str and intent:
        try:
            wire=client.payment_status(order=order,client_secret=intent,timeout=timeout).wire
        except m.MinutesError as exc:
            # A dead failed/cancelled order's intent read is rejected as gone;
            # that corroborates closure. Auth and other failures still surface.
            if exc.code not in ('HTTP_400','HTTP_404'):
                raise
            wire={}
        evidence['payment_intent']={
            'status':wire.get('status'),'transaction_status':wire.get('transaction_status'),
            'authorized_minor':m.amount_minor(wire['authorized_amount'])
                if wire.get('authorized_amount') is not None else None,
            'captured_minor':m.amount_minor(wire['captured_amount'])
                if wire.get('captured_amount') is not None else None,
            'is_3ds_failure':wire.get('is_3ds_failure')}
    order_get=evidence['order_get']
    if order_get['raw_status'] not in ('failed','cancelled') or order_get['identity_echoed'] is not True:
        j.fail('RELEASE_EVIDENCE_ORDER_NOT_DEAD')
    if order in evidence['active_orders']:
        j.fail('RELEASE_EVIDENCE_ORDER_STILL_ACTIVE')
    if 'payment_intent' in evidence:
        intent_state=evidence['payment_intent']
        if (intent_state['status']=='payment_confirmed' or intent_state['transaction_status']=='CAPTURED'
                or (intent_state['authorized_minor'] or 0)>0 or (intent_state['captured_minor'] or 0)>0):
            j.fail('RELEASE_EVIDENCE_INTENT_NOT_CLEARED')
    return evidence


def telegram_3ds_notify(order,total_minor):
    """One attention ping for the owner's out-of-band ENBD 3DS approval."""
    text=(f"Noon Minutes CLI test order {order} AED {m.wire_amount(total_minor):g} needs ENBD 3DS "
          "approval: open ENBD X app notification / Activity and approve. ~2 min window.")
    env={k:v for k,v in os.environ.items() if k not in ('NODE_OPTIONS','BUN_OPTIONS','BUN_INSPECT')}
    command=[*TELEGRAM_CLI,'--source','Minutes CLI build','--severity','attention',
             '--text',text,'--key',f'minutes-cli-3ds-{order}']
    try:
        result=subprocess.run(command,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
    except (OSError,subprocess.TimeoutExpired):
        j.fail('MINUTES_3DS_NOTIFY_FAILED')
    if result.returncode:j.fail('MINUTES_3DS_NOTIFY_FAILED')
    return {'notified':True,'key':f'minutes-cli-3ds-{order}'}


def _rows(rows):
    """items-file rows {sku,qty,...}: 'modifiers' defaults to () (contract
    keeps modifiers optional); everything else validated by m._skus()."""
    if not isinstance(rows,(list,tuple)):
        return rows  # let m._skus raise its native INVALID_LINES
    out=[]
    for row in rows:
        if isinstance(row,dict) and 'modifiers' not in row:
            row=dict(row); row['modifiers']=()
        out.append(row)
    return out


class MinutesFlow:
    def __init__(self, *, skus=None, items=None, auth=None):
        # Lane-native validation strictly BEFORE any auth/network work.
        if skus is not None and items is not None:
            j.fail('MINUTES_ITEMS_CONFLICT')
        self.skus=m._skus(_rows(skus if skus is not None else items))
        if not self.skus:
            j.fail('MINUTES_SKUS_REQUIRED')
        self.auth=auth or NoonAuthLifecycle()
        self.snapshot=self.auth.fresh_before_mutation('minutes')
        j.require_account_available('noon',self.snapshot.account_ref)
        self.flow_id=str(uuid.uuid4())
        self.scope_hash=j.digest({'skus':self.skus,'home':self.snapshot.address_ref,
                                  'card':'5542','quiet':True,'extras':False})
        self.opened=False
        self.expected=None
        self.review=None
        self.current=None
        self.intent=None  # RAM-only paymentIntentToken; never persisted or printed
        self.cookies_in_ram=[]
        self.cart_hash=j.digest({'flow_id':self.flow_id,'account':self.snapshot.account_ref,'scope':self.scope_hash})
        self.store=receipts.create(flow_id=self.flow_id,app='noon',vertical='minutes',
            account_hash=self.snapshot.account_ref,scope_hash=self.scope_hash)
        self.client=m.MinutesCheckout(self.snapshot.read_headers(),
            AccountHome('minutes',self.snapshot.account_ref,self.snapshot.address_ref,time.time()),
            header_provider=self._headers,receipt=self._receipt,response_cookies=self._cookies)

    def _headers(self,operation,deadline):
        status=self.auth.status('minutes')
        snapshot=(self.auth.reconcile('minutes') if status['maintenance_state']!='none'
                  else self.auth.fresh_before_mutation('minutes',deadline=deadline))
        if (snapshot.account_ref!=self.snapshot.account_ref or snapshot.address_ref!=self.snapshot.address_ref):
            j.fail('MINUTES_ACCOUNT_HOME_CHANGED')
        self.snapshot=snapshot
        return snapshot.mutation_headers('minutes') if operation in m.WRITES else snapshot.read_headers()

    def _before(self,operation,body_hash):
        if self.expected is None or (operation,body_hash)!=self.expected:
            j.fail('MINUTES_REQUEST_NOT_BOUND')
        kinds={'session_get':'cart','sync':'cart','instructions':'instructions',
               'payment':'selection','place':'place','payment_complete':'payment'}
        kind=kinds[operation]
        financial=kind in ('place','payment')
        if financial and self.review is None:
            j.fail('MINUTES_EXACT_REVIEW_REQUIRED')
        if not self.opened:
            j.open_flow(flow_id=self.flow_id,app='noon',vertical='minutes',
                account_hash=self.snapshot.account_ref,scope_hash=self.scope_hash)
            self.opened=True
        journal_operation=(getattr(self,'_readback_operation',None)
                           if operation=='session_get' else None) or operation
        result=j.consume(self.flow_id,journal_operation,kind=kind,request_hash=body_hash,
            cart_hash=self.cart_hash,review_hash=self.review['digest'] if financial else None,
            payable_minor=self.review['amount'] if financial else None,
            payment_order_id=self.review.get('order') if kind=='payment' else None)
        self.expected=None
        return result

    def _receipt(self,record):
        operation=record['operation']
        if operation in ('place','payment_complete'):
            self.store.append(receipts.Receipt(operation='place' if operation=='place' else 'payment',
                state='SUBMISSION_UNKNOWN' if record['outcome']=='UNKNOWN' else record['outcome'],
                http_status=record['http_status'],order_id=record['order_id'],
                payable_minor=self.review['amount'],currency='AED',review_sha256=self.review['digest']))
        journal_operation=(getattr(self,'_readback_operation',None)
                           if operation=='session_get' else None) or operation
        j.observe(self.flow_id,journal_operation,outcome=record['outcome'],
            evidence_hash=record['evidence_hash'],order_id=record['order_id'])
        return True

    def _cookies(self,operation,values,*,response_url,http_status,outcome_journaled):
        pending=(self.snapshot,tuple(values),response_url,http_status)
        self.cookies_in_ram.append(pending)
        if operation in m.WRITES and not outcome_journaled:
            return True
        self.auth.retain_response_cookies('minutes',pending[0],pending[1],
            response_url=response_url,http_status=http_status)
        self.cookies_in_ram.remove(pending)
        return True

    def _expect(self,operation,body):
        self.expected=(operation,hashlib.sha256(m._json(body)).hexdigest())

    def initial_session(self):
        self._expect('session_get',{})
        self.current=self.client.get_session(before_send=self._before,timeout=25)
        return self.current.projection

    def fill_empty(self):
        if self.current is None or self.current.projection['lines']:
            j.fail('EXISTING_MINUTES_CART_MUST_NOT_BE_REPLACED')
        self._expect('sync',{'skus':self.skus,'bundles':[],'refresh':False})
        self.current=self.client.sync(skus=self.skus,bundles=[],refresh=False,before_send=self._before,timeout=25)
        return self.current.projection

    def refresh_cart_readback(self):
        """Re-read the exact current session, never replay a cart mutation.

        The captured session/get route is a POST, so retain its journal and
        response-cookie guarantees under a fresh observation name. This is
        deliberately not sync(refresh=True), which could mutate the basket.
        """
        self._readback_operation='session_readback_'+uuid.uuid4().hex
        self.review=None
        try:
            self._expect('session_get',{})
            self.current=self.client.get_session(before_send=self._before,timeout=25)
        finally:
            self._readback_operation=None
        return self.current.projection

    @classmethod
    def resume_exact_sync(cls, flow_id, *, skus=None, items=None, auth=None):
        """Recover only our recorded Minutes sync using exact native readback."""
        if skus is not None and items is not None:
            j.fail('MINUTES_ITEMS_CONFLICT')
        normalized = m._skus(_rows(skus if skus is not None else items))
        if not normalized:
            j.fail('MINUTES_SKUS_REQUIRED')
        binding=j.binding(flow_id)
        if binding['app']!='noon' or binding['vertical']!='minutes':j.fail('MINUTES_FLOW_REQUIRED')
        self=object.__new__(cls)
        self.auth=auth or NoonAuthLifecycle()
        self.current=readback_session(self.auth)
        self.snapshot=self.auth.reconcile('minutes') if self.auth.status('minutes')['maintenance_state']!='none' else self.auth.revalidate('minutes')
        self.flow_id=flow_id;self.skus=normalized
        self.scope_hash=j.digest({'skus':self.skus,'home':self.snapshot.address_ref,
                                  'card':'5542','quiet':True,'extras':False})
        if self.scope_hash!=binding['scope_hash'] or self.snapshot.account_ref!=binding['account_hash']:
            j.fail('MINUTES_RECOVERY_SCOPE_MISMATCH')
        actual=[(x['sku'],x['quantity'],tuple(x['modifiers'])) for x in self.current.projection['lines']]
        expected=[(x['sku'],x['qty'],tuple(x['modifiers'])) for x in self.skus]
        if actual!=expected or any(x['is_freebie'] or x['bundle_present'] or x['deal_code'] for x in self.current.projection['lines']):
            j.fail('MINUTES_RECOVERY_MANIFEST_MISMATCH')
        request=hashlib.sha256(m._json({'skus':self.skus,'bundles':[],'refresh':False})).hexdigest()
        j.reconcile_preparation(flow_id,'sync',request_hash=request,evidence_hash=j.digest(self.current.projection))
        self.opened=True;self.expected=None;self.review=None;self.cookies_in_ram=[]
        self.intent=None
        self.cart_hash=j.digest({'flow_id':flow_id,'account':self.snapshot.account_ref,'scope':self.scope_hash})
        self.store=receipts.load(**binding)
        self.client=m.MinutesCheckout(self.snapshot.read_headers(),
            AccountHome('minutes',self.snapshot.account_ref,self.snapshot.address_ref,time.time()),
            header_provider=self._headers,receipt=self._receipt,response_cookies=self._cookies)
        return self

    @classmethod
    def resume_active(cls, flow_id, *, skus=None, items=None, auth=None):
        """Continue an ACTIVE preparation flow from exact native readback.

        Only for flows whose consumed operations are non-financial (cart/
        instructions/selection): the readback must match the recorded scope
        manifest exactly. Nothing is re-sent; the next operation continues
        where the previous process stopped. Accepts skus= (legacy) or items=.
        """
        if skus is not None and items is not None:
            j.fail('MINUTES_ITEMS_CONFLICT')
        normalized = m._skus(_rows(skus if skus is not None else items))
        if not normalized:
            j.fail('MINUTES_SKUS_REQUIRED')
        binding=j.binding(flow_id);state=j.inspect(flow_id)
        if (binding['app']!='noon' or binding['vertical']!='minutes'):j.fail('MINUTES_FLOW_REQUIRED')
        if (state['state']!='ACTIVE' or state['order_id']
                or any(x['kind'] in ('place','payment','preauthorize','prepay')
                       for x in state['operations'])):
            j.fail('MINUTES_ACTIVE_PREPARATION_REQUIRED')
        self=object.__new__(cls)
        self.auth=auth or NoonAuthLifecycle()
        self.current=readback_session(self.auth)
        self.snapshot=self.auth.reconcile('minutes') if self.auth.status('minutes')['maintenance_state']!='none' else self.auth.revalidate('minutes')
        self.flow_id=flow_id;self.skus=normalized
        self.scope_hash=j.digest({'skus':self.skus,'home':self.snapshot.address_ref,
                                  'card':'5542','quiet':True,'extras':False})
        if self.scope_hash!=binding['scope_hash'] or self.snapshot.account_ref!=binding['account_hash']:
            j.fail('MINUTES_RECOVERY_SCOPE_MISMATCH')
        actual=[(x['sku'],x['quantity'],tuple(x['modifiers'])) for x in self.current.projection['lines']]
        expected=[(x['sku'],x['qty'],tuple(x['modifiers'])) for x in self.skus]
        if any(x['is_freebie'] or x['bundle_present'] or x['deal_code'] for x in self.current.projection['lines']):
            j.fail('MINUTES_RECOVERY_MANIFEST_MISMATCH')
        if sorted(actual)!=sorted(expected):
            j.fail('MINUTES_RECOVERY_MANIFEST_MISMATCH')
        self.opened=True;self.expected=None;self.review=None;self.intent=None
        self.cookies_in_ram=[]
        self.cart_hash=j.digest({'flow_id':flow_id,'account':self.snapshot.account_ref,'scope':self.scope_hash})
        self.store=receipts.load(**binding)
        self.client=m.MinutesCheckout(self.snapshot.read_headers(),
            AccountHome('minutes',self.snapshot.account_ref,self.snapshot.address_ref,time.time()),
            header_provider=self._headers,receipt=self._receipt,response_cookies=self._cookies)
        return self

    def select_quiet(self):
        # The captured app sets exactly these two codes; noon may expose other
        # non-quiet codes (e.g. delivery_instructions) that stay untouched.
        required={'dont_ring_the_bell','leave_it_at_my_door'}
        observed=self.current.projection['delivery_preferences']
        codes={x['code'] for x in observed} if observed else set()
        if not required <= codes:
            j.fail('QUIET_CODES_UNSUPPORTED')
        body={'deliveryPreferences':{code:True for code in sorted(required)},
              'driverNotes':m.QUIET_NOTE,'save':False}
        self._expect('instructions',body)
        self.current=self.client.set_delivery_instructions(preferences=body['deliveryPreferences'],
            driver_notes=body['driverNotes'],save=False,before_send=self._before,timeout=25)
        return self.current.projection

    def approve(self):
        snapshot=self.current
        card=m.saved_card_5542(self.client.payment_cards(timeout=25).wire)
        p=snapshot.projection;wire=snapshot.wire
        fee_keys={'orderDeliveryFee','orderServiceFee','orderSmallOrderFee','orderGiftBagFee',
                  'orderPaymentFee','orderCodFee','orderBulkyOrderFee','orderConvenienceFee','orderLateNightFee'}
        if set(k for k in wire if k.endswith('Fee')) != fee_keys:j.fail('MINUTES_FEE_SCHEMA_CHANGED')
        fees={key:m.amount_minor(wire[key]) for key in fee_keys}
        if (p['subtotal_minor']+sum(fees.values())!=p['total_minor']
                or p['total_minor']<=0
                or any(fees[k] for k in ('orderGiftBagFee','orderPaymentFee','orderCodFee'))):
            j.fail('MINUTES_FEE_ARITHMETIC_OR_EXTRAS')
        digest=m.review_snapshot(snapshot,expected_skus=self.skus,expected_total_minor=p['total_minor'],
            required_preferences=('dont_ring_the_bell','leave_it_at_my_door'),card=card)
        self.review={'digest':digest,'amount':p['total_minor']}
        self.card=card
        return {'payable_minor':p['total_minor'],'subtotal_minor':p['subtotal_minor'],'fees':fees,
                'card_last4':'5542','home':'Banyantree2104','quiet':True,'review_hash':digest}

    def prepare_only(self):
        """Non-financial prepare-only: cart fill, quiet, frozen review; STOP.

        Fresh flow: initial_session -> fill_empty -> select_quiet -> approve
        and STOPS before place(): no financial send of any kind. Resumed
        flow: consumed journal operations are skipped by name (session_get /
        sync / instructions are one-shot); the exact readback carried by
        resume_active() is re-reviewed fresh. The flow stays ACTIVE for a
        later explicit order.
        """
        consumed = ({x['name'] for x in j.inspect(self.flow_id)['operations']}
                    if self.opened else set())
        if self.current is None:
            if 'session_get' not in consumed:
                self.initial_session()
            if 'sync' not in consumed:
                self.fill_empty()
        if 'instructions' not in consumed:
            self.select_quiet()
        self.refresh_cart_readback()
        review = self.approve()
        return {'flow_id': self.flow_id, 'review': review, 'prepared_only': True,
                'readback': dict(self.current.projection)}

    def place(self):
        if self.review is None:j.fail('MINUTES_REVIEW_REQUIRED')
        approved=dict(self.review)
        self.refresh_cart_readback()
        self.approve()
        if self.review!=approved:
            j.fail('MINUTES_REVIEW_CHANGED_BEFORE_PLACE')
        self._guard_active_orders()
        self._expect('place',{'total':m.wire_amount(self.review['amount'])})
        result=self.client.place_order(total_minor=self.review['amount'],before_send=self._before,timeout=25)
        self.review['order']=result['order']
        return result

    def _guard_active_orders(self):
        """STOP before place while any active order exists; never blind-retry."""
        active=self.client.active_orders(timeout=25).projection
        if active['count']:
            print(json.dumps({'phase':'active_order_blocker',
                              'active_orders':active['active']}),flush=True)
            j.fail('MINUTES_ACTIVE_ORDER_PRESENT')
        return active

    @classmethod
    def resume_order(cls, flow_id, *, auth=None):
        binding=j.binding(flow_id);state=j.inspect(flow_id)
        if (binding['app']!='noon' or binding['vertical']!='minutes' or state['state']!='ACTIVE' or not state['order_id']
                or any(x['kind']=='payment' for x in state['operations'])):
            j.fail('MINUTES_PAYMENT_ALREADY_CONSUMED_OR_ORDER_MISSING')
        self=object.__new__(cls);self.auth=auth or NoonAuthLifecycle()
        self.current=readback_session(self.auth)
        self.snapshot=self.auth.reconcile('minutes') if self.auth.status('minutes')['maintenance_state']!='none' else self.auth.revalidate('minutes')
        if self.snapshot.account_ref!=binding['account_hash']:j.fail('MINUTES_RECOVERY_ACCOUNT_CHANGED')
        self.flow_id=flow_id;self.scope_hash=binding['scope_hash'];self.opened=True
        self.expected=None;self.cookies_in_ram=[];self.intent=None
        self.cart_hash=j.digest({'flow_id':flow_id,'account':self.snapshot.account_ref,'scope':self.scope_hash})
        self.store=receipts.load(**binding)
        placed=next(r for r in self.store.snapshot().receipts if r.operation=='place')
        if placed.order_id!=state['order_id'] or placed.payable_minor!=state['reserved_minor']:
            j.fail('MINUTES_PLACE_RECEIPT_MISMATCH')
        self.review={'digest':placed.review_sha256,'amount':placed.payable_minor,'order':placed.order_id}
        self.client=m.MinutesCheckout(self.snapshot.read_headers(),
            AccountHome('minutes',self.snapshot.account_ref,self.snapshot.address_ref,time.time()),
            header_provider=self._headers,receipt=self._receipt,response_cookies=self._cookies)
        self.card=m.saved_card_5542(self.client.payment_cards(timeout=25).wire)
        if (self.current.projection['payment']['token_ref']!=m.fingerprint(self.card.token)
                or self.current.projection['total_minor']!=self.review['amount']):
            j.fail('MINUTES_PAYMENT_CONTEXT_CHANGED')
        return self

    def complete(self, *, cvv_encryption=None, cvv=None):
        local=j.inspect(self.flow_id)
        if local['state']!='ACTIVE' or any(x['kind']=='payment' for x in local['operations']):
            j.fail('MINUTES_FINANCIAL_CONTINUATION_FENCED')
        order=self.review['order']
        status=self.client.order_status(order,timeout=25)
        if (status.projection['raw_status']!='pending' or not status.projection['identity_echoed']
                or not status.projection['payment_intent_present']
                or m.amount_minor(status.wire['orderTotal'])!=self.review['amount']):
            j.fail('MINUTES_EXACT_PENDING_INTENT_REQUIRED')
        session=self.current.wire
        if cvv is not None:
            if cvv_encryption is not None:j.fail('CVV_INPUT_AMBIGUOUS')
            from noon_cvv import encrypt
            config=self.client.payment_config(timeout=25)
            cvv_encryption=encrypt(config.wire,cvv)
        if session.get('isCvvRequired') is not False and cvv_encryption is None:
            j.fail('LEGITIMATE_CVV_ENCRYPTION_REQUIRED')
        provider=session.get('paymentProviderCode')
        if provider not in ('NOON_PAY','ADYEN','CHECKOUT'):j.fail('MINUTES_PAYMENT_PROVIDER_UNVERIFIED')
        optional={}
        for source,target in (('installmentCount','installments'),('paymentType','paymentType'),('idEmiPlan','idEmiPlan')):
            if source in status.wire:optional[target]=status.wire[source]
        for source,target in (('valuTenorMonth','tenorMonth'),('applePayToken','applePayToken'),
                              ('googlePayToken','googlePayToken'),('adcbTokenCode','adcbTokenCode')):
            if source in session:optional[target]=session[source]
        if any(v is not None for v in optional.values()):j.fail('MINUTES_OPTIONAL_PAYMENT_BRANCH_UNSUPPORTED')
        body={'clientSecret':status.wire['paymentIntentToken'],'paymentMethodCode':'cc_noonpay',
              'idCustomerToken':self.card.token,'cvvEncryption':cvv_encryption,'paymentProviderCode':provider,**optional}
        self._expect('payment_complete',body)
        self.intent={'secret':body['clientSecret']}
        for source,key in (('placedAt','placed_at'),('estimatedDeliveryAt','eta')):
            value=status.wire.get(source)
            if isinstance(value,str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}',value):
                self.review[key]=value+'+04:00'
            elif isinstance(value,str) and value:
                self.review[key]=value
        return self.client.complete_payment(order=order,client_secret=body['clientSecret'],card=self.card,
            provider_code=provider,cvv_encryption=cvv_encryption,optional_fields=optional,before_send=self._before,timeout=25).projection

    def notify_3ds(self):
        return telegram_3ds_notify(self.review['order'],self.review['amount'])

    def await_payment(self,*,notify=None,poll_seconds=5.0,wait_seconds=240.0,
                      sleep=time.sleep,clock=time.monotonic):
        """Poll the payment intent through the out-of-band 3DS window.

        notify(order,total_minor) runs exactly once before the first poll.
        Paid requires the captured terminal triple (payment_confirmed+CAPTURED+
        authorized==captured==total, error 0); a timeout never retries payment.
        """
        order=self.review['order']
        secret=self.intent['secret'] if self.intent else None
        if secret is None:
            status=self.client.order_status(order,timeout=25)
            if (not status.projection['payment_intent_present']
                    or status.projection['raw_status']!='pending'):
                j.fail('MINUTES_EXACT_PENDING_INTENT_REQUIRED')
            secret=status.wire['paymentIntentToken']
            self.intent={'secret':secret}
        if notify is not None:notify(order,self.review['amount'])
        deadline=clock()+wait_seconds
        polls=0
        last=None
        while True:
            try:
                snap=self.client.payment_intent_status(order=order,client_secret=secret,
                    total_minor=self.review['amount'],timeout=25)
                p=snap.projection
            except m.MinutesError as exc:
                # Transient read failures never end the wait and never resend
                # anything; auth loss must surface for an app rebind instead.
                if exc.code not in ('REQUEST_TIMEOUT','REQUEST_FAILED','RATE_LIMITED'):
                    raise
                p=None
            polls+=1
            if p is not None:
                seen=(p['payment_status'],p['transaction_status'])
                if seen!=last:
                    last=seen
                    print(json.dumps({'phase':'payment_poll','order':order,
                        'payment_status':p['payment_status'],
                        'transaction_status':p['transaction_status']}),flush=True)
                if p['paid']:
                    self._payment_receipt('PAYMENT_REPORTED_SUCCESS',p)
                    j.observe(self.flow_id,'payment_complete',outcome='PAYMENT_REPORTED_SUCCESS',
                        evidence_hash=j.digest({'flow_id':self.flow_id,'payment_status':p}),
                        order_id=order)
                    return {**p,'polls':polls,'timed_out':False}
                if p['state']=='payment_failed':
                    self._payment_receipt('PAYMENT_UNKNOWN',p)
                    return {**p,'polls':polls,'timed_out':False}
            if clock()>=deadline:
                if p is not None:self._payment_receipt('PAYMENT_PENDING',p)
                return {**(p or {}),'polls':polls,'timed_out':True,
                        'state':'payment_window_elapsed'}
            sleep(poll_seconds)

    def _payment_receipt(self,state,p):
        self.store.append(receipts.Receipt(operation='payment_status',state=state,
            http_status=200,order_id=self.review['order'],payable_minor=self.review['amount'],
            currency='AED',review_sha256=self.review['digest']))

    def verify_tracking(self,*,timeout=25):
        """Exact native track of OUR placed order; observe EXACT_ORDER_CONFIRMED."""
        tracking=self.client.track(self.review['order'],timeout=timeout)
        if (tracking.get('order')!=self.review['order']
                or tracking.get('identity_verified') is not True
                or tracking.get('account_verified') is not True
                or tracking.get('source')!='native_order_api'
                or tracking.get('status') not in {'placed','preparing','picked up',
                    'out for delivery','nearby','delivered'}):
            j.fail('EXACT_TRACKING_NOT_CONFIRMED')
        j.observe(self.flow_id,'payment_complete',outcome='EXACT_ORDER_CONFIRMED',
            evidence_hash=j.digest(tracking),order_id=self.review['order'])
        return tracking

    def register_tracker(self,label,*,placed_at=None,eta=None):
        """order-watch add with durable readback; observe TRACKER_REGISTERED."""
        order=self.review['order']
        name=f"order-noon-{order.lower()}"
        command=[WATCH_BIN,'add','--app','noon','--order',order,'--for','owner',
                 '--placed-at',placed_at or self.review.get('placed_at')
                 or dt.datetime.now(dt.timezone(dt.timedelta(hours=4))).isoformat(),
                 '--label',label]
        eta=eta or self.review.get('eta')
        if eta:command+=['--eta',eta]
        env={k:v for k,v in os.environ.items() if k not in ('NODE_OPTIONS','BUN_OPTIONS','BUN_INSPECT')}
        try:
            result=subprocess.run(command,env=env,stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,timeout=125)
        except (OSError,subprocess.TimeoutExpired):
            j.fail('TRACKER_REGISTRATION_UNCONFIRMED_READBACK_REQUIRED')
        try:
            config=json.loads((WATCH_ORDERS/f'{name}.json').read_text())
            watcher=json.loads((WATCH_WATCHERS/name/'watcher.json').read_text())
        except (OSError,ValueError):
            j.fail('TRACKER_REGISTRATION_UNCONFIRMED_READBACK_REQUIRED')
        if result.returncode or config.get('order')!=order or config.get('active') is not True or not watcher:
            j.fail('TRACKER_REGISTRATION_UNCONFIRMED_READBACK_REQUIRED')
        j.observe(self.flow_id,'payment_complete',outcome='TRACKER_REGISTERED',
            evidence_hash=j.digest({'watcher':name,'active':True}),order_id=order)
        return {'watcher':name,'registered':True}

    @classmethod
    def resume_payment(cls, flow_id, *, auth=None):
        """Status-only recovery: payment consumed, no PAYMENT_REPORTED_SUCCESS yet.

        The rebuilt client has no receipt hook, so no further mutation can be
        sent on this path; only order reads and status polling remain.
        """
        binding=j.binding(flow_id);state=j.inspect(flow_id)
        if (binding['app']!='noon' or binding['vertical']!='minutes' or state['state']!='ACTIVE'
                or not state['order_id'] or not any(x['kind']=='payment' for x in state['operations'])
                or any(x['kind'] not in ('cart','instructions','selection','place','payment')
                       for x in state['operations'])):
            j.fail('MINUTES_PAYMENT_RESUME_STATE_INVALID')
        self=object.__new__(cls);self.auth=auth or NoonAuthLifecycle()
        self.snapshot=self.auth.reconcile('minutes') if self.auth.status('minutes')['maintenance_state']!='none' else self.auth.revalidate('minutes')
        if self.snapshot.account_ref!=binding['account_hash']:j.fail('MINUTES_RECOVERY_ACCOUNT_CHANGED')
        self.flow_id=flow_id;self.scope_hash=binding['scope_hash'];self.opened=True
        self.expected=None;self.cookies_in_ram=[];self.current=None;self.intent=None
        self.cart_hash=j.digest({'flow_id':flow_id,'account':self.snapshot.account_ref,'scope':self.scope_hash})
        self.store=receipts.load(**binding)
        placed=next(r for r in self.store.snapshot().receipts if r.operation=='place')
        if placed.order_id!=state['order_id']:j.fail('MINUTES_PLACE_RECEIPT_MISMATCH')
        self.review={'digest':placed.review_sha256,'amount':placed.payable_minor,'order':placed.order_id}
        self.client=m.MinutesCheckout(self.snapshot.read_headers(),
            AccountHome('minutes',self.snapshot.account_ref,self.snapshot.address_ref,time.time()),
            header_provider=self._headers,response_cookies=self._cookies)
        return self
