"""Exact retained NowNow session cleanup, with no financial continuation."""
import time
import uuid
import json
import os

import commerce_journal as j
import commerce_preorder_release as release
from commerce_preorder import IntentVault
from commerce_nownow_capture import load
from noon_auth_lifecycle import NoonAuthLifecycle
from noon_checkout import AccountHome
import noon_nownow_checkout as native


class CleanupUnverified(Exception):
    code = 'NOWNOW_CLEAR_OUTCOME_UNVERIFIED'

    def __init__(self, source_id, cleanup_id, cause):
        self.details = {'flow_id': source_id, 'cleanup_flow_id': cleanup_id,
                        'cause': getattr(cause, 'code', 'READBACK_FAILED'),
                        'financial_send': False, 'cart_mutation_sent': True,
                        'recovery': 'Inspect cleanup_flow_id; do not resend deletion or abandon the cleanup.'}
        super().__init__(self.code)


def _require_source(condition, code):
    if not condition:
        j.fail(code)


def source(flow_id, cleanup_id=None):
    with j._db() as db:
        flow = j._get(db, flow_id)
        ops = list(db.execute('SELECT rowid AS seq,* FROM operations WHERE flow_id=? ORDER BY rowid', (flow_id,)))
        observations = list(db.execute('SELECT * FROM observations WHERE flow_id=?', (flow_id,)))
        failed = any(o['outcome'] == 'FLOW_RELEASED_FAILED_PREORDER' for o in observations)
        _require_source(flow['app'] == 'noon' and flow['vertical'] == 'nownow'
            and flow['state'] == 'RELEASED' and flow['order_id'] is None and bool(ops)
            and all(o['state'] == 'OBSERVED' and o['kind'] not in ('place', 'payment') for o in ops),
            'NOWNOW_CLEAR_CLOSED_FLOW_REQUIRED')
        financial = any(o['kind'] in ('preauthorize', 'prepay') for o in ops)
        _require_source((financial and failed) or (not financial and flow['reserved_minor'] == 0),
                       'NOWNOW_CLEAR_FINANCIAL_HISTORY')
        _require_source(not any(o['order_id'] or o['outcome'] in
            ('PREORDER_PAYMENT_CONFIRMED', 'PAYMENT_REPORTED_SUCCESS', 'EXACT_ORDER_CONFIRMED')
            for o in observations), 'NOWNOW_CLEAR_SUCCESS_HISTORY')
        for op in ops:
            if op['kind'] in ('preauthorize', 'prepay'):
                continue  # The terminal release and fresh failed intent cover these only.
            evidence = [o for o in observations if o['operation'] == op['name']]
            _require_source(any(o['outcome'] == 'RESPONSE_RECEIVED' for o in evidence)
                and all(o['outcome'] in ('RESPONSE_RECEIVED', 'CART_READBACK') for o in evidence),
                'NOWNOW_CLEAR_UNRESOLVED_CART_HISTORY')
        _require_source(not db.execute("SELECT 1 FROM operations p JOIN flows f ON p.flow_id=f.id "
            "WHERE f.app='noon' AND f.account_hash=? AND p.rowid>? AND f.id!=? AND f.id!=?",
            (flow['account_hash'], ops[-1]['seq'], flow_id, cleanup_id or '')).fetchone(),
            'NOWNOW_CLEAR_OWNERSHIP_SUPERSEDED')
        return {'account_hash': flow['account_hash'], 'failed_preorder': financial}


