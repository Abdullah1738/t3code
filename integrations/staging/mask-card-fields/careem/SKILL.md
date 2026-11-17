---
name: careem
description: Use for Careem Food, Quik groceries/electronics/shops and Box pickup/drop-off for Abdullah. Ordering and account actions go through the Careem Android app (ph); the careem-search guest CLI is optional read-only catalog only. Rides moved to Uber Lux (uber skill) on 2026-10-04; Careem rides only if he explicitly asks.
---

# Careem super-app (on Abdullah's local Android phone)

## Delivery cards (2026-10-22)

Load `delivery-cards` after placement. Register the confirmed order with
`order-watch add --app careem --vertical food|quik|shops|box ... --items-file FILE`.
Include the actual item names/photos and checkout total from the ordering task.
The tracker generates and sends one self-updating card: owner gets a tailnet native
card; Moni gets a public rich link. Verify `delivery_card.status:sent`. This replaces
Moni's placement text below; don't send both. No extra progress pings. Sparse
Careem email/push coverage stays explicit on the card.

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
- **Her go only.** "Order X" is a go for exactly X. A question ("what's best?", "find X on
  Careem") or an offered basket is not; anything you picked needs her ok. Wait 10+ min after
  proposing. 14 Oct: Quik AED 82.41 placed 17:06 after only an offer, and the 13:07 basket
  after "ordering it now". "No conflicting messages" is not a go. Price/fee/item change =
  ask again. Prefs and branch exclusions: `~/Documents/assistant/moni-prefs.md`.
- **Check first:** open now, delivers Home, item in stock, fee read from the logged-in app
  cart (guest `careem-search` fees aren't quotes; say which you used). Missing option or
  generic item = show options, don't add a paid substitute or use another store.

## Ordering and account stay in the app (owner rule, 2026-10-11)

Careem is deliberately NOT part of the commerce CLI ordering lanes: ordering,
payment, refunds, vouchers and account actions go through the Careem Android
app (`com.careem.acma`) with the phone workflows below. The `careem-search`
CLI remains an OPTIONAL read-only guest catalog (menus, prices, hours, ETA
hints) — guest pricing, not Abdullah's account/Plus benefits; `--require-account`
fails closed. Careem orders/tracking have no customer API scope:
`careem-search orders|track` returns ACCOUNT_CAPTURE_REQUIRED_GUEST_CATALOG_ONLY
(rechecked 2026-10-11) — track via email/notification evidence with
`order-watch`/`order-track` like before.

No further clone or OTP experiments (owner decision, 2026-10-10/11): the
`com.careem.capture` diagnostics below are CLOSED history, not a workflow to
resume — never launch the clone or retry its sign-in/OTP experiments.
**Restoration verified 2026-10-11, 12:36–12:37 Dubai:** the inherited capture
proxy was still enabled. Setting `http_proxy` explicitly to `:0` and restoring
`screen_off_timeout` to `60000` brought the original `com.careem.acma` online.
Profile retained Abdullah's login; Food loaded Home with live restaurants/ETAs,
and Quik loaded Home with products/prices and a 12-minute estimate. No logout,
data clearing or new order was needed. Re-check fresh app state on future use.

## Rides: NOT Careem any more (owner, 2026-10-04)
Default trips are **Uber Lux** — load the `uber` / `rides` skills. Use the Careem ride flow below only if Abdullah explicitly asks for Careem.

## Legacy Careem ride fast path
Known Home/Gym routes: use the `rides` fast path:
`~/.local/android/venv/bin/python ~/.config/opencode/skills/productivity/careem/scripts/ride.py Gym Home --review`
Export `PHONE_HOLD_OWNER` as your exact hold token for every `ph` call and runner. Reverse arguments for Home→Gym.
Live-tested 22–25s to Premier/Marriott checkout. No `--review` = dry-run returning
to Careem home. Task model reviews the fresh screenshot and performs authorised
Yalla tap; script never books. Skip delivery/API history for cab requests.
Another task's hold is a bounded handback, not a research loop.

## Always track delivery orders after checkout

7 Oct reliability update: see app-api-search's delivery reliability section.
15s durable push journal is live; Food/Quik/Box/rides share a package, so ID-less
pushes require exact-order verification before recipient arrival texts. Guest
catalog renewal still cannot track orders. Tracking failures go to Abdullah.
Do not ask Abdullah for the actual arrival time. Only if he volunteers it, record
`order-watch reconcile --app careem --order ID --reported-at ISO_WITH_TIMEZONE`.

After every Food/Quik/Shops order, run `order-watch add --app careem --order
ORDER_ID --for owner` (or `--for moni`), with `--placed-at ISO_WITH_TIMEZONE
--eta LATEST_ETA_ISO --label "store/items"`. Start tracking before reporting
completion.
Group order (asked for in a group chat, e.g. `group-sb_gro`): add `--chat <slug>`
to `order-watch add` so the card and arrival texts go to that group, not a 1:1.
Pass it even in a group thread: the chat is only inferred from the thread's folder,
and a `cd` elsewhere loses it. Check `chat` in the receipt.
Add `--single-active-order` only when this is the sole active delivery
and no ride/Box tracker could explain an ID-less Careem push. Read status with
`order-track --app careem --order ORDER_ID`; load `app-api-search` for limitations.
Tracking uses read-only email/notification evidence, without phone UI actions.
2026-10-04: `careem-search orders --json` and `careem-search track ORDER_ID --json`
return ACCOUNT_CAPTURE_REQUIRED_GUEST_CATALOG_ONLY until an authenticated order
session is available. `careem-auth refresh` renews guest access only; it cannot
unlock Quik/Food order history. 173090398 remains API-unverified. Do not retry
clone login or claim these entry points already track Careem orders.
Capture recheck (2026-10-04): original `com.careem.acma` still rejects `run-as`
as non-debuggable; no root executable/debug WebView socket was found. Combined
with the earlier original-app TLS rejection, account capture remains blocked.
There is no working account recapture command; guest renewal below is separate.

## Plan-first app navigation

See `../android-phone/plans/COVERAGE.md` for exact tested routes and remaining gaps.
`careem-section.json SERVICE EXPECTED_TEXT` enters Food/Quik/Shops/Rides/Box;
Food/Quik search, saved ride destination/Premier pre-booking, and Box pickup
have saved plans. Continue with a newly written jevrun plan when coverage ends;
manual phone input is recovery after a plan failure. Final checkout verification
stays with the task model. API catalog results need no phone verification.

## Request policy and delivery instructions

Use the default iMessage-thread model to search/compare/order, and
`opus/gpt-6-astra` for tool/skill maintenance (provider-block fallback unchanged).
Owner/Moni requests preempt builds; background phone batches yield to priority-hold.
Basket priority: fewest orders > ETA > total with fees (`basket ITEM ITEM --json`).
Catalogs expose `image_url`; `--images-dir DIR` downloads candidates for visual review.
Food/Quik/Shops/Box checkout MUST request **leave at door, don't ring bell, don't
call**, using all supported toggles and delivery instructions. Box's documented
captain chips include “Please leave outside the door” and “Upon arrival please
call”: select the former, deselect the latter; add no bell/no call to the note.
Food/Quik/Shops: inspect delivery-address/instructions (restaurant “Add a note”
may be kitchen-only, so don't mistake it for rider instructions). Exact current
toggles remain unverified. Read back before paying. Keep Jev + jevrun fast path.

Load `android-phone` first (`ph` CLI, rules). Package **`com.careem.acma`** (installed 2026-10-02 from Play).
Account: +971585134795, "Abdullah Rangoonwala" (rating 4.95). Rides default = **Premier** (see `rides` skill).

## Read-only search status (2026-10-03)

### Auth renewal (verified 2026-10-04)

Run **`careem-auth refresh`** to renew the guest catalog token (~4 seconds,
including a live catalog validation); `careem-auth status` shows expiry only.
`careem-search` automatically refreshes and retries once on HTTP 401. Concurrent
callers share a cross-process refresh lock and reuse the winning token. HTTP 403
does not trigger renewal. No phone, OTP, clone launch or proxy is needed.
The legitimate clone guest refresh token and APK client-auth configuration were
recovered once into macOS Keychain (`app-api-cli.native`, account `careem`).
Rotated refresh tokens remain there; access headers change only after a live
guest catalog validation. Tokens/credentials must never be printed. This remains
guest pricing, not Abdullah's account/Plus benefits. Bootstrap/revoked-grant
errors require maintenance; do not retry clone sign-in. Source:
`/Users/ardud/Documents/assistant/app-api-cli/careem_auth.py`.
Verified: Food `"veal dumplings"` returned 3 restaurants/10 dish hits (not proof of
exact veal availability), forced-401 Quik search returned 20 milk products, and
three simultaneous renewal processes reused one rotation.

Owner scope rule (2026-10-03): API work is for read-only Quik, electronics,
Shops and Food search/catalogs. Rides and Box are booked in the app; never map
their APIs or build API price checks. Do not retry sign-in in the diagnostic clone.

`careem-search` is delivered; load `app-api-search`. Quik/Food/menu and now
Shops/electronics all work over native guest APIs (~1–3 s). Shops uses global-search
and merchant-home, with area, ETA and delivery fee. Quik now exposes ETA/fee too.
`careem-search food sushi --open`, `menu ID --query salmon`,
`menu-match sushi "seaweed salad" --open`, `quik milk`, `shops milk --open`,
`electronics charger --open`. Multi-item matching is item-name-only, with culinary
synonyms; unrelated product hits are removed. Electronics applies a name category filter.
`shop-search match careem shops milk eggs --open --json` (also quik/electronics)
intersects store IDs and gives item subtotals, excluding fees.
All API calls use saved noon Home pin 25.0778251,55.1569039; Careem's account/Home
record is not verified. Guest/Plus promotional fees are not owner entitlements.
`--require-account` fails closed. Shops API errors automatically announce and use
the real-app UI fallback; fee/open status are unavailable there. `--ui` forces UI.
Food/Quik candidate search is first-page bounded; menus are complete returned catalogs.
The discovery paragraphs below are historical; ride endpoints are out of scope.

Read-only offline APK analysis is recorded in
`~/Documents/assistant/app-api-cli/CAREEM-NOTES.md`. Candidate native families include
`rides.careemapis.com` (`v1/rides/estimate`, `v2/rides/estimate`),
`food.careemapis.com` and `groceries.careemapis.com`. These are APK strings, not
verified ride requests. **Authenticated API replay remains unavailable**; the guest
catalog CLI above is delivered. Original app/data/login were not modified.

The separate `com.careem.capture` clone is historical diagnostic tooling, not
the Careem app to use. Keep it stopped. Previous bootstrap requests returned
202 without a received code; the cause was not established. That is not proof
the real app's login provider is broken. Historical notes are in the fork's
`integrations/app-api-cli/CAREEM-NOTES.md` and `CAREEM-AUTH-RESUME.md`.
Do not resume capture/OTP experiments without a new owner request.

## Hard rules
- **Shared phone:** request tasks use `ph hold acquire --token <session-id>`, export `PHONE_HOLD_OWNER=<session-id>` for every `ph` call and runner, and `ph hold release` on completion, cancellation or failure. ph refreshes on every call; use `ph hold refresh` during long OTP/reply waits. It archives holds after their agent exits or 30 minutes without a refresh. `ph hold status` shows the holder's process and time until stale. Background jobs use `ph lease run --owner <card-or-thread-id> --purpose "<short>" -- <cmd>`. Exit 5 means yield; never loop or delete another task's claim. Keep `http_proxy` at `:0`. If an old capture proxy broke the app, verify no conflicting holder then explicitly restore `:0` (deleting the setting can leave a cached proxy). Never clear app data, log out, or touch unrelated apps to repair connectivity.
- A post-ride rating sheet ("How was your experience with <captain>?") can pop up when opening Rides: tap "Skip". Don't rate unless asked.
- Never tap **Yalla!** (rides), **Pay AED X** (Food/Quik/Shops), **Place order** (Box) unless Abdullah explicitly asked in this conversation. Getting to those screens is fine.
- **Conflict hold (13 Oct review):** immediately before that final tap, re-read the latest messages from the requester AND Abdullah in the relevant chat(s) (Moni: her Robob thread; plus the owner thread). If anything newer conflicts with, changes or retracts the selection, hold and reconfirm instead of placing. A fallback path never inherits authorization past a newer conflicting message. For Moni, the re-read must also show her explicit go (her own "order X", or her ok after the final basket and price); no go = no Pay tap.
- Trackers on the home screen ("Arriving in 1 minute", "How was your ride?") are Abdullah's own rides. Shared bookings for Moni are fine. Never cancel or rate a ride unless asked.

## Login (done 2026-10-02; redo only if logged out)
Home burger (id=button_BurgerMenu) → "Continue with phone number" → id=phone_number_edittext `585134795` → id=btn_continue ("Send code via SMS") → SMS "<#> Your code is NNNN" (4 digits; `ph sms 3`) → tap id=edit_otp_code, `ph type NNNN` → "Yes, I'm a returning user" → "Verify your card" (id=TryAnotherWayCardInput) answer **4746** (Careem login verification answer: last 4 of a card on the account) → id=ContinueButton.
Grant perms: `ph sh pm grant com.careem.acma android.permission.{ACCESS_FINE_LOCATION,ACCESS_COARSE_LOCATION,POST_NOTIFICATIONS}`.

## Home screen
Tiles (by text): Rides, Food, Quik, Pay, Box (row 1, Box may be off-screen right at x≈1062) and Hala Taxi, Shops, DineOut, Home&Care, Fix. Back from a service: id=button_ArrowLeft. Popups: Careem Plus spotlight (tap the cross at ~(985,666) or Back), "How was your experience?" rating sheet (cross at ~(985,1894)). Never join Careem Plus.

## Saved addresses (Profile → Saved addresses), cleaned 2026-10-02 per owner
Keep ONLY these three (Moni + Moni Office deleted 2026-10-02):
- **Home** = "2104, 21, Banyantree Residences Hillside, JLT, Dubai" (formerly "The Den").
- **Gym** = "ARKHE Club, Silverene Tower A, Dubai" (custom label Gym; rides captain note: Silverene Tower A entrance itself, not the road below or residents' parking).
- **Monika HDS** = "HDS Tower, Floor 37, 3701, Dubai" (the office / HDS Tower entry).
The tracker on Careem home ("Arriving...", "How was your ride?") is Abdullah's own ride. Shared bookings for Moni are fine.
- Add new: id=button_new_address → "Search an address" → type → tap the result ROW by coords (`ph tap "ARKHE Club"` matches the typed field case-insensitively) → Next → type (Other) → id=other_address_details → label Custom/id=nickname_input_field → id=button_next "Save address".
- Remove: row's moreVertical → "Remove" → "Yes, remove".

## Payment: use card 2342 ("Marriott2342"), added 2026-11-01. 5542 is DEAD
- 1 Nov 2026: 2342 was added (ENBD X approved, AED 1 check refunded). 5542 is still saved and still pre-selected by default, so switch the payment line to 2342 by hand on every final screen until 5542 is removed. Never pay on 5542.

### History: card 5542 ("Marriott") was the only card and the default everywhere (2026-10-02 23:44)
- Profile → Card and accounts shows only **Marriott •• 5542 | Credit** (MasterCard). All other cards (7543, 4455, 5399, 9963, 4746, 7896) were deleted 2026-10-02. Wallet AED 0, Cash still exists as an option. Never select them.
- Verified auto-selected on the final screens: Rides ("Marriott" row above Yalla!), Food cart ("Marriott", Pay AED X), Quik cart ("Marriott"), Box ("Pay with Marriott •• 5542"). Still glance at the card line on every final screen.
- (nightly 2026-10-19) Before paying on 5542 run `card-status check 5542` (exit 3 = declined in the last 12h: stop, tell the requester, ask Abdullah once, no retry). After an in-app decline: `card-status declined 5542 --reason "<reason>" --source "careem <what>"`. Clear only on his word: `card-status ok 5542 --note "topped up HH:MM"`.
- Re-adding a card (if ever needed): Card and accounts → "Add" → tap fields and use `adb -s SERIAL shell input text "$(security find-generic-password -s robob-card -a Marriott.<field> -w | tr -cd '0-9')"` (no clipboard; `ph type` fails on the expiry field and leaves card data in the clipboard). Field coords: number (540,482), MM/YY (280,705), CVV (799,705), nickname (540,893); DON'T press Back (it closes the form); "Add card" button moves to (540,1331) while the keyboard is up. → "Verification required" → Continue → ENBD Mastercard Identity Check: "Tap on the push notification we have sent on your ENBDX app" (AED 1.00 test hold) → Abdullah approves in ENBD X (text him via the iMessage bridge) → "Card added successfully". Redact `ph ui` on that form (it shows full PAN/CVV).
- Remove a card: card's "Edit" → "Remove card" (expired) / "Remove this card from wallet" → "Yes, remove card" → "Card removed successfully" → "Go to wallet".

## Rides (Premier)
1. Home → "Rides" (close Plus spotlight). Screen: "Where to?", "Later" (schedule), recent places.
2. "Where to?" → pickup field (id=field_search, defaults to nearest saved place/GPS, e.g. Home "58 m") and drop-off field. Tabs "Suggested" / "Saved". Tap **Saved** → "Gym" (or Home).
3. "Confirm pick-up" screen (id=item_selected_address shows pickup) → tap "Confirm pick-up". To change pickup, tap the address card first.
4. Class list with prices + ETA: Comfort, Executive, **Premier**, Premier Max, Kids, Electric. Tap "Premier" (row text). Payment row "Marriott" (5542) + "Add offer". Book button = **"Yalla!"** (~(466,2224)); settings gear next to it.
5. Sample 2026-10-02 22:41, Home → Gym (Arkhe): **Premier AED 56.48**, 2 mins away, arrive ~12 min; Executive 43.96, Comfort 33-40.
6. Backing out: `ph key back` ×2-3. Nothing is booked until Yalla!.

## Food
Home → "Food" → "Deliver to Home" (id=location-picker) → search bar at (477,346) (placeholder rotates: "Search for cuisines/restaurants", so tap coords) → type → `ph key enter` → Restaurants/Dishes tabs, "Best match for ..." → tap restaurant name → menu (filters: Schedule id=chip_button_schedule, Group order) → tap item card → item sheet (options, qty) → "Add • AED X" → bottom bar "AED X • 1 item" + **Checkout** → cart: items with Plus/Minus, "Add a note", "Don't send cutlery", "Deliver to Home" + address, card "Marriott" (5542), button **"Pay AED X"** (STOP). Restaurant cards show calorie/macros on many healthy places ("Calorie info" filter).
Tested: Right Bite (Dubai Marina) Creamy Chicken Spaghetti AED 64 → Pay AED 67.20 (incl. 4.50 delivery). Clear cart: Minus on the item.

## Quik (groceries, ~12 min)
Home → "Quik" → tabs All/Deals/Fresh/Discover/FIX/Beauty/Categories, "Grocery List" / "AI List" (type or photo of a list). Search bar (363,346) → type → enter → results with "Plus" add buttons (prices id=composable-node-info-price-cnt-final) → bottom bar "Checkout" → Cart ("Did you forget?" upsells) → Deliver to Home, card Marriott 5542 → **"Pay AED X"** (STOP; small orders add fees, e.g. 1 L milk 7.60 → Pay 17.55).

## Shops (electronics, pharmacy, flowers, pets, Spinneys ...)
Home → "Shops" → "Type to search..." at (540,346) → type → enter → results grouped by store (e.g. "airpods" → HiPhone Telecom, Phone Book, Geant Express, with ETA + items). Categories: Pharmacy, Super market, Gifts & Flowers, Butchery & Seafood, Specialty, Pet Supplies, Roasteries & Sweets, Health & Beauty, Toys & Stationary, Home & Living. Cart/checkout same as Food.

## Box (courier pickup/drop-off)
Home → "Box" → options id=box-delivery-bike (Box Delivery), id=box-delivery-car, id=box-delivery-shop-n-drop (buy & deliver), id=box-delivery-citytocity.
Box Delivery: "Add pick-up details" → saved list (Home, Gym, ...) or search → "Add drop-off details" → vehicle Motorbike (≤7 kg, AED 24-28) / Car (≤60 kg, AED 33-38) → instructions for captain (chips "Upon arrival please call", "Please leave outside the door") → Package category (default "Food, groceries", editable) → "Continue to checkout" → summary (ETA 30-40 min, est. total, card authorised hold) → **"Place order"** (STOP). Home → Gym motorbike: est. AED 28, card Marriott 5542.

## Gotchas
- `ph tap "Box"` fails if the Play Store was foreground; `ph open com.careem.acma` first.
- Pressing Back too many times exits to the previous app (e.g. Play Store).
- Many nodes are Compose with empty text; use coordinates from the sibling text node.
