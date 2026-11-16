#!/bin/sh
# venice-x402 guard. Kept as a thin wrapper: the logic lives in
# bin/venice-ensure, which does more than a kickstart —
#   1. bootstraps the LaunchAgent when the job is not loaded at all (the
#      14:07Z failure: launchd had no job, so KeepAlive and kickstart were
#      both no-ops and the proxy stayed down for 31 minutes);
#   2. kickstarts it when the job is loaded but nothing listens on the port;
#   3. exits silently when the port answers (a 401 counts: no bearer token).
# Created 15 Nov 2026 after four board cards failed with ConnectionRefused.
exec /Users/ardud/.local/share/venice-x402/bin/venice-ensure
