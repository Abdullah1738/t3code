"""Read-only Talabat order lines resolved against the vendor's live menu.

Order lines come from the authenticated exact-order tracking screen
(`order_details` in the layout-referenced `tlb_app_bff_passthrough` widget):
name, quantity, the server's comma-joined choices label and the item note.
Each line is matched by name on the branch's native menu (menubff v4) for its
description; customizable items read the choices sheet (menubff v3) so each
chosen option name resolves to its catalog option. Calories/macros are parsed
from the published description or option name text only; nothing is estimated.
No cart, order, payment or watcher operation is performed.
"""
import argparse
import datetime as dt
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import talabat_http_orders as http

# A trailing multiplier ("Protein 2x") is a portion count, never a gram value.
NUM = r'(\d{1,4}(?:\.\d{1,2})?)(?!\s*[x×*]|\d)'
_KCAL = [re.compile(r'(?<![A-Za-z])(?:k?cal(?:ories)?)\s*[:=]?\s*' + NUM + r'(?![\d.])', re.I),
         re.compile(NUM + r'\s*k?cal(?:ories)?\b', re.I)]
_MACROS = {
    'protein_g': [re.compile(NUM + r'g?P(?![A-Za-z:])'),
                  re.compile(r'(?<![A-Za-z])P(?:rotein)?\s*[:=]?\s*' + NUM + r'\s*g?(?![\d.])'),
                  re.compile(r'(?<![A-Za-z])protein\s*[:=]?\s*' + NUM, re.I),
                  re.compile(NUM + r'\s*g\s*protein\b', re.I)],
    'carbs_g': [re.compile(NUM + r'g?C(?![A-Za-z:])'),
                re.compile(r'(?<![A-Za-z])C(?:arbs?|arbohydrates?)?\s*[:=]?\s*' + NUM + r'\s*g?(?![\d.])'),
                re.compile(r'(?<![A-Za-z])carb(?:s|ohydrates?)?\s*[:=]?\s*' + NUM, re.I),
                re.compile(NUM + r'\s*g\s*carb(?:s|ohydrates?)?\b', re.I)],
    'fat_g': [re.compile(NUM + r'g?F(?![A-Za-z:])'),
              re.compile(r'(?<![A-Za-z])F(?:ats?)?\s*[:=]?\s*' + NUM + r'\s*g?(?![\d.])'),
              re.compile(r'(?<![A-Za-z])(?:healthy\s+)?fats?\s*[:=]?\s*' + NUM, re.I),
              re.compile(NUM + r'\s*g\s*fats?\b', re.I)],
}
FIELDS = ('kcal', 'protein_g', 'carbs_g', 'fat_g')


def _num(text):
    value = float(text)
    return int(value) if value.is_integer() else value


def parse_macros(*texts):
    """First published value per field across texts, in priority order."""
    out = {k: None for k in FIELDS}
    for text in texts:
        if not isinstance(text, str) or not text:
            continue
        for field, patterns in (('kcal', _KCAL), *_MACROS.items()):
            if out[field] is not None:
                continue
            hits = [m for p in patterns for m in [p.search(text)] if m]
            if hits:
                out[field] = _num(min(hits, key=lambda m: m.start()).group(1))
    return out if any(v is not None for v in out.values()) else None


def norm(name):
    text = re.sub(r'<[^>]+>', ' ', str(name or '')).casefold()
    text = re.sub(r'[^\w%.]+', ' ', text, flags=re.UNICODE).replace('_', ' ')
    return re.sub(r'\s+', ' ', text).strip(' .')


# ------------------------------------------------------------------ order lines

def _safe(value, limit=600):
    if isinstance(value, str) and len(value) <= limit and all(ord(c) >= 32 or c in '\n\t' for c in value):
        return value
    return None


