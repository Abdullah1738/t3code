"""Credential hygiene for untrusted message text, before formatting or truncation."""
import re

REDACTED = '[redacted]'
URL_RE = re.compile(r'https?://\S+|(?:file://)?(?:/Users/|/Volumes/|/var/|/tmp/|/home/|~/)[^\s]+')
UUID_RE = re.compile(r'^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$')
LONG_RE = re.compile(r'\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{32,}\b')
STRONG = r'password|passwd|passcode|passphrase|pwd|pw|secret|private[ _-]?key|client[ _-]?secret|seed|mnemonic|recovery[ _-]?phrase|api[ _-]?key|access[ _-]?key'
WEAK = r'pass|pin|otp|2fa|mfa|code|token'
# Longer separators must win before their one-character prefixes.
SEP = r'(?:[^\S\n]*(?:=>|->|=|:|–|—|-|\bis\b)\s*|[^\S\n]*\n\s*)'
VALUE = r'''(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|"[^"\n]*|'[^'\n]*|`[^`\n]*|[^\s"'`]+)'''
# Wrappers remain in the output, including JSON property quotes and Markdown emphasis.
OPEN = r'(?<![\w-])(?P<open>\*\*|__|\*|_|`|"|\')?'
CLOSE = r'(?(open)(?P<close>(?P=open)))'
LABEL_SUFFIX = r'(?P<inner>[^\S\n]*(?:=>|->|=|:|–|—|-|\bis\b))?' + CLOSE + r'(?P<sep>(?(inner)\s*|(?:' + SEP + r'|[^\S\n]+)))'
LABEL_PATTERN = OPEN + '(?P<label>' + STRONG + '|' + WEAK + r')(?=[\W_]|$)' + LABEL_SUFFIX + r'(?P<value>' + VALUE + ')'
LABEL_RE = re.compile('(?=' + LABEL_PATTERN + ')', re.I)
STRONG_RE = re.compile('(?:' + STRONG + ')', re.I)
REAL_SEP_RE = re.compile(SEP, re.I)
PROSE_RE = re.compile(r'(?:removed|reset|resetting|resets|rotation|rotate|rotated|policy|policies|manager|management|field|fields|expiry|expired|expiration|strength|requirements|required|protected|protection|data|phrase|words|generation|sharing|shared|hash|hashing|hashes|encryption|authentication|validation|was|were|has|have|will|should|must|not|is|the|a|an|for|to|and|or)\b', re.I)
JWT_RE = re.compile(r'\beyJ[\w-]+\.[\w-]+\.[\w-]+')
KEY_RE = re.compile(r'\b(?:sk|pk|lin_api|ghp|gho|xox[bp])[-_][A-Za-z0-9_-]{12,}')
EMAIL = r'[\w.+-]+@[\w-]+\.[\w.]+'
LOGIN_RE = re.compile('(' + EMAIL + r')([^\S\n]*(?:/|,|\||\n|[^\S\n])[^\S\n]*)(' + VALUE + ')')
BLOCK_RE = re.compile(r'\b(?:login[^\S\n]+details|credentials|creds)[^\S\n]*:?(?:[^\S\n]*\n){0,2}[^\S\n]*'
                      r'(?P<user>(?:(?:user(?:name)?|email)[^\S\n]*[:=][^\S\n]*)?[^\s/:=|,]+)'
                      r'(?P<sep>[^\S\n]*(?:/|,|\||=>|->|=|:|–|—|-|\bis\b)\s*|[^\S\n]*\n\s*)'
                      r'(?P<value>' + VALUE + ')', re.I)
PHRASE_RE = re.compile(OPEN + r'(?P<label>seed|mnemonic|recovery[ _-]?phrase)(?=[\W_]|$)' + LABEL_SUFFIX + r'(?P<value>(?:[a-z]+\s+){11,23}[a-z]+)\b', re.I)
GROUPED_RE = re.compile(OPEN + r'(?P<label>pin|otp|2fa|mfa|code|passcode)(?=[\W_]|$)' + LABEL_SUFFIX + r'(?P<value>\d{2,4}(?:[ -]\d{2,4}){1,3})(?![\w-])', re.I)
HASH_RE = re.compile(r'(?:[0-9a-f]{16}|[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})', re.I)
HASH_FIELDS = {'headRefOid', 'baseRefOid', 'head_sha', 'head', 'sha', 'commitSha', 'headSha', 'trace', 'traceId', 'trace_id', 'spanId', 'span_id'}


def _credential_word(value):
    return any(not c.isalpha() for c in value.strip(".,;:?'\"()"))


def _technical_code(match):
    return match['label'].lower() == 'code' and bool(re.search(
        r'\b(?:http(?:\s+status)?|status|error|exit|response|return|close|grpc|sql)\s+$',
        match.string[:match.start()], re.I))


def _prefix(match):
    return (match['open'] or '') + match['label'] + (match['inner'] or '') + (match['close'] or '') + match['sep']


