---
name: uber
description: Use for Uber rides for Abdullah. CLI first for places, fares, booking, live driver status and cancellation; native Android app fallback for unsupported features. Default Lux, card 2342.
---

# Uber — CLI first

Owner rule (2026-10-04): "we will use uber from now on and not Careem for trips. Uber lux".
Every ride = **Uber, class "Lux"**, card **Mastercard ••••2342 (Marriott)**. Careem stays for
Food / Quik / Box only. Load `rides` for booking authorization, live pickup and rider
communication. Use the installed `uber` CLI first (owner, 2026-10-11). Use the
original Android app `com.ubercab` only for unsupported features or a verified
CLI failure. Phone fallback follows `android-phone` rules and the priority hold.

## CLI setup and verified coverage (2026-10-11)

Installed: `@crafter/uber-cli` 0.1.0, `agent-browser` 0.38.2; upstream
`https://github.com/crafter-station/uber-cli`. `uber doctor --json` checks install.
Default profile is `default`. Session is encrypted in
`~/Library/Application Support/uber/profiles/default/session.enc`; key in macOS
Keychain service `uber-cli`. Never print cookies, OTPs, keys or decrypted sessions.

Live-proven: saved places → Lux quote → request → assigned driver/vehicle/plate →
cancel → idle status → exact cancelled-trip history. The owner-authorized test
on 11 Oct used Home → Gym, Mastercard 5542, quote AED 65.89. Cancellation was
confirmed 29 seconds after request, AFTER driver assignment; Uber recorded
`CANCELED`, AED 0.00. This is past evidence, not permission for another test and
not a promise that future cancellations are free.

### Live ride status / ETA: fast recipe (2026-10-13)

Use **`uber-ride`** (`~/.local/bin/uber-ride`, our wrapper; not part of the npm
package, so upgrades don't touch it). It runs `uber rides status --json` with a
hard 15 s kill and prints one line: trip UUID, status, driver, car, plate,
pickup ETA, arrival time (Dubai) and dropoff. Measured 1–3 s.

```sh
uber-ride --trip 4607125a      # summary; --trip checks the current trip UUID prefix
uber-ride --json               # raw rides-status envelope
```

Exit codes: 0 = ride in progress, 3 = no ride, 4 = current trip is NOT the
`--trip` you asked for, 5 = CLI error envelope (auth etc., message on stderr),
124 = timed out (then check `uber auth status --json` or read the trip in the app).
Without the wrapper: `perl -e 'alarm 15; exec @ARGV' uber rides status --json`
(macOS has no `timeout`).

**Gotcha: never use bare `uber status`.** It is an alias of `auth status`
(aliases: `auth`, `status`, `whoami`), not ride status, so it never shows driver
or ETA. It probes all three surfaces, and the Eats probe is permanently expired
and Cloudflare-gated, so it launches a **headed** agent-browser Chrome (window
pops up, 120 s idle). It also flips the profile's `.browser-mode` and restarts
the shared `uber-cli-default` browser. Cold, it took 36 s; on 13 Oct (Moni's ETA
ask) it printed nothing in 45 s and was killed. Ride status is `uber rides status`
(alias `uber ride`), which is pure HTTP and never opens a browser.

### Booking and tracking

1. Get the rider's location from the Sendblue `location` command (or
   `location-request` if none is fresh; see `imessage-notifications`). Find My is
   retired. Use the explicitly requested pickup when supplied. Never substitute the automation phone's GPS.
2. `uber rides status --json`: do not create a second trip while one is active.
   `state: Looking` with `trip: null` was the verified idle shape. On an error or
   uncertain state, inspect the original app before any new booking.
3. `uber me --json` verifies the account and available payment methods. Resolve
   the current UUID of **Mastercard 2342** into `PAYMENT_UUID`; do not assume the
   selected method is correct and never choose 7896/Cash/Uber Cash.
