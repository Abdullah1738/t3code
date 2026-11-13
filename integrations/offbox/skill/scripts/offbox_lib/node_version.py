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

from . import toolchain

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
__offbox_cur=$(node --version 2>/dev/null) || __offbox_cur=
if [ -n "$__offbox_best" ]; then
  export PATH="$__offbox_best/bin:$PATH"
elif [ "${__offbox_require_nvm:-0}" != 1 ] && [[ "$__offbox_cur" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && __offbox_in "$(__offbox_nk "$__offbox_cur")"; then
  :
else
  __offbox_reason="$__offbox_want (box default ${__offbox_cur:-none}; nvm:${__offbox_have:- none})"
  export NVM_DIR="$HOME/.nvm"
  mkdir -p "$NVM_DIR" || __offbox_stop "$__offbox_reason: cannot create nvm directory"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    __offbox_curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/nvm.sh -o "$NVM_DIR/nvm.sh.tmp" &&
      mv "$NVM_DIR/nvm.sh.tmp" "$NVM_DIR/nvm.sh" || __offbox_stop "$__offbox_reason: nvm download failed"
  fi
  __offbox_index="$NVM_DIR/.offbox-index.tab"
  __offbox_curl -fsSL https://nodejs.org/dist/index.tab -o "$__offbox_index.tmp" &&
    mv "$__offbox_index.tmp" "$__offbox_index" || __offbox_stop "$__offbox_reason: Node index download failed"
  # The index is newest first. Filter with the *intersection*, not nvm's partial-version matching.
  __offbox_install=
  while read -r __offbox_v __offbox_rest; do
    [[ "$__offbox_v" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
    if __offbox_in "$(__offbox_nk "$__offbox_v")"; then __offbox_install=$__offbox_v; break; fi
  done < "$__offbox_index"
  [ -n "$__offbox_install" ] || __offbox_stop "$__offbox_reason: no published Node satisfies the pin"
  (
    . "$NVM_DIR/nvm.sh" --no-use || exit 1
    __offbox_nvm_home=$NVM_DIR
    mkdir -p "$NVM_DIR/.cache" || exit 1
    __offbox_stage=$(mktemp -d "$NVM_DIR/.offbox-stage.XXXXXX") || exit 1
    trap 'rm -rf -- "$__offbox_stage"' EXIT
    export NVM_DIR="$__offbox_stage"
    ln -s "$__offbox_nvm_home/.cache" "$NVM_DIR/.cache" || exit 1
    __offbox_slug=$(nvm_get_download_slug node binary "$__offbox_install") || exit 1
    __offbox_compression=$(nvm_get_artifact_compression "$__offbox_install") || exit 1
    __offbox_cache="$NVM_DIR/.cache/bin/$__offbox_slug"
    mkdir -p "$__offbox_cache" || exit 1
    __offbox_archive="$__offbox_cache/$__offbox_slug.$__offbox_compression"
    __offbox_curl -fsSL "https://nodejs.org/dist/$__offbox_install/SHASUMS256.txt" -o "$__offbox_cache/SHASUMS256.txt" || exit 1
    __offbox_sum=$(awk -v file="$__offbox_slug.$__offbox_compression" '$2 == file {print $1; exit}' "$__offbox_cache/SHASUMS256.txt")
    [[ "$__offbox_sum" =~ ^[0-9a-fA-F]{64}$ ]] || exit 1
    __offbox_archive_ok() {
      local actual
      if command -v sha256sum >/dev/null; then
        actual=$(sha256sum "$1" 2>/dev/null) || return 1
      else
        actual=$(shasum -a 256 "$1" 2>/dev/null) || return 1
      fi
      [ "${actual%% *}" = "$__offbox_sum" ]
    }
    if ! __offbox_archive_ok "$__offbox_archive"; then
      __offbox_curl -fsSL "https://nodejs.org/dist/$__offbox_install/$__offbox_slug.$__offbox_compression" -o "$__offbox_archive.tmp" || exit 1
      __offbox_archive_ok "$__offbox_archive.tmp" || { echo 'offbox: Node archive checksum mismatch' >&2; exit 1; }
      mv "$__offbox_archive.tmp" "$__offbox_archive" || exit 1
    fi
    # nvm 0.40.3 can fall through a checksum error. Supply only our independently verified archive.
    nvm_remote_version() { echo "$__offbox_install"; }
    nvm_download_artifact() { echo "$__offbox_archive"; }
    nvm_download() { return 1; }
    unset NVM_OFFLINE
    nvm install -b "$__offbox_install" || exit 1
    [ "$("$NVM_DIR/versions/node/$__offbox_install/bin/node" --version)" = "$__offbox_install" ] || exit 1
    mkdir -p "$__offbox_nvm_home/versions/node" || exit 1
    mv "$NVM_DIR/versions/node/$__offbox_install" "$__offbox_nvm_home/versions/node/$__offbox_install" || exit 1
  ) >&2 || __offbox_stop "$__offbox_reason: nvm install $__offbox_install failed"
  export PATH="$NVM_DIR/versions/node/$__offbox_install/bin:$PATH"
  __offbox_actual=$(node --version 2>/dev/null) || __offbox_actual=
  [[ "$__offbox_actual" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && __offbox_in "$(__offbox_nk "$__offbox_actual")" ||
    __offbox_stop "$__offbox_reason: installed Node did not activate"
  echo "offbox: node $__offbox_actual (installed: $__offbox_want)" >&2
  __offbox_installed=1
fi
__offbox_actual=$(node --version 2>/dev/null) || __offbox_stop "$__offbox_want: selected Node cannot execute"
[[ "$__offbox_actual" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && __offbox_in "$(__offbox_nk "$__offbox_actual")" || __offbox_stop "$__offbox_want: selected Node $__offbox_actual does not match"
__offbox_pin_command node "$(command -v node)"
[ "${__offbox_installed:-}" = 1 ] || echo "offbox: node $__offbox_actual ($__offbox_want)" >&2
unset -f __offbox_nk __offbox_in
unset __offbox_want __offbox_best __offbox_bk __offbox_have __offbox_d __offbox_v __offbox_k __offbox_cur __offbox_actual __offbox_installed __offbox_install __offbox_reason __offbox_index __offbox_rest
"""


NO_PIN_BLOCK = r"""__offbox_default=$(
  __offbox_alias=default
  for (( __offbox_depth=0; __offbox_depth<16; __offbox_depth++ )); do
    [[ "$__offbox_alias" =~ ^(lts/)?[a-zA-Z0-9_.*-]+$ ]] || break
    [[ "$__offbox_alias" != *..* ]] || break
    [ -f "$HOME/.nvm/alias/$__offbox_alias" ] || break
    IFS= read -r __offbox_alias < "$HOME/.nvm/alias/$__offbox_alias" || :
  done
  printf '%s' "$__offbox_alias"
)
__offbox_default=${__offbox_default#v}
case "$__offbox_default" in *.x|*.X|*.\*) __offbox_default=${__offbox_default%.*} ;; esac
__offbox_best=; __offbox_bk=-1; __offbox_preferred=; __offbox_pk=-1
for __offbox_d in "$HOME"/.nvm/versions/node/v*; do
  __offbox_v=${__offbox_d##*/}
  [[ "$__offbox_v" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
  [ -x "$__offbox_d/bin/node" ] || continue
  __offbox_k=$(IFS=.; set -- ${__offbox_v#v}; echo $((10#$1*1000000 + 10#$2*1000 + 10#$3)))
  if [ "$__offbox_k" -gt "$__offbox_bk" ]; then __offbox_best=$__offbox_d; __offbox_bk=$__offbox_k; fi
  case "${__offbox_v#v}" in
    "$__offbox_default"|"$__offbox_default".*)
      if [ "$__offbox_k" -gt "$__offbox_pk" ]; then __offbox_preferred=$__offbox_d; __offbox_pk=$__offbox_k; fi ;;
  esac
done
__offbox_choice='newest nvm'
if [ "$__offbox_default" = system ]; then
  __offbox_path=; __offbox_sep=; __offbox_tail=$PATH:
  while [[ "$__offbox_tail" == *:* ]]; do
    __offbox_entry=${__offbox_tail%%:*}; __offbox_tail=${__offbox_tail#*:}
    case "$__offbox_entry" in "$HOME"/.nvm/versions/node/*/bin) continue ;; esac
    __offbox_path=$__offbox_path$__offbox_sep$__offbox_entry; __offbox_sep=:
  done
  export PATH=$__offbox_path
  hash -r 2>/dev/null || :
  __offbox_best=
  __offbox_preferred=
fi
if [ -n "$__offbox_preferred" ]; then
  __offbox_best=$__offbox_preferred
  __offbox_choice='nvm default'
fi
if [ -n "$__offbox_best" ]; then
  export PATH="$__offbox_best/bin:$PATH"
  hash -r 2>/dev/null || :
  echo "offbox: node ${__offbox_best##*/} (no pin; $__offbox_choice)" >&2
else
  __offbox_cur=$(node --version 2>/dev/null) || __offbox_cur=none
  __offbox_command=$(command -v node) || __offbox_command=unavailable
  if [ "$__offbox_default" = system ]; then
    echo "offbox: node $__offbox_cur (no pin; nvm default system $__offbox_command)" >&2
  else
    echo "offbox: node $__offbox_cur (no pin; box default $__offbox_command)" >&2
  fi
fi
unset __offbox_default __offbox_best __offbox_bk __offbox_preferred __offbox_pk __offbox_d __offbox_v __offbox_k __offbox_choice __offbox_cur __offbox_command __offbox_path __offbox_sep __offbox_tail __offbox_entry
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
    return sorted(out)


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
        en_label = f"{prefix}package.json engines {eng}" if en is not None else None
        if nv is not None and en is not None:
            inter = _isect(nv, en)
            return inter, f"{nv_label}, {en_label}"
        if nv:
            return nv, nv_label
        if en is not None:
            return en, en_label
        return None
    return None


def _ci_values(text):
    entries = []
    list_indent = scalar_indent = None
    flow = ''
    for line in text.splitlines():
        indent = len(line) - len(line.lstrip())
        if scalar_indent is not None:
            if not line.strip() or indent > scalar_indent:
                continue
            scalar_indent = None
        # Script/heredoc bodies are YAML data, not workflow keys.
        scalar = re.match(r'^(\s*)(-\s+)?[^#]+:\s*[|>][0-9+-]*\s*(?:#.*)?$', line)
        if scalar:
            scalar_indent = len(scalar[1]) + len(scalar[2] or '')
            list_indent = None
            continue
        clean = re.sub(r'\$\{\{.*?\}\}', 'EXPRESSION', line.split('#', 1)[0])
        value = clean.strip()
        if flow:
            flow += ' ' + value
            if flow.endswith(']'):
                entries.extend(flow[1:-1].split(','))
                flow = ''
            continue
        match = re.match(r"^(\s*)(?:['\"]node-version['\"]|node-version):\s*(.*)$", clean)
        if match:
            value = match[2].strip()
            list_indent = len(match[1]) if not value else None
            if value.startswith('['):
                if value.endswith(']'):
                    entries.extend(value[1:-1].split(','))
                else:
                    flow = value
            else:
                entries.append(value)
        elif list_indent is not None and value:
            item = re.match(r'^(\s*)-\s+(.+)$', clean)
            if item and len(item[1]) >= list_indent:
                entries.append(item[2].strip())
            else:
                list_indent = None
    return entries


def _ci_want(root):
    signals = []
    workflows = root / '.github/workflows'
    for path in sorted([*workflows.glob('*.yml'), *workflows.glob('*.yaml')]):
        text = _read(path)
        if text is None:
            continue
        ranges, versions = [], []
        for value in _ci_values(text):
            value = value.strip().strip("'\"")
            if not value or '${{' in value:
                continue
            parsed = parse_range(value) or parse_nvmrc(value)
            if parsed:
                ranges.extend(parsed)
                versions.append(value)
        if ranges:
            signals.append((ranges, f"{path.relative_to(root).as_posix()} node-version {', '.join(dict.fromkeys(versions))}"))
    if not signals:
        return None
    # Matrices remain a union; conflicting workflows use the one with the highest major.
    majors = {max(lo for lo, _ in ranges) // 1_000_000 for ranges, _ in signals}
    if len(majors) > 1:
        highest = max(majors)
        signals = [(ranges, label) for ranges, label in signals
                   if max(lo for lo, _ in ranges) // 1_000_000 == highest]
        suffix = f'; workflows disagree, highest major {highest}'
    else:
        suffix = ''
    label = signals[0][1]
    if len(signals) > 1:
        label += f' (+{len(signals) - 1} workflows)'
    return sorted({r for ranges, _ in signals for r in ranges}), label + suffix


def want(root: Path, cwd: Path):
    """(ranges, label) for the repo at root as seen from cwd, or None. Never raises."""
    try:
        root = Path(root)
        return _want(root, Path(cwd)) or _ci_want(root)
    except Exception:
        return None


def block(w, *, require_nvm=False) -> str:
    """Select or provision a matching Node, stopping before user code on failure."""
    if w is None:
        return NO_PIN_BLOCK
    ranges, label = w
    rng = " ".join(f"{lo} {hi}" for lo, hi in ranges)
    return toolchain.SHELL + f"__offbox_require_nvm={int(require_nvm)}\n" + (BLOCK.replace("@RANGES@", rng)
            .replace("@WANT@", shlex.quote(label)))
