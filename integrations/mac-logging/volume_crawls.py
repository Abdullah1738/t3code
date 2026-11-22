"""Attribute long metadata crawls from the CPU sampler's existing ps snapshot."""
import os
import json
from pathlib import Path
import re
import subprocess
import sys
import time

from toollog import emit, finite_number, VOLUME_THREAD_ID

TOOLS = {'du', 'rg', 'find', 'fd', 'ncdu', 'dust'}
# Arity differs between tools: fd -g is boolean; rg -g consumes a glob.
VALUE_OPTIONS = {
    'rg': set(('-d --max-depth -g --glob --iglob -t --type -T --type-not -j --threads '
               '--ignore-file --path-separator --sort --sortr --max-filesize -m --max-count '
               '-A -B -C --after-context --before-context --context --encoding --color '
               '--colors --engine --pre --pre-glob --replace -r --hostname-bin '
               '--hyperlink-format --field-match-separator --field-context-separator '
               '--max-columns -M --type-add --type-clear --regex-size-limit --dfa-size-limit '
               '--context-separator --label').split()),
    'fd': set(('-d --max-depth --min-depth -t --type -e --extension -E --exclude '
               '-S --size --changed-within --changed-before --changed-after --owner '
               '-j --threads --color --path-separator --ignore-file').split()),
    'du': {'-d', '-I', '-t', '--max-depth', '--exclude', '--exclude-from', '--block-size'},
    'ncdu': {'--exclude', '--exclude-from', '--color', '-o', '-f'},
    'dust': {'-d', '--depth', '-n', '--number-of-lines', '-X', '--ignore-directory',
             '-e', '--filter', '-v', '--invert-filter', '--min-size'},
}
BOOL_OPTIONS = {
    'rg': set(('--files --hidden --no-ignore --no-ignore-vcs --no-ignore-parent '
               '--no-ignore-global --no-ignore-dot --no-ignore-messages --no-ignore-files '
               '--follow --one-file-system --text --binary --fixed-strings --ignore-case '
               '--case-sensitive --smart-case --line-number --no-line-number --column '
               '--count --count-matches --files-with-matches --files-without-match '
               '--only-matching --quiet --no-messages --multiline --multiline-dotall '
               '--pcre2 --unicode --no-unicode --json --vimgrep --stats --trim --no-heading '
               '--heading --null --null-data --crlf --passthru --debug --trace --no-config '
               '--no-mmap --mmap --line-buffered --block-buffered --with-filename '
               '--no-filename --invert-match --word-regexp --line-regexp').split()),
    'fd': set(('--glob --regex --hidden --no-ignore --unrestricted --follow --full-path '
               '--absolute-path --strip-cwd-prefix --show-errors --print0 --quiet '
               '--list-details --one-file-system --fixed-strings --case-sensitive '
               '--ignore-case --no-ignore-vcs --no-ignore-parent --no-ignore-global '
               '--no-ignore-files --no-hidden').split()),
    'du': {'--apparent-size', '--summarize', '--human-readable', '--total', '--one-file-system'},
    'ncdu': {'--exclude-caches', '--exclude-kernfs', '--one-file-system', '--read-only'},
    'dust': {'--reverse', '--no-colors', '--full-paths', '--ignore-hidden', '--apparent-size', '--file_types', '--file-types'},
}
SHORT_BOOL = {'rg': set('nNHuUaisSwxFPlLcqo0zv'), 'fd': set('gHILhipals0uqF'),
              'du': set('aHLPchklmrsx'), 'ncdu': set('xqer012'), 'dust': set('rhfsbPpRt')}
FIND_FLAGS = set('EHLPXdsx')
MAX_CANDIDATES = 32


def exec_end(args, start):
    # fd owns everything up to a literal semicolon or the end of argv.
    return args.index(';', start)+1 if ';' in args[start:] else len(args)


def find_paths(args):
    paths, i = [], 0
    # BSD find uses getopt("EHLPXdf:sx") before its roots and expression.
    while i < len(args):
        arg = args[i]
        if arg == '--':
            i += 1
            break
        if not arg.startswith('-') or len(arg) < 2 or arg[1] not in FIND_FLAGS | {'f'}:
            break
        for offset, flag in enumerate(arg[1:], 1):
            if flag == 'f':
                path = arg[offset+1:]
                if not path:
                    i += 1
                    if i >= len(args):
                        return None
                    path = args[i]
                paths.append(path)
                break
            if flag not in FIND_FLAGS:
                return None
        i += 1
    for arg in args[i:]:
        if arg.startswith(('-', '!', '(')):
            break
        paths.append(arg)
    return paths or ['.']


