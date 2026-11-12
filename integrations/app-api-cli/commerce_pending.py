"""Same-basket reminders and explicit acknowledgement at the financial send boundary."""
from collections import defaultdict
import datetime as dt
import json
import re
import time

import commerce_journal as j
import order_card


def legacy_scopes(vertical, items, home, *, extra=None, use_current_cart=False):
    """Compare old opaque scopes without changing any historical record or card default."""
    scopes = {}
    for card in ('2342', '9546'):
        if vertical in ('main','supermall'):
            base = {'sku': items[0]['sku_config'], 'qty':items[0]['quantity']} if len(items)==1 else {'items':[[r['sku_config'],r['quantity']] for r in items]}
            if vertical=='supermall':base['service']='supermall'
        elif vertical=='minutes':
            base={'skus':items,'extras':False}
        else:
            return {}
        base.update(home=home,card=card,quiet=True)
        variants=[base]
        if vertical=='minutes':
            variants=[{**base,**({'note':extra} if extra is not None else {}),**({'use_current_cart':True} if current else {})} for current in (False,True)]
        for variant in variants:scopes[j.digest(variant)]=card
    return scopes


def basket_hash(vertical, items):
    keys = {'main': 'sku_config', 'supermall': 'sku_config', 'nownow': 'product_code',
            'minutes': 'sku', 'food': 'itemCode'}
    if type(items) not in (list,tuple) or not items:
        j.fail('PENDING_BASKET_INVALID')
    quantities = defaultdict(int)
    for item in items:
        if type(item) is not dict:
            j.fail('PENDING_BASKET_INVALID')
        code = item.get(keys[vertical])
        quantity = item.get('quantity', item.get('qty', 1))
        if type(code) is not str or not code or type(quantity) is not int or quantity <= 0:
            j.fail('PENDING_BASKET_INVALID')
        quantities[code] += quantity
    if not quantities:
        j.fail('PENDING_BASKET_INVALID')
    return j.digest({'vertical': vertical, 'items': sorted(quantities.items())})


def register(flow_id, vertical, account_hash, items, *, card_last4=None, legacy=None):
    j._flow(flow_id)
    value = basket_hash(vertical, items)
    with j._db() as db:
        prior = db.execute('SELECT * FROM baskets WHERE flow_id=?', (flow_id,)).fetchone()
        if prior and (prior['vertical'], prior['account_hash'], prior['basket_hash']) != (vertical, account_hash, value):
            j.fail('PENDING_BASKET_CHANGED')
        db.execute('INSERT OR IGNORE INTO baskets VALUES (?,?,?,?,?,?,?,?)',
                   (flow_id, vertical, account_hash, value, card_last4 or order_card.LAST4, '[]', json.dumps(legacy or {}), None))
        if legacy:
            db.execute('UPDATE baskets SET legacy_scopes=? WHERE flow_id=?',(json.dumps(legacy),flow_id))


def _legacy(flow, current):
    # Retained reviews predate basket metadata. Never read a secret or rebuild a cart.
    path = j.ROOT / flow['vertical'] / (flow['id'] + '.json')
    try:
        state = json.loads(path.read_text())
        if type(state) is not dict or type(state.get('review',{})) is not dict:
            j.fail('PENDING_BASKET_INVALID')
        card = state.get('card_last4') or state.get('review',{}).get('card_last4')
        if type(card) is not str or re.fullmatch(r'[0-9]{4}',card) is None:
            j.fail('PENDING_BASKET_INVALID')
        items = state.get('items', state.get('rows'))
        return {'basket_hash': basket_hash(flow['vertical'], items),
                'card_last4': card}
    except (OSError, ValueError, KeyError, TypeError, j.JournalError):
        card = json.loads(current['legacy_scopes']).get(flow['scope_hash'])
        # Scope hashes cannot prove different items: they also bind item order,
        # address and notes. An unavailable legacy manifest is a possible match,
        # requiring only this flow's explicit acknowledgement, never account release.
        return {'basket_hash':current['basket_hash'],'card_last4':card,
                'identity_uncertain': card is None}


def matching(db, current, *, now=None):
    now = time.time() if now is None else now
    rows = db.execute("""SELECT f.* FROM flows f WHERE app='noon' AND account_hash=?
        AND vertical=? AND id!=? AND created_at>=? AND state IN ('ACTIVE','FENCED')
        AND (EXISTS (SELECT 1 FROM operations o WHERE o.flow_id=f.id AND o.state='MAY_HAVE_SENT'
             AND o.kind IN ('place','payment','preauthorize','prepay'))
          OR EXISTS (SELECT 1 FROM observations o WHERE o.flow_id=f.id AND o.outcome='CHALLENGE_REQUIRED')
          OR (f.state='ACTIVE' AND EXISTS (SELECT 1 FROM operations o WHERE o.flow_id=f.id
              AND o.kind IN ('place','payment','preauthorize','prepay'))
              AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.flow_id=f.id
                  AND o.outcome IN ('PAYMENT_REPORTED_SUCCESS','PREORDER_PAYMENT_CONFIRMED')))
          OR (f.state='FENCED' AND EXISTS (SELECT 1 FROM operations o WHERE o.flow_id=f.id
              AND o.kind IN ('place','payment','preauthorize','prepay')))) ORDER BY created_at""",
        (current['account_hash'], current['vertical'], current['flow_id'], now - 48 * 3600)).fetchall()
    warnings = []
    for flow in rows:
        prior = db.execute('SELECT * FROM baskets WHERE flow_id=?', (flow['id'],)).fetchone()
        prior = prior or _legacy(flow, current)
        if not prior or prior['basket_hash'] != current['basket_hash']:
            continue
        started = dt.datetime.fromtimestamp(flow['created_at'], dt.timezone(dt.timedelta(hours=4))).isoformat()
        card = prior['card_last4'] or 'unknown'
        approval = prior.get('approval_minor') if isinstance(prior,dict) else prior['approval_minor']
        verification = db.execute("SELECT 1 FROM operations WHERE flow_id=? AND kind='prepay'",(flow['id'],)).fetchone()
        amount = approval if approval is not None else None if verification else flow['reserved_minor']
        amount_text = f'AED {amount/100:.2f}' if amount is not None else 'an unknown amount'
        warnings.append({'warning': 'SAME_BASKET_PENDING', 'flow_id': flow['id'],
            'card_last4': card, 'amount_minor': amount, 'basket_minor':flow['reserved_minor'], 'started_at': started,
            'basket_match': 'unresolved_legacy_manifest' if isinstance(prior,dict) and prior.get('identity_uncertain') else 'same_items',
            'message': f'an approval for {amount_text} on card ••{card} from {started} may still be pending; decline it in your bank app if you see it'})
    return warnings


