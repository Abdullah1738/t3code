"""Best-effort, local orders diagnostics. Only allowlisted metadata reaches disk."""
import contextlib
import contextvars
import datetime as dt
import functools
import hashlib
import inspect
import json
import math
import os
from pathlib import Path
import re
import sys
from time import perf_counter
import tempfile
import urllib.error
import urllib.parse

CAP_BYTES = 50 * 1024 * 1024
_PENDING = contextvars.ContextVar('orders_log_pending', default=None)
_SCOPES = contextvars.ContextVar('orders_log_scopes', default=())
_REQUEST = contextvars.ContextVar('orders_log_request', default=None)
_SEEN = set()
_NAMES = {
    'cmd.start', 'cmd.end', 'cmd.error', 'guard.refused', 'payment.may_have_sent',
    'step.auth', 'step.cart_build', 'step.checkout', 'step.payment_submit',
    'step.bank_approval_wait', 'step.confirmation', 'flow.recover_payment',
    'flow.release', 'flow.abandon', 'track.add', 'track.poll', 'track.transition',
    'track.eta_elapsed', 'track.delivered', 'track.error', 'card.assert',
    'provider.track', 'provider.orders', 'provider.details', 'log.cap',
    'case.open', 'case.update', 'case.close', 'case.reopen', 'case.corroborate',
    'question.ask', 'check.run', 'cache_reset',
}
_ENUMS = {
    'lane': {'food', 'minutes', 'nownow', 'main', 'supermall', 'marketplace', 'careem', 'uber',
             'quik', 'shops', 'box', 'same-day'},
    'merchant': {'noon', 'careem', 'amazon', 'web', 'uber', 'other', 'unknown'},
    'source': {'cli', 'phone', 'email'},
    'outcome': {'success', 'failure', 'refused', 'ask_now', 'dont_ask', 'unverified', 'failed'},
    'kind': {'refund', 'dispute', 'decline', 'unasked_charge', 'charge', 'hold',
             'payment_deadline', 'autopay_expected', 'merchant_card'},
    'starved_by': {'none', 'owner_threads', 'msgs', 'lookups', 'census', 'receipt',
                   'reconcile', 'follow', 'attention', 'build_write', 'merchants', 'order_charges',
                   'payments', 'questions', 'refunds', 'order_screen', 'loads', 'writes', 'locks'},
    'owner_result': {'ok', 'incomplete', 'list_failed'},
    'slowestPhase': {'reconcile', 'follow', 'attention', 'build_write'},
    'state': {'unknown', 'placed', 'ordered', 'shipped', 'preparing', 'picked up', 'out for delivery',
              'nearby', 'delivered', 'cancelled', 'pending confirmation'},
}
_ENUMS['from'] = _ENUMS['to'] = _ENUMS['state']
_BOOLS = {'prepareOnly', 'changed', 'fallback', 'budgetHit', 'unmatched', 'deadlineMoved', 'answered', 'polled'}
_NUMBERS = {'exitCode', 'amountMinor', 'count', 'ageDays', 'openCases', 'fired', 'sourceLimits',
            'msgs_timeouts', 'msgs_p50_ms',
            'merchants_ms', 'order_charges_ms', 'payments_ms', 'questions_ms', 'refunds_ms',
            'order_screen_ms', 'receipt_ms', 'loads_ms', 'writes_ms', 'writes_n', 'locks_ms', 'follow_ms', 'untimed_ms',
            'owner_threads_ms', 'msgs_ms', 'msgs_max_ms', 'lookups_ms', 'census_ms',
            'owner_list_pages', 'owner_list_ms', 'owner_threads_selected', 'owner_threads_fresh',
            'owner_threads_needed', 'owner_threads_fetched', 'owner_fetch_ms_max', 'owner_timeouts', 'owner_cache_size'}
_CASE_FIELDS = {'merchant', 'amount', 'currency', 'reference', 'state', 'next', 'deadline',
                'due', 'why', 'who', 'watchers', 'note', 'because', 'reply', 'source'}
_MONEY_PROPS = {
    'case.open': {'kind', 'unmatched'},
    'case.update': {'fields', 'deadlineMoved', 'answered'},
    'case.close': {'kind', 'ageDays'},
    'question.ask': {'outcome'},
    'check.run': {'budgetHit', 'openCases', 'fired', 'slowestPhase', 'sourceLimits', 'limitKinds', 'orderCoverage', 'chargeCensus',
                  'msgs_timeouts', 'msgs_p50_ms', 'msgs_by_kind', 'receipt_result',
                  'merchants_ms', 'order_charges_ms', 'payments_ms', 'questions_ms', 'refunds_ms',
                  'order_screen_ms', 'receipt_ms', 'loads_ms', 'writes_ms', 'writes_n', 'locks_ms', 'follow_ms', 'untimed_ms',
                  'owner_threads_ms', 'msgs_ms', 'msgs_max_ms', 'lookups_ms', 'census_ms', 'starved_by',
                  'owner_list_pages', 'owner_list_ms', 'owner_threads_selected', 'owner_threads_fresh',
                  'owner_threads_needed', 'owner_threads_fetched', 'owner_fetch_ms_max', 'owner_timeouts', 'owner_cache_size', 'owner_result'},
}
_COMMANDS = {'test-talabat-shops', 'capabilities', 'restaurant-cart-contract', 'item-options', 'cart',
             'clear-cart', 'menu', 'choices', 'inspect', 'open-flows', 'recover-payment',
             'close-food-captured', 'track', 'track-exact', 'order-details', 'order-status',
             'reconcile-order', 'marketplace-cart', 'checkout-check', 'review-contract',
             'auth', 'order', 'await-payment', 'release-flow', 'abandon-flow', 'log-rollup'}
_ENUMS['subcommand'] = _COMMANDS


def log_dir():
    override = os.environ.get('ROBOB_TOOL_LOG_DIR')
    if override:
        return Path(override)
    if 'unittest' in sys.modules or 'pytest' in sys.modules:
        return None
    return Path.home() / '.robob/logs/tools'


def root():
    base = log_dir()
    return base / 'orders' if base is not None else None


