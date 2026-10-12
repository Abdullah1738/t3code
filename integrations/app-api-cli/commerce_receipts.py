"""Private, append-only received evidence for a trusted commerce coordinator.

No auth access, transport, journal transitions or mutation restoration. Callbacks
are projected field by field; raw responses and payment instruments cannot be
stored. A receipt is evidence, never permission to resend an operation.
"""
from contextlib import contextmanager
from dataclasses import dataclass, replace
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
import uuid
import talabat_quote_diagnostics as quote_diagnostics

from talabat_http_checkout import AsyncPaymentContext, PaymentResult
from talabat_place_contract import PlaceObservation
from commerce_journal import MAX_SQLITE_INTEGER

ROOT = Path.home() / '.local/state/app-api-cli/commerce'
MAX_BYTES = 65536
VERTICALS = {'talabat': {'shops', 'restaurants', 'mart'},
             'noon': {'main', 'supermall', 'minutes', 'nownow'}}
PREPARATION = {'create_cart', 'quote_initial', 'quote_selected',
               'quote_initial_quiet', 'quote_selected_quiet', 'quote_final_quiet'}
PLACE_PAIRS = {
    ('SUBMISSION_UNKNOWN', 'RESPONSE_MISSING_OR_MALFORMED'),
    ('SUBMISSION_UNKNOWN', 'DUPLICATE_ORDER_ERROR_NO_RETRY'),
    ('SUBMISSION_UNKNOWN', 'GENERIC_ERROR_NO_RETRY'),
    ('SUBMISSION_UNKNOWN', 'HTTP_STATUS_UNSUPPORTED_NO_RETRY'),
    ('SUBMISSION_UNKNOWN', 'PLACED_ORDER_IDENTITY_INVALID'),
    ('SUBMISSION_UNKNOWN', 'PLACED_ORDER_SCHEMA_UNSUPPORTED'),
    ('CHALLENGE_REQUIRED', 'MOBILE_VERIFICATION_REQUIRED'),
    ('CHALLENGE_REQUIRED', 'PAYMENT_REDIRECT_UNSUPPORTED'),
    ('PAYMENT_PENDING', 'PAYMENT_COMPLETION_UNPROVEN'),
}
PAYMENT_PAIRS = {
    ('PAYMENT_UNKNOWN', 'RESPONSE_INVALID_NO_RETRY'),
    ('PAYMENT_UNKNOWN', 'STATUS_READ_FAILED_NO_RETRY'),
    ('PAYMENT_UNKNOWN', 'ASYNC_STATUS_LITERAL_UNSUPPORTED'),
    ('PAYMENT_UNKNOWN', 'ASYNC_READ_AUTH_RENEWAL_REQUIRED'),
    ('PAYMENT_BLOCKED', 'FALLBACK_NOT_FOLLOWED'),
    ('PAYMENT_BLOCKED', 'SDK_BRANCH_NOT_SUPPORTED'),
    ('CHALLENGE_REQUIRED', 'REDIRECT_NOT_FOLLOWED'),
    ('PAYMENT_ERROR_REPORTED', 'NO_ROLLBACK_OR_RETRY_ASSUMED'),
    ('PAYMENT_PENDING', 'TALABAT_ASYNC_STATUS_REQUIRED'),
    ('PAYMENT_PENDING', 'ASYNC_STATUS_PENDING'),
    ('PAYMENT_REPORTED_SUCCESS', 'TALABAT_SYNC_NORMAL_RETURN'),
    ('PAYMENT_REPORTED_SUCCESS', 'EXACT_TRANSACTION_ASYNC_STATUS_SUCCESS'),
}


class ReceiptError(RuntimeError):
    def __init__(self, code='RECEIPT_INVALID'):
        self.code = code
        super().__init__(code)


def _require(ok, code='RECEIPT_INVALID'):
    if not ok:
        raise ReceiptError(code)


def _hash(value):
    return type(value) is str and re.fullmatch(r'[0-9a-f]{64}', value) is not None


