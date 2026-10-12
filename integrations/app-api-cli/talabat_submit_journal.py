"""Local at-most-once fence only; no HTTP, auth, order submission or unlock API.

Consumption precedes a possible send and is permanent, even when a caller dies
before sending. Hashes are local bindings, never server idempotency guarantees.
No raw account/cart/card/order identifiers, requests or responses are stored.
"""
from contextlib import contextmanager
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import time
import uuid

from talabat_http_orders import TalabatError

ROOT = Path.home() / '.local/state/app-api-cli/talabat-submit'
BINDINGS = frozenset(('account', 'cart', 'home', 'card', 'items', 'charges', 'instructions', 'request'))
STATES = frozenset(('RESPONSE_RECEIVED', 'PAYMENT_PENDING', 'CHALLENGE_REQUIRED', 'ORDER_ID_OBSERVED',
                    'EXACT_ORDER_VERIFIED', 'SUBMISSION_UNKNOWN'))


def _fail(code):
    raise TalabatError(code)


def _hash(value):
    return type(value) is str and re.fullmatch(r'[0-9a-f]{64}', value) is not None


def _timestamp(value):
    return type(value) in (int, float) and math.isfinite(value) and value > 0


def review_digest(review):
    """Validate and hash a LOCAL review envelope, not a Talabat wire schema.

    A future adapter must build these bindings from fresh verified observations;
    this pure helper does not establish authorization or recover old cart lineage.
    """
    if (type(review) is not dict or set(review) != {
            'version', 'bindings', 'currency', 'payable_minor', 'observed_at', 'expires_at'}
            or type(review['version']) is not int or review['version'] != 1
            or type(review['bindings']) is not dict or set(review['bindings']) != BINDINGS
            or not all(_hash(v) for v in review['bindings'].values())
            or review['currency'] != 'AED' or type(review['payable_minor']) is not int
            or not 1 <= review['payable_minor'] <= 5000
            or not _timestamp(review['observed_at']) or not _timestamp(review['expires_at'])
            or not 0 < review['expires_at'] - review['observed_at'] <= 120):
        _fail('SUBMIT_REVIEW_INVALID')
    raw = json.dumps(review, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    return hashlib.sha256(raw).hexdigest()


def _secure_stat(path, directory=False):
    info = path.lstat()
    expected = 0o700 if directory else 0o600
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if (not kind(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != expected or (not directory and info.st_nlink != 1)):
        _fail('SUBMIT_JOURNAL_UNSAFE_PATH')
    return info


@contextmanager
def _db():
    connection = None
    try:
        # The owner-only auth-state parent must already exist. Silently rebuilding
        # missing state could discard a past fence. Tests patch ROOT below a
        # pre-existing private temp parent; no CLI exposes a path override.
        _secure_stat(ROOT.parent, directory=True)
        ROOT.mkdir(mode=0o700, exist_ok=True)
        _secure_stat(ROOT, directory=True)
        path = ROOT / 'journal.sqlite'
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        before = _secure_stat(path)
        connection = sqlite3.connect(path, timeout=0, isolation_level=None)
        after = _secure_stat(path)
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            _fail('SUBMIT_JOURNAL_UNSAFE_PATH')
        connection.execute('PRAGMA journal_mode=DELETE')
        connection.execute('PRAGMA synchronous=FULL')
        connection.execute('PRAGMA fullfsync=ON')
        connection.execute('BEGIN IMMEDIATE')
        connection.execute('''CREATE TABLE IF NOT EXISTS attempts (
            operation TEXT PRIMARY KEY, account_hash TEXT NOT NULL UNIQUE,
            cart_hash TEXT NOT NULL, digest TEXT NOT NULL, payable_minor INTEGER NOT NULL,
            created_at REAL NOT NULL, state TEXT NOT NULL,
            UNIQUE(account_hash, cart_hash))''')
        connection.execute('''CREATE TABLE IF NOT EXISTS observations (
            sequence INTEGER PRIMARY KEY, operation TEXT NOT NULL, state TEXT NOT NULL,
            evidence_hash TEXT NOT NULL, observed_at REAL NOT NULL)''')
        yield connection
        connection.execute('COMMIT')
        # Retain both the DB entry and the first-use ROOT entry before returning
        # permission to attempt a send. Failure here remains fail-closed/spent.
        for path in (ROOT, ROOT.parent):
            directory = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    except TalabatError:
        raise
    except sqlite3.OperationalError:
        _fail('SUBMIT_JOURNAL_BUSY_OR_UNAVAILABLE')
    except Exception:
        _fail('SUBMIT_JOURNAL_UNAVAILABLE')
    finally:
        if connection is not None:
            if connection.in_transaction:
                connection.rollback()
            connection.close()


def consume(review, approved_digest):
    """Atomically consume one locally approved fresh review, never send anything.

    Same-account attempts remain fenced across new cart IDs and process crashes.
    There is deliberately no automatic reset/release, even after exact readback;
    future deliberate orders need a separately reviewed lifecycle implementation.
    """
    digest = review_digest(review)
    if not _hash(approved_digest) or not hmac.compare_digest(digest, approved_digest):
        _fail('SUBMIT_REVIEW_NOT_APPROVED')
    now = time.time()
    if not review['observed_at'] <= now < review['expires_at']:
        _fail('SUBMIT_REVIEW_STALE')
    operation = str(uuid.uuid4())
    with _db() as db:
        # Recheck after acquiring the cross-process exclusive transaction.
        now = time.time()
        if not review['observed_at'] <= now < review['expires_at']:
            _fail('SUBMIT_REVIEW_STALE')
        try:
            db.execute('INSERT INTO attempts VALUES (?,?,?,?,?,?,?)',
                       (operation, review['bindings']['account'], review['bindings']['cart'],
                        digest, review['payable_minor'], now, 'MAY_HAVE_SENT'))
        except sqlite3.IntegrityError:
            _fail('SUBMIT_ACCOUNT_ALREADY_FENCED')
    return {'operation': operation, 'state': 'MAY_HAVE_SENT', 'digest': digest}


def record_observation(operation, state, evidence_hash):
    """Append an adapter observation. Never reinterpret uncertainty as safe retry.

    An evidence hash is just a local record pointer; it does not prove an order,
    charge, challenge completion or delivery. No raw payload is accepted.
    """
    if (type(operation) is not str or re.fullmatch(r'[0-9a-f-]{36}', operation) is None
            or type(state) is not str or state not in STATES or not _hash(evidence_hash)):
        _fail('SUBMIT_OBSERVATION_INVALID')
    with _db() as db:
        if db.execute('SELECT 1 FROM attempts WHERE operation=?', (operation,)).fetchone() is None:
            _fail('SUBMIT_OPERATION_UNKNOWN')
        db.execute('INSERT INTO observations(operation,state,evidence_hash,observed_at) VALUES (?,?,?,?)',
                   (operation, state, evidence_hash, time.time()))
    return {'state': state, 'retry_allowed': False, 'account_fence_retained': True}
