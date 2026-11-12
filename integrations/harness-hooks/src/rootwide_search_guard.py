"""Refuse literal recursive search roots without walking or reading those roots."""
from __future__ import annotations

import json
import os
import posixpath
import re
import shlex
import sys

from statev2_guard import _heredocs, _quoted_punctuation, AmbiguousScript

ROOTS = frozenset({"/Users/ardud/checkouts", "/Volumes/ExternalSSD/board-wt",
                   "/Volumes/ExternalSSD", "/Users/ardud", "/"})
OVERRIDE = "AGENT_GUARD_APPROVED"


def reason(root, cwd):
    return (f"Refused: recursive search over {root} walks every agent's checkout through the shared ovnfs mount and loads the whole Mac.\n"
            f"Search your own checkout ({cwd} or /Users/ardud/checkouts/<name>) or pass the exact file path. "
            "Your packet is your card prompt; files it names are under the paths it gives. "
            "AGENTS.md rules for your work are in your checkout root and its parent folders, not elsewhere.")


# Arity matters: a glob, pattern, replacement or ignore file is never a search
# root. Unknown options leave the command unclassified rather than guessing.
COMMON_VALUES = {"--regexp", "--file", "--ignore-file", "--glob", "--iglob",
                 "--type", "--type-not", "--max-count", "--max-depth", "--depth",
                 "--color", "--colors", "--encoding", "--threads", "--context",
                 "--after-context", "--before-context", "--max-filesize"}
COMMON_FLAGS = set("hHnNliIvVqsSwWucCzZaAoOPFLrR0UQvEbBg")
COMMON_LONG = {"--files", "--hidden", "--no-hidden", "--no-ignore", "--no-ignore-vcs",
               "--no-ignore-parent", "--no-ignore-global", "--no-ignore-dot", "--no-config",
               "--follow", "--no-follow", "--recursive", "--line-number", "--no-line-number",
               "--files-with-matches", "--files-without-match", "--ignore-case", "--smart-case",
               "--case-sensitive", "--fixed-strings", "--word-regexp", "--line-regexp", "--invert-match",
               "--count", "--count-matches", "--quiet", "--silent", "--no-messages", "--null",
               "--null-data", "--text", "--binary", "--multiline", "--multiline-dotall",
               "--pcre2", "--json", "--heading", "--no-heading", "--only-matching",
               "--passthru", "--stats", "--debug", "--trace", "--no-unicode", "--unicode"}
VALUES = {
    "rg": COMMON_VALUES | {"--pre", "--pre-glob", "--engine", "--sort", "--sortr", "--path-separator",
        "--replace", "--type-add", "--type-clear", "--hostname-bin", "--hyperlink-format", "--field-match-separator",
        "--field-context-separator", "--context-separator", "--max-columns", "--dfa-size-limit", "--regex-size-limit"},
    "grep": {"--regexp", "--file", "--include", "--exclude", "--exclude-dir", "--exclude-from",
        "--directories", "--devices", "--binary-files", "--label", "--color", "--colour", "--max-count",
        "--after-context", "--before-context", "--context"},
    "fd": {"--type", "--extension", "--exclude", "--ignore-file", "--max-depth", "--min-depth",
        "--exact-depth", "--size", "--changed-within", "--changed-before", "--base-directory",
        "--threads", "--color", "--path-separator", "--format", "--owner", "--max-results"},
    "ag": COMMON_VALUES | {"--ignore", "--ignore-dir", "--path-to-ignore", "--search-files",
        "--pager", "--replace", "--width", "--filename-pattern"},
    "ack": COMMON_VALUES | {"--ignore-dir", "--ignore-file", "--match", "--output", "--pager", "--env",
        "--range-start", "--range-end", "--type-add", "--type-set", "--type-del"},
    "git": {"--regexp", "--file", "--max-depth", "--threads", "--after-context", "--before-context", "--context"},
}
SHORT_VALUES = {"rg": set("efgtTmABCEMjr"), "grep": set("efmABCDd"),
                "fd": set("tEedjcS"), "ag": set("GgmABCE"),
                "ack": set("ABCGm"), "git": set("efABC")}