def _uuid(value):
    try:
        parsed = uuid.UUID(value)
        return type(value) is str and str(parsed) == value and parsed.version == 4
    except (ValueError, AttributeError, TypeError):
        return False


def _text(value, maximum=512, empty=False):
    return (type(value) is str and len(value) <= maximum and (empty or bool(value.strip()))
            and all(ord(c) >= 32 and ord(c) != 127 for c in value)
            and re.search(r'(?i)(?:https?|javascript|data)\s*:', value) is None)


@dataclass(frozen=True, repr=False)
class Binding:
    flow_id: str
    app: str
    vertical: str
    account_hash: str
    scope_hash: str

    def __post_init__(self):
        _require(_uuid(self.flow_id) and type(self.app) is str and self.app in VERTICALS
                 and type(self.vertical) is str and self.vertical in VERTICALS[self.app]
                 and _hash(self.account_hash) and _hash(self.scope_hash), 'RECEIPT_BINDING_INVALID')


@dataclass(frozen=True, repr=False)
class Receipt:
    """Allowlisted evidence. Use the bound callable sink for Talabat callbacks.

    Noon may append this minimal type directly; no client secret or card token
    field exists. Monetary quote revisions are separate immutable observations.
    """
    operation: str
    state: str
    reason: str | None = None
    http_status: int | None = None
    cart_id: str | None = None
    cart_binding: str | None = None
    currency: str | None = None
    payable_minor: int | None = None
    review_sha256: str | None = None
    order_id: str | None = None
    transaction_id: str | None = None
    balance_amount: str | None = None
    payment_id: str | None = None
    metadata: str | None = None
    context: AsyncPaymentContext | None = None
    next_index: int | None = None
    # Account-stable ids this receipt legitimately re-records from a prior
    # terminal flow (Talabat grocery cart). Validated globally in _check_foreign.
    adopted: tuple = ()
    # Allowlisted quote failure projection only, never a raw account response.
    diagnostic: dict | None = None


@dataclass(frozen=True, repr=False)
class TalabatReadback:
    """Inputs only for AsyncPaymentPoller, which performs GETs with fresh auth.

    A terminal stored result must be handled before creating another poller.
    Nothing here can reconstruct Checkout or authorize place/payment.
    """
    context: AsyncPaymentContext
    next_index: int
    result: PaymentResult
    stopped: bool


@dataclass(frozen=True, repr=False)
class Snapshot:
    binding: Binding
    receipts: tuple[Receipt, ...]

    def talabat_readback(self):
        _require(self.binding.app == 'talabat', 'RECEIPT_NOT_TALABAT')
        records = [r for r in self.receipts if r.context is not None]
        _require(bool(records), 'RECEIPT_ASYNC_CONTEXT_UNAVAILABLE')
        r = records[-1]
        result = PaymentResult(r.state, r.reason, r.order_id, r.transaction_id, r.payment_id, r.metadata)
        # The rejected-auth poller stops; recovery may supply fresh verified auth
        # to a new GET-only poller at this same context and advanced cursor.
        renew_read_auth = (r.operation == 'payment_status' and r.http_status == 401
                           and (r.state, r.reason) == ('PAYMENT_UNKNOWN', 'ASYNC_READ_AUTH_RENEWAL_REQUIRED'))
        stopped = (r.state != 'PAYMENT_PENDING' and not renew_read_auth
                   and not (r.operation == 'payment' and r.state == 'PAYMENT_UNKNOWN'))
        return TalabatReadback(r.context, r.next_index, result, stopped)


def _binding_wire(b):
    return dict(flow_id=b.flow_id, app=b.app, vertical=b.vertical,
                account_hash=b.account_hash, scope_hash=b.scope_hash)


def _context_wire(c):
    if c is None:
        return None
    _require(type(c) is AsyncPaymentContext, 'RECEIPT_CONTEXT_INVALID')
    return dict(order_id=c.order_id, transaction_id=c.transaction_id, acceptance_id=c.acceptance_id,
                intervals=list(c.intervals), account_binding=c.account_binding,
                payment_id=c.payment_id, metadata=c.metadata)


