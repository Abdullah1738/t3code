"""Guest disk probes and conservative cleanup, also shipped beside boatd (stdlib only)."""
import errno
import inspect
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import time
import base64
import zlib

GIB = 1024 ** 3
WARN_BYTES = GIB
GATE_BYTES = 256 * 1024 ** 2
FAIL_BYTES = 64 * 1024 ** 2
MARKER = 'offbox-space: '
CLIENT_STARTED_AT = time.time()
PROBE_BEGIN_MARKER = 'offbox-space-probe: '
PROBE_ERROR_MARKER = 'offbox-space-probe-error: '
PROBE_FAILED = 'offbox: disk-space probe failed (exit '
PROBE_INVALID = 'offbox: infra: disk probe payload invalid (client code changed on disk since start?)'
ENOSPC = re.compile(r'No space left on device|\bENOSPC\b|os error 28|Errno\s*28|errno[ :=]*28', re.I)


def snapshot(workspace=None, home=None):
    out = {}
    for name, path in [('tmp', '/tmp'), ('var_tmp', '/var/tmp'), ('home', home or str(Path.home())),
                       ('workspace', workspace or str(Path.home()))]:
        try:
            s = os.statvfs(path)
            try:
                fs = subprocess.run(['findmnt', '-T', path, '-n', '-o', 'FSTYPE'], capture_output=True,
                                    text=True, timeout=5).stdout.strip()
            except (OSError, subprocess.SubprocessError):
                fs = 'unknown'
            out[name] = dict(path=path, size_bytes=s.f_blocks*s.f_frsize, free_bytes=s.f_bavail*s.f_frsize,
                             fstype=fs or 'unknown')
        except (OSError, subprocess.SubprocessError) as e:
            out[name] = dict(path=path, error=str(e))
    return out


def warning(space, box):
    s = space.get('tmp', {})
    if s.get('free_bytes', WARN_BYTES) < WARN_BYTES:
        return (f"offbox: warning: /tmp on {box} has {s['free_bytes']} free of {s['size_bytes']} "
                '(leftovers from earlier runs); writes to /tmp may fail with ENOSPC')


def held_paths(proc=Path('/proc')):
    """Unknown permissions fail closed; disappearing processes are harmless."""
    found = set()
    for p in proc.iterdir():
        if not p.name.isdigit() or int(p.name) == os.getpid():
            continue
        try:
            found.add(os.readlink(p / 'cwd').removesuffix(' (deleted)'))
            found.add(os.readlink(p / 'root').removesuffix(' (deleted)'))
            for fd in (p / 'fd').iterdir():
                try:
                    found.add(os.readlink(fd).removesuffix(' (deleted)'))
                except OSError as e:
                    if e.errno != errno.ENOENT:
                        raise
            for line in (p / 'maps').read_text().splitlines():
                parts = line.split(None, 5)
                if len(parts) == 6 and parts[5].startswith('/'):
                    mapped = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), parts[5])
                    found.add(mapped.removesuffix(' (deleted)'))
        except OSError as e:
            if e.errno not in (errno.ENOENT, errno.ESRCH):
                raise
    return found


def inventory(path, uid, cutoff, device):
    """No mounts, foreign owners or sockets anywhere in the candidate tree."""
    st = path.lstat()
    if st.st_dev != device or st.st_uid != uid or stat.S_ISSOCK(st.st_mode):
        return None
    if max(st.st_mtime, st.st_ctime) >= cutoff:
        return None
    if not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode)):
        return None
    size, mtime = st.st_blocks * 512, st.st_mtime
    if stat.S_ISDIR(st.st_mode):
        for child in path.iterdir():
            info = inventory(child, uid, cutoff, device)
            if info is None:
                return None
            size += info[0]
            mtime = max(mtime, info[1])
    return size, mtime, st.st_ino, st.st_dev


def remove_checked(parent, name, uid, cutoff, device, expected=None):
    """Anchor traversal to directory fds; a replacement tree never inherits the old tree's eligibility."""
    st = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if (st.st_uid != uid or st.st_dev != device or max(st.st_mtime, st.st_ctime) >= cutoff or
            (expected is not None and st.st_ino != expected)):
        return 0, False
    if stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode):
        os.unlink(name, dir_fd=parent)
        return st.st_blocks*512, True
    if not stat.S_ISDIR(st.st_mode):
        return 0, False
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    total, complete = 0, True
    try:
        opened = os.fstat(fd)
        if opened.st_ino != st.st_ino or max(opened.st_mtime, opened.st_ctime) >= cutoff:
            return 0, False
        def mount_id(handle):
            return next(line for line in Path(f'/proc/self/fdinfo/{handle}').read_text().splitlines()
                        if line.startswith('mnt_id:'))
        if mount_id(parent) != mount_id(fd):
            return 0, False
        for child in os.listdir(fd):
            try:
                size, removed = remove_checked(fd, child, uid, cutoff, device)
            except OSError:
                size, removed = 0, False
            total += size
            complete &= removed
        try:
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if complete and current.st_ino == st.st_ino:
                os.rmdir(name, dir_fd=parent)
                return total+st.st_blocks*512, True
        except OSError:
            pass
        return total, False
    finally:
        os.close(fd)


