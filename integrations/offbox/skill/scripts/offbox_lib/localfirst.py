"""Local-first: light Go checks run on the Mac instead of waking a boat box.

Two layers. A static allowlist picks what may run here: `go test -run` / `go vet` / `go build -o /dev/null` of up
to three repo packages, `gofmt -l`, `go version|env|list`, read-only pipe filters, and redirects to /dev/null or to
/tmp files the same command writes. The packages, and the module packages they import, must have no OS- or
arch-specific files. The run itself then goes through sandbox-exec: writes only to a private run dir (the command's
/tmp/x paths are rewritten into it) and the Go caches, never to the repo; no reads of home-directory or secret files
(.env, keys) unless --include names them; no Docker/SSH agent/keychain, no unix sockets, no local UDP, no TCP to
services listening on this Mac. An in-sandbox reaper kills everything the run started when it ends. A run the
sandbox blocked is rerun on the box. Anything else, or anything unclear, stays on the box.
`offbox run --remote` always uses the box; OFFBOX_LOCAL_FIRST=0 turns local-first off.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

from . import common
from .common import db, event, log, new_id, now, say

SLOTS = 4
MAX_PKGS_PER_CMD = 3
MAX_PKGS_TOTAL = 6
MAX_GO_CMDS = 8
MAX_SCAN_DIRS = 300
BASH = next((b for b in ("/opt/homebrew/bin/bash", "/usr/local/bin/bash") if os.path.exists(b)), "/bin/bash")
SANDBOX = "/usr/bin/sandbox-exec"
PYTHON = os.path.realpath(sys.executable)
GNU_GREP = "/opt/homebrew/opt/grep/libexec/gnubin"
HOME = os.path.realpath(os.path.expanduser("~"))

# Go environment a command may set, each with a value check. Everything else that steers go, git, cloud or the
# shell is refused.
GO_ENV = {
    "GOTOOLCHAIN": re.compile(r"local|auto|go\d+\.\d+(\.\d+|rc\d+)?(\+auto|\+path)?").fullmatch,
    "GOMAXPROCS": re.compile(r"\d+").fullmatch,
    "GOTRACEBACK": re.compile(r"none|single|all|system|crash|[0-2]").fullmatch,
    "GODEBUG": re.compile(r"[\w=,.]*").fullmatch,
    "GOWORK": lambda v: v == "off",
    "GOEXPERIMENT": re.compile(r"[\w,]*").fullmatch,
    "CGO_ENABLED": lambda v: v in ("0", "1"),
    "GOFLAGS": None,  # checked as go flags
}
ENV_DENY = re.compile(r"^(GO|CGO_|LD_|DYLD_|GIT_|AWS_|FDB_|DOCKER_|SSH_|OFFBOX_)|^(CC|CXX|PATH|BASH_ENV|ENV|IFS|HOME|"
                      r"TMPDIR|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|KUBECONFIG|CDPATH|GLOBIGNORE)$")
# Kept from the caller's environment for a local run (plus runs.build_env's CI=1 and allowlist).
KEEP_ENV = {"PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "TZ", "GOPRIVATE", "GONOSUMDB", "GONOPROXY",
            "GOPROXY", "OPENCODE_SESSION_ID"}

SIMPLE = {"true", "false", ":", "echo", "printf", "pwd", "exit", "test", "[", "[["}
FILTERS = {"head", "tail", "grep", "egrep", "fgrep", "sort", "uniq", "wc", "cut", "tr", "cat", "sed"}
SHELLS = {"bash", "sh", "zsh"}
LOOPS = {"for", "while", "until", "select", "case", "function", "coproc"}
SET_OPTS = ("pipefail", "errexit", "nounset", "xtrace")

DIGITS = re.compile(r"\d+").fullmatch
DURATION = re.compile(r"(\d+(\.\d+)?(ns|us|ms|s|m|h))+").fullmatch
OSARCH = r"(linux|darwin|windows|freebsd|openbsd|netbsd|android|ios|plan9|wasip1|js|amd64|arm64|386|arm|wasm|riscv64)"
# go flag -> "bool" or a value check. Anything not listed (-c, -exec, -toolexec, -vettool, -gcflags, -ldflags,
# -asmflags, -bench, -fuzz, -coverprofile, -overlay, -modfile, -args, -C, -a ...) sends the run to the box.
GO_FLAGS = {
    "v": "bool", "race": "bool", "short": "bool", "failfast": "bool", "cover": "bool", "x": "bool", "n": "bool",
    "work": "bool", "trimpath": "bool", "json": "bool", "modcacherw": "bool", "e": "bool", "m": "bool",
    "deps": "bool", "test": "bool", "find": "bool", "compiled": "bool",
    "buildvcs": lambda v: v in ("true", "false", "auto"),
    "run": True, "skip": True, "list": True, "f": True,
    "tags": lambda v: bool(re.fullmatch(r"[\w.,]+", v)) and not re.search(rf"\b{OSARCH}\b", v),
    "vet": re.compile(r"off|[\w,]+").fullmatch,
    "covermode": lambda v: v in ("set", "count", "atomic"),
    "coverpkg": re.compile(r"[\w./,-]+").fullmatch,
    "shuffle": re.compile(r"on|off|\d+").fullmatch,
    "p": DIGITS, "parallel": DIGITS, "cpu": re.compile(r"\d+(,\d+)*").fullmatch,
    "count": lambda v: v.isdigit() and int(v) <= 3,
    "timeout": lambda v: bool(DURATION(v)) and not re.fullmatch(r"(0+(\.0+)?[a-z]+)+", v),
    "o": lambda v: v == "/dev/null",
    "mod": lambda v: v in ("readonly", "vendor"),
    "pgo": lambda v: v in ("off", "auto"),
}
SED_PART = re.compile(r"^\s*(?:(?:\d+|\$|/[^/]*/)(?:\s*,\s*(?:\d+|\$|/[^/]*/))?\s*!?\s*)?[pdq]\s*$"
                      r"|^\s*(?:(?:\d+|\$|/[^/]*/)\s*)?s(.).*?\1.*?\1[gpiI0-9]*\s*$")
GNU_ESCAPE = re.compile(r"\\[sSwWbB<>`'nt]")
BOX_ONLY = re.compile(r"/proc/|\bsudo\b|\bdocker\b|\bfdbcli\b|/usr/local/go\b|\bsystemctl\b|\bapt(-get)?\b")
# Only top-level /tmp files: they are rewritten into the run's private dir, which has no subdirectories.
TMP_TARGET = re.compile(r"(?:/private)?/tmp/[\w+-][\w.+-]*")
# Where a run's /tmp/ paths start in the command text (rewritten to <rundir>/t/ before it runs).
TMP_REF = re.compile(r"(?<![\w.$/-])(?:/private)?/tmp/(?=[\w+-])")
SAFE_DIR = re.compile(r"/[\w./-]+")
GLOB = re.compile(r"[*?\[\]{}~]")
OSARCH_FILE = re.compile(rf"_{OSARCH}(_{OSARCH})?(_test)?\.go$")
BUILD_TAG = re.compile(r"^\s*//\s*(?:go:build|\+build)\s(.*)$", re.M)
DOTENV = re.compile(r"[\"'/]\.env\b|godotenv")
# File writes a test may make into its own package dir. The sandbox blocks them, and a test that hides the error
# ("could not create fixture") fails like a real failure, so a failed run of such a package is retried on the box.
# Any selector with these names counts (import aliases, `os.WriteFile (`, function values): a false hit only costs a
# box rerun after a local failure.
WRITES = re.compile(r"\.\s*(?:WriteFile|Create|OpenFile|Mkdir|MkdirAll|Rename|Remove|RemoveAll|Symlink|Link|"
                    r"Chmod|Chown|Lchown|Chtimes|Truncate)\b")
DOCKER_LIBS = re.compile(r"testcontainers|dockertest|github\.com/docker/|github\.com/moby/")
REDIR = re.compile(r"&>>?|>>|>\||>&|>\(|>|<<<|<<-?|<>|<&|<\(|<")
# Local services an accidental test connection could reach (root-owned listeners lsof can't see as this user).
STATIC_PORTS = (22, 88, 445, 548, 2181, 3306, 4317, 4318, 4566, 4689, 5432, 5900, 6379, 8080, 8123, 8443, 9000,
                9092, 9200, 11211, 27017)
SECRET_FILES = (r'#"^/(Users|Volumes|private/tmp|private/var/folders)/(.*/)?(\.env[^/]*|[^/]*\.(pem|key|p12|pfx|jks|p8|'
                r'mobileprovision)|\.netrc|\.npmrc|\.pypirc|credentials\.json|id_rsa[^/]*|id_ed25519[^/]*|'
                r'[^/]*\.tfstate[^/]*)$"')


def _inside(root: str, path: str) -> bool:
    return path == root or path.startswith(root.rstrip("/") + "/")


def _plain(w: str) -> bool:
    from classify import VAR
    return bool(w) and VAR not in w and "$" not in w and "`" not in w


# ---------------------------------------------------------------- shell text


def _dollar_ok(s: str, i: int, quoted: bool = False) -> str | None:
    if not quoted and s.startswith(("$'", '$"'), i):
        return "ANSI-C or locale quoting"
    if s.startswith("$((", i):
        return "arithmetic expansion"
    if s.startswith("${", i) and not re.match(r"\$\{[A-Za-z_]\w*(\[\d+\])?\}", s[i:]):
        return "parameter expansion with operators"
    return None


def _target(script: str, i: int):
    """The redirect target word starting at i -> (text, end) or (None, end) when it is not one plain word."""
    n = len(script)
    while i < n and script[i] in " \t":
        i += 1
    m = re.compile(r"'([^']*)'|\"([^\"$`\\]*)\"|([^\s;|&<>()'\"$`\\]+)").match(script, i)
    if not m:
        return None, i
    j = m.end()
    if j < n and script[j] not in " \t\n;|&<>)":
        return None, j  # concatenated quotes or expansions: refuse rather than guess what bash opens
    return next(g for g in m.groups() if g is not None), j


def _scan(script: str, events: list) -> str | None:
    """Quote-aware pass over the raw text. Refuses shell forms the lexer can't see through; records redirects as
    (position, 'w'|'r', path) in `events`."""
    i, n, depth = 0, len(script), 0
    while i < n:
        c = script[i]
        if c == "\\":
            i += 2
            continue
        if c == "'":
            j = script.find("'", i + 1)
            if j < 0:
                return "unbalanced quote"
            i = j + 1
            continue
        if c == '"':
            j = i + 1
            while j < n and script[j] != '"':
                if script[j] == "\\":
                    j += 2
                    continue
                if script[j] == "`":
                    return "backtick substitution"
                if script[j] == "$":
                    why = _dollar_ok(script, j, quoted=True)
                    if why:
                        return why
                j += 1
            if j >= n:
                return "unbalanced quote"
            body = script[i + 1:j]
            if "$(" in body and re.search(r"[<>&]", body):
                return "redirect inside a quoted command substitution"
            i = j + 1
            continue
        if c == "`":
            return "backtick substitution"
        if c == "$":
            why = _dollar_ok(script, i)
            if why:
                return why
            if script.startswith("$(", i):
                depth += 1
                i += 2
                continue
            i += 1
            continue
        if c == "#" and (i == 0 or script[i - 1] in " \t\n;|&("):
            j = script.find("\n", i)
            i = n if j < 0 else j
            continue
        if c == "(":
            return "subshell or grouping parentheses"
        if c == ")":
            if not depth:
                return "subshell or grouping parentheses"
            depth -= 1
            i += 1
            continue
        if c == "&":
            if script[i + 1:i + 2] == "&":
                i += 2
                continue
            if script[i + 1:i + 2] != ">":
                return "background job"
        elif c == "|" and script[i + 1:i + 2] == "&":
            i += 2
            continue
        elif c not in "<>":
            i += 1
            continue
        pos = i
        op = REDIR.match(script, i).group(0)
        i += len(op)
        if op.startswith("<<"):
            return "heredoc"
        if op in ("<(", ">("):
            return "process substitution"
        target, i = _target(script, i)
        if target is None:
            return "redirect target is not one plain word"
        if op in (">&", "<&") and re.fullmatch(r"\d+-?|-", target):
            continue
        if target == "/dev/null":
            continue
        if TMP_TARGET.fullmatch(target) and os.path.normpath(target) == target:
            events.append((pos, "r" if op.startswith("<") and op != "<>" else "w", target))
            continue
        return f"redirects to or from {target}"
    return None


# ---------------------------------------------------------------- environment


def _go_flags(tokens, sub):
    """-> list of positional args, or a reason string when a flag is not on the allowlist."""
    from classify import VAR
    pos, i = [], 0
    while i < len(tokens):
        tok = tokens[i]
        if not tok.startswith("-") or tok == "-":
            pos.append(tok)
            i += 1
            continue
        name, eq, val = tok.lstrip("-").partition("=")
        if name.startswith("test."):
            name = name[5:]
        if name not in GO_FLAGS:
            return f"go flag -{name}"
        kind = GO_FLAGS[name]
        if kind == "bool":
            if eq and val not in ("true", "false", "1", "0"):
                return f"go flag -{name}={val}"
        else:
            if not eq:
                if i + 1 >= len(tokens):
                    return f"go flag -{name} without a value"
                i += 1
                val = tokens[i]
            if VAR in val or "$(" in val or "`" in val or "${" in val:
                return f"go flag -{name} with a variable"
            if kind is not True and not kind(val):
                return f"go flag -{name} {val}"
        if name == "list" and sub not in ("test", None):
            return "-list outside go test"
        i += 1
    return pos


def _env_value(name: str, val: str) -> str | None:
    """None when NAME=val is fine for a local go run."""
    if not _plain(val):
        return f"{name} from a variable"
    if name == "GOFLAGS":
        pos = _go_flags(val.split(), None)
        if isinstance(pos, str):
            return f"GOFLAGS: {pos}"
        return "GOFLAGS with a non-flag word" if pos else None
    return None if GO_ENV[name](val) else f"{name}={val}"


def env_ok(env: dict) -> str | None:
    """The effective Go environment of a local run (inherited, --env and our defaults) must pass the same checks."""
    for name in GO_ENV:
        if name in env:
            why = _env_value(name, env[name])
            if why:
                return why
    return None


def _assignments(words, prefix_for: str | None) -> str | None:
    from classify import ASSIGN
    for w in words:
        if not ASSIGN.match(w):
            break
        name, _, val = w.partition("=")
        if name.endswith("+"):
            return f"appends to {name[:-1]}"
        if name in GO_ENV:
            why = _env_value(name, val)
            if why:
                return why
            continue
        if ENV_DENY.match(name):
            return f"sets {name}"
        if prefix_for in ("go", "env"):
            return f"sets {name} for go (tests may reach a service)"
    return None


# ---------------------------------------------------------------- go


def _go(words, ctx) -> str | None:
    args = words[1:]
    if not args:
        return "bare go"
    sub = args[0]
    ctx["n"]["checks"] += 1
    if sub == "version":
        return None if len(args) == 1 else "go version with arguments"
    if sub == "env":
        return None if all(re.fullmatch(r"[A-Z0-9_]+", w) for w in args[1:]) else "go env with flags"
    if sub not in ("test", "vet", "build", "list"):
        return f"go {sub} is not a light check"
    pos = _go_flags(args[1:], sub)
    if isinstance(pos, str):
        return pos
    if sub == "build" and not re.search(r"(^|\s)--?o(=|\s+)/dev/null(\s|$)", " ".join(args[1:])):
        return "go build writes a binary (add -o /dev/null)"
    if sub == "list" and any(re.fullmatch(r"--?m(=true)?", w) for w in args[1:]):
        return None if all(re.fullmatch(r"[\w./@-]+", p) for p in pos) else "go list -m argument"
    targets = []
    for p in pos or ["."]:
        if not _plain(p) or GLOB.search(p) or not (p in (".", "..") or p.startswith(("./", "../"))):
            return f"package {p!r} is not a plain repo path"
        if "..." in p and sub != "list":
            return "package pattern with ..."
        d = os.path.realpath(os.path.join(ctx["cwd"], p.replace("...", "").rstrip("/") or "."))
        if d.endswith(".go"):
            d = os.path.dirname(d)
        if not _inside(ctx["root"], d):
            return f"package {p} is outside the repo"
        targets.append(d)
    if sub == "list":
        return None
    if len(targets) > MAX_PKGS_PER_CMD:
        return f"more than {MAX_PKGS_PER_CMD} packages"
    ctx["n"]["pkgs"] += len(targets)
    ctx["n"]["go"] += 1
    if ctx["n"]["pkgs"] > MAX_PKGS_TOTAL or ctx["n"]["go"] > MAX_GO_CMDS:
        return "too many go checks in one run"
    return _packages(sorted(set(targets)), ctx, sub == "test")


def _packages(targets, ctx, testing: bool) -> str | None:
    """Targets plus every module package they import: no OS/arch-specific files (Mac and Linux would build
    different code), no .env reads unless --include names one, no Docker libraries in tests. Tested packages that
    write files are counted in ctx["n"]["writes"]."""
    from classify import _go_module
    root, mod = _go_module(ctx["cwd"])
    if not root or not mod:
        return "no go.mod above the working dir"
    try:
        with open(os.path.join(root, "go.mod"), errors="replace") as f:
            gomod = f.read()
    except OSError:
        return "cannot read go.mod"
    if re.search(r"=>\s*(\.{1,2}/|/)", gomod):
        return "go.mod replaces a module with a local path (may not be synced to the box)"
    for d in targets:
        nearest, _ = _go_module(d if os.path.isdir(d) else os.path.dirname(d))
        if nearest and nearest != root:
            return f"{os.path.relpath(d, ctx['root'])} is in a nested module"
    docker = testing and bool(DOCKER_LIBS.search(gomod))
    env_ok_ = any(re.search(r"(^|/)\.env", i) for i in ctx["includes"])
    irx = re.compile('"(' + re.escape(mod) + r'(?:/[^"\s]*)?)"')
    todo = [(d, True) for d in targets]
    seen: set[str] = set()
    while todo:
        d, target = todo.pop(0)
        if d in seen:
            continue
        seen.add(d)
        if len(seen) > MAX_SCAN_DIRS:
            return "imports too many packages to check"
        try:
            names = sorted(x for x in os.listdir(d) if x.endswith(".go"))
        except FileNotFoundError:
            continue  # go reports a missing package in a second
        except OSError:
            return f"cannot read {d}"
        rel = os.path.relpath(d, ctx["root"])
        for name in names:
            if name.endswith("_test.go") and not target:
                continue
            if OSARCH_FILE.search(name):
                return f"{rel}/{name} is OS- or arch-specific"
            try:
                with open(os.path.join(d, name), errors="replace") as f:
                    txt = f.read(300_000)
            except OSError:
                return f"cannot read {rel}/{name}"
            head = txt.split("\npackage ", 1)[0]
            if any(re.search(rf"\b{OSARCH}\b", m) for m in BUILD_TAG.findall(head)):
                return f"{rel}/{name} has an OS or arch build tag"
            if target and DOTENV.search(txt) and not env_ok_:
                return f"{rel}/{name} reads a .env file (use --include)"
            if docker and DOCKER_LIBS.search(txt):
                return f"{rel}/{name} may start Docker containers"
            if testing and target and WRITES.search(txt):
                ctx["n"]["writes"] = ctx["n"].get("writes", 0) + 1
            for imp in irx.findall(txt):
                todo.append((os.path.normpath(os.path.join(root, imp[len(mod):].lstrip("/"))), False))
    return None


# ---------------------------------------------------------------- commands


def _filter(exe, args) -> str | None:
    from classify import VAR
    if any(VAR in w or "$(" in w or "`" in w or "${" in w for w in args):
        return f"{exe} with a variable"
    if exe == "sed":
        scripts, pos, i = [], [], 0
        while i < len(args):
            w = args[i]
            if w == "-e" and i + 1 < len(args):
                scripts.append(args[i + 1])
                i += 2
                continue
            if w.startswith("-"):
                if not re.fullmatch(r"-[nEr]+", w):
                    return f"sed {w}"
            else:
                pos.append(w)
            i += 1
        if not scripts and pos:
            scripts.append(pos.pop(0))
        for s in scripts:
            if GNU_ESCAPE.search(s):
                return "sed script uses GNU-only escapes"
            if not all(SED_PART.match(part) for part in s.split(";") if part.strip()):
                return "sed script is not a plain print/delete/substitute"
        return None
    if exe in ("grep", "egrep", "fgrep"):
        if not os.path.isdir(GNU_GREP) and any(re.match(r"^-[^-]*P|^--perl", w) for w in args):
            return "grep -P needs GNU grep"
        return None
    if exe == "sort" and any(re.match(r"^-[^-]*o|^--(output|compress|files0)", w) for w in args):
        return "sort writes a file"
    if exe == "uniq" and len([w for w in args if w == "-" or not w.startswith("-")]) > 1:
        return "uniq writes a file"
    if exe == "tail" and any(re.match(r"^-[^-]*[fF]|^--(follow|retry)", w) for w in args):
        return "tail -f never ends"
    if exe == "head":
        negative = any(re.match(r"^-[nc]-|^--(lines|bytes)=-", w) for w in args) or \
            any(w in ("-n", "-c") and nxt.startswith("-") for w, nxt in zip(args, args[1:]))
        if negative:
            return "head with a negative count (GNU only)"
    if exe == "cat" and any(w.startswith("-") and not re.fullmatch(r"-[nbsuvet]+", w) for w in args):
        return "cat flag"
    return None


def _tmpkey(p: str) -> str:
    p = os.path.normpath(p)
    return p[len("/private"):] if p.startswith("/private/tmp/") else p


# Flags that take a value, per command, so file operands can be told apart from patterns and counts.
VALUE_FLAGS = {"head": {"-n", "-c"}, "tail": {"-n", "-c"}, "cut": {"-d", "-f", "-c", "-b"},
               "sort": {"-k", "-t", "-S", "-T"}, "grep": {"-e", "-m", "-A", "-B", "-C", "-f"},
               "sed": {"-e"}, "uniq": {"-f", "-s"}}
VALUE_FLAGS["egrep"] = VALUE_FLAGS["fgrep"] = VALUE_FLAGS["grep"]


def _operands(exe: str, args) -> set[int]:
    """Indices of args that name files. A /tmp path anywhere else (a pattern, a message) is refused, because the
    run's /tmp/ paths are rewritten to its private dir and that must only ever change which file is opened."""
    if exe in ("echo", "printf", "true", "false", ":", "pwd", "exit", "tr", "go", "gofmt"):
        return set()
    if exe in ("test", "[", "[["):
        return {k for k, w in enumerate(args) if not w.startswith("-") and w not in ("]", "]]", "=", "==", "!=", "!")}
    flags, pos, k, ended = VALUE_FLAGS.get(exe, set()), [], 0, False
    explicit = False
    while k < len(args):
        w = args[k]
        if not ended and w == "--":
            ended = True
        elif not ended and w.startswith("-") and w != "-":
            if w in flags:
                explicit = explicit or w in ("-e", "-f")
                k += 1
        else:
            pos.append(k)
        k += 1
    if exe in ("grep", "egrep", "fgrep", "sed") and not explicit and pos:
        pos = pos[1:]  # the first operand is the pattern or script
    return set(pos)


