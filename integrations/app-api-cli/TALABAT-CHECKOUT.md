# Talabat checkout — contract research and historical observations

## Current implementation (14 October 2026)

The disabled-adapter and test-scope statements in the dated research below are
historical, not current CLI restrictions. `commerce order talabat` now supports
arbitrary catalog items and multiple lines in Mart, Shops and Restaurants via
`--items-file`. Restaurants support live-menu-validated choices/add-ons,
one-level nested subchoices and exact item notes. `sub_choice_ids` contains
integer option IDs from the selected parent's `sub_categories`; required and
optional child groups obey their live bounds. Empty required groups fail before
cart creation with `MENU_SUBCHOICE_SECTION_BOUNDS_FAILED`. Nested parent quantity
must be 1; deeper child groups remain unsupported. Item quantity may exceed 1.
The native payload uses `subChoiceIds`, while cart echoes flatten IDs in `choices`
and retain parent ownership in `choicesDetails[].subChoicesDetails`. Verify both.
Native numeric `opr:-1` uses the valid current price as the original-price anchor
for both items and paid/free choices. Choice costs apply to every item unit.
Prepare-only proof: two Large Peach Iced Teas at Dunkin676187, AED42 subtotal /
AED44.10 payable, exact quiet quote and cart readback, then abandoned; no purchase.
Nested prepare-only proof (14 October): Latea745022 Brown Sugar Boba With Milk,
two Cold700ml with 50% Sugar + paid Crystal Jelly, plus a separate Cold700ml with
25% Sugar. Two distinct rows, three units, AED65.25 payable; initial and quiet
quotes plus fresh owned-cart GET verified. Flow2399abbe-4ca8-44d0-9c08-884cbf1b086e
was cleared with captured per-line quantity-zero PUTs, empty cart GET verified,
then released. No order or payment was sent; nested paid-order proof is pending.
There are no local category/count/quantity/spending-policy caps. Caller agents
enforce authorization and budgets; exact Home/card5542/quiet, merchant constraints,
foreign-cart ownership and financial-at-most-once checks remain mandatory.

Paid multi-line restaurant acceptance: order3950661129, ZeroFat Hawaiian Pizza
with extra turkey ham and “No onions please”, plus still water, AED82.65;
exact native tracking, registered watcher and journal COMPLETE. The owner later
requested cancellation himself; that is not a checkout failure or permission
to retry. Mart/Shops have historical single-line paid proof; their new multi-line
path is fixture-tested, not paid-live-proven. See COMMERCE-HTTP.md for current
commands, evidence levels and recovery. The old AED50 offline draft bound and
protein-test restrictions below are historical evidence, not active policy.

### Quote rejection and recovery (11 October 2026)

Right Bite branch22632/item3739746911 with free choice3739746913 exposed three
parser gaps: native `Coupon` discount, `SmallOrderFee`, and the free-choice
`pr:0, opr:-1` original-price sentinel. All are now supported with exact totals:
AED34 -15 +1 +3.90 +1.70 =25.60. Live `--prepare-only` passed initial and selected
quiet quotes plus exact owned-cart readback; no order/payment was sent.

An unparseable/unavailable CCX preview is a nonfinancial `PREPARATION_FAILED`,
not an ambiguous order. Durable receipts retain safe parser code/class, a bounded
redacted monetary projection and the body hash, never raw account responses.
Eligible cart/quote-only failures atomically become terminal `RELEASED` with zero
reservation. `commerce release-flow FLOW` also handles legacy quote fences after
validating immutable receipts and all prior observations. Ambiguous cart creation,
place/payment and financial reservations are not released by this path. It neither
deletes the server cart nor cancels/refunds an order. See COMMERCE-HTTP.md for the
full evidence gate and diagnostic contract.

## Historical status (9 October 2026)

Status: **readiness and three bounded quote observations implemented; pure place
contract, evidence-derived local review, at-most-once journal and no-send adapter
implemented, submission still disabled**.
General cart replacement, quote, commit and cancel remain disabled. There is no
place transport or managed ordering CLI. All historical cart/quote write intents
are consumed. This is not an executable HTTP ordering adapter; no purchase is
needed to test the offline contracts.

**Current operational state (9 October 2026): the one permitted
Quest add POST has already succeeded. Its API-only cart is still present; no
cleanup or purchase occurred. Three later quote POSTs succeeded, as recorded below.
Never rerun/rehome/delete any consumed intent.** The earlier original-app empty
observation does not establish API-cart cleanup. See the lineage limits below.

## No-send adapter and decoded dispatch — 9 October 2026

This section supersedes earlier unresolved-getter/HTTP-verb statements. Offline
snapshot decoding recovered the missing dispatch targets and independently checked
364842 entries and120749 raw instruction entries against the original ELF bytes.
No application entrypoint or payment function was executed.

- The place-response transactionId, orderId and balanceAmount stored in AFg feed
  eTransId, orderId and the nullable floating-point remainingAmount parser,
  respectively. There is no fixed minor-unit conversion in that parser.
- Ucb and tla payment transport implementations explicitly set **POST**, targeting
  the release base plus `/pay/v1/payments`. Jbh decorates and forwards the selector;
  exact live client, environment and successful host/path overrides remain unproved.
- UUID wrappers are newly constructed but may share a lazy cached holder. Same
  registration/scope and no intervening reset yields the same String; arbitrary
  place/payment instance equality is not established. The async handler passes
  one captured acceptance ID to both payment and status calls. The checkout
  success path clears the holder. None of this establishes backend idempotency.
- A generic401 refresh-and-resend interceptor exists. Its attachment to the exact
  payment client remains unresolved. A single wrapper invocation is not proof of
  a single network attempt; any future mutation transport must prohibit automatic
  auth replay, retries and redirect resubmission. The native duplicate guard permits
  matching requests after **strictly more than three seconds**, not safe replay.

`talabat_payment_route.selected_payment_event` validates a private, seven-key
selected saved-card event candidate. It requires explicit `talabat`/`sync`, exact
method2/7 and saved5542 tokenId, typed method names/card/routing fields, and rejects
raw prePayment (including ForceCVV), selected/postPayment events, wallet/mixed or
unknown paymentMode, replacement instrument and polling configuration. Falsy
unsupported values do not become absence. Native unknown-platform/type defaults
are not copied. It is **not** the enclosing17-field payment body and does not
establish which effective fallback/controller route the app would use.

`talabat_order_adapter.prepare_review` composes that route check with the full
local fresh-review contract. `rehearse` verifies exact acknowledgement binding and
post-ack refreshed observations, then conservatively projects supplied place,
payment and exact-order outcomes. All config data is hash-bound, so candidate
routing drift invalidates approval even when price/card stay the same. Neither
function consumes a journal, fetches data, authenticates, polls or sends anything.
`submit` always fails before any IO, regardless of supplied flags or digests.

The rehearsal explicitly retains false for effective native route, trusted owner
authorization, fresh provenance, precharge amount enforcement, financial completion,
request idempotency, send/readiness and commit. Even a supplied status success plus
delivered exact-ID tracking is not a proven financial receipt. Isolated tests
compose the permanent journal separately; no real journal has been created.

## Evidence-derived local review — 9 October 2026

`talabat_fresh_review` is a pure consistency layer, not a live quote command or an
owner-authorization service. It does not fetch, access credentials, consume a
production journal, send an order, or enable the existing disabled entry points.
Its raw input bundle stays private and is discarded after deriving hashes and a
safe display. All inputs are supplied observations, not authenticated provenance.

- `build_review` requires account/profile, saved addresses/cards, vendor, before
  and after carts, payment-config request amount and response, the actual prepare
  body, full quote, and explicit payment-requirement observation. It independently
  validates the saved Home/customer and unique5542 card, scope, type-exact cart
  consistency, selected-card prepare body, fee sum, quiet presets and no extras.
- Eight journal-compatible bindings are derived from that data, not supplied as
  arbitrary hashes. The permanent account key depends on stable account ID/country,
  not mutable phone/profile data. A changed phone still invalidates the review but
  cannot sidestep a consumed account fence.
- Payment-config amount must equal quote payable; cart subtotal must equal the
  quoted item subtotal. This validates supplied request context only: the config
  response does not independently prove what amount was requested.
- Reviews expire within120seconds of the **oldest observation**, checked against
  wall and monotonic clocks. Clock rollback/skew, expired data, altered fields and
  cross-process restoration fail closed. Display data is detached from inputs.
- `bind_acknowledgement` accepts only the exact local review decision/digest and
  binds it to same-process wall/monotonic timestamps. It is not owner identity
  verification. A future trusted interaction adapter must provide the actual
  decision and capture its clocks when received, not recreate historical approval.
- `check_approval_binding` requires matching revalidated bindings and observations
  starting strictly after the acknowledgement in **both clocks**. Revalidation
  cannot extend the original review's expiry. Fee splits, raw quote changes, Home,
  card, cart and instructions drift all require a new exact review.

All projections retain `owner_authorization_verified:false`,
`fresh_server_provenance_verified:false`, `ready_to_order:false` and
`commit_enabled:false`. Local equality is not permission to send. Synthetic tests
compose reviews, the temporary journal and pending/unknown/challenge responses;
every post-send outcome keeps the permanent fence, including a new cart/digest.

### Price binding: no-go for live enablement on current evidence

The recovered place request contains no approved amount, quote revision, expiry
or server price-lock token. Fresh local equality cannot enforce the final server
charge during the race between review and submission. Do not invent a wire field
or charge first and compare later. Enabling ordering requires a proven server
price binding or a supported staged-payment boundary exposing the exact charge
for fresh authorization before any payment, in addition to payment completion,
request/response correlation and the permanent no-retry fence.

The decoded getter chain closes a narrower fact: place-response `balanceAmount`
feeds the payment request's `remainingAmount` through nullable floating-point
parsing. It does **not** establish the amount's currency/units, that it is the full
charge rather than a remainder, or that the server enforces it. The place parser
defaults absent balance to `"0.0"`; zero is not a free/paid assertion. The later
payment body carries no explicit approved-total cap or quote-lock token.

Likewise, the app's payment-pending state does not prove that `placeOrder` is a
charge-free staging operation. It must not be invoked just to discover a later
amount. No exact precharge receipt/enforcement contract or supported charge-free
staging guarantee was established. This is a limit of the available evidence,
not a claim that Talabat has no server-side price protection. A test purchase
would not prove those guarantees. Keep the entire live path disabled; use native
checkout for a genuinely requested order unless the missing contract is resolved.

## Payment continuation and outcome boundaries — 9 October 2026