def reap(root, uid, live, *, clock=time.time, proc=Path('/proc'), emit=print,
         mountinfo=Path('/proc/self/mountinfo'), finished_before=None, keep_prefixes=()):
    root = Path(root)
    # A confirmed finished run needs no grace period; every live wrapper still fences its files.
    cutoff = min([finished_before if finished_before is not None else clock()-600] +
                 [r['started_at'] for r in live])
    device = root.stat().st_dev
    # st_dev alone cannot distinguish a bind mount of the same filesystem.
    mounts = [re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), line.split()[4])
              for line in mountinfo.read_text().splitlines()]
    removed = 0
    for path in root.iterdir():
        # The parent is protected too: never recurse into any run's private scratch.
        if path.name in ('offbox-run', '.X11-unix', 'snap-private-tmp') or path.name.startswith(('systemd-private-', *keep_prefixes)):
            continue
        if any(m == str(path) or m.startswith(str(path) + '/') for m in mounts):
            continue
        try:
            info = inventory(path, uid, cutoff, device)
            if info is None:
                continue
            held = held_paths(proc)
            if any(p == str(path) or p.startswith(str(path) + '/') for p in held):
                continue
            # Recheck the entire tree after the proc scan, including concurrent creation/renames.
            if inventory(path, uid, cutoff, device) != info:
                continue
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                size, complete = remove_checked(fd, path.name, uid, cutoff, device, expected=info[2])
            finally:
                os.close(fd)
            if size or complete:
                removed += size
                emit(dict(path=str(path), size_bytes=size, mtime=info[1], partial=not complete))
        except OSError as e:
            if e.errno not in (errno.ENOENT, errno.ESRCH):
                emit(dict(skipped=str(path), error=str(e)))
    return removed


def preflight(context, *, measure=None, reaper=reap, emit=print):
    """boatd holds its admission lock, so no new command can start during this pass."""
    box, run = context['box_id'], context['run_id']
    if measure is None:
        home = pwd.getpwnam('user').pw_dir
        measure = lambda: snapshot(home, home=home)
    space = measure()
    emit(MARKER + json.dumps(dict(phase='server_start', space=space)))
    line = warning(space, box)
    if line:
        emit(line)
    live = context['live']
    critical = space.get('tmp', {}).get('free_bytes', GATE_BYTES) < GATE_BYTES
    # A critically full busy box is refused without disturbing its current work.
    if not (critical and live):
        for key, root in [('tmp', '/tmp'), ('var_tmp', '/var/tmp')]:
            s = space.get(key, {})
            if s.get('free_bytes', 1) < s.get('size_bytes', 0) / 2:
                def report(item):
                    if 'path' in item:
                        emit(f"offbox: reclaimed {item['path']} ({item['size_bytes']} bytes, mtime {item['mtime']}, "
                             f"partial={item.get('partial', False)}) "
                             f"on {box} run {run}")
                    else:
                        emit('offbox: reclaim skipped ' + json.dumps(item))
                uid = context.get('uid')
                if uid is None:
                    uid = pwd.getpwnam('user').pw_uid
                total = reaper(root, uid, live, emit=report)
                emit(f'offbox: reclaimed total {total} bytes on {box} run {run} under {root}')
    space = measure()
    if space.get('tmp', {}).get('free_bytes', GATE_BYTES) < GATE_BYTES:
        emit(MARKER + json.dumps(dict(phase='gate', space=space, infra_failure='enospc')))
        emit(f"offbox: infra: /tmp on {box} has {space['tmp']['free_bytes']} free; "
             'command not started (requires 256 MiB). Retry on another box; see remote-compute: Disk space.')
        return 90
    return 0


def valid_space(space):
    return (isinstance(space, dict) and all(isinstance(s, dict) for s in space.values()) and
            all(type(s[k]) is int and s[k] >= 0 for s in space.values()
                for k in ('free_bytes', 'size_bytes') if k in s))


def error_line(line):
    return not line.startswith((MARKER, 'offbox: warning:')) and bool(ENOSPC.search(line))


