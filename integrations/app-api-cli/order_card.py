"""Noon uses Mashreq; Marriott requires an explicit caller-selected fallback."""
import os
def _configured():
    value = os.environ.get('COMMERCE_CARD_LAST4', '9546')
    if value not in ('9546', '2342'):
        raise RuntimeError('ORDER_CARD_CONFIG_INVALID')
    return value
LAST4 = _configured()
CVV_ACCOUNT = {'9546': 'MashreqNoon.card_cvc', '2342': 'Marriott.card_cvc'}[LAST4]
NETWORK = {'9546': 'visa', '2342': 'mastercard'}[LAST4]
BANK_APP = {'9546': 'Mashreq app', '2342': 'ENBD X'}[LAST4]