def clear_cart(flow_id, *, auth=None, request=native.native_request, vault=None):
    proof = source(flow_id)
    state = load(flow_id)
    auth = auth or NoonAuthLifecycle()
    j.require_account_available('noon', proof['account_hash'])
    cleanup_id = str(uuid.uuid4())
    p = state['review']['projection']
    body = {'sessionCode': p['session']}
    digest = j.digest(body)
    current = None

    def verify():
        nonlocal current
        native.require(source(flow_id, cleanup_id) == proof, 'NOWNOW_CLEAR_SOURCE_CHANGED')
        _, reader, review = release.review_cart(flow_id, auth=auth)
        if proof['failed_preorder']:
            saved = (vault or IntentVault()).load(flow_id)
            pre = j.preorder_status(flow_id)
            native.require(saved['intent_hash'] == pre['intent_hash'] and not pre['payment_confirmed']
                and saved['review_hash'] == review['digest'] and saved['card_hash'] == state['card_hash'],
                'NOWNOW_CLEAR_INTENT_CHANGED')
            result = reader._call('payment_status', {'clientSecret': saved['secret']}, 25)
            release.failed_intent(result, saved, state)
        current = auth.revalidate('nownow')
        native.require(current.account_ref == proof['account_hash'] and current.address_ref == state['address_hash'],
                       'NOWNOW_CLEAR_ACCOUNT_HOME_CHANGED')
        return reader

    verify()
    root = j.ROOT / 'nownow-cleanup'
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (root / (cleanup_id + '.json')).open('x') as handle:
        os.fchmod(handle.fileno(), 0o600)
        json.dump({'flow_id': flow_id, 'cleanup_flow_id': cleanup_id,
                   'session_hash': j.digest(body)}, handle)
        handle.flush()
        os.fsync(handle.fileno())
    j.open_flow(flow_id=cleanup_id, app='noon', vertical='nownow', account_hash=proof['account_hash'],
                scope_hash=j.digest({'cleanup_of': flow_id, 'session': p['session']}))

    def headers(operation, deadline):
        nonlocal current
        native.require(operation in ('cart_delete', 'cart_get'), 'NOWNOW_CLEAR_OPERATION_DENIED')
        if operation == 'cart_delete':
            verify()
        else:
            current = auth.revalidate('nownow', deadline=deadline)
            native.require(current.account_ref == proof['account_hash']
                and current.address_ref == state['address_hash'], 'NOWNOW_CLEAR_ACCOUNT_HOME_CHANGED')
        return current.mutation_headers('nownow')

    def before(operation, request_hash):
        native.require(operation == 'cart_delete' and request_hash == digest, 'NOWNOW_CLEAR_REQUEST_CHANGED')
        source(flow_id, cleanup_id)
        return j.consume(cleanup_id, 'cart_delete', kind='cart', request_hash=digest)

    def receipt(record):
        j.observe(cleanup_id, record['operation'], outcome=record['outcome'], evidence_hash=record['evidence_hash'])
        return True

    def cookies(operation, values, **kw):
        if kw['outcome_journaled']:
            auth.retain_response_cookies('nownow', current, values,
                response_url=kw['response_url'], http_status=kw['http_status'])
        return True

    client = native.NowNowCheckout(AccountHome('nownow', proof['account_hash'], state['address_hash'], time.time()),
        header_provider=headers, request=request, receipt=receipt, response_cookies=cookies)
    try:
        client.delete_cart(p['session'], before_send=before)
        def before_read(operation, request_hash):
            native.require(operation == 'cart_get' and request_hash == j.digest({'storeCode': p['store']}),
                           'NOWNOW_CLEAR_REQUEST_CHANGED')
            return j.consume(cleanup_id, 'cart_get', kind='quote', request_hash=request_hash)
        exact = client.get_cart(p['store'], before_send=before_read, timeout=25)
        native.require('data' in exact.wire and exact.wire['data'] is None
                       and exact.projection.get('empty') is True, 'NOWNOW_CLEAR_NOT_EMPTY')
        from commerce_nownow import reader
        check = reader(auth=auth, expected_account=proof['account_hash'], expected_address=state['address_hash'])
        carts = check.recent_carts(timeout=25).projection['carts']
        native.require(not any(c.get('session_code') == p['session'] or c.get('store_code') == p['store']
                               for c in carts), 'NOWNOW_CLEAR_NOT_EMPTY')
        native.require(not check.home(timeout=25).projection['active_orders'], 'NOWNOW_CLEAR_ACTIVE_ORDER')
        j.observe(cleanup_id, 'cart_delete', outcome='CART_READBACK',
                  evidence_hash=j.digest({'exact': exact.projection, 'recent': carts, 'cart_empty': True}))
        j.abandon(cleanup_id)
    except Exception as exc:
        if not j.inspect(cleanup_id)['operations']:
            j.abandon(cleanup_id)
        else:
            raise CleanupUnverified(flow_id, cleanup_id, exc) from None
        raise
    return {'ok': True, 'flow_id': flow_id, 'cleanup_flow_id': cleanup_id,
            'cart_empty': True, 'cart_mutation_sent': True, 'financial_send': False}