4. `uber places saved --json` resolves `home` and `gym`. For other locations use
   `uber places search "VENUE" --json`, then inspect the selected address/pin.
   Exception: "same place you dropped me" / "where I got dropped" uses the exact
   drop-off pin of the rider's last completed trip (`uber trips list --json` ->
   `uber trips get UUID --json`, 2nd `mapImageUrl` marker) as `--from LAT,LNG`,
   never a venue-name search (13 Oct: wrong Mazaya entrance). See `rides`.
5. Preview (non-booking):

   ```sh
   uber rides estimate --from home --to gym --json
   uber rides request --from home --to gym --product Lux \
       --payment "$PAYMENT_UUID" --max-fare "$FARE_CEILING" --json
   ```

   Verify pickup **Banyan Tree Residences • Hillside**, dropoff **ARKHE Club,
   Silverene Tower**, `Lux`, AED fare and 2342 from the fresh preview. Adapt the
   route for the actual request. Set a reasonable ceiling within the user's
   authorization; don't copy a historical fare as today's quote.
6. Only when the current user request authorizes this booking, confirm its exact
   single-use token: `uber rides request --confirm rq_TOKEN --json`. Preview is
   not booking. Tokens expire; a higher re-quote is a new decision, not success.
   A returned `tripUuid` is the identity to retain.
7. `uber-ride --trip TRIP_UUID` (or `uber rides status --json`, never bare
   `uber status`) provides the CURRENT trip, driver/car/plate/ETA.
   Verify its UUID matches this booking. Never reuse a driver from history.
