#!/usr/bin/env bash
set -euo pipefail
mkdir -p tmp/perf/r2-evidence
NODE_PIN="$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["node"])' "$(dirname "$0")/../runtime.json")"
if [ "$(node -v 2>/dev/null || true)" != "$NODE_PIN" ]; then
  NODE_DIRECTORY="$(mktemp -d)"
  trap 'rm -rf "$NODE_DIRECTORY"' EXIT
  NODE_ARCHIVE="node-${NODE_PIN}-linux-x64.tar.xz"
  curl -fsSL "https://nodejs.org/dist/${NODE_PIN}/${NODE_ARCHIVE}" -o "$NODE_DIRECTORY/$NODE_ARCHIVE"
  curl -fsSL "https://nodejs.org/dist/${NODE_PIN}/SHASUMS256.txt" -o "$NODE_DIRECTORY/sums"
  (cd "$NODE_DIRECTORY"; awk -v archive="$NODE_ARCHIVE" '$2 == archive' sums | sha256sum -c -)
  tar xf "$NODE_DIRECTORY/$NODE_ARCHIVE" -C "$NODE_DIRECTORY"
  export PATH="$NODE_DIRECTORY/node-${NODE_PIN}-linux-x64/bin:$PATH"
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
