"""The one saved card every paying commerce lane uses. 5542 was cancelled 29 Oct 2026."""
import os, re
CANCELLED = frozenset({'5542'})
def _configured():
    value = os.environ.get('COMMERCE_CARD_LAST4', '2342')
    if not re.fullmatch(r'[0-9]{4}', value) or value in CANCELLED:
        raise RuntimeError('ORDER_CARD_CONFIG_INVALID')
    return value
LAST4 = _configured()
