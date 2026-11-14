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

## R11′ rerun — evaluator q2

The evaluator pinned R11′ = 58a926792ae28235d33d14025f417eccbc842549 (origin/main at14 Nov ~02:50 Dubai), containing oldR11 and#1386 plus the reviewed app merges since then. Use exactly this SHA even if main moves. Run3 candidate overload runs in parallel against the same3 base runs (d5e7,33c5,4463), with the same frozen v1 workload, box size and settings. Score under the relative gate (.11) plus q1's review launch substitution. Record box IDs/co-load and report every metric/runID plus the base2/3 profile diff as “Relative gate (.11) rerun at58a926792a”. Thresholds and seed/drive stay unchanged.

## Matched A/B/C batches — evaluator amendment, 14 Nov ~04:00 Dubai

The R11′ rerun above is INVALID (each run recorded two warnings). It is information only. The evaluator's replacement design is three sequential batches, each containing A = dbc99fc3a4b817977bc23a57ea7c049da5d45190, B = 8fde0ece3a2abea3dfed2866b6648fda68f52934, and C = 58a926792ae28235d33d14025f417eccbc842549. Each arm runs on a separate xlarge box, with the same frozen v1 workload, settings and measurement wrapper. B is diagnostic: report C−B and B−A. Score C against its own batch's A under the relative line and q1 clarification. Every batch must pass.

The permitted measurement additions retain warning text, count/time native SQL by statement and caller (including separately timed reader-worker prepare/execute), and record interval ELU. They add no SQL, providers, effects, seed fields or driver inputs. Existing INVALID rules remain in force. Old base runs are information only for this design. The older-revision diagnostic-field exception still applies; harness-owned execution timers are separate from the product's diagnostic attributes.

Evaluator q3, verbatim:

Don't wait for a host-wide quiet window. No reservation mechanism exists, the host is rarely idle (46 overlapping commands last time), and we never pause or kill anyone else's jobs. Waiting for idle could stall the release indefinitely. I'm dropping the host-idle precondition from step 2. The matched design is what controls contention: the arms of a batch start at the same moment and share whatever load the host has.

To be exact, the design is the latest one (seq 46): **3 sequential batches, each a triple** of A = dbc99fc3a4, B = 8fde0ece3a and C = 58a926792a, started together on 3 separate xlarge boxes. It is not 6 runs at once.

What you do instead:
1. Land the measurement changes first (warning text, per-statement counts/timings/callers, interval ELU), and test them offbox.
2. Before each batch, read offbox host load (running jobs and boxes). Launch when it's at or below the median of the last hour, or after a 20-minute wait at most, whichever comes first. Don't wait longer.
3. Record host-wide co-load over each batch's steady window: overlapping job ids, their sizes and kinds, especially disk-heavy ones like 304e.
4. Validity per batch: the batch is valid when all 3 arms start within 60 s of each other and their steady windows overlap by ≥90%. Co-load doesn't invalidate a batch on its own, since it hits all arms; report it. Use interval ELU to show whether the C−A gap holds minute by minute or only in stall minutes.
5. Score C against A within each batch, as before. Every batch must pass. B is diagnostic.

I'm also asking the offbox board for a benchmark-reservation feature so future release gates can get a quiet window. Don't wait for it.

## Explicit tmpfs and idle host — evaluator amendment, 14 Nov 01:42Z

The following decision supersedes the storage reference and host-load precondition in the matched-batch/q3 amendments above. Batches1/2 and all old runs are information only. Count the first three valid batches among at most six new attempts (numbered3–8); a valid numerical FAIL is retained, not replaced by a later attempt. The six frozen workload files and offered inputs stay unchanged. Database placement is explicit tmpfs; the measurement wrapper records both actual database files immediately before the steady ELU window and immediately after it. Filesystem probes execute outside the measured window. Other required telemetry and INVALID rules remain unchanged.

Evaluator decision, verbatim:

**Base runs:** we don't need to prove what d5e7/33c5/4463 used. Every matched batch carries its own A arm, and the verdict is C against A inside each batch. Those three runs and the old R11' runs are information only from now on. The calibration to live was about workload shape (cards, tx/min, tick rate), and that doesn't depend on the filesystem. Note in the report that the absolute busy level isn't proven to be the same as at calibration.

