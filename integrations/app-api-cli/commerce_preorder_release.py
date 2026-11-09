"""Read-only evidence for a failed NowNow card check before any placement."""
import time

import commerce_journal as j
from commerce_preorder import IntentVault
from commerce_nownow import reader
from commerce_nownow_capture import load
from noon_checkout import fingerprint
from noon_nownow_checkout import Snapshot
from noon_minutes_checkout import amount_minor, _application_ok


def require(ok, code):
    if not ok:
        j.fail('PREORDER_RELEASE_' + code)


def review_cart(flow_id, *, auth=None):
    """Read the exact retained session, never adopt an arbitrary matching basket."""
    from commerce_auth_status import CommerceAuth
    from commerce_nownow_order import NowNowOrderFlow, saved_card
    state = load(flow_id)
    auth = auth or CommerceAuth().noon
    client = reader(auth=auth, expected_account=state['binding']['account_hash'])
    require(not client.home(timeout=25).projection['active_orders'], 'ACTIVE_ORDER_PRESENT')
    recent = client.recent_carts(timeout=25)
    p = state['review']['projection']
    rows = [r for r in recent.wire['data']['carts'] if r.get('checkoutSessionCode') == p['session']]
    require(len(rows) == 1, 'EXACT_CART_MISSING')
    row = rows[0]
    require(fingerprint(row.get('customerCode')) == state['binding']['account_hash']
            and all(row.get(k) is None for k in ('order', 'orderNr', 'order_nr', 'orderId')), 'CART_ORDER_OR_ACCOUNT_CHANGED')
    # This lane only supports plain items; the legacy review digest omits notes
    # and modifiers, so reject native customizations independently of its hash.
    require(row.get('notes') in (None, '')
            and all(item.get('modifiers') in (None, [], {}) and item.get('notes') in (None, '')
                    for item in row.get('products', [])), 'CART_CUSTOMIZATION_CHANGED')
    # Reuse all normal review guards with a reader that denies every write.
    flow = object.__new__(NowNowOrderFlow)
    flow.flow_id, flow.client, flow.items = flow_id, client, state['items']
    flow.session_code, flow.store_code = p['session'], p['store']
    flow.single = len(flow.items) == 1
    flow.product_code = flow.items[0]['product_code'] if flow.single else None
    flow.quantity = flow.items[0]['quantity'] if flow.single else None
    flow.snapshot = auth.revalidate('nownow')
    require(flow.snapshot.account_ref == state['binding']['account_hash']
            and flow.snapshot.address_ref == state['address_hash'], 'ACCOUNT_HOME_CHANGED')
    flow.current = Snapshot({'data': row}, {}, recent.observed_at)
    flow.card = saved_card(client, timeout=25)
    require(fingerprint(flow.card.token) == state['card_hash'], 'CARD_CHANGED')
    flow.review_final()
    require(flow.review['digest'] == state['review']['digest'], 'CART_CHANGED')
    return state, client, flow.review


def failed_intent(data, saved, state):
    _application_ok(data)
    require(data.get('status') == 'payment_failed' and data.get('transaction_status') == 'FAILED'
            and not data.get('redirect_url') and data.get('error_code') not in (None, '', '0', 0), 'NOT_TERMINAL_FAILURE')
    require(data.get('currency_code') == 'AED' and data.get('payment_method_code') == 'cc_noonpay'
            and data.get('is_cc_payment') is True, 'PAYMENT_KIND_CHANGED')
    require(fingerprint(data.get('customer_code')) == state['binding']['account_hash']
            and fingerprint(str(data.get('id_token'))) == saved['card_hash']
            and str(data.get('cc_masked') or '').endswith(state['card_last4']), 'PAYMENT_IDENTITY_CHANGED')
    for key in ('authorized_amount', 'captured_amount', 'reversed_amount', 'refunded_amount'):
        require(key in data and data[key] is not None and amount_minor(data[key]) == 0, 'NONZERO_OR_UNKNOWN_AMOUNT')
    require(all(data.get(k) is None for k in ('order', 'orderNr', 'order_nr', 'orderId')), 'ORDER_PRESENT')
    return {'payment_status': 'payment_failed', 'transaction_status': 'FAILED',
            'authorized_minor': 0, 'captured_minor': 0, 'error_code': data['error_code'],
            'verification_minor': amount_minor(data.get('amount')), 'card_last4': state['card_last4']}


def release(flow_id, *, auth=None, vault=None):
    local = j.inspect(flow_id)
    require(local['app'] == 'noon' and local['vertical'] == 'nownow' and local['state'] == 'FENCED'
            and local['order_id'] is None and not any(o['kind'] in ('place', 'payment') for o in local['operations'])
            and all(o['state'] == 'OBSERVED' for o in local['operations']), 'HISTORY_INVALID')
    saved = (vault or IntentVault()).load(flow_id)
    pre = j.preorder_status(flow_id)
    require(not pre['payment_confirmed'] and saved['intent_hash'] == pre['intent_hash']
            and saved['review_hash'] == pre['review_hash'] and saved['cart_hash'] == pre['cart_hash']
            and saved['payable_minor'] == pre['reserved_minor'], 'BINDING_MISMATCH')
    state, client, review = review_cart(flow_id, auth=auth)
    require(saved['card_hash'] == state['card_hash'] and review['digest'] == pre['review_hash'], 'BINDING_MISMATCH')
    result = client._call('payment_status', {'clientSecret': saved['secret']}, 25,
                         project=lambda d: Snapshot(d, {}, time.time()))
    evidence = failed_intent(result.wire, saved, state)
    evidence.update(intent_hash=saved['intent_hash'], review_hash=review['digest'],
                    exact_session_present=True, placement_calls=0, order=None,
                    source='retained_intent_status_and_exact_unplaced_cart')
    closed = j.release_failed_preorder(flow_id, evidence_hash=j.digest(evidence), intent_hash=saved['intent_hash'])
    return {'ok': True, 'flow_id': flow_id, **closed, 'evidence': evidence,
            'financial_send': False, 'financial_retry': False}


def prepare_released(flow_id, *, store_code, items, auth=None):
    from commerce_nownow_order import _normalize_items
    local = j.inspect(flow_id)
    require(local['state'] == 'RELEASED', 'RELEASED_REQUIRED')
    state = load(flow_id)
    require(store_code == state['review']['projection']['store']
            and _normalize_items(None, None, items) == state['items'], 'MANIFEST_CHANGED')
    j.require_account_available('noon', state['binding']['account_hash'])
    _, _, review = review_cart(flow_id, auth=auth)
    return {'ok': True, 'flow_id': flow_id, 'state': 'PREPARED_NOT_ORDERED', 'review': review,
            'readback': {'verified': True}, 'account_available': True, 'financial_send': False,
            'retry_allowed': False, 'released_cart_review_only': True}
