---
name: offbox-person
description: Use for any login, sign-up, account, cookie or browser task for someone other than Abdullah (currently Moni), and for any build, script or project done for her. Runs her browser and her work on her own offbox VM so none of her data touches Abdullah's Mac.
---

# offbox-person

One offbox lease per person. Her logins, cookies, browser profile, secrets, files,
and anything built or run for her live on her box under `~/person/`. The Mac holds
only a tiny state file (box name, tunnel pid, local port) under
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
- Bring the owner's Mac-side config only when a task needs it: `~/.local/share/offbox-person/<person>/config.json`
  is the only Mac-side file, and only holds the optional `{"proxy": "..."}` setting.

## Commands

```bash
offbox-person up <person>                          # ensure box, CDP launcher, tunnel; prints local CDP port
offbox-person browser <person> -- <agent-browser args>
offbox-person run <person> -- <cmd ...>            # runs in ~/person/work on the box
offbox-person secret set <person> <name>           # value on stdin
offbox-person secret get|rm <person> <name>
offbox-person secret list <person>
offbox-person save <person>                        # keep a default base warm, pinned
offbox-person down <person>                        # close tunnel, release the lease
offbox-person list
```

Browser example:

```bash
offbox-person browser moni -- open https://example.com
offbox-person browser moni -- snapshot -i
```

## How it works (what to know)

- The browser is CloakBrowser, headed under Xvfb, started detached on the box with
  `setsid nohup` so it survives the end of the `offbox run` that started it. It listens
  on CDP `127.0.0.1:9242`.
- agent-browser on the Mac reaches it through an `offbox ports 9242` tunnel. A live tunnel
  keeps the lease warm (it touches the lease and holds the auto-stop TTL). If the tunnel
  dies, the box auto-stops after its idle window; the next `offbox-person up` brings it back.
- Every offbox call runs with `--no-fallback --remote`. A failed box call never re-runs on
  the Mac.
- Proxy is off by default. The owner chooses how her traffic exits (home IP via Tailscale
  exit node, or a UAE ISP proxy); set it in `config.json` only when told to.
- Use `offbox-person down` to close the tunnel first; it kills the tunnel child before releasing.
