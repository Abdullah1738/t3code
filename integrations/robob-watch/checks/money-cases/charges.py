"""Is a card alert already explained, before anyone asks the owner about it?

Owner rule (nightly 2026-10-24): before asking about a charge, look for its receipt or order mail
(same amount and merchant, from two hours before to 36 hours after the charge), look at what he typed in his own
threads around the charge, and when it's a merchant he already pays, wait for the receipt ("Wait for
the email", 24 Oct). Only a charge none of these explain goes to him.
"""
import contextvars
from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError as FutureTimeout
import datetime as dt
from email.utils import parseaddr
from decimal import Decimal, InvalidOperation
import importlib.util
import hashlib
import itertools
import json
import math
import os
from pathlib import Path
import re
import resource
import signal
import statistics
import subprocess
import threading
import time
from contextlib import contextmanager
import urllib.parse
from zoneinfo import ZoneInfo
import order_lookup
from state_json import write_json

# The watcher process can already have a different helper named toollog loaded.
_log_spec = importlib.util.spec_from_file_location('owner_texts_orders_log', Path(__file__).with_name('toollog.py'))
toollog = importlib.util.module_from_spec(_log_spec)
_log_spec.loader.exec_module(toollog)

TZ = ZoneInfo('Asia/Dubai')
MSGS = os.environ.get('MONEY_CASES_MSGS', str(Path('~/.local/bin/msgs').expanduser()))
CONTROL_FILE = Path('~/.robob/ardud-control.json').expanduser()
RECEIPT_BEFORE = dt.timedelta(hours=2)
# Hits asked for per receipt search, and mails read from them: a receipt buried under usage notices
# with the same amount is still found, without an unbounded number of reads.
RECEIPT_HITS = 60
RECEIPT_READS = 12
# A receipt under another name (Stripe's legal entity, a reseller) counts only this close to the
# charge and only when it shows the same card's last four digits.
SAME_TIME = order_lookup.SAME_TIME
OWNER_AROUND = dt.timedelta(minutes=30)
# Uber Eats receipts came 11 hours after their holds on 24 Oct.
WAIT = dt.timedelta(hours=36)
KNOWN_SINCE = dt.timedelta(days=180)
KNOWN_GAP = dt.timedelta(hours=12)

BANKS = re.compile(r'emirates ?nbd|emiratesnbd|emirates ?islamic|\bei sms\b|mashreq|adcb|\bwio', re.I)
_AMT = r'(?P<cur>[A-Z]{3}) ?(?P<amt>\d[\d,]*(?:\.\d{1,2})?)'
_CARD = r'(?:Credit|Debit|Prepaid) Card'
PATTERNS = [
    ('charge', re.compile(rf'Purchase of {_AMT} with (?:your )?{_CARD} ending (?P<card>\d{{4}}) at '
                          r'(?P<merchant>[^,]+?)(?:,[^,]*?)?\.(?: |$)', re.I)),
    ('charge', re.compile(rf'Payment of {_AMT} to (?P<merchant>.+?) with (?:your )?{_CARD} ending (?P<card>\d{{4}})',
                          re.I)),
    ('decline', re.compile(rf'Transaction of {_AMT} on your (?:Credit |Debit )?Card (?:ending )?(?P<card>\d{{4}}) '
                           r'at (?P<merchant>.+?) was declined', re.I)),
    ('charge', re.compile(r'Credit Card Purchase Card Ending: ?(?P<card>\d{4}) At: ?(?P<merchant>[^,]+?)(?:,[^,]*?)? '
                          rf'Amount: ?{_AMT}', re.I)),
    ('decline', re.compile(rf'Purchase declined\b.*?Amount: ?{_AMT} Credit Card Ending: ?(?P<card>\d{{4}}) '
                           r'At: ?(?P<merchant>[^,]+?)(?:,| Date|$)', re.I)),
    ('charge', re.compile(rf'Card X+(?P<card>\d{{4}}) (?:was )?used for {_AMT}\b.*? at (?P<merchant>[^,]+?) ?,', re.I)),
    ('charge', re.compile(rf'Payment of {_AMT}(?: \([A-Z]{{3}} [\d,.]+\))? was done at (?P<merchant>.+?) using your '
                          r'Wio \w+ card (?:ending (?:with )?)?(?P<card>\d{4})', re.I)),
    ('decline', re.compile(rf'Payment of {_AMT} at (?P<merchant>.+?) with your Wio \w+ card ending with '
                           r'(?P<card>\d{4}) was declined', re.I)),
    ('charge', re.compile(rf'Card ending with (?P<card>\d{{4}}) (?:was|has been) used for a purchase of {_AMT} at '
                          r'(?P<merchant>.+?)(?:\.(?: |$)|,| on \d|$)', re.I)),
]
NOT_CHARGES = re.compile(r'\btowards (?:the )?(?:payment of )?your|has been refunded|refund initiated', re.I)
# Words that say nothing about who the merchant is.
STOP = set('''pending auth trip help bill com www net org llc ltd limited inc fze fzco fzc dmcc the and for pay
    payment payments online store shop shops dubai uae sub subs card middle east insurance services service
    solutions group international trading general center centre company market'''.split())
SYMBOLS = {'USD': ['$'], 'EUR': ['€'], 'GBP': ['£'], 'AED': ['د.إ'], 'INR': ['₹'], 'JPY': ['¥'], 'CNY': ['¥']}
# What a receipt, invoice or order mail says and an advert doesn't.
RECEIPT_WORDS = re.compile(r"\b(?:(?:receipt|invoice|amount paid|paid on|billed to|charged to|your (?:total )?bill|"
                           r"order (?:number|no|id|confirmed|confirmation|summary)|thanks? (?:you )?for "
                           r"(?:your )?(?:\w+ )?order(?:ing)?|payment (?:received|confirmation|successful|confirmed))"
                           r"\b|order #)", re.I)
# His words mention a charge without owning it when he denies it, asks about it or isn't sure.
NOT_MINE = re.compile(r"\?|n't\b|\b(?:not|never|no idea|unknown|recogni[sz]e|fraud|scam|stolen|block|dispute|"
                      r"cancel|refund|who|what|why|which|maybe|perhaps|probably|possibly|might|unsure|think|guess)\b",
                      re.I)
# A negative statement about buying or owning: "No Apple orders from me", "I ordered nothing from Apple".
NEGATED = re.compile(r"\b(?:no|none|nothing|never|not|n't|didn't|haven't|hasn't|wasn't|isn't)\b", re.I)
# A denial or correction in the whole message: "I paid Apple. No, I ordered nothing from Apple." The later
# denial vetoes the earlier affirmation, so it is checked on the message before any clause is accepted.
# Only a denial of buying or owning vetoes: a bare "no", "actually" or "no need to ask" is discourse, not a denial.
VETO = re.compile(r"\b(?:not\s+me|not\s+mine|wasn'?t\s+(?:me|mine)|isn'?t\s+(?:me|mine)|that\s+wasn'?t|"
                  r"it\s+wasn'?t|wrong\s+(?:charge|one|order|account)|incorrect\s+(?:charge|one)|"
                  r"belongs?\s+to\s+(?:someone|somebody|another|anyone))\b"
                  r"|\b(?:none|nothing|never|not|n't)\b"
                  # "No Apple orders from me", "no charges from Apple": a "no" in front of a purchase object.
                  r"|\bno\s+(?:\w+\s+)?(?:orders?|purchases?|payments?|charges?|subscriptions?|mine|from\s+me)\b", re.I)
CORRECTION = re.compile(r"\b(?:wrong\s+(?:charge|one|transaction|payment)|nothing\s+to\s+do\s+with\s+(?:me|us|this)|"
                        r"not\s+(?:my|for)\s+(?:charge|one|transaction|payment|me)|not\s+mine|isn'?t\s+mine|"
                        # Naming another person is not a denial: "someone else reimbursed me" stays a payment he made.
                        # Only "someone else's charge" and "belongs to someone else" deny that it is his.
                        r"someone\s+else'?s\s+(?:charge|one|transaction|payment)|"
                        # Predicative: "That was someone else's", "that one is someone else's". Not "someone else reimbursed me".
                        r"(?:that|this|it|one|charge)(?:\s+one)?(?:\s+(?:was|is)|'s)\s+someone\s+else'?s|"
                        r"belongs?\s+to\s+(?:someone|somebody|another|anyone)(?:\s+else)?)\b", re.I)
