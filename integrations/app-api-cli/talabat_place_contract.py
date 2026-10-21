"""Pure, bounded place-body contract and fail-closed response interpretation.

No transport, CLI, auth access, journal consumption or payment completion exists
here. Private inputs/results must stay in memory. A body is neither fresh evidence
nor authorization. Only project_response() is suitable for logs/persistence.
"""
from dataclasses import dataclass, field
from decimal import Decimal
import re

import talabat_quote as q


def require_submission_enabled():
    """Unconditional stop, before any future auth, journal or network work."""
    q.c._fail('SUBMIT_DISABLED_PAYMENT_COMPLETION_AND_FRESH_AUTHORIZATION_UNPROVEN')


def require_no_payment_challenge(requirement):
    """Local discriminant, NOT a guessed response JSON path or completion proof.

    ForceCVV is an evidenced native payment-config discriminant. Its precise
    config-to-saved-card continuation is unresolved; unknown requirements stop too.
    None means no supplied requirement, not proof none will occur downstream.
    """
    if requirement is not None:
        q.c._fail('SUBMIT_CVV_REQUIRED' if type(requirement) is str and requirement == 'ForceCVV'
                  else 'SUBMIT_PAYMENT_CHALLENGE_UNSUPPORTED')


def place_body(*, home, vendor, config, saved_card, quote, quote_body, cart_id, payment_requirement=None):
    """Build ONLY the supported saved-Home/5542/Quest ordinary-delivery draft.

    The caller must independently establish fresh account/Home/cart provenance and
    supply the exact selected-card prepare body used to obtain this quote. Local
    equality cannot prove that it really was sent or that the response is current.
    Validation here is offline consistency only. Flow=null and absent-tip nulls
    are explicit supported branches, not a claim of exact UI replay. There is no
    amount/revision/expiry field on this native request. No-save false does not
    clear past defaults or certify server persistence behavior.
    """
    require_no_payment_challenge(payment_requirement)
    prepared = q.selected_card_body(home, vendor, config, saved_card)
    if not q._same_json(quote_body, prepared):
        q.c._fail('PLACE_DRAFT_PREPARE_BINDING_INVALID')
    if not prepared['selectedAddressId'].strip() or not prepared['cardFingerPrint'].strip():
        q.c._fail('PLACE_DRAFT_IDENTITY_INVALID')
    if not q.c._identifier(cart_id) or not cart_id.strip() or type(quote) is not dict:
        q.c._fail('PLACE_DRAFT_QUOTE_BINDING_INVALID')
    checkout = quote.get('checkout')
    if (type(checkout) is not dict or type(quote.get('branchInfo')) is not dict
            or type(checkout.get('address')) is not dict):
        q.c._fail('PLACE_DRAFT_QUOTE_SCHEMA_UNSUPPORTED')
    country = quote['branchInfo'].get('country')
    address = checkout['address']
    if (not q._same_json(checkout.get('branchId'), q.c.BRANCH)
            or type(country) is not dict or not q._same_json(country.get('id'), 4)
            or not q._same_json(address.get('areaId'), home['area_id'])
            or not q._same_json(address.get('latitude'), home['latitude'])
            or not q._same_json(address.get('longitude'), home['longitude'])):
        q.c._fail('PLACE_DRAFT_QUOTE_BINDING_INVALID')
    summary = checkout.get('paymentSummary')
    charges = summary.get('items') if type(summary) is dict else None
    # The review projector can omit malformed rows. A place draft must reject
    # them instead, rather than mistaking the remaining known rows for all fees.
    if type(charges) is not list or len(charges) != 4 or any(type(row) is not dict for row in charges):
        q.c._fail('PLACE_DRAFT_CHARGES_SCHEMA_UNSUPPORTED')
    evidence = {'home':home, 'cart_id':cart_id, 'body':quote_body, 'response':quote}
    try:
        projected = q.project_quote(evidence)
    except q.c.http.TalabatError:
        raise
    except (TypeError, ValueError, AttributeError, KeyError):
        q.c._fail('PLACE_DRAFT_QUOTE_SCHEMA_UNSUPPORTED')
    if (projected['quote_ready_for_review'] is not True
            or not Decimal('0') < Decimal(projected['amount']) <= Decimal('50')):
        q.c._fail('PLACE_DRAFT_QUOTE_NOT_REVIEWABLE')
    choices = q.c.instruction_choices(checkout.get('deliveryInstructions'))
    if any(choice.title not in q.PRESET_LABELS for choice in choices):
        q.c._fail('PLACE_DRAFT_INSTRUCTIONS_UNSUPPORTED')
    # selected_card_body already requires exactly one enabled event matching the
    # saved tokenId, validates its method/BIN/fingerprint, and refuses wallet state.
    row = next(row for row in config['paymentMethods']
               if type(row.get('events')) is dict
               and type(row['events'].get('payment')) is dict
               and type(row['events']['payment'].get('card')) is dict
               and row['events']['payment']['card'].get('cardId') == saved_card['tokenId'])
    card_id = row['events']['payment']['card']['cardId']
    if type(card_id) is not str or not card_id.strip():
        q.c._fail('PLACE_DRAFT_CARD_ID_INVALID')
    # Explicit allowlist: never merge prepare features/nullable-wallet/hasDues.
    body = {key:prepared[key] for key in (
        'countryCode', 'paymentMethod', 'addTPayMethod', 'binNumber', 'isMigrated',
        'branchId', 'verticalId', 'selectedAddressId', 'addressV2', 'cardFingerPrint')}
    body.update(allowDuplicateOrder=False, riderTipAmount=None, isCustomRiderTip=None,
                saveRiderTipForLater=False, proSubscribeChecked=False, cardTokenId=card_id,
                proPlanId=None, priorityLevel='', quickCheckout=False, flow=None,
                deliveryInstructions=[choice.id for choice in choices if choice.selected],
                saveDeliveryInstructionsForLater=False)
    return body