_GUARD_TAGS = frozenset("""
SAME_BASKET_PENDING_ACK_REQUIRED NOON_FALLBACK_REQUIRES_RECORDED_9546_DECLINE
ACCOUNT_HOME_CHANGED ACCOUNT_OR_HOME_MISMATCH BINDING_MISMATCH
FOOD_ACCOUNT_HOME_CHANGED FOOD_CART_HOME_OR_OUTLET_CHANGED FOOD_ORDER_HOME_OR_OUTLET_CHANGED
HOME_2104_BINDING_MISMATCH HOME_2104_MISMATCH HOME_CONTEXT_MISMATCH HOME_MISMATCH
HOME_PIN_MISMATCH HOME_READ_STALE HOME_SCHEMA_UNKNOWN HOMEPAGE_SCHEMA_CHANGED INVALID_HOME
MAIN_ACCOUNT_HOME_CHANGED MARKETPLACE_ACCOUNT_HOME_CHANGED MARKETPLACE_CLEAR_ACCOUNT_HOME_CHANGED
MINUTES_ACCOUNT_HOME_CHANGED NOWNOW_ACCOUNT_HOME_CHANGED NOWNOW_CLEAR_ACCOUNT_HOME_CHANGED
ORDER_HOME_STORE_MISMATCH SESSION_HOME_MISMATCH STALE_HOME SUPERMALL_ACCOUNT_HOME_CHANGED
DRIVER_NOTE_INVALID INVALID_DRIVER_NOTES DUPLICATE_PREFERENCE INVALID_PREFERENCES
PREFERENCES_REQUIRED PREFERENCES_SCHEMA_CHANGED SCHEMA_DELIVERY_OPTIONS SCHEMA_DELIVERY_OPTION
INVALID_DELIVERY_OPTION INVALID_DELIVERY_OPTION_CODE INVALID_DELIVERY_OPTION_STATUS
INVALID_DELIVERY_OPTION_ACTION INVALID_DELIVERY_OPTION_TYPE INVALID_DELIVERY_OPTION_MESSAGE
ACTIVE_ORDER_PRESENT ACTIVE_ORDER_SCHEMA_CHANGED ADDRESS ADDRESS_BINDING_MISMATCH
ADDRESS_OWNER_MISMATCH ADDRESS_SCHEMA_CHANGED ASYNC_SAVED_CARD_INSTRUMENT_REQUIRED CARD
CARDS_SCHEMA_CHANGED CARD_ASSERT_FINAL_REFUSED CARD_CANCELLED CARD_CHANGED CARD_FILL_FAILED
CARD_MISMATCH CARD_QUOTE_BODY_DENIED CARD_QUOTE_CONTEXT_UNSUPPORTED
CARD_QUOTE_EXACT_SAVED_CARD_NOT_UNIQUE CARD_QUOTE_INTENT_ALREADY_CONSUMED
CARD_QUOTE_PAYMENT_SCHEMA_CHANGED CARD_RECENTLY_DECLINED CARD_RECORD_REQUIRED CARD_REQUIRED
CARD_SELECTION_REQUIRED CARD_STATUS_FILE CARD_STATUS_UNREADABLE CARD_SYNC_BINDING_MISMATCH
CARD_SYNC_RECEIPT_REQUIRED CARD_SYNC_REQUEST_MISMATCH CARD_SYNC_RESPONSE_MISMATCH CARD_SYNC_STALE
CARD_TOKEN_MISMATCH COMMERCE_CARD_LAST4 DELETED_CARD DURABLE_CARD_SYNC_REQUIRED
EXACT_SAVED_CARD_NOT_UNIQUE EXACT_SAVED_CARD_ROUTE_NOT_UNIQUE FOOD_CARD_INVALID
FOOD_CARD_SELECTION_UNOBSERVED FOOD_CARD_TOKEN_INVALID FOOD_CART_ADDRESS_VERSION_CHANGED
FOOD_DELIVERY_CARD_SEND_UNVERIFIED FOOD_FRESH_CARD_TOKEN_CHANGED FOOD_ORDER_QUIET_CHANGED
FOOD_PAYMENT_CARD_MISMATCH FOOD_PREPARED_CARD_BINDING_MISSING FOOD_QUIET_CODES_UNAVAILABLE
FOOD_QUIET_NOT_VERIFIED FOOD_SELECTED_CARD_NOT_UNIQUE FOOD_SELECTED_CARD_REQUIRED
FRESH_EXACT_AMOUNT_CARD_QUOTE_REQUIRED HOME_ADDRESS_UNVERIFIED INITIAL_QUOTE_ADDRESS_INVALID
INVALID_ADDRESS_CODE INVALID_ADDRESS_VERSION INVALID_CARD INVALID_CARD_TOKEN INVALID_SAVED_CARD
MAIN_ACTIVE_ORDER_PRESENT MAIN_ADDRESS_BINDING_MISMATCH MAIN_DEFAULT_CARD_MISSING
MAIN_DEFAULT_CARD_NOT_ACTIVE MAIN_DEFAULT_CARD_NOT_SELECTED MAIN_SILENT_DELIVERY_NOT_ACTIVE
MARKETPLACE_ACTIVE_ORDER_PRESENT MARKETPLACE_SAVED_CARD_MISMATCH MINUTES_ACTIVE_ORDER_PRESENT
MONI_GO_CHAT_INVALID MONI_GO_NOT_FOUND MONI_GO_REQUIRED MONI_GO_UNVERIFIABLE
NOWNOW_9546_PAID_CONTRACT_UNPROVEN NOWNOW_ACTIVE_ORDER_PRESENT NOWNOW_ADDRESS_BINDING_MISMATCH
NOWNOW_CARD_REQUIRED NOWNOW_CLEAR_ACTIVE_ORDER NOWNOW_DURABLE_CARD_SELECTION_MISMATCH
NOWNOW_QUIET_NOTE_MISMATCH NOWNOW_QUIET_PREFERENCE_DISABLED NOWNOW_QUIET_PREFERENCE_NOT_ACTIVE
NOWNOW_QUIET_PREFERENCE_SCHEMA_UNSUPPORTED NOWNOW_QUIET_PREFERENCE_UNSUPPORTED
NOWNOW_SAVED_CARD_NOT_UNIQUE NO_SUPPORTED_ORDER_CARDS ORDERING_PAUSED ORDER_ADDRESS_UNVERIFIED
ORDER_CARD_CONFIG_INVALID ORDER_QUIET_MISMATCH OWNED_SESSION_CARD_REQUIRED OWNER_GO OWNER_GO_INVALID
OWNER_GO_REQUIRED PAYMENT_ENUM_AND_CARD_TOKEN_MAPPING_UNVERIFIED PAYMENT_METHOD_OR_CARD_INVALID
PAYMENT_ROUTE_SAVED_CARD_MISMATCH PLACE_DRAFT_CARD_ID_INVALID PREORDER_CHALLENGE_CARD_INVALID QUIET
QUIET_CODES_UNSUPPORTED QUIET_CONTROLS_READBACK_MISMATCH QUIET_CONTROLS_UNAVAILABLE
QUIET_CONTROLS_UNKNOWN QUIET_CONTROLS_UNSUPPORTED QUIET_CONTROL_IDS_CHANGED QUIET_DELIVERY_MISMATCH
QUIET_EVIDENCE_REQUIRED QUIET_INSTRUCTIONS_UNREPRESENTABLE QUIET_INSTRUCTION_BINDINGS_REQUIRED
QUIET_INSTRUCTION_IDS_AND_READBACK_UNVERIFIED QUIET_INSTRUCTION_READBACK_MISMATCH
QUIET_NOTES_MISMATCH QUIET_NOTE_MISMATCH QUIET_NOTE_READBACK_MISMATCH QUIET_NOTE_SUPPORT_UNKNOWN
QUIET_PREFERENCE_MISMATCH QUIET_SELECTED_QUOTE_REQUIRED QUIET_SOURCE_QUOTE_MISMATCH
QUIET_TOGGLE_NOT_VERIFIED SAVED_ADDRESS_SCHEMA_CHANGED SAVED_CARDS_SCHEMA_CHANGED SAVED_CARD_EXPIRED
SAVED_CARD_EXPIRY_INVALID SAVED_CARD_LAST4_MISMATCH SAVED_CARD_MASK_MISMATCH
SAVED_CARD_MATERIAL_MISSING SAVED_CARD_METHOD_MISMATCH SAVED_CARD_MISMATCH
SAVED_CARD_NOT_READY_OR_CVV_REQUIRED SAVED_CARD_NOT_UNIQUE SAVED_CARD_REQUIRED
SAVED_CARD_SELECTION_REQUIRED SAVED_CARD_TITLE_MISMATCH SAVED_CARD_TOKEN_MISMATCH
SAVED_CARD_TYPE_MISMATCH SCHEMA_ADDRESSES SCHEMA_CARD_ID SCHEMA_CARD_IS_SELECTED SCHEMA_CARD_MASK
SCHEMA_CARD_SECTIONS SCHEMA_CARD_SESSION SCHEMA_CARD_TYPE SCHEMA_METHOD_CARDS SCHEMA_SECTION_CARDS
SELECTED_CARD_AMBIGUOUS_OR_MISSING SELECTED_CARD_ID_MISMATCH SELECTED_CARD_QUOTE_REQUIRED
SELECTED_CART_SESSION_CARD_REQUIRED SESSION_ADDRESS_MATCH_REQUIRED STALE_CARD
SUPERMALL_ACTIVE_ORDER_PRESENT SUPERMALL_ADDRESS_BINDING_MISMATCH SUPERMALL_DEFAULT_CARD_MISSING
SUPERMALL_DEFAULT_CARD_NOT_ACTIVE SUPERMALL_DEFAULT_CARD_NOT_SELECTED
SUPERMALL_SILENT_DELIVERY_NOT_ACTIVE TALABAT_ADDRESS_CHECK_FAILED TALABAT_RETIRED
UNSUPPORTED_NATIVE_MARKETPLACE_QUIET_DELIVERY UNSUPPORTED_QUIET_OPTION_SEMANTICS
""".split())