8. **Live ride card (owner rule, 22 Oct 2026), immediately after `tripUuid`:**
   `ride-card meta` (only if the rider isn't Abdullah), `ride-card refresh --trip UUID`,
   `ride-card send --trip UUID --session CURRENT_SESSION_ID`. One shared card for
   rider and booker (Abdullah + Moni) that the `ride-share-updates` watcher keeps
   current (driver, car, plate, ETA, five-step rail). It replaces the old plate and
   arrival texts: don't send those. Booked from a group? Its own session reaches it; from the owner
   chat add `--chat group-...` (groups get the share link). Full flow: `references/booking-card.md`.
   **Scheduled (Reserve) rides:** no tripUuid until dispatch, so set the reservation auto-card
   watcher at booking time (`references/booking-card.md` "Scheduled reservations"). Never put a
   session id in its context; it wakes the owner thread, which sends with its own current session.

The CLI cannot set quiet ride, temperature or other rider preferences. Say that
before asking for the go and tell the rider to ask the driver; don't promise them.
ETA/arrival claims come only from a fresh `uber-ride --trip` read, quoted as read.
Pickup wait timer and "tell me when they've arrived" handling: see `rides`.

### Cancellation and ambiguous outcomes

Only cancel when asked (including an explicitly authorized test's cancellation):
`uber rides cancel --json` previews, then
`uber rides cancel --confirm rc_TOKEN --json` cancels the bound current trip.
Inspect the trip UUID and `cancelable` state. The preview currently gives a
GENERIC fee warning, not an exact fee quote; do not claim cancellation is free.
Read `uber rides status --json` after success and
`uber trips get TRIP_UUID --json` for terminal status/recorded fare. Cancelled
trips may have no receipt (`trips receipt` returns not-found). History address
labels were inconsistent on the test; use the verified preview/live stops for
route identity, not duplicate cancelled-history labels.

Never blind-repeat a request/confirmation after a timeout, lost response or
unknown send. Check live status, audit/history and the original app first. Do
not bypass `uber killswitch` or create a new request to escape an uncertain one.
If a requested cancellation fails in the CLI, immediately inspect/cancel that
exact trip in the original app rather than abandoning an active test ride.

### Confirm failure investigation / local patch (2026-10-16)

At 10:12 Dubai, Home → HDS Tower (`ChIJqfNuG6xsXz4RgtGp7REtb2E`), Lux
AED 42.50, card 2342 previewed normally; two confirmations returned upstream
`not found`. Audit `started` occurs immediately before the sole `TripRequest`
GraphQL mutation to `https://m.uber.com/go/graphql`; both failures were there,
not in place resolution or repricing. The old client dropped HTTP status,
operation, GraphQL error code/path and request ID, and incorrectly marked this
money-action failure retryable. **The Uber-side reason is still unproven.**
Do not claim that the booking failure is fixed or that Google IDs are broken:
the exact HDS ID booked successfully on 14 Oct and was the pickup on 15 Oct.

Read-only findings: same account/profile/payment on riders and rides surfaces,
no arrears, both locations resolved, Lux preview succeeded before the native
ride started. The live web `TripRequest` document exactly matched the installed
one. No login/profile changes were needed. Later previews returned products
with `isAvailable:false` while the native ride was `OnTrip`; that is not evidence
of a new CLI fault. No live confirmation or cancellation was sent by this investigation.

Installed a narrow diagnostics/retry-semantics patch to 0.1.0:
- GraphQL failures name operation + HTTP status, and available error code/path
  and request ID. These are retained in the existing failure audit message.
- Null `tripRequest` plus GraphQL errors no longer becomes a null-property crash.
- Failures from a dispatched `TripRequest` have `retryable:false` and instruct
  the caller to reconcile status/app/history before another attempt.
- Does not change destination, fare metadata, payment, request document or login.
- Six offline tests exercise the shipped command/client with **all fetches mocked**:
  not-found, network error, null data, success UUID, business error and HTTP 503.

Patch source and exact replayable installer (version/snippet guarded):
`~/.config/opencode/skills/productivity/uber/scripts/apply-confirm-diagnostics.py`
and `scripts/trip-request-diagnostics.js`. Reapply after reinstalling **0.1.0**:

```sh
/usr/bin/python3 ~/.config/opencode/skills/productivity/uber/scripts/apply-confirm-diagnostics.py
node --test ~/.config/opencode/skills/productivity/uber/scripts/confirm-regression.test.mjs
```

The installer locates the active `uber` executable; refuses other versions or
changed code. Installed files: package `dist/main.js` and
`dist/local-trip-request-diagnostics.js`. Original bundle/package + checksums:
`~/.local/share/uber-cli-patches/20261016-confirm-diagnostics/` (survives npm
reinstall), also package `local-backups/20261016-confirm-diagnostics/`.
Original bundle SHA-256: `ea296a89de2d9818b8982a1431eca430ba05a1c0e1cc7b0cefd5d55a8526a82a`.
Rollback copies that backup's `main.js` over the same-version package's
`dist/main.js`; the unused helper can remain. Investigation artifacts:
`/Users/ardud/.robob/imessage/tmp/uber-cli-confirm-20261016/REPORT.md`.

**Next actual owner-authorized booking:** first verify no active ride, then a
fresh preview and current 2342, confirm once only. Success requires returned
`tripUuid` plus matching fresh status/driver. If it fails, retain the enriched
JSON and audit error, check exact live status and app/history, and investigate
the indicated HTTP/code/path before retrying or falling back. Preview success
cannot establish mutation success. Do not send a test booking for diagnostics.

### Authentication recovery (both surfaces required)

`uber me --json` needs **riders** (`riders.uber.com`); places, fares and active
status need **rides** (`m.uber.com/go`). Both must work for booking. `eats:false`
is irrelevant to rides. `uber auth status --json`/`uber auth refresh --json` may
include generic login advice when only Eats failed; check each surface instead.

Try `uber auth refresh --json` once. For a genuine login/SSO gap, the owner
explicitly chose this CLI's built-in **agent-browser**, not Dia. Use its SAME
persistent profile and session; omitting `--profile` starts an empty browser:

```sh
agent-browser --session uber-cli-default \
    --profile "$HOME/Library/Application Support/uber/profiles/default/browser" \
    --headed open 'https://m.uber.com/go/home'
agent-browser --session uber-cli-default snapshot -i
```

If Login is shown, complete the normal UI with fresh snapshot refs. UAE phone
field uses the local number; SMS is four digits on the current `[Uber] Your code:`
message. Scope extraction to this request's timestamp (never match a year or an
old SMS). An email step may follow: iCloud, subject `Do not share: …`; check
Inbox/Junk. Keep codes in RAM, not chat/files. Do not loop on Resend.
Then open `https://riders.uber.com/trips` in that same profile to complete its
SSO hop. Run `uber auth refresh --json` to seal the cookies; verify `uber me`,
`uber places saved` and `uber rides status` before booking. If switching from an
already-running empty/mismatched browser, close only `uber-cli-default` first.
Headed recovery may show a window; do not automate past an unsolved challenge.

Diagnostic: an `Unexpected token '<'` during request PREVIEW was riders GraphQL
returning an HTML 302 login redirect while rides auth worked. Correct-profile
riders SSO + refresh fixed it. A raw headless browser at an auth challenge is not
proof the saved CLI session expired. Avoid repeated full logins.

### App-only gaps

Multi-stop/scheduled rides, destination changes, driver chat, guest-rider/Moni
selection and account/payment edits are not live-proven in this CLI. Use the
native app for those actions, without creating a duplicate trip. The CLI's
status can still help only when the current trip identity is verified. No
Silverene entrance note to drivers any more (owner, 31 Oct: not needed on Uber).
Do not claim the earlier multi-stop/destination-change campaign goals are done.

## Native app fallback reference

The sections below are phone fallback instructions, not the default route.

## Account (set up 2026-10-04)
- Installed from Play Store 4 Oct 2026. Logged into his EXISTING Uber account:
  Abdullah Rangoonwala, +971 58 513 4795, abdullahrangoonwala@icloud.com (rating 4.77).
- Login = 2 codes: phone field (type `+971585134795`, the UAE flag auto-selects; the
  country-code picker doesn't open by tap) → Continue → 4-digit SMS "[Uber] Your code: NNNN"
  (`ph sms 3`) into id=PHONE_SMS_OTP-0 → then "Welcome back, Abdullah" asks a 4-digit
  **email** code to the iCloud address: `himalaya envelope list -a icloud -s 5`, subject
  "Do not share: NNNN" → id=EMAIL_OTP_CODE-0.
- First open after login showed a "Rate your trip" sheet for an old trip: tap
  id=ub__skip_button_v2 (never tip/rate on his behalf).

## Payment
- **Card swap 30 Oct 2026:** ENBD Marriott 5542 was cancelled 29 Oct; replacement Marriott **2342** added in the app, set as Personal default, and 5542 removed. Wallet now = 7896 (Wio), **2342** and Cash (plus Apple Pay/Uber Cash in `uber me`). The vault "Marriott" card = **2342**.
- History: wallet since 4 Oct 23:59 was 7896, 5542, Cash; the bogus 7412 "(Marriot)" card was deleted. Don't trust Uber's "(Marriot)" label.
- Personal profile default = Mastercard ••••2342 (Account → Wallet → Trip profiles →
  Personal → "Selected payment method"). Checkout bar id=ub__payment_bar_view shows
  "Mastercard ••••2342"; verify it on every booking. Never 7412/7896/Cash.
- (nightly 2026-10-18) When Abdullah says not to use the Marriott card (now 2342; 17 Oct: "don't use Marriott 5542 today", it was over its limit), Uber has no allowed card: Mashreq 9546/9093 are not in the Uber wallet. Don't offer 7896, Cash or 2342 as a "just this once" option. Send one message: "2342 is off today and 9546 isn't on Uber. Add 9546 in the app, or book this one yourself." Don't book until he answers. Check `uber me` for the wallet before asking. On 17 Oct the agent asked "Can I put it on Wio 7896?" and Moni's ride slipped while he booked it himself.

- (nightly 2026-10-19) After any card decline, don't retry the same card the same day. Check `card-status check 2342` first (exit 3 = declined in the last 12h). On 18 Oct Tims was declined on 5542 at 11:11, then Moni's Uber was tried on 5542 at 12:55 and failed too, so she booked it herself. Record a decline with `card-status declined 2342 --source uber` and a top-up with `card-status ok 2342`.
- (nightly 2026-10-19) Fares: the quote is not the price. If the last finished trip on the same route cost far more than the quote (18 Oct: ARKHE quoted ~75, actual 144.85), say both numbers before booking the next one.

## Saved places (Account → Settings → Shortcuts / Saved places)
- **Home** = Banyan Tree Residences • Hillside (Al Sarayat St, JLT).
- **Gym** = ARKHE Club (Silverene Tower, Dubai Marina). Search "ARKHE Club" works.
- Also pre-existing: "Anah" (AlTurrfa Park) — not ours to use by default.

## Phone booking flow (initial review verified 4 Oct; real booking notes below)
1. `ph open com.ubercab` → home tab: tap "Where to?".
2. "Plan your trip": pickup defaults to GPS ("3 Al Thanya St"). ALWAYS set it:
   tap id=ub__location_edit_search_pickup_view → `ph type "Home" --clear` →
   tap "Home, Banyan Tree Residences • Hillside".
3. Destination field is focused: tap the saved suggestion (e.g. "Gym, ARKHE Club"). If you
   typed "Gym", search returns Gymboree; tap "Clear location text" to see saved places again.
4. "Choose a trip" list: rows like `Lux,Fare AED 75.65,Estimated drop-off…, driver is 3 min`
   (also Comfort, Black, VanXL). Lux was preselected; tap the row starting "Lux," if not
   "selected,Lux". Home→Gym Lux ≈ AED 76 (4 Oct, 23:03).
5. Verify: header "Home to Gym", "selected,Lux", payment bar "Mastercard ••••2342".
   Button id=order_selection_request_button reads "Choose Lux" — this is the
   REQUEST tap; only when Abdullah asked for the ride. Then read the result (possible
   extra confirm-pickup screen: check the pin is Banyantree/Silverene, then confirm).
6. Silverene pickups: no driver message needed (owner, 31 Oct 2026).

## Gotchas
- Phone was Dozing with keyguard on: `adb shell input keyevent KEYCODE_WAKEUP; adb shell
  wm dismiss-keyguard`, then swipe up; Play Store `ph ui` was empty until then.
- The Google keyboard often covers the tree; filter `ph ui | grep -v inputmethod`.
- Phone fallback fast path = the jevrun plans below; manual `ph` only on handback.
- First real booking (4 Oct, Mr. Brisket Motor City → Home, Lux AED 136.42): after "Choose Lux"
  there were 3 more screens: "Confirm the pick-up spot" (id=confirm_button) → "Confirm new fare"
  (id=ub__sobriety_confirm_button, same fare) → "Is this trip for someone else?" (shows up because
  the phone's GPS is at home, far from the pickup). "Me" is preselected, so check ✓ on Me, then
  id=button_next "Book trip". A driver was assigned in ~20 s. Driver/car/plate come in one
  content-desc ("Vehicle number plate – …, <colour> <model>. Driver name – …").
- Non-home pickups: type the venue name into the pickup field (e.g. "Mr. Brisket Motor City") and
  tap the top result. A shared location sometimes resolves only to "Dubai" for him; then use the known venue.
- **Wallet cards can't be removed or edited during an active trip**: Delete shows a snackbar "You
  cannot delete or make changes to the payment methods while your trip…" and the card stays.
  Remove cards only after the trip ends.
- While a trip is active, the top-left id=ub__menu is "Navigate to home screen"; tap
  id=ub__menu_view_button, and Account/Wallet show up in the bottom tabs.

## Fast plans (plan + jevrun, built 4–5 Oct 2026; deterministic, 0 Jev calls, $0)
Take your own hold with `ph hold acquire --token <session-id>` and export
`PHONE_HOLD_OWNER=<session-id>` for every `ph` call and runner. Release it with
`ph hold release`, including on cancellation or failure. ph refreshes it on every
call; use `ph hold refresh` through long OTP/reply waits. ph archives it after
its agent exits or 30 minutes without a refresh. Check `ph hold status`.
Exit 5 means yield; never loop or delete another task's claim.
`R="perl -e 'alarm 90; exec @ARGV' ~/.local/android/venv/bin/python -u ~/.config/opencode/skills/productivity/android-phone/scripts/jevrun.py"`,
`P=~/.config/opencode/skills/productivity/android-phone/plans`. jevrun blocks taps on Choose Lux/Comfort/…,
Book trip, Unconfirm/Cancel trip, tips, star ratings, and ids order_selection_request_button /
ub__smart_trip_cancel_action_button / ub__sobriety_confirm_button / button_next. New step types: `{"print":"regex"}`
prints matching labels (`  | …`), `{"shot":"name"}` saves a unique screenshot (path printed as `SHOT …-s.png`).

| Plan | Command | Ends on | Measured (warm phone) |
|---|---|---|---|
| a) book → review | `$R $P/uber-ride-review.json Home "Banyan Tree Residences" Gym "ARKHE Club"` (args: pickup query, pickup row, dropoff query, dropoff row; venue pickup e.g. `"Mr. Brisket Motor City" "Mr. Brisket"`; address dropoff: type it and give a row substring) | "Choose a trip": prints `Home to Gym`, `selected,Lux,Fare AED …`, `Mastercard ••••2342`, `Choose Lux` + SHOT `uber-review-*` | **28.4 s** (30 s wall), exit 0, 5 Oct 00:01 (AED 70.96). First try failed verify by tapping an already-selected Lux row (fixed) |
| b) active trip status | `$R $P/uber-trip-status.json` | prints driver/plate/car (`Vehicle number plate – L69721, Grey BMW 7-series. Driver name – Mustaq`), `… is arriving now` / `Drop-off at HH:MM`, then Trip details `AED…`, `Mastercard ••••2342`, `HH:MM drop-off`; closes the sheet. No trip → prints only `Where to?` | **11.1 s** (12.6 s wall), no active trip at run time. Trip-sheet ids were verified by hand during the 4 Oct trip |
| c1) wallet list | `$R $P/uber-wallet-list.json` | prints `Mastercard ••••7896 (Wio)`, `Mastercard ••••2342`, `Cash`, `Personal` | **10.4–10.5 s** (11 s wall), 2 runs |
| c2) remove card | `$R $P/uber-wallet-remove.json 7412` (last 4) | the "Remove payment method / Are you sure…? Delete / Cancel" dialog, after verifying `••••LAST4` on the card page; SHOT `uber-remove-confirm-*` | **17.3 s** (18 s wall). Then task model: `ph ui \| grep -q "••••LAST4" && ph tap Delete`, re-run c1. Never 5542 |