@dataclass(frozen=True)
class PlaceObservation:
    """Private returned identities for potential exact-ID reconciliation, not paid.

    repr excludes every server-supplied value. Never persist/asdict this object.
    Even when parsing fails, a valid received order ID is retained for readback.
    """
    state: str
    reason: str
    order_id: str | None = field(default=None, repr=False)
    transaction_id: str | None = field(default=None, repr=False)
    balance_amount: str | None = field(default=None, repr=False)
    redirect_url: str | None = field(default=None, repr=False)


def _order_id(value):
    # Stricter than native String: this is the exact-ID tracking route's contract.
    return value if type(value) is str and re.fullmatch(r'[0-9]{1,20}', value) else None


def _transaction_id(value):
    return value if type(value) is str and q.c._identifier(value) and value.strip() else None


def parse_response(status, body):
    """Interpret an already-received post-send result without any side effect.

    None/malformed/error responses are SUBMISSION_UNKNOWN, never retry-safe.
    Only HTTP200 follows the native success parser, and even that is pending.
    Error actions, redirects and telemetry are never executed or forwarded.
    """
    if type(body) is not dict:
        return PlaceObservation('SUBMISSION_UNKNOWN', 'RESPONSE_MISSING_OR_MALFORMED')
    placed = body.get('placedOrder')
    placed = placed if type(placed) is dict else {}
    order_id = _order_id(placed.get('orderId'))
    transaction_id = _transaction_id(placed.get('transactionId'))

    def stopped(state, reason):
        return PlaceObservation(state, reason, order_id, transaction_id)

    generic = body.get('genericError')
    mobile = (type(generic) is dict and
              ((type(generic.get('errorCode')) is int and generic['errorCode'] == 107)
               or generic.get('errorMessage') == 'Mobile Number cant be empty'))
    # Presence stops even if fields are malformed, including on HTTP200. The app's
    # fallback with missing local phone info is not permission to skip verification.
    if body.get('smsVerificationError') is not None or mobile:
        return stopped('CHALLENGE_REQUIRED', 'MOBILE_VERIFICATION_REQUIRED')
    if body.get('duplicateOrderError') is not None:
        if (type(status) is int and status == 400
                and type(body['duplicateOrderError']) is dict
                and body.get('placedOrder') is None and generic is None
                and not set(body) - {'duplicateOrderError', 'placedOrder', 'genericError',
                                     'smsVerificationError', 'tracking', 'trackingInfo'}):
            return stopped('REJECTED_DUPLICATE', 'DUPLICATE_ORDER_ERROR_NO_RETRY')
        return stopped('SUBMISSION_UNKNOWN', 'DUPLICATE_ORDER_ERROR_NO_RETRY')
    if generic is not None:
        return stopped('SUBMISSION_UNKNOWN', 'GENERIC_ERROR_NO_RETRY')
    if type(status) is not int or status != 200:
        return stopped('SUBMISSION_UNKNOWN', 'HTTP_STATUS_UNSUPPORTED_NO_RETRY')
    if order_id is None or transaction_id is None:
        return stopped('SUBMISSION_UNKNOWN', 'PLACED_ORDER_IDENTITY_INVALID')
    balance = placed.get('balanceAmount')
    redirect = placed.get('redirectUrl')
    balance = '0.0' if balance is None else balance
    redirect = '' if redirect is None else redirect
    if (type(balance) is not str or type(redirect) is not str
            or (body.get('trackingInfo') is not None and type(body['trackingInfo']) is not dict)
            or (body.get('tracking') is not None and type(body['tracking']) is not dict)):
        return stopped('SUBMISSION_UNKNOWN', 'PLACED_ORDER_SCHEMA_UNSUPPORTED')
    return PlaceObservation('CHALLENGE_REQUIRED' if redirect else 'PAYMENT_PENDING',
                            'PAYMENT_REDIRECT_UNSUPPORTED' if redirect else 'PAYMENT_COMPLETION_UNPROVEN',
                            order_id, transaction_id, balance, redirect)


