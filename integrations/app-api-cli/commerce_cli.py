"""Native HTTP commerce: caller-authorized baskets and exact recovery."""
import argparse
import json
import re
import sys
import os
import subprocess
import datetime as dt
from pathlib import Path

import commerce_journal as journal
import commerce_receipts as receipts
from commerce_auth_status import CommerceAuth
from commerce_flow import FlowGate, account_hash
from commerce_basket_input import input_items
import talabat_http_checkout as talabat
import talabat_http_orders as talabat_orders
import order_watch_receipt


def register_tracking(flow, label, recipient='owner', *, paid=True):
    """Register the exact returned ID, then read back its durable registration.

    Unpaid/unknown outcomes are tracked too, but Moni's placement text is held
    until payment is confirmed; recover-payment's paid re-add releases it.
    """
    state=journal.inspect(flow.flow_id)
    order=state['order_id']
    if not order:journal.fail('EXACT_ORDER_ID_UNAVAILABLE')
    env={k:v for k,v in os.environ.items() if k not in ('NODE_OPTIONS','BUN_OPTIONS','BUN_INSPECT')}
    command=[str(Path.home()/'.local/bin/order-watch'),'add','--app',state['app'],'--order',order,
             *order_watch_receipt.command_args(recipient),
             '--placed-at',dt.datetime.now(dt.timezone.utc).isoformat(),'--label',label,
             *([] if paid else ['--hold-placed-text'])]
    try:
        result=subprocess.run(command,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=125)
    except (OSError,subprocess.TimeoutExpired):
        journal.fail('TRACKER_REGISTRATION_UNCONFIRMED_READBACK_REQUIRED')
    name=f"order-{state['app']}-{order.lower()}"
    try:
        config=json.loads((Path.home()/'.local/state/order-tracker/orders'/f'{name}.json').read_text())
        watcher=json.loads((Path.home()/'.local/share/robob-watch/watchers'/name/'watcher.json').read_text())
    except (OSError,ValueError):
        journal.fail('TRACKER_REGISTRATION_UNCONFIRMED_READBACK_REQUIRED')
    exit_ok,receipt=order_watch_receipt.parse(result.stdout,result.returncode,recipient,name)
    if not exit_ok or config.get('order')!=order or config.get('watcher')!=name or not watcher:
        journal.fail('TRACKER_REGISTRATION_UNCONFIRMED_READBACK_REQUIRED')
    # A fast delivery may close a correctly registered watcher before readback.
    flow.gate.tracker_registered(order,{'watcher':name,'active':config.get('active') is True})
    return {'watcher':name,'registered':True,**receipt}


def purchase_talabat(args):
    from commerce_talabat import TalabatFlow
    from talabat_basket import parse_items
    rows=input_items(args,id_argument='item',id_key='item_id',note_key='note')
    # Shape/identity validation is merchant-specific. The CLI does not impose
    # a food category, line-count, quantity or spending policy of its own.
    items=parse_items(rows,vertical=args.vertical)
    verticals_key=talabat.shared.verticals_key(args.apk_pool)
    if getattr(args,'resume_flow',None):
        from commerce_talabat import settle_interrupted_cart
        state=journal.inspect(args.resume_flow)
        if any(x['state']!='OBSERVED' for x in state['operations']):
            print(json.dumps({'flow_id':args.resume_flow,'phase':'settle'}),flush=True)
            settled=settle_interrupted_cart(args.resume_flow,vertical=args.vertical,
                branch=args.branch,items=items,verticals_key=verticals_key)
            print(json.dumps({'flow_id':args.resume_flow,'phase':'settled',
                'cart_id':settled['cart_id'],'adopted_from':settled['adopted_from']}),flush=True)
        flow=TalabatFlow(vertical=args.vertical,branch=args.branch,items=items,flow_id=args.resume_flow)
        print(json.dumps({'flow_id':flow.flow_id,'phase':'resumed'}),flush=True)
        review=flow.resume_cart(verticals_key=verticals_key)
    else:
        flow=TalabatFlow(vertical=args.vertical,branch=args.branch,items=items)
        print(json.dumps({'flow_id':flow.flow_id,'phase':'created'}),flush=True)
        review=flow.prepare(verticals_key=verticals_key)
    print(json.dumps({'flow_id':flow.flow_id,'review':review}),flush=True)
    if getattr(args, 'prepare_only', False):
        # Explicitly stop before purchase; verify a fresh GET after the quote.
        flow.checkout.read_owned_cart(allowed_food_totals=(review['payable_minor'],))
        return {'ok':True,'state':'PREPARED_NOT_ORDERED','flow_id':flow.flow_id,
                'review':review,'cart_readback_verified':True,'financial_send':False}
    tracking_registration=None
    result=None
    try:
        result=flow.purchase()
    finally:
        # A returned order must be tracked even when payment validation or its
        # receipt raises. This never repeats place or submits a payment fallback.
        if journal.inspect(flow.flow_id)['order_id']:
            paid=isinstance(result,dict) and result.get('state')=='PAYMENT_REPORTED_SUCCESS'
            tracking_registration=register_tracking(flow,args.label,args.recipient,paid=paid)
    if tracking_registration is not None:
        result['tracking']=tracking_registration
        result.update(order_watch_receipt.fields(tracking_registration))
    if result['state']=='PAYMENT_REPORTED_SUCCESS':
        tracking=flow.checkout.track()
        flow.gate.exact_order(tracking)
        journal.complete(flow.flow_id)
        result['order']=tracking['order'];result['delivery_status']=tracking['status']
        result['payable_minor']=review['payable_minor']
    return result


