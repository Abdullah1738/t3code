"""Best-effort, metadata-only 9router logs. No caller text reaches a log line."""
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re

CAP = 50 * 1024 * 1024
_seen = set()
PROPS = {'model', 'size', 'count', 'status', 'enabled', 'locked', 'limited', 'reloginNeeded', 'state', 'action', 'tag', 'dryRun', 'complete', 'cost', 'hour', 'exitCode', 'attempt', 'source', 'failed', 'total', 'fourxx', 'fivexx'}
IDS = {'account', 'connection', 'thread', 'incident', 'request', 'session'}

def directory():
    return Path(os.environ.get('ROUTER_LOG_DIR', str(Path.home() / '.robob/logs/tools/9router')))

def token(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_.:/-]{1,100}', value):
        return None
    if re.search(r'(?i)(sk-|bearer|password|secret|token|api.?key|otp|cookie|prompt|@)', value):
        return None
    return value

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
        if isinstance(v, str):
            v = token(v)
        if v is not None and (isinstance(v, (str, bool)) or isinstance(v, (int, float)) and math.isfinite(v)):
            props[k] = v
    if ids:
        row['ids'] = ids
    if props:
        row['props'] = props
    if event.get('error'):
        tag = token(event['error'].get('tag')) or 'unknown'
        row['error'] = {'tag': tag, 'message': tag}  # Never retain raw exceptions or provider text.
    return row

def emit(component, name, kind='event', **fields):
    try:
        now = dt.datetime.now(dt.timezone.utc)
        row = clean(dict(component=component, name=name, kind=kind, **fields), now)
        if row is None:
            return
        root = directory()
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(root, 0o700)
        day = now.date().isoformat()
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
                except FileExistsError:
                    pass
                if kind != 'error':
                    return
            os.write(fd, (json.dumps(row, separators=(',', ':')) + '\n').encode())
        finally:
            os.close(fd)
    except Exception:
        pass
