#!/usr/bin/env bash
set -euo pipefail
# Run from the repository root on a Linux worker; never builds the desktop app.
pnpm install --ignore-scripts --frozen-lockfile
pnpm --filter @t3tools/protocol-models typecheck
pnpm --filter @t3tools/protocol-models simulate
pnpm --filter @t3tools/protocol-models conformance
pnpm --filter @t3tools/protocol-models verify
