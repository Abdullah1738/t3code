"""Pick the nvm Node a repo asks for: .nvmrc / .node-version and package.json engines.node.

Versions are keys major*1e6 + minor*1e3 + patch. A range is a list of (lo, hi) with hi exclusive.
Mirrors the reference prototype in the offbox-node-28oct board artifact (checked against its cases in
tests/test_node_version.py).
"""
import json
import re
import shlex
from pathlib import Path

TOP = 10**12
LTS = {"argon": 4, "boron": 6, "carbon": 8, "dubnium": 10, "erbium": 12, "fermium": 14, "gallium": 16,
       "hydrogen": 18, "iron": 20, "jod": 22, "krypton": 24}
VER = re.compile(r"^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-+][0-9A-Za-z.-]*)?$")

BLOCK = r"""__offbox_want=@WANT@
__offbox_nk() { local IFS=.; set -- ${1#v}; echo $(( 10#${1:-0} * 1000000 + 10#${2:-0} * 1000 + 10#${3:-0} )); }
__offbox_in() { local k=$1; set -- @RANGES@; while [ $# -ge 2 ]; do [ "$k" -ge "$1" ] && [ "$k" -lt "$2" ] && return 0; shift 2; done; return 1; }
__offbox_best=; __offbox_bk=-1; __offbox_have=
for __offbox_d in "$HOME"/.nvm/versions/node/v*; do
  __offbox_v=${__offbox_d##*/}
  case "${__offbox_v#v}" in ''|*[!0-9.]*) continue ;; esac
  [ -x "$__offbox_d/bin/node" ] || continue
  __offbox_have="$__offbox_have $__offbox_v"
  __offbox_k=$(__offbox_nk "$__offbox_v")
  if __offbox_in "$__offbox_k" && [ "$__offbox_k" -gt "$__offbox_bk" ]; then __offbox_best=$__offbox_d; __offbox_bk=$__offbox_k; fi
done
if [ -n "$__offbox_best" ]; then
  export PATH="$__offbox_best/bin:$PATH"
  echo "offbox: node ${__offbox_best##*/} ($__offbox_want)" >&2
else
  __offbox_cur=$(node --version 2>/dev/null)
  if [ -n "$__offbox_cur" ] && __offbox_in "$(__offbox_nk "${__offbox_cur%%-*}")"; then
    echo "offbox: node $__offbox_cur (box default; $__offbox_want)" >&2
  else
    echo "offbox: warning: no node on this box matches $__offbox_want (box default ${__offbox_cur:-none}; nvm:${__offbox_have:- none}). Install one once: offbox run -- 'source ~/.nvm/nvm.sh && nvm install @MAJOR@'" >&2
  fi
fi
unset -f __offbox_nk __offbox_in
unset __offbox_want __offbox_best __offbox_bk __offbox_have __offbox_d __offbox_v __offbox_k __offbox_cur
"""


def _key(ma, mi=0, pa=0):
    return ma * 1_000_000 + min(mi, 999) * 1_000 + min(pa, 999)


def _partial(s):
    m = VER.match(s)
    if not m:
        return None
    out = []
    for g in m.groups():
        if g is None or not g.isdigit():
            break
        out.append(int(g))
    return out


def _lower(p):
    return _key(*(p + [0, 0, 0])[:3])


def _upper(p):
    if not p:
        return TOP
    q = p[:-1] + [p[-1] + 1]
    return _key(*(q + [0, 0, 0])[:3])


def _comparator(c):
    m = re.match(r"^(>=|<=|>|<|=|\^|~)?(.*)$", c)
    op, v = m.group(1) or "", m.group(2)
    p = _partial(v) if v not in ("", "*", "x", "X") else []
    if p is None:
        return None
    if op in ("", "="):
        return (_lower(p), _upper(p))
    if op == ">=":
        return (_lower(p), TOP)
    if op == ">":
        return (_lower(p) + 1 if len(p) == 3 else _upper(p), TOP) if p else (TOP, TOP)
    if op == "<":
        return (0, _lower(p))
    if op == "<=":
        return (0, _key(*p) + 1 if len(p) == 3 else _upper(p))
    if op == "~":
        return (_lower(p), _upper(p[:2]) if len(p) >= 2 else _upper(p))
    if op == "^":
        if not p:
            return (0, TOP)
        i = next((i for i, n in enumerate(p) if n != 0), len(p) - 1)
        return (_lower(p), _upper(p[:i + 1]))
    return None


