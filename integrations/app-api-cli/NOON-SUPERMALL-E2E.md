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

## Checkout-v2 payment audit (2026-11-01, #239)

**Stop condition reached: the app opens a payment webview.** No payment code
was changed by this audit. A body-only patch is not a verified 3DS fix, and the
earlier frictionless proofs do not cover this branch. The CLI currently alerts
and polls where the app opens `redirect_url`; a pending response alone does not
prove that ENBD has sent an approval prompt.

Input: the retained 8 October `noon.apk` (214931048 bytes), asset
`assets/index.android.bundle` (34278052 bytes), Hermes v98, source hash
`d0701a3dd9cf80ab003916e00307a0d42abd7c6a`, asset SHA-256
`a213ec477e181c8e4b9ccb4fa85b13a064559c8c4ad93c3869f1200d12f487f3`.
This is **not** the older 33908200-byte APK asset in NOON-CHECKOUT.md.
Read the ZIP asset into RAM and pipe it to the documented `hermesc` with
`-b -dump-bytecode -pretty=false -`; filter its stdout, never save a full dump.
References below are zero-based function IDs and decimal byte offsets within
each function (`[@ N]`), which avoid pretty-output line-number differences.

- **Marketplace call chain:** `NoonCheckoutScreen` f42598 creates
  `getCvvEncryptionData` f88586, `_placeOrder` f88588 and
  `paymentStatusHandler` f88590. `_placeOrder` reaches generator f131025,
  which calls `NoonCheckoutService.placeOrderV2` at @394–451 and attaches
  its result callback f134890 at @462. This is checkout-v2, not the separate
  Minutes/Food/NowNow payment code.
- **Completion object:** f134890 @0 uses shape 40097, key-buffer offset
  567752, 11 slots: `orderNumber`, `paymentMethodCode`, `idCustomerToken`,
  `cvvEncryption`, `idEmiPlan`, `tenorMonth`, `applePayToken`, `googlePayToken`,
  `paymentType`, `installments`, `paymentProviderCode`. It fills every slot
  at @18–219, then fetches order status. f119063 @621–657 copies that object,
  adds `clientSecret` from the pending order-status response, and calls
  `PaymentService.completePaymentIntent`. There is **no `adcbTokenCode`**
  in this marketplace object. With saved `cc_noonpay` and required CVV, the
  populated core is the order, method, selected card ID, encrypted envelope,
  provider and client secret.
- **Null versus absent matters:** shape 40097's literal values start as null,
  but the instructions overwrite all 11 slots. Missing EMI selection writes
  `undefined` at @83–93; absent optional payment arguments and array entries
  likewise write `undefined` at @97–159 (arguments originate in f131025
  @727–758). Ordinary JSON omits these properties. Static evidence therefore
  does **not** justify copying Minutes' explicit-null body into marketplace.
  No marketplace CVV wire capture was made; the exact optional values still
  depend on caller/session data. Maximum constructed key set is 12 including
  `clientSecret`, not the previously suggested 13-key body.
- **Provider source:** f134890 @195–219 reads the checkout session's top-level
  `paymentProviderCode` and passes it through `ApplePayManager.getMerchantIDCode`
  (f62407). That helper preserves `NOON_PAY`, `ADYEN`, `CHECKOUT` (enum f5959
  @47–77), otherwise defaults to `NOON_PAY` at @41–72. f119063 @639–651
  carries the result into completion. Any future CLI change should use the
  packet's stricter fail-closed provider check, not copy the app's fallback.
- **CVV config route is already correct in the CLI:** f88611 @171–204 calls
  `PaymentService.getPaymentConfig` alongside the checkout session fetch.
  f29187 @22–80 uses `getServiceBaseUrl('st', 'mp-payment-api-public')` plus
  GET `/config`: production `https://api-app-st.noon.com/_svc/mp-payment-api-public/config`
  (base builder f23801 @168–378). f88586 @95–241 reads
  `cvv_encryption.public_key/public_key_name`, calls `encryptDataV2` and
  builds `cvvEncryption{encCvv,publicKeyName}`. Do not switch this to the
  Minutes-only `/_svc/mp-payment-public/config` route.