def order_lines(data, order):
    """Layout-referenced order_details only; templates are never searched."""
    layouts, widgets = data.get('layouts'), data.get('widgets')
    if not isinstance(layouts, list) or not isinstance(widgets, dict):
        raise http.TalabatError('ORDER_DETAILS_SCHEMA_CHANGED')
    referenced = {key for layout in layouts if isinstance(layout, dict) and layout.get('name') == 'body'
                  for key in (layout.get('column') if isinstance(layout.get('column'), list) else [])}
    widget = widgets.get('tlb_app_bff_passthrough')
    if 'tlb_app_bff_passthrough' not in referenced or not isinstance(widget, dict):
        raise http.TalabatError('ORDER_DETAILS_UNAVAILABLE')
    children = http._props(http._data(widget).get('component')).get('children')
    found = [c for c in (children if isinstance(children, list) else [])
             if isinstance(c, dict) and c.get('template_id') == 'order_details']
    if len(found) != 1:
        raise http.TalabatError('ORDER_DETAILS_UNAVAILABLE')
    props = http._props(found[0])
    shop = str(props.get('shop_id') or '')
    if not re.fullmatch(r'[1-9][0-9]{0,15}', shop) or not isinstance(props.get('items'), list):
        raise http.TalabatError('ORDER_DETAILS_SCHEMA_CHANGED')
    lines = []
    for row in props['items']:
        p = http._props(row)
        qty = p.get('quantity')
        if not isinstance(row, dict) or row.get('template_id') != 'order_item' or type(qty) is not int or qty < 1:
            raise http.TalabatError('ORDER_DETAILS_SCHEMA_CHANGED')
        choices = _safe(p.get('choices'))
        lines.append({'name': _safe(p.get('name'), 300) or '', 'quantity': qty,
                      'choices_text': choices.strip() if choices else None,
                      'note': _safe(p.get('special_request'), 1000) if p.get('has_special_request') is True else None})
    return {'order': order, 'branch_id': int(shop), 'chain_id': _safe(str(props.get('chain_id') or ''), 20) or None,
            'vendor_name': _safe(props.get('vendor_name'), 200),
            'order_note': _safe(props.get('special_requests_descriptor'), 1000) if props.get('has_special_requests') is True else None,
            'lines': lines}


def read_order(order, deadline):
    def operation(saved, end):
        data = http.request(http.TRACKING + order, saved, end)
        tracked = http.project(data, order)  # exact order-ID echo + status
        return tracked, order_lines(data, order)
    return http.read_with_renewal(operation, deadline)


# ------------------------------------------------------------------ menu resolution

def menu_items(menu_raw):
    try:
        sections = menu_raw['menu']['result']['menu']['menuSection']
    except (KeyError, TypeError):
        raise http.TalabatError('MENU_SCHEMA_INVALID') from None
    rows = []
    for section in sections if isinstance(sections, list) else []:
        for item in (section.get('itm') or []) if isinstance(section, dict) else []:
            if isinstance(item, dict) and type(item.get('id')) is int and isinstance(item.get('nm'), str):
                rows.append({'id': item['id'], 'name': item['nm'], 'description': (item.get('dsc') or '').strip(),
                             'price': item.get('pr'), 'customizable': item.get('icc') is True,
                             'category': section.get('nm')})
    return rows


def match_item(name, rows):
    key = norm(name)
    if not key:
        return None, 'unnamed_order_line', []
    exact = [r for r in rows if norm(r['name']) == key]
    how = 'exact_name'
    if not exact:
        exact = [r for r in rows if norm(r['name']) and (key.startswith(norm(r['name'])) or norm(r['name']).startswith(key))]
        how = 'name_prefix'
    if not exact:
        return None, 'not_on_current_menu', []
    # The same id/description cross-listed in several sections is one item.
    distinct = {(r['name'], r['description']) for r in exact}
    if len(distinct) > 1:
        return None, 'ambiguous_name', exact
    return exact[0], how, exact


def option_index(sections, path=()):
    out = []
    for s in sections:
        for o in s.get('options', ()):
            out.append({'option_id': o['option_id'], 'name': o['name'], 'section': s['name'],
                        'price_minor': o.get('price_minor'), 'path': path})
            out += option_index(o.get('sub_categories') or (), path + (o['name'],))
    return out


