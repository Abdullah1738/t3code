"""Readiness plus an explicit parent-only cart experiment; ordering stays disabled."""
import argparse
import datetime as dt
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
import hashlib
import hmac
from http.client import HTTPException
import json
import math
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import order_card
import talabat_auth as auth
import talabat_http_orders as http

API = 'https://api.talabat.com'
ADDRESS_API = 'https://userlocation.talabat.com'
CARDS = '/pay/v1/cards'
ADDRESSES = '/api/v2/user/addresses'
BRANCH = 798285
VENDOR = f'/grocery/v2/TB_AE/branches/{BRANCH}'
CART = '/grocery/v2/cart'
QUEST = '0130fb0a-223a-4ca9-8b26-c250244f68e3'
PROBE_MARKER = 'talabat-quest-cart-post.intent'
MAX_BYTES = 2_000_000
HOME_NAMES = {'banyantree', 'banyantreeresidences', 'banyantreeresidenceshillside',
              'banyantreehillside'}
BLOCKERS = (
    'CART_REPLACE_AND_APP_SYNC_SEMANTICS_UNVERIFIED',
    'QUOTE_CART_BINDING_AND_PAYABLE_TOTAL_UNVERIFIED',
    'PAYMENT_ENUM_AND_CARD_TOKEN_MAPPING_UNVERIFIED',
    'QUIET_INSTRUCTION_IDS_AND_READBACK_UNVERIFIED',
    'COMMIT_IDEMPOTENCY_AND_RECONCILIATION_UNVERIFIED',
)
QUIET_CHOICES = frozenset(('leave_at_door', 'no_bell', 'no_call'))
QUIET_NOTE = "Leave at door; don't ring bell; don't call."
# Local review format, NOT Talabat request/response field names. Only hashes of
# private bindings are accepted. None of these hashes certifies server evidence.
# This unused v1 experiment is NOT a future adapter prerequisite: do not invent
# server revisions/expiry when the real API lacks them just to fit this format.
REVIEW_BINDINGS = frozenset((
    'account_sha256', 'cart_sha256', 'server_cart_revision_sha256',
    'server_quote_binding_sha256', 'items_sha256', 'charges_sha256', 'home_sha256',
    'payment_sha256', 'quiet_instructions_sha256', 'checkout_policy_sha256',
))
REVIEW_KEYS = frozenset(('schema_version', 'branch_id', 'bindings', 'currency',
                         'payable_minor', 'observed_at', 'expires_at'))


def _fail(code):
    raise http.TalabatError(code)


def _number(value, low, high):
    return (type(value) in (int, float) and math.isfinite(value)
            and low <= value <= high)


def _identifier(value):
    return isinstance(value, str) and 0 < len(value) <= 512 and not any(ord(c) < 32 for c in value)


def verticals_key(pool):
    """Public production 13.95.0 APK constant, read into memory only."""
    try:
        with Path(pool).open() as source:
            for line in source:
                if line.startswith('[pp+0x7c80] String: '):
                    value = json.loads(line.split('String: ', 1)[1])
                    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{16}', value):
                        break
                    return value
    except (OSError, ValueError, TypeError):
        pass
    _fail('PUBLIC_APK_VERTICALS_KEY_UNAVAILABLE')


