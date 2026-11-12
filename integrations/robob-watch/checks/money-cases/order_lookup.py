"""Bounded read-only order lookup through the installed app-api readers."""
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from zoneinfo import ZoneInfo


def read(app, deadline=None):
    remaining = 10 if deadline is None else min(10, deadline - time.time())
    if remaining < 1:
        raise ValueError('order lookup out of time')
    python = Path('~/.local/share/uv/tools/mitmproxy/bin/python').expanduser()
    root = Path(os.environ.get('MONEY_CASES_APP_API', '~/.local/share/app-api-cli')).expanduser()
    try:
        result = subprocess.run([str(python), '-B', str(Path(__file__).resolve()), app, str(root)],
                                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=remaining)
        if result.returncode:
            raise ValueError('order lookup unavailable')
        result = json.loads(result.stdout)
        if (not isinstance(result, dict) or not isinstance(result.get('orders'), list)
                or type(result.get('complete')) is not bool):
            raise ValueError('invalid orders')
        return result
    except (OSError, subprocess.TimeoutExpired, ValueError) as e:
        raise ValueError('order lookup unavailable') from e


def native(app, root):
    sys.path.insert(0, root)
    if app == 'careem':
        import careem_http_orders
        # Refuses while the customer list binding is unverified. No auth or UI fallback.
        return careem_http_orders.orders()
    import native_orders
    from noon_order_details import details
    rows, complete = [], True
    end = time.monotonic() + 8
    for service in ('minutes', 'marketplace', 'food', 'nownow'):
        remaining = end - time.monotonic()
        if remaining < 1:
            raise ValueError('order lookup out of time')
        result = native_orders.orders('noon', service=service, timeout=remaining)
        if not result.get('ok') or result.get('partial'):
            raise ValueError('incomplete order list')
        coverage = result.get('coverage') or {}
        lane = coverage.get(service) or {}
        if service == 'minutes':
            pages = lane.get('total_pages')
            complete = complete and type(pages) is int and pages <= 1 and lane.get('page') == 1
        else:
            # Marketplace history and Food/NowNow default pages do not prove exhaustive history.
            complete = complete and lane.get('exhaustive') is True
        seen = set()
        for order in result['orders']:
            oid = order['order']
            if oid in seen:
                continue
            seen.add(oid)
            if len(seen) > 8 or end - time.monotonic() < 1:
                raise ValueError('incomplete order details')
            detail = details(oid, service, timeout=end - time.monotonic())
            if detail.get('ok') is not True or detail.get('account_verified') is not True or detail.get('order') != oid:
                raise ValueError('unverified order detail')
            placed = (order.get('placed_at') if service == 'minutes' else None) or detail.get('placed_at')
            if service == 'minutes' and isinstance(placed, str):
                parsed = dt.datetime.fromisoformat(placed.replace('Z', '+00:00'))
                # The native Minutes list documents zone-less placement times as Dubai local.
                if parsed.tzinfo is None:
                    placed = parsed.replace(tzinfo=ZoneInfo('Asia/Dubai')).isoformat()
            rows.append({'order': oid, 'total': detail.get('total'), 'currency': detail.get('currency'),
                         'placed_at': placed,
                         'status': order.get('status'), 'raw_status': order.get('raw_status')})
    return {'orders': rows, 'complete': complete}


if __name__ == '__main__':
    try:
        print(json.dumps(native(sys.argv[1], sys.argv[2])))
    except Exception:
        sys.exit(1)
