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
- `lib/pump.mjs`: delivery to Robob threads via `POST /api/ardud/control/threads/:id/send`
  (`mode: queue`, `clientRequestId = coord:<sha256 of JSON [event_key, recipient]>`, so a resend
  after a crash replays instead of posting twice), then `release observe` for a bounded number of
  running releases per tick.
- `cli.mjs`: the CLI. JSON out; exit 1 with `error.code` on refusal, 2 on usage.
- `scripts/coord`: wrapper for `~/.local/bin`. `scripts/com.ardud.coord-pump.plist`: the pump
  LaunchAgent (`coord pump` every 60 s).

State: `~/.local/share/coord/data/coord.db` (override with `COORD_DB`). Control API url/token come
from `T3_CONTROL_URL` / `T3_CONTROL_TOKEN` or `~/.robob/ardud-control.json` (chmod 600).

Defaults (env overrides): reconcile by `COORD_RECONCILERS` (`master,release`), manual admits by
`COORD_ADMITTERS` (`master,release`), approval sources `COORD_APPROVAL_SOURCES` (`web,mobile`),
lease TTL 30 min, one reminder after 30 min unacked.

## Setup

`coord init` seeds the pull-only `crw` process actor (idempotent). The crw adapter also calls
`ensureActor('crw', { kind: 'process' })`, which never rebinds an existing actor.

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
| `service_release` | `as, key, env, repo, binary, sha, tag, runtimeSha, contentPrs` (array, may be `[]`) |
| `frontend_release` | `as, key, env, repo, binary, sha, runtimeSha, contentPrs` |
| `redispatch` | the service fields plus `tag, digest` of the built release (manual admit) |
| `tf_apply` | `as, key, env, plan: 'saved:<plan run id>@<attempt>'`; always the full `dev` root; manual admit |
| `ddl` / `migration` | `as, key, env, plan: '<file>.sql@<sha256 of the SQL>'`; manual admit |

`footprint` is optional and only adds resources. Every request also takes `env:<env>`, `repo:<repo>`,
`svc:<binary>` and the Terraform roots it touches (`tf:dev` for saved plans and for `registry`,
`tf:dev-risk-liquidation` and `tf:dev-core-capacity` for `risk-liquidation`). Naming `env:<env>` in
`footprint` (and every Terraform/DDL/migration) makes the operation exclusive for its environment.

**`releaseAdmit(id, { as, manual?, verify?, planRun?, rangeResolver?, gateCheck?, runtime? })`**,
**`releaseStart(id, { as, fence, sha?, tag?, digest?, plan?, releaseRun?, deployRun?, tfRun?, ... })`**.
Start requires the admission fence, the same claim fences admission relied on, the same head, range,
gates and runtime, no open QA window and no other built release of the repo.

**`releaseRecord(id, o)`**
- admitted/running: `{ fence, releaseRun?, deployRun?, tfRun?, digest? }` (each field binds once).
- built_not_deployed: `{ as: 'release'|'master', evidence: string, tag?, digest?, deployRun? }`. The
  row stays built; it then admits a `redispatch` with that exact tag and digest.

**`releaseReconcile(id, { as: 'release'|'master', outcome, evidence: string })`**
| outcome | from | to |
| --- | --- | --- |
| `not_started` | admitted, running | cancelled |
| `still_running` | admitted, running | unchanged (note recorded) |
| `done` | running | done |
| `rolled_back`, `failed` | running | failed |
| `built` (service only) | running | built_not_deployed |

Terraform, DDL and migrations are never auto-classified: after the run, the release owner or master
records `done`/`failed` with evidence text (run id, attempt, readback). The release keeps its locks
until then (`attention.awaiting_reconcile`). Ending a running operation that touches a Terraform root
advances that root, so saved plans whose run started earlier are refused (`stale_plan`).

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
- The pump re-reads each delivery or reminder, its actor's thread and the pause state just before each
  send; held rows never starve deliverable ones.
- A Robob thread in `waiting` is not drained, and a thread that could not be checked is not drained.
- `ready()` is true only if no dependency changed or was added while it was evaluated.
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
  newer attempt (created within GitHub's 30-day rerun window); otherwise `unknown`. A newer unreadable,
  unfinished or failed run for the binary makes it `unknown`. Jobs are read per attempt; skipped jobs
  are not log-fetched.
- `built_not_deployed` needs the repo's `release.yml` run at the release's tag and sha with a
  successful `Build and push image` step.
- Frontend `done` needs a successful run of the repo's configured deploy workflow
  (`deploy-dev.yml`) that executed a deploy job and whose head contains the requested sha.
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
