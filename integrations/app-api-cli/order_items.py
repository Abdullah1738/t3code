"""Compare placed basket lines with authoritative tracker snapshots."""
from decimal import Decimal, InvalidOperation
import hashlib
import unicodedata

import toollog

ID_FIELDS = ('item_id', 'item_code', 'sku', 'sku_config')


def name(item):
    return ' '.join(str(item.get('name') or item.get('title') or item.get('product_name') or '').split())


def identity(item):
    fields = match_fields(item)
    return next((fields[field] for field in ID_FIELDS if field in fields), normalized_name(item))


def legacy_identity(item):
    return str(item.get('item_id') or item.get('sku') or item.get('sku_config') or name(item).casefold())


def normalized_name(item):
    chars = []
    for char in unicodedata.normalize('NFKC', name(item)):
        code = ord(char)
        category = unicodedata.category(char)
        if (category in ('So', 'Sk', 'Cs', 'Co') or 0xFE00 <= code <= 0xFE0F
                or code == 0x200D or 0x1F3FB <= code <= 0x1F3FF):
            continue
        chars.append(' ' if category.startswith('P') else char)
    return ' '.join(''.join(chars).split()).casefold() or name(item).casefold()


def match_fields(item):
    # Registration stores delivery_cards.text(value, 80); native reads must use the same form.
    fields = {field: value for field in ID_FIELDS
              if (value := ' '.join(str(item.get(field) or '').split())[:80])}
    if name(item) and not item.get('unresolved'):
        fields['name'] = normalized_name(item)
    return fields


def matched_field(original, current):
    old, new = match_fields(original), match_fields(current)
    for field in (*ID_FIELDS, 'name'):
        if field in old and field in new:
            return field if old[field] == new[field] else None
    return None


def same_item(original, current):
    return matched_field(original, current) is not None


def price(item):
    try:
        value = item.get('line_total') if item.get('line_total') is not None else item.get('price', item.get('unit_price'))
        if value is None and item.get('price_minor') is not None:
            value = Decimal(str(item['price_minor'])) / 100
        value = Decimal(str(value))
        return value if value.is_finite() else None
    except (ValueError, TypeError, InvalidOperation):
        return None


def dropped(result, state, cfg):
    baseline = state.setdefault('placed_items', cfg.get('placed_items') or (cfg.get('card_meta') or {}).get('items') or [])
    rows = result.get('items')
    if rows is None:
        rows = result.get('manifest_items')
    complete = result.get('items_complete') is True or result.get('manifest_complete') is True
    if not baseline and complete and rows:
        baseline.extend(rows)
    seen = state.setdefault('dropped_items_seen', [])
    candidates = list(result.get('dropped_items') or [])
    matched_by = dict.fromkeys((*ID_FIELDS, 'name'), 0)
    comparisons = [(original, [(item, field) for item in (rows or [])
                              if (field := matched_field(original, item))]) for original in baseline]
    no_overlap = bool(rows) and bool(baseline) and not any(matches for _, matches in comparisons)
    absent_count = 0
    if rows is not None:
        for original, matches in comparisons:
            if matches:
                matched_by[matches[0][1]] += 1
            current = matches[0][0] if len(matches) == 1 else None
            # Completeness cannot prove absence when an ID-only manifest might
            # contain a line from the name-only card basket (or vice versa).
            comparable = any(all(field in match_fields(item) for item in rows) for field in match_fields(original))
            absent = not matches and complete and comparable
            absent_count += int(absent)
            # A wholly disjoint manifest cannot establish that this basket vanished.
            removed = absent and not no_overlap
            if current is not None:
                removed = (str(current.get('status', '')).lower() in ('removed', 'cancelled', 'canceled', 'unavailable')
                           or (price(current) == 0 and price(original) is not None and price(original) > 0))
            if removed:
                candidates.append(original)
    events = []
    for item in candidates:
        original = next((old for old in baseline if same_item(old, item)), item)
        key = identity(original)
        if not key or key in seen or legacy_identity(original) in seen:
            continue
        seen.append(key)
        amount = price(original)
        money = f' ({cfg.get("currency", "AED")} {amount:.2f})' if amount is not None else ''
        notice = 'item-dropped-' + hashlib.sha256(key.encode()).hexdigest()[:16]
        events.append({'kind': 'item_dropped', 'item': name(original) or key,
                       'amount': str(amount) if amount is not None else None,
                       'requester': cfg.get('for', 'owner'), 'chat': cfg.get('chat') or cfg.get('for', 'owner'),
                       'notice_key': cfg['watcher'] + '-' + notice,
                       'message': f'{cfg.get("merchant") or cfg["app"]} removed {name(original) or key}{money}; want me to get it elsewhere?'})
    toollog.emit('order-watch', 'order_watch.item_drop_check',
                 ids={'watcher': cfg.get('watcher')},
                 props={'app': cfg['app'], 'baseline_count': len(baseline), 'row_count': len(rows or []),
                        'complete': complete, 'matched_by': matched_by, 'absent_count': absent_count,
                        'emitted_count': len(events), 'suppressed_reason': 'no_overlap' if no_overlap else None})
    return events
