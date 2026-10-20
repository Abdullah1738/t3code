"""Durable local HTTP-commerce ownership and at-most-once operations.

No network, credentials, raw cart/payment payloads, retry, reset or cancellation.
An unknown send retains account ownership; a different flow ID cannot escape it.
Stored order IDs are for exact reconciliation/tracking, never inferred from history.
"""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import time
import uuid

ROOT = Path.home() / '.local/state/app-api-cli/commerce'
CAMPAIGN = 'commerce-unrestricted-v1'
# Spending authority belongs to the caller, not a permanent CLI test policy.
# None is the public uncapped value; zero is its schema-v1 storage sentinel.
# Historical campaign rows and their reservations remain untouched.
TOTAL_LIMIT_MINOR = None
ORDER_LIMIT_MINOR = None
MAX_SQLITE_INTEGER = (1 << 63) - 1
VERTICALS = {'noon': {'nownow', 'main', 'minutes', 'supermall'},
             'talabat': {'shops', 'restaurants', 'mart'}}
OUTCOMES = frozenset({'RESPONSE_RECEIVED', 'UNKNOWN', 'CHALLENGE_REQUIRED',
                       'ORDER_ID_RECEIVED', 'PAYMENT_REPORTED_SUCCESS',
                       'EXACT_ORDER_CONFIRMED', 'TRACKER_REGISTERED',
                       'PREORDER_INTENT_RECEIVED','PREORDER_PAYMENT_CONFIRMED',
                       'FLOW_RELEASED_NO_PAYMENT_SENT', 'STABLE_CART_ADOPTED',
                        'FENCED_PAYMENT_RECONCILED', 'PREPARATION_FAILED'})
KINDS = frozenset({'cart', 'quote', 'instructions', 'selection', 'place', 'payment',
                   'preauthorize','prepay'})
SCHEMA = {
    'campaigns': '''CREATE TABLE campaigns (
        name TEXT PRIMARY KEY, total_limit INTEGER NOT NULL, order_limit INTEGER NOT NULL)''',
    'flows': '''CREATE TABLE flows (
        id TEXT PRIMARY KEY, campaign TEXT NOT NULL, app TEXT NOT NULL,
        vertical TEXT NOT NULL, account_hash TEXT NOT NULL, scope_hash TEXT NOT NULL,
        state TEXT NOT NULL, reserved_minor INTEGER NOT NULL DEFAULT 0,
        review_hash TEXT, place_cart_hash TEXT, order_id TEXT, created_at REAL NOT NULL)''',
    'active_account': '''CREATE UNIQUE INDEX active_account
        ON flows(app, account_hash) WHERE state NOT IN ('COMPLETE','RELEASED') ''',
    'carts': '''CREATE TABLE carts (
        app TEXT NOT NULL, account_hash TEXT NOT NULL, cart_hash TEXT NOT NULL,
        flow_id TEXT NOT NULL, PRIMARY KEY(app, account_hash, cart_hash))''',
    'orders': '''CREATE TABLE orders (
        app TEXT NOT NULL, account_hash TEXT NOT NULL, order_id TEXT NOT NULL,
        flow_id TEXT NOT NULL, PRIMARY KEY(app, account_hash, order_id))''',
    'operations': '''CREATE TABLE operations (
        flow_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
        request_hash TEXT NOT NULL, state TEXT NOT NULL, created_at REAL NOT NULL,
        PRIMARY KEY(flow_id,name))''',
    'observations': '''CREATE TABLE observations (
        sequence INTEGER PRIMARY KEY, flow_id TEXT NOT NULL, operation TEXT NOT NULL,
        outcome TEXT NOT NULL, evidence_hash TEXT NOT NULL, order_id TEXT,
        observed_at REAL NOT NULL)''',
}
# Exact historical schemas only; never repair a partial or unexpected schema.
LEGACY_ACTIVE_ACCOUNT = ('CREATE UNIQUE INDEX active_account '
                         "ON flows(app, account_hash) WHERE state != 'COMPLETE'")
SCHEMA_V1 = SCHEMA.copy()
OWNER_ATTESTED_UNCHARGED = 'OWNER_ATTESTED_UNCHARGED'
SCHEMA = {**SCHEMA,
    'active_account': '''CREATE UNIQUE INDEX active_account
        ON flows(app, account_hash) WHERE state NOT IN ('COMPLETE','RELEASED','OWNER_ATTESTED_UNCHARGED') ''',
    'owner_attestations': '''CREATE TABLE owner_attestations (
        flow_id TEXT PRIMARY KEY, order_id TEXT NOT NULL, reserved_minor INTEGER NOT NULL,
        attested_by TEXT NOT NULL, evidence TEXT NOT NULL, attested_at REAL NOT NULL,
        provider_evidence TEXT NOT NULL, evidence_hash TEXT NOT NULL)''',
}


def _schema_matches(objects, expected):
    return (set(objects) == set(expected) and all(
        ' '.join(objects[name].split()) == ' '.join(sql.split())
        for name, sql in expected.items()))


class JournalError(RuntimeError):
    pass


def fail(code):
    raise JournalError(code)


def digest(value):
    """Canonical private input -> binding. The input is never written."""
    try:
        encoded = json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    except (ValueError, TypeError, OverflowError):
        fail('JOURNAL_BINDING_INVALID')
    if len(encoded) > 2_000_000:
        fail('JOURNAL_BINDING_TOO_LARGE')
    return hashlib.sha256(encoded).hexdigest()


def _hash(value):
    return type(value) is str and re.fullmatch(r'[0-9a-f]{64}', value) is not None


def _flow(value):
    try:
        parsed = uuid.UUID(value)
    except (ValueError, TypeError, AttributeError):
        fail('JOURNAL_FLOW_INVALID')
    if type(value) is not str or str(parsed) != value or parsed.version != 4:
        fail('JOURNAL_FLOW_INVALID')
    return value


def _order(value):
    return type(value) is str and re.fullmatch(r'[A-Za-z0-9-]{1,80}', value) is not None


def _stat(path, directory=False):
    info = path.lstat()
    if (not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            or stat.S_IMODE(info.st_mode) != (0o700 if directory else 0o600)
            or info.st_uid != os.getuid() or (not directory and info.st_nlink != 1)):
        fail('JOURNAL_UNSAFE_PATH')
    return info