def talabat_discovery(args):
    """Authenticated menu/choice reads, without opening or modifying a cart."""
    from dataclasses import asdict
    import uuid
    from talabat_menu_choices import fetch_menu_index, fetch_item_choices

    item_id=getattr(args,'item',None)
    if type(args.branch) is not int or not 0<args.branch<=journal.MAX_SQLITE_INTEGER:
        journal.fail('BRANCH_ID_INVALID')
    if item_id is not None and (type(item_id) is not int or not 0<item_id<=journal.MAX_SQLITE_INTEGER):
        journal.fail('MENU_ITEM_ID_INVALID')

    def forbidden(*_args,**_kwargs):
        journal.fail('MENU_DISCOVERY_MUTATION_FORBIDDEN')

    saved=CommerceAuth().fresh_before_mutation('talabat','restaurants').mutation_account('restaurants')
    checkout=talabat.Checkout(saved,flow_id=str(uuid.uuid4()),journal=forbidden,receipt=forbidden)
    checkout.resolve_restaurant(args.branch)
    menu=fetch_menu_index(checkout,args.branch)
    result={'ok':True,'app':'talabat','branch_id':args.branch,
            'source':'authenticated_native_menu','account_verified':True,
            'cart_mutation':False,'financial_send':False}
    if item_id is None:
        result['items']=[asdict(item) for item in menu.entries.values()]
    else:
        item=menu.get(item_id)
        if item is None:
            journal.fail('EXACT_CATALOG_ITEM_UNAVAILABLE')
        choices=fetch_item_choices(checkout,args.branch,item_id)
        result.update(item=asdict(item),choices=asdict(choices),choice_selection={
            'choice_id':'sections[].options[].option_id',
            'sub_choice_ids':'selected option.sub_categories[].options[].option_id',
            'nested_depth_supported':1,'nested_parent_quantity_supported':1,
            'child_quantity':1,'required_sections_enforced':True})
    return result


def capabilities():
    return {'ok':True,'currency':'AED','order_cap_minor':journal.ORDER_LIMIT_MINOR,
        'campaign_cap_minor':journal.TOTAL_LIMIT_MINOR,'verticals':{
        'noon.minutes':{'auth':'verified_cookie_revalidation','cart':'journalled_native',
            'place':'live_order_created','payment':'live_confirmed_e2e_paid_order_2026_10_10',
            'tracking':'exact_native','rejected_auth_renewal_proven':False,
             'multi_item_baskets':True,'multi_item_cart_live_verified':True,
             'multi_item_purchase_live_verified':True},
        'noon.main':{'auth':'verified_cookie_revalidation','cart':'journalled_native',
            'place':'live_order_created','payment':'frictionless_saved_card_live_paid_2026_10_10',
            'tracking':'exact_shipment_manifest','multi_item_baskets':True,
            'multi_item_cart_live_verified':True,'multi_item_purchase_live_verified':True},
        'noon.supermall':{'auth':'verified_cookie_revalidation','cart':'journalled_native_rocket_quick_atc',
            'place':'live_order_created','payment':'frictionless_saved_card_live_paid_2026_10_11',
            'tracking':'exact_shipment_manifest_rocket_unit_binding','multi_item_baskets':True,
            'multi_item_cart_live_verified':True,'multi_item_purchase_live_verified':True},
        'noon.nownow':{'auth':'verified_cookie_revalidation','cart':'journalled_native',
            'place':'live_order_created','payment':'saved_card_session_token_live_paid_2026_10_10',
            'tracking':'exact_native','multi_item_baskets':True,
            'multi_item_cart_live_verified':True,'multi_item_purchase_live_verified':True,
            'quiet_driver_note_live_verified':True},
        'talabat.shops':{'auth':'legitimate_refresh_grant','cart':'live_journalled',
            'place':'live_order_created','payment':'native_async_live_paid','tracking':'exact_native',
            'multi_item_baskets':True,'multi_item_purchase_live_verified':False},
        'talabat.mart':{'auth':'legitimate_refresh_grant','cart':'live_journalled',
            'place':'live_order_created','payment':'native_async_live_paid','tracking':'exact_native',
            'multi_item_baskets':True,'multi_item_purchase_live_verified':False},
        'talabat.restaurants':{'auth':'legitimate_refresh_grant','cart':'native_food_cart_with_item_notes',
            'cart_read':'exact_owned_cart_v1_get','place':'live_order_created',
            'payment':'native_async_live_paid','tracking':'exact_native',
            'item_notes':'exact_cart_quote_readback_live_verified_2026_10_11',
            'item_note_purchase_live_verified':True,'food_choices_supported':True,
            'food_choices_cart_live_verified':True,'food_choices_purchase_live_verified':True,
            'nested_subchoices_supported':True,'nested_subchoices_depth':1,
            'nested_subchoices_cart_live_verified':True,
            'nested_subchoices_purchase_live_verified':False,'multi_item_baskets':True,
            'multi_item_cart_live_verified':True,'multi_item_purchase_live_verified':True}},
        'talabat_order_scope':'arbitrary_catalog_items_and_multiple_lines',
        'spending_policy':'caller_managed_no_cli_order_or_campaign_cap',
        'basket_input':'items_file_json_array_or_items_object_with_legacy_single_item_flags',
        'noon_session_recovery':'bounded_same_account_revalidation_and_peer_cookie_adoption',
        'noon_refresh_grant_verified':False,
        'prepare_only':'cart_and_quote_mutations_with_readback_no_place_or_payment',
        'financial_retry':False}


def cvv_from_keychain():
    """Saved-card CVV from Keychain into RAM; never an argument, file or log line."""
    command=['security','find-generic-password','-s','robob-card','-a','Marriott.card_cvc','-w']
    try:
        result=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=15)
    except (OSError,subprocess.TimeoutExpired):
        journal.fail('CVV_KEYCHAIN_UNAVAILABLE')
    if result.returncode:
        journal.fail('CVV_KEYCHAIN_UNAVAILABLE')
    value=result.stdout.decode('utf-8','replace').strip()
    if re.fullmatch(r'[0-9]{3,4}',value) is None:
        journal.fail('CVV_KEYCHAIN_INVALID')
    return value.encode('ascii')


def prepared_result(flow, prepared):
    """Expose the adapter's verified nonfinancial preparation result."""
    if (not isinstance(prepared,dict) or prepared.get('prepared_only') is not True
            or prepared.get('flow_id')!=flow.flow_id
            or not isinstance(prepared.get('review'),dict)
            or not isinstance(prepared.get('readback'),dict)
            or not prepared['readback']):
        journal.fail('PREPARE_ONLY_READBACK_UNCONFIRMED')
    return {**prepared,'ok':True,'state':'PREPARED_NOT_ORDERED',
            'cart_readback_verified':True,'financial_send':False,'financial_retry':False}