def warnings(flow_id):
    with j._db() as db:
        current = db.execute('SELECT * FROM baskets WHERE flow_id=?', (flow_id,)).fetchone()
        return matching(db, current) if current else []


def acknowledge(flow_id, pending_ids):
    pending_ids = pending_ids or []
    for pending in pending_ids:
        j._flow(pending)
    with j._db() as db:
        db.execute('UPDATE baskets SET acknowledgements=? WHERE flow_id=?', (json.dumps(pending_ids), flow_id))


def require_acknowledged(db, flow):
    current = db.execute('SELECT * FROM baskets WHERE flow_id=?', (flow['id'],)).fetchone()
    if current is None:
        return  # Historical flows retain their existing send/ownership guards.
    pending = matching(db, current)
    acknowledged = json.loads(current['acknowledgements'])
    missing = [w for w in pending if w['flow_id'] not in acknowledged]
    if missing:
        raise j.PaymentError('SAME_BASKET_PENDING_ACK_REQUIRED',
                             {'warnings': missing, 'financial_send': False, 'financial_retry': False})


def cli_review(flow, args):
    lane = getattr(args, 'order_command', None)
    account = getattr(flow, 'account_hash', None)
    if lane == 'minutes':
        account = flow.snapshot.account_ref
    if lane == 'food':
        account = flow.account
    items = getattr(flow, 'skus' if lane == 'minutes' else 'rows' if lane == 'food' else 'items', None)
    if lane in ('main','supermall','nownow','minutes','food') and type(items) in (list,tuple) and j._hash(account):
        home = flow.home.address_ref if lane == 'food' else flow.snapshot.address_ref
        legacy = legacy_scopes(lane,items,home,extra=getattr(flow,'driver_note_extra',None),use_current_cart=getattr(flow,'use_current_cart',False))
        register(flow.flow_id, lane, account, items, legacy=legacy)
    if lane in ('main','supermall','minutes') and j._hash(account):
        refresh_legacy(lane,account)
    acknowledge(flow.flow_id, getattr(args, 'ack_pending', None))
    pending = warnings(flow.flow_id)
    if pending:
        print(json.dumps({'flow_id': flow.flow_id, 'warnings': pending}), flush=True)
    return pending


def record_approval(flow_id, wire):
    from noon_minutes_checkout import amount_minor
    if wire.get('amount') is None:
        return
    amount = amount_minor(wire['amount'])
    if amount <= 0:
        j.fail('PENDING_APPROVAL_AMOUNT_INVALID')
    with j._db() as db:
        db.execute('UPDATE baskets SET approval_minor=? WHERE flow_id=?',(amount,flow_id))


def refresh_legacy(vertical, account):
    """Backfill old placed flows from exact native merchandise, before the send lock."""
    with j._db() as db:
        rows = db.execute("""SELECT f.* FROM flows f LEFT JOIN baskets b ON b.flow_id=f.id
            WHERE f.app='noon' AND f.vertical=? AND f.account_hash=? AND f.created_at>=?
            AND f.state IN ('ACTIVE','FENCED') AND b.flow_id IS NULL AND f.order_id IS NOT NULL""",
            (vertical,account,time.time()-48*3600)).fetchall()
    if not rows:
        return
    from commerce_auth_status import CommerceAuth
    from noon_order_details import details
    snapshot = CommerceAuth().noon.revalidate('main' if vertical=='supermall' else vertical)
    if snapshot.account_ref != account:
        j.fail('RECOVERY_ACCOUNT_CHANGED')
    key = 'sku' if vertical=='minutes' else 'sku_config'
    for row in rows:
        native = details(row['order_id'],vertical)
        if (native.get('order') != row['order_id'] or native.get('account_verified') is not True
                or native.get('items_complete') is not True):
            j.fail('PENDING_LEGACY_BASKET_EVIDENCE_INVALID')
        items = [{key:r['item_code'] if vertical=='minutes' else r['sku_config'],'quantity':r['qty']} for r in native['items']]
        candidates = legacy_scopes(vertical,items,snapshot.address_ref)
        card = native.get('card_last4') or candidates.get(row['scope_hash']) or 'unknown'
        register(row['id'],vertical,account,items,card_last4=card)
