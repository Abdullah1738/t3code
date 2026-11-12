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
bash packages/perf-harness/scripts/verify-round2.sh
mkdir -p tmp/perf/r2-attribution
result=0
ROBOB_PERF_LEGACY_BURST=1 node packages/perf-harness/src/driver.ts tmp/perf/r2/fixtures/1x-42 d069f2795d tmp/perf/r2-attribution/burst.jsonl 3 tmp/perf/base/apps/server/dist/bin.mjs > tmp/perf/r2-attribution/driver.log 2>&1 || result=$?
node packages/perf-harness/src/profile.ts tmp/perf/r2-attribution/burst.jsonl.artifacts tmp/perf/r2-attribution/profiles.json
exit "$result"
