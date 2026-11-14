#!/usr/bin/python3
"""Open money cases: one row per case, deadline pings and ended reply watchers.

  money-cases list [--all] [--json]
  money-cases show ID
  money-cases add ID --merchant M --amount 12.34 --currency AED --state S --next N
                  --deadline D --who W [--due D] [--reference R] [--why TEXT] [--watcher ID]...
  money-cases update ID [--merchant M] [--amount A] [--currency C] [--reference R]
                  [--state S] [--next N] [--deadline D] [--due D] [--why TEXT] [--who W]
                  [--add-watcher ID] [--drop-watcher ID] [--note TEXT]
                  [--source REF | --reply ID]   required for deadline changes; [--because TEXT] is optional
                  [--because TEXT | --reply ID]   required for due changes
  money-cases add ... --unmatched     no merchant match: recorded as "unmatched", never guessed
                  [--charged YYYY-MM-DD] [--kind charge|hold]   hold = pre-auth, dropped off = released
  money-cases card-swap --old OLD --new NEW [--also STALE ...] [--case ID ...] [--dry-run]
                  lists open cases naming the old card; writes only the cases picked with --case; never closes a case
                  and leaves a next line that holds a card number or code as is
  money-cases card-dead LAST4 --note TEXT
  money-cases cards    list dead cards
  money-cases close ID --outcome TEXT
  money-cases reopen ID --deadline D --note TEXT
  money-cases brief    one line for open cases or closed cases with running reply watchers
  money-cases check    the robob-watch check for the money-cases watcher

Charge questions (owner rule, nightly 2026-10-24: never ask about a charge a receipt or his own
words already explain, wait for the receipt from a merchant he already pays, never ask a third time):
  money-cases charge ALERT [--sender S] [--at T] [--now T]   is a card alert explained? (reads only)
  money-cases ask (ALERT --at T [--sender S] | --id QID) --said QUESTION
                       run before asking him about a charge: exit 0 = ask now (counted), 3 = don't
  money-cases answered QID --note TEXT
  money-cases questions [--all] [--json]
  money-cases migrate-legacy-asks [--dry-run]   mark pre-13 Nov 04:25Z cases already raised
  money-cases unasked [--all] [--json | --ask]   daily first asks, screened before listing

A deadline is a date (09:00 Dubai that day) or an ISO time. Every open case has one.
An optional due date uses the same format; deadline remains the follow-up ping date.
"""
import argparse
import calendar
import contextvars
import datetime as dt
from decimal import Decimal, InvalidOperation
from email.utils import parseaddr
import fcntl
import faulthandler
import functools
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
import charges  # noqa: E402
from state_json import write_json as atomic_write_json
import payments  # noqa: E402
# Inbox triage already uses the watcher helper named toollog in this process.
_log_spec = importlib.util.spec_from_file_location('money_cases_orders_log', Path(__file__).resolve().with_name('toollog.py'))
toollog = importlib.util.module_from_spec(_log_spec)
_log_spec.loader.exec_module(toollog)

# robob-watch test copies the watcher into scratch, while helpers stay installed.
REDACT_HELPERS = Path(__file__).resolve().parents[2] / 'helpers'
if not (REDACT_HELPERS / 'redact.py').is_file():
    REDACT_HELPERS = Path.home() / '.local/share/robob-watch/helpers'
sys.path.insert(0, str(REDACT_HELPERS))
from redact import redact as redact_credentials, SEP

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
# ask and one re-ask (not within REASK_GAP of the first). Unanswered questions stay listed indefinitely.
SAME_CHARGE = dt.timedelta(minutes=15)
# A successful retry explains a decline only within an hour of that decline.
PAID_AFTER = dt.timedelta(minutes=60)
# The same alert seen twice (a re-run, or an ask whose --at is the minute shown) lands this close;
# a second alert on the same channel further apart is a second charge.
ALERT_SAME = dt.timedelta(minutes=2)
MAX_ASKS = 2
REASK_GAP = dt.timedelta(hours=24)
CASE_AFTER = dt.timedelta(hours=12)
UNMATCHED_AFTER = dt.timedelta(hours=2)
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
FIELDS = ('merchant', 'amount', 'currency', 'reference', 'state', 'next', 'deadline', 'due', 'why', 'who')
REFUND_DONE = re.compile(
    r'\brefund\s+(?:(?:(?P<past>has been|was)|is)\s+)?(?P<after>processed|issued|initiated|credited|refunded|sent)\b'
    r'|\b(?P<before>processed|issued|initiated)\s+(?:(?:the|your)\s+)?refund\b'
    r'|\b(?:(?P<credit_past>was|has been)\s+)?(?P<credit>credited)\s+back to your (?:card|account)\b', re.I)
REFUND_NEGATION = re.compile(r"\b(?:not|can't|cannot|unable|won't|isn't|hasn't|wasn't|haven't|never)\b", re.I)
_REFUND_REQUEST = r'(?:(?:re)?confirm|verify|check|advise|tell|inform|ensure|let|provide|send|share|give)\b'
_REFUND_MODIFIERS = r'(?:(?:please|kindly|just|simply|also|again|now|do|[a-z]+ly)\s+)*'
_REFUND_ASK = (r'(?:ask(?:s|ed|ing)?|request(?:s|ed|ing)?|need(?:s|ed|ing)?|want(?:s|ed|ing)?'
               r'|requir(?:e[sd]?|ing)|seek(?:s|ing)?|sought)')
REFUND_REQUEST_WORD = re.compile(rf'\b{_REFUND_ASK}\b', re.I)
REFUND_PROOF_NOUN = re.compile(r'\b(?:confirmations?|verification|proof|evidence|assurance)\b', re.I)
_REFUND_CREDIT_FOLLOW = (r'\s+(?:to\s+)?(?:(?:already|[a-z]+ly)\s+)*'
                         r'(?:(?:be|have\s+been)\s+)?(?:(?:already|[a-z]+ly)\s+)*credited\b')
REFUND_PROOF_DEMAND = re.compile(
    r'\b(?:required|needed|requested|wanted|sought|awaited|necessary|mandatory|essential)\b'
    rf'|\bexpected\b(?!{_REFUND_CREDIT_FOLLOW})', re.I)
REFUND_QUERY = re.compile(
    rf'(?:^|[\n.!?;:,])\s*{_REFUND_MODIFIERS}(?:(?:am|is|are|was|were|do|does|did|has|have|had|can|could|may|might|will|would|shall|should|who|what|when|where|why|how|which)\b|{_REFUND_REQUEST})'
    rf'|\b(?:please|kindly)\s+{_REFUND_MODIFIERS}(?:{_REFUND_REQUEST})'
    r'|\bwhether\b|\b(?:confirm|check|know|advise|ask(?:s|ing)?|wonder(?:s|ing)?)\s+if\b'
    rf'|\b{_REFUND_ASK}\s+(?:to\b|(?:(?:that|for)\s+)?(?:i|we|you|he|she|they|me|us|him|her|them)\b'
    r'|(?:for\s+)?(?:(?:a|the|your|written)\s+)*confirmations?\b)'
    r'|\b(?:asked|requested|required)\s+to\s+(?:confirm|verify|check)\b', re.I)
REFUND_UNCERTAIN = re.compile(
    r'\b(?:if|unless|until|pending|provided|providing|assuming|tomorrow|later|soon)\b'
    r'|\b(?:in\s+case|as\s+long\s+as|so\s+long\s+as|subject\s+to|next\s+(?:day|week|month|year))\b', re.I)
REFUND_TIMING = re.compile(r'\b(?:once|when|before|after|upon)\b', re.I)
REFUND_PAST_PREFIX = re.compile(
    r'^\s*(?:(?:after|before|upon)\s+(?:the\s+)?(?:approval|cutoff)'
    r'|(?:after|before|once|when)\s+(?:the\s+)?approval\s+(?:was|has been|had been)\s+(?:received|granted))\s*,\s*', re.I)
REFUND_FUTURE = re.compile(
    r'\b(?:will|would|shall|should|may|might|could|can(?!\s+confirm\b)|expect(?:s|ed|ing)?|hop(?:e[sd]?|ing)|plan(?:s|ned|ning)?|'
    r'anticipat(?:e|es|ed|ing)|intend(?:s|ed|ing)?|aim(?:s|ed|ing)?|scheduled|await(?:s|ing)?|'
    r'(?:going|about|trying|attempting)\s+to|working\s+(?:to|on))\b'
    r"|['’](?:ll|d)\b", re.I)
REFUND_PROOF_PENDING = re.compile(
    rf'(?:{REFUND_FUTURE.pattern}|\b(?:must|can|(?:has|have|had|ought)\s+to)\b)'
    rf'(?!{_REFUND_CREDIT_FOLLOW})', re.I)
REFUND_FOLLOWUP = re.compile(
    r'(?<=[.!])\s+(?:have you received (?:it|the refund|the credit)|is there anything else we can help with)\?\s*$', re.I)
QUOTED_REPLY = re.compile(r'^\s*>|^.*Original Message.*$|^.*\bOn\b.+\bwrote:.*$', re.I | re.M)
CARD = re.compile(r'(?<!\d)[2-6](?:[ -]?\d){12,18}(?!\d)')
# A secret is a labelled value: a code of 3-12 digits (grouped or not) a few words after the label, a token
# with a digit right after it ("code", "is", ":"), or anything assigned to a password. The match is removed.
_LABEL = (r'(?:otp|one[- ]time (?:pass)?code|verification code|security code|passcode|password|passwd|pwd'
          r'|cvv|cvc|pin)')
LABELLED = re.compile(
    rf'\b{_LABEL}\b(?:\s*(?:[:=#-]|\b[a-z]+\b)){{0,3}}\s*\d(?:[ -]?\d){{2,11}}(?!\w)'
    rf'|\b{_LABEL}\b(?:\s*(?:code|number|no\.?|is|was|[:=#-])){{0,3}}\s*\S*\d\S*'
    r'|\b(?:password|passwd|passcode|pwd)\b\s*(?:(?:is|was)\s*)?[:=]\s*\S+', re.I)


class CaseError(Exception):
    def __init__(self, message, tag='OPERATION_FAILED'):
        super().__init__(message)
        self.tag = tag


_LOG_EVENTS = contextvars.ContextVar('money_cases_events', default=None)
_CLI_WATCHDOG = contextvars.ContextVar('money_cases_watchdog', default=False)


class LogTimeout(BaseException):
    # Bypass the shared logger's Exception handlers so one slow write ends the entire flush.
    pass


def record_event(name, **values):
    # Nested case changes can run under the question book's lock. Only queue facts here;
    # the outer operation calls the logger after all its books have been released.
    try:
        pending = _LOG_EVENTS.get()
        if pending is not None:
            pending.append((name, values))
    except Exception:
        pass


def log_scope(fn):
    @functools.wraps(fn)
    def wrapped(*args, **kwargs):
        if _LOG_EVENTS.get() is not None:
            return fn(*args, **kwargs)
        events = []
        token = _LOG_EVENTS.set(events)
        try:
            return fn(*args, **kwargs)
        finally:
            _LOG_EVENTS.reset(token)
            try:
                remaining = signal.getitimer(signal.ITIMER_REAL)[0]
                # An earlier caller deadline uses an Exception that the logger could swallow.
                # Leave that timer alone and drop diagnostics when it is already near expiry.
                if not remaining or remaining > 0.25:
                    with within(time.time() + 0.25, LogTimeout()):
                        for name, values in events:
                            try:
                                toollog.emit('money-cases', name, **values)
                            except Exception:
                                pass
            except (LogTimeout, Exception):
                pass
    return wrapped


def case_operation(name):
    def decorate(fn):
        @log_scope
        @functools.wraps(fn)
        def wrapped(data, case_id, *args, **kwargs):
            try:
                return fn(data, case_id, *args, **kwargs)
            except Exception as exc:
                record_event(name, kind='error', ok=False, ids={'caseId': case_id},
                             error=getattr(exc, 'tag', 'OPERATION_FAILED'))
                raise
        return wrapped
    return decorate


def record_closed(case, at):
    try:
        opened = moment(case.get('opened'))
        age = max(0, ((at or now_dubai()) - opened).days) if opened else 0
        record_event('case.close', ok=True, ids={'caseId': case['id']},
                     props={'kind': case.get('kind', 'charge'), 'ageDays': age})
    except Exception:
        pass


def log_ask(fn):
    @log_scope
    @functools.wraps(fn)
    def wrapped(*args, **kwargs):
        try:
            result = fn(*args, **kwargs)
        except Exception:
            record_event('question.ask', kind='error', ok=False, error='OPERATION_FAILED',
                         props={'outcome': 'failed'})
            raise
        outcome = {0: 'ask_now', DONT_ASK: 'dont_ask', 4: 'unverified'}.get(result[0], 'failed')
        record_event('question.ask', kind='error' if result[0] == 4 else 'event',
                     ok=result[0] in (0, DONT_ASK), props={'outcome': outcome},
                     error='OPERATION_FAILED' if result[0] == 4 else None)
        return result
    return wrapped


def log_cli(fn):
    @log_scope
    @functools.wraps(fn)
    def logged(*args, **kwargs):
        record_event('cmd.start')
        try:
            result = fn(*args, **kwargs)
        except BaseException:
            record_event('cmd.end', ok=False)
            raise
        record_event('cmd.end', ok=result == 0)
        return result

    @functools.wraps(fn)
    def wrapped(*args, **kwargs):
        token = _CLI_WATCHDOG.set(False)
        try:
            return logged(*args, **kwargs)
        finally:
            if _CLI_WATCHDOG.get():
                faulthandler.cancel_dump_traceback_later()
            _CLI_WATCHDOG.reset(token)
    return wrapped


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
    # Generic rules see complete quoted values before the legacy patterns can split them.
    text = redact_credentials(text)
    text = re.sub(r'\b' + _LABEL + r'\b(?:' + SEP + r'|[^\S\n]+)\[redacted\]', '[secret removed]', text, flags=re.I)
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


within = charges.within


def lock_wait(deadline):
    if deadline is None:
        return 10
    if time.time() >= deadline:
        raise CheckTimeout('out of time; the rest next check')
    return max(1, min(10, int(deadline - time.time())))


def now_dubai():
    return dt.datetime.now(TZ)


def stamp(t=None):
    return (t or now_dubai()).isoformat(timespec='auto')


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


def due_of(case):
    """Display dates use due when set; ping scheduling still uses deadline_of."""
    try:
        return parse_time(case.get('due') or case['deadline'])
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
KINDS = ('charge', 'hold', 'payment_deadline', 'autopay_expected', 'charge_unconfirmed')
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
    if not case.get('amount') or not case.get('currency'):
        return None
    amount = format(Decimal(str(case['amount'])).normalize(), 'f')
    return (' '.join(str(case['merchant']).split()).lower(), amount, str(case['currency']).upper(),
            case.get('charged') or case['opened'][:10])


def active(row):
    return row.get('status') in ('open', 'awaiting_answer')


def merge_state(case, incoming, now):
    """An observation may tighten a deadline state without erasing its evidence."""
    if not re.search(r'\boverdue\b', incoming, re.I) or re.search(r'\b(?:not|no longer) overdue\b', incoming, re.I):
        return
    line = re.search(r'OVERDUE since [^;\n]+', incoming, re.I)
    line = line.group(0) if line else incoming
    if line not in [h['text'] for h in case.get('history', [])]:
        case['history'].append({'at': stamp(now), 'text': line})
    case.update(state=incoming, urgency='overdue', updated=stamp(now))


def note_purchase(data, merchant, amount, currency, card, asked_by, thread, invoice='', now=None):
    now = now or now_dubai()
    if asked_by not in ('owner', 'moni'):
        raise CaseError('asked-by must be owner or moni')
    entry = dict(merchant=check_text('merchant', merchant), amount=check_amount(amount),
                 currency=check_currency(currency), card=last4_arg('card', card), asked_by=asked_by,
                 thread=check_text('thread', thread), invoice=check_text('invoice', invoice, False), at=stamp(now))
    entry['id'] = 'purchase-' + hashlib.sha256(json.dumps(entry, sort_keys=True).encode()).hexdigest()[:16]
    with Locked(data or DATA) as book:
        notes = book.setdefault('purchases', [])
        # Retrying a command in the same payment turn must not create another explanation.
        identity = ('merchant', 'amount', 'currency', 'card', 'asked_by', 'thread', 'invoice')
        old = next((n for n in notes if all(n[k] == entry[k] for k in identity)
                    and abs(parse_time(n['at']) - now) <= dt.timedelta(minutes=15)), None)
        if old:
            return old
        notes.append(entry)
    return entry


def purchase_merchant(merchant):
    key = merchant_key(merchant)
    # ChatGPT receipts and bank descriptors use both product and company names.
    return 'openai' if re.search(r'\b(?:openai|chatgpt)\b', key) else key


