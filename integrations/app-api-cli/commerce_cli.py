"""Native HTTP commerce: caller-authorized baskets and exact recovery."""
import argparse
import json
import re
import sys
import os
import subprocess
import datetime as dt
from pathlib import Path

import card_status
import commerce_journal as journal
import commerce_receipts as receipts
from commerce_auth_status import CommerceAuth
from commerce_flow import FlowGate, account_hash
from commerce_basket_input import input_items
import talabat_http_checkout as talabat
import talabat_http_orders as talabat_orders
import order_watch_receipt
import order_card

RECONCILE_NOT_REORDER=('An order ID may already exist and payment may have been sent. Do not place another '
                       'order. Run "commerce recover-payment {flow}" and "commerce order-status {flow}".')
RECOVERY_NOT_REORDER=('Still unconfirmed. Do not place another order. Check "commerce order-status {flow}" '
                      'and "commerce reconcile-order {flow}"; rerun recover-payment later.')
# Every paying lane uses this saved card (order_card.LAST4; the cancelled card is refused there).
ORDER_CARD_LAST4=order_card.LAST4
# Owner pause on all ordering: while this file exists, money commands refuse (exit 4).
PAUSE_FILE=Path(os.environ.get('ORDERING_PAUSE_FILE') or Path.home()/'.local/state/ordering-paused')
PAUSED_COMMANDS=frozenset({'order','test-talabat-shops','await-payment','marketplace-cart','cart','recover-payment'})
# close-food-captured is excluded: it reads bank/order evidence and closes local
# ownership only; it has no place, completion, payment or other remote send.
EXIT_PAUSED=4
# Only outcomes that clearly mean the card itself was refused.
CARD_DECLINE_REASONS=frozenset({'PAYMENT_DECLINED_INSUFFICIENT_FUNDS_NO_RETRY',
                                'PAYMENT_DECLINED_BY_ISSUER_NO_RETRY'})


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
             *__import__('delivery_cards').commerce_args(flow, state['vertical']),
             *order_watch_receipt.command_args(recipient,state.get('reserved_minor')),
             '--placed-at',dt.datetime.now(dt.timezone.utc).isoformat(),'--label',label,
             *(['--payment-confirmed'] if paid else ['--hold-placed-text'])]
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
        flow=TalabatFlow(vertical=args.vertical,branch=args.branch,items=items,flow_id=args.resume_flow,
                         allow_duplicate_of=getattr(args,'allow_duplicate_of',None))
        print(json.dumps({'flow_id':flow.flow_id,'phase':'resumed'}),flush=True)
        review=flow.resume_cart(verticals_key=verticals_key)
    else:
        flow=TalabatFlow(vertical=args.vertical,branch=args.branch,items=items,
                         allow_duplicate_of=getattr(args,'allow_duplicate_of',None))
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
    confirmed=False
    tracking=None
    try:
        result=flow.purchase()
        result.update(ok=False, purchase_confirmed=False, financial_retry=False,
                      payment_reported_success=result['state']=='PAYMENT_REPORTED_SUCCESS',
                      payment_capture_verified=None, delivery_status='pending confirmation')
        order=journal.inspect(flow.flow_id)['order_id']
        if order:
            result['order']=order  # Recovery identity, never a placement claim.
        noted=note_card_decline(result,app='talabat')
        if noted:result['card_status']=noted
        if result['state']=='PAYMENT_REPORTED_SUCCESS':
            # A failed verification read must not hide the reported payment and
            # order identity behind a bare error code; that invites a re-order.
            try:
                tracking=flow.checkout.track()
                result['order_verification']=tracking
                if tracking.get('order_list_present') is not True or tracking.get('order_account_verified') is not True:
                    result['error']='TALABAT_ORDER_LIST_CONFIRMATION_REQUIRED'
                else:
                    flow.gate.exact_order(tracking)
                    confirmed=True
            except Exception as exc:
                code=getattr(exc,'code',None) or str(exc)
                result['error']='TALABAT_ORDER_VERIFICATION_FAILED'
                result['verification_error']=(code if type(code) is str and re.fullmatch(r'[A-Z][A-Z0-9_]{0,100}',code)
                                              else 'ORDER_VERIFICATION_READ_FAILED')
        else:
            result['error']='TALABAT_PAYMENT_NOT_CONFIRMED' if order else 'TALABAT_PLACE_NOT_CONFIRMED'
        if not confirmed:
            from commerce_order_status import TALABAT_ORDERLESS_NEXT_ACTION
            result['next_action']=(RECONCILE_NOT_REORDER.format(flow=flow.flow_id) if order
                                   else TALABAT_ORDERLESS_NEXT_ACTION)
        if result['state']=='REJECTED_DUPLICATE':
            from commerce_talabat_duplicate import NEXT_ACTION
            result.update(error='TALABAT_REJECTED_DUPLICATE',delivery_status=None,
                          next_action=NEXT_ACTION.replace('FLOW',flow.flow_id))
    finally:
        # A returned order must be tracked even when payment validation or its
        # receipt raises. This never repeats place or submits a payment fallback.
        if journal.inspect(flow.flow_id)['order_id']:
            tracking_registration=register_tracking(flow,args.label,args.recipient,paid=confirmed)
    if tracking_registration is not None:
        result['tracking']=tracking_registration
        result.update(order_watch_receipt.fields(tracking_registration))
    if confirmed:
        journal.complete(flow.flow_id)
        result.update(ok=True,purchase_confirmed=True)
        result['order']=tracking['order'];result['delivery_status']=tracking['status']
        result['payable_minor']=review['payable_minor']
    return result


