"""Cross-app read-only basket search: convenience, delivery time, then cost."""
import argparse
import concurrent.futures as cf
import itertools
import json
import os
import re
import subprocess
import signal
import time
from pathlib import Path
from catalog_schema import normalize, download
from common import HOME_LAT, HOME_LNG, item_matches, money

# Talabat retired by the owner 2026-11-07 (talabat_retired.py): never searched.
SOURCES = [('noon', 'minutes'), ('noon', 'nownow'), ('careem', 'quik'),
           ('careem', 'shops')]


def strict_match(term, name):
    normalized_term = re.sub(r'(\d)\s*(ml|kg|g|l)\b', r'\1 \2', term, flags=re.I)
    normalized_name = re.sub(r'(\d)\s*(ml|kg|g|l)\b', r'\1 \2', name, flags=re.I)
    if not item_matches(normalized_term, normalized_name, synonyms=False):
        return False
    # Preserve quantities and one-character tokens ignored by legacy food search.
    requested = re.findall(r'\d+(?:\.\d+)?\s*(?:ml|kg|g|l)\b', term.lower())
    compact = re.sub(r'\s+', '', name.lower())
    if any(re.sub(r'\s+', '', size) not in compact for size in requested):
        return False
    exclusions = {'milk': r'\b(?:evaporated|condensed|chocolate|powder|soap|bath|bread|biscuit|cookies|candy|toffee|cleanser)\b',
                  'eggs': r'\b(?:chocolate|candy|noodles|pasta|biscuit)\b',
                  'banana': r'\b(?:leaves|leaf|shake|milk|chips|bread|cake|biscuit|smoothie|yogurt|powder)\b',
                  'butter': r'\b(?:peanut|almond|cashew|cookie|body|shea|cocoa|chicken)\b'}
    return not re.search(exclusions.get(term.casefold(), r'(?!)'), name, re.I)


def relevant_sources(term):
    # Pharmacy catalogs are relevant to health/personal-care requests, not every
    # loaf/banana. All general grocery storefronts are always searched.
    pharmacy = re.search(r'panadol|vitamin|medicine|tablet|capsule|cream|shampoo|tooth|marvis|dove|deodorant|sunscreen|protein|supplement|baby|diaper|bandage|ibuprofen|paracetamol', term, re.I)
    return [(a,s) for a,s in SOURCES if s != 'pharmacies' or pharmacy]


def search(app, section, term, timeout, open_only):
    command = [str(Path.home()/'.local/bin'/f'{app}-search')]
    command += ['--'+section] if section in ('minutes', 'mart') else [section]
    command += [term, '--json', '--limit', '30', '--timeout', str(timeout)]
    if app == 'noon' or app == 'talabat' and section == 'mart':
        command += ['--native']
    if app == 'talabat' and section in ('groceries', 'pharmacies'):
        command += ['--stores', '12']
    if open_only and section not in ('minutes', 'mart', 'quik'):
        command += ['--open']
    env = dict(os.environ, APP_SEARCH_NO_UI='1', APP_BASKET_FAST='1')
    try:
        # Kill the entire wrapper/Python process group on deadline; an orphaned
        # child must not keep hammering the catalog after basket returns.
        p = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, env=env, start_new_session=True)
        try:
            stdout, _ = p.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGTERM)
            p.communicate()
            return app, section, term, None, 'SEARCH_TIMEOUT'
        data = json.loads(stdout)
        if p.returncode or data.get('error'):
            return app, section, term, None, 'SEARCH_FAILED'
        return app, section, term, normalize(data), None
    except (subprocess.TimeoutExpired, ValueError):
        return app, section, term, None, 'SEARCH_TIMEOUT_OR_INVALID_RESPONSE'


