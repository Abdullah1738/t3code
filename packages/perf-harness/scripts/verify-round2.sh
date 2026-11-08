#!/usr/bin/env bash
set -euo pipefail
mkdir -p tmp/perf/r2-verify
pnpm install --frozen-lockfile > tmp/perf/r2-verify/install.log 2>&1
node --test packages/perf-harness/src/*.test.ts > tmp/perf/r2-verify/tests.log 2>&1
pnpm exec tsc --noEmit -p packages/perf-harness > tmp/perf/r2-verify/typecheck.log 2>&1
(cd packages/shared; pnpm exec vp test run src/nodeSqliteClient.test.ts) > tmp/perf/r2-verify/sqlite-tests.log 2>&1
(cd packages/client-runtime; pnpm exec vp test run src/ardud/actionTelemetry.test.ts src/ardud/kanban/client.test.ts src/ardud/kanban/threads.test.ts src/rpc/client.test.ts) > tmp/perf/r2-verify/client-tests.log 2>&1