- **After complete:** f29184 @22–94 posts the supplied object unchanged to
  `/_svc/mp-payment-api-public/paymentintent/complete` on the same `st` host.
  f88590 @514–535 polls status after 1000 ms for `payment_pending` (f29185
  @65–104 posts only `{clientSecret}` to `/paymentintent/status`). On
  `payment_ready_to_redirect`, f88590 @314–499 passes the returned URL as
  `uri` to `noon.WebViewScreenWithCancel` (shape 19426/value offset 608769).
  When `use_new_webview` is true it instead calls `NoonCheckoutPasskeyUtils.handle`;
  f88658 @14–78 invokes `NativeAuthSessionModule.startMastercardAuth(uri)`.
  The webview close callback f119073 @35–47 checks `WebViewScreen.closeMessage`,
  then @390–402 reads payment status. Confirmed/failed payment statuses lead
  back to exact order status (f88590 @243–270). Neither redirect mechanism is
  implemented by the CLI, so #239 stops here as instructed.

These are static app-contract findings, not proof of which defect caused the
two 31 October timeouts. No live request, bank prompt, order or payment was
generated. Missing provider is a proven request difference; the config-route
hypothesis is disproved for this bundle, and the mandatory redirect branch
requires a separately scoped decision before implementation or a live retry.

The CLI now sends the session's `paymentProviderCode`, failing closed unless it
is `NOON_PAY`, `ADYEN` or `CHECKOUT`, and prints `payment_status_poll` lines.
Redirect handling is not built.

Live checkout-v2 sessions send `paymentProviderCode` as null (1 Nov). The CLI
maps an explicit null to `NOON_PAY`, as the app's `getMerchantIDCode` does; a
missing key or any other value still fails closed.

## Why checkout-v2 payments never start 3DS (1 Nov)

**#286 result: request differences found, but the cause of `CREATED` is not
proved. Do not spend on another guessed retry.** #272's third attempt still
returned `payment_pending / CREATED`, no redirect and no 3DS-failure flag, then
timed out. Opening a redirect cannot explain that attempt: the app only opens
one *after* `payment_ready_to_redirect`. The audit below separates observable
differences from a demonstrated fix.

Evidence: the same APK/asset/hash and decimal function-relative offsets as
#239 above, rechecked from the ZIP in RAM. Only selected function excerpts were
retained, not a complete dump. CLI comparison is against base `54b8c95357`,
including #258/#272. Header observations are a **1 Nov storage-only read** of
the `noon` and `minutes` Keychain lifecycle overlays, passed through the repo's
pure `_headers` functions; they are not a capture of the failed request. Three
bounded whoami GETs checked current dynamic-header names/types/equality, with
no cookie retention or other writes. No session POST, cart/order/payment call,
phone action, credential export, deploy or change to payment code was made.

### 1. Headers — CLI differs as follows

Both `payment_complete` and `payment_status` use the same header builder in
each lane and POST to `api-app-st.noon.com`. The marketplace order flows both
construct `MarketplaceClient('main')`, including Supermall
(`commerce_main_order.py` / `commerce_supermall_order.py`, constructor and
resume paths). Thus payment uses `ecom`, **not** the standalone Supermall read
client's `rocket`. `noon_marketplace_checkout._headers` forces `x-mp:noon` and
`x-experience:ecom`; `noon_minutes_checkout._headers` preserves their captured
Minutes values. Both force JSON accept/content-type and identity encoding,
and remove host, length, connection, cache validators and Sentry trace headers.

**Complete effective inventory (35 explicit headers in each lane):**

