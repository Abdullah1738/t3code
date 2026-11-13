"""Best-effort, local orders diagnostics. Only allowlisted metadata reaches disk."""
import contextlib
import contextvars
import datetime as dt
import functools
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
from time import perf_counter
import tempfile

CAP_BYTES = 50 * 1024 * 1024
_PENDING = contextvars.ContextVar('orders_log_pending', default=None)
_SEEN = set()
_NAMES = {
    'cmd.start', 'cmd.end', 'cmd.error', 'guard.refused', 'payment.may_have_sent',
    'step.auth', 'step.cart_build', 'step.checkout', 'step.payment_submit',
    'step.bank_approval_wait', 'step.confirmation', 'flow.recover_payment',
    'flow.release', 'flow.abandon', 'track.add', 'track.poll', 'track.transition',
    'track.eta_elapsed', 'track.delivered', 'track.error', 'card.assert',
    'provider.track', 'provider.orders', 'provider.details', 'log.cap',
    'case.open', 'case.update', 'case.close', 'case.reopen', 'case.corroborate',
    'question.ask', 'check.run',
}
_ENUMS = {
    'lane': {'food', 'minutes', 'nownow', 'main', 'supermall', 'careem', 'uber'},
    'merchant': {'noon', 'careem', 'amazon', 'uber', 'other'},
    'source': {'cli', 'phone', 'email'},
    'outcome': {'success', 'failure', 'refused', 'ask_now', 'dont_ask', 'unverified', 'failed'},
    'kind': {'refund', 'dispute', 'decline', 'unasked_charge', 'charge', 'hold',
             'payment_deadline', 'autopay_expected', 'merchant_card'},
    'slowestPhase': {'reconcile', 'follow', 'attention', 'build_write'},
    'state': {'unknown', 'placed', 'preparing', 'picked up', 'out for delivery',
              'nearby', 'delivered', 'cancelled', 'pending confirmation'},
}
_ENUMS['from'] = _ENUMS['to'] = _ENUMS['state']
_BOOLS = {'prepareOnly', 'changed', 'fallback', 'budgetHit', 'unmatched', 'deadlineMoved', 'answered'}
_NUMBERS = {'exitCode', 'amountMinor', 'count', 'ageDays', 'openCases', 'fired'}
_CASE_FIELDS = {'merchant', 'amount', 'currency', 'reference', 'state', 'next', 'deadline',
                'due', 'why', 'who', 'watchers', 'note', 'because', 'reply', 'source'}
_MONEY_PROPS = {
    'case.open': {'kind', 'unmatched'},
    'case.update': {'fields', 'deadlineMoved', 'answered'},
    'case.close': {'kind', 'ageDays'},
    'question.ask': {'outcome'},
    'check.run': {'budgetHit', 'openCases', 'fired', 'slowestPhase'},
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


def _fields(props):
    result = {}
    for key, value in (props or {}).items():
        if key in _ENUMS and type(value) is str and value in _ENUMS[key]:
            result[key] = value
        elif key in _BOOLS and type(value) is bool:
            result[key] = value
        elif key in _NUMBERS and type(value) is int and abs(value) <= 10**12:
            result[key] = value
        elif key == 'fields' and type(value) is str and (value == '' or all(
                field in _CASE_FIELDS for field in value.split(','))):
            result[key] = value
        elif key == 'last4' and type(value) is str and re.fullmatch(r'[0-9]{4}', value):
            result[key] = value
    return result


def _ids(values):
    # Hash even syntactically valid IDs: input IDs can themselves contain a PAN/OTP.
    return {key: hashlib.sha256(str(value).encode()).hexdigest()[:16]
            for key, value in (values or {}).items()
            if key in {'flowId', 'orderId', 'caseId'} and type(value) in (str, int) and value != ''}


def emit(component, name, *, kind='event', duration_ms=None, ok=None, ids=None, props=None, error=None):
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
        if props:
            row['props'] = _fields(props)
        if error is not None:
            code = tag(error)
            row['error'] = {'tag': code, 'message': code}
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
                           'error': {'tag': 'LOG_CAP', 'message': 'LOG_CAP'}}
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


def timed(component, name, *, lane=None):
    def decorate(fn):
        @functools.wraps(fn)
        def wrapped(*args, **kwargs):
            with deferred():
                start = perf_counter()
                ok, code = False, None
                try:
                    result = fn(*args, **kwargs)
                    ok = not (isinstance(result, dict) and (result.get('ok') is False or bool(result.get('errors'))))
                    if not ok:
                        code = tag(result.get('error'))
                    if name == 'step.bank_approval_wait' and isinstance(result, dict) and (
                            result.get('paid') is False or result.get('verification_confirmed') is False
                            or result.get('timed_out') is True):
                        ok = False
                        code = 'PAYMENT_WAIT_TIMEOUT' if result.get('timed_out') is True else 'PAYMENT_WAIT_UNCONFIRMED'
                    return result
                except Exception as exc:
                    code = tag(getattr(exc, 'code', str(exc)))
                    raise
                finally:
                    try:
                        obj = args[0] if args else None
                        emit(component, name, kind='perf' if ok else 'error', ok=ok,
                             duration_ms=(perf_counter() - start) * 1000,
                             ids=({'orderId': kwargs.get('expected_order_id') or kwargs.get('order_id') or kwargs.get('order') or (obj if name in {'provider.track', 'provider.details'} and type(obj) is str else None)} if name.startswith('provider.') else
                                  {'orderId': obj.get('order')} if isinstance(obj, dict) else
                                  {'flowId': kwargs.get('flow_id') or getattr(obj, 'flow_id', obj if type(obj) is str else '')}),
                             props=({**result.get('logProps', {})} if name == 'track.poll' and ok is not None and 'result' in locals() and isinstance(result, dict) else {'lane': lane or getattr(obj, 'service', None) or (args[1] if name == 'step.auth' and len(args) > 1 and type(args[1]) is str else None)}), error=code)
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
        counts, kinds, durations, errors = {}, {}, {}, {}
        total = oks = failures = error_lines = invalid = source_bytes = 0
        path = folder / (day + '.ndjson')
        if path.exists():
            with path.open() as source:
                for line in source:
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
                    value = row.get('durationMs')
                    if type(value) in (float, int) and math.isfinite(value):
                        durations.setdefault(name, []).append(value)
                    if kind == 'error':
                        code = tag(row.get('error', {}).get('tag'))
                        item = errors.setdefault(code, {'tag': code, 'count': 0, 'sampleId': None})
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
        result = {'day': day, 'tool': 'orders', 'total': total, 'countsByName': counts,
                  'countsByKind': kinds, 'okRate': oks / (oks + failures) if oks + failures else None,
                  'errorRate': error_lines / total if total else 0, 'durationsMs': latency,
                  'topErrors': sorted(errors.values(), key=lambda x: (-x['count'], x['tag']))[:20],
                  'invalidLines': invalid, 'sourceBytes': source_bytes}
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
        if not isinstance(previous, dict) or previous.get('sourceBytes') != size:
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
            except Exception:
                if args[:1] == ['add'] and not _locked:
                    def option(flag, default=None):
                        return args[args.index(flag)+1] if flag in args and args.index(flag)+1 < len(args) else default
                    emit('order-watch', 'track.add', kind='error', ok=False,
                         ids={'orderId':option('--order')},
                         props={'merchant':option('--app'),'source':option('--source','cli')},
                         error='TRACK_REGISTRATION_FAILED')
                raise
    return wrapped
