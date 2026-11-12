"""Bank payment notices shared by inbox triage and the bounded autopay follow-up."""
import datetime as dt
from decimal import Decimal
import re
from zoneinfo import ZoneInfo

TZ = ZoneInfo('Asia/Dubai')
BANKS = {
    'Wio': r'\bwio\b',
    'ENBD': r'\b(?:enbd|emirates\s*nbd|emiratesnbd)\b',
    'Mashreq': r'\bmashreq(?:bank)?\b',
    'ADCB': r'\b(?:adcb(?:alerts)?|abu dhabi commercial bank)\b',
    'FAB': r'\b(?:fab(?:bank)?|first abu dhabi bank)\b',
    'Amex': r'\b(?:amex|american express|aexp\.com)\b',
}
AUTOPAY = r'(?:auto[ -]?pay|auto(?:matic)?[ -]?debit|automatic payment)'
_AMOUNT_CLAUSE = r'(?:\s+(?:of|for)\s+[A-Z]{3}\s*[\d,.]+)?'
_SUCCESS_STATE = r'(?:(?:was|is|has been)\s+)?(?:successfully\s+)?(?:successful|succeeded|completed|processed|received|credited|debited)'
SUCCESS = re.compile(rf'\b(?:{AUTOPAY}|payment){_AMOUNT_CLAUSE}\s+{_SUCCESS_STATE}\b', re.I)
FAILURE = re.compile(rf'\b(?:{AUTOPAY}|(?:card )?payment)\b.{{0,70}}\b(?:failed|unsuccessful|declined|could not be processed)\b', re.I)
EXPECTED = re.compile(rf'\b{AUTOPAY}\b.{{0,100}}\b(?:scheduled|due|tonight|today|will be (?:debited|processed))\b', re.I)
PAY_DUE = re.compile(r'\bpayment(?:\s+of\s+[A-Z]{3}\s*[\d,.]+)?\s+(?:is\s+)?due\s+(?:before|by|on)\b|\b(?:repay|pay|payment\s+(?:is\s+)?due)\s+(?:before|by|on)\b|\bto avoid (?:interest|(?:a )?late (?:payment )?fee)', re.I)
PROMO = re.compile(r'\b(?:\d+\s*%\s*off|cashback|cash back|discount|promotion|reward points)\b', re.I)
MONEY = re.compile(r'\b(?P<c>AED|USD|EUR|GBP)\s*(?P<a>\d+(?:,\d{3})*(?:\.\d{2})?)(?!\d|[.,]\d)|(?<![\d.,])(?P<b>\d+(?:,\d{3})*(?:\.\d{2})?)\s*(?P<d>AED|USD|EUR|GBP)\b', re.I)


def institution(sender):
    return next((bank for bank, pattern in BANKS.items() if re.search(pattern, sender, re.I)), None)


def due_time(text, at):
    """Interpret only the deadline clause, relative to the notice's Dubai date."""
    marker = re.search(r'\b(?:before|by|due(?!\s+to\b)(?:\s+(?:on|at))?|scheduled(?:\s+(?:on|at|for))?|(?:debited|processed)\s+(?:on|at)|tonight|today|tomorrow)\b', text, re.I)
    if not marker:
        return None
    clause = re.split(r';|\.\s', text[marker.start():marker.start() + 100].lower(), maxsplit=1)[0]
    date = at.date() + dt.timedelta(days=bool(re.search(r'\btomorrow\b', clause)))
    weekdays = ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')
    iso = re.search(r'\b(20\d{2}-\d{2}-\d{2})\b', clause)
    numeric = re.search(r'\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b', clause)
    named = re.search(r'\b(\d{1,2})(?:st|nd|rd|th)?\s+((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)(?:\s+(20\d{2}))?\b', clause)
    try:
        if iso:
            date = dt.date.fromisoformat(iso[1])
        elif numeric:
            date = dt.date(int(numeric[3]), int(numeric[2]), int(numeric[1]))
        elif named:
            for fmt in ('%d %B %Y', '%d %b %Y'):
                try:
                    date = dt.datetime.strptime(f'{named[1]} {named[2]} {named[3] or at.year}', fmt).date()
                    break
                except ValueError:
                    pass
            else:
                return None
        else:
            weekdays = ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')
            for index, name in enumerate(weekdays):
                if re.search(r'\b' + name + r'\b', clause):
                    date += dt.timedelta(days=(index - date.weekday()) % 7)
                    break
    except ValueError:
        return None
    if 'midnight' in clause:
        clock = dt.time(23, 59)
    else:
        clock_match = re.search(r'(?<![\d-])(\d{1,2}):(\d{2})(?:\s*([ap])\.?m\.?)?(?!\d)|\b(\d{1,2})\s*([ap])\.?m\.?', clause)
        if clock_match:
            hour = int(clock_match[1] or clock_match[4])
            minute = int(clock_match[2] or 0)
            ampm = clock_match[3] or clock_match[5]
            if ampm:
                if not 1 <= hour <= 12:
                    return None
                hour = hour % 12 + (12 if ampm == 'p' else 0)
            try:
                clock = dt.time(hour, minute)
            except ValueError:
                return None
        elif iso or numeric or named or re.search(r'\b(?:today|tonight|tomorrow|' + '|'.join(weekdays) + r')\b', clause):
            clock = dt.time(23, 59)
        else:
            return None
    return dt.datetime.combine(date, clock, TZ)