_KNOWN_TAGS = _GUARD_TAGS | frozenset("""
OPERATION_FAILED LOG_CAP TRACK_REGISTRATION_FAILED TRACK_POLL_SOURCE_ERROR
AUTH_EXPIRED AUTH_FORBIDDEN ACCOUNT_CAPTURE_REQUIRED INVALID_ORDER_ID INVALID_ARGUMENTS
DIA_BRIDGE_UNAVAILABLE DIA_INVALID_RESPONSE DIA_TRANSPORT_FAILED FAILED SOURCE_ERRORS
PAYMENT_WAIT_TIMEOUT PAYMENT_WAIT_UNCONFIRMED
DEADLINE_REASON_REQUIRED CHARGE_DUPLICATE_CANDIDATE CORROBORATE_MISMATCH
""".split())


def tag(value):
    code = getattr(value, 'code', value)
    return code if type(code) is str and code in _KNOWN_TAGS else 'OPERATION_FAILED'


def guard_refused(code):
    if type(code) is str and code in _GUARD_TAGS:
        emit('commerce', 'guard.refused', kind='error', ok=False, error=code)


# Only protocol vocabulary survives. Regex-only filtering would accept a token,
# address or card number that happens to look like a code or URL segment.
_ENDPOINTS = frozenset('''/_vs/st/st-whoami-api/whoami
/_svc/instant/order/list /_svc/instant/order/track /_svc/instant/order/get
/_svc/order-v2/orders/active /_svc/order-v2/orders/history
/_svc/mp-food-api-mpnoon/order/details /_svc/mp-food-api-mpnoon/order/orders
/_svc/mp-shop-api-mpnoon/v1/order/details /_svc/mp-shop-api-mpnoon/v1/order/history
/userinfo /token /identity/client/otp /identity/client/otp/verification'''.split())
_DYNAMIC_ENDPOINTS = (
    (r'/_svc/order-v2/order/[^/]+', '/_svc/order-v2/order/:id'),
    (r'/_svc/mp-food-api-mpnoon/order/tracking/[^/]+/info', '/_svc/mp-food-api-mpnoon/order/tracking/:id/info'),
    (r'/_svc/mp-shop-api-mpnoon/v1/order/tracking/[^/]+', '/_svc/mp-shop-api-mpnoon/v1/order/tracking/:id'),
    (r'/v1/activity-tracker/food/[^/]+', '/v1/activity-tracker/food/:id'),
)
_CODE_WORDS = frozenset('''AUTH AUTHENTICATION AUTHORIZATION UNAUTHORIZED FORBIDDEN
ACCESS TOKEN EXPIRED INVALID MISSING REQUIRED DENIED HTTP INTERNAL SERVER ERROR
SERVICE UNAVAILABLE BAD GATEWAY REQUEST TIMEOUT TIMED OUT RATE LIMIT LIMITED
TOO MANY REQUESTS NOT FOUND ORDER ACCOUNT SESSION RESPONSE SCHEMA CHANGED
FAILED FAILURE READ CONNECTION CONNECT RESET REFUSED ABORTED NETWORK
APPLICATION REJECTED SUCCESS FALSE DEADLINE EXCEEDED SEARCH MESSAGE MAILSEARCH
UNVERIFIED UNRECOGNIZED UNEXPECTED JSON PARSE UNAVAILABLE OR OVERALL AMAZON
EMAIL INVALID_ARGUMENTS DIA TRANSPORT BRIDGE'''.split())
_EXCEPTIONS = frozenset('''Exception RuntimeError ValueError TypeError KeyError
OSError TimeoutError ConnectionError ConnectionResetError ConnectionRefusedError
HTTPError URLError HTTPException RemoteDisconnected JSONDecodeError
TimeoutExpired NoonError MinutesError CareemError AccountError BrowserOrdersError
OrderError'''.split())
_SCHEMA_REASONS = frozenset('''SCHEMA_CHANGED RESPONSE_SCHEMA_CHANGED
ORDER_MISMATCH_OR_SCHEMA_CHANGED ORDER_ITEM_SCHEMA_CHANGED ORDER_MISMATCH
ORDER_IDENTITY_UNVERIFIED INCOMPLETE_MANIFEST DUPLICATE_JSON_KEY'''.split())
_AMAZON_PHASES = {
    'session_open': '/amazon/session/open',
    'order_list': '/amazon/mail/search',
    'order_detail': '/amazon/mail/read',
    'parse': '/amazon/mail/parse',
}
_ENDPOINTS |= frozenset(_AMAZON_PHASES.values())


