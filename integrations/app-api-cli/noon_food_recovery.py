"""Read-only native Food recovery and verified order-watch registration.

Fresh unpaid intent/CVV shapes have not been captured. Native recovery can prove
capture, but cannot authorize a payment continuation from an unknown shape.
"""
import json
import os
import subprocess
import re
from pathlib import Path

import commerce_food as food
import commerce_journal as j
import noon_http_orders as core
import noon_vertical_reads as vertical
from noon_checkout import fingerprint
from noon_food_financial import require, minor
import order_watch_receipt


class NativeReader:
    def __init__(self, flow_id):
        self.flow_id=flow_id
        binding=j.binding(flow_id)
        require(binding['app']=='noon' and binding['vertical']=='food','FOOD_FLOW_REQUIRED')
        self.state=json.loads((food.ROOT/(flow_id+'.json')).read_text())
        self.flow=None

    def session(self):
        rows=[{'item_code':r['itemCode'],'qty':r['qty'],'modifiers':r['modifiers'],'notes':r['notes']}
              for r in self.state['items']]
        self.flow=food.FoodFlow(self.state['outlet'],rows,self.flow_id,read_only=True)
        try:
            data=self.flow.read()
        except j.JournalError as exc:
            if str(exc) == 'FOOD_RESPONSE_UNVERIFIED':
                local=j.inspect(self.flow_id)
                if local['state']=='FENCED' and local['order_id'] and not any(
                        o['kind'] in ('payment','prepay','preauthorize') for o in local['operations']):
                    raise j.PaymentError('FOOD_RESPONSE_UNVERIFIED', {
                        'flow_id':self.flow_id, 'financial_send':False, 'financial_retry':False,
                        'next':[f'For a delivered automatic capture, use commerce close-food-captured {self.flow_id} '
                                '--bank-msg-id MSG_ID (dry run); add --confirm only after reviewing its evidence.']}) from None
            raise
        self.session_data=data
        # An exact owned session is the only permitted source of an order ID.
        # Retain all review guards while allowing that session to have an order.
        review=self.flow.review({**data,'orderNr':None})
        expected={k:v for k,v in self.state['review'].items() if k not in ('store','display_items')}
        require(review==expected and j.digest(self.state['review'])==self.state['review_hash'],
                'FOOD_FINANCIAL_REVIEW_CHANGED')
        require(isinstance(self.state.get('card_hash'),str),'FOOD_PREPARED_CARD_BINDING_MISSING')
        require(j.digest(str(data.get('paymentToken')))==self.state['card_hash'],
                'FOOD_FRESH_CARD_TOKEN_CHANGED')
        selection=[o for o in j.inspect(self.flow_id)['operations'] if o['name']=='set_payment_method']
        require(len(selection)==1 and selection[0]['state']=='OBSERVED','FOOD_CARD_SELECTION_UNOBSERVED')
        return {'account_hash':self.flow.account,'scope_hash':self.flow.scope,
                'session_id':self.state['session'],'review_hash':self.state['review_hash'],
                'amount_minor':review['payable_minor'],'card_hash':self.state['card_hash'],
                'order_id':data.get('orderNr')}

    def order(self, order):
        require(self.flow is not None,'FOOD_SESSION_READ_REQUIRED')
        data=vertical._food_data(vertical._read('food_detail',self.flow.headers,core.operation_deadline(15),order))
        row=project_order(data,order,self.flow,self.state)
        row['automatic_payment_processed']=(
            self.session_data.get('paymentRequireCompletion') is False
            and self.session_data.get('paymentRequireCvv') is False
            and j.digest(str(self.session_data.get('paymentToken')))==self.state['card_hash']
            and data.get('paymentClientSecret') is None
            and isinstance(data.get('paymentProcessedAt'),str)
            and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d',data['paymentProcessedAt']) is not None
            and (data.get('miscInfo') or {}).get('isPaymentAutoCapture') is True
            and minor(self.session_data.get('orderPaymentFinalTotal'))==self.state['review']['payable_minor']
            and all(data.get(k)==0 for k in ('orderRefundToWallet','orderIssuedCredit','orderAdjustments'))
            and data.get('failedErrorMsg') is None and row['accepted'])
        return row

    def payment(self, intent):
        import noon_nownow_checkout as payment
        return payment.native_request('payment_status',self.flow.headers,core.operation_deadline(15),
            {'clientSecret':intent},response_observer=lambda *a,**k:None)

    def continuation_verified(self, row, payment):
        # No captured unpaid Food status or CVV requirement yet. In particular,
        # absent paymentRequireCvv is not permission to omit CVV.
        return False

    def card_token(self):
        import noon_nownow_checkout as payment
        data=payment.native_request('payment_cards',self.flow.headers,core.operation_deadline(15),None,
                                   response_observer=lambda *a,**k:None)
        rows=[r for r in data.get('data',[]) if isinstance(r,dict) and r.get('isDeleted') is False
              and str(r.get('ccMasked') or '').endswith(self.flow.card_last4) and str(r.get('id','')).isdigit()]
        require(len(rows)==1 and j.digest(str(rows[0]['id']))==self.state['card_hash'],'FOOD_PAYMENT_TOKEN_MISMATCH')
        return str(rows[0]['id'])


