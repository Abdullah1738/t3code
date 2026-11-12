# Money cases

One place for open money cases (refunds, disputes, failed or unexpected charges, debts and payment deadlines), so none of them is dropped. Each case is one row: amount, currency, merchant, reference, state, next action, deadline and who acts. The `money-cases` watcher wakes the owner's iMessage agent when a case is due within 24 hours, once a day while it is overdue, and when a reply watcher linked to the case ends (done, expired or removed before it finished) while the case is still open. Linked watchers must exist when they are added. Moving a deadline, even back to an earlier date, or reopening a case re-arms its pings. No pings go out from 23:00 to 08:00 Dubai; the check holds them until 08:00.

The code lives here. The cases live in `~/Documents/assistant/money-cases/cases.json` (mode 600), never in git.

The check stops itself at 40 seconds, below the runner's 60-second timeout; `pings.json` records phase times, lookup and owner-query counts, msgs calls and the slowest phase in `timing`, also printed to stderr for runs over 20 seconds or when the final save times out (the previous pings file stays intact and no event is emitted). Timing in pings is sampled after the data fsync; stderr timing also includes the final timing-footer flush. The check uses null stdin for msgs and dumps a traceback and exits at 48 seconds if normal deadline handling cannot interrupt a hung C call (`MONEY_CASES_HARD_STOP` overrides this interval for subprocess tests). It reads Robob's server-owned read replica `readonly/state.sqlite`, never the live statev2 database.

## Use

```sh
money-cases add acme-refund --merchant Acme --amount 120.50 --currency AED \
  --reference "order 1234" --state "refund asked, no reply yet" \
  --next "card dispute" --deadline 2026-10-25 --who Abdullah --watcher acme-refund-reply
money-cases list [--all] [--json]
money-cases show ID
money-cases update ID --state "..." --next "..." --deadline 2026-10-28 --source mail:abc --because "Acme agreed to Wed" [--add-watcher ID] [--note "..."]
# deadline changes need --source (evidence) or --reply (his reply id); --because alone is refused
money-cases update ID --state "..." --reply msg-9001      # his answer: restarts the two-day clock
money-cases add boat-sms --merchant boat.dev --amount 25 --currency USD --charged 2026-10-25 --repeat boat-mail ...
# the SMS is the same charge: a note goes on boat-mail, no second case
money-cases corroborate boat-mail --merchant boat.dev --amount 25 --currency USD --charged 2026-10-25 --observation "SMS 10:45"
# same, recorded without adding a case; refused if the charge does not match exactly
money-cases add careem-2792 --unmatched --amount 90.30 --currency AED --charged 2026-10-25 --kind charge \
  --state "charge on 2792, merchant not matched" --next "hold for Moni" --deadline 2026-10-28 --who Moni
# --unmatched records merchant "unmatched"; an unmatched charge is never named or matched to a guess
money-cases add pre-auth-x --merchant Acme --amount 90.30 --currency AED --kind hold ...
money-cases close pre-auth-x --outcome "dropped off"   # a hold is recorded as "released", not "refunded"
money-cases close ID --outcome "refund landed 27 Oct"
money-cases reopen ID --deadline 2026-11-01 --note "..."
money-cases card-dead 5542 --note "cancelled 30 Oct, replaced by 2342"
money-cases cards      # list dead cards
money-cases brief      # one line for the morning brief, nothing when no case is open
```

A deadline is a date (meaning 09:00 Dubai that day) or an ISO time. Every open case needs one. Setting a new deadline re-arms the ping. Every change is kept in the case's `history`.