def order_minutes(args):
    """Full paid Minutes E2E: guard, sync, quiet, review, place, pay, 3DS wait, track.

    Journalled at-most-once per operation; a paid outcome requires the captured
    terminal payment triple, exact tracking and a registered order watcher.
    """
    from commerce_minutes import MinutesFlow,readback_active_orders,telegram_3ds_notify
    import noon_minutes_checkout as minutes_transport
    items=input_items(args,id_argument='sku',id_key='sku',quantity_key='qty')
    auth=CommerceAuth().noon
    guard=readback_active_orders(auth)
    if guard.projection['count']:
        print(json.dumps({'phase':'active_order_blocker',
                          'active_orders':guard.projection['active']}),flush=True)
        journal.fail('MINUTES_ACTIVE_ORDER_PRESENT')
    if args.resume_flow:
        flow=MinutesFlow.resume_active(args.resume_flow,items=items,auth=auth)
        print(json.dumps({'flow_id':flow.flow_id,'phase':'resumed'}),flush=True)
    else:
        flow=MinutesFlow(items=items,auth=auth)
        print(json.dumps({'flow_id':flow.flow_id,'phase':'created'}),flush=True)
    try:
        prepared=flow.prepare_only()
        verified=prepared_result(flow,prepared)
        review=prepared['review']
        print(json.dumps({'flow_id':flow.flow_id,'phase':'review','review':review}),flush=True)
        if args.prepare_only:
            return verified
        # Preparation never even loads the saved-card CVV. Read it only on the
        # explicitly invoked financial path, and never retain it in output.
        cvv=cvv_from_keychain() if args.cvv_from_keychain else None
        placed=flow.place()
        print(json.dumps({'flow_id':flow.flow_id,'phase':'placed','order':placed['order']}),flush=True)
        payment=flow.complete(cvv=cvv)
        print(json.dumps({'flow_id':flow.flow_id,'phase':'payment_submitted','payment':payment}),flush=True)
    except minutes_transport.MinutesError as exc:
        if exc.code in ('AUTH_EXPIRED','AUTH_FORBIDDEN'):
            journal.fail('MINUTES_AUTH_EXPIRED_NEEDS_APP_REBIND')
        raise
    if payment['payment_status']=='payment_pending':
        notify=telegram_3ds_notify(placed['order'],review['payable_minor'])
    elif payment['payment_status']=='payment_confirmed':
        # Captured flow always challenges, but a confirmed direct return is paid,
        # not an error; the status readback below still proves the terminal triple.
        notify={'notified':False,'reason':'payment_confirmed_without_challenge'}
    else:
        journal.fail('MINUTES_PAYMENT_NOT_PENDING')
    print(json.dumps({'flow_id':flow.flow_id,'phase':'owner_3ds_notified','notify':notify}),flush=True)
    paid=flow.await_payment()
    print(json.dumps({'flow_id':flow.flow_id,'phase':'payment_awaited','paid':paid['paid'],
        'payment_status':paid['payment_status'],'transaction_status':paid['transaction_status'],
        'authorized_minor':paid.get('authorized_minor'),'polls':paid['polls'],
        'timed_out':paid['timed_out']}),flush=True)
    if not paid['paid']:
        journal.fail('MINUTES_PAYMENT_WINDOW_ELAPSED_NO_RETRY' if paid['timed_out']
                     else 'MINUTES_PAYMENT_FAILED_NO_RETRY')
    tracking=flow.verify_tracking()
    registration=flow.register_tracker(args.label,recipient=args.recipient)
    journal.complete(flow.flow_id)
    return {'ok':True,'flow_id':flow.flow_id,'order':placed['order'],
        'items':items,
        'payable_minor':review['payable_minor'],
        'paid':{'payment_status':paid['payment_status'],
                'transaction_status':paid['transaction_status'],
                'authorized_minor':paid['authorized_minor'],
                'captured_minor':paid['captured_minor'],'polls':paid['polls'],
                'confirmed_at':dt.datetime.now(dt.timezone.utc).isoformat()},
        'delivery_status':tracking['status'],'eta':tracking.get('eta'),
        'tracking':tracking,'watcher':registration['watcher'],'notify':notify,
        **order_watch_receipt.fields(registration),'financial_retry':False}


def order_nownow(args):
    """Paid NowNow E2E replay of the captured contract (NNGAANNWEFJMZW8A).

    session/create -> edit-product -> validate guard -> edit-payment (saved
    card) -> set-delivery-preference (BOTH flags one call) -> place-order ->
    tracking poll. Payment rides the session token; place is the only
    financial send. On 401: stop, no re-login attempt.
    """
    import noon_nownow_checkout as nownow_transport
    from commerce_nownow_order import NowNowOrderFlow
    items=input_items(args,id_argument='product_code',id_key='product_code')
    auth=CommerceAuth().noon
    if args.resume_flow:
        flow=NowNowOrderFlow.resume_active(args.resume_flow,store_code=args.store_code,
            items=items,auth=auth)
        print(json.dumps({'flow_id':flow.flow_id,'phase':'resumed'}),flush=True)
    else:
        flow=NowNowOrderFlow(store_code=args.store_code,items=items,auth=auth)
        print(json.dumps({'flow_id':flow.flow_id,'phase':'created'}),flush=True)
    prepared=flow.prepare_only()
    verified=prepared_result(flow,prepared)
    review=prepared['review']
    print(json.dumps({'flow_id':flow.flow_id,'phase':'review','review':review}),flush=True)
    if args.prepare_only:
        return verified
    try:
        placed=flow.place()
    except nownow_transport.NowNowError as exc:
        if exc.code in ('AUTH_EXPIRED','AUTH_FORBIDDEN'):
            journal.fail('NOWNOW_AUTH_EXPIRED_NEEDS_APP_REBIND')
        raise
    print(json.dumps({'flow_id':flow.flow_id,'phase':'placed','order':placed['order']}),flush=True)
    tracking=flow.poll_tracking()
    paid=flow.confirm_paid(tracking)
    registration=flow.register_tracker(args.label,eta=tracking.get('estimate'),recipient=args.recipient)
    journal.complete(flow.flow_id)
    return {'ok':True,'flow_id':flow.flow_id,'order':flow.order,
            'items':items,'store_code':args.store_code,
            'payable_minor':flow.review['payable_minor'],'paid':paid,
            'delivery_status':tracking['status'],
            'eta':tracking.get('estimate'),'watcher':registration['watcher'],
            **order_watch_receipt.fields(registration),
            'financial_retry':False}