# A statement that opens like a question is one, with or without its "?": "Is this Apple charge mine".
ASKS = re.compile(r"^\W*(?:is|are|was|were|am|do|does|did|have|has|had|can|could|would|will|should|shall|may)\b",
                  re.I)
# His words own a payment: he is ordering, paying, subscribing or topping up (not just naming a merchant).
OWNER_BUYS = re.compile(r"\b(?:ordering|ordered|paying|paid|set ?up|subscrib(?:e|ed|ing)|top(?:ped|ping)? up|"
                        r"bought|buying|(?:is|are|was|it'?s|that'?s) mine|mine)\b"
                        # "acme order" or "my order" is his purchase; "the order of Apple announcements" isn't.
                        r"|\b\w+ orders?\b(?! of)|\border (?:#|no\.?|number)\s*\d", re.I)


class Lookup(Exception):
    """A source couldn't be read; the charge is then not explained by it."""


class SourceLimit(Lookup):
    def __init__(self, message, kinds):
        self.kinds = kinds
        super().__init__(message)


OWNER_BUDGET = 10
OWNER_REQUEST_TIMEOUT = 3
OWNER_TIMING_KEYS = (
    'owner_list_pages', 'owner_list_ms', 'owner_threads_selected', 'owner_threads_fresh',
    'owner_threads_needed', 'owner_threads_fetched', 'owner_fetch_ms_max', 'owner_timeouts', 'owner_cache_size')
OWNER_REQUEST_LIMIT = 64
OWNER_CACHE_VERSION = 2
_OWNER_STATS_LOCK = threading.Lock()
_MSGS_ACTIVE = set()
MSGS_BUDGET = 2
RECEIPT_BUDGET = 4


TIMING_STATS = contextvars.ContextVar('money_cases_timing_stats', default=None)
_TIMING_STACK = contextvars.ContextVar('money_cases_timing_stack', default=())


@contextmanager
def step_timing(stats, name, deadline=None):
    stats = stats if stats is not None else TIMING_STATS.get()
    started = time.monotonic()
    stack = tuple(frame for frame in _TIMING_STACK.get() if frame.get('active'))
    frame = {'stats': stats, 'children': 0.0, 'name': name, 'active': True, 'deadline': deadline}
    error = None
    try:
        _TIMING_STACK.set((*stack, frame))
        alarm = signal.getitimer(signal.ITIMER_REAL)[0]
        if alarm:
            enclosing = time.time() + alarm
            deadline = min(deadline, enclosing) if deadline is not None else enclosing
        frame['deadline'] = deadline
        yield
    except BaseException as exc:
        error = exc
        raise
    finally:
        # A signal can interrupt setup or even the final clock sample. Restore
        # the source context first so later calls cannot inherit a dead frame.
        frame['active'] = False
        _TIMING_STACK.set(stack)
        elapsed = (time.monotonic() - started) * 1000
        if stack and stack[-1]['stats'] is stats:
            stack[-1]['children'] += elapsed
        if stats is not None:
            # Nested source/storage steps own their time; the parent records only
            # its remaining work so the follow buckets can be summed.
            exclusive = round(max(0, elapsed - frame['children']))
            key = name + '_ms'
            stats[key] = stats.get(key, 0) + exclusive
            if name == 'msgs':
                stats['msgs_max_ms'] = max(stats.get('msgs_max_ms', 0), round(elapsed))
            if deadline is not None and time.time() >= deadline:
                stats['starved_by'] = name
                if error is not None and not hasattr(error, '_money_cases_step'):
                    error._money_cases_step = name


def order_app(charge):
    merchant = charge['merchant'].lower()
    return 'careem' if 'careem' in merchant else 'noon' if 'noon' in merchant else None


def card_owner(charge):
    path = Path(os.environ.get('MONEY_CASES_SETTINGS', Path(__file__).with_name('settings.json')))
    try:
        owners = json.loads(path.read_text())['card_owners']
        if not isinstance(owners, dict) or any(value not in ('abdullah', 'moni') for value in owners.values()):
            raise ValueError('invalid card owners')
        return owners.get(charge['card'], owners.get('Wio', 'abdullah'))
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise Lookup('card owners: settings unreadable') from e


def order_receipt(charge, at, now, deadline=None, lookup=None, memo=None, stats=None):
    app = order_app(charge)
    if not app:
        return None
    try:
        key = ('orders', app)
        if memo is not None and key in memo:
            result = memo[key]
        else:
            try:
                options = {}
                if lookup is None:
                    options = {'since': (memo or {}).get(('orders_since', app), at - SAME_TIME)}
                    if memo is not None and ('orders_cache',) in memo:
                        options['cache_path'] = memo[('orders_cache',)]
                with step_timing(stats, 'lookups', deadline):
                    result = (lookup or order_lookup.read)(app, deadline=deadline, **options)
            except (ValueError, OSError) as exc:
                if isinstance(exc, order_lookup.OutOfTime):
                    raise
                result = exc
            if memo is not None:
                memo[key] = result
        if isinstance(result, Exception):
            raise result
        complete = result.get('complete') is True if isinstance(result, dict) else True
        rows = result.get('orders') if isinstance(result, dict) else result
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise ValueError('invalid order list')
        matches = {}
        for row in rows:
            placed = dt.datetime.fromisoformat(str(row.get('placed_at')).replace('Z', '+00:00'))
            if placed.tzinfo is None:
                raise ValueError('order time missing zone')
            total = Decimal(str(row.get('total')))
            if not total.is_finite() or not row.get('currency') or not row.get('order'):
                raise ValueError('order amount missing')
            if row.get('status') in ('cancelled', 'canceled', 'failed') or row.get('raw_status') in ('cancelled', 'canceled', 'failed'):
                continue
            if (total == Decimal(charge['amount']) and row['currency'] == charge['currency']
                    and abs(placed - at) <= SAME_TIME and placed <= now):
                matches[row['order']] = row
        if len(matches) == 1:
            return {'verdict': 'receipt', 'why': f'{app} order {next(iter(matches))}: amount and time match', 'errors': []}
        if len(matches) > 1:
            raise ValueError('ambiguous orders')
        if app == 'noon' and isinstance(result, dict):
            lanes = result.get('lanes') or {}
            marketplace = lanes.get('marketplace') or {}
            walked = marketplace.get('walked_at')
            if walked is None or order_lookup.moment(walked) < at + SAME_TIME:
                raise SourceLimit('noon orders: Marketplace snapshot predates the match window (source limit)',
                                  ['marketplace_stale'])
            if any(abs(order_lookup.moment(t) - at) <= SAME_TIME for t in marketplace.get('hold_times', [])):
                raise SourceLimit('noon orders: Marketplace placement near charge (source limit)', ['marketplace_hold'])
            short = []
            for name in order_lookup.LANES:
                lane = lanes.get(name) or {}
                if lane.get('exhaustive') is True:
                    continue
                covered = lane.get('covered_from')
                # A tied timestamp can continue on the next page at the inclusive match edge.
                if covered is not None and order_lookup.moment(covered) < at - SAME_TIME:
                    continue
                short.append((name, lane))
            if short:
                if all(lane.get('limit') == 'page-1 history only' and lane.get('covered_from')
                       for name, lane in short):
                    names = ', '.join(name for name, lane in short)
                    raise SourceLimit(f'noon orders: {names} history does not reach '
                                      f'{(at - SAME_TIME).date()} (source limit)',
                                      [name + '_page_1' for name, lane in short])
                raise ValueError('incomplete history cannot authorize an ask')
        elif not complete:
            raise ValueError('incomplete history cannot authorize an ask')
    except order_lookup.SourceLimit as e:
        raise SourceLimit('careem orders: order list binding unverified (source limit)', [e.code]) from e
    except (ValueError, TypeError, KeyError, InvalidOperation, OSError) as e:
        raise Lookup(f'{app} orders: lookup unavailable or incomplete') from e
    return None


