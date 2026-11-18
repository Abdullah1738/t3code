# Jev phone coverage — 2026-10-03

> Talabat retired (owner, 2026-11-07): every Talabat line below is history only. The Talabat plans are archived in `~/.config/opencode/retired-skills/talabat/android-plans/` and `jevrun.py` refuses `com.talabat`.


## Known-reorder update — 2026-10-05

Read `../../../app-api-search/reorders.md`. Existing `noon-minutes-search.json`
was already rehearsed (17.7–19.9s); the 5 Oct order used only the open plan then
manual calls. There was no saved Minutes search→quantity→checkout plan.
New `noon-minutes-sponges-review.json` is an **unrehearsed draft** for an empty
basket and correct Minutes Home address: exact search/product/add-five/cart/
delivery-review screenshot, stops before payment. Task model checks quantities,
sets any missing instructions/toggles and reviews current total before paying.
New `talabat-open-pharmacy.json NAME` avoids the Food-tab bias of the restaurant
plan; also draft, not live-rehearsed. Talabat direct branch and both syringe IDs
were verified via native API; app deep-link candidate remains unverified.
Targets of 75–120s noon / 90–120s Talabat are estimates, not benchmark results.

## Third pass — 22:45 Dubai (latest)

Two clean live runs each: Amazon toothpaste add → checkout → exit → cleanup;
Amazon delivered-package tracking, delivery-instruction editor navigation (no save),
return-reason navigation (no reason chosen); Careem Food Right Bite checkout/cleanup;
Careem Shops Spinneys two-milk checkout/cleanup; Box category editor and leave-door
shortcut/full-note readback; noon Minutes existing-basket checkout/payment review;
noon NowNow VIVA milk checkout/cleanup; Talabat Supercare pharmacy and Ferns N Petals
flower checkout/cleanup; Wheely preferences/help and schedule-date selection → review
→ exit. These are specific trained examples, not all products/stores.

Fixes and evidence:
- Amazon suggestion sheet obscured Add to cart while AX exposed it. Scroll before
  add, guard obscured product buttons, wait for Cart 1 item. Two add runs14.0/14.5s,
  checkout7.9/8.0s, cleanup5.6/5.7s. Empty cart confirmed.
- Careem exact-case Plus must win over lowercase plus (Add more items icon).
  Shops minimum AED10 required quantity2; checkout10.4/9.6s, cleanup6.2/5.9s.
  Food checkout8.1/8.0s, cleanup6.6/5.4s; final global carts empty.
- Box chips are text shortcuts, NOT independent selected switches: leave-door
  overwrites note. Apply shortcut then full no-bell/no-call wording;12.6/10.5s.
  Category edit needs screenshot-grounded pencil offset;4.1/4.4s open,
  8.2/7.7s submit category. Submit here edits category only.
- Talabat pharmacy checkout10.1/9.8s, flowers12.1/12.7s; all additions removed,
  `There’s nothing in your cart yet!` verified. Pharmacy upsell is conditional.
- Talabat AX reports both chips unchecked. Calibrated fresh-pixel verifier now
  verifies don't-ring selected/call unselected, twice per invocation; two live
  invocations3.9/3.9s. Leave-at-door still absent/unverified; no false full-policy pass.
- Wheely date wheel AX text stays stale after movement; screenshot OCR confirms
  actual date, then summary AX confirms5 Oct. Two date-selection runs12.9/13.6s,
  final SCHEDULE A JOURNEY untouched and draft exited. Date argument is required;
  this is an observed two-day wheel movement, not arbitrary-time scheduling.
- NowNow VIVA checkout14.3/14.8s, cleanup16.6/15.8s. Existing separate Nothing
  AED1399 basket discovered after cleanup and preserved. Minutes nine-item basket
  untouched. Noon returns corrected verifiers passed and repeated6.1s.
- Amazon tracking8.8/7.4s; preferences-editor roundtrip15.2/14.9s;
  return-reason roundtrip6.4/6.8s. Tracking used a delivered order, not active ETA.

Still incomplete: Amazon variant flow (colour/size AX stale; OCR catches mismatch,
size L passed once but cold combined route still fails); active-order tracking;
saving delivery preferences. Noon Food promo did not recur, so recovery remains
unproven; Main/Rocket/Food checkout not trained in this pass. Talabat leave-at-door
control not found. Wheely arbitrary hour/minute choice not trained.

