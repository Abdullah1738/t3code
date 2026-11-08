Synthetic performance measurements run offbox. Node/SQLite are pinned in runtime.json.
No fixture can import an existing home. A fixture is created from migrations and
synthetic records, hashed after closing SQLite, and copied afresh for each repeat.

From the checkout root:

```sh
offbox run --remote --no-fallback -- node --test packages/perf-harness/src/metrics.test.ts packages/perf-harness/src/queryPlan.test.ts
offbox run --remote --no-fallback -- node packages/perf-harness/src/fixture.ts /tmp/perf-fixture-1x 1x 42
offbox run --remote --no-fallback -- sh -c 'cd apps/server && pnpm exec vp pack'
offbox run --remote --no-fallback --pull tmp/perf/REVISION-1x.jsonl -- node packages/perf-harness/src/baseline.ts 1x REVISION tmp/perf
offbox run --remote --no-fallback --pull tmp/perf/REVISION-5x.jsonl -- node packages/perf-harness/src/baseline.ts 5x REVISION tmp/perf
offbox run --remote --no-fallback -- sh -c 'cd apps/server && pnpm exec vp test run src/ardud/perf/queryPlan.test.ts'
offbox run --remote --no-fallback -- node packages/perf-harness/src/compare.ts BASE.jsonl CANDIDATE.jsonl COMPARISON.json
```

Build the revision being measured before running its baseline. Run comparison
within one scale/load and fixed hardware/runtime. JSONL run records are append-only;
keep per-action results, trace evidence and fixture identities with the ledger.
A missing metric or correctness check prevents a passing verdict.

Current driver measurements are loopback response timings, not native paint or
10 Mbps/100 ms device latency. Post response includes delivery on the old server;
it is not a durable-ACK measurement. Concurrent activity uses HTTP board writes and WS metadata commands through the
real event sink. Provider token streaming and true cursor resume are not implemented. The compact fixture has
no real provider credentials and no schedulable work. TB/USB storage performance
requires a separate, capacity-checked storage workload. No cloud result certifies
USB SSD latency.

To measure an older build, pass its server entry as the fifth baseline argument:
`node packages/perf-harness/src/baseline.ts 1x BASE_SHA tmp/perf PATH_TO_BASE_DIST/bin.mjs`.
Use the same fixture directory for each revision. Never label a candidate artifact
with the base SHA. Resume checks the fixture and server artifact hash.
