# External release supervisor hold

The retry supervisor currently lives outside the fork:
`/Users/ardud/.robob/install-20261111.2-sup/install-retry.zsh`.
It writes `~/.robob/install-20261111.2.ndjson` and
`~/.robob/install-20261111.2-sup/attempt-N.ndjson`, and invokes
`/Volumes/ExternalSSD/tmp/release-20261111b/clone/apps/desktop/scripts/install-robob-fast.zsh`.
That release clone predates the hold support added here. Do not edit or run
this live supervisor as part of building the guard.

Before enabling the guard, apply these exact additions to the supervisor
(or its next release copy). After `cd /Volumes/ExternalSSD/tmp/release-20261111b/clone`,
before `for i in 1 2 3 4 5 6; do`, insert:

```zsh
source /Volumes/ExternalSSD/t3code-fork/integrations/robob-guard/scripts/install-hold.zsh
robob_hold_begin release-supervisor || exit $?
```

The `zshexit` hook releases the hold at supervisor exit, not child exit or
between attempts. Its beater watches the supervisor PID, so preflight and
all attempts share one window. The main fork installer now holds internally
as well and will reuse this parent hold when run by an updated supervisor.

The existing `exit $rc` must be preceded by this post-launch health gate,
so a successful child exit alone does not end the install window:

```zsh
if (( rc == 0 )); then
  until node /Volumes/ExternalSSD/t3code-fork/apps/server/src/ardud/control/t3ctl.mjs health >/dev/null 2>&1; do
    sleep 5
  done
fi
```

On a failed child the supervisor owns recovery: keep the same shell and hold
alive through rollback and its post-launch health check. Do not drop the
hold just to start another attempt. If the supervisor itself dies, the guard
will ignore its hold and recover Robob. #943 owns strengthening the release
installer's readiness definition; this guard adds no separate health policy.

Other entry points: `missions-cutover.zsh` and `missions-rollback.zsh` both
call `install-robob-resume.zsh`, so the leaf installer covers their quit window.
`robob-cutover.zsh` is the retired OpenChamber migration/rollback path and
should not be run against the current installation. Its rollback returns to
OpenChamber rather than a healthy Robob; it contradicts the owner's current
always-reopen decision and would require an explicit owner decision to revive.
