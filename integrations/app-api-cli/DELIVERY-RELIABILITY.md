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
  named; coverage problems repeat hourly while unresolved.
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
