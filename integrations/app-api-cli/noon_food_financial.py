"""Food financial contract and coordinator; production financial transport disabled.

The coordinator is exercised with injected transports. Recovery uses only exact
session/order/intent reads and never calls a financial writer. No secret is
persisted: intent and selected-card bindings are hashes.
"""
import fcntl
import json
import os
import re
from decimal import Decimal, InvalidOperation

import commerce_journal as j

PLACE_URL='https://api-app-fd.noon.com/_svc/mp-food-api-mpnoon/order/place-order'
COMPLETE_URL='https://api-app-st.noon.com/_svc/mp-payment-api-public/paymentintent/complete'
STATUS_URL='https://api-app-st.noon.com/_svc/mp-payment-api-public/paymentintent/status'


def require(value, code):
    if not value:j.fail(code)


def minor(value):
    require(not isinstance(value,bool),'FOOD_PAYMENT_AMOUNT_INVALID')
    try:
        amount=Decimal(str(value))*100
        require(amount.is_finite() and amount>=0 and amount==amount.to_integral_value(),'FOOD_PAYMENT_AMOUNT_INVALID')
        return int(amount)
    except (InvalidOperation,ValueError,TypeError):j.fail('FOOD_PAYMENT_AMOUNT_INVALID')


def place_payload(session, amount):
    require(isinstance(session,str) and re.fullmatch(r'[A-Za-z0-9_-]{5,100}',session),'FOOD_SESSION_INVALID')
    require(type(amount) is int and amount>0,'FOOD_PAYMENT_AMOUNT_INVALID')
    return {'sessionCode':session,'orderTotal':amount/100,'orderPaymentAmount':amount/100}


def completion_payload(intent, token, *, cvv_required, cvv_encryption=None):
    """Saved-card subset of native shape 33353; wallet/Apple/Google/ADCB excluded."""
    require(isinstance(intent,str) and 0<len(intent)<=2000,'FOOD_INTENT_INVALID')
    require(isinstance(token,str) and token.isdigit(),'FOOD_CARD_TOKEN_INVALID')
    require(type(cvv_required) is bool,'FOOD_CVV_REQUIREMENT_UNKNOWN')
    require(not cvv_required or cvv_encryption is not None,'FOOD_ENCRYPTED_CVV_REQUIRED')
    body={'clientSecret':intent,'paymentMethodCode':'cc_noonpay','idCustomerToken':token,
          'paymentProviderCode':'NOON_PAY'}
    if cvv_encryption is not None:
        require(isinstance(cvv_encryption,dict) and set(cvv_encryption)=={'encCvv','publicKeyName'}
                and all(isinstance(v,str) and 0<len(v)<16000 for v in cvv_encryption.values()),'FOOD_ENCRYPTED_CVV_INVALID')
        body['cvvEncryption']=dict(cvv_encryption)
    return body


def payment_projection(raw, order, amount, card_hash):
    """Historical Food status proof: exact reference/currency/card and full capture."""
    require(raw.get('reference')==order,'FOOD_PAYMENT_REFERENCE_MISMATCH')
    require(raw.get('currency_code')=='AED' and minor(raw.get('amount'))==amount,'FOOD_PAYMENT_AMOUNT_MISMATCH')
    require(str(raw.get('cc_masked') or '').endswith('2342') and raw.get('payment_method_code')=='cc_noonpay',
            'FOOD_PAYMENT_CARD_MISMATCH')
    require(j.digest(str(raw.get('id_token')))==card_hash,'FOOD_PAYMENT_TOKEN_MISMATCH')
    require(all(isinstance(raw.get(k),str) and re.fullmatch(r'[A-Za-z0-9_]{1,80}',raw[k])
                for k in ('status','transaction_status')),'FOOD_PAYMENT_STATUS_INVALID')
    authorized=minor(raw['authorized_amount']) if raw.get('authorized_amount') is not None else None
    captured=minor(raw['captured_amount']) if raw.get('captured_amount') is not None else None
    refunded=minor(raw['refunded_amount']) if raw.get('refunded_amount') is not None else None
    reversed_amount=minor(raw['reversed_amount']) if raw.get('reversed_amount') is not None else None
    paid=(raw.get('status')=='payment_confirmed' and raw.get('transaction_status')=='CAPTURED'
          and raw.get('error_code')=='0' and authorized==captured==amount
          and refunded in (None,0) and reversed_amount in (None,0))
    return {'order':order,'currency':'AED','amount_minor':amount,'paid':paid,
            'payment_status':raw.get('status'),'transaction_status':raw.get('transaction_status'),
            'captured_minor':captured,'authorized_minor':authorized,'refunded_minor':refunded,
            'challenge_required':bool(raw.get('redirect_url')),'financial_retry':False}


