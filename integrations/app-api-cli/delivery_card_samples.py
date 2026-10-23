#!/usr/bin/env python3
"""Offline delivery card samples for the compact-bubble acceptance set (card-check).

Writes one public card directory per case and prints {"state", "dir"} per line.
Reads no tracker state and contacts nothing."""
import argparse
import datetime as dt
import json
from pathlib import Path

import delivery_cards as dc

PIZZA = 'Spicy Chicken Ranch Pizza with Cheese'
BASE = 'Large, thin crust, stuffed cheese'
FOOD = {'app': 'talabat', 'order': '4670610680', 'label': 'Talabat order', 'vertical': 'restaurants',
        'store': 'ZeroFat', 'total': 'AED 141.70'}
GROCERY = {'app': 'noon', 'order': 'NN41907736', 'label': 'noon NowNow order', 'vertical': 'nownow',
           'store': 'noon NowNow', 'total': 'AED 58.25'}
# What the card was registered with (line totals, no choices) and what tracking reads back.
FOOD_META = [{'name': 'Organic Eggs', 'qty': 1, 'line_total': 22.5},
             {'name': 'Grilled Shrimp', 'qty': 1, 'line_total': 40.5},
             {'name': 'Grilled Shrimp', 'qty': 1, 'price': 0.0, 'line_total': 73.8}]
FOOD_READ = [{'name': 'Organic Eggs', 'quantity': 1},
             {'name': 'Grilled Shrimp', 'quantity': 1, 'choices': '200g, Satay Sauce, Sweet Potato'},
             {'name': 'Grilled Shrimp', 'quantity': 1, 'choices': '100g, Plain'}]
GROCERY_META = [{'name': 'Al Ain Fresh Full Cream Milk 1L', 'qty': 2, 'price': 6.25},
                {'name': 'Barakat Fresh Orange Juice 1L', 'qty': 1, 'price': 13.5},
                {'name': 'Almarai Greek Yoghurt Plain 4 x 150g', 'qty': 1, 'price': 17.75},
                {'name': 'Bananas Philippines 1kg', 'qty': 1, 'price': 8.95}]
EXTRA = [{'name': f'Extra item {n}', 'qty': 1} for n in range(1, 4)]
PARTIAL = {'whole_order_complete': False, 'partial_evidence': [{'stage': 'delivered'}]}


def pizzas(*choices):
    return [{'name': PIZZA, 'quantity': 1, 'choices': c} for c in choices]


