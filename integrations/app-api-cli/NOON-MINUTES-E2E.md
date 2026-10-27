# Noon Minutes paid-order E2E replay — 10 October 2026

**Live result (2026-10-10):** one paid CLI order, end to end over HTTP only —
order `IAEGAA1483YX0EMVXA` (Grenade White Chocolate High Protein Drink 330ml
x1, AED 14.20 + 8.00 delivery + 3.00 small-order = AED 25.20), placed at
14:26 +04, owner-approved 3DS (ENBD X, Telegram-prompted), captured
(`payment_confirmed`/`CAPTURED`, authorized == captured == 25.20), exact
native tracking through `ready_for_pickup` → **delivered** by 14:38 (+12
min), watcher `order-noon-iaegaa1483yx0emvxa` registered, journal COMPLETE.
Flow `e805808c-5ec5-472a-8763-4cb01b531618`.

`commerce order minutes` performs the full paid Minutes order over native HTTP
only: active-order guard, cart session sync, quiet delivery, reviewed place,
encrypted-CVV payment completion, out-of-band 3DS wait, exact paid-signal
readback, order tracking and watcher registration. The wire contract is
validated against a real paid order captured on 2026-10-10
(`IAEGAA148ODSUNJWBA`, AED 17.25, MASTERCARD …5542); the hygiene-redacted
contract fixture lives in `test/fixture_minutes_payment_chain.json`.

## Usage

```
commerce checkout-check minutes                      # cart + active orders preflight
commerce item-options minutes --sku SKU --query "product name"
noon-search --minutes "grenade white chocolate"      # pick the exact SKU
commerce order minutes --sku SKU --quantity 1 \
    --cvv-from-keychain --label "minutes <item> x1 (CLI E2E test)"
commerce await-payment FLOW_UUID [--minutes 4] [--no-notify]   # crash-resume status wait
commerce track-exact noon minutes ORDER_ID
```

`--cvv-from-keychain` reads the saved-card CVV from Keychain
(`robob-card` / `Marriott.card_cvc`) into process RAM through a captured
`security find-generic-password` pipe. The CVV is never a command-line
argument, file, journal entry or log line.

## Flow (steps, endpoints, contract)

1. **Guard.** `POST api-app-instant.noon.com/_svc/instant/order/get-active`
   with body `{}`. Any `activeOrders[]` entry (unpaid or in-flight order from a
   crashed run or the phone app) surfaces its orderNr/status and STOPS the run
   (`MINUTES_ACTIVE_ORDER_PRESENT`). The same check runs again inside
   `place()`. There is one financial send per journalled operation. Cancellation
   alone is not no-charge proof and never authorizes a replacement order.
2. **Cart.** `POST /_svc/instant/session/get` `{}`, then `session/sync` with
   the full SKU manifest. An existing non-empty cart is never replaced
   (`EXISTING_MINUTES_CART_MUST_NOT_BE_REPLACED`). Quiet instructions
   (`dont_ring_the_bell`, `leave_it_at_my_door` + the standard driver note)
   come from the observed preference codes only.
   Required catalog option groups are checked before cart preparation. Pass
   selected codes in each items-file row's `modifiers` array; `catalog_query`
   is an optional product-name search hint. Discovery uses the read-only
   native catalog search, requires an exact SKU hit and fails closed when that
   bounded search cannot resolve the item. Missing required groups are returned
   by name with their option codes and min/max selections; defaults are never
   silently selected. A sync that drops any requested line fails immediately.
3. **Review.** `project_session` + `review_snapshot` pin SKUs, quantities,
   fee arithmetic (subtotal + fees == total), the unique saved MASTERCARD
   …5542 card (re-read from `/_svc/customer-v1/customer/paymentcards`), AED,
    no wallet/EMI/deals. Explicit provider-added `isFreebie` lines may be additional
    only with price zero, all other prices zero/null and an unrequested SKU.
    These are reported in `review.provider_added_freebies` and remain in the
    full review hash, including the pre-place check. All unexplained/nonzero
    additions still fail. Provider gifts have `qtyMax=0` because users cannot add
    them; merchant quantity caps apply to requested lines.
    The caller enforces purchase authorization and spending;
   there is no local order/campaign policy cap.
4. **Place.** `POST /_svc/instant/order/place` with body `{"total": <major units>}`
   (captured: `{"total":17.25}`) → `{order_nr, success, error_modal}`.
5. **Order readback.** `POST /_svc/instant/order/get` `{"orderNr":…}`; the
   payment `clientSecret` is the TOP-LEVEL `paymentIntentToken` field (never
   nested). `statusCode` is `pending` before payment. Fee/card fields:
   `orderSubtotal`, `orderDeliveryFee`, `orderSmallOrderFee`, `orderTotal`,
   `orderPaymentAmount`, `currencyCode`, `initialOrderDetails`,
   `paymentMethodCode`, `creditCardMask/Bin/Type`.
