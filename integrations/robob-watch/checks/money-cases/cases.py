#!/usr/bin/python3
"""Open money cases: one row per case, deadline pings and ended reply watchers.

  money-cases list [--all] [--json]
  money-cases show ID
  money-cases add ID --merchant M --amount 12.34 --currency AED --state S --next N
                  --deadline D --who W [--reference R] [--why TEXT] [--watcher ID]...
  money-cases update ID [--merchant M] [--amount A] [--currency C] [--reference R]
                  [--state S] [--next N] [--deadline D] [--why TEXT] [--who W]
                  [--add-watcher ID] [--drop-watcher ID] [--note TEXT]
                  [--because TEXT | --reply ID]   required with --deadline
  money-cases add ... --unmatched     no merchant match: recorded as "unmatched", never guessed
                  [--charged YYYY-MM-DD] [--kind charge|hold]   hold = pre-auth, dropped off = released
  money-cases card-swap --old OLD --new NEW [--also STALE ...] [--dry-run]
                  point open cases' next line at a replacement card (last 4 only); never closes a case
  money-cases close ID --outcome TEXT
  money-cases reopen ID --deadline D --note TEXT
  money-cases brief    one line for the morning brief, nothing when no case is open
  money-cases check    the robob-watch check for the money-cases watcher

A deadline is a date (09:00 Dubai that day) or an ISO time. Every open case has one.
"""
import argparse
import datetime as dt
from decimal import Decimal, InvalidOperation
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import sys
import tempfile
from zoneinfo import ZoneInfo

TZ = ZoneInfo('Asia/Dubai')
DATA = Path(os.environ.get('MONEY_CASES_DIR', '~/Documents/assistant/money-cases')).expanduser()
WATCH_ROOT = Path(os.environ.get('ROBOB_WATCH_ROOT', '~/.local/share/robob-watch')).expanduser()
LIVE = WATCH_ROOT / 'watchers' / 'money-cases'
SOON = dt.timedelta(hours=24)
ASK_AFTER = dt.timedelta(days=2)
BRIEF_DUE = dt.timedelta(hours=48)
BRIEF_CHANGED = dt.timedelta(hours=24)
QUIET = (23, 8)  # Dubai hours: no pings from 23:00 until 08:00
KEEP_SENT = dt.timedelta(days=60)
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


UNMATCHED = 'unmatched'
KINDS = ('charge', 'hold')
# Sent once after 2 days of reminders with no answer. The case then stays quiet until he answers.
ASK = ('no reply from you for 2 days. Yes or no: keep chasing this case, or close it? '
       'I stay quiet on it until you answer')


def check_charged(text):
    try:
        dt.date.fromisoformat(text)
    except ValueError:
        raise CaseError(f'charged {text!r} is not a date (YYYY-MM-DD)')
    return text


def charge_key(case):
    """Merchant, amount, currency and day, normalised the way the CLI stores them (trim, case, 2 places)."""
    amount = format(Decimal(str(case['amount'])).normalize(), 'f')
    return (' '.join(str(case['merchant']).split()).lower(), amount, str(case['currency']).upper(),
            case.get('charged') or case['opened'][:10])


def norm_ref(text):
    return ' '.join(str(text or '').split()).lower()


def same_charge(cases, new):
    """Recorded charges that the new one may be a repeat of: the same merchant, amount, currency, day and kind.

    Free-form references ("email 09:13", "sms 10:45") describe where a charge was seen, not which transaction
    it is, so they never separate two charges. The check only lists the candidates; it never decides. The
    caller must say `--repeat ID` (same charge) or `--distinct` (a new transaction). An unmatched charge is
    never a candidate."""
    if new['merchant'] == UNMATCHED:
        return []
    key, kind = charge_key(new), new.get('kind', 'charge')
    return [c['id'] for c in cases
            if c.get('merchant') != UNMATCHED and c.get('kind', 'charge') == kind and charge_key(c) == key]


