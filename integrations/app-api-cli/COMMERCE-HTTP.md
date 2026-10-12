# Native HTTP commerce lifecycle

Source integrations use `commerce_journal.py` for local at-most-once mutation
ownership and durable financial-liability accounting. There are no local product
category, basket-count, quantity or spending-policy caps. The caller must enforce
the user's authorization and task budget, including reserved/uncertain liability.
`capabilities` reports null order/campaign caps; unrestricted tooling is not
purchase authorization. Merchant constraints and exact account/Home/card/quiet,
manifest, money, foreign-cart and financial-at-most-once checks remain enforced.
`commerce_receipts.py` holds private exact returned identities and payment-status
cursors. Neither raw HTTP responses nor credentials belong in those files.

## Recovery

After installation:

```
commerce inspect FLOW_UUID
commerce capabilities
commerce order-status FLOW_UUID
commerce reconcile-order FLOW_UUID
commerce recover-payment FLOW_UUID --max-reads 90
commerce await-payment FLOW_UUID --minutes 4
commerce release-flow FLOW_UUID
commerce abandon-flow FLOW_UUID
commerce track FLOW_UUID
commerce track-exact noon minutes I_ORDER_ID
commerce track-exact noon nownow NN_ORDER_ID
commerce track-exact noon supermall N_ORDER_ID
commerce track-exact talabat restaurants ORDER_ID
commerce auth talabat shops
commerce auth noon minutes
commerce auth noon minutes --reconcile
commerce auth noon minutes --recover
commerce auth noon main --diagnose-readonly
commerce marketplace-cart main
commerce marketplace-cart supermall
commerce checkout-check nownow
commerce checkout-check minutes
commerce review-contract main
commerce review-contract nownow
commerce restaurant-cart-contract
commerce order minutes --sku SKU --quantity 1 --cvv-from-keychain --label "minutes <item> x1"
commerce order main --sku-config SKU_CONFIG --quantity 2 --label "main <item> x2"
commerce order nownow --product-code P --store-code S --quantity 1 --label "nownow <item> x1"
commerce order supermall --sku-config SKU_CONFIG --quantity 1 --label "supermall <item> x1"
commerce order minutes --items-file basket.json --prepare-only
commerce order minutes --items-file basket.json --resume-flow FLOW_UUID --cvv-from-keychain
commerce order talabat --vertical restaurants --branch BRANCH_ID --items-file basket.json \
  --apk-pool /path/to/talabat-apk-pool.txt --prepare-only
commerce menu talabat --branch BRANCH_ID
commerce choices talabat --branch BRANCH_ID --item ITEM_ID
```

All seven lanes accept `--items-file FILE` (or `-` for stdin), a JSON array or
`{"items":[...]}`. Do not mix this with legacy scalar item/quantity flags. Rows:

- Minutes: `{"sku":"SKU","qty":1}`.
- NowNow: `{"product_code":"P...","quantity":1}`, one `--store-code` per flow.
- Main/Supermall: `{"sku_config":"SKU_CONFIG","quantity":1}`.
- Talabat: `{"item_id":ITEM_ID,"quantity":1}`, with grocery UUIDs or food integer
  IDs. Restaurants additionally accept `note` and `choices` rows of
  `{"choice_id":CHOICE_ID,"quantity":1,"sub_choice_ids":[]}`. Resolve choices from
  the exact live menu; required groups, selection cardinality and quantities are
  validated. Nonempty nested subchoices are unproved and refused, not guessed.

Many items stay in one checkout/flow; do not silently split a requested basket.
Unverified merchant variants, modifiers and scheduled slots still require an
explicit app fallback. Mart/Shops notes and choices are not supported.

For Talabat, `recover-payment` restores the exact received transaction and native
polling cursor. For Minutes, it reads the exact persisted order, including a
terminal failed result. It never reconstructs a checkout or resends place/payment.
Payment success is distinct from exact order confirmation and delivery tracking.
The full paid Minutes flow — guard, sync, place, encrypted-CVV completion, 3DS
Telegram wait, paid triple, tracking and watcher — is documented in
[NOON-MINUTES-E2E.md](NOON-MINUTES-E2E.md).

