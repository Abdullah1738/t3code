"""Attribute long metadata crawls from the CPU sampler's existing ps snapshot."""
import os
from pathlib import Path
import re
import shlex
import subprocess

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
            if tool == 'fd' and option in ('--search-path', '--base-directory'):
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


def thread_identity(proc):
    """Only t3ctl's identity operand is evidence; inline shell/query text isn't."""
    try:
        words = shlex.split(proc.get('args', ''))
    except ValueError:
        return None
    if not words:
        return None
    name = Path(proc.get('comm', '')).name
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


def volume_crawls(rows, previous, now, run, home=None):
    home = str(Path.home()) if home is None else home
    candidates = []
    by_pid = {p['pid']: p for p in rows}
    for proc in rows:
        tool = Path(proc.get('comm', '')).name
        # ps's exiting rows have reset counters/argv and cannot be attributed.
        if tool not in TOOLS or proc['state'].startswith('?') or not proc.get('args'):
            continue
        if proc['elapsedS'] >= 30:
            candidates.append(proc)
    if not candidates:
        return
    cwds = cwd_snapshot([p['pid'] for p in candidates], run)
    for proc in candidates:
        tool = Path(proc['comm']).name
        try:
            args = proc['args']
            # ps does not shell-quote argv. Strip the known executable first so
            # a binary path containing spaces is not mistaken for operands.
            tail = args[len(proc['comm']):] if args.startswith(proc['comm']+' ') else None
            words = shlex.split(tail) if tail is not None else shlex.split(args)[1:]
        except ValueError:
            continue
        cwd = cwds.get(proc['pid'])
        operands = search_paths(tool, words)
        if operands is None:
            continue
        paths = [absolute(p, cwd, home) for p in operands]
        if not any(p is not None and broad_root(p, home) for p in paths):
            continue
        chain, seen = [], {proc['pid']}
        parent = proc
        thread_id = None
        for _ in range(4):
            parent = by_pid.get(parent['ppid'])
            if parent is None or parent['pid'] in seen:
                break
            seen.add(parent['pid'])
            chain.append(dict(pid=parent['pid'], name=Path(parent.get('comm', '')).name))
            if thread_id is None:
                thread_id = thread_identity(parent)
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
        # Paths only: search patterns, inline expressions and option values are
        # not filesystem attribution data. Paths themselves remain verbatim.
        emit('scan', 'event', 'scan.volume_crawl', props=dict(pid=proc['pid'], ppid=proc['ppid'],
             parentChain=chain, argv=[proc['comm'], *[p for p in paths if p is not None]],
             cwd=cwd, elapsedS=proc['elapsedS'], cpuPct=pct, threadId=thread_id))
