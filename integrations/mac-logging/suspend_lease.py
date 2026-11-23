#!/usr/bin/python3
"""Deadline-bound upkeep suspensions. Unowned stops are observations only."""
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jobs import state_path
from toollog import emit
from cpu_labels import command_label

DEFAULT_DEADLINE = '10m'  # Recommended explicit CLI value; omission is an error.
MAX_SECONDS = 3600
TIMEOUTS = {'ps': 8, 'launchctl_list': 5, 'owner_list': 3, 'procinfo': 2, 'notify': 5}


class CommandTimeout(subprocess.TimeoutExpired):
    def __init__(self, cmd, timeout, elapsed_ms, load_avg):
        super().__init__(cmd, timeout)
        self.fields = dict(cmd=cmd, timeoutS=timeout, elapsedMs=elapsed_ms, loadAvg1=load_avg)


class BudgetExceeded(BaseException):
    """Escape recovery loops too; the durable lease is retried next minute."""


PROTECTED = {
    'pids': (1,),
    'names': ('launchd', 'kernel_task', 'WindowServer', 'Robob', 'tailscaled', 'sshd',
              'claude', 'codex', 'opencode', 'gemini', 'cursor-agent', 'grok', 'antigravity'),
    'paths': ('/System/', '/usr/libexec/', '/usr/sbin/', '/sbin/'),
    'comm_fragments': ('cua-driver',),
    'providers': r'(?:^|[/@])(?:claude(?:-code)?|codex|opencode|gemini(?:-cli)?|cursor-agent|grok|antigravity)(?:$|[/.-])',
    'provider_executables': ('claude', 'codex', 'opencode', 'gemini', 'cursor-agent', 'grok', 'antigravity',
                             'codex-aarch64-apple-darwin', 'codex-x86_64-apple-darwin'),
    'provider_scripts': ('codex/bin/codex.js', 'opencode/bin/opencode',
                         '@anthropic-ai/claude-code/cli.js', '@google/gemini-cli/dist/index.js'),
    'servers': r'(?:^|/)(?:apps/server/(?:dist|src)/(?:bin\.mjs|index\.[cm]?[jt]s|bin\.ts)|t3code(?:/|$)|t3-code(?:/|$))',
    'interpreters': ('node', 'bun', 'npx', 'bash', 'zsh', 'sh', 'python', 'python3'),
    'server_runtime': '.robob/userdata/server-runtime.json',
    'guard_scripts': ('mac_guard.py', 'suspend_lease.py'),
    'service_labels': ('com.abdullah.', 'com.ardud.', 'local.ardud.'),
    'robob_app': '/Applications/Robob.app/',
}


def duration(value):
    match = re.fullmatch(r'([1-9][0-9]*)(s|m|h)', value or '')
    if not match:
        raise ValueError('deadline required: use 10m (positive seconds, minutes or hours)')
    seconds = int(match[1]) * {'s': 1, 'm': 60, 'h': 3600}[match[2]]
    if seconds > MAX_SECONDS:
        raise ValueError('deadline exceeds the 60m cap')
    return seconds


def protected(p):
    name = Path(p['comm']).name
    if (p.get('robobServer') or p['pid'] in PROTECTED['pids'] or p['pid'] == os.getpid()
            or name in PROTECTED['names'] or p['comm'].startswith(PROTECTED['paths'])
            or any(fragment in p['comm'] for fragment in PROTECTED['comm_fragments'])
            or '.app/' in p['comm']):
        return True
    try:
        words = shlex.split(p['command'])
    except ValueError:
        return True
    if any(re.search(PROTECTED['servers'], word) for word in words):
        return True
    if any(Path(word).name in PROTECTED['guard_scripts'] for word in words):
        return True
    if name in PROTECTED['interpreters'] or re.fullmatch(r'python3\.\d+', name):
        if len(words) < 2 or any(w in ('-c', '-e', '--eval', '--prompt', '-p') for w in words):
            return True
        return any(re.search(PROTECTED['providers'], word, re.I) for word in words)
    return bool(re.search(PROTECTED['providers'], p['comm'], re.I))


