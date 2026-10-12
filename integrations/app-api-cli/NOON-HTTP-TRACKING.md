# Noon HTTP tracking — 8 October 2026

## Delivered scope

`noon_http_orders.py` provides `track(order, timeout=10, *, deadline=None)` and
`orders(service='all', page=1, timeout=10)`, raising `NoonError` with sanitized
codes. It supports native Minutes and marketplace/supermall/rocket evidence.
Food, NowNow and the full marketplace manifest are provided separately by
`noon_vertical_reads.py`; see `NOON-VERTICAL-READS.md` for those contracts.

The integration hardening below was verified with offline fixtures only; it did
not repeat the earlier live reads or perform deployment, commits, phone/browser
actions, cart/checkout changes, cancellation or customer notifications.

## Verified live evidence

Both `minutes` and `noon` stored sessions passed native whoami authentication and
the existing saved-Home binding: customerCode exists; selected address code/key
equal captured headers; selected address identifies BanyanTree. Original raw
identity/address/header material stays in process memory.

### Minutes IAEGA8148M1PBI5LTA

- Parent captured `confirmed` at 14:01 UTC; placed 17:58:35 Dubai.
- 14:03 UTC: native track `picked_up`, visible title **Out for delivery**.
  `rider.showRiderDetails=true`; name/phone fields present. Only these two rider
  fields are projected; no location, tip/payment/card metadata.
- List ETA was `Arrives between:<br><b>06:11 - 06:16 PM</b>`.
- 14:09 UTC: `arrived_at_delivery`, title **Our rider is nearby**; list ETA narrowed
  to 18:11–18:13 Dubai. This maps to `nearby`, not delivered.
- Finite 60-second sampler first detected `delivered` at
  **2026-10-08T14:10:47.713069Z**; rider hidden/null. That is detection time, not a
  claim of exact arrival time. All subsequent bounded samples agreed.
- Track field `etaMsgConfig.deliveryTime=7` was observed while out for delivery,
  but its unit is not independently established, so it is not converted to ETA.
- Native list window is parsed to Dubai start/end only when the same-day window
  is unambiguous and within four hours of placement. Midnight/AM-PM ambiguity and
  scheduled-day text remain null. Original sanitized ETA text remains available.

Validated mappings: confirmed→placed, picked_up→out for delivery,
arrived_at_delivery→nearby, delivered→delivered. Unknown enums stay unknown.

### Marketplace NAEIA0002358740 / NAEIA0002358740-S1

- Active card was **shipment-level**, `level=rocket_shipment`, containing nested
  item `NAEIA0002358740-1`, quantity 1. Old flat-item-only assumptions miss this.
- 14:03 UTC: out_for_delivery. Native delivery message `Arriving 5 Mins`.
- Native `GET /_svc/order-v2/track/shipment/NAEIA0002358740-S1` returned 200, exact
  order/shipment identities, and timeline with only the out_for_delivery node
  carrying a non-null status. Substatus `out_for_delivery_arrive_rocket`, message
  `Arrived at your location`.
- Its future **Delivered** timeline node had `status:null`; never classify from
  the node key/label alone.
- After completion that shipment route returned 302. Redirects remain disabled.
- Native history is item-level: exact item `NAEIA0002358740-1`, shipment S1,
  highStatusCode delivered, subStatusCode delivered_rocket.
- Newly verified `GET /_svc/order-v2/track/item/NAEIA0002358740-1` returned 200,
  exact top-level order/item and nested item/shipment identities, with a current
  delivered status object and text **today, 06:10 PM**.
- Whole-order completeness is not established by the bounded history page or the
  observed one-item shipment. Top-level terminal status deliberately remains
  `unknown`, with exact delivered item proof under `shipments` (`scope:item`).

Marketplace rider data is null: its action arrays contain contact information,
but no `showRiderDetails` consent/display flag was established for this schema.
Relative delivery messages remain text, not fabricated ISO timestamps.

## Native read routes

- GET api-app-st.noon.com `/_vs/st/st-whoami-api/whoami`
- POST api-app-instant.noon.com `/_svc/instant/order/track` `{order_nr}`
- POST same host `/_svc/instant/order/list` `{pageNr}`
- GET api-app.noon.com `/_svc/order-v2/orders/active`
- GET same host `/_svc/order-v2/orders/history` (first page only)
- GET same host `/_svc/order-v2/track/shipment/{exactShipmentNr}`
- GET same host `/_svc/order-v2/track/item/{exactItemNr}`

Shipment/item paths were found in the local installed APK's Hermes bundle
`$TMPDIR/opencode/noon-tracking.apk!assets/index.android.bundle`, then verified
using only the existing own order. Read candidates `/track/order/{orderNr}` and
`/_svc/order/api/order/{orderNr}` returned 400; no full order-summary route was
established. They are not part of the module allowlist.

## Transport and failure behavior

One monotonic deadline across account verification, tracking and optional ETA
enrichment. An internal caller may supply `deadline` as an absolute monotonic
value; it is inherited unchanged, not restarted from a remaining duration.
The marketplace aggregator passes that same value to this core and the manifest
reader. Expired inherited budgets fail before session/Keychain access.
Each HTTP read uses its own non-nested SIGALRM context, blocking
drip-fed headers/body overruns. Non-main-thread and pre-existing timer fail closed.
2 MB compressed and decoded bounds, no proxy/redirect, and sanitized HTTP/transport
errors. Credentials loaded in memory only from existing `minutes` / `noon` entries.

