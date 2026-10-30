#!/usr/bin/python3
"""Open money cases: one row per case, deadline pings and ended reply watchers.

  money-cases list [--all] [--json]
  money-cases show ID
  money-cases add ID --merchant M --amount 12.34 --currency AED --state S --next N
                  --deadline D --who W [--reference R] [--why TEXT] [--watcher ID]...
  money-cases update ID [--merchant M] [--amount A] [--currency C] [--reference R]
                  [--state S] [--next N] [--deadline D] [--why TEXT] [--who W]
                  [--add-watcher ID] [--drop-watcher ID] [--note TEXT]
  money-cases close ID --outcome TEXT
  money-cases reopen ID --deadline D --note TEXT
  money-cases brief    one line for the morning brief, nothing when no case is open
  money-cases check    the robob-watch check for the money-cases watcher

Charge questions (owner rule, nightly 2026-10-24: never ask about a charge a receipt or his own
words already explain, wait for the receipt from a merchant he already pays, never ask a third time):
  money-cases charge ALERT [--sender S] [--at T] [--now T]   is a card alert explained? (reads only)
  money-cases ask (ALERT --at T [--sender S] | --id QID) --said QUESTION
                       run before asking him about a charge: exit 0 = ask now (counted), 3 = don't
  money-cases answered QID --note TEXT
  money-cases questions [--all] [--json]

A deadline is a date (09:00 Dubai that day) or an ISO time. Every open case has one.
"""
import argparse
import datetime as dt
from decimal import Decimal, InvalidOperation
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sys
import tempfile
import time
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
import charges  # noqa: E402

TZ = ZoneInfo('Asia/Dubai')
DATA = Path(os.environ.get('MONEY_CASES_DIR', '~/Documents/assistant/money-cases')).expanduser()
WATCH_ROOT = Path(os.environ.get('ROBOB_WATCH_ROOT', '~/.local/share/robob-watch')).expanduser()
LIVE = WATCH_ROOT / 'watchers' / 'money-cases'
SOON = dt.timedelta(hours=24)
BRIEF_DUE = dt.timedelta(hours=48)
BRIEF_CHANGED = dt.timedelta(hours=24)
QUIET = (23, 8)  # Dubai hours: no pings from 23:00 until 08:00
KEEP_SENT = dt.timedelta(days=60)
# Charge questions: alerts this close with the same card, amount and merchant are one charge. One
# ask and one re-ask (not within REASK_GAP of the first); CASE_AFTER the re-ask without an answer,
# or FOLLOW_FOR after the charge, the question becomes a money case.
SAME_CHARGE = dt.timedelta(minutes=15)
# The same alert seen twice (a re-run, or an ask whose --at is the minute shown) lands this close;
# a second alert on the same channel further apart is a second charge.
ALERT_SAME = dt.timedelta(minutes=2)
MAX_ASKS = 2
REASK_GAP = dt.timedelta(hours=6)
CASE_AFTER = dt.timedelta(hours=12)
FOLLOW_FOR = dt.timedelta(days=7)
# A charge that became a money case is still looked up this long, so a late receipt settles it.
FOLLOW_CASE = dt.timedelta(days=30)
FOLLOW_BUDGET = 25  # seconds of archive lookups per check
FOLLOW_EACH = 8  # at most this many of them per question, least recently checked first
DONT_ASK = 3
# The runner clips an event at 6,000 characters; cases past this limit wait for the next check.
EVENT_LIMIT = 4000
ID = re.compile(r'[a-z0-9][a-z0-9-]{0,47}')
FIELDS = ('merchant', 'amount', 'currency', 'reference', 'state', 'next', 'deadline', 'why', 'who')
CARD = re.compile(r'(?<!\d)[2-6](?:[ -]?\d){14,15}(?!\d)')
# A secret is a labelled value: a code of 3-12 digits (grouped or not) a few words after the label, a token
# with a digit right after it ("code", "is", ":"), or anything assigned to a password. The match is removed.
_LABEL = (r'(?:otp|one[- ]time (?:pass)?code|verification code|security code|passcode|password|passwd|pwd'
          r'|cvv|cvc|pin)')
LABELLED = re.compile(
    rf'\b{_LABEL}\b(?:\s*(?:[:=#-]|\b[a-z]+\b)){{0,3}}\s*\d(?:[ -]?\d){{2,11}}(?!\w)'
    rf'|\b{_LABEL}\b(?:\s*(?:code|number|no\.?|is|was|[:=#-])){{0,3}}\s*\S*\d\S*'
    r'|\b(?:password|passwd|passcode|pwd)\b\s*(?:(?:is|was)\s*)?[:=]\s*\S+', re.I)


class CaseError(Exception):
    pass


def luhn(digits):
    total = 0
    for i, d in enumerate(reversed(digits)):
        n = int(d) * (2 if i % 2 else 1)
        total += n - 9 if n > 9 else n
    return total % 10 == 0


def card_numbers(text):
    return [m for m in CARD.finditer(text) if luhn(re.sub(r'\D', '', m.group()))]


def redact(text):
    """Event text reaches runner logs and fallback channels, so a hand-edited book can't leak a card or code."""
    text = str(text)
    for m in reversed(card_numbers(text)):
        text = text[:m.start()] + '[card number removed]' + text[m.end():]
    return LABELLED.sub('[secret removed]', text)


def redact_all(obj):
    """Redact every string in a stored row, so show and list --json print a hand-edited book safely."""
    if isinstance(obj, str):
        return redact(obj)
    if isinstance(obj, list):
        return [redact_all(x) for x in obj]
    if isinstance(obj, dict):
        return {k: redact_all(v) for k, v in obj.items()}
    return obj