Further static tracing recovered the registered checkout-to-payment callback and
the router. Selection uses the effective payment event's **platform and sync/async
mode**, not paymentMethod2/addTPayMethod7 alone. The Talabat request route serializes
17 fields for `/pay/v1/payments` and supplies `x-acceptance-request-id`. HyperPay has
a separate saved-card SDK continuation. This is not yet an executable saved5542
payment contract; concrete routing, amount semantics, URL overrides, exact
identity scope and challenge handling require further proof. Transaction getters,
POST dispatch and parts of the identity lifecycle are now closed as above.
Top-level cardToken
belongs to separate tokenization state and must not be filled from saved tokenId.
The earlier selected event.cardId = saved tokenId = place.cardTokenId binding is
not proof of identity through an effective fallback or mixed-payment route.

A recovered three-second native duplicate guard is only a local debounce. It
allows later repeat requests and is **not server idempotency or safe-retry proof**.

The follow-up closed three narrower details without live calls: remainingAmount
uses nullable floating-point string parsing with no fixed minor-unit conversion;
the static release payment base URL is `https://api.talabat.com`; and the request
ID provider lazily caches a UUID-v4-formatted value. This does not prove the input
amount's financial units, the concrete URL override, or that every place/payment
instance shares one holder lifetime. The later decoder closes the HTTP verb;
the registration/reset findings above narrow but do not erase the identity gap.

### Pure status and exact-order comparison

`talabat_payment_outcome` contains no fetcher, payment builder, polling loop or
callback executor. `project_payment_status` interprets a supplied v2 body with
five recovered nullable fields: `status`, `error`, `fallback`, `redirectUrl` and
`hyperPayCheckoutId`. The transaction-keyed route is `/pay/v2/payment/status`;
its body has no echoed order/transaction, charge amount, currency or charged card.

- Exact `success` is an **unbound payment-flow success signal**, not a verified
  payment for this order. Identity/request association must be established outside
  the body; no current flag upgrades it to payment completed or settled.
- `pending` or absent status stays pending; unsupported casing/aliases stay unknown.
  `failed`, `cancelled` and `aborted` are not invented as recovered terminal enums.
- Redirect, fallback method and HyperPay checkout continuation stop. No URL is
  opened, fallback card selected or SDK invoked. Error/abort/timeout never proves
  no charge, reversal, cancellation or safe retry.
- Error fields, URLs, checkout IDs, telemetry and raw response values are never
  included in the safe projection. Unknown extra financial-looking fields cannot
  become a payment receipt.

`project_order_readback` compares a supplied exact tracking identity only with an
order ID actually received in the place observation, including one retained after
a later parse error. It rejects bool/float/loose ID coercions. Recognized preparing,
out-for-delivery and delivered stages are separate fulfilment claims; an unknown
stage is not acceptance. The projection explicitly reports that local identity
equality is not authenticated fresh readback, bank settlement or a charged amount.
No nearby history record can replace a missing place-response ID.

The final native checkout-success callback carries an enum and cached order
context, not a new amount/card receipt. `MakePaymentDone`, `GetPaymentStatusDone`
and postcheck-validation fields are telemetry, not exact payment verification.
The newly recovered status route needs an already-known transaction identity;
it does not recover a lost place response or permit another submit.

Offline acceptance for this expanded milestone:105 focused tests (29 fresh review,
23 payment outcome,36 place contract,17 journal),571 full Python tests and14 Node
transport tests pass sequentially. Independent read-only checks found and resolved
one approval clock-ordering defect and two outcome edge cases. A prior full run
hit two existing elapsed-time assertions during host CPU contention; the isolated
cases and subsequent full run passed without changing those tests or modules.
All data is synthetic and journals temporary. None of this is live payment proof.

## Offline submission safeguards — 9 October 2026

This section supersedes historical unimplemented-contract statements below. The
new code has no HTTP/auth access, CLI, payment completion, or live journal adapter.
Static contracts come from the original Android13.95.0 app; current raw private
quote data was not retained and has not been re-observed for these checks.

### Pure saved-card draft

`talabat_place_contract.place_body` builds only the bounded ordinary-delivery
saved-Home/card5542/one-Quest branch. It validates offline quote consistency,
strict type equality, current cart-ID echo, exact manifest, AED amount/fee sum,
Home/unit and supported quiet controls. The exact prepare body must match the
selected-card context; it is not reconstructed and passed off as sent evidence.
Malformed fee rows are rejected rather than filtered out. Its AED50 cap is a format/scope bound,
**not authorization**. It does not establish freshness, account provenance, an
immutable server price, or absence of a later payment requirement.

- The independently recovered place serializer has17 base fields; it is not the
  prepare body. `cardTokenId` comes from the same selected event's `cardId`, bound
  to saved `tokenId` rather than `token`; method/BIN/fingerprint come from that row.
- Both `saveDeliveryInstructionsForLater` and `saveRiderTipForLater` are explicitly
  false. Supported selected instruction IDs stay in native order. Saved Home
  address fields are unchanged, including the native country-code string alias.
- `allowDuplicateOrder`, `proSubscribeChecked` and `quickCheckout` are false;
  `proPlanId` is null. The explicit absent-tip branch is null/null, independent of
  the false save flag. `priorityLevel` is empty and `flow` null: supported branches,
  not a claim of exact ordinary UI runtime replay.
- No wallet/dues/features/top-level device-coordinate fields are copied from
  prepare. Wallet selection and known CVV/unknown payment requirements block.
  No unsupported rider-note, CVV, OTP, save-card or saved-address switch is invented.

No-save false is statically supported, **not live-tested server persistence** and
not a request to delete past saved defaults. The full place body remains private
in memory; never log or persist it.

### Response interpretation: 200 is payment pending

Native parser `0x168eb2c` requires `placedOrder.orderId` and `transactionId` strings.
`balanceAmount` is a string defaulting to `"0.0"`; `redirectUrl` is a string
defaulting to empty. Ordinary success at `0x16919fc..1ad4` **unconditionally emits
PlaceOrderSuccessPendingPaymentState**. No parsed field proves the card was charged
or the merchant accepted the order, even if balance is zero and redirect empty.

`parse_response` and its safe `project_response` therefore:

- report `PAYMENT_PENDING` on a supported200 response, never paid/completed;
- stop on SMS/mobile verification or a nonempty redirect, without executing error
  actions, following links, inventing callbacks, or retrying;
- treat dropped responses, schema errors, non200 statuses and generic/duplicate
  errors as `SUBMISSION_UNKNOWN`, with `retry_allowed:false` in every case;
- privately retain any valid returned numeric1–20digit order ID for a future
  exact-ID readback, including when the rest of the response is malformed;
- project only fixed states/reasons/booleans, never order/transaction IDs, URLs,
  balance strings, telemetry, account details or server error text.

ForceCVV is a separate native payment-config discriminant, not a guessed response
JSON key. The exact saved-card payment handler and legitimate3DS completion flow
remain unproven. No cart/request/transaction-to-order lookup was recovered. An
empty order list or similar time/amount/items cannot reconcile a lost response.
Existing exact-order tracking can verify only an actually received order ID and
does not by itself prove card settlement.

### Durable local fence, not server idempotency

`talabat_submit_journal` validates an explicit localv1 review (eight SHA256 bindings:
account/cart/Home/card/items/charges/instructions/request; AED integer minor amount;
local freshness window at most120s). Digest equality is only a local consistency
check: a future adapter must derive current facts and obtain fresh exact approval.

Consumption uses SQLite BEGIN IMMEDIATE, a permanent account-unique fence,
FULL/fullfsync and a committed `MAY_HAVE_SENT` record before returning. Observation
states now include `PAYMENT_PENDING`; observations never release the fence. No
second automatic order, reset, unlock or ambiguous retry is implemented. Storage
is private, owner-only, no-follow, and rejects unsafe/corrupt paths instead of
repairing them. Both database and new-directory entries are synced; the existing
private state parent must exist rather than being silently recreated. Only
hashes/local operation IDs are stored, not raw account data.

The real journal has not been created or consumed. The submission entry point
still fails unconditionally before auth/journal/network work. Enabling a future
adapter requires the proven exact payment-completion path, fresh live bindings
and explicit current quote authorization. Historical receipts cannot supply them.
No live quote/cart/order/cleanup/preference/phone action was made in this phase.

Offline source acceptance:53 focused tests (36 place contract,17 journal),519
full Python tests and14 Node transport tests pass sequentially. Runtime catalog
selection also passed15 tests before deployment. The tests use synthetic data,
temporary journals, mocked HTTP and a loopback-only network guard. They verify
crash/concurrency/no-retry behavior but are not live purchase/payment evidence.

## Quote observation progress — 9 October 2026, 01:34 Dubai

`talabat_quote.py` adds parent-only one-shot prepare observations, not ordering.
Initial nullable-payment, selected saved-card, and final payable-context reviews
each returned HTTP200 from `/ccx/v1/checkout/{fresh current grocery cart ID}`.
The version is the explicit native false-fallback branch, not an observed account
feature flag. Payment-config amount first used the subtotal20.25, then observed
payable30.14. These are explicit exploratory contexts, not exact app replay.

Final live observation (with projection limitations below):

- tracking.cartId equals the fresh current GET ID; sole Quest itemGuid/quantity1
  match. The historical cart POST ID remains lost; no cleanup authority recovered.
- Saved Home was independently verified; quote coordinates/area match, and its
  description contained2104. Country4/currencyAED match.
- Item20.25 + delivery8.99 + service0.90 = payable **AED30.14**; returned item price
  and total projected as20.25. Post-quote GET retained the same ID/sole item/subtotal.
- Chosen enabled5542 payment row's cardId equals saved tokenId, not token;
  method2/addTPayMethod7, binNumber/cardFingerPrint and chosen supportedFeatures
  were mapped through the actual native selected-config mapper. No selected wallet
  event exists, so walletBalance is null. No card token was submitted for payment.
- **Leave at my door selected; Don't ring doorbell selected; Call on arrival
  unselected.** Message on arrival unselected. This API response exposes a door
  control that the earlier phone observation did not; do not repeat the old claim
  that the current quote has no door control.
- No tip option selected and no tip line charged; subscription absent. Tip
  save-for-later remains selected in the response. Instruction save-for-later
  defaults true. Neither was changed, and any later commit must explicitly prevent
  unwanted saved-preference changes via evidenced fields.

There is no recovered dedicated rider-note field. Preset instructions are proven;
cart.specialRequests was **not** misrepresented as a rider note, and saved address
extra_directions was not changed. Quote-for-review is not ready-to-order: exact
card payment/challenge handling, per-order no-save policy and commit reconciliation
remain unimplemented. `talabat_checkout.commit` and general quote/cart/cancel
entry points remain disabled. No public ordering CLI was installed.

