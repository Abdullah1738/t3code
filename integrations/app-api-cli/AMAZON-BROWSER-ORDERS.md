# Amazon.ae browser order reads

## Investigation checkpoint — 2026-10-08

This is an additive, read-only lane. `amazon-orders` remains the email adapter.
`amazon_email_orders.py`, `order_tracker.py`, watchers and arrival deduplication
are unchanged. The installer now adds a separate opt-in `amazon-browser-orders`
launcher, with module/helper preflight before writing any managed launcher.
Historical source-only checkpoints below predate coordinator deployment; they
are not the current installation status. No commit or push.

## Release acceptance — 2026-10-09

The complete source suite passed 428 Python tests, including a regression for
catalog-test imports shadowing the source tree with installed modules; the
separate Node transport suite passed 14 tests. Noon checkout remains disabled.
Deployed with `integrations/deploy.zsh app-api-cli` and the installed installer.
All 53 deployed source files matched their source hashes. Eight protected
email/tracking/auth modules and seven existing wrappers remained unchanged;
the separate catalog selection passed 15 tests again after deployment.

At 00:42 Dubai on 9 October, the installed `amazon-browser-orders` launcher
successfully read the exact existing Dia Personal tab, tracked one returned ID,
and selected the same unique tab without an explicit ID (10.398s / 10.043s /
9.557s respectively). This was real Dia MCP transport, not a fixture. No page
navigation, focus, login, OTP, CAPTCHA, cookie export or purchase was needed.
Only counts, timing and equality booleans were retained from verification.

The current history page returned **10 of 48 advertised orders**, one unsupported
layout and ten items with missing quantities. Coverage is only the rendered
page; all whole-order completion flags remain false. `track` only filters that
page, and does not navigate to an off-page order. This is read-only order history,
not an ordering command or a replacement for the email/tracking path.

### Upstream review

Reviewed https://github.com/alexdlaird/amazon-orders at
`c4785175db9f5be15c9bf519d2d94ee4fdcc0164`. Public scratch checkout:
`/Users/ardud/.robob/scratch/2026-10-08-continue-owner-authorized-delivery-http-59e6905d/tmp/amazon-orders-upstream`.
No upstream package was installed or executed.

- MIT license, copyright 2024–2025 Alex Laird; notice retained below for selector
  adaptation. Source: `LICENSE`, `amazonorders/selectors.py`.
- `AmazonOrders.parse_order_history(html, config, start_index=0)`,
  `parse_order_details(html, config, order_number=None)` and
  `parse_tracking(html, config)` are already parser-only seams. Entities use
  BeautifulSoup selectors and configurable entity/constants classes.
- `orders.py` imports `AmazonSession`; `AmazonOrdersConfig` reads local YAML,
  dynamically loads configurable classes and honors environment settings.
  We do not need that dependency/config/auth surface for this small read path.
- `session.py` constructs a requests session, loads/persists a JSON cookie jar,
  accepts username/password/OTP-secret environment values, drives authentication
  forms and optionally writes raw HTML in debug mode. None is suitable here.
- `contrib/browser/playwright.py` starts a separate browser and bridges cookies
  both ways; challenge-solving integrations also exist. Do not use them. Dia's
  resident authenticated page is the only permitted account transport.
- `.ae` currency mapping already exists (`AED`), but `.ae` is absent from the
  region auth-cookie and sign-in assoc-handle tables. Domain override alone is
  not proof of UAE authentication compatibility. Core support claims English
  `.com`; English UAE selectors were checked separately below.
- Upstream shipments carry status text and optional shipment identity; its
  tracking entity extracts carrier/tracking number, not a reconciled whole-order
  completion result. Missing item quantities stay null upstream too.

### Actual browser observations

`dia_profiles` confirmed no Amazon tab in Personal. Created a dedicated tab,
`9D10A644-B85C-400A-A372-EE33C38AB59C` (CDP target
`026C1AE858A99C8249A2CB1F27DF0ED6`). Native creation switched the active profile
from Equicom to Personal; subsequent inspection/navigation was background-bound
to this exact tab. No unrelated user tab was repurposed.

The existing Personal Amazon.ae session was already signed in. Opening
`https://www.amazon.ae/gp/your-account/order-history` rendered **Your Orders**,
10 cards, English UAE (`en-ae`). No credential entry, OTP initiation, CAPTCHA,
cookie export, auth mutation, shopping or order changes were necessary.

