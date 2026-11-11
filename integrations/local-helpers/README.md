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

## Quint

`bin/quint` installs as `~/.local/bin/quint`. Run bounded `quint verify` on
the Mac, rather than offbox. The wrapper checks `java -version` for Java 21+
in `QUINT_JAVA_HOME` (an invalid explicit override fails), Homebrew's
`/opt/homebrew/opt/openjdk`, then `/usr/libexec/java_home -v '21+'`.
Install a missing JDK with `brew install openjdk`. It finds the real CLI via
`QUINT_BIN`, PATH (skipping itself and symlinks to itself), then
`~/.nvm/versions/node/v26.2.0/bin/quint`; the CLI's directory supplies node
on short agent PATHs. Missing CLI: `npm i -g @informalsystems/quint@0.33.1`.

Verify without `--server-endpoint` gets a free local port. Explicit endpoints
must name a free `localhost:<port>` or `127.0.0.1:<port>`; the wrapper starts its
own server there and never attaches to an existing server. Other commands pass
through. `QUINT_APALACHE_ARCHIVE` selects the reviewed archive (default
`~/.local/share/apalache-patched/apalache-0.62.4-grpc-1.75.0.tgz`); a missing or
mismatched archive/JAR fails before starting Java. Each verify uses a private
temporary distribution and `QUINT_HOME`, with a refusing fallback launcher and
the pinned JAR available to TLC. Quint-side launch/download attempts fail even
if Quint exits zero. The wrapper stops only its own server and CLI PIDs on
completion or signals. Port ownership is checked with `lsof` before Quint runs.

CVE-2022-3171 affects stock grpc-services 1.41.0's pre-22 reflection gencode, despite its protobuf-java 3.25.8 runtime; #787 aligns gRPC to 1.75.0 and regenerates with 3.25.8.
The guard pins archive SHA256 `b4fc81998dd20d0b55a48c16d1caed1045e324bbbfe45ee7f625f6aaf70caf6f` and JAR `cb6a7d689b2937b00be5e7e30e9bb1925cde7c8ce47aaafddb1cf21c8c167593`, always setting `error_on_unsafe_pre22_gencode=true`; unsafe JVM overrides and ambiguous backslash/whitespace spellings are refused.
Apalache still binds IPv6 `*:<port>` with reflection registered: LAN/tailnet peers can reach it for the run's duration. The Mac firewall was disabled (block-all disabled, stealth off) on 12 Nov; a loopback source patch is a separate follow-up.
`QUINT_ALLOW_VULNERABLE_APALACHE=1` explicitly bypasses this guard with a visible warning, permitting Quint's original cache/download/launch behavior; it never silences the protobuf warning.
Upstream Apalache 0.63.0 still has no dependency fix (#787's 11 Nov check); issue filing and all installations remain owner-approved evaluator actions.

Use `command -v quint` to confirm the wrapper is selected: harness PATHs put
nvm before `~/.local/bin`. Until approved PATH changes and installation, call
the checkout's `integrations/local-helpers/bin/quint` explicitly. The shared
`~/.quint` cache is untouched. Offbox has no installed wrapper or pinned
archive from this change; shipping both and fixing PATH is a separate task.

Offbox investigation (9 Nov 2026, crpko-devops pool `bx_2vtg2veh`, three
remote calls including one pre-command failure): Quint 0.33.1 downloads
`https://github.com/apalache-mc/apalache/releases/download/v0.62.4/apalache.tgz`
without checking the HTTP status before tar extraction. `curl -sSIL` and
Node fetch both returned **504, text/html, 92 bytes**; `file` identified HTML
starting with `<html><body><h1>504 Gateway Time-out</h1>`. This reproduces the
invalid-archive cause: GitHub's error response is passed to tar as a tgz.
It is independent of Java. Successful downloads on other boxes are consistent
with an intermittent asset failure. Use the Mac's managed cached backend;
for diagnosing a fresh download use `curl --fail --location`, then `file`
and `tar tzf` before extraction. A manual cache transfer must use the approved
patched distribution, not an unguarded stock 0.62.4 download.

The separate offbox signature `Unrecognized VM option 'G1PeriodicGCInterval'`
indicates an older JVM (Java 11 in the reports); Apalache requires Java 21+.
Run verify on the Mac for either signature. The box's apt history records
`openjdk-11-jdk` in the base image install. Offbox selects `crpko-go` for
crpko-devops (`skill/scripts/offbox_lib/lease.py`); that template doesn't
provision Java. Saved pool state explains variation: this probe had an
additional Ubuntu `openjdk-21-jre-headless` package and Java 21 selected via
`update-alternatives`; its install provenance wasn't in apt history.
Proposal only: add `openjdk-21-jdk-headless` to `skill/templates/crpko-go.sh`
and select its java alternative, then refresh the crpko-devops pool's saved
template/state. Existing saved boxes need that refresh too. No pool or
template changes are made here; prefer the Mac unless it proves insufficient.

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

`apalache/build-patched.sh` builds Apalache 0.62.4 (`7954daf7563a69cce9d0b89c8542e40bf46f7c6e`) with all gRPC modules at 1.75.0 and protobuf/protoc 3.25.8; ScalaPB stays at 0.11.20.
Rebuild on Linux/JDK 21: `offbox run --remote -- 'JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 integrations/local-helpers/apalache/build-patched.sh'` (requires git, curl, Python 3 and sha256sum).
Output: `tmp/apalache-patched-0.62.4/apalache-0.62.4-grpc-1.75.0.tgz`; SHA256 `b4fc81998dd20d0b55a48c16d1caed1045e324bbbfe45ee7f625f6aaf70caf6f`.
The recipe checks resolved dependencies and reflection bytecode, records the JAR hash, and retains v1alpha reflection for quint 0.33.1; installation and wrapper selection are separate.
Launch with `JVM_ARGS=-Dcom.google.protobuf.error_on_unsafe_pre22_gencode=true apalache/bin/apalache-mc server --port=<n>`; this version binds `*:<n>` and has no checker `--hostname` option.
As of 9 Nov 2026, upstream main has no dependency fix after 0.62.4; the upstream issue draft is on Robob card #787 and has not been filed.