Three permanent dated quote intents in the current coordinator workspace are
consumed: `talabat-initial-quote-20261009.intent`,
`talabat-card-quote-20261009.intent`, `talabat-payable-review-20261009.intent`.
Never rerun their launchers or delete/rehome markers. Private IDs, card data and
raw responses stayed in RAM; safe receipts contain amounts, preset labels, field
types and equality booleans. No order, charge, cart replacement/clear, phone use,
SMS, saved preference API or subscription action occurred. The unpaid cart remains.

Post-observation review found and fixed five defensive gaps: arbitrary alphabetic
labels/keys in projections, ignored explicit branch contradictions, Python
bool/int/float equality in body validation, display-money sign stripping, and a
unit substring check. Seven red-capable regressions now cover them. The response
was not retained, so the stricter price-display and complete-unit-token checks
were **not** rerun against that live response; historical item-price/unit booleans
must not be promoted into those stronger guarantees. Numeric fee/total fields,
exact current cart ID, itemGuid/quantity and the known six preset controls remain
the recorded live evidence. No additional quote was sent to retest projections.

Acceptance:38 focused quote tests and466 full integration tests passed;14 Node
transport tests and15 catalog tests passed sequentially. An existing auth test's
40ms signal-timing race was made deterministic at its mocked storage seam; no
production auth/renewal change. All quote intents remain consumed, and there is
no repeatable send command or order placement capability in this release.

Source/static details and safe receipts: current coordinator
`tmp/quote-phase-plan.md`, `tmp/talabat-quote-inputs-research.md`,
`tmp/talabat-payable-review-safe.json`. Deployment/test status is recorded in the
phase checkpoint; historical source-only sections below are not current state.

## Deployment acceptance — 9 October 2026

Readiness and bounded-probe source/tests are now deployed; this does not enable
general checkout or authorize a second cart probe. The full integration suite
passed 428 Python tests (48 checkout tests), and the separate catalog selection
passed 15 tests after deployment. Existing Talabat auth/tracking modules and
wrappers are unchanged. Acceptance made no Talabat live request or phone action.
The outstanding unpaid API cart was not cleared; its three permanent intent /
receipt files were verified unchanged. The discarded private cart ID prevents
safe lineage-based cleanup, so the original app being empty is not cleanup proof.

## Verified on 8 October 2026

The final CLI run at 15:39:30 UTC / 19:39:30 Dubai made five bounded GETs:

1. Verified the live profile against the existing Keychain account binding.
2. Found exactly one saved card ending **5542**, country 4, `isValidCard: true`,
   `isExpired: false`, `isForceCvv: false`, and nonempty saved token fields.
   Two-digit expiry years are normalized to 2000+year; month/year were current.
3. Selected the unique saved Banyantree Home/unit 2104 belonging to that profile.
   Reads use its actual Talabat coordinates and area, not the approximate shared
   catalog pin. Coordinates, address IDs and contacts never leave memory.
4. Resolved exact grocery branch **798285** to its live DH vendor and chain IDs.
5. Read `/grocery/v2/cart`: HTTP 200, an opaque nonempty ID, `items: []`, and
   `subtotal_after_discount: 0`.

The empty result is scoped to that account-header/branch request. The response
does not echo a customer binding. A later parent observation below positively
confirmed app/API cart divergence, not merely a missing synchronization test.
It does **not** authorize replacement or imply a free
checkout. The card read proves stored-card readiness, not payment selection,
saved-token-to-checkout mapping, or freedom from later CVV/3DS requirements.

That readiness run made no cart/quote/payment/order mutation, cancellation, auth
renewal, OTP, website, browser, phone, proxy, clone, credential export, commit or
deployment. Later parent-only phone observation is recorded below.
The earlier app order 3944138092 / AED 21.79 was not duplicated.

## Running and integration

```sh
~/.local/share/uv/tools/mitmproxy/bin/python talabat_checkout.py readiness \
  --apk-pool /path/to/original-13.95.0/flutter-static-fixed/pp.txt \
  --timeout 30
```

The callable is `readiness(apk_pool, timeout=30)`. The caller installs any wrapper;
this module does not change other CLI dispatch or catalog/auth modules. The
mitmproxy Python environment is required by the deployed Keychain adapter used
by the existing account helper. A public APK pool path is required explicitly;
no credential value is accepted on argv, fetched from a website, printed or
written. The original public production verticals key is read into memory from
pool offset `0x7c80`. Missing/wrong-version artifacts fail closed. The caller must
keep that public artifact available when deploying; no temporary path is baked
into this module.

`ok: true` means the bounded readiness reads succeeded, **not** ready to order.
The result always includes:

- `commit_enabled: false`, `cart_mutation_enabled: false`, `cancel_enabled: false`.
- `checkout_quote_verified: false`, `cart.payable_total: null`.
- `payment.selected_for_checkout: false`.
- `quiet_instructions_verified: false`, `benefits_verified: false`.
- Explicit blockers for cart semantics, quote/amount binding, payment mapping,
  quiet instructions and submission reconciliation; nonempty cart adds a blocker.

`replace_cart()`, `prepare_quote()`, `commit()` and `cancel_order()` fail immediately
without loading credentials or sending a request, including when passed a valid
local review digest or arguments claiming explicit approval/observed contracts.
There is no mutation CLI or general enable/force flag. The narrow
`parent_cart_probe` exception below can make one authorized Quest cart POST;
it cannot call checkout preparation, place an order or clear a cart.
Auth expiry and HTTP 401 surface to the caller: this lane deliberately does not
call `read_with_renewal`, `refresh` or login. Parent-owned maintenance handles auth
separately; no hidden state mutation occurs during readiness.

All calls share one elapsed network deadline (0 < timeout <= 120 seconds), with
2 MB per-response bounds and no retries, proxies or redirects. Native Keychain
calls and local APK filesystem reads are OS operations, not network calls; they
can defer Python timeout delivery. The final deadline check prevents stale success.
No raw responses, card tokens, customer IDs, cart IDs, contact/address values or
server error bodies are returned. Readiness never modifies baskets. The parent
probe refuses a nonempty server preflight and requires a fresh parent phone
observation before send. Lazy banners/action URLs are ignored.

## Live read contracts

The account snapshot is loaded through `talabat_http_orders.account()` followed
by exact profile verification. Native headers are sanitized; per-service API key,
customer/platform headers are rebuilt only for the cart request.

```text
GET https://api.talabat.com/customers/v1/profile
GET https://api.talabat.com/pay/v1/cards?countryId=4
GET https://userlocation.talabat.com/api/v2/user/addresses?countryId=4
GET https://api.talabat.com/grocery/v2/TB_AE/branches/798285
    ?areaId=<saved Home>&lat=<saved Home>&lon=<saved Home>
GET https://api.talabat.com/grocery/v2/cart
    ?branch_id=798285&dh_vendor_id=<live branch global_id>
    &global_entity_id=TB_AE&chain_id=<live branch chain_id>
    &lat=<saved Home>&lon=<saved Home>
    &campaign_progress_required=false&has_outstanding_payments=false
```

Every read uses the account bearer. The cart also uses `X-API-Key` from the
production APK, `x-customer-id` from the verified profile, and `X-Platform: android`.
The two false query flags are display/request context; they are not authorization
to pay dues or manipulate promotions. No Pro entitlement is inferred from vendor
flags or zero delivery-fee fields.

Card parsing requires a unique masked/number suffix match, strict boolean flags,
valid expiry and saved token material. Missing flags or CVV requirements block
further reads. Home parsing requires exact normalized known Home names, unit,
customer/country binding, JLT area 1308, established Banyantree coordinate bounds
(25.06 < latitude < 25.10 and 55.14 < longitude < 55.18), and a nonempty address ID.
Ambiguous or mismatched homes fail rather than choosing the default/first entry.
The low-level GET route gate now enforces those same strict coordinate bounds,
area 1308, integer country/branch/chain values, nonempty DH vendor identity, exact
false cart flags and the public key's 16-character format. This does not replace
the live Home/profile/vendor checks or establish cart isolation.

## Offline helpers — not an ordering implementation

No helper below loads credentials, writes files, calls HTTP, prepares a cart,
issues an authorization, or changes preferences. They are deliberately not CLI
commands and cannot be used to switch on the disabled mutation entrypoints.

- `instruction_choices(container) -> tuple[DeliveryInstruction, ...]` parses the
  nested static instruction model only: `instructions[]` containing nonempty
  string `id`/`title` and **explicit boolean** `isSelected`/`isEnabled`. IDs must
  be unique; 1–64 entries are accepted. Results are immutable/detached. Unknown
  fields/action URLs are ignored, not followed. It does not guess an outer quote
  response schema or reuse saved Home's differently shaped instruction array.
- `quiet_instruction_ids(container, observed_bindings, *, note_readback)` takes
  exactly `leave_at_door`, `no_bell`, `no_call`. Each binds either an observed
  `{id, title, selected: bool}` control or explicit `{control_absent: true}`.
  Bound IDs/titles/state must match; selected controls must be enabled; no extra
  selected IDs are allowed. An unselected **Call on arrival** control can cover
  no-call. A nonexistent leave-at-door toggle must **not** be invented: the note
  covers it. The exact note readback must be
  `Leave at door; don't ring bell; don't call.` for all configurations, including
  those with all three positive controls. It returns selected IDs in app order.
  This replaces the earlier incorrect three-positive-IDs requirement. Absence
  and semantic mappings are caller-supplied observations, not inferred from
  labels/icons. This is only **consistency validation**, not independent proof
  of absence, meaning, persistence or an order's instructions. It never changes
  `saveForLater` or sends `saveDeliveryInstructionsForLater`.
- `freeze_local_review(review, *, now) -> LocalReviewFingerprint` canonicalizes
  and SHA256-hashes a proposed **local review format**, explicitly not Talabat's
  wire schema. Frozen object stores canonical bytes privately in memory (excluded
  from repr), digest and expiry. No file/journal is created.
- `require_same_local_review(frozen, current, expected_digest, *, now)` rebuilds
  that fingerprint and rejects changed contents, wrong/missing explicit digest,
  future observations or expiry. It returns a matching local fingerprint, **not**
  a one-shot permission. Calling it repeatedly has no authorization significance.

The unused experimental v1 local format accepts only these keys. **It is not a
required format for a future real adapter**; its server-revision and expiry
assumptions must not become artificial ordering blockers:

