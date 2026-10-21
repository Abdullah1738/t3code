"""Exact persisted-order reads with current account binding and cookie retention."""
import time

import commerce_journal as journal
import commerce_receipts as receipts
from commerce_auth_status import CommerceAuth
from commerce_flow import account_hash
from noon_checkout import AccountHome


TALABAT_ORDERLESS_NEXT_ACTION=(
    'No order ID was returned. Do not place another order. Read "talabat-search orders --json" '
    'using the supported launcher and check the account order history; use app/support if unresolved. '
    'Payment polling is unavailable without an exact retained transaction context. '
    'Keep the flow fenced; a place error and absent order do not prove no charge.')


def talabat_place_failure(binding, local, snapshot=None):
    """Expose an orderless place receipt without inventing a payment cursor."""
    if binding['app']!='talabat' or local['order_id']:
        return None
    snapshot=snapshot if snapshot is not None else receipts.load(**binding).snapshot()
    placed=[r for r in snapshot.receipts if r.operation=='place']
    if len(placed)!=1 or any(r.order_id or r.context is not None for r in snapshot.receipts):
        return None
    place=placed[0]
    result = {'ok':False,'app':'talabat','vertical':binding['vertical'],'flow_id':binding['flow_id'],
            'error':'TALABAT_PLACE_NOT_CONFIRMED','state':place.state,'reason':place.reason,
            'place_http_status':place.http_status,'order':None,
            'transaction_id_received':place.transaction_id is not None,
            'payment_operation_recorded':any(o['kind']=='payment' for o in local['operations']),
            'journal_state':local['state'],'reserved_minor':local['reserved_minor'],
            'purchase_confirmed':False,'payment_capture_verified':None,'provider_no_charge_proven':False,
            'financial_retry':False,'reservation_release_allowed':False,
            'next_action':TALABAT_ORDERLESS_NEXT_ACTION}
    from commerce_talabat_duplicate import eligible, NEXT_ACTION
    if eligible(binding, local, snapshot) or local['state']==journal.REJECTED_DUPLICATE:
        result.update(error='TALABAT_REJECTED_DUPLICATE',state='REJECTED_DUPLICATE',
                      account_fence_lifted=local['state']==journal.REJECTED_DUPLICATE,
                      next_action=NEXT_ACTION.replace('FLOW',binding['flow_id']))
    return result


def status(flow_id, *, auth=None):
    binding=journal.binding(flow_id)
    local=journal.inspect(flow_id)
    order=local['order_id']
    if not order:
        failure=talabat_place_failure(binding,local)
        if failure is not None:return failure
        journal.fail('EXACT_ORDER_ID_UNAVAILABLE')
    auth=auth or CommerceAuth()
    if binding['app']=='talabat':
        import talabat_http_orders as orders
        from talabat_auth import new_deadline
        saved=auth.fresh_before_mutation('talabat',binding['vertical']).mutation_account(binding['vertical'])
        if account_hash(saved)!=binding['account_hash']:journal.fail('RECOVERY_ACCOUNT_CHANGED')
        result=orders.track_bound(order,saved,new_deadline(20))
        return {**result,'flow_id':flow_id,'financial_retry':False,
                'reserved_minor':local['reserved_minor'],'journal_state':local['state']}
    if binding['vertical'] in ('main','supermall'):
        from commerce_marketplace import MarketplaceFlow
        flow=MarketplaceFlow(binding['vertical'],auth=auth.noon)
        if flow.account_hash!=binding['account_hash']:journal.fail('RECOVERY_ACCOUNT_CHANGED')
        response=flow.client.order_status(order)
        return {**response.summary(),'flow_id':flow_id,'order':order,
            'reserved_minor':local['reserved_minor'],'journal_state':local['state'],'financial_retry':False}
    if binding['vertical']=='nownow':
        from commerce_nownow import reader
        client=reader(auth=auth.noon,expected_account=binding['account_hash'])
        return {**client.track(order),'flow_id':flow_id,'reserved_minor':local['reserved_minor'],
            'journal_state':local['state'],'financial_retry':False}
    if binding['vertical']!='minutes':journal.fail('INVALID_COMMERCE_VERTICAL')
    import noon_minutes_checkout as minutes
    manager=auth.noon
    state=manager.status('minutes')
    snapshot=manager.reconcile('minutes') if state['maintenance_state']!='none' else manager.revalidate('minutes')
    if snapshot.account_ref!=binding['account_hash']:journal.fail('RECOVERY_ACCOUNT_CHANGED')
    retained=[]
    def cookies(operation,values,*,response_url,http_status,outcome_journaled):
        retained.append((snapshot,tuple(values),response_url,http_status))
        manager.retain_response_cookies('minutes',snapshot,values,response_url=response_url,http_status=http_status)
        retained.clear()
        return True
    client=minutes.MinutesCheckout(snapshot.read_headers(),
        AccountHome('minutes',snapshot.account_ref,snapshot.address_ref,time.time()),response_cookies=cookies)
    response=client.order_status(order,timeout=20)
    return {'app':'noon','vertical':'minutes','flow_id':flow_id,**response.projection,
            'total_minor':minutes.amount_minor(response.wire['orderTotal']),
            'reserved_minor':local['reserved_minor'],'journal_state':local['state'],
            'financial_retry':False}
