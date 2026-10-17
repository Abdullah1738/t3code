"""Explicit cart-only cleanup; no order/payment endpoints or financial continuation."""
import hashlib
import time
import uuid

import commerce_journal as j
import noon_minutes_checkout as m
from commerce_minutes import readback_session, readback_active_orders
from noon_auth_lifecycle import NoonAuthLifecycle
from noon_checkout import AccountHome


def clear_cart(flow_id, *, auth=None):
    proof = j.minutes_cleanup_source(flow_id)
    auth = auth or NoonAuthLifecycle()
    snapshot = auth.fresh_before_mutation('minutes')
    m.require(snapshot.account_ref == proof['account_hash'], 'MINUTES_CLEAR_ACCOUNT_MISMATCH')
    j.require_account_available('noon', snapshot.account_ref)
    m.require(readback_active_orders(auth).projection['count'] == 0, 'MINUTES_ACTIVE_ORDER_PRESENT')
    current = readback_session(auth)
    if not current.projection['lines']:
        return {'ok': True, 'flow_id': flow_id, 'cart_empty': True, 'already_empty': True,
                'financial_send': False, 'cart_mutation_sent': False}

    def verify_readback(snap):
        operation = 'session_get' if proof['operation'].startswith('session_readback_') else proof['operation']
        observation = m.ResponseObservation('https://' + m.ROUTES[operation][1] + m.ROUTES[operation][2], 200, ())
        record = m.MinutesCheckout._response_receipt(operation, proof['request_hash'], [observation],
            None, snap, None, None, hashlib.sha256(m._json(snap.projection)).hexdigest())
        m.require(record['evidence_hash'] == proof['evidence_hash'], 'MINUTES_CLEAR_CART_READBACK_MISMATCH')

    verify_readback(current)
    cleanup_id = str(uuid.uuid4())
    body = {'skus': [], 'bundles': [], 'refresh': False}
    request_hash = hashlib.sha256(m._json(body)).hexdigest()
    j.claim_minutes_cleanup(flow_id, cleanup_id, evidence_hash=proof['evidence_hash'])

    def headers(operation, deadline):
        nonlocal snapshot
        # Read before obtaining mutation headers: these reads can rotate cookies.
        m.require(readback_active_orders(auth).projection['count'] == 0, 'MINUTES_ACTIVE_ORDER_PRESENT')
        verify_readback(readback_session(auth))
        fresh = auth.fresh_before_mutation('minutes', deadline=deadline)
        m.require((fresh.account_ref, fresh.address_ref) == (snapshot.account_ref, snapshot.address_ref),
                  'MINUTES_ACCOUNT_HOME_CHANGED')
        snapshot = fresh
        return fresh.mutation_headers('minutes')

    def before(operation, digest):
        m.require(operation == 'sync' and digest == request_hash, 'MINUTES_CLEAR_REQUEST_NOT_BOUND')
        # Refuse concurrent local changes after the fresh remote header/readback pass.
        m.require(j.minutes_cleanup_source(flow_id) == proof, 'MINUTES_CLEAR_CART_OWNERSHIP_SUPERSEDED')
        return j.consume(cleanup_id, 'clear_cart', kind='cart', request_hash=digest)

    def receipt(record):
        j.observe(cleanup_id, 'clear_cart', outcome=record['outcome'], evidence_hash=record['evidence_hash'])
        return True

    def cookies(operation, values, *, response_url, http_status, outcome_journaled):
        if outcome_journaled:
            auth.retain_response_cookies('minutes', snapshot, values,
                response_url=response_url, http_status=http_status)
        return True

    client = m.MinutesCheckout(snapshot.read_headers(),
        AccountHome('minutes', snapshot.account_ref, snapshot.address_ref, time.time()),
        header_provider=headers, receipt=receipt, response_cookies=cookies)
    try:
        result = client.sync(skus=[], bundles=[], refresh=False, before_send=before, timeout=25)
        m.require(not result.projection['lines'], 'MINUTES_CLEAR_NOT_EMPTY')
        after = readback_session(auth)
        m.require(not after.projection['lines'], 'MINUTES_CLEAR_NOT_EMPTY')
        j.abandon(cleanup_id)
    except Exception:
        # Consumed sends retain the fence; never automatically retry an empty sync.
        if not j.inspect(cleanup_id)['operations']:
            j.abandon(cleanup_id)
        raise
    return {'ok': True, 'flow_id': flow_id, 'cleanup_flow_id': cleanup_id,
            'cart_empty': True, 'financial_send': False, 'cart_mutation_sent': True}
