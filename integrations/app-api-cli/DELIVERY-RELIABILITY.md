# Delivery tracking repair, 7 October 2026

Tracking source is this directory; deploy with `integrations/deploy.zsh app-api-cli`.
Other catalog code remains in the existing app-api-cli installation. Credentials
stay in Keychain; no raw notification dumps or mail bodies are stored.

## Confirmed causes

- Talabat: native credentials are guest-only. Today's nearby notification at
  13:21:21 Dubai had no order ID; registration disabled single-order correlation,
  so old code discarded it. The 13:28 receipt does not state delivery. Owner
  reported about 13:24. This is a missed detection, not a successful replay.
- Careem: guest-only native credentials; multiple services share the app. Old
  active-only notification sampling and strict ID filtering have the same blind
  spot. No historical Careem delivery push remains available for replay.
- noon: Minutes native tracking works; marketplace is item/partial-history
  scoped and intentionally cannot certify whole-order completion. Unknown must
  wake verification rather than be presented as complete tracking coverage.
- Amazon: exact-order full-text searches can time out; two six-second body reads
  could be spent on receipts before delivery mail. Same-day searches also omit
  messages because search dates are exclusive/timezone-sensitive. Moni's email
  account exists in himalaya but is absent from mailsearch's account list.
- `remove`: inherited Bun inspector variables break child robob-watch processes;
  an archived watcher left its order registration active. Child environments are
  now sanitized and removal is idempotent.

## Runtime

- LaunchAgent `com.ardud.delivery-notifications`: read-only ADB every 15s;
  no phone UI, obeys priority-hold. Installer is `install-notifications.py`.
- SQLite `~/.local/state/order-tracker/delivery.sqlite`: projected notifications
  retained 30 days, source health, reconciliation records. Mode 0600.
- `delivery-source-health`: 60s robob-watch check, expires 7 Oct 2027. Existing
  failure escalation wakes repair and alerts rather than remaining silent.
- Existing per-order watchers keep their cursors. Context migration changes
  routing to arrival-only and asks Abdullah for actual arrival once per order.
- ID-less delivery-window pushes wake verification, never certify arrival.
- Email status candidates ranked before body reads, Gmail sender fallback plus
  Moni Inbox, one-day search overlap, 35s total mail budget. Per-account errors
  named; a coverage problem alerts when a new error appears or the confirmed
  stage changes, otherwise it repeats at most daily while unresolved.
- Amazon package events dedupe per message, do not mark whole-order terminal.

## Verification

16 focused tests pass, including retained pushes, actual Talabat wording,
marketing rejection, body-budget selection, date overlap, multi-shipment events,
inspector stripping, first-detection reconciliation and native identity checks.
Live replay: Amazon camera order 408-0853276-3455510 now returns delivered from
Gmail Inbox 190091, email timestamp 6 Oct 13:42:49 UTC; exact ID verified in body.
Live noon Minutes IAEGA4148P7H5TWI1A returns native delivered.
Collector health and robob-watch scratch tests pass. No test messages sent.

## Remaining gaps

Polling is not an Android NotificationListener: a push cleared within 15s, phone
offline or Mac asleep can be missed. No provider is assumed to emit a delivered
push. Talabat/Careem require exact-order app verification for ambiguous pushes;
native account bootstrap remains unavailable. Email is bounded and can be slow.
SMS inspection found no verified machine delivery feed; `ph sms` reads forwarded
Mac Messages, not Android notifications. The next live orders must validate the
complete detection-to-recipient loop and compare reported arrival times.
Several older registrations are active without watchers; don't rearm them and
send old delivery texts without checking owner context. Reconciliation records
must distinguish historical investigation from live detection.

## Talabat receipt email, 8 October 2026

Lazy Cat 3943292030 (Moni) was delivered at 12:36 Dubai, but the watcher only
fired `eta_elapsed` at 12:54. Native tracking is still guest-only
(`ACCOUNT_CAPTURE_REQUIRED_GUEST_CATALOG_ONLY`). The phone journal got no
Talabat order pushes that day. Generic email matching skipped the one signal
that existed: Talabat's "Your service charges Receipt" email in `gmail`,
sent 12:36:16. Its subject has no status word, and the order ID is only in the
PDF attachment, which Gmail search indexes. So `classify(subject)` returned
`unknown`, and the email was never treated as delivery evidence.

From 25 Sep to 8 Oct, every Talabat order got one of these receipts, and each
one's PDF order ID matched. Sent times line up with arrival: 12:36 vs a reported
12:36 on 8 Oct, and 13:28 vs about 13:24 on 7 Oct.
For Talabat orders, `talabat_receipt()` now runs an exact-ID Gmail search
(`from:talabat.com subject:receipt "ID"`) every 45s. It checks the sender
domain, the subject and the send time (must be after placement). A match counts
as exact-order `delivered` evidence, alongside native status and pushes.
Replay test: a check at 12:37 fires `stage_change delivered` once, with no later
`eta_elapsed`. Amazon `email_*_unavailable` errors on 8 Oct came from
intermittent Outlook XOAUTH2 failures and slow body reads. Gmail and
mailsearch work. Receipts still depend on gmail OAuth health.
