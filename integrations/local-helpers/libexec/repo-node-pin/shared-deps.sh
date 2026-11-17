# Shared stores are read-only: pnpm exec/run can install before running a command.
repo_shared_deps_check() (
    tool=$1
    manager=$tool
    shift
    if [ "$#" = 1 ]; then
        case "$1" in --version|-v|--help|-h) return 0 ;; esac
    fi
    # Pnpm's global and run options can precede the command/script boundary.
    takes_value() {
        option=$1
        case "$option" in --config.*) option=--${option#--config.} ;; esac
        case "$2" in true|false) return 0 ;; esac
        case "$option" in
            --color) case "$2" in always|auto|never|true|false) return 0 ;; esac ;;
            --link-workspace-packages) [ "$2" != deep ] || return 0 ;;
            --scripts-prepend-node-path) case "$2" in auto|warn-only|true|false) return 0 ;; esac ;;
            -F|--filter|--filter-prod|--reporter|--loglevel|--test-pattern|--changed-files-ignore-pattern|--workspace-packages|--pm-on-fail|--workspace-concurrency|--resume-from|--npm-path|--node-package-map-type|--cache-dir|--child-concurrency|--cpu|--fetch-retries|--fetch-retry-factor|--fetch-retry-maxtimeout|--fetch-retry-mintimeout|--fetch-timeout|--global-dir|--global-pnpmfile|--hoist-pattern|--hoisting-limits|--https-proxy|--libc|--lockfile-dir|--merge-git-branch-lockfiles-branch-pattern|--modules-dir|--network-concurrency|--node-linker|--noproxy|--npmrc-auth-file|--only|--os|--package-import-method|--pnpmfile|--pnpr-server|--proxy|--public-hoist-pattern|--registry|--state-dir|--store-dir|--trust-policy|--trust-policy-exclude|--trust-policy-ignore-after|--virtual-store-dir) return 0 ;;
        esac
        return 1
    }
    command_name=''
    target=$PWD
    while [ "$#" -gt 0 ]; do
        case "$1" in
            -C|--dir|--prefix)
                [ "$#" -gt 1 ] || return 0
                target=$2
                shift ;;
            -C=*|--dir=*|--prefix=*) target=${1#*=} ;;
            -C?*) target=${1#-C} ;;
            --) shift; command_name=${1:-}; break ;;
            -*) if [ "$#" -gt 1 ] && takes_value "$1" "$2"; then shift; fi ;;
            pm) manager=pnpm ;;
            recursive|multi|m) ;;
            with) [ "${2:-}" != current ] || shift ;;
            *) command_name=$1; break ;;
        esac
        shift
    done
    case "$command_name" in
        help) return 0 ;;
    esac
    if [ "$manager" = vp ]; then
        case "$command_name" in
            i|install|add|ci|clean-install|ic|install-clean|install-test|it|update|up|upgrade|remove|rm|uninstall|un|uni|link|ln|unlink|dislink|prune|dedupe|rebuild|rb|fetch|patch|patch-commit|patch-remove|import|deploy) ;;
            *) return 0 ;;
        esac
    fi
    # exec/test escape the remaining arguments; run escapes after its script name.
    script_name=0
    if [ "$manager" = pnpm ]; then
        case "$command_name" in
            run|run-script) shift; script_name=1 ;;
            i|install|add|ci|clean-install|ic|install-clean|install-test|it|update|up|upgrade|remove|rm|uninstall|un|uni|link|ln|unlink|dislink|prune|dedupe|rebuild|rb|fetch|patch|patch-commit|patch-remove|import|deploy) ;;
            *) set -- ;;
        esac
    fi
    # Install commands also accept directory options after package names.
    while [ "$#" -gt 0 ]; do
        case "$1" in
            -C|--dir|--prefix)
                [ "$#" -gt 1 ] || break
                target=$2
                shift ;;
            -C=*|--dir=*|--prefix=*) target=${1#*=} ;;
            -C?*) target=${1#-C} ;;
            --) break ;;
            -*) if [ "$#" -gt 1 ] && takes_value "$1" "$2"; then shift; fi ;;
            *) [ "$script_name" = 0 ] || break ;;
        esac
        shift
    done
    for start in "$PWD" "$target"; do
        dir=$(CDPATH= cd -- "$start" 2>/dev/null && pwd -P) || continue
        while :; do
            for suffix in node_modules node_modules/.pnpm node_modules/.bin; do
                if [ -L "$dir/$suffix" ]; then
                    printf '%s\n' "$tool: refusing to write through shared dependencies: $dir/$suffix is a symlink." \
                        'Use offbox run -- pnpm install --frozen-lockfile, or replace the symlink with this worktree’s own install.' >&2
                    return 1
                fi
            done
            [ -e "$dir/.git" ] && break
            [ "$dir" = / ] && break
            dir=${dir%/*}
            [ -n "$dir" ] || dir=/
        done
    done
)
