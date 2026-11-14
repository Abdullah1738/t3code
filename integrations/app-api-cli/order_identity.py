"""Website order numbers are local to a merchant, unlike native app IDs."""
import hashlib
import re


def merchant_domain(value):
    value = str(value or '')
    labels = value.split('.')
    if (len(value) > 253 or len(labels) < 2 or value != value.lower()
            or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label)
                   for label in labels) or labels[-1].isdigit()):
        raise ValueError('Invalid --merchant-domain: use a lowercase hostname with at least one dot')
    return value


def order_id(app, value):
    if app == 'web':
        value = value.removeprefix('#')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,' + ('40' if app == 'web' else '80') + '}', value):
        raise ValueError('Invalid order ID')
    return value


def tracker_id(app, order, domain=None):
    if app == 'web':
        domain_key = hashlib.sha256(merchant_domain(domain).encode()).hexdigest()[:16]
        return f'order-web-{domain_key}-{order.lower()}'
    return f'order-{app}-{order.lower()}'