def corroborate_in(book, case_id, text, at=None):
    """Note that another channel saw an already-recorded charge. Caller holds the lock."""
    case = find(book, case_id)
    if case.get('status') != 'open':
        raise CaseError(f'case {case_id!r} is closed; reopen it first')
    case['updated'] = stamp(at)
    case['history'].append({'at': stamp(at), 'text': text})
    return case


def corroborate(data, case_id, merchant, amount, currency, charged, kind, observation, at=None):
    """Record that another channel (say SMS after mail) saw the same charge. Counts it once.

    Refuses unless the charge matches the case exactly, so a corroboration can never merge two charges."""
    candidate = {'merchant': check_text('merchant', merchant), 'amount': check_amount(amount),
                 'currency': check_currency(currency), 'charged': check_charged(charged), 'kind': kind}
    with Locked(data) as book:
        case = find(book, case_id)
        if case.get('merchant') == UNMATCHED or charge_key(case) != charge_key(candidate) \
                or case.get('kind', 'charge') != kind:
            raise CaseError(f'{case_id!r} is not this charge (merchant, amount, currency, day or kind differ)')
        corroborate_in(book, case_id, 'seen again: ' + check_text('observation', observation), at)
    return case


def moment(text):
    try:
        t = dt.datetime.fromisoformat(text)
    except (TypeError, ValueError):
        return None
    return (t if t.tzinfo else t.replace(tzinfo=TZ)).astimezone(TZ)


def answered_at(case):
    """When he last answered: a close, a reopen, or an update with --reply (his reply id). Else when it opened.

    A --because reason is recorded but is not an answer: it can come from a process, not from him."""
    owned = [m for m in (moment(h.get('at')) for h in case.get('history', []) if h.get('owner')) if m]
    return max(owned) if owned else moment(case['opened'])


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


class Locked:
    """Serialise read-modify-write of cases.json between CLI calls."""

    def __init__(self, data):
        self.data = data

    def __enter__(self):
        self.data.mkdir(parents=True, exist_ok=True)
        self.lock = (self.data / 'cases.lock').open('a')

        def timed_out(*_):
            raise CaseError('cases.lock still held after 10s')
        previous = signal.signal(signal.SIGALRM, timed_out)
        signal.alarm(10)
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX)
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, previous)
        self.book = load(self.data)
        return self.book

    def __exit__(self, kind, *_):
        try:
            if kind is None:
                write_json(self.data / 'cases.json', self.book)
        finally:
            self.lock.close()


def find(book, case_id):
    for case in book['cases']:
        if case['id'] == case_id:
            return case
    raise CaseError(f'no case {case_id!r}')


