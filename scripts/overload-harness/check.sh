#!/usr/bin/env bash
set -uo pipefail
out=${OVERLOAD_CHECK_DIR:-tmp/overload-checks}
mkdir -p "$out"
files=(apps/server/scripts/overload-harness.ts apps/server/src/ardud/perf/overloadShape.ts apps/server/src/ardud/perf/overloadShape.test.ts apps/server/src/ardud/perf/overloadMath.ts apps/server/src/ardud/perf/overloadMath.test.ts scripts/overload-harness/run.mjs scripts/overload-harness/report.mjs scripts/overload-harness/profile.mjs scripts/overload-harness/report.test.mjs apps/server/scripts/overload-latency.mjs scripts/overload-harness/latency-report.mjs)
vp fmt "${files[@]}" >"$out/format.log" 2>&1
format_rc=$?
tar -cf "$out/formatted.tar" "${files[@]}"
vp test run apps/server/src/ardud/perf/overloadShape.test.ts apps/server/src/ardud/perf/overloadMath.test.ts scripts/overload-harness/report.test.mjs >"$out/tests.log" 2>&1
tests_rc=$?
tsc-rs --noEmit -p apps/server >"$out/types.log" 2>&1
types_rc=$?
vp lint "${files[@]}" >"$out/lint.log" 2>&1
lint_rc=$?
printf 'format=%s tests=%s types=%s lint=%s\n' "$format_rc" "$tests_rc" "$types_rc" "$lint_rc" | tee "$out/status.txt"
node apps/server/scripts/overload-latency.mjs --check-imports >"$out/latency-imports.log" 2>&1
imports_rc=$?
printf 'imports=%s\n' "$imports_rc" | tee -a "$out/status.txt"
if [[ ${1:-} == --diagnostic ]] && (( tests_rc == 0 && types_rc == 0 )); then
  node scripts/overload-harness/run.mjs --revision=smoke-uncommitted --warmup=120 --seconds=60 --out="$out/smoke" >"$out/smoke.log" 2>&1
  smoke_rc=$?
  printf 'smoke=%s\n' "$smoke_rc" | tee -a "$out/status.txt"
else
  smoke_rc=0
fi
if (( format_rc || tests_rc || types_rc || lint_rc || smoke_rc || imports_rc )); then exit 1; fi
