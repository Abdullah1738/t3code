# Noon checkout adapter boundary — 8 October 2026

## Result and scope

### Deployment status — 9 October 2026

The accepted module, tests and this note are deployed. The full integration
suite passed 428 Python tests, including the 40 Noon boundary tests. No new live
Noon request was made during coordinator acceptance. Installation does not
enable cart, quote or purchase operations; existing Noon tracking is unchanged.

### Acceptance freeze — 9 October 2026

The second research pass was interrupted after it stopped responding to freeze
requests. Its three original files were preserved outside the deployment tree.
An unfinished, unused `_main_cart_get` helper had no response projection or
tests and was not wired into `ReadOnlyCheckout`; it is excluded from this
release. The accepted public behavior remains the first-pass account/Home GET
and pure local validation only. No additional live cart GET is claimed.

Second-pass static findings supersede the earlier undecoded-operand notes below:
`hermesc -b -dump-bytecode -pretty=false` resolves full string operands. Main
cart GET is `/_svc/cart-v1/cart` with `dismiss` / `isPageCart` query fields;
`dismiss` is not a harmless observation flag. Minutes sync POST maps inputs to
`{skus, bundles, refresh}`; delivery-instructions POST uses
`{deliveryPreferences, driverNotes, save}`; selected-payment POST uses
`{paymentMethodCode, paymentToken, creditCardMask, walletAmount, idEmiPlan}`.
These are static mappings, not live-tested bodies or permission to call them.
Nested product/warehouse bindings, complete checkout projections and
Main/Supermall isolation remain unresolved. No new decoding or checkout probe
is part of acceptance. The historical first-pass evidence below is retained.

The synthetic `server_revision` / expiry / idempotency requirements below are
local design placeholders, not proof that Noon exposes those fields. A later
implementation must follow the actual observed contract; do not make up remote
tokens or require a hypothetical API feature instead of sound local at-most-once
reservation and authoritative reconciliation.

**No service is ready for an HTTP purchase. All mutations are unconditionally
disabled.** This is a research/safety boundary with one known account GET, not a
checkout implementation disguised as a ready adapter. No cart, quote, order,
cancel, payment, OTP, auth refresh or address mutation was attempted. No phone was
used, no browser page was accessed, and no cookies/credentials were exported.
Dia's tool catalog and profile inventory were inspected only.

Owned additions, relative to `/Volumes/ExternalSSD/t3code-fork/integrations/app-api-cli/`:

- `noon_checkout.py`
- `test/test_noon_checkout.py`
- `NOON-CHECKOUT.md`

The research pass made no dispatch/tracker/catalog edits, commit, push,
deployment or skill changes. Coordinator deployment is recorded above.
Existing tracking remains frozen. The source copies of `native_orders.py`,
`noon_http_orders.py`, `noon_vertical_reads.py`, `order_tracker.py`, and the runtime
catalog `native.py` are read-only. There is no runtime `noon_native.py` in the
provided catalog root; `native.py` is the actual implementation inspected.

## Readiness by service