def project_order(data, order, flow, state):
    require(data.get('orderNr')==order and isinstance(data.get('customerCode'),str)
            and fingerprint(data['customerCode'])==flow.account,'FOOD_ORDER_ACCOUNT_MISMATCH')
    require((data.get('outletInfo') or {}).get('outletCode')==flow.outlet
            and data.get('addressCode')==flow.headers['x-addresscode']
            and flow.headers['x-addresskey']==str(data.get('addressCode'))+'-'+str(data.get('addressVersion')),
            'FOOD_ORDER_HOME_OR_OUTLET_CHANGED')
    require(isinstance(data.get('items'),list),'FOOD_ORDER_ITEMS_INVALID')
    rows=[{'itemCode':r.get('itemCode'),'qty':r.get('qty'),'modifiers':r.get('modifiers') or {},
           'notes':r.get('notes') or None} for r in data['items']]
    require(sorted(map(j.digest,rows))==sorted(map(j.digest,flow.rows)),'FOOD_ORDER_MANIFEST_CHANGED')
    amount=state['review']['payable_minor']
    require(data.get('currencyCode')=='AED' and minor(data.get('orderTotal'))==amount
            and minor(data.get('orderPaymentAmount'))==amount and minor(data.get('orderWalletAmount'))==0,
            'FOOD_ORDER_AMOUNT_CHANGED')
    require(str(data.get('creditCardMask') or '').endswith(state['review']['card_last4'])
            and data.get('paymentMethodCode')=='prepaid' and data.get('prepaidPaymentMethodCode')=='cc_noonpay'
            and data.get('paymentProviderCode')=='NOON_PAY','FOOD_ORDER_PAYMENT_METHOD_CHANGED')
    # Quiet preferences in order details use "choice"; sessions use "value".
    prefs={p.get('code'):p.get('choice') for p in data.get('deliveryPreferenceInfo',[]) if isinstance(p,dict)}
    require(all(prefs.get(k) is True for k in food.QUIET) and data.get('driverNotes')==food.QUIET_NOTE,
            'FOOD_ORDER_QUIET_CHANGED')
    return {'order_id':order,'account_hash':flow.account,'scope_hash':flow.scope,
            'amount_minor':amount,'card_hash':state['card_hash'],'intent':data.get('paymentClientSecret'),
            'cvv_required':data.get('paymentRequireCvv'),
            'accepted':(data.get('orderStatusCode')=='accepted' and data.get('outletStatusCode')=='accepted') or data.get('orderStatusCode')=='delivered' or
                       (data.get('outletStatusCode')=='picked_up' and data.get('orderStatusCode') in ('delivering','picked_up'))}


class TrackerRegistrar:
    def __init__(self, reader):
        self.reader=reader

    def __call__(self, order, *, paid):
        local=j.inspect(self.reader.flow_id)
        require(local['order_id']==order,'FOOD_TRACKER_ORDER_MISMATCH')
        name='order-noon-'+order.lower()
        home=Path.home()
        command=[str(home/'.local/bin/order-watch'),'add','--app','noon','--order',order,
                 '--vertical','food','--for','owner','--label',self.reader.state['review'].get('store') or 'noon Food',
                 '--total',f"AED {local['reserved_minor']/100:.2f}",
                 '--payment-confirmed' if paid else '--hold-placed-text']
        env={k:v for k,v in os.environ.items() if k not in ('BUN_INSPECT','BUN_OPTIONS','NODE_OPTIONS')}
        try:
            result=subprocess.run(command,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=125)
            cfg=json.loads((home/'.local/state/order-tracker/orders'/f'{name}.json').read_text())
            watcher=json.loads((home/'.local/share/robob-watch/watchers'/name/'watcher.json').read_text())
        except (OSError,ValueError,subprocess.TimeoutExpired):
            j.fail('FOOD_TRACKER_REGISTRATION_UNVERIFIED')
        receipt_rows=[]
        for line in result.stdout.decode('utf-8','replace').splitlines():
            try: row=json.loads(line)
            except ValueError: continue
            if isinstance(row,dict) and row.get('tracker_id')==name:receipt_rows.append(row)
        require(result.returncode==0 and receipt_rows and receipt_rows[-1].get('watcher_registered') is True
                and cfg.get('app')=='noon' and cfg.get('order')==order and cfg.get('watcher')==name
                and cfg.get('vertical')=='food' and watcher.get('id')==name
                and cfg.get('delivery_card',{}).get('held') is (not paid),'FOOD_TRACKER_REGISTRATION_UNVERIFIED')
        _,receipt=order_watch_receipt.parse(result.stdout,result.returncode,'owner',name)
        return {'registered':True,'order':order,'held':not paid,**receipt}
