---
name: offbox-person
description: Use for any login, sign-up, account, cookie or browser task for someone other than Abdullah (currently Moni), and for any build, script or project done for her. Runs her browser and her work on her own box on the home offbox server so none of her data touches Abdullah's Mac.
---

# offbox-person

This version of the skill applies once her box lives on the home offbox server (go-live moves it there).

One offbox lease per person. Her logins, cookies, browser profile, secrets, files,
and anything built or run for her live on her box under `~/person/`, and stay there. The Mac
holds only small state files (tunnel and SOCKS pids, local ports, tunnel logs) under
`~/.local/share/offbox-person/state/`. There is no copy or backup of her data on the Mac, on
Dropbox or on Boat (see "Her data stays on the box").

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
  or the owner's repos. Only results she asked for go back to chat. There is no exception:
  backups are snapshots on the server itself, not copies.
- Abdullah has full access to her box (owner, 2026-10-21): use it for him whenever he asks,
  no need to check with her first.
- Don't put credentials in chat. Store them with `offbox-person secret set`, read them with
  `offbox-person secret get` only inside the box where they're needed.
- Stop the box when the task is done: `offbox-person down <person>`. Keep it warm only while a
  task needs it. A stopped box costs nothing and is kept.
- Her work never goes to Boat. If the home server is down, her task waits (exit 93 below); don't
  move it to another backend, the Mac or Dia to get it done.
- `~/.local/share/offbox-person/<person>/config.json` is the only Mac-side setting and is optional:
  `{"home": false}` (use the box's own connection, the home line in Dubai), `{"proxy": "..."}` (another
  proxy), `{"locale": "..."}` (browser language, default `en-US`). Change it only when the owner says so.

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
- Home route: her browser leaves through this Mac's internet connection, not the box's own.
  `up` starts `offbox-person-socks` on this Mac (127.0.0.1 only) and `offbox ports 1055 --reverse`
  exposes it on her box as `socks5://127.0.0.1:1055`. The SOCKS server refuses loopback, LAN,
  tailnet/CGNAT, link-local and multicast destinations, so her pages can't reach the Mac or tailnet.
  Timezone follows the exit IP. If the route is down the browser has no internet: that is intended,
  it never falls back to the box's own connection. apt/pip and `offbox-person run` on the box go
  out directly, over the home line.
  The route was built when her box was in an EU datacenter. Her box is now at home in Dubai, so with
  the Mac at home both ways leave through the same home line, and the server's firewall already keeps
  boxes off the LAN, the tailnet and the host. With the Mac away, her browser exits wherever the Mac
  is. `{"home": false}` makes the browser use the box's own connection; that switch is the owner's call.
- agent-browser on the Mac reaches CDP through an `offbox ports 9242` tunnel. A live tunnel keeps
  the lease warm. If the tunnels die the box auto-stops after its idle window; the next command
  (or `up`) brings everything back.
- Every offbox call runs as thread `person:<person>` with a pool of one box and `--no-fallback
  --remote`. A failed box call never re-runs on the Mac. The offbox client picks her API token by
  itself; never pass, read or print a token.
- `down` and `save` close the browser first so her cookies are flushed to disk, then stop the
  tunnels and the SOCKS server by the pids in the state file.
- Exit codes: `run` returns her command's own exit. 90 = her box didn't start (try again in a few
  minutes). 93 = the home offbox server is down or unreachable: nothing ran, nothing was sent to
  Boat, her tasks wait until it is back. It is not retried; say so to whoever asked and try later.
  94 = her command was interrupted by a server restart and was not re-run. Check what it already
  did, then run it again only if that is safe (never blindly for a send, a payment or a form
  submit). `down` still cleans up the Mac side before it reports 93.

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

- Exit 90 means her box didn't start and exit 93 that the home server is down; neither says anything about
  WhatsApp. 'offline (not linked)', 'not linked yet', or 'not linked' from link-status indicate a not-linked
  state. Read commands are retried once after a 90; nothing is retried after a 93 or a 94.
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

- Load, not cost: at home her box has no hourly price, and a stopped box costs nothing and is kept. Every
  `wa` call or watcher run touches the lease and keeps the box running for another idle window, so a watcher
  at a short interval keeps it on all the time, using memory on the home server that builds also need. With
  a longer interval it stops between runs, but a reply can wait that long. While the box is stopped, her
  phone holds the new messages and hands them over on the next resume (offline sync), so nothing is lost,
  only delayed. Pick the interval for the job, give watchers a short expiry, and don't run an always-on
  watcher for her without a reason she gave. The owner's `msgs` doesn't index her WhatsApp, on purpose; use
  `wa search` on her box.
- While the home server is down, the watcher check exits 93: a failed run, never a new message. robob-watch
  retries, alerts once after 5 failures in a row (and wakes the watcher's chat once after 15 min of failing),
  and catches up when the server is back (her phone held the messages). If you are woken for that, there is
  nothing to repair on the Mac; don't move the watcher anywhere else.
- Linked devices are dropped by WhatsApp after about 30 days without connecting, and a stopped box doesn't
  connect. The box is pinned (never deleted) and offbox starts a pinned box that has been stopped for 12
  days, but if `wa status` says `not linked` or the events show `logged_out`, re-link as above.
- Her WhatsApp store (session keys and messages) lives only on her box and is covered by its snapshots like
  the rest of her home.

## Her data stays on the box

Owner decision (Nov 2026): "we dont need to snapshot any of moni's offbox data locally, it can all stay on
device." The old Mac job (`offbox-person-backup`: restic repo on the Mac, Dropbox mirror) is retired and
`install.zsh` removes its LaunchAgent.

- Where it lives: her box is a container on the home offbox server (boatd on Incus/ZFS, at home in Dubai),
  owner `moni`. offbox reaches it with her own API token (Keychain service `offbox-server-api`, account
  `moni`), which sees only her boxes.
- What protects it: the pool is a ZFS mirror on two NVMe disks. Every run ends with a snapshot, and her box
  also gets hourly, daily and weekly snapshots. Kept: 48 hourly, 30 daily, 12 weekly, plus the newest 20
  per-run snapshots and one per day for 14 days. A monthly scrub checks both disks. The numbers have one
  source, `DEFAULTS["retention"]` in `integrations/offbox/server/boatd.py`; read them there if in doubt.
- What there is not, on purpose: a copy on the Mac, on Dropbox or on Boat. The snapshots cover a bad change,
  a deleted file and one dead disk, and they live on the same server. Don't pull her files to the Mac or
  anywhere else "to be safe", and don't set up another backup unless Abdullah asks.
- Restoring a file: done on the server from a snapshot, by Abdullah or an agent he asks. A snapshot is an
  Incus snapshot of her container. To see them (read-only), on the server: `incus snapshot list <container>`
  (`python3 /opt/boatd/boatd.py box list` as root shows which container is hers). The restored file stays on
  her box.
- Server down: her tasks wait. `offbox-person` exits 93 and nothing runs; person work is never sent to Boat.
- Interrupted run: a server restart during her command gives exit 94. Her commands are never re-run
  automatically, because a second login, send or payment can do harm.
- Leftovers of the old backup on the Mac (`~/.local/share/offbox-person/restic/`, its Keychain password
  `restic-offbox-person`, Dropbox `/Backups/offbox-person/`, `state/*backup*` files) are Abdullah's to
  delete. Don't read, restore from or add to them.
- Tests: `python3 tests/test_offbox_person.py` and `python3 tests/test_socks.py` (fake offbox, no real box).