def _search_paths(tool, args):
    paths, explicit_pattern, files, recursive, options = [], False, False, False, True
    base = None
    index = 0
    while index < len(args):
        arg = args[index]
        index += 1
        if options and arg == "--":
            options = False
            continue
        if options and arg.startswith("--"):
            flag, equal, value = arg.partition("=")
            if flag in {"--help", "--version", "--type-list", "--list-file-types"}:
                return None, None
            if flag in VALUES[tool]:
                if not equal:
                    if index == len(args):
                        return None, None
                    value = args[index]
                    index += 1
                explicit_pattern |= flag in {"--regexp", "--file", "--match"} or tool == "ag" and flag == "--search-files"
                if flag == "--base-directory":
                    base = value
                if tool == "grep" and flag == "--directories":
                    recursive |= value == "recurse"
            elif flag in COMMON_LONG or flag in {"--no-index", "--untracked", "--cached", "--full-name",
                    "--absolute-path", "--relative-path", "--print0", "--show-errors", "--strip-cwd-prefix",
                    "--no-require-git", "--one-file-system", "--and", "--or", "--not", "--all-match"}:
                files |= flag == "--files"
                recursive |= flag == "--recursive"
            else:
                return None, None
            continue
        if options and arg.startswith("-") and arg != "-":
            flags = arg[1:]
            for offset, flag in enumerate(flags):
                if flag in SHORT_VALUES[tool]:
                    value = flags[offset + 1:]
                    if not value:
                        if index == len(args):
                            return None, None
                        value = args[index]
                        index += 1
                    explicit_pattern |= tool in {"rg", "grep", "git"} and flag in "ef" or tool == "ag" and flag == "g"
                    if tool == "grep" and flag == "d":
                        recursive |= value == "recurse"
                    break
                if flag not in COMMON_FLAGS and flag not in "0123456789":
                    return None, None
                recursive |= flag in "rR"
            continue
        paths.append(arg)
    if tool == "grep" and not recursive:
        return None, None
    if tool == "git" and "--no-index" not in args:
        return None, None
    if not files and not explicit_pattern:
        paths = paths[1:]
    return paths, base


def _path(value, cwd, home):
    if value == "~" or value.startswith("~/"):
        value = home + value[1:]
    value = re.sub(r"\$\{HOME\}|\$HOME(?!\w)", lambda _: home, value)
    # Dynamic paths/globs are deliberately not guessed or expanded on disk.
    if any(char in value for char in "$`*?\0"):
        return None
    if not value.startswith("/") and cwd is None:
        return None
    return "/" + posixpath.normpath(posixpath.join(cwd or "/", value)).lstrip("/")


def _tokens(source):
    # Preserve literal dollars/tildes in single quotes and escaped words. shlex
    # otherwise loses the distinction between '$HOME' and "$HOME".
    source = re.sub(r"'[^']*'|\\[^\n]", lambda m: m[0].replace("$", "\0dollar").replace("~", "\0tilde"), source)
    # _quoted_punctuation reserves NUL markers of its own; use a temporary
    # printable marker, then restore our non-expandable sentinels after lexing.
    source = source.replace("\0", "__rootguard_literal_")
    source, quoted = _quoted_punctuation(source)
    lexer = shlex.shlex(source, posix=True, punctuation_chars=";&|(){}<>\n")
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    tokens = []
    for word in lexer:
        if re.fullmatch(r"[;&|(){}<>\n]+", word):
            tokens.extend(re.findall(r"&&|\|\||<<<|<<|>>|<&|>&|<>|[;&|(){}<>\n]", word))
            continue
        for key, value in quoted.items():
            word = word.replace(key, "\0literal:" + value if re.fullmatch(r"[;&|(){}<>\n]+", value) else value)
        tokens.append(word.replace("__rootguard_literal_", "\0"))
    return tokens


