# Money cases

One place for open money cases (refunds, disputes, failed or unexpected charges, debts and payment deadlines), so none of them is dropped. Each case is one row: amount, currency, merchant, reference, state, next action, deadline and who acts. The `money-cases` watcher wakes the owner's iMessage agent when a case is due within 24 hours, once a day while it is overdue, and when a reply watcher linked to the case ends (done, expired or removed before it finished) while the case is still open. Linked watchers must exist when they are added. Moving a deadline, even back to an earlier date, or reopening a case re-arms its pings. No pings go out from 23:00 to 08:00 Dubai; the check holds them until 08:00.

The code lives here. The cases live in `~/Documents/assistant/money-cases/cases.json` (mode 600), never in git.

Orders registered with `order-watch --amount ... --card LAST4` are checked on
the first scheduled tick at least 15 minutes after placement. Missing bank
evidence opens one `charge_unconfirmed` case per order, separate from unexplained
charges. A matching bank SMS/email (merchant, card, currency, amount and placement
window) closes it, including after tracker removal. Same-amount nearby orders
remain unconfirmed when allocation is ambiguous. Archive failures retain the
unconfirmed state; they never prove a payment failed. This needs both the
app-api-cli deployment and the money-cases installer after approval.

The check stops itself at 40 seconds, below the runner's 60-second timeout; `pings.json` records phase times, lookup and owner-query counts, msgs calls and the slowest phase in `timing`, also printed to stderr for runs over 20 seconds or when the final save times out (the previous pings file stays intact and no event is emitted). Timing in pings is sampled after the data fsync; stderr timing also includes the final timing-footer flush. The check uses null stdin for msgs and dumps a traceback and exits at 48 seconds if normal deadline handling cannot interrupt a hung C call (`MONEY_CASES_HARD_STOP` overrides this interval for subprocess tests). It reads owner messages through Robob's control API.

Each check appends timing, owner-read counts/results and up to ten diagnostic errors (300 characters each) to `runs.jsonl` beside `pings.json` in the watcher directory, outside DATA. Free-form error details are omitted to keep message text and credentials out. Appends have a 40 ms budget, never fail the check, and count failures in `history_append_errors` for the process and runner stderr. A nonblocking `runs.lock` protects rotation, and the next append repairs an interrupted last line. The file rotates before exceeding 2 MiB, keeping `runs.jsonl.1`; installs preserve both. `money-cases runs --since 24h` (or `--json`, with a duration or timezone-aware ISO `--since`) reads both files and reports counts, runs over 40 seconds, p50/p95/max seconds (linearly interpolated percentiles), slowest phases, owner results and grouped errors. Corrupt lines are counted and skipped. Budget and iCloud skips are recorded; a hard stop in a hung C call cannot safely append Python diagnostics.

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
money-cases brief      # one line for the morning brief, including closed cases with running watchers
```

A deadline is a date (meaning 09:00 Dubai that day) or an ISO time. Every open case needs one. Setting a new deadline re-arms the ping. Every change is kept in the case's `history`.

Use `add --due DATE` to record the real due date separately from the follow-up deadline. `update --due DATE` needs `--because TEXT` or `--reply ID`. The brief sorts and judges overdue cases by due when set and shows the follow-up date too; cases without due use deadline. Pings still follow deadline.

Rules added 2026-10-30 (money-cases fixes, card #10):
- **No self-moved deadlines.** A deadline change needs `--source mail:<id>`, `sms:<id>`, `imessage:<id>`, `statement:<path>#<line>`, or `--reply` (his reply id). `--because` is an optional reason and cannot move a deadline alone. The source is kept in the history text and its `source` field; it can also be recorded without a deadline change. Only his reply counts as an owner answer.
- **One reminder a case a day.** A second reminder the same day is held until the next day.
- **One yes/no after two silent days.** The clock starts at the first reminder delivered after his last answer, not at case creation, so a case that was never reminded is never asked about. After two days with no answer the check sends one yes/no and then stays quiet until he answers. An answer is a `close`, a `reopen`, or an update with `--reply` (his reply id). A `--because` reason is recorded but is not an answer, so a process that moves a deadline leaves the case quiet.
- **Charges are never merged or split silently.** A new charge with the same merchant, amount, currency, day and kind as a recorded one is refused, and the refusal names the candidate. The caller decides: `--repeat ID` if it is the same charge (seen again, a note is added to that case), or `--distinct` if it is a second transaction. Free-form references such as "email 09:13" describe where a charge was seen, so they never tell two charges apart. An unmatched charge is never a candidate.
- **Build once, acknowledge delivery separately.** Event keys and the case’s daily cap are recorded in `built` before the check prints an event; they suppress another build even if the runner never accepts or acknowledges it. Existing outbox keys migrate on the first check. Delivery still controls the reminder clock: The runner acks a run before it delivers the event and may retry it later or the next day. A reminder is recorded as sent, and it counts toward the one-a-day cap and starts the two-day clock, only when the runner's `state.json` confirms delivery (`fires` rose and `last_fire_at` is the delivery time). An event the runner owns stays pending; a lost event releases the outbox, while its keys remain consumed.
- **Holds.** A pre-auth hold (`--kind hold`) that drops off is closed as `released`, not `refunded`.
- A merchant mail after the case's last edit saying a refund was processed holds the dispute deadline until mail time + 7 days (or the existing later deadline) and tells him once; any negation in the merchant's own text blocks the hold.
- A hold requires a direct completed-refund statement; questions, confirmation requests, and future or conditional processing do not qualify. Ambiguous proof-led wording keeps the existing deadline. Past approval timing before or after the confirmation, or a later card-credit estimate, does not cancel completed evidence. A trailing receipt or help question can be ignored after an affirmative statement.
- **No guesses.** A charge whose merchant or order can't be matched is `unmatched`, never named by a guess.