```text
schema_version: 1
branch_id: 798285
currency: AED
payable_minor: positive integer, under 1_000_000_000 (100 minor units/AED)
observed_at / expires_at: integer Unix seconds; 0 < observed_at <= now < expires_at
bindings: exactly the following lowercase 64-hex SHA256 values
  account_sha256, cart_sha256, server_cart_revision_sha256,
  server_quote_binding_sha256, items_sha256, charges_sha256, home_sha256,
  payment_sha256, quiet_instructions_sha256, checkout_policy_sha256
```

`payable_minor`'s bound is a format limit, **not** a spending authorization. A
future observed adapter would have to bind complete exact item/variant/quantity/
price and fee/discount manifests, Home coordinates/address identity, card5542 and
verified token mapping, instruction IDs/readback **plus notes**, zero tip/wallet/
dues/Pro/priority and no-default-saving policy. No such adapter exists yet. Raw
tokens, addresses, arbitrary fields and booleans/floats disguised as money/time
are rejected by this local format. Its hashes are opaque claims supplied by the
caller, not redaction guarantees or independently verified facts; do not persist
even these fingerprints as public artifacts. Never manufacture a server revision,
quote binding or expiry to satisfy this unused format. If the actual API omits
those fields, bind the fresh observed cart/quote and impose an explicit **local**
freshness window instead; change/replace the local format when a real adapter is
built. Local hashing cannot establish a server-side immutable quote or protect
against server-side changes on its own. Missing server idempotency is not a reason
to invent it: a durable at-most-once send with no ambiguous retry is the fallback,
with honest inability to automatically recover an ambiguous result.

These offline formats are not prerequisites to the separately bounded cart
probe. They cannot authorize any write or substitute for observed wire contracts.

## Static contracts recovered, not activated

Original Android 13.95.0 AOT addresses and pool offsets are evidence references,
not runtime constants except the explicitly read public production key.

### Grocery base, headers and cart

- Production `qcommerceApi` configuration: `0x1e711f0..208`, pool `0x57118` →
  `https://api.talabat.com` at `0x571e0`. The grocery routing wrapper goes through
  `0x260f4a8` → `0x2197408`; optional feature rewriting exists but ordinary base
  above is now live verified.
- Vertical API key: getter `0x129faec` → `0xc857c8`; production dispatch index 5
  at `0x7c68` → `0xc8599c` → pool `0x7c80`. The debug constant is different and
  is not used. The API key value is deliberately omitted here.
- Header builder `0xea84e0`: key, customer ID and Android platform. Caller
  `0x231ab6c` → `0x129faec` → `0x231ad4c` binds them. An optional `X-User-Flow`
  comes from model field `0x13` at `0xea8614..648`. Grocery options wrapper
  `0x260f53c` merges `x-tpro-deals-enabled: true` and `x-weightables-enabled: true`
  at `0x260f5bc..5e0`. Readiness does not send these capability headers. They are
  **leads, not a demonstrated fix** for the app/API cart divergence below; no
  specific device/session/cart identity cause has been established.
- GET `0x231b7bc` → query builder `0x13e7da8` → `0x2697e70` uses the exact query
  above. Stringified coordinates and lowercase true/false booleans are recovered.
- POST `0x2194bbc` → serializer `0xea9ac4` → `0x269780c`, same `/grocery/v2/cart`:
  `dh_vendor_id`, `branch_id`, `chain_id`, `global_entity_id`,
  `items[{product_id, quantity, increment_weight}]`, `lat`, `lon`,
  `campaign_progress_required`, `has_outstanding_payments`.
  Static success handling accepts 200/201. **Not called by this lane.** Full
   replacement-style use is now observed below. The parent's later POST→GET
   readback demonstrates persistence in this HTTP context, while the original app
   remains empty. It is neither stateless calculation nor app synchronization.

The old proposed Nada plain-milk cart was never added and is not authorized for
the next test. Any later parent-only test is **protein shakes only**. Existing
server emptiness alone is insufficient to prove risk-contained cart mutation.

### Quote/payment/instructions

Quote/preparation path builder `0x245e504`, caller `0x245e3b8`:
`/ccx/{v1|v2}/checkout/{ID}`. Feature `exp_ordering_call_checkout_v2` chooses
version. Serializer `0x16874d0`, options `0x168732c`. **POST is now statically
evidenced** by the independent literal-method dispatcher described below, not
guessed from the operation name. The static grocery-cart→checkout ID dataflow is
now traced below; it is not live checkout validation. The concrete runtime adapter
chain and complete live payable-total response remain unresolved.
This preparation is **not a read-only GET** and was not called.

Recovered fields include country/device location, paymentMethod, addTPayMethod,
rider-tip values, proSubscribeChecked, walletBalance, isMigrated, branchId,
verticalId, binNumber, hasDues, optional fingerprint/priority/flow, and always
`quickCheckout`. Address helper `0x1687c94` conditionally selects selectedAddressId
or a full legacy address, and independently adds addressV2 when available.
Do not substitute guessed enums or combine separate model versions.

`deliveryInstructions` serialization at `0x1687920..7abc` filters entries whose
selected flag is true and appends each entry's **ID** (field `0x17`). It is not a
free-form note array. Saved Home instruction arrays were empty. Actual server IDs
and wire readback remain unresolved. Enforce all three quiet **outcomes** using
observed supported controls and notes, not three invented selected toggles. The
parent's current UI has no leave-at-door toggle and no selected call-on-arrival.
No fabricated instructions were sent.

The saved-card route is statically at `0x255ad10`, API configuration offset `0x84`.
Its `token`/`tokenId` fields must not be assumed to map directly to commit's
`cardTokenId`. Payment enums, tokenization and later challenge policy remain gaps.
Any future CVV/3DS requirement must stop for an approved supported flow.

The static zero-valued checkout fixture at pool `0x4adc8` is not a live quote.
No exact payable total or quote/cart fingerprint can honestly be reported yet.

### Commit and reconciliation plan — disabled

Static commit path `/ccx/v1/checkout/{ID}/placeOrder`, main routine `0x24634...`,
serialization `0x2463a4c`, includes allowDuplicateOrder, cardTokenId and shared
checkout/address fields. It has never been called by this implementation.

Cached `x-request-id` creation (`0x168732c` → `0x1687410` → `0x1687448`) is only
proven client correlation behavior. Server idempotency scope, replay semantics,
and request/cart → exact order lookup are not proven. Duplicate-order error
strings do not establish a retry guarantee.

Before any separately authorized future mutation:

1. Resolve the confirmed app/API cart divergence and guard against existing
   baskets. Use a real server revision/conditional update if offered, but do not
   require a nonexistent field or pretend local hashes give server isolation.
2. Persist an operation identity and limited intent securely before transmission;
   no raw address/card tokens in a plain journal. Implement that journal first.
3. Retain a fresh verified quote with exact items, cart binding, saved Home/card,
   payable total/currency and all three quiet outcomes. Bind server quote IDs,
   revisions and expiry **if supplied**; otherwise make local freshness policy
   explicit and re-read the actual cart/quote before submission. Tip, Pro,
   wallet/TPay and outstanding-dues payment must not be implicitly enabled.
4. Obtain parent/owner decision on that exact quote. Keep allowDuplicateOrder false.
5. Submit at most once under that immutable identity. Timeout/lost response becomes
   `SUBMISSION_UNKNOWN`; no new request ID or blind retry. Use profile-bound order
   listing and exact tracking as evidence. An empty list is not proof of failure;
   ambiguous amount/time/item matches cannot certify the submitted order.
6. If submission is ambiguous and exact request/cart→order correlation is absent,
   stop for explicit reconciliation. Server replay guarantees are not required
   to implement a one-shot send, but their absence rules out automatic resending.
   Never cancel/reorder automatically.

The module contains only the bounded cart experiment's journal/transport, not an
order-commit journal or transport. Local review validation is not a server quote,
one-shot authorization, proof of idempotency, or a reason to enable transmission.

## Expansion investigation — 8 October 2026, source only

No live API calls were necessary in this expansion: the five-GET proof above is
inherited, not repeated. Dia's catalog and profile inventory were inspected only;
no pages or phone were accessed. Prior deployed tracking remains frozen. Only
this document, `talabat_checkout.py` and `test/test_talabat_checkout.py` are owned
by this lane. No runtime/catalog/shared dispatch/tracker edits or deployment.

Public artifacts inspected:

- `/private/var/folders/vt/8qndzr_j44z70bh0rn2zyfkm0000gn/T/opencode/talabat-live-1395/flutter-static-fixed/pp.txt`
- Sibling `../libapp.so` and `asm/1050544_MXL.dart` (public app code, not account storage).
- Read-only helper: `/Users/ardud/.robob/scratch/2026-10-08-thread-provider-opencode-provider-instance-c7c79aae/tmp/talabat-aot.py`.
  It uses already cached pyelftools/Capstone; no dependency was installed. Its
  `safe()` sometimes labels long ordinary names as opaque, so field names were
  checked against the pool. The generated asm mostly has `size: -0x1` stubs;
  byte disassembly, not those empty stubs, supplies instruction evidence.

### New static findings (not live wire verification)

