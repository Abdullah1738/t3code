"""Repo pnpm pin selection, shared with callers that need CI-compatible toolchains."""
import json
import re
import shlex
from pathlib import Path

from . import node_version, toolchain

PIN = re.compile(r"^v?\d+(?:\.(?:\d+|x|\*)){0,2}(?:\+sha(?:224|256|384|512)\.[a-zA-Z0-9+/=]+)?$")
SCALAR = r'''["']?([^\s"'#{},]+)["']?'''


def _ci(root):
    env, action = set(), set()
    for p in sorted((root / '.github/workflows').glob('*')):
        if p.suffix not in ('.yaml', '.yml'):
            continue
        text = node_version._read(p) or ''
        env.update(re.findall(r'''^\s*["']?PNPM_VERSION["']?:\s*''' + SCALAR, text, re.M))
        env.update(re.findall(r'''^\s*(?:-\s+)?env:\s*\{[^}\n]*?\bPNPM_VERSION:\s*''' + SCALAR, text, re.M))
        # YAML step keys can appear in either order, and the step itself may have a name/id.
        lines = text.splitlines()
        for i, line in enumerate(lines):
            if not re.search(r'\buses:\s*["\']?pnpm/action-setup@', line):
                continue
            depth = len(line) - len(line.lstrip())
            start = next((j for j in range(i, -1, -1)
                          if re.match(r'\s*-\s+', lines[j]) and
                          len(lines[j]) - len(lines[j].lstrip()) <= depth), i)
            step_depth = len(lines[start]) - len(lines[start].lstrip())
            end = next((j for j in range(start + 1, len(lines)) if lines[j].strip() and
                        (len(lines[j]) - len(lines[j].lstrip()) < step_depth or
                         (len(lines[j]) - len(lines[j].lstrip()) == step_depth and
                          lines[j].lstrip().startswith('- ')))), len(lines))
            for j in range(start, end):
                header = re.match(r'\s*(?:-\s+)?with:\s*(.*)', lines[j])
                if not header:
                    continue
                if header.group(1).startswith('{'):
                    m = re.search(r'\bversion:\s*' + SCALAR, header.group(1))
                    if m:
                        action.add(m.group(1))
                    continue
                with_depth = len(lines[j]) - len(lines[j].lstrip())
                for option in lines[j + 1:end]:
                    if option.strip() and len(option) - len(option.lstrip()) <= with_depth:
                        break
                    m = re.match(r'\s*version:\s*' + SCALAR, option)
                    if m:
                        action.add(m.group(1))

    for values, source in ((env, 'ci PNPM_VERSION'), (action, 'ci pnpm/action-setup')):
        if values:
            return (next(iter(values)) if len(values) == 1 else '', source)
    return None


def want(root: Path, cwd: Path):
    for d in node_version._dirs(Path(root), Path(cwd)):
        lock = node_version._read(d / 'pnpm-lock.yaml')
        if lock is None:
            continue
        try:
            pkg = json.loads(node_version._read(d / 'package.json') or '{}')
        except ValueError:
            return '', 'invalid package.json'
        manager = pkg.get('packageManager', '') if isinstance(pkg, dict) else ''
        if isinstance(manager, str) and manager.startswith('pnpm@'):
            return manager[5:], 'packageManager'
        ci = _ci(Path(root))
        if ci:
            return ci
        m = re.search(r'^lockfileVersion:\s*' + SCALAR, lock, re.M)
        version = m.group(1) if m else '?'
        major = version.split('.')[0]
        # Lockfile 9 is shared by pnpm 9/10/11; the compatibility fallback must retain package.json overrides.
        pin = {'9': '10', '6': '8', '5': '7'}.get(major, '')
        return pin, f'lockfile {version}'
    return None