def order_main(args):
    """Paid noon MAIN marketplace E2E replay (NAEIA0042714780 contract).

    skuConfig -> offer -> cart add -> checkout session {shouldUpdateSession:
    true} with server-carried silent delivery + default card 5542 + home
    address -> place-order {total} -> order-status poll until success with
    shipments (paid). Frictionless: no CVV, no 3DS, no clientSecret use.
    """
    from commerce_main_order import MainOrderFlow
    import noon_marketplace_checkout as market_transport
    items=input_items(args,id_argument='sku_config',id_key='sku_config')
    auth=CommerceAuth().noon
    if args.resume_flow:
        flow=MainOrderFlow.resume_active(args.resume_flow,items=items,auth=auth)
        print(json.dumps({'flow_id':flow.flow_id,'phase':'resumed'}),flush=True)
    else:
        flow=MainOrderFlow(items=items,auth=auth)
        print(json.dumps({'flow_id':flow.flow_id,'phase':'created'}),flush=True)
    prepared=flow.prepare_only()
    verified=prepared_result(flow,prepared)
    review=prepared['review']
    print(json.dumps({'flow_id':flow.flow_id,'phase':'review','review':review}),flush=True)
    if args.prepare_only:
        return verified
    try:
        placed=flow.place()
    except market_transport.MarketplaceError as exc:
        if exc.code in ('AUTH_EXPIRED','AUTH_FORBIDDEN'):
            journal.fail('MAIN_AUTH_EXPIRED_NEEDS_APP_REBIND')
        raise
    print(json.dumps({'flow_id':flow.flow_id,'phase':'placed','order':placed['order']}),flush=True)
    paid=flow.await_success()
    flow.confirm_paid()
    tracking=flow.verify_tracking()
    registration=flow.register_tracker(args.label,recipient=args.recipient)
    journal.complete(flow.flow_id)
    return {'ok':True,'flow_id':flow.flow_id,'order':flow.order,
            'items':items,
            'payable_minor':flow.review['payable_minor'],'paid':paid,
            'delivery_status':tracking.get('status'),'tracking':tracking,
            'watcher':registration['watcher'],**order_watch_receipt.fields(registration),
            'financial_retry':False}


def order_supermall(args):
    """Paid noon SUPERMALL (rocket) E2E replay (NAEIA0000960441 contract).

    rocket catalog resolve -> quick-atc cart add -> checkout session
    {shouldUpdateSession:true} with server-carried silent delivery + default
    card 5542 + home address + isRocket shipment with absolute express
    deliveryDate -> place-order {total} -> order-status poll until success
    with shipments (paid). Frictionless: no CVV, no 3DS, no clientSecret use.
    """
    from commerce_supermall_order import SupermallOrderFlow
    import noon_marketplace_checkout as market_transport
    items=input_items(args,id_argument='sku_config',id_key='sku_config')
    auth = CommerceAuth().noon
    if args.resume_flow:
        state = journal.inspect(args.resume_flow)
        if state['order_id']:
            if args.prepare_only:
                journal.fail('PREPARE_ONLY_FLOW_ALREADY_ORDERED')
            result = SupermallOrderFlow.resume_paid(args.resume_flow, label=args.label,
                                                    eta=args.eta, recipient=args.recipient)
            return result
        flow = SupermallOrderFlow.resume_active(args.resume_flow, items=items, auth=auth)
        print(json.dumps({'flow_id': flow.flow_id, 'phase': 'resumed'}), flush=True)
    else:
        flow = SupermallOrderFlow(items=items, auth=auth)
        print(json.dumps({'flow_id': flow.flow_id, 'phase': 'created'}), flush=True)
    prepared=flow.prepare_only()
    verified=prepared_result(flow,prepared)
    review=prepared['review']
    print(json.dumps({'flow_id': flow.flow_id, 'phase': 'review', 'review': review}), flush=True)
    if args.prepare_only:
        return verified
    try:
        placed = flow.place()
    except market_transport.MarketplaceError as exc:
        if exc.code in ('AUTH_EXPIRED', 'AUTH_FORBIDDEN'):
            journal.fail('SUPERMALL_AUTH_EXPIRED_NEEDS_APP_REBIND')
        raise
    print(json.dumps({'flow_id': flow.flow_id, 'phase': 'placed', 'order': placed['order']}), flush=True)
    paid = flow.await_success()
    flow.confirm_paid()
    tracking = flow.verify_tracking()
    registration = flow.register_tracker(args.label, eta=flow.review.get('eta'),
                                         recipient=args.recipient)
    journal.complete(flow.flow_id)
    return {'ok': True, 'flow_id': flow.flow_id, 'order': flow.order,
            'items': items,
            'payable_minor': flow.review['payable_minor'], 'paid': paid,
            'delivery_status': tracking.get('status'), 'tracking': tracking,
            'eta': flow.review.get('eta'), 'watcher': registration['watcher'],
            **order_watch_receipt.fields(registration),
            'financial_retry': False}


def await_payment_flow(args):
    """Restart-safe status-only continuation of a consumed, unconfirmed payment.

    When the paid observation is already journalled (crash between payment
    confirmation and tracking/registration), this only finishes the exact
    tracking, watcher registration and journal completion.
    """
    from commerce_minutes import MinutesFlow,telegram_3ds_notify
    flow=MinutesFlow.resume_payment(args.flow_id)
    already_paid=journal.payment_reported(args.flow_id)
    if already_paid:
        paid={'paid':True,'payment_status':'payment_confirmed',
              'transaction_status':'CAPTURED','polls':0,'timed_out':False,
              'already_observed':True}
    else:
        notify=None if args.no_notify else (lambda order,total:telegram_3ds_notify(order,total))
        paid=flow.await_payment(notify=notify,wait_seconds=args.minutes*60)
    print(json.dumps({'flow_id':args.flow_id,'phase':'payment_awaited','paid':paid['paid'],
        'payment_status':paid['payment_status'],'transaction_status':paid['transaction_status'],
        'polls':paid['polls'],'timed_out':paid['timed_out']}),flush=True)
    if not paid['paid']:
        journal.fail('MINUTES_PAYMENT_WINDOW_ELAPSED_NO_RETRY' if paid['timed_out']
                     else 'MINUTES_PAYMENT_FAILED_NO_RETRY')
    tracking=flow.verify_tracking()
    if not flow.review.get('eta') and tracking.get('eta'):
        flow.review['eta']=tracking['eta']
    registration=flow.register_tracker('minutes CLI E2E test order (resumed)',
                                       recipient=getattr(args,'recipient','owner'))
    journal.complete(args.flow_id)
    return {'ok':True,'flow_id':args.flow_id,'order':flow.review['order'],
        'paid':{'payment_status':paid['payment_status'],
                'transaction_status':paid['transaction_status'],
                'authorized_minor':paid.get('authorized_minor'),
                'captured_minor':paid.get('captured_minor'),'polls':paid['polls'],
                'confirmed_at':dt.datetime.now(dt.timezone.utc).isoformat()},
        'delivery_status':tracking['status'],'eta':tracking.get('eta'),
        'tracking':tracking,'watcher':registration['watcher'],
        **order_watch_receipt.fields(registration),'financial_retry':False}


