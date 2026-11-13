"""Compare placed basket lines with authoritative tracker snapshots."""
from decimal import Decimal, InvalidOperation
import hashlib


def name(item):
    return ' '.join(str(item.get('name') or item.get('title') or item.get('product_name') or '').split())


def identity(item):
    return str(item.get('item_id') or item.get('sku') or item.get('sku_config') or name(item).casefold())


def match_fields(item):
    fields = {field: str(item[field]) for field in ('item_id', 'sku', 'sku_config') if item.get(field)}
    if name(item) and not item.get('unresolved'):
        fields['name'] = name(item).casefold()
    return fields


def same_item(original, current):
    old, new = match_fields(original), match_fields(current)
    for field in ('item_id', 'sku', 'sku_config', 'name'):
        if field in old and field in new:
            return old[field] == new[field]
    return False


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
    if rows is not None:
        for original in baseline:
            matches = [item for item in rows if same_item(original, item)]
            current = matches[0] if len(matches) == 1 else None
            # Completeness cannot prove absence when an ID-only manifest might
            # contain a line from the name-only card basket (or vice versa).
            comparable = any(all(field in match_fields(item) for item in rows) for field in match_fields(original))
            removed = not matches and complete and comparable
            if current is not None:
                removed = (str(current.get('status', '')).lower() in ('removed', 'cancelled', 'canceled', 'unavailable')
                           or (price(current) == 0 and price(original) is not None and price(original) > 0))
            if removed:
                candidates.append(original)
    events = []
    for item in candidates:
        original = next((old for old in baseline if same_item(old, item)), item)
        key = identity(original)
        if not key or key in seen:
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
    return events
