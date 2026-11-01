#!/bin/zsh
# Debounced checker shipped from the Robob fork (integrations/robob-watch/helpers/ride-share-check.py).
# Old inline checker kept as check.py for rollback.
export RIDE_SHARE_STATE="${0:A:h}/rides.json"
export WATCH_DIR="${0:A:h}"
exec /usr/bin/python3 "$HOME/.local/share/robob-watch/helpers/ride-share-check.py"