def check_secret(name, text):
    if card_numbers(text) or LABELLED.search(text):
        raise CaseError(f'{name} looks like it holds a card number, code or password; keep those out of the book')
    return text


def now_dubai():
    return dt.datetime.now(TZ)


def stamp(t=None):
    return (t or now_dubai()).isoformat(timespec='seconds')


def parse_time(text):
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}', text):
        return dt.datetime.combine(dt.date.fromisoformat(text), dt.time(9), TZ)
    t = dt.datetime.fromisoformat(text.replace('Z', '+00:00'))
    return t if t.tzinfo else t.replace(tzinfo=TZ)


def deadline_of(case):
    """The case deadline, or None when the stored value can't be read."""
    try:
        return parse_time(case['deadline'])
    except (KeyError, TypeError, ValueError):
        return None


def check_deadline(text):
    try:
        parse_time(text)
    except ValueError:
        raise CaseError(f'deadline {text!r} is not a date (YYYY-MM-DD) or an ISO time')
    return text


def check_amount(text):
    try:
        value = Decimal(text.replace(',', ''))
    except InvalidOperation:
        raise CaseError(f'amount {text!r} is not a number')
    if not value.is_finite() or value < 0 or value >= 10 ** 12:
        raise CaseError(f'amount {text!r} must be a positive number under a trillion')
    return format(value, 'f')


def check_currency(text):
    if not re.fullmatch(r'[A-Za-z]{3}', text):
        raise CaseError(f'currency {text!r} must be a 3-letter code')
    return text.upper()


def check_text(name, text, required=True):
    text = (text or '').strip()
    if required and not text:
        raise CaseError(f'{name} is empty')
    return check_secret(name, text)


def check_watcher(watcher_id, root=None):
    if not ID.fullmatch(watcher_id):
        raise CaseError(f'watcher id {watcher_id!r} is not a robob-watch id')
    if not ((root or WATCH_ROOT) / 'watchers' / watcher_id / 'watcher.json').exists():
        raise CaseError(f'no robob-watch watcher {watcher_id!r}; create it first')
    return watcher_id


def money(case):
    return f"{case['currency']} {Decimal(case['amount']):,}"


def day(t):
    return f"{t:%a} {t.day} {t:%b}"


def when(t):
    t = t.astimezone(TZ)
    return day(t) if (t.hour, t.minute) == (9, 0) else f'{day(t)} {t:%H:%M}'


def read_json(path, default):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(obj, f, ensure_ascii=False, indent=1)
            f.write('\n')
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def load(data=None):
    data = data or DATA
    book = read_json(data / 'cases.json', {'version': 1, 'cases': []})
    if not isinstance(book, dict) or not isinstance(book.get('cases'), list):
        raise CaseError(f'{data / "cases.json"} is not a cases file')
    return book


def load_questions(data=None):
    data = data or DATA
    book = read_json(data / 'questions.json', {'version': 1, 'questions': []})
    if not isinstance(book, dict) or not isinstance(book.get('questions'), list):
        raise CaseError(f'{data / "questions.json"} is not a questions file')
    return book


class Locked:
    """Serialise read-modify-write of cases.json (or questions.json) between CLI calls and checks."""

    def __init__(self, data, name='cases'):
        self.data, self.name = data, name

    def __enter__(self):
        self.data.mkdir(parents=True, exist_ok=True)
        self.lock = (self.data / f'{self.name}.lock').open('a')

        def timed_out(*_):
            raise CaseError(f'{self.name}.lock still held after 10s')
        previous = signal.signal(signal.SIGALRM, timed_out)
        signal.alarm(10)
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX)
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, previous)
        try:
            self.book = load(self.data) if self.name == 'cases' else load_questions(self.data)
        except BaseException:
            self.lock.close()
            raise
        return self.book

    def __exit__(self, kind, *_):
        try:
            if kind is None:
                # Question rows quote alerts, receipts and his own words; nothing secret is stored.
                book = self.book if self.name == 'cases' else redact_all(self.book)
                write_json(self.data / f'{self.name}.json', book)
        finally:
            self.lock.close()


def find(book, case_id):
    for case in book['cases']:
        if case['id'] == case_id:
            return case
    raise CaseError(f'no case {case_id!r}')


def add(data, case_id, merchant, amount, currency, state, next_action, deadline, who,
        reference='', why='', watchers=(), at=None, root=None):
    if not ID.fullmatch(case_id):
        raise CaseError(f'id {case_id!r} must be lowercase letters, digits and dashes')
    case = {
        'id': case_id, 'merchant': check_text('merchant', merchant), 'amount': check_amount(amount),
        'currency': check_currency(currency), 'reference': check_text('reference', reference, False),
        'state': check_text('state', state), 'next': check_text('next', next_action),
        'deadline': check_deadline(deadline), 'why': check_text('why', why, False), 'who': check_text('who', who),
        'watchers': [check_watcher(w, root) for w in dict.fromkeys(watchers)], 'status': 'open',
        'rev': 0, 'cycle': 0,
        'opened': stamp(at), 'updated': stamp(at), 'closed': None, 'outcome': None,
        'history': [{'at': stamp(at), 'text': 'opened'}],
    }
    with Locked(data) as book:
        if any(c['id'] == case_id for c in book['cases']):
            raise CaseError(f'case {case_id!r} already exists')
        book['cases'].append(case)
    return case