def _isect(a, b):
    out = []
    for lo1, hi1 in a:
        for lo2, hi2 in b:
            lo, hi = max(lo1, lo2), min(hi1, hi2)
            if lo < hi:
                out.append((lo, hi))
    return sorted(out)


def parse_range(spec):
    """engines.node text -> sorted [(lo, hi)], or None when empty or unparsable."""
    spec = spec.strip()
    if not spec:
        return None
    out = []
    for alt in spec.split("||"):
        alt = re.sub(r"(>=|<=|>|<|=|\^|~)\s+", r"\1", alt.strip())
        m = re.match(r"^(\S+)\s+-\s+(\S+)$", alt)
        if m:
            a, b = _partial(m.group(1)), _partial(m.group(2))
            if a is None or b is None:
                return None
            cur = [(_lower(a), _key(*b) + 1 if len(b) == 3 else _upper(b))]
        else:
            cur = [(0, TOP)]
            for c in alt.split() or ["*"]:
                r = _comparator(c)
                if r is None:
                    return None
                cur = _isect(cur, [r])
        out += cur
    out = [r for r in out if r[0] < r[1]]
    return sorted(out) or None


def _first_line(text):
    return next((l.split("#")[0].strip() for l in text.splitlines() if l.split("#")[0].strip()), "")


def parse_nvmrc(text):
    """.nvmrc / .node-version text -> [(lo, hi)], or None (lts/*, node, stable, junk)."""
    line = _first_line(text)
    if line.lower().startswith("lts/"):
        n = LTS.get(line[4:].lower())
        return [(_key(n), _key(n + 1))] if n else None
    p = _partial(line)
    if not p:
        return None
    return [(_lower(p), _key(p[0] + 1))]


def _read(p):
    try:
        return p.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _engines(d):
    text = _read(d / "package.json")
    if text is None:
        return None
    try:
        data = json.loads(text)
    except ValueError:
        return None
    eng = data.get("engines") if isinstance(data, dict) else None
    node = eng.get("node") if isinstance(eng, dict) else None
    return node.strip() if isinstance(node, str) else None


def _dirs(root, cwd):
    """cwd first, then up to root; just root when cwd is outside it."""
    try:
        rel = cwd.resolve().relative_to(root.resolve())
    except ValueError:
        return [root]
    dirs = [root]
    cur = root
    for part in rel.parts:
        cur = cur / part
        dirs.append(cur)
    return list(reversed(dirs))


def _want(root, cwd):
    for d in _dirs(root, cwd):
        prefix = "" if d == root else d.relative_to(root).as_posix() + "/"
        name = ".nvmrc"
        text = _read(d / ".nvmrc")
        if text is None:
            name = ".node-version"
            text = _read(d / ".node-version")
        eng = _engines(d)
        if text is None and eng is None:
            continue
        nv = parse_nvmrc(text) if text is not None else None
        nv_label = f"{prefix}{name} {_first_line(text)}" if nv else None
        en = parse_range(eng) if eng else None
        en_label = f"{prefix}package.json engines {eng}" if en else None
        if nv and en:
            inter = _isect(nv, en)
            if inter:
                return inter, f"{nv_label}, {en_label}"
            return en, en_label
        if nv:
            return nv, nv_label
        if en:
            return en, en_label
        return None
    return None


def want(root: Path, cwd: Path):
    """(ranges, label) for the repo at root as seen from cwd, or None. Never raises."""
    try:
        return _want(Path(root), Path(cwd))
    except Exception:
        return None


def block(w) -> str:
    """Bash block that puts the newest fitting nvm Node first on PATH."""
    ranges, label = w
    major = min(lo for lo, _ in ranges) // 1_000_000
    rng = " ".join(f"{lo} {hi}" for lo, hi in ranges)
    return (BLOCK.replace("@RANGES@", rng).replace("@MAJOR@", str(major))
            .replace("@WANT@", shlex.quote(label)))