def _wire(r):
    _require(type(r) is Receipt)
    _require(type(r.adopted) is tuple and all(type(x) is str and x for x in r.adopted)
             and len(set(r.adopted)) == len(r.adopted))
    # Explicit projection, never asdict() an adapter object or response.
    return dict(operation=r.operation, state=r.state, reason=r.reason, http_status=r.http_status,
                cart_id=r.cart_id, cart_binding=r.cart_binding, currency=r.currency,
                payable_minor=r.payable_minor, review_sha256=r.review_sha256,
                order_id=r.order_id, transaction_id=r.transaction_id, balance_amount=r.balance_amount,
                payment_id=r.payment_id, metadata=r.metadata, context=_context_wire(r.context),
                next_index=r.next_index, adopted=list(r.adopted), diagnostic=r.diagnostic)


def _validate(b, r):
    _require(type(r) is Receipt)
    _require(type(r.operation) is str and type(r.state) is str)
    _require(r.reason is None or type(r.reason) is str)
    if r.diagnostic is not None:
        _require(b.app == 'talabat' and r.operation in PREPARATION - {'create_cart'}
                 and r.state == 'PREPARATION_FAILED' and quote_diagnostics.valid(r.diagnostic)
                 and r.reason == r.diagnostic['error_code'], 'RECEIPT_DIAGNOSTIC_INVALID')
    _require(r.http_status is None or type(r.http_status) is int and 100 <= r.http_status <= 599)
    _require(r.cart_id is None or _text(r.cart_id))
    for value in (r.cart_binding, r.review_sha256):
        _require(value is None or _hash(value))
    if r.cart_id is not None:
        _require(r.cart_binding == hashlib.sha256(r.cart_id.encode()).hexdigest(), 'RECEIPT_CART_MISMATCH')
    if r.payable_minor is None:
        _require(r.currency is None)
    else:
        _require(type(r.payable_minor) is int and 0 <= r.payable_minor <= MAX_SQLITE_INTEGER and r.currency == 'AED')
    order_pattern = r'[0-9]{1,20}' if b.app == 'talabat' else r'[A-Za-z0-9-]{1,80}'
    _require(r.order_id is None or type(r.order_id) is str and re.fullmatch(order_pattern, r.order_id))
    _require(r.transaction_id is None or _text(r.transaction_id))
    _require(r.balance_amount is None or type(r.balance_amount) is str
             and re.fullmatch(r'[0-9]+(?:\.[0-9]{1,2})?', r.balance_amount))
    for value in (r.payment_id, r.metadata):
        _require(value is None or _text(value, 8192, empty=True))
    if r.adopted:
        _require(r.operation == 'create_cart' and type(r.adopted) is tuple
                 and all(type(x) is str and x for x in r.adopted)
                 and len(set(r.adopted)) == len(r.adopted), 'RECEIPT_ADOPTION_INVALID')
        for value in r.adopted:
            _require(value in (r.cart_id, r.cart_binding), 'RECEIPT_ADOPTION_INVALID')
    if b.app == 'noon':
        _require(r.operation in {'preparation', 'place', 'payment', 'payment_status', 'tracking'}
                 and r.state in {'RESPONSE_RECEIVED', 'SUBMISSION_UNKNOWN', 'CHALLENGE_REQUIRED',
                                 'ORDER_ID_RECEIVED', 'PAYMENT_PENDING', 'PAYMENT_UNKNOWN',
                                 'PAYMENT_REPORTED_SUCCESS', 'EXACT_ORDER_CONFIRMED', 'TRACKER_REGISTERED'}
                 and r.reason is None and all(x is None for x in
                     (r.transaction_id, r.balance_amount, r.payment_id, r.metadata, r.context, r.next_index)))
        if r.state in {'ORDER_ID_RECEIVED', 'PAYMENT_REPORTED_SUCCESS', 'EXACT_ORDER_CONFIRMED', 'TRACKER_REGISTERED'}:
            _require(r.order_id is not None, 'RECEIPT_ORDER_REQUIRED')
        return
    if r.operation in PREPARATION:
        _require(all(x is None for x in (r.order_id, r.transaction_id, r.balance_amount,
                                        r.payment_id, r.metadata, r.context, r.next_index)))
        if r.state == 'PREPARATION_FAILED':
            _require(r.operation != 'create_cart' and r.diagnostic is not None
                     and all(x is None for x in (r.cart_id, r.cart_binding, r.currency,
                                                r.payable_minor, r.review_sha256)))
        elif r.state == 'SUBMISSION_UNKNOWN':
            _require(r.reason == 'RESPONSE_INVALID_OR_UNAVAILABLE_NO_RETRY' and all(x is None for x in
                     (r.cart_id, r.cart_binding, r.currency, r.payable_minor, r.review_sha256)))
        else:
            _require(r.state == 'SUCCEEDED' and r.reason is None)
            if r.operation == 'create_cart':
                _require(r.cart_id is not None and r.http_status in (200, 201)
                         and r.payable_minor is None and r.review_sha256 is None)
            else:
                _require(r.cart_id is None and r.cart_binding is not None and r.payable_minor is not None
                         and r.review_sha256 is not None and r.http_status == 200)
        return
    _require(all(x is None for x in (r.cart_id, r.cart_binding, r.currency, r.payable_minor, r.review_sha256)))
    if r.operation == 'place':
        _require((r.state, r.reason) in PLACE_PAIRS and all(x is None for x in
                     (r.payment_id, r.metadata, r.context, r.next_index)))
        return
    _require(r.operation in {'payment', 'payment_status'} and (r.state, r.reason) in PAYMENT_PAIRS
             and r.order_id is not None and r.transaction_id is not None and r.balance_amount is None)
    if r.context is None:
        _require(r.operation == 'payment' and type(r.next_index) is int and r.next_index == 0)
        return
    c = r.context
    _require(type(c) is AsyncPaymentContext and type(c.intervals) is tuple
             and 1 <= len(c.intervals) <= 180 and all(type(x) in (int, float) and math.isfinite(x)
                 and 0.001 <= x <= 60 for x in c.intervals) and sum(c.intervals) <= 300,
             'RECEIPT_CONTEXT_INVALID')
    _require(c.account_binding == b.account_hash and c.acceptance_id == b.flow_id
             and (c.order_id, c.transaction_id, c.payment_id, c.metadata) ==
                 (r.order_id, r.transaction_id, r.payment_id, r.metadata), 'RECEIPT_CONTEXT_MISMATCH')
    _require(type(r.next_index) is int and 0 <= r.next_index <= len(c.intervals), 'RECEIPT_CURSOR_INVALID')
    if r.operation == 'payment':
        _require(r.next_index == 0 and r.state in {'PAYMENT_PENDING', 'PAYMENT_UNKNOWN'}, 'RECEIPT_CURSOR_INVALID')