class DisabledTransport:
    def assert_enabled(self):
        j.fail('FOOD_LIVE_FINANCIAL_TRANSPORT_DISABLED')

    def send(self, operation, payload):
        self.assert_enabled()


class Coordinator:
    """Reader validates native identity; journal independently binds every send.

    reader.session() returns fresh normalized session/review evidence.
    reader.order(id) returns normalized acceptance plus an intent in RAM.
    reader.payment(intent) is the verified read-only status operation.
    registrar(id, paid=bool) must verify the durable watcher and its receipt.
    """
    def __init__(self, flow_id, reader, registrar, *, transport=None):
        self.flow_id=flow_id;self.reader=reader;self.registrar=registrar
        self.transport=transport or DisabledTransport()
        self.binding=j.binding(flow_id)
        require(self.binding['app']=='noon' and self.binding['vertical']=='food','FOOD_FLOW_REQUIRED')
        root=j.ROOT/'food-financial';root.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.path=root/(flow_id+'.json')

    def save(self, state):
        tmp=self.path.with_suffix('.tmp')
        fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
        with os.fdopen(fd,'w') as stream:
            json.dump(state,stream,allow_nan=False);stream.flush();os.fsync(stream.fileno())
        tmp.replace(self.path)

    def locked(self, action):
        with self.path.with_suffix('.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            return action()

    def session(self, state=None):
        value=self.reader.session()
        require(value['account_hash']==self.binding['account_hash'] and value['scope_hash']==self.binding['scope_hash'],
                'FOOD_FINANCIAL_ACCOUNT_SCOPE_MISMATCH')
        for key in ('review_hash','card_hash'):
            require(isinstance(value.get(key),str) and re.fullmatch(r'[a-f0-9]{64}',value[key]),'FOOD_FINANCIAL_BINDING_INVALID')
        require(type(value.get('amount_minor')) is int and value['amount_minor']>0,'FOOD_PAYMENT_AMOUNT_INVALID')
        if state:
            require(all(value[k]==state[k] for k in ('session_id','review_hash','amount_minor','card_hash')),
                    'FOOD_FINANCIAL_REVIEW_CHANGED')
        return value

    def _observe_unknown(self, operation):
        j.observe(self.flow_id,operation,outcome='UNKNOWN',evidence_hash=j.digest({'operation':operation,'outcome':'unknown'}))

    def place(self):
        def action():
            self.transport.assert_enabled()  # Gate before reads, reservation or journal consumption.
            require(not any(o['kind'] in ('place','payment') for o in j.inspect(self.flow_id)['operations']),
                    'FOOD_FINANCIAL_SEND_ALREADY_CONSUMED')
            session=self.session();require(not session.get('order_id'),'FOOD_SESSION_ALREADY_ORDERED')
            state={k:session[k] for k in ('session_id','review_hash','amount_minor','card_hash')}
            state['cart_hash']=j.digest(session['session_id'])
            payload=place_payload(session['session_id'],session['amount_minor'])
            self.save(state)
            j.consume(self.flow_id,'place',kind='place',request_hash=j.digest(payload),cart_hash=state['cart_hash'],
                      review_hash=state['review_hash'],payable_minor=state['amount_minor'])
            try:self.transport.send('place',payload)
            except Exception:
                self._observe_unknown('place')
                return {'state':'PLACE_OUTCOME_UNKNOWN','financial_retry':False}
            # The response envelope is not used as order identity or payment proof.
            return self._recover()
        return self.locked(action)

    def _order(self, state, session, local):
        financial=j.financial_binding(self.flow_id)
        require(financial['review_hash']==state['review_hash'] and financial['reserved_minor']==state['amount_minor']
                and financial['place_cart_hash']==state['cart_hash']
                and state['cart_hash']==j.digest(state['session_id']),'FOOD_FINANCIAL_JOURNAL_BINDING_MISMATCH')
        order=session.get('order_id')
        if not order:return None
        require(isinstance(order,str) and re.fullmatch(r'F[A-Z0-9]{1,63}',order),'FOOD_ORDER_ID_INVALID')
        require(local['order_id'] in (None,order),'FOOD_ORDER_ID_CHANGED')
        row=self.reader.order(order)
        require(row.get('order_id')==order and row.get('account_hash')==self.binding['account_hash']
                and row.get('scope_hash')==self.binding['scope_hash'] and row.get('amount_minor')==state['amount_minor']
                and row.get('card_hash')==state['card_hash'],'FOOD_ORDER_BINDING_MISMATCH')
        if not local['order_id']:
            j.observe(self.flow_id,'place',outcome='ORDER_ID_RECEIVED',evidence_hash=j.digest({'order':order,'session_hash':state['cart_hash']}),order_id=order)
        intent=row.get('intent')
        if intent:
            require(isinstance(intent,str) and len(intent)<=2000,'FOOD_INTENT_INVALID')
            digest=j.digest(intent)
            require(state.get('intent_hash',digest)==digest,'FOOD_PAYMENT_INTENT_CHANGED')
            state['intent_hash']=digest;self.save(state)
        return row

    def complete_payment(self, *, cvv_encryption=None):
        def action():
            self.transport.assert_enabled()
            state=json.loads(self.path.read_text());session=self.session(state);local=j.inspect(self.flow_id)
            row=self._order(state,session,local)
            require(row and row.get('intent'),'FOOD_BOUND_INTENT_REQUIRED')
            current=payment_projection(self.reader.payment(row['intent']),row['order_id'],state['amount_minor'],state['card_hash'])
            if current['paid']:return self._recover()
            require(not current['challenge_required'],'FOOD_CHALLENGE_ALREADY_ACTIVE')
            require(current['payment_status'] not in ('payment_failed','payment_error'),'FOOD_PAYMENT_FAILED_NO_RETRY')
            require(self.reader.continuation_verified(row,current) is True,'FOOD_UNPAID_INTENT_CONTRACT_UNVERIFIED')
            token=self.reader.card_token()
            require(j.digest(token)==state['card_hash'],'FOOD_PAYMENT_TOKEN_MISMATCH')
            payload=completion_payload(row['intent'],token,cvv_required=row.get('cvv_required'),cvv_encryption=cvv_encryption)
            j.consume(self.flow_id,'payment',kind='payment',request_hash=j.digest(payload),cart_hash=state['cart_hash'],
                      review_hash=state['review_hash'],payable_minor=state['amount_minor'],payment_order_id=row['order_id'])
            try:self.transport.send('complete',payload)
            except Exception:
                self._observe_unknown('payment')
                return {'state':'PAYMENT_OUTCOME_UNKNOWN','order':row['order_id'],'financial_retry':False}
            return self._recover()
        return self.locked(action)

    def recover(self):
        return self.locked(self._recover)

    def _recover(self):
        state=json.loads(self.path.read_text());session=self.session(state);local=j.inspect(self.flow_id)
        require(any(o['kind']=='place' for o in local['operations']),'FOOD_PLACE_JOURNAL_REQUIRED')
        row=self._order(state,session,local)
        if row is None:
            return {'state':'PLACE_OUTCOME_UNKNOWN','order':None,'financial_send':False,'financial_retry':False}
        order=row['order_id'];payment=None
        payment_error=None
        if row.get('intent'):
            try:
                payment=payment_projection(self.reader.payment(row['intent']),order,state['amount_minor'],state['card_hash'])
            except Exception:
                # A status outage must not strand an exactly identified order.
                # No exception payload (which could contain a secret) is persisted.
                payment_error='FOOD_PAYMENT_PROOF_UNAVAILABLE_OR_MISMATCHED'
        paid=bool(payment and payment['paid']);accepted=row.get('accepted') is True
        if local['state']=='COMPLETE':
            require(paid and accepted,'FOOD_COMPLETED_ORDER_EVIDENCE_CHANGED')
        receipt=self.registrar(order,paid=paid and accepted)
        require(receipt.get('registered') is True and receipt.get('order')==order,'FOOD_TRACKER_REGISTRATION_UNVERIFIED')
        local=j.inspect(self.flow_id)
        operation='payment' if any(o['kind']=='payment' for o in local['operations']) else 'place'
        if local['state']!='COMPLETE':
            if paid:
                j.observe(self.flow_id,operation,outcome='PAYMENT_REPORTED_SUCCESS',evidence_hash=j.digest(payment),order_id=order)
                if j.inspect(self.flow_id)['state']=='FENCED':j.reconcile_food_paid(self.flow_id,evidence_hash=j.digest(payment))
                if accepted:j.observe(self.flow_id,operation,outcome='EXACT_ORDER_CONFIRMED',evidence_hash=j.digest({'order':order,'accepted':True}),order_id=order)
            j.observe(self.flow_id,operation,outcome='TRACKER_REGISTERED',evidence_hash=j.digest(receipt),order_id=order)
            if paid and accepted:j.complete(self.flow_id)
        return {'ok':True,'state':'PAID_AND_ACCEPTED' if paid and accepted else 'PAID_AWAITING_ACCEPTANCE' if paid else 'PAYMENT_UNCONFIRMED',
                'order':order,'paid':paid,'accepted':accepted,'payment':payment,'tracker':receipt,
                'payment_error':payment_error,
                'financial_send':False,'financial_retry':False}


def contract():
    return {'implemented':['durable consume-before-send placement/payment coordinator',
        'session/review/account/address/items/quiet/card/amount/order/intent binding',
        'read-only exact capture recovery; ambiguous sends never retried',
        'order-watch receipt and durable state readback; card held until capture plus acceptance'],
        'live_financial_transport':'disabled; no enable flag or financial HTTP dispatcher',
        'static_place':{'url':PLACE_URL,'fields':['sessionCode','orderTotal','orderPaymentAmount']},
        'static_complete':{'url':COMPLETE_URL,'saved_card_fields':['clientSecret','paymentMethodCode',
            'idCustomerToken','paymentProviderCode','cvvEncryption'],
            'optional_wallet_fields':['applePayToken','googlePayToken','adcbTokenCode']},
        'read_only_status':{'url':STATUS_URL,'fields':['clientSecret'],
            'proof':'exact reference, AED amount/authorized/captured, cc_noonpay, 2342 token binding, payment_confirmed/CAPTURED/error 0'},
        'unsupported':['fresh place response and post-place session field continuity (orderNr/intent/CVV requirement)',
            'unpaid intent status and safe eligibility for first completion; native adapter refuses unknown states',
            'saved-card absent wallet-field serialization and encrypted-CVV request acceptance',
            '3DS challenge/return contract; recovery reads status only and never follows redirect URLs',
            'early restaurant acceptance enums; only observed picked_up/delivered proves acceptance'],
        'proof_required':'One separately authorized, freshly priced restaurant order with one placement and at most one bound completion; capture redacted request shapes and independent session/order/status readbacks. Never replay timeout or ambiguous sends.'}
