---
name: offbox-person
description: Use for any login, sign-up, account, cookie or browser task for someone other than Abdullah (currently Moni), and for any build, script or project done for her. Runs her browser and her work on her own offbox VM so none of her data touches Abdullah's Mac.
---

# offbox-person

One offbox lease per person. Her logins, cookies, browser profile, secrets, files,
and anything built or run for her live on her box under `~/person/`. The Mac holds
only small state files (tunnel and SOCKS pids, local ports, backup status) under
`~/.local/share/offbox-person/state/` and the encrypted backup repo (see Backups).

## When to use

- Any login, sign-up, account, OTP or cookie work for Moni (or any non-owner person).
- Any code, script, project or file work done for her. It runs on her box, not the Mac.
- Notes and documents about her (preferences, routines, health notes, ID papers, insurance,
  form profiles) are NOT box data. They go in the life wiki on the Mac (`life-wiki` skill,
  IDs under `documents/moni/`). Owner rule 2026-10-21. Box data is her logins, cookies,
  accounts, mail access, working files and any database or tool built for her.

## Rules

- Never use Dia, the owner's Keychain, or the owner's browser profiles for her accounts.
- Never create or run her working data on the Mac. Build and run it with `offbox-person run`.
- Never copy her box data (profile, cookies, secrets, files, outputs) to the Mac, the wiki,
  or the owner's repos. Only results she asked for go back to chat. The encrypted Dropbox
  backup below is the one exception.
- Abdullah has full access to her box (owner, 2026-10-21): use it for him whenever he asks,
  no need to check with her first.
- Don't put credentials in chat. Store them with `offbox-person secret set`, read them with
  `offbox-person secret get` only inside the box where they're needed.
- Stop the box when the task is done: `offbox-person down <person>`. Keep it warm only while a
  task needs it.