def parse(text, sender=''):
    """The charge in a bank alert, or None when the text isn't a card charge or decline we read."""
    if sender and not BANKS.search(sender):
        return None
    text = re.sub(r'\s+', ' ', str(text or '')).strip()
    if NOT_CHARGES.search(text):
        return None
    for kind, pattern in PATTERNS:
        m = pattern.search(text)
        if not m:
            continue
        try:
            amount = Decimal(m['amt'].replace(',', '')).quantize(Decimal('0.01'))
        except InvalidOperation:
            return None
        merchant = re.sub(r'\s+', ' ', m['merchant']).strip(' *.')
        return {'kind': kind, 'currency': m['cur'].upper(), 'amount': str(amount), 'card': m['card'],
                'merchant': merchant, 'pending': bool(re.search(r'\b(?:pending|auth)\b', merchant, re.I))}
    return None


def describe(charge):
    return f"{charge['merchant']} {charge['currency']} {Decimal(charge['amount']):,} (card ending {charge['card']})"


def words(merchant):
    found = re.findall(r'[a-z]{3,}', merchant.lower())
    return list(dict.fromkeys(w for w in found if w not in STOP))[:4]


def amounts(charge):
    a = Decimal(charge['amount'])
    cur = charge['currency'].lower()
    out = [f'{a:.2f}', f'{a:,.2f}']
    if a == a.to_integral_value():
        out.append(f'{a:,.0f}')
    out += [cur + v for v in list(out)]
    return list(dict.fromkeys(out))


def left(deadline, cap):
    if deadline is None:
        return cap
    remaining = deadline - time.time()
    if remaining < 1:
        raise Lookup('out of time')
    return min(cap, remaining)


def msgs(argv, deadline, cap, memo=None, stats=None):
    stats = stats if stats is not None else TIMING_STATS.get()
    key = tuple(argv)
    if memo is not None and key in memo:
        result = memo[key]
        if isinstance(result, Lookup):
            raise result
        return result
    timeout = left(deadline, min(cap, MSGS_BUDGET))
    if stats is not None:
        stats['msgs_calls'] += 1
    started = time.monotonic()
    called_at = time.time()
    stop = called_at + timeout
    alarm = signal.getitimer(signal.ITIMER_REAL)[0]
    if alarm:
        stop = min(stop, time.time() + alarm)
    timed_out = False
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu_before = usage.ru_utime + usage.ru_stime
    active = object()
    concurrent = len(_MSGS_ACTIVE)
    _MSGS_ACTIVE.add(active)
    try:
        with step_timing(stats, 'msgs', time.time() + timeout):
            done = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
        if done.returncode:
            raise Lookup(f'msgs exit {done.returncode}: {done.stderr.strip()[:200]}')
    except (OSError, subprocess.TimeoutExpired, Lookup) as e:
        timed_out = isinstance(e, subprocess.TimeoutExpired) or getattr(e, '_money_cases_timeout', False)
        error = e if isinstance(e, Lookup) else Lookup(f'msgs: {e}')
        if memo is not None:
            memo[key] = error
        raise error from e
    except BaseException as exc:
        timed_out = getattr(exc, '_money_cases_timeout', False)
        raise
    finally:
        _MSGS_ACTIVE.discard(active)
        usage = resource.getrusage(resource.RUSAGE_CHILDREN)
        cpu_ms = round(max(0, usage.ru_utime + usage.ru_stime - cpu_before) * 1000)
        if stats is not None:
            stats['msgs_cpu_ms'] = stats.get('msgs_cpu_ms', 0) + cpu_ms
            stats['msgs_concurrent_max'] = max(stats.get('msgs_concurrent_max', 0), concurrent + 1)
            elapsed = round((time.monotonic() - started) * 1000)
            stats.setdefault('_msgs_samples_ms', []).append(elapsed)
            stats['msgs_timeouts'] = stats.get('msgs_timeouts', 0) + int(
                timed_out or time.time() >= stop)
            names = {frame['name'] for frame in _TIMING_STACK.get()
                     if frame.get('active') and frame['stats'] is stats
                     and (frame['deadline'] is None or called_at < frame['deadline'])}
            kind = 'receipt' if 'receipt' in names else 'history' if 'history' in names else \
                'refund' if 'refunds' in names else 'order' if names & {
                'order_charges', 'lookups', 'order_screen'} else 'other'
            bucket = stats.setdefault('msgs_by_kind', {}).setdefault(kind, {'count': 0, 'ms': 0})
            bucket['count'] += 1
            bucket['ms'] += elapsed
            stats.setdefault('_msgs_calls', []).append(
                {'kind': kind, 'wall_ms': elapsed, 'cpu_ms': cpu_ms, 'concurrent': concurrent})
    if memo is not None:
        memo[key] = done
    return done


def receipt_timing(stats):
    """Bounded metadata only, including defaults for checks without archive work."""
    samples = stats.get('_msgs_samples_ms', [])
    return {'msgs_cpu_ms': stats.get('msgs_cpu_ms', 0),
            'msgs_concurrent_max': stats.get('msgs_concurrent_max', 0),
            'msgs_cache_hits': stats.get('msgs_cache_hits', 0),
            'msgs_timeouts': stats.get('msgs_timeouts', 0),
            'msgs_p50_ms': round(statistics.median(samples)) if samples else 0,
            'msgs_by_kind': {kind: {key: stats.get('msgs_by_kind', {}).get(kind, {}).get(key, 0)
                                    for key in ('count', 'ms')} for kind in ('receipt', 'order', 'refund', 'history', 'other')},
            'receipt_result': {key: stats.get('receipt_result', {}).get(key, 0)
                               for key in ('found', 'none', 'out_of_time', 'error')}}


def day(t):
    return t.astimezone(TZ).date().isoformat()


SEARCH_CACHE_DAYS = 14
SEARCH_CACHE_LIMIT = 256
SEARCH_ROW_FIELDS = ('id', 'ts', 'source', 'sender', 'subject', 'from_me')


def search_cache(path, now):
    try:
        entries = json.loads(path.read_text())
        if not isinstance(entries, dict):
            return {}
        clean = {}
        for key, entry in entries.items():
            if not re.fullmatch(r'[0-9a-f]{64}', key) or not isinstance(entry, dict):
                continue
            saved, rows = entry.get('saved'), entry.get('rows')
            if (type(saved) not in (int, float) or not math.isfinite(saved)
                    or not now - SEARCH_CACHE_DAYS * 86400 <= saved <= now
                    or not isinstance(rows, list) or any(not isinstance(row, dict)
                        or set(row) - set(SEARCH_ROW_FIELDS)
                        or type(row.get('id')) not in (str, int)
                        or type(row.get('ts')) not in (int, float)
                        or not math.isfinite(row['ts'])
                        or not isinstance(row.get('sender', ''), str)
                        or not isinstance(row.get('subject', ''), str)
                        or type(row.get('from_me', False)) not in (bool, int)
                        or row.get('source') not in ('email', 'imessage', 'whatsapp') for row in rows)):
                continue
            clean[key] = entry
        return dict(sorted(clean.items(), key=lambda item: item[1]['saved'])[-SEARCH_CACHE_LIMIT:])
    except (OSError, ValueError, TypeError, OverflowError):
        return {}


def closed_search_cache(memo, until):
    if memo is None or ('msgs_cache',) not in memo or not until:
        return None
    try:
        closed = dt.date.fromisoformat(until) < dt.datetime.now(TZ).date()
    except (TypeError, ValueError):
        return None
    return Path(memo[('msgs_cache',)]) if closed else None


class SearchRows(list):
    def __init__(self, rows, raw_count):
        super().__init__(rows)
        self.raw_count = raw_count


