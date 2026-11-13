#!/bin/zsh
unset BUN_INSPECT
exec /opt/homebrew/bin/python3 -I -B "${0:A:h}/check.py"