def result(path, code, *, offset=0, identity=None):
    import offbox_protocol
    identity = identity or offbox_protocol.for_run(path=path)
    phases, matches, seen_attempt, final = {}, False, 0, None
    probe_error, traceback_line, string_trace, command_started = None, None, 0, False
    probe_errors, started_attempts = {}, set()
    native_crash = False
    native_attempts = {}
    native_reason = None
    try:
        with open(path, 'rb') as f:
            f.seek(offset)
            for raw in f:
                line = raw.decode(errors='replace')
                if line.startswith(MARKER):
                    try:
                        item = json.loads(line[len(MARKER):])
                        phase = item['phase']
                        if phase in ('attempt', 'result'):
                            attempt = item.get('attempt')
                            if type(attempt) is not int or attempt < 1:
                                continue
                            if phase == 'attempt':
                                seen_attempt = max(seen_attempt, attempt)
                                probe_error, traceback_line, string_trace, command_started = None, None, 0, False
                            else:
                                record = item.get('record')
                                if (isinstance(record, dict) and isinstance(record.get('disk_space'), dict) and
                                        all(p in ('server_start', 'start', 'end', 'gate') and valid_space(s)
                                            for p, s in record['disk_space'].items()) and
                                        record.get('infra_failure') in (None, 'enospc', 'native_crash', 'disk_probe') and
                                        (record.get('infra_failure') != 'disk_probe' or
                                         record.get('infra_reason') == 'probe_crashed') and
                                        (record.get('infra_failure') != 'native_crash' or
                                         isinstance(record.get('infra_reason'), str)) and
                                        (final is None or attempt >= final[0])):
                                    final = attempt, record
                            continue
                        if phase in ('toolchain', 'setup'):
                            if (item.get('infra_failure') == 'native_crash' and
                                    isinstance(item.get('infra_reason'), str)):
                                native_crash = True
                                native_reason = item['infra_reason']
                                native_attempts[seen_attempt] = native_reason
                            continue
                        space = item['space']
                        if phase not in ('server_start', 'start', 'end', 'gate') or not valid_space(space):
                            continue
                        if phase == 'server_start':
                            phases = {}
                            native_crash = False
                        elif phase == 'start':
                            native_crash = False
                            server_start = phases.get('server_start') if set(phases) == {'server_start'} else None
                            phases = {'server_start': server_start} if server_start is not None else {}
                        phases[phase] = space
                    except (ValueError, KeyError, TypeError):
                        pass
                else:
                    if identity.command_started(line):
                        command_started = True
                        started_attempts.add(seen_attempt)
                    if line.startswith(PROBE_BEGIN_MARKER):
                        traceback_line, string_trace = None, 0
                    if 'File "<string>"' in line:
                        string_trace += 1
                    if string_trace >= 2 and re.match(r'^(?:[\w.]*Error|[\w.]*Exception):', line):
                        traceback_line = line.strip()
                        if not command_started:
                            probe_error = traceback_line
                    if line.startswith((PROBE_ERROR_MARKER, PROBE_FAILED)):
                        probe_error = traceback_line or line.strip()
                    if probe_error:
                        probe_errors[seen_attempt] = probe_error
                    matches |= error_line(line)
    except OSError:
        pass
    # Stream interleaving is not chronology. Only the server's explicit byte-range result
    # can attribute errors to one attempt; legacy/Boat logs retain all observed evidence.
    authoritative = final is not None and final[0] >= seen_attempt
    if authoritative:
        phases = final[1]['disk_space']
        matches = final[1].get('infra_failure') == 'enospc'
        # Older servers summarize disk failures only. Preserve the explicit stderr
        # toolchain marker for that same attempt so a client-only install is enough.
        native_crash = (final[1].get('infra_failure') == 'native_crash' or
                        final[1].get('setup_native_crash') is True or final[0] in native_attempts)
        native_reason = (final[1].get('infra_reason') if final[1].get('infra_failure') == 'native_crash'
                         else native_attempts.get(final[0]))
    if authoritative:
        probe_error = final[1].get('disk_probe_error') or probe_errors.get(final[0])
        command_started = final[0] in started_attempts
    start, end = phases.get('start', phases.get('server_start', {})), phases.get('end', {})
    out = dict(disk_space=phases, command_exit_code=None if 'gate' in phases else code,
               wrapper_exit_code=code, infra_failure=None, infra_reason=None)
    if authoritative:
        out['disk_attempt'] = final[0]
    for key, s in start.items():
        for field in ('free_bytes', 'size_bytes', 'fstype'):
            if field in s:
                out[f'{key}_{field}'] = s[field]
    low = any(s.get('free_bytes', FAIL_BYTES) < FAIL_BYTES for s in end.values())
    if code not in (0, None) and (matches or low or 'gate' in phases):
        out['infra_failure'] = 'enospc'
        out['infra_reason'] = 'low_space_gate' if 'gate' in phases else 'disk_exhausted'
    if probe_error:
        out['disk_probe_error'] = probe_error
        probe_crashed = code in (None, 90) and not command_started and 'gate' not in phases
        if authoritative and 'disk_probe_error' in final[1]:
            probe_crashed = final[1].get('infra_failure') == 'disk_probe'
        if probe_crashed:
            out.update(infra_failure='disk_probe', infra_reason='probe_crashed', command_exit_code=None)
    if native_crash:
        out['setup_native_crash'] = True
    if code == 90 and native_crash and native_reason:
        out.update(infra_failure='native_crash', infra_reason=native_reason, command_exit_code=None)
    return out


