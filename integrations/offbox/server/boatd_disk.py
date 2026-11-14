"""Disk measurements and snapshot selection; no Incus or SQLite mutations here."""
from __future__ import annotations

import os
import subprocess
import time

GIB = 1024 ** 3
# On 14 Nov a 1.7 TiB pool lost ~40 GB/h, with ~200 GB pinned per repository box.
# 20% warns hours before exhaustion; 10% stops growth above ZFS's ~3% slop.
# Cleanup aims for 25% to avoid churning at the warning threshold.
WARN = .20
HARD = .10
TARGET = .25
KEEP_AUTO = 3
SNAPSHOT_RATIO = .50


def command(args):
    p = subprocess.run(args, capture_output=True, text=True, timeout=10)
    if p.returncode:
        raise OSError(p.stderr.strip()[-200:])
    return p.stdout


def filesystem(path):
    st = os.statvfs(path)
    return {"filesystem": str(path), "free_bytes": st.f_bavail * st.f_frsize,
            "total_bytes": st.f_blocks * st.f_frsize, "free_inodes": st.f_favail,
            "total_inodes": st.f_files}


def level(row, pool=False):
    free, total = row['free_bytes'], row['total_bytes']
    fraction = free / total if total else 0
    inode_fraction = row.get('free_inodes', 0) / row['total_inodes'] if row.get('total_inodes') else 1
    hard = max(256 * 1024 ** 2, total * HARD) if pool else 256 * 1024 ** 2
    warn = max(GIB, total * WARN) if pool else GIB
    if free < hard or inode_fraction < .01:
        return 'full'
    if free < warn or inode_fraction < .05:
        return 'low'
    return 'ok'


def sample(pool, state_path, incus_path='/var/lib/incus', log_path='/var/log'):
    rows, errors = [], []
    try:
        size, raw_free = map(int, command(['zpool', 'list', '-Hp', '-o', 'size,free', pool]).split())
        # Raw zpool FREE includes slop and cannot be used as allocatable capacity.
        avail = int(command(['zfs', 'get', '-Hp', '-o', 'value', 'available', pool]).strip())
        rows.append({'filesystem': pool, 'free_bytes': avail, 'total_bytes': size, 'raw_free_bytes': raw_free})
    except (OSError, ValueError, subprocess.SubprocessError) as e:
        errors.append(f'{pool}: {e}')
    for path in dict.fromkeys((str(state_path), incus_path, log_path)):
        try:
            rows.append(filesystem(path))
        except OSError as e:
            errors.append(f'{path}: {e}')
    for row in rows:
        row['free_pct'] = round(100 * row['free_bytes'] / row['total_bytes'], 2) if row['total_bytes'] else 0
        row['level'] = level(row, row['filesystem'] == pool)
    full = [r for r in rows if r['level'] == 'full']
    low = [r for r in rows if r['level'] == 'low']
    return {'sampled_at': time.time(), 'level': 'full' if full else 'unknown' if errors else 'low' if low else 'ok',
            'disk_full': bool(full), 'disk_low': bool(full or low), 'filesystems': rows, 'errors': errors}


def inventory(dataset):
    """One traversal gives per-box live/snapshot bytes and actual snapshot identities."""
    boxes, snaps = {}, []
    for line in command(['zfs', 'list', '-Hp', '-o', 'name,usedbysnapshots,referenced', '-r', dataset]).splitlines():
        name, used, live = line.split('\t')
        if name.startswith(dataset + '/containers/bx-') and '/' not in name[len(dataset + '/containers/'):]:
            bid = name.rsplit('/', 1)[1].replace('bx-', 'bx_', 1)
            boxes[bid] = {'snapshot_bytes': int(used), 'live_bytes': int(live)}
    for line in command(['zfs', 'list', '-Hp', '-t', 'snapshot', '-o', 'name,used,creation,clones', '-r', dataset]).splitlines():
        name, used, created, clones = line.split('\t')
        ds, _, suffix = name.partition('@snapshot-')
        if not suffix or not ds.startswith(dataset + '/containers/bx-'):
            continue
        bid = ds.rsplit('/', 1)[1].replace('bx-', 'bx_', 1)
        snaps.append({'box': bid, 'dataset': name, 'name': suffix, 'kind': suffix.split('-', 1)[0],
                      'bytes': int(used), 'created_at': int(created), 'clones': clones != '-'})
    return boxes, snaps


def candidates(snaps, protected, keep=KEEP_AUTO):
    """Only older auto snapshots, globally oldest first. Clone origins always survive."""
    newest = {}
    for row in sorted(snaps, key=lambda r: (r['created_at'], r['name']), reverse=True):
        if row['kind'] == 'auto':
            newest.setdefault(row['box'], []).append(row['name'])
    keepers = {(bid, name) for bid, names in newest.items() for name in names[:keep]}
    return sorted((r for r in snaps if r['kind'] == 'auto' and r['box'] not in protected and not r['clones']
                   and (r['box'], r['name']) not in keepers), key=lambda r: (r['created_at'], r['name']))


def description(data):
    rows = data.get('filesystems') or []
    bad = next((r for r in rows if r['level'] == 'full'), None) or next((r for r in rows if r['level'] == 'low'), None)
    return f"{bad['filesystem']} {bad['free_bytes'] / GIB:.1f} GiB free" if bad else 'disk measurement unavailable'
