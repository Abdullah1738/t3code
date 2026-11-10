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
certified. Cancelled marketplace items stay unknown for order-level status.

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
contract were not fully decoded, so only the live-verified empty body is allowed.

Live default list returned `status=success`, `data.pages=1`, 21 own orders.
All 21 had agreement among `orderStatusCode=delivered`,
`logisticsStatusCode=delivered`, and `isDelivered=true`. Projection requires that
agreement before returning delivered from a list row. This remains a default
page, explicitly non-exhaustive, regardless of the reported page count.

Exact tracking of first returned ID `FE96NN7V0AOPFGA` returned
`status=success`, exact `data.orderNr`, and `data.status=delivered`. Its status
was independently consistent with the list row. Second list ID was
`FE96NN0QMKW5XRA`; no tracking call was needed for that order.

Only Food `delivered` is live-verified. Unknown/active/cancelled enums are not
mapped. ETA remains null. Delivered tracking still exposes rider contact and
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
- `food_orders(timeout=10)` and `nownow_orders(timeout=10)`.
- Raises the existing `NoonError` with sanitized codes.

Parent may route explicit Food requests / validated `F...` order IDs here,
translating `NoonError` to its `OrderError`. Do not use generic probing to detect
verticals. Route `NN...` explicitly to NowNow **before** generic marketplace
`N...` dispatch. Marketplace routing here rejects `NN...`. Parent may add
`--service nownow`; do not probe services for an ID.

Marketplace order-detail reads now provide actual whole-order proof only when
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
