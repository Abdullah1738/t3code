#!/usr/bin/python3
"""Folder budgets reuse inventory; only the daily pass may measure extra paths."""
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import time
from types import SimpleNamespace

import jobs
from toollog import emit

CONFIG = Path(__file__).with_name('disk-budgets.json')
GB = 1024**3


def load_budgets(config=CONFIG):
    rows = json.loads(Path(config).read_text())
    if not isinstance(rows, list):
        raise ValueError('disk budgets must be a list')
    result, seen = [], set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != {'path', 'owner_board', 'budget_gb', 'note'}:
            raise ValueError('invalid disk budget fields')
        path, owner, limit = row['path'], row['owner_board'], row['budget_gb']
        if (not isinstance(path, str) or not path.startswith(('/', '~/'))
                or any(c in path for c in ('\n', '\r', '\x00'))
                or '..' in Path(path).parts or not isinstance(owner, str)
                or not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', owner)
                or not jobs.number(limit) or limit <= 0 or not isinstance(row['note'], str)):
            raise ValueError('invalid disk budget value')
        # Keep lexical paths: resolving would follow userdata onto the SSD.
        path = str(Path(os.path.expanduser(path)))
        if path in seen:
            raise ValueError('duplicate disk budget path')
        seen.add(path)
        result.append(dict(row, path=path))
    return result


def path_status(path, deadline):
    try:
        for part in reversed((path, *path.parents)):
            info = jobs.deadline_call(deadline, part.lstat)
            if stat.S_ISLNK(info.st_mode):
                return 'symlink'
        return 'present'
    except FileNotFoundError as exc:
        # An absent ancestor implies an absent target, but the target's
        # backing volume must still be mounted before reporting zero bytes.
        missing = FileNotFoundError(exc.errno, exc.strerror, str(path))
        return 'missing' if jobs.confirmed_absent(path, missing) else 'unavailable'
    except (OSError, jobs.SourceFailure):
        return 'unavailable'


def cached_value(value, now, root=None):
    if (not isinstance(value, dict) or not jobs.number(value.get('bytes'))
            or not jobs.number(value.get('at')) or value['at'] > now
            or value.get('partial') is not False or value.get('limited')):
        return None
    return dict(bytes=value['bytes'], at=value['at'],
                fresh=not jobs.inventory_needs_measurement(value, now, root=root))


def inventory_size(path, inventory, now):
    if inventory.get('duMode') != 'links':
        return None
    roots = inventory.get('childState', {})
    if not isinstance(roots, dict):
        return None
    key = str(path)
    if key in roots:
        cache = roots[key]
        # Root totals may be lower bounds. An incomplete listing or child
        # cannot silently become an under-budget observation.
        if (not isinstance(cache, dict) or key in inventory.get('partials', {})
                or key not in inventory.get('sizes', {})):
            return None
        excluded = str(Path.home()/'.robob/userdata')
        values = [cached_value(v, now, path) for p, v in cache.items() if p != excluded]
        if any(v is None for v in values):
            return None
        at = min((v['at'] for v in values), default=inventory.get('at'))
        if not jobs.number(at) or at > now:
            return None
        return dict(bytes=sum(v['bytes'] for v in values), at=at,
                    fresh=all(v['fresh'] for v in values) and now-at < jobs.INVENTORY_FRESH_S)
    pending = [(root, cache) for root, cache in roots.items() if isinstance(cache, dict)]
    while pending:
        root, cache = pending.pop()
        if key in cache:
            return cached_value(cache[key], now, root)
        for child, value in cache.items():
            if (isinstance(value, dict) and isinstance(value.get('parts'), dict)
                    and path.is_relative_to(child)):
                pending.append((child, value['parts']))
    return None


