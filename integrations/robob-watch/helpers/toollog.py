"""Best-effort, metadata-only tool logs shared with src/toollog.ts."""
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re
import errno
import signal

CAP = 50 * 1024 * 1024
_TOKEN = re.compile(r'[a-zA-Z][a-zA-Z0-9_.-]{0,79}')
_NAME = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}')
_DATED = re.compile(r'(?:rollup-)?(\d{4}-\d{2}-\d{2})(?:\.ndjson|\.json|\.cap)')
_IDS = frozenset(('watcher', 'run', 'thread', 'chat', 'key', 'operation', 'reminder', 'update', 'item', 'helper'))
_NUMERIC = frozenset(('exitCode', 'attempt', 'count', 'bytes', 'queuedMs', 'failedSources', 'totalSources'))
_BOOLEAN = frozenset(('deduped', 'accepted', 'timedOut'))
_ERRNO = frozenset(name for name in dir(errno) if name.startswith('E') and type(getattr(errno, name)) is int) | {'UNKNOWN'}
_SIGNALS = frozenset(s.name for s in signal.Signals)
_VALUES = {
    'severity': ('info', 'attention', 'error'),
    'outcome': ('fire', 'no_change', 'fail', 'timeout'),
    'source': ('mail', 'sms', 'bank', 'charge'),
    'routed': ('board', 'chat', 'ignored', 'logged'),
    'authKind': ('otp', 'signin_link'),
    'senderLabel': ('Emirates NBD', 'Emirates Islamic', 'Mashreq', 'ADCB', 'Wio', 'Apple', 'Google',
                    'WHOOP', 'Claude', 'Virgin', 'e&', 'du', 'your bank', 'an inbox sender'),
    'class': ('urgent', 'today', 'info', 'noise', 'candidate', 'charge', 'bank', 'security', 'otp', 'unknown', 'fail_open', 'deduped'),
    'action': ('create', 'queue', 'cancel', 'snooze', 'sent', 'retry', 'check', 'wake', 'notify', 'send', 'coalesce', 'conflict', 'expire', 'pause', 'remove', 'cap', 'resume'),
    'state': ('pending', 'sending', 'sent', 'uncertain', 'cancelled', 'failed', 'scheduled', 'queued', 'done', 'expired', 'paused', 'active'),
    'stderrClass': ('usage_error', 'missing_file', 'permission', 'timeout', 'python_traceback', 'auth', 'connect', 'json', 'unknown'),
    'triggerKind': ('file', 'wal'),
}
_initialized = set()

# Same order and normalization as src/cause.ts; classification never retains text in a log.
_PATTERNS = tuple((name, re.compile(pattern, re.I)) for name, pattern in (
    ('usage_error', r'(?:^|\n)\s*usage:|unrecognized arguments?|unknown (?:option|argument)|invalid (?:option|choice)|argument .*required|not (?:an exact trip UUID|a bridge chat slug)|no bridge chat|unsafe display name|invalid command arguments|duplicate command option|unexpected positional arguments|--[a-z-]+ (?:is required|must be)'),
    ('missing_file', r'no such file or directory|filenotfounderror|\bENOENT\b|command not found|cannot find module|modulenotfounderror'),
    ('permission', r'permission denied|operation not permitted|permissionerror|\b(?:EACCES|EPERM)\b'),
    ('timeout', r'timed? out|timeoutexpired|timeouterror|\bETIMEDOUT\b'),
    ('auth', r'authentication[ _-]*failed|invalid credentials|invalid[_ -]grant|login failed|unauthori[sz]ed|forbidden|HTTP[ :]+(?:401|403)\b'),
    ('connect', r'connection[ _-]*(?:refused|reset|aborted)|\b(?:ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN)\b|network is (?:unreachable|down)|no route to host|temporary failure in name resolution|bridge socket is unavailable|bridge request failed'),
    ('json', r'jsondecodeerror|invalid json|json (?:parse|decode) error|unexpected (?:token|end).*json'),
    ('python_traceback', r'traceback \(most recent call last\):'),
))
_PATHS = re.compile(r'''"(?:[A-Za-z]:\\|/|\.\.?/|~/)[^"]*"|'(?:[A-Za-z]:\\|/|\.\.?/|~/)[^']*'|(?:[A-Za-z]:\\|/|\.\.?/|~/)[^\s'"<>]*''')


