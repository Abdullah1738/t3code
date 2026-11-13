# Robob installer

`install-robob-fast.zsh` runs the installer in tmux and records its output in
`~/.robob/install-<stamp>.ndjson`. The outer wrapper returns after starting the
session; its exit 0 only confirms the launch. `--dry-run` prints the plan without
installing.

Startup and continuation readiness have a three-minute bound after quit. After
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