def talabat_retired_note():
    import talabat_retired
    return talabat_retired.MESSAGE


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
        'campaign_cap_minor':journal.TOTAL_LIMIT_MINOR,
        'selected_card':{'last4':order_card.LAST4,'network':order_card.NETWORK,'bank_app':order_card.BANK_APP},
        'live_paid_proof_card':'2342',
        'nownow_selected_card_purchase_enabled':order_card.LAST4=='2342',
        'marketplace_card_selection':'requires matching default card in noon app',
        'verticals':{
        'noon.food':{'purchase_enabled':True,'payment':'automatic_saved_card_native_and_bank',
            'cards':['9546','2342'],'explicit_payment_requirements':'needs_app','financial_retry':False},
        'noon.minutes':{'auth':'verified_cookie_revalidation','cart':'journalled_native',
            'place':'live_order_created','payment':'live_confirmed_e2e_paid_order_2026_10_10',
            'tracking':'exact_native','rejected_auth_renewal_proven':False,
             'multi_item_baskets':True,'multi_item_cart_live_verified':True,
             'multi_item_purchase_live_verified':True,
             'cart_edit':'cart minutes show | cart minutes set --items-file F --expect-hash H (journalled whole-cart replace, never orders)',
             'order_current_cart':'order minutes --items-file F --use-current-cart (orders the server cart only when it matches F exactly)'},
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
        'talabat_order_scope':'retired_by_owner_2026_11_07',
        'talabat_retired':talabat_retired_note(),
        'spending_policy':'caller_managed_no_cli_order_or_campaign_cap',
        'basket_input':'items_file_json_array_or_items_object_with_legacy_single_item_flags',
        'noon_session_recovery':'bounded_same_account_revalidation_and_peer_cookie_adoption',
        'noon_refresh_grant_verified':False,
        'prepare_only':'cart_and_quote_mutations_with_readback_no_place_or_payment',
        'financial_retry':False}


def cvv_from_keychain():
    """Saved-card CVV from Keychain into RAM; never an argument, file or log line."""
    command=['security','find-generic-password','-s','robob-card','-a',order_card.CVV_ACCOUNT,'-w']
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


QUIET_NOT_OFFERED_NOTICE=("noon didn't offer leave at door for this cart; don't ring bell is on "
                          "and the driver note asks to leave it at the door")


def quiet_notice(review):
    """Tell the requester when noon offered no leave-at-door toggle for this cart."""
    if isinstance(review,dict) and review.get('quiet_codes_not_offered'):
        return QUIET_NOT_OFFERED_NOTICE
    return None