def _read_check(exe, words, ctx) -> str | None:
    """A /tmp path may only be a whole file operand, and then it is a read of a file this command already wrote."""
    from classify import VAR
    files = _operands(exe, words) if exe else set()
    for k, w in enumerate(words):
        if "/tmp/" not in w:
            continue
        if VAR in w:
            return "a /tmp path built from a variable"
        if k not in files or not TMP_TARGET.fullmatch(w) or os.path.normpath(w) != w:
            return f"mentions {w} outside a file argument"
        if _tmpkey(w) not in ctx["written"]:
            return f"reads {w} from an earlier run"
    return None


def _segment(words, ctx, depth) -> str | None:
    """None when this simple command is local-safe, else the reason it is not."""
    from classify import ASSIGN, KEYWORDS
    if words and words[0] in LOOPS:
        return "shell loop or function"
    while words and words[0] in KEYWORDS:
        words = words[1:]
    if words and words[0] in LOOPS:
        return "shell loop or function"
    j = 0
    while j < len(words) and ASSIGN.match(words[j]):
        j += 1
    exe = words[j] if j < len(words) else None
    why = _assignments(words[:j], exe and os.path.basename(exe))
    if why or exe is None or exe in ("fi", "}", "done", "esac"):
        return why
    args = words[j + 1:]
    if not _plain(exe) or "/" in exe:
        return f"{exe!r} is not a plain command"
    if exe == "time":
        return _segment([w for w in args if w != "-p"], ctx, depth)
    if exe == "env":
        if any(w.startswith("-") for w in args):
            return "env with flags"
        return _segment(args, ctx, depth)
    if exe == "export":
        for w in args:
            name, eq, val = w.partition("=")
            if name not in GO_ENV or not eq:
                return f"exports {name}"
            why = _env_value(name, val)
            if why:
                return why
        return None
    if exe == "set":
        it = iter(args)
        for w in it:
            if re.fullmatch(r"[-+][eux]*o", w):
                if next(it, None) not in SET_OPTS:
                    return "set option"
            elif not re.fullmatch(r"[-+][eux]+", w):
                return f"set {w}"
        return None
    if exe == "printf" and any(w.startswith("-v") for w in args):
        return "printf -v"
    if exe in SIMPLE:
        return _read_check(exe, args, ctx)
    if exe == "tee":
        for f in args:
            if f.startswith("-"):
                if not re.fullmatch(r"-[aip]+", f):
                    return f"tee {f}"
                continue
            if f != "/dev/null" and not (TMP_TARGET.fullmatch(f) and os.path.normpath(f) == f):
                return "tee writes a repo file"
            ctx["written"].add(_tmpkey(f))
        return None
    if exe in SHELLS:
        script, i = None, 0
        while i < len(args):
            w = args[i]
            if re.fullmatch(r"[-+][eux]*o", w) and i + 1 < len(args) and args[i + 1] in SET_OPTS:
                i += 2
                continue
            if re.fullmatch(r"-[eux]*c[eux]*", w) and i + 1 < len(args) and script is None:
                script = args[i + 1]
                i += 2
                break
            if re.fullmatch(r"-[eux]+", w):
                i += 1
                continue
            return f"{exe} {w}"
        if script is None or i < len(args):
            return f"{exe} without exactly one -c script"
        return _script(script, ctx, depth + 1)
    why = _read_check(exe, args, ctx)
    if why:
        return why
    if exe == "gofmt":
        ctx["n"]["checks"] += 1
        for w in args:
            if w.startswith("-"):
                if not re.fullmatch(r"-[lsed]+", w):
                    return f"gofmt {w}"
            elif not _plain(w) or GLOB.search(w) or \
                    not _inside(ctx["root"], os.path.realpath(os.path.join(ctx["cwd"], w))):
                return f"gofmt path {w!r}"
        return None
    if exe == "go":
        return _go(words[j:], ctx)
    if exe in FILTERS:
        return _filter(exe, args)
    return f"{exe} is not on the local-first list"


