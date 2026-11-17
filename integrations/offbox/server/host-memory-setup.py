#!/usr/bin/env python3
"""Configure aggregate payload memory without restarting services or containers."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import boatd_memory as memory

GIB = 1024**3
SERVICES = ('incus.service', 'boatd.service', 'ssh.service', 'tailscaled.service')
DROPIN = '90-offbox-memory.conf'


class Host:
    def __init__(self, root=Path('/'), command=None):
        self.root = root
        self.command = command or self.run

    @staticmethod
    def run(args):
        p = subprocess.run(args, capture_output=True, text=True, timeout=120)
        if p.returncode:
            raise RuntimeError(f'{args[0]} {args[1]}: {p.stderr[-300:]}')
        return p.stdout

    def path(self, name):
        return self.root / name.lstrip('/')

    def read(self, name):
        try:
            return self.path(name).read_text()
        except FileNotFoundError:
            return None

    def write(self, name, text, mode=0o644):
        path = self.path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as f:
            temporary = Path(f.name)
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        temporary.chmod(mode)
        temporary.replace(path)

    def inspect(self, hard=None, high=None):
        if 'memory' not in (self.read('/sys/fs/cgroup/cgroup.controllers') or '').split():
            raise ValueError('cgroup v2 memory controller required')
        info = memory.meminfo(self.path('/proc/meminfo'))
        ceiling = self.read('/sys/module/zfs/parameters/zfs_arc_max')
        # A zero module parameter means auto-sized; get the actual ARC ceiling rather than assuming zero.
        if ceiling is None or int(ceiling) == 0:
            arc = dict((line.split()[0], line.split()[2]) for line in
                       (self.read('/proc/spl/kstat/zfs/arcstats') or '').splitlines()[2:] if len(line.split()) == 3)
            ceiling = arc.get('c_max')
        if ceiling is None:
            raise ValueError('ARC ceiling unavailable; cannot derive the host budget')
        budget = ((info['MemTotal'] - int(ceiling) - 20*GIB) // GIB) * GIB
        hard = budget if hard is None else hard
        high = hard - 8*GIB if high is None else high
        if not 0 < high < hard <= budget:
            raise ValueError('require 0 < high < hard <= RAM - ARC ceiling - 20 GiB host reserve')
        profile = json.loads(self.command(['incus', 'query', '/1.0/profiles/offbox']))
        instances = json.loads(self.command(['incus', 'query', '/1.0/instances?recursion=1']))
        # raw.lxc on a local instance overrides the whole profile value (not an additive merge).
        targets = [('profile', 'offbox', profile.get('config', {}).get('raw.lxc', ''))]
        for instance in instances:
            if not re.fullmatch(r'(?:bx-[a-z0-9]{8}|sv-[a-f0-9]{12})', instance['name']):
                continue
            raw = instance.get('config', {}).get('raw.lxc')
            if raw is not None:
                targets.append(('config', instance['name'], raw))
        desired = {f'/etc/systemd/system/{memory.PARENT}':
                   '[Unit]\nDescription=Offbox payload memory budget\n\n[Slice]\nMemoryAccounting=yes\n'
                   f'MemoryHigh={high}\nMemoryMax={hard}\nMemorySwapMax=0\n'}
        for service in SERVICES:
            desired[f'/etc/systemd/system/{service}.d/{DROPIN}'] = (
                '[Unit]\nRequires=offbox.slice\nAfter=offbox.slice\n\n[Service]\n'
                'OOMScoreAdjust=-900\nMemoryMin=134217728\n')
        changes = [dict(kind='file', path=path, content=text) for path, text in desired.items()
                   if self.read(path) != text]
        for kind, name, raw in targets:
            value = memory.placement(raw)
            if value != raw:
                changes.append(dict(kind=kind, name=name, value=value, before=raw))
        cg = self.path('/sys/fs/cgroup')
        legacy = sorted(p.name for p in cg.glob('lxc.payload.*'))
        current = int(self.read(f'/sys/fs/cgroup/{memory.PARENT}/memory.current') or '0')
        if current >= high and self.read(f'/sys/fs/cgroup/{memory.PARENT}/memory.high') != str(high)+'\n':
            legacy.append('payload usage is at or above proposed memory.high; drain before lowering')
        if current >= hard and self.read(f'/sys/fs/cgroup/{memory.PARENT}/memory.max') != str(hard)+'\n':
            legacy.append('payload usage is at or above proposed memory.max; drain before lowering')
        drift = []
        for key, wanted in [('memory.max', hard), ('memory.high', high), ('memory.swap.max', 0)]:
            if self.read(f'/sys/fs/cgroup/{memory.PARENT}/{key}') != str(wanted)+'\n':
                drift.append(key)
        for service in SERVICES:
            state = dict(line.split('=', 1) for line in self.command([
                'systemctl', 'show', service, '-p', 'MainPID', '-p', 'ControlGroup', '-p', 'MemoryMin']).splitlines() if '=' in line)
            group = state.get('ControlGroup', '')
            pid = int(state.get('MainPID', '0'))
            if group == '/offbox.slice' or group.startswith('/offbox.slice/') or (pid and not group):
                raise ValueError(f'{service}: control plane must be outside offbox.slice')
            if state.get('MemoryMin') != '134217728':
                drift.append(service+':MemoryMin')
            if pid == 1 or (pid > 1 and self.read(f'/proc/{pid}/oom_score_adj') != '-900\n'):
                drift.append(service+':OOMScoreAdjust')
        return dict(hard=hard, high=high, arc_ceiling=int(ceiling), host_reserve=20*GIB,
                    changes=changes, legacy_payloads=legacy, runtime_drift=drift)

    def apply(self, plan):
        with memory.lifecycle_lock(self.path('/var/lib/boatd'), exclusive=True):
            fresh = self.inspect(plan['hard'], plan['high'])
            if not (fresh['changes'] or fresh['runtime_drift'] or fresh['legacy_payloads']):
                return
            self.require_drained(fresh)
            self.apply_drained(fresh)

    def require_drained(self, plan):
        # Moving tasks would leave their existing charged pages behind; do not pretend live migration caps them.
        if plan['legacy_payloads']:
            raise ValueError('drain and stop legacy payloads before apply: '+', '.join(plan['legacy_payloads']))
        if self.command(['systemctl','show','boatd.service','--value','-p','MainPID']).strip() != '0':
            raise ValueError('stop boatd in the drained maintenance window before apply')
        if list(self.path('/sys/fs/cgroup').glob('**/lxc.payload.*')):
            raise ValueError('drain and stop all payloads before apply')

    def apply_drained(self, plan):
        backup = '/var/lib/boatd/host-memory-before.json'
        if self.read(backup) is None:
            saved = []
            for change in plan['changes']:
                if change['kind'] == 'file':
                    saved.append(dict(kind='file', path=change['path'], before=self.read(change['path'])))
                else:
                    saved.append(change)
            services = {}
            for service in SERVICES:
                raw = self.command(['systemctl','show',service,'-p','MainPID','-p','ControlGroup','-p','MemoryMin'])
                state = dict(line.split('=',1) for line in raw.splitlines() if '=' in line)
                services[service] = dict(memory_min=state['MemoryMin'],
                    oom_score_adj=self.read('/proc/'+state['MainPID']+'/oom_score_adj'))
            parent = {key:self.read(f'/sys/fs/cgroup/{memory.PARENT}/{key}')
                      for key in ('memory.max','memory.high','memory.swap.max')}
            self.write(backup, json.dumps(dict(changes=saved, services=services, parent=parent), indent=2)+'\n', mode=0o600)
        for change in plan['changes']:
            if change['kind'] == 'file':
                self.write(change['path'], change['content'])
            else:
                prefix = ['incus', 'profile', 'set'] if change['kind'] == 'profile' else ['incus', 'config', 'set']
                self.command([*prefix, change['name'], 'raw.lxc='+change['value']])
        if plan['changes']:
            self.command(['systemctl', 'daemon-reload'])
        self.command(['systemctl', 'start', memory.PARENT])
        # Refresh after config writes/reload too; another operator may not honor boatd's lifecycle fence.
        self.require_drained(self.inspect(plan['hard'], plan['high']))
        self.command(['systemctl', 'set-property', '--runtime', memory.PARENT,
                      'MemoryMax='+str(plan['hard']), 'MemoryHigh='+str(plan['high']), 'MemorySwapMax=0'])
        # set-property updates resource controls without restarting a service. OOMScoreAdjust also needs
        # the existing main process updated; its persistent Service setting covers future starts.
        for service in SERVICES:
            self.command(['systemctl', 'set-property', '--runtime', service, 'MemoryMin=134217728'])
            pid = int(self.command(['systemctl', 'show', service, '--value', '-p', 'MainPID']).strip())
            if pid == 1:
                raise ValueError(service+': invalid main process')
            if pid > 1:
                self.path(f'/proc/{pid}/oom_score_adj').write_text('-900\n')


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument('--dry-run', action='store_true')
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--apply', action='store_true')
    p.add_argument('--hard-gib', type=int)
    p.add_argument('--high-gib', type=int)
    args = p.parse_args(argv)
    host = Host()
    try:
        plan = host.inspect(args.hard_gib*GIB if args.hard_gib else None, args.high_gib*GIB if args.high_gib else None)
        print(json.dumps(plan, indent=2))
        if args.apply:
            host.apply(plan)
            plan = host.inspect(plan['hard'], plan['high'])
        if args.check or args.apply:
            return int(bool(plan['changes'] or plan['legacy_payloads'] or plan['runtime_drift']))
        return 0
    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(str(error))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
