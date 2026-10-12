"""Read-only Amazon.ae order DOM projection; no browser/session/network client.

Evaluate DIA_EXTRACTOR through the supported Dia Personal dia_evaluate tool on
an explicitly selected orders tab, then call parse_dia_result. Credentials stay
in the browser. This is NOT a whole-order completion reducer or email replacement.
Selectors adapted from alexdlaird/amazon-orders (MIT, Alex Laird 2024-2025);
see AMAZON-BROWSER-ORDERS.md for the license and observed compatibility.
"""
import datetime as dt
from decimal import Decimal
import re
from urllib.parse import urlsplit

SCHEMA = 'amazon.ae.orders.dom.v1'
SOURCE = 'amazon_browser_dom'
ORDER_ID = re.compile(r'\d{3}-\d{7}-\d{7}', re.ASCII)
MONTHS = 'January February March April May June July August September October November December'.split()
DATE = re.compile(r'(\d{1,2}) (' + '|'.join(MONTHS) + r') (\d{4})', re.I)
ORIGINS = {'https://www.amazon.ae', 'https://amazon.ae'}
PATHS = {
    'history': re.compile(r'/(?:gp/your-account/order-history|your-orders/orders)(?:/ref=[^/?#]+)?/?$'),
    'details': re.compile(r'/your-orders/order-details(?:/ref=[^/?#]+)?/?$'),
}

