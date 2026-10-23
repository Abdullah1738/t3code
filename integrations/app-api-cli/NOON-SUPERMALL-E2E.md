# noon SUPERMALL (rocket) E2E CLI lane — captured contract, live replay

Live-captured 2026-10-10 23:31+04 on paid rocket order **NAEIA0000960441**
(1x Quest Vanilla Protein Milkshake 325ml, skuConfig ZC3D2FE430033CA47B932Z,
17.00 item + 5.00 shipping + 3.49 supermall service fees = **AED 25.49 paid**) —
frictionless saved-card (cc_noonpay, card 5542): **no CVV, no 3DS, no
clientSecret consumption**. Rocket express promise "Get in 1 hr 8 mins",
absolute deliveryDate `2026-10-11T00:37:00` (+04).

CLI: `commerce order supermall --sku-config ZC3D2FE430033CA47B932Z --quantity 1
--cvv-from-keychain --label "…"` (+ `--resume-flow FLOW_UUID`, 24h window pre-place; read-only
paid completion post-place).

Module map: `commerce_supermall_order.py` (journalled lane) over
`noon_marketplace_checkout.py` (native transport; adds the `add_rocket`
quick-atc operation) + `noon_http_orders` (guard reads). Fixtures:
`test/fixture_supermall_e2e_chain.json` (captured checkout chain),
`test/fixture_supermall_order_detail_live.json` (live order-v2 manifest);
tests: `test/test_commerce_supermall_order.py`,
`test/test_noon_vertical_reads.py` (rocket manifest projection).

## Rocket deltas vs the Main lane (same checkout-v2 family)

1. **Catalog verify** requires the unique buyable offer of the skuConfig to be
   rocket-flagged (`hit.flags` contains `rocket`);
   `SUPERMALL_ITEM_NOT_ROCKET` otherwise. Search runs with `x-experience:
   rocket`; checkout uses the separately captured `ecom` experience.
2. **Cart add** is the PDP quick_atc route: `POST
   cart-v1/cart/item/{offerCode}/{qty}?showCart` with body
   `{"isFouponSelected":false,"isInstallationSelected":false}` — no
   `isPageCart`, no storeCode (Main posts `?showCart&isPageCart=true` with no
   body).
3. **Session shipment** must be `isRocket:true, isSlotBased:false` with
   exactly one selected promise whose `deliveryDate` is an ABSOLUTE timestamp
   (`YYYY-MM-DDTHH:MM:SS`, Dubai local; becomes the watcher `--eta` at
   `+04:00`). A relative/absent promise stops the lane
   (`SUPERMALL_PROMISE_DELIVERY_DATE_REQUIRED`).
4. **Total arithmetic**: fees exist on rocket orders (5.00 shipping + 3.49
   service). The lane requires `total == orderPaymentAmount`,
   `subtotal == Σ(unitPrice × qty)`, `total ≥ subtotal`. The caller manages
   spending authorization; there is no local spending-policy cap. Main's
   multi-item path now also supports aggregate fee arithmetic.
5. **Experience binding**: the captured rocket checkout chain (cart add,
   session, place, order-status) all post with `x-experience: ecom`, so the
   ordering transport binds to the shared `main` (ecom) client while the
   journal keeps the distinct `supermall` vertical. `checkout-check` /
   `track-exact` continue to use the dedicated supermall (rocket) client for
   reads — both experiences serve the same account-level cart and order-v2
   family (live-verified both ways).

## Lane lifecycle (mutations journalled at-most-once)

1. **Guard** (reads): `GET cart-v1/cart` must be empty (a foreign basket is
   never replaced); `GET order-v2/orders/active` + per-order order-status:
   paid/success prior orders (e.g. the rocket order still in flight) are
   surfaced. An expired checkout record (HTTP 400, exact `Order not found` /
   code 404 body) requires matching `Paid with` and `Total paid` evidence from
   that order's durable order-v2 detail. Pending/failed/unproved orders still
   stop everything (`SUPERMALL_ACTIVE_ORDER_PRESENT`); catalog rocket resolve;
   quantity ≥ stock minimum. This fallback never confirms a new placement.
2. **Quick add** (mutation): captured route above → cart readback must hold
   exactly our offer at the requested quantity
   (`SUPERMALL_EXACT_ADDED_MANIFEST_MISMATCH` fences).
