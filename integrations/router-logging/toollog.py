"""Best-effort, metadata-only 9router logs. No caller text reaches a log line."""
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re
import atexit
import time
import signal
import threading
from urllib.parse import urlsplit
import volume

CAP = 200 * 1024 * 1024
_seen = set()
_last_report = time.monotonic()
PROPS = {'endpoint', 'model', 'size', 'count', 'status', 'enabled', 'locked', 'limited', 'reloginNeeded', 'state', 'action', 'tag', 'dryRun', 'complete', 'cost', 'hour', 'exitCode', 'attempt', 'source', 'failed', 'total', 'fourxx', 'fivexx', 'phase', 'durationMaxMs', 'omitted', 'provider', 'scope', 'cause', 'lockMs', 'until', 'previousBackoffLevel', 'backoffLevel', 'source'}
PROPS.update({'target', 'step', 'errno', 'syscall', 'attemptNo', 'firstTs', 'lastTs'})
CONNECTION_ERRNOS = {'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'}
SYSCALLS = {'connect', 'read', 'write', 'getaddrinfo', 'send', 'recv', 'shutdown'}
IDS = {'account', 'connection', 'thread', 'incident', 'request', 'session', 'writer'}
PROPS.update({'downSince', 'downMs', 'pid', 'ppid', 'initiator', 'stopReason', 'script', 'releaseDir',
              'startedAtMs', 'finishedAtMs', 'lastErrorCode', 'outcome', 'ownerPid', 'lockAgeMs'})
MESSAGES = {'Robob replica is stale; recovery deferred', 'Robob replica is not ready',
            'thread is newer than Robob replica; recovery deferred', 'unverified Robob replica',
            'The operation was aborted due to timeout', 'The operation was aborted'}

def directory():
    return Path(os.environ.get('ROUTER_LOG_DIR', str(Path.home() / '.robob/logs/tools/9router')))

def token(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_.:/-]{1,100}', value):
        return None
    if re.search(r'(?i)(sk-|bearer|password|secret|token|api.?key|otp|cookie|prompt|@)', value):
        return None
    return value

def safe_target(value):
    try:
        if not isinstance(value, str) or len(value) > 4096 or not re.match(r'(?i)^(?:https?|wss?)://', value) or re.search(r'[\s\\]', value):
            return None
        url = urlsplit(value)
        ports = {'http': 80, 'https': 443, 'ws': 80, 'wss': 443}
        if url.scheme not in ports or not url.hostname or len(url.hostname) > 253:
            return None
        host = url.hostname.encode('idna').decode('ascii')
        if not re.fullmatch(r'[a-zA-Z0-9._:-]+', host):
            return None
        if ':' in host:
            import ipaddress
            host = '[' + ipaddress.IPv6Address(host).compressed + ']'
        return f'{url.scheme}://{host}:{url.port if url.port is not None else ports[url.scheme]}'
    except (ValueError, UnicodeError):
        return None

