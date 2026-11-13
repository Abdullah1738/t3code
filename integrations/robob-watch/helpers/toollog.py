"""Best-effort, metadata-only tool logs shared with src/toollog.ts."""
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re

CAP = 50 * 1024 * 1024
_TOKEN = re.compile(r'[a-zA-Z][a-zA-Z0-9_.-]{0,79}')
_NAME = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}')
_DATED = re.compile(r'(?:rollup-)?(\d{4}-\d{2}-\d{2})(?:\.ndjson|\.json|\.cap)')
_IDS = frozenset(('watcher', 'run', 'thread', 'chat', 'key', 'operation', 'reminder', 'update', 'item', 'helper'))
_NUMERIC = frozenset(('exitCode', 'attempt', 'count', 'bytes', 'queuedMs'))
_BOOLEAN = frozenset(('deduped', 'accepted'))
_VALUES = {
    'severity': ('info', 'attention', 'error'),
    'outcome': ('fire', 'no_change', 'fail', 'timeout'),
    'source': ('mail', 'sms', 'bank', 'charge'),
    'routed': ('board', 'chat', 'ignored'),
    'class': ('urgent', 'today', 'info', 'noise', 'candidate', 'charge', 'bank', 'security', 'otp', 'unknown', 'fail_open', 'deduped'),
    'action': ('create', 'queue', 'cancel', 'snooze', 'sent', 'retry', 'check', 'wake', 'notify', 'send', 'coalesce', 'conflict', 'expire', 'pause', 'remove', 'cap', 'resume'),
    'state': ('pending', 'sending', 'sent', 'uncertain', 'cancelled', 'failed', 'scheduled', 'queued', 'done', 'expired', 'paused', 'active'),
}
_initialized = set()


def log_directory():
    return Path(os.environ['TOOLLOG_DIR']) if 'TOOLLOG_DIR' in os.environ else Path.home() / '.robob/logs/tools/watchers'


def _finite(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except (OverflowError, ValueError):
        return False


def _token(value):
    return type(value) is str and _TOKEN.fullmatch(value) is not None


def _fields(entry, at):
    # Exact built-in types avoid calling arbitrary __str__/mapping hooks while logging.
    if type(entry) is not dict or not _token(entry.get('component')) or not _token(entry.get('name')):
        return None
    if type(entry.get('kind')) is not str or entry['kind'] not in ('event', 'perf', 'error'):
        return None
    row = {'ts': at.isoformat(timespec='milliseconds').replace('+00:00', 'Z'), 'tool': 'watchers',
           'component': entry['component'], 'kind': entry['kind'], 'name': entry['name']}
    if _finite(entry.get('durationMs')) and entry['durationMs'] >= 0:
        row['durationMs'] = entry['durationMs']
    if type(entry.get('ok')) is bool:
        row['ok'] = entry['ok']
    ids = {}
    if type(entry.get('ids')) is dict:
        for key, value in entry['ids'].items():
            if type(key) is not str or key not in _IDS or not (type(value) is str or _finite(value)):
                continue
            text = str(value)
            if type(value) is float and value.is_integer():
                text = str(int(value))
            ids[key] = (text if key in ('watcher', 'helper') and _NAME.fullmatch(text) and not re.search(r'\d{5}', text)
                        else hashlib.sha256(text.encode('utf-8', errors='replace')).hexdigest()[:24])
    if ids:
        row['ids'] = ids
    props = {}
    if type(entry.get('props')) is dict:
        for key, value in entry['props'].items():
            if type(key) is not str:
                continue
            if key == 'exitCode' and value is None:
                props[key] = None
            elif key in _NUMERIC and _finite(value):
                props[key] = value
            elif key in _BOOLEAN and type(value) is bool:
                props[key] = value
            elif type(value) is str and value in _VALUES.get(key, ()):
                props[key] = value
    if props:
        row['props'] = props
    error = entry.get('error')
    if type(error) is dict and _token(error.get('tag')):
        row['error'] = {'tag': error['tag'], 'message': error['tag']}
    return row


def _append(path, row):
    payload = (json.dumps(row, ensure_ascii=True, allow_nan=False, separators=(',', ':')) + '\n').encode('utf-8')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, payload)
    finally:
        os.close(fd)


