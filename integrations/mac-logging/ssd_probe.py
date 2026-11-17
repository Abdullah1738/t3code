#!/usr/bin/python3
"""Bounded launchd SSD read detection; state and child output stay on the Mac."""
import ctypes as c
import datetime as dt
import errno
import fcntl
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import tempfile
import time

from collector import notify
from process_argv import BsdInfo
from toollog import emit, private_dir

PROBE = Path('/Volumes/ExternalSSD/.mac-upkeep/probe.bin')
DEADLINE_S = 3
# The gate lets the parent persist PID + lstart before any SSD syscall. Each
# stage flushes separately so a stuck read still leaves its completed stat time.
READER = '''import errno,json,os,sys,time
if sys.stdin.buffer.read(1) != b"1":
    sys.exit(1)
for stage in ("statMs", "readMs"):
    started = time.monotonic()
    try:
        if stage == "statMs":
            os.stat(sys.argv[1])
        else:
            with open(sys.argv[1], "rb", buffering=0) as stream:
                if len(stream.read(4096)) != 4096:
                    raise OSError(errno.EIO, "short probe read")
        print(json.dumps({stage: (time.monotonic()-started)*1000}), flush=True)
    except OSError as exc:
        print(json.dumps({"errno": errno.errorcode.get(exc.errno, "EIO")}), flush=True)
        sys.exit(1)
'''


