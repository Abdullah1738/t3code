# Additional Noon native reads — 8 October 2026

## Verified live

Only off-device HTTP and the provided installed APK were used. Existing `noon`,
`minutes`, and `nownow` Keychain sessions all passed native whoami and the saved
Home address-code/key binding. No credentials, raw HTTP responses, customer
addresses, payment fields or driver contact details were persisted or printed.
No phone, browser, mail, carts, notifications, Keychain writes, deployment or
commits. Existing source files remain owned by their other workers.

### Marketplace order detail

New route: `GET https://api-app.noon.com/_svc/order-v2/order/{orderNr}`.
This is not the previously unsuccessful `/_svc/order/api/order/{orderNr}`.

APK Hermes `getOrderDetailsV2` calls `api.get` with the order appended to this
path. At 15:01 UTC the module read exact order `NAEIA0002358740`, one `itemGroups`
entry, item `NAEIA0002358740-1`, shipment `NAEIA0002358740-S1`, quantity 1 and
`subStatus.highStatusCode=delivered`. Unlike history, this endpoint takes an
exact order, with no page argument. Its response has invoice, shipping address,
itemGroups and order-level actions; only IDs, quantity and item state survive
projection.

**Full-inventory contract now verified for conservative completion.** Follow-up
inspection found an independent item count in the invoice's summary and grouped
entries: exact labels `Subtotal (1 item)` / `Subtotal (2 items)`. All occurrences
must agree. The app's `getOrder` calls `getOrderDetailsV2(orderNumber)` without
pagination. Its order view reads `order.itemGroups`, reduces the groups to the
item inventory, and renders each group. This is distinct from bounded history
cards and item/shipment detail routes.

Bounded live study inspected 20 history cards (17 distinct recent own orders),
then six exact order details, including two multi-item orders:

- `NAEIA0002358740`: one delivered item, shipment `-S1`, invoice count 1.
- `NAEIA0010650214`: items `-1`, `-2`, both delivered, same `-S1`, count 2.
- `NAEIA0086947289` and `NAEIA0021471294`: one delivered item each.
- `NAEIA0040023791`: one cancelled item, shipment null.
- `NAEI90039840903`: two cancelled items, shipments null, count 2.

No multi-shipment order occurred in that bounded history sample. Synthetic split-
shipment validation is tested, not claimed as live coverage. Quantity >1,
bundles, localized invoice labels, returns and mixed terminal states are not
certified by this study. Cancelled marketplace items stay unknown in the
merchandise-detail projection used by money-cases; the separate tracking
projection's all-cancelled inventory rule is not money-cases coverage proof.

`manifest_complete=true` now requires the full order envelope, nonempty groups,
exact order/item/shipment identities, unique item IDs, consistent group/item
states, two or more agreeing invoice-count occurrences, and equality of invoice
count, distinct item count and summed quantity. Bundles and new pagination,
partial, truncation, count or completeness signals fail closed. Whole-order
`delivered` additionally requires every item delivered and a shipment for each.
Missing groups, malformed or duplicate IDs throw sanitized errors; incomplete
counts return unknown. Transport rejects oversized, truncated and duplicate-key
JSON. This certifies the returned native full-order contract, not a claim that
bounded history itself was exhaustive. A server that silently corrupts both its
inventory and matching invoice count is outside observable client guarantees.

Live module recheck returned `manifest_complete=true`,
`whole_order_complete=true`, `status=delivered` for both the one- and two-item
delivered orders above, with account/Home verification.

### Food

For a delivered Food order placed on the automatic saved-card path (explicit
null client secret, no completion sent), `commerce close-food-captured FLOW
--bank-msg-id ID` validates the retained placement, the exact delivered order
and its automatic payment detail, and an EmiratesNBD purchase SMS on 2342 for
the exact amount within 30 minutes after placement. Review the dry run, then
add `--confirm` to close locally as COMPLETE, retaining the reservation and all
consumed operations. It never places, pays, or retries; live Food placement
and completion remain disabled. A changed evidence record cannot close again.