def _callback(b, record):
    _require(type(record) is dict and b.app == 'talabat', 'RECEIPT_CALLBACK_INVALID')
    record = record.copy()
    operation = record.get('operation')
    _require(type(operation) is str, 'RECEIPT_CALLBACK_INVALID')
    if 'flow_id' in record:
        _require(record.pop('flow_id') == b.flow_id, 'RECEIPT_FLOW_MISMATCH')
    else:
        _require(operation == 'payment_status', 'RECEIPT_FLOW_REQUIRED')
    base = dict(operation=operation, http_status=record.get('http_status'))
    if operation in PREPARATION:
        if record.get('state') == 'PREPARATION_FAILED':
            keys = {'operation', 'state', 'reason', 'http_status', 'diagnostic'}
        elif record.get('state') == 'SUBMISSION_UNKNOWN':
            keys = {'operation', 'state', 'reason', 'http_status'}
        elif operation == 'create_cart':
            keys = {'operation', 'state', 'http_status', 'cart_id', 'cart_binding'}
        else:
            keys = {'operation', 'state', 'http_status', 'cart_binding', 'currency', 'payable_minor', 'review_sha256'}
        _require(set(record) == keys, 'RECEIPT_CALLBACK_FIELDS_INVALID')
        return Receipt(**record)
    if operation == 'place':
        _require(set(record) == {'operation', 'observation', 'http_status'}, 'RECEIPT_CALLBACK_FIELDS_INVALID')
        o = record['observation']
        _require(type(o) is PlaceObservation)
        # Malformed balance must not discard an otherwise exact received ID.
        balance = o.balance_amount if type(o.balance_amount) is str and re.fullmatch(
            r'[0-9]{1,6}(?:\.[0-9]{1,2})?', o.balance_amount) else None
        return Receipt(**base, state=o.state, reason=o.reason, order_id=o.order_id,
                       transaction_id=o.transaction_id, balance_amount=balance)
    _require(operation in {'payment', 'payment_status'} and set(record) ==
             {'operation', 'result', 'context', 'next_index', 'http_status'}, 'RECEIPT_CALLBACK_FIELDS_INVALID')
    p = record['result']
    _require(type(p) is PaymentResult)
    return Receipt(**base, state=p.state, reason=p.reason, order_id=p.order_id, transaction_id=p.transaction_id,
                   payment_id=p.payment_id, metadata=p.metadata, context=record['context'], next_index=record['next_index'])


