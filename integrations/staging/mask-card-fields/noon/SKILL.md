---
name: noon
description: Use for anything on noon (noon.com shopping, noon Minutes, NowNow, Supermall, orders, returns, tracking) for Abdullah. Ordering on Minutes/NowNow/Main/Supermall via the commerce CLI first; phone app (ph) only as fallback for CLI-unsupported baskets, account actions and returns.
---

# noon — CLI first, native app fallback

Owner correction, 9 Nov: noon Food orders go through `commerce order food` first.
A gated or incomplete CLI lane is a bug to fix, not a reason to quietly place on
the phone. If a CLI order cannot be placed, say so to Abdullah before using the
phone. Never repeat an ambiguous send through either interface.

Food automatic saved-card path: `commerce order food --outlet-code CODE
--items-file FILE --prepare-only`, then the same command with `--resume-flow FLOW`
and without `--prepare-only`. Exact false CVV/completion flags are required. A real
intent, CVV or 3DS requirement returns needs-app; there is no payment-completion
writer. `commerce recover-payment FLOW` only reads the exact order after placement,
including after checkout-session expiry. Capture needs exact native automatic
processing plus a unique bank purchase for the retained card, amount and time
(Mashreq 9546 email or ENBD 2342 SMS). Until both exist, tracking stays held.

## Card rule (owner, 9 Nov 2026)

ALL noon lanes use saved Mashreq Noon Visa **9546** by default. Marriott Mastercard
**2342** is an explicit fallback only if 9546 fails/declines, after exact payment
reconciliation proves a replacement is safe. Never 5542, COD or wallet-only.
Run `card-status check` for the selected card. CVV: `MashreqNoon.card_cvc` for
9546, `Marriott.card_cvc` for 2342; secrets stay in RAM. Historical proof amounts
and card numbers below describe past orders, not the current selection rule.
Before final Pay/Place order/Request, read the on-screen last four and run `card-status assert-final MERCHANT LAST4` (noon 2342 needs `--fallback` only after failure/decline and safe reconciliation); after a payment-method change, record it with `card-status merchant set MERCHANT LAST4 --source "<how known>"`, settle open invoices within existing authorization, and set a 24-hour check.
CLI card selection deployed 9 Nov 2026 from commit `1cc174a7cc`: 9546 is the
default; explicit fallback is `COMMERCE_CARD_LAST4=2342 commerce ...`.
Food uses `commerce order food` first, including automatic saved-card payment on 9546.
`commerce order nownow ... --prepare-only` can review a 9546 basket. Live NowNow on 9546 is blocked as unproven (`NOWNOW_9546_PAID_CONTRACT_UNPROVEN`). A 2342 fallback needs a recent recorded 9546 decline, recorded owner approval, a `--prepare-only` of the same basket within 60 minutes and a flow under 12 hours old. On `NOWNOW_FRESH_PREPARE_REQUIRED`, re-run `--prepare-only`. NowNow stays unproven until one real order completes with capture and tracker evidence. A fenced NowNow cleanup doesn't block new orders; never resend a delete or a financial request.
CVV verification is journalled once and may require an AED 1 bank check before
order placement. A verification is not purchase capture. On a bank redirect,
stop and notify the requester with the actual verification amount; open the
retained redirect in a dedicated Dia agent window only with authorization.
Never resend completion on the original flow. New orders remain available; a matching pending basket needs --ack-pending FLOW. `recover-payment FLOW`
reads the retained intent; a successfully approved, observed challenge may
resume the same basket with `--resume-flow FLOW` without repeating verification.
Unknown sends and failed verification remain fenced until exact reconciliation.
`commerce release-flow FLOW --dry-run` checks an expired NowNow pre-order bank challenge without closing it. A live release needs FENCED challenge history, an expired 24-hour continuation window, terminal noon intent failure/expiry/cancellation, zero authorisation and capture, and exact account-bound order history covering the flow start with no matching or ambiguous order. Missing or ambiguous evidence leaves the flow fenced. A pending redirect with zero captured is not release evidence. Main, Supermall and Food still use exact-order reconciliation.
For a released NowNow cart, the original item/store arguments with
`--resume-flow FLOW --prepare-only` perform a read-only review and eligibility
check (`released_cart_review_only: true`). This is not a replacement purchase
flow. The retained store cart still blocks automatic creation of another cart
for that store. Device verification the CLI cannot prove stops before sends.

NowNow purchase capture requires the exact retained order details plus one bank
purchase matching the original card, amount and placement time. This works by
order ID after checkout expiry. Pending evidence registers a held tracker;
release needs capture and a verified delivery-card sent receipt. Modifiers and
item notes are currently unsupported and refuse before mutation.

9 Nov NowNow verification attempt: one Grenade White Chocolate 330ml shake, Monoprix,
AED 26.70 prepared. The single AED 1 verification failed 3DS (19046), with zero
authorized/captured; no placement or order ID. Full 9546 purchase/capture proof
is still outstanding. Flow `3c9f7d65-c713-434d-8130-c1fea6c49176` was terminally
RELEASED on 9 Nov with the exact failed intent and unchanged unplaced cart,
after commit `7e615f618e` was pushed to PR #4 and deployed. Account availability
and a read-only `--prepare-only --resume-flow` review passed (AED 26.70, 9546,
zero placement/payment sends). The account fence was lifted; the retained Monoprix cart was subsequently cleared
with the guarded command below. Never resume the released flow for purchase or
silently use 2342.


## Delivery cards (2026-10-22)

Load `delivery-cards` after placement. New commerce/manual order-watch registrations
create and send one self-updating card: owner gets a tailnet native card; Moni gets
a public rich link. Verify `delivery_card.status:sent` in the tracker receipt.
This replaces Moni's placement text below; don't send both. Pass the actual
`--vertical` and optional `--items-file` display metadata on manual registrations.
No extra progress pings. Payment-unconfirmed cards remain held.

## Moni orders (nightly review 2026-10-15)

- **Tell her at placement, via the tracker:** pass `--for moni` to `commerce order ...`
  (phone/app orders: `order-watch add --for moni ...`). It texts her the placement (what +
  ETA) once per order in her Robob thread (bridge `send --to moni`; never Abdullah's imsg,
  owner rule 2026-10-21), only after payment is confirmed. Don't also text her
  yourself; if you already did, add `--no-placed-text`. Label `"Store: items"` or pass
  `--store`. Check the receipt before reporting success: `moni_notified` must be `sent`. On
  `failed:*`, check her thread's outbox (`~/.config/spectrum-bridge/chats/moni/state.sqlite`),
  then text her by hand with `cli.ts send --to moni` (plain, what + ETA,
  never starting with "robob"). `moni_notice_held: true` = payment unconfirmed: run
  `commerce recover-payment` before telling her. `--dry-run-text` previews. Moni-order
  subagent briefs must include this; the parent verifies on completion (missed 4 times on
  14 Oct).
- **Her stop wins (nightly 2026-10-20).** "Leave it", "cancel", "forget it" stops every step for that
  request in the same turn: no prepare-only, card fix, reconcile or retry after it. One order agent per
  request. `commerce order --for moni` refuses with `MONI_CANCELLED_AFTER_GO` (exit 1, nothing sent)
  when she cancelled after her go; never retry it, only her new go clears it. Before any other Moni step
  (prepare-only, resume, recover, phone fallback) run `python3 ~/.local/share/app-api-cli/moni_go.py
  check --go "<her words>"`: exit 0 go stands, 4 she cancelled (stop), 2 no go found. Continuation
  briefs must re-read her chat. 19 Oct PSL ran three agents and kept going after her 11:45 "pls leave it".
