"""Is a card alert already explained, before anyone asks the owner about it?

Owner rule (nightly 2026-10-24): before asking about a charge, look for its receipt or order mail
(same amount and merchant, from two hours before the charge on), look at what he typed in his own
threads around the charge, and when it's a merchant he already pays, wait for the receipt ("Wait for
the email", 24 Oct). Only a charge none of these explain goes to him.
"""
import datetime as dt
from decimal import Decimal, InvalidOperation
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
from zoneinfo import ZoneInfo
import order_lookup

TZ = ZoneInfo('Asia/Dubai')
MSGS = os.environ.get('MONEY_CASES_MSGS', str(Path('~/.local/bin/msgs').expanduser()))
# The installer puts the helper beside this check; the source tree shares helpers/.
if not Path(__file__).with_name('robob_readonly.py').exists():
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'helpers'))
from robob_readonly import connect_replica, replica_path

STATE_DB = replica_path('MONEY_CASES_STATE_DB')
RECEIPT_BEFORE = dt.timedelta(hours=2)
# Hits asked for per receipt search, and mails read from them: a receipt buried under usage notices
# with the same amount is still found, without an unbounded number of reads.
RECEIPT_HITS = 60
RECEIPT_READS = 12
# A receipt under another name (Stripe's legal entity, a reseller) counts only this close to the
# charge and only when it shows the same card's last four digits.
SAME_TIME = dt.timedelta(minutes=15)
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


def card_owner(charge):
    path = Path(os.environ.get('MONEY_CASES_SETTINGS', Path(__file__).with_name('settings.json')))
    try:
        owners = json.loads(path.read_text())['card_owners']
        if not isinstance(owners, dict) or any(value not in ('abdullah', 'moni') for value in owners.values()):
            raise ValueError('invalid card owners')
        return owners.get(charge['card'], owners.get('Wio', 'abdullah'))
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise Lookup('card owners: settings unreadable') from e


def order_receipt(charge, at, now, deadline=None, lookup=None):
    merchant = charge['merchant'].lower()
    app = 'careem' if 'careem' in merchant else 'noon' if 'noon' in merchant else None
    if not app:
        return None
    try:
        result = (lookup or order_lookup.read)(app, deadline=deadline)
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
        if not complete:
            raise ValueError('incomplete history cannot authorize an ask')
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
    key = tuple(argv)
    if memo is not None and key in memo:
        result = memo[key]
        if isinstance(result, Lookup):
            raise result
        return result
    timeout = left(deadline, cap)
    if stats is not None:
        stats['msgs_calls'] += 1
    try:
        done = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
        if done.returncode:
            raise Lookup(f'msgs exit {done.returncode}: {done.stderr.strip()[:200]}')
    except (OSError, subprocess.TimeoutExpired, Lookup) as e:
        error = e if isinstance(e, Lookup) else Lookup(f'msgs: {e}')
        if memo is not None:
            memo[key] = error
        raise error from e
    if memo is not None:
        memo[key] = done
    return done


def day(t):
    return t.astimezone(TZ).date().isoformat()


def search(query, since, until=None, source=None, n=20, deadline=None, memo=None, stats=None):
    """Rows from the message archive (the msgs CLI), newest first, without bodies."""
    cmd = [MSGS, 'search', query, '--json', '-n', str(n), '--date', '--since', since]
    if until:
        cmd += ['--until', until]
    if source:
        cmd += ['--in', source]
    done = msgs(cmd, deadline, 15, memo, stats)
    # split on '\n' only: msgs prints ensure_ascii=False JSON, so a snippet can hold
    # U+2028, \x85 or \x1c-\x1e, which str.splitlines() would treat as line breaks.
    try:
        rows = [json.loads(line) for line in done.stdout.split('\n') if line.strip()]
        if any(not isinstance(row, dict) for row in rows):
            raise ValueError('invalid search row')
        return rows
    except ValueError as e:
        raise Lookup('msgs: unreadable search output') from e


