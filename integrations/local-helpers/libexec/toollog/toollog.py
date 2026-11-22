"""Private, best-effort tool metrics and the shared nightly reader. Stdlib only."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import contextlib
import json
import math
import os
from pathlib import Path
import re
import hashlib
import time
import struct
import random
import sys
import tempfile
from functools import lru_cache

# Keep iMessage class names in sync with spectrum-bridge/src/log-error.ts.
_IMESSAGE_ERROR_NAMES = frozenset('Error TypeError RangeError ReferenceError SyntaxError URIError EvalError AggregateError IMessageError APIError FetchError HTTPError NetworkError ZodError AbortError TimeoutError BoundedTimeout SystemError SQLiteError SqliteError DOMException JudgeError TransportError PublishError CliError SttError SecretError ShareError HttpError ApiError ControlError LineError SendblueError ValidationError UnknownError'.split())

CAP_BYTES = 50 * 1024 * 1024
HOOKS_CAP_BYTES = 35 * 1024 * 1024
HOOK_SAMPLE_RATE = 128
# Hook rows slower than this carry measured phase timings and are never sampled
# or capped out: they are rare and they are the rows a latency card needs.
SLOW_HOOK_MS = 2000
# Measured spans inside one hook call. Callers time them with a monotonic clock;
# a phase a writer cannot measure is left out, never estimated.
HOOK_PHASES = ('identity_ms', 'lineage_ms', 'classify_ms', 'guard_ms', 'live_db_ms', 'remote_scan_ms', 'desktop_ms',
               'lock_wait_ms', 'log_write_ms', 'mask_ms', 'spawn_ms')
_SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
_LABEL = re.compile(r"[A-Za-z0-9_.:-]{1,120}\Z")
_ID_VALUE = re.compile(r"[A-Za-z0-9_.:%/-]{1,300}\Z")
# Data is allowlisted at the boundary; raw commands, prompts and exception text
# cannot accidentally become metadata when a caller passes its input dictionary.
_FIELDS = {'harness', 'guard', 'decision', 'rule', 'firstWord', 'commandLength',
           'filesChanged', 'driftFound', 'differingCount', 'platform', 'billedMinutes',
           'exitCode', 'failingStep', 'count', 'dryRun', 'toolCount', 'operation', 'status',
           'cwdClass', 'matchedRoot', 'argv0Class', 'repeatCount', 'threadIdSource',
           'method', 'toolName', 'load1', 'load5', 'load15', 'sampleRate',
           'httpMethod', 'ttfbMs', 'reason', 'identity_source', 'driver', 'route', 'httpStatus',
           'resolution', 'attempt', 'command', 'attempts', 'waitedMs',
           'classifier', 'errorClass', 'failMode', 'spawnMs', 'classifyMs', 'totalMs', 'cmdKind',
           'holder', 'adbVerb', 'source', 'cmdShape', 'project', *HOOK_PHASES}
_IDS = {'sessionId', 'threadId', 'nativeAgentId', 'cardNumber', 'serverId', 'home', 'sampleId'}
_WORDS = set('git rg grep find ls cat cp mv rm python python3 node bun npm pnpm yarn vp go cargo rustc make docker offbox bash sh zsh curl sqlite3 terraform aws rcsim runcloud printf echo env sudo'.split())


def command_props(command):
    if not isinstance(command, str):
        return {}
    match = re.match(r"\s*([A-Za-z0-9_./+-]+)(?=\s|$)", command)
    word = match.group(1).rsplit('/', 1)[-1] if match else ''
    first = word if word in _WORDS else 'other'
    argv_class = ('search' if first in {'rg', 'grep', 'find'} else
                  'interpreter' if first in {'python', 'python3', 'node', 'bun', 'bash', 'sh', 'zsh'} else
                  'package-manager' if first in {'npm', 'pnpm', 'yarn', 'vp'} else
                  'build' if first in {'go', 'cargo', 'rustc', 'make'} else first if first in {
                      'git', 'docker', 'offbox', 'sqlite3'} else 'other')
    return {'firstWord': first, 'argv0Class': argv_class, 'commandLength': len(command)}


# A command shape is a skeleton of a refused command for grouping refusals. It
# fails closed: the only literal text it keeps is operators, env var names, one
# or two-letter flags, and words from fixed vocabularies (programs, subcommands,
# file extensions, --long options, long single-dash options). Everything else, including any
# word it cannot place, becomes a placeholder. The output alphabet has no '/',
# quotes or backslashes, and _SHAPE_TEXT rejects anything else at the log boundary.
_SHAPE_TEXT = re.compile(r"[A-Za-z0-9 _.:=<>+|&;()$`,-]{1,240}\Z")
# Backslash escapes stay inside their word, so `super\;secret` is one argument, not two commands.
_SHAPE_TOKENS = re.compile(r"""'[^']*'?|"(?:\\.|[^"\\])*"?|\$\(|`|&&|\|\||<<<|<<-?|&>>?|[0-9]*>>?(?:&[0-9-]?)?|<|[|;&()]|(?:\\.|[^\s'"`|;&()<>\\])+""", re.S)
_HEREDOC_START = re.compile(r"(?<!<)<<(?!<)(-?)")
_HEREDOC_WORD = re.compile(r"""\s*(?:'([^']*)'|"([^"]*)"|((?:\\.|[^\s;&|<>()'"\\])+))""")
_SHAPE_PROGRAMS = frozenset('''
alias apw awk aws az base64 basename bash bat brew bun bunx cargo cat cd chmod chown cliq clickhouse-client cmp
codesign column comm command cp curl cut date defaults deno df diff dig dirname docker du echo env eslint eval
exec export expr false fd fdbcli ffmpeg file find fj gcloud gh git go gradle grep gunzip gzip head helm hlog
hostname id jest jq kill kubectl launchctl less linctl ln ls lsof make man mdfind mkdir mktemp mv mvn mysql nc nice
node nohup npm npx offbox open openssl osascript perl pgrep php pip pipx pkill plutil pnpm poetry popd
prettier printenv printf ps psql pushd pwd python rclone read readlink realpath redis-cli restic rg rm rmdir
rsync ruby rustc say scp security sed seq set sh shasum sips sleep sort source sqlite ssh stat sudo swift
t3ctl tail tailname tailscale tar tee terraform test time timeout touch tr true tsc type uname uniq unset
unzip uv uvx vitest vp wait wc which whoami xargs xcodebuild xcrun yarn yq zip zsh
'''.split())
_SHAPE_PROGRAM_VERSION = re.compile(r"([a-z][a-z-]*?)(?:[0-9]+(?:\.[0-9]+)*)?\Z")
_SHAPE_EXTENSION = re.compile(r"\.([A-Za-z][A-Za-z0-9]{0,7})\Z")
_SHAPE_EXTENSIONS = frozenset('''bash c cjs conf cpp css csv db env go gz h html ini java jpg js json jsonl jsx
kt log lua md mjs ndjson patch pdf php pl png py qnt rb rs sh sql sqlite sqlite3 svg swift tar tgz toml ts tsx
txt wal xml yaml yml zip zsh'''.split())
# Long option names also come from a fixed list; others read --<opt> (with =<v> kept).
_SHAPE_LONG_OPTIONS = frozenset('''all allow-empty background bg board build cached check config count cwd day db
debug depth detach dev dir directory dry-run env exclude file files filter fix fixed-strings force format
frozen-lockfile global glob grep help hidden home-dir host ignore-case include interactive json kind limit
line-number list max-depth name name-only no-cache no-pager no-verify oneline only-matching out output pattern
porcelain port prefix preload print project quiet read-only readonly recursive reporter rm root rule run save-dev
share short silent size staged stat status step table test-name-pattern timeout top tty type verbose version
watch word-regexp workspace write yes'''.split())
# One or two letters (-u, -rf) or a known long single-dash option; an attached
# value (-psecret, -usecret) is never a flag name.
_SHAPE_SHORT_FLAG = re.compile(r"-[A-Za-z]{1,2}\Z")
_SHAPE_DASH_WORDS = frozenset('''-name -iname -path -ipath -type -exec -execdir -print -print0 -delete -maxdepth
-mindepth -newer -mtime -mmin -size -not -and -or -prune -empty -version -help'''.split())
# Words after the program survive only from this fixed subcommand vocabulary, so
# an argument (echo hunter2) can never pass as a subcommand.
_SHAPE_VOCABULARY = frozenset('''add api apply build check checkout cherry-pick clean clone close commit compose
config create deploy describe destroy dev diff discover down edit exec export fetch fmt format generate get
images import info init inspect install issue kill lint list log logs ls ls-files merge mod new open plan pip
pr preview ps pull push query read rebase release remove reset restart restore rev-parse rm run serve set show
start stash status stop switch sync tag test tidy typecheck uninstall unittest unset up update upgrade validate
vet view wait watch worktree pytest'''.split())
_SHAPE_SEPARATORS = {'&&', '||', '|', ';', '&', '(', ')', '$(', '`'}
# These run the next word as a command, so it is shaped as a program again.
_SHAPE_WRAPPERS = frozenset('env sudo timeout nohup xargs time exec command nice'.split())
# After `--` these run a command too (`offbox run -- vp test`); elsewhere `--` only ends options.
_SHAPE_RUNNERS = _SHAPE_WRAPPERS | frozenset('offbox uv npx bunx pipx poetry'.split())
_SHAPE_GLOB = re.compile(r"[*?\[]")
_SHAPE_ASSIGNMENT = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)=")
_SHAPE_ENV_NAME = re.compile(r"[A-Z_][A-Z0-9_]{0,40}\Z")


def _shape_program(name):
    """The program name when it (minus a version suffix like python3.15) is a known tool, else None."""
    if name in _SHAPE_PROGRAMS:
        return name
    match = _SHAPE_PROGRAM_VERSION.fullmatch(name) if len(name) <= 40 else None
    return name if match and match[1] in _SHAPE_PROGRAMS else None


def _shape_path(extension):
    suffix = extension[1].lower()
    return f'<path.{suffix}>' if suffix in _SHAPE_EXTENSIONS else '<path>'


def _shape_word(token, slot):
    if token[0] in '\'"':
        return '<qvar>' if token[0] == '"' and '$' in token else '<q>'
    if '\\' in token:
        return '<w>'
    if '$' in token:
        return '<var>'
    if _SHAPE_GLOB.search(token):
        return '<glob>'
    if token[0].isdigit() or token[0] == '-' and token[1:2].isdigit():
        return '<n>'
    if token[0] == '-' and token != '-':
        name, equals, _ = token.partition('=')
        if name.startswith('--'):
            return ('--' + name[2:] if name[2:] in _SHAPE_LONG_OPTIONS else '--<opt>') + ('=<v>' if equals else '')
        known = not equals and (_SHAPE_SHORT_FLAG.match(name) or name in _SHAPE_DASH_WORDS)
        return name if known else '<flag>'
    tail = token.rstrip('/').rsplit('/', 1)[-1]
    extension = _SHAPE_EXTENSION.search(tail)
    if '/' in token or token[0] in '~.':
        if slot == 0 and not extension and _shape_program(tail):
            return tail
        return _shape_path(extension) if extension else '<path>'
    if slot == 0:
        return _shape_program(token) or (_shape_path(extension) if extension else '<cmd>')
    if extension:
        return _shape_path(extension)
    return token if slot <= 2 and token in _SHAPE_VOCABULARY else '<w>'


