"""Read-only evidence for rejected Talabat submissions; never resend a checkout."""
import datetime as dt
import time
from collections import Counter

import commerce_journal as journal
import commerce_receipts as receipts
from commerce_auth_status import CommerceAuth
from commerce_flow import account_hash
import talabat_http_checkout as h
import talabat_http_list as history
import talabat_order_items as order_items


REASON = 'DUPLICATE_ORDER_ERROR_NO_RETRY'
NEXT_ACTION = ('Talabat blocked this checkout as similar to a recent order. The request will never be resent. '
               'Run commerce reconcile-order FLOW --close-duplicate for a fresh authenticated history check. '
               'After closure, get the caller\'s explicit go for a new flow; for genuinely different items '
               'use --allow-duplicate-of ORDER_ID. Otherwise wait or use the app after reconciliation.')


def eligible(binding, local, snapshot, *, legacy_attested=False):
    placed = [r for r in snapshot.receipts if r.operation == 'place']
    return (binding['app'] == 'talabat' and local['order_id'] is None and len(placed) == 1
            and (placed[0].state == 'REJECTED_DUPLICATE'
                 or legacy_attested and placed[0].state == 'SUBMISSION_UNKNOWN')
            and placed[0].reason == REASON and placed[0].http_status == 400
            and not any(r.order_id or r.transaction_id or r.context for r in snapshot.receipts)
            and sum(o['kind'] == 'place' for o in local['operations']) == 1
            and all(o['state'] == 'OBSERVED' and o['kind'] not in ('payment','preauthorize','prepay')
                    for o in local['operations']))


def complete_history(saved, deadline):
    result = history._list_orders(saved, deadline, 0, history.MAX_PAGES, history.PAGE_SIZE * history.MAX_PAGES)
    if (result.get('ok') is not True or result.get('account_verified') is not True
            or result.get('truncated') is not False or result['pagination']['snapshot_changed']
            or result['pagination']['duplicates_omitted']):
        journal.fail('DUPLICATE_HISTORY_INCOMPLETE')
    return result


def exact_lines(saved, order, deadline):
    data = h.orders.request(h.orders.TRACKING + order, saved, deadline)
    tracked = h.orders.project(data, order)
    if tracked.get('order') != order or tracked.get('identity_verified') is not True:
        journal.fail('DUPLICATE_EXACT_ORDER_REQUIRED')
    info = order_items.order_lines(data, order)
    if not info['lines'] or any(not x['name'] for x in info['lines']):
        journal.fail('DUPLICATE_ORDER_ITEMS_UNAVAILABLE')
    return info


def _names(lines):
    result = Counter()
    for row in lines:
        if type(row.get('name')) is not str or not row['name'].strip() or type(row.get('quantity')) is not int or row['quantity'] < 1:
            journal.fail('DUPLICATE_ITEM_EVIDENCE_INVALID')
        result[order_items.norm(row['name'])] += row['quantity']
    return result


def _cart(saved, binding, snapshot, deadline, references=()):
    """Reconstruct the retained intent from the exact owned cart, not a current cart."""
    from commerce_talabat import intent_scope
    import talabat_restaurant_cart as restaurant
    created = [r for r in snapshot.receipts if r.operation == 'create_cart' and r.state == 'SUCCEEDED']
    if binding['vertical'] != 'restaurants' or len(created) != 1 or not created[0].cart_id:
        journal.fail('DUPLICATE_RESTAURANT_CART_REQUIRED')
    cart_id = created[0].cart_id
    response = h._wire(saved, deadline, 'GET', '/cart/v1/' + cart_id, params={'hasOutstandingPayments':'false'})
    if response.status != 200:journal.fail('DUPLICATE_CART_READ_FAILED')
    data = response.data
    try:
        branch = data['branchInfo']['restaurant']['branchId']
        rows = data['cart']['items']
        items = []
        for row in rows:
            _, details, _ = restaurant.choices_echo(row)
            choices = tuple((cid, d['quantity'], tuple(c['id'] for c in d.get('subChoicesDetails', [])))
                            for cid, d in details.items())
            items.append(h.Item(row['menuItemId'], row['quantity'], row.get('specialRequest') or '', choices))
        items = tuple(items)
        restaurant.project_cart(data, cart_id=cart_id, branch_id=branch, items=items)
        bound = (restaurant.manifest_digest(branch,items) == created[0].manifest_sha256
                 if created[0].manifest_sha256 is not None else
                 any(intent_scope('restaurants', branch, items, reference) == binding['scope_hash']
                     for reference in (None, *references)))
        if not bound:
            journal.fail('DUPLICATE_CART_INTENT_CHANGED')
        names = _names(rows)
    except (KeyError, TypeError, ValueError):
        journal.fail('DUPLICATE_CART_EVIDENCE_INVALID')
    return branch, names