def iso(t):
    return t.astimezone(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


# Fields only automation puts on a turn: a scheduled run, a notification, a delegated result, a message
# from another thread. A turn carrying any of them is never his typing, whoever it is stamped as.
AUTOMATED = ('scheduledTaskId', 'notification', 'delegatedCompletion', 'senderThreadId')
# Inbound ids the iMessage bridge makes up for its own turns: watcher wakes, context resets, secure forms.
SYNTHETIC_IDS = ('wake:', 'reset:', 'secret:')
INBOUND_ID = re.compile(r'Current incoming message ID: ("(?:[^"\\]|\\.)*")')


def inbound_id(payload):
    """The iMessage the bridge relayed in this turn, from its channel-guidance record, or None."""
    context = payload.get('context')
    records = context.get('records') if isinstance(context, dict) else None
    for record in records if isinstance(records, list) else []:
        if not isinstance(record, dict) or record.get('kind') != 'ardud-guidance':
            continue
        body = record.get('payload')
        m = INBOUND_ID.search(str(body.get('text') or '') if isinstance(body, dict) else '')
        if m:
            try:
                return str(json.loads(m.group(1)))
            except ValueError:
                return None
    return None


# Where the app stamps a turn he typed himself. 'server' 'user' turns are coord, crw and forwards.
APP_SOURCES = ('web', 'mobile', 'desktop')


def owner_turn(payload, title=''):
    """Whether a Robob user turn is his own typing. A turn automation made (a schedule run under his saved
    actor, a notification, a delegated result, another thread's message) never is. Otherwise: a 'user'
    turn typed in the app, or, in his iMessage thread, a turn relaying a real inbound iMessage. Scheduled
    prompts, kanban and watcher wakes carry no relayed id, or a made-up wake:/reset:/secret: one."""
    if any(payload.get(k) for k in AUTOMATED):
        return False
    if payload.get('createdBy') == 'user' and payload.get('creationSource') in APP_SOURCES:
        return True
    if payload.get('createdBy') not in ('user', 'system') or not str(title or '').startswith('iMessage'):
        return False
    iid = inbound_id(payload)
    return bool(iid) and not iid.startswith(SYNTHETIC_IDS) and not str(payload.get('text') or '').lstrip().startswith('[')


def owner_texts(since, until, deadline=None, stats=None):
    """What the owner typed in his own Robob threads (app or iMessage) between two times."""
    left(deadline, 4)
    stop = time.time() + (4 if deadline is None else min(4, deadline - time.time() - 0.5))
    try:
        db = connect_replica(STATE_DB)
        try:
            db.set_progress_handler(lambda: int(time.time() >= stop), 10000)
            if stats is not None:
                stats['owner_queries'] += 1
            rows = db.execute(
                'SELECT m.created_at, m.payload_json, t.title FROM orchestration_v2_projection_threads t '
                'CROSS JOIN orchestration_v2_projection_messages m ON m.thread_id = t.thread_id '
                'AND m.created_at BETWEEN ? AND ? WHERE t.updated_at >= ? AND m.role = ?',
                (iso(since), iso(until), iso(since), 'user')).fetchall()
        finally:
            db.close()
    except (sqlite3.Error, OSError, ValueError) as e:
        if isinstance(e, sqlite3.OperationalError) and 'interrupted' in str(e):
            raise Lookup('Robob state: query over time') from e
        raise Lookup(f'Robob state: {e}') from e
    out = []
    for created, payload, title in rows:
        try:
            p = json.loads(payload)
        except ValueError:
            continue
        text = str(p.get('text') or '') if isinstance(p, dict) else ''
        # Other people's chats and forwarded turns never count.
        if not isinstance(p, dict) or not owner_turn(p, title) or text.startswith('[Forwarded by') \
                or re.match(r'(?:Moni|Group)\b', title or ''):
            continue
        out.append((created, text, title or ''))
    return out


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


def alert_text(shown):
    """The message itself from msgs show: a chat is shown with its neighbours, its own line marked >."""
    for line in shown.splitlines():
        if line.startswith('>'):
            return re.sub(r'^>\s*\d+ \S+ \S+ [^:]*: ', '', line)
    return shown


HEADER = re.compile(r'^(?:Account|Date|From|To|Cc|Subject|File|Message-ID|Folder):', re.I)


def body_key(text):
    """The mail's words without its headers: copies of one notice differ only in Date and File."""
    lines = [ln for ln in str(text).splitlines() if not HEADER.match(ln.strip())]
    return ' '.join(' '.join(lines).split())


def receipt(charge, at, now, find=None, deadline=None, read=None, memo=None, stats=None):
    """The receipt or order mail for a charge. It shows the amount as money in the charge's currency
    and reads as a receipt, and either names the merchant (from two hours before the charge on) or,
    under another name, shows the card's last four digits within 15 minutes of it. Search hits are
    checked against the mail itself."""
    options = {'memo': memo, 'stats': stats} if memo is not None else {}
    find = find or (lambda *a, **kw: search(*a, **kw, **options))
    read = read or (lambda row, deadline: show(row, deadline, **options))
    amount = ' OR '.join(f'"{v}"' for v in amounts(charge))
    money, card = amount_pattern(charge), last_four(charge)
    names = words(charge['merchant'])
    named = re.compile(r'\b(?:' + '|'.join(map(re.escape, names)) + r')\b', re.I) if names else None
    tries = []
    if names:
        tries.append((amount + ' ' + ' OR '.join(f'"{w}"' for w in names), at - RECEIPT_BEFORE, now,
                      lambda text: named.search(text) and RECEIPT_WORDS.search(text)))
    tries.append((amount, at - SAME_TIME, min(now, at + SAME_TIME),
                  lambda text: card.search(text) and RECEIPT_WORDS.search(text)))
    reads, seen_bodies = 0, set()
    for query, start, end, proves in tries:
        # Usage notices with the same amount and merchant can fill a page of hits, so the search goes
        # wider than one page. Reads are capped, and a body already read counts for nothing new: a
        # run of identical notices must not use up the reads before the receipt.
        for row in find(query, day(start), source='email', n=RECEIPT_HITS, deadline=deadline):
            ts = row.get('ts') or 0
            if not (start.timestamp() <= ts <= end.timestamp() + 60) or row.get('from_me') \
                    or BANKS.search(str(row.get('sender') or '')):
                continue
            text = read(row, deadline)
            key = body_key(text)
            if key in seen_bodies:
                continue
            if reads >= RECEIPT_READS:
                return None
            reads += 1
            seen_bodies.add(key)
            if money.search(text) and proves(text):
                return row
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


def known(charge, at, find=None, deadline=None, read=None):
    """How he already pays this merchant, from before the last half day: 'receipt' when a mail with
    a receipt from it came, 'bank' when an earlier bank alert was a charge from it, else None."""
    find, read = find or search, read or show
    names = words(charge['merchant'])
    if not names:
        return None
    key, before = set(names), at - KNOWN_GAP
    named = ' OR '.join(f'"{w}"' for w in names)
    since, until = day(at - KNOWN_SINCE), day(before)
    name_re = re.compile(r'\b(?:' + '|'.join(map(re.escape, names)) + r')\b', re.I)

    def older(rows):
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


def found(charge, at, now, deadline=None, find=None, said=None, errors=None, memo=None, stats=None):
    """A receipt or his own words that explain the charge, or None."""
    errors = [] if errors is None else errors
    try:
        row = receipt(charge, at, now, find, deadline, memo=memo, stats=stats)
        if row:
            when = dt.datetime.fromtimestamp(row['ts'], TZ).strftime('%a %d %b %H:%M')
            return {'verdict': 'receipt', 'why': f"receipt {when}: {row.get('sender', '')} - {row.get('subject', '')}"[:200],
                    'msgs': row.get('id'), 'errors': errors}
    except Lookup as e:
        errors.append(f'receipt: {e}')
    try:
        hit = order_receipt(charge, at, now, deadline)
        if hit:
            return {**hit, 'errors': errors}
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


def explain(charge, at, now, deadline=None, find=None, said=None):
    """verdict receipt | owner | wait | ask, with why and any lookup errors."""
    errors = []
    owner = card_owner(charge)
    if charge['kind'] != 'charge' and owner == 'moni':
        return {'verdict': 'held', 'why': 'held for Moni', 'errors': []}
    if charge['kind'] != 'charge':
        return {'verdict': 'ask', 'why': 'a declined payment goes to him', 'errors': errors}
    hit = found(charge, at, now, deadline, find, said, errors)
    if hit:
        return hit
    if errors:
        return {'verdict': 'unverified', 'why': 'sources unreadable; do not ask', 'errors': errors}
    if owner == 'moni':
        return {'verdict': 'held', 'why': 'held for Moni', 'errors': []}
    if now < at + WAIT:
        try:
            how = known(charge, at, find, deadline)
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