def select_card(data, now=None):
    """Return private card only inside this process; never change payment state."""
    if not isinstance(data, dict) or not isinstance(data.get('data'), list) or data.get('error') not in ('', None):
        _fail('SAVED_CARDS_SCHEMA_CHANGED')
    cards = data['data']
    if not all(isinstance(card, dict) for card in cards):
        _fail('SAVED_CARDS_SCHEMA_CHANGED')
    matches = [c for c in cards if isinstance(c.get('cardNumber'), str)
               and re.fullmatch(r'[0-9 *xX•●-]*' + order_card.LAST4, c['cardNumber'])]
    if len(matches) != 1:
        _fail('EXACT_SAVED_CARD_NOT_UNIQUE')
    card = matches[0]
    if (type(card.get('CountryId')) is not int or card['CountryId'] != 4
            or card.get('isExpired') is not False or card.get('isValidCard') is not True
            or card.get('isForceCvv') is not False):
        _fail('SAVED_CARD_NOT_READY_OR_CVV_REQUIRED')
    year, month = card.get('expireYear'), card.get('expireMonth')
    if (not isinstance(year, str) or not re.fullmatch(r'(?:[0-9]{2}|[0-9]{4})', year)
            or not isinstance(month, str) or not re.fullmatch(r'[0-9]{1,2}', month)
            or not 1 <= int(month) <= 12):
        _fail('SAVED_CARD_EXPIRY_INVALID')
    year = int(year) + (2000 if len(year) == 2 else 0)
    now = now or dt.datetime.now(dt.timezone.utc)
    if (year, int(month)) < (now.year, now.month):
        _fail('SAVED_CARD_EXPIRED')
    if not all(_identifier(card.get(k)) for k in ('token', 'tokenId')):
        _fail('SAVED_CARD_MATERIAL_MISSING')
    return card


def select_home(data, saved):
    if (not isinstance(data, dict) or data.get('has_error') is not False
            or not isinstance(data.get('result'), list)
            or not all(isinstance(a, dict) for a in data['result'])):
        _fail('SAVED_ADDRESS_SCHEMA_CHANGED')
    homes = [a for a in data['result']
             if isinstance(a.get('profile_name'), str)
             and re.sub(r'[^a-z]', '', a['profile_name'].lower()) in HOME_NAMES
             and a.get('suite') == '2104']
    if len(homes) != 1:
        _fail('EXACT_SAVED_HOME_NOT_UNIQUE')
    home = homes[0]
    if (type(home.get('cust_id')) is not int
            or str(home['cust_id']) != str(saved['expected_profile']['id'])
            or type(home.get('country')) is not int or home['country'] != 4
            or type(home.get('area_id')) is not int or home['area_id'] != 1308
            or not _identifier(home.get('id'))
            or not _number(home.get('latitude'), 25.06, 25.10)
            or not 25.06 < home['latitude'] < 25.10
            or not _number(home.get('longitude'), 55.14, 55.18)
            or not 55.14 < home['longitude'] < 55.18
            or not isinstance(home.get('delivery_instructions'), list)):
        _fail('SAVED_HOME_BINDING_INVALID')
    return home


def select_vendor(data):
    vendor = data.get('vendor') if isinstance(data, dict) else None
    if (not isinstance(vendor, dict) or type(vendor.get('talabat_id')) is not int
            or vendor['talabat_id'] != BRANCH or not _identifier(vendor.get('global_id'))
            or type(vendor.get('chain_id')) is not int or vendor['chain_id'] <= 0
            or vendor.get('is_dark_store') is not True):
        _fail('VENDOR_BINDING_INVALID')
    return vendor


def project_cart(data):
    if (not isinstance(data, dict) or not _identifier(data.get('id'))
            or not isinstance(data.get('items'), list)
            or not all(isinstance(item, dict) for item in data['items'])
            or type(data.get('subtotal_after_discount')) not in (int, float)):
        _fail('CART_SCHEMA_CHANGED')
    try:
        subtotal = Decimal(str(data['subtotal_after_discount']))
        if not subtotal.is_finite() or subtotal < 0:
            raise InvalidOperation()
    except (InvalidOperation, ValueError):
        _fail('CART_SCHEMA_CHANGED')
    # Empty here is scoped only to this GET, not other vendors or device-local carts.
    empty = not data['items'] and subtotal == 0
    return {'branch_id': BRANCH, 'cart_id_present': True,
            'item_rows': len(data['items']), 'empty': empty,
            'request_account_bound': True, 'response_owner_binding_verified': False,
            'app_cart_sync_verified': False, 'payable_total': None}


@dataclass(frozen=True)
class DeliveryInstruction:
    id: str
    title: str
    selected: bool
    enabled: bool