def update(data, case_id, changes, add_watchers=(), drop_watchers=(), note='', at=None, root=None):
    checks = {'amount': check_amount, 'currency': check_currency, 'deadline': check_deadline}
    with Locked(data) as book:
        case = find(book, case_id)
        said = []
        for field, value in changes.items():
            if value is None:
                continue
            if field in checks:
                value = checks[field](value)
            else:
                value = check_text(field, value, field not in ('reference', 'why'))
            if case.get(field) != value:
                said.append(f'{field}: {value}')
                case[field] = value
                if field == 'deadline':
                    # A new revision re-arms deadline pings, even when the date goes back to an earlier one.
                    case['rev'] = case.get('rev', 0) + 1
        for w in add_watchers:
            check_watcher(w, root)
            if w not in case['watchers']:
                case['watchers'].append(w)
                said.append(f'watcher {w} linked')
        for w in drop_watchers:
            if w in case['watchers']:
                case['watchers'].remove(w)
                said.append(f'watcher {w} unlinked')
        if note:
            said.append(check_text('note', note))
        if not said:
            raise CaseError('nothing to change')
        case['updated'] = stamp(at)
        case['history'].append({'at': stamp(at), 'text': '; '.join(said)})
    return case


def close(data, case_id, outcome, at=None):
    with Locked(data) as book:
        case = find(book, case_id)
        if case['status'] == 'closed':
            raise CaseError(f'case {case_id!r} is already closed')
        case.update(status='closed', closed=stamp(at), outcome=check_text('outcome', outcome), updated=stamp(at))
        case['history'].append({'at': stamp(at), 'text': 'closed: ' + case['outcome']})
    return case


def reopen(data, case_id, deadline, note, at=None):
    with Locked(data) as book:
        case = find(book, case_id)
        if case['status'] == 'open':
            raise CaseError(f'case {case_id!r} is open')
        note = check_text('note', note)
        case.update(status='open', closed=None, outcome=None, deadline=check_deadline(deadline), updated=stamp(at),
                    rev=case.get('rev', 0) + 1, cycle=case.get('cycle', 0) + 1)
        case['history'].append({'at': stamp(at), 'text': 'reopened: ' + note})
    return case


def watcher_state(folder):
    try:
        return json.loads((folder / 'state.json').read_text())
    except (OSError, ValueError):
        return None


def watcher_end(watcher_id, root=None):
    """How a linked reply watcher ended, or None while it still runs or can't be read.

    `robob-watch remove` moves a watcher to archive/<id>-<ms>; an archived watcher that had already
    finished reads as that same ending, so cleaning it up doesn't raise the case again."""
    root = root or WATCH_ROOT
    folder = root / 'watchers' / watcher_id
    if not folder.exists():
        archived = sorted((p for p in (root / 'archive').glob(watcher_id + '-*')
                           if re.fullmatch(re.escape(watcher_id) + r'-\d+', p.name)),
                          key=lambda p: int(p.name.rsplit('-', 1)[1]))
        if not archived:
            return ('missing', "isn't a robob-watch watcher (typo, or never created)")
        folder = archived[-1]
        state = watcher_state(folder) or {}
        if state.get('status') not in ('done', 'expired'):
            return ('removed', 'removed')
    state = watcher_state(folder)
    if state is None:
        return None
    status = state.get('status')
    if status == 'done':
        return ('done', f"done after {state.get('fires', 0)} fire(s), last {state.get('last_fire_at', '?')}")
    if status == 'expired':
        return ('expired', f"expired after {state.get('fires', 0)} fire(s), at {state.get('last_run_at', '?')}")
    return None


def clip(text, n=160):
    text = ' '.join(text.split())
    return text if len(text) <= n else text[:n - 1] + '…'


def attention(cases, now, sent, root=None):
    """(head, items, tail) for each open case with pings it hasn't had; items are (key, text) pairs."""
    entries = []
    for case in cases:
        if case.get('status') != 'open':
            continue
        deadline = deadline_of(case)
        cid = case['id']
        # rev changes with every deadline edit, cycle with every reopen, so both re-arm pings.
        rev, cycle = case.get('rev', 0), case.get('cycle', 0)
        # Redact before clipping: a clipped card number would no longer match.
        head = f"- {cid}: {clip(redact(case['merchant']), 80)} {clip(money(case), 40)}"
        if case.get('reference'):
            head += f" (ref {clip(redact(case['reference']), 80)})"
        found = []
        if deadline is None:
            found.append((f'{cid}|r{rev}|no-deadline', 'has no valid deadline; set one'))
        elif now >= deadline:
            found.append((f'{cid}|r{rev}|overdue|{now.date()}', f'OVERDUE since {when(deadline)}'))
        elif now >= deadline - SOON:
            found.append((f'{cid}|r{rev}|soon', f'due {when(deadline)}'))
        for w in case.get('watchers', []):
            end = watcher_end(w, root)
            if end:
                found.append((f'{cid}|c{cycle}|watcher|{w}|{end[1]}',
                              f'reply watcher {w} {clip(redact(end[1]), 120)} while the case is still open. '
                              f'Options: chase again with a new reply watcher, take the next step, or close the case'))
        found = [(k, t) for k, t in found if k not in sent]
        if found:
            tail = (f"Next: {clip(redact(case['next']))}. Who: {clip(redact(case['who']), 60)}. "
                    f"State: {clip(redact(case['state']))}")
            entries.append((head, found, tail))
    return entries


def case_line(head, texts, tail):
    return redact(f"{head}: {'; '.join(texts)}. {tail}")


def fit(text, n):
    while units(text) > n:
        text = text[:max(0, min(len(text), n) - 2)] + '…'
    return text


def units(text):
    """Length as the runner counts it (JavaScript UTF-16 code units)."""
    return len(text.encode('utf-16-le')) // 2


def quiet(now):
    start, end = QUIET
    return now.hour >= start or now.hour < end


