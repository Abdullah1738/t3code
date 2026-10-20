#!/usr/bin/env python3
"""offbox heavy-command classifier (worker C).

Implements ../heavy-rules.json (the one rule set shared with the gate plugin
offbox-gate.ts and monitor.py). Stdlib only.

  classify.py "<cmd>" [--cwd DIR]     -> JSON verdict
  classify.py --test                   run the embedded vectors (exit 1 on failure)
  classify.py --batch < in.jsonl       {"cmd","cwd"} per line -> verdict per line
"""
from __future__ import annotations

import json
import os
import re
import shlex
import sys
from pathlib import Path

RULES_PATH = Path(os.environ.get("OFFBOX_RULES") or Path(__file__).resolve().parent.parent / "heavy-rules.json")
HOME = os.path.expanduser("~")
ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\+?=")
KEYWORDS = {"if", "then", "else", "elif", "do", "while", "until", "!", "{", "}"}
SKIP_SEG = {"for", "case", "select", "function", "fi", "done", "esac", "in"}
OPCH = set(";&|()<>")
VAR = "\x00"
_SPEC = None
_REPO_CACHE: dict = {}


def spec() -> dict:
    global _SPEC
    if _SPEC is None:
        raw = json.loads(RULES_PATH.read_text())
        thr = raw.get("throwaway_cwd_re", "$^")
        for r in raw["rules"] + raw["wrappers"]:
            r["_cmd"] = re.compile(r["cmd"])
            r["_sub"] = [re.compile(s) for s in r.get("sub", [])]
            r["_vf"] = set(r.get("value_flags", []))
            if r.get("skip_re"):
                r["_skip"] = re.compile(r["skip_re"])
            if r.get("node_script_re"):
                r["_node"] = re.compile(r["node_script_re"])
        raw["_thr"] = re.compile(thr)
        _SPEC = raw
    return _SPEC


# ---------------------------------------------------------------- lexer

def _balanced(s: str, i: int) -> int:
    """i points just after an opening '('. Returns index just after the matching ')'."""
    depth, n = 1, len(s)
    while i < n:
        c = s[i]
        if c == "\\":
            i += 2
            continue
        if c == "'":
            j = s.find("'", i + 1)
            i = n if j < 0 else j + 1
            continue
        if c == '"':
            i += 1
            while i < n and s[i] != '"':
                i += 2 if s[i] == "\\" else 1
            i += 1
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return n


def _dollar(s: str, i: int, buf: list, subs: list) -> int:
    """s[i] == '$'. Appends to buf, returns new index."""
    n = len(s)
    if s.startswith("$(", i):
        j = _balanced(s, i + 2)
        subs.append(s[i + 2:j - 1])
        buf.append(s[i:j])
        return j
    if s.startswith("${", i):
        j = s.find("}", i)
        j = n - 1 if j < 0 else j
        name = s[i + 2:j]
        buf.append(f"{VAR}{name}{VAR}" if re.fullmatch(r"[A-Za-z_]\w*", name) else s[i:j + 1])
        return j + 1
    m = re.match(r"[A-Za-z_]\w*", s[i + 1:])
    if m:
        buf.append(f"{VAR}{m.group(0)}{VAR}")
        return i + 1 + m.end()
    buf.append("$")
    return i + 1


def _word(s: str, i: int, subs: list) -> tuple[str, int]:
    n, buf = len(s), []
    if s[i] == "~" and (i + 1 == n or s[i + 1] in "/ \t\n;&|)"):
        buf.append(HOME)
        i += 1
    while i < n:
        c = s[i]
        if c in " \t\r\n" or c in OPCH:
            break
        if c == "\\":
            if i + 1 < n and s[i + 1] != "\n":
                buf.append(s[i + 1])
            i += 2
        elif c == "'":
            j = s.find("'", i + 1)
            j = n if j < 0 else j
            buf.append(s[i + 1:j])
            i = j + 1
        elif c == '"':
            i += 1
            while i < n and s[i] != '"':
                if s[i] == "\\" and i + 1 < n:
                    buf.append(s[i + 1] if s[i + 1] in '"\\$`' else s[i:i + 2])
                    i += 2
                elif s[i] == "$":
                    i = _dollar(s, i, buf, subs)
                elif s[i] == "`":
                    j = s.find("`", i + 1)
                    j = n if j < 0 else j
                    subs.append(s[i + 1:j])
                    i = j + 1
                else:
                    buf.append(s[i])
                    i += 1
            i += 1
        elif c == "$":
            i = _dollar(s, i, buf, subs)
        elif c == "`":
            j = s.find("`", i + 1)
            j = n if j < 0 else j
            subs.append(s[i + 1:j])
            i = j + 1
        else:
            buf.append(c)
            i += 1
    return "".join(buf), i