`reconcile-order` reads the persisted place receipt first, then the exact native
order and available intent/transaction status. It reports route/method/time and
projected-evidence/reference hashes without exposing private intent material.
It cannot release a reservation or reopen a flow. Failed/zero-total orders and
status errors do not establish no charge. The current missing interface is an
authoritative exact-attempt authorization/capture/void/expiry disposition. Normal
fulfillment tracking and client payment-status responses are not that ledger.

Before each mutation, a verified one-use auth snapshot must be obtained. Auth
failure after dispatch does not authorize repeating the mutation. Unknown cart
and financial sends retain ownership and financial reservations. A new flow ID
cannot escape them. Talabat's nonfinancial quote failure is the narrow exception
below; it closes the failed flow, never retries its operation.

### Talabat quote failures (11 October 2026)

The CCX `/ccx/v1/checkout/{cartId}` preview is not a place/payment operation.
An invalid or unavailable quote now returns `PREPARATION_FAILED` with the exact
phase and a safe parser `cause`. The private receipt retains a bounded allowlisted
projection of monetary fields/charge types, exception class and a full-body hash.
Identity, choices and note text are hashed; addresses, credentials, raw responses
and arbitrary exception messages are not logged. Unknown charge types and invalid
arithmetic still reject rather than allowing an unreviewed order.

After the failed receipt is durable, the journal atomically closes eligible
preparation as `RELEASED`: successful observed cart creation and earlier quotes,
only known cart/quote operations, no order/review approval, no financial operation
and zero reserved liability. The account becomes available for a distinct future
authorized flow, but the old flow stays terminal and cannot be resumed/replayed.
If receipt persistence fails, it is **not** released. Ambiguous create-cart,
place/payment and challenged financial flows keep their existing fences.

`commerce release-flow FLOW` applies the same receipt/evidence checks to an older
Talabat quote fence (including HTTP200 parse rejection), or to a crash after the
failure receipt was written but before journal release. It makes no merchant
request. Neither automatic nor explicit release deletes the remote cart, cancels
an app order, proves a refund or permits financial retry.

Live regression: Right Bite branch22632, Baked Chicken Tenders3739746911 with
free Dynamite Sauce3739746913, completed `--prepare-only` at AED25.60: original
subtotal34 minus `Coupon`15 plus `SmallOrderFee`1, delivery3.90 and service1.70.
Both charge types and the native free-choice `pr:0, opr:-1` sentinel are handled
without weakening exact totals or choice checks. Initial/selected quiet quotes
and fresh owned-cart readback passed. No order/payment was sent; the successful
test preparation was then abandoned locally. This is quote acceptance, not a new
paid acceptance claim. The owner's manual order was left untouched.

## Authentication and human challenges

Talabat uses its existing legitimate refresh-token grant with retained rotation
material and exact-profile checks. `commerce auth talabat shops --recover` performs
that maintenance separately from checkout. A rejected or revoked grant must stop
for the supported account-login flow; do not loop on SMS requests.

Noon retains response cookies in Keychain, reconciles them with whoami, and pins
the same account and saved Home. Main/Supermall share one auth record but distinct
checkout routing. `noon_auth_lifecycle.py revalidate-identity main` is the evidenced
native customer GET. A successful check of an already valid session does **not**
prove rejected-session renewal. `commerce auth noon SERVICE --recover` performs
bounded same-account revalidation and peer-cookie adoption, publishing only after
identity/Home validation; it never replays a mutation. Retained-cookie reconciliation
has live Minutes evidence; rejected-session adoption/import is fixture-tested only.
No refresh grant or automatic login is claimed. See NOON-AUTH-RECOVERY.md.
If bounded recovery cannot obtain valid same-account material, use native account
recovery: sign in through the original app using the
saved email and legitimate email OTP, then explicitly rebind an authorized native
capture to the same pinned account. Do not sign out or alter valid credentials to
manufacture an expiry test. No clone/root/proxy/CAPTCHA bypass is supported.

