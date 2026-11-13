"""Read-only same-store product matching, retaining each source's account context."""
import argparse
import json
import subprocess
import time
from pathlib import Path
from common import item_matches, money


def run(app, section, terms, limit=10, open_only=False, timeout=30):
    if len(terms) < 2 or any(not t.strip() for t in terms):
        raise ValueError('USAGE: provide at least two nonempty item terms')
    if app == 'talabat':
        # Retired by the owner 2026-11-07; see talabat_retired.py.
        import talabat_retired
        raise ValueError(f'{talabat_retired.CODE}: {talabat_retired.MESSAGE}')
    valid = {'noon': ['main', 'minutes', 'nownow'], 'careem': ['quik', 'shops', 'electronics']}
    if section not in valid.get(app, []) or not 1 <= limit <= 100:
        raise ValueError('USAGE: unsupported app/section')
    if open_only and section in ('main', 'minutes', 'quik'):
        raise ValueError('OPEN_STATUS_UNVERIFIED: this section does not expose verified open status')
    def one(term):
        cmd = [str(Path.home()/'.local/bin'/f'{app}-search')]
        if app == 'noon':
            cmd += ['--minutes'] if section == 'minutes' else ['nownow'] if section == 'nownow' else []
        elif app == 'talabat':
            cmd += ['--mart'] if section == 'mart' else [section]
        else:
            cmd += [section]
        cmd += [term, '--limit', '30', '--timeout', str(timeout), '--json']
        if open_only and section in ['nownow', 'groceries', 'pharmacies', 'flowers', 'shops', 'electronics']:
            cmd += ['--open']
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        d = json.loads(p.stdout)
        if p.returncode or d.get('error'):
            raise ValueError(f'SEARCH_FAILED: {app}/{section}/{term}: {d.get("error")}')
        return term, d
    # UI fallbacks share a phone; serialize searches.
    if app == 'talabat':
        from talabat_native import batch_products
        from native import NativeError
        try:
            batch = batch_products(terms, section, timeout=timeout, stores=4, open_only=open_only)
            data = list(batch.items())
        except NativeError as e:
            raise ValueError(f'SEARCH_FAILED: {e.code}') from None
    else:
        data = [one(t) for t in terms]
    stores, fallbacks = {}, []
    for term, d in data:
        fallbacks += d.get('fallbacks', [])
        groups = d.get('stores')
        if groups is None:
            key = d.get('warehouse') or d.get('merchant_id') or (d.get('store') or {}).get('id') or section
            groups = [{'store_id': key, 'store': (d.get('store') or {}).get('name') or section,
                       'items': d.get('items', d.get('results', [])), **(d.get('store') or {})}]
        for g in groups:
            key = str(g.get('store_id', g.get('merchant_id', g.get('id', section))))
            hits = [i for i in g.get('items', []) if item_matches(term, i['name']) and
                    i.get('buyable', i.get('available')) is not False]
            if not hits:
                continue
            hits.sort(key=lambda i: (i.get('price') is None, i.get('price') or 0))
            row = stores.setdefault(key, {'store_id': key, 'store': g.get('store', g.get('name')),
                                         'status': g.get('status', 'unknown'), 'matches': {}})
            row['matches'][term] = [{k: i.get(k) for k in ('id', 'name', 'price', 'size', 'image_url', 'description', 'unit_price', 'unit_price_unit')} for i in hits[:3]]
    rows = [s for s in stores.values() if len(s['matches']) == len(set(terms))]
    coverage = data[0][1].get('coverage')
    if coverage and coverage['errors'] and not coverage['product_searches_completed']:
        raise ValueError('SEARCH_FAILED: all Talabat product/status checks failed; no-match cannot be determined')
    for s in rows:
        prices = [hits[0]['price'] for hits in s['matches'].values()]
        s['item_subtotal'] = money(sum(prices)) if all(p is not None for p in prices) else None
    rows.sort(key=lambda s: (s['item_subtotal'] is None, s['item_subtotal'] or 0))
    return {'ok': True, 'app': app, 'section': section, 'terms': terms, 'stores': rows[:limit],
            'account': data[0][1].get('account'), 'location': data[0][1].get('location'),
            'fallbacks': fallbacks, 'scope': 'intersection of fetched search pages, not exhaustive',
            'coverage': data[0][1].get('coverage'),
            'notes': ['Same store/warehouse ID required. Item names only; unavailable items excluded.',
                      'Subtotal excludes delivery/service fees and is not a checkout quote.',
                      'Marketplace main is one platform, not a same-seller guarantee.']}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('app'); p.add_argument('section'); p.add_argument('terms', nargs='+')
    p.add_argument('--open', action='store_true'); p.add_argument('--limit', type=int, default=10)
    p.add_argument('--timeout', type=int, default=30)
    o = p.parse_args(); start = time.monotonic()
    try:
        d = run(o.app, o.section, o.terms, o.limit, o.open, o.timeout)
        d['elapsed_seconds'] = round(time.monotonic()-start, 2)
        print(json.dumps(d))
    except (ValueError, subprocess.TimeoutExpired) as e:
        print(json.dumps({'ok': False, 'error': 'BASKET_SEARCH_FAILED', 'message': str(e) if isinstance(e, ValueError) else 'Component search timed out; no-match cannot be determined.'}))
        raise SystemExit(1)