| Service | Ready now | Observed contract | Concrete blocker / next observation |
|---|---|---|---|
| Minutes | Account/Home GET; pure safety validation | `InstantApi` session/cart operations and order placement use POST wrappers. `sync` maps inputs to `skus`, `bundles`, `refresh`. Separate instant session namespace. | Nested item/offer/warehouse and quantity payload; session/quote identity; complete amount/fee schema; selected-card reference and CVV/3DS path; delivery instruction values and persisted readback; at-most-once submission/reconciliation. Existing parent phone observations do not establish these HTTP bindings. |
| Main | Account/Home GET; pure safety validation | Cart GET `/_svc/cart-v1/cart` uses `dismiss` / `isPageCart`; quantity uses PUT, add POST, delete DELETE. Checkout `getSession` is POST, **not** a safe GET inferred from its name. | Query values and side-effect semantics; checkout response/selection fields; complete selected manifest vs partial checkout; seller/offer/fulfillment identity; sales-experience header; quote binding and submit correlation. No cart GET was accepted as live-verified. |
| Supermall | Same underlying account/Home GET only; separate internal service identity | Shared `placeOrderV2` accepts a sales experience. Helper recognizes `noon` and `rocket`. This does not independently establish today's Supermall UI→rocket mapping or identical cart/session semantics. | Prove current Supermall experience/header and cart namespace, selection isolation and checkout routing. Do not alias it to Main. Parent: compare Main and Supermall current carts/checkout screens and record whether selected items/cart counts cross over. UI similarity alone is not wire-contract proof. |
| NowNow | Existing NowNow credential-template→account/Home GET; pure safety validation | `NNMPBaseUrl` uses `api-app-fd.noon.com/_svc/mp-shop-api-mpnoon/`. Cart/session `active`, `recent`, `create`, product/payment/preference edits and place-order are POST. `v1/order/homepage` is GET. Catalog `ctnoon` is separate. | Full `sessionCode`/store/product/offer payloads; active-session request body and read-only semantics; delivery/replacement preferences; schedule, card and totals; idempotency and exact order cancellation eligibility. Parent: open existing NowNow store cart, note replacement/schedule controls and cancellation warning, review instructions/payment/summary without placing or clearing. |

All four need actual quote field projections. No schema inferred from tracking,
catalog prices, button titles, endpoint names or an empty basket is accepted.
Successful whoami authentication is **not** proof of a selected checkout card,
cart address, current basket, Supermall isolation, or ordering readiness.

## Evidence: observed vs inferred

### Live GET evidence

The only live URL used was the already-verified:

`GET https://api-app-st.noon.com/_vs/st/st-whoami-api/whoami`

- Two initial schema-only reads using existing Minutes/marketplace auth succeeded.
- Four subsequent reads through `ReadOnlyCheckout.account_home()` succeeded for
  `minutes`, `main`, `supermall`, `nownow` at Unix UTC times
  `1791478656.949056` through `1791478658.6260931`.
- Nonempty `customer.customerCode`; header-bound `selectedAddress.addressCode`
  and `.addressKey`; the known BanyanTree Hillside Flat 2104; exact saved pin
  `(250778251, 551569039)` in whoami integer units were checked.
- Multiple experiences pointed to the same selected address. The new projection
  checks **every matching address**, rejecting conflicting same-ID pin/text data.
- Returned projection contains service, SHA-256 equality references and check
  time, not address strings, phone, account ID or headers. No raw response saved.
- Main and Supermall intentionally use the same existing account auth loader
  for this one identity read. This is not shared-checkout evidence.

### Static APK evidence and reproduction anchors

Input supplied by parent:
`/private/var/folders/vt/8qndzr_j44z70bh0rn2zyfkm0000gn/T/opencode/noon-tracking.apk`.
APK size `213643930`, asset `assets/index.android.bundle` size `33908200`, Hermes
v98, embedded source hash `7f22f8cf886b8a369d91ad8529029e45ac10a65d`.

The bundle was read directly from ZIP into memory and piped to
`/Users/ardud/.local/share/forge-deps/node_modules/hermes-compiler/hermesc/osx-bin/hermesc`
with `-b -dump-bytecode -`. No complete bundle/disassembly extraction was written.
Filtered public-code results were emitted to tool-managed shell output only.

Reproducible full-disassembly line anchors (same supplied APK/compiler):

