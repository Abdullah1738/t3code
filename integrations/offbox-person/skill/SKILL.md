---
name: offbox-person
description: Use for any login, sign-up, account, cookie or browser task for someone other than Abdullah (currently Moni), and for any build, script or project done for her. Runs her browser and her work on her own offbox VM so none of her data touches Abdullah's Mac.
---

# offbox-person

One offbox lease per person. Her logins, cookies, browser profile, secrets, files,
and anything built or run for her live on her box under `~/person/`. The Mac holds
only a tiny state file (tunnel and SOCKS pids, local ports) under
`~/.local/share/offbox-person/state/`.

## When to use

- Any login, sign-up, account, OTP or cookie work for Moni (or any non-owner person).
- Any code, script, project or file work done for her. It runs on her box, not the Mac.
- Preference notes about her (what she likes, habits, routines) are NOT box data. They
  go in the life wiki on the Mac as usual (`life-wiki` skill).

## Rules

- Never use Dia, the owner's Keychain, or the owner's browser profiles for her accounts.
- Never create or run her working data on the Mac. Build and run it with `offbox-person run`.
- Never copy her data (profile, cookies, secrets, files, outputs) to the Mac, the wiki,
  or the owner's repos. Only results she asked for go back to chat.
- Don't put credentials in chat. Store them with `offbox-person secret set`, read them with
  `offbox-person secret get` only inside the box where they're needed.
- Stop the box when the task is done: `offbox-person down <person>`. Keep it warm only while a
  task needs it.
- `~/.local/share/offbox-person/<person>/config.json` is the only Mac-side file and is optional:
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
