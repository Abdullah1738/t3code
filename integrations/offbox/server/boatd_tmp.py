"""Per-instance scratch disks. The legacy profile remains unchanged for existing boxes."""
from __future__ import annotations

import json
import os
from pathlib import Path
import posixpath
import re
import subprocess
import threading

TMPFS = 'lxc.mount.entry = tmpfs tmp tmpfs rw,nosuid,nodev,mode=1777,size=8G,create=dir 0 0'
DEVICE = 'offbox-tmp'
LABEL = 'user.offbox.scratch'
OWNER = 'user.offbox.scratch-owner'
MANAGED = 'org.offbox:managed'
BOX = 'org.offbox:box'
ZOWNER = 'org.offbox:owner'
VERSION = 'scratch-v1'
ROOT = Path('/var/lib/offbox-scratch')
_locks: dict[str, threading.RLock] = {}
_guard = threading.Lock()


def lock(box):
    with _guard:
        return _locks.setdefault(box, threading.RLock())


def without_tmpfs(raw):
    lines = []
    for line in raw.splitlines():
        if line == TMPFS:
            continue
        match = re.match(r'\s*lxc\.mount\.entry\s*=\s*(.*)', line)
        if match:
            fields = match[1].split()
            target = posixpath.normpath('/' + fields[1].lstrip('/')) if len(fields) > 1 else ''
            if target == '/tmp' or target.startswith('/tmp/'):
                raise RuntimeError('foreign raw.lxc mount at /tmp; refusing scratch disk')
        lines.append(line)
    # A nonempty local value overrides the inherited profile value in Incus.
    return '\n'.join(lines + ['# offbox scratch disk v1'])


