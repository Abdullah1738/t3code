"""Host memory inputs and shared payload placement, independent of Incus transport."""
from pathlib import Path
from contextlib import contextmanager
import fcntl

PARENT = 'offbox.slice'
CGROUP_LINE = 'lxc.cgroup.dir = ' + PARENT


@contextmanager
def lifecycle_lock(directory, *, exclusive=False):
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / 'memory-lifecycle.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
        yield


def meminfo(path=Path('/proc/meminfo')):
    values = {}
    for line in path.read_text().splitlines():
        key, value, *unit = line.split()
        values[key.rstrip(':')] = int(value) * (1024 if unit == ['kB'] else 1)
    return values


def payload_path(root, instance):
    nested = root / PARENT / ('lxc.payload.' + instance)
    return nested if nested.exists() else root / ('lxc.payload.' + instance)


def anon_bytes(path):
    try:
        return dict(line.split() for line in (path / 'memory.stat').read_text().splitlines()).get('anon')
    except OSError:
        return None


def payload_capacity(root, promised):
    parent = root / PARENT
    if not parent.exists():
        return {}
    current = int((parent / 'memory.current').read_text())
    stats = dict(line.split() for line in (parent / 'memory.stat').read_text().splitlines())
    # Only clean, unmapped non-shmem cache on the file LRU is credited. A new allocation can reclaim it
    # at memory.high; otherwise an idle box with a warm file cache could never admit work again.
    reclaimable = max(0, min(int(stats.get('inactive_file', 0)) + int(stats.get('active_file', 0)),
                             max(0, int(stats.get('file', 0)) - int(stats.get('shmem', 0)))) -
                      sum(int(stats.get(k, 0)) for k in ('file_dirty','file_writeback','file_mapped')))
    reclaimable = min(current, reclaimable)
    limits = {}
    for key in ('high', 'max'):
        value = (parent / ('memory.' + key)).read_text().strip()
        limits[key] = None if value == 'max' else int(value)
    ceilings = [v for v in limits.values() if v is not None]
    return dict(payload_current=current, payload_high=limits['high'], payload_max=limits['max'],
                payload_reclaimable=reclaimable,
                payload_free=min(ceilings) - current + reclaimable - promised if ceilings else None)


def capacity(info, available, reserve, promised, payload=None):
    # Shmem has no reclaim path without swap. Do not credit it against a running command's future anon growth.
    committed = sum(info.get(k, 0) for k in ('AnonPages', 'Shmem', 'SUnreclaim', 'PageTables', 'KernelStack'))
    budget = info.get('MemTotal', 0) - committed - reserve - promised
    free = min(available - reserve - promised, budget)
    payload = payload or {}
    if payload.get('payload_free') is not None:
        free = min(free, payload['payload_free'])
    return dict(mem_available=available, shmem=info.get('Shmem', 0), committed_bytes=committed,
                committed_as=info.get('Committed_AS', 0), admitted_bytes=promised, reserve=reserve,
                free_bytes=free, **payload)


def placement(raw):
    lines = raw.splitlines()
    for line in lines:
        key, sep, value = line.partition('=')
        if key.strip().startswith('lxc.cgroup.dir') or key.strip() == 'lxc.cgroup.relative':
            if key.strip() != 'lxc.cgroup.dir' or not sep or value.strip() != PARENT:
                raise ValueError('foreign cgroup placement; reconcile before applying memory setup')
    if not any(line.partition('=')[0].strip() == 'lxc.cgroup.dir' for line in lines):
        lines.append(CGROUP_LINE)
    return '\n'.join(lines)
