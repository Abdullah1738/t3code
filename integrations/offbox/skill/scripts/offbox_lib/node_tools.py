"""Repo-local Node executables and package-manager bootstrap advice."""

import shlex
from pathlib import Path

from . import package_manager
from .common import read_json


# Include absent bin directories and disable hashing so installs cannot leave a
# previously resolved global tool cached for the rest of a compound command.
PATH_BLOCK = r'''if [ -f "$HOME"/@ROOT@/package.json ]; then
  __offbox_repo_root=$(builtin cd -- "$HOME"/@ROOT@ && pwd -P)
  __offbox_repo_bins=
  __offbox_repo_path() {
    local dir=$(pwd -P) bins= rest= entry tail=$PATH sep=
    while :; do
      entry=${tail%%:*}
      if [ -z "${__offbox_toolchain_bin:-}" ] || [ "$entry" != "$__offbox_toolchain_bin" ]; then
        case ":$__offbox_repo_bins" in
          *":$entry:"*) ;;
          *) rest="$rest$sep$entry"; sep=: ;;
        esac
      fi
      [[ $tail == *:* ]] || break
      tail=${tail#*:}
    done
    case "$dir/" in
      "$__offbox_repo_root/"*)
        while :; do
          bins="$bins$dir/node_modules/.bin:"
          [ "$dir" != "$__offbox_repo_root" ] || break
          dir=${dir%/*}
        done ;;
    esac
    __offbox_repo_bins=$bins
    export PATH="${__offbox_toolchain_bin:+$__offbox_toolchain_bin:}$bins$rest"
    hash -r 2>/dev/null || :
    set +h
  }
  __offbox_repo_init() {
    unalias cd 2>/dev/null || :
    function cd { builtin cd "$@" && __offbox_repo_path; }
    export -f cd
    if declare -F __offbox_command_not_found >/dev/null; then
      function command_not_found_handle { __offbox_command_not_found "$@"; }
      export -f command_not_found_handle
    fi
    if [ -n "${__offbox_bash_env:-}" ]; then
      if [ "${BASH_ENV-}" != "$__offbox_bash_env" ]; then
        export __offbox_original_bash_env=${BASH_ENV-}
      fi
      export BASH_ENV=$__offbox_bash_env
    fi
    __offbox_repo_path
  }
  export __offbox_repo_root __offbox_repo_bins
  export -f __offbox_repo_init __offbox_repo_path
@HINT@
  __offbox_repo_init
  # New Bash processes reset hashall even though exported functions survive.
  export __offbox_original_bash_env=${BASH_ENV-}
  __offbox_expand_bash_env() {
    local __offbox_env_file=$__offbox_original_bash_env __offbox_env_prefix __offbox_promptvars=0
    __offbox_expanded_bash_env=
    [ -n "$__offbox_env_file" ] || return 0
    case "$__offbox_env_file" in
      '~/'*|'~') __offbox_env_file="$HOME${__offbox_env_file:1}" ;;
      '~+/'*|'~+') __offbox_env_file="$PWD${__offbox_env_file:2}" ;;
      '~-/'*|'~-') __offbox_env_prefix='~-'; __offbox_env_file="${OLDPWD-$__offbox_env_prefix}${__offbox_env_file:2}" ;;
      '~'*)
        __offbox_env_prefix=${__offbox_env_file%%/*}
        # Only a literal username reaches eval, never filename or shell syntax.
        if [[ ${__offbox_env_prefix:1} =~ ^[a-zA-Z0-9_.-]+$ ]]; then
          local __offbox_env_expanded
          eval "__offbox_env_expanded=$__offbox_env_prefix"
          __offbox_env_file="$__offbox_env_expanded${__offbox_env_file:${#__offbox_env_prefix}}"
        fi ;;
    esac
    # @P uses Bash's parameter/command/arithmetic expansion without parsing a
    # filename as shell code. Protect literal backslashes from prompt escapes.
    shopt -q promptvars || { shopt -s promptvars; __offbox_promptvars=1; }
    __offbox_env_file=${__offbox_env_file//\\/\\\\}
    __offbox_env_file=${__offbox_env_file@P}
    [ "$__offbox_promptvars" -eq 0 ] || shopt -u promptvars
    [ -n "$__offbox_env_file" ] || return 0
    # BASH_ENV loads relative to cwd; source would search PATH for a basename.
    case "$__offbox_env_file" in */*) ;; *) __offbox_env_file=./$__offbox_env_file ;; esac
    __offbox_expanded_bash_env=$__offbox_env_file
  }
  export -f __offbox_expand_bash_env
  mkdir -p "$HOME/.offbox"
  __offbox_bash_env=$(mktemp "$HOME/.offbox/bash-env.XXXXXX") || exit 97
  export __offbox_bash_env
  {
    # Non-Bash launchers can drop exported functions while keeping BASH_ENV.
    printf '%s\n' 'if [[ -n ${__offbox_repo_root-} && ${__offbox_repo_bins+x} && ${__offbox_original_bash_env+x} && -n ${__offbox_bash_env-} ]]; then'
    for __offbox_function in __offbox_repo_path __offbox_repo_init __offbox_expand_bash_env __offbox_command_not_found; do
      if declare -F "$__offbox_function" >/dev/null; then
        printf 'declare -F %s >/dev/null || {\n' "$__offbox_function"
        declare -f "$__offbox_function"
        printf '}\nexport -f %s\n' "$__offbox_function"
      fi
    done
    printf '%s\n' \
      'export BASH_ENV=$__offbox_original_bash_env' \
      '__offbox_expand_bash_env "$@"' \
      '[ ! -r "$__offbox_expanded_bash_env" ] || . "$__offbox_expanded_bash_env"' \
      '__offbox_repo_init' \
      'fi'
  } > "$__offbox_bash_env"
  export BASH_ENV=$__offbox_bash_env
fi'''


def block(rdir: str, root: Path | None = None) -> str:
    manifest = read_json(root / "package.json", {}) if root else {}
    cases = []
    for tool, package in (("vp", "vite-plus"), ("tsc-rs", "tsc-rs")):
        if isinstance(manifest, dict) and any(isinstance(manifest.get(key), dict) and package in manifest[key]
                                              for key in ("dependencies", "devDependencies")):
            message = (f"offbox: {tool} is a repo-local tool ({package}) and node_modules isn't installed on this box yet. "
                       f"Run: offbox run -- sh -c '{package_manager.install_command(root)} && <your command>'")
            cases.append(f"      {tool}) printf '%s\\n' {shlex.quote(message)} >&2; return 127 ;;")
    # Let Bash identify the failed command, including assignments and cd/--step forms.
    # No preflight may reject a tool that an earlier command in this run installs.
    hint = ('''  __offbox_command_not_found() {
    if [ ! -e "$__offbox_repo_root/node_modules" ]; then
      case "$1" in
''' + "\n".join(cases) + '''
      esac
    fi
    printf '%s: command not found\\n' "$1" >&2
    return 127
  }
  export -f __offbox_command_not_found''' if cases else "")
    return PATH_BLOCK.replace("@ROOT@", shlex.quote(rdir)).replace("@HINT@", hint)
