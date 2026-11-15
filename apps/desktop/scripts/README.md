# Robob installer

`install-robob-fast.zsh` runs the installer in tmux and records its output in
`~/.robob/install-<stamp>.ndjson`. The outer wrapper returns after starting the
session; its exit 0 only confirms the launch. `--dry-run` prints the plan without
installing.

`--ready-budget-s N` sets one startup budget, in integer seconds (minimum 180,
default 180). It is logged as `readyBudgetS` at install start and covers command
deadlines, the backup allowance (still capped at 120 s with 60 s reserved), listening
and continuation readiness, measured from quit. Generated `run-install.zsh` release
launchers must pass the packet's budget to `install-robob-fast.zsh`, for example
`--ready-budget-s 780`; the wrapper preserves it across tmux. The legacy unattended
restart and resume installers accept the same flag.

An overrun logs the current phase from `userdata/logs/boot.ndjson`, pins the backup
and keeps the recovery heartbeat until healthy. It never stops the new server.
The legacy server-health wait remains unbounded; its budget marks a diagnostic,
and also replaces its existing shutdown grace and optional OpenCode wait.

After startup and continuation readiness,
that, the `read-check` phase runs `~/.local/bin/robob-read-watchdog --sustain 300
--every 30 --give-up 1800`. Success is reported only after five minutes of healthy
reads, including installs with no interrupted threads and rollbacks. Automatic
continuations do not wait for this observation window.

| Node installer exit | Meaning |
| --- | --- |
| 0 | Completed (or printed the plan with `--dry-run`). |
| 1 | An installation or reporting step failed; inspect the log. |
| 75 | The bundle is installed, but sustained reads failed. The error notification includes the failing-since time and log. Do not reinstall on the strength of this code. |

`ROBOB_READ_CHECK` overrides the watchdog executable path for tests.
`ROBOB_INSTALL_LOG` supplies the log path when invoking the Node script directly;
the zsh wrapper sets it for detached runs.