## Saved merchant cards

The scheduled check reads `card-status merchant dead --json` (requires the matching app-api-cli
install). It keeps one saved-card case per merchant, closes it once no cancelled/declined card is
saved, and reopens it if a dead card returns. Manually closed unchanged cases stay closed. An
unavailable or invalid registry leaves existing cases unchanged and records a check error. These
cases have no amount or currency: no charge has happened. The brief includes the saved-card reason
and a known next charge date. Unknown dates use the observation day's action deadline; they never
invent a renewal date. The existing watcher handles reminders; no new notifier is installed.

## Renewals on dead cards

`card-dead LAST4 --note "..."` records a cancelled card in `cards.json` next to the case book; `cards` lists it. Non-dry `card-swap --old OLD --new NEW [--also STALE]` also marks the old and stale cards dead, even without `--case`. Case text still changes only for explicit `--case` picks. `--dry-run` writes neither book.

`money-cases subs add ID --merchant NAME [--last4 1234] [--amount 5 --currency USD] [--cadence monthly|yearly] [--next-renewal YYYY-MM-DD] [--account EMAIL] [--status active]` adds a subscription. Unknown fields may be blank. Use `subs list`, `subs due --days 3`, `subs edit ID` with the same flags, and `subs remove ID`; status also accepts `needs card update` and `cancelled`. Only card endings and account labels belong here, never credentials.

Renewal notices learn entries in `subscriptions.json` beside the case book, including notices on live cards. Cadence is learned only when the notice says monthly or yearly; fill missing fields with `subs edit`. A charge is explained only by one matching active entry: the same merchant, card and currency, amount within 5%, and date within three days. Declines and pending holds always keep their existing checks. Matching in triage or the ask gate advances the next date once, preserving month-end dates. The read-only `charge` command and dry triage do not advance it.

Marking a card dead through the CLI also searches the last 60 days of bank alerts. Repeat merchants and registered subscriptions on that card are flagged `needs card update` and get one case each. Cross-channel copies do not count as repeat purchases. Repetition alone does not establish a renewal date or cadence: the case asks to confirm these. Re-running a failed sweep is safe by repeating `card-dead`. No merchant settings change. The check gives one heads-up per merchant and renewal date within three days when the card is dead or the entry needs an update; normal quiet hours and delivery bookkeeping apply.

Inbox triage opens a charge case when a renewal notice names a dead card, one amount with USD/$/AED/EUR/GBP, and an explicit date with a year (ISO, day/month/year, or a named month). A last-4 ending or masked card is required. The case records the renewal date, the source message ID and the action to move the subscription to a live card or cancel it. The same merchant and renewal date create one case, including after closure. Live cards and incomplete or ambiguous notices stay with ordinary triage. No payment or subscription change happens automatically.

