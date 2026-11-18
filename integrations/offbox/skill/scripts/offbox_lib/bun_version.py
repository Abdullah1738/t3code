"""Match Bun to an exact repo pin or the client's installed binary."""

import json
import re
import shlex
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from . import node_version, toolchain
from .common import OFFBOX_BUN_DEFAULT

EXACT = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
WORD = re.compile(r'''(?:^|[\s"'`;|&()<>])/?(?:[\w.+~-]+/)*bunx?(?=$|[\s"'`;|&()<>])''')


@dataclass(frozen=True)
class Choice:
    wanted: str
    source: str
    warnings: tuple[str, ...] = ()


def uses_bun(root: Path, cwd: Path, words) -> bool:
    return (any(WORD.search(word) for word in words) or
            any((directory / name).is_file() for directory in node_version._dirs(root, cwd)
                for name in ('bun.lock', 'bun.lockb')))


def mac_version():
    """Probe the executable directly; shell functions and aliases aren't version sources."""
    path = shutil.which('bun')
    if path:
        try:
            result = subprocess.run([path, '--version'], capture_output=True, text=True, timeout=3)
            version = result.stdout.strip()
            if result.returncode == 0 and re.fullmatch(EXACT, version):
                return version
        except (OSError, subprocess.SubprocessError, UnicodeError):
            pass
    return None


def want(root: Path, cwd: Path, words, mac=None, env=None):
    """Pure picker: all process inputs, including the Mac probe and override, are explicit."""
    root, cwd = Path(root).resolve(), Path(cwd).resolve()
    if not uses_bun(root, cwd, words):
        return None
    directories = node_version._dirs(root, cwd)
    warnings = []

    def warn(path, reason):
        warnings.append(f'offbox: warning: {path}: {reason}')

    selected = None
    if env is not None:
        if re.fullmatch(EXACT, env):
            selected = (env, 'env')
        else:
            warn('OFFBOX_BUN_VERSION', 'expected exact X.Y.Z; ignoring')
    if selected is None:
        for directory in directories:
            path = directory / '.bun-version'
            if not path.exists():
                continue
            try:
                pin = path.read_text(encoding='utf-8').rstrip()
                match = re.fullmatch('v?(' + EXACT + ')', pin)
                if match:
                    selected = (match[1], '.bun-version')
                    break
                warn(path, 'expected exact X.Y.Z; ignoring')
            except (OSError, UnicodeError):
                warn(path, 'cannot read Bun pin; ignoring')

    packages = []
    for directory in directories:
        path = directory / 'package.json'
        if not path.exists():
            continue
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(data, dict):
                raise ValueError('not an object')
            packages.append((path, data))
        except (OSError, UnicodeError, ValueError):
            warn(path, 'cannot read package.json; ignoring')
    if selected is None:
        for path, data in packages:
            pin = data.get('packageManager')
            if isinstance(pin, str) and pin.startswith('bun@'):
                match = re.fullmatch('bun@(' + EXACT + r')(?:\+sha[0-9A-Za-z.-]+)?', pin)
                if match:
                    selected = (match[1], 'packageManager')
                    break
                warn(path, 'expected packageManager bun@X.Y.Z; ignoring')
            elif pin is not None and not isinstance(pin, str):
                warn(path, 'invalid packageManager; ignoring')
    version, source = selected or ((mac, 'mac') if isinstance(mac, str) and re.fullmatch(EXACT, mac)
                                   else (OFFBOX_BUN_DEFAULT, 'default'))
    for path, data in packages:
        engines = data.get('engines')
        if not isinstance(engines, dict) or 'bun' not in engines:
            continue
        spec = engines['bun']
        ranges = node_version.parse_range(spec) if isinstance(spec, str) else None
        if ranges is None:
            warn(path, 'cannot parse engines.bun; ignoring')
        elif not any(lo <= node_version._key(*map(int, version.split('.'))) < hi for lo, hi in ranges):
            warnings.append(f'offbox: warning: bun {version} outside engines.bun {json.dumps(spec)}')
        break
    return Choice(version, source, tuple(warnings))


