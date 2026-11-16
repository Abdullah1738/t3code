---
name: android-phone
description: "Use to drive Abdullah's own Android phone (Nothing Phone 3a Lite, USB-plugged into this Mac) via ph (ADB + uiautomator2) and the fast plan+Jev runner (jevrun.py) - apps, UI tree, taps, OTP logins, installs, Amazon.ae. Phone is fallback for CLI-ordered delivery (noon commerce CLI comes first) and home of app-only flows. Never Talabat (retired 2026-11-07)."
---

# Android phone (local, USB)

## TEMPORARY: the phone has a screen-lock PIN, 1234 (owner, 14 Nov 2026)

**Read this first.** For TorSSH's App lock test (board-torssh #21, scenario 18), the owner asked for a temporary screen-lock **PIN `1234`** on this phone ("Set a temporary pin in my phone, put it as 1234 and make it known on agent instructions"). It's also in the login Keychain as `nothing-phone-temp-pin` / `ardud`.
- If the phone shows a lock screen or a "Confirm your PIN" or credential prompt, enter `1234`. Don't stop and don't ask the owner.
- Don't change or remove the PIN yourself, unless you're the TorSSH #21 worker finishing the test.
- **Removal order (TorSSH #21 only):** turn **off** TorSSH's App lock in TorSSH Settings → remove the screen lock (Settings → Security → Screen lock → None) → tell the TorSSH evaluator, who deletes this section and the Keychain item.
- Delete this section as soon as the PIN is removed.

## Repeat orders: use the saved recipe first

Read `../../app-api-search/reorders.md` BEFORE phone discovery for known orders.
It has Bia's syringe basket (new noon/Careem source still to be found; Talabat is
retired) and Moni's noon sponge basket, expected totals, search terms and checkout
controls.

**Talabat retired (owner, 2026-11-07):** never open, drive or log in to the
Talabat app (`com.talabat`), for Abdullah or Moni. `jevrun.py` refuses Talabat
plans (`TALABAT_RETIRED`, exit 6) and the old `talabat-*.json` plans are archived
in `~/.config/opencode/retired-skills/talabat/android-plans/`.
Rehearsed Minutes search exists: `noon-minutes-search.json`; use it beyond the
open plan. New combined sponge/pharmacy-open plans are drafts, explicitly marked
in `plans/COVERAGE.md`; don't describe them as live-trained.

## Always start delivery tracking

7 Oct update: app-api-search has the current reliability/reconciliation workflow.
Read-only `com.ardud.delivery-notifications` journals pushes every 15s and yields
to priority-hold. Do not clear notifications for testing. Amazon tracking is
allowed via email, with Gmail/Moni Inbox fallback and one-day search overlap;
checkout/search remains app-only. "Delivered" email is shipment-scoped, so never
close a multi-package order after the first parcel. Send arrival-only updates;
do not ask for the actual arrival time. If Abdullah volunteers it, record with
`order-watch reconcile --app amazon --order ID --reported-at ISO_WITH_TIMEZONE`. SMS on `ph sms` is Mac
forwarded Messages, not a phone-side notification archive.

After placing any noon/Careem/Amazon order for Abdullah or Moni, run
`order-watch add --app noon|careem|amazon --order ORDER_ID --for owner|moni
--placed-at ISO_WITH_TIMEZONE --eta LATEST_ETA_ISO --label "store/items"` (choose
one app and recipient). Read-only tracking is an exception to Amazon's no-search/
order-CLI rule: it uses email and Android notification evidence only.
Add `--single-active-order` only after confirming no other active order/service
can explain that app's pushes. ID-less pushes are unconfirmed, never delivery proof.
`order-track --app APP --order ID` reads status. See `app-api-search` for routing.
Always register before reporting checkout completion; never promise tracking
without a successful watcher add/test. Notification dumps are read-only and do
not acquire the phone UI lock; UI fallbacks must respect priority-hold.

## Request-first delivery policy (updated 2026-10-11)

Fulfil requests using the default iMessage-thread model; only building/fixing
tools and skills uses `opus/gpt-6-astra`. Provider-block fallback still applies.
Requests from Abdullah/Moni preempt builds. Background build work stays off-device
while priority-hold exists and checks it before every phone batch. Never remove
another task's hold. Request agents record their session ID in the hold, refresh
it, and release only if still its owner. Do not assume a stale hold is free without
checking its owner.