- **Request from her agent over the agent bus (owner rule 2026-11-15).** Pass `--moni-bus-request <areq id>`
  instead of `--moni-go` on placing runs. It checks an active moni-to-owner request from the last 24 hours;
  done, declined and done_late refuse. For continuations, recheck it with `agent_bus_read.bus_request(id)`
  first and never retry after it closes. Her stop above still wins, and requests made in her chat keep the
  `--moni-go` check.
- **Go given in a group chat (owner rule 2026-10-27).** The go check reads chat 45, her Robob 1:1 and every
  group chat she's in, so a go she gives in a group (e.g. "Group sb_gro") is found with no extra flag. In a
  group only her own messages count, and a cancel from her in any of these chats still stops the order. When
  you know the chat, pass its slug: `commerce order ... --moni-chat <chat-slug>` and `moni_go.py check --go
  "<her words>" --chat <chat-slug>` (e.g. `group-sb_gro`; it then reads chat 45, her 1:1 and that chat only).
  Put the chat slug in every order brief. Don't set `MONI_BRIDGE_DB` any more: it limits the check to that one
  chat DB. 27 Oct: a 482 AED Minutes order stalled until Abdullah chased it.
- **Her go only.** "Order X" is a go for exactly X. A question ("what's best?") or an
  offered basket is not; anything you picked, swapped or added needs her ok. Wait at least
  10 min after proposing; never "ordering it now" first. Price/fee/item change = ask again. Standing rules and branch exclusions: `~/Documents/assistant/moni-prefs.md`.
- **Check first:** store open now, delivers to Banyantree, in stock, fee from the logged-in
  CLI quote (name the source; 14 Oct a NowNow fee was quoted 6.45, real 13.45). Generic item
  missing from this store = hold and show options here, don't buy it from another store
  (14 Oct gloves). Missing option/add-on = ask before adding any paid substitute.

## CLI-first ordering: Food, Minutes, NowNow, Main, Supermall (owner rule, 2026-10-11)

noon ordering is HTTP-CLI first. The `commerce` CLI (source
`/Volumes/ExternalSSD/t3code-fork/integrations/app-api-cli`, runtime
`~/.local/share/app-api-cli`) has paid HTTP evidence for minutes, main,
supermall and nownow (placed + paid + tracked Oct 10–11 2026, including a
3DS-approved minutes order). The current NowNow path is unproven until one real
order completes with capture and tracker evidence. Search
stays with `noon-search`; the phone app is fallback for baskets the lanes
cannot express, plus account actions and returns.

```sh
commerce checkout-check minutes            # read-only cart + active-order preflight
noon-search --minutes "grenade white chocolate"     # resolve the exact SKU
commerce order minutes  --sku SKU --quantity 1 \
    --cvv-from-keychain --label "minutes <item> x1"
commerce order nownow    --product-code P4372707388695472A --store-code SPNNYSAKBB \
    --quantity 1 --prepare-only     # live send: same basket + --resume-flow FLOW,
                                    # prepare <=60 min, flow <=12 h
commerce order main      --sku-config Z0B9474A290818B862A38Z --quantity 2 \
    --cvv-from-keychain --label "main <item> x2"
commerce order supermall --sku-config ZC3D2FE430033CA47B932Z --quantity 1 \
    --cvv-from-keychain --label "supermall <item> x1" [--eta ISO_DATE]
# all four accept: --resume-flow FLOW_UUID (24h pre-place window)
# all four also accept --items-file basket.json and --prepare-only
commerce order minutes --items-file basket.json --prepare-only
commerce order minutes --items-file basket.json --resume-flow FLOW_UUID \
    --cvv-from-keychain --label "complete requested basket"
```

## Unrestricted baskets (owner update, 2026-10-11)

17 Oct fix status: the new Minutes `item-options`/`clear-cart` commands and
freebie/required-option checks below are in source, after the
active phone-order hold. Do not assume the installed CLI has them yet.

There is no local product-category, item-count, quantity or spending policy cap.
The caller agent enforces the owner's actual authorization and budget; a task's
test allowance is not a permanent CLI limit. `commerce capabilities` reports
null order/campaign caps. Merchant stock/quantity rules, exact money/manifest
validation, account ownership and no-blind-resend fencing remain mandatory.

`--items-file FILE` (or `-` for stdin) accepts a JSON array or `{ "items": [...] }`.
Do not mix it with scalar item/quantity flags. Use these lane-native rows:

- Minutes: `{"sku":"SKU","qty":1,"modifiers":["OPTION_CODE",...]}`.
  `modifiers` can be omitted for plain items. Optional `catalog_query` supplies
  the product-name search hint when searching by SKU does not return the item.
  Use `commerce item-options minutes --sku SKU --query "product name"` to read
  live option groups, exact option codes, prices and min/max selections without
  changing the cart. Required groups must be selected explicitly, including
  catalog-preselected options; missing selections fail before cart preparation
  with `MINUTES_REQUIRED_OPTIONS_MISSING` and `details.required_groups`.
  Unknown/excess options fail too. Never invent option IDs or equate low-fat
  milk with skimmed. Unsupported customization schemas require app fallback.
- NowNow: `{"product_code":"P...","quantity":1}` with one `--store-code` for
  the whole flow; optional verified `modifiers`/`notes`. Never invent option IDs.
- Main/Supermall: `{"sku_config":"SKU_CONFIG","quantity":1}`.

Many distinct items go in ONE flow. NowNow remains one store per flow; marketplace
supports complete multi-shipment review. Duplicate Noon identifiers reject—combine
their quantity explicitly. Unknown merchant variants/slots are not made valid by
an unrestricted CLI; use the app for genuinely unsupported contracts.

Building or editing a Minutes basket over time (28 Oct). Use only these commands.
Never write a script that drives `MinutesCheckout`/`sync` by hand:

1. `commerce cart minutes show` (read-only) prints the cart as items-file rows
   (`sku`, `qty`, `modifiers`, display-only `title`) plus `cart_hash`.
2. Write the whole basket to a JSON file: the shown rows plus your edits. Option
   codes come from `commerce item-options minutes --sku SKU --query NAME`.
3. `commerce cart minutes set --items-file F --expect-hash HASH` replaces the
   whole cart in one journalled send and reads it back. It never orders or pays.
   It refuses if the cart changed since `show` (`MINUTES_CART_CHANGED_SINCE_SHOW`:
   show again, redo the edit), with an active order, or with bundle/deal lines.
   The same basket again returns `unchanged` and sends nothing. Repeat 1-3 per change.
4. Order exactly that cart: `commerce order minutes --items-file F --use-current-cart`
   with the usual flags (`--prepare-only` first if you want the review). Keep
   `--use-current-cart` on the `--resume-flow` run too, or the scope won't match.
   It refuses with `MINUTES_CURRENT_CART_MISMATCH` unless the cart equals F, and
   it sends no cart change. To change the basket after a `--prepare-only`, run
   `commerce abandon-flow FLOW` first: `set` refuses while that flow is open.

