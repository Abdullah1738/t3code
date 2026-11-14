"""Shared phone claims. Priority holds never expire by age; expired leases are free.

Lease holders refresh their TTL so a crashed background job cannot wedge the phone.
The metadata flock serializes compare/replace/unlink, not device operations.
"""
import contextlib
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import tempfile

LOCK_DIR = Path(os.environ.get('PH_LOCK_DIR', '~/.local/share/phone-lock')).expanduser()
HOLD = LOCK_DIR / 'priority-hold'
LEASE = LOCK_DIR / 'lease.json'
HOLD_REASON = 'owner request holds the phone; if it is yours, export PHONE_HOLD_OWNER=<your exact hold token>'
DEFAULT_TTL = 20 * 60
MAX_TTL = 120 * 60
event_hook = lambda kind: None


class Busy(Exception):
    pass


def now():
    return dt.datetime.now(dt.timezone.utc)


def owner_token(owner):
    if not re.fullmatch(r'[A-Za-z0-9._:-]{1,80}', owner):
        raise ValueError('owner must be 1-80 characters: letters, digits, . _ : -')
    return owner


def ttl_seconds(ttl):
    if isinstance(ttl, str):
        match = re.fullmatch(r'(\d+(?:\.\d+)?)([smh]?)', ttl)
        if not match:
            raise ValueError('ttl must be seconds or a duration such as 20m')
        ttl = float(match[1]) * {'': 1, 's': 1, 'm': 60, 'h': 3600}[match[2]]
    if not 0 < ttl <= MAX_TTL:
        raise ValueError('ttl must be positive and at most 120m')
    return float(ttl)


def hold_state():
    try:
        held = HOLD.read_text().strip()
        return True, bool(held) and os.environ.get('PHONE_HOLD_OWNER') == held
    except FileNotFoundError:
        return os.path.lexists(HOLD), False
    except (OSError, UnicodeError):
        # A disappeared hold is free; unreadable or partially written holds are busy.
        return os.path.lexists(HOLD), False


@contextlib.contextmanager
def metadata_lock():
    LOCK_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (LOCK_DIR / '.lease.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def read_lease():
    try:
        raw = LEASE.read_text()
    except FileNotFoundError:
        return None, None
    try:
        lease = json.loads(raw)
        owner_token(lease['owner'])
        acquired = dt.datetime.fromisoformat(lease['acquired_at'])
        expires = dt.datetime.fromisoformat(lease['expires_at'])
        if acquired.tzinfo is None or expires.tzinfo is None or expires <= acquired:
            raise ValueError()
        lease['purpose'] = safe_purpose(lease['purpose'])
        return lease, raw
    except (ValueError, TypeError, KeyError):
        raise Busy('lease metadata unavailable') from None


def safe_purpose(purpose):
    # Reuse the CLI sanitizer; importing it never connects to the device.
    from ph import diagnostic
    return diagnostic(str(purpose))[:80]


def live(lease):
    return bool(lease and dt.datetime.fromisoformat(lease['expires_at']) > now())


def lease_reason(lease):
    return f"leased by {lease['owner']} ({lease['purpose']}) until {lease['expires_at']}"


def write_temp(lease):
    fd, path = tempfile.mkstemp(prefix='.lease-', dir=LOCK_DIR)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(lease, out)
        return Path(path)
    except BaseException:
        os.unlink(path)
        raise


def replace_checked(lease, raw):
    path = write_temp(lease)
    try:
        if LEASE.read_text() != raw:
            raise Busy('lease changed; yield')
        os.replace(path, LEASE)
    finally:
        path.unlink(missing_ok=True)


def acquire(owner, purpose, ttl=DEFAULT_TTL):
    owner_token(owner)
    ttl = ttl_seconds(ttl)
    purpose = safe_purpose(purpose)
    expired = False
    with metadata_lock():
        if hold_state()[0]:
            raise Busy(HOLD_REASON)
        old, raw = read_lease()
        if live(old) and old['owner'] != owner:
            raise Busy(lease_reason(old))
        start = now()
        lease = dict(owner=owner, purpose=purpose, acquired_at=start.isoformat(),
                     expires_at=(start + dt.timedelta(seconds=ttl)).isoformat(), pid=os.getpid())
        if old:
            expired = not live(old)
            replace_checked(lease, raw)
        else:
            path = write_temp(lease)
            try:
                try:
                    os.link(path, LEASE)
                except FileExistsError:
                    raise Busy('lease changed; yield') from None
            finally:
                path.unlink(missing_ok=True)
    if expired:
        try: event_hook('lease_expired_takeover')
        except Exception: pass
    return lease


def refresh(owner):
    owner_token(owner)
    with metadata_lock():
        present, own = hold_state()
        if present and not own:
            raise Busy(HOLD_REASON)
        lease, raw = read_lease()
        if not lease or lease['owner'] != owner:
            raise Busy('lease is not yours')
        ttl = (dt.datetime.fromisoformat(lease['expires_at']) - dt.datetime.fromisoformat(lease['acquired_at'])).total_seconds()
        start = now()
        lease.update(acquired_at=start.isoformat(), expires_at=(start + dt.timedelta(seconds=ttl)).isoformat())
        replace_checked(lease, raw)
        return lease


def release(owner):
    owner_token(owner)
    with metadata_lock():
        lease, raw = read_lease()
        if not lease:
            return
        if lease['owner'] != owner:
            raise Busy('lease is not yours')
        if LEASE.read_text() != raw:
            raise Busy('lease changed; yield')
        LEASE.unlink()


def status():
    present, own_hold = hold_state()
    with metadata_lock():
        lease, _ = read_lease()
    seconds = max(0, (dt.datetime.fromisoformat(lease['expires_at']) - now()).total_seconds()) if lease else 0
    own = bool(lease and lease['owner'] in (os.environ.get('PH_LEASE_OWNER'), os.environ.get('PHONE_HOLD_OWNER')))
    return dict(hold_present=present, own_hold=own_hold, lease=lease, seconds_left=seconds,
                lease_owner=lease['owner'] if lease else 'none',
                lease_state=('own' if own else 'foreign') if seconds else 'none')


def check(action):
    present, own_hold = hold_state()
    if present:
        return (True, '') if own_hold else (False, HOLD_REASON)
    try:
        state = status()
    except (Busy, OSError, UnicodeError):
        return not action, 'lease metadata unavailable'
    present, own_hold = hold_state()
    if present:
        return (True, '') if own_hold else (False, HOLD_REASON)
    lease = state['lease']
    if state['lease_state'] == 'foreign':
        return not action, lease_reason(lease)
    if action and state['lease_state'] == 'own':
        ttl = (dt.datetime.fromisoformat(lease['expires_at']) - dt.datetime.fromisoformat(lease['acquired_at'])).total_seconds()
        if state['seconds_left'] < ttl / 2:
            try:
                refresh(lease['owner'])
            except (Busy, OSError):
                return False, 'lease changed; yield'
    # The hold may have been created while reading or refreshing the lease.
    present, own_hold = hold_state()
    return ((True, '') if own_hold else (False, HOLD_REASON)) if present else (True, '')