def resolve_choices(text, options):
    """Split the server label on ', ' and greedily rejoin to exact option names."""
    if not text:
        return []
    by_name = {}
    for o in options:
        by_name.setdefault(norm(o['name']), []).append(o)
    parts = [p for p in text.split(', ')]
    out, i = [], 0
    while i < len(parts):
        for j in range(len(parts), i, -1):
            label = ', '.join(parts[i:j]).strip()
            hits = by_name.get(norm(label))
            if hits:
                out.append({'label': label, 'resolved': True, 'ambiguous': len({h['option_id'] for h in hits}) > 1,
                            'option_id': hits[0]['option_id'], 'option_name': hits[0]['name'],
                            'section': hits[0]['section'], 'parent': list(hits[0]['path']) or None,
                            'price_minor': hits[0]['price_minor'], 'macros': parse_macros(hits[0]['name'])})
                i = j
                break
        else:
            label = parts[i].strip()
            # e.g. "Iced Latte Large": product name prefixed to the option label.
            suffix = [o for o in options if norm(o['name']) and norm(label).endswith(' ' + norm(o['name']))]
            if len({o['option_id'] for o in suffix}) == 1:
                o = suffix[0]
                out.append({'label': label, 'resolved': True, 'ambiguous': False, 'option_id': o['option_id'],
                            'option_name': o['name'], 'section': o['section'], 'parent': list(o['path']) or None,
                            'price_minor': o['price_minor'], 'macros': parse_macros(o['name']), 'match': 'label_suffix'})
            else:
                out.append({'label': label, 'resolved': False, 'macros': parse_macros(label)})
            i += 1
    return out


class Menu:
    """Guest native catalog reads (menubff v4 menu + v3 choices) under one deadline."""

    def __init__(self, deadline):
        import talabat_native as native
        from talabat_menu_choices import parse_choices
        self.native, self.parse_choices, self.deadline = native, parse_choices, deadline
        self.tb = native.Talabat(None, max(1, int(http.remaining_time(deadline))))
        self.tb.deadline = deadline

    def items(self, branch):
        raw = self.tb.menu_raw(branch)
        try:
            vendor = raw['vendor']['result']['restaurant']
        except (KeyError, TypeError):
            vendor = {}
        if vendor.get('bid') not in (None, branch):
            raise http.TalabatError('RESTAURANT_BRANCH_MISMATCH')
        return menu_items(raw), vendor.get('na') or vendor.get('name')

    def choices(self, branch, item_id):
        from dataclasses import asdict
        native = self.native
        t = native.template_for(self.tb.saved, lambda p: bool(native.MENU.fullmatch(p)))
        data = native.request(t, self.tb.budget(), path=f'/menubff/v3/branches/{branch}/menu/{item_id}/choices',
                              params={'countryId': 4, 'areaId': 1308, 'latitude': native.HOME_LAT,
                                      'longitude': native.HOME_LNG, 'source': '', 'isProUser': 'false'})
        return [asdict(s) for s in self.parse_choices(data, item_id).sections]


def _add(total, macros, factor, missing, label):
    for field in FIELDS:
        value = (macros or {}).get(field)
        if value is None:
            missing.add(f'{label}:{field}')
        else:
            total[field] = round((total[field] or 0) + value * factor, 2)


def resolve(lines_info, menu):
    branch = lines_info['branch_id']
    out_lines, total, missing = [], {k: None for k in FIELDS}, set()
    try:
        rows, _ = menu.items(branch)
        menu_error = None
    except Exception as exc:  # NativeError/TalabatError: keep order lines, flag resolution
        rows, menu_error = [], getattr(exc, 'code', None) or str(exc) or 'MENU_READ_FAILED'
    choice_cache = {}
    for line in lines_info['lines']:
        item, how, candidates = match_item(line['name'], rows) if rows else (None, 'menu_unavailable', [])
        entry = {**line, 'resolved': item is not None, 'match': how, 'menu_item_id': None,
                 'menu_name': None, 'description': None, 'category': None, 'macros': None, 'choices': []}
        if how == 'ambiguous_name':
            entry['candidates'] = [{'menu_item_id': c['id'], 'menu_name': c['name'], 'description': c['description']}
                                   for c in candidates[:5]]
        options = []
        if item:
            entry.update(menu_item_id=item['id'], menu_name=item['name'], description=item['description'] or None,
                         category=item['category'], macros=parse_macros(item['description'], item['name']))
            if line['choices_text'] and item['customizable']:
                if item['id'] not in choice_cache:
                    try:
                        choice_cache[item['id']] = option_index(menu.choices(branch, item['id']))
                    except Exception as exc:
                        choice_cache[item['id']] = getattr(exc, 'code', None) or str(exc) or 'CHOICES_READ_FAILED'
                options = choice_cache[item['id']]
                if isinstance(options, str):
                    entry['choices_error'], options = options, []
        if line['choices_text']:
            entry['choices'] = resolve_choices(line['choices_text'], options)
        label = line['name'] or 'unnamed'
        if entry['resolved']:
            _add(total, entry['macros'], line['quantity'], missing, label)
        else:
            missing.add(f'{label}:unresolved')
        for choice in entry['choices']:
            if choice.get('macros'):
                _add(total, choice['macros'], line['quantity'], set(), label)
        out_lines.append(entry)
    return out_lines, total, sorted(missing), menu_error