def search(query, since, until=None, source=None, n=20, deadline=None, memo=None, stats=None, all_copies=False):
    """Rows from the message archive (the msgs CLI), newest first, without bodies."""
    # Deduplication happens after msgs limits raw rows, hiding truncated searches.
    # Keep the raw count, then fold Message-ID copies before any body reads.
    cache_path = closed_search_cache(memo, until)
    cmd = [MSGS, 'search', query, '--json', '-n', str(n), '--date', '--since', since]
    if all_copies or cache_path is not None:
        cmd += ['--all-copies']
    if until:
        cmd += ['--until', until]
    if source:
        cmd += ['--in', source]
    cache, key = {}, None
    if cache_path is not None:
        left(deadline, MSGS_BUDGET)
        key = hashlib.sha256(json.dumps(cmd, ensure_ascii=False).encode()).hexdigest()
        cache = search_cache(cache_path, time.time())
        if key in cache:
            target = stats if stats is not None else TIMING_STATS.get()
            if target is not None:
                target['msgs_cache_hits'] = target.get('msgs_cache_hits', 0) + 1
            return cache[key]['rows']
    done = msgs(cmd, deadline, 15, memo, stats)
    # split on '\n' only: msgs prints ensure_ascii=False JSON, so a snippet can hold
    # U+2028, \x85 or \x1c-\x1e, which str.splitlines() would treat as line breaks.
    try:
        rows = [json.loads(line) for line in done.stdout.split('\n') if line.strip()]
        if any(not isinstance(row, dict) for row in rows):
            raise ValueError('invalid search row')
    except ValueError as e:
        raise Lookup('msgs: unreadable search output') from e
    raw_count, unique, seen = len(rows), [], set()
    for row in rows:
        msgid = row.get('msgid')
        ident = msgid.lower() if row.get('source') == 'email' and isinstance(msgid, str) and msgid else None
        if ident is not None:
            if ident in seen:
                continue
            seen.add(ident)
        unique.append(row)
    rows = SearchRows(unique, raw_count)
    # A capped result is incomplete. Do not freeze it (or any failed search)
    # into a negative screen; open windows always go back to the archive.
    if key is not None and raw_count < n:
        cache[key] = {'saved': time.time(), 'rows': [
            {field: row[field] for field in SEARCH_ROW_FIELDS if field in row} for row in rows]}
        cache = dict(sorted(cache.items(), key=lambda item: item[1]['saved'])[-SEARCH_CACHE_LIMIT:])
        try:
            write_json(cache_path, cache)
        except OSError:
            pass  # A cache write cannot invalidate a completed archive read.
    return rows


def iso(t):
    return t.astimezone(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


# Bridge-generated turns are never relayed owner messages.
SYNTHETIC_IDS = ('wake:', 'reset:', 'secret:')
APP_SOURCES = ('web', 'mobile', 'desktop')


@contextmanager
def within(deadline, error):
    if deadline is None:
        yield
        return
    remaining = deadline - time.time()
    if remaining <= 0:
        raise error
    previous = signal.getitimer(signal.ITIMER_REAL)
    # Keep an earlier enclosing deadline and its exception handler.
    if previous[0] and previous[0] <= remaining:
        yield
        return
    handler = signal.getsignal(signal.SIGALRM)
    started = time.monotonic()

    def expired(*_):
        error._money_cases_timeout = True
        raise error

    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, remaining)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, handler)
        if previous[0]:
            signal.setitimer(signal.ITIMER_REAL, max(0.000001, previous[0] - (time.monotonic() - started)),
                             previous[1])


def owner_turn(summary, title=''):
    """Whether a control-API user message is his typing, with complete provenance."""
    if type(summary.get('automated')) is not bool or 'inboundMessageId' not in summary \
            or (summary['inboundMessageId'] is not None and not isinstance(summary['inboundMessageId'], str)):
        raise Lookup('Robob control: message provenance unavailable; server update required')
    if summary['automated']:
        return False
    if summary.get('createdBy') == 'user' and summary.get('creationSource') in APP_SOURCES:
        return True
    if summary.get('createdBy') not in ('user', 'system') or not title.startswith('iMessage'):
        return False
    iid = summary['inboundMessageId']
    return bool(iid) and not iid.startswith(SYNTHETIC_IDS) and not str(summary.get('text') or '').lstrip().startswith('[')


def control_config():
    # Honor the runner's component credential, retaining the shared file for older installs.
    named = os.environ.get('T3_CONTROL_TOKEN_FILE')
    component = Path.home() / '.robob/components/watchers.json'
    path = Path(named).expanduser() if named else component if component.exists() else CONTROL_FILE
    try:
        config = json.loads(path.read_text())
        url, token = config['url'], config['token']
        if not isinstance(url, str) or not isinstance(token, str) or not token:
            raise ValueError()
        url = url.rstrip('/')
        if not url.endswith('/api/ardud/control'):
            url += '/api/ardud/control'
        return url, token
    except (OSError, ValueError, KeyError, TypeError):
        raise Lookup('Robob control: credentials unavailable') from None


def control_get(config, path, params, deadline, stats=None):
    url, token = config
    timeout = left(deadline, OWNER_REQUEST_TIMEOUT)
    listed = path == '/threads'
    started = time.monotonic()
    if stats is not None:
        with _OWNER_STATS_LOCK:
            stats['owner_queries'] = stats.get('owner_queries', 0) + 1
            if listed:
                stats['owner_list_pages'] = stats.get('owner_list_pages', 0) + 1
    try:
        # Curl's wall-clock limit covers DNS, connect/TLS, headers and body. The
        # subprocess timeout also kills and reaps it if its resolver gets stuck.
        # Disable curlrc and pass the credential on stdin, never in argv or errors.
        done = subprocess.run(['/usr/bin/curl', '-q', '--config', '-', '--silent', '--fail',
                               '--proto', '=http,https', '--max-time', str(timeout),
                               '--url', url + path + '?' + urllib.parse.urlencode(params)],
                              input=('header = ' + json.dumps('Authorization: Bearer ' + token) + '\n').encode(),
                              capture_output=True, timeout=timeout)
        if done.returncode == 28:
            raise subprocess.TimeoutExpired('Robob control', timeout)
        if done.returncode:
            raise Lookup('Robob control: request failed or timed out')
        result = json.loads(done.stdout)
        if not isinstance(result, dict) or result.get('ok') is not True:
            raise Lookup('Robob control: invalid response')
        return result
    except subprocess.TimeoutExpired:
        if stats is not None:
            with _OWNER_STATS_LOCK:
                stats['owner_timeouts'] = stats.get('owner_timeouts', 0) + 1
        raise Lookup('Robob control: request failed or timed out') from None
    except (OSError, ValueError):
        # Neither a server error body nor a request/credential repr belongs in pings.json.
        raise Lookup('Robob control: request failed or timed out') from None
    finally:
        if stats is not None:
            elapsed = round((time.monotonic() - started) * 1000)
            with _OWNER_STATS_LOCK:
                if listed:
                    stats['owner_list_ms'] = stats.get('owner_list_ms', 0) + elapsed
                else:
                    stats['owner_fetch_ms_max'] = max(stats.get('owner_fetch_ms_max', 0), elapsed)


def owner_time(value):
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('timestamp missing zone')
    return parsed


def owner_cache(path, cache_reset=None):
    try:
        cache = json.loads(path.read_text())
        if not isinstance(cache, dict):
            raise ValueError()
        for tid, entry in cache.items():
            if not isinstance(tid, str) or not tid or not isinstance(entry, dict):
                raise ValueError()
            # Earlier delta caches could mark redacted text as current.
            if type(entry.get('version')) is not int or entry['version'] != OWNER_CACHE_VERSION:
                raise ValueError()
            owner_time(entry['updatedAt'])
            owner_time(entry['coveredFrom'])
            if not isinstance(entry['title'], str) or not isinstance(entry['texts'], list):
                raise ValueError()
            for row in entry['texts']:
                if not isinstance(row['messageId'], str) or not row['messageId'] \
                        or not isinstance(row['text'], str) or row['title'] != entry['title']:
                    raise ValueError()
                owner_time(row['createdAt'])
        return cache
    except FileNotFoundError:
        return {}
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        if cache_reset is not None:
            cache_reset()
        else:
            toollog.emit('money-cases', 'cache_reset')
        return {}


def save_owner_cache(path, cache, since, until):
    # Keep fourteen days, extending to this call's oldest followed question so
    # unanswered older questions can warm up too. No cases-data lock is needed:
    # this atomic private file is independent of cases.json/questions.json.
    cutoff = min(since, until - dt.timedelta(days=14))
    kept = {}
    for tid, entry in cache.items():
        if owner_time(entry['updatedAt']) < cutoff:
            continue
        kept[tid] = {**entry, 'coveredFrom': max(cutoff, owner_time(entry['coveredFrom'])).isoformat(),
                     'texts': [row for row in entry['texts'] if owner_time(row['createdAt']) >= cutoff]}
    try:
        write_json(path, kept)
        return len(kept)
    except OSError:
        raise Lookup('Robob control: owner cache save failed') from None