def runner_fires(wd):
    try:
        return int(json.loads((wd / 'state.json').read_text()).get('fires', 0))
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def delivered(out, wd):
    """Whether the runner took the last event: it acked that run, or it delivered something since.

    The runner saves its pending event before writing .run-ok, so a crash between the two still
    delivers the event after restart and raises fires; only this check's output ever fires."""
    ack = (wd / '.run-ok').read_text().strip() if (wd / '.run-ok').exists() else ''
    if out.get('run') and out['run'] == ack:
        return True
    fires = runner_fires(wd)
    return fires is not None and isinstance(out.get('fires'), int) and fires > out['fires']


def live_keys(cases):
    """Keys that still stop a repeat: the one-shot pings of each open case's current deadline and reopen cycle.

    A tuple, so str.startswith matches the watcher-ending keys of the current cycle too."""
    keys = []
    for case in cases:
        if case.get('status') == 'open':
            cid, rev, cycle = case['id'], case.get('rev', 0), case.get('cycle', 0)
            keys += [f'{cid}|r{rev}|soon', f'{cid}|r{rev}|no-deadline', f'{cid}|c{cycle}|']
    return tuple(keys)


def merchant_key(merchant):
    return ' '.join(charges.words(merchant)) or ' '.join(merchant.lower().split())


def charge_of(q):
    # Questions opened before 'pending' was stored rebuild it from the merchant name.
    pending = q.get('pending', bool(re.search(r'\b(?:pending|auth)\b', q.get('merchant') or '', re.I)))
    return {k: q[k] for k in ('kind', 'currency', 'amount', 'card', 'merchant')} | {'pending': pending}


def channel(sender):
    """A bank's SMS and its email copy are two channels for one charge."""
    return 'email' if '@' in str(sender or '') else 'sms'


def alerts_of(q):
    return q.get('alerts') or [{'channel': 'sms', 'at': q.get('at'), 'item': q.get('item')}]


def same_charge(q, charge):
    return (q.get('kind'), q.get('card'), q.get('currency'), q.get('amount'), q.get('mkey')) == \
        (charge['kind'], charge['card'], charge['currency'], charge['amount'], merchant_key(charge['merchant']))


def seen_alert(q, chan, at, item=None):
    """Whether this alert is already on the question: the same triage item, or (for an alert quoted
    without an item, as `money-cases ask` gets it) the same channel within ALERT_SAME."""
    for a in alerts_of(q):
        if item and a.get('item'):
            if a['item'] == item:
                return True
            continue
        try:
            if a.get('channel') == chan and abs(parse_time(a['at']) - at) <= ALERT_SAME:
                return True
        except (KeyError, TypeError, ValueError):
            continue
    return False


def question_for(book, charge, at, chan='sms', item=None):
    """The question an alert belongs to: the one that already has this alert (the same triage item,
    or the same channel within ALERT_SAME), else one with no alert on this channel yet within
    SAME_CHARGE (the bank's copy on its other channel). A second alert on the same channel is a
    second charge, and a decline is never the same question as a charge."""
    copy = None
    for q in reversed(book['questions']):
        if not same_charge(q, charge):
            continue
        if seen_alert(q, chan, at, item):
            return q
        try:
            near = abs(parse_time(q['at']) - at) <= SAME_CHARGE
        except (KeyError, TypeError, ValueError):
            continue
        if copy is None and near and all(a.get('channel') != chan for a in alerts_of(q)):
            copy = q
    return copy


def attach(q, chan, at, item=None):
    if not seen_alert(q, chan, at, item):
        q['alerts'] = alerts_of(q) + [{'channel': chan, 'at': stamp(at), 'item': item}]


def find_question(book, qid):
    for q in book['questions']:
        if q.get('id') == qid:
            return q
    raise CaseError(f'no charge question {qid!r}')


def new_question(book, charge, text, at, now, chan='sms', item=None):
    key = merchant_key(charge['merchant'])
    base = '|'.join([charge['kind'], charge['card'], charge['currency'], charge['amount'], key, chan, stamp(at)])
    q = {'id': 'q-' + hashlib.sha256(base.encode()).hexdigest()[:8], 'kind': charge['kind'],
         'card': charge['card'], 'currency': charge['currency'], 'amount': charge['amount'],
         'merchant': clip(redact(charge['merchant']), 80), 'pending': bool(charge.get('pending')),
         'mkey': key, 'at': stamp(at),
         'alert': clip(redact(text or ''), 240), 'alerts': [{'channel': chan, 'at': stamp(at), 'item': item}],
         'status': 'open', 'wait_until': None, 'asks': [], 'passed': False, 'item': None, 'why': '',
         'case': None, 'by': None, 'outcome': None, 'checked': None,
         'opened': stamp(now), 'updated': stamp(now), 'closed': None}
    book['questions'].append(q)
    return q


def note_why(q, why, now):
    q.update({'why': clip(redact(why), 200), 'updated': stamp(now)})


def settle(q, outcome, by, now, status='closed'):
    q.update({'status': status, 'outcome': clip(redact(outcome), 200), 'by': by, 'closed': stamp(now),
              'updated': stamp(now)})


def prune_questions(book, now):
    cutoff = stamp(now - KEEP_SENT)
    book['questions'] = [q for q in book['questions'] if q.get('status') == 'open' or (q.get('closed') or '') >= cutoff]