def _check_append(b, previous, r, all_flows):
    _validate(b, r)
    # Cross-flow identity uniqueness lives in _check_foreign (evaluated over the
    # complete scan so it can never depend on file order). Talabat grocery cart
    # ids are account-stable: adoption is stamped on the receipt itself and the
    # prior owner must stay non-financial forever after.
    for field in ('cart_id', 'cart_binding', 'order_id', 'transaction_id', 'payment_id'):
        value = getattr(r, field)
        if value is None:
            continue
        _require(all(getattr(old, field) in (None, value) for old in previous), 'RECEIPT_ID_REBOUND')
    if r.operation not in {'payment_status', 'tracking'}:
        _require(all(old.operation != r.operation for old in previous), 'RECEIPT_OPERATION_ALREADY_STORED')
    if b.app != 'talabat':
        placed = next((old for old in previous if old.operation == 'place'), None)
        if placed is not None:
            _require(r.operation != 'preparation', 'RECEIPT_PREPARATION_AFTER_PLACE')
            for field in ('currency', 'payable_minor', 'review_sha256'):
                value = getattr(r, field)
                _require(value is None or value == getattr(placed, field), 'RECEIPT_PLACE_BINDING_CHANGED')
        return
    if r.operation in PREPARATION:
        _require(not any(old.operation == 'place' for old in previous), 'RECEIPT_PREPARATION_AFTER_PLACE')
    if r.operation in {'payment', 'payment_status'}:
        _require(any(old.operation == 'place' and old.order_id == r.order_id
                     and old.transaction_id == r.transaction_id for old in previous), 'RECEIPT_PAYMENT_NOT_BOUND_TO_PLACE')
    if r.operation == 'payment_status':
        contexts = [old for old in previous if old.context is not None]
        _require(bool(contexts) and _context_wire(contexts[-1].context) == _context_wire(r.context), 'RECEIPT_CONTEXT_REBOUND')
        _require(r.next_index == contexts[-1].next_index + 1, 'RECEIPT_CURSOR_NOT_NEXT')