def search_paths(tool, args):
    """None means unknown option arity: never persist guessed query operands."""
    if tool == 'find':
        return find_paths(args)
    paths, positionals, base = [], [], None
    explicit_pattern = list_files = False
    after_options = False
    i = 0
    while i < len(args):
        arg = args[i]
        if not after_options and arg == '--':
            after_options = True
        elif not after_options and arg.startswith('-') and arg != '-':
            option, equal, value = arg.partition('=')
            if tool == 'fd' and option in ('-x', '-X', '--exec', '--exec-batch'):
                i = exec_end(args, i+1)
                continue
            elif tool == 'fd' and option in ('--search-path', '--base-directory'):
                if not equal:
                    if i+1 >= len(args):
                        return None
                    value = args[i+1]
                    i += 1
                if option == '--base-directory':
                    base = value
                else:
                    paths.append(value)
            elif tool == 'rg' and option in ('-e', '--regexp', '-f', '--file'):
                explicit_pattern = True
                i += not equal
            elif tool == 'ncdu' and option == '-f':
                return None
            elif option in VALUE_OPTIONS[tool]:
                i += not equal
            elif option in BOOL_OPTIONS[tool]:
                list_files |= tool == 'rg' and option == '--files'
            elif not arg.startswith('--'):
                # Walk bundles so -nrVALUE and -nePATTERN retain correct arity.
                for offset, flag in enumerate(arg[1:], 1):
                    short = '-'+flag
                    if tool == 'fd' and flag in ('x', 'X'):
                        i = exec_end(args, i+1)-1
                        break
                    if tool == 'rg' and short in ('-e', '-f'):
                        explicit_pattern = True
                        i += offset == len(arg)-1
                        break
                    if tool == 'ncdu' and short == '-f':
                        return None
                    if short in VALUE_OPTIONS[tool]:
                        i += offset == len(arg)-1
                        break
                    if flag not in SHORT_BOOL[tool]:
                        return None
            else:
                return None
        else:
            positionals.append(arg)
        i += 1
    # Explicit pattern sources may follow paths. A literal --files after -- is
    # still a positional pattern, and fd has no rg file-list mode.
    if tool == 'fd' or (tool == 'rg' and not explicit_pattern and not list_files):
        positionals = positionals[1:]
    paths.extend(positionals)
    paths = paths or ['.']
    if tool == 'rg':
        paths = [p for p in paths if p != '-']
    return [os.path.join(base, p) for p in paths] if base is not None else paths


def thread_identity(proc, words):
    """Only t3ctl's identity operand is evidence; inline shell/query text isn't."""
    if not words:
        return None
    name = proc.get('tool') or Path(proc.get('comm', '')).name
    if name in ('node', 'bun') and len(words) > 1 and Path(words[1]).name == 't3ctl.mjs':
        words = words[1:]
    elif name != 't3ctl':
        return None
    if len(words) < 3:
        return None
    identity = None
    if words[1] in ('status', 'messages', 'send', 'wait', 'interrupt', 'respond',
                    'origin', 'set', 'archive-if-idle'):
        identity = words[2]
    elif words[1] == 'events':
        for i, value in enumerate(words[2:], 2):
            if value == '--thread' and i+1 < len(words):
                identity = words[i+1]
            elif value.startswith('--thread='):
                identity = value[len('--thread='):]
    return identity if identity and VOLUME_THREAD_ID.fullmatch(identity) else None


def broad_root(path, home):
    return (path in ('/', home) or re.fullmatch(r'/Volumes/[^/]+', path) is not None
            or re.fullmatch(r'/Volumes/ExternalSSD/[^/]+', path) is not None)


def absolute(path, cwd, home):
    if path == '~' or path.startswith('~/'):
        path = home + path[1:]
    if not path.startswith('/'):
        if cwd is None:
            return None
        path = os.path.join(cwd, path)
    path = os.path.normpath(path)
    # lsof can expose the Data-volume alias of the same mount/home path.
    for alias in ('/System/Volumes/Data', '/Volumes/Data'):
        if path.startswith(alias+'/Volumes/') or path.startswith(alias+'/Users/'):
            path = path[len(alias):]
            break
    return path


def cwd_snapshot(pids, run):
    try:
        result = run(['/usr/sbin/lsof', '-a', '-d', 'cwd', '-p', ','.join(map(str, pids)), '-Fn'],
                     capture_output=True, text=True, timeout=2)
        found, pid = {}, None
        for line in result.stdout.splitlines():
            if line.startswith('p') and line[1:].isdigit():
                pid = int(line[1:])
            elif line.startswith('n/') and pid in pids:
                found[pid] = line[1:]
        # lsof returns 1 if even one selected process exited. Keep surviving rows.
        return found
    except (OSError, UnicodeError, subprocess.TimeoutExpired):
        return {}


