# Money cases

One place for open money cases (refunds, disputes, failed or unexpected charges, debts), so none of them is dropped. Each case is one row: amount, currency, merchant, reference, state, next action, deadline and who acts. The `money-cases` watcher wakes the owner's iMessage agent when a case is due within 24 hours, once a day while it is overdue, and when a reply watcher linked to the case ends (done, expired or removed before it finished) while the case is still open. Linked watchers must exist when they are added. Moving a deadline, even back to an earlier date, or reopening a case re-arms its pings. No pings go out from 23:00 to 08:00 Dubai; the check holds them until 08:00.

The code lives here. The cases live in `~/Documents/assistant/money-cases/cases.json` (mode 600), never in git.

## Use

```sh
money-cases add acme-refund --merchant Acme --amount 120.50 --currency AED \
  --reference "order 1234" --state "refund asked, no reply yet" \
  --next "card dispute" --deadline 2026-10-25 --who Abdullah --watcher acme-refund-reply
money-cases list [--all] [--json]
money-cases show ID
money-cases update ID --state "..." --next "..." --deadline 2026-10-28 [--add-watcher ID] [--note "..."]
money-cases close ID --outcome "refund landed 27 Oct"
money-cases reopen ID --deadline 2026-11-01 --note "..."
money-cases brief      # one line for the morning brief, nothing when no case is open
```

A deadline is a date (meaning 09:00 Dubai that day) or an ISO time. Every open case needs one. Setting a new deadline re-arms the ping. Every change is kept in the case's `history`.

## Install or update

From this directory run `/usr/bin/python3 -B install.py`. It copies the named source files into `~/.local/share/robob-watch/watchers/money-cases/`, links `~/.local/bin/money-cases` to the live `cases.py` and registers `watcher.json` (paused while it holds `check.lock`, resumed afterwards). It keeps the case data, `pings.json`, the lock inode and the live pause state and session. Until the resume succeeds, the intended pause state is kept in `.install-paused`, so a rerun finishes a failed resume; `install.lock` keeps a second install out until the first has resumed. No service restart is needed.

This package lives under `checks/` because `integrations/deploy.zsh robob-watch` excludes the live `watchers/` tree.

## How a ping is delivered

The check notes what each event covered in `pings.json` before printing it. The runner's `.run-ok` (or a higher `fires` count in its `state.json`, for a runner that delivered but died before writing `.run-ok`) acknowledges it, and only then are those cases recorded as sent. An event the runner never took is rebuilt from the book on the next run, so it respects quiet hours and drops closed or moved cases. One event stays under 4,000 characters as the runner counts them (it clips at 6,000), with every field clipped; pings that don't fit, even from a single case, follow on the next check and only what was shown counts as sent. A busy `check.lock` exits 75, so the runner keeps its last acknowledgement. The watcher's `quiet` window (23:00-08:00 Dubai) also makes the runner hold an event it couldn't deliver before 23:00 until morning. Sent keys are kept 60 days, except the one-time pings of a case that is still open on the same deadline and reopen cycle, so a reply watcher's ending is never raised twice.

Card numbers and labelled codes or passwords (`OTP code 482913`, `OTP is 482 913`, `password: ...`) are refused when a case is written and redacted from anything the check or CLI prints, including `show` and `list --json`.

## Verify

```sh
/usr/bin/python3 -B -m unittest -v test_cases.py test_install.py
unset BUN_INSPECT
robob-watch test money-cases
```
