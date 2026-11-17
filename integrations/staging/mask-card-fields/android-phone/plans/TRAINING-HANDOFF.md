# Phone training handoff — 2026-10-03 19:33 Dubai

> Talabat retired (owner, 2026-11-07): every Talabat line below is history only. The Talabat plans are archived in `~/.config/opencode/retired-skills/talabat/android-plans/` and `jevrun.py` refuses `com.talabat`.


## Latest third pass — 22:45 Dubai

Read COVERAGE.md's new top section. Substantial gaps closed with two clean runs:
Amazon add/checkout/cleanup, tracking delivered package, preferences editor,
return-reason navigation; Careem Food/Shops checkout/cleanup, Box category/chip
shortcut; Talabat pharmacy/flowers checkout/cleanup and visual no-bell/no-call
verification; noon Minutes/NowNow review; Wheely preferences/help/date scheduling.
All training items removed. Noon Minutes nine-item and NowNow Nothing AED1399
existing baskets preserved. No commitments or messages. No commit.

Latest phone state: Amazon shirt product lower page, Cart0. Variants unfinished:
AX selected-colour/size strings can remain stale even when screenshot changes.
OCR catches this, but first tap sometimes does not select; cold scroll_to Selected
color also failed. amazon-size-select passed once; combined variant route NOT
reliable. Do not count it trained. Wheely wheel movement works with fresh OCR
and summary readback; two full runs passed selecting5 Oct, then exit. Arbitrary
hour/minute selection remains untrained. Talabat chip verifier has two clean runs
for don't-ring=true/call=false only; leave-at-door is absent, not silently assumed.
Noon Food promo never reappeared. Main/Rocket/Food checkout remains pending.

Important new discoveries: Box delivery chips REPLACE free text; always restore
full instructions afterwards. Careem Plus quantity differs from lowercase plus
(Add more); runner exact-case preference fixed this. NowNow cleanup can reveal
another existing merchant cart; never assume the entire app should be empty.

New draft/inspection plans must be read against the coverage claims, not assumed
validated solely by existence. Test command: local Android venv Python
scripts/test_jevrun_guards.py (offline). OCR uses local tesseract, temp images deleted.
Final checks: 8 offline guard tests pass; all plan JSON parses and runner Python
syntax compiles. Coverage PNG regenerated at the original requested path.

Continuation completed a second partial pass. Read COVERAGE.md's Continuation
section first for accurate live results. Latest phone state: Amazon empty cart.
All training additions removed (Talabat pizza, Quik milk, Amazon toothpaste).
Noon nine-item basket untouched. No commitment actions or messages.

New runner typing fix: clear_text → settle/remount → refocus → send_keys without
clear. Noon same-query and changed-query searches now pass repeatedly. Four
offline guard tests pass. Explicit Place your order and Wheely final-ID block.
New plans cover Careem Box checkout/help, Profile/cards/addresses, Quik cart and
cleanup; Wheely history/destination/prebooking/scheduling review; Amazon checkout
and cleanup (first run worked, later add failed empty); Talabat quantity and Mart;
noon returns eligibility. Exact times and caveats in COVERAGE.md.

Next: investigate Amazon add retry failure; strengthen/revalidate corrected
verifiers; train Careem Food/Shops; Box category/chips; noon Food overlay and
other checkouts; Amazon variants/returns; remaining Talabat verticals. Many
workflows still missing. No commit; shared index remains unrelated staged work.

Historical first-pass notes follow.

Task is NOT complete. Owner requested every workflow of every app. Current
coverage is a useful first pass only; see COVERAGE.md for exact live results.

Root cause diagnosed: ordering session did use restaurant-open Jev in13.9s,
then skill explicitly switched to manual. Fixed wording and added Talabat
customization/item note/cart note/checkout/cleanup plans with actual live runs.

Runner changes active in-place: guarded deterministic taps, payment/Yalla/Buy
Now/send protection, process flock, request hold checks, wait failures,
full-label verification, scroll_to/swipe, guarded anchor offsets. Four offline
tests pass; independent read-only review resolved findings. Last small change
changed search Enter regex to substring to handle underscore resource IDs.

Latest phone state: noon Minutes search smetana. Re-running search plan on an
already-filled search field led to typing readback=MISSING. Inspect ph ui fresh
after checking priority hold. Do not reuse stale screen coordinates.

No orders/payments/rides/messages sent. Talabat training cart cleared and empty
text verified, twice; noon Minutes existing9-item cart NEVER modified.

No commits: ~/.config/opencode is hugely dirty, with3 unrelated staged files
(scripts/hermes-history.py, scripts/tests/test_history.py,
skills/session-history/SKILL.md),413 modified files. Preserve shared index.
Own files: scripts/jevrun.py, scripts/test_jevrun_guards.py, added plan JSONs and
COVERAGE.md under android-phone; small edits to android-phone/talabat/noon/
careem/app-api-search SKILL.md. Another worker concurrently updates API-only
wording in talabat/app-api-search; reread before editing and preserve its edits.

Output image exists at
/Users/ardud/.robob/imessage/2026-10-03/session-703e7e40-27b0-4377-8ef8-e931a7e04493/jev_coverage.png
(honest partial coverage graphic).

Next priorities:
1. Fix cold-start noon Food modal overlay (Deals for you, hidden close AX;
   Back dismisses) and Minutes existing-search repeatability.
2. Talabat visual delivery chips state (selected not reliably exposed in AX),
   quantity2 plan, address/payment/voucher selections, Mart/store verticals.
3. Careem Food/Quik/Shops cart/options/notes/delivery controls/cleanup; Box full
   pickup/dropoff/category checkout; history/help/account/other services.
4. Amazon variants/basket/checkout/delivery preferences/cleanup; history/help/
   returns (stop before submission), Wheely destination/prebooking/history.
5. Strengthen plan postconditions (some generic section templates only check
   passed text) and attach actual per-plan validation records.
6. Finish inventory matrix per subsection/workflow, regenerate PNG.

Run background phone work under `ph lease run --owner <card-or-thread-id>
--purpose "training" -- <cmd>` (one shell line), including direct uiautomator2/adb.
`ph lease status` shows the claim. Exit5 means yield without looping or deleting
another task's claim. Request holders export their exact `PHONE_HOLD_OWNER`
for every `ph` call and runner. jevrun also holds its own flock automatically.
No commitment taps, payments/bookings/messages. Clear only training additions.
