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
import time
from zoneinfo import ZoneInfo

TZ = ZoneInfo('Asia/Dubai')
MSGS = os.environ.get('MONEY_CASES_MSGS', str(Path('~/.local/bin/msgs').expanduser()))
STATE_DB = Path(os.environ.get('MONEY_CASES_STATE_DB', '~/.robob/userdata/statev2.sqlite')).expanduser()
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
# His words mention a charge without owning it when he denies it or asks about it.
NOT_MINE = re.compile(r"\?|n't\b|\b(?:not|never|no idea|unknown|recogni[sz]e|fraud|scam|stolen|block|dispute|"
                      r"cancel|refund|who|what|why|which)\b", re.I)
# His words own a payment: he is ordering, paying, subscribing or topping up (not just naming a merchant).
OWNER_BUYS = re.compile(r"\b(?:order(?:ing|ed|s)?|paying|paid|pay(?:ing)? (?:for|the)|set ?up|subscrib(?:e|ed|ing)|"
                        r"top(?:ped|ping)? up|bought|buying)\b", re.I)


class Lookup(Exception):
    """A source couldn't be read; the charge is then not explained by it."""


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


def day(t):
    return t.astimezone(TZ).date().isoformat()


def search(query, since, until=None, source=None, n=20, deadline=None):
    """Rows from the message archive (the msgs CLI), newest first, without bodies."""
    cmd = [MSGS, 'search', query, '--json', '-n', str(n), '--date', '--since', since]
    if until:
        cmd += ['--until', until]
    if source:
        cmd += ['--in', source]
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=left(deadline, 15))
    except (OSError, subprocess.TimeoutExpired) as e:
        raise Lookup(f'msgs: {e}') from e
    if done.returncode:
        raise Lookup(f'msgs exit {done.returncode}: {done.stderr.strip()[:200]}')
    return [json.loads(line) for line in done.stdout.splitlines() if line.strip()]


def iso(t):
    return t.astimezone(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def owner_texts(since, until, deadline=None):
    """What the owner typed in his own Robob threads (app or iMessage) between two times."""
    left(deadline, 5)
    try:
        db = sqlite3.connect(f'file:{STATE_DB}?mode=ro', uri=True, timeout=2)
        try:
            rows = db.execute(
                'SELECT m.created_at, m.payload_json, t.title FROM orchestration_v2_projection_threads t '
                'CROSS JOIN orchestration_v2_projection_messages m ON m.thread_id = t.thread_id '
                'AND m.created_at BETWEEN ? AND ? WHERE t.updated_at >= ? AND m.role = ?',
                (iso(since), iso(until), iso(since), 'user')).fetchall()
        finally:
            db.close()
    except sqlite3.Error as e:
        raise Lookup(f'Robob state: {e}') from e
    out = []
    for created, payload, title in rows:
        try:
            p = json.loads(payload)
        except ValueError:
            continue
        text = str(p.get('text') or '')
        # The bridge stamps the owner's iMessage turns 'system' (control/http.ts), so 'user' alone drops
        # all of them. Synthetic wakes and other people's chats still don't count as his words.
        if p.get('createdBy') not in ('user', 'system') or text.startswith('[Forwarded by') \
                or re.match(r'(?:Moni|Group)\b', title or ''):
            continue
        out.append((created, text, title or ''))
    return out


def show(row, deadline=None):
    """The whole mail for a search row (msgs show)."""
    try:
        done = subprocess.run([MSGS, 'show', str(row['id'])], capture_output=True, text=True,
                              timeout=left(deadline, 10))
    except (OSError, subprocess.TimeoutExpired, KeyError) as e:
        raise Lookup(f'msgs show: {e}') from e
    if done.returncode:
        raise Lookup(f'msgs show exit {done.returncode}: {done.stderr.strip()[:200]}')
    return done.stdout


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


def receipt(charge, at, now, find=None, deadline=None, read=None):
    """The receipt or order mail for a charge. It shows the amount as money in the charge's currency
    and reads as a receipt, and either names the merchant (from two hours before the charge on) or,
    under another name, shows the card's last four digits within 15 minutes of it. Search hits are
    checked against the mail itself."""
    find, read = find or search, read or show
    amount = ' OR '.join(f'"{v}"' for v in amounts(charge))
    money, card = amount_pattern(charge), last_four(charge)
    names = words(charge['merchant'])
    named = re.compile(r'\b(?:' + '|'.join(map(re.escape, names)) + r')\b', re.I) if names else None
    tries = []
    if names:
        tries.append((amount + ' ' + ' OR '.join(f'"{w}"' for w in names), at - RECEIPT_BEFORE, now,
                      lambda text: named.search(text) and (RECEIPT_WORDS.search(text) or card.search(text))))
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
            key = ' '.join(text.split())
            if key in seen_bodies:
                continue
            if reads >= RECEIPT_READS:
                return None
            reads += 1
            seen_bodies.add(key)
            if money.search(text) and proves(text):
                return row
    return None


def owner_said(charge, at, now, said=None, deadline=None):
    said = said or owner_texts
    names = words(charge['merchant'])
    if not names:
        return None
    pattern = re.compile(r'\b(?:' + '|'.join(map(re.escape, names)) + r')\b', re.I)
    for created, text, title in said(at - OWNER_AROUND, min(now, at + OWNER_AROUND), deadline=deadline):
        # Naming the merchant isn't enough: "Summarize the Apple keynote" names it without buying
        # anything. He has to say he is paying or ordering it.
        # "It isn't mine" or "what's the Acme charge?" names the merchant but explains nothing.
        if pattern.search(text) and OWNER_BUYS.search(text) and not NOT_MINE.search(text):
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


def found(charge, at, now, deadline=None, find=None, said=None, errors=None):
    """A receipt or his own words that explain the charge, or None."""
    errors = [] if errors is None else errors
    try:
        row = receipt(charge, at, now, find, deadline)
        if row:
            when = dt.datetime.fromtimestamp(row['ts'], TZ).strftime('%a %d %b %H:%M')
            return {'verdict': 'receipt', 'why': f"receipt {when}: {row.get('sender', '')} - {row.get('subject', '')}"[:200],
                    'msgs': row.get('id'), 'errors': errors}
    except Lookup as e:
        errors.append(f'receipt: {e}')
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
    if charge['kind'] != 'charge':
        return {'verdict': 'ask', 'why': 'a declined payment goes to him', 'errors': errors}
    hit = found(charge, at, now, deadline, find, said, errors)
    if hit:
        return hit
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
    return {'verdict': 'ask', 'why': 'no receipt, nothing he wrote, and nothing to wait for', 'errors': errors}
