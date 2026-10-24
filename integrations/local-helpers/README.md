# local-helpers

Small scripts that live under `~/.local` instead of a service directory: the
mail OAuth heal and OTP watcher, the shared link-preview helper and the quick
card builder. Edit them here, then install.

| Source | Installed as | Used by |
| --- | --- | --- |
| `libexec/mail/` | `~/.local/libexec/mail/` | `himalaya-heal`, `mailsearch`, otp watchers, message-archive (`MAIL_LIBEXEC`) |
| `libexec/card-preview/` | `~/.local/libexec/card-preview/` | ride cards (`RIDE_CARD_PREVIEW_LIB`), coordinated-project daily cards |
| `libexec/qcard/` | `~/.local/libexec/qcard/` | `qcard` |
| `bin/` | `~/.local/bin/` | agents and skills |
| `launchd/` | `~/Library/LaunchAgents/` | `local.ardud.otp-watch`, `local.ardud.otp-idle`, `local.ardud.mail-token-refresh` |

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
loaded. A plist reload or `otp-idle` restart that a failed run didn't get to
is kept as a marker in `~/.local/state/local-helpers` and done by the next run;
a plist's marker names the backup launchd was running, so the run that does the
reload can still go back to it. If a marker doesn't name one (an older
installer's empty marker), the running job is left alone and the run says how
to reload it by hand. Only one install runs at a time (a lock in the
same folder; a second run waits up to 5 minutes, `--check` waits too).
The smoke check parses every Python file, imports the libraries from their
installed path, runs `qcard templates` and `uber --version` under a bare
`PATH`, and lints the plists. `--check` also reports missing links, wrong
modes (the `uber` wrapper too), unloaded agents and pending reloads or
restarts.

Tokens, passwords, cached IPs, OTP state and generated pages stay outside the
repo: Keychain, `~/.local/state/{mail-oauth,otp-watch}`, `~/.cache`,
`~/.local/share/imessage-apps`.

The delivery card builder that used to live in `~/.local/libexec/delivery-card`
is retired; delivery cards come from `app-api-cli/delivery_cards.py`.

Tests: `/usr/bin/python3 -m unittest discover -s tests` (each test runs the
installer from a throwaway git copy of this package, with a temp `HOME` and a
fake `launchctl`).
