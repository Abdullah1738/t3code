"""Evidence-derived local review only. No fetching, approval UI or order transport.

Raw observations are private, caller-supplied data, not authenticated provenance.
This module closes consistency/expiry gaps; it cannot make old observations fresh,
authenticate an owner's approval, lock a server price or enable a purchase.
"""
from dataclasses import dataclass, field
from decimal import Decimal
import hashlib
import hmac
import json
import math

import talabat_place_contract as place
import talabat_submit_journal as journal

q = place.q
KEYS = frozenset(('expected_profile', 'profile', 'addresses', 'cards', 'vendor',
                  'cart_before', 'cart_after', 'payment_config', 'config_amount',
                  'quote', 'quote_body', 'payment_requirement'))
PROFILE_KEYS = frozenset(('id', 'mobile_country_code', 'mobile_number'))
_EPOCH = object()  # reviews cannot be restored as fresh across process restarts


def _fail(code):
    q.c._fail(code)


def _json(value):
    """Strict JSON primitives only; no coercion of keys, subclasses or NaN."""
    def check(item, depth=0):
        if depth > 32:
            _fail('FRESH_REVIEW_SCHEMA_UNSUPPORTED')
        if type(item) is dict:
            if any(type(k) is not str for k in item):
                _fail('FRESH_REVIEW_SCHEMA_UNSUPPORTED')
            for value in item.values():
                check(value, depth + 1)
        elif type(item) is list:
            for value in item:
                check(value, depth + 1)
        elif type(item) not in (str, int, float, bool, type(None)) or (
                type(item) is float and not math.isfinite(item)):
            _fail('FRESH_REVIEW_SCHEMA_UNSUPPORTED')
    check(value)
    raw = json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    if len(raw) > q.c.MAX_BYTES:
        _fail('FRESH_REVIEW_TOO_LARGE')
    return raw


def _hash(label, value):
    return hashlib.sha256(b'talabat-local-review-v1\0' + label.encode() + b'\0' + _json(value)).hexdigest()


def _clock(value):
    return type(value) in (int, float) and math.isfinite(value) and value > 0


def _fresh(observed_at, expires_at, started_monotonic, now, now_monotonic):
    if (not all(_clock(v) for v in (observed_at, expires_at, started_monotonic, now, now_monotonic))
            or not 0 < expires_at - observed_at <= 120
            or not observed_at <= now < expires_at
            or not 0 <= now_monotonic - started_monotonic < expires_at - observed_at
            or abs((now - observed_at) - (now_monotonic - started_monotonic)) > 2):
        _fail('FRESH_REVIEW_STALE_OR_CLOCK_CHANGED')


@dataclass(frozen=True)
class FrozenReview:
    """Detached hashes and safe display only; never contains private raw inputs."""
    digest: str
    expires_at: float
    _review: bytes = field(repr=False)
    _display: bytes = field(repr=False)
    _started_monotonic: float = field(repr=False)
    _epoch: object = field(repr=False, compare=False)
    _integrity: str = field(repr=False)


