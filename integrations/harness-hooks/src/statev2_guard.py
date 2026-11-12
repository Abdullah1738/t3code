"""Bounded shell/source checks; never opens a database or executes a command."""
from __future__ import annotations

import ast
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat


LIVE = re.compile(
    r"(?:\.robob/userdata/statev2|robob-data/userdata/statev2|\.robob/userdata/\*\.sqlite|"
    r"(?:\.local/share/opencode|opencode-data)/opencode\.db|"
    # The legacy home database is protected; workspace .t3 copies stay isolated.
    rf"(?:{re.escape(str(Path.home()))}|~|\$HOME|\$\{{HOME\}})/\.t3/userdata/statev2)"
)
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
# Only this inspected implementation uses --source for every source DB read.
# A changed script falls back to source inspection until reviewed again.
MIGRATE_SOURCE_SHA256 = "65998cc5a8ed461fc03c8ca1acbf6dad50958a6cfbef978d9009e815237e151b"
BACKUP_FIXTURE_SHA256 = "a61b75ca544511c4d73829953ae0e1cd9b4b344f5f052d12127609b296d4a713"
REASON = (
    "statev2 guard: this command was NOT run (owner incident 2026-11-05).\n"
    "Shell reads of Robob's live statev2.sqlite and OpenCode's live opencode.db are blocked, "
    "including sqlite3/python/node scripts and read-only SQL. They contend with the live writers.\n"
    "Use Robob tools/APIs (board_*/card_*, t3ctl, /api/ardud/control/*), recall for past sessions, "
    "or server traces instead. Work on an existing isolated copy. Creating a copy or VACUUM INTO "
    "also reads the live file and needs Abdullah's approval first.\n"
    "If only the database can answer, report the exact queries and stop."
)
UNRESOLVED_REASON = (
    "statev2 guard: this command was NOT run. The effective directory or path of an explicit "
    "script invocation could not be established, so its live-database access cannot be checked. "
    "Use a literal absolute script path and an explicit workdir; do not bypass the guard."
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
    if "statev2" not in source and "opencode.db" not in source:
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


def _python_touches_live(source, directory):
    relative_live = _relative_source_live(source, directory)
    mentions = source_touches_live(source) or relative_live
    changed_directory = bool(re.search(r"\bchdir\b", source) and
                             ("statev2.sqlite" in source or "opencode.db" in source) and
                             (relative_live or re.search(r"\.robob|robob-data|\.local/share/opencode|opencode-data", source)))
    if not mentions and not changed_directory and not (directory is not None and any(LIVE.search(str(directory / name)) for name in {"statev2.sqlite", "opencode.db"})):
        return False
    try:
        tree, aliases, bindings = _python_tree(source)
    except (SyntaxError, ValueError):
        return True
    db = {"sqlite3", "apsw", "sqlalchemy", "duckdb", "peewee"}
    direct_callables = {id(n.func) for n in ast.walk(tree) if isinstance(n, ast.Call)}
    for node in ast.walk(tree):
        name = _name(node)
        root, *rest = name.split(".")
        canonical = ".".join([aliases.get(root, root), *rest])
        if canonical.split(".")[0] in db:
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
            if any(m.split(".")[0] in db | {"builtins", "importlib"} for m in modules):
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


def _shell_fixture_source(source):
    """Discount only paths rooted in single, literal mktemp assignments."""
    try:
        shell, _ = _heredocs(source)
        shell, quoted = _quoted_punctuation(shell)
        lexer = shlex.shlex(shell, posix=True, punctuation_chars=";&|(){}\n")
        lexer.whitespace = " \t\r"
        lexer.whitespace_split = True
        tokens = list(lexer)
    except (ValueError, AmbiguousScript):
        return source
    audited = hashlib.sha256(source.encode()).hexdigest() == BACKUP_FIXTURE_SHA256
    # Merely assigning in a skipped branch or uncalled function leaves the
    # inherited value intact. The committed backup test has audited setup
    # calls; other bodies need a straight-line proof.
    if not audited and any(token in {'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'case', 'select', 'do', 'done', 'function', 'ln', 'hash'} or token.startswith(('PATH=', 'PATH+=')) or re.fullmatch(r'[;&|(){}\n]*[&|(){}][;&|(){}\n]*', token) for token in tokens):
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
    if not audited:
        # Keep the general proof closed: only ordered mktemp assignments and
        # a literal fixture read. Other setup belongs in an audited test body.
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
            # A computed command word can run side effects before cat sees
            # the fixture path, invalidating its isolated-root proof.
            if not re.fullmatch(r'[\w./+-]+', executable, re.ASCII) or os.path.basename(executable) != 'cat':
                return source
            fixture = re.fullmatch(r'\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})/\.robob/userdata/statev2\.sqlite(?:-(?:wal|shm|journal))?', value)
            if not fixture or (fixture[1] or fixture[2]) not in assigned:
                return source
    for name in proven:
        fixture = r"(?<![\w/.$-])\$(?:" + re.escape(name) + r"\b|\{" + re.escape(name) + r"\})/\.robob/userdata/statev2(?:\.sqlite)?"
        assignment = re.search(r'(?m)^[ \t]*' + re.escape(name) + r'="?\$\(mktemp ', source)
        if not audited and assignment and any(match.start() < assignment.start() for match in re.finditer(fixture, source)):
            continue
        source = re.sub(fixture, 'guard_isolated_fixture', source)
    return source


def _source_hit(source, directory, python=False, shell=False):
    if python:
        return _python_touches_live(source, directory)
    if shell:
        source = _shell_fixture_source(source)
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
    # Other languages have no text-only AST exemption. Preserve their existing
    # conservative treatment of paths split across variables or join calls.
    return bool("statev2.sqlite" in source and re.search(r"\.robob|robob-data", source) or
                "opencode.db" in source and re.search(r"\.local/share|opencode-data|[\"']opencode[\"']", source))


class AmbiguousScript(Exception):
    """An explicit script invocation has no statically established location."""


class LiveRead(Exception):
    def __init__(self, rule):
        self.rule = rule


def _token(value):
    return repr(value[:80]).replace("\n", " ")


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


def _heredocs(source, offset=0, known=()):
    lines = source.splitlines(keepends=True)
    output, bodies = [], {}
    index = 0
    while index < len(lines):
        line = lines[index]
        index += 1
        matches, quote, escaped, substitutions = [], None, False, []
        i = 0
        while i < len(line):
            char = line[i]
            if escaped:
                escaped = False
            elif char == "\\" and quote != "'":
                escaped = True
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
            elif line.startswith("<<", i) and not line.startswith("<<<", i):
                match = re.match(r"<<(-)?[ \t]*(?:'([^']+)'|\"([^\"]+)\"|([^\s;&|<>()'\"]+))", line[i:])
                if match:
                    delimiter = next(x for x in match.groups()[1:] if x is not None)
                    if delimiter not in known:
                        key = f"__guard_heredoc_{offset + len(bodies) + len(matches)}__"
                        matches.append((i, i + match.end(), bool(match[1]), delimiter, key, match[2] is not None or match[3] is not None))
                    i += match.end() - 1
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
                raise AmbiguousScript("unterminated heredoc " + _token(delimiter))
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


def _read_words(words):
    if not words:
        return words
    binary = os.path.basename(words[0])
    if binary == "jq":
        return _jq_read_words(words)
    listing = binary == "rg" and "--files" in words
    fd_listing = binary in {"fd", "fdfind"} and not any(w in {"-x", "-X", "--exec", "--exec-batch"} or w.startswith(("--exec=", "--exec-batch=")) for w in words)
    find_listing = binary == "find" and not any(w in {"-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls"} or w.startswith("-fprint") for w in words)
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
    words = _read_words(words)
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


def _concurrent_group(tokens, index):
    while index < len(tokens):
        token = tokens[index]
        if token == "&" and index + 1 < len(tokens) and tokens[index + 1] in {">", ">>"}:
            index += 3
        elif token in {"<", ">", ">>", "<<"}:
            index += 1
            if index < len(tokens) and tokens[index] in {"&", "|"}:
                index += 1
            index += 1
        elif token in {";", "&&", "||", "|", "&", "\n"}:
            return token in {"|", "&"}
        else:
            index += 1
    return False


def _quoted_punctuation(source):
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
            output.append(source[index:index + 2])
            index += 2
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
            if end < len(source) and re.fullmatch(r"[;&|(){}\n<>]+", value):
                key = f"{prefix}{len(quoted)}__"
                quoted[key] = value
                output.append(key)
            else:
                output.append(source[index:end + 1])
            index = end + 1
            continue
        output.append(char)
        index += 1
    return "".join(output), quoted


def scripts_in(command: str, cwd: str) -> list[Path]:
    """Track literal cwd changes without evaluating shell code or variables."""
    paths = []
    written = {}
    unknown_cause = "directory changed in a conditional branch"
    conditional = 0
    shell_values = {"HOME": str(Path.home())}
    path_values = {}
    live_assignments = set()

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

    def remember_assignment(word, directory):
        name, _, value = word.partition("=")
        candidates = [values[0] for values in variants([value])]
        shell_values[name] = expand(value)
        for candidate in candidates:
            path = _literal_path(candidate, directory)
            if re.search(r"\.robob|robob-data|\.local/share/opencode|opencode-data", candidate):
                path_values.setdefault(name, set()).add(candidate)
            if LIVE.search(candidate) or path is not None and LIVE.search(str(path)):
                # Branches and env prefixes may not execute; retain possible
                # bindings rather than letting a later assignment erase them.
                live_assignments.add(str(path) if path is not None else candidate)

    def check_source(source, directory, python=False, rule="live-database-script", shell=False):
        if _source_hit(source, directory, python, shell):
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
        # A preceding edit or link can invalidate both the source hash and
        # realpath before execution. Keep this exception to one plain call.
        try:
            plain = shlex.split(command, comments=True)
        except ValueError:
            plain = []
        if (plain != words or os.environ.get('NODE_OPTIONS') or
                '\\\n' in command or '\\\r\n' in command):
            raise AmbiguousScript("run migrate-dev-db alone without runtime options; split preparation into a separate call")

    def add(value, directory, binary="script", migration_args=None):
        path = _literal_path(value, directory)
        if path is None:
            cause = (f"relative script {_token(value)} after {unknown_cause}" if directory is None and not os.path.isabs(value)
                     else f"non-literal script path {_token(value)} ({binary})")
            raise AmbiguousScript(cause)
        if len(paths) >= MAX_SCRIPTS:
            raise AmbiguousScript(f"more than MAX_SCRIPTS ({MAX_SCRIPTS}) script invocations")
        if LIVE.search(str(path)) or LIVE.search(os.path.realpath(path)):
            raise LiveRead("live-database-script")
        if path not in paths:
            paths.append(path)
        try:
            invocation = shlex.split(command, comments=True)
        except ValueError:
            invocation = []
        shell = (binary in {'bash', 'sh', 'zsh', 'dash', 'ksh'} and len(invocation) == 2 and
                 os.path.basename(invocation[0]) == binary and invocation[1] == value and
                 not value.startswith(('~', '$')) and '\\\n' not in command and '\\\r\n' not in command and
                 not any(os.environ.get(name) or name in shell_values for name in ('BASH_ENV', 'ENV')) and
                 not any(name.startswith('BASH_FUNC_') for name in os.environ))
        if path in written:
            body, replaced = written[path]
            check_source(body, directory, path.suffix == ".py", shell=shell)
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
                if migration_args is not None and hashlib.sha256(source).hexdigest() == MIGRATE_SOURCE_SHA256:
                    migration_source(migration_args, directory)
                    return
                check_source(source.decode("utf-8", errors="replace"), directory, path.suffix == ".py", shell=shell)
        except OSError:
            pass

    def decode_word(value, directory, depth, quoted, checked, cwd_only=False, bodies=None):
        nonlocal conditional
        for key, literal in reversed(quoted.items()):
            if key in value and key not in checked and literal.startswith(("${", "$(", "`")) and not cwd_only:
                checked.add(key)
                for substitution in _substitutions(literal, shell=True):
                    conditional += 1
                    try:
                        scan(substitution, directory, depth + 1, inherited_bodies=bodies)
                    finally:
                        conditional -= 1
            value = value.replace(key, literal)
        return value

    def inspect(words, directory, depth, bodies, quoted, cwd_only=False):
        nonlocal unknown_cause
        words = list(words)
        checked = set()
        def decode(value):
            return decode_word(value, directory, depth, quoted, checked, cwd_only, bodies)
        documents, redirects = [], []
        index = 0
        while index < len(words):
            if words[index] in {"<<", ">", ">>", "<"} and index + 1 < len(words):
                op, value = words[index:index + 2]
                if op == "<<" and value in bodies:
                    body, heredoc_quoted = bodies[value]
                    if not heredoc_quoted:
                        for substitution in _substitutions(body):
                            scan(substitution, directory, depth + 1)
                    documents.append(body)
                else:
                    redirects.append((op, decode(value)))
                del words[index:index + 2]
            else:
                index += 1
        words = [decode(word) for word in words]
        caller_directory = directory
        child_directory = False
        while words:
            binary = os.path.basename(words[0])
            if re.match(r"^[A-Za-z_]\w*=", words[0]):
                remember_assignment(words.pop(0), directory)
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
                        remember_assignment(flag, directory)
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
            else:
                break
        if not words:
            return caller_directory if child_directory else directory
        binary, args = os.path.basename(words[0]), words[1:]
        after = caller_directory if child_directory else directory
        if binary in {"export", "readonly", "declare", "typeset", "local"}:
            for arg in args:
                if re.match(r"^[A-Za-z_]\w*=", arg):
                    remember_assignment(arg, directory)
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
        if python or binary in shells | {"node", "bun", "deno"}:
            args = _interpreter_args(binary, args)
        if documents:
            stdin_code = not args or args[0] == "-" or all(arg.startswith("-") for arg in args)
            if binary in shells and any(re.fullmatch(r"-[a-z]*s[a-z]*", arg) for arg in args) and not any(re.fullmatch(r"-[a-z]*c[a-z]*", arg) for arg in args):
                stdin_code = True
            for body in documents:
                if binary in shells and stdin_code:
                    scan(body, directory, depth + 1)
                elif (python or binary in {"node", "bun", "deno"}) and stdin_code or binary in {"sqlite3", "sqlite"}:
                    check_source(body, directory, python, "live-database-read")
            if binary in {"cat", "tee"}:
                targets = [(value, op == ">>") for op, value in redirects if op in {">", ">>"}]
                if binary == "tee":
                    targets.extend((arg, "-a" in args or "--append" in args) for arg in args if not arg.startswith("-"))
                for target, append in targets:
                    path = _literal_path(target, directory)
                    if path is not None:
                        prior, replaced = written.get(path, ("", False))
                        if conditional:
                            written[path] = (prior + "".join(documents), replaced)
                        else:
                            written[path] = (prior + "".join(documents), replaced) if append else ("".join(documents), True)
        read_words = list(words)
        if python or binary in {"node", "bun", "deno"}:
            for i, arg in enumerate(read_words[1:], 1):
                if arg in {"-c", "-e", "--eval", "-p", "--print"} and i + 1 < len(read_words):
                    check_source(read_words[i + 1], directory, python, "live-database-read")
                    del read_words[i + 1]
                    break
        assignment_reads = [] if binary == "jq" else list(live_assignments)
        if any(_direct_read(values + assignment_reads, directory)
               for values in variants(read_words)):
            raise LiveRead("live-database-read")
        if any(_direct_read(["cat", *values], directory)
               for values in variants([v for op, v in redirects if op == "<"])):
            raise LiveRead("live-database-read")
        if binary in shells:
            if any(re.fullmatch(r"-[a-z]*n[a-z]*", arg) for arg in args):
                return after
            index = next((i for i, arg in enumerate(args) if re.fullmatch(r"-[a-z]*c[a-z]*", arg)), None)
            if index is not None:
                if index + 1 < len(args):
                    scan(args[index + 1], directory, depth + 1)
                return after
        if binary == "eval":
            return scan(" ".join(args), directory, depth + 1)
        interpreter = binary in shells | {"node", "bun", "deno"} or re.fullmatch(r"python[\d.]*", binary)
        if interpreter or binary in {"source", "."}:
            if binary in {"bun", "deno"} and args[:1] == ["run"]:
                args = args[1:]
            while args and args[0].startswith("-"):
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
            if args and args[0] != "-":
                targets = args if binary == "node" and "--test" in words else args[:1]
                for target in targets:
                    if not target.startswith("-"):
                        migration_args = (args[1:] if binary == "node" and len(words) > 1 and words[1] == target and
                                          Path(target).name == "migrate-dev-db.ts" else None)
                        if migration_args is not None:
                            migration_context(words)
                        add(target, directory, binary, migration_args)
        elif words[0].startswith(("/", "./", "../", "~/", "$HOME/", "${HOME}/")) and re.search(r"\.(?:py|mjs|cjs|js|ts|sh)$", words[0]):
            add(words[0], directory, binary)
        return after

    def scan(source, directory, depth=0, cwd_only=False, inherited_bodies=None):
        if depth > MAX_SHELL_DEPTH:
            if SCRIPT.search(source) or DIRECT.search(source) or READER.search(source):
                raise AmbiguousScript(f"shell nesting deeper than MAX_SHELL_DEPTH ({MAX_SHELL_DEPTH})")
            return None
        try:
            source, bodies = _heredocs(source, len(inherited_bodies or {}), inherited_bodies or ())
            bodies = {**(inherited_bodies or {}), **bodies}
        except AmbiguousScript:
            if (SCRIPT.search(source) or DIRECT.search(source) or
                    re.search(r"(?:^|[\s;&|])(?:python[\d.]*|bash|sh|zsh|node)\s+[^<\s]", source) or
                    source_touches_live(source) and READER.search(source)):
                raise
            return directory
        source, quoted = _quoted_punctuation(source)
        lexer = shlex.shlex(source, posix=True, punctuation_chars=";&|(){}\n<>")
        lexer.whitespace = " \t\r"
        lexer.whitespace_split = True
        try:
            tokens = []
            for token in lexer:
                if re.fullmatch(r"[;&|(){}\n<>]+", token):
                    tokens.extend(re.findall(r"&&|\|\||<<-?|>>|[^\s]|\n", token))
                else:
                    tokens.append(token)
        except ValueError:
            if SCRIPT.search(source) or DIRECT.search(source) or READER.search(source) or any(value.startswith("${") for value in quoted.values()):
                raise AmbiguousScript(f"shell text could not be parsed (unbalanced quote near line {lexer.lineno})")
            return None

        def walk(index, current, closing=None, probe=cwd_only, stop=None):
            nonlocal unknown_cause, conditional
            words = []
            branches = []
            guarded = False

            def run(words, current, concurrent=False):
                nonlocal conditional
                before = current
                uncertain = bool(branches) or guarded or concurrent
                conditional += uncertain
                try:
                    current = inspect(words, current, depth, bodies, quoted, cwd_only=probe) if words else current
                finally:
                    conditional -= uncertain
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
                    try:
                        nested, index = walk(index + 1, current, group_close, probe=probe, stop=stop)
                    finally:
                        conditional -= uncertain
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
                    elif words:
                        guarded = False
                    words = []
                    if token == ";" and index and tokens[index - 1] == ";" and branches and branches[-1]["kind"] == "case":
                        branches[-1]["pattern"] = True
                        current = branches[-1]["cwd"]
                elif token in {"if", "while", "until", "for", "case", "select"} and not words:
                    branches.append({"cwd": current, "branch_cwd": current, "changed": False, "kind": token, "pattern": token == "case"})
                    if token in {"for", "select", "case"}:
                        index += 1
                        checked = set()
                        while index < len(tokens) and tokens[index] not in {";", "\n", "do"}:
                            # A case header ends at 'in', before its first arm.
                            if token == "case" and tokens[index] == "in":
                                break
                            decode_word(tokens[index], header_cwd, depth, quoted, checked, probe, bodies)
                            index += 1
                elif token in {"elif", "else"} and not words and branches:
                    current = branches[-1]["branch_cwd"]
                elif token in {"then", "do"} and not words:
                    if token == "then" and branches:
                        branches[-1]["branch_cwd"] = current
                elif token in {"fi", "done", "esac"} and not words:
                    if branches:
                        frame = branches.pop()
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

    scan(command, Path(cwd))
    return paths


def classify_detail(command: str, cwd: str) -> tuple[str | None, str | None]:
    cwd = cwd if isinstance(cwd, str) and cwd else os.getcwd()
    try:
        scripts_in(command, cwd)
    except AmbiguousScript as error:
        return "live-database-script-unresolved", str(error)
    except LiveRead as error:
        return error.rule, None
    return None, None


def classify(command: str, cwd: str) -> str | None:
    return classify_detail(command, cwd)[0]