3. **Checkout session**: `POST checkout-v2/session/session
   {"shouldUpdateSession":true}` → verify server-carried defaults
   (silent_delivery active, default card 5542 selected, addressKey == home,
   useCredits false, wallet 0) + the rocket shipment/promise/total checks
   above; freezes the review hash (60s freshness at place).
4. **Place**: `POST checkout-v2/order/place-order {"total": 25.49}` → response
   body is the bare order-nr string (`"NAEIA0000960441"`).
5. **Paid signal**: poll `GET checkout-v2/order/order-status?order_nr=…`:
   `pending` ("Payment pending") → **`status:"success"` + populated
   `shipments` + `total:"25.49"`** = PAID. `paymentError`/`paymentErrorMsg`
   non-null is failure (`SUPERMALL_PAYMENT_ERROR_NO_RETRY`). A pending `clientSecret`
   is completed once with the selected card and encrypted CVV. Pending/3DS prompts
   ENBD approval via Telegram, then polls for at most ten minutes. Challenge coverage
   is fixture-only; `await-payment FLOW` resumes reads without another payment.
6. **Confirm + track + watch**: journal PAYMENT_REPORTED_SUCCESS on the financial
   op; exact order-v2 order-detail readback (bounded retries while
   `itemGroups` repopulates — `INCOMPLETE_MANIFEST`/`INVALID_RESPONSE` only;
   any schema mismatch still fails fast); `order-watch add … --eta
   <promise deliveryDate+04:00>` with durable readback; journal COMPLETE.

## Guard rails

- Nonempty basket / unpaid active order / non-rocket or ambiguous catalog hit
  / quantity below stock minimum: STOP before any write.
- Silent delivery inactive, default card not selected, address/credits
  anomaly, non-rocket shipment, promise without absolute date, fee/subtotal
   arithmetic break: STOP before place.
- paymentError → failure, never a retry; window elapsed → no retry. 401/403 →
  `SUPERMALL_AUTH_EXPIRED_NEEDS_APP_REBIND` (no re-login). Resume ≤ 24h
  pre-place (exact basket readback, never re-adds, refuses foreign
  manifests); post-place resume is read-only (tracking + watcher + COMPLETE;
  place never repeated).
- Full liability is reserved in the journal before place. Caller-managed
  authorization/budgets replace the former local order/campaign policy limits.

## Track-exact adapter fix (this lane)

`commerce track-exact noon supermall NAEIA0000960441` failed
ORDER_MISMATCH_OR_SCHEMA_CHANGED at capture time, and the same failure
reproduced live on the lane's own fresh rocket order at place time
(NAEIA0070666081). Two real rocket order-v2 manifest deltas, both now fixed
in `noon_vertical_reads.manifest_projection` + `noon_http_orders`:

1. **Rocket fulfillment-unit shipment ids**: a fresh/confirmed rocket order
   binds its shipment as `{order}-U<digits>` (unit) — at the **group** level
   (`itemGroups[].shipmentNr`) with the item row's own `shipmentNr: null`.
   `core.SHIPMENT` only accepted `-S<digits>`, so both the exact-track
   projection AND the `/orders/active` guard read
   (`marketplace_cards`) raised ORDER_MISMATCH_OR_SCHEMA_CHANGED while any
   fresh rocket order existed. The regex now accepts the live-verified
   `-S`/`-U` suffixes (prefix binding to the order unchanged); packing later
   rebinds the same shipment as `-S1` (observed on both live orders).
2. **One-sided group/row shipment binding**: the projection inherits the
   present side when only one of group/row carries the shipment id, after
   validating the inherited id belongs to the same order. Both-set-but-
   different and cross-order ids remain ORDER_MISMATCH_OR_SCHEMA_CHANGED.

Regression fixtures (hygiene-redacted, no phones/coords/tokens):
`test/fixture_supermall_order_detail_live.json` (NAEIA0000960441,
out_for_delivery, `-S1`) and
`test/fixture_supermall_order_detail_fresh_live.json` (NAEIA0070666081,
confirmed, group `-U1` + null row id — the exact captured failure shape);
cases in `test/test_noon_vertical_reads.py` (projection, regex, active-cards
guard read, inheritance, foreign/conflicting rejection).

## Contract deviations vs the 2026-10-10 capture

- Pending payment adds encrypted-CVV completion and payment-status reads
  (fixture coverage only). The lane adds no setter calls: silent delivery and the
  default card are account-level and verified server-side, exactly as
  captured.
- The search query differs: the capture browsed supermall carousels and a
  human text search; the lane queries by the exact skuConfig and requires the
  unique buyable rocket offer (verified live against the same hit).