def _label(match):
    value, sep = match['value'], match['sep']
    original = _prefix(match) + value
    if value == REDACTED or _technical_code(match):
        return original
    if match['label'].lower() == 'secret' and value == 'removed]' and match.start() > 0 and match.string[match.start() - 1] == '[':
        return original
    # A URL supplied on its own remains a usable link; a quoted secret is one value,
    # even when its contents happen to contain a URL.
    if URL_RE.fullmatch(value):
        return original
    if not (match['inner'] or REAL_SEP_RE.fullmatch(sep)) and not value.startswith(('"', "'", '`')):
        if STRONG_RE.fullmatch(match['label']) and PROSE_RE.match(value) and not _credential_word(value):
            return original
        if not STRONG_RE.fullmatch(match['label']) and not _credential_word(value):
            return original
    if (match['inner'] or sep).strip().lower() == 'is' and re.fullmatch(r'(?:wrong|incorrect|correct|invalid|expired|missing|unavailable|unchanged)', value, re.I):
        return original
    return _prefix(match) + REDACTED


def _inside(spans, start):
    return any(lo <= start < hi for lo, hi in spans)


def _labelled_values(text):
    spans = [m.span() for m in URL_RE.finditer(text)]
    def phrase(m):
        if _inside(spans, m.start()) or (not (m['inner'] or REAL_SEP_RE.fullmatch(m['sep'])) and PROSE_RE.match(m['value'])):
            return m.group()
        words = m['value'].split()
        count = max(n for n in (12, 15, 18, 21, 24) if n <= len(words))
        return _prefix(m) + REDACTED + (' ' + ' '.join(words[count:]) if len(words) > count else '')
    text = PHRASE_RE.sub(phrase, text)
    spans = [m.span() for m in URL_RE.finditer(text)]
    text = GROUPED_RE.sub(lambda m: m.group() if _inside(spans, m.start()) or _technical_code(m) else _prefix(m) + REDACTED, text)
    spans = [m.span() for m in URL_RE.finditer(text)]
    def block(m):
        if _inside(spans, m.start()):
            return m.group()
        labelled = LABEL_RE.match(m.string, m.start('value'))
        if labelled and (labelled['value'] == REDACTED or _label(labelled) != _prefix(labelled) + labelled['value']):
            return m.group()
        if URL_RE.fullmatch(m['value']):
            return m.group()
        return m.group()[:m.start('value') - m.start()] + REDACTED
    text = BLOCK_RE.sub(block, text)
    spans = [m.span() for m in URL_RE.finditer(text)]
    parts, last = [], 0
    for m in LABEL_RE.finditer(text):
        if m.start() < last or _inside(spans, m.start()):
            continue
        replacement = _label(m)
        if replacement != _prefix(m) + m['value'] or m['value'] == REDACTED:
            parts.extend((text[last:m.start()], replacement))
            last = m.end('value')
    parts.append(text[last:])
    return ''.join(parts)


def _outside_urls(text):
    text = JWT_RE.sub(REDACTED, text)
    text = KEY_RE.sub(REDACTED, text)
    def long(m):
        word = m.group()
        typed = HASH_RE.fullmatch(word) and re.search(r'\b(?:trace(?:[_ ]id)?|span(?:[_ ]id)?|git(?: sha)?|commit(?: sha)?|head(?: sha)?)\s*[:=]?\s*$', m.string[:m.start()], re.I)
        return word if typed or UUID_RE.fullmatch(word) or re.fullmatch(r'(?:reply|watcher|card|thread|script|disc|board|goal)-[A-Za-z0-9_-]+', word) else REDACTED
    text = LONG_RE.sub(long, text)
    return text


def _email_pairs(text):
    spans = [m.span() for m in URL_RE.finditer(text)]
    def login(m):
        value = m[3]
        if _inside(spans, m.start()) or URL_RE.fullmatch(value):
            return m.group()
        if re.fullmatch('(?:' + STRONG + '|' + WEAK + r')[:=–—-]?', value, re.I) and re.match(r'\s*(?:=>|->|[:=–—-]|is)?\s*\[redacted\]', m.string[m.end():], re.I):
            return m.group()
        if (value.startswith(('"', "'", '`')) or 6 <= len(value) <= 40) and (m[2].strip() in ('/', ',', '|') or _credential_word(value)):
            return m[1] + m[2] + REDACTED
        return m.group()
    return LOGIN_RE.sub(login, text)


def redact(text: str) -> str:
    """Remove credential values before layout changes; retain labels and usable links."""
    text = _email_pairs(_labelled_values(text))
    parts, last = [], 0
    for url in URL_RE.finditer(text):
        parts.extend((_outside_urls(text[last:url.start()]), url.group()))
        last = url.end()
    parts.append(_outside_urls(text[last:]))
    return ''.join(parts)


def redact_fields(value):
    """Sanitize text fields before serializing an outgoing card or wake payload."""
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, list):
        return [redact_fields(v) for v in value]
    if isinstance(value, dict):
        return {k: v if k in HASH_FIELDS and isinstance(v, str) and HASH_RE.fullmatch(v) else redact_fields(v) for k, v in value.items()}
    return value


if __name__ == '__main__':
    import sys
    sys.stdout.write(redact(sys.stdin.read()))