def tool_log(entry):
    try:
        if (os.environ.get('ROBOB_TEST') or os.environ.get('NODE_ENV') == 'test' or os.environ.get('PYTEST_CURRENT_TEST')) and not os.environ.get('TOOLLOG_DIR'):
            return
        at = dt.datetime.now(dt.timezone.utc)
        row = _fields(entry, at)
        if row is None:
            return
        directory, day = log_directory(), row['ts'][:10]
        path = directory / (day + '.ndjson')
        identity = (str(directory), day)
        if identity not in _initialized:
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            directory.chmod(0o700)
            cutoff = (at - dt.timedelta(days=30)).date().isoformat()
            for child in directory.iterdir():
                match = _DATED.fullmatch(child.name)
                if match and match[1] < cutoff:
                    try:
                        child.unlink()
                    except OSError:
                        pass
            _initialized.add(identity)
        try:
            size = path.stat().st_size
        except FileNotFoundError:
            size = 0
        if size > CAP:
            try:
                fd = os.open(directory / (day + '.cap'), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                try:
                    os.fchmod(fd, 0o600)
                finally:
                    os.close(fd)
                _append(path, {'ts': row['ts'], 'tool': 'watchers', 'component': 'logger', 'kind': 'error',
                               'name': 'log.cap', 'ok': False, 'error': {'tag': 'log.cap', 'message': 'log.cap'}})
            except Exception:
                pass  # The exclusive marker is shared by Python and TypeScript processes.
            if row['kind'] != 'error':
                return
        _append(path, row)
    except Exception:
        pass  # Formatting, retention and filesystem failures must not affect a check.


def tool_error(component, tag, ids=None):
    try:
        if not _token(component) or not _token(tag):
            return
        tool_log({'component': component, 'kind': 'error', 'name': component + '.error',
                  'ok': False, 'ids': ids, 'error': {'tag': tag}})
    except Exception:
        pass


def helper_main(name, fn, *args):
    """Keep each helper's result/exception intact while recording its process boundary."""
    import time
    started, code = time.perf_counter(), 0
    try:
        result = fn(*args)
        if type(result) is int:
            code = result
        return result
    except SystemExit as error:
        code = error.code if type(error.code) is int else 0 if error.code is None else 1
        raise
    except BaseException:
        code = 1
        raise
    finally:
        tool_log({'component': 'helpers', 'kind': 'perf' if code == 0 else 'error', 'name': 'helper.run',
                  'durationMs': (time.perf_counter() - started) * 1000, 'ok': code == 0,
                  'ids': {'helper': name, 'watcher': os.environ.get('WATCH_ID')}, 'props': {'exitCode': code},
                  **({'error': {'tag': 'helper.exit_failed'}} if code else {})})


def _main():
    # Shell helpers send only a fixed basename, elapsed milliseconds and an exit code.
    try:
        import argparse
        class QuietParser(argparse.ArgumentParser):
            def error(self, _message):
                raise ValueError()
            def exit(self, _status=0, _message=None):
                raise ValueError()
        parser = QuietParser(add_help=False)
        parser.add_argument('--helper', required=True)
        parser.add_argument('--duration-ms', type=float, required=True)
        parser.add_argument('--exit-code', type=int, required=True)
        args = parser.parse_args()
        tool_log({'component': 'helpers', 'kind': 'perf' if args.exit_code == 0 else 'error', 'name': 'helper.run',
                  'durationMs': max(0, args.duration_ms), 'ok': args.exit_code == 0,
                  'ids': {'helper': args.helper, 'watcher': os.environ.get('WATCH_ID')},
                  'props': {'exitCode': args.exit_code},
                  **({'error': {'tag': 'helper.exit_failed'}} if args.exit_code else {})})
    except BaseException:
        pass


if __name__ == '__main__':
    _main()