def _strip_heredoc_bodies(text):
    """Drop heredoc bodies. A delimiter that cannot be read, or a body whose
    terminator never appears exactly, drops everything after it."""
    kept, pending = [], []
    for line in text.split('\n'):
        if pending:
            delimiter, strip_tabs = pending[0]
            if delimiter is not None and (line.lstrip('\t') if strip_tabs else line) == delimiter:
                pending.pop(0)
            continue
        kept.append(line)
        for start in _HEREDOC_START.finditer(line):
            word = _HEREDOC_WORD.match(line, start.end())
            delimiter = None
            # Mixed quoting (E"O"F) is not parsed; leaving it unreadable drops the rest.
            if word and not line[word.end():word.end() + 1] in ('"', "'"):
                delimiter = word[1] if word[1] is not None else word[2] if word[2] is not None else re.sub(r'\\(.)', r'\1', word[3])
            pending.append((delimiter or None, bool(start[1])))
    return ' ; '.join(line for line in kept if line.strip()), bool(pending)


def command_shape(command):
    """Privacy-reduced skeleton of a command for grouping refusals, or None."""
    if not isinstance(command, str) or not command.strip():
        return None
    text = command[:4000].replace('\\\n', ' ')
    truncated = len(command) > 4000
    if '\n' in text:
        text, unterminated = _strip_heredoc_bodies(text)
        truncated |= unterminated
    out = []
    slot, program, assignments_done, target = 0, None, False, None
    for token in _SHAPE_TOKENS.findall(text):
        if token in _SHAPE_SEPARATORS:
            if token == ')' and out and out[-1] == ';':
                out.pop()
            if not (token == ';' and (not out or out[-1] in _SHAPE_SEPARATORS)):
                out.append(token)
            slot, program, assignments_done, target = 0, None, False, None
            continue
        if token[0] in '<>&' or token[0].isdigit() and '>' in token:
            target = 'heredoc' if token.startswith('<<') and token != '<<<' else 'redirect'
            out.append('<<' if target == 'heredoc' else '<<<' if token == '<<<' else
                       '<' if token == '<' else '>&' if '&' in token else '>')
            continue
        if target:
            out.append('<delim>' if target == 'heredoc' else _shape_word(token, 3))
            target = None
            continue
        if token == '--':
            out.append('--')
            if program in _SHAPE_RUNNERS:
                slot, program, assignments_done = 0, None, False
            continue
        assignment = _SHAPE_ASSIGNMENT.match(token) if not assignments_done and slot == 0 else None
        if assignment:
            out.append(f'{assignment[1]}=<v>' if _SHAPE_ENV_NAME.match(assignment[1]) else '<assign>')
            continue
        assignments_done = True
        word = _shape_word(token, slot)
        if slot == 0 and word in _SHAPE_WRAPPERS:
            program, assignments_done = word, False
        elif token[0] == '-' and token != '-' and not token[1:2].isdigit():
            pass
        elif not (slot == 0 and word == '<n>'):
            if slot == 0:
                program = word
            slot += 1
        if word.startswith('<') and out and out[-1].rstrip('+') == word:
            out[-1] = word + '+'
        else:
            out.append(word)
        if len(out) >= 32:
            truncated = True
            break
    while out and out[-1] in {';', '&'}:
        out.pop()
    if truncated and out:
        out.append('...')
    shape = ' '.join(out)
    if len(shape) > 240:
        shape = shape[:236].rsplit(' ', 1)[0] + ' ...'
    return shape if shape and _SHAPE_TEXT.fullmatch(shape) else None


def hook_props(props, *, error=False):
    """Absent optional fields retain their defaults; errors retain all context."""
    result = dict(props)
    if error or props.get('decision') not in {'allowed', 'rewritten'}:
        return result
    for key, defaults in {'argv0Class': ('none', ''), 'matchedRoot': ('none', ''),
                          'repeatCount': (0, 1), 'firstWord': ('',),
                          'commandLength': (0,), 'cwdClass': ('other', '')}.items():
        if key in result and (result[key] is None or result[key] in defaults):
            del result[key]
    # Independent sampling also works for one-shot native hook processes.
    result['sampleRate'] = HOOK_SAMPLE_RATE
    return result


def cwd_class(cwd):
    return _cwd_class(cwd) if isinstance(cwd, str) and cwd else 'other'


@lru_cache(maxsize=256)
def _cwd_class(cwd):
    path = os.path.abspath(os.path.expanduser(cwd))
    current = path
    for _ in range(32):
        git = os.path.join(current, '.git')
        if os.path.isfile(git):
            return 'worktree'
        if os.path.isdir(git):
            return 'repo-root'
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    home = str(Path.home())
    return 'home' if path == home or path.startswith(home + os.sep) else 'other'


def cwd_project(cwd):
    """Folder name of the git repository holding cwd (the main checkout for a worktree), or None."""
    return _cwd_project(cwd) if isinstance(cwd, str) and cwd else None


@lru_cache(maxsize=256)
def _cwd_project(cwd):
    current = os.path.abspath(os.path.expanduser(cwd))
    for _ in range(32):
        git = os.path.join(current, '.git')
        if os.path.isdir(git):
            name = os.path.basename(current)
            break
        if os.path.isfile(git):
            # Worktrees point at <repo>/.git/worktrees/<name>; report the repository, not the task branch.
            try:
                with open(git, encoding='utf-8') as source:
                    pointer = source.read(4096).strip()
            except (OSError, UnicodeError):
                pointer = ''
            target = pointer[8:].strip() if pointer.startswith('gitdir: ') else ''
            repo, marker, _ = target.rpartition('/.git/worktrees/')
            name = os.path.basename(repo) if marker else os.path.basename(current)
            break
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent
    else:
        return None
    return name if _LABEL.fullmatch(name or '') else None


def matched_root(root):
    if root is not None and not isinstance(root, str):
        return 'other'
    return {'/': 'filesystem', '/Users/ardud': 'home', '/Volumes/ExternalSSD': 'external',
            '/Volumes/ExternalSSD/board-wt': 'board-worktrees'}.get(root, 'none' if root is None else 'other')


def _hook_id(value):
    if not isinstance(value, str) or not value:
        return None
    # Robob thread IDs encode their project path. Other path-shaped inputs are
    # opaque fingerprints, never paths copied from hook stdin or environment.
    if (_LABEL.fullmatch(value) or value.startswith('thread:project:') and re.fullmatch(r'[A-Za-z0-9_.:%-]{1,300}', value)):
        return value
    return 'sha256:' + hashlib.sha256(value.encode()).hexdigest()[:32]


def hook_ids(harness, ids=None):
    values = ids or {}
    session = _hook_id(values.get('sessionId'))
    agent = _hook_id(values.get('nativeAgentId'))
    thread = _hook_id(values.get('threadId') or os.environ.get('ROBOB_THREAD_ID'))
    source = 'robob' if thread else 'native' if session else 'unknown'
    native = f'native:{harness}:{session}' + (f':{agent}' if agent else '')
    result = {'threadId': thread or (native if session else f'unknown:{harness}')}
    if session:
        result['sessionId'] = session
    if agent:
        result['nativeAgentId'] = agent
    card = values.get('cardNumber') or os.environ.get('ROBOB_CARD_NUMBER')
    if type(card) is int and card > 0 or isinstance(card, str) and re.fullmatch(r'[1-9][0-9]{0,8}', card):
        result['cardNumber'] = int(card)
    return result, source


def _repeat_count(harness, ids, guard, rule, first_word):
    if ids['threadId'].startswith('unknown:'):
        return 1
    # Hooks are short-lived processes. A small per-key sidecar survives the next
    # invocation without reading the day log. Counts are best effort on overlap;
    # no lock or logging failure may delay a policy decision.
    try:
        directory = board_dir('agent-tools')
        now = time.time()
        day = datetime.fromtimestamp(now, timezone.utc).strftime('%Y-%m-%d')
        key = hashlib.sha256('\0'.join([harness, ids.get('sessionId') or ids['threadId'], ids.get('nativeAgentId', ''), guard, rule, first_word]).encode()).hexdigest()[:32]
        path = directory / (f'.repeat-{day}-{key}.bin')
        try:
            fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        except FileNotFoundError:
            _private_dir(directory)
            fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            data = os.pread(fd, 16, 0)
            if not data and now % 86400 < 60:
                yesterday = datetime.fromtimestamp(now - 86400, timezone.utc).strftime('%Y-%m-%d')
                try:
                    with open(directory / (f'.repeat-{yesterday}-{key}.bin'), 'rb') as previous:
                        data = previous.read(16)
                except OSError:
                    pass
            at, previous_count = struct.unpack('!dQ', data) if len(data) == 16 else (0, 0)
            count = previous_count + 1 if 0 <= now - at <= 60 else 1
            # Fixed-size records avoid JSON parsing and a separate truncate on
            # every short-lived hook. Only timestamps and counts are persisted.
            os.pwrite(fd, struct.pack('!dQ', now, count), 0)
        finally:
            os.close(fd)
        return count
    except Exception:
        return 1


_test_root = None


def root():
    global _test_root
    override = os.environ.get('TOOLLOG_ROOT')
    if override:
        return Path(override)
    if ('unittest' in sys.modules or 'pytest' in sys.modules or
            os.environ.get('NODE_ENV') == 'test' or os.environ.get('ROBOB_TEST')):
        if _test_root is None:
            _test_root = tempfile.TemporaryDirectory(prefix='helpers-test-logs-')
        os.environ['TOOLLOG_ROOT'] = _test_root.name
        return Path(_test_root.name)
    return Path.home() / '.robob/logs/tools'


def board_dir(board):
    if not isinstance(board, str) or not _SLUG.fullmatch(board):
        raise ValueError('invalid board slug')
    return root() / board


def _private_dir(path):
    if not path.exists():
        if not path.parent.exists():
            _private_dir(path.parent)
        path.mkdir(mode=0o700, exist_ok=True)
    os.chmod(path, 0o700)


def _claim(path):
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        return True
    except FileExistsError:
        return False


def _append(path, row):
    data = (json.dumps(row, separators=(',', ':'), allow_nan=False) + '\n').encode()
    fd = os.open(path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, data)
    finally:
        os.close(fd)


