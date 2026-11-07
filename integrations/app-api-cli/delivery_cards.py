"""Delivery card projection, rendering and one idempotent placement notice.

Watcher checks supply already-read evidence. No polling process or merchant
request is started here. Only the allowlisted view is written to the web root.
"""
import argparse
from collections import Counter
import datetime as dt
import fcntl
import hashlib
import html
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
import time
import traceback
from urllib.parse import urlparse

APPS = Path.home() / '.local/share/imessage-apps'
ROOT = Path.home() / '.local/state/order-tracker'
WATCHERS = Path.home() / '.local/share/robob-watch/watchers'
ASSETS = Path(__file__).with_name('delivery-card-assets')
BUN = str(Path.home() / '.bun/bin/bun')
BRIDGE = str(Path.home() / '.local/share/spectrum-bridge/src/cli.ts')
DUBAI = dt.timezone(dt.timedelta(hours=4))
THEMES = {'noon': ('#feee00', '#16160f'), 'talabat': ('#ff5a00', '#201006'),
          'careem': ('#00df72', '#062c1b'), 'amazon': ('#ffb347', '#202326')}
LANES = {'noon': ('minutes', 'nownow', 'supermall', 'main', 'food', 'marketplace'),
         'talabat': ('restaurants', 'mart', 'shops'), 'careem': ('food', 'quik', 'shops', 'box'),
         'amazon': ('same-day',)}
NAMES = {'noon': 'noon', 'talabat': 'Talabat', 'careem': 'Careem', 'amazon': 'Amazon'}
LABELS = {'minutes': 'Minutes', 'nownow': 'NowNow', 'supermall': 'Supermall', 'main': 'Main',
          'marketplace': 'Marketplace',
          'restaurants': 'Food', 'mart': 'Mart', 'shops': 'Shops', 'food': 'Food',
          'quik': 'Quik', 'box': 'Box', 'same-day': 'Same-day'}


