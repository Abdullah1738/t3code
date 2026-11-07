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
  money-cases card-swap --old OLD --new NEW [--also STALE ...] [--case ID ...] [--dry-run]
                  lists open cases naming the old card; writes only the cases picked with --case; never closes a case
                  and leaves a next line that holds a card number or code as is
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
from contextlib import contextmanager
import datetime as dt
from decimal import Decimal, InvalidOperation
import fcntl
import faulthandler
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
ASK_AFTER = dt.timedelta(days=2)
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
CHECK_BUDGET = 40
FOLLOW_BUDGET = 20  # seconds of archive lookups per check
FOLLOW_EACH = 6  # at most this many of them per question, least recently checked first
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


class CheckTimeout(CaseError):
    pass


class LookupTimeout(Exception):
    pass


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


def lock_wait(deadline):
    if deadline is None:
        return 10
    if time.time() >= deadline:
        raise CheckTimeout('out of time; the rest next check')
    return max(1, min(10, int(deadline - time.time())))


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
        if isinstance(text, str) and text.endswith(('Z', 'z')):
            text = text[:-1] + '+00:00'
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


def write_json(path, obj, timing=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)

    def put(text):
        pending = memoryview(text.encode('utf-8'))
        while pending:
            written = os.write(fd, pending)
            if not written:
                raise OSError('could not write temporary JSON file')
            pending = pending[written:]

    try:
        # No buffered stream: closing after an interrupted flush must not retry the write.
        put(json.dumps(obj, ensure_ascii=False, indent=1) + '\n')
        os.fsync(fd)
        if timing is not None:
            # Sample after the data fsync; the timing footer and its fsync are also bounded.
            os.lseek(fd, -2, os.SEEK_END)
            put(',\n "timing": ' + json.dumps(timing(), ensure_ascii=False) + '\n}\n')
            os.fsync(fd)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        os.close(fd)
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

    def __init__(self, data, name='cases', wait=10):
        self.data, self.name, self.wait = data, name, wait

    def __enter__(self):
        self.data.mkdir(parents=True, exist_ok=True)
        self.lock = (self.data / f'{self.name}.lock').open('a')

        try:
            with within(time.time() + self.wait, CheckTimeout(f'{self.name}.lock still held after {self.wait}s')):
                fcntl.flock(self.lock, fcntl.LOCK_EX)
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
        reference='', why='', watchers=(), at=None, root=None, charged='', kind='charge', unmatched=False,
        repeat=None, distinct=False, end=None):
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
    with Locked(data, wait=lock_wait(end)) as book:
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


