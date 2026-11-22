"""Local terminal imports and metadata repairs; no polling or delivery side effects."""
import argparse
from contextlib import ExitStack
from copy import deepcopy
from decimal import Decimal, InvalidOperation
import fcntl
import hashlib
import json
import os

import amazon_checkout
import order_identity
import toollog


def metadata(tracker, cfg, args):
    if args.amount is not None:
        try:
            amount = Decimal(args.amount)
            if not amount.is_finite() or amount <= 0 or amount != amount.quantize(Decimal('.01')):
                raise ValueError('amount must be positive with at most two decimal places')
        except InvalidOperation as exc:
            raise ValueError('amount must be a number') from exc
        amount = format(amount, '.2f')
        cfg.update(amount=amount, total='AED ' + amount, currency='AED')
        cfg.setdefault('card_meta', {}).update(total=amount, currency='AED')
    if args.items_file:
        source = json.loads(tracker.Path(args.items_file).read_text())
        rows = source if isinstance(source, list) else source.get('items') if isinstance(source, dict) else None
        if not isinstance(rows, list) or not rows or any(not isinstance(row, dict) for row in rows):
            raise ValueError('items-file must contain a nonempty item array')
        items = tracker.delivery_cards.items(rows)
        if len(items) != len(rows) or any(item['unresolved'] or item['qty'] <= 0 for item in items):
            raise ValueError('Every item needs a name and a positive integer quantity')
        cfg.setdefault('card_meta', {})['items'] = items
        cfg['placed_items'] = deepcopy(items)


def members(tracker, order, requested):
    ids = {order, *requested}
    while True:
        configs = {oid: tracker.read(amazon_checkout.config_path(tracker, oid)) for oid in sorted(ids)}
        expanded = ids | {oid for cfg in configs.values() for oid in cfg.get('siblings', [])}
        if expanded == ids:
            return configs
        ids = {order_identity.order_id('amazon', oid) for oid in expanded}