def cases():
    """name -> (cfg, data, meta, minutes since the last check). Each one is a layout risk seen
    on a real bubble: every stage, no ETA, worded dates, long names, variants, many rows."""
    food = lambda data, meta=FOOD_META, **cfg: ({**FOOD, **cfg}, {'items': FOOD_READ, **data}, {'items': meta})
    shop = lambda data, meta=GROCERY_META, **cfg: ({**GROCERY, **cfg}, data, {'items': meta})
    pizza = lambda *c: ({**FOOD, 'store': 'Pizza Hut', 'total': 'AED 104.00'},
                        {'status': 'preparing', 'eta_text': 'Arrives in 25-35 mins', 'items': pizzas(*c)},
                        {'items': [{'name': PIZZA, 'qty': 1, 'price': 52} for _ in c]})
    out = {
        'awaiting': food({'status': 'pending confirmation'}),
        'confirmed': food({'status': 'confirmed', 'eta_text': 'Arrives in 35-45 mins'}),
        'preparing': food({'status': 'preparing', 'eta_text': 'Arrives in 25-35 mins'}),
        'pickedup': food({'status': 'picked up', 'eta_text': 'Arrives in 12 mins'}),
        'ontheway': food({'status': 'out for delivery', 'eta_text': 'Arrives in 8 mins'}),
        'nearby': food({'status': 'nearby', 'eta_text': 'Arrives in 2 mins'}),
        'delivered': food({'status': 'delivered'}),
        'cancelled': food({'status': 'cancelled'}),
        'pending': food({'status': 'unknown'}),
        'noeta': food({'status': 'preparing'}),
        'noitems': ({**FOOD, 'total': None}, {'status': 'preparing', 'eta_text': 'Arrives in 25-35 mins'}, {}),
        'stale': (*food({'status': 'preparing', 'eta_text': 'Arrives in 25-35 mins', 'errors': ['timeout']}), 12),
        'late': (*food({'status': 'preparing', 'eta_text': 'Arrives in 1 min'}), 3),
        'partial': (*food({'status': 'out for delivery', 'eta_text': 'Arrives in 8 mins', **PARTIAL},
                          FOOD_META + EXTRA), 7),
        'latepartial': (*food({'status': 'out for delivery', 'eta_text': 'Arrives in 1 min', **PARTIAL},
                              FOOD_META + EXTRA), 3),
        'sample': (lambda c, d, m: (c, d, {**m, 'sample': True}))(*food({'status': 'out for delivery', 'eta_text': 'Arrives in 8 mins'})),
        'longstore': food({'status': 'preparing', 'eta_text': 'Arrives in 25-35 mins'},
                          store='The Cheesecake Factory - Dubai Mall'),
        'dated': food({'status': 'preparing', 'eta_text': 'Arrives in 26 hours'}),
        'worded': shop({'status': 'out for delivery', 'eta_text': 'Expected Wednesday 23 September', **PARTIAL},
                       GROCERY_META + EXTRA, vertical='main', order='N52791133', store='noon'),
        'window': shop({'status': 'out for delivery',
                        'eta_text': 'Expected Wednesday 23 September between 17:00 and 19:00'},
                       vertical='main', order='N52791133', store='noon'),
        'tomorrow': shop({'status': 'confirmed', 'eta_text': 'Estimated delivery: Tomorrow, 5 PM'},
                         app='amazon', order='407-1849925-6612307', vertical='same-day', store='Amazon.ae',
                         label='Amazon order'),
        'packing': shop({'status': 'preparing', 'eta_text': 'Arrives in 14 mins'}),
        'packed': shop({'status': 'packed', 'eta_text': 'Arrives in 11 mins'}),
        'intransit': shop({'status': 'picked up', 'eta_text': 'Arrives in 9 mins'}),
        'outfordelivery': shop({'status': 'out for delivery', 'eta_text': 'Arrives in 6 mins'}),
        'grocerydelivered': shop({'status': 'delivered'}),
        'quik': shop({'status': 'preparing', 'eta_text': 'Arrives in 18 mins'}, app='careem', order='CQ88213',
                     vertical='quik', store='Careem Quik', label='Careem order'),
        'photos': shop({'status': 'out for delivery', 'eta_text': 'Arrives in 6 mins'},
                       [{**i, 'image_url': f'photo-{n}.png'} for n, i in enumerate(GROCERY_META)]),
        'pizza': pizza('No Jalapenos', 'Extra Jalapenos'),
        'pizzalong': pizza(f'{BASE}, No Jalapenos', f'{BASE}, Extra Jalapenos'),
        'pizza3': pizza(f'{BASE}, No Jalapenos', f'{BASE}, Extra Jalapenos',
                        'Small, thick crust, regular cheese, No Jalapenos'),
        'pizzacomma': pizza('Large, Half & Half (Chicken, Beef)', 'Large, Half & Half (Chicken, Tofu)'),
        'pizzasuper': pizza(*(f'{BASE}, {x}' for x in ('Cheese', 'Olives', 'Cheese, Olives'))),
        'pizzacover': pizza(*(f'{BASE}, {x}' for x in ('Chicken, Bacon, Extra cheese', 'Beef, Olives, Extra cheese',
                                                       'Chicken, Bacon, Beef, Olives'))),
        'pizzalead': pizza('Half & Half (Chicken, Beef), Large', 'Half & Half (Chicken, Tofu), Large'),
        'pizzaarabic': pizza(*('حجم كبير، عجينة رقيقة، جبنة محشوة, ' + x for x in ('بدون فلفل', 'فلفل إضافي'))),
    }
    return {k: v if len(v) == 4 else (*v, 0) for k, v in out.items()}


def photo(path, n):
    from PIL import Image
    Image.new('RGB', (112, 112), ('#e8d9b5', '#f2a65a', '#f7f3ea', '#f5d547')[n % 4]).save(path)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--out', required=True)
    ap.add_argument('--only', help='comma-separated case names')
    a = ap.parse_args(argv)
    now = dt.datetime.now(dt.timezone.utc)
    pick = set(a.only.split(',')) if a.only else None
    for name, (cfg, data, meta, age) in cases().items():
        if pick and name not in pick:
            continue
        folder = Path(a.out) / name
        data = {**data, 'checked_at': (now - dt.timedelta(minutes=age)).isoformat()}
        dc.build({k: v for k, v in cfg.items() if v is not None}, data, meta, outdir=folder, public=True)
        for n, row in enumerate(meta.get('items', [])):
            if str(row.get('image_url', '')).startswith('photo-'):
                photo(folder / row['image_url'], n)
        print(json.dumps({'state': name, 'dir': str(folder)}), flush=True)


if __name__ == '__main__':
    main()
