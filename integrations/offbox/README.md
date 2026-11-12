# offbox

Sends heavy agent work (test suites, installs, builds, Docker) to the home offbox
server (`server/`, once `server/bootstrap.zsh <ip> client` has written
`~/.local/share/offbox/server.json`) or to boat.dev VMs (always, until then, and as
the standby while home is down) instead of the Mac, and runs light Go checks
locally in a macOS sandbox.

| Path here | Live copy |
| --- | --- |
| `skill/` | `~/.config/opencode/skills/remote-compute/` (the `remote-compute` skill, `offbox` CLI, classifier, monitor, box templates) |
| `plugin/offbox-gate.ts` | `~/.config/opencode/plugin/offbox-gate.ts` (OpenCode shell gate, loads at OpenCode start) |
| `bin/boat` | `~/.local/bin/boat` (boat CLI wrapper, signs in from Keychain `boat-api`/`ardud`) |
| `launchd/com.ardud.offbox-monitor.plist` | `~/Library/LaunchAgents/` (load monitor + reaper) |
| `launchd/com.ardud.offbox-home-monitor.plist` | `~/Library/LaunchAgents/` (home server health check, every minute: `skill/scripts/home_monitor.py tick`) |
| (link) | `~/.local/bin/offbox` -> `skill/scripts/offbox.py` in the live skill |

State stays outside the repo: `~/.local/share/offbox/` (offbox.db for Boat,
offbox-home.db for the home server, logs, backups, `server.json`,
`backend-state.json`), gate mode `~/.config/opencode/offbox-gate.json`, boat token under
`~/Library/Application Support/ascii/boat/`.

`skill/scripts/blockers/` goes first on every agent shell's PATH. Besides the
`docker` guard it holds `wacli`, `himalaya` and `himalaya-heal`, which refuse
raw sends so agents go through `wa` and `mailsend` (robob-watch helpers). Those
send right away and keep a sent record; they don't wait for Abdullah's OK.
Reads and drafts pass through.

## Two monitors

`com.ardud.offbox-home-monitor` watches the home server (`server/home/`) and is a second LaunchAgent on
purpose. The load monitor is a KeepAlive loop that samples the Mac every 10 s, with its own lock and its
spend/reap jobs. The home check is a one-shot every 60 s (`StartInterval`, no KeepAlive): it cannot pile up
(launchd folds intervals missed during sleep into one run, and a tick that finds `home-monitor.lock` held exits
at once), the loop cannot starve it, and a crash in one never stops the other. It shares no code with the loop.

Each tick asks `GET <server.json url>/health` (4 s, no token) and whether the Mac itself is online (tailnet
up, internet reachable). Two failed checks in a row with the Mac online mean down; three good checks in a row
mean up again. A failure while the Mac is offline, or on the first tick after a gap of more than 150 s (sleep,
reboot), counts for nothing, and so does a check less than 30 s after the last one (a manual run next to
the scheduled one). The verdict goes to `~/.local/share/offbox/backend-state.json`, which the offbox
client reads on every run (down: runs go to Boat). Once per outage it starts a repair agent in its own Robob
thread (Fable 5.2, standard mode, through the control API with the `offbox` component credential; runbook:
`server/home/REPAIR-RUNBOOK.md`) and sends one Telegram. An outage that starts within 30 minutes of the last
alert or recovery is the same outage: same thread, no second Telegram. A later outage reuses the thread if it
is still open. On recovery the thread is told, Telegram is not. "Up but degraded" (a dead disk) is one
Telegram per set of reasons per day, no thread. All thresholds are constants at the top of `home_monitor.py`.

Until `bootstrap.zsh` writes `server.json` (or while it says `"disabled": true`) a tick does nothing: no
network, no files. `home_monitor.py tick --dry-run` (or `OFFBOX_HOME_MONITOR_DRY_RUN=1`) checks and records
state but starts no thread and sends nothing, and prints what it would have done; `home_monitor.py status`
prints the state. Events are in `~/.local/share/offbox/home-monitor.log`.

## Changing it

This tree is the source of truth. Every change is committed and pushed to
`origin main` before it goes live; `install.zsh` refuses unpushed changes.

```bash
cd integrations/offbox/skill/scripts
# OFFBOX_STATE_DIR: the suite must not read this Mac's server.json / backend-state.json
OFFBOX_STATE_DIR=$(mktemp -d) python3 -m unittest discover -s tests -p 'test_*.py'   # ~5 min
python3 ../../tests/test_boatd.py                      # the server (boatd): reconcile, tokens, queue, retention
OFFBOX_RULES=../heavy-rules.json python3 classify.py --test
(cd tests && unset BUN_INSPECT && bun test classify.test.ts gate-plugin.test.ts)
cd ../.. && git commit ... && git push origin HEAD:main
./install.zsh --dry-run && ./install.zsh               # or: integrations/deploy.zsh offbox
./install.zsh --check                                   # live copy == repo, HEAD on origin
```

`install.zsh` restarts the monitor LaunchAgent and loads the home monitor (reloading it when its plist
changed). A gate plugin change only takes effect after an OpenCode restart, which needs Abdullah's go.
