"""Bounded shell/source checks; never opens a database or executes a command."""
from __future__ import annotations

import ast
import base64
import glob
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import unicodedata
import warnings
from urllib.parse import unquote


REPLICA = re.compile(r"(?<![\w.-])\.robob/userdata/readonly/state\.sqlite(?:-(?:wal|shm))?(?![\w./-])")
LIVE = re.compile(
    r"(?:\.robob/userdata/statev2|robob-data/userdata/statev2|\.robob/userdata/\*\.sqlite|"
    # Legacy names and near-misses remain protected; only the replica is public.
    rf"(?!{REPLICA.pattern})\.robob/userdata/(?:[\w.-]+/)*state\.sqlite|"
    r"(?:\.local/share/opencode|opencode-data)/opencode\.db|"
    # The legacy home database is protected; workspace .t3 copies stay isolated.
    rf"(?:{re.escape(str(Path.home()))}|~|\$HOME|\$\{{HOME\}})/\.t3/userdata/(?:statev2|(?:[\w.-]+/)*state\.sqlite))"
)
DATABASE_NAME = re.compile(r"statev2(?:[.-][\w-]+)?\.sqlite|state\.sqlite|opencode\.db")
PROTECTED_SOURCE_TOKEN = re.compile(r"\.robob|\.t3|robob-data|userdata|opencode", re.IGNORECASE)
# Preserve the existing hidden-home fixture; new subpaths use plain segments.
SHELL_FIXTURE_DATABASE = (r"(?:\.robob/userdata/|(?:[A-Za-z0-9_][A-Za-z0-9._-]*/)+)"
                          r"statev2(?:\.sqlite)?(?:-(?:wal|shm|journal))?")
SHELL_HIDDEN_FIXTURE_DATABASE = r"\.robob/userdata/statev2(?:\.sqlite)?(?:-(?:wal|shm|journal))?"
SHELL_FIXTURE_WORD = re.compile(r'''(?<![^ \t\n;&|(){}])\#[^\n]*|(?:[^ \t\n;&|<>()"'\\]+|"(?:[^"\\]|\\[\s\S])*"|'[^']*'|\\[\s\S])+''')
READER = re.compile(
    r"(?:^|[\s;&|('\"`])(?:\S*/)?(?:sqlite3?|python[\d.]*|node|bun|deno|duckdb|litecli|"
    r"datasette|uv|cp|rsync|ditto|dd|cat|strings|grep|rg|jq|xxd|hexdump|tar|zip|restic)"
    r"(?=[\s;&|)`]|$)"
)
SCRIPT = re.compile(
    r"(?:^|[\s;&|('\"`])(?:\S*python[\d.]*|node|bun|deno|bash|zsh|sh|uv\s+run(?:\s+python[\d.]*)?)"
    r"\s+(?:-[\w-]+\s+)*(?:\"([^\"]+\.(?:py|mjs|cjs|js|ts|sh))\"|"
    r"'([^']+\.(?:py|mjs|cjs|js|ts|sh))'|([^\s;&|<>'\"]+\.(?:py|mjs|cjs|js|ts|sh)))"
)
DIRECT = re.compile(
    r"(?:^|[;&|(\n]|-[a-z]*c\s+['\"])\s*(?:(?:command|exec|nohup|sudo)\s+)?"
    r"([.~$/][^\s;&|<>'\"]*\.(?:py|mjs|cjs|js|ts|sh))"
)
MAX_SOURCE_BYTES = 2_000_000
MAX_SCRIPTS = 32
NODE_TEST_MAX_FILES = 200
MAX_SHELL_DEPTH = 12
STARTUP_ENV = re.compile(r'(?:BASH_ENV|ENV|BASHOPTS|SHELLOPTS|LD_[A-Za-z_]*|DYLD_[A-Za-z_]*|PYTHON[A-Z_]+)')
SHELL_SPECIAL_BINDINGS = frozenset({'path', 'cdpath', 'fpath', 'FPATH', 'ARGV0', 'NULLCMD', 'READNULLCMD',
                                    'PS4', 'PROMPT4', 'BASH_XTRACEFD',
                                    'commands', 'functions', 'dis_functions', 'aliases', 'galiases', 'saliases',
                                    'dis_aliases', 'dis_galiases', 'dis_saliases', 'reswords', 'dis_reswords',
                                    'builtins', 'dis_builtins', 'options'})
NODE_SCRIPT_OPTIONS = {'-r', '--require', '--import', '--loader', '--experimental-loader', '--test-global-setup'}
NODE_FILE_OPTIONS = {
    '--env-file', '--env-file-if-exists', '--experimental-config-file', '--build-snapshot-config',
    '--experimental-package-map', '--experimental-sea-config', '--openssl-config',
    '--snapshot-blob', '--localstorage-file', '--test-rerun-failures',
}
NODE_VALUE_OPTIONS = {
    '-C', '--conditions', '--input-type', '--title', '--inspect-port', '--debug-port',
    '--allow-fs-read', '--allow-fs-write', '--build-snapshot-config', '--cpu-prof-dir',
    '--cpu-prof-interval', '--cpu-prof-name', '--diagnostic-dir', '--disable-proto',
    '--disable-warning', '--dns-result-order', '--env-file', '--env-file-if-exists',
    '--experimental-config-file', '--experimental-package-map', '--experimental-sea-config',
    '--experimental-test-tag-filter', '--heap-prof-dir', '--heap-prof-interval', '--heap-prof-name',
    '--heapsnapshot-near-heap-limit', '--heapsnapshot-signal', '--icu-data-dir',
    '--inspect-publish-uid', '--localstorage-file', '--max-http-header-size',
    '--max-old-space-size', '--max-semi-space-size', '--max-old-space-size-percentage',
    '--network-family-autoselection-attempt-timeout', '--openssl-config', '--redirect-warnings',
    '--report-directory', '--report-dir', '--report-filename', '--report-signal', '--run',
    '--secure-heap', '--secure-heap-min', '--snapshot-blob', '--test-concurrency',
    '--test-coverage-branches', '--test-coverage-exclude', '--test-coverage-functions',
    '--test-coverage-include', '--test-coverage-lines', '--experimental-test-isolation',
    '--test-isolation', '--test-name-pattern', '--test-random-seed', '--test-reporter',
    '--test-reporter-destination', '--test-rerun-failures', '--test-shard',
    '--test-skip-pattern', '--test-timeout', '--tls-cipher-list', '--tls-keylog',
    '--trace-event-categories', '--trace-event-file-pattern', '--trace-require-module',
    '--unhandled-rejections', '--use-largepages', '--v8-pool-size', '--watch-kill-signal', '--watch-path',
}
REASON = (
    "statev2 guard: this command was NOT run (owner incident 2026-11-05).\n"
    "Shell reads of Robob's live statev2.sqlite and OpenCode's live opencode.db are blocked, "
    "including sqlite3/python/node scripts and read-only SQL. They contend with the live writers.\n"
    "Use Robob tools/APIs (board_*/card_*, t3ctl, /api/ardud/control/*), recall for past sessions, "
    "or server traces instead. Work on an existing isolated copy. Creating a copy or VACUUM INTO "
    "also reads the live file: ask Abdullah on your card (card_ask), then run "
    "`live-db-snapshot --card <id> --ask <id> --db <path>` once he approves.\n"
    "If only the database can answer, report the exact queries and stop."
)


def protected_databases():
    """Concrete live files for the snapshot helper; classifier patterns stay unchanged."""
    home = Path.home()
    return {(home / relative).resolve() for relative in (
        ".robob/userdata/statev2.sqlite", ".robob/userdata/state.sqlite",
        ".t3/userdata/statev2.sqlite", ".t3/userdata/state.sqlite",
        ".local/share/opencode/opencode.db",
    )}


def _name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return _name(node.value) + "." + node.attr
    return ""


def _path_expression(node, bindings, aliases, partial=False):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        return bindings.get(node.id)
    if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Div, ast.Add)):
        left = _path_expression(node.left, bindings, aliases, partial)
        right = _path_expression(node.right, bindings, aliases, partial)
        if left is not None and right is not None:
            return os.path.join(left, right) if isinstance(node.op, ast.Div) else left + right
        if partial and right is not None:
            return right
    if isinstance(node, ast.Call):
        name = _name(node.func)
        root, *rest = name.split(".")
        name = ".".join([aliases.get(root, root), *rest])
        if name in {"Path.home", "pathlib.Path.home", "os.path.expanduser"}:
            if not node.args:
                return str(Path.home())
            value = _path_expression(node.args[0], bindings, aliases)
            return os.path.expanduser(value) if value is not None else None
        if name in {"Path", "pathlib.Path", "os.path.join"}:
            parts = [_path_expression(arg, bindings, aliases, partial) for arg in node.args]
            if parts and all(part is not None for part in parts):
                return os.path.join(*parts)
            if partial:
                # A dynamic home does not hide a literal protected suffix.
                return "/".join(part or "" for part in parts)
        if isinstance(node.func, ast.Attribute) and node.func.attr in {"joinpath", "expanduser"}:
            base = _path_expression(node.func.value, bindings, aliases)
            parts = [_path_expression(arg, bindings, aliases) for arg in node.args]
            if base is not None and all(part is not None for part in parts):
                return os.path.expanduser(base) if node.func.attr == "expanduser" else os.path.join(base, *parts)
    return None


def _python_tree(source):
    tree = ast.parse(source)
    aliases, bindings = {}, {}
    stores = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            aliases.update((n.asname or n.name, n.name) for n in node.names)
        elif isinstance(node, ast.ImportFrom):
            aliases.update((n.asname or n.name, (node.module or "") + "." + n.name) for n in node.names)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            stores[node.id] = stores.get(node.id, 0) + 1
        elif isinstance(node, ast.arg):
            stores[node.arg] = stores.get(node.arg, 0) + 1
    for node in ast.walk(tree):
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target, ast.Name) and stores.get(target.id) == 1:
                    value = _path_expression(node.value, bindings, aliases)
                    if value is not None:
                        bindings[target.id] = value
    return tree, aliases, bindings


def source_touches_live(source: str) -> bool:
    if LIVE.search(source):
        return True
    # Separate fixture names and prose do not make a path. Resolve only paths
    # assembled by one Python expression (including Path.home()/... chains).
    if "statev2" not in source and "state.sqlite" not in source and "opencode.db" not in source:
        return False
    try:
        tree, aliases, bindings = _python_tree(source)
        return any(LIVE.search(value) for node in ast.walk(tree)
                   if (value := _path_expression(node, bindings, aliases, partial=True)) is not None)
    except (SyntaxError, ValueError):
        return False


def _foreign_reader_shadowed(source):
    names = r'(?:open(?:Sync)?|sqlite3?|Database(?:Sync)?|connect|readFile(?:Sync)?|createReadStream)'
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError):
        pass
    else:
        # sqlite3 imports establish real readers; later writes to their bindings
        # or attributes still invalidate that trust, including renamed imports.
        standard_names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                standard_names.update(alias.asname or alias.name.split('.')[0] for alias in node.names
                                      if alias.name.split('.')[0] == 'sqlite3')
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and (node.module or '').split('.')[0] == 'sqlite3':
                standard_names.update(alias.asname or alias.name for alias in node.names)

        def sensitive(name):
            return bool(name and (name in standard_names or re.fullmatch(names, name)))

        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                if any(alias.name.split('.')[0] != 'sqlite3' and sensitive(alias.asname or alias.name.split('.')[0]) for alias in node.names):
                    return True
            elif isinstance(node, ast.ImportFrom):
                if (node.level != 0 or (node.module or '').split('.')[0] != 'sqlite3') and any(sensitive(alias.asname or alias.name) for alias in node.names):
                    return True
            elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)) and sensitive(node.id):
                return True
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.arg, ast.ExceptHandler, ast.MatchAs, ast.MatchStar)):
                if sensitive(node.arg if isinstance(node, ast.arg) else node.name):
                    return True
            elif isinstance(node, (ast.Attribute, ast.Subscript)) and isinstance(node.ctx, (ast.Store, ast.Del)):
                if sensitive(getattr(node, 'attr', None)) or _name(node.value).split('.')[0] in standard_names:
                    return True
            elif isinstance(node, ast.Call) and _name(node.func) in {'setattr', 'delattr'} and node.args:
                if _name(node.args[0]).split('.')[0] in standard_names:
                    return True
        return False
    return bool(re.search(
        rf'\b(?:function\s*\*?|class|def|alias)\s+{names}\b|'
        rf'\b(?:const|let|var)\s+[^;\n=]*\b{names}\b|'
        rf'\b{names}\s*=(?!=|>)|\b{names}\s*\([^()\n]*\)\s*\{{|'
        rf'\b(?:as|import)\s+{names}\b|'
        rf'\b(?:function|def)\b[^\n(]*\([^)]*\b{names}\b|'
        rf'\([^()]*\b{names}\b[^()]*\)\s*=>|\b{names}\s*=>|'
        rf'\bcatch\s*\(\s*{names}\b', source))


def _foreign_state_source(source, directory):
    # Discharge only fixed reader operands. Stored paths can have their basename
    # transformed or rebased later, so they retain the original source evidence.
    def literal(match):
        value = match[0]
        before, after = source[:match.start()], source[match.end():]
        scalar = match.start() == 0 and match.end() == len(source)
        reader = re.search(r'''\b(?:Database(?:Sync)?|readFile(?:Sync)?|open(?:Sync)?|createReadStream)\s*\(\s*(['"])$''', before)
        direct_reader = reader and re.match(re.escape(reader[1]) + r'\s*[,)]', after)
        shell = re.search(r'''(?:^|[\s;(])(?:[^\s;()]+/)?sqlite3?\s+(?:-[\w-]+\s+)*(['"]?)$''', before)
        direct_shell = shell and re.match(re.escape(shell[1]) + r'(?=$|[\s;|&()<>])', after)
        if not (scalar or direct_reader or direct_shell):
            return value
        path = _literal_path(value, directory)
        if path is None or REPLICA.search(value) or LIVE.search(value) or LIVE.search(str(path)):
            return value
        for root in (Path.home() / '.robob/userdata', Path.home() / '.t3/userdata'):
            if path.is_relative_to(root.resolve()):
                return value
        return ' ' * len(value)
    masked = re.sub(r'''(?<![^\s'"(=])(?:~|\$HOME|\$\{HOME\})?/(?:[^\s'"`$*?\[\]();|&<>\\/]+/)*state\.sqlite(?:-(?:wal|shm|journal))?(?=$|[\s'"),;|&<>])''', literal, source)
    # A separate protected root may transform or rebase the foreign operand.
    if (re.search(r"\.robob\b|robob-data|\.t3\b|opencode-data|\.local/share/opencode|['\"]opencode['\"]", masked) or
            re.search(r'\buserdata\b', masked) and re.search(r'\b(?:homedir|HOME|T3CODE_HOME)\b|\bPath\.home\b', masked)):
        return source
    return masked


def _relative_source_live(source, directory):
    if directory is None:
        return False
    names = [name for name in ("statev2.sqlite", "opencode.db") if name in source]
    if not names:
        return False
    for match in re.finditer(r"['\"]([^'\"\n]+)['\"]", source):
        path = _literal_path(match[1], directory)
        if path is not None and (LIVE.search(str(path)) or any(LIVE.search(str(path / name)) for name in names)):
            return True
    return False


def _python_touches_live(source, directory, replica=False):
    try:
        tree, aliases, bindings = _python_tree(source)
    except (SyntaxError, ValueError):
        return bool(replica or source_touches_live(source) or _relative_source_live(source, directory) or
                    directory is not None and any(LIVE.search(str(directory / name))
                                                  for name in {'statev2.sqlite', 'state.sqlite', 'opencode.db'}))

    definitions, stores = {}, {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            stores[node.id] = stores.get(node.id, 0) + 1
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.arg)):
            name = node.arg if isinstance(node, ast.arg) else node.name
            stores[name] = stores.get(name, 0) + 1
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for imported in node.names:
                name = imported.asname or (imported.name.split('.')[0] if isinstance(node, ast.Import) else imported.name)
                stores[name] = stores.get(name, 0) + 1
        if isinstance(node, (ast.ExceptHandler, ast.MatchAs, ast.MatchStar)) and node.name:
            stores[node.name] = stores.get(node.name, 0) + 1
        if isinstance(node, ast.MatchMapping) and node.rest:
            stores[node.rest] = stores.get(node.rest, 0) + 1
        if type(node).__name__ in {'TypeVar', 'ParamSpec', 'TypeVarTuple'}:
            stores[node.name] = stores.get(node.name, 0) + 1
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            for target in node.targets if isinstance(node, ast.Assign) else [node.target]:
                if isinstance(target, ast.Name):
                    definitions[target.id] = node.value

    # A cached path must not retain trust from an import that was rebound.
    ambiguous = {name for name in aliases if stores.get(name) != 1}
    ambiguous.update(name for name in {'Path', 'pathlib', 'os'} if name not in aliases)
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and isinstance(node.ctx, (ast.Store, ast.Del)):
            root = _name(node).split('.')[0]
            if root in aliases:
                ambiguous.add(root)
    dependents = {}
    for name, value in definitions.items():
        for part in ast.walk(value) if value is not None else ():
            if isinstance(part, ast.Name):
                dependents.setdefault(part.id, set()).add(name)
    pending = list(ambiguous)
    while pending:
        for name in dependents.get(pending.pop(), ()):
            if name not in ambiguous:
                ambiguous.add(name)
                pending.append(name)
    bindings = {name: value for name, value in bindings.items() if name not in ambiguous}
    # Object writes can reach imported readers/builders through aliases whose
    # identity this path evaluator cannot establish.
    opaque = any(isinstance(n, (ast.Attribute, ast.Subscript)) and isinstance(n.ctx, (ast.Store, ast.Del)) or
                 isinstance(n, ast.ImportFrom) and any(a.name == '*' for a in n.names) or
                 _name(n) in {'globals', 'locals', 'vars', 'setattr', 'delattr'} or
                 aliases.get(_name(n)) == 'sys.modules' or
                 isinstance(n, ast.Attribute) and (n.attr in {'__dict__', '__globals__', 'f_globals', 'f_locals', '__getattribute__', '__setattr__'} or
                     n.attr == 'modules' and aliases.get(_name(n.value), _name(n.value)) == 'sys')
                 for n in ast.walk(tree))

    def uri_value(node, seen=frozenset()):
        if any(isinstance(n, ast.Name) and n.id in ambiguous for n in ast.walk(node)):
            return None
        value = _path_expression(node, bindings, aliases)
        if value is not None:
            return value
        if isinstance(node, ast.Name) and node.id not in seen and stores.get(node.id) == 1 and node.id in definitions:
            return uri_value(definitions[node.id], seen | {node.id})
        if isinstance(node, ast.Call) and _name(node.func) == 'str' and 'str' not in stores and 'str' not in aliases and len(node.args) == 1:
            return uri_value(node.args[0], seen)
        if isinstance(node, ast.JoinedStr):
            parts = [uri_value(n.value, seen) if isinstance(n, ast.FormattedValue) and
                     n.conversion == -1 and n.format_spec is None else uri_value(n, seen) for n in node.values]
            return ''.join(parts) if all(p is not None for p in parts) else None
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            left, right = uri_value(node.left, seen), uri_value(node.right, seen)
            return left + right if left is not None and right is not None else None
        return None

    replica = replica or any(REPLICA.search(value) for node in ast.walk(tree)
                             if (value := _path_expression(node, bindings, aliases)) is not None)
    original_live = source_touches_live(source)
    replica_calls = set()
    for node in ast.walk(tree):
        if not replica or original_live or opaque or not isinstance(node, ast.Call) or not node.args:
            continue
        root, *rest = _name(node.func).split('.')
        if root not in aliases or root in ambiguous or stores.get(root) != 1 or '.'.join([aliases[root], *rest]) != 'sqlite3.connect':
            continue
        value = uri_value(node.args[0])
        if value is None:
            continue
        value = re.sub(r'^file:', '', value).split('?', 1)[0]
        match = REPLICA.search(value)
        if match and match.end() == len(value) and not _direct_read(['cat', value], directory):
            replica_calls.update(id(n) for n in ast.walk(node.func))
    relative_live = _relative_source_live(source, directory)
    mentions = original_live or relative_live or replica
    changed_directory = bool(re.search(r"\bchdir\b", source) and
                             ("statev2.sqlite" in source or "state.sqlite" in source or "opencode.db" in source) and
                             (relative_live or re.search(r"\.robob|robob-data|\.local/share/opencode|opencode-data", source)))
    if not mentions and not changed_directory and not (directory is not None and any(LIVE.search(str(directory / name)) for name in {"statev2.sqlite", "state.sqlite", "opencode.db"})):
        return False
    db = {"sqlite3", "apsw", "sqlalchemy", "duckdb", "peewee"}
    direct_callables = {id(part) for n in ast.walk(tree) if isinstance(n, ast.Call) for part in ast.walk(n.func)}
    for node in ast.walk(tree):
        name = _name(node)
        root, *rest = name.split(".")
        canonical = ".".join([aliases.get(root, root), *rest])
        if canonical.split(".")[0] in db and id(node) not in replica_calls:
            return True
        if canonical in {"__import__", "builtins", "importlib", "eval", "exec", "getattr", "__builtins__"} or canonical.startswith(("builtins.", "importlib.", "__builtins__.")):
            return True
        if changed_directory and canonical == "os.chdir":
            return True
        sensitive = (canonical in {"open", "io.open", "os.open", "Path", "pathlib.Path"} or
                     canonical.startswith(("subprocess.", "os.exec", "shutil.copy")) or
                     canonical in {"os.system", "os.popen", "shutil.move", "os.link", "os.symlink"} or
                     isinstance(node, ast.Attribute) and node.attr in {"open", "read_text", "read_bytes", "write_text", "write_bytes"})
        if sensitive and id(node) not in direct_callables:
            return True
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            modules = [n.name for n in node.names] if isinstance(node, ast.Import) else [node.module or ""]
            if any(m.split(".")[0] in db | {"builtins", "importlib"} and
                   not (m == 'sqlite3' and replica_calls) for m in modules):
                return True
        if not isinstance(node, ast.Call):
            continue
        if not isinstance(node.func, (ast.Name, ast.Attribute)):
            return True
        name = _name(node.func)
        root, *rest = name.split(".")
        name = ".".join([aliases.get(root, root), *rest])
        if (name.startswith(("subprocess.", "os.exec", "shutil.copy")) or
                name in {"os.system", "os.popen", "shutil.move", "os.link", "os.symlink"}):
            return True
        value = None
        file_call = name in {"open", "io.open", "os.open", "Path", "pathlib.Path"}
        if file_call:
            value = _path_expression(node.args[0], bindings, aliases) if node.args else None
        elif isinstance(node.func, ast.Attribute) and node.func.attr in {"open", "read_text", "read_bytes", "write_text", "write_bytes"}:
            file_call = True
            value = _path_expression(node.func.value, bindings, aliases)
        if file_call:
            path = _literal_path(value, directory) if value is not None else None
            if path is None or LIVE.search(str(path)):
                return True
    return False


def _trusted_fixture_tool(executable, name, directory):
    trusted = {f'/bin/{name}', f'/usr/bin/{name}'}
    if name == 'node':
        trusted.add('/usr/local/bin/node')
    system_paths = set(trusted)
    if name in {'node', 'bash'}:
        def root_owned(path):
            try:
                path = Path(os.path.realpath(path))
                return all((info := os.stat(part)).st_uid == 0 and not info.st_mode & 0o022 for part in (path, *path.parents))
            except Exception:
                return False
        trusted = {path for path in trusted if root_owned(path)}
    # This Mac's default Bash is Homebrew's versioned package, not /bin/bash.
    if name == 'bash':
        brew = '/opt/homebrew/bin/bash'
        if re.fullmatch(r'/opt/homebrew/Cellar/bash/[^/]+/bin/bash', os.path.realpath(brew)):
            trusted.add(brew)
    if name == 'node':
        for candidate in (executable, shutil.which(name)):
            if candidate and candidate not in system_paths and os.path.isabs(candidate) and (re.fullmatch(r'/opt/homebrew/Cellar/node(?:@\d+)?/[^/]+/bin/node', os.path.realpath(candidate)) or
                              re.fullmatch(re.escape(str(Path.home() / '.nvm/versions/node')) + r'/v\d+\.\d+\.\d+/bin/node', os.path.realpath(candidate))):
                trusted.add(candidate)
    if executable in trusted:
        return True
    if executable != name:
        return False
    search = []
    for entry in os.get_exec_path():
        if not os.path.isabs(entry):
            if directory is None:
                return False
            entry = str(directory / entry)
        search.append(entry)
    resolved = shutil.which(name, path=os.pathsep.join(search))
    return resolved is not None and os.path.realpath(resolved) in {os.path.realpath(path) for path in trusted}


FIXTURE_TOOLS = ('mktemp', 'cat', 'ln', 'cp', 'mkdir', 'rm', 'chmod', 'touch', 'mkfifo')
# Reviewed integrations/local-helpers/libexec/repo-node-pin files (sha256).
# init.sh evals select.py's output and select.py runs no other program, so
# only these exact bytes are trusted; the read list below follows select.py.
# A changed helper fails closed until its new hash is reviewed in here.
REPO_NODE_PIN_HASHES = {
    'bash-env.sh': {'84d84773c9b61952f5a39367470ad4043c463e8573259846ec3bb614931c8d60'},
    # Both audited startup forms work; only the newer one sources safe-chain.
    'init.sh': {'d97da32ec68ee02cbf663db7675199cd12e9bd47db27cd9bb45468d133e9a4b0',
                '90a6436ed6c5ab91b13da9fd27e57d26cdd96b6dcfe0677e591ca5f942f38327'},
    'select.py': {'7be0cf8c91fdb19d5ea261085f67d8fe88d9100bf39d3ebca1eec4f6d867eaa4',
                  '1ded56be26d29b956ca8a62217e94c1ca952513f2cd96934a9680c08c045d61d'},
}
# @aikidosec/safe-chain 1.5.29; its only startup read is this exact script.
REPO_NODE_PIN_SAFE_CHAIN_SHA256 = '1802eddd1a871cd5dc639d894be3cbf069679adba3a24aa49cbb90786cce9e1d'
REPO_NODE_PIN_SAFE_CHAIN_SOURCE = b'[ ! -r "$HOME/.safe-chain/scripts/init-posix.sh" ] || . "$HOME/.safe-chain/scripts/init-posix.sh"'
REPO_NODE_PIN_PYTHON = '/opt/homebrew/bin/python3'
# select.py may move these harness guard dirs to the front of PATH.
REPO_NODE_PIN_MANAGED = ('.config/opencode/skills/remote-compute/scripts/blockers',
                         '.local/share/harness-hooks/coord-blockers', '.local/share/quint-guard/bin')
REPO_NODE_PIN_INPUTS = ('package.json', '.nvmrc', '.node-version', 'pnpm-lock.yaml')
REPO_NODE_PIN_COMMAND = re.compile(
    r'ROBOB_REPO_|_repo_node_|NVM_DIR|COREPACK_HOME|repo-node-pin|\.nvm\b|libexec|corepack|'
    r'package\.json|\.nvmrc|\.node-version|pnpm-lock\.yaml|CDPATH|'
    r'(?<![\w$])HOME\+?=|\bunset\b[^;&|\n]*\bHOME\b|-u\s*HOME\b')


REPO_NODE_PIN_HERE = re.compile(r'HERE="\$\(cd "\$\(dirname "\$0"\)/\.\." && pwd\)"')


def _repo_node_pin_cd_proof(source):
    """The pinned cd wrapper refreshes after every cd. The startup proof walks
    only the invocation cwd and $(dirname "$0")/.., so allow at most one cd: the
    HERE line's subshell, which leaves the script's own cwd unchanged, with no
    CDPATH search, an unchanged $0 and $PWD, and logical cd."""
    code = '\n'.join(line for line in source.splitlines() if not line.lstrip().startswith('#'))
    # Bash and the fixture lexer drop quotes, escapes and continuations from
    # command words (c""d, c\d, c\<newline>d); scan with all of them removed.
    flat = re.sub(r'[\'"\\]', '', code.replace('\\\n', ''))
    # Logical cd resolves against $PWD; physical mode and cdable_vars change
    # what the one allowed cd reaches.
    redirect = re.compile(r'CDPATH|BASH_ARGV0|cdable_vars|\bshopt\b|(?<![\w$])(?:OLD)?PWD\+?=|'
                          r'\b(?:export|declare|typeset|local|readonly|unset|read)\b[^\n;]*\b(?:OLD)?PWD\b|'
                          r'\bset\s+(?:-[A-Za-z]*P|-o\s+physical)')
    if redirect.search(code) or redirect.search(flat):
        return False
    change = re.compile(r'(?<![\w.$/-])(?:cd|pushd|popd)(?![\w.-])')
    changes = list(change.finditer(code))
    if not changes and not change.search(flat):
        return True
    lines = re.findall(r'(?m)^.*\bHERE\s*=.*$', code)
    return (len(changes) == 1 and len(change.findall(flat)) == 1 and len(lines) == 1 and
            REPO_NODE_PIN_HERE.fullmatch(lines[0].strip()) is not None and
            changes[0].start() == code.index(lines[0]) + lines[0].index('cd'))


def _repo_node_pin_input_safe(path):
    """select.py opens this path before the script runs; it must not be live."""
    try:
        os.lstat(path)
    except FileNotFoundError:
        return True
    except OSError:
        return False
    if LIVE.search(str(path)) or LIVE.search(os.path.realpath(path)):
        return False
    try:
        info = os.stat(path)
    except FileNotFoundError:
        return True
    except OSError:
        return False
    # Opening a directory fails harmlessly. A second hard link can be the
    # live database under another name.
    return stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode) and info.st_nlink == 1


def _repo_node_pin_inputs_safe(directories, home, helper, nvm, search, unchanged=None):
    """Every file the pinned select.py can open from these cwds and environment."""
    if not directories or any(directory is None for directory in directories):
        return False
    inputs = []
    starts = {start for directory in directories
              for start in (os.path.normpath(os.path.abspath(directory)), os.path.realpath(directory))}
    for start in starts:
        current = start
        while True:
            inputs += [os.path.join(current, name) for name in REPO_NODE_PIN_INPUTS]
            parent = os.path.dirname(current)
            if os.path.exists(os.path.join(current, '.git')) or parent == current:
                break
            current = parent

    def children(root):
        # select.py opens alias files by name, so an unlistable directory
        # that still allows lookups hides inputs; only absence proves none.
        try:
            return [entry.path for entry in os.scandir(root)]
        except (FileNotFoundError, NotADirectoryError):
            return []

    try:
        inputs += children(os.path.join(nvm, 'alias'))
        inputs += [os.path.join(version, 'lib/node_modules/pnpm/package.json')
                   for version in children(os.path.join(nvm, 'versions/node'))]
        for entry in search:
            pnpm = os.path.join(entry, 'pnpm')
            if unchanged is not None and not unchanged(pnpm):
                return False
            if os.path.exists(pnpm):
                inputs.append(os.path.join(os.path.dirname(os.path.dirname(os.path.realpath(pnpm))), 'package.json'))
        # select.py uses get(name, default): an empty or relative value is
        # resolved against whatever cwd the refresh runs in.
        corepack = os.environ.get('COREPACK_HOME', os.path.join(home, '.cache/node/corepack'))
        if not os.path.isabs(corepack):
            return False
        if unchanged is not None and not unchanged(corepack, descendants=True):
            return False
        inputs += [os.path.join(version, 'package.json') for version in children(os.path.join(corepack, 'v1/pnpm'))]
    except OSError:
        return False
    return all(_repo_node_pin_input_safe(path) and (unchanged is None or unchanged(path)) for path in inputs)


def _inherited_startup_safe(name, directory, command=None, bindings=None, written=(), script=None, unchanged=None):
    """Accept an inherited BASH_ENV only as this Mac's repo-node-pin wrapper.

    Every agent shell here inherits it from ~/.zshenv. Its init.sh evals
    select.py's output, which no static scan resolves, so the proof pins the
    chain instead: reviewed file hashes, default helper and Python locations,
    clean select.py inputs, and no fixture tool reachable through any PATH
    entry the chain can add or reorder. A binding set by the command itself is
    never inherited and stays refused by callers.
    """
    value = os.environ.get(name, '')
    home = os.environ.get('HOME', '')
    if name != 'BASH_ENV' or not value or not home or not os.path.isabs(home) or str(Path.home()) != home:
        return False
    if any(other != 'BASH_ENV' and setting and STARTUP_ENV.fullmatch(other) for other, setting in os.environ.items()):
        return False
    if any(other.startswith('BASH_FUNC_') for other in os.environ) or os.environ.get('ZDOTDIR') or os.environ.get('CDPATH'):
        return False
    if bindings is not None and (bindings.get('HOME', home) != home or any(key != 'HOME' and REPO_NODE_PIN_COMMAND.search(key + '=') for key in bindings)):
        return False
    if command is not None and REPO_NODE_PIN_COMMAND.search(command):
        return False
    helper = os.path.join(home, '.local/libexec/repo-node-pin')
    # Bash expands BASH_ENV before reading it.
    if not os.path.isabs(value) or re.search(r'[$`~\\]', value):
        return False
    real_helper = os.path.realpath(helper)
    if os.path.realpath(value) != os.path.join(real_helper, 'bash-env.sh'):
        return False
    if os.environ.get('ROBOB_REPO_PREVIOUS_BASH_ENV', '') not in {'', value}:
        return False
    if os.path.realpath(os.environ.get('ROBOB_REPO_NODE_HELPER') or helper) != real_helper:
        return False
    if (os.environ.get('ROBOB_REPO_NODE_PYTHON') or REPO_NODE_PIN_PYTHON) != REPO_NODE_PIN_PYTHON:
        return False
    nvm = os.environ.get('NVM_DIR', os.path.join(home, '.nvm'))
    if not os.path.isabs(nvm):
        return False
    # Hashes describe the current disk, not pending shell writes. Include
    # directory contents that can become new imports or lookup candidates.
    if unchanged is not None and (not unchanged(REPO_NODE_PIN_PYTHON) or
            any(not unchanged(root, descendants=True) for root in
                (helper, nvm, os.path.join(home, '.safe-chain'),
                 *(os.path.join(home, managed) for managed in REPO_NODE_PIN_MANAGED)))):
        return False
    for remembered in written:
        resolved = os.path.realpath(remembered)
        if any(resolved == root or resolved.startswith(root + os.sep)
               for root in (real_helper, os.path.realpath(nvm))):
            return False
    sources_safe_chain = False
    for part, hashes in REPO_NODE_PIN_HASHES.items():
        if unchanged is not None and not unchanged(os.path.join(real_helper, part)):
            return False
        try:
            with open(os.path.join(real_helper, part), 'rb') as handle:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_SOURCE_BYTES:
                    return False
                body = handle.read(MAX_SOURCE_BYTES + 1)
                if hashlib.sha256(body).hexdigest() not in hashes:
                    return False
                if part == 'init.sh':
                    sources_safe_chain = body.splitlines().count(REPO_NODE_PIN_SAFE_CHAIN_SOURCE) == 1
        except OSError:
            return False
    safe_chain = os.path.join(home, '.safe-chain')
    safe_chain_bin = None
    if sources_safe_chain:
        startup = os.path.join(safe_chain, 'scripts/init-posix.sh')
        if unchanged is not None and not unchanged(startup):
            return False
        failure = startup + ' does not match REPO_NODE_PIN_SAFE_CHAIN_SHA256; review and re-pin the safe-chain startup file.'
        if any(os.path.realpath(remembered) == os.path.realpath(safe_chain) or
               os.path.realpath(remembered).startswith(os.path.realpath(safe_chain) + os.sep)
               for remembered in written):
            raise AmbiguousScript(failure)
        try:
            os.lstat(startup)
        except FileNotFoundError:
            pass
        except OSError:
            raise AmbiguousScript(failure) from None
        else:
            confined = os.path.join(os.path.realpath(home), '.safe-chain') + os.sep
            if not os.path.realpath(startup).startswith(confined) or not _repo_node_pin_input_safe(startup):
                raise AmbiguousScript(failure)
            try:
                with open(startup, 'rb') as handle:
                    info = os.fstat(handle.fileno())
                    if (not stat.S_ISREG(info.st_mode) or info.st_size > MAX_SOURCE_BYTES or
                            hashlib.sha256(handle.read(MAX_SOURCE_BYTES + 1)).hexdigest() != REPO_NODE_PIN_SAFE_CHAIN_SHA256):
                        raise AmbiguousScript(failure)
                safe_chain_bin = os.path.join(os.path.dirname(os.path.realpath(os.path.dirname(startup))), 'bin')
            except OSError:
                raise AmbiguousScript(failure) from None
    # Python puts the script's directory first on sys.path, even with -S.
    try:
        entries = list(os.scandir(real_helper))
    except OSError:
        return False
    for entry in entries:
        if entry.name == 'select.py':
            continue
        if entry.name == '__pycache__' or entry.name.endswith(('.py', '.pyc', '.so', '.pth')):
            return False
        try:
            if entry.is_dir() and any(os.path.lexists(os.path.join(entry.path, init)) for init in ('__init__.py', '__init__.pyc')):
                return False
        except OSError:
            return False
    # Startup prepends Node and pnpm dirs, moves managed dirs forward and drops
    # one Node entry, so no fixture tool may resolve differently in any order.
    search = list(os.get_exec_path())
    search += glob.glob(os.path.join(glob.escape(nvm), 'versions', 'node', '*', 'bin'))
    search += [os.path.join(helper, 'pnpm-bin'), *(os.path.join(home, managed) for managed in REPO_NODE_PIN_MANAGED)]
    if safe_chain_bin is not None:
        search.append(safe_chain_bin)
    added = os.environ.get('_repo_node_added_node', '')
    if added:
        search.append(added)
    if any(not os.path.isabs(entry) for entry in search):
        return False
    startup_tools = ('dirname',) if safe_chain_bin is not None else ()
    for tool in (*FIXTURE_TOOLS, *startup_tools):
        trusted = {os.path.realpath(f'/bin/{tool}'), os.path.realpath(f'/usr/bin/{tool}')}
        for entry in search:
            candidate = os.path.join(entry, tool)
            if unchanged is not None and not unchanged(candidate):
                return False
            if os.path.lexists(candidate) and os.path.realpath(candidate) not in trusted:
                return False
    # The refresh also runs after each cd. The fixture grammar allows only
    # `cd "$(dirname "$0")/.."`, and its child shells either clear the
    # environment or run `sleep`, so the script's parent is the one other cwd.
    directories = [directory]
    if script is not None and directory is not None:
        directories.append(os.path.join(directory, os.path.dirname(str(script)), '..'))
    return _repo_node_pin_inputs_safe(directories, home, helper, nvm, search, unchanged)


