# Main-thread overload harness

The line is in PASS-LINE.md. The original thresholds were pushed at 6cbce53a before any run; evaluator clarification is at 358ad2969b. The harness has no authority to relax it.

`shape.json` contains only aggregate numeric statistics from the authorized isolated backup. Its syntheticLoad section names the 17-board trace count and large-board live overrides separately. `targets.json` records the .9 profile minute, caller mix and independently timed cumulative cache rates. Never copy private database rows or trace payloads into this folder or offbox.

Run from the repository root on offbox, after `pnpm install --frozen-lockfile`:

```
node scripts/overload-harness/run.mjs --revision=<product-sha> --out=tmp/overload/<label>
```

The default is 120 seconds warm-up and 600 seconds steady state. `--warmup=0 --seconds=30` is a smoke run and can never pass the release gate. A fresh temporary home holds synthetic statev2 and boards databases; no ambient T3 home is used. The loader adds one read-only observer of the dispatcher's existing private queue in memory. It changes no product source file; its hash is recorded in the result and must match across comparisons. All other measurements observe existing spans, persistence and cache counters.

The runner uses real migrations, reader pools, KanbanStore, KanbanService, its dispatcher and normal 30-second tick schedule, EventSink and RestartPacingState.status. Synthetic thread transport supplies provider reads/launches without starting external providers. Every offered input has its own counter; the driver schedules independently of completion. GC, ELU, delay histogram, stalls, logical completions, physical costs and queue samples cover only the steady window. A middle 60-second inspector profile is written for full runs.

The status workload uses the real cutover ledger, status service and response formatter, with synthetic refs sized for the measured reply. HTTP authentication/transport is outside this composition. The synthetic rootStart lane currently writes through EventSink; it does not run the full provider-start service. Those limitations are carried in result.json. PROVENANCE.md lists every measured field and remaining approximation, including the single-model pool mapping and unmeasured wait-kind census. Calibration determines whether the workload is faithful; an incomplete harness or failed calibration must not be presented as a product verdict.

After pulling each run back, add its exact offbox run id, log path and frozen SOURCE.json manifest to result.json. Include a workloadHash covering the runner, loader, math, shape generator and numeric inputs; report-only edits do not change the offered workload. Keep the CPU profile beside it. Produce the report with one schema2 calibration and three candidate inputs (evaluator measurement clarification) (R and individual fixes are additional rows):

```
node scripts/overload-harness/report.mjs <output-folder> base=<schema2-base/result.json> R=<R/result.json> candidate=<c1/result.json> candidate=<c2/result.json> candidate=<c3/result.json>
```

A run with missing required telemetry, mixed settings or an incomplete profile is INVALID. Complete evidence that misses a performance line is FAIL. The three earlier schema1 runs are information only and are never compared with schema2. It separates physical cost reductions from logical work equivalence. Run each revision on the same box allocation, Node version, runtime flags, seed, rates and observer. Do not compare simultaneous benchmark processes on one box. A 260-board sensitivity run (`--boards=260`) is labelled sensitivity and never gates the release.

The evaluator froze load and seed at tree8976cd88. Three schema1 .9 runs finish unchanged, followed by one schema2 .9 calibration with byte-identical shape.json and targets.json. Post its fidelity result and stop before an overload candidate, pending evaluator direction. Schema2 fixes GC timestamp clipping, initializes zero counters and closes the sampled stall gap. `bash scripts/overload-harness/check.sh` performs focused checks only; `--diagnostic` explicitly requests a180s diagnostic and is subject to that stop rule.

The independent #1365 scenario follows with `node apps/server/scripts/overload-latency.mjs --revision=<full-sha> --out=tmp/latency/<role>`. Its own synthetic history seed uses latency-shape.json, real HTTP control/MCP routes and auth services, actual PK reads, and a harness-owned WebSocket adapter to the real archive snapshot path. Deferred barriers hold the background reader and writer;100 request rounds use3s cancellation deadlines, with timeouts recorded as censored lower bounds. Run on .9 and the #1365 per-fix revision with identical driver/seed. It is not a full overload candidate. Attach run/source provenance and call `node scripts/overload-harness/latency-report.mjs <output> <base.json> <fix.json>`; see PASS-LINE.md for thresholds and the older-revision diagnostic exception.