`auth noon SERVICE --diagnose-readonly` is a distinct diagnostic: it reads the
existing pinned account and performs only the established whoami/customer GETs.
Returned cookies stay in RAM; it performs no Keychain writes, login, OTP, repair,
or retry after rejection. It reports pending retention separately from auth-cookie
change and never calls valid-session success “renewal.” A rejected session gives
the supported native account-recovery action; acquired credentials still require
explicit same-account binding through the existing maintenance path.

`noon_cvv.encrypt` supports the native RSA-OAEP/SHA256 CVV envelope. The caller
supplies authorized CVV bytes in RAM and the observed payment-config public key;
the helper performs no vault lookup, storage or network operation. Minutes checks
the exact pending order and unconsumed journal before accepting this continuation.
Mobile verification or 3DS still requires the supported human challenge surface.
Preserve the exact order/payment receipt; never simulate successful challenge
callbacks or send a second order because a payment needs attention.

## Current constraints and live evidence

| Vertical | Installed supported surface | Live proof and remaining scope |
|---|---|---|
| Minutes | Multi-item journalled cart/instructions/place, encrypted CVV, 3DS wait, cookie reconciliation, exact tracking | 2026-10-11: Maxi vanilla + Marvis, IAEGAB148QT5XHKTFA, AED67 captured; exact tracking/watcher, COMPLETE. Historical single-line delivered proof remains in NOON-MINUTES-E2E.md |
| Main | Multi-item ecom cart, aggregate fee/card/quiet review across shipments, checkout-v2 place/status | 2026-10-11: Dove spray + handwash, NAEIA0096136484, AED50.74 paid, two shipments; exact manifest/watcher, COMPLETE. Not a delivery claim |
| Supermall | Multi-item rocket quick-atc, all-rocket/non-slot shipment review, absolute express promises | 2026-10-11: two Kleenex items, NAEIA0059296797, AED36.49 paid; one rocket shipment, exact manifest/watcher, COMPLETE. Multi-rocket-shipment branch remains fixture-only |
| NowNow | Multi-product single-store session, saved-card selection, both quiet flags + exact driver note, place/tracking | 2026-10-11: two tissue lines/three units, NNGABNNZQGOYY1PA, AED31.95 paid; exact native placed/watcher, COMPLETE |
| Talabat shops | Multi-item cart/quiet quote/place, saved5542 async payment/status, exact tracking | Historical paid order3949762814, AED31.56, COMPLETE. New multi-item path fixture-tested, not paid live |
| Talabat Mart | Multi-item native grocery cart, quote/place/payment and exact tracking | Historical paid order3949170955, AED21.79, COMPLETE/delivered. New multi-item path fixture-tested, not paid live |
| Talabat restaurants | Multi-item food cart, basic menu-verified choices/add-ons, exact notes/cart/quote, CCX payment/tracking | 2026-10-11: ZeroFat Hawaiian + extra turkey ham, note “No onions please”, still water; order3950661129, AED82.65 paid, exact tracking/watcher, COMPLETE. Owner subsequently requested cancellation; no retry/replacement |

`capabilities` is deliberately separate from live account/order status. A mapped
transport or passing synthetic test is not payment or delivery acceptance.
The former protein-only/single-line/order/campaign policy limits are retired.
Every lane still rejects malformed or unsupported merchant contracts. Use the
app for a genuinely unsupported basket, never to repeat an ambiguous financial
send. Basic Talabat food choices are paid-live-proven; nested subchoices are not.

### Talabat per-item notes and nonfinancial preparation

```
commerce order talabat --vertical restaurants --branch BRANCH_ID \
  --item ITEM_ID --quantity 1 --apk-pool /path/to/talabat-apk-pool.txt \
  --item-note "No ice please" --prepare-only
```