def _fixture_python_paths(tree, aliases, local_module):
    """File reads must derive from the invocation's confined path arguments."""
    definitions, stores = {}, {}

    def define(target, mode, value, indexes=()):
        if isinstance(target, ast.Name):
            definitions.setdefault(target.id, []).append((id(target), mode, value, indexes))
        elif isinstance(target, (ast.Tuple, ast.List)):
            for index, part in enumerate(target.elts):
                define(part, mode, value, (*indexes, index))

    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            stores.setdefault(node.id, set()).add(id(node))
        if isinstance(node, ast.Assign):
            for target in node.targets:
                define(target, 'assign', node.value)
        elif isinstance(node, (ast.AnnAssign, ast.NamedExpr)):
            define(node.target, 'assign', node.value)
        elif isinstance(node, (ast.For, ast.comprehension)):
            define(node.target, 'iterate', node.iter)

    def called(node):
        root, *rest = _name(node.func).split('.')
        return '.'.join([aliases.get(root, root), *rest])

    def item(value):
        if value == 'paths':
            return 'path'
        if value == 'relatives':
            return 'relative'
        if value == 'walk':
            return ('path', 'relatives', 'relatives')
        if value == 'items':
            return ('relative', None)
        return None

    def kind(node, seen=frozenset()):
        if isinstance(node, ast.Name):
            if node.id in seen:
                return None
            entries = definitions.get(node.id, [])
            if not entries or stores.get(node.id) != {entry[0] for entry in entries}:
                return None
            values = []
            for _, mode, value, indexes in entries:
                value = kind(value, seen | {node.id})
                if mode == 'iterate':
                    value = item(value)
                for index in indexes:
                    value = value[index] if isinstance(value, tuple) and index < len(value) else item(value)
                values.append(value)
            return values[0] if values[0] is not None and all(value == values[0] for value in values) else None
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return 'relative' if not os.path.isabs(node.value) and '..' not in node.value.split('/') and '\\' not in node.value else None
        if isinstance(node, ast.Dict) and all(key is not None and kind(key, seen) == 'relative' for key in node.keys):
            return 'dictionary'
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            left, right = kind(node.left, seen), kind(node.right, seen)
            return left if left == right and left in {'paths', 'relatives'} else None
        if isinstance(node, ast.Subscript):
            if _name(node.value) == 'sys.argv':
                minimum = 2 if local_module == 'transcript_backup_manifest' else 1
                index = node.slice.lower if isinstance(node.slice, ast.Slice) else node.slice
                if isinstance(index, ast.Constant) and type(index.value) is int and index.value >= minimum:
                    return 'paths' if isinstance(node.slice, ast.Slice) and node.slice.step is None else 'path' if not isinstance(node.slice, ast.Slice) else None
            value = kind(node.value, seen)
            return value if isinstance(node.slice, ast.Slice) and value in {'paths', 'relatives'} else item(value) if not isinstance(node.slice, ast.Slice) else None
        if isinstance(node, ast.ListComp):
            value = kind(node.elt, seen)
            return {'path': 'paths', 'relative': 'relatives'}.get(value)
        if isinstance(node, ast.Call):
            name = called(node)
            values = [kind(arg, seen) for arg in node.args]
            if name == 'os.path.join' and values and values[0] == 'path' and all(value == 'relative' for value in values[1:]) and not node.keywords:
                return 'path'
            if name == 'os.path.basename' and len(values) == 1 and values[0] in {'path', 'relative'} and not node.keywords:
                return 'relative'
            if name in {'glob.glob', 'os.walk'} and values == ['path'] and not node.keywords:
                return 'paths' if name == 'glob.glob' else 'walk'
            if isinstance(node.func, ast.Attribute) and node.func.attr == 'items' and kind(node.func.value, seen) == 'dictionary':
                return 'items'
        return None

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = called(node)
        if _name(node.func).split('.')[-1] == 'open' or name in {'glob.glob', 'os.walk'}:
            if not node.args or kind(node.args[0]) != 'path':
                return False
        if name == 'transcript_backup_manifest.verify' and (len(node.args) != 2 or kind(node.args[1]) != 'path'):
            return False
    return True


def _fixture_python_readonly(source, tree=None, local_module=None, pathlib_reads=False, data_helpers=False, database_fixture=False):
    """The fixture's Python helpers may inspect files, not change its tree."""
    try:
        if tree is None:
            with warnings.catch_warnings():
                warnings.simplefilter('ignore', SyntaxWarning)
                warnings.simplefilter('ignore', DeprecationWarning)
                tree = ast.parse(source)
    except (SyntaxError, ValueError):
        return False
    if database_fixture:
        _, aliases, bindings = _python_tree(source)
        if not _fixture_python_paths(tree, aliases, local_module):
            return False
        walk_targets = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.For) and isinstance(node.iter, ast.Call) and _name(node.iter.func) == 'os.walk' and isinstance(node.target, ast.Tuple) and len(node.target.elts) == 3:
                for part in node.target.elts[1:]:
                    if isinstance(part, ast.Name):
                        walk_targets.setdefault(part.id, set()).add(id(part))
        # Only unchanged os.walk list bindings justify addition. A later
        # assignment could otherwise turn the same names into path strings.
        walk_lists = {name for name, targets in walk_targets.items()
                      if all(id(node) in targets for node in ast.walk(tree)
                             if isinstance(node, ast.Name) and node.id == name and isinstance(node.ctx, ast.Store))}
        for node in ast.walk(tree):
            if isinstance(node, ast.AugAssign):
                return False
            value = _path_expression(node, bindings, aliases, partial=True)
            if value is not None and LIVE.search(value):
                return False
            literal = (node.value.decode('latin-1') if isinstance(node, ast.Constant) and isinstance(node.value, bytes) else
                       node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else _name(node))
            if re.search(r'statev2|opencode|robob|\.sqlite|\.db|userdata', literal, re.I):
                return False
            if local_module != 'transcript_backup_manifest' and literal.split('.')[-1] in {'glob', 'listdir', 'scandir', 'walk', 'iterdir', 'rglob'}:
                return False
            if isinstance(node, ast.JoinedStr) or isinstance(node, ast.BinOp) and (
                    isinstance(node.op, ast.Mod) or isinstance(node.op, ast.Add) and not
                    all(isinstance(part, ast.Name) and part.id in walk_lists for part in (node.left, node.right))):
                return False
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'join':
                name = _name(node.func)
                root, *rest = name.split('.')
                if '.'.join([aliases.get(root, root), *rest]) != 'os.path.join':
                    return False
    modules = {'json', 'sys', 'os', 'glob', 'hashlib'}
    if pathlib_reads:
        modules.add('pathlib')
    if local_module:
        modules.add(local_module)
    attributes = {'argv', 'stdin', 'stdout', 'stderr', 'basename', 'excluded', 'exists', 'glob', 'hexdigest', 'insert', 'islink', 'items', 'join', 'load', 'loads', 'path', 'read', 'sha256', 'verify', 'walk'}
    if pathlib_reads:
        attributes |= {'Path', 'home', 'read_text', 'read_bytes'}
    functions = {'print', 'len', 'set', 'dict', 'list', 'tuple', 'str', 'int', 'bool', 'all', 'any', 'enumerate', 'range', 'sorted', 'min', 'max', 'open', 'SystemExit'}
    if data_helpers:
        attributes |= {'get', 'values', 'setdefault', 'exit', 'dumps'}
        functions |= {'isinstance', 'Exception', 'Path'}
        helpers = [node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)]
        if any(node.name in functions | modules or node.decorator_list for node in helpers):
            return False
        functions.update(node.name for node in helpers)
    for node in ast.walk(tree):
        if isinstance(node, (ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)) or isinstance(node, ast.FunctionDef) and not data_helpers:
            return False
        if isinstance(node, ast.Import) and any(n.name not in modules or n.asname in functions for n in node.names):
            return False
        # Imported members can disguise a mutator as an allowed builtin.
        # The generated failure stand-in is the sole wildcard import used by
        # this fixture; ordinary helpers use module-qualified attributes.
        if isinstance(node, ast.ImportFrom) and not (local_module == node.module == 'fixture_run_limited' and node.level == 0 and len(node.names) == 1 and node.names[0].name == '*' and node.names[0].asname is None) and not (data_helpers and node.module == 'pathlib' and node.level == 0 and len(node.names) == 1 and node.names[0].name == 'Path' and node.names[0].asname is None):
            return False
        if isinstance(node, ast.Attribute) and node.attr == 'insert' and (local_module != 'transcript_backup_manifest' or _name(node) != 'sys.path.insert'):
            return False
        if isinstance(node, ast.Call) and _name(node.func) == 'sys.path.insert' and (len(node.args) != 2 or not isinstance(node.args[0], ast.Constant) or node.args[0].value != 0 or ast.unparse(node.args[1]) != 'sys.argv[1]'):
            return False
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store) and node.id in functions | modules:
            return False
        if data_helpers and isinstance(node, ast.arg) and node.arg in functions | modules:
            return False
        if data_helpers and isinstance(node, (ast.Global, ast.Nonlocal)):
            return False
        if isinstance(node, ast.Attribute) and (node.attr not in attributes or isinstance(node.ctx, ast.Store)):
            return False
        if isinstance(node, ast.Subscript) and isinstance(node.ctx, ast.Store):
            root = node.value
            while isinstance(root, ast.Subscript):
                root = root.value
            if not data_helpers or not isinstance(root, ast.Name) or root.id in functions | modules:
                return False
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id not in functions:
                return False
            if not isinstance(node.func, (ast.Name, ast.Attribute)):
                return False
            if isinstance(node.func, ast.Name) and node.func.id == 'open':
                mode = node.args[1] if len(node.args) > 1 else next((k.value for k in node.keywords if k.arg == 'mode'), ast.Constant('r'))
                if not isinstance(mode, ast.Constant) or mode.value not in {'r', 'rb', 'rt'} or any(k.arg not in {'mode', 'encoding', 'errors'} for k in node.keywords):
                    return False
    return True


def _fixture_setup(source):
    """Recognize a fixture reset function, without trusting a filename or digest."""
    # This extended form has one root reset at the start of a function. Each
    # read must follow that reset, including after the previous tree is removed.
    match = re.search(r'(?m)^([A-Za-z_]\w*)\(\)[ \t]*\{[ \t]*(?:#[^\n]*)?\n[ \t]*([A-Za-z_]\w*)=\$\(mktemp -d "\$([A-Za-z_]\w*)/[^"$`]+"\)', source)
    if not match:
        return False
    function, root, parent = match.groups()
    if re.search(r'\bimport transcript_backup_manifest\b', source) and (len(re.findall(r'\bHERE\s*=', source)) != 1 or not re.search(r'(?m)^HERE="\$\(cd "\$\(dirname "\$0"\)/\.\." && pwd\)"$', source)):
        return False
    if {root, parent} & {'HOME', 'home', 'CODEX_HOME', 'PWD', 'OLDPWD', 'PATH', 'CDPATH', 'IFS', 'ENV', 'BASH_ENV', 'TMPDIR', 'SHELLOPTS', 'BASHOPTS'}:
        return False
    if len(re.findall(r'(?m)^' + re.escape(function) + r'\(\)', source)) != 1 or re.search(r'\b(?:mktemp|cat|bash)\s*\(\s*\)|\bfunction\s+(?:mktemp|cat|bash)\b', source):
        return False
    if not re.search(r'(?m)^' + re.escape(parent) + r'=\$\(mktemp -d "\$\{TMPDIR:-/tmp\}/[^"$`]+"\) \|\| exit 1$', source[:match.start()]):
        return False
    shell, bodies = _heredocs(source)
    python_bodies = set()
    python_modules = {}
    for key, (body, _) in bodies.items():
        # Non-Python fixture data is checked by the shell source scan. A
        # parseable Python helper must satisfy the read-only grammar too.
        try:
            with warnings.catch_warnings():
                warnings.simplefilter('ignore', SyntaxWarning)
                warnings.simplefilter('ignore', DeprecationWarning)
                tree = ast.parse(body)
        except (SyntaxError, ValueError):
            continue
        local_module = None
        if re.search(r'\bimport transcript_backup_manifest\b', body):
            if not re.search(r'"\$PYTHON" - "\$HERE/src"[^\n]*<< ' + key + r'\b', shell):
                return False
            local_module = 'transcript_backup_manifest'
        if re.search(r'\bfrom fixture_run_limited import \*', body):
            if not re.search(r'cp "\$R/src/run_limited\.py" "\$R/src/fixture_run_limited\.py"\ncat > "\$R/src/run_limited\.py" << ' + key + r'\b', shell) or source.count('$R/src/fixture_run_limited.py') != 1:
                return False
            local_module = 'fixture_run_limited'
        if not _fixture_python_readonly(body, tree, local_module, database_fixture=True):
            return False
        python_bodies.add(key)
        python_modules[key] = local_module
    confined = re.sub(r'\$(?:' + re.escape(root) + r'\b|\{' + re.escape(root) + r'\})/\.robob', 'guard_fixture_home', shell)
    if '.robob' in confined:
        return False
    # A function, shell import or dynamic assignment can invalidate the reset.
    lexer = shlex.shlex(shell, posix=True, punctuation_chars=';&|(){}\n')
    lexer.whitespace = ' \t\r'
    lexer.whitespace_split = True
    tokens = list(lexer)
    # Startup/import settings change what an otherwise literal interpreter
    # executes. Standalone assignments matter too, even before an env prefix.
    if any(STARTUP_ENV.fullmatch(token.split('=', 1)[0]) for token in tokens if '=' in token):
        return False
    if any(token in {'eval', 'source', '.', 'declare', 'typeset', 'local', 'readonly', 'export', 'read', 'readarray', 'mapfile', 'unset', 'let', 'hash', 'enable'} or token.startswith(('PATH=', 'PATH+=')) and tokens[max(0, index - 2):index] != ['env', '-i'] for index, token in enumerate(tokens)) or re.search(r'\bprintf\s+-v|\bwait\s+-p', shell):
        return False
    for name in (root, parent):
        if len(re.findall(r'(?<![\w])' + re.escape(name) + r'(?:\[[^\]\n]*\])?\+?=', source)) != 1:
            return False
        if re.search(r'\b(?:for|select|getopts)\s+' + re.escape(name) + r'\b', shell):
            return False
    # Repeated root expansions in a snapshot path stay inside the first root
    # only when the inherited temp prefix cannot insert parent segments.
    temp_prefix = os.environ.get('TMPDIR') or '/tmp'
    if not os.path.isabs(temp_prefix) or '..' in temp_prefix.split('/') or re.search(r'\bTMPDIR(?:\[[^\]\n]*\])?\+?=|\b(?:for|select|getopts)\s+TMPDIR\b', shell):
        return False
    # Descendants contain only known temp roots and literal path pieces.
    descendants = {root, parent}

    def confined_path(value):
        value = value.replace('\\\n', '')
        roots = r'\$(?:' + '|'.join(map(re.escape, descendants)) + r')\b'
        return bool(re.match(roots + r'(?:/|$)', value) and
                    not re.search(r'[$`\\\'"]', re.sub(roots, 'guard_fixture_root', value)) and '..' not in value.split('/'))

    for line in shell.splitlines():
        assignment = re.fullmatch(r'\s*([A-Za-z_]\w*)="([^"`\n]+)"\s*', line)
        if assignment and confined_path(assignment[2]):
            descendants.add(assignment[1])
    derived = descendants - {root, parent}
    if derived and re.search(r'\b(?:' + '|'.join(map(re.escape, derived)) + r')(?:\[[^\]\n]*\]\+?=|\+=)', shell):
        return False
    assignments = re.finditer(r'\b(' + '|'.join(map(re.escape, derived)) + r')=("[^"\n]*"|[^\s;]+)', shell) if derived else ()
    for assignment in assignments:
        value = assignment[2].strip('"')
        if not confined_path(value):
            return False
    if re.search(r'\b(?:for|select|getopts)\s+(?:' + '|'.join(map(re.escape, descendants)) + r')\b', shell):
        return False
    if any(os.path.basename(token) in {'mv', 'mount', 'umount', 'rsync', 'ditto', 'rmdir', 'tar', 'unzip', 'cpio', 'install'} for token in tokens):
        return False
    for index, token in enumerate(tokens):
        if os.path.basename(token) == 'ln':
            paths = []
            for word in tokens[index + 1:]:
                if re.fullmatch(r'[;&|(){}\n]+', word):
                    break
                if not word.startswith('-'):
                    paths.append(word)
                elif word not in {'-s', '--'}:
                    return False
            if len(paths) != 2 or any(not re.fullmatch(r'\$(?:' + '|'.join(map(re.escape, descendants)) + r')(?:/[^$`]+)?', word) or '..' in word.split('/') for word in paths):
                return False
    # Tokenize before tracking calls: text inside quotes and function bodies
    # cannot establish a binding in the caller. Substitutions remain opaque.
    masked, quoted = _quoted_punctuation(shell)
    chars, quote, index = list(masked), None, 0
    while index < len(chars):
        char = chars[index]
        if char == '\\' and quote != "'":
            index += 2
            continue
        if char in {'"', "'"} and quote in {None, char}:
            quote = char if quote is None else None
        elif char == '#' and quote is None and (index == 0 or chars[index - 1].isspace()):
            while index < len(chars) and chars[index] != '\n':
                chars[index] = ' '
                index += 1
            continue
        index += 1
    masked = ''.join(chars)
    masked = re.sub(r'\$\(\([^()\n]*\)\)', 'guard_arithmetic', masked)
    masked = masked.replace('\\\n', '').replace('\\\r\n', '')
    masked = masked.replace('2>&1', ' guard_stderr_redirect')
    lexer = shlex.shlex(masked, posix=True, punctuation_chars=';&|(){}\n<')
    lexer.whitespace = ' \t\r'
    lexer.whitespace_split = True
    groups, group, input_redirect = [], [], False
    for token in [*lexer, '\n']:
        if re.fullmatch(r'[;&|(){}\n]+', token):
            groups.append((group, token, input_redirect))
            group, input_redirect = [], False
        else:
            input_redirect |= bool(re.fullmatch(r'[<;&|(){}\n]+', token) and '<' in token)
            for key, literal in quoted.items():
                token = token.replace(key, literal)
            group.append(token)
    tools = dict(re.findall(r'(?m)^([A-Za-z_]\w*)=(/[^\s$`]+)$', shell))
    allowed_helpers = {'/opt/homebrew/opt/sqlite/bin/sqlite3', '/opt/homebrew/bin/python3', '/opt/homebrew/bin/restic'}
    commands = {'set', 'trap', 'cat', 'chmod', 'mkdir', 'touch', 'echo', 'cp', 'printf', 'ln', 'env', 'rm', 'grep', 'ls', 'mkfifo', 'kill', 'wait', 'true', 'false', 'exit', '[', ':', 'bash', 'sh', 'date', 'wc', 'tr', 'sleep', 'cd', 'pwd', 'dirname', 'mktemp'}
    syntax = {'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', '!', 'in'}
    if tools and re.search(r'\b(?:for|select|getopts)\s+(?:' + '|'.join(map(re.escape, tools)) + r')\b', shell):
        return False
    active, branches, cases, defining, pending = False, [], [], None, None
    declared, runners, conditional_call = set(), set(), False
    fixture = re.compile(r'\$\{?' + re.escape(root) + r'\}?/' + SHELL_FIXTURE_DATABASE + r'\b')

    # Imported modules come from the repo. Fixture output must never rewrite
    # that source tree, including through a temporary alias for its directory.
    redirect_shell, redirect_quotes = _quoted_punctuation(shell)
    redirect_shell = redirect_shell.replace('2>&1', '')
    lexer = shlex.shlex(redirect_shell, posix=True, punctuation_chars=';&|(){}\n<>')
    lexer.whitespace = ' \t\r'
    lexer.whitespace_split = True
    redirect_tokens = list(lexer)
    for index, token in enumerate(redirect_tokens):
        if token not in {'>', '>>'}:
            continue
        if index + 1 >= len(redirect_tokens):
            return False
        target = redirect_tokens[index + 1]
        for key, literal in redirect_quotes.items():
            target = target.replace(key, literal)
        if target != '/dev/null' and not confined_path(target):
            return False

    def command_safe(words, input_redirect=False, piped_input=False):
        words = list(words)
        environment, isolated_environment = {}, False
        # Assignments and env are prefixes, never the executable being proved.
        for _ in range(MAX_SHELL_DEPTH):
            while words and re.match(r'[A-Za-z_]\w*=', words[0]):
                name, value = words.pop(0).split('=', 1)
                if STARTUP_ENV.fullmatch(name):
                    return False
                environment[name] = value
            if not words:
                return True
            if words[0] in {'if', 'while', 'until', 'then', 'else', 'do', '!'}:
                words.pop(0)
            elif words[0] == 'env':
                words.pop(0)
                if words[:1] == ['-i']:
                    words.pop(0)
                    environment, isolated_environment = {}, True
                elif words and words[0].startswith('-'):
                    return False
            else:
                break
        else:
            return False
        if not words:
            return True
        words = [word for word in words if word not in {'>/dev/null', '2>/dev/null', 'guard_stderr_redirect'}]
        executable, args = words[0], words[1:]
        if executable.startswith('$'):
            name = executable[1:]
            if tools.get(name) not in allowed_helpers or len(re.findall(r'\b' + re.escape(name) + r'\s*=', shell)) != 1:
                return False
            executable = tools[name]
        elif '$' in executable or '`' in executable:
            return False
        if executable not in commands | syntax | declared and executable not in allowed_helpers and not (os.path.dirname(executable) in {'/bin', '/usr/bin'} and os.path.basename(executable) in commands):
            return False
        binary = os.path.basename(executable)
        if binary == 'sqlite3':
            sql_args = list(args)
            safe_sql = sql_args[:3] == ['-safe', '-noinit', '--']
            if safe_sql:
                sql_args = sql_args[3:]
            elif sql_args[:1] == ['-readonly']:
                sql_args.pop(0)
            # Only argv SQL is inspected here. File, pipe, heredoc and inherited
            # stdin can carry additional commands, so none proves isolation.
            if input_redirect or piped_input or len(sql_args) < 2:
                return False
            if sql_args[0] != ':memory:' and not confined_path(sql_args[0]):
                return False
            # These SQLite helpers can change the fixture's filesystem; inspect
            # only SQL operands so Python's json.load remains a normal read.
            sql = '\n'.join(bodies[word][0] if word in bodies else word for word in sql_args[1:])
            if re.search(r'(?m)^\s*\.|(?i:\b(?:load_extension|writefile)\s*\()', sql):
                return False
            # Generated dumps are evaluated only by SQLite's restricted mode.
            # -- fixes option parsing and -noinit excludes startup SQL. Ordinary
            # fixture SQL only interpolates the numeric clock value it uses.
            if not safe_sql and any(char in sql.replace('$(date +%s)', '') for char in '$`'):
                return False
        if binary == 'cp':
            if not args or not confined_path(args[-1]) or any(not (confined_path(word) or re.fullmatch(r'\$HERE/(?:scripts/[\w.-]+\.sh|src/[\w.-]+\.py)', word)) or '..' in word.split('/') for word in args):
                return False
        if binary == 'ln' and (any(word.startswith('-') and word not in {'-s', '--'} for word in args) or len([word for word in args if not word.startswith('-')]) != 2 or any(not confined_path(word) for word in args if not word.startswith('-'))):
            return False
        # A fixture's database names cannot excuse a reader whose operand is
        # assembled from unrelated shell state, even if no live name is literal.
        if binary == 'cat':
            index = 0
            while index < len(args):
                word = args[index]
                if word in {'>', '>>', '<', '<<'}:
                    if index + 1 >= len(args):
                        return False
                    target = args[index + 1]
                    if not (target in bodies if word == '<<' else target == '/dev/null' or confined_path(target)):
                        return False
                    index += 2
                    continue
                if word != '--' and not confined_path(word):
                    return False
                index += 1
        if binary == 'grep':
            operands = list(args)
            while operands and operands[0] in {'-q', '-c', '--'}:
                operands.pop(0)
            if not operands or operands[0].startswith('-'):
                return False
            if any(not confined_path(word) for word in operands[1:]):
                return False
        if binary in {'bash', 'sh'} and '-c' in args:
            code = args[args.index('-c') + 1:]
            return bool(code and re.fullmatch(r'sleep [0-9]+; :', code[0]))
        if binary in {'bash', 'sh'}:
            script = re.fullmatch(r'\$([A-Za-z_]\w*)/scripts/memory_backup\.sh', args[0]) if len(args) == 1 else None
            if not (script and script[1] in descendants and isolated_environment and environment.get('HOME') in {'$' + root, '${' + root + '}'}):
                return False
            operand = '$' + script[1] + '/scripts/memory_backup.sh'
            copied = r'cp\s+"\$HERE/scripts/memory_backup\.sh"\s+"\$' + re.escape(script[1]) + r'/scripts/"'
            if source.count(operand) != 1 or not re.search(copied, shell):
                return False
            if defining is not None:
                runners.add(defining)
        if executable in runners and (len(args) > 1 or any(not confined_path(arg) for arg in args)):
            return False
        if binary == 'python3':
            if args[:1] == ['-c']:
                return len(args) >= 2 and _fixture_python_readonly(args[1], database_fixture=True) and all(confined_path(word) for word in args[2:])
            if args[:1] != ['-'] or args.count('<<') != 1:
                return False
            index = args.index('<<')
            if index + 2 != len(args) or args[index + 1] not in python_bodies or any('<' in word for word in args[:index]):
                return False
            paths = args[1:index]
            if python_modules[args[index + 1]] == 'transcript_backup_manifest':
                if paths[:1] != ['$HERE/src']:
                    return False
                paths = paths[1:]
            return all(confined_path(word) for word in paths)
        if binary == 'trap':
            return args == ['rm -rf "$' + parent + '"', 'EXIT']
        if binary == 'cd':
            # With an inherited BASH_ENV, _repo_node_pin_cd_proof also limits
            # where and how often this runs; widen both together.
            return args == ['$(dirname "$0")/..']
        return True

    piped_input = False
    for words, separator, input_redirect in groups:
        separator = separator.strip(';\n') or '\n'
        if separator == '()' and len(words) == 1:
            pending = words[0]
            continue
        if separator == '{' and pending is not None and defining is None:
            if branches or cases or conditional_call or pending in declared:
                return False
            defining, pending = pending, None
            continue
        if separator == ')' and cases and len(words) == 1 and re.fullmatch(r'[\w*?!-]+', words[0]):
            active = cases[-1]
            continue
        if re.search(r'[(){}]', separator) and separator != '}':
            return False
        if words:
            head = words[0]
            if not command_safe(words, input_redirect, piped_input):
                return False
            if defining is not None:
                if head == 'return' or defining != function and any(fixture.search(word) for word in words):
                    return False
            else:
                if head == 'case':
                    cases.append(active)
                elif head == 'esac' and cases:
                    active = cases.pop() and active
                if head in {'if', 'for', 'while', 'until'}:
                    branches.append(active)
                elif head in {'else', 'elif'} and branches:
                    active = branches[-1]
                elif head in {'fi', 'done'} and branches:
                    active = branches.pop() and active
                if head == function and function in declared and not conditional_call and separator.strip(';\n') == '' and len(words) <= 2 and all(re.fullmatch(r'[A-Za-z0-9_-]+', word) for word in words[1:]):
                    active = True
                if head == 'rm' and any(re.search(r'\$\{?' + re.escape(root) + r'\}?(?:/|$)', word) for word in words[1:]):
                    active = False
                if any(fixture.search(word) for word in words) and not active:
                    return False
        if separator == '}':
            if defining is None:
                return False
            declared.add(defining)
            defining = None
        if words or '&' in separator or '|' in separator:
            conditional_call = '&' in separator or '|' in separator
            piped_input = separator in {'|', '|&'}
    if defining is not None or pending is not None:
        return False

    def substitutions_safe(text, depth=0):
        if depth >= MAX_SHELL_DEPTH:
            return False
        try:
            for body in _substitutions(text, shell=True):
                if not substitutions_safe(body, depth + 1):
                    return False
                masked, quoted = _quoted_punctuation(body)
                lexer = shlex.shlex(masked, posix=True, punctuation_chars=';&|\n<')
                lexer.whitespace = ' \t\r'
                lexer.whitespace_split = True
                group, input_redirect, piped_input = [], False, False
                for token in [*lexer, '\n']:
                    if re.fullmatch(r'[;&|\n]+', token):
                        if not command_safe(group, input_redirect, piped_input):
                            return False
                        if group or '&' in token or '|' in token:
                            piped_input = token.strip(';\n') in {'|', '|&'}
                        group, input_redirect = [], False
                    else:
                        input_redirect |= bool(re.fullmatch(r'[<;&|\n]+', token) and '<' in token)
                        for key, literal in quoted.items():
                            token = token.replace(key, literal)
                        group.append(token)
        except (ValueError, AmbiguousScript):
            return False
        return True

    if not substitutions_safe(shell):
        return False
    return True


