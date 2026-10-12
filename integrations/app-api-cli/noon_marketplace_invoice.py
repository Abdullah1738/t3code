"""Pure, snapshot-bound reconciliation of Main/Supermall HTML invoice rows.

No native accounting role/code was established by the dynamic invoice renderer.
Roles below are LOCAL user-reviewed meanings of exact observed HTML titles, never
wire fields. There is intentionally no default label map. A successful result is
invoice arithmetic, not an extras inventory or a complete checkout review.
"""
from dataclasses import dataclass
from html.parser import HTMLParser
import re
import unicodedata

from noon_marketplace_native_shape import (
    HBC_SHA256, native_aed_display_minor, native_invoice_observations,
)
from noon_marketplace_review import ReviewError, digest, minor, require, text


NATIVE_ROLE_CONTRACT = {
    'hbc_sha256': HBC_SHA256,
    'entry_inventory': 'invoice.sections[].entries[]',
    'entry_title': 'f116858@381,@440: HTML title',
    'entry_amount': 'f116858@652,@712: HTML amount',
    'analytics_only': 'f116850@54..104: breakdown.analyticsFeeType -> info_click',
    'section_layout_only': 'f116862@6: isSpecial; f84550@6..27: nudges/sections',
    'native_accounting_role_supported': False,
    'default_label_roles': (),
}


@dataclass(frozen=True)
class InvoiceRowRole:
    """Local meaning assigned to one exact HTML label at one observed row path."""
    source_path: tuple
    title: str
    role: str  # subtotal, fee, discount, total; never a native fee code


@dataclass(frozen=True)
class LocalInvoiceReview:
    """Caller-owned user review; must not be constructed from server role fields.

    Bind the whole session and invoice, including section metadata and breakdowns.
    review_ref identifies the actual local user decision, not static HBC evidence.
    This module checks binding/coverage; the caller owns provenance of the decision.
    """
    session_hash: str
    invoice_hash: str
    rows: tuple
    review_ref: str