Completed reads are retained independently. The response/projection for each read
must finish before the shared deadline; a response that arrives late is discarded,
even if it contains a terminal status. Once the budget is gone, no later request
or vertical's Keychain/session lookup starts. Returning already accepted evidence
does not recheck the deadline and throw it away.

- Minutes primary tracking is required. If it fails or finishes late, `track`
  raises. Optional list/ETA failure preserves the primary status, text and rider;
  no late list ETA is used.
- Marketplace tracking always attempts both the active page and first history
  page while budget remains, including when active contains the target order.
  A failure in either page does not discard the other. Only exact target-order
  rows survive; equal item/shipment identities within the same scope are merged.
   Conflicting snapshots stay `unknown` in `items` with `card_status_conflict`.
   An accepted exact detail can supply scoped evidence, but does not remove the
   card conflict's veto on whole-order completion. Multiple explicit current
   timeline statuses retain `timeline_status_conflict`, even when their reduced
   `raw_status` is null. Item and shipment scopes remain separate.
- Up to four distinct item/shipment details are attempted. Every accepted card is
  retained, including cards beyond that detail bound and cards whose detail read
  fails. Previously accepted detail evidence survives a later detail failure.
   Card fallback retains its bounded-card coverage rather than claiming a detail
   was fetched. Top-level `truncated` flags the four-detail bound, not dropped cards.
   Successful detail retains a separate copy of the card's `item_ids`; this keeps
   observed inventory available for manifest reconciliation and prevents a prior
   item arrival being notified again when it next appears as a shipment.
- `orders('all')` keeps independent Minutes/marketplace results even when one
  vertical fails authentication, transport or schema validation. Marketplace list
  pages are independent too. Each returned row belongs to a verified session.
  A successfully read empty list is valid; if no list page succeeds, the call
  raises a sanitized `NoonError` rather than returning a misleading empty success.
  Marketplace tracking likewise raises when no exact target evidence is found.

Successful results add `partial` and `read_coverage`. `partial=true` means one or
more planned reads failed or were skipped, not that the existing status is invalid.
`read_coverage.completed` lists accepted reads; `failed` and `skipped` map read
names to sanitized codes. Detail keys include the already verified item/shipment
ID. `warnings` contains deduplicated summaries such as
`eta_enrichment_native_read_timeout`, `marketplace_history_http_503`, or
`detail_detail_limit`. Each fallback detail also carries its own warning.
`partial=false` is not proof of exhaustive history or a whole-order manifest.
List coverage separately exposes `active_fetched` / `history_fetched`.

Minutes checks exact csHelpLabels.orderNumber. Marketplace checks exact order and
shipment/item binding. No new enum inferred from future timeline text. Active
shipment detail failures (including 302/404, timeout and 5xx) preserve card-scoped
evidence; history selects the item-detail route. No inferred whole-order
delivered/cancelled from partial pages.

## Tracking integration

`native_orders.track` routes Minutes to this core, Food and NowNow to the vertical
reader, and marketplace through the scoped-plus-manifest aggregator. `NN...`
dispatch precedes `N...`. Errors are translated from `NoonError` to `OrderError`.
Listing selects the appropriate core or explicit vertical reader.

Whole marketplace delivery requires a complete delivered manifest and agreement
with every observed record: top-level status, `items`, and `shipments`. An explicit
raw status other than `delivered` vetoes completion even if normalized to unknown.
Card/timeline conflict warnings also veto. All `item_id`, nested `item_ids`, and
`shipment_id` values must exist in the manifest, and observed item-to-shipment
associations must match. A conflicting manifest cannot erase prior scoped proof.
The aggregator rejects a manifest returned after the original deadline and retains
already accepted scoped evidence with a sanitized timeout warning.

`order_tracker.fetch` already consumes the compatible top-level status/eta/rider
shape. Preserve `shipments`, `items`, `scope`, `whole_order_complete`, `partial`,
`read_coverage`, and warnings in its result when available, including when
whole-order status is unknown. For marketplace terminal item evidence, emit an
item/shipment-scoped event rather than closing the whole order; parent owns that
policy/glue, including mixed active/terminal events and cross-poll deduplication.
Preserve native ETA source when present (`native_minutes_list_window`).

The new tests embed sanitized live structural fixtures. Run:

```sh
PYTHONDONTWRITEBYTECODE=1 ~/.local/share/uv/tools/mitmproxy/bin/python -m unittest test.test_noon_http_orders -v
```

No test calls the network or Keychain. Tests cover identity/Home mismatch, header
projection, current-vs-future timeline, partial completion, ETA ambiguity, terminal
item history, redirects, bounds, truncated HTTP, total deadline and signal cleanup.
The active/history and partial-failure regressions were run red before the fix.
Additional cases cover independent vertical failure, empty successful pages,
late primary/list/history/detail rejection, zero further requests after deadline,
scoped duplicate/conflicting cards, and evidence beyond the four-detail limit.
This hardening pass used mocked reads only; it did not repeat live account checks.
Integration regressions in `test/test_native_orders.py` exercise real projections
for unmapped raw states, collapsed card/timeline conflicts, missing inventory,
wrong item/shipment associations, agreeing inventory, and inherited/late deadlines.
Its real `order_tracker.fetch` + `transition` replay verifies item-then-shipment
arrival deduplication without changes to the tracker or its test module.