BLOCK = r'''__offbox_pnpm_pin=@PIN@
__offbox_pnpm_source=@SOURCE@
__offbox_pnpm_fail() { __offbox_stop "pnpm $__offbox_pnpm_pin ($__offbox_pnpm_source; box ${__offbox_pnpm_current:-none}): $*"; }
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export npm_config_manage_package_manager_versions=false
# A version probe must not let an unconfigured Corepack shim fetch its default/latest package manager.
__offbox_pnpm_current=$(COREPACK_ENABLE_NETWORK=0 pnpm --version 2>/dev/null) || __offbox_pnpm_current=
__offbox_pnpm_matches() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  case "$1." in "$__offbox_pnpm_base."*) return 0 ;; esac
  return 1
}
__offbox_pnpm_base=${__offbox_pnpm_pin%%+*}
__offbox_pnpm_base=${__offbox_pnpm_base#v}
__offbox_pnpm_base=${__offbox_pnpm_base%.x}; __offbox_pnpm_base=${__offbox_pnpm_base%.\*}
__offbox_pnpm_cache="$HOME/.offbox/toolchains/pnpm/$__offbox_pnpm_pin"
if [ -x "$__offbox_pnpm_cache/bin/pnpm" ]; then
  export PATH="$__offbox_pnpm_cache/bin:$PATH"
  __offbox_pnpm_current=$(pnpm --version 2>/dev/null) || __offbox_pnpm_current=
fi
# A Corepack dispatcher is cwd-sensitive even when its --version probe matches.
# Reuse its cached package's actual CLI, never the dispatcher itself.
if __offbox_pnpm_matches "$__offbox_pnpm_current" && [ ! -x "$__offbox_pnpm_cache/bin/pnpm" ]; then
  __offbox_pnpm_cli=$(node -e '
    const fs=require("fs"),p=require("path"),v=process.argv[2];
    const cli=dir=>{try{const m=JSON.parse(fs.readFileSync(p.join(dir,"package.json"))); if(!["pnpm","@pnpm/exe"].includes(m.name)||m.version!==v)return ""; const b=typeof m.bin==="string"?m.bin:m.bin.pnpm; const f=p.resolve(dir,b); return fs.existsSync(f)?f:""}catch{return ""}};
    let found="";
    try {
      const f=fs.realpathSync(process.argv[1]),dir=p.resolve(p.dirname(f),"..");
      found=cli(dir);
      let corepack=false;
      try{corepack=JSON.parse(fs.readFileSync(p.join(dir,"package.json"))).name==="corepack"}catch{}
      const fd=fs.openSync(f,"r"),buffer=Buffer.alloc(4096);
      let header="";
      try{header=buffer.subarray(0,fs.readSync(fd,buffer,0,buffer.length,0)).toString()}finally{fs.closeSync(fd)}
      corepack=corepack||(header.includes("corepack.cjs")&&header.includes("runMain"));
      // Standalone pnpm executables need no package manifest. Only dispatchers must be unwrapped.
      if(!found&&!corepack)found=f;
    }catch{}
    const home=process.env.COREPACK_HOME||p.join(process.env.XDG_CACHE_HOME||p.join(process.env.HOME,".cache"),"node/corepack");
    for(const dir of [p.join(home,"v1/pnpm",v),p.join(home,"pnpm",v)])found=found||cli(dir);
    console.log(found);
  ' "$(command -v pnpm)" "$__offbox_pnpm_current") || __offbox_pnpm_cli=
  if [ -n "$__offbox_pnpm_cli" ]; then
    __offbox_pin_command pnpm "$__offbox_pnpm_cli"
    __offbox_pnpm_current=$(pnpm --version 2>/dev/null) || __offbox_pnpm_current=
  else
    __offbox_pnpm_current=
  fi
fi
if ! __offbox_pnpm_matches "$__offbox_pnpm_current"; then
  (
  mkdir -p "${__offbox_pnpm_cache%/*}" || __offbox_pnpm_fail 'cannot create cache'
  [ ! -e "$__offbox_pnpm_cache" ] || __offbox_pnpm_fail 'cached activation is invalid'
  __offbox_pnpm_tmp=$(mktemp -d "${__offbox_pnpm_cache%/*}/.stage.XXXXXX") || __offbox_pnpm_fail 'cannot create staging directory'
  trap 'rm -rf -- "$__offbox_pnpm_tmp"' EXIT
  __offbox_pnpm_version=$__offbox_pnpm_base
  if [[ "$__offbox_pnpm_base" =~ ^[0-9]+$ ]]; then
    __offbox_curl -fsSL "https://registry.npmjs.org/pnpm/latest-$__offbox_pnpm_base" -o "$__offbox_pnpm_tmp/index.json" || __offbox_pnpm_fail 'registry lookup failed'
    __offbox_pnpm_version=$(node -e 'console.log(require(process.argv[1]).version || "")' "$__offbox_pnpm_tmp/index.json") || __offbox_pnpm_fail 'invalid registry metadata'
  elif [[ ! "$__offbox_pnpm_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    __offbox_curl -fsSL https://registry.npmjs.org/pnpm -H 'Accept: application/vnd.npm.install-v1+json' -o "$__offbox_pnpm_tmp/index.json" || __offbox_pnpm_fail 'registry lookup failed'
    __offbox_pnpm_version=$(node -e 'const p=require(process.argv[1]),s=process.argv[2]+"."; console.log(Object.keys(p.versions).filter(v=>/^\d+\.\d+\.\d+$/.test(v)&& (v+".").startsWith(s)).sort((a,b)=>{const x=a.split(".").map(Number),y=b.split(".").map(Number); return y[0]-x[0]||y[1]-x[1]||y[2]-x[2]} )[0]||"")' "$__offbox_pnpm_tmp/index.json" "$__offbox_pnpm_base") || __offbox_pnpm_fail 'invalid registry metadata'
  fi
  __offbox_pnpm_matches "$__offbox_pnpm_version" || __offbox_pnpm_fail 'no published version satisfies the pin'
  __offbox_curl -fsSL "https://registry.npmjs.org/pnpm/$__offbox_pnpm_version" -o "$__offbox_pnpm_tmp/meta.json" || __offbox_pnpm_fail 'version lookup failed'
  __offbox_curl -fsSL "https://registry.npmjs.org/pnpm/-/pnpm-$__offbox_pnpm_version.tgz" -o "$__offbox_pnpm_tmp/pnpm.tgz" || __offbox_pnpm_fail 'archive download failed'
  node -e 'const fs=require("fs"),c=require("crypto"),m=JSON.parse(fs.readFileSync(process.argv[1])),b=fs.readFileSync(process.argv[2]),i=m.dist.integrity; if(!i||!i.startsWith("sha512-")||c.createHash("sha512").update(b).digest("base64")!==i.slice(7))process.exit(1); const h=process.argv[3].split("+")[1]; if(h){const [a,v]=h.split("."); if(!["hex","base64"].some(e=>c.createHash(a).update(b).digest(e)===v))process.exit(1)}' "$__offbox_pnpm_tmp/meta.json" "$__offbox_pnpm_tmp/pnpm.tgz" "$__offbox_pnpm_pin" || __offbox_pnpm_fail 'archive checksum mismatch'
  tar -xzf "$__offbox_pnpm_tmp/pnpm.tgz" -C "$__offbox_pnpm_tmp" || __offbox_pnpm_fail 'archive extraction failed'
  __offbox_pnpm_bin=$(node -e 'const b=require(process.argv[1]).bin.pnpm; if(!/^bin\/[a-zA-Z0-9.-]+$/.test(b))process.exit(1); console.log(b)' "$__offbox_pnpm_tmp/meta.json") || __offbox_pnpm_fail 'invalid pnpm entry point'
  [ "$(node "$__offbox_pnpm_tmp/package/$__offbox_pnpm_bin" --version)" = "$__offbox_pnpm_version" ] || __offbox_pnpm_fail 'staged pnpm cannot execute'
  mkdir -p "$__offbox_pnpm_tmp/bin"
  # Bypass Corepack entirely: this verified package and shim have no implicit latest lookup.
  printf '#!/bin/sh\nexec node "%s/package/%s" "$@"\n' "$__offbox_pnpm_cache" "$__offbox_pnpm_bin" > "$__offbox_pnpm_tmp/bin/pnpm"
  chmod +x "$__offbox_pnpm_tmp/bin/pnpm"
  mv "$__offbox_pnpm_tmp" "$__offbox_pnpm_cache" || __offbox_pnpm_fail 'cache activation failed'
  ) || exit 99
  export PATH="$__offbox_pnpm_cache/bin:$PATH"
  __offbox_pnpm_current=$(pnpm --version 2>/dev/null) || __offbox_pnpm_fail 'activated pnpm cannot execute'
fi
__offbox_pnpm_matches "$__offbox_pnpm_current" || __offbox_pnpm_fail 'activated pnpm does not match'
__offbox_pin_command pnpm "$(command -v pnpm)"
echo "offbox: pnpm v$__offbox_pnpm_current ($__offbox_pnpm_source)" >&2
unset -f __offbox_pnpm_fail __offbox_pnpm_matches
unset __offbox_pnpm_pin __offbox_pnpm_base __offbox_pnpm_source __offbox_pnpm_current __offbox_pnpm_cache __offbox_pnpm_tmp __offbox_pnpm_version __offbox_pnpm_bin
'''


def block(w):
    pin, source = w
    if not PIN.fullmatch(pin):
        return toolchain.SHELL + '__offbox_stop ' + shlex.quote(f'pnpm pin {pin!r} ({source}) is unsupported or conflicting')
    return toolchain.SHELL + BLOCK.replace('@PIN@', shlex.quote(pin)).replace('@SOURCE@', shlex.quote(source))