def _script(script: str, ctx, depth: int) -> str | None:
    """Segments and redirects in text order, so a /tmp read must follow the write that made the file."""
    from classify import lex
    if depth > 3:
        return "nested too deep"
    events: list = []
    why = _scan(script, events)
    if why:
        return why
    segs, subs = lex(script)
    items = [(seg[0][1], 1, seg) for seg in segs if seg] + [(p, 0, (k, t)) for p, k, t in events]
    for _, kind, x in sorted(items, key=lambda it: (it[0], it[1])):
        if kind == 0:
            k, t = x
            if k == "w":
                ctx["written"].add(_tmpkey(t))
            elif _tmpkey(t) not in ctx["written"]:
                return f"reads {t} from an earlier run"
            continue
        why = _segment([w for w, _ in x], ctx, depth)
        if why:
            return why
    for sub in subs:
        why = _script(sub, dict(ctx, written=set(ctx["written"])), depth + 1)
        if why:
            return why
    return None


def eligible(cmd: str, ctx) -> str | None:
    """None when `cmd` (one shell string) may run locally, else why not.
    ctx: root, cwd, start (real paths), includes (list), n {pkgs, go, checks}, written (set)."""
    from classify import classify
    if BOX_ONLY.search(cmd):
        return "uses Linux or box-only tools or paths"
    why = _script(cmd, ctx, 0)
    if why:
        return why
    v = classify(cmd, ctx["start"])
    if v.get("heavy") or v.get("error"):
        return "heavy (classifier)"
    return None


