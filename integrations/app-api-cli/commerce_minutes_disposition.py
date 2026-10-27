"""Close a Minutes flow whose exact order noon itself reports failed/cancelled and uncaptured.

Fresh, account-bound reads only: order/get (exact echoed orderNr), order/get-active and
paymentintent/status. Never sends a cart, place or payment operation. The closure is a
terminal local disposition: the reservation, order ownership and consumed operations
stay recorded, and nothing here authorizes a retry or a replacement purchase.
"""
import hashlib
import json
import re
import time

import commerce_journal as journal
import commerce_receipts as receipts
import noon_minutes_checkout as m
from commerce_auth_status import CommerceAuth
from noon_checkout import AccountHome

DEAD_STATUSES = ('failed', 'cancelled')
# Any of these in the intent's transaction status means money may have moved.
MONEY_MOVED = re.compile(r'CAPTUR|AUTHORI[SZ]|SETTL|REFUND|CHARGE')
TERMINAL_PAYMENT_STATUSES = ('payment_failed', 'payment_error')
# A failure label alone is not finality: noon's fixtures show failed-looking intents still
# carrying CREATED / 3DS_ENROLL_INITIATED transactions. Only transaction statuses noon
# has been observed to finalise as a non-capture may close a flow. None observed yet, so
# the fence holds by default until a real terminal failure fixture is captured.
TERMINAL_NO_CAPTURE_TXNS = ()


def _wire_hash(value):
    # Native wire money is Decimal (parse_float=Decimal); hash its exact text.
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), default=str).encode()).hexdigest()


def failed_uncaptured_evidence(order_snap, active, intent, *, order, reserved_minor):
    """Pure gate over the three fresh reads; any other shape keeps the flow open."""
    def require(ok, code):
        if not ok:
            journal.fail(code)

    got = order_snap.projection
    require(got.get('order') == order and got.get('identity_echoed') is True,
            'MINUTES_FAILED_CLOSE_EXACT_ORDER_REQUIRED')
    require(got.get('raw_status') in DEAD_STATUSES, 'MINUTES_FAILED_CLOSE_ORDER_NOT_FAILED')
    total = m.amount_minor(order_snap.wire['orderTotal'])
    require(total == 0, 'MINUTES_FAILED_CLOSE_ORDER_TOTAL_NOT_ZERO')
    require(order not in [row['order'] for row in active['active']],
            'MINUTES_FAILED_CLOSE_ORDER_STILL_ACTIVE')
    require(got.get('payment_intent_present') is True and intent is not None,
            'MINUTES_FAILED_CLOSE_INTENT_READ_REQUIRED')
    pay = intent.projection
    txn = pay.get('transaction_status') or ''
    # Only a terminal failure proves no future capture: an in-progress intent (pending,
    # CREATED, 3DS enrol, ready-to-redirect) can still settle, so it keeps the flow fenced.
    require(pay.get('paid') is False and pay.get('state') == 'payment_failed'
            and pay.get('payment_status') in TERMINAL_PAYMENT_STATUSES
            and txn in TERMINAL_NO_CAPTURE_TXNS
            and not pay.get('redirect_required')
            and pay.get('error_code') in (None, '0')
            and not MONEY_MOVED.search(txn)
            and pay.get('authorized_minor') == 0 and pay.get('captured_minor') == 0,
            'MINUTES_FAILED_CLOSE_INTENT_NOT_UNCAPTURED')
    return {'order': order, 'currency': 'AED', 'amount_minor': reserved_minor,
            'order_status': got['raw_status'], 'order_total_minor': total,
            'payment_error_present': got.get('payment_error_present'),
            'active_orders_checked': True, 'order_active': False,
            'intent_status': pay.get('payment_status'), 'intent_transaction_status': txn or None,
            'authorized_minor': 0, 'captured_minor': 0, 'is_3ds_failure': pay.get('is_3ds_failure'),
            'provider_order_failed': True, 'uncaptured_at_check': True,
            'response_hashes': [_wire_hash(order_snap.wire), _wire_hash(active),
                                _wire_hash(intent.wire)]}