| Concern | Exact evidence | What it does **not** establish |
|---|---|---|
| Checkout path parameter | `0x245e6f4` reads model field `0x7`; grocery `Ugc.id`→route `cartId`→checkout state mapping is detailed below. Place path `0x2463480..490` reads nested checkout model field `0x7`. | Static identity dataflow is not live checkout acceptance, a revision, response quote identity or immutable server amount. |
| Prepare versus place | Prepare body `0x16874d0`, JSON encode `0x245e420`; place map `0x24634b8..3a20`, JSON encode call at `0x2463a4c`. Both use selector `class-id - 0x1000` at `0x245e49c` / `0x2463b04`. Independent method dispatcher compares literal POST and invokes this same selector at `0x26fdda0..df4`. | POST selector is now evidenced. Concrete runtime vtable implementation and current endpoint success are not live verified. |
| Instruction model | Container parser `0x245c044` reads `instructions`; entry parser `0x245c61c` reads `id` (`0x245c6b4`), `title`, `iconName`, `isSelected` (`0x245c7f0`), `isEnabled` (`0x245c88c`). Fields `0x17/0x7/0xb/0xf/0x13` respectively hold ID/title/icon/selected/enabled at `0x245c940..964`. | No literal quiet IDs or their meanings were found. Server-provided titles/IDs must be observed together. |
| Instruction wire array | `0x16879cc..9dc` tests selected field `0xf`, appends ID field `0x17`; `0x1687aa8` inserts `deliveryInstructions`. Place repeats insertion `0x24639cc`. | Use supported controls plus notes; do not invent IDs for absent controls or include an unselected call-on-arrival ID. Notes are not this ID-array's schema. |
| Do not save defaults | Container `saveForLater` at `0x245c230`, `isPreSaved` at `0x245c4f8`; place optionally sends `saveDeliveryInstructionsForLater` at `0x2463a10`. | Quiet choices for this one order must not silently change saved Home preferences. |
| Payment enum source | Parser `0x1699e4c..a080` reads numeric `paymentMethod`, string `paymentMethodName`, numeric `addTPayMethod`, string `addTPayMethodName`. Pool `0x51d28` is a **cash fallback fixture** with `events.payment.method`, not a saved-card enum table. | No numeric saved-card mapping or token/tokenId/cardTokenId equality. Never reuse fixture cash=0 for card ordering. |
| Request identity | `0x1687448..4cc` returns cached ID or creates/stores one when null. `0x168732c` adds `x-request-id`, optional `X-User-Flow`; place also adds `x-device-brand`. `duplicateOrdersSameCartId` (`0xbe828`) is used in telemetry `0x246dba4..bc`. | Cached correlation and duplicate telemetry do not prove server deduplication, atomicity, replay safety or exact order reconciliation. |
| Cancel | `0x26e2928..2a10` constructs `/menubff/item-replacement/food/orders/{id}/cancel-order`; closure `0x2041f78` calls transport selector `class-id - 0xff5`, the same selector used by grocery POST wrapper `0x26979cc`. | This is food item-replacement cancellation, **not** general grocery/Mart cancellation. Eligibility, reason/refund policy, response schema, native status, and repeat behavior remain unverified. It must never be used for a Mart test. |

### Follow-up: transport and payment dataflow

The selector conclusion is independently grounded, not just two similar callers:

- Generic method dispatcher `0x26fdc90` normalizes the method, compares literal
  `GET` at `0x26fdd04` and invokes `class-id + 0`; compares literal `POST` at
  `0x26fdda0` and invokes `class-id - 0x1000` at `0x26fddf4`; `PUT` uses
  `class-id - 0xff2`. This resolves the high-level prepare/place **POST selector**.
- Both checkout calls take repository `Jhb` field `0x13` as receiver:
  `0x245e42c` / `0x2463a28`. DI `0x16a4b60..bec` resolves type `rla` (pool
  `0x80b0`) and stores it into that field. `Jhb` is class 13044; abstract `rla`
  is 15592. Implementors found: `Jbh` 15593, `Ucb` 15594, `tla` 15595.
  `Jbh` DI `0xeb198c..9d4` wraps another `rla` plus `Hbh`. A dumped dispatch table
  is unavailable, so the final instantiated chain and concrete method address
  are still unresolved. Grocery's lower-layer selectors `-0xff5` POST / `-0xff8`
  GET are not a contradiction; they belong to a different wrapper layer.
- Payment event parser `0x1699870` puts `method` in field `0xb`, `card` in `0x17`,
  `instrumentId` in `0x1f`. Method parser `0x1699e48` reads numeric `paymentMethod`
  into unboxed field `0x7`, numeric `addTPayMethod` into `0x13`, with corresponding
  names in `0xf` / `0x1b`. These values are **server-driven**, not a recovered
  local enum table. Checkout state builder `0x245ea24` uses the explicit selected
  config or state field `0xb`, then config.field7 → event.method.fieldb → numeric
  fields at `0x245ee94..ef00`. It writes Hhb fields `0x23`/`0x27` at
  `0x245f034..40`; prepare `0x1687644..684` and place `0x24634e8..508` consume them.
- Place `0x24633ec` receives `cardTokenId` as arg3, saves it at `0x246340c`, and
  copies it directly to body at `0x2463598..5a8`. Wrapper `0x2462754` forwards
  arg3 unchanged (`0x2462784`, `0x2462864..874`). Its caller takes
  state.fielda3 → fieldf → fieldb at `0x2462668..6bc`; another caller at
  `0x2633fb8..ff0` also uses selected-config.fieldb. The legacy `/pay/v1/cards`
  parser puts `tokenId` into a **different model's field `0x1f`** at
  `0x1a2d0e0..168`. Equality between those models is **not established**. There
  must be a real selected-card mapping, not `tokenId` chosen because of its name.
  The similarly named `paymentConfigCardTokenId` at `0x1e8ba88` is BNPL telemetry
  and the preferred-payment serializer `0x1e8bd6c` is not proof of this mapping.

### Follow-up: safe GET coverage

No standalone instruction GET was found. Pool `instructions` (`0x49880`) is used
by validation and nested parser `0x245bfac`; the latter is called by checkout
response parser at `0x2459930`, after reading outer `deliveryInstructions` at
`0x24598dc`. `/ccx/v1/` voucher apply/redeem/unapply paths are mutations, not safe
instruction discovery. Negative search evidence is bounded, not proof no such
endpoint exists elsewhere.

A distinct **saved-payment management** GET is statically observed:
`/pay/v2/payment-methods?countryId={country}` (`0x262a504..5d0`, pool `0x47738`).
It uses GET selector `class-id + 0`, base config field `0x83`. Parser `0x1e858d8`
reads `paymentMethods`, `placeHolder`, `cardSecurityConfig`, `trackingRules`;
entry field reads `0x1e85df0..60c8` include `uid`, `icon`, `title`, `subtitle`, `tag`, `canBePrimary`,
`action`. This is **not shown to return checkout payment-event numeric enums**,
and contains no observed delivery-instruction schema. It was not called or added
to the read allowlist. A projected schema-only parent read is an optional lead
only after verifying its base/auth binding, not a prerequisite to another phone
checkout or a reason to change primary payment.

### Fresh parent observation: app/API cart divergence confirmed

Parent-reported original-app observation, 2026-10-08 21:14–21:20 Dubai; this lane
did not access the phone or repeat API reads:

- Mart initially displayed empty (`Start adding`, AED10 minimum) at Home.
- Parent added only one Quest Chocolate Flavor Protein Shake, 325ml, product
  `0130fb0a-223a-4ca9-8b26-c250244f68e3`, AED20.25. App displayed one item plus
  AED8.99 delivery + AED0.90 service = **AED30.14**. This is a UI total, **not an
  HTTP quote** produced by this module.
- Account/branch GET still returned `items: []`, subtotal zero both after adding
  and after entering checkout. Therefore the earlier empty-cart GET is now
  positively demonstrated **not to be app-cart synchronization proof**.
- Checkout: Home2104, ETA10–20 minutes; **PostPaid selected by default**, card5542
  offered but not selected. Never derive selected-card enums from that default.
- **Don't ring doorbell selected**, **Call on arrival unselected**; Leave at
  reception and Ring doorbell grey; no Leave at door toggle. Save-for-next-time
  was checked by default and untouched. The UI does not expose corresponding
  server IDs and does not prove notes have been transmitted.
- No purchase. Parent removed only its single Quest test item and independently
  verified the app's empty-cart screen at **21:21:51 Dubai**. This confirms that
  test's cleanup, not global account-cart emptiness or HTTP/app synchronization.

That next bounded cart POST has now happened under parent authority, below.
Capability headers and flow/device context as causes remain hypotheses; neither
direction of app/API divergence establishes a specific device-identity problem.

### Parent result: API-only Quest cart persisted, not cleaned

Parent-reported run on 2026-10-08 at **22:23 Dubai**, after dry run, 47 tests and
fresh original-app empty/Home observation:

- Exactly one authorized Quest quantity1 was POSTed. Response subtotal was
  **AED20.25**, with a new opaque cart ID relative to the empty preflight.
- Immediate same-context GET returned the **same ID as POST**, the sole Quest
  quantity1 and AED20.25. This establishes persistence/readback for that HTTP
  context, not payable total or an order.
- Both responses omitted `branch_id`. Their keys were `id`, `items`,
  `subtotal_after_discount`, `cart_update_messages`, `campaign_progress`,
  `lazy_banners`. Missing response echo does **not** defeat the independently
  bound request branch/vendor/account/Home scope. The response projector now
  reports `branch_id_present:false`, `branch_matches:null`, not false mismatch.
  A present wrong/malformed branch remains false. This change grants no cleanup.
- At **22:23:41**, the original app still showed empty/Start adding AED10. The
  later HTTP cart and earlier 21:21:51 app cleanup are distinct observations.
- Parent's separately authorized cleanup wrapper stopped on the missing branch
  echo **before sending any clear**. The private POST ID was discarded when the
  probe process exited. Earlier equality booleans cannot re-establish equality to
  a later GET. Thus the API test cart is **still present, not purchased, not
  cleaned**; no blind clear is authorized by this worker's schema correction.

Parent evidence (not read or modified by this worker):

- `/Users/ardud/.robob/scratch/2026-10-08-continue-owner-authorized-delivery-http-59e6905d/tmp/talabat-quest-cart-post.intent`
- `/Users/ardud/.robob/scratch/2026-10-08-continue-owner-authorized-delivery-http-59e6905d/tmp/talabat-cart-probe-safe-result.json`

The intent is permanently consumed for this experiment. Do not rerun add, remove
the marker, choose another directory, or call the old dry-run recipe as a way to
recover the cart. Preserve the current API test basket while the parent decides
the next separately authorized step; this child made no live read or write.

### Full cart serializer and callsites (bounded follow-up)

The normal builder `0x228acc0` loads its basket through `0x129fb20` → `0xea2f9c`,
then `0x129fb54` reads the local `Ugc` subject/current object (`field 7`). It maps
**the complete items list**, not a delta: `0x228ad94..ae04` → `0x129fd4c` extracts
each product ID (`field 7`), integer quantity (`field 0x13`) and nullable weight
(`field 0x5f`). This constructs `rph` and `qph` through `0x129fc04`.

`0x2192ff0` dispatches that request to `0x2194bbc` at `0x2193064`, then parses the
response with `0xea8adc`. The alternate caller `0x24412..155c` passes an **empty
items list** at `0x2441478` and calls the same POST at `0x24414c4`; after parsing,
it explicitly checks items and throws **"Cart was not cleared. Items still
remain in the response."** This is direct evidence of replacement/clear use.
There is a local app basket source; it is **not proof the endpoint is stateless**.
Static client code cannot prove database persistence or cross-device isolation.

All fields are always emitted by `0xea9ac4`/`0xea9cfc` (including null weights):