def classify(command, cwd, *, approved=None, home=None, _depth=0):
    """Return only a proven prohibited root. Never execute shell expansions."""
    if _depth > 8 or not isinstance(command, str):
        return None
    home = home or os.path.expanduser("~")
    approved = os.environ.get(OVERRIDE, "") if approved is None else approved
    try:
        source, _ = _heredocs(command)
        tokens = _tokens(source.replace("\\\n", ""))
    except (ValueError, AmbiguousScript):
        return None
    directory = _path(cwd, "/", home) if isinstance(cwd, str) else None
    scopes, words = [], []

    def inspect(words, directory, approved, piped=False):
        # Redirection destinations and heredoc delimiters are data.
        args, i = [], 0
        stdin = piped or "<" in words or "<<" in words or "<<<" in words
        while i < len(words):
            if words[i] in {"<", ">", ">>", "<<", "<<-", "<<<", "<&", ">&", "<>"}:
                if args and args[-1].isdigit():
                    args.pop()
                i += 2
            else:
                args.append(words[i])
                i += 1
        while args and args[0] in {"if", "then", "elif", "else", "do", "!"}:
            args.pop(0)
        local_approved = approved
        while args:
            if re.match(r"^[A-Za-z_]\w*=", args[0]):
                name, value = args.pop(0).split("=", 1)
                if name == OVERRIDE:
                    local_approved = value
            elif args[0] in {"command", "exec", "env", "nohup"}:
                wrapper = args.pop(0)
                if wrapper == "env":
                    while args and args[0].startswith("-"):
                        flag = args.pop(0)
                        if flag in {"-u", "--unset"} and args:
                            if args.pop(0) == OVERRIDE:
                                local_approved = ""
                        elif flag in {"-i", "--ignore-environment"}:
                            local_approved = ""
                        elif flag != "--":
                            return None, directory, approved
                elif args and args[0] == "--":
                    args.pop(0)
            else:
                break
        if not args:
            persistent = all(re.match(r"^[A-Za-z_]\w*=", word) for word in words)
            return None, directory, local_approved if persistent else approved
        tool = posixpath.basename(args.pop(0))
        if tool == "cd":
            dest = next((a for a in args if a not in {"--", "-P", "-L"}), "~")
            return None, _path(dest, directory, home), approved
        if tool in {"export", "unset"}:
            for arg in args:
                if tool == "unset" and arg == OVERRIDE:
                    approved = ""
                elif arg.startswith(OVERRIDE + "="):
                    approved = arg.split("=", 1)[1]
            return None, directory, approved
        if local_approved:
            return None, directory, approved
        if tool in {"sh", "bash", "zsh"}:
            for i, arg in enumerate(args):
                if arg.startswith("-") and "c" in arg and "n" not in arg and i + 1 < len(args):
                    return classify(args[i + 1].replace("\0dollar", "$").replace("\0tilde", "~"), directory, approved=local_approved, home=home, _depth=_depth + 1), directory, approved
            return None, directory, approved
        search_directory = directory
        if tool == "git":
            while args and args[0] in {"-C", "-c", "--git-dir", "--work-tree"}:
                flag = args.pop(0)
                if not args:
                    return None, directory, approved
                value = args.pop(0)
                if flag == "-C":
                    search_directory = _path(value, search_directory, home)
            if not args or args.pop(0) != "grep":
                return None, directory, approved
        if tool == "find":
            paths = []
            for arg in args:
                if arg in {"-H", "-L", "-P", "-X", "-s", "-d"} and not paths:
                    continue
                if arg.startswith("-") or arg in {"!", "("}:
                    break
                paths.append(arg)
            base = None
            paths = paths or ["."]
        elif tool in VALUES:
            paths, base = _search_paths(tool, args)
        else:
            return None, directory, approved
        if paths is None:
            return None, directory, approved
        if not paths and stdin and tool in {"rg", "ag", "ack"} and "--files" not in args:
            return None, directory, approved
        paths = paths or ["."]
        if base is not None:
            search_directory = _path(base, search_directory, home)
        for value in paths:
            path = _path(value, search_directory, home)
            if path in ROOTS:
                return path, directory, approved
        return None, directory, approved

    piped, pipeline = False, None
    for token in [*tokens, ";"]:
        if token in {";", "&&", "||", "|", "&", "\n", "(", ")", "{", "}"}:
            previous = (directory, approved)
            hit, directory, approved = inspect(words, directory, approved, piped)
            if hit:
                return hit
            words = []
            if token == "|":
                pipeline = pipeline or previous
                directory, approved = pipeline
            elif pipeline:
                directory, approved = pipeline
                pipeline = None
            piped = token == "|"
            if token == "(":
                scopes.append((directory, approved))
            elif token == ")" and scopes:
                directory, approved = scopes.pop()
        else:
            words.append(token)
    return None


def main():
    event = json.load(sys.stdin)
    root = classify(event["command"], event.get("cwd"), approved=event.get("approved"))
    print(json.dumps({"root": root, "reason": reason(root, event.get("cwd")) if root else None}))


if __name__ == "__main__":
    main()
