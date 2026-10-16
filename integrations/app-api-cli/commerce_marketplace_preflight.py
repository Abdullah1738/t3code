"""Payment evidence for previous active marketplace orders, before cart writes."""
import re

import noon_http_orders as core
import noon_marketplace_checkout as market
from noon_marketplace_native_shape import native_aed_display_minor
from noon_marketplace_review import ReviewError


def _detail_paid(data, order):
    # Captured order-v2 shape, 2026-10-16. "confirmed" on an active-list card
    # is fulfillment state, not payment evidence. Require the durable Paid with
    # card amount AND the matching Total paid invoice row for the exact order.
    if not isinstance(data, dict) or data.get('orderNr') != order:
        return False
    payment = data.get('payment')
    if (data.get('paymentMethodCode') != 'cc_noonpay'
            or not isinstance(payment, dict) or payment.get('title') != 'Paid with'
            or payment.get('paymentMethodCode') != 'cc_noonpay'
            or any(obj.get(key) for obj in (data, payment)
                   for key in ('paymentError', 'paymentErrorMsg', 'error', 'errors'))):
        return False
    methods = payment.get('paymentMethods')
    if (not isinstance(methods, list) or len(methods) != 1
            or not isinstance(methods[0], dict)
            or methods[0].get('code') not in ('mastercard', 'visa', 'amex')):
        return False
    amount = methods[0].get('amount')
    if not isinstance(amount, str) or not re.fullmatch(r'[0-9]+\.[0-9]{2}', amount):
        return False
    invoice = data.get('invoice')
    sections = invoice.get('sections') if isinstance(invoice, dict) else None
    if not isinstance(sections, list) or not sections:
        return False
    totals = []
    try:
        paid_minor = market.fils(amount)
        for section in sections:
            entries = section.get('entries') if isinstance(section, dict) else None
            if not isinstance(entries, list):
                return False
            for entry in entries:
                if not isinstance(entry, dict):
                    return False
                if core.text(entry.get('title')) == 'Total paid (inc. VAT)':
                    value = entry.get('amount')
                    if not isinstance(value, str):
                        return False
                    # U+E001 is the native AED glyph in this order-v2 invoice.
                    totals.append(native_aed_display_minor(value.replace('\ue001', 'AED')))
        return paid_minor > 0 and totals == [paid_minor]
    except (market.MarketplaceError, ReviewError):
        return False


def prior_order_paid(client, order, *, timeout=25):
    """Read-only; never use this fallback for a new/ambiguous placement."""
    try:
        data = client.call('order_status', order=order, timeout=timeout).data
    except market.MarketplaceError as exc:
        if exc.code != 'CHECKOUT_ORDER_NOT_FOUND':
            raise
        return _detail_paid(client.call('order_detail', order=order, timeout=timeout).data, order)
    return (isinstance(data, dict) and data.get('status') == 'success'
            and not data.get('paymentError') and not data.get('paymentErrorMsg'))
