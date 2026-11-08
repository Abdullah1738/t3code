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

Driver measurements cover loopback responses and simulated 10 Mbps/100 ms
body delivery; native paint and device latency remain unmeasured. Post response includes delivery on the old server;
it is not a durable-ACK measurement. Concurrent activity uses HTTP board writes and WS metadata commands through the
real event sink. Provider token streaming and true cursor resume are not implemented. The compact fixture has
no real provider credentials and no schedulable work. TB/USB storage performance
requires a separate, capacity-checked storage workload. No cloud result certifies
USB SSD latency.

To measure an older build, pass its server entry as the fifth baseline argument:
`node packages/perf-harness/src/baseline.ts 1x BASE_SHA tmp/perf PATH_TO_BASE_DIST/bin.mjs`.
Use the same fixture directory for each revision. Never label a candidate artifact
with the base SHA. Resume checks the fixture and server artifact hash.

Round 2 measurement support:

- A connection handshake precedes sustained HTTP/RPC activity. Each repeat runs
  ten seconds of activity before measuring foreground requests. `harnessHash`
  separates this workload from the earlier short burst; do not compare them as
  a server improvement. Runtime, hardware and fixture identities must also match.
- `ROBOB_PERF_LEGACY_BURST=1` reproduces the original pre-handshake HTTP burst
  for attribution. It is a separate workload, including failed attempts.
- Sampler IPC flushes CPU profiles before shutdown, including failed actions.
  `profile.ts ARTIFACT_DIRECTORY OUTPUT.json` resolves server source maps and
  ranks samples once each. `elapsedSharePct` includes idle and profiler work;
  it is not an active-CPU percentage. Native synchronous SQL timing captures
  counts, total/max wall time and individual stalls >=50 ms on the main thread.
- The 10 Mbps / 100 ms RTT driver simulation paces real response-body delivery.
  `mobile.shapedColdFirstPage` and `mobile.shapedFullRefreshResume` are HTTP
  response measurements. The latter deliberately refetches the first page;
  native cache/cursor resume and device paints remain unmeasured gates.
- Web board/discussion paint opportunities carry the originating RPC ID.
  Client-runtime exposes `paintActionValue` with a host-supplied frame scheduler
  for mobile. Pending-message paint is still absent because no optimistic
  message row is rendered. Duplicate action/phase paints are ignored.
- SQL spans carry `db.commit.at_ms` after SQLite returns from outer COMMIT or
  autocommit DML. Several commits can belong to one action. This boundary does
  not certify an atomic command receipt or FULL power-loss durability; durable
  ACK remains unmeasured. Telemetry failures cannot change the SQL result.
- Pinned node:sqlite exposes neither sqlite3_stmt_status nor scan-status
  counters. `db.stmt_status.available=false` and `rowsVisited=null` preserve
  this gap. Rows returned are recorded separately and never stand in for visits.