def _shell_fixture_source(source, directory):
    """Discount only paths rooted in single, literal mktemp assignments."""
    if any(value and STARTUP_ENV.fullmatch(name) and not (name == 'BASH_ENV' and _inherited_startup_safe(name, directory))
           for name, value in os.environ.items()):
        return source
    if os.environ.get('BASH_ENV') and not _repo_node_pin_cd_proof(source):
        return source
    try:
        stripped, _ = _heredocs(source)
        shell, quoted = _quoted_punctuation(stripped)
        lexer = shlex.shlex(shell, posix=True, punctuation_chars=";&|(){}\n")
        lexer.whitespace = " \t\r"
        lexer.whitespace_split = True
        tokens = list(lexer)
    except (ValueError, AmbiguousScript):
        return source
    reset_fixture = _fixture_setup(source)
    # An inherited PATH can replace mktemp or cat even in a fixture body.
    required_tools = ('cat', 'ln', 'cp', 'mkdir', 'rm', 'chmod', 'touch', 'mkfifo') if reset_fixture else ()
    if not _trusted_fixture_tool('mktemp', 'mktemp', directory) or any(not _trusted_fixture_tool(tool, tool, directory) for tool in required_tools):
        return source
    # Merely assigning in a skipped branch or uncalled function leaves the
    # inherited value intact. Reset functions need a dominance proof;
    # other bodies need a straight-line proof.
    if not reset_fixture and any(token in {'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'case', 'select', 'do', 'done', 'function', 'ln', 'hash'} or token.startswith(('PATH=', 'PATH+=')) or re.fullmatch(r'[;&|(){}\n]*[&|(){}][;&|(){}\n]*', token) for token in tokens):
        return source
    candidates = {}
    for index, token in enumerate(tokens):
        match = re.fullmatch(r"([A-Za-z_]\w*)=(.*)", token, re.S)
        boundary = lambda word: bool(re.fullmatch(r"[;&|(){}\n]+", word))
        if not match or index and not boundary(tokens[index - 1]) or index + 1 < len(tokens) and not boundary(tokens[index + 1]):
            continue
        name, value = match.groups()
        if name in {'HOME', 'home', 'CODEX_HOME'}:
            continue
        for key, literal in quoted.items():
            value = value.replace(key, literal)
        # Any other textual assignment or mutation invalidates the proof,
        # including writes hidden in a branch, heredoc, or quoted command.
        stores = re.findall(r"(?<![\w])" + re.escape(name) + r"(?:\[[^\]\n]*\])?\+?=", source)
        if len(stores) != 1 or re.search(r"\b(?:read|readarray|mapfile|unset|let|for|select|getopts|printf\s+-v)\b[^\n;]*\b" + re.escape(name) + r"\b", shell):
            continue
        if not re.search(r'(?m)^[ \t]*' + re.escape(name) + r'="?\$\(mktemp ', source):
            continue
        if not value.startswith('$(mktemp ') or not value.endswith(')'):
            continue
        body = value[2:-1]
        if re.search(r"[;|&`\n]|\$\(", body):
            continue
        try:
            args = shlex.split(body)
        except ValueError:
            continue
        if args[:2] != ['mktemp', '-d'] or len(args) > 3:
            continue
        template = args[2] if len(args) == 3 else ''
        if template.startswith('-'):
            continue
        template = template.replace('${TMPDIR:-/tmp}', '/tmp')
        deps = re.findall(r"\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))", template)
        if re.sub(r"\$(?:\{[A-Za-z_]\w*\}|[A-Za-z_]\w*)", '', template).find('$') >= 0:
            continue
        candidates[name] = {a or b for a, b in deps}
    # Dynamic writes and imported shell state cannot establish a local proof.
    if (any(token in {'eval', 'source', '.', 'local', 'declare', 'typeset', 'alias', 'export', 'readonly', 'read', 'readarray', 'mapfile', 'getopts', 'let', 'enable', 'unset'} for token in tokens) or
            re.search(r'\b(?:printf\s+-v|wait\s+-p)\b', shell) or
            any(os.path.basename(token) in {'mv', 'mount', 'umount', 'rsync', 'ditto'} for token in tokens) or
            re.search(r'\b(?:symlink|link)\s*\(', source) or
            re.search(r'\bmktemp\s*\(\s*\)|\bfunction\s+mktemp\b', shell)):
        return source
    proven = set()
    for _ in candidates:
        proven.update(name for name, deps in candidates.items() if deps <= proven)
    if not reset_fixture:
        # Keep the general proof closed: only ordered mktemp assignments and
        # a literal fixture read. Reset functions use the separate lifetime proof above.
        groups, group = [], []
        for token in tokens + ['\n']:
            if re.fullmatch(r'[;\n]+', token):
                if group:
                    groups.append(group)
                group = []
            else:
                group.append(token)
        assigned = set()
        for group in groups:
            assignment = re.fullmatch(r'([A-Za-z_]\w*)=.*', group[0], re.S)
            if len(group) == 1 and assignment and assignment[1] in proven and candidates[assignment[1]] <= assigned:
                assigned.add(assignment[1])
                continue
            if len(group) != 2:
                return source
            executable, value = group
            for key, literal in quoted.items():
                executable = executable.replace(key, literal)
                value = value.replace(key, literal)
            # A same-named helper or computed command can alter the fixture
            # root before reading it. Only the system reader preserves it.
            if not _trusted_fixture_tool(executable, 'cat', directory):
                return source
            fixture = re.fullmatch(r'\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})/' + SHELL_FIXTURE_DATABASE, value)
            if not fixture or (fixture[1] or fixture[2]) not in assigned:
                return source
    # A heredoc body may become a child script that never inherits the mktemp
    # root, so an empty root turns a plain subpath into an absolute path. Bodies
    # keep only the hidden-home shape, which stays fixture-only from /.
    body_lines, offset = [], 0
    for line, kept in zip(source.splitlines(keepends=True), stripped.splitlines(keepends=True)):
        if line.strip() and not kept.strip():
            body_lines.append((offset, offset + len(line)))
        offset += len(line)

    def in_body(position):
        return any(start <= position < end for start, end in body_lines)

    roots = []
    for name in sorted(proven):
        root = r"\$(?:" + re.escape(name) + r"\b|\{" + re.escape(name) + r"\})/"
        assignment = re.search(r'(?m)^[ \t]*' + re.escape(name) + r'="?\$\(mktemp ', source)
        if not reset_fixture and assignment and any(match.start() < assignment.start() for match in re.finditer(root + SHELL_FIXTURE_DATABASE, source)):
            continue
        roots.append(root)
    if not roots:
        return source
    root = '(?:' + '|'.join(roots) + ')'
    fixture, body_fixture = root + SHELL_FIXTURE_DATABASE, root + SHELL_HIDDEN_FIXTURE_DATABASE

    def discount_word(match):
        word = match[0]
        binding = re.match(r'[A-Za-z_]\w*=', word)
        prefix = binding[0] if binding else ''
        value = word[len(prefix):]
        # Single quotes preserve a literal dollar sign, not a mktemp root.
        quote = '"' if value.startswith('"') and value.endswith('"') else ''
        if quote:
            value = value[1:-1]
        if not re.fullmatch(body_fixture if in_body(match.start()) else fixture, value):
            return word
        return prefix + quote + 'guard_isolated_fixture' + quote

    # One pass over the original text, so heredoc offsets stay valid. Match
    # complete raw shell words, retaining adjacent quoted pieces; punctuation
    # or whitespace inside quotes cannot terminate a path.
    return SHELL_FIXTURE_WORD.sub(discount_word, source)


def _fixture_shell_live(text, depth=0):
    if depth >= MAX_SHELL_DEPTH:
        return True
    # Bash removes continuations before parsing words. Its ANSI-C and locale
    # quoting are outside shlex's grammar, so neither can prove isolation.
    text = text.replace('\\\n', '')
    if "$'" in text or '$"' in text:
        return True
    for body in _substitutions(text, shell=True):
        if _fixture_shell_live(body, depth + 1):
            return True
    text, quoted = _quoted_punctuation(text)
    for value in quoted.values():
        if value.startswith('${') and value.endswith('}') and _fixture_shell_live(value[2:-1], depth + 1):
            return True
    # Keep literal hashes inside words. shlex's default comments would hide
    # later operands; only comments identified as whole shell words are data.
    text = SHELL_FIXTURE_WORD.sub(lambda match: '' if match[0].startswith('#') else match[0], text)
    text = re.sub(r'\$\(\([^()\n]*\)\)', 'guard_arithmetic', text)
    # An unmasked substitution may have escaped the bounded parser. It cannot
    # establish that discarding the fixture's database names is safe.
    if '$(' in text or '`' in text:
        return True
    lexer = shlex.shlex(text, posix=True, punctuation_chars=';&|(){}\n')
    lexer.whitespace_split = True
    lexer.commenters = ''
    for token in lexer:
        for key, literal in quoted.items():
            token = token.replace(key, literal)
        if LIVE.search(token):
            return True
    return False


def _replica_reader_source(source):
    # A literal is discounted only at a reader, or in an immutable binding whose
    # every use is a reader argument. Unknown transformations retain the name.
    identifier = r'[A-Za-z_$][\w$]*'
    strings = re.compile(r'''//[^\r\n\u2028\u2029]*|/\*[\s\S]*?\*/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"''')
    code = strings.sub(lambda m: ' ' * len(m[0]), source)
    discounted = []
    for command in re.finditer(r'(?m)^\s*sqlite3\s+-readonly\s+([^\s;|&]+)', source):
        if (replica := REPLICA.search(command[1])) and replica.end() == len(command[1]):
            start, end = command.span(1)
            discounted.append((start, end))
            code = code[:start] + ' ' * (end - start) + code[end:]
    # Escaped identifiers, templates and regex literals need lexical parsing to
    # prove that the textual reference list is complete. Keep them conservative.
    if any(token in code for token in ('\\', '`', '/')) or re.search(r'\b(?:eval|Function|Reflect|Proxy)\b', code):
        return source

    def namespace(module, operations):
        names = []
        pattern = r'''\bimport\s+\*\s+as\s+(''' + identifier + r''')\s+from\s*(['"])node:''' + module + r'''\2'''
        for imported in re.finditer(pattern, source):
            if not code.startswith('import', imported.start()):
                continue
            uses = [m for m in re.finditer(r'(?<![\w$])' + re.escape(imported[1]) + r'(?![\w$])', code)
                    if m.span() != imported.span(1)]
            if all(re.match(r'\s*\.\s*(?:' + operations + r')\s*\(', code[m.end():]) for m in uses):
                names.append(re.escape(imported[1]))
        return '(?:' + '|'.join(names) + ')' if names else r'(?!)'

    paths = namespace('path', 'join|resolve')
    os_module = namespace('os', 'homedir')
    util_module = namespace('util', 'parseArgs')
    constructors = [namespace('sqlite', 'DatabaseSync') + r'\.DatabaseSync']
    named_reader = r'''\bimport\s*\{\s*(DatabaseSync)(?:\s+as\s+(''' + identifier + r'''))?\s*\}\s*from\s*(['"])node:sqlite\3'''
    for imported in re.finditer(named_reader, source):
        if not code.startswith('import', imported.start()):
            continue
        group = 2 if imported[2] else 1
        uses = [m for m in re.finditer(r'(?<![\w$])' + re.escape(imported[group]) + r'(?![\w$])', code)
                if m.span() != imported.span(group)]
        if all(re.search(r'\bnew\s*$', code[:m.start()]) and re.match(r'\s*\(', code[m.end():]) for m in uses):
            constructors.append(re.escape(imported[group]))
    reader = re.compile(r'\bnew\s+(?:' + '|'.join(constructors) + r')\s*\(\s*$')
    literal = r'''(?:'[^'\\\n]*\.robob/userdata/readonly/state\.sqlite(?:-(?:wal|shm))?'|"[^"\\\n]*\.robob/userdata/readonly/state\.sqlite(?:-(?:wal|shm))?")'''
    home = r'(?:process\.env\.HOME|' + os_module + r'\.homedir\(\s*\))'
    seed = re.compile(paths + r'\.(?:join|resolve)\(\s*' + home + r'\s*,\s*' + literal + r'\s*\)|' + home + r'\s*\+\s*' + literal + '|' + literal)

    def reader_use(start, end):
        return reader.search(code[:start]) and re.match(r'\s*[,)]', code[end:])

    def binding_reads(name, declaration, text=code):
        uses = list(re.finditer(r'(?<![\w$])' + re.escape(name) + r'(?![\w$])', text))
        reads = [m for m in uses if m.span() != declaration]
        return bool(reads) and all(reader_use(m.start(), m.end()) for m in reads)

    implicit_args = (not re.search(r'\b(?:globalThis|global|require|module|constructor|__proto__)\b|\bimport\s*\(', code) and
                     all(re.match(r'\s*\.\s*fromEntries\s*\(', code[m.end():])
                         for m in re.finditer(r'\bObject\b', code)))
    # Default inference covers the probe's dependencies; other imported code
    # can mutate arguments without exposing those writes in this source.
    default_modules = {'node:sqlite', 'node:os', 'node:path', 'node:util',
                       'node:timers/promises', 'effect/Console', 'effect/Effect'}
    for token in strings.finditer(source):
        if token[0][0] in '\'"' and re.search(r'\b(?:from|import)\s*$', code[:token.start()]):
            module = token[0][1:-1]
            if module not in default_modules:
                implicit_args = False

    for match in seed.finditer(source):
        if not REPLICA.search(match[0]):
            continue
        start, end = match.span()
        # Parentheses around an expression are transparent; call parentheses
        # must remain so a helper's argument cannot look like a direct read.
        while (opening := re.search(r'\(\s*$', source[:start])) and re.match(r'\s*\)', source[end:]):
            before = source[:opening.start()].rstrip()
            if before and re.search(r'[\w$.)\]]$', before):
                break
            start = opening.start()
            end += re.match(r'\s*\)', source[end:]).end()
        safe = reader_use(start, end)
        declaration = re.search(r'\bconst\s+(' + identifier + r')\s*=\s*$', code[:start])
        if declaration and re.match(r'\s*;', code[end:]):
            safe = binding_reads(declaration[1], declaration.span(1))
        option = re.search(r'''\breplica\s*:\s*\{\s*type\s*:\s*(['"])string\1\s*,\s*default\s*:\s*$''', source[:start])
        parser = re.search(r'\bconst\s*\{\s*(values)\s*\}\s*=\s*' + util_module + r'\.parseArgs\(\s*\{\s*options\s*:\s*\{', code)
        if option and parser and parser.start() < option.start() and re.match(r'\s*,?\s*}', code[end:]):
            # The probe's parseArgs option is another immutable binding. Reject
            # option overrides and unknown uses of the returned values object.
            depth, close = 1, code.index('(', parser.start()) + 1
            while close < len(code) and depth:
                depth += (code[close] == '(') - (code[close] == ')')
                close += 1
            options = code[parser.start():close]
            depth, options_end = 1, parser.end()
            while options_end < close and depth:
                depth += (code[options_end] == '{') - (code[options_end] == '}')
                options_end += 1
            raw_options = source[parser.end():options_end]
            # Only the literal options record is covered by this default proof;
            # root overrides and changes to implicit argv must stay unproven.
            default_input = (implicit_args and re.fullmatch(r'\s*,?\s*}\s*\)', code[options_end:close]) and
                             '[' not in options and '\\' not in raw_options and
                             all(parser.end() <= token.start() < options_end
                                 for token in strings.finditer(source)
                                 if token[0][0] in '\'"' and re.match(r'\s*:', code[token.end():])) and
                             len(re.findall(r'\breplica\b', raw_options)) == 1 and
                             all(re.match(r'\s*\.\s*(?:exitCode\b|env\s*\.\s*HOME\b)', code[m.end():])
                                 for m in re.finditer(r'(?<![\w$])process(?![\w$])', code)))
            uses = code
            for access in re.finditer(r'''\bvalues\s*\[\s*(['"])([^'"\n]+)\1\s*\]''', source):
                if access[2] != 'replica' and '\\' not in access[2] and not re.match(r'\s*(?:[+*/%&|?^-]*=(?!=)|\+\+|--)', code[access.end():]):
                    uses = uses[:access.start()] + ' ' * len(access[0]) + uses[access.end():]
            for access in re.finditer(r'\bvalues\.replica\b', code):
                if reader_use(access.start(), access.end()):
                    uses = uses[:access.start()] + ' ' * len(access[0]) + uses[access.end():]
            uses = uses[:parser.start(1)] + ' ' * len(parser[1]) + uses[parser.end(1):]
            # Optional access and destructuring also expose computed keys that
            # string masking cannot prove safe for implicit parser arguments.
            safe = (default_input and not re.search(r'[\w$)\]}]\s*(?:\?\.\s*)?\[|\]\s*:', uses) and
                    end < close and '...' not in options and
                    len(re.findall(r'\breplica\s*:', options)) == 1 and
                    len(re.findall(r'\boptions\s*:', options)) == 1 and
                    not re.search(r'\bvalues\b', uses))
        if safe:
            discounted.append((start, end))
    for start, end in reversed(discounted):
        source = source[:start] + ' ' * (end - start) + source[end:]
    return source


def _strip_config_dir_db_names(source, directory):
    # A tool's own ~/.config/<tool>/state.sqlite deny list is not Robob's live state.
    if 'state.sqlite' not in source or '.config' not in source:
        return source
    # A config basename may still be opened relative to the live working directory.
    if directory is not None and any(LIVE.search(str(Path(directory).resolve() / name))
                                     for name in ('state.sqlite', 'statev2.sqlite', 'opencode.db')):
        return source
    string = r'''(?:"[^"\\\n]*"|'[^'\\\n]*')'''
    database = r'''(?:"state\.sqlite(?:-(?:wal|shm|journal))?"|'state\.sqlite(?:-(?:wal|shm|journal))?')'''
    join = r'(?<![\w$.])(?:path\.join|join|resolve)\s*\(\s*(?:os\.)?homedir\s*\(\s*\)\s*,\s*'
    config = r'''(?:"\.config"|'\.config')\s*,\s*(?P<tool>''' + string + r')\s*,\s*'
    quoted = r'''//[^\n]*|/\*[\s\S]*?\*/|"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|`(?:[^`\\]|\\[\s\S])*`'''
    identifier = r'[A-Za-z_$][\w$]*'

    def fixed_uses(match, array=False):
        # Stored names retain evidence unless every use keeps the fixed config path.
        declaration = re.search(r'\bconst\s+(' + identifier + r')\s*=\s*$', code[:match.start()])
        if not declaration or not re.match(r'\s*;', code[match.end():]):
            return False
        for use in re.finditer(r'(?<![\w$])' + re.escape(declaration[1]) + r'(?![\w$])', source):
            if use.span() == declaration.span(1):
                continue
            if not array:
                return False
            if re.match(r'\s*\.\s*includes\s*\(', code[use.end():]):
                continue
            loop = re.search(r'\bfor\s*\(\s*const\s+(' + identifier + r')\s+of\s*$', code[:use.start()])
            opening = re.match(r'\s*\)\s*\{', code[use.end():])
            if not loop or not opening or not fixed_stat():
                return False
            start = end = use.end() + opening.end()
            depth = 1
            while end < len(code) and depth:
                depth += (code[end] == '{') - (code[end] == '}')
                end += 1
            if depth:
                return False
            for item in re.finditer(r'(?<![\w$])' + re.escape(loop[1]) + r'(?![\w$])', source[start:end - 1]):
                at, after = start + item.start(), start + item.end()
                if (not re.search(r'(?<![\w$.])stat\s*\(\s*$', code[start:at]) or
                        not re.match(r'\s*[,)]', code[after:])):
                    return False
        return True

    def fixed_stat():
        imports = [item for item in re.finditer(r'''\bimport\s*\{[^{}]*\bstat\b[^{}]*\}\s*from\s*(["'])node:fs/promises\1''', source)
                   if code[item.start():].startswith('import')]
        for use in re.finditer(r'\bstat\b', source):
            if any(item.start() <= use.start() < item.end() and
                   re.search(r'(?:\{|,)\s*stat\s*(?:,|\})', item[0]) for item in imports):
                continue
            if code[:use.start()].rstrip().endswith('.') and re.match(r'\s*\(', code[use.end():]):
                continue
            if (not imports or not re.match(r'\s*\(', code[use.end():]) or
                    re.search(r'\bfunction\s*\*?\s*$', code[:use.start()])):
                return False
        return bool(imports)

    def safe_tool(value):
        return (bool(re.fullmatch(r'[A-Za-z0-9_.-]+', value)) and value not in {'.', '..'} and
                value.lower() not in {'robob', 't3', 't3code', 'opencode', 'robob-data', 'opencode-data'})

    def operand(match):
        if match['names'] is None:
            return literal(match)
        if (not safe_tool(match['tool'][1:-1]) or LIVE.search(match[0]) or
                not fixed_uses(match, array=match[0].startswith('['))):
            return match[0]
        start, end = match.span('names')
        names = re.sub(string, lambda item: "''" if re.fullmatch(database, item[0]) else item[0], match['names'])
        return (match[0][:start - match.start()] + names +
                match[0][end - match.start():])

    array = (r'\[(?P<names>\s*' + string + r'(?:\s*,\s*' + string + r')*\s*,?\s*)\]\s*'
             r'\.map\(\s*(?P<param>[A-Za-z_$][\w$]*)\s*=>\s*' + join + config +
             r'(?P=param)\s*\)\s*\)')
    def literal(match):
        if match[0][0] not in "\"'":
            return match[0]
        value = match[0][1:-1]
        path = re.fullmatch(r'(?:~/|/(?:[^/]+/)*)\.config/([^/]+)/state\.sqlite(?:-(?:wal|shm|journal))?', value)
        if (path and safe_tool(path[1]) and '..' not in value.split('/') and
                not any(char in value for char in ('\\', '$', '*', '?', '[')) and not LIVE.search(value) and
                fixed_uses(match)):
            return "''"
        return match[0]

    # Prototype access can replace membership checks or iteration with a reader.
    if re.search(r'\b(?:prototype|__proto__|getPrototypeOf|setPrototypeOf)\b', source):
        return source
    code = re.sub(quoted, lambda match: ' ' * len(match[0]), source)
    source = re.sub(array + '|' + quoted, operand, source)
    code = re.sub(quoted, lambda match: ' ' * len(match[0]), source)
    return re.sub(join + config + r'(?P<names>' + database + r')\s*\)|' + quoted, operand, source)


def _js_fixture_source(source):
    # Only immutable strings in unshadowed const spans supply root evidence.
    # Ambiguous syntax retains the original scan for the affected span.
    if re.search(r'\b(?:homedir|cwd)\b|\bHOME\b(?!\s*:)|\bprocess\s*(?:\[|\.\s*(?:env\s*\[|(?:chdir|cwd)\b))|[\'"`]~/(?:\.robob|\.t3|\.local/share/opencode)\b', source):
        return source
    if re.search(r'''['"`]/[^'"`\n]*/(?:\.robob|\.t3|\.local/share/opencode|robob-data|opencode-data)(?:/|['"`])''', source):
        return source
    live_parents = {str(parent) for path in protected_databases() for parent in path.parents if str(parent) != '/'}
    for match in re.finditer(r'''['"`](/[^'"`\n]*)['"`]''', source):
        value = os.path.normpath(match[1])
        if value in live_parents or re.fullmatch(r'/(?:Users|home)/[^/]+|/root', value):
            return source
    token = re.compile(r'''//[^\n]*|/\*[\s\S]*?\*/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*|===|!==|==|!=|=>|(?:>>>|<<|>>|\*\*|&&|\|\||\?\?|[+*/%&|^-])=|\+\+|--|[^\s]''')
    regexp = re.compile(r'''/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n\[])+/[dgimsuvy]*''')
    quoted = re.compile(r"//[^\n]*|/\*[\s\S]*?\*/|\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'")

    def template_end(start, nesting=0):
        if nesting > 24:
            return None, True
        position, uncertain = start + 1, False
        while position < len(source):
            if source[position] == '\\':
                position += 2
            elif source[position] == '`':
                return position + 1, uncertain
            elif source.startswith('${', position):
                position += 2
                begin, groups = position, ['}']
                while groups and position < len(source):
                    string = quoted.match(source, position)
                    if string:
                        position = string.end()
                        continue
                    char = source[position]
                    if char == '`':
                        position, _ = template_end(position, nesting + 1)
                        uncertain = True
                        if position is None:
                            return None, True
                        continue
                    if char == '/':
                        return None, True
                    if char in {'"', "'", '\\'}:
                        return None, True
                    if char in '{[(':
                        groups.append({'{': '}', '[': ']', '(': ')'}[char])
                        uncertain |= char == '{'
                    elif char in '}])':
                        if char != groups.pop():
                            return None, True
                    position += 1
                if groups:
                    return None, True
                uncertain |= bool(re.search(r'\bfunction\b|=>|(?<![=!<>])=(?!=|>)|\+\+|--', source[begin:position - 1]))
            else:
                position += 1
        return None, True
    regex_prefixes = {'(', '[', '=', ',', ':', ';', '?', '~', '+', '-', '*', '/', '%', '&', '|', '^',
                      '==', '!=', '===', '!==', '=>', 'return', 'throw', 'case', 'typeof', 'void', 'delete', 'in', 'instanceof'}
    matches, position, uncertain_tokens = [], 0, set()
    while (match := token.search(source, position)) is not None:
        if match[0].startswith('`'):
            end, uncertain = template_end(match.start())
            if end is None:
                return source
            if uncertain:
                uncertain_tokens.add(len(matches))
            match = re.compile(r'[\s\S]+').match(source, match.start(), end)
        elif match[0] in {'"', "'"}:
            return source
        if match[0] == '/':
            previous = re.sub(r'\s+', '', matches[-1][0]) if matches else ''
            # Optional access can split a keyword property off its receiver.
            member = len(matches) > 1 and matches[-2][0] == '.'
            # A division sign must not swallow the following assignments as a
            # regex. Block/control endings need a parser, so retain the scan.
            if not member and (not previous or previous in regex_prefixes or re.fullmatch(r'(?:>>>|<<|>>|\*\*|&&|\|\||\?\?|[+*/%&|^-])?=', previous)):
                match = regexp.match(source, match.start())
                if match is None:
                    return source
            elif not member and (previous in {')', '}', '!', '<', '>', 'of', 'yield', 'await'} or not (re.fullmatch(r'[\w$]+(?:\.[\w$]+)*', previous) or
                    previous[:1] in {'"', "'", '`', '/'} or previous in {']', '++', '--'})):
                return source
        position = match.end()
        if not match[0].startswith(('//', '/*')):
            matches.append(match)
    words = [re.sub(r'\s+', '', m[0]) if m[0][0] not in "\"'`" else m[0] for m in matches]
    scopes, parents, scope_ends, stack = [], {0: None}, {}, [0]
    for i, word in enumerate(words):
        scopes.append(stack[-1])
        if word == '{':
            parents[i + 1] = stack[-1]
            stack.append(i + 1)
        elif word == '}':
            if len(stack) == 1:
                return source
            scope_ends[stack.pop()] = i
    if len(stack) != 1:
        return source
    scope_ends[0] = len(words)
    definitions, writes = {}, []
    for i in range(len(words) - 2):
        if words[i] in {'const', 'let'} and re.fullmatch(r'[A-Za-z_$][\w$]*', words[i + 1]) and words[i + 2] == '=':
            definitions.setdefault((scopes[i], words[i + 1]), []).append((i + 3, i + 1))
        if re.fullmatch(r'[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*', words[i]) and (
                re.fullmatch(r'(?:>>>|<<|>>|\*\*|&&|\|\||\?\?|[+*/%&|^-])?=', words[i + 1]) or
                words[i + 1] in {'++', '--', 'of', 'in'} or words[i - 1:i] in (['++'], ['--'], ['delete'])):
            writes.append(i)

    def binding(name, i):
        scope = scopes[i]
        while scope is not None:
            key = (scope, name)
            if key in definitions:
                return key
            scope = parents[scope]
        return None

    invalid = set()
    for i in writes:
        key = binding(words[i], i)
        if key and (len(definitions[key]) != 1 or definitions[key][0][1] != i):
            invalid.add(key)
    # A complex assignment target proves nothing about any name it contains.
    # Include its receiver for indexed writes; unrelated fixture names survive.
    brackets, openings = [], {}
    for i, word in enumerate(words):
        if word in {'[', '{', '('}:
            brackets.append(i)
        elif word in {']', '}', ')'} and brackets:
            if words[brackets[-1]] != {']': '[', '}': '{', ')': '('}[word]:
                return source
            openings[i] = brackets.pop()
        elif word in {']', '}', ')'}:
            return source
        if word in {']', '}', ')', '!'} and words[i + 1:i + 2] and (
                words[i + 1] in {'of', 'in'} or re.fullmatch(r'(?:>>>|<<|>>|\*\*|&&|\|\||\?\?|[+*/%&|^-])?=', words[i + 1])):
            start = openings.get(i, i)
            for n in range(max(0, start - 1), i):
                invalid.add(binding(words[n], n))
                invalid.add(binding(words[n].split('.')[0], n))
    if brackets:
        return source
    declarations = []
    for i, word in enumerate(words[:-2]):
        if word in {'const', 'let', 'var', 'function', 'class'} and re.fullmatch(r'[A-Za-z_$][\w$]*', words[i + 1]):
            declarations.append((words[i + 1], i + 1))
        if word == 'function' and words[i + 1] == '*' and re.fullmatch(r'[A-Za-z_$][\w$]*', words[i + 2]):
            declarations.append((words[i + 2], i + 2))
        if word in {'const', 'let', 'var'} and re.fullmatch(r'[A-Za-z_$][\w$]*', words[i + 1]) and words[i + 2] != '=':
            definitions[(scopes[i], words[i + 1])] = []
        if word in {'const', 'let', 'var'} and words[i + 1] in {'{', '['}:
            end = next((n for n in range(i + 2, len(words)) if words[n] == '='), i + 2)
            names = set(words[i + 2:end])
            for name in names:
                if re.fullmatch(r'[A-Za-z_$][\w$]*', name):
                    definitions[(scopes[i], name)] = []
                    declarations.append((name, i + 1))
        if word == 'import' and words[i + 1] != '(':
            end = next((n for n in range(i + 1, len(words)) if words[n] == 'from' or words[n][:1] in {'"', "'"}), len(words))
            declarations.extend((words[n], n) for n in range(i + 1, end) if re.fullmatch(r'[A-Za-z_$][\w$]*', words[n]))
    # Parameter bindings shadow outer fixture names even without an assignment.
    # Unknown/destructured parameter syntax can only remove a proof.
    parameters, nesting = [], []
    for i, word in enumerate(words):
        if word == '(':
            nesting.append(i)
        elif word == ')' and nesting:
            start = nesting.pop()
            after = i + 1
            prefix = start - 1
            if prefix >= 0 and words[prefix] == '>':
                depth = 1
                prefix -= 1
                while prefix >= 0 and depth:
                    depth += (words[prefix] == '>') - (words[prefix] == '<')
                    prefix -= 1
            before = words[max(0, prefix - 2):prefix + 1]
            function = 'function' in before
            # Return types do not affect parameter bindings. Unknown type
            # syntax must not let a header borrow an enclosing const proof.
            if words[after:after + 1] == [':']:
                parameters.append((start + 1, i, after))
                continue
            arrow = words[after:after + 1] == ['=>']
            if arrow:
                after += 1
            # Method names can be keywords, literals or computed properties.
            # Ambiguous control headers may only remove an outer root proof.
            method = words[after:after + 1] == ['{']
            if arrow or function or method:
                parameters.append((start + 1, i, after))
        elif word == '=>' and i and re.fullmatch(r'[\w$]+', words[i - 1]):
            parameters.append((i - 1, i, i + 1))
    parameter_names = set()
    for start, end, body in parameters:
        names = {word for word in words[start:end] if re.fullmatch(r'[A-Za-z_$][\w$]*', word)}
        parameter_names.update(names)
        declarations.extend((name, start) for name in names)
        if words[body:body + 1] == ['{']:
            for name in names:
                definitions[(body + 1, name)] = []
        else:
            # Concise arrows and typed returns need no expression-extent
            # inference: remove the enclosing binding's proof conservatively.
            invalid.update(binding(name, body) for name in names)
    # Const strings cannot be redirected by missed writes. A different binding
    # anywhere in the declaration's remaining block still voids that proof.
    for key, values in definitions.items():
        if len(values) != 1:
            continue
        _, declaration = values[0]
        if (words[declaration - 1] != 'const' or
                any(name == key[1] and declaration < i < scope_ends[key[0]] for name, i in declarations) or
                any(declaration < i < scope_ends[key[0]] and
                    (key[1] in words[i] or DATABASE_NAME.search(words[i])) for i in uncertain_tokens)):
            invalid.add(key)

    def suffix(value):
        return bool(value) and not value.startswith(('/', '~')) and not re.search(r'[\\$`]', value) and '..' not in value.split('/')

    def expression(i, seen=frozenset(), awaited=False):
        if i >= len(words) or len(seen) > 24:
            return None, i
        if words[i] == 'await':
            return expression(i + 1, seen, awaited=True)
        word = words[i]
        if word[:1] in {'"', "'"}:
            value = word[1:-1]
            return ('part', value) if suffix(value) else None, i + 1
        if word.startswith('`'):
            if i in uncertain_tokens:
                return None, i + 1
            template = re.fullmatch(r'`\$\{([\w$.]+)\}/([^`]+)`', word)
            if template and suffix(template[2]):
                root = reference(template[1], i, seen)
                if root and root[0] == 'temp':
                    return ('temp', ''), i + 1
            return None, i + 1
        if words[i + 1:i + 2] != ['(']:
            return reference(word, i, seen), i + 1
        args, end = [], i + 2
        while end < len(words) and words[end] != ')':
            value, end = expression(end, seen)
            args.append(value)
            if words[end:end + 1] != [',']:
                break
            end += 1
        if words[end:end + 1] != [')']:
            return None, end
        end += 1
        if word in {'mkdtemp', 'fsp.mkdtemp', 'realpath', 'fsp.realpath'} and not awaited:
            return None, end
        if word in {'tmpdir', 'os.tmpdir'} and not args:
            return ('prefix', ''), end
        if word in {'join', 'path.join', 'resolve', 'path.resolve'} and args and args[0] and args[0][0] in {'temp', 'prefix'} and all(arg and arg[0] == 'part' for arg in args[1:]):
            return args[0], end
        if word in {'mkdtempSync', 'fs.mkdtempSync', 'mkdtemp', 'fsp.mkdtemp'} and len(args) == 1 and args[0] and args[0][0] == 'prefix':
            return ('temp', ''), end
        if word in {'realpathSync', 'fs.realpathSync', 'realpath', 'fsp.realpath'} and len(args) == 1 and args[0] and args[0][0] == 'temp':
            return args[0], end
        return None, end

    def reference(name, i, seen):
        key = binding(name, i)
        if '.' in name or key is None or key in invalid or key in seen or len(definitions[key]) != 1:
            return None
        start, declaration = definitions[key][0]
        if declaration >= i:
            return None
        value, end = expression(start, seen | {key})
        return value if words[end:end + 1] and words[end] in {';', ',', ')', '}'} else None

    # Builtin names must not be rebound or shadowed by local implementations.
    calls = {'tmpdir', 'os.tmpdir', 'join', 'path.join', 'resolve', 'path.resolve', 'mkdtempSync', 'fs.mkdtempSync', 'mkdtemp', 'fsp.mkdtemp', 'realpathSync', 'fs.realpathSync', 'realpath', 'fsp.realpath'}
    apis = {word.split('.')[0] for i, word in enumerate(words) if word in calls and words[i + 1:i + 2] == ['(']}
    imported = set()
    for match in re.finditer(r'''\bimport\s+([^;'"\n]+)\s+from\s+['"](?:node:)?(fs(?:/promises)?|os|path)['"]''', source):
        spec, module = match.groups()
        names = {'os': {'tmpdir'}, 'path': {'join', 'resolve'}, 'fs': {'mkdtempSync', 'realpathSync'}, 'fs/promises': {'mkdtemp', 'realpath'}}[module]
        if spec.strip().startswith('{'):
            imported.update(name.strip() for name in spec.strip()[1:-1].split(',') if name.strip() in names)
        elif re.fullmatch(r'(?:\*\s+as\s+)?' + {'os': 'os', 'path': 'path', 'fs': 'fs', 'fs/promises': 'fsp'}[module], spec.strip()):
            imported.add(spec.strip().split()[-1])
    if not apis <= imported or apis & parameter_names:
        return source
    if any(name.split('.')[0] in apis for _, name in definitions) or any(words[i].split('.')[0] in apis for i in writes):
        return source
    if apis and re.search(r'\bfunction\s+(?:' + '|'.join(apis) + r')\b', source):
        return source
    spans = []
    for i, word in enumerate(words):
        if word in {'join', 'path.join', 'resolve', 'path.resolve'} or word.startswith('`'):
            value, end = expression(i)
            if value and value[0] == 'temp' and end > i and DATABASE_NAME.search(source[matches[i].start():matches[end - 1].end()]):
                spans.append((matches[i].start(), matches[end - 1].end()))
    for start, end in sorted(spans, reverse=True):
        # Other operands may reuse a protected root, even when this path is
        # temporary. Discharge its DB name without erasing that root evidence.
        source = source[:start] + DATABASE_NAME.sub(lambda match: ' ' * len(match[0]), source[start:end]) + source[end:]
    return source


def _source_hit(source, directory, python=False, shell=False):
    # Inspect the original body, including literals/comments, never its path or argv.
    discount_foreign = not PROTECTED_SOURCE_TOKEN.search(source)
    foreign_source = _strip_config_dir_db_names(source, directory) if not python else source
    if discount_foreign and 'state.sqlite' in foreign_source and _foreign_reader_shadowed(source):
        return True
    # Keep the root evidence so the replica cannot hide a second database name.
    replica = REPLICA.search(source)
    if python:
        return _python_touches_live(source, directory, replica=bool(replica))
    if replica and not shell:
        source = _replica_reader_source(source)
    if shell:
        original = source
        source = _shell_fixture_source(source, directory)
        # Discounting a fixture must not hide a separate live path assembled
        # from adjacent quoted pieces of a shell word.
        if source != original:
            try:
                text, _ = _heredocs(source)
                if _fixture_shell_live(text):
                    return True
            except (ValueError, AmbiguousScript):
                return True
    if source_touches_live(source) or _relative_source_live(source, directory):
        return True
    def isolated_literal(match):
        value = match[2]
        # A direct absolute argument stays fixed even if the program changes cwd.
        # Receivers, assignments and helper-call operands may be transformed.
        if (re.search(r"(?:statev2\.sqlite|opencode\.db)(?:-(?:wal|shm|journal))?$", value) and
                Path(value).is_absolute() and
                re.search(r"\b(?:readFile(?:Sync)?|open(?:Sync)?|createReadStream)\s*\(\s*$", source[:match.start()]) and
                re.match(r"\s*[,)]", source[match.end():]) and
                _literal_path(value, directory) is not None and
                not _direct_read(["cat", value], directory)):
            return "''"
        return match[0]
    source = re.sub(r"(['\"])([^'\"\\\n]+)\1", isolated_literal, source)
    # A bundle id such as com.ardud.robob is not a path segment. Keep split
    # live roots conservative, including cwd changes separate from the name.
    live_root = replica or re.search(r"(?<!\w)\.robob\b|robob-data|\.local/share|opencode-data|[\"']opencode[\"']", source)
    home_userdata = (not shell and re.search(r"\buserdata\b", source) and
                     re.search(r"\b(?:homedir|HOME|T3CODE_HOME)\b|\bPath\.home\b|['\"`]~(?:/|['\"`])", source))
    # A foreign operand may still supply a root for another database operand.
    if discount_foreign:
        source = _foreign_state_source(source, directory)
        if re.search(r'''\bsqlite3?\s+(?:-[\w-]+\s+)*['"]?[^'"\s;]*state\.sqlite''', source):
            return True
    # Shell fixture proofs above discharge statev2/opencode paths, not other
    # database names that their setup may also list as data.
    database = re.search(r"statev2\.sqlite|opencode\.db", source) if shell else DATABASE_NAME.search(source)
    return bool(database and (live_root or home_userdata))


def _isolated_migration_history_helpers(location):
    # These are the only imported helpers that select history files. Read the
    # checkout being inspected, never a helper from the guard's own checkout.
    root = Path(os.path.realpath(location)).parent.parent / 'src/ardud/persistence'

    def reject(name):
        raise LiveRead('live-database-script', f"{root / name}: guard's module pin needs re-auditing; isolated migration refused.")

    bodies = []
    for name in ('historySourceFiles.ts', 'historyArchiveSql.ts'):
        try:
            with (root / name).open('rb') as handle:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_SOURCE_BYTES:
                    reject(name)
                body = handle.read(MAX_SOURCE_BYTES + 1)
            if len(body) > MAX_SOURCE_BYTES:
                reject(name)
            bodies.append(body.decode('utf-8'))
        except (OSError, UnicodeError):
            reject(name)
    history, archive = bodies
    # A whole-helper shape proves the basename check and the source-directory
    # join together; accepting the return expression alone could hide a write.
    expected = r'''// integrations/harness-hooks/src/statev2_guard.py::_isolated_migration_source proves this shape; run its tests after changes.

import type * as Path from "effect/Path";

/** Also serialized into the readonly export worker; keep runtime dependencies explicit. */
export function resolveHistoryBasePath(
  path: Pick<Path.Path, "dirname" | "basename" | "join">,
  sourcePath: string,
  rows: ReadonlyArray<{ readonly filename: unknown }>,
) {
  if (rows.length === 0) return undefined;
  const filename = rows[0]!.filename;
  if (
    rows.length !== 1 ||
    typeof filename !== "string" ||
    !/^statev2\.pre-shrink-[^/\\]+\.sqlite$/.test(filename) ||
    path.basename(filename) !== filename
  )
    throw new Error("Invalid readonly history base filename");
  return path.join(path.dirname(sourcePath), filename);
}'''
    if history.strip() != expected:
        reject('historySourceFiles.ts')
    # Node executes the entire imported module. Pin the audited SQL-only body,
    # including imports and initializers: a safe archiveFilename alone cannot
    # discharge extra runtime I/O. Re-audit the whole module before changing it.
    if hashlib.sha256(archive.encode('utf-8')).hexdigest() != 'cc4ac6791b0764fc1c33f89fb8682bfbb795f14a5b007efbe53e5454a566400e':
        reject('historyArchiveSql.ts')
    archive_name = r'export const archiveFilename = \(filename: string\) =>\s*NodePath\.join\(NodePath\.dirname\(filename\), "archive\.sqlite"\);'
    return len(re.findall(archive_name, archive)) == 1


def _isolated_migration_source(source, directory, location):
    # Discharge the one default-source expression only after the caller has
    # supplied isolated --source and --base-dir arguments. All other source
    # text still goes through the live-path check.
    # A literal home root can assemble a second live path after the default
    # is discharged, even when its segments escape the ordinary source scan.
    if re.search(r'''['"`]/(?:Users|home|root|var/root|private)(?=/|['"`])''', source):
        return False
    default = re.compile(r'const sourcePath = path\.resolve\(\s*input\.source \?\? path\.join\(sharedHome, "userdata", "statev2\.sqlite"\),\s*\);')
    if len(default.findall(source)) != 1 or source.count('NodeOS.homedir()') != 1:
        return False
    call = re.compile(r'runMigrateDevDb\(\{\s*projects,\s*threadsPerProject,\s*baseDir: Option\.getOrUndefined\(baseDir\),\s*source: Option\.getOrUndefined\(source\),\s*\}\)')
    if len(call.findall(source)) != 1 or len(re.findall(r'runMigrateDevDb\s*\(', source)) != 1:
        return False
    callback = re.compile(r'\(\{ projects, threadsPerProject, baseDir, source \}\) =>\s*Effect\.gen\(function\* \(\) \{\s*const result = yield\* ' + call.pattern)
    option = re.compile(r'source: Flag\.String\("source"\)\.pipe\(\s*Flag\.optional,\s*Flag\.withDescription\("[^"\\\n]*"\),\s*\),')
    if len(callback.findall(source)) != 1 or len(option.findall(source)) != 1:
        return False
    # A matching property is not enough when a later duplicate or spread can
    # replace it. Recognize the complete literal options object and its four
    # fields; dynamic composition cannot prove which source flag is effective.
    description = r'Flag\.withDescription\(\s*"[^"\\\n]*",?\s*\),'
    integer = lambda field, flag: re.escape(field) + r':\s*Flag\.Int\("' + re.escape(flag) + r'"\)\.pipe\(\s*Flag\.withDefault\([0-9]+\),\s*' + description + r'\s*\),'
    string = lambda field, flag: re.escape(field) + r':\s*Flag\.String\("' + re.escape(flag) + r'"\)\.pipe\(\s*Flag\.optional,\s*' + description + r'\s*\),'
    options = r'Command\.make\(\s*"migrate-dev-db",\s*\{\s*' + integer('projects', 'projects') + r'\s*' + integer('threadsPerProject', 'threads-per-project') + r'\s*' + string('baseDir', 'base-dir') + r'\s*' + string('source', 'source') + r'\s*\},\s*' + callback.pattern
    if len(re.findall(options, source)) != 1:
        return False
    # The source argument must reach the read-only ATTACHes, and every SQLite client
    # must open a destination. An isolated CLI flag proves neither by itself.
    if len(re.findall(r'\bcopySourceSlice\b', source)) != 2 or len(re.findall(r'copySourceSlice\(sourcePath\)', source)) != 1:
        return False
    attaches = [f'ATTACH DATABASE ${{`${{NodeURL.pathToFileURL({operand}).href}}?mode=ro`}} AS {schema}'
                for operand, schema in (('sourcePath', 'src'), ('archivePath', 'cold'), ('basePath', 'base'))]
    if any(source.count(attach + '`;') != 1 for attach in attaches) or len(re.findall(r'\bATTACH\b', source)) != 3:
        return False
    copy_start = 'const copySourceSlice = Effect.fn("copyDevDbSourceSlice")(function* (sourcePath: string) {'
    if source.count(copy_start) != 1:
        return False
    copy_body = source.split(copy_start, 1)[1].split('\nconst pruneSnapshot =', 1)[0]
    if any(attach not in copy_body for attach in attaches):
        return False
    if not _isolated_migration_history_helpers(location):
        return False
    # Remove complete, proven derivations before checking every remaining use.
    # An extra alias, mutation, reader or writer of either history path fails.
    history_uses = source
    history_forms = (
        r'import \{ resolveHistoryBasePath \} from "\.\./src/ardud/persistence/historySourceFiles\.ts";',
        r'import \{\s*archiveFilename,\s*HISTORY_TABLES,\s*liveColumns,\s*\} from "\.\./src/ardud/persistence/historyArchiveSql\.ts";',
        r'const archivePath = archiveFilename\(sourcePath\);',
        r'const archivePath = `\$\{archiveFilename\(databasePath\)\}\$\{suffix\}`;',
        r'const baseRows = hasTable\("ardud_history_base_archive"\)\s*\? yield\* sql<\{\s*filename: string;\s*\}>`SELECT filename FROM src\.ardud_history_base_archive LIMIT 2`\s*: \[\];',
        r'const basePath = yield\* Effect\.try\(\{\s*try: \(\) => resolveHistoryBasePath\(path, sourcePath, baseRows\),\s*catch: \(\) =>\s*new MigrateDevDbHistoryArchiveError\(\{\s*sourcePath,\s*archivePath: sourcePath,\s*reason: "invalid-base",\s*\}\),\s*\}\);',
    )
    for form in history_forms:
        if len(re.findall(form, history_uses)) != 1:
            return False
        history_uses = re.sub(form, '', history_uses)
    for attach in attaches:
        history_uses = history_uses.replace(attach, '')
    history_uses = re.sub(r'new MigrateDevDbHistoryArchiveError\(\{\s*sourcePath,\s*archivePath(?:: basePath)?,\s*reason: "(?:missing|identity-mismatch)",\s*\}\)|new MigrateDevDbDestinationArchiveError\(\{ databasePath, archivePath \}\)', 'guard_history_error', history_uses)
    history_uses = re.sub(r'\barchivePath: Schema\.String|\bthis\.archivePath\b|\bfs\.exists\((?:archivePath|basePath)\)|\bbasePath !== undefined', 'guard_history_use', history_uses)
    if re.search(r'\b(?:archiveFilename|resolveHistoryBasePath|archivePath|basePath)\b', history_uses):
        return False
    if len(re.findall(r'\bbaseRows\b', history_uses)) != 0:
        return False
    for binding in (
        'const stateDir = path.join(baseDir, "userdata");',
        'const databasePath = path.join(stateDir, "statev2.sqlite");',
        'const snapshotPath = `${databasePath}.migrate-dev-db-tmp`;',
    ):
        if source.count(binding) != 1:
            return False
    detach = re.compile(r'const attached = yield\* sql<\{ name: string \}>`PRAGMA database_list`;\s*for \(const name of \["base", "cold", "src"\]\) \{\s*if \(attached\.some\(\(entry\) => entry\.name === name\)\) yield\* sql`DETACH DATABASE \$\{sql\(name\)\}`;\s*\}')
    if len(detach.findall(source)) != 1 or len(re.findall(r'\bDETACH\b', source)) != 1:
        return False
    database_uses = re.sub(r'import \* as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";', '', source)
    database_uses = re.sub(r'NodeSqliteClient\.layer\(\{ filename: (?:databasePath|snapshotPath) \}\)', 'guard_destination_client', database_uses)
    if re.search(r'\bNodeSqliteClient\b', database_uses):
        return False
    homes = default.sub('', source)
    homes = re.sub(r'const sharedHome = path\.resolve\(options\.sharedHome \?\? path\.join\(NodeOS\.homedir\(\), "\.t3"\)\);|readonly sharedHome\?: string \| undefined;|fs\.realPath\(sharedHome\)|\(\) => sharedHome', '', homes)
    if re.search(r'\bsharedHome\b', homes):
        return False
    home_api = homes.replace('import * as NodeOS from "node:os";', '')
    url_api = source.replace('import * as NodeURL from "node:url";', '')
    for attach in attaches:
        url_api = url_api.replace(attach, '')
    if re.search(r'\bNodeOS\b', home_api) or re.search(r'\bNodeURL\b', url_api):
        return False
    path_api = re.sub(r'const path = yield\* Path\.Path;', '', source)
    path_api = path_api.replace('resolveHistoryBasePath(path, sourcePath, baseRows)', 'guard_history_base')
    path_api = re.sub(r'\bpath\.(?:join|resolve|dirname)\s*(?=\()', 'guard_path_operation', path_api)
    path_api = path_api.replace('path to a real statev2.sqlite', 'guard_source_help').replace('path this command rewrites', 'guard_destination_help')
    if re.search(r'\bpath\b', path_api):
        return False
    source_uses = default.sub('', source)
    source_uses = source_uses.replace('resolveHistoryBasePath(path, sourcePath, baseRows)', 'guard_history_base')
    source_uses = source_uses.replace('archiveFilename(sourcePath)', 'guard_history_archive')
    source_uses = source_uses.replace('archivePath: sourcePath', 'guard_history_error')
    source_uses = re.sub(r'(new MigrateDevDbHistoryArchiveError\(\{\s*)sourcePath,', r'\1guard_source_error,', source_uses)
    source_uses = re.sub(r'\bsourcePath: (?:Schema\.String|string)|\bthis\.sourcePath\b|\{ sourcePath \}(?=\))|\$\{sourcePath\}|\bdatabasePath: sourcePath\b', 'guard_source_use', source_uses)
    source_uses = re.sub(r'\b(?:copySourceSlice|NodeURL\.pathToFileURL|fs\.exists|fs\.stat)\(sourcePath\)|\.realPath\(sourcePath\)|\(\) => sourcePath\b', 'guard_source_read', source_uses)
    if re.search(r'\bsourcePath\b', source_uses):
        return False
    remainder = default.sub('', source)
    # Every use of the input object must be a known read or the snapshot call.
    # Unknown uses include aliases, indexed writes and reflective mutation.
    uses = re.sub(r'\binput:\s*RunMigrateDevDbInput\b|\bpruneSnapshot\(input\)', 'guard_input', remainder)
    uses = re.sub(r'\binput\.(?:projects|threadsPerProject|baseDir)\b(?!\s*(?:[+*/%&|?^-]*=(?!=)|\+\+|--))', 'guard_input_read', uses)
    if re.search(r'\binput\b|\b(?:Reflect|eval|Function|arguments|Proxy)\b', uses):
        return False
    option_uses = re.sub(r'import \* as Option from "effect/Option";', '', source)
    option_uses = re.sub(r'\bOption\.(?:getOrUndefined|isSome)\s*(?=\()', 'guard_option', option_uses)
    if re.search(r'\bOption\b', option_uses):
        return False
    flag_uses = source.replace('import { Command, Flag } from "effect/cli";', '')
    flag_uses = re.sub(r'\bFlag\.(?:Int|String|withDefault|withDescription)\s*(?=\()|\bFlag\.optional\s*(?=,)', 'guard_flag', flag_uses)
    if re.search(r'\bFlag\b', flag_uses):
        return False
    if re.search(r'(?:sourcePath|\bsource)\s*[+*/%&|?^-]*=(?!=)', remainder):
        return False
    source = default.sub('const sourcePath = "guard_isolated_fixture";', source)
    # The home initializer feeds only the discharged default and the verified
    # realpath comparison above; it cannot supply the explicit source operand.
    source = re.sub(r'const sharedHome = path\.resolve\(options\.sharedHome \?\? path\.join\(NodeOS\.homedir\(\), "\.t3"\)\);', '', source)
    # CLI help is data. Only a literal string argument is discounted, never
    # a computed expression or a filesystem operation appended to that line.
    source = re.sub(r'Flag\.withDescription\("[^"\\\n]*"\)', '', source)
    return not _source_hit(source, directory)


class AmbiguousScript(Exception):
    """An explicit script invocation has no statically established location."""


class UnterminatedHeredoc(AmbiguousScript):
    pass


class LiveRead(Exception):
    def __init__(self, rule, detail=None):
        self.rule = rule
        self.detail = detail


def _token(value):
    return repr(value)


def _database_reference(source):
    # Report the operand, never the surrounding source or JSON payload.
    source = REPLICA.sub(lambda match: " " * len(match[0]), source)
    protected = LIVE.search(source)
    if protected:
        for match in re.finditer(r"(?:~|\$\{?HOME\}?|/)[^\s'\"\\<>]*?(?:statev2\.sqlite|opencode\.db)(?:-(?:wal|shm|journal))?", source):
            if match.start() <= protected.start() < match.end():
                return match
        return protected
    return DATABASE_NAME.search(source)


def refusal_reason(rule, cause, cwd):
    if rule == "live-database-script-unresolved":
        if cause and '\nAccepted: ' in cause:
            detail, hint = cause.split('\nAccepted: ', 1)
            writer = re.fullmatch(r'no readable same-call heredoc writer for this script; invalidated by '
                                  r'(python3?) command at line (\d+); intervening command; '
                                  r'python: write target not literal: (.+) \([a-z0-9]+\)', detail)
            if writer:
                detail = (f'{writer[3]}: a {writer[1]} command may have written it (line {writer[2]}), '
                          'and the guard can only inspect scripts written by a same-call heredoc')
            return ("statev2 guard: this command was NOT run.\n"
                    f"Could not check {detail}. Resolved workdir: {cwd}.\nAccepted: {hint}")
        fix = "Use a literal absolute script path."
        if cause and "unbalanced quote" in cause:
            fix = "Close the shell quote before running the command."
        elif cause and ('script source changed after its heredoc write' in cause or 'unchecked copy at script path' in cause):
            fix = "An intervening command may replace the checked source. Split source preparation and execution into separate calls."
        elif cause and ("MAX_SCRIPTS" in cause or "MAX_SHELL_DEPTH" in cause or "node --test lists" in cause):
            fix = "Split the steps into separate shell calls."
        elif cause and "node --test glob" in cause:
            fix = "List the files literally, or run npm test / npm --prefix <pkg> test / vp test run."
        return ("statev2 guard: this command was NOT run.\n"
                f"Could not check {cause or 'the script path'}. Resolved workdir: {cwd}.\n{fix}")
    if cause:
        return "statev2 guard: this command was NOT run.\n" + cause
    return REASON


def _substitutions(text, shell=False, spans=False):
    result, index, outer_quote, parameters = [], 0, None, 0
    while index < len(text):
        if shell and not parameters and outer_quote is None and text[index] == "#" and (index == 0 or text[index - 1].isspace() or text[index - 1] in ";&|(){}"):
            end = text.find("\n", index)
            index = len(text) if end == -1 else end
            continue
        if text[index] == "\\" and (not shell or outer_quote != "'"):
            index += 2
            continue
        if shell and text[index] in "\"'" and outer_quote in {None, text[index]}:
            outer_quote = text[index] if outer_quote is None else None
            index += 1
            continue
        if shell and outer_quote == "'":
            index += 1
            continue
        if shell and text.startswith("${", index):
            parameters += 1
            index += 2
            continue
        if shell and text[index] == "}" and parameters:
            parameters -= 1
        if text[index] == "`":
            end = index + 1
            while end < len(text) and (text[end] != "`" or text[end - 1] == "\\"):
                end += 1
            if end == len(text):
                raise AmbiguousScript("unterminated command substitution in " + ("shell text" if shell else "unquoted heredoc"))
            result.append((index, end + 1, text[index + 1:end]) if spans else text[index + 1:end])
            index = end + 1
            continue
        if text.startswith("$(", index) and not text.startswith("$((", index):
            end, nesting, quote = index + 2, 1, None
            while end < len(text) and nesting:
                char = text[end]
                if char == "\\":
                    end += 2
                    continue
                if quote:
                    if char == quote:
                        quote = None
                elif char in "\"'":
                    quote = char
                elif shell and char == "#" and (end == 0 or text[end - 1].isspace() or text[end - 1] in ";&|(){}"):
                    newline = text.find("\n", end)
                    end = len(text) if newline == -1 else newline
                    continue
                elif char == "(":
                    nesting += 1
                elif char == ")":
                    nesting -= 1
                end += 1
            if nesting:
                raise AmbiguousScript("unterminated command substitution in " + ("shell text" if shell else "unquoted heredoc"))
            result.append((index, end, text[index + 2:end - 1]) if spans else text[index + 2:end - 1])
            index = end
            continue
        index += 1
    return result


def _heredoc_word(source, start):
    index, value, quote, quoted = start, [], None, False
    while index < len(source):
        char = source[index]
        if char == "\\" and quote != "'":
            if index + 1 == len(source):
                raise AmbiguousScript("unterminated heredoc delimiter " + _token(source[start:index + 1]))
            following = source[index + 1]
            # Bare line continuations disappear before shell tokenization;
            # they must not suppress expansions in the document body.
            quoted |= following != '\n'
            if quote == '"' and following not in '$`"\\\n':
                value.append('\\')
                index += 1
                continue
            if following != '\n':
                value.append(following)
            index += 2
            continue
        if quote:
            if char == quote:
                quote = None
            else:
                value.append(char)
        elif char == '$' and source[index + 1:index + 2] in {"'", '"'}:
            raise AmbiguousScript("unsupported dollar-quoted heredoc delimiter " + _token(source[start:].split('\n', 1)[0]))
        elif char in "\"'":
            quoted, quote = True, char
        elif char.isspace() or char in ';&|<>()':
            break
        else:
            value.append(char)
        index += 1
    if quote:
        raise AmbiguousScript("unterminated heredoc delimiter " + _token(source[start:index].rstrip('\r\n')))
    return index, ''.join(value), quoted


def _heredocs(source, offset=0, known=()):
    lines = source.splitlines(keepends=True)
    starts = [0]
    for line in lines:
        starts.append(starts[-1] + len(line))
    output, bodies = [], {}
    index, quote, escaped, substitutions = 0, None, False, []
    while index < len(lines):
        line = lines[index]
        line_start = starts[index]
        index += 1
        # A wrapped shell payload can be one quoted word across many lines.
        # Its heredocs belong to the recursive scan after outer quote removal.
        matches = []
        i = 0
        while i < len(line):
            char = line[i]
            if escaped:
                escaped = False
            elif char == "\\" and quote != "'":
                escaped = True
            elif char == '`' and quote != "'":
                # Backtick contents have their own quote context. They are
                # inspected recursively by the substitution walker.
                end = line_start + i + 1
                while end < len(source) and source[end] != '`':
                    end += 2 if source[end] == '\\' else 1
                if end >= len(source):
                    raise AmbiguousScript('unterminated backtick substitution')
                while end - line_start >= len(line) and index < len(lines):
                    line += lines[index]
                    index += 1
                i = end - line_start
            elif quote != "'" and line.startswith("$(", i) and not line.startswith("$((", i):
                substitutions.append([quote, 1])
                quote = None
                i += 1
            elif quote:
                if char == quote:
                    quote = None
            elif substitutions and char == "(":
                substitutions[-1][1] += 1
            elif substitutions and char == ")":
                substitutions[-1][1] -= 1
                if not substitutions[-1][1]:
                    quote = substitutions.pop()[0]
            elif char in "\"'":
                quote = char
            elif char == "#" and (i == 0 or line[i-1].isspace()):
                break
            elif line.startswith('<<<', i):
                i += 2
            elif line.startswith("<<", i):
                start = i + 2
                tabs = line[start:start + 1] == '-'
                start += tabs
                while start < len(line) and line[start] in ' \t':
                    start += 1
                end, delimiter, quoted = _heredoc_word(source, line_start + start)
                end -= line_start
                if end > start:
                    while end > len(line) and index < len(lines):
                        line += lines[index]
                        index += 1
                    if delimiter not in known:
                        key = f"__guard_heredoc_{offset + len(bodies) + len(matches)}__"
                        matches.append((i, end, tabs, delimiter, key, quoted))
                    consumed = end - i
                    i += consumed - 1
            i += 1
        for start, end, tabs, delimiter, key, quoted in reversed(matches):
            line = line[:start] + "<< " + key + line[end:]
        output.append(line)
        for _, _, tabs, delimiter, key, quoted in matches:
            body = []
            while index < len(lines):
                candidate = lines[index]
                index += 1
                if (candidate.lstrip("\t") if tabs else candidate).rstrip("\r\n") == delimiter:
                    break
                body.append(candidate.lstrip("\t") if tabs else candidate)
            else:
                raise UnterminatedHeredoc("unterminated heredoc " + _token(delimiter))
            bodies[key] = ("".join(body), quoted)
            output.append("\n" * (len(body) + 1))
    return "".join(output), bodies


def _jq_read_words(words):
    result, inputs, index = [words[0]], [], 1
    program, positional_args, options = False, False, True
    while index < len(words):
        word = words[index]
        if options and word in {"--arg", "--argjson"}:
            index += 3
        elif options and word in {"--args", "--jsonargs"}:
            positional_args = True
            index += 1
        elif options and word in {"--rawfile", "--slurpfile", "--argfile"}:
            result.extend(words[index:index + 3])
            index += 3
        elif options and word in {"--from-file", "--run-tests", "-L", "--library-path", "--indent"}:
            result.extend(words[index:index + 2])
            program |= word in {"--from-file", "--run-tests"}
            index += 2
        elif options and word.startswith("--from-file="):
            result.append(word)
            program = True
            index += 1
        elif options and re.match(r"^-[A-Za-z]*f", word):
            result.append(word)
            if re.fullmatch(r"-[A-Za-z]*f", word) and index + 1 < len(words):
                result.append(words[index + 1])
                index += 1
            program = True
            index += 1
        elif options and word == "--":
            options = False
            index += 1
        elif options and word.startswith("-"):
            result.append(word)
            index += 1
        elif not program:
            program = True
            index += 1
        else:
            if not positional_args:
                inputs.append(word)
            index += 1
    return result + inputs


def _rg_lists_files(words):
    if not words or os.path.basename(words[0]) != 'rg':
        return False
    index = 1
    listing = False
    while index < len(words):
        word = words[index]
        if word == '--':
            return listing
        if word == '--files':
            listing = True
            index += 1
            continue
        if word in {'-l', '--files-with-matches', '--files-without-match', '-c', '--count', '--count-matches', '-q', '--quiet', '--json'}:
            # Ripgrep's last mode flag wins, including flags after --files.
            listing = False
            index += 1
            continue
        flag, equal, _ = word.partition('=')
        if flag in {'-g', '--glob', '--iglob', '-e', '--regexp', '-f', '--file', '-t', '--type', '-T', '--type-not'}:
            index += 1 if equal else 2
        elif word in {'--hidden', '--no-hidden', '--no-ignore', '--no-ignore-vcs', '-uu', '-uuu', '-u', '-L', '--follow'} or not word.startswith('-'):
            index += 1
        else:
            return False
    return listing


def _fd_lists_files(words):
    index = 1
    operands = {'--max-depth', '--min-depth', '--exact-depth', '--exclude', '--type', '--extension', '--size', '--owner', '--format', '--threads', '--max-results', '--base-directory', '--path-separator', '--search-path', '--batch-size', '--changed-within', '--changed-before', '--and', '--color', '--ignore-contain'}
    while index < len(words):
        word = words[index]
        if word == '--':
            return True
        flag, equal, _ = word.partition('=')
        if flag in {'--exec', '--exec-batch', '--ignore-file'}:
            return False
        if flag in operands:
            index += 1 if equal else 2
            continue
        if word.startswith('-') and not word.startswith('--'):
            for offset, letter in enumerate(word[1:], 1):
                if letter in 'xX':
                    return False
                if letter in 'dEteSocjC':
                    # Remaining characters are one attached operand, not flags.
                    if offset == len(word) - 1:
                        index += 1
                    break
        index += 1
    return True


def _listing_only(words):
    if not words:
        return False
    binary = os.path.basename(words[0])
    if binary == 'rg':
        return _rg_lists_files(words)
    if binary in {'fd', 'fdfind'}:
        return _fd_lists_files(words)
    if binary == 'find':
        return not any(w in {'-exec', '-execdir', '-ok', '-okdir', '-delete', '-fls', '-files0-from'} or w.startswith('-fprint') for w in words[1:])
    return binary == 'ls'


def _search_read_words(words):
    # Regexps are data; pattern files, include globs and positional paths are
    # still readers. Parse options before choosing an implicit first pattern.
    result, positionals, explicit, options = [words[0]], [], False, True
    index = 1
    values = {'-A', '--after-context', '-B', '--before-context', '-C', '--context', '-m', '--max-count'}
    switches = {'--files-with-matches', '--count', '--quiet', '--line-number',
                '--text', '--fixed-strings', '--ignore-case',
                '--word-regexp', '--line-regexp', '--invert-match', '--only-matching', '--no-messages',
                '--with-filename', '--no-filename', '--null', '--null-data'}
    short_switches = set('abchiIlLnNqsvwxoFHzU')
    grep = os.path.basename(words[0]) == 'grep'
    if grep:
        values |= {'--include', '--exclude', '--exclude-dir', '--exclude-from', '--label',
                   '--binary-files', '--directories', '--devices', '-d', '-D'}
        switches |= {'--recursive', '--dereference-recursive', '--files-without-match', '--initial-tab'}
        short_switches |= set('EGPRrTuVZ0123456789')
    else:
        values |= {'-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not', '-j', '--threads',
                   '-M', '--max-columns', '-E', '--encoding', '--color', '--colors', '--sort', '--sortr',
                   '--max-depth', '--max-filesize', '--ignore-file', '--type-add', '--type-clear',
                   '--engine', '--replace', '-r', '--path-separator', '--hostname-bin', '--pre', '--pre-glob'}
        switches |= {'--files', '--files-without-match', '--count-matches', '--json', '--hidden',
                     '--no-hidden', '--no-ignore', '--no-ignore-vcs', '--follow', '--no-line-number',
                     '--case-sensitive', '--smart-case', '--pcre2', '--stats', '--multiline'}
        short_switches |= set('PSuV0')
    while index < len(words):
        word = words[index]
        flag, equal, _ = word.partition('=')
        if options and word == '--':
            options = False
            result.append(word)
        elif options and flag in {'-e', '--regexp', '-f', '--file'}:
            explicit = True
            if flag in {'-f', '--file'}:
                result.extend(words[index:index + (1 if equal else 2)])
            index += 0 if equal else 1
        elif options and flag in values:
            result.extend(words[index:index + (1 if equal else 2)])
            index += 0 if equal else 1
        elif options and word.startswith('-') and not word.startswith('--'):
            operand = next((n for n, char in enumerate(word[1:], 1) if char in 'ef' or '-' + char in values), None)
            prefix = word[1:operand] if operand is not None else word[1:]
            if any(char not in short_switches for char in prefix):
                return words
            if operand is not None:
                char = word[operand]
                attached = operand + 1 < len(word)
                explicit |= char in 'ef'
                if char != 'e':
                    result.append(word)
                    if not attached and index + 1 < len(words):
                        result.append(words[index + 1])
                index += 0 if attached else 1
            else:
                result.append(word)
        elif options and word.startswith('--'):
            # GNU grep's color operand is optional and must be attached.
            if word not in switches and not (grep and flag in {'--color', '--colour'}):
                return words
            result.append(word)
        else:
            positionals.append(len(result))
            result.append(word)
        index += 1
    if not explicit and not _rg_lists_files(words) and positionals:
        del result[positionals[0]]
    return result


def _read_words(words):
    if not words:
        return words
    binary = os.path.basename(words[0])
    if binary == "jq":
        return _jq_read_words(words)
    if binary in {'rg', 'grep'}:
        words = _search_read_words(words)
    listing = _rg_lists_files(words)
    fd_listing = binary in {"fd", "fdfind"} and _listing_only(words)
    find_listing = binary == "find" and _listing_only(words)
    result, index, fd_pattern = [], 0, False
    while index < len(words):
        word = words[index]
        flag, equal, inline = word.partition("=")
        pair = flag in {"-g", "--glob", "--iglob"} if binary == "rg" else False
        pair |= binary in {"fd", "fdfind"} and flag in {"-E", "--exclude", "-g", "--glob"}
        pair |= binary == "grep" and flag in {"--exclude", "--exclude-dir"}
        pair |= binary == "find" and flag in {"-name", "-iname", "-path", "-wholename"}
        pair |= binary == "git" and words[1:2] == ["ls-files"] and flag in {"-x", "--exclude"}
        if pair:
            value = inline if equal else words[index + 1] if index + 1 < len(words) else ""
            drop = (listing or binary in {"grep", "git"} or
                    binary in {"fd", "fdfind"} and (fd_listing or flag in {"-E", "--exclude"}) or
                    (binary == "rg" and value.startswith("!")) or
                    (binary == "find" and (find_listing or index > 0 and words[index - 1] in {"!", "-not"})))
            if not drop:
                result.extend([flag, value])
            if binary in {"fd", "fdfind"} and flag in {"-g", "--glob"}:
                fd_pattern = True
            index += 1 if equal else 2
            continue
        if fd_listing:
            if word in {"-e", "--extension", "-t", "--type", "-d", "--max-depth"}:
                index += 2
                continue
            if index and not word.startswith("-") and not fd_pattern:
                fd_pattern = True
                index += 1
                continue
        result.append(word)
        index += 1
    return result


def _direct_read(words, directory):
    listing = _listing_only(words)
    words = _read_words(words)
    if listing:
        # Stdin redirection is checked separately; discovery only lists names.
        return False
    if not words or not READER.search(" ".join(words)) and os.path.basename(words[0]) not in {"find", "fd", "fdfind"}:
        return False
    roots = [str(directory)] if directory is not None else []
    roots.extend(str(path) for word in words[1:256] if (path := _literal_path(word, directory)) is not None)
    live_root = any(re.search(r"(?:\.robob|robob-data)(?:/|$)|(?:\.local/share/opencode|opencode-data)(?:/|$)", root) for root in roots)
    for index, value in enumerate(words[1:256], 1):
        if os.path.basename(words[0]) == "find" and value in {"statev2.sqlite", "opencode.db"}:
            if any(LIVE.search(root.rstrip("/") + "/" + value) for root in words[1:]):
                return True
        # A content-search include filter can select the live file; exclusion
        # filters were removed above. Bare fixture names elsewhere cannot.
        if live_root and re.search(r"(?:statev2|opencode\.db)", value):
            if value.startswith("--include=") or "*" in value or words[index - 1] in {"-g", "--glob", "--iglob"}:
                return True
        path = _literal_path(value, directory)
        if path is not None and LIVE.search(str(path)):
            return True
        if LIVE.search(value):
            return True
        if (re.search(r'state\.sqlite(?:-(?:wal|shm|journal))?$', value) and
                os.path.basename(words[0]) in {'sqlite', 'sqlite3'} and
                not REPLICA.search(value) and 'state.sqlite' in _foreign_state_source(value, directory)):
            return True
    return False


def _literal_path(value: str, cwd: Path | None) -> Path | None:
    value = re.sub(r"^(?:~|\$HOME|\$\{HOME\})(?=/|$)", str(Path.home()), value)
    if not value or re.search(r"[$`*?\[\]]", value) or value == "-":
        return None
    path = Path(value)
    if not path.is_absolute():
        if cwd is None:
            return None
        path = cwd / path
    return Path(os.path.realpath(path))


def _node_test_glob_matches(value, directory):
    pattern = str(Path.home()) + value[1:] if value.startswith('~/') else value
    if re.search(r'[$`~\\\r\n{}]', pattern):
        raise AmbiguousScript(f"node --test glob {_token(value)} has unsupported expansion")
    # Python and shells disagree on caret/POSIX character classes. Only the
    # common literal-list/range grammar can supply a complete scan here.
    if '[' in re.sub(r'\[!?[A-Za-z0-9_.-]+\]', '', pattern):
        raise AmbiguousScript(f"node --test glob {_token(value)} has an unsupported character class")
    if directory is None:
        raise AmbiguousScript(f"node --test glob {_token(value)} has an unknown working directory")
    try:
        matches = sorted(glob.glob(pattern, root_dir=str(directory), recursive=True))
        files = []
        for match in matches:
            # Glob results are filenames, not new shell expressions. Resolve
            # symlinks without interpreting metacharacters in matched names.
            path = Path(os.path.realpath(directory / match))
            if not stat.S_ISREG(path.stat().st_mode):
                raise AmbiguousScript(f"node --test glob {_token(value)} matched a non-regular file {_token(match)}")
            files.append(path)
    except (OSError, ValueError, RecursionError) as error:
        raise AmbiguousScript(f"node --test glob {_token(value)} could not be checked") from error
    if not files:
        raise AmbiguousScript(f"node --test glob {_token(value)} matched no files in {directory}")
    return files


def _interpreter_args(binary, args):
    operands = {"-X", "-W", "--check-hash-based-pycs"} if re.fullmatch(r"python[\d.]*", binary) else set()
    if binary in {"bash", "sh", "zsh", "dash", "ksh"}:
        operands |= {"-o", "+o", "-O", "+O"}
    if binary in {"node", "bun", "deno"}:
        operands |= {"--test-name-pattern", "--test-skip-pattern", "--test-reporter", "--test-reporter-destination", "--test-concurrency"}
    result, index = [], 0
    while index < len(args):
        flag = args[index]
        if flag in {"-c", "-e", "--eval", "-p", "--print", "-m", "--", "-"} or not flag.startswith(("-", "+")):
            return result + args[index:]
        index += 2 if flag in operands else 1
        if flag not in operands:
            result.append(flag)
    return result


def _node_arguments(args):
    result, inputs, test_mode, runtime_options = [], [], False, False
    index = 0
    while index < len(args):
        arg = args[index]
        if arg in {'--', '-', '-e', '--eval', '-p', '--print'} or not arg.startswith('-'):
            return result + args[index:], inputs, test_mode, runtime_options
        flag, equal, value = arg.partition('=')
        if flag in NODE_SCRIPT_OPTIONS | NODE_VALUE_OPTIONS:
            runtime_options = True
            if not equal:
                index += 1
                value = args[index] if index < len(args) else ''
            if flag in NODE_SCRIPT_OPTIONS | NODE_FILE_OPTIONS and value:
                inputs.append(value)
        else:
            if arg == '--test':
                test_mode = True
            elif arg == '--no-test':
                test_mode = False
            result.append(arg)
        index += 1
    return result, inputs, test_mode, runtime_options


def _concurrent_group(tokens, index):
    while index < len(tokens):
        token = tokens[index]
        if token == "&" and index + 1 < len(tokens) and tokens[index + 1] in {">", ">>"}:
            index += 3
        elif token in {"<", "<>", ">", ">>", "<<", "<<<"}:
            index += 1
            if index < len(tokens) and tokens[index] in {"&", "|"}:
                index += 1
            index += 1
        elif token in {";", "&&", "||", "|", "&", "\n"}:
            return token in {"|", "&"}
        else:
            index += 1
    return False


def _quoted_punctuation(source, script_literals=False, single_quotes_only=False):
    # shlex strips quotes, making a filename like '&' indistinguishable from
    # a background operator. Keep quoted punctuation opaque until command data
    # is inspected, including adjacent quoted pieces of a single word.
    if "\0" in source:
        raise AmbiguousScript("shell text contains a NUL byte")
    # A shell word cannot contain NUL, even by concatenating quoted pieces.
    # Reserved markers therefore cannot collide with an input filename.
    prefix = "\0guard_quoted_"
    output, quoted, index = [], {}, 0
    # Keep executed substitutions intact until the walker knows this word's cwd.
    pieces, end = [], 0
    for start, stop, _ in _substitutions(source, shell=True, spans=True):
        key = f"{prefix}{len(quoted)}__"
        quoted[key] = source[start:stop]
        pieces.extend([source[end:start], key])
        end = stop
    source = "".join([*pieces, source[end:]])
    while index < len(source):
        char = source[index]
        if char == "#" and (index == 0 or source[index - 1].isspace() or source[index - 1] in ";&|(){}"):
            end = source.find("\n", index)
            end = len(source) if end == -1 else end
            output.append(' ' * (end - index) if script_literals else source[index:end])
            index = end
            continue
        if char == "\\" and index + 1 < len(source):
            if script_literals:
                if source[index + 1] == '\n':
                    output.append(source[index:index + 2])
                    index += 2
                    continue
                key = f"\0guard_literal_escape_{len(quoted)}__"
                quoted[key] = source[index + 1]
                output.append(key)
                index += 2
                continue
            output.append(source[index:index + 2])
            index += 2
            continue
        if script_literals:
            # Descriptor operands are not command names and cannot replace a
            # script's contents; input redirects remain visible to the walker.
            boundary = index == 0 or source[index - 1].isspace() or source[index - 1] in ';&|(){}'
            duplicate = re.match(r'(?:\d*)>&(?:\d+|-)(?=$|[\s;&|(){}<>])', source[index:]) if char == '>' or boundary else None
            descriptor = re.match(r'\d+(?=[<>])', source[index:]) if boundary else None
            if duplicate or descriptor:
                index += (duplicate or descriptor).end()
                continue
        if source.startswith("${", index):
            end, levels = index + 2, [None]
            while end < len(source) and levels:
                current, quote = source[end], levels[-1]
                if current == "\\" and quote != "'":
                    end += 2
                    continue
                if current in "\"'" and quote in {None, current}:
                    levels[-1] = current if quote is None else None
                elif quote != "'" and source.startswith("${", end):
                    levels.append(None)
                    end += 2
                    continue
                elif current == "}" and quote is None:
                    levels.pop()
                end += 1
            if not levels:
                # Parameter braces belong to the word, not a shell group.
                key = f"{prefix}{len(quoted)}__"
                quoted[key] = source[index:end]
                output.append(key)
                index = end
                continue
        if char in "\"'":
            end = index + 1
            while end < len(source):
                if source[end] == "\\" and (char == '"' or single_quotes_only and index > 0 and source[index - 1] == '$'):
                    end += 2
                    continue
                if source[end] == char:
                    break
                end += 1
            value = source[index + 1:end]
            if single_quotes_only:
                if char == "'" and (index == 0 or source[index - 1] != '$'):
                    output.append(' ' + ''.join('\n' if c == '\n' else ' ' for c in value) + ' ')
                else:
                    output.append(source[index:end + 1])
                index = end + 1
                continue
            literal = script_literals and (char == "'" or '\\$' in value or '\\`' in value)
            double = script_literals and char == '"' and not literal
            if end < len(source) and (re.fullmatch(r"[;&|(){}\n<>]+", value) or literal or double):
                literal_prefix = '\0guard_literal_double_' if char == '"' else '\0guard_literal_'
                key = (f"{literal_prefix}{len(quoted)}__" if literal else
                       f"\0guard_double_{len(quoted)}__" if double else f"{prefix}{len(quoted)}__")
                if double:
                    value = shlex.split(source[index:end + 1])[0]
                quoted[key] = value
                output.append(key)
            else:
                output.append(source[index:end + 1])
            index = end + 1
            continue
        output.append(char)
        index += 1
    result = "".join(output)
    if single_quotes_only:
        # Keep substitutions, parameter expansions and backticks live. Only
        # ordinary single quotes are inert for the binding preflight.
        for key, value in reversed(quoted.items()):
            result = result.replace(key, value)
    return result, quoted


def _offbox_payload(words, *, known_only=True):
    if len(words) < 3 or os.path.basename(words[0]) != 'offbox' or words[1] != 'run':
        return None
    index = 2
    while index < len(words):
        flag, equal, value = words[index].partition('=')
        if words[index] == '--':
            return words[index + 1:]
        if flag in {'--include', '--size', '--template', '--base', '--pull', '--env'}:
            value = value if equal else words[index + 1] if index + 1 < len(words) else ''
            if not value or value.startswith('-') or flag == '--env' and not _safe_fixture_assignment(value):
                return words[words.index('--', index) + 1:] if not known_only and '--' in words[index:] else None
            index += 1 if equal else 2
        elif flag in {'--bg', '--remote', '--no-fallback', '--git', '--fresh', '--no-sync', '--no-retry'} and not equal:
            index += 1
        else:
            # Preserve scanning of unknown wrappers, but do not transfer a
            # caller proof through flags that may change execution bindings.
            return words[words.index('--', index) + 1:] if not known_only and '--' in words[index:] else None
    return None


def _safe_fixture_assignment(word):
    match = re.fullmatch(r'([A-Za-z_]\w*)=([\s\S]*)', word)
    if not match:
        return False
    name, value = match.groups()
    if (name in {'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'PS4', 'IFS', 'PATH', 'CDPATH',
                 'HOME', 'PROMPT_COMMAND', 'GLOBIGNORE', 'ZDOTDIR'} or
            name.startswith(('BASH_', 'LD_', 'DYLD_', 'PYTHON'))):
        return False
    return not re.search(r'[$`]', value) or _fresh_mktemp(value) and not re.search(r'[$`<>#\r\n]', value[2:-1])


def _fixture_invocation(source):
    # shlex alone splits unquoted $(mktemp -d) into two words. Reuse the
    # walker's opaque substitutions without evaluating or trusting their body.
    text, quoted = _quoted_punctuation(source)
    lexer = shlex.shlex(text, posix=True, punctuation_chars=';&|(){}\n<>')
    lexer.whitespace = ' \t\r'
    lexer.whitespace_split = True
    words = list(lexer)
    while words and re.fullmatch(r'\n+', words[0]):
        words.pop(0)
    while words and re.fullmatch(r'\n+', words[-1]):
        words.pop()
    # A later command can change lookup or startup bindings. Reject operators
    # before stripping assignments; quoted punctuation remains ordinary data.
    if any(re.fullmatch(r'[;&|(){}\n<>]+', word) for word in words):
        return []
    for key, value in reversed(quoted.items()):
        words = [word.replace(key, value) for word in words]

    def strip_environment(argv):
        index, env_seen = 0, False
        while index < len(argv):
            word = argv[index]
            if re.match(r'^[A-Za-z_]\w*=', word):
                if not _safe_fixture_assignment(word):
                    return []
                index += 1
            elif word == 'env' and not env_seen:
                env_seen = True
                index += 1
                if index == len(argv) or not re.match(r'^[A-Za-z_]\w*=', argv[index]):
                    return []
            else:
                break
        return argv[index:]

    words = strip_environment(words)
    payload = _offbox_payload(words)
    return strip_environment(payload) if payload is not None else words


def _fresh_mktemp(value):
    if not re.fullmatch(r'\$\(mktemp -d(?: [^;&|()`\n]*)?\)', value):
        return False
    if re.search(r'\.\.|\.robob/userdata|robob-data|\.t3/userdata|\.local/share/opencode|opencode-data', value):
        return False
    try:
        args = shlex.split(value[2:-1])[2:]
    except ValueError:
        return False
    # Only HOME/PWD are bounded template expansions. No option can turn this
    # into a dry run, or redirect -t's generated name outside its temp root.
    args = [re.sub(r'\$\{?(HOME|PWD)\}?', '/guard-root', arg) for arg in args]
    if args[:1] == ['-t']:
        return len(args) == 2 and '/' not in args[1] and not re.search(r'[$`*?\[\]{}~]', args[1])
    return len(args) <= 1 and all(not arg.startswith('-') and not re.search(r'[$`*?\[\]{}]', arg) for arg in args)


def _attached_script_operand(word, binary):
    flag, equal, value = word.partition('=')
    options = NODE_SCRIPT_OPTIONS | NODE_FILE_OPTIONS if binary == 'node' else {'--preload'} if binary == 'bun' else set()
    return value if equal and flag in options else word


def scripts_in(command: str, cwd: str | Path | None, *, _depth=0, _sources=None, _stdin=None, _environment=None, _opaque=None, _preservation=True, _budget=None, _glob_writes=None, _cwd_candidates=None) -> list[Path]:
    """Resolve bounded shell paths and inspect sources without executing them."""
    paths = []
    script_files, node_test_files = _budget if _budget is not None else (set(), set())
    glob_writes = _glob_writes if _glob_writes is not None else set()
    written = {}
    invalidated_written = {}
    write_history = {}
    variable_written = set()
    tool_changes = set()
    stdin_words, stdin_bodies = _stdin or ([], {})
    if _sources is not None:
        prior_written, prior_invalidated, prior_history, prior_variable, prior_tool_changes = _sources
        written.update(prior_written)
        invalidated_written.update(prior_invalidated)
        write_history.update((path, list(history)) for path, history in prior_history.items())
        variable_written.update(prior_variable)
        tool_changes.update(prior_tool_changes)
    unknown_cause = "directory changed in a conditional branch"
    unknown_directories = set(_cwd_candidates or ())
    conditional = 0
    inherited_values, inherited_unsafe, caller_command = _environment or ({}, False, None)
    shell_values = {"HOME": str(Path.home()), **inherited_values}
    path_values = {}
    live_assignments = set()
    # Script bindings keep unknown branch values, unlike the reader's lexical
    # expansion. A safe assignment in one branch cannot prove a script path.
    script_values = {}
    opaque_written, inherited_empty, inherited_reasons = _opaque or ({}, set(), {})
    opaque_written = dict(opaque_written)
    inherited_quoted = {value for _, value in opaque_written}
    invocation_written = {}
    invocation_fresh = set()
    invocation_literals = set()
    invocation_reader_literals = set()
    invocation_quoted = set()
    invocation_glob_escaped = set()
    uncertain_write = 0
    unsafe_bindings = bool(inherited_unsafe)
    unsafe_binding_cause = inherited_unsafe or None
    # Opaque paths need a fresh, unmodified root; existing files cannot be
    # assumed replaced when a write fails or is skipped.
    fresh_variables = set()
    marker_variables = set()
    populated_paths = set()
    binding_causes = {}
    writer_causes = {}
    last_invalidation = None
    invocation_invalidation = None
    invocation_startup_failure = None
    current_line = 1
    copied_opaque = set()
    noclobber = False
    proof_failure = 'opaque binary'
    execution_site = 'script operand'
    execution_binary = 'script'

    def binary_label(words):
        binary = os.path.basename(words[0]) if words else ''
        # Executable names are caller-controlled too. Only emit vocabulary
        # owned by the guard, never a path or an arbitrary command token.
        if re.fullmatch(r'python[\d.]*', binary):
            return 'python3' if binary.startswith('python3') else 'python'
        return binary if binary in {'node', 'bun', 'deno', 'bash', 'sh', 'zsh', 'dash', 'ksh',
                                    'cat', 'tee', 'sed', 'chmod', 'mkdir', 'ls', 'test', 'echo',
                                    'cp', 'mv', 'rsync', 'ditto', 'install', 'git', 'offbox',
                                    'perl', 'truncate', 'true', 'printf', 'mktemp'} else 'opaque binary'

    def invalidate(paths, site, words=(), reason=None, destination=None):
        target = invalidated_written if destination is None else destination
        detail = f'{site}: {binary_label(words)} at line {current_line}; {reason or proof_failure}'
        for path in paths:
            target.setdefault(path, detail)

    def reader_directories(directory):
        # Unknown script paths still refuse; reader checks must also retain
        # directories that a skipped branch or loop could leave in effect.
        return (directory,) if directory is not None else (None, *unknown_directories)

    def direct_read(words, directory):
        return any(_direct_read(words, candidate) for candidate in reader_directories(directory))

    def remember_reader_directory(directory):
        if directory is not None:
            unknown_directories.add(directory)
            if len(unknown_directories) > MAX_SCRIPTS:
                raise AmbiguousScript(f"more than MAX_SCRIPTS ({MAX_SCRIPTS}) directory alternatives")

    def change_directory(value, directory):
        if directory is None:
            # Keep both skipped and taken alternatives, including wrapper
            # directories that do not change their caller's cwd.
            for candidate in tuple(unknown_directories):
                remember_reader_directory(_literal_path(value, candidate))
        return _literal_path(value, directory)

    def source_identity(path):
        # The same call may run on a case-insensitive, normalization-insensitive
        # filesystem (including offbox's local fallback). Missing fresh paths
        # cannot be stat'ed, so distinct spellings must not prove distinct files.
        return unicodedata.normalize('NFD', str(path).casefold())

    def opaque_key(value, directory):
        root = re.fullmatch(r'\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/([^$`*?\[\]{}]+)', value)
        if root and not Path(root[3]).is_absolute() and '..' not in Path(root[3]).parts and Path(root[3]) != Path('.'):
            return directory, root[1] or root[2], source_identity(Path(root[3]))
        return None

    def opaque_contains(parent, child):
        return (parent is not None and child is not None and parent[:2] == child[:2] and
                (parent[2] == child[2] or child[2].startswith(parent[2] + '/')))

    def opaque_fallback(value, directory):
        # Use the validated, unexpanded suffix: the variable's mktemp template
        # can itself contain slashes after script_variants expands it.
        return _literal_path(value[value.index('/'):], directory) if opaque_key(value, directory) else None

    def copied_source(key):
        # A named cp destination may already be a directory, in which case cp
        # writes below it using the source basename rather than replacing it.
        return next((copied for copied in copied_opaque if opaque_contains(copied, key)), None)

    def output_only_print(words):
        # zsh print -v (also in combined flags) assigns variables. The reporter
        # uses this exact output-only prefix; after -- every operand is data.
        return words[1:3] == ['-r', '--']

    def invalidate_print_bindings(words, line, loop=False):
        nonlocal unsafe_bindings, unsafe_binding_cause
        words = list(words)
        while words:
            if words[0] in {'do', 'then', 'else', 'if', 'while', 'until', '!', '{', '('} or re.match(r'^[A-Za-z_]\w*=', words[0]):
                words.pop(0)
            elif words[0] in {'command', 'builtin', 'noglob', 'nocorrect', 'time'}:
                modifier = words.pop(0)
                if modifier in {'command', 'time'} and words[:1] == ['-p']:
                    words.pop(0)
                if words[:1] == ['--']:
                    words.pop(0)
            else:
                break
        if not words or os.path.basename(words[0]) != 'print' or output_only_print(words):
            return
        unsafe_bindings = True
        context = ' in a loop' if loop else ''
        unsafe_binding_cause = f'unproved print flags may reassign shell/startup bindings{context} at line {line}'
        script_values.clear()
        opaque_written.clear()
        fresh_variables.clear()

    def path_refusal(value, directory, binary, reason=None):
        if '$' not in value and '`' not in value:
            return None
        names = re.findall(r'\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)', value)
        key = opaque_key(value, directory)
        if reason is None:
            if value in inherited_reasons:
                return inherited_reasons[value]
            if value not in invocation_quoted and value not in inherited_quoted:
                reason = 'unquoted script path; quote the directory variable (IFS/glob expansion is unproved)'
            elif unsafe_bindings:
                reason = unsafe_binding_cause
            elif key in writer_causes:
                reason = writer_causes[key]
            else:
                reason = next((binding_causes[a or b] for a, b in names if (a or b) in binding_causes), None)
                reason = reason or ('no readable same-call heredoc writer for this script; ' + invocation_invalidation
                                    if invocation_invalidation else 'no readable same-call heredoc writer for this script')
        extension = '.py' if binary.startswith('python') else '.sh' if binary in {'bash','sh','zsh','dash','ksh'} else '.ts' if binary == 'bun' else '.js'
        runner = f'bun test --preload "$d/x{extension}"' if binary == 'bun' else f'{binary} "$d/x{extension}"'
        return (f'{reason}: {_token(value)} ({binary})\n'
                f'Accepted: d=$(mktemp -d); cat > "$d/x{extension}" <<\'EOF\' … EOF; {runner} '
                '(quote "$d" and use a same-call heredoc), or create/write first and run its literal absolute script path in the next call.')

    def remember_glob_write(value, directory):
        path = _literal_path(value, directory)
        glob_writes.add(path)
        if path is not None:
            # A wildcard can traverse a symlink below its literal prefix.
            # Retain the destination spelling as well as the resolved target.
            value = re.sub(r"^(?:~|\$HOME|\$\{HOME\})(?=/|$)", str(Path.home()), value)
            lexical = Path(value)
            if not lexical.is_absolute():
                lexical = directory / lexical
            glob_writes.add(Path(os.path.abspath(lexical)))

    def affected_sources(path, descendants=False, *, track_tool=True):
        # Executable trust must survive the whole call, even writes before a
        # script is remembered. None records an unbounded mutation.
        if track_tool:
            tool_changes.add(path)
        glob_writes.add(path)
        if path is None:
            return set(written)
        identity = source_identity(path)
        affected = {remembered for remembered in written
                    if source_identity(remembered) == identity or
                    descendants and source_identity(remembered).startswith(identity.rstrip('/') + '/')}
        # Different realpaths can still name the same hard-linked file.
        # Unavailable identity cannot prove that a write leaves sources alone.
        try:
            destination_info = path.stat()
        except FileNotFoundError:
            return affected
        except OSError:
            return set(written)
        for remembered in written:
            try:
                if os.path.samestat(destination_info, remembered.stat()):
                    affected.add(remembered)
            except FileNotFoundError:
                continue
            except OSError:
                affected.add(remembered)
        return affected

    def unchanged_tool(executable, directory, *, descendants=False):
        if None in tool_changes:
            return False
        candidates = set()
        if '/' not in executable:
            # Relative PATH entries depend on the shell's current directory.
            if any(not os.path.isabs(entry) for entry in os.get_exec_path()):
                return False
            candidates.update(_literal_path(str(Path(entry) / executable), directory) for entry in os.get_exec_path())
            executable = shutil.which(executable)
        path = _literal_path(executable, directory) if executable else None
        if path is None:
            return False
        candidates.add(path)
        for changed in tool_changes:
            identity = source_identity(changed)
            if any(candidate is None or source_identity(candidate) == identity or
                   source_identity(candidate).startswith(identity.rstrip('/') + '/') or
                   descendants and identity.startswith(source_identity(candidate).rstrip('/') + '/')
                   for candidate in candidates):
                return False
            for candidate in candidates:
                try:
                    if os.path.samefile(candidate, changed):
                        return False
                except FileNotFoundError:
                    pass
                except OSError:
                    return False
        return True

    def python_preserves_sources(source, directory):
        nonlocal proof_failure
        proof_failure = 'python: operation proof failed'
        try:
            tree = ast.parse(source)
        except (SyntaxError, ValueError):
            proof_failure = 'python: source not parseable'
            return False
        bindings, strings = {}, set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                if node.func.attr in {'glob', 'rglob', 'walk', 'scandir', 'listdir', 'iterdir'}:
                    proof_failure = 'python: glob or traversal targets unproved'
                    return False
                elif node.func.attr in {'touch', 'rename', 'replace', 'unlink', 'extractall', 'urlretrieve'}:
                    proof_failure = 'python: mutation method outside write proof'

        def writer_parts(call):
            if isinstance(call.func, ast.Attribute) and call.func.attr in {'write', 'write_text', 'write_bytes'}:
                return call.func.value, [*call.args, *(k.value for k in call.keywords)]
            if _name(call.func) == 'json.dump' and len(call.args) == 2 and all(
                    k.arg in {'indent', 'sort_keys', 'ensure_ascii'} for k in call.keywords):
                return call.args[1], [call.args[0], *(k.value for k in call.keywords)]
            return None, []

        # Normalize one bounded context-manager writer into the same operation
        # proof as open(...).write/json.dump. Do not trust arbitrary handle use.
        statements = []
        for statement in tree.body:
            if isinstance(statement, ast.With) and len(statement.items) == 1 and len(statement.body) == 1:
                item = statement.items[0]
                body = statement.body[0]
                if (isinstance(item.optional_vars, ast.Name) and isinstance(body, ast.Expr) and
                        isinstance(body.value, ast.Call) and _name(body.value.func) == 'json.dump' and
                        len(body.value.args) == 2 and isinstance(body.value.args[1], ast.Name) and
                        body.value.args[1].id == item.optional_vars.id and
                        sum(isinstance(n, ast.Name) and n.id == item.optional_vars.id for n in ast.walk(tree)) == 2 and
                        item.optional_vars.id not in {'json', 'Path', 'pathlib', 'open', 'compile', 'ast'} and
                        not any(isinstance(n, ast.Name) and n.id == item.optional_vars.id for n in ast.walk(body.value.args[0]))):
                    body.value.args[1] = item.context_expr
                    statements.append(body)
                    continue
            statements.append(statement)
        tree.body = statements

        def string_value(node):
            return (isinstance(node, ast.Constant) and isinstance(node.value, str) or
                    isinstance(node, ast.Name) and node.id in strings or
                    isinstance(node, ast.Subscript) and string_value(node.value) or
                    isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add) and string_value(node.left) and string_value(node.right) or
                    isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and
                    (node.func.attr == 'read' and isinstance(node.func.value, ast.Call) and _name(node.func.value.func) == 'open' or
                     node.func.attr in {'read_text', 'read_bytes'} or
                     node.func.attr == 'replace' and string_value(node.func.value)))

        class StringMethods(ast.NodeTransformer):
            def visit_Call(self, node):
                string_replace = isinstance(node.func, ast.Attribute) and node.func.attr in {'replace', 'index'} and string_value(node.func.value)
                parse = (_name(node.func) == 'ast.parse' or _name(node.func) == 'compile')
                self.generic_visit(node)
                if string_replace or parse:
                    return ast.Tuple(elts=[*([node.func.value] if string_replace else []), *node.args, *(k.value for k in node.keywords)], ctx=ast.Load())
                return node

        def bound_names(node):
            if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
                return [node.id]
            if isinstance(node, ast.arg):
                return [node.arg]
            if isinstance(node, ast.alias):
                return [node.asname or node.name.split('.')[0]]
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.ExceptHandler)):
                return [node.name] if node.name else []
            return []

        for statement in tree.body:
            # Compound scopes can rebind a value before using it. Only a
            # straight-line assignment may keep the preceding value for its
            # RHS (s = s.replace(...)); nested rebinding needs another call.
            assignment_target = (statement.targets[0] if isinstance(statement, ast.Assign) and len(statement.targets) == 1 and
                                 isinstance(statement.targets[0], ast.Name) else None)
            for node in ast.walk(statement):
                if isinstance(node, ast.NamedExpr) or type(node).__name__ == 'Match':
                    return False
                if node is not assignment_target and any(name in bindings or name in strings for name in bound_names(node)):
                    return False
            if isinstance(statement, ast.Import):
                statement.names = [item for item in statement.names if item.name != 'ast' or item.asname]
            # Shadowed parsers and path constructors cannot justify preserving
            # source or selecting a sibling destination.
            constructors = {id(item) for item in statement.names
                            if (isinstance(statement, ast.Import) and item.name == 'pathlib' or
                                isinstance(statement, ast.ImportFrom) and statement.module == 'pathlib' and item.name == 'Path') and item.asname is None} if isinstance(statement, (ast.Import, ast.ImportFrom)) else set()
            if any(name in {'ast', 'compile', 'Path', 'pathlib'} and id(node) not in constructors
                   for node in ast.walk(statement) for name in bound_names(node)):
                return False
            # Only straight-line literal destinations can prove that a data
            # edit leaves remembered scripts alone. Keep all value expressions
            # in the AST so their side effects still face the read-only check.
            if isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call):
                call = statement.value
                receiver, data = writer_parts(call)
                if receiver is not None:
                    if isinstance(receiver, ast.Call) and _name(receiver.func) == 'open':
                        mode = receiver.args[1] if len(receiver.args) > 1 else next((k.value for k in receiver.keywords if k.arg == 'mode'), None)
                        if (not isinstance(mode, ast.Constant) or mode.value not in {'w', 'a', 'wb', 'ab'} or
                                not receiver.args or len(receiver.args) > 2 or
                                any(k.arg not in {'mode', 'encoding', 'errors'} for k in receiver.keywords)):
                            return False
                        destination = _path_expression(receiver.args[0], bindings, {})
                        values = [*receiver.args, *(k.value for k in receiver.keywords)]
                    elif isinstance(call.func, ast.Attribute) and call.func.attr in {'write_text', 'write_bytes'}:
                        destination = _path_expression(receiver, bindings, {})
                        values = [receiver]
                    else:
                        return False
                    path = _literal_path(destination, directory) if destination is not None else None
                    if path is None or affected_sources(path, descendants=True):
                        proof_failure = ('python: write target not literal' if path is None else
                                         'python: write target aliases checked source')
                        return False
                    statement.value = ast.Tuple(elts=[*values, *data], ctx=ast.Load())
            literal = None
            is_string = False
            if isinstance(statement, ast.Assign) and len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name):
                literal = _path_expression(statement.value, bindings, {})
                is_string = string_value(statement.value)
            statement = StringMethods().visit(statement)
            for node in ast.walk(statement):
                if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
                    bindings.pop(node.id, None)
                    strings.discard(node.id)
            if isinstance(statement, ast.Assign) and len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name):
                name = statement.targets[0].id
                if literal is not None:
                    bindings[name] = literal
                if is_string:
                    strings.add(name)
        return _fixture_python_readonly(source, tree=tree, pathlib_reads=True, data_helpers=True)

    def inherited_startup_safe(name, directory, script=None):
        return _inherited_startup_safe(name, directory, caller_command if caller_command is not None else command,
                                       shell_values, written, script,
                                       lambda path, **kwargs: unchanged_tool(path, directory, **kwargs))

    def startup_binding(name):
        return (name in {'PATH', 'IFS', 'ENV', 'BASH_ENV', 'BASHOPTS', 'SHELLOPTS', 'ZDOTDIR',
                         'NODE_OPTIONS', 'CDPATH', 'HOME', 'NVM_DIR', 'ROBOB_REPO_NODE_HELPER',
                         'ROBOB_REPO_NODE_PYTHON', 'ROBOB_REPO_PREVIOUS_BASH_ENV', '_repo_node_added_node'} or
                name in SHELL_SPECIAL_BINDINGS or name.startswith(('LD_', 'DYLD_')))

    def preservation_tool(words, directory, *, builtin=False):
        nonlocal proof_failure
        label = binary_label(words)
        if not _preservation:
            proof_failure = label + ': command wrapper proof failed'
            return False
        if unsafe_bindings or 'NODE_OPTIONS' in shell_values:
            proof_failure = label + ': shell lookup or startup proof failed'
            return False
        if any(name.startswith('BASH_FUNC_') for name in os.environ):
            proof_failure = label + ': executable provenance or mutation proof failed'
            return False
        names = set(shell_values) | set(os.environ)
        for name in names:
            if name in {'BASH_ENV', 'ENV', 'ZDOTDIR', 'BASHOPTS', 'SHELLOPTS', 'CDPATH'} or name in SHELL_SPECIAL_BINDINGS or name.startswith(('LD_', 'DYLD_')):
                if name in shell_values or os.environ.get(name) and not inherited_startup_safe(name, directory):
                    proof_failure = label + ': shell lookup or startup proof failed'
                    return False
        if not builtin and (not _trusted_fixture_tool(words[0], os.path.basename(words[0]), directory) or
                            not unchanged_tool(words[0], directory)):
            proof_failure = label + ': executable provenance or mutation proof failed'
            return False
        return True

    def interpreter_startup_proved(words, directory):
        nonlocal proof_failure
        binary = os.path.basename(words[0])
        if binary == 'zsh':
            proof_failure = 'zsh: implicit startup unproved'
            return False
        if re.fullmatch(r'python[\d.]*', binary):
            startup_args = list(words[1:])
            isolated = False
            while startup_args and startup_args[0] in {'-I', '-E', '-s', '-S', '-B', '-u', '-b', '-bb', '-q'}:
                isolated |= startup_args.pop(0) == '-I'
            if not isolated:
                proof_failure = 'python: non-isolated startup'
                return False
            if startup_args[:1] == ['-m']:
                proof_failure = 'python: module startup unproved'
                return False
            if startup_args and startup_args[0].startswith('-') and startup_args[0] not in {'-c', '-'}:
                proof_failure = 'python: startup options unproved'
                return False
        if binary in {'bun', 'deno'}:
            proof_failure = binary + ': startup configuration unproved'
            return False
        if binary == 'node' and (os.environ.get('NODE_OPTIONS') or 'NODE_OPTIONS' in shell_values):
            proof_failure = 'node: NODE_OPTIONS startup proof failed'
            return False
        node_options = NODE_SCRIPT_OPTIONS | NODE_VALUE_OPTIONS | NODE_FILE_OPTIONS
        safe_node_values = {'--input-type', '--test-name-pattern', '--test-skip-pattern', '--test-concurrency'}
        if (binary == 'node' and any(arg.partition('=')[0] in node_options - safe_node_values for arg in words[1:]) or
                binary == 'bun' and any(arg.partition('=')[0] == '--preload' for arg in words[1:])):
            proof_failure = binary + ': runtime startup options unproved'
            return False
        if binary == 'node':
            for arg in _node_arguments(words[1:])[0]:
                if not arg.startswith('-') or arg in {'--', '-', '-e', '--eval', '-p', '--print'}:
                    break
                if arg not in {'--test', '--no-test', '--no-warnings', '--check', '-c'}:
                    proof_failure = 'node: runtime startup options unproved'
                    return False
        if binary in {'bash', 'sh', 'zsh', 'dash', 'ksh'}:
            for index, arg in enumerate(words[1:]):
                if arg.startswith('+'):
                    raise AmbiguousScript(f'shell: plus options unproved at line {current_line}')
                if arg == '-' and index + 2 < len(words):
                    raise AmbiguousScript(f'shell: bare dash input unproved at line {current_line}')
                if not arg.startswith('-') or arg == '--':
                    break
                if arg in {'--noprofile', '--norc'}:
                    continue
                if not re.fullmatch(r'-[enucsvxf]+', arg):
                    proof_failure = 'shell: startup options unproved'
                    return False
                if 'c' in arg:
                    break
        return preservation_tool(words, directory)

    def direct_startup_proved(source, directory):
        nonlocal proof_failure
        # A retained executable proves its bytes, not the interpreter selected
        # by its shebang. Keep env split strings and custom loaders unproved.
        first = source.split('\n', 1)[0]
        if first.startswith('#!'):
            # The kernel does not interpret shell quotes or backslashes in
            # shebang words. shlex must never normalize another executable.
            if re.search(r'''['"\\\r\x00-\x08\x0b-\x1f]''', first):
                proof_failure = 'direct script: shebang word unproved'
                return False
            try:
                startup = shlex.split(first[2:])
            except ValueError:
                startup = []
            if not startup or len(startup) > 2 or not os.path.isabs(startup[0]):
                proof_failure = 'direct script: shebang startup unproved'
                return False
            if os.path.basename(startup[0]) == 'env':
                if len(startup) != 2 or startup[1].startswith('-') or not preservation_tool(startup, directory):
                    proof_failure = 'direct script: env shebang startup unproved'
                    return False
                startup = startup[1:]
        else:
            startup = ['sh']
        binary = os.path.basename(startup[0])
        if len(startup) == 2:
            option = startup[1]
            shell_option = binary in {'bash', 'sh', 'zsh', 'dash', 'ksh'} and (option in {'--noprofile', '--norc'} or re.fullmatch(r'-[enuxvf]+', option))
            if not shell_option and not (re.fullmatch(r'python[\d.]*', binary) and option == '-I'):
                proof_failure = 'direct script: shebang execution mode unproved'
                return False
        if binary not in {'node', 'bash', 'sh', 'zsh', 'dash', 'ksh'} and not re.fullmatch(r'python[\d.]*', binary):
            proof_failure = 'direct script: interpreter startup unproved'
            return False
        return interpreter_startup_proved(startup, directory)

    def require_direct_startup(source, directory, binary):
        if execution_site == 'direct script' and not direct_startup_proved(source, directory):
            raise AmbiguousScript(f'direct script startup at line {current_line}; {proof_failure}')

    def may_change_scripts(words, directory, stdin_sources=(), *, literal_eval=False, external_lookup=False, literal_arguments=()):
        nonlocal proof_failure
        proof_failure = 'opaque binary'
        words = list(words)
        if not words:
            return False
        binary = os.path.basename(words[0])
        if binary in {'node', 'bun', 'deno'}:
            proof_failure = 'node: source or operation proof failed'
        elif re.fullmatch(r'python[\d.]*', binary):
            proof_failure = 'python: source proof failed'
        if ((binary in {'node', 'bun', 'deno', 'bash', 'sh', 'zsh', 'dash', 'ksh'} or
                re.fullmatch(r'python[\d.]*', binary)) and not interpreter_startup_proved(words, directory)):
            return True
        builtin = (not external_lookup and words[0] in {'set', 'unset', 'print', ':'})
        if not preservation_tool(words, directory, builtin=builtin):
            return True
        # Fresh directory creation cannot replace an existing source or PATH
        # executable. Reuse the bounded mktemp grammar and tool provenance.
        if (binary == 'mktemp' and not unsafe_bindings and
                _fresh_mktemp('$(' + ' '.join(['mktemp', *words[1:]]) + ')') and
                not any(name.startswith('BASH_FUNC_') for name in os.environ) and
                _trusted_fixture_tool(words[0], 'mktemp', directory) and unchanged_tool(words[0], directory)):
            return False
        if binary == 'sed':
            if not literal_arguments or not all(literal_arguments):
                proof_failure = 'sed: operand expansion unproved'
                return True
            args = words[1:]
            if args[:1] == ['-i']:
                args = args[1:]
                if os.uname().sysname == 'Darwin':
                    if args[:1] != ['']:
                        proof_failure = 'sed: backup suffix or program unproved'
                        return True
                    args = args[1:]
                # sed can execute commands or write additional files from its
                # expression. Only a plain substitution has bounded outputs.
                if (len(args) >= 2 and re.fullmatch(r's/(?:\\.|[^/\\\n])*/(?:\\.|[^/\\\n])*/[gIp0-9]*', args[0]) and
                        all(not arg.startswith('-') and (path := _literal_path(arg, directory)) is not None and
                            not affected_sources(path, descendants=True) for arg in args[1:])):
                    return False
            proof_failure = 'sed: output targets or expression unproved'
        # These writers have explicit destinations, handled by affected_sources
        # below. Treating them as arbitrary programs also invalidated siblings.
        if binary == 'cp' and len(words) == 3 and not any(arg.startswith('-') for arg in words[1:]):
            if (len(literal_arguments) != len(words) or
                    any(not literal and not (word in invocation_quoted and opaque_key(word, directory))
                        for word, literal in zip(words, literal_arguments))):
                proof_failure = 'cp: operand expansion unproved'
                return True
            if unsafe_bindings:
                return True
            source = _literal_path(words[1], directory)
            target = words[2]
            if (words[1] in invocation_quoted and (directory, words[1]) in opaque_written and
                    _literal_path(target, directory) is not None):
                return False
            if source is not None and _literal_path(target, directory) is not None:
                return False
            root = re.fullmatch(r'\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/([^$`*?\[\]{}]*)', target)
            if source is not None and root and (root[1] or root[2]) in fresh_variables:
                tool_changes.add(opaque_fallback(target, directory))
                # A named sibling preserves other paths. copied_opaque still
                # prevents executing or replacing this unchecked copy itself.
                if target in invocation_quoted and opaque_key(target, directory):
                    return False
                return not (source.suffix == '.ndjson' and root[3] in {'', source.name})
        if binary == 'git':
            proof_failure = 'git: startup configuration unproved'
            return True
        if binary == 'unset' and all(re.fullmatch(r'[A-Za-z_]\w*', arg) for arg in words[1:]):
            return False
        if binary in {'bash', 'sh', 'zsh', 'dash', 'ksh', 'node', 'bun', 'deno'} or re.fullmatch(r'python[\d.]*', binary):
            parse_args = [arg for arg in words[1:] if arg != '--no-warnings']
            if (binary == 'node' and not unsafe_bindings and not os.environ.get('NODE_OPTIONS') and
                    'NODE_OPTIONS' not in shell_values and len(parse_args) == 2 and parse_args[0] in {'--check', '-c'} and
                    not parse_args[1].startswith('-') and not any(name.startswith('BASH_FUNC_') for name in os.environ) and
                    _trusted_fixture_tool(words[0], 'node', directory) and unchanged_tool(words[0], directory)):
                return False
            if (binary in {'bash', 'sh', 'zsh', 'dash', 'ksh'} and len(words) == 3 and words[1] == '-n' and
                    not words[2].startswith('-') and not unsafe_bindings and unchanged_tool(words[0], directory) and
                    # Bash's noexec mode also disables startup-file commands.
                    # Other shells retain their existing startup proof.
                    (binary == 'bash' and _trusted_fixture_tool(words[0], 'bash', directory) or
                     not any(name in shell_values or os.environ.get(name) and not inherited_startup_safe(name, directory) for name in {'BASH_ENV', 'ENV', 'ZDOTDIR'})) and
                    not any(name.startswith('BASH_FUNC_') for name in os.environ)):
                return False
            if re.fullmatch(r'python[\d.]*', binary):
                args = _interpreter_args(binary, words[1:])
                while args and args[0] in {'-I', '-E', '-s', '-S', '-B', '-u', '-b', '-bb', '-q'}:
                    args.pop(0)
                sources = []
                retained = False
                if len(args) > 1 and args[0] == '-c':
                    if not literal_eval and re.search(r'[$`*?\[\]{}~]', args[1]):
                        proof_failure = 'python: inline source not literal'
                        return True
                    sources = [args[1]]
                elif not args or args[0] == '-':
                    sources = list(stdin_sources)
                elif args[:2] == ['-m', 'unittest'] and directory is not None:
                    retained = True
                    # Keep discovery's existing scan scope; on-disk test import
                    # coverage is a separate rule. A local unittest shadows stdlib.
                    if any((directory / name).exists() or directory / name in written
                           for name in ('unittest.py', 'unittest/__init__.py')):
                        return True
                    candidates = module_candidates(args[1:], directory)
                    sources = [written[path][0] for candidate in candidates
                               if (path := _literal_path(candidate, directory)) in written]
                    if any(_literal_path(candidate, directory) in invalidated_written for candidate in candidates):
                        return True
                elif not args[0].startswith('-'):
                    retained = True
                    opaque = invocation_written.get((directory, args[0]))
                    if opaque is not None and args[0] in invocation_quoted and not unsafe_bindings:
                        return not all(heredoc_preserves_sources(source, directory, True, args[1:]) for source in opaque)
                    for candidate in script_variants(args[0]):
                        path = _literal_path(candidate, directory)
                        if path not in written or path in invalidated_written or LIVE.search(str(path)):
                            return True
                        sources.append(written[path][0])
                        try:
                            info = path.stat()
                            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_SOURCE_BYTES:
                                return True
                            with path.open('rb') as handle:
                                opened = os.fstat(handle.fileno())
                                if not stat.S_ISREG(opened.st_mode) or opened.st_size > MAX_SOURCE_BYTES:
                                    return True
                                contents = handle.read(MAX_SOURCE_BYTES + 1)
                            if len(contents) > MAX_SOURCE_BYTES:
                                return True
                            sources.append(contents.decode('utf-8', errors='replace'))
                        except FileNotFoundError:
                            pass
                        except OSError:
                            return True
                if sources and all(python_preserves_sources(source, directory) or
                                   retained and heredoc_preserves_sources(source, directory, True,
                                                                         args[1:] if args and not args[0].startswith('-') else None)
                                   for source in sources):
                    return False
            elif binary in {'node', 'bun'}:
                inline = node_inline_sources(words, directory, stdin_sources, literal_eval=literal_eval)
                if inline:
                    return not all(node_inline_preserves_sources(source, directory) for source in inline)
                args = _interpreter_args(binary, words[1:])
                test_mode = False
                if binary == 'node':
                    args, inputs, test_mode, runtime_options = _node_arguments(words[1:])
                    if inputs or runtime_options or any(arg.startswith('-') and arg != '--test' for arg in args):
                        return True
                    args = [arg for arg in args if arg != '--test']
                elif args[:1] == ['test']:
                    test_mode, args = True, args[1:]
                if args[:1] == ['run']:
                    args = args[1:]
                if args and not args[0].startswith('-'):
                    if test_mode:
                        candidates = [_literal_path(candidate, directory) for arg in args for candidate in script_variants(arg)]
                        return not (candidates and all(path in written and path not in invalidated_written and written[path][1] and
                                                       heredoc_preserves_sources(written[path][0], directory, False) for path in candidates))
                    opaque = invocation_written.get((directory, args[0]))
                    if opaque is not None and args[0] in invocation_quoted and not unsafe_bindings:
                        return not all(heredoc_preserves_sources(source, directory, False) for source in opaque)
                    candidates = [_literal_path(candidate, directory) for candidate in script_variants(args[0])]
                    if candidates and all(path in written and path not in invalidated_written and written[path][1] and
                                          heredoc_preserves_sources(written[path][0], directory, False) for path in candidates):
                        return False
            return True
        if binary == 'print':
            return not output_only_print(words)
        return binary not in {'cat', 'tee', 'mkdir', 'chmod', 'set', 'head', 'tail', 'echo', 'printf', 'true', 'false', ':', 'test', '[', 'ls', 'stat', 'wc', 'pwd'}

    def node_inline_sources(words, directory, stdin_sources, *, literal_eval=False):
        nonlocal proof_failure
        if not words or os.path.basename(words[0]) != 'node':
            return []
        # Shell bindings retain possible transient/conditional values, so an
        # empty local assignment cannot erase an inherited startup hook here.
        if os.environ.get('NODE_OPTIONS') or 'NODE_OPTIONS' in shell_values:
            proof_failure = 'node: NODE_OPTIONS startup proof failed'
            return []
        proof_failure = 'node: inline runtime options or arguments unproved'
        # Literal source describes this invocation only if the resolved Node
        # toolchain is trusted and no earlier write can have replaced it.
        if not preservation_tool(words, directory):
            return []
        # _node_arguments removes options for operand discovery, including
        # --run. That is not evidence that the literal eval body runs alone.
        # Accept only modes whose complete argv leaves startup and outputs
        # unchanged; options after the body must face the same restriction.
        args = words[1:]
        while args:
            if args[0] in {'--no-warnings', '--input-type=module', '--input-type=commonjs'}:
                args = args[1:]
            elif len(args) > 1 and args[0] == '--input-type' and args[1] in {'module', 'commonjs'}:
                args = args[2:]
            else:
                break
        if len(args) == 2 and args[0] in {'-e', '--eval', '-p', '--print'}:
            source = args[1]
            if literal_eval or not re.search(r'[$`*?\[\]{}~]', source):
                return [source]
            proof_failure = 'node: inline source not literal'
            return []
        return list(stdin_sources) if args in ([], ['-']) else []

    def node_inline_preserves_sources(source, directory, depth=0):
        nonlocal proof_failure
        proof_failure = 'node: inline operation or import proof failed'
        if depth > MAX_SHELL_DEPTH or len(source) > MAX_SOURCE_BYTES:
            return False
        # Reuse the retained-source grammar for the program around imports.
        # Each accepted data module is decoded and faces the same proof; local
        # and computed specifiers cannot justify ignoring remembered scripts.
        literal = r'''(?:"[^"\\\n]*"|'[^'\\\n]*')'''
        pattern = r'\b(?:await\s+)?import\s*(?:\(\s*(' + literal + r')\s*\)|(' + literal + r'))\s*;?'
        for match in list(re.finditer(pattern, source)):
            specifier = (match[1] or match[2])[1:-1]
            if not specifier.startswith('data:text/javascript,') and not specifier.startswith('data:text/javascript;base64,'):
                proof_failure = 'node: local or unsupported inline import'
                return False
            header, _, payload = specifier.partition(',')
            try:
                decoded = (base64.b64decode(payload, validate=True).decode('utf-8') if header.endswith(';base64') else unquote(payload))
            except (ValueError, UnicodeError):
                proof_failure = 'node: data import decoding failed'
                return False
            check_source(decoded, directory, False, 'live-database-read')
            if not node_inline_preserves_sources(decoded, directory, depth + 1):
                return False
        remaining = re.sub(pattern, '', source)
        if re.search(r'\b(?:import|require)\b', remaining):
            proof_failure = 'node: computed or unsupported inline import'
            return False
        return heredoc_preserves_sources(remaining, directory, False)

    def heredoc_preserves_sources(source, directory, python, script_args=None):
        # This proof is only for bodies retained from this batch. Arbitrary
        # on-disk programs still invalidate every source, even if DB-safe.
        if not python:
            # A skipped test with an empty callback cannot change a source.
            # Match the complete program; extra imports, hooks and callbacks
            # must keep the ordinary invalidation behavior.
            string = r"'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\""
            skipped = (r"\s*import\s+([A-Za-z_$][\w$]*)\s+from\s+(['\"])node:test\2\s*;\s*" +
                       r"\1\.skip\(\s*(?:" + string + r")\s*,\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)\s*;?\s*")
            if re.fullmatch(skipped, source):
                return True
            # A small read-only JS grammar; unsupported expressions fail closed.
            source = re.sub(r"import\s*\{\s*readFileSync\s*\}\s*from\s*(['\"])node:fs\1\s*;", '', source)
            strings = r"'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\""
            source = re.sub(strings, 'guardString', source)
            return (not re.search(r'[^\w\s.,;:(){}\[\]=]', source) and
                    not re.search(r'\[(?!\s*\d+\s*\])|\b(?:function|class|this|globalThis)\b', source) and
                    not re.search(r'\bconst\s+(?:readFileSync|trim|split|map|process|console|JSON)\s*=', source) and
                    not re.search(r'\b(?:import|require|eval|Function|new|delete|await)\b', source) and
                    all(name in {'argv', 'trim', 'split', 'map', 'log', 'stringify', 'parse', 'length'}
                        for name in re.findall(r'\.\s*(\w+)', source)) and
                    '=' not in re.sub(r'\bconst\s+[A-Za-z_]\w*\s*=', '', source) and
                    all(name.lstrip('.') in {'readFileSync', 'trim', 'split', 'map', 'console.log', 'JSON.stringify'}
                        for name in re.findall(r'([\w.]+)\s*\(', source)) and
                    not re.search(r'(?:\]|\))\s*\(|(?:process|console|JSON)\s*[.\[][^;\n]*=', source))
        try:
            tree = ast.parse(source)
        except (SyntaxError, ValueError):
            return False
        # The older proof already handles literal data edits and a restricted
        # read-only helper grammar. Add only the JSON/HTTP readback grammar
        # here, never a denylist of Python writers: unknown code can write too.
        if any(type(node).__name__ == 'Match' for node in ast.walk(tree)):
            return False
        modules = {'json', 'sys', 'pathlib', 'urllib.request', 'unittest', 'tempfile'}
        calls = {'print', 'len', 'dict', 'list', 'tuple', 'str', 'int', 'bool',
                 'json.load', 'json.loads', 'json.dumps', 'pathlib.Path', 'pathlib.Path.read_text',
                 'urllib.request.urlopen', 'tempfile.TemporaryDirectory', 'unittest.main',
                 'self.assertTrue', 'self.assertFalse', 'self.assertEqual', 'self.assertIsNone'}
        aliases, values = {}, {}
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                if any(item.name not in modules for item in node.names):
                    return False
                aliases.update((item.asname or item.name.split('.')[0], item.name if item.asname else item.name.split('.')[0]) for item in node.names)
            elif isinstance(node, ast.ImportFrom):
                if (node.level or node.module not in modules or
                        any((node.module + '.' + item.name) not in calls for item in node.names)):
                    return False
                aliases.update((item.asname or item.name, (node.module or '') + '.' + item.name) for item in node.names)
        def qualified(node):
            if isinstance(node, ast.Name):
                return aliases.get(node.id, node.id)
            if isinstance(node, ast.Attribute):
                return qualified(node.value) + '.' + node.attr
            if isinstance(node, ast.Call) and qualified(node.func) == 'pathlib.Path':
                return 'pathlib.Path'
            return ''
        test_nodes = set()
        for node in tree.body:
            if isinstance(node, ast.ClassDef):
                if (node.decorator_list or node.keywords or len(node.bases) != 1 or qualified(node.bases[0]) != 'unittest.TestCase' or
                        any(not isinstance(member, ast.FunctionDef) for member in node.body)):
                    return False
                test_nodes.add(node)
                for method in node.body:
                    if (not method.name.startswith('test_') or method.decorator_list or method.returns or
                            len(method.args.args) != 1 or method.args.args[0].arg != 'self' or method.args.posonlyargs or
                            method.args.kwonlyargs or method.args.vararg or method.args.kwarg or method.args.defaults):
                        return False
                    test_nodes.add(method)
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node not in test_nodes:
                return False
            if isinstance(node, (ast.AsyncFunctionDef, ast.Lambda, ast.AnnAssign, ast.NamedExpr, ast.AugAssign, ast.Delete)):
                return False
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
                if node.id in aliases or node.id in calls or node.id in values or node.id == 'self':
                    return False
                values[node.id] = True
            if isinstance(node, (ast.Attribute, ast.Subscript)) and isinstance(node.ctx, ast.Store):
                return False
            if isinstance(node, ast.Attribute) and node.attr.startswith('__'):
                return False
            if isinstance(node, ast.Call) and qualified(node.func) not in calls:
                return False
            if isinstance(node, ast.Call) and any(k.arg not in {'encoding', 'errors', 'indent', 'sort_keys'} for k in node.keywords):
                return False
            if isinstance(node, ast.Call) and qualified(node.func) == 'unittest.main':
                # TestProgram can import a selected module, loader, or tests
                # selected by CLI discovery. Only a plain current-module call
                # with no script arguments preserves the checked source.
                if (script_args is None or script_args or node.keywords or len(node.args) > 1 or
                        node.args and (not isinstance(node.args[0], ast.Constant) or node.args[0].value != '__main__')):
                    return False
            if isinstance(node, ast.Call) and qualified(node.func) == 'urllib.request.urlopen':
                # A caller-supplied Request or URL can invoke arbitrary handlers.
                # A literal HTTP(S) GET leaves file destinations out of the API.
                if (len(node.args) != 1 or node.keywords or not isinstance(node.args[0], ast.Constant) or
                        not isinstance(node.args[0].value, str) or not node.args[0].value.startswith(('http://', 'https://'))):
                    return False
        return True

    def module_candidates(args, directory):
        module = args[0].replace('.', '/') + '.py'
        candidates = [module] + [arg if arg.endswith('.py') else arg.replace('.', '/') + '.py' for arg in args[1:] if not arg.startswith('-')]
        candidates += [candidate[:-3] + '/__main__.py' for candidate in candidates]
        candidates += [str(parent / '__init__.py') for candidate in candidates for parent in Path(candidate).parents if parent != Path('.')]
        if args[0] == 'unittest' and 'discover' in args:
            start, pattern = '.', 'test*.py'
            for i, arg in enumerate(args):
                if arg in {'-s', '--start-directory'} and i + 1 < len(args):
                    start = args[i + 1]
                elif arg in {'-p', '--pattern'} and i + 1 < len(args):
                    pattern = args[i + 1]
            start_path = _literal_path(start, directory)
            if start_path is None:
                raise AmbiguousScript('non-literal unittest discovery directory ' + _token(start))
            candidates += [str(path) for path in written if path.is_relative_to(start_path) and (path.match(pattern) or path.name == '__init__.py')]
        return candidates

    def script_variants(value, *, literal=None, bindings=None):
        if (value in invocation_literals if literal is None else literal) or unsafe_bindings:
            return {value}
        bindings = script_values if bindings is None else bindings
        candidates, end = {''}, 0
        for match in re.finditer(r"\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)", value):
            name = match[1] or match[2]
            expanded = set()
            for candidate in candidates:
                for replacement in bindings.get(name, {match[0]}):
                    expanded.add(candidate + value[end:match.start()] + replacement)
                    if len(expanded) > MAX_SCRIPTS:
                        raise AmbiguousScript("too many variable script paths")
            candidates = expanded
            end = match.end()
        return {candidate + value[end:] for candidate in candidates}

    def invalidate_variable(name):
        fresh_variables.discard(name)
        marker_variables.discard(name)
        populated_paths.difference_update(key for key in tuple(populated_paths) if key[1] == name)
        copied_opaque.difference_update(item for item in tuple(copied_opaque) if item[1] == name)
        reference = re.compile(r"\$\{" + re.escape(name) + r"\}|\$" + re.escape(name) + r"(?!\w)")
        for key in list(opaque_written):
            if reference.search(key[1]):
                del opaque_written[key]

    def expand(value, overrides=None):
        values = shell_values if overrides is None else {**shell_values, **overrides}
        return re.sub(r"\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)",
                      lambda match: values.get(match[1] or match[2], match[0]), value)

    def variants(words):
        yield [expand(word) for word in words]
        for name, values in path_values.items():
            reference = re.compile(r"\$\{" + re.escape(name) + r"\}|\$" + re.escape(name) + r"(?!\w)")
            if any(reference.search(word) for word in words):
                for value in values:
                    yield [expand(word, {name: value}) for word in words]

    def remember_assignment(word, directory, track_scripts=True, transient=False):
        nonlocal unsafe_bindings, unsafe_binding_cause
        name, _, value = word.partition("=")
        if track_scripts:
            if startup_binding(name.removesuffix('+')):
                unsafe_bindings = True
                label = name if name in {'PATH', 'IFS', 'ENV', 'BASH_ENV', 'BASHOPTS', 'SHELLOPTS', 'ZDOTDIR'} else 'startup binding'
                unsafe_binding_cause = f'{label} assignment at line {current_line}'
            previous = name in script_values
            invalidate_variable(name)
            resolved_path = None
            if not uncertain_write and not transient and word not in invocation_literals and value.startswith('$(cat ') and value.endswith(')'):
                try:
                    reader = shlex.split(value[2:-1])
                    source_path = _literal_path(reader[1], directory) if len(reader) == 2 and reader[0] == 'cat' else None
                    if source_path is not None and not re.search(r'\.robob/userdata|robob-data|\.t3/userdata|\.local/share/opencode|opencode-data', str(source_path)):
                        # This is a bounded read of a path marker, never a DB.
                        # A second filename mention, even in code or an alias
                        # binding, or an earlier opaque writer voids the read.
                        remainder = command.replace(value, '', 1)
                        mentioned = source_path.name in remainder or None in tool_changes
                        lexer = shlex.shlex(remainder, posix=True, punctuation_chars=';&|()<>')
                        lexer.whitespace_split = True
                        for token in lexer:
                            alias = token.partition('=')[2] if re.match(r'^[A-Za-z_]\w*=', token) else token
                            if _literal_path(expand(alias, {'PWD': str(directory)}), directory) == source_path:
                                mentioned = True
                        info = source_path.stat()
                        # Multiple hard links give writers an unmentioned name
                        # for this marker. Keep those files out of this proof.
                        if not mentioned and stat.S_ISREG(info.st_mode) and info.st_size <= 8192 and info.st_nlink == 1:
                            with source_path.open('rb') as handle:
                                opened = os.fstat(handle.fileno())
                                if not stat.S_ISREG(opened.st_mode) or opened.st_size > 8192 or opened.st_nlink != 1:
                                    raise ValueError('unbounded or aliased path marker')
                                raw = handle.read(8193)
                            text = raw.decode('utf-8')
                            if os.path.isabs(text) and not re.search(r'[$`*?\[~\r\n]', text) and not re.search(r'\.robob/userdata|robob-data|\.t3/userdata|\.local/share/opencode|opencode-data', text):
                                resolved_path = text
                except (OSError, ValueError, UnicodeError):
                    pass
            if resolved_path is not None:
                marker_variables.add(name)
            candidates = {resolved_path, ''} if resolved_path is not None else {value} if word in invocation_literals else script_variants(value)
            script_values[name] = candidates | script_values.get(name, {"$" + name}) if uncertain_write or transient else candidates
            if not uncertain_write and not transient and _fresh_mktemp(value):
                fresh_variables.add(name)
                binding_causes.pop(name, None)
            else:
                reason = ('conditional or transient binding' if uncertain_write or transient else
                          'mktemp template under a protected directory or containing ..' if '$(mktemp' in value and re.search(r'\.\.|\.robob/userdata|robob-data|\.t3/userdata|\.local/share/opencode|opencode-data', value) else
                          'unsupported mktemp options/template' if '$(mktemp' in value else
                          'read the path first, then use it literally' if value.startswith('$(cat ') else
                          'reassigned binding' if previous else 'unproved variable binding')
                binding_causes[name] = f'{reason} at line {current_line}'
        candidates = [value] if word in invocation_reader_literals else [values[0] for values in variants([value])]
        shell_values[name] = value if word in invocation_reader_literals else expand(value)
        for candidate in candidates:
            path = _literal_path(candidate, directory)
            if LIVE.search(candidate) or re.search(r"\.robob|robob-data|\.local/share/opencode|opencode-data", candidate):
                path_values.setdefault(name, set()).add(candidate)
            if LIVE.search(candidate) or path is not None and LIVE.search(str(path)):
                # Branches and env prefixes may not execute; retain possible
                # bindings rather than letting a later assignment erase them.
                live_assignments.add(str(path) if path is not None else candidate)

    def check_source(source, directory, python=False, rule="live-database-script", shell=False, test_target=None, location=None):
        # Config/foreign operand discounts cannot supply fixture evidence.
        checked = _js_fixture_source(source) if test_target is not None and not python and not shell else source
        if any(_source_hit(checked, candidate, python, shell) for candidate in reader_directories(directory)):
            match = _database_reference(source)
            line = source.count("\n", 0, match.start()) + 1 if match else 1
            detail = (f"{location or '<inline script>'}:{line} names {_token(match[0])}." if match else
                      f"{location or '<inline script>'}:{line} contains a protected database read.")
            if test_target is not None and match:
                runners = {m[2] for m in re.finditer(r"\bimport\s+(?:[^;'\"]*\bfrom\s*)?(['\"])(node:test|vitest|vite-plus/test)\1", source)}
                if 'node:test' not in runners and runners & {'vitest', 'vite-plus/test'}:
                    detail += f"\nRun tests through the repo runner: vp test run {shlex.quote(test_target)}."
            raise LiveRead(rule, detail)

    def migration_source(args, directory):
        source = None
        source_operand = None
        source_directory = None
        destination = None

        def migration_path(value, flag):
            if value == '-' or re.search(r'[$`*?\[\]]', value) or not os.path.isabs(value) and directory is None:
                raise AmbiguousScript("non-literal migrate-dev-db " + flag + ' ' + _token(value))
            # Node uses a physical process.cwd(), then path.resolve normalizes
            # operand dot segments before following links within the operand.
            operand = Path(os.path.abspath(value if os.path.isabs(value) else Path(os.path.realpath(directory)) / value))
            resolved = _literal_path(str(operand), directory)
            if resolved is None:
                raise AmbiguousScript("non-literal migrate-dev-db " + flag + ' ' + _token(value))
            return operand, resolved

        index = 0
        while index < len(args):
            flag, equal, value = args[index].partition("=")
            if flag not in {"--source", "--base-dir", "--projects", "--threads-per-project"}:
                raise AmbiguousScript("unrecognized migrate-dev-db argument " + _token(args[index]))
            if not equal:
                index += 1
                value = args[index] if index < len(args) else ""
            if not value or value.startswith("--"):
                raise AmbiguousScript("missing migrate-dev-db argument " + _token(flag))
            if value.startswith(('~', '$')):
                if direct_read(['cat', value], directory):
                    raise LiveRead("live-database-read")
                raise AmbiguousScript("use literal migrate-dev-db paths without home or variable expansion " + _token(value))
            if flag == "--source":
                if source is not None:
                    raise AmbiguousScript("duplicate migrate-dev-db --source")
                source_operand, source = migration_path(value, flag)
                # The migrator resolves the spelling of --source, rather than
                # its realpath, before deriving its history siblings.
                source_directory = source_operand.parent
            elif flag == "--base-dir":
                _, destination = migration_path(value, flag)
                if direct_read(['cat', str(destination / 'userdata/statev2.sqlite')], directory):
                    raise LiveRead("live-database-read")
            index += 1
        # Its default is HOME/.t3/userdata/statev2.sqlite, a protected database.
        if source is None or LIVE.search(str(source)):
            raise LiveRead("live-database-read")
        if destination is None:
            raise AmbiguousScript("migrate-dev-db needs an explicit isolated --base-dir")

        def live_history_path(path):
            resolved = os.path.realpath(path)
            return (LIVE.search(resolved) or
                    re.search(r'(?:\.robob|robob-data)/userdata(?:/|$)|(?:\.local/share/opencode|opencode-data)(?:/|$)', resolved) or
                    resolved.startswith(str(Path.home() / '.t3/userdata') + os.sep))

        if live_history_path(source):
            raise LiveRead("live-database-read")
        # Check every possible history binding without opening the source DB.
        # A sibling symlink or hard link must not turn an isolated copy into a
        # read of a live file before the migrator's identity check runs.
        candidates = [source_operand, source_directory / 'archive.sqlite']
        try:
            with os.scandir(source_directory) as entries:
                for entry in entries:
                    if re.fullmatch(r'statev2\.pre-shrink-[^/\\]+\.sqlite', entry.name):
                        candidates.append(Path(entry.path))
                        if len(candidates) > MAX_SCRIPTS:
                            raise AmbiguousScript("too many migrate-dev-db history siblings to prove isolation")
        except FileNotFoundError:
            pass
        except OSError:
            raise AmbiguousScript("cannot inspect migrate-dev-db history siblings") from None
        # SQLite may access sidecars through either spelling of a symlinked DB.
        inputs = {(Path(str(spelling) + suffix), primary == source_operand, suffix)
                  for primary in candidates for spelling in (primary, Path(os.path.realpath(primary)))
                  for suffix in ('', '-wal', '-shm', '-journal')}
        protected_identities = None
        for candidate, source_input, suffix in inputs:
            if live_history_path(candidate):
                raise LiveRead("live-database-read")
            try:
                info = candidate.stat()
            except FileNotFoundError:
                continue
            except OSError:
                raise AmbiguousScript("cannot prove migrate-dev-db input is isolated " + _token(str(candidate))) from None
            if not stat.S_ISREG(info.st_mode):
                raise AmbiguousScript("migrate-dev-db input needs an isolated regular copy " + _token(str(candidate)))
            if info.st_nlink != 1 and not source_input:
                raise AmbiguousScript("migrate-dev-db history input needs an isolated regular copy " + _token(str(candidate)))
            # Closed backups may be supplied through a neutral hard link.
            # Compare every input against live identities: a plain symlink
            # can reach a neutral physical target without increasing st_nlink.
            if protected_identities is None:
                databases = protected_databases()
                roots = {database.parent for database in databases}
                roots.update(Path.home() / relative for relative in ('.robob/userdata', '.t3/userdata', '.local/share/opencode'))
                roots.update(root / 'readonly' for root in tuple(roots))
                live_files = {Path(str(database) + ending) for database in databases
                              for ending in ('', '-wal', '-shm', '-journal')}
                try:
                    for root in roots:
                        try:
                            with os.scandir(root) as entries:
                                for entry in entries:
                                    match = re.fullmatch(r'(statev2\.sqlite|state\.sqlite|opencode\.db|archive\.sqlite|statev2\.pre-shrink-[^/\\]+\.sqlite)(?:-(?:wal|shm|journal))?', entry.name)
                                    if match:
                                        primary = root / match[1]
                                        # SQLite may use sidecars beside either
                                        # spelling of a symlinked live database.
                                        live_files.update(Path(str(spelling) + ending)
                                                          for spelling in (primary, Path(os.path.realpath(primary)))
                                                          for ending in ('', '-wal', '-shm', '-journal'))
                                        if len(live_files) > MAX_SCRIPTS * 4:
                                            raise AmbiguousScript("too many live history files to prove hard-linked migrate-dev-db source is isolated")
                        except FileNotFoundError:
                            pass
                    protected_identities = set()
                    for live in live_files:
                        try:
                            live_info = live.stat()
                        except FileNotFoundError:
                            continue
                        protected_identities.add((live_info.st_dev, live_info.st_ino))
                except OSError:
                    raise AmbiguousScript("cannot prove hard-linked migrate-dev-db source is isolated") from None
            if (info.st_dev, info.st_ino) in protected_identities:
                raise LiveRead("live-database-read")

    def migration_context(words):
        # A preceding edit or link can invalidate both the source proof and
        # realpath before execution. Keep this exception to one plain call.
        try:
            plain = shlex.split(command, comments=True)
        except ValueError:
            plain = []
        if (plain != words or os.environ.get('NODE_OPTIONS') or
                '\\\n' in command or '\\\r\n' in command):
            raise AmbiguousScript("run migrate-dev-db alone without runtime options; split preparation into a separate call")

    def script_path(value, directory, binary):
        path = _literal_path(value, directory)
        if path is None:
            cause = path_refusal(value, directory, binary) or (f"relative script {_token(value)} after {unknown_cause}" if directory is None and not os.path.isabs(value)
                     else f"non-literal script path {_token(value)} ({binary})")
            raise AmbiguousScript(cause)
        return path

    def add(value, directory, binary="script", migration_args=None, test_target=None):
        if (value not in invocation_quoted and value not in inherited_quoted and
                any((a or b) in marker_variables for a, b in re.findall(r'\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)', value))):
            raise AmbiguousScript(path_refusal(value, directory, binary))
        inline = re.fullmatch(r'(\$\(mktemp -d(?: [^;&|()`\n]*)?\))/([^$`*?\[\]{}]+)', value)
        if (not unsafe_bindings and (value in invocation_quoted and value not in invocation_literals or value in inherited_empty) and
                inline and _fresh_mktemp(inline[1]) and '..' not in Path(inline[2]).parts and not Path(inline[2]).is_absolute()):
            # This substitution is in the invocation itself, so its directory
            # is still empty. A variable expanded to the same text is not fresh.
            add_literal('/' + inline[2], directory, binary)
            return
        if binary == 'node' and test_target is not None and any(char in value for char in '*?['):
            if value in invocation_glob_escaped:
                raise AmbiguousScript(f"node --test glob {_token(value)} has unsupported backslash expansion")
            if directory is None:
                raise AmbiguousScript(f"node --test glob {_token(value)} after {unknown_cause}")
            matches = _node_test_glob_matches(value, directory)
            pattern = str(Path.home()) + value[1:] if value.startswith('~/') else value
            prefix = os.path.dirname(re.split(r'[*?\[]', pattern, maxsplit=1)[0]) or '.'
            lexical_prefix = Path(os.path.abspath(directory / prefix))
            prefix = Path(os.path.realpath(lexical_prefix))
            # A changed ancestor may redirect a prefix through a new symlink.
            changed = glob_writes | set(written) | set(invalidated_written) | variable_written
            if copied_opaque or any(path is None or any(path == base or path.is_relative_to(base) or base.is_relative_to(path) for base in (prefix, lexical_prefix)) or
                                    any(match == path or match.is_relative_to(path) for match in matches) for path in changed):
                raise AmbiguousScript(f"node --test glob {_token(value)}: glob test files are written in the same call; list them literally")
            for path in matches:
                add_literal(str(path), directory, binary, test_target=value, resolved_path=path)
            return
        if binary == 'node' and test_target is not None and any(char in value for char in '{}'):
            raise AmbiguousScript(f"node --test glob {_token(value)} has unsupported brace expansion")
        for candidate in script_variants(value):
            if candidate != value and (candidate.startswith(('-', '+', '~')) or
                                       any(char in candidate for char in '\\\r\n') or
                                       re.search(r'\s', candidate) and value not in invocation_quoted):
                raise AmbiguousScript(path_refusal(value, directory, binary) or f"non-literal script path {_token(value)} ({binary})")
            if _literal_path(candidate, directory) is None:
                body = invocation_written.get((directory, value)) if (value in invocation_quoted or value in inherited_quoted) and not unsafe_bindings else None
                if body is None:
                    copied = copied_source(opaque_key(value, directory))
                    if copied is not None:
                        raise AmbiguousScript(path_refusal(value, directory, binary, writer_causes.get(copied, 'unchecked copy at script path')))
                    detail = path_refusal(value, directory, binary)
                    if detail:
                        raise AmbiguousScript(detail)
                    script_path(candidate, directory, binary)
                # Repeated bindings in a combined AST must not hide a read
                # that was visible in one of its appended source fragments.
                for fragment in (*body, ''.join(body)):
                    check_source(fragment, directory, value.endswith(".py"))
                require_direct_startup(''.join(body), directory, binary)
                if invocation_startup_failure:
                    cause = path_refusal(value, directory, binary)
                    if ' at line ' not in cause:
                        cause = path_refusal(value, directory, binary, invocation_startup_failure)
                    raise AmbiguousScript(cause)
                # A failed mktemp can skip a guarded writer and leave an empty
                # root. Inspect that fallback as well as the fresh-root body.
                fallback = re.sub(r'\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)',
                                  lambda match: '' if (match[1] or match[2]) in invocation_fresh else match[0], value)
                if fallback != value:
                    for failure in script_variants(fallback):
                        if _literal_path(failure, directory) is not None:
                            add_literal(failure, directory, binary)
            else:
                add_literal(candidate, directory, binary, migration_args, test_target)

    def check_budget():
        if len(script_files) > MAX_SCRIPTS:
            raise AmbiguousScript(f"more than MAX_SCRIPTS ({MAX_SCRIPTS}) script invocations")
        if len(node_test_files) > NODE_TEST_MAX_FILES:
            raise AmbiguousScript(f"node --test lists {len(node_test_files)} test files in one call (limit {NODE_TEST_MAX_FILES}); split them or run npm test")

    def add_literal(value, directory, binary="script", migration_args=None, test_target=None, resolved_path=None):
        path = resolved_path if resolved_path is not None else script_path(value, directory, binary)
        (node_test_files if binary == 'node' and test_target is not None else script_files).add(path)
        check_budget()
        if LIVE.search(str(path)) or LIVE.search(os.path.realpath(path)):
            raise LiveRead("live-database-script", f"{path}:1 is a protected live database.")
        if path in invalidated_written:
            # A known live source still gets its precise refusal. Otherwise
            # on-disk bytes cannot prove what an intervening writer will run.
            if path in written:
                check_source(written[path][0], directory, path.suffix == '.py')
            try:
                info = path.stat()
                if stat.S_ISREG(info.st_mode) and info.st_size <= MAX_SOURCE_BYTES:
                    with path.open('rb') as handle:
                        opened = os.fstat(handle.fileno())
                        if stat.S_ISREG(opened.st_mode) and opened.st_size <= MAX_SOURCE_BYTES:
                            source = handle.read(MAX_SOURCE_BYTES + 1)
                            if len(source) <= MAX_SOURCE_BYTES:
                                check_source(source.decode('utf-8', errors='replace'), directory, path.suffix == '.py', location=path)
            except OSError:
                pass
            # Audit rows retain 240 characters. Put both proof sites before a
            # potentially long script path so truncation keeps the diagnosis.
            raise AmbiguousScript("script source changed after its heredoc write; " + invalidated_written[path] +
                                  f'; execution {execution_site}: {execution_binary} at line {current_line}; ' + _token(value))
        if path not in paths:
            paths.append(path)
        try:
            proof_command = command if caller_command is None else caller_command
            redirect = re.search(r'\s+>\s+([^\s;&|<>$`]+)\s+2>&1\s*$', proof_command)
            destination = shlex.split(redirect[1]) if redirect else []
            if redirect and (len(destination) != 1 or direct_read(['cat', destination[0]], directory)):
                raise LiveRead('live-database-script', f"{path}:1 has an unsafe output redirect.")
            plain = proof_command[:redirect.start()] if redirect else proof_command
            invocation = _fixture_invocation(plain)
        except ValueError:
            invocation = []
        shell = (binary in {'bash', 'sh', 'zsh', 'dash', 'ksh'} and len(invocation) == 2 and
                 os.path.basename(invocation[0]) == binary and invocation[1] == value and
                 _trusted_fixture_tool(invocation[0], binary, directory) and
                 not value.startswith(('~', '$')) and '\\\n' not in proof_command and '\\\r\n' not in proof_command and
                 not any(name in shell_values or os.environ.get(name) and not inherited_startup_safe(name, directory, value) for name in ('BASH_ENV', 'ENV')) and
                 not any(name.startswith('BASH_FUNC_') for name in os.environ))
        if path in written:
            body, replaced = written[path]
            if path in variable_written:
                for fragment in write_history[path]:
                    check_source(fragment, directory, path.suffix == '.py')
            check_source(body, directory, path.suffix == ".py", shell=shell, test_target=test_target, location=path)
            require_direct_startup(body, directory, binary)
            if replaced:
                return
        try:
            info = path.stat()
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_SOURCE_BYTES:
                if resolved_path is not None:
                    raise AmbiguousScript(f"node --test glob {_token(test_target)} has an uncheckable file {_token(value)}")
                return
            with path.open("rb") as handle:
                opened = os.fstat(handle.fileno())
                if not stat.S_ISREG(opened.st_mode) or opened.st_size > MAX_SOURCE_BYTES:
                    if resolved_path is not None:
                        raise AmbiguousScript(f"node --test glob {_token(test_target)} has an uncheckable file {_token(value)}")
                    return
                source = handle.read(MAX_SOURCE_BYTES + 1)
            if len(source) <= MAX_SOURCE_BYTES:
                if migration_args is not None and _isolated_migration_source(source.decode('utf-8', errors='replace'), directory, path):
                    migration_source(migration_args, directory)
                    return
                decoded = source.decode("utf-8", errors="replace")
                check_source(decoded, directory, path.suffix == ".py", shell=shell, test_target=test_target, location=path)
                require_direct_startup(decoded, directory, binary)
            elif resolved_path is not None:
                raise AmbiguousScript(f"node --test glob {_token(test_target)} has an uncheckable file {_token(value)}")
        except OSError:
            if resolved_path is not None:
                raise AmbiguousScript(f"node --test glob {_token(test_target)} has an unreadable file {_token(value)}")
            pass

    def safe_mktemp_substitution(source, directory):
        # A fresh directory cannot replace a remembered script. Keep this
        # exception narrower than the shell grammar: no expansions or commands.
        if unsafe_bindings or any(name.startswith('BASH_FUNC_') for name in os.environ):
            return False
        try:
            words = shlex.split(source)
        except ValueError:
            return False
        if not words or not _fresh_mktemp('$(' + shlex.join(['mktemp', *words[1:]]) + ')'):
            return False
        return (preservation_tool(words, directory) and
                _trusted_fixture_tool(words[0], 'mktemp', directory) and unchanged_tool(words[0], directory))

    def decode_word(value, directory, depth, quoted, checked, cwd_only=False, bodies=None, preserve_mktemp=False):
        nonlocal conditional, uncertain_write, last_invalidation
        for key, literal in reversed(quoted.items()):
            if key in value and key not in checked and not key.startswith('\0guard_literal_') and literal.startswith(("${", "$(", "`")) and not cwd_only:
                checked.add(key)
                for substitution in _substitutions(literal, shell=True):
                    if preserve_mktemp and safe_mktemp_substitution(substitution, directory):
                        continue
                    conditional += 1
                    uncertain_write += 1
                    try:
                        scan(substitution, directory, depth + 1, inherited_bodies=bodies)
                        substitution_words = shlex.split(substitution)
                        if substitution_words and os.path.basename(substitution_words[0]) == 'mktemp':
                            invalidate(written, 'command substitution', substitution_words, 'mktemp: substitution form unproved')
                            opaque_written.clear()
                            fresh_variables.clear()
                            tool_changes.add(None)
                            glob_writes.add(None)
                            last_invalidation = f'command substitution at line {current_line}; mktemp: substitution form unproved'
                    finally:
                        conditional -= 1
                        uncertain_write -= 1
            value = value.replace(key, literal)
        return value

    def scan_child(source, directory, depth):
        # The shell walker cannot prove how a local reader rewrites its argument.
        if 'state.sqlite' in _strip_config_dir_db_names(source, directory) and _foreign_reader_shadowed(source):
            check_source(source, directory, rule='live-database-read')
        previous = {name: set(values) for name, values in script_values.items()}
        previous_fresh = set(fresh_variables)
        script_values.clear()
        fresh_variables.clear()
        opaque_written.clear()
        try:
            return scan(source, directory, depth)
        finally:
            script_values.clear()
            script_values.update(previous)
            fresh_variables.clear()
            fresh_variables.update(previous_fresh)
            opaque_written.clear()

    def scan_remote(source, directory, depth, input_words=(), input_bodies=None, inherit_environment=False, opaque=None, preservation=True):
        # Synced source evidence may be read remotely, but remote writes,
        # bindings and cwd cannot prove anything about the caller's files.
        # offbox may fall back to running locally, so its payload keeps the
        # caller's startup and lookup bindings (BASH_ENV, PATH, ...), and the
        # exact-invocation proof still reads the caller's whole command.
        environment = None
        if inherit_environment:
            environment = ({name: value for name, value in shell_values.items()
                            if STARTUP_ENV.fullmatch(name) or name in {'ZDOTDIR', 'PATH', 'IFS', 'NODE_OPTIONS'}},
                           unsafe_binding_cause if unsafe_bindings else False, caller_command if caller_command is not None else command)
        remote_paths = scripts_in(source, directory, _depth=depth,
                                  _sources=(written, invalidated_written, write_history, variable_written, tool_changes),
                                  _stdin=(input_words, input_bodies or {}), _environment=environment, _opaque=opaque,
                                  _preservation=_preservation and preservation,
                                  _budget=(script_files, node_test_files), _glob_writes=glob_writes,
                                  _cwd_candidates=unknown_directories)
        paths.extend(path for path in remote_paths if path not in paths)
        check_budget()

    def inspect(words, directory, depth, bodies, quoted, changed_sources, cwd_only=False, binding_preflight=False):
        nonlocal unknown_cause, invocation_written, invocation_fresh, invocation_literals, invocation_reader_literals, invocation_quoted, invocation_glob_escaped, unsafe_bindings, unsafe_binding_cause, noclobber, last_invalidation, invocation_invalidation
        nonlocal execution_site, execution_binary, proof_failure
        nonlocal invocation_startup_failure
        invocation_invalidation = last_invalidation
        invocation_startup_failure = None
        words = list(words)
        if stdin_words and not any(word in {'<<', '<<<', '<', '<>'} for word in words):
            words.extend(stdin_words)
        checked = set()
        literal_words = set()
        reader_literal_words = set()
        binding_literal_words = set()
        double_words = set()
        escaped_words = set()
        unquoted_words = set()
        # Prefix assignments are decoded before remember_assignment sees them.
        # A PATH override may therefore shadow mktemp in this very substitution.
        preserve_mktemp = not any(re.match(r'^(?:PATH|IFS|ENV|BASH_ENV|ZDOTDIR)=', word) for word in words)
        def decode(value):
            decoded = decode_word(value, directory, depth, quoted, checked, cwd_only, bodies, preserve_mktemp)
            if '\0guard_literal_escape_' in value:
                escaped_words.add(decoded)
            reader_word = value
            for key, text in reversed(quoted.items()):
                if key.startswith('\0guard_literal_double_'):
                    text = re.sub(r'\\[$`"\\\n]', '', text)
                elif key.startswith('\0guard_literal_'):
                    text = ''
                reader_word = reader_word.replace(key, text)
            if not re.search(r'[$`]', reader_word):
                reader_literal_words.add(decoded)
                if not re.search(r'[*?\[\]{}~]', value):
                    binding_literal_words.add(value)
            if any(key in value and key.startswith('\0guard_literal_') and re.search(r'[$`]', text)
                   for key, text in quoted.items()):
                literal_words.add(decoded)
            if '\0guard_double_' in value and not re.search(r'[$`]', value) and '\0guard_quoted_' not in value:
                double_words.add(decoded)
            else:
                unquoted_words.add(decoded)
            return decoded
        documents, document_keys, redirects, exact_documents, here_strings = [], [], [], True, []
        index = 0
        while index < len(words):
            if words[index] in {"<<", "<<<", ">", ">>", "<", ">|", "&>", "&>>", "<>", ">&", "<&"} and index + 1 < len(words):
                op, value = words[index:index + 2]
                if not cwd_only and '>' in op and value.startswith('!'):
                    # zsh's force-clobber suffix is outside this redirect
                    # grammar; it must not look like a harmless filename.
                    glob_writes.add(None)
                if op == '<<<':
                    text = decode(value) + '\n'
                    literal = '\0guard_literal_' in value and not re.search(r'[$`]', value) and '\0guard_double_' not in value and '\0guard_quoted_' not in value
                    here_strings.append((text, literal or not any(char in text for char in '$`')))
                elif op == "<<" and value in bodies:
                    document_keys.append(value)
                    body, heredoc_quoted = bodies[value]
                    exact_documents &= heredoc_quoted or not any(char in body for char in '$`\\')
                    if not heredoc_quoted:
                        for substitution in _substitutions(body):
                            scan(substitution, directory, depth + 1)
                    documents.append(body)
                else:
                    target = decode(value)
                    redirects.append((op, target))
                    if op == '<>':
                        # It opens stdin for reading as well as writing. Keep
                        # the existing input-source checks for that operand.
                        redirects.append(('<', target))
                del words[index:index + 2]
            else:
                index += 1
        if not cwd_only:
            # Redirects run even for an empty command or an early-returning
            # builtin. Keep their destinations before unwrapping changes cwd.
            for op, target in redirects:
                if '>' in op and not (op == '>&' and re.fullmatch(r'\d+|-', target)):
                    remember_glob_write(target, directory)
                if op == '<>' and any(direct_read(['cat', *values], directory) for values in variants([target])):
                    raise LiveRead('live-database-read')
            if any(word in {'>', '>>', '>|', '&>', '&>>', '<>', '>&'} for word in words):
                glob_writes.add(None)
        raw_words = list(words)
        words = [decode(word) for word in words]
        invocation_literals = literal_words
        invocation_reader_literals = reader_literal_words
        invocation_quoted = double_words - unquoted_words
        invocation_glob_escaped = escaped_words

        def caller_argv(count):
            # Prefix unwrapping only removes words from the front. Preserve
            # literal quote segments until caller expansions are complete.
            # Reader candidates do not enumerate every loop iteration's cwd.
            # Keep script paths unresolved even when those candidates are safe.
            pwd_values = ({str(directory)} if directory is not None else
                          {'$PWD', *(str(candidate) for candidate in unknown_directories)})
            bindings = {'HOME': {str(Path.home())}, **({'PWD': pwd_values} if pwd_values else {}),
                        **{name: set(values) for name, values in script_values.items()}}
            # Reader evidence survives declarations that invalidate script
            # proofs. Keep an unknown alternative rather than trusting it.
            for name, value in shell_values.items():
                if name in script_values:
                    bindings[name].update(path_values.get(name, ()))
                elif name != 'HOME' or value != str(Path.home()) or name in path_values:
                    bindings[name] = {'$' + name, value, *path_values.get(name, ())}
            arguments = [[]]
            variable = r'\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)'
            markers = dict(quoted)

            def double_text(text):
                parts, index = [], 0
                while index < len(text):
                    char = text[index]
                    if char == '\\' and index + 1 < len(text) and text[index + 1] in '$`"\\\n':
                        index += 1
                        char = text[index]
                        if char in '$`':
                            marker = f'\0guard_literal_remote_{len(markers)}__'
                            markers[marker] = char
                            char = marker
                        elif char == '\n':
                            char = ''
                    parts.append(char)
                    index += 1
                return ''.join(parts)

            def resolve(text, quoted_context=False):
                pieces, end = [], 0
                for match in re.finditer(r'\0guard_(?:quoted|double|literal(?:_double|_remote|_escape)?)_\d+__', text):
                    pieces.append((text[end:match.start()], None))
                    pieces.append((match[0], markers[match[0]]))
                    end = match.end()
                pieces.append((text[end:], None))
                result = {''}
                for key, literal in pieces:
                    if literal is not None:
                        if key.startswith('\0guard_literal_double_'):
                            values = resolve(double_text(literal), True)
                        elif key.startswith('\0guard_literal_'):
                            values = {literal}
                        else:
                            values = resolve(literal, quoted_context or key.startswith('\0guard_double_'))
                    else:
                        if not quoted_context:
                            key = key.replace('\n', '')
                        if unsafe_bindings and re.search(variable, key):
                            raise AmbiguousScript('unresolved caller-expanded remote argument ' + _token(key))
                        if not quoted_context:
                            for match in re.finditer(variable, key):
                                if any(re.search(r'\s|[*?\[]', candidate) for candidate in bindings.get(match[1] or match[2], ())):
                                    raise AmbiguousScript('ambiguous unquoted remote argument ' + _token(key))
                        values = script_variants(key, literal=False, bindings=bindings)
                    result = {prior + value for prior in result for value in values}
                    if len(result) > MAX_SCRIPTS:
                        raise AmbiguousScript('too many caller-expanded remote argument combinations')
                return result

            for raw in raw_words[-count:]:
                resolved = resolve(raw)
                if '' in resolved and not re.search(r'\0guard_(?:literal|double)_', raw):
                    raise AmbiguousScript('unquoted remote argument may disappear after expansion')
                arguments = [prior + [candidate] for prior in arguments for candidate in resolved]
                if len(arguments) > MAX_SCRIPTS:
                    raise AmbiguousScript('too many caller-expanded remote argument combinations')
            return arguments
        if not cwd_only and any(re.match(r'^[A-Za-z_]\w*(?:\+=|\[[^=]*=)', word) for word in words):
            script_values.clear()
            opaque_written.clear()
        caller_directory = directory
        child_directory = False
        external_lookup = False
        wrapper_proved = True
        assignment_prefix = True
        while words:
            binary = os.path.basename(words[0])
            if binary in {'command', 'exec', 'nohup', 'sudo', 'nice', 'timeout', 'env', 'uv', 'offbox'}:
                assignment_prefix = False
                builtin = words[0] in {'command', 'exec'} and not external_lookup
                wrapper_proved &= preservation_tool(words, directory, builtin=builtin)
                # Wrappers can select another PATH/user, run setup hooks or
                # open implicit output files. Only plain command and env
                # assignments retain the child's inherited lookup proof.
                if binary not in {'command', 'env'} or binary == 'command' and len(words) > 1 and words[1].startswith('-'):
                    wrapper_proved = False
                external_lookup |= not builtin or binary != 'command'
            target = re.match(r'^([A-Za-z_]\w*)(?:\+=|\[[^=]*=)', words[0])
            if target and startup_binding(target[1]):
                shell_values.setdefault('NODE_OPTIONS', '')
                unsafe_bindings = True
                unsafe_binding_cause = f'non-scalar startup binding assignment at line {current_line}'
            if assignment_prefix and re.match(r"^[A-Za-z_]\w*=", raw_words[-len(words)]):
                transient = any(not re.match(r'^[A-Za-z_]\w*=', word) for word in words)
                remember_assignment(words.pop(0), directory, not cwd_only, transient)
            elif binary in {"command", "exec", "nohup", "sudo", "nice", "timeout"}:
                words.pop(0)
                while words and words[0].startswith("-"):
                    flag = words.pop(0)
                    if flag in {"-u", "-g", "-h", "-n", "-s", "-k", "--signal", "--kill-after"} and words:
                        words.pop(0)
                if binary == "timeout" and words:
                    words.pop(0)
            elif binary == "env":
                words.pop(0)
                while words and (words[0].startswith("-") or re.match(r"^[A-Za-z_]\w*=", words[0])):
                    flag = words.pop(0)
                    if flag.startswith('-'):
                        wrapper_proved = False
                    if re.match(r"^[A-Za-z_]\w*=", flag):
                        remember_assignment(flag, directory, not cwd_only, True)
                    elif flag in {"-C", "--chdir"}:
                        child_directory = True
                        directory = change_directory(words.pop(0), directory) if words else None
                    elif flag.startswith("--chdir="):
                        child_directory = True
                        directory = change_directory(flag.split("=", 1)[1], directory)
                    elif flag in {"-u", "--unset"} and words:
                        words.pop(0)
                    elif flag.startswith('-S') or flag == '--split-string' or flag.startswith('--split-string='):
                        raise AmbiguousScript('env: split-string lookup unproved')
                    elif flag not in {'-i', '--ignore-environment', '-0', '--null', '-v', '--debug', '--', '-', '--help', '--version'}:
                        raise AmbiguousScript('env: options or split-string lookup unproved')
            elif binary == "uv" and "run" in words[1:]:
                words.pop(0)
                while words:
                    flag = words.pop(0)
                    if flag == "run":
                        break
                    if flag in {"--directory", "--project"}:
                        value = words.pop(0) if words else ""
                        if flag == "--directory":
                            child_directory = True
                            directory = change_directory(value, directory)
                while words and words[0].startswith("-"):
                    flag = words.pop(0)
                    if flag in {"--directory", "--project", "--python", "--with", "--group", "--extra"}:
                        value = words.pop(0) if words else ""
                        if flag == "--directory":
                            child_directory = True
                            directory = change_directory(value, directory)
            elif binary == "offbox" and words[1:2] == ['run']:
                options_end = words.index('--') if '--' in words else len(words)
                for index in range(2, options_end):
                    flag, equal, value = words[index].partition('=')
                    if flag == '--step':
                        step = value if equal else words[index + 1] if index + 1 < options_end else ''
                        if not step:
                            raise AmbiguousScript('offbox --step has no command')
                        # Steps are shell commands, never exact-invocation
                        # fixture proofs. Inspect them even beside a payload.
                        scan_remote(step, directory, depth + 1, inherit_environment=True,
                                    preservation=wrapper_proved)
                payload = _offbox_payload(words, known_only=False)
                if payload is None:
                    break
                # --env is understood by the exact on-disk fixture proof,
                # but must not expand the separate caller-heredoc exception.
                trusted_flags = (_offbox_payload(words) is not None and
                                 not any(word.partition('=')[0] == '--env'
                                         for word in words[2:len(words) - len(payload)]))
                pulls = any(word == '--pull' or word.startswith('--pull=') for word in words[2:len(words) - len(payload)])
                words = payload
                remote_input, remote_bodies = [], {key: bodies[key] for key in document_keys}
                for key in document_keys:
                    remote_input.extend(['<<', key])
                for text, exact in here_strings:
                    key = f'__guard_remote_stdin_{len(remote_bodies)}__'
                    remote_bodies[key] = (text, exact)
                    remote_input.extend(['<<', key])
                for op, target in redirects:
                    if op in {'<', '<>'}:
                        remote_input.extend([op, target])
                if words:
                    trusted, empty, reasons = {}, set(), {}
                    payload_binary = next((os.path.basename(word) for word in words
                                           if os.path.basename(word) in {'bash', 'sh', 'zsh', 'dash', 'ksh', 'node', 'bun', 'deno'} or
                                           re.fullmatch(r'python[\d.]*', os.path.basename(word))), os.path.basename(words[0]))
                    def caller_template(value):
                        return expand(value, {'PWD': shell_values.get('PWD', str(directory))})
                    # A single string is remote shell text. Only argv payloads
                    # expand caller variables, and only the caller's quoted
                    # words retain the exact same proof as a local invocation.
                    if len(words) > 1 and not unsafe_bindings and trusted_flags:
                        for argument in words:
                            word = _attached_script_operand(argument, payload_binary)
                            if argument in invocation_quoted:
                                invocation_quoted.add(word)
                            if argument in invocation_literals:
                                invocation_literals.add(word)
                            if (word not in invocation_quoted and any((a or b) in marker_variables for a, b in
                                    re.findall(r'\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)', word))):
                                raise AmbiguousScript(path_refusal(word, directory, payload_binary))
                            if '$' in word and word not in invocation_literals:
                                for candidate in script_variants(word):
                                    detail = path_refusal(word, directory, payload_binary)
                                    reasons[candidate] = detail
                                    reasons[caller_template(candidate)] = detail
                            if word in invocation_quoted and word not in invocation_literals:
                                body = opaque_written.get((directory, word))
                                if body is not None:
                                    invocation_written = dict(opaque_written)
                                    invocation_fresh = set(fresh_variables)
                                    add(word, directory, payload_binary)
                                    for candidate in script_variants(word):
                                        trusted[directory, candidate] = body
                                        trusted[directory, caller_template(candidate)] = body
                                elif word.startswith('$(mktemp -d'):
                                    empty.update({word, caller_template(word)})
                    try:
                        arguments = caller_argv(len(words))
                    except AmbiguousScript as error:
                        word = next((word for word in words if '$' in word and word not in invocation_literals), None)
                        raise AmbiguousScript(path_refusal(word, directory, payload_binary, unsafe_binding_cause or str(error)) if word else str(error)) from error
                    for argv in arguments:
                        scan_remote(argv[0] if len(argv) == 1 else shlex.join(argv), directory, depth + 1,
                                    remote_input, remote_bodies, inherit_environment=True,
                                    opaque=(trusted, empty, reasons) if len(words) > 1 else None,
                                    preservation=wrapper_proved)
                    if may_change_scripts(words, directory, documents):
                        tool_changes.add(None)
                        invalidate(written, 'offbox payload', words, destination=changed_sources)
                        fresh_variables.clear()
                    if pulls:
                        glob_writes.add(None)
                        # Pulls occur after the payload, and may replace any
                        # local source before the next command in this call.
                        last_invalidation = f'invalidated by offbox --pull at line {current_line}'
                        opaque_written.clear()
                        fresh_variables.clear()
                        invalidate(written, 'offbox pull', ['offbox'], 'output pull may replace source', changed_sources)
                        tool_changes.add(None)
                # Local output redirects still need the normal invalidation
                # pass after the remote command has been checked.
                words = ['true']
                break
            else:
                break
        if not words:
            if not cwd_only and not wrapper_proved:
                tool_changes.add(None)
                if written or opaque_written or invalidated_written:
                    raise AmbiguousScript(f'command wrapper proof failed at line {current_line}')
            if not redirects:
                return caller_directory if child_directory else directory
            # A null command still opens its redirects. Reuse the ordinary
            # redirect path instead of dropping the write with an empty argv.
            words = [':']
        binary, args = os.path.basename(words[0]), words[1:]
        execution_binary = binary_label(words)
        execution_site = 'interpreter operand' if binary in {'node', 'bun', 'deno'} or re.fullmatch(r'python[\d.]*', binary) else 'script operand'
        if binary in {'set', 'bash', 'sh', 'zsh', 'dash', 'ksh'}:
            for arg in args:
                for option in script_variants(arg):
                    if re.fullmatch(r'-[A-Za-z]*C[A-Za-z]*', option) or option == 'noclobber' or binary == 'set' and '$' in option:
                        noclobber = True
        if binary in {'trap', 'alias', 'unalias', 'enable', 'builtin', 'shopt', 'setopt'}:
            unsafe_bindings = True
            unsafe_binding_cause = f'{binary} shell binding builtin at line {current_line}'
        after = caller_directory if child_directory else directory
        shell_builtin = not external_lookup and words[0] == binary
        def track_output_redirects():
            nonlocal last_invalidation
            # Any redirect other than the recognized heredoc writer invalidates
            # that file's prior source proof, including append and fd redirects.
            output_redirects = list(redirects)
            if binary == 'tee':
                output_redirects.extend(('>', arg) for arg in args if not arg.startswith('-'))
            for op, target in output_redirects:
                if op not in {'>', '>>', '>|', '&>', '&>>', '<>', '>&'} or op == '>&' and re.fullmatch(r'\d+|-', target):
                    continue
                key = opaque_key(target, directory)
                # A quoted, contained sibling with a distinct filesystem identity
                # cannot replace the checked script.
                # This matches literal-path source checking, which does not recurse
                # through imports. Unknown aliases still invalidate every proof.
                bounded = (not unsafe_bindings and not uncertain_write and
                           (key and key[1] in fresh_variables and target in invocation_quoted or
                            _literal_path(target, directory) is not None))
                if bounded:
                    for retained in list(opaque_written):
                        if opaque_key(retained[1], retained[0]) == key and key is not None:
                            del opaque_written[retained]
                    if key is not None and not (documents and binary in {'cat', 'tee'}):
                        populated_paths.add(key)
                        writer_causes[key] = f'written by a non-heredoc writer ({binary}) at line {current_line}'
                else:
                    if opaque_written or fresh_variables:
                        last_invalidation = f'unbounded or unquoted write at line {current_line}'
                    opaque_written.clear()
                    fresh_variables.clear()
                for candidate in script_variants(target):
                    path = _literal_path(candidate, directory)
                    remember_glob_write(candidate, directory)
                    fresh_target = bounded and key is not None and key[1] in fresh_variables
                    if fresh_target:
                        # A fresh root cannot contain an existing executable, but
                        # failed mktemp leaves the absolute empty-root fallback.
                        tool_changes.add(opaque_fallback(target, directory))
                    affected = affected_sources(path, track_tool=not fresh_target)
                    if op in {'>', '>>'} and documents and binary in {'cat', 'tee'}:
                        affected.discard(path)
                    invalidate(affected, 'output redirect', words, 'redirect target overlaps or is unproved')
        if not cwd_only and shell_builtin and binary in {'export', 'readonly', 'declare', 'typeset', 'local', 'cd', 'pushd', 'popd'}:
            track_output_redirects()
        if (not cwd_only and not wrapper_proved and
                binary in {'export', 'readonly', 'declare', 'typeset', 'local', 'cd', 'pushd', 'popd'}):
            tool_changes.add(None)
            if written or opaque_written or invalidated_written:
                raise AmbiguousScript(f'command wrapper proof failed at line {current_line}')
        if shell_builtin and binary in {"export", "readonly", "declare", "typeset", "local"}:
            # Only literal scalar names can exclude startup variables. Brace
            # fragments, globbing and computed names need the same taint as
            # an explicit NODE_OPTIONS declaration.
            names = [arg.partition('=')[0] for arg in args]
            if any(name in {'NODE_OPTIONS', 'NODE_OPTIONS+'} or
                   not re.fullmatch(r'(?:[A-Za-z_]\w*\+?|--|-[A-Za-z]+)', name) for name in names):
                shell_values.setdefault('NODE_OPTIONS', '')
            if not cwd_only:
                if binary in {'declare', 'typeset', 'local'} and any(re.fullmatch(r'-[A-Za-z]*[naiA][A-Za-z]*', arg) for arg in args):
                    unsafe_bindings = True
                    unsafe_binding_cause = f'non-scalar declaration at line {current_line}'
                if any(startup_binding(name.removesuffix('+')) for name in names):
                    unsafe_bindings = True
                    unsafe_binding_cause = f'startup binding declaration at line {current_line}'
                script_values.clear()
                opaque_written.clear()
            for arg in args:
                if re.match(r"^[A-Za-z_]\w*=", arg):
                    remember_assignment(arg, directory, False)
            return after
        if shell_builtin and binary == "cd":
            args = [arg for arg in args if arg not in {"--", "-L", "-P"}]
            changed = change_directory(args[0] if args else str(Path.home()), directory) if len(args) <= 1 else None
            if changed is None and "loop that changes directory" not in unknown_cause:
                unknown_cause = "cd to a non-literal directory " + _token(args[0] if args else "")
            return after if child_directory else changed
        if shell_builtin and binary in {"pushd", "popd"}:
            unknown_cause = "pushd/popd changes the directory"
            return None
        if cwd_only:
            if binding_preflight:
                invalidate_print_bindings(words, current_line, loop=True)
            return scan(" ".join(args), directory, depth + 1, cwd_only=True) if binary == "eval" else after
        if binary == 'unset' and all(re.fullmatch(r'[A-Za-z_]\w*', arg) for arg in args):
            if 'PATH' in args:
                unsafe_bindings = True
                unsafe_binding_cause = f'PATH unset at line {current_line}'
            for name in args:
                invalidate_variable(name)
                script_values.pop(name, None)
        elif binary in {'read', 'readarray', 'mapfile', 'unset', 'eval', 'source', '.', 'let', 'getopts'}:
            script_values.clear()
            opaque_written.clear()
            shell_values.setdefault('NODE_OPTIONS', '')
        binding_option = False
        if binary in {'printf', 'wait'}:
            # Keep raw quote markers per argument: a literal '$opt' elsewhere
            # in this invocation cannot prove an expanded "$opt" is data.
            for arg, raw in zip(args, raw_words[-len(args):] if args else []):
                if raw not in binding_literal_words:
                    binding_option = True
                    break
                if arg == '--' or not arg.startswith('-'):
                    break
                if binary == 'printf' and arg.startswith('-v') or binary == 'wait' and re.match(r'^-[A-Za-z]*p', arg):
                    binding_option = True
                    break
        if binding_option:
            script_values.clear()
            opaque_written.clear()
            shell_values.setdefault('NODE_OPTIONS', '')
        if binary == 'printf':
            # Bash's %n assigns a shell variable. Only a literal, bounded
            # format can prove that printf leaves lookup/startup bindings alone.
            format_index = 1 if args and args[0] == '--' else 0
            raw_args = raw_words[-len(args):] if args else []
            format_safe = (format_index < len(args) and raw_args[format_index] in binding_literal_words and
                           '%' not in re.sub(r'%%|%[-+ #0]*(?:\d+|\*)?(?:\.(?:\d+|\*))?[bqcsdiouxXfFeEgGaA]',
                                             '', args[format_index]))
            if args and not format_safe:
                unsafe_bindings = True
                unsafe_binding_cause = f'printf binding format unproved at line {current_line}'
                script_values.clear()
                opaque_written.clear()
                shell_values.setdefault('NODE_OPTIONS', '')
        invalidate_print_bindings(words, current_line)
        invocation_written = dict(opaque_written)
        invocation_fresh = set(fresh_variables)
        stdin_sources = documents if exact_documents and not here_strings and not any(op in {'<', '<>'} for op, _ in redirects) else []
        literal_arguments = [raw in binding_literal_words for raw in raw_words[-len(words):]]
        code_index = next((index + 1 for index, arg in enumerate(words)
                           if arg in {'-c', '-e', '--eval', '-p', '--print'}), len(words))
        literal_eval = code_index < len(literal_arguments) and literal_arguments[code_index]
        if written or opaque_written or invalidated_written:
            inline_sources = node_inline_sources(words, directory, stdin_sources, literal_eval=literal_eval)
            if binary == 'node' and not wrapper_proved:
                inline_sources = []
                proof_failure = 'node: command wrapper proof failed'
            if (binary == 'node' and not inline_sources and
                    (not args or stdin_sources or any(arg in {'-e', '--eval', '-p', '--print', '-'} for arg in args))):
                raise AmbiguousScript(f'{proof_failure}; execution inline source: node at line {current_line}')
            if inline_sources and not all(node_inline_preserves_sources(source, directory) for source in inline_sources):
                raise AmbiguousScript(f'{proof_failure}; execution inline source: node at line {current_line}')
        interpreter = binary in {'node', 'bun', 'deno', 'bash', 'sh', 'zsh', 'dash', 'ksh'} or re.fullmatch(r'python[\d.]*', binary)
        direct_script = (not interpreter and not re.match(r'^[A-Za-z_]\w*(?:\[[^]]*\])?\+?=', words[0]) and
                         (bool(re.search(r'\.(?:py|mjs|cjs|js|ts|sh)$', words[0])) or
                          (directory, words[0]) in invocation_written or
                          any(_literal_path(candidate, directory) in written for candidate in script_variants(words[0]))))
        if direct_script:
            execution_site = 'direct script'
        startup_proved = (interpreter_startup_proved(words, directory) if interpreter else
                          preservation_tool(words, directory, builtin=True) if direct_script else True)
        if direct_script and '/' not in words[0]:
            startup_proved = False
            proof_failure = 'direct script: executable lookup unproved'
        startup_refusal = None
        if (interpreter or direct_script) and (not wrapper_proved or not startup_proved):
            reason = proof_failure if wrapper_proved else 'command wrapper proof failed'
            # A failed startup/lookup proof can replace source before this
            # invocation opens it. Body effects invalidate only later uses.
            invalidate(written, 'interpreter startup', words, reason)
            last_invalidation = f'interpreter startup: {binary_label(words)} at line {current_line}; {reason}'
            invocation_invalidation = invocation_invalidation or last_invalidation
            invocation_startup_failure = last_invalidation
            if written or invocation_written or invalidated_written:
                startup_refusal = last_invalidation
            opaque_written.clear()

        def finish_invocation():
            # Unknown startup options can hide the actual script operand. A
            # failed proof must survive every interpreter exit, including
            # recursive shell scans that replace the invocation's state.
            if startup_refusal:
                raise AmbiguousScript("script source changed after its heredoc write; " + startup_refusal +
                                      "; execution unproved interpreter")
            if direct_script or interpreter and changes_scripts:
                tool_changes.add(None)
            return after

        if wrapper_proved:
            changes_scripts = may_change_scripts(words, directory, stdin_sources, literal_eval=literal_eval,
                                                external_lookup=external_lookup, literal_arguments=literal_arguments)
        else:
            changes_scripts = True
            proof_failure = 'command wrapper proof failed'
        # Execution alone already permits subsequent literal test targets.
        # Keep that behavior for scanned tests, version probes and npm tasks;
        # explicit redirects and filesystem commands still record destinations.
        node_glob_predecessor = binary == 'node' and ('--test' in args or args in (['--version'], ['-v']))
        # Shell write tracking is deferred until its input form is known.
        if changes_scripts and not node_glob_predecessor and binary not in {'npm', 'bash', 'sh', 'zsh', 'dash', 'ksh', 'cp', 'mv', 'rsync', 'ditto', 'install', 'tee', 'sed', 'perl', 'truncate'}:
            glob_writes.add(None)
        if binary == 'mkdir':
            for arg in args:
                if not arg.startswith('-'):
                    for candidate in script_variants(arg):
                        remember_glob_write(candidate, directory)
        if changes_scripts:
            if opaque_written or fresh_variables:
                last_invalidation = f'invalidated by {binary_label(words)} command at line {current_line}; intervening command; {proof_failure}'
            # Current interpreter/startup lookup precedes this body's effects.
            # Recursive shell input tracks its own commands before returning.
            if not (direct_script or interpreter):
                tool_changes.add(None)
            invalidate(written, 'intervening command', words, destination=changed_sources)
            opaque_written.clear()
            fresh_variables.clear()
        if binary == 'chmod':
            for arg in args:
                if arg.startswith('-'):
                    continue
                key = opaque_key(arg, directory)
                root = re.fullmatch(r'\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))', arg)
                fresh = (arg in invocation_quoted and not unsafe_bindings and not uncertain_write and
                         (key is not None and key[1] in fresh_variables or
                          root is not None and (root[1] or root[2]) in fresh_variables))
                if fresh:
                    # An empty-root chmod cannot enable an existing PATH tool;
                    # a descendant still has the ordinary failed-root fallback.
                    if key is not None:
                        tool_changes.add(opaque_fallback(arg, directory))
                else:
                    tool_changes.update(_literal_path(candidate, directory) for candidate in script_variants(arg))
        if words[0].startswith(('/', './', '../')) and re.search(r'\.(?:py|mjs|cjs|js|ts|sh)$', words[0]):
            fresh_variables.clear()
        if binary in {'cp', 'mv', 'rsync', 'ditto', 'install', 'tee', 'sed', 'perl', 'truncate'}:
            destinations = args[-1:] if binary == 'cp' and len(args) == 2 and not any(arg.startswith('-') for arg in args) else args
            for arg in destinations:
                for candidate in script_variants(arg):
                    target = _literal_path(candidate, directory)
                    remember_glob_write(candidate, directory)
                    if target is not None:
                        invalidate(affected_sources(target, descendants=True), 'writer operand', words, 'destination overlaps checked source')
            if binary == 'cp' and len(args) == 2:
                root = re.fullmatch(r'\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/([^$`*?\[\]{}]*)', args[-1])
                source = _literal_path(args[0], directory)
                if root and source is not None:
                    copied = opaque_key('$' + (root[1] or root[2]) + '/' + (root[3] or source.name), directory)
                    if copied is not None:
                        copied_opaque.add(copied)
                        writer_causes[copied] = f'unchecked copy at script path at line {current_line}'
                        for key in list(opaque_written):
                            if opaque_contains(copied, opaque_key(key[1], key[0])):
                                del opaque_written[key]
        if binary == "vp" and args[:2] == ["run", "migrate-dev-db"]:
            if any(direct_read(['cat', *values], directory)
                   for values in variants([v for op, v in redirects if op in {'<', '<>'}])):
                raise LiveRead("live-database-read")
            migration_context(words)
            migration_source(args[2:], directory)
            # Resolve the package command as vp does; never trust the task name
            # or a same-named script in an unrelated project as an exemption.
            if directory is None:
                raise AmbiguousScript("migrate-dev-db after " + unknown_cause)
            for parent in (directory, *directory.parents):
                try:
                    package = json.loads((parent / "package.json").read_text())
                except (OSError, ValueError):
                    continue
                task = package.get("scripts", {}).get("migrate-dev-db")
                if task != "node apps/server/scripts/migrate-dev-db.ts":
                    raise AmbiguousScript("unrecognized migrate-dev-db package command")
                add("apps/server/scripts/migrate-dev-db.ts", parent, "node", args[2:])
                return after
            raise AmbiguousScript("migrate-dev-db package command not found")
        shells = {"bash", "sh", "zsh", "dash", "ksh"}
        python = bool(re.fullmatch(r"python[\d.]*", binary))
        if binary == 'bun':
            remaining, index, options = [], 0, True
            while index < len(args):
                arg = args[index]
                flag, equal, value = arg.partition('=')
                if options and flag == '--preload':
                    original = arg
                    if not equal:
                        index += 1
                        value = args[index] if index < len(args) else ''
                    if equal and original in invocation_quoted:
                        invocation_quoted.add(value)
                    if equal and original in invocation_literals:
                        invocation_literals.add(value)
                    if not value:
                        raise AmbiguousScript('missing bun --preload operand')
                    add(value, directory, 'bun')
                else:
                    remaining.append(arg)
                    if arg == '--' or arg not in {'test', 'run'} and not arg.startswith('-') and args[:1] != ['test']:
                        options = False
                index += 1
            args = remaining
        if python or binary in shells | {"bun", "deno"}:
            args = _interpreter_args(binary, args)
        node_test = False
        node_inputs = []
        node_runtime_options = False
        if binary == 'node':
            for argument in args:
                operand = _attached_script_operand(argument, binary)
                if argument in invocation_quoted:
                    invocation_quoted.add(operand)
                if argument in invocation_literals:
                    invocation_literals.add(operand)
            args, node_inputs, node_test, node_runtime_options = _node_arguments(args)
        if binary == 'bun' and args[:1] == ['test']:
            node_test, args = True, args[1:]
        if binary in {'bun', 'deno'} and args[:1] == ['run']:
            args = _interpreter_args(binary, args[1:])
        program_args = list(args)
        while program_args and program_args[0].startswith('-') and program_args[0] != '-':
            flag = program_args.pop(0)
            if flag in {'--', '-c', '-e', '--eval', '-p', '--print', '-m'}:
                break
        stdin_code = not args or program_args[:1] == ['-'] or all(arg.startswith('-') for arg in args)
        shell_options = args[:len(args) - len(program_args)] if binary in shells else []
        shell_stdin = any(re.fullmatch(r'-[a-z]*s[a-z]*', arg) for arg in shell_options)
        shell_command = any(re.fullmatch(r'-[a-z]*c[a-z]*', arg) for arg in shell_options)
        stdin_code |= shell_stdin and not shell_command
        if binary in shells and changes_scripts:
            # Only command strings and literal stdin bodies are walked below.
            # Checking an on-disk shell file for DB reads does not check writes.
            inspected_command = shell_command and bool(program_args)
            inspected_stdin = (stdin_code and (documents or here_strings) and exact_documents and
                               all(exact for _, exact in here_strings) and not any(op in {'<', '<&', '<>'} for op, _ in redirects))
            if not inspected_command and not inspected_stdin:
                glob_writes.add(None)
        track_output_redirects()
        tee_options = binary == 'tee' and all(arg and (not arg.startswith('-') or arg in {'-a', '--append', '--'}) for arg in args)
        writer = not noclobber and exact_documents and not here_strings and not any(op in {'<', '<>'} for op, _ in redirects) and (binary == 'cat' and args in ([], ['-'], ['--']) or tee_options)
        writer_failure = 'heredoc writer proof failed'
        if writer and not (wrapper_proved and preservation_tool(words, directory)):
            writer = False
            writer_failure = proof_failure if wrapper_proved else 'command wrapper proof failed'
        if not (writer and documents) and binary == 'tee':
            last_invalidation = f'unreadable tee writer at line {current_line}'
            if not tee_options:
                opaque_written.clear()
                fresh_variables.clear()
        if (documents or here_strings) and binary in {'cat', 'tee'} and not writer:
            for op, target in redirects:
                if op in {'>', '>>', '<>'}:
                    for candidate in script_variants(target):
                        path = _literal_path(candidate, directory)
                        if path is not None:
                            invalidate([path], 'unreadable heredoc writer', words, writer_failure)
                        key = opaque_key(target, directory)
                        if key is not None:
                            writer_causes.setdefault(key, binding_causes.get(key[1]) or
                                f'no readable same-call heredoc writer for this script; {writer_failure} at line {current_line}')
        if documents:
            for body in documents:
                if binary in shells and stdin_code:
                    scan_child(body, directory, depth + 1)
                elif (python or binary in {"node", "bun", "deno"}) and stdin_code or binary in {"sqlite3", "sqlite"}:
                    check_source(body, directory, python, "live-database-read")
            if stdin_code and not exact_documents and (python or binary in shells | {'node', 'bun', 'deno'}):
                raise AmbiguousScript('non-literal executable stdin source after heredoc expansion')
            if writer:
                targets = [(value, op == ">>") for op, value in redirects if op in {">", ">>"}]
                if binary == "tee":
                    targets.extend((arg, "-a" in args or "--append" in args) for arg in args if not arg.startswith("-"))
                for target, append in targets:
                    candidates = script_variants(target)
                    for candidate in candidates:
                        path = _literal_path(candidate, directory)
                        if path is not None:
                            if not append and not conditional and len(candidates) == 1 and '$' not in target:
                                invalidated_written.pop(path, None)
                            prior, replaced = written.get(path, ("", False))
                            if not append and not conditional and len(candidates) == 1 and '$' not in target:
                                write_history[path] = []
                                variable_written.discard(path)
                            write_history.setdefault(path, []).extend(documents)
                            if '$' in target:
                                variable_written.add(path)
                            if conditional or len(candidates) != 1 or '$' in target:
                                written[path] = (prior + "".join(documents), replaced and '$' not in target)
                            else:
                                written[path] = (prior + "".join(documents), replaced) if append else ("".join(documents), True)
                    references = [a or b for a, b in re.findall(r'\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)', target)]
                    rooted = re.fullmatch(r'\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/([^$`*?\[\]{}]+)', target)
                    # Freshness proves only descendants of that directory,
                    # never a sibling reached through an opaque root's parent.
                    contained = rooted is not None and not Path(rooted[3]).is_absolute() and '..' not in Path(rooted[3]).parts and Path(rooted[3]) != Path('.')
                    if (not unsafe_bindings and not uncertain_write and directory is not None and references and target in invocation_quoted and
                            contained and
                            copied_source(opaque_key(target, directory)) is None and
                            all(name in fresh_variables for name in references) and
                            all(name in script_values and '$' + name not in script_values[name] for name in references) and
                            not any(char in target for char in '`*?[') and '$(' not in target):
                        prior = invocation_written.get((directory, target))
                        key = opaque_key(target, directory)
                        if append and prior is not None or not append and key not in populated_paths:
                            opaque_written[(directory, target)] = (*prior, *documents) if append else tuple(documents)
                            populated_paths.add(key)
                        else:
                            fresh_variables.difference_update(references)
                    else:
                        fresh_variables.clear()
        if stdin_code:
            for body, exact in here_strings:
                if binary in shells:
                    scan_child(body, directory, depth + 1)
                elif python or binary in {'node', 'bun', 'deno'}:
                    check_source(body, directory, python, 'live-database-read')
                if not exact and (python or binary in shells | {'node', 'bun', 'deno'}):
                    raise AmbiguousScript('non-literal executable stdin source after here-string expansion')
        read_words = list(words)
        if python or binary in {"node", "bun", "deno"}:
            for i, arg in enumerate(read_words[1:], 1):
                if arg in {"-c", "-e", "--eval", "-p", "--print"} and i + 1 < len(read_words):
                    check_source(read_words[i + 1], directory, python, "live-database-read")
                    del read_words[i + 1]
                    break
        assignment_reads = [] if binary == "jq" else list(live_assignments)
        listing_reads = assignment_reads
        if binary == 'rg':
            config = shell_values.get('RIPGREP_CONFIG_PATH', os.environ.get('RIPGREP_CONFIG_PATH', ''))
            if config:
                listing_reads = [*listing_reads, config]
        if (binary in {'rg', 'fd', 'fdfind', 'find'} and _listing_only(read_words) and
                direct_read(['cat', *listing_reads], directory)):
            # Environment-selected config files are read even in listing mode.
            raise LiveRead('live-database-read')
        if any(direct_read(values + assignment_reads, directory)
               for values in variants(read_words)):
            if python and any(flag in words for flag in {"-c", "-e"}) and any(".write_text(" in word or ".write_bytes(" in word for word in words):
                match = _database_reference(" ".join(read_words[1:]))
                if match:
                    raise LiveRead("live-database-read", f"Inline-code argument names {_token(match[0])}; it cannot be verified as data only.\n"
                                   "Use apply_patch to write report data containing protected database paths.")
            raise LiveRead("live-database-read")
        if any(direct_read(["cat", *values], directory)
               for values in variants([v for op, v in redirects if op in {'<', '<>'}])):
            raise LiveRead("live-database-read")
        if stdin_code and (python or binary in shells | {'node', 'bun', 'deno'}):
            for op, target in redirects:
                if op in {'<', '<>'}:
                    add(target, directory, binary)
        for source in node_inputs:
            add(source, directory, 'node')
        # Node can load runtime hooks even during --check. Only a plain parse
        # invocation gets this exception; substitutions were checked above.
        node_parse = False
        node_target = None
        if binary == 'node':
            for index, arg in enumerate(args):
                if arg in {'--check', '-c'}:
                    node_parse = True
                elif arg == '--no-warnings':
                    continue
                elif arg == '--':
                    node_target = args[index + 1] if index + 1 < len(args) else None
                    break
                elif not arg.startswith('-') or arg == '-':
                    node_target = arg
                    break
                else:
                    node_parse = False
                    break
        if node_parse and not node_test and not node_runtime_options and not os.environ.get("NODE_OPTIONS") and "NODE_OPTIONS" not in shell_values:
            if node_target is not None and node_target != '-':
                # Parsing still opens the operand. Resolve aliases so an
                # unknown token cannot stand for the live database itself.
                path = script_path(node_target, directory, binary)
                if LIVE.search(str(path)):
                    raise LiveRead('live-database-read')
            if not wrapper_proved or not startup_proved or not preservation_tool(words, directory):
                reason = invocation_startup_failure or (proof_failure if wrapper_proved else 'node: command wrapper proof failed')
                raise AmbiguousScript(f'{reason}; execution parse-only: node at line {current_line}')
            return finish_invocation()
        if binary in shells:
            if any(re.fullmatch(r"-[a-z]*n[a-z]*", arg) for arg in shell_options):
                if not wrapper_proved or not startup_proved or not preservation_tool(words, directory):
                    reason = invocation_startup_failure or (proof_failure if wrapper_proved else 'shell: command wrapper proof failed')
                    raise AmbiguousScript(f'{reason}; execution parse-only: shell at line {current_line}')
                return finish_invocation()
            index = next((i for i, arg in enumerate(shell_options) if re.fullmatch(r"-[a-z]*c[a-z]*", arg)), None)
            if index is not None:
                if index + 1 < len(args):
                    scan_child(args[index + 1], directory, depth + 1)
                return finish_invocation()
        if binary == "eval":
            return scan(" ".join(args), directory, depth + 1)
        if binary == 'ssh':
            remote = list(args)
            while remote and remote[0].startswith('-'):
                flag = remote.pop(0)
                if flag == '--':
                    break
                if flag[:2] in {'-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w'} and len(flag) == 2:
                    if not remote:
                        raise AmbiguousScript('missing ssh option operand ' + _token(flag))
                    remote.pop(0)
            if len(remote) > 1:
                for argv in caller_argv(len(remote) - 1):
                    scan_remote(' '.join(argv), directory, depth + 1)
            return finish_invocation()
        interpreter = binary in shells | {"node", "bun", "deno"} or re.fullmatch(r"python[\d.]*", binary)
        if interpreter or binary in {"source", "."}:
            options_ended = False
            while args and args[0].startswith("-"):
                if args[0] == '-':
                    return finish_invocation()
                flag = args.pop(0)
                if flag in {"-c", "-e", "--eval", "-p", "--print", "-m"}:
                    if flag == "-m" and python and args:
                        if directory is not None:
                            for candidate in module_candidates(args, directory):
                                if _literal_path(candidate, directory) in written:
                                    add(candidate, directory, binary)
                    elif args and binary not in shells:
                        check_source(args[0], directory, python, "live-database-read")
                    return finish_invocation()
                if flag == "--":
                    options_ended = True
                    break
            if binary in shells and args[:1] == ['-'] and len(args) > 1:
                raise AmbiguousScript(f'shell: bare dash input unproved at line {current_line}')
            if shell_stdin and not shell_command:
                return finish_invocation()
            if args and args[0] != "-":
                targets = args if node_test else args[:1]
                for target in targets:
                    if options_ended or not target.startswith("-"):
                        migration_args = (args[1:] if binary == "node" and len(words) > 1 and words[1] == target and
                                          Path(target).name == "migrate-dev-db.ts" else None)
                        if migration_args is not None:
                            migration_context(words)
                        add(target, directory, binary, migration_args, target if node_test else None)
                        if python and Path(target).name == 'offbox.py' and args[1:2] == ['ssh'] and len(args) > 3:
                            remote = args[3:]
                            for argv in caller_argv(len(remote)):
                                scan_remote(argv[0] if len(argv) == 1 else shlex.join(argv), directory, depth + 1)
        elif direct_script:
            add(words[0], directory, binary)
        return finish_invocation()

    def scan(source, directory, depth=0, cwd_only=False, inherited_bodies=None):
        nonlocal unsafe_bindings, unsafe_binding_cause
        if depth > MAX_SHELL_DEPTH:
            if SCRIPT.search(source) or DIRECT.search(source) or READER.search(source):
                raise AmbiguousScript(f"shell nesting deeper than MAX_SHELL_DEPTH ({MAX_SHELL_DEPTH})")
            return None
        try:
            inherited_bodies = {**stdin_bodies, **(inherited_bodies or {})}
            source, bodies = _heredocs(source, len(inherited_bodies or {}), inherited_bodies or ())
            bodies = {**(inherited_bodies or {}), **bodies}
        except UnterminatedHeredoc:
            # Shells accept EOF as an implicit terminator for data-only
            # documents. Executable or database-reading text stays refused.
            if (SCRIPT.search(source) or DIRECT.search(source) or
                    re.search(r"(?:^|[\s;&|])(?:python[\d.]*|bash|sh|zsh|node)\s+\S", source) or
                    source_touches_live(source) and READER.search(source)):
                raise
            return directory
        # Definitions and arithmetic can mutate bindings outside the simple
        # assignment grammar. Keep variable execution opaque in those shells.
        binding_source, _ = _quoted_punctuation(source, single_quotes_only=True)
        checks = [('(( arithmetic', re.search(r'\(\(', binding_source)),
                  ('function definition', re.search(r'(?:^|[;&|()\n])\s*(?:function\s+[A-Za-z_]\w*|[A-Za-z_]\w*\s*\(\s*\)\s*\{)', binding_source)),
                  ('non-simple ${} expansion', next((m for m in re.finditer(r'\$\{[^}]*\}', binding_source)
                                                    if not re.fullmatch(r'\$\{[A-Za-z_]\w*\}', m[0])), None))]
        for reason, match in checks:
            if match:
                unsafe_bindings = True
                unsafe_binding_cause = f'{reason} at line {binding_source.count(chr(10), 0, match.start()) + 1}'
                opaque_written.clear()
                break
        source, quoted = _quoted_punctuation(source, script_literals=True)

        def source_line(offset):
            prefix = source[:offset]
            for marker, literal in reversed(quoted.items()):
                prefix = prefix.replace(marker, literal)
            return prefix.count('\n') + 1

        continued_redirect = re.search(r'[<>][ \t]*(?:\\\n)+|(?:\\\n)+[ \t]*[<>]', source)
        if continued_redirect:
            raise AmbiguousScript(f'continued redirect unproved at line {source_line(continued_redirect.start())}')
        clobber = re.search(r'>{1,2}[!|]', source)
        if clobber:
            raise AmbiguousScript(f'clobber redirect unproved at line {source_line(clobber.start())}')
        # The lexer treats braces as shell groups; it cannot retain a complete
        # expanding filename. Quoted words and parameter braces are masked.
        brace = re.search(r'\{[^\s{}]+\}|(?<=[^\s;&|(){}<>])\{|\}(?=[^\s;&|(){}<>])', source)
        if brace:
            raise AmbiguousScript(f'shell brace expansion or word boundary unproved at line {source_line(brace.start())}')
        lexer = shlex.shlex(source, posix=True, punctuation_chars=";&|(){}\n<>")
        lexer.whitespace = " \t\r"
        lexer.whitespace_split = True
        try:
            tokens = []
            for token in lexer:
                if re.fullmatch(r"[;&|(){}\n<>]+", token):
                    tokens.extend(re.findall(r"&&|\|\||&>>|&>|>&|<&|<>|>\||<<<|<<-?|>>|[^\s]|\n", token))
                else:
                    tokens.append(token)
        except ValueError:
            if SCRIPT.search(source) or DIRECT.search(source) or READER.search(source) or any(value.startswith("${") for value in quoted.values()):
                raise AmbiguousScript(f"shell text could not be parsed (unbalanced quote near line {lexer.lineno})")
            return None
        token_lines, line = [], 1
        for token in tokens:
            token_lines.append(line)
            line += token.count('\n')
            for marker, literal in quoted.items():
                if marker in token:
                    line += literal.count('\n')

        def walk(index, current, closing=None, probe=cwd_only, stop=None, binding_preflight=False,
                 end_after_loop=False):
            nonlocal unknown_cause, conditional, uncertain_write, current_line, unsafe_bindings, unsafe_binding_cause
            words = []
            words_line = 1
            branches = []
            guarded = False
            safe_chain = True

            def mark_cwd_change(before, after):
                if before != after:
                    if before is not None and after is None:
                        remember_reader_directory(before)
                    for frame in branches:
                        frame["changed"] = True

            def run(words, current, concurrent=False):
                nonlocal conditional, uncertain_write, current_line
                before = current
                current_line = words_line
                uncertain = bool(branches) or guarded or concurrent
                conditional += uncertain
                uncertain_write += bool(branches) or concurrent or guarded and not safe_chain
                changed_sources = {}
                try:
                    current = inspect(words, current, depth, bodies, quoted, changed_sources,
                                      cwd_only=probe, binding_preflight=binding_preflight) if words else current
                finally:
                    invalidated_written.update(changed_sources)
                    conditional -= uncertain
                    uncertain_write -= bool(branches) or concurrent or guarded and not safe_chain
                mark_cwd_change(before, current)
                return current

            while index < (len(tokens) if stop is None else stop):
                token = tokens[index]
                header_cwd = current
                if branches and branches[-1]["kind"] == "case" and branches[-1].get("pattern"):
                    # Pattern words are data, including reserved words and an
                    # optional opening parenthesis. Still check expansions.
                    if token == '\n':
                        index += 1
                        continue
                    if token != 'esac' or index + 1 < len(tokens) and tokens[index + 1] in {'|', ')'}:
                        checked = set()
                        pattern_depth = 0
                        if token == '(':
                            index += 1
                        while index < len(tokens):
                            part = tokens[index]
                            if part == ')' and not pattern_depth:
                                break
                            if part == '(':
                                pattern_depth += 1
                            elif part == ')':
                                pattern_depth -= 1
                            decode_word(part, branches[-1].get('arm_cwd', branches[-1]['cwd']),
                                        depth, quoted, checked, probe, bodies)
                            index += 1
                        if index == len(tokens):
                            raise AmbiguousScript('shell text could not be parsed (unterminated case pattern)')
                        current = branches[-1].get('arm_cwd', branches[-1]['cwd'])
                        branches[-1]['pattern'] = False
                        index += 1
                        continue
                if not words and token in {'!', 'time'}:
                    # These reserved words can prefix compound commands too.
                    # Keep their groups/case arms visible to the normal walk.
                    if token == '!':
                        safe_chain = False
                    index += 1
                    if token == 'time' and index < len(tokens) and tokens[index] == '-p':
                        index += 1
                    continue
                if token in {"for", "while", "until", "select"} and not words and not probe:
                    if token in {'for', 'select'}:
                        header = []
                        for target in tokens[index + 1:]:
                            if target in {'in', 'do', ';', '\n'}:
                                break
                            header.append(target)
                        if len(header) != 1 or not re.fullmatch(r'[A-Za-z_]\w*', header[0]):
                            raise AmbiguousScript(f'loop targets unproved at line {token_lines[index]}')
                    if token in {'for', 'select'} and index + 1 < len(tokens) and startup_binding(tokens[index + 1]):
                        unsafe_bindings = True
                        unsafe_binding_cause = f'loop startup binding at line {token_lines[index]}'
                    # Any iteration can inherit the cwd left by the preceding
                    # one. Preflight loop bodies before resolving relative paths.
                    # Reuse the normal group/case traversal to discover binding
                    # mutations and the matching loop end. Counting raw keyword
                    # tokens mistakes case patterns and arguments for syntax.
                    loop_cwd, end = walk(index, current, probe=True, stop=stop,
                                         binding_preflight=True, end_after_loop=True)
                    if loop_cwd != current:
                        # The body starts unknown, so its cd may no longer
                        # produce a change that enclosing exits can observe.
                        mark_cwd_change(current, loop_cwd)
                        current = None
                        unknown_cause = "a loop that changes directory"
                    # The next iteration may inherit any assignment from the
                    # body, including one after an earlier script invocation.
                    raw_segment = tokens[index + 1:end]
                    segment = [decode_word(word, current, depth, quoted, set(), True, bodies) for word in raw_segment]
                    if any(word in {'read', 'readarray', 'mapfile', 'unset', 'printf', 'let', 'getopts', 'eval', 'source', '.', 'wait', 'local', 'declare', 'typeset', 'export', 'readonly', 'trap', 'alias', 'unalias', 'enable', 'builtin', 'shopt', 'setopt'} or re.match(r'^[A-Za-z_]\w*(?:\+=|\[[^=]*=)', word) for word in segment):
                        script_values.clear()
                        opaque_written.clear()
                        shell_values.setdefault('NODE_OPTIONS', '')
                    for offset, decoded in enumerate(segment):
                        assignment = re.match(r'^([A-Za-z_]\w*)=', decoded)
                        loop_name = segment[offset + 1] if decoded in {'for', 'select'} and offset + 1 < len(segment) else None
                        if assignment or loop_name and re.fullmatch(r'[A-Za-z_]\w*', loop_name):
                            name = assignment[1] if assignment else loop_name
                            if startup_binding(name):
                                unsafe_bindings = True
                                unsafe_binding_cause = f'loop startup binding at line {token_lines[index]}'
                            script_values[name] = {'$' + name}
                            invalidate_variable(name)
                    group, raw_group = [], []
                    body_start = raw_segment.index('do') + 1 if 'do' in raw_segment else len(segment)
                    body = list(zip(raw_segment[body_start:], segment[body_start:]))
                    for raw, word in body + [(';', ';')]:
                        if word not in {';', '\n', '&&', '||', '|', '&'}:
                            group.append(word)
                            raw_group.append(raw)
                            continue
                        targets = [group[i + 1] for i, token in enumerate(group[:-1]) if token in {'>', '>>', '<>'}]
                        syntax_only = len(group) == 1 and raw_group[0] in {'do', 'then', 'else', 'fi', 'done', 'esac'}
                        if not syntax_only and may_change_scripts(group, current):
                            tool_changes.add(None)
                            invalidate(written, 'loop command', group)
                        if group and os.path.basename(group[0]) in {'cp', 'mv', 'rsync', 'ditto', 'tee', 'sed', 'perl', 'truncate'}:
                            targets += group[1:]
                        for target in targets:
                            for candidate in script_variants(target):
                                path = _literal_path(candidate, current)
                                invalidate(affected_sources(path, descendants=True), 'loop writer', group, 'destination overlaps or is unproved')
                        if targets:
                            opaque_written.clear()
                        group, raw_group = [], []
                if token in {"(", "{"} and not words:
                    group_close = ")" if token == "(" else "}"
                    end, nesting = index + 1, 1
                    while end < len(tokens) and nesting:
                        if tokens[end] == token:
                            nesting += 1
                        elif tokens[end] == group_close:
                            nesting -= 1
                        end += 1
                    concurrent = _concurrent_group(tokens, end)
                    uncertain = bool(branches) or guarded or concurrent
                    conditional += uncertain
                    uncertain_write += bool(branches) or concurrent or guarded and not safe_chain
                    previous_values = {name: set(values) for name, values in script_values.items()}
                    try:
                        nested, index = walk(index + 1, current, group_close, probe=probe, stop=stop,
                                             binding_preflight=binding_preflight)
                    finally:
                        conditional -= uncertain
                        uncertain_write -= bool(branches) or concurrent or guarded and not safe_chain
                    if token == '(' and not probe:
                        for name in script_values.keys() | previous_values.keys():
                            script_values[name] = script_values.get(name, {'$' + name}) | previous_values.get(name, {'$' + name})
                        opaque_written.clear()
                    if token == "{":
                        mark_cwd_change(current, nested)
                        current = nested
                    continue
                if token == closing:
                    return run(words, current), index + 1
                if token == ';' and branches and branches[-1]['kind'] == 'case':
                    # Arm terminators are one operator, not background jobs or
                    # pipes. Consume the whole operator before the next pattern.
                    terminator = next((parts for parts in [(';', ';', '&'), (';', ';'),
                                                          (';', '&'), (';', '|')]
                                       if tokens[index:index + len(parts)] == list(parts)), None)
                    if terminator:
                        current = run(words, current)
                        words = []
                        guarded = False
                        safe_chain = True
                        frame = branches[-1]
                        frame['pattern'] = True
                        frame['arm_cwd'] = frame['cwd']
                        # A continuing arm can be entered directly or from the
                        # preceding arm. Merge both cwd possibilities before
                        # checking its pattern expansions or relative sources.
                        if terminator != (';', ';') and current != frame['cwd']:
                            frame['arm_cwd'] = None
                            unknown_cause = 'directory changed across continuing case arms'
                        current = frame['arm_cwd']
                        index += len(terminator)
                        continue
                if token in {";", "&&", "||", "|", "&", "\n"}:
                    prior = current
                    current = run(words, current, concurrent=token in {"|", "&"})
                    if token in {"||", "|", "&"} and current != prior:
                        current = None if token == "||" else prior
                    if token in {"&&", "||", "|", "&"}:
                        guarded = True
                        safe_predecessor = bool(words) and (all(re.match(r'^[A-Za-z_]\w*=', word) for word in words) or os.path.basename(words[0]) == 'mkdir')
                        safe_chain = safe_chain and token == '&&' and safe_predecessor
                    elif words:
                        guarded = False
                        safe_chain = True
                    words = []
                elif token in {"if", "while", "until", "for", "case", "select"} and not words:
                    branches.append({"cwd": current, "branch_cwd": current, "changed": False, "kind": token, "pattern": token == "case"})
                    if token in {"for", "select", "case"}:
                        index += 1
                        checked = set()
                        header = []
                        while index < len(tokens) and tokens[index] not in {";", "\n", "do"}:
                            # A case header ends at 'in', before its first arm.
                            if token == "case" and tokens[index] == "in":
                                break
                            header.append(decode_word(tokens[index], header_cwd, depth, quoted, checked, probe, bodies))
                            index += 1
                        if token == 'for' and not probe and header and re.fullmatch(r'[A-Za-z_]\w*', header[0]):
                            name = header[0]
                            invalidate_variable(name)
                            previous = script_values.get(name, {'$' + name})
                            values = set(header[2:]) if header[1:2] == ['in'] and all(not re.search(r'[$`*?\[\]{}~]', word) for word in header[2:]) else {'$' + name}
                            script_values[name] = values or {'$' + name}
                            branches[-1]['script_loop'] = (name, previous)
                elif token in {"elif", "else"} and not words and branches:
                    current = branches[-1]["branch_cwd"]
                elif token in {"then", "do"} and not words:
                    if token == "then" and branches:
                        branches[-1]["branch_cwd"] = current
                elif token in {"fi", "done", "esac"} and not words:
                    if branches:
                        frame = branches.pop()
                        if 'script_loop' in frame:
                            name, previous = frame['script_loop']
                            script_values[name] = script_values.get(name, {'$' + name}) | previous
                        after = None if frame["changed"] else frame["cwd"]
                        if frame['changed'] and frame['cwd'] is not None:
                            remember_reader_directory(frame['cwd'])
                        mark_cwd_change(current, after)
                        current = after
                        if frame["changed"]:
                            unknown_cause = "directory changed in a conditional branch or loop"
                        if end_after_loop and token == 'done' and not branches:
                            return current, index + 1
                else:
                    if not words:
                        words_line = token_lines[index]
                    words.append(token)
                index += 1
            return run(words, current), index

        return walk(0, directory)[0]

    scan(command, Path(cwd) if cwd is not None else None, _depth)
    return paths


def classify_detail(command: str, cwd: str) -> tuple[str | None, str | None]:
    cwd = cwd if isinstance(cwd, str) and cwd else os.getcwd()
    try:
        scripts_in(command, cwd)
    except AmbiguousScript as error:
        return "live-database-script-unresolved", str(error)
    except LiveRead as error:
        match = _database_reference(command)
        detail = error.detail or (f"line {command.count(chr(10), 0, match.start()) + 1} names {_token(match[0])}." if match else
                                  "Command contains a protected database read.")
        return error.rule, detail
    return None, None


def classify(command: str, cwd: str) -> str | None:
    return classify_detail(command, cwd)[0]
