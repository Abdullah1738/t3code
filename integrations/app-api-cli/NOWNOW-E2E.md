# NowNow E2E CLI lane — captured contract, live replay

Live-captured 2026-10-10 on paid order **NNGAANNWEFJMZW8A** (Spinneys Dubai Marina,
1x Grenade Protein Shake White Chocolate 330ml, subtotal 20.50 + delivery 6.45 +
service 4.50 = **AED 31.45 paid**). **No CVV, no 3DS** — payment rides the saved-card
token bound into the checkout session by `edit-payment`; `place-order` is the single
financial send. (Minutes needs paymentintent/complete + 3DS; NowNow does NOT.)

CLI: `commerce order nownow --product-code P4372707388695472A --store-code SPNNYSAKBB \
--quantity 1 --label "…"` (+ `--resume-flow FLOW_UUID`, 24h window).

Module map: `commerce_nownow_order.py` (journalled lane) over
`noon_nownow_checkout.py` (native transport). Fixture:
`test/fixture_nownow_e2e_chain.json` (hygiene-redacted from the capture);
tests: `test/test_commerce_nownow_order.py`.

## Lane lifecycle (every mutation journalled at-most-once)

1. **Guard** (reads only): `GET v1/order/homepage` → each `active[]` order must
   belong to an exact same-account NowNow journal-COMPLETE flow with a different
   scope (store, products, quantities, home). Unattributed, unfinished or same-scope
   orders block (`NOWNOW_ACTIVE_ORDER_PRESENT`); fulfilment still in flight on a
   completed distinct purchase does not. `POST v1/session/recent` → an existing cart for
   our store is never adopted (`NOWNOW_STORE_CART_PRESENT`); saved card from
   `GET customer-v1/customer/paymentcards` (unique live default Mastercard 5542) and
   its token corroborated in `POST v1/payment/subscription/list {}` (the numeric
   paymentcard id is the edit-payment paymentToken — verified against the live
   capture; token fingerprints only, never persisted).
2. **`POST v1/session/create`** `{productCode, storeCode, modifiers:{}}` →
   `data.checkoutSessionCode` (full session state).
3. **`POST v1/session/edit-product`** `{sessionCode, productCode, qty, notes:null,
   modifiers:{}}` — absolute quantity; sent for each additional product and
   when the first product needs quantity or other supported field changes.
4. **`POST v1/session/validate`** `{sessionCode}` → full state; pre-place guard:
   fee arithmetic (subtotal + delivery + handling + service + smallorder + cash +
   tip − discount == total == orderPaymentAmount), wallet 0, no tip/cash/discount/
   small-order fee, `addressCode == x-addresscode` (BanyanTree Flat 2104 home),
   exact complete product manifest, session/store identity echoed. Spending
   authorization belongs to the caller, not a permanent local policy cap.
5. **`POST v1/session/edit-payment`** `{sessionCode, paymentMethodCode:"prepaid",
   creditCardMask, paymentToken, prepaid_payment_method_code:"cc_noonpay",
   walletAmount:0}` → readback must echo `hasPaymentSubscription:true` + the exact
   card mask (`NOWNOW_PAYMENT_READBACK_MISMATCH` otherwise).
6. **`POST v1/session/set-delivery-preference`** `{sessionCode, deliveryPreference:
   {leave_it_at_my_door:true, dont_ring_the_bell:true}}` — **BOTH flags in ONE
   call** (the captured UI double-toggle ended with both false on NNGAANNWEFJMZW8A;
   the API is full-state, so one call is correct and idempotent).
7. **Driver note + final readback** `POST v1/session/add-notes`
   `{sessionCode,driverNotes:"Leave at door. Don't ring bell. Don't call."}`
   requires the exact echo, then `POST v1/session/active {storeCode}` (journalled
   quote read) re-verifies fees/address/manifest/payment + both quiet flags and
   the exact driver note; the frozen
   review digest binds session, store, product, qty, fees, total, address, card,
   quiet for the place reservation.
8. **`POST v1/order/place-order`** `{sessionCode, total}` → `data.order{orderNr,
   orderRef, orderStatusCode:"pending_acceptance", customerStatusCode:"placed",
   fees, orderPaymentAmount}`. Response schema is `data.order.orderNr` (nested —
   the transport was corrected from the earlier HBC guess).
9. **Poll `GET v1/order/tracking/{orderNr}`** until `status` ∈ {placed, preparing}
   → `placed` ("Awaiting confirmation from the merchant", needHelpActions incl.
   `cancel_order`) → `preparing` ("order is being prepared", estimate window,
   rider assigned in description). place-200 + this native tracking IS the paid
   signal on this lane (no paymentintent calls exist at all).
10. **Watcher** `order-watch add --app noon --order … --for owner --placed-at …
    --eta … --label …` with durable readback; journal COMPLETE requires
    PAYMENT_REPORTED_SUCCESS → EXACT_ORDER_CONFIRMED → TRACKER_REGISTERED on the
    single `place` operation.

## Guard rails

