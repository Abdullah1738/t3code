"""Opt-in, read-only projections from the original authenticated Android app.

Native routes and delivered-order UI verified on Talabat 13.95.0. No tokens,
cart controls, HTTP calls, raw UI dumps, screenshots or payment data are used.
"""
import argparse
import datetime as dt
import fcntl
import json
import re
import signal
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

PACKAGE = 'com.talabat'
SERIAL = '002473611000997'
HOLD = Path.home() / '.local/share/phone-lock/priority-hold'
ID = re.compile(r'Order (?:ID:\s*|#)(\d{1,20})')
# Exact labels only. Unknown and future-tense text cannot certify completion.
STATUS = {'Delivered': 'delivered', 'Order delivered': 'delivered',
          'Cancelled': 'cancelled', 'Order cancelled': 'cancelled',
          'Preparing your order': 'preparing', 'Order confirmed': 'placed',
          'Out for delivery': 'out for delivery', 'Picked up': 'picked up'}


class UIError(Exception):
    pass


def guard():
    # Never reclaim/bypass a hold based on age, including our caller's hold.
    if HOLD.exists():
        raise UIError('PHONE_BUSY')


def label(node):
    return (node.get('text') or node.get('content-desc') or '').strip()


def visible(node):
    bounds = re.findall(r'-?\d+', node.get('bounds', ''))
    return (node.get('package') == PACKAGE and node.get('visible-to-user') != 'false' and len(bounds) == 4
            and int(bounds[2]) > int(bounds[0]) and int(bounds[3]) > int(bounds[1]))


def labels(xml):
    return [label(n) for n in ET.fromstring(xml).iter('node') if visible(n) and label(n)]


def status(texts):
    hits = [(t, STATUS[t]) for t in texts if t in STATUS]
    stages = {s for _, s in hits}
    if len(stages) != 1:
        return 'unknown', None
    return hits[0][1], hits[0][0]


def tracking_status(texts):
    hits = [(t, STATUS[t]) for t in texts if t in STATUS]
    # Observed on a delivered order. "Arrived" alone can mean rider arrival;
    # require this exact completion variant and both companion labels.
    early = next((t for t in texts if re.fullmatch(r'Arrived \d{1,3} mins early \.\.', t)), None)
    if early and '100%, Progress is' in texts and 'We beat the clock! Enjoy your order' in texts:
        hits.append((early, 'delivered'))
    if len({s for _, s in hits}) != 1:
        return 'unknown', None
    return hits[0][1], hits[0][0]


def base(order=None):
    return {'ok': True, 'app': 'talabat', 'order': order, 'source': 'android_ui',
            'status': 'unknown', 'eta': None, 'rider': None,
            'checked_at': dt.datetime.now(dt.timezone.utc).isoformat()}


def parse_orders(xml):
    root = ET.fromstring(xml)
    parents = {c: p for p in root.iter() for c in p}
    out = []
    seen = set()
    for node in root.iter('node'):
        match = ID.fullmatch(label(node)) if visible(node) else None
        if not match or match[1] in seen:
            continue
        # The observed order card is the immediate parent. Never borrow a
        # neighbouring card's status when the app's tree shape changes.
        parent = parents.get(node)
        if parent is None:
            continue
        texts = [label(n) for n in parent.iter('node') if visible(n) and label(n)]
        ids = {m[1] for t in texts if (m := ID.fullmatch(t))}
        if ids != {match[1]} or 'View details' not in texts:
            continue
        result = base(match[1])
        result['status'], result['raw_status'] = status(texts)
        result['identity_verified'] = True
        out.append(result)
        seen.add(match[1])
    return out


def on_orders(xml):
    root = ET.fromstring(xml)
    # Native order-list opens a standalone screen without the bottom nav.
    return ('Orders' in labels(xml) and any(visible(n) and label(n) == 'All'
            and n.get('selected') == 'true' for n in root.iter('node')))


def order_ids(xml):
    return {m[1] for t in labels(xml) if (m := ID.fullmatch(t))}


def parse_tracking(top_xml, before_xml, after_xml, order):
    upper, lower = labels(top_xml), labels(after_xml)
    # The status snapshot must be captured BETWEEN two exact identity checks,
    # not from a possibly stale header seen while the route is still loading.
    if order_ids(before_xml) != {order} or order_ids(after_xml) != {order}:
        raise UIError('ORDER_IDENTITY_UNVERIFIED')
    if order_ids(top_xml) - {order}:
        raise UIError('ORDER_IDENTITY_UNVERIFIED')
    if not any(t in upper for t in ('Your order from', 'Order delivered',
                                    'Preparing your order', 'Order confirmed',
                                    'Out for delivery', 'Order cancelled')):
        raise UIError('TRACKING_SCREEN_UNVERIFIED')
    result = base(order)
    result['status'], result['raw_status'] = tracking_status(upper + lower)
    result['identity_verified'] = True
    result['coverage'] = 'exact_order_tracking_screen; active_eta_and_rider_schema_unverified'
    return result