def _metadata(values, keys):
    result = {}
    for key, value in (values or {}).items():
        if key not in keys:
            continue
        if key in ('cmdShape', 'project') and keys is _FIELDS:
            if isinstance(value, str) and (_SHAPE_TEXT if key == 'cmdShape' else _LABEL).fullmatch(value):
                result[key] = value
            continue
        if type(value) is bool or type(value) in (int, float) and math.isfinite(value):
            result[key] = value
        elif key == 'reason' and isinstance(value, str):
            result[key] = value[:120]
        elif isinstance(value, str) and (re.fullmatch(r"[A-Za-z/:]{1,80}", value) if key == 'method'
                                       else (_ID_VALUE if keys is _IDS else _LABEL).fullmatch(value)):
            result[key] = value
    return result


def emit(component, kind, name, *, board='agent-tools', duration_ms=None, ok=None,
         ids=None, props=None, error_tag=None):
    """Drop write failures. Error messages are fixed tags, never exception messages."""
    try:
        if kind not in {'event', 'perf', 'error', 'opencode-reload'} or not _LABEL.fullmatch(component) or not _LABEL.fullmatch(name):
            return
        now = datetime.now(timezone.utc)
        day = now.strftime('%Y-%m-%d')
        directory = board_dir(board)
        _private_dir(directory)
        if _claim(directory / ('.retained-' + day)):
            cutoff = (now.date() - timedelta(days=30)).isoformat()
            for path in directory.iterdir():
                date = re.fullmatch(r'(?:rollup-|\.retained-|\.cap-(?:hooks-)?|\.repeat-)?(\d{4}-\d{2}-\d{2})(?:-[a-f0-9]{32})?(?:\.ndjson|\.json|\.bin)?', path.name)
                if date and date[1] < cutoff:
                    try:
                        path.unlink()
                    except OSError:
                        pass
        row = {'ts': now.isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
               'tool': board, 'component': component, 'kind': kind, 'name': name}
        if type(duration_ms) in (int, float) and math.isfinite(duration_ms) and duration_ms >= 0:
            row['durationMs'] = round(duration_ms, 3)
        if type(ok) is bool:
            row['ok'] = ok
        for key, value in [('ids', _metadata(ids, _IDS)), ('props', _metadata(props, _FIELDS))]:
            if value:
                row[key] = value
        if kind == 'opencode-reload':
            # This event intentionally carries file paths and hashes, never bytes.
            reload = props or {}
            files = reload.get('files', [])
            busy = reload.get('busy', {})
            if (component != 'installers' or name != 'opencode-reload'
                    or not _SLUG.fullmatch(reload.get('installer', ''))
                    or not isinstance(files, list) or not files
                    or not isinstance(busy, dict)
                    or type(reload.get('waited_ms')) is not int or reload['waited_ms'] < 0
                    or type(reload.get('allow_reload')) is not bool):
                return
            for item in files:
                if (not isinstance(item, dict) or not isinstance(item.get('path'), str)
                        or not os.path.isabs(item['path']) or any(
                            item.get(key) is not None and not re.fullmatch(r'[a-f0-9]{64}', item[key])
                            for key in ('sha256_before', 'sha256_after'))):
                    return
            if any(not _LABEL.fullmatch(key) or not (type(value) is int and value >= 0 or value == 'unknown')
                   for key, value in busy.items()):
                return
            row['props'] = {key: reload[key] for key in ('installer', 'busy', 'waited_ms', 'allow_reload')}
            row['props']['files'] = [{key: item[key] for key in ('path', 'sha256_before', 'sha256_after')}
                                     for item in files]
        if error_tag:
            tag = error_tag if isinstance(error_tag, str) and _LABEL.fullmatch(error_tag) else 'other'
            row['error'] = {'tag': tag, 'message': tag}
        path = directory / (day + '.ndjson')
        try:
            size = path.stat().st_size
        except FileNotFoundError:
            size = 0
        caps = [('all', CAP_BYTES, '.cap-')]
        if component == 'hooks':
            caps.append(('hooks', HOOKS_CAP_BYTES, '.cap-hooks-'))
        for scope, cap, claim_prefix in caps:
            if size >= cap:
                if _claim(directory / (claim_prefix + day)):
                    _append(path, {**{k: row[k] for k in ('ts', 'tool', 'component')},
                                   'kind': 'error', 'name': 'log.cap', 'ok': False,
                                   'props': {'component': scope, 'capBytes': cap},
                                   'error': {'tag': 'log.cap', 'message': 'Daily log cap reached'}})
        if (kind != 'error' and not _slow_hook(row)
                and (size >= CAP_BYTES or component == 'hooks' and size >= HOOKS_CAP_BYTES)):
            return
        rate = _sample_rate(row)
        if rate > 1 and random.random() >= 1 / rate:
            return
        _append(path, row)
    except Exception:
        pass


def _is_slow(duration_ms):
    # Compare the value emit() writes, so the writer and the cap agree at the boundary.
    return (type(duration_ms) in (int, float) and math.isfinite(duration_ms)
            and round(duration_ms, 3) > SLOW_HOOK_MS)


def _slow_hook(row):
    return row.get('name') == 'hook.decision' and _is_slow(row.get('durationMs'))


def phase_props(duration_ms, phases):
    """Integer phase fields for a slow hook row; nothing for a fast one."""
    if not _is_slow(duration_ms):
        return {}
    return {key: int(round(value)) for key, value in (phases or {}).items()
            if key in HOOK_PHASES and type(value) in (int, float) and math.isfinite(value) and value >= 0}


def run_source():
    """'test' inside a test runner. Until #185 tags test runs, the environment is the only signal."""
    return 'test' if ('unittest' in sys.modules or 'pytest' in sys.modules or os.environ.get('NODE_ENV') == 'test'
                      or os.environ.get('ROBOB_TEST') or os.environ.get('PYTEST_CURRENT_TEST')) else 'real'


def hook(harness, guard, decision, rule, duration_ms, command=None, error_tag=None, ids=None, *, cwd=None, matched=None, identity_source=None, extra=None, phases=None):
    try:
        identity, source = hook_ids(harness, ids)
        command_fields = command_props(command)
        if decision in ('denied', 'rewritten'):
            shape = command_shape(command)
            if shape:
                command_fields['cmdShape'] = shape
            project = cwd_project(cwd)
            if project:
                command_fields['project'] = project
        if run_source() == 'test':
            # Lets refusalShapes drop rows from hook processes a test spawned
            # without isolating the log root (#185 owns the general fix).
            command_fields['source'] = 'test'
        if isinstance(identity_source, str) and identity_source in {'cache', 'control', 'negative-cache'}:
            command_fields['identity_source'] = identity_source
        timings = phase_props(duration_ms, phases)
        props = hook_props({**(extra or {}), 'harness': harness, 'guard': guard, 'decision': decision, 'rule': rule,
                    'threadIdSource': source, 'cwdClass': cwd_class(cwd), 'matchedRoot': matched_root(matched),
                    'repeatCount': _repeat_count(harness, identity, guard, rule, command_fields.get('firstWord', 'none')),
                    'argv0Class': 'none', **command_fields}, error=decision == 'denied' or bool(error_tag))
        if _is_slow(duration_ms):
            # Every slow row is written, so it weighs 1 in the rollup's estimates.
            props.pop('sampleRate', None)
        emit('hooks', 'error' if decision == 'denied' or error_tag else 'perf', 'hook.decision',
             duration_ms=duration_ms, ok=decision != 'denied' and not error_tag, ids=identity,
             props={**props, **timings},
             error_tag=error_tag or (rule if decision == 'denied' else None))
    except Exception:
        pass


def _read_records(board, day):
    # Validate dates before constructing paths, including dates supplied by another board.
    if datetime.strptime(day, '%Y-%m-%d').strftime('%Y-%m-%d') != day:
        raise ValueError('invalid UTC day')
    path = board_dir(board) / (day + '.ndjson')
    if not path.exists():
        return
    with path.open(encoding='utf-8') as source:
        for line_number, line in enumerate(source, 1):
            try:
                row = json.loads(line)
                if not isinstance(row, dict):
                    continue
                yield line_number, row
            except (ValueError, UnicodeError):
                continue


def read(board, day, kind=None, name=None):
    for _, row in _read_records(board, day):
        if kind and row.get('kind') != kind or name and row.get('name') != name:
            continue
        yield row


_UUID = r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}'
_ENCODED_ID = r"[A-Za-z0-9_.%~!*'()-]+"
# Control requests can use an encoded idempotency key instead of a UUID.
# Imports and MCP-created children also have stable, non-UUID IDs.
_ROBOB_THREAD = re.compile(
    rf'(?:{_UUID}|mcp:{_UUID}(?::fork)?|ardud-control:thread:{_ENCODED_ID}'
    rf'|ardud-opencode-import:thread:ses_[A-Za-z0-9]+'
    rf'|import:[A-Za-z0-9_.-]+:[A-Za-z0-9_.:%-]+'
    rf'|thread:project:[A-Za-z0-9_.:%-]+:{_UUID}'
    rf'|thread:mcp:{_ENCODED_ID}:{_ENCODED_ID}:[0-9]+'
    rf'|thread:delegated-task:{_ENCODED_ID})\Z')


def _hook_attempt(row):
    if row.get('name') != 'hook.decision':
        return None
    props, ids = row.get('props'), row.get('ids')
    if not isinstance(props, dict) or not isinstance(ids, dict):
        return None
    thread, rule, ts = ids.get('threadId'), props.get('rule'), row.get('ts')
    if not isinstance(thread, str) or not isinstance(rule, str):
        return None
    decision = props.get('decision')
    if 'decision' not in props and (row.get('kind') == 'error' or row.get('ok') is False):
        decision = 'denied'
    if decision not in ('denied', 'rewritten'):
        return None
    try:
        at = datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp() if isinstance(ts, str) else None
    except (ValueError, TypeError):
        at = None
    return thread, rule, decision, at


def _hook_weight(row):
    # Refusals normally have no sampling. Preserve unexpected estimates and
    # label them, even on error rows; the general totals retain their old rules.
    rate = row['props'].get('sampleRate')
    return rate if type(rate) is int and 1 <= rate <= 2**53 - 1 else 1


def _attributed_thread(thread):
    return bool(thread.startswith('native:') and thread[7:] or _ROBOB_THREAD.fullmatch(thread))


REFUSAL_SHAPE_CAP = 100
REFUSAL_RETRY_SECONDS = 300
_PROJECT_THREAD = re.compile(rf'thread:project:([A-Za-z0-9_.:%-]+):{_UUID}\Z')


def _thread_project(thread):
    """Project label for a refusal: the folder name a Robob thread ID encodes."""
    if thread.startswith('unknown:'):
        return 'unattributed'
    if thread.startswith('native:'):
        return 'native'
    match = _PROJECT_THREAD.fullmatch(thread)
    if not match:
        return 'unknown'
    from urllib.parse import unquote
    value = match[1]
    for _ in range(3):
        decoded = unquote(value)
        if decoded == value:
            break
        value = decoded
    name = value.rstrip('/').rsplit('/', 1)[-1].rsplit(':', 1)[-1]
    return name if _LABEL.fullmatch(name) else 'other'