Observed, not inferred:

- History: `.order-card`, `.order-header`, `.yohtmlc-order-id span[dir=ltr]`,
  `.order-header .a-span3` (date), `.order-header .a-span2` (AED total),
  `.delivery-box`, `.yohtmlc-shipment-status-primaryText` containing nested
  `.delivery-box__primary-text`, `.item-box`, `.yohtmlc-product-title`.
  Cancelled cards instead have a `.a-span12` date and no total.
- The selected time window advertised **48 orders** in `.time-filter__label`;
  `.num-orders` was absent. Only its first 10 cards were inspected; no all-history
  claim. `ul.a-pagination li.a-last a` exists. Pagination URLs are not assumed
  to expose a particular query-key format or automatically followed.
- Visible statuses included `Return started`, `Delivered 6 October`, `Cancelled`,
  `Arriving Monday`, `Delivered on 6 October at 8:38 AM`, `Delivered today` and
  `Amazon Now delivery`. The last card uses an unsupported brand-info layout.
  History quantity for the inspected single-item card was absent, not assumed 1.
- Actual detail link path `/your-orders/order-details`; details rendered
  `#orderDetails`, `[data-component=orderId]`, `[data-component=orderDate]`,
  `[data-component=shipments] .a-box`, `[data-component=purchasedItems]`,
  `[data-component=itemTitle]`. A primary `h4.od-status-message` and a separate
  secondary `.od-status-message` were both present; do not combine secondary
  delivery-location copy into the primary status. The quantity component was
  empty. Detail reconciliation cannot safely invent a quantity.
- Followed the inspected card's existing package link, staying in the same tab.
  Package tracking used `/progress-tracker/package`, with orderId, shipmentId and
  packageIndex parameters. Initial page inspection matched upstream's
  `#mainContent-container`, `section.pt-card`, `.pt-delivery-card-trackingId` and
  `.tracking-event-carrier-header`, plus `.pt-promise-main-slot`. Its rendered
  heading explicitly said **2 orders in this package**. This is package proof,
  not evidence that either whole order is complete. A later read of the first
  `#mainContent-container` had fewer nodes/no promise; tracking DOM readiness or
  duplicate containers requires additional verification. No tracking-page parser
  completeness is claimed from those selectors alone.

Only bounded structural/status projections were inspected; no raw production
HTML, cookies, credentials, addresses, product titles or payment details saved
as fixtures. Test fixtures remain synthetic. The dedicated tab was returned to
the orders history URL at the end, not closed or reused for another purpose.

## Implementation and verification

### Parser module in this source-only lane

- `amazon_browser_orders.py`: no dependencies beyond Python stdlib. It does not
  import upstream or the email/tracker modules. No network, subprocess, filesystem
  writes, auth, navigation, purchases or watcher changes.
- `DIA_EXTRACTOR`: reviewed JavaScript expression to run **inside** the existing
  exact Dia Personal tab using `dia_evaluate`. Reads only order DOM fields;
  returns a bounded projection, not raw HTML. It never reads cookies, storage,
  input values, recipient/address/payment data or product titles. Product ASINs
  come from allowed Amazon.ae `/dp/` paths. Tracking URLs never leave the page;
  exact order-bound shipment identities are SHA-256 hashed in the browser.
- `parse_snapshot(snapshot, *, profile_name, observed_at, expected_order_id=None)`:
  offline parser of that projection. UAE dates/AED totals, exact IDs, explicit
  quantities, primary per-shipment statuses, pagination/count bounds. Quantity
  absent means null, not one. Input is not independently authenticated proof.
- `parse_dia_result(response, *, tab_id, target_id, observed_at,
  expected_order_id=None)`: validates the supported `dia_evaluate` response shape,
  exact Personal tab and CDP target, HTTPS Amazon.ae origin, allowed order path
  and location/projection agreement before parsing. Navigation races reject.
  Caller must provide the actual trusted MCP tool response, not arbitrary JSON
  claiming to be it; the mapping is not a cryptographic attestation.
