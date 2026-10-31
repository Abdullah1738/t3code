"""Explicit, at-most-once removal of journal-owned Main/Supermall cart rows."""
import order_card
import uuid

import commerce_journal as j
import noon_marketplace_checkout as m
from commerce_main_order import active_marketplace_orders
from noon_auth_lifecycle import NoonAuthLifecycle


def require(value, code):
    if not value:
        j.fail(code)


def inventory(response):
    projection = response.summary()
    rows = projection['items']
    result = {}
    for row in rows:
        key = (row.get('offerCode'), row.get('variantKey', ''))
        require(isinstance(key[0], str) and m.ID.fullmatch(key[0])
                and key not in result and type(row.get('quantity')) is int,
                'MARKETPLACE_CLEAR_CART_SCHEMA_CHANGED')
        result[key] = row['quantity']
    require(projection['count'] == sum(result.values())
            and (bool(result) or projection['empty']), 'MARKETPLACE_CLEAR_CART_SCHEMA_CHANGED')
    return result


def row_fingerprints(response):
    return {(row['offerCode'], row.get('variantKey', '')): row['identity_digest']
            for row in response.summary()['items']}


def owned_adds(proof, response):
    """Reconstruct only known add requests; a matching title is never ownership."""
    rows = inventory(response)
    require(bool(rows), 'MARKETPLACE_CLEAR_CART_READBACK_MISMATCH')
    matched = {}
    for (offer, variant), qty in rows.items():
        require(variant == '', 'MARKETPLACE_CLEAR_VARIANT_UNSUPPORTED')
        candidates = [m.operation(response.operation.service, 'add', offer=offer, quantity=qty,
                                  is_page_cart=page) for page in (False, True)]
        candidates.append(m.operation(response.operation.service, 'add_rocket', offer=offer, quantity=qty))
        found = [(op, saved) for op in candidates for saved in proof['adds']
                 if op.digest == saved['request_hash'] and saved['name'] in
                 (op.name, op.name + '_' + op.digest[:16])]
        require(len(found) == 1, 'MARKETPLACE_CLEAR_CART_NOT_OWNED')
        op, saved = found[0]
        require(saved['name'] not in matched, 'MARKETPLACE_CLEAR_CART_NOT_OWNED')
        matched[saved['name']] = (op, offer)
    require(set(matched) == {op['name'] for op in proof['adds']}, 'MARKETPLACE_CLEAR_CART_NOT_OWNED')
    return matched


def verify_source(proof, response, snapshot, vertical):
    adds = owned_adds(proof, response)
    if proof.get('closed_uncharged'):
        # noon rebuilds the cart after a failed order, so the bytes differ. Ownership
        # rests on owned_adds (every row one of our adds, nothing else) plus the scope.
        require(proof['readback_hash'] is None, 'MARKETPLACE_CLEAR_CART_READBACK_MISMATCH')
        raw = response.data.get('items')
        if 'groups' in response.data:
            from noon_marketplace_native_shape import _flatten
            raw = [row for _, _, row in _flatten(response.data, 'groups', 'SCHEMA_CART_ROWS')]
        require(type(raw) is list, 'MARKETPLACE_CLEAR_CART_SCHEMA_CHANGED')
        by_offer = {row.get('offerCode'): row for row in raw}
        items = [{'sku_config': by_offer[adds[op['name']][1]].get('skuConfig'),
                  'quantity': by_offer[adds[op['name']][1]].get('quantity')} for op in proof['adds']]
        require(len(raw) == len(items), 'MARKETPLACE_CLEAR_CART_NOT_OWNED')
        require(all(isinstance(row['sku_config'], str) and m.ID.fullmatch(row['sku_config'])
                    for row in items), 'MARKETPLACE_CLEAR_CART_NOT_OWNED')
        from commerce_main_order import _scope_hash as main_scope
        from commerce_supermall_order import _scope_hash as rocket_scope
        scope = (main_scope if vertical == 'main' else rocket_scope)(items, snapshot.address_ref)
        require(proof['scope_hash'] == scope, 'MARKETPLACE_CLEAR_ACCOUNT_HOME_CHANGED')
        return
    if proof['readback_hash']:
        require(m.cleanup_readback_hash(response, snapshot.account_ref, snapshot.address_ref)
                == proof['readback_hash'], 'MARKETPLACE_CLEAR_CART_READBACK_MISMATCH')
        return
    # Older preparations retained the add receipt, not a separate cart readback.
    # Reconstruct its ENTIRE response evidence, and independently bind Home to
    # the original scope. No adoption based merely on the visible SKUs.
    last = adds[proof['adds'][-1]['name']][0]
    observation = m.ResponseObservation('https://' + last.host + last.path, 200, ())
    record = m.MarketplaceClient._response_receipt(last, [observation], response.data, None)
    require(record['evidence_hash'] == proof['add_evidence_hash'],
            'MARKETPLACE_CLEAR_CART_READBACK_MISMATCH')
    scopes = [j.digest({'service': vertical, 'account': snapshot.account_ref,
                       'home': snapshot.address_ref, 'card': order_card.LAST4, 'quiet': True})]
    raw = response.data.get('items')
    if isinstance(raw, list) and raw and 'groups' not in response.data:
        by_offer = {row.get('offerCode'): row for row in raw}
        rows = [by_offer[adds[op['name']][1]] for op in proof['adds']]
        items = [{'sku_config': row.get('skuConfig'), 'quantity': row.get('quantity')} for row in rows]
        if all(isinstance(row['sku_config'], str) and m.ID.fullmatch(row['sku_config']) for row in items):
            from commerce_main_order import _scope_hash as main_scope
            from commerce_supermall_order import _scope_hash as rocket_scope
            scopes.append((main_scope if vertical == 'main' else rocket_scope)(items, snapshot.address_ref))
    require(proof['scope_hash'] in scopes, 'MARKETPLACE_CLEAR_ACCOUNT_HOME_CHANGED')