Booking after (a), task model only and only when asked: check the SHOT/printed lines (route header,
selected Lux, 2342), `ph tap id=order_selection_request_button`, then handle confirm pick-up spot
(id=confirm_button) → "Confirm new fare" (id=ub__sobriety_confirm_button) → "Is this trip for
someone else?" Me → id=button_next "Book trip", and read the driver with (b). Expected end-to-end
≈ 30 s plan + ~15 s confirms + driver match.
- Wallet history: 7412 "(Marriot)" (not the real card) DELETED 4 Oct 23:59 after the trip ended. Wallet now =
  7896 (Wio), **2342** (default, Personal profile "Default payment method is MasterCard ending with 2342"), Cash.
- Trip-end check without touching the UI: `adb -s 002473611000997 shell dumpsys notification --noredact | grep -A40 pkg=com.ubercab | grep android.text=`,
  or the home screen losing its "Drop-off HH:MM"/"arriving" banner. No rating sheet appeared after the 4 Oct trip.
- Don't run (b) with the "Plan your trip" screen open; it restarts the app for that reason (an earlier no-restart version tapped a "Home" place row).

## Ride for someone else (e.g. Moni) — rider switch (learned 4 Oct 2026, dry run, nothing booked)
Separate section; the book/status/wallet plans above belong to the other workstream.
- **Moni is already a saved Uber rider**: Account → Contacts ("Manage all your contacts at Uber")
  lists "Moni" (+971 58 593 ••13) and "Dylan". No need to add her. "Add new contact" exists in the
  Switch rider sheet for anyone else. Her contact page also has "Book a trip", "Add to family" and
  safety toggles (Share trip location is 21:00–05:00 only; leave as is).