- Errors are static `BrowserOrdersError` codes, never a dumped response. Normal
  login/OTP/CAPTCHA pages return `AUTH_OR_CHALLENGE_REQUIRED`; no auth attempt is
  initiated. Wrong locale/page/layout/readiness fails explicitly. A missing
  requested order is `ORDER_NOT_ON_THIS_PAGE`, not proof it does not exist.

### Conservative status contract

`source=amazon_browser_dom` and `visible_stage` mean the rendered shipment/card
status, **not** an order-tracker terminal stage. Mixed shipment statuses produce
`visible_stage=unknown` with each shipment retained. Return/refund/cancellation
do not become delivery. Future, negated, hypothetical and progress-rail text do
not match the anchored status parser. Date-only delivery copy yields
`evidence_at=null`; the caller's timezone-aware `observed_at` remains separate.

**Always false:** `whole_order_delivered`, `terminal`, `manifest_complete`,
`coverage.scan_complete`, `coverage.whole_history_complete`,
`tracker_integration_enabled`. Even one detail card or all visibly delivered
shipments with quantities does not prove a full manifest. The observed combined
package page is deliberately unsupported. These records are not directly
compatible with the email reducer's shipment keys or item fingerprints; do not
merge them by key or feed `visible_stage` into the tracker as native completion.

### Initial parser milestone verification

- Ran the extractor logic in the real signed-in UAE history tab, with an extra
  in-page redaction envelope that replaced order IDs, ASINs, amounts and shipment
  keys before returning. It selected all 10 cards in the 48-order filter, 10
  shipments and 10 item rows, with no truncation and a next-page link. Five cards
  had one accepted exact-order-bound tracking identity; five had none. All
  quantities were absent. Nine cards had supported ordinary item layout; one
  Amazon Now card was explicitly marked unsupported.
- Read-only detail navigation used the card's existing
  `a[href*="/your-orders/order-details"]`; `.yohtmlc-order-details-link` did not
  exist on this live history page. Rechecked the detail parser selectors: exact
  bare order ID and English full date matched; one shipment, primary delivered
  status, one product row/link, one tracking link, no quantity. No detail total
  parsing is claimed. A small diagnostic regex was corrected for JS template
  escaping; the actual extractor uses a raw Python string.
- **38 focused offline tests passed** with socket.connect, create_connection and
  subprocess.Popen blocked. Includes a synthetic ten-card reconstruction of the
  observed projection shape, split packages/mixed statuses, blank quantities,
  known quantities without whole completion, exact-ID mismatch, return/refund,
  cancelled card/no total, unsupported tracking pages, future/negated text,
  malformed IDs/money/dates, duplicated IDs, truncation, challenge/profile/host/
  tab/target/location rejection, input bounds and non-echo of unrelated data.
- Tests use synthetic data; no production payload fixture was persisted. The
  Python parser was exercised against reconstructed projection shape, not a saved
  unredacted account response. The full JS extractor is live-checked, not covered
  by a standalone HTML/DOM emulator suite.
- Whitespace checks passed for all three owned files. No full-suite rerun or
  deployment was attempted; the parent's prior 302-test deployed baseline stays
  frozen, not a new claim from this lane.
- Final read-only SHA-256 check against the parent's
  `tmp/deployed-final-sha256.json`: **42/42 deployed files unchanged**; also
  **7/7 protected source files unchanged** (`amazon_email_orders.py`,
  `order_tracker.py`, `install-cli.py`, `AMAZON-EMAIL-TRACKING.md` and their three
  corresponding test files). Last focused rerun: 38 tests passed in 0.008 seconds
  with all three network/process entrypoints blocked.

Focused command (source directory):

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test \
  -p test_amazon_browser_orders.py -v
```

The actual validation additionally wrapped discovery/run in `unittest.mock.patch`
for the three socket/process entrypoints above. No other suites ran concurrently.

## Runnable opt-in CLI — authorized follow-up

The parent expanded exclusive ownership to add `amazon_dia_cli.py`,
`amazon_dia_transport.mjs`, `test/test_amazon_dia_cli.py` and the isolated Node
test `test/test_amazon_dia_transport.mjs`. The original email command remains
unchanged. Installer/wrapper/deployment remain parent-owned.

### Commands

```sh
cd /Volumes/ExternalSSD/t3code-fork/integrations/app-api-cli
PYTHONDONTWRITEBYTECODE=1 python3 amazon_dia_cli.py orders --json
PYTHONDONTWRITEBYTECODE=1 python3 amazon_dia_cli.py orders --json \
  --tab-id 9D10A644-B85C-400A-A372-EE33C38AB59C