Delivery ordering is CLI first (owner rule, 2026-10-11): noon
(Minutes/NowNow/Main/Supermall) orders go
through the `commerce` CLI lanes — see the `noon` skill for syntax
and guards; those lanes register the order-watch tracker themselves. Use the
phone (Jev + `jevrun.py`, task model verifies final checkout) for: baskets the
CLI lanes cannot express, Careem ordering/account actions, Amazon
(**app-only; no Amazon search/order CLI**), and safe pre-financial CLI failures
or unsupported features — say which path you used and why. An ambiguous
place/payment must be reconciled before any replacement phone checkout; an
error or local release does not prove no order/no charge. For every delivery: mandatory **leave at door;
don't ring bell; don't call** via all supported toggles and rider notes.
Amazon: inspect selected address's delivery instructions / delivery
preferences; exact current toggle locations are unverified. Read back before
pay, and register `order-watch` BEFORE reporting success on phone-placed
orders. Basket preference: fewest orders, then ETA, then total including fees.
Amazon availability, price and delivery fee come only from the logged-in app
(name the source in the reply). A logged-out web page is not evidence: on 14 Oct
it showed Method Wild Rhubarb "unavailable" when the app had it. Moni orders
(any app): her explicit go first, then register `order-watch add --for moni ...`
right after placement; it texts her what + ETA once in her Robob thread (check the receipt
says `moni_notified: sent` before reporting success, don't text her twice). Full
rules at the top of `noon`/`careem`.
Uber rides also use the `uber` CLI first; load `uber`/`rides`. CLI-only work
does not take the phone UI hold. Take your own hold only for actual app fallback.

Abdullah's dedicated automation phone replaced the Mobilerun cloud phone on 2026-09-30. It is a **Nothing Phone (3a) Lite**
(model A001T, serial `002473611000997`, Android 15, 1080x2392). It stays plugged into this Mac over USB, sits at home
(so GPS ≈ Banyantree JLT). Do NOT assume it is awake/unlocked: on 4 Oct it was
Dozing with keyguard showing, despite stay-awake=7; USB battery charging reported
false. Verify wakefulness/keyguard before navigation. Google account: surprisedwarrior@gmail.com.
Everything runs locally: no cloud and no third party sees the screen or the data.

Installed and **logged in** (2026-09-30):

| App | Package | Account |
|---|---|---|
| noon | com.noon.buyerapp | email abdullahrangoonwala@icloud.com (name "Hala") |
| (retired 2026-11-07: never use) Talabat | com.talabat | - |
| Careem | com.careem.acma | +971585134795 (Abdullah Rangoonwala), logged in 2026-10-02; Food/Quik/Box only (rides moved to Uber 2026-10-04), see `careem` skill |
| Uber | com.ubercab | +971585134795 (Abdullah Rangoonwala, existing account), installed+logged in 2026-10-04; default rides = **Lux**, card 2342, see `uber` skill |
| Wheely | com.wheely.wheely | +971585134795 |
| Amazon.ae | com.amazon.mShop.android.shopping | +971585134795 |

Addresses and payment cards are account-level, so they carried over from the old device. Still verify them on every checkout.

## Speed rules (read first; learned 2026-09-30)

**Plan-first applies beyond opening the app.** Search, customization, notes, cart edits,
delivery options and account navigation each continue through saved or newly written
plans. A missing saved plan is a reason to write one, not to revert to tap-by-tap.
Manual input is recovery after a plan fails (exit 2/3/4); state reads and the task
model's final checkout verification remain mandatory. Read `plans/COVERAGE.md`
for actual validated routes, preconditions and gaps; a generic template is not
evidence that every workflow is trained. Read-only catalog lookups use
`app-api-search` APIs, without phone verification; Amazon remains app-only.
`ph` and the runner exit 5 (PHONE_BUSY) when another task holds the phone:
yield without retrying in a loop. Request tasks export `PHONE_HOLD_OWNER` as
their exact hold token for every `ph` call and runner. Background training uses
`ph lease run --owner <card-or-thread-id> --purpose "training" -- <cmd>`.
Runs also acquire an automatic `jevrun.lock` flock, released on process exit.

Persistent tree reads are often <1s, but repeated standalone ph calls measured
~3s each on 4 Oct. Model turns and sleeps add further latency. Only for an
explicit Careem ride request, use `../careem/scripts/ride.py` (see rides): one persistent connection,
explicit pickup/dropoff, ~22–25s to checkout, task-model final verification.
Check conflicting hold once; report blocker within 10s instead of researching
it for minutes. Never bypass another holder. Parent releases a cancelled child's
matching hold. Never copy an unknown holder into PHONE_HOLD_OWNER.
1. **Navigation = one plan run, not one `ph` call per turn.** Use an existing plan in `plans/` (table below), or write a quick plan JSON in $TMPDIR and run it with `scripts/jevrun.py`. Take over with `ph` only on HANDBACK (exit 2) and for the final check.
2. **Chain `ph` calls in a single shell command** (`ph tap X; ph wait "Y" 8; ph ui | head -30`). Use `ph wait "text"` instead of `sleep N`.
3. Tap by `id=` or exact text. Use `ph shot` only when the tree can't answer (images, maps).
4. **Unavailable = say so immediately.** If a search shows "No results found" or the item isn't on the menu, tell Abdullah it's unavailable. Don't hunt synonyms or second-guess (owner rule).
5. Pop-ups/upsells (noon One, Yango Plus, "7-Day Challenge", review prompts): close them with their Close/No thanks button or Back. Never accept them.
6. The final safety check is always yours, never Jev's: read `ph ui` on the checkout/Request screen and verify the address (Banyantree), card 9546 for noon (2342 explicit fallback), 2342 for Uber/Amazon, items/class and total, then tap Place order/Request only if Abdullah asked.
Before final Pay/Place order/Request, read the on-screen last four and run `card-status assert-final MERCHANT LAST4` (noon 2342 needs `--fallback` only after failure/decline and safe reconciliation); after a payment-method change, record it with `card-status merchant set MERCHANT LAST4 --source "<how known>"`, settle open invoices within existing authorization, and set a 24-hour check.

### Ready-made plans (`~/.config/opencode/skills/productivity/android-phone/plans/`)

Run: `~/.local/android/venv/bin/python -u ~/.config/opencode/skills/productivity/android-phone/scripts/jevrun.py PLAN.json [arg1 arg2 ...]` (args fill `{1}`, `{2}` in the plan). Wrap it in `perl -e 'alarm 90; exec @ARGV' ...` and keep `-u`.
This alarm wrapper is for phone plans, **never for `commerce`**: an inherited
SIGALRM breaks commerce's native deadlines. Use the shell tool's timeout there.

| Plan | Args | Ends on | Measured |
|---|---|---|---|
| (obsolete: Yango uninstalled 2026-10-02) `yango-home-to-gym.json` | - | Yango final Request screen, Home → Silverene Tower A, Élite, 5542 (verify step built in) | 19-22 s cold, 3/3 runs |
| `noon-nownow-search.json` | product | NowNow search results (then `ph tap` the item's ADD → id=nownow_view_cart_btn) | ~20 s cold |
| `uber-ride-review.json` | pickup query, pickup row, dropoff query, dropoff row | Uber "Choose a trip" with Lux + 2342 verified, summary printed + SHOT (task model taps Request) | 28 s cold |
| `uber-trip-status.json` / `uber-wallet-list.json` / `uber-wallet-remove.json` | - / - / last4 | trip driver+plate+ETA+fare / wallet cards / Delete dialog | 11 / 10 / 17 s |

Write a new plan when a flow will repeat. Use deterministic `tap`/`key`/`wait` steps where ids are known (0 Jev cost, fastest) and `jev` steps where the screen varies. Save it in `plans/` and add a row to this table.

## `ph`, the CLI (fast: reads the accessibility tree, ~0.1 s, no screenshots needed)

```bash
ph ui                 # on-screen elements: [i] 'label' (x,y) flags(E=edit C=clickable ✓=selected) id=RID ; header "== app=PKG at=HHhMMmSSs"
ph ui -a              # include status bar/system UI
ph tap "Continue"     # tap by text/desc (exact match first, then substring); ph tap "Add" 2 = 3rd match
ph tap id=search_bar  # tap by resource-id
ph tap 540 1200       # coordinates (1080x2392)
ph type "biryani" [--clear]   # types into the focused field (tap the field first)
ph key back|home|enter|recent|del
ph swipe up           # scroll down the page (up = content moves up)
ph wait "Place order" 20      # wait for text; exit 1 on timeout
ph open PKG | ph stop PKG
ph url "market://details?id=PKG" com.android.vending   # deep link, optional target package
ph shot NAME          # screenshot -> $PH_TMP/NAME-<ts>.png + 540w -s.png copy (Read the -s.png). Only when the tree isn't enough (images, maps, visual checks)
ph sms [n]            # last n incoming SMS/iMessages on the Mac (chat.db): OTP codes land here
ph cur (dumpsys, ~0.1 s) | ph wake | ph sh CMD
```

- The wrapper is `/opt/homebrew/bin/ph`, a sh script that execs `~/.local/android/venv/bin/python scripts/ph.py`. Don't symlink ph.py directly: a direct exec hangs in dyld because of the provenance xattr.
- Env vars: `PH_SERIAL`, `PH_TMP` (default `…/T/opencode/phone`), `PH_TIMEOUT` (45 s per call). Read commands retry once. An action that may have been sent exits 4 (`MAYBE_SENT`): run `ph ui` and check before repeating; never blind-repeat a pay/confirm tap. Drops go to `~/.local/state/ph/events.jsonl`; read them with `ph log`.
- adb lives at `~/.local/android/platform-tools` and is symlinked into /opt/homebrew/bin. The venv at `~/.local/android/venv` is uv-managed (uiautomator2). Install packages with `uv pip install --python ~/.local/android/venv/bin/python X`; plain pip hangs.
- macOS has no `timeout`. Wrap risky adb calls: `perl -e 'alarm 30; exec @ARGV' adb shell ...`.
- Chain steps in one shell call: `ph tap "X"; sleep 2; ph ui | head -30`. Always look at the fresh `ph ui` (check the `at=` time) before the next tap.
- Many apps obfuscate their ids, so tap by visible text where you can.

## Rules

- **Never place orders, pay, book, tip, or subscribe unless Abdullah explicitly says to in this conversation.** Browsing, carts, prices, and tracking are fine.
- **Address: always the saved Banyantree Residences Hillside (JLT, Flat 2104). Payment: noon uses saved Mashreq 9546 by default, Marriott 2342 only as explicit fallback after failure/decline and safe reconciliation; Uber/Amazon stay on 2342.** Verify both on the final screen before any Place order/Request. Never use cash, wallet-only, another card, HDS/Work, or a GPS/"Other" pin. If either is missing, stop and ask; don't add new ones.
- Act only on fresh state. Re-run `ph ui` after every action. If the app is logged out or behaving unexpectedly during a booking or order, stop and text Abdullah. Don't blind-tap.
- Don't log out of apps, factory reset, or change Google account settings on the phone.
- The phone's own SIM/number isn't used. Codes go to Abdullah's +971585134795, which forwards SMS to the Mac.

## Logins (do them yourself; don't ask Abdullah unless a code doesn't arrive within ~1 min)

SMS codes appear in `ph sms` within about 10 s. Don't loop on Resend, because each resend kills the previous code.
- **noon**: phone login is not supported. Country UAE → Continue, location Skip, onboarding Skip. Then Account tab → Login/Sign up → email field → `abdullahrangoonwala@icloud.com` → CONTINUE. The OTP arrives in iCloud mail: `himalaya envelope list -a icloud -m Inbox -s 4` (subject "NNNNNN is the OTP for your noon account verification"). `ph type CODE`.
- **Yango**: phone field → `585134795` → Log in → Continue → passkey sheet: Dismiss → "Face ID login failed": **Send OTP** → SMS "<#>Your confirmation code: NNNNNN" → `ph type` → pick the account "Abdullah Rangoonwala".
- **Uber**: type `+971585134795` in id=PHONE_NUMBER (UAE auto-detected) → Continue → SMS "[Uber] Your code: NNNN" → id=PHONE_SMS_OTP-0 → then a 4-digit email code to iCloud (subject "Do not share: NNNN") → id=EMAIL_OTP_CODE-0.
- **Wheely**: Experience Wheely → the country code defaults to +44/+1, so tap it and pick United Arab Emirates → phone field → `585134795` → CONTINUE → SMS "Welcome to Wheely. Your code is NNNNNN" → `ph type`.
- **Amazon.ae**: Already a customer? Sign in → id=ap_email_login → `+971585134795` → Continue → the OTP defaults to WhatsApp, so tap **Send OTP by SMS** → id=cvf-input-code → type → Verify. A second code is emailed to surprisedwarrior@gmail.com: `himalaya envelope list -a gmail -s 4`, subject "amazon.ae: Sign-in attempt", then `himalaya message read -a gmail ID | grep -oE '\b[0-9]{6}\b'` → id=input-box-otp → Submit code.

## Installing apps

`ph url "market://details?id=PKG" com.android.vending; ph wait Install; ph tap Install`, then poll `ph sh pm list packages -3`.
Grant permissions up front: `ph sh pm grant PKG android.permission.ACCESS_FINE_LOCATION` (also COARSE_LOCATION and POST_NOTIFICATIONS).

## Phone setup (already done; redo if the phone is ever reset)

- Developer options: USB debugging on, and "Always allow from this computer" accepted.
- Power (changed 2026-10-06): the Mac's USB port only gives ~0.5A, which can't keep up with the screen on, so the phone drained to 0% twice while 'charging'. Now `stay_on_while_plugged_in 0`, `screen_off_timeout 60000`, brightness manual 1. Always `ph wake` (and check keyguard) before phone work. Check `dumpsys battery | grep level` first; below ~15% let it charge. Animation scales 0.5.
- Fully muted (2026-09-30): ringer SILENT, media/notification/system/ring/alarm volume 0, DND = Total silence (`cmd notification set_dnd none`, zen_mode 2), vibration + haptics off, dial pad/lock/charging/screenshot sounds off. Media volume only drops via `input keyevent 25` repeats (`cmd media_session volume --set` is ignored). Keep it silent.
- Location on (Google Location Accuracy "Turn on"). Timezone Asia/Dubai.
- Battery: leave the apps unrestricted if Nothing OS starts killing background apps.

## Live view for Abdullah (scrcpy)

- `phone` (at /opt/homebrew/bin/phone) opens a live mirror window titled "AgentPhone". It is view-only (`--no-control`), so his mouse can't interfere. `phone -c` gives full control. Any other args go straight to scrcpy, e.g. `phone --record=/tmp/run.mp4`.
- scrcpy v4.1 lives at ~/.local/android/scrcpy (a symlink to the release dir; ADB=/opt/homebrew/bin/adb). Don't use `brew install scrcpy`, because brew hangs on this Mac.
- The mirror runs alongside `ph`/uiautomator2 without conflict. If he asks to "show me" or watch, launch it with `(phone >/tmp/phone.log 2>&1 &)`.

## Maintenance

- Phone unreachable: run `ph doctor` (or `--json`) first. It's read-only, under 15 s, and returns `ok`, `unauthorized`, `offline`, `usb_mode` or `not_connected`, plus the exact one-line ask for Abdullah (`ask_owner`). Exit 0 means ok. `usb_mode` means it's plugged in but not in a debugging USB mode. On 21 Oct it sat in MIDI mode and a fallback order waited about 20 min until he switched it. Send him the ask right away, with no other debugging first (nightly 2026-10-22).
- `adb devices` shows nothing: check the cable/port, then `adb kill-server; adb devices`. If the phone prompts, accept the RSA prompt on it (ask Abdullah).
- Read failures reconnect once; `MAYBE_SENT` (exit 4) resets u2 but never repeats the action. Check `ph ui` before repeating, especially pay/confirm taps. Use `ph log` for drop events and evidence.

Direct-u2 scripts (`d(text=...).click()`, `.exists`, `.wait()` via objInfo/waitForExists) bypass this protection. On `RemoteDisconnected`/`ConnectionError`, run `ph note-drop --source <caller> --cmd <verb> --exc <type> [--msg <message>] [--phase read|action]`, reconnect, then re-read the screen before repeating an action. Drops are most common after IME switches or system dialogs (BiometricPrompt, Copy). For visible keyboard keys, prefer adb taps on fresh key bounds over `d.send_keys`, which swaps the IME.

## Fast mode: plan + Jev runner (`scripts/jevrun.py`)

For multi-step navigation, write a short plan JSON and run it in one call instead of one `ph` call per LLM turn:
`~/.local/android/venv/bin/python -u scripts/jevrun.py plans/yango-home-to-gym.json` (the example plan reaches Yango's final "Request" screen from a cold start in ~29 s; the old way took minutes).
- Plan: `{"app":PKG,"restart":true,"ready":"text","steps":[{"jev":"sub-goal"},{"type":"text"},{"verify":["a","b"]}]}`.
- For each `jev` step it sends one Jev `choice` request (~0.4 s, keep-alive session) over the indexed on-screen elements plus BACK/WAIT/NONE. It auto-taps only when p≥0.55 and the margin is ≥0.2; a parent and child on the same row count as one choice. Before tapping it checks the target is still on screen, then waits until the label set changes and is stable (so map motion is ignored).
- `type` reads the field back afterwards, and `verify` does substring checks. Exit codes: 2 = HANDBACK (unsure: take over with `ph ui`), 3 = typing failed, 4 = verify failed.
- It **never taps** Request/Order/Book/Pay/Place order/Confirm/Unlock/Subscribe. The final check (address, card 2342, class/items, total) and the actual order tap stay with the agent via `ph ui`.
- Where the time goes: Jev ~0.4 s/step and uiautomator dump ~0.35 s on map screens, but most of it is the app's own loading/animation (settle 1.5–4 s/step).

- Step types: `{"print":"regex","optional":bool}` (print matching labels), `{"shot":"name"}` (unique screenshot, prints path), `{"jev":"sub-goal"}`, `{"type":"text","field":"optional label substring"}`, `{"tap":"id=RID"|"text","optional":true,"secs":4}` (deterministic), `{"key":"enter"}`, `{"wait":"text","secs":8}`, `{"verify":[...]}`. `ready` can be a string or a list. Extra CLI args fill `{1}`, `{2}`...
- Robustness (2026-09-30): low-confidence decisions re-read the screen up to 5 times before HANDBACK (most are still-loading screens); `verify` retries for 4 s; a stale uiautomator server is killed and reconnected automatically. Always end ordering plans with a `verify` step, because Jev occasionally says DONE too early.
- For typing into a specific field, prefer `{"type":"...","field":"Destination"}` over a Jev 'tap the field' step (deterministic, and it taps the field if it isn't focused).
- Unlabeled clickable nodes get their resource-id as the label (e.g. "nownow search bar"), so Jev can see icon-only buttons.
- 2026-09-30 additions: plan `activity` (explicit launch activity); Jev choice `DONE` skips a step already satisfied; `{type}` auto-taps the input field if none is focused (optional `field` substring). Stale-target re-decides are normal on screens with popups.

## Never delegate phone work to a subagent (owner rule, 2026-09-30)

**The main agent drives the phone itself**, in one shell call (plan + `ph ui | grep` check + force-stop). Don't spawn subagents or other models for phone runs, and don't suggest it. Benchmarked on the Yango home→gym plan: the direct run took ~20 s. Every delegated run was slower: Sonnet 29 s, Luna high 52-72 s, Luna low ~105 s. The runner takes ~20 s whoever calls it, so delegating only adds model turn latency.
- Flaky pick seen once: Yango step 4 chose 'Tower A Silverene Tower A, Silverene Towers…' and the final verify reported `missing=['Tower A']`. The verify step catches it. On any `missing=` the agent must fix the destination by hand (or rerun the plan) before reporting ready.

## Shared phone: priority hold (owner rule 2026-10-02)

**Cancellation/steering cleanup is immediate:** when a task is cancelled,
superseded, or steered away from phone work, stop its pending phone inputs and
release `~/.local/share/phone-lock/priority-hold` immediately if (and only if)
the contents still match that task's recorded owner token. Do this before the
reply or unrelated work, not at the old task's natural end. Use a `finally`/shell
EXIT/INT/TERM cleanup for owned holds on failure as well. If an interrupted child
cannot run cleanup, its parent must stop that child's phone process and release
only the confirmed matching child's hold. Never remove another live task's hold,
copy its token into PHONE_HOLD_OWNER, or reclaim based on age alone. Check release
by readback (absent or a different owner's new hold), without deleting a successor.

`ph` enforces priority holds and leases (exit 5, PHONE_BUSY). Under another
request's hold, every device command is refused, including reads.
- Request tasks: acquire the hold exclusively with their session ID (shell
  noclobber), export `PHONE_HOLD_OWNER` as that exact token for every `ph` call
  and runner, refresh its mtime, and release only their matching hold on exit.
- Background/long phone jobs (QA, captures, training): use
  `ph lease run --owner <card-or-thread-id> --purpose "<short>" -- <cmd>`, or
  `ph lease acquire`, `refresh`, and `release`. Direct uiautomator2/adb scripts
  must run under a lease or own the priority hold. Request holds outrank leases;
  expired leases are free. A hold's age alone never grants access: check its
  owner/session liveness.
- `ph lease status` shows the claim. Without a lease or hold, actions may
  interleave with another agent's. Exit 5 means yield: never retry in a loop,
  copy another holder's token, or delete another task's lease or hold.
- Proxy gotcha: deleting `http_proxy` (reads null) can leave a cached dead proxy (127.0.0.1:18089) so apps show "no internet". Clear explicitly with `adb shell settings put global http_proxy :0` and leave it at `:0`.
- Phone serial 002473611000997 (always pass -s). Local emulators are blocked since 2026-10-09 (Run Cloud via the `run-cloud` skill instead), so this phone should be the only adb device.
