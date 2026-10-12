"""Parent-only bounded quote observations. No order, cart write or preference API.

These select supported native initial/card branches explicitly, not app-identical
replay. Three dated one-shot probes are permanently consumed after live checks.
The API cart must contain only the authorized Quest shake. Historical cart
ownership and cleanup authority are not recovered. No public ordering CLI.
"""
import json
from decimal import Decimal, InvalidOperation
import os
from pathlib import Path
import re
import time
import urllib.parse
import urllib.request
import uuid

import talabat_checkout as c

INITIAL_INTENT = Path('/Users/ardud/.robob/scratch/2026-10-08-continue-already-owner-authorized-autonomous-2092997c/tmp/talabat-initial-quote-20261009.intent')
CARD_INTENT = INITIAL_INTENT.with_name('talabat-card-quote-20261009.intent')
REVIEW_INTENT = INITIAL_INTENT.with_name('talabat-payable-review-20261009.intent')
CARD_FEATURES = frozenset(('riderTip', 'subscription', 'binVoucherEligible',
                           'isCashFeesEligible', 'mixPayment', 'postpaidFirstOrderIncentive'))
ADDRESS_KEYS = ('id', 'area_id', 'area_name', 'block', 'building_no', 'country_code',
                'country', 'extra_directions', 'floor', 'judda', 'latitude',
                'longitude', 'mobile_number', 'phone_number', 'street', 'type')
PRESET_LABELS = frozenset(('Call on arrival', "Don't ring doorbell", 'Leave at reception',
                           'Ring doorbell', 'Message on arrival', 'Leave at my door'))


def _same_json(left, right):
    """Type-exact equality: bool/int/float substitutions are different wire data."""
    if type(left) is not type(right):
        return False
    if type(left) is dict:
        return left.keys() == right.keys() and all(_same_json(left[k], right[k]) for k in left)
    if type(left) is list:
        return len(left) == len(right) and all(_same_json(a, b) for a, b in zip(left, right))
    return left == right


def initial_body(home, vendor, features):
    """Private native-format body. Caller already verified profile/Home/vendor.

    hasDues=null means the explicitly unpopulated optional adapter path, NOT a
    finding of no debt. No selected payment/tip/wallet or saved preference is
    supplied, and this function cannot produce placeOrder input.
    """
    if (type(home) is not dict or any(k not in home for k in ADDRESS_KEYS)
            or type(home.get('country')) is not int or home['country'] != 4 or home.get('country_code') != '971'
            or not c._identifier(home.get('id')) or home.get('suite') != '2104'
            or type(home.get('area_id')) is not int or home['area_id'] != 1308
            or type(home.get('type')) is not int
            or any(type(home[k]) is not str for k in ADDRESS_KEYS
                   if k not in ('country','area_id','latitude','longitude','type'))
            or not c._number(home.get('latitude'), 25.06, 25.10)
            or not c._number(home.get('longitude'), 55.14, 55.18)):
        c._fail('INITIAL_QUOTE_ADDRESS_INVALID')
    c.select_vendor({'vendor': vendor})
    if (type(vendor.get('vertical_type')) is not int or vendor['vertical_type'] != 1
            or type(vendor.get('is_migrated')) is not bool):
        c._fail('INITIAL_QUOTE_VENDOR_INVALID')
    # This exact map was independently observed. Unknown keys must not overwrite
    # address/payment/safety fields through the native addAll operation.
    if (type(features) is not dict or set(features) != {'paySupportsTPro'}
            or type(features['paySupportsTPro']) is not bool):
        c._fail('INITIAL_QUOTE_FEATURE_MAP_CHANGED')
    address = {k: home[k] for k in ADDRESS_KEYS}
    address['country'] = home['country_code']  # observed native serializer quirk
    return {'countryCode': 'AE', 'deviceLatitude': float(home['latitude']),
            'deviceLongitude': float(home['longitude']), 'paymentMethod': None,
            'addTPayMethod': None, 'riderTipAmount': None, 'isCustomRiderTip': None,
            'saveRiderTipForLater': None, 'proSubscribeChecked': False,
            'walletBalance': None, 'isMigrated': vendor['is_migrated'] or vendor['is_dark_store'],
            'branchId': c.BRANCH, 'verticalId': vendor['vertical_type'],
            'binNumber': None, 'hasDues': None, **features,
            'selectedAddressId': home['id'], 'addressV2': address,
            'quickCheckout': False}