def identity(p):
    return '%s:%s' % (p['pid'], p['start'])


def redacted_record(record):
    result = dict(record)
    for key in ('command', 'comm', 'owner'):
        if isinstance(result.get(key), str):
            result[key] = command_label(result[key]) or '[redacted]'
    return result


def redact_state(state):
    changed = False
    for entries in (state['leases'], state['unowned']):
        for record in entries.values():
            clean = redacted_record(record)
            if record != clean:
                record.update(clean)
                changed = True
    return changed


def provider_process(p):
    # This recognition grants an exception, unlike the broad refusal rules.
    # Unknown versions/layouts stay within the protected app ancestry.
    if Path(p['comm']).name in PROTECTED['provider_executables']:
        return True
    words = shlex.split(p['command'])
    # Only the interpreter's script position identifies a provider. Later
    # arguments can be labels or prompt text supplied to an unrelated program.
    return (Path(p['comm']).name in PROTECTED['interpreters'] and len(words) > 1
            and not words[1].startswith('-')
            and any(words[1] == suffix or words[1].endswith('/'+suffix)
                    for suffix in PROTECTED['provider_scripts']))


def parse_stopped(raw):
    result = []
    for line in raw.splitlines():
        parts = line.split(None, 7)
        if len(parts) == 8 and parts[0].isdigit() and parts[1].startswith('T'):
            result.append(dict(pid=int(parts[0]), stat=parts[1], start=' '.join(parts[2:7]), command=parts[7]))
    return result


