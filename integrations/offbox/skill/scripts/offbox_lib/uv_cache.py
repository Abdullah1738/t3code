"""Quarantine a shared uv archive only after uv reports a missing cache file."""
import json
from pathlib import Path
import re
import shlex
import sqlite3
import subprocess
import time
from typing import NamedTuple

from . import api, common, ssh_sync


MISSING = re.compile(
    r"(?:failed to open file|failed to read)[^\n]*?[`'\"]?"
    r"(?P<path>/[^\s`'\"]*/\.xcache/uv/archive-v0/(?P<entry>[A-Za-z0-9_-]{8,64})(?:/[^\n`'\"]+)?)"
    r"[`'\"]?:?[^\n]*?(?:No such file or directory|os error 2)", re.I)
DIST = re.compile(r"/([A-Za-z0-9_][A-Za-z0-9_.-]*?)-[0-9][^/]*\.dist-info/")
INSTALL = re.compile(r"Failed to install:\s+([A-Za-z0-9_][A-Za-z0-9_.-]*?)-[0-9][^\s]*\.whl", re.I)
CAUSE = re.compile(r"\r?\n[ \t]+Caused by:[ \t]*", re.I)
PERMISSION = re.compile(r"Permission denied|\bos error 13\b", re.I)


def broken_entry(text):
    # uv can put the path and ENOENT on adjacent cause lines. Keep separate errors apart.
    for error in CAUSE.sub(' ', text).splitlines():
        if PERMISSION.search(error):
            continue
        for match in MISSING.finditer(error):
            context = error[max(0, match.start() - 2048):match.start()]
            installs = list(INSTALL.finditer(context))
            if not installs and not match.group(0).lower().startswith('failed to read'):
                continue
            dist = DIST.search(match['path'])
            package = dist[1] if dist else installs[-1][1] if installs else None
            if package:
                return match['entry'], re.sub(r'[-_.]+', '-', package).lower()
    return None


# uv holds a shared .lock during installs; an exclusive nonblocking flock avoids moving files used by
# another uv process. rename (never shutil.move) must fail rather than copy across filesystems.
REPAIR = r'''
import fcntl, json, os, sys, tempfile
from pathlib import Path

entry = sys.argv[1]
cache = Path.home() / '.xcache/uv'
source = cache / 'archive-v0' / entry
archive = 'untouched'
def scan_error(error):
    raise error
try:
    with (cache / '.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('uv cache is busy; no files moved')
        trash = Path.home() / '.offbox/trash'
        trash.mkdir(parents=True, exist_ok=True)
        destination = Path(tempfile.mkdtemp(prefix='uv-' + entry + '-', dir=trash))
        if os.path.lexists(source):
            os.rename(source, destination / 'archive')
            archive = 'moved'
        else:
            archive = 'absent'
        refs = set()
        target = os.path.normpath(str(source))
        for wheels in cache.glob('wheels-v*'):
            if wheels.is_symlink() or not wheels.is_dir():
                continue
            for root, dirs, files in os.walk(wheels, followlinks=False, onerror=scan_error):
                for name in dirs + files:
                    path = Path(root) / name
                    if path.is_symlink():
                        link = os.path.normpath(os.path.join(root, os.readlink(path)))
                        if link == target or link.startswith(target + '/'):
                            refs.add(path)
                            refs.update(p for p in (Path(str(path) + ext) for ext in ('.http', '.msgpack', '.rkyv', '.rev'))
                                        if os.path.lexists(p))
                    elif path.suffix in ('.http', '.msgpack', '.rkyv', '.rev') and path.is_file():
                        # HTTP cache records can retain an archive ID even after its symlink is lost.
                        with path.open('rb') as stream:
                            if entry.encode() in stream.read(4 * 1024 * 1024):
                                refs.add(path)
                                http = path.with_suffix('.http')
                                if os.path.lexists(http):
                                    refs.add(http)
        for index, path in enumerate(sorted(refs)):
            if os.path.lexists(path):
                os.rename(path, destination / ('ref-' + str(index)))
        print(json.dumps({'ok': True, 'reason': 'wheel references cleared', 'archive': archive, 'refs': len(refs)}))
except (OSError, RuntimeError) as error:
    print(json.dumps({'ok': False, 'reason': str(error), 'archive': archive}))
    sys.exit(1)
'''