6. **CVV encryption.** `GET api-app-instant.noon.com/_svc/mp-payment-public/config`
   → `cvv_encryption{public_key_name:"key_1", public_key: RSA-2048 PEM}`,
   `available_payment_methods:[cc_noonpay, apple_pay, google_pay,
   adcb_touchpoints]`, `new_algorithm:true`. `noon_cvv.encrypt` builds the
   RSA-OAEP/SHA256 envelope in RAM.
7. **Complete.** `POST api-app-st.noon.com/_svc/mp-payment-api-public/paymentintent/complete`
   with the exact captured 13-key body (clientSecret, paymentMethodCode
   `cc_noonpay`, idCustomerToken, cvvEncryption{encCvv,publicKeyName},
   paymentProviderCode `NOON_PAY`, seven null optional branches) →
   `{status:"payment_pending", transaction_status:"CREATED",
   authorized_amount:0.0, reference:<order_nr>, cc_masked, cc_type,
   is_3ds_failure:false}`.
8. **3DS wait.** The challenge is out-of-band (owner approves in the ENBD X
   app). On `payment_pending` the flow immediately sends the owner one
   Telegram attention ping (key `minutes-cli-3ds-<order_nr>`, ~2 min window),
   then polls `POST …/paymentintent/status` `{"clientSecret":…}` every 5 s for
   up to 4 min. Observed transitions: `payment_pending/CREATED` →
   `payment_ready_to_redirect/3DS_ENROLL_INITIATED` →
   `payment_confirmed/CAPTURED`.
9. **Paid signal.** Exactly `status:"payment_confirmed"` AND
   `transaction_status:"CAPTURED"` AND `authorized_amount == captured_amount
   == total` AND `error_code:"0"`. Anything else — including a captured amount
   that differs from the reviewed total — is not paid. Transient status-read
   failures stay inside the wait window; auth loss surfaces
    `MINUTES_AUTH_EXPIRED_NEEDS_APP_REBIND`. Bounded same-account cookie
    maintenance is separate (`commerce auth noon minutes --recover`); no
    refresh grant, automatic login or financial replay is claimed.
10. **Close.** Exact `track` of the placed order (EXACT_ORDER_CONFIRMED),
    `order-watch add --app noon --order … --for owner --placed-at <order
    placedAt+04:00> --eta <estimatedDeliveryAt> --label …` with durable
    readback (TRACKER_REGISTERED), then journal `complete()`. The paid
    observation must precede tracking confirmation.

A window that elapses or a terminal payment failure is reported
(`MINUTES_PAYMENT_WINDOW_ELAPSED_NO_RETRY` / `MINUTES_PAYMENT_FAILED_NO_RETRY`);
the flow never re-pays. `commerce await-payment FLOW_UUID` resumes the
status-only wait after a crash (rebuilds the intent from order/get; no
mutation is possible on that path).

## Releasing a fenced never-paid flow

For a closed **cart-only** preparation, `commerce clear-cart minutes --flow UUID`
can remove the unchanged cart. First use `abandon-flow` to close eligible
preparation. Cleanup requires an observed sync, zero reservation, no order or
financial operations, no active local flow or merchant order, and the entire
current session projection matching the last response evidence hash. A later
cart writer invalidates ownership. The clear is one journalled empty sync plus
an independent empty-cart readback; an ambiguous send is fenced. This does not
cancel an order or prove a refund. Never use it concurrently with app checkout:
the provider does not expose an atomic cart revision for conditional sync.

The 17 Oct freebie, option-group and cleanup changes are fixture-verified.
Catalog option fields come from the recorded SHOT search response; customized
sync is transport/fixture-verified, not a new live paid-order claim.

A crashed run leaves a FENCED flow owning the account (deliberate anti-spin
fence). When the exact merchant state later proves the order dead, the fence
can be released — never deleted — through evidence review:

```
commerce release-flow FLOW_UUID
```

It refuses unless the binding is noon/minutes, the flow is FENCED, no payment
continuation was ever consumed, and the live evidence proves all of:
order/get `statusCode` `failed`/`cancelled` with echoed identity, absence
from order/get-active, and an unconsumed/uncaptured paymentintent/status when
an intent token is still returned. The release is terminal
(`FLOW_RELEASED_NO_PAYMENT_SENT` observation), the AED reservation stays
counted against the campaign budget, the order ID stays owned (never
rebindable), and nothing authorizes a retry. The journal's account-fence
index migrates once (same unique shape, `RELEASED` also terminal); any other
unexpected schema is still refused, not repaired.

### Closing a sent-payment flow noon reports failed (27 Oct 2026)