def import_plan(tracker, args, configs):
    cfg = deepcopy(configs[args.order])
    state = amazon_checkout.order_state(tracker, cfg)
    if cfg and (cfg.get('active', True) or not tracker.terminal_order(cfg, state.get('last_result', {}))):
        raise ValueError('Order is already tracked and active or lacks terminal proof')
    if cfg and state['last_result']['status'] != args.status:
        raise ValueError('Imported status conflicts with existing terminal proof')
    if (tracker.WATCHERS / order_identity.tracker_id('amazon', args.order) / 'watcher.json').exists():
        raise ValueError('Order still has a watcher; retire it before importing')
    stored = [c for c in configs.values() if c]
    if any(c.get('for') != args.recipient for c in stored):
        raise ValueError('Amazon checkout requester conflicts with an existing tracker')
    chats = {tracker.chat_of(c) for c in stored}
    if len(chats) > 1 or (args.chat and chats and args.chat not in chats):
        raise ValueError('Amazon checkout trackers have conflicting chats')
    requested = args.chat or os.environ.get('ORDER_WATCH_CHAT') or tracker.cwd_chat()
    if requested and not tracker.known_chat(requested):
        if args.chat:
            raise ValueError('Requested chat is unavailable')
        requested = None
    chat = next(iter(chats), None) or requested or tracker.default_chat(args.recipient)
    if chat != tracker.default_chat(args.recipient) and not tracker.known_chat(chat):
        raise ValueError('Amazon checkout existing chat is unavailable')
    wid = order_identity.tracker_id('amazon', args.order)
    now = tracker.stamp()
    cfg = cfg or {'app': 'amazon', 'order': args.order, 'watcher': wid, 'for': args.recipient,
                  'placed_at': args.placed_at or args.at, 'registered_at': now, 'eta': None}
    cfg.update(active=False, chat=chat, retired_at=now,
               terminal_import={'status': args.status, 'at': args.at, 'evidence': args.evidence})
    if args.card:
        cfg['card_last4'] = args.card
    metadata(tracker, cfg, args)
    state = deepcopy(state)
    proof = {'stage': args.status, 'scope': 'order', 'source': 'terminal_import',
             'evidence_at': args.at, 'evidence': args.evidence}
    result = deepcopy(state.get('last_result')) or {
        'app': 'amazon', 'order': args.order, 'status': args.status, 'whole_order_complete': True,
        'source': 'terminal_import', 'checked_at': now, 'evidence_at': args.at, 'errors': []}
    if proof not in result.setdefault('evidence', []):
        result['evidence'].append(proof)
    state.update(status=args.status, primed=True, last_result=result)
    state.setdefault('terminal_at', tracker.epoch(args.at))
    configs = deepcopy(configs)
    configs[args.order] = cfg
    states = {oid: amazon_checkout.order_state(tracker, c) for oid, c in configs.items() if c}
    states[args.order] = state
    if len(configs) > 1:
        ids = sorted(configs)
        checkout_id = 'amazon-checkout-' + hashlib.sha256('|'.join(ids).encode()).hexdigest()[:24]
        group = {'order_ids': ids}
        leader = amazon_checkout.select_leader(tracker, group, args.order)
        results = {oid: s.get('card_result') or s.get('last_result', {}) for oid, s in states.items()}
        terminal = all(c and tracker.terminal_order(c, results.get(oid, {}))
                       for oid, c in configs.items())
        status = ('cancelled' if all(r.get('status') == 'cancelled'
                                   for r in results.values()) else 'delivered') if terminal else min(
            (results.get(oid, {}) for oid, c in configs.items()
             if not c or not tracker.terminal_order(c, results.get(oid, {}))),
            key=lambda r: tracker.RANK.get(r.get('status'), -1)).get('status', 'unknown')
        projection = {'status': status, 'whole_order_complete': terminal,
                      'checkout': checkout_id, 'checkout_terminal': terminal}
        for oid, member in configs.items():
            if not member:
                continue
            member.update(checkout=checkout_id, siblings=ids, checkout_leader=leader)
            saved = states[oid]
            saved.update(checkout=checkout_id, siblings=ids, checkout_terminal=terminal)
            if saved.get('last_result'):
                saved['last_result']['checkout_result'] = deepcopy(projection)
    archive = tracker.WATCHERS.parent / 'archive'
    target = archive / (wid + '-import-terminal')
    existing_path = amazon_checkout.order_state_path(tracker, configs[args.order])
    state_path = existing_path or target / 'order-tracker-state.json'
    writes = {str(amazon_checkout.config_path(tracker, oid)): c for oid, c in configs.items() if c}
    for oid, saved in states.items():
        path = state_path if oid == args.order else amazon_checkout.order_state_path(tracker, configs[oid])
        if path:
            writes[str(path)] = saved
    if not existing_path:
        if (tracker.WATCHERS / wid).exists() or target.exists() or (archive / 'retired' / (wid + '.json')).exists():
            raise ValueError('Order has existing watcher or archive state; reconcile it before importing')
        writes[str(archive / 'retired' / (wid + '.json'))] = {'archived': str(target), 'at': now}
    return writes