def _row_shape(props):
    shape = props.get('cmdShape')
    if isinstance(shape, str) and _SHAPE_TEXT.fullmatch(shape):
        return shape, 'command'
    # Rows written before cmdShape existed still group by their fixed-vocabulary fields.
    first = props.get('firstWord')
    cwd = props.get('cwdClass')
    first = first if isinstance(first, str) and _LABEL.fullmatch(first) else 'none'
    return f"coarse:{first}" + (f" cwd:{cwd}" if isinstance(cwd, str) and _LABEL.fullmatch(cwd) else ''), 'coarse'


class _RefusalShapes:
    """Daily refusal counts by (rule, command shape); see refusal_shapes()."""

    def __init__(self, start, rule=None):
        from collections import defaultdict
        self.start, self.rule = start, rule
        self.groups = {}
        self.times = defaultdict(list)
        self.previous = defaultdict(list)
        self.excluded = self.coarse = 0

    def _accept(self, row, attempt):
        return attempt and not (self.rule and attempt[1] != self.rule)

    def add(self, row, attempt):
        from collections import Counter
        if not self._accept(row, attempt):
            return
        thread, rule, decision, at = attempt
        props = row['props']
        weight = _hook_weight(row)
        if props.get('source') == 'test':
            self.excluded += weight
            return
        shape, origin = _row_shape(props)
        self.coarse += weight * (origin == 'coarse')
        group = self.groups.get((rule, shape))
        if group is None:
            group = self.groups[(rule, shape)] = {
                'origin': origin, 'count': 0, 'denied': 0, 'rewritten': 0, 'unattributed': 0, 'retry': 0,
                'threads': set(), 'harness': Counter(), 'guard': Counter(), 'projects': Counter(), 'sampled': False}
        group['count'] += weight
        group[decision] += weight
        harness, guard = props.get('harness'), props.get('guard')
        group['harness'][harness if isinstance(harness, str) and _LABEL.fullmatch(harness) else 'unknown'] += weight
        group['guard'][guard if isinstance(guard, str) and _LABEL.fullmatch(guard) else 'unknown'] += weight
        project = props.get('project')
        group['projects'][project if isinstance(project, str) and _LABEL.fullmatch(project) else _thread_project(thread)] += weight
        if weight > 1:
            group['sampled'] = True
        if thread.startswith('unknown:'):
            # One unknown:<harness> bucket mixes many agents: neither a thread nor a retry.
            group['unattributed'] += weight
            return
        group['threads'].add(thread)
        if weight == 1 and at is not None:
            self.times[(thread, rule, shape)].append(at)

    def add_previous(self, row, attempt):
        """Rows from the previous UTC day supply only the retry window across midnight."""
        if not self._accept(row, attempt) or row['props'].get('source') == 'test' or _hook_weight(row) > 1:
            return
        thread, rule, _, at = attempt
        key = (thread, rule, _row_shape(row['props'])[0])
        if key in self.times and at is not None and self.start - REFUSAL_RETRY_SECONDS <= at < self.start:
            self.previous[key].append(at)

    def result(self, cap=REFUSAL_SHAPE_CAP):
        from collections import Counter
        for (thread, rule, shape), current in self.times.items():
            # A refusal repeated by the same thread within 5 minutes means the agent was stuck on it.
            merged = sorted([(at, False) for at in self.previous.get((thread, rule, shape), ())]
                            + [(at, True) for at in current])
            self.groups[(rule, shape)]['retry'] += sum(
                1 for (before, _), (at, today) in zip(merged, merged[1:])
                if today and 0 <= at - before <= REFUSAL_RETRY_SECONDS)
        def entry(group):
            return {'count': group['count'], 'denied': group['denied'], 'rewritten': group['rewritten'],
                    'distinctThreads': len(group['threads']), 'unattributed': group['unattributed'],
                    'retryWithin5m': group['retry'], 'harness': dict(sorted(group['harness'].items())),
                    'topProjects': [{'project': name, 'count': count} for name, count in
                                    sorted(group['projects'].items(), key=lambda x: (-x[1], x[0]))[:5]],
                    'sampled': group['sampled']}
        # Denials first: sampled rewrites are estimates and would otherwise bury them.
        ranked = sorted(self.groups.items(), key=lambda x: (-x[1]['denied'], -x[1]['count'], x[0]))
        shapes = [{'rule': rule, 'guard': group['guard'].most_common(1)[0][0], 'shape': shape,
                   'shapeSource': group['origin'], **entry(group)} for (rule, shape), group in ranked[:cap]]
        other = None
        if len(ranked) > cap:
            folded = {'count': 0, 'denied': 0, 'rewritten': 0, 'unattributed': 0, 'retry': 0, 'threads': set(),
                      'harness': Counter(), 'projects': Counter(), 'sampled': False}
            for _, group in ranked[cap:]:
                for key in ('count', 'denied', 'rewritten', 'unattributed', 'retry'):
                    folded[key] += group[key]
                folded['threads'] |= group['threads']
                folded['harness'].update(group['harness'])
                folded['projects'].update(group['projects'])
                folded['sampled'] |= group['sampled']
            other = {'shapes': len(ranked) - cap, **entry(folded)}
        return {'rows': sum(group['count'] for group in self.groups.values()), 'shapeCount': len(ranked),
                'coarseRows': self.coarse, 'excludedTestRows': self.excluded,
                'retryWindowSeconds': REFUSAL_RETRY_SECONDS, 'cap': cap, 'shapes': shapes, 'other': other}


def _sample_rate(row):
    props = row.get('props')
    rate = props.get('sampleRate') if isinstance(props, dict) else None
    # Errors are never sampled, including records from older or external writers.
    return rate if row.get('kind') != 'error' and type(rate) is int and 1 <= rate <= 2**53 - 1 else 1


_IMESSAGE_CALLS = {
    ('GET', '/health'): 'health', ('GET', '/projects'): 'projects', ('GET', '/threads'): 'threads',
    ('POST', '/threads'): 'createThread', ('GET', '/threads/:id'): 'thread', ('PATCH', '/threads/:id'): 'settle',
    ('GET', '/threads/by-native/:id'): 'byNative', ('GET', '/threads/:id/messages'): 'messages',
    ('GET', '/threads/:id/runs/:id/evidence'): 'runEvidence', ('POST', '/threads/:id/requests/:id/respond'): 'respond',
    ('POST', '/attachments'): 'attachment', ('PUT', '/threads/:id/origin'): 'origin',
    ('POST', '/threads/:id/send'): 'send', ('POST', '/threads/:id/interrupt'): 'interrupt',
}


def _imessage_call_name(row):
    props = row.get('props') if isinstance(row.get('props'), dict) else {}
    method, route = props.get('method'), props.get('route')
    return _IMESSAGE_CALLS.get((method, route)) if isinstance(method, str) and isinstance(route, str) else None


def _imessage_call_stats(row):
    # Same fixed operation names and millisecond histogram format as spectrum-bridge/src/log-calls.ts.
    if row.get('component') != 'robob' or row.get('name') != 'turn.robob_calls' or row.get('kind') != 'perf':
        return {}
    calls = row.get('calls')
    if not isinstance(calls, dict):
        return {}
    result = {}
    for name, stats in calls.items():
        if name not in _IMESSAGE_CALLS.values() or not isinstance(stats, dict):
            continue
        oks, failures, histogram = stats.get('ok'), stats.get('failed'), stats.get('histogram')
        if (type(oks) is not int or type(failures) is not int or oks < 0 or failures < 0
                or not 1 <= oks + failures <= 10_000_000 or not isinstance(histogram, list) or len(histogram) > 100_000):
            continue
        values = [(pair[0], pair[1]) for pair in histogram if isinstance(pair, list) and len(pair) == 2
                  and type(pair[0]) is int and 0 <= pair[0] <= 86_400_000
                  and type(pair[1]) is int and 1 <= pair[1] <= 10_000_000]
        if sum(count for _, count in values) == oks + failures:
            single = stats.get('singleFailures')
            if type(single) is not int or not 0 <= single <= failures:
                single = None
            result[name] = (oks, failures, values, single)
    return result


