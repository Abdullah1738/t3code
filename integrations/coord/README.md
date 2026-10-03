# coord

Thin coordination substrate for the Crpko delivery workflow: scoped channel events with
per-recipient delivery and ack, claims with fencing, dependency readiness, a release / TF / DDL /
QA admission queue, a single-writer architecture request queue, and pause / drain gates.
Linear and GitHub stay the external truth; crw keeps its own approval and execution state.

Plain Node (v22.5+, `node:sqlite`), no dependencies.

- `lib/coord.mjs`: the library (`post`, `inbox`, `ack`, `claim`, `check`, `renew`, `release`,
  `reconcile`, `releaseRequest`, `releaseAdmit`, `releaseStart`, `releaseObserve`, `archRequest`,
  `archTake`, `archDone`, `gate`, `approvalProvenance`, `attention`, ...). crw imports it in-process.
- `lib/evidence.mjs`: read-only `gh` evidence (`serviceRuntime`, `verifyHead`, `observeRelease`).
- `lib/pump.mjs`: delivery to Robob threads via `POST /api/ardud/control/threads/:id/send`
  (`mode: queue`, `clientRequestId = coord:<event_key>:<recipient>`, so a resend after a crash
  replays instead of posting twice).
- `cli.mjs`: the CLI. JSON out; exit 1 with `error.code` on refusal, 2 on usage.
- `scripts/coord`: wrapper for `~/.local/bin`. `scripts/com.ardud.coord-pump.plist`: the pump
  LaunchAgent (`coord pump` every 60 s).

State: `~/.local/share/coord/data/coord.db` (override with `COORD_DB`). Control API url/token come
from `T3_CONTROL_URL` / `T3_CONTROL_TOKEN` or `~/.robob/ardud-control.json` (chmod 600).

Defaults (env overrides): reconcile by `COORD_RECONCILERS` (`master,release`), manual admits by
`COORD_ADMITTERS` (`master,release`), approval sources `COORD_APPROVAL_SOURCES` (`web,mobile`),
lease TTL 30 min, one reminder after 30 min unacked.

## Rules worth knowing

- Same `event_key` + same body is a no-op; a different body is refused (`conflict`, 409).
- An expired lease becomes `reconcile_required`, never a handover. Fences only grow.
- Release admission binds repo, sha, digest, plan and environment; `release start` revalidates the
  head and refuses if it moved. A `built_not_deployed` release blocks new releases of that repo until
  a `redispatch` with the same tag and digest, or an admitter cancels it.
- `pause` refuses claims, admissions, starts and non-control deliveries; acks still work.
  `drain` refuses new claims and admissions; in-flight work can renew and observe.
- A Robob thread in `waiting` is not drained.
- `approvalProvenance(msg)` verifies only `createdBy=user` with `creationSource` in the configured set.

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