class RepairResult(NamedTuple):
    ok: bool
    reason: str
    archive: str = 'unknown'


def repair(box, entry, package, *, timeout=20):
    started = time.monotonic()
    with api.budget(timeout):
        base = ssh_sync.ssh_base(box)
        remaining = timeout - (time.monotonic() - started)
        if remaining < 1:
            raise subprocess.TimeoutExpired(base, timeout)
        command = 'timeout -s KILL ' + str(max(0.1, remaining - 1)) + ' python3 -I -c ' + shlex.quote(REPAIR) + ' ' + shlex.quote(entry)
        # Freeze the selected management/legacy endpoint so setup cannot spend this budget twice.
        result = ssh_sync.ssh(box, command, timeout=remaining, base=base)
    try:
        receipt = json.loads(result.stdout)
    except (ValueError, TypeError):
        return RepairResult(False, f'SSH exit {result.returncode}; no repair receipt')
    if not isinstance(receipt, dict):
        return RepairResult(False, f'SSH exit {result.returncode}; invalid repair receipt')
    archive = receipt.get('archive', 'unknown')
    if archive not in ('moved', 'absent', 'untouched'):
        return RepairResult(False, 'invalid archive repair receipt')
    return RepairResult(result.returncode == 0 and receipt.get('ok') is True and archive != 'untouched',
                        str(receipt.get('reason', 'invalid repair receipt'))[:300], archive)


def report(box, run_id, log_path, code, *, until=None):
    if not box or code is None:
        return
    try:
        found = broken_entry(Path(log_path).read_text(errors='replace')) if log_path else None
    except OSError:
        return
    if not found:
        return
    entry, package = found
    details = dict(run=run_id, box=box, entry=entry, package=package)
    con = None
    try:
        con = common.db()
        # A foreground run, its background follower and later waits can all see the same log.
        claimed = con.execute('INSERT OR IGNORE INTO kv VALUES (?,?,?)',
                              ('uv_cache_corrupt:' + run_id, json.dumps(details), common.now())).rowcount
        con.commit()
        if not claimed:
            return
        common.event(con, box, 'uv_cache_corrupt', json.dumps(details))
        budget = 20 if until is None else max(0, min(20, until - common.now()))
        try:
            if budget < 1:
                result = RepairResult(False, 'caller deadline reached')
            else:
                result = repair(box, entry, package, timeout=budget)
        except (OSError, subprocess.TimeoutExpired, common.OffboxError) as error:
            result = RepairResult(False, 'timeout' if isinstance(error, subprocess.TimeoutExpired) else str(error)[:300])
        common.event(con, box, 'uv_cache_repaired' if result.ok else 'uv_cache_repair_failed',
                     json.dumps(dict(details, reason=result.reason, archive=result.archive)))
        if result.archive == 'moved':
            outcome = 'it was moved aside'
        elif result.archive == 'absent':
            outcome = 'it was already absent; its wheel references were cleared' if result.ok else 'it was already absent'
        else:
            outcome = 'repair did not complete'
        if not result.ok:
            outcome += f'; repair failed ({result.reason})'
        common.say(f'the uv cache on {box} has a broken entry ({entry}); {outcome} — rerun, '
                   'or set UV_CACHE_DIR=$(mktemp -d) for a private cache')
    except sqlite3.Error as error:
        common.log(f'{run_id}: uv cache diagnostic could not be recorded: {error}')
    finally:
        if con:
            con.close()
