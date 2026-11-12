#!/usr/bin/python3
"""Open money cases: one row per case, deadline pings and ended reply watchers.

  money-cases list [--all] [--json]
  money-cases show ID
  money-cases add ID --merchant M --amount 12.34 --currency AED --state S --next N
                  --deadline D --who W [--reference R] [--why TEXT] [--watcher ID]...
  money-cases update ID [--merchant M] [--amount A] [--currency C] [--reference R]
                  [--state S] [--next N] [--deadline D] [--why TEXT] [--who W]
                  [--add-watcher ID] [--drop-watcher ID] [--note TEXT]
                  [--source REF | --reply ID]   required for deadline changes; [--because TEXT] is optional
  money-cases add ... --unmatched     no merchant match: recorded as "unmatched", never guessed
                  [--charged YYYY-MM-DD] [--kind charge|hold]   hold = pre-auth, dropped off = released
  money-cases card-swap --old OLD --new NEW [--also STALE ...] [--case ID ...] [--dry-run]
                  lists open cases naming the old card; writes only the cases picked with --case; never closes a case
                  and leaves a next line that holds a card number or code as is
  money-cases card-dead LAST4 --note TEXT
  money-cases cards    list dead cards
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
from email.utils import parseaddr
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
import payments  # noqa: E402

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
REASK_GAP = dt.timedelta(hours=24)
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


def check_source(source):
    source = check_text('source', source)
    if not re.fullmatch(r'(?:mail|sms|imessage):\S(?:.*\S)?|statement:\S(?:.*\S)?#[1-9][0-9]*', source):
        raise CaseError('source must be mail:<id>, sms:<id>, imessage:<id> or statement:<path>#<line> (value not shown)')
    return source


def check_watcher(watcher_id, root=None):
    if not ID.fullmatch(watcher_id):
        raise CaseError(f'watcher id {watcher_id!r} is not a robob-watch id')
    if not ((root or WATCH_ROOT) / 'watchers' / watcher_id / 'watcher.json').exists():
        raise CaseError(f'no robob-watch watcher {watcher_id!r}; create it first')
    return watcher_id


UNMATCHED = 'unmatched'
KINDS = ('charge', 'hold', 'payment_deadline', 'autopay_expected')
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


def load_cards(data=None):
    book = read_json((data or DATA) / 'cards.json', {'dead': {}})
    if not isinstance(book, dict) or not isinstance(book.get('dead'), dict):
        raise CaseError('cards.json is not a cards file')
    for last4, info in book['dead'].items():
        last4_arg('dead card', last4)
        if not isinstance(info, dict) or not isinstance(info.get('since'), str) or not isinstance(info.get('note'), str):
            raise CaseError('cards.json has an invalid dead card entry')
    return book


def dead_cards(data=None):
    return load_cards(data)['dead']


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
            self.book = {'cases': load, 'questions': load_questions, 'cards': load_cards}[self.name](self.data)
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
           because='', reply='', source=''):
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
        source = check_source(source) if source else ''
        if moved and not (source or reply):
            raise CaseError('deadline changes need --source (mail:, sms:, imessage: or statement:) or --reply (his reply id); nothing was changed')
        if because:
            said.append(f'because: {because}')
        if reply:
            said.append(f'owner reply {reply}')
        if source:
            said.append(f'source: {source}')
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
        if source:
            entry['source'] = source
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


def card_dead(data, last4, note, at=None):
    last4, note = last4_arg('card', last4), check_text('note', note)
    with Locked(data, 'cards') as book:
        book['dead'][last4] = {'since': book['dead'].get(last4, {}).get('since', stamp(at)), 'note': note}
    return book['dead'][last4]


def card_swap(data, old, new, also=(), dry_run=False, at=None, cases=()):
    """Point open cases at a replacement card: rewrite the old (and stale planned) last-4 in `next` only.

    A human picks each case with --case: only the ids in `cases` are written, and a pick with nothing to swap
    refuses the whole call before any write. Closed cases are never touched and nothing is closed here. A case
    that names a card elsewhere (state, why, reference) comes back with after=None so someone checks it by hand."""
    old, new = last4_arg('old', old), last4_arg('new', new)
    if old == new:
        raise CaseError('old and new card are the same last 4')
    stale = sorted({old, *(last4_arg('also', a) for a in also)})
    if new in stale:
        raise CaseError('new card is also listed as stale')
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
            if not dry_run:
                with Locked(data, 'cards') as cards:
                    for last4 in stale:
                        cards['dead'][last4] = {'since': cards['dead'].get(last4, {}).get('since', stamp(at)),
                                                'note': f'replaced by {new}'}
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


RENEWAL = re.compile(r'\b(?:renews on|will renew|auto[ -]?renew(?:al)?|next billing date|will be charged|subscription renewal)\b', re.I)
RENEWAL_DATE = re.compile(r'\b(?:20\d{2}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]20\d{2}|'
                          r'\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+20\d{2}|'
                          r'(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?,?\s+20\d{2})\b', re.I)
RENEWAL_CARD = re.compile(r'\bending\s+(?:in\s+)?([0-9]{4})(?!\d)|[•*]{4}\s*([0-9]{4})(?!\d)', re.I)
RENEWAL_TIER = r'(?:pro|plus|premium|basic|business|starter|standard|enterprise|free|team|individual|family)'


def renewal_disabled(text):
    entity = r'auto[ -]?renew(?:al)?|subscription|renewal|membership|plan|card'
    negative = re.compile(r'\b(?:not|never|no longer|no|without|[a-z]+n[’\']t)\s+'
                          r'(?:(?:be|been|being|to|set to|going to|scheduled to|ever|currently|[a-z]+ly)\s+){0,5}'
                          r'(?:auto[ -]?)?(?:renew(?:ed|s|al)?|charg(?:e|ed)|bill(?:ed)?|debit(?:ed)?)\b', re.I)
    state = re.compile(r'(?:^|\b(?:is|was|has|have|had|remains|stays)\s+|[:=]\s*)'
                       r'(?:(?:already|been|set to|[a-z]+ly|still|now)\s+){0,5}'
                       r'(?:cancell?ed|disabled|deactivated|turned off|switched off|off)\b', re.I)
    # Payment-method adjuncts aren't the subject of a trailing renewal status.
    text = re.sub(r'\b(?:using|with) (?:your )?card (?:ending (?:in )?|[•*]{4}\s*)[0-9]{4}\b', '', text, flags=re.I)
    for clause in re.split(r'(?<=[.!?;])\s+|\bbut\b|\bhowever\b|\bbecause\b', text, flags=re.I):
        # Instructions and conditional consequences don't establish the renewal's
        # current state. A cancelled card is precisely why this case needs action.
        if clause.rstrip().endswith('?'):
            continue
        assertions = []
        boundaries = [0] + [m.end() for m in re.finditer(r',\s+(?!\d)', clause, re.I)]
        for lo, hi in zip(boundaries, boundaries[1:] + [len(clause)]):
            part = clause[lo:hi]
            for subject in re.finditer(r'\b(?:' + entity + r')\b', part, re.I):
                if subject[0].lower() == 'card':
                    continue
                tail = part[subject.end():]
                offset = subject.end() + len(tail) - len(tail.lstrip())
                for match in state.finditer(tail.lstrip()):
                    if not re.search(r'\bcard\b', part[subject.end():offset + match.start()], re.I):
                        assertions.append((lo + offset + match.start(), lo + offset + match.end(), lo))
            assertions += [(lo + m.start(), lo + m.end(), lo) for m in negative.finditer(part)]
            for match in re.finditer(r'\b(?:cancell?ed|disabled|deactivated|turned off|switched off) '
                                     r'(?:your |the )?(?:' + entity + r')\b', part, re.I):
                if not re.search(r'\b(?:not|never|no longer|[a-z]+n[’\']t)\b', part[:match.start()], re.I) and not re.search(r'\bcard$', match[0], re.I):
                    assertions.append((lo + match.start(), lo + match.end(), lo))
        conditions = list(re.finditer(r'\b(?:if|unless|in case)\b', clause, re.I))
        for start, end, lo in assertions:
            prefix = clause[lo:start]
            if re.match(r'\s*and\b', prefix, re.I):
                # A comma doesn't end the control of "ensure X, and Y".
                # Causal clauses are split above because they assert their own fact.
                prefix = clause[:start]
            if re.search(r'\b(?:can|could|may|might|would|should|ensure|make sure|how to)\b|'
                         r'^\s*(?:please )?(?:set|keep)\b', prefix, re.I):
                continue
            # A condition attached to the assertion qualifies it. Advice in a later
            # comma clause ("cancelled, contact us if...") leaves the fact intact.
            conditional = any(c.start() < end or ',' not in clause[end:c.start()] or
                              not re.search(r'\w', clause[end:c.start()].rsplit(',', 1)[-1]) for c in conditions)
            if not conditional:
                return True
    return False


def renewal(text, sender='', subject=''):
    """Only dated renewal notices with one explicit money value and card can become cases."""
    body = ' '.join(text.split())
    text = ' '.join((subject + ' ' + body).split()).replace('$', 'USD ')
    marker = RENEWAL.search(text)
    if not marker or renewal_disabled(text):
        return None
    if re.search(r'\bwill be charged\b', text, re.I) and not re.search(
            r'\b(?:subscription|membership|recurring|renews on|will renew|auto[ -]?renew(?:al)?)\b|\b' +
            RENEWAL_TIER + r'\s+plan\b', text, re.I):
        return None
    try:
        amounts = {(m['c'] or m['d']).upper() + ':' + check_amount(m['a'] or m['b'])
                   for m in payments.MONEY.finditer(text)}
    except CaseError:
        return None
    cards = {m[1] or m[2] for m in RENEWAL_CARD.finditer(text)}
    dates = set()
    for marker in RENEWAL.finditer(text):
        if re.search(r'\b(?:last|previous|prior)\s*$', text[:marker.start()], re.I):
            continue
        tail = text[marker.end():]
        link = re.match(r'\s*(?:[:\-]\s*)?(?:(?:is|for|at)\s+)?', tail)
        price = payments.MONEY.match(tail, link.end())
        pos = price.end() if price else link.end()
        link = re.match(r'\s*(?:(?:on|scheduled for)\s+)?', tail[pos:])
        if RENEWAL_DATE.match(tail, pos + link.end()):
            # Only an immediately linked date is evidence. Other sentences may quote
            # the notice date, an old bill or a card's expiry instead of the renewal.
            clause = re.split(r'[.!?;](?:\s+|$)', tail, maxsplit=1)[0]
            dates.update(m[0] for m in RENEWAL_DATE.finditer(clause))
    if len(amounts) != 1 or len(cards) != 1 or len(dates) != 1:
        return None
    date_text = re.sub(r'(\d)(?:st|nd|rd|th)\b', r'\1', dates.pop(), flags=re.I).replace(',', '')
    for fmt in ('%Y-%m-%d', '%d/%m/%Y', '%d-%m-%Y', '%d %b %Y', '%d %B %Y', '%b %d %Y', '%B %d %Y'):
        try:
            date = dt.datetime.strptime(date_text, fmt).date().isoformat()
            break
        except ValueError:
            pass
    else:
        return None
    name = (re.search(r'\byour\s+([\w&.-]+(?:\s+[\w&.-]+){0,4}?)\s+(?:plan|subscription|membership)\b', body, re.I) or
            re.search(r'\b([\w&.-]+(?:\s+[\w&.-]+){0,2}?)\s+(?:plan|subscription|membership)\b', body, re.I))
    merchant = name[1] if name else ''
    merchant = re.sub(r'^(?:your|the)\s+', '', merchant, flags=re.I)
    merchant = re.sub(r'(?:^|\s+)' + RENEWAL_TIER + r'(?:\s+' + RENEWAL_TIER + r')*$', '', merchant, flags=re.I)
    if re.search(r'\b(?:your|the|subscription|renewal|monthly|annual|annually|yearly|quarterly|weekly|daily|trial)\b', merchant, re.I):
        merchant = ''
    domain = ''
    if sender:
        address = re.fullmatch(r'[^@\s]+@([a-z0-9.-]+)', parseaddr(sender)[1], re.I)
        domain = address[1].strip('.').lower() if address else ''
        identity = domain or sender.strip()
        key = lambda value: re.sub(r'[^a-z0-9]', '', value.lower())
        # A generic plan label must not identify two unrelated senders as one merchant.
        # Only a simple brand domain can confirm a body name. Neither display names
        # nor shared subdomain labels establish which merchant sent the notice.
        if domain:
            brand = domain.split('.')[0] if domain.count('.') == 1 else ''
        else:
            brand = identity
        if not key(merchant) or key(merchant) != key(brand):
            merchant = identity
    if not merchant:
        return None
    currency, amount = amounts.pop().split(':')
    try:
        merchant = check_text('merchant', merchant)
    except CaseError:
        return None
    notice = {'merchant': merchant, 'amount': amount, 'currency': currency,
              'date': date, 'last4': cards.pop()}
    if domain:
        notice['identity'] = domain
    return notice


def renewal_case(data, notice, source, now=None, end=None, include_existing=False):
    data, now = data or DATA, now or now_dubai()
    if notice['last4'] not in dead_cards(data):
        return None
    source = check_text('source', source)
    merchant = check_text('merchant', notice['merchant'])
    identity = check_text('renewal identity', notice.get('identity', ''), False).lower()
    identity_key = identity or merchant.lower()
    slug = re.sub(r'[^a-z0-9]+', '-', merchant.lower()).strip('-')
    if len(slug) > 29:
        slug = slug[:20].rstrip('-') + '-' + hashlib.sha256(identity_key.encode()).hexdigest()[:8]
    if not slug:
        raise CaseError('renewal merchant needs letters or digits for a case id')
    due = check_charged(notice['date'])
    cid = f'renewal-{slug}-{due}'
    try:
        with Locked(data, wait=lock_wait(end)) as book:
            existing = next((c for c in book['cases'] if identity and c.get('renewal_identity') == identity
                             and c.get('renewal_date') == due), None)
            if not existing:
                # SMS has a merchant name but no mailbox domain. Match a unique
                # domain label in either arrival order; ambiguous aliases stay in triage.
                neutral = {'notifications', 'notification', 'mail', 'email', 'billing', 'alerts', 'alert',
                           'noreply', 'support', 'updates', 'accounts', 'account', 'co', 'com', 'org', 'net', 'gov', 'edu', 'ac'}
                def domain_alias(name, domain):
                    key = re.sub(r'[^a-z0-9]', '', name.lower())
                    return key and key not in neutral and key in {
                        re.sub(r'[^a-z0-9]', '', label) for label in domain.split('.')[:-1]}
                aliases = [c for c in book['cases'] if c.get('renewal_date') == due and (
                    (not identity and c.get('renewal_identity') and domain_alias(merchant, c['renewal_identity'])) or
                    (identity and not c.get('renewal_identity') and domain_alias(c['merchant'], identity)))]
                if len(aliases) > 1:
                    case = None
                    raise _DryRun
                if aliases:
                    existing = aliases[0]
            named = next((c for c in book['cases'] if c['id'] == cid), None)
            if not existing and named and (not identity or not named.get('renewal_identity')) and named['merchant'].lower() == merchant.lower():
                existing = named
            if existing:
                if identity and not existing.get('renewal_identity'):
                    # Every senderless match must bind through this common path,
                    # including names containing dots that match a readable id.
                    existing['renewal_identity'] = identity
                    existing['history'].append({'at': stamp(now), 'text': f'renewal sender confirmed; source: {source}',
                                                'source': source})
                    return existing if include_existing else None
                case = existing
                raise _DryRun
            if named:
                # Different domains can have the same readable slug (dots vs dashes).
                # Keep the first readable id and disambiguate the other exact identity.
                slug = slug[:20].rstrip('-') + '-' + hashlib.sha256(('collision:' + identity_key).encode()).hexdigest()[:8]
                cid = f'renewal-{slug}-{due}'
                alternate = next((c for c in book['cases'] if c['id'] == cid), None)
                if alternate:
                    if alternate['merchant'].lower() == merchant.lower() and (not identity or alternate.get('renewal_identity') == identity):
                        case = alternate
                        raise _DryRun
                    raise CaseError('renewal identity conflicts with an existing case; review it by hand')
            case = {'id': cid, 'kind': 'charge', 'merchant': merchant,
                    'amount': check_amount(notice['amount']), 'currency': check_currency(notice['currency']),
                    'charged': due, 'reference': source,
                    'state': f"renews {due} on dead card {notice['last4']}",
                    'next': 'move the subscription to a live card or cancel it', 'deadline': due,
                    'who': 'Abdullah', 'why': '', 'watchers': [], 'status': 'open', 'rev': 0, 'cycle': 0,
                    'opened': stamp(now), 'updated': stamp(now), 'closed': None, 'outcome': None,
                    'renewal_identity': identity, 'renewal_date': due,
                    'history': [{'at': stamp(now), 'text': f'opened; source: {source}', 'source': source}]}
            book['cases'].append(case)
    except _DryRun:
        return case if include_existing else None
    return case


def payment_matches(case, notice):
    return (case.get('kind') in ('payment_deadline', 'autopay_expected') and
            case.get('merchant') == notice['institution'] and case['amount'] == notice['amount'] and
            case['currency'] == notice['currency'])


def payment_close(case, outcome, at, owner=False):
    case.update(status='closed', closed=stamp(at), outcome=outcome, updated=stamp(at))
    case['history'].append({'at': stamp(at), 'text': 'closed: ' + outcome, 'owner': owner})


def payment_in(book, notice, source, now):
    source = check_text('source', source)
    observed = parse_time(notice['at'])
    matches = [c for c in book['cases'] if payment_matches(c, notice)]
    if notice['kind'] == 'payment_success':
        receipts = book.setdefault('payment_successes', [])
        if not any(r['source'] == source for r in receipts):
            receipts.append({**notice, 'source': source})
        book['payment_successes'] = [r for r in receipts if parse_time(r['at']) >= now - KEEP_SENT]
        closed = []
        for case in matches:
            if case['status'] == 'open' and parse_time(case['opened']) <= observed <= deadline_of(case) + dt.timedelta(days=7):
                payment_close(case, 'payment confirmed by ' + source, now)
                closed.append(case['id'])
        return closed
    due = check_deadline(notice['deadline'])
    key = '|'.join((notice['kind'], notice['institution'], notice['currency'], notice['amount'], stamp(parse_time(due))))
    cid = ('pay-' if notice['kind'] == 'payment_deadline' else 'auto-') + hashlib.sha256(key.encode()).hexdigest()[:20]
    for case in matches:
        if case['id'] == cid or source in case.get('sources', []) or (
                case.get('kind') == notice['kind'] and deadline_of(case) == parse_time(due)):
            if source not in case.setdefault('sources', []):
                case['sources'].append(source)
            if notice.get('deadline_basis') != 'scheduled_fallback':
                case['deadline_basis'] = 'bank_notice'
            return case['id']
    # A delayed/replayed failure must not resurrect a payment already confirmed.
    for receipt in book.get('payment_successes', []):
        if payment_matches({'kind': 'payment_deadline', 'merchant': receipt['institution'],
                            'amount': receipt['amount'], 'currency': receipt['currency']}, notice) and \
                observed <= parse_time(receipt['at']) <= parse_time(due) + dt.timedelta(days=7):
            return None
    case = {'id': cid, 'kind': notice['kind'], 'merchant': notice['institution'],
            'amount': check_amount(notice['amount']), 'currency': check_currency(notice['currency']),
            'deadline': due, 'due': due if notice['kind'] == 'autopay_expected' else None,
            'stated_deadline': notice.get('repayment_deadline'), 'sources': [source],
            'deadline_basis': notice.get('deadline_basis', 'bank_notice'),
            'charged': observed.date().isoformat(), 'reference': source, 'why': '',
            'state': 'autopay expected' if notice['kind'] == 'autopay_expected' else 'payment needs confirmation',
            'next': 'check payment confirmation; close with --outcome paid when confirmed', 'who': 'Abdullah',
            'watchers': [], 'status': 'open', 'rev': 0, 'cycle': 0,
            'opened': stamp(observed), 'updated': stamp(now), 'closed': None, 'outcome': None,
            'history': [{'at': stamp(now), 'text': 'bank notice: ' + source}]}
    if notice['kind'] == 'payment_deadline':
        expected = [c for c in matches if c.get('kind') == 'autopay_expected' and c['status'] == 'open' and
                    -dt.timedelta(hours=1) <= observed - parse_time(c.get('due') or c['deadline']) <= dt.timedelta(days=1)]
        if expected:
            parent = min(expected, key=lambda c: abs(observed - parse_time(c.get('due') or c['deadline'])))
            case['autopay_case'] = parent['id']
            previous = next((c for c in matches if c['id'] == parent.get('payment_case')), None)
            if previous and previous['status'] == 'open' and previous.get('deadline_basis') == 'scheduled_fallback' and notice.get('deadline_basis') != 'scheduled_fallback':
                payment_close(previous, 'superseded by bank deadline ' + cid, now)
            parent['payment_case'] = cid
    book['cases'].append(case)
    return cid


def record_payment(data, notice, source, now=None, end=None):
    now = now or now_dubai()
    with Locked(data or DATA, wait=lock_wait(end)) as book:
        return payment_in(book, notice, source, now)


def follow_payments(data, now, deadline, find=None, stats=None, end=None):
    errors = []
    source = find or (lambda *args, **kwargs: charges.search(*args, **kwargs, stats=stats))
    write_end = end if end is not None else deadline + 2
    candidates = [c for c in load(data)['cases'] if c.get('kind') == 'autopay_expected' and c['status'] == 'open'
                  and now >= parse_time(c.get('due') or c['deadline']) + dt.timedelta(hours=1)]
    for case in sorted(candidates, key=lambda c: c.get('payment_checked', '')):
        if deadline - time.time() < 1:
            break
        each = min(deadline, time.time() + 4)
        due = parse_time(case.get('due') or case['deadline'])
        success = None
        try:
            with within(each, LookupTimeout('autopay lookup out of time')):
                if stats is not None:
                    stats['lookups'] += 1
                # One query spans email and SMS. Parse the returned body as a bank notice;
                # an amount or a success keyword in an unrelated receipt is not confirmation.
                query = ' OR '.join(f'"{v}"' for v in charges.amounts(case))
                rows = source(query, since=charges.day(parse_time(case['opened'])),
                              until=charges.day(now + dt.timedelta(days=1)), n=20, deadline=each)
                success = None
                for row in rows[:20]:
                    if row.get('from_me') or row.get('source') not in ('email', 'mail', 'imessage', 'sms'):
                        continue
                    observed = (dt.datetime.fromtimestamp(row['ts'], TZ) if isinstance(row.get('ts'), (float, int))
                                else moment(row.get('at') or row.get('date')))
                    if not observed or not parse_time(case['opened']) <= observed <= now:
                        continue
                    if payments.institution(str(row.get('sender') or '')) != case['merchant']:
                        continue
                    text = ' '.join(str(row.get(k) or '') for k in ('subject', 'snippet', 'text', 'body'))
                    if not row.get('body') and not row.get('text'):
                        text = charges.alert_text(charges.show(row, deadline=each, stats=stats))
                    notice = payments.parse(text, str(row.get('sender') or ''), observed)
                    if notice and notice['kind'] == 'payment_success' and payment_matches(case, notice):
                        success = (notice, str(row['id']))
                        break
        except (charges.Lookup, LookupTimeout) as e:
            errors.append(str(e))
        # No confirmation is still unconfirmed when the archive is unavailable.
        # Do not claim the debit failed; keep the deadline visible for checking.
        with Locked(data, wait=lock_wait(write_end)) as book:
            current = next(c for c in book['cases'] if c['id'] == case['id'])
            if current['status'] != 'open':
                continue
            current['payment_checked'] = stamp(now)
            if success:
                payment_in(book, success[0], success[1], now)
            else:
                existing = next((c for c in book['cases'] if c.get('kind') == 'payment_deadline' and c['status'] == 'open' and
                                 payment_matches(c, {'institution': case['merchant'], 'amount': case['amount'],
                                                     'currency': case['currency']}) and
                                 (c['id'] == current.get('payment_case') or
                                  (deadline_of(c) and abs(deadline_of(c) - due) <= dt.timedelta(days=1)))), None)
                repayment = (existing['deadline'] if existing else current.get('stated_deadline')) or stamp(due + dt.timedelta(hours=3))
                notice = {'kind': 'payment_deadline', 'institution': case['merchant'],
                          'currency': case['currency'], 'amount': case['amount'],
                          'at': case['opened'], 'deadline': repayment, 'deadline_basis': 'scheduled_fallback'}
                child = existing['id'] if existing else payment_in(book, notice, 'missing-' + case['id'], now)
                current['payment_case'] = child
                if child:
                    next(c for c in book['cases'] if c['id'] == child)['autopay_case'] = case['id']
    return errors


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
        if case.get('kind') in ('payment_deadline', 'autopay_expected'):
            notice = {'institution': case['merchant'], 'amount': case['amount'], 'currency': case['currency']}
            for other in book['cases']:
                if other['status'] == 'open' and payment_matches(other, notice) and (
                        other['id'] in (case.get('autopay_case'), case.get('payment_case')) or
                        (deadline_of(other) and deadline_of(case) and
                         abs(deadline_of(other) - deadline_of(case)) <= dt.timedelta(days=1))):
                    payment_close(other, outcome, at, owner=True)
    with Locked(data, 'questions') as questions:
        for q in questions['questions']:
            if linked_case(q) == case_id:
                settle(q, outcome, 'case_close', at or now_dubai())
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
        if case.get('status') != 'open' or case_owner(case) != 'abdullah':
            continue
        if case.get('kind') in ('payment_deadline', 'autopay_expected'):
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
            keys += [f'{cid}|r{rev}|c{cycle}|payment|', f'{cid}|r{rev}|soon', f'{cid}|r{rev}|no-deadline', f'{cid}|c{cycle}|', f'{cid}|ask|']
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
         'owner': charges.card_owner(charge), 'card': charge['card'], 'currency': charge['currency'], 'amount': charge['amount'],
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


def linked_case(q):
    return q.get('case') or q.get('was_case') or 'charge-' + q['id'][2:]


def case_owner(case):
    if case.get('owner'):
        return case['owner']
    cards = re.findall(r'(?<!\d)\d{4}(?!\d)', case.get('reference', '') + ' ' + case.get('state', ''))
    if any(charges.card_owner({'card': card}) == 'moni' for card in cards):
        return 'moni'
    return 'moni' if str(case.get('who', '')).lower() in ('moni', 'monika') else 'abdullah'


def recover_case(data, q, cases=None):
    if not q:
        return
    cases = load(data)['cases'] if cases is None else cases
    previous = next((c for c in cases if c['id'] == linked_case(q)), None)
    if previous and (q.get('case') or q.get('was_case') or previous.get('why') == f'charge question {q["id"]}'):
        q['case'] = previous['id']
        if previous['status'] == 'closed' and q.get('status') != 'closed':
            q.update(was_case=previous['id'], case_closed=True)
            settle(q, previous.get('outcome') or 'case closed', 'case_close', parse_time(previous['closed']))
        elif previous['status'] == 'open' and q.get('status') == 'open':
            settle(q, f'now money case {previous["id"]}', 'check', parse_time(previous['opened']), 'case')


def repeat_bill(data, q, now, end=None):
    data = data or DATA
    # A new bank alert after a card-change closure is evidence that the merchant billed again.
    if q.get('status') != 'open' or q.get('kind') != 'charge':
        return
    with Locked(data, wait=lock_wait(end)) as book:
        for case in reversed(book['cases']):
            outcome = case.get('outcome') or ''
            if case.get('status') != 'closed' or not re.search(
                    r'\b(?:card (?:changed|dead|cancelled|canceled|replaced)|(?:changed|dead|cancelled|canceled|replaced) card)\b',
                    outcome, re.I):
                continue
            if case_owner(case) != charges.card_owner(charge_of(q)):
                continue
            if merchant_key(case['merchant']) != q['mkey'] or parse_time(q['at']) <= parse_time(case['closed']):
                continue
            case.update(status='open', closed=None, outcome=None, deadline=now.date().isoformat(),
                        amount=q['amount'], currency=q['currency'], charged=parse_time(q['at']).date().isoformat(),
                        state='merchant billed again after card change', updated=stamp(now),
                        rev=case.get('rev', 0) + 1, cycle=case.get('cycle', 0) + 1,
                        owner=charges.card_owner(charge_of(q)))
            case['history'].append({'at': stamp(now), 'text': f'repeat bill: charge question {q["id"]}'})
            q['case'] = case['id']
            settle(q, f'now money case {case["id"]}', 'check', now, 'case')
            return


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
    data = data or DATA
    charge = charges.parse(text, sender)
    if not charge:
        return None
    now = (now or now_dubai()).astimezone(TZ)
    at = (at or now).astimezone(TZ)
    chan = channel(sender)
    q = question_for(load_questions(data), charge, at, chan, item)
    recover_case(data, q)
    owner = charges.card_owner(charge)
    base = {'kind': charge['kind'], 'owner': owner, 'errors': []}
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
        return {**base, 'verdict': 'held' if owner == 'moni' else 'case', 'why': f"money case {q['case']}", 'id': q['id']}
    if owner != 'moni' and q and q.get('asks'):
        return {**base, 'verdict': 'asked', 'why': f"asked {len(q['asks'])} time(s); the check follows it",
                'id': q['id']}
    if owner != 'moni' and q and q.get('passed') and item and q.get('item') and q['item'] != item:
        return {**base, 'verdict': 'asked', 'why': f"another alert for this charge ({q['item']}) went to him",
                'id': q['id']}
    r = charges.explain(charge, at, now, deadline, find, said)
    verdict = 'explained' if r['verdict'] in ('receipt', 'owner') else r['verdict']
    qid = q['id'] if q else None
    if record:
        with Locked(data or DATA, 'questions') as book:
            q = question_for(book, charge, at, chan, item) or new_question(book, charge, text, at, now, chan, item)
            q['owner'] = owner
            recover_case(data, q)
            repeat_bill(data, q, now)
            attach(q, chan, at, item)
            qid = q['id']
            if q['status'] == 'case':
                return {**base, 'verdict': 'held' if owner == 'moni' else 'case', 'why': f"money case {q['case']}", 'id': qid}
            if q['status'] == 'open' and not q.get('asks') and not q.get('passed'):
                note_why(q, r['why'], now)
                if verdict == 'explained':
                    settle(q, r['why'], 'triage', now)
                elif verdict == 'wait':
                    q['wait_until'] = r['until']
            prune_questions(book, now)
    return {**base, 'verdict': verdict, 'why': r['why'], 'id': qid, 'errors': r['errors']}


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
    recover_case(data, q)
    # Lookups run before taking the lock; a settled question needs none.
    r = None if q and q['status'] != 'open' else charges.explain(charge, at, now, deadline, find, said)
    with Locked(data, 'questions') as book:
        q = (find_question(book, q['id']) if q else None) or question_for(book, charge, at, chan) \
            or new_question(book, charge, text, at, now, chan)
        q['owner'] = charges.card_owner(charge)
        recover_case(data, q)
        repeat_bill(data, q, now)
        if chan:
            attach(q, chan, at)
        if q['status'] == 'closed':
            return DONT_ASK, f"{q['id']} is settled ({q['outcome']}). Don't ask."
        if q['status'] == 'case':
            return DONT_ASK, f"{q['id']} is money case {q['case']}; follow the case, don't ask about the charge."
        if r is None:
            r = charges.explain(charge, at, now, deadline, find, said)
        note_why(q, r['why'], now)
        if r['errors']:
            return 4, '\n'.join(f"UNVERIFIED: source {e.split(':', 1)[0]} unreadable ({q['id']})" for e in r['errors'])
        if r['verdict'] in ('receipt', 'owner'):
            settle(q, r['why'], 'ask', now)
            if q['owner'] == 'moni':
                return DONT_ASK, f"{q['id']}: explained for Moni (owner: moni); {r['why']}."
            return DONT_ASK, (f"{q['id']} is explained: {r['why']}. Don't ask; if he was asked about it before, "
                              'tell him in one line.')
        if q['owner'] == 'moni':
            return DONT_ASK, f"{q['id']}: held for Moni (owner: moni). Don't ask Abdullah."
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
        return 0, (f"{q['id']}: ask him now ({len(asks)} of {MAX_ASKS}); {r['why']}. When he answers: "
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
    errors, hits, looked, failed = [], {}, set(), set()
    todo = []
    questions = load_questions(data)['questions']
    cases, repaired = load(data)['cases'], set()
    for q in questions:
        before = dict(q)
        q['owner'] = charges.card_owner(charge_of(q))
        recover_case(data, q, cases)
        if q != before:
            repaired.add(q['id'])
    for q in questions:
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
    owner_error = None
    if charge_times and now - (min(charge_times) - charges.OWNER_AROUND) <= dt.timedelta(days=2):
        try:
            with within(deadline, LookupTimeout('out of time')):
                owner_rows = source(min(charge_times) - charges.OWNER_AROUND, now, deadline=deadline)
        except (charges.Lookup, LookupTimeout) as e:
            owner_error = f'his threads: {e}'
            errors.append(owner_error)
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
        before_errors = len(errors)
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
                    if owner_rows is not None and charges.card_owner(charge_of(q)) == 'abdullah' else None
            if hit:
                hits[q['id']] = hit
            if owner_error or len(errors) > before_errors:
                failed.add(q['id'])
    if not looked and not repaired:
        return errors
    with Locked(data, 'questions', wait=lock_wait(end)) as book:
        cases = load(data)['cases']
        for q in book['questions']:
            if q['id'] not in looked and q['id'] not in repaired:
                continue
            q['owner'] = charges.card_owner(charge_of(q))
            if q['id'] in looked:
                q['checked'] = stamp(now)
                q['unverified'] = q['id'] in failed
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
            if q['id'] in failed or charges.card_owner(charge_of(q)) == 'moni':
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
        if charges.card_owner(charge_of(q)) != 'abdullah':
            continue
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
        elif q.get('status') == 'open' and not q.get('unverified') and not q.get('asks') and q.get('wait_until') \
                and now >= parse_time(q['wait_until']):
            item = (f"q|{q['id']}|ask", 'no receipt came while we waited',
                    f"Run money-cases ask --id {q['id']} --said '<question>' and ask him once if it says so")
        else:
            continue
        if item[0] not in sent:
            # No day: a question's pings are once-only keys, outside the one-reminder-a-day cap of cases.
            entries.append((head, [(item[0], item[1])], item[2], None))
    return entries


def payment_entries(cases, now, sent):
    entries = []
    for case in sorted(cases, key=lambda c: deadline_of(c) or now):
        if case.get('kind') != 'payment_deadline' or case['status'] != 'open' or case_owner(case) != 'abdullah':
            continue
        due = deadline_of(case)
        if not due:
            continue
        base = f"{case['id']}|r{case.get('rev', 0)}|c{case.get('cycle', 0)}|payment|"
        # The watcher ticks every 15 min. Start one tick early so a 23:59 deadline
        # gets its hour-before reminder before the existing 23:00 quiet window.
        stage = 'deadline' if now >= due else 'hour' if now >= due - dt.timedelta(minutes=75) else 'initial'
        if stage is None or base + stage in sent:
            continue
        head = f"- {case['id']}: {clip(redact(case['merchant']), 80)} {clip(money(case), 40)}"
        entries.append((head, [(base + stage, f'Payment deadline {day(due)} {due:%H:%M} Dubai; still unconfirmed')],
                        'Send this payment reminder alone. Confirm paid/done with money-cases close ID --outcome paid.', None))
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
    state.setdefault('built', {})
    event = ''
    retained_outbox = state.get('outbox')
    try:
        with within(work_end, CheckTimeout('out of time; the rest next check')):
            out = state.pop('outbox', None)
            if out:
                for key in out['keys']:
                    state['built'].setdefault(key, out['at'])
                for cid in out.get('days', []):
                    state['built'].setdefault(f"{cid}|day|{parse_time(out['at']).date()}", out['at'])
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
                # Build keys already suppress another emission. Two cases: the runner took the event (it is in state.json `pending`, and it will
                # retry it), or the runner never took it (the check died before the runner saved it). Only the first
                # is kept; the second is dropped, allowing unrelated new keys to proceed.
                if runner_owns(wd, out):
                    state['outbox'] = out
            retained_outbox = state.get('outbox')
            phases[phase] = time.time() - phase_at
            phase, phase_at = 'follow', time.time()
            errors = follow_payments(data or DATA, now, min(end - 28, time.time() + 6), find, stats, end=work_end)
            errors += follow(data or DATA, now, root, min(end - 8, time.time() + FOLLOW_BUDGET), find, said,
                            end=work_end, stats=stats)
            phases[phase] = time.time() - phase_at
            phase, phase_at = 'attention', time.time()
            if errors:
                state['question_errors'] = {'at': stamp(now), 'errors': errors[:10]}
            else:
                state.pop('question_errors', None)
            # Only new keys may produce another event, even when delivery is never acknowledged.
            cases = load(data)['cases']
            cutoff = stamp(now - KEEP_SENT)
            live = live_keys(cases)
            state['sent'] = {k: v for k, v in state['sent'].items() if v >= cutoff or k in live or k.startswith(live)}
            state['built'] = {k: v for k, v in state['built'].items()
                              if v >= cutoff or k.startswith(live) or k.startswith('q|')}
            # An undelivered event is still out: the runner retries it. Never build a second one over it, so no
            # case key is recorded for an event that was never shown.
            if not quiet(now) and 'outbox' not in state:
                handled = state['sent'] | state['built']
                questions = load_questions(data)['questions']
                qentries = question_entries(questions, now, handled)
                qids = {key.split('|')[1] for _, items, _, _ in qentries for key, _ in items}
                covered = {q['id']: linked_case(q) for q in questions if q['id'] in qids}
                due = attention(cases, now, handled, root, clock)
                by_case = {entry[3]: entry for entry in due}
                combined = []
                for head, items, tail, case_id in qentries:
                    qid = items[0][0].split('|')[1]
                    cid = covered[qid]
                    if cid in by_case:
                        _, reminders, next_action, _ = by_case[cid]
                        items = items + reminders
                        tail = tail + '. ' + next_action
                        case_id = cid
                    combined.append((head, items, tail, case_id))
                payment_due = payment_entries(cases, now, handled)
                entries = payment_due[:1] if payment_due else [entry for entry in due if entry[3] not in covered.values()] + combined
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
                    for key in taken:
                        state['built'][key] = stamp(now)
                    for cid in days:
                        state['built'][f'{cid}|day|{now.date()}'] = stamp(now)
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
    open_cases = [c for c in cases if c.get('status') == 'open' and case_owner(c) == 'abdullah']
    if not open_cases:
        return ''
    due, changed = [], []
    far = dt.datetime.max.replace(tzinfo=TZ)
    for case in sorted(open_cases, key=lambda c: (c.get('kind') != 'payment_deadline', deadline_of(c) or far)):
        deadline = deadline_of(case)
        if deadline is None:
            due.append(f"{case['merchant']} {money(case)} (no valid deadline)")
        elif case.get('kind') == 'payment_deadline' or deadline <= now + BRIEF_DUE:
            late = 'overdue since ' if deadline <= now else ''
            display = f'{day(deadline)} {deadline:%H:%M} Dubai' if case.get('kind') == 'payment_deadline' else when(deadline)
            due.append(f"{case['merchant']} {money(case)} ({late}{display})")
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
            p.add_argument('--because', default='', help='optional reason for a deadline change')
            p.add_argument('--source', default='', help='evidence: mail:, sms:, imessage: or statement:<path>#<line>')
            p.add_argument('--reply', default='', help="his reply id for a deadline change (or use --source)")
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
    p = sub.add_parser('card-dead', help='record a cancelled card by its last 4 digits')
    p.add_argument('last4')
    p.add_argument('--note', required=True)
    sub.add_parser('cards', help='list dead cards')
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
            qs = [q for q in load_questions()['questions'] if args.all or (q.get('status') == 'open' and charges.card_owner(charge_of(q)) == 'abdullah')]
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
            cases = [c for c in load()['cases'] if args.all or (c['status'] == 'open' and case_owner(c) == 'abdullah')]
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
                   because=args.because, reply=args.reply, source=args.source)
            print(table([find(load(), args.id)]))
        elif args.command == 'corroborate':
            corroborate(DATA, args.id, args.merchant, args.amount, args.currency, args.charged, args.kind,
                        args.observation)
            print(table([find(load(), args.id)]))
        elif args.command == 'card-dead':
            card_dead(DATA, args.last4, args.note)
            print(f'card {args.last4} marked dead')
        elif args.command == 'cards':
            print(json.dumps(redact_all(dead_cards(DATA)), ensure_ascii=False, indent=1))
        elif args.command == 'card-swap':
            changes = card_swap(DATA, args.old, args.new, args.also, dry_run=args.dry_run, cases=args.case)
            if not args.dry_run:
                print('marked dead: ' + ', '.join(sorted({args.old, *args.also})))
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
                print(f"{len(rewritable)} case(s) would change; cases unchanged. Pick with --case ID (repeatable)")
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
    except (CaseError, charges.Lookup) as e:
        if isinstance(e, charges.Lookup):
            print(f"UNVERIFIED: source {str(e).split(':', 1)[0]} unreadable", file=sys.stderr)
            return 4
        print(f'money-cases: {e}', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