`--item-note` maps to that food line's `specialRequest`, not rider delivery
instructions or the order-level `cart.specialRequests` field. It applies to all
units of the line. Printable Unicode and line breaks are preserved exactly;
there is no arbitrary local note-length cap. The observed native 200-character
field belongs to the separate order-level note, not an item-note limit.
Nonempty notes on Mart/Shops and unsupported controls fail before account work.
Missing, changed or cross-item notes fail cart/quote/owned-cart validation.
The note participates in flow intent and approved review; a resumed flow cannot
change it. Empty-note flows retain their original scope/review shape.

`--prepare-only` performs cart creation, quote preparation and fresh exact-cart
GET, then returns `PREPARED_NOT_ORDERED`, `cart_readback_verified:true` and
`financial_send:false`. It is not read-only, but never calls place/payment or
registers an order watcher. Without the flag, this command places and pays and
requires explicit purchase authorization. `abandon-flow` can close eligible local
preparation with all sends observed, no financial operations and zero reservation;
it does not delete the merchant cart. Failed quote receipts use the narrower
automatic/explicit release path described above.

Live verification on 2026-10-11: branch667942/item1922796571 retained `No ice
please` through cart, checkout (AED31.15) and fresh GET. Flow
`71041bdf-a548-46e5-b282-7ff86089a5b0` had only observed cart/quote operations,
zero reservation and no order ID; it was abandoned locally after verification.
No order or payment was sent for that historical notes-only test. The subsequent
two-line ZeroFat order above proved notes plus a basic add-on through payment.
Repeated identical menu IDs in
recommendation and normal sections are deduplicated; conflicting names reject.

Financial review is now implemented in `noon_marketplace_review.py` and
`noon_nownow_review.py`. The orchestration modules bind their immutable results
to owned carts, fresh account/Home snapshots and the durable pre-send journal.
`checkout-check` performs read-only native preflight and reports the existing
account fence. `review-contract` lists exact native mapping gaps.

Main/Supermall now extracts populated cart `groups[].items[]`, selected
`isSelectedForCheckout`, checkout `shipments[].items[]`, `unitPrice × quantity`,
`subtotal`/`total`/`orderPaymentAmount`, invoice sections/entries and keyed delivery
options. Its selected card is the active `cc_noonpay` method's selected card from
`cards` or `cardSections`, using `id`/`mask`/`type`. AddressCode binds the separate
verified address key; session is not required to invent an addressKey echo.
Unrecognized seller/fulfillment/session variants remain unsupported; the captured
Main/Supermall flows verify their exact fee and silent-delivery shape. Synthetic
test mappings are not production configuration. NowNow review
checks actual cart fields, full monetary inventory/arithmetic and native controller
branches. Its card identity comes from the native selected card and the exact,
acknowledged journalled edit-payment request—not an invented basket token echo.
The native finalize context has five keys: paymentMethod, walletEnabled,
walletAmount, card and applePayHashedTransactionId. The no-wallet card branch uses
cc_noonpay/false/0/the selected card/null. A pre-order CVV intent branch is reported
explicitly and has distinct `preauthorize`/`prepay` journal phases. The full
reviewed amount is reserved before creating the intent; no merchant order ID is
invented. Intent secrets stay in Keychain with hashes/bindings in the journal.
`recover-payment` can only read the exact retained intent's status. A crash after
an unobserved financial send remains fenced even if later status says confirmed.
Placement attaches the exact returned order to the same reservation, without a
second debit to the campaign budget. No post-order payment is allowed on this path.

NowNow `validateBasket(true)` is mapped to POST `v1/session/validate` with only
`{sessionCode}`. `true` selects local place-order loading state, not a wire flag.
The result is shallow-merged with the current basket and fully reviewed again.
Warnings, changed totals/manifests and stale validation block continuation.

