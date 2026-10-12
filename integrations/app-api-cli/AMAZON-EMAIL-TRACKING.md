# Amazon email tracking

`amazon_email_orders.py` is a standalone, standard-library Python CLI and an
importable email evidence adapter. It reads mail through `mailsearch`; it does
not call Amazon, open a browser/phone, change mail flags, place orders, or perform
any cancellation/return action. Importing the module performs no I/O. No local
mail cache or raw-message files are created.

## Commands

Deployment verification (2026-10-08): the frozen module and tracker glue are now
installed, with a managed `amazon-orders` launcher. Real CLI scans verified both
complete and partial behavior: `order-track` completed 20/20 body reads across
all five healthy accounts and reconciled one whole delivery. Standalone scans
with 75-second budgets had intermittent body-read timeouts (20/22 and 17/20;
the latter also reported one unavailable account), retained package proof, and
correctly returned `partially_delivered`, `whole_order_delivered:false`, exit 1.
These partial runs are not claimed successful complete scans. No raw mail was
persisted, and no website, phone, mail-flag or order mutation was used.

From this directory:

```sh
python3 -B amazon_email_orders.py orders --json
python3 -B amazon_email_orders.py track 123-1234567-1234567 --json
python3 -B amazon_email_orders.py orders --since 2026-09-23 --timeout 120 --max-reads 100 --json
# Only after discovering the relevant account; narrowing is explicit in coverage:
python3 -B amazon_email_orders.py orders --account gmail --days 14 --json
```

The parent installer exposes the same interface as `amazon-orders orders|track`.

The order ID above is synthetic. `mailsearch` must be on PATH with its existing
account configuration. Defaults are 30 days, 75 seconds overall, 150 envelope
matches per folder, and 60 body reads. Bounds: 366 days, 300 seconds, 500 envelope
matches per folder, 200 reads. `--since YYYY-MM-DD` overrides the lower date;
the search overlaps by one day for exclusive `after:` semantics/time zones.
The upper bound is two calendar days beyond the current date; future mail dates
over five minutes ahead of observation are unusable evidence.

The default first search covers **icloud, gmail, fund, outlook, juno** together.
Only matching account/folder/UIDs are subsequently read. Search is sender-based,
not exact-order fulltext: an order ID present only inside a tracking link was
missed by Gmail exact-ID search during verification. The local parser requires
an exact full order ID before creating any evidence.

Every body read uses `mailsearch read ACCOUNT FOLDER UID --raw`. The underlying
helper selects the mailbox read-only and uses `BODY.PEEK[]`; no seen flag is set.
Search has a 15-second internal budget and at most 18 seconds wall time. Up to
four body reads run concurrently with 12-second per-read timeouts; all reads
share the overall monotonic deadline. Queued reads do not start after it expires.
There is no automatic retry that extends the deadline.

Exit code 0 means the bounded scan had no reported operational errors, **not**
that an order was found or delivered. Exit 1 includes safe structured errors for
account failures/timeouts, read failures, truncation, read caps and invalid
arguments. Partial evidence survives failures but cannot close the whole order.
The helper's raw error strings are never echoed because they may contain account
data. Unknown/no evidence is a normal result, not a fabricated status.

## Evidence and completion rules

- The original RFC822 `From` address must belong to an explicit Amazon marketplace
  domain or its subdomain. Display names and substring matches are not trusted.
  This is a **domain filter, not DKIM/SPF authentication**.
- Stages come from recognized current subjects, never the body progress timeline.
  Confirmation emails contain all four labels, including “Delivered,” before
  anything has shipped. Recognized stages are `confirmed`, `shipped`,
  `out for delivery`, `delivered`, `problem`, `cancelled`, `return_requested`,
  `returned`, and `refunded`. Future/conditional/negated statements and forwarded
  messages do not become positive completion evidence.
- Order IDs can be visible or in locally decoded, domain-checked Amazon links.
  Links are never fetched or emitted. `shipmentId` is hashed; `packageIndex` is
  not a package count. Multiple order IDs can share a message or a package.
- `observed_at` is when this run read the message. `evidence_at` is the timezone-
  aware email `Date` converted to UTC, explicitly labeled `email_date_header`.
  It is **not an asserted physical arrival time**. Missing/naive/future dates
  block whole-order completion. The caller must preserve first observation if
  it wants durable first-detection times across runs.