| Header(s) | Marketplace vs Minutes; app evidence |
|---|---|
| `x-platform`, `x-content`, `x-build` | Match each other: `android`, `mobile`, `21772`. The app sets platform/content/build in f1738 @399–485. Build is `config.build`, not a payment-specific constant. |
| `x-experience`, `x-mp` | **Differ:** `ecom` / `noon` versus `nooninstant` / `nooninstant`. Expected vertical routing, not a missing 3DS header. Global app setters: f23803 @13–63, f53246 @69–85 and f53247 @69–135. PaymentService does not override them: f29184 @65–94, f29185 @78–104. A real Rocket-context app can instead have experience `rocket`; the earlier captured checkout used `ecom`. Do not switch the payment lane to Minutes or Rocket merely because Minutes works. |
| `x-locale` | Same `en-ae`; app setter f23802 @22–44. |
| `x-device-id`, `x-visitor-id` | Present and equal between overlays; values withheld. App setters f23805 @22–44 and f23804 @28–47. No newly generated payment fingerprint in these setters. |
| `x-addresscode`, `x-addresskey`, `x-uphonecode`, `x-lat`, `x-lng` | Present and equal; values withheld. App adds selected-address/phone/location state in f23811 @156–439. CLI preserves its verified capture, rather than consulting an app store. |
| `x-device-lat`, `x-device-lng` | **Differ in value** between retained overlays; no coordinates reported. App reads current customer-device location in f23811 @311–533; CLI replays retained coordinates. This is distinct from the equal delivery-location headers. |
| `x-ab-test` | **Differs in value** between overlays. App overlays current `whoami.data.headers` on every request (f59124 @36–97 → f23811 @620–676). CLI auth revalidation merges only Set-Cookie into old headers (`NoonAuthLifecycle._exchange/_publish`); it does not adopt the returned header map. A fresh whoami GET returned `x-ab-test` as a list; retained text did not match its comma, comma-space or compact-JSON rendering. This proves a refresh/representation gap, not which experiment affects payment. |
| `x-mp-country`, `x-border-enabled`, `x-rocket-enabled`, `x-aster-zonecode`, `x-ecom-zonecode`, `x-food-zonecode`, `x-nooninstant-zonecode`, `x-noonnownow-zonecode`, `x-out-zonecode`, `x-ping-zonecode`, `x-rocket-mp-zonecode`, `x-rocket-zonecode`, `x-services-zonecode` | Present and equal between overlays. Same dynamic-header merge as above; fresh GET names matched. Fresh boolean flags matched after lowercase wire-string conversion. Their individual names are server-provided, **not** APK literals defining a closed header list. |
| `user-agent` | Same retained `okhttp/4.12.0`. Neither PaymentService nor f23811 sets a special payment UA. Actual native-stack/TLS behaviour is not reproduced by putting an OkHttp UA on Python urllib. |
| `cache-control` | Same `no-cache`; app f1738 @364–370. |
| `content-type` | Same `application/json` after both builders, even though the retained marketplace template lacks it. App f1738 @585–595. **No on-wire difference here.** |
| `accept` | Same CLI `application/json`; **both differ from app** `application/json, text/plain, */*` (f1739 @3498, shape 509/value offset 604991). Also recorded in the working Minutes capture notes. |
| `accept-encoding` | Same CLI `identity`; both discard captured compression negotiation. Native transport's actual encoding is outside these JS setters. Not a marketplace-only omission. |
| `cookie` | **Differs:** Minutes alone contains cookie name `use-st-payment`; marketplace does not. Of the 17 shared names, only `_natnetidv2` has a different value; `_nrtnetid`, `nguestv2`, `RT`, `ak_bmsc`, `dcae`, `review_lang`, `x-available-ae` and the nine `x-location-<experience>-ae` cookies match. Values withheld. App uses `withCredentials:true` (f1738 @571); CLI manually carries its lane's retained Cookie header and response rotations. `use-st-payment` has no literal occurrence in this Hermes string pool or any APK DEX inspected. Its source, path/domain and backend meaning are **unknown**, not a justified cookie to invent or copy across lanes. |

Transport also supplies `Host`, `Content-Length` and `Connection: close` in
urllib; the payment host matches the app base URL, lengths depend on the body,
and native connection management is not established by Hermes. HTTP header
case is not a semantic difference. Both builders strip `if-none-match`,
`if-modified-since`, `sentry-trace` and `baggage`; no payment dependency on
these cache/telemetry headers was found in the traced path.

**Additional app header / absence checks:**

- **CLI differs: missing `x-session-source` on checkout-v2**, not on
  `/paymentintent/complete` or `/status`. f23811 @539–612 tests the URL for
  `checkout-v2` before setting it. Cart→checkout sets `checkout` in f84319
  @25–40; f59467 @29–35 defaults to `buynow`, and the buy-now entry points
  f118609/f118620/f119430/f119444 @22–39 explicitly set `buynow`. f59469 @0–8
  returns the value; checkout cleanup f119115 @22–37 restores `checkout`.
  Neither retained lane header map has this key. It affects session/place/
  order-status requests, so it is a concrete order-context mismatch.
