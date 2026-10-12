# noon MAIN marketplace E2E CLI lane — captured contract, live replay

Live-captured 2026-10-10 on paid order **NAEIA0042714780** (2x Maxi Nutrition
MaxShake Vanilla 330ml, skuConfig Z0B9474A290818B862A38Z, subtotal 19.80 (35% off
from 30.88), shipping FREE, **AED 19.80 paid**) — frictionless saved-card
(cc_noonpay, card 5542): **no CVV, no 3DS, no clientSecret consumption**.

CLI: `commerce order main --sku-config Z0B9474A2908862A38Z... --quantity 2 --label "…"`
(+ `--resume-flow FLOW_UUID`, 24h window).

Module map: `commerce_main_order.py` (journalled lane) over
`noon_marketplace_checkout.py` (native transport) + `noon_http_orders` (guard
reads). Fixture: `test/fixture_main_e2e_chain.json`; tests:
`test/test_commerce_main_order.py`.

## Lane lifecycle (mutations journalled at-most-once)

1. **Guard** (reads): `GET cart-v1/cart` must be empty (a foreign basket is never
   replaced); `GET order-v2/orders/active` plus exact prior order-status reads
   surfaces already-paid orders but blocks pending/unpaid/erroring orders
   (`MAIN_ACTIVE_ORDER_PRESENT`); catalog resolve `GET
   api-app.noon.com/_svc/catalog/api/v3/u/search?q=<skuConfig>` → exactly one
   buyable offer code for the skuConfig (`offer_code`, string booleans — catalog
   v3 returns `is_buyable:"True"`, `stock_minimum_quantity:"2"`); quantity must be
   ≥ stock minimum.
2. **Add**: `POST cart-v1/cart/item/{offerCode}/{qty}?showCart&isPageCart=true` →
   readback must hold exactly our offer at the requested quantity
   (`MAIN_EXACT_ADDED_MANIFEST_MISMATCH`).
3. **Checkout session**: `POST checkout-v2/session/session
   {"shouldUpdateSession":true}` → verify **server-carried defaults**:
   - `deliveryOptions.silent_delivery.status == "active"` (quiet delivery is
     account-level; no setter call exists on this lane),
   - `paymentMethods[code=cc_noonpay].status=="active"` with exactly one selected
     default card ending 5542 (`id` is the payment token; never persisted),
   - `addressKey == x-addresskey` (BanyanTree Flat 2104 home),
   - `useCredits:false`, `walletAmount:0`, exact aggregate shipment manifest;
     multi-item review requires subtotal = sum(unitPrice × quantity),
     total = orderPaymentAmount >= subtotal and exposes fees = total − subtotal.
     Caller-managed authorization/budget, no local spending-policy cap.
4. **Place**: `POST checkout-v2/order/place-order {"total": 19.8}` → response body
   is the **bare order-nr string** (`"NAEIA0042714780"`).
5. **Paid signal**: poll `GET checkout-v2/order/order-status?order_nr=…`:
   `pending` ("Deal reservation pending" → "Payment pending") → **`status:
   "success"` + populated `shipments` + `total:"19.80"`** = PAID. `paymentError`/
   `paymentErrorMsg` non-null is failure (`MAIN_PAYMENT_ERROR_NO_RETRY`); a
   `clientSecret` may be present even on success and is never consumed.
6. **Confirm**: journal PAYMENT_REPORTED_SUCCESS on the single `place` op, exact
   order-detail tracking readback (order-v2 `/_svc/order-v2/order/{nr}` manifest),
   `order-watch add` with durable readback, journal COMPLETE.

## Guard rails

- Nonempty basket / active marketplace order / unbuyable or ambiguous catalog hit
  / quantity below stock minimum: STOP before any write.
- Silent delivery inactive, default card not selected, address/credits/total
  anomaly: STOP before place.
- paymentError → failure, never a retry; window elapsed → no retry. 401/403 →
  `MAIN_AUTH_EXPIRED_NEEDS_APP_REBIND` (no re-login). Resume ≤ 24h, re-reads the
  live basket, refuses a foreign manifest, never re-adds.

## Contract deviations vs the 2026-10-10 capture