def release_flow(args):
    """Evidence-reviewed release of a fenced never-paid flow (noon minutes / talabat)."""
    from commerce_minutes import exact_failed_evidence
    binding=journal.binding(args.flow_id)
    local=journal.inspect(args.flow_id)
    if binding['app']=='noon' and binding['vertical']=='minutes':
        if local['state']!='FENCED':
            journal.fail('RELEASE_FENCED_ONLY')
        if not local['order_id']:
            journal.fail('RELEASE_ORDER_MISSING')
        if any(x['kind'] in ('payment','preauthorize','prepay') for x in local['operations']):
            journal.fail('RELEASE_PAYMENT_CONSUMED')
        evidence=exact_failed_evidence(CommerceAuth().noon,local['order_id'])
    elif binding['app']=='talabat' and binding['vertical'] in ('shops','mart','restaurants'):
        if not local['order_id'] and not any(x['kind'] in ('place','payment','preauthorize','prepay')
                                            for x in local['operations']):
            from commerce_talabat import release_failed_preparation
            result=release_failed_preparation(args.flow_id)
            return {'ok':True,'flow_id':args.flow_id,**result,'financial_retry':False}
        if local['state']!='FENCED':
            journal.fail('RELEASE_FENCED_ONLY')
        if any(x['kind'] in ('payment',) for x in local['operations']):
            journal.fail('RELEASE_PAYMENT_CONSUMED')
        if not local['order_id']:
            # Orderless refusal: the server answered the place with an error and
            # no order id. Evidence review = the refused place receipt itself
            # (4xx, empty order/transaction identity) plus the journal shape.
            import commerce_receipts as receipts
            snap = receipts.load(**binding).snapshot()
            refused = [r for r in snap.receipts if r.operation == 'place'
                       and 400 <= (r.http_status or 0) <= 499
                       and not r.order_id and not r.transaction_id]
            if len(refused) != 1:
                journal.fail('RELEASE_TALABAT_ORDERLESS_EVIDENCE_INVALID')
            evidence={'place_http_status':refused[0].http_status,
                      'place_state':refused[0].state,'order_id':None}
            result=journal.release_orderless(args.flow_id,
                evidence_hash=journal.digest({'flow_id':args.flow_id,'evidence':evidence}))
            return {'ok':True,'flow_id':args.flow_id,**result,
                    'order':None,'evidence':evidence,
                    'reservation_minor_retained':local['reserved_minor'],'financial_retry':False}
        # Live readback proving the merchant order never paid: the zombie sits in
        # order_confirmingdelayed with no amounts, unchanged for days, and the
        # journal itself never observed a payment send.
        track=talabat.orders.track(local['order_id'])
        evidence={'order_id':local['order_id'],'raw_status':track.get('raw_status'),
                  'status':track.get('status'),'amount':track.get('amount'),
                  'vendor':track.get('vendor')}
        if evidence['raw_status']!='order_confirmingdelayed' or evidence['amount'] is not None:
            journal.fail('RELEASE_TALABAT_EVIDENCE_INVALID')
    else:
        journal.fail('RELEASE_MINUTES_ONLY')
    result=journal.release(args.flow_id,
        evidence_hash=journal.digest({'flow_id':args.flow_id,'evidence':evidence}))
    return {'ok':True,'flow_id':args.flow_id,**result,
            'order':local['order_id'],'evidence':evidence,
            'reservation_minor_retained':local['reserved_minor'],'financial_retry':False}


def abandon_flow(args):
    """Terminal close of an ACTIVE flow that never sent anything (process-loss recovery)."""
    return {'ok':True,'flow_id':args.flow_id,**journal.abandon(args.flow_id),'financial_retry':False}


def track_exact(app, vertical, order):
    """Explicit vertical routing; never infer a purchase from a history match."""
    if app=='talabat':
        if vertical not in ('shops','restaurants','mart'):journal.fail('INVALID_COMMERCE_VERTICAL')
        return talabat.orders.track(order)
    if vertical=='minutes':
        import noon_http_orders
        return noon_http_orders.track(order)
    if vertical in ('main','supermall'):
        from commerce_marketplace import MarketplaceFlow
        return MarketplaceFlow(vertical).client.track(order)
    if vertical=='nownow':
        from commerce_nownow import reader
        return reader().track(order)
    journal.fail('INVALID_COMMERCE_VERTICAL')


def checkout_check(vertical):
    """Live read-only readiness; surface account disposition before cart writes."""
    if vertical not in ('main','supermall','nownow','minutes'):journal.fail('INVALID_COMMERCE_VERTICAL')
    auth=CommerceAuth().noon
    snapshot=auth.reconcile(vertical) if auth.status(vertical)['maintenance_state']!='none' else auth.revalidate(vertical)
    blocker=None
    try:journal.require_account_available('noon',snapshot.account_ref)
    except journal.JournalError as exc:blocker=str(exc)
    result={'ok':True,'app':'noon','vertical':vertical,'account_home_verified':True,
        'account_available':blocker is None,'blocker':blocker,'financial_send':False}
    if vertical in ('main','supermall'):
        from commerce_marketplace import MarketplaceFlow
        cart=MarketplaceFlow(vertical,auth=auth).cart()
        result.update(cart_empty=cart['empty'],item_count=cart['count'])
    elif vertical=='nownow':
        from commerce_nownow import reader
        recent=reader(auth=auth).recent_carts(timeout=25)
        result.update(existing_store_carts=len(recent.projection['carts']),ownership='not_adopted')
    elif vertical=='minutes':
        from commerce_minutes import readback_active_orders,readback_session
        cart=readback_session(auth)
        active=readback_active_orders(auth)
        result.update(cart_empty=not cart.projection['lines'],
                      item_count=sum(line['quantity'] for line in cart.projection['lines']),
                      total_minor=cart.projection['total_minor'],
                      active_orders=active.projection['active'])
    return result


