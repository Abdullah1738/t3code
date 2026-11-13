"""Bounded shell/source checks; never opens a database or executes a command."""
from __future__ import annotations

import ast
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import warnings


REPLICA = re.compile(r"(?<![\w.-])\.robob/userdata/readonly/state\.sqlite(?:-(?:wal|shm))?(?![\w./-])")
LIVE = re.compile(
    r"(?:\.robob/userdata/statev2|robob-data/userdata/statev2|\.robob/userdata/\*\.sqlite|"
    # Legacy names and near-misses remain protected; only the replica is public.
    rf"(?!{REPLICA.pattern})\.robob/userdata/(?:[\w.-]+/)*state\.sqlite|"
    r"(?:\.local/share/opencode|opencode-data)/opencode\.db|"
    # The legacy home database is protected; workspace .t3 copies stay isolated.
    rf"(?:{re.escape(str(Path.home()))}|~|\$HOME|\$\{{HOME\}})/\.t3/userdata/statev2)"
)
DATABASE_NAME = re.compile(r"statev2(?:[.-][\w-]+)?\.sqlite|state\.sqlite|opencode\.db")
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
MAX_SHELL_DEPTH = 12
STARTUP_ENV = re.compile(r'(?:BASH_ENV|ENV|BASHOPTS|SHELLOPTS|LD_[A-Za-z_]*|DYLD_[A-Za-z_]*|PYTHON[A-Z_]+)')
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
    "also reads the live file and needs Abdullah's approval first.\n"
    "If only the database can answer, report the exact queries and stop."
)


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
    # This Mac's default Bash is Homebrew's versioned package, not /bin/bash.
    if name == 'bash':
        brew = '/opt/homebrew/bin/bash'
        if re.fullmatch(r'/opt/homebrew/Cellar/bash/[^/]+/bin/bash', os.path.realpath(brew)):
            trusted.add(brew)
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
    if any(value and STARTUP_ENV.fullmatch(name) for name, value in os.environ.items()):
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
        parser = re.search(r'\bconst\s*\{\s*(values)\s*\}\s*=\s*(?:' + identifier + r'\.)*parseArgs\(\s*\{\s*options\s*:\s*\{', code)
        if option and parser and parser.start() < option.start() and re.match(r'\s*,?\s*}', code[end:]):
            # The probe's parseArgs option is another immutable binding. Reject
            # option overrides and unknown uses of the returned values object.
            depth, close = 1, code.index('(', parser.start()) + 1
            while close < len(code) and depth:
                depth += (code[close] == '(') - (code[close] == ')')
                close += 1
            options = code[parser.start():close]
            uses = code
            for access in re.finditer(r'''\bvalues\s*\[\s*(['"])([^'"\n]+)\1\s*\]''', source):
                if access[2] != 'replica' and '\\' not in access[2] and not re.match(r'\s*(?:[+*/%&|?^-]*=(?!=)|\+\+|--)', code[access.end():]):
                    uses = uses[:access.start()] + ' ' * len(access[0]) + uses[access.end():]
            for access in re.finditer(r'\bvalues\.replica\b', code):
                if reader_use(access.start(), access.end()):
                    uses = uses[:access.start()] + ' ' * len(access[0]) + uses[access.end():]
            uses = uses[:parser.start(1)] + ' ' * len(parser[1]) + uses[parser.end(1):]
            safe = (end < close and '...' not in options and
                    len(re.findall(r'\breplica\s*:', options)) == 1 and
                    len(re.findall(r'\boptions\s*:', options)) == 1 and
                    not re.search(r'\bvalues\b', uses))
        if safe:
            discounted.append((start, end))
    for start, end in reversed(discounted):
        source = source[:start] + ' ' * (end - start) + source[end:]
    return source


def _source_hit(source, directory, python=False, shell=False):
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
    # Shell fixture proofs above discharge statev2/opencode paths, not other
    # database names that their setup may also list as data.
    database = re.search(r"statev2\.sqlite|opencode\.db", source) if shell else DATABASE_NAME.search(source)
    return bool(database and (live_root or home_userdata))


def _isolated_migration_source(source, directory):
    # Discharge the one default-source expression only after the caller has
    # supplied isolated --source and --base-dir arguments. All other source
    # text still goes through the live-path check.
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
    # The source argument must reach the sole ATTACH, and every SQLite client
    # must open a destination. An isolated CLI flag proves neither by itself.
    if len(re.findall(r'\bcopySourceSlice\b', source)) != 2 or len(re.findall(r'copySourceSlice\(sourcePath\)', source)) != 1:
        return False
    attach = 'ATTACH DATABASE ${`${NodeURL.pathToFileURL(sourcePath).href}?mode=ro`} AS src'
    if source.count(attach) != 1 or len(re.findall(r'\bATTACH\b', source)) != 1:
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
    url_api = source.replace('import * as NodeURL from "node:url";', '').replace(attach, '')
    if re.search(r'\bNodeOS\b', home_api) or re.search(r'\bNodeURL\b', url_api):
        return False
    path_api = re.sub(r'const path = yield\* Path\.Path;', '', source)
    path_api = re.sub(r'\bpath\.(?:join|resolve|dirname)\s*(?=\()', 'guard_path_operation', path_api)
    path_api = path_api.replace('path to a real statev2.sqlite', 'guard_source_help').replace('path this command rewrites', 'guard_destination_help')
    if re.search(r'\bpath\b', path_api):
        return False
    source_uses = default.sub('', source)
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
        fix = "Use a literal absolute script path."
        if cause and "unbalanced quote" in cause:
            fix = "Close the shell quote before running the command."
        elif cause and ("MAX_SCRIPTS" in cause or "MAX_SHELL_DEPTH" in cause):
            fix = "Split the steps into separate shell calls."
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