- **No second ride while one is active.** During Abdullah's live trip EVERY entry point (Where to?,
  Later/Schedule, Add trip, Reserve, the contact's "Book a trip", and the `uber://` deep link) showed
  the "Currently unavailable" sheet: "Service you requested is unavailable while you are on a trip.
  Wait for the trip to end before proceeding ahead." (OK button). Workarounds: wait for drop-off
  (poll `ph ui` for "Heading to"/"Drop-off" to disappear, then skip the "Rate your trip" sheet with
  id=ub__skip_button_v2, no tip or rating), or ask whoever wants the ride whether to book it through
  another app/account (Moni decides that for her own ride; she's an admin, no need to ask him). Don't cancel the active trip.
- Flow (manual): Where to? → "Plan your trip". On the first open after a trip, the **Switch rider**
  sheet popped up by itself; otherwise tap the rider pill id=pill_button_guest ("For me", desc
  "Rider: For me. Switch rider"). Sheet: contacts with id=action_radio, then Me, "Send a ride"
  (voucher, NEW), "Add new contact", id=button_done (the keyboard hides Me/Done, so dismiss it
  first). Tap "Moni" → Done → the pill reads "Moni" (desc "Rider: Moni. Switch rider"). Then set
  pickup/dropoff as in the booking flow → "Choose a trip" (selected,Lux, Mastercard ••••2342) →
  `Choose Lux` = REQUEST (task model only, when asked).
- **Who pays:** the requester. The payment bar stays on Abdullah's Personal profile Mastercard
  ••••2342; the rider doesn't need an Uber account. Uber says it texts the rider the driver details
  and a tracking link; that wasn't observed (nothing was booked), so after a real booking still send
  Moni the live ride card yourself (`references/booking-card.md`).
- **Card first (owner, 9 Oct, updated 22 Oct 2026):** the moment `tripUuid` exists (or, on the phone
  fallback, the moment a driver shows), your very next action is `ride-card send` (meta + refresh
  first), before screenshots, fare checks or destination edits. On 9 Oct Moni waited many minutes
  and had to ask "What number plate". The card fills the plate itself. If a rider asks for the plate,
  read the exact current trip (`uber-ride --trip UUID`) and answer from it.
- Pickup = her location: run `location --session <id> --chat moni` (or `location-request --chat moni`) and type that address or
  venue as the pickup query. If her location is home, use "Home". If she says "where you
  dropped me", use the last completed trip's exact drop-off pin (step 4 exception above).
- **Plan** (fast, stops before Request):
  `PHONE_HOLD_OWNER="YOUR_OWN_CONFIRMED_HOLD_TOKEN" perl -e 'alarm 120; exec @ARGV'
  ~/.local/android/venv/bin/python -u ~/.config/opencode/skills/productivity/android-phone/scripts/jevrun.py
  ~/.config/opencode/skills/productivity/android-phone/plans/uber-ride-for-rider.json
  Moni Home "Home, Banyan Tree" Gym "Gym, ARKHE"`
  Args: rider, pickup query, pickup row, dropoff query, dropoff row. Ends on "Choose a trip" with a
  printed summary plus SHOT `uber-rider-review-*.png`. Measured on 4 Oct: **48 s, exit 0**, 1 Jev
  step ($0.00008). Then the task model checks with `ph ui`: the pill desc says "Rider: Moni" (tap Back
  once to see it), "Home to Gym", "selected,Lux" and "Mastercard ••••2342" before tapping
  id=order_selection_request_button. After Request expect the confirm-pickup/fare screens, and the
  "Is this trip for someone else?" sheet (pick Moni, not Me) → "Book trip".
- Plan gotcha: don't tap the "Lux," row when it's already selected. Tapping it again opens a
  "Confirm details" card instead (the first test run failed verify that way).

## Driver details: verify before sending (2026-10-09 incident)
Only send the rider car/plate/driver read from FRESH `uber rides status --json` bound to the CURRENT trip UUID, or a fresh native screenshot/UI dump after assignment. Never reuse earlier text, trips history or a stale dump. On 9 Oct Moni got the morning's driver instead of the real one. Coordinators answering "same driver?" must read the verified current trip, never their own notes.