def instruction_choices(container):
    """Parse the statically observed *nested* instruction model, not a quote.

    Unlike the app's lenient parser, missing/stringified booleans fail closed.
    Titles/IDs are returned only to an in-process caller, never readiness/CLI.
    No assumptions are made about a quote's outer response shape or saved Home's
    unrelated delivery_instructions list.
    """
    rows = container.get('instructions') if type(container) is dict else None
    if type(rows) is not list or not 1 <= len(rows) <= 64:
        _fail('DELIVERY_INSTRUCTIONS_SCHEMA_UNVERIFIED')
    choices, seen = [], set()
    for row in rows:
        if (type(row) is not dict or not _identifier(row.get('id'))
                or not row['id'].strip() or not _identifier(row.get('title'))
                or not row['title'].strip() or type(row.get('isSelected')) is not bool
                or type(row.get('isEnabled')) is not bool or row['id'] in seen):
            _fail('DELIVERY_INSTRUCTIONS_SCHEMA_UNVERIFIED')
        seen.add(row['id'])
        choices.append(DeliveryInstruction(row['id'], row['title'],
                                           row['isSelected'], row['isEnabled']))
    return tuple(choices)


def quiet_instruction_ids(container, observed_bindings, *, note_readback):
    """Check observed controls (including negative states) plus exact notes.

    This is offline consistency checking, NOT proof the labels have those
    meanings or that the server saved them. Never infer meaning from list order,
    a translation, icon, title substring, or fabricated numeric IDs. A binding is
    either {id, title, selected: bool} or an explicit {control_absent: True}
    observation. In particular, no_call may mean Call on arrival is UNselected;
    leave_at_door may have no control and use notes. No three-positive-ID rule.
    All three policies must be covered and the full fixed note read back, even
    when controls exist. Absence is supplied evidence, never guessed from titles.
    The returned tuple follows the app's selected-entry order. This helper does
    not save preferences and does not serialize saveDeliveryInstructionsForLater.
    """
    if type(observed_bindings) is not dict or set(observed_bindings) != QUIET_CHOICES:
        _fail('QUIET_INSTRUCTION_BINDINGS_REQUIRED')
    if type(note_readback) is not str or note_readback != QUIET_NOTE:
        _fail('QUIET_NOTE_READBACK_MISMATCH')
    choices = instruction_choices(container)
    by_id = {choice.id: choice for choice in choices}
    expected, bound = set(), set()
    for binding in observed_bindings.values():
        if type(binding) is dict and set(binding) == {'control_absent'} and binding['control_absent'] is True:
            continue
        if (type(binding) is not dict or set(binding) != {'id', 'title', 'selected'}
                or not _identifier(binding.get('id')) or not _identifier(binding.get('title'))
                or type(binding.get('selected')) is not bool):
            _fail('QUIET_INSTRUCTION_BINDINGS_REQUIRED')
        choice = by_id.get(binding['id'])
        if (choice is None or choice.title != binding['title']
                or choice.selected is not binding['selected']
                or (choice.selected and not choice.enabled) or choice.id in bound):
            _fail('QUIET_INSTRUCTION_READBACK_MISMATCH')
        bound.add(choice.id)
        if choice.selected:
            expected.add(choice.id)
    selected = tuple(choice.id for choice in choices if choice.selected)
    if set(selected) != expected:
        _fail('QUIET_INSTRUCTION_READBACK_MISMATCH')
    return selected


def _sha256(value):
    return type(value) is str and re.fullmatch(r'[0-9a-f]{64}', value) is not None


@dataclass(frozen=True)
class LocalReviewFingerprint:
    """Detached, in-memory local fingerprint. Not a quote or authorization.

    There is deliberately no serialize/authorize/send method or persisted state.
    Even a valid instance cannot enable prepare_quote, commit, or cancel_order.
    """
    digest: str
    expires_at: int
    _canonical: bytes = field(repr=False)