@contextmanager
def _db():
    db = None
    try:
        _stat(ROOT.parent, True)
        ROOT.mkdir(mode=0o700, exist_ok=True)
        _stat(ROOT, True)
        path = ROOT / 'journal.sqlite'
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        before = _stat(path)
        db = sqlite3.connect(path, timeout=0, isolation_level=None)
        after = _stat(path)
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            fail('JOURNAL_UNSAFE_PATH')
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA journal_mode=DELETE')
        db.execute('PRAGMA synchronous=FULL')
        db.execute('PRAGMA fullfsync=ON')
        db.execute('BEGIN IMMEDIATE')
        objects = dict(db.execute("SELECT name,sql FROM sqlite_master WHERE substr(name,1,7) != 'sqlite_'"))
        version = db.execute('PRAGMA user_version').fetchone()[0]
        if not objects and version == 0 and before.st_size == 0:
            for statement in SCHEMA.values():
                db.execute(statement)
            db.execute('PRAGMA user_version=2')
        elif version == 1 and any(_schema_matches(objects, expected) for expected in
                (SCHEMA_V1, {**SCHEMA_V1, 'active_account': LEGACY_ACTIVE_ACCOUNT})):
            db.execute('DROP INDEX active_account')
            db.execute(SCHEMA['active_account'])
            db.execute(SCHEMA['owner_attestations'])
            db.execute('PRAGMA user_version=2')
        elif version != 2 or not _schema_matches(objects, SCHEMA):
            fail('JOURNAL_SCHEMA_UNSUPPORTED')
        yield db
        db.execute('COMMIT')
        for directory in (ROOT, ROOT.parent):
            fd = os.open(directory, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    except JournalError:
        raise
    except sqlite3.IntegrityError:
        fail('JOURNAL_IDENTITY_ALREADY_OWNED_OR_CONSUMED')
    except sqlite3.OperationalError:
        fail('JOURNAL_BUSY_OR_UNAVAILABLE')
    except Exception:
        fail('JOURNAL_UNAVAILABLE')
    finally:
        if db is not None:
            if db.in_transaction:
                db.rollback()
            db.close()


def _get(db, flow_id):
    row = db.execute('SELECT * FROM flows WHERE id=?', (_flow(flow_id),)).fetchone()
    if row is None:
        fail('JOURNAL_FLOW_UNKNOWN')
    return row


def _active(row):
    if row['state'] != 'ACTIVE':
        fail('JOURNAL_FLOW_FENCED')


def open_flow(*, flow_id, app, vertical, account_hash, scope_hash):
    """Claim the account for a specific new intent; never adopts an existing flow."""
    _flow(flow_id)
    if (type(app) is not str or app not in VERTICALS or type(vertical) is not str
            or vertical not in VERTICALS[app] or not _hash(account_hash) or not _hash(scope_hash)):
        fail('JOURNAL_SCOPE_INVALID')
    with _db() as db:
        db.execute('INSERT OR IGNORE INTO campaigns VALUES (?,?,?)',
                   (CAMPAIGN, 0, 0))
        policy = db.execute('SELECT * FROM campaigns WHERE name=?', (CAMPAIGN,)).fetchone()
        if (policy['total_limit'], policy['order_limit']) != (0, 0):
            fail('JOURNAL_CAMPAIGN_METADATA_INVALID')
        db.execute('INSERT INTO flows(id,campaign,app,vertical,account_hash,scope_hash,state,created_at) '
                   'VALUES (?,?,?,?,?,?,?,?)', (flow_id, CAMPAIGN, app, vertical, account_hash, scope_hash, 'ACTIVE', time.time()))
    return {'flow_id': flow_id, 'state': 'ACTIVE', 'request_sent': False}


def consume(flow_id, operation, *, kind, request_hash, cart_hash=None,
            review_hash=None, payable_minor=None, payment_order_id=None, payment_intent_hash=None):
    """Return True ONLY after durable MAY_HAVE_SENT; no second use of an operation.

    Before each mutation, the preceding mutation must have an explicit observation.
    Reserving at place includes possible payment; payment does not reserve twice.
    Reservations are never refunded merely because a request failed or timed out.
    """
    if (type(operation) is not str or not re.fullmatch(r'[a-z][a-z0-9_]{0,63}', operation)
            or type(kind) is not str or kind not in KINDS or not _hash(request_hash)
            or (cart_hash is not None and not _hash(cart_hash))):
        fail('JOURNAL_OPERATION_INVALID')
    financial = kind in ('place', 'payment','preauthorize','prepay')
    if financial:
        if (not _hash(review_hash) or type(payable_minor) is not int
                or not 0 < payable_minor <= MAX_SQLITE_INTEGER or cart_hash is None):
            fail('JOURNAL_EXACT_QUOTE_OR_ORDER_BUDGET_INVALID')
    elif review_hash is not None or payable_minor is not None:
        fail('JOURNAL_NONFINANCIAL_AMOUNT_INVALID')
    if kind == 'payment':
        if not _order(payment_order_id):
            fail('JOURNAL_PAYMENT_ORDER_INVALID')
    elif payment_order_id is not None:
        fail('JOURNAL_PAYMENT_ORDER_ON_OTHER_OPERATION')
    if kind=='prepay':
        if not _hash(payment_intent_hash):fail('JOURNAL_PREORDER_INTENT_REQUIRED')
    elif payment_intent_hash is not None:fail('JOURNAL_INTENT_ON_OTHER_OPERATION')
    with _db() as db:
        flow = _get(db, flow_id)
        _active(flow)
        policy = db.execute('SELECT * FROM campaigns WHERE name=?', (flow['campaign'],)).fetchone()
        if policy is None:
            fail('JOURNAL_CAMPAIGN_METADATA_INVALID')
        if db.execute('SELECT 1 FROM operations WHERE flow_id=? AND state=?',
                      (flow_id, 'MAY_HAVE_SENT')).fetchone():
            fail('JOURNAL_PREVIOUS_SEND_UNOBSERVED')
        if cart_hash is not None:
            owner = db.execute('SELECT flow_id FROM carts WHERE app=? AND account_hash=? AND cart_hash=?',
                               (flow['app'], flow['account_hash'], cart_hash)).fetchone()
            if owner is not None and owner['flow_id'] != flow_id:
                fail('JOURNAL_CART_ALREADY_OWNED')
            db.execute('INSERT OR IGNORE INTO carts VALUES (?,?,?,?)',
                       (flow['app'], flow['account_hash'], cart_hash, flow_id))
        placed = db.execute("SELECT 1 FROM operations WHERE flow_id=? AND kind='place'", (flow_id,)).fetchone()
        preauth=db.execute("SELECT name FROM operations WHERE flow_id=? AND kind='preauthorize'",(flow_id,)).fetchone()
        if kind in ('preauthorize','prepay') and (flow['app']!='noon' or flow['vertical']!='nownow' or placed):
            fail('JOURNAL_PREORDER_SCOPE_INVALID')
        if kind=='preauthorize' and preauth:fail('JOURNAL_PREORDER_ALREADY_CONSUMED')
        if preauth and kind not in ('prepay','place','quote'):
            fail('JOURNAL_PREORDER_SELECTION_FROZEN')
        if preauth and kind=='quote' and not db.execute("SELECT 1 FROM observations WHERE flow_id=? AND outcome='PREORDER_PAYMENT_CONFIRMED'",(flow_id,)).fetchone():
            fail('JOURNAL_PREORDER_PAYMENT_UNCONFIRMED')
        if kind=='prepay':
            if (not preauth or flow['reserved_minor']!=payable_minor or flow['review_hash']!=review_hash
                    or flow['place_cart_hash']!=cart_hash):fail('JOURNAL_PREORDER_BINDING_MISMATCH')
            if db.execute("SELECT 1 FROM operations WHERE flow_id=? AND kind='prepay'",(flow_id,)).fetchone():
                fail('JOURNAL_PREORDER_PAYMENT_ALREADY_CONSUMED')
            intent=db.execute("SELECT evidence_hash FROM observations WHERE flow_id=? AND operation=? AND outcome='PREORDER_INTENT_RECEIVED'",
                (flow_id,preauth['name'])).fetchall()
            if len(intent)!=1 or intent[0]['evidence_hash']!=payment_intent_hash:fail('JOURNAL_PREORDER_INTENT_MISMATCH')
        if placed and kind != 'payment':
            fail('JOURNAL_PLACE_ALREADY_CONSUMED')
        if kind == 'place' and preauth:
            if (flow['reserved_minor']!=payable_minor or flow['review_hash']!=review_hash
                    or flow['place_cart_hash']!=cart_hash):fail('JOURNAL_PREORDER_BINDING_MISMATCH')
            if not db.execute("SELECT 1 FROM observations o JOIN operations p ON p.flow_id=o.flow_id AND p.name=o.operation "
                    "WHERE o.flow_id=? AND p.kind='prepay' AND o.outcome='PREORDER_PAYMENT_CONFIRMED'",(flow_id,)).fetchone():
                fail('JOURNAL_PREORDER_PAYMENT_UNCONFIRMED')
        elif kind in ('place','preauthorize'):
            db.execute('UPDATE flows SET reserved_minor=?,review_hash=?,place_cart_hash=? WHERE id=?',
                       (payable_minor, review_hash, cart_hash, flow_id))
        if kind == 'payment':
            if preauth:fail('JOURNAL_PREORDER_NO_POSTORDER_PAYMENT')
            if (not placed or flow['order_id'] is None or flow['reserved_minor'] != payable_minor
                    or flow['review_hash'] != review_hash or flow['place_cart_hash'] != cart_hash):
                fail('JOURNAL_PAYMENT_NOT_BOUND_TO_PLACE')
            if flow['order_id'] != payment_order_id:
                fail('JOURNAL_PAYMENT_ORDER_MISMATCH')
            if db.execute("SELECT 1 FROM operations WHERE flow_id=? AND kind='payment'", (flow_id,)).fetchone():
                fail('JOURNAL_PAYMENT_ALREADY_CONSUMED')
            if db.execute("SELECT 1 FROM observations WHERE flow_id=? AND outcome='PAYMENT_REPORTED_SUCCESS'",
                          (flow_id,)).fetchone():
                fail('JOURNAL_PAYMENT_ALREADY_REPORTED')
        db.execute('INSERT INTO operations VALUES (?,?,?,?,?,?)',
                   (flow_id, operation, kind, request_hash, 'MAY_HAVE_SENT', time.time()))
    return True


def observe(flow_id, operation, *, outcome, evidence_hash, order_id=None):
    """Append trusted adapter evidence, not a claim inferred by this local store."""
    if (type(outcome) is not str or outcome not in OUTCOMES or not _hash(evidence_hash)
            or (order_id is not None and not _order(order_id))):
        fail('JOURNAL_OBSERVATION_INVALID')
    requires_order = outcome in {'ORDER_ID_RECEIVED', 'PAYMENT_REPORTED_SUCCESS',
                                'EXACT_ORDER_CONFIRMED', 'TRACKER_REGISTERED'}
    if requires_order and order_id is None:
        fail('JOURNAL_EXACT_ORDER_ID_REQUIRED')
    with _db() as db:
        flow = _get(db, flow_id)
        if flow['state'] == 'COMPLETE':
            fail('JOURNAL_FLOW_COMPLETE')
        if flow['state'] == 'RELEASED':
            fail('JOURNAL_FLOW_RELEASED')
        if flow['state'] == OWNER_ATTESTED_UNCHARGED:
            fail('JOURNAL_FLOW_OWNER_ATTESTED_UNCHARGED')
        if outcome == 'PREPARATION_FAILED':
            fail('JOURNAL_USE_PREPARATION_RELEASE')
        op = db.execute('SELECT * FROM operations WHERE flow_id=? AND name=?', (flow_id, operation)).fetchone()
        if op is None:
            fail('JOURNAL_OPERATION_UNKNOWN')
        if outcome=='PREORDER_INTENT_RECEIVED':
            if op['kind']!='preauthorize' or order_id is not None:fail('JOURNAL_PREORDER_INTENT_SCOPE_INVALID')
            if db.execute("SELECT 1 FROM observations WHERE flow_id=? AND outcome='PREORDER_INTENT_RECEIVED'",(flow_id,)).fetchone():
                fail('JOURNAL_PREORDER_INTENT_ALREADY_BOUND')
        if outcome=='PREORDER_PAYMENT_CONFIRMED' and (op['kind']!='prepay' or order_id is not None):
            fail('JOURNAL_PREORDER_CONFIRMATION_SCOPE_INVALID')
        if order_id is not None:
            if op['kind'] not in ('place', 'payment'):
                fail('JOURNAL_ORDER_ON_NONFINANCIAL_OPERATION')
            if flow['order_id'] is not None and flow['order_id'] != order_id:
                fail('JOURNAL_ORDER_ID_CHANGED')
            owner = db.execute('SELECT flow_id FROM orders WHERE app=? AND account_hash=? AND order_id=?',
                               (flow['app'], flow['account_hash'], order_id)).fetchone()
            if owner is not None and owner['flow_id'] != flow_id:
                fail('JOURNAL_ORDER_ALREADY_OWNED')
            db.execute('INSERT OR IGNORE INTO orders VALUES (?,?,?,?)',
                       (flow['app'], flow['account_hash'], order_id, flow_id))
            db.execute('UPDATE flows SET order_id=? WHERE id=?', (order_id, flow_id))
        if outcome in ('UNKNOWN', 'CHALLENGE_REQUIRED'):
            db.execute('UPDATE flows SET state=? WHERE id=?', ('FENCED', flow_id))
        # Observations never undo a prior unknown or free a consumed operation.
        db.execute('UPDATE operations SET state=? WHERE flow_id=? AND name=?', ('OBSERVED', flow_id, operation))
        db.execute('INSERT INTO observations(flow_id,operation,outcome,evidence_hash,order_id,observed_at) '
                   'VALUES (?,?,?,?,?,?)', (flow_id, operation, outcome, evidence_hash, order_id, time.time()))
    return {'outcome': outcome, 'retry_allowed': False}

def reconcile_fenced_payment(flow_id, *, evidence_hash):
    """Explicitly reviewed reconciliation of an unknown async payment result.

    A fenced flow stays fenced even when later evidence looks successful;
    this is the separately reviewed implementation complete() asks for. It
    reactivates the flow ONLY when the fence came from an UNKNOWN observation
    on the financial operation that a LATER success observation on the same
    operation and order has superseded. Challenge fences, unknown places with
    no order, and non-financial fences are never reconciled here.
    """
    if not _hash(evidence_hash):
        fail('JOURNAL_OBSERVATION_INVALID')
    with _db() as db:
        flow = _get(db, flow_id)
        if flow['state'] != 'FENCED' or flow['order_id'] is None:
            fail('JOURNAL_RECONCILIATION_NOT_FENCED_ORDER')
        op = db.execute("SELECT * FROM operations WHERE flow_id=? AND kind='payment'",
                         (flow_id,)).fetchone()
        if op is None:
            fail('JOURNAL_RECONCILIATION_FINANCIAL_OPERATION_MISSING')
        unknown = db.execute("SELECT MIN(sequence) AS s FROM observations WHERE flow_id=? "
                             "AND operation=? AND outcome='UNKNOWN'",
                             (flow_id, op['name'])).fetchone()
        success = db.execute("SELECT MIN(sequence) AS s FROM observations WHERE flow_id=? "
                             "AND operation=? AND outcome='PAYMENT_REPORTED_SUCCESS' "
                             "AND order_id=?", (flow_id, op['name'], flow['order_id'])).fetchone()
        if unknown['s'] is None or success['s'] is None or not unknown['s'] < success['s']:
            fail('JOURNAL_RECONCILIATION_EVIDENCE_CHAIN_INVALID')
        db.execute('INSERT INTO observations(flow_id,operation,outcome,evidence_hash,order_id,observed_at) '
                  'VALUES (?,?,?,?,?,?)',
                  (flow_id, op['name'], 'FENCED_PAYMENT_RECONCILED', evidence_hash,
                   flow['order_id'], time.time()))
        db.execute('UPDATE flows SET state=? WHERE id=?', ('ACTIVE', flow_id))
    return {'outcome': 'FENCED_PAYMENT_RECONCILED', 'retry_allowed': False}


def complete(flow_id):
    """Close a known successful order, allowing a distinct deliberate next order.

    Unknown/challenged flows remain fenced, even if later supplied evidence looks
    successful; explicit reconciliation needs a separately reviewed implementation.
    """
    with _db() as db:
        flow = _get(db, flow_id)
        _active(flow)
        if flow['order_id'] is None or flow['reserved_minor'] <= 0:
            fail('JOURNAL_COMPLETION_UNPROVEN')
        financial = db.execute("SELECT name FROM operations WHERE flow_id=? AND kind='payment'", (flow_id,)).fetchone()
        preorder=db.execute("SELECT name FROM operations WHERE flow_id=? AND kind='prepay'",(flow_id,)).fetchone()
        if preorder is not None:
            financial=preorder
        if financial is None:
            financial = db.execute("SELECT name FROM operations WHERE flow_id=? AND kind='place'", (flow_id,)).fetchone()
        successes = list(db.execute("SELECT sequence FROM observations WHERE flow_id=? AND operation=? "
                                    "AND order_id=? AND outcome='PAYMENT_REPORTED_SUCCESS' ORDER BY sequence",
                                    (flow_id, financial['name'], flow['order_id']))) if financial else []
        if preorder is not None:
            successes=list(db.execute("SELECT sequence FROM observations WHERE flow_id=? AND operation=? AND outcome='PREORDER_PAYMENT_CONFIRMED' ORDER BY sequence",
                (flow_id,preorder['name'])))
        observations = list(db.execute('SELECT sequence,outcome FROM observations WHERE flow_id=? AND order_id=?',
                                       (flow_id, flow['order_id'])))
        if (not successes or not any(row['outcome'] == 'EXACT_ORDER_CONFIRMED'
                                    and row['sequence'] > successes[-1]['sequence'] for row in observations)
                or not any(row['outcome'] == 'TRACKER_REGISTERED' for row in observations)):
            fail('JOURNAL_COMPLETION_UNPROVEN')
        if preorder is not None and not db.execute("SELECT 1 FROM observations o JOIN operations p ON p.flow_id=o.flow_id AND p.name=o.operation "
                "WHERE o.flow_id=? AND p.kind='place' AND o.outcome='ORDER_ID_RECEIVED' AND o.order_id=?",
                (flow_id,flow['order_id'])).fetchone():
            fail('JOURNAL_COMPLETION_UNPROVEN')
        if db.execute("SELECT 1 FROM operations WHERE flow_id=? AND state='MAY_HAVE_SENT'", (flow_id,)).fetchone():
            fail('JOURNAL_PREVIOUS_SEND_UNOBSERVED')
        db.execute("UPDATE flows SET state='COMPLETE' WHERE id=?", (flow_id,))
    return {'state': 'COMPLETE', 'retry_allowed': False}


def release_preparation(flow_id, operation, *, evidence_hash):
    """Atomic, terminal closure after a durable failed Talabat quote receipt.

    Only known cart/quote endpoints, a successful observed create_cart and
    successful earlier quotes qualify. No financial operation, reservation,
    order, review approval or pending prior send is ever released here. Cart
    identity remains owned, and no operation can be reused. This is NOT remote
    cart deletion, order cancellation, refund evidence or purchase authority.
    """
    quotes = {'quote_initial', 'quote_initial_quiet', 'quote_selected',
              'quote_selected_quiet', 'quote_final_quiet'}
    if operation not in quotes or not _hash(evidence_hash):
        fail('JOURNAL_PREPARATION_RELEASE_INVALID')
    with _db() as db:
        flow = _get(db, flow_id)
        ops = list(db.execute('SELECT * FROM operations WHERE flow_id=? ORDER BY created_at,rowid', (flow_id,)))
        if (flow['app'] != 'talabat' or flow['state'] not in ('ACTIVE', 'FENCED')
                or flow['reserved_minor'] != 0 or any(flow[k] is not None for k in
                    ('order_id', 'review_hash', 'place_cart_hash'))
                or len(ops) < 2 or ops[0]['name'] != 'create_cart'
                or ops[0]['kind'] != 'cart' or ops[-1]['name'] != operation
                or any(r['name'] not in quotes or r['kind'] != 'quote' for r in ops[1:])):
            fail('JOURNAL_PREPARATION_RELEASE_NOT_PRE_FINANCIAL')
        for op in ops[:-1]:
            observed = list(db.execute('SELECT outcome FROM observations WHERE flow_id=? AND operation=?',
                                      (flow_id, op['name'])))
            if (op['state'] != 'OBSERVED' or not observed
                    or not any(r['outcome'] == 'RESPONSE_RECEIVED' for r in observed)
                    or any(r['outcome'] not in ('RESPONSE_RECEIVED', 'STABLE_CART_ADOPTED') for r in observed)):
                fail('JOURNAL_PREPARATION_RELEASE_PRIOR_SEND_UNRESOLVED')
        if db.execute("SELECT 1 FROM observations WHERE flow_id=? AND (order_id IS NOT NULL "
                      "OR outcome IN ('PAYMENT_REPORTED_SUCCESS','CHALLENGE_REQUIRED'))", (flow_id,)).fetchone():
            fail('JOURNAL_PREPARATION_RELEASE_FINANCIAL_EVIDENCE')
        db.execute("UPDATE operations SET state='OBSERVED' WHERE flow_id=? AND name=?", (flow_id, operation))
        db.execute('INSERT INTO observations(flow_id,operation,outcome,evidence_hash,observed_at) VALUES (?,?,?,?,?)',
                   (flow_id, operation, 'PREPARATION_FAILED', evidence_hash, time.time()))
        db.execute("UPDATE flows SET state='RELEASED' WHERE id=?", (flow_id,))
    return {'state': 'RELEASED', 'reason': 'PREPARATION_FAILED_NO_FINANCIAL_SEND',
            'financial_send': False, 'remote_cart_deleted': False, 'retry_allowed': False}


def release(flow_id, *, evidence_hash):
    """Terminal evidence-reviewed closure of a fenced never-paid flow.

    The journal's permanent fence exists because an unknown send keeps
    account ownership. When the exact merchant state later proves the order
    dead (failed/cancelled, not active, intent never captured) and no payment
    continuation was ever consumed, the caller may release THIS fence after
    gathering that evidence. The reservation stays counted; no order ID is
    freed for reuse; nothing here authorizes a retry.
    """
    if not _hash(evidence_hash):
        fail('JOURNAL_RELEASE_INVALID')
    with _db() as db:
        flow = _get(db, flow_id)
        if flow['state'] != 'FENCED':
            fail('JOURNAL_RELEASE_FENCED_ONLY')
        if flow['order_id'] is None:
            fail('JOURNAL_RELEASE_ORDER_REQUIRED')
        if db.execute("SELECT 1 FROM operations WHERE flow_id=? AND state='MAY_HAVE_SENT'",
                      (flow_id,)).fetchone():
            fail('JOURNAL_RELEASE_UNOBSERVED_SEND')
        operations = [row['kind'] for row in db.execute(
            'SELECT kind FROM operations WHERE flow_id=?', (flow_id,))]
        if 'place' not in operations or any(kind in ('payment', 'preauthorize', 'prepay')
                                            for kind in operations):
            fail('JOURNAL_RELEASE_PAYMENT_HISTORY_INVALID')
        if db.execute("SELECT 1 FROM observations WHERE flow_id=? AND outcome='PAYMENT_REPORTED_SUCCESS'",
                     (flow_id,)).fetchone():
            fail('JOURNAL_RELEASE_SUCCESS_ALREADY_OBSERVED')
        db.execute('UPDATE flows SET state=? WHERE id=?', ('RELEASED', flow_id))
        db.execute("INSERT INTO observations(flow_id,operation,outcome,evidence_hash,observed_at) "
                   "VALUES (?,?,?,?,?)",
                   (flow_id, next(row['name'] for row in db.execute(
                       "SELECT name FROM operations WHERE flow_id=? AND kind='place'", (flow_id,))),
                    'FLOW_RELEASED_NO_PAYMENT_SENT', evidence_hash, time.time()))
    return {'state': 'RELEASED', 'reservation_minor_retained': True, 'retry_allowed': False}


def release_orderless(flow_id, *, evidence_hash):
    """Terminal closure of a FENCED flow whose place POST was answered with an
    orderless refusal (4xx, no order id, no payment send).

    Unlike release(), there is no merchant order to prove dead: the server's
    own response refused the submission. The evidence review therefore happens
    in the CLI layer (receipts must show the refused place), and the journal
    only enforces the local shape: every send OBSERVED, a place present, no
    payment history, and no order id ever recorded.
    """
    if not _hash(evidence_hash):
        fail('JOURNAL_RELEASE_INVALID')
    with _db() as db:
        flow = _get(db, flow_id)
        if flow['state'] != 'FENCED':
            fail('JOURNAL_RELEASE_FENCED_ONLY')
        if flow['order_id'] is not None:
            fail('JOURNAL_RELEASE_ORDER_PRESENT')
        if db.execute("SELECT 1 FROM operations WHERE flow_id=? AND state='MAY_HAVE_SENT'",
                      (flow_id,)).fetchone():
            fail('JOURNAL_RELEASE_UNOBSERVED_SEND')
        operations = [row['kind'] for row in db.execute(
            'SELECT kind FROM operations WHERE flow_id=?', (flow_id,))]
        if 'place' not in operations or any(kind in ('payment', 'preauthorize', 'prepay')
                                            for kind in operations):
            fail('JOURNAL_RELEASE_PAYMENT_HISTORY_INVALID')
        if db.execute("SELECT 1 FROM observations WHERE flow_id=? AND outcome='PAYMENT_REPORTED_SUCCESS'",
                      (flow_id,)).fetchone():
            fail('JOURNAL_RELEASE_SUCCESS_ALREADY_OBSERVED')
        db.execute('UPDATE flows SET state=? WHERE id=?', ('RELEASED', flow_id))
        db.execute("INSERT INTO observations(flow_id,operation,outcome,evidence_hash,observed_at) "
                   "VALUES (?,?,?,?,?)",
                   (flow_id, 'place', 'FLOW_RELEASED_PLACE_REFUSED_NO_ORDER', evidence_hash, time.time()))
    return {'state': 'RELEASED', 'reservation_minor_retained': True, 'retry_allowed': False}


def payment_reported(flow_id):
    """True once a financial observation claimed PAYMENT_REPORTED_SUCCESS."""
    with _db() as db:
        _get(db, flow_id)
        return bool(db.execute("SELECT 1 FROM observations WHERE flow_id=? "
                               "AND outcome='PAYMENT_REPORTED_SUCCESS'", (flow_id,)).fetchone())


def validate_owner_attestation(*, evidence, attested_by):
    if (attested_by != 'owner' or type(evidence) is not str or not evidence.strip()
            or len(evidence) > 4096 or any(ord(c) < 32 and c not in '\n\t' or ord(c) == 127 for c in evidence)):
        fail('OWNER_ATTESTATION_EVIDENCE_REQUIRED')


def close_owner_attested_uncharged(flow_id, *, order_id, reserved_minor,
                                  evidence, attested_by, provider_evidence):
    """Trusted exact-provider review plus owner evidence, committed atomically.

    This is an owner disposition, not provider proof of a void/refund. Retain the
    reservation and every consumed operation/identity; only free the account slot.
    A later observer cannot reopen this terminal flow or authorize another send.
    """
    validate_owner_attestation(evidence=evidence, attested_by=attested_by)
    if type(provider_evidence) is not dict or not provider_evidence:
        fail('OWNER_ATTESTATION_PROVIDER_EVIDENCE_REQUIRED')
    evidence_hash = digest(provider_evidence)
    provider_json = json.dumps(provider_evidence, sort_keys=True, separators=(',', ':'), allow_nan=False)
    with _db() as db:
        flow = _get(db, flow_id)
        if (flow['app'] != 'talabat' or flow['state'] != 'FENCED'
                or not order_id or flow['order_id'] != order_id
                or type(reserved_minor) is not int or reserved_minor <= 0
                or flow['reserved_minor'] != reserved_minor):
            fail('OWNER_ATTESTATION_FENCED_TALABAT_PAYMENT_REQUIRED')
        ops = list(db.execute('SELECT * FROM operations WHERE flow_id=?', (flow_id,)))
        payments = [op for op in ops if op['kind'] == 'payment']
        if (len(payments) != 1 or sum(op['kind'] == 'place' for op in ops) != 1
                or any(op['state'] != 'OBSERVED' or op['kind'] in ('preauthorize', 'prepay') for op in ops)):
            fail('OWNER_ATTESTATION_PAYMENT_HISTORY_INVALID')
        if db.execute("SELECT 1 FROM observations WHERE flow_id=? AND outcome IN "
                      "('PAYMENT_REPORTED_SUCCESS','EXACT_ORDER_CONFIRMED','PREORDER_PAYMENT_CONFIRMED')",
                      (flow_id,)).fetchone():
            fail('OWNER_ATTESTATION_PROVIDER_SUCCESS_ALREADY_OBSERVED')
        now = time.time()
        audit_hash = digest({'flow_id': flow_id, 'order_id': order_id, 'reserved_minor': reserved_minor,
                             'attested_by': attested_by, 'evidence': evidence, 'attested_at': now,
                             'provider_evidence_hash': evidence_hash})
        db.execute('INSERT INTO owner_attestations VALUES (?,?,?,?,?,?,?,?)',
                   (flow_id, order_id, reserved_minor, attested_by, evidence, now, provider_json, audit_hash))
        db.execute('INSERT INTO observations(flow_id,operation,outcome,evidence_hash,order_id,observed_at) '
                   'VALUES (?,?,?,?,?,?)', (flow_id, payments[0]['name'], OWNER_ATTESTED_UNCHARGED,
                                           audit_hash, order_id, now))
        db.execute('UPDATE flows SET state=? WHERE id=?', (OWNER_ATTESTED_UNCHARGED, flow_id))
    return {'state': OWNER_ATTESTED_UNCHARGED, 'account_fence_lifted': True,
            'attested_at': now, 'evidence_hash': audit_hash,
            'reservation_minor_retained': reserved_minor, 'retry_allowed': False}


def inspect(flow_id):
    """Restart-safe local status. Order ID is private tracker input; no payloads."""
    with _db() as db:
        row = _get(db, flow_id)
        operations = [dict(x) for x in db.execute('SELECT name,kind,state FROM operations WHERE flow_id=? ORDER BY created_at', (flow_id,))]
        # Sum in Python so an uncapped history cannot overflow SQLite SUM.
        spent = sum(x[0] for x in db.execute('SELECT reserved_minor FROM flows WHERE campaign=?', (row['campaign'],)))
        policy = db.execute('SELECT * FROM campaigns WHERE name=?', (row['campaign'],)).fetchone()
        result = {'flow_id': flow_id, 'app': row['app'], 'vertical': row['vertical'],
                  'state': row['state'], 'order_id': row['order_id'], 'reserved_minor': row['reserved_minor'],
                  'campaign': row['campaign'], 'campaign_reserved_minor': spent,
                  'campaign_limit_minor': None, 'order_limit_minor': None,
                  'historical_campaign_limit_minor': (policy['total_limit'] or None) if policy else None,
                  'operations': operations, 'retry_allowed': False}
        attestation = db.execute('SELECT * FROM owner_attestations WHERE flow_id=?', (flow_id,)).fetchone()
        if attestation is not None:
            result['owner_attestation'] = dict(attestation)
            result['owner_attestation']['provider_evidence'] = json.loads(attestation['provider_evidence'])
    return result


def binding(flow_id):
    """Exact private receipt binding for read-only restart recovery."""
    with _db() as db:
        row = _get(db, flow_id)
        return {'flow_id': row['id'], 'app': row['app'], 'vertical': row['vertical'],
                'account_hash': row['account_hash'], 'scope_hash': row['scope_hash']}


def completed_order_binding(*, app, vertical, account_hash, order_id):
    """Attribute an exact account/order to its completed flow; no state changes.

    Remote fulfilment may still be active after payment, exact confirmation and
    tracker registration completed locally. Unknown, released, wrong-lane and
    unfinished orders cannot use this evidence to permit another checkout.
    """
    if (type(app) is not str or app not in VERTICALS or type(vertical) is not str
            or vertical not in VERTICALS[app] or not _hash(account_hash)
            or not _order(order_id)):
        fail('JOURNAL_ORDER_LOOKUP_INVALID')
    with _db() as db:
        row = db.execute(
            'SELECT f.id,f.scope_hash FROM orders o JOIN flows f ON f.id=o.flow_id '
            'AND f.app=o.app AND f.account_hash=o.account_hash AND f.order_id=o.order_id '
            "WHERE o.app=? AND o.account_hash=? AND o.order_id=? AND f.vertical=? AND f.state='COMPLETE'",
            (app, account_hash, order_id, vertical)).fetchone()
        return {'flow_id': row['id'], 'scope_hash': row['scope_hash']} if row is not None else None


def flow_created_at(flow_id):
    """Creation time for lane-local expiry windows (e.g. 24h resume limits)."""
    with _db() as db:
        row = _get(db, flow_id)
        return row['created_at']


def decline_observed_at(flow_id):
    """When a reported payment error was observed for this flow, or None. Read-only.

    A reported error (a card decline included) is journaled as UNKNOWN on the
    payment operation. A conclusive status read stops the poller, so the latest
    such row is at or after the decline a recovery re-reads (never earlier).
    """
    with _db() as db:
        _get(db, flow_id)
        row = db.execute("SELECT MAX(o.observed_at) AS at FROM observations o JOIN operations p "
                         "ON p.flow_id=o.flow_id AND p.name=o.operation "
                         "WHERE o.flow_id=? AND p.kind='payment' AND o.outcome='UNKNOWN'",
                         (flow_id,)).fetchone()
        return row['at']


def preorder_status(flow_id):
    """Read durable pre-order phase without exposing payment secrets."""
    with _db() as db:
        flow=_get(db,flow_id)
        rows=list(db.execute("SELECT name,kind,state FROM operations WHERE flow_id=? AND kind IN ('preauthorize','prepay') ORDER BY created_at",(flow_id,)))
        observations=list(db.execute("SELECT operation,outcome,evidence_hash FROM observations WHERE flow_id=? AND outcome IN ('PREORDER_INTENT_RECEIVED','PREORDER_PAYMENT_CONFIRMED') ORDER BY sequence",(flow_id,)))
        return {'state':flow['state'],'operations':[dict(row) for row in rows],
            'intent_hash':next((row['evidence_hash'] for row in observations if row['outcome']=='PREORDER_INTENT_RECEIVED'),None),
            'payment_confirmed':any(row['outcome']=='PREORDER_PAYMENT_CONFIRMED' for row in observations),
            'reserved_minor':flow['reserved_minor'],'order_id':flow['order_id'],
            'review_hash':flow['review_hash'],'cart_hash':flow['place_cart_hash']}


def abandon(flow_id):
    """Terminal local close of eligible nonfinancial preparation.

    Every operation must be OBSERVED (no
    MAY_HAVE_SENT), no place/payment/preauthorize/prepay op may exist, and the
    reservation must be zero. Nothing is released for retry; the account slot
    is freed without deleting any remote cart or undoing preparation changes.
    The legacy outcome/error codes below are retained for journal compatibility.
    """
    with _db() as db:
        flow = _get(db, flow_id)
        if flow['state'] not in ('ACTIVE', 'FENCED'):
            fail('JOURNAL_ABANDON_ACTIVE_ONLY')
        rows = list(db.execute("SELECT kind,state FROM operations WHERE flow_id=?", (flow_id,)))
        if (any(r['state'] != 'OBSERVED' for r in rows)
                or any(r['kind'] in ('place', 'payment', 'preauthorize', 'prepay') for r in rows)
                or flow['reserved_minor']):
            fail('JOURNAL_ABANDON_UNSENT_ONLY')
        db.execute('UPDATE flows SET state=? WHERE id=?', ('RELEASED', flow_id))
        db.execute("INSERT INTO observations(flow_id,operation,outcome,evidence_hash,observed_at) "
                   "VALUES (?,?,?,?,?)",
                   (flow_id, 'flow', 'FLOW_ABANDONED_UNSENT_READS_ONLY',
                    digest({'flow_id': flow_id, 'outcome': 'FLOW_ABANDONED_UNSENT_READS_ONLY'}), time.time()))
    return {'state': 'RELEASED', 'abandoned': True, 'retry_allowed': False}


def cart_owner(app, account_hash, cart_hash):
    """Current owning flow of a cart binding, or None. Read-only."""
    if not _hash(cart_hash):
        fail('JOURNAL_CART_LOOKUP_INVALID')
    with _db() as db:
        row = db.execute('SELECT flow_id FROM carts WHERE app=? AND account_hash=? AND cart_hash=?',
                         (app, account_hash, cart_hash)).fetchone()
        return row['flow_id'] if row is not None else None


def minutes_cleanup_source(flow_id):
    """Proof for cart-only cleanup of a closed Minutes preparation, never payment.

    The last session response hash binds the *entire* current projection. A
    later local mutating flow invalidates ownership, even if its items match.
    """
    with _db() as db:
        flow = _get(db, flow_id)
        ops = list(db.execute('SELECT * FROM operations WHERE flow_id=? ORDER BY created_at,rowid', (flow_id,)))
        if (flow['app'] != 'noon' or flow['vertical'] != 'minutes' or flow['state'] != 'RELEASED'
                or flow['reserved_minor'] != 0 or any(flow[k] is not None for k in
                    ('order_id', 'review_hash', 'place_cart_hash'))
                or not any(x['name'] == 'sync' and x['kind'] == 'cart' for x in ops)
                or any(x['kind'] not in ('cart', 'instructions', 'selection')
                       or x['state'] != 'OBSERVED' for x in ops)):
            fail('MINUTES_CLEAR_CLOSED_CART_ONLY_FLOW_REQUIRED')
        if db.execute("SELECT 1 FROM flows f JOIN operations p ON p.flow_id=f.id "
                      "WHERE f.app='noon' AND f.account_hash=? AND f.id!=? "
                      "AND p.created_at>? AND (f.vertical!='minutes' OR "
                      "(p.name!='session_get' AND p.name NOT LIKE 'session_readback_%'))",
                      (flow['account_hash'], flow_id, ops[-1]['created_at'])).fetchone():
            fail('MINUTES_CLEAR_CART_OWNERSHIP_SUPERSEDED')
        op = ops[-1]
        if not (op['name'] in ('sync', 'instructions', 'payment', 'session_get')
                or op['name'].startswith('session_readback_')):
            fail('MINUTES_CLEAR_SESSION_EVIDENCE_REQUIRED')
        evidence = list(db.execute('SELECT outcome,evidence_hash FROM observations '
                                   'WHERE flow_id=? AND operation=? ORDER BY sequence', (flow_id, op['name'])))
        if not evidence or any(x['outcome'] != 'RESPONSE_RECEIVED' for x in evidence):
            fail('MINUTES_CLEAR_SESSION_EVIDENCE_REQUIRED')
        return {'account_hash': flow['account_hash'], 'scope_hash': flow['scope_hash'],
                'operation': op['name'], 'request_hash': op['request_hash'],
                'evidence_hash': evidence[-1]['evidence_hash']}


def claim_minutes_cleanup(source_flow_id, cleanup_flow_id, *, evidence_hash):
    """Account claim precedes the empty sync. Source ownership is rechecked at send."""
    proof = minutes_cleanup_source(source_flow_id)
    if proof['evidence_hash'] != evidence_hash:
        fail('MINUTES_CLEAR_CART_READBACK_MISMATCH')
    return open_flow(flow_id=cleanup_flow_id, app='noon', vertical='minutes',
                     account_hash=proof['account_hash'],
                     scope_hash=digest({'cleanup_of': source_flow_id, 'evidence_hash': evidence_hash}))


def adopt_stable_cart(new_flow_id, old_flow_id, cart_hash, *, evidence_hash):
    """Transfer an account-stable cart binding to a resuming flow.

    Talabat grocery cart ids are account-stable: a cart POST replaces contents
    and keeps the id, so a successor flow legitimately reuses the same identity.
    The prior owner must be terminal RELEASED with no financial operation and
    no reservation; the new flow must be ACTIVE with nothing placed. The
    transfer is one-way and recorded as durable evidence on the new flow.
    """
    if not _hash(evidence_hash) or not _hash(cart_hash) or new_flow_id == old_flow_id:
        fail('JOURNAL_ADOPTION_INVALID')
    with _db() as db:
        new = _get(db, new_flow_id)
        old = _get(db, old_flow_id)
        if (new['state'] != 'ACTIVE' or new['app'] != 'talabat' or new['order_id'] is not None
                or new['reserved_minor'] != 0):
            fail('JOURNAL_ADOPTION_NEW_FLOW_INVALID')
        if db.execute("SELECT 1 FROM operations WHERE flow_id=? AND name='create_cart'", (new_flow_id,)).fetchone() is None:
            fail('JOURNAL_ADOPTION_NEW_FLOW_CART_OPERATION_REQUIRED')
        if old['state'] != 'RELEASED' or old['app'] != 'talabat' or old['account_hash'] != new['account_hash']:
            fail('JOURNAL_ADOPTION_PRIOR_OWNER_INVALID')
        if old['order_id'] is not None:
            fail('JOURNAL_ADOPTION_PRIOR_OWNER_FINANCIAL')
        # A prior place attempt is adoptable only when it is fully OBSERVED and
        # provably produced no order (order_id None, no payment send ever): the
        # orderless-refusal shape. Its budget reservation stays counted (never
        # spent) and does not block identity transfer. Any payment history or
        # an unobserved place send keeps the prior owner financial.
        for row in db.execute("SELECT kind,state FROM operations WHERE flow_id=?", (old_flow_id,)):
            if row['kind'] in ('payment', 'preauthorize', 'prepay'):
                fail('JOURNAL_ADOPTION_PRIOR_OWNER_FINANCIAL')
            if row['kind'] == 'place' and row['state'] != 'OBSERVED':
                fail('JOURNAL_ADOPTION_PRIOR_OWNER_FINANCIAL')
        row = db.execute('SELECT flow_id FROM carts WHERE app=? AND account_hash=? AND cart_hash=?',
                         (new['app'], new['account_hash'], cart_hash)).fetchone()
        owned = db.execute('SELECT cart_hash FROM carts WHERE app=? AND account_hash=? AND flow_id=?',
                           (new['app'], new['account_hash'], new_flow_id)).fetchall()
        if any(r['cart_hash'] != cart_hash for r in owned):
            fail('JOURNAL_ADOPTION_NEW_FLOW_ALREADY_OWNS_CART')
        if row is None:
            # Receipts-only prior: the prior flow's create_cart receipt holds the
            # account-stable cart identity but it never reached a quote consume,
            # so no carts row was ever written. The successor legitimately claims
            # the identity (INSERT) instead of transferring it (UPDATE); every
            # prior-holder guard above still applied to the receipts holder.
            db.execute('INSERT INTO carts (app, account_hash, cart_hash, flow_id) VALUES (?,?,?,?)',
                       (new['app'], new['account_hash'], cart_hash, new_flow_id))
        elif row['flow_id'] != old_flow_id:
            fail('JOURNAL_ADOPTION_CART_NOT_OWNED_BY_PRIOR')
        else:
            db.execute('UPDATE carts SET flow_id=? WHERE app=? AND account_hash=? AND cart_hash=? AND flow_id=?',
                       (new_flow_id, new['app'], new['account_hash'], cart_hash, old_flow_id))
        # Evidence row only: the create_cart operation stays MAY_HAVE_SENT until
        # the successor persists its receipt and observes RESPONSE_RECEIVED, so
        # the send ambiguity is never masked by the adoption itself.
        db.execute("INSERT INTO observations(flow_id,operation,outcome,evidence_hash,observed_at) "
                   "VALUES (?,?,?,?,?)",
                   (new_flow_id, 'create_cart', 'STABLE_CART_ADOPTED', evidence_hash, time.time()))
    return {'adopted_cart_hash': cart_hash, 'prior_flow_id': old_flow_id, 'transferred': True}


def require_account_available(app, account_hash, *, flow_id=None):
    """Reject a fenced/owned account before preparing a new remote operation.

    Reads remain available independently. This does not release, reset, or adopt
    an existing flow; consume() repeats the check atomically before every send.
    """
    if app not in VERTICALS or not _hash(account_hash):fail('JOURNAL_SCOPE_INVALID')
    if flow_id is not None:_flow(flow_id)
    with _db() as db:
        active=db.execute("SELECT id,state FROM flows WHERE app=? AND account_hash=? "
                          "AND state NOT IN ('COMPLETE','RELEASED','OWNER_ATTESTED_UNCHARGED')",
                          (app,account_hash)).fetchone()
        if active is not None and (active['id']!=flow_id or active['state']!='ACTIVE'):
            fail('JOURNAL_ACCOUNT_RECONCILIATION_REQUIRED')
    return True


def reconcile_preparation(flow_id, operation, *, request_hash, evidence_hash):
    """Trusted exact readback of the latest nonfinancial send, never a resend.

    Financial ambiguity/challenges cannot use this path. The original operation
    remains consumed; only subsequent, distinct preparation/place can proceed.
    """
    if not _hash(request_hash) or not _hash(evidence_hash):
        fail('JOURNAL_RECONCILIATION_INVALID')
    with _db() as db:
        flow = _get(db, flow_id)
        operations = list(db.execute('SELECT * FROM operations WHERE flow_id=? ORDER BY created_at', (flow_id,)))
        if (flow['state'] != 'FENCED' or flow['reserved_minor'] != 0 or flow['order_id'] is not None
                or not operations or operations[-1]['name'] != operation
                or operations[-1]['kind'] not in ('cart', 'quote', 'instructions', 'selection')
                or operations[-1]['request_hash'] != request_hash
                or any(row['kind'] in ('place', 'payment') for row in operations)):
            fail('JOURNAL_RECONCILIATION_NOT_NONFINANCIAL')
        bad = list(db.execute("SELECT operation,outcome FROM observations WHERE flow_id=? AND outcome IN ('UNKNOWN','CHALLENGE_REQUIRED')", (flow_id,)))
        if not bad or any(row['operation'] != operation or row['outcome'] != 'UNKNOWN' for row in bad):
            fail('JOURNAL_RECONCILIATION_AMBIGUOUS')
        db.execute('INSERT INTO observations(flow_id,operation,outcome,evidence_hash,observed_at) VALUES (?,?,?,?,?)',
                   (flow_id, operation, 'RESPONSE_RECEIVED', evidence_hash, time.time()))
        db.execute("UPDATE operations SET state='OBSERVED' WHERE flow_id=? AND name=?", (flow_id, operation))
        db.execute("UPDATE flows SET state='ACTIVE' WHERE id=?", (flow_id,))
    return {'state':'ACTIVE','reconciled_operation':operation,'retry_allowed':False}
