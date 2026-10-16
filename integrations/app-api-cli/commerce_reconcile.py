"""Read-only exact-order financial disposition. Never releases local reservations."""
import datetime as dt
import hashlib
import time

import commerce_journal as journal
import commerce_receipts as receipts
from commerce_auth_status import CommerceAuth
from commerce_flow import account_hash


def _now():return dt.datetime.now(dt.timezone.utc).isoformat()


def _evidence(route, method, projection, *, checked_at, reference=None):
    result={'route':route,'method':method,'checked_at':checked_at,'projection':projection,
            'projection_hash':journal.digest(projection)}
    if reference is not None:result['exact_reference_hash']=hashlib.sha256(reference.encode()).hexdigest()
    return result


def _safe_read_error(exc):
    import re
    value=getattr(exc,'code',str(exc))
    return value if type(value) is str and re.fullmatch(r'[A-Z][A-Z0-9_]{0,100}',value) else 'EXACT_STATUS_READ_FAILED'


def reconcile(flow_id, *, auth=None):
    binding=journal.binding(flow_id);local=journal.inspect(flow_id)
    store=receipts.load(**binding).snapshot()
    order=local['order_id']
    placed=[x for x in store.receipts if x.operation=='place' and x.order_id==order]
    if not order or len(placed)!=1:journal.fail('EXACT_PLACE_RECEIPT_REQUIRED')
    auth=auth or CommerceAuth();evidence=[]
    if binding['app']=='noon' and binding['vertical']=='minutes':
        import noon_minutes_checkout as m
        from noon_checkout import AccountHome
        manager=auth.noon
        current=None
        def headers(operation,deadline):
            nonlocal current
            state=manager.status('minutes')
            current=manager.reconcile('minutes') if state['maintenance_state']!='none' else manager.revalidate('minutes',deadline=deadline)
            if current.account_ref!=binding['account_hash']:journal.fail('RECOVERY_ACCOUNT_CHANGED')
            return current.read_headers()
        first=headers('order_get',time.monotonic()+25)
        held=[]
        def cookies(operation,values,*,response_url,http_status,outcome_journaled):
            held.append((current,tuple(values),response_url,http_status))
            manager.retain_response_cookies('minutes',current,values,response_url=response_url,http_status=http_status)
            held.clear();return True
        client=m.MinutesCheckout(first,AccountHome('minutes',current.account_ref,current.address_ref,time.time()),
            header_provider=headers,response_cookies=cookies)
        response=client.order_status(order,timeout=25)
        projection={**response.projection,'total_minor':m.amount_minor(response.wire['orderTotal'])}
        if projection.get('identity_echoed') is not True:journal.fail('EXACT_ORDER_ECHO_REQUIRED_FOR_INTENT')
        evidence.append(_evidence('/_svc/instant/order/get','POST',projection,checked_at=_now(),reference=order))
        intent=response.wire.get('paymentIntentToken')
        if type(intent) is str and intent:
            try:
                payment=client.payment_status(order=order,client_secret=intent,timeout=25)
                projection=payment.projection
            except Exception as exc:
                projection={'error':_safe_read_error(exc),'read_only':True}
            evidence.append(_evidence('/_svc/mp-payment-api-public/paymentintent/status','POST',projection,
                checked_at=_now(),reference=intent))
        else:
            evidence.append(_evidence('/_svc/instant/order/get','POST',{'intent_available':False},checked_at=_now()))
        missing='Exact order/payment-intent authorization and capture ledger or terminal void/expiry liability record; order/get and paymentintent/status do not expose it.'
    elif binding['app']=='talabat':
        import talabat_http_checkout as h
        saved=auth.fresh_before_mutation('talabat',binding['vertical']).mutation_account(binding['vertical'])
        if account_hash(saved)!=binding['account_hash']:journal.fail('RECOVERY_ACCOUNT_CHANGED')
        data=h.orders.request(h.orders.TRACKING+order,saved,h.auth.new_deadline(15))
        projection=h.orders.project(data,order)
        projection['profile_verified']=True
        evidence.append(_evidence('/order-tracking/v4/order-tracking/<exact-order>','GET',
            {k:projection.get(k) for k in ('order','status','raw_status','identity_verified','account_verified','profile_verified')},
            checked_at=_now(),reference=order))
        txn=placed[0].transaction_id
        if not txn:journal.fail('EXACT_TRANSACTION_RECEIPT_REQUIRED')
        response=h._wire(saved,time.monotonic()+15,'GET','/pay/v2/payment/status',params={
            'isRedirectionInitiated':'false','encryptedTransactionId':txn,
            'scenario':'deliveryOrder','subscription':'false'},headers={'x-acceptance-request-id':flow_id})
        data=response.data or {};literal=data.get('status')
        known={'pending','success','error','redirection','Error'}
        projection={'http_status':response.status,'status':literal if type(literal) is str and literal in known else 'unmapped',
            'error_present':data.get('error') is not None,'fallback_present':data.get('fallback') is not None,
            'redirect_present':data.get('redirectUrl') is not None,'sdk_present':data.get('hyperPayCheckoutId') is not None}
        evidence.append(_evidence('/pay/v2/payment/status','GET',projection,checked_at=_now(),reference=txn))
        missing='Exact placed transaction authorization/capture/void/expiry ledger; payment/status Error and fulfillment tracking do not prove absence of liability.'
    else:journal.fail('FINANCIAL_DISPOSITION_VERTICAL_UNMAPPED')
    return {'ok':True,'flow_id':flow_id,'app':binding['app'],'vertical':binding['vertical'],'order':order,
        'journal_state':local['state'],'reserved_minor':local['reserved_minor'],
        'campaign_reserved_minor':local['campaign_reserved_minor'],
        'financial_operations_recorded':[x['kind'] for x in local['operations'] if x['kind'] in ('place','payment','preauthorize','prepay')],
        'evidence':evidence,'liability':'unresolved','liability_interface_missing':missing,
        'required_terminal_evidence':['exact order-to-intent/transaction association',
            'final authorization/capture/void/expiry disposition for each known financial attempt',
            'amount and currency reconciliation against the retained reservation',
            'authoritative evidence whether any future capture remains possible'],
        'disposition':'retain_fence_and_reservation','financial_retry':False,'reservation_release_allowed':False,
        'next_action':'Obtain an authoritative exact-order/transaction financial disposition through supported merchant/payment support; do not submit another checkout.'}