def read(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return {} if default is None else default


def atomic(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f'.{os.getpid()}.tmp')
    tmp.write_text(value if isinstance(value, str) else json.dumps(value, ensure_ascii=False))
    tmp.replace(path)


def text(value, limit=180):
    return ' '.join(str(value or '').split())[:limit]


def number(value):
    try:
        n = float(value)
        return n if math.isfinite(n) and n >= 0 else None
    except (ValueError, TypeError):
        return None


def amount(value):
    if isinstance(value, str):
        value = re.sub(r'^(?:AED|USD|EUR|GBP)\s*', '', value.strip(), flags=re.I).replace(',', '')
    return number(value)


def instant(value):
    try:
        at = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return at if at.tzinfo else None
    except ValueError:
        return None


def slug(app, order):
    base = re.sub('[^a-z0-9-]', '-', f'delivery-{app}-{order}'.lower())
    return base if len(base) <= 64 else base[:49] + '-' + hashlib.sha256(base.encode()).hexdigest()[:14]


def image_url(value):
    if not isinstance(value, str):
        return None
    u = urlparse(value)
    if u.scheme == 'https' and u.hostname and not u.username and not u.password:
        return value[:2048]
    # Local photos in an existing card, never file:// or path traversal.
    if not u.scheme and not u.netloc and not value.startswith('/') and '..' not in Path(value).parts:
        return value[:500]
    return None


def items(rows, *, private_notes=False):
    out = []
    for row in (rows or [])[:150]:
        if not isinstance(row, dict):
            continue
        name = text(row.get('name') or row.get('title') or row.get('productTitle') or row.get('product_name'))
        ident = text(row.get('sku') or row.get('sku_config') or row.get('skuConfig') or
                     row.get('item_id') or row.get('product_code') or row.get('productCode'), 80)
        qty = number(row.get('qty', row.get('quantity', 1)))
        if not qty or qty != int(qty):
            continue
        price = amount(row.get('price', row.get('unitPrice')))
        if price is None and row.get('price_minor') is not None:
            price = number(row['price_minor'])
            price = price / 100 if price is not None else None
        # Free-text notes are opt-in for the owner's private card only.
        # Talabat allows 600 characters; keep them all so two long labels that differ only
        # at the end stay different. The bubble trims at display time.
        detail = next((text(row[k], 600) for k in ('detail', 'choices_text', 'choicesString', 'choices')
                       if isinstance(row.get(k), str) and row[k].strip()), None)
        if private_notes and isinstance(row.get('notes'),str) and row['notes'].strip():
            detail=(detail+'; ' if detail else '')+'Note: '+text(row['notes'],500)
        out.append({'name': name or (f'Item {ident}' if ident else 'Item details pending'),
                    'unresolved': bool(row.get('unresolved') or not name), 'detail': detail,
                    'qty': int(qty), 'price': price, 'line_total': amount(row.get('line_total')),
                    'image': image_url(row.get('image_url') or row.get('image') or row.get('imageUrl'))})
    return out


def fill_details(rows, observed):
    """Add choices from the tracking read to stored rows that lack them.

    A choice is only attached when the pairing is certain: the open stored
    lines and the read's remaining lines agree in count and quantity, and
    either there is one of each or every read line has the same choices.
    Otherwise, when no stored line of that dish has choices yet, the read's
    own lines replace the dish's lines without per-line prices, so a variant
    is never shown next to another variant's price. A conflict (a stored
    variant the read shows with another quantity) leaves the dish as stored."""
    key = lambda i: i['name'].casefold()
    plan = {}
    for k in {key(r) for r in rows}:
        mine = [r for r in rows if key(r) == k]
        theirs = [i for i in observed if key(i) == k]
        if not any(i['detail'] for i in theirs):
            continue
        # Lines that already carry their choices claim the read line with the
        # same choices and quantity.
        conflict = False
        for r in mine:
            if not r.get('detail'):
                continue
            same = [i for i in theirs if (i['detail'] or '').casefold() == r['detail'].casefold()]
            hit = next((i for i in same if i['qty'] == r['qty']), None)
            if hit:
                theirs.remove(hit)
            elif same:
                conflict = True
        open_rows = [r for r in mine if not r.get('detail')]
        if (conflict or not open_rows or len(open_rows) != len(theirs)
                or sum(r['qty'] for r in open_rows) != sum(i['qty'] for i in theirs)):
            continue
        details = {i['detail'] for i in theirs}
        if len(details) == 1:
            if None not in details and sorted(r['qty'] for r in open_rows) == sorted(i['qty'] for i in theirs):
                plan[k] = ('fill', theirs[0]['detail'])
        elif len(open_rows) == len(mine):
            plan[k] = ('swap', theirs)
    out, swapped = [], set()
    for row in rows:
        k = key(row)
        how = plan.get(k)
        if not how or row.get('detail'):
            out.append(row)
        elif how[0] == 'fill':
            out.append({**row, 'detail': how[1]})
        elif k not in swapped:
            swapped.add(k)
            out.extend({**i, 'price': None, 'line_total': None} for i in how[1])
    return out


def choice_parts(detail):
    """A choices label split on its top-level commas, so "Half & Half (Chicken, Beef)" stays
    one choice. When brackets or quotes don't pair up, the label stays whole."""
    pairs = {')': '(', ']': '[', '}': '{', '”': '“'}
    parts, stack, quoted, start = [], [], False, 0
    for n, ch in enumerate(detail):
        if ch == '"':
            quoted = not quoted
        elif quoted:
            continue
        elif ch in '([{“':
            stack.append(ch)
        elif ch in pairs:
            if not stack or stack.pop() != pairs[ch]:
                return [detail]
        elif ch == ',' and not stack:
            parts.append(detail[start:n])
            start = n + 1
    if stack or quoted:
        return [detail]
    parts.append(detail[start:])
    return [p.strip() for p in parts if p.strip()] or [detail]


def picks(rows):
    """Bubble label for a dish ordered more than once. It leads with choices that set this line
    apart from every other variant of the dish, closest variant first, so the cut-off tail is
    what they share. Choices are counted, so a second "Cheese" is a difference. The full page
    keeps the server's order."""
    def key(part):
        return ' '.join(part.split()).casefold()
    groups = {}
    for i in rows:
        if i.get('detail'):
            groups.setdefault(i['name'].casefold(), []).append(Counter(map(key, choice_parts(i['detail']))))
    out = []
    for i in rows:
        pick = None
        if i.get('detail'):
            parts = choice_parts(i['detail'])
            mine = Counter(map(key, parts))
            # Identical lines can't be told apart anyway, and a line that holds all of this
            # one's choices and more doesn't say which of them matter, so neither counts.
            open_ = [d for d in (mine - other for other in groups[i['name'].casefold()]) if d]
            order = {}
            for n, p in enumerate(parts):
                order.setdefault(key(p), n)
            lead = []
            # Greedy cover: each variant still looking the same gets one of its differences
            # up front, the closest variants first, preferring a choice that splits off several.
            while open_:
                least = min(sum(d.values()) for d in open_)
                pool = {k for d in open_ if sum(d.values()) == least for k in d}
                k = min(pool, key=lambda k: (-sum(1 for d in open_ if d[k]), order[k]))
                lead.append(k)
                open_ = [d for d in open_ if not d[k]]
            if lead:
                used, first = set(), []
                for k in lead:
                    n = next(n for n, p in enumerate(parts) if n not in used and key(p) == k)
                    used.add(n)
                    first.append(parts[n])
                pick = text(', '.join(first + [p for n, p in enumerate(parts) if n not in used]), 160)
        out.append({**i, 'pick': pick} if pick else i)
    return out


def names(rows, limit=160):
    """Short item line for the bubble: one entry per dish, quantities merged."""
    counts = {}
    for i in rows:
        counts[i['name']] = counts.get(i['name'], 0) + i['qty']
    return text(' · '.join(f'{n} ×{q}' if q > 1 else n for n, q in counts.items()), limit)


def commerce_metadata(flow, vertical):
    """Project only display fields from the checkout already verified by its lane."""
    rows = []
    if vertical == 'minutes':
        if getattr(flow, 'card_recovered', False):
            return []  # A post-place session can belong to a newer basket.
        current = getattr(flow, 'current', None)
        rows = (getattr(current, 'wire', None) or {}).get('items', [])
        if not rows:
            rows = (getattr(current, 'projection', None) or {}).get('lines', [])
        # The payable total is verified, but unit-price discount semantics vary
        # across Minutes rows. Omit prices rather than label list prices as paid.
        rows = [{**r, 'price': None, 'price_minor': None} for r in rows]
    elif vertical == 'nownow':
        current = getattr(flow, 'current', None)
        rows = (getattr(current, 'wire', None) or {}).get('data', {}).get('products', [])
        rows = [{**r, 'price': None, 'line_total': amount(r.get('totalPrice'))} for r in rows]
    elif vertical in ('main', 'supermall'):
        response = getattr(flow, 'session_response', None)
        rows = [i for s in (getattr(response, 'data', None) or {}).get('shipments', [])
                for i in s.get('items', [])]
        catalog = getattr(flow, 'card_catalog', {})
        rows = [{**r, 'title': r.get('title') or catalog.get(r.get('skuConfig'), {}).get('title'),
                 'image_url': r.get('image_url') or catalog.get(r.get('skuConfig'), {}).get('image_url')}
                for r in rows]
    else:
        checkout = getattr(flow, 'checkout', None)
        quote = getattr(checkout, 'quote', None)
        if quote is not None:
            quoted = json.loads(quote.response).get('checkout', {}).get('cart', {}).get('items', [])
            # Already validated against the exact manifest. Native row totals
            # can include discounts/options; do not reconstruct those prices.
            rows = [{**r, 'line_total': amount(r.get('total'))} for r in quoted]
        menu = getattr(checkout, '_menu_index', None)
        if not rows:
            for i in getattr(flow, 'items', []):
                m = menu.get(i.item_id) if menu else None
                rows.append({'item_id': i.item_id, 'quantity': i.quantity,
                             'name': getattr(m, 'name', None)})
    from catalog_schema import image
    if vertical in ('minutes', 'main', 'supermall'):
        rows = [{**r, 'image_url': image(r, 'https://f.nooncdn.com/p/')} for r in rows]
    return items(rows)


def commerce_args(flow, vertical):
    # Presentation must never turn a successful payment into a failed purchase.
    try:
        return ['--vertical', vertical, '--card-items-json', json.dumps(commerce_metadata(flow, vertical))]
    except (AttributeError, TypeError, ValueError, KeyError):
        return ['--vertical', vertical]


def lane(cfg, meta):
    app = cfg['app']
    value = meta.get('vertical') or cfg.get('vertical')
    if value in LANES[app]:
        return value
    words = (str(meta.get('store', '')) + ' ' + cfg.get('label', '')).lower()
    for v in LANES[app]:
        if re.search(r'\b' + re.escape(v) + r'\b', words):
            return v
    if app == 'noon':
        order = cfg['order'].upper()
        return 'nownow' if order.startswith('NN') else 'food' if order.startswith('F') else 'marketplace' if order.startswith('N') else 'minutes'
    # Unknown Careem/Talabat vertical must not invent a food/grocery stage.
    return 'same-day' if app == 'amazon' else ''


def stage(data, food=False):
    steps = ['Confirmed', 'Preparing', 'Picked up', 'On the way', 'Delivered'] if food else [
        'Confirmed', 'Packed', 'Out for delivery', 'Delivered']
    current = str(data.get('status') or 'unknown').lower().replace('_', ' ')
    # Scoped deliveries/cancellations cannot complete the order. In particular,
    # never promote a shipment suffix or the presence of a delivered item.
    if current in ('delivered', 'cancelled') and data.get('whole_order_complete') is False:
        current = 'unknown'
    if current == 'unknown':
        previous = data.get('last_confirmed_status', 'unknown')
        if previous not in ('delivered', 'cancelled'):
            current = previous
    mapping = {'placed': 0, 'confirmed': 0, 'preparing': 1, 'packed': 1,
               'picked up': 2, 'out for delivery': 3 if food else 2,
               'nearby': 3 if food else 2, 'delivered': len(steps)-1}
    idx = mapping.get(current, -1)
    label = 'Cancelled' if current == 'cancelled' else 'Awaiting confirmation' if current == 'pending confirmation' else steps[idx] if idx >= 0 else 'Tracking pending'
    if idx < 0 and current=='unknown':
        if data.get('raw_status')=='processing':
            label='Processing'
        elif data.get('status_text') and not re.search(r'cancel|deliver|complet',data['status_text'],re.I):
            label=text(data['status_text'],120)
    if current == 'preparing' and not food:
        # Preparing is not proof that packing has finished.
        steps[1] = label = 'Packing'
    if current == 'picked up' and not food:
        steps.insert(2, 'In transit')
        idx, label = 2, 'In transit'
    return steps, idx, label, current in ('delivered', 'cancelled')


def eta(data, cfg):
    checked = instant(data.get('checked_at'))
    # Resolve relative estimates against the observation, not render time.
    raw = text(data.get('eta_text'), 80)
    minutes = data.get('eta_relative_minutes')
    if type(minutes) not in (int, float) or not math.isfinite(minutes):
        minutes = None
    if minutes is None and raw:
        hours = re.search(r'(\d+)\s*(?:hr|hour)', raw, re.I)
        mins = re.search(r'(\d+)(?:\s*[-–]\s*(\d+))?\s*min', raw, re.I)
        if hours or mins:
            minutes = (int(hours[1])*60 if hours else 0) + (int(mins[2] or mins[1]) if mins else 0)
    at = checked + dt.timedelta(minutes=minutes) if checked and minutes is not None and 0 <= minutes < 2880 else None
    at = at or instant(data.get('eta')) or instant(cfg.get('eta'))
    if not at:
        return raw or 'No estimate yet', '', None
    local = at.astimezone(DUBAI)
    now = dt.datetime.now(DUBAI)
    prefix = 'Expected by' if local.date() == now.date() else local.strftime('Expected %a %-d %b by')
    return local.strftime('%H:%M'), prefix, at.isoformat()


def view(cfg, data, meta):
    vertical = lane(cfg, meta)
    food = vertical in ('food', 'restaurants')
    steps, idx, label, terminal = stage(data, food)
    big, sub, at = eta(data, cfg)
    if terminal:
        big, sub, at = label, '', None
    app = cfg['app']
    brand = NAMES[app] + (' ' + LABELS[vertical] if vertical else '')
    store = text(meta.get('store') or cfg.get('store') or data.get('vendor_name'))
    if not store and ':' in cfg.get('label', ''):
        store = text(cfg['label'].split(':', 1)[0])
    private_notes=cfg.get('for','owner')=='owner' and cfg.get('chat','owner')=='owner' and not meta.get('public')
    rows = items(meta.get('items'),private_notes=private_notes)
    observed = items(data.get('items') if data.get('items_complete') else data.get('manifest_items') or data.get('items'),private_notes=private_notes)
    if not rows or (observed and any(not i['unresolved'] for i in observed) and all(i['unresolved'] for i in rows)):
        rows = observed or rows
    else:
        rows = fill_details(rows, observed)
    if private_notes and data.get('items_complete') and observed:
        for row in rows:
            matches=[i for i in observed if not i['unresolved'] and i['name']==row['name'] and i['qty']==row['qty']]
            peers=[i for i in rows if i['name']==row['name'] and i['qty']==row['qty']]
            if len(matches)==len(peers)==1:
                detail=matches[0].get('detail') or ''
                if '; Note: ' in detail and row.get('detail')==detail.split('; Note: ',1)[0]:
                    row['detail']=detail
    rows = picks(rows)
    total = amount(meta.get('total') if meta.get('total') is not None else cfg.get('total'))
    if total is None:
        total = amount(data.get('total'))
    partial = bool(data.get('whole_order_complete') is False and (
        any(p.get('stage') == 'delivered' for p in data.get('partial_evidence', [])) or
        any(p.get('status') == 'delivered' for p in data.get('shipments', []))))
    return {'version': 1, 'app': app, 'vertical': vertical, 'brand': brand, 'store': store,
            'order': cfg['order'], 'big': big, 'sub': sub, 'eta': at, 'stage': label,
            'word': at is None, 'summary': names(rows),
            'steps': steps, 'index': idx, 'terminal': terminal, 'partial': partial,
            'checked_at': data.get('checked_at'), 'unavailable': bool(data.get('errors')),
            'items': rows, 'count': sum(i['qty'] for i in rows) if rows else data.get('manifest_item_count'),
            'total': total, 'currency': text(meta.get('currency') or 'AED', 5),
            'theme': THEMES[app], 'sample': bool(meta.get('sample'))}


def description(v):
    return ' · '.join(x for x in (v['stage'], f"{v['count']} items" if v['count'] is not None else '',
                                  f"{v['currency']} {v['total']:,.2f}" if v['total'] is not None else '') if x)


def head_class(v):
    # A worded estimate ("Expected Wednesday 23 September") is set smaller so the date stays whole.
    if not v.get('word', v['terminal']):
        return ''
    return 'word long' if len(v['big']) > 16 else 'word'


def markup(v):
    e = lambda x: html.escape(str(x or ''), quote=True)
    progress = ''.join(f'<li class="{"on" if i <= v["index"] else ""}"' +
                       (' aria-current="step"' if i == v['index'] else '') + f'>{e(s)}</li>'
                       for i, s in enumerate(v['steps']))
    rows = []
    for i in v['items']:
        photo = f'<img src="{e(i["image"])}" alt="" width="56" height="56" loading="lazy" referrerpolicy="no-referrer">' if i['image'] else ''
        line = i['line_total'] if i['line_total'] is not None else i['price'] * i['qty'] if i['price'] is not None else None
        price = f'<span class="price">{line:,.2f}</span>' if line is not None else ''
        detail = f'<span class="detail" dir="auto">{e(i["detail"])}</span>' if i.get('detail') else ''
        detail += f'<span class="pick" dir="auto">{e(i["pick"])}</span>' if i.get('pick') else ''
        rows.append(f'<li class="{"has-photo" if photo else ""}">{photo}<span class="name"><span class="dish">{e(i["name"])}</span><span class="qty"> ×{i["qty"]}</span>{detail}</span>{price}</li>')
    heading = f'{v["count"]} item' + ('' if v['count'] == 1 else 's') if v['count'] is not None else 'Your order'
    total = f'<p class="total">Total<span><small>{e(v["currency"])}</small> {v["total"]:,.2f}</span></p>' if v['total'] is not None else ''
    tally = ' · '.join(x for x in (heading if v['count'] is not None else '',
                                   f'{v["currency"]} {v["total"]:,.2f}' if v['total'] is not None else '') if x)
    summary = f'<p class="summary">{e(tally)}</p>' if tally else ''
    # The bubble lists the first lines whole; past three it says how many are left.
    more = f'<p class="more">+{len(rows) - 2} more</p>' if len(rows) > 3 else ''
    when = f'<p class="when">{e(v["sub"])}</p>' if v['sub'] else ''
    return f'''<header class="eta"><div class="store">{e(v['brand'])}<span>{e(v['store'])}</span><span class="order">{e(v['order'])}</span></div>
{when}<h1 class="{head_class(v)}">{e(v['big'])}</h1></header>
<section aria-label="Delivery progress"><p class="status" role="status">{e(v['stage'])}</p>
{'' if v['stage'] == 'Cancelled' else f'<ol class="steps" style="--steps:{len(v["steps"])}">{progress}</ol>'}
{'<p class="notice">Part delivered<span> · remaining items still tracked</span></p>' if v['partial'] else ''}{summary}</section>
<section aria-labelledby="items-title"><h2 id="items-title">{e(heading)}</h2><ul class="items">{''.join(rows)}</ul>{more}
{'' if rows else '<p class="empty">Item details haven’t been added yet.</p>'}{total}</section>
<footer><p id="freshness">{'Sample order' if v['sample'] else 'Latest tracking check'}<time datetime="{e(v['checked_at'])}"></time></p><button type="button" id="refresh">Refresh</button></footer>'''


def page(v, url=None, *, with_preview=True):
    title = v['brand'] + ' · ' + v['stage']
    preview = (url.rstrip('/') + '/' if url else '') + 'preview.png'
    css, js = (ASSETS / 'card.css').read_text(), (ASSETS / 'card.js').read_text()
    boot = json.dumps(v, ensure_ascii=False).replace('<', '\\u003c')
    image_meta = (f'<meta property="og:image" content="{html.escape(preview, quote=True)}">'
                  '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">') if with_preview else ''
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex,nofollow">
<title>{html.escape(title)}</title><meta property="og:title" content="{html.escape(title, quote=True)}">
<meta property="og:description" content="{html.escape(description(v), quote=True)}">
{image_meta}
<style>{css}</style></head><body style="--field:{v['theme'][0]};--field-ink:{v['theme'][1]}">
<main aria-label="Delivery tracking">{markup(v)}</main><script id="initial" type="application/json">{boot}</script><script>{js}</script></body></html>'''


def preview(path, v):
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return preview_chrome(path)
    im = Image.new('RGB', (1200, 630), v['theme'][0])
    draw = ImageDraw.Draw(im)
    def font(size):
        for name in ('/System/Library/Fonts/SFNS.ttf', '/System/Library/Fonts/Helvetica.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'):
            try:
                return ImageFont.truetype(name, size)
            except OSError:
                pass
        return ImageFont.load_default()
    def fitted(value, size, y):
        while size > 20 and draw.textbbox((0, 0), value, font=font(size))[2] > 1070:
            size -= 2
        draw.text((64, y), value, fill=v['theme'][1], font=font(size))
    fitted(v['brand'], 44, 40)
    fitted(v['store'], 32, 106)
    # The label reads before the time it qualifies ("Expected by" / "18:06").
    if v['sub']:
        fitted(v['sub'], 38, 178)
    fitted(v['big'], 180 if not v.get('word') else 120, 220 if v['sub'] else 180)
    fitted(description(v), 32, 440)
    if v.get('summary'):
        fitted(v['summary'], 28, 492)
    fitted('Sample order' if v['sample'] else 'Open for the latest tracking', 26, 556)
    tmp = path.with_name('preview.tmp.png')
    im.save(tmp)
    tmp.replace(path)
    return True


def preview_chrome(path):
    # The local page is already built. Do not fetch product images over the network.
    shells = sorted((Path.home() / '.robob/tools/chrome-headless-shell').glob('*/*/chrome-headless-shell'), reverse=True)
    for shell in shells:
        try:
            with tempfile.TemporaryDirectory(prefix='delivery-preview-') as tmp:
                image = Path(tmp) / 'preview.png'
                result = subprocess.run([str(shell), '--headless', '--disable-gpu', '--hide-scrollbars',
                                         '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND',
                                         '--window-size=1200,630', f'--screenshot={image}',
                                         (path.parent / 'index.html').resolve().as_uri()],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
                if result.returncode == 0 and image.is_file() and image.stat().st_size:
                    image.replace(path)
                    return True
        except (OSError, subprocess.TimeoutExpired):
            continue
    return False


def build(cfg, data, meta=None, outdir=None, url=None, *, public=False):
    folder = Path(outdir) if outdir else APPS / slug(cfg['app'], cfg['order'])
    folder.mkdir(parents=True, exist_ok=True)
    metadata = {**({} if public else read(folder / 'items.json')), **cfg.get('card_meta', {}), **(meta or {})}
    v = view(cfg, data, {**metadata, 'public':public})
    # JSON refresh and static fallback use the same projection.
    atomic(folder / 'status.json', v)
    fingerprint = hashlib.sha256(json.dumps({k: v[k] for k in ('brand', 'store', 'big', 'sub', 'stage', 'count', 'total', 'sample', 'summary')}, sort_keys=True).encode()).hexdigest()
    preview_path = folder / 'preview.png'
    current = read(folder / 'preview-state.json').get('hash') == fingerprint and preview_path.exists()
    atomic(folder / 'index.html', page(v, url, with_preview=current))
    if not current:
        current = preview(preview_path, v)
        if current:
            atomic(folder / 'preview-state.json', {'hash': fingerprint})
            atomic(folder / 'index.html', page(v, url))
    return {'slug': folder.name, 'dir': str(folder), 'stage': v['stage'], 'items': v['count'],
            'has_preview': bool(current)}


def route():
    db = Path(os.environ.get('SPECTRUM_BRIDGE_DB') or Path.home() / '.config/spectrum-bridge/state.sqlite')
    with sqlite3.connect(f'{db.as_uri()}?mode=ro', uri=True, timeout=2) as con:
        row = con.execute("select json_extract(value, '$.id') from kv where key='route'").fetchone()
    value = row[0] if row else None
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_:.-]{1,200}', value):
        raise ValueError('bridge_no_route')
    return value


def live_session(args):
    """Saved bridge args with --session re-read from the live owner route.

    The owner's session rotates; a session frozen with the first attempt makes
    every later retry 409. Key, text and URL stay exactly as first saved."""
    args = list(args)
    if '--session' in args:
        args[args.index('--session') + 1] = route()
    return args


def chat_store(slug):
    base = Path(os.environ.get('SPECTRUM_BRIDGE_DB') or Path.home() / '.config/spectrum-bridge/state.sqlite').parent
    return base / 'state.sqlite' if slug == 'owner' else base / 'chats' / slug / 'state.sqlite'


def op_ids(args):
    """Outbox ids a saved send can have: hash(slug:key) over --to, hash(key) on the caller's own route."""
    kind = 'app' if args[0] == 'app' else 'send'
    key = args[args.index('--key') + 1]
    slug = args[args.index('--to') + 1] if '--to' in args else 'owner'
    h = lambda s: hashlib.sha256(s.encode()).hexdigest()
    return slug, {'to': f'{kind}:{h(slug + ":" + key)}', 'self': f'{kind}:{h(key)}'}


# One statement is one read snapshot: op rows, the route and the fallback marks can't be read
# across a send or a route rotation that lands between two queries. The route comes back even
# when none of the ops exist yet.
OUTBOX_SQL = ("select r.route, o.id, o.state, o.attempts, o.payload, "
              "(select value from kv where key = 'firstAttempt:' || o.id), "
              "(select value from kv where key = 'fallback:' || o.id) "
              "from (select (select value from kv where key = 'route') as route) r "
              "left join outbox o on o.id in ({})")


def _kv(value):
    try:
        return json.loads(value) if value else None
    except ValueError:
        return value


def op_kind(oid, state, attempts, stale, first, fell, owner):
    """live: out, or queued and deliverable; maybe: the bridge can't tell, it was cancelled after
    an attempt, or it is a failed card the owner chat's Telegram fallback may have sent (only the
    owner chat has one; it takes failed app ops it has tried and marks them only after its own
    send returns, so only its "skipped" mark proves it never went); dead: never went."""
    if state in ('sent', 'fallback', 'sending') or (state == 'pending' and not stale):
        return 'live'
    if state == 'uncertain' or (state in ('pending', 'cancelled') and attempts):
        return 'maybe'
    skipped = isinstance(fell, dict) and 'skipped' in fell
    if owner and state == 'failed' and oid.startswith('app:') and not skipped and isinstance(first, (int, float)):
        return 'maybe'
    return 'dead'


def ops(args):
    """(route, {id: (kind, state)}): the chat's live route and the bridge's own record of a
    saved send, read only.

    Owner cards first saved without --to sat in the owner's session-bound queue, so both of
    the owner's routes are read."""
    slug, ids = op_ids(args)
    wanted = list(ids.values()) if slug == 'owner' else [ids['to']]
    con = sqlite3.connect(f'{chat_store(slug).as_uri()}?mode=ro', uri=True, timeout=2)
    try:
        rows = con.execute(OUTBOX_SQL.format(','.join('?' * len(wanted))), wanted).fetchall()
    finally:
        con.close()
    route, out = _kv(rows[0][0]) if rows else None, {}
    live = route if isinstance(route, dict) else {}
    for _, oid, state, attempts, payload, first, fell in rows:
        if oid is None:
            continue
        op = _kv(payload) or {}
        stale = op.get('generation') is not None and (op.get('sessionId'), op.get('generation')) != (live.get('id'), live.get('generation'))
        out[oid] = (op_kind(oid, state, attempts, stale, _kv(first), _kv(fell), slug == 'owner'), state)
    return route, out


def mine(args):
    """The outbox id this exact route and key use."""
    return op_ids(args)[1]['to' if '--to' in args else 'self']


def open_attempts(holder, field):
    """Bridge calls that got no answer: each may still be queued later, until something proves it can't."""
    if 'open' in holder:
        return list(holder['open'])
    # Saved before per-attempt records: only its last attempt can still be open.
    args = holder.get(field)
    return [{'args': list(args)}] if args and holder.get('status') != 'sent' and not holder.get('refused') else []


def waiting(holder, field):
    """Open attempts that may still land. One that left an op is settled by that op. One on the
    owner's own route is dead once the live route has another id: the bridge checks the route when
    it queues, and an old route id never comes back. Nothing settles an unanswered --to request
    except its op, so only the same op may carry its retry. Each is read on its own: outbox rows
    are never deleted and route ids only move on, so a later read can't undo an earlier one."""
    out = []
    for a in open_attempts(holder, field):
        args = a['args']
        route, seen = ops(args)
        if mine(args) in seen:
            continue
        if '--to' not in args and isinstance(route, dict) and args[args.index('--session') + 1] != route.get('id'):
            continue
        out.append(a)
    return out


def reconcile(args, holder=None, field='send_args'):
    """Args for the next attempt at a saved send, or a final status when it must not be sent again.

    While an earlier attempt may still land, only that same op (route and key) carries the retry;
    once every attempt is settled, a dead op moves on to --to owner or a fresh key."""
    holder = holder or {}
    for _ in range(20):
        _, seen = ops(args)
        kinds = {kind for kind, _ in seen.values()}
        if 'live' in kinds:
            return 'sent', args
        if 'maybe' in kinds:
            return 'failed:may_have_sent_check_chat', args
        held = {mine(a['args']): a['args'] for a in waiting(holder, field)}
        if len(held) > 1:
            return 'failed:may_have_sent_check_chat', args
        if held:
            return None, list(next(iter(held.values())))
        moved = owner_to(args, holder)
        if moved != args:
            args = moved
            continue
        if mine(args) in seen:
            i = args.index('--key') + 1
            base, _, n = args[i].partition('#')
            args = [*args[:i], f'{base}#{int(n or 1) + 1}', *args[i + 1:]]
            continue
        return None, args
    raise ValueError('bridge_outbox_unclear')


def owner_to(args, last=None):
    """New owner-card form: --to owner carries no session, so no rotation can cancel or refuse it.
    Not on a bridge that already refused it (an older CLI or server)."""
    args = list(args)
    if args[0] == 'app' and '--to' not in args and not (last or {}).get('no_to'):
        args += ['--to', 'owner']
    return args


class BridgeError(ValueError):
    def __init__(self, err):
        super().__init__('bridge_request_failed')
        # A clear "no" from the bridge (or a request the CLI never sent): nothing was queued.
        self.refused = bool(re.search(r'\(HTTP (4\d\d|503)\)|Invalid command arguments', err or ''))
        # An older bridge that doesn't know --to for this command.
        self.no_to = bool(re.search(r'Invalid command arguments|\(HTTP 400\)', err or ''))


def attempt(holder, field, save):
    """One bridge call for saved args, recorded on disk first so a cut process is reconciled next
    time. Returns 'sent' or a final status. An older bridge without `app --to owner` gets the
    owner's own route, reconciled first: that route may hold an earlier op under this key."""
    holder['open'] = open_attempts(holder, field)
    for n in (1, 2):
        entry = {'args': list(holder[field]), 'at': time.time()}
        holder['open'].append(entry)
        holder['attempted_at'] = entry['at']
        save()
        try:
            ack = bridge(holder[field])
        except BridgeError as exc:
            if exc.refused:
                holder['open'].remove(entry)  # a clear no for this request: it queued nothing
            args = holder[field]
            if n == 1 and exc.no_to and args[0] == 'app' and args[-2:] == ['--to', 'owner']:
                holder['no_to'] = True
                final, holder[field] = reconcile(args[:-2], holder, field)
                if final:
                    return final
                holder[field] = live_session(holder[field])
                continue
            raise
        holder['open'] = [a for a in holder['open'] if mine(a['args']) != mine(holder[field])]
        if not isinstance(ack.get('id'), str) or not isinstance(ack.get('created'), bool):
            raise ValueError('card_send_bad_ack')
        holder['bridge_id'] = ack['id']
        if ack['created'] is False:
            # The bridge already had this op: a send only if that op is still going.
            had = ops(holder[field])[1].get(mine(holder[field]))
            if not had:
                raise ValueError('bridge_outbox_unclear')  # the same key again can't post twice
            if had[0] == 'dead':
                raise ValueError('bridge_had_this_key_dropped')  # the next try takes a fresh key
        return 'sent'



def public_url(url):
    """A link people off the tailnet can open: https on a public host (the bridge's share origin or a
    quick tunnel), never the tailnet (.ts.net), loopback or a bare IP."""
    parsed = urlparse(url)
    host = (parsed.hostname or '').lower()
    return (parsed.scheme == 'https' and '.' in host and not host.endswith('.ts.net')
            and not re.fullmatch(r'[0-9.]+|[0-9a-f:]+', host) and host not in ('localhost',))


def bridge(args, timeout=12):
    env = {k: v for k, v in os.environ.items() if k not in ('BUN_INSPECT', 'BUN_OPTIONS', 'NODE_OPTIONS')}
    p = subprocess.run([BUN, BRIDGE, *args], capture_output=True, text=True, timeout=timeout, env=env)
    if p.returncode:
        raise BridgeError(p.stderr)
    return json.loads(p.stdout)


def prune_completed_shares():
    """Free only delivery-owned shares whose terminal page had an hour to be read."""
    records = bridge(['shares'], timeout=2).get('shares', [])
    by_app = {r['app']: r for r in records if isinstance(r,dict) and isinstance(r.get('app'),str)}
    for path in sorted((ROOT / 'cards').glob('*.json')):
        state = read(path)
        finished = state.get('terminal_at')
        if not finished or time.time() - finished < 3600 or state.get('unshared'):
            continue
        shared = by_app.get(state.get('slug'))
        if not shared or shared.get('url') != state.get('url'):
            continue
        # A stable-origin link is permanent: retiring it would break the URL already sent. Only an explicit unshare ends it.
        if shared.get('permanent'):
            continue
        bridge(['unshare', '--app', state['slug']], timeout=2)
        state['unshared'] = True
        atomic(path, state)
        return  # Bound maintenance latency per new registration.


def share_days(cfg):
    days = 7 if cfg.get('app') == 'amazon' or cfg.get('vertical') in ('main', 'supermall', 'marketplace') else 2
    promised = instant(cfg.get('eta'))
    if promised:
        days = max(days, math.ceil((promised.timestamp()-time.time())/86400)+2)
    return min(30, max(1, days))


def sync(cfg, data, *, send=False, recover=False):
    settings = cfg.get('delivery_card')
    if not isinstance(settings, dict):
        return {'status': 'legacy_not_enrolled'}
    key = cfg['watcher']
    statepath = ROOT / 'cards' / (key + '.json')
    statepath.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with statepath.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = read(statepath)
        recipient = settings.get('chat') or cfg.get('chat') or cfg['for']
        # Public shares get a separate allowlisted directory. Legacy items.json
        # and arbitrary files must never become public through directory reuse.
        public_slug = slug(cfg['app'], cfg['order'])
        if recipient != 'owner':
            public_slug = public_slug[:48] + '-' + hashlib.sha256((key + ':public-v1').encode()).hexdigest()[:12]
        folder = APPS / public_slug
        if recipient != 'owner' and folder.exists():
            allowed = {'index.html', 'status.json', 'preview.png', 'preview-state.json'}
            extras = [p for p in folder.iterdir() if p.name not in allowed]
            if extras:
                state.update(status='failed:public_directory_has_extra_files')
                atomic(statepath, state)
                return {'status': state['status'], 'slug': public_slug}
        rendered = build(cfg, data, outdir=folder, url=state.get('url'), public=recipient != 'owner')
        state.update(rendered)
        if rendered['stage'] in ('Delivered', 'Cancelled'):
            state.setdefault('terminal_at', time.time())
        if state.get('status') == 'sent' and state.get('send_args') and not state.get('bridge_confirmed'):
            # The bridge took the send; until its outbox shows it out, a route rotation or a
            # refusal can still drop it, and then it must be sendable again.
            try:
                _, seen = ops(state['send_args'])
                if seen and {st for _, st in seen.values()} & {'sent', 'fallback'}:
                    state['bridge_confirmed'] = True
                elif (seen and {kind for kind, _ in seen.values()} == {'dead'} and mine(state['send_args']) in seen
                      and not waiting(state, 'send_args')):
                    state['status'] = 'failed:dropped_by_bridge'
            except (OSError, ValueError, sqlite3.Error):
                pass  # unreadable: keep what the ack said
        if not send or settings.get('held') or (settings.get('skip_send') and not recover):
            if state.get('status') != 'sent':
                state['status'] = 'held:payment_unconfirmed' if settings.get('held') else 'skipped' if settings.get('skip_send') else state.get('status', 'not_sent')
        elif state.get('status') != 'sent':
            # Never deliver a forgotten placement days later after a restart.
            registered = instant(cfg.get('registered_at'))
            if not recover and (not registered or time.time() - registered.timestamp() > 6*3600):
                state['status'] = 'expired:send_manually'
            else:
                try:
                    if not state.get('url'):
                        if recipient != 'owner':
                            try:
                                prune_completed_shares()
                            except Exception:
                                pass  # Maintenance cannot block this order's card.
                        published = bridge(['publish' if recipient == 'owner' else 'share', '--app', rendered['slug'],
                                            *(['--days', str(share_days(cfg))] if recipient != 'owner' else [])],
                                           timeout=65 if recipient != 'owner' else 12)
                        warnings = published.get('metadataWarnings') or []
                        # Missing imagery is expected only when both renderers failed.
                        if any(w != 'missing og:image' or rendered['has_preview'] for w in warnings):
                            raise ValueError('card_metadata_incomplete')
                        url = published.get('url')
                        if not isinstance(url, str) or not url.startswith('https://'):
                            raise ValueError('card_publish_bad_ack')
                        if recipient != 'owner' and not public_url(url):
                            raise ValueError('public_card_url_required')
                        state['url'] = url
                        atomic(statepath, state)
                        build(cfg, data, outdir=folder, url=url, public=recipient != 'owner')
                    final = None
                    if not state.get('send_args'):
                        state['open'] = []
                        session = route()
                        dedupe = 'delivery-card:' + key
                        if recipient == 'owner':
                            state['send_args'] = owner_to(['app', '--url', state['url'], '--caption', 'Delivery tracking', '--summary', 'Open your order', '--session', session, '--key', dedupe], state)
                        else:
                            # A public rich link also works for recipients who
                            # have not installed Robob Cards.
                            state['send_args'] = ['send', '--to', recipient, '--text=' + state['url'], '--session', session, '--key', dedupe]
                        if recover:
                            final, state['send_args'] = reconcile(state['send_args'], state)
                    else:
                        # A retry: the bridge outbox says whether the last attempt got through.
                        final, state['send_args'] = reconcile(state['send_args'], state)
                    if final:
                        state['status'] = final
                    else:
                        state['send_args'] = live_session(state['send_args'])
                        state['status'] = 'attempting'
                        state['status'] = attempt(state, 'send_args', lambda: atomic(statepath, state))
                except (OSError, ValueError, sqlite3.Error, subprocess.TimeoutExpired) as exc:
                    state['status'] = 'failed:' + (str(exc) if isinstance(exc, ValueError) else type(exc).__name__)
        # Quick-tunnel links can change after bridge restart. Report a broken
        # original link for repair, without sending another progress message.
        if state.get('status') == 'sent' and recipient != 'owner' and not state.get('unshared') and time.time() - state.get('link_checked_at', 0) > 300:
            try:
                shared = bridge(['shares'], timeout=2)
                records = shared if isinstance(shared, list) else shared.get('shares', [])
                live = next((r for r in records if r.get('app') == public_slug), None)
                state['link_health'] = 'ok' if live and live.get('live') and live.get('url') == state.get('url') else 'needs_repair'
            except (OSError, ValueError, subprocess.TimeoutExpired):
                state['link_health'] = 'unknown'
            state['link_checked_at'] = time.time()
        atomic(statepath, state)
        statepath.chmod(0o600)
        return {k: state.get(k) for k in ('status', 'slug', 'url', 'link_health')}


def repair_link(cfg, data):
    """Explicit replacement for a confirmed-sent link; never a progress ping."""
    settings = cfg.get('delivery_card', {})
    recipient = settings.get('chat') or cfg.get('chat') or cfg.get('for')
    if recipient == 'owner' or settings.get('held') or settings.get('skip_send'):
        raise ValueError('public_sent_card_required')
    path = ROOT / 'cards' / (cfg['watcher'] + '.json')
    with path.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = read(path)
        if state.get('status') != 'sent' or not state.get('url'):
            raise ValueError('public_sent_card_required')
        repair = state.get('repair')
        if not repair or repair.get('status') == 'sent':
            shared = bridge(['shares']).get('shares', [])
            current = next((r for r in shared if r.get('app') == state['slug'] and r.get('live')), None)
            url = current.get('url') if current else None
            if not url:
                url = bridge(['share','--app',state['slug'],'--days',str(share_days(cfg))],timeout=65).get('url')
            if not isinstance(url,str) or not public_url(url):
                raise ValueError('public_card_url_required')
            if url == state['url']:
                state['link_health'] = 'ok'; atomic(path,state)
                return {'status':'unchanged','url':url}
            key = 'delivery-card-repair:' + cfg['watcher'] + ':' + hashlib.sha256(url.encode()).hexdigest()[:12]
            repair = {'status':'attempting','url':url,'open':[],'args':['send','--to',recipient,'--text='+url,
                      '--session',route(),'--key',key]}
            state['repair'] = repair
            atomic(path,state)
        build(cfg,data,outdir=APPS/state['slug'],url=repair['url'],public=True)
        final = None
        if repair.get('tried'):
            final, repair['args'] = reconcile(repair['args'], repair, 'args')
        if not final:
            repair['args'] = live_session(repair['args'])
            repair['tried'] = True
            final = attempt(repair, 'args', lambda: atomic(path, state))
        if final != 'sent':
            repair['status'] = final
            atomic(path,state)
            raise ValueError('repair_may_have_sent_check_chat')
        repair.update(status='sent')
        state.update(url=repair['url'],link_health='ok',link_checked_at=time.time())
        atomic(path,state)
        return {'status':'sent','url':state['url']}


def safe_sync(cfg, data, *, send=False, recover=False):
    try:
        return sync(cfg, data, send=send, recover=recover)
    except Exception as exc:
        # Card failures must not suppress tracker evidence or financial receipts.
        traceback.print_exc()
        return {'status': 'failed:' + type(exc).__name__ + ':' + str(exc)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--app', required=True, choices=THEMES)
    ap.add_argument('--order', required=True)
    ap.add_argument('--dir')
    ap.add_argument('--items-file')
    ap.add_argument('--data-file', help='fixture/status JSON; never contacts a provider')
    ap.add_argument('--vertical')
    ap.add_argument('--send', action='store_true', help='retry an enrolled card with its retained idempotency key')
    ap.add_argument('--recover-send', action='store_true', help='explicitly recover a suppressed or expired enrolled placement card')
    ap.add_argument('--repair-link', action='store_true', help='explicitly send a replacement for a changed public URL')
    ap.add_argument('--loop', type=int, default=0, help='legacy compatibility; watcher hooks are preferred')
    ap.add_argument('--hours', type=float, default=4)
    a = ap.parse_args(argv)
    if not re.fullmatch('[A-Za-z0-9_-]{1,80}', a.order):
        ap.error('Invalid order ID')
    cfg = read(ROOT / 'orders' / f'order-{a.app}-{a.order.lower()}.json')
    cfg.update(app=a.app, order=a.order)
    if (a.send or a.recover_send or a.repair_link) and (a.data_file or a.dir or not cfg.get('delivery_card')):
        ap.error('--send requires a registered, enrolled order; no fixture or custom directory')
    if sum((a.send, a.recover_send, a.repair_link)) > 1:
        ap.error('choose only one send or repair action')
    if a.vertical:
        cfg['vertical'] = a.vertical
    meta = read(a.items_file) if a.items_file else {}
    if isinstance(meta, list):
        meta = {'items': meta}
    end = time.time() + a.hours*3600
    while True:
        if a.data_file:
            data = read(a.data_file)
        else:
            p = subprocess.run([str(Path.home() / '.local/bin/order-watch'), 'status', '--app', a.app, '--order', a.order], capture_output=True, text=True, timeout=240)
            if p.returncode:
                raise SystemExit('order-watch status failed')
            data = json.loads(p.stdout)
        result = build(cfg, data, meta, a.dir)
        if a.send or a.recover_send:
            result['delivery_card'] = safe_sync(cfg, data, send=True, recover=a.recover_send)
        if a.repair_link:
            result['repair'] = repair_link(cfg,data)
        print(json.dumps(result), flush=True)
        if not a.loop or result['stage'] in ('Delivered', 'Cancelled') or time.time() >= end:
            break
        time.sleep(max(60, a.loop))


if __name__ == '__main__':
    main()
