"""Offline extraction of statically evidenced Main/Supermall response fields.

This is evidence, not a complete financial review or purchase authorization.
NATIVE_SHAPE addresses the decoded response body (no HTTP ``data`` envelope).
See http-marketplace-native-shape.md and http-marketplace-semantic-closure.md
for the HBC function/byte-offset anchors.
Unproven fields are deliberately absent, rather than aliases or default values.
"""
from copy import deepcopy
from html.parser import HTMLParser
import re

from commerce_journal import MAX_SQLITE_INTEGER
from noon_marketplace_review import EvidenceShape, Field, ReviewError, digest, minor, require, text


HBC_SHA256 = 'a213ec477e181c8e4b9ccb4fa85b13a064559c8c4ad93c3869f1200d12f487f3'


def _field(path, anchor):
    return Field(path, 'HBC ' + anchor)


NATIVE_SHAPE = EvidenceShape((
    ('cart_rows', _field(('groups', '*', 'items'), 'f27371@51; f59831@21')),
    ('cart_offer', _field(('offerCode',), 'f84475@13')),
    ('cart_variant', _field(('variantKey',), 'f84475@23')),
    ('cart_quantity', _field(('quantity',), 'f84475@95')),
    ('cart_selected', _field(('isSelectedForCheckout',), 'f84475@105')),
    ('cart_unit_amount', _field(('unitPrice',), 'f41043@2338')),
    ('cart_installation', _field(('installation',), 'f41043@3709')),
    ('cart_warranty', _field(('extendedWarranty',), 'f41043@3672')),
    ('cart_customization', _field(('customizationAnswers',), 'f41043@1598')),
    ('cart_installation_selected', _field(('installation', 'isSelected'),
                                        'f41048@1150; f84491@63..72')),
    ('cart_installation_price_display', _field(('installation', 'price'), 'f41048@881 HtmlView')),
    ('cart_warranty_code', _field(('extendedWarranty', 'code'),
                                'f41043@4142..4148 -> f41046@177,@234; f84488@180')),
    ('cart_warranty_unit_amount', _field(('extendedWarranty', 'unitPrice'), 'f41046@222')),
    ('cart_warranty_provider', _field(('extendedWarranty', 'providerName'), 'f41046@216')),
    ('group_type', _field(('type',), 'f84462@141')),
    ('group_analytics', _field(('analytics',), 'f84462@131')),
    ('shipment_id', _field(('id',), 'f42627@331')),
    ('shipment_promises', _field(('promises',), 'f42627@349 -> f88750@20')),
    ('promise_selected', _field(('isSelected',), 'f119249@3')),
    ('session_rows', _field(('shipments', '*', 'items'),
                            'f88591@93 -> f119075@9 -> f131031@15')),
    ('session_offer', _field(('offerCode',), 'f88749@972')),
    ('session_quantity', _field(('quantity',), 'f88749@44')),
    ('session_unit_amount', _field(('unitPrice',), 'f88749@59')),
    ('address_code', _field(('addressCode',), 'f88612@18; f119106@3,@16')),
    ('subtotal', _field(('subtotal',), 'f88591@59')),
    ('payable', _field(('total',), 'f131025@418')),
    ('order_payment_amount', _field(('orderPaymentAmount',), 'f88635@1092')),
    ('wallet_balance', _field(('walletAmount',), 'f42617@1380 credit-balance display')),
    ('use_credits', _field(('useCredits',), 'f42617@1224 toggle value')),
    ('subscription_enrolled', _field(('integratedNoonone', 'enrolled'), 'f88591@131,@148')),
    ('donation', _field(('donation',), 'f131050@104')),
    ('invoice_entries', _field(('invoice', 'sections', '*', 'entries'),
                               'f131052@114; f41073@266; f84542@294')),
    ('invoice_title', _field(('title',), 'f116858@381,@440; HTML display')),
    ('invoice_amount_display', _field(('amount',), 'f116858@652,@712; HTML display')),
    ('invoice_breakdown', _field(('breakdown',), 'f116858@44..50 -> f116850@6')),
    ('invoice_analytics_fee_type', _field(('breakdown', 'analyticsFeeType'), 'f116850@54')),
    ('delivery_options', _field(('deliveryOptions',), 'f88616@54,@65')),
    ('option_status', _field(('status',), 'f119092@31,@49,@53')),
    ('option_message', _field(('message',), 'f88688@642')),
    ('option_action', _field(('action',), 'f88688@98..109 receiver_phone branch')),
    ('option_type', _field(('type',), 'f88688@539..551 checkbox rendering')),
), 'HBC:' + HBC_SHA256 + ':marketplace-static-v2')


