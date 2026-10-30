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
money-cases update ID --state "..." --next "..." --deadline 2026-10-28 --because "Acme agreed to Wed" [--add-watcher ID] [--note "..."]
# a deadline change needs --because (the reason) or --reply (his reply id); it is refused otherwise and recorded in history
money-cases update ID --state "..." --reply msg-9001      # his answer: restarts the two-day clock
money-cases corroborate ID --merchant boat.dev --amount 25 --currency USD --charged 2026-10-25 --observation "SMS 10:45"
# another channel saw the same charge: counted once; refused if the charge does not match exactly
money-cases add talabat-2792 --unmatched --amount 90.30 --currency AED --charged 2026-10-25 --kind charge \
  --state "charge on 2792, merchant not matched" --next "owner: which order?" --deadline 2026-10-28 --who Abdullah
# --unmatched records merchant "unmatched"; an unmatched charge is never named or matched to a guess
money-cases add pre-auth-x --merchant Talabat --amount 90.30 --currency AED --kind hold ...
money-cases close pre-auth-x --outcome "dropped off"   # a hold is recorded as "released", not "refunded"
money-cases close ID --outcome "refund landed 27 Oct"
money-cases reopen ID --deadline 2026-11-01 --note "..."
money-cases brief      # one line for the morning brief, nothing when no case is open
```

A deadline is a date (meaning 09:00 Dubai that day) or an ISO time. Every open case needs one. Setting a new deadline re-arms the ping. Every change is kept in the case's `history`.

Rules added 2026-10-30 (money-cases fixes, card #10):
- **No self-moved deadlines.** A deadline change without `--because` or `--reply` is refused and changes nothing. The reason goes into `history`.
- **One reminder a case a day.** A second reminder the same day is held until the next day.
- **One yes/no after two silent days.** The clock starts at the first reminder delivered after his last answer, not at case creation, so a case that was never reminded is never asked about. After two days with no answer the check sends one yes/no and then stays quiet until he answers. An answer is a `close`, a `reopen`, or an update with `--reply` (his reply id). A `--because` reason is recorded but is not an answer, so a process that moves a deadline leaves the case quiet.
- **Charges are not merged by the check.** A second charge with the same merchant, amount, currency, day and kind is refused by `add` unless its reference differs (then it is a second transaction). To record that another channel saw the same charge, use `corroborate`, which only succeeds on an exact match. Two real same-day equal-value charges with different references both stay. A charge still `unmatched` is never merged.
- **Holds.** A pre-auth hold (`--kind hold`) that drops off is closed as `released`, not `refunded`.
- **No guesses.** A charge whose merchant or order can't be matched is `unmatched`, never named by a guess.

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