**Storage for every counted batch: tmpfs, set explicitly, in all three arms.**
- Point each arm's statev2 and boards data directory at a tmpfs mount. Don't rely on whatever /tmp happens to be. This also makes bx_61vytpaz usable.
- At steady start and again at the end, record the filesystem identity of each **actual** database file (fs type plus device/mount) in the run artifacts.
- If any arm isn't on tmpfs at either check, the batch is INVALID.
- Why tmpfs: most boxes already use it, it gives every arm the same storage, and there's only one ZFS box, so three ZFS arms would mean co-loading it. Real-disk fidelity is still the separate question for after the verdict.

**Verdict rule, set now:** three new matched batches (3, 4, 5) that pass the storage check, have no Warn-level stalls, and get host-wide idle before launch. Score C against A per batch under the relative gate (.11) plus q1. Every batch must pass. If a batch is INVALID, run another one; stop and report if you reach six attempts without three valid batches. B stays diagnostic.

**One thing to report:** busy for the whole batch dropped from about 23% in batch 1 to about 14% in batch 2. That's a 9 pp swing between batches on the same code. Put each batch's spread beside the gate's margin. If the swing between batches is as big as the gate's margin, say so, because the paired comparison is then carrying the whole verdict.

No need to wait for my reply after the information-only reports. Start batch 3 under these rules once host-wide idle is confirmed.

## Bounded idle wait — evaluator amendment, 14 Nov01:51Z

This supersedes only the unlimited idle wait above. The evaluator's45-minute clock began14 Nov01:51:13Z (fallback eligible02:36:13Z). Keep the same three arms, explicit tmpfs checks, Warn/INVALID rule and first-three-valid-in-six-attempts rule. Each batch is labelled idle or quiet-enough and records full host-wide co-load. No workload inputs change.

Evaluator decision, verbatim:

1. **Wait up to 45 minutes from now for full host-wide idle.** If you get it, launch.
2. **If it doesn't come, launch on "quiet enough" instead:** no other benchmark, SQLite-heavy, disk-wait or profiling job anywhere on the host, and no xlarge job besides ours. Ordinary light jobs are acceptable. Record the full host-wide co-load across the steady window, as before.
3. **A quiet-enough batch counts on the same terms as one launched on full idle:** storage check passes and no Warn-level stalls. The matched design is there to absorb load the arms share. It doesn't need an empty host.
4. **Never pause, kill or move anyone else's jobs**, and don't open a new box to get around the wait.
5. **In the report, mark each counted batch "idle" or "quiet-enough"** and give its co-load. If quiet-enough batches show clearly wider spread within the batch than idle ones, say so.

The rest stands: three counted batches, C against A per batch, stop at six attempts. Batches 1 and 2 show a 9–10 pp swing between batches against C−A margins of −0.12 and −1.02 pp, which is why the verdict is paired. Put that in the report as written.

## Loaded tier, CPU pressure and retained suites — evaluator decisions, 14 Nov

These decisions were received before counted batch3 or any counted candidate process. They supersede only the launch/placement/run-identity provisions above; the workload, performance thresholds, q1 substitution and INVALID rules remain in force. Rotation advances by counted position: an INVALID attempt repeats its uncounted Latin-square row; a numerical FAIL is counted. No workload knob changes.

Evaluator launch/placement decision, verbatim:

**1. Wait for quiet-enough until 03:45Z.** Check about every 5 minutes. If quiet-enough arrives, launch and mark the batch "quiet-enough", same as before.

**2. After 03:45Z, launch "loaded".** Three conditions:
- None of our three arm boxes is running any other job at launch.
- The storage check passes at both boundaries.
- Full host-wide co-load is recorded across the steady window. List the other xlarge and opaque jobs by run id.

A loaded batch counts on the same terms (no Warn-level stalls), plus one extra check. Record CPU steal/contention for each arm's box over the steady window (cgroup `cpu.stat` throttling and guest steal, whichever the VM exposes). If A's box and C's box differ by more than 2 pp of CPU time, the batch is INVALID. That is box-level unfairness, and the pairing can't absorb it. If neither metric is available on a box, the batch is INVALID too. Don't infer it.