def freeze_local_review(review, *, now):
    """Fingerprint a strict local review envelope without private/raw values.

    Required hashes must eventually come from an observed adapter. Supplying
    them here does not prove account, card, instructions, cart isolation, server
    revision, server quote binding, expiry, or idempotency. Never manufacture a
    server revision/expiry from local time to satisfy this format. It is not an
    app wire schema. Validation and hashing perform no I/O.
    """
    if type(now) is not int or now <= 0 or type(review) is not dict or set(review) != REVIEW_KEYS:
        _fail('LOCAL_REVIEW_SCHEMA_INVALID')
    bindings = review['bindings']
    if (type(review['schema_version']) is not int or review['schema_version'] != 1
            or type(review['branch_id']) is not int or review['branch_id'] != BRANCH
            or review['currency'] != 'AED'
            or type(review['payable_minor']) is not int or not 0 < review['payable_minor'] < 10**9
            or type(bindings) is not dict or set(bindings) != REVIEW_BINDINGS
            or not all(_sha256(value) for value in bindings.values())
            or type(review['observed_at']) is not int or type(review['expires_at']) is not int
            or not 0 < review['observed_at'] <= now < review['expires_at'] < 2**63):
        _fail('LOCAL_REVIEW_INVALID_OR_EXPIRED')
    canonical = json.dumps(review, sort_keys=True, separators=(',', ':'),
                           ensure_ascii=True, allow_nan=False).encode('ascii')
    return LocalReviewFingerprint(hashlib.sha256(canonical).hexdigest(),
                                  review['expires_at'], canonical)


def require_same_local_review(frozen, current, expected_digest, *, now):
    """Reject local changes/staleness; does not consume or grant authorization."""
    if (type(frozen) is not LocalReviewFingerprint or not _sha256(frozen.digest)
            or not _sha256(expected_digest)):
        _fail('LOCAL_REVIEW_DIGEST_REQUIRED')
    candidate = freeze_local_review(current, now=now)
    if (not hmac.compare_digest(frozen.digest, expected_digest)
            or not hmac.compare_digest(candidate.digest, expected_digest)
            or candidate != frozen):
        _fail('LOCAL_REVIEW_CHANGED')
    return candidate


def _route(host, path, query, key, *, probe_context=False):
    """Exact GET-only allowlist; no caller-selected URL, method, body or headers."""
    allowed = {
        (API, CARDS): {'countryId'},
        (ADDRESS_API, ADDRESSES): {'countryId'},
        (API, VENDOR): {'areaId', 'lat', 'lon'},
        (API, CART): {'branch_id', 'dh_vendor_id', 'global_entity_id', 'chain_id',
                      'lat', 'lon', 'campaign_progress_required', 'has_outstanding_payments'},
    }
    if (type(probe_context) is not bool or (probe_context and path != CART)
            or type(query) is not dict or (host, path) not in allowed or set(query) != allowed[(host, path)]):
        _fail('CHECKOUT_READ_ENDPOINT_DENIED')
    if path in (CARDS, ADDRESSES) and (type(query['countryId']) is not int or query['countryId'] != 4):
        _fail('CHECKOUT_READ_ENDPOINT_DENIED')
    if path in (VENDOR, CART):
        if (not _number(query['lat'], 25.06, 25.10) or not 25.06 < query['lat'] < 25.10
                or not _number(query['lon'], 55.14, 55.18) or not 55.14 < query['lon'] < 55.18):
            _fail('CHECKOUT_READ_ENDPOINT_DENIED')
    if path == VENDOR and (type(query['areaId']) is not int or query['areaId'] != 1308):
        _fail('CHECKOUT_READ_ENDPOINT_DENIED')
    if path == CART:
        if (type(query['branch_id']) is not int or query['branch_id'] != BRANCH
                or query['global_entity_id'] != 'TB_AE' or not _identifier(query['dh_vendor_id'])
                or type(query['chain_id']) is not int or query['chain_id'] <= 0
                or query['campaign_progress_required'] != ('true' if probe_context else 'false')
                or query['has_outstanding_payments'] != 'false'
                or type(key) is not str or not re.fullmatch(r'[A-Za-z0-9_-]{16}', key)):
            _fail('CHECKOUT_READ_ENDPOINT_DENIED')
    elif key is not None:
        _fail('CHECKOUT_READ_ENDPOINT_DENIED')


