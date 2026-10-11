# coord

Thin coordination substrate for the Crpko delivery workflow: scoped channel events with
per-recipient delivery and ack, claims with fencing, dependency readiness, a release / TF / DDL /
QA admission queue, a single-writer architecture request queue, and pause / drain gates.
Linear and GitHub stay the external truth; crw keeps its own approval and execution state.

Plain Node (v22.5+, `node:sqlite`), no dependencies.

- `lib/coord.mjs`: the library (`post`, `inbox`, `ack`, `claim`, `check`, `renew`, `release`,
  `reconcile`, `releaseRequest`, `releaseAdmit`, `releaseStart`, `releaseRecord`, `releaseReconcile`,
  `releaseObserve`, `archRequest`, `archTake`, `archDone`, `archTransfer`, `archCloseout`, `gate`,
  `approvalProvenance`, `ensureActor`, `configure`, `attention`, ...). crw imports it in-process;
  `coord.evidence` re-exports `lib/evidence.mjs`.
- `lib/evidence.mjs`: read-only `gh` evidence (`serviceRuntime`, `frontendRuntime`, `verifyHead`,
  `observeRelease`, `planRun`).
- `lib/pump.mjs`: doorbell delivery to Robob threads via `POST /api/ardud/control/threads/:id/send`
  (`mode: queue`). Per thread at most one outstanding wake: `[coord] N unacked deliveries for <actor>
  (seqs a-b, newest: ...). Read coord inbox --as <actor> --unacked, handle, ack.` It rings only an
  `idle`/`waiting` thread; while the last wake's run is still queued, new deliveries are marked sent on
  that wake instead. Single-recipient `control`/`blocker` summaries go inline. The wake's
  `clientRequestId` (`coord:wake:<sha256>`) is kept until the ring settles, so a resend after a crash
  replays instead of posting twice. Then `release observe` for a bounded number of running releases.
  Self-healing (`HEAL` in `lib/pump.mjs`, counted in `deliver.healed`/`heals`): a thread reported
  `queued` with no run activity for 3 min has a held queue (Robob holds it after provider failures and
  restarts) and is rung like an idle one; a wake whose turn failed or was cancelled after starting (or
  that sits behind a held queue) goes back to pending and is re-rung under a new `clientRequestId`, at
  most once per 5 min; a turn running 30+ min with deliveries older than `unackedAfter` gets a queued
  wake. Overdue deliveries on a busy thread are listed in `deliver.stuck` and `attention.pending_overdue`.
  Supersede: before ringing a non-idle thread the pump lists its queued runs and cancels its own earlier
  wakes/reminders (message id from a `coord:` clientRequestId and `[coord]`/`[coord reminder]` text), so
  only the newest wake is queued; their unacked deliveries ride on the new wake. Every 5 min it also checks
  each actor thread: one held 10+ min with only coord wakes queued has them cancelled and gets one fresh
  wake; one holding anything else (owner or agent messages, task notices) is never touched and is listed in
  `attention.held_queues`. Queue list/cancel go over the app's `/ws` RPC (`getThreadProjection`,
  `queued-run.cancel`) with the control token. Counted in `deliver.superseded`/`supersedes`.
  Each tick stamps `pump:heartbeat` in `control` (with `superseded`); `attention.pump.stale` flags a pump
  silent for 5 min.
- `cli.mjs`: the CLI. JSON out; exit 1 with `error.code` on refusal, 2 on usage.
- `scripts/coord`: wrapper for `~/.local/bin`. `scripts/com.ardud.coord-pump.plist`: the pump
  LaunchAgent (`coord pump` every 60 s).

State: `~/.local/share/coord/data/coord.db` (override with `COORD_DB`). Control API url/token come
from `T3_CONTROL_URL` / `T3_CONTROL_TOKEN` or `~/.robob/ardud-control.json` (chmod 600).

Defaults (env overrides): reconcile by `COORD_RECONCILERS` (`master,release`), manual admits by
`COORD_ADMITTERS` (`master,release`), approval sources `COORD_APPROVAL_SOURCES` (`web,mobile`),
lease TTL 30 min; each delivery is reminded once after 30 min unacked, at most one coalesced reminder
per thread per 30 min, only while the thread is idle.

## Setup

`coord init` seeds the pull-only `crw` process actor (idempotent). The crw adapter also calls
`ensureActor('crw', { kind: 'process' })`, which never rebinds an existing actor: it is a single
insert-if-absent, so a registration that wins concurrently stays as it is. It returns
`{ actor, created: true }` or `{ actor, existing: true }`.