def card_swap(data, old, new, also=(), dry_run=False, at=None, cases=()):
    """Point open cases at a replacement card: rewrite the old (and stale planned) last-4 in `next` only.

    A human picks each case with --case: only the ids in `cases` are written, and a pick with nothing to swap
    refuses the whole call before any write. Closed cases are never touched and nothing is closed here. A case
    that names a card elsewhere (state, why, reference) comes back with after=None so someone checks it by hand."""
    old, new = last4_arg('old', old), last4_arg('new', new)
    if old == new:
        raise CaseError('old and new card are the same last 4')
    stale = sorted({old, *(last4_arg('also', a) for a in also)})
    token = re.compile(r'(?<!\d)(?:' + '|'.join(stale) + r')(?!\d)')
    picks = set(cases)
    changes = []
    rewrites = []
    try:
        with Locked(data) as book:
            for case in book['cases']:
                if case.get('status') != 'open':
                    continue
                if not any(token.search(str(case.get(f) or '')) for f in ('id', 'reference', 'state', 'next', 'why')):
                    continue
                before = case.get('next') or ''
                after, count = token.subn(new, before)
                # The returned text is for display: redact first, so a grouped full number that contains the old
                # last-4 is masked before the swap can make it fail the Luhn check and slip through.
                shown_before = redact(before)
                shown_after = token.subn(new, shown_before)[0]
                if count and (card_numbers(before) or LABELLED.search(before)):
                    # Rewriting a group of a stored full number breaks its Luhn check, so show, list --json and the
                    # watcher would stop masking it. Leave the row exactly as stored for a human to clean.
                    changes.append({'id': case['id'], 'before': shown_before, 'after': None, 'held': True})
                    continue
                if not count:
                    changes.append({'id': case['id'], 'before': shown_before, 'after': None})
                    continue
                changes.append({'id': case['id'], 'before': shown_before, 'after': shown_after})
                rewrites.append((case, after, changes[-1]))
            rewritable = {case['id'] for case, _, _ in rewrites}
            nothing = [cid for cid in dict.fromkeys(cases) if cid not in rewritable]
            if nothing:
                raise CaseError(f'case {redact(nothing[0])!r} has nothing to swap; pick from the list')
            for _, _, change in rewrites:
                change['picked'] = change['id'] in picks
            for case, after, change in rewrites:
                if dry_run or not change['picked']:
                    continue
                case['next'] = after
                case['updated'] = stamp(at)
                case['history'].append({'at': stamp(at), 'text': f'card swap {old}->{new}: next updated'})
            if dry_run or not picks:
                # Raising here keeps Locked from writing: a no-pick call must not replace cases.json at all.
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


def question_matches(q, charge):
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
        if not question_matches(q, charge):
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


def recover_case(data, q, cases=None):
    if not q or q.get('status') != 'open':
        return
    cid = 'charge-' + q['id'][2:]
    cases = load(data)['cases'] if cases is None else cases
    previous = next((c for c in cases if c['id'] == cid and c.get('why') == f'charge question {q["id"]}'), None)
    # A case can commit just before an alarm prevents its question link from being saved.
    if previous:
        q['case'] = cid
        settle(q, f'now money case {cid}', 'check', parse_time(previous['opened']), 'case')


def case_from(data, q, now, by, root=None, end=None):
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
            reference=f'card ending {q["card"]}', why=f'charge question {q["id"]}', at=now, root=root, end=end)
    except CheckTimeout:
        raise
    except CaseError as e:
        if 'already exists' not in str(e):
            raise
    q['case'] = cid
    settle(q, f'now money case {cid}', by, now, 'case')
    return cid


def close_untouched(data, cid, outcome, now, end=None):
    """Close a money case a charge question opened, unless someone has worked on it since."""
    with Locked(data, wait=lock_wait(end)) as book:
        case = next((c for c in book['cases'] if c['id'] == cid), None)
        if case and case['status'] == 'closed':
            # A previous check may have saved the case just before its question write timed out.
            return True
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
    recover_case(data, q)
    base = {'kind': charge['kind'], 'errors': []}
    if record and q:
        # Record the alert before the early returns below, or the next copy of this charge (say the
        # email after an SMS that was already asked) looks like a new charge and goes to him again.
        with Locked(data or DATA, 'questions') as book:
            live = question_for(book, charge, at, chan, item)
            if live:
                recover_case(data, live)
                attach(live, chan, at, item)
                q = live
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
            recover_case(data, q)
            attach(q, chan, at, item)
            qid = q['id']
            if q['status'] == 'case':
                return {**base, 'verdict': 'case', 'why': f"money case {q['case']}", 'id': qid}
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
            recover_case(data, q)
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
        recover_case(data, q)
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
        recover_case(data, q)
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