- `GET post-order/{nr}` and the cart reset read are NOT replayed (post-order
  marketing payload; unnecessary for paid proof).

## Live proof

Lane's own live run, 2026-10-11 00:16-00:23 +04 (flow
`b999304d-39b0-4728-bc86-4661d996a5cc`, journal COMPLETE):

- **Order NAEIA0070666081** — 1x Quest Vanilla Protein Milkshake 325ml
  (skuConfig ZC3D2FE430033CA47B932Z, rocket offer aaa9dcee08bdd46c, stock
  minimum 1), **AED 25.49 paid** frictionless (cc_noonpay card 5542; no
  CVV/3DS, clientSecret null): 17.00 item + 8.49 fees (5.00 shipping + 3.49
  supermall service).
- Guard surfaced 3 prior paid orders (incl. rocket NAEIA0000960441
  out_for_delivery); cart empty; catalog resolve → buyable rocket offer.
- Session verify (review hash 6141af41…cb4a): silent_delivery active, default
  card 5542 selected, addressKey 487167e4…-1 (Flat 2104), useCredits false,
  wallet 0, isRocket shipment isSlotBased false, selected express promise
  "Get in 1 hr 8 mins" with absolute deliveryDate 2026-10-11T01:27:00,
  total == orderPaymentAmount == 25.49, subtotal 17.00 + fees 8.49.
- Timeline: place 00:16:54 → `pending` "Payment pending" → **`success`
  "Your order is successfully placed"** 00:16:59 (total "25.49", shipments
  populated) → item confirmed (`-U1` unit shipment) → packed (`-S1`).
- The fresh `-U1` manifest reproduced the captured track-exact failure
  (ORDER_MISMATCH_OR_SCHEMA_CHANGED at the first verify attempt — the exact
  bug this lane fixes). After the adapter fix + redeploy, the read-only paid
  resume (`--resume-flow … --eta 2026-10-11T01:27:00+04:00`) finished the
  flow: exact order-v2 manifest (item NAEIA0070666081-1, shipment -S1,
  manifest_complete), watcher `order-noon-naeia0070666081` registered with
  durable readback, journal COMPLETE 00:23:13.
- Post-proof: `commerce track-exact noon supermall NAEIA0070666081` (packed)
  and `... NAEIA0000960441` (**delivered**, whole_order_complete) both verify
  through the fixed adapter; the `/orders/active` guard read accepts the
   rocket unit row. The historical campaign reservation was 21970/25000 minor;
   it is not a current spending cap or authorization.

## Multi-item baskets + prepare-only (2026-10-11, paid live)

`SupermallOrderFlow(items=[{'sku_config','quantity'},...])` (legacy
`sku_config=`/`quantity=` unchanged; `SUPERMALL_ITEMS_CONFLICT` on mixing).
Per-item rocket resolve (every hit must stay rocket-flagged) + quick-add;
adds journal as `add_rocket_<digest16>`. Review aggregates **all rocket
shipments**: each shipment isRocket True/isSlotBased False, exactly one selected
rocket promise with ABSOLUTE deliveryDate; manifest sorted across shipments;
`subtotal == sum(unitPrice*qty)`; `total == payable > 0`, `total >=
subtotal`; **eta = max promise date across shipments**. Multi projection
carries items/subtotal_minor/fees_minor/total_minor/shipments; single stays
byte-identical. `prepare_only()` mirrors main (fresh cart re-GET before the
session refresh; `session_<uuid8>` journal name on re-run); resume adopts by
exact aggregate manifest.

Paid live proof: flow `1fa3d76c-5193-4a3a-a232-000272540bdd`, order
`NAEIA0059296797`, Kleenex DailyCare tissues5×120 ×1 + disposable hand towels90
×1, subtotal28 + fees8.49 = AED36.49. One rocket/non-slot shipment, absolute
promise17:14+04, Home/card5542/silent/no credits, exact two-item readback.
Same-flow continuation reached pending→success with shipments/total, complete
two-item manifest, watcher `order-noon-naeia0059296797`, journal COMPLETE.
Fulfillment stage was unknown at acceptance, not a delivery claim.
**Multi-rocket-shipment sessions remain fixture-only**, including eta=max
across two shipments (`test/test_multi_basket_lanes.py`).
Arbitrary qty caps removed (`SUPERMALL_QUANTITY_INVALID` int>=1;
`ORDER_LIMIT_MINOR` comparison gone; stock-minimum merchant check retained).