def close_duplicate(flow_id, *, auth=None, wait_for_history=False,
                    separate_order=None, separate_after=None, separate_evidence=None,
                    legacy_rejection_evidence=None):
    # A matching order is never silently attributed to this rejected request.
    # An explicit caller-provided independent-placement record may exclude one
    # exact order, with fresh identity/items/date evidence retained in the audit.
    separate = None
    if legacy_rejection_evidence is not None and (
            type(legacy_rejection_evidence) is not str or not 20 <= len(legacy_rejection_evidence.strip()) <= 4096
            or any(ord(c)<32 for c in legacy_rejection_evidence)):
        journal.fail('DUPLICATE_LEGACY_REJECTION_EVIDENCE_REQUIRED')
    if any(x is not None for x in (separate_order, separate_after, separate_evidence)):
        import re
        if (type(separate_order) is not str or not re.fullmatch(r'[0-9]{1,20}',separate_order)
                or type(separate_after) is not str or type(separate_evidence) is not str
                or not 10 <= len(separate_evidence.strip()) <= 4096
                or any(ord(c)<32 for c in separate_evidence)):
            journal.fail('DUPLICATE_SEPARATE_ORDER_EVIDENCE_REQUIRED')
        try:
            stamp = dt.datetime.fromisoformat(separate_after)
            if stamp.tzinfo is None:raise ValueError()
            separate = {'order':separate_order,'after':stamp.timestamp(),'evidence':separate_evidence}
        except ValueError:journal.fail('DUPLICATE_SEPARATE_ORDER_TIME_INVALID')
    binding = journal.binding(flow_id)
    local = journal.inspect(flow_id)
    if local['state'] == journal.REJECTED_DUPLICATE:
        return {'ok':True, 'flow_id':flow_id, 'state':journal.REJECTED_DUPLICATE,
                'account_fence_lifted':True, 'already_closed':True, 'financial_send':False, 'financial_retry':False}
    store = receipts.load(**binding)
    snapshot = store.snapshot()
    if local['state'] != 'FENCED' or not eligible(binding, local, snapshot,
                                                legacy_attested=legacy_rejection_evidence is not None):
        journal.fail('DUPLICATE_REJECTION_EVIDENCE_REQUIRED')
    rejected_at = journal.place_observed_at(flow_id)
    if separate is not None and not rejected_at < separate['after'] <= time.time():
        journal.fail('DUPLICATE_SEPARATE_ORDER_TIME_INVALID')
    # Include the entire attempt window, not just orders dated after the response.
    since = journal.flow_created_at(flow_id) - 120
    remaining = 30 - (time.time() - rejected_at)
    if wait_for_history and 0 < remaining <= 30:
        time.sleep(remaining)
    if time.time() - rejected_at < 30:
        journal.fail('DUPLICATE_HISTORY_SETTLING_RECHECK_AFTER_30_SECONDS')
    auth = auth or CommerceAuth()
    saved = auth.fresh_before_mutation('talabat', binding['vertical']).mutation_account(binding['vertical'])
    if account_hash(saved) != binding['account_hash']:journal.fail('RECOVERY_ACCOUNT_CHANGED')
    deadline = h.auth.new_deadline(60)
    first = complete_history(saved, deadline)
    branch, names = _cart(saved, binding, snapshot, deadline, [r['order'] for r in first['orders']])
    checked = []
    separate_verified = None
    for row in first['orders']:
        # Unknown branch/date is not absence. Native delivery_date is only used
        # to exclude records already dated before this flow's whole send window.
        if row.get('branch_id') is None:journal.fail('DUPLICATE_HISTORY_BRANCH_UNKNOWN')
        if row['branch_id'] != branch:continue
        stamp = row.get('native_delivery_date')
        if not stamp:journal.fail('DUPLICATE_HISTORY_DATE_UNKNOWN')
        if dt.datetime.fromisoformat(stamp).timestamp() < since:continue
        info = exact_lines(saved, row['order'], deadline)
        if info['branch_id'] != branch:journal.fail('DUPLICATE_HISTORY_BRANCH_MISMATCH')
        # Ignore note/choice differences deliberately: uncertain variants block
        # closure rather than incorrectly proving absence.
        if _names(info['lines']) == names:
            if (separate is None or row['order'] != separate['order']
                    or dt.datetime.fromisoformat(stamp).timestamp() < separate['after']):
                journal.fail('DUPLICATE_MATCHING_ORDER_REQUIRES_RECONCILIATION')
            separate_verified = {**separate,'native_delivery_date':stamp,'items_hash':journal.digest(info['lines'])}
        checked.append({'order':row['order'], 'items_hash':journal.digest(info['lines'])})
    if separate is not None and separate_verified is None:
        journal.fail('DUPLICATE_SEPARATE_ORDER_NOT_VERIFIED')
    second = complete_history(saved, deadline)
    if first['orders'] != second['orders'] or first['total_orders'] != second['total_orders']:
        journal.fail('DUPLICATE_HISTORY_CHANGED')
    evidence = {'binding':binding, 'rejected_at':rejected_at, 'window_start':since,
                'checked_at':second['checked_at'], 'history_complete':True, 'matching_orders':[],
                'history_hash':journal.digest(second['orders']), 'history_count':second['total_orders'],
                'branch_id':branch, 'cart_items_hash':journal.digest(dict(names)), 'checked_orders':checked,
                'separately_placed_order':separate_verified,
                'legacy_rejection_attestation':legacy_rejection_evidence,
                'receipt_snapshot_hash':journal.digest([receipts._wire(r) for r in snapshot.receipts])}
    with store.locked_snapshot() as current:
        if current.receipts != snapshot.receipts:journal.fail('DUPLICATE_RECEIPTS_CHANGED')
        result = journal.close_rejected_duplicate(flow_id, evidence=evidence, expected_local=local)
    return {'ok':True, 'flow_id':flow_id, **result, 'financial_send':False, 'financial_retry':False,
            'purchase_confirmed':False, 'provider_no_charge_proven':False,
            'next_action':'Rejected checkout closed. A new flow needs the caller\'s explicit go; this flow cannot be retried.'}