def connection_prop(key, value):
    if key == 'step':
        return token(value)
    if key == 'target':
        return value if value in ('control', 'opencode') else safe_target(value)
    if key == 'errno':
        return value if isinstance(value, str) and value in CONNECTION_ERRNOS else None
    if key == 'syscall':
        return value if isinstance(value, str) and value in SYSCALLS else None
    if key == 'attemptNo':
        return value if type(value) is int and 0 < value <= 9007199254740991 else None
    if key in ('firstTs', 'lastTs'):
        if isinstance(value, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', value):
            try:
                dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
                return value
            except ValueError:
                pass
        return None
    return token(value) if isinstance(value, str) else value

def clean(event, now):
    name, component = token(event.get('name')), token(event.get('component'))
    if not name or not component or event.get('kind') not in ('event', 'perf', 'error'):
        return None
    row = dict(ts=now.isoformat(timespec='milliseconds').replace('+00:00', 'Z'), tool='9router', component=component, kind=event['kind'], name=name)
    ms = event.get('durationMs')
    if isinstance(ms, (float, int)) and math.isfinite(ms) and ms >= 0:
        row['durationMs'] = round(ms, 3)
    if isinstance(event.get('ok'), bool):
        row['ok'] = event['ok']
    ids = {k: hashlib.sha256(str(v).encode()).hexdigest()[:16] for k, v in event.get('ids', {}).items() if k in IDS and isinstance(v, (str, int))}
    props = {}
    for k, v in event.get('props', {}).items():
        if k not in PROPS:
            continue
        v = connection_prop(k, v)
        if v is not None and (isinstance(v, (str, bool)) or isinstance(v, (int, float)) and math.isfinite(v)):
            props[k] = v
    if name == 'log.volume':
        props.update(volume.clean_props(event.get('props', {})))
    if ids:
        row['ids'] = ids
    if props:
        row['props'] = props
    if event.get('error'):
        tag = token(event['error'].get('tag')) or 'unknown'
        message = event['error'].get('message')
        row['error'] = {'tag': tag, 'message': message[:300] if isinstance(message, str) and message in MESSAGES else tag}
    return row

def emit(component, name, kind='event', **fields):
    state = None
    try:
        now = dt.datetime.now(dt.timezone.utc)
        root = directory()
        day = now.date().isoformat()
        state = volume.state_for(root, day)
        row = clean(dict(component=component, name=name, kind=kind, **fields), now)
        if row is None:
            volume.dropped(state, 'invalid_event')
            return
        if len((json.dumps(row, separators=(',', ':')) + '\n').encode()) > 4096:
            volume.dropped(state, 'line_size')
            return
        _write(root, day, now, row, state)
        if time.monotonic() - _last_report >= volume.INTERVAL_SECONDS:
            report_volume(heartbeat=True)
    except Exception:
        if state is not None:
            volume.dropped(state, 'invalid_event')


def _write(root, day, now, row, state):
    is_volume = row['name'] == 'log.volume'
    try:
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(root, 0o700)
        key = (str(root), day)
        if key not in _seen:
            # Cross-process marker makes retention a once-a-day operation.
            try:
                fd = os.open(root / ('.retention-' + day), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(fd)
                cutoff = (now.date() - dt.timedelta(days=30)).isoformat()
                for p in root.iterdir():
                    m = re.fullmatch(r'(?:rollup-|\.cap-|\.retention-)?(\d{4}-\d{2}-\d{2})(?:\.ndjson|\.json)?', p.name)
                    if m and m[1] < cutoff:
                        p.unlink()
            except FileExistsError:
                pass
            _seen.add(key)
        fd = os.open(root / (day + '.ndjson'), os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
        try:
            os.fchmod(fd, 0o600)
            if os.fstat(fd).st_size >= CAP:
                try:
                    marker = os.open(root / ('.cap-' + day), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                    os.close(marker)
                    cap = clean(dict(component='logger', name='log.cap', kind='error', error={'tag': 'daily_cap'}), now)
                    os.write(fd, (json.dumps(cap, separators=(',', ':')) + '\n').encode())
                    volume.written(state, 'log.cap')
                except FileExistsError:
                    pass
                # Drop counters must remain visible after the daily cap.
                if row['kind'] != 'error' and row['component'] not in ('guard', 'supervisor') and not is_volume:
                    volume.dropped(state, 'daily_cap')
                    return False
            os.write(fd, (json.dumps(row, separators=(',', ':')) + '\n').encode())
            if not is_volume:
                volume.written(state, row['name'])
            return True
        finally:
            os.close(fd)
    except Exception:
        volume.write_error(state, not is_volume)
        return False


def report_volume(heartbeat=False):
    global _last_report
    _last_report = time.monotonic()
    for state in list(volume.STATES.values()):
        if state['version'] <= state['reported'] and not (heartbeat and state['day'] == dt.datetime.now(dt.timezone.utc).date().isoformat()):
            continue
        try:
            root, day = state['root'], state['day']
            if not root.is_dir():
                continue
            path = root / (day + '.ndjson')
            record = volume.snapshot(state, path.stat().st_size if path.exists() else 0)
            now = dt.datetime.combine(dt.date.fromisoformat(day), dt.datetime.now(dt.timezone.utc).timetz())
            row = clean(dict(component='logger', name='log.volume', kind='event', ids=record['ids'], props=record['props']), now)
            if _write(root, day, now, row, state):
                state['reported'] = record['version']
        except Exception:
            volume.write_error(state, False)


atexit.register(report_volume)

def _report_on_signal(signum, previous):
    def handle(received, frame):
        report_volume()
        if callable(previous):
            previous(received, frame)
        elif previous == signal.SIG_DFL:
            signal.signal(signum, signal.SIG_DFL)
            os.kill(os.getpid(), signum)
    return handle


if threading.current_thread() is threading.main_thread():
    for _signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(_signum, _report_on_signal(_signum, signal.getsignal(_signum)))
