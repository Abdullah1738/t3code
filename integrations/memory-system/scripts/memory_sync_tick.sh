#!/bin/bash
# DEPRECATED 2026-10-02. This used to run raw sync and fact extraction in one
# lock (logs/tick.lock), so a hung extractor blocked capture for 2+ days.
# The stages are now separate launchd jobs:
#   com.abdullah.memory-sync    -> scripts/memory_capture_tick.sh
#   com.abdullah.memory-extract -> scripts/memory_extract_tick.sh
# The old combined script is in git history. This shim only runs
# the capture stage, in case something still calls it.
exec /bin/bash "$HOME/.local/share/memory-system/scripts/memory_capture_tick.sh" "$@"
