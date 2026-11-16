"""Shared phone claims. Holds free themselves after holder exit or 30m without refresh.

Owned ph calls refresh holds at most once per minute; expired leases are free.

Lease holders refresh their TTL so a crashed background job cannot wedge the phone.
The metadata flock serializes compare/replace/unlink, not device operations.
"""
import contextlib
import datetime as dt
import fcntl
import json
import hashlib
import subprocess
import stat
import os
from pathlib import Path
import re
import tempfile
import uuid

LOCK_DIR = Path(os.environ.get('PH_LOCK_DIR', '~/.local/share/phone-lock')).expanduser()
HOLD = LOCK_DIR / 'priority-hold'
LEASE = LOCK_DIR / 'lease.json'
HOLD_LOST_REASON = 'priority hold expired; acquire it again before using the phone'
HOLD_REASON = 'owner request holds the phone; if it is yours, export PHONE_HOLD_OWNER=<your exact hold token>'
DEFAULT_TTL = 20 * 60
MAX_TTL = 120 * 60
HOLD_STALE_AFTER = 30 * 60
event_hook = lambda kind: None
_lost_holds = set()


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
    if not 1 <= ttl <= MAX_TTL:
        raise ValueError('ttl must be between 1s and 120m')
    return float(ttl)


def hold_stale_after():
    value = os.environ.get('PH_HOLD_STALE_AFTER', str(HOLD_STALE_AFTER))
    match = re.fullmatch(r'(\d+(?:\.\d+)?)([smh]?)', value)
    if not match:
        raise ValueError('invalid hold staleness')
    seconds = float(match[1]) * {'': 1, 's': 1, 'm': 60, 'h': 3600}[match[2]]
    if not 0 < seconds < float('inf'):
        raise ValueError('invalid hold staleness')
    return seconds


def token_sha(token):
    return hashlib.sha256(token.encode()).hexdigest()[:16]


def process_started(pid):
    try:
        result = subprocess.run(['ps', '-o', 'lstart=', '-p', str(pid)],
                                capture_output=True, text=True, timeout=1,
                                env={**os.environ, 'LC_ALL': 'C', 'TZ': 'UTC0'})
        if result.returncode == 1 and not result.stdout.strip():
            return False
        return result.stdout.rstrip('\n') if result.returncode == 0 and result.stdout.strip() else None
    except (OSError, subprocess.SubprocessError):
        return None


