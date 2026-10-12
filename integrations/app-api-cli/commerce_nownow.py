"""Profile-bound NowNow exact reads using current auth overlays and retention."""
import time
import uuid
import hashlib

import commerce_journal as journal
from noon_auth_lifecycle import NoonAuthLifecycle
from noon_checkout import AccountHome
from noon_nownow_checkout import NowNowCheckout, WRITES
import noon_nownow_checkout as native
import commerce_receipts as receipts


def reader(*, auth=None, expected_account=None):
    auth=auth or NoonAuthLifecycle()
    def snapshot():
        return auth.reconcile('nownow') if auth.status('nownow')['maintenance_state']!='none' else auth.revalidate('nownow')
    current=snapshot()
    account,address=current.account_ref,current.address_ref
    if expected_account is not None and expected_account!=account:journal.fail('RECOVERY_ACCOUNT_CHANGED')
    retained=[]
    def headers(operation,deadline):
        nonlocal current
        if operation in WRITES:journal.fail('NOWNOW_FINANCIAL_REVIEW_REQUIRED')
        current=snapshot()
        if current.account_ref!=account or current.address_ref!=address:journal.fail('NOWNOW_ACCOUNT_HOME_CHANGED')
        return current.read_headers()
    def cookies(operation,values,*,response_url,http_status,outcome_journaled):
        retained.append((current,tuple(values),response_url,http_status))
        auth.retain_response_cookies('nownow',current,values,response_url=response_url,http_status=http_status)
        retained.clear()
        return True
    return NowNowCheckout(AccountHome('nownow',account,address,time.time()),
        header_provider=headers,response_cookies=cookies)


