"""Pure, private extraction of the native Main/Supermall selected checkout card.

Native keys and selectors are anchored in HBC 4893567-4893586,
4893746-4893793 and closures 119103/119108/119109/119110. This is an
in-memory result for internal comparison, not a public receipt or wire payload.
"""
from dataclasses import dataclass, field


# PaymentMethods.CC, HBC 1259848, shape 1496 / value-buffer offset 718882.
CC_PAYMENT_METHOD = 'cc_noonpay'


class CardError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class SelectedCard:
    """Private native identity; never log/serialize this as a public result."""
    token: str = field(repr=False)
    mask: str = field(repr=False)
    network: str = field(repr=False)
    payment_method: str
    is_selected: bool


def _require(ok, code):
    if not ok:
        raise CardError(code)


def _rows(value, code):
    _require(type(value) is list and len(value) <= 1000
             and all(type(row) is dict for row in value), code)
    return value


def _text(value, code):
    _require(type(value) is str and bool(value.strip()) and len(value) <= 512
             and not any(ord(c) < 32 for c in value), code)
    return value


def extract_selected_card(session) -> SelectedCard:
    """Extract the selected CC card from one native session snapshot.

    The native active method is methods.find(m => m.status === 'active').
    Independently, native card lookup finds code === PaymentMethods.CC, then
    uses 'cardSections' in method to choose sections over legacy method.cards.
    Sections flatten section.cards || []; the card predicate is isSelected.

    For review use we additionally reject ambiguous methods/cards, non-boolean
    selection flags and a non-CC active method. Missing/null section cards are
    empty, but present null cardSections never falls back to method.cards.
    No flat session fields, basket echoes, or saved-card-list aliases are read.
    """
    _require(type(session) is dict, 'SCHEMA_CARD_SESSION')
    payments = session.get('paymentMethodsV2')
    _require(type(payments) is dict, 'SCHEMA_PAYMENT_METHODS_V2')
    methods = _rows(payments.get('methods'), 'SCHEMA_PAYMENT_METHODS')
    active = [row for row in methods if row.get('status') == 'active']
    _require(len(active) == 1, 'SELECTED_PAYMENT_METHOD_AMBIGUOUS_OR_MISSING')
    _require(active[0].get('code') == CC_PAYMENT_METHOD, 'SELECTED_PAYMENT_METHOD_NOT_CC')
    cc = [row for row in methods if row.get('code') == CC_PAYMENT_METHOD]
    _require(len(cc) == 1, 'CC_PAYMENT_METHOD_AMBIGUOUS')
    method = cc[0]
    if 'cardSections' in method:
        sections = _rows(method['cardSections'], 'SCHEMA_CARD_SECTIONS')
        cards = []
        for section in sections:
            rows = section.get('cards')
            if rows is not None:
                cards.extend(_rows(rows, 'SCHEMA_SECTION_CARDS'))
        _require(len(cards) <= 1000, 'SCHEMA_SECTION_CARDS')
    else:
        cards = _rows(method.get('cards'), 'SCHEMA_METHOD_CARDS')
    selected = []
    for card in cards:
        flag = card.get('isSelected', False)
        _require(type(flag) is bool, 'SCHEMA_CARD_IS_SELECTED')
        if flag:
            selected.append(card)
    _require(len(selected) == 1, 'SELECTED_CARD_AMBIGUOUS_OR_MISSING')
    card = selected[0]
    # confirmPaymentMethod: card.id -> cardToken; checkout card.mask -> cardMask
    # (4895765-4895775). Selected-card consumers use .type (4893890-4893894).
    card_id = card.get('id')
    if type(card_id) is int and card_id > 0:
        card_id = str(card_id)
    return SelectedCard(
        token=_text(card_id, 'SCHEMA_CARD_ID'),
        mask=_text(card.get('mask'), 'SCHEMA_CARD_MASK'),
        network=_text(card.get('type'), 'SCHEMA_CARD_TYPE'),
        payment_method=active[0]['code'],
        is_selected=True,
    )