def process_alive(pid, started):
    """True for the same process, False for exit/reuse, None when unknown."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0 or not isinstance(started, str) or not started:
        return None
    current = process_started(pid)
    return None if current is None else current == started


def holder_metadata(token, holder_pid=None):
    # Detached lease runners supply their own PID; ordinary requests use ancestry.
    from ph import caller_chain, process_comm
    if holder_pid is None:
        agent = next((row for row in caller_chain() if row['comm'] in ('claude', 'codex', 'opencode')), {})
        pid = agent.get('pid') if agent.get('comm') in ('claude', 'codex') else None
        comm = agent.get('comm')
    else:
        if not isinstance(holder_pid, int) or isinstance(holder_pid, bool) or holder_pid <= 0:
            raise ValueError('invalid holder pid')
        pid, comm = holder_pid, process_comm(holder_pid)
    started = process_started(pid) if pid else None
    return dict(token_sha=token_sha(token), agent_pid=pid if started else None,
                agent_comm=comm, agent_started=started or None, recorded_at=now().isoformat())


def read_holder(token, snapshot=None, *, match_file=True):
    try:
        owner = json.loads(HOLD.with_name('priority-hold.owner.json').read_text())
        if isinstance(owner, dict) and owner.get('token_sha') == token_sha(token):
            if match_file:
                snapshot = snapshot or hold_snapshot()
                if (owner.get('hold_dev'), owner.get('hold_ino')) != (snapshot[0].st_dev, snapshot[0].st_ino):
                    return {}
            return owner
    except (OSError, UnicodeError, ValueError):
        pass
    return {}


def write_holder(token, holder_pid=None):
    snapshot = hold_snapshot()
    owner = holder_metadata(token, holder_pid)
    owner.update(hold_dev=snapshot[0].st_dev, hold_ino=snapshot[0].st_ino)
    path = write_temp(owner)
    try:
        if same_hold(snapshot, hold_snapshot()):
            os.replace(path, HOLD.with_name('priority-hold.owner.json'))
    finally:
        path.unlink(missing_ok=True)


def remove_holder(token):
    if read_holder(token, match_file=False):
        HOLD.with_name('priority-hold.owner.json').unlink(missing_ok=True)


def hold_snapshot(path=None):
    path = HOLD if path is None else path
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode):
        raise OSError('hold is not a regular file')
    contents = path.read_text()
    after = path.lstat()
    if (before.st_ino, before.st_mtime_ns) != (after.st_ino, after.st_mtime_ns):
        raise OSError('hold changed')
    return after, contents


def same_hold(left, right):
    return (left[0].st_ino, left[0].st_mtime_ns, left[1]) == (right[0].st_ino, right[0].st_mtime_ns, right[1])


def archive_hold(snapshot):
    name = 'priority-hold.stale-' + now().strftime('%Y%m%dT%H%M%SZ') + '-' + str(os.getpid())
    archived = LOCK_DIR / name
    # Several stale holds can be swept by one process in the same second.
    if os.path.lexists(archived):
        archived = LOCK_DIR / (name + '-' + uuid.uuid4().hex)
    os.rename(HOLD, archived)
    try:
        unchanged = same_hold(snapshot, hold_snapshot(archived))
    except (OSError, UnicodeError):
        unchanged = False
    if not unchanged:
        try:
            os.link(archived, HOLD)
        except FileExistsError:
            pass
        else:
            archived.unlink()
        return False
    remove_holder(snapshot[1].strip())
    return True


def _hold_status():
    state = dict(present=False, own_hold=False, age_s=None, stale_in_s=None,
                 holder_alive=None, agent_comm=None)
    try:
        snapshot = hold_snapshot()
        held = snapshot[1].strip()
        state['present'] = True
        age = max(0, now().timestamp() - snapshot[0].st_mtime)
        try:
            stale_after = hold_stale_after()
        except ValueError:
            stale_after = HOLD_STALE_AFTER
        state.update(age_s=age, stale_in_s=max(0, stale_after-age))
        owner = read_holder(held, snapshot)
        comm = owner.get('agent_comm')
        state['agent_comm'] = comm if isinstance(comm, str) and re.fullmatch(r'[A-Za-z0-9_.+-]{1,80}', comm) else None
        pid, started = owner.get('agent_pid'), owner.get('agent_started')
        state['holder_alive'] = process_alive(pid, started)
        reason = ('holder_exited' if state['holder_alive'] is False else
                  'not_refreshed' if age > stale_after else None)
        if reason:
            if archive_hold(snapshot):
                lost = bool(held) and os.environ.get('PHONE_HOLD_OWNER') == held
                if lost:
                    _lost_holds.add(token_sha(held))
                hold_archive_event(reason, age, state['agent_comm'], token_sha(held))
                state.update(present=os.path.lexists(HOLD), archived=reason, lost_hold=lost)
            # A replaced or refreshed hold is busy even when we restored it.
            return state
        state['own_hold'] = bool(held) and os.environ.get('PHONE_HOLD_OWNER') == held
        if state['own_hold']:
            if not same_hold(snapshot, hold_snapshot()):
                state['own_hold'] = False
                return state
            if not owner:
                try:
                    write_holder(held)
                except OSError:
                    pass
            if age >= 60:
                # Touch the opened inode, never a successor at the same pathname.
                with HOLD.open() as handle:
                    if same_hold(snapshot, (os.fstat(handle.fileno()), handle.read())):
                        os.utime(handle.fileno(), None)
                        state.update(age_s=0, stale_in_s=stale_after)
            current = hold_snapshot()
            if current[0].st_ino != snapshot[0].st_ino or current[1] != snapshot[1]:
                state['own_hold'] = False
    except (OSError, UnicodeError):
        state.update(present=os.path.lexists(HOLD), own_hold=False)
    return state


def hold_archive_event(reason, age_s, agent_comm, digest):
    from ph import event, caller_chain
    event('hold_archived', device=False, reason=reason, age_s=age_s,
          agent_comm=agent_comm, token_sha=digest, caller_chain=caller_chain())


def hold_status():
    try:
        with metadata_lock():
            return _hold_status()
    except OSError:
        return dict(present=os.path.lexists(HOLD), own_hold=False, age_s=None, stale_in_s=None,
                    holder_alive=None, agent_comm=None)


def hold_state():
    state = hold_status()
    return state['present'], state['own_hold']


def hold_acquire(token, *, holder_pid=None):
    if not token or token != token.strip():
        raise ValueError('hold token must be nonempty without surrounding whitespace')
    if holder_pid is not None and (not isinstance(holder_pid, int) or isinstance(holder_pid, bool) or holder_pid <= 0):
        raise ValueError('invalid holder pid')
    with metadata_lock():
        if _hold_status()['present']:
            raise Busy(HOLD_REASON)
        fd, name = tempfile.mkstemp(prefix='.hold-', dir=LOCK_DIR)
        path = Path(name)
        try:
            with os.fdopen(fd, 'w') as out:
                out.write(token)
                out.flush()
                os.fsync(out.fileno())
            try:
                os.link(path, HOLD)
            except FileExistsError:
                raise Busy(HOLD_REASON) from None
            try:
                write_holder(token, holder_pid)
            except OSError:
                pass
            _lost_holds.discard(token_sha(token))
        finally:
            path.unlink(missing_ok=True)


def hold_refresh():
    with metadata_lock():
        state = _hold_status()
        if not state['own_hold']:
            raise Busy(HOLD_LOST_REASON if not state['present'] else 'hold is not yours')
        snapshot = hold_snapshot()
        with HOLD.open() as handle:
            if not same_hold(snapshot, (os.fstat(handle.fileno()), handle.read())) or snapshot[1].strip() != os.environ.get('PHONE_HOLD_OWNER'):
                raise Busy('hold changed; yield')
            os.utime(handle.fileno(), None)


def hold_release(token=None):
    with metadata_lock():
        try:
            snapshot = hold_snapshot()
        except FileNotFoundError:
            return
        token = os.environ.get('PHONE_HOLD_OWNER') if token is None else token
        if not token or snapshot[1].strip() != token:
            raise Busy('hold is not yours')
        if not same_hold(snapshot, hold_snapshot()):
            raise Busy('hold changed; yield')
        HOLD.unlink()
        remove_holder(token)
        # A successor can take over immediately; never remove it during readback.
        try:
            hold_snapshot()
        except (OSError, UnicodeError):
            pass


@contextlib.contextmanager
def metadata_lock():
    LOCK_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (LOCK_DIR / '.lease.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def read_lease():
    try:
        raw = LEASE.read_bytes()
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
    except (ValueError, TypeError, KeyError, UnicodeError):
        # Even a damaged claim cannot be live beyond the maximum lease lifetime
        # after its last write. Recent corruption stays busy, never stolen.
        modified = dt.datetime.fromtimestamp(LEASE.stat().st_mtime, dt.timezone.utc)
        expires = modified + dt.timedelta(seconds=MAX_TTL)
        if expires <= now():
            return dict(owner='unknown', purpose='expired unreadable lease', acquired_at=modified.isoformat(),
                        expires_at=expires.isoformat(), pid=None, invalid=True), raw
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
            out.flush()
            os.fsync(out.fileno())
        return Path(path)
    except BaseException:
        os.unlink(path)
        raise


def replace_checked(lease, raw):
    path = write_temp(lease)
    try:
        if LEASE.read_bytes() != raw:
            raise Busy('lease changed; yield')
        os.replace(path, LEASE)
    finally:
        path.unlink(missing_ok=True)


def acquire(owner, purpose, ttl=DEFAULT_TTL, *, exclusive=False):
    owner_token(owner)
    ttl = ttl_seconds(ttl)
    purpose = safe_purpose(purpose)
    expired = False
    with metadata_lock():
        if _hold_status()['present']:
            raise Busy(HOLD_REASON)
        old, raw = read_lease()
        if live(old) and (exclusive or old['owner'] != owner):
            raise Busy(lease_reason(old))
        start = now()
        lease = dict(owner=owner, purpose=purpose, acquired_at=start.isoformat(),
                     expires_at=(start + dt.timedelta(seconds=ttl)).isoformat(), pid=os.getpid(),
                     lease_id=old.get("lease_id") if live(old) and old.get("lease_id") else uuid.uuid4().hex)
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


def refresh(owner, *, lease_id=None):
    owner_token(owner)
    with metadata_lock():
        state = _hold_status()
        present, own = state['present'], state['own_hold']
        if present and not own:
            raise Busy(HOLD_REASON)
        lease, raw = read_lease()
        if not lease or lease.get('invalid') or lease['owner'] != owner or (lease_id is not None and lease.get('lease_id') != lease_id):
            raise Busy('lease is not yours')
        ttl = (dt.datetime.fromisoformat(lease['expires_at']) - dt.datetime.fromisoformat(lease['acquired_at'])).total_seconds()
        start = now()
        lease.update(acquired_at=start.isoformat(), expires_at=(start + dt.timedelta(seconds=ttl)).isoformat())
        replace_checked(lease, raw)
        return lease


def release(owner, *, lease_id=None):
    owner_token(owner)
    with metadata_lock():
        lease, raw = read_lease()
        if not lease:
            return
        if lease.get('invalid') or lease['owner'] != owner or (lease_id is not None and lease.get('lease_id') != lease_id):
            raise Busy('lease is not yours')
        if LEASE.read_bytes() != raw:
            raise Busy('lease changed; yield')
        LEASE.unlink()


def status():
    hold = hold_status()
    present, own_hold = hold['present'], hold['own_hold']
    with metadata_lock():
        lease, _ = read_lease()
    seconds = max(0, (dt.datetime.fromisoformat(lease['expires_at']) - now()).total_seconds()) if lease else 0
    own = bool(lease and lease['owner'] in (os.environ.get('PH_LEASE_OWNER'), os.environ.get('PHONE_HOLD_OWNER')))
    return dict(hold_present=present, own_hold=own_hold, lease=lease, seconds_left=seconds,
                **({'archived': hold['archived']} if 'archived' in hold else {}),
                lost_hold=hold.get('lost_hold', False),
                lease_owner=lease['owner'] if lease else 'none',
                lease_state=('own' if own else 'foreign') if seconds else 'none')


def check(action):
    hold = hold_status()
    owner = os.environ.get('PHONE_HOLD_OWNER')
    if hold.get('lost_hold') or (owner and token_sha(owner) in _lost_holds and not hold['own_hold']):
        return False, HOLD_LOST_REASON
    present, own_hold = hold['present'], hold['own_hold']
    if present:
        return (True, '') if own_hold else (False, HOLD_REASON)
    try:
        state = status()
    except (Busy, OSError, UnicodeError):
        return not action, 'lease metadata unavailable'
    present, own_hold = hold_state()
    if present:
        return (True, '') if own_hold else (False, HOLD_REASON)
    if state.get('lost_hold'):
        return False, HOLD_LOST_REASON
    lease = state['lease']
    if state['lease_state'] == 'foreign':
        return not action, lease_reason(lease)
    if action and state['lease_state'] == 'own':
        ttl = (dt.datetime.fromisoformat(lease['expires_at']) - dt.datetime.fromisoformat(lease['acquired_at'])).total_seconds()
        if state['seconds_left'] < ttl / 2:
            try:
                refresh(lease['owner'], lease_id=lease.get('lease_id'))
            except (Busy, OSError):
                return False, 'lease changed; yield'
    # The hold may have been created while reading or refreshing the lease.
    present, own_hold = hold_state()
    return ((True, '') if own_hold else (False, HOLD_REASON)) if present else (True, '')