def _phase_cause(cause, phase, elapsed_ms):
    if (type(phase) is str and phase in _AMAZON_PHASES
            and type(elapsed_ms) in (int, float) and math.isfinite(elapsed_ms)
            and 0 <= elapsed_ms <= 10**12):
        cause.update(phase=phase, phaseElapsedMs=round(elapsed_ms, 3))
    return cause


def _endpoint(value):
    if type(value) is not str:
        return None
    try:
        path = urllib.parse.urlsplit(value).path
    except ValueError:
        return '/:redacted'
    if path in _ENDPOINTS:
        return path
    return next((template for pattern, template in _DYNAMIC_ENDPOINTS
                 if re.fullmatch(pattern, path)), '/:redacted') if path else None


def _upstream_code(value):
    if type(value) is str and len(value) <= 80 and re.fullmatch(r'[A-Za-z_ -]+', value):
        words = re.split(r'[_ -]+', value.upper())
        if all(word in _CODE_WORDS for word in words):
            return value
    return None


def _body_code(data):
    if not isinstance(data, dict):
        return None
    error = data.get('error')
    errors = data.get('errors')
    first = errors[0] if isinstance(errors, list) and errors else None
    candidates = [data.get('code'), data.get('errorCode'), data.get('error_code'),
                  first.get('code') if isinstance(first, dict) else first,
                  error.get('code') if isinstance(error, dict) else error]
    return next((code for value in candidates if (code := _upstream_code(value))), None)


def _cause(exc=None, *, endpoint=None, status=None, attempt=None, upstream_code=None):
    status = status if type(status) is int and 100 <= status <= 599 else None
    chain, seen = [], set()
    while isinstance(exc, BaseException) and id(exc) not in seen and len(chain) < 8:
        chain.append(exc)
        seen.add(id(exc))
        reason = exc.reason if isinstance(exc, urllib.error.URLError) else None
        exc = exc.__cause__ or exc.__context__ or (reason if isinstance(reason, BaseException) else None)
    for item in reversed(chain):
        value = getattr(item, 'code', None)
        if status is None and type(value) is int and 100 <= value <= 599:
            status = value
    timeout = any(isinstance(item, TimeoutError) or type(item).__name__ == 'TimeoutExpired'
                  or (item.args and type(item.args[0]) is str and item.args[0] in {
                      'NATIVE_READ_TIMEOUT', 'REQUEST_TIMEOUT', 'HTTP_TIMEOUT', 'DIA_TIMEOUT'}) for item in chain)
    retryable = timeout or status in {408, 425, 429} or (status is not None and 500 <= status <= 599)
    cls = type(chain[-1]).__name__ if chain else None
    cause = {'httpStatus': status if type(status) is int and 100 <= status <= 599 else None,
            'endpoint': _endpoint(endpoint),
            'attempt': attempt if type(attempt) is int and 1 <= attempt <= 10000 else None,
            'retryable': bool(retryable), 'upstreamCode': _upstream_code(upstream_code),
            'exceptionClass': cls if cls in _EXCEPTIONS else 'Exception' if cls else None}
    for item in chain:
        reason = item.args[0] if item.args else None
        if type(reason) is str and reason in _SCHEMA_REASONS:
            cause['reason'] = reason
            break
    return cause


def _record_failure(scope, *, exc=None, result=None):
    observed = scope.get('failure') or scope.get('last') or {}
    cause = _cause(exc, endpoint=observed.get('endpoint'), status=observed.get('httpStatus'),
                   attempt=observed.get('attempt'),
                   upstream_code=observed.get('upstreamCode') or (
                       _body_code(result) if 'failure' not in scope else None))
    cause['exceptionClass'] = observed.get('exceptionClass') or cause['exceptionClass']
    cause['retryable'] |= observed.get('retryable') is True
    _phase_cause(cause, observed.get('phase'), observed.get('phaseElapsedMs'))
    if 'reason' not in cause and observed.get('reason'):
        cause['reason'] = observed['reason']
    # Tracker rows are emitted after provider wrappers return or their errors
    # are caught, so both failure forms must reach the enclosing scopes.
    for active in _SCOPES.get():
        active['failure'] = cause


def error_recorder():
    scopes = _SCOPES.get()
    def record(exc):
        cause = _cause(exc, attempt=1)
        for scope in scopes:
            scope['failure'] = cause
    return record