def attested_failed_evidence(order_snap, active, intent, *, order, reserved_minor):
    """Pure gate for the owner-attested close of a noon-failed Minutes order.

    No terminal-transaction allowlist here: the owner's card check stands in for
    bank-side finality. An in-progress intent (redirect, 3DS enrol) is allowed and
    recorded; anything that shows money paid, moved or pending capture still refuses.
    """
    def require(ok, code):
        if not ok:
            journal.fail(code)

    got = order_snap.projection
    require(got.get('order') == order and got.get('identity_echoed') is True,
            'MINUTES_OWNER_ATTEST_EXACT_ORDER_REQUIRED')
    require(got.get('raw_status') in DEAD_STATUSES, 'MINUTES_OWNER_ATTEST_ORDER_NOT_FAILED')
    total = m.amount_minor(order_snap.wire['orderTotal'])
    require(total == 0, 'MINUTES_OWNER_ATTEST_ORDER_TOTAL_NOT_ZERO')
    require(order not in [row['order'] for row in active['active']],
            'MINUTES_OWNER_ATTEST_ORDER_STILL_ACTIVE')
    require(got.get('payment_intent_present') is True and intent is not None,
            'MINUTES_OWNER_ATTEST_INTENT_READ_REQUIRED')
    pay = intent.projection
    txn = pay.get('transaction_status') or ''
    require(pay.get('paid') is False and pay.get('payment_status') != 'payment_confirmed',
            'MINUTES_OWNER_ATTEST_INTENT_PAID')
    require(not MONEY_MOVED.search(txn), 'MINUTES_OWNER_ATTEST_MONEY_MOVED')
    require(pay.get('authorized_minor') == 0 and pay.get('captured_minor') == 0,
            'MINUTES_OWNER_ATTEST_AMOUNT_NOT_ZERO')
    return {'order': order, 'currency': 'AED', 'amount_minor': reserved_minor,
            'order_status': got['raw_status'], 'order_total_minor': total,
            'payment_error_present': got.get('payment_error_present'),
            'active_orders_checked': True, 'order_active': False,
            'intent_status': pay.get('payment_status'), 'intent_transaction_status': txn or None,
            'redirect_required': bool(pay.get('redirect_required')),
            'authorized_minor': 0, 'captured_minor': 0, 'is_3ds_failure': pay.get('is_3ds_failure'),
            'response_hashes': [_wire_hash(order_snap.wire), _wire_hash(active),
                                _wire_hash(intent.wire)]}


def _client(binding, auth):
    manager = (auth or CommerceAuth()).noon
    current = None

    def headers(operation, deadline):
        nonlocal current
        state = manager.status('minutes')
        current = (manager.reconcile('minutes') if state['maintenance_state'] != 'none'
                   else manager.revalidate('minutes', deadline=deadline))
        if current.account_ref != binding['account_hash']:
            journal.fail('RECOVERY_ACCOUNT_CHANGED')
        return current.read_headers()

    first = headers('order_get', time.monotonic() + 25)

    def cookies(operation, values, *, response_url, http_status, outcome_journaled):
        manager.retain_response_cookies('minutes', current, values, response_url=response_url,
                                        http_status=http_status)
        return True
    return m.MinutesCheckout(first, AccountHome('minutes', current.account_ref, current.address_ref, time.time()),
                             header_provider=headers, response_cookies=cookies)