Runner additions: case-sensitive target preference; obscured Amazon guard;
fail-closed native checkbox and calibrated Talabat visual verifier; bounded OCR;
anchored wheel swipe; absence verification including IDs. Deterministic plans no
longer call Jev warmup. No orders, payments, bookings, returns submitted or messages.

Plans are executable navigation recipes, not model fine-tuning. Run with
`~/.local/android/venv/bin/python -u ../scripts/jevrun.py PLAN.json ARGS`.
Catalog lookups for noon/Talabat/Careem use APIs only; these UI search plans are
ordering navigation/training, not a requirement to verify API results on-device.
Final payment/booking/sending is always outside plans. All validations below
stopped before commitment. Existing noon Minutes basket (9 items) was preserved.
The single Talabat training pizza was removed; empty-cart text verified.

## Diagnosis

Order session `ses_efe088f7affe9M8Jg4K6v1HwXS` DID run
`talabat-open-restaurant.json` successfully in 13.9 seconds (memory events
121542480–121542481). The skill then explicitly directed manual `ph` menu search.
Only restaurant-open and NowNow-search plans were available; no customization,
notes or checkout plans. This was an incomplete-plan/documentation handoff,
not a Jev failure. Original September implementation session:
`ses_f0dd442f2ffeweTATVLC2OgcvU`.

## Live validated

| App/section | Plan(s), arguments | Result |
|---|---|---|
| Talabat Food | talabat-open-restaurant ZeroFat; talabat-menu-item "Hawaiian Pizza" | 12.6s + 10.1s, menu and product |
| Talabat options/item note | talabat-hawaiian-customize | 12s, ham + No onions please; AED68.40 |
| Talabat basket | talabat-add-customized-item | 7.1s, correct item/options/note |
| Talabat order note | talabat-cart-note NOTE | 14.5s, full note readback |
| Talabat checkout | talabat-checkout-review | 15.4s, Banyantree, card5542, total; no payment |
| Talabat checkout back | talabat-checkout-back | 3.8s |
| Talabat item discard | talabat-item-discard | 8.3s, confirms Yes, close |
| Talabat history/track | talabat-home-section Orders Orders; talabat-track | 5.3s +3.7s; track currently verifies ZeroFat |
| Careem Food | careem-section Food "Deliver to"; careem-food-search "Right Bite" | 8.2s +12.5s |
| Careem Quik | careem-section Quik Grocery; careem-quik-search milk | 6s +8.7s |
| Careem Shops | careem-section Shops "Type to search" | 5.9s |
| Careem Rides | careem-section Rides "Where to"; careem-ride-saved-destination Gym; careem-ride-premier | 7.3s +8.7s +8.7s; stopped at Yalla; backed out |
| Careem Box | careem-section Box "helping hand"; careem-box-pickup | 6.3s +6.6s, saved pickup list |
| noon account/history | noon-section Account "My Orders"; noon-account-page "My Orders" Orders | 18.4s +8s |
| noon Minutes | noon-minutes-open; noon-minutes-cart-review Banyan; noon-minutes-payment-review | 21.4s /25.6s /13.5s; existing cart read-only; card5542 |
| Amazon.ae | amazon-search "Marvis Whitening Mint 85ml" | 10.4s; results independently read back |
| Amazon.ae product | amazon-product "Whitening Mint Toothpaste With Xylitol" | 19.9s, Add to cart visible, nothing added |
| Careem Shops search | careem-shops-search charger | 7.2s, query verified; stronger result postcondition still needed |
| noon Minutes address | noon-minutes-address | 19.2s, saved address list, no selection changed |
| noon Food | noon-food-open | 16.3s, search page |
| Talabat account/vouchers | talabat-home-section Account Vouchers; talabat-vouchers | 4.7s +2.2s |
| Talabat cart removal | talabat-cart-remove-test-item | 4.4s, single training pizza removed, empty cart verified |
| Wheely | wheely-home | 8.1s, pickup and vehicle classes |

## Failures and fixes

- Talabat exact product text matched the search field: use Jev card choice.
- Long order-note verification failed because runner truncated labels to110 chars:
  full labels now retained for verification.
- Talabat card and total not simultaneously visible: verify sequentially with scroll.
- Talabat remove control is not in AX: generic Jev selected quantity center and
  opened item editor. Manual screenshot recovery removed test item at quantity
  anchor x−97. Updated remove plan requires live revalidation.