New verified routes on `api-app-fd.noon.com`:

- `POST /_svc/mp-food-api-mpnoon/order/orders`, body `{}`: native default list.
- `GET /_svc/mp-food-api-mpnoon/order/tracking/{orderNr}/info`: exact tracking.

Static evidence: Hermes `getOrders` uses `FoodApi.post`; `getOrderTracking`
uses `FoodApi.get`, the tracking path, exact order argument, and `/info` suffix.
Use existing `noon` session with `x-mp=food`, `x-experience=food`, and revalidate
whoami/Home. The list's four optional positional argument names/pagination
contract were not fully decoded in October. The explicit page contract is now
verified below; callers omitting a page retain this original empty-body read.

Live default list returned `status=success`, `data.pages=1`, 21 own orders.
All 21 had agreement among `orderStatusCode=delivered`,
`logisticsStatusCode=delivered`, and `isDelivered=true`. Projection requires that
agreement before returning delivered from a list row. This remains a default
page, explicitly non-exhaustive, regardless of the reported page count.

Exact tracking of first returned ID `FE96NN7V0AOPFGA` returned
`status=success`, exact `data.orderNr`, and `data.status=delivered`. Its status
was independently consistent with the list row. Second list ID was
`FE96NN0QMKW5XRA`; no tracking call was needed for that order.

Exact Food tracking also maps `preparing`, `delivering` and `picked_up`, with
verified native ETA windows. Live evidence on 13 November 2026 confirmed raw
`canceled`, projected to `cancelled`; provider status labels remain verbatim.
Other enum values remain unknown. Delivered tracking still exposes rider contact and
coordinates without an established display gate; these are deliberately omitted.
Food list responses also include payment-client-secret fields: never return or
log the upstream object. The module constructs a fresh small allowlisted output.

### NowNow: base composition resolved, live tracking verified

`NNMPBaseUrl.getUrl` explicitly selects `nownowConfig.prodMPNoonNNBaseUrl`
unless `config.env == staging`; it does **not** select `prodMPNNBaseUrl`.
Decoded Hermes object shape 831 and literal buffer at offset 678656 establish
the production value as `https://api-app-fd.noon.com/_svc/mp-shop-api-mpnoon/`.
The similarly named `mp-shop-api-mpnownow` was the wrong base and explains the
earlier 503; it is not an auth-expiry finding. No guessed sweep was used.

The return options are `{baseURL, headers}` (shape 19696), with `X-Address-Key`
(shape 29181) constructed from the selected address key by replacing the first
hyphen with a colon. Implementation loads only the existing NowNow catalog
template headers, verifies native whoami/Home, then adds that derived header.

Verified read routes under that base:

- `POST v1/order/history`, body `{}`: 24 own orders, reported pages 1; 23
  delivered and one canceled. Default-page coverage remains non-exhaustive.
- `POST v1/order/details`, body `{"orderNr":"EXACT_ID"}`: exact identity.
- `GET v1/order/tracking/EXACT_ID`: tracking status.

`NNOrderServices.orderDetails` uses POST; its app consumer constructs object
shape 19674, decoded key `orderNr`. Tracking and history method/path composition
are also explicit in the APK.

Live exact checks:

- `NNG9UNNZOHP800MA`: detail `orderNr` exact; detail order/logistics/customer
  status and tracking status/orderStatusCode all `delivered`.
- `NNG9UNNMW8HT7DNA`: same five-field agreement on `canceled`; normalized output
  is `cancelled`.

Tracking does not echo an order ID. Therefore `track(..., service='nownow')`
requires the separate exact-ID detail first, then agreement with the tracking
resource on that same requested ID. Wrong detail identity errors before tracking;
state conflicts return unknown. Only delivered/canceled are live-mapped. ETA,
rider contact, location and all financial fields are omitted. Active progression
and a current-order ETA/rider-display contract remain unverified.