# Fixed vocabulary from spectrum-bridge/log-error.ts; never accept arbitrary code-shaped tokens.
_IMESSAGE_CAUSE_CODES = set("""
ABORT_ERR Aborted AbortedBeforeConnecting ClientAborted CompressionFailed ConnectionClosed
ConnectionRefused DNSResolutionFailed DNSResolveFailed EACCES EAI_AGAIN EBADF ECONNABORTED
ECONNREFUSED ECONNRESET EEXIST EHOSTUNREACH EINVAL EIO EISDIR EMFILE ENETUNREACH ENFILE ENOENT
ENOSPC ENOTDIR ENOTEMPTY ENOTFOUND EPERM EPIPE EROFS ERR_INVALID_ARG_TYPE ERR_INVALID_URL
ERR_SOCKET_CLOSED ERR_STREAM_PREMATURE_CLOSE ERR_TLS_CERT_ALTNAME_INVALID ETIMEDOUT
FailedToOpenSocket HPE_INVALID_CHUNK_SIZE HPE_INVALID_CONSTANT HTTP2CompressionError
HTTP2ContentLengthMismatch HTTP2EnhanceYourCalm HTTP2FlowControlError HTTP2FrameSizeError
HTTP2GoAway HTTP2HeaderListTooLarge HTTP2ProtocolError HTTP2RefusedStream HTTP2StreamReset
HTTP2Unsupported HTTP3ContentLengthMismatch HTTP3HandshakeFailed HTTP3HeaderEncodingError
HTTP3ProtocolError HTTP3StreamReset HTTP3Unsupported InvalidCRL InvalidContentLength
InvalidHTTPResponse InvalidRedirectURL InvalidURL Malformed_HTTP_Response ProxyConnectFailed
RedirectURLInvalid RedirectURLTooLong RequestBodyLengthMismatch RequestBodyNotReusable
ResponseHeadersTooLarge SQLITE_BUSY SQLITE_CANTOPEN SQLITE_CONSTRAINT SQLITE_ERROR SQLITE_LOCKED
SQLITE_READONLY ShortRead TLSHandshakeFailed Timeout TooManyRedirects UND_ERR_BODY_TIMEOUT
UND_ERR_CONNECT_TIMEOUT UND_ERR_HEADERS_OVERFLOW UND_ERR_HEADERS_TIMEOUT
UND_ERR_RES_CONTENT_LENGTH_MISMATCH UND_ERR_SOCKET UnexpectedData UnexpectedRedirect
UnrequestedUpgrade UnsupportedProtocol UnsupportedProxyProtocol UnsupportedRedirectProtocol
UnsupportedTransferEncoding WantRead WantWrite WriteFailed Z_DATA_ERROR ZlibError addressNotFound
attachmentNotFound attachmentNotReady attachmentTimeout attachmentTooLarge audioTooLarge
catchupIncomplete catchupTimeout chatNotFound closed contentDuplicateExceeded conversionFailed
dailyLimitExceeded databaseError duplicateMessage emptyAudio endpointOverride groupIconNotFound
internalError invalidApp invalidArgument invalidAttachment invalidAttachmentLimit invalidCredentials
invalidEffect invalidOperationId invalidOwner invalidOwnerChat invalidPoll invalidResponse
invalidServerUrl invalidTokenLifetime invalidTokenResponse jevFailed keyUnavailable messageNotFound
networkError operationNotSupported pollNotFound preconditionFailed privateApiUnavailable
recipientCoolingDown recipientLimitExceeded recipientLocked sendReceiveRatioExceeded
serviceUnavailable sharedFriendLocationNotFound sharedPlanRequired timeout tokenBlocked tokenExpired
tokenNetwork unauthenticated unauthorized unknownSendFailure uploadRateExceeded upload_failed
upload_url
""".split())
# Bun exposes a fixed node:os errno vocabulary; Python uses host-specific names and drops aliases.
_IMESSAGE_CAUSE_CODES.update("""
E2BIG EACCES EADDRINUSE EADDRNOTAVAIL EAFNOSUPPORT EAGAIN EALREADY EBADF
EBADMSG EBUSY ECANCELED ECHILD ECONNABORTED ECONNREFUSED ECONNRESET EDEADLK
EDESTADDRREQ EDOM EDQUOT EEXIST EFAULT EFBIG EHOSTUNREACH EIDRM
EILSEQ EINPROGRESS EINTR EINVAL EIO EISCONN EISDIR ELOOP
EMFILE EMLINK EMSGSIZE EMULTIHOP ENAMETOOLONG ENETDOWN ENETRESET ENETUNREACH
ENFILE ENOBUFS ENODATA ENODEV ENOENT ENOEXEC ENOLCK ENOLINK
ENOMEM ENOMSG ENOPROTOOPT ENOSPC ENOSR ENOSTR ENOSYS ENOTCONN
ENOTDIR ENOTEMPTY ENOTSOCK ENOTSUP ENOTTY ENXIO EOPNOTSUPP EOVERFLOW
EPERM EPIPE EPROTO EPROTONOSUPPORT EPROTOTYPE ERANGE EROFS ESPIPE
ESRCH ESTALE ETIME ETIMEDOUT ETXTBSY EWOULDBLOCK EXDEV
""".split())
_IMESSAGE_CAUSE_CODES.update('network bad_response no_handle no_media_url unsupported invalid_app_card card_preview_unavailable too_large download_failed lineFailure sendUnconfirmed'.split())
_IMESSAGE_CODE_ALIASES = {
    'ConnectionRefused': 'ECONNREFUSED', 'Timeout': 'ETIMEDOUT',
    'Malformed_HTTP_Response': 'HPE_INVALID_CONSTANT', 'InvalidHTTPResponse': 'HPE_INVALID_CHUNK_SIZE',
    'ResponseHeadersTooLarge': 'UND_ERR_HEADERS_OVERFLOW', 'InvalidContentLength': 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
    'ZlibError': 'Z_DATA_ERROR',
}
_IMESSAGE_PROVIDER_CODES = {'invalid_number', 'worker_unavailable', 'stop_opt_out', 'opted_out', '5504', 'provider_error'}


def _imessage_cause_key(value):
    if not isinstance(value, str):
        return None
    if value in {'prompt_acceptance_probe', 'background_watch', 'callsite_failure', 'TimeoutError', 'AbortError'}:
        return value
    if re.fullmatch(r'http\.[1-5]xx', value):
        return value
    prefix, _, code = value.partition('.')
    if prefix not in {'code', 'errno'}:
        return None
    if code in _IMESSAGE_CAUSE_CODES or re.fullmatch(r'(?:http|tokenHttp)[1-5]\d{2}', code):
        return value
    if re.fullmatch(r'-?(?:0|[1-9]\d{0,4})', code) and abs(int(code)) <= 65535:
        return value
    # Provider detail after an HTTP status is intentionally never copied.
    if re.fullmatch(r'http_[1-5][0-9]{2}(?::(?:invalid_number|worker_unavailable|stop_opt_out|opted_out|5504|provider_error))?', code):
        return value
    return None


def _imessage_error_code(value):
    if type(value) in (int, float) and abs(value) <= 65535 and math.isfinite(value) and value == int(value):
        return int(value)
    if not isinstance(value, str):
        return None
    if value in _IMESSAGE_CODE_ALIASES:
        return _IMESSAGE_CODE_ALIASES[value]
    http = re.fullmatch(r'http_([1-5][0-9]{2})([\s\S]*)', value)
    if http:
        detail = http[2].removeprefix(':')
        # Match safeLineFailureCode: provider text is reduced to a fixed vocabulary.
        suffix = ':' + (_imessage_provider_code(detail) or 'provider_error') if detail else ''
        return 'http_' + http[1] + suffix
    if value in _IMESSAGE_CAUSE_CODES or re.fullmatch(r'(?:http|tokenHttp)[1-5][0-9]{2}', value):
        return value
    return None


def _imessage_provider_code(value):
    if not isinstance(value, str) or len(value) > 40:
        return None
    key = value.lower()
    return 'stop_opt_out' if key == 'stop' else key if key in _IMESSAGE_PROVIDER_CODES else None


def _imessage_replayed_cause(row):
    # TS clean() rebuilds reduced error fields and ignores stored causeKey on replay.
    kind = row.get('kind')
    if kind not in ('error', 'perf', 'event') or not (kind == 'error' or row.get('name') == 'turn.robob_call' and row.get('ok') is False):
        return None
    for field in ('component', 'name'):
        label = row.get(field, 'undefined')
        label = 'null' if label is None else str(label).lower() if type(label) is bool else label
        if not isinstance(label, str) or not re.fullmatch(r'[a-zA-Z][a-zA-Z0-9_.-]{0,99}', label):
            return None
    error = row.get('error') if isinstance(row.get('error'), dict) else {}
    props = row.get('props') if isinstance(row.get('props'), dict) else {}
    source = error.get('cause') if isinstance(error.get('cause'), dict) else {}
    nested = source.get('cause') if isinstance(source.get('cause'), dict) else {}
    response = source.get('response') if isinstance(source.get('response'), dict) else {}
    tag = error.get('tag')
    tag = '' if tag is None else tag
    if not isinstance(tag, str):
        return None
    if re.match(r'^http_[1-5][0-9]{2}', tag):
        tag = _imessage_error_code(tag)
    elif tag.startswith('sendblue.'):
        tag = 'sendblue.' + (_imessage_provider_code(tag[9:]) or 'async_failure')
    tag_status = re.match(r'^http_([1-5][0-9]{2})', tag)
    fallback_name = ('ValidationError' if tag.startswith('form.') else 'SendblueError' if tag.startswith('sendblue.')
                     else 'HttpError' if tag_status else 'UnknownError') if isinstance(tag, str) else 'UnknownError'
    name = source.get('name') if source.get('name') is not None else error.get('name', fallback_name)
    name = name if isinstance(name, str) and name in _IMESSAGE_ERROR_NAMES else 'UnknownError'
    if tag == 'router.catch1' and props.get('causeKind') in ('timeout', 'http', 'transport'):
        return (tag, 'prompt_acceptance_probe')
    if name not in {'Error', 'UnknownError', 'TimeoutError', 'BoundedTimeout'}:
        return None
    tag = tag if re.fullmatch(r'[a-zA-Z][a-zA-Z0-9_.:-]{0,99}', tag) else 'operation.failed'
    fallback_code = error.get('code') if error.get('code') is not None else 'http_' + tag_status[1] if tag_status else None
    code = next((safe for value in [source.get('code'), nested.get('code'), fallback_code]
                 if (safe := _imessage_error_code(value)) is not None), None)
    number = next((safe for value in [source.get('errno'), nested.get('errno'), error.get('errno')]
                   if (safe := _imessage_error_code(value)) is not None), None)
    if code is not None:
        http = re.match(r'^(?:http_?|tokenHttp)([1-5])[0-9]{2}', code) if isinstance(code, str) else None
        key = 'http.' + http[1] + 'xx' if http else f'code.{code}'
    elif number is not None:
        key = f'errno.{number}'
    else:
        fallback_status = error.get('status')
        if fallback_status is None:
            fallback_status = int(tag_status[1]) if tag_status else props.get('status')
        status = next((value for value in [source.get('status'), source.get('statusCode'), response.get('status'), fallback_status]
                       if value is not None), None)
        if type(status) in (int, float) and 100 <= status <= 599 and math.isfinite(status) and status == int(status):
            key = f'http.{int(status) // 100}xx'
        else:
            key = {'router.catch1': 'prompt_acceptance_probe', 'router.catch49': 'background_watch'}.get(tag, 'callsite_failure')
    key = _imessage_cause_key(key)
    return (tag, key) if key else None


def _imessage_render_stats(row):
    if row.get('name') != 'card.renders' or row.get('kind') != 'perf':
        return None
    stats = row.get('renders')
    if not isinstance(stats, dict):
        return None
    count, histogram = stats.get('count'), stats.get('histogram')
    if type(count) is not int or not 1 <= count <= 10_000_000 or not isinstance(histogram, list) or len(histogram) > 1001:
        return None
    values = [(p[0], p[1]) for p in histogram if isinstance(p, list) and len(p) == 2
              and type(p[0]) is int and 0 <= p[0] <= 1000 and type(p[1]) is int and 1 <= p[1] <= 10_000_000]
    return (count, values) if sum(n for _, n in values) == count else None


def _imessage_shared_renders(board, day):
    import sqlite3
    path = board_dir(board) / f'renders-{day}.sqlite'
    components = {'cards', 'card-file', 'quick-renderer', 'delivery-renderer', 'ride-renderer', 'nutrition-renderer'}
    kinds = {'quick', 'delivery', 'ride', 'nutrition', 'secure_form', 'other'}
    groups = {}
    try:
        if path.is_symlink():
            return []
        with contextlib.closing(sqlite3.connect(path.absolute().as_uri() + '?mode=ro', uri=True)) as db:
            for component, kind, chat, ms, count in db.execute('SELECT component, cardKind, chat, ms, count FROM bins'):
                if (component not in components or kind not in kinds or chat not in {'owner', 'moni', 'other', 'unknown'}
                        or type(ms) is not int or not 0 <= ms <= 1000 or type(count) is not int or not 1 <= count <= 2**53 - 1):
                    continue
                row = groups.setdefault((component, kind, chat), {'component': component, 'kind': 'perf', 'name': 'card.render',
                    '_rollup_count': 0, '_rollup_ok': 0, '_rollup_failed': 0, '_rollup_histogram': [], '_rollup_synthetic': True})
                row['_rollup_count'] += count
                row['_rollup_ok'] += count
                row['_rollup_histogram'].append((ms, count))
    except (OSError, sqlite3.Error):
        return []
    return list(groups.values())


