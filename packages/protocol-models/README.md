# Protocol contracts

These finite abstractions constrain M2–M4 changes. `restart.qnt` and the
`stepCurrent` relation in `commands.qnt` describe the code at `d069f2795d`.
Other relations describe the target architecture, not shipped guarantees.

Run from the repository root on a compute worker:

```sh
pnpm install --ignore-scripts --frozen-lockfile
pnpm --filter @t3tools/protocol-models typecheck
pnpm --filter @t3tools/protocol-models simulate
pnpm --filter @t3tools/protocol-models verify
pnpm --filter @t3tools/protocol-models conformance
```

`verify` needs Java 21 or newer and network access for Quint's first Apalache
download. Quint 0.33.1 pins Apalache 0.62.4; the runner selects that version
explicitly. fast-check 4.10.2 and tsx 4.23.15 are pinned in package.json.
Results, ITF counterexamples, seeds and shrink paths go to `traces/latest/`.
The checked regression artifacts are retained in `traces/regressions/`.
Set `MODEL_CASE=restart-nativePreparationContinues` to run just the explicit
`no_provider_thread` counterexample (or another `<spec>-<invariant>` case).
Expected counterexamples are successful checks only when the tool actually
reports an invariant violation, never when parsing or the backend fails.

## Bounds and interpretation

| Model | Bound | Checked property |
| --- | --- | --- |
| restart | one source run, one awaited native child, two crashes, one continuation command | I7 accounting after recovery and no duplicate durable dispatch |
| commands | two IDs, two crashes, three lease generations, one active claim | I1 ACK has durable outcome; I2 retry/receipt-expiry dedup; I4 durable delivery obligation |
| boards | two cards, two independent fields, three revisions/tokens, one pool slot | I3 field preservation and explicit conflicts; I6 capacity and fenced attachment |
| sync | two keys, four writes, two epochs, one principal/scope, two snapshot pages | I5 prefix equality/convergence/tombstones; I9 immediate authorization |
| stops | two deferred board stops, three runs, two crashes (board sends only) | a let-go interrupt never cuts a run started after it was asked for; `stepVolatile` is the expected counterexample (stop closed in memory only) |

The runner explores all executions through 10 transitions using Apalache and
samples 10,000 runs of 10 transitions with seed 20261108. Deterministic `run`
tests include longer witnesses, independent of that bound.

Safety checks need no fairness. Eventual progress assumes finitely many crashes,
healthy storage, eventual provider/transport availability, fair recovery and
worker service, and either a successful delivery or an explicit terminal failure.
`I4_obligation` checks preservation of the durable work obligation, **not an
unbounded liveness theorem**. `I4_fairSuffix` additionally checks that two healthy service opportunities
settle both possible commands after a failure-free drain begins. This bounded
service assumption is stronger than weak fairness. The delivery witness and conformance fair suffix
check termination after failures stop. Infinite crashes or a worker never being
scheduled cannot satisfy eventual delivery. Exactly-once external visibility
requires a durable downstream inbox or reconciliation; fencing local completion
alone cannot prevent a provider executing an ambiguous call twice.

I1's crash relation preserves committed state. This is a process-loss model;
power-loss equivalence requires FULL synchronization and correct filesystem /
drive flush semantics. These models do not prove SQLite or USB behavior. I8 is
outside this lane (no archive model).

## Source correspondence and counterexamples

- `restart.qnt`: `RestartContinuation.ts:restartContinuationDecision` checks for a
  saved provider thread before considering awaited work. `recover` abstracts
  `ProviderRuntimeRecoveryService`'s atomic reconciliation plus continuation
  outbox enqueue. `claim/execute/complete` abstract `EffectOutbox` and
  `continueRestartedRun`: deterministic message/command IDs deduplicate a replay.
  The `preparing` phase represents a never-started app run, which is skipped
  as `other`. `start` represents a run with startedAt whose provider thread is
  not saved yet; this is skipped as `no_provider_thread`. Both preparation
  windows are checked by the stronger assertion.
- `preparationWitness`: prepare → crash → recover produces
  `no_provider_thread` with no continuation. The stronger assertion
  `preparationContinues` fails. The current I7 interpretation permits a recorded
  reason; the existing reason is a startup log, not a durable per-run receipt.
  The model does not prove that logs are delivered to the owner. It excludes
  settings disabled/unreadable, archived/snoozed threads, session mismatch,
  user Stop, newer runs, maintenance commands and the three-continuation loop
  guard; those paths require further refinement before full I7 certification.
- `commands.qnt:stepCurrent`: `KanbanService.post/answer` saves before calling
  `routeSavedOwner/routeRetainingAskers`; `boardLocks.outside` releases locks for
  I/O. Conflicts now retry with fresh state. The hotfix's `ownerDeliveries` map
  and retry fibers remain volatile. `lostOwnerWitness`: save → process loss →
  recovery has saved content but no routable work or durable pending notice.
  This is the I4 loss class, not an assertion that the current endpoint returned
  an M2 receipt. Conflict alone is **not** claimed to reproduce loss after the
  hotfix; crash during the retry window does. The visible pending note after
  exhausted retries is not a terminal undeliverable outcome or a durable job.
- `boards.qnt` models a serialized mailbox reducer, not the current snapshot
  locking implementation. Field revisions are independent. A move reserves the
  pool slot atomically and invalidates old completion tokens when leaving.
- `sync.qnt` captures versioned rows at H before paging. Deltas represent the
  entire changed-row prefix (unchanged keys folded forward), applied atomically
  with its cursor. Tombstones remain in versioned history. Floor/epoch mismatches
  prevent delta application and force a new snapshot. Tokens abstract binding
  store/scope/schema as one fixed scope and an epoch. Revocation guards every
  response and purges the client immediately on discovery. A disconnected
  client cannot know about a server revocation; instantaneous remote cache
  erasure is not a feasible guarantee.

## Conformance seam

`conformance/outbox.ts` runs the real EventSink, projection store, receipt store
and outbox over a fresh, migrated, file-backed SQLite database. It drives
scheduled fast-check command sequences: commits and duplicate retries,
transaction rollback before append and after the first outbox write, claim,
delivery, completion, stale completion from an actual prior claim, process
loss and startup reconciliation. After every step it compares receipts, events,
projection title, outbox status and a synthetic downstream inbox to an independent
reference model. The inbox's unique ID is the downstream dedup assumption.
A deterministic regression additionally exercises reverse admission order, a
late transactional rollback, duplicate acceptance, and delivery/crash/reclaim
followed by completion from the actual old worker.
A final fair suffix drains every accepted obligation, including a delivery
whose completion ACK was lost before a restart.

Process loss closes service scopes and reopens the same file; it does not SIGKILL
a child process, simulate disk-full or prove fsync. The real effect executor is
replaced by the synthetic inbox, so this checks commit/outbox delivery boundaries,
not provider SDK behavior or the EffectWorker daemon scheduler. The pattern is
reusable by adding command adapters and observations for later reducers.

On failure `conformance.json` records seed, shrink path, replayPath in the printed
command counterexample, and the final shrunk trace. Replay with `FC_SEED`,
`FC_PATH`, `FC_REPLAY_PATH`; use `FC_RUNS` to change the default 100 scenarios.

References: [Quint CLI](https://quint.sh/docs/quint),
[Quint language](https://quint.sh/docs/lang),
[Apalache invariants](https://apalache-mc.org/docs/apalache/principles/invariants.html),
[fast-check stateful tests](https://fast-check.dev/docs/advanced/model-based-testing/).