- `~/.local/share/offbox-person/<person>/config.json` is the only Mac-side setting and is optional:
  `{"home": false}` (use the box's own EU IP), `{"proxy": "..."}` (another proxy), `{"locale": "..."}`
  (browser language, default `en-US`). Change it only when the owner says so.

## Commands

```bash
offbox-person up <person>                          # ensure box, desktop, browser, home route; prints local CDP port
offbox-person browser <person> -- <agent-browser args>
offbox-person cua <person> <tool> ['<json>']        # cua-driver call on her box's desktop
offbox-person shot <person>                        # desktop screenshot -> $TMPDIR/offbox-person/<person>/*.png
offbox-person run <person> -- <cmd ...>            # runs in ~/person/work on the box
offbox-person secret set <person> <name>           # value on stdin
offbox-person secret get|rm <person> <name>
offbox-person secret list <person>
offbox-person save <person>                        # closes browser, saves a default base, pins it; box stops
offbox-person down <person>                        # close browser, tunnels and home route, release the lease
offbox-person backup <person> [--force]            # back up the latest snapshot to Dropbox now
offbox-person list
```

Browser work goes through `offbox-person browser` (agent-browser over CDP):

```bash
offbox-person browser moni -- open https://example.com
offbox-person browser moni -- snapshot -i
```

Use `cua` only for what the CDP route can't do: native dialogs, file pickers, sites that block
automation, or non-browser GUI apps on her box. Follow the `cua-driver` skill (observe, act with a
fresh `element_token`, verify); look at the desktop with `shot`:

```bash
offbox-person cua moni list_windows
offbox-person cua moni get_window_state '{"pid": 1234, "window_id": 5678}'
offbox-person shot moni                            # then read the printed PNG path
```

Screenshots are transient: `down` deletes `$TMPDIR/offbox-person/<person>/`. Don't copy them elsewhere.

## How it works (what to know)

- Her box runs one desktop: Xvfb `:99` (1440x900), openbox, a D-Bus session bus with AT-SPI, the
  `cua-driver serve` daemon (telemetry off) and CloakBrowser (headed, CDP `127.0.0.1:9242`,
  accessibility tree on). `~/person/session.sh` starts whatever is missing; `~/person/session.env`
  holds `DISPLAY` and the bus address. Logs: `~/person/{xvfb,dbus,atspi,wm,cua,browser}.log` on the box.
- Home route: her browser leaves through the owner's home connection (Dubai), not the box's EU IP.
  `up` starts `offbox-person-socks` on this Mac (127.0.0.1 only) and `offbox ports 1055 --reverse`
  exposes it on her box as `socks5://127.0.0.1:1055`. The SOCKS server refuses loopback, LAN,
  tailnet/CGNAT, link-local and multicast destinations, so her pages can't reach the Mac or tailnet.
  Timezone follows the exit IP. If the route is down the browser has no internet: that is intended,
  it never falls back to the EU IP. apt/pip and `offbox-person run` on the box go out directly.
- agent-browser on the Mac reaches CDP through an `offbox ports 9242` tunnel. A live tunnel keeps
  the lease warm. If the tunnels die the box auto-stops after its idle window; the next command
  (or `up`) brings everything back.
- Every offbox call runs as thread `person:<person>` with a pool of one box and `--no-fallback
  --remote`. A failed box call never re-runs on the Mac.
- `down` and `save` close the browser first so her cookies are flushed to disk, then stop the
  tunnels and the SOCKS server by the pids in the state file.

## On her box (Moni)

- Wiki: read-only clone of the life wiki at `~/person/wiki` (GitHub deploy key
  `moni-box-wiki-readonly`, private key `~/person/secrets/wiki_deploy`). Refresh it before
  reading: `offbox-person run moni -- 'cd ~/person/wiki && git pull -q'`. It can't push; edit the
  wiki on the Mac.
- Her Gmail lives only on her box (moved off the Mac 2026-10-21): himalaya account `moni`
  (default), `~/person/bin/{himalaya,ortie}`, OAuth token in `~/person/secrets/ortie-moni.json`
  (ortie refreshes it itself). The owner may read her mail any time through the box:
  `offbox-person run moni -- 'himalaya envelope list -m INBOX -s 20 --json'`,
  `offbox-person run moni -- 'himalaya message read -m INBOX <id>'`. Same himalaya syntax as
  the `agent-mail` skill. Send only with the owner's or her OK on the exact draft.
- Her working files: `~/person/files/` (for example `moni-spending-2026-09/`, her bank statement work).

## Backups (Dropbox)

`offbox-person-backup <person>|--all` backs up her box home from its latest boat snapshot:
- Skips when the content snapshot id is the one last backed up (`--force` overrides).
- Pulls the home minus reinstallable runtimes and caches (`.cloakbrowser`, `.cua-driver`, caches,
  `go/pkg`, `person/venv`, `person/wiki`) onto a fresh encrypted, case-sensitive disk image mounted at
  `~/.local/share/offbox-person/stage/<person>`. Its key exists only in the running script; the image is
  detached and deleted at the end of every run (also on failure or TERM), and a run killed outright
  leaves only ciphertext that the next run deletes. `person/bin` (her himalaya and ortie) is backed up
  because `box/setup.sh` doesn't reinstall it.
- Writes a restic snapshot into `~/.local/share/offbox-person/restic/<person>` (password in Keychain
  `restic-offbox-person`/`ardud`; it is the only copy of the key, Dropbox holds only ciphertext), then
  mirrors the repo to Dropbox `/Backups/offbox-person/<person>/restic` (every file hash-checked). It runs
  `restic check` first and never mirrors a damaged repo. Dropbox files are deleted only after the daily
  prune (`--delete` on the next mirror); otherwise the mirror only adds.
- Fails (never silently passes) if a listed file other than browser-profile caches/locks or Go
  telemetry is missing from the pull. Every boat/offbox/restic/Dropbox call has a timeout that kills the
  whole process group. A failed pull is retried twice from a fresh listing.
- Never replaces Dropbox history: if the Mac repo is missing but a backup was made before, or Dropbox
  already holds a repo, it stops and asks for a restore instead of starting a new repo; it won't
  mirror over a Dropbox repo with a different `config`.
- `down` and `save` start it in the background, in its own process group, once the box has stopped (it
  waits for a running backup instead of skipping). One run per person (flock on
  `state/<person>-backup.lock`). LaunchAgent `com.abdullah.offbox-person-backup` (installed by
  `integrations/offbox-person/install.zsh`) runs `--all` at login and every 6 h. It runs a copy at
  `~/.local/share/offbox-person/bin/` because launchd may not read the external drive, so re-run
  `install.zsh` after changing the script.
- Status: `~/.local/share/offbox-person/state/<person>-backup.json` (`ok`, `stage`,
  `last_success_ts`, `last_boat_snapshot`, `last_restic_snapshot`), log
  `<person>-backup-YYYYMM.log` (counts only; tool error lines that name a path are dropped). The state
  dir is mode 700. A failure or a lock stuck over 6 h sends one Telegram per stage per day. Keeps 8
  last, 14 daily, 8 weekly, 24 monthly, 5 yearly; `restic check --read-data-subset=10%` every 30 days.
- Tests: `python3 tests/test_backup.py` (real restic, fake boat/offbox/Dropbox, about 4 min) and
  `python3 tests/test_offbox_person.py`.

Restore:

```bash
export RESTIC_REPOSITORY=~/.local/share/offbox-person/restic/moni
export RESTIC_PASSWORD_COMMAND="security find-generic-password -s restic-offbox-person -a ardud -w"
restic snapshots --tag person-moni
restic restore latest --target "$TMPDIR/moni-restore" --include '*/person/files'   # or the whole snapshot
```

Copy the restored files back to her box (tar over `offbox ssh` from `~/.local/share/offbox-person/moni`
with `OFFBOX_THREAD=person:moni OFFBOX_POOL_SIZE=1`) and delete the restored copy from the Mac right
away. If the Mac repo is gone, download `/Backups/offbox-person/<person>/restic` from Dropbox to the repo
path first (`dbxcli ls -R` then `dbxcli get` file by file; a folder `get` fails). The Keychain password
is needed either way. Tested 21 Oct: a repo downloaded from Dropbox restored her files byte for byte.