def verify_override(saved, *, order, branch, items, menu, deadline):
    """Explicit reference + same account/vendor + provably different base items."""
    import re
    if type(order) is not str or not re.fullmatch(r'[0-9]{1,20}', order):
        journal.fail('DUPLICATE_REFERENCE_INVALID')
    listed = complete_history(saved, deadline)
    if not any(r['order'] == order and r.get('branch_id') == branch for r in listed['orders']):
        journal.fail('DUPLICATE_REFERENCE_ACCOUNT_OR_BRANCH_MISMATCH')
    info = exact_lines(saved, order, deadline)
    if info['branch_id'] != branch:journal.fail('DUPLICATE_REFERENCE_ACCOUNT_OR_BRANCH_MISMATCH')
    previous = set()
    for line in info['lines']:
        candidates = [entry.item_id for entry in menu.entries.values()
                      if order_items.norm(entry.name) == order_items.norm(line['name'])]
        if len(candidates) != 1:journal.fail('DUPLICATE_REFERENCE_ITEMS_UNRESOLVED')
        previous.add(candidates[0])
    if previous == {item.item_id for item in items}:
        journal.fail('DUPLICATE_OVERRIDE_ITEMS_NOT_DIFFERENT')
    return {'order':order, 'branch_id':branch, 'different_base_items_verified':True}