def main(tracker, argv):
    command = argv[0]
    parser = argparse.ArgumentParser(prog='order-watch ' + command,
                                    description='Already-delivered orders: import terminal proof or correct metadata silently.')
    parser.add_argument('--app', required=True, choices=['amazon'])
    parser.add_argument('--order', required=True)
    parser.add_argument('--amount', required=command == 'set-meta')
    parser.add_argument('--items-file', required=command == 'set-meta')
    parser.add_argument('--dry-run', action='store_true', help='print exact file contents; write nothing')
    if command == 'import-terminal':
        parser.add_argument('--for', dest='recipient', choices=['owner', 'moni'], required=True)
        parser.add_argument('--chat')
        parser.add_argument('--status', required=True)
        parser.add_argument('--at', required=True)
        parser.add_argument('--evidence', required=True)
        parser.add_argument('--placed-at')
        parser.add_argument('--card')
        parser.add_argument('--checkout-order', action='append', default=[])
    args = parser.parse_args(argv[1:])
    event = 'track.import_terminal' if command == 'import-terminal' else 'track.meta_corrected'
    try:
        args.order = order_identity.order_id('amazon', args.order)
        if command == 'import-terminal':
            if args.status not in tracker.TERMINAL:
                raise ValueError('status must be delivered or cancelled')
            tracker.epoch(args.at)
            if args.placed_at and tracker.epoch(args.placed_at) > tracker.epoch(args.at):
                raise ValueError('placed-at must not be after the terminal time')
            if not args.evidence.strip():
                raise ValueError('evidence must be nonempty')
            if args.card and not tracker.re.fullmatch(r'\d{4}', args.card):
                raise ValueError('card needs four digits')
            if args.chat and not tracker.CHAT_RE.fullmatch(args.chat):
                raise ValueError('Invalid --chat')
            args.checkout_order = [order_identity.order_id('amazon', oid) for oid in args.checkout_order]
        path = amazon_checkout.config_path(tracker, args.order)
        if not args.dry_run:
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with ExitStack() as stack:
            configs = members(tracker, args.order, args.checkout_order) if command == 'import-terminal' else {}
            # Discovery holds a sibling's state lock while registering missing
            # orders. Acquire states before registration to avoid that cycle.
            paths = {amazon_checkout.order_state_path(tracker, c) for c in configs.values() if c}
            if not args.dry_run:
                for state_path in sorted(p for p in paths if p):
                    lock = stack.enter_context((state_path.parent / 'order-tracker.lock').open('a'))
                    fcntl.flock(lock, fcntl.LOCK_EX)
                registration = stack.enter_context(path.with_suffix('.registration.lock').open('a'))
                fcntl.flock(registration, fcntl.LOCK_EX)
                bank = stack.enter_context((tracker.ROOT / 'bank-charge.lock').open('a'))
                fcntl.flock(bank, fcntl.LOCK_EX)
            if command == 'import-terminal':
                current = members(tracker, args.order, args.checkout_order)
                if current != configs or paths != {amazon_checkout.order_state_path(tracker, c) for c in current.values() if c}:
                    raise ValueError('Checkout changed during import; retry with fresh state')
                writes = import_plan(tracker, args, current)
                props = {'merchant': 'amazon', 'state': args.status}
            else:
                cfg = tracker.read(path)
                if not cfg:
                    raise ValueError('Register the order first')
                old_amount = cfg.get('amount')
                metadata(tracker, cfg, args)
                cfg['metadata_revision'] = cfg.get('metadata_revision', 0) + 1
                props = {'merchant': 'amazon', 'newAmountMinor': int(Decimal(cfg['amount']) * 100)}
                if old_amount is not None:
                    props['oldAmountMinor'] = int(Decimal(str(old_amount)) * 100)
                writes = {str(path): cfg}
            if not args.dry_run:
                for filename, content in writes.items():
                    tracker.write(tracker.Path(filename), content)
                toollog.emit('order-watch', event, ok=True, ids={'orderId': args.order}, props=props)
                if command == 'import-terminal' and len(current) > 1:
                    toollog.emit('order-watch', 'checkout.sibling_link', ok=True, ids={'orderId': args.order},
                                 props={'merchant': 'amazon', 'count': len(current)})
        print(json.dumps({'ok': True, 'dry_run': args.dry_run, 'writes': writes}, indent=2))
        return 0
    except (ValueError, OSError, InvalidOperation) as exc:
        if not args.dry_run:
            toollog.emit('order-watch', event, kind='error', ok=False, ids={'orderId': args.order},
                         props={'merchant': 'amazon'}, error='TERMINAL_REPAIR_REFUSED')
        print(json.dumps({'ok': False, 'error': str(exc)}))
        return 1
