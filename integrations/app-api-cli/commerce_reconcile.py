"""Exact-order disposition and explicit owner-attested closure; never financial retries."""
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


def owner_attest_no_charge(flow_id, *, evidence, attested_by, auth=None):
    """Close only the delayed Talabat/Error shape on explicit owner evidence.

    Both provider checks are fresh, exact GETs. An Error is not no-charge proof:
    the distinct terminal disposition records whose evidence closes the fence.
    Unknown/new provider shapes remain fenced instead of becoming an override.
    """
    import talabat_http_checkout as h
    journal.validate_owner_attestation(evidence=evidence, attested_by=attested_by)
    binding=journal.binding(flow_id);local=journal.inspect(flow_id)
    if (binding['app']!='talabat' or local['state']!='FENCED' or not local['order_id']
            or local['reserved_minor']<=0):
        journal.fail('OWNER_ATTESTATION_FENCED_TALABAT_PAYMENT_REQUIRED')
    if (sum(x['kind']=='payment' for x in local['operations'])!=1
            or any(x['state']!='OBSERVED' for x in local['operations'])):
        journal.fail('OWNER_ATTESTATION_PAYMENT_HISTORY_INVALID')
    if journal.payment_reported(flow_id):
        journal.fail('OWNER_ATTESTATION_PROVIDER_SUCCESS_ALREADY_OBSERVED')
    store=receipts.load(**binding)
    snapshot=store.snapshot()
    order=local['order_id']
    placed=[r for r in snapshot.receipts if r.operation=='place' and r.order_id==order]
    if len(placed)!=1 or not placed[0].transaction_id:
        journal.fail('EXACT_TRANSACTION_RECEIPT_REQUIRED')
    if any(r.state=='PAYMENT_REPORTED_SUCCESS' for r in snapshot.receipts):
        journal.fail('OWNER_ATTESTATION_PROVIDER_SUCCESS_ALREADY_OBSERVED')
    txn=placed[0].transaction_id
    params={'isRedirectionInitiated':'false','encryptedTransactionId':txn,
            'scenario':'deliveryOrder','subscription':'false'}
    contexts=[r.context for r in snapshot.receipts if r.context is not None]
    if contexts:
        context=contexts[-1]
        if (context.order_id!=order or context.transaction_id!=txn
                or context.acceptance_id!=flow_id or context.account_binding!=binding['account_hash']):
            journal.fail('OWNER_ATTESTATION_PAYMENT_CONTEXT_MISMATCH')
        params=h.payment_status_params(context)
    auth=auth or CommerceAuth()
    saved=auth.fresh_before_mutation('talabat',binding['vertical']).mutation_account(binding['vertical'])
    if account_hash(saved)!=binding['account_hash']:journal.fail('RECOVERY_ACCOUNT_CHANGED')
    tracking=h.orders.project(h.orders.request(h.orders.TRACKING+order,saved,h.auth.new_deadline(15)),order)
    tracking['profile_verified']=True
    # This path already obtained a freshly profile-verified, flow-bound account.
    # A pending order may be absent from the app list; that absence does not lift
    # its financial fence. Owner evidence and exact transaction Error are required.
    if (tracking.get('order')!=order or tracking.get('identity_verified') is not True
            or account_hash(saved)!=binding['account_hash']):
        journal.fail('OWNER_ATTESTATION_EXACT_ORDER_REQUIRED')
    # Delayed confirmation projects to pending confirmation; only this exact
    # raw state remains eligible for the separate owner/payment evidence checks.
    delayed=tracking.get('raw_status')=='order_confirmingdelayed' and tracking.get('status')=='pending confirmation'
    if not delayed and tracking.get('status') in {'placed','preparing','picked up','out for delivery','nearby','delivered'}:
        journal.fail('OWNER_ATTESTATION_ORDER_ACTIVE_OR_DELIVERED')
    if not delayed:
        journal.fail('OWNER_ATTESTATION_ORDER_STATE_UNSUPPORTED')
    provider=[_evidence('/order-tracking/v4/order-tracking/<exact-order>','GET',
        {k:tracking.get(k) for k in ('order','status','raw_status','identity_verified','account_verified','profile_verified')},
        checked_at=_now(),reference=order)]
    response=h._wire(saved,time.monotonic()+15,'GET','/pay/v2/payment/status',params=params,
                     headers={'x-acceptance-request-id':flow_id})
    data=response.data
    literal=data.get('status') if type(data) is dict else None
    signal=literal.strip().lower() if type(literal) is str else None
    if signal in {'success','captured','paid','authorized','authorised'}:
        journal.fail('OWNER_ATTESTATION_PAYMENT_SUCCESS_OR_AUTHORIZATION')
    # An unknown key may carry capture/authorization evidence. Never discard it
    # and accept the remaining Error, even when the HTTP response is non-2xx.
    if (type(response.status) is not int or response.status not in (200,422)
            or type(data) is not dict
            or set(data)-{'status','error','errors','fallback','redirectUrl','hyperPayCheckoutId'}
            or signal!='error'
            or any(data.get(k) is not None for k in ('fallback','redirectUrl','hyperPayCheckoutId'))
            or any(data.get(k) is not None and (type(data[k]) is not dict
                or set(data[k])-{'type','title','subtitle','exception','cta'}
                or any(type(v) is not str for v in data[k].values())) for k in ('error','errors'))):
        journal.fail('OWNER_ATTESTATION_PAYMENT_STATE_UNSUPPORTED')
    provider.append(_evidence('/pay/v2/payment/status','GET',
        {'http_status':response.status,'status':signal,'error_present':data.get('error') is not None,
         'errors_present':data.get('errors') is not None,
         'fallback_present':False,'redirect_present':False,'sdk_present':False},checked_at=_now(),reference=txn))
    # A concurrent recovery may have received success while these GETs ran. Its
    # receipt is written before the journal observation; check both stores.
    with store.locked_snapshot() as current:
        if current.receipts!=snapshot.receipts:
            journal.fail('OWNER_ATTESTATION_RECEIPTS_CHANGED')
        result=journal.close_owner_attested_uncharged(flow_id,order_id=order,
            reserved_minor=local['reserved_minor'],evidence=evidence,attested_by=attested_by,
            provider_evidence={'binding':binding,'checks':provider,
                'receipt_snapshot_hash':journal.digest([receipts._wire(r) for r in snapshot.receipts])})
    return {'ok':True,'flow_id':flow_id,'app':'talabat','vertical':binding['vertical'],'order':order,
            **result,'liability':'owner_attested_uncharged','disposition':'owner_attested_uncharged',
            'provider_no_charge_proven':False,'financial_send':False,'financial_retry':False,
            'reservation_release_allowed':False}


def reconcile(flow_id, *, auth=None):
    binding=journal.binding(flow_id);local=journal.inspect(flow_id)
    if binding['app']=='noon' and binding['vertical'] in ('main','supermall'):
        from commerce_marketplace_disposition import reconcile as marketplace_reconcile
        return marketplace_reconcile(flow_id, auth=auth.noon if auth else None)
    store=receipts.load(**binding).snapshot()
    order=local['order_id']
    from commerce_order_status import talabat_place_failure
    failure=talabat_place_failure(binding,local,store)
    if failure is not None:return failure
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
    result={'ok':True,'flow_id':flow_id,'app':binding['app'],'vertical':binding['vertical'],'order':order,
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
    if local['state']==journal.OWNER_ATTESTED_UNCHARGED:
        result.update(liability='owner_attested_uncharged',disposition='owner_attested_uncharged',
            owner_attestation=local['owner_attestation'],provider_no_charge_proven=False,
            next_action='Terminal owner-attested closure; these reads do not reopen the flow or authorize a retry.')
    return result
