"""Exact NowNow native order plus unique bank purchase; recovery never sends money."""
import json
import os
import time

import commerce_journal as j
import noon_nownow_checkout as native
from noon_checkout import fingerprint


def require(ok, code):
    if not ok:
        j.fail('NOWNOW_' + code)


def retain(flow):
    root = j.ROOT / 'nownow'
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    state = {'binding': j.binding(flow.flow_id), 'review': flow.review,
             'items': flow.items, 'card_last4': flow.review['projection']['card_last4'],
             'card_hash': fingerprint(flow.card.token), 'address_hash': flow.address_hash}
    path = root / (flow.flow_id + '.json')
    if path.exists():
        old = json.loads(path.read_text())
        require(old['review']['digest'] == flow.review['digest'], 'RETAINED_REVIEW_CHANGED')
        return
    with path.open('x') as handle:
        os.chmod(path, 0o600)
        json.dump(state, handle)
        handle.flush()
        os.fsync(handle.fileno())


def load(flow_id):
    binding = j.binding(flow_id)
    state = json.loads((j.ROOT / 'nownow' / (flow_id + '.json')).read_text())
    require(binding == state['binding'] and binding['vertical'] == 'nownow'
            and j.digest(state['review']['projection']) == state['review']['digest'], 'RETAINED_REVIEW_INVALID')
    return state


def native_evidence(row, order, state):
    from commerce_nownow_order import _wire_manifest
    p = state['review']['projection']
    amount = state['review']['payable_minor']
    require(row.get('orderNr') == order and fingerprint(row.get('customerCode')) == state['binding']['account_hash'], 'ORDER_ACCOUNT_MISMATCH')
    require(row.get('addressCode') == p['address_code'] and row.get('addressVersion') == p['address_version']
            and (row.get('storeInfo') or {}).get('storeCode') == p['store'], 'ORDER_HOME_STORE_MISMATCH')
    require(_wire_manifest(row.get('products')) == sorted((r['product_code'], r['quantity']) for r in state['items']), 'ORDER_MANIFEST_MISMATCH')
    require(row.get('currencyCode') == 'AED'
            and all(native.seam.amount_minor(row.get(k)) == amount for k in ('orderTotal', 'orderPaymentAmount'))
            and native.seam.amount_minor(row.get('orderWalletAmount')) == 0, 'ORDER_AMOUNT_MISMATCH')
    misc = row.get('prepaidPaymentMisc') or {}
    require(str(row.get('creditCardMask') or '').endswith(state['card_last4'])
            and row.get('paymentMethodCode') == 'prepaid' and misc.get('prepaidPaymentMethodCode') == 'cc_noonpay'
            and misc.get('isCvvRequired') is False and 'paymentClientSecret' in row
            and row['paymentClientSecret'] is None and row.get('failedErrorMsg') is None, 'ORDER_PAYMENT_UNCONFIRMED')
    require(row.get('orderStatusCode') in ('pending_acceptance', 'pending_approval', 'accepted', 'preparing', 'delivering', 'delivered')
            and all(native.seam.amount_minor(row.get(k)) == 0 for k in ('orderRefunds', 'orderIssuedCredit')), 'ORDER_NOT_ACCEPTED_OR_ADJUSTED')
    prefs = {r.get('code'): r.get('choice') for r in row.get('deliveryPreferenceInfo', []) if isinstance(r, dict)}
    require(all(prefs.get(k) is True for k in ('dont_ring_the_bell', 'leave_it_at_my_door'))
            and row.get('driverNotes') == native.QUIET_NOTE, 'ORDER_QUIET_MISMATCH')
    return {'order': order, 'amount_minor': amount, 'card_last4': state['card_last4'],
            'status': row['orderStatusCode'], 'source': 'exact_native_order'}


def confirm(flow_id, *, client=None):
    from commerce_food_capture import find_bank_capture
    from commerce_nownow import reader
    state = load(flow_id)
    local = j.inspect(flow_id)
    require(local['order_id'] and local['reserved_minor'] == state['review']['payable_minor'], 'EXACT_ORDER_REQUIRED')
    client = client or reader(expected_account=state['binding']['account_hash'])
    data = client.order_status(local['order_id'], timeout=25).wire['data']
    evidence = native_evidence(data.get('order', data), local['order_id'], state)
    bank = find_bank_capture(j.food_capture_placed_at(flow_id), evidence['amount_minor'], state['card_last4'])
    j.claim_food_bank_purchase(flow_id, bank)
    digest = j.digest({'native': evidence, 'bank': bank})
    j.observe(flow_id, 'place', outcome='PAYMENT_REPORTED_SUCCESS', evidence_hash=digest, order_id=local['order_id'])
    j.observe(flow_id, 'place', outcome='EXACT_ORDER_CONFIRMED', evidence_hash=digest, order_id=local['order_id'])
    if local['state'] == 'FENCED':
        j.reconcile_nownow_paid(flow_id, evidence_hash=digest)
    return {'paid': True, 'signal': 'exact_native_order_and_unique_bank_purchase', 'bank_message_id': bank['source_id']}


def recover(flow_id, *, recipient='owner'):
    from commerce_nownow import reader
    from commerce_nownow_order import NowNowOrderFlow
    local = j.inspect(flow_id)
    if local['state'] == 'COMPLETE':
        return {'ok': True, 'flow_id': flow_id, 'order': local['order_id'], 'state': 'COMPLETE', 'financial_retry': False}
    state = load(flow_id)
    client = reader(expected_account=state['binding']['account_hash'])
    flow = object.__new__(NowNowOrderFlow)
    flow.flow_id, flow.order, flow.client = flow_id, local['order_id'], client
    flow.review, flow.items, flow.current = state['review'], state['items'], None
    try:
        paid = confirm(flow_id, client=client)
    except Exception:
        flow.register_tracker('NowNow order', recipient=recipient, paid=False)
        raise
    registration = flow.register_tracker('NowNow order', recipient=recipient)
    try:
        tracking = client.tracking(local['order_id']).projection
    except Exception:
        tracking = {'status': 'unknown', 'read_failed': True}
    j.complete(flow_id)
    return {'ok': True, 'flow_id': flow_id, 'order': flow.order, 'paid': paid,
            'tracking': tracking, 'registration': registration, 'financial_retry': False}
