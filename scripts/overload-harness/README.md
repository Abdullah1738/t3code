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

After pulling each run back, add its exact offbox run id and log path to result.json. Keep the CPU profile beside it. Produce the report with three calibration and three candidate inputs (R and individual fixes are additional rows):

```
node scripts/overload-harness/report.mjs <output-folder> base=<base1/result.json> base=<base2/result.json> base=<base3/result.json> R=<R/result.json> candidate=<c1/result.json> candidate=<c2/result.json> candidate=<c3/result.json>
```

The report fails closed on missing provenance/profile/windows/calibration and records all failure reasons. It separates physical cost reductions from logical work equivalence. Run each revision on the same box allocation, Node version, runtime flags, seed, rates and observer. Do not compare simultaneous benchmark processes on one box. A 260-board sensitivity run (`--boards=260`) is labelled sensitivity and never gates the release.