- None on the wire chain (search → cart → add → session → place → order-status →
  post-order reads). The lane adds no setter calls: silent delivery and the
  default card are account-level and verified server-side, exactly as captured.
- The search query differs: the capture used a human query ("maxi nutrition
  vanilla"); the lane queries by the exact skuConfig and requires a unique
  buyable offer (verified live against the same hit).
- `GET post-order/NAEIA0042714780` and the cart reset read are NOT replayed
  (post-order marketing payload; unnecessary for paid proof).

## Live proof

Lane's own live run, 2026-10-10 15:51 +04 (flow
`93970ad3-0a73-4d3c-a216-7b9769168f70`, journal COMPLETE):

- **Order NAEIA0055978445** — 2x Maxi Nutrition MaxShake Vanilla 330ml
  (skuConfig Z0B9474A290818B862A38Z, offer a42fa0b0583a448f, stock minimum 2),
  **AED 19.80 paid** frictionless (cc_noonpay card 5542; no CVV/3DS, no
  clientSecret use).
- Session verify: silent_delivery active, default card 5542 selected, addressKey
  487167e4…-1 (Flat 2104), useCredits false, wallet 0, total == subtotal ==
  orderPaymentAmount == 19.80, review hash 288e499a…6304.
- Status timeline: `pending` "Payment pending" → **`success` "Your order is
  successfully placed"** (total "19.80", shipments populated); order-detail
  item NAEIA0055978445-1 qty 2: processing → confirmed.
- Watcher `order-noon-naeia0055978445` registered with durable readback;
  `commerce track-exact noon main NAEIA0055978445` verified.

One guard refinement was proven live: the captured order NAEIA0042714780
(delivery tomorrow) is still an active marketplace order. Per the task recipe
("cart + order-status of previous") the guard now reads each prior active
order's order-status: paid/success orders are surfaced and the lane proceeds;
any pending/unpaid or erroring order stops it (`MAIN_ACTIVE_ORDER_PRESENT`).

## Multi-item baskets + prepare-only (2026-10-11, paid live)

`MainOrderFlow(items=[{'sku_config','quantity'},...])` (legacy
`sku_config=`/`quantity=` unchanged; `MAIN_ITEMS_CONFLICT` on mixing).
Per-item resolve + add; each add journals as `add_<digest16>` so resumed
flows skip exact consumed adds. Review is **aggregate across all shipments**
(multi-seller OK): manifest = sorted (skuConfig, qty) over every shipment,
`subtotal == sum(unitPrice*qty)`, `total == payable > 0`, `total >= subtotal`,
`fees = total - subtotal >= 0` exposed. Multi-item projection carries
`items/subtotal_minor/fees_minor/total_minor/shipments/...`; single-item
projection stays byte-identical to the capture-era shape (scope digests and
old ACTIVE flows unaffected).

`flow.prepare_only()` runs guard → resolve → adds (skipping consumed) →
**fresh cart re-GET** → checkout session → review, and stops: no place, no
financial send; returns review + readback evidence, flow stays ACTIVE. A
re-run session after the first `session` consume journals as
`session_<uuid8>` (same one-shot rule as adds) so resume can re-GET the
basket instead of trusting a cached session. `resume_active(flow_id,
items=...)` re-resolves every item and adopts the live cart by exact
aggregate manifest.

Paid live proof: flow `61ffd21a-87cc-487e-8931-20d41a9b1e14`, order
`NAEIA0096136484`, Dove Men+Care Clean Comfort spray2×250ml pack ×1 and
Himalaya Tulsi/Aloe handwash250ml ×1. Two shipments, subtotal42.25 + fees8.49 =
AED50.74; exact prepare/readback then same-flow paid continuation, Home/card5542/
silent_delivery/no credits. Status pending→success with shipments and exact
total; complete two-item tracking manifest, watcher `order-noon-naeia0096136484`,
journal COMPLETE. Fulfillment stage was unknown at acceptance; not a delivery
claim or proof of every seller/fee variant. Constructor/aggregate review/resume
also covered by `test/test_multi_basket_lanes.py`.
Arbitrary qty/money caps removed (`MAIN_QUANTITY_INVALID` now int>=1 only;
`ORDER_LIMIT_MINOR` comparison gone; positive/exact money + stock-minimum
merchant checks retained).
