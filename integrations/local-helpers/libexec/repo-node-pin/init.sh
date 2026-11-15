# Sourced by zsh and bash. Never replaces the safe-chain pnpm function.
# Agent shells are noninteractive and do not read the vendor's .zshrc/.bashrc hooks.
[ ! -r "$HOME/.safe-chain/scripts/init-posix.sh" ] || . "$HOME/.safe-chain/scripts/init-posix.sh"
_repo_node_refresh() {
    [ "${_repo_node_busy:-}" = 1 ] && return 0
    [ "${_repo_node_seen_pwd:-}" = "$PWD" ] && [ "${_repo_node_seen_path:-}" = "$PATH" ] && return 0
    _repo_node_busy=1
    local scan="$PWD" relevant=0 rest="$PATH" part clean='' output removed=0 count=0
    while :; do
        if [ -f "$scan/.nvmrc" ] || [ -f "$scan/.node-version" ] || [ -f "$scan/package.json" ] || [ -f "$scan/pnpm-lock.yaml" ]; then relevant=1; break; fi
        [ -e "$scan/.git" ] && break
        [ "$scan" = / ] && break
        scan=${scan%/*}; [ -n "$scan" ] || scan=/
    done
    # Snapshot restoration can replace our PATH with one already containing the same Node.
    if [ -n "${_repo_node_added_node:-}" ]; then
        while :; do
            part=${rest%%:*}
            [ "$part" != "$_repo_node_added_node" ] || count=$((count + 1))
            case "$rest" in *:*) rest=${rest#*:} ;; *) break ;; esac
        done
        [ "$count" -gt "${_repo_node_base_node_count:-0}" ] || removed=1
    fi
    rest=$PATH
    # Remove only the extra copy this helper inserted; retain the caller's original entries.
    while :; do
        part=${rest%%:*}
        if [ "$removed" = 0 ] && [ -n "${_repo_node_added_node:-}" ] && [ "$part" = "$_repo_node_added_node" ]; then
            removed=1
        elif [ "$part" != "$ROBOB_REPO_NODE_HELPER/pnpm-bin" ]; then
            clean="${clean}${part}:"
        fi
        case "$rest" in *:*) rest=${rest#*:} ;; *) break ;; esac
    done
    clean=${clean%:}
    if [ "$relevant" = 1 ]; then
        if output=$("$ROBOB_REPO_NODE_PYTHON" -S "$ROBOB_REPO_NODE_HELPER/select.py" "$PWD" "$clean"); then
            eval "$output" || { _repo_node_busy=0; return 0; }
            if [ -n "${_repo_node_warning:-}" ]; then
                local root="$PWD" physical_root warning_key
                while [ ! -e "$root/.git" ] && [ "$root" != / ]; do
                    root=${root%/*}; [ -n "$root" ] || root=/
                done
                [ "$root" != / ] || root=$scan
                # Canonicalize aliases without running zsh chpwd hooks or capturing their output.
                if [ -n "${ZSH_VERSION:-}" ]; then
                    physical_root=$(builtin cd -q "$root" && builtin pwd -P) || physical_root=$root
                else
                    physical_root=$(builtin cd "$root" && builtin pwd -P) || physical_root=$root
                fi
                root=$physical_root
                warning_key="$root
$_repo_node_warning"
                if [ "$warning_key" != "${_REPO_NODE_WARNED:-}" ]; then
                    printf '%s\n' "repo-node: $_repo_node_warning" >&2 || :
                    # One bounded marker survives nested bash/zsh children, including Python subprocesses.
                    export _REPO_NODE_WARNED="$warning_key"
                fi
            fi
            _repo_node_base_node_count=0
            rest=$clean
            while [ -n "${_repo_node_added_node:-}" ]; do
                part=${rest%%:*}
                [ "$part" != "$_repo_node_added_node" ] || _repo_node_base_node_count=$((_repo_node_base_node_count + 1))
                case "$rest" in *:*) rest=${rest#*:} ;; *) break ;; esac
            done
        fi
    else
        PATH=$clean; export PATH
        unset ROBOB_REPO_NODE ROBOB_REPO_PNPM_CLI ROBOB_REPO_PNPM_HINT
        _repo_node_added_node=''
    fi
    export _repo_node_added_node _repo_node_base_node_count
    _repo_node_seen_pwd=$PWD
    _repo_node_seen_path=$PATH
    _repo_node_busy=0
    return 0
}

# zsh preexec also runs between script lines when installed from .zshenv.
# Its status must not turn a preceding, guarded failure into an errexit exit.
_repo_node_hook() { _repo_node_refresh || :; return 0; }

: "${ROBOB_REPO_NODE_HELPER:=$HOME/.local/libexec/repo-node-pin}"
: "${ROBOB_REPO_NODE_PYTHON:=/opt/homebrew/bin/python3}"
if [ "${BASH_ENV:-}" != "$ROBOB_REPO_NODE_HELPER/bash-env.sh" ]; then
    ROBOB_REPO_PREVIOUS_BASH_ENV=${BASH_ENV:-}
    export ROBOB_REPO_PREVIOUS_BASH_ENV
    BASH_ENV=$ROBOB_REPO_NODE_HELPER/bash-env.sh; export BASH_ENV
fi

if [ "${_repo_node_hooked:-}" != 1 ]; then
    _repo_node_hooked=1
    if [ -n "${ZSH_VERSION:-}" ]; then
        # chpwd covers `cd repo && pnpm ...`; preexec covers interactive PATH changes.
        eval 'chpwd_functions+=(_repo_node_hook); preexec_functions+=(_repo_node_hook); precmd_functions+=(_repo_node_hook)'
        if [ ! -o interactive ]; then
            # Claude restores its snapshot PATH after .zshenv. Refresh before its next command.
            if typeset -f TRAPDEBUG >/dev/null; then
                functions -c TRAPDEBUG _repo_node_previous_debug
            else
                _repo_node_zsh_traps=$(trap) || _repo_node_zsh_traps=''
                case "$_repo_node_zsh_traps" in
                    *' DEBUG')
                        _repo_node_zsh_debug=${_repo_node_zsh_traps##*trap -- }
                        _repo_node_zsh_debug=${_repo_node_zsh_debug% DEBUG}
                        # zsh ignores a string trap's ordinary command status, unlike a function trap's return.
                        _repo_node_previous_debug() { eval "eval $_repo_node_zsh_debug"; :; } ;;
                    *) _repo_node_previous_debug() { :; } ;;
                esac
            fi
            TRAPDEBUG() { _repo_node_previous_debug "$@" || return $?; _repo_node_hook; return 0; }
        fi
    elif [ -n "${BASH_VERSION:-}" ]; then
        # Bash can restore a caller's DEBUG trap when a sourced file returns.
        # Directory builtins give the same `cd repo && command` guarantee without changing that trap.
        for _repo_node_builtin in cd pushd popd; do
            _repo_node_declaration=$(declare -f "$_repo_node_builtin") || _repo_node_declaration=''
            _repo_node_command="builtin $_repo_node_builtin"
            case "$_repo_node_declaration" in
                *'_repo_node_wrapper_v2'*) continue ;;
                *'_repo_node_refresh'*)
                    # Upgrade exported pre-errexit wrappers without saving one as its own predecessor.
                    if declare -F "_repo_node_previous_$_repo_node_builtin" >/dev/null; then
                        _repo_node_command="_repo_node_previous_$_repo_node_builtin"
                    fi ;;
                ?*)
                    eval "_repo_node_previous_${_repo_node_declaration}"
                    export -f "_repo_node_previous_$_repo_node_builtin"
                    _repo_node_command="_repo_node_previous_$_repo_node_builtin" ;;
            esac
            eval "$_repo_node_builtin() { $_repo_node_command \"\$@\"; local rc=\$?; : _repo_node_wrapper_v2; if [ \"\$rc\" = 0 ]; then _repo_node_refresh || :; fi; return \"\$rc\"; }"
        done
    fi
fi
_repo_node_hook
