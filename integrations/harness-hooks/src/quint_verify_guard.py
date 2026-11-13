"""Recognize direct Quint verify entry points without reading user scripts."""
from __future__ import annotations

import json
import os
import posixpath
import re
import shutil
import sys

from rootwide_search_guard import _tokens
from statev2_guard import _heredocs, AmbiguousScript

OVERRIDE = "QUINT_ALLOW_VULNERABLE_APALACHE"
REASON = "Refused: run quint verify through /Users/ardud/.local/bin/quint (or explicitly set QUINT_ALLOW_VULNERABLE_APALACHE=1)."
GUARDS = {"/Users/ardud/.local/bin/quint", "/Users/ardud/.local/share/quint-guard/bin/quint"}


def _quint_command(args):
    # Match the wrapper's yargs scalar/boolean/array option handling. In
    # particular, `--out verify typecheck` does not execute verify.
    i = 0
    while i < len(args):
        arg = args[i]
        i += 1
        if arg == "--":
            return None
        if arg.startswith("--invariants") and arg.split("=", 1)[0] == "--invariants":
            while i < len(args) and (not args[i].startswith("-") or re.match(r"^-[0-9.]", args[i])):
                i += 1
        elif arg.startswith("--"):
            if "=" in arg or arg.startswith("--no-"):
                continue
            boolean = arg in {"--help", "--version", "--random-transitions", "--randomTransitions"}
            if i < len(args) and (args[i] in {"true", "false"} if boolean else
                    not args[i].startswith("-") or args[i] == "-" or re.match(r"^-[0-9.]", args[i])):
                i += 1
        elif arg.startswith("-"):
            return None
        else:
            return arg
    return None


def _package(word):
    return bool(re.fullmatch(r"(?:quint|@informalsystems/quint)(?:@[^/]+)?", word))


def _cli(word):
    return word.endswith("/@informalsystems/quint/dist/src/cli.js")


def _runner_args(args):
    # Package-runner options with separate values. Equals forms need no
    # lookahead; `--` terminates runner options, not Quint's options.
    values = {"--package", "-p", "--cache", "--prefix", "--registry", "--userconfig",
              "--workspace", "-w", "--dir", "-C", "--cwd", "--filter", "--config",
              "--shell", "--reporter", "--store-dir", "--call", "-c"}
    while args and args[0].startswith("-"):
        flag = args.pop(0)
        if flag.startswith("--call="):
            return [], flag.split("=", 1)[1]
        if flag == "--":
            break
        if flag in values and args:
            value = args.pop(0)
            if flag in {"--call", "-c"}:
                return [], value
    return args, None


def _path(word, cwd):
    word = re.sub(r"^~(?=/)|\$\{HOME\}|\$HOME(?!\w)", "/Users/ardud", word)
    return posixpath.normpath(posixpath.join(cwd or "/", word))