Rules added 2026-10-30 (money-cases fixes, card #10):
- **No self-moved deadlines.** A deadline change needs `--source mail:<id>`, `sms:<id>`, `imessage:<id>`, `statement:<path>#<line>`, or `--reply` (his reply id). `--because` is an optional reason and cannot move a deadline alone. The source is kept in the history text and its `source` field; it can also be recorded without a deadline change. Only his reply counts as an owner answer.
- **One reminder a case a day.** A second reminder the same day is held until the next day.
- **One yes/no after two silent days.** The clock starts at the first reminder delivered after his last answer, not at case creation, so a case that was never reminded is never asked about. After two days with no answer the check sends one yes/no and then stays quiet until he answers. An answer is a `close`, a `reopen`, or an update with `--reply` (his reply id). A `--because` reason is recorded but is not an answer, so a process that moves a deadline leaves the case quiet.
- **Charges are never merged or split silently.** A new charge with the same merchant, amount, currency, day and kind as a recorded one is refused, and the refusal names the candidate. The caller decides: `--repeat ID` if it is the same charge (seen again, a note is added to that case), or `--distinct` if it is a second transaction. Free-form references such as "email 09:13" describe where a charge was seen, so they never tell two charges apart. An unmatched charge is never a candidate.
- **Build once, acknowledge delivery separately.** Event keys and the case’s daily cap are recorded in `built` before the check prints an event; they suppress another build even if the runner never accepts or acknowledges it. Existing outbox keys migrate on the first check. Delivery still controls the reminder clock: The runner acks a run before it delivers the event and may retry it later or the next day. A reminder is recorded as sent, and it counts toward the one-a-day cap and starts the two-day clock, only when the runner's `state.json` confirms delivery (`fires` rose and `last_fire_at` is the delivery time). An event the runner owns stays pending; a lost event releases the outbox, while its keys remain consumed.
- **Holds.** A pre-auth hold (`--kind hold`) that drops off is closed as `released`, not `refunded`.
- **No guesses.** A charge whose merchant or order can't be matched is `unmatched`, never named by a guess.

## Renewals on dead cards

`card-dead LAST4 --note "..."` records a cancelled card in `cards.json` next to the case book; `cards` lists it. Non-dry `card-swap --old OLD --new NEW [--also STALE]` also marks the old and stale cards dead, even without `--case`. Case text still changes only for explicit `--case` picks. `--dry-run` writes neither book.

Inbox triage opens a charge case when a renewal notice names a dead card, one amount with USD/$/AED/EUR/GBP, and an explicit date with a year (ISO, day/month/year, or a named month). A last-4 ending or masked card is required. The case records the renewal date, the source message ID and the action to move the subscription to a live card or cancel it. The same merchant and renewal date create one case, including after closure. Live cards and incomplete or ambiguous notices stay with ordinary triage. No payment or subscription change happens automatically.

Generic plan or billing labels use the sender's identity. Email fallback retains the full domain so shared display names and mail subdomains cannot merge vendors; long case slugs include a hash. Body merchant names are used when they agree with the supplied sender, or when no sender was supplied. Cancellation wording stays with ordinary triage. A standalone “will be charged” notice also needs subscription, membership, recurring-service or product-tier plan context.

The case keeps the original renewal date and exact mailbox identity separately from its readable name. Later wording changes reuse that case, including after closure or a deadline update. An SMS merchant can match one unique mailbox-domain label in either arrival order; the first corroborating email binds its mailbox identity and records the source without reopening it. Ambiguous matches stay in ordinary triage. If distinct identities share a readable slug, a hash of the exact identity distinguishes their case IDs.

## Bank payment deadlines

Inbox triage records bank repayment/failure notices as `payment_deadline` cases and scheduled card payments as `autopay_expected`, using the notice time in Dubai. Wio, ENBD, Mashreq, ADCB, FAB and Amex are supported. A bank sender and one unambiguous currency/amount are required; promotions and merchant purchase declines are excluded. `before midnight` means 23:59 that day. A date or “tonight/today” without a clock means 23:59; a failure with no readable deadline stays with normal triage for full-message review. The automatic due+3h fallback applies only to an already scheduled autopay.

One institution/amount/currency/deadline is one case, including mail/SMS copies and replays. The check looks for a bank success confirmation at due+1h, with at most 6 seconds total and 4 seconds per lookup from its existing 40-second budget. Without confirmation it opens an unconfirmed payment deadline, using the bank's stated repayment deadline or due+3h. A later bank deadline supersedes that fallback. Lookup time is separate from the reserved case-save budget, so a slow archive cannot skip reminder generation. Archive errors leave the payment unconfirmed and are recorded in pings; they do not establish that the debit failed.

The initial payment alert and reminders go alone through the existing outbox: once on detection, once 60–75 minutes before the deadline (the watcher's 15-minute cadence), then at most once at/after it. The usual one-per-day/third-question flow does not apply to these two reminders. Existing 23:00–08:00 quiet hours still apply, so a midnight deadline gets its first reminder before quiet hours and its final reminder in the morning. Payment deadlines come first in `brief`. Bank payment-received/autopay-success notices close matching rows; `money-cases close ID --outcome paid` (or `done`) is the existing chat-confirmation path and closes the related autopay row too. Closed cases are never reopened by replays.

## Charge questions

Before anyone asks him about a card charge (owner rule, nightly review 24 Oct; his words that day: "Wait for the email"), `money-cases ask` decides whether to ask:

```sh
money-cases charge "ALERT TEXT" --sender EmiratesNBD --at 2026-10-23T23:47:00+04:00   # what explains it, reads only
money-cases ask "ALERT TEXT" --sender EmiratesNBD --at ... --said "Is the Acme charge yours?"
money-cases ask --id q-1a2b3c4d --said "..."      # a question the check raised
money-cases answered q-1a2b3c4d --note "his order"
money-cases questions [--all] [--json]
```

`charges.py` reads ENBD, Emirates Islamic, ADCB, Wio and Mashreq charge and decline alerts. A charge is explained by a receipt mail that shows the amount as money in the charge's currency and reads as a receipt or order, and either names the merchant (from two hours before the alert on) or shows the card's last four digits within 15 minutes of it. Something he typed in his own Robob threads within 30 minutes of it also explains it when one statement names the merchant and says he paid, ordered or owns it (and any amount in it is the charge's), unless the message denies, questions or hedges it. Only his typing counts: app turns, and iMessage turns that relay a real inbound message; scheduled runs, notifications, watcher and bridge wakes, coord and crw turns never do. A merchant that mailed him receipts before, or a pending hold from a merchant his bank alerts show, waits up to 36 hours for the receipt. Declines on his cards go to him. `ask` needs the alert's own time (`--at`) so the same alert stays one question; it exits 0 and counts the ask only when he should be asked, allows one re-ask 24 hours later, and a third ask instead opens a money case. Exit 3 says why not. Exit 4 prints `UNVERIFIED: source <name> unreadable` for each failed source and does not count an ask. `answered` on a question that became a case notes his answer on the case and leaves it open.

Owner-thread evidence comes from the server-owned
`~/.robob/userdata/readonly/state.sqlite` replica. `MONEY_CASES_STATE_DB` overrides
shared `ROBOB_READONLY_DB`. A missing, incomplete or >120-second-old export is a
failed lookup, never evidence that he said nothing, and never falls back to the
live writer. Symlink and hardlink aliases of the writer are refused too.

Inbox triage runs every card alert it sees through the same checks before its classifier, holds a fresh charge alert for five minutes in case its receipt comes with it, and sends every charge nothing explains on to the agent even when the classifier skips it. The SMS and the bank's mail copy of one charge are one question; two alerts of the same amount on the same channel are two. The check follows open questions each run, least recently checked first: it closes them when a receipt lands (and says so once if he was asked), raises a wait that ran out once, turns a question asked twice and unanswered for 12 hours, or open for a week, into a money case, and keeps looking for 30 days after that, closing a case nobody has touched when the receipt comes. Questions live in `questions.json` next to the cases. Runs outside the live watcher (`robob-watch test`, other `WATCH_DIR`s) work on a copy of the case, question and dead-card books in their own folder.

## Install or update

From this directory run `/usr/bin/python3 -B install.py`. It copies the named source files into `~/.local/share/robob-watch/watchers/money-cases/`, links `~/.local/bin/money-cases` to the live `cases.py` and registers `watcher.json` (paused while it holds `check.lock`, resumed afterwards). It keeps the case data, `pings.json`, the lock inode and the live pause state and session. Until the resume succeeds, the intended pause state is kept in `.install-paused`, so a rerun finishes a failed resume; `install.lock` keeps a second install out until the first has resumed. No service restart is needed.

This package lives under `checks/` because `integrations/deploy.zsh robob-watch` excludes the live `watchers/` tree.

## How a ping is delivered

The check commits event keys in `built` and its outbox before printing. `sent` records confirmed delivery and starts the two-day reminder clock. An owned pending event stays with the runner; an event it never accepted is dropped without repeating its keys. Unrelated new keys can then proceed. Only keys that fit in the 4,000-character event are consumed. Question transition keys remain consumed for good; current case-cycle keys remain while the case is open. Closing a charge case also closes its linked question, and the check repairs old uncascaded closures. A question and its charge case share one event line.

`settings.json` contains the card-owner map, used by the CLI, brief, check and inbox-triage gate. Card 2792 belongs to Moni. Her unexplained charges remain tagged `owner: moni`; they do not appear in the default owner lists or become owner questions. Receipt/order matches still settle them. `--all` is available for explicit inspection. A new charge after a merchant's case was closed as card changed/dead reopens that case once.

Before an unexplained noon or Careem charge can become an ask, `order_lookup.py` runs the installed app-api read paths in a bounded subprocess. An exact amount, currency and timezone-aware placement time within 15 minutes explains the charge; multiple matching orders or incomplete/unavailable reads block asking. Noon uses native lists plus exact order details. Verified rows survive a later lane failure or the detail/time bound, with `complete: false`; a missing match still blocks an ask. The reader inherits the caller’s remaining budget, reserving time to return those rows. Careem's list reader currently refuses with an unverified host binding, so an unmatched Careem alert fails closed. There is no login, phone, purchase or messaging fallback. The noon detail projection's `placed_at` field must ship with the app-api-cli change in the same rollout. `MONEY_CASES_APP_API` can select an isolated reader installation; `MONEY_CASES_SETTINGS` can select an isolated settings file.

Card numbers and labelled codes or passwords (`OTP code 482913`, `OTP is 482 913`, `password: ...`) are refused when a case is written and redacted from anything the check or CLI prints, including `show` and `list --json`.

## Verify

```sh
/usr/bin/python3 -B -m unittest -v test_accuracy.py test_cases.py test_charges.py test_install.py
unset BUN_INSPECT
robob-watch test money-cases
```
