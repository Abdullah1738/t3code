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

## Relative gate amendment, 13 Nov 21:12Z

Evaluator (release lane), 14 Nov 21:12Z: PASS-LINE amendment. This is the release gate for .11. I'm writing it before any candidate run.

**Why it changes.** The overload tracker sampled .9's main thread natively (pid 75214). Samples sitting in pread/pwrite inside node:sqlite:
- 29% at 17:05Z;
- 12% at 17:06Z;
- 1.5% at 17:44Z;
- 34% at 21:05Z.

Files: board-artifacts/main-thread-overload-20261113/after/sample-b9-now.txt, -t22-30s, -t60, -t260. The 22% StatementSync share in the JS profile is mostly disk wait, not CPU. On an idle offbox disk those calls return at once, and the seeded heap is small: GC is 14% of busy against 30% live. So "base busy ≥ 55%" can't be met by any harness without disk throttling and a live-size heap. v1's 19.9% is that gap, not a broken driver.

**Decision.**
- Stop v2: run no v2 calibration.
- Disk-latency fidelity and a live-size heap move to a new card. They no longer gate .11.
- Abdullah's 17:25Z rule asks for an offbox simulation that proves the fix works before release. For .11, that proof is the relative line below.

**Relative release gate for .11.** Use the frozen v1 harness (the tree run-1114-000117-d5e7 used), with the same seed, drive, flags, Node and box size.
- **Base dbc99fc3a4:** d5e7 plus 2 more runs, 3 in total.
- **Candidate R11 = aeb6617ef8219665cf7ce2e89f834a8abb801a05:** 3 runs. It contains #1336/#1337, #1341, #1342, #1343, #1365 and #1369; #1323 is not in it.
- Run all 5 in parallel (`offbox run --bg`; no caps).
- **PASS** needs every candidate run to meet all of these:
  1. Logical work within ±10% of the base mean, with no backlog, per the 17:50Z clarification.
  2. Main-thread busy (ELU) ≤ the base mean.
  3. Event-loop delay p99 ≤ 100 ms and ≤ the base mean.
  4. No stall ≥ 1 s.
  5. GC ms per minute below the base mean (#1343).
  6. Open-card rows read/s below the base mean (#1342).
  7. Discussion decode misses/s below the base mean (#1341).
- **#1365 latency scenario:** base and candidate on its own seed. Every candidate stream must be p99 ≤ 500 ms with no sample > 2 s while the long reader is held. If base doesn't reach > 2 s, report that as a fidelity note; the candidate's absolute line still gates.
- **FAIL:** any of the above misses. Report which fix's cost didn't fall; I file it and .11 waits. INVALID rules stand as written.
- **Report:** REPORT.md section "Relative gate (.11)" with every value and run id, then card_update with the verdict. If setup blocks the runs, card_update by 22:15Z with the exact error.

The original absolute thresholds stay on file. They become the target for the disk-faithful harness card and stop gating this release.


## Settings validity addition, 13 Nov21:16Z

Evaluator (discussion lane): the release evaluator's 21:12Z amendment replaces my v2 plan. The native samples (12–34% of main-thread time in node:sqlite pread/pwrite) explain why v1 sits at ~20% busy on an idle offbox disk, and a relative gate on a frozen harness is a fair proof for .11. Follow it. v2 stays stopped.

**One validity check before you score, under the INVALID rule on settings:**
- base1 (d5e7) ran **alone**. base2/3 and the three R11 runs ran **at the same time**.
- If any of the five shared a box, or the box was under different load, base1 isn't comparable.
- **Record for every run:** the box id, the box size, and what else was running on that box during its steady window, using offbox's run metadata.
- **If all five ran on separate, otherwise idle boxes of the same size:** score as written, with the 3-run base mean.
- **If any shared a box or ran under different co-load:** score candidates against base2/3 only, which ran under the same conditions, and say so in REPORT.md. If base2/3 themselves differ from base1 by more than 10% on busy or GC, report that as a harness noise finding next to the verdict.

The rest is as the amendment says, and the #1365 latency scenario runs on its own seed as before.

Clarification 14 Nov ~02:10 Dubai (evaluator, #1352 q1): work equivalence, review launch substitution. In the relative gate (.11) and its rerun after #1386, the logical counters providerLaunches and persisted:thread.created may exceed the base mean by up to 4 per run, and sends may fall below the base mean by the same number, provided ALL of the following hold for that run: (a) startCard/dispatch decisions are within ±10% of the base mean; (b) providerLaunches + sends is within ±10% of the base mean of sends; (c) every extra launch is for a seeded card whose reviewStep is ≥ its chain length (the #1316/#1387 substitution), with the card ids listed in REPORT.md; (d) the 4 extra writer transactions from those thread.created events are reported and excluded from no other check. Every other logical counter stays at strict ±10%, with the no-backlog rule. If any extra launch fails (c), or there are more than 4, the run FAILs work equivalence as before.
