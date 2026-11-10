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

For acceptance, build both revisions, then run the common controller:

```sh
offbox run --remote --no-fallback --pull tmp/perf/paired -- node packages/perf-harness/src/paired.ts /tmp/perf-fixture-1x BASE_SHA /path/to/base/bin.mjs CANDIDATE_SHA /path/to/candidate/bin.mjs tmp/perf/paired 10
```

Use a fresh output directory for each experiment. The controller retains every
attempt and its host counters, retries only the permitted preparation/steal
failures, and writes accepted pair ledgers and the comparison. Sequential
`baseline.ts` runs remain useful for diagnostics; acceptance uses `paired.ts`.

Build the revision being measured before running its baseline. Run comparison
within one scale/load and fixed hardware/runtime. JSONL run records are append-only;
keep per-action results, trace evidence and fixture identities with the ledger.
A missing metric or correctness check prevents a passing verdict.

Driver measurements cover loopback responses and simulated 10 Mbps/100 ms
body delivery; native paint and device latency remain unmeasured. Post response includes delivery on the old server;
it is not a durable-ACK measurement. Concurrent activity uses HTTP board writes and WS metadata commands through the
real event sink. Owner writes use the existing local ACP mock with no provider credentials;
real provider token streaming and true cursor resume are not implemented. No work pool is added.
TB/USB storage performance
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

Acceptance statistics (`paired-bootstrap-v2`):

- Use at least ten matched interleaved A/B pairs on one worker, alternating
  AB/BA order. Each fresh, flushed fixture runs its configured writer workload
  (32 at 1x, 128 at 5x), unchanged between the two revisions.
  Foreground endpoints are each requested forty times per run. Keep raw request
  values, nearest-rank p50/p95/p99 and max; never use the largest repeat as p95.
- Compare the median of each primary per-run value (request p95 and scalar
  resource/event-loop metrics). Request p50 companions remain informational;
  request-tail acceptance also uses the pooled policy below. Resample whole matched pairs 10,000
  times (fixed seed 42) for a percentile 95% confidence interval of the ratio
  of medians, B/A. Fail when the ratio exceeds 1.10 and the interval excludes
  1.0. Event-loop p99 fails on any significant increase. Report max separately.
- Pool all request values for endpoint p95/p99. Bootstrap matched run clusters,
  preserving all requests in each selected run. Fail a pooled p99 increase over
  25% only when its interval excludes 1.0. Requests within a run are correlated;
  they are not independent bootstrap units. These are per-metric intervals,
  without multiplicity correction. Ten pairs cannot establish equivalence.
  Require forty samples per run for the seven foreground endpoint families;
  absent/short families are unmeasured. The one-shot mobile cold/resume requests
  remain diagnostics with unmeasured tails.
- WAL cost is cumulative frames and frame bytes (page size plus 24-byte frame
  header) per completed HTTP/WS operation during the sampling interval. Probe
  SQLite 3.51+ `wal_checkpoint(NOOP)` after statements/commits and inspect WAL
  header salts to distinguish reused generations. Include every attached schema,
  deduplicating by database file. Capture SQL duration before probing so probe
  time is not attributed to SQL. Sampling executes on the
  writer thread before it can acknowledge a checkpoint-worker truncation.
  Checkpoint policy remains intact. Probe overhead applies equally to A/B;
  this measures instrumented relative performance, not absolute native latency.
  `wal.bytes` remains allocated file size, informational only. Probe failures
  leave write cost unmeasured. Correctness/device gaps are never changed to pass.
- Record Linux CPU steal from `/proc/stat` and IO PSI total deltas between
  `perf-start` and `perf-stop`, excluding fixture preparation and shutdown.
  Exclude and redo the entire pair only for steal above 15% or failed fixture
  flush; retain every attempt, reason and command exit. IO pressure is reported,
  never used for post-hoc removal. Record absolute budgets as information under
  this relative gate; existing unmeasured fields keep the overall verdict incomplete.

Old metric keys remain in the ledger; foreground response keys contain each
run's p95, with explicit `.p50` and `.p95` keys and `requests`/`summaries` alongside.
Comparisons reject legacy ledgers and unpaired or fewer than ten runs.

Owner-write workload (`owner-writes-v3`):

- Each run makes forty `kanban.answer` WebSocket RPCs against distinct persisted
  open asks under the sustained HTTP and WS writers. Ten each target a worker, an evaluator, an existing evaluator
  after its worker has moved on, and a newly launched evaluator after the original
  asker was archived. Twenty submit freeform text on a choice block, and twenty
  pick an option. Each pick
  targets `q2` at message 22 and must leave the independent `q1` at message 21 open.
  HTTP preparation and closure checks are outside `answer.response.ms`.
- Each run also makes forty actual `kanban.message.post` WebSocket RPCs on a
  separate set of forty fresh discussions. Ten each target an asking worker,
  evaluator, stale-worker fallback and new evaluator launch. The returned and
  read-back message must match the owner, exact text and next sequence; the
  original ask must close separately. Reply markers are absent from seeded
  questions and card titles, so those cannot count as provider delivery.
- `messagePost.response.ms` contains only those forty WS post timings. The old
  `post.response.ms` remains the separate HTTP post workload. Neither HTTP post
  latency nor answer latency can fill the WS post distribution or coverage.
- `answer.response.ms` retains all forty response values, p50/p95/p99 and max.
  Gate v2 applies the existing per-run p95 and pooled p99 regression checks. At
  5x the candidate's pooled answer p95 must also be strictly below 500 ms. This
  target can fail even when the relative comparison passes.