class StderrCause:
    def __init__(self):
        self.line, self.last, self.lines, self.rank = '', '', 0, len(_PATTERNS)

    def add(self, text):
        parts = text.split('\n')
        for i, part in enumerate(parts):
            text = self.line + part
            for rank, (_, pattern) in enumerate(_PATTERNS):
                if pattern.search(text):
                    self.rank = min(self.rank, rank)
            self.line = text
            if i < len(parts) - 1:
                self.lines += 1
                self.last, self.line = self.line.removesuffix('\r'), ''

    def props(self, timed_out=False):
        normalized = re.sub(r'\d+', '#', _PATHS.sub('<path>', self.line or self.last))
        return {'stderrClass': 'timeout' if timed_out else _PATTERNS[self.rank][0] if self.rank < len(_PATTERNS) else 'unknown',
                'stderrLines': self.lines + int(bool(self.line)),
                'stderrHash': hashlib.sha256(normalized.encode('utf-8', errors='replace')).hexdigest()[:16]}


def stderr_cause(text, timed_out=False):
    cause = StderrCause()
    cause.add(text.decode('utf-8', errors='replace') if isinstance(text, bytes) else text or '')
    return cause.props(timed_out)


def _capture_stderr(cause):
    """Observe fd 2 as well as Python writes, including inherited subprocess stderr."""
    import codecs
    import select
    import sys
    import threading
    from contextlib import contextmanager

    @contextmanager
    def capture():
        saved, sink, reader, writer = None, None, None, None
        try:
            sys.stderr.flush()
            saved = os.dup(2)
            sink = os.dup(saved)
            reader, writer = os.pipe()
        except OSError:
            for fd in (saved, sink, reader, writer):
                if fd is not None:
                    os.close(fd)
            yield
            return
        stopped = threading.Event()

        def copy():
            decode = codecs.getincrementaldecoder('utf-8')('replace')
            try:
                while True:
                    ready, _, _ = select.select([reader], [], [], .01)
                    if ready:
                        chunk = os.read(reader, 8192)
                        if not chunk:
                            break
                        try:
                            cause.add(decode.decode(chunk))
                        except Exception:
                            pass
                        view = memoryview(chunk)
                        while view:
                            view = view[os.write(sink, view):]
                    if stopped.is_set() and not ready:
                        break
                cause.add(decode.decode(b'', final=True))
            except Exception:
                pass
            finally:
                os.close(reader)
                os.close(sink)

        worker = threading.Thread(target=copy, daemon=True)
        try:
            worker.start()
        except RuntimeError:
            for fd in (saved, sink, reader, writer):
                os.close(fd)
            yield
            return
        try:
            os.dup2(writer, 2)
            os.close(writer)
            yield
        finally:
            sys.stderr.flush()
            os.dup2(saved, 2)
            os.close(saved)
            stopped.set()
            # Detached descendants may keep fd 2 open. Never hold the helper open for them.
            worker.join(timeout=.1)

    return capture()


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
            file_event = entry['name'] in ('data_read.retried', 'data_read.failed', 'data_write.retried',
                                           'data_write.failed', 'runs_log.write_failed')
            # Only triage supplies a bounded, credential-redacted classifier diagnostic.
            if (entry['component'] == 'triage' and entry['name'] == 'triage.classify' and key == 'classifier_error'
                    and type(value) is str and len(value) <= 400 and not any(ord(c) < 32 for c in value)):
                props[key] = value
            elif file_event and key == 'path' and type(value) is str and len(value) <= 1024 and value.startswith('/') and not any(ord(c) < 32 for c in value):
                props[key] = value
            elif file_event and key in ('attempts', 'ms') and _finite(value) and value >= 0:
                props[key] = value
            elif file_event and key == 'dataless' and type(value) is bool:
                props[key] = value
            elif key in ('exitCode', 'signal') and value is None:
                props[key] = None
            elif key == 'stderrLines' and type(value) is int and 0 <= value <= 2 ** 53 - 1:
                props[key] = value
            elif key == 'stderrHash' and type(value) is str and re.fullmatch(r'[a-f0-9]{16}', value):
                props[key] = value
            elif key == 'errnoCode' and type(value) is str and value in _ERRNO:
                props[key] = value
            elif key == 'signal' and type(value) is str and value in _SIGNALS:
                props[key] = value
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