| JSON field | Observed model/wire type | Probe source / choice |
| --- | --- | --- |
| `dh_vendor_id` | string reference | freshly verified vendor `global_id` |
| `branch_id` | **string**, clear caller converts integer at `0x244133c..1380` | `"798285"` |
| `chain_id` | **string**, conversion at `0x2441388..13d0` | live chain ID string |
| `global_entity_id` | string | `"TB_AE"` |
| `items` | list of `rph` maps | exactly one authorized Quest, quantity 1 |
| `product_id` | string | `0130fb0a-223a-4ca9-8b26-c250244f68e3` |
| `quantity` | integer (`ldur x`, integer boxing at `0xea9d54..68`) | 1 |
| `increment_weight` | nullable number; source is model `field 0x5f` | explicit null for the non-weighted bottled-shake probe |
| `lat`, `lon` | nullable double; `0x228ae28..aeb0` boxes saved location or null | nonnull verified Home coordinates |
| `campaign_progress_required` | boolean | **true**, normal builder `0x228aee0`; clear caller uses false `0x2441498` |
| `has_outstanding_payments` | boolean context passed by caller | false, explicit no-dues experiment context; not an account debt assertion |

There are no other body fields/defaults in these two serializers, no cart ID,
payment enum, token, address ID, note, revision, or item price in this cart body.
Weight parser `0xea99e4..9a5c` accepts optional numeric `increment_weight` and
preserves null; no static fallback to zero is present. The probe's null choice is
schema-supported, not claimed to have been captured for this exact Quest SKU.
The parent should stop if the response treats it as weighted/substituted.

Response parser `0xea8adc`: `items`→`Noh` list; `product_id` and `quantity` are
required (`0xea991c..995c`); `free_quantity` defaults 0, `stock` and
`increment_weight` are nullable. It reads `branch_id`, `subtotal_after_discount`,
`id`, `cart_update_messages`, `campaign_progress`, `lazy_banners`. Cart `id` is
stored into `Ugc.field 0x53` at `0xea8e38..3c` (empty-string fallback if absent).
The static bridge into checkout is now traced in the first-prepare section below.
The probe itself compares only the POST/GET IDs, not a live checkout response.

### Parent-only one-shot Quest cart experiment

Owner authority now permits a controlled cart mutation; this lane's prohibition
on live writes is **not a global blocker for the parent**. Treat the operation as
potentially persistent full replacement. The parent keeps the exclusive phone/cart
turn and checks same account, Home2104 and original-app emptiness immediately
before send. Server emptiness alone is inadequate; neither check excludes races
from another device, so coordinate owner inactivity rather than invent isolation.

Callable (no wrapper/CLI/deployment change):

```python
parent_cart_probe(apk_pool, intent_dir, *, send=False, phone_checked_at=None,
                  phone_empty_home_account_verified=False, timeout=30)
```

It runs the same profile/card/Home/vendor checks and a fresh empty-cart GET.
After a successfully parsed POST, one read-only cart GET compares the response
identity/items while private IDs are still in memory (six GETs total on success).
Failed readback is explicit and does not hide or repeat the received POST.
For this experiment **both cart GET and POST** use `campaign_progress_required`
true, no outstanding-payments context and the static capability headers
`x-tpro-deals-enabled: true`, `x-weightables-enabled: true`. GET remains string
query values; POST branch/chain are strings and flags JSON booleans. Bearer,
public APK API key and bound customer/platform headers stay in memory. Optional
`X-User-Flow` is omitted, not invented. There is no cookie/device export.

The following is the **historical execution recipe, already consumed at22:23**;
do not execute it again against this now-nonempty cart. Default `send=False`
builds the exact body in memory and prints only fixed field
types, item count and policy booleans. It writes no marker and sends no POST.
`send=True` requires a parent observation timestamp no older than **120 seconds**
both before reads and again before dispatch. That is a caller attestation, not
independent phone verification. Use an already-existing, private parent scratch
directory and **the same directory for this experiment forever**:

```sh
# Run from /Volumes/ExternalSSD/t3code-fork/integrations/app-api-cli.
# First dry run: five GETs only, no phone action or POST by this script.
PYTHONDONTWRITEBYTECODE=1 ~/.local/share/uv/tools/mitmproxy/bin/python - <<'PY'
import json
from talabat_checkout import parent_cart_probe
pool = '/private/var/folders/vt/8qndzr_j44z70bh0rn2zyfkm0000gn/T/opencode/talabat-live-1395/flutter-static-fixed/pp.txt'
intent_dir = '/Users/ardud/.robob/scratch/2026-10-08-continue-owner-authorized-delivery-http-59e6905d/tmp'
print(json.dumps(parent_cart_probe(pool, intent_dir)))
PY
```

For the separately decided live run, use the same script with **only** the call
changed to `parent_cart_probe(pool, intent_dir, send=True,
phone_checked_at=ACTUAL_UNIX_SECONDS_OF_PARENT_OBSERVATION,
phone_empty_home_account_verified=True)`. Do not manufacture that timestamp
inside the helper, infer phone emptiness from GET, or reuse an old screenshot.
Only one Quest shake is possible: transport rejects altered SKU/quantity/branch,
extra fields, weights, dues and out-of-bounds Home coordinates.

Immediately before dispatch it atomically creates the fixed mode0600 file
`talabat-quest-cart-post.intent` with `O_EXCL|O_NOFOLLOW`, writes a nonsecret
`MAY_HAVE_SENT` record, and fsyncs file+directory. A successful response appends
only the safe projected receipt. Existing/partial markers block another send.
There is no safe automatic retry; **never delete the marker or choose another
directory to retry**, even after 401, timeout, process crash, malformed response,
unexpected item, or receipt-write failure. A marker conservatively remains
consumed if a local failure happens immediately before dispatch too. Cross-process
protection is scoped to this fixed directory; this is not a general account-wide
ordering journal or server idempotency claim.

POST accepts 200/201 only, <=2MB, one shared bounded deadline, no redirect/proxy,
auth refresh or transport retry. Output contains allowlisted response-field types,
counts, subtotal and equality booleans only; no unknown key names, IDs, tokens,
addresses, URLs or raw errors. `sent:true` means a parsed response was received,
**not a valid checkout quote or a purchase**. Inspect `sole_quest_quantity_one`,
ID presence, any returned branch echo, projected stock count/null-weight flag, and fresh GET/app
state. Under `response`, `same_cart_id_as_preflight` compares POST to the first
GET; under `readback`, that same field compares the final GET to the POST's ID.
Neither is live checkout-path validation; separate static dataflow is below.
Subtotal is not payable total. No follow-on
prepare/cleanup/purchase is called, including on success.

#### Controlled cleanup — separate permission and receipt

Do **not** clear after an ambiguous add merely to "undo" it. Retain the marker;
parent reconciles with read-only GET in the identical probe context and the
original app, without adding/reordering/restoring anything. A clear needs its
own explicit decision and distinct durable intent/receipt. The helper deliberately
does not implement it or accept `items:[]`.

Only proceed if the successful add's exact response ID still matches the current
GET cart ID, branch/account/Home still match, and the **entire** current cart is
exactly our sole Quest UUID, quantity1, zero free quantity, no weight/substitute
or unrelated row. Also inspect the original app: if it contains any unrelated
item, or attribution/scope is ambiguous, **stop rather than clear**. If the GET
is already empty, do not POST an empty cart; this does not prove app cleanup.
The parent can remove a visible attributable sole test item through the original
app and record separate app-vs-API observations, never claim global synchronization.
The probe's immediate readback performs this ID comparison without exporting IDs.
For a later HTTP cleanup, keep the private response ID in the same controlled
process or obtain exact attributable context through a new parent-owned wrapper;
the persisted booleans alone cannot prove a later GET still has that ID. If that
link was lost, stop rather than infer ownership from only SKU/amount/time.

If HTTP cleanup is justified, the statically observed clear body is the same
validated fresh-context map with `items:[]` and
`campaign_progress_required:false`; other fields remain freshly bound, including
`has_outstanding_payments:false`. Use **one** POST to the same route, a distinct
pre-dispatch marker, no auth retry/redirect, and the same safe schema projection.
Never reuse the add helper or secretly broaden its one-Quest allowlist. Read back
both empty response and a fresh same-context GET plus original app; if response
or attribution is ambiguous, stop with cleanup unknown. Static empty-list use is
proven; persistence and atomic precondition enforcement are not.

### First prepare: resolved ID/address/transport, remaining context boundary

`0x24587f0` builds prepare from checkout state `field 0xb`; selected payment is
`state.field 0xb` (`0x2458820..40`). Builder `0x245ea24` falls back from an explicit
override to that state value, but permits it to remain null. At `0x245ee84..90`
and `0x245eec4..d0`, missing config produces **null** paymentMethod/addTPayMethod.
Serializer `0x1687638..7690` includes both keys with those values (not omitted).
Thus an app-code-supported first prepare can request server configuration without
guessing a saved-card enum or sending a token. Null payment is **not** selection
of card5542, and any resulting default PostPaid must not reach commit.

#### Grocery ID → route → checkout ID

The following are tagged Dart field offsets; an offset shared by unrelated
classes is not itself evidence. These linked callsites carry the same string:

1. Cart parser `0xea8d70`/`0xea8e38` stores JSON `id` in `Ugc.field53` (class18680).
   Mapper `0xeaa508` reads it at `0xeaa530`, then writes it unchanged to mapped
   cart `field7` at `0xeaa7ac..7b0` (allocator `0x21953bc`, class18638).
2. Grocery navigation `0x22dd5a8` calls `0x13594dc`→`0x22b58e0`. That loads the
   current local Ugc via `0xea8aa8`→`0xea2f9c`→`0xea8a70` and invokes the mapper
   at `0x22b5948`. `0x22dd720` reads mapped `field7`; `0x22dd7a0` requires it.
3. `0x22dd904` passes it to `0x22dd9cc`, stored in closure context `field23`
   (`0x22ddaa8..aac`). Closure `0x13a6b78` reads that field and passes it through
   `0x22ddcb0`→`0x13a6c5c` into `wlb.fieldf` (`0x13a6cb8..cbc`).
4. `0x13a65a4` reads `wlb.fieldf` at `0x13a6644`; `0x13a670c` inserts that exact
   string into route query **cartId** at `0x13a6850..864`, then builds the URI
   (`0x1d0e7ac`). The receiving route parser `0xf79fc4` reads `cartId` at
   `0xf7a0b8..c8` into `Zhb.field13` at `0xf7a538..53c`.
5. Widget closure `0x168bd00` reads `Zhb.field13` at `0x168bd6c..74`, passing it
   as x2 to factory `0x168be6c`. The factory passes it as x3 to constructor
   `0x168c4e8` (`0x168c4bc..4cc`); constructor stores controller `field6b` at
   `0x168c940`. `0x169f7c0` reads that field and setter `0x169f948` writes it
   unchanged into service's `Ghb.field2f` at `0x169f954`.