def _redirect(s: str, i: int, heredocs: list, subs: list) -> int:
    n = len(s)
    while i < n and s[i].isdigit():
        i += 1
    if s.startswith(("<(", ">("), i):
        j = _balanced(s, i + 2)
        subs.append(s[i + 2:j - 1])
        return j
    for op in ("<<<", "<<-", "<<", "<>", "<&", ">&", ">>", ">|", "&>>", "&>", "<", ">"):
        if s.startswith(op, i):
            i += len(op)
            break
    while i < n and s[i] in " \t":
        i += 1
    if i >= n or s[i] in "\n;|()":
        return i
    target, i = _word(s, i, [])
    if op in ("<<", "<<-"):
        heredocs.append((target.replace(VAR, ""), op == "<<-"))
    return i


def lex(s: str):
    """-> (segments, subs). A segment is a list of (word, start_offset)."""
    segs, cur, subs, heredocs = [], [], [], []
    i, n = 0, len(s)
    while i < n:
        c = s[i]
        if c == "\n":
            if cur:
                segs.append(cur)
            cur = []
            i += 1
            for delim, _strip in heredocs:
                while i < n:
                    j = s.find("\n", i)
                    j = n if j < 0 else j
                    line = s[i:j].strip()
                    i = j + 1
                    if line == delim:
                        break
            heredocs = []
        elif c in " \t\r":
            i += 1
        elif c == "\\" and s.startswith("\\\n", i):
            i += 2
        elif c == "#":
            j = s.find("\n", i)
            i = n if j < 0 else j
        elif c in "<>" or (c == "&" and s.startswith("&>", i)) or (c.isdigit() and re.match(r"\d+[<>]", s[i:i + 6])):
            i = _redirect(s, i, heredocs, subs)
        elif c in ";&|()":
            if cur:
                segs.append(cur)
            cur = []
            i += 2 if s[i:i + 2] in ("&&", "||", ";;", "|&") else 1
        else:
            start = i
            w, i = _word(s, i, subs)
            cur.append((w, start))
    if cur:
        segs.append(cur)
    return segs, subs


# ---------------------------------------------------------------- evaluation

def _expand(w: str, env: dict) -> str:
    if VAR not in w:
        return w
    return re.sub(VAR + r"(\w+)" + VAR, lambda m: env.get(m.group(1), "$" + m.group(1)), w)


def _chdir(cwd, args):
    args = [a for a in args if not a.startswith("-") or a == "-"]
    if not args:
        return HOME
    t = args[0]
    if "$" in t or t == "-":
        return None
    if os.path.isabs(t):
        return os.path.normpath(t)
    return os.path.normpath(os.path.join(cwd, t)) if cwd else None


def _has(flags, wanted) -> bool:
    for f in flags:
        for w in wanted:
            if f == w or f.startswith(w + "=") or (len(w) == 2 and w[1] != "-" and not f.startswith("--") and f.startswith(w)):
                return True
    return False


def _repo_file(cwd, file, pat) -> bool:
    if not cwd:
        return False
    d = cwd
    for _ in range(12):
        p = os.path.join(d, file)
        if p not in _REPO_CACHE:
            try:
                with open(p, errors="replace") as f:
                    _REPO_CACHE[p] = f.read(400_000)
            except OSError:
                _REPO_CACHE[p] = None
        if _REPO_CACHE[p] is not None:
            return re.search(pat, _REPO_CACHE[p]) is not None
        nd = os.path.dirname(d)
        if nd == d:
            break
        d = nd
    return False