def add(data, case_id, merchant, amount, currency, state, next_action, deadline, who,
        reference='', why='', watchers=(), at=None, root=None, charged='', kind='charge', unmatched=False,
        repeat=None, distinct=False):
    if not ID.fullmatch(case_id):
        raise CaseError(f'id {case_id!r} must be lowercase letters, digits and dashes')
    if kind not in KINDS:
        raise CaseError(f'kind {kind!r} must be one of: {", ".join(KINDS)}')
    if unmatched:
        if (merchant or '').strip():
            raise CaseError('give --unmatched or --merchant, not both: an unmatched charge has no merchant name')
        merchant = UNMATCHED
    else:
        merchant = check_text('merchant', merchant)
    case = {
        'id': case_id, 'merchant': merchant, 'amount': check_amount(amount), 'kind': kind,
        'charged': check_charged(charged) if charged else stamp(at)[:10],
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
        candidates = same_charge(book['cases'], case)
        if candidates and not (repeat or distinct):
            raise CaseError(f'a charge with this merchant, amount, currency and day is already recorded as '
                            f'{", ".join(map(repr, candidates))}. Say --repeat ID if it is the same charge, or '
                            f'--distinct if it is a second transaction; nothing was added.')
        if repeat:
            if repeat not in candidates:
                raise CaseError(f'--repeat {repeat!r} is not a charge matching this one')
            if distinct:
                raise CaseError('give --repeat or --distinct, not both')
            corroborate_in(book, repeat, f"seen again: {check_text('reference', reference, False) or 'repeat'}", at)
            return find(book, repeat)
        book['cases'].append(case)
    return case


def update(data, case_id, changes, add_watchers=(), drop_watchers=(), note='', at=None, root=None,
           because='', reply=''):
    checks = {'amount': check_amount, 'currency': check_currency, 'deadline': check_deadline}
    with Locked(data) as book:
        case = find(book, case_id)
        said = []
        moved = False
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
                    moved = True
        because = check_text('because', because, False)
        reply = check_text('reply', reply, False)
        if moved and not (because or reply):
            raise CaseError('a deadline change needs --because (the reason) or --reply (his reply id); nothing was changed')
        if because:
            said.append(f'because: {because}')
        if reply:
            said.append(f'owner reply {reply}')
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
        entry = {'at': stamp(at), 'text': '; '.join(said)}
        if reply:
            # Only his reply id is an owner answer; a --because reason alone is recorded, not answered.
            entry['owner'] = True
        case['history'].append(entry)
    return case


def last4_arg(name, value):
    if type(value) is not str or not re.fullmatch(r'[0-9]{4}', value):
        # Never echo the value: a full card number passed by mistake must not reach stderr or logs.
        raise CaseError(f'{name} must be exactly the last 4 digits of the card (value not shown)')
    return value


class _DryRun(Exception):
    """Raised inside Locked so nothing is written."""


def card_swap(data, old, new, also=(), dry_run=False, at=None):
    """Point open cases at a replacement card: rewrite the old (and stale planned) last-4 in `next` only.

    Closed cases are never touched and nothing is closed here: a human confirms each move. A case that
    names a card elsewhere (state, why, reference) comes back with after=None so someone checks it by hand."""
    old, new = last4_arg('old', old), last4_arg('new', new)
    if old == new:
        raise CaseError('old and new card are the same last 4')
    stale = sorted({old, *(last4_arg('also', a) for a in also)})
    token = re.compile(r'(?<!\d)(?:' + '|'.join(stale) + r')(?!\d)')
    changes = []
    try:
        with Locked(data) as book:
            for case in book['cases']:
                if case.get('status') != 'open':
                    continue
                if not any(token.search(str(case.get(f) or '')) for f in ('id', 'reference', 'state', 'next', 'why')):
                    continue
                before = case.get('next') or ''
                after, count = token.subn(new, before)
                if not count:
                    changes.append({'id': case['id'], 'before': before, 'after': None})
                    continue
                changes.append({'id': case['id'], 'before': before, 'after': after})
                case['next'] = after
                case['updated'] = stamp(at)
                case['history'].append({'at': stamp(at), 'text': f'card swap {old}->{new}: next updated'})
            if dry_run:
                raise _DryRun
    except _DryRun:
        pass
    return changes


def close(data, case_id, outcome, at=None):
    with Locked(data) as book:
        case = find(book, case_id)
        if case['status'] == 'closed':
            raise CaseError(f'case {case_id!r} is already closed')
        outcome = check_text('outcome', outcome)
        case.update(status='closed', closed=stamp(at), outcome=outcome, updated=stamp(at))
        # A pre-auth hold that drops off was released, not refunded.
        word = 'released' if case.get('kind') == 'hold' else 'closed'
        case['history'].append({'at': stamp(at), 'text': f'{word}: {outcome}', 'owner': True})
    return case


def reopen(data, case_id, deadline, note, at=None):
    with Locked(data) as book:
        case = find(book, case_id)
        if case['status'] == 'open':
            raise CaseError(f'case {case_id!r} is open')
        note = check_text('note', note)
        case.update(status='open', closed=None, outcome=None, deadline=check_deadline(deadline), updated=stamp(at),
                    rev=case.get('rev', 0) + 1, cycle=case.get('cycle', 0) + 1)
        case['history'].append({'at': stamp(at), 'text': 'reopened: ' + note, 'owner': True})
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


def attention(cases, now, sent, root=None, since=None):
    """(head, items, tail, day) for each open case with pings it hasn't had; items are (key, text) pairs.

    `since` maps a case id to {'answer': <answer time>, 'at': <when its first reminder was delivered>}. The
    two-day clock for the yes/no starts there, so a case with no reminder yet is never asked about."""
    since = since or {}
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
        answer = answered_at(case)
        ask_key = f'{cid}|ask|{answer.isoformat()}'
        if ask_key in sent:
            # The yes/no is out; the case stays quiet until he answers (a new answer time changes the key).
            continue
        found = [(k, t) for k, t in found if k not in sent]
        # The yes/no goes last, so every reminder still pending is sent before the case goes quiet.
        # Its clock starts at the first reminder delivered since his last answer, not at case creation.
        clock = since.get(cid)
        started = moment(clock.get('at')) if clock and clock.get('answer') == answer.isoformat() else None
        # A start only counts when its reminder went out after his answer, not before it.
        if started and started >= answer and now - started >= ASK_AFTER:
            found.append((ask_key, ASK))
        if not found:
            continue
        day_key = f'{cid}|day|{now.date()}'
        if day_key in sent:
            # At most one reminder per case per day.
            continue
        tail = (f"Next: {clip(redact(case['next']))}. Who: {clip(redact(case['who']), 60)}. "
                f"State: {clip(redact(case['state']))}")
        entries.append((head, found, tail, cid))
    return entries


def case_line(head, texts, tail):
    return redact(f"{head}: {'; '.join(texts)}." + (f" {tail}" if tail else ''))


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
    """The runner's fire count. A watcher with no state.json yet has fired 0 times, not an unknown count."""
    try:
        return int(json.loads((wd / 'state.json').read_text()).get('fires', 0))
    except FileNotFoundError:
        return 0
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def runner_owns(wd, out):
    """Whether the runner has accepted this check's output: it is saved as the runner's pending event.

    The runner saves `pending` (with the event text) before it acks the run, so a match means it will retry
    the event itself. No match and no delivery means the output was lost before acknowledgement."""
    try:
        pending = json.loads((wd / 'state.json').read_text()).get('pending') or {}
    except (OSError, ValueError, AttributeError):
        return False
    # An outbox from before this field (or an empty one) has no event to match, so it is never owned.
    event = (out.get('event') or '').strip()
    return bool(event) and (pending.get('event') or '').strip() == event


def delivery_time(out, wd):
    """When the runner actually delivered this event, or None while it is still pending.

    `.run-ok` only says the check's output was recorded; the runner delivers it later and may retry it
    overnight. The confirmed delivery is the runner's own record: `fires` rose past the count when this
    event was built, and `last_fire_at` is the moment that delivery succeeded."""
    fires = runner_fires(wd)
    if fires is None or not isinstance(out.get('fires'), int) or fires <= out['fires']:
        return None
    try:
        state = json.loads((wd / 'state.json').read_text())
    except (OSError, ValueError):
        return None
    return moment(state.get('last_fire_at'))


def live_keys(cases):
    """Keys that still stop a repeat: the one-shot pings of each open case's current deadline and reopen cycle,
    and its yes/no ask until he answers.

    A tuple, so str.startswith matches the watcher-ending keys of the current cycle too."""
    keys = []
    for case in cases:
        if case.get('status') == 'open':
            cid, rev, cycle = case['id'], case.get('rev', 0), case.get('cycle', 0)
            keys += [f'{cid}|r{rev}|soon', f'{cid}|r{rev}|no-deadline', f'{cid}|c{cycle}|', f'{cid}|ask|']
    return tuple(keys)


def run_check(wd, run, data=None, root=None, now=None):
    now = (now or now_dubai()).astimezone(TZ)
    pings = wd / 'pings.json'
    state = read_json(pings, {'sent': {}})
    state.setdefault('sent', {})
    out = state.pop('outbox', None)
    clock = state.setdefault('clock', {})
    delivered_at = delivery_time(out, wd) if out else None
    if out and delivered_at:
        # Record what was actually delivered, at the real delivery time: a retry overnight or later must not
        # count as the day the check built it.
        for key in out['keys']:
            # Each case's one-a-day cap is the day its reminder was delivered, not the day it was built.
            state['sent'][key] = delivered_at.isoformat(timespec='seconds')
        for cid in out.get('days', []):
            state['sent'][f"{cid}|day|{delivered_at.astimezone(TZ).date()}"] = delivered_at.isoformat(timespec='seconds')
        # Start the two-day yes/no clock at the first reminder actually delivered since the last answer.
        for cid, answer in out.get('clock', {}).items():
            if clock.get(cid, {}).get('answer') != answer['answer']:
                clock[cid] = {'answer': answer['answer'], 'at': delivered_at.isoformat(timespec='seconds')}
    elif out:
        # Not delivered yet. Two cases: the runner took the event (it is in state.json `pending`, and it will
        # retry it), or the runner never took it (the check died before the runner saved it). Only the first
        # is kept; the second is dropped and rebuilt below, or it would block every alert for good.
        if runner_owns(wd, out):
            state['outbox'] = out
    # An event the runner never took is rebuilt from the book, so it skips quiet hours and closed or moved cases.
    cases = load(data)['cases']
    cutoff = stamp(now - KEEP_SENT)
    live = live_keys(cases)
    state['sent'] = {k: v for k, v in state['sent'].items() if v >= cutoff or k in live or k.startswith(live)}
    event = ''
    # An undelivered event is still out: the runner retries it. Never build a second one over it, so no
    # case key is recorded for an event that was never shown.
    if not quiet(now) and 'outbox' not in state:
        entries = attention(cases, now, state['sent'], root, clock)
        if entries:
            header = f'Money cases: {len(entries)} need attention.'
            footer = 'Details: money-cases show ID.'
            # Reserve for the longest overflow line that can be printed (its count is at most len(entries)).
            more = (f'{len(entries)} more need attention; they follow in a later check '
                    f'(one reminder per case a day; money-cases list).')
            room = EVENT_LIMIT - units(header) - units(more) - units(footer) - 3
            shown, taken, full, days = [], [], 0, []
            # Only what fits is recorded as sent; a case with more pings than fit gets the rest next check.
            for head, items, tail, day in entries:
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
                    days.append(day)
                if len(texts) < len(items):
                    break
                full += 1
            tail = ['Details: money-cases show ID.']
            if full < len(entries):
                tail.insert(0, f'{len(entries) - full} more need attention; they follow in a later check '
                               f'(one reminder per case a day; money-cases list).')
            event = '\n'.join([header, *shown, *tail])
            # The clock start for any case whose first reminder is in this event (only when it is delivered).
            by_id = {c['id']: c for c in cases}
            starts = {}
            for key in taken:
                cid = key.split('|', 1)[0]
                if cid in by_id and cid not in starts:
                    starts[cid] = {'answer': answered_at(by_id[cid]).isoformat()}
            state['outbox'] = {'run': run, 'keys': taken, 'at': stamp(now), 'fires': runner_fires(wd),
                               'clock': starts, 'days': list(dict.fromkeys(days)), 'event': event}
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
            # merchant is optional on add: --unmatched stands in for it.
            required = name == 'add' and field not in ('reference', 'why', 'merchant')
            p.add_argument('--' + field, required=required)
        if name == 'add':
            p.add_argument('--repeat', default=None, metavar='ID',
                           help='this is the same charge as ID (seen again): add a note there, no new case')
            p.add_argument('--distinct', action='store_true',
                           help='a second transaction, not a repeat (needed when a matching charge exists)')
            p.add_argument('--unmatched', action='store_true',
                           help='the merchant/order was not matched; say so rather than guess one')
            p.add_argument('--charged', default='', help='charge date YYYY-MM-DD (default: today)')
            p.add_argument('--kind', default='charge', choices=KINDS)
            p.add_argument('--watcher', action='append', default=[])
        else:
            p.add_argument('--add-watcher', action='append', default=[])
            p.add_argument('--drop-watcher', action='append', default=[])
            p.add_argument('--note', default='')
            p.add_argument('--because', default='', help='reason for a deadline change (required with --deadline)')
            p.add_argument('--reply', default='', help="his reply id for a deadline change (or use --because)")
    p = sub.add_parser('close')
    p.add_argument('id')
    p.add_argument('--outcome', required=True)
    p = sub.add_parser('reopen')
    p.add_argument('id')
    p.add_argument('--deadline', required=True)
    p.add_argument('--note', required=True)
    p = sub.add_parser('corroborate', help='another channel saw this same charge: counted once, not added again')
    p.add_argument('id')
    p.add_argument('--merchant', required=True)
    p.add_argument('--amount', required=True)
    p.add_argument('--currency', required=True)
    p.add_argument('--charged', required=True, help='charge date YYYY-MM-DD')
    p.add_argument('--kind', default='charge', choices=KINDS)
    p.add_argument('--observation', required=True, help='where it was seen, e.g. "SMS 10:45"')
    p = sub.add_parser('card-swap', help='a card was replaced: move open cases to the new last 4')
    p.add_argument('--old', required=True)
    p.add_argument('--new', required=True)
    p.add_argument('--also', action='append', default=[], metavar='LAST4', help='another stale planned card')
    p.add_argument('--dry-run', action='store_true')
    sub.add_parser('brief')
    sub.add_parser('check')
    args = parser.parse_args(argv)
    try:
        if args.command == 'check':
            wd = Path(os.environ.get('WATCH_DIR', LIVE))
            wd.mkdir(parents=True, exist_ok=True)
            with (wd / 'check.lock').open('a') as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    # Nonzero so the runner keeps its last .run-ok acknowledgement.
                    print('money-cases check already running', file=sys.stderr)
                    return 75
                event = run_check(wd, os.environ.get('WATCH_RUN', ''))
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
            case = add(DATA, args.id, args.merchant, args.amount, args.currency, args.state, args.next,
                       args.deadline, args.who, args.reference, args.why, args.watcher, charged=args.charged,
                       kind=args.kind, unmatched=args.unmatched, repeat=args.repeat, distinct=args.distinct)
            # With --repeat, add returns the existing case and creates nothing: show that one.
            print(table([case]))
        elif args.command == 'update':
            changes = {f: getattr(args, f) for f in FIELDS}
            update(DATA, args.id, changes, args.add_watcher, args.drop_watcher, args.note,
                   because=args.because, reply=args.reply)
            print(table([find(load(), args.id)]))
        elif args.command == 'corroborate':
            corroborate(DATA, args.id, args.merchant, args.amount, args.currency, args.charged, args.kind,
                        args.observation)
            print(table([find(load(), args.id)]))
        elif args.command == 'card-swap':
            changes = card_swap(DATA, args.old, args.new, args.also, dry_run=args.dry_run)
            for c in changes:
                # Same redaction as show/list: a hand-edited case may hold a card number or code in next.
                cid = redact(c['id'])
                if c['after'] is None:
                    print(f"{cid}: names {args.old}, check by hand")
                else:
                    print(f"{cid}: next {redact(c['before'])!r} -> {redact(c['after'])!r}")
            updated = sum(1 for c in changes if c['after'] is not None)
            verb = 'would update' if args.dry_run else 'updated'
            print(f'{updated} case(s) {verb}')
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