def purchase_match(data, charge, at, qid=None):
    if charge['kind'] != 'charge':
        return None
    for note in reversed(load(data).get('purchases', [])):
        if note.get('question') and note['question'] != qid:
            continue
        if (note['card'] == charge['card'] and note['currency'] == charge['currency']
                and Decimal(note['amount']) == Decimal(charge['amount'])
                and purchase_merchant(note['merchant']) == purchase_merchant(charge['merchant'])
                and abs(parse_time(note['at']) - at) <= dt.timedelta(minutes=15)):
            return {'verdict': 'owner', 'why': f"delegated purchase requested by {note['asked_by']}; thread {note['thread']}"
                    + (f"; invoice {note['invoice']}" if note.get('invoice') else ''), 'errors': [], 'purchase': note['id']}
    return None


def bind_purchase(data, result, at, qid):
    if not result.get('purchase'):
        return True
    with Locked(data or DATA) as book:
        note = next(n for n in book['purchases'] if n['id'] == result['purchase'])
        if note.get('question') and note['question'] != qid:
            return False
        note.update(charge_at=stamp(at), question=qid)
    return True


def receipt_for_question(data, charge, qid=None, questions=None, at=None):
    questions = load_questions(data)['questions'] if questions is None else questions
    current = next((q for q in questions if q['id'] == qid), None)
    current = current or (dict(charge, at=stamp(at)) if at is not None else None)
    # Descriptor variants of one alert may have different question IDs. Only
    # different transactions, including settled ones, compete for a receipt.
    rivals = [q for q in questions if q['id'] != qid and q.get('kind') == 'charge'
              and q['currency'] == charge['currency'] and Decimal(q['amount']) == Decimal(charge['amount'])
              and (not current or not moment(q.get('at')) or not alert_alias(current, q))]

    def accepts(row, text):
        received = dt.datetime.fromtimestamp(row['ts'], TZ)
        for other in rivals:
            explained = other.get('explanation') or {}
            if row.get('id') is not None and explained.get('msgs') == row['id']:
                return False
            observed = moment(other.get('at'))
            if observed is None:
                continue
            named = any(re.search(r'\b' + re.escape(word) + r'\b', text, re.I)
                        for word in charges.words(other['merchant']))
            for matched, is_named in ((named, True), (charges.last_four(other).search(text), False)):
                start, end = charges.receipt_window(observed, received, is_named)
                if matched and start <= received <= end:
                    return False
        return True

    return accepts


def explain_charge(data, charge, at, now, deadline=None, find=None, said=None, qid=None, *, purchases=True):
    if charge['kind'] != 'charge':
        return charges.explain(charge, at, now, deadline, find, said)
    questions = load_questions(data)['questions']
    current = next((q for q in questions if q['id'] == qid), None)
    current = current or dict(charge, at=stamp(at), id=qid)
    rows = [q for q in questions if q['id'] != qid] + [current]
    results = {}
    shared = alert_verdict(alert_verdicts(rows, now), current, now)
    if shared and shared['verdict'] in ('receipt', 'owner', 'subscription'):
        return shared
    stop = deadline if deadline is not None else time.time() + 30
    aliases = [current] + [q for q in questions if q['id'] != qid and alert_alias(current, q)]
    memo = {('orders_cache',): Path(data or DATA) / 'order-details.json'}
    for app in ('noon', 'careem'):
        times = [parse_time(q['at']) - charges.SAME_TIME for q in aliases
                 if charges.order_app(charge_of(q)) == app]
        if times:
            memo[('orders_since', app)] = min(times)
    for q in aliases:
        each = min(stop, time.time() + FOLLOW_EACH)
        try:
            with within(each, LookupTimeout('out of time')):
                purchase = purchase_match(data, charge_of(q), parse_time(q['at']), q['id']) if purchases else None
                result = purchase or charges.explain(
                    charge_of(q), parse_time(q['at']), now, each, find, said,
                    receipt_ok=receipt_for_question(data, charge_of(q), q['id'], rows, parse_time(q['at'])), memo=memo)
        except (charges.Lookup, LookupTimeout) as exc:
            result = {'verdict': 'unverified', 'why': 'sources unreadable; do not ask', 'errors': [str(exc)]}
        if result.get('purchase') and q['id'] != qid:
            note = next(n for n in load(data)['purchases'] if n['id'] == result['purchase'])
            if note.get('question') == q['id']:
                result = {k: v for k, v in result.items() if k != 'purchase'}
        results[q['id']] = result
        shared = alert_verdict(alert_verdicts(rows, now, results), current, now)
        if shared and shared['verdict'] in ('receipt', 'owner', 'subscription'):
            break
    return shared


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
    if key is None:
        return []
    return [c['id'] for c in cases
            if c.get('merchant') != UNMATCHED and c.get('kind', 'charge') == kind and charge_key(c) == key]


def corroborate_in(book, case_id, text, at=None):
    """Note that another channel saw an already-recorded charge. Caller holds the lock."""
    case = find(book, case_id)
    if not active(case):
        raise CaseError(f'case {case_id!r} is closed; reopen it first')
    case['updated'] = stamp(at)
    case['history'].append({'at': stamp(at), 'text': text})
    return case


@case_operation('case.corroborate')
def corroborate(data, case_id, merchant, amount, currency, charged, kind, observation, at=None):
    """Record that another channel (say SMS after mail) saw the same charge. Counts it once.

    Refuses unless the charge matches the case exactly, so a corroboration can never merge two charges."""
    candidate = {'merchant': check_text('merchant', merchant), 'amount': check_amount(amount),
                 'currency': check_currency(currency), 'charged': check_charged(charged), 'kind': kind}
    with Locked(data) as book:
        case = find(book, case_id)
        if case.get('merchant') == UNMATCHED or charge_key(case) != charge_key(candidate) \
                or case.get('kind', 'charge') != kind:
            raise CaseError(f'{case_id!r} is not this charge (merchant, amount, currency, day or kind differ)',
                            tag='CORROBORATE_MISMATCH')
        corroborate_in(book, case_id, 'seen again: ' + check_text('observation', observation), at)
        merge_state(case, observation, at)
    record_event('case.corroborate', ok=True, ids={'caseId': case_id})
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
    """Start the reminder clock at his last answer or the latest returning merchant risk.

    A --because reason is recorded but is not an answer: it can come from a process, not from him."""
    owned = [m for m in (moment(h.get('at')) for h in case.get('history', []) if h.get('owner')) if m]
    cycle_started = moment(case.get('merchant_card_cycle_started'))
    if cycle_started:
        owned.append(cycle_started)
    return max(owned) if owned else moment(case['opened'])


def money(case):
    if case.get('kind') == 'merchant_card':
        return 'saved card'
    if not case.get('amount') or not case.get('currency'):
        return 'amount unknown'
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


if os.environ.get("WATCH_ATTEMPT"):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "helpers"))
    from watch_admission import admitted_check
else:
    def admitted_check(fn):
        return fn


@admitted_check
def write_json(path, obj, timing=None):
    return atomic_write_json(path, obj, timing)


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


SUB_FIELDS = ('merchant', 'last4', 'amount', 'currency', 'cadence', 'next_renewal', 'account', 'status')
SUB_STATUSES = ('active', 'needs card update', 'cancelled')


def subscription(values):
    row = {key: check_text(key, values.get(key, ''), key == 'merchant') for key in SUB_FIELDS}
    if not sub_merchant(row['merchant']):
        raise CaseError('merchant needs letters or digits')
    if row['last4']:
        last4_arg('card', row['last4'])
    if row['amount']:
        row['amount'] = check_amount(row['amount'])
    if row['currency']:
        row['currency'] = check_currency(row['currency'])
    if row['cadence'] not in ('', 'monthly', 'yearly'):
        raise CaseError('cadence must be monthly, yearly or blank')
    if row['next_renewal']:
        check_charged(row['next_renewal'])
    row['status'] = row['status'] or 'active'
    if row['status'] not in SUB_STATUSES:
        raise CaseError('status must be active, needs card update or cancelled')
    return row


def load_subscriptions(data=None):
    book = read_json((data or DATA) / 'subscriptions.json', {'version': 1, 'subscriptions': []})
    if not isinstance(book, dict) or not isinstance(book.get('subscriptions'), list):
        raise CaseError('subscriptions.json is not a subscriptions file')
    ids = set()
    for row in book['subscriptions']:
        if not isinstance(row, dict) or not ID.fullmatch(str(row.get('id', ''))) or row['id'] in ids:
            raise CaseError('subscriptions.json has an invalid or duplicate id')
        row.update(subscription(row))
        ids.add(row['id'])
    return book


def sub_change(data, sid, changes, operation='edit'):
    check_secret('subscription id', sid)
    if not ID.fullmatch(sid):
        raise CaseError('subscription id must be 1-48 lowercase letters, digits or hyphens')
    with Locked(data, 'subscriptions') as book:
        row = next((s for s in book['subscriptions'] if s['id'] == sid), None)
        if (operation == 'add') == bool(row):
            raise CaseError('subscription already exists' if row else 'subscription not found')
        if operation == 'remove':
            book['subscriptions'].remove(row)
            return row
        updated = subscription({**(row or {}), **changes})
        if row:
            reset_anchor = any(updated[k] != row.get(k) for k in ('next_renewal', 'cadence'))
            row.update(updated)
            if reset_anchor:
                row.pop('anchor_day', None)
        else:
            row = {'id': sid, **updated}
            book['subscriptions'].append(row)
    return row


def sub_merchant(name):
    # Only punctuation/case aliases; shared words such as Google must not match Google Pro.
    return re.sub(r'[\W_]', '', name.casefold())


def renewal_alias(name, domain):
    neutral = {'notifications', 'notification', 'mail', 'email', 'billing', 'alerts', 'alert',
               'noreply', 'support', 'updates', 'accounts', 'account', 'co', 'com', 'org', 'net', 'gov', 'edu', 'ac'}
    key = re.sub(r'[^a-z0-9]', '', name.lower())
    return key and key not in neutral and key in {
        re.sub(r'[^a-z0-9]', '', label) for label in domain.split('.')[:-1]}


def learn_subscription(data, notice, end=None):
    learned = subscription({'merchant': notice['merchant'], 'last4': notice['last4'],
                            'amount': notice['amount'], 'currency': notice['currency'],
                            'next_renewal': notice['date'], 'cadence': notice.get('cadence', '')})
    identity = check_text('identity', notice.get('identity', ''), False)
    try:
        with Locked(data, 'subscriptions', wait=lock_wait(end)) as book:
            candidates = [s for s in book['subscriptions'] if identity and s.get('identity') == identity
                          and s['last4'] in ('', learned['last4'])]
            if not candidates:
                candidates = [s for s in book['subscriptions'] if sub_merchant(s['merchant']) == sub_merchant(learned['merchant'])
                              and s['last4'] in ('', learned['last4']) and s.get('identity', '') in ('', identity)]
            if not candidates:
                candidates = [s for s in book['subscriptions'] if s['last4'] in ('', learned['last4']) and (
                    (not identity and s.get('identity') and renewal_alias(learned['merchant'], s['identity'])) or
                    (identity and not s.get('identity') and renewal_alias(s['merchant'], identity)))]
            if len(candidates) > 1:
                raise _DryRun
            row = candidates[0] if candidates else None
            if row and (row['status'] == 'cancelled' or row.get('next_renewal', '') > learned['next_renewal']):
                raise _DryRun
            if row:
                changes = {k: v for k, v in learned.items() if v and k not in ('merchant', 'account', 'status')}
                if all(row.get(k) == v for k, v in changes.items()) and row.get('identity', '') == (identity or row.get('identity', '')):
                    raise _DryRun
                if any(k in changes and row.get(k) != changes[k] for k in ('next_renewal', 'cadence')):
                    row.pop('anchor_day', None)
                row.update(changes)
            else:
                sid = 'sub-' + hashlib.sha256((sub_merchant(learned['merchant']) + ':' + learned['last4'] + ':' + identity).encode()).hexdigest()[:16]
                row = {'id': sid, **learned}
                book['subscriptions'].append(row)
            row['identity'] = identity or row.get('identity', '')
    except _DryRun:
        pass


def sub_next(date, cadence, anchor=None):
    date = dt.date.fromisoformat(date)
    year, month = date.year, date.month
    if cadence == 'yearly':
        year += 1
    else:
        year, month = year + month // 12, month % 12 + 1
    return dt.date(year, month, min(anchor or date.day, calendar.monthrange(year, month)[1])).isoformat()


def subscription_match(data, charge, at, record=False, end=None):
    if charge['kind'] != 'charge' or charge.get('pending'):
        return None
    date = at.astimezone(TZ).date()

    def matches(book):
        out = []
        for row in book['subscriptions']:
            if row['status'] == 'cancelled' or not all(row.get(k) for k in ('last4', 'amount', 'currency', 'cadence', 'next_renewal')):
                continue
            if sub_merchant(row['merchant']) != sub_merchant(charge['merchant']) or row['last4'] != charge['card'] or row['currency'] != charge['currency']:
                continue
            expected, amount = Decimal(row['amount']), Decimal(charge['amount'])
            if expected <= 0 or abs(amount - expected) > expected * Decimal('.05'):
                continue
            due = dt.date.fromisoformat(row['next_renewal'])
            if abs((date - due).days) <= 3:
                out.append((row, due.isoformat()))
        return out

    if not record:
        found = matches(load_subscriptions(data))
    else:
        try:
            with Locked(data, 'subscriptions', wait=lock_wait(end)) as book:
                found = matches(book)
                if len(found) != 1:
                    raise _DryRun
                row, due = found[0]
                row['anchor_day'] = row.get('anchor_day') or dt.date.fromisoformat(due).day
                row['next_renewal'] = sub_next(due, row['cadence'], row['anchor_day'])
        except _DryRun:
            return None
    if len(found) != 1:
        return None
    row, due = found[0]
    return {'verdict': 'subscription', 'why': f"subscription {row['id']} renewal {due}", 'errors': []}


def subscriptions_due(data, now, days=3):
    if days < 0:
        raise CaseError('days must be non-negative')
    return [s for s in load_subscriptions(data)['subscriptions'] if s['status'] != 'cancelled' and s['next_renewal']
            and 0 <= (dt.date.fromisoformat(s['next_renewal']) - now.astimezone(TZ).date()).days <= days]


def subscription_entries(data, now, handled):
    dead = dead_cards(data)
    entries = []
    for row in subscriptions_due(data, now):
        key = f"subs:{sub_merchant(row['merchant'])}:{row['next_renewal']}"
        if key in handled or not (row['last4'] in dead or row['status'] == 'needs card update'):
            continue
        entries.append((clip(row['merchant'], 100), [(key, f"renews {row['next_renewal']}; card {row['last4'] or 'unknown'} needs update")],
                        f"money-cases subs list ({row['id']}); move to a live card or cancel", None))
        handled = {**handled, key: stamp(now)}
    return entries


