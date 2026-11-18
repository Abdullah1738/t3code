"""Amazon checkout registration and combined-card projection.

Orders retain their own identity, bank amount and delivery proof. Checkout
completion is derived from every member; it never replaces per-order evidence.
"""
from copy import deepcopy
from contextlib import redirect_stdout
from decimal import Decimal
import fcntl
import io
import json
import os

import order_identity
import toollog


def config_path(tracker, order):
    return tracker.ROOT / 'orders' / (order_identity.tracker_id('amazon', order) + '.json')


def link_order(tracker, order, checkout):
    path = config_path(tracker, order)
    # Use write_order's config lock and reread inside it: a removal, notice or
    # routing update committed since discovery began must survive this link.
    with (tracker.ROOT / 'bank-charge.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = tracker.read(path)
        if current:
            apply(current, checkout)
            tracker.write(path, current)
        return current


def order_state(tracker, cfg):
    wid = cfg.get('watcher')
    if not wid:
        return {}
    state = tracker.read(tracker.WATCHERS / wid / 'order-tracker-state.json')
    if state:
        return state
    # robob-watch moves terminal watcher directories; its retired index is the
    # durable pointer used by removal as well as expiry.
    archive = tracker.WATCHERS.parent / 'archive'
    retired = tracker.read(archive / 'retired' / (wid + '.json'))
    target = tracker.Path(retired.get('archived', ''))
    if target.parent.resolve() == archive.resolve() and target.name.startswith(wid + '-'):
        return tracker.read(target / 'order-tracker-state.json')
    return {}


def select_leader(tracker, checkout, preferred):
    configs = [tracker.read(config_path(tracker, oid)) for oid in checkout['order_ids']]
    for cfg in configs:
        if cfg.get('checkout_leader') in checkout['order_ids']:
            return cfg['checkout_leader']
    existing = [cfg for cfg in configs if cfg]
    existing.sort(key=lambda cfg: (cfg.get('registered_at', ''), cfg['order']))
    for cfg in existing:
        card = tracker.read(tracker.ROOT / 'cards' / (cfg['watcher'] + '.json'))
        if card.get('url') or card.get('send_args'):
            return cfg['order']
    return existing[0]['order'] if existing else preferred


def log(name, order, checkout, **props):
    toollog.emit('order-watch', 'track.' + name, ids={'orderId': order, 'watcher': checkout},
                 props={'merchant': 'amazon', **props})


def strip_options(argv, names):
    out, skip = [], False
    for arg in argv:
        if skip:
            skip = False
        elif arg.split('=', 1)[0] in names:
            skip = '=' not in arg
        else:
            out.append(arg)
    return out


def add(tracker, args, argv, order_ids):
    from amazon_email_orders import track
    try:
        mail = track(order_ids[0], since=(args.placed_at or tracker.stamp())[:10], timeout=35)
    except (RuntimeError, OSError, ValueError, tracker.subprocess.TimeoutExpired):
        mail = {}
    checkout = mail.get('checkout')
    if not checkout or len(checkout['order_ids']) < 2:
        if len(order_ids) > 1:
            raise ValueError('Amazon multi-order registration needs a complete confirmation email')
        return None
    if (mail.get('errors') or not checkout.get('complete')
            or not set(order_ids) <= set(checkout['order_ids'])
            or any(row.get('currency') != 'AED' for row in checkout['orders'])):
        log('checkout_mismatch', order_ids[0], checkout['id'], count=len(order_ids))
        raise ValueError('Amazon checkout confirmation is incomplete or conflicts with requested orders')
    if args.dry_run_text:
        print(json.dumps({'checkout': checkout, 'dry_run': True}))
        return 0
    tracker.ROOT.mkdir(parents=True, exist_ok=True)
    with (tracker.ROOT / (checkout['id'] + '.lock')).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        checkout = {**checkout, 'leader': select_leader(tracker, checkout, order_ids[0])}
        leader = checkout['leader']
        chats = set()
        for oid in checkout['order_ids']:
            stored = tracker.read(config_path(tracker, oid))
            if stored:
                chats.add(tracker.chat_of(stored))
            if stored and (stored.get('for') != args.recipient or
                           (args.chat and tracker.chat_of(stored) != args.chat)):
                log('checkout_mismatch', oid, checkout['id'])
                raise ValueError('Amazon checkout requester conflicts with an existing tracker')
        if len(chats) > 1:
            log('checkout_mismatch', order_ids[0], checkout['id'])
            raise ValueError('Amazon checkout trackers have conflicting chats')
        requested = args.chat or os.environ.get('ORDER_WATCH_CHAT') or tracker.cwd_chat()
        if requested and not tracker.known_chat(requested):
            print(json.dumps({'warning': 'chat_unknown_using_default', 'chat': requested}))
            requested = None
        # Existing routing wins over ambient shell/chat context, as it does for
        # a single-order retry. Pass it explicitly so new members cannot drift.
        chat = next(iter(chats), None) or requested or tracker.default_chat(args.recipient)
        if chat != tracker.default_chat(args.recipient) and not tracker.known_chat(chat):
            log('checkout_mismatch', order_ids[0], checkout['id'])
            raise ValueError('Amazon checkout existing chat is unavailable')
        base = strip_options(argv, {'--order', '--order-id', '--amount', '--total', '--items-file',
                                    '--card-items-json', '--chat', '--card-chat'}) + ['--chat', chat]
        # Registration primes cannot send. Enroll the combined placement last,
        # after every member has a watcher and its own payment metadata.
        sequence = [oid for oid in checkout['order_ids'] if oid != leader] + [leader]
        codes = []
        for oid in sequence:
            row = next(r for r in checkout['orders'] if r['order'] == oid)
            stored = tracker.read(config_path(tracker, oid))
            if stored.get('active') is False and tracker.terminal_order(stored, order_state(tracker, stored).get('last_result', {})):
                link_order(tracker, oid, checkout)
                log('checkout_link', oid, checkout['id'], count=len(checkout['order_ids']))
                continue
            member = [*base, '--order', oid]
            if isinstance(args.card, str):
                member += ['--amount', row['amount']]
            if oid != leader:
                member = [a for a in member if a != '--no-placed-text']
                member = strip_options(member, {'--placed-text'})
                member += ['--no-placed-text', '--no-card-send']
            codes.append(tracker.main(member, _checkout=checkout))
            if codes[-1] not in (None, 0, tracker.NOTICE_FAILED_EXIT):
                return codes[-1]
        print(json.dumps({'checkout': checkout['id'], 'orders': checkout['order_ids'],
                          'watcher_registered': all(config_path(tracker, oid).exists() and
                              (tracker.WATCHERS / order_identity.tracker_id('amazon', oid) / 'watcher.json').exists()
                              for oid in checkout['order_ids'])}))
        return max((code or 0 for code in codes), default=0)


def apply(cfg, checkout):
    row = next(row for row in checkout['orders'] if row['order'] == cfg['order'])
    if cfg.get('amount') and Decimal(cfg['amount']) != Decimal(row['amount']):
        log('checkout_mismatch', cfg['order'], checkout['id'])
    cfg.update(checkout=checkout['id'], siblings=checkout['order_ids'],
               checkout_leader=checkout.get('leader', checkout['order_ids'][0]), amount=row['amount'],
               total='AED ' + row['amount'], currency=row['currency'])
    cfg.setdefault('card_meta', {}).update(items=row['items'], total=row['amount'], currency=row['currency'])
    # A caller may have passed the whole basket as the placed manifest.
    cfg['placed_items'] = deepcopy(row['items'])


def discover(tracker, cfg, mail):
    """Repair a known checkout only during a real watcher check, never scratch."""
    checkout = mail.get('checkout')
    if not checkout or len(checkout['order_ids']) < 2 or mail.get('errors') or not checkout.get('complete'):
        return
    if any(row.get('currency') != 'AED' for row in checkout['orders']):
        return
    folder = os.environ.get('WATCH_DIR')
    if (not folder or tracker.Path(folder).resolve() != (tracker.WATCHERS / cfg['watcher']).resolve()
            or os.environ.get('WATCH_RUN', '').startswith('prime-')):
        return
    with (tracker.ROOT / (checkout['id'] + '.lock')).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        checkout = {**checkout, 'leader': select_leader(tracker, checkout, cfg['order'])}
        _discover(tracker, cfg, checkout)


def _discover(tracker, cfg, checkout):
    for oid in checkout['order_ids']:
        path = config_path(tracker, oid)
        stored = tracker.read(path)
        if stored and (stored.get('for') != cfg['for'] or tracker.chat_of(stored) != tracker.chat_of(cfg)):
            log('checkout_mismatch', oid, checkout['id'])
            return
    for oid in checkout['order_ids']:
        path = config_path(tracker, oid)
        stored = tracker.read(path)
        watch = tracker.WATCHERS / order_identity.tracker_id('amazon', oid) / 'watcher.json'
        if stored.get('checkout') == checkout['id'] and (watch.exists() or stored.get('active') is False):
            continue
        if stored and (watch.exists() or stored.get('active') is False):
            # Linking an existing watcher does not change its card suppression,
            # notice receipt or active state, and never retries placement.
            link_order(tracker, oid, checkout)
            log('checkout_link', oid, checkout['id'], count=len(checkout['order_ids']))
            continue
        member = ['add', '--app', 'amazon', '--order', oid, '--for', cfg['for'], '--chat', tracker.chat_of(cfg),
                  '--placed-at', cfg['placed_at'], '--no-placed-text', '--no-card-send', '--source', 'email']
        if cfg.get('card_last4'):
            row = next(r for r in checkout['orders'] if r['order'] == oid)
            member += ['--card', cfg['card_last4'], '--amount', row['amount']]
        if cfg.get('eta'):
            member += ['--eta', cfg['eta']]
        # robob-watch treats stdout as an event. Registration receipts are not
        # arrival evidence and must never wake the recipient thread.
        with redirect_stdout(io.StringIO()):
            tracker.main(member, _checkout=checkout)
        if not stored:
            log('checkout_auto_add', oid, checkout['id'])
    cfg.update(tracker.read(config_path(tracker, cfg['order'])))


def summary(tracker, cfg, current=None):
    ids = cfg.get('siblings') or [cfg['order']]
    members, results = [], []
    for oid in ids:
        member = tracker.read(config_path(tracker, oid))
        state = order_state(tracker, member)
        result = state.get('card_result') or state.get('last_result', {})
        if oid == cfg['order'] and current is not None and not tracker.terminal_order(member, result):
            if (tracker.terminal_order(member, current) or
                    tracker.RANK.get(current.get('status'), -1) >= tracker.RANK.get(result.get('status'), -1)):
                result = current
        members.append(member)
        results.append(result)
    terminal = all(member and tracker.terminal_order(member, result) for member, result in zip(members, results))
    active = [r for m, r in zip(members, results) if not m or not tracker.terminal_order(m, r)]
    status = ('cancelled' if all(r.get('status') == 'cancelled' for r in results) else 'delivered') if terminal else min(
        active, key=lambda r: tracker.RANK.get(r.get('status'), -1)).get('status', 'unknown')
    return members, {'status': status, 'whole_order_complete': terminal,
                     'checkout': cfg.get('checkout'), 'checkout_terminal': terminal}


def card_key(cfg):
    if cfg.get('app') == 'amazon' and cfg.get('checkout'):
        return order_identity.tracker_id('amazon', cfg['checkout_leader'])
    return cfg['watcher']


def remember_card_terminal(cfg, data, state, now):
    if cfg.get('app') != 'amazon' or not cfg.get('checkout'):
        return
    if data.get('checkout_terminal'):
        if state.get('checkout_terminal_id') != cfg['checkout']:
            state['terminal_at'] = now
        state.update(checkout_terminal_id=cfg['checkout'], checkout_terminal_status=data['status'])
        state.setdefault('terminal_at', now)
    else:
        # A delivered legacy order can become the shared card for an active
        # checkout. Its former completion time cannot retire the combined link.
        for key in ('terminal_at', 'checkout_terminal_id', 'checkout_terminal_status'):
            state.pop(key, None)


def card_view(cfg, data, retained=None):
    import order_tracker as tracker
    if cfg.get('app') != 'amazon' or not cfg.get('checkout'):
        return cfg, data
    members, result = summary(tracker, cfg, data)
    leader = next((m for m in members if m.get('order') == cfg['checkout_leader']), None)
    if not leader:
        return cfg, {**data, 'status': 'unknown', 'whole_order_complete': False}
    view = deepcopy(leader)
    view['card_meta'] = {'items': [item for m in members for item in m.get('card_meta', {}).get('items', [])],
                         'total': str(sum((Decimal(m.get('amount') or '0') for m in members), Decimal('0'))),
                         'currency': 'AED', 'store': 'Amazon'}
    view['total'] = 'AED ' + view['card_meta']['total']
    view['amount'] = view['card_meta']['total']
    if (retained and retained.get('checkout_terminal_id') == cfg['checkout']
            and retained.get('checkout_terminal_status') in tracker.TERMINAL):
        result.update(status=retained['checkout_terminal_status'], whole_order_complete=True, checkout_terminal=True)
    return view, {**data, **result, 'last_confirmed_status': result['status']}
