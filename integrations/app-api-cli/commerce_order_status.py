"""Exact persisted-order reads with current account binding and cookie retention."""
import time

import commerce_journal as journal
from commerce_auth_status import CommerceAuth
from commerce_flow import account_hash
from noon_checkout import AccountHome


def status(flow_id, *, auth=None):
    binding=journal.binding(flow_id)
    local=journal.inspect(flow_id)
    order=local['order_id']
    if not order:journal.fail('EXACT_ORDER_ID_UNAVAILABLE')
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