def command_result(stdout, stderr, code, *, stdout_offset=0, stderr_offset=0, identity=None):
    record = result(stderr, code, offset=stderr_offset, identity=identity)
    if code not in (0, None) and not record['infra_failure']:
        with open(stdout, 'rb') as output:
            output.seek(stdout_offset)
            if any(error_line(line.decode(errors='replace')) for line in output):
                record.update(infra_failure='enospc', infra_reason='disk_exhausted')
    return record


def message(record):
    if record.get('infra_failure') == 'disk_probe':
        return 'infra: the offbox disk probe crashed before your command started; nothing ran. Rerun.'
    if record.get('infra_failure') == 'native_crash':
        return 'infra: this box crashed native programs during setup (exit 90).'
    phases = record.get('disk_space', {})
    start = phases.get('start', phases.get('server_start', {}))
    end = phases.get('end', phases.get('gate', {}))
    values = '; '.join(f"{s.get('path', k)} {start.get(k, {}).get('free_bytes', 'unknown')} free at start, "
                       f"{s.get('free_bytes', 'unknown')} at end" for k, s in end.items())
    return (f"infra: the box ran out of disk ({values or 'space not measured'}); "
            'test results from this run are not valid. Rerun; see remote-compute: Disk space')


def probe():
    phase = sys.argv[1]
    space = snapshot(sys.argv[2] if len(sys.argv) > 2 else None)
    print(MARKER + json.dumps(dict(phase=phase, space=space)), file=sys.stderr, flush=True)
    if phase == 'start':
        receipt = None
        run = os.environ.get('OFFBOX_RUN_ID', '')
        if re.fullmatch(r'run-[A-Za-z0-9-]+', run):
            receipt = Path.home() / '.offbox/exit' / (run + '.gate')
            try:
                receipt.unlink(missing_ok=True)
            except OSError:
                pass
        line = warning(space, os.environ.get('OFFBOX_BOX_ID', '<box>'))
        if line:
            print(line, file=sys.stderr)
        if space.get('tmp', {}).get('free_bytes', GATE_BYTES) < GATE_BYTES:
            record = json.dumps(dict(phase='gate', space=space))
            # A lost command-start response has no API log identity, including on home boxes.
            if receipt is not None:
                try:
                    receipt.parent.mkdir(parents=True, exist_ok=True)
                    receipt.write_text(record)
                except OSError:
                    pass
            print(MARKER + record, file=sys.stderr, flush=True)
            print('offbox: infra: /tmp below 256 MiB; command not started; see remote-compute: Disk space', file=sys.stderr)
            sys.exit(90)


def _build_probe_payload():
    # Send only the probe, not the reaper; wrapped shell commands must remain below 64 KiB.
    source = ('import os,json,re,subprocess,sys\nfrom pathlib import Path\n'
              f'WARN_BYTES={WARN_BYTES}\nGATE_BYTES={GATE_BYTES}\nMARKER={MARKER!r}\n'
              + '\n'.join(inspect.getsource(f) for f in (snapshot, warning, probe)) + '\nprobe()\n')
    compile(source, '<offbox disk probe>', 'exec')
    return base64.b64encode(zlib.compress(source.encode())).decode()


# inspect uses on-disk line numbers. Capture before a queue wait can span an install.
try:
    _PROBE_PAYLOAD = _build_probe_payload()
    PROBE_PAYLOAD_ERROR = None
except Exception as error:
    PROBE_PAYLOAD_ERROR = f'{type(error).__name__}: {error}'
    _fallback = 'import sys\nprint(' + repr(PROBE_ERROR_MARKER + PROBE_PAYLOAD_ERROR) + ', file=sys.stderr)\n'
    _PROBE_PAYLOAD = base64.b64encode(zlib.compress(_fallback.encode())).decode()


def probe_payload():
    return _PROBE_PAYLOAD


def client_metadata():
    try:
        mtime = Path(__file__).stat().st_mtime
    except OSError:
        mtime = None
    return dict(client_started_at=CLIENT_STARTED_AT, disk_probe_module_mtime=mtime)


if __name__ == '__main__':
    if sys.argv[1] == 'preflight':
        sys.exit(preflight(json.loads(sys.argv[2])))
    probe()