- The separate WS post target also requires candidate pooled p95 strictly below
  500 ms at 5x. Its existing-style primary p95 and clustered pooled p99 regression
  gates use only `messagePost.response.ms`. Missing or repeated samples, missing
  persisted sequence evidence, or open asks prevent a passing WS post target.
- A disposable clone's `synthetic` provider uses `acpRegistry` with the existing
  `apps/server/scripts/acp-mock-agent.ts` local command. Its HOME, settings,
  project workspace and request log belong to that clone. No credentials or
  live provider are used. `ownerAnswerCoverage` reports ask consumption and mock
  delivery separately. Mock delivery requires all forty unique markers in ACP
  prompts, persisted messages on the intended recipient threads, and ten new
  discussion evaluator links. Missing evidence leaves coverage unmeasured;
  live provider delivery is always unmeasured. Core service tests remain the
  independent proof of launch semantics.
- `ownerMessagePostCoverage` reports persistence, ask closure and mock delivery
  independently. Post delivery requires forty unique reply markers in ACP prompts,
  forty expected-recipient messages and ten new evaluator links for the post
  discussions, separate from the answer evidence. Live delivery remains unmeasured.
- Raw per-sample open/closed evidence and provider requests live in each run's
  retained artifacts. Answer trace phases use the originating action IDs;
  `serial.queue`, `serial.key` and `serial.wait_ms` identify routing and evaluator
  admission waits when the server supplies them. Older builds leave these
  admission phases unmeasured.
- Both owner RPCs have a 60-second request timeout. The collection window allows
  90 minutes because forty posts taking the reported 10–43 seconds each cannot
  complete within the earlier two-minute read workload window. This is a failure
  bound for a slow baseline; the response budgets remain 500 ms. Both artifacts
  run with the same harness, fixture and bounds.

Reuse a complete, closed M1a or unconsumed `owner-answers-v2` synthetic fixture by copying and upgrading it; never
modify the pristine source. The helper copies only the synthetic databases,
adds the asks, repairs only the answer recipients' opaque history nodes, and
includes the updated main/boards hashes and workload version in the
new fixture identity:

```sh
node packages/perf-harness/src/ownerAnswerFixture.ts /home/user/m1a-r7-fixtures/1x /home/user/owner-writes-v3-fixtures/1x
node packages/perf-harness/src/ownerAnswerFixture.ts /home/user/m1a-r7-fixtures/5x /home/user/owner-writes-v3-fixtures/5x
```

For v2 sources, substitute the pristine v2 fixture directory. Its forty answer
cards remain byte-for-byte unchanged and forty post cards are added. Consumed,
unsupported or already-v3 fixtures are rejected by the upgrade command. Existing
v2 manifests and old ledgers cannot certify v3. Generate fresh v3 fixtures with
`fixture.ts NEW_DIRECTORY 1x|5x 42` when no reusable source is available.

Run the same harness checkout against the exact base artifact and the integrated
candidate, on one offbox worker. Replace the artifact paths and candidate SHA
with their verified values. Use separate fresh output directories:

```sh
node packages/perf-harness/src/paired.ts /home/user/owner-writes-v3-fixtures/1x 491bad873e8c933e9a0344b34e5e2ba299076d62 /path/to/491bad873e/bin.mjs CANDIDATE_SHA /path/to/candidate/bin.mjs tmp/owner-writes-v3/paired-1x 10
node packages/perf-harness/src/paired.ts /home/user/owner-writes-v3-fixtures/5x 491bad873e8c933e9a0344b34e5e2ba299076d62 /path/to/491bad873e/bin.mjs CANDIDATE_SHA /path/to/candidate/bin.mjs tmp/owner-writes-v3/paired-5x 10
```

These are remote commands: invoke them with `offbox run --remote` from that
checkout, or place them in an included script run through that command. Keep
both scales' ledgers, comparison.json and artifact directories. Ten accepted
interleaved pairs per scale are required. Native/device/correctness gaps can keep
the controller exit nonzero even when relative performance and both owner-write targets pass.

Shell memory gates (renderer OOM, 10 Nov 2026):

- `shellMemoryBrowserGate.ts` is the regression gate. It runs the built web app
  (`apps/web/dist`, the bundle the desktop renderer loads) in a headless Chrome against this
  tree's server on the `shell` fixture (20,000 rows shaped like the live desktop list: two
  pull request links each, 93% unsettled), with 30 writes/s, and samples the renderer heap
  over CDP. It fails on a renderer crash, a list that never completes, a heap peak over
  1 GB or over 512 MB kept after a forced GC, or a renderer that restarts the walk at page
  one after a crash mid-load.

  ```sh
  offbox run --remote --no-fallback -- node packages/perf-harness/src/fixture.ts tmp/fx-shell shell
  (cd apps/web && vp build)
  node packages/perf-harness/src/shellMemoryBrowserGate.ts tmp/fx-shell tmp/shell-memory.json
  ```

  `ROBOB_PERF_PROFILE_AT_PAGE=N` saves a sampling heap profile and a CPU profile once N
  pages have landed, for attribution against the bundle's source maps.

- `shellMemoryGate.ts` runs the client-runtime shell state and loader alone in Node
  (`node --expose-gc`), with an in-process fetch. It has no React, so it does not see what
  the sidebar draws; it guards the page merge and link fill.
