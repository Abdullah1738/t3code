# Source from bash or zsh. This bridge never changes the caller's exit status.
mac_log() {
  "${MAC_LOG_PYTHON:-/usr/bin/python3}" "${MAC_LOG_HOME:-$HOME/.local/lib/mac-logging}/jobs.py" "$@" 2>/dev/null || :
}