class _Title(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.stack = []

    def handle_starttag(self, tag, attrs):
        require(tag in ('b', 'strong', 'span') and not attrs,
                'UNSUPPORTED_INVOICE_TITLE_HTML')
        self.stack.append(tag)

    def handle_endtag(self, tag):
        require(bool(self.stack) and self.stack.pop() == tag,
                'INVALID_INVOICE_TITLE_HTML')

    def handle_data(self, data):
        self.parts.append(data)

    def handle_comment(self, data):
        raise ReviewError('UNSUPPORTED_INVOICE_TITLE_HTML')

    handle_decl = handle_comment
    handle_pi = handle_comment
    unknown_decl = handle_comment


def _title(value, path):
    require(type(value) is str and 0 < len(value) <= 4096,
            'INVALID_NATIVE_FIELD:' + path)
    parser = _Title()
    parser.feed(value)
    parser.close()
    require(not parser.stack, 'INVALID_INVOICE_TITLE_HTML')
    display = ''.join(parser.parts).replace('\xa0', ' ')
    require(not any(unicodedata.category(c).startswith('C') for c in display),
            'INVALID_INVOICE_TITLE_HTML')
    display = ' '.join(display.split())
    require(bool(display), 'INVALID_NATIVE_FIELD:' + path)
    return unicodedata.normalize('NFKC', display).casefold()


def _required(obj, key, path):
    require(type(obj) is dict, 'INVALID_NATIVE_FIELD:' + path)
    require(key in obj, 'MISSING_NATIVE_FIELD:' + path)
    return obj[key]


def _money(session, key):
    value = _required(session, key, key)
    try:
        return minor(value)
    except ReviewError:
        raise ReviewError('INVALID_NATIVE_FIELD:' + key) from None


def _invoice(session):
    invoice = _required(session, 'invoice', 'invoice')
    sections = _required(invoice, 'sections', 'invoice.sections')
    require(type(sections) is list and bool(sections),
            'INVALID_NATIVE_FIELD:invoice.sections')
    count = 0
    for i, section in enumerate(sections):
        prefix = f'invoice.sections[{i}]'
        entries = _required(section, 'entries', prefix + '.entries')
        require(type(entries) is list,
                'INVALID_NATIVE_FIELD:' + prefix + '.entries')
        for j, row in enumerate(entries):
            path = prefix + f'.entries[{j}]'
            _required(row, 'title', path + '.title')
            _required(row, 'amount', path + '.amount')
            count += 1
    require(count > 0, 'EMPTY_NATIVE_INVOICE')
    return invoice


def native_invoice_reconcile(session, invoice_observations, *, local_review=None):
    """Reconcile all observed invoice rows with actual native monetary controls.

    Requires exact session subtotal/total/orderPaymentAmount/useCredits and the
    COMPLETE unmodified native_invoice_observations(session) output. A caller-owned
    LocalInvoiceReview maps every exact title/path to its local accounting meaning.
    There is no fuzzy matching, sign-derived role, analytics-derived role, ignored
    row, optional money default, or synthetic fee code. Duplicate visible titles
    anywhere in the invoice and duplicate subtotal/total roles fail as ambiguous.

    Supported subset: AED displays, nonnegative subtotal/total/fees, nonpositive
    discounts, credits disabled, payment == total. Enabling credits requires a
    separate applied-credit contract and is unsupported here. Known donation
    charges reject. Noon One enrollment is not a new membership purchase.
    Unobserved cart/session extras remain outside
    this function's proof; the result must not be used as checkout authorization.
    """
    require(type(session) is dict, 'INVALID_NATIVE_FIELD:session')
    subtotal = _money(session, 'subtotal')
    total = _money(session, 'total')
    payment = _money(session, 'orderPaymentAmount')
    credits = _required(session, 'useCredits', 'useCredits')
    require(type(credits) is bool, 'INVALID_NATIVE_FIELD:useCredits')
    invoice = _invoice(session)
    expected = native_invoice_observations(session)
    require(type(invoice_observations) is list
            and digest(invoice_observations) == digest(expected),
            'INCOMPLETE_OR_CHANGED_INVOICE_OBSERVATIONS')
    require(local_review is not None, 'LOCAL_INVOICE_LABEL_REVIEW_REQUIRED')
    require(type(local_review) is LocalInvoiceReview, 'INVALID_LOCAL_INVOICE_REVIEW')
    text(local_review.review_ref, 'LOCAL_INVOICE_REVIEW_REF_REQUIRED')
    require(local_review.session_hash == digest(session)
            and local_review.invoice_hash == digest(invoice),
            'LOCAL_INVOICE_REVIEW_SNAPSHOT_MISMATCH')
    require(type(local_review.rows) is tuple and len(local_review.rows) == len(expected),
            'LOCAL_INVOICE_ROLE_COVERAGE_MISMATCH')
    roles = {}
    for row in local_review.rows:
        require(type(row) is InvoiceRowRole and type(row.source_path) is tuple
                and len(row.source_path) == 5
                and row.source_path[:2] == ('invoice', 'sections')
                and row.source_path[3] == 'entries'
                and type(row.source_path[2]) is int and row.source_path[2] >= 0
                and type(row.source_path[4]) is int and row.source_path[4] >= 0,
                'INVALID_LOCAL_INVOICE_ROW_PATH')
        require(row.source_path not in roles, 'DUPLICATE_LOCAL_INVOICE_ROW_PATH')
        require(type(row.role) is str and row.role in ('subtotal', 'fee', 'discount', 'total'),
                'UNSUPPORTED_INVOICE_ROW_ROLE_OR_EXTRA')
        roles[row.source_path] = row
    require(set(roles) == {row['source_path'] for row in expected},
            'LOCAL_INVOICE_ROLE_COVERAGE_MISMATCH')
    totals = {'subtotal': [], 'fee': [], 'discount': [], 'total': []}
    seen_titles = set()
    rows = []
    for observation in expected:
        path = observation['source_path']
        row = observation['native_entry']
        assignment = roles[path]
        prefix = f'invoice.sections[{path[2]}].entries[{path[4]}]'
        label = _title(row['title'], prefix + '.title')
        require(label not in seen_titles, 'AMBIGUOUS_DUPLICATE_INVOICE_LABEL')
        seen_titles.add(label)
        require(type(assignment.title) is str and assignment.title == row['title'],
                'LOCAL_INVOICE_LABEL_MISMATCH')
        try:
            amount = native_aed_display_minor(row['amount'])
        except ReviewError as error:
            raise ReviewError(error.code + ':' + prefix + '.amount') from None
        role = assignment.role
        require((amount <= 0 if role == 'discount' else amount >= 0),
                'INVOICE_ROLE_AMOUNT_SIGN_MISMATCH:' + prefix + '.amount')
        totals[role].append(amount)
        rows.append({'source_path': path, 'source_hash': observation['source_hash'],
                     'title': row['title'], 'local_role': role, 'amount_minor': amount})
    require(len(totals['subtotal']) == 1, 'EXACTLY_ONE_INVOICE_SUBTOTAL_REQUIRED')
    require(len(totals['total']) == 1, 'EXACTLY_ONE_INVOICE_TOTAL_REQUIRED')
    require(totals['subtotal'][0] == subtotal, 'INVOICE_SUBTOTAL_MISMATCH')
    require(totals['total'][0] == total, 'INVOICE_TOTAL_MISMATCH')
    fees = sum(totals['fee'])
    discounts = -sum(totals['discount'])
    require(subtotal + fees - discounts == total, 'INVOICE_ARITHMETIC_MISMATCH')
    require(not credits, 'UNSUPPORTED_NATIVE_APPLIED_CREDITS:useCredits')
    require(payment == total, 'ORDER_PAYMENT_AMOUNT_MISMATCH')
    if session.get('donation') is not None:
        require(_money(session, 'donation') == 0, 'UNSUPPORTED_NATIVE_EXTRA:donation')
    result = {
        'scope': 'native-invoice-arithmetic-only', 'currency': 'AED',
        'subtotal_minor': subtotal, 'fee_minor': fees, 'discount_minor': discounts,
        'total_minor': total, 'order_payment_minor': payment, 'useCredits': credits,
        'rows': rows, 'session_hash': digest(session), 'invoice_hash': digest(invoice),
        'local_review_hash': digest({
            'review_ref': local_review.review_ref,
            'rows': [{'source_path': r.source_path, 'title': r.title, 'role': r.role}
                     for r in local_review.rows],
        }),
        'role_basis': 'local-user-reviewed-exact-html-labels',
        'unsupported': ('native-accounting-role-codes', 'complete-extras-inventory',
                        'checkout-authorization'),
    }
    result['reconciliation_hash'] = digest(result)
    return result