| Full dump line | Observed instruction evidence |
|---|---|
| 2323194 | `addToCart` calls `api.post`, dynamic `/_svc/cart-v1/cart...` path with `?showCart`, payload argument and metadata. Not a fully reconstructed request. |
| 2323241 | `getCartData` builds a URL under `/_svc/cart-v1/cart...`, two query fields from shape 19680, calls `api.get`. Literal operand is truncated by the disassembler; exact query keys remain undecoded. |
| 2323273 / 2323318 | `setCartItemQuantity` uses `api.put`; `deleteCartItem` uses `api.delete`. |
| 2343673 | Minutes `sync` reads input fields `items`, `bundles`, `refresh`, calls `InstantApi.post` under `/_svc/instant/session...`. |
| 2343750 | Minutes `setDeliveryInstructions` passes input object to `InstantApi.post`. Key/value mapping not recovered. |
| 2345947 / 2345966 | NowNow `fetch` posts caller payload to `v1/session/active`; `fetchRecent` posts `{}` to `v1/session/recent`, both with `NNMPBaseUrl.getUrl()`. Neither is an allowed GET in this lane. |
| 2345985 | NowNow `fetchHomeActive` calls `api.get('v1/order/homepage', NNMPBaseUrl.getUrl())`. No live request made; response/projection unknown. |
| 2346003–2346105 | NowNow session create/add/edit/address/payment/placeOrder wrappers call `api.post` using `NNMPBaseUrl`. Address edit supplies separate baseURL+headers shape. Input is largely passed through; payload fields need caller decoding. |
| 2346181 | NowNow `validateCart` is POST `/v1/session/validate`; do not treat validation/quote naming as read-only. |
| 2346337–2346375 | NowNow `addNote`, `setDeliveryPreference`, `setReplacementPreference` are separate POST operations. Cannot substitute a catalog request or only one quiet toggle. |
| 2346503 / 2346524 | NowNow delete-cart and scheduled-delivery are POST operations. |
| 2597524 | Minutes `placeOrder` passes caller payload to `InstantApi.post` under the instant order namespace. |
| 2920545 / 2920682 | NowNow `placeOrder` calls POST `v1/order/place-or...`; string pool has `v1/order/place-order`. `deleteOrder` explicitly posts to `/v1/order/cancel`. Existence does not establish cancellation eligibility or payload. |
| 3075140 | `getSalesExperience` returns mapped values only for `noon` or `rocket`, otherwise null. |
| 3084022 | Main checkout `getSession` posts caller argument, default `{}`, to `/_svc/checkout-v2...`. |
| 3084137 | `placeOrderV2` calls `getSalesExperience(second argument)` and optionally adds headers via shapes 18700/24978, then calls `api.post`. Header name/value mapping and Supermall callers still need proof. |
| 3084166 | Checkout `getOrderStatus` uses GET with order identifier concatenated to a static prefix. Not enabled here; response matching/reconciliation semantics unknown. |

Full relevant **string-pool** values, not automatically verified request pairs:

- Minutes: `/_svc/instant/session/get`, `/get-eta`, `/sync`,
  `/delivery-instructions/set`, `/payment/set-method`, `/payment-method/reset`,
  `/delivery-mode/set`, `/receiver/set`, `/add-address-details`;
  `/_svc/instant/order/place`, `/cancel`.
- Marketplace: `/_svc/cart-v1/cart`, `/item/`, `/items/`,
  `/select-for-checkout`; `/_svc/checkout-v2/session/session`, `/set-address`,
  `/set-payment-method`, `/set-delivery-option`, `/set-shipment-option`,
  `/resolve`; `/_svc/checkout-v2/order/place-order`,
  `/_svc/checkout-v2/order/order-status?order_nr=`.
- NowNow: `v1/session/create`, `/active`, `/recent`, `/add-product`,
  `/edit-product`, `/edit-address`, `/edit-payment`, `/set-delivery-preference`,
  `/set-replacement-preference`, `/schedule-delivery`; `v1/order/place-order`.
- UI strings include `leave_at_door_toggle`, `dontringthebell` and
  `order-tracking-leave-door`. They are not sufficient to claim all services
  expose those flags or that any flag currently persists.
- `/v2/cart` and `/v2/checkout` also appear, but the shown `getCart` wrapper is
  `digitalCardsApi`, **not NowNow**. These routes must not be conflated.

Disassembly displays many string operands truncated after a prefix, even with
`-pretty`. A matching pool string plus a suggestive function name is a research
lead, not permission to issue the call. No guessed mutation URL is in the code.

Bounded static output retained by the tool host for follow-up:

- `/Users/ardud/.local/share/opencode/shell/cc904b7ec11b436704afa183f6b5d0411608a646/sh_11c6e66620015gL0MM7cQk60DC.out`
- `/Users/ardud/.local/share/opencode/shell/cc904b7ec11b436704afa183f6b5d0411608a646/sh_11c745306001n3OVujIEw6sebF.out`