def classify(command, cwd=None, *, path=None, approved=None, _depth=0, _runner=False):
    """True means refuse. Unknown bare-command PATH relies on managed homes.

    Hook processes do not inherit the tool shell's configured PATH. Only an
    explicit command PATH (or a caller-supplied one) can resolve bare Quint.
    No script, CLI source, model or backend named by the command is opened.
    """
    if not isinstance(command, str) or _depth > 8:
        return False
    approved = os.environ.get(OVERRIDE, "") if approved is None else approved
    try:
        source, _ = _heredocs(command)
        tokens = _tokens(source.replace("\\\n", ""))
    except (ValueError, AmbiguousScript):
        return False

    def inspect(words, state):
        allowance, search_path, directory = state
        args, i = [], 0
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
        local = {OVERRIDE: allowance, "PATH": search_path}
        while args:
            if re.match(r"^[A-Za-z_]\w*=", args[0]):
                name, value = args.pop(0).split("=", 1)
                if name in local:
                    local[name] = value
            elif posixpath.basename(args[0]) in {"env", "command", "exec", "nohup"}:
                wrapper = posixpath.basename(args.pop(0))
                while args and args[0].startswith("-"):
                    flag = args.pop(0)
                    if wrapper == "env":
                        if flag in {"-i", "--ignore-environment"}:
                            local = {OVERRIDE: "", "PATH": None}
                        elif flag in {"-u", "--unset"} and args:
                            local[args.pop(0)] = ""
                        elif flag.startswith("--unset="):
                            local[flag.split("=", 1)[1]] = ""
                        elif flag in {"-C", "--chdir"} and args:
                            directory = _path(args.pop(0), directory)
                    if flag == "--":
                        break
                    if wrapper == "command" and flag in {"-v", "-V"}:
                        return False, state
            else:
                break
        if not args:
            return False, (local.get(OVERRIDE, ""), local.get("PATH"), directory)
        executable, *args = args
        tool = posixpath.basename(executable)
        if tool in {"export", "unset"}:
            for word in args:
                name, equal, value = word.partition("=")
                if name in local and (equal or tool == "unset"):
                    local[name] = value if tool == "export" else None
            return False, (local.get(OVERRIDE, ""), local.get("PATH"), directory)
        if tool == "cd":
            dest = next((a for a in args if a not in {"--", "-P", "-L"}), "/Users/ardud")
            return False, (allowance, search_path, _path(dest, directory))
        if tool in {"sh", "bash", "zsh"}:
            for i, arg in enumerate(args[:-1]):
                if arg.startswith("-") and "c" in arg and "n" not in arg:
                    return classify(args[i + 1].replace("\0dollar", "$").replace("\0tilde", "~"), directory, path=local.get("PATH"), approved=local.get(OVERRIDE) or "", _depth=_depth + 1, _runner=_runner), state
            return False, state
        if local.get(OVERRIDE) == "1":
            return False, state
        if tool in {"npm", "pnpm"}:
            args, nested = _runner_args(args)
            if nested:
                return classify(nested.replace("\0dollar", "$").replace("\0tilde", "~"), directory, path=local.get("PATH"), approved="", _depth=_depth + 1, _runner=True), state
            if not args or args.pop(0) not in ({"exec"} if tool == "npm" else {"exec", "dlx"}):
                return False, state
        if tool in {"npm", "pnpm", "npx", "bunx"}:
            args, nested = _runner_args(args)
            if nested:
                return classify(nested.replace("\0dollar", "$").replace("\0tilde", "~"), directory, path=local.get("PATH"), approved="", _depth=_depth + 1, _runner=True), state
            if not args:
                return False, state
            executable, *args = args
            # Runners install/resolve the package themselves, bypassing PATH.
            if _package(executable):
                return _quint_command(args) == "verify", state
            tool = posixpath.basename(executable)
            if tool in {"sh", "bash", "zsh"}:
                for i, arg in enumerate(args[:-1]):
                    if arg.startswith("-") and "c" in arg and "n" not in arg:
                        source = args[i + 1].replace("\0dollar", "$").replace("\0tilde", "~")
                        return classify(source, directory, path=local.get("PATH"), approved="", _depth=_depth + 1, _runner=True), state
                return False, state
        if tool == "node":
            while args and args[0].startswith("-"):
                flag = args.pop(0)
                if flag in {"-r", "--require", "--import", "--loader", "--experimental-loader",
                            "--title", "--conditions", "-C", "--icu-data-dir", "--openssl-config",
                            "--redirect-warnings", "--diagnostic-dir", "--env-file", "--env-file-if-exists",
                            "--inspect-port", "--input-type", "--dns-result-order", "--max-http-header-size"} and args:
                    args.pop(0)
                if flag == "--":
                    break
            if not args:
                return False, state
            executable, *args = args
            tool = posixpath.basename(executable)
        if tool != "quint" and not _cli(_path(executable, directory)):
            return False, state
        if _quint_command(args) != "verify":
            return False, state
        if executable == "quint":
            if _runner:
                return True, state
            shell_path = local.get("PATH")
            if shell_path is None or "$" in shell_path or "`" in shell_path:
                return False, state
            # which stats executable candidates; it never reads CLI contents.
            executable = shutil.which("quint", path=shell_path)
            if executable is None:
                return False, state
        return _path(executable, directory) not in GUARDS, state

    states = frozenset({(approved, path, cwd)})
    words, scopes = [], []
    list_state = stage_state = states
    pipeline = None
    previous = None
    conditional_depth = 0
    for token in [*tokens, ";"]:
        if token == "\n" and not words and previous in {"|", "|&", "&&", "||"}:
            continue
        if token in {";", "&&", "||", "|", "|&", "&", "\n", "(", ")", "{", "}"}:
            before = states
            first = words[0] if words else None
            if first in {"if", "while", "until", "for", "case"}:
                conditional_depth += 1
            next_states = set()
            for state in states:
                hit, next_state = inspect(words, state)
                if hit:
                    return True
                next_states.add(next_state)
            # Short-circuit lists and control bodies may skip an export, cd
            # or unset. A permission is valid only on every possible path.
            if previous in {"&&", "||"} or conditional_depth:
                next_states.update(before)
            if first in {"fi", "done", "esac"}:
                conditional_depth = max(0, conditional_depth - 1)
            states = frozenset(next_states)
            words = []
            skipped = before if previous in {"&&", "||"} else frozenset()
            previous = token
            if token in {"(", "{"}:
                scopes.append((token, states, list_state, stage_state, pipeline, skipped))
                list_state = stage_state = states
                pipeline = None
                continue
            if token in {"|", "|&"}:
                pipeline = pipeline or stage_state
                states = stage_state = pipeline
                continue
            if pipeline:
                states = pipeline
                pipeline = None
            if token == "&":
                states = list_state
            if token in {")", "}"} and scopes:
                opening, parent, list_state, stage_state, pipeline, skipped = scopes.pop()
                if opening == "(":
                    states = parent
                else:
                    states = states | skipped
            else:
                stage_state = states
                if token in {";", "\n", "&"}:
                    list_state = states
        else:
            words.append(token)
    return False


def main():
    event = json.load(sys.stdin)
    denied = classify(event["command"], event.get("cwd"), path=event.get("path"), approved=event.get("approved"))
    print(json.dumps({"denied": denied, "reason": REASON if denied else None}))


if __name__ == "__main__":
    main()