def argv_snapshot(rows, run):
    command = [sys.executable, '-I', str(Path(__file__).with_name('process_argv.py')),
               *[str(p['pid']) for p in rows]]
    try:
        result = run(command, capture_output=True, text=True, timeout=2)
        if result.returncode or len(result.stdout) > 1048576:
            return {}
        values = json.loads(result.stdout)
        found = {}
        for proc in rows:
            value = values.get(str(proc['pid'])) if isinstance(values, dict) else None
            if not isinstance(value, dict):
                continue
            words = value.get('argv')
            start = int(time.mktime(time.strptime(proc['start'], '%a %b %d %H:%M:%S %Y')))
            if (value.get('startS') == start and value.get('ppid') == proc['ppid']
                    and value.get('uid') == proc['uid']
                    and isinstance(value.get('executable'), str)
                    and Path(value['executable']).name == (proc.get('tool') or Path(proc['comm']).name)
                    and isinstance(words, list) and 1 <= len(words) <= 4096
                    and all(isinstance(w, str) and '\0' not in w for w in words)):
                found[proc['pid']] = value
        return found
    except (OSError, UnicodeError, ValueError, OverflowError, subprocess.TimeoutExpired):
        return {}


# Only parsed attribution survives the minute sampler process. Never cache argv.
MAX_CACHE = 512
SESSION_UUID = re.compile(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}')
OPENCODE_SESSION = re.compile(r'ses_[A-Za-z0-9]{1,128}')


def provider_name(proc, words):
    name = proc.get('tool') or Path(proc.get('comm', '')).name
    if name in ('claude', 'codex', 'opencode'):
        return name
    if name == 'node' and len(words) > 1:
        script = words[1]
        for provider, suffix in (('claude', '/@anthropic-ai/claude-code/cli.js'),
                                 ('codex', '/@openai/codex/bin/codex.js'),
                                 ('opencode', '/opencode-ai/bin/opencode')):
            if script.endswith(suffix):
                return provider
    return None


def provider_session(provider, words):
    flags = {'claude': ('--session-id', '--resume', '-r'),
             'codex': ('--session-id',), 'opencode': ('--session', '-s')}[provider]
    valid = OPENCODE_SESSION if provider == 'opencode' else SESSION_UUID
    values = []
    # Skip option operands so prompts/settings containing flag-shaped strings
    # cannot become a session identifier. Unknown CLI shapes fail closed.
    takes_value = set(('--output-format --input-format --thinking --thinking-display --effort '
                       '--model --permission-prompt-tool --allowedTools --tools --disallowedTools '
                       '--permission-mode --add-dir --settings --mcp-config --system-prompt '
                       '--append-system-prompt --max-turns --max-budget-usd --betas '
                       '--agents --agent --fallback-model --setting-sources --debug-file '
                       '--prompt --config -c --enable --disable -C --cd --sandbox --approval-mode --profile '
                       '--provider --format --title --agent --port --hostname').split())
    boolean = set(('--verbose --allow-dangerously-skip-permissions --dangerously-skip-permissions '
                   '--include-partial-messages --print --continue --strict-mcp-config '
                   '--disable-slash-commands --no-session-persistence --no-chrome '
                   '--chrome --fork-session --json --full-auto').split())
    if provider == 'claude':
        boolean.add('-p')
    else:
        takes_value.add('-p')
    i, command = 1, None
    while i < len(words):
        word = words[i]
        # Subcommands follow global options. Flag operands with these names
        # are skipped below, while an actual shared server always fails closed.
        if word == '--':
            if command is None and provider in ('codex', 'opencode') and words[i+1:i+2] in (
                    ['app-server'], ['serve'], ['web']):
                return None, True
            break
        if not word.startswith('-'):
            if command is None and ((provider == 'codex' and word == 'app-server') or
                                    (provider == 'opencode' and word in ('serve', 'web'))):
                return None, True
            if (provider == 'codex' and command is None and word == 'exec' or
                    provider == 'opencode' and command is None and word == 'run'):
                command = word
                i += 1
                continue
            if provider == 'codex' and command in (None, 'exec') and word == 'resume':
                i += 1
                if i >= len(words) or not valid.fullmatch(words[i]):
                    return None, True
                values.append(words[i])
                command = 'resume'
                i += 1
                continue
            break
        option, equal, value = word.partition('=')
        if option in flags:
            value = value if equal else words[i+1] if i+1 < len(words) else ''
            if not valid.fullmatch(value):
                return None, True
            values.append(value)
            i += 1 if equal else 2
        elif option in takes_value:
            i += 1 if equal else 2
        elif option in boolean:
            i += 1
        elif provider == 'codex' and word.startswith('-c') and len(word) > 2:
            i += 1
        else:
            return None, True
    unique = set(values)
    return (next(iter(unique)), False) if len(unique) == 1 else (None, len(unique) > 1)


def process_key(proc):
    return [proc['start'], proc['ppid'], proc['uid'], proc.get('tool') or Path(proc['comm']).name]


