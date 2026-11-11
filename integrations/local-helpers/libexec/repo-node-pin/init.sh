# Sourced by zsh and bash. Never replaces the safe-chain pnpm function.
_repo_node_refresh() {
    local _repo_node_status=$?
    [ "${_repo_node_busy:-}" = 1 ] && return "$_repo_node_status"
    [ "${_repo_node_seen_pwd:-}" = "$PWD" ] && [ "${_repo_node_seen_path:-}" = "$PATH" ] && return "$_repo_node_status"
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
            eval "$output"
            if [ -n "${_repo_node_warning:-}" ] && [ "$_repo_node_warning" != "${_repo_node_last_warning:-}" ]; then
                printf '%s\n' "repo-node: $_repo_node_warning" >&2
            fi
            _repo_node_last_warning=${_repo_node_warning:-}
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
    return "$_repo_node_status"
}

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
        eval 'chpwd_functions+=(_repo_node_refresh); preexec_functions+=(_repo_node_refresh); precmd_functions+=(_repo_node_refresh)'
        if [ ! -o interactive ]; then
            # Claude restores its snapshot PATH after .zshenv. Refresh before its next command.
            if typeset -f TRAPDEBUG >/dev/null; then
                functions -c TRAPDEBUG _repo_node_previous_debug
            else
                _repo_node_zsh_traps=$(trap)
                case "$_repo_node_zsh_traps" in
                    *' DEBUG')
                        _repo_node_zsh_debug=${_repo_node_zsh_traps##*trap -- }
                        _repo_node_zsh_debug=${_repo_node_zsh_debug% DEBUG}
                        _repo_node_previous_debug() { eval "eval $_repo_node_zsh_debug"; } ;;
                    *) _repo_node_previous_debug() { :; } ;;
                esac
            fi
            TRAPDEBUG() { _repo_node_previous_debug "$@"; _repo_node_refresh; }
        fi
    elif [ -n "${BASH_VERSION:-}" ]; then
        # Bash can restore a caller's DEBUG trap when a sourced file returns.
        # Directory builtins give the same `cd repo && command` guarantee without changing that trap.
        for _repo_node_builtin in cd pushd popd; do
            _repo_node_declaration=$(declare -f "$_repo_node_builtin") || _repo_node_declaration=''
            case "$_repo_node_declaration" in *'_repo_node_refresh'*) continue ;; esac
            if [ -n "$_repo_node_declaration" ]; then
                eval "_repo_node_previous_${_repo_node_declaration}"
                # An exported directory function carries this wrapper into child Bash.
                export -f "_repo_node_previous_$_repo_node_builtin"
                eval "$_repo_node_builtin() { _repo_node_previous_$_repo_node_builtin \"\$@\"; local rc=\$?; [ \"\$rc\" != 0 ] || _repo_node_refresh; return \"\$rc\"; }"
            else
                eval "$_repo_node_builtin() { builtin $_repo_node_builtin \"\$@\"; local rc=\$?; [ \"\$rc\" != 0 ] || _repo_node_refresh; return \"\$rc\"; }"
            fi
        done
    fi
fi
_repo_node_refresh