## Contracts for the crw adapter

```js
import * as coord from '<live>/lib/coord.mjs';
coord.configure({ rangeResolver, gateCheck });   // once per process; both are required for deploy releases
```

**`rangeResolver({ repo, binary, environment, base, head }) -> Promise<{ complete: true, prs: string[], evidence?: string }>`**
`repo` is lowercase `owner/name`, `base` is the request's `runtimeSha`, `head` its `sha` (both 40-char).
`prs` is every PR whose merge commit is in `base..head`, as lowercase `owner/repo#N`. Return
`complete: true` only when the whole range was read; throw or return anything else and admission
refuses `range_unavailable`. An empty range is accepted only as `{ complete: true, prs: [] }`.

**`gateCheck(release) -> Promise<{ prs: Array<{ pr: string, ok: boolean, evidence: string }> }>`**
Called with the release row (`content_prs`, `repo`, `binary`, `git_sha`, `runtime_sha`, ...) only when
the range is non-empty. Every PR in `content_prs` needs `ok: true` and non-empty `evidence`, otherwise
`gates_not_clear` (or `gate_unavailable` when the hook is missing or throws).

Both run at `releaseAdmit` and again at `releaseStart`, after coord checks that the live runtime
(`serviceRuntime` / `frontendRuntime`) is known and equals the request's `runtimeSha`
(`runtime_unknown` / `runtime_moved`), and that `prs` equals `contentPrs` as a set (`range_mismatch`).
The CLI loads both hooks from `COORD_HOOKS` (a module exporting `rangeResolver` and `gateCheck`).

**Requests** (`releaseRequest(o)`; repo and binary are canonicalized to lowercase):

| kind | required |
| --- | --- |
| `service_release` | `as, key, env, repo, binary, sha, tag, runtimeSha, contentPrs` (array, may be `[]`); `tag` is `<binary>-docs<N>-dev.<M>` |
| `frontend_release` | `as, key, env, repo, binary, sha, runtimeSha, contentPrs` |
| `redispatch` | the service fields plus `tag, digest` of the built release (manual admit) |
| `tf_apply` | `as, key, env, plan: 'saved:<plan run id>@<attempt>'`; always the full `dev` root; manual admit |
| `ddl` / `migration` | `as, key, env, plan: '<file>.sql@<sha256 of the SQL>'`; manual admit |

Tags follow crpko-devops `scripts/validate-release-tag.mjs`: `^<binary>-docs<N>-<env>\.<M>$` with
`N, M >= 1` and no leading zeros, where `<binary>` is one of the release-tag schema's binaries
(`coord.RELEASE_BINARIES`, mirrored from `plan/schemas/cicd/release-tag.schema.json`). Repository names
are not binaries: custody-transfer releases `custody-transfers`, market-data-mock `market-data`,
venue-router-adapters-mock `venue-router-adapters`, risk-liquidation-latest `risk-liquidation`. Its binary and env must equal the request's (dev only, since only dev
has evidence); this is checked at request, admission, start and when binding a tag on a built row
(`invalid_tag`). The service workflow takes its environment from the tag, so a prod tag on a dev
request would release to prod. `coord.parseTag(tag)` returns `{ binary, docs, env, version }` or null.

`footprint` is optional and only adds resources. Every request also takes `env:<env>`, `repo:<repo>`,
`svc:<binary>` and the Terraform roots it touches (`tf:dev` for saved plans and for `registry`,
`tf:dev`, `tf:dev-risk-liquidation` and `tf:dev-core-capacity` for `risk-liquidation`, whose state
handoff writes the source `dev` state too). Naming `env:<env>` in
`footprint` (and every Terraform/DDL/migration) makes the operation exclusive for its environment.

**`releaseAdmit(id, { as, manual?, verify?, planRun?, rangeResolver?, gateCheck?, runtime? })`**,
**`releaseStart(id, { as, fence, sha?, tag?, digest?, plan?, releaseRun?, deployRun?, tfRun?, ... })`**.
Start requires the admission fence, the same claim fences admission relied on, the same head, range,
gates and runtime, a valid tag, no open QA window and no other built release of the repo. Restated
`env`, `repo` and `sha` are compared in canonical form (`DEV` matches `dev`). Run ids
(`releaseRun`, `deployRun`, `tfRun`), digest and tag bind once, whether given to `releaseRecord` or
`releaseStart`: a different value for a bound field is `binding_mismatch`.