def case_from(data, q, now, by, root=None):
    """Turn a charge question he never answered into a money case (never a third ask)."""
    cid = 'charge-' + q['id'][2:]
    n = len(q.get('asks', []))
    try:
        add(data, cid, q['merchant'] or 'unknown merchant', q['amount'], q['currency'],
            f'charge on card ending {q["card"]} on {when(parse_time(q["at"]))}: asked him {n} time(s), '
            'no answer and no receipt',
            'tell him once it is an open money case, with options (his charge, dispute it, block the card); '
            'never ask about the charge again',
            (now + dt.timedelta(days=2)).date().isoformat(), 'Abdullah',
            reference=f'card ending {q["card"]}', why=f'charge question {q["id"]}', at=now, root=root)
    except CaseError as e:
        if 'already exists' not in str(e):
            raise
    q['case'] = cid
    settle(q, f'now money case {cid}', by, now, 'case')
    return cid


def close_untouched(data, cid, outcome, now):
    """Close a money case a charge question opened, unless someone has worked on it since."""
    with Locked(data) as book:
        case = next((c for c in book['cases'] if c['id'] == cid), None)
        if not case or case['status'] != 'open' or len(case.get('history', [])) > 1:
            return False
        outcome = clip(redact(outcome), 200)
        case.update(status='closed', closed=stamp(now), outcome=outcome, updated=stamp(now))
        case['history'].append({'at': stamp(now), 'text': 'closed: ' + outcome})
        return True


def screen(text, sender='', at=None, now=None, deadline=None, data=None, find=None, said=None, record=True,
           item=None):
    """For inbox triage: None when the text isn't a card alert this reads, else {verdict, why, id,
    kind, errors} with verdict explained | case | asked | wait | ask. Only ask should reach him.
    item is triage's id for the message; triaged() records whether triage raised it."""
    charge = charges.parse(text, sender)
    if not charge:
        return None
    now = (now or now_dubai()).astimezone(TZ)
    at = (at or now).astimezone(TZ)
    chan = channel(sender)
    q = question_for(load_questions(data), charge, at, chan, item)
    base = {'kind': charge['kind'], 'errors': []}
    if record and q:
        # Record the alert before the early returns below, or the next copy of this charge (say the
        # email after an SMS that was already asked) looks like a new charge and goes to him again.
        with Locked(data or DATA, 'questions') as book:
            live = question_for(book, charge, at, chan, item)
            if live:
                attach(live, chan, at, item)
    if q and q['status'] == 'closed':
        return {**base, 'verdict': 'explained', 'why': q.get('outcome') or '', 'id': q['id']}
    if q and q['status'] == 'case':
        return {**base, 'verdict': 'case', 'why': f"money case {q['case']}", 'id': q['id']}
    if q and q.get('asks'):
        return {**base, 'verdict': 'asked', 'why': f"asked {len(q['asks'])} time(s); the check follows it",
                'id': q['id']}
    if q and q.get('passed') and item and q.get('item') and q['item'] != item:
        return {**base, 'verdict': 'asked', 'why': f"another alert for this charge ({q['item']}) went to him",
                'id': q['id']}
    r = charges.explain(charge, at, now, deadline, find, said)
    verdict = 'explained' if r['verdict'] in ('receipt', 'owner') else r['verdict']
    qid = q['id'] if q else None
    if record:
        with Locked(data or DATA, 'questions') as book:
            q = question_for(book, charge, at, chan, item) or new_question(book, charge, text, at, now, chan, item)
            attach(q, chan, at, item)
            qid = q['id']
            if q['status'] == 'open' and not q.get('asks') and not q.get('passed'):
                note_why(q, r['why'], now)
                if verdict == 'explained':
                    settle(q, r['why'], 'triage', now)
                elif verdict == 'wait':
                    q['wait_until'] = r['until']
            prune_questions(book, now)
    return {'verdict': verdict, 'why': r['why'], 'id': qid, 'kind': charge['kind'], 'errors': r['errors']}


def triaged(data, outcomes, now=None):
    """After inbox triage has saved its event: outcomes are (question id, item id, raised). A raised
    alert went to the woken agent (so a later receipt gets a closing line and the bank's copy isn't
    sent again). Triage raises every unexplained charge; one it dropped was already answered in a
    chat."""
    now = (now or now_dubai()).astimezone(TZ)
    with Locked(data or DATA, 'questions') as book:
        for qid, item, raised in outcomes:
            q = next((x for x in book['questions'] if x.get('id') == qid), None)
            if not q or q['status'] != 'open' or q.get('asks') or q.get('passed'):
                continue
            if raised:
                q.update({'passed': True, 'item': item, 'updated': stamp(now)})
            else:
                settle(q, 'already answered in a chat', 'triage', now)


