#!/usr/bin/env bash
set -euo pipefail
mkdir -p tmp/perf/r2-evidence
if [ "$(node -v)" != v24.22.2 ]; then
  mkdir -p /tmp/perf-node
  curl -fsSL https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.xz -o /tmp/perf-node/node.tar.xz
  curl -fsSL https://nodejs.org/dist/v24.22.2/SHASUMS256.txt -o /tmp/perf-node/sums
  (cd /tmp/perf-node; grep ' node-v24.22.2-linux-x64.tar.xz$' sums | sed 's/node-v24.22.2-linux-x64.tar.xz/node.tar.xz/' | sha256sum -c -)
  tar xf /tmp/perf-node/node.tar.xz -C /tmp/perf-node
  export PATH="/tmp/perf-node/node-v24.22.2-linux-x64/bin:$PATH"
fi
pnpm install --frozen-lockfile > tmp/perf/r2-evidence/install.log 2>&1
node --test packages/perf-harness/src/*.test.ts > tmp/perf/r2-evidence/tests.log 2>&1
for package in packages/perf-harness packages/shared packages/client-runtime apps/server apps/web; do
  pnpm exec tsc --noEmit -p "$package" > "tmp/perf/r2-evidence/${package##*/}-typecheck.log" 2>&1
done
(cd packages/shared; pnpm exec vp test run src/nodeSqliteClient.test.ts) > tmp/perf/r2-evidence/sqlite-tests.log 2>&1
(cd packages/client-runtime; pnpm exec vp test run src/ardud/actionTelemetry.test.ts src/ardud/kanban/client.test.ts src/ardud/kanban/threads.test.ts src/rpc/client.test.ts) > tmp/perf/r2-evidence/client-tests.log 2>&1
mkdir -p tmp/perf/r2-steady
if [ ! -f tmp/perf/base/apps/server/dist/bin.mjs ]; then
  mkdir -p tmp/perf/base
  tar xf tmp/perf/base.tar -C tmp/perf/base
  (cd tmp/perf/base; pnpm install --frozen-lockfile; cd apps/server; pnpm exec vp pack) > tmp/perf/r2-evidence/base-build.log 2>&1
fi
for scale in 1x 5x; do
  fixture="tmp/perf/final/fixtures/$scale-42"
  if [ "$scale" = 1x ]; then fixture="tmp/perf/r2/fixtures/1x-42"; fi
  node packages/perf-harness/src/baseline.ts "$scale" d069f2795d tmp/perf/r2-steady tmp/perf/base/apps/server/dist/bin.mjs "$fixture" > "tmp/perf/r2-evidence/$scale.log" 2>&1 || result=$?
  find tmp/perf/r2-steady -maxdepth 1 -type f -exec cp {} tmp/perf/r2-evidence/ \;
  node packages/perf-harness/src/profile.ts "tmp/perf/r2-steady/d069f2795d-$scale.jsonl.artifacts" "tmp/perf/r2-evidence/$scale-profiles.json"
done
exit "${result:-0}"