## Interfaces and safe parent integration

`noon_vertical_reads.py` depends on sibling `noon_http_orders.py`:

- `track(order, service='food'|'marketplace'|'nownow', timeout=10, *, deadline=None)`;
  service is required. `deadline` is an internal absolute monotonic budget,
  inherited unchanged when the marketplace aggregator calls both readers.
- `food_orders(timeout=10, *, page=None)` and `nownow_orders(timeout=10, *, page=None)`.
  An explicit page uses the verified ten-row request; omitted pages retain the
  original default list and non-exhaustive coverage.
- Raises the existing `NoonError` with sanitized codes.

Parent may route explicit Food requests / validated `F...` order IDs here,
translating `NoonError` to its `OrderError`. Do not use generic probing to detect
verticals. Route `NN...` explicitly to NowNow **before** generic marketplace
`N...` dispatch. Marketplace routing here rejects `NN...`. Parent may add
`--service nownow`; do not probe services for an ID.

Marketplace merchandise-detail reads used by money-cases provide proof only when
both manifest flags are true and `status=delivered`. Preserve existing exact
item/shipment evidence; if it conflicts with a delivered manifest, keep unknown
rather than overriding the conflict. A failed/incomplete manifest must not erase
previous scoped evidence or become whole-order delivered.

The hardened `native_orders.py` aggregator checks both scoped `items` and
`shipments`, including nested `item_ids` and item-to-shipment associations. All
observed IDs must reconcile with the manifest. Explicit raw statuses other than
`delivered` veto whole delivery even when normalized to unknown; retained card
and timeline conflict warnings veto too. A later successful detail does not erase
conflicting card evidence. The core carries card membership into successful
detail results so tracker item-to-shipment deduplication keeps working. No tracker
source or tracker test changes were needed for this hardening.

Transport is a literal six-route allowlist, no redirects, no system proxies,
2 MB wire/decoded limits, one monotonic deadline including Keychain load and
whoami, and the core SIGALRM enforcement. Credentials remain in memory. It
fails closed on mismatched IDs, duplicate manifest items, missing groups,
unknown state enums and malformed responses.

Both tracking readers accept the original absolute deadline. An expired inherited
deadline stops before session/Keychain work, and projection must finish within the
budget. The aggregator also checks the manifest's return boundary before accepting
it; a late manifest is discarded without losing previously accepted scoped proof.

Fourteen focused unit tests passed, plus live calls to all six added read routes:

```sh
PYTHONDONTWRITEBYTECODE=1 ~/.local/share/uv/tools/mitmproxy/bin/python -m unittest test.test_noon_vertical_reads -v
```

The tests cover manifest identity/duplicates/quantity, reconciled whole-order
delivery, partial counts, missing envelope/invoice, conflicting counts/status,
new pagination, bundles, absent delivered shipments and synthetic split shipments;
NowNow exact identity, state agreement and delivered/canceled/unknown states;
read-only route construction and duplicate-key/truncated JSON;
Food privacy and exact identity, unverified enums, list-state disagreement and
route/input rejection, sanitized HTTP errors, expired deadlines and oversized
responses. They do not claim comprehensive independent transport
testing; the core's existing transport suite and a parent review remain useful.

The subsequent integration hardening used no live HTTP/Keychain/phone/browser
access. New regressions were run red before implementation: late reader entry,
late manifest projection/return, explicit raw and collapsed status conflicts,
missing or remapped observed inventory, and a real two-poll tracker replay for
item-to-shipment arrival deduplication. Run the complete focused offline set:

```sh
PYTHONDONTWRITEBYTECODE=1 ~/.local/share/uv/tools/mitmproxy/bin/python -B -m unittest test.test_native_orders test.test_noon_http_orders test.test_noon_vertical_reads test.test_order_tracker test.test_amazon_email_orders
```