Earlier bounded research files were read-only:
`/Volumes/ExternalSSD/t3code-fork/tmp/noon-vertical-research-20261008/evidence.txt`
and `continuation-evidence.txt`. Their NowNow baseURL proof uses
`prodMPNoonNNBaseUrl`; do not reuse the guessed `mpnownow` service or the `ctnoon`
catalog base for checkout.

## Implemented local contract

These are explicitly **internal normalized types**, not Noon JSON field names:

- `ReadOnlyCheckout.account_home(service, timeout=12)`: allowlisted whoami GET,
  current Keychain loaders, absolute deadline inherited through storage/network,
  existing no-redirect/no-proxy/bounded transport; no retries or auth renewal.
  `cart()`, `quote()`, `mutate()` raise before touching auth/network. A caller
  cannot switch on mutations with `force=True` or `enabled=True`.
- `Product`: service + merchant + fulfillment + SKU + offer, avoiding same-name,
  different-size/seller/warehouse substitution. Main/Supermall are distinct even
  if an upstream service is later proven shared. Minutes/NowNow require one
  store/fulfillment pair. No auto-clear, merge or replacement of the owner cart.
- `Quote`: frozen complete manifest, integer quantities and AED fils; exact
  requested products/prices; no unexpected gifts/upsells; all adjustments and
  final total reconcile exactly. No unknown fee becomes zero. Main/Supermall
  seller distinctions remain at line level rather than assuming one seller.
- Home/account/cart/revision/delivery selection are bound. Ref fields meant for
  private opaque identifiers are hashed before persistence; no tokens/card
  numbers/CVV/OTP are part of this contract. Product identifiers may remain
  ordinary catalog identifiers; don't pass credentials as product refs.
- Saved-card method must be Mastercard ending 5542, with nonempty hashed selected
  card reference; zero wallet allocation and full final amount to that card.
  `cvv`, `3ds`, or unknown challenge blocks and requires parent handling. The
  actual selected card was **not read** in this study; tests use synthetic data.
- Quiet controls need a complete, evidence-backed inventory. Every offered
  control must be selected. Explicitly unsupported controls are allowed only
  with the complete mandated text: `Leave at door. Don't ring bell. Don't call.`
  If text is unsupported, all three controls must be selected. Missing support
  information is unknown and blocks. No semantics inferred from an absent key.
- Immutable digest binds the full validated quote, including all financial and
  instruction fields, cart/version, service and observation/expiry. Maximum
  local age 60 seconds and expiry horizon 120 seconds are conservative local
  policy, **not an observed Noon expiry**. A fresh response—even the same total
  with a new revision/time—requires a new binding. Local SHA-256 is not a server
  lock/CAS, remote idempotency token, or signed approval.
- `Attempt` is a pure journal transition seam: reserve → reconcile-required
  **before dispatch** → exact-one-match confirmed. No match, incomplete history,
  timeout, duplicate matches or ambiguous result never permits another send.
  There is no retry transition. Parent must supply authoritative exact matching;
  equality of an asserted hash alone is not proof an order belongs to the intent.
- This module does **not** persist/lock attempts, reserve across processes, send
  HTTP writes, sign authorizations, or reconcile live orders. Reusing an old
  in-memory `reserved` value is not protected. Parent's durable intent journal,
  atomic reservation and exact live evidence are prerequisites for a future
  sender. The same intent must not be retried with a new UUID after a timeout.
- Cancellation returns `eligible: null`, `executable: false` for every service.
  An endpoint named cancel, an order status, a store warning, or order age does
  not establish exact current eligibility/refund/fee conditions.

### Known transport limitation inherited unchanged

The frozen tracking whoami transport uses Python's standard JSON decoder, which
does not reject duplicate object keys. This lane did not alter it. This GET is
identity evidence only and cannot unlock checkout. Any future checkout decoder
must reject duplicate keys/nonfinite amounts, retain bounded gzip/body handling,
check application errors and identifiers, enforce one total deadline, deny
redirects/proxies/arbitrary endpoints and never log credentials or raw bodies.