**3. Rotate box assignment across counted batches.** Over batches 3–5, each arm runs once on each of the three boxes (a Latin square). Write the assignment into the batch artifacts before each launch. This cancels whatever is left of the per-box effect we saw in batch 1. It's a placement rule only. Seed, drive, storage and thresholds stay frozen.

**4. Everything else stands:** C against A in each batch under the relative gate (.11) plus q1, every counted batch must pass, B is diagnostic, and you stop and report at six attempts. Label each batch idle, quiet-enough or loaded in the report. Put each batch's within-batch spread next to its tier, so we can see whether load widened it.

Land R8's fixes before batch 3, and launch on the reviewed tree. There's no need to wait for me after that. Go on the rule above.

Evaluator q4, verbatim:

Pressure is required (revision 0). A zero throttled_usec under cpu.max=unlimited can't show contention, because nothing can throttle. A zero steal in /proc/stat on Incus is the host's view, and on bare metal steal is always 0. Both counters read zero whatever happens, so they don't count as available for the gate.

Gate formula, loaded tier only, fixed before any results:
- For each arm, take the box container's own cgroup (the one holding the arm's server process). Read cpu.pressure `some total=` (µs) at steady start and steady end.
- pressure_pct = Δsome_total_us / steady_wall_us × 100, using that arm's own steady wall in µs, from the same exact clock as the busy measurement.
- INVALID if |pressure_pct(A) − pressure_pct(C)| > 2.0 pp.
- INVALID if cpu.pressure is missing or unreadable on A's or C's box at either boundary, or if the counter goes backwards. Don't infer it.

Diagnostic only, never the gate: record raw cpu.pressure `full`, throttled_usec / nr_throttled deltas, cpu.max, and /proc/stat steal, with /proc/stat labelled as a shared host view. One exception: if cpu.max is limited on any arm box (not `max`), throttled_usec Δ / steady_wall_us also gates at the same 2.0 pp.

B: record the same values; it doesn't gate. Idle and quiet-enough batches: record the same values; they don't gate. Put pressure_pct for every arm in each batch row of the report.

Evaluator's note, read this before you act:
Both arms run the same workload, so in-container self-contention largely cancels. A pressure gap between A and C means the boxes were treated unequally, which is what the 2 pp rule is there to catch.

Evaluator q5, verbatim:

Retain three suite leases (revision 0). Waiting for an explicit box selector could take days, and the release is gated on this card. Three retained jobs on existing pooled xlarge boxes don't open a new box, and don't pause, kill or move anyone else's jobs. The offbox server has no caps, and other runs simply queue. So this stays within the rules.

Conditions, all fixed before the first candidate:
1. **Run identity.** A counted run's key is (parent offbox run id, batch, arm, Node pid + process start time, steady-window start/end). Change the reporter to require nine distinct keys. It must also reject any repeated artifact, profile or steady window, so nothing counts twice. Record the real parent offbox id on every run. Never fabricate an id, and never rewrite pool metadata.
2. **A fresh start for every run.** Each run gets a new Node process and a new statev2/boards directory under /dev/shm/robob-overload-1352/<batch>-<arm>. Before each batch, delete the previous batch's directory and record that it is gone. Don't keep warm in-process state, caches or profiles between runs.
3. **Placement proof.** At launch and at steady end, record the box identity from inside each job (offbox box id, hostname, and the Incus container id if the job exposes it). Check it against the Latin square written before that batch. If a job turns out to be on a box other than the planned one, that batch is INVALID.
4. **Exclusivity.** Each lease holds its box, so the "nothing else on our arm boxes" condition is met by construction. Still record the box's other processes at launch as proof.
5. **Release promptly.** Release all three leases as soon as the third valid batch finishes, or when you stop at six attempts or on any abort. Don't hold them idle between batches longer than the pre-batch checks need. Record lease start and end times in the report.

Everything else stands: q4's pressure gate, storage checks at both boundaries, the tier labels, C against A in each batch, and the stop at six attempts.

Evaluator's note, read this before you act:
Box-held state between batches is limited to OS state, and each batch wipes its tmpfs directory. Mention this as a fidelity note in the report; it isn't a reason to invalidate.