def sweep_dead_card(data, last4, now=None, alerts=None, end=None):
    now = now or now_dubai()
    start = now - dt.timedelta(days=60)
    if alerts is None:
        # Search the existing archive, then parse whole alerts rather than clipped snippets.
        alerts = []
        for hit in charges.search(last4, charges.day(start), until=charges.day(now + dt.timedelta(days=1)), n=1000, deadline=end):
            if hit.get('from_me') or not start.timestamp() <= hit.get('ts', 0) <= now.timestamp():
                continue
            alerts.append({**hit, 'text': charges.alert_text(charges.show(hit, end))})
    groups = {}
    for hit in alerts:
        charge = charges.parse(hit.get('text', ''), hit.get('sender', ''))
        at = dt.datetime.fromtimestamp(hit.get('ts', 0), TZ)
        if not charge or charge['kind'] != 'charge' or charge.get('pending') or charge['card'] != last4 or not start <= at <= now:
            continue
        group = groups.setdefault(sub_merchant(charge['merchant']), [])
        # Copies across SMS/email do not establish a recurring merchant.
        if any(c['amount'] == charge['amount'] and c['currency'] == charge['currency'] and abs((at - t).total_seconds()) <= 900 for t, c in group):
            continue
        group.append((at, charge))
    flagged = []
    try:
        with Locked(data, 'subscriptions', wait=lock_wait(end)) as book:
            before = [dict(s) for s in book['subscriptions']]
            for name, group in groups.items():
                rows = [s for s in book['subscriptions'] if sub_merchant(s['merchant']) == name and s['last4'] == last4 and s['status'] != 'cancelled']
                if not rows and any(sub_merchant(s['merchant']) == name and s['last4'] == last4 for s in book['subscriptions']):
                    continue
                if not rows and len(group) < 2:
                    continue
                _, charge = max(group, key=lambda x: x[0])
                if not rows:
                    sid = 'sub-' + hashlib.sha256((name + ':' + last4).encode()).hexdigest()[:16]
                    # Repetition is evidence for a card update, not proof of cadence or a future date.
                    row = {'id': sid, **subscription({'merchant': charge['merchant'], 'last4': last4,
                           'amount': charge['amount'], 'currency': charge['currency']})}
                    book['subscriptions'].append(row)
                    rows = [row]
                for row in rows:
                    row['status'] = 'needs card update'
            for row in book['subscriptions']:
                if row['last4'] == last4 and row['status'] != 'cancelled':
                    row['status'] = 'needs card update'
                    flagged.append(dict(row))
            if before == book['subscriptions']:
                raise _DryRun
    except _DryRun:
        pass
    handled_merchants = set()
    for row in sorted(flagged, key=lambda s: (s['next_renewal'] or '9999-12-31', s['id'])):
        merchant = sub_merchant(row['merchant'])
        if merchant in handled_merchants:
            continue
        handled_merchants.add(merchant)
        references = {'subscription:' + s['id'] for s in flagged if sub_merchant(s['merchant']) == merchant}
        if any(c.get('reference') in references or (c.get('subscription_card') == last4 and
               sub_merchant(c['merchant']) == merchant) for c in load(data)['cases']):
            continue
        if row['next_renewal'] and row['amount'] and row['currency']:
            case = renewal_case(data, {'merchant': row['merchant'], 'last4': last4, 'date': row['next_renewal'],
                                      'amount': row['amount'], 'currency': row['currency'], 'identity': row.get('identity', '')},
                                'subscription:' + row['id'], now, end=end, include_existing=True)
            if case:
                with Locked(data, wait=lock_wait(end)) as book:
                    find(book, case['id'])['subscription_card'] = last4
        else:
            # No guessed renewal date: make an actionable case due today until the date is confirmed.
            cid = 'subs-card-' + hashlib.sha256((sub_merchant(row['merchant']) + ':' + last4).encode()).hexdigest()[:20]
            try:
                with Locked(data, wait=lock_wait(end)) as book:
                    if any(c['id'] == cid for c in book['cases']):
                        raise _DryRun
                    book['cases'].append({'id': cid, 'kind': 'charge', 'subscription_card': last4,
                        'merchant': row['merchant'], 'amount': row['amount'],
                        'currency': row['currency'], 'charged': now.date().isoformat(), 'reference': 'subscription:' + row['id'],
                        'state': f'subscription uses dead card {last4}; renewal details incomplete',
                        'next': 'confirm renewal details and move to a live card or cancel', 'deadline': now.date().isoformat(),
                        'who': 'Abdullah', 'why': '', 'watchers': [], 'status': 'open', 'rev': 0, 'cycle': 0,
                        'opened': stamp(now), 'updated': stamp(now), 'closed': None, 'outcome': None,
                        'history': [{'at': stamp(now), 'text': 'opened from dead-card subscription sweep'}]})
            except _DryRun:
                pass
    return flagged


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
            self.book = {'cases': load, 'questions': load_questions, 'cards': load_cards,
                         'subscriptions': load_subscriptions}[self.name](self.data)
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


@case_operation('case.open')
def add(data, case_id, merchant, amount, currency, state, next_action, deadline, who,
        reference='', why='', watchers=(), at=None, root=None, charged='', kind='charge', unmatched=False,
        repeat=None, distinct=False, end=None, due=None, alert_at=None):
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
        'watchers': [check_watcher(w, root) for w in dict.fromkeys(watchers)], 'status': 'open', 'asks': [],
        'rev': 0, 'cycle': 0,
        'opened': stamp(at), 'updated': stamp(at), 'closed': None, 'outcome': None,
        'history': [{'at': stamp(at), 'text': 'opened'}],
    }
    if due is not None:
        case['due'] = check_deadline(due)
    if alert_at is not None:
        case['alert_at'] = stamp(parse_time(alert_at))
    with Locked(data, wait=lock_wait(end)) as book:
        if any(c['id'] == case_id for c in book['cases']):
            raise CaseError(f'case {case_id!r} already exists')
        candidates = same_charge(book['cases'], case)
        if candidates and not (repeat or distinct):
            raise CaseError(f'a charge with this merchant, amount, currency and day is already recorded as '
                            f'{", ".join(map(repr, candidates))}. Say --repeat ID if it is the same charge, or '
                            f'--distinct if it is a second transaction; nothing was added.',
                            tag='CHARGE_DUPLICATE_CANDIDATE')
        if repeat:
            if repeat not in candidates:
                raise CaseError(f'--repeat {repeat!r} is not a charge matching this one')
            if distinct:
                raise CaseError('give --repeat or --distinct, not both')
            corroborate_in(book, repeat, f"seen again: {check_text('reference', reference, False) or 'repeat'}", at)
            merge_state(find(book, repeat), state, at)
            case = find(book, repeat)
        else:
            book['cases'].append(case)
    record_event('case.corroborate' if repeat else 'case.open', ok=True, ids={'caseId': case['id']},
                 props={} if repeat else {'kind': case.get('kind', 'charge'), 'unmatched': unmatched})
    return case


@case_operation('case.update')
def update(data, case_id, changes, add_watchers=(), drop_watchers=(), note='', at=None, root=None,
           because='', reply='', source='', cascade_questions=True, refund_mail=None, expected_updated=None):
    checks = {'amount': check_amount, 'currency': check_currency, 'deadline': check_deadline, 'due': check_deadline}
    with Locked(data) as book:
        case = find(book, case_id)
        # Archive reads happen outside the lock; never overwrite a case edited during the lookup.
        if expected_updated is not None and case['updated'] != expected_updated:
            raise _DryRun
        before = {key: case.get(key) for key in FIELDS}
        before['watchers'] = list(case['watchers'])
        old_state = case['state']
        said = []
        moved = False
        due_moved = False
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
                elif field == 'due':
                    due_moved = True
        because = check_text('because', because, False)
        reply = check_text('reply', reply, False)
        source = check_source(source) if source else ''
        if moved and not (source or reply):
            raise CaseError('deadline changes need --source (mail:, sms:, imessage: or statement:) or --reply (his reply id); nothing was changed',
                            tag='DEADLINE_REASON_REQUIRED')
        if due_moved and not (because or reply):
            raise CaseError('due changes need --because or --reply; nothing was changed', tag='DEADLINE_REASON_REQUIRED')
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
        if refund_mail is not None:
            case['refund_mail'] = refund_mail
        entry = {'at': stamp(at), 'text': '; '.join(said)}
        if source:
            entry['source'] = source
        if source.startswith('statement:') and changes.get('amount') is not None:
            case.update(statement_balance=case['amount'], statement_at=stamp(at))
        if reply and active(case):
            case['status'] = 'open'
            case.pop('queued', None)
            case['answered_cycle'] = case.get('cycle', 0)
        if reply:
            # Only his reply id is an owner answer; a --because reason alone is recorded, not answered.
            entry['owner'] = True
        case['history'].append(entry)
        if changes.get('state'):
            if re.search(r'\boverdue\b', old_state, re.I) and not (reply or source):
                case['state'] = old_state
            if (reply or source) and not re.search(r'\boverdue\b', changes['state'], re.I):
                case.pop('urgency', None)
            merge_state(case, changes['state'], at)
        changed_fields = sorted(key for key in (*FIELDS, 'watchers') if before.get(key) != case.get(key))
    record_event('case.update', ok=True, ids={'caseId': case_id},
                 props={'fields': ','.join(changed_fields), 'deadlineMoved': moved, 'answered': bool(reply)})
    if reply and cascade_questions:
        with Locked(data, 'questions') as questions:
            for q in questions['questions']:
                if linked_case(q) == case_id:
                    recover_case(data, q, [case])
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
                if not active(case):
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
                          r'(?:auto[ -]?)?(?P<verb>renew(?:ed|s|al)?|charg(?:e|ed)|bill(?:ed)?|debit(?:ed)?)\b', re.I)
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
            for match in negative.finditer(part):
                if re.fullmatch(r'charg(?:e|ed)|bill(?:ed)?|debit(?:ed)?', match['verb'], re.I):
                    tail = clause[lo + match.end():].lstrip()
                    amount = payments.MONEY.match(tail)
                    if amount:
                        tail = tail[amount.end():]
                    date_ref = (r'(?:then|(?:this|that) date|(?:your|the|next)(?: next)? '
                                r'(?:renewal|billing|payment) (?:date|cycle|period)|today|tomorrow|'
                                r'next (?:week|month|year)|' + RENEWAL_DATE.pattern + r')')
                    # "Not charged until renewal" schedules billing; it doesn't
                    # cancel the renewal. Only qualify this billing assertion.
                    timing = re.match(r'\s*(?:(?:again|at all|anything|any amount)\s*)?(?P<comma>,?)\s*'
                                      r'(?:until|before|prior to)\s+' + date_ref + r'(?=$|[\s,.;!?])', tail, re.I)
                    if timing:
                        # After a comma, a date followed by another action can start
                        # independent advice ("before tomorrow please read...").
                        if not timing['comma'] or not re.search(r'\w', tail[timing.end():]):
                            continue
                    if re.fullmatch(r'\s*(?:until|before|prior to)\s+' + date_ref +
                                    r'\s*,?\s*(?:you|we|your card|your account)\s+'
                                    r'(?:(?:will|are|is|do|does|have|has)\s+)?', clause[:lo + match.start()], re.I):
                        continue
                assertions.append((lo + match.start(), lo + match.end(), lo))
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
    cadences = set()
    if re.search(r'\bmonthly\b|\bevery month\b', text, re.I):
        cadences.add('monthly')
    if re.search(r'\b(?:yearly|annual|annually)\b|\bevery year\b', text, re.I):
        cadences.add('yearly')
    if len(cadences) == 1:
        notice['cadence'] = cadences.pop()
    if domain:
        notice['identity'] = domain
    return notice


def renewal_case(data, notice, source, now=None, end=None, include_existing=False):
    data, now = data or DATA, now or now_dubai()
    learn_subscription(data, notice, end=end)
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
                aliases = [c for c in book['cases'] if c.get('renewal_date') == due and (
                    (not identity and c.get('renewal_identity') and renewal_alias(merchant, c['renewal_identity'])) or
                    (identity and not c.get('renewal_identity') and renewal_alias(c['merchant'], identity)))]
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


def merchant_dead():
    """Read the shared registry; a failed/old CLI must never resolve existing cases."""
    try:
        result = subprocess.run([os.environ.get('CARD_STATUS_CLI', 'card-status'), 'merchant', 'dead', '--json'],
                                capture_output=True, text=True, timeout=4, check=True)
        rows = json.loads(result.stdout)
        if not isinstance(rows, list):
            raise ValueError()
        keys = set()
        for row in rows:
            key = check_text('merchant key', row['key'])
            check_text('merchant', row['merchant'])
            if key in keys or key != key.casefold() or not row['dead_cards']:
                raise ValueError()
            keys.add(key)
            if row.get('next_charge') is not None:
                if not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', row['next_charge']):
                    raise ValueError()
                check_charged(row['next_charge'])
            for card in row['dead_cards']:
                last4_arg('saved card', card['last4'])
                if card['state'] not in ('cancelled', 'declined'):
                    raise ValueError()
        return rows
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError, CaseError):
        raise CaseError('card-status merchant dead unavailable or invalid; merchant cases unchanged')