ADDRESS_SHAPE = EvidenceShape((
    ('address_code', _field(('addressCode',), 'f84763@145; f119106@3')),
    ('address_key', _field(('addressKey',), 'f84763@185; f88582@224')),
    ('street_address', _field(('streetAddress',), 'f84763@82,@99')),
    ('lat', _field(('lat',), 'f84763@28,@62')),
    ('lng', _field(('lng',), 'f84763@40,@72')),
), 'HBC:' + HBC_SHA256 + ':address-v1-static')

WHOAMI_SHAPE = EvidenceShape((
    ('currency', _field(('config', 'country', 'currencyCode'),
                        'f88603@3..25; relative to whoami.data')),
), 'HBC:' + HBC_SHA256 + ':whoami-currency-static')


def native_selected_address(session, addresses):
    """Bind a supplied fresh address inventory by session.addressCode, strictly.

    Native f88612/f119106 searches this exact code, but its UI fallback to a
    default address (f119107) is unsuitable for a financial review. Reject no
    match/duplicate matches instead. This does not validate Home or freshness.
    """
    code = text(NATIVE_SHAPE.get('address_code', session), 'INVALID_ADDRESS_CODE')
    matches = [row for row in _rows(addresses, 'SCHEMA_ADDRESSES')
               if ADDRESS_SHAPE.get('address_code', row) == code]
    require(len(matches) == 1, 'SESSION_ADDRESS_MATCH_REQUIRED')
    return deepcopy(matches[0])


# These are continuation nodes, not hypothetical wire fields. In particular,
# do not graft guessed seller/fulfillment fields onto rows to satisfy review().
UNRESOLVED = (
    ('cart_seller', 'f41043@15 item; f84462@107 passes groups[].items[] unchanged'),
    ('cart_fulfillment', 'f84462@131 group.analytics; @141 group.type is not fulfillment identity'),
    ('session_seller', 'f88749@6 shipment item; f42627@340 shipment.items'),
    ('session_fulfillment', 'f42627@331 shipment.id; @349 promises are not fulfillment identity'),
    ('session_variant', 'f88749@972 and f88763@3 key only by offerCode; no variantKey read proven'),
    ('fee_inventory', 'f116858 HTML amount; f116850@54 breakdown.analyticsFeeType is analytics, not a fee code'),
    ('discount', 'f41043@2380 item.discount; aggregate selected-session discount not proven'),
    ('tip', 'f131050@104 donation is not tip; no marketplace tip response path proven'),
    ('wallet_spend', 'f42617@1224 useCredits; @1380 walletAmount is displayed balance'),
    ('extras_inventory', 'installation.isSelected f84491@63; warranty.code f84488@180; no exhaustive session extras'),
    ('address_key', 'f88582@224 reads chosen-address.addressKey for setAddress, not session.addressKey'),
    ('currency', 'f88603@3..25 reads whoami.data.config.country.currencyCode, not session.currency'),
    ('quiet_semantics', 'f88688@123 status / @642 server message; f88680@128 code/active request'),
    ('delivery_note', 'f88683@50 note.content is alternate-phone UI copy, not owner delivery note'),
)


def _rows(value, code):
    require(type(value) is list and all(type(row) is dict for row in value), code)
    return value


def _flatten(data, container, code):
    """Validate both levels and preserve every group/shipment, including duplicates."""
    require(type(data) is dict and container in data, code)
    result = []
    for index, group in enumerate(_rows(data[container], code)):
        require('items' in group, code)
        for item_index, row in enumerate(_rows(group['items'], code)):
            result.append((index, item_index, row))
    return result