PYTHONDONTWRITEBYTECODE=1 python3 amazon_dia_cli.py track "$ORDER_ID" --json \
  --tab-id 9D10A644-B85C-400A-A372-EE33C38AB59C --timeout 30
```

JSON is always the output format; `--json` is an explicit accepted flag.
Successful rendered-page reads exit 0, including unknown/partial evidence.
Static error JSON exits 1; interrupted execution exits 130. Exit 0 is **not**
delivery confirmation. `track` filters an exact order ID on the current page;
`ORDER_NOT_ON_THIS_PAGE` is not proof of nonexistence. No implicit mail fallback
is run; the result identifies the separate unchanged email fallback.

Without `--tab-id`, exactly one existing supported Amazon.ae history/detail tab
must exist in the uniquely mapped **Personal** profile. More than one fails
`AMAZON_ORDERS_TAB_AMBIGUOUS`, even if one is active. Explicit tab selection still
requires that tab to belong to Personal and show an allowed order path. Missing,
unmapped, loading, unsupported or ambiguous targets fail without navigation.
Target matches must have the exact normalized URL and browser context; no
title-only fallback. The CLI neither creates, focuses nor navigates tabs, retries
auth, initiates OTP, visits tracking/cancel paths, or scans later pages.

### Supported transport and binding

- Python launches the adjacent Node helper in a new process session/group.
  Node loads the **official MCP SDK** `Client` and `StdioClientTransport` from
  `~/.config/opencode/dia-agent-bridge/node_modules/@modelcontextprotocol/sdk/dist/esm`
  and starts `~/.config/opencode/dia-agent-bridge/src/server.js`.
- Tool sequence is exactly `dia_profiles` then `dia_evaluate`. No standalone
  CDP/Playwright/HTTP/browser automation client. The evaluation uses only the
  reviewed `DIA_EXTRACTOR` literal read from the adjacent parser source file;
  there is no arbitrary expression, script, server path or endpoint CLI flag.
- Bridge subprocess environment forces `DIA_AUTO_HEAL=0`, local bridge endpoint
  `http://127.0.0.1:9222` and bounded internal tool/AppleScript/CDP timeouts.
  Inherited credentials and Node inspector/debug variables are not forwarded.
  This does not modify the global MCP or Dia's independent login/guard services.
  A broken bridge requires separately authorized manual repair; this CLI never
  requests an auto-heal/restart.
- Actual bridge implementation was inspected: `getBrowserTargets` merges optional
  `/json/list` **id** with `Target.getTargets` **targetId**. The Python validator
  now accepts `targetId` alone or consistent merged IDs, rejecting disagreement.
  A synthetic regression covers both shapes. Bridge `tabTarget` returns no
  `diaTabId` in its `targetId` branch, so evaluation sends **tabId only**, then
  checks returned profile, tab, target ID and browser context against inventory.
- Full URL (including query) must match between selected inventory and returned
  target before dropping private query/hash fields. The Python validator then
  binds the projected response and its DOM origin/path. Changed IDs, contexts,
  URLs or location mismatches fail closed. Tab/profile inventory is never emitted.
  No cryptographic attestation is claimed; the installed local bridge is trusted.
- Raw target metadata, titles, websocket endpoints, SDK errors, stderr and
  credentials are never printed or persisted. Only the DOM projection and
  minimal binding data cross the private subprocess pipe; Python emits only the
  existing parsed order result plus `transport=dia_mcp_stdio`.

### Bounds and cleanup

Default total transport deadline 30 seconds; `--timeout` accepts 5–60 seconds.
Node's deadline is one second shorter, shared across connection, inventory and
evaluation; no progress-based deadline extension. MCP stdio frames and helper
output are capped at **2 MiB**; Python enforces the output cap while reading,
before accumulating excess bytes. Error and source-extractor bounds also apply.
SDK close is bounded; Python terminates the helper/MCP/osascript process group,
reaps its direct child and verifies the group is absent on success, failure,
timeout, SIGINT or SIGTERM. Unresolved cleanup returns `DIA_CLEANUP_FAILED`, never
a successful read. Cleanup allows up to 1.3 seconds plus scheduling overhead
after the transport deadline. SIGKILL cannot run Python
cleanup, a normal OS limitation. No long-lived worker/cache/service is created.