def reconcile_merchants(data=None, now=None, end=None):
    rows = merchant_dead()
    now = now or now_dubai()
    active = {row['key']: row for row in rows}
    if not rows and not any(c.get('merchant_card_key') and not c.get('merchant_card_resolved')
                            for c in load(data)['cases']):
        return
    with Locked(data or DATA, wait=lock_wait(end)) as book:
        for row in rows:
            key = row['key']
            cards = sorted({(c['last4'], c['state']) for c in row['dead_cards']})
            fingerprint = json.dumps([cards, row.get('next_charge')], separators=(',', ':'))
            state = row['merchant'] + ' still holds ' + ', '.join(f'{state} card ••{last4}' for last4, state in cards)
            if row.get('next_charge'):
                state += '; next charge ' + row['next_charge']
            existing = next((c for c in book['cases'] if c.get('merchant_card_key') == key), None)
            if not existing:
                cid = 'merchant-card-' + hashlib.sha256(key.encode()).hexdigest()[:24]
                if any(c['id'] == cid for c in book['cases']):
                    raise CaseError('merchant case id already used; review by hand')
                existing = {'id': cid, 'kind': 'merchant_card', 'merchant_card_key': key,
                            'merchant': row['merchant'], 'merchant_card_fingerprint': fingerprint,
                            'amount': None, 'currency': None,
                            'reference': 'card-status merchant dead', 'owner': 'abdullah',
                            'next': 'update the saved payment method, then record it with card-status merchant set',
                            'deadline': row.get('next_charge') or now.date().isoformat(),
                            'who': 'Abdullah', 'why': '', 'watchers': [], 'status': 'open', 'rev': 0, 'cycle': 0,
                            'opened': stamp(now), 'updated': stamp(now), 'closed': None, 'outcome': None,
                            'state': state, 'history': [{'at': stamp(now), 'text': 'opened from saved merchant cards'}]}
                book['cases'].append(existing)
            elif existing.get('merchant_card_fingerprint') != fingerprint or existing.get('merchant_card_resolved'):
                if existing['status'] == 'closed':
                    existing.update(status='open', closed=None, outcome=None, cycle=existing.get('cycle', 0) + 1,
                                    rev=existing.get('rev', 0) + 1, merchant_card_cycle_started=stamp(now))
                if row.get('next_charge') and row['next_charge'] != existing['deadline']:
                    existing.update(deadline=row['next_charge'], rev=existing.get('rev', 0) + 1)
                existing.update(state=state, updated=stamp(now), merchant_card_resolved=False,
                                merchant_card_fingerprint=fingerprint)
                existing['history'].append({'at': stamp(now), 'text': 'saved merchant cards changed'})
        for case in book['cases']:
            if (case.get('merchant_card_key') and case['merchant_card_key'] not in active
                    and not case.get('merchant_card_resolved')):
                if case['status'] in ('open', 'awaiting_answer'):
                    payment_close(case, 'merchant no longer holds a cancelled or declined card', now)
                else:
                    case['history'].append({'at': stamp(now), 'text': 'dead saved card no longer present'})
                case['merchant_card_resolved'] = True


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
            if active(case) and parse_time(case['opened']) <= observed <= deadline_of(case) + dt.timedelta(days=7):
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
        expected = [c for c in matches if c.get('kind') == 'autopay_expected' and active(c) and
                    -dt.timedelta(hours=1) <= observed - parse_time(c.get('due') or c['deadline']) <= dt.timedelta(days=1)]
        if expected:
            parent = min(expected, key=lambda c: abs(observed - parse_time(c.get('due') or c['deadline'])))
            case['autopay_case'] = parent['id']
            previous = next((c for c in matches if c['id'] == parent.get('payment_case')), None)
            if previous and active(previous) and previous.get('deadline_basis') == 'scheduled_fallback' and notice.get('deadline_basis') != 'scheduled_fallback':
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
    candidates = [c for c in load(data)['cases'] if c.get('kind') == 'autopay_expected' and active(c)
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
                existing = next((c for c in book['cases'] if c.get('kind') == 'payment_deadline' and active(c) and
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


@case_operation('case.close')
def close(data, case_id, outcome, at=None, source=''):
    closed_cases = []
    if case_id.startswith('q-'):
        source, outcome = check_source(source), check_text('outcome', outcome)
        with Locked(data, 'questions') as questions:
            q = find_question(questions, case_id)
            if q['status'] == 'closed':
                raise CaseError(f'question {case_id!r} is already closed')
            if q.get('case'):
                with Locked(data) as book:
                    parent = find(book, q['case'])
                    if active(parent):
                        payment_close(parent, outcome, at)
                        parent['history'][-1]['source'] = source
                        closed_cases.append(parent)
                for case in closed_cases:
                    record_closed(case, at)
                for other in questions['questions']:
                    if linked_case(other) == q['case'] and active(other):
                        settle(other, outcome, source, at or now_dubai())
            settle(q, outcome, source, at or now_dubai())
        return q
    with Locked(data) as book:
        case = find(book, case_id)
        if case['status'] == 'closed':
            raise CaseError(f'case {case_id!r} is already closed')
        outcome = check_text('outcome', outcome)
        source = check_source(source) if source else ''
        if case.get('status') == 'awaiting_answer' and not source:
            raise CaseError('closing an awaiting_answer case needs --source; use answered for his answer')
        case.update(status='closed', closed=stamp(at), outcome=outcome, updated=stamp(at))
        closed_cases.append(case)
        # A pre-auth hold that drops off was released, not refunded.
        word = 'released' if case.get('kind') == 'hold' else 'closed'
        case['history'].append({'at': stamp(at), 'text': f'{word}: {outcome}', 'owner': True, 'source': source})
        if case.get('kind') in ('payment_deadline', 'autopay_expected'):
            notice = {'institution': case['merchant'], 'amount': case['amount'], 'currency': case['currency']}
            for other in book['cases']:
                if active(other) and payment_matches(other, notice) and (
                        other['id'] in (case.get('autopay_case'), case.get('payment_case')) or
                        (deadline_of(other) and deadline_of(case) and
                         abs(deadline_of(other) - deadline_of(case)) <= dt.timedelta(days=1))):
                    payment_close(other, outcome, at, owner=True)
                    closed_cases.append(other)
    for closed_case in closed_cases:
        record_closed(closed_case, at)
    with Locked(data, 'questions') as questions:
        for q in questions['questions']:
            if linked_case(q) == case_id:
                settle(q, outcome, 'case_close', at or now_dubai())
    return case


@case_operation('case.reopen')
def reopen(data, case_id, deadline, note, at=None):
    with Locked(data) as book:
        case = find(book, case_id)
        if active(case):
            raise CaseError(f'case {case_id!r} is open')
        note = check_text('note', note)
        case.pop('queued', None)
        case.pop('refund_mail', None)
        case['asks'] = []
        case.update(status='open', closed=None, outcome=None, deadline=check_deadline(deadline), updated=stamp(at),
                    rev=case.get('rev', 0) + 1, cycle=case.get('cycle', 0) + 1)
        case['history'].append({'at': stamp(at), 'text': 'reopened: ' + note, 'owner': True})
    record_event('case.reopen', ok=True, ids={'caseId': case_id})
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


def is_bill(case):
    if case.get('kind') == 'merchant_card' or case.get('amount') in (None, '') or case.get('currency') in (None, ''):
        return False
    text = ' '.join(str(case.get(k, '')) for k in ('merchant', 'state', 'reference', 'id'))
    return case.get('kind') == 'payment_deadline' or bool(re.search(
        r'\b(?:bill|statement|autopay|premium|repayment)\b', text, re.I))


def overdue_bill(case, now):
    due = deadline_of(case)
    return is_bill(case) and ((due is not None and now >= due) or case.get('urgency') == 'overdue')


def balance_after_credits(case, cases, now):
    """Use the newest recorded statement, then posted same-card credits, including closed refunds."""
    if case.get('kind') == 'merchant_card' or case.get('amount') in (None, '') or case.get('currency') in (None, ''):
        return money(case)
    balance = Decimal(case.get('statement_balance', case['amount']))
    statement_at = moment(case.get('statement_at')) or moment(case['opened'])
    amount_re = re.compile(r'(?P<currency>[A-Z]{3})\s*(?P<amount>\d[\d,]*(?:\.\d{1,2})?)', re.I)
    for h in sorted(case.get('history', []), key=lambda h: h['at']):
        match = re.search(r'statement balance[: ]+([A-Z]{3})\s*([\d,]+(?:\.\d{1,2})?)', h['text'], re.I)
        when = moment(h['at'])
        if match and match[1].upper() == case['currency'] and statement_at <= when <= now:
            balance, statement_at = Decimal(match[2].replace(',', '')), when
    def cards(text):
        return set(re.findall(r'(?:card(?: ending(?: with| in)?)?|ending(?: with| in)?)\s*[*xX• ]*(\d{4})(?!\d)', text, re.I))
    own_cards = {case['card']} if case.get('card') else cards(' '.join(str(case.get(k, '')) for k in ('reference', 'state')))
    credits = []
    for other in cases:
        # Only explicit bank-side credit evidence counts. A refund request or promise does not.
        for h in other.get('history', []):
            text, when = h['text'], moment(h['at'])
            if not when or when > now or not re.search(
                    r'\b(?:refund|credit)\b.*\b(?:landed|posted|credited|received)\b', text, re.I):
                continue
            if re.search(r'\b(?:no|not|never)\s+(?:\w+\s+){0,2}(?:refund|credit|landed|posted|received)\b'
                         r'|\b(?:refund|credit)\b[^.;]*\b(?:not|never|pending|expected)\b', text, re.I):
                continue
            found_cards = cards(text)
            amounts = {(m['currency'].upper(), m['amount'].replace(',', '')) for m in amount_re.finditer(text)}
            amounts = {Decimal(a) for c, a in amounts if c == case['currency']}
            if len(found_cards) == 1 and len(amounts) == 1:
                credits.append((found_cards.pop(), amounts.pop(), when, text, other['id']))
    if not own_cards:
        # Legacy bill rows may name only the bank. Bind only when its recorded credits identify one card.
        bank = next((b for b in ('wio', 'enbd', 'mashreq', 'adcb', 'fab', 'amex')
                     if b in case['merchant'].lower()), None)
        candidates = {card for card, _, _, text, _ in credits if bank and re.search(r'\b' + bank + r'\b', text, re.I)}
        if len(candidates) == 1:
            own_cards = candidates
    postings = {}
    for card, amount, when, text, source in credits:
        identity = (source, card, amount)
        if identity not in postings or when < postings[identity]:
            postings[identity] = when
    for (_, card, amount), when in postings.items():
        if own_cards == {card} and when > statement_at:
            balance -= amount
    return f"{case['currency']} {max(Decimal('0'), balance):,.2f}"


def initial_question_needed(case):
    return not case.get('asks') and case.get('answered_cycle') != case.get('cycle', 0)


def mark_bill_asked(data, keys, now, expected_answers=None):
    ids = {key.split('|')[0] for key in keys if '|bill-ask|' in key or '|initial-ask|' in key or '|payment|deadline' in key
           or ('|ask|' in key and not key.startswith('q|'))}
    if not ids:
        return
    with Locked(data or DATA) as book:
        for c in book['cases']:
            if c['id'] not in ids or not active(c) or any(
                    h.get('owner') and moment(h.get('at')) and moment(h['at']) >= now for h in c.get('history', [])):
                continue
            cid, rev, cycle = c['id'], c.get('rev', 0), c.get('cycle', 0)
            expected = (expected_answers or {}).get(cid, {}).get('answer')
            if expected is not None and expected != answered_at(c).isoformat():
                continue
            current = {f'{cid}|bill-ask|r{rev}|c{cycle}', f'{cid}|r{rev}|c{cycle}|payment|deadline',
                       f'{cid}|ask|{answered_at(c).isoformat()}'}
            if c.get('answered_cycle') != cycle:
                current.add(f'{cid}|initial-ask|c{cycle}')
            if not current.intersection(keys):
                continue
            c['status'] = 'awaiting_answer'
            if not any(a.get('at') == stamp(now) for a in c.setdefault('asks', [])):
                c['asks'].append({'at': stamp(now), 'question': 'money case'})
                c['history'].append({'at': stamp(now), 'text': 'asked; awaiting_answer'})


def attention(cases, now, sent, root=None, since=None, pending=False):
    """(head, items, tail, day) for each open case with pings it hasn't had; items are (key, text) pairs.

    `since` maps a case id to {'answer': <answer time>, 'at': <when its first reminder was delivered>}. The
    two-day clock for the yes/no starts there, so a case with no reminder yet is never asked about."""
    since = since or {}
    entries = []
    for case in cases:
        if not active(case) or case_owner(case) != 'abdullah':
            continue
        # The daily list owns the first ask; an automatic case must not add a
        # deadline prompt while that charge still awaits his answer.
        automatic = bool(case.get('alert_at') and not owner_answered(case))
        if case.get('kind') in ('payment_deadline', 'autopay_expected'):
            continue
        refund = case.get('refund_mail')
        refund_pending = bool(refund and f"{case['id']}|refund|{refund['id']}" not in sent)
        if pending and is_bill(case) and not overdue_bill(case, now) and not refund_pending:
            continue
        deadline = deadline_of(case)
        cid = case['id']
        day_key = f'{cid}|day|{now.date()}'
        # rev changes with every deadline edit, cycle with every reopen, so both re-arm pings.
        rev, cycle = case.get('rev', 0), case.get('cycle', 0)
        # Redact before clipping: a clipped card number would no longer match.
        head = f"- {cid}: {clip(redact(case['merchant']), 80)} {clip(money(case), 40)}"
        if case.get('reference'):
            head += f" (ref {clip(redact(case['reference']), 80)})"
        found = []
        if refund and deadline is not None and moment(refund.get('at')):
            found.append((f"{cid}|refund|{refund['id']}",
                          f"{case['merchant']} mailed {when(moment(refund['at']))} that the refund was processed; "
                          f'dispute step held until {when(deadline)}'))
        if automatic:
            # Refund news can bypass the first-ask suppression without exposing its next-action prompt.
            if refund_pending and found and day_key not in sent:
                entries.append((head, found, '', cid))
            continue
        bill_key = f'{cid}|bill-ask|r{rev}|c{cycle}'
        urgent = overdue_bill(case, now) and bill_key not in sent
        if urgent:
            found.append((bill_key, f"OVERDUE; balance after credits: {balance_after_credits(case, cases, now)}. "
                          'Ask now even if another question is pending'))
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
        if ask_key in sent and not urgent and not refund_pending:
            # The yes/no is out; the case stays quiet until he answers (a new answer time changes the key).
            continue
        found = [(k, t) for k, t in found if k not in sent]
        # The yes/no goes last, so every reminder still pending is sent before the case goes quiet.
        # Its clock starts at the first reminder delivered since his last answer, not at case creation.
        clock = since.get(cid)
        started = moment(clock.get('at')) if clock and clock.get('answer') == answer.isoformat() else None
        # A start only counts when its reminder went out after his answer, not before it.
        if started and started >= answer and now - started >= ASK_AFTER and ask_key not in sent:
            found.append((ask_key, ASK))
        if not found:
            continue
        if day_key in sent and not urgent:
            # At most one reminder per case per day.
            continue
        tail = (f"Next: {clip(redact(case['next']))}. Who: {clip(redact(case['who']), 60)}. "
                f"State: {clip(redact(case['state']))}")
        entries.append((head, found, tail, cid))
    return entries


def case_line(head, texts, tail):
    return redact((head + ': ' if head else '') + '; '.join(texts) + '.' + (f' {tail}' if tail else ''))


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
    """Whether the runner saved this output in its pending delivery or person-chat batch.

    The runner saves the event text before it acks the run, so a match means it will retry
    the event itself. No match and no delivery means the output was lost before acknowledgement."""
    try:
        runner = json.loads((wd / 'state.json').read_text())
        pending = runner.get('pending') or {}
    except (OSError, ValueError, AttributeError):
        return False
    # An outbox from before this field (or an empty one) has no event to match, so it is never owned.
    event = (out.get('event') or '').strip()
    queued = (runner.get('batch') or {}).get('events') or []
    return bool(event) and ((pending.get('event') or '').strip() == event
                            or any(isinstance(item, str) and item.strip() == event for item in queued))


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
        if active(case):
            cid, rev, cycle = case['id'], case.get('rev', 0), case.get('cycle', 0)
            keys += [f'{cid}|r{rev}|c{cycle}|payment|', f'{cid}|r{rev}|soon', f'{cid}|r{rev}|no-deadline', f'{cid}|c{cycle}|', f'{cid}|ask|', f'{cid}|bill-ask|', f'{cid}|initial-ask|']
            keys.append(f'{cid}|refund|')
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
        if near and all(a.get('channel') != chan for a in alerts_of(q)):
            distance = abs(parse_time(q['at']) - at)
            if copy is None or distance < copy[0]:
                copy = (distance, q)
            elif distance == copy[0]:
                copy = (distance, None)
    return copy[1] if copy else None


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
    if item:
        # Distinct bank alerts can share a timestamp; their questions must still have distinct ids.
        base += '|' + item
    q = {'id': 'q-' + hashlib.sha256(base.encode()).hexdigest()[:8], 'kind': charge['kind'],
         'owner': charges.card_owner(charge), 'card': charge['card'], 'currency': charge['currency'], 'amount': charge['amount'],
         'merchant': clip(redact(charge['merchant']), 80), 'pending': bool(charge.get('pending')),
         'mkey': key, 'at': stamp(at), 'subscription_dated': True,
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
    book['questions'] = [q for q in book['questions'] if active(q)
                         or (q.get('status') == 'case' and q.get('by') == 'daily')
                         or (q.get('closed') or '') >= cutoff]


def linked_case(q):
    return q.get('case') or q.get('was_case') or 'charge-' + q['id'][2:]


def unmatched_id(q):
    amount = format(Decimal(check_amount(q['amount'])).normalize(), 'f')
    key = '|'.join((last4_arg('card', q['card']), amount, check_currency(q['currency']),
                    stamp(parse_time(q['at']).astimezone(TZ))))
    return 'unmatched-' + hashlib.sha256(key.encode()).hexdigest()[:16]


def alert_verdicts(questions, now, results=None):
    evidence = {}
    for q in questions:
        if q.get('kind') != 'charge':
            continue
        rows = evidence.setdefault(unmatched_id(q), [])
        if (q.get('explanation') or {}).get('verdict') in ('receipt', 'owner', 'subscription'):
            rows.append((q, {k: v for k, v in q['explanation'].items() if k != 'purchase'}))
        until = moment(q.get('wait_until'))
        if until and now < until:
            rows.append((q, {'verdict': 'wait', 'why': 'wait for the receipt', 'until': stamp(until), 'errors': []}))
        if results and q['id'] in results:
            rows.append((q, results[q['id']]))
    return evidence


def alert_alias(q, other):
    # Separate questions with identical descriptors represent distinct bank
    # alerts, even if their timestamps have the same precision.
    return unmatched_id(q) == unmatched_id(other) and (q.get('id') == other.get('id') or
            merchant_key(q['merchant']) != merchant_key(other['merchant']))


def alert_verdict(evidence, q, now):
    results = [result for source, result in evidence.get(unmatched_id(q), []) if alert_alias(q, source)]
    explained = next((r for r in results if r['verdict'] in ('receipt', 'owner', 'subscription')), None)
    if explained:
        return explained
    unreadable = next((r for r in results if r['verdict'] == 'unverified'), None)
    if unreadable:
        return unreadable
    waits = [r for r in results if r['verdict'] == 'wait' and (moment(r.get('until')) or now) > now]
    if waits:
        return max(waits, key=lambda r: parse_time(r['until']))
    return next((r for r in results if r['verdict'] in ('unverified', 'held')),
                next((r for r in results if r['verdict'] == 'ask'), None))


def case_owner(case):
    if case.get('owner'):
        return case['owner']
    cards = re.findall(r'(?<!\d)\d{4}(?!\d)', case.get('reference', '') + ' ' + case.get('state', ''))
    if any(charges.card_owner({'card': card}) == 'moni' for card in cards):
        return 'moni'
    return 'moni' if str(case.get('who', '')).lower() in ('moni', 'monika') else 'abdullah'


def case_answered_question(case, q):
    activity = [moment(a.get('at')) for a in q.get('asks', [])]
    latest = max((t for t in activity if t), default=moment(q['opened']))
    return (case.get('answered_cycle') == case.get('cycle', 0) and answered_at(case) >= latest)


def question_in_cycle(q, case):
    if 'case_cycle' in q:
        return q['case_cycle'] == case.get('cycle', 0)
    # Legacy links have no cycle field. Only activity after the last reopen belongs
    # to its current cycle; follow-up checks do not count as question activity.
    starts = [moment(h.get('at')) for h in case.get('history', [])
              if h.get('text', '').startswith(('reopened:', 'repeat bill:'))]
    started = max((t for t in starts if t), default=moment(case['opened']))
    activity = [moment(q.get('opened'))] + [moment(a.get('at')) for a in q.get('asks', [])]
    return not case.get('cycle', 0) or max((t for t in activity if t), default=started) >= started


def recover_case(data, q, cases=None):
    if not q:
        return
    cases = load(data)['cases'] if cases is None else cases
    previous = next((c for c in cases if c['id'] == linked_case(q)), None)
    if previous is None and q.get('kind') == 'charge':
        previous = next((c for c in cases if c.get('alert_at') and c['id'] == unmatched_id(q)), None)
    if previous and previous.get('alert_at') and previous['merchant'] == UNMATCHED:
        q.update(case=previous['id'], case_opened=previous['id'])
        q.setdefault('case_cycle', previous.get('cycle', 0))
    if previous and (q.get('case') or q.get('was_case') or previous.get('why') == f'charge question {q["id"]}'):
        q['case'] = previous['id']
        if previous['status'] == 'closed' and q.get('status') != 'closed':
            q.update(was_case=previous['id'], case_closed=True)
            settle(q, previous.get('outcome') or 'case closed', 'case_close', parse_time(previous['closed']))
        elif active(previous) and not question_in_cycle(q, previous) and q.get('status') != 'closed':
            settle(q, 'linked case moved to a new cycle', 'case_cycle', parse_time(previous['updated']))
        elif active(previous) and q.get('status') in ('open', 'case', 'awaiting_answer') and case_answered_question(previous, q):
            q['was_case'] = previous['id']
            settle(q, 'owner answered linked case ' + previous['id'], 'case_reply', answered_at(previous))
        elif active(previous) and q.get('status') in ('open', 'case', 'awaiting_answer') and question_in_cycle(q, previous) \
                and any(not a.get('legacy') for a in previous.get('asks', [])) \
                and len(previous.get('asks', [])) > len(q.get('asks', [])):
            q.update(status='awaiting_answer', asks=list(previous['asks']), closed=None)
        elif active(previous) and q.get('status') == 'open' and not q.get('case_opened'):
            settle(q, f'now money case {previous["id"]}', 'check', parse_time(previous['opened']), 'case')


def repeat_bill(data, q, now, end=None):
    data = data or DATA
    # A new bank alert after a card-change closure is evidence that the merchant billed again.
    if q.get('status') != 'open' or q.get('kind') != 'charge':
        return
    with Locked(data, wait=lock_wait(end)) as book:
        for case in reversed(book['cases']):
            if case.get('kind') == 'merchant_card' or case.get('merchant_card_key'):
                continue
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
                        owner=charges.card_owner(charge_of(q)), asks=[])
            case['history'].append({'at': stamp(now), 'text': f'repeat bill: charge question {q["id"]}'})
            q.update(case=case['id'], case_cycle=case.get('cycle', 0))
            settle(q, f'now money case {case["id"]}', 'check', now, 'case')
            return


def case_from(data, q, now, by, root=None, end=None):
    """Turn a charge question he never answered into a money case (never a third ask)."""
    cid = q.get('case') or 'charge-' + q['id'][2:]
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
    q.update(case=cid, case_cycle=find(load(data), cid).get('cycle', 0))
    settle(q, f'now money case {cid}', by, now, 'case')
    if q.get('asks'):
        q.update(status='awaiting_answer', closed=None)
        with Locked(data, wait=lock_wait(end)) as book:
            case = find(book, cid)
            case.update(status='awaiting_answer', asks=list(q['asks']))
    return cid


def unmatched_from(data, q, now, root=None, end=None):
    cid = unmatched_id(q)
    try:
        add(data, cid, '', q['amount'], q['currency'], 'charge with no matching order or receipt',
            'owner: which order is this?', (now + dt.timedelta(days=2)).date().isoformat(), 'Abdullah',
            reference=f'card ending {last4_arg("card", q["card"])}', why=f'charge question {q["id"]}',
            at=now, root=root, charged=parse_time(q['at']).date().isoformat(), unmatched=True,
            end=end, alert_at=q['at'])
    except CheckTimeout:
        raise
    except CaseError as e:
        if 'already exists' not in str(e):
            raise
    recover_case(data, q)
    if q.get('asks'):
        with Locked(data, wait=lock_wait(end)) as book:
            case = find(book, cid)
            if active(case) and len(case.get('asks', [])) < len(q['asks']):
                case.update(status='awaiting_answer', asks=list(q['asks']))
    return cid


@case_operation('case.close')
def close_untouched(data, cid, outcome, now, end=None):
    """Close a money case a charge question opened, unless someone has worked on it since."""
    with Locked(data, wait=lock_wait(end)) as book:
        case = next((c for c in book['cases'] if c['id'] == cid), None)
        if case and case['status'] == 'closed':
            # A previous check may have saved the case just before its question write timed out.
            return True
        history = [h for h in (case or {}).get('history', [])
                   if not (h.get('automatic') and h.get('text') == 'asked; awaiting_answer')]
        if not case or not active(case) or len(history) > 1:
            return False
        outcome = clip(redact(outcome), 200)
        case.update(status='closed', closed=stamp(now), outcome=outcome, updated=stamp(now))
        case['history'].append({'at': stamp(now), 'text': 'closed: ' + outcome})
    record_closed(case, now)
    return True


def explain_question(data, q, result, by, now, end=None, questions=()):
    """All entry points settle an untouched linked case from the same evidence as its question."""
    aliases = [other for other in questions if other is not q and other.get('kind') == 'charge'
               and q.get('kind') == 'charge' and (active(other) or other.get('status') == 'case')
               and alert_alias(q, other)]
    for current in [q] + aliases:
        recover_case(data, current)
        if current is not q and not (active(current) or current.get('status') == 'case'):
            continue
        cid = current.get('case')
        if cid:
            current['was_case'] = cid
            current['case_closed'] = close_untouched(data, cid, 'explained: ' + result['why'], now, end=end)
        settle(current, result['why'], by, now)
        current['explanation'] = redact_all(result)


@log_scope
def screen(text, sender='', at=None, now=None, deadline=None, data=None, find=None, said=None, record=True,
           item=None):
    """For inbox triage: None when the text isn't a card alert this reads, else {verdict, why, id,
    kind, errors} with verdict explained | case | asked | wait | ask. Only ask should reach him.
    item is triage's id for the message; triaged() records whether triage raised it."""
    data = data or DATA
    charge = charges.parse(text, sender)
    if not charge:
        return None
    dated = at is not None
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
    matched = subscription_match(data, charge, at, record=record, end=deadline) if dated else None
    r = matched or explain_charge(data, charge, at, now, deadline, find, said, q['id'] if q else None)
    verdict = 'explained' if r['verdict'] in ('receipt', 'owner', 'subscription') else r['verdict']
    qid = q['id'] if q else None
    if record:
        with Locked(data or DATA, 'questions') as book:
            q = question_for(book, charge, at, chan, item) or new_question(book, charge, text, at, now, chan, item)
            if not dated:
                q['subscription_dated'] = False
            q['owner'] = owner
            recover_case(data, q)
            repeat_bill(data, q, now)
            attach(q, chan, at, item)
            qid = q['id']
            if q['status'] == 'case':
                return {**base, 'verdict': 'held' if owner == 'moni' else 'case', 'why': f"money case {q['case']}", 'id': qid}
            if r.get('purchase') and not bind_purchase(data, r, at, q['id']):
                r = explain_charge(data, charge, at, now, deadline, find, said, q['id'], purchases=False)
                verdict = 'explained' if r['verdict'] in ('receipt', 'owner') else r['verdict']
            if verdict == 'explained' and active(q):
                explain_question(data, q, r, 'check' if q.get('asks') or q.get('passed') else 'triage', now, deadline,
                                 book['questions'])
            elif q['status'] == 'open' and not q.get('asks') and not q.get('passed'):
                note_why(q, r['why'], now)
                if verdict == 'wait':
                    q['wait_until'] = r['until']
            prune_questions(book, now)
    return {**base, 'verdict': verdict, 'why': r['why'], 'id': qid, 'errors': r['errors'],
            **({'limits': r['limits']} if r.get('limits') else {})}


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


@log_ask
def ask(data, question, text=None, sender='', at=None, qid=None, now=None, deadline=None, root=None,
        find=None, said=None, daily=False, daily_run=None):
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
    r = None if q and not active(q) and not (daily and q.get('status') == 'case') else (
        (subscription_match(data, charge, at, record=True, end=deadline) if not q or q.get('subscription_dated', False) else None)
        or explain_charge(data, charge, at, now, deadline, find, said, q['id'] if q else None))
    with Locked(data, 'questions', wait=lock_wait(deadline)) as book:
        q = (find_question(book, q['id']) if q else None) or question_for(book, charge, at, chan) \
            or new_question(book, charge, text, at, now, chan)
        q['owner'] = charges.card_owner(charge)
        recover_case(data, q)
        repeat_bill(data, q, now)
        if chan:
            attach(q, chan, at)
        if q['status'] == 'closed':
            return DONT_ASK, f"{q['id']} is settled ({q['outcome']}). Don't ask."
        parent = next((c for c in load(data)['cases'] if c['id'] == q.get('case')), None) if daily else None
        linked = [other for other in book['questions'] if parent and linked_case(other) == parent['id']
                  and question_in_cycle(other, parent)]
        if daily and (q.get('asks') or q.get('unverified') or (parent and daily_case_handled(parent, linked))):
            return DONT_ASK, f"{q['id']}: already handled; not in the daily list."
        if q['status'] == 'case' and not daily:
            return DONT_ASK, f"{q['id']} is money case {q['case']}; follow the case, don't ask about the charge."
        if r is None:
            r = explain_charge(data, charge, at, now, deadline, find, said, q['id'] if q else None)
        if r.get('purchase') and not bind_purchase(data, r, at, q['id']):
            r = explain_charge(data, charge, at, now, deadline, find, said, q['id'], purchases=False)
        note_why(q, r['why'], now)
        if r['verdict'] == 'unverified' and not r['errors']:
            return 4, f"UNVERIFIED: {r['why']} ({q['id']})"
        if r['errors']:
            return 4, '\n'.join(f"UNVERIFIED: source {e.split(':', 1)[0]} unreadable ({q['id']})" for e in r['errors'])
        if r['verdict'] in ('receipt', 'owner', 'subscription'):
            explain_question(data, q, r, 'ask', now, deadline, book['questions'])
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
        entry = {'at': stamp(now), 'question': question}
        if daily_run:
            entry['daily_run'] = daily_run
        if q.get('case'):
            with Locked(data, wait=lock_wait(deadline)) as cases:
                parent = next(c for c in cases['cases'] if c['id'] == q['case'])
                if not active(parent) or (daily and daily_case_handled(parent, [
                        other for other in book['questions'] if linked_case(other) == parent['id']
                        and question_in_cycle(other, parent)])):
                    return DONT_ASK, f"{q['id']}: linked case already handled."
                parent.update(status='awaiting_answer', asks=asks + [entry])
                parent['history'].append({'at': stamp(now), 'text': 'asked; awaiting_answer', 'automatic': True})
        asks.append(entry)
        q['status'] = 'awaiting_answer'
        return 0, (f"{q['id']}: ask him now ({len(asks)} of {MAX_ASKS}); {r['why']}. When he answers: "
                   f"money-cases answered {q['id']} --note '<his answer>'.")


@log_scope
def answered(data, qid, note, now=None):
    """His answer settles the question. A money case it opened stays open with his answer noted: he may
    have said it isn't his."""
    data = data or DATA
    note = check_text('note', note)
    now = (now or now_dubai()).astimezone(TZ)
    with Locked(data, 'questions') as book:
        q = find_question(book, qid)
        recover_case(data, q)
        if q.get('case') and q['status'] in ('open', 'case', 'awaiting_answer'):
            cid = q['case']
            settle(q, note, 'answered', now)
            q['was_case'] = cid
            try:
                parent = update(data, cid, {}, note=f'he answered about charge question {qid}: {note}',
                                reply=qid, at=now, cascade_questions=False)
                for other in book['questions']:
                    if linked_case(other) == cid:
                        recover_case(data, other, [parent])
            except CaseError:
                pass
        elif active(q):
            settle(q, note, 'answered', now)
        return q


@log_scope
def follow(data, now, root=None, deadline=None, find=None, said=None, end=None, stats=None):
    """Close questions a receipt or his words now explain, including ones already turned into money
    cases (FOLLOW_CASE). Asked questions remain awaiting_answer indefinitely. Least recently checked
    first initially, then round robin. Persist the cursor before lookups so an interrupted
    run cannot keep retrying its head. Lookups run outside the lock; returns lookup errors."""
    errors, hits, verdicts, looked, failed = [], {}, {}, set(), set()
    todo = []
    question_book = load_questions(data)
    questions = question_book['questions']
    transactions = alert_verdicts(questions, now)
    cases, repaired = load(data)['cases'], set()
    for q in questions:
        before = dict(q)
        q['owner'] = charges.card_owner(charge_of(q))
        recover_case(data, q, cases)
        if q.get('status') in ('open', 'case', 'awaiting_answer') and q.get('asks'):
            q['status'] = 'awaiting_answer'
        if q != before:
            repaired.add(q['id'])
    waiting = {linked_case(q): q for q in questions if q.get('status') == 'awaiting_answer' and q.get('case')}
    if any(c['id'] in waiting and active(c) and c['status'] != 'awaiting_answer' for c in cases):
        with Locked(data, wait=lock_wait(end)) as book:
            for c in book['cases']:
                if c['id'] in waiting and active(c):
                    q = waiting[c['id']]
                    if case_answered_question(c, q):
                        recover_case(data, q, [c])
                        repaired.add(q['id'])
                    else:
                        c.update(status='awaiting_answer', asks=list(q['asks']))
    for q in questions:
        try:
            at = parse_time(q['at'])
        except (KeyError, TypeError, ValueError):
            continue
        if active(q) or (q.get('status') == 'case' and now - at <= FOLLOW_CASE):
            todo.append((q.get('checked') or '', at, q))
    stats = stats if stats is not None else {'lookups': 0, 'owner_queries': 0, 'msgs_calls': 0}
    # Count the active input snapshot, including deferred questions. not_checked
    # is a subset of limited; only completed, error-free screens are proven_clean.
    with charges.step_timing(stats, 'census'):
        census = stats['charge_census'] = {app: dict.fromkeys(
            ('open', 'matched', 'proven_clean', 'limited', 'error', 'not_checked'), 0)
            for app in ('noon', 'careem')}
        census_questions = {}
        for q in questions:
            app = charges.order_app(charge_of(q)) if q.get('kind') == 'charge' and active(q) else None
            if app in census:
                census_questions[q['id']] = app
                for key in ('open', 'limited', 'not_checked'):
                    census[app][key] += 1
    census_outcomes = {}

    def counted(qid, outcome):
        old = census_outcomes.get(qid)
        census_outcomes[qid] = outcome
        app = census_questions.get(qid)
        if app is None:
            return
        census[app][old or 'limited'] -= 1
        if old is None:
            census[app]['not_checked'] -= 1
        census[app][outcome] += 1

    memo = {('orders_cache',): Path(data) / 'order-details.json'}
    for app in ('noon', 'careem'):
        times = [at - charges.SAME_TIME for _, at, q in todo
                 if q.get('kind') == 'charge' and charges.order_app(charge_of(q)) == app]
        if times:
            memo[('orders_since', app)] = min(times)
    owner_source = said or (lambda *a, **kw: charges.owner_texts(*a, **kw, stats=stats))
    source_error = None

    def source(*args, **kwargs):
        nonlocal source_error
        if source_error is not None:
            raise source_error
        try:
            # Old questions query separate windows; all windows share this cap.
            remaining = charges.OWNER_BUDGET - stats.get('owner_threads_ms', 0) / 1000
            if remaining <= 0:
                raise charges.Lookup('Robob control: lookup over time')
            stop = time.time() + remaining
            if kwargs.get('deadline') is not None:
                stop = min(stop, kwargs['deadline'])
            kwargs['deadline'] = stop
            with charges.step_timing(stats, 'owner_threads', stop), within(
                    stop, charges.Lookup('Robob control: lookup over time')):
                rows = owner_source(*args, **kwargs)
                if time.time() >= stop:
                    raise charges.Lookup('Robob control: lookup over time')
                return rows
        except charges.Lookup as exc:
            if str(exc) != 'out of time':
                source_error = exc
            raise
    charge_times = [at for _, at, q in todo if q.get('kind') == 'charge']
    owner_rows = None
    owner_error = None
    if charge_times and now - (min(charge_times) - charges.OWNER_AROUND) <= dt.timedelta(days=2):
        try:
            owner_end = min(deadline, time.time() + 4) if deadline is not None else time.time() + 4
            with within(owner_end, LookupTimeout('out of time')):
                owner_rows = source(min(charge_times) - charges.OWNER_AROUND, now, deadline=owner_end)
        except (charges.Lookup, LookupTimeout) as e:
            owner_error = f'his threads: {e}'
            errors.append(owner_error)
            owner_rows = []

    def owner(since, until, deadline=None):
        if owner_rows is None:
            return source(since, until, deadline=deadline)
        return [row for row in owner_rows if since <= parse_time(row[0]) <= until]

    ordered = sorted(todo, key=lambda x: (x[1], x[2]['id']))
    cursor = question_book.get('follow_cursor')
    if cursor:
        previous = (parse_time(cursor['at']), cursor['id'])
        ordered = [item for item in ordered if (item[1], item[2]['id']) > previous] + \
                  [item for item in ordered if (item[1], item[2]['id']) <= previous]
    else:
        ordered.sort(key=lambda x: x[0])
    for _, at, q in ordered:
        # A shortened tail attempt can fail at the same point every cycle.
        if deadline is not None and deadline - time.time() < FOLLOW_EACH:
            errors.append('out of time; the rest next check')
            break
        commit_end = deadline
        if end is not None:
            latest = end - FOLLOW_EACH - 0.1
            commit_end = min(commit_end, latest) if commit_end is not None else latest
        with within(commit_end, CheckTimeout('cursor commit out of time; the rest next check')):
            with Locked(data, 'questions', wait=lock_wait(commit_end)) as book:
                book['follow_cursor'] = {'at': stamp(at), 'id': q['id']}
        looked.add(q['id'])
        counted(q['id'], 'error')  # An interrupted attempt must never look clean.
        before_errors = len(errors)
        limits = []
        if q.get('kind') == 'charge':
            # Start the full slice after the cursor commit. The phase deadline admits
            # work; the enclosing whole-check alarm still bounds storage and lookups.
            each = time.time() + FOLLOW_EACH
            stats['lookups'] += 1
            try:
                with within(each, LookupTimeout('out of time')):
                    matched = subscription_match(data, charge_of(q), at, record=True, end=each) if q.get('subscription_dated', False) else None
                    charge = charge_of(q)
                    shared = alert_verdict(transactions, q, now)
                    hit = shared if shared and shared['verdict'] in ('receipt', 'owner', 'subscription') else None
                    hit = hit or matched or purchase_match(data, charge, at, q['id'])
                    receipt_ok = receipt_for_question(data, charge, q['id'], questions, at)
                    if not hit and active(q) and not q.get('case') and now - at >= UNMATCHED_AFTER \
                            and charges.card_owner(charge) == 'abdullah':
                        result = charges.explain(charge, at, now, each, find, owner,
                                                 receipt_ok=receipt_ok, memo=memo, stats=stats)
                        errors.extend(result['errors'])
                        limits.extend(result.get('limits', []))
                        verdicts[q['id']] = result
                        if result['verdict'] in ('receipt', 'owner'):
                            hit = result
                    elif not hit:
                        hit = charges.found(charge, at, now, each, find, owner, errors, memo, stats,
                                            receipt_ok=receipt_ok, limits=limits)
            except (charges.Lookup, LookupTimeout) as e:
                errors.append(str(e))
                # A slow receipt cannot hide owner evidence already loaded in this run.
                hit = charges.owner_found(charge_of(q), at, now, said=owner, errors=errors) \
                    if owner_rows is not None and charges.card_owner(charge_of(q)) == 'abdullah' else None
            counted(q['id'], 'matched' if hit else 'error' if owner_error or len(errors) > before_errors
                    else 'limited' if limits else 'proven_clean')
            if hit:
                hits[q['id']] = hit
            if limits and not hit:
                stats.setdefault('question_limits', []).extend(limits)
            if owner_error or len(errors) > before_errors or (limits and not hit):
                failed.add(q['id'])
    stats['order_coverage'] = {app: result['lanes'] for (kind, *rest), result in memo.items()
                               if kind == 'orders' and isinstance(result, dict) and 'lanes' in result
                               for app in rest}
    if not looked and not repaired:
        return errors
    with Locked(data, 'questions', wait=lock_wait(end)) as book:
        cases = load(data)['cases']
        # Finish evidence assignment for every alias before any question can
        # open a case, regardless of lookup or question insertion order.
        for q in book['questions']:
            hit = hits.get(q['id'])
            if not hit:
                continue
            purchase = hit.get('purchase')
            if purchase and not bind_purchase(data, hit, parse_time(q['at']), q['id']):
                failed.add(q['id'])
                counted(q['id'], 'error')
                errors.append(f"{q['id']}: purchase note matched a different charge; recheck next run")
                continue
            verdicts[q['id']] = {k: v for k, v in hit.items() if k != 'purchase'}
        for q in book['questions']:
            if q.get('kind') == 'charge' and active(q) and q['id'] not in looked:
                verdicts[q['id']] = {'verdict': 'unverified', 'why': 'alias not screened; recheck next run',
                                      'errors': ['alias not screened']}
            elif q['id'] in failed and (verdicts.get(q['id']) or {}).get('verdict', 'ask') == 'ask':
                verdicts[q['id']] = {'verdict': 'unverified', 'why': 'sources unreadable; do not ask',
                                      'errors': ['alias source unreadable']}
        for q in book['questions']:
            if q['id'] not in looked or q.get('kind') != 'decline' or not (active(q) or q.get('status') == 'case'):
                continue
            declined = moment(q.get('at'))
            if declined is None:
                continue
            for c in book['questions']:
                charged = moment(c.get('at'))
                if (c.get('kind') == 'charge' and charged and dt.timedelta() < charged - declined <= PAID_AFTER
                        and all(c.get(k) == q.get(k) for k in ('card', 'currency', 'amount', 'mkey'))):
                    verdicts[q['id']] = {'verdict': 'paid',
                                         'why': f'paid after decline: declined {declined:%H:%M}, '
                                                f"charged {charged:%H:%M} ({c['id']})"}
                    break
        transactions = alert_verdicts(book['questions'], now, verdicts)
        for q in book['questions']:
            result = alert_verdict(transactions, q, now) if q.get('kind') == 'charge' else verdicts.get(q['id'])
            hit = result if result and result['verdict'] in ('receipt', 'owner', 'subscription', 'paid') else None
            if q['id'] not in looked and q['id'] not in repaired and not result:
                continue
            q['owner'] = charges.card_owner(charge_of(q))
            if q.get('status') in ('open', 'case', 'awaiting_answer') and q.get('asks'):
                q['status'] = 'awaiting_answer'
            if q['id'] in looked:
                q['checked'] = stamp(now)
                q['unverified'] = q['id'] in failed or bool(result and result['verdict'] == 'unverified')
            recover_case(data, q, cases)
            if hit and (active(q) or q.get('status') == 'case'):
                try:
                    explain_question(data, q, hit, 'check', now, end, book['questions'])
                except CheckTimeout:
                    raise
                except CaseError as e:
                    counted(q['id'], 'error')
                    errors.append(f"{q['id']}: {e}")
            if result and not hit and active(q):
                note_why(q, result['why'], now)
                if result['verdict'] == 'wait':
                    q['wait_until'] = result['until']
                elif result['verdict'] == 'ask' and q['id'] in looked and not q.get('case') \
                        and not q.get('case_opened') and not q.get('unverified') \
                        and q['owner'] == 'abdullah' and q['kind'] == 'charge' \
                        and now - parse_time(q['at']) >= UNMATCHED_AFTER \
                        and (moment(q.get('wait_until')) or now) <= now:
                    try:
                        unmatched_from(data, q, now, root, end)
                    except CheckTimeout:
                        raise
                    except CaseError as e:
                        errors.append(f"{q['id']}: {e}")
        # Reconcile from a snapshot: updating one alias must not propagate its
        # outcome through another alias to a distinct same-descriptor question.
        with charges.step_timing(stats, 'census', end):
            attempted = census_outcomes.copy()
            for q in book['questions']:
                if q['id'] not in census_questions:
                    continue
                if q.get('status') == 'closed' and (q.get('explanation') or {}).get('verdict') in (
                        'receipt', 'owner', 'subscription'):
                    counted(q['id'], 'matched')
                elif active(q) and q['id'] in attempted:
                    result = alert_verdict(transactions, q, now)
                    if result and result['verdict'] == 'unverified':
                        peers = transactions.get(unmatched_id(q), [])
                        failed_alias = any(attempted.get(source['id']) == 'error' and alert_alias(q, source)
                                           for source, _ in peers)
                        counted(q['id'], 'error' if failed_alias else 'limited')
        prune_questions(book, now)
    return errors


LEGACY_ASK_CUTOFF = dt.datetime(2026, 11, 13, 4, 25, tzinfo=dt.timezone.utc)
# These four were verified as already raised before the structured ask flow.
LEGACY_RAISED_CASES = {'yalla-tph-mandate', 'logic-utilities-nov', 'charge-26dc3e4c',
                       'refund-noon-fgb9nne277t50va'}


def cycle_started(case):
    starts = [moment(h.get('at')) for h in case.get('history', [])
              if h.get('text', '').startswith(('reopened:', 'repeat bill:'))]
    return max((t for t in starts if t), default=moment(case.get('opened')))


def owner_answered(case):
    started = cycle_started(case)
    return any(h.get('owner') and moment(h.get('at')) and (not started or moment(h['at']) >= started)
               and not h.get('text', '').startswith(('reopened:', 'repeat bill:'))
               for h in case.get('history', []))


def daily_case_handled(case, linked):
    if not initial_question_needed(case):
        return 'already asked or answered'
    if owner_answered(case):
        return 'owner answered'
    if any(q.get('asks') or q.get('status') in ('closed', 'answered') for q in linked):
        return 'linked question already asked or settled'
    return ''


def legacy_migration_reason(case, linked):
    now = LEGACY_ASK_CUTOFF.astimezone(TZ)
    if case['id'] in LEGACY_RAISED_CASES:
        return 'verified pre-daily case already raised'
    # Match the original daily list eligibility, before linked-answer and decline
    # filtering. Unrelated disputes, holds and young charges were never in that list.
    opened, wait = moment(case.get('opened')), moment(case.get('wait_until'))
    if (case.get('kind') != 'charge' or case_owner(case) != 'abdullah' or not initial_question_needed(case)
            or not opened or now - opened <= SOON or (wait and now < wait) or case.get('unverified')
            or any(q.get('asks') or q.get('unverified') or q.get('explanation') or
                   (moment(q.get('wait_until')) or now) > now for q in linked)):
        return ''
    return 'eligible for original daily list; pre-install cycle'


def migrate_legacy_asks(data, dry_run=False):
    """Seed asks without turning historical notifications into pending questions."""
    def migrate(book):
        changed = []
        questions = load_questions(data)['questions']
        for case in book['cases']:
            started = cycle_started(case)
            if (not active(case) or is_bill(case) or case.get('asks') or not started
                    or started >= LEGACY_ASK_CUTOFF):
                continue
            linked = [q for q in questions if linked_case(q) == case['id'] and question_in_cycle(q, case)]
            reason = legacy_migration_reason(case, linked)
            if not reason:
                continue
            entry = {'at': case.get('updated') or case['opened'], 'question': 'legacy (pre-daily list)', 'legacy': True}
            case['asks'] = [entry]
            if (owner_answered(case) or any(q.get('status') in ('closed', 'answered') for q in linked)):
                case['answered_cycle'] = case.get('cycle', 0)
            changed.append(f"{case['id']} -> {case['status']} ({reason}; legacy ask at {entry['at']})")
        return changed
    if dry_run:
        return migrate(load(data))
    with Locked(data) as book:
        return migrate(book)


def daily_version(row):
    # Screening timestamps must not re-arm a declined charge. Manual edits and new
    # charge evidence do, even when an older writer did not bump rev or cycle.
    return [row.get(k) for k in ('rev', 'cycle', 'charged', 'opened', 'at', 'amount',
                                 'currency', 'merchant', 'card', 'reference', 'state')]


def daily_skip_reason(row, now):
    if row.get('daily_skip') and row.get('daily_skip_version') == daily_version(row):
        until = moment(row.get('daily_skip_until'))
        if not until or now < until:
            return row['daily_skip']
    return ''


def daily_decline(row, linked):
    if row['type'] == 'case' and not any(q.get('status') != 'closed' for q in linked):
        if not re.fullmatch(r'\d{4}', row['card']):
            return 'no unambiguous card last four'
        if row.get('charged') != row['at'][:10]:
            return 'charge date differs from case opening date'
    return ''


def mark_daily_skip(data, row, reason, now, end, wait_until=None):
    kind = 'questions' if row['type'] == 'question' else 'cases'
    try:
        with within(end, CheckTimeout('skip recording out of time')):
            with Locked(data, kind, wait=lock_wait(end)) as book:
                current = (find_question if kind == 'questions' else find)(book, row['id'])
                if daily_version(current) != row.get('_daily_version', daily_version(row)):
                    return
                current.update(daily_checked=stamp(now), daily_skip=clip(redact(reason), 200),
                               daily_skip_version=daily_version(current))
                current.pop('daily_skip_until', None)
                if wait_until or current.get('wait_until'):
                    current['daily_skip_until'] = wait_until or current['wait_until']
    except CheckTimeout:
        # An exhausted budget leaves the item available for another attempt.
        pass


def refund_text(shown):
    text = shown.replace('\r\n', '\n').replace('\r', '\n').lstrip()
    if charges.HEADER.match(text):
        # msgs show includes inherited subjects and other metadata before a blank line.
        parts = re.split(r'\n[ \t]*\n', text, maxsplit=1)
        text = parts[1] if len(parts) == 2 else ''
    return QUOTED_REPLY.split(text, maxsplit=1)[0].replace('’', "'")


def direct_refund_statement(evidence, done, merchant):
    lead = ' '.join(evidence[:done.start()].casefold().split())
    lead = re.sub(r'^(?:confirmation|verification|proof|evidence|assurance)\s*:\s*', '', lead)
    lead = re.sub(r'^(?:(?:we|i) (?:can )?confirm|(?:kindly|please) note)(?: that)?(?: |$)', '', lead)
    if done['before']:
        return (lead in ('', ' '.join(merchant.casefold().split()), 'the bank', 'our team', 'the team')
                or re.fullmatch(r'(?:we|i|they|he|she)(?: (?:have|had|has))?(?: (?:manually|already))?'
                                r'(?: processed (?:the|your) request and)?', lead) is not None)
    money = re.fullmatch(r'(?:(?:your|the|our) )?[a-z]{3} ?\d[\d.,]*', lead) is not None
    if done['credit']:
        return lead in ('', 'the amount', 'the payment', 'your card', 'your account') or money
    return lead in ('', 'your', 'the', 'our', 'this', 'that') or money


def refund_mails(data, now, deadline, find=None, read=None, stats=None):
    find = find or (lambda *a, **kw: charges.search(*a, **kw, stats=stats))
    read = read or (lambda *a, **kw: charges.show(*a, **kw, stats=stats))
    errors = []
    for case in load(data)['cases']:
        merchant = case['merchant']
        words = charges.words(merchant)
        since = moment(case.get('updated'))
        if not active(case) or case.get('kind') == 'hold' or merchant == UNMATCHED or not words or not since:
            continue
        if time.time() >= deadline:
            errors.append('refund mail: out of time; the rest next check')
            break
        try:
            with within(deadline, LookupTimeout('out of time')):
                rows = find(' OR '.join(f'"{w}"' for w in words) + ' refund OR credited', charges.day(since),
                            source='email', n=10, deadline=deadline)
                for row in sorted(rows, key=lambda row: row['ts'], reverse=True):
                    mailed = dt.datetime.fromtimestamp(row['ts'], TZ)
                    sender = row.get('sender', '').lower()
                    if (mailed <= since or row.get('from_me') or row.get('source') != 'email'
                            or charges.BANKS.search(sender) or not any(w in sender for w in words)
                            or str(row['id']) == str(case.get('refund_mail', {}).get('id'))):
                        continue
                    text = refund_text(read(row, deadline))
                    # A wrong hold postpones a dispute, so any authored negation blocks it.
                    if REFUND_NEGATION.search(text):
                        continue
                    # Abbreviations can look like sentence endings inside a question. Only
                    # a neutral trailing follow-up may be ignored; other questions block a hold.
                    confirmation = REFUND_FOLLOWUP.sub('', text)
                    prefix = REFUND_PAST_PREFIX.match(confirmation)
                    if prefix:
                        confirmation = confirmation[prefix.end():]
                    if '?' in confirmation or REFUND_QUERY.search(confirmation):
                        continue
                    # A completed initiation may precede an estimate for the card credit.
                    future = REFUND_FUTURE.search(confirmation)
                    evidence = confirmation[:future.start()] if future else confirmation
                    done = REFUND_DONE.search(evidence)
                    # A recipient can be any name or noun phrase, including wrapped text.
                    if not done:
                        continue
                    before = evidence[:done.start()]
                    proof = REFUND_PROOF_NOUN.search(before)
                    demand = REFUND_PROOF_DEMAND.search(confirmation)
                    # Requests and nominal proof claims need a recognizable direct assertion,
                    # rather than a completed verb embedded in an unresolved statement.
                    if ((prefix or proof or demand or REFUND_REQUEST_WORD.search(before))
                            and not direct_refund_statement(evidence, done, merchant)):
                        continue
                    if proof and (REFUND_PROOF_DEMAND.search(confirmation[done.end():])
                                  or REFUND_REQUEST_WORD.search(confirmation[done.end():])
                                  or REFUND_PROOF_PENDING.search(confirmation[done.end():])):
                        continue
                    completed = done['past'] or done['before'] or done['credit_past']
                    # A resolved timing prefix dates a past assertion; it cannot make
                    # present or future processing into completed-refund evidence.
                    if prefix and not completed:
                        continue
                    # Present/bare wording may depend on a condition after the future marker.
                    context = evidence if completed else confirmation
                    if REFUND_UNCERTAIN.search(context):
                        continue
                    # Past completion can be dated after approval; timing before it
                    # or attached to present-tense processing still describes a condition.
                    timings = list(REFUND_TIMING.finditer(context))
                    if timings and (any(t.start() < done.end() for t in timings)
                                    or not completed):
                        continue
                    changes = {'state': f'refund promised: {merchant} mail {mailed:%a %d %b %H:%M} says it was processed'}
                    due = mailed + dt.timedelta(days=7)
                    current = deadline_of(case)
                    if current is None or due > current:
                        changes['deadline'] = stamp(due)
                    if 'dispute' in case['next'].lower() and not case['next'].startswith('held: watch the card for the credit; then '):
                        changes['next'] = 'held: watch the card for the credit; then ' + case['next']
                    update(data, case['id'], changes, note=f"refund mail {row['id']}", at=now,
                           because=f"merchant mail {row['id']} says the refund was processed; dispute step held",
                           source=f"mail:{row['id']}", refund_mail={'id': row['id'], 'at': stamp(mailed)},
                           expected_updated=case['updated'])
                    break
        except _DryRun:
            continue
        except (charges.Lookup, LookupTimeout, TimeoutError) as exc:
            errors.append(f"refund mail {case['id']}: {exc}")
    return errors


def unasked_candidates(data, now, excluded=None, declined=None):
    """Read-only snapshots; linked cases and their questions count as one charge."""
    now = now.astimezone(TZ)
    cases = load(data)['cases']
    questions = load_questions(data)['questions']
    transactions = alert_verdicts(questions, now)
    rows, represented = [], set()
    def omit(row, reason):
        if excluded is not None:
            excluded.append(dict(row, skip=reason))
    for q in questions:
        recover_case(data, q, cases)
        shared = alert_verdict(transactions, q, now) if q.get('kind') == 'charge' else None
        reason = ('already asked or settled' if q.get('status') != 'open' or q.get('asks') else
                  'source unreadable' if q.get('unverified') else
                  'held for another owner' if charges.card_owner(charge_of(q)) != 'abdullah' else
                  daily_skip_reason(q, now))
        reason = reason or ('charge explained' if shared and shared['verdict'] in ('receipt', 'owner', 'subscription') else
                            'waiting for receipt' if shared and shared['verdict'] == 'wait' else '')
        observed, wait = moment(q.get('at')), moment(q.get('wait_until'))
        reason = reason or ('less than 24 h old or missing charge time' if not observed or now - observed <= SOON else
                            'waiting for receipt' if wait and now < wait else '')
        if reason:
            omit(q, reason)
        elif linked_case(q) in represented:
            omit(q, 'represented by charge question')
        else:
            rows.append(dict(q, type='question'))
            represented.add(linked_case(q))
    for c in cases:
        linked = [q for q in questions if linked_case(q) == c['id'] and question_in_cycle(q, c)]
        shared = [alert_verdict(transactions, q, now) for q in linked if q.get('kind') == 'charge']
        reason = ('closed' if not active(c) else 'not a charge' if c.get('kind') != 'charge' else
                  'bill uses deadline reminders' if is_bill(c) else daily_case_handled(c, linked) or
                  ('held for another owner' if case_owner(c) != 'abdullah' else
                   'represented by charge question' if c['id'] in represented else daily_skip_reason(c, now)))
        opened, wait = moment(c.get('opened')), moment(c.get('wait_until'))
        reason = reason or ('source unreadable' if c.get('unverified') or any(q.get('unverified') for q in linked) else
                            'charge explained' if any(q.get('explanation') for q in linked) or any(
                                r and r['verdict'] in ('receipt', 'owner', 'subscription') for r in shared) else
                            'waiting for receipt' if any(r and r['verdict'] == 'wait' for r in shared) or (wait and now < wait) or any(
                                (moment(q.get('wait_until')) or now) > now for q in linked) else
                            'less than 24 h old or missing opening time' if not opened or now - opened <= SOON else '')
        if reason:
            omit(c, reason)
            continue
        cards = {m[1] or m[2] for m in re.finditer(
            r'\bending(?: in)?\s+(\d{4})(?!\d)|[•*]{2,4}\s*(\d{4})(?!\d)',
            c.get('reference', '') + ' ' + c.get('state', ''), re.I)}
        card = c.get('card') or (next(iter(cards)) if len(cards) == 1 else '')
        row = dict(c, type='case', at=c['opened'], card=card, _daily_version=daily_version(c),
                   daily_checked=max([c.get('daily_checked') or ''] + [q.get('daily_checked') or '' for q in linked]))
        reason = ('held for another owner' if charges.card_owner({'card': card}) != 'abdullah' else
                  daily_decline(row, linked))
        if reason:
            omit(row, reason)
            if declined is not None:
                declined.append((row, reason))
        else:
            rows.append(row)
    return sorted(rows, key=lambda row: (parse_time(row['at']), row['id']))


def daily_question(data, row, now, end):
    """Give a standalone case the same receipt and answer bookkeeping as a charge question."""
    with Locked(data, 'questions', wait=lock_wait(end)) as book:
        if row['type'] == 'question':
            q = find_question(book, row['id'])
        else:
            case = find(load(data), row['id'])
            linked = [q for q in book['questions'] if linked_case(q) == case['id'] and question_in_cycle(q, case)]
            if not active(case) or daily_case_handled(case, linked):
                return None
            for linked in book['questions']:
                if linked_case(linked) == case['id']:
                    recover_case(data, linked, [case])
            q = next((q for q in book['questions'] if linked_case(q) == case['id']
                      and question_in_cycle(q, case) and q.get('status') != 'closed'), None)
            if not q:
                # Without a known last four or a charge timestamp, receipt matching would guess.
                if not re.fullmatch(r'\d{4}', row['card']) or case.get('charged') != row['at'][:10]:
                    return None
                charge = {k: row[k] for k in ('kind', 'card', 'currency', 'amount', 'merchant')}
                q = new_question(book, charge, '', parse_time(row['at']), now, 'case',
                                 f"{case['id']}|c{case.get('cycle', 0)}")
                q.update(case=case['id'], case_cycle=case.get('cycle', 0), status='case', by='daily')
        # Save the attempt before archive access so timeouts rotate behind untouched items.
        q['daily_checked'] = stamp(now)
        return q['id']


def unasked_line(row):
    return redact(f"{row['id']}: {clip(row['merchant'], 80)} {money(row)} on ••{row.get('card') or 'unknown'}, "
                  f"{parse_time(row['at']):%Y-%m-%d}")


def unasked(data, now=None, find=None, said=None, budget=40):
    data = data or DATA
    now = (now or now_dubai()).astimezone(TZ)
    end = time.time() + budget
    run_id = '.'.join(os.urandom(4).hex() for _ in range(3))
    listed, explained, open_parents = [], [], []
    declined = []
    candidates = unasked_candidates(data, now, declined=declined)
    for row, reason in declined:
        if end - time.time() < 2:
            break
        mark_daily_skip(data, row, reason, now, end)
    for row in sorted(candidates, key=lambda r: (r.get('daily_checked') or '', parse_time(r['at']), r['id'])):
        if end - time.time() < 2:
            break
        each = min(end - 1, time.time() + FOLLOW_EACH)
        qid = None
        try:
            with within(each, LookupTimeout('out of time')):
                qid = daily_question(data, row, now, each)
                if not qid:
                    mark_daily_skip(data, row, 'daily question declined', now, each)
                    continue
                rc, refusal = ask(data, f'daily list {now.date()}', qid=qid, now=now,
                            deadline=each, find=find, said=said, daily=True, daily_run=run_id)
            q = find_question(load_questions(data), qid)
        except (LookupTimeout, CheckTimeout, charges.Lookup):
            if not qid:
                continue
            q = find_question(load_questions(data), qid)
            recover_case(data, q)
            # The parent or question may have committed before its save timed out.
            # Only this invocation's durable ask can recover a line here.
            if not any(a.get('daily_run') == run_id for a in q.get('asks', [])):
                continue
            rc = 0
        if rc == 0:
            listed.append((parse_time(row['at']), row['id'], unasked_line(dict(q, id=row['id']))))
        elif rc != 4:
            mark_daily_skip(data, row, refusal, now, each, q.get('wait_until'))
        if rc != 0 and q['status'] == 'closed' and q.get('explanation'):
            line = f"{row['id']} {clip(row['merchant'], 80)} ({q['why']})"
            if q.get('case') and not q.get('case_closed'):
                open_parents.append(line)
            else:
                explained.append(line)
    lines = [line for _, _, line in sorted(listed)] or ['No charges ready to ask about.']
    notes = []
    if explained:
        notes.append('Explained and settled: ' + '; '.join(explained))
    if open_parents:
        notes.append('Charge explained; case still open: ' + '; '.join(open_parents))
    if notes:
        lines.append('. '.join(notes) + '.')
    return redact('\n'.join(lines))


def question_entries(questions, now, sent, pending=False):
    """attention()-style (head, items, tail, day) entries for what the check did to charge questions, once each."""
    entries = []
    for q in sorted(questions, key=lambda q: q['at']):
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
        elif q.get('status') == 'case' and q.get('asks') and q.get('by') == 'check' and recent:
            item = (f"q|{q['id']}|case", f"he didn't answer, so it is now money case {q.get('case')}",
                    "Tell him once with options; never ask about the charge again")
        else:
            continue
        if item[0] not in sent:
            # No day: a question's pings are once-only keys, outside the one-reminder-a-day cap of cases.
            entries.append((head, [(item[0], item[1])], item[2], None))
    return entries


def payment_entries(cases, now, sent, pending=False):
    entries = []
    for case in sorted(cases, key=lambda c: deadline_of(c) or now):
        if case.get('kind') != 'payment_deadline' or not active(case) or case_owner(case) != 'abdullah':
            continue
        due = deadline_of(case)
        if not due or (pending and now < due):
            continue
        base = f"{case['id']}|r{case.get('rev', 0)}|c{case.get('cycle', 0)}|payment|"
        # The watcher ticks every 15 min. Start one tick early so a 23:59 deadline
        # gets its hour-before reminder before the existing 23:00 quiet window.
        stage = 'deadline' if now >= due else 'hour' if now >= due - dt.timedelta(minutes=75) else 'initial'
        if stage is None or base + stage in sent:
            continue
        head = f"- {case['id']}: {clip(redact(case['merchant']), 80)} {clip(money(case), 40)}"
        entries.append((head, [(base + stage, f'Payment deadline {day(due)} {due:%H:%M} Dubai; still unconfirmed'
                            + (f'; balance after credits: {balance_after_credits(case, cases, now)}; ask even if another question is pending' if now >= due else ''))],
                        'Send this payment reminder alone. Confirm paid/done with money-cases close ID --outcome paid --source sms:<id>.', None))
    return entries


def follow_order_charges(data, now, deadline, find=None, stats=None, end=None, registry=None, read=None):
    import order_charges
    registry = registry or Path(os.environ.get('ORDER_TRACKER_ROOT', '~/.local/state/order-tracker')).expanduser()
    source = find or (lambda *args, **kwargs: charges.search(*args, **kwargs, stats=stats))
    reader = read or (lambda *args, **kwargs: charges.show(*args, **kwargs, stats=stats))
    book = load(data)
    settled = book.get('order_charges', {})
    orders = {cfg['watcher']: cfg for cfg in order_charges.registrations(registry)}
    for case in book['cases']:
        if case.get('kind') == 'charge_unconfirmed' and active(case) and case.get('order_registration'):
            cfg = case['order_registration']
            orders.setdefault(cfg['watcher'], cfg)
    errors = []
    # Rotate long lists so a noisy archive cannot starve the same older order forever.
    for wid, cfg in sorted(orders.items(), key=lambda pair: settled.get(pair[0], {}).get('checked', '')):
        prior = settled.get(wid, {})
        placed = parse_time(cfg['placed_at'])
        if prior.get('confirmed') or now < placed + dt.timedelta(minutes=15):
            continue
        cid = 'order-charge-' + hashlib.sha256(wid.encode()).hexdigest()[:20]
        case = next((c for c in book['cases'] if c['id'] == cid), None)
        if case and not active(case):
            continue
        if time.time() + 1 >= deadline:
            break
        proof = None
        try:
            each = min(deadline, time.time() + 4)
            with within(each, LookupTimeout('order charge lookup out of time')):
                peers = [dict(other, bank_confirmed_at=(settled.get(key, {}).get('confirmed') or {}).get('at'))
                         for key, other in orders.items()]
                proof = order_charges.matching_charge(cfg, now, source, reader, each, charges, peers)
        except (charges.Lookup, LookupTimeout) as exc:
            errors.append(f'{wid}: {exc}')
        # One transaction owns both the per-order receipt and its case. Concurrent
        # checks and repeated SMS/email copies cannot open a second case.
        with Locked(data, wait=lock_wait(end or deadline + 2)) as current:
            notes = current.setdefault('order_charges', {})
            if notes.get(wid, {}).get('confirmed'):
                continue
            notes[wid] = {'checked': stamp(now), 'confirmed': proof}
            settled[wid] = notes[wid]
            live = next((c for c in current['cases'] if c['id'] == cid), None)
            if proof:
                if live and active(live):
                    live.update(status='closed', closed=stamp(now), updated=stamp(now),
                                outcome='bank charge confirmed')
                    live['history'].append({'at': stamp(now), 'text': 'bank charge confirmed', 'source': proof['source']})
            elif live is None:
                merchant = check_text('merchant', order_charges.merchant(cfg))
                current['cases'].append({
                    'id': cid, 'kind': 'charge_unconfirmed', 'merchant': merchant,
                    'amount': check_amount(cfg['amount']), 'currency': check_currency(cfg.get('currency', 'AED')),
                    'card': cfg['card_last4'], 'reference': cfg['order'], 'charged': placed.date().isoformat(),
                    'state': 'charge unconfirmed', 'next': 'Check bank evidence; do not pay or reorder again',
                    'deadline': stamp(placed + dt.timedelta(minutes=15)),
                    'why': 'No matching bank charge observed 15 minutes after order placement; this does not prove payment failed',
                    'who': 'Moni' if cfg.get('for') == 'moni' else 'Abdullah', 'watchers': [], 'status': 'open',
                    'asks': [], 'rev': 0, 'cycle': 0, 'opened': stamp(now), 'updated': stamp(now),
                    'closed': None, 'outcome': None, 'history': [{'at': stamp(now), 'text': 'opened'}],
                    'order_registration': cfg})
    return errors


@log_scope
def run_check(wd, run, data=None, root=None, now=None, find=None, said=None):
    diagnostic = {'budgetHit': False, 'openCases': 0, 'fired': 0, 'ok': False,
                  'slowest': 'reconcile', 'started': time.time()}
    try:
        event = _run_check(wd, run, data, root, now, find, said, diagnostic=diagnostic)
        # ok means the pass completed and saved without errors, including source
        # read failures. Known source limits alone are not errors; coverage and
        # the census describe those. Exceptions leave the initial False intact.
        diagnostic['ok'] = diagnostic.get('complete', True)
        return event
    finally:
        try:
            # The check owns the start and timing samples; logging adds no second timer.
            duration = diagnostic.get('total_s')
            if duration is None:
                duration = time.time() - diagnostic['started']
            stats = diagnostic.get('stats', {})
            diagnostic['charge_census'] = stats.get('charge_census', {})
            diagnostic['order_coverage'] = stats.get('order_coverage', diagnostic.get('order_coverage', {}))
            record_event('check.run', kind='perf', duration_ms=duration * 1000, ok=diagnostic['ok'],
                         props={key: diagnostic[key] for key in ('budgetHit', 'openCases', 'fired')} |
                               {'slowestPhase': diagnostic['slowest'],
                                'sourceLimits': diagnostic.get('sourceLimits', 0),
                                'limitKinds': diagnostic.get('limitKinds', []),
                                'orderCoverage': diagnostic.get('order_coverage', {}),
                                'chargeCensus': diagnostic.get('charge_census', {}),
                                **{key: stats.get(key, 0) for key in (
                                    'owner_threads_ms', 'msgs_ms', 'msgs_max_ms', 'lookups_ms', 'census_ms')},
                                'starved_by': stats.get('starved_by', diagnostic.get('starved_by', 'none'))})
        except Exception:
            pass


def _run_check(wd, run, data=None, root=None, now=None, find=None, said=None, *, diagnostic):
    started = diagnostic['started']
    end = started + CHECK_BUDGET
    # Reserve a second for the final save, which still has the whole-check deadline.
    work_end = end - 1
    stats = {'lookups': 0, 'owner_queries': 0, 'msgs_calls': 0}
    diagnostic['stats'] = stats
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
            diagnostic['openCases'] = sum(active(c) for c in load(data)['cases'])
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
                    state['sent'][key] = delivered_at.isoformat(timespec='auto')
                for cid in out.get('days', []):
                    state['sent'][f"{cid}|day|{delivered_at.astimezone(TZ).date()}"] = delivered_at.isoformat(timespec='auto')
                mark_bill_asked(data, out['keys'], delivered_at, out.get('clock'))
                # Start the two-day yes/no clock at the first reminder actually delivered since the last answer.
                for cid, answer in out.get('clock', {}).items():
                    if clock.get(cid, {}).get('answer') != answer['answer']:
                        clock[cid] = {'answer': answer['answer'], 'at': delivered_at.isoformat(timespec='auto')}
            elif out:
                # Build keys already suppress another emission. Two cases: the runner took the event (it is in state.json `pending`, and it will
                # retry it), or the runner never took it (the check died before the runner saved it). Only the first
                # is kept; the second is dropped, allowing unrelated new keys to proceed.
                if runner_owns(wd, out):
                    state['outbox'] = out
            retained_outbox = state.get('outbox')
            phases[phase] = time.time() - phase_at
            phase, phase_at = 'follow', time.time()
            errors = []
            try:
                reconcile_merchants(data, now, end=work_end)
            except CheckTimeout:
                raise
            except CaseError as exc:
                errors.append(str(exc))
            errors += follow_order_charges(data or DATA, now, min(end - 28, time.time() + 6), find, stats, end=work_end)
            errors += follow_payments(data or DATA, now, min(end - 28, time.time() + 6), find, stats, end=work_end)
            errors += follow(data or DATA, now, root, min(end - 8, time.time() + FOLLOW_BUDGET), find, said,
                            end=work_end, stats=stats)
            errors += refund_mails(data or DATA, now, time.time() + 8, find, stats=stats)
            phases[phase] = time.time() - phase_at
            phase, phase_at = 'attention', time.time()
            if errors:
                state['question_errors'] = {'at': stamp(now), 'errors': errors[:10]}
            else:
                state.pop('question_errors', None)
            limits = stats.get('question_limits', [])
            if limits:
                state['question_limits'] = {'at': stamp(now), 'limits': [l['why'] for l in limits][:10]}
            else:
                state.pop('question_limits', None)
            diagnostic['sourceLimits'] = len(limits)
            diagnostic['limitKinds'] = sorted({kind for l in limits for kind in l['kinds']})
            diagnostic['order_coverage'] = stats.get('order_coverage', {})
            # Only new keys may produce another event, even when delivery is never acknowledged.
            cases = load(data)['cases']
            diagnostic['openCases'] = sum(active(c) for c in cases)
            cutoff = stamp(now - KEEP_SENT)
            live = live_keys(cases)
            state['sent'] = {k: v for k, v in state['sent'].items() if v >= cutoff or k in live or k.startswith(live)}
            state['built'] = {k: v for k, v in state['built'].items()
                              if v >= cutoff or k.startswith(live) or k.startswith('q|')}
            # An undelivered event is still out: the runner retries it. Never build a second one over it, so no
            # case key is recorded for an event that was never shown.
            if not quiet(now) and 'outbox' not in state:
                handled = state['sent'] | state['built']
                cases = load(data)['cases']
                questions = load_questions(data)['questions']
                pending = any(active(c) and c.get('status') == 'awaiting_answer'
                              and case_owner(c) == 'abdullah' for c in cases)
                qentries = question_entries(questions, now, handled, pending)
                qids = {key.split('|')[1] for _, items, _, _ in qentries for key, _ in items}
                covered = {q['id']: linked_case(q) for q in questions if q['id'] in qids}
                pending = pending or any(active(q) and q.get('asks')
                              and charges.card_owner(charge_of(q)) == 'abdullah' for q in questions)
                pending = pending or any(k.endswith('|ask') for _, items, _, _ in qentries for k, _ in items)
                due = attention(cases, now, handled, root, clock, pending)
                due.sort(key=lambda entry: not any('|bill-ask|' in k for k, _ in entry[1]))
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
                payment_due = payment_entries(cases, now, handled, pending)
                urgent_bills = any('|bill-ask|' in k for _, items, _, _ in due for k, _ in items)
                overdue_payment = any(c.get('kind') == 'payment_deadline' and active(c) and overdue_bill(c, now)
                                      for c in cases)
                entries = payment_due[:1] if payment_due and (overdue_payment or not urgent_bills) else \
                    [entry for entry in due if entry[3] not in covered.values()] + combined
                if not payment_due:
                    entries += subscription_entries(data, now, handled)
                    daily_key = f'daily-unasked|{now.date()}'
                    candidates = unasked_candidates(data or DATA, now)
                    if candidates and daily_key not in handled:
                        first_regular = next((i for i, entry in enumerate(entries)
                                              if not any('|bill-ask|' in k for k, _ in entry[1])), len(entries))
                        entries.insert(first_regular, ('', [(daily_key, f'{len(candidates)} unasked charges older than 24 h. '
                                              'Run `money-cases unasked --ask` and send its output as one message')], '', None))
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
        diagnostic['budgetHit'] = time.time() >= work_end
        if diagnostic['budgetHit']:
            stats['starved_by'] = getattr(e, '_money_cases_step', phase)
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
                **{k: stats[k] for k in ('lookups', 'owner_queries', 'msgs_calls')},
                **{k: stats.get(k, 0) for k in ('owner_threads_ms', 'msgs_ms', 'msgs_max_ms', 'lookups_ms', 'census_ms')},
                'starved_by': stats.get('starved_by', 'none'), 'slowest': max(phases, key=phases.get)}

    saved = False
    state.pop('timing', None)
    try:
        with within(end, CheckTimeout('out of time saving pings; the rest next check')):
            write_json(pings, state, timing=timing)
            saved = True
    except CheckTimeout as exc:
        already_expired = diagnostic['budgetHit']
        diagnostic['budgetHit'] = already_expired or time.time() >= end
        if time.time() >= end and (save_at < end or not already_expired):
            stats['starved_by'] = getattr(exc, '_money_cases_step', 'build_write')
        # The old pings file is intact; never emit an event without its committed outbox.
        event = ''
    result = timing()
    diagnostic.update(result, complete=saved and not state.get('question_errors', {}).get('errors'),
                      fired=int(bool(event)))
    if not saved or result['total_s'] > 20:
        print('money-cases timing: ' + json.dumps({**result, 'pings_saved': saved}, sort_keys=True), file=sys.stderr)
    return event


def visible_cases(data):
    rows = load(data)['cases']
    ids = {c['id'] for c in rows}
    for q in load_questions(data)['questions']:
        if not active(q) or linked_case(q) in ids:
            continue
        rows.append({**q, 'state': 'awaiting_answer' if q.get('asks') else 'unasked charge',
                     'status': 'awaiting_answer' if q.get('asks') else q['status'],
                     'deadline': None, 'who': q.get('owner') or charges.card_owner(charge_of(q)),
                     'next': 'await his answer' if q.get('asks') else 'check receipt, then include in the daily list'})
    return rows


def cancelled_cards():
    """Read only cancelled last-4s; an unavailable card-status file must not break the brief."""
    try:
        path = Path(os.environ.get('CARD_STATUS_FILE') or '~/.local/state/card-status.json').expanduser()
        records = json.loads(path.read_text())
    except (OSError, UnicodeError, ValueError, RuntimeError):
        return set()
    if not isinstance(records, dict):
        return set()
    return {last4 for last4, record in records.items()
            if re.fullmatch(r'[0-9]{4}', last4) and isinstance(record, dict) and record.get('state') == 'cancelled'}


def brief(cases, now=None, root=None, cancelled=None):
    now = (now or now_dubai()).astimezone(TZ)
    root = root or WATCH_ROOT
    open_cases = [c for c in cases if active(c) and case_owner(c) == 'abdullah']
    running = []
    for case in cases:
        if case.get('status') != 'closed' or case_owner(case) != 'abdullah':
            continue
        for watcher in case.get('watchers', []):
            if (isinstance(watcher, str) and ID.fullmatch(watcher)
                    and (root / 'watchers' / watcher).is_dir() and watcher_end(watcher, root) is None):
                running.append(f"{case['id']} ({watcher})")
    if not open_cases and not running:
        return ''

    due, changed = [], []
    far = dt.datetime.max.replace(tzinfo=TZ)
    for case in sorted(open_cases, key=lambda c: (c.get('kind') != 'payment_deadline', due_of(c) or far)):
        deadline = deadline_of(case)
        due_date = due_of(case)
        date = ''
        if case.get('due'):
            if due_date is None:
                date = 'no valid due date'
            else:
                local = due_date.astimezone(TZ)
                display = f'{day(local)} {local:%H:%M} Dubai' if case.get('kind') == 'payment_deadline' else when(due_date)
                date = ('overdue since ' if due_date <= now else 'due ') + display
            if deadline is not None and deadline != due_date:
                date += f' (follow-up {when(deadline)})'
        if case.get('kind') == 'merchant_card':
            due.append(case['state'] + (f'; {date}' if date else ''))
        elif case.get('status') == 'awaiting_answer':
            due.append(f"{case['merchant']} {money(case)} (awaiting answer"
                       + (f"; {case['state']}" if case.get('urgency') == 'overdue' else '')
                       + (f'; {date}' if date else '') + ')')
        elif case.get('urgency') == 'overdue':
            due.append(f"{case['merchant']} {money(case)} ({case['state']}" + (f'; {date}' if date else '') + ')')
        elif due_date is None:
            due.append(f"{case['merchant']} {money(case)} ({date or 'no valid deadline'})")
        elif case.get('kind') == 'payment_deadline' or due_date <= now + BRIEF_DUE:
            if date:
                due.append(f"{case['merchant']} {money(case)} {date}")
            else:
                late = 'overdue since ' if deadline <= now else ''
                display = f'{day(deadline)} {deadline:%H:%M} Dubai' if case.get('kind') == 'payment_deadline' else when(deadline)
                due.append(f"{case['merchant']} {money(case)} ({late}{display})")
        elif parse_time(case['updated']) >= now - BRIEF_CHANGED:
            changed.append(f"{case['merchant']} {money(case)}" + (f' {date}' if date else ''))
    parts = [f'Money: {len(open_cases)} open']
    if due:
        parts.append('due: ' + '; '.join(due))
    if changed:
        parts.append('changed: ' + '; '.join(changed))
    if open_cases and not due and not changed:
        parts.append('nothing due in 48h')
    if running:
        shown = running[:3]
        if len(running) > len(shown):
            shown.append(f'+{len(running) - len(shown)} more')
        parts.append('closed but watcher running: ' + ', '.join(shown))

    if cancelled is None:
        cancelled = cancelled_cards()
    cancelled = sorted({c for c in cancelled if isinstance(c, str) and re.fullmatch(r'[0-9]{4}', c)})
    refunds = []
    for case in open_cases:
        text = ' '.join(str(case.get(field) or '') for field in ('state', 'next', 'why'))
        if not re.search(r'refund|credit', text, re.I):
            continue
        for last4 in cancelled:
            if re.search(r'(?<!\d)' + last4 + r'(?!\d)', text):
                refunds.append(f"refund to cancelled card {last4}: {case['id']}, ask ENBD where it went")
    parts.extend(refunds[:3])
    if len(refunds) > 3:
        parts.append(f'+{len(refunds) - 3} more')
    return ' '.join(redact('; '.join(parts) + '.').split())


def table(cases):
    rows = []
    for c in sorted(cases, key=lambda c: (not active(c), str(c.get('due') or c.get('deadline')))):
        flag = ' [awaiting_answer]' if c['status'] == 'awaiting_answer' else '' if active(c) else ' [closed]'
        deadline = deadline_of(c)
        by = when(deadline) if deadline else f"{c.get('deadline')!r} (not a valid deadline)"
        dates = f'by {by}'
        if c.get('due'):
            due_date = due_of(c)
            dates = (f'due {when(due_date)}' if due_date else f"{c['due']!r} (not a valid due date)")
            if c.get('deadline'):
                dates += f', follow-up {by}'
        # Redact each field before clipping it: a clipped card number would no longer match.
        rows.append(f"{c['id']}{flag}: {redact(c['merchant'])} {money(c)}, {dates} ({redact(c['who'])})\n"
                    f"  next: {clip(redact(c['next']), 200)}\n  state: {clip(redact(c['state']), 200)}")
    return redact('\n'.join(rows)) or 'No cases.'


@log_cli
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
            required = name == 'add' and field not in ('reference', 'why', 'merchant', 'due')
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
            p.add_argument('--because', default='', help='reason for a due change; optional for deadline changes')
            p.add_argument('--source', default='', help='evidence: mail:, sms:, imessage: or statement:<path>#<line>')
            p.add_argument('--reply', default='', help="his reply id for a due or deadline change")
    p = sub.add_parser('close')
    p.add_argument('id')
    p.add_argument('--outcome', required=True)
    p.add_argument('--source', default='')
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
    p = sub.add_parser('subs', help='subscription register; blank fields mean unknown')
    subs = p.add_subparsers(dest='subs_command', required=True)
    subs.add_parser('list')
    p = subs.add_parser('due')
    p.add_argument('--days', type=int, default=3)
    subs.add_parser('remove').add_argument('id')
    for operation in ('add', 'edit'):
        p = subs.add_parser(operation)
        p.add_argument('id')
        for field in SUB_FIELDS:
            p.add_argument('--' + field.replace('_', '-'), required=operation == 'add' and field == 'merchant')
    sub.add_parser('brief')
    sub.add_parser('check')
    p = sub.add_parser('note-purchase')
    for field in ('merchant', 'amount', 'currency', 'card', 'asked-by', 'thread'):
        p.add_argument('--' + field, required=True)
    p.add_argument('--invoice', default='')
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
    p = sub.add_parser('migrate-legacy-asks')
    p.add_argument('--dry-run', action='store_true')
    p = sub.add_parser('unasked')
    p.add_argument('--all', action='store_true', help='include excluded items and their reasons (read-only)')
    mode = p.add_mutually_exclusive_group()
    mode.add_argument('--json', action='store_true')
    mode.add_argument('--ask', action='store_true')
    args = parser.parse_args(argv)
    try:
        if args.command == 'note-purchase':
            entry = note_purchase(DATA, args.merchant, args.amount, args.currency, args.card, args.asked_by, args.thread, args.invoice)
            print(json.dumps(entry, ensure_ascii=False))
        elif args.command == 'migrate-legacy-asks':
            rows = migrate_legacy_asks(DATA, args.dry_run)
            print(('Would migrate' if args.dry_run else 'Migrated') + f' {len(rows)} legacy asks.')
            for row in rows:
                print(row)
        elif args.command == 'unasked':
            if args.ask and args.all:
                raise CaseError('--all is read-only; use it without --ask')
            if args.ask:
                print(unasked(DATA))
            else:
                excluded = [] if args.all else None
                rows = unasked_candidates(DATA, now_dubai(), excluded=excluded)
                if args.all and args.json:
                    rows += excluded
                print(json.dumps(redact_all(rows), ensure_ascii=False, indent=1) if args.json else
                      '\n'.join(unasked_line(row) for row in rows) or 'No unasked charges.')
                if args.all and not args.json:
                    for row in excluded:
                        print(redact(f"{row['id']}: skipped ({row['skip']})"))
        elif args.command == 'charge':
            charge = charges.parse(args.alert, args.sender)
            if not charge:
                raise CaseError('not a card charge or decline alert this reads')
            now = parse_time(args.now) if args.now else now_dubai()
            observed = parse_time(args.at) if args.at else now
            q = question_for(load_questions(DATA), charge, observed, channel(args.sender))
            matched = subscription_match(DATA, charge, observed) if args.at else None
            r = matched or explain_charge(DATA, charge, observed, now, time.time() + 30, qid=q['id'] if q else None)
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
            qs = [q for q in load_questions()['questions'] if args.all or (active(q) and charges.card_owner(charge_of(q)) == 'abdullah')]
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
            _CLI_WATCHDOG.set(True)
            wd = Path(os.environ.get('WATCH_DIR', LIVE))
            wd.mkdir(parents=True, exist_ok=True)
            data = DATA
            if wd.resolve() != LIVE.resolve():
                # robob-watch test runs a copy of the watcher folder; it gets a copy of the books too.
                data = wd / 'scratch-books'
                if not data.exists():
                    data.mkdir(mode=0o700)
                    for name in ('cases.json', 'questions.json', 'cards.json', 'subscriptions.json'):
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
            line = brief(visible_cases(DATA))
            if line:
                print(line)
        elif args.command == 'list':
            cases = [c for c in visible_cases(DATA) if args.all or (active(c) and case_owner(c) == 'abdullah')]
            print(json.dumps(redact_all(cases), ensure_ascii=False, indent=1) if args.json else table(cases))
        elif args.command == 'show':
            case_id = next((q['case'] for q in load_questions(DATA)['questions']
                            if q['id'] == args.id and active(q) and q.get('case')), args.id)
            print(json.dumps(redact_all(find({'cases': visible_cases(DATA)}, case_id)), ensure_ascii=False, indent=1))
        elif args.command == 'add':
            case = add(DATA, args.id, args.merchant, args.amount, args.currency, args.state, args.next,
                       args.deadline, args.who, args.reference, args.why, args.watcher, charged=args.charged,
                       kind=args.kind, unmatched=args.unmatched, repeat=args.repeat, distinct=args.distinct, due=args.due)
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
            sweep_dead_card(DATA, args.last4, end=time.time() + 60)
            print(f'card {args.last4} marked dead')
        elif args.command == 'subs':
            if args.subs_command in ('add', 'edit', 'remove'):
                changes = {f: getattr(args, f) for f in SUB_FIELDS if getattr(args, f, None) is not None}
                result = sub_change(DATA, args.id, changes, args.subs_command)
            else:
                result = subscriptions_due(DATA, now_dubai(), args.days) if args.subs_command == 'due' else load_subscriptions(DATA)['subscriptions']
            print(json.dumps(redact_all(result), ensure_ascii=False, indent=1))
        elif args.command == 'cards':
            print(json.dumps(redact_all(dead_cards(DATA)), ensure_ascii=False, indent=1))
        elif args.command == 'card-swap':
            changes = card_swap(DATA, args.old, args.new, args.also, dry_run=args.dry_run, cases=args.case)
            if not args.dry_run:
                for last4 in sorted({args.old, *args.also}):
                    sweep_dead_card(DATA, last4, end=time.time() + 60)
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
            close(DATA, args.id, args.outcome, source=args.source)
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