def ask(data, question, text=None, sender='', at=None, qid=None, now=None, deadline=None, root=None,
        find=None, said=None):
    """The gate before anyone asks him about a charge: (0, message) means ask now and the ask is
    counted; (DONT_ASK, message) says why not. at is the alert's own time, so asking about the same
    alert again finds the same question."""
    data = data or DATA
    question = check_text('question', clip(question or '', 300))
    now = (now or now_dubai()).astimezone(TZ)
    chan = None
    if qid:
        q = find_question(load_questions(data), qid)
        charge, at = charge_of(q), parse_time(q['at'])
    else:
        charge = charges.parse(text or '', sender)
        if not charge:
            raise CaseError('not a card charge or decline alert this reads; check the receipt and his threads by hand')
        if at is None:
            raise CaseError("give --at, the alert's own time, so the same alert stays one question")
        at, chan = at.astimezone(TZ), channel(sender)
        q = question_for(load_questions(data), charge, at, chan)
    # Lookups run before taking the lock; a settled question needs none.
    r = None if q and q['status'] != 'open' else charges.explain(charge, at, now, deadline, find, said)
    with Locked(data, 'questions') as book:
        q = (find_question(book, q['id']) if q else None) or question_for(book, charge, at, chan) \
            or new_question(book, charge, text, at, now, chan)
        if chan:
            attach(q, chan, at)
        if q['status'] == 'closed':
            return DONT_ASK, f"{q['id']} is settled ({q['outcome']}). Don't ask."
        if q['status'] == 'case':
            return DONT_ASK, f"{q['id']} is money case {q['case']}; follow the case, don't ask about the charge."
        if r is None:
            r = charges.explain(charge, at, now, deadline, find, said)
        note_why(q, r['why'], now)
        if r['verdict'] in ('receipt', 'owner'):
            settle(q, r['why'], 'ask', now)
            return DONT_ASK, (f"{q['id']} is explained: {r['why']}. Don't ask; if he was asked about it before, "
                              'tell him in one line.')
        if r['verdict'] == 'wait':
            q['wait_until'] = r['until']
            return DONT_ASK, (f"{q['id']}: {r['why']} (until {when(parse_time(r['until']))}). Don't ask; the "
                              'money-cases check says when no receipt came.')
        asks = q['asks']
        if len(asks) >= MAX_ASKS:
            cid = case_from(data, q, now, 'ask', root)
            return DONT_ASK, (f"{q['id']} was asked {len(asks)} times, so it is now money case {cid}. Tell him once "
                              'with options; never a third ask.')
        if asks and now - parse_time(asks[-1]['at']) < REASK_GAP:
            again = parse_time(asks[-1]['at']) + REASK_GAP
            return DONT_ASK, f"{q['id']}: asked at {when(parse_time(asks[-1]['at']))}; the one re-ask waits until {when(again)}."
        asks.append({'at': stamp(now), 'question': question})
        note = f" (couldn't check everything: {'; '.join(r['errors'])})" if r['errors'] else ''
        return 0, (f"{q['id']}: ask him now ({len(asks)} of {MAX_ASKS}); {r['why']}{note}. When he answers: "
                   f"money-cases answered {q['id']} --note '<his answer>'.")


def answered(data, qid, note, now=None):
    """His answer settles the question. A money case it opened stays open with his answer noted: he may
    have said it isn't his."""
    data = data or DATA
    note = check_text('note', note)
    now = (now or now_dubai()).astimezone(TZ)
    with Locked(data, 'questions') as book:
        q = find_question(book, qid)
        if q['status'] == 'case':
            cid = q['case']
            settle(q, note, 'answered', now)
            q['was_case'] = cid
            try:
                update(data, cid, {}, note=f'he answered about charge question {qid}: {note}', at=now)
            except CaseError:
                pass
        elif q['status'] == 'open':
            settle(q, note, 'answered', now)
        return q


def follow(data, now, root=None, deadline=None, find=None, said=None):
    """Close questions a receipt or his words now explain, including ones already turned into money
    cases (FOLLOW_CASE); turn ones he didn't answer after the re-ask, or followed past FOLLOW_FOR,
    into money cases. Least recently checked first, at most FOLLOW_EACH seconds each, so one slow
    question doesn't starve the rest. Lookups run outside the lock; returns lookup errors."""
    errors, hits, looked = [], {}, set()
    todo = []
    for q in load_questions(data)['questions']:
        try:
            at = parse_time(q['at'])
        except (KeyError, TypeError, ValueError):
            continue
        if q.get('status') == 'open' or (q.get('status') == 'case' and now - at <= FOLLOW_CASE):
            todo.append((q.get('checked') or '', at, q))
    for _, at, q in sorted(todo, key=lambda x: x[0]):
        if deadline is not None and deadline - time.time() < 2:
            errors.append('out of time; the rest next check')
            break
        looked.add(q['id'])
        if q.get('kind') == 'charge':
            each = time.time() + FOLLOW_EACH
            hit = charges.found(charge_of(q), at, now, each if deadline is None else min(deadline, each),
                                find, said, errors)
            if hit:
                hits[q['id']] = hit
    if not looked:
        return errors
    with Locked(data, 'questions') as book:
        for q in book['questions']:
            if q['id'] not in looked:
                continue
            q['checked'] = stamp(now)
            if q.get('status') == 'case':
                if q['id'] in hits:
                    cid = q['case']
                    settle(q, hits[q['id']]['why'], 'check', now)
                    q['was_case'] = cid
                    try:
                        q['case_closed'] = close_untouched(data, cid, 'explained: ' + hits[q['id']]['why'], now)
                    except CaseError as e:
                        errors.append(f"{q['id']}: {e}")
                continue
            if q.get('status') != 'open':
                continue
            if q['id'] in hits:
                settle(q, hits[q['id']]['why'], 'check', now)
                continue
            asks, at = q.get('asks', []), parse_time(q['at'])
            try:
                if len(asks) >= MAX_ASKS and now - parse_time(asks[-1]['at']) >= CASE_AFTER:
                    case_from(data, q, now, 'check', root)
                elif now - at >= FOLLOW_FOR:
                    # Never closed unseen: a week without an explanation is a money case he hears about.
                    case_from(data, q, now, 'check', root)
            except CaseError as e:
                errors.append(f"{q['id']}: {e}")
        prune_questions(book, now)
    return errors


