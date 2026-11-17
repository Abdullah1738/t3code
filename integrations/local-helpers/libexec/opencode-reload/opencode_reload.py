"""Batch OpenCode-watched replacements after a quiet window. Stdlib only."""
from __future__ import annotations

import argparse
import base64
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timezone

_log_spec = importlib.util.spec_from_file_location(
    'opencode_reload_toollog', Path(__file__).resolve().parent.parent / 'toollog/toollog.py')
toollog = importlib.util.module_from_spec(_log_spec)
_log_spec.loader.exec_module(toollog)


def read(path):
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


def digest(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def instances():
    override = os.environ.get('OPENCODE_RELOAD_INSTANCES')
    if override is not None:
        result = json.loads(override)
        if not isinstance(result, list) or not result:
            raise ValueError('OPENCODE_RELOAD_INSTANCES must be a nonempty list')
        names = set()
        for item in result:
            if not isinstance(item, dict) or not isinstance(item.get('name'), str) or not re.fullmatch(r'[A-Za-z0-9_-]+', item['name']):
                raise ValueError('invalid OpenCode instance')
            if item['name'] in names:
                raise ValueError('duplicate OpenCode instance name')
            names.add(item['name'])
            if not isinstance(item.get('url'), str) or not item['url'].startswith(('http://', 'https://')):
                raise ValueError('invalid OpenCode instance URL')
            for key in ('directory', 'password_file'):
                if key in item and not isinstance(item[key], str):
                    raise ValueError(f'invalid OpenCode instance {key}')
        return result
    home = Path.home()
    return [dict(name=name, url='http://127.0.0.1:49374', directory=str(directory),
                 password_file=str(home / '.config/opencode-service/password'))
            for name, directory in [('HOME', home), ('BTSE', home / 'BTSE')]]


def busy_counts(config):
    counts, running = {}, set()
    for item in config:
        try:
            # 2.0.22 protocol/groups/session.ts: session.active is process-wide,
            # including HOME and BTSE drains. Union IDs so shared-service probes
            # don't double-count; separate service URLs work the same way.
            query = urllib.parse.urlencode({'location[directory]': item.get('directory', str(Path.home()))})
            request = urllib.request.Request(item['url'].rstrip('/') + '/api/session/active?' + query)
            password = read(Path(item.get('password_file', Path.home() / '.config/opencode-service/password')))
            if password:
                auth = base64.b64encode(b'opencode:' + password.strip()).decode()
                request.add_header('Authorization', 'Basic ' + auth)
            with urllib.request.urlopen(request, timeout=2) as response:
                data = json.load(response)['data']
            if not isinstance(data, dict) or any(not isinstance(v, dict) or v.get('type') != 'running' for v in data.values()):
                raise ValueError('invalid active session response')
            counts[item['name']] = len(data)
            running.update((item['url'], sid) for sid in data)
        except (OSError, ValueError, KeyError, TypeError):
            counts[item['name']] = 'unknown'
    return counts, len(running)


def settings():
    wait = float(os.environ.get('OPENCODE_RELOAD_WAIT', '600'))
    if not 0 <= wait <= 86400:
        raise ValueError('OPENCODE_RELOAD_WAIT must be between 0 and 86400 seconds')
    return wait, instances()


def quiet_window(allow_reload=False, *, fetch=busy_counts, sleep=time.sleep, clock=time.monotonic):
    wait, config = settings()
    started = clock()
    while True:
        counts, total = fetch(config)
        elapsed = clock() - started
        if allow_reload or not total:
            return counts, round(elapsed * 1000)
        if elapsed >= wait:
            raise ValueError(f'{total} OpenCode sessions busy; rerun later or pass --allow-reload')
        sleep(min(15, wait - elapsed))


def apply(installer, pairs, *, allow_reload=False, dry_run=False, receipt=None, expected_before=None, owned_by=None):
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', installer):
        raise ValueError('invalid installer name')
    identities = {row['path']: (row['device'], row['inode'], row['mtime_ns']) for row in
                  (json.loads(Path(owned_by).read_text()) if owned_by is not None else [])}
    def verify_owner(dst):
        if owned_by is not None:
            current = dst.stat()
            if identities.get(str(dst)) != (current.st_dev, current.st_ino, current.st_mtime_ns):
                raise ValueError(f'OpenCode file is no longer owned by this install: {dst}; preserving it')

    expected_before = {Path(dst).absolute(): Path(src).read_bytes() for src, dst in (expected_before or [])}
    # Read every source/destination before creating backups, directories or temps.
    planned = []
    destinations = set()
    for source, destination in pairs:
        source, destination = Path(source), Path(destination).absolute()
        if destination in destinations or destination.is_symlink():
            raise ValueError(f'duplicate or symlink destination: {destination}')
        destinations.add(destination)
        data = source.read_bytes()
        before = read(destination)
        if before != data:
            if destination in expected_before and before != expected_before[destination]:
                raise ValueError(f'OpenCode file changed since planning: {destination}; rerun')
            planned.append((destination, data, before, source.stat().st_mode & 0o777))
    if not planned:
        return 0
    settings()
    if dry_run:
        for dst, *_ in planned:
            print(f'would write {dst}')
        return len(planned)
    state = Path.home() / '.local/state/opencode-reload'
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / 'install.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        # A second installer may have finished while we waited for its lock.
        remaining = []
        for dst, data, before, mode in planned:
            current = read(dst)
            if current == data:
                continue
            if current != before or dst.is_symlink():
                raise ValueError(f'OpenCode file changed while waiting for lock: {dst}; rerun')
            verify_owner(dst)
            remaining.append((dst, data, before, mode))
        planned = remaining
        if not planned:
            return 0
        allow_reload = allow_reload or os.environ.get('OPENCODE_ALLOW_RELOAD') == '1'
        counts, waited = quiet_window(allow_reload)
        for dst, _, before, _ in planned:
            if read(dst) != before or dst.is_symlink():
                raise ValueError(f'OpenCode file changed while waiting: {dst}; rerun')
            verify_owner(dst)
        stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S-%f')
        backup = Path.home() / '.config/opencode/backups' / installer / stamp
        staged, written, owned = [], [], []
        try:
            for dst, data, before, mode in planned:
                if before is not None:
                    # No *.ts.bak files inside auto-loaded plugin/.
                    relative = Path(*dst.parts[-2:])
                    saved = backup / relative.parent / (relative.name + '.bak-' + stamp)
                    saved.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    saved.write_bytes(before)
                    saved.chmod(0o600)
                dst.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                fd, temp = tempfile.mkstemp(dir=dst.parent, prefix='.opencode-reload-', suffix='.tmp')
                staged.append((Path(temp), dst, before, data))
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.chmod(temp, 0o600 if dst.name.endswith(('.json', '.jsonc')) else mode)
            # Staging and fsync can take time; preserve edits made during them.
            for dst, _, before, _ in planned:
                if read(dst) != before or dst.is_symlink():
                    raise ValueError(f'OpenCode file changed while staging: {dst}; rerun')
                verify_owner(dst)
            for temp, dst, before, data in staged:
                identity = temp.stat()
                os.replace(temp, dst)
                owned.append({'path': str(dst), 'device': identity.st_dev, 'inode': identity.st_ino, 'mtime_ns': identity.st_mtime_ns})
                written.append({'path': str(dst), 'sha256_before': digest(before), 'sha256_after': digest(data)})
        finally:
            try:
                if owned and receipt is not None:
                    Path(receipt).write_text(json.dumps(owned))
            finally:
                record_reload(installer, written, counts, waited, allow_reload, len(planned))
                for temp, *_ in staged:
                    temp.unlink(missing_ok=True)
    return len(written)


def record_reload(installer, written, counts, waited, allow_reload, total):
    if written:
        toollog.emit('installers', 'opencode-reload', 'opencode-reload', ok=len(written) == total,
                     props={'installer': installer, 'files': written, 'busy': counts,
                            'waited_ms': waited, 'allow_reload': allow_reload})
        busy = ', '.join(f'{name}={count}' for name, count in counts.items())
        print(f'opencode-reload: {installer} wrote {len(written)} files; OpenCode reloads now (~20 s, busy sessions: {busy})', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--installer', required=True)
    parser.add_argument('--pair', nargs=2, action='append', default=[])
    parser.add_argument('--allow-reload', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--owned-by', help='restore only inodes recorded by this install')
    parser.add_argument('--receipt', help='record replaced inode identities for rollback ownership')
    parser.add_argument('--expect-before', nargs=2, action='append', default=[])
    args = parser.parse_args()
    try:
        apply(args.installer, args.pair, allow_reload=args.allow_reload, dry_run=args.dry_run,
              receipt=args.receipt, expected_before=args.expect_before, owned_by=args.owned_by)
    except (OSError, ValueError) as error:
        parser.exit(1, f'opencode-reload: {error}\n')


if __name__ == '__main__':
    main()