def project_response(observation):
    """Allowlisted safe state only. No IDs, URLs, messages, actions or amounts."""
    if type(observation) is not PlaceObservation or (observation.state, observation.reason) not in {
            ('SUBMISSION_UNKNOWN', 'RESPONSE_MISSING_OR_MALFORMED'),
            ('SUBMISSION_UNKNOWN', 'DUPLICATE_ORDER_ERROR_NO_RETRY'),
            ('REJECTED_DUPLICATE', 'DUPLICATE_ORDER_ERROR_NO_RETRY'),
            ('SUBMISSION_UNKNOWN', 'GENERIC_ERROR_NO_RETRY'),
            ('SUBMISSION_UNKNOWN', 'HTTP_STATUS_UNSUPPORTED_NO_RETRY'),
            ('SUBMISSION_UNKNOWN', 'PLACED_ORDER_IDENTITY_INVALID'),
            ('SUBMISSION_UNKNOWN', 'PLACED_ORDER_SCHEMA_UNSUPPORTED'),
            ('CHALLENGE_REQUIRED', 'MOBILE_VERIFICATION_REQUIRED'),
            ('CHALLENGE_REQUIRED', 'PAYMENT_REDIRECT_UNSUPPORTED'),
            ('PAYMENT_PENDING', 'PAYMENT_COMPLETION_UNPROVEN')}:
        q.c._fail('PLACE_OBSERVATION_INVALID')
    return {'state':observation.state, 'reason':observation.reason,
            'order_id_received':_order_id(observation.order_id) is not None,
            'transaction_id_received':_transaction_id(observation.transaction_id) is not None,
            'redirect_present':type(observation.redirect_url) is str and bool(observation.redirect_url),
            'submission_may_have_occurred':True, 'exact_order_readback_verified':False,
            'payment_completion_verified':False, 'merchant_acceptance_verified':False,
            'retry_allowed':False, 'ready_to_order':False, 'commit_enabled':False}