def _read_words(words):
    if not words:
        return words
    binary = os.path.basename(words[0])
    if binary == "jq":
        return _jq_read_words(words)
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
        elif token in {"<", ">", ">>", "<<", "<<<"}:
            index += 1
            if index < len(tokens) and tokens[index] in {"&", "|"}:
                index += 1
            index += 1
        elif token in {";", "&&", "||", "|", "&", "\n"}:
            return token in {"|", "&"}
        else:
            index += 1
    return False


def _quoted_punctuation(source, script_literals=False):
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
            output.append(source[index:end])
            index = end
            continue
        if char == "\\" and index + 1 < len(source):
            if script_literals:
                if source[index + 1] == '\n':
                    output.append(source[index:index + 2])
                    index += 2
                    continue
                key = f"\0guard_literal_{len(quoted)}__"
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
            duplicate = re.match(r'(?:\d*)>&(?:\d+|-)', source[index:]) if char == '>' or boundary else None
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
                if source[end] == "\\" and char == '"':
                    end += 2
                    continue
                if source[end] == char:
                    break
                end += 1
            value = source[index + 1:end]
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
    return "".join(output), quoted


def scripts_in(command: str, cwd: str | Path | None, *, _depth=0, _sources=None, _stdin=None, _environment=None) -> list[Path]:
    """Resolve bounded shell paths and inspect sources without executing them."""
    paths = []
    written = {}
    invalidated_written = set()
    write_history = {}
    variable_written = set()
    stdin_words, stdin_bodies = _stdin or ([], {})
    if _sources is not None:
        prior_written, prior_invalidated, prior_history, prior_variable = _sources
        written.update(prior_written)
        invalidated_written.update(prior_invalidated)
        write_history.update((path, list(history)) for path, history in prior_history.items())
        variable_written.update(prior_variable)
    unknown_cause = "directory changed in a conditional branch"
    conditional = 0
    inherited_values, inherited_unsafe, caller_command = _environment or ({}, False, None)
    shell_values = {"HOME": str(Path.home()), **inherited_values}
    path_values = {}
    live_assignments = set()
    # Script bindings keep unknown branch values, unlike the reader's lexical
    # expansion. A safe assignment in one branch cannot prove a script path.
    script_values = {}
    opaque_written = {}
    invocation_written = {}
    invocation_fresh = set()
    invocation_literals = set()
    invocation_reader_literals = set()
    invocation_quoted = set()
    uncertain_write = 0
    unsafe_bindings = inherited_unsafe
    # Opaque paths need a fresh, unmodified root; existing files cannot be
    # assumed replaced when a write fails or is skipped.
    fresh_variables = set()
    populated_variables = set()
    noclobber = False

    def affected_sources(path, descendants=False):
        if path is None:
            return set(written)
        affected = {remembered for remembered in written
                    if remembered == path or descendants and remembered.is_relative_to(path)}
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

    def python_preserves_sources(source, directory):
        try:
            tree = ast.parse(source)
        except (SyntaxError, ValueError):
            return False
        bindings, strings = {}, set()

        def string_value(node):
            return (isinstance(node, ast.Constant) and isinstance(node.value, str) or
                    isinstance(node, ast.Name) and node.id in strings or
                    isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and
                    (node.func.attr == 'read' and isinstance(node.func.value, ast.Call) and _name(node.func.value.func) == 'open' or
                     node.func.attr == 'replace' and string_value(node.func.value)))

        class StringMethods(ast.NodeTransformer):
            def visit_Call(self, node):
                string_replace = isinstance(node.func, ast.Attribute) and node.func.attr == 'replace' and string_value(node.func.value)
                self.generic_visit(node)
                if string_replace:
                    return ast.Tuple(elts=[node.func.value, *node.args, *(k.value for k in node.keywords)], ctx=ast.Load())
                return node

        for statement in tree.body:
            # Only straight-line literal destinations can prove that a data
            # edit leaves remembered scripts alone. Keep all value expressions
            # in the AST so their side effects still face the read-only check.
            if isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call):
                call = statement.value
                if isinstance(call.func, ast.Attribute) and call.func.attr in {'write', 'write_text', 'write_bytes'}:
                    receiver = call.func.value
                    if call.func.attr == 'write' and isinstance(receiver, ast.Call) and _name(receiver.func) == 'open':
                        mode = receiver.args[1] if len(receiver.args) > 1 else next((k.value for k in receiver.keywords if k.arg == 'mode'), None)
                        if not isinstance(mode, ast.Constant) or mode.value not in {'w', 'a', 'wb', 'ab'} or not receiver.args:
                            return False
                        destination = _path_expression(receiver.args[0], bindings, {})
                        values = [*receiver.args, *(k.value for k in receiver.keywords)]
                    elif call.func.attr in {'write_text', 'write_bytes'}:
                        destination = _path_expression(receiver, bindings, {})
                        values = [receiver]
                    else:
                        return False
                    path = _literal_path(destination, directory) if destination is not None else None
                    if path is None or affected_sources(path):
                        return False
                    statement.value = ast.Tuple(elts=[*values, *call.args, *(k.value for k in call.keywords)], ctx=ast.Load())
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

    def may_change_scripts(words, directory, stdin_sources=()):
        words = list(words)
        while words and (words[0] in {'do', 'then', 'else', 'if', '!'} or re.match(r'^[A-Za-z_]\w*=', words[0])):
            words.pop(0)
        if not words or words[0] in {'for', 'while', 'until', 'done', 'fi'}:
            return False
        binary = os.path.basename(words[0])
        if binary in {'bash', 'sh', 'zsh', 'dash', 'ksh', 'node', 'bun', 'deno'} or re.fullmatch(r'python[\d.]*', binary):
            if (binary in {'bash', 'sh', 'zsh', 'dash', 'ksh'} and len(words) == 3 and words[1] == '-n' and
                    not words[2].startswith('-') and not unsafe_bindings and
                    not any(os.environ.get(name) or name in shell_values for name in {'BASH_ENV', 'ENV', 'ZDOTDIR'}) and
                    not any(name.startswith('BASH_FUNC_') for name in os.environ)):
                return False
            if re.fullmatch(r'python[\d.]*', binary):
                args = _interpreter_args(binary, words[1:])
                while args and args[0] in {'-I', '-E', '-s', '-S', '-B', '-u', '-b', '-bb', '-q'}:
                    args.pop(0)
                sources = []
                if len(args) > 1 and args[0] == '-c':
                    sources = [args[1]]
                elif not args or args[0] == '-':
                    sources = list(stdin_sources)
                elif not args[0].startswith('-'):
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
                if sources and all(python_preserves_sources(source, directory) for source in sources):
                    return False
            return True
        # Search writes only to explicit output redirects, checked below.
        if binary == 'linctl' and words[1:3] == ['issue', 'search']:
            return False
        return binary not in {'cat', 'tee', 'mkdir', 'chmod', 'set', 'head', 'tail', 'echo', 'printf', 'true', 'false', ':', 'test', '[', 'ls', 'stat', 'wc', 'pwd'}

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
        populated_variables.discard(name)
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
        nonlocal unsafe_bindings
        name, _, value = word.partition("=")
        if track_scripts:
            if name in {'PATH', 'IFS', 'ENV', 'BASH_ENV', 'BASHOPTS', 'SHELLOPTS', 'ZDOTDIR'}:
                unsafe_bindings = True
            invalidate_variable(name)
            candidates = {value} if word in invocation_literals else script_variants(value)
            script_values[name] = candidates | script_values.get(name, {"$" + name}) if conditional or transient else candidates
            if not conditional and not transient and re.fullmatch(r'\$\(mktemp -d(?: [^;&|()`\n]*)?\)', value):
                fresh_variables.add(name)
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
        if _source_hit(source, directory, python, shell):
            if test_target is not None:
                match = _database_reference(source)
                if match:
                    line = source.count("\n", 0, match.start()) + 1
                    detail = f"{location}:{line} names {_token(match[0])}."
                    runners = {m[2] for m in re.finditer(r"\bimport\s+(?:[^;'\"]*\bfrom\s*)?(['\"])(node:test|vitest|vite-plus/test)\1", source)}
                    if 'node:test' not in runners and runners & {'vitest', 'vite-plus/test'}:
                        detail += f"\nRun tests through the repo runner: vp test run {shlex.quote(test_target)}."
                    raise LiveRead(rule, detail)
            raise LiveRead(rule)

    def migration_source(args, directory):
        source = None
        destination = None
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
                if _direct_read(['cat', value], directory):
                    raise LiveRead("live-database-read")
                raise AmbiguousScript("use literal migrate-dev-db paths without home or variable expansion " + _token(value))
            if flag == "--source":
                if source is not None:
                    raise AmbiguousScript("duplicate migrate-dev-db --source")
                source = _literal_path(value, directory)
                if source is None:
                    raise AmbiguousScript("non-literal migrate-dev-db --source " + _token(value))
            elif flag == "--base-dir":
                destination = _literal_path(value, directory)
                if destination is None:
                    raise AmbiguousScript("non-literal migrate-dev-db --base-dir " + _token(value))
                if _direct_read(['cat', str(destination / 'userdata/statev2.sqlite')], directory):
                    raise LiveRead("live-database-read")
            index += 1
        # Its default is HOME/.t3/userdata/statev2.sqlite, a protected database.
        if source is None or LIVE.search(str(source)):
            raise LiveRead("live-database-read")
        if destination is None:
            raise AmbiguousScript("migrate-dev-db needs an explicit isolated --base-dir")

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
            cause = (f"relative script {_token(value)} after {unknown_cause}" if directory is None and not os.path.isabs(value)
                     else f"non-literal script path {_token(value)} ({binary})")
            raise AmbiguousScript(cause)
        return path

    def add(value, directory, binary="script", migration_args=None, test_target=None):
        for candidate in script_variants(value):
            if candidate != value and (candidate.startswith(('-', '+', '~')) or
                                       any(char in candidate for char in '\\\r\n') or
                                       re.search(r'\s', candidate) and value not in invocation_quoted):
                raise AmbiguousScript(f"non-literal script path {_token(value)} ({binary})")
            if _literal_path(candidate, directory) is None:
                body = invocation_written.get((directory, value)) if value in invocation_quoted and not unsafe_bindings else None
                if body is None:
                    script_path(candidate, directory, binary)
                # Repeated bindings in a combined AST must not hide a read
                # that was visible in one of its appended source fragments.
                for fragment in (*body, ''.join(body)):
                    check_source(fragment, directory, value.endswith(".py"))
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

    def add_literal(value, directory, binary="script", migration_args=None, test_target=None):
        path = script_path(value, directory, binary)
        if len(paths) >= MAX_SCRIPTS:
            raise AmbiguousScript(f"more than MAX_SCRIPTS ({MAX_SCRIPTS}) script invocations")
        if LIVE.search(str(path)) or LIVE.search(os.path.realpath(path)):
            raise LiveRead("live-database-script")
        if path in invalidated_written:
            # A known live source still gets its precise refusal. Otherwise
            # on-disk bytes cannot prove what an intervening writer will run.
            try:
                info = path.stat()
                if stat.S_ISREG(info.st_mode) and info.st_size <= MAX_SOURCE_BYTES:
                    with path.open('rb') as handle:
                        opened = os.fstat(handle.fileno())
                        if stat.S_ISREG(opened.st_mode) and opened.st_size <= MAX_SOURCE_BYTES:
                            source = handle.read(MAX_SOURCE_BYTES + 1)
                            if len(source) <= MAX_SOURCE_BYTES:
                                check_source(source.decode('utf-8', errors='replace'), directory, path.suffix == '.py')
            except OSError:
                pass
            raise AmbiguousScript("script source changed after its heredoc write " + _token(value))
        if path not in paths:
            paths.append(path)
        try:
            proof_command = command if caller_command is None else caller_command
            redirect = re.search(r'\s+>\s+([^\s;&|<>$`]+)\s+2>&1\s*$', proof_command)
            destination = shlex.split(redirect[1]) if redirect else []
            if redirect and (len(destination) != 1 or _direct_read(['cat', destination[0]], directory)):
                raise LiveRead('live-database-script')
            plain = proof_command[:redirect.start()] if redirect else proof_command
            invocation = shlex.split(plain, comments=True)
            if invocation[:2] == ['offbox', 'run']:
                if invocation[2:3] == ['--']:
                    invocation = invocation[3:]
                elif invocation[2:4] == ['--bg', '--']:
                    invocation = invocation[4:]
                elif invocation[2:5] == ['--remote', '--no-fallback', '--']:
                    invocation = invocation[5:]
        except ValueError:
            invocation = []
        shell = (binary in {'bash', 'sh', 'zsh', 'dash', 'ksh'} and len(invocation) == 2 and
                 os.path.basename(invocation[0]) == binary and invocation[1] == value and
                 _trusted_fixture_tool(invocation[0], binary, directory) and
                 not value.startswith(('~', '$')) and '\\\n' not in proof_command and '\\\r\n' not in proof_command and
                 not any(os.environ.get(name) or name in shell_values for name in ('BASH_ENV', 'ENV')) and
                 not any(name.startswith('BASH_FUNC_') for name in os.environ))
        if path in written:
            body, replaced = written[path]
            if path in variable_written:
                for fragment in write_history[path]:
                    check_source(fragment, directory, path.suffix == '.py')
            check_source(body, directory, path.suffix == ".py", shell=shell, test_target=test_target, location=path)
            if replaced:
                return
        try:
            info = path.stat()
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_SOURCE_BYTES:
                return
            with path.open("rb") as handle:
                opened = os.fstat(handle.fileno())
                if not stat.S_ISREG(opened.st_mode) or opened.st_size > MAX_SOURCE_BYTES:
                    return
                source = handle.read(MAX_SOURCE_BYTES + 1)
            if len(source) <= MAX_SOURCE_BYTES:
                if migration_args is not None and _isolated_migration_source(source.decode('utf-8', errors='replace'), directory):
                    migration_source(migration_args, directory)
                    return
                check_source(source.decode("utf-8", errors="replace"), directory, path.suffix == ".py", shell=shell, test_target=test_target, location=path)
        except OSError:
            pass

    def decode_word(value, directory, depth, quoted, checked, cwd_only=False, bodies=None):
        nonlocal conditional, uncertain_write
        for key, literal in reversed(quoted.items()):
            if key in value and key not in checked and not key.startswith('\0guard_literal_') and literal.startswith(("${", "$(", "`")) and not cwd_only:
                checked.add(key)
                for substitution in _substitutions(literal, shell=True):
                    conditional += 1
                    uncertain_write += 1
                    try:
                        scan(substitution, directory, depth + 1, inherited_bodies=bodies)
                    finally:
                        conditional -= 1
                        uncertain_write -= 1
            value = value.replace(key, literal)
        return value

    def scan_child(source, directory, depth):
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

    def scan_remote(source, directory, depth, input_words=(), input_bodies=None, inherit_environment=False):
        # Synced source evidence may be read remotely, but remote writes,
        # bindings and cwd cannot prove anything about the caller's files.
        # offbox may fall back to running locally, so its payload keeps the
        # caller's startup and lookup bindings (BASH_ENV, PATH, ...), and the
        # exact-invocation proof still reads the caller's whole command.
        environment = None
        if inherit_environment:
            environment = ({name: value for name, value in shell_values.items()
                            if STARTUP_ENV.fullmatch(name) or name in {'ZDOTDIR', 'PATH', 'IFS'}},
                           unsafe_bindings, caller_command if caller_command is not None else command)
        remote_paths = scripts_in(source, directory, _depth=depth,
                                  _sources=(written, invalidated_written, write_history, variable_written),
                                  _stdin=(input_words, input_bodies or {}), _environment=environment)
        paths.extend(path for path in remote_paths if path not in paths)
        if len(paths) > MAX_SCRIPTS:
            raise AmbiguousScript(f"more than MAX_SCRIPTS ({MAX_SCRIPTS}) script invocations")

    def inspect(words, directory, depth, bodies, quoted, changed_sources, cwd_only=False):
        nonlocal unknown_cause, invocation_written, invocation_fresh, invocation_literals, invocation_reader_literals, invocation_quoted, unsafe_bindings, noclobber
        words = list(words)
        if stdin_words and not any(word in {'<<', '<<<', '<'} for word in words):
            words.extend(stdin_words)
        checked = set()
        literal_words = set()
        reader_literal_words = set()
        double_words = set()
        unquoted_words = set()
        def decode(value):
            decoded = decode_word(value, directory, depth, quoted, checked, cwd_only, bodies)
            reader_word = value
            for key, text in reversed(quoted.items()):
                if key.startswith('\0guard_literal_double_'):
                    text = re.sub(r'\\[$`"\\\n]', '', text)
                elif key.startswith('\0guard_literal_'):
                    text = ''
                reader_word = reader_word.replace(key, text)
            if not re.search(r'[$`]', reader_word):
                reader_literal_words.add(decoded)
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
            if words[index] in {"<<", "<<<", ">", ">>", "<"} and index + 1 < len(words):
                op, value = words[index:index + 2]
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
                    redirects.append((op, decode(value)))
                del words[index:index + 2]
            else:
                index += 1
        raw_words = list(words)
        words = [decode(word) for word in words]
        invocation_literals = literal_words
        invocation_reader_literals = reader_literal_words
        invocation_quoted = double_words - unquoted_words

        def caller_argv(count):
            # Prefix unwrapping only removes words from the front. Preserve
            # literal quote segments until caller expansions are complete.
            bindings = {'HOME': {str(Path.home())}, **({'PWD': {str(directory)}} if directory is not None else {}),
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
                for match in re.finditer(r'\0guard_(?:quoted|double|literal(?:_double|_remote)?)_\d+__', text):
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
        if not cwd_only and any(re.match(r'^[A-Za-z_]\w*(?:\+|\[)', word) for word in words):
            script_values.clear()
            opaque_written.clear()
        caller_directory = directory
        child_directory = False
        while words:
            binary = os.path.basename(words[0])
            if re.match(r"^[A-Za-z_]\w*=", words[0]):
                transient = any(not re.match(r'^[A-Za-z_]\w*=', word) for word in words)
                remember_assignment(words.pop(0), directory, not cwd_only, transient)
            elif binary in {"then", "do", "else", "!"}:
                words.pop(0)
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
                    if re.match(r"^[A-Za-z_]\w*=", flag):
                        remember_assignment(flag, directory, not cwd_only, True)
                    elif flag in {"-C", "--chdir"}:
                        child_directory = True
                        directory = _literal_path(words.pop(0), directory) if words else None
                    elif flag.startswith("--chdir="):
                        child_directory = True
                        directory = _literal_path(flag.split("=", 1)[1], directory)
                    elif flag in {"-u", "--unset"} and words:
                        words.pop(0)
                    elif flag in {"-S", "--split-string"} and words:
                        scan(words.pop(0), directory, depth + 1)
                    elif flag.startswith("--split-string="):
                        scan(flag.split("=", 1)[1], directory, depth + 1)
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
                            directory = _literal_path(value, directory)
                while words and words[0].startswith("-"):
                    flag = words.pop(0)
                    if flag in {"--directory", "--project", "--python", "--with", "--group", "--extra"}:
                        value = words.pop(0) if words else ""
                        if flag == "--directory":
                            child_directory = True
                            directory = _literal_path(value, directory)
            elif binary == "offbox" and words[1:2] == ["run"] and "--" in words[2:]:
                words = words[words.index("--", 2) + 1:]
                remote_input, remote_bodies = [], {key: bodies[key] for key in document_keys}
                for key in document_keys:
                    remote_input.extend(['<<', key])
                for text, exact in here_strings:
                    key = f'__guard_remote_stdin_{len(remote_bodies)}__'
                    remote_bodies[key] = (text, exact)
                    remote_input.extend(['<<', key])
                for op, target in redirects:
                    if op == '<':
                        remote_input.extend([op, target])
                if words:
                    for argv in caller_argv(len(words)):
                        scan_remote(argv[0] if len(argv) == 1 else shlex.join(argv), directory, depth + 1,
                                    remote_input, remote_bodies, inherit_environment=True)
                    if may_change_scripts(words, directory, documents):
                        changed_sources.update(written)
                        fresh_variables.clear()
                # Local output redirects still need the normal invalidation
                # pass after the remote command has been checked.
                words = ['true']
                break
            else:
                break
        if not words:
            return caller_directory if child_directory else directory
        binary, args = os.path.basename(words[0]), words[1:]
        if binary in {'set', 'bash', 'sh', 'zsh', 'dash', 'ksh'}:
            for arg in args:
                for option in script_variants(arg):
                    if re.fullmatch(r'-[A-Za-z]*C[A-Za-z]*', option) or option == 'noclobber' or binary == 'set' and '$' in option:
                        noclobber = True
        if binary in {'trap', 'alias', 'unalias', 'enable', 'builtin', 'shopt', 'setopt'}:
            unsafe_bindings = True
        after = caller_directory if child_directory else directory
        if binary in {"export", "readonly", "declare", "typeset", "local"}:
            if not cwd_only:
                if binary in {'declare', 'typeset', 'local'} and any(re.fullmatch(r'-[A-Za-z]*[naiA][A-Za-z]*', arg) for arg in args):
                    unsafe_bindings = True
                if any(arg.partition('=')[0] in {'PATH', 'IFS', 'ENV', 'BASH_ENV', 'BASHOPTS', 'SHELLOPTS', 'ZDOTDIR'} for arg in args):
                    unsafe_bindings = True
                script_values.clear()
                opaque_written.clear()
            for arg in args:
                if re.match(r"^[A-Za-z_]\w*=", arg):
                    remember_assignment(arg, directory, False)
            return after
        if binary == "cd":
            args = [arg for arg in args if arg not in {"--", "-L", "-P"}]
            changed = _literal_path(args[0] if args else str(Path.home()), directory) if len(args) <= 1 else None
            if changed is None and "loop that changes directory" not in unknown_cause:
                unknown_cause = "cd to a non-literal directory " + _token(args[0] if args else "")
            return after if child_directory else changed
        if binary in {"pushd", "popd"}:
            unknown_cause = "pushd/popd changes the directory"
            return None
        if cwd_only:
            return scan(" ".join(args), directory, depth + 1, cwd_only=True) if binary == "eval" else after
        if binary in {'read', 'readarray', 'mapfile', 'unset', 'eval', 'source', '.', 'let', 'getopts'}:
            script_values.clear()
            opaque_written.clear()
        if binary in {'printf', 'wait'} and any(arg in {'-v', '-p'} for arg in args):
            script_values.clear()
            opaque_written.clear()
        invocation_written = dict(opaque_written)
        invocation_fresh = set(fresh_variables)
        # Unknown commands can replace a remembered opaque file. A command
        # may use its own source proof, but later commands cannot reuse it.
        if binary not in {'cat', 'tee', 'mkdir'}:
            opaque_written.clear()
        stdin_sources = documents if exact_documents and not here_strings and not any(op == '<' for op, _ in redirects) else []
        if may_change_scripts(words, directory, stdin_sources):
            changed_sources.update(written)
            fresh_variables.clear()
        if binary == 'chmod' or binary in {'bash', 'sh', 'zsh', 'dash', 'ksh', 'node', 'bun', 'deno'} or re.fullmatch(r'python[\d.]*', binary):
            fresh_variables.clear()
        if words[0].startswith(('/', './', '../')) and re.search(r'\.(?:py|mjs|cjs|js|ts|sh)$', words[0]):
            fresh_variables.clear()
        if binary in {'cp', 'mv', 'rsync', 'ditto', 'install', 'tee', 'sed', 'perl', 'truncate'}:
            for arg in args:
                for candidate in script_variants(arg):
                    target = _literal_path(candidate, directory)
                    if target is not None:
                        invalidated_written.update(affected_sources(target, descendants=True))
        if binary == "vp" and args[:2] == ["run", "migrate-dev-db"]:
            if any(_direct_read(['cat', *values], directory)
                   for values in variants([v for op, v in redirects if op == '<'])):
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
        if python or binary in shells | {"bun", "deno"}:
            args = _interpreter_args(binary, args)
        node_test = False
        node_inputs = []
        node_runtime_options = False
        if binary == 'node':
            args, node_inputs, node_test, node_runtime_options = _node_arguments(args)
        if binary in {'bun', 'deno'} and args[:1] == ['run']:
            args = _interpreter_args(binary, args[1:])
        program_args = list(args)
        while program_args and program_args[0].startswith('-') and program_args[0] != '-':
            flag = program_args.pop(0)
            if flag in {'--', '-c', '-e', '--eval', '-p', '--print', '-m'}:
                break
        stdin_code = not args or program_args[:1] == ['-'] or all(arg.startswith('-') for arg in args)
        shell_stdin = binary in shells and any(re.fullmatch(r'-[a-z]*s[a-z]*', arg) for arg in args[:len(args) - len(program_args)])
        shell_command = binary in shells and any(re.fullmatch(r'-[a-z]*c[a-z]*', arg) for arg in args[:len(args) - len(program_args)])
        stdin_code |= shell_stdin and not shell_command
        # Any redirect other than the recognized heredoc writer invalidates
        # that file's prior source proof, including append and fd redirects.
        for op, target in redirects:
            if op not in {'>', '>>'}:
                continue
            # Opaque roots can alias through a second variable or spelling.
            # No intervening output proves it left the remembered file alone.
            opaque_written.clear()
            for candidate in script_variants(target):
                path = _literal_path(candidate, directory)
                affected = affected_sources(path)
                if documents and binary in {'cat', 'tee'}:
                    affected.discard(path)
                invalidated_written.update(affected)
        if binary == 'tee':
            opaque_written.clear()
        tee_options = binary == 'tee' and all(arg and (not arg.startswith('-') or arg in {'-a', '--append', '--'}) for arg in args)
        writer = not noclobber and exact_documents and not here_strings and not any(op == '<' for op, _ in redirects) and (binary == 'cat' and args in ([], ['-'], ['--']) or tee_options)
        if not (writer and documents) and (any(op in {'>', '>>'} for op, _ in redirects) or binary == 'tee'):
            fresh_variables.clear()
        if (documents or here_strings) and binary in {'cat', 'tee'} and not writer:
            for op, target in redirects:
                if op in {'>', '>>'}:
                    for candidate in script_variants(target):
                        path = _literal_path(candidate, directory)
                        if path is not None:
                            invalidated_written.add(path)
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
                                invalidated_written.discard(path)
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
                            all(name in fresh_variables for name in references) and
                            all(name in script_values and '$' + name not in script_values[name] for name in references) and
                            not any(char in target for char in '`*?[') and '$(' not in target):
                        prior = invocation_written.get((directory, target))
                        if append and prior is not None or not append and not any(name in populated_variables for name in references):
                            opaque_written[(directory, target)] = (*prior, *documents) if append else tuple(documents)
                            populated_variables.update(references)
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
                _direct_read(['cat', *listing_reads], directory)):
            # Environment-selected config files are read even in listing mode.
            raise LiveRead('live-database-read')
        if any(_direct_read(values + assignment_reads, directory)
               for values in variants(read_words)):
            if python and any(flag in words for flag in {"-c", "-e"}) and any(".write_text(" in word or ".write_bytes(" in word for word in words):
                match = _database_reference(" ".join(read_words[1:]))
                if match:
                    raise LiveRead("live-database-read", f"Inline-code argument names {_token(match[0])}; it cannot be verified as data only.\n"
                                   "Use apply_patch to write report data containing protected database paths.")
            raise LiveRead("live-database-read")
        if any(_direct_read(["cat", *values], directory)
               for values in variants([v for op, v in redirects if op == "<"])):
            raise LiveRead("live-database-read")
        if stdin_code and (python or binary in shells | {'node', 'bun', 'deno'}):
            for op, target in redirects:
                if op == '<':
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
            return after
        if binary in shells:
            if any(re.fullmatch(r"-[a-z]*n[a-z]*", arg) for arg in args):
                return after
            index = next((i for i, arg in enumerate(args) if re.fullmatch(r"-[a-z]*c[a-z]*", arg)), None)
            if index is not None:
                if index + 1 < len(args):
                    scan_child(args[index + 1], directory, depth + 1)
                return after
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
            return after
        interpreter = binary in shells | {"node", "bun", "deno"} or re.fullmatch(r"python[\d.]*", binary)
        if interpreter or binary in {"source", "."}:
            while args and args[0].startswith("-"):
                if args[0] == '-':
                    return after
                flag = args.pop(0)
                if flag in {"-c", "-e", "--eval", "-p", "--print", "-m"}:
                    if flag == "-m" and python and args:
                        module = args[0].replace(".", "/") + ".py"
                        if directory is not None:
                            candidates = [module] + [arg if arg.endswith(".py") else arg.replace(".", "/") + ".py" for arg in args[1:] if not arg.startswith("-")]
                            candidates += [candidate[:-3] + "/__main__.py" for candidate in candidates]
                            candidates += [str(parent / "__init__.py") for candidate in candidates for parent in Path(candidate).parents if parent != Path(".")]
                            if args[0] == "unittest" and "discover" in args:
                                start, pattern = ".", "test*.py"
                                for i, arg in enumerate(args):
                                    if arg in {"-s", "--start-directory"} and i + 1 < len(args):
                                        start = args[i + 1]
                                    elif arg in {"-p", "--pattern"} and i + 1 < len(args):
                                        pattern = args[i + 1]
                                start_path = _literal_path(start, directory)
                                if start_path is None:
                                    raise AmbiguousScript("non-literal unittest discovery directory " + _token(start))
                                candidates += [str(path) for path in written if path.is_relative_to(start_path) and (path.match(pattern) or path.name == "__init__.py")]
                            for candidate in candidates:
                                if _literal_path(candidate, directory) in written:
                                    add(candidate, directory, binary)
                    elif args and binary not in shells:
                        check_source(args[0], directory, python, "live-database-read")
                    return after
                if flag == "--":
                    break
            if shell_stdin and not shell_command:
                return after
            if args and args[0] != "-":
                targets = args if node_test else args[:1]
                for target in targets:
                    if not target.startswith("-"):
                        migration_args = (args[1:] if binary == "node" and len(words) > 1 and words[1] == target and
                                          Path(target).name == "migrate-dev-db.ts" else None)
                        if migration_args is not None:
                            migration_context(words)
                        add(target, directory, binary, migration_args, target if node_test else None)
                        if python and Path(target).name == 'offbox.py' and args[1:2] == ['ssh'] and len(args) > 3:
                            remote = args[3:]
                            for argv in caller_argv(len(remote)):
                                scan_remote(argv[0] if len(argv) == 1 else shlex.join(argv), directory, depth + 1)
        elif words[0].startswith(("/", "./", "../", "~/", "$HOME/", "${HOME}/")) and re.search(r"\.(?:py|mjs|cjs|js|ts|sh)$", words[0]):
            add(words[0], directory, binary)
        return after

    def scan(source, directory, depth=0, cwd_only=False, inherited_bodies=None):
        nonlocal unsafe_bindings
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
        if (re.search(r'\(\(|(?:^|[;&|()\n])\s*(?:function\s+[A-Za-z_]\w*|[A-Za-z_]\w*\s*\(\s*\)\s*\{)', source) or
                any(not re.fullmatch(r'\$\{[A-Za-z_]\w*\}', match[0]) for match in re.finditer(r'\$\{[^}]*\}', source))):
            unsafe_bindings = True
            opaque_written.clear()
        source, quoted = _quoted_punctuation(source, script_literals=True)
        lexer = shlex.shlex(source, posix=True, punctuation_chars=";&|(){}\n<>")
        lexer.whitespace = " \t\r"
        lexer.whitespace_split = True
        try:
            tokens = []
            for token in lexer:
                if re.fullmatch(r"[;&|(){}\n<>]+", token):
                    tokens.extend(re.findall(r"&&|\|\||<<<|<<-?|>>|[^\s]|\n", token))
                else:
                    tokens.append(token)
        except ValueError:
            if SCRIPT.search(source) or DIRECT.search(source) or READER.search(source) or any(value.startswith("${") for value in quoted.values()):
                raise AmbiguousScript(f"shell text could not be parsed (unbalanced quote near line {lexer.lineno})")
            return None

        def walk(index, current, closing=None, probe=cwd_only, stop=None):
            nonlocal unknown_cause, conditional, uncertain_write
            words = []
            branches = []
            guarded = False
            safe_chain = True

            def run(words, current, concurrent=False):
                nonlocal conditional, uncertain_write
                before = current
                uncertain = bool(branches) or guarded or concurrent
                conditional += uncertain
                uncertain_write += bool(branches) or concurrent or guarded and not safe_chain
                changed_sources = set()
                try:
                    current = inspect(words, current, depth, bodies, quoted, changed_sources, cwd_only=probe) if words else current
                finally:
                    invalidated_written.update(changed_sources)
                    conditional -= uncertain
                    uncertain_write -= bool(branches) or concurrent or guarded and not safe_chain
                if before != current:
                    for frame in branches:
                        frame["changed"] = True
                return current

            while index < (len(tokens) if stop is None else stop):
                token = tokens[index]
                header_cwd = current
                if token in {"for", "while", "until", "select"} and not words and not probe:
                    # Any iteration can inherit the cwd left by the preceding
                    # one. Preflight loop bodies before resolving relative paths.
                    end, nesting = index + 1, 1
                    while end < len(tokens) and nesting:
                        if tokens[end] in {"for", "while", "until", "select"}:
                            nesting += 1
                        elif tokens[end] == "done":
                            nesting -= 1
                        end += 1
                    if walk(index, current, probe=True, stop=end)[0] != current:
                        current = None
                        unknown_cause = "a loop that changes directory"
                    # The next iteration may inherit any assignment from the
                    # body, including one after an earlier script invocation.
                    segment = [decode_word(word, current, depth, quoted, set(), True, bodies) for word in tokens[index + 1:end]]
                    if any(word in {'read', 'readarray', 'mapfile', 'unset', 'printf', 'let', 'getopts', 'eval', 'source', '.', 'wait', 'local', 'declare', 'typeset', 'export', 'readonly', 'trap', 'alias', 'unalias', 'enable', 'builtin', 'shopt', 'setopt'} or re.match(r'^[A-Za-z_]\w*(?:\+|\[)', word) for word in segment):
                        script_values.clear()
                        opaque_written.clear()
                    for offset, decoded in enumerate(segment):
                        assignment = re.match(r'^([A-Za-z_]\w*)=', decoded)
                        loop_name = segment[offset + 1] if decoded in {'for', 'select'} and offset + 1 < len(segment) else None
                        if assignment or loop_name and re.fullmatch(r'[A-Za-z_]\w*', loop_name):
                            name = assignment[1] if assignment else loop_name
                            script_values[name] = {'$' + name}
                            invalidate_variable(name)
                    group = []
                    body = segment[segment.index('do') + 1:] if 'do' in segment else []
                    for word in body + [';']:
                        if word not in {';', '\n', '&&', '||', '|', '&'}:
                            group.append(word)
                            continue
                        targets = [group[i + 1] for i, token in enumerate(group[:-1]) if token in {'>', '>>'}]
                        if may_change_scripts(group, current):
                            invalidated_written.update(written)
                        if group and os.path.basename(group[0]) in {'cp', 'mv', 'rsync', 'ditto', 'tee', 'sed', 'perl', 'truncate'}:
                            targets += group[1:]
                        for target in targets:
                            for candidate in script_variants(target):
                                path = _literal_path(candidate, current)
                                invalidated_written.update(affected_sources(path, descendants=True))
                        if targets:
                            opaque_written.clear()
                        group = []
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
                        nested, index = walk(index + 1, current, group_close, probe=probe, stop=stop)
                    finally:
                        conditional -= uncertain
                        uncertain_write -= bool(branches) or concurrent or guarded and not safe_chain
                    if token == '(' and not probe:
                        for name in script_values.keys() | previous_values.keys():
                            script_values[name] = script_values.get(name, {'$' + name}) | previous_values.get(name, {'$' + name})
                        opaque_written.clear()
                    if token == "{":
                        if nested != current:
                            for frame in branches:
                                frame["changed"] = True
                        current = nested
                    continue
                if token == closing:
                    return run(words, current), index + 1
                if branches and branches[-1]["kind"] == "case" and branches[-1].get("pattern") and token == "|":
                    checked = set()
                    for word in words:
                        decode_word(word, branches[-1]["cwd"], depth, quoted, checked, probe, bodies)
                    words = []
                    current = branches[-1]["cwd"]
                    index += 1
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
                    if token == ";" and index and tokens[index - 1] == ";" and branches and branches[-1]["kind"] == "case":
                        branches[-1]["pattern"] = True
                        current = branches[-1]["cwd"]
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
                        current = None if frame["changed"] else frame["cwd"]
                        if frame["changed"]:
                            unknown_cause = "directory changed in a conditional branch or loop"
                elif branches and branches[-1]["kind"] == "case" and token == ")":
                    checked = set()
                    for word in words:
                        decode_word(word, branches[-1]["cwd"], depth, quoted, checked, probe, bodies)
                    words = []
                    current = branches[-1]["cwd"]
                    branches[-1]["pattern"] = False
                else:
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
        return error.rule, error.detail
    return None, None


def classify(command: str, cwd: str) -> str | None:
    return classify_detail(command, cwd)[0]