def owner_texts(since, until, deadline=None, stats=None, cache_path=None, cache_reset=None):
    """His app/iMessage typing, fetched once per check within its own total cap."""
    if stats is not None:
        for key in OWNER_TIMING_KEYS:
            stats.setdefault(key, 0)
        stats['owner_result'] = 'list_failed'
    stop = time.time() + (OWNER_BUDGET if deadline is None
                          else min(OWNER_BUDGET, left(deadline, OWNER_BUDGET) - 0.5))
    alarm = signal.getitimer(signal.ITIMER_REAL)[0]
    if alarm:
        stop = min(stop, time.time() + alarm - 0.5)
    error = Lookup('Robob control: owner read incomplete; continuing next check (out of time)')
    with within(stop, error):
        # Stop network work early enough to persist completed threads. The outer
        # deadline also bounds cache reads, fsync, pruning and result assembly.
        rows = _owner_texts(since, until, stats, cache_path, cache_reset, stop - 0.25)
        if time.time() >= stop:
            raise error
        if stats is not None:
            stats['owner_result'] = 'ok'
        return rows


def _owner_texts(since, until, stats, cache_path, cache_reset, stop):
    with within(stop, Lookup('Robob control: incomplete thread list')):
        config = control_config()
        # The API's since filter is strict on updatedAt; include messages created exactly at since.
        start = iso(since - dt.timedelta(milliseconds=1))
        threads = {}
        requests = stats.get('owner_queries', 0) if stats is not None else 0
        # He replies in app-created threads and MCP-launched top-level threads
        # (t3_thread_launch/create_threads stamp mcp), plus the iMessage bridge.
        # Server-created board workers/reviews and subagents are not owner chats.
        for kind in ({'creationSource': ','.join((*APP_SOURCES, 'mcp'))}, {'origin': 'imessage'}):
            params = {'updatedSince': start, 'limit': 500, **kind}
            cursors, ids = set(), set()
            while True:
                if requests >= OWNER_REQUEST_LIMIT:
                    raise Lookup('Robob control: incomplete thread list')
                requests += 1
                result = control_get(config, '/threads', params, stop, stats)
                page, total = result.get('threads'), result.get('total')
                if not isinstance(page, list):
                    raise Lookup('Robob control: invalid thread list')
                if type(total) is not int or total < len(page):
                    raise Lookup('Robob control: invalid thread count')
                for thread in page:
                    if not isinstance(thread, dict):
                        raise Lookup('Robob control: invalid thread')
                    tid = thread.get('threadId')
                    if not isinstance(tid, str) or not tid:
                        raise Lookup('Robob control: missing thread id')
                    ids.add(tid)
                    threads[tid] = thread
                cursor = result.get('nextCursor')
                if cursor is None:
                    if total != len(ids):
                        raise Lookup('Robob control: incomplete thread list')
                    break
                if not isinstance(cursor, str) or not cursor or cursor in cursors or not page:
                    raise Lookup('Robob control: incomplete thread list')
                cursors.add(cursor)
                params['cursor'] = cursor

    if stats is not None:
        stats['owner_result'] = 'incomplete'
    path = Path(cache_path) if cache_path is not None else Path(os.environ.get(
        'MONEY_CASES_DIR', '~/Documents/assistant/money-cases')).expanduser() / 'owner-texts.json'
    cache = owner_cache(path, cache_reset)
    if stats is not None:
        stats['owner_cache_size'] = len(cache)

    def read_thread(thread):
        title = str(thread.get('title') or '')
        tid = thread['threadId']
        prior = cache.get(tid)
        # Redaction can change text without advancing the message's updatedAt.
        # A delta cannot validate retained texts, even when it contains new turns.
        # Replace the covered span on every thread change; unchanged threads stay cheap.
        read_from = min(since, owner_time(prior['coveredFrom'])) if prior else since
        result = control_get(config, '/threads/' + urllib.parse.quote(tid, safe='') + '/messages',
                             {'since': iso(read_from - dt.timedelta(milliseconds=1)),
                              'role': 'user', 'all': 'true'}, stop, stats)
        messages = result.get('messages')
        if not isinstance(messages, list):
            raise Lookup('Robob control: invalid message list')
        total = result.get('total')
        if type(total) is not int or total < 0:
            raise Lookup('Robob control: invalid message count')
        if total != len(messages):
            raise Lookup('Robob control: incomplete message list')
        out = {}
        for message in messages:
            if time.time() >= stop:
                raise Lookup('Robob control: lookup over time')
            if not isinstance(message, dict):
                raise Lookup('Robob control: invalid message')
            if message.get('role') != 'user':
                continue
            # Reject old summaries before accepting any rows, including app-typed turns.
            typed = owner_turn(message, title)
            try:
                created = owner_time(message['createdAt'])
            except (KeyError, ValueError, TypeError, AttributeError):
                raise Lookup('Robob control: invalid message timestamp') from None
            text = str(message.get('text') or '')
            mid = message.get('messageId')
            if not isinstance(mid, str) or not mid:
                raise Lookup('Robob control: message id unavailable; server update required')
            out.pop(mid, None)
            if created >= read_from and typed and not text.startswith('[Forwarded by'):
                out[mid] = {'messageId': mid, 'createdAt': iso(created), 'text': text, 'title': title}
        # Preserve the caller's precision: rounding down would claim an unread
        # fractional millisecond when a later call moves its window earlier.
        return {'version': OWNER_CACHE_VERSION, 'updatedAt': thread['updatedAt'], 'coveredFrom': read_from.isoformat(),
                'title': title, 'texts': list(out.values())}

    selected = []
    for thread in threads.values():
        title = str(thread.get('title') or '')
        if thread.get('archived') or re.match(r'(?:Moni|Group)\b', title):
            continue
        try:
            owner_time(thread['updatedAt'])
        except (KeyError, ValueError, TypeError, AttributeError):
            raise Lookup('Robob control: thread updatedAt unavailable; server update required') from None
        selected.append(thread)
    selected.sort(key=lambda thread: owner_time(thread['updatedAt']), reverse=True)
    covered, needed = set(), []
    for thread in selected:
        prior = cache.get(thread['threadId'])
        if prior and prior['updatedAt'] == thread['updatedAt'] and prior['title'] == str(thread.get('title') or '') \
                and owner_time(prior['coveredFrom']) <= since:
            covered.add(thread['threadId'])
        else:
            needed.append(thread)
    # Give uncached spans and changed threads a share of every request window.
    # Each queue retains newest-first order; churn cannot starve older cold spans.
    full, changed = [], []
    for thread in needed:
        prior = cache.get(thread['threadId'])
        (full if prior is None or owner_time(prior['coveredFrom']) > since else changed).append(thread)
    needed = [thread for pair in itertools.zip_longest(full, changed) for thread in pair if thread is not None]
    if stats is not None:
        stats['owner_threads_selected'] = len(selected)
        stats['owner_threads_fresh'] = len(covered)
        stats['owner_threads_needed'] = len(needed)
    errors = []
    pool = ThreadPoolExecutor(max_workers=6)
    futures = {}
    try:
        futures = {pool.submit(read_thread, thread): thread['threadId']
                   for thread in needed[:max(0, OWNER_REQUEST_LIMIT - requests)]}
        for future in as_completed(futures, timeout=max(0.001, stop - time.time())):
            # Harvest after shutdown, including successes behind a stalled read.
            pass
    except FutureTimeout:
        pass
    finally:
        # SIGALRM during Thread.join can strand Python 3.9's thread-state lock.
        # Requests kill/reap themselves; reserve cleanup time before any enclosing alarm.
        pool.shutdown(wait=True, cancel_futures=True)
    # If a changed thread fails, don't persist its unvalidated previous texts.
    for thread in needed:
        cache.pop(thread['threadId'], None)
    for future, tid in futures.items():
        if future.cancelled():
            continue
        try:
            cache[tid] = future.result()
            covered.add(tid)
            if stats is not None:
                stats['owner_threads_fetched'] += 1
        except Lookup as exc:
            errors.append(exc)
    size = save_owner_cache(path, cache, since, until)
    if stats is not None:
        stats['owner_cache_size'] = size
    if len(covered) != len(selected):
        detail = ': ' + str(errors[0]) if errors else ''
        raise Lookup(f'Robob control: owner read incomplete ({len(covered)} of {len(selected)} threads); '
                     f'continuing next check{detail}')
    out = [(row['createdAt'], row['text'], row['title']) for thread in selected
           for row in cache[thread['threadId']]['texts'] if since <= owner_time(row['createdAt']) <= until]
    return sorted(out, key=lambda row: row[0], reverse=True)