def atomic_json(path, value):
    fd, tmp = tempfile.mkstemp(prefix='.ssd-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def load(path):
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except FileNotFoundError:
        return {}


def alive(pid):
    if type(pid) is not int or not 0 < pid < 2**31:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def poll_until(child, deadline):
    while child.poll() is None:
        remaining = deadline-time.monotonic()
        if remaining <= 0:
            return False
        time.sleep(min(.01, remaining))
    return True


def birth_identity(pid):
    # Query the process table directly so identifying a stuck ps never needs
    # another ps. Darwin's BSD info contains an exact kernel birth timestamp.
    try:
        if sys.platform == 'darwin':
            lib = c.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
            lib.proc_pidinfo.argtypes = (c.c_int, c.c_int, c.c_uint64, c.c_void_p, c.c_int)
            lib.proc_pidinfo.restype = c.c_int
            info = BsdInfo()
            if lib.proc_pidinfo(pid, 3, 0, c.byref(info), c.sizeof(info)) == c.sizeof(info) and info.pid == pid:
                return [info.startS, info.startUs]
        elif sys.platform == 'linux':
            # Offbox tests use the same PID-reuse invariant with Linux's birth
            # ticks and boot identity; neither path touches a monitored volume.
            fields = Path('/proc/%s/stat' % pid).read_text().rsplit(')', 1)[1].split()
            return [Path('/proc/sys/kernel/random/boot_id').read_text().strip(), int(fields[19])]
    except (OSError, ValueError, IndexError):
        pass
    return None


def helper_active(state):
    prior = state.get('identityChild')
    if not prior or not alive(prior['pid']):
        return False
    current = birth_identity(prior['pid'])
    return not prior.get('birth') or current is None or current == prior['birth']


def identity(pid, root, state, save, deadline):
    # Even the metadata helper is abandoned without wait/communicate. If ps
    # itself stalls, retain it and suppress further helpers until it is gone.
    if helper_active(state):
        return None
    output = root/'ssd-identity.out'
    with output.open('wb') as stream:
        child = subprocess.Popen(['/bin/ps', '-p', str(pid), '-o', 'lstart='],
            stdout=stream, stderr=subprocess.DEVNULL,
            env={**os.environ, 'LC_ALL': 'C'})
    state['identityChild'] = dict(pid=child.pid, birth=birth_identity(child.pid))
    save()
    if not poll_until(child, min(deadline, time.monotonic()+.5)):
        return None
    state.pop('identityChild', None)
    save()
    start = output.read_text().strip() if child.returncode == 0 else ''
    return start if re.fullmatch(r'[A-Z][a-z]{2} [A-Z][a-z]{2} +[0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}', start) else ''


def probe(root, state, save, path=PROBE, timeout=DEADLINE_S, reader=None):
    result = dict(statMs=None, readMs=None, outcome='timeout', errno='ETIMEDOUT', stuckPrior=False)
    deadline = time.monotonic()+timeout
    prior = state.get('child')
    if helper_active(state):
        result['stuckPrior'] = True
        return result
    if prior and alive(prior.get('pid')):
        start = identity(prior['pid'], root, state, save, deadline)
        # Unknown identity is fail-closed. A confirmed different lstart is PID
        # reuse and permits another reader; never signal that unrelated process.
        if alive(prior['pid']) and (not start or not prior.get('start') or start == prior['start']):
            result['stuckPrior'] = True
            return result
    state.pop('child', None)
    save()
    output = root/'ssd-reader.out'
    with output.open('wb') as stream:
        # mac-cpu starts directly as Python (no FDA-granted /bin/zsh). A plain
        # child preserves the affected launchd context; shell reads hide #106.
        child = subprocess.Popen(reader or [sys.executable, '-c', READER, str(path)],
            stdin=subprocess.PIPE, stdout=stream, stderr=subprocess.DEVNULL)
    state['child'] = dict(pid=child.pid, start=None)
    save()
    try:
        start = identity(child.pid, root, state, save, deadline)
        state['child']['start'] = start or None
        save()
        if not start or time.monotonic() >= deadline:
            if start == '':
                result.update(outcome='error', errno='EIO')
            return result
        try:
            child.stdin.write(b'1')
            child.stdin.flush()
        except BrokenPipeError:
            pass
        finished = poll_until(child, deadline)
    finally:
        child.stdin.close()
    if finished:
        state.pop('child', None)
        save()
    # stdout is a small regular file, never a pipe whose EOF depends on a
    # kernel-stuck child. No kill, wait, communicate or Popen context manager.
    for line in output.read_text().splitlines():
        try:
            row = json.loads(line)
            for key in ('statMs', 'readMs', 'errno'):
                if key in row:
                    result[key] = row[key]
        except (ValueError, TypeError):
            pass
    if not finished:
        result.update(readMs=None, errno='ETIMEDOUT')
    elif child.returncode != 0 or result['statMs'] is None or result['readMs'] is None:
        result.update(outcome='error', errno=result['errno'] if result['errno'] != 'ETIMEDOUT' else 'EIO')
    else:
        result.update(outcome='slow' if max(result['statMs'], result['readMs']) > 500 else 'ok', errno=None)
    return result


def alert_state(result, root, state, save, now, send):
    # ~/.local/state/mac-upkeep/ssd-launchd-read-blocked is the restart-tool
    # interlock. Its consumers are owned separately by the watchdog and guard.
    marker = root/'ssd-launchd-read-blocked'
    stamp = now.isoformat(timespec='microseconds').replace('+00:00', 'Z')
    blocked = load(marker)
    bad = result['outcome'] in ('timeout', 'error') or result['stuckPrior']
    if bad:
        state['failures'] = state.get('failures', 0)+1
        state.setdefault('since', blocked.get('since', stamp))
        if state['failures'] >= 2 or blocked:
            atomic_json(marker, dict(since=state['since'], lastOutcome=result['outcome'], errno=result['errno']))
            if not state.get('incident'):
                state['incident'] = state['since']
                hhmm = dt.datetime.fromisoformat(state['since'].replace('Z', '+00:00')).strftime('%H:%MZ')
                state.setdefault('pending', []).append(dict(
                    key='mac-upkeep:ssd-read-probe:'+state['incident'],
                    text="Background jobs can't read the ExternalSSD (since %s). Don't restart Robob or other apps until this clears; a fresh start can hang. Mac Upkeep is on it." % hhmm))
    else:
        state['failures'] = 0
        if result['outcome'] == 'ok':
            if blocked or state.get('incident'):
                incident = state.get('incident', blocked.get('since'))
                state.setdefault('pending', []).append(dict(
                    key='mac-upkeep:ssd-read-probe:'+str(incident)+':recovery',
                    text='Background jobs can read the ExternalSSD again.'))
                marker.unlink(missing_ok=True)
            state.pop('incident', None)
            state.pop('since', None)
        elif not blocked:
            state.pop('since', None)
    # Reserve exact text and key before sending: a timeout can follow queueing.
    save()
    while state.get('pending'):
        entry = state['pending'][0]
        try:
            sent = send(entry['text'], entry['key'])
        except Exception:
            sent = False
        if not sent:
            break
        state['pending'].pop(0)
        save()


def send_notice(text, key, root, state, save):
    def run(argv, **kwargs):
        deadline = time.monotonic()+3
        prior = state.get('noticeChild')
        if prior and alive(prior['pid']):
            start = identity(prior['pid'], root, state, save, deadline)
            if alive(prior['pid']) and (not start or not prior.get('start') or start == prior['start']):
                return subprocess.CompletedProcess(argv, 1)
        # The collector's CLI path and dedupe contract are reused, but its
        # subprocess.run timeout would wait forever if this launcher hit #106.
        child = subprocess.Popen(argv, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, env=kwargs.get('env'))
        state['noticeChild'] = dict(pid=child.pid, start=None)
        save()
        state['noticeChild']['start'] = identity(child.pid, root, state, save, deadline) or None
        save()
        if not poll_until(child, deadline):
            return subprocess.CompletedProcess(argv, 1)
        state.pop('noticeChild', None)
        save()
        return subprocess.CompletedProcess(argv, child.returncode)
    return notify(text, key, run)


def process_type():
    try:
        path = Path.home()/'Library/LaunchAgents/com.abdullah.mac-cpu.plist'
        with path.open('rb') as stream:
            return plistlib.load(stream).get('ProcessType', 'Standard')
    except (OSError, ValueError):
        return 'unknown'


def sample(root=None, path=PROBE, now=None, send=None, timeout=DEADLINE_S, reader=None):
    root = Path(root) if root is not None else Path.home()/'.local/state/mac-upkeep'
    now = (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc)
    result = dict(statMs=None, readMs=None, outcome='error', errno='EIO', stuckPrior=False,
                  processType=process_type(), nice=os.nice(0), loadavg1=os.getloadavg()[0])
    try:
        private_dir(root)
        with (root/'ssd-read-probe.lock').open('a') as lock:
            os.chmod(lock.name, 0o600)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return None
            state_file = root/'ssd-read-probe.json'
            state = load(state_file)
            def save():
                atomic_json(state_file, state)
            try:
                result.update(probe(root, state, save, path, timeout, reader))
            except Exception as exc:
                result.update(outcome='error', errno=errno.errorcode.get(getattr(exc, 'errno', None), 'EIO'))
            alert_state(result, root, state, save, now,
                        send or (lambda text, key: send_notice(text, key, root, state, save)))
    except Exception as exc:
        result.update(outcome='error', errno=errno.errorcode.get(getattr(exc, 'errno', None), 'EIO'))
    emit('disk', 'event', 'disk.ssd_read_probe', ok=result['outcome'] in ('ok', 'slow'), props=result, now=now)
    return result


def init_probe(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open('xb') as stream:
            stream.write(bytes(4096))
            stream.flush()
            os.fsync(stream.fileno())
    except FileExistsError:
        if path.stat().st_size != 4096:
            raise ValueError('SSD probe file must be 4096 bytes')


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['init', 'check'])
    parser.add_argument('--path', type=Path, default=PROBE)
    args = parser.parse_args()
    if args.operation == 'init':
        init_probe(args.path)
    elif args.path.stat().st_size != 4096:
        raise ValueError('SSD probe file must be 4096 bytes')