### Real CLI verification

Read-only runs used the existing dedicated Personal tab, still signed in; no
navigation, tab creation, sign-in or account mutation was performed:

- Explicit-tab `orders`: exit 0 in **10.860s**, 10 parsed cards / 48 advertised,
  expected status mix (2 return-requested, 4 delivered, 2 cancelled, 2 unknown).
- Default unique-tab `orders`: exit 0 in **7.597s**, same 10 cards.
- `track` using an actual ID obtained only in memory from that result: exit 0 in
  **7.596s**, exactly one matching order; coverage still says 10 cards inspected.
- `track` with a synthetic missing ID: exit 1 in **7.438s**,
  `ORDER_NOT_ON_THIS_PAGE`.

All reads had empty stderr; every returned order remained nonterminal and
whole-delivered false. Live verification printed only allowlisted counts,
timings, stage summaries and equality booleans—not real IDs, prices, ASINs,
shipment keys or raw tool responses. No production fixture or result file was
written. No helper process remained afterwards.

### Focused offline tests

Initial CLI validation: **71 PASS: 39 parser + 18 CLI + 14 Node transport tests.** Python socket connect
and create_connection were blocked for the final focused run. CLI tests use
synthetic local Python subprocesses only to test byte bounds, stderr discard,
timeout, process-group/grandchild cleanup, interrupt cleanup and env filtering;
they never start the Dia bridge. Node tests use a fake MCP client and no network.
TargetId/merged-ID compatibility, ambiguity, context mismatch, location race,
challenge/missing-order errors, static errors, only-two-tools sequencing,
auto-heal-off environment and fixed-extractor loading all have regressions.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test \
  -p test_amazon_browser_orders.py -v
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test \
  -p test_amazon_dia_cli.py -v
node --test test/test_amazon_dia_transport.mjs
```

Initial CLI parent-baseline SHA check: **42/42 deployed files unchanged** and **7/7
protected email/tracker/installer source/doc/test files unchanged**. No full
suite, Careem tests or deployment rerun in this follow-up. Earlier 38-test hashes
are superseded only for the owned parser/test by the target-ID compatibility fix.

### Cleanup race correction — parent review follow-up

Parent's 98-test Amazon run reproduced an oversize error masked by
`PermissionError` in `_stop_group`'s first `killpg(SIGTERM)`. A minimal unmodified
100-attempt oversize loop reproduced on **attempt 11**. At failure:

- The direct child's `returncode` was still null, but `ps` reported its group
  contained only that child in zombie state (same UID as caller).
- `getpgid(child)` returned ESRCH while `killpg(group, SIGTERM)` returned EPERM.
- `poll()` reaped exit status 0; the following group probe returned ESRCH.
- A second controlled probe reproduced the zombie-only EPERM without load.
  With a live grandchild and an exited leader, group signalling succeeded; after
  TERM, the temporary zombie-only group again returned EPERM until reaped by its
  new parent. Therefore leader exit/ESRCH alone cannot certify group cleanup.

Narrow fix only in `_stop_group`: poll/reap an already exited leader before TERM,
keep the bounded TERM grace, then KILL/probe the entire original private group.
EPERM is a pending state, **not success**. Only group-probe ESRCH **and** a reaped
direct child allow return. Retry within the one-second cleanup bound to allow
orphan zombies to be reaped. Persistent permission failure, live survivors or
other OS cleanup failures produce static `DIA_CLEANUP_FAILED`. Verified cleanup
preserves the original `DIA_RESPONSE_TOO_LARGE`/timeout/interrupt; unresolved
cleanup takes precedence, retaining the original exception as in-memory context
without printing it or any raw OS error. No successful payload can escape an
unresolved cleanup.

Five added regression tests cover deterministic EPERM preservation (red before
fix), exited leader with surviving child (red before fix), persistent denied/live
groups (red before fix), unresolved cleanup overriding success while retaining
original error context, and a **real TERM-ignoring grandchild** whose leader was
already reaped. Existing real timeout/grandchild and interrupt tests remain.

Verification, sequential and offline:

- 100 exact oversize attempts: intended error on all 100.
- 10 timeout/grandchild attempts and 10 reaped-leader/TERM-ignoring-grandchild
  attempts: passed; 130 post-cleanup group-absence probes total, no leaks.
- **103 Amazon Python tests passed** (39 parser + 23 CLI + 41 unchanged email)
  with socket connect/create_connection forbidden; synthetic local subprocesses
  explicitly allowed. This is the parent's exact 98-test selection plus five
  regressions, not the entire integration suite.
- **14 Node transport tests passed**, unchanged transport code.

```sh
PYTHONPATH=.:test ~/.local/share/uv/tools/mitmproxy/bin/python -B -m unittest \
  test_amazon_dia_cli.CliTests.test_exited_zombie_eperm_preserves_oversize_after_verified_cleanup \
  test_amazon_dia_cli.CliTests.test_exited_leader_does_not_skip_live_grandchild \
  test_amazon_dia_cli.CliTests.test_cleanup_permission_denied_or_surviving_group_fails_closed -v