def show(row, deadline=None, memo=None, stats=None):
    """The whole mail for a search row (msgs show)."""
    try:
        return msgs([MSGS, 'show', str(row['id'])], deadline, 10, memo, stats).stdout
    except KeyError as e:
        raise Lookup(f'msgs show: {e}') from e


def amount_pattern(charge):
    """The amount written as money in the charge's currency: EUR 1,234.50, 1.234,50 €, $199, AED266.79.
    A bare number isn't money: "2026-10-25 00:12" reads as 25.00 in the archive's search."""
    a = Decimal(charge['amount'])
    whole, cents = f'{a:.2f}'.split('.')
    grouped = f'{int(whole):,}'
    forms = {f'{whole}.{cents}', f'{whole},{cents}', f'{grouped}.{cents}', f"{grouped.replace(',', '.')},{cents}"}
    if cents == '00':
        forms |= {whole, grouped, grouped.replace(',', '.')}
    amount = r'(?<![\d.,])(?:' + '|'.join(map(re.escape, sorted(forms, key=len, reverse=True))) + r')(?![\d]|[.,]\d)'
    code = re.escape(charge['currency'].upper())
    signs = [re.escape(x) for x in SYMBOLS.get(charge['currency'].upper(), [])]
    before, after = '|'.join([rf'\b{code}'] + signs), '|'.join([rf'{code}\b'] + signs)
    return re.compile(rf'(?:{before})\s?{amount}|{amount}\s?(?:{after})', re.I)


def last_four(charge):
    return re.compile(rf'(?<!\d){charge["card"]}(?!\d)')


CHAT_LINE = re.compile(r'^(?P<mark>[ >]) +\d+ [\d?]{4}-[\d?]{2}-[\d?]{2} [\d?]{2}:[\d?]{2} [^:]*: ')


def alert_text(shown):
    """Selected msgs-show body, including continuations but excluding neighboring messages."""
    body = None
    for line in shown.splitlines():
        header = CHAT_LINE.match(line)
        if body is not None:
            if header:
                break
            body.append(line)
        elif header and header['mark'] == '>':
            body = [line[header.end():]]
    if body is not None:
        return '\n'.join(body)
    return shown


HEADER = re.compile(r'^(?:Account|Date|From|To|Cc|Subject|File|Message-ID|Folder):', re.I)


def body_key(text):
    """The mail's words without its headers: copies of one notice differ only in Date and File."""
    lines = [ln for ln in str(text).splitlines() if not HEADER.match(ln.strip())]
    return ' '.join(' '.join(lines).split())


def receipt_window(at, now, named):
    before, after = (RECEIPT_BEFORE, WAIT) if named else (SAME_TIME, SAME_TIME)
    # Bank alert times may be quoted only to the minute. Keep that allowance identical
    # for candidate matching, archive bounds and checks for competing charges.
    return at - before, min(min(now, at + after) + dt.timedelta(minutes=1), at + WAIT)


def receipt_variant(charge):
    if charge['currency'] != 'AED':
        return None
    name = words(charge['merchant'])
    if name == ['uber'] and charge.get('pending'):
        return 'uber'
    if name in (['boat', 'dev'], ['browser', 'use']):
        return 'usd'
    return None


def labelled_money(text, label, currency):
    number = r'(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?(?![\d.,])'
    signs = '|'.join([rf'\b{currency}\b'] + [re.escape(s) for s in SYMBOLS[currency]])
    pattern = rf'\b{label}\b\s*:?\s*(?:(?:{signs})\s*({number})|({number})\s*(?:{signs}))'
    return {Decimal((m[1] or m[2]).replace(',', '')) for m in re.finditer(pattern, text, re.I)}


def alternate_receipt(charge, at, now, row, text):
    variant = receipt_variant(charge)
    if not variant or not RECEIPT_WORDS.search(text):
        return False
    # These bank descriptors were verified against branded receipts, not arbitrary
    # mentions of generic descriptor words such as "dev", "browser" or "use".
    brand = r'\buber\b' if variant == 'uber' else \
        r'\bboat(?:\.dev)?\b' if words(charge['merchant']) == ['boat', 'dev'] else r'\bbrowser[\s-]+use\b'
    if not re.search(brand, text, re.I) or not re.search(brand, str(row.get('sender') or ''), re.I):
        return False
    if variant == 'usd' and not re.fullmatch(brand + r'(?:\s+Inc\.?)?',
                                            parseaddr(str(row.get('sender') or ''))[0].strip(), re.I):
        return False
    received = dt.datetime.fromtimestamp(row.get('ts') or 0, TZ)
    start, end = receipt_window(at, now, True)
    if not start <= received <= end:
        return False
    amount = Decimal(charge['amount'])
    if amount <= 0:
        return False
    if variant == 'usd':
        paid = labelled_money(text, 'amount paid', 'USD')
        if len(paid) != 1 or next(iter(paid)) <= 0:
            return False
        # Both observed AED 190.47 charges have USD 50 receipts: the AED peg
        # plus 3.7% bank markup. Only these verified merchants use the 0–4% band.
        base = next(iter(paid)) * Decimal('3.6725')
        return base.quantize(Decimal('.01')) <= amount <= (base * Decimal('1.04')).quantize(Decimal('.01'))
    domain = parseaddr(str(row.get('sender_addr') or row.get('sender') or ''))[1].rpartition('@')[2].lower()
    if domain != 'uber.com' and not domain.endswith('.uber.com'):
        return False
    if not at <= received <= min(now + dt.timedelta(minutes=1), at + dt.timedelta(hours=2)):
        return False
    totals = labelled_money(text, 'total', 'AED')
    waits = labelled_money(text, 'wait time', 'AED')
    if len(totals) != 1 or len(waits) > 1:
        return False
    total = next(iter(totals))
    candidates = {total}
    # Two holds equal the final total before its explicitly itemized wait-time
    # fee; a third differs by AED 0.09. Do not tolerate an arbitrary fare change.
    if waits and 0 <= next(iter(waits)) < total:
        candidates.add(total - next(iter(waits)))
    tolerance = min(Decimal('1.00'), amount * Decimal('.01'))
    return any(abs(amount - candidate) <= tolerance for candidate in candidates)