def _imessage_rollup_records(board, day):
    def batch(row):
        identity = row.get('ids')
        value = identity.get('callBatchId') if isinstance(identity, dict) else None
        return value if isinstance(value, str) else None
    represented = set()
    represented_single_failures = set()
    pending = []
    for line, raw in _read_records(board, day):
        row = {key: value for key, value in raw.items() if not key.startswith('_rollup_')}
        renders = _imessage_render_stats(row)
        calls = _imessage_call_stats(row)
        if renders:
            count, histogram = renders
            yield line, {**row, 'name': 'card.render', '_rollup_count': count, '_rollup_ok': count,
                         '_rollup_failed': 0, '_rollup_histogram': histogram}
        elif calls:
            for name, (oks, failed, histogram, single) in calls.items():
                if batch(row) is not None:
                    represented.add((batch(row), name))
                    if single is not None:
                        represented_single_failures.add((batch(row), name))
                yield line, {'ts': row.get('ts'), 'ids': row.get('ids'), 'component': 'robob', 'kind': 'perf',
                             'name': 'turn.robob_call', '_rollup_count': oks + failed,
                             '_rollup_ok': oks, '_rollup_failed': failed, '_rollup_histogram': histogram, '_rollup_call': name,
                             '_rollup_single_failures': single or 0}
        elif row.get('name') == 'turn.robob_call' and row.get('kind') == 'perf':
            pending.append((line, row))
            yield line, {'_rollup_skip': True}
        else:
            yield line, row
    # Count retained observations only after seeing the summaries in this same read.
    for line, row in pending:
        if (batch(row), _imessage_call_name(row)) not in represented:
            yield line, {**row, '_rollup_deferred': True}
        elif row.get('error'):
            yield line, {**row, '_rollup_deferred': True, '_rollup_diagnostic': True,
                         '_rollup_failure_counted': (batch(row), _imessage_call_name(row)) in represented_single_failures}
    for row in _imessage_shared_renders(board, day):
        yield 0, row


def _imessage_probe_stats(row):
    if row.get('component') != 'router' or row.get('name') != 'router.prompt_probes' or row.get('kind') != 'perf':
        return None
    value = row.get('promptProbe')
    if not isinstance(value, dict):
        return None
    outcomes = ('accepted', 'notAcceptedYet', 'timeout', 'http', 'transport')
    valid = lambda n: type(n) is int and 0 <= n <= 10_000_000
    if not all(valid(value.get(k)) for k in ('calls',) + outcomes):
        return None
    if value['calls'] != sum(value[k] for k in outcomes):
        return None
    statuses = value.get('httpByStatus')
    if not isinstance(statuses, dict) or any(not isinstance(k, str) or not re.fullmatch(r'[1-5]\d{2}', k) or not valid(v) for k, v in statuses.items()):
        return None
    if sum(statuses.values()) != value['http']:
        return None
    result = {k: value[k] for k in ('calls',) + outcomes}
    result['httpByStatus'] = dict(statuses)
    for field in ('elapsedMs', 'attempts', 'msUntilAccepted'):
        bins = value.get(field)
        if not isinstance(bins, list) or len(bins) > 100_000:
            return None
        if any(not isinstance(pair, list) or len(pair) != 2 or type(pair[0]) is not int or not 0 <= pair[0] <= 2**53 - 1 or not valid(pair[1]) or pair[1] < 1 for pair in bins):
            return None
        result[field] = [tuple(pair) for pair in bins]
    samples = lambda field: sum(n for _, n in result[field])
    if samples('elapsedMs') != result['calls'] or samples('attempts') > result['accepted'] or samples('attempts') != samples('msUntilAccepted'):
        return None
    return result