def _check_foreign(flows):
    """Global cross-flow identity uniqueness over a COMPLETE scan.

    Evaluated after every receipt of every flow is loaded, so the verdict can
    never depend on filename order. Invariant per identity value (cart id,
    cart binding, order, transaction, payment): at most ONE flow may hold it
    financially (place/payment/payment_status receipts). A flow that stamps a
    value as adopted (account-stable cart identity re-recorded from a terminal
    prior flow) owns that value; every other flow holding it must stay
    non-financial forever, or the adoption is void.
    """
    adopted_by = {}
    financial = {}
    for flow, snap in flows.items():
        stamps = set()
        for r in snap.receipts:
            stamps.update(r.adopted)
        adopted_by[flow] = frozenset(stamps)

        def _financial(r):
            # A refused orderless place (400, no order) never moved money; a
            # place is financial only once it carries the order it created,
            # and payment ops once they carry their transaction identity.
            if r.operation == 'place':
                return bool(r.order_id or r.transaction_id)
            if r.operation in ('payment', 'payment_status'):
                return bool(r.order_id or r.transaction_id or r.payment_id)
            return False

        financial[flow] = any(_financial(r) for r in snap.receipts)
    for flow, snap in flows.items():
        for r in snap.receipts:
            for field in ('cart_id', 'cart_binding', 'order_id', 'transaction_id', 'payment_id'):
                value = getattr(r, field)
                # Empty paymentId is a native supplied value, not a unique identity.
                if value is None or value == '':
                    continue
                for other_flow, other in flows.items():
                    if other_flow == flow or other.binding.app != snap.binding.app:
                        continue
                    if not any(getattr(old, field) == value for old in other.receipts):
                        continue
                    if value in adopted_by[flow] or value in adopted_by[other_flow]:
                        # The identity is account-stable and adopted across
                        # flows. Any number of non-financial holders may share
                        # it, but at most ONE holder may ever be financial
                        # with it (the flow that actually placed the order).
                        # Two financial holders would mean the same cart was
                        # ordered twice.
                        _require(not (financial[flow] and financial[other_flow]),
                                 'RECEIPT_ADOPTION_FOREIGN_FINANCIAL')
                    else:
                        _require(False, 'RECEIPT_ID_FOREIGN')


def _safe(fd, directory=False, publication=None):
    info = os.fstat(fd)
    links_ok = (info.st_nlink == 1 if publication is None else
                info.st_nlink == 2 and (info.st_dev, info.st_ino) == publication)
    _require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
             and stat.S_IMODE(info.st_mode) == (0o700 if directory else 0o600)
             and info.st_uid == os.getuid() and (directory or links_ok), 'RECEIPT_UNSAFE_PATH')


def _sync(fd, directory=False):
    os.fsync(fd)
    if sys.platform == 'darwin' and not directory:
        fcntl.fcntl(fd, fcntl.F_FULLFSYNC)


@contextmanager
def _directory(create=False, write=False):
    """Walk with directory descriptors, never following a symlink component."""
    fds = []
    try:
        path = Path(ROOT)
        _require(path.is_absolute() and '..' not in path.parts, 'RECEIPT_UNSAFE_PATH')
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        fd = os.open('/', flags)
        fds.append(fd)
        for part in path.parent.parts[1:]:
            fd = os.open(part, flags, dir_fd=fd)
            fds.append(fd)
        _safe(fd, True)
        for part in (path.name, 'receipts'):
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
                _sync(fd, True)
            fd = os.open(part, flags, dir_fd=fd)
            fds.append(fd)
            _safe(fd, True)
        lock = os.open('.lock', os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_CREAT if create else 0), 0o600, dir_fd=fd)
        fds.append(lock)
        _safe(lock)
        fcntl.flock(lock, fcntl.LOCK_EX if write else fcntl.LOCK_SH)
        yield fd
    except ReceiptError:
        raise
    except Exception:
        raise ReceiptError('RECEIPT_STORE_UNAVAILABLE') from None
    finally:
        for fd in reversed(fds):
            os.close(fd)


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        _require(key not in result, 'RECEIPT_CORRUPT')
        result[key] = value
    return result