def operation_recorder():
    # Capture before mail workers start; their ContextVars do not inherit ours.
    scopes = _SCOPES.get()
    @contextlib.contextmanager
    def operation(name):
        start = perf_counter()
        end = None
        def failed(exc=None, *, upstream_code=None, phase=None, elapsed_ms=None):
            # The mail helper may identify a session timeout inside the search.
            safe_phase = _phase_cause({}, phase, elapsed_ms)
            observed = safe_phase.get('phase', name)
            elapsed = safe_phase.get('phaseElapsedMs',
                                     ((end if end is not None else perf_counter()) - start) * 1000)
            cause = _phase_cause(_cause(exc, endpoint=_AMAZON_PHASES.get(observed),
                                       attempt=1, upstream_code=upstream_code),
                                 observed, elapsed)
            for scope in scopes:
                scope['failure'] = cause
        try:
            yield failed
        except Exception as exc:
            failed(exc)
            raise
        finally:
            end = perf_counter()
    return operation


def poll_observation(props):
    if _SCOPES.get():
        _SCOPES.get()[-1]['props'].update(_fields(props))


def _error(code, cause):
    reason = cause.get('reason')
    reason = reason if type(reason) is str and reason in _SCHEMA_REASONS else None
    safe = _cause(endpoint=cause.get('endpoint'), status=cause.get('httpStatus'),
                  attempt=cause.get('attempt'), upstream_code=cause.get('upstreamCode'))
    safe['exceptionClass'] = cause.get('exceptionClass') if cause.get('exceptionClass') in _EXCEPTIONS else None
    safe['retryable'] = cause.get('retryable') is True
    _phase_cause(safe, cause.get('phase'), cause.get('phaseElapsedMs'))
    cause = safe
    message = code
    if cause['httpStatus'] is not None:
        message = 'HTTP ' + str(cause['httpStatus'])
        if reason or cause['upstreamCode']:
            message += ': ' + (reason or cause['upstreamCode'])
    elif reason or cause['upstreamCode']:
        message = reason or cause['upstreamCode']
    elif cause['retryable'] and cause['exceptionClass']:
        # Without an HTTP status, only a recognized timeout is retryable.
        message = 'Upstream request timed out'
    return {'tag': code, 'message': message[:200], 'cause': cause}


@contextlib.contextmanager
def request(endpoint, attempt=1):
    """Observe an existing request; never read an error body or retry it."""
    observation = {'endpoint': endpoint, 'status': None, 'attempt': attempt, 'upstream_code': None}
    token = _REQUEST.set(observation)
    try:
        yield
    except Exception as exc:
        cause = _cause(exc, **observation)
        for scope in _SCOPES.get():
            scope['failure'] = cause
        raise
    finally:
        cause = _cause(**observation)
        for scope in _SCOPES.get():
            scope['last'] = cause
            if cause['httpStatus'] is not None and cause['httpStatus'] >= 400:
                scope.setdefault('failure', cause)
        _REQUEST.reset(token)


def response(status, data):
    observation = _REQUEST.get()
    if observation is not None:
        observation['status'] = status if type(status) is int else None
        observation['upstream_code'] = _body_code(data)


def phase_recorder():
    # Capture scopes before launching mail workers: ContextVars do not cross
    # ThreadPoolExecutor boundaries. Only completed intervals enter the log.
    scopes = _SCOPES.get()
    @contextlib.contextmanager
    def measure(name):
        start = perf_counter()
        try:
            yield
        finally:
            end = perf_counter()
            for scope in scopes:
                scope['intervals'].append((start, end, name))
    return measure


def phase(name):
    return phase_recorder()(name)


def _phases(scope, start, end):
    boundaries = [(start, 0, 'other'), (end, 0, 'other')]
    for a, b, name in scope['intervals']:
        if name in {'fetch', 'parse'}:
            boundaries.extend([(max(start, a), 1, name), (min(end, b), -1, name)])
    active, totals, previous = {'fetch': 0, 'parse': 0}, {'fetch': 0, 'parse': 0, 'other': 0}, start
    # Concurrent mail reads overlap: count wall time once, giving fetch priority
    # over parsing while another worker is still waiting for I/O.
    for at, delta, name in sorted(boundaries):
        category = 'fetch' if active['fetch'] else 'parse' if active['parse'] else 'other'
        totals[category] += max(0, at - previous) * 1000
        if name in active:
            active[name] += delta
        previous = at
    return {name + 'Ms': round(value, 3) for name, value in totals.items()}


