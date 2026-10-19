#!/bin/zsh
unset BUN_INSPECT
exec /usr/bin/python3 "${0:A:h}/triage.py"