**Resource keys** are canonicalized by every entry point that takes one (`claim`, `check`, `renew`,
`release`, `reconcile`, `claim_free` deps, release and QA footprints, the CLI), so spellings of the same
resource are one key: the kind is lowercased; `repo:<owner>/<name>` and `pr:<owner>/<name>#<n>` lowercase
owner and name; `svc:`, `tf:` and `env:` values are lowercased names. Malformed keys are refused
(`resource_invalid`): a missing kind or value, whitespace or control characters, `repo:` without exactly
`<owner>/<name>`, `pr:` without `#<number>`, `svc:`/`tf:`/`env:` values that are not names. Other
kinds (`ticket:`, `ch:`, ...) keep their value as given. Results report the canonical `resource`.

**Environments** have one spelling too, wherever they enter: claim `env`, release `env`, QA `env`,
pause/drain `scope` (`env:<e>` or a lowercase name such as `crw`), event `env`, list filters and the
CLI flags. `coord.canonicalEnv(env)` lowercases and checks it: `env_required` (missing/blank),
`env_invalid` (malformed), `env_unsupported` (`*`, or anything but dev where an operation acts).
`setMode` stores `mode:env:dev` for `ENV:DEV`; `gate` reads the same key; a malformed scope is
`scope_invalid`.

**Stored state is never rewritten.** On open, coord checks (read-only) that every stored resource key,
environment, pause/drain scope, Terraform root, release repo and binary is canonical. If any is not
(written by an older version or by hand) the open is refused with `noncanonical_state`, naming the
table, row and canonical form; an operator must reconcile those rows by hand (decide which spelling is
the real claim or release, resolve conflicts, then rewrite or delete) before coord will open the database.
Request fingerprints come from canonical fields, so retries of the same request stay idempotent.

**Mutation claims** are claims on anything but `pr:`, `ticket:`, `files:`, `arch:`, `channel:` and
`work:`. Each resolves to exactly one concrete supported environment (only `dev` today), checked in
the library so the CLI and embedders agree:
- `env:<e>` and Terraform roots `tf:<e>` / `tf:<e>-<suffix>` (`tf:dev`, `tf:dev-risk-liquidation`,
  `tf:dev-core-capacity` are dev) carry their own environment;
