"""Journalled whole-cart Minutes edit: read the cart, or replace it with a basket file.

`show` is read-only. `set_cart` sends exactly one full-manifest sync after a fresh
readback proves the cart still matches the hash the caller read with `show`.
It never orders, pays or places; ordering stays with `order minutes`.
"""
import hashlib
import time
import uuid

import commerce_journal as j
import noon_minutes_checkout as m
import noon_minutes_options as options
from commerce_minutes import _rows, readback_active_orders, readback_session
from noon_auth_lifecycle import NoonAuthLifecycle
from noon_checkout import AccountHome

def _sorted_row(sku, qty, modifiers):
    return {'sku': sku, 'qty': qty, 'modifiers': sorted(modifiers)}


def manifest(lines):
    """Normal (non-freebie) cart lines as sorted {sku, qty, modifiers} rows."""
    rows = []
    for line in lines:
        if line.get('is_freebie') is True:
            continue
        rows.append(_sorted_row(line['sku'], line['quantity'], line['modifiers']))
    return sorted(rows, key=lambda r: (r['sku'], r['qty'], tuple(r['modifiers'])))


def manifest_hash(rows):
    key = sorted((r['sku'], r['qty'], tuple(sorted(r['modifiers']))) for r in rows)
    return hashlib.sha256(m._json([[sku, qty, list(mods)] for sku, qty, mods in key])).hexdigest()


def _special_count(lines):
    return sum(1 for line in lines if line.get('is_freebie') is not True and
               (line.get('bundle_present') or line.get('deal_code') or
                line.get('cart_line_type') not in (None, 'normal')))


def _titles(lines):
    return {line['sku']: line.get('title') for line in lines if line.get('is_freebie') is not True}


def show(*, auth=None):
    auth = auth or NoonAuthLifecycle()
    session = readback_session(auth)
    lines = session.projection['lines']
    rows = manifest(lines)
    titles = _titles(lines)
    items = [{**row, 'title': titles.get(row['sku'])} for row in rows]
    freebies = [{'sku': line['sku'], 'title': line.get('title'), 'quantity': line['quantity']}
                for line in lines if line.get('is_freebie') is True]
    return {'ok': True, 'items': items, 'freebies': freebies,
            'special_lines': _special_count(lines), 'total_minor': session.projection.get('total_minor'),
            'cart_hash': manifest_hash(rows), 'financial_send': False, 'cart_mutation_sent': False}


def set_cart(rows, *, expect_hash, auth=None):
    m.require(isinstance(expect_hash, str) and expect_hash, 'MINUTES_CART_EXPECT_HASH_REQUIRED')
    queries = {row.get('sku'): row.get('catalog_query') for row in rows if isinstance(row, dict)}
    new_rows = m._skus(_rows(rows))
    m.require(new_rows and all(x['qty'] > 0 for x in new_rows), 'INVALID_QUANTITY')
    # Deal/ATC fields would reach the sync but not the manifest the readback is checked against.
    m.require(all(set(x) == {'sku', 'qty', 'modifiers'} for x in new_rows), 'MINUTES_CART_ROW_FIELDS_UNSUPPORTED')
    new_manifest = [_sorted_row(x['sku'], x['qty'], x['modifiers']) for x in new_rows]
    new_hash = manifest_hash(new_manifest)

    auth = auth or NoonAuthLifecycle()
    snapshot = auth.fresh_before_mutation('minutes')
    j.require_account_available('noon', snapshot.account_ref)
    m.require(readback_active_orders(auth).projection['count'] == 0, 'MINUTES_ACTIVE_ORDER_PRESENT')
    current = readback_session(auth)
    lines = current.projection['lines']
    m.require(_special_count(lines) == 0, 'MINUTES_CART_SPECIAL_LINES')
    current_rows = manifest(lines)
    if manifest_hash(current_rows) != expect_hash:
        j.fail('MINUTES_CART_CHANGED_SINCE_SHOW')
    if manifest_hash(current_rows) == new_hash:
        return {'ok': True, 'unchanged': True, 'cart_hash': new_hash,
                'financial_send': False, 'cart_mutation_sent': False}

    # Option codes are read only for rows not already in the cart as-is.
    current_keys = {(r['sku'], tuple(r['modifiers'])) for r in current_rows}
    for item in new_rows:
        if (item['sku'], tuple(sorted(item['modifiers']))) not in current_keys:
            catalog = options.read_options(item['sku'], query=queries.get(item['sku']), auth=auth)
            options.validate_selection(item, catalog)

    flow_id = str(uuid.uuid4())
    scope_hash = j.digest({'minutes_cart_set': new_hash, 'from': expect_hash})
    j.open_flow(flow_id=flow_id, app='noon', vertical='minutes',
                account_hash=snapshot.account_ref, scope_hash=scope_hash)

    body = {'skus': new_rows, 'bundles': [], 'refresh': False}
    request_hash = hashlib.sha256(m._json(body)).hexdigest()

    def headers(operation, deadline):
        nonlocal snapshot
        # Re-check the cart and the hash right before the mutation headers; a
        # cookie-rotating read must come before the fresh headers, as in clear_cart.
        m.require(readback_active_orders(auth).projection['count'] == 0, 'MINUTES_ACTIVE_ORDER_PRESENT')
        verify = readback_session(auth)
        if manifest_hash(manifest(verify.projection['lines'])) != expect_hash:
            j.fail('MINUTES_CART_CHANGED_SINCE_SHOW')
        fresh = auth.fresh_before_mutation('minutes', deadline=deadline)
        m.require((fresh.account_ref, fresh.address_ref) == (snapshot.account_ref, snapshot.address_ref),
                  'MINUTES_ACCOUNT_HOME_CHANGED')
        snapshot = fresh
        return fresh.mutation_headers('minutes')

    def before(operation, digest):
        m.require(operation == 'sync' and digest == request_hash, 'MINUTES_CART_REQUEST_NOT_BOUND')
        return j.consume(flow_id, 'minutes_cart_set', kind='cart', request_hash=digest)

    def receipt(record):
        j.observe(flow_id, 'minutes_cart_set', outcome=record['outcome'], evidence_hash=record['evidence_hash'])
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
        result = client.sync(skus=new_rows, bundles=[], refresh=False, before_send=before, timeout=25)
        after = readback_session(auth)
        m.review_manifest(after.projection['lines'], new_manifest, mismatch='MINUTES_CART_SET_VERIFY_MISMATCH')
        j.abandon(flow_id)
    except Exception:
        # A consumed send keeps the fence; never auto-retry a cart write.
        if not j.inspect(flow_id)['operations']:
            j.abandon(flow_id)
        else:
            raise j.JournalError('MINUTES_CART_SET_OUTCOME_UNVERIFIED: after the send, run '
                                 "'commerce cart minutes show' to confirm the cart, then "
                                 "'commerce abandon-flow " + flow_id + "' to free the account.") from None
        raise
    return {'ok': True, 'flow_id': flow_id, 'items': new_manifest,
            'cart_hash': new_hash, 'total_minor': result.projection.get('total_minor'),
            'cart_mutation_sent': True, 'financial_send': False}