def require_current_cart(before, after):
    projected = c.project_probe_cart(after, before.get('id'))
    if (not projected['sole_quest_quantity_one'] or not projected['same_cart_id_as_preflight']
            or projected['branch_matches'] is False
            or c.project_probe_cart(before, before.get('id'))['branch_matches'] is False
            or before.get('items') != after.get('items')
            or before.get('subtotal_after_discount') != after.get('subtotal_after_discount')
            or not c._number(after.get('subtotal_after_discount'), 0.01, 50)):
        c._fail('INITIAL_QUOTE_CART_CHANGED_OR_NOT_SOLE_QUEST')
    return projected


def selected_card_body(home, vendor, config, saved_card):
    """Native selected-config mapping, without selecting wallet or charging.

    Config.field17 overlays the chosen row's supportedFeatures; bin/fingerprint
    come from events.payment.card. A populated events.selected is deliberately
    refused here until its wallet semantics are understood, never guessed null.
    Card identity is checked in memory; the prepare request has no cardTokenId.
    """
    if type(config) is not dict or type(config.get('paymentMethods')) is not list:
        c._fail('CARD_QUOTE_PAYMENT_SCHEMA_CHANGED')
    c.select_card({'data': [saved_card]})
    matches = []
    for row in config['paymentMethods']:
        if type(row) is not dict:
            c._fail('CARD_QUOTE_PAYMENT_SCHEMA_CHANGED')
        events = row.get('events')
        payment = events.get('payment') if type(events) is dict else None
        card = payment.get('card') if type(payment) is dict else None
        if type(card) is dict and card.get('cardId') == saved_card['tokenId']:
            matches.append(row)
    if len(matches) != 1:
        c._fail('CARD_QUOTE_EXACT_SAVED_CARD_NOT_UNIQUE')
    row = matches[0]
    events = row['events']; payment = events['payment']; card = payment['card']
    method = payment.get('method'); features = row.get('supportedFeatures')
    if (row.get('isEnabled') is not True or type(row.get('isSelected')) is not bool
            or type(row.get('title')) is not str
            or not re.search(r'(?<![0-9])5542(?![0-9])', row['title'])
            or events.get('selected') is not None
            or type(method) is not dict or type(method.get('paymentMethod')) is not int
            or method['paymentMethod'] != 2 or type(method.get('addTPayMethod')) is not int
            or method['addTPayMethod'] != 7
            or type(features) is not dict or set(features) != CARD_FEATURES
            or any(type(v) is not bool for v in features.values())
            or type(card.get('binNumber')) is not str
            or not re.fullmatch(r'[0-9]{6,8}', card['binNumber'])
            or not c._identifier(card.get('cardFingerPrint'))):
        c._fail('CARD_QUOTE_CONTEXT_UNSUPPORTED')
    body = initial_body(home, vendor, config.get('supportedFeatures'))
    body.update(paymentMethod=method['paymentMethod'], addTPayMethod=method['addTPayMethod'],
                binNumber=card['binNumber'], cardFingerPrint=card['cardFingerPrint'], **features)
    return body


def payment_config(saved, amount, flow_id, deadline):
    """Explicit exploratory amount; not an assertion of app route total/payable."""
    if not c._number(amount, 0.01, 50) or not re.fullmatch(r'[0-9a-f-]{36}', flow_id):
        c._fail('INITIAL_QUOTE_PAYMENT_CONTEXT_INVALID')
    headers = c.auth.native_headers(saved)
    for key in ('x-api-key','x-customer-id','x-platform','x-user-flow'):
        headers.pop(key, None)
    headers.update({'authorization':'Bearer '+saved['auth']['access_token'],
                    'x-acceptance-request-id':flow_id})
    query = urllib.parse.urlencode({'scenario':'deliveryOrder', 'amount':str(amount),
                                   'countryId':4, 'branchId':c.BRANCH})
    req = urllib.request.Request(c.API+'/pay/v2/payments?'+query, headers=headers, method='GET')
    return _json_request(req, deadline)


def _json_request(req, deadline):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), c.http.NoRedirect())
    try:
        with c.http.read_deadline(deadline) as remaining:
            with opener.open(req, timeout=remaining) as response:
                if response.code != 200:
                    c._fail('QUOTE_HTTP_STATUS_UNEXPECTED')
                raw = response.read(c.MAX_BYTES+1)
            if len(raw) > c.MAX_BYTES:
                c._fail('QUOTE_RESPONSE_TOO_LARGE')
            value = json.loads(raw)
            if type(value) is not dict:
                c._fail('QUOTE_RESPONSE_NOT_OBJECT')
        return value
    except Exception:
        c._fail('QUOTE_REQUEST_FAILED_NO_RETRY')