Marketplace invoice roles are not supplied by a proven native accounting enum.
`noon_marketplace_invoice.native_invoice_reconcile` supports exact observed HTML
rows with a snapshot-bound **local label review**, checks complete row coverage and
native subtotal/total/payment/credits arithmetic, and labels that limited scope.
It never turns `analyticsFeeType` into a charge code. Missing or ambiguous label
review, duplicate visible totals, unknown markup and unaccounted rows reject.

The live Main/Supermall captures established the supported account-carried
`deliveryOptions.silent_delivery.status="active"` path. The order flows verify
that exact session state rather than inventing setters for unknown controls.
The generic `set_delivery_options` adapter still rejects unsupported inactive
options. `note.content` is alternate-recipient UI copy, not rider instructions.
Do not infer a new delivery-control contract from a quiet-sounding label alone.

- Saved Home2104, saved card5542, quiet delivery, no tips/subscriptions/wallet.
- Talabat grocery carts can have account-stable IDs. Existing unrelated baskets
  are not overwritten. Reuse of an eligible released flow's identity requires
  evidence-gated adoption; a historical orphan is not a permanent branch ban.
- Restaurant exact owned-cart readback is implemented as GET `/cart/v1/{cartId}`
  with `hasOutstandingPayments=false`, no body. It verifies the original cart,
  branch, native line/menu IDs, quantities, notes/options and total. CCX line-ID
  correspondence is live-proven and rechecked, never calculated from an ID
  pattern. Food totals may move only to the exact approved quoted total.
- Noon payment client secrets remain RAM-only. Process loss without a supported
  exact order read returning that intent requires reconciliation, not another pay.
- `order-status` reads the exact persisted order with renewed/profile-bound auth;
  Minutes additionally retains response cookies. A terminal failed order stays
  fenced even when its response still contains a payment-intent token.
- Talabat's native zero `balanceAmount` is forwarded as `remainingAmount:0.0` on
  the supported payment continuation. It is not evidence of payment success; the
  full approved quote remains reserved against the budget.
- Capability is not live acceptance. See the coordinator's local checkpoints for
  per-vertical actual purchases, delivery evidence, spending and remaining gaps.

## E2E order lanes (2026-10-10 captures)

Three full paid-order lanes replay the contracts captured on 2026-10-10; see
NOWNOW-E2E.md, NOON-MAIN-E2E.md and NOON-SUPERMALL-E2E.md for the complete
lifecycles.

NowNow (`commerce order nownow`): one journalled flow over
`api-app-fd.noon.com/_svc/mp-shop-api-mpnoon/` — homepage/recent guard reads,
paymentcards + `v1/payment/subscription/list` saved-token corroboration, then
session/create → edit-product (absolute qty) → validate (fee/address/manifest
pre-place guard) → edit-payment (`prepaid` + cc_noonpay saved-card token +
mask readback) → set-delivery-preference with BOTH quiet flags true in ONE
full-state call → `add-notes` with the exact leave-door/no-bell/no-call driver
note → final session/active readback (fees+payment+quiet flags+note verified
again) → place-order `{sessionCode,total}` → `v1/order/tracking/{orderNr}` poll
until placed/preparing. The captured saved-token path used no CVV, 3DS or
paymentintent calls; this is not a guarantee against future challenges. Place-200
plus native tracking is the supported paid signal. `data.order.orderNr` is the captured
place response shape (nested under `order`, correcting the earlier HBC guess).
Cancellation remains unsupported: tracking exposes `actionCode:"cancel_order"`
and research has route/path candidates, but no verified complete cancellation
payload. An action label or route name is not enough to send a request. No guessed
cancel call was made; owner-initiated cancellation is distinct from CLI acceptance.

