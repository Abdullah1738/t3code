"""Bounded shell/source checks; never opens a database or executes a command."""
from __future__ import annotations

import ast
import os
from pathlib import Path
import re
import shlex
import stat


LIVE = re.compile(
    r"(?:\.robob/userdata/statev2|robob-data/userdata/statev2|\.robob/userdata/\*\.sqlite|"
    r"(?:\.local/share/opencode|opencode-data)/opencode\.db)"
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


def _python_touches_live(source, directory):
    mentions = source_touches_live(source)
    changed_directory = bool(re.search(r"\bchdir\b", source) and
                             ("statev2.sqlite" in source or "opencode.db" in source) and
                             re.search(r"\.robob|robob-data|userdata|\.local/share/opencode|opencode-data", source))
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


def _source_hit(source, directory, python=False):
    if python:
        return _python_touches_live(source, directory)
    # Other languages have no text-only AST exemption. Preserve their existing
    # conservative treatment of paths split across variables or join calls.
    return bool(source_touches_live(source) or
                "statev2.sqlite" in source and re.search(r"\.robob|robob-data|userdata", source) or
                "opencode.db" in source and re.search(r"\.local/share|opencode-data|[\"']opencode[\"']", source))


class AmbiguousScript(Exception):
    """An explicit script invocation has no statically established location."""


class LiveRead(Exception):
    def __init__(self, rule):
        self.rule = rule


def _token(value):
    return repr(value[:80]).replace("\n", " ")


def _substitutions(text, shell=False):
    result, index, outer_quote = [], 0, None
    while index < len(text):
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
        if text[index] == "`":
            end = index + 1
            while end < len(text) and (text[end] != "`" or text[end - 1] == "\\"):
                end += 1
            if end == len(text):
                raise AmbiguousScript("unterminated command substitution in " + ("shell parameter expansion" if shell else "unquoted heredoc"))
            result.append(text[index + 1:end])
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
                elif char == "(":
                    nesting += 1
                elif char == ")":
                    nesting -= 1
                end += 1
            if nesting:
                raise AmbiguousScript("unterminated command substitution in " + ("shell parameter expansion" if shell else "unquoted heredoc"))
            result.append(text[index + 2:end - 1])
            index = end
            continue
        index += 1
    return result


def _heredocs(source):
    lines = source.splitlines(keepends=True)
    output, bodies = [], {}
    index = 0
    while index < len(lines):
        line = lines[index]
        index += 1
        matches, quote, escaped = [], None, False
        i = 0
        while i < len(line):
            char = line[i]
            if escaped:
                escaped = False
            elif char == "\\" and quote != "'":
                escaped = True
            elif quote:
                if char == quote:
                    quote = None
            elif char in "\"'":
                quote = char
            elif char == "#" and (i == 0 or line[i-1].isspace()):
                break
            elif line.startswith("<<", i) and not line.startswith("<<<", i):
                match = re.match(r"<<(-)?[ \t]*(?:'([^']+)'|\"([^\"]+)\"|([^\s;&|<>()'\"]+))", line[i:])
                if match:
                    key = f"__guard_heredoc_{len(bodies) + len(matches)}__"
                    matches.append((i, i + match.end(), bool(match[1]), next(x for x in match.groups()[1:] if x is not None), key, match[2] is not None or match[3] is not None))
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

    def check_source(source, directory, python=False, rule="live-database-script"):
        if _source_hit(source, directory, python):
            raise LiveRead(rule)

    def add(value, directory, binary="script"):
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
        if path in written:
            body, replaced = written[path]
            check_source(body, directory, path.suffix == ".py")
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
                check_source(source.decode("utf-8", errors="replace"), directory, path.suffix == ".py")
        except OSError:
            pass

    def decode_word(value, directory, depth, quoted, checked, cwd_only=False):
        nonlocal conditional
        for key, literal in quoted.items():
            if key in value and key not in checked and literal.startswith("${") and not cwd_only:
                checked.add(key)
                for substitution in _substitutions(literal, shell=True):
                    conditional += 1
                    try:
                        scan(substitution, directory, depth + 1)
                    finally:
                        conditional -= 1
            value = value.replace(key, literal)
        return value

    def inspect(words, directory, depth, bodies, quoted, cwd_only=False):
        nonlocal unknown_cause
        words = list(words)
        checked = set()
        def decode(value):
            return decode_word(value, directory, depth, quoted, checked, cwd_only)
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
                        add(target, directory, binary)
        elif words[0].startswith(("/", "./", "../", "~/", "$HOME/", "${HOME}/")) and re.search(r"\.(?:py|mjs|cjs|js|ts|sh)$", words[0]):
            add(words[0], directory, binary)
        return after

    def scan(source, directory, depth=0, cwd_only=False):
        if depth > MAX_SHELL_DEPTH:
            if SCRIPT.search(source) or DIRECT.search(source) or READER.search(source):
                raise AmbiguousScript(f"shell nesting deeper than MAX_SHELL_DEPTH ({MAX_SHELL_DEPTH})")
            return None
        try:
            source, bodies = _heredocs(source)
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
                        decode_word(word, branches[-1]["cwd"], depth, quoted, checked, probe)
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
                            decode_word(tokens[index], header_cwd, depth, quoted, checked, probe)
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
                        decode_word(word, branches[-1]["cwd"], depth, quoted, checked, probe)
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