def rollup(board, day, top_n=20):
    from collections import Counter, defaultdict
    counts_name, counts_kind, tags = Counter(), Counter(), Counter()
    causes, render_failures = Counter(), Counter()
    cause_kinds = defaultdict(Counter)
    probe_totals, probe_statuses = Counter(), Counter()
    probe_bins = defaultdict(list)
    probe_hours = {}
    probe_rows = defaultdict(Counter)
    samples, references, durations = {}, {}, defaultdict(list)
    order_errors, order_polls = {}, defaultdict(list)
    component_totals, component_errors = Counter(), defaultdict(Counter)
    component_samples, component_durations = defaultdict(dict), defaultdict(list)
    order_failures, poll_counts = defaultdict(Counter), {}
    can_report_outcomes = {'success': 0, 'refused': 0}
    threads_by_rule, attempts = defaultdict(Counter), defaultdict(list)
    tag_hours, classifier_failures, classifier_classes = defaultdict(Counter), Counter(), defaultdict(Counter)
    thread_decisions, unattributed = defaultdict(Counter), defaultdict(Counter)
    sampled_threads, sampled_attempts, sampled_unknown = set(), set(), set()
    unrecognized = 0
    unrecognized_sampled = False
    caps = []
    recorded = 0
    last_record = None
    component_stats = {}
    sampled = False
    day_start = datetime.strptime(day, '%Y-%m-%d').replace(tzinfo=timezone.utc)
    start = day_start.timestamp()
    refusal_shapes_acc = _RefusalShapes(start) if board == 'agent-tools' else None
    total = oks = failed = errors = observed = 0
    single_failures = 0
    deduped_failures = 0
    probe_failure_kinds = {}
    slow_hooks = []
    def observe_error(row, line_number, weight=1):
        nonlocal single_failures
        probe_id = (row.get('ids') or {}).get('inboundId', '')
        if board == 'imessage' and isinstance(probe_id, str) and re.fullmatch(r'row_[a-f0-9]{16}', probe_id):
            probe_tag = ('router.probe_backoff' if row.get('name') == 'router.probe_backoff'
                         else 'router.catch1' if (row.get('error') or {}).get('tag') == 'router.catch1' else None)
            if probe_tag:
                key = (probe_tag, 'admission_read_failed')
                causes[key] += weight
                probe_rows[key][probe_id] += weight
        if board == 'imessage' and row.get('alreadyLogged') is True:
            request_id = (row.get('ids') or {}).get('requestId')
            cause_kind = (row.get('props') or {}).get('causeKind')
            if ((row.get('error') or {}).get('tag') == 'router.catch1'
                    and isinstance(request_id, str) and request_id and cause_kind in ('timeout', 'http', 'transport')):
                probe_failure_kinds[request_id] = cause_kind
            return
        request_failure = (board == 'imessage' and row.get('component') == 'robob' and row.get('name') == 'turn.robob_call'
                           and row.get('kind') == 'perf' and row.get('ok') is False)
        single = (row.get('props') or {}).get('failureFormat') == 'single'
        if request_failure and single and not row.get('_rollup_failure_counted'):
            single_failures += weight
        if request_failure and not single and (row.get('error') or {}).get('tag') == 'control.request_failed':
            return
        if board == 'imessage':
            cause = _imessage_replayed_cause(row)
            if cause:
                causes[cause] += weight
        tag = (row.get('error') or {}).get('tag')
        if not isinstance(tag, str):
            return
        key = tag
        if board == 'imessage':
            error_name = (row.get('error') or {}).get('name')
            if not isinstance(error_name, str) or error_name not in _IMESSAGE_ERROR_NAMES:
                error_name = 'UnknownError'
            key = (tag, error_name)
            cause_kind = (row.get('props') or {}).get('causeKind')
            # Request details follow catches, including when their count is owned by a summary.
            if cause_kind is None and request_failure:
                request_id = (row.get('ids') or {}).get('requestId')
                if isinstance(request_id, str):
                    cause_kind = probe_failure_kinds.get(request_id)
            if cause_kind in ('timeout', 'http', 'transport'):
                cause_kinds[key][cause_kind] += weight
        tags[key] += weight
        references.setdefault(key, {'file': day + '.ndjson', 'line': line_number, 'ts': row.get('ts')})
        identity = row.get('ids')
        if isinstance(identity, dict) and identity:
            samples.setdefault(key, identity)
    records = _imessage_rollup_records(board, day) if board == 'imessage' else _read_records(board, day)
    for line_number, row in records:
        if not (board == 'imessage' and (row.get('_rollup_deferred') or row.get('_rollup_synthetic'))):
            recorded += line_number != last_record
            last_record = line_number
        if board == 'imessage' and row.get('_rollup_skip'):
            continue
        if board == 'imessage' and row.get('_rollup_diagnostic'):
            observe_error(row, line_number)
            continue
        if board == 'imessage':
            single_failures += row.get('_rollup_single_failures', 0)
        aggregate = board == 'imessage' and '_rollup_count' in row
        weight = row['_rollup_count'] if aggregate else _sample_rate(row)
        sampled |= weight > 1 and not aggregate
        total += weight
        if row.get('name') in {'log.cap', 'log.degraded'}:
            props = row.get('props') or {}
            caps.append({'component': props.get('component', 'all'),
                         'capBytes': props.get('capBytes'), 'ts': row.get('ts')})
        name, kind = row.get('name', 'unknown'), row.get('kind', 'unknown')
        counts_name[name] += weight
        counts_kind[kind] += weight
        attempt = _hook_attempt(row)
        if attempt and refusal_shapes_acc:
            refusal_shapes_acc.add(row, attempt)
        if attempt:
            thread, rule, decision, at = attempt
            refusal_weight = _hook_weight(row)
            if thread.startswith('unknown:'):
                unattributed[(rule, thread)][decision] += refusal_weight
                if refusal_weight > 1:
                    sampled_unknown.add((rule, thread))
            elif _attributed_thread(thread):
                threads_by_rule[rule][thread] += refusal_weight
                thread_decisions[(rule, thread)][decision] += refusal_weight
                if refusal_weight > 1:
                    sampled_threads.add((rule, thread))
                if at is not None and start <= at < start + 86400:
                    attempts[(thread, rule, decision)].append((at, refusal_weight))
                    if refusal_weight > 1:
                        sampled_attempts.add((thread, rule, decision))
            else:
                unrecognized += refusal_weight
                unrecognized_sampled |= refusal_weight > 1
        row_ok = row['_rollup_ok'] if aggregate else weight * (row.get('ok') is True)
        row_failed = row['_rollup_failed'] if aggregate else weight * (row.get('ok') is False)
        already_logged = board == 'imessage' and row.get('alreadyLogged') is True
        if already_logged:
            if kind == 'error' or row_failed:
                deduped_failures += weight
            row_failed = 0
        observed += row_ok + row_failed
        oks += row_ok
        failed += row_failed
        errors += weight * (kind == 'error' and not already_logged)
        duration = row.get('durationMs')
        if board == 'agent-tools' and _slow_hook(row):
            slow_hooks.append((line_number, row))
        values = row['_rollup_histogram'] if aggregate else ([(duration, weight)]
            if type(duration) in (int, float) and math.isfinite(duration) and duration >= 0 else [])
        if values:
            durations[name].extend(values)
        if board == 'imessage':
            probe = _imessage_probe_stats(row)
            if probe:
                hour = str(row.get('ts', ''))[11:13]
                hourly = probe_hours.setdefault(hour, {'counts': Counter(), 'statuses': Counter(), 'bins': defaultdict(list)})
                for field in ('calls', 'accepted', 'notAcceptedYet', 'timeout', 'http', 'transport'):
                    probe_totals[field] += probe[field]
                    hourly['counts'][field] += probe[field]
                probe_statuses.update(probe['httpByStatus'])
                hourly['statuses'].update(probe['httpByStatus'])
                for field in ('elapsedMs', 'attempts', 'msUntilAccepted'):
                    probe_bins[field].extend(probe[field])
                    hourly['bins'][field].extend(probe[field])
            component = row.get('component', 'unknown')
            call = row.get('_rollup_call') if aggregate else _imessage_call_name(row)
            for label in [name] + ([call] if name == 'turn.robob_call' and call else []):
                stats = component_stats.setdefault((component, label), {'count': 0, 'ok': 0, 'failed': 0, 'histogram': []})
                stats['count'] += weight
                stats['ok'] += row_ok
                stats['failed'] += row_failed
                stats['histogram'].extend(values)
        if board == 'orders':
            component = row.get('component')
            if not isinstance(component, str) or component not in {
                    'commerce', 'order-watch', 'card_status', 'card-vault-fill', 'noon', 'careem',
                    'amazon', 'uber', 'toollog', 'money-cases'}:
                component = 'unknown'
            component_totals[component] += weight
            if component == 'order-watch' and name == 'order_watch.can_report' and type(row.get('ok')) is bool:
                can_report_outcomes['success' if row['ok'] else 'refused'] += weight
            if type(duration) in (int, float) and math.isfinite(duration) and duration >= 0:
                component_durations[f'{component}:{name}'].append((duration, weight))
            merchant = (row.get('props') or {}).get('merchant')
            if merchant not in {'noon', 'careem', 'amazon', 'uber', 'other'}:
                merchant = 'unknown'
            if (component == 'order-watch' and name == 'track.poll' and type(row.get('ok')) is bool
                    and (row.get('props') or {}).get('polled') is not False):
                poll = poll_counts.setdefault(merchant, {'count': 0, 'failed': 0})
                poll['count'] += weight
                poll['failed'] += weight * (row['ok'] is False)
            identity = row.get('ids')
            order_id = identity.get('orderId') if isinstance(identity, dict) else None
            if (kind == 'error' and name in {'track.poll', 'provider.track', 'provider.details'}
                    and (row.get('props') or {}).get('polled') is not False
                    and type(order_id) is str and re.fullmatch(r'[a-f0-9]{16}', order_id)):
                order_failures[component][order_id] += weight
            if name == 'track.poll' and type(duration) in (int, float) and math.isfinite(duration) and duration >= 0:
                order_polls[merchant].append((duration, weight))
            if kind == 'error':
                error = row.get('error') or {}
                status = (error.get('cause') or {}).get('httpStatus')
                status = status if type(status) is int and 100 <= status <= 599 else None
                code = error.get('tag') or 'OPERATION_FAILED'
                component_errors[component][code] += weight
                component_samples[component].setdefault(code, {
                    'file': day + '.ndjson', 'line': line_number})
                item = order_errors.setdefault((code, status, merchant), {
                    'tag': code, 'httpStatus': status, 'merchant': merchant, 'count': 0,
                    'sampleId': {'file': day + '.ndjson', 'line': line_number}})
                item['count'] += weight
        if board == 'imessage':
            props = row.get('props') if isinstance(row.get('props'), dict) else {}
            failure_code = props.get('failureCode')
            if name == 'card.render' and row_failed and isinstance(failure_code, str) and failure_code in {
                    'renderer_failed', 'preview_missing', 'render_exception', 'page_fetch', 'page_http', 'page_type',
                    'page_body', 'image_fetch', 'image_http', 'image_type', 'image_body', 'upload', 'upload_url',
                    'invalid_url', 'file_prepare'}:
                render_failures[failure_code] += weight
        observe_error(row, line_number, weight)
        tag = (row.get('error') or {}).get('tag')
        if board == 'agent-tools' and isinstance(tag, str):
            hour = str(row.get('ts', ''))[11:13]
            tag_hours[tag][hour if re.fullmatch(r'[0-2][0-9]', hour) else '??'] += weight
            if tag == 'hook.classifier_failed':
                props = row.get('props') if isinstance(row.get('props'), dict) else {}
                # Rows written before #214 have no classifier; their guard still ranks them.
                name = props.get('classifier') if isinstance(props.get('classifier'), str) else f"guard:{props.get('guard', 'unknown')}"
                classifier_failures[name] += weight
                error_class = props.get('errorClass')
                classifier_classes[name][error_class if isinstance(error_class, str) else 'unrecorded'] += weight
    def percentiles(values):
        values.sort()
        count = sum(weight for _, weight in values)
        def percentile(fraction):
            threshold = math.ceil(count * fraction)
            seen = 0
            for value, weight in values:
                seen += weight
                if seen >= threshold:
                    return value
        return {'p50': percentile(.5), 'p95': percentile(.95), 'max': values[-1][0]}
    loops = []
    # A UTC file boundary must not hide a retry loop. Previous-day records
    # supply only the rolling window; daily totals and top threads stay local.
    for _, row in _read_records(board, (day_start - timedelta(days=1)).strftime('%Y-%m-%d')):
        attempt = _hook_attempt(row)
        if attempt and refusal_shapes_acc:
            refusal_shapes_acc.add_previous(row, attempt)
        if attempt:
            thread, rule, decision, at = attempt
            key = (thread, rule, decision)
            if key in attempts and at is not None and start - 3600 <= at < start:
                weight = _hook_weight(row)
                sampled |= weight > 1
                attempts[key].append((at, weight))
                if weight > 1:
                    sampled_attempts.add(key)
    for (thread, rule, decision), timestamps in sorted(attempts.items()):
        timestamps.sort()
        left = peak = window_count = 0
        for at, weight in timestamps:
            window_count += weight
            while at - timestamps[left][0] > 3600:
                window_count -= timestamps[left][1]
                left += 1
            if at >= start:
                peak = max(peak, window_count)
        if peak > 20:
            loops.append({'threadId': thread, 'rule': rule, 'decision': decision,
                          'maxCountInHour': peak, 'repeatLoop': True,
                          'sampled': (thread, rule, decision) in sampled_attempts})
    result = {'schemaVersion': 1, 'tool': board, 'day': day, 'total': total,
            'recordedRows': recorded, 'sampled': sampled, 'logCaps': caps,
            'countsByName': dict(counts_name), 'countsByKind': dict(counts_kind),
            'okCount': oks, 'failedCount': failed, 'okRate': oks / observed if observed else None,
            'errorRate': (errors + single_failures) / total if total else 0,
            'durationMsByName': {name: percentiles(values) for name, values in sorted(durations.items())},
            'topThreadsByRule': {rule: [{'threadId': thread, 'count': count, 'attributed': True,
                                      'denied': thread_decisions[(rule, thread)]['denied'],
                                      'rewritten': thread_decisions[(rule, thread)]['rewritten'],
                                      'sampled': (rule, thread) in sampled_threads} for thread, count in
                                     sorted(threads.items(), key=lambda x: (-x[1], x[0]))[:top_n]]
                                 for rule, threads in sorted(threads_by_rule.items())},
            'repeatLoops': loops,
            'topErrorTags': [{**({'tag': key[0], 'name': key[1]} if board == 'imessage' else {'tag': key}),
                              'count': count, 'sampleId': samples.get(key, references[key]),
                              **({'causeKinds': dict(cause_kinds[key])} if board == 'imessage' and cause_kinds[key] else {})}
                             for key, count in sorted(tags.items(), key=lambda x: (-x[1], x[0]))[:20]]}
    if board == 'agent-tools':
        result['refusalShapes'] = refusal_shapes_acc.result()
        result['unattributedByRule'] = {rule: [
                {'threadId': thread, 'count': sum(counts.values()), 'attributed': False,
                 'denied': counts['denied'], 'rewritten': counts['rewritten'],
                 'sampled': (rule, thread) in sampled_unknown}
                for (entry_rule, thread), counts in sorted(unattributed.items()) if entry_rule == rule]
                for rule in sorted({rule for rule, _ in unattributed})}
        result['unrecognizedThreadIds'] = unrecognized
        result['unrecognizedThreadIdsSampled'] = unrecognized_sampled
        result['errorTagsByHour'] = {tag: dict(sorted(hours.items())) for tag, hours in
                                     sorted(tag_hours.items(), key=lambda x: (-sum(x[1].values()), x[0]))}
        result['topClassifierFailures'] = [
            {'classifier': name, 'count': count,
             'errorClasses': dict(sorted(classifier_classes[name].items(), key=lambda x: (-x[1], x[0])))}
            for name, count in sorted(classifier_failures.items(), key=lambda x: (-x[1], x[0]))[:5]]
        result['slowestPhaseByCount'] = slowest_phases(slow_hooks, day, percentiles, top_n)
    if board == 'orders':
        result['canReportByOutcome'] = can_report_outcomes
        result['durationsMs'] = {name: dict(values) for name, values in result['durationMsByName'].items()}
        if order_polls:
            result['durationsMs']['track.poll']['byMerchant'] = {
                merchant: {**percentiles(values), 'count': sum(weight for _, weight in values)}
                for merchant, values in sorted(order_polls.items())}
        result['topErrors'] = sorted(order_errors.values(), key=lambda x: (
            -x['count'], x['tag'], x['httpStatus'] or 0, x['merchant']))[:20]
        result['durationsMs'].update({
            key: {**percentiles(values), 'count': sum(weight for _, weight in values)}
            for key, values in sorted(component_durations.items())
            if key not in result['durationsMs']})
        result['errorsByComponent'] = {
            component: dict(sorted(component_errors[component].items()))
            for component in sorted(component_totals)}
        result['failureShare'] = {
            component: sum(component_errors[component].values()) / component_totals[component]
            for component in sorted(component_totals)}
        # Match topErrorTags' frequency ranking, but never copy an IDs dictionary.
        result['topErrorSamplesByComponent'] = {
            component: [{'tag': code, 'count': count,
                         'sampleId': component_samples[component][code]}
                        for code, count in sorted(component_errors[component].items(),
                                                  key=lambda item: (-item[1], item[0]))[:5]]
            for component in sorted(component_totals)}
        result['topOrderFailuresByComponent'] = {
            component: [{'orderId': order_id, 'count': count} for order_id, count in
                        sorted(orders.items(), key=lambda item: (-item[1], item[0]))[:5]]
            for component, orders in sorted(order_failures.items())}
        result['pollsByMerchant'] = {
            merchant: {**poll, 'failureShare': poll['failed'] / poll['count']}
            for merchant, poll in sorted(poll_counts.items())}
    if board == 'imessage':
        def probe_summary(counts, statuses, bins):
            summary = {field: counts[field] for field in ('calls', 'accepted', 'notAcceptedYet', 'timeout', 'http', 'transport')}
            summary['httpByStatus'] = dict(statuses)
            for field in ('elapsedMs', 'attempts', 'msUntilAccepted'):
                values = bins[field]
                summary[field] = {'count': sum(n for _, n in values), **(percentiles(values) if values else {'p50': 0, 'p95': 0, 'max': 0})}
            return summary
        result['promptProbe'] = {**probe_summary(probe_totals, probe_statuses, probe_bins),
            'byHour': {hour: probe_summary(value['counts'], value['statuses'], value['bins']) for hour, value in sorted(probe_hours.items())}}
        result['dedupedFailures'] = deduped_failures
        result['topCauses'] = [{'tag': tag, 'causeKey': cause, 'count': count,
                                **({'distinctInboundIds': len(probe_rows[(tag, cause)]),
                                    'topInboundIds': [{'inboundId': row, 'count': attempts} for row, attempts in
                                                      sorted(probe_rows[(tag, cause)].items(), key=lambda x: (-x[1], x[0]))[:14]]}
                                   if (tag, cause) in probe_rows else {})}
                               for (tag, cause), count in sorted(causes.items(), key=lambda x: (-x[1], x[0]))[:20]]
        result['cardRenderFailures'] = dict(sorted(render_failures.items()))
        result['byComponent'] = {}
        result['durationMs'] = result['durationMsByName']
        for (component, name), stats in component_stats.items():
            result['byComponent'].setdefault(component, {})[name] = {
                'count': stats['count'], 'ok': stats['ok'], 'failed': stats['failed'],
                'errorRate': stats['failed'] / stats['count'] if stats['count'] else 0,
                **({'durationMs': percentiles(stats['histogram'])} if stats['histogram'] else {})}
    return result