def collect(results, terms, open_only=False):
    stores, errors, fallbacks = {}, [], []
    seen_issues = set()
    for app, section, term, data, error in results:
        if error:
            errors.append({'app': app, 'section': section, 'term': term, 'error': error})
            continue
        fallbacks.extend(data.get('fallbacks', []))
        for issue in data.get('coverage', {}).get('errors', []):
            if issue.get('term', term) == term:
                key = (app, section, json.dumps(issue, sort_keys=True))
                if key not in seen_issues:
                    errors.append({'app':app, 'section':section, **issue})
                    seen_issues.add(key)
        groups = data.get('stores')
        if groups is None:
            info = data.get('store') or {}
            groups = [{**info, 'store_id': data.get('warehouse') or data.get('merchant_id') or info.get('id') or section,
                       'store': info.get('name') or f'{app} {section}', 'items': data.get('items', data.get('results', []))}]
        for g in groups:
            if g.get('status') in ('closed', 'busy', 'scheduled_only'):
                continue
            if open_only and g.get('status') != 'open':
                continue
            sid = g.get('store_id', g.get('merchant_id', g.get('id')))
            if sid is None:
                continue
            key = f'{app}/{section}/{sid}'
            row = stores.setdefault(key, {**{k:v for k,v in g.items() if k != 'items'},
                                         'account': data.get('account'), 'fallbacks':data.get('fallbacks', []),
                                         'key': key, 'app': app, 'section': section, 'matches': {}})
            hits = [i for i in g.get('items', []) if strict_match(term, i.get('name') or '')
                    and i.get('available') is not False and i.get('buyable') is not False
                    and isinstance(i.get('price'), (float, int)) and i['price'] >= 0]
            hits.sort(key=lambda i: (not i.get('image_url'), i['price']))
            if hits:
                row['matches'][term] = hits[0]
    return list(stores.values()), errors, fallbacks


def make_plan(selected, terms):
    assignments = {s['key']: [] for s in selected}
    gaps = []
    for term in terms:
        candidates = [s for s in selected if term in s['matches']]
        if not candidates:
            gaps.append(term)
            continue
        best = min(candidates, key=lambda s: s['matches'][term]['price'])
        assignments[best['key']].append({'requested': term, **best['matches'][term]})
    out = []
    for s in selected:
        items = assignments[s['key']]
        if not items:
            continue
        subtotal = money(sum(i['price'] for i in items))
        fee = s.get('delivery_fee')
        minimum = s.get('min_order')
        out.append({**{k:v for k,v in s.items() if k != 'matches'}, 'items': items,
                    'item_subtotal': subtotal, 'delivery_fee': fee,
                    'min_order_gap': money(max(0, minimum-subtotal)) if minimum is not None else None,
                    'total_including_delivery': money(subtotal+fee) if fee is not None else None})
    eta = [s.get('eta_minutes') for s in out]
    totals = [s['total_including_delivery'] for s in out]
    return {'stores': out, 'order_count': len(out), 'coverage_gaps': gaps,
            'max_eta_minutes': max(eta) if eta and all(x is not None for x in eta) else None,
            'item_subtotal': money(sum(s['item_subtotal'] for s in out)),
            'total_including_delivery': money(sum(totals)) if totals and all(x is not None for x in totals) else None,
            'checkout_total': None, 'fees_complete': False,
            'visual_review_required': True,
            'minimum_order_met': all(s['min_order_gap'] == 0 for s in out) if all(s['min_order_gap'] is not None for s in out) else None}


def rank(plan):
    return (len(plan['coverage_gaps']), plan['order_count'],
            plan['max_eta_minutes'] if plan['max_eta_minutes'] is not None else float('inf'),
            plan['total_including_delivery'] if plan['total_including_delivery'] is not None else float('inf'))


def optimize(stores, terms, limit=10):
    stores = [s for s in stores if s['matches']]
    if not stores:
        return [], False
    # Exact subset coverage DP finds the minimum number of orders. Enumeration
    # below is bounded separately and explicitly reported for dense catalogs.
    masks = [sum(1 << i for i,t in enumerate(terms) if t in s['matches']) for s in stores]
    reachable = {0: 0}
    for mask in masks:
        for old, count in list(reachable.items()):
            union = old | mask
            reachable[union] = min(reachable.get(union, 1000), count+1)
    target = max(reachable, key=lambda m: (m.bit_count(), -reachable[m]))
    count = reachable[target]
    plans, checked, truncated = [], 0, False
    for indexes in itertools.combinations(range(len(stores)), count):
        checked += 1
        if checked > 100000:
            truncated = True
            break
        covered = 0
        for i in indexes:
            covered |= masks[i]
        if covered.bit_count() != target.bit_count():
            continue
        plan = make_plan([stores[i] for i in indexes], terms)
        plans.append(plan)
    plans.sort(key=rank)
    return plans[:limit], truncated