- Careem Box has no visible "Box Delivery" label: verify "helping hand".
- noon account transient error: rerun passed. Minutes semantic tile name missing:
  deterministic `switcher_button_uae_instant` works.
- Later cold-start from noon Food failed to switch to Minutes (18:22–18:23):
  target tap returned success but Food remained visible; bounded wait correctly
  failed. `noon-minutes-open` is conditional, not robust across all remembered tabs.
  Draft `noon-minutes-switch` also failed the postcondition. Needs screenshot-led
  recovery/training before broad use. Existing nine-item basket still untouched.
- Root cause found visually at18:27: Food "Deals for you" modal overlays the
  switcher but leaves background AX nodes exposed. Back dismisses it; then
  noon-minutes-switch passed13.9s. Cold-start plan still needs conditional modal
  dismissal. Minutes search Enter guard then handed back; search resource-id
  underscore matching corrected, awaiting rerun.
- Wheely has PICKUP rather than Where-to: corrected entry verifier.

## Inventory and remaining gaps (not validated)

| App | Subsections | Remaining workflows |
|---|---|---|
| Talabat | Food, Mart, Groceries, Beauty, Pharmacies, Sweets, Stores, Give Back, Pay, Account | cart quantity/remove revalidation; delivery chips (visual state); address/payment selection; vouchers; help/reorder; all non-Food ordering |
| noon | Main, Rocket, Food, Minutes, NowNow, Account | Main/Rocket/Food/NowNow product and checkout; Minutes options/notes/edits/delivery toggles; vouchers; addresses; returns/help; reorder |
| Careem | Rides, Food, Quik, Shops, Box, Hala, DineOut, Home&Care, Fix, Pay/Profile | Food/Quik/Shops customization/cart/checkout/notes/toggles; Box dropoff/category/checkout; tracking/history/help; account/vouchers; secondary services |
| Amazon.ae | Search, product/store, cart, checkout, orders, account | product variants/options, basket edits, address/payment/delivery preferences, checkout, tracking/history/reorder, returns/help |
| Wheely | Pickup/classes, destination, bookings, payment, account | destination/checkout, scheduling, history/help/account |

Draft unvalidated plans: noon-minutes-search (ran to actual results; corrected ADD to Filters/Sort, needs rerun), noon-minutes-switch (failed). Do not call these trained until live reruns pass.
Legacy noon-nownow-search was validated Sept30, not rerun in this pass.
Yango is uninstalled; its historical plan is obsolete.

## Runner conventions

## Continuation pass — 2026-10-03 19:33 Dubai

Still partial coverage. The following adds to, rather than replaces, the first-pass
inventory. No orders, payments, ride requests, return submissions or messages.
Talabat training pizza removed (empty-cart verifier passed); Careem Quik milk
removed (Your carts → Add items to your cart passed); Amazon toothpaste removed
(fresh tree: Your Shopping Cart is empty, Cart 0 item). A later Amazon add retry
did not add anything; fresh cart again showed empty. Noon nine-item basket untouched.