def _read(fd, name, publication=None):
    file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        _safe(file, publication=publication)
        with os.fdopen(file, 'rb', closefd=False) as stream:
            raw = stream.read(MAX_BYTES + 1)
        _require(len(raw) <= MAX_BYTES, 'RECEIPT_CORRUPT')
        return json.loads(raw.decode('utf-8'), object_pairs_hook=_pairs,
                          parse_constant=lambda _: _require(False, 'RECEIPT_CORRUPT'))
    finally:
        os.close(file)


def _publication_pairs(fd, names):
    """Only a pending/final pair with no other inode aliases can be recovered."""
    inodes = {}
    for name in names:
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        inodes.setdefault((info.st_dev, info.st_ino), []).append((name, info))
    pairs = {}
    for identity, entries in inodes.items():
        pending = [name for name, info in entries if re.fullmatch(r'\.pending-[0-9a-f-]{36}', name)
                   and info.st_nlink == 2]
        if not pending:
            continue
        _require(len(entries) == 2 and len(pending) == 1 and _uuid(pending[0][9:]), 'RECEIPT_UNSAFE_PATH')
        final = next(name for name, _ in entries if name != pending[0])
        _require(re.fullmatch(r'[0-9a-f-]{36}\.[0-9]{8}\.json', final) is not None, 'RECEIPT_UNSAFE_PATH')
        pairs[pending[0]] = pairs[final] = identity
    return pairs


def _scan(fd):
    # All callers hold LOCK_EX: recovery can remove only the unpublished alias,
    # after the entire published history passes the normal schema/binding checks.
    flows = {}
    names = sorted(os.listdir(fd))
    publications = _publication_pairs(fd, names)
    for name in names:
        if name == '.lock':
            continue
        # Single-link unpublished files are never adopted or deleted. A paired
        # alias is removed below only after validating its published receipt.
        if re.fullmatch(r'\.pending-[0-9a-f-]{36}', name):
            file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            try:
                _safe(file, publication=publications.get(name))
            finally:
                os.close(file)
            continue
        match = re.fullmatch(r'([0-9a-f-]{36})\.([0-9]{8})\.json', name)
        _require(match is not None, 'RECEIPT_UNEXPECTED_FILE')
        flow, version = match[1], int(match[2])
        data = _read(fd, name, publications.get(name))
        _require(type(data) is dict and set(data) == {'schema', 'binding', 'version', 'receipt'}
                 and type(data['schema']) is int and data['schema'] == 1
                 and type(data['version']) is int and data['version'] == version
                 and type(data['binding']) is dict, 'RECEIPT_CORRUPT')
        b = Binding(**data['binding'])
        _require(b.flow_id == flow, 'RECEIPT_BINDING_MISMATCH')
        if version == 0:
            _require(data['receipt'] is None and flow not in flows, 'RECEIPT_CORRUPT')
            flows[flow] = Snapshot(b, ())
            continue
        _require(flow in flows and flows[flow].binding == b
                 and version == len(flows[flow].receipts) + 1, 'RECEIPT_VERSION_OR_BINDING_MISMATCH')
        value = data['receipt']
        _require(type(value) is dict, 'RECEIPT_CORRUPT')
        value = value.copy()
        # Back-compat: receipts published before the adoption field exist.
        value.setdefault('adopted', [])
        value.setdefault('diagnostic', None)
        value['adopted'] = tuple(value['adopted'])
        _require(set(value) == set(_wire(Receipt('', ''))), 'RECEIPT_CORRUPT')
        if value['context'] is not None:
            c = value['context']
            _require(type(c) is dict and type(c.get('intervals')) is list, 'RECEIPT_CORRUPT')
            value['context'] = AsyncPaymentContext(**{**c, 'intervals': tuple(c['intervals'])})
        r = Receipt(**value)
        _check_append(b, flows[flow].receipts, r, flows)
        flows[flow] = Snapshot(b, flows[flow].receipts + (r,))
    _check_foreign(flows)
    if publications:
        # Persist the final name before dropping the spare link, including when
        # the original publisher died before its directory fsync.
        _sync(fd, True)
        for name in publications:
            if name.startswith('.pending-'):
                os.unlink(name, dir_fd=fd)
                _sync(fd, True)
    return flows