def review_contract(vertical):
    """Machine-readable native contract gaps, not synthetic financial approval."""
    if vertical in ('main','supermall'):
        from noon_marketplace_native_shape import NATIVE_SHAPE,UNRESOLVED
        from noon_marketplace_invoice import NATIVE_ROLE_CONTRACT
        from noon_marketplace_quiet import MISSING_NODES
        return {'ok':True,'vertical':vertical,'review_engine':'noon_marketplace_review.review',
            'native_shape':NATIVE_SHAPE.evidence_id,
            'mapped_native_fields':[key for key,field in NATIVE_SHAPE.fields],
            'selected_card':'paymentMethodsV2.methods active cc_noonpay; cards/cardSections; isSelected; id/mask/type',
            'unresolved_nodes':dict(UNRESOLVED),
            'invoice_contract':NATIVE_ROLE_CONTRACT,
            'invoice_arithmetic':'complete exact HTML rows plus snapshot-bound local label review; no native fee-code inference',
            'quiet_delivery_supported':False,'quiet_missing_nodes':MISSING_NODES,
            'requires_owned_manifest':True,'financial_send':False}
    if vertical=='nownow':
        return {'ok':True,'vertical':vertical,'review_engine':'noon_nownow_review.review_snapshot',
            'selected_card_binding':'native card.id plus acknowledged journalled edit-payment request; no basket token echo required',
            'finalize_context_keys':['paymentMethod','walletEnabled','walletAmount','card','applePayHashedTransactionId'],
            'controller_validation':'validateBasket(true)',
            'controller_branches':['validate_basket_required','preorder_subscription_required','finalize_candidate',
                                   'device_verification_required','validation_warning'],
            'validation_wire':{'method':'POST','path':'/_svc/mp-shop-api-mpnoon/v1/session/validate','body_keys':['sessionCode']},
            'preorder_journal':['preauthorize_full_budget','exact_intent_hash','prepay_once','status_only_recovery','place_attach_same_reservation'],
            'unresolved':['live paid order acceptance','human challenge continuation if returned'],
            'requires_owned_manifest':True,'financial_send':False}
    journal.fail('INVALID_COMMERCE_VERTICAL')


def recover_talabat(flow_id, *, max_reads=90, recipient='owner'):
    binding=journal.binding(flow_id)
    if binding['app']!='talabat':journal.fail('TALABAT_FLOW_REQUIRED')
    store=receipts.load(**binding)
    cursor=store.snapshot().talabat_readback()

    def finish_recovered(state, reason, next_index):
        """Close a conclusive paid flow read-only: reconcile fence, exact-order
        readback, tracker readback (registering once if missing), completion."""
        completed=False; completion_error=None; notice={}
        if state=='PAYMENT_REPORTED_SUCCESS' and journal.inspect(flow_id)['order_id']:
            try:
                if journal.inspect(flow_id)['state']=='FENCED':
                    journal.reconcile_fenced_payment(flow_id,
                        evidence_hash=journal.digest({'recovered_poll':True,
                            'payment_id':getattr(cursor.context,'payment_id',None),
                            'transaction_id':getattr(cursor.context,'transaction_id',None)}))
                order=journal.inspect(flow_id)['order_id']
                saved=CommerceAuth().fresh_before_mutation('talabat',binding['vertical']).mutation_account(binding['vertical'])
                if account_hash(saved)!=binding['account_hash']:journal.fail('RECOVERY_ACCOUNT_CHANGED')
                def no_mutation(_):journal.fail('RECOVERY_READ_ONLY')
                gate=FlowGate(**binding,receipt_sink=store,request_check=no_mutation)
                gate.opened=True
                tracking=talabat_orders.track(order)
                gate.exact_order(tracking)
                name=f"order-talabat-{order.lower()}"
                cfg_path=Path.home()/'.local/state/order-tracker/orders'/f'{name}.json'
                watch_path=Path.home()/'.local/share/robob-watch/watchers'/name/'watcher.json'
                registered=False
                try:
                    # active=True = still watching; active=False = tracker closed
                    # itself after a terminal state (e.g. delivered). Both mean
                    # registration happened: these files are only written by
                    # order-watch add for this exact order.
                    cfg=json.loads(cfg_path.read_text()); watch=json.loads(watch_path.read_text())
                    registered=(cfg.get('order')==order and cfg.get('watcher')==name and bool(watch))
                except (OSError,ValueError):
                    registered=False
                who='moni' if registered and cfg.get('for')=='moni' else recipient
                closed=registered and cfg.get('active') is False
                if not registered or (who=='moni' and not closed):
                    # Re-adding an existing watcher only releases a placement
                    # text held while payment was unconfirmed; never twice.
                    env={k:v for k,v in os.environ.items() if k not in ('NODE_OPTIONS','BUN_OPTIONS','BUN_INSPECT')}
                    command=[str(Path.home()/'.local/bin/order-watch'),'add','--app','talabat','--order',order,
                             *order_watch_receipt.command_args(who),
                             '--placed-at',dt.datetime.now(dt.timezone.utc).isoformat(),
                             '--label','talabat recovered paid order']
                    try:
                        added=subprocess.run(command,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=125)
                    except (OSError,subprocess.TimeoutExpired):
                        journal.fail('TRACKER_REGISTRATION_UNCONFIRMED_READBACK_REQUIRED')
                    notice=order_watch_receipt.parse(added.stdout,added.returncode,who,name)[1]
                    try:
                        cfg=json.loads(cfg_path.read_text()); watch=json.loads(watch_path.read_text())
                        registered=(cfg.get('order')==order and cfg.get('watcher')==name and bool(watch))
                    except (OSError,ValueError):
                        registered=False
                    if not registered:
                        journal.fail('TRACKER_REGISTRATION_UNCONFIRMED_READBACK_REQUIRED')
                gate.tracker_registered(order, {'watcher': name, 'active': True})
                journal.complete(flow_id)
                completed=True
            except Exception as exc:
                completion_error=getattr(exc,'code',None) or str(exc)
        return {'state':state,'reason':reason,'flow_id':flow_id,
                'next_index':next_index,'financial_retry':False,
                'completed':completed,'completion_error':completion_error,
                **(order_watch_receipt.fields(notice) if notice else {})}

    if cursor.stopped and cursor.result.state != 'PAYMENT_UNKNOWN':
        # A conclusive stored result (success/error/blocked/challenge) settles
        # recovery from evidence alone. PAYMENT_UNKNOWN is precisely the state
        # where a fresh read-only poll is needed; the stored literal must not
        # freeze the flow forever.
        return finish_recovered(cursor.result.state, cursor.result.reason, cursor.next_index)
    saved=CommerceAuth().fresh_before_mutation('talabat',binding['vertical']).mutation_account(binding['vertical'])
    if account_hash(saved)!=binding['account_hash']:journal.fail('RECOVERY_ACCOUNT_CHANGED')
    def no_mutation(_):journal.fail('RECOVERY_READ_ONLY')
    gate=FlowGate(**binding,receipt_sink=store,request_check=no_mutation)
    gate.opened=True
    poller=talabat.AsyncPaymentPoller(saved,cursor.context,receipt=gate.talabat_receipt,
        next_index=cursor.next_index,timeout=120)
    result=poller.poll(max_reads=max_reads)
    return finish_recovered(result.state, result.reason, poller.next_index)