def process_metadata(proc, vector):
    words = vector.get('argv', [])
    provider = provider_name(proc, words)
    thread = vector.get('threadId')
    thread = thread if isinstance(thread, str) and VOLUME_THREAD_ID.fullmatch(thread) else None
    metadata = dict(identity=process_key(proc), threadId=thread or thread_identity(proc, words),
                    provider=provider, providerSessionId=None, providerSessionAmbiguous=False)
    if provider:
        session_words = words[1:] if (proc.get('tool') or Path(proc['comm']).name) == 'node' else words
        session, ambiguous = provider_session(provider, session_words)
        metadata.update(providerSessionId=session, providerSessionAmbiguous=ambiguous or not words)
    tool = proc.get('tool') or Path(proc['comm']).name
    if tool in TOOLS and words:
        metadata.update(executable=vector['executable'], operands=search_paths(tool, words[1:]))
    return metadata


def volume_crawls(rows, previous, now, run, home=None):
    home = str(Path.home()) if home is None else home
    candidates = []
    by_pid = {p['pid']: p for p in rows}
    old_cache = previous.get('volumeCrawlCache', {})
    old_cache = old_cache if isinstance(old_cache, dict) else {}
    cache = {pid: value for pid, value in old_cache.items()
             if isinstance(pid, str) and pid.isdigit() and int(pid) in by_pid and isinstance(value, dict)
             and value.get('identity') == process_key(by_pid[int(pid)])}
    for proc in rows:
        tool = proc.get('tool') or Path(proc.get('comm', '')).name
        if tool not in TOOLS or proc['state'].startswith('?'):
            continue
        if proc['elapsedS'] >= 30:
            candidates.append(proc)
    if not candidates:
        return dict(list(cache.items())[-MAX_CACHE:])
    offset = (int(now)//60*MAX_CANDIDATES) % len(candidates)
    candidates = (candidates[offset:]+candidates[:offset])[:MAX_CANDIDATES]
    selected = {p['pid']: p for p in candidates}
    for proc in candidates:
        parent = proc
        for _ in range(4):
            parent = by_pid.get(parent['ppid'])
            if parent is None:
                break
            selected[parent['pid']] = parent
            if (parent.get('tool') or Path(parent['comm']).name) == 'Robob':
                break
    fresh = [p for p in selected.values() if str(p['pid']) not in cache]
    vectors = argv_snapshot(fresh, run) if fresh else {}
    for proc in fresh:
        cache[str(proc['pid'])] = process_metadata(proc, vectors.get(proc['pid'], {}))
    cache = dict(list(cache.items())[-MAX_CACHE:])
    cwds = cwd_snapshot([p['pid'] for p in candidates], run)
    for proc in candidates:
        metadata = cache.get(str(proc['pid']), {})
        operands = metadata.get('operands')
        if operands is None:
            continue
        cwd = cwds.get(proc['pid'])
        paths = [absolute(p, cwd, home) for p in operands]
        if not any(p is not None and broad_root(p, home) for p in paths):
            continue
        chain, seen = [], {proc['pid']}
        parent = proc
        thread_id = metadata.get('threadId')
        provider = dict(providerPid=None, provider=None, providerSessionId=None,
                        providerSessionAmbiguous=False)
        for _ in range(4):
            parent = by_pid.get(parent['ppid'])
            if parent is None or parent['pid'] in seen:
                break
            seen.add(parent['pid'])
            chain.append(dict(pid=parent['pid'], name=parent.get('tool') or Path(parent.get('comm', '')).name))
            if chain[-1]['name'] == 'Robob':
                break
            identity = cache.get(str(parent['pid']), {})
            if thread_id is None:
                thread_id = identity.get('threadId')
            if provider['provider'] is None and identity.get('provider'):
                provider.update({k: identity.get(k) for k in ('provider', 'providerSessionId', 'providerSessionAmbiguous')})
                provider['providerPid'] = parent['pid']
        if provider['providerSessionAmbiguous']:
            thread_id = None
        old = previous.get('processes')
        old = old if isinstance(old, dict) else {}
        prior = old.get(str(proc['pid']))
        prior = prior if isinstance(prior, dict) else {}
        at = previous.get('at')
        window = now-at if finite_number(at) else 0
        pct = None
        if (0 < window <= 3600 and prior.get('start') == proc['start']
                and finite_number(prior.get('cpuS')) and 0 <= prior['cpuS'] <= proc['cpuS']):
            pct = round((proc['cpuS']-prior['cpuS'])/window*100, 3)
        emit('scan', 'event', 'scan.volume_crawl', props=dict(pid=proc['pid'], ppid=proc['ppid'],
             parentChain=chain, argv=[metadata['executable'], *[p for p in paths if p is not None]],
             cwd=cwd, elapsedS=proc['elapsedS'], cpuPct=pct, threadId=thread_id, **provider))
    return cache