def post_initial(saved, cart_id, body, flow_id, deadline):
    """One fixed v1 prepare POST, consumed before transmission. Never a purchase.

    No timeout/error/HTTP status permits reuse. No caller-selected journal path.
    The receipt is not an idempotency promise or an assertion of server success.
    """
    if not c._identifier(cart_id) or not re.fullmatch(r'[0-9a-f-]{36}', flow_id):
        c._fail('INITIAL_QUOTE_BINDING_INVALID')
    # Require the exact initial shape, then reconstruct through the pure builder.
    expected = {'countryCode','deviceLatitude','deviceLongitude','paymentMethod','addTPayMethod',
                'riderTipAmount','isCustomRiderTip','saveRiderTipForLater','proSubscribeChecked',
                'walletBalance','isMigrated','branchId','verticalId','binNumber','hasDues',
                'paySupportsTPro','selectedAddressId','addressV2','quickCheckout'}
    if (type(body) is not dict or set(body) != expected or body['branchId'] != c.BRANCH
            or body['countryCode'] != 'AE' or body['verticalId'] != 1 or body['isMigrated'] is not True
            or body['proSubscribeChecked'] is not False or body['quickCheckout'] is not False
            or any(body[k] is not None for k in ('paymentMethod','addTPayMethod','riderTipAmount',
                   'isCustomRiderTip','saveRiderTipForLater','walletBalance','binNumber','hasDues'))):
        c._fail('INITIAL_QUOTE_BODY_DENIED')
    address = body.get('addressV2')
    if type(address) is not dict or set(address) != set(ADDRESS_KEYS) or address.get('country') != '971':
        c._fail('INITIAL_QUOTE_BODY_DENIED')
    home = {**address, 'country':4, 'suite':'2104'}
    vendor = {'talabat_id':c.BRANCH,'global_id':'validated-synthetic-vendor',
              'chain_id':1,'vertical_type':1,'is_dark_store':True,'is_migrated':False}
    rebuilt = initial_body(home,vendor,{'paySupportsTPro':body['paySupportsTPro']})
    if not _same_json(body, rebuilt):
        c._fail('INITIAL_QUOTE_BODY_DENIED')
    return _post_quote_once(saved, cart_id, body, flow_id, deadline, INITIAL_INTENT,
                            'initial_quote', False)


def post_selected_card(saved, cart_id, body, flow_id, deadline, *, home, vendor, config, saved_card):
    """Distinct single-shot selected-card quote, never a replay of initial."""
    if (not c._identifier(cart_id) or not re.fullmatch(r'[0-9a-f-]{36}', flow_id)
            or not _same_json(body, selected_card_body(home, vendor, config, saved_card))):
        c._fail('CARD_QUOTE_BODY_DENIED')
    return _post_quote_once(saved, cart_id, body, flow_id, deadline, CARD_INTENT,
                            'selected_card_quote', True)