6. Builder `0x245ea24` reads `Ghb.field2f` (`0x245ea64..70`), writes `Hhb.field7`
   at `0x245f00c..10`; path builder reads it at `0x245e6f4`.

This supports **grocery cart ID is the checkout path ID**, not a separate guessed
checkout-ID exchange. The generic router's internal URI-query→map dispatch and
the local cache write following the POST parser were not individually traced;
both route ends and the cart parser/mapper agree. It is strong static dataflow,
not a claim that a live prepare has accepted this particular HTTP-only cart.

#### Address and country are no longer opaque guesses

- `0x2458b68`→`0x2458bcc` obtains saved-address model `eca`, unwraps its `field7`
  ID (`0x2458bb4..bbc`) and returns it to `Hhb.fieldf` (`0x245f020`). Helper
  `0x1687c94` uses that exact value as **selectedAddressId** when nonempty
  (`0x1687ce0..d04`, predicate `0x168892c`). With null/empty ID it emits the legacy
  address object instead, not an invented string ID.
- The builder independently reads saved address again at `0x245ee68..74` into
  `Hhb.field7f`. When nonnull, the helper **also emits addressV2**, even when
  selectedAddressId exists (`0x1688394..87ec`). Therefore omitting addressV2 just
  because an ID exists is not a faithful reproduction of this populated path.
- addressV2 has exactly16 keys: `id`, `area_id`, `area_name`, `block`,
  `building_no`, `country_code`, `country`, `extra_directions`, `floor`, `judda`,
  `latitude`, `longitude`, `mobile_number`, `phone_number`, `street`, `type`.
  Source tagged fields respectively: `7,b,13,43,3b,4f,4f,47,3f,37,23,2b,5b,5f,33,63`.
  Area ID is integer; coordinates are doubles. Other source values/nullable types
  must be preserved, not coerced from guessed aliases such as suite→floor.
  Legacy address uses the same15 non-ID keys from `Hhb.field47.fieldf`.
- **countryCode** is `Hhb.fieldb`, serialized at `0x1687558..76c`, not an address
  ID. It comes from country model `Nzb.fieldf` via `0x210e3b4`, with empty-string
  fallback only when country is absent. Public `objs.txt` object `Nzb@17401b1`
  (lines30729–33) explicitly pairs country4 with **AE**, currency **AED**,2digits.
  This resolves the earlier unlabeled `Hhb.fieldb` lead.
- The final parser pass resolves the address-country type discrepancy. Raw
  address parser `0xc1ce44` puts **country_code string** into `mca.field47`
  (`0xc1d3a8`, `0xc1d9a0`) and **country integer** into unboxed `mca.field4f`
  (`0xc1d464`, `0xc1d9bc`). Mapper `0xc1cc8c` copies those separately into
  `eca.field4f` and `eca.field53` (`0xc1cd18..24`, `0xc1cde4..dec`). Checkout
  serializer `0x16884e4..8530` deliberately uses **eca.field4f for BOTH
  addressV2.country_code and addressV2.country**. Therefore both outbound values
  are the raw `country_code` **string**, not raw integer country4. Do not
  "correct" this observed serializer quirk. Validate raw country4 separately.
- The other15 addressV2 values map directly from the same-named raw fields;
  `country` is the sole value alias. The full raw→mca→eca chain is:
  id `8b→7`, area_id `f→b`, area_name `17→13`, latitude `57→23`, longitude
  `5f→2b`, street `2b→33`, judda `27→37`, building_no `2f→3b`, floor `33→3f`,
  block `23→43`, extra_directions `3b→47`, mobile_number `43→5b`, phone_number
  `3f→5f`, type `1b→63`, country_code `47→4f`. Integer/double fields retain
  their types; no suite→floor conversion or additional `suite` key.
- Parent independently verified current saved Home with two read-only GETs:
  all16 raw keys exist; id/address text/phone fields are strings, area_id/country/
  type are integers, latitude/longitude are floats. `suite` is a separate string,
  `delivery_instructions` a list. Only field types were retained, not private
  values. This matches the recovered conversion; it is not a checkout submission.

#### Method/base/version and exact remaining merge

- Repository DI takes `OKc.fieldb`→config tagged `field63` at `0x16a4b18..28`
  and stores it as repository `field7` at `0x16a4bd0..d4`. Prepare passes that
  value as **Ozm** at `0x245e438..484`. Public production `FKc` object pool
  `0x57310`, untagged offset64, is **https://api.talabat.com**. POST selector
  evidence remains the independent literal dispatcher above. The concrete
  runtime adapter chain still has not been reconstructed, but the passed base
  value is no longer unknown.
- `exp_ordering_call_checkout_v2` uses false fallback at `0x245e648/670`, hence
  **v1 unless the flag is true**; true selects v2 (`0x245e69c..6b8`). A future
  probe must state which branch it selects, not claim the account flag observed.
- The exact base map serializer includes countryCode, deviceLatitude,
  deviceLongitude, paymentMethod, addTPayMethod, riderTipAmount, isCustomRiderTip,
  saveRiderTipForLater, proSubscribeChecked, walletBalance, isMigrated, branchId,
  verticalId, binNumber, hasDues. It then merges `Hhb.field3f`, optional `wfq`
  (default empty map), optional cardFingerPrint, and address helper output.
  Optional selected deliveryInstructions follow. At `0x1687abc..7c30`, optional
  priorityLevel/isCurbsidePickup/flow are added and **quickCheckout is always
  emitted** (`Hhb.field73`, builder defaults false). These fields cannot be
  dropped merely because payment is null.
- The previously untraced `Ghb.field7` context-map setter is now `0x164d694`;
  checkout calls it at `0x2468564`, `0x2468648`, `0x2470d50`, taking the current
  payment-service result `jFg.fieldb`. That result is populated at `0x2469be4..be8`
  from getter `0x1695898`, which reads `payment.paymentMethods` model `uFg.field17`.
  Mapper `0x169afac` copies this from its input model `field13` at
  `0x169b078..80` / `0x169b0c0..c4`. The upstream parser is now resolved:
  **supportedFeatures**, from `/pay/v2/payments` (details below). Actual account
  contents remain unobserved. This is not arbitrary caller metadata.
- Builder `0x245ea90..eb14` uses `{}` only if state map is null, and merges
  selected config `field17` (also `{}` if null). Null is a real code path, but the
  current app initializes payment service before prepare (`0x2468648` before
  `0x2468678`); it is not proof this actual flow has no context. Branch, vertical,
  migration are copied from navigation/controller initialization via setters
  `0x168d724`, `0x168d760`, `0x168d68c`, not derived from a missing response echo.

#### Final bounded pass: payment GET and supportedFeatures

This is static contract evidence, **not an executed or fully specified GET
recipe**. No new URL was allowlisted and no first-prepare constructor was added.

- Loader `0x246c538` builds **GET https://api.talabat.com/pay/v2/payments** from
  literal pool `0x52870` (`0x246c588`) plus query builder `0x169d3f0`. Base is
  production config tagged `field83`, public pool `0x57310` offset84. GET selector
  is the known lower-layer `class-id-0xff8` (`0x246c6b4`). This is distinct from
  `/pay/v2/payment-methods`, the management-list endpoint noted earlier.
- Response parser `0x1697308` reads mainPaymentMethod, paymentMethods,
  trackingRules, presentation and **supportedFeatures**. The last is nullable
  `Map<String,dynamic>` at `0x1697538`, stored into model `field13` at
  `0x1697590`, then copied into `uFg.field17` at `0x169b078..b0c4`. This closes
  the upstream map→payment-service result→Ghb.field7→prepare body merge. Since
  it merges after the base fields, actual keys can override them. Neither an
  empty map nor safe values may be fabricated from the key name.
- Required query fields are **scenario** and **amount**. For delivery, scenario
  is exactly **deliveryOrder** (public enum `lGg@177a131`, pool `0xbdd40`);
  `0x169f980` selects pickUp only for route deliveryMode `pickup`. Controller
  initializes scenario/amount at `0x169f8b8`/`0x169f900`, then both initialization
  branches call `0x246955c`→`0x169eedc` before the payment loader.
- **amount is the route totalAmount double converted to string**, with `"0.0"`
  when absent (`0x169f8ec..900`). Grocery route amount comes from mapped-cart
  totals `field17` (`0x22dd740`), copied from **Ugc.field17** by mapper
  `0xeaa558..5d0`. Cart response parser `0xea8adc` initializes that field to0
  (`0xea8e04`); response `subtotal_after_discount` is stored in the DIFFERENT
  **Ugc.field3b** (`0xea8e20`). Local recomputation before navigation has not
  been traced. Therefore neither live subtotal20.25, prior UI payable30.14,
  nor freshly parsed0.0 is proven to be the actual current app request amount.
- Optional query fields, emitted only when nonnull: countryId, branchId,
  hasApplePayDebitCards, hasApplePayCreditCards, hasGooglePayCards,
  hasBenefitPayApp, hasZainCashApp, subscription, selected, walletToggle,
  presentationMode, proPlanId (nonempty), voucherId, cashFees, oneTimePayment.
  Country service supplies4; current branch is798285. The request model also has
  a vertical field, but this query builder does **not** serialize verticalId.
- The two Apple capability providers return null in this Android artifact
  (`0x246cf64`). Google is derived through `0x22235cc`; Benefit/Zain use native
  MethodChannels (`0x246cdcc`, `0x246cc54`). Current outputs are unknown; do not
  invent false values. Before the first GET, `0x246c8b4` may import native payment
  context through `0x2170d84`→`0x169dcac`; its current map is not observed.
- Header **x-acceptance-request-id** is emitted from request `field4f`
  (`0x246c638..654`), sourced through `0x246a1d8`→`0x1687410`→`0x1687448`, the
  cached per-flow request-ID generator. It is not automatically the generic
  native_headers random x-request-id. Do not export it or assume retry safety.

Consequently scenario/path/base/parser are resolved, but a claimed **exact app
GET replay** still needs the route-amount calculation and native payment context/
capabilities. An explicitly exploratory parent GET with chosen parameters would
be a different experiment, not proof those values match the app. None was sent.

#### Vertical, migration, initial tip/wallet/dues