Generic plan or billing labels use the sender's identity. Email fallback retains the full domain so shared display names and mail subdomains cannot merge vendors; long case slugs include a hash. Body merchant names are used when they agree with the supplied sender, or when no sender was supplied. An explicitly cancelled or disabled renewal stays with ordinary triage; cancellation instructions, conditional consequences and cancelled-card notices do not suppress an upcoming renewal. A standalone “will be charged” notice also needs subscription, membership, recurring-service or product-tier plan context.

No-charge wording bounded by “until” or “before” the billing date describes when charging starts and preserves the stated renewal. Unqualified no-charge statements and explicit cancellation or disabled-renewal states still prevent automatic case creation.

The case keeps the original renewal date and exact mailbox identity separately from its readable name. Later wording changes reuse that case, including after closure or a deadline update. An SMS merchant can match one unique mailbox-domain label in either arrival order; the first corroborating email binds its mailbox identity and records the source without reopening it. Ambiguous matches stay in ordinary triage. If distinct identities share a readable slug, a hash of the exact identity distinguishes their case IDs.

## Bank payment deadlines

Inbox triage records bank repayment/failure notices as `payment_deadline` cases and scheduled card payments as `autopay_expected`, using the notice time in Dubai. Wio, ENBD, Mashreq, ADCB, FAB and Amex are supported. A bank sender and one unambiguous currency/amount are required; promotions and merchant purchase declines are excluded. `before midnight` means 23:59 that day. A date or “tonight/today” without a clock means 23:59; a failure with no readable deadline stays with normal triage for full-message review. The automatic due+3h fallback applies only to an already scheduled autopay.

One institution/amount/currency/deadline is one case, including mail/SMS copies and replays. The check looks for a bank success confirmation at due+1h, with at most 6 seconds total and 4 seconds per lookup from its existing 40-second budget. Without confirmation it opens an unconfirmed payment deadline, using the bank's stated repayment deadline or due+3h. A later bank deadline supersedes that fallback. Lookup time is separate from the reserved case-save budget, so a slow archive cannot skip reminder generation. Archive errors leave the payment unconfirmed and are recorded in pings; they do not establish that the debit failed.