def order_minutes(args):
    """Full paid Minutes E2E: guard, sync, quiet, review, place, pay, 3DS wait, track.

    Journalled at-most-once per operation; a paid outcome requires the captured
    terminal payment triple, exact tracking and a registered order watcher.
    """
    from commerce_minutes import MinutesFlow,readback_active_orders,telegram_3ds_notify,telegram_stall_notify
    import noon_minutes_checkout as minutes_transport
    items=input_items(args,id_argument='sku',id_key='sku',quantity_key='qty')
    auth=CommerceAuth().noon
    guard=readback_active_orders(auth)
    if guard.projection['count']:
        print(json.dumps({'phase':'active_order_blocker',
                          'active_orders':guard.projection['active']}),flush=True)
        journal.fail('MINUTES_ACTIVE_ORDER_PRESENT')
    extra=getattr(args,'driver_note_extra',None)
    use_current=bool(getattr(args,'use_current_cart',False))
    if args.resume_flow:
        flow=MinutesFlow.resume_active(args.resume_flow,items=items,auth=auth,driver_note_extra=extra,
                                       use_current_cart=use_current)
        print(json.dumps({'flow_id':flow.flow_id,'phase':'resumed'}),flush=True)
    else:
        flow=MinutesFlow(items=items,auth=auth,driver_note_extra=extra,use_current_cart=use_current)
        print(json.dumps({'flow_id':flow.flow_id,'phase':'created'}),flush=True)
    try:
        prepared=flow.prepare_only()
        verified=prepared_result(flow,prepared)
        review=prepared['review']
        print(json.dumps({'flow_id':flow.flow_id,'phase':'review','review':review}),flush=True)
        notice=quiet_notice(review)
        # The final result carries the same notice as the prepare-only result.
        if notice:
            verified={**verified,'quiet_notice':notice}
            print(json.dumps({'flow_id':flow.flow_id,'phase':'quiet_notice','quiet_notice':notice}),flush=True)
        if args.prepare_only:
            return verified
        # Preparation never even loads the saved-card CVV. Read it only on the
        # explicitly invoked financial path, and never retain it in output.
        cvv=cvv_from_keychain() if args.cvv_from_keychain else None
        placed=flow.place(cvv_ready=cvv is not None)
        print(json.dumps({'flow_id':flow.flow_id,'phase':'placed','order':placed['order']}),flush=True)
        with minutes_after_send(flow,sending=True):
            payment=flow.complete(cvv=cvv)
        print(json.dumps({'flow_id':flow.flow_id,'phase':'payment_submitted','payment':payment}),flush=True)
    except minutes_transport.MinutesError as exc:
        if exc.code in ('AUTH_EXPIRED','AUTH_FORBIDDEN'):
            journal.fail('MINUTES_AUTH_EXPIRED_NEEDS_APP_REBIND')
        raise
    with minutes_after_send(flow):
        if payment['payment_status']=='payment_pending':
            notify=telegram_3ds_notify(placed['order'],review['payable_minor'])
        elif payment['payment_status']=='payment_confirmed':
            # Captured flow always challenges, but a confirmed direct return is paid,
            # not an error; the status readback below still proves the terminal triple.
            notify={'notified':False,'reason':'payment_confirmed_without_challenge'}
        else:
            # The card was sent; a refused answer still isn't proof nothing was charged.
            journal.payment_fail('MINUTES_PAYMENT_NOT_PENDING',flow_id=flow.flow_id,order=flow.review.get('order'),
                                 amount_minor=flow.review.get('amount'))
        print(json.dumps({'flow_id':flow.flow_id,'phase':'owner_3ds_notified','notify':notify}),flush=True)
        paid=flow.await_payment(wait_seconds=600,stall=telegram_stall_notify)
        print(json.dumps({'flow_id':flow.flow_id,'phase':'payment_awaited','paid':paid['paid'],
            'payment_status':paid['payment_status'],'transaction_status':paid['transaction_status'],
            'authorized_minor':paid.get('authorized_minor'),'polls':paid['polls'],
            'timed_out':paid['timed_out']}),flush=True)
        if not paid['paid']:
            minutes_payment_fail(flow,paid)
    tracking=flow.verify_tracking()
    registration=flow.register_tracker(args.label,recipient=args.recipient)
    journal.complete(flow.flow_id)
    return {'ok':True,'flow_id':flow.flow_id,'order':placed['order'],
        'items':items,
        **({'quiet_notice':notice} if notice else {}),
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
    if not args.prepare_only and order_card.LAST4 != '2342':
        journal.fail('NOWNOW_SELECTED_CARD_PAYMENT_UNVERIFIED_USE_PHONE')
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
    true} with server-carried silent delivery + default card (order_card.LAST4) + home
    address -> place-order {total} -> order-status poll until success with
    shipments (paid), including encrypted CVV and out-of-band ENBD approval.
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
    flow.prepare_payment(cvv_loader=cvv_from_keychain if args.cvv_from_keychain else None)
    try:
        with marketplace_after_send(flow,sending=True):
            placed=flow.place()
    except market_transport.MarketplaceError as exc:
        if exc.code in ('AUTH_EXPIRED','AUTH_FORBIDDEN'):
            journal.fail('MAIN_AUTH_EXPIRED_NEEDS_APP_REBIND')
        raise
    print(json.dumps({'flow_id':flow.flow_id,'phase':'placed','order':placed['order']}),flush=True)
    with marketplace_after_send(flow):
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
    card (order_card.LAST4) + home address + isRocket shipment with absolute express
    deliveryDate -> place-order {total} -> order-status poll until success
    with shipments (paid), including encrypted CVV and ENBD approval.
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
    flow.prepare_payment(cvv_loader=cvv_from_keychain if args.cvv_from_keychain else None)
    try:
        with marketplace_after_send(flow, sending=True):
            placed = flow.place()
    except market_transport.MarketplaceError as exc:
        if exc.code in ('AUTH_EXPIRED', 'AUTH_FORBIDDEN'):
            journal.fail('SUPERMALL_AUTH_EXPIRED_NEEDS_APP_REBIND')
        raise
    print(json.dumps({'flow_id': flow.flow_id, 'phase': 'placed', 'order': placed['order']}), flush=True)
    with marketplace_after_send(flow):
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


def marketplace_after_send(flow,sending=False):
    return journal.after_payment_send(flow_id=flow.flow_id,order=getattr(flow,'order',None),
                                      amount_minor=flow.review['payable_minor'],sending=sending)


def minutes_after_send(flow,sending=False):
    return journal.after_payment_send(flow_id=flow.flow_id,order=flow.review.get('order'),
                                      amount_minor=flow.review.get('amount'),sending=sending)


def minutes_payment_fail(flow,paid):
    # No Minutes read proves a no-capture, so a failed or unconfirmed payment is never "not charged".
    outcome=('declined' if not paid['timed_out'] else
             'confirming' if paid.get('payment_status')=='payment_confirmed' else 'waiting')
    journal.payment_fail('MINUTES_PAYMENT_WINDOW_ELAPSED_NO_RETRY' if paid['timed_out']
                         else 'MINUTES_PAYMENT_FAILED_NO_RETRY',flow_id=flow.flow_id,
                         order=flow.review.get('order'),amount_minor=flow.review.get('amount'),
                         outcome=outcome)


