---
name: app-api-search
description: "Find items for Abdullah or Moni: noon and Careem search with images, visual picks, nutrition and price comparisons, plus broad web search for things the apps don't carry. Shopping lists, not baskets."
---

# Delivery search: images, baskets, visual picks and nutrition comparisons

## Talabat retired (owner, 2026-11-07)

Abdullah: "We will never use talabat again." No Talabat search, menus, ordering,
tracking or app fallback, for Abdullah or Moni, and don't offer it as an option.
`talabat-search`, `shop-search match talabat`, `talabat-auth` and every
`commerce ... talabat` command refuse with `TALABAT_RETIRED` (exit 5), and
`basket` no longer searches Talabat. Use noon and Careem (plus broad web search).

## Owner rules (2 Nov 2026): shopping lists, not baskets; search broadly

- Never build app carts or baskets ahead of time, for Abdullah or Moni. When one of them asks for a basket, write a durable **shopping list** instead (items, quantities, brand preferences). Keep the store generic, because stock and prices change before an order is placed. Pick the store and listing only when they give the go, then order from the list. For Moni, keep the list in `/Users/ardud/.robob/imessage/chats/moni/pending-orders.md`.
- When asked to find an item, look broadly: websites, specialist shops, brand sites, Amazon.ae, Instagram/WhatsApp shops and local stores (Perplexity/Exa/web), not just noon/Careem. Example: noon had no hookah bowls, but HookahMarket and S2B did.

## Delivery reliability update — 7 Oct 2026 (supersedes older tracking notes)

All app-api-cli source (catalog, commerce and tracking) lives in
`/Volumes/ExternalSSD/t3code-fork/integrations/app-api-cli/`; deploy changes with
`integrations/deploy.zsh app-api-cli` to `~/.local/share/app-api-cli`.
`com.ardud.delivery-notifications` journals
projected Android notifications every 15 seconds to
`~/.local/state/order-tracker/delivery.sqlite`; it yields to priority-hold and
never opens apps. `delivery-source-health` watches collector health and wakes
repair after failures. Polling can miss notifications cleared within 15 seconds;
phone offline/asleep-Mac gaps remain possible. No Android listener is installed.

ID-less delivery-window pushes now wake a verifier even without single-active
opt-in. They are NOT order delivery proof. Verify the specific order before
texting Moni; if ambiguous ask Abdullah. Arrival-only recipient texts; diagnostic
failures go to Abdullah. Amazon delivered emails prove a PACKAGE, not all items;
keep watching until all shipments are verified. Gmail and Moni Inbox fallback
uses himalaya; search starts one day before placement to avoid timezone/exclusive
after-date misses. Receipts are not delivery confirmations.

Do not ask Abdullah what time a delivery arrived or run `reconcile --asked`
(owner rule, 2026-10-11). Only if he volunteers the time, record with
`order-watch reconcile --app APP --order ID --reported-at ISO_WITH_TIMEZONE
--note "owner reported approximate time"`. The SQLite reconciliation table keeps
placement, first detection/source/evidence time, reported arrival and historical ask time;
the command returns `gap_seconds`. Never backdate discovery to a recovered push.
Today's Dunkin 3941245276 is logged as missed, reported ~13:24 Dubai; no invented
machine arrival time. `remove` now sanitizes inherited Bun inspector variables
and is idempotent, including stale local registrations.

## Known reorders: skip broad discovery

Read `reorders.md` first for Bia's syringes / Moni's sponges. The old syringe
source was a Talabat pharmacy branch; Talabat is retired (2026-11-07), so find
the syringes on noon or Careem (or a pharmacy site) and record the new source
in `reorders.md`. `scripts/reorder-catalog.py` was Talabat-only and is retired.

Use this skill for cross-app item/price/image search, convenience-first baskets,
visual product selection and calorie comparisons across noon and Careem.
Ordering is NOT done here: noon orders go through the `commerce` CLI
lanes first (see the `noon` skill); Careem and Amazon order in their
phone apps.

Commerce expansion (2026-10-11): all four noon order lanes accept many
items via `--items-file`; no local product-category, count/quantity or spending
policy caps. The caller owns user limits and authorization. `--prepare-only` on order commands mutates a cart and
verifies readback without placing/paying; it is NOT a catalog lookup. Search CLIs
remain read-only. Noon `commerce auth noon VERTICAL --recover` now offers bounded
same-account revalidation/peer-cookie adoption, not a claimed refresh-token grant.

## Model and scheduling policy