def _read(p):
    if p not in _REPO_CACHE:
        try:
            with open(p, errors="replace") as f:
                _REPO_CACHE[p] = f.read(400_000)
        except OSError:
            _REPO_CACHE[p] = None
    return _REPO_CACHE[p]


def _go_module(cwd):
    """-> (module root dir, module path) of the nearest go.mod above cwd, else (None, None)."""
    d = cwd
    for _ in range(12):
        txt = _read(os.path.join(d, "go.mod"))
        if txt is not None:
            m = re.search(r"^module\s+(\S+)", txt, re.M)
            return (d, m.group(1)) if m else (None, None)
        nd = os.path.dirname(d)
        if nd == d:
            break
        d = nd
    return None, None


def _scan(d, rx, ext, mod):
    """-> (any `ext` file in d matches rx, module-local import paths) or None if d is unreadable. Cached."""
    key = ("scan", d, rx.pattern, ext, mod)
    if key not in _REPO_CACHE:
        try:
            names = sorted(n for n in os.listdir(d) if n.endswith(ext))
        except OSError:
            names = None
        res = None
        if names is not None:
            hit, imps = False, set()
            irx = re.compile('"(' + re.escape(mod) + '/[^"\\s]+)"') if mod else None
            for n in names[:400]:
                try:
                    with open(os.path.join(d, n), errors="replace") as f:
                        txt = f.read(200_000)
                except OSError:
                    hit = True
                    break
                if rx.search(txt):
                    hit = True
                    break
                if irx:
                    imps.update(irx.findall(txt))
            res = (hit, sorted(imps))
        _REPO_CACHE[key] = res
    return _REPO_CACHE[key]


PKG_SCAN_MAX = 60


def _pkg_mentions(cwd, pos, c) -> bool:
    """A target package dir (or, with go_imports, any package of the same module it transitively imports) has an
    `ext` file matching re. Unresolvable targets or more than PKG_SCAN_MAX dirs count as a match (stay heavy)."""
    if not cwd:
        return True
    rx, ext = re.compile(c["re"]), c["ext"]
    root, mod = _go_module(cwd) if c.get("go_imports") else (None, None)
    todo = []
    for t in pos or ["."]:
        if VAR in t or "$" in t or "..." in t or not t.startswith((".", "/")):
            return True
        todo.append(os.path.normpath(t if os.path.isabs(t) else os.path.join(cwd, t)))
    seen = set()
    while todo:
        d = todo.pop(0)
        if d in seen:
            continue
        seen.add(d)
        if len(seen) > PKG_SCAN_MAX:
            return True
        r = _scan(d, rx, ext, mod)
        if r is None or r[0]:
            return True
        todo += [os.path.normpath(os.path.join(root, imp[len(mod) + 1:])) for imp in r[1]]
    return False


def _cond(c: dict, flags, pos, cwd) -> bool:
    sp = spec()
    if "has_flag" in c and not _has(flags, c["has_flag"]):
        return False
    if "lacks_flag" in c and _has(flags, c["lacks_flag"]):
        return False
    if "min_pos" in c and len(pos) < c["min_pos"]:
        return False
    if "max_pos" in c and len(pos) > c["max_pos"]:
        return False
    if "pos_all_re" in c and not all(re.search(c["pos_all_re"], p) for p in pos):
        return False
    if "pos_none_re" in c and any(re.search(c["pos_none_re"], p) for p in pos):
        return False
    if "pos_any_re" in c and not any(re.search(c["pos_any_re"], p) for p in pos):
        return False
    if "cwd_re" in c:
        rx = sp["_thr"] if c["cwd_re"] == "$throwaway" else re.compile(c["cwd_re"])
        if not cwd or not rx.search(cwd):
            return False
    if "repo_file" in c and not _repo_file(cwd, c["repo_file"]["file"], c["repo_file"]["re"]):
        return False
    if "pkg_mentions" in c and not _pkg_mentions(cwd, pos, c["pkg_mentions"]):
        return False
    return True