def parse(text, sender, at):
    # Require a bank sender, not a bank name quoted in a merchant promotion.
    bank = institution(sender)
    if not bank or not at:
        return None
    text = ' '.join(text.split())
    failed = FAILURE.search(text)
    if PROMO.search(text) and not failed:
        return None
    if re.search(r'\b(?:not|never)\s+(?:been\s+)?(?:received|successful|credited)|\bno payment (?:was )?received', text, re.I):
        success = None
    else:
        success = SUCCESS.search(text)
    if success and (re.search(rf'\b(?:if|whether|when|once|until|hope)\b.{{0,100}}\b(?:{AUTOPAY}|payment)\b', text, re.I) or
                    re.search(r'\b(?:reversed|reversal|returned|cancelled|canceled|rejected)\b', text, re.I)):
        success = None
    if success and re.search(r'\b(?:savings|current) account\b|\binward (?:transfer|remittance)\b', text, re.I):
        return None
    expected = EXPECTED.search(text)
    if not re.search(AUTOPAY, text, re.I):
        merchant = re.search(r'\b(?:card )?payment(?:\s+of)?\s+(?:[A-Z]{3}\s*)?[\d,.]+\s+(?:at|to)\s+([a-z][\w.-]*)', text, re.I)
        if re.search(r'\b(?:debit card|purchase|pos|ecommerce|merchant|transaction)\b', text, re.I) or (merchant and not institution(merchant[1])):
            return None
    if success and not failed:
        kind = 'payment_success'
    elif failed:
        kind = 'payment_deadline'
    elif expected:
        kind = 'autopay_expected'
    elif PAY_DUE.search(text):
        kind = 'payment_deadline'
    else:
        return None
    amounts = list(MONEY.finditer(text))
    if not amounts:
        return None
    # Multiple different amounts (minimum, balance, payment) need full-message review.
    values = {(m['c'] or m['d']).upper() + ':' + str(Decimal((m['a'] or m['b']).replace(',', '')).quantize(Decimal('.01'))) for m in amounts}
    if len(values) != 1:
        return None
    currency, amount = values.pop().split(':')
    at = at.astimezone(TZ)
    due = due_time(text, at) if kind != 'payment_success' else None
    repayment = re.search(r'\b(?:repay|pay|payment(?:\s+of\s+[A-Z]{3}\s*[\d,.]+)?\s+(?:is\s+)?due)\s+(?:before|by|on|at)\b', text, re.I)
    repayment_due = due_time(text[repayment.start():], at) if repayment else None
    if kind == 'payment_deadline':
        due = repayment_due
    if due is None and kind != 'payment_success':
        return None
    return {'kind': kind, 'institution': bank, 'amount': amount, 'currency': currency,
            'at': at.isoformat(timespec='seconds'),
            'deadline': due.isoformat(timespec='seconds') if due else None,
            'stated_deadline': due.isoformat(timespec='seconds') if due else None,
            'repayment_deadline': repayment_due.isoformat(timespec='seconds') if repayment_due else None}