def close_failed(flow_id, *, auth=None, client=None):
    binding, local = journal.binding(flow_id), journal.inspect(flow_id)
    if (binding['app'] != 'noon' or binding['vertical'] != 'minutes'
            or local['state'] not in ('ACTIVE', 'FENCED') or not local['order_id']
            or local['reserved_minor'] <= 0):
        journal.fail('MINUTES_FAILED_FLOW_REQUIRED')
    order = local['order_id']
    store = receipts.load(**binding)
    snapshot = store.snapshot()
    placed = [r for r in snapshot.receipts if r.operation == 'place' and r.order_id == order]
    if (len(placed) != 1 or placed[0].currency != 'AED'
            or placed[0].payable_minor != local['reserved_minor']
            or any(r.state == 'PAYMENT_REPORTED_SUCCESS' for r in snapshot.receipts)):
        journal.fail('EXACT_PLACE_RECEIPT_REQUIRED')
    # Local shape is checked before any network read, then again atomically at commit.
    journal.minutes_failed_close_precheck(flow_id)
    client = client or _client(binding, auth)
    order_snap = client.order_status(order, timeout=25)
    active = client.active_orders(timeout=25).projection
    token = order_snap.wire.get('paymentIntentToken')
    intent = None
    if type(token) is str and token:
        intent = client.payment_intent_status(order=order, client_secret=token,
                                              total_minor=local['reserved_minor'], timeout=25)
    evidence = failed_uncaptured_evidence(order_snap, active, intent, order=order,
                                          reserved_minor=local['reserved_minor'])
    evidence.update(checked_at=time.time(), account_hash=binding['account_hash'])
    with store.locked_snapshot() as current:
        if current.receipts != snapshot.receipts:
            journal.fail('MINUTES_FAILED_CLOSE_RECEIPTS_CHANGED')
        closed = journal.close_minutes_failed_uncaptured(flow_id, evidence=evidence, expected_local=local)
    return {'ok': True, 'flow_id': flow_id, 'app': 'noon', 'vertical': 'minutes', 'order': order,
            **closed, 'evidence': {k: v for k, v in evidence.items() if k != 'account_hash'},
            'disposition': 'provider_failed_uncaptured', 'charge': 'not_captured_at_check',
            'tell': ('noon reports this order failed on payment and nothing was authorized or captured. '
                     'If a bank hold still shows, it should drop off; a new order needs its own go.'),
            'financial_send': False, 'financial_retry': False}


def owner_attest_failed(flow_id, *, evidence, attested_by, auth=None, client=None):
    """Terminal owner-attested close of a noon-failed Minutes flow.

    Owner evidence is validated before anything else, then the same local shape and
    exact receipts as close_failed, then the three fresh reads and the strict gate.
    Only the journal's owner-attestation close writes; nothing here sends or retries.
    """
    journal.validate_owner_attestation(evidence=evidence, attested_by=attested_by)
    binding, local = journal.binding(flow_id), journal.inspect(flow_id)
    if (binding['app'] != 'noon' or binding['vertical'] != 'minutes'
            or local['state'] not in ('ACTIVE', 'FENCED') or not local['order_id']
            or local['reserved_minor'] <= 0):
        journal.fail('MINUTES_FAILED_FLOW_REQUIRED')
    order = local['order_id']
    store = receipts.load(**binding)
    snapshot = store.snapshot()
    placed = [r for r in snapshot.receipts if r.operation == 'place' and r.order_id == order]
    if (len(placed) != 1 or placed[0].currency != 'AED'
            or placed[0].payable_minor != local['reserved_minor']
            or any(r.state == 'PAYMENT_REPORTED_SUCCESS' for r in snapshot.receipts)):
        journal.fail('EXACT_PLACE_RECEIPT_REQUIRED')
    journal.minutes_failed_close_precheck(flow_id)
    client = client or _client(binding, auth)
    order_snap = client.order_status(order, timeout=25)
    active = client.active_orders(timeout=25).projection
    token = order_snap.wire.get('paymentIntentToken')
    intent = None
    if type(token) is str and token:
        intent = client.payment_intent_status(order=order, client_secret=token,
                                              total_minor=local['reserved_minor'], timeout=25)
    checked = attested_failed_evidence(order_snap, active, intent, order=order,
                                       reserved_minor=local['reserved_minor'])
    checked.update(checked_at=time.time(), account_hash=binding['account_hash'])
    with store.locked_snapshot() as current:
        if current.receipts != snapshot.receipts:
            journal.fail('MINUTES_OWNER_ATTEST_RECEIPTS_CHANGED')
        closed = journal.close_minutes_owner_attested_uncharged(
            flow_id, evidence=evidence, attested_by=attested_by,
            provider_evidence=checked, expected_local=local)
    return {'ok': True, 'flow_id': flow_id, 'app': 'noon', 'vertical': 'minutes', 'order': order,
            **closed, 'evidence': {k: v for k, v in checked.items() if k != 'account_hash'},
            'disposition': 'owner_attested_uncharged', 'liability': 'owner_attested_uncharged',
            'provider_no_charge_proven': False, 'financial_send': False, 'financial_retry': False,
            'reservation_release_allowed': False}