# Returns a bounded, allowlisted DOM projection, never raw HTML, hrefs, cookies,
# titles, recipient/address/payment data, scripts, hidden form fields or inputs.
# This expression has no navigation, clicks, auth, fetch/XHR or storage access.
DIA_EXTRACTOR = r"""(async () => {
  const schema = 'amazon.ae.orders.dom.v1';
  const origin = location.origin, path = location.pathname;
  const history = /^\/(gp\/your-account\/order-history|your-orders\/orders)(\/ref=[^/?#]+)?\/?$/.test(path);
  const details = /^\/your-orders\/order-details(\/ref=[^/?#]+)?\/?$/.test(path);
  if (!['https://www.amazon.ae', 'https://amazon.ae'].includes(origin))
    return {schema, error: 'UNSUPPORTED_ORIGIN'};
  const challenge = !!document.querySelector(
    'input[type="password"], #ap_email, #auth-mfa-otpcode, #captchacharacters, '
    + 'form[name="signIn"], #auth-mfa-form, #verification-code-form, '
    + '#aa-challenge-page-captcha-container, .amzn-captcha-modal, '
    + 'form[action$="validateCaptcha"], script[src*="awswaf.com"]');
  if (challenge || /\/(ap|errors)\//.test(path)) return {schema, error: 'AUTH_OR_CHALLENGE_REQUIRED'};
  if (!history && !details) return {schema, error: 'UNSUPPORTED_PAGE'};
  const lang = document.documentElement.lang.toLowerCase();
  if (!/^en(?:-|$)/.test(lang)) return {schema, error: 'UNSUPPORTED_LANGUAGE'};
  if (document.readyState !== 'complete') return {schema, error: 'PAGE_NOT_READY'};
  let truncated = false;
  const text = e => (e?.textContent || '').replace(/\s+/g, ' ').trim();
  const bounded = t => { if (t.length > 512) truncated = true; return t.slice(0, 512); };
  const first = (e, selectors) => {
    for (const s of selectors) { const found = e.querySelector(s); if (found) return found; }
    return null;
  };
  const list = (e, s, max) => {
    const xs = Array.from(e.querySelectorAll(s));
    if (xs.length > max) truncated = true;
    return xs.slice(0, max);
  };
  const outermost = xs => xs.filter(x => !xs.some(y => x !== y && y.contains(x)));
  const orderID = t => {
    const m = t.match(/^(?:Order\s*(?:#|number:?)\s*)?(\d{3}-\d{7}-\d{7})$/i);
    return m ? m[1] : null;
  };
  const key = async t => Array.from(new Uint8Array(await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(t)))).map(x => x.toString(16).padStart(2, '0')).join('');
  const roots = history ? Array.from(document.querySelectorAll('.order-card'))
                        : Array.from(document.querySelectorAll('#orderDetails'));
  if (!roots.length) return {schema, error: 'NO_SUPPORTED_ORDER_CARDS'};
  if (roots.length > 100) truncated = true;
  const orders = [];
  for (const root of roots.slice(0, 100)) {
    const id_text = bounded(text(first(root, history ?
      ['.yohtmlc-order-id span[dir="ltr"]', '.yohtmlc-order-id bdi[dir="ltr"]'] :
      ['[data-component="orderId"]'])));
    const oid = orderID(id_text);
    const placed_text = bounded(text(first(root, history ?
      ['.order-header .a-span3', '.order-header .a-span12'] : ['[data-component="orderDate"]'])));
    // Detail total/charge-summary variants are not yet verified; do not guess.
    const total_text = history ? bounded(text(root.querySelector('.order-header .a-span2'))) : '';
    const shipmentNodes = outermost(list(root, history ? '.delivery-box' :
      '[data-component="shipments"] .a-box', 50));
    const shipments = [];
    for (const box of shipmentNodes) {
      const statusNodes = history ? list(box, '.delivery-box__primary-text', 5) :
        list(box, 'h4.od-status-message', 5);
      if (history && !statusNodes.length)
        statusNodes.push(...list(box, '.yohtmlc-shipment-status-primaryText', 5));
      const status_texts = Array.from(new Set(statusNodes.map(x => bounded(text(x))).filter(Boolean)));
      const items = [];
      const itemNodes = outermost(list(box, history ? '.item-box' :
        '[data-component="purchasedItems"] .a-fixed-left-grid', 100));
      for (const item of itemNodes) {
        const link = item.querySelector('a[href*="/dp/"]');
        let asin = null;
        if (link) {
          try {
            const u = new URL(link.getAttribute('href'), location.href);
            if (['https://www.amazon.ae', 'https://amazon.ae'].includes(u.origin) && !u.username && !u.password)
              asin = u.pathname.match(/\/dp\/([A-Z0-9]{10})(?:\/|$)/)?.[1] || null;
          } catch (_) { /* Unsupported link, no item identity. */ }
        }
        items.push({asin, quantity_text: bounded(text(first(item,
          ['.od-item-view-qty', 'span.item-view-qty', 'span.product-image__qty', '[data-component="quantity"]'])))});
      }
      const keys = [], links = list(box, 'a[href*="/progress-tracker/package"]', 50);
      for (const a of links) {
        try {
          const u = new URL(a.getAttribute('href'), location.href);
          if (!['https://www.amazon.ae', 'https://amazon.ae'].includes(u.origin) || u.username || u.password ||
              !/^\/progress-tracker\/package(?:\/ref=[^/?#]+)?\/?$/.test(u.pathname)) continue;
          const ids = u.searchParams.getAll('orderId'), sids = u.searchParams.getAll('shipmentId');
          const indexes = u.searchParams.getAll('packageIndex');
          if (!oid || ids.length !== 1 || ids[0] !== oid || sids.length !== 1 ||
              !/^[A-Za-z0-9_-]{1,160}$/.test(sids[0]) || indexes.length > 1 ||
              (indexes.length && !/^\d{1,4}$/.test(indexes[0]))) continue;
          keys.push(await key(['amazon.ae', oid, sids[0], indexes[0] || ''].join('|')));
        } catch (_) { /* Unknown tracking identity; never copy the URL. */ }
      }
      shipments.push({status_texts, items, shipment_keys: Array.from(new Set(keys))});
    }
    orders.push({id_text, placed_text, total_text, shipments,
      unsupported_layout: !!root.querySelector('.yo-enhanced-flex-card, .yo-enhanced-card, .brand-info-box')});
  }
  return {schema, origin, path, lang, ready: true, challenge: false,
    kind: history ? 'history' : 'details', orders, observed_order_cards: roots.length,
    advertised_count_text: history ? bounded(text(first(document,
      ['.time-filter__label', '.js-yo-container span.num-orders']))) : '',
    next_page_present: !!document.querySelector('ul.a-pagination li.a-last:not(.a-disabled) a'), truncated};
})()"""