def order_items(order, timeout=30):
    if not isinstance(order, str) or not re.fullmatch(r'[0-9]{1,20}', order):
        raise http.TalabatError('INVALID_ORDER_ID')
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 5 <= timeout <= 90:
        raise http.TalabatError('INVALID_TIMEOUT')
    deadline = time.monotonic() + timeout
    tracked, info = read_order(order, deadline)
    with http.read_deadline(deadline):
        lines, total, missing, menu_error = resolve(info, Menu(deadline))
    return {'ok': True, 'app': 'talabat', 'order': order, 'source': 'native_order_api+native_menu',
            'order_source': 'order_tracking.order_details', 'menu_source': 'native_android_guest_menu',
            'status': tracked['status'], 'raw_status': tracked['raw_status'],
            'profile_verified': True, 'order_id_verified': True,
            **{key: tracked.get(key) for key in ('delivery_address', 'is_home', 'home_match_reason')},
            'vendor_name': info['vendor_name'], 'branch_id': info['branch_id'], 'chain_id': info['chain_id'],
            'order_note': info['order_note'], 'items': lines,
            'totals': {**total, 'complete': not missing, 'missing': missing,
                       'basis': 'published menu text x quantity, plus chosen options that publish values'},
            'menu_error': menu_error, 'read_only': True, 'cart_mutation': False, 'financial_send': False,
            'checked_at': dt.datetime.now(dt.timezone.utc).isoformat()}


def _fmt(m):
    if not m:
        return 'no published macros'
    if all(m.get(k) is None for k in FIELDS):
        return 'no published macros'
    labels = (('kcal', 'Cal ', ''), ('protein_g', 'P', 'g'), ('carbs_g', 'C', 'g'), ('fat_g', 'F', 'g'))
    return ' '.join(f'{p}{m[k]}{s}' for k, p, s in labels if m.get(k) is not None)


def summary(result):
    if not result.get('ok'):
        return f"talabat order-items failed: {result.get('error')}"
    rows = [f"{result['vendor_name']} (branch {result['branch_id']}), order {result['order']} - {result['status']}"]
    for line in result['items']:
        rows.append(f"{line['quantity']}x {line['menu_name'] or line['name'] or '(unnamed)'}: {_fmt(line['macros'])}"
                    + ('' if line['resolved'] else f" [unresolved: {line['match']}]"))
        if line.get('description'):
            rows.append(f"   {line['description']}")
        for c in line['choices']:
            rows.append(f"   + {c['label']}: " + (_fmt(c.get('macros')) if c.get('macros') else
                        ('no published macros' if c['resolved'] else 'not matched to menu option')))
        if line.get('note'):
            rows.append(f"   note: {line['note']}")
    if result.get('order_note'):
        rows.append(f"Order note: {result['order_note']}")
    t = result['totals']
    rows.append('Total: ' + _fmt(t) + ('' if t['complete'] else f" (incomplete: {', '.join(t['missing'])})"))
    return '\n'.join(rows)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('order')
    parser.add_argument('--timeout', type=float, default=30)
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    try:
        result = order_items(args.order, args.timeout)
    except http.TalabatError as exc:
        result = {'ok': False, 'app': 'talabat', 'order': args.order, 'error': str(exc)}
    except Exception as exc:
        result = {'ok': False, 'app': 'talabat', 'order': args.order,
                  'error': getattr(exc, 'code', None) or 'ORDER_ITEMS_READ_FAILED'}
    print(json.dumps(result, indent=2, ensure_ascii=False) if args.json else summary(result))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