`release-flow` never touches a flow whose payment continuation was consumed. When
noon itself later fails that order (e.g. 3DS never completed, "could not be placed
due to a payment error" email), close it with:

```
commerce reconcile-order FLOW_UUID --close-failed
```

Reads only, on the flow's bound account: order/get with echoed orderNr and
`statusCode` `failed`/`cancelled`, `orderTotal` 0, the order absent from
order/get-active, and a successful paymentintent/status read with authorized and
captured 0, not `payment_confirmed` and no capture/authorization/settle/refund
transaction status. It refuses within 15 minutes of the place (3DS window), on any
unobserved send, a payment-success receipt or observation, prepay/preauthorize
history, a changed journal or receipts, or a failed/missing intent read. The close
is terminal (`MINUTES_CLOSED_FAILED_UNCAPTURED`, state `RELEASED`): the reservation
stays counted, the order ID stays owned, nothing is resent and no retry is
authorized. It records "uncaptured at check", not a bank-side void: a pending
hold can still show on the card until the bank drops it. First live use: flow
95df7e79 / IAEGAR1482ANIBCZKA (intent `payment_ready_to_redirect`,
`3DS_ENROLL_INITIATED`, 0 authorized/captured).

## Deviations from the capture (deliberate, benign)

- The transport sends `accept: application/json`; the app sends
  `application/json, text/plain, */*`. The full native x- header set
  (x-platform/build/experience/mp/zonecodes/ab-test/device/location,
  user-agent `okhttp/4.12.0`, cookies) is replayed verbatim from the verified
  Keychain capture, and `sentry-trace`/`baggage` are dropped as noise.
  Server responses were identical in practice.
- `payment_intent_status` binds the expected total and reference; the raw
  app client does not (it trusts the body). Stricter is intentional.
- Live-only findings (2026-10-10 replay, absent from the phone capture):
  the session now exposes a third delivery preference code
  `delivery_instructions` (left untouched; only the two quiet codes are
  set); a just-paid order reports track status `ready_for_pickup`
  ("Packing your order") before `confirmed`/`picked_up` — mapped to
  `preparing`; and a dead failed order's paymentintent/status read returns
  HTTP 400 (treated as closure corroboration in `release-flow`, never as
  payment evidence).

## Journal, secrets, fences

Every run is journalled in `~/.local/state/app-api-cli/commerce` (flow UUID,
operation hashes, receipts, observations; secrets appear only as hashes).
`paymentIntentToken`, `idCustomerToken` and the CVV are RAM-only. A crashed
run leaves an ACTIVE flow owning the account: `commerce order-status`,
`commerce reconcile-order` and `commerce await-payment` read it exactly; a
new order on the same account requires resolving it first. A FENCED
never-paid flow whose merchant order is provably dead can be released with
evidence review (`commerce release-flow`, above). These fences are
deliberate — they are the anti-spin guarantee, not permanent blocks.

## Multi-item baskets + prepare-only (2026-10-11, paid live)

`MinutesFlow(items=[{'sku','qty'},...])` (alias of the native `skus=`
constructor; `MINUTES_ITEMS_CONFLICT` on mixing both; `modifiers` defaults
to `()` per row). Minutes was already a full-manifest sync lane — the multi
work here is validation normalization, cap removal and prepare-only:

- Arbitrary caps removed: per-line qty cap, items-count cap, 100M money
  ceiling, bundle qty cap. **Merchant cap now enforced**: a session line
  with wire `qtyMax` rejects `quantity > qtyMax` in review
  (`MERCHANT_QTY_MAX_EXCEEDED`) — previously projected but unchecked.
- `flow.prepare_only()` = session → sync (full manifest, one op) →
  instructions (skipped if consumed) → independent fresh session GET →
  approve (fee schema + arithmetic + payment-token/card binding + quiet
  codes), stop before place. Fresh `payment_cards` read on every prepare;
  consumed sync/instructions are never re-sent. Fresh read-only session GETs
  are journalled separately rather than trusting the retained mutation response.
  Flow stays ACTIVE; preparation never loads CVV.
- `resume_active(flow_id, items=...)` / `resume_exact_sync(flow_id, items=...)`
  accept the items alias; scope digest unchanged (full manifest already
  hashed).

Paid live proof: flow `912d499c-8b65-4abe-ace7-d53005c8aaf3`, order
`IAEGAB148QT5XHKTFA`, Maxi vanilla shake + Marvis Whitening Mint85ml ×1 each,
subtotal59 + delivery8 = AED67. Exact prepared flow resumed without a duplicate
cart; RAM-only CVV and owner-approved 3DS reached payment_confirmed/CAPTURED.
The initial tracking read exposed native `preparing` (“Packing your order”),
now mapped with a regression. Status-only `await-payment` completed tracking
and watcher registration without another financial send. Journal COMPLETE;
watcher `order-noon-iaegab148qt5xhktfa`. This is paid/tracked acceptance, not a
new delivery claim. Synthetic coverage also includes merchant qtyMax and
consumed-write skips (`test/test_multi_basket_lanes.py`).