def _item(row, prefix, container_index, item_index):
    get = lambda name: NATIVE_SHAPE.get(prefix + '_' + name, row)
    quantity = get('quantity')
    require(type(quantity) is int and quantity > 0, 'INVALID_ITEM_QUANTITY')
    unit = minor(get('unit_amount'))
    line = unit * quantity
    require(line <= MAX_SQLITE_INTEGER, 'INVALID_AMOUNT')
    result = {
        'offerCode': text(get('offer'), 'INVALID_OFFER'),
        'quantity': quantity,
        'unitPrice': deepcopy(get('unit_amount')),
        # Derived money, never presented as an observed native linePrice field.
        'derived_line_minor': line,
        'source_path': (('groups' if prefix == 'cart' else 'shipments'),
                         container_index, 'items', item_index),
        'source_hash': digest(row),
    }
    if prefix == 'cart':
        # The app null-coalesces variantKey in selection requests (f104664@97),
        # but this evidence extractor preserves null/absence, without defaulting.
        if 'variantKey' in row:
            variant = get('variant')
            require(variant is None or type(variant) is str, 'SCHEMA_CART_VARIANT')
            result['variantKey'] = variant
        selected = get('selected')
        require(type(selected) is bool, 'SCHEMA_CART_SELECTED')
        result['isSelected'] = selected
        for semantic, key in (('installation', 'installation'),
                              ('warranty', 'extendedWarranty'),
                              ('customization', 'customizationAnswers')):
            if key in row:
                result[key] = deepcopy(get(semantic))
    return result


def _contexts(data, container, fields):
    """Bind native containers verbatim by hash; IDs are not seller identities."""
    out = []
    for index, row in enumerate(data[container]):
        values = {key: deepcopy(row[key]) for key in fields if key in row}
        out.append({'source_path': (container, index), 'source_hash': digest(row),
                    'values': values})
    return out