def clear_cart(flow_id, vertical, *, auth=None, request=m.native_request, timeout=25):
    proof = j.marketplace_cleanup_source(flow_id, vertical)
    auth = auth or NoonAuthLifecycle()
    def auth_snapshot(deadline=None):
        state = auth.status(vertical)
        return (auth.reconcile(vertical) if state['maintenance_state'] != 'none'
                else auth.revalidate(vertical, deadline=deadline))
    snapshot = auth_snapshot()
    require(snapshot.account_ref == proof['account_hash'], 'MARKETPLACE_CLEAR_ACCOUNT_MISMATCH')
    address = snapshot.address_ref
    j.require_account_available('noon', snapshot.account_ref)
    cleanup_id = None
    expected = None
    current_name = None

    def headers(operation, deadline):
        nonlocal snapshot
        fresh = auth_snapshot(deadline)
        require((fresh.account_ref, fresh.address_ref) == (proof['account_hash'], address),
                'MARKETPLACE_CLEAR_ACCOUNT_HOME_CHANGED')
        snapshot = fresh
        return fresh.mutation_headers(vertical) if operation.mutation else fresh.read_headers()

    def before(metadata):
        require(expected is not None and metadata == {
            'service': expected.service, 'operation': 'remove',
            'request_digest': expected.digest, 'order_id': None}, 'MARKETPLACE_CLEAR_REQUEST_NOT_BOUND')
        require(j.marketplace_cleanup_source(flow_id, vertical, cleanup_flow_id=cleanup_id) == proof,
                'MARKETPLACE_CLEAR_CART_OWNERSHIP_SUPERSEDED')
        return j.consume(cleanup_id, current_name, kind='cart', request_hash=expected.digest)

    def receipt(record):
        j.observe(cleanup_id, current_name, outcome=record['outcome'], evidence_hash=record['evidence_hash'])
        return True

    def cookies(operation, values, *, response_url, http_status, outcome_journaled):
        if operation == 'cart' or outcome_journaled:
            auth.retain_response_cookies(vertical, snapshot, values,
                response_url=response_url, http_status=http_status)
        return True

    require(not active_marketplace_orders(timeout=timeout), 'MARKETPLACE_ACTIVE_ORDER_PRESENT')
    # Both paid lanes use ecom; early Supermall probes used the rocket rail.
    source_error = None
    for service in (('main', 'supermall') if vertical == 'supermall' else ('main',)):
        client = m.MarketplaceClient(service, header_provider=headers, before_send=before,
                                    receipt=receipt, response_cookies=cookies, request=request)
        current = client.cart(timeout=timeout)
        if current.summary()['empty']:
            continue
        try:
            verify_source(proof, current, snapshot, vertical)
            break
        except j.JournalError as exc:
            source_error = source_error or exc
    else:
        if source_error:
            raise source_error
        return {'ok': True, 'flow_id': flow_id, 'cart_empty': True, 'already_empty': True,
                'financial_send': False, 'cart_mutation_sent': False}
    remaining = inventory(current)
    remaining_fingerprints = row_fingerprints(current)
    expected_hash = current.digest
    cleanup_id = str(uuid.uuid4())
    require(j.marketplace_cleanup_source(flow_id, vertical) == proof,
            'MARKETPLACE_CLEAR_CART_OWNERSHIP_SUPERSEDED')
    j.open_flow(flow_id=cleanup_id, app='noon', vertical=vertical, account_hash=proof['account_hash'],
                scope_hash=j.digest({'cleanup_of': flow_id, 'proof': proof}))
    try:
        for offer, variant in list(remaining):
            require(not active_marketplace_orders(timeout=timeout), 'MARKETPLACE_ACTIVE_ORDER_PRESENT')
            fresh = client.cart(timeout=timeout)
            require(fresh.digest == expected_hash, 'MARKETPLACE_CLEAR_CART_READBACK_MISMATCH')
            args = {'offer': offer, 'is_page_cart': True, 'variant_key': variant}
            expected = m.operation(service, 'remove', **args)
            current_name = 'clear_' + expected.digest[:16]
            result = client.call('remove', timeout=timeout, **args)
            remaining.pop((offer, variant))
            remaining_fingerprints.pop((offer, variant))
            # Removal returns a cart; read it independently too. A successful
            # transport alone cannot release ownership after a partial clear.
            returned = m.Response(m.operation(service, 'cart'), result.http_status, result.data)
            after = client.cart(timeout=timeout)
            require(inventory(returned) == remaining and inventory(after) == remaining
                    and row_fingerprints(returned) == remaining_fingerprints
                    and row_fingerprints(after) == remaining_fingerprints,
                    'MARKETPLACE_CLEAR_READBACK_MISMATCH')
            expected_hash = after.digest
        j.abandon(cleanup_id)
    except Exception:
        if not j.inspect(cleanup_id)['operations']:
            j.abandon(cleanup_id)
        elif current_name is not None:
            j.observe(cleanup_id, current_name, outcome='UNKNOWN',
                      evidence_hash=j.digest({'reason': 'CLEAR_NOT_VERIFIED'}))
        raise
    return {'ok': True, 'flow_id': flow_id, 'cleanup_flow_id': cleanup_id, 'cart_empty': True,
            'financial_send': False, 'cart_mutation_sent': True}