def follow(data, now, root=None, deadline=None, find=None, said=None, end=None, stats=None):
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
    stats = stats if stats is not None else {'lookups': 0, 'owner_queries': 0, 'msgs_calls': 0}
    memo = {}
    source = said or (lambda *a, **kw: charges.owner_texts(*a, **kw, stats=stats))
    charge_times = [at for _, at, q in todo if q.get('kind') == 'charge']
    owner_rows = None
    if charge_times and now - (min(charge_times) - charges.OWNER_AROUND) <= dt.timedelta(days=2):
        try:
            with within(deadline, LookupTimeout('out of time')):
                owner_rows = source(min(charge_times) - charges.OWNER_AROUND, now, deadline=deadline)
        except (charges.Lookup, LookupTimeout) as e:
            errors.append(f'his threads: {e}')
            owner_rows = []

    def owner(since, until, deadline=None):
        if owner_rows is None:
            return source(since, until, deadline=deadline)
        return [row for row in owner_rows if since <= parse_time(row[0]) <= until]

    for _, at, q in sorted(todo, key=lambda x: x[0]):
        if deadline is not None and deadline - time.time() < 2:
            errors.append('out of time; the rest next check')
            break
        looked.add(q['id'])
        if q.get('kind') == 'charge':
            each = time.time() + FOLLOW_EACH
            each = each if deadline is None else min(deadline, each)
            stats['lookups'] += 1
            try:
                with within(each, LookupTimeout('out of time')):
                    hit = charges.found(charge_of(q), at, now, each, find, owner, errors, memo, stats)
            except (charges.Lookup, LookupTimeout) as e:
                errors.append(str(e))
                # A slow receipt cannot hide owner evidence already loaded in this run.
                hit = charges.owner_found(charge_of(q), at, now, said=owner, errors=errors) \
                    if owner_rows is not None else None
            if hit:
                hits[q['id']] = hit
    if not looked:
        return errors
    with Locked(data, 'questions', wait=lock_wait(end)) as book:
        cases = load(data)['cases']
        for q in book['questions']:
            if q['id'] not in looked:
                continue
            q['checked'] = stamp(now)
            recover_case(data, q, cases)
            if q.get('status') == 'case':
                if q['id'] in hits:
                    cid = q['case']
                    settle(q, hits[q['id']]['why'], 'check', now)
                    q['was_case'] = cid
                    try:
                        q['case_closed'] = close_untouched(data, cid, 'explained: ' + hits[q['id']]['why'], now, end=end)
                    except CheckTimeout:
                        raise
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
                    case_from(data, q, now, 'check', root, end=end)
                elif now - at >= FOLLOW_FOR:
                    # Never closed unseen: a week without an explanation is a money case he hears about.
                    case_from(data, q, now, 'check', root, end=end)
            except CheckTimeout:
                raise
            except CaseError as e:
                errors.append(f"{q['id']}: {e}")
        prune_questions(book, now)
    return errors


def question_entries(questions, now, sent):
    """attention()-style (head, items, tail, day) entries for what the check did to charge questions, once each."""
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
            # No day: a question's pings are once-only keys, outside the one-reminder-a-day cap of cases.
            entries.append((head, [(item[0], item[1])], item[2], None))
    return entries