def recover_payment(flow_id, *, max_reads=90, recipient='owner'):
    binding=journal.binding(flow_id)
    if binding['app']=='talabat':return recover_talabat(flow_id,max_reads=max_reads,recipient=recipient)
    if binding['vertical']=='nownow' and journal.preorder_status(flow_id)['operations']:
        from commerce_preorder import recover
        return recover(flow_id)
    # Noon restart recovery uses the exact persisted order. A returned intent is
    # never permission to replay a consumed completion or pay a failed order.
    from commerce_order_status import status
    result=status(flow_id)
    return {**result,'recovery':'exact_order_readback_only','financial_retry':False}


def basket_arguments(parser, flag):
    source=parser.add_mutually_exclusive_group(required=True)
    source.add_argument(flag)
    source.add_argument('--items-file',metavar='PATH',
        help='basket JSON array or {"items":[...]}; use - for stdin')
    parser.add_argument('--quantity',type=int,default=None,
        help='quantity for the single-item flag (default 1); not combined with --items-file')
    parser.add_argument('--prepare-only',action='store_true',
        help='create/review the basket with exact readback, without ordering or paying (not read-only)')
    recipient_argument(parser)
    parser.add_argument('--moni-go',default=None,metavar='HER_WORDS',
        help="required with --for moni unless --prepare-only: Moni's own go, quoted from her chat (checked against "
             'her messages in the last 45 min; fails closed with MONI_GO_NOT_FOUND)')


def require_moni_go(args):
    """Moni's own go must be on record before anything is placed for her.

    Abdullah's standing approval pays for her orders; it never picks them.
    Prepare-only runs never place, so they don't need it.
    """
    placing=args.command=='test-talabat-shops' or args.command=='order'
    if not placing or getattr(args,'recipient','owner')!='moni' or getattr(args,'prepare_only',False):return None
    import moni_go
    return moni_go.verify(getattr(args,'moni_go',None) or '')


def recipient_argument(parser):
    parser.add_argument('--for',dest='recipient',choices=order_watch_receipt.RECIPIENTS,default='owner',
        help='who ordered; moni = order-watch texts her the placement (once per order) and routes arrival texts to her. '
             'Label as "Store: items" for that text')