BLOCK = r'''__offbox_bun_want=@VERSION@
__offbox_bun_source=@SOURCE@
__offbox_bun_started=$(date +%s%N)
__offbox_bun_had=$(bun --version 2>/dev/null) || __offbox_bun_had=none
__offbox_bun_used=box
if [ "$__offbox_bun_had" = "$__offbox_bun_want" ]; then
  __offbox_bun_executable=$(command -v bun)
  __offbox_bun_dir=$(CDPATH= builtin cd -- "$(dirname "$__offbox_bun_executable")" && pwd -P) || __offbox_stop 'cannot resolve Bun directory'
  __offbox_bun_executable="$__offbox_bun_dir/bun"
else
  __offbox_bun_cache="$HOME/.bun-versions/$__offbox_bun_want"
  case $(uname -m) in
    x86_64|amd64) __offbox_bun_arch=x64 ;;
    aarch64|arm64) __offbox_bun_arch=aarch64 ;;
    *) __offbox_stop "bun $__offbox_bun_want: unsupported architecture for https://github.com/oven-sh/bun/releases/download/bun-v$__offbox_bun_want/" ;;
  esac
  __offbox_bun_url="https://github.com/oven-sh/bun/releases/download/bun-v$__offbox_bun_want/bun-linux-$__offbox_bun_arch.zip"
  __offbox_bun_used=$(
    mkdir -p "$HOME/.bun-versions" || exit 1
    # Different repo leases can share the same version cache on a box.
    exec 9>"$HOME/.bun-versions/$__offbox_bun_want.lock" || exit 1
    flock -w 120 9 || exit 1
    if [ "$("$__offbox_bun_cache/bin/bun" --version 2>/dev/null)" = "$__offbox_bun_want" ]; then
      ln -sf bun "$__offbox_bun_cache/bin/bunx" || exit 1
      echo cached
      exit 0
    fi
    __offbox_bun_tmp=$(mktemp -d "$HOME/.bun-versions/.stage.XXXXXX") || exit 1
    trap 'rm -rf -- "$__offbox_bun_tmp"' EXIT
    __offbox_curl -fsSL "$__offbox_bun_url" -o "$__offbox_bun_tmp/bun.zip" >&2 || exit 1
    unzip -q "$__offbox_bun_tmp/bun.zip" -d "$__offbox_bun_tmp" >&2 || exit 1
    mkdir "$__offbox_bun_tmp/ready" "$__offbox_bun_tmp/ready/bin" || exit 1
    mv "$__offbox_bun_tmp/bun-linux-$__offbox_bun_arch/bun" "$__offbox_bun_tmp/ready/bin/bun" || exit 1
    chmod +x "$__offbox_bun_tmp/ready/bin/bun" || exit 1
    [ "$("$__offbox_bun_tmp/ready/bin/bun" --version)" = "$__offbox_bun_want" ] || exit 1
    ln -s bun "$__offbox_bun_tmp/ready/bin/bunx" || exit 1
    # Invalid old entries are never used, and a partial download never becomes the cache.
    if [ -e "$__offbox_bun_cache" ]; then mv "$__offbox_bun_cache" "$__offbox_bun_tmp/invalid" || exit 1; fi
    mv "$__offbox_bun_tmp/ready" "$__offbox_bun_cache" || exit 1
    echo installed
  ) || __offbox_stop "bun $__offbox_bun_want: install failed ($__offbox_bun_url)"
  export PATH="$__offbox_bun_cache/bin:$PATH"
  __offbox_bun_executable="$__offbox_bun_cache/bin/bun"
fi
__offbox_pin_command bun "$__offbox_bun_executable"
__offbox_pin_command bunx "$__offbox_bun_executable"
hash -r
[ "$(bun --version 2>/dev/null)" = "$__offbox_bun_want" ] || __offbox_stop "bun $__offbox_bun_want: activation failed"
__offbox_bun_timing=
if [ "$__offbox_bun_used" = installed ]; then
  __offbox_bun_tenths=$(( ($(date +%s%N) - __offbox_bun_started + 50000000) / 100000000 ))
  printf -v __offbox_bun_timing ' in %s.%ss' "$((__offbox_bun_tenths / 10))" "$((__offbox_bun_tenths % 10))"
fi
echo "offbox: bun $__offbox_bun_want (from $__offbox_bun_source; box had $__offbox_bun_had; $__offbox_bun_used$__offbox_bun_timing)" >&2
unset __offbox_bun_want __offbox_bun_source __offbox_bun_had __offbox_bun_used __offbox_bun_cache __offbox_bun_arch __offbox_bun_url __offbox_bun_executable __offbox_bun_dir
unset __offbox_bun_started __offbox_bun_tenths __offbox_bun_timing
'''


def block(choice):
    if choice is None:
        return ''
    warnings = ''.join('echo ' + shlex.quote(line) + ' >&2\n' for line in choice.warnings)
    return (toolchain.SHELL + warnings + BLOCK.replace('@VERSION@', shlex.quote(choice.wanted))
            .replace('@SOURCE@', shlex.quote(choice.source)))


def result(text):
    matches = re.findall(r'^offbox: bun (' + EXACT + r') \(from (env|\.bun-version|packageManager|mac|default); box had ([^;\n]+); (box|cached|installed)(?: in ([0-9]+\.[0-9]+)s)?\)$', text, re.M)
    if matches:
        version, source, had, used, seconds = matches[-1]
        return dict(wanted=version, source=source, box_had=had, used=used,
                    install_s=float(seconds) if used == 'installed' and seconds else None)
    return None