- Unattributed, unfinished or duplicate-scope active order / foreign store cart /
  ambiguous saved card / inactive token: STOP before any write. Journal-COMPLETE
  means paid, exactly confirmed and tracked, not necessarily delivered.
- Fee/address/manifest anomalies: STOP before place (`NOWNOW_*` codes); at most ONE
  place per flow (journal-enforced); financial retry never happens.
- Review freshness ≤ 60s at place; flow resume ≤ 24h (`NOWNOW_FLOW_EXPIRED_24H`);
  resume re-reads the live store session and refuses a foreign manifest — nothing
  is re-sent.
- 401/403 → `NOWNOW_AUTH_EXPIRED_NEEDS_APP_REBIND`; no re-login attempt exists.
- No local order/campaign spending cap; durable reservations and no-retry
  financial ownership remain. The caller accounts for all uncertain liability.

## Contract deviations vs the 2026-10-10 capture

- The captured UI made TWO sequential set-delivery-preference calls (final state
  both-false — the mishap). The lane sends ONE call with both true and requires the
  readback; the captured *correct* shape is what the lane replays.
- `driverNotes` was empty on the historical captured order. The 2026-10-11
  expansion also sends the existing native `add-notes` contract and requires
  the exact leave-door/no-bell/no-call note on a fresh read before placement.
  This is now paid-live-proven, not an invented preference code.
- Cancel: tracking `needHelpActions` exposes `actionCode:"cancel_order"`.
  **No complete cancellation payload is verified; `commerce cancel nownow` is
  a GAP**. Known route/path candidates do not authorize speculative requests.
  Cancel window = pending_acceptance only (~5 min; auto-confirms after).

## Live proof

Lane's own live run, 2026-10-10 15:41 +04 (flow
`bbc16987-e2fc-480a-98c5-0b05c23ecd8f`, journal COMPLETE):

- **Order NNGAANN4DYYYITRA** — Spinneys, 1x Grenade white chocolate shake 330ml,
  subtotal 20.50 + delivery 6.45 + service 4.50 = **AED 31.45 paid** (saved card
  5542 via session token; no CVV/3DS).
- Review readback: `quiet: true` (both flags), address 487167e4… (Flat 2104),
  card_last4 5542, review hash c66f6cee…b021.
- Status timeline: `placed` ("Awaiting confirmation from the merchant",
  needHelpActions incl. cancel_order) → `pending_approval`/preparing →
  `ready_for_pickup` "Immad will be delivering your order today", estimate
  **04:05PM - 04:20PM** — same fee/stage shape as the captured NNGAANNWEFJMZW8A.
- Watcher `order-noon-nngaann4dyyyitra` registered with durable readback;
  `commerce track-exact noon nownow NNGAANN4DYYYITRA` verified
  (raw_status ready_for_pickup, account+home verified).

One guard fix was needed live: with no active orders in flight,
`v1/order/homepage` returns `active: null` (the capture only showed the
populated shape); the transport now projects null as zero active orders.

## Multi-item baskets + prepare-only (2026-10-11, paid live)

`NowNowOrderFlow(store_code=..., items=[{'product_code','quantity',
'modifiers'?,'notes'?},...])` (legacy `product_code=`/`quantity=` unchanged;
`NOWNOW_ITEMS_CONFLICT` on mixing; duplicates `NOWNOW_DUPLICATE_PRODUCT`).
One session per flow, one place send — a multi-product basket is never
silently split into multiple charges. The session is created with the first
line; every additional line is one `edit-product` journaled as
`product_edit_<digest16>` (skipped on resume when consumed); index 0 needs
no edit when it is bare (qty 1, no modifiers/notes).

Review is the exact frozen multi-product manifest (sorted productCode/qty
vs `products`), supported fee arithmetic / wallet 0 / quiet flags and note /
prepaid card-5542 binding as the
capture. Multi projection adds `products` (single stays byte-identical).
`flow.prepare_only()` = guard → card+corroborate → create-or-adopt →
edits → validate → payment → quiet flags + driver note → pre_place_read → review_final, stop
before place; consumed ops (`cart_create`/`product_edit_*`/`cart_validate`/
`payment`/`delivery_preference`/`instructions`) are never re-sent. `resume_active(flow_id,
store_code, items=...)` adopts the live session by exact manifest.

Caps: qty upper bound and notes length cap removed (type checks retained);
read-side page bounds (orders/carts/token lists) retained as fail-closed
schema bounds. Paid live proof: flow `e498d57d-8c6b-4a37-8bfd-23c30a989101`,
order `NNGABNNZQGOYY1PA`, Spinneys Fine Classic facial tissues ×2 and Waitrose
Ultra Balm tissues ×1, subtotal21 + delivery6.45 + service4.50 = AED31.95.
Both exact quiet flags and no-call driver note verified; same prepared flow
resumed for one place send, native placed, watcher `order-noon-nngabnnzqgoyy1pa`,
journal COMPLETE. No CVV/3DS on this attempt. The live decoder yields Decimal
quantities; the manifest now accepts positive finite integral Decimal values
without relaxing exact quantities. Tests cover that regression, dropped notes,
multi-product single-place sends and resume without resending consumed writes.
