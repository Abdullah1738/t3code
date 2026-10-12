# Talabat HTTP tracking

`talabat-search track ORDER_ID --json` uses native authenticated HTTP without
opening the phone or a website. `order-track --app talabat --order ORDER_ID`
uses the same result before existing fallback sources. Dispatch belongs to
`native_orders.py`; this module does not order, cancel, pay, register or send OTP.

## Identity and bounded renewal

The account is separate from guest catalog search. Tokens and the expected
profile live only in Keychain (`app-api-cli.native`, `talabat-account`). Every
read checks GET `/customers/v1/profile` against that binding, then GET
`/order-tracking/v4/order-tracking/ORDER_ID` against the requested ID. Redirects
and environment proxies are disabled; each response is limited to 2 MB.

`read_with_renewal(operation, deadline)` owns **one** renewal/retry across tracking
and listing. It captures the token from the exact read snapshot, allows expiry
only for renewal, and calls `talabat_auth.refresh(rejected_token=token,
deadline=original_deadline)` on local expiry or HTTP 401. After renewal it reloads
the account and repeats the entire profile/read operation. Listing restarts all
requested pages, not just a failing page. A second 401 propagates. No retries for
403, identity mismatch, unknown schema, ambiguous maintenance, or other errors.
Dispatch must not wrap this with another refresh retry. OTP is never automatic.

All network phases and the renewal lock share the original elapsed budget.
Timeouts must be finite, positive and at most 120 seconds. Main-thread SIGALRM
bounds even drip-fed headers/bodies; an existing alarm or threaded caller fails
closed. Native Keychain OS calls are not interruptible HTTP operations; results
arriving after the budget are rejected before further network work. A fully
received mutation response is retained as opaque bytes in Keychain **before JSON
decoding** in one local-only phase (two-second allowance). That allowance never
extends the original parse/profile validation budget. A parse timeout retains
the response for explicit reconciliation; no POST is repeated. Keychain OS calls
may defer Python signals until returning; retention failure stops without retry.
Publication rechecks the base immediately before writing. All legitimate writers
must hold the shared account lock: Keychain has no atomic compare-and-swap, so
this cannot eliminate a final race with an arbitrary out-of-lock writer.
See TALABAT-AUTH.md for reconciliation and storage-failure limits.

## Instantiated SDUI projection

Never recursively search widgets/templates/events for a convenient rider or ETA.
Only widgets referenced by `layouts[name=body].column` are considered:

- Active header: `widgets.header_with_lifecycle_order_component` (Stack), actual
  `data.children[]` FluidComponent, `data.component.properties.order_container`
  `.properties.cells[]`, template_id `active-order-item-v2`. Its `tracking_key`
  must match the requested order, `title_offstage` must be false, visibility must
  allow display, and exactly one cell may match.
  All children/cells in the size-bounded response are inspected, not just a
  30-element prefix; conflicting matches anywhere suppress the projection.
- ETA is the actual cell's `properties.title`, e.g. `Arrives in 10-20 mins`,
  `Arrives in 9 mins`, `Arrives within 5 mins`. It is exposed as `eta_text` with
  the precise `eta_source` path. **`eta` remains null**: no absolute timestamp is
  invented. Event `eta_lower/upper` had no timezone and conflicted with display;
  they are not parsed as UTC or local time.
- The same cell's `sub_title` becomes `status_text`, with its precise source.
- Rider: `widgets.tlb_app_bff_passthrough.data.component.properties.children[]`,
  instantiated template_id `rider_info`. It must be layout-referenced, visible,
  have `has_text=true`, `has_contact_bottom_sheet=true` and the observed active
  description `is your delivery hero for today`; past-tense rider descriptions
  are suppressed even during a lagging active status. Explicit hidden or
  false show policies suppress it. Exactly one qualifying component is required.
  Only name and source/visibility provenance are projected. Contact bottom sheets,
  phone, chat/call actions, images, coordinates and templates are not inspected.
- **No exact visible active order means no rider fallback**, even if some
  rider_info object exists elsewhere. Terminal/unknown stages hide ETA/rider.

## Live evidence, 8 October 2026

Auth bootstrap plus one legitimate refresh succeeded; post-renewal profile and
tracking verified delivered orders 3943476390 and 3943292030 at 14:17 UTC.

Active test order 3944138092 supplied these independent/HTTP observations:

| Dubai time | Evidence | Normalized stage |
|---|---|---|
| 18:29 and 18:31 | Parent app: almost ready, rider Jehanzeb at store; ETA 10–20 mins | preparing |
| 18:32 | HTTP order_almostready with matching actual title/subtitle | preparing |
| 18:35:24 | HTTP order_delivering; actual subtitle “Your order is on the way”, ETA 10 mins | out for delivery |
| 18:37:13 | Same actual header, ETA 9 mins; instantiated rider_info title Jehanzeb | out for delivery |
| 18:41:45 / 18:42:12 | order_delivering, actual subtitle “Your order is nearby”, ETA within 5 mins | nearby |
| 18:45:45 | Parent HTTP list Delivering paired with same exact tracking order_delivering | list: out for delivery |
| 18:50:51 | Still order_delivering/nearby, but rider description became past tense | nearby; rider suppressed |
| 18:51:12.942 | First sampled order_delivered; actual title Order delivered / Enjoy your order! | delivered; ETA/rider null |

Raw delivery_status is preserved. `order_almostready -> preparing`,
`order_delivering -> out for delivery`, `order_delivered -> delivered` are
verified. Nearby requires **both** order_delivering and the exact visible
same-order subtitle “Your order is nearby”; `status_source` records that cell.
Unknown enums remain unknown, even if familiar-looking text is elsewhere.
List `Preparing`, `Delivering`, `Delivered` are verified; list ETA/rider stay null.

Finite sampling is capped at 15 minutes / 45 calls, at least 20 seconds between
samples or the upstream meta interval if longer (observed meta: 10 seconds).
Only bounded allowlisted observations are saved; tests use synthetic identities
and sanitized component shapes, never raw responses or credentials.
The sampler stopped immediately on delivered (terminal meta became 250 seconds),
within its 15-minute cap. Detection time is not an assertion of physical arrival.

## Remaining limits

No verified placed, picked-up or cancelled enum yet. No absolute ETA timezone,
rider contact details or account-benefit/address assertions. New SDUI layouts,
hidden/ambiguous cells or unknown visibility controls produce null details rather
than guessed visibility. Order history is bounded, not a snapshot transaction.
No phone/browser use, purchases, cancellation, logout/revoke or deployment is
part of this implementation.

Implementation: `talabat_http_orders.py`, `talabat_http_list.py`, `talabat_auth.py`.
Tests: `test/test_talabat_http_orders.py`, `test/test_talabat_http_list.py`,
`test/test_talabat_auth.py`.