def run_check(wd, run, data=None, root=None, now=None, find=None, said=None):
    started = time.time()
    end = started + CHECK_BUDGET
    # Reserve a second for the final save, which still has the whole-check deadline.
    work_end = end - 1
    stats = {'lookups': 0, 'owner_queries': 0, 'msgs_calls': 0}
    phases = {}
    phase, phase_at = 'reconcile', started
    now = (now or now_dubai()).astimezone(TZ)
    pings = wd / 'pings.json'
    state = read_json(pings, {'sent': {}})
    state.setdefault('sent', {})
    event = ''
    retained_outbox = state.get('outbox')
    try:
        with within(work_end, CheckTimeout('out of time; the rest next check')):
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
            retained_outbox = state.get('outbox')
            phases[phase] = time.time() - phase_at
            phase, phase_at = 'follow', time.time()
            errors = follow(data or DATA, now, root, min(end - 8, time.time() + FOLLOW_BUDGET), find, said,
                            end=work_end, stats=stats)
            phases[phase] = time.time() - phase_at
            phase, phase_at = 'attention', time.time()
            if errors:
                state['question_errors'] = {'at': stamp(now), 'errors': errors[:10]}
            else:
                state.pop('question_errors', None)
            # An event the runner never took is rebuilt from the book, so it skips quiet hours and closed or moved cases.
            cases = load(data)['cases']
            cutoff = stamp(now - KEEP_SENT)
            live = live_keys(cases)
            state['sent'] = {k: v for k, v in state['sent'].items() if v >= cutoff or k in live or k.startswith(live)}
            # An undelivered event is still out: the runner retries it. Never build a second one over it, so no
            # case key is recorded for an event that was never shown.
            if not quiet(now) and 'outbox' not in state:
                entries = attention(cases, now, state['sent'], root, clock) + \
                    question_entries(load_questions(data)['questions'], now, state['sent'])
                phases[phase] = time.time() - phase_at
                phase, phase_at = 'build_write', time.time()
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
                            if day:
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
    except CheckTimeout as e:
        errors = state.setdefault('question_errors', {'at': stamp(now), 'errors': []})['errors']
        errors.append(str(e))
        # A partly built event was never handed to the runner. Keep only a previously owned outbox.
        state.pop('outbox', None)
        if retained_outbox is not None:
            state['outbox'] = retained_outbox
        event = ''
    phases[phase] = time.time() - phase_at
    for name in ('reconcile', 'follow', 'attention', 'build_write'):
        phases.setdefault(name, 0)
    save_at = time.time()
    built_s = phases['build_write']

    def timing():
        phases['build_write'] = built_s + time.time() - save_at
        return {'at': stamp(now), 'total_s': round(time.time() - started, 3),
                **{f'{key}_s': round(value, 3) for key, value in phases.items()},
                **stats, 'slowest': max(phases, key=phases.get)}

    saved = False
    state.pop('timing', None)
    try:
        with within(end, CheckTimeout('out of time saving pings; the rest next check')):
            write_json(pings, state, timing=timing)
            saved = True
    except CheckTimeout:
        # The old pings file is intact; never emit an event without its committed outbox.
        event = ''
    result = timing()
    if not saved or result['total_s'] > 20:
        print('money-cases timing: ' + json.dumps({**result, 'pings_saved': saved}, sort_keys=True), file=sys.stderr)
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
    p.add_argument('--case', action='append', default=[], metavar='ID', help='an open case to move (repeatable)')
    p.add_argument('--dry-run', action='store_true')
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
            if hasattr(sys.stderr, 'reconfigure'):
                sys.stderr.reconfigure(line_buffering=True)
            faulthandler.enable(file=sys.stderr)
            faulthandler.dump_traceback_later(float(os.environ.get('MONEY_CASES_HARD_STOP', CHECK_BUDGET + 8)),
                                             exit=True)
            try:
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
            finally:
                faulthandler.cancel_dump_traceback_later()
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
            changes = card_swap(DATA, args.old, args.new, args.also, dry_run=args.dry_run, cases=args.case)
            for c in changes:
                # Same redaction as show/list: a hand-edited case may hold a card number or code in next.
                cid = redact(c['id'])
                if c.get('held'):
                    print(f"{cid}: next {redact(c['before'])!r} holds a card number or code, left as is; clean it by hand")
                elif c['after'] is None:
                    print(f"{cid}: names {args.old}, check by hand")
                else:
                    unpicked = ' (not picked)' if args.case and not c['picked'] else ''
                    print(f"{cid}: next {redact(c['before'])!r} -> {redact(c['after'])!r}{unpicked}")
            rewritable = [c for c in changes if c['after'] is not None]
            if not args.case:
                print(f"{len(rewritable)} case(s) would change; nothing written. Pick with --case ID (repeatable)")
            else:
                picked = sum(1 for c in rewritable if c['picked'])
                verb = 'would update' if args.dry_run else 'updated'
                print(f'{picked} case(s) {verb}')
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