- **Matches the CLI at this JS boundary:** no explicit `x-forwarded-*`,
  `browserInfo`, `deviceInfo`, 3DS/browser-info header, Origin or Referer is
  added by f29184/f29185 or the entire f23811 @0–682. `x-forwarded-host/proto`
  occurrences in f20634 @14–88 are *reads* in `httpRequestToRequestData`, not
  payment header writes; `x-forwarded-acl-token` in f133249 @123–150 is read
  from a whoami response in the config-screen path. No such name was in the
  fresh whoami body header map. Do not fabricate one from a string search.
- `X-cpCode` is conditional on a collection-point selection (f23811 @447–456)
  and absent in both home-delivery overlays. The device-model/OS headers in
  f29183 @114–186 belong to `/valu/tenures`, **not** complete/status.

This is an exhaustive diff of the current **CLI header inputs/builders** and
the traced JS payment client, not a claim to have observed every native-stack
header or the live app's cookie jar. Dynamic server headers and native
interception are reasons a wire capture is still needed.

### 2. Body — no hidden 3DS fields; one type/source difference remains

**Matches the CLI's core fields:** f134890 @0–219 constructs the previously
documented 11-slot object. f119063 @621–657 spreads it, adds `clientSecret`
and drops a nullish provider; it adds no browser/device/return/redirect URL,
channel, platform or 3DS flag. f29184 @75–94 passes the body argument unchanged;
its second argument is optional *request config*, unused by f119063 @657.
The registered request interceptor f23815 @0–17 calls f23811, whose writes are
headers only. Axios f23841 @92–196 applies the request transform; f23880
@397–430 → `stringifySafely` f23834 @78–105 does ordinary JSON.stringify for
this object, without augmenting it. Status remains only `{clientSecret}`
(f29185 @65–104). No evidence supports adding `browserInfo` or Minutes' seven
explicit-null optionals to this path.

**CLI differs in card source/type handling:** the app selects the `isSelected`
card from `paymentMethodsV2.methods` (including flattened `cardSections`),
f88613 @20–174, predicates f119108 @6–46 / f119109 @0–16 / f119110 @0–9.
It copies that card's `.id` directly into `idCustomerToken`, f134890 @38–63;
there is no string coercion in that path or the JSON transform. CLI
`MarketplacePayment.prepare_payment` selects from legacy `paymentMethods`,
requires default+selected+last4, and `card_token` converts a positive integer
to a decimal **string**. Consequently a numeric V2 ID stays numeric in the
app but is a string in the CLI. The failed run's V2 selected ID/type was not
read here; legacy/V2 equality and whether noon cares about the JSON type are
unproved. Minutes' working captured token is a string, which does not settle
the marketplace contract. Preserve exact ID precision and existing selection
checks; do not change this on a guess.

For required CVV, the envelope matches: f88586 @95–241 uses the config's public
key/name and `encryptDataV2`; f29190 @0–117 encrypts a string with RSA-OAEP
SHA256 and Base64, matching `noon_cvv.encrypt`. **A separate conditional
difference:** f88586 @49–93 returns without encryption unless method CC and
`isCvvRequired` is truthy; CLI sends an envelope whenever a CVV was supplied,
even if the session says false. That is not evidence of the cause in these
reported CVV-required attempts.

### 3. Extra steps — pending path matches; conditional branches differ

**Matches the CLI between successful place and pending complete:** f134890
@223–227 invokes the local post-order-message helper (bound in f42598
@2198–2204, implemented as a React state-setter call in f87928 @0–17 via
f42334 @242–249/@303–313); @302–354 reads exact order status. f119063 @540–674 completes
the returned intent. f119067 @13–28 passes its response to the status handler.
For `payment_pending`, f88590 @67–73 jumps straight to @514–535's one-second
timer; f119071 @52–64 then calls `PaymentService.getStatus`. No enrol/initiate/
authorize, device-data-collection or Checkout.com/Cybersource SDK invocation
exists in this traced pending branch. The CLI instead interleaves order and
payment reads, sleeping up to two seconds (`MarketplacePayment.await_success`).
The timing difference does not establish why an intent stays `CREATED`.

**CLI differs in two conditional branches:**

