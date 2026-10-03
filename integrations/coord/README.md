# coord

Thin coordination substrate for the Crpko delivery workflow: scoped channel events with
per-recipient delivery and ack, claims with fencing, dependency readiness, a release / TF / DDL /
QA admission queue, a single-writer architecture request queue, and pause / drain gates.
Linear and GitHub stay the external truth; crw keeps its own approval and execution state.

Plain Node (v22.5+, `node:sqlite`), no dependencies.

- `lib/coord.mjs`: the library (`post`, `inbox`, `ack`, `claim`, `check`, `renew`, `release`,
  `reconcile`, `releaseRequest`, `releaseAdmit`, `releaseStart`, `releaseObserve`, `archRequest`,
  `archTake`, `archDone`, `archTransfer`, `gate`, `approvalProvenance`, `ensureActor`, `configure`,
  `attention`, ...). crw imports it in-process.
- `lib/evidence.mjs`: read-only `gh` evidence (`serviceRuntime`, `verifyHead`, `observeRelease`).
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

crw supplies the rollout-gate hook in-process:

```js
import * as coord from '<live>/lib/coord.mjs';
coord.configure({ gateCheck: async release => ({ prs: release.content_prs.map(pr => ({ pr, ok, evidence })) }) });
```

Every PR in `content_prs` needs `ok: true` with non-empty `evidence`, at admission and again at
start. Without a hook, a non-empty range is refused with `gate_unavailable`. The CLI loads one from
`COORD_GATE_HOOK` (a module exporting `gateCheck`).

## Rules worth knowing

- Same `event_key` + same body is a no-op; a different body is refused (`conflict`, 409).
- An expired lease becomes `reconcile_required`, never a handover. Fences only grow.
- Request keys are idempotent against an immutable fingerprint of the request; a different binding is
  `conflict`, even after the release progressed.
- Service and frontend releases need `binary`, `runtimeSha` and `contentPrs` (every PR in
  runtimeSha..sha), or an empty list with `rangeEvidence`.
- Release admission binds repo, sha, digest, plan and environment; `release start` revalidates the
  head and the gates, and refuses if either moved. A `built_not_deployed` release blocks new releases
  of that repo in that environment until a manually admitted `redispatch` with the same tag and digest
  starts (it supersedes exactly that row), or an admitter cancels it. An admitter can bind a missing
  digest to a built row with `release record --as release --evidence ...`.
- Terraform: `tf_apply` names its root and scope (`targets` or `fullRoot`) and the root generation at
  plan time (`coord tf gen ROOT`). Starting any mutation whose footprint names `tf:<root>` bumps that
  generation; older plans are refused (`stale_plan`) at admission and at start. `tf_full_root_blocked`
  is on until master clears it, and is rechecked at start. `plan` is `saved:<plan run id>` or
  `scope:<infra-only scope>`; for ddl/migration `<file>.sql[@checksum]`.
- An open QA window holds its whole environment against every mutation, in both directions, whatever
  the footprint strings; an expired window keeps holding until master/release closes it (attention
  lists it). QA cannot open over an unresolved or foreign env claim.
- An expired lease is never released or handed over; it needs `reconcile`. Expired claims on a
  footprint or its env block admission, start and QA by anyone.
- `pause` refuses claims, admissions, starts and non-control deliveries; acks still work.
  `drain` refuses new claims and admissions; in-flight work can renew and observe.
- The pump re-reads each delivery, its actor's thread and the pause state just before each send;
  held rows never starve deliverable ones.
- A Robob thread in `waiting` is not drained, and a thread that could not be checked is not drained.
- A taken arch request moves to a new `arch:broker` holder only via `arch transfer`, after the old
  fence was released or reconciled as `not_started`/`rolled_back`.
- `approvalProvenance(msg)` verifies only `createdBy=user` with `creationSource` in the configured set.

## Evidence and known limits

Evidence fails closed: anything not positively identified is `unknown`, and the release stays
`running` (attention lists it under `unobserved`).

- Only `dev` has an evidence source. Requests for other environments are refused `env_unsupported`.
- Service runtime is the newest deploy-dev-service attempt (by `run_started_at`) that names the binary;
  a newer unreadable, unfinished or failed run for it makes runtime unknown.
- Terraform/migration `done` needs the right workflow file, `CRPKO_ENV`, plan identity in the logs and
  a successful apply step (`Apply saved plan`, `Terraform apply`, `Apply gated migration`).
- Frontend `done` needs the deploy run's head to contain the requested sha (observed-head semantics).
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