MAX_CPU_BUSY = 0.8


def _cpu_busy(sample: float = 0.3) -> float | None:
    """Share of CPU time spent busy over `sample` seconds (host_statistics), or None when it can't be read."""
    import ctypes
    import ctypes.util
    try:
        lib = ctypes.CDLL(ctypes.util.find_library("System"))
        lib.mach_host_self.restype = ctypes.c_uint

        def ticks():
            buf, n = (ctypes.c_uint * 4)(), ctypes.c_uint(4)
            if lib.host_statistics(lib.mach_host_self(), 3, buf, ctypes.byref(n)) != 0:  # HOST_CPU_LOAD_INFO
                raise OSError("host_statistics failed")
            return list(buf)

        a, end = ticks(), time.monotonic() + 1.5
        while True:
            time.sleep(sample)
            d = [y - x for x, y in zip(a, ticks())]  # user, system, idle, nice
            # The counters move in coarse steps; a short sample can see none at all, so keep sampling a little.
            if sum(d) >= 100 or time.monotonic() > end:
                return 1 - d[2] / sum(d) if sum(d) > 0 else None
    except (OSError, AttributeError, ValueError):
        return None


def _mac_busy() -> str | None:
    """Why the Mac is too busy for a local check, or None. macOS load averages count blocked and I/O threads (the
    Mac sits near 30 with 60% idle CPU), so the real test is CPU time; load only catches runaway pressure."""
    cpus = os.cpu_count() or 8
    load = os.getloadavg()[1]
    if load > 3 * cpus:
        return f"mac load {load:.0f}"
    busy = _cpu_busy()
    if busy is None:
        return f"mac load {load:.0f}" if load > 1.5 * cpus else None
    if busy > MAX_CPU_BUSY:
        return f"mac cpu {busy:.0%} busy"
    return None


