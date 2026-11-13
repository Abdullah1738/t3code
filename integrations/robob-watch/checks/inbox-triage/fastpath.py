"""Deterministic security alerts; no message body is copied into an alert."""
from decimal import Decimal, InvalidOperation
from email.utils import parseaddr
from html.parser import HTMLParser
import os
from pathlib import Path
import re
import sys
import time

HELPERS = Path(__file__).resolve().parents[2] / 'helpers'
if not (HELPERS / 'toollog.py').is_file():
    HELPERS = Path.home() / '.local/share/robob-watch/helpers'
sys.path.insert(0, str(HELPERS))
try:
    from toollog import tool_error, tool_log
except ImportError:
    # Scratch checks also run while an older helpers install is still in place.
    def tool_log(*_args, **_kwargs):
        pass

    def tool_error(*_args, **_kwargs):
        pass

# These currencies have fixed USD pegs. Other currencies need an explicit local rate.
AED_RATES = {'AED': '1', 'USD': '3.6725', 'SAR': str(Decimal('3.6725') / Decimal('3.75')),
             'QAR': str(Decimal('3.6725') / Decimal('3.64')),
             'BHD': str(Decimal('3.6725') / Decimal('0.376')),
             'OMR': str(Decimal('3.6725') / Decimal('0.3845'))}
BANK = re.compile(r'emirates[ -]*nbd|emirates[ -]*islamic|\bei[ -]*sms\b|mashreq|adcb|\bwio|\bfab\b|first abu dhabi|\bdib\b|dubai islamic|rakbank|hsbc|citi(?:bank)?|standard.?chartered', re.I)
AUTH = re.compile(r'\b(?:otp|one[- ]time (?:password|code)|verification code|security code|login code|sign[- ]in code|authentication code|passcode|apple (?:id|account) code)\b', re.I)
MAGIC = re.compile(r'\b(?:(?:secure|magic|sign[- ]in|login) link|link to (?:sign[- ]in|log\s?in|claude))\b', re.I)
SIGNIN_BUTTON = re.compile(r'(?:sign[- ]in|log[- ]?in)(?:\s+(?:to|with)\s+[\w .-]{1,50})?', re.I)
NEW_LOGIN = re.compile(r'\b(?:new[- ](?:login|sign[- ]in)|(?:sign[- ]in|log(?:ged)?[- ]in|login) (?:to .{0,40}? )?(?:on|from|with) (?:a |an )?(?:new|unrecogni[sz]ed)|unrecogni[sz]ed (?:login|sign[- ]in))\b', re.I)
DEVICE_NOTICE = re.compile(r'\b(?:new|unrecogni[sz]ed)[- ]device\b.{0,50}\b(?:registered|registration|added|linked|detected|connected|signed|logged|accessed)\b'
                           r'|\b(?:registered|added|linked|detected|connected|accessed|signed|logged)\b.{0,50}\b(?:new|unrecogni[sz]ed)[- ]device\b', re.I)
SIM = re.compile(r'\b(?:e?sim(?: card)?[ -](?:(?:has been|was|is being|will be) )?(?:successfully )?(?:swap(?:ped|ping)?|replacement|replaced|change|changed|transfer(?:red)?|converted)|(?:swap|replace|convert|transfer|switch)(?:ped|d|ed|ment|ing)? .{0,40}\be?sim|sim\s*(?:to|→|->)\s*esim|port[- ]?out|number.{0,25}\bport(?:ed|ing))\b', re.I)
MONEY = r'(?P<currency>AED|USD|SAR|QAR|BHD|OMR|KWD|EUR|GBP|INR|JPY|CHF|CAD|AUD|SGD)\s*(?P<amount>\d+(?:,\d{3})*(?:\.\d{1,3})?)(?!\d|[.,]\d)'
DEBITS = [re.compile(p, re.I) for p in (
    rf'\b(?:purchase|payment|transaction)(?: of| for| amount| amount:|:)?\s*{MONEY}',
    rf'\b(?:amount|debited|charged)\s*:?\s*{MONEY}',
    rf'\b(?:used for|purchase of)\s*{MONEY}',
    rf'\b{MONEY}\s+(?:has been |was |is )?(?:debited|charged)',
)]


def identity(sender):
    sender = str(sender or '').strip()
    return (parseaddr(sender)[1] if '@' in sender else sender).casefold()


def expected(item, actions):
    # A phone lock, recent unrelated payment, or an action after the message is no proof.
    return any(isinstance(a, dict) and a.get('sender') == identity(item.get('sender'))
               and isinstance(a.get('at'), (int, float)) and 0 <= item['ts'] - a['at'] <= 600
               and (not a.get('account') or a['account'] == item.get('account')) for a in actions)