## Static evidence location

APK supplied at `$TMPDIR/opencode/noon-tracking.apk`, Hermes HBC version 98,
source hash `7f22f8cf886b8a369d91ad8529029e45ac10a65d`.
The installed compiler at
`~/.local/share/forge-deps/node_modules/hermes-compiler/hermesc/osx-bin/hermesc`
supports `-b -dump-bytecode`. It yields truncated string previews in instructions;
full strings are available in its string pool. Relevant static snippets are in
repo scratch `tmp/noon-vertical-research-20261008/evidence.txt` and
`continuation-evidence.txt`. Follow-up disassembly completed in 150 seconds.
Static offsets: object keys 8129464, literal values 6979476; serialized tags
0x5 = uint16 string ID, 0x4 = uint32 string ID, with low-nibble run length.
Relevant functions: NNMPBaseUrl/getUrl around disassembly line 4046257,
NowNow config construction 1164956, orderDetails/trackOrder/orderHistory 2920578,
getOrderDetailsV2 2555386, order screen getOrder 5079510, and item-group inventory
consumption 5077760. These are APK facts, not remote configuration guesses.

## History and placement-time proof (14 November 2026)

Re-extracted the installed APK read-only. Hermes HBC98 source hash:
`5b3d2a34efdc976ed0775abe14f49a8fd9c69cb8`. The following are line anchors in
`hermesc -b -dump-bytecode`, not offsets in the older October bundle.

### Food and NowNow local wall times

The legacy Food order card `render` at 5511553 reads `createdAt` and formats it
with `dayjs(value).format('DD MMM YYYY')` at 5511598, without UTC conversion.
`FoodMyOrderDetailsScreen.render` reads the exact order's `createdAt` at 5574186
and passes it to `formatDateTime`. NowNow `NNOrderInfoSection` at 3645390 and
`NNOrderHistoryCardHeader` at 3656830 both pass `createdAt` to `formatTo12Hours`
(3622154), which constructs `Date(value)` and uses `toLocaleDateString`.
These are local-wall-time consumers. The separate Nano formatter at 5271644
uses `dayjs.utc(...).local()`; it is **not** evidence that the legacy API returns
UTC. Do not apply its convention to these routes.

All 33 Food and 34 NowNow live list rows carried `timeZone='+04:00'`.
Exact details for three orders in each lane echoed both the list creation time
and that separate offset. Independent same-amount noon bank alerts established
the following deltas (alert minus order, after applying the response offset):

| Lane | Order wall time | Independent zoned charge time | Delta |
|---|---|---|---:|
| Food | 2026-11-12 17:26:39 | 2026-11-12T17:27:18+04:00 | 39 s |
| Food | 2026-11-09 18:40:28 | 2026-11-09T18:40:47+04:00 | 19 s |
| Food | 2026-11-07 17:14:47 | 2026-11-07T17:15:06+04:00 | 19 s |
| NowNow | 2026-10-15 19:24:46 | 2026-10-15T15:32:14+00:00 | 448 s |
| NowNow | 2026-10-14 11:33:58 | 2026-10-14T07:41:13+00:00 | 435 s |
| NowNow | 2026-10-11 16:00:04 | 2026-10-11T12:08:11+00:00 | 487 s |

Food corroboration used copied money-cases state; NowNow used local archived
bank-alert timestamps, with message bodies only parsed in memory. No UTC
interpretation matched these samples; no contrary match was found. These alerts
corroborate the time zone, not exact payment-processing latency. Confirmation
mail searches for the initial sample did not yield order confirmations.

`placed_time` accepts an already zoned ISO timestamp, or a strict ISO wall time
with the independently verified separate `+04:00` offset. Missing/malformed
times and other separate offsets stay unknown. It never inserts a zone merely
because the service is Food or NowNow. Lists and details share this parser.

### Food and NowNow numbered pages