- every other mutation resource needs `claim(resource, { as, env })` (CLI `--env`).
Refusals: `env_required` (missing or blank `env`, or `env:` with nothing after it), `env_unsupported`
(any environment other than dev, including `*` and `env:*`), `env_mismatch` (an `env` that contradicts
the resource's own). Coordination claims ignore `env`. `claim` returns its `env`. A mutation claim
passes the global pause/drain gate and its environment's.

**Claims exclude claims** beyond the same resource: an `env:<e>` claim overlaps every other mutation
claim scoped to `<e>`, in both directions and whoever holds it (`claimed`; an expired one gives
`reconcile_required` until reconciled). `check` applies the same rule. Disjoint narrow claims (two
services) stay independent, and coordination claims are unaffected. There is no same-owner exception:
an operation that holds `env:<e>` does not also claim narrower resources in `<e>`.

**Claims, QA windows and releases** exclude each other both ways:
- An open QA window refuses every mutation claim in its environment (`qa_window_open`), and cannot
  open over one (`claimed`).
- While a release is admitted or running, `claim('env:<env>')` is refused (`release_in_flight`) for
  every mutation in that environment, and `claim('svc:…' | 'repo:…' | 'tf:…')` when the resource is in
  its footprint. An env-exclusive release (Terraform, DDL, migration, or a footprint naming `env:<e>`)
  refuses every mutation claim in its environment, and is not admitted over a foreign one;
- `check` of such a fence is refused too, except for a claim the release's admission relied on
  (listed in its `claim_fences`): its owner keeps `check`/`renew` of exactly that fence.
So take the claims an operation needs before its admission, not after. Admission and start refuse
foreign or expired claims on the footprint (`claimed`, `reconcile_required`).

**`releaseRecord(id, o)`**
- admitted/running: `{ fence, releaseRun?, deployRun?, tfRun?, digest? }` (each field binds once).
- built_not_deployed: `{ as: 'release'|'master', evidence: string, tag?, digest?, deployRun? }`. The
  row stays built; it then admits a `redispatch` with that exact tag and digest.

**`releaseReconcile(id, { as: 'release'|'master', outcome, evidence: string })`** (async)
| outcome | from | to |
| --- | --- | --- |
| `not_started` | admitted, running | cancelled |
| `still_running` | admitted, running | unchanged (note recorded) |
| `done` | running | done |
| `rolled_back`, `failed` | running | failed |
| `built` (service only) | running | built_not_deployed |

A redispatch reconciled `not_started` puts its built source back to `built_not_deployed`; only
`releaseCancel` by an admitter abandons a built release.

Terraform, DDL and migrations are never auto-classified: after the run, the release owner or master
records `done`/`failed` with evidence text (run id, attempt, readback). The release keeps its locks
until then (`attention.awaiting_reconcile`). Ending a running operation that touches a Terraform root
advances that root, so saved plans whose run started earlier are refused (`stale_plan`).

Claim-only mutations advance roots too: acquiring `tf:<root>` advances `<root>`, and so does releasing
it or reconciling it after expiry; acquiring or ending an `env:<e>` claim advances every known root of
`<e>` (the saved-plan root and the service release roots). A saved plan whose run started before any
of those is refused (`stale_plan`).

**Plan verification** (`configure({ planRun })` or the default GitHub check) must return
`{ startedAt, run?, attempt? }` with a finite positive `startedAt` (seconds) and, when given, the
pinned run and attempt. `null`, a malformed result, or a throw is `plan_unverified`, at admission and
at start; start also requires the same `startedAt` as admission.

Saved plans: `terraform-dev.yml`'s saved-plan apply takes only `saved_plan_run_id` and uses that
run's **latest** attempt; it has no attempt input. Admission and start therefore require the pinned
attempt to still be the run's latest, both before and after reading its evidence
(`plan_attempt_moved`), and that attempt's `Package saved full-root
plan`, `Configure AWS credentials for saved plan storage`, `Store saved plan in the state bucket` and
`Upload saved plan metadata` steps to have succeeded (`plan_unverified`). A rerun of the plan run
between start and the apply dispatch is not visible to coord: the master owns that race (dispatch
right after start and do not rerun plan runs). Reconciling a `tf_apply` as `done` re-reads the plan
run; if it moved past the pinned attempt the evidence must name the plan attempt the apply used
(`plan attempt <n>`, between the pinned and the latest), otherwise `plan_attempt_moved`.

**Runtime evidence** (`coord.evidence.serviceRuntime({ binary, env = 'dev' })`,
`coord.evidence.frontendRuntime({ repo, env = 'dev' })`) resolve
`{ state: 'known'|'unknown', sha, tag, digest, run, attempt, reason }` (`tag`/`digest` are `null`
for frontends; everything but `state` and `reason` is `null` when unknown). They throw
`env_unsupported` for environments other than `dev`.

## Rules worth knowing

- Same `event_key` + same body is a no-op; a different body is refused (`conflict`, 409).
- An expired lease becomes `reconcile_required`, never a handover. Fences only grow. An expired lease
  is never released; it needs `reconcile`, and blocks admission, start and QA by anyone meanwhile.
- Request keys are idempotent against an immutable fingerprint of the request; a different binding is
  `conflict`, even after the release progressed. A saved plan or migration can be registered once.
- A `built_not_deployed` release blocks every new release of its repo in that environment, at
  admission and at start, until the redispatch admitted for exactly that row starts, or an admitter
  cancels or reconciles it.
- `tf_full_root_blocked` is on until master clears it, and is rechecked at start.
- An open QA window holds its environment in both directions: no admission or start of a mutation, no
  new `env:` claim, and `check` of an `env:` fence fails. QA cannot open over any env claim or any
  admitted/running mutation of that environment. An expired window keeps holding until master/release
  closes it (attention lists it).
- `pause` refuses claims, admissions, starts and non-control deliveries; acks still work.
  `drain` refuses new claims and admissions; in-flight work can renew and observe.
- The pump re-reads each delivery, its actor's thread and the pause state just before each ring, under a
  per-thread lease; held rows never starve deliverable ones. Last ring per thread is in the `wakes` table.
- A Robob thread in `waiting` is not drained, and a thread that could not be checked is not drained.
- `reconcile(resource, { as, fence, outcome, evidence })` (CLI `--fence`, required) closes exactly the
  expired claim with that fence. Retrying a fence that was already reconciled returns its historical
  result (`historical: true`); any other fence is `stale_fence`, and the current claim is untouched.
- `ready()` is true only if no dependency changed or was added while it was evaluated, and the local
  ones (`claim_free`, `event_acked`, `release_done`) still hold inside its final transaction.
- A taken arch request moves to a new `arch:broker` holder via `arch transfer` after the old fence was
  released or reconciled `not_started`/`rolled_back`, or is closed with `arch closeout` (commits plus
  evidence) after it was reconciled `done`.
- `approvalProvenance(msg)` verifies only `createdBy=user` with `creationSource` in the configured set.

## Evidence and known limits

Evidence fails closed: anything not positively identified is `unknown`, and the release stays
`running` (attention lists it under `unobserved`).

- Only `dev` has an evidence source. Requests for other environments are refused `env_unsupported`.
- Service runtime is the newest executed attempt (by `run_started_at`) of `deploy-dev-service.yml` or
  `rollback-dev-service.yml` that names the binary. Run lists are paged until no unseen run could hold a
  newer attempt (created within GitHub's 30-day rerun window); otherwise `unknown`.
  A run's latest attempt that provably changed nothing (it never reached `Validate release tag`;
  for frontends, ran no deploy job) does not erase that run's history: its earlier attempts are read
  back, and the latest one that did something decides that run, at that attempt's own time. An attempt
  whose effect cannot be told makes the runtime `unknown`; an older run is never reported instead.
  Before a runtime is reported `known`, every run discovery classified (the winner, runs skipped as
  no-ops, runs placed at an earlier attempt) is re-read by id; if any moved to a new attempt, is running
  again, or cannot be read, the result is `unknown` and the reason names the run. Nothing is cached
  across calls. A newer unreadable,
  unfinished or failed run for the binary makes it `unknown`. Jobs are read per attempt; skipped jobs
  are not log-fetched.
- Service observation trusts push-tag `release.yml` runs only: the run's `head_branch` must be the
  tag and `head_sha` the release sha. A `workflow_dispatch` release run (`--field release_tag=...`) is
  `unknown` with reason `workflow_dispatch provenance unsupported; reconcile manually`; CRW cuts
  release tags by push, so this is an accepted limit.
- Every applied observation, pending or terminal, advances the release version, so an older
  observation still in flight is discarded once a newer one was recorded. An observer that throws is
  recorded the same way, as an unknown result (`observation failed: ...`).
- The observer binds the release run's attempt, the downstream deploy run and its attempt the first time
  it sees them, and persists them even while the result is pending. Afterwards, a different attempt of
  either run, a release run first seen past attempt 1, or a dispatch link in the logs that is not the
  bound deploy run makes the result `unknown`: the release keeps its locks until `release reconcile`.
- A known downstream deploy run decides the outcome, whatever the parent's conclusion: while it runs,
  the release stays running. Without a downstream link, a parent run is `failed` only when its
  `Trigger environment deployment workflow` and `Build and push image` steps were both skipped; a
  successful push gives `built_not_deployed`. A push step that started and failed may already have
  pushed (registry checks the image after pushing, in the same step), so that is `unknown` and the
  locks stay until reconciled `built` or `failed` with evidence.
- `built_not_deployed` needs the repo's `release.yml` run at the release's tag and sha with a
  successful `Build and push image` step.
- Before any terminal result, the release and deploy runs are re-read: a new attempt or a run running
  again makes the result `unknown`.
- Frontend `done` needs a successful run of the repo's configured deploy workflow
  (`deploy-dev.yml`) that executed a deploy job and whose head contains the requested sha.
  crypko-frontend's CI (`ci.yml`) also deploys dev: a push run on `main-dev` whose `Deploy to Dev`
  job succeeded counts too (a skipped job does not), and runtime is the deploy that finished last.
- Terraform, DDL and migration outcomes are recorded by hand (`release reconcile`), not read from logs.
- No ECS readback yet: deployed means the deploy workflow succeeded with matching inputs, not that
  every ECS service runs the digest with `rolloutState=COMPLETED`.

## Test

```bash
cd integrations/coord && node --test 'test/*.test.mjs'
```

Tests use a temp DB and a stub control server; they never touch Robob.

## Install

```bash
./integrations/deploy.zsh coord
install -m 755 integrations/coord/scripts/coord ~/.local/bin/coord
cp integrations/coord/scripts/com.ardud.coord-pump.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ardud.coord-pump.plist
```

No Robob or OpenCode restart is needed.