def build_review(snapshot, *, observed_at, now, started_monotonic, now_monotonic, ttl=120):
    """Validate one coherent supplied observation bundle and derive all bindings.

    observed_at/started_monotonic must be captured BEFORE the oldest observation,
    not when this function runs. config_amount is the actual payment-config GET
    request amount; the response does not independently echo/certify it. A future
    trusted adapter must provide that provenance. Full relevant response hashes
    deliberately invalidate approval even on conservative/unclassified drift.
    """
    if type(ttl) is not int or not 1 <= ttl <= 120 or not _clock(observed_at):
        _fail('FRESH_REVIEW_TIME_INVALID')
    expires = observed_at + ttl
    _fresh(observed_at, expires, started_monotonic, now, now_monotonic)
    if type(snapshot) is not dict or set(snapshot) != KEYS:
        _fail('FRESH_REVIEW_OBSERVATIONS_REQUIRED')
    # Detach once so caller mutations cannot alter the validated request/review.
    data = json.loads(_json(snapshot))
    expected, profile = data['expected_profile'], data['profile']
    if (type(expected) is not dict or set(expected) != PROFILE_KEYS
            or type(expected['id']) is not int or expected['id'] <= 0
            or expected['mobile_country_code'] != '971'
            or type(expected['mobile_number']) is not str or not expected['mobile_number'].isascii()
            or not expected['mobile_number'].isdigit() or not 7 <= len(expected['mobile_number']) <= 15
            or type(profile) is not dict
            or not q._same_json({k:profile.get(k) for k in PROFILE_KEYS}, expected)):
        _fail('FRESH_REVIEW_ACCOUNT_MISMATCH')
    try:
        home = q.c.select_home(data['addresses'], {'expected_profile':expected})
        card = q.c.select_card(data['cards'])
        vendor = q.c.select_vendor(data['vendor'])
        before, after = data['cart_before'], data['cart_after']
        q.require_current_cart(before, after)
        if (not q._same_json(before.get('items'), after.get('items'))
                or not q._same_json(before.get('subtotal_after_discount'), after.get('subtotal_after_discount'))):
            _fail('FRESH_REVIEW_CART_CHANGED')
        body = place.place_body(home=home, vendor=vendor, config=data['payment_config'],
                                saved_card=card, quote=data['quote'], quote_body=data['quote_body'],
                                cart_id=after['id'], payment_requirement=data['payment_requirement'])
        projected = q.project_quote({'home':home, 'cart_id':after['id'],
                                     'body':data['quote_body'], 'response':data['quote']})
        amount = projected['amount']
        if (q._money(data['config_amount']) != amount
                or q._money(after['subtotal_after_discount']) != projected['item_total']):
            _fail('FRESH_REVIEW_AMOUNT_CONTEXT_MISMATCH')
    except q.c.http.TalabatError:
        raise
    except (TypeError, KeyError, ValueError, AttributeError, IndexError):
        _fail('FRESH_REVIEW_SCHEMA_UNSUPPORTED')
    checkout = data['quote']['checkout']
    bindings = {
        # Stable account ID, not a changing phone/profile hash that could evade
        # the journal's same-account permanent fence.
        'account':_hash('account', {'id':expected['id'], 'country':4}),
        'cart':_hash('cart', {'before':before, 'after':after, 'vendor':vendor}),
        'home':_hash('home', {'profile':expected, 'home':home}),
        'card':_hash('card', {'saved_card':card, 'config':data['payment_config'],
                            'config_amount':data['config_amount']}),
        'items':_hash('items', checkout['cart']),
        'charges':_hash('charges', {'summary':checkout['paymentSummary'], 'amount':amount}),
        'instructions':_hash('instructions', {'controls':checkout['deliveryInstructions'],
            'tip':checkout['riderTips'], 'selected':body['deliveryInstructions'],
            'save_instructions':False, 'save_tip':False}),
        'request':_hash('request', {'place':body, 'prepare':data['quote_body'], 'quote':data['quote']}),
    }
    review = {'version':1, 'bindings':bindings, 'currency':'AED',
              'payable_minor':int(Decimal(amount) * 100), 'observed_at':observed_at, 'expires_at':expires}
    display = {'currency':'AED', 'payable_minor':review['payable_minor'],
        'item':'Quest Chocolate Protein Shake 325ml', 'quantity':1,
        'address':'Banyantree 2104', 'card_last4':'5542',
        'charges':projected['charges'], 'leave_at_door':True, 'no_bell':True, 'no_call':True,
        'tip_selected':False, 'subscription_selected':False, 'wallet_selected':False,
        'save_instructions':False, 'save_tip':False}
    review_bytes, display_bytes = _json(review), _json(display)
    integrity = _hash('frozen', [review, display, started_monotonic])
    return FrozenReview(journal.review_digest(review), expires, review_bytes, display_bytes,
                        started_monotonic, _EPOCH, integrity)


def _validate(frozen, now, now_monotonic):
    if type(frozen) is not FrozenReview or frozen._epoch is not _EPOCH:
        _fail('FRESH_REVIEW_PROCESS_OR_TYPE_INVALID')
    try:
        review = json.loads(frozen._review)
        display = json.loads(frozen._display)
        if (journal.review_digest(review) != frozen.digest or frozen.expires_at != review['expires_at']
                or _hash('frozen', [review, display, frozen._started_monotonic]) != frozen._integrity):
            _fail('FRESH_REVIEW_TAMPERED')
        _fresh(review['observed_at'], review['expires_at'], frozen._started_monotonic, now, now_monotonic)
    except q.c.http.TalabatError:
        raise
    except (ValueError, TypeError, KeyError):
        _fail('FRESH_REVIEW_TAMPERED')
    return review