class Host:
    def __init__(self, run=subprocess.run):
        self.run = run
        self.labels = None

    def call(self, argv, cmd, timeout, **kwargs):
        started = time.monotonic()
        try:
            return self.run(argv, timeout=timeout, **kwargs)
        except subprocess.TimeoutExpired:
            elapsed_ms = (time.monotonic()-started)*1000
            raise CommandTimeout(cmd, timeout, elapsed_ms, os.getloadavg()[0]) from None

    def ps(self, args):
        r = self.call(['/bin/ps', '-ww']+args, 'ps '+args[0], TIMEOUTS['ps'], capture_output=True, text=True,
                     env={**os.environ, 'LC_ALL': 'C'})
        if r.returncode == 1 and not r.stdout.strip() and not r.stderr.strip():
            return ''
        if r.returncode:
            raise OSError('ps failed')
        return r.stdout.strip()

    def process(self, pid):
        raw = self.ps(['-p', str(pid), '-o', 'pid=,ppid=,stat=,lstart=,comm='])
        if not raw:
            return None
        parts = raw.split(None, 8)
        if len(parts) != 9 or not parts[0].isdigit() or not parts[1].isdigit():
            raise ValueError('invalid ps identity')
        start = ' '.join(parts[3:8])
        args = self.ps(['-p', str(pid), '-o', 'lstart=,command=']).split(None, 5)
        if len(args) != 6 or ' '.join(args[:5]) != start:
            raise OSError('identity changed during ps')
        p = dict(pid=int(parts[0]), ppid=int(parts[1]), stat=parts[2], start=start,
                 comm=parts[8], command=args[5])
        try:
            with (Path.home()/PROTECTED['server_runtime']).open() as stream:
                runtime = json.loads(stream.read(65536))
            if isinstance(runtime, dict) and runtime.get('pid') == p['pid']:
                p['robobServer'] = True
        except (OSError, ValueError):
            pass
        return p

    def stopped(self):
        args = ['-axo', 'pid=,stat=,lstart=,command=']
        try:
            raw = self.ps(args)
        except subprocess.TimeoutExpired:
            raw = self.ps(args)
        return parse_stopped(raw)

    def protected(self, p):
        if protected(p):
            return True
        r = self.call(['/bin/launchctl', 'list'], 'launchctl list', TIMEOUTS['launchctl_list'],
                      capture_output=True, text=True)
        if r.returncode:
            raise OSError('launchd protection lookup unavailable')
        services = {int(f[0]) for line in r.stdout.splitlines()
                    if len(f := line.split()) == 3 and f[0].isdigit()
                    and f[2].startswith(PROTECTED['service_labels'])}
        seen = set()
        while p and p['pid'] not in seen:
            seen.add(p['pid'])
            if p['pid'] in services:
                return True
            if p.get('robobServer') or p['comm'].startswith(PROTECTED['robob_app']):
                return True
            if p['ppid'] == 1:
                return False
            parent = self.process(p['ppid'])
            if parent is None:
                raise OSError('parent protection lookup changed')
            p = parent
            if len(seen) >= 32:
                raise OSError('parent protection chain too deep')
        raise OSError('parent protection chain incomplete')

    def owner(self, p):
        if self.labels is None:
            self.labels = {}
            try:
                r = self.call(['/bin/launchctl', 'list'], 'launchctl list', TIMEOUTS['owner_list'],
                              capture_output=True, text=True)
                for line in r.stdout.splitlines() if r.returncode == 0 else []:
                    fields = line.split()
                    if len(fields) == 3 and fields[0].isdigit():
                        self.labels[int(fields[0])] = fields[2]
            except (OSError, subprocess.TimeoutExpired):
                pass
        if p['pid'] in self.labels:
            return self.labels[p['pid']]
        # procinfo can require root; a bounded best-effort lookup must not sudo.
        try:
            r = self.call(['/bin/launchctl', 'procinfo', str(p['pid'])], 'launchctl procinfo',
                          TIMEOUTS['procinfo'], capture_output=True, text=True)
            match = re.search(r'(?m)^\s*(?:label|service|job)\s*(?:=|:)\s*([\w.-]+)', r.stdout)
            if r.returncode == 0 and match:
                return match[1]
        except (OSError, subprocess.TimeoutExpired):
            pass
        try:
            words = shlex.split(p['command'])
            # For interpreter jobs the script is more useful than python's path.
            return next((w for w in words[1:] if w.startswith('/') and not w.startswith('-')), words[0])
        except (ValueError, IndexError):
            return 'unknown'

    def signal(self, pid, sig):
        os.kill(pid, sig)

    def sleep(self, seconds):
        time.sleep(seconds)

    def notify(self, key, text):
        env = dict(os.environ)
        env.pop('BUN_INSPECT', None)
        r = self.call([str(Path.home()/'.bun/bin/bun'),
                      str(Path.home()/'.local/share/telegram-bridge/src/cli.ts'), 'notify',
                      '--source', 'Mac Upkeep', '--severity', 'attention', '--key', key,
                      '--text', text], 'bun cli.ts', TIMEOUTS['notify'], capture_output=True, env=env)
        return r.returncode == 0


