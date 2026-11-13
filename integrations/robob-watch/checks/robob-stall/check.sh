#!/bin/zsh -f
unset BUN_INSPECT
exec node "${0:A:h}/check.mjs"