def receipt(charge, at, now, find=None, deadline=None, read=None, memo=None, stats=None, receipt_ok=None):
    """The receipt or order mail for a charge. It shows the amount as money in the charge's currency
    and reads as a receipt, and either names the merchant (from two hours before to 36 hours after) or,
    under another name, shows the card's last four digits within 15 minutes of it. Search hits are
    checked against the mail itself. Verified pending-hold and USD conversion variants
    additionally require a branded receipt and the bounded amount proof above."""
    options = {}
    if memo is not None:
        options['memo'] = memo
    if stats is not None:
        options['stats'] = stats
    find = find or (lambda *a, **kw: search(*a, **kw, all_copies=True, **options))
    read = read or (lambda row, deadline: show(row, deadline, **options))
    amount = ' OR '.join(f'"{v}"' for v in amounts(charge))
    money, card = amount_pattern(charge), last_four(charge)
    names = words(charge['merchant'])
    named = re.compile(r'\b(?:' + '|'.join(map(re.escape, names)) + r')\b', re.I) if names else None
    tries = []
    variant = receipt_variant(charge)
    integral = Decimal(charge['amount']) == Decimal(charge['amount']).to_integral_value()
    # "$1" is just the common token "1" to FTS. For whole amounts, find candidates
    # by merchant/card instead; the same currency/amount proof below still decides.
    if names:
        # Questions can remain unanswered indefinitely; a later recurring purchase's receipt
        # must not explain them merely because its merchant and amount happen to repeat.
        exact = lambda row, text: money.search(text) and named.search(text) and RECEIPT_WORDS.search(text)
        named_query = ' OR '.join(f'"{w}"' for w in names)
        tries.append(((named_query if integral else amount + ' ' + named_query),
                      *receipt_window(at, now, True), exact, 'exact'))
    tries.append((f'"{charge["card"]}"' if integral else amount, *receipt_window(at, now, False),
                  lambda row, text: money.search(text) and card.search(text) and RECEIPT_WORDS.search(text), 'exact'))
    if variant:
        # Preserve exact-search priority and reserve a separate bounded allowance:
        # generic dev/browser words or amount-only notices must not starve the brand query.
        query = '"uber"' if variant == 'uber' else '"boat"' if names == ['boat', 'dev'] else '"browser use"'
        window = (at, min(now + dt.timedelta(minutes=1), at + dt.timedelta(hours=2))) \
            if variant == 'uber' else receipt_window(at, now, True)
        tries.append((query, *window, lambda row, text: exact(row, text)
                      or alternate_receipt(charge, at, now, row, text), 'variant'))
    reads, seen_bodies, incomplete, read_limited = {'exact': 0, 'variant': 0}, set(), False, False
    for query, start, end, proves, budget in tries:
        # Usage notices with the same amount and merchant can fill a page of hits, so the search goes
        # wider than one page. Reads are capped, and a body already read counts for nothing new: a
        # run of identical notices must not use up the reads before the receipt.
        # msgs accepts date bounds, with an exclusive until. Include the final day;
        # the exact shared timestamp window below filters the remaining partial day.
        until = day(end + dt.timedelta(days=1))
        count = 0
        rows = find(query, day(start), until=until, source='email', n=RECEIPT_HITS, deadline=deadline)
        for row in rows:
            count += 1
            ts = row.get('ts') or 0
            if not (start.timestamp() <= ts <= end.timestamp()) or row.get('from_me') \
                    or BANKS.search(str(row.get('sender') or '')):
                continue
            text = read(row, deadline)
            key = body_key(text)
            # A later query can prove a variant from a body whose exact amount failed.
            if key not in seen_bodies:
                if reads[budget] >= RECEIPT_READS:
                    if not variant:
                        raise Lookup('receipt scan incomplete: read limit reached')
                    read_limited = True
                    break
                reads[budget] += 1
                seen_bodies.add(key)
            if proves(row, text):
                if receipt_ok is None or receipt_ok(row, text):
                    return row
        incomplete = incomplete or getattr(rows, 'raw_count', count) >= RECEIPT_HITS
    if read_limited:
        raise Lookup('receipt scan incomplete: read limit reached')
    if incomplete:
        raise Lookup('receipt scan incomplete: search limit reached')
    return None


# Where one statement ends and the next begins: "I paid Amazon AED 50. Send me the Apple keynote" is two.
CLAUSES = re.compile(r'[.!?;:\n]+(?=\s|$)|,\s+|\s+(?:and|then|but|also|plus)\s+', re.I)
_CODES = r'(?:AED|USD|EUR|GBP|INR|JPY|CNY|SAR|QAR|KWD|OMR|BHD|CAD|AUD|CHF|SGD|HKD|dhs?|dirhams?|bucks|dollars?|euros?|pounds?|rupees?)'
MONEY = re.compile(rf'(?:\b{_CODES}\b|[$€£¥₹])\s?\d|\d[\d,.]*\s?(?:\b{_CODES}\b|[$€£¥₹])', re.I)


# The seller after "from/at/on/via/through": one to four words, never starting with a determiner ("with my
# ENBD card" is an instrument, not a seller), and stopping before a purpose, instrument or product phrase
# ("from Amazon for my Apple laptop" buys from Amazon). A missing seller falls back to the payee after the verb.
SELLER_STOP = r"(?:for|using|with|via|through|by|on|in|my|your|our|the|a|an|this|that|to|and|but|then|so)"
SELLER_FROM = re.compile(
    r"\b(?:from|at|on|via|through)\s+(?!" + SELLER_STOP + r"\b)"
    r"(?P<seller>[\w.*/&'-]+(?:\s+(?!" + SELLER_STOP + r"\b)[\w.*/&'-]+){0,3})(?=\s+" + SELLER_STOP + r"\b|[.,;!?]|$)",
    re.I)


OWNS = re.compile(r"\b(?:(?:is|are|was|it'?s|that'?s) mine|mine)\b", re.I)
# A payment method is how he paid, never who was paid: "with Apple Pay", "via Apple Pay", "on my card".
# It is cut from the clause before any payee or seller is read, so "Apple Pay" can't stand in for Apple.
# How he paid, never who was paid. Only a method phrase is cut: "with/via/using/on" a payment method, or a
# card with its issuer ("with my ENBD card"). A bare "account" or "wallet" is a destination, not a method:
# "I topped up my Apple account" funds Apple, so it stays as the payee.
PAYMENT_METHOD = re.compile(r"\b(?:with|via|using|through|on|by)\s+(?:my\s+|the\s+|his\s+|our\s+)?"
                            r"(?:(?:[A-Za-z]+\s+)?(?:card|cheque)|(?:apple|google|samsung)\s+(?:pay|wallet)|paypal|"
                            r"bank\s+transfer|cash)\b(?:\s+(?:ending|no\.?|number)?\s*\d{4})?", re.I)


def buys_from(clause, pattern):
    """Whether this clause says he bought from the merchant. "I ordered an Apple charger from Amazon"
    buys from Amazon: the purchase verb is followed by a seller word, and the merchant has to be the
    seller, not the product brand. "I paid Apple" with no seller word names the merchant itself. Owning
    it ("the Apple charge is mine") is separate and needs no seller."""
    # How he paid is not who he paid: it is cut out before the payee or seller is read.
    clause = PAYMENT_METHOD.sub(' ', clause)
    if OWNS.search(clause) and pattern.search(clause):
        return True
    m = OWNER_BUYS.search(clause)
    if not m or OWNS.search(clause[m.start():]):
        return bool(m) and bool(pattern.search(clause))
    # A purchase noun ("acme order", "order #123") names what he bought without a seller word.
    if not re.match(r"(?:ordering|ordered|paying|paid|set ?up|subscrib|top|bought|buying)", m.group(0), re.I):
        return bool(pattern.search(clause))
    tail = clause[m.end():]
    seller = SELLER_FROM.search(tail)
    if seller:
        return bool(pattern.search(seller.group('seller')))
    # No seller phrase: only the payee right after the verb counts ("I paid Apple", "ordered Apple").
    # Anything else in the tail ("with Apple Pay", "Apple gear through the Amazon store") is ambiguous
    # and leaves the charge unexplained.
    # The payee is the whole phrase right after the verb: it ends the clause, so "Apple Pay" or "Apple gear"
    # after it is a different thing (the instrument, the product), not the payee.
    # After the payee only an amount and his payment instrument may follow ("Apple USD 99 with my ENBD card").
    after = r"(?:\s+(?:" + MONEY.pattern + r"|[$€£¥₹]\s?\d[\d,.]*|\d[\d,.]*|for\s+(?:my|the|his|our)?\s*[\w.*/&'-]+(?:\s+[\w.*/&'-]+){0,2}|(?:with|using|on)\s+(?:my|the|his|our)?\s*[\w.*/&'-]*\s*(?:card|account|wallet|pay)\b.*?))*"
    payee = re.match(r"\s*(?:(?:the|my|his|our)\s+)?(?P<payee>[\w.*/&'-]+(?:\s+[\w.*/&'-]+){0,2}?)" + after + r"\s*$", tail, re.I)
    return bool(payee) and bool(pattern.search(payee.group('payee')))