class BrowserOrdersError(ValueError):
    """Safe error code only; never echo browser response contents."""


def _fail(code):
    raise BrowserOrdersError(code)


def _text(value):
    if not isinstance(value, str) or len(value) > 512:
        _fail('INVALID_SNAPSHOT')
    return ' '.join(value.split())


def _list(value, maximum):
    if not isinstance(value, list) or len(value) > maximum:
        _fail('INVALID_SNAPSHOT')
    return value


def _object(value):
    if not isinstance(value, dict):
        _fail('INVALID_SNAPSHOT')
    return value


def _order_id(value):
    m = re.fullmatch(r'(?:Order\s*(?:#|number:?)\s*)?(\d{3}-\d{7}-\d{7})', _text(value), re.I | re.ASCII)
    return m[1] if m else None


def _date(value):
    match = DATE.fullmatch(value)
    if not match:
        return None
    try:
        return dt.date(int(match[3]), next(i + 1 for i, m in enumerate(MONTHS)
                                         if m.lower() == match[2].lower()), int(match[1]))
    except ValueError:
        return None


def _observed(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.utcoffset() is None:
            raise ValueError
        return parsed
    except (ValueError, TypeError, AttributeError):
        _fail('TIMEZONE_AWARE_OBSERVATION_REQUIRED')


def classify_status(text, *, observed_at):
    """Primary status only. No page-wide keyword matching or inferred timestamps."""
    now = _observed(observed_at).astimezone(dt.timezone(dt.timedelta(hours=4))).date()
    text = _text(text).lower()
    exact = {'cancelled': 'cancelled', 'canceled': 'cancelled', 'return started': 'return_requested',
             'return requested': 'return_requested', 'return received': 'returned',
             'refund issued': 'refunded', 'out for delivery': 'out for delivery',
             'shipped': 'shipped', 'dispatched': 'shipped', 'delivered': 'delivered',
             'delivered today': 'delivered', 'delivered yesterday': 'delivered'}
    if text in exact:
        return exact[text]
    delivered = re.fullmatch(r'delivered (?:on )?(\d{1,2} [a-z]+(?: \d{4})?)'
                             r'(?: at (?:[1-9]|1[0-2]):[0-5][0-9] (?:am|pm))?', text)
    if delivered:
        date_text = delivered[1]
        if not re.search(r'\b\d{4}$', date_text):
            date_text += ' ' + str(now.year)
        day = _date(date_text)
        if day and day <= now:
            return 'delivered'
    return 'unknown'


def parse_snapshot(snapshot, *, profile_name, observed_at, expected_order_id=None):
    """Offline parser for DIA_EXTRACTOR's projection, not arbitrary HTML/JSON.

    Caller-supplied projection is not authentication proof. Production callers
    must use parse_dia_result to bind it to the exact supported Dia tool response.
    All completion flags stay false, including on a one-card detail page.
    """
    if profile_name != 'Personal':
        _fail('PERSONAL_PROFILE_REQUIRED')
    observed = _observed(observed_at).isoformat()
    if expected_order_id is not None and (not isinstance(expected_order_id, str) or
                                         not ORDER_ID.fullmatch(expected_order_id)):
        _fail('INVALID_ORDER_ID')
    s = _object(snapshot)
    if s.get('schema') != SCHEMA:
        _fail('UNSUPPORTED_SCHEMA')
    if 'error' in s:
        known = {'UNSUPPORTED_ORIGIN', 'AUTH_OR_CHALLENGE_REQUIRED', 'UNSUPPORTED_PAGE',
                 'UNSUPPORTED_LANGUAGE', 'PAGE_NOT_READY', 'NO_SUPPORTED_ORDER_CARDS'}
        _fail(s['error'] if isinstance(s['error'], str) and s['error'] in known else 'INVALID_SNAPSHOT')
    if not isinstance(s.get('origin'), str) or s['origin'] not in ORIGINS:
        _fail('UNSUPPORTED_ORIGIN')
    kind = s.get('kind')
    if not isinstance(kind, str) or kind not in PATHS or not PATHS[kind].fullmatch(_text(s.get('path'))):
        _fail('UNSUPPORTED_PAGE')
    if not re.fullmatch(r'en(?:-[a-z0-9]+)*', _text(s.get('lang')).lower()):
        _fail('UNSUPPORTED_LANGUAGE')
    if s.get('challenge') is not False:
        _fail('AUTH_OR_CHALLENGE_REQUIRED')
    if s.get('ready') is not True:
        _fail('PAGE_NOT_READY')
    if type(s.get('truncated')) is not bool or type(s.get('next_page_present')) is not bool:
        _fail('INVALID_SNAPSHOT')
    rows = _list(s.get('orders'), 100)
    if not rows:
        _fail('NO_SUPPORTED_ORDER_CARDS')
    if type(s.get('observed_order_cards')) is not int or s['observed_order_cards'] < len(rows):
        _fail('INVALID_SNAPSHOT')
    if s['observed_order_cards'] != len(rows) and not s['truncated']:
        _fail('INVALID_SNAPSHOT')
    orders, invalid_cards, seen = [], 0, set()
    for row in rows:
        row = _object(row)
        oid = _order_id(row.get('id_text'))
        if oid is None:
            invalid_cards += 1
            continue
        if oid in seen:
            _fail('DUPLICATE_ORDER_ID')
        seen.add(oid)
        warnings = ['whole_order_manifest_unverified']
        if row.get('unsupported_layout') is not False:
            warnings.append('unsupported_item_layout')
        placed_text = re.sub(r'^order placed\s*', '', _text(row.get('placed_text')), flags=re.I)
        placed = _date(placed_text)
        money = re.fullmatch(r'(?:total\s*)?AED\s*((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})',
                             _text(row.get('total_text')), re.I)
        total = str(Decimal(money[1].replace(',', ''))) if money else None
        shipments = []
        for raw in _list(row.get('shipments'), 50):
            raw = _object(raw)
            statuses = list(dict.fromkeys(_text(x) for x in _list(raw.get('status_texts'), 5) if x))
            stage = classify_status(statuses[0], observed_at=observed) if len(statuses) == 1 else 'unknown'
            issues = []
            if len(statuses) != 1:
                issues.append('missing_or_conflicting_primary_status')
            keys = _list(raw.get('shipment_keys'), 50)
            if any(not isinstance(k, str) or not re.fullmatch('[a-f0-9]{64}', k) for k in keys):
                _fail('INVALID_SNAPSHOT')
            keys = sorted(set(keys))
            if len(keys) != 1:
                issues.append('missing_or_ambiguous_shipment_identity')
            items = []
            for raw_item in _list(raw.get('items'), 100):
                raw_item = _object(raw_item)
                asin = raw_item.get('asin')
                if asin is not None and (not isinstance(asin, str) or not re.fullmatch('[A-Z0-9]{10}', asin)):
                    _fail('INVALID_SNAPSHOT')
                quantity = re.fullmatch(r'(?:(?:qty|quantity)\s*:?\s*)?([1-9][0-9]{0,3})',
                                        _text(raw_item.get('quantity_text')), re.I)
                items.append({'asin': asin, 'quantity': int(quantity[1]) if quantity else None})
            if not items or any(x['quantity'] is None or x['asin'] is None for x in items):
                issues.append('item_identity_or_quantity_unverified')
            shipments.append({'scope': 'shipment', 'stage': stage, 'status_texts': statuses,
                              'shipment_key': keys[0] if len(keys) == 1 else None,
                              'items': items, 'manifest_complete': False,
                              'evidence_at': None, 'observed_at': observed, 'warnings': issues})
        stages = {x['stage'] for x in shipments}
        orders.append({'order_id': oid, 'placed_date': placed.isoformat() if placed else None,
                       'total': {'currency': 'AED', 'amount': total} if total is not None else None,
                       'visible_stage': next(iter(stages)) if len(stages) == 1 else 'unknown',
                       'shipments': shipments, 'whole_order_delivered': False, 'terminal': False,
                       'manifest_complete': False, 'warnings': warnings})
    parsed_count = len(orders)
    if expected_order_id is not None:
        orders = [x for x in orders if x['order_id'] == expected_order_id]
        if not orders:
            _fail('ORDER_NOT_ON_THIS_PAGE')
    count = re.fullmatch(r'(\d[\d,]*) orders?(?: placed in)?', _text(s.get('advertised_count_text')), re.I)
    return {'source': SOURCE, 'schema': SCHEMA, 'page_kind': kind, 'observed_at': observed,
            'orders': orders, 'coverage': {
                'scope': 'rendered_page_only', 'observed_cards': s['observed_order_cards'],
                'parsed_cards': parsed_count, 'invalid_cards': invalid_cards,
                'advertised_orders_in_filter': int(count[1].replace(',', '')) if count else None,
                'next_page_present': s['next_page_present'], 'truncated': s['truncated'],
                'scan_complete': False, 'whole_history_complete': False},
            'fallback': 'amazon_email_orders', 'tracker_integration_enabled': False}


def parse_dia_result(response, *, tab_id, target_id, observed_at, expected_order_id=None):
    """Validate exact Personal tab/target and origin around a dia_evaluate result.

    No tool invocation or side effect occurs here. Parent owns the actual Dia
    call and unwrapping its MCP JSON transport into this mapping.
    """
    response = _object(response)
    if not tab_id or not target_id or response.get('profileName') != 'Personal':
        _fail('DIA_BINDING_MISMATCH')
    target = response.get('target', {})
    # Target.getTargets uses targetId; /json/list optionally contributes id.
    # getBrowserTargets merges both, but id is not guaranteed to be present.
    actual_id = target.get('targetId', target.get('id')) if isinstance(target, dict) else None
    if (not isinstance(target, dict) or response.get('diaTabId') != tab_id or
            actual_id != target_id or target.get('type') != 'page' or
            ('id' in target and target['id'] != actual_id)):
        _fail('DIA_BINDING_MISMATCH')
    result = response.get('result', {})
    if not isinstance(result, dict) or result.get('exceptionDetails'):
        _fail('DIA_EVALUATION_FAILED')
    remote = result.get('result', {})
    if not isinstance(remote, dict) or remote.get('type') != 'object':
        _fail('DIA_EVALUATION_FAILED')
    snapshot = _object(remote.get('value'))
    try:
        url = urlsplit(target.get('url', ''))
        origin = f'{url.scheme}://{url.netloc}'
    except (ValueError, TypeError, AttributeError):
        _fail('DIA_LOCATION_MISMATCH')
    if origin not in ORIGINS:
        _fail('DIA_LOCATION_MISMATCH')
    # Error projections contain no page data (e.g. normal sign-in challenge).
    if 'error' not in snapshot and (origin != snapshot.get('origin') or url.path != snapshot.get('path')):
        _fail('DIA_LOCATION_MISMATCH')
    return parse_snapshot(snapshot, profile_name='Personal', observed_at=observed_at,
                          expected_order_id=expected_order_id)
