"""Pure selected-card event draft, NOT proof of the effective native route.

The native controller tries internal fallback state before the selected row. That
state is not an established API field. This module never fetches configuration,
defaults an unknown platform, performs a precheck, or starts a payment/SDK.
Returned event data is private: keep it in memory, never print or persist it.
"""
import copy

import talabat_quote as q

EVENT_KEYS = frozenset(('platform', 'method', 'routingCriteria', 'card',
                        'platformType', 'paymentStatusPullingInterval', 'instrumentId'))
METHOD_KEYS = frozenset(('paymentMethod', 'paymentMethodName',
                         'addTPayMethod', 'addTPayMethodName'))
CARD_KEYS = frozenset(('cardId', 'binNumber', 'cardFingerPrint'))


def _fail(code):
    q.c._fail(code)


def _text(value):
    return type(value) is str and q.c._identifier(value) and bool(value.strip())


def selected_payment_event(*, home, vendor, config, saved_card):
    """Serialize only the explicit talabat+sync, saved order-card, no-precheck candidate.

    This is the seven-field KEg serializer, not the enclosing FDg payment body.
    Native defaults and alternate-wallet/card fallback are intentionally absent.
    Missing optional null fields follow the native nullable branch; they are not
    evidence of fresh runtime state, amount binding, or permission to send.
    """
    q.selected_card_body(home, vendor, config, saved_card)
    row = next(row for row in config['paymentMethods']
               if type(row.get('events')) is dict
               and type(row['events'].get('payment')) is dict
               and type(row['events']['payment'].get('card')) is dict
               and row['events']['payment']['card'].get('cardId') == saved_card['tokenId'])
    if row.get('paymentMode') is not None:
        _fail('PAYMENT_ROUTE_WALLET_MIXED_OR_UNKNOWN_MODE')
    events = row['events']
    if set(events) - {'prePayment', 'selected', 'payment', 'postPayment'}:
        _fail('PAYMENT_ROUTE_EVENTS_UNSUPPORTED')
    pre = events.get('prePayment')
    if pre is not None:
        _fail('PAYMENT_ROUTE_CVV_REQUIRED' if type(pre) is dict and pre.get('name') == 'ForceCVV'
              else 'PAYMENT_ROUTE_PRECHECK_UNSUPPORTED')
    if events.get('selected') is not None or events.get('postPayment') is not None:
        _fail('PAYMENT_ROUTE_AUXILIARY_EVENT_UNSUPPORTED')
    event = events['payment']
    if set(event) - EVENT_KEYS:
        _fail('PAYMENT_ROUTE_EVENT_SCHEMA_UNSUPPORTED')
    # Never reproduce the native unknown/missing -> talabat/sync fallback.
    if type(event.get('platform')) is not str or event['platform'] != 'talabat':
        _fail('PAYMENT_ROUTE_PLATFORM_UNSUPPORTED')
    if type(event.get('platformType')) is not str or event['platformType'] != 'sync':
        _fail('PAYMENT_ROUTE_PLATFORM_TYPE_UNSUPPORTED')
    method, card = event.get('method'), event.get('card')
    if (type(method) is not dict or set(method) != METHOD_KEYS
            or type(method['paymentMethod']) is not int or method['paymentMethod'] != 2
            or type(method['addTPayMethod']) is not int or method['addTPayMethod'] != 7
            or not all(_text(method[k]) for k in ('paymentMethodName', 'addTPayMethodName'))):
        _fail('PAYMENT_ROUTE_METHOD_UNSUPPORTED')
    if (type(card) is not dict or set(card) != CARD_KEYS
            or not all(_text(card[k]) for k in CARD_KEYS)
            or not q._same_json(card['cardId'], saved_card['tokenId'])):
        _fail('PAYMENT_ROUTE_SAVED_CARD_MISMATCH')
    routing = event.get('routingCriteria')
    if routing is not None and (type(routing) is not dict or set(routing) != {'pu'}
                                or not _text(routing['pu'])):
        _fail('PAYMENT_ROUTE_ROUTING_CRITERIA_UNSUPPORTED')
    # No interval semantics or instrument replacement is supported by this
    # narrow synchronous candidate, even if a value is falsy ([], "", 0).
    if event.get('paymentStatusPullingInterval') is not None:
        _fail('PAYMENT_ROUTE_POLLING_CONFIGURATION_UNSUPPORTED')
    if event.get('instrumentId') is not None:
        _fail('PAYMENT_ROUTE_INSTRUMENT_REPLACEMENT_UNSUPPORTED')
    return copy.deepcopy({key:event.get(key) for key in EVENT_KEYS})