def question_entries(questions, now, sent):
    """attention()-style entries for what the check did to charge questions, once each."""
    entries = []
    for q in questions:
        try:
            at = parse_time(q['at'])
            done = parse_time(q['closed']) if q.get('closed') else None
        except (KeyError, TypeError, ValueError):
            continue
        head = f"- {q['id']}: {clip(redact(q.get('merchant', '')), 80)} {money(q)} on card ending {q.get('card')} ({when(at)})"
        recent = done is not None and now - done <= FOLLOW_FOR
        if q.get('status') == 'closed' and q.get('by') == 'check' and recent and q.get('was_case'):
            state = 'closed' if q.get('case_closed') else 'still open (someone worked on it): close it if this settles it'
            item = (f"q|{q['id']}|closed", f"explained now: {clip(redact(q.get('outcome') or ''), 160)}; money case "
                    f"{q['was_case']} {state}", 'Tell him in one line it is settled')
        elif q.get('status') == 'closed' and q.get('by') == 'check' and recent and (q.get('asks') or q.get('passed')):
            item = (f"q|{q['id']}|closed", f"explained now: {clip(redact(q.get('outcome') or ''), 160)}",
                    "He was told about it, so tell him in one line it's settled")
        elif q.get('status') == 'case' and q.get('by') == 'check' and recent:
            item = (f"q|{q['id']}|case", f"he didn't answer, so it is now money case {q.get('case')}",
                    "Tell him once with options; never ask about the charge again")
        elif q.get('status') == 'open' and not q.get('asks') and q.get('wait_until') \
                and now >= parse_time(q['wait_until']):
            item = (f"q|{q['id']}|ask", 'no receipt came while we waited',
                    f"Run money-cases ask --id {q['id']} --said '<question>' and ask him once if it says so")
        else:
            continue
        if item[0] not in sent:
            entries.append((head, [(item[0], item[1])], item[2]))
    return entries


def run_check(wd, run, data=None, root=None, now=None, find=None, said=None):
    now = (now or now_dubai()).astimezone(TZ)
    pings = wd / 'pings.json'
    state = read_json(pings, {'sent': {}})
    state.setdefault('sent', {})
    out = state.pop('outbox', None)
    if out and delivered(out, wd):
        for key in out['keys']:
            state['sent'][key] = out['at']
    errors = follow(data or DATA, now, root, time.time() + FOLLOW_BUDGET, find, said)
    if errors:
        state['question_errors'] = {'at': stamp(now), 'errors': errors[:10]}
    else:
        state.pop('question_errors', None)
    # An event the runner never took is rebuilt from the book, so it skips quiet hours and closed or moved cases.
    cases = load(data)['cases']
    cutoff = stamp(now - KEEP_SENT)
    live = live_keys(cases)
    state['sent'] = {k: v for k, v in state['sent'].items() if v >= cutoff or k in live or k.startswith(live)}
    event = ''
    if not quiet(now):
        entries = attention(cases, now, state['sent'], root) + \
            question_entries(load_questions(data)['questions'], now, state['sent'])
        if entries:
            header = f'Money cases: {len(entries)} need attention.'
            footer = 'Details: money-cases show ID.'
            more = f'{len(entries)} more need attention; they follow in the next check (money-cases list).'
            room = EVENT_LIMIT - units(header) - units(more) - units(footer) - 3
            shown, taken, full = [], [], 0
            # Only what fits is recorded as sent; a case with more pings than fit gets the rest next check.
            for head, items, tail in entries:
                texts = []
                for key, text in items:
                    if units(case_line(head, texts + [text], tail)) + 1 > room:
                        break
                    texts.append(text)
                    taken.append(key)
                if not texts and not shown:
                    # Lines are clipped field by field, so this only guards a hand-edited book.
                    texts.append(items[0][1])
                    taken.append(items[0][0])
                if texts:
                    line = fit(case_line(head, texts, tail), room - 1)
                    shown.append(line)
                    room -= units(line) + 1
                if len(texts) < len(items):
                    break
                full += 1
            tail = ['Details: money-cases show ID.']
            if full < len(entries):
                tail.insert(0, f'{len(entries) - full} more need attention; they follow in the next check '
                               f'(money-cases list).')
            event = '\n'.join([header, *shown, *tail])
            state['outbox'] = {'run': run, 'keys': taken, 'at': stamp(now), 'fires': runner_fires(wd)}
    write_json(pings, state)
    return event


def brief(cases, now=None):
    now = (now or now_dubai()).astimezone(TZ)
    open_cases = [c for c in cases if c.get('status') == 'open']
    if not open_cases:
        return ''
    due, changed = [], []
    far = dt.datetime.max.replace(tzinfo=TZ)
    for case in sorted(open_cases, key=lambda c: deadline_of(c) or far):
        deadline = deadline_of(case)
        if deadline is None:
            due.append(f"{case['merchant']} {money(case)} (no valid deadline)")
        elif deadline <= now + BRIEF_DUE:
            late = 'overdue since ' if deadline <= now else ''
            due.append(f"{case['merchant']} {money(case)} ({late}{when(deadline)})")
        elif parse_time(case['updated']) >= now - BRIEF_CHANGED:
            changed.append(f"{case['merchant']} {money(case)}")
    parts = [f'Money: {len(open_cases)} open']
    if due:
        parts.append('due: ' + '; '.join(due))
    if changed:
        parts.append('changed: ' + '; '.join(changed))
    if not due and not changed:
        parts.append('nothing due in 48h')
    return redact('. '.join(parts) + '.')


def table(cases):
    rows = []
    for c in sorted(cases, key=lambda c: (c['status'] != 'open', str(c.get('deadline')))):
        flag = '' if c['status'] == 'open' else ' [closed]'
        deadline = deadline_of(c)
        by = when(deadline) if deadline else f"{c.get('deadline')!r} (not a valid deadline)"
        # Redact each field before clipping it: a clipped card number would no longer match.
        rows.append(f"{c['id']}{flag}: {redact(c['merchant'])} {money(c)}, by {by} ({redact(c['who'])})\n"
                    f"  next: {clip(redact(c['next']), 200)}\n  state: {clip(redact(c['state']), 200)}")
    return redact('\n'.join(rows)) or 'No cases.'