def deep_refresh(budgets, inventory, run, deadline, stopped=lambda: False):
    """Called while the daily pass holds inventory_lock and its wall budget."""
    state = jobs.read_state('disk-budget-deep')
    cache = state.get('children', {}) if state.get('duMode') == 'links' else {}
    cache = cache if isinstance(cache, dict) else {}
    for row in budgets:
        if stopped() or time.monotonic() >= deadline:
            break
        path = Path(row['path'])
        # Existing roots and their immediate children belong to the shared
        # scanner. Nested targets reuse parts when available, otherwise deep
        # owns just that exact folder (never another hourly root).
        roots = inventory.get('childState', {})
        if (str(path) in roots or str(path.parent) in roots
                or inventory_size(path, inventory, time.time()) is not None):
            continue
        stop = min(deadline, time.monotonic()+jobs.DEEP_CHILD_CAP_S)
        status = path_status(path, min(stop, time.monotonic()+2))
        if status != 'present':
            cache.pop(str(path), None)
            continue
        entry = SimpleNamespace(path=str(path), is_dir=lambda follow_symlinks=False, p=path:
                                stat.S_ISDIR(p.lstat().st_mode))
        one = {str(path): cache[str(path)]} if str(path) in cache else {}

        def checkpoint(*_):
            cache.update(one)
            jobs.save_state('disk-budget-deep', dict(duMode='links', children=cache))

        attempted, parts, singles, retries = set(), {}, set(), set()
        # A daily pass can finish a little earlier than yesterday. Refresh
        # ordinary totals that will expire before this pass's deadline.
        due_at = time.time()+max(0, deadline-time.monotonic())
        while (not stopped() and time.monotonic() < stop and str(path) not in attempted
               and jobs.inventory_due(one.get(str(path)), time.time(), due_at, root=path.parent)):
            jobs.big_root_inventory(path.parent, run, stop, one, ([entry], True),
                                    deep=True, checkpoint=checkpoint, due_at=due_at,
                                    attempted=attempted, part_work=parts, single_paths=singles,
                                    probe_retries=retries)
        checkpoint()
    jobs.save_state('disk-budget-deep', dict(duMode='links', children=cache))


def sample(budgets=None, now=None):
    now = dt.datetime.now(dt.timezone.utc) if now is None else now.astimezone(dt.timezone.utc)
    timestamp, hour = now.timestamp(), int(now.timestamp()//3600)
    budgets = load_budgets() if budgets is None else budgets
    inventory = jobs.read_state('disk-inventory')
    deep = jobs.read_state('disk-budget-deep')
    deadline = time.monotonic()+5
    with jobs.state_path('disk-budget').with_suffix('.lock').open('a') as lock:
        os.chmod(lock.name, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        state = jobs.read_state('disk-budget')
        for row in budgets:
            path, limit = Path(row['path']), row['budget_gb']
            previous = state.get(str(path), {})
            if previous.get('hour') != hour:
                status = path_status(path, min(deadline, time.monotonic()+1))
                value = None
                source = 'inventory'
                if status == 'missing':
                    value = dict(bytes=0, at=timestamp, fresh=True)
                elif status in ('present', 'unavailable'):
                    value = inventory_size(path, inventory, timestamp)
                    if value is None and deep.get('duMode') == 'links':
                        value = cached_value(deep.get('children', {}).get(str(path)), timestamp)
                        source = 'deep'
                    if value is None:
                        value = cached_value(previous.get('lastSize'), timestamp)
                        if value is not None:
                            value['fresh'] = False
                if value is None or not value['fresh'] or status == 'unavailable':
                    source = 'stale'
                size = value['bytes']/GB if value else None
                props = dict(path=str(path), owner=row['owner_board'], sizeGb=size, budgetGb=limit,
                             overBy=max(0, size-limit) if size is not None else None,
                             sizeAgeS=max(0, timestamp-value['at']) if value else None,
                             source=source, status=status if status != 'present' else
                             'ok' if source != 'stale' else 'unmeasured' if value is None else 'stale')
                streak = previous.get('streak', 0) if previous.get('hour') == hour-1 else 0
                streak = streak+1 if source != 'stale' and size is not None and size > limit else 0
                if not emit('disk', 'event', 'disk.budget', now=now, props=props):
                    continue
                previous = dict(previous, hour=hour, streak=streak, props=props)
                if value is not None and source != 'stale':
                    previous['lastSize'] = dict(bytes=value['bytes'], at=value['at'], partial=False)
                state[str(path)] = previous
                jobs.save_state('disk-budget', state)
            if previous.get('streak', 0) >= 3 and previous.get('overDay') != now.date().isoformat():
                if emit('disk', 'event', 'disk.budget.over', now=now, props=previous['props']):
                    previous['overDay'] = now.date().isoformat()
                    jobs.save_state('disk-budget', state)