def _row_phases(row):
    """Measured phases plus the unmeasured remainder; None for rows written without phases."""
    props = row.get('props') if isinstance(row.get('props'), dict) else {}
    phases = {key: props[key] for key in HOOK_PHASES
              if type(props.get(key)) in (int, float) and math.isfinite(props[key]) and props[key] >= 0}
    if not phases:
        return None
    phases['unmeasured'] = max(0, int(round(row['durationMs'] - sum(phases.values()))))
    return phases


def slowest_phases(rows, day, percentiles, top_n=10):
    """Hook rows over SLOW_HOOK_MS: the largest phase per row, then count and p95 per phase per harness."""
    harnesses, top = {}, []
    for line_number, row in rows:
        props = row.get('props') if isinstance(row.get('props'), dict) else {}
        harness = props.get('harness') if isinstance(props.get('harness'), str) else 'unknown'
        entry = harnesses.setdefault(harness, {'rows': 0, 'unphasedRows': 0, 'largest': {}, 'values': {}})
        entry['rows'] += 1
        phases = _row_phases(row)
        largest = None
        if phases is None:
            entry['unphasedRows'] += 1
        else:
            largest = max(phases, key=lambda key: (phases[key], key != 'unmeasured', key))
            entry['largest'][largest] = entry['largest'].get(largest, 0) + 1
            for key, value in phases.items():
                entry['values'].setdefault(key, []).append((value, 1))
        top.append({'durationMs': row['durationMs'], 'ts': row.get('ts'), 'harness': harness,
                    'guard': props.get('guard'), 'rule': props.get('rule'),
                    'errorTag': (row.get('error') or {}).get('tag') if isinstance(row.get('error'), dict) else None,
                    'largestPhase': largest, 'phases': phases,
                    'sampleId': {'file': day + '.ndjson', 'line': line_number}})
    return {'thresholdMs': SLOW_HOOK_MS, 'byHarness': {
                harness: {'rows': entry['rows'], 'unphasedRows': entry['unphasedRows'],
                          'largestPhase': dict(sorted(entry['largest'].items(), key=lambda x: (-x[1], x[0]))),
                          'phases': {key: {'count': len(values), 'p95': percentiles(values)['p95']}
                                     for key, values in sorted(entry['values'].items())}}
                for harness, entry in sorted(harnesses.items())},
            'slowestRows': sorted(top, key=lambda x: (-x['durationMs'], x['sampleId']['line']))[:top_n]}


def hourly_table(result, limit=20):
    """Text table of error tags by UTC hour from a rollup, busiest tags first."""
    hours = [f'{hour:02d}' for hour in range(24)]
    tags = list((result.get('errorTagsByHour') or {}).items())[:limit]
    width = max([len('tag')] + [len(tag) for tag, _ in tags])
    lines = [' '.join(['tag'.ljust(width)] + [hour.rjust(4) for hour in hours] + ['total'.rjust(6)])]
    for tag, counts in tags:
        lines.append(' '.join([tag.ljust(width)] + [str(counts.get(hour, 0) or '.').rjust(4) for hour in hours]
                              + [str(sum(counts.values())).rjust(6)]))
    for entry in result.get('topClassifierFailures') or []:
        classes = ', '.join(f'{name} {count}' for name, count in entry['errorClasses'].items())
        lines.append(f"classifier_failed {entry['classifier']}: {entry['count']} ({classes})")
    return '\n'.join(lines)


def refusal_shapes(board, day, rule=None, cap=REFUSAL_SHAPE_CAP):
    """refusalShapes for one UTC day without running the whole rollup.

    Groups denied/rewritten hook.decision rows by rule and command shape. Rows
    written before cmdShape existed group by a coarse shape (first word, cwd class).
    """
    if rule is not None and not _LABEL.fullmatch(rule):
        raise ValueError('invalid rule')
    day_start = datetime.strptime(day, '%Y-%m-%d').replace(tzinfo=timezone.utc)
    shapes = _RefusalShapes(day_start.timestamp(), rule)
    for _, row in _read_records(board, day):
        attempt = _hook_attempt(row)
        if attempt:
            shapes.add(row, attempt)
    for _, row in _read_records(board, (day_start - timedelta(days=1)).strftime('%Y-%m-%d')):
        attempt = _hook_attempt(row)
        if attempt:
            shapes.add_previous(row, attempt)
    return shapes.result(cap)


def refusals_table(result, limit=30):
    """Text table of the busiest refusal shapes from refusalShapes."""
    def projects(entry):
        return ', '.join(f"{item['project']} {item['count']}" for item in entry['topProjects'][:3])
    def harness(entry):
        return ','.join(f'{name} {count}' for name, count in entry['harness'].items())
    rows = [(str(entry['count']) + ('~' if entry['sampled'] else ''), str(entry['denied']), str(entry['rewritten']),
             str(entry['distinctThreads']), str(entry['retryWithin5m']), harness(entry), entry['rule'],
             entry['shape'], projects(entry)) for entry in result['shapes'][:limit]]
    hidden = result['shapes'][limit:]
    other = result.get('other')
    if hidden or other:
        count = sum(entry['count'] for entry in hidden) + (other['count'] if other else 0)
        denied = sum(entry['denied'] for entry in hidden) + (other['denied'] if other else 0)
        rewritten = sum(entry['rewritten'] for entry in hidden) + (other['rewritten'] if other else 0)
        retries = sum(entry['retryWithin5m'] for entry in hidden) + (other['retryWithin5m'] if other else 0)
        shapes = len(hidden) + (other['shapes'] if other else 0)
        rows.append((str(count), str(denied), str(rewritten), '', str(retries), '', '*', f'other ({shapes} shapes)', ''))
    header = ('count', 'den', 'rew', 'thr', 'retry', 'harness', 'rule', 'shape', 'top projects')
    widths = [max(len(row[i]) for row in rows + [header]) for i in range(len(header) - 1)]
    def line(row):
        cells = [cell.rjust(width) if i < 5 else cell.ljust(width) for i, (cell, width) in enumerate(zip(row, widths))]
        return '  '.join(cells + [row[-1]]).rstrip()
    summary = (f"{result['rows']} refusals in {result['shapeCount']} shapes; {result['coarseRows']} from rows "
               f"without cmdShape (coarse); {result['excludedTestRows']} test rows excluded; retry = same thread, "
               f"rule and shape again within {result['retryWindowSeconds'] // 60} min; ~ = sampled estimate")
    return '\n'.join([summary, line(header)] + [line(row) for row in rows])


def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='cmd', required=True)
    for cmd in ('read', 'rollup'):
        p = sub.add_parser(cmd)
        p.add_argument('--board', required=True)
        p.add_argument('--day', default=datetime.now(timezone.utc).strftime('%Y-%m-%d'))
        if cmd == 'read':
            p.add_argument('--kind', choices=['event', 'perf', 'error', 'opencode-reload'])
            p.add_argument('--name')
            p.add_argument('--limit', type=int, default=100)
        else:
            p.add_argument('--top', type=int, default=20)
            p.add_argument('--table', action='store_true', help='also print error tags by UTC hour after the path')
    p = sub.add_parser('refusals', help='denied/rewritten hook refusals by rule and command shape')
    p.add_argument('--board', default='agent-tools')
    p.add_argument('--day', default=datetime.now(timezone.utc).strftime('%Y-%m-%d'))
    p.add_argument('--rule')
    p.add_argument('--top', type=int, default=30, help='table rows to print; the rest are summed as other')
    p.add_argument('--json', action='store_true', help='print the refusalShapes JSON instead of the table')
    args = parser.parse_args(argv)
    try:
        if args.cmd == 'refusals':
            if args.top < 1:
                raise ValueError('top must be positive')
            result = refusal_shapes(args.board, args.day, args.rule)
            print(json.dumps(result, indent=2) if args.json else refusals_table(result, args.top))
        elif args.cmd == 'read':
            if args.limit < 0:
                raise ValueError('limit must be nonnegative')
            from itertools import islice
            for row in islice(read(args.board, args.day, args.kind, args.name), args.limit):
                print(json.dumps(row, separators=(',', ':')))
        else:
            if args.top < 1:
                raise ValueError('top must be positive')
            result = rollup(args.board, args.day, args.top)
            if args.board == 'orders':
                import subprocess
                try:
                    # Kept out of checks: the bounded history read belongs to the daily rollup.
                    done = subprocess.run(['money-cases', 'health', '--day', args.day, '--json'],
                                          capture_output=True, text=True, timeout=2, check=True)
                    health = json.loads(done.stdout)
                    if health.get('day') == args.day and isinstance(health.get('one_line'), str):
                        result['moneyCasesHealth'] = health
                except (OSError, ValueError, AttributeError, subprocess.SubprocessError):
                    pass
            directory = board_dir(args.board)
            _private_dir(directory)
            path = directory / ('rollup-' + args.day + '.json')
            import tempfile
            fd, tmp = tempfile.mkstemp(dir=directory, prefix='.rollup-')
            try:
                with os.fdopen(fd, 'w') as dest:
                    json.dump(result, dest, indent=2, allow_nan=False)
                    dest.write('\n')
                os.replace(tmp, path)
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)
            print(path)
            if 'moneyCasesHealth' in result:
                print(result['moneyCasesHealth']['one_line'])
            if args.table:
                print(hourly_table(result))
        return 0
    except (OSError, ValueError) as error:
        print(f'toollog: {error}', file=__import__('sys').stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