The initial payment alert and reminders go alone through the existing outbox: once on detection, once 60–75 minutes before the deadline (the watcher's 15-minute cadence), then at most once at/after it. The usual one-per-day/third-question flow does not apply to these two reminders. Existing 23:00–08:00 quiet hours still apply, so a midnight deadline gets its first reminder before quiet hours and its final reminder in the morning. Payment deadlines come first in `brief`. Bank payment-received/autopay-success notices close matching rows; `money-cases close ID --outcome paid --source sms:<id>` (or `done`, with its source) is the existing chat-confirmation path and closes the related autopay row too. Closed cases are never reopened by replays.

## Charge questions

- A decline closes as paid after decline when a charge with the same card, merchant, currency and amount follows within 60 minutes.

Before anyone asks him about a card charge (owner rule, nightly review 24 Oct; his words that day: "Wait for the email"), `money-cases ask` decides whether to ask:

```sh
money-cases charge "ALERT TEXT" --sender EmiratesNBD --at 2026-10-23T23:47:00+04:00   # what explains it, reads only
money-cases ask "ALERT TEXT" --sender EmiratesNBD --at ... --said "Is the Acme charge yours?"
money-cases ask --id q-1a2b3c4d --said "..."      # a question the check raised
money-cases answered q-1a2b3c4d --note "his order"
money-cases questions [--all] [--json]
```

`charges.py` reads ENBD, Emirates Islamic, ADCB, Wio and Mashreq charge and decline alerts. A charge is normally explained by a receipt mail that shows the amount as money in the charge's currency and reads as a receipt or order, and either names the merchant (from two hours before through 36 hours after the alert) or shows the card's last four digits within 15 minutes of it. Something he typed in his own Robob threads within 30 minutes of it also explains it when one statement names the merchant and says he paid, ordered or owns it (and any amount in it is the charge's), unless the message denies, questions or hedges it. Only his typing counts: app turns, and iMessage turns that relay a real inbound message; scheduled runs, notifications, watcher and bridge wakes, coord and crw turns never do. A merchant that mailed him receipts before, or a pending hold from a merchant his bank alerts show, waits up to 36 hours for the receipt. Declines on his cards go to him. `ask` needs the alert's own time (`--at`) so the same alert stays one question; it exits 0 and counts the ask only when he should be asked, allows one re-ask 24 hours later, and a third ask instead opens a money case. Exit 3 says why not. Exit 4 prints `UNVERIFIED: source <name> unreadable` for each failed source and does not count an ask. `answered` on a question that became a case notes his answer on the case and leaves it open.

Uber pending holds can match a receipt from Uber within two hours: its total, or its total before an explicit wait-time fee, within 1% capped at AED 1. Boat and Browser Use AED charges can match a branded USD receipt's amount paid at the AED peg plus up to 4% bank markup. A receipt compatible with another charge stays ambiguous, including when the amounts differ.

Owner-thread evidence comes from Robob's control API, using
`T3_CONTROL_TOKEN_FILE`, the watchers component credential, or
`~/.robob/ardud-control.json`. The server must supply message provenance
(`automated` and `inboundMessageId`); an older server or a failed/timed-out
lookup supplies no owner evidence and records a lookup error. There is no
SQLite fallback. The per-check union-window fetch runs before receipt and order
lookups in `follow()`, capped at ten seconds of the remaining check budget and
three seconds per request. `timing.owner_queries` counts HTTP requests;
`owner_result` reports complete coverage (`ok`), a partial refresh (`incomplete`),
or a failed thread listing (`list_failed`). Partial refreshes save cache progress
and supply no owner evidence.

Inbox triage runs every card alert it sees through the same checks before its classifier, holds a fresh charge alert for five minutes in case its receipt comes with it, and sends every charge nothing explains on to the agent even when the classifier skips it. The SMS and the bank's mail copy of one charge are one question; two alerts of the same amount on the same channel are two. The check follows open questions each run, least recently checked first: it closes them when a receipt lands (and says so once if he was asked), routes expired waits to the daily list and retains asked questions as awaiting_answer without an age cutoff. Older linked money cases still accept receipt matches, closing a case nobody has touched when the receipt comes. Asked questions have no age cutoff. A receipt compatible with multiple distinct charge questions stays ambiguous; a historical receipt found later still counts when its timestamp uniquely matches the original charge window. Questions live in `questions.json` next to the cases. Runs outside the live watcher (`robob-watch test`, other `WATCH_DIR`s) work on a copy of the case, question and dead-card books in their own folder.

## Install or update

`money-cases health` reads the current UTC day's run history without changing case
state. Use `--day YYYY-MM-DD` for another UTC day, `--json` for JSON only, or
`--one-line` for a compact daily result. `toollog rollup --board orders --day
YYYY-MM-DD` includes that result and prints its one-line summary when available.
History retention is bounded; an old day may no longer be present.

Receipt coverage counts charge questions in the follow walk, excluding those
resolved by existing order, subscription, purchase or shared evidence. Unattempted
is eligible minus the existing receipt outcome counters. A run interrupted before
the question census has unknown coverage; old history is also unknown. Budget stop
reasons identify the last observed constraint, with the whole-check deadline taking
precedence. Call counts measure merchant registry reads, bank-evidence lookups for
registered orders, and charge-question evaluations. Load samples are the host's
1/5/15-minute load averages; unavailable samples stay null.

Marketplace coverage comes from `marketplace-placements.json`, refreshed outside the check's budget. To prime it after installation, run the installed reader with the account-reader Python:

```sh
~/.local/share/uv/tools/mitmproxy/bin/python -I -B ~/.local/share/robob-watch/watchers/money-cases/order_lookup.py refresh-marketplace --data ~/Documents/assistant/money-cases --budget 180
```

The command prints counts and a result. `end_of_history` means the full cursor chain and every placement were read. Checks launch a detached refresh once the snapshot is ten minutes old; simultaneous refreshes exit `busy`. An incomplete snapshot cannot prove absence. A charge whose match window ends after the snapshot's walk began stays limited as `marketplace_stale`; a placement near an order not proven delivered stays limited as `marketplace_hold`.

From this directory run `/usr/bin/python3 -B install.py`. It copies the named source files into `~/.local/share/robob-watch/watchers/money-cases/`, links `~/.local/bin/money-cases` to the live `cases.py` and registers `watcher.json` (paused while it holds `check.lock`, resumed afterwards). It keeps the case data, `pings.json`, the lock inode and the live pause state and session. Until the resume succeeds, the intended pause state is kept in `.install-paused`, so a rerun finishes a failed resume; `install.lock` keeps a second install out until the first has resumed. No service restart is needed.

This package lives under `checks/` because `integrations/deploy.zsh robob-watch` excludes the live `watchers/` tree.

## How a ping is delivered

The check commits event keys in `built` and its outbox before printing. `sent` records confirmed delivery and starts the two-day reminder clock. An owned pending event stays with the runner; an event it never accepted is dropped without repeating its keys. Unrelated new keys can then proceed. Only keys that fit in the 4,000-character event are consumed. Question transition keys remain consumed for good; current case-cycle keys remain while the case is open. Closing a charge case also closes its linked question, and the check repairs old uncascaded closures. A question and its charge case share one event line.

`settings.json` contains the card-owner map, used by the CLI, brief, check and inbox-triage gate. Card 2792 belongs to Moni. Her unexplained charges remain tagged `owner: moni`; they do not appear in the default owner lists or become owner questions. Receipt/order matches still settle them. `--all` is available for explicit inspection. A new charge after a merchant's case was closed as card changed/dead reopens that case once.

Before an unexplained noon or Careem charge can become an ask, `order_lookup.py` runs the installed app-api read paths in a bounded subprocess. An exact amount, currency and timezone-aware placement time within 15 minutes explains the charge; multiple matching orders or incomplete/unavailable reads block asking. Noon uses native lists plus exact order details. Verified rows survive a later lane failure or the detail/time bound, with `complete: false`; a missing match still blocks an ask. The reader inherits the caller’s remaining budget, reserving time to return those rows. Careem's list reader currently refuses with an unverified host binding, so an unmatched Careem alert fails closed. There is no login, phone, purchase or messaging fallback. The noon detail projection's `placed_at` field must ship with the app-api-cli change in the same rollout. `MONEY_CASES_APP_API` can select an isolated reader installation; `MONEY_CASES_SETTINGS` can select an isolated settings file.

Card numbers and labelled codes or passwords (`OTP code 482913`, `OTP is 482 913`, `password: ...`) are refused when a case is written and redacted from anything the check or CLI prints, including `show` and `list --json`.

## Verify

```sh
ROBOB_TEST=1 /usr/bin/python3 -B -m unittest -v test_accuracy.py test_cases.py test_charges.py test_install.py
unset BUN_INSPECT
robob-watch test money-cases
```


## Unanswered charges and purchase notes

`questions`, `list`, `show` and `brief` retain asked charges as `awaiting_answer` until an answer or a sourced closure. `answered QID --note ...` records the answer; `close ID --outcome ... --source mail:<id>|sms:<id>|imessage:<id>|statement:<path>#<line>` closes a waiting case with evidence. Never-asked charges older than 24 hours go through the daily list and receipt gate, even while other questions await answers. Quiet hours and the check budget apply.

Overdue bills still bypass unanswered questions. Their alert includes the latest recorded statement balance less later posted credits for that card, including closed refund cases. Promised refunds are excluded. Repeated or corroborating events retain an OVERDUE state and a separate history line.

At payment time, record a delegated purchase:

```sh
money-cases note-purchase --merchant MERCHANT --amount AMOUNT --currency CUR \
  --card LAST4 --asked-by owner --thread THREAD_ID [--invoice INVOICE_ID]
```

Use `--asked-by moni` for her purchases. This records the request, not a payment or a ledger entry. The charge matcher (including inbox triage) checks merchant, exact amount/currency, last four digits and a 15-minute payment window before external lookups. Once matched, the note cannot explain a separate later charge. Purchase notes stay in the private case book, outside git.

## Daily unasked list

The check records an Abdullah-owned charge as an `unmatched` case once it is at least two hours old and still has verdict `ask`. It stores `case_opened` on the question and opens only one case per card ending, amount, currency and alert time. Receipt waits, explained charges, unreadable sources, declines and Moni's charges do not open one. This records the case without asking him: the linked question keeps its original alert time for the daily list, and the case adds no separate prompt while it awaits his answer.

The first non-quiet check each Dubai day raises one daily list when unasked charges older than 24 hours remain. Awaiting answers do not hold it. Run `money-cases unasked` (or `--json`) to inspect candidates without writing; add `--all` to see excluded items and their reasons; on the daily event, run `money-cases unasked --ask` and send its output as one message, never individual asks.

The command screens receipts, orders, purchase notes and subscriptions before listing each charge, oldest first, then summarizes explanations it settled. Listed charges become `awaiting_answer`; reruns cannot list them again. Moni's charges stay held. Failed screens rotate behind untouched items so later charges get checked. Unreadable or unscreened items stay for a later run: the command has a 40-second total budget and a 6-second limit per item. Cases without a known card or charge time stay held for inspection. Quiet hours, overdue bills and payment deadlines keep their existing behavior.

After installing this fix, run `money-cases migrate-legacy-asks --dry-run`, review the list, then run `money-cases migrate-legacy-asks` once. It seeds the existing ask marker on open non-bill cases from the original daily list whose current cycle started before 13 Nov 2026 04:25Z, plus four verified legacy cases. Age and receipt-wait eligibility are frozen at that cutoff. It preserves their status; historical notifications do not become pending questions. Repeating it makes no further changes. Existing asks and answered state prevent another daily first ask, including linked questions and structured owner answers.

Declined daily items retain a reason until their revision, cycle or charge evidence changes. Receipt waits resume at their expiry; timeouts and unreadable lookups can be retried. Cases without usable card evidence or a matching charge date are excluded from the daily count.

## iCloud downloads

DATA stays at `~/Documents/assistant/money-cases` (or `MONEY_CASES_DIR`).
Book and cache reads, lock opens/flocks, and atomic writes retry EDEADLK after
one bounded `brctl download` attempt. Backoffs and the download share the
remaining check/phase deadline. Interrupted I/O retries immediately at most three
times within that deadline; other I/O errors keep their existing behavior.
An unreadable dependency aborts before any further save; it is never treated as
an empty book. Temporary JSON files are renamed only after a complete write.

The runner counts **every nonzero exit**, including 75, as a failure. There is no
skip code. On EDEADLK exhaustion or a data I/O deadline, `check` prints one diagnostic line
and returns 0 with no event. It retains pings.json and its outbox. The runner
advances its acknowledgement; the next check resumes from money-cases' retained
state. The existing busy-check.lock exit 75 is unchanged. Other CLI commands
return 75 for an unavailable data file.

Each skip records `skip_streak`, `first_skip_at` / `last_skip_at` (Unix seconds),
`last_file`, `last_reason` (`edeadlk` or `deadline`), `edeadlk_retries` and `edeadlk_ms` in `data-skips.json` in WATCH_DIR,
**outside DATA**. A streak at least two hours old exits 1 to trigger the normal
failure/alert path. A clean run removes that file and records the preceding
streak and its last file, reason and first timestamp in timing. Each skipped run
also leaves its exit code, file, reason and phase in `runs.jsonl`.
Successful pings.json timing includes `edeadlk_retries`, `edeadlk_ms`,
`eintr_retries`, and a metadata-only startup `dataless_files` count (SF_DATALESS,
0x40000000). The census has a separate 100 ms budget; failure records a null count
and `dataless_error` (class and errno) without aborting or skipping the check.
Those diagnostics are allowed in check.run tool logs too.

### Keep Downloaded

Every install attempts the idempotent pin, without failing the install when
pinning fails. Run `money-cases pin` to retry, or `money-cases pin --check` for
FileProvider's pin state and current dataless count. No data path changes.

Verified on macOS 27.0.1 (26A434), 16 Nov 2026, in disposable folders under
Documents, removed afterwards:

```
xattr -w 'com.apple.fileprovider.pinned#PX' 1 <folder>
fileproviderctl evaluate <folder>
```

FileProvider processes this asynchronously. The installer waits up to eight
seconds after setting the attribute and only reports `pinned` when
`fileproviderctl evaluate` reports `isKeepDownloaded = 1;`. A repeated install
reports `already pinned` only after the same confirmation. A written xattr alone
is insufficient: the unsuffixed `com.apple.fileprovider.pinned` test did **not**
report Keep Downloaded. The pinned folder's child also reported
`isKeepDownloaded = 1;`; an unpinned control reported 0. `brctl evict <child>`
refused eviction with NSFileProviderErrorDomain -2008 and the file remained
materialized. The newly created, not-yet-uploaded control was also refused, so
that refusal alone does not establish the cause. FileProvider's affirmative
Keep Downloaded state is the verification used by the CLI and installer.
`brctl` and `fileproviderctl` help list no pin subcommand on this OS. The xattr
interface is not an Apple-supported public pin API, so failed or changed behavior
is reported, never assumed successful.

Sources: [Apple's Keep Downloaded guide](https://support.apple.com/guide/mac-help/work-with-folders-and-files-in-icloud-drive-mchl1a02d711/mac)
and [the FileProvider/xattr investigation](https://eclecticlight.co/2026/10/13/pin-files-in-icloud-drive/).
