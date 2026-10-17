"""Bounded read-only Shops UI fallback; no cart/item buttons are pressed."""
import importlib.util
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from phone_guard import held


def search_shops(query, limit, timeout):
    from careem_search import SearchError, price
    if held():
        raise SearchError('PHONE_BUSY')
    spec = importlib.util.spec_from_file_location('careem_phone', Path.home() / '.config/opencode/skills/productivity/android-phone/scripts/ph.py')
    ph = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ph)
    end = time.monotonic() + max(timeout, 30)

    def guard():
        if held():
            raise SearchError('PHONE_BUSY')
        if time.monotonic() > end:
            raise SearchError('UI_TIMEOUT')

    def nodes():
        guard()
        return ph.nodes()

    def action(fn, *args, **kwargs):
        guard()
        fn(*args, **kwargs)

    def tap_node(node):
        action(ph.d().click, node['x'], node['y'])

    def wait(predicate):
        while True:
            ns = nodes()
            found = predicate(ns)
            if found:
                return found
            time.sleep(.25)

    def match(ns, label):
        return next((n for n in ns if n['pkg'] == 'com.careem.acma' and label in (n['t'], n['c'], n['rid'])), None)

    action(subprocess.run, ['adb', '-s', ph.SERIAL, 'shell', 'am', 'start', '-n',
                           'com.careem.acma/com.careem.acma.ui.NavActivity'],
           capture_output=True, timeout=10)
    # Back only through existing screens until Shops home or super-app home.
    for _ in range(7):
        ns = nodes()
        if match(ns, 'Type to search...') or match(ns, 'Shops'):
            break
        if any('Continue with phone' in n['t'] for n in ns):
            raise SearchError('LOGIN_REQUIRED')
        action(ph.d().press, 'back')
        time.sleep(.3)
    ns = nodes()
    if match(ns, 'Shops'):
        tap_node(match(ns, 'Shops'))
    wait(lambda ns: match(ns, 'Type to search...'))
    ns = nodes()
    if not match(ns, 'Home'):
        raise SearchError('HOME_MISMATCH')
    # Opening the location sheet is read-only; never select or edit an address.
    tap_node(match(ns, 'location-picker'))
    address_nodes = wait(lambda ns: ns if any('Banyan' in n['t'] or 'banyan' in n['t'] for n in ns) else None)
    address_text = ' '.join(n['t'] for n in address_nodes)
    if '2104' not in address_text:
        raise SearchError('HOME_ADDRESS_UNVERIFIED')
    action(ph.d().press, 'back')
    tap_node(wait(lambda ns: match(ns, 'Type to search...')))
    field = wait(lambda ns: match(ns, 'SearchInput'))
    tap_node(field)
    action(ph.d().send_keys, query, clear=True)
    wait(lambda ns: any(n['rid'] == 'SearchInput' and n['t'] == query for n in ns))
    action(ph.d().press, 'enter')
    ns = wait(lambda ns: ns if any(n['rid'].startswith('item_card_') for n in ns)
              or any('no results' in n['t'].lower() or 'no matches' in n['t'].lower() for n in ns) else None)
    # Require stable fresh results after submission, never reuse a prior tree.
    previous = None
    for _ in range(8):
        guard()
        xml = ph.d().dump_hierarchy(compressed=False)
        if xml == previous:
            break
        previous = xml
        time.sleep(.3)
    root = ET.fromstring(xml)
    items = []
    store, eta = None, None
    pending = []
    for node in root.iter('node'):
        a = node.attrib
        if a.get('package') != 'com.careem.acma':
            continue
        label = a.get('text', '')
        if re.fullmatch(r'\d+\s*-\s*\d+ mins', label):
            eta = label
            store = pending[-1] if pending else None
        if label:
            pending.append(label)
        rid = a.get('resource-id', '').split('/')[-1]
        if not rid.startswith('item_card_'):
            continue
        labels = [n.get('text') for n in node.iter('node') if n.get('text')]
        prices = [s for s in labels if '⃎' in s or s.startswith('AED ')]
        names = [s for s in labels if s not in prices and not re.search(r'%|\boff\b', s, re.I)]
        if not names or not prices:
            continue
        name = names[0]
        items.append({'id': rid.removeprefix('item_card_'), 'name': name, 'price': price(prices[0]),
                      'currency': 'AED', 'store': store, 'eta': eta, 'delivery_fee': None,
                      'query_match': query.casefold() in name.casefold(), 'availability': 'listed_in_app'})
    return {'source': 'android_ui', 'account': {'authenticated': True, 'pricing': 'app'},
            'location': {'name': 'Home — Banyantree Residences Hillside, Flat 2104',
                         'saved_address_verified': True},
            'results': items[:limit], 'fetched_count': len(items), 'truncated': True,
            'pagination': 'visible_screen_only',
            'warning': 'Careem may return related or irrelevant products; check query_match. Fees are not exposed here.'}