def _match(rule, base, argv):
    if not rule["_cmd"].fullmatch(base):
        return None
    flags, pos, i = [], [], 1
    while i < len(argv):
        a = argv[i]
        if a == "--":
            i += 1
            continue
        if a.startswith("-") and len(a) > 1:
            flags.append(a)
            i += 2 if a in rule["_vf"] else 1
            continue
        pos.append(a)
        i += 1
    subs = rule["_sub"]
    if len(pos) < len(subs) or any(not r.fullmatch(p) for r, p in zip(subs, pos)):
        return None
    skip = rule.get("_skip")
    rest = [p for p in pos[len(subs):] if not ASSIGN.match(p) and not (skip and skip.fullmatch(p))]
    return flags, rest


def _heavy(rule, flags, pos, cwd) -> bool:
    if any(_cond(c, flags, pos, cwd) for c in rule.get("force_heavy_when", [])):
        return True
    hw = rule.get("heavy_when")
    if hw is not None and not any(_cond(c, flags, pos, cwd) for c in hw):
        return False
    return not any(_cond(c, flags, pos, cwd) for c in rule.get("local_when", []))


def _peel(argv, ctx, start, out, depth):
    for _ in range(10):
        while argv and ASSIGN.match(argv[0]):
            argv = argv[1:]
        if not argv:
            return None
        base = os.path.basename(argv[0])
        w = next((w for w in spec()["wrappers"] if w["_cmd"].fullmatch(base)
                  and len(argv) > len(w["_sub"]) and all(r.fullmatch(a) for r, a in zip(w["_sub"], argv[1:]))), None)
        if not w:
            return argv
        if w.get("_node"):
            rest = [a for a in argv[1:] if not a.startswith("-")]
            m = w["_node"].search(rest[0]) if rest else None
            if not m:
                return argv
            argv = [m.group(1)] + argv[argv.index(rest[0]) + 1:]
            continue
        if w["cmd"] == "perl" and not any(a in ("-e", "-E") for a in argv[1:]):
            return argv
        rest, i = argv[1 + len(w["_sub"]):], 0
        sflags = set(w.get("script_flags", []))
        while i < len(rest) and rest[i].startswith("-") and rest[i] != "-":
            a = rest[i]
            if a == "--":
                i += 1
                break
            name, eq, val = a.partition("=")
            if a in sflags or (w.get("script_cluster") and re.fullmatch(r"-[a-zA-Z]*c[a-zA-Z]*", a)):
                if i + 1 < len(rest):
                    _analyze(rest[i + 1], dict(ctx), depth + 1, out, start)
                return None
            if eq and name in sflags:
                _analyze(val, dict(ctx), depth + 1, out, start)
                return None
            i += 2 if a in w["_vf"] else 1
        rest = rest[i:]
        while rest and ASSIGN.match(rest[0]):
            rest = rest[1:]
        argv = rest[w.get("skip_pos", 0):]
    return argv