def get_json(saved, host, path, query, deadline, key=None, *, probe_context=False):
    _route(host, path, query, key, probe_context=probe_context)
    headers = auth.native_headers(saved)
    for header in ('x-api-key', 'x-customer-id', 'x-platform', 'x-user-flow'):
        headers.pop(header, None)
    headers['authorization'] = 'Bearer ' + saved['auth']['access_token']
    if path == CART:
        headers.update({'x-api-key': key, 'x-customer-id': str(saved['expected_profile']['id']),
                        'x-platform': 'android'})
        if probe_context:
            headers.update({'x-tpro-deals-enabled': 'true', 'x-weightables-enabled': 'true'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), http.NoRedirect())
    try:
        url = host + path + '?' + urllib.parse.urlencode(query)
        req = urllib.request.Request(url, headers=headers, method='GET')
        with http.read_deadline(deadline) as remaining:
            with opener.open(req, timeout=remaining) as response:
                if response.code != 200:
                    _fail('CHECKOUT_READ_HTTP_STATUS')
                raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                _fail('RESPONSE_TOO_LARGE')
            data = json.loads(raw)
            if not isinstance(data, dict):
                _fail('CHECKOUT_READ_SCHEMA_CHANGED')
        return data
    except urllib.error.HTTPError as exc:
        exc.close()
        auth.http_ok(exc.code)
        _fail('CHECKOUT_READ_HTTP_STATUS')
    except (urllib.error.URLError, HTTPException, OSError, ValueError, TypeError):
        _fail('CHECKOUT_READ_FAILED')


def readiness(apk_pool, timeout=30):
    """One five-GET batch, no refresh/OTP, no persistence, no checkout mutation."""
    deadline = auth.new_deadline(timeout)
    key = verticals_key(apk_pool)
    saved = http.account()  # deliberately not read_with_renewal
    http.verify_profile(http.request(http.PROFILE, saved, deadline), saved)
    select_card(get_json(saved, API, CARDS, {'countryId': 4}, deadline))
    home = select_home(get_json(saved, ADDRESS_API, ADDRESSES, {'countryId': 4}, deadline), saved)
    location = {'lat': home['latitude'], 'lon': home['longitude']}
    vendor = select_vendor(get_json(saved, API, VENDOR, {'areaId': home['area_id'], **location}, deadline))
    cart = project_cart(get_json(saved, API, CART, {
        'branch_id': BRANCH, 'dh_vendor_id': vendor['global_id'], 'global_entity_id': 'TB_AE',
        'chain_id': vendor['chain_id'], **location,
        'campaign_progress_required': 'false', 'has_outstanding_payments': 'false',
    }, deadline, key=key))
    http.remaining_time(deadline)
    return {'ok': True, 'app': 'talabat', 'mode': 'read_only_checkout_readiness',
            'profile_verified': True, 'saved_home_verified': True,
            'payment': {'saved_card_last4': order_card.LAST4, 'unique_match': True,
                        'not_expired': True, 'cvv_required_by_cards_endpoint': False,
                        'selected_for_checkout': False},
            'cart': cart, 'benefits_verified': False, 'quiet_instructions_verified': False,
             'checkout_quote_verified': False, 'cart_mutation_enabled': False,
            'commit_enabled': False, 'cancel_enabled': False,
            'blockers': list(BLOCKERS) + ([] if cart['empty'] else ['CART_NOT_EMPTY']),
            'checked_at': dt.datetime.now(dt.timezone.utc).isoformat()}


def _quest_body(home, vendor):
    """Private in-memory body, matching qph/rph serializers; never print it.

    Branch/chain are strings in the POST model (unlike our GET query inputs).
    increment_weight is nullable: null is the explicit non-weighted probe choice.
    The normal app cart builder requests campaign progress; the clear flow does
    not. has_outstanding_payments=false is this experiment's no-dues context.
    """
    return {'dh_vendor_id': vendor['global_id'], 'branch_id': str(BRANCH),
            'chain_id': str(vendor['chain_id']), 'global_entity_id': 'TB_AE',
            'items': [{'product_id': QUEST, 'quantity': 1, 'increment_weight': None}],
            'lat': float(home['latitude']), 'lon': float(home['longitude']),
            'campaign_progress_required': True, 'has_outstanding_payments': False}


