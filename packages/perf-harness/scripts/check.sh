#!/usr/bin/env bash
set -euo pipefail
pnpm install --frozen-lockfile
mkdir -p tmp/perf/results
if [ ! -d tmp/perf/base/apps ]; then mkdir -p tmp/perf/base; tar -xf tmp/perf/base.tar -C tmp/perf/base; fi
if [ -L tmp/perf/base/node_modules ]; then rm tmp/perf/base/node_modules; fi
(
 cd tmp/perf/base
 pnpm install --frozen-lockfile
 pnpm exec tsc --noEmit -p apps/server > ../results/base-typecheck.log 2>&1
 cd apps/server
 pnpm exec vp test run src/orchestration-v2/ProviderSessionManager.test.ts src/orchestration-v2/Adapters/CodexAdapterV2.test.ts > ../../../results/base-idle-tests.log 2>&1
 pnpm exec vp pack > ../../../results/base-build.log 2>&1
)
node --test packages/perf-harness/src/metrics.test.ts packages/perf-harness/src/queryPlan.test.ts
pnpm exec tsc --noEmit -p packages/perf-harness > tmp/perf/results/harness-typecheck.log 2>&1
(cd apps/server; pnpm exec vp test run src/ardud/perf/queryPlan.test.ts src/observability/RpcInstrumentation.test.ts src/ardud/http/ReplyBuilders.test.ts src/ardud/kanban/engine/boardLocks.test.ts) > tmp/perf/results/gates.log 2>&1
(cd packages/client-runtime; pnpm exec vp test run src/ardud/actionTelemetry.test.ts src/rpc/client.test.ts) > tmp/perf/results/client-tests.log 2>&1
(cd apps/server; pnpm exec vp pack)
node packages/perf-harness/src/fixture.ts /tmp/robob-perf-check correctness
node packages/perf-harness/src/driver.ts /tmp/robob-perf-check candidate-working-tree tmp/perf/results/candidate-smoke.jsonl 1