If `set` fails after its send (`MINUTES_CART_SET_OUTCOME_UNVERIFIED`), don't set
again: run the `recovery` command it prints (`commerce cart minutes reconcile
--flow FLOW --items-file F --expect-hash H`). It closes the flow only when the cart
matches F. Nobody edits the cart in the noon app while an agent is building it.

`--prepare-only` builds/reviews the cart and verifies fresh exact readback, then
returns `PREPARED_NOT_ORDERED`, `financial_send:false`. It mutates a cart but does
not place, pay, load CVV or register a watcher. Resume that exact flow/manifest to
purchase; do not make a replacement cart. Preparation leaves the flow ACTIVE.

Minutes provider-added gifts (17 Oct): only additional lines explicitly marked
`isFreebie:true`, with price zero and every other exposed price zero/null, are
accepted. The SKU must not be user-requested; bundles, deals, unknown line kinds,
nonzero and unexplained additions still stop review. Prepare output includes
`review.provider_added_freebies` (title, SKU, quantity, price); tell the buyer.
Freebies remain bound into the exact final review and fresh pre-place readback.

Explicit cleanup of an abandoned Minutes preparation:

```sh
commerce abandon-flow FLOW_UUID
commerce clear-cart minutes --flow FLOW_UUID
```

NowNow cleanup (deployed 9 Nov, `1afee3e483` on PR #4):
`commerce clear-cart nownow --flow FLOW_UUID` deletes only the
exact retained session of a RELEASED flow. For a failed pre-order verification,
the terminal release and a fresh failed-intent status with explicit zero bank
amounts are required. It refuses open/fenced account flows, later cart writers,
changed cart/account/Home, placement or unresolved sends. One journalled native
delete is followed by exact store-session and recent-cart empty readbacks.
An uncertain delete or failed readback keeps the account blocked; never resend
or bypass it through the app. The error returns `cleanup_flow_id`; its source
link is retained under the commerce journal's `nownow-cleanup/` directory.
`abandon-flow` cannot close a consumed delete without empty-cart evidence.
Cleanup sends no payment and places no order.
Live proof 9 Nov: old Monoprix session deleted once; exact store-session and recent
cart readbacks proved empty. Cleanup `f4c198f9-71a3-4485-959e-25a4c289171d`
is RELEASED, no order/payment. Fresh prepare-only flow
`686c475e-a777-4f41-97fc-7dbdd2510c70` reached review for one Grenade White Chocolate
330ml (`P5997551102819847A`, `MNPRXPJMSL`), AED 26.75, Mashreq 9546, Home and
quiet delivery verified. It remains ACTIVE for an authorized same-flow resume;
no subscription/payment/placement was sent. Next paid test still requires the
owner available for the expected AED 1 verification and working Dia.

Main/Supermall cleanup (deployed 22 Oct): after `commerce abandon-flow FLOW_UUID`,
use `commerce clear-cart main|supermall --flow FLOW_UUID`. It removes only exact
journal-owned rows with unchanged full-cart evidence and matching account/Home;
later writers, active orders/flows, or any financial history refuse, except a failed order closed uncharged (below). Each removal
is sent once and independently read back; ambiguous/partial clears stay fenced.
Old flows must match their retained add-response evidence. Fixture-tested only;
never run during phone/app cart editing. No live clear was done for this fix.

Supermall catalog (22 Oct): the resolver and `noon-search --rocket` use the
Rocket catalog experience; checkout still uses ecom. The selected offer must
have the `rocket` flag. A nested Rocket promotion on an FBN offer is not enough.
Catalog errors now identify `details.sku_config` before any cart writes.

`clear-cart` is cart-only. It requires a closed/released Minutes flow with an
observed sync, no order/payment/financial operations or reservation, no active
account flow or active merchant order, and a fresh full-session readback matching
the last journalled response hash. Later cart writers or changed readback refuse
cleanup; a failed prepare alone does not grant ownership of any current basket.
It journals one empty sync and independently verifies the cart is empty. An
ambiguous clear remains fenced, never automatically retried. Do not run this
while someone is ordering in the app: noon has no atomic cart-revision guard.
17 Oct implementation verification is recorded-fixture-only; no live clear or
customized order was performed as part of the fix.

Live multi-item paid proof (2026-10-11), with exact tracking and registered watchers:
Minutes Maxi vanilla + Marvis Whitening Mint, AED67; Main Dove spray + handwash,
AED50.74 across two shipments; NowNow two tissue lines/three units, AED31.95;
Supermall two Kleenex items, AED36.49 in one rocket shipment. Multi-rocket-shipment
aggregation remains fixture-only. `commerce capabilities` and COMMERCE-HTTP.md
distinguish live proof from fixture coverage; paid/tracked does not mean delivered.

Lane facts:

- **minutes** — instant lane; always pass `--cvv-from-keychain`. noon asks
  for the CVV on some carts; without the flag such a cart stops with
  `MINUTES_CVV_REQUIRED_USE_CVV_FROM_KEYCHAIN` before anything is sent. The
  flag reads the saved-card CVV from Keychain (`robob-card`/`MashreqNoon.card_cvc`; `Marriott.card_cvc` only when 2342 is explicitly selected)
  into RAM only (never an argument/file/log). Long baskets are fine: the
  account check refreshes itself after 90 s. May require owner-approved 3DS
  (ENBD X push): the first Telegram alert reads `this is ours: approve noon
  Minutes AED X in the selected card's bank app (Mashreq for 9546; ENBD X for 2342) now`, the command waits up to 10 minutes, and a
  second alert goes out once if it is still unpaid after 5 minutes. If
  interrupted after the payment was consumed, resume status-only with
  `commerce await-payment FLOW --minutes 10`.
- **nownow** — store-based quick commerce; the live tested saved-card session
  path used no CVV or 3DS. Store/product codes come from `noon-search nownow … --json`.
- **main / supermall** — marketplace checkout-v2, saved card `cc_noonpay`
  (9546 default; 2342 explicit fallback). Use `--cvv-from-keychain`: Supermall required CVV/ENBD approval on
  23 Oct. The new continuation encrypts CVV in RAM, completes the exact pending
  intent at most once, alerts Telegram immediately with
  `this is ours: approve noon AED X in the selected card's bank app (Mashreq for 9546; ENBD X for 2342)`, then polls for up to ten minutes.
  Interrupted runs resume status-only with `commerce await-payment FLOW --minutes 10`;
  it never sends a missing payment step or replays one. This new challenge path
  is fixture-tested only; the earlier live tests were frictionless.
  If the payment is still unconfirmed after 5 minutes, a second Telegram alert
  goes out (approve if the selected card's bank app has the prompt; otherwise check noon > Orders
  before the app fallback). Failed/timeout outcomes print `charge`
  (`not_charged` only with noon's own no-capture proof, else `unknown`), a
  `tell` line that is the most you may say to the person (never "nothing
  charged" on `unknown`, even to Moni), and `next` steps.
  A bank/ENBD X prompt is ours whenever `commerce open-flows` (read-only,
  last 30 min) lists a flow: say "approve it now, AED X at noon" straight away.
  Failed/timeout outcomes are journalled and fenced. `commerce reconcile-order FLOW`
  can close a Main/Supermall failure only with fresh exact native cancellation and
  full-amount refund evidence explicitly saying payment was not captured and won't
  be charged (the original order card, exact cancelled items, zero pending/non-refundable balance).
  It releases the local reservation, never a merchant payment.
  Once it closes (MARKETPLACE_CLOSED_UNCHARGED), noon puts the items back in the cart: run
  `commerce clear-cart main|supermall --flow FLOW_UUID` within 24 h. It removes only that flow's
  own lines at their ordered quantity, and it refuses if anything else is in the cart or another
  noon flow has written since. If it refuses, remove the line in the noon app.
  `supermall` is the rocket rail (isRocket shipment + absolute express promise verified).
  `skuConfig` is the product's `skuConfig`/deep-link code, NOT the display sku
  used by minutes.

Guards (enforced in code — never bypass):

- No permanent CLI order/campaign spending ceiling. Authorize each requested
  basket and enforce the caller's current budget, including uncertain liability.
- Active orders block a lane (an unpaid/in-flight order stops the run); an
  existing foreign cart is never replaced (minutes `EXISTING_…_CART_MUST_NOT_
  BE_REPLACED`, main empty-cart guard, nownow store-cart guard). Minutes orders
  a cart that's already there only with `--use-current-cart`, and only when it
  equals the items file exactly; change it with `cart minutes set`.
- Scope is bound: SKUs/store codes, quantities and the verified Banyantree
  Home are hashed into the flow; a `--resume-flow` with a changed scope fails
  (`*_RECOVERY_SCOPE_MISMATCH`). Address/home change fails the lane.
- There is no product-name filter (Talabat's old filter is also retired). That does not
  guarantee every catalog item/offer can be ordered: stock, minimum quantities,
  seller/fulfillment shape and payment guards must pass. Many basket lines are
  supported, with positive integer quantities and owner-authorized items only.
- Multi-SKU baskets are supported. Minutes catalog-backed modifier groups are
  supported through `item-options` and `modifiers` in the items file. Unverified
  customization/variant and scheduled-slot contracts remain a limitation: resolve
  what you can with `noon-search`, then
  use an explicit phone fallback. Never silently split a requested basket.
- Quiet delivery is enforced/reviewed per lane (minutes: every quiet code noon
  offers for that cart plus the quiet note; nownow `leave_it_at_my_door` +
  `dont_ring_the_bell` set together in one idempotent call, plus the exact
  `Leave at door. Don't ring bell. Don't call.` driver note through `add-notes`;
  main/supermall verify account-level `silent_delivery` active — never attempt to
  activate arbitrary option codes). If a review output shows quiet flags unset,
  stop — do not place.
- Minutes quiet toggles are per cart (owner rule 2026-10-27). If noon offers only
  `dont_ring_the_bell` (Moni's 18-line basket, 27 Oct), the CLI still orders with
  that toggle on plus the quiet note. The review lists `quiet_codes_not_offered` and
  the result carries a `quiet_notice`: pass it on to whoever asked in one line
  ("noon had no leave-at-door option for this cart; don't ring bell is on and the
  note asks to leave it at the door"). Only `QUIET_CODES_UNSUPPORTED` (neither
  toggle offered) still refuses; then use the phone fallback.
- Extra driver note: `commerce order minutes ... --driver-note-extra "TEXT"`
  (one line, 1-200 chars) goes after the quiet note, e.g. a gate code. It is part
  of the flow scope, so pass the same text again with `--resume-flow`.

Auth (read-only checks first): Keychain `app-api-cli.native` accounts `minutes`,
`noon`, `nownow`, pinned to the same account and saved Home. `commerce auth noon
VERTICAL` reports status; `--reconcile` validates retained response cookies;
`--recover` runs bounded same-account revalidation/peer-cookie adoption. Live
Minutes retained-cookie reconciliation is proved. Rejected-session adoption is
fixture-tested only; no refresh-token grant or automatic login is claimed.
`--diagnose-readonly` performs no credential writes. If bounded recovery fails,
use authorized original-app email-OTP login and explicit same-account rebind;
never sign out valid sessions, manufacture expiry, loop OTPs or replay mutations.

Tracking: the CLI auto-registers the order-watch tracker and returns the
watcher name — never report order success without it. Exact reads: `commerce
track-exact noon minutes|nownow|main|supermall ORDER_ID`, `commerce track
FLOW`, `noon-search track ORDER_ID --json`, `noon-search orders --minutes
--json`. Marketplace history is first-page bounded: item delivery never
certifies whole-order completion; keep watching remaining shipments.

Recovery: `commerce inspect FLOW` / `order-status FLOW`; `--resume-flow` for
interrupted pre-place flows; `commerce recover-payment FLOW` reads the exact
retained intent/transaction. A MAY_HAVE_SENT payment is never blind-resent,
and its reservation stays recorded. New noon flows on every lane remain available.
A matching vertical, item set and quantities pending within 48 hours prints
`SAME_BASKET_PENDING` with the prior flow, card, amount and start time.
`--prepare-only` prints the warning; live placement needs `--ack-pending FLOW`
for each match. A legacy manifest that cannot be reconstructed is labelled
`unresolved_legacy_manifest` and needs that flow acknowledgement as a possible
same-basket match. Known different baskets and other lanes remain available. Decline the old approval in the bank app if it appears. Release/abandon
changes local journal state, not the merchant's order or financial liability.

Minutes order noon failed after the payment was sent (27 Oct 2026). Symptom: noon emails
"could not be placed due to a payment error". The original flow remains consumed; new
orders are available. Minutes `release-flow` refuses when a payment was sent.
Two closes, both read-only towards noon:
1. `commerce reconcile-order FLOW --close-failed`. The exact order must be `failed`/`cancelled`
   with echoed orderNr, total 0 and not active, and its payment intent must show 0
   authorized/captured with a transaction status noon finalises as non-capture. No such
   status has been seen yet (the list is empty on purpose), so today it refuses every real
   failed order with `MINUTES_FAILED_CLOSE_INTENT_NOT_UNCAPTURED`. On success: terminal
   `RELEASED` (`MINUTES_CLOSED_FAILED_UNCAPTURED`); say "nothing was authorized or captured
   when checked".
2. When 1 refuses, ask Abdullah to check the original order card for a noon charge of that amount. Only
   after he says nothing was charged, run
   `commerce reconcile-order FLOW --owner-attest-no-charge --attested-by owner --evidence "Abdullah checked original card LAST4 on DATE: no AED AMOUNT noon charge for order ORDER_ID"`.
   Use his actual words; never infer it from noon's email or the intent status. Same fresh
   reads: order failed/cancelled, echoed, total 0, inactive; intent not paid, not
   `payment_confirmed`, no captured/authorised status, 0 authorized/captured. A 3DS or
   redirect intent is allowed. Terminal `OWNER_ATTESTED_UNCHARGED`; `commerce inspect FLOW`
   shows the `owner_attestation`. It rests on his check, not noon's proof: say "you checked
   and nothing was charged", never "noon confirmed no charge".
Both refuse within 15 min of place/payment, on any unobserved send or success evidence, or if
anything changed. Both free the account, keep the reservation and order ownership, and never
resend or retry. A bank hold can still show for a while. A replacement order needs its own go.
First used on flow 95df7e79 / IAEGAR1482ANIBCZKA (AED 482.65, 3DS never completed).
Run `commerce` directly with a shell timeout, never a `perl alarm` wrapper
(its inherited SIGALRM conflicts with native read deadlines).

## Known reorders — start here

Read `../../app-api-search/reorders.md` for Moni's exact sponge basket, totals
and delivery controls. Resolve current SKUs with `noon-search` and order via
`commerce --items-file` (on the order lane) when the complete requested basket
fits its supported merchant shape and the caller's authorization.
For an unsupported basket, the phone fallback uses the rehearsed
`noon-minutes-search.json` after `noon-minutes-open.json` (17.7–19.9s, 3 Oct).
Do not switch to manual taps after opening unless a plan fails.
`noon-minutes-sponges-review.json` combines
search/add-five/cart/instruction review for an empty basket (draft, not live-timed).
Last sponge order: 5 four-piece boxes, AED40.50 including delivery, not AED6.80
each; refresh actual checkout. Final payment remains with the task model.

## Always track after checkout

7 Oct reliability update: see app-api-search's delivery reliability section.
Minutes native tracking remains primary. Marketplace item delivery does not
prove whole-order completion; use shipment/item evidence and verify remaining
items. Durable 15s push journal is fallback across verticals; ID-less pushes
require verification. Send arrival-only texts; do not ask for the actual arrival
time. If Abdullah volunteers it, record it with
`order-watch reconcile --app noon --order ID --reported-at ISO_WITH_TIMEZONE`.

After every Main/Minutes/Food/NowNow order, run `order-watch add --app noon
--order ORDER_ID --for owner` (or `--for moni`), with `--placed-at
ISO_WITH_TIMEZONE --eta LATEST_ETA_ISO --label "store/items"`. Always start tracking
before reporting completion.
Group order (asked for in a group chat, e.g. `group-sb_gro`): add `--chat <slug>`
to `commerce order ...` (or `order-watch add`) so the card and arrival texts go to that group, not a 1:1. A Moni
order's `--moni-chat` already counts.
Pass it even in a group thread: the chat is only inferred from the thread's folder,
and a `cd` elsewhere loses it. Check `chat` in the receipt.
`ORDER_CHAT_UNKNOWN` = no such chat; nothing was sent or charged.
Add `--single-active-order` only when this is the sole
active order across the noon app. Read status with `order-track --app noon --order
ORDER_ID`. Native Minutes tracking is primary as of 2026-10-04:
`noon-search track ORDER_ID --json`, `noon-search orders --minutes --page 1 --json`.
Verified IAEGA4148P7H5TWI1A = delivered. No phone UI/proxy needed; Keychain auth.
`noon-search orders --json` includes marketplace active/history item statuses,
but whole marketplace completion is unverified with bounded history. Active ETA
and rider shapes need live verification. Load `app-api-search` for limits/routing.
Email/notifications remain fallback; ID-less pushes are unconfirmed candidates.

## Plan-first app navigation (unsupported-basket/account fallback only)

Use `../android-phone/plans/COVERAGE.md` for tested plans and their preconditions.
`noon-minutes-open.json`, `noon-minutes-cart-review.json` (arg `Banyan`),
`noon-minutes-payment-review.json`, and account/history plans are available.
Write the next short jevrun plan when coverage ends; manual input is recovery
after a plan fails, not the default continuation. Keep the task-model final
checkout check. Catalog lookups use APIs without phone verification.
Minutes is now top switcher `switcher_button_uae_instant`, not always bottom nav.
Never clear an existing owner basket during training.

## Request policy and checkout delivery instructions

Use the default iMessage-thread model for searches/comparisons/orders; use
`opus/gpt-6-astra` only to build/fix tooling (provider-block fallback unchanged).
Owner/Moni phone fallbacks take their own priority hold and export
`PHONE_HOLD_OWNER` as its exact token for every `ph` call and runner. Background
phone jobs use `ph lease run --owner <card-or-thread-id> --purpose "<short>" -- <cmd>`.
`ph lease status` shows the claim. Exit 5 means yield without looping or deleting
another task's claim. Rank baskets by fewest orders, then ETA, then total with fees.
Use `basket ITEM ITEM --json`; API items include `image_url`, and searches accept
`--images-dir DIR` for visual comparison. Ordering is `commerce` CLI first; the
phone fallback uses Jev + `jevrun.py`.
Mandatory before paying in Main/Minutes/Food/NowNow: select **leave at door**,
**don't ring bell**, **don't call** wherever offered; add the same wording under
delivery instructions if free text is supported. Inspect checkout's address /
delivery-instructions section; exact toggle locations are not yet verified.
Read back supported selections before Place order. Do not silently omit them.

> Alternative (2026-10-02): Careem Quik (12-min groceries) and Careem Shops (electronics, pharmacy, flowers, pets) in com.careem.acma; see the `careem` skill.

## Fast read-only lookups (2026-10-03)

Load `app-api-search` first for product/price lookups: `noon-search "marvis" --json`
or `noon-search --minutes "smetana" --json` (~1–2 s, no phone UI).
It now calls native Android endpoints using the real phone's captured authenticated
session from macOS Keychain and verifies saved Banyantree on every call. No browser
or running proxy needed. `--web` explicitly chooses the older Dia guest/web fallback.
See `app-api-search` for expiry/recapture and response limitations.
Additional commands: `noon-search --rocket iphone --json` (Rocket ETA/price),
`noon-search food sushi --open --json`, `noon-search food-menu OUTLETCODE --query salmon --json`,
`noon-search food-match sushi "seaweed salad" --open --json` (item names only).
`noon-search nownow milk --open --json` uses the real captured native NowNow search
endpoint (~2 s), checking saved Banyantree and returning store/area/prices/fee and
verified live status. `operationality` supplies open/closed and opening time;
`schedulingInfo` distinguishes immediate delivery from scheduled-only. Results
include `status_message`, `opens_at` (Asia/Dubai), `scheduled_only`, `delivery_mode`.
`--open` excludes closed/scheduled-only/unknown stores on the fetched page.
The prior 503 was a guessed wrong route; the actual app uses
`/_svc/mp-shop-api-ctnoon/v2/content/search`. No phone or proxy needed at runtime.
`--page`/`--limit` bound the native store page; up to ten matching products per store.
Search cards show ETA/ADD even for closed stores, so never infer open from those.
Verified against VIVA JBR (immediate delivery), Spinneys Dubai Marina (closed,
opens 08:00), Waitrose Springs (closed, opens 10:00), including scheduling banners.
`shop-search match noon minutes milk eggs --json` and `shop-search match noon nownow milk eggs --json`
find same-store lists with item subtotals; NowNow supports `--open`. No carts are touched. Marketplace `main`
matching is one platform, not a same-seller guarantee. Minutes ETA is null, not a
current 13-minute promise. Saved Home pin: 25.0778251,55.1569039 (verified from noon).
Ordering goes through the `commerce` CLI lanes first (see CLI-first ordering
above); use the phone workflows below only for CLI-unsupported baskets,
account actions and returns.

The noon app (`com.noon.buyerapp`) is on Abdullah's Nothing phone, which is USB-plugged into this Mac. It is **logged in** as abdullahrangoonwala@icloud.com (account name "Hala"). Drive it with `ph` and load the `android-phone` skill too (CLI, rules, logins).

```bash
ph open com.noon.buyerapp; sleep 4; ph ui | head -40   # launch + read screen (text tree; fast)
ph tap id=search_bar; ph type "airpods pro"; ph key enter
ph tap "Add to cart"          # tap by visible text; ph tap X Y for coords (1080x2392)
ph swipe up                   # scroll down
ph shot n1                    # only when you need to SEE it (product images); Read the printed -s.png
ph stop com.noon.buyerapp     # force-stop
```

Run `ph ui` after every action, before the next tap. Popups shift the screen.

## HARD RULES

1. **Never place an order, pay, or subscribe unless Abdullah explicitly says to in this conversation.** Searching, comparing, wishlisting, building a cart, and tracking are fine.
2. **Address: always the saved Home "BanyanTree Hillside - Flat 2104, D 61 - Dubai"**. Never Work (HDS Tower), Silverene, Starbucks JLT, or the GPS "Other"/current-location pin that the home header may show (e.g. "Al Thanyah Fifth").
3. **Payment: saved Mashreq Noon Visa ending 9546 by default; Marriott 2342 only as explicit fallback after failure/decline and safe reconciliation.** Never cash on delivery, noon credits/wallet-only, or another card. Don't add cards.
4. Before ordering, verify address = BanyanTree Hillside Flat 2104, card = xxxx9546 (or explicitly selected fallback 2342), and exact items/qty/total. CLI order commands include the financial send, not just a preview: invoke only for an authorized order within the guards. For phone fallback, read fresh `ph ui` (plus `ph shot` if in doubt) before Place order. Report the actual total and delivery date.
   - (nightly 2026-10-19) Declined card memory: before any order (CLI or phone), run `card-status check 9546` (2342 for an explicit fallback). Exit 3 means it was declined in the last 12 hours: stop, tell the requester straight away and ask Abdullah once; never retry it that day. `commerce order ...` refuses on its own (`CARD_RECENTLY_DECLINED`, exit 3) and records insufficient-funds declines itself. After a decline in the app or on noon, record it: `card-status declined LAST4 --reason "<reason>" --source "<app> <order>"`. Clear only after Abdullah says he topped up: `card-status ok LAST4 --note "topped up HH:MM"`. 18 Oct: Tims and Moni's Uber both hit the same declined card 2 hours apart.
5. **Conflict hold (13 Oct review):** immediately before the final pay/place action (CLI order command or phone Place order), re-read the latest messages from the requester AND Abdullah in the relevant chat(s) (Moni: her Robob thread; plus the owner thread). If anything newer conflicts with, changes or retracts the selection, hold and reconfirm instead of placing. A fallback path never inherits authorization past a newer conflicting message. For Moni, the re-read must also show her explicit go (her own "order X", or her ok after the final basket and price); no go = no order (see Moni orders at the top). CLI gate (nightly 2026-10-16): `commerce order ... --for moni` needs exactly one of `--moni-go "<her exact words>"` or, for a request from her agent over the iMessage agent bus, `--moni-bus-request <areq id>`. The bus path checks a recent active moni-to-owner request and refuses done/declined/done_late; with `--moni-go`, the CLI checks her chat for that message in the last 45 min and refuses with MONI_GO_NOT_FOUND / MONI_GO_REQUIRED / MONI_GO_UNVERIFIABLE (no order attempted, safe to fix and rerun). For a purchase her agent requests over the bus, record his standing delegation with `owner-go record-delegated --principal moni --bus-request <areq id>` and the exact vendor/item/minor-unit amount/currency/cadence before verifying. Other paths still need his original explicit yes; installs/downloads always need his own yes. Abdullah's standing OK pays for her orders but never stands in for her go; never write 'pre-approved, don't ask' into a Moni order brief (15 Oct Lazy Cat AED 90.30). Abdullah's own order for Moni (nightly 2026-10-17): when he says "order Moni X" or sets up a surprise, it's his order and his go, so place it `--for owner` (the --moni-go gate is for her requests) and don't ask Moni to confirm. Tell her it's coming only when he says to, and never on a surprise. Text her only after the payment is confirmed (16 Oct Visanne 3962200177 was declined after he'd been told it was ordered).
6. Login (if ever logged out): phone login is **not supported**, so use the email abdullahrangoonwala@icloud.com. Account tab (756,2255) → Login/Sign up → email field → type the email → CONTINUE → OTP. The OTP arrives in iCloud mail. Read it yourself: `himalaya envelope list -a icloud -m Inbox -s 4` (subject "NNNNNN is the OTP for your noon account verification"). `ph type CODE` (it auto-submits). If it isn't there within ~1 min, check Junk, then ask Abdullah.

## Layout (local phone 1080x2392, verified 2026-09-30; prefer `ph tap "text"` over coords)

- Bottom nav (y=2255): Home 108, Categories 324, Minutes 540, Account 756, Cart 972. Search bar id=search_bar at the top of Home.
- The Home header shows the delivery location (verified 2026-09-30: "Other, BanyanTree Hillside - Flat 2104, D 61 - Dubai", which is correct). If it isn't BanyanTree, tap it and pick the saved BanyanTree address.
- Account: name "Hala", noon One member, My Orders, Wishlist, noon Credits, **Addresses**, **Manage cards**, Returns, Warranty claims (`ph swipe up` to reach them).
- Location and notification permissions are pre-granted via `pm grant`.

## Common tasks

- **Price check / find product**: `noon-search` for the requested vertical. Do not verify catalog results on the phone.
- **Build/order a cart**: use the CLI lane for an authorized supported order. An app-only basket uses Add to cart → Cart; stop before payment unless told to order.
- **Order status / tracking**: `commerce track-exact noon VERTICAL ORDER_ID` first; Account → My Orders only when native evidence is unavailable.
- **Returns**: Account → Returns / My Orders → item → Return. Moni's own request is enough; no second approval from Abdullah (owner rule, 22 Oct), but honor it if she calls it off. If it can't be done right now (no pickup date that fits, app error), don't drop it: keep it with its blocker and the next date to try. Never say it's booked or refunded before the app shows a reference.
  Track it with `order-watch aftercare add --app noon --order ID --for moni|owner --item NAME --amount "AED X" --refund-to "original card LAST4" --request "<who, when, what they said>" --blocker "<why not now>" --next-at <ISO+04:00> [--constraint "pickup on or after ..."] [--deadline YYYY-MM-DD]`. Its watcher wakes the owner thread at `--next-at` (then daily) with what to do. When it's done: `order-watch aftercare close --id CASE --reference <ref the app shows> --pickup "<booked date and window, e.g. Tue 27 Oct 9-1>"`; still blocked: `update --id CASE --blocker ... --next-at ...`; called off: `drop --id CASE --reason ...`. `order-watch aftercare list` shows open cases and any wake that isn't live.

## noon Minutes notes (verified 2026-09-28)
- Minutes has its own address header; it defaulted to Work (HDS Tower). Always switch to Home BanyanTree before checkout.
- **WARNING (2026-09-28, 2nd order):** the CVV sheet does NOT always appear. Tapping "Place order | AED X" charged 5542 immediately with no CVV prompt (the card had been used once already). Treat "Place order" as the final pay button. If told to stop before payment, stop on the checkout screen and do NOT tap Place order.
- Phone fallback may ask for the **CVV of the selected card** ("Enter CVV … Pay AED X"). Load `card-vault` and use MashreqNoon's saved CVV (Marriott only for fallback 2342) in RAM-only command substitution; never echo/log it. Ask via secret-request only if the vault value is absent. A historical phone order had no 3DS, but the October CLI test did: surface any bank challenge to Abdullah, never resend payment.
- Per-item max qty seen: 4 (Maxi Nutrition shakes); C4 Cosmic Rainbow capped at 3 on 2026-09-28 (2nd order). Barebells on Minutes: only Cookies & Cream milkshake stocked.
- If an item is out of stock, skip it and don't scroll-hunt. Report the skipped items after the order.

## Abdullah's usual Minutes basket (2026-09-28 order, AED 77.90)
- C4 Energy Cosmic Rainbow 500ml ×4. It's his favourite C4 flavour, and he asked for extra to stock up (2026-09-28).
- Maxi Nutrition vanilla protein shake ×4. When he says "Pro Max" he means Maxi Nutrition.
- Dove Men+Care 72H antiperspirant **spray**. Must be a spray, not a stick or roll-on.
- Barebells vanilla milkshake, if it's in stock.
- Sour cream: when he says "Smetana", he means **Svalya Sour Cream Litovskaya 30% fat 380g** (label reads "Сметана"; search "smetana"). Confirmed as his choice 2026-09-28.
- Chicken: **Americana Air Fryer chicken strips ONLY** (he loved them, 29 Sep 2026: "only ever get that exact one"). Order IAEG9T148KAUT5NRFA had both Zingz strips (spicy, AED 37.95) and Air Fryer Chicken Strips (normal, AED 41.95); he loves BOTH (confirmed 29 Sep): Americana Air Fryer Zingz strips (spicy) and Americana Air Fryer Chicken Strips (normal). No other chicken brands/products.
- Toothpaste: when he says "Marvis Whitening", he means **Marvis Whitening Mint 85ml**. Confirmed 2026-09-28.

## NowNow (quick-commerce stores, verified 2026-09-30)
- **CLI first:** `noon-search nownow QUERY --json`, then `commerce order nownow` for a supported authorized basket. **Phone fallback:** `~/.local/android/venv/bin/python -u ~/.config/opencode/skills/productivity/android-phone/scripts/jevrun.py ~/.config/opencode/skills/productivity/android-phone/plans/noon-nownow-search.json "Nothing Phone 3a"` reaches results in ~20 s. Then read fresh `ph ui`, add the exact item and use `id=nownow_view_cart_btn`.
- Home → top switcher `ph tap id=switcher_button_noonnownow` → tap the search bar (540,539) → wait ~2 s for `id=nownow_search_input` to have focus → `ph type "..."` → enter. (Typing before the search screen opens is lost.)
- Results show products and the stores that carry them (e.g. "Nothing, Palm Jumeirah" official store, id=nownow_store_*). Add with `id=nownow_add_to_cart_<SKU>` → `id=nownow_view_cart_btn`.
- The cart pops a noon One upsell sheet: tap `id=nownow_noon_one_bottom_sheet_no_thanks`. A free-delivery coupon (DEL200, orders above AED 200) can be applied with "FREE delivery coupon available" → APPLY → Got it.
- The cart screen IS the final checkout: address header, "Pay using Card ****9546", and "AED X • Place Order" (= pays). Some stores say "Orders once confirmed cannot be returned or cancelled".

## Running shopping list
Abdullah adds items during the day. Append them to the "Pending" section of `~/Documents/assistant/shopping-list.md`. The robob watcher `shopping-list-9am` wakes the agent at 09:00 Dubai to show him the list and ask for the go-ahead, but only when the Pending list changed since the last ask, or once a week on Mondays if unchanged (nightly 2026-10-22: it had asked about the same ketchup and popcorn every day for 9 days). Ask once; don't re-ask the same day. Order only after he says yes. Afterwards, move the ordered items into Log and clear Pending.

## Phone-fallback speed playbook (historical Minutes lessons)
1. When he pre-authorises ("just order, no approval"), go straight through to Pay. Still check the address and card on the checkout screen (`ph ui`) and apply the HARD RULES conflict hold, then report the total and ETA afterwards.
2. Use the selected card's saved CVV (MashreqNoon for 9546, Marriott for fallback 2342) through `card-vault` in RAM only if requested by checkout. Do not ask Abdullah to re-supply an already saved secret.
3. Minutes search: use the Minutes tab's own search bar, one item per search, and try adding from the results tile's "+" before opening the product page. Tap "+" repeatedly up to qty 4 (the cap).
4. Fix the Minutes address (Work → Home) first, before searching, because stock and ETA are per address.
5. An old small basket had AED 8 delivery and ~13 min ETA. These are historical, not today's quote: read current fees and ETA.
For info gathering (menus, macros, prices, open hours) use the `noon-search` API. Talabat is retired (owner, 2026-11-07): never search, order or fall back to it. For ordering/cart/checkout use the `commerce` CLI lanes first; the phone app is fallback.

## Finding items (owner rules, 2026-09-30, updated 2026-11-02)
When Abdullah or Moni ask to find groceries, start with the noon/Careem catalogs via app-api-search for Banyantree (no phone checks on read-only results). If they don't have it, or it isn't everyday groceries, look broadly: web search (Perplexity/Exa), specialist shops, brand sites, Amazon.ae, Instagram/WhatsApp shops and local stores, and say where each find is from. Don't build carts: write a shopping list with the store left open and pick the store and listing at their go.

## Shopping list rule (owner, 2026-10-01)
Before ANY grocery/quick-commerce order (noon Minutes, NowNow, Careem Quik, etc.), read `~/Documents/assistant/grocery-list.md` and add every item on it to the cart alongside what was asked (if the store carries it). After the order is placed, remove the items you bought from the list and mention what was added. If an item is unavailable, leave it on the list and say so.
Include the complete multi-item basket in `--items-file`; use app fallback only
for an unsupported merchant contract, not merely because there are several items.
Do not silently drop list items or turn the basket into multiple purchases.

## Food discovery and tracking (7 Nov 2026)

`noon-search food-menu OUTLET --json` includes `choice_groups`: exact modifier
codes, min/max, max per option, nested choices, prices, defaults and availability.
Items expose `note_type` and `max_quantity`. Defaults are discovery metadata,
not authorization to add paid options.

Food supports journalled preparation and automatic saved-card placement:
`commerce order food --outlet-code OUTLET --items-file FILE --prepare-only`
with rows `{"item_code":"I...","qty":1,"modifiers":{"MD...":{"I...":1}},"notes":null}`.
Use exact menu codes; every required choice must be explicit. Notes are refused
when the item says `note_type:none`. An unavailable or changed basket fails exact
readback; do not buy a substitute. Resume the same retained flow with
`--resume-flow UUID`; ambiguous sends are never retried. The review requires
Banyantree Hillside Flat 2104, selected card 9546 (2342 explicit fallback), zero wallet contribution,
leavedoor/dontring/avoidcalling and the exact quiet driver note.

Live 7 Nov preparation: Dunkin Voss Water x1 AED17.70; Under500 Crispy Chicken
Strips x1 with No Sauce AED45.85. Neither was placed or paid. Both isolated
sessions were left intact and local flows abandoned after exact unplaced reads;
no preexisting basket was cleared. A nested Dunkin cappuccino selection was
removed by the provider as unavailable; do not claim nested-choice paid proof.

`commerce review-contract food` lists remaining gaps. `commerce recover-payment
UUID` reads preparations (including locally released ones) or reconciles an
existing Food financial journal. Financial recovery binds the owned session,
exact order, review, account/home, items/options/notes, card token hash, amount
and intent hash; it never sends place/pay. Captured payment and restaurant
acceptance are separate: an unaccepted or unconfirmed order gets a held card.
Order-watch receipt and durable registration are verified before completion.
Unknown sends stay consumed on their own flow. New noon flows are available; a matching pending basket requires --ack-pending FLOW.

The automatic saved-card placement writer is enabled. It requires explicit false
CVV/completion flags on the fresh reviewed session. Real intents, CVV and 3DS
remain unsupported and return needs-app without a completion send. Recovery uses
the retained exact order ID after session expiry and verifies native automatic
processing plus a unique exact-card/amount bank purchase before releasing the card.

`commerce track-exact noon food ORDER_ID` reads the exact Food order. Food
`delivering` maps to out for delivery; verified ETA windows use the native
start timestamp and end of the displayed window. Unknown statuses remain unknown.

The `noon-order-discovery` watcher reads Minutes, Food, NowNow and shared
Main/Supermall account histories every 120 seconds. First run baselines old IDs.
New IDs wake a registrar; requests retry every ten minutes until durable
order-watch registration exists. This is bounded first-page coverage, not an
exhaustive account audit. Shared history uses neutral `marketplace` throughout
track-exact, order-watch and cards; do not guess main/supermall.

`commerce order-details noon food|minutes|nownow|main|supermall|marketplace ID`
reads exact merchandise, quantities, exposed choices/notes/prices and total.
Food names/options come from the order's saved menu, not today's catalog.
Null means not exposed. Marketplace counts distinguish lines from units;
merchandise completeness never proves whole-order delivery. See delivery-cards
for the registration contract.

Marketplace lifecycle uses native values across confirmed/processing/packed/
shipped/out_for_delivery/delivered/cancelled, including known spelling variants.
Mixed shipments use the least advanced active stage. Terminal closure requires
the complete inventory reconciled to invoice units; an older processing row
cannot defeat explicit whole-inventory cancellation. Native relative ETA is
anchored to observation time and suppressed when any active sibling lacks an
estimate. Re-rendering a card never advances an old countdown.

## Card-specific lane limits (9 Nov 2026)

Explicit fallback syntax: `COMMERCE_CARD_LAST4=2342 commerce ...`. Only use it
after 9546 fails/declines and exact reconciliation allows another purchase.
For historical 2342 flow resume/reconcile/cleanup use that same override.
Main/Supermall pay with the saved default card in noon; the CLI verifies it but
does not switch it. A different selection requires changing the default in the
noon app first. NowNow paid CLI on 9546 refuses before cart changes: payment
confirmation on Visa is unproven, so use the phone with 9546. Do not use 2342 just
to evade that limitation. Visa cancellation refund wording remains fixture-only;
unrecognized provider evidence stays fenced. `commerce capabilities` reports
the selected card and these lane limits; older live-paid proofs are on 2342.


## Food follow-up (9 Nov 2026)

Old Just Fit Food order FGB7NNH55JK6LDA (AED115.90, original 2342) is reconciled.
`close-food-captured` validated exact delivery, bound automatic order detail and
bank archive message 514898, then closed flow
24195ed3-73e6-40d1-ab4c-9cd093b6b311 as COMPLETE without an owner attestation.
The reservation/send history remains consumed; this is not a no-charge release.
`recover-payment` confirms captured; the stale account fence is gone.

Food automatic saved-card HTTP placement is enabled; NowNow 9546 is still gated
because its native endpoint and capture proof differ. Food bank reconciliation
supports Mashreq 9546 purchase emails and ENBD 2342 purchase SMS. Historical
2342 evidence cannot close a 9546 flow. Real intents/CVV/3DS still need the app.

## Authorized Food app proof (9 Nov 2026, 17:48 Dubai)

Owner's existing Just Fit Food cart was ordered once in Android with payment
traffic capture: FGB9NN2HL9601HA, AED172.80, Mashreq 9546. Chicken Stir Fry x1,
Sweet Potato Fries x1, Buffalo Chicken Wrap (spicy) x1; all modifier maps empty,
no item notes, no wallet contribution. All three quiet toggles and the exact
quiet driver note were verified. Native order accepted/accepted with
`paymentProcessedAt=2026-11-09T17:48:56`, null client secret and automatic capture
true; Mashreq purchase email (msgs 516800) corroborates amount/card/merchant/time.
Owner watcher registration and delivery-card `sent` receipt verified.

The captured place response began pending/not_synced. Session CVV and completion
requirements were explicitly false. No CVV, paymentintent/complete or 3DS traffic
occurred. This does not close the unpaid-intent/CVV/3DS gaps or prove NowNow 9546.
This automatic Food evidence supports the CLI automatic path. NowNow 9546 needs
its own proof. Never send another payment for this order.
Redacted local evidence: `/Volumes/ExternalSSD/t3code-fork/tmp/food-proof-20261109/`.


## Food CLI paid proof (9 Nov 2026, 18:40 Dubai)

Enabled and deployed from PR #4 commits `7357d7517b` and `aeb29b7eb5`.
`commerce order food` placed FGB9NNE277T50VA once: Just Fit Food Original Omelette,
AED58.35 on Mashreq9546, BanyanTree Hillside Flat2104, all three quiet preferences
and exact driver note. No phone placement, CVV, intent completion or 3DS.
`commerce recover-payment c50bc525-9984-4062-b45b-9e3692e5680e` returned
PAID_AND_ACCEPTED with exact native automatic capture and Mashreq purchase email
516830. Watcher registered, delivery card sent. 68 offbox fixture tests pass;
independent reviews resolved. Recovery uses the journal placement-time accessor.
NowNow9546 is still gated: its `{sessionCode,total}` placement and tracking-only
payment signal differ from Food, and the saved9546 listing is not a paid proof.

## Logs

Orders diagnostics append to `~/.robob/logs/tools/orders/YYYY-MM-DD.ndjson` (UTC).
Commerce records `cmd.start`, `cmd.end`, `cmd.error`, `guard.refused`,
`payment.may_have_sent`, `step.*` timings and `flow.*` recovery/release/abandon events.
Tracking records `track.add`, `track.poll`, `track.transition`, `track.eta_elapsed`,
`track.delivered` and `track.error`; card checks record `card.assert`.
Provider reads record `provider.track`, `provider.orders` and `provider.details`.
For app-placed orders pass `order-watch add --source phone`; email registration
uses `--source email` (CLI registration defaults to `cli`).
Run `commerce log-rollup --day YYYY-MM-DD` for counts, error rates and timings;
the JSON is saved beside the day file as `rollup-YYYY-MM-DD.json`.
Logs keep 30 days, hash IDs, and exclude order text and credentials.
