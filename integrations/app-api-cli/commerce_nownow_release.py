"""Read-only evidence for terminal closure of an expired NowNow bank challenge."""
import datetime as dt
import math
import time

import commerce_journal as j
from commerce_preorder import IntentVault
from commerce_nownow import reader
from commerce_nownow_capture import load
from noon_nownow_checkout import Snapshot
from noon_minutes_checkout import amount_minor, _application_ok
from noon_checkout import fingerprint


def require(ok, code='EVIDENCE_INVALID'):
    if not ok:
        j.fail('RELEASE_NOWNOW_' + code)


def timestamp(value, zone=None):
    try:
        if type(value) in (int, float):
            require(math.isfinite(value))
            return float(value)
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None and zone in ('+04:00', '+00:00'):
            parsed = parsed.replace(tzinfo=dt.timezone(dt.timedelta(hours=4 if zone == '+04:00' else 0)))
        require(parsed.tzinfo is not None)
        return parsed.timestamp()
    except (ValueError, TypeError, AttributeError):
        j.fail('RELEASE_NOWNOW_EVIDENCE_INVALID')


def no_order(client, state, created_at):
    response = client._call('orders', {}, 25, project=lambda d: Snapshot(d, {}, time.time()))
    _application_ok(response.wire)
    _application_ok(response.wire.get('data'))
    rows = response.wire.get('data', {}).get('orders')
    require(isinstance(rows, list))
    # The native history endpoint has no proven pagination contract. A returned
    # order older than this flow bounds its default page; an unbounded/empty page
    # is inconclusive, rather than an invitation to infer an absent order.
    times = [timestamp(row.get('createdAt'), row.get('timeZone')) for row in rows]
    require(bool(times) and min(times) < created_at and times == sorted(times, reverse=True))
    require(all(fingerprint(row.get('customerCode')) == state['binding']['account_hash']
                and j._order(row.get('orderNr')) for row in rows))
    projection = state['review']['projection']
    checked = 0
    for row, at in zip(rows, times):
        require(all(row.get(key) != projection['session'] for key in ('checkoutSessionCode', 'sessionCode', 'orderRef')))
        if at < created_at:
            continue
        order = row.get('orderNr')
        require(isinstance(order, str) and bool(order))
        detail = row
        require(fingerprint(detail.get('customerCode')) == state['binding']['account_hash'])
        require(detail.get('orderNr') == order)
        # Exact cart/session match is conclusive; equal store+amount is ambiguous
        # even when the list omits a cart reference. Both must refuse closure.
        require(all(detail.get(key) != projection['session'] for key in ('checkoutSessionCode', 'sessionCode', 'orderRef')))
        store = (detail.get('storeInfo') or {}).get('storeCode')
        require(isinstance(store, str))
        total = amount_minor(detail.get('orderTotal'))
        require(not (store == projection['store'] and total == state['review']['payable_minor']))
        checked += 1
    return {'no_order': True, 'history_covers_flow_start': True, 'orders_checked': checked}


def eligibility(flow_id, *, auth=None, vault=None, now=None):
    with j.read_only():
        return _eligibility(flow_id,auth=auth,vault=vault,now=now)


def _eligibility(flow_id, *, auth=None, vault=None, now=None):
    local = j.inspect(flow_id)
    require(local['app'] == 'noon' and local['vertical'] == 'nownow'
            and local['state'] == 'FENCED', 'FENCED_REQUIRED')
    with j._db() as db:
        challenge = db.execute("""SELECT 1 FROM observations o JOIN operations p
            ON p.flow_id=o.flow_id AND p.name=o.operation WHERE o.flow_id=?
            AND o.outcome='CHALLENGE_REQUIRED' AND p.kind='prepay'""", (flow_id,)).fetchone()
    require(challenge is not None, 'WRONG_STAGE')
    require(local['order_id'] is None and all(op['state'] == 'OBSERVED'
            and op['kind'] not in ('place', 'payment') for op in local['operations']))
    saved = (vault or IntentVault()).load(flow_id)
    pre = j.preorder_status(flow_id)
    state = load(flow_id)
    require(not pre['payment_confirmed'] and saved['intent_hash'] == pre['intent_hash']
            and saved['review_hash'] == pre['review_hash'] == state['review']['digest']
            and saved['cart_hash'] == pre['cart_hash']
            and saved['payable_minor'] == pre['reserved_minor'] == state['review']['payable_minor']
            and saved['card_hash'] == state['card_hash'])
    client = reader(auth=auth, expected_account=state['binding']['account_hash'])
    result = client._call('payment_status', {'clientSecret': saved['secret']}, 25,
                          project=lambda data: Snapshot(data, {}, time.time()))
    wire = result.wire
    _application_ok(wire)
    # The existing continuation window is 24 h. Its expiry alone proves nothing
    # about money: terminal native status and zero authorisation/capture must also hold.
    expires = j.flow_created_at(flow_id) + 24 * 3600
    require(expires <= (time.time() if now is None else now), 'CHALLENGE_NOT_EXPIRED')
    try:
        terminal = {'payment_failed': 'FAILED', 'payment_expired': 'EXPIRED', 'payment_cancelled': 'CANCELLED'}
        require(wire.get('status') in terminal and wire.get('transaction_status') == terminal[wire['status']])
        require(not wire.get('redirect_url') and wire.get('currency_code') == 'AED'
                and wire.get('payment_method_code') == 'cc_noonpay' and wire.get('is_cc_payment') is True)
        require(fingerprint(wire.get('customer_code')) == state['binding']['account_hash']
                and fingerprint(str(wire.get('id_token'))) == saved['card_hash']
                and str(wire.get('cc_masked') or '').endswith(state['card_last4']))
        require(all(key in wire and wire[key] is not None and amount_minor(wire[key]) == 0
                    for key in ('authorized_amount','captured_amount','reversed_amount','refunded_amount')))
        require(all(wire.get(key) is None for key in ('order','orderNr','order_nr','orderId')))
        evidence = {'payment_status': wire['status'], 'transaction_status': wire['transaction_status'],
                    'authorized_minor': 0, 'captured_minor': 0, 'card_last4': state['card_last4'],
                    'verification_minor': amount_minor(wire.get('amount'))}
        orders = no_order(client, state, j.flow_created_at(flow_id))
    except Exception:
        j.fail('RELEASE_NOWNOW_EVIDENCE_INVALID')
    return {**evidence, **orders, 'continuation_expires_at': expires,
            'intent_hash': saved['intent_hash'], 'review_hash': saved['review_hash']}


def release(flow_id, *, dry_run=False, **kwargs):
    try:
        evidence = eligibility(flow_id, **kwargs)
    except Exception as exc:
        if str(exc).startswith('RELEASE_NOWNOW_'):
            raise
        j.fail('RELEASE_NOWNOW_EVIDENCE_INVALID')
    if dry_run:
        return {'ok': True, 'eligible': True, 'flow_id': flow_id, 'dry_run': True,
                'evidence': evidence, 'financial_send': False, 'journal_changed': False}
    closed = j.release_failed_preorder(flow_id, evidence_hash=j.digest(evidence),
                                       intent_hash=evidence['intent_hash'])
    return {'ok': True, 'flow_id': flow_id, **closed, 'evidence': evidence,
            'financial_send': False, 'financial_retry': False}