class Scratch:
    def __init__(self, cfg, incus):
        self.cfg, self.incus = cfg, incus

    def identity(self, box):
        if not re.fullmatch(r'bx_[a-z0-9]{8}', box):
            raise RuntimeError('invalid scratch box identity')
        instance = box.replace('_', '-')
        return instance, f"{self.cfg['zpool']}/scratch/{instance}", ROOT / instance

    def query(self, instance):
        p = self.incus('query', f'/1.0/instances/{instance}', timeout=30)
        return json.loads(p.stdout or b'{}')

    @staticmethod
    def zfs(*args):
        p = subprocess.run(['zfs', *args], capture_output=True, text=True, timeout=120)
        if p.returncode:
            raise RuntimeError(f"zfs {args[0]} failed: {p.stderr[-300:]}")
        return p.stdout

    def properties(self, dataset):
        keys = [MANAGED, BOX, ZOWNER, 'mountpoint', 'normalization', 'utf8only', 'refquota', 'reservation']
        out = self.zfs('get', '-Hp', '-o', 'property,value', ','.join(keys), dataset)
        return dict(line.split('\t', 1) for line in out.splitlines())

    def prepare_parent(self):
        dataset = f"{self.cfg['zpool']}/scratch"
        p = subprocess.run(['zfs', 'list', '-H', '-o', 'name', dataset], capture_output=True, timeout=30)
        if p.returncode:
            self.zfs('create', '-o', f'mountpoint={ROOT}', '-o', 'normalization=none', '-o', 'utf8only=on',
                     '-o', 'setuid=off', '-o', 'devices=off', '-o', 'exec=on',
                     '-o', f'{MANAGED}=scratch-parent-v1', dataset)
        props = self.properties(dataset)
        if any(props.get(k) != v for k, v in {MANAGED: 'scratch-parent-v1', 'mountpoint': str(ROOT),
                                             'normalization': 'none', 'utf8only': 'on'}.items()):
            raise RuntimeError('foreign scratch parent; refusing to adopt it')

    def validate(self, box, owner):
        _, dataset, mount = self.identity(box)
        props = self.properties(dataset)
        expected = {MANAGED: VERSION, BOX: box, ZOWNER: owner, 'mountpoint': str(mount),
                    'normalization': 'none', 'utf8only': 'on', 'refquota': str(64 * 1024**3), 'reservation': '0'}
        if not owner or any(props.get(k) != v for k, v in expected.items()):
            raise RuntimeError(f'scratch identity/properties mismatch: {dataset}')
        if mount.resolve() != mount or not mount.is_dir():
            raise RuntimeError(f'noncanonical scratch mountpoint: {mount}')
        # Never chmod or snapshot a bare directory left behind by an unmounted dataset.
        p = subprocess.run(['findmnt', '-rn', '-M', str(mount), '-o', 'SOURCE,FSTYPE'],
                           capture_output=True, text=True, timeout=30)
        if p.returncode or p.stdout.split() != [dataset, 'zfs']:
            raise RuntimeError(f'scratch dataset not mounted: {dataset}')
        return dataset, mount

    @staticmethod
    def stopped(info):
        if info.get('status', '').lower() != 'stopped':
            raise RuntimeError('scratch mutation requires a confirmed stopped instance')

    def detach_copy(self, instance):
        """Saved bases contain rootfs state only, never references to another box's scratch."""
        info = self.query(instance)
        self.stopped(info)
        config = info.get('config', {})
        devices = info.get('devices', {})
        if LABEL not in config:
            if DEVICE in devices:
                raise RuntimeError('unlabelled scratch device in copy')
            return
        device = devices.get(DEVICE, {})
        source_box = config[LABEL].rsplit('/', 1)[-1].replace('-', '_')
        _, source_dataset, source_mount = self.identity(source_box)
        expected = {'type': 'disk', 'source': str(source_mount), 'path': '/tmp', 'shift': 'true',
                    'raw.mount.options': 'nosuid,nodev'}
        if config[LABEL] != source_dataset or not config.get(OWNER) or device != expected:
            raise RuntimeError('scratch copy device mismatch')
        self.incus('config', 'device', 'remove', instance, DEVICE)
        self.incus('config', 'unset', instance, LABEL)
        self.incus('config', 'unset', instance, OWNER)

    def create(self, box, owner):
        instance, dataset, mount = self.identity(box)
        with lock(box):
            self.detach_copy(instance)
            if not self.cfg.get('scratch_disk', True):
                # A cloned disk instance locally suppressed the legacy profile entry.
                info = self.query(instance)
                raw = info.get('expanded_config', info.get('config', {})).get('raw.lxc', '')
                if TMPFS not in raw.splitlines():
                    self.incus('config', 'set', instance, f'raw.lxc={raw}\n{TMPFS}')
                return
            info = self.query(instance)
            self.stopped(info)
            raw = without_tmpfs(info.get('expanded_config', info.get('config', {})).get('raw.lxc', ''))
            for dev in info.get('expanded_devices', info.get('devices', {})).values():
                path = posixpath.normpath('/' + dev.get('path', '').lstrip('/'))
                if path == '/tmp' or path.startswith('/tmp/'):
                    raise RuntimeError('foreign Incus device at /tmp; refusing scratch disk')
            self.zfs('create', '-o', f'mountpoint={mount}', '-o', 'normalization=none', '-o', 'utf8only=on',
                     '-o', 'refquota=64G', '-o', 'reservation=0', '-o', f'{MANAGED}={VERSION}',
                     '-o', f'{BOX}={box}', '-o', f'{ZOWNER}={owner}', dataset)
            self.validate(box, owner)
            os.chmod(mount, 0o1777)
            self.zfs('snapshot', dataset + '@empty')
            self.incus('config', 'set', instance, f'{LABEL}={dataset}', f'{OWNER}={owner}', f'raw.lxc={raw}')
            self.attach(instance, mount)

    def attach(self, instance, mount):
        self.incus('config', 'device', 'add', instance, DEVICE, 'disk', f'source={mount}', 'path=/tmp',
                   'shift=true', 'raw.mount.options=nosuid,nodev')

    def start(self, box):
        instance, dataset, mount = self.identity(box)
        with lock(box):
            info = self.query(instance)
            if info.get('status', '').lower() == 'running':
                return
            config = info.get('config', {})
            if LABEL in config:
                self.stopped(info)
                if config[LABEL] != dataset:
                    raise RuntimeError('scratch instance label mismatch')
                self.validate(box, config.get(OWNER))
                device = info.get('devices', {}).get(DEVICE)
                expected = {'type': 'disk', 'source': str(mount), 'path': '/tmp', 'shift': 'true',
                            'raw.mount.options': 'nosuid,nodev'}
                if device != expected:
                    raise RuntimeError('scratch instance device mismatch')
                self.zfs('rollback', dataset + '@empty')
            elif DEVICE in info.get('expanded_devices', info.get('devices', {})):
                raise RuntimeError('unlabelled scratch device')
            self.incus('start', instance, timeout=300)

    def delete(self, box, owner):
        """Called only after Incus confirmed deletion; safe to retry after a partial create/delete."""
        _, dataset, mount = self.identity(box)
        with lock(box):
            p = subprocess.run(['zfs', 'list', '-H', '-o', 'name', dataset],
                               capture_output=True, text=True, timeout=30)
            if p.returncode:
                # Absence must be confirmed by listing the parent (not a failed ZFS query).
                children = self.zfs('list', '-H', '-o', 'name', '-r', f"{self.cfg['zpool']}/scratch").splitlines()
                if dataset in children:
                    raise RuntimeError('scratch dataset lookup failed')
                return
            self.validate(box, owner)
            instances = json.loads(self.incus('query', '/1.0/instances?recursion=1', timeout=60).stdout)
            for info in instances:
                if info.get('name') == box.replace('_', '-'):
                    raise RuntimeError('scratch instance still exists')
                for dev in info.get('expanded_devices', info.get('devices', {})).values():
                    if dev.get('source') in (str(mount), dataset):
                        raise RuntimeError('scratch backing still referenced by an instance')
            snapshots = self.zfs('list', '-H', '-t', 'snapshot', '-o', 'name', '-r', dataset).splitlines()
            if any(s != dataset + '@empty' for s in snapshots):
                raise RuntimeError('unexpected scratch snapshots; refusing deletion')
            if snapshots:
                self.zfs('destroy', dataset + '@empty')
            self.zfs('destroy', dataset)

    def verify(self, box):
        instance, dataset, _ = self.identity(box)
        info = self.query(instance)
        if LABEL not in info.get('config', {}):
            return
        out = self.incus('exec', instance, '--', 'findmnt', '-rn', '-M', '/tmp',
                         '-o', 'SOURCE,FSTYPE,OPTIONS', timeout=30).stdout.decode().split()
        if len(out) != 3 or out[:2] != [dataset, 'zfs'] or not {'rw', 'nosuid', 'nodev'} <= set(out[2].split(',')) \
                or 'noexec' in out[2].split(','):
            raise RuntimeError('scratch /tmp did not mount as executable nosuid,nodev ZFS')
        mode = self.incus('exec', instance, '--', 'stat', '-c', '%a', '/tmp', timeout=30).stdout.strip()
        if mode != b'1777':
            raise RuntimeError('scratch /tmp is not mode 1777')

    def chown(self, box, old_owner, new_owner):
        instance, dataset, _ = self.identity(box)
        with lock(box):
            config = self.query(instance).get('config', {})
            if LABEL not in config:
                return
            if config[LABEL] != dataset or config.get(OWNER) != old_owner:
                raise RuntimeError('scratch owner label mismatch')
            self.validate(box, old_owner)
            self.zfs('set', f'{ZOWNER}={new_owner}', dataset)
            try:
                self.incus('config', 'set', instance, f'{OWNER}={new_owner}')
            except Exception:
                self.zfs('set', f'{ZOWNER}={old_owner}', dataset)
                raise