class NowNowFlow:
    """One explicitly owned store cart; review and controller are separate steps."""
    def __init__(self, *, store_code, products, auth=None, request=native.native_request):
        self.auth=auth or NoonAuthLifecycle()
        self.store_code=native.ident(store_code)
        self.products=tuple(products)
        if not self.products or any(type(code) is not str or type(qty) is not int or qty<1
                                    for code,qty in self.products):journal.fail('PRODUCT_MANIFEST_INVALID')
        if len({x[0] for x in self.products})!=len(self.products):journal.fail('PRODUCT_MANIFEST_DUPLICATE')
        self.snapshot=self._snapshot()
        self.account_hash,self.address_hash=self.snapshot.account_ref,self.snapshot.address_ref
        journal.require_account_available('noon',self.account_hash)
        self.flow_id=str(uuid.uuid4())
        self.scope_hash=journal.digest({'store':store_code,'products':self.products,'home':self.address_hash,'card':'5542'})
        self.opened=False;self.expected=None;self.session_code=None;self.current=None;self.review=None
        self.receipt_store=None;self.pending_cookies=[]
        self.preorder_intent_hash=None
        self.client=NowNowCheckout(AccountHome('nownow',self.account_hash,self.address_hash,time.time()),
            header_provider=self._headers,request=request,receipt=self._receipt,response_cookies=self._cookies)

    def _snapshot(self):
        return self.auth.reconcile('nownow') if self.auth.status('nownow')['maintenance_state']!='none' else self.auth.revalidate('nownow')

    def _headers(self,operation,deadline):
        self.snapshot=self._snapshot()
        if self.snapshot.account_ref!=self.account_hash or self.snapshot.address_ref!=self.address_hash:
            journal.fail('NOWNOW_ACCOUNT_HOME_CHANGED')
        return self.snapshot.mutation_headers('nownow') if operation in WRITES else self.snapshot.read_headers()

    def _expect(self,operation,body):
        self.expected=(operation,hashlib.sha256(native.seam._json(body)).hexdigest())

    def _before(self,operation,digest):
        if self.expected!=(operation,digest):journal.fail('NOWNOW_REQUEST_NOT_BOUND')
        journal.require_account_available('noon',self.account_hash,flow_id=self.flow_id if self.opened else None)
        kind={'cart_get':'quote','cart_validate':'quote','cart_create':'cart','product_edit':'cart','instructions':'instructions',
              'delivery_preference':'instructions','payment':'selection','place':'place',
              'payment_complete':'prepay' if self.preorder_intent_hash else 'payment',
              'payment_subscription':'preauthorize'}.get(operation)
        if kind is None:journal.fail('NOWNOW_CONTROLLER_OPERATION_UNPROVEN')
        financial=kind in ('place','payment','preauthorize','prepay')
        if financial and (self.review is None or time.time()-self.review.observed_at>60):
            journal.fail('NOWNOW_FRESH_REVIEW_REQUIRED')
        if financial and (self.review.account_ref!=self.account_hash or self.review.address_ref!=self.address_hash):
            journal.fail('NOWNOW_REVIEW_IDENTITY_CHANGED')
        if financial:
            from noon_nownow_review import require_same_review
            import json
            frozen=self.review;expected=json.loads(frozen.frozen_json)
            reviewed=self.review_cart(financials_minor=expected['amounts'],price_breakdown=expected['priceBreakdown'])
            require_same_review(frozen,reviewed,now=time.time())
        if not self.opened:
            journal.open_flow(flow_id=self.flow_id,app='noon',vertical='nownow',account_hash=self.account_hash,scope_hash=self.scope_hash)
            self.receipt_store=receipts.create(flow_id=self.flow_id,app='noon',vertical='nownow',
                account_hash=self.account_hash,scope_hash=self.scope_hash)
            self.opened=True
        name=operation if operation not in ('cart_get','product_edit') else operation+'_'+digest[:16]
        self.operation_name=name
        result=journal.consume(self.flow_id,name,kind=kind,request_hash=digest,
            cart_hash=journal.digest({'flow':self.flow_id,'store':self.store_code}),
            review_hash=self.review.digest if financial else None,
            payable_minor=self.review.payable_minor if financial else None,
            payment_order_id=getattr(self,'order',None) if kind=='payment' else None,
            payment_intent_hash=self.preorder_intent_hash if kind=='prepay' else None)
        self.expected=None
        return result

    def _receipt(self,record):
        if record['service']!='nownow':journal.fail('NOWNOW_RECEIPT_SCOPE_INVALID')
        if record['operation'] in ('place','payment_complete') and not (record['operation']=='payment_complete' and self.preorder_intent_hash):
            self.receipt_store.append(receipts.Receipt(operation='place' if record['operation']=='place' else 'payment',
                state='SUBMISSION_UNKNOWN' if record['outcome']=='UNKNOWN' else record['outcome'],
                http_status=record['http_status'],order_id=record['order_id'],currency='AED',
                payable_minor=self.review.payable_minor,review_sha256=self.review.digest))
        journal.observe(self.flow_id,self.operation_name,outcome=record['outcome'],
            evidence_hash=record['evidence_hash'],order_id=record['order_id'])
        self.last_receipt=dict(record)
        return True

    def _cookies(self,operation,values,*,response_url,http_status,outcome_journaled):
        pending=(self.snapshot,tuple(values),response_url,http_status);self.pending_cookies.append(pending)
        if operation in WRITES and not outcome_journaled:return True
        self.auth.retain_response_cookies('nownow',self.snapshot,values,response_url=response_url,http_status=http_status)
        self.pending_cookies.remove(pending);return True

    def create(self):
        # Recent-session native read preserves every unrelated store cart. It is
        # never a license to adopt a basket merely because its product matches.
        existing=self.client.recent_carts(timeout=25)
        if any(row['store_code']==self.store_code for row in existing.projection['carts']):
            journal.fail('EXISTING_STORE_CART_MUST_NOT_BE_ADOPTED')
        code,qty=self.products[0]
        if len(self.products)!=1 or qty!=1:journal.fail('FIRST_CART_SINGLE_UNIT_REQUIRED')
        body={'storeCode':self.store_code,'productCode':code,'modifiers':{}}
        self._expect('cart_create',body)
        result=self.client.create_cart(store_code=self.store_code,product_code=code,modifiers={},before_send=self._before,timeout=25)
        self.session_code=result.projection['session_code']
        return self.read_cart()

    def read_cart(self):
        self._expect('cart_get',{'storeCode':self.store_code})
        result=self.client.get_cart(self.store_code,before_send=self._before,timeout=25)
        if self.session_code is not None and result.projection.get('session_code')!=self.session_code:
            journal.observe(self.flow_id,self.operation_name,outcome='UNKNOWN',
                evidence_hash=journal.digest({'reason':'OWNED_SESSION_CHANGED'}))
            journal.fail('NOWNOW_OWNED_SESSION_CHANGED')
        self.current=result
        return result.projection

    def quiet(self):
        if self.current is None or self.session_code is None:journal.fail('OWNED_CART_REQUIRED')
        row=self.current.wire['data'];prefs=row.get('deliveryPreference')
        if type(prefs) is not dict or set(prefs)!={'dont_ring_the_bell','leave_it_at_my_door'}:
            journal.fail('NOWNOW_QUIET_PREFERENCE_SCHEMA_UNSUPPORTED')
        if any(type(v) is not bool for v in prefs.values()):journal.fail('NOWNOW_QUIET_PREFERENCE_DISABLED')
        selected={k:True for k in prefs}
        self._expect('delivery_preference',{'sessionCode':self.session_code,'deliveryPreference':selected})
        self.current=self.client.set_delivery_preference(session_code=self.session_code,preferences=selected,before_send=self._before,timeout=25)
        self._expect('instructions',{'sessionCode':self.session_code,'driverNotes':native.QUIET_NOTE})
        self.current=self.client.set_quiet_notes(session_code=self.session_code,before_send=self._before,timeout=25)
        return self.current.projection

    def select_card(self,card):
        body=native.payment_payload(self.session_code,card)
        self._expect('payment',body)
        self.current=self.client.set_payment_method(session_code=self.session_code,card=card,before_send=self._before,timeout=25)
        self.card=card
        from noon_nownow_controller import bind_card_sync
        self.controller_card={'id':card.token,'ccMasked':card.mask,'ccType':card.network,'isDeleted':False}
        self.card_binding=bind_card_sync(account_home=self.client._home,session_code=self.session_code,
            card=card,request_hash=hashlib.sha256(native.seam._json(body)).hexdigest(),
            receipt=self.last_receipt,response=self.current.wire,observed_at=self.current.observed_at)
        return self.current.projection

    def review_cart(self, *, financials_minor, price_breakdown):
        from noon_nownow_review import review_snapshot
        if self.current is None or self.session_code is None or not hasattr(self,'card'):
            journal.fail('OWNED_SESSION_CARD_REQUIRED')
        headers=self.snapshot.read_headers()
        self.review=review_snapshot(self.current,
            account_home=AccountHome('nownow',self.account_hash,self.address_hash,self.snapshot.checked_at),
            session_code=self.session_code,store_code=self.store_code,
            address_code=headers['x-addresscode'],address_key=headers['x-addresskey'],
            address_version=self.current.wire['data'].get('addressVersion'),
            expected_manifest=[{'productCode':code,'qty':qty,'modifiers':{},'notes':None} for code,qty in self.products],
            expected_financials_minor=financials_minor,expected_price_breakdown=price_breakdown,
            card=self.card,now=time.time(),card_binding=getattr(self,'card_binding',None))
        return self.review

    def controller_decision(self, controller, *, validation=None):
        from noon_nownow_review import continuation_decision
        if self.review is None:journal.fail('EXACT_REVIEW_REQUIRED')
        return continuation_decision(self.review,controller,now=time.time(),validation=validation)

    def validate_reviewed(self):
        """Current onValidate: exact native request, detached shallow merge, review."""
        from noon_nownow_review import require_same_review
        import json
        journal.require_account_available('noon',self.account_hash,flow_id=self.flow_id)
        if self.review is None or self.current is None:journal.fail('EXACT_REVIEW_REQUIRED')
        before=self.review;expected=json.loads(before.frozen_json)
        self._expect('cart_validate',{'sessionCode':self.session_code})
        response=self.client.validate_cart(self.session_code,store_code=self.store_code,before_send=self._before,timeout=25)
        merged=native.merge_validated_basket(self.current.wire['data'],response.wire['data'],
            session_code=self.session_code,store_code=self.store_code)
        self.current=native.Snapshot({'data':merged},native.project_cart({'data':merged}),response.observed_at)
        current=self.review_cart(financials_minor=expected['amounts'],price_breakdown=expected['priceBreakdown'])
        require_same_review(before,current,now=time.time())
        self.validation={'review_digest':current.digest,'observed_at':response.observed_at,
                         'checkoutWarningPopup':merged.get('checkoutWarningPopup')}
        return self.validation

    def native_controller_context(self):
        from noon_nownow_controller import selected_instrument,finalize_input,source_flags
        if self.review is None or not hasattr(self,'controller_card'):journal.fail('DURABLE_CARD_SYNC_REQUIRED')
        instrument=selected_instrument(self.controller_card)
        flags=source_flags(self.current.wire['data'])
        # Exact native onSync/onFinalize object, not an HTTP payload or fake
        # basket echo. No-wallet scope deliberately passes zero available credit.
        context=finalize_input(instrument)
        controller={'observed_at':time.time(),'review_digest':self.review.digest,'status':'idle',
            'orderPaymentAmount':self.review.payable_minor/100,'selection':instrument,
            'wallet':{'enabled':False},**flags}
        return controller,context

    def authorize_preorder(self, *, cvv, vault=None):
        """Native CVV branch: full budget reserved before subscription creation.

        This is financial authorization before an order exists, not zero-cost
        staging. Every unknown or challenge fences place; no mutation retry.
        """
        from commerce_preorder import IntentVault,payment_outcome
        from noon_cvv import encrypt
        from noon_checkout import fingerprint
        journal.require_account_available('noon',self.account_hash,flow_id=self.flow_id)
        if self.review is None:journal.fail('EXACT_REVIEW_REQUIRED')
        from noon_nownow_review import require_same_review
        import json
        frozen=self.review;expected=json.loads(frozen.frozen_json)
        current=self.review_cart(financials_minor=expected['amounts'],price_breakdown=expected['priceBreakdown'])
        require_same_review(frozen,current,now=time.time())
        controller,context=self.native_controller_context()
        if (controller['isCvvRequired'] is not True or controller['requiresCardSubscription']
                or controller['isVerifyDeviceRequired']):
            journal.fail('PREORDER_CVV_BRANCH_REQUIRED')
        row=self.current.wire['data']
        validation=getattr(self,'validation',None)
        if (validation is None or validation['review_digest']!=self.review.digest
                or time.time()-validation['observed_at']>60 or validation['checkoutWarningPopup'] is not None):
            journal.fail('FRESH_NATIVE_VALIDATION_REQUIRED')
        encrypted=encrypt(self.client.payment_config(timeout=25).wire,cvv)
        body={'addressCode':row['addressCode'],'addressVersion':row['addressVersion'],'paymentToken':self.card.token}
        self._expect('payment_subscription',body)
        intent=self.client.create_payment_subscription(address_code=body['addressCode'],
            address_version=body['addressVersion'],card=self.card,before_send=self._before,timeout=25)
        secret=intent.wire['data']
        cart_hash=journal.digest({'flow':self.flow_id,'store':self.store_code})
        self.intent_vault=vault or IntentVault()
        try:
            self.preorder_intent_hash=self.intent_vault.retain(self.flow_id,secret=secret,
                review_hash=self.review.digest,cart_hash=cart_hash,card_hash=fingerprint(self.card.token),
                payable_minor=self.review.payable_minor)
            journal.observe(self.flow_id,'payment_subscription',outcome='PREORDER_INTENT_RECEIVED',
                evidence_hash=self.preorder_intent_hash)
        except Exception:
            journal.observe(self.flow_id,'payment_subscription',outcome='UNKNOWN',
                evidence_hash=journal.digest({'reason':'INTENT_RETENTION_FAILED'}))
            raise
        payload=native.payment_complete_payload(secret,self.card,encrypted)
        self._expect('payment_complete',payload)
        result=self.client.complete_payment(order=None,session_code=self.session_code,client_secret=secret,
            card=self.card,cvv_encryption=encrypted,before_send=self._before,timeout=25)
        outcome=payment_outcome(result.projection)
        journal.observe(self.flow_id,'payment_complete',outcome=outcome,
            evidence_hash=journal.digest(result.projection))
        return result.projection

    def read_preorder_payment(self, *, vault=None):
        from commerce_preorder import IntentVault,payment_outcome
        from noon_checkout import fingerprint
        saved=(vault or getattr(self,'intent_vault',None) or IntentVault()).load(self.flow_id)
        state=journal.preorder_status(self.flow_id)
        if (saved['review_hash']!=self.review.digest or saved['card_hash']!=fingerprint(self.card.token)
                or saved['payable_minor']!=self.review.payable_minor or saved['intent_hash']!=state['intent_hash']
                or saved['cart_hash']!=journal.digest({'flow':self.flow_id,'store':self.store_code})):
            journal.fail('PREORDER_BINDING_MISMATCH')
        result=self.client.payment_status(order=None,session_code=self.session_code,client_secret=saved['secret'],timeout=25)
        journal.observe(self.flow_id,'payment_complete',outcome=payment_outcome(result.projection),
                        evidence_hash=journal.digest(result.projection))
        return result.projection

    def finalize_reviewed(self, controller, *, validation):
        journal.require_account_available('noon',self.account_hash,flow_id=self.flow_id)
        if validation is not getattr(self,'validation',None):journal.fail('FRESH_NATIVE_VALIDATION_REQUIRED')
        native_controller,finalize_context=self.native_controller_context()
        for key in ('orderPaymentAmount','requiresCardSubscription','isCvvRequired'):
            if controller.get(key)!=native_controller[key]:journal.fail('NOWNOW_CONTROLLER_CONTEXT_CHANGED')
        if (controller.get('selection',{}).get('cardId')!=native_controller['selection']['cardId']
                or finalize_context['walletEnabled'] is not False or finalize_context['walletAmount']!=0):
            journal.fail('NOWNOW_CONTROLLER_CONTEXT_CHANGED')
        decision=self.controller_decision(controller,validation=validation)
        preconfirmed=journal.preorder_status(self.flow_id)['payment_confirmed']
        if decision['state']!='finalize_candidate' and not (decision['state']=='preorder_subscription_required' and preconfirmed):
            journal.fail('NOWNOW_'+decision['state'].upper())
        # Recompute on the exact retained session before dispatch; controller
        # flags alone never authorize changing the reviewed cart/payment amount.
        from noon_nownow_review import require_same_review
        import json
        frozen=self.review;data=json.loads(frozen.frozen_json)
        current=self.review_cart(financials_minor=data['amounts'],price_breakdown=data['priceBreakdown'])
        require_same_review(frozen,current,now=time.time())
        body=native.place_payload(self.session_code,self.review.payable_minor)
        self._expect('place',body)
        result=self.client.place_order(session_code=self.session_code,order_payment_minor=self.review.payable_minor,
            before_send=self._before,timeout=25)
        self.order=result.projection['order']
        return result.projection