def decide(a, me, cwd: str) -> str | None:
    """None when this run should go local, else the reason it stays remote (for the log only)."""
    from . import lease
    from .runs import ENV_ALLOW
    if os.environ.get("OFFBOX_LOCAL_FIRST", "1") == "0" or getattr(a, "remote", False):
        return "forced remote"
    if a.bg or a.no_sync or a.base or a.fresh or a.template or a.pull:
        return "flags need the box"
    if not os.path.exists(SANDBOX):
        return "no sandbox-exec"
    for e in a.env or []:
        name = e.partition("=")[0]
        if name not in GO_ENV and name not in ENV_ALLOW:
            return f"--env {name}"
    root = os.path.realpath(me["repo_root"])
    why = env_ok(local_env(a, "check", "/nonexistent", root))
    if why:
        return why
    start = os.path.realpath(cwd)
    if not _inside(root, start):
        return "cwd outside the repo"
    counts = {"pkgs": 0, "go": 0, "checks": 0}
    written: set[str] = set()
    for step in a.steps or [a.cmd[0] if len(a.cmd) == 1 else shlex.join(a.cmd)]:
        ctx = {"root": root, "cwd": start, "start": start, "includes": list(a.include or []), "n": counts,
               "written": written}
        why = eligible(step, ctx)
        if why:
            return why
    if not counts["checks"]:
        return "nothing to check locally"
    a.local_writes = bool(counts.get("writes"))  # run() retries a failure of these on the box
    why = _mac_busy()
    if why:
        return why
    con = db()
    try:
        if lease.docker_recent(con, repo_root=me.get("repo_root"), thread=me.get("thread")):
            return "this repo/thread used docker on the box recently"
    finally:
        con.close()
    return None


