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

## Her WhatsApp (her own account, on her box; set up 31 Oct 2026)

Same design as Abdullah's `wa` on the Mac (`whatsapp` skill), but her linked device, store and service live
only on her box. Never read her chats with the owner's `wa`/`msgs` (those are HIS account), and never copy her
store or messages to the Mac; only the answer she asked for goes back to her chat.

- wacli 0.20.0 at `~/person/bin/wacli`, store `~/person/wa/store` (mode 700), systemd --user service
  `wacli-sync` (`sync --follow`, same flags as the Mac LaunchAgent, Restart=always, enabled). Lingering is on,
  so it starts on every box resume. Logs `~/person/wa/sync.events.log`. Reader `~/person/bin/wa-db` (the same
  file as robob-watch `helpers/wa-db`), wrapper `~/person/bin/wa` (Dubai times).
- From the Mac: `offbox-person wa <person> <cmd>`. A plain ssh: it resumes a stopped box (~10 s) and doesn't
  start the browser or tunnels. After a resume the first read waits up to ~25 s for WhatsApp to hand over
  what arrived while the box was off.

```bash
offbox-person wa moni status                  # online pid N | offline (linked|not linked) | linking
offbox-person wa moni chats 20                # recent chats: name (unread) | jid
offbox-person wa moni find "Ana"              # contacts -> jid | name | push name
offbox-person wa moni read 9715xxxxxxx 40     # last 40 in that chat, phone JID + LID merged
offbox-person wa moni search "passport" --after 2026-10-01 --limit 20   # FTS over all her chats
offbox-person wa moni ids <jid> 10            # message ids + media type
offbox-person wa moni download <jid> <msgid>  # -> ~/person/files/whatsapp/ on her box (send it with care)
offbox-person wa moni send <jid> "text"       # sends AS HER. Only on her own ask, exact wording she OKed
offbox-person wa moni sendfile <jid> <box-path> [caption]
offbox-person wa moni events 20               # connected / logged_out / warnings
offbox-person wa moni setup                   # (re)install wacli, wa, wa-db and the unit; idempotent
```

- Sending: it's her account. Send only what she asked for, in her words or a draft she OKed in her chat.
  Never test-send to her contacts.
- Linking or re-linking (her phone removed the device, `logged_out` in events): `offbox-person wa moni link
  <her number, digits>` prints an 8-character code. Send it to her chat as one plain line: "WhatsApp > Settings
  > Linked devices > Link a device > Link with phone number instead, then type this code: XXXX-XXXX". It is good for about 2
  minutes. The link job (transient unit `wa-link`) then pulls history and starts `wacli-sync` by itself.
  `link --qr` prints a QR payload instead (render the text as a PNG; it rotates every 20 s, so the pair code is
  easier over iMessage). `link-status` shows progress. At most two tries, then ask her when she's free.
  Her number is in `~/.config/spectrum-bridge/access.json`.
- Watchers on her WhatsApp: robob-watch on the Mac, with `--chat moni` so the fire wakes HER chat (never the
  owner's; a failed wake stays pending, there is no owner fallback). The check is
  `offbox-person-wa-new <person> <jid>`: it runs `wa new` on her box, whose cursor and outbox live in
  `~/person/wa/watch/<watcher id>` there (the runner's WATCH_RUN/.run-ok are passed along). Remove the
  watcher when done; the box-side cursor dir can stay.

```bash
robob-watch add --id moni-wa-ana --title "Ana replied on Moni's WhatsApp" --chat moni \
  --check 'offbox-person-wa-new moni 9715xxxxxxx' --interval 300 --mode wake --expires 3d --max-fires 1 \
  --session CURRENT_SESSION_ID --context "Moni asked (date) to be told when Ana replies about X. Read the chat with offbox-person wa moni read <jid>, tell Moni in one line. Never send anything from her WhatsApp."
```

- Cost (her box is `default`, $0.036/h; it stops after 10 min idle and stopped is free). Every `wa` call or
  watcher run touches the lease and keeps it up for another 10 min. No watcher: the box only runs while an
  agent uses it, about $0. A watcher at 5 min or less keeps the box on: about $0.86/day ($26/month). A
  30 min interval lets it stop between runs, roughly $0.30/day, but a reply can wait up to 30 min. While the
  box is stopped, her phone holds the new messages and hands them over on the next resume (offline sync), so
  nothing is lost, only delayed. Pick the interval for the job, give watchers a short expiry, and don't run an
  always-on watcher for her without a reason she gave. The owner's `msgs` doesn't index her WhatsApp, on
  purpose; use `wa search` on her box.
- Linked devices are dropped by WhatsApp after about 30 days without connecting. The box is pinned and boat
  resumes it at least every 12 days, but if `wa status` says `not linked` or the events show `logged_out`, re-link
  as above.
- Her WhatsApp store (session keys and messages) is in the encrypted Dropbox backup with the rest of her
  home.

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