def _json_type(value):
    return {type(None): 'null', bool: 'boolean', int: 'integer', float: 'number',
            str: 'string', list: 'array', dict: 'object'}.get(type(value), 'invalid')


def project_probe_cart(data, previous_id):
    """Allowlisted projection; absent branch echo is unknown, not a mismatch.

    Request scope is established by the calling route/body checks, not by this
    response-only helper. Neither an absent nor matching echo grants cleanup.
    """
    known = ('id', 'branch_id', 'items', 'subtotal_after_discount',
             'cart_update_messages', 'campaign_progress', 'lazy_banners')
    if type(data) is not dict:
        _fail('CART_PROBE_RESPONSE_SCHEMA_CHANGED')
    rows = data.get('items')
    valid_rows = type(rows) is list and len(rows) <= 128 and all(type(x) is dict for x in rows)
    exact = (valid_rows and len(rows) == 1 and rows[0].get('product_id') == QUEST
             and type(rows[0].get('quantity')) is int and rows[0]['quantity'] == 1
             and rows[0].get('increment_weight') in (None, 0)
             and type(rows[0].get('increment_weight')) in (type(None), int, float)
             and type(rows[0].get('free_quantity', 0)) is int
             and rows[0].get('free_quantity', 0) == 0)
    subtotal = data.get('subtotal_after_discount')
    subtotal = subtotal if _number(subtotal, 0, 1_000_000) else None
    branch = data.get('branch_id')
    return {'schema': {key: _json_type(data[key]) for key in known if key in data},
            'unprojected_field_count': len(set(data) - set(known)),
            'cart_id_present': _identifier(data.get('id')),
            'same_cart_id_as_preflight': _identifier(data.get('id')) and data['id'] == previous_id,
            'branch_id_present': 'branch_id' in data,
            'branch_matches': (type(branch) in (str, int) and str(branch) == str(BRANCH)
                               if 'branch_id' in data else None),
            'item_rows': len(rows) if valid_rows else None,
            'sole_quest_quantity_one': bool(exact), 'subtotal_after_discount': subtotal,
            'stock_quantity': (rows[0]['stock'] if valid_rows and len(rows) == 1
                               and type(rows[0].get('stock')) is int
                               and 0 <= rows[0]['stock'] <= 1_000_000 else None),
            'increment_weight_is_null': (rows[0].get('increment_weight') is None
                                        if valid_rows and len(rows) == 1 else None),
            'empty': valid_rows and len(rows) == 0 and subtotal == 0,
            'payable_total': None, 'checkout_binding_verified': False,
            'server_persistence_verified': False, 'app_cart_sync_verified': False}


def _probe_post(saved, key, body, deadline):
    """Exactly one fixed cart POST. No redirect, refresh, retry, quote or order."""
    if (type(body) is not dict or set(body) != {'dh_vendor_id', 'branch_id', 'chain_id',
            'global_entity_id', 'items', 'lat', 'lon', 'campaign_progress_required',
            'has_outstanding_payments'} or body.get('branch_id') != str(BRANCH)
            or type(body.get('chain_id')) is not str or not re.fullmatch(r'[1-9][0-9]*', body['chain_id'])
            or body.get('global_entity_id') != 'TB_AE' or not _identifier(body.get('dh_vendor_id'))
            or not _number(body.get('lat'), 25.06, 25.10) or not 25.06 < body['lat'] < 25.10
            or not _number(body.get('lon'), 55.14, 55.18) or not 55.14 < body['lon'] < 55.18
            or body.get('campaign_progress_required') is not True
            or body.get('has_outstanding_payments') is not False
            or type(body.get('items')) is not list or len(body['items']) != 1
            or type(body['items'][0]) is not dict
            or set(body['items'][0]) != {'product_id', 'quantity', 'increment_weight'}
            or body['items'][0].get('product_id') != QUEST
            or type(body['items'][0].get('quantity')) is not int or body['items'][0]['quantity'] != 1
            or body['items'][0].get('increment_weight') is not None
            or type(key) is not str or not re.fullmatch(r'[A-Za-z0-9_-]{16}', key)):
        _fail('CART_PROBE_BODY_DENIED')
    headers = auth.native_headers(saved)
    for header in ('x-api-key', 'x-customer-id', 'x-platform', 'x-user-flow'):
        headers.pop(header, None)
    headers.update({'authorization': 'Bearer ' + saved['auth']['access_token'],
                    'x-api-key': key, 'x-customer-id': str(saved['expected_profile']['id']),
                    'x-platform': 'android', 'content-type': 'application/json',
                    'x-tpro-deals-enabled': 'true', 'x-weightables-enabled': 'true'})
    request = urllib.request.Request(API + CART, method='POST', headers=headers,
                                     data=json.dumps(body, allow_nan=False).encode('utf-8'))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), http.NoRedirect())
    try:
        with http.read_deadline(deadline) as remaining:
            with opener.open(request, timeout=remaining) as response:
                if response.code not in (200, 201):
                    _fail('CART_PROBE_SUBMISSION_UNKNOWN')
                raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                _fail('CART_PROBE_SUBMISSION_UNKNOWN')
            data = json.loads(raw)
            if type(data) is not dict:
                _fail('CART_PROBE_SUBMISSION_UNKNOWN')
        return data
    except urllib.error.HTTPError as exc:
        exc.close()
        # Even 401 is not a license to renew and repeat this POST.
        _fail('CART_PROBE_SUBMISSION_UNKNOWN')
    except (urllib.error.URLError, HTTPException, OSError, ValueError, TypeError):
        _fail('CART_PROBE_SUBMISSION_UNKNOWN')