Food `getOrders` at 2739881 constructs shape 22125. Object-key buffer file
offset 9404404, shape offset 425286, four uint16 string IDs decode, in argument
order, to **year, page, limit, customerCode**. The only enabled body is
`{"page":N,"limit":10}`; year/customer filters remain unused.

NowNow `orderHistory` at 3593048 passes its argument unchanged to
`POST v1/order/history`. Its `useNNOrderHistory` continuation at 7810166 calls
that method, tests `page`, and its reload paths at 7810006/7810069/7810121
construct shape 24108 (**page, limit**). The response consumer at 7809950
extracts `data.data.orders` and treats empty orders as the end.

Live full traversal with that body:

| Lane | Page 1 | Page 2 | Page 3 | Page 4 | Page 5 | Reported pages |
|---|---:|---:|---:|---:|---:|---:|
| Food | 10 | 10 | 10 | 3 | 0 | 4 |
| NowNow | 10 | 10 | 10 | 4 | 0 | 4 |

All IDs were distinct within and across pages; all normalized creation times
were newest-first. The histories reached January and March 2024 respectively.
Explicit numbered reads report `paging_verified`, `page`, `total_pages`,
`ordered_by_placed_at`, and end-of-history `exhaustive`. This last flag describes
the final page: a consumer must traverse the preceding pages before claiming
an exhaustive lane. Repeated pages, missing page metadata and timestamp ties
are tested at the money-cases boundary. Omitted-page reads remain unverified.

### Marketplace cursors and whole-order evidence

`getOrdersHistory` at 3016057 uses `ORDERS_HISTORY`, URL.search with `cursor`
(shape 23861, offset 444652) and `limit` (shape 23862, offset 444660), then
`api.get`. No numeric page parameter exists on this route. Live read-only
`GET /_svc/order-v2/orders/history?limit=10&cursor=...` traversed **20 pages,
197 distinct item/shipment cards**, ending with seven cards and `hasMore=false`.
Every page added distinct cards. Orders can straddle pages because cards are
item/shipment-scoped; repeated order IDs alone do not mean a repeated page.

The cursor follows `pagination.nextCursor`; `hasMore` must be boolean and a
continuation must have a nonempty, advancing cursor. The native reader accepts
an optional cursor to avoid replaying prior requests; a standalone numbered
page replays the chain within its existing deadline. Exact tracking keeps its
original bounded active/history reads. Direct callers omitting `page` also keep
their original request and first-page-only flags (including order discovery).
History's `header.date` describes the
terminal shipment event, **not order placement**, so no creation-time prefix
coverage is claimed from Marketplace ordering.

The exact full-order route continues to provide zoned `createdAt` (for example,
the sampled third-page order returned `2026-10-22T10:33:08+04:00`). Its view
`children` at 7354109 reads `createdAt`, `invoice`, and `itemGroups` from the
same full-order object. Whole-order delivery still requires the existing
independent invoice-count/complete-manifest proof described above. Details now
expose that proof for cache eligibility. Cancellation/failure remains unproven
for whole-order money-cases coverage; neither freezes cached totals nor establishes
a clean negative there. Active rows without known placement times still block
coverage until read, and Marketplace must exhaust history to prove absence.

### Cancellation and alternative history investigation (15 November 2026)

The installed APK was pulled again without opening or changing the app. HBC98
source hash remains `5b3d2a34efdc976ed0775abe14f49a8fd9c69cb8`; all anchors
below refer to that dump. This investigation **does not establish** a new
whole-order cancellation/failure contract or a placement-ordered prefix.

The order screen's `getOrder` at 6216060 calls `getOrderDetailsV2` with
`props.orderNumber`; the service at 3016311 makes the exact GET. The view at
7354109 reads `cancellationMessage` from the order envelope into environment
slot 6, independently of `itemGroups`. Its header renderer at 7907582 tests
that slot's truthiness through `renderIf` (7907643); it does not reduce item
statuses to derive the message. No sampled live response included that field.
The inspected view therefore supplies no usable whole-order cancellation
predicate for these responses.