class Phone:
    """Small deterministic navigation plan; no arbitrary taps or URI input."""

    def __init__(self):
        self.device = None

    def adb(self, *args):
        guard()
        p = subprocess.run(['adb', '-s', SERIAL, 'shell', *args],
                           capture_output=True, text=True, timeout=12)
        guard()
        if p.returncode:
            raise UIError('PHONE_COMMAND_FAILED')
        return p.stdout

    def snapshot(self):
        guard()
        if self.device is None:
            import uiautomator2
            self.device = uiautomator2.connect(SERIAL)
        guard()
        if self.device.app_current().get('package') != PACKAGE:
            raise UIError('APP_NOT_FOREGROUND')
        guard()
        xml = self.device.dump_hierarchy(compressed=False)
        guard()
        if self.device.app_current().get('package') != PACKAGE:
            raise UIError('APP_NOT_FOREGROUND')
        guard()
        return xml

    def stable(self, predicate, seconds=8):
        deadline, previous = time.monotonic() + seconds, None
        while time.monotonic() < deadline:
            xml = self.snapshot()
            texts = labels(xml)
            if any('Continue with phone' in t or t == 'Log in' for t in texts):
                raise UIError('LOGIN_REQUIRED')
            if predicate(xml) and texts == previous:
                return xml
            previous = texts
            time.sleep(.2)
        raise UIError('UI_SCHEMA_CHANGED_OR_TIMEOUT')

    def route(self, uri):
        result = self.adb('am', 'start', '-W', '-a', 'android.intent.action.VIEW',
                          '-d', uri, '-n', PACKAGE + '/.FlutterLandingScreen')
        if 'Error:' in result or 'Status: ok' not in result:
            raise UIError('NATIVE_ROUTE_FAILED')

    def orders(self):
        self.route('talabat://order-list')
        xml = self.stable(on_orders)
        rows = parse_orders(xml)
        if not rows:
            raise UIError('NO_VERIFIED_VISIBLE_ORDERS')
        return {'ok': True, 'app': 'talabat', 'source': 'android_ui', 'orders': rows,
                'coverage': 'visible_order_cards_only; not_full_history',
                'truncated': True, 'checked_at': base()['checked_at']}

    def swipe(self, direction):
        guard()
        self.device.swipe_ext(direction, scale=.65)
        guard()
        return self.stable(lambda x: bool(labels(x)), seconds=4)

    def identity(self, current, order):
        for attempt in range(4):
            ids = order_ids(current)
            if ids:
                if ids != {order}:
                    raise UIError('ORDER_IDENTITY_UNVERIFIED')
                return current
            if attempt == 3:
                break
            current = self.swipe('up')
        raise UIError('ORDER_IDENTITY_UNVERIFIED')

    def track(self, order):
        # Establish an unrelated verified screen so a rejected route cannot
        # silently reuse the previous tracking screen.
        self.orders()
        self.route('talabat:///order-tracking?orderId=' + order)
        initial = self.stable(lambda x: any(t in labels(x) for t in (
            'Your order from', 'Order delivered', 'Preparing your order',
            'Order confirmed', 'Out for delivery', 'Order cancelled')))
        before = self.identity(initial, order)
        # Discard all pre-identity status. The app can preserve a stale header
        # or scroll offset while loading a different order's detail screen.
        top = before
        for _ in range(4):
            if tracking_status(labels(top))[0] != 'unknown':
                break
            fresh = self.swipe('down')
            if labels(fresh) == labels(top):
                break
            top = fresh
        after = self.identity(top, order)
        return parse_tracking(top, before, after, order)


def run(command, order=None):
    if command not in {'orders', 'track'}:
        raise UIError('INVALID_COMMAND')
    if command == 'track' and not re.fullmatch(r'\d{1,20}', order or ''):
        raise UIError('INVALID_ORDER_ID')
    guard()
    HOLD.parent.mkdir(parents=True, exist_ok=True)
    with (HOLD.parent / 'jevrun.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise UIError('PHONE_BUSY') from None
        guard()
        phone = Phone()
        battery = re.search(r'^\s*level:\s*(\d+)\s*$', phone.adb('dumpsys', 'battery'), re.M)
        if battery is None:
            raise UIError('BATTERY_STATE_UNVERIFIED')
        if int(battery[1]) < 15:
            raise UIError('PHONE_BATTERY_LOW')
        # KEYCODE_WAKEUP is reliable when screen_on() mistakenly sees AOD as on.
        phone.adb('input', 'keyevent', 'KEYCODE_WAKEUP')
        phone.adb('wm', 'dismiss-keyguard')
        return phone.track(order) if command == 'track' else phone.orders()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('command', choices=['orders', 'track'])
    p.add_argument('order', nargs='?')
    p.add_argument('--timeout', type=float, default=45)
    args = p.parse_args()
    if not 1 <= args.timeout <= 60:
        p.error('timeout must be 1..60')
    def timed_out(*_):
        raise UIError('UI_TIMEOUT')
    signal.signal(signal.SIGALRM, timed_out)
    signal.setitimer(signal.ITIMER_REAL, args.timeout)
    try:
        result = run(args.command, args.order)
    except UIError as exc:
        result = {**base(args.order), 'ok': False, 'error': str(exc)}
    except Exception:
        # Third-party exceptions can contain raw UI, device or account data.
        result = {**base(args.order), 'ok': False, 'error': 'UI_READ_FAILED'}
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
    print(json.dumps(result, indent=2))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