Use the default iMessage-thread model for searches/comparisons/orders, inline or
with default-model subagents. Build/fix tools and skills on `opus/gpt-6-astra`;
provider-block fallback remains Astra. Requests preempt builds; background phone
work checks priority-hold before every batch and yields without removing it.
Amazon remains phone-app-only, no CLI. Ordering on noon (Minutes/NowNow/Main/
Supermall) is `commerce` CLI first — see
the `noon` skill for lane syntax and guards; the CLI auto-registers
tracking. Jev + jevrun with a final task-model checkout check is the fallback
for CLI-unsupported baskets and all app-only flows, including leave at door /
don't ring bell / don't call on every phone checkout. Before any final pay/place
(CLI or phone), apply the conflict hold in the `noon`/`careem` HARD
RULES: re-read the requester's and Abdullah's latest messages; hold on conflict.

Search/compare subagents (13 Oct review: one took 68 calls and 1.5 h and crossed
an owner answer): cap the brief at ~20 tool calls, then return best results so
far. Before sending results to anyone, re-read the chat (`imsg history --chat-id
45` for Moni, plus the owner thread); drop or adjust anything already answered.

### Moni's option requests (13 Oct review)

- Send images in the FIRST reply (`--images-dir`, then the iMessage bridge
  `send-file`); she asked for pics 4-5 times on 13 Oct.
- No budget given: ask it first, in one line, before a broad search.
- Quote listing text verbatim (name, size, claims like "sugar free"); never
  paraphrase or upgrade product claims.
- Availability, price and fees: say where each number came from (guest search,
  authenticated quote, logged-in app). Quote fees as final only from the authenticated
  CLI quote or logged-in app cart. Never call something unavailable from a logged-out
  web check (14 Oct: Amazon "unavailable" was wrong; a 6.45 fee was really 13.45).
- Before offering a store as "ordering now", confirm it is open and delivering to
  Banyantree (`hours`/`--open`), and that it isn't on her exclusions list in
  `~/Documents/assistant/moni-prefs.md`. Search results are proposals: ordering
  needs her explicit go (see the Moni orders section in `noon`/`careem`).
- Product facts (nightly 2026-10-17): answer "does it detach / is it raw / what
  size" only from the listing or the maker's page, and say "from the listing" or
  "not stated on the listing". 16 Oct: a child said an iPad case keyboard "does NOT
  detach" without checking, which took 4 rounds. A Furchild freeze-dried vs raw
  mix-up cost 15 min. Confirm the exact variant before giving macros or feeding
  amounts.
- Don't re-ask what Abdullah already answered in the thread (16 Oct: Moni was asked
  "11 or 13 inch?" after he'd said it).
- (nightly 2026-10-22) When she asks you to decide, send one pick and one fallback,
  each checked against weight, size, how it mounts and arrival time, and mark listing
  claims you couldn't confirm. 22 Oct: "I'm not reviewing pls just make decision", then
  the phone stand was "so heavy and bulky" and "not acc MagSafe".
- A return is done only with a return reference and pickup slot; until then say what
  blocks it and the next date it can go. Her orders and returns don't need Abdullah's
  OK (his rule 22 Oct, see moni-prefs), but still need her request.

## Workflows

### Mandatory post-order tracking (2026-10-03)

After **every** Abdullah/Moni order, always register tracking:
`order-watch add --app noon|careem|amazon --order ID --for owner|moni
--placed-at ISO_WITH_TIMEZONE --eta LATEST_ETA_ISO --label "store/items"`.
Choose one app/recipient; use the latest ETA bound with Dubai `+04:00`.
Optional `--single-active-order` permits ID-less notification candidates only
when no other active order/service in that app can explain the push. Candidates
remain unconfirmed, especially Careem rides/Box and multiple noon verticals.
The helper primes and runs `robob-watch test`; report its initial status yourself.
`order-track --app APP --order ID` returns JSON status/evidence/ETA/rider;
`order-watch remove --app APP --order ID` closes tracking after delivery/cancellation.