def talabat_arguments(parser):
    basket_arguments(parser,'--item')
    parser.add_argument('--branch',type=int,required=True)
    parser.add_argument('--apk-pool',default=str(Path.home()/'.local/state/app-api-cli/talabat-apk-pool.txt'))
    parser.add_argument('--vertical',choices=('shops','mart','restaurants'),default='shops',
        help='mart for dark stores, shops for other retail, restaurants for food')
    parser.add_argument('--resume-flow',default=None,metavar='FLOW_UUID',
        help='resume the exact original pre-financial basket; never retry an ambiguous financial send')
    parser.add_argument('--item-note',default='',metavar='TEXT',
        help='restaurant note for the single-item flag; basket files carry per-line notes')
    parser.add_argument('--label',default='Talabat order')


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    commands=parser.add_subparsers(dest='command',required=True)
    commands.add_parser('capabilities')
    commands.add_parser('restaurant-cart-contract')
    for name in ('menu','choices'):
        discovery=commands.add_parser(name,help='Read Talabat menu items or item choices; never changes a cart')
        discovery.add_argument('app',choices=('talabat',))
        discovery.add_argument('--branch',type=int,required=True)
        if name=='choices':discovery.add_argument('--item',type=int,required=True)
    inspect=commands.add_parser('inspect');inspect.add_argument('flow_id')
    recover=commands.add_parser('recover-payment');recover.add_argument('flow_id')
    recover.add_argument('--max-reads',type=int,default=90)
    recipient_argument(recover)
    track=commands.add_parser('track');track.add_argument('flow_id')
    exact=commands.add_parser('track-exact');exact.add_argument('app',choices=('noon','talabat'))
    exact.add_argument('vertical');exact.add_argument('order')
    status=commands.add_parser('order-status');status.add_argument('flow_id')
    disposition=commands.add_parser('reconcile-order');disposition.add_argument('flow_id')
    cart=commands.add_parser('marketplace-cart');cart.add_argument('service',choices=('main','supermall'))
    preflight=commands.add_parser('checkout-check');preflight.add_argument('vertical',choices=('main','supermall','nownow','minutes'))
    contract=commands.add_parser('review-contract');contract.add_argument('vertical',choices=('main','supermall','nownow'))
    auth=commands.add_parser('auth');auth.add_argument('app',choices=('noon','talabat'))
    auth.add_argument('vertical');maintenance=auth.add_mutually_exclusive_group()
    maintenance.add_argument('--recover',action='store_true');maintenance.add_argument('--reconcile',action='store_true')
    maintenance.add_argument('--diagnose-readonly',action='store_true')
    buy=commands.add_parser('test-talabat-shops',help='Compatibility alias for order talabat')
    talabat_arguments(buy)
    order=commands.add_parser('order')
    order_commands=order.add_subparsers(dest='order_command',required=True)
    talabat_order=order_commands.add_parser('talabat',
        help='Caller-authorized Talabat basket with per-item notes and menu choices')
    talabat_arguments(talabat_order)
    minutes_order=order_commands.add_parser('minutes',
        help='Authorized Minutes paid order E2E: guard, sync, quiet, review, place, encrypted-CVV pay, 3DS wait, tracking')
    basket_arguments(minutes_order,'--sku')
    minutes_order.add_argument('--cvv-from-keychain',action='store_true',
        help='read the saved-card CVV from Keychain robob-card into RAM (required when the session demands CVV)')
    minutes_order.add_argument('--label',default='Noon Minutes order')
    minutes_order.add_argument('--resume-flow',default=None,metavar='FLOW_UUID',
        help='continue an ACTIVE preparation flow (exact cart readback; nothing re-sent)')
    nownow_order=order_commands.add_parser('nownow',
        help='Authorized NowNow paid order E2E: guard, session, validate, saved-card, quiet, place, tracking')
    basket_arguments(nownow_order,'--product-code')
    nownow_order.add_argument('--store-code',required=True)
    nownow_order.add_argument('--label',default='Noon NowNow order')
    nownow_order.add_argument('--resume-flow',default=None,metavar='FLOW_UUID',
        help='continue an ACTIVE pre-place flow (24h window; exact session readback)')
    main_order=order_commands.add_parser('main',
        help='Authorized noon MAIN marketplace paid order E2E: cart, session verify, frictionless place, status poll')
    basket_arguments(main_order,'--sku-config')
    main_order.add_argument('--label',default='Noon Main order')
    main_order.add_argument('--resume-flow',default=None,metavar='FLOW_UUID',
        help='continue an ACTIVE pre-place flow (24h window; exact basket readback)')
    supermall_order=order_commands.add_parser('supermall',
        help='Authorized noon SUPERMALL (rocket) paid order E2E: rocket resolve, quick-atc add, session verify, frictionless place, status poll')
    basket_arguments(supermall_order,'--sku-config')
    supermall_order.add_argument('--label',default='Noon Supermall order')
    supermall_order.add_argument('--resume-flow',default=None,metavar='FLOW_UUID',
        help='continue an ACTIVE flow (pre-place basket readback within 24h, or read-only paid completion)')
    supermall_order.add_argument('--eta',default=None,metavar='ISO_DATE',
        help='absolute promise deliveryDate (with offset) for the watcher; paid resume only')
    await_cmd=commands.add_parser('await-payment',help='Status-only 3DS wait continuation of a consumed minutes payment')
    await_cmd.add_argument('flow_id')
    await_cmd.add_argument('--minutes',type=float,default=4.0)
    await_cmd.add_argument('--no-notify',action='store_true')
    recipient_argument(await_cmd)
    release=commands.add_parser('release-flow',
        help='Evidence-reviewed local release: failed Talabat quote with no financial send, or verified never-paid order')
    release.add_argument('flow_id')
    abandon=commands.add_parser('abandon-flow',
        help='Local close of eligible preparation with all sends observed, no financial ops and zero reserved')
    abandon.add_argument('flow_id')
    args=parser.parse_args(argv)
    try:
        moni_go=require_moni_go(args)
        if args.command=='capabilities':result=capabilities()
        elif args.command in ('menu','choices'):result=talabat_discovery(args)
        elif args.command=='restaurant-cart-contract':
            from talabat_restaurant_cart import contract
            result={'ok':True,**contract()}
        elif args.command=='test-talabat-shops':result=purchase_talabat(args)
        elif args.command=='order' and args.order_command=='talabat':result=purchase_talabat(args)
        elif args.command=='order' and args.order_command=='minutes':result=order_minutes(args)
        elif args.command=='order' and args.order_command=='nownow':result=order_nownow(args)
        elif args.command=='order' and args.order_command=='main':result=order_main(args)
        elif args.command=='order' and args.order_command=='supermall':result=order_supermall(args)
        elif args.command=='await-payment':result=await_payment_flow(args)
        elif args.command=='release-flow':result=release_flow(args)
        elif args.command=='abandon-flow':result=abandon_flow(args)
        elif args.command=='inspect':result=journal.inspect(args.flow_id)
        elif args.command=='recover-payment':
            result=recover_payment(args.flow_id,max_reads=args.max_reads,recipient=args.recipient)
        elif args.command=='order-status':
            from commerce_order_status import status
            result=status(args.flow_id)
        elif args.command=='reconcile-order':
            from commerce_reconcile import reconcile
            result=reconcile(args.flow_id)
        elif args.command=='marketplace-cart':
            from commerce_marketplace import MarketplaceFlow
            result=MarketplaceFlow(args.service).cart()
        elif args.command=='checkout-check':result=checkout_check(args.vertical)
        elif args.command=='review-contract':result=review_contract(args.vertical)
        elif args.command=='track-exact':result=track_exact(args.app,args.vertical,args.order)
        elif args.command=='auth':
            manager=CommerceAuth()
            if args.diagnose_readonly:
                if args.app!='noon':journal.fail('READONLY_DIAGNOSTIC_NOON_ONLY')
                result=manager.noon.diagnose_readonly(args.vertical)
            else:
                result=manager.recover(args.app,args.vertical,reconcile=args.reconcile) if args.recover or args.reconcile else manager.status(args.app,args.vertical)
        else:
            state=journal.inspect(args.flow_id)
            if not state['order_id']:journal.fail('EXACT_ORDER_ID_UNAVAILABLE')
            result=track_exact(state['app'],state['vertical'],state['order_id'])
        if moni_go and isinstance(result,dict):result={**result,'moni_go':moni_go}
        print(json.dumps(result))
        return 1 if result.get('ok') is False else 0
    except Exception as exc:
        code=str(exc)
        preparation=re.fullmatch(r'PREPARATION_FAILED:(quote_(?:initial|initial_quiet|selected|selected_quiet|final_quiet)):([A-Z][A-Z0-9_]{1,99})',code)
        if isinstance(exc,talabat.orders.TalabatError) and preparation:
            print(json.dumps({'ok':False,'error':'PREPARATION_FAILED','phase':preparation[1],
                              'cause':preparation[2],'financial_send':False,'financial_retry':False}))
            return 1
        if not re.fullmatch(r'[A-Z][A-Z0-9_]{0,100}',code):code='COMMERCE_OPERATION_FAILED'
        print(json.dumps({'ok':False,'error':code,'financial_retry':False}))
        return 1


if __name__=='__main__':sys.exit(main())
