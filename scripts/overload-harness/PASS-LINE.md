# Overload release gate

Set on 13 November 2026 for card #1352, before any harness calibration or candidate run. Only an evaluator comment on #1352 may change these thresholds. A harness that misses calibration must be fixed; the line stays fixed.

Calibration base: **dbc99fc3a4** (live .9). Second baseline R: **5b42a6cc98** (.10 boot fix).

## Measurement window

Each run has a **2-minute warm-up**, followed by **10 minutes steady state**. Record main-thread busy using `performance.eventLoopUtilization`, event-loop delay p50/p99/max using `monitorEventLoopDelay`, every stall **≥ 1 second**, and GC duration with a `PerformanceObserver` for `gc`. Capture a **60-second CPU profile in the middle** and report shares of busy time in the same form as FINDINGS-build7.

Record completed tick steps/s, writer transactions/min, events persisted, and card rows read/s. Record offered drive rates separately from completed work. Keep the synthetic seed, drive rates, runtime flags, instrumentation, hardware allocation and Node version the same between compared runs. Record commit SHAs, seed/targets hashes, offbox run ids and log paths.

## Calibration: all three base runs

- Main-thread busy **≥ 55%**.
- GC **≥ 20% of main-thread busy time**.
- Work rates within **±25% of targets.json**.

If calibration fails, the harness is not faithful and cannot issue a candidate PASS.

## Candidate: all three runs must pass

- Main-thread busy **≤ 30%** over the steady window.
- Event-loop delay p99 **≤ 100 ms**.
- **No stall ≥ 1 second**.
- GC **≤ 10% of wall time**.
- Work done within **±10% of the base run**. Passing by doing less work is a FAIL.

Run the full candidate only once #1323, #1341, #1342 and #1343 have merged. Until then, measure each landed fix on the base and report its own share removed. Missing calibration, missing work counters, incomplete windows, changed seed/drive rates or fewer than three passing candidate runs cannot produce a PASS.

## Clarification 13 Nov ~17:50Z

Sanctioned by the packet's Robob evaluator (667f0c44), discussion disc-be4f9fc6-0031-4d7f-b2cf-351ddd71c389. The original thresholds above stand verbatim.

“Work done within ±10% of base” means logical work on the same seed and drive:

- Synthetic provider events and commands offered per minute, by kind.
- Orchestration events persisted, by type, and commands completed or receipts written.
- Board tick steps/s and dispatch decisions.
- Status, asks feed, board_get and read-open-cards poller requests served, each with the same logical result size (card/ask count) as base.

No backlog may build. Pending commands, outbox depth and dispatcher queue at the end of the window must each be ≤ base +10%, with no upward slope across the steady window.

Writer transactions/min, card rows read/s, discussion misses and cache hits are physical costs. Report their reductions per fix; falling costs never fail candidate equivalence. Base calibration still checks physical rates within ±25% of targets.json.

The exact-minute targets replace the packet's estimates: 10.9 tick steps/s, 795 writer transactions/min, 13,253 open-card rows/s and 621 discussion misses/s. Total card/discussion rates use differences between cumulative tickLocalWaits snapshots, separately labelled from per-operation counts.

Seed 17 boards (trace-measured board cache entries): the 4,290/3,900-card board, the 1,320-card board (packet live overrides), and 15 small boards sized from backup statistics. Do not seed 260 for the gate. If calibration falls short on dispatch or tick cost, run a 260-board sensitivity variant; it does not gate the verdict.

## Data provenance

`shape.json` separates measured aggregate statistics from the isolated 10:36 backup from the live-cardinality requirements supplied by the card. No backup rows or private text may be sent offbox. `targets.json` is derived from the .9 trace's exact 17:13:36–17:14:36Z profile minute, with a separately labelled cumulative-counter interval for row/decode throughput. Earlier approximate rates are labelled as estimates, not substituted for that minute.

## Addition 13 Nov ~19:26Z — #1365 request-latency scenario

Sanctioned by the release evaluator in #1352's discussion. This scenario runs after the three frozen .9 overload calibrations, on its own synthetic seed, and does not change the overload inputs or thresholds above. Include #1365 (merged as13368af733) in per-fix measurements and the re-pin candidate.

Use an isolated seeded WAL database shaped only from backup aggregates, warm readers, a concurrent writer and one long background read. Trigger an unpaged archive snapshot from a foreground WS request. Use Deferred entry/release barriers, no sleeps. The synthetic database must run the real startup index path, including ardud_control_thread_candidates_idx on revisions that add it.

Calibration on dbc99fc3a4 must show p99 **>2 seconds** for each affected stream: GET /api/ardud/control/threads?limit=1 and ProjectionStore.isNodeStored's primary-key lookup, while the long reader and writer remain held. A stream that misses this line has a fidelity gap and cannot credit the fix.

Actual MCP credential resolution has two guard streams: an issued provider token and the OAuth/client session-token path. Each must have p99 **≤500 ms** and **no sample >2 seconds** on both base and candidate. Credential resolution was fast live; it is not expected to exceed2 seconds on base. Report whole-request MCP time including middleware/tool execution separately; it does not gate this scenario.

Candidate: **every stream** must have p99 **≤500 ms** and **no sample >2 seconds**, while the long reader is still active. Record acquire_wait_ms, hold_ms, statement.execution_ms and writer lock wait. Report missing execution telemetry on older revisions explicitly, without treating inclusive statement time as execution.

## Measurement clarification 13 Nov ~19:35Z

The evaluator froze load and seed, and authorized schema2 measurement/report corrections. The three schema1 .9 runs are information only because of GC boundary and stall-sampling limitations. Run **one schema2 .9 calibration** with seed and drive inputs byte-identical to frozen tree8976cd88; this is the calibration that counts. Never compare schema1 with schema2. Post its fidelity gaps, then stop: no candidate run pending the evaluator’s decision. Missing required telemetry, mixed settings or an incomplete profile makes a run **INVALID**, never PASS or FAIL. The #1365 latency scenario follows the calibrations on its own seed regardless of the overload verdict.

### #1365 telemetry compatibility clarification

Reader acquire_wait_ms (db.reader.acquire_wait_ms) and statement.execution_ms (db.statement.execution_ms) first appear in13368af733. On dbc99fc3a4, label them **not emitted by this revision**; this is an explicit older-revision exception, not missing data. Keep its real lock_wait_ms/hold_ms and never infer execution time from them. The gate uses client-side timings measured by the harness on both revisions; server-side diagnostics do not replace them. Required emitted diagnostics missing from .9 (lock_wait_ms/hold_ms) or the per-fix revision (all four fields), or missing client timings on either, make the run INVALID. No backports into base.