Source: `app-api-cli/order_tracker.py`; runtime: `~/.local/state/order-tracker/`.
All four apps currently use exact-ID, sender-domain-filtered email (5-minute poll)
plus active Android pushes (60 seconds; read-only adb, no UI/lock/proxy).
Native tracking update (2026-10-04): `noon-search track ORDER_ID --json` and
`noon-search orders --minutes --page 1 --json` use verified authenticated Minutes
order APIs. IAEGA4148P7H5TWI1A returned delivered from both routes. `order-track`
now uses native evidence first, skipping mail/ADB when it gets a known stage.
`noon-search orders --json` also lists marketplace active/history item statuses;
marketplace history is first-page bounded, so `track` never certifies whole-order
completion from partial items. Active-order ETA enums and rider display remain
unverified; unknown stays unknown. (Talabat order tracking was retired with
Talabat on 2026-11-07.) `careem-search orders|track ID --json` still fail explicitly
with ACCOUNT_CAPTURE_REQUIRED_GUEST_CATALOG_ONLY: the Careem session remains
guest and no authenticated order endpoint is verified; email/push fallback
remains, and Careem ordering stays in the app (owner rule 2026-10-11).
Owner-approved capture was rechecked on 2026-10-04: both original apps deny
`run-as`, no `su` or debug WebView socket is available, and original Careem TLS
interception already failed. Do not treat capture approval as successful
bootstrap; see `app-api-cli/ORDER-TRACKING.md` for the blocker.
Amazon search/checkout stays app-only. Missing evidence = unknown, never delivered.
ETA is checkout-supplied unless a verified native field is available; rider data
is projected only when native showRiderDetails is true (otherwise null).
Some orders expose neither IDs in pushes nor status mail, so full stage coverage
cannot be guaranteed. The watcher wakes on new delivery stages, candidate changes,
problems or ETA+5 minutes without confirmation, and deduplicates repeated stages.
Tracking problems are deduped by error family (mailbox suffixes ignored), transient
read errors stay quiet until 3 in a row past the ETA, nothing fires while a stage is
delivered with a future ETA, and at most one problem wake per order per 24h.
`--for moni` also texts Moni the placement once (receipt JSON `tracker_id`,
`watcher_registered`, `moni_notified`; held until payment is confirmed;
`--no-placed-text` if you already told her; `--dry-run-text` to preview).
The arrival-time question to Abdullah is retired (don't ask).
Owner updates wake the saved owner iMessage session; Moni wakes instruct sending
to her Robob thread with `cli.ts send --to moni` (same key on retry, the bridge
dedupes; never Abdullah's imsg, owner rule 2026-10-21). Remove after confirmed delivered/cancelled.
No restaurant contact, cancellation or reorder is authorised by tracking.

**Read-only catalog policy (2026-10-03): API-only for noon/Careem
lookups. Do not launch the phone to verify prices, menus, stock or opening hours.**
Expose unknown account benefits/fees as unknown. Phone use is for requested
ordering/account actions or explicit tooling training; Amazon remains app-only.
Historical UI fallback descriptions below are not permission to invoke them for
ordinary catalog research. Saved ordering plans and honest validation coverage:
`../productivity/android-phone/plans/COVERAGE.md`.

- **Basket:** `basket milk eggs bread banana butter --json [--open] [--png FILE]`.
  Parallel native searches across Minutes/NowNow and Careem Quik/Shops
  (Talabat removed 2026-11-07). Rank full coverage by fewest orders, max ETA, then
  items plus delivery fees; unknown fees are never zero. `--open` excludes unknown
  status (including Minutes/Quik when unverified). Inspect sizes/variants/images;
  bounded catalog coverage and partial search failures are explicit.
  Default component deadline is8s; use `--timeout 30` for slower-store coverage.
  Shared cross-process
  token buckets/concurrency leases pace every native/public request and retry;
  full 429 Retry-After cooldowns persist across CLI calls. Short projected caches:
  listings120s, live status30s, branch identity60s, product results15s. Credentials
  never enter this cache. `coverage` reports selected/listed stores, completed vs
  planned product searches, status failures and deadline/backoff errors. Completed
  results survive partial failures. Bounded coverage is not an all-app price claim.
  Verified home five-item --open basket7.23s: Mart + Albaraka10/10 product searches,
  no product timeouts; Fly mart native status404 explicitly unknown/excluded.
  Full53-case live suite passed after pacing/batching (2026-10-03).
- **Visual pick:** search candidate drinks/items across apps in parallel with
  `--json --images-dir DIR`, then open the downloaded images and visually compare
  them yourself. For “matcha with cream inside the cup”, inspect the cream layer,
  not just the title. Menu photos are illustrative, not a guarantee of preparation.
- **Calorie compare:** while downloading candidates, use food-nutrition-lookup
  and exa for published nutrition and lower-calorie alternatives elsewhere. Keep
  serving sizes equal, cite sources; distinguish published calories from estimates.
  `description` and `calories_kcal` retain exposed menu information where available.
  noon puts kcal in `size` (e.g. "190 kcal"); `catalog_schema.normalize` reads it there too (f3f68b68bb).
- **Cheapest item:** parallel app searches, strict brand/flavour/size comparison,
  then delivery fee and minimum-order check. Historical Barebells comparison:
  NowNow Choithrams AED15.95 won; parallel searches took2.7s. Recheck live pricing.

Every item has `image_url` (null when upstream omits it); `--images-dir DIR`
downloads available images and adds `image_path` / HTTP status or a download error.
Shared presentation fields: ETA minutes (upper end of range), delivery fee,
minimum order, status, size, unit price/unit, description and calories when exposed.
Null means unknown, never free/zero. Basket totals include known delivery charges
but cannot certify service/small-order fees or account promotions before checkout.

Runtime: `~/.local/share/app-api-cli/` (non-iCloud, migrated 2026-10-06).
`~/Documents/assistant/app-api-cli/` remains a compatibility symlink; all eight
CLI wrappers point directly to that deployed directory; edit only the fork's
`integrations/app-api-cli` source. The search CLI sources (noon/careem search, basket, catalog_schema, lib/, capture/, test/) are tracked there since 07c3b4fe93. Do not move runtime code
back into Documents: Optimize Storage evicted it and broke Node startup.
Use these before manual browsing. These search CLIs remain read-only: no orders,
carts or payment through them — ordering goes through the separate `commerce`
CLI lanes (see the `noon` skill). Credentials stay in macOS Keychain
(`app-api-cli.native`); never dump raw responses, headers, Keychain entries,
logcat or capture flows.

## Commands

**Careem renewal (verified 2026-10-04):** `careem-auth refresh` renews the 24-hour
guest token non-interactively in ~4 seconds, including a catalog validation;
`careem-auth status` reports expiry/readiness without secrets. `careem-search`
automatically renews and retries once on HTTP 401 (not 403), with a cross-process
lock to coalesce concurrent stale-token callers. Renewal uses the legitimate
guest refresh-token grant at `https://identity.careem.com/token`; client auth,
refresh-token rotation and catalog headers stay in Keychain service
`app-api-cli.native`, account `careem`. No phone/OTP/proxy is needed. New access
headers are published only after a live guest catalog validation; rotated renewal
material is retained even if that validation temporarily fails. Bootstrap or
revoked-grant errors require maintenance, not clone login retries. Source:
`/Users/ardud/Documents/assistant/app-api-cli/careem_auth.py`.
Live verification: Food `"veal dumplings"` returned 3 restaurants/10 dish hits
(not exact veal availability); forced-401 Quik milk returned 20 products; three
simultaneous renewal processes shared one rotation. Guest provenance is unchanged.

```sh
noon-search marvis --json
noon-search --rocket iphone --json
noon-search --minutes smetana --json
noon-search food sushi --open --json
noon-search food-menu SSHZNKNBDI --query salmon --json
noon-search food-match sushi "seaweed salad" --open --json
noon-search nownow milk --open --limit 10 --json


careem-search food sushi --open
careem-search menu 1054428 --query salmon
careem-search menu-match sushi "seaweed salad" --open
careem-search quik milk
careem-search shops milk --open
careem-search electronics charger --open

# Same-store product lists + price subtotals (no cart changes):
shop-search match noon minutes milk eggs --json
shop-search match noon nownow milk eggs --json
shop-search match careem shops milk eggs --open --json
shop-search match careem electronics charger cable --json
```

`shop-search match APP SECTION TERM TERM` intersects store/warehouse IDs across
the fetched pages, excludes explicitly unavailable items, matches item names and
sorts by cheapest item subtotal. Supported sections: noon main/minutes/nownow;
Careem quik/shops/electronics (Talabat refuses since 2026-11-07).
`noon main` means one marketplace, **not one seller**. Subtotals exclude fees and
do not constitute a checkout quote. Comparison still needs equal brand/size/variant.

## Provenance and location

- Saved noon Home pin confirmed by authenticated `whoami`: **25.0778251,
  55.1569039**, BanyanTree Hillside, Flat 2104. All searches use this pin. Old
  25.0778835,55.1566159 was a nearby building coordinate (~30 m away).
- noon Main/Rocket/Minutes/Food use the captured real Android account and verify
  saved Home on every call. `AUTH_EXPIRED` / `HOME_MISMATCH` require recapture.
- Careem catalog can be **guest**-scoped. Sharing the noon
  pin does not verify its catalog account benefits; inspect result provenance
  and use `--require-account` to fail closed. Careem
  has no customer API session; its original app remains the account path.
- `fee_source`, `eta_source`, `search_source`, `status_source`
  distinguish sources; search fee/ETA are retained separately from live branch data.
- Careem merchant home now supplies Quik and Shops ETA/fee. Plus promotional fee
  is separately labeled; it is not proof the owner qualifies.

## Search behavior

- Food multi-item matching requires every term on item **names**, never descriptions
  or category alone. Explicit culinary synonyms include sushi→maki/nigiri and
  seaweed salad→wakame. Results show concrete names and prices for each term.
- Prices round to two decimal precision, `(ANS)` and similar menu tags are removed,
  branch area is included when supplied. Menu presence is not checkout orderability,
  but it IS the answer to "is X on the menu / back on the menu": report the listed item,
  don't confirm it on the phone (the 3 Oct ZeroFat Hawaiian check did, needlessly).
- Careem Shops/electronics now use native `global-search` + `shops-merchant-home`,
  usually ~2 s. Irrelevant products are removed. Electronics adds a name category
  filter. Food/Quik search is currently the first API page (~20 results); truncation
  is exposed. Menus load the full returned catalog.

## Fallback limits

- NowNow now uses the captured authenticated native endpoint
  `api-app-fd.noon.com/_svc/mp-shop-api-ctnoon/v2/content/search` (~2 s), with saved
  Home verified each call. The old 503 was a guessed, wrong catalog route.
  `noon-search nownow milk --open --json` filters on live store `operationality`,
  not ETA or ADD buttons (closed stores display both). Results include `status`,
  `status_message`, `opens_at` (Asia/Dubai), `scheduled_only`, and `delivery_mode`.
  Closed stores may accept scheduled orders; optional slots on open stores do not
  imply scheduled-only. Missing/conflicting status never passes `--open`.
  `--page` selects a native page, `--limit` bounds stores (1–100); up to ten products
  per store. Merchant-collapsed and not exhaustive; open filter applies to fetched
  page only. `shop-search match noon nownow milk eggs --open --json` works too.
  No phone/proxy needed for searches; credentials remain in Keychain `nownow`.
  Auth/capture errors surface rather than downgrading verified status to UI guesses.
- Careem Shops API errors automatically invoke the original-app UI; `--ui` forces
  it. Visible-screen-only results, fee unknown. `--open` cannot be certified there.
- Phone fallbacks check priority-hold before each input and yield with `PHONE_BUSY`.
  No clone login, original-app replacement or proxy manipulation is needed.
- Minutes native search has no verified ETA/fee field; null is intentional.
- Public web research uses no account cookies. Authenticated browser fallback uses
  Dia Personal. Check `dia_profiles` before browser work; never export cookies.
- `--web` selects Dia explicitly for supported noon lookups. Automatic noon
  fallback announces loss of account/Home verification; use `--require-account` or
  `--native` to disallow that downgrade.
- Careem rides/Box remain app-only and outside this catalog scope. Uber rides
  use the separate `uber` CLI first; load `uber`/`rides`, not delivery discovery.

## Verification and maintenance

New-app discovery watcher `delivery-app-cli-discovery` checks installed packages
every300s with read-only adb and yields to priority-hold. Source:
`app-api-cli/delivery_apps_watch.py`; baseline in the watcher's runtime directory.
Known delivery/shopping packages (including Deliveroo) trigger background CLI
building on `opus/gpt-6-astra`; Amazon and existing supported apps are excluded.
New package families need adding to `KNOWN`. Watcher expires 2027-10-02; renew then.

```sh
cd /Volumes/ExternalSSD/t3code-fork/integrations/app-api-cli
~/.local/share/uv/tools/mitmproxy/bin/python -m unittest discover -s test -v
node --test test/test_*.mjs
~/.local/share/uv/tools/mitmproxy/bin/python test/live_scenarios.py
```

Use the mitmproxy Python environment for Keychain Security.framework and capture
tests. System Python lacks mitmproxy and may hang accessing Keychain.
Capture maintenance: run `ph hold status --json` before every phone batch;
it sweeps exited holders and holds unrefreshed for 30 minutes. Yield while
`present` is true; never delete another task's hold. Request phone fallbacks use
`ph hold acquire --token <session-id>`, export `PHONE_HOLD_OWNER=<session-id>`,
and `ph hold release` on completion, cancellation or failure. ph refreshes on
every call; use `ph hold refresh` during long OTP/reply waits. Keep Android `http_proxy` explicitly
`:0`; deleting it once left a cached dead proxy. Clone capture tools/old history
are in `capture/`, `CAREEM-NOTES.md`; current search changes
are documented in `HARDENING.md`. Do not retry clone login.
