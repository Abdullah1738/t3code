#!/bin/zsh -f
set -eu
exec /usr/bin/python3 "${0:A:h}/refresh.py" install "$@"
