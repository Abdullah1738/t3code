# Robob overload restart

Source for the parked overload watchdog (Watchers #109). Nothing in this package
loads a LaunchAgent. `install.zsh` writes the installed files and plist and creates
the disabled marker. The watchdog's own checks stop at `EXPIRES`, currently
**23 Nov 2026, 00:00 UTC**. `status` reports this as `expiresScope: "check"`.

`restart [stamp]` serves callers with their own restart authority, including
mac-guard under Mac #91. It remains available past `EXPIRES` and keeps every
other limit. Its arguments, alphanumeric stamp, detached tmux launch on socket
`restart` / session `robob-restart`, logs and result files are unchanged.

## Activation, in order

1. Get Abdullah's explicit say-so, and Mac #106's current all-clear. Confirm the
   Mac #107 marker `~/.local/state/mac-upkeep/ssd-launchd-read-blocked` is absent.
2. Run `./integrations/robob-overload-restart/install.zsh` from the reviewed fork.
   It preserves the off state and prints a bootstrap command without running it.
3. Use a separate, one-shot launchd plist with ProgramArguments
   `/bin/zsh -f ~/.local/share/robob-overload-restart/launchd-entry.zsh probe`
   (expand `~` in the plist). It must have no interval or KeepAlive. Record the
   `preflight.probe` rows and final `probe outcome=ok`, then remove that one-shot
   label. `probe` never takes a hold, quits, opens Robob or sends Telegram.
4. Only after that passes, remove the watchdog's `disabled` marker and run the
   printed bootstrap command. Read the first `check` row, including `stages` and
   `rule`. An unknown verdict is not proof of a healthy backend.

Stop with `launchctl bootout gui/$(id -u)/com.ardud.robob-overload-restart` and
create `~/.local/state/robob-overload-restart/disabled`. Do not extend the expiry
without renewed authority. This implementation does not alter robob-guard or the
Watchers #108 outage alert.

## Safety model

The installed zsh entry remains the launchd responsible process; Python and Node
run as children. It never execs Python. State, locks, results and logs default to
the internal disk at `~/.local/state/robob-overload-restart`; installed source is
at `~/.local/share/robob-overload-restart`. Keep both on the internal disk.

Before deep health and again before quit, child processes must open the SSD
runtime file, read the app executable and resolve/list userdata through its
symlink. Missing, denied, slow and timed-out reads all refuse. A marker refuses
even when stale, as required by this card. This intentionally tightens the old
tracker's stale-marker exception. Only child probes touch those dependencies;
the watchdog never reads server-runtime.json to infer server identity.

A separate supervisor owns the hold and the 25-minute monotonic deadline. It
kills the restart process group and calls `robob-install-hold stop --by
overload-restart --pid <supervisor>`, including after a partial hold acquisition,
worker crash, exception or supervisor TERM/INT/HUP. It never waits indefinitely
for a killed process. Readiness logs a start and outcome for each attempt; a
deadline also writes an outcome from the parent. The usual 15-minute readiness
window, two-hour cooldown and minimum uptime, build/install/restart exclusions,
disabled marker and both overload rules remain. Expiry stops only the watchdog's
own checks, including their automatic restart triggers.

Install exclusions also inspect every pane on tmux socket `qf-install` in sessions
matching `^install\d*$`. A live pane holds while its command is not an idle shell
(`zsh`, `-zsh`, `bash`, `sh`, `login`), or its session was active within 30 minutes.
Old idle shells and dead panes do not hold forever. Exit 1, `no server running`
or `error connecting` establishes absence; other probe failures hold. Session
holds keep reason `restart-or-install-session` and log `detail` with the matching
socket/session, command and idle age, or the probe failure.

The supervisor alone writes one `restart.done`/`restart.failed` per cycle stamp.
It then retries the result notice up to three times, with the same Telegram key
`robob-overload-restart:<stamp>:result`. Three 20-second calls and two 30-second
gaps bound notification attempts to about two minutes. Each attempt logs its
exit code and stderr head. Telegram's key deduplication prevents an ambiguous
retry from accepting a second notice. A permanent bridge outage remains a
logged `notify.failed`; no process can guarantee remote delivery while the
transport is unavailable. SIGKILL of the supervisor itself, machine power loss,
or an unwritable internal disk cannot produce an in-process result. The guard's
independent hold maximum and #108 are the separate safety nets for those cases.

The installer copies `client.mjs` and `deep-health.mjs` from the fork's
`apps/server/src/ardud/control/` to the internal install. No board-artifact
t3ctl snapshot is vendored. Reinstall this package after changes to that health
protocol. `health-probe.mjs` calls the same deep-health implementation directly,
without t3ctl's detached helper, so a supervisor kill covers the entire probe.

## Configuration and verification

All path overrides use the `ROBOB_OVERLOAD_` prefix: `HOME` (installed source),
`STATE`, `LOG`, `APP`, `USERDATA`, `SSD_PROBE`, `MAC_MARKER`, `HOLD`, `HOLD_CLI`,
`NODE`, `TMUX`, `BUN`, `TELEGRAM`, `QF_SOCKET`, `QF_SESSION_RE`, `QF_IDLE_SEC`.
The QF overrides default to `qf-install`, `^install\d*$` and 1800 seconds.
Installer-only `PLIST_DIR` changes the output
directory. `DEADLINE` defaults to 1500 seconds, `PROBE_TIMEOUT` to 8,
`PROBE_SLOW` to 4, `NOTIFY_TIMEOUT` to 20 and `NOTIFY_DELAY` to 30. `DRY=1`
suppresses quit/hold/open/Telegram. Never redirect supervisor storage to the SSD.

Run the focused suite offbox from the repository root:

```sh
offbox run -- python3 -m unittest discover -s integrations/robob-overload-restart -p 'test_*.py'
python3 -m py_compile integrations/robob-overload-restart/robob-overload-restart.py
zsh -f -n integrations/robob-overload-restart/launchd-entry.zsh
zsh -f -n integrations/robob-overload-restart/open-robob-clean.zsh
zsh -f -n integrations/robob-overload-restart/install.zsh
```

Tests use temporary paths, a fake hold CLI, fake quit/open/Telegram and real
FIFO opens with no writer. They do not use the live tmux socket, hold, app or
Telegram. Passing them proves bounded behavior under the simulated syscall
jam; the launchd/TCC readback remains an explicit activation prerequisite.