def main(argv=None):
    os.umask(0o077)
    parser = argparse.ArgumentParser(prog='money-cases', description=__doc__.split('\n')[0])
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('list')
    p.add_argument('--all', action='store_true')
    p.add_argument('--json', action='store_true')
    sub.add_parser('show').add_argument('id')
    for name in ('add', 'update'):
        p = sub.add_parser(name)
        p.add_argument('id')
        for field in FIELDS:
            p.add_argument('--' + field, required=name == 'add' and field not in ('reference', 'why'))
        if name == 'add':
            p.add_argument('--watcher', action='append', default=[])
        else:
            p.add_argument('--add-watcher', action='append', default=[])
            p.add_argument('--drop-watcher', action='append', default=[])
            p.add_argument('--note', default='')
    p = sub.add_parser('close')
    p.add_argument('id')
    p.add_argument('--outcome', required=True)
    p = sub.add_parser('reopen')
    p.add_argument('id')
    p.add_argument('--deadline', required=True)
    p.add_argument('--note', required=True)
    sub.add_parser('brief')
    sub.add_parser('check')
    p = sub.add_parser('charge')
    p.add_argument('alert')
    p.add_argument('--sender', default='')
    p.add_argument('--at')
    p.add_argument('--now')
    p = sub.add_parser('ask')
    p.add_argument('alert', nargs='?')
    p.add_argument('--id')
    p.add_argument('--sender', default='')
    p.add_argument('--at')
    p.add_argument('--said', required=True)
    p = sub.add_parser('answered')
    p.add_argument('id')
    p.add_argument('--note', required=True)
    p = sub.add_parser('questions')
    p.add_argument('--all', action='store_true')
    p.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    try:
        if args.command == 'charge':
            charge = charges.parse(args.alert, args.sender)
            if not charge:
                raise CaseError('not a card charge or decline alert this reads')
            now = parse_time(args.now) if args.now else now_dubai()
            r = charges.explain(charge, parse_time(args.at) if args.at else now, now, time.time() + 30)
            print(json.dumps(redact_all({'charge': charge, **r}), ensure_ascii=False, indent=1))
        elif args.command == 'ask':
            if bool(args.alert) == bool(args.id):
                raise CaseError('give the alert text or --id QID')
            rc, message = ask(DATA, args.said, args.alert, args.sender, parse_time(args.at) if args.at else None,
                              args.id, deadline=time.time() + 30)
            print(redact(message))
            return rc
        elif args.command == 'answered':
            q = answered(DATA, args.id, args.note)
            print(f"{q['id']}: {q['status']} ({redact(q.get('outcome') or '')})")
            if q.get('was_case') and q.get('by') == 'answered':
                print(f"money case {q['was_case']} stays open with his answer noted; close it if that settles it.")
        elif args.command == 'questions':
            qs = [q for q in load_questions()['questions'] if args.all or q.get('status') == 'open']
            if args.json:
                print(json.dumps(redact_all(qs), ensure_ascii=False, indent=1))
            else:
                for q in qs:
                    print(redact(f"{q['id']} [{q['status']}] {q.get('merchant')} {money(q)} card {q.get('card')} "
                                 f"at {when(parse_time(q['at']))}, asked {len(q.get('asks', []))}x: "
                                 f"{q.get('outcome') or q.get('why') or ''}"))
                if not qs:
                    print('No charge questions.')
        elif args.command == 'check':
            wd = Path(os.environ.get('WATCH_DIR', LIVE))
            wd.mkdir(parents=True, exist_ok=True)
            data = DATA
            if wd.resolve() != LIVE.resolve():
                # robob-watch test runs a copy of the watcher folder; it gets a copy of the books too.
                data = wd / 'scratch-books'
                if not data.exists():
                    data.mkdir(mode=0o700)
                    for name in ('cases.json', 'questions.json'):
                        if (DATA / name).exists():
                            shutil.copy2(DATA / name, data / name)
            with (wd / 'check.lock').open('a') as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    # Nonzero so the runner keeps its last .run-ok acknowledgement.
                    print('money-cases check already running', file=sys.stderr)
                    return 75
                event = run_check(wd, os.environ.get('WATCH_RUN', ''), data)
            if event:
                print(event)
        elif args.command == 'brief':
            line = brief(load()['cases'])
            if line:
                print(line)
        elif args.command == 'list':
            cases = [c for c in load()['cases'] if args.all or c['status'] == 'open']
            print(json.dumps(redact_all(cases), ensure_ascii=False, indent=1) if args.json else table(cases))
        elif args.command == 'show':
            print(json.dumps(redact_all(find(load(), args.id)), ensure_ascii=False, indent=1))
        elif args.command == 'add':
            add(DATA, args.id, args.merchant, args.amount, args.currency, args.state, args.next,
                args.deadline, args.who, args.reference, args.why, args.watcher)
            print(table([find(load(), args.id)]))
        elif args.command == 'update':
            changes = {f: getattr(args, f) for f in FIELDS}
            update(DATA, args.id, changes, args.add_watcher, args.drop_watcher, args.note)
            print(table([find(load(), args.id)]))
        elif args.command == 'close':
            close(DATA, args.id, args.outcome)
            print(f'closed {args.id}')
        elif args.command == 'reopen':
            reopen(DATA, args.id, args.deadline, args.note)
            print(table([find(load(), args.id)]))
    except CaseError as e:
        print(f'money-cases: {e}', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
