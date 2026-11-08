# local-helpers

Small scripts that live under `~/.local` instead of a service directory: the
mail OAuth heal and OTP watcher, the shared link-preview helper, the quick
card builder, the MacBook power alerts and the Juno proxy. Edit them here,
then install.

| Source | Installed as | Used by |
| --- | --- | --- |
| `libexec/mail/` | `~/.local/libexec/mail/` | `himalaya-heal`, `mailsearch`, otp watchers, message-archive (`MAIL_LIBEXEC`) |
| `libexec/card-preview/` | `~/.local/libexec/card-preview/` | ride cards (`RIDE_CARD_PREVIEW_LIB`), coordinated-project daily cards |
| `libexec/qcard/` | `~/.local/libexec/qcard/` | `qcard` |
| `juno-proxy/` | `~/.local/share/juno-proxy/` | `com.abdullah.juno-proxy`: HTTP/CONNECT proxy and `/proxy.pac` on the Tailscale IP, port 8118, so tailnet devices reach Juno hosts through this Mac's VPN |
| `lydia-ticks/` | `~/.local/share/lydia-ticks/` | `com.ardud.lydia-ticks-server` (Bun, 127.0.0.1:18820: saves each tick on Lydia's checklist and serves the per-day history page) and `com.ardud.lydia-ticks-tunnel` (Cloudflare tunnel for https://lydia.abdullah.fund). `tunnel.json` (tunnel credentials), `history-token` (the private history link) and `ticks.db*` (Lydia's data) stay live-only, never in the repo |
| `bin/` | `~/.local/bin/` | agents and skills; `power-unplug-telegram.sh` and `battery-low-telegram.sh` for the power agents; `cards-tunnel`, `cards-health` and `cards-tunnel-setup` for the card links; `opencode-web` for the emergency OpenCode web UI; `rclaude` for an interactive Claude Code launched like Robob's claudeAgent threads (pinned harness binary, `~/.robob/harness-homes/claude`, 9router env and model/effort from `~/.robob/userdata/settings.json`; `rclaude --rclaude-print` shows the resolved command) |
| `launchd/` | `~/Library/LaunchAgents/` | `local.ardud.otp-watch`, `local.ardud.otp-idle`, `local.ardud.mail-token-refresh`, `com.abdullah.juno-proxy`, `com.ardud.power-unplug-telegram` (Telegram when the MacBook is unplugged or plugged back in, every 20s), `com.ardud.battery-low-telegram` (Telegram every 5 min on battery at 20% or less), `com.ardud.cards-tunnel` (the named Cloudflare tunnel for cards.abdullah.fund), `com.ardud.cards-health` (every 5 min: restarts the tunnel when the public link stops answering, Telegram after two misses and when it's back), `com.ardud.lydia-ticks-server` and `com.ardud.lydia-ticks-tunnel` (see `lydia-ticks/` above; code changes restart them), `com.ardud.opencode-web` (always-on `opencode serve` on 127.0.0.1:4096, the emergency web UI at https://opencode.tail, independent of Robob and the OpenCode service; waits for a hand-started copy on the port to exit instead of killing it) |

`install.zsh` also keeps two links in `~/.local/bin`: `wa` and `mailsend`
point at the deployed robob-watch helpers (deploy robob-watch first). It
writes `~/.local/bin/uber` as a small wrapper that runs the newest nvm
node's `@crafter/uber-cli` with that node's absolute path, so ride watchers
with a short `PATH` still run it. It never replaces an `uber` file it didn't
write.

```bash
./install.zsh --check      # does the live copy match this commit?
./install.zsh --dry-run    # what would change
./install.zsh              # install, reload changed agents, smoke check
```

It installs the git-tracked files only (ignored caches never ship) and refuses
uncommitted or unpushed work (`--allow-unpushed` is for tests). Each file gets
its fixed mode (`kc-read`, `kc-write` and `otp-watch.py` stay 700). Every
replaced file keeps a `<file>.bak-<timestamp>` copy next to it (never
overwriting an older one), so a bad install rolls back with a `mv`. Changed plists are reloaded; a plist that won't load is
restored from its backup. Every run also loads any managed agent that isn't
loaded. `otp-idle` and the Juno proxy keep running, so new code for them
restarts that agent (`kickstart -k`). A plist reload or restart that a failed run didn't get to
is kept as a marker in `~/.local/state/local-helpers` and done by the next run;
a plist's marker names the backup launchd was running, so the run that does the
reload can still go back to it. If a marker doesn't name one (an older
installer's empty marker), the running job is left alone and the run says how
to reload it by hand. Only one install runs at a time (a lock in the
same folder; a second run waits up to 5 minutes, `--check` waits too).
The smoke check parses every Python file, imports the libraries from their
installed path, runs `qcard templates` and `uber --version` under a bare
`PATH`, checks the shell scripts' syntax and lints the plists. `--check` also reports missing links, wrong
modes (the `uber` wrapper too), unloaded agents and pending reloads or
restarts.

Tokens, passwords, cached IPs, OTP state and generated pages stay outside the
repo: Keychain, `~/.local/state/{mail-oauth,otp-watch}`, `~/.cache`,
`~/.local/share/imessage-apps`.

The delivery card builder that used to live in `~/.local/libexec/delivery-card`
is retired; delivery cards come from `app-api-cli/delivery_cards.py`.

`~/.local/bin/power-unplug-telegram.sh --test` sends one test alert without
changing the saved power state (`~/.local/state/power-source`). A change whose
alert couldn't be sent waits in `power-source.pending` and is retried every run
with the same Telegram key and text (the bridge only dedupes an identical resend).
Nothing is sent unless that file was written.

Tests: `/usr/bin/python3 -m unittest discover -s tests` (each install test runs
the installer from a throwaway git copy of this package, with a temp `HOME` and
a fake `launchctl`; the power alert tests use a fake `pmset` and notifier).

Card links: the spectrum bridge serves every `share` at `https://cards.abdullah.fund/s/<token>/` from
127.0.0.1:18793 (its config.json `shareOrigin`). `cards-tunnel` runs the named Cloudflare tunnel that forwards
there; both agents idle until the tunnel exists. One time, after Abdullah ran `cloudflared tunnel login` and
picked abdullah.fund: `~/.local/bin/cards-tunnel-setup` creates the tunnel (credentials in
`~/.cloudflared/cards-tunnel.json`, never in this repo), points the DNS name at it and starts it.

`robob-read-watchdog` probes `t3ctl threads --active --limit 5` with a 10-second
request deadline every 30 seconds. After three minutes of failed reads it sends
one Telegram alert, then one recovery when reads work again. It clears the
incident quietly while Robob is closed or `tmux -L restart` has the
`robob-restart` session. State and stderr live in
`~/.local/state/robob-read-watchdog/`.

After approval, run `integrations/local-helpers/install.zsh` from the merged,
pushed checkout (it installs and loads the agent). If it needs loading manually:
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ardud.robob-read-watchdog.plist`.
Unload with `launchctl bootout gui/$(id -u)/com.ardud.robob-read-watchdog`.

Installers can call `robob-read-watchdog --sustain 300 --every 30 --give-up 1800`
to require five minutes of consecutive healthy reads. Any failed probe resets
the healthy window; timeout exits 1. This mode sends no notifications and uses
no watchdog state. `ROBOB_WD_PROBE`, `ROBOB_WD_NOTIFY`, `ROBOB_WD_APP_RUNNING`,
`ROBOB_WD_RESTARTING` and `ROBOB_WD_SLEEP` accept replacement commands;
`ROBOB_WD_STATE` overrides the state directory. `ROBOB_WD_NOW` accepts epoch
seconds or a command returning epoch seconds for an advancing test clock.
