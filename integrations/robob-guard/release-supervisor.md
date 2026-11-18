# External release supervisor hold

Every hold now expires **30 minutes after creation**, even while its owner
and beater remain alive. The recovery waits below do not extend that bound;
repair or rollback must finish before it, or the guard can recover Robob itself.

The retry supervisor currently lives outside the fork:
`/Users/ardud/.robob/install-20261111.2-sup/install-retry.zsh`.
It writes `~/.robob/install-20261111.2.ndjson` and
`~/.robob/install-20261111.2-sup/attempt-N.ndjson`, and invokes
`/Volumes/ExternalSSD/tmp/release-20261111b/clone/apps/desktop/scripts/install-robob-fast.zsh`.
That release clone predates the hold support added here. Do not edit or run
this live supervisor as part of building the guard.

Before enabling the guard, apply all three edits below to that supervisor
(or its next release copy). These cover success, failure and retry exhaustion.
After `cd /Volumes/ExternalSSD/tmp/release-20261111b/clone`, before the loop,
insert this block:

```zsh
source /Volumes/ExternalSSD/t3code-fork/integrations/robob-guard/scripts/install-hold.zsh
robob_hold_begin release-supervisor || exit $?
T3CTL=/Volumes/ExternalSSD/t3code-fork/apps/server/src/ardud/control/t3ctl.mjs
supervisor_finish() {
  local install_rc=$1
  print -u2 "Install attempt ended ($install_rc). Keeping supervisor $$ and its heartbeat until Robob is healthy."
  print -u2 "If recovery is needed, repair or run a compatible rollback from another Terminal with ROBOB_INSTALL_HOLD_BY=$ROBOB_INSTALL_HOLD_BY ROBOB_INSTALL_HOLD_PID=$ROBOB_INSTALL_HOLD_PID. Keep this supervisor running."
  robob_hold_wait_for_repair node "$T3CTL" health
  exit "$install_rc"
}
```

Replace the indented `exit $rc` inside the loop with:

```zsh
  supervisor_finish "$rc"
```

Replace the final `exit 1` after `done` with:

```zsh
supervisor_finish 1
```

`robob_hold_wait_for_repair` validates the command's JSON body: `ok` must
be the boolean `true` and `status` must be `healthy`. Exit 0 with `null`,
HTML, malformed JSON or an unhealthy response does not release the hold.

Do not put an `rc == 0` condition around the health wait. If a child fails
at launch, times out on readiness, cannot relaunch the previous app, or
exhausts its pre-quit retries, the owning supervisor stays alive with its
heartbeat. It keeps waiting until the authenticated health command succeeds,
including after a manually completed compatible rollback. The child's
original exit code is preserved after recovery; healthy does not turn a
failed install into a successful install.

The existing pre-quit clone-race `continue` keeps the same hold between
attempts. The `zshexit` hook releases it only after `supervisor_finish`
observes health. The helper's beater watches the supervisor PID. If the
supervisor is killed or crashes, its PID dies and the guard recovers Robob;
the same happens at the 30-minute age cap. There is no permanent hold switch.

The fork installer also checks authenticated health before releasing its own
hold after any quit, outside its configured readiness budget (180 s by default). Post-swap checks
require a new boot identity. If it is waiting after a failed launch, the log
and Telegram alert request repair or compatible rollback from another
Terminal while the installer remains alive. Pass the hold name/PID printed
in its recovery log to that rollback so it reuses the live owner instead of
fighting it. Rollback compatibility still uses the installer's existing
migration preflight; this change does not roll back automatically.

Other entry points: `missions-cutover.zsh` and `missions-rollback.zsh` both
call `install-robob-resume.zsh`, so the leaf installer covers their quit window.
`robob-cutover.zsh` is the retired OpenChamber migration/rollback path and
should not be run against the current installation. Its rollback returns to
OpenChamber rather than a healthy Robob; it contradicts the owner's current
always-reopen decision and would require an explicit owner decision to revive.