def _post_quote_once(saved, cart_id, body, flow_id, deadline, marker, operation, selected):
    # Internal caller chooses one of three fixed operations, never a caller path.
    if (marker, operation, selected) not in ((INITIAL_INTENT, 'initial_quote', False),
                                             (CARD_INTENT, 'selected_card_quote', True),
                                             (REVIEW_INTENT, 'payable_context_review', True)):
        c._fail('QUOTE_OPERATION_DENIED')
    # Serialize and form request before consuming. Even failure after consumption
    # leaves the marker in place; a quote retry requires explicit reconciliation.
    encoded = json.dumps(body, allow_nan=False, separators=(',', ':')).encode()
    headers = c.auth.native_headers(saved)
    for key in ('x-api-key','x-customer-id','x-platform','x-user-flow'):
        headers.pop(key, None)
    headers.update({'authorization':'Bearer '+saved['auth']['access_token'],
                    'content-type':'application/json', 'x-request-id':flow_id})
    req = urllib.request.Request(c.API+'/ccx/v1/checkout/'+urllib.parse.quote(cart_id, safe=''),
                                 headers=headers, data=encoded, method='POST')
    c.http.remaining_time(deadline)
    if not marker.parent.is_dir() or marker.parent.is_symlink():
        c._fail('INITIAL_QUOTE_INTENT_DIRECTORY_INVALID')
    try:
        fd = os.open(marker, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        c._fail('INITIAL_QUOTE_INTENT_ALREADY_CONSUMED')
    with os.fdopen(fd, 'w') as journal:
        journal.write(json.dumps({'version':1,'operation':operation,
                                 'state':'MAY_HAVE_SENT','created_at':int(time.time()),
                                 'exact_app_replay':False,'payment_selected':selected})+'\n')
        journal.flush()
        os.fsync(journal.fileno())
        dirfd = os.open(marker.parent, os.O_RDONLY)
        try:
            os.fsync(dirfd)
        finally:
            os.close(dirfd)
        c.http.remaining_time(deadline)
        return _json_request(req, deadline)


def observe_initial(apk_pool, *, send=False, timeout=45):
    """Return private in-memory evidence. Only an allowlisted projection may log.

    send=False is read-only; send=True is parent authorization for this single
    quote observation, NOT payment or cart cleanup. Do not expose as a CLI.
    """
    if type(send) is not bool:
        c._fail('QUOTE_EXPLICIT_SEND_REQUIRED')
    if send and (INITIAL_INTENT.exists() or INITIAL_INTENT.is_symlink()):
        c._fail('INITIAL_QUOTE_INTENT_ALREADY_CONSUMED')
    deadline = c.auth.new_deadline(timeout)
    saved = c.http.account()
    c.http.verify_profile(c.http.request(c.http.PROFILE, saved, deadline), saved)
    card = c.select_card(c.get_json(saved,c.API,c.CARDS,{'countryId':4},deadline))
    home = c.select_home(c.get_json(saved,c.ADDRESS_API,c.ADDRESSES,{'countryId':4},deadline),saved)
    loc = {'lat':home['latitude'],'lon':home['longitude']}
    vendor = c.select_vendor(c.get_json(saved,c.API,c.VENDOR,{'areaId':home['area_id'],**loc},deadline))
    key = c.verticals_key(apk_pool)
    query = {'branch_id':c.BRANCH,'dh_vendor_id':vendor['global_id'],'global_entity_id':'TB_AE',
             'chain_id':vendor['chain_id'],**loc,'campaign_progress_required':'true',
             'has_outstanding_payments':'false'}
    before = c.get_json(saved,c.API,c.CART,query,deadline,key,probe_context=True)
    require_current_cart(before,before)
    flow_id = str(uuid.uuid4())
    config = payment_config(saved,before['subtotal_after_discount'],flow_id,deadline)
    body = initial_body(home,vendor,config.get('supportedFeatures'))
    after = c.get_json(saved,c.API,c.CART,query,deadline,key,probe_context=True)
    cart = require_current_cart(before,after)
    response = post_initial(saved,after['id'],body,flow_id,deadline) if send else None
    return {'sent':send,'cart':cart,'body':body,'response':response,
            'payment_config':config,'saved_card':card,'home':home,
            'cart_id':after['id'], 'saved':saved, 'vendor':vendor,
            'flow_id':flow_id, 'deadline':deadline}


def observe_selected_card(apk_pool, *, send=False, timeout=45):
    """Private in-memory quote evidence. No preference/default/card API write."""
    if type(send) is not bool:
        c._fail('QUOTE_EXPLICIT_SEND_REQUIRED')
    if send and (CARD_INTENT.exists() or CARD_INTENT.is_symlink()):
        c._fail('CARD_QUOTE_INTENT_ALREADY_CONSUMED')
    evidence = observe_initial(apk_pool, send=False, timeout=timeout)
    body = selected_card_body(evidence['home'], evidence['vendor'],
                              evidence['payment_config'], evidence['saved_card'])
    response = post_selected_card(evidence['saved'], evidence['cart_id'], body,
                evidence['flow_id'], evidence['deadline'], home=evidence['home'],
                vendor=evidence['vendor'], config=evidence['payment_config'],
                saved_card=evidence['saved_card']) if send else None
    evidence.update(sent=send, body=body, response=response)
    return evidence


def observe_payable_review(apk_pool, *, send=False, timeout=45):
    """One bounded final review using the observed 30.14 payment-config amount.

    This is a new, explicit context after a received card-quote response, not a
    retry of either consumed operation. It still cannot place an order. The
    payable is experimental context until revalidated in this response.
    """
    if type(send) is not bool:
        c._fail('QUOTE_EXPLICIT_SEND_REQUIRED')
    if send and (REVIEW_INTENT.exists() or REVIEW_INTENT.is_symlink()):
        c._fail('PAYABLE_REVIEW_INTENT_ALREADY_CONSUMED')
    # Initial read scaffolding does no POST and no preference selection.
    evidence = observe_initial(apk_pool, send=False, timeout=timeout)
    config = payment_config(evidence['saved'], 30.14, evidence['flow_id'], evidence['deadline'])
    body = selected_card_body(evidence['home'], evidence['vendor'], config, evidence['saved_card'])
    home, vendor = evidence['home'], evidence['vendor']
    query = {'branch_id':c.BRANCH,'dh_vendor_id':vendor['global_id'],'global_entity_id':'TB_AE',
             'chain_id':vendor['chain_id'],'lat':home['latitude'],'lon':home['longitude'],
             'campaign_progress_required':'true','has_outstanding_payments':'false'}
    cart = c.get_json(evidence['saved'],c.API,c.CART,query,evidence['deadline'],
                      c.verticals_key(apk_pool),probe_context=True)
    projected = c.project_probe_cart(cart,evidence['cart_id'])
    if (not projected['same_cart_id_as_preflight'] or not projected['sole_quest_quantity_one']
            or projected['branch_matches'] is False
            or projected['subtotal_after_discount'] != 20.25):
        c._fail('PAYABLE_REVIEW_CART_CHANGED')
    response = _post_quote_once(evidence['saved'], evidence['cart_id'], body,
                evidence['flow_id'], evidence['deadline'], REVIEW_INTENT,
                'payable_context_review', True) if send else None
    evidence.update(sent=send, body=body, response=response,payment_config=config)
    return evidence


def _money(value):
    if type(value) not in (str, int, float) or not re.fullmatch(r'[0-9]{1,4}(?:\.[0-9]{1,2})?', str(value)):
        return None
    try:
        result = Decimal(str(value))
        return str(result.quantize(Decimal('0.01'))) if result.is_finite() else None
    except InvalidOperation:
        return None


def _display_money(value):
    if type(value) is not str or len(value) > 80:
        return _money(value)
    # Whole supported format, not a number scraped from arbitrary text. Unknown
    # currency/localized displays stay unknown; never drop signs or parentheses.
    match = re.fullmatch(r'(?:AED )?([0-9]{1,4}(?:\.[0-9]{1,2})?)(?: AED)?', value)
    if match is None or (value.startswith('AED ') and value.endswith(' AED')):
        return None
    return _money(match[1])


def _label(value):
    return value if type(value) is str and value in PRESET_LABELS else 'unrecognized'


def _tip_states(value, path='riderTips', depth=0):
    """Numeric/state-only tip projection; no free text, identifiers or metadata."""
    if depth > 6:
        return []
    out=[]
    if type(value) is dict:
        for key, item in value.items():
            if key in ('isSelected','isEnabled','isCustom','saveForLater','isPreSaved') and type(item) is bool:
                out.append({'path':path+'.'+key,'value':item})
            elif key in ('amount','value','selectedAmount','tipAmount','riderTipAmount') and _money(item) is not None:
                out.append({'path':path+'.'+key,'amount':_money(item)})
            elif key in ('options','saveTip','saveForLater','custom') and type(item) in (dict,list):
                out.extend(_tip_states(item,path+'.'+key,depth+1))
    elif type(value) is list:
        for index, item in enumerate(value[:20]):
            out.extend(_tip_states(item,path+f'[{index}]',depth+1))
    return out


def project_quote(evidence):
    """Only safe amounts, fixed labels and equality checks; no IDs or raw text."""
    response = evidence.get('response')
    checkout = response.get('checkout') if type(response) is dict else None
    if type(checkout) is not dict:
        c._fail('QUOTE_CHECKOUT_RESPONSE_MISSING')
    tracking = response.get('tracking', {})
    branch = response.get('branchInfo', {})
    home = evidence['home']
    address = checkout.get('address', {})
    country = branch.get('country', {}) if type(branch) is dict else {}
    cart = checkout.get('cart', {})
    items = cart.get('items') if type(cart) is dict else None
    row = items[0] if type(items) is list and len(items) == 1 and type(items[0]) is dict else {}
    summary = checkout.get('paymentSummary', {})
    charges = []
    known_charges = {'SubTotal','DeliveryFee','ServiceFee','Total','Discount','Tip','Tax'}
    for charge in summary.get('items', []) if type(summary) is dict else []:
        if type(charge) is dict:
            charges.append({'type':charge.get('type') if charge.get('type') in known_charges else 'unrecognized',
                            'amount':_money(charge.get('amount'))})
    # Provider preset UI labels only, never a saved address or free-text field.
    # Labels do not themselves set controls; IDs remain private in memory.
    controls = []
    container = checkout.get('deliveryInstructions')
    for control in c.instruction_choices(container):
        controls.append({'title':_label(control.title),
                         'selected':control.selected,'enabled':control.enabled})
    save = container.get('saveForLater', {})
    matched_amounts = {r['type']:r['amount'] for r in charges}
    known_sum = (len(charges) == 4 and len(matched_amounts) == 4 and
                 set(matched_amounts) == {'SubTotal','DeliveryFee','ServiceFee','Total'} and
                 all(v is not None for v in matched_amounts.values()) and
                 sum(Decimal(matched_amounts[k]) for k in ('SubTotal','DeliveryFee','ServiceFee')) == Decimal(matched_amounts['Total']))
    projected = {'quote_response_received':True,
            'current_cart_id_echo_matches':type(tracking) is dict and tracking.get('cartId') == evidence['cart_id'],
            'branch_matches':checkout.get('branchId') == c.BRANCH,
            'country_matches':type(country) is dict and country.get('id') == 4,
            'currency_aed':type(country) is dict and country.get('currencyCode') == 'AED',
            'home_coordinates_match':type(address) is dict and address.get('latitude') == home['latitude'] and address.get('longitude') == home['longitude'],
            'home_area_matches':type(address) is dict and address.get('areaId') == home['area_id'],
            'home_unit_in_description':type(address) is dict and type(address.get('description')) is str and bool(re.search(r'(?<!\w)2104(?!\w)', address['description'])),
            'one_quest_item_guid_matches':row.get('itemGuid') == c.QUEST,
            'one_quantity':type(row.get('quantity')) is int and row['quantity'] == 1,
            'item_price':_display_money(row.get('price')), 'item_total':_display_money(row.get('total')),
            'amount':_money(checkout.get('amount')),'charges':charges,
            'charges_sum_matches':bool(known_sum),
            'amount_matches_summary':_money(checkout.get('amount')) is not None and _money(checkout.get('amount')) == matched_amounts.get('Total'),
            'controls':controls,'saved_instruction_default':save.get('isPreSaved') if type(save) is dict and type(save.get('isPreSaved')) is bool else None,
            'rider_tips_present':checkout.get('riderTips') is not None,
            'rider_tip_states':_tip_states(checkout.get('riderTips')),
            'subscription_present':checkout.get('subscription') is not None,
            'card_prepare_requested':_same_json([evidence['body'].get('paymentMethod'),evidence['body'].get('addTPayMethod')], [2,7]),
            'exact_card_payment_authorized':False,'rider_note_verified':False,
            'ready_to_order':False,'commit_enabled':False}
    states = {control['title']:control for control in controls}
    quiet = (len(states) == len(controls) and
             states.get('Leave at my door') == {'title':'Leave at my door','selected':True,'enabled':True} and
             states.get("Don't ring doorbell") == {'title':"Don't ring doorbell",'selected':True,'enabled':True} and
             states.get('Call on arrival') == {'title':'Call on arrival','selected':False,'enabled':True} and
             {x['title'] for x in controls if x['selected']} == {'Leave at my door',"Don't ring doorbell"})
    tip = checkout.get('riderTips')
    options = tip.get('options') if type(tip) is dict else None
    no_tip_selected = (type(options) is list and 1 <= len(options) <= 20 and
                       all(type(o) is dict and o.get('isSelected') is False for o in options))
    projected['quiet_controls_verified'] = bool(quiet)
    projected['no_tip_option_selected'] = bool(no_tip_selected)
    projected['quote_ready_for_review'] = (all(projected[k] for k in (
        'current_cart_id_echo_matches','branch_matches','country_matches','currency_aed',
        'home_coordinates_match','home_area_matches','home_unit_in_description',
        'one_quest_item_guid_matches','one_quantity','charges_sum_matches',
        'amount_matches_summary','card_prepare_requested','quiet_controls_verified',
        'no_tip_option_selected')) and not projected['subscription_present'] and
        projected['item_total'] == projected['item_price'] == matched_amounts.get('SubTotal'))
    return projected