# ---------------------------------------------------------------- running


def _box_go_version() -> str | None:
    try:
        txt = (common.TEMPLATES_DIR / "crpko-go.sh").read_text()
    except OSError:
        return None
    m = re.search(r"GO_VERSION=\"\$\{OFFBOX_GO_VERSION:-([0-9.]+)\}\"", txt)
    return m.group(1) if m else None


_GO_PATHS: dict | None = None


def _go_paths() -> dict:
    """GOCACHE/GOMODCACHE/GOPATH as the Mac's go sees them (GOENV file included); local runs pin them and set
    GOENV=off so that file can't add flags."""
    global _GO_PATHS
    if _GO_PATHS is None:
        p = subprocess.run(["go", "env", "-json", "GOCACHE", "GOMODCACHE", "GOPATH"], capture_output=True, text=True,
                           timeout=30, cwd="/", env=dict(os.environ, GOTOOLCHAIN="local", GOFLAGS=""))
        vals = json.loads(p.stdout)
        out = {k: os.path.realpath(v.split(os.pathsep)[0]) for k, v in vals.items() if v}
        if set(out) != {"GOCACHE", "GOMODCACHE", "GOPATH"}:
            raise RuntimeError(f"go env: {p.stderr.strip()[:200]}")
        _GO_PATHS = out
    return _GO_PATHS


def local_env(a, rid: str, rundir: str, root: str | None = None) -> dict:
    """Allowlisted environment: no cloud credentials, no Docker daemon, no local FoundationDB, box's Go version."""
    from .runs import build_env
    env = {k: v for k, v in os.environ.items() if k in KEEP_ENV or k.startswith("LC_")}
    extra, _ = build_env(a.env or [])
    env.update(extra)
    env.update(_go_paths())
    flags = env.get("GOFLAGS", "").strip()
    env.update(GOENV="off", GOTELEMETRY="off", TMPDIR=rundir, GOFLAGS=("-p=4 -buildvcs=false " + flags).strip(),
               DOCKER_HOST="unix:///nonexistent/offbox-local-docker.sock", GIT_TERMINAL_PROMPT="0",
               AWS_CONFIG_FILE="/dev/null", AWS_SHARED_CREDENTIALS_FILE="/dev/null", AWS_EC2_METADATA_DISABLED="true",
               FDB_CLUSTER_FILE="/nonexistent/offbox-local.cluster",
               FDB_CLUSTER_FILE_PATH="/nonexistent/offbox-local.cluster", OFFBOX_LOCAL_RUN=rid)
    if os.path.isdir(GNU_GREP):
        env["PATH"] = GNU_GREP + os.pathsep + env.get("PATH", "/usr/bin:/bin")
    v = _box_go_version()
    if v:
        env.setdefault("GOTOOLCHAIN", f"go{v}+auto")
    if _outer_go_work(root):
        env["GOWORK"] = "off"  # a go.work above the repo is never synced to the box
    return env


def _outer_go_work(root: str | None) -> bool:
    if not root:
        return False
    d = os.path.realpath(os.getcwd())
    while True:
        if os.path.isfile(os.path.join(d, "go.work")):
            return not _inside(os.path.realpath(root), d)
        up = os.path.dirname(d)
        if up == d:
            return False
        d = up