def _phone_probe_attestation(checked_at, verified):
    # Parent-supplied observation, not a claim we can inspect/lock the phone here.
    if (verified is not True or type(checked_at) not in (int, float)
            or not math.isfinite(checked_at) or not 0 <= time.time() - checked_at <= 120):
        _fail('FRESH_PARENT_PHONE_EMPTY_HOME_ACCOUNT_OBSERVATION_REQUIRED')


def parent_cart_probe(apk_pool, intent_dir, *, send=False, phone_checked_at=None,
                      phone_empty_home_account_verified=False, timeout=30):
    """Five GETs + body construction by default; one explicit parent-only POST.

    Parent must hold the exclusive phone/cart turn and freshly confirm the
    original app's same account, Home and empty basket. This function cannot
    prove other devices/carts are idle. Treat endpoint as persistent replacement.
    Keep the same intent_dir forever for this experiment. Never delete/re-home
    its marker to retry, including after an HTTP error or interrupted process.
    No cleanup, quote or purchase is implicit. Returns only safe projections.
    """
    if type(send) is not bool:
        _fail('CART_PROBE_SEND_MUST_BE_EXPLICIT_BOOLEAN')
    marker = Path(intent_dir) / PROBE_MARKER
    if send:
        _phone_probe_attestation(phone_checked_at, phone_empty_home_account_verified)
        if marker.exists() or marker.is_symlink():
            _fail('CART_PROBE_INTENT_ALREADY_CONSUMED')
    deadline = auth.new_deadline(timeout)
    key = verticals_key(apk_pool)
    saved = http.account()
    http.verify_profile(http.request(http.PROFILE, saved, deadline), saved)
    select_card(get_json(saved, API, CARDS, {'countryId': 4}, deadline))
    home = select_home(get_json(saved, ADDRESS_API, ADDRESSES, {'countryId': 4}, deadline), saved)
    location = {'lat': home['latitude'], 'lon': home['longitude']}
    vendor = select_vendor(get_json(saved, API, VENDOR, {'areaId': home['area_id'], **location}, deadline))
    cart_query = {
        'branch_id': BRANCH, 'dh_vendor_id': vendor['global_id'], 'global_entity_id': 'TB_AE',
        'chain_id': vendor['chain_id'], **location,
        'campaign_progress_required': 'true', 'has_outstanding_payments': 'false',
    }
    before = get_json(saved, API, CART, cart_query, deadline, key=key, probe_context=True)
    if not project_cart(before)['empty']:
        _fail('CART_PROBE_SERVER_CART_NOT_EMPTY')
    body = _quest_body(home, vendor)
    result = {'ok': True, 'mode': 'parent_cart_probe', 'sent': False,
              'profile_home_card_verified': True, 'server_cart_empty': True,
              'phone_observation_verified_by_module': False,
              'request_schema': {k: _json_type(v) for k, v in body.items()},
              'item_schema': {k: _json_type(v) for k, v in body['items'][0].items()},
              'item_rows': 1, 'quest_quantity': 1,
              'campaign_progress_required': True, 'has_outstanding_payments': False,
              'quote_sent': False, 'commit_enabled': False, 'cleanup_sent': False}
    http.remaining_time(deadline)
    if not send:
        return result
    _phone_probe_attestation(phone_checked_at, phone_empty_home_account_verified)
    # Existing parent scratch directory only: never create another retry scope.
    directory = Path(intent_dir)
    if not directory.is_dir() or directory.is_symlink():
        _fail('CART_PROBE_INTENT_DIRECTORY_REQUIRED')
    fd = None
    try:
        fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        intent = {'version': 1, 'operation': 'quest_cart_post', 'branch_id': BRANCH,
                  'quantity': 1, 'state': 'MAY_HAVE_SENT', 'created_at': int(time.time())}
        with os.fdopen(fd, 'w') as journal:
            fd = None
            journal.write(json.dumps(intent) + '\n')
            journal.flush()
            os.fsync(journal.fileno())
            dirfd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(dirfd)
            finally:
                os.close(dirfd)
            # An expired deadline still leaves the consumed intent in place.
            http.remaining_time(deadline)
            response = _probe_post(saved, key, body, deadline)
            result.update(sent=True, response=project_probe_cart(response, before['id']))
            http.remaining_time(deadline)
            journal.write(json.dumps({'state': 'RESPONSE_RECEIVED', 'receipt': result}) + '\n')
            journal.flush()
            os.fsync(journal.fileno())
            # Read-only comparison while private IDs are still in memory. Failure
            # cannot authorize resend/clear and must not hide the received POST.
            try:
                after = get_json(saved, API, CART, cart_query, deadline, key=key, probe_context=True)
                result['readback'] = project_probe_cart(after, response.get('id'))
                http.remaining_time(deadline)
            except Exception:
                result['readback'] = {'verified': False, 'error': 'CART_READBACK_UNAVAILABLE'}
            journal.write(json.dumps({'state': 'READBACK_ATTEMPTED', 'receipt': result}) + '\n')
            journal.flush()
            os.fsync(journal.fileno())
        return result
    except FileExistsError:
        _fail('CART_PROBE_INTENT_ALREADY_CONSUMED')
    except Exception:
        # Do not echo network/body/filesystem exception text or retry/clear.
        _fail('CART_PROBE_SUBMISSION_UNKNOWN_INTENT_CONSUMED')
    finally:
        if fd is not None:
            os.close(fd)