- Delivery evidence is always shipment-scoped. A delivered package without a
  complete order manifest is `partially_delivered`, never whole-order delivered.
- A complete manifest requires the verified confirmation layout: greeting,
  `Order #`, its edit label and exact-order link, complete title/quantity/price
  triples, and an order total. Unknown item-table layouts, missing fields,
  quantity rows after the total, and partial-list markers fail closed. Two order
  sections in one confirmation yield two manifests, not two packages.
- Whole completion requires a consistent complete confirmation manifest; every
  shipment has one identity and a consistent item inventory; their quantities
  exactly cover the manifest without extras/double counting; every latest
  shipment is delivered; and the bounded scan is complete. Conflicting equal-
  time stages, shipments predating confirmation, unresolved confirmations,
  multi-order package allocation, unusable timestamps, cancellation or return
  evidence all block closure.
- Copies of the same message are deduplicated by content-aware event identity.
  The reduced event keeps the earliest `observed_at` and its original mailbox
  fields, plus a sorted, unique `mailbox_aliases` list of every observed
  `account:folder:uid` copy. Unioning these references does not change `event_id`
  or `evidence_at`, mutate input events, or add shipment quantities twice.
  Already-reduced evidence can be reduced again without losing aliases. Reused
  Message-IDs with changed content are not discarded.
- Cancellation remains `partially_cancelled` without item reconciliation.
  `return_requested` does not mean the return was received or refunded. Neither
  cancellation nor returns are marked terminal by this adapter.

Only `whole_order_delivered: true` / `terminal: true` authorizes whole-order
delivery closure. `latest_event: delivered` is not sufficient.

## Safe output and honest coverage

Output contains order IDs, hashed shipment/item/event identities, quantities,
stages, timestamps, sender domain, mailbox references, and reason/error codes.
It contains no subject, product title, body, address, raw Message-ID, private
tracking/return URL, token, or credential. MIME bodies remain in memory only.

`source` is always `amazon_email`, `email_only` is true, and `native_order_api`
is false. `coverage.complete` refers only to this bounded recognized-message
scan. It does not certify live Amazon state, all account history, or all possible
mail formats. Unsupported/localized subjects are not body-read. Deleted mail
is excluded. `mailsearch` does not enumerate silently skipped/nonselectable
folders, and cannot search the separate Moni account. Folder coverage lists
folders with returned hits, not a claim that every other folder was inspected.
An explicitly narrowed account scan is labeled `explicit_accounts`.

Current manifest support is intentionally narrow. HTML-only messages can yield
package evidence, but arbitrary HTML item-table layouts are not promoted to
complete manifests. Opaque item identity is normalized product-title text, not
a verified Amazon line-item ID. Combined packages spanning orders remain
unresolved rather than guessing allocation, including same-title products in
different orders.

## Mailbox and format verification (2026-10-08)

Initial discovery searched all five accounts. In the wider September 23 onward
window (with September 22 overlap), Gmail `[Gmail]/All Mail` returned 75 matches;
iCloud Inbox returned three broad sender-search matches; fund, outlook and juno
returned none. Some iCloud matches were unrelated sender display names and
were not accepted as Amazon evidence. Gmail was the relevant order mailbox.
English Amazon.ae mail and Amazon.co.uk package notices were observed.

Verified actual format details, with no raw production fixtures retained:

- Multipart alternative messages included useful plain text. Confirmation,
  shipped, out-for-delivery, and delivered subjects have distinct current-stage
  prefixes. One real delivered subject was `Delivered in 11 hrs 23 mins`, without
  a colon. Confirmation bodies include a four-stage progress timeline.
- The plain confirmation has one item/quantity/price table and a Total per order
  section. More than one order can occur in one confirmation.
- One combined delivery carried a visible order ID different from the order ID
  in its trusted tracking link. Shipment contents grew from dispatch to delivery;
  the reducer correctly retained partial/ambiguous status.
- Return sender display names expose a `mailsearch` legacy `parseaddr` envelope
  reconstruction bug. Filtering the reconstructed envelope dropped real returns.
  Candidate subjects are now read regardless of envelope From; trust is checked
  strictly against the original message's From header. Actual return requests
  correctly superseded otherwise delivered histories.