def render(data, path):
    from PIL import Image, ImageDraw, ImageFont
    font_path = '/System/Library/Fonts/Supplemental/Arial.ttf'
    font = ImageFont.truetype(font_path, 21)
    small = ImageFont.truetype(font_path, 17)
    import textwrap
    lines = ['Delivery basket', 'Convenience > time > cost']
    for idx,p in enumerate(data['plans'][:3], 1):
        lines += ['', f"{idx}. {p['order_count']} order(s) · ETA {p['max_eta_minutes'] or '?'} min",
                  f"Items + delivery: AED {p['total_including_delivery'] if p['total_including_delivery'] is not None else '?'}"]
        for s in p['stores']:
            lines += [s.get('store') or s['key']]
            for item in s['items']:
                lines += textwrap.wrap(f"{item['name']} · AED {item['price']:.2f}", 39)
        if p['coverage_gaps']:
            lines += ['Missing: '+', '.join(p['coverage_gaps'])]
    lines += ['', 'Catalog estimate; checkout fees may differ.']
    im = Image.new('RGB', (480, 50+len(lines)*29), '#f8f8fa')
    draw = ImageDraw.Draw(im)
    for n,line in enumerate(lines):
        draw.text((20, 20+n*29), line, fill='#151923', font=font if n==0 else small)
    im.save(path)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('items', nargs='+')
    p.add_argument('--json', action='store_true')
    p.add_argument('--open', action='store_true', help='Require verified open status, excluding unknown Minutes/Quik')
    p.add_argument('--images-dir')
    p.add_argument('--png')
    p.add_argument('--timeout', type=int, default=8, help='Per-component deadline, 5–60s; incomplete sources are reported')
    p.add_argument('--limit', type=int, default=10)
    o = p.parse_args()
    terms = list(dict.fromkeys(t.strip() for t in o.items if t.strip()))
    if not terms or len(terms)>12 or not 5 <= o.timeout <=60:
        p.error('Use 1–12 distinct items and timeout 5–60')
    start = time.monotonic()
    with cf.ThreadPoolExecutor(48) as pool:
        futures = [pool.submit(search,a,s,t,o.timeout,o.open) for t in terms for a,s in relevant_sources(t) if a != 'talabat']
        results = [f.result() for f in futures]
    stores, errors, fallbacks = collect(results, terms, o.open)
    plans, truncated = optimize(stores, terms, o.limit)
    data = {'ok': bool(plans), 'schema_version': 1, 'terms': terms,
            'location': {'latitude':HOME_LAT,'longitude':HOME_LNG}, 'plans': plans,
            'search_errors': errors, 'fallbacks': fallbacks, 'plan_enumeration_truncated':truncated,
            'coverage': [{'app':a, 'section':s, **d['coverage']} for a,s,t,d,e in results
                         if d and 'coverage' in d and t == terms[0]],
            'stores_searched': len(stores), 'elapsed_seconds':round(time.monotonic()-start,2),
            'notes':['Ranked by coverage, fewest orders, maximum ETA, then items plus known delivery fees.',
                     'Unknown ETA/fees sort last, never as zero. Service, small-order and account fees require checkout.',
                     'Fetched candidate pages only; strict name matching does not replace visual variant/size review.',
                     'Each requested term selects one unit. Overlapping terms may select the same SKU twice.']}
    if o.images_dir:
        download(data,o.images_dir)
    if o.png:
        render(data,o.png)
        data['summary_png'] = str(Path(o.png).resolve())
    if o.json:
        print(json.dumps(data,ensure_ascii=False,indent=2))
    else:
        for i,plan in enumerate(plans,1):
            print(f"{i}. {plan['order_count']} orders | max ETA {plan['max_eta_minutes']} min | items + delivery AED {plan['total_including_delivery']}")
            for s in plan['stores']:
                print(f"  {s.get('store') or s['key']} | fee {s.get('delivery_fee')} | ETA {s.get('eta_minutes')}")
                for item in s['items']:
                    print(f"    {item['name']} | AED {item['price']} | {item.get('size')} | {item.get('unit_price')} {item.get('unit_price_unit')} | image_url: {item.get('image_url')}")
            print('  Gaps:', ', '.join(plan['coverage_gaps']) or 'none')
        print(f"{len(errors)} component errors; {data['elapsed_seconds']}s; checkout total/extra fees unverified.")


if __name__ == '__main__':
    main()