def owner_said(charge, at, now, said=None, deadline=None):
    said = said or owner_texts
    names = words(charge['merchant'])
    if not names:
        return None
    pattern = re.compile(r'\b(?:' + '|'.join(map(re.escape, names)) + r')\b', re.I)
    money = amount_pattern(charge)
    for created, text, title in said(at - OWNER_AROUND, min(now, at + OWNER_AROUND), deadline=deadline):
        # Phone keyboards type curly apostrophes ("That’s"); the patterns only know the straight one.
        text = text.replace('\u2019', "'").replace('\u2018', "'")
        # "It isn't mine", "what's the Acme charge?" or "Have I paid Acme" anywhere in the message explains
        # nothing. The whole message is checked, before it is split, so a "?" is never cut off its clause.
        parts = CLAUSES.split(text)
        # A denial in any clause vetoes the whole message before any clause is accepted, so a later "No Apple
        # orders from me" can't be outvoted by an earlier "I paid Apple". A clause about the merchant or the
        # charge that denies it is a denial; "no need to ask" names neither, so it doesn't veto.
        denied = any(CORRECTION.search(c) or (VETO.search(c) and (pattern.search(c) or OWNS.search(c) or OWNER_BUYS.search(c)))
                     for c in parts)
        if NOT_MINE.search(text) or denied or any(ASKS.search(c) for c in parts):
            continue
        # The purchase words have to be about this merchant, in the same statement: "I paid Amazon AED 50.
        # Send me the Apple keynote summary." pays Amazon, not Apple. An amount in that statement has to be
        # this charge's: "I paid AED 50 for the Apple cable" isn't a USD 99 Apple charge.
        for clause in parts:
            if NEGATED.search(clause):
                continue
            if buys_from(clause, pattern) and (not MONEY.search(clause) or money.search(clause)):
                return created, text, title
    return None


def known(charge, at, find=None, deadline=None, read=None, stats=None, memo=None):
    """How he already pays this merchant, from before the last half day: 'receipt' when a mail with
    a receipt from it came, 'bank' when an earlier bank alert was a charge from it, else None."""
    options = {} if stats is None else {'stats': stats}
    if memo is not None:
        options['memo'] = memo
    find = find or (lambda *a, **kw: search(*a, **kw, all_copies=True, **options))
    read = read or (lambda *a, **kw: show(*a, **kw, **options))
    names = words(charge['merchant'])
    if not names:
        return None
    key, before = set(names), at - KNOWN_GAP
    named = ' OR '.join(f'"{w}"' for w in names)
    since, until = day(at - KNOWN_SINCE), day(before)
    name_re = re.compile(r'\b(?:' + '|'.join(map(re.escape, names)) + r')\b', re.I)

    def older(rows):
        if getattr(rows, 'raw_count', len(rows)) >= 30:
            raise Lookup('merchant history incomplete: search limit reached')
        return [r for r in rows if (r.get('ts') or 0) < before.timestamp() and not r.get('from_me')]

    # Newsletters name big merchants all the time, so mail the merchant sent itself is read first,
    # and bank alerts get their own search. Each read is a msgs show; three of each is enough.
    mails = [r for r in older(find(f'{named} receipt OR invoice OR billed OR paid OR order', since,
                                   until=until, source='email', n=30, deadline=deadline))
             if not BANKS.search(str(r.get('sender') or ''))]
    mails.sort(key=lambda r: not name_re.search(str(r.get('sender') or '')))
    for row in mails[:3]:
        text = read(row, deadline)
        if RECEIPT_WORDS.search(text) and name_re.search(text):
            return 'receipt'
    banks = [r for r in older(find(f'{named} "card"', since, until=until, n=30, deadline=deadline))
             if BANKS.search(str(r.get('sender') or ''))]
    for row in banks[:3]:
        old = parse(alert_text(read(row, deadline)), str(row.get('sender') or ''))
        if old and old['kind'] == 'charge' and key & set(words(old['merchant'])):
            return 'bank'
    return None


def found(charge, at, now, deadline=None, find=None, said=None, errors=None, memo=None, stats=None, receipt_ok=None, limits=None):
    """A receipt or his own words that explain the charge, or None."""
    errors = [] if errors is None else errors
    limits = [] if limits is None else limits
    receipt_result = 'error'
    receipt_end = time.time()
    try:
        # Several fast searches/reads can exhaust a two-second scan. Keep the
        # per-process cap, but allow four seconds inside the six-second question,
        # leaving two for order history even when a finder ignores its timeout.
        mail_end = time.time() + RECEIPT_BUDGET
        if deadline is not None:
            mail_end = min(mail_end, deadline)
        receipt_end = mail_end
        alarm = signal.getitimer(signal.ITIMER_REAL)[0]
        if alarm:
            receipt_end = min(receipt_end, time.time() + alarm)
        with step_timing(stats, 'receipt', mail_end), within(mail_end, Lookup('receipt lookup over time')):
            row = receipt(charge, at, now, find, mail_end, memo=memo, stats=stats, receipt_ok=receipt_ok)
        receipt_result = 'found' if row else 'none'
        if row:
            when = dt.datetime.fromtimestamp(row['ts'], TZ).strftime('%a %d %b %H:%M')
            return {'verdict': 'receipt', 'why': f"receipt {when}: {row.get('sender', '')} - {row.get('subject', '')}"[:200],
                    'msgs': row.get('id'), 'errors': errors}
    except Lookup as e:
        receipt_result = 'out_of_time' if getattr(e, '_money_cases_timeout', False) or \
            time.time() >= receipt_end or 'out of time' in str(e) or \
            'over time' in str(e) or isinstance(e.__cause__, subprocess.TimeoutExpired) else 'error'
        errors.append(f'receipt: {e}')
    except BaseException as exc:
        if getattr(exc, '_money_cases_timeout', False) or time.time() >= receipt_end:
            receipt_result = 'out_of_time'
        raise
    finally:
        target = stats if stats is not None else TIMING_STATS.get()
        if target is not None:
            counts = target.setdefault('receipt_result', {})
            counts[receipt_result] = counts.get(receipt_result, 0) + 1
    try:
        hit = order_receipt(charge, at, now, deadline, memo=memo, stats=stats)
        if hit:
            return {**hit, 'errors': errors}
    except SourceLimit as e:
        limits.append({'why': str(e), 'kinds': e.kinds})
    except Lookup as e:
        errors.append(f'orders: {e}')
    if card_owner(charge) == 'moni':
        return None
    return owner_found(charge, at, now, deadline, said, errors)


def owner_found(charge, at, now, deadline=None, said=None, errors=None):
    errors = [] if errors is None else errors
    try:
        hit = owner_said(charge, at, now, said, deadline)
        if hit:
            when = dt.datetime.fromisoformat(hit[0].replace('Z', '+00:00')).astimezone(TZ).strftime('%H:%M')
            return {'verdict': 'owner', 'why': f'he wrote about it at {when} in "{hit[2]}": {hit[1][:100]}',
                    'errors': errors}
    except Lookup as e:
        errors.append(f'his threads: {e}')
    return None


def explain(charge, at, now, deadline=None, find=None, said=None, receipt_ok=None, *, memo=None, stats=None):
    """verdict receipt | owner | wait | ask, with why and any lookup errors."""
    errors, limits = [], []
    owner = card_owner(charge)
    if charge['kind'] != 'charge' and owner == 'moni':
        return {'verdict': 'held', 'why': 'held for Moni', 'errors': []}
    if charge['kind'] != 'charge':
        return {'verdict': 'ask', 'why': 'a declined payment goes to him', 'errors': errors}
    hit = found(charge, at, now, deadline, find, said, errors, memo, stats, receipt_ok=receipt_ok, limits=limits)
    if hit:
        return hit
    if errors:
        return {'verdict': 'unverified', 'why': 'sources unreadable; do not ask', 'errors': errors, 'limits': limits}
    if limits:
        return {'verdict': 'unverified', 'why': 'source limit: ' + '; '.join(l['why'] for l in limits) + '; do not ask',
                'errors': [], 'limits': limits}
    if owner == 'moni':
        return {'verdict': 'held', 'why': 'held for Moni', 'errors': []}
    if now < at + WAIT:
        try:
            with step_timing(stats, 'history', deadline):
                how = known(charge, at, find, deadline, stats=stats, memo=memo)
            # A merchant that mails receipts gets its receipt waited for ("Wait for the email", 24 Oct);
            # one he only has bank alerts from is waited for when this is a pending hold.
            if how == 'receipt' or (how == 'bank' and charge['pending']):
                until = at + WAIT
                why = 'a merchant that mails him receipts' if how == 'receipt' else 'a pending hold from a merchant he uses'
                return {'verdict': 'wait', 'why': why + ': wait for the receipt',
                        'until': until.isoformat(timespec='seconds'), 'errors': errors}
        except Lookup as e:
            errors.append(f'merchant history: {e}')
    return {'verdict': 'unverified' if errors else 'ask',
            'why': 'sources unreadable; do not ask' if errors else 'no receipt, nothing he wrote, and nothing to wait for',
            'errors': errors}