def project_review(frozen, *, now, now_monotonic):
    """Safe review for display, never an instruction to buy or raw observation log."""
    _validate(frozen, now, now_monotonic)
    return {**json.loads(frozen._display), 'review_digest':frozen.digest, 'expires_at':frozen.expires_at,
            'local_consistency_verified':True, 'fresh_server_provenance_verified':False,
            'owner_authorization_verified':False, 'server_price_lock_verified':False,
            'payment_completion_verified':False, 'ready_to_order':False, 'commit_enabled':False}


@dataclass(frozen=True)
class BoundAcknowledgement:
    """Same-process acknowledgement timing, not authenticated owner identity."""
    digest: str
    approved_at: float
    approved_monotonic: float = field(repr=False)
    _epoch: object = field(repr=False, compare=False)
    _integrity: str = field(repr=False)


def bind_acknowledgement(frozen, decision, *, now, now_monotonic):
    """Timestamp an exact local decision in this process, without enabling IO.

    A future trusted owner-interaction adapter must call this when the owner
    actually responds, using its own wall/monotonic clocks, not supplied history.
    """
    _validate(frozen, now, now_monotonic)
    if (type(decision) is not dict or set(decision) != {'decision', 'digest'}
            or decision['decision'] != 'approve_exact_review'
            or not journal._hash(decision['digest'])
            or not hmac.compare_digest(frozen.digest, decision['digest'])):
        _fail('FRESH_REVIEW_APPROVAL_BINDING_INVALID')
    integrity = _hash('acknowledgement', [frozen.digest, now, now_monotonic])
    return BoundAcknowledgement(frozen.digest, now, now_monotonic, _EPOCH, integrity)


def check_approval_binding(frozen, current, acknowledgement, *, now, now_monotonic):
    """Check a LOCAL acknowledgement against original and revalidated observations.

    An acknowledgement must come from a future trusted owner-interaction adapter;
    a local decision/digest is not identity or authorization proof. This neither consumes the
    journal nor returns a send permit. It cannot renew the original review's TTL.
    """
    original = _validate(frozen, now, now_monotonic)
    latest = _validate(current, now, now_monotonic)
    ack = acknowledgement
    if (type(ack) is not BoundAcknowledgement or ack._epoch is not _EPOCH
            or not journal._hash(ack.digest) or not hmac.compare_digest(frozen.digest, ack.digest)
            or not _clock(ack.approved_at) or not _clock(ack.approved_monotonic)
            or _hash('acknowledgement', [ack.digest, ack.approved_at, ack.approved_monotonic]) != ack._integrity):
        _fail('FRESH_REVIEW_APPROVAL_BINDING_INVALID')
    _fresh(original['observed_at'], original['expires_at'], frozen._started_monotonic,
           ack.approved_at, ack.approved_monotonic)
    _fresh(ack.approved_at, original['expires_at'], ack.approved_monotonic, now, now_monotonic)
    if (not q._same_json(original['bindings'], latest['bindings'])
            or original['payable_minor'] != latest['payable_minor']
            or frozen._display != current._display
            or latest['observed_at'] < original['observed_at']
            or current._started_monotonic < frozen._started_monotonic):
        _fail('FRESH_REVIEW_CHANGED_REAPPROVAL_REQUIRED')
    if (latest['observed_at'] <= ack.approved_at
            or current._started_monotonic <= ack.approved_monotonic):
        _fail('FRESH_REVIEW_POST_APPROVAL_REVALIDATION_REQUIRED')
    return {'approval_binding_matches':True, 'owner_authorization_verified':False,
            'fresh_server_provenance_verified':False, 'ready_to_order':False, 'commit_enabled':False}


def require_live_review_enabled():
    """No new quote path/marker lifecycle is enabled by these offline helpers."""
    _fail('FRESH_REVIEW_LIVE_TRANSPORT_AND_OWNER_APPROVAL_UNPROVEN')
