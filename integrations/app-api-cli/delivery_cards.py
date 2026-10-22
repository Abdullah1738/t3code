"""Delivery card projection, rendering and one idempotent placement notice.

Watcher checks supply already-read evidence. No polling process or merchant
request is started here. Only the allowlisted view is written to the web root.
"""
import argparse
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
import time
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
LANES = {'noon': ('minutes', 'nownow', 'supermall', 'main', 'food'),
         'talabat': ('restaurants', 'mart', 'shops'), 'careem': ('food', 'quik', 'shops', 'box'),
         'amazon': ('same-day',)}
NAMES = {'noon': 'noon', 'talabat': 'Talabat', 'careem': 'Careem', 'amazon': 'Amazon'}
LABELS = {'minutes': 'Minutes', 'nownow': 'NowNow', 'supermall': 'Supermall', 'main': 'Main',
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


def items(rows):
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
        out.append({'name': name or (f'Item {ident}' if ident else 'Item details pending'),
                    'unresolved': bool(row.get('unresolved') or not name),
                    'qty': int(qty), 'price': price, 'line_total': amount(row.get('line_total')),
                    'image': image_url(row.get('image_url') or row.get('image') or row.get('imageUrl'))})
    return out


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
        return 'nownow' if order.startswith('NN') else 'food' if order.startswith('F') else 'main' if order.startswith('N') else 'minutes'
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
        if previous not in ('delivered', 'cancelled') or data.get('whole_order_complete') is not False:
            current = previous
    mapping = {'placed': 0, 'confirmed': 0, 'preparing': 1, 'packed': 1,
               'picked up': 2, 'out for delivery': 3 if food else 2,
               'nearby': 3 if food else 2, 'delivered': len(steps)-1}
    idx = mapping.get(current, -1)
    label = 'Cancelled' if current == 'cancelled' else 'Awaiting confirmation' if current == 'pending confirmation' else steps[idx] if idx >= 0 else 'Tracking pending'
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
        return '—', raw or 'Waiting for an estimate', None
    local = at.astimezone(DUBAI)
    now = dt.datetime.now(DUBAI)
    prefix = 'Expected by' if local.date() == now.date() else local.strftime('%a %-d %b · by')
    return local.strftime('%H:%M'), prefix, at.isoformat()


def view(cfg, data, meta):
    vertical = lane(cfg, meta)
    food = vertical in ('food', 'restaurants')
    steps, idx, label, terminal = stage(data, food)
    big, sub, at = eta(data, cfg)
    if terminal:
        big, sub, at = label, ('Delivery confirmed' if label == 'Delivered' else 'Order closed'), None
    app = cfg['app']
    brand = NAMES[app] + (' ' + LABELS[vertical] if vertical else '')
    store = text(meta.get('store') or cfg.get('store') or data.get('vendor_name'))
    if not store and ':' in cfg.get('label', ''):
        store = text(cfg['label'].split(':', 1)[0])
    rows = items(meta.get('items'))
    observed = items(data.get('manifest_items') or data.get('items'))
    if not rows or (observed and any(not i['unresolved'] for i in observed) and all(i['unresolved'] for i in rows)):
        rows = observed or rows
    total = amount(meta.get('total') if meta.get('total') is not None else cfg.get('total'))
    partial = bool(data.get('whole_order_complete') is False and (
        any(p.get('stage') == 'delivered' for p in data.get('partial_evidence', [])) or
        any(p.get('status') == 'delivered' for p in data.get('shipments', []))))
    return {'version': 1, 'app': app, 'vertical': vertical, 'brand': brand, 'store': store,
            'order': cfg['order'], 'big': big, 'sub': sub, 'eta': at, 'stage': label,
            'steps': steps, 'index': idx, 'terminal': terminal, 'partial': partial,
            'checked_at': data.get('checked_at'), 'unavailable': bool(data.get('errors')),
            'items': rows, 'count': sum(i['qty'] for i in rows) if rows else data.get('manifest_item_count'),
            'total': total, 'currency': text(meta.get('currency') or 'AED', 5),
            'theme': THEMES[app], 'sample': bool(meta.get('sample'))}


def description(v):
    return ' · '.join(x for x in (v['stage'], f"{v['count']} items" if v['count'] is not None else '',
                                  f"{v['currency']} {v['total']:,.2f}" if v['total'] is not None else '') if x)


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
        rows.append(f'<li class="{"has-photo" if photo else ""}">{photo}<span class="name">{e(i["name"])}<span class="qty"> ×{i["qty"]}</span></span>{price}</li>')
    heading = f'{v["count"]} item' + ('' if v['count'] == 1 else 's') if v['count'] is not None else 'Your order'
    total = f'<p class="total">Total<span><small>{e(v["currency"])}</small> {v["total"]:,.2f}</span></p>' if v['total'] is not None else ''
    return f'''<header class="eta"><div class="store">{e(v['brand'])}<span>{e(v['store'])}</span><span class="order">{e(v['order'])}</span></div>
<h1 class="{'word' if v['terminal'] else ''}">{e(v['big'])}</h1><p class="when">{e(v['sub'])}</p></header>
<section aria-label="Delivery progress"><p class="status" role="status">{e(v['stage'])}</p>
{'' if v['stage'] == 'Cancelled' else f'<ol class="steps" style="--steps:{len(v["steps"])}">{progress}</ol>'}
{'<p class="notice">Part delivered · remaining items still tracked</p>' if v['partial'] else ''}</section>
<section aria-labelledby="items-title"><h2 id="items-title">{e(heading)}</h2><ul class="items">{''.join(rows)}</ul>
{'' if rows else '<p class="empty">Item details haven’t been added yet.</p>'}{total}</section>
<footer><p id="freshness">{'Sample order' if v['sample'] else 'Latest tracking check'}<time datetime="{e(v['checked_at'])}"></time></p><button type="button" id="refresh">Refresh</button></footer>'''


def page(v, url=None):
    title = v['brand'] + ' · ' + v['stage']
    preview = (url.rstrip('/') + '/' if url else '') + 'preview.png'
    css, js = (ASSETS / 'card.css').read_text(), (ASSETS / 'card.js').read_text()
    boot = json.dumps(v, ensure_ascii=False).replace('<', '\\u003c')
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex,nofollow">
<title>{html.escape(title)}</title><meta property="og:title" content="{html.escape(title, quote=True)}">
<meta property="og:description" content="{html.escape(description(v), quote=True)}">
<meta property="og:image" content="{html.escape(preview, quote=True)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<style>{css}</style></head><body style="--field:{v['theme'][0]};--field-ink:{v['theme'][1]}">
<main aria-label="Delivery tracking">{markup(v)}</main><script id="initial" type="application/json">{boot}</script><script>{js}</script></body></html>'''


def preview(path, v):
    from PIL import Image, ImageDraw, ImageFont
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
    fitted(v['big'], 180, 160)
    fitted(v['sub'], 38, 380)
    fitted(description(v), 32, 460)
    fitted('Sample order' if v['sample'] else 'Open for the latest tracking', 26, 550)
    tmp = path.with_name('preview.tmp.png')
    im.save(tmp)
    tmp.replace(path)


def build(cfg, data, meta=None, outdir=None, url=None, *, public=False):
    folder = Path(outdir) if outdir else APPS / slug(cfg['app'], cfg['order'])
    folder.mkdir(parents=True, exist_ok=True)
    metadata = {**({} if public else read(folder / 'items.json')), **cfg.get('card_meta', {}), **(meta or {})}
    v = view(cfg, data, metadata)
    # JSON refresh and static fallback use the same projection.
    atomic(folder / 'status.json', v)
    atomic(folder / 'index.html', page(v, url))
    fingerprint = hashlib.sha256(json.dumps({k: v[k] for k in ('brand', 'store', 'big', 'sub', 'stage', 'count', 'total', 'sample')}, sort_keys=True).encode()).hexdigest()
    if read(folder / 'preview-state.json').get('hash') != fingerprint or not (folder / 'preview.png').exists():
        preview(folder / 'preview.png', v)
        atomic(folder / 'preview-state.json', {'hash': fingerprint})
    return {'slug': folder.name, 'dir': str(folder), 'stage': v['stage'], 'items': v['count']}


def route():
    db = Path(os.environ.get('SPECTRUM_BRIDGE_DB') or Path.home() / '.config/spectrum-bridge/state.sqlite')
    with sqlite3.connect(f'{db.as_uri()}?mode=ro', uri=True, timeout=2) as con:
        row = con.execute("select json_extract(value, '$.id') from kv where key='route'").fetchone()
    value = row[0] if row else None
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_:.-]{1,200}', value):
        raise ValueError('bridge_no_route')
    return value


def bridge(args, timeout=12):
    env = {k: v for k, v in os.environ.items() if k not in ('BUN_INSPECT', 'BUN_OPTIONS', 'NODE_OPTIONS')}
    p = subprocess.run([BUN, BRIDGE, *args], capture_output=True, text=True, timeout=timeout, env=env)
    if p.returncode:
        raise ValueError('bridge_request_failed')
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
        bridge(['unshare', '--app', state['slug']], timeout=2)
        state['unshared'] = True
        atomic(path, state)
        return  # Bound maintenance latency per new registration.


def share_days(cfg):
    days = 7 if cfg.get('app') == 'amazon' or cfg.get('vertical') in ('main', 'supermall') else 2
    promised = instant(cfg.get('eta'))
    if promised:
        days = max(days, math.ceil((promised.timestamp()-time.time())/86400)+2)
    return min(30, max(1, days))


def sync(cfg, data, *, send=False):
    settings = cfg.get('delivery_card')
    if not isinstance(settings, dict):
        return {'status': 'legacy_not_enrolled'}
    key = cfg['watcher']
    statepath = ROOT / 'cards' / (key + '.json')
    statepath.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with statepath.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = read(statepath)
        recipient = settings.get('chat') or cfg['for']
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
        if not send or settings.get('held') or settings.get('skip_send'):
            if state.get('status') != 'sent':
                state['status'] = 'held:payment_unconfirmed' if settings.get('held') else 'skipped' if settings.get('skip_send') else state.get('status', 'not_sent')
        elif state.get('status') != 'sent':
            # Never deliver a forgotten placement days later after a restart.
            registered = instant(cfg.get('registered_at'))
            if not registered or time.time() - registered.timestamp() > 6*3600:
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
                        if published.get('metadataWarnings'):
                            raise ValueError('card_metadata_incomplete')
                        url = published.get('url')
                        if not isinstance(url, str) or not url.startswith('https://'):
                            raise ValueError('card_publish_bad_ack')
                        if recipient != 'owner' and not urlparse(url).hostname.endswith('.trycloudflare.com'):
                            raise ValueError('public_card_url_required')
                        state['url'] = url
                        atomic(statepath, state)
                        build(cfg, data, outdir=folder, url=url, public=recipient != 'owner')
                    if not state.get('send_args'):
                        session = route()
                        dedupe = 'delivery-card:' + key
                        if recipient == 'owner':
                            state['send_args'] = ['app', '--url', state['url'], '--caption', 'Delivery tracking', '--summary', 'Open your order', '--session', session, '--key', dedupe]
                        else:
                            # app has no --to route. A public rich link also works
                            # for recipients who have not installed Robob Cards.
                            state['send_args'] = ['send', '--to', recipient, '--text=' + state['url'], '--session', session, '--key', dedupe]
                    state['status'] = 'attempting'
                    atomic(statepath, state)
                    ack = bridge(state['send_args'])
                    if not isinstance(ack.get('id'), str) or not isinstance(ack.get('created'), bool):
                        raise ValueError('card_send_bad_ack')
                    state.update(status='sent', bridge_id=ack['id'])
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
    recipient = settings.get('chat') or cfg.get('for')
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
            if not isinstance(url,str) or not (urlparse(url).hostname or '').endswith('.trycloudflare.com'):
                raise ValueError('public_card_url_required')
            if url == state['url']:
                state['link_health'] = 'ok'; atomic(path,state)
                return {'status':'unchanged','url':url}
            key = 'delivery-card-repair:' + cfg['watcher'] + ':' + hashlib.sha256(url.encode()).hexdigest()[:12]
            repair = {'status':'attempting','url':url,'args':['send','--to',recipient,'--text='+url,
                      '--session',route(),'--key',key]}
            state['repair'] = repair
            atomic(path,state)
        build(cfg,data,outdir=APPS/state['slug'],url=repair['url'],public=True)
        ack = bridge(repair['args'])
        if not isinstance(ack.get('id'),str) or not isinstance(ack.get('created'),bool):
            raise ValueError('card_send_bad_ack')
        repair.update(status='sent',bridge_id=ack['id'])
        state.update(url=repair['url'],link_health='ok',link_checked_at=time.time())
        atomic(path,state)
        return {'status':'sent','url':state['url']}


def safe_sync(cfg, data, *, send=False):
    try:
        return sync(cfg, data, send=send)
    except Exception as exc:
        # Card failures must not suppress tracker evidence or financial receipts.
        return {'status': 'failed:' + type(exc).__name__}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--app', required=True, choices=THEMES)
    ap.add_argument('--order', required=True)
    ap.add_argument('--dir')
    ap.add_argument('--items-file')
    ap.add_argument('--data-file', help='fixture/status JSON; never contacts a provider')
    ap.add_argument('--vertical')
    ap.add_argument('--send', action='store_true', help='retry an enrolled card with its retained idempotency key')
    ap.add_argument('--repair-link', action='store_true', help='explicitly send a replacement for a changed public URL')
    ap.add_argument('--loop', type=int, default=0, help='legacy compatibility; watcher hooks are preferred')
    ap.add_argument('--hours', type=float, default=4)
    a = ap.parse_args(argv)
    if not re.fullmatch('[A-Za-z0-9_-]{1,80}', a.order):
        ap.error('Invalid order ID')
    cfg = read(ROOT / 'orders' / f'order-{a.app}-{a.order.lower()}.json')
    cfg.update(app=a.app, order=a.order)
    if (a.send or a.repair_link) and (a.data_file or a.dir or not cfg.get('delivery_card')):
        ap.error('--send requires a registered, enrolled order; no fixture or custom directory')
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
        if a.send:
            result['delivery_card'] = safe_sync(cfg, data, send=True)
        if a.repair_link:
            result['repair'] = repair_link(cfg,data)
        print(json.dumps(result), flush=True)
        if not a.loop or result['stage'] in ('Delivered', 'Cancelled') or time.time() >= end:
            break
        time.sleep(max(60, a.loop))


if __name__ == '__main__':
    main()
