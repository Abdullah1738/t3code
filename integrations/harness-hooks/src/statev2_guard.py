"""Bounded shell/source checks; never opens a database or executes a command."""
from __future__ import annotations

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
    r"datasette|uv|cp|rsync|ditto|dd|cat|strings|grep|rg|xxd|hexdump|tar|zip|restic)"
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


def source_touches_live(source: str) -> bool:
    return bool(LIVE.search(source) or
                ("statev2.sqlite" in source and re.search(r"\.robob|robob-data|userdata", source)) or
                ("opencode.db" in source and re.search(r"\.local/share|opencode-data|[\"']opencode[\"']", source)))


class AmbiguousScript(Exception):
    """An explicit script invocation has no statically established location."""


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


def scripts_in(command: str, cwd: str) -> list[Path]:
    """Track literal cwd changes without evaluating shell code or variables."""
    paths = []

    def add(value, directory):
        path = _literal_path(value, directory)
        if path is None or len(paths) >= MAX_SCRIPTS:
            raise AmbiguousScript()
        if path not in paths:
            paths.append(path)

    def inspect(words, directory, depth):
        words = list(words)
        caller_directory = directory
        child_directory = False
        while words:
            binary = os.path.basename(words[0])
            if re.match(r"^[A-Za-z_]\w*=", words[0]) or binary in {"then", "do", "else", "!"}:
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
                    if flag in {"-C", "--chdir"}:
                        child_directory = True
                        directory = _literal_path(words.pop(0), directory) if words else None
                    elif flag.startswith("--chdir="):
                        child_directory = True
                        directory = _literal_path(flag.split("=", 1)[1], directory)
                    elif flag in {"-u", "--unset"} and words:
                        words.pop(0)
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
            else:
                break
        if not words:
            return caller_directory if child_directory else directory
        binary, args = os.path.basename(words[0]), words[1:]
        after = caller_directory if child_directory else directory
        if binary == "cd":
            args = [arg for arg in args if arg not in {"--", "-L", "-P"}]
            changed = _literal_path(args[0] if args else str(Path.home()), directory) if len(args) <= 1 else None
            return after if child_directory else changed
        if binary in {"pushd", "popd"}:
            return None
        shells = {"bash", "sh", "zsh", "dash", "ksh"}
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
                    return after
                if flag == "--":
                    break
            if args and re.search(r"\.(?:py|mjs|cjs|js|ts|sh)$", args[0]):
                add(args[0], directory)
        elif words[0].startswith(("/", "./", "../", "~/", "$HOME/", "${HOME}/")) and re.search(r"\.(?:py|mjs|cjs|js|ts|sh)$", words[0]):
            add(words[0], directory)
        return after

    def scan(source, directory, depth=0):
        if depth > MAX_SHELL_DEPTH:
            if SCRIPT.search(source) or DIRECT.search(source):
                raise AmbiguousScript()
            return None
        lexer = shlex.shlex(source, posix=True, punctuation_chars=";&|(){}\n<>")
        lexer.whitespace = " \t\r"
        try:
            tokens = []
            for token in lexer:
                if re.fullmatch(r"[;&|(){}\n<>]+", token):
                    tokens.extend(re.findall(r"&&|\|\||<<-?|>>|[^\s]|\n", token))
                else:
                    tokens.append(token)
        except ValueError:
            if SCRIPT.search(source) or DIRECT.search(source):
                raise AmbiguousScript()
            return None

        def walk(index, current, closing=None):
            words = []
            while index < len(tokens):
                token = tokens[index]
                if token in {"(", "{"} and not words:
                    nested, index = walk(index + 1, current, ")" if token == "(" else "}")
                    if token == "{":
                        current = nested
                    continue
                if token == closing:
                    return inspect(words, current, depth) if words else current, index + 1
                if token in {";", "&&", "||", "|", "&", "\n"}:
                    prior = current
                    current = inspect(words, current, depth) if words else current
                    if token in {"||", "|", "&"} and current != prior:
                        current = None if token == "||" else prior
                    words = []
                elif token in {"if", "elif", "while", "until", "for", "case", "select"} and not words:
                    # A conditional directory change does not establish the cwd
                    # after its branch. Only script execution needs a known cwd.
                    current = None
                elif token in {"fi", "done", "esac"} and not words:
                    pass
                else:
                    words.append(token)
                index += 1
            return inspect(words, current, depth) if words else current, index

        return walk(0, directory)[0]

    scan(command, Path(cwd))
    return paths


def classify(command: str, cwd: str) -> str | None:
    if source_touches_live(command) and READER.search(command):
        return "live-database-read"
    cwd = cwd if isinstance(cwd, str) and cwd else os.getcwd()
    if LIVE.search(cwd.rstrip("/") + "/statev2.sqlite") and READER.search(command) and re.search(r"\bstatev2\.sqlite\b", command):
        return "live-database-read"
    if LIVE.search(cwd.rstrip("/") + "/opencode.db") and READER.search(command) and re.search(r"\bopencode\.db\b", command):
        return "live-database-read"
    if READER.search(command):
        try:
            words = shlex.split(command)
        except ValueError:
            words = []
        for value in words[:256]:
            value = re.sub(r"^(?:~|\$HOME|\$\{HOME\})(?=/)", str(Path.home()), value)
            if value.startswith(("/", "./", "../")) or re.fullmatch(r"[^\s/]+\.(?:sqlite|db)(?:-wal|-shm)?", value):
                # Resolve path aliases without opening their targets. Reads of a
                # symlink to the live file contend with the same writer.
                path = value if os.path.isabs(value) else os.path.join(cwd, value)
                if LIVE.search(os.path.realpath(path)):
                    return "live-database-read"
    try:
        scripts = scripts_in(command, cwd)
    except AmbiguousScript:
        return "live-database-script-unresolved"
    for path in scripts:
        # A script symlink must not turn this source inspection into a DB read.
        if LIVE.search(str(path)) or LIVE.search(os.path.realpath(path)):
            return "live-database-script"
        try:
            info = path.stat()
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_SOURCE_BYTES:
                continue
            with path.open("rb") as handle:
                opened = os.fstat(handle.fileno())
                if not stat.S_ISREG(opened.st_mode) or opened.st_size > MAX_SOURCE_BYTES:
                    continue
                source = handle.read(MAX_SOURCE_BYTES + 1)
            if len(source) <= MAX_SOURCE_BYTES and source_touches_live(source.decode("utf-8", errors="replace")):
                return "live-database-script"
        except OSError:
            continue
    return None