class _InlineDisplay(HTMLParser):
    """Small unambiguous HTML subset, rejecting hidden/alternate price markup."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.stack = []

    def handle_starttag(self, tag, attrs):
        require(tag in ('b', 'strong', 'span') and not attrs, 'UNSUPPORTED_INVOICE_HTML')
        self.stack.append(tag)

    def handle_endtag(self, tag):
        require(bool(self.stack) and self.stack.pop() == tag, 'INVALID_INVOICE_HTML')

    def handle_data(self, data):
        self.parts.append(data)

    def handle_comment(self, data):
        raise ReviewError('UNSUPPORTED_INVOICE_HTML')

    def handle_decl(self, decl):
        raise ReviewError('UNSUPPORTED_INVOICE_HTML')

    def handle_pi(self, data):
        raise ReviewError('UNSUPPORTED_INVOICE_HTML')

    def unknown_decl(self, data):
        raise ReviewError('UNSUPPORTED_INVOICE_HTML')


def native_aed_display_minor(value):
    """Parse ONE explicit AED display amount, never infer a fee role or currency.

    Unknown markup, Free, crossed-out prices, multiple amounts, wrong currency,
    grouping errors and fractional fils fail. This parser's accepted subset is
    local policy, not a claim that every native HTML amount uses that grammar.
    """
    require(type(value) is str and len(value) <= 4096, 'INVALID_INVOICE_AMOUNT')
    parser = _InlineDisplay()
    parser.feed(value)
    parser.close()
    require(not parser.stack, 'INVALID_INVOICE_HTML')
    display = ''.join(parser.parts).replace('\xa0', ' ').strip()
    number = r'-?(?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+)(?:\.[0-9]{1,2})?'
    match = re.fullmatch(r'(?:AED +(' + number + r')|(' + number + r') +AED)', display)
    require(match is not None, 'INVALID_INVOICE_AMOUNT')
    amount = (match[1] or match[2]).replace(',', '')
    return -minor(amount[1:]) if amount.startswith('-') else minor(amount)


def native_invoice_observations(session):
    """All invoice rows, with exact paths and optional parsed display amounts.

    analyticsFeeType remains an analytics label; neither it nor the title becomes
    a fee code. Rows are never summed: sections may repeat totals/breakdowns.
    """
    require(type(session) is dict and type(session.get('invoice')) is dict,
            'SCHEMA_INVOICE_ENTRIES')
    sections = _rows(session['invoice'].get('sections'), 'SCHEMA_INVOICE_ENTRIES')
    out = []
    for i, section in enumerate(sections):
        for j, row in enumerate(_rows(section.get('entries'), 'SCHEMA_INVOICE_ENTRIES')):
            entry = {'source_path': ('invoice', 'sections', i, 'entries', j),
                     'source_hash': digest(row), 'native_entry': deepcopy(row)}
            if 'amount' in row:
                try:
                    entry['display_amount_minor'] = native_aed_display_minor(row['amount'])
                except ReviewError as error:
                    entry['amount_parse_error'] = error.code
            out.append(entry)
    return out


def native_credit_state(session):
    """Exact native credit controls and payment amounts, without wallet-spend inference."""
    require(type(session) is dict, 'INVALID_REVIEW_DATA')
    enabled = NATIVE_SHAPE.get('use_credits', session)
    require(type(enabled) is bool, 'SCHEMA_USE_CREDITS')
    balance = minor(NATIVE_SHAPE.get('wallet_balance', session))
    total = minor(NATIVE_SHAPE.get('payable', session))
    payment = minor(NATIVE_SHAPE.get('order_payment_amount', session))
    return {'useCredits': enabled, 'wallet_balance_minor': balance,
            'total_minor': total, 'order_payment_minor': payment,
            # Same comparison as f42617@465..477, not an applied-credit amount.
            'balance_covers_total': balance >= total,
            'derived_payment_difference_minor': total - payment,
            'source_hash': digest(session)}


def native_addon_observations(cart, session):
    """Known native addon controls only, not an exhaustive extras inventory.

    Warranty is a selected plan object passed to the remove action. Installation
    is an offer that can be present but unselected. Preserve null/missing states;
    no absence-derived false flags, empty inventories, or zero prices.
    """
    require(type(session) is dict, 'INVALID_REVIEW_DATA')
    out = []
    for i, j, row in _flatten(cart, 'groups', 'SCHEMA_CART_ROWS'):
        for key in ('installation', 'extendedWarranty', 'customizationAnswers'):
            if key not in row:
                continue
            value = row[key]
            entry = {'source_path': ('groups', i, 'items', j, key),
                     'native_value': deepcopy(value), 'source_hash': digest(value)}
            if key == 'installation' and type(value) is dict:
                if 'isSelected' in value:
                    require(type(value['isSelected']) is bool, 'SCHEMA_INSTALLATION_SELECTED')
                    entry['isSelected'] = value['isSelected']
                if 'price' in value:
                    try:
                        entry['display_price_minor'] = native_aed_display_minor(value['price'])
                    except ReviewError as error:
                        entry['amount_parse_error'] = error.code
            if key == 'extendedWarranty' and type(value) is dict:
                if 'code' in value:
                    entry['code'] = text(value['code'], 'INVALID_WARRANTY_CODE')
                if 'unitPrice' in value:
                    entry['unit_price_minor'] = minor(value['unitPrice'])
            out.append(entry)
    if 'donation' in session:
        entry = {'source_path': ('donation',), 'native_value': deepcopy(session['donation']),
                 'source_hash': digest(session['donation'])}
        if session['donation'] is not None:
            entry['amount_minor'] = minor(session['donation'])
        out.append(entry)
    return out


def native_context_binding(cart, session):
    """Match native offer/quantity/unit amounts while preserving opaque context.

    Split shipments are supported. Multiple cart rows for a selected offer are
    ambiguous because the session reader has no variantKey: reject them. A cart
    variant remains a cart observation, never a fabricated session field. Full
    response/container hashes bind all seller/fulfillment-relevant opaque data
    without claiming a named identity, server revision or server CAS guarantee.
    """
    normalized = native_normalize(cart, session)
    selected = {}
    counts = {}
    for row in normalized['cart_items']:
        counts[row['offerCode']] = counts.get(row['offerCode'], 0) + 1
    for row in normalized['cart_items']:
        if row['isSelected']:
            offer = row['offerCode']
            require(counts[offer] == 1, 'AMBIGUOUS_CART_OFFER_CONTEXT')
            selected[offer] = row
    require(bool(selected), 'EMPTY_SELECTED_CART')
    shipments = {}
    for row in normalized['session_items']:
        offer = row['offerCode']
        require(offer in selected, 'SESSION_OFFER_CONTEXT_MISMATCH')
        require(minor(row['unitPrice']) == minor(selected[offer]['unitPrice']),
                'SESSION_UNIT_CONTEXT_MISMATCH')
        shipments.setdefault(offer, []).append(row)
    links = []
    for offer, cart_row in selected.items():
        rows = shipments.get(offer, [])
        require(sum(row['quantity'] for row in rows) == cart_row['quantity'],
                'SESSION_QUANTITY_CONTEXT_MISMATCH')
        links.append({'cart_item': deepcopy(cart_row),
                      'session_paths': tuple(row['source_path'] for row in rows)})
    binding = {'source_hashes': normalized['source_hashes'], 'links': links,
               'cart_contexts': normalized['cart_contexts'],
               'shipment_contexts': normalized['shipment_contexts'],
               'evidence_id': NATIVE_SHAPE.evidence_id}
    binding['binding_hash'] = digest(binding)
    return binding


def native_normalize(cart, session):
    """Return proven evidence from two decoded native response bodies, without I/O.

    Required: populated-cart ``groups[].items[]`` and ``shipments[].items[]``.
    Item fields require exact native types. Optional session observations remain
    absent when absent; their omission does not establish zero/false/empty.
    All shipment lines and unselected cart lines survive, with source paths.
    ``derived_line_minor`` = exact unitPrice minor units * quantity; this alone
    does not prove discounted payable line totals or validate a basket.

    Output includes cart_items, session_items, cart_contexts, shipment_contexts,
    session_values, source_hashes, evidence_id, unresolved. Delivery options and
    invoice entries/observations are included only when supplied. Unknown semantics
    in UNRESOLVED prevent this result from being a complete review adapter.
    NATIVE_SHAPE is for raw responses; it is not a shape for this output.
    """
    require(type(cart) is dict and type(session) is dict, 'INVALID_REVIEW_DATA')
    hashes = (digest(cart), digest(session))
    cart_items = [_item(row, 'cart', i, j)
                  for i, j, row in _flatten(cart, 'groups', 'SCHEMA_CART_ROWS')]
    session_items = [_item(row, 'session', i, j)
                     for i, j, row in _flatten(session, 'shipments', 'SCHEMA_SESSION_ROWS')]
    values = {}
    for name, key in (('address_code', 'addressCode'), ('subtotal', 'subtotal'),
                      ('payable', 'total'), ('order_payment_amount', 'orderPaymentAmount'),
                      ('wallet_balance', 'walletAmount'), ('use_credits', 'useCredits'),
                      ('donation', 'donation')):
        if key in session:
            values[name] = deepcopy(NATIVE_SHAPE.get(name, session))
    if 'integratedNoonone' in session:
        # Preserve the actual payload, even null, rather than invent enrollment.
        values['integratedNoonone'] = deepcopy(session['integratedNoonone'])
    result = {'cart_items': cart_items, 'session_items': session_items,
              'session_values': values, 'source_hashes': hashes,
              'evidence_id': NATIVE_SHAPE.evidence_id, 'unresolved': UNRESOLVED}
    result['cart_contexts'] = _contexts(cart, 'groups', ('type', 'analytics'))
    result['shipment_contexts'] = _contexts(session, 'shipments', ('id', 'promises'))
    if 'deliveryOptions' in session:
        options = NATIVE_SHAPE.get('delivery_options', session)
        require(type(options) is dict and len(options) <= 1000, 'SCHEMA_DELIVERY_OPTIONS')
        out = []
        for code, option in options.items():
            text(code, 'INVALID_DELIVERY_OPTION')
            require(type(option) is dict, 'SCHEMA_DELIVERY_OPTIONS')
            status = text(NATIVE_SHAPE.get('option_status', option), 'INVALID_DELIVERY_OPTION')
            entry = {'code': code, 'status': status, 'active': status == 'active',
                     'disabled': status == 'disabled',
                     'source_hash': digest(option),
                     'source_path': ('deliveryOptions', code)}
            for key in ('message', 'action', 'type'):
                if key in option:
                    entry[key] = deepcopy(NATIVE_SHAPE.get('option_' + key, option))
            out.append(entry)
        result['delivery_options'] = out
    if 'invoice' in session:
        result['invoice_entries'] = deepcopy(_rows(
            NATIVE_SHAPE.get('invoice_entries', session), 'SCHEMA_INVOICE_ENTRIES'))
        result['invoice_observations'] = native_invoice_observations(session)
    return result