def _listen_ports() -> set[int]:
    ports = set(STATIC_PORTS)
    try:
        out = subprocess.run(["/usr/sbin/lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fn"], capture_output=True,
                             text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return ports
    for line in out.splitlines():
        m = re.match(r"n.*:(\d+)$", line)
        if m:
            ports.add(int(m.group(1)))
    return ports


def _q(p: str) -> str:
    return '"' + p.replace("\\", "\\\\").replace('"', '\\"') + '"'


def profile(root: str, rundir: str, env: dict, includes: list[str], ports=None) -> str:
    """sandbox-exec profile for one local run. Later rules win."""
    gp, gc, gm = env["GOPATH"], env["GOCACHE"], env["GOMODCACHE"]
    # Harmless per-user files the toolchain touches on every run (CoreFoundation's text encoding, Go's local
    # telemetry counters).
    telemetry = os.path.join(HOME, "Library/Application Support/go/telemetry")
    readable = [f"(literal {_q(HOME)})", f"(literal {_q(HOME + '/.CFUserTextEncoding')})", f"(subpath {_q(telemetry)})",
                f"(subpath {_q(root)})", f"(subpath {_q(rundir)})"] + \
        [f"(subpath {_q(p)})" for p in (gp + "/pkg", gc, gm) if _inside(HOME, p) or _inside("/private/tmp", p)]
    # The run's own dir and the Go caches only. /tmp is not writable: the command's /tmp/x paths point into rundir.
    writable = ["/dev", rundir, gp + "/pkg", gc, gm, telemetry]
    incs = [os.path.realpath(os.path.join(root, i.strip("/"))) for i in includes]
    lines = [
        "(version 1)",
        "(allow default)",
        f"(deny file-read-data (subpath {_q(HOME)}) (subpath \"/private/tmp\"))",
        f"(allow file-read-data {' '.join(readable)})",
        f'(deny file-read-data (regex {SECRET_FILES}) (regex #"/\\.(aws|ssh|gnupg)/") '
        '(regex #"/\\.docker/config\\.json$") (subpath "/usr/local/etc/foundationdb"))',
        '(allow file-read-data (regex #"/\\.env\\.(example|sample|template|dist)$"))',
    ]
    if incs:
        lines.append("(allow file-read-data " + " ".join(f"(subpath {_q(p)})" for p in incs) + ")")
    lines += [
        "(deny file-write* (require-not (require-any " + " ".join(f"(subpath {_q(p)})" for p in writable) + ")))",
        # The checkout stays read-only even when it sits inside a writable dir.
        f"(deny file-write* (subpath {_q(root)}))",
        # No unix sockets (Docker, SSH agent, local daemons) except DNS and the run's own; no local UDP.
        "(deny network-outbound (remote unix-socket))",
        '(allow network-outbound (remote unix-socket (literal "/private/var/run/mDNSResponder")) '
        f"(remote unix-socket (subpath {_q(rundir)})))",
        '(deny network-outbound (remote udp "localhost:*"))',
    ]
    ports = sorted(_listen_ports() if ports is None else ports)
    if ports:
        lines.append("(deny network-outbound " + " ".join(f'(remote tcp "localhost:{p}")' for p in ports) + ")")
    lines += [
        '(deny process-exec (literal "/usr/bin/osascript") (literal "/usr/bin/open") (literal "/usr/bin/security") '
        '(literal "/usr/bin/ssh") (literal "/usr/bin/scp") (literal "/usr/bin/sudo") (literal "/usr/bin/pbcopy") '
        '(literal "/usr/bin/pbpaste") (regex #"/(docker|fdbcli|kubectl|aws|terraform|gh|op)$"))',
        "(deny signal (with no-report))",  # the reaper probes every pid; don't flood the system log
        "(allow signal (target same-sandbox))",
        "(deny appleevent-send)",
        '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc") '
        '(global-name "com.apple.pasteboard.1"))',
    ]
    return "\n".join(lines) + "\n"


def _nice():
    os.nice(5)


# Runs inside the sandbox, so its signals reach only processes of this run (the profile allows same-sandbox signals
# only). It starts the shell in its own process group, forwards INT/TERM/HUP to it (a second signal, or 5 s after
# the first, kills hard), and once the shell exits kills everything the run left behind, including setsid'd
# helpers, by probing every pid: only this run's processes answer. If its parent dies it stops the run the same way.
REAPER = r"""
import os, signal, subprocess, sys, time
got, child, kill_at = [], None, [0.0]
def stop(sig):
    try:
        os.killpg(child.pid, sig)
    except OSError:
        pass
def on_signal(signum, _frame):
    got.append(signum)
    if not kill_at[0]:
        kill_at[0] = time.monotonic() + 5
    if child is not None:
        stop(signal.SIGKILL if len(got) > 1 else signum)
for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(s, on_signal)
parent = os.getppid()
if not got:
    child = subprocess.Popen(sys.argv[1:], process_group=0)
    if got:
        stop(got[0])
    while child.poll() is None:
        time.sleep(0.2)
        if os.getppid() != parent and not got:
            on_signal(signal.SIGTERM, None)
        elif got and len(got) < 2 and time.monotonic() > kill_at[0]:
            on_signal(signal.SIGKILL, None)
def left():
    me, out = os.getpid(), []
    for p in range(2, 100000):
        if p == me:
            continue
        try:
            os.kill(p, 0)
        except OSError:
            continue
        out.append(p)
    return out
pids = left()
for sig in (signal.SIGTERM, signal.SIGKILL):
    for p in pids:
        try:
            os.kill(p, sig)
        except OSError:
            pass
    end = time.monotonic() + 2
    while pids and time.monotonic() < end:
        time.sleep(0.1)
        pids = left()
    if not pids:
        break
# A cancelled run reports the signal that cancelled it, whatever the child's own handler exited with.
rc = 128 + got[0] if got else child.returncode
os._exit(128 - rc if rc < 0 else rc)
"""


class _Killer:
    """Forward SIGINT/SIGTERM/SIGHUP to the in-sandbox reaper (installed before the spawn, so nothing is missed)."""

    def __init__(self):
        self.p, self.sig, self.old = None, None, {}

    def __enter__(self):
        for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            self.old[s] = signal.signal(s, self.handle)
        return self

    def handle(self, signum, _frame):
        self.sig = self.sig or signum
        if self.p is not None:
            try:
                os.kill(self.p.pid, signum)
            except OSError:
                pass

    def __exit__(self, *exc):
        for s, h in self.old.items():
            signal.signal(s, h)


def _stop(p, grace: float = 5.0) -> None:
    """Make sure the reaper (and through it the run) is gone: TERM, TERM again (hard), then KILL."""
    for sig in (signal.SIGTERM, signal.SIGTERM, signal.SIGKILL):
        if p.poll() is not None:
            return
        try:
            os.kill(p.pid, sig)
        except OSError:
            pass
        try:
            p.wait(timeout=grace)
            return
        except subprocess.TimeoutExpired:
            pass


class _Slot:
    """Non-blocking slot over fcntl locks; .fh is None when the Mac already runs SLOTS local-first jobs."""

    def __init__(self):
        import fcntl
        common.ensure_dirs()
        self.fh = None
        for i in range(SLOTS):
            f = open(common.LOCKS_DIR / f"local-first.{i}", "a+")
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.fh = f
                return
            except OSError:
                f.close()

    def release(self):
        if self.fh:
            self.fh.close()


DENIED = b"operation not permitted"


def _pump(src, fd: int, lf, lock, seen: list) -> None:
    tail = b""
    while True:
        try:
            chunk = os.read(src.fileno(), 65536)
        except OSError:
            break
        if not chunk:
            break
        if DENIED in (tail + chunk).lower():
            seen[0] = True
        tail = chunk[-len(DENIED):]
        try:
            os.write(fd, chunk)
        except OSError:
            pass
        with lock:
            lf.write(chunk)


class Rerun(Exception):
    """The sandbox blocked something the check needed. Nothing outside the run's private dir changed, so the
    caller reruns it on the box."""


def run(a, me, steps: list[str]) -> int | None:
    """Run locally and return the exit code, or None when it could not start here (caller goes remote). Raises
    Rerun when the sandbox blocked the run. Once the command has started this never returns None."""
    from .runs import command_block, report_exit, step_results, steps_block
    slot, rundir, lf, con = None, None, None, None
    try:
        try:
            slot = _Slot()
            if not slot.fh:
                return None
            shown = steps_block(steps) if steps else (a.cmd[0] if len(a.cmd) == 1 else shlex.join(a.cmd))
            rid = new_id("run")
            rundir = tempfile.mkdtemp(prefix=f"offbox-{rid}-", dir=os.path.realpath(tempfile.gettempdir()))
            if not SAFE_DIR.fullmatch(rundir) or _inside(os.path.realpath(me["repo_root"]), rundir):
                raise OSError(f"temp dir {rundir!r} is unusable for a sandboxed run")
            os.mkdir(os.path.join(rundir, "t"))
            os.mkdir(os.path.join(rundir, "tmp"))
            # The command's /tmp/x files live in the run's private dir: no stale files from earlier runs, no
            # clashes between parallel runs, nothing left behind.
            cmd = TMP_REF.sub(rundir + "/t/", shown)
            if not steps:
                cmd = command_block(cmd)
            env = local_env(a, rid, os.path.join(rundir, "tmp"), me["repo_root"])
            prof = profile(os.path.realpath(me["repo_root"]), rundir, env, list(a.include or []))
            chk = subprocess.run([SANDBOX, "-p", prof, "/usr/bin/true"], capture_output=True, timeout=30)
            if chk.returncode != 0:
                raise OSError(f"sandbox preflight failed: {chk.stderr.decode(errors='replace')[:200]}")
            log_path = common.LOGS_DIR / f"{rid}.log"
            lf = open(log_path, "wb")
            con = db()
            con.execute("""INSERT INTO runs (run_id, owner, session_id, thread_id, repo_root, cwd, cmd, mode, status,
                start_at, local_cwd, log_path) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (rid, me["owner"], me.get("session"), me.get("thread"), me["repo_root"], os.getcwd(),
                         (" ; ".join(steps) if steps else shown)[:4000], "local", "starting", now(), os.getcwd(),
                         str(log_path)))
            con.commit()
        except Exception as e:  # noqa: BLE001 - anything before the spawn just sends the run to the box
            log(f"local-first setup failed: {e!r}")
            return None
        with _Killer() as killer:
            if killer.sig:
                _finish(con, rid, "killed", 128 + killer.sig, 0.0)
                return 128 + killer.sig
            try:
                # $0 marks the shell for the monitor (ps -E doesn't show a sandboxed child's environment).
                p = subprocess.Popen([SANDBOX, "-p", prof, PYTHON, "-I", "-S", "-c", REAPER, BASH, "-c", cmd,
                                      f"offbox-local:{rid}"], env=env, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, preexec_fn=_nice,
                                     process_group=0)  # own group: a terminal Ctrl-C arrives once, via _Killer
            except Exception as e:  # noqa: BLE001
                log(f"local-first spawn failed: {e!r}")
                con.execute("DELETE FROM runs WHERE run_id=?", (rid,))
                con.commit()
                return None
            killer.p = p
            if killer.sig:
                killer.handle(killer.sig, None)
            # From here the command may be running: never hand it to the box again (except Rerun below).
            t = time.monotonic()
            lock, denied = threading.Lock(), [False]
            pumps = [threading.Thread(target=_pump, args=(p.stdout, 1, lf, lock, denied), daemon=True),
                     threading.Thread(target=_pump, args=(p.stderr, 2, lf, lock, denied), daemon=True)]
            try:
                say("light command: running on this Mac, not a boat box (offbox run --remote forces the box)")
                log(f"local-first {rid} cwd={os.getcwd()} cmd={shown[:300]}")
                try:
                    con.execute("UPDATE runs SET status='running', process_id=? WHERE run_id=?", (p.pid, rid))
                    con.commit()
                except Exception as e:  # noqa: BLE001
                    log(f"local-first row update failed: {e!r}")
                for th in pumps:
                    th.start()
                code = p.wait()
            finally:
                _stop(p)
                for th in pumps:
                    if th.is_alive() or th.ident:
                        th.join(timeout=5)
                for f in (p.stdout, p.stderr):
                    try:
                        f.close()
                    except OSError:
                        pass
        if code < 0:
            code = 128 - code
        if killer.sig and code == 0:
            code = 128 + killer.sig  # a cancelled run never reports success
        # Retry on the box when the sandbox said no, or when a tested package writes files (its test may hide the
        # error). macOS only reports denials for Apple-signed binaries, so test binaries can't be watched for them.
        rerun = None
        if code != 0 and not killer.sig:
            if denied[0]:
                rerun = "it printed Operation not permitted"
            elif getattr(a, "local_writes", False):
                rerun = "the tested package writes files"
        status = "killed" if killer.sig else ("done" if code == 0 else "failed")
        _finish(con, rid, status, code, round(time.monotonic() - t, 1),
                "local-first: sandbox blocked it, rerun on the box" if rerun else "local-first")
        lf.flush()
        if rerun:
            raise Rerun(rerun)
        if steps:
            res = step_results(log_path)
            failed = next((n for n, rc in res if rc != 0), None)
            report_exit(steps[failed - 1] if failed else "", code, res, len(steps), where="local")
        else:
            report_exit(shown, code, where="local")
        return code
    finally:
        for h in (lf, con):
            try:
                if h:
                    h.close()
            except Exception:  # noqa: BLE001
                pass
        if slot:
            slot.release()
        if rundir:
            shutil.rmtree(rundir, ignore_errors=True)


def _finish(con, rid, status, code, secs, note="local-first"):
    try:
        con.execute("UPDATE runs SET status=?, exit_code=?, end_at=?, error=? WHERE run_id=?",
                    (status, code, now(), note, rid))
        con.commit()
        event(con, None, "local_first", f"{rid} exit={code} {secs}s {status}")
    except Exception as e:  # noqa: BLE001
        log(f"local-first row update failed: {e!r}")