1. **Before place**, f131025 @762–795 awaits `checkBNPLEligibility`
   (f42598 @409–427 → f88584/f88585 → f119060 @17 → f131024).
   f131024 @488–543 reads session `bnplEligibilityCheckApi/Payload`; when the
   API is falsey it returns `{is_eligible_customer:true}` **without HTTP**.
   When supplied, @545–619 posts that payload plus selected-address `phone`
   via f29186 @22–81 to the session-provided path under the payment base URL.
   CLI has no such branch. The retained Main/Supermall fixtures have no
   non-null eligibility API; no fresh checkout-session POST was allowed here.
   Thus it is not a proven saved-card prerequisite, but it cannot be dismissed
   merely because the function is named BNPL. A nonempty current value needs
   separate scoped evidence, not an arbitrary new endpoint/retry.
2. **After ready-to-redirect**, f88590 @314–499 opens the webview/native auth
   already recorded in #239. CLI only alerts/polls. This missing continuation
   remains real, but is unreachable in #272's observed pending/no-URL state.

Payment config is fetched with session setup before place (f88611 @171–204);
CVV encryption is local before place (f131025 @130–177). There is no additional
checkout session refresh in the traced place-success→complete→pending path.
These claims are bounded to this retained bundle/path, not every payment
method, current backend behaviour or downloaded webview script.

### 4. Place flags — body matches the CLI

**Matches the CLI:** f131025 @408–424 creates exactly `{total:session.total}`;
@428–451 supplies `currentMarketplace` separately. f41082 @22–100 turns that
second argument into an optional **header** override, `x-experience`, then
posts the original body to `/_svc/checkout-v2/order/place-order`. The mapping
is `noon→ecom`, `rocket→rocket` (f12591 @66–76; f41006 @9–38).
There is no paymentMethodCode, is3ds, payment_flow or payment_option in this
place body. CLI `operation('place')` and both order classes' `place()` send
only total too. Do not add guessed order/payment flags. The missing
`x-session-source` and runtime experience/header-state issues in question 1
are the order-level differences, not omitted JSON flags.

### Smallest follow-up, and what would actually settle the failure

The smallest **proved request-parity correction** is in
`noon_marketplace_checkout._headers`, with operation/path context threaded
through `MarketplaceClient._call` and `native_request`: set
`x-session-source: checkout` only for this cart-based lane's
`/_svc/checkout-v2/` requests. Do not attach it to paymentintent, cart-v1,
order-v2 or Minutes; do not change `ecom/noon` routing. Test Main and Supermall
session/place/order-status plus negative assertions for complete/status,
cart/detail/refund and Minutes. This corrects a static mismatch; **it is not
yet a demonstrated fix for 3DS**. The auth refresh gap belongs in
`NoonAuthLifecycle._exchange/_publish`, but copying arbitrary whoami headers
could overwrite account/Home/routing fields: specify and test its safe
merge/serialization separately rather than hiding it in a payment patch.

**Recommendation: one owner-approved real-app Supermall saved-card CVV
capture before another CLI payment.** Start before checkout session refresh;
include the session's legacy and V2 selected-card **types and equality**, BNPL
API presence, config, place, first order-status, complete, status transitions
and redirect/native-auth handoff. Capture effective request headers and cookie
name/domain/path/presence (especially `use-st-payment`), and compare opaque
values only in RAM. Retain a redacted schema/type/diff fixture, never tokens,
cookie values, CVV/ciphertext, client secrets or raw redirect URLs. This single
trace establishes the app's actual source header, dynamic headers, card JSON
type, cookie presence/scope and any pre-complete calls on the presently installed
version. A cookie already present before capture still has unknown origin unless
its earlier Set-Cookie source is retained. It requires phone use and a small purchase, **neither authorized nor
performed by this card**. If the real app also stays CREATED, client parity
alone is not the explanation and noon-side evidence is needed.

Do not synthesize `use-st-payment`, force 3DS flags, copy Minutes' nulls or
weaken reservation/consume-before-send, exact-order binding, MAY_HAVE_SENT,
recovery-only or no-resend guards. No additional financial send is proposed
for an existing flow. Siblings checked: Main/Supermall shared transport and
payment mixin; Minutes transport/complete; await-payment/recovery paths;
order-watch's payment-unconfirmed hold; #239/#258/#272 and the noon skill.
This doc changes none of their behaviour. No runtime config, skill/watcher
edit or deploy is required; future code/capture work needs its own approval.

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