def _publish(fd, b, version, receipt):
    data = dict(schema=1, binding=_binding_wire(b), version=version,
                receipt=None if receipt is None else _wire(receipt))
    raw = json.dumps(data, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    _require(len(raw) <= MAX_BYTES, 'RECEIPT_TOO_LARGE')
    temporary = '.pending-' + str(uuid.uuid4())
    name = f'{b.flow_id}.{version:08d}.json'
    file = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    try:
        _safe(file)
        with os.fdopen(file, 'wb', closefd=False) as stream:
            stream.write(raw)
            stream.flush()
            _sync(file)
        # Atomic, no-clobber publication. Never os.replace an earlier receipt.
        os.link(temporary, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
    finally:
        os.close(file)
        os.unlink(temporary, dir_fd=fd)
        _sync(fd, True)


@dataclass(frozen=True, repr=False)
class ReceiptStore:
    binding: Binding

    def snapshot(self):
        with _directory(write=True) as fd:
            flows = _scan(fd)
            _require(self.binding.flow_id in flows, 'RECEIPT_FLOW_UNKNOWN')
            result = flows[self.binding.flow_id]
            _require(result.binding == self.binding, 'RECEIPT_BINDING_MISMATCH')
            return result

    def holders(self, value, *, exclude_flow=None):
        """Flow ids whose receipts hold an identity value (cart id/binding).

        Read-only global scan used by adoption guards to find receipts-only
        prior holders that never wrote a journal carts row. Raises nothing on
        unknown flows; returns a set of flow ids.
        """
        if type(value) is not str or not value:
            return set()
        with _directory(write=False) as fd:
            flows = _scan(fd)
        found = set()
        for flow, snap in flows.items():
            if flow == exclude_flow or snap.binding.app != self.binding.app:
                continue
            for r in snap.receipts:
                if value in (r.cart_id, r.cart_binding):
                    found.add(flow)
                    break
        return found

    def append(self, receipt, *, adopted_ids=frozenset()):
        _validate(self.binding, receipt)
        if type(adopted_ids) is not frozenset:
            adopted_ids = frozenset()
        if adopted_ids:
            # Adoption is stamped on the receipt so every future scan re-derives
            # the exemption; only cart identity may be adopted.
            _require(receipt.operation == 'create_cart', 'RECEIPT_ADOPTION_INVALID')
            receipt = replace(receipt, adopted=tuple(sorted(adopted_ids)))
        with _directory(write=True) as fd:
            flows = _scan(fd)
            _require(self.binding.flow_id in flows, 'RECEIPT_FLOW_UNKNOWN')
            previous = flows[self.binding.flow_id]
            _require(previous.binding == self.binding, 'RECEIPT_BINDING_MISMATCH')
            _check_append(self.binding, previous.receipts, receipt, flows)
            candidate = {**flows, self.binding.flow_id:
                         Snapshot(self.binding, previous.receipts + (receipt,))}
            _check_foreign(candidate)
            _publish(fd, self.binding, len(previous.receipts) + 1, receipt)
        return True

    def __call__(self, record, *, adopted_ids=frozenset()):
        return self.append(_callback(self.binding, record), adopted_ids=adopted_ids)


def create(*, flow_id, app, vertical, account_hash, scope_hash):
    """New binding only. Existing flows must be loaded with their exact binding."""
    b = Binding(flow_id, app, vertical, account_hash, scope_hash)
    with _directory(create=True, write=True) as fd:
        flows = _scan(fd)
        _require(flow_id not in flows, 'RECEIPT_FLOW_EXISTS')
        _publish(fd, b, 0, None)
    return ReceiptStore(b)


def load(*, flow_id, app, vertical, account_hash, scope_hash):
    """Verify history/binding and finish interrupted publication, never add evidence."""
    store = ReceiptStore(Binding(flow_id, app, vertical, account_hash, scope_hash))
    store.snapshot()
    return store