def prepare_quote(*args, **kwargs):
    _fail('CHECKOUT_QUOTE_DISABLED_UNVERIFIED_CONTRACT')


def replace_cart(*args, **kwargs):
    _fail('CHECKOUT_CART_MUTATION_DISABLED_UNVERIFIED_CONTRACT')


def commit(*args, **kwargs):
    _fail('CHECKOUT_COMMIT_DISABLED')


def cancel_order(*args, **kwargs):
    _fail('CHECKOUT_CANCEL_DISABLED_UNVERIFIED_CONTRACT')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    read = sub.add_parser('readiness', help='bounded GETs only; does not prepare a cart or quote')
    read.add_argument('--apk-pool', required=True, help='original 13.95.0 pp.txt; public constants read in memory')
    read.add_argument('--timeout', type=float, default=30)
    args = parser.parse_args(argv)
    try:
        result = readiness(args.apk_pool, args.timeout)
        print(json.dumps(result))
        return 0
    except http.TalabatError as exc:
        print(json.dumps({'ok': False, 'app': 'talabat', 'error': str(exc), 'commit_enabled': False}))
        return 1
    except Exception:
        print(json.dumps({'ok': False, 'app': 'talabat', 'error': 'CHECKOUT_READ_FAILED', 'commit_enabled': False}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