def _analyze(src, ctx, depth, out, outer_start):
    if depth > 5 or not src:
        return
    segs, subs = lex(src)
    env = ctx["env"]
    for seg in segs:
        words = [(_expand(w, env), s) for w, s in seg]
        while words and words[0][0] in KEYWORDS:
            words = words[1:]
        if not words or words[0][0] in SKIP_SEG:
            continue
        j = 0
        while j < len(words) and ASSIGN.match(words[j][0]):
            j += 1
        if j == len(words):
            for w, _ in words:
                k, _, v = w.partition("=")
                env[k.rstrip("+")] = v
            continue
        argv = [w for w, _ in words[j:]]
        start = words[j][1] if outer_start is None else outer_start
        envs = [w.partition("=")[0].rstrip("+") for w, _ in words[:j]] if outer_start is None else []
        base = os.path.basename(argv[0])
        if base in ("cd", "pushd"):
            ctx["cwd"] = _chdir(ctx["cwd"], argv[1:])
            continue
        if base == "export":
            for w in argv[1:]:
                if ASSIGN.match(w):
                    k, _, v = w.partition("=")
                    env[k] = v
            continue
        argv = _peel(argv, ctx, start, out, depth)
        if not argv or os.path.basename(argv[0]) == "offbox":
            continue
        base = os.path.basename(argv[0])
        for rule in spec()["rules"]:
            m = _match(rule, base, argv)
            if m and _heavy(rule, m[0], m[1], ctx["cwd"]):
                out.append({"rule": rule["id"], "class": rule["class"], "size": rule["size"], "why": rule["why"],
                            "start": start, "envs": envs, "argv": " ".join(argv)[:200]})
                break
    for s in subs:
        _analyze(s, {"cwd": ctx["cwd"], "env": dict(env)}, depth + 1, out, -1)


def _rewrite(cmd: str, hits: list, size: str) -> str:
    sz = "" if size == "default" else f"--size {size} "
    if any(h["start"] is None or h["start"] < 0 for h in hits):
        return f"offbox run {sz}-- bash -c {shlex.quote(cmd)}"
    s = cmd
    for st in sorted({h["start"] for h in hits}, reverse=True):
        mine = [h for h in hits if h["start"] == st]
        hsz = max((h["size"] for h in mine), key=spec()["sizes"].index)
        envs = "".join(f"--env {e} " for e in dict.fromkeys(e for h in mine for e in h["envs"]))
        s = s[:st] + "offbox run " + ("" if hsz == "default" else f"--size {hsz} ") + envs + "-- " + s[st:]
    return s


def classify(cmd: str, cwd: str | None = None) -> dict:
    out: list = []
    try:
        env = {"HOME": HOME, "TMPDIR": os.environ.get("TMPDIR", "/tmp/")}
        _analyze(cmd, {"cwd": os.path.normpath(cwd) if cwd else None, "env": env}, 0, out, None)
    except Exception as e:  # noqa: BLE001  fail open
        return {"heavy": False, "error": f"{type(e).__name__}: {e}"}
    if not out:
        return {"heavy": False}
    size = max((h["size"] for h in out), key=spec()["sizes"].index)
    return {"heavy": True, "rule": out[0]["rule"], "class": out[0]["class"], "size": size, "why": out[0]["why"],
            "rules": sorted({h["rule"] for h in out}), "rewrite": _rewrite(cmd, out, size)}


def run_vectors() -> int:
    bad = 0
    vecs = spec().get("vectors", [])
    fixtures = str(Path(__file__).resolve().parent / "tests" / "fixtures")
    for v in vecs:
        cwd = v.get("cwd")
        r = classify(v["cmd"], cwd.replace("$FIXTURES", fixtures, 1) if cwd else cwd)
        ok = r["heavy"] == v["heavy"] and (not v["heavy"] or "rule" not in v or r.get("rule") == v["rule"])
        ok = ok and ("rewrite" not in v or r.get("rewrite") == v["rewrite"])
        if not ok:
            bad += 1
            print(f"FAIL {v['cmd'][:120]!r} cwd={v.get('cwd')} want heavy={v['heavy']} rule={v.get('rule')} got {r}")
    print(f"{len(vecs) - bad}/{len(vecs)} vectors pass")
    return 1 if bad else 0


def main(argv: list[str]) -> int:
    if argv[:1] == ["--test"]:
        return run_vectors()
    if argv[:1] == ["--batch"]:
        for line in sys.stdin:
            d = json.loads(line)
            print(json.dumps(classify(d["cmd"], d.get("cwd"))))
        return 0
    cwd = None
    if "--cwd" in argv:
        k = argv.index("--cwd")
        cwd = argv[k + 1]
        argv = argv[:k] + argv[k + 2:]
    if not argv:
        print(__doc__)
        return 2
    print(json.dumps(classify(" ".join(argv) if len(argv) > 1 else argv[0], cwd or os.getcwd()), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
