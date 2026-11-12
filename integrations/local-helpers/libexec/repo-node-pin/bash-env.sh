# Preserve a pre-existing BASH_ENV without sourcing this file recursively.
if [ -n "${ROBOB_REPO_PREVIOUS_BASH_ENV:-}" ] && [ "$ROBOB_REPO_PREVIOUS_BASH_ENV" != "${BASH_ENV:-}" ]; then
    . "$ROBOB_REPO_PREVIOUS_BASH_ENV"
fi
. "${ROBOB_REPO_NODE_HELPER:-$HOME/.local/libexec/repo-node-pin}/init.sh"
