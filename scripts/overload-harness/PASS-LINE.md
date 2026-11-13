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

## Work-equivalence definition pending evaluator clarification

The numerical line above is unchanged from the card. #1323 aims to reduce physical writer transactions and #1342 aims to reduce card rows read. Applying ±10% to those physical cost counters would reject their intended improvements. This conflict was raised in the #1352 discussion before implementing the driver or verdict. Until the evaluator defines which counters measure useful work versus cost removed, the harness must not issue a candidate PASS.

## Data provenance

`shape.json` separates measured aggregate statistics from the isolated 10:36 backup from the live-cardinality requirements supplied by the card. No backup rows or private text may be sent offbox. `targets.json` is derived from the .9 trace's exact 17:13:36–17:14:36Z profile minute, with a separately labelled cumulative-counter interval for row/decode throughput. Earlier approximate rates are labelled as estimates, not substituted for that minute.