## Minimal next parent work (no purchase needed yet)

1. Check phone priority-hold, then use the **normal logged-in app only**. Do not
   clone, root, log out, change proxy/VPN/TLS settings or intercept credentials.
2. Inspect existing baskets first. Record a sanitized per-service manifest and
   selected subset, cart/store identity visible to the user and current selected
   saved Home. Do not clear or replace existing items. If empty, stop with
   `EMPTY_CART_OBSERVATION_REQUIRED`; adding one shake is a separate parent-owned
   mutation, not an action for this lane.
3. Open checkout details without pressing/sliding Place Order or Pay. Those
   controls can charge immediately; a CVV sheet is not guaranteed. Record exact
   titles of all three quiet controls, supported/absent status, selections and
   text field; card 5542; item quantities/unit totals; every fee/discount; grand
   total; delivery window/scheduled choice; replacement and cancellation text.
   Opening a checkout in the app can itself POST/create/sync a session—parent owns
   that boundary. Do not present it as an HTTP read-only observation.
4. Compare Main/Supermall without moving items. UI readback answers visible
   isolation but **cannot reveal wire headers, payload fields or idempotency**.
   Finish caller/operand decoding in the same public APK for those missing
   fields. No new phone capture mechanism is authorized by this document.
5. Before enabling even one mutation, require exact request/response schemas,
   quote revision binding, server replay behavior, a bounded authoritative
   reconciliation lookup, durable local intent reservation and original-cart
   preservation tests. If normal app/source evidence cannot establish these,
   retain HTTP disabled and use the authorized app workflow. Do not keep guessing.
6. Only if later necessary and explicitly authorized, parent can place one small
   protein-shake order after all checks, register existing frozen tracking
   immediately and reconcile exact order/amount before any other attempt. This
   study placed none. Cancellation testing is not authorized by a purchase test.

## Targeted verification

Only the new offline suite was run, not the shared whole integration suite:

```sh
cd /Volumes/ExternalSSD/t3code-fork/integrations/app-api-cli
PYTHONDONTWRITEBYTECODE=1 ~/.local/share/uv/tools/mitmproxy/bin/python -B \
  -m unittest discover -s test -p test_noon_checkout.py -v
```

Final result: **40 tests passed** (0.067 seconds). Synthetic fixtures only. Covers strict Home
binding and pin, guest/wrong-flat rejection, per-service routing and zero retries,
disabled operations before I/O, cross-service/seller/offer/warehouse isolation,
manifest/price/quantity/completeness, final sum/discount handling, card5542 and
wallet/challenge blocking, all quiet controls/text, expiry, immutable binding,
ambiguous dispatch/reconcile and unknown cancellation. Additional regressions cover
missing address IDs matching a stringified `None`, exception privacy, expired
storage budgets before HTTP, blank/control-character references, oversized
timestamp integers and bounded adjustment counts. Final strict string-ID and
error-redaction hardening was verified offline; no further live calls were made.
Live checkout, concurrency journal and server replay behavior remain untested by
design.

Frozen baseline hashes: **all five rechecked unchanged at handoff**. These checks
cover the source tracking modules and runtime catalog listed below, not a rerun
of the earlier full tracking deployment gate. All three owned files are new and
untracked; nothing was staged, committed or deployed.

| File | SHA-256 |
|---|---|
| source `native_orders.py` | `7d6e5534977829df8271560bf8661251f841e5b13d941f728c44d43972eaaaa9` |
| source `noon_http_orders.py` | `57c55c8980ae393d7d8eb190f69e421606f56b67c756119507e66bf89458223f` |
| source `noon_vertical_reads.py` | `50f0b2d12af94d0da951952f5f4233970cbe3a1cdd3b14205199260a7e0e616f` |
| source `order_tracker.py` | `a053734562d6b4fa9bd3459b950207cdeff0857bade7d50f15b8f25ac63ee5f6` |
| `/Users/ardud/.local/share/app-api-cli/native.py` | `8e54434eb116dcff39753f33fee523ab5156c368b7efa7e9d8fa06d573501b4d` |