def tool_error(component, tag, ids=None, props=None):
    try:
        if not _token(component) or not _token(tag):
            return
        tool_log({'component': component, 'kind': 'error', 'name': component + '.error',
                  'ok': False, 'ids': ids, 'props': props, 'error': {'tag': tag}})
    except Exception:
        pass


def helper_main(name, fn, *args):
    """Keep each helper's result/exception intact while recording its process boundary."""
    import time
    import sys
    import traceback
    started, code, cause = time.perf_counter(), 0, StderrCause()
    try:
        with _capture_stderr(cause):
            result = fn(*args)
        if type(result) is int:
            code = result
        return result
    except SystemExit as error:
        code = error.code if type(error.code) is int else 0 if error.code is None else 1
        if type(error.code) is str:
            try:
                cause.add(error.code + '\n')
            except Exception:
                pass
        raise
    except BaseException as error:
        code = 1
        try:
            cause.add(''.join(traceback.format_exception(type(error), error, error.__traceback__)))
        except Exception:
            pass
        raise
    finally:
        try:
            tool_log({'component': 'helpers', 'kind': 'perf' if code == 0 else 'error', 'name': 'helper.run',
                      'durationMs': (time.perf_counter() - started) * 1000, 'ok': code == 0,
                      'ids': {'helper': name, 'watcher': os.environ.get('WATCH_ID')},
                      'props': {'exitCode': code, **(cause.props() if code else {})},
                      **({'error': {'tag': 'helper.exit_failed'}} if code else {})})
        except Exception:
            pass


def _main():
    # Shell stderr stays in a pipe, never a scratch file or log. Stdout and stdin are inherited.
    import sys
    if len(sys.argv) > 3 and sys.argv[1] == '--shell-helper' and sys.argv[3] == '--':
        import codecs
        import subprocess
        import time
        name, cause, started = sys.argv[2], StderrCause(), time.perf_counter()
        child = subprocess.Popen(['/bin/zsh', '-f', *sys.argv[4:]], stderr=subprocess.PIPE)
        decode = codecs.getincrementaldecoder('utf-8')('replace')
        while True:
            chunk = os.read(child.stderr.fileno(), 8192)
            if not chunk:
                break
            try:
                cause.add(decode.decode(chunk))
            except Exception:
                pass
            sys.stderr.buffer.write(chunk)
            sys.stderr.buffer.flush()
        cause.add(decode.decode(b'', final=True))
        code = child.wait()
        try:
            tool_log({'component': 'helpers', 'kind': 'perf' if code == 0 else 'error', 'name': 'helper.run',
                      'durationMs': (time.perf_counter() - started) * 1000, 'ok': code == 0,
                      'ids': {'helper': name, 'watcher': os.environ.get('WATCH_ID')},
                      'props': {'exitCode': code, **(cause.props() if code else {})},
                      **({'error': {'tag': 'helper.exit_failed'}} if code else {})})
        except Exception:
            pass
        if code < 0:
            if -code not in (signal.SIGKILL, signal.SIGSTOP):
                signal.signal(-code, signal.SIG_DFL)
            os.kill(os.getpid(), -code)
        sys.exit(code)
    # Legacy metadata-only caller; no stderr was supplied.
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
                  'props': {'exitCode': args.exit_code, **(stderr_cause('') if args.exit_code else {})},
                  **({'error': {'tag': 'helper.exit_failed'}} if args.exit_code else {})})
    except BaseException:
        pass


if __name__ == '__main__':
    _main()