class SuspendLease:
    def __init__(self, path=None, host=None, clock=time.time, logger=emit):
        self.path = Path(path) if path else state_path('suspend-lease')
        self.host = host or Host()
        self.clock = clock
        self.logger = logger

    @contextmanager
    def locked(self):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.path.with_suffix('.lock').open('a') as lock:
            os.chmod(lock.name, 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                state = json.loads(self.path.read_text())
            except FileNotFoundError:
                state = dict(version=1, leases={}, unowned={}, alerts={})
            # Corrupt state is an error, never permission to signal a PID anew.
            if (not isinstance(state, dict) or state.get('version') != 1
                    or any(not isinstance(state.get(k), dict) for k in ('leases', 'unowned', 'alerts'))):
                raise ValueError('invalid suspend ledger')
            # Older ledgers may contain raw argv. Scrub before listing, logging
            # or recovery can expose them, including read-only list commands.
            if redact_state(state):
                self.save(state)
            yield state

    def save(self, state):
        redact_state(state)
        fd, tmp = tempfile.mkstemp(prefix='.suspend-', dir=self.path.parent)
        try:
            with os.fdopen(fd, 'w') as stream:
                os.fchmod(stream.fileno(), 0o600)
                json.dump(state, stream, allow_nan=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(tmp, self.path)
            directory = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def log(self, name, lease=None, ok=True, **props):
        self.logger('suspend', 'event' if ok else 'error', 'suspend.'+name,
                    ok=ok, props=redacted_record({**(lease or {}), **props}),
                    error_tag=None if ok else 'suspend.'+name)

    def log_timeout(self, exc, lease=None):
        if isinstance(exc, CommandTimeout):
            self.log('error', lease, ok=False, result='TimeoutExpired', **exc.fields)

    def current(self, lease):
        p = self.host.process(lease['pid'])
        return p if p and p['start'] == lease['start'] else None

    def send(self, lease, sig, reads):
        p = self.current(lease)
        if not p:
            return None
        if getattr(self.host, 'protected', protected)(p):
            raise ValueError('protected process')
        # Protection can walk ancestors and contact launchd. Recheck the target
        # after that work so a reused PID or exec cannot inherit authorization.
        confirmed = self.current(lease)
        if not confirmed:
            return None
        if any(confirmed[k] != p[k] for k in ('comm', 'command')):
            raise ValueError('process changed during protection lookup')
        if sig == signal.SIGSTOP and confirmed['stat'].startswith('T'):
            raise ValueError('process already stopped; cannot adopt an unowned stop')
        try:
            self.host.signal(p['pid'], sig)
        except OSError as exc:
            # Even a refused signal gets a read-back, without hiding its errno.
            receipt = dict(signal=signal.Signals(sig).name, stat='unknown', sent=False)
            reads.append(receipt)
            after = self.current(lease)
            receipt['stat'] = after['stat'] if after else 'gone'
            if not isinstance(exc, ProcessLookupError):
                raise
            return after
        # A failed read stays explicit; callers retain the lease for recovery.
        receipt = dict(signal=signal.Signals(sig).name, stat='unknown', sent=True)
        reads.append(receipt)
        after = self.current(lease)
        receipt['stat'] = after['stat'] if after else 'gone'
        return after

    def settle(self, lease, stopped, reads):
        # SIGCONT and SIGSTOP may be pending at the first ps read.
        for _ in range(10):
            p = self.current(lease)
            if reads:
                reads[-1]['stat'] = p['stat'] if p else 'gone'
            if not p or p['stat'].startswith('T') == stopped:
                return p
            self.host.sleep(.05)
        return p

    def stop(self, pid, deadline, then, reason, actor, card=None, expected_start=None):
        seconds = duration(deadline)
        if type(pid) is not int or pid <= 0 or then not in ('cont', 'kill') or not reason.strip() or not actor.strip():
            raise ValueError('pid, then, reason and actor required')
        with self.locked() as state:
            p = self.host.process(pid)
            if not p or (expected_start is not None and p['start'] != expected_start):
                raise ValueError('process gone or birth changed')
            if getattr(self.host, 'protected', protected)(p):
                raise ValueError('protected process')
            fresh = self.current(p)
            if not fresh or any(fresh[k] != p[k] for k in ('comm', 'command')):
                raise ValueError('process changed during protection lookup')
            p = fresh
            if p['stat'].startswith('T') or str(pid) in state['leases']:
                raise ValueError('process already stopped or leased')
            now = self.clock()
            lease = redacted_record(dict(p, createdAt=now, deadline=now+seconds, then=then,
                                         reason=reason, actor=actor, card=card))
            state['leases'][str(pid)] = lease
            self.save(state)
            reads = []
            try:
                self.send(lease, signal.SIGSTOP, reads)
                after = self.settle(lease, True, reads)
                if not after or not after['stat'].startswith('T'):
                    raise RuntimeError('SIGSTOP read-back failed')
            except Exception as exc:
                self.log_timeout(exc, lease)
                sent_stop = any(r['signal'] == 'SIGSTOP' and r['sent'] for r in reads)
                recovered = not sent_stop
                if sent_stop:
                    try:
                        self.send(lease, signal.SIGCONT, reads)
                        after = self.settle(lease, False, reads)
                        recovered = not after or not after['stat'].startswith('T')
                    except Exception as recovery_exc:
                        self.log_timeout(recovery_exc, lease)
                if recovered:
                    state['leases'].pop(str(pid), None)
                    self.save(state)
                self.log('stop_failed', lease, ok=False, readBack=reads, recovered=recovered)
                raise RuntimeError('SIGSTOP failed; recovery recorded') from None
            self.log('stop', lease, readBack=reads, stat=after['stat'])
            return lease

    def alert(self, state, lease, problem):
        key = identity(lease)
        entry = state['alerts'].setdefault(key, dict(sent=False, text=
            'mac-suspend: pid %s (%s), started %s: %s. Inspect the suspend ledger; unowned stops are never signalled.' %
            (lease['pid'], lease.get('owner', lease.get('comm', 'unknown')), lease['start'], problem)))
        self.save(state)  # Retry ambiguous deliveries with exactly the same text.
        if not entry['sent']:
            try:
                entry['sent'] = bool(self.host.notify('mac-suspend:'+key, entry['text']))
            except Exception as exc:
                self.log_timeout(exc, lease)
                entry['sent'] = False
            self.save(state)
            self.log('alert', lease, ok=entry['sent'])

    def finish(self, state, lease, action):
        reads, ok, result = [], False, 'failed'
        if action == 'kill':
            lease['phase'] = 'killing'
            self.save(state)
        try:
            p = self.current(lease)
            if not p:
                ok, result = True, 'stale'
            elif action == 'resume':
                self.send(lease, signal.SIGCONT, reads)
                after = self.settle(lease, False, reads)
                ok = not after or not after['stat'].startswith('T')
                result = 'resumed' if ok else 'still_stopped'
            else:
                after = self.send(lease, signal.SIGTERM, reads)
                if after:
                    self.host.sleep(5)
                    after = self.current(lease)
                    reads[-1]['stat'] = after['stat'] if after else 'gone'
                if after:
                    self.send(lease, signal.SIGKILL, reads)
                    # Allow the kernel to retire the process; zombies hold no locks.
                    for _ in range(10):
                        after = self.current(lease)
                        reads[-1]['stat'] = after['stat'] if after else 'gone'
                        if not after or after['stat'].startswith('Z'):
                            break
                        self.host.sleep(.05)
                ok = not after or after['stat'].startswith('Z')
                result = 'gone' if ok else 'still_alive'
        except Exception as exc:
            self.log_timeout(exc, lease)
            result = 'read_or_signal_failed'
        if ok:
            state['leases'].pop(str(lease['pid']), None)
        self.save(state)
        self.log(action, lease, ok=ok, readBack=reads, result=result)
        if not ok and action == 'kill':
            self.alert(state, lease, 'leased kill failed its read-back')
        return dict(pid=lease['pid'], start=lease['start'], action=action, ok=ok, result=result, readBack=reads)

    def release(self, pid, action):
        if action not in ('resume', 'kill'):
            raise ValueError('invalid action')
        with self.locked() as state:
            lease = state['leases'].get(str(pid))
            if not lease:
                raise ValueError('no owned lease for pid; unowned processes are never signalled')
            return self.finish(state, lease, action)

    def listing(self):
        with self.locked() as state:
            return [dict(p, timeLeftS=max(0, p['deadline']-self.clock()))
                    for p in state['leases'].values() if self.current(p)]

    def sweep(self):
        with self.locked() as state:
            actions, now = [], self.clock()
            for lease in list(state['leases'].values()):
                try:
                    p = self.current(lease)
                except Exception as exc:
                    if isinstance(exc, CommandTimeout):
                        self.log_timeout(exc, lease)
                    else:
                        self.log('error', lease, ok=False, result='identity_unavailable')
                    continue
                if not p or (not p['stat'].startswith('T') and lease.get('phase') != 'killing'):
                    state['leases'].pop(str(lease['pid']))
                    self.save(state)
                    self.log('cleared', lease, result='stale' if not p else 'not_stopped')
                elif lease['deadline'] <= now or lease.get('phase') == 'killing':
                    self.log('expired', lease)
                    action = 'kill' if lease.get('phase') == 'killing' or lease['then'] == 'kill' else 'resume'
                    actions.append(self.finish(state, lease, action))
            unowned = {}
            for p in self.host.stopped():
                key = identity(p)
                lease = state['leases'].get(str(p['pid']))
                if lease and lease['start'] == p['start']:
                    continue
                entry = state['unowned'].get(key)
                if entry is None:
                    entry = redacted_record(dict(p, firstSeen=now, owner=self.host.owner(p), overdue=False))
                    unowned[key] = entry
                    state['unowned'][key] = entry
                    self.save(state)
                    self.log('orphan', entry, ageS=0, phase='first_seen')
                unowned[key] = entry
                if now-entry['firstSeen'] >= 600:
                    if not entry['overdue']:
                        entry['overdue'] = True
                        self.save(state)
                        self.log('orphan', entry, ageS=now-entry['firstSeen'], phase='overdue')
                    self.alert(state, entry, 'unowned stopped process observed for at least 10 minutes')
            state['unowned'] = unowned
            self.save(state)
            self.log('sweep', count=len(state['leases']), unownedCount=len(unowned))
            return dict(leases=list(state['leases'].values()), unowned=list(unowned.values()), actions=actions)


def main(argv=None, service=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    stop = commands.add_parser('stop')
    stop.add_argument('--pid', type=int, required=True)
    stop.add_argument('--deadline', required=True, help='recommended: 10m; maximum: 60m')
    stop.add_argument('--then', choices=('cont', 'kill'), required=True)
    stop.add_argument('--reason', required=True)
    stop.add_argument('--actor', required=True)
    stop.add_argument('--card')
    for name in ('resume', 'kill'):
        commands.add_parser(name).add_argument('--pid', type=int, required=True)
    for name in ('list', 'sweep'):
        commands.add_parser(name).add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    service = service or SuspendLease()
    try:
        if args.command == 'stop':
            result = service.stop(args.pid, args.deadline, args.then, args.reason, args.actor, args.card)
        elif args.command in ('resume', 'kill'):
            result = service.release(args.pid, args.command)
        elif args.command == 'list':
            result = service.listing()
        else:
            result = service.sweep()
        if getattr(args, 'json', False) or args.command not in ('list', 'sweep'):
            print(json.dumps(result, indent=2))
        elif args.command == 'list':
            for lease in result:
                print('%s %s %.0fs left -> %s (%s)' % (lease['pid'], lease['start'], lease['timeLeftS'], lease['then'], lease['actor']))
        else:
            print('%d leases; %d unowned stops; %d expired actions' %
                  (len(result['leases']), len(result['unowned']), len(result['actions'])))
        return 1 if isinstance(result, dict) and (result.get('ok') is False or any(not a['ok'] for a in result.get('actions', []))) else 0
    except (Exception, BudgetExceeded) as exc:
        service.log('error', ok=False,
                    result='TimeoutExpired' if isinstance(exc, subprocess.TimeoutExpired) else type(exc).__name__,
                    **(exc.fields if isinstance(exc, CommandTimeout) else {}))
        print('mac-suspend: '+str(exc), file=sys.stderr)
        return 1


if __name__ == '__main__':
    def timeout(signum, frame):
        raise BudgetExceeded('mac-suspend exceeded 50s budget')
    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(50)
    sys.exit(main())
