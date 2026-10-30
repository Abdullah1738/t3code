"""Main/Supermall native account reader and journal-bound preparation flow.

Financial review needs the real selected-session schema; preparation can already
be bound to the exact observed cart without overwriting another basket.
"""
import order_card
import uuid
import time
import hashlib

import commerce_journal as journal
import commerce_receipts as receipts
import noon_marketplace_checkout as market
from noon_auth_lifecycle import NoonAuthLifecycle


class MarketplaceFlow:
    def __init__(self, service, *, auth=None, request=market.native_request):
        if service not in market.EXPERIENCES:journal.fail('INVALID_SERVICE')
        self.service=service
        self.auth=auth or NoonAuthLifecycle()
        self.snapshot=self._snapshot()
        self.account_hash=self.snapshot.account_ref
        self.address_hash=self.snapshot.address_ref
        self.flow_id=str(uuid.uuid4())
        self.opened=False
        self.expected=None
        self.pending_cookies=[]
        self.last_cart=None
        self.session_response=None
        self.owned_offers=()
        self.card=None
        self.review=None
        self.receipt_store=None
        self.scope_hash=journal.digest({'service':service,'account':self.account_hash,
            'home':self.address_hash,'card':order_card.LAST4,'quiet':True})
        self.client=market.MarketplaceClient(service,header_provider=self._headers,
            before_send=self._before,receipt=self._receipt,response_cookies=self._cookies,request=request)

    def _snapshot(self, deadline=None):
        state=self.auth.status(self.service)
        return (self.auth.reconcile(self.service) if state['maintenance_state']!='none'
                else self.auth.revalidate(self.service,deadline=deadline))

    def _headers(self, operation, deadline):
        snapshot=self._snapshot(deadline)
        if (snapshot.account_ref!=self.account_hash or snapshot.address_ref!=self.address_hash
                or operation.service!=self.service):
            journal.fail('MARKETPLACE_ACCOUNT_HOME_CHANGED')
        self.snapshot=snapshot
        return snapshot.mutation_headers(self.service) if operation.mutation else snapshot.read_headers()

    def _before(self, metadata):
        journal.require_account_available('noon',self.account_hash,
            flow_id=self.flow_id if self.opened else None)
        if self.expected is None or metadata!={
                'service':self.service,'operation':self.expected.name,
                'request_digest':self.expected.digest,'order_id':self.expected.order_id}:
            journal.fail('MARKETPLACE_REQUEST_NOT_BOUND')
        # These are the concrete implemented preparation callers below. No generic
        # boolean approval can turn an arbitrary operation into a financial send.
        kind={'session':'quote','add':'cart','select':'selection','address':'selection',
              'payment_method':'selection','delivery_option':'instructions','place':'place',
              'payment_complete':'payment'}.get(self.expected.name)
        if kind is None:journal.fail('MARKETPLACE_SESSION_REVIEW_REQUIRED')
        financial=kind in ('place','payment')
        if financial:
            if self.review is None or time.time()-self.review.observed_at>60:
                journal.fail('MARKETPLACE_FRESH_REVIEW_REQUIRED')
            if self.review.account_ref!=self.account_hash or self.review.address_ref!=self.address_hash:
                journal.fail('MARKETPLACE_REVIEW_IDENTITY_CHANGED')
        if not self.opened:
            journal.open_flow(flow_id=self.flow_id,app='noon',vertical=self.service,
                account_hash=self.account_hash,scope_hash=self.scope_hash)
            self.opened=True
            self.receipt_store=receipts.create(flow_id=self.flow_id,app='noon',vertical=self.service,
                account_hash=self.account_hash,scope_hash=self.scope_hash)
        operation=self.expected
        name=operation.name
        if name=='delivery_option':name='delivery_'+hashlib.sha256(operation.body).hexdigest()[:16]
        self.current_operation=name
        accepted=journal.consume(self.flow_id,name,kind=kind,
            request_hash=operation.digest,cart_hash=journal.digest({
                'service':self.service,'account':self.account_hash,'flow':self.flow_id}),
            review_hash=self.review.digest if financial else None,
            payable_minor=self.review.payable_minor if financial else None,
            payment_order_id=operation.order_id if kind=='payment' else None)
        self.expected=None
        return accepted

    def _receipt(self, record):
        if record['service']!=self.service:journal.fail('MARKETPLACE_RECEIPT_SCOPE_MISMATCH')
        if record['operation'] in ('place','payment_complete'):
            self.receipt_store.append(receipts.Receipt(operation='place' if record['operation']=='place' else 'payment',
                state='SUBMISSION_UNKNOWN' if record['outcome']=='UNKNOWN' else record['outcome'],
                http_status=record['http_status'],order_id=record['order_id'],currency='AED',
                payable_minor=self.review.payable_minor,review_sha256=self.review.digest))
        journal.observe(self.flow_id,self.current_operation,outcome=record['outcome'],
            evidence_hash=record['evidence_hash'],order_id=record['order_id'])
        return True

    def _cookies(self, operation, values, *, response_url, http_status, outcome_journaled):
        record=(self.snapshot,tuple(values),response_url,http_status)
        self.pending_cookies.append(record)
        if operation not in ('cart','order_status','order_detail','payment_config','payment_status') and not outcome_journaled:return True
        self.auth.retain_response_cookies(self.service,record[0],record[1],
            response_url=response_url,http_status=http_status)
        self.pending_cookies.remove(record)
        return True

    def cart(self):
        self.last_cart=self.client.cart()
        return self.last_cart.summary()

    def add_to_empty(self, *, offer, quantity, store_code=None):
        before=self.client.cart()
        if before.summary()['empty'] is not True:journal.fail('OWNER_BASKET_MUST_NOT_BE_REPLACED')
        args={'offer':offer,'quantity':quantity}
        if store_code is not None:args['store_code']=store_code
        self.expected=market.operation(self.service,'add',**args)
        result=self.client.call('add',**args)
        after=self.client.cart()
        # Complete returned inventory remains available in RAM for offer/seller
        # review. A changed unrelated line cannot be silently discarded.
        market.assert_preserved(before.data,after.data,changed=((offer,''),))
        items=after.data.get('items')
        if 'groups' in after.data:
            from noon_marketplace_native_shape import _flatten
            items=[row for _,_,row in _flatten(after.data,'groups','SCHEMA_CART_ROWS')]
        if (type(items) is not list or len(items)!=1 or items[0].get('offerCode')!=offer
                or items[0].get('variantKey','')!='' or items[0].get('quantity')!=quantity):
            journal.observe(self.flow_id,'add',outcome='UNKNOWN',
                evidence_hash=journal.digest({'reason':'EXACT_ADDED_MANIFEST_MISMATCH'}))
            journal.fail('EXACT_ADDED_MANIFEST_MISMATCH')
        self.last_cart=after
        journal.observe(self.flow_id, self.current_operation, outcome='CART_READBACK',
            evidence_hash=market.cleanup_readback_hash(after, self.account_hash, self.address_hash))
        self.owned_offers=((offer,'',quantity),)
        return result.summary()

    def session(self):
        self.expected=market.operation(self.service,'session')
        self.session_response=self.client.session()
        return self.session_response

    def select_owned(self):
        if not self.owned_offers or self.last_cart is None:journal.fail('OWNED_OFFERS_REQUIRED')
        changes={(offer,variant):True for offer,variant,qty in self.owned_offers}
        offers=market.selection_payload(self.last_cart.data,changes)
        if any(row['isSelected'] and (row['offerCode'],row['variantKey']) not in changes for row in offers):
            journal.fail('UNOWNED_OFFER_SELECTED')
        self.expected=market.operation(self.service,'select',offers=offers)
        return self.client.call('select',offers=offers)

    def set_home(self):
        address=self.snapshot.read_headers()['x-addresskey']
        self.expected=market.operation(self.service,'address',address_key=address)
        self.session_response=self.client.call('address',address_key=address)
        return self.session_response

    def select_card(self, card):
        from noon_minutes_checkout import SavedCard
        if type(card) is not SavedCard:journal.fail('SAVED_CARD_REQUIRED')
        card.validate()
        args={'card_token':card.token,'card_mask':card.mask}
        self.expected=market.operation(self.service,'payment_method',**args)
        self.session_response=self.client.call('payment_method',**args)
        self.card=card
        return self.session_response

    def set_delivery_options(self, quiet_options):
        from noon_marketplace_quiet import select_native_quiet_delivery
        if self.session_response is None:journal.fail('SELECTED_SESSION_REQUIRED')
        # The native activation callback is not an arbitrary quiet checkbox.
        # Require the actual supported semantic contract before any setter wire.
        return select_native_quiet_delivery(self.session_response.data,service=self.service,
            request_experience=market.EXPERIENCES[self.service],request_mp='noon')

    def review_selected(self, *, manifest, expected_fees, quiet_options, shape=None):
        import noon_marketplace_review as review
        if self.last_cart is None or self.session_response is None or self.card is None:
            journal.fail('SELECTED_CART_SESSION_CARD_REQUIRED')
        if tuple((x.offer,x.variant,x.quantity) for x in manifest)!=self.owned_offers:
            journal.fail('REVIEW_MANIFEST_NOT_OWNED')
        headers=self.snapshot.read_headers()
        home={'account_ref':self.account_hash,'address_ref':self.address_hash,
            'address_code':headers['x-addresscode'],'address_key':headers['x-addresskey'],
            'title':'Home 2104','street_address':'BanyanTree Hillside',
            'lat':250778251,'lng':551569039,'observed_at':self.snapshot.checked_at}
        card={'token':self.card.token,'mask':self.card.mask,'card_type':self.card.network,
              'observed_at':self.session_response.observed_at}
        context=review.Context(self.service,self.account_hash,self.address_hash,
            review.digest(self.last_cart.data),review.digest(self.session_response.data),
            self.last_cart.observed_at,self.session_response.observed_at,time.time(),60)
        self.review=review.review(self.last_cart.data,self.session_response.data,manifest,home,card,
            context=context,shape=shape,expected_fees=expected_fees,quiet_options=quiet_options)
        return self.review

    def native_review_evidence(self, *, invoice_review=None):
        """Concrete native context, credit and invoice evidence before final review.

        Opaque seller/fulfillment context is hash-bound; it is not given invented
        merchant IDs. Complete fee roles and quiet semantics remain explicit.
        """
        if self.last_cart is None or self.session_response is None:journal.fail('SELECTED_CART_SESSION_REQUIRED')
        from noon_marketplace_native_shape import native_context_binding,native_credit_state,native_invoice_observations,native_addon_observations
        context=native_context_binding(self.last_cart.data,self.session_response.data)
        credit=native_credit_state(self.session_response.data)
        if credit['useCredits'] or credit['total_minor']!=credit['order_payment_minor']:
            journal.fail('UNAPPROVED_WALLET_OR_PAYMENT_DIFFERENCE')
        invoices=native_invoice_observations(self.session_response.data)
        from noon_marketplace_invoice import native_invoice_reconcile,NATIVE_ROLE_CONTRACT
        invoice_result=(native_invoice_reconcile(self.session_response.data,invoices,local_review=invoice_review)
            if invoice_review is not None else {'supported':False,'blocker':'LOCAL_INVOICE_LABEL_REVIEW_REQUIRED',
                'native_role_contract':NATIVE_ROLE_CONTRACT})
        addons=native_addon_observations(self.last_cart.data,self.session_response.data)
        from noon_marketplace_quiet import native_quiet_contract
        quiet=native_quiet_contract(self.session_response.data,service=self.service,
            request_experience=market.EXPERIENCES[self.service],request_mp='noon')
        for addon in addons:
            key=addon['source_path'][-1]
            if (key=='installation' and addon.get('isSelected') is True
                    or key=='extendedWarranty' and addon.get('native_value') is not None
                    or key=='donation' and addon.get('amount_minor',0)>0):
                journal.fail('UNAPPROVED_NATIVE_ADDON')
        return {'context':context,'credit':credit,'invoice_rows':invoices,'invoice_reconciliation':invoice_result,'addons':addons,
                'quiet_contract':quiet,
                'financial_review_complete':False}

    def place_reviewed(self):
        import noon_marketplace_review as review
        journal.require_account_available('noon',self.account_hash,flow_id=self.flow_id)
        if self.review is None:journal.fail('SELECTED_CART_REVIEW_REQUIRED')
        if (review.digest(self.last_cart.data)!=self.review.cart_hash
                or review.digest(self.session_response.data)!=self.review.session_hash):
            journal.fail('REVIEW_SNAPSHOT_CHANGED')
        amount=self.review.payable_minor/100
        self.expected=market.operation(self.service,'place',total=amount)
        return self.client.call('place',total=amount)

    def complete_existing_payment(self, order, *, cvv=None):
        journal.require_account_available('noon',self.account_hash,flow_id=self.flow_id)
        if self.review is None or self.card is None:journal.fail('SELECTED_CART_REVIEW_REQUIRED')
        current=self.client.order_status(order)
        if current.data.get('status')!='pending' or not current.data.get('clientSecret'):
            journal.fail('EXACT_PENDING_PAYMENT_REQUIRED')
        args={'order':order,'client_secret':current.data['clientSecret'],'card_token':self.card.token}
        if cvv is not None:
            from noon_cvv import encrypt
            args['cvv_encryption']=encrypt(self.client.call('payment_config').data,cvv)
        self.expected=market.operation(self.service,'payment_complete',**args)
        result=self.client.call('payment_complete',**args)
        if result.summary().get('state')=='payment_confirmed':
            journal.observe(self.flow_id,'payment_complete',outcome='PAYMENT_REPORTED_SUCCESS',
                evidence_hash=result.digest,order_id=order)
        return result
