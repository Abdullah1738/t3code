#!/usr/bin/env bash
set -euo pipefail
mkdir -p tmp/perf/results
pnpm exec tsc --noEmit -p packages/perf-harness > tmp/perf/results/harness-typecheck.log 2>&1
(cd apps/server; pnpm exec vp test run src/ardud/perf/queryPlan.test.ts src/observability/RpcInstrumentation.test.ts src/ardud/http/ReplyBuilders.test.ts src/ardud/kanban/engine/boardLocks.test.ts) > tmp/perf/results/gates.log 2>&1
(cd packages/client-runtime; pnpm exec vp test run src/ardud/actionTelemetry.test.ts src/rpc/client.test.ts) > tmp/perf/results/client-tests.log 2>&1
(cd apps/server; pnpm exec vp pack)
node packages/perf-harness/src/fixture.ts /tmp/robob-perf-correctness-candidate correctness
node packages/perf-harness/src/driver.ts /tmp/robob-perf-correctness-candidate candidate-working-tree tmp/perf/results/candidate-smoke.jsonl 1 apps/server/dist/bin.mjs