| Route | Live evidence / current status |
|---|---|
| noon Minutes repeat search | Fixed runner clear/refocus/paste race. `noon-minutes-search milk` 18.6s, change to smetana17.7s, repeat smetana19.9s; all readbacks and result verifiers pass. Suggestion tap replaces Enter (search label disappears after typing). |
| noon Main account | `noon-main-account`19.4s from Food account; verifies My Orders/Manage cards. Generic account route differs by vertical. |
| noon returns | `noon-returns-review`5.5s opened filters and empty return list; `noon-return-eligibility`4.8s opened Your recent purchases. Visible items had closed windows or were ineligible. Strengthened final verifiers reflect fresh live readback, not rerun yet. No return created. |
| Careem profile/account | `careem-profile`6.3s, repeated5.6s; `careem-account-review`10.6s verifies Marriott5542, Home/Gym/Monika HDS saved list, Help Centre. Home now has Profile bottom tab, not old burger ID. |
| Careem Quik basket/checkout/cleanup | Full repeat passed: section8.2s, search9.6s, training-cart7.4s, cleanup5.3s. One Almarai1L; fresh checkout shows Banyantree, Marriott, Pay17.55. `careem-carts` verifies Your carts; empty text independently checked. |
| Careem Box | Full repeat passed: section5.7s, pickup6.7s, route8.6s, checkout-review17.1s, help4.9s. Home→Gym Motorbike, captain note leave/no bell/no call, default Food/groceries category, total28, card5542, Place order untouched. Chip selection and category editing still missing. Restarted to Profile afterwards. |
| Wheely history/account | `wheely-history-roundtrip`5.2s verifies account Mastercard5542, opens JOURNEY HISTORY, returns PICKUP. Back from history returns map, not menu. |
| Wheely destination/prebooking | Pickup chooser→saved Banyan Tree goes directly to confirmation. `wheely-destination`10.1s typed Silverene Tower A; result ARKHE Club selected by `wheely-prebooking-review`7.0s. Fresh screen: Banyan Tree→ARKHE, Mastercard5542, Business AED63–79, REQUEST A CHAUFFEUR untouched. |
| Wheely scheduling | Opened Schedule a Journey→Other→PICKUP TIME / Schedule for. No time confirmed. `wheely-dismiss-training`6.5s closed sheet and backed to PICKUP. Schedule plan verifier corrected from Done; final combined version needs rerun. |
| Amazon cart/checkout | Initially empty. One Marvis toothpaste added; proceeded through Need anything else?→Continue4.6s to final Place your order screen. Fresh review: Banyan Tree2104, Mastercard5542, total40.07. Cancel returns upsell, then Back returns basket4.1s. Training toothpaste deleted and empty independently verified. Combined corrected plans need rerun; later add retry failed with empty basket, so add is not robust yet. |
| Amazon history | `amazon-orders`6.3s; order-detail5.8s opened delivered Amazon Now phone order. View order details tap did not change the page: `amazon-now-order-summary` is NOT validated despite weak Order verifier passing. Tracking of an active order / returns still missing. |
| Talabat quantity | `talabat-training-quantity-roundtrip`6.8s:1→2 (136.80)→1 (68.40), screenshot-grounded ±97px quantity anchor. |
| Talabat delivery chips | `talabat-delivery-review`2.6s plus screenshot: Don't ring doorbell visibly checked; Call on arrival unselected; Leave at reception / Ring doorbell grey. AX does not expose selection. Leave at door not visible here; no chips changed. This is visual review, not automated selected-state verification. |
| Talabat cleanup | `talabat-cart-remove-test-item`2.9s passed empty-cart verification. |
| Talabat Mart | Cold `talabat-mart-open`6.6s and `talabat-mart-search milk`6.5s passed result Item quantity verifier. No item added. Other verticals still untrained. |

### Continuation failures / remaining work

- Noon Food overlay did not recur in this pass. Cold Food open15.2s worked;
  conditional promo dismissal remains unresolved, not marked fixed.
- Amazon Jev cart navigation failed because its cart tab was beyond45 candidates.
  Deterministic Cart tap works. Add-to-cart retry ended in empty cart: investigate
  product button / load timing before calling basket plan reliable.
- Careem Quik and Talabat Mart typed search screens lose their Search label;
  exact query suggestion taps avoid weakening the Enter guard.
- Runner now separates clear→fresh field→paste; live verified across noon, Careem,
  Amazon, Talabat and Wheely. Four offline guard tests pass. Amazon Place your
  order text and Wheely confirmation_sheet_confirm resource ID explicitly blocked.
- Unfinished: Careem Food/Shops checkout/options/delivery toggles; Box category/
  chips; Talabat other vertical carts, delivery no-call/leave-door automation;
  noon Main/Food/NowNow checkout, delivery options and robust promo handling;
  Amazon variants, delivery preferences, reliable add, returns; Wheely settings/
  help and schedule selection. Full inventory above remains relevant.
- Several new plan final verifiers were tightened after fresh UI inspection but
  not rerun. Treat only explicitly passing routes above as validated.
- No commit: three unrelated staged files remain in shared config repository.

- `swipe`: up/down/left/right; `scroll_to`: bounded (default5 swipes).
- Optional tap `offset:[dx,dy]` only with an observed, stable semantic anchor and
  screenshot evidence; never use near payment/booking controls.
- Exit2 handback;3 typing;4 verification/wait timeout;5 PHONE_BUSY.
- Request tasks export `PHONE_HOLD_OWNER` as their exact hold token for every
  `ph` call and runner. Never copy another task's token.
- Background jobs use `ph lease run --owner <card-or-thread-id> --purpose "<short>" -- <cmd>`.
  Automatic process flock also prevents overlapping plan runs. Exit5 means yield,
  without looping or deleting another task's claim. `ph lease status` shows it.
- Plan-first beyond navigation: write the next short recipe when missing;
  manual input is recovery after an observed plan failure.