def _fields(props):
    result = {}
    for key, value in (props or {}).items():
        if key in _ENUMS and type(value) is str and value in _ENUMS[key]:
            result[key] = value
        elif key in _BOOLS and type(value) is bool:
            result[key] = value
        elif key in _NUMBERS and type(value) is int and abs(value) <= 10**12 \
                and (not (key.endswith('_ms') or key == 'writes_n' or key.startswith('owner_')) or value >= 0):
            result[key] = value
        elif key == 'limitKinds' and isinstance(value, list):
            result[key] = sorted({v for v in value if isinstance(v, str) and v in {
                'ORDER_LIST_HOST_BINDING_UNVERIFIED', 'food_page_1', 'nownow_page_1', 'marketplace_page_1'}})
        elif key == 'receipt_result' and isinstance(value, dict):
            result[key] = {k: v for k, v in value.items() if k in {'found', 'none', 'out_of_time', 'error'}
                           and type(v) is int and 0 <= v <= 10**9}
        elif key == 'msgs_by_kind' and isinstance(value, dict):
            result[key] = {kind: {k: v for k, v in bucket.items() if k in {'count', 'ms'}
                                  and type(v) is int and 0 <= v <= 10**9}
                           for kind, bucket in value.items() if kind in {'receipt', 'order', 'other'}
                           and isinstance(bucket, dict)}
        elif key == 'chargeCensus' and isinstance(value, dict):
            result[key] = {app: {k: v for k, v in counts.items()
                if k in {'open', 'matched', 'proven_clean', 'limited', 'error', 'not_checked'}
                and type(v) is int and 0 <= v <= 10**9}
                for app, counts in value.items() if app in {'noon', 'careem'} and isinstance(counts, dict)}
        elif key == 'orderCoverage' and isinstance(value, dict):
            result[key] = {}
            for app in ('noon', 'careem'):
                lanes = value.get(app)
                if not isinstance(lanes, dict):
                    continue
                result[key][app] = {}
                for name in ('minutes', 'marketplace', 'food', 'nownow'):
                    lane = lanes.get(name)
                    if not isinstance(lane, dict):
                        continue
                    safe = {k: v for k, v in lane.items() if k in {'pages', 'fetched', 'cached', 'ms', 'coverage_cleared_rows'}
                            and type(v) is int and 0 <= v <= 10**9}
                    if type(lane.get('stop_reason')) is str and lane['stop_reason'] in {'slice_out', 'detail_error', 'unknown_time_row',
                            'scoped_cancellation', 'scoped_conflict', 'unordered', 'repeated_page', 'invalid_detail',
                            'invalid_paging', 'end_of_history', 'covered', 'unproven_paging', 'list_error', 'reader_error'}:
                        safe['stop_reason'] = lane['stop_reason']
                    covered = lane.get('covered_from')
                    if covered is None or (isinstance(covered, str) and re.fullmatch(
                            r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})', covered)):
                        safe['covered_from'] = covered
                    safe['exhaustive'] = lane.get('exhaustive') is True
                    safe['limit'] = 'page-1 history only' if lane.get('limit') == 'page-1 history only' else None
                    result[key][app][name] = safe
        elif key == 'fields' and type(value) is str and (value == '' or all(
                field in _CASE_FIELDS for field in value.split(','))):
            result[key] = value
        elif key == 'last4' and type(value) is str and re.fullmatch(r'[0-9]{4}', value):
            result[key] = value
        elif key == 'phases' and isinstance(value, dict):
            result[key] = {k: round(v, 3) for k, v in value.items()
                           if k in {'fetchMs', 'parseMs', 'otherMs'} and type(v) in (int, float)
                           and math.isfinite(v) and 0 <= v <= 10**12}
        elif key in {'consecutive_failures', 'poll_interval_s'} and type(value) is int and 0 <= value <= 10**12:
            result[key] = value
        elif key == 'last_success_at' and (value is None or (type(value) is str and re.fullmatch(
                r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})', value))):
            result[key] = value
    return result


def _ids(values):
    # Hash even syntactically valid IDs: input IDs can themselves contain a PAN/OTP.
    return {key: hashlib.sha256(str(value).encode()).hexdigest()[:16]
            for key, value in (values or {}).items()
            if key in {'flowId', 'orderId', 'caseId'} and type(value) in (str, int) and value != ''}


def _noon_lane(order):
    if type(order) is str:
        return next((value for prefix, value in (
            ('NN', 'nownow'), ('F', 'food'), ('N', 'marketplace'), ('I', 'minutes'))
            if order.startswith(prefix)), None)
    return None


def emit(component, name, *, kind='event', duration_ms=None, ok=None, ids=None, props=None, error=None, cause=None):
    try:
        if component not in {'commerce', 'order-watch', 'card_status', 'noon', 'careem', 'amazon', 'uber', 'toollog', 'money-cases'}:
            return
        if kind not in {'event', 'perf', 'error'} or name not in _NAMES:
            return
        if component == 'money-cases':
            props = {key: value for key, value in (props or {}).items()
                     if key in _MONEY_PROPS.get(name, set())}
            ids = {key: value for key, value in (ids or {}).items() if key == 'caseId'}
        now = dt.datetime.now(dt.timezone.utc)
        row = {'ts': now.isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
               'tool': 'orders', 'component': component, 'kind': kind, 'name': name}
        if type(duration_ms) in (int, float) and math.isfinite(duration_ms):
            row['durationMs'] = round(max(0, duration_ms), 3)
        if type(ok) is bool:
            row['ok'] = ok
        safe_ids = _ids(ids)
        if safe_ids:
            row['ids'] = safe_ids
        context = _SCOPES.get()[-1] if _SCOPES.get() else {}
        if name.startswith(('provider.', 'track.')):
            props = {**context.get('props', {}), **(props or {})}
            merchant = props.get('merchant', component)
            props['merchant'] = merchant if merchant in _ENUMS['merchant'] else 'unknown'
            if props['merchant'] == 'noon' and not props.get('lane'):
                props['lane'] = _noon_lane((ids or {}).get('orderId'))
        if props:
            row['props'] = _fields(props)
        if error is not None:
            code = tag(error)
            detail = cause or context.get('failure') or context.get('last') or _cause(error)
            row['error'] = _error(code, detail)
        pending = _PENDING.get()
        if pending is not None:
            pending.append(row)
        else:
            _write(row)
    except Exception:
        pass


def _private_directory(folder):
    missing = []
    path = folder
    while not path.exists():
        missing.append(path)
        path = path.parent
    for path in reversed(missing):
        path.mkdir(mode=0o700, exist_ok=True)
    private = ([folder] if os.environ.get('ROBOB_TOOL_LOG_DIR') else
               [folder.parent.parent, folder.parent, folder])
    for path in private:
        path.chmod(0o700)


def _write(row):
    try:
        folder = root()
        if folder is None:
            return
        _private_directory(folder)
        day = row['ts'][:10]
        seen = (str(folder), day)
        if seen not in _SEEN:
            cutoff = dt.date.fromisoformat(day) - dt.timedelta(days=30)
            for path in folder.iterdir():
                match = re.fullmatch(r'(?:rollup-)?(\d{4}-\d{2}-\d{2})\.(?:ndjson|json|cap)', path.name)
                if match and dt.date.fromisoformat(match[1]) < cutoff:
                    path.unlink()
            _SEEN.add(seen)
        path = folder / (day + '.ndjson')
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        try:
            os.fchmod(fd, 0o600)
            if os.fstat(fd).st_size >= CAP_BYTES:
                # O_EXCL makes the single cap marker durable across CLI invocations.
                marker = folder / ('rollup-' + day + '.cap')
                try:
                    claim = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                except FileExistsError:
                    claim = None
                if claim is not None:
                    os.close(claim)
                    cap = {'ts': row['ts'], 'tool': 'orders', 'component': 'toollog',
                           'kind': 'error', 'name': 'log.cap', 'ok': False,
                           'error': _error('LOG_CAP', _cause())}
                    os.write(fd, (json.dumps(cap, separators=(',', ':')) + '\n').encode())
                if row['kind'] != 'error':
                    return
            os.write(fd, (json.dumps(row, separators=(',', ':')) + '\n').encode())
        finally:
            os.close(fd)
    except Exception:
        pass


@contextlib.contextmanager
def deferred():
    """Buffer in memory until the outer operation has released its own locks."""
    if _PENDING.get() is not None:
        yield
        return
    rows = []
    token = _PENDING.set(rows)
    try:
        yield
    finally:
        _PENDING.reset(token)
        for row in rows:
            _write(row)


@contextlib.contextmanager
def _scope(scope):
    token = _SCOPES.set((*_SCOPES.get(), scope))
    try:
        yield
    finally:
        _SCOPES.reset(token)


def timed(component, name, *, lane=None):
    def decorate(fn):
        signature = inspect.signature(fn)
        @functools.wraps(fn)
        def wrapped(*args, **kwargs):
            obj = args[0] if args else None
            try:
                binding = signature.bind_partial(*args, **kwargs)
                binding.apply_defaults()
                bound = binding.arguments
            except TypeError:
                bound = kwargs
            cfg = obj if isinstance(obj, dict) else {}
            props = {'merchant': component if component in _ENUMS['merchant'] else cfg.get('app', 'unknown'),
                     'lane': lane or bound.get('service') or bound.get('vertical') or cfg.get('vertical')
                             or getattr(obj, 'service', None)}
            if props['merchant'] == 'noon' and not props['lane']:
                props['lane'] = _noon_lane(cfg.get('order') or bound.get('order'))
            scope = {'props': props, 'intervals': []}
            with deferred(), _scope(scope):
                start = perf_counter()
                ok, code = False, None
                try:
                    result = fn(*args, **kwargs)
                    ok = not (isinstance(result, dict) and (result.get('ok') is False or bool(result.get('errors'))))
                    if not ok:
                        code = tag(result.get('error'))
                        _record_failure(scope, result=result)
                    if name == 'step.bank_approval_wait' and isinstance(result, dict) and (
                            result.get('paid') is False or result.get('verification_confirmed') is False
                            or result.get('timed_out') is True):
                        ok = False
                        code = 'PAYMENT_WAIT_TIMEOUT' if result.get('timed_out') is True else 'PAYMENT_WAIT_UNCONFIRMED'
                    return result
                except Exception as exc:
                    code = tag(getattr(exc, 'code', str(exc)))
                    _record_failure(scope, exc=exc)
                    raise
                finally:
                    try:
                        end = perf_counter()
                        if name == 'track.poll' and (props['merchant'] == 'amazon' or end - start > 2):
                            props['phases'] = _phases(scope, start, end)
                        emit(component, name, kind='perf' if ok else 'error', ok=ok,
                             duration_ms=(end - start) * 1000,
                             ids=({'orderId': kwargs.get('expected_order_id') or kwargs.get('order_id') or kwargs.get('order') or (obj if name in {'provider.track', 'provider.details'} and type(obj) is str else None)} if name.startswith('provider.') else
                                  {'orderId': obj.get('order')} if isinstance(obj, dict) else
                                  {'flowId': kwargs.get('flow_id') or getattr(obj, 'flow_id', obj if type(obj) is str else '')}),
                             props={**props, **(result.get('logProps', {}) if name == 'track.poll' and 'result' in locals() and isinstance(result, dict) else {})}, error=code)
                        guard_refused(code)
                    except Exception:
                        pass
        return wrapped
    return decorate


def rollup(day=None):
    try:
        day = day or dt.datetime.now(dt.timezone.utc).date().isoformat()
        if dt.date.fromisoformat(day).isoformat() != day:
            return None
        folder = root()
        if folder is None:
            return None
        counts, kinds, durations, errors, polls = {}, {}, {}, {}, {}
        component_totals, component_errors, component_samples, component_durations = {}, {}, {}, {}
        order_failures, poll_counts = {}, {}
        total = oks = failures = error_lines = invalid = source_bytes = 0
        path = folder / (day + '.ndjson')
        if path.exists():
            with path.open() as source:
                for line_number, line in enumerate(source, 1):
                    source_bytes += len(line.encode('utf-8'))
                    try:
                        row = json.loads(line)
                        name, kind = row['name'], row['kind']
                        if not isinstance(name, str) or name not in _NAMES or kind not in {'event', 'perf', 'error'}:
                            raise ValueError()
                    except (ValueError, KeyError, TypeError):
                        invalid += 1
                        continue
                    total += 1
                    counts[name] = counts.get(name, 0) + 1
                    kinds[kind] = kinds.get(kind, 0) + 1
                    oks += row.get('ok') is True
                    failures += row.get('ok') is False
                    error_lines += kind == 'error'
                    component = row.get('component')
                    if not isinstance(component, str) or component not in {
                            'commerce', 'order-watch', 'card_status', 'noon', 'careem',
                            'amazon', 'uber', 'toollog', 'money-cases'}:
                        component = 'unknown'
                    component_totals[component] = component_totals.get(component, 0) + 1
                    component_errors.setdefault(component, {})
                    component_samples.setdefault(component, {})
                    value = row.get('durationMs')
                    merchant = _fields(row.get('props')).get('merchant', 'unknown')
                    # Count the poll outcome once, not its provider and track.error rows.
                    if (component == 'order-watch' and name == 'track.poll' and type(row.get('ok')) is bool
                            and (row.get('props') or {}).get('polled') is not False):
                        poll_merchant = merchant if merchant in {'noon', 'careem', 'amazon', 'uber', 'other'} else 'unknown'
                        poll = poll_counts.setdefault(poll_merchant, {'count': 0, 'failed': 0})
                        poll['count'] += 1
                        poll['failed'] += row['ok'] is False
                    identity = row.get('ids')
                    order_id = identity.get('orderId') if isinstance(identity, dict) else None
                    if (kind == 'error' and name in {'track.poll', 'provider.track', 'provider.details'}
                            and (row.get('props') or {}).get('polled') is not False
                            and type(order_id) is str and re.fullmatch(r'[a-f0-9]{16}', order_id)):
                        orders = order_failures.setdefault(component, {})
                        orders[order_id] = orders.get(order_id, 0) + 1
                    if type(value) in (float, int) and math.isfinite(value):
                        durations.setdefault(name, []).append(value)
                        if name == 'track.poll':
                            polls.setdefault(merchant, []).append(value)
                        if value >= 0:
                            component_durations.setdefault(f'{component}:{name}', []).append(value)
                    if kind == 'error':
                        code = tag(row.get('error', {}).get('tag'))
                        by_tag = component_errors[component]
                        by_tag[code] = by_tag.get(code, 0) + 1
                        component_samples[component].setdefault(code, {
                            'file': day + '.ndjson', 'line': line_number})
                        status = (row.get('error', {}).get('cause') or {}).get('httpStatus')
                        status = status if type(status) is int and 100 <= status <= 599 else None
                        item = errors.setdefault((code, status, merchant),
                            {'tag': code, 'httpStatus': status, 'merchant': merchant, 'count': 0, 'sampleId': None})
                        item['count'] += 1
                        # Only IDs from our hashed representation can enter a rollup.
                        for value in (row.get('ids') or {}).values():
                            if type(value) is str and re.fullmatch(r'[a-f0-9]{16}', value):
                                item['sampleId'] = item['sampleId'] or value
                                break
        latency = {}
        for name, values in durations.items():
            values.sort()
            latency[name] = {'p50': values[max(0, math.ceil(len(values) * .5) - 1)],
                             'p95': values[max(0, math.ceil(len(values) * .95) - 1)], 'max': values[-1]}
        if polls:
            latency['track.poll']['byMerchant'] = {}
            for merchant, values in sorted(polls.items()):
                values.sort()
                latency['track.poll']['byMerchant'][merchant] = {
                    'count': len(values), 'p50': values[math.ceil(len(values) * .5) - 1],
                    'p95': values[math.ceil(len(values) * .95) - 1], 'max': values[-1]}
        result = {'schemaVersion': 2, 'day': day, 'tool': 'orders', 'total': total, 'countsByName': counts,
                  'countsByKind': kinds, 'okRate': oks / (oks + failures) if oks + failures else None,
                  'errorRate': error_lines / total if total else 0, 'durationsMs': latency,
                  'topErrors': sorted(errors.values(), key=lambda x: (-x['count'], x['tag'], x['httpStatus'] or 0, x['merchant']))[:20],
                  'invalidLines': invalid, 'sourceBytes': source_bytes}
        for key, values in sorted(component_durations.items()):
            values.sort()
            latency[key] = {'p50': values[math.ceil(len(values) * .5) - 1],
                            'p95': values[math.ceil(len(values) * .95) - 1],
                            'max': values[-1], 'count': len(values)}
        result['errorsByComponent'] = {
            component: dict(sorted(component_errors[component].items()))
            for component in sorted(component_totals)}
        result['failureShare'] = {
            component: sum(component_errors[component].values()) / component_totals[component]
            for component in sorted(component_totals)}
        # Match topErrors' frequency ranking, using references rather than raw IDs.
        result['topErrorSamplesByComponent'] = {
            component: [{'tag': code, 'count': count,
                         'sampleId': component_samples[component][code]}
                        for code, count in sorted(component_errors[component].items(),
                                                  key=lambda item: (-item[1], item[0]))[:5]]
            for component in sorted(component_totals)}
        result['topOrderFailuresByComponent'] = {
            component: [{'orderId': order_id, 'count': count} for order_id, count in
                        sorted(orders.items(), key=lambda item: (-item[1], item[0]))[:5]]
            for component, orders in sorted(order_failures.items())}
        result['pollsByMerchant'] = {
            merchant: {**poll, 'failureShare': poll['failed'] / poll['count']}
            for merchant, poll in sorted(poll_counts.items())}
        _private_directory(folder)
        target = folder / ('rollup-' + day + '.json')
        fd, temporary = tempfile.mkstemp(prefix='.rollup-', dir=folder)
        try:
            with os.fdopen(fd, 'w') as out:
                json.dump(result, out, separators=(',', ':'))
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return result
    except Exception:
        return None


def previous_day_rollup():
    try:
        folder = root()
        if folder is None:
            return
        now = dt.datetime.now(dt.timezone.utc)
        if (now.hour, now.minute) < (0, 5):
            return
        day = (now.date() - dt.timedelta(days=1)).isoformat()
        try:
            previous = json.loads((folder / ('rollup-' + day + '.json')).read_text())
        except (OSError, ValueError):
            previous = {}
        source = folder / (day + '.ndjson')
        size = source.stat().st_size if source.exists() else 0
        if (not isinstance(previous, dict) or previous.get('sourceBytes') != size
                or previous.get('schemaVersion') != 2
                or not all(key in previous for key in (
                    'errorsByComponent', 'failureShare', 'topErrorSamplesByComponent',
                    'topOrderFailuresByComponent', 'pollsByMerchant'))):
            rollup(day)
    except Exception:
        pass


def run_command(args, execute):
    props = {'lane': getattr(args, 'order_command', None) or getattr(args, 'vertical', None),
             'subcommand': args.command, 'prepareOnly': bool(getattr(args, 'prepare_only', False))}
    ids = {'flowId': getattr(args, 'flow_id', '')}
    emit('commerce', 'cmd.start', props=props, ids=ids)
    start, exit_code = perf_counter(), 1
    try:
        exit_code = execute(args)
        return exit_code
    finally:
        emit('commerce', 'cmd.end', kind='perf', ok=exit_code == 0, ids=ids,
             duration_ms=(perf_counter() - start) * 1000,
             props={**props, 'exitCode': exit_code, 'outcome': 'success' if exit_code == 0 else 'failure'})


def consumed(fn):
    @functools.wraps(fn)
    def wrapped(flow_id, operation, **kwargs):
        result = fn(flow_id, operation, **kwargs)
        # Never write at the financial boundary. The enclosing operation flushes
        # the in-memory record after its journal and payment locks are released.
        if _PENDING.get() is not None and kwargs.get('kind') in {'place', 'payment', 'preauthorize', 'prepay'}:
            emit('commerce', 'payment.may_have_sent', ids={'flowId': flow_id},
                 props={'amountMinor': kwargs.get('payable_minor')})
        return result
    return wrapped


def registration(fn):
    @functools.wraps(fn)
    def wrapped(argv=None, _locked=False):
        import sys
        args = sys.argv[1:] if argv is None else argv
        with deferred():
            try:
                return fn(argv, _locked=_locked)
            except Exception as exc:
                if args[:1] == ['add'] and not _locked:
                    def option(flag, default=None):
                        value = default
                        for i, arg in enumerate(args):
                            if arg == flag and i + 1 < len(args):
                                value = args[i + 1]
                            elif arg.startswith(flag + '='):
                                value = arg[len(flag) + 1:]
                        return value
                    emit('order-watch', 'track.add', kind='error', ok=False,
                         ids={'orderId':option('--order')},
                         props={'merchant':option('--app'),'source':option('--source','cli'),
                                'lane':option('--vertical')},
                         error='TRACK_REGISTRATION_FAILED', cause=_cause(exc))
                raise
    return wrapped