def issued_auth(text):
    # A boilerplate "never share your OTP" footer does not mean a code was issued.
    code = r'(?:\[code\]|\d{2,4}(?:\s+\d{2,4}){1,2}\b|(?=[A-Z0-9-]{4,12}\b)(?=[A-Z0-9-]*\d)[A-Z0-9-]+)'
    connector = (r'(?:\s+(?:for|to)\s+(?:(?![.!?](?:\s|$)).){1,220}?(?:\bis\s*[:=-]?\s*|[:=]\s*)'
                 r'|\s*(?:is\s*)?[:=-]?\s*)')
    return bool(re.search(AUTH.pattern + connector + code, text, re.I)
                or re.search(code + r'\s+(?:is\s+)?your(?:\s+\w+){0,3}\s+' + AUTH.pattern, text, re.I)
                or re.search(r'\buse\s+' + code + r'\s+to\s+(?:sign[- ]in|log[- ]in|verify)', text, re.I))


def html_signin_link(value):
    # Keep only evidence: HTML-to-text conversion may discard a button's target.
    class Links(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.label = None
            self.found = False

        def handle_starttag(self, tag, attrs):
            if tag == 'a':
                target = next((v for k, v in attrs if k == 'href'), '') or ''
                self.label = [] if re.match(r'https?://', target.strip(), re.I) else None

        def handle_data(self, data):
            if self.label is not None:
                self.label.append(data)

        def handle_endtag(self, tag):
            if tag == 'a' and self.label is not None:
                label = re.sub(r'\s+', ' ', ''.join(self.label)).strip()
                self.found |= bool(SIGNIN_BUTTON.fullmatch(label))
                self.label = None

    parser = Links()
    parser.feed(value)
    return parser.found


def sender_label(sender):
    # Never copy an untrusted display name, URL, address localpart or digit sequence.
    value = identity(sender)
    names = ((r'emirates[ -]*nbd', 'Emirates NBD'), (r'emirates[ -]*islamic|\bei[ -]*sms\b', 'Emirates Islamic'),
             (r'mashreq', 'Mashreq'), (r'adcb', 'ADCB'), (r'\bwio', 'Wio'),
             (r'apple', 'Apple'), (r'google', 'Google'), (r'whoop', 'WHOOP'),
             (r'claude|anthropic', 'Claude'), (r'virgin', 'Virgin'),
             (r'etisalat|e&', 'e&'), (r'^(?:du|du\.ae)$|@(?:[^@]+\.)?du\.ae$', 'du'))
    for pattern, name in names:
        if re.search(pattern, value, re.I):
            return name
    if BANK.search(value):
        return 'your bank'
    return 'an inbox sender'


def classify(item, actions=(), rates=None):
    started = time.perf_counter()
    ids = {'watcher': os.environ.get('WATCH_ID', 'inbox-triage-fastpath'), 'item': item.get('id')}
    if os.environ.get('WATCH_RUN'):
        ids['run'] = os.environ['WATCH_RUN']
    props = {}
    source = item.get('source')
    if source == 'email':
        props['source'] = 'mail'
    elif source in ('imessage', 'sms'):
        props['source'] = 'sms'
    try:
        result = _classify(item, actions, rates)
    except Exception:
        tool_error('fastpath', 'fastpath.classify_failed', ids)
        tool_log({'component': 'fastpath', 'kind': 'perf', 'name': 'fastpath.classify', 'ok': False,
                  'durationMs': (time.perf_counter() - started) * 1000, 'ids': ids,
                  'props': {**props, 'class': 'unknown'}})
        raise
    category = {'auth': 'otp', 'debit': 'charge', 'sim': 'security', 'login': 'security'}.get((result or {}).get('kind'), 'unknown')
    if category == 'charge':
        props['source'] = 'charge'
    tool_log({'component': 'fastpath', 'kind': 'perf', 'name': 'fastpath.classify', 'ok': True,
              'durationMs': (time.perf_counter() - started) * 1000, 'ids': ids,
              'props': {**props, 'class': category}})
    return result


def _classify(item, actions=(), rates=None):
    if item.get('source') not in ('email', 'imessage', 'sms'):
        return None
    sender = identity(item.get('sender'))
    text = re.sub(r'\s+', ' ', ' '.join(str(item.get(k) or '') for k in ('subject', 'preview')))
    label = sender_label(sender)
    if re.search(r'etisalat|e&|virgin|^(?:du|du\.ae)$|@(?:[^@]+\.)?du\.ae$', sender, re.I) and SIM.search(text):
        return {'kind': 'sim', 'text': f'Security: SIM/eSIM swap or port-out notice from {label}. Check your mobile account now.'}
    button = (item.get('signin_link')
              or re.search(r'\b(?:sign[- ]in|log[- ]?in)[\s:\[(]*(?:https?://|\[link\])', text, re.I))
    # Receipts and debit notices also carry ordinary portal buttons in their footers.
    issued_link = (MAGIC.search(str(item.get('subject') or ''))
                   or re.search(r'^\s*(?:please\s+)?(?:sign[- ]in|log[- ]?in)\b', str(item.get('subject') or ''), re.I)
                   or re.search(r'\b(?:this|your|the)\s+link\s+(?:will\s+)?(?:expires?\b|is\s+valid\s+for\b)', text, re.I))
    magic = (MAGIC.search(text) and re.search(r'https?://|\[link\]', text, re.I)
             or button and issued_link)
    if not item.get('list_unsubscribe') and item.get('precedence') not in ('bulk', 'list', 'junk') and (issued_auth(text) or magic):
        if expected(item, actions):
            return None
        what = 'a sign-in link' if magic else 'an OTP'
        return {'kind': 'auth', 'text': f'Security: {what} from {label}; no matching in-flight action in the last 10 minutes. Check sessions and rotate if these keep arriving.'}
    if (BANK.search(sender) or re.search(r'apple|google', sender, re.I)) and (
            NEW_LOGIN.search(text) or DEVICE_NOTICE.search(text)
            or re.search(r'\b(?:apple (?:id|account)|google account)\b.{0,40}\bwas used to sign[- ]in\b', text, re.I)):
        return {'kind': 'login', 'text': f'Security: new-device or login alert from {label}. Check your account sessions.'}
    if not BANK.search(sender) or not re.search(r'\bcard\b', text, re.I):
        return None
    if not re.search(r'\b(?:purchase|payment|transaction|debited|charged|used for)\b', text, re.I):
        return None
    matches = [m for pattern in DEBITS for m in pattern.finditer(text)
               if not re.search(r'\b(?:balance|available|limit)\b[^.!?]*$', text[:m.start()], re.I)]
    match = min(matches, key=lambda m: m.start()) if matches else None
    if not match:
        return None
    # Only the transaction's sentence establishes its status; bank footers mention failures,
    # refunds and statements too. Decimal points do not end a sentence.
    boundaries = [m.end() for m in re.finditer(r'[.!?](?:\s+|$)', text)]
    start = max((p for p in boundaries if p <= match.start()), default=0)
    end = min((p for p in boundaries if p > match.end()), default=len(text))
    clause = text[start:end]
    if re.search(r"\b(?:not|never|hasn['’]t|haven['’]t|wasn['’]t|weren['’]t|isn['’]t|aren['’]t|won['’]t|cannot|can['’]t)"
                 r'(?:(?:\s+)(?:been|be|being|yet|actually|successfully)){0,4}\s+(?:charged|debited|deducted|collected)\b'
                 r'|\bno\s+(?:money|funds|amount)\s+(?:was\s+|has\s+been\s+)?(?:charged|debited|deducted)\b', clause, re.I):
        return None
    if re.search(r'\b(?:will|shall|may|can|would)\s+(?:soon\s+)?(?:be\s+)?(?:charged|debited|deducted|collected|processed)\b'
                 r'|\b(?:is|was|becomes?|falls?|remains?)\s+due\b'
                 r'|\bdue\s+(?:on|by|before|within|today|tomorrow|now)\b|\bdue\s+\d'
                 r'|\bpayable\b|\b(?:must|should)\s+be\s+paid\b'
                 r'|\b(?:is|are)\s+(?:going|about)\s+to\s+be\s+(?:charged|debited|deducted)\b'
                 r'|\b(?:scheduled|upcoming)\s+(?:card\s+)?(?:payment|charge|debit)\b'
                 r'|\b(?:payment|charge|debit)\b.{0,40}\bscheduled\b|\breminder\b', clause, re.I):
        return None
    if re.search(r'\b(?:received|towards|credited)\b', clause, re.I) and re.search(r'\b(?:card|payment)\b', clause, re.I):
        return None
    if re.search(r'\b(?:declined|failed|refund(?:ed)?|revers(?:al|ed)|credited|credit received|payment due|minimum due|statement)\b', clause, re.I):
        return None
    precision = 3 if match['currency'].upper() in ('BHD', 'OMR', 'KWD') else 2
    if '.' in match['amount'] and len(match['amount'].split('.')[1]) > precision:
        return None
    currency, amount = match['currency'].upper(), Decimal(match['amount'].replace(',', ''))
    try:
        rate = Decimal(str({**AED_RATES, **(rates or {})}.get(currency, '0')))
        if not rate.is_finite() or rate <= 0 or amount * rate < 1000:
            return None
    except (InvalidOperation, TypeError, ValueError):
        tool_error('fastpath', 'fastpath.rate_invalid', {'watcher': os.environ.get('WATCH_ID', 'inbox-triage-fastpath'), 'item': item.get('id')})
        return None
    card = re.search(r'\bcard\s*(?:(?:ending|number|no\.?|used|with)\s*[:#-]?\s*)*(?:[xX* -]*)(\d[\d -]{2,25}\d)', text, re.I)
    digits = re.sub(r'\D', '', card[1]) if card else ''
    suffix = f' (card ending {digits[-4:]})' if len(digits) >= 4 else ''
    return {'kind': 'debit', 'text': f'Bank debit: {currency} {amount:,.{precision}f}{suffix}, reported by {label}. Check the bank notice and receipt.'}