`renderPayments` at 6216937 reads `order.trackActions.view_refund_tracking`
(6216960) and renders its control when the action is nonempty (6217018).
This is a refund-navigation affordance, not a whole-order status. The live
mixed-order counterexample below and two all-delivered inventories have it too.
The similarly named
`isOrderCancelled` at 4151496 reads `timeline[].status.highStatusCode`;
the inspected full-order response shapes have no such timeline. Its name alone cannot
promote a shipment tracking result to an order-level result.

Read-only history traversal reached `hasMore=false`: 20 pages, 197 cards,
115 distinct orders. Exact GETs read all 115 orders, yielding 87 all-delivered
inventories, 27 all-cancelled inventories, and one mixed inventory. None had
`cancellationMessage` or top-level `status`, `subStatus`, `orderStatus`, or
`statusCode`. Sample labels below are local encounter ordinals, not order IDs.

| Sample | Item states | Invoice units / observed units | Refund action | Order cancellation field |
|---|---|---|---|---|
| 7 | 2 cancelled | 2 / 2 | present | absent |
| 8 | 1 cancelled | 1 / 1 | present | absent |
| 9 | 1 cancelled | 1 / 1 | present | absent |
| 114 | 2 cancelled, 5 delivered | 7 / 7 | present | absent |

All four reconcile under the existing manifest checks and carry zoned
`createdAt`. Local archive searches for exact-order noon mail found no rows
for samples 7-9. Sample 114 had four rows, including one cancellation subject
and two delivery subjects. These metadata corroborate its mixed state; they
do not establish cancellation or refund settlement for the other samples.

The missing Part A evidence is an app-defined whole-order cancellation rule
with a live order-level discriminator, or an app reduction that explicitly
defines the whole-order outcome, together with positive and mixed controls.
Inventory agreement alone and the existing tracking projection's reduction
are insufficient for that requested proof. No `whole_order_status` is exposed,
no failure status is inferred, and cancellation detail is not made cacheable.

Part B inspected `getOrdersHistory` (3016057): its query fields are `cursor`,
`limit`, `q`, `status`, `service`, `date_from`, and `date_to`. There is no
placement sort argument. The 115 exact creation times encountered in the
live cursor chain contained nine adjacent newest-first inversions; page 2
was not strictly older than page 1. Neither a prefix nor a date-filter
interpretation is certified.

The older `getOrdersV2` at 3015887 uses `GET /_svc/order-v2/orders?year=...`.
Shape 23856 (key-buffer offset 355010, buffer file offset 9404404) decodes to
`year`, with no page, cursor, or sort key. `getOrders` at 6206825 selects that
year and `updateStateFromResponse` at 6206882 consumes `dataGroups`; the
feature-gated older path remains visible in `loadOrders` at 6663460.
Live year reads returned empty `processing` groups and `completed` groups
of 102 cards (2026) and 64 cards (2025). Cards still carry item/shipment IDs,
and expose neither `createdAt` nor pagination. This verifies the older
grouped route exists, not placement ordering or an exhaustive coverage
contract. No separate reader form is enabled. Nano's separate active/history
constants do not prove coverage of this Marketplace account history either.

The full cold cursor-and-detail experiment took 76,553 ms, including four
local archive metadata searches. Replaying the 20-page chain with all creation
times already held in memory took 10,383 ms; a separate history-only traversal
took 11,562 ms. The warm figure is an optimistic lower bound: no per-order
validation, account re-verification, or production process startup is included.
It already exceeds the money-cases lane's 8,000 ms maximum (7,800 ms for the
child before startup costs). No budget is raised and no cross-run cursor is
retained. Money-cases keeps `scoped_cancellation`, null Marketplace coverage,
and its existing matching semantics. A proven cancellation rule would still
leave the full-chain timing and mixed-order proof unresolved.