- Fresh vendor parser `0x21917c8` maps raw vertical_type into unboxed `Akc.field1b`
  (`0x2191a84`, `0x2191e50`), is_dark_store into `field23` (`0x2191a34`,
  `0x2191e5c`) and is_migrated into `field27` (`0x2191a5c`, `0x2191e68`). Navigation
  `0x22dd7c4..82c` maps vertical_type through enum lookup `0x13597cc` and passes
  its same numeric ID into the route; migration is **is_migrated OR is_dark_store**.
  Route serializer `0x13a686c..68ec` carries both to checkout state. Parent's
  fresh three-GET profile/Home/vendor check observed vertical_type integer1,
  is_migrated false, is_dark_store true: **verticalId=1, isMigrated=true** for
  this exact vendor snapshot. These are no longer guessed Mart constants.
- Tip comes from `Ghb.fieldf` (`0x245ece8`); when null, both riderTipAmount and
  isCustomRiderTip are explicitly null (`0x245ef10`, `0x245ef54`). Otherwise the
  tip object's double `field7` and boolean `fieldf` are used. saveRiderTipForLater
  comes from `Ghb.field13` (`0x245ecf4`). Fresh state allocation `0x16a5550` leaves
  them null. Observed tip setter `0x2460448` and save-tip setter `0x245879c` each
  store a value and immediately prepare. This proves a legitimate **nullable
  initial path**, not that all current saved preferences are absent.
- walletBalance is null when selected config is null (`0x245ef6c..78`), otherwise
  selected config `field2b`. proSubscribeChecked is false in the builder. A
  server-selected PostPaid config may exist before actual app prepare, so a
  supported null-config path is not evidence that the app selected card5542.
- **hasDues is not cart.has_outstanding_payments.** Service `field43` receives an
  optional adapter via DI `0x16a490c`: it looks up **OutstandingPaymentsDefault**
  (pool `0x552a8`), returning null only if unregistered (`0x16a49a0`). The value
  is stored at `0x16a48b8`. Prepare builder calls/awaits that adapter at
  `0x245edf8..ee3c` and accepts a nullable boolean into `Hhb.field77`. Its
  registered implementation/current account result remains unobserved. Do not
  substitute false simply because the cart probe used false for its own flag.

**Bounded result:** no executable first-prepare constructor/transport was added.
Remaining wire-value gaps are now specifically (1) payment GET amount after
local cart recomputation and current native payment context/capabilities;
(2) actual supportedFeatures and selected-config map/defaults, rather than an
invented empty merge; (3) current OutstandingPaymentsDefault result and whether
tip/save-tip preferences were populated before this prepare. An intentionally
unselected-payment first prepare remains a supported builder branch, but has not
been live verified for this HTTP-only cart. These are not demands for nonexistent
server revisions/idempotency. Cart-ID mapping, selectedAddressId, the complete
addressV2 country conversion, countryCode, base, null-payment capability, and
this vendor's vertical/migration values are resolved and should not be reopened
as blanket blockers. This final bounded pass is documentation-only.

After those mappings, a separately authorized parent-only **one-shot prepare**
can use a fresh private GET ID/current sole-Quest manifest in the identical
account/vendor/Home context, with its own durable intent, no resend on ambiguity,
and projected payment/instruction schemas only. This does not require rerunning
add. It does not repair the lost historical POST-ID lineage for a later clear.
`prepare_quote` and `commit` remain disabled. No purchase until actual card5542,
all three quiet outcomes plus notes, and full payable quote are verified.

### Minimal next observation for the parent

#### Parent exploratory payment GET, after the final static freeze

The parent performed two bounded GET observations at `/pay/v2/payments`, after
profile validation, with explicit `scenario=deliveryOrder`, `amount=20.25`,
country4 and branch798285. This is a deliberately chosen subtotal experiment,
**not exact app replay or proof20.25 is payable**. Optional native capabilities
were omitted; each observation used its own in-memory acceptance request ID.
No renewal/retry, preference change, quote, order or card action was sent.

Both returned200. Only schema/type information and safe equality/boolean fields
were retained. The response has four paymentMethods plus mainPaymentMethod,
supportedFeatures, trackingRules and presentation. Top supportedFeatures was
`paySupportsTPro:true`. One enabled, unselected row's title matched5542; its
events.payment.method was `paymentMethod:2, addTPayMethod:7`. Its card.cardId
equalled the independently verified `/pay/v1/cards` tokenId, **not token**.
Neither identifier was printed or persisted. This resolves those server-returned
values for the chosen GET context; final placeOrder.cardTokenId propagation and
current selection must still be bound, not inferred from a title alone.

The currently selected row was not5542 (`2/11`), consistent with the earlier
PostPaid UI observation. Do not accept the server default as card selection.
Card supportedFeatures included riderTip/subscription/mixPayment true; these
are capabilities, **not authorization to tip, subscribe, or use wallet credit**.
No checkout mutation followed this read, and the API-only Quest cart remains.

Safe local evidence: current continuation workspace
`tmp/talabat-payment-config-safe-schema.json` and
`tmp/talabat-payment-card-comparison.json`; no private tokens or raw bodies.

Do not buy merely to close a checkbox. UI observation alone cannot prove wire
enums, IDs or idempotency. Original-app TLS interception was previously blocked;
no root/clone/proxy/integrity bypass is proposed. If normal app-visible evidence
cannot provide a field, record that blocker rather than fabricate it.

1. On a parent-owned phone turn, honor priority-hold. Inspect current app cart(s)
   **before adding anything** and confirm account/Home Banyantree 2104. If any
    existing owner basket is present, stop without clearing/replacing it. The
    controlled experiment above may proceed with fresh phone+server empty checks
    while recording the remaining synchronization ambiguity; no full prior sync
    proof is demanded just to observe this explicitly authorized small cart POST.
2. **Only the21:21:51 UI test was cleaned. The22:23 HTTP test cart remains.** Do
   not repeat add/cart-building or purchase merely to reconfirm divergence. The
   next HTTP observation, if justified after the narrow mappings above, uses the
   current sole-Quest cart, never a replacement or prior Nada plain milk. If a
   separate parent UI observation is needed, preserve existing baskets. Record
   exact product/variant/quantity; no substitutions.
   Stop at checkout, select card 5542, set leave at door / no bell / no call in
   every supported toggle plus notes, no tip/Pro subscription/credit/dues/priority.
   Do not persist save-for-later/default changes: its current default is checked,
   so a future order must explicitly prevent that write through an observed
   supported per-order mechanism. Do not tap Place order for observation alone.
3. Required **sanitized field contract**, obtained through an authorized supported
   observation channel, not a raw log: method/path/version/content-type, request
   field names/types; exact equality relations among cart response ID, checkout
   path ID and request ID; actual cart context/isolation; quote currency/full
   amount/all line quantities/prices/fees, and revision/expiry **only if supplied**;
   quiet entry `id` + `title` + selected/enabled and their post-selection readback;
   paymentMethod/addTPayMethod **for saved card**, and which saved material maps to
   cardTokenId (equality boolean only, never the token). Observe challenge signals
   and full server quote/payment/address binding. Missing actual cart association
   or numeric/card mapping remains a blocker. Missing server revision/expiry is
   **not** itself a blocker: use exact fresh observations and explicit local
   freshness without inventing a server guarantee from a hash.
4. Before parent-only HTTP prepare/place is added, document any available server
   idempotency and exact request/cart→order reconciliation, without making their
   absence a demand for unsupported API guarantees. An ordinary screenshot and
   success response do not prove replay safety. Add a durable cross-process
   single-flight journal and atomically consume exact quote-digest authorization
   **before** transmission. Keep `allowDuplicateOrder=false`; treat any timeout,
   parse failure or transport ambiguity as SUBMISSION_UNKNOWN, never resend or
   create a fresh operation identity. If exact correlation is unavailable, such
   ambiguity needs explicit manual reconciliation; list/amount/time matching is
   not exact proof. At-most-once sends remain possible without safe replay.
5. Cancellation needs a separately observed **Mart/grocery eligible-order** route,
   honest reason enum, full refund/fee review, exact test-order ownership and native
   terminal readback. Never call the item-replacement food path for this purpose.
   Parent registers any actual test with existing tracking; iMessage alone owns
   arrival notices. Cancel only that test, never an existing owner order.

This worker made no live calls. The parent already executed the explicit cart
probe; its add intent must never be reused. Checkout/commit are not implemented. This is
incremental HTTP progress, not a UI-only ordering substitution or a claim that
no-live-mutation applies to the parent.

## Tests

```sh
PYTHONDONTWRITEBYTECODE=1 ~/.local/share/uv/tools/mitmproxy/bin/python -m unittest \
  test.test_talabat_checkout -v
```

**48 focused tests pass** (2026-10-08). The actual run wrapped this one test module
with `socket.socket.connect`, `socket.create_connection` and `subprocess.Popen`
blocked; no full suite or overlapping heavy tests were run. All credentials are
synthetic, with Keychain/account/renewal/store calls mocked. No external requests
or Keychain writes occurred.

Coverage includes the existing strict card/expiry/CVV, address ownership and
ambiguity, branch binding, empty/nonempty/malformed carts, no private projection,
GET-only route/header controls, HTTP errors without retry, response size limits,
shared deadline and no auth mutation. Added regressions cover strict low-level
route locality/types, instruction schema/uniqueness/boolean requirements, exact
positive and negative control readback, explicit absent-toggle observations plus
full note readback, unchanged saved-default state, no title/ID guessing, immutable local
fingerprints, all binding changes, amount/time/expiry/digest drift, rejection of
raw/unknown fields and forged fingerprints. Even valid synthetic review evidence
plus claimed approval cannot unlock cart/quote/commit/cancel.

Ten focused probe regressions additionally cover exact string-vs-integer body
types and null weight, dry run/no persistence, fresh phone-attestation requirement,
nonempty-cart rejection, mode0600 durable intent before dispatch and duplicate
suppression, ambiguous response without retry/cleanup, safe response projection,
one POST transport including 401/no refresh, narrow body rejection, fsync failure
preventing dispatch, and readback failure without retry or loss of POST receipt. Tests use
synthetic responses and temporary nonsecret journals; they are not live success.
One later regression distinguishes missing branch echo (unknown) from a present
wrong/malformed branch, without claiming a response echo proves request scope.

Source is frozen for parent review at this checkpoint. The original five-GET
live readiness evidence has **not** been repeated after these source-only edits.
Existing deployed tracking, catalog, shared dispatch and owner carts are untouched;
no commit, push, deploy, phone action, live account read/write or skill edit was
performed by this lane during this expansion. Parent's21:21:51 UI cleanup and
22:23 successful API-only cart add are separately recorded above. The latter
cart remains present; cleanup/quote/order were not sent. Source is not deployed.
