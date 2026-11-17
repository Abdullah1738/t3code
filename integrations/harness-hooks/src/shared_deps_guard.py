"""Apply the package-manager wrapper's shared-store policy to shell tools."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys

from rootwide_search_guard import _tokens
from statev2_guard import _heredocs, AmbiguousScript

SOURCE = Path(__file__).resolve().parents[2] / "local-helpers/libexec/repo-node-pin/shared-deps.sh"
GUARD = SOURCE if SOURCE.is_file() else Path.home() / ".local/libexec/repo-node-pin/shared-deps.sh"


def classify(command, cwd=None, *, _depth=0):
    if not isinstance(command, str) or _depth > 8:
        return None
    try:
        source, _ = _heredocs(command)
        tokens = _tokens(source.replace("\\\n", ""))
    except (ValueError, AmbiguousScript):
        return None
    directory = cwd or os.getcwd()
    scopes = []
    words = []

    def inspect(args, directory):
        args = list(args)
        parent_directory = directory
        env_scope = False
        while args:
            if re.match(r"^[A-Za-z_]\w*=", args[0]) or args[0] in {"then", "do", "if", "elif", "else", "!"}:
                args.pop(0)
                continue
            wrapper = os.path.basename(args[0])
            if wrapper not in {"env", "command", "exec", "nohup"}:
                break
            args.pop(0)
            env_scope = env_scope or wrapper == "env"
            while args and args[0].startswith("-"):
                flag = args.pop(0)
                if flag == "--":
                    break
                if wrapper == "command" and flag in {"-v", "-V"}:
                    return None, parent_directory
                if wrapper == "env" and flag in {"-u", "--unset", "-C", "--chdir"} and args:
                    value = args.pop(0)
                    if flag in {"-C", "--chdir"}:
                        directory = os.path.abspath(os.path.join(directory, value))
                elif wrapper == "env" and flag.startswith("--chdir="):
                    directory = os.path.abspath(os.path.join(directory, flag.split("=", 1)[1]))
        if not args:
            return None, parent_directory
        tool = os.path.basename(args.pop(0))
        if tool == "cd":
            dest = next((a for a in args if a not in {"--", "-P", "-L"}), str(Path.home()))
            return None, parent_directory if env_scope else os.path.abspath(os.path.join(directory, dest))
        if tool in {"sh", "bash", "zsh"}:
            for i, arg in enumerate(args[:-1]):
                if arg.startswith("-") and "c" in arg and "n" not in arg:
                    return classify(args[i + 1], directory, _depth=_depth + 1), parent_directory
        if tool in {"node", "nodejs"}:
            while args and args[0].startswith("-"):
                flag = args.pop(0)
                if flag == "--":
                    break
                if flag in {"-e", "--eval", "-p", "--print", "-c", "--check"}:
                    return None, parent_directory
                if flag in {"-r", "--require", "--import", "--loader", "--experimental-loader", "--conditions", "-C", "--title", "--env-file", "--env-file-if-exists", "--input-type", "--inspect-port", "--diagnostic-dir", "--icu-data-dir", "--openssl-config", "--redirect-warnings", "--dns-result-order"} and args:
                    args.pop(0)
            if not args:
                return None, parent_directory
            tool = os.path.basename(args.pop(0)).removesuffix(".cjs").removesuffix(".mjs").removesuffix(".js")
        if tool == "corepack":
            if not args:
                return None, parent_directory
            tool = args.pop(0).split("@", 1)[0]
        if tool not in {"vp", "pnpm"}:
            return None, parent_directory
        # Only our trusted policy script is executed. Parsed command words are
        # positional arguments; no part of the user's command is evaluated.
        try:
            result = subprocess.run(["/bin/sh", "-c", '. "$1"; shift; repo_shared_deps_check "$@"',
                                     "shared-deps", str(GUARD), tool, *[arg.replace("\0dollar", "$").replace("\0tilde", "~") for arg in args]], cwd=directory,
                                    capture_output=True, text=True, timeout=2)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            return None, parent_directory
        return (result.stderr.strip() if result.returncode == 1 else None), parent_directory

    directories = frozenset({directory})
    scopes = []
    pipeline = None
    list_start = directories
    for token in [*tokens, ";"]:
        if token in {";", "&&", "||", "|", "|&", "&", "\n", "(", ")", "{", "}"}:
            before = directories
            after = set()
            for current in directories:
                reason, next_directory = inspect(words, current)
                if reason:
                    return reason
                after.add(next_directory)
            directories = frozenset(after)
            words = []
            if token == "(":
                scopes.append(directories)
            elif token == ")" and scopes:
                directories = scopes.pop()
            if token in {"|", "|&"}:
                pipeline = pipeline or before
                directories = pipeline
            elif pipeline:
                directories = directories | pipeline
                pipeline = None
            if token == "&":
                directories = list_start
            elif token in {"&&", "||"}:
                directories = directories | before
            if token in {";", "\n", "&"}:
                list_start = directories
        else:
            words.append(token)
    return None


if __name__ == "__main__":
    event = json.load(sys.stdin)
    reason = classify(event["command"], event.get("cwd"))
    print(json.dumps({"denied": bool(reason), "reason": reason}))