Main (`commerce order main`): guard empty cart-v1 basket + order-v2 active
page + catalog v3 search by exact skuConfig (string booleans, unique buyable
offer, stock minimum respected) → cart item add with readback → checkout-v2
session `{shouldUpdateSession:true}` verifying server-carried defaults
(`deliveryOptions.silent_delivery.status=="active"`, cc_noonpay active with the
unique selected default card ending 5542, addressKey == home, useCredits false,
wallet 0, total == orderPaymentAmount >= subtotal, exact aggregate shipment manifest) →
place-order `{total}` returning the bare order-nr string → order-status poll
until `success` with shipments and exact total string; paymentError is terminal
failure. A clientSecret may ride even the success response and is never
consumed. No setter calls are made: quiet delivery and default card are
account-level and verified server-side, exactly as captured on NAEIA0042714780
— this supersedes the earlier "quiet-delivery controls not established" finding
for Main, which described the pre-capture adapter scope. The corresponding
Supermall path was subsequently captured and paid live too.

Supermall (`commerce order supermall`): same checkout-v2 family as Main with
the rocket deltas only — rocket-flagged catalog resolve, the quick_atc cart
add (`POST cart-v1/cart/item/{offer}/{qty}?showCart` with both deselect flags
false in the body), an `isRocket:true / isSlotBased:false` session shipment
whose selected express promise carries an ABSOLUTE `deliveryDate` (watcher
eta), and fee arithmetic (subtotal == Σ unitPrice×qty, total ==
orderPaymentAmount ≥ subtotal). The captured rocket chain posts the checkout
family with `x-experience: ecom`, so the ordering transport binds to the shared
ecom client while the journal keeps the `supermall` vertical. The exact-track
adapter accepts the rocket order-v2 manifest's fresh `-U<digits>` fulfillment
unit binding (group-level shipmentNr with null row ids; `core.SHIPMENT`
accepts the live-verified -S/-U suffixes and `/orders/active` guard reads no
longer fail while a fresh rocket order exists — see NOON-SUPERMALL-E2E.md).

All lanes: journal at-most-once place reservation bound to the frozen review
digest, review freshness ≤ 60s, 24h `--resume-flow` window with exact live
readback (nothing re-sent; foreign manifests refused; supermall also resumes
post-place read-only to finish tracking/watcher/COMPLETE), auth rejection stops
the mutation for bounded same-account maintenance (no automatic login/replay),
watcher registration with durable
readback required before COMPLETE. Fixtures
`test/fixture_nownow_e2e_chain.json` / `test/fixture_main_e2e_chain.json` /
`test/fixture_supermall_e2e_chain.json` (+ the live order-detail manifests
`test/fixture_supermall_order_detail_live.json` and
`test/fixture_supermall_order_detail_fresh_live.json`) carry the captured
bodies hygiene-redacted (card tokens/ids, customer codes, phones, cookies
never stored).

Live lane proofs (each exactly one paid order, journal COMPLETE,
watcher readback verified): NowNow flow bbc16987… order NNGAANN4DYYYITRA
AED 31.45 (2026-10-10 15:41 → pending_approval → ready_for_pickup, rider
Imdad, estimate 04:05-04:20PM); Main flow 93970ad3… order NAEIA0055978445
AED 19.80 (pending "Payment pending" → success with shipments, total
"19.80"); Supermall flow b999304d… order NAEIA0070666081 AED 25.49
(2026-10-11 00:16 → pending → success in ~5s → confirmed/packed, rocket
express promise 01:27+04, watcher eta bound; see NOON-SUPERMALL-E2E.md).
That earlier campaign's historical reservation was 21970/25000 minor; it is not
a current cap or allowance. The 2026-10-11 multi-item acceptance above spent
AED268.83 against a separate caller-managed AED300 authorization, with no
uncertain liability and no cancellation refund credited. Live-discovered edges now
encoded: homepage `active:null` when no NowNow order is in flight; the Main
prior-order guard reads order-status (paid/success prior orders surface but do
not block; pending/unpaid stops); fresh rocket orders bind a `-U<digits>`
fulfillment unit at the manifest group level (null row shipment ids) that
rebinds as `-S1` at packing — the exact-track projection and the
`/orders/active` guard read both accept it.
