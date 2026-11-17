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
bash packages/perf-harness/scripts/verify-round2.sh
mkdir -p tmp/perf/r2-attribution
result=0
ROBOB_PERF_LEGACY_BURST=1 node packages/perf-harness/src/driver.ts tmp/perf/r2/fixtures/1x-42 d069f2795d tmp/perf/r2-attribution/burst.jsonl 3 tmp/perf/base/apps/server/dist/bin.mjs > tmp/perf/r2-attribution/driver.log 2>&1 || result=$?
node packages/perf-harness/src/profile.ts tmp/perf/r2-attribution/burst.jsonl.artifacts tmp/perf/r2-attribution/profiles.json
exit "$result"