PYTHONPATH=.:test ~/.local/share/uv/tools/mitmproxy/bin/python -B -m unittest \
  discover -s test -p 'test_amazon*py' -v
node --test test/test_amazon_dia_transport.mjs
```

Final baseline readback after this correction: **42/42 deployed files unchanged**;
email/tracker source, their tests and email doc still match (5/5). The parent-owned
`install-cli.py` and its test now differ from the old deployment manifest; neither
was edited by this lane. No live Dia/network/auth/phone call, deployment or shared
file edit occurred in this correction. Only CLI, CLI tests and this doc changed;
the other four owned-file hashes remain frozen.

### Parent wiring / remaining limitations

Parent can install a separate `amazon-browser-orders` wrapper targeting
`amazon_dia_cli.py`; preserve `amazon-orders` email wrapper and watcher dispatch.
Deploy the adjacent Python parser and Node helper together. Runtime requirements:
Python 3, Node on PATH, the installed Dia bridge with its current SDK, and a
running signed-in Dia Personal order tab. No npm/package/auth installation was
performed. No wrapper/installer change was made in this lane.

On absent page, challenge, readiness or mapping error, surface the static error.
Manual parent actions may use the global Dia MCP for legitimate sign-in/repair
or navigation to an existing read-only order link; never auto-initiate OTP or
bypass CAPTCHA. Current verification needed no such action. Later pages,
Arabic locale, enhanced/carousel/digital/Amazon Now manifests and robust
combined-package tracking remain unverified. No CLI tracking-page reader,
complete-manifest reducer, arrival notice or automatic watcher closure exists.

No phone or live mutation is needed for this bounded history MVP. Whole-order
browser completion is blocked on independent complete manifest/quantity/package
membership verification. Until then, retain email fallback and existing arrival
deduplication; this adapter must not close watches or send arrival notifications.

## Ownership freeze

Only the seven authorized lane files were edited: parser, parser tests, CLI,
Node transport, CLI tests, Node transport tests and this document. Upstream public
scratch checkout remains only under assigned workspace `tmp/`. No commit/push/
deploy, phone, authentication mutation, OTP, cookie export, cart/purchase/
cancellation, shared dispatch/tracker/installer, email adapter or skill edit.
Implementation is frozen for parent review.

Frozen implementation SHA-256:

```text
ecf0cca04877c054d20c4dd1f1972a696b822c61e1d7a416d8019388074fbd99  amazon_browser_orders.py
417feb2568ba2a78a5dfcca5fd17f34c72cf17aedc363c5b24b0d4d4c850ae3d  amazon_dia_cli.py
6b74fc1893ebb062e65b50097793b1fb28d00d4354ceb706c83a2ce099e82e7e  amazon_dia_transport.mjs
3aef0b0745112f8f46c94ee80cf5b087bb341713bc731a17bfcf18834f1173a6  test/test_amazon_browser_orders.py
29f9339f24c91790315e5de7d3b430f206c6aa656e7745bececf0d1dbf26a2e8  test/test_amazon_dia_cli.py
15f9de633637683136a7755cf4490a25c33932a83d222511185c52db77bff8ec  test/test_amazon_dia_transport.mjs
```

## Selector adaptation license

MIT License

Copyright (c) 2024-2025 Alex Laird

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