def await_payment_flow(args):
    """Restart-safe status-only continuation of a consumed, unconfirmed payment.

    When the paid observation is already journalled (crash between payment
    confirmation and tracking/registration), this only finishes the exact
    tracking, watcher registration and journal completion.
    """
    binding = journal.binding(args.flow_id)
    if binding['app'] == 'noon' and binding['vertical'] in ('main', 'supermall'):
        from commerce_main_order import MainOrderFlow
        from commerce_supermall_order import SupermallOrderFlow
        from commerce_marketplace_payment import telegram_3ds_notify
        cls = MainOrderFlow if binding['vertical'] == 'main' else SupermallOrderFlow
        flow = cls.resume_payment(args.flow_id)
        if journal.payment_reported(args.flow_id):
            if journal.inspect(args.flow_id)['state'] == 'FENCED':
                journal.reconcile_marketplace_paid(args.flow_id,
                    evidence_hash=journal.digest({'order': flow.order, 'retained_paid_evidence': True}))
            paid = {'paid': True, 'already_observed': True}
        else:
            with marketplace_after_send(flow):
                paid = flow.await_success(wait_seconds=args.minutes * 60,
                                          notify=None if args.no_notify else telegram_3ds_notify)
        tracking = flow.verify_tracking()
        registration = flow.register_tracker(args.label, recipient=args.recipient)
        journal.complete(args.flow_id)
        return {'ok': True, 'flow_id': args.flow_id, 'order': flow.order, 'paid': paid,
                'tracking': tracking, 'watcher': registration['watcher'],
                **order_watch_receipt.fields(registration), 'financial_send': False,
                'financial_retry': False}
    from commerce_minutes import MinutesFlow,telegram_3ds_notify,telegram_stall_notify
    flow=MinutesFlow.resume_payment(args.flow_id)
    already_paid=journal.payment_reported(args.flow_id)
    if already_paid:
        paid={'paid':True,'payment_status':'payment_confirmed',
              'transaction_status':'CAPTURED','polls':0,'timed_out':False,
              'already_observed':True}
    else:
        notify=None if args.no_notify else (lambda order,total:telegram_3ds_notify(order,total))
        stall=None if args.no_notify else telegram_stall_notify
        with minutes_after_send(flow):
            paid=flow.await_payment(notify=notify,wait_seconds=args.minutes*60,stall=stall)
    with minutes_after_send(flow):
        print(json.dumps({'flow_id':args.flow_id,'phase':'payment_awaited','paid':paid['paid'],
            'payment_status':paid['payment_status'],'transaction_status':paid['transaction_status'],
            'polls':paid['polls'],'timed_out':paid['timed_out']}),flush=True)
        if not paid['paid']:
            minutes_payment_fail(flow,paid)
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
            from commerce_talabat_duplicate import close_duplicate
            return close_duplicate(args.flow_id)
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
    if vertical=='food':
        from noon_vertical_reads import track
        return track(order, 'food')
    if vertical=='marketplace':
        from native_orders import noon_marketplace_track
        return noon_marketplace_track(order,15)
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
    if vertical=='food':
        from noon_food_financial import contract
        return {'ok':True,'vertical':'food','review_engine':'commerce_food.FoodFlow.review',
            'prepare_only':True,'purchase_enabled':True,'financial_send':False,
            'binding':['account','Banyantree Hillside Flat 2104','address version','outlet','item quantities','modifier quantities','item notes',order_card.LAST4],
            'quiet':['leavedoor','dontring','avoidcalling','driverNotes'],
            'journal':'consume before each mutation; no resend of consumed operations; retained exact session readback',
            'financial_contract':contract()}
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
    if journal.inspect(flow_id)['state']==journal.OWNER_ATTESTED_UNCHARGED:
        journal.fail('JOURNAL_FLOW_OWNER_ATTESTED_UNCHARGED')
    store=receipts.load(**binding)
    snapshot=store.snapshot()
    from commerce_order_status import talabat_place_failure
    failure=talabat_place_failure(binding,journal.inspect(flow_id),snapshot)
    if failure is not None:return failure
    cursor=snapshot.talabat_readback()

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
                tracking=talabat_orders.track_bound(order,saved,talabat.auth.new_deadline(20))
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
                if not registered or (not closed and (who=='moni' or cfg.get('delivery_card', {}).get('held'))):
                    # Re-adding an existing watcher only releases a placement
                    # text held while payment was unconfirmed; never twice.
                    env={k:v for k,v in os.environ.items() if k not in ('NODE_OPTIONS','BUN_OPTIONS','BUN_INSPECT')}
                    command=[str(Path.home()/'.local/bin/order-watch'),'add','--app','talabat','--order',order,
                             '--vertical', binding['vertical'],
                             '--payment-confirmed',
                             *order_watch_receipt.command_args(who,order_watch_receipt.reserved_minor(journal,flow_id)),
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
        return {'ok':completed,'purchase_confirmed':completed,
                'payment_reported_success':state=='PAYMENT_REPORTED_SUCCESS',
                'payment_capture_verified':None,
                'order':journal.inspect(flow_id)['order_id'],
                'state':state,'reason':reason,'flow_id':flow_id,
                'next_index':next_index,'financial_retry':False,
                'completed':completed,'completion_error':completion_error,
                **({} if completed else {'next_action':RECOVERY_NOT_REORDER.format(flow=flow_id)}),
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
    if binding['app']=='noon' and binding['vertical']=='food':
        from commerce_food import recover
        return recover(flow_id)
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
    parser.add_argument('--moni-chat',default=None,metavar='SLUG',
        help='bridge chat where she gave the go, e.g. group-sb_gro; default: her 1:1 plus every group chat')


def require_moni_go(args):
    """Moni's own go must be on record before anything is placed for her.

    Abdullah's standing approval pays for her orders; it never picks them.
    Prepare-only runs never place, so they don't need it.
    """
    placing=args.command=='test-talabat-shops' or args.command=='order'
    if not placing or getattr(args,'recipient','owner')!='moni' or getattr(args,'prepare_only',False):return None
    import moni_go
    chat=getattr(args,'moni_chat',None)
    return moni_go.verify(getattr(args,'moni_go',None) or '', **({'chat':chat} if chat else {}))


def card_preflight(args):
    """Refuse a paying run, before any network call, on a card seen declined.

    No override flag: clearing is `card-status ok <last4>` once Abdullah says so.
    Prepare-only never pays, and a supermall resume with an existing order only
    finishes tracking for a paid order, so neither is checked.
    """
    placing=args.command=='test-talabat-shops' or args.command=='order'
    if not placing or getattr(args,'prepare_only',False):return None
    if args.command=='order' and args.order_command=='supermall' and args.resume_flow:
        try:
            if journal.inspect(args.resume_flow)['order_id']:return None
        except Exception:
            pass
    status=card_status.check(ORDER_CARD_LAST4)
    return status if status['blocked'] else None


def note_card_decline(result, *, app, not_before=None, occurred_at=None):
    """Record a clear card decline so every other money path refuses the card.

    `occurred_at` is when an old decline really happened (recovery re-reads);
    None means it happened just now. Bookkeeping only: never raises, never
    changes the payment outcome.
    """
    if not isinstance(result,dict) or result.get('reason') not in CARD_DECLINE_REASONS:return None
    flow=result.get('flow_id')
    try:
        recorded=card_status.record_declined(ORDER_CARD_LAST4,reason=result['reason'],
            source=f"commerce {app} {result.get('order') or flow}",event=flow,
            not_before=not_before,occurred_at=occurred_at)['recorded']
        current=card_status.check(ORDER_CARD_LAST4)
        return {'card_last4':ORDER_CARD_LAST4,'recorded':recorded,'blocked':current['blocked'],
                'message':current['message']}
    except Exception as exc:
        return {'card_last4':ORDER_CARD_LAST4,'recorded':False,'error':type(exc).__name__,
                'message':(f'Recording the decline failed; run: card-status declined {ORDER_CARD_LAST4} '
                           f'--reason {result["reason"]} --source "commerce {app}"')}


def recipient_argument(parser):
    parser.add_argument('--for',dest='recipient',choices=order_watch_receipt.RECIPIENTS,default='owner',
        help='who ordered; moni = order-watch texts her the placement (once per order) and routes arrival texts to her. '
             'Label as "Store: items" for that text')
    parser.add_argument('--chat',default=None,metavar='SLUG',
        help='bridge chat the order was placed from, e.g. group-sb_gro; the delivery card and arrival texts go there. '
             'Default: the iMessage chat folder this runs in, else owner/Moni')


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
    parser.add_argument('--allow-duplicate-of',metavar='ORDER_ID',
        help='explicit new-flow duplicate-guard override; requires same-account order and different base items')


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    commands=parser.add_subparsers(dest='command',required=True)
    commands.add_parser('capabilities')
    commands.add_parser('restaurant-cart-contract')
    options=commands.add_parser('item-options',help='Read Minutes option groups; no cart changes')
    options.add_argument('vertical',choices=('minutes',))
    options.add_argument('--sku',required=True)
    options.add_argument('--query',help='Product-name search hint; result must match --sku exactly')
    cart=commands.add_parser('cart',help='Read or replace the whole Minutes cart; never orders')
    cart.add_argument('vertical',choices=('minutes',))
    cart.add_argument('action',choices=('show','set','reconcile'))
    cart.add_argument('--flow',dest='flow_id',default=None,metavar='FLOW_UUID',
        help='reconcile: the flow whose consumed cart send has no receipt; closes it only after an exact readback')
    cart.add_argument('--items-file',dest='items_file',default=None,metavar='PATH',
        help='set: the full basket (JSON array or {"items":[...]}), same format as order minutes')
    cart.add_argument('--expect-hash',dest='expect_hash',default=None,metavar='HASH',
        help='set: cart_hash from the last cart minutes show; refused if the cart changed since')
    clear=commands.add_parser('clear-cart',help='Clear an unchanged cart owned by a closed, cart-only noon flow')
    clear.add_argument('vertical',choices=('minutes','main','supermall'))
    clear.add_argument('--flow',dest='flow_id',required=True)
    for name in ('menu','choices'):
        discovery=commands.add_parser(name,help='Read Talabat menu items or item choices; never changes a cart')
        discovery.add_argument('app',choices=('talabat',))
        discovery.add_argument('--branch',type=int,required=True)
        if name=='choices':discovery.add_argument('--item',type=int,required=True)
    inspect=commands.add_parser('inspect');inspect.add_argument('flow_id')
    open_flows=commands.add_parser('open-flows',
        help='Read-only: unsettled payments sent recently. A bank/3DS prompt while one is listed is ours')
    open_flows.add_argument('--minutes',type=float,default=30.0)
    recover=commands.add_parser('recover-payment');recover.add_argument('flow_id')
    recover.add_argument('--max-reads',type=int,default=90)
    recipient_argument(recover)
    captured=commands.add_parser('close-food-captured', help='Close a delivered automatic Food capture from bank SMS evidence; never sends money')
    captured.add_argument('flow_id')
    captured.add_argument('--bank-msg-id', type=int, required=True)
    captured.add_argument('--attested-by', choices=('owner',))
    captured.add_argument('--confirm', action='store_true', help='Commit the evidenced close; omitted means validated dry run')
    track=commands.add_parser('track');track.add_argument('flow_id')
    exact=commands.add_parser('track-exact');exact.add_argument('app',choices=('noon','talabat'))
    exact.add_argument('vertical');exact.add_argument('order')
    detail=commands.add_parser('order-details',help='Read exact noon merchandise, choices, notes and totals')
    detail.add_argument('app',choices=('noon',));detail.add_argument('vertical');detail.add_argument('order')
    status=commands.add_parser('order-status');status.add_argument('flow_id')
    disposition=commands.add_parser('reconcile-order');disposition.add_argument('flow_id')
    disposition.add_argument('--close-duplicate',action='store_true',
        help='close a definitive duplicate refusal after fresh complete order-history checks; never resends')
    disposition.add_argument('--separate-order',metavar='ORDER_ID',
        help='exact independently placed matching order; needs --separate-order-after and --evidence')
    disposition.add_argument('--separate-order-after',metavar='ISO_TIME',
        help='caller-attested independent-placement lower time bound with timezone')
    disposition.add_argument('--legacy-rejection-evidence',metavar='TEXT',
        help='explicit evidence of definitive rejection for a legacy lossy SUBMISSION_UNKNOWN receipt')
    disposition.add_argument('--close-failed',action='store_true',
        help='Minutes: terminal close when noon reports the exact order failed/cancelled, inactive, '
             'zero total and its payment intent uncaptured; never retries')
    disposition.add_argument('--owner-attest-no-charge',action='store_true',
        help='terminal close of a Talabat flow, or a noon Minutes flow whose payment noon reports failed, '
             'on explicit owner evidence plus fresh exact provider checks; never retries')
    disposition.add_argument('--evidence',metavar='TEXT',
        help='owner no-charge statement and source/context, retained in the private journal')
    disposition.add_argument('--attested-by',choices=('owner',))
    cart=commands.add_parser('marketplace-cart');cart.add_argument('service',choices=('main','supermall'))
    preflight=commands.add_parser('checkout-check');preflight.add_argument('vertical',choices=('main','supermall','nownow','minutes'))
    contract=commands.add_parser('review-contract');contract.add_argument('vertical',choices=('main','supermall','nownow','food'))
    auth=commands.add_parser('auth');auth.add_argument('app',choices=('noon','talabat'))
    auth.add_argument('vertical');maintenance=auth.add_mutually_exclusive_group()
    maintenance.add_argument('--recover',action='store_true');maintenance.add_argument('--reconcile',action='store_true')
    maintenance.add_argument('--diagnose-readonly',action='store_true')
    buy=commands.add_parser('test-talabat-shops',help='Compatibility alias for order talabat')
    talabat_arguments(buy)
    order=commands.add_parser('order')
    order_commands=order.add_subparsers(dest='order_command',required=True)
    food_order=order_commands.add_parser('food', help='Journalled Food automatic saved-card order; explicit payment requirements need app')
    food_order.add_argument('--outlet-code',required=True)
    food_order.add_argument('--items-file',required=True)
    food_order.add_argument('--prepare-only',action='store_true')
    food_order.add_argument('--resume-flow')
    talabat_order=order_commands.add_parser('talabat',
        help='Caller-authorized Talabat basket with per-item notes and menu choices')
    talabat_arguments(talabat_order)
    minutes_order=order_commands.add_parser('minutes',
        help='Authorized Minutes paid order E2E: guard, sync, quiet, review, place, encrypted-CVV pay, 3DS wait, tracking')
    basket_arguments(minutes_order,'--sku')
    minutes_order.add_argument('--cvv-from-keychain',action='store_true',
        help='read the saved-card CVV from Keychain robob-card into RAM (required when the session demands CVV)')
    minutes_order.add_argument('--use-current-cart',dest='use_current_cart',action='store_true',
        help='order the cart already on the server when it matches the basket file exactly; nothing is synced')
    minutes_order.add_argument('--label',default='Noon Minutes order')
    minutes_order.add_argument('--resume-flow',default=None,metavar='FLOW_UUID',
        help='continue an ACTIVE preparation flow (exact cart readback; nothing re-sent)')
    minutes_order.add_argument('--driver-note-extra',default=None,metavar='TEXT',
        help='optional extra driver note (1-200 chars, no newlines) added after the quiet note')
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
    main_order.add_argument('--cvv-from-keychain',action='store_true',
        help='encrypt saved-card CVV in RAM for an exact pending payment')
    main_order.add_argument('--resume-flow',default=None,metavar='FLOW_UUID',
        help='continue an ACTIVE pre-place flow (24h window; exact basket readback)')
    supermall_order=order_commands.add_parser('supermall',
        help='Authorized noon SUPERMALL (rocket) paid order E2E: rocket resolve, quick-atc add, session verify, frictionless place, status poll')
    basket_arguments(supermall_order,'--sku-config')
    supermall_order.add_argument('--label',default='Noon Supermall order')
    supermall_order.add_argument('--cvv-from-keychain',action='store_true',
        help='encrypt saved-card CVV in RAM for an exact pending payment')
    supermall_order.add_argument('--resume-flow',default=None,metavar='FLOW_UUID',
        help='continue an ACTIVE flow (pre-place basket readback within 24h, or read-only paid completion)')
    supermall_order.add_argument('--eta',default=None,metavar='ISO_DATE',
        help='absolute promise deliveryDate (with offset) for the watcher; paid resume only')
    await_cmd=commands.add_parser('await-payment',help='Status-only payment/3DS continuation for Minutes, Main and Supermall')
    await_cmd.add_argument('flow_id')
    await_cmd.add_argument('--minutes',type=float,default=10.0)
    await_cmd.add_argument('--label',default='Noon order (payment resumed)')
    await_cmd.add_argument('--no-notify',action='store_true')
    recipient_argument(await_cmd)
    release=commands.add_parser('release-flow',
        help='Evidence-reviewed local release: failed Talabat quote with no financial send, or verified never-paid order')
    release.add_argument('flow_id')
    abandon=commands.add_parser('abandon-flow',
        help='Local close of eligible preparation with all sends observed, no financial ops and zero reserved')
    abandon.add_argument('flow_id')
    args=parser.parse_args(argv)
    # Talabat retired by the owner (2026-11-07): refuse before pause, auth or network.
    import talabat_retired
    if talabat_retired.requested(args):return talabat_retired.refuse()
    # Owner pause first: nothing below (chat lookup, auth, network) runs while it holds.
    if args.command in PAUSED_COMMANDS and PAUSE_FILE.exists():
        print(json.dumps({'ok':False,'error':'ORDERING_PAUSED',
                          'message':f"Ordering is paused: {PAUSE_FILE.read_text().strip()}",
                          'financial_send':False,'financial_retry':False}))
        return EXIT_PAUSED
    # Checked before any network call or money step. --chat wins; a Moni order's
    # --moni-chat (where she gave the go) is the order's chat too.
    chat=getattr(args,'chat',None) or (getattr(args,'moni_chat',None) if getattr(args,'recipient','owner')=='moni' else None)
    if chat:
        import delivery_cards
        if not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,99}',chat) or not delivery_cards.chat_store(chat).exists():
            print(json.dumps({'ok':False,'error':'ORDER_CHAT_UNKNOWN','chat':chat,
                              'financial_send':False,'financial_retry':False}))
            return 2
        os.environ['ORDER_WATCH_CHAT']=chat
    try:
        declined=card_preflight(args)
        if declined:
            print(json.dumps({'ok':False,'error':declined['error'],'card_last4':declined['card_last4'],
                              'message':declined['message'],'financial_send':False,'financial_retry':False}))
            return card_status.EXIT_BLOCKED
        moni_go=require_moni_go(args)
        if args.command=='capabilities':result=capabilities()
        elif args.command=='item-options':
            from noon_minutes_options import read_options
            result={'ok':True,'financial_send':False,'cart_mutation_sent':False,
                    **read_options(args.sku,query=args.query)}
        elif args.command=='cart':
            from commerce_minutes_cart import show as cart_show,set_cart as cart_set
            from commerce_basket_input import read_items
            if args.action=='show':
                result=cart_show(auth=CommerceAuth().noon)
            elif args.action=='reconcile':
                if args.flow_id is None or args.expect_hash is None or args.items_file is None:
                    journal.fail('MINUTES_CART_RECONCILE_REQUIRES_FLOW_ITEMS_AND_EXPECT_HASH')
                from commerce_minutes_cart import reconcile as cart_reconcile
                result=cart_reconcile(args.flow_id,rows=read_items(args.items_file),expect_hash=args.expect_hash,
                                      auth=CommerceAuth().noon)
            else:
                if args.items_file is None or args.expect_hash is None:
                    journal.fail('MINUTES_CART_SET_REQUIRES_ITEMS_FILE_AND_EXPECT_HASH')
                result=cart_set(read_items(args.items_file),expect_hash=args.expect_hash,auth=CommerceAuth().noon,
                                items_file=args.items_file)
        elif args.command=='clear-cart':
            if args.vertical=='minutes':
                from commerce_minutes_cleanup import clear_cart
                result=clear_cart(args.flow_id)
            else:
                from commerce_marketplace_cleanup import clear_cart
                result=clear_cart(args.flow_id, args.vertical)
        elif args.command in ('menu','choices'):result=talabat_discovery(args)
        elif args.command=='restaurant-cart-contract':
            from talabat_restaurant_cart import contract
            result={'ok':True,**contract()}
        elif args.command=='test-talabat-shops':result=purchase_talabat(args)
        elif args.command=='order' and args.order_command=='talabat':result=purchase_talabat(args)
        elif args.command=='order' and args.order_command=='minutes':result=order_minutes(args)
        elif args.command=='order' and args.order_command=='food':
            from commerce_food import prepare
            result=prepare(args)
        elif args.command=='order' and args.order_command=='nownow':result=order_nownow(args)
        elif args.command=='order' and args.order_command=='main':result=order_main(args)
        elif args.command=='order' and args.order_command=='supermall':result=order_supermall(args)
        elif args.command=='await-payment':result=await_payment_flow(args)
        elif args.command=='release-flow':result=release_flow(args)
        elif args.command=='abandon-flow':result=abandon_flow(args)
        elif args.command=='inspect':result=journal.inspect(args.flow_id)
        elif args.command=='open-flows':
            flows=journal.open_payments(since_seconds=max(0.0,args.minutes)*60)
            result={'ok':True,'open':flows,'financial_send':False,
                    'bank_prompt':'ours: approve it' if flows else 'no open payment from us in this window'}
        elif args.command=='recover-payment':
            result=recover_payment(args.flow_id,max_reads=args.max_reads,recipient=args.recipient)
            if isinstance(result,dict) and result.get('reason') in CARD_DECLINE_REASONS:
                # A late read of an old flow must not re-block a card cleared since it started,
                # and its 12h block runs from when the decline was observed, not from this read.
                try:started=journal.flow_created_at(args.flow_id)
                except Exception:started=None
                try:occurred=journal.decline_observed_at(args.flow_id)
                except Exception:occurred=None
                # No decline row (receipt parked before it was journaled): treat it as now.
                noted=note_card_decline(result,app='talabat',not_before=started,occurred_at=occurred)
                if noted:result={**result,'card_status':noted}
        elif args.command=='close-food-captured':
            from commerce_food_capture import close
            result=close(args, track_exact)
        elif args.command=='order-status':
            from commerce_order_status import status
            result=status(args.flow_id)
        elif args.command=='reconcile-order':
            from commerce_reconcile import reconcile, owner_attest_no_charge
            if args.close_failed:
                if (args.close_duplicate or args.owner_attest_no_charge or args.attested_by is not None
                        or args.evidence is not None or args.separate_order is not None
                        or args.separate_order_after is not None or args.legacy_rejection_evidence is not None):
                    journal.fail('FAILED_CLOSURE_FLAGS_CONFLICT')
                from commerce_minutes_disposition import close_failed
                result=close_failed(args.flow_id)
            elif args.close_duplicate:
                if args.owner_attest_no_charge or args.attested_by is not None:
                    journal.fail('DUPLICATE_CLOSURE_FLAGS_CONFLICT')
                from commerce_talabat_duplicate import close_duplicate
                result=close_duplicate(args.flow_id,separate_order=args.separate_order,
                    separate_after=args.separate_order_after,separate_evidence=args.evidence,
                    legacy_rejection_evidence=args.legacy_rejection_evidence)
            elif args.separate_order is not None or args.separate_order_after is not None or args.legacy_rejection_evidence is not None:
                journal.fail('DUPLICATE_CLOSURE_FLAG_REQUIRED')
            elif args.owner_attest_no_charge:
                owner_binding=journal.binding(args.flow_id)
                if owner_binding['app']=='noon' and owner_binding['vertical']=='minutes':
                    from commerce_minutes_disposition import owner_attest_failed
                    result=owner_attest_failed(args.flow_id,evidence=args.evidence,attested_by=args.attested_by)
                else:
                    result=owner_attest_no_charge(args.flow_id,evidence=args.evidence,attested_by=args.attested_by)
            elif args.evidence is not None or args.attested_by is not None:
                journal.fail('OWNER_ATTESTATION_FLAG_REQUIRED')
            else:
                result=reconcile(args.flow_id)
        elif args.command=='marketplace-cart':
            from commerce_marketplace import MarketplaceFlow
            result=MarketplaceFlow(args.service).cart()
        elif args.command=='checkout-check':result=checkout_check(args.vertical)
        elif args.command=='review-contract':result=review_contract(args.vertical)
        elif args.command=='track-exact':result=track_exact(args.app,args.vertical,args.order)
        elif args.command=='order-details':
            from noon_order_details import details
            result=details(args.order,args.vertical)
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
        from noon_minutes_options import OptionsError
        from commerce_supermall_order import CatalogError
        if isinstance(exc,(OptionsError,CatalogError)):
            print(json.dumps({'ok':False,'error':exc.code,'details':exc.details,
                              'financial_send':False,'financial_retry':False}))
            return 1
        from commerce_minutes_cart import OutcomeUnverified
        if isinstance(exc,OutcomeUnverified):
            print(json.dumps({'ok':False,'error':exc.code,**exc.details,'financial_retry':False}))
            return 1
        code=str(exc)
        preparation=re.fullmatch(r'PREPARATION_FAILED:(quote_(?:initial|initial_quiet|selected|selected_quiet|final_quiet)):([A-Z][A-Z0-9_]{1,99})',code)
        if isinstance(exc,talabat.orders.TalabatError) and preparation:
            print(json.dumps({'ok':False,'error':'PREPARATION_FAILED','phase':preparation[1],
                              'cause':preparation[2],'financial_send':False,'financial_retry':False}))
            return 1
        if not re.fullmatch(r'[A-Z][A-Z0-9_]{0,100}',code):code='COMMERCE_OPERATION_FAILED'
        # A sent payment that didn't confirm: say whether a no-charge is proven, never assume it.
        details=exc.details if isinstance(exc,journal.PaymentError) else {}
        print(json.dumps({'ok':False,'error':code,**details,'financial_retry':False}))
        return 1


if __name__=='__main__':sys.exit(main())