- Actual cancellation mail parsed as cancellation, not delivery.
- A clean recent all-account run read 20/20 candidate messages with all accounts
  healthy and no truncation. It established one single-package whole delivery,
  retained another delivered package as partial when its older confirmation was
  outside that narrower date window, and preserved return-request states.
- A wider run read 38/39 messages; one Gmail read exceeded 12 seconds. It exposed
  all corresponding package evidence and marked whole completion false because
  coverage was incomplete. A separate search also timed out. These are real
  intermittent mailbox limits, not hidden successes.
- Multi-shipment evidence was present: one order had two shipment identities and
  combined-order inventory conflicts plus a return request. No clean, completely
  reconciled multi-package delivery was established live. Full multi-package
  closure is covered by synthetic regressions, not claimed as live-verified.

Production IDs/status projections are in the implementation handoff, not saved
as fixtures. All parser fixtures use synthetic IDs/names/links and preserve only
the observed structural layouts.

## Tests and tracker integration

```sh
python3 -B -m unittest discover -s test -p test_amazon_email_orders.py -v
python3 -B -m unittest discover -s test -p test_order_tracker.py -q
python3 -B -m unittest discover -s test -p test_delivery_store.py -q
```

Reusable seams:

```python
from amazon_email_orders import parse_message, aggregate_order, orders, track

# Pure parser/reducer; safe to reuse already-fetched RFC822 mail.
events = parse_message(raw, account=account, folder=folder, uid=uid,
                       observed_at=observed_at)
projection = aggregate_order(order_id, events, scan_complete=scan_complete)

# Or let this adapter own the bounded email search/read path.
projection = track(order_id, since=placement_date, timeout=35)
```

The existing tracker already uses email fallback. Recommended integration:
reuse this adapter for the Amazon branch rather than adding it as a native API
source. Run one `orders()` scan per polling cycle and share its evidence across
active orders where possible; choose a lower bound no later than the earliest
placement. Avoid a separate all-account scan for every active order. Preserve
account/read errors, scan coverage, shipment keys, and observed/evidence times.
For the watcher's sub-60-second process budget, pass `timeout=35` or less and
retain the existing 300-second email cache; leave the remaining budget for local
notification processing. The standalone interactive default remains 75 seconds.

Do not pass raw delivered-package events through generic stage ranking as
whole-order delivery. Map package events to the existing shipment-delivered wake
path; close only when `whole_order_delivered` is true. Keep the mail-derived
source label. Reconciliation of physical arrival time remains separate.

### Watcher glue

`order_tracker.amazon_fetch()` uses the 35-second scan / 300-second cache and
keeps notification pushes unconfirmed. It closes an order only on the adapter's
`whole_order_delivered` flag. Package proof is projected even when inventory is
incomplete: a single known shipment key is preferred; otherwise the stable
`amazon:event:<event_id>` key identifies the email, not an invented package.
Matching delivery-event observations and email dates remain separate and do not
change on a cache-only tick. Legacy `account:folder:uid` keys are matched against
all reduced `mailbox_aliases` (projected as proof `mail_keys`) to migrate existing
arrival deduplication, including a legacy key for a non-primary duplicate copy
in another account/folder. Old cached events without aliases still use their
singular account/folder/UID reference.

Cancellation, return-request, return-received, and refund evidence appears in
`aftercare_evidence` and produces scoped `aftercare` wakes, never whole-order
terminal transitions. Wakes include `email_status`. Earlier/equal-time delivered
packages are retained with `historical=true`, baselined in arrival deduplication,
and not announced as fresh arrivals. Later sibling deliveries can still wake.
Aftercare is read-only evidence: it never authorizes removal or a return/refund/
cancellation action. Delivery problems retain their own scoped problem evidence;
a current problem also baselines earlier arrivals instead of announcing them.

Limits: without a shipment ID, two distinct emails about the same physical
package cannot be proven equivalent; event-ID dedupe only catches identical
events. Legacy migration requires the old mailbox key to remain present in the
current scan's primary reference or alias union; copies absent from the scan
cannot be reconstructed. Aftercare cannot safely allocate items to packages, so
the historical-arrival cutoff is conservatively order-wide. Already removed
delivery watchers do not restart themselves to monitor later returns. A retained
`last_confirmed_status=delivered` is historical, not current whole completion.

The parent deployed this implementation and installed the managed launcher on
2026-10-08, then verified the real CLI paths as described above. Source changes
remain uncommitted. No watcher registrations or arrival-notice routing changed.
