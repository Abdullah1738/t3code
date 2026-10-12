# Talabat account maintenance and order listing

The existing verified account and guest catalog remain
separate; no phone, browser, registration, revoke or purchase endpoints are used.

## Recovered contract (original Android 13.95.0)

- OTP login returns renewal material in **response headers**, not only JSON:
  `X-Device` and `x-refresh-token-created-at`. AOT `0x24b1d28` reads the former;
  `0xc84c30` reads the latter. The previous scratch bootstrap retained only JSON,
  explaining the AAA `ApiOauthDeviceTokenInvalidException` rejection.
- AAA refresh is JSON POST `https://talabat.dh-auth.io/api/v5/oauth2/token`:
  client_id android, production client_secret, grant_type refresh_token,
  refresh_token, scope empty. `0x21321d0`/`0xc856a0` build it. `0x21354a0`
  adds X-Device, obtained by native fetchDeviceToken (`0x2137724`).
- `x-refresh-token-created-at` is response metadata, not an invented request
  header. `/tokens` at pool `0x547b8` is Checkout.com card tokenization and has
  nothing to do with account renewal. No call was made to it.
- GET `/vendor-list/v1/orders/country/4` accepts latitude, longitude,
  **zero-based** page_number and page_size (APK uses 75). Verified page 0 returned
  75 of 85 orders, page 1 the final 10. Response includes orders, total_orders,
  is_last_page; lazy_load_calls must not be followed.

Current Keychain: service `app-api-cli.native`, account `talabat-account`, native
headers, auth, expected_profile, account_verified, country AE. All values private.
The active token is an approximately eight-hour JWT; OTP expires_in is an absolute
epoch. New credentials must be retained before validation, but must not replace
the active verified binding until GET `/customers/v1/profile` matches it.

The owner authorized one normal existing-account SMS bootstrap on 8 October to
retain the missing headers, followed by one justified renewal. No resend or
blind retry after an ambiguous mutation. See the completion section below for
actual verification, not just static evidence.

## Maintenance CLI and integration

Run with the mitmproxy Python environment (Security.framework Keychain adapter),
from this directory. No secrets are accepted on command-line arguments or printed.

```sh
~/.local/share/uv/tools/mitmproxy/bin/python talabat_auth.py status
~/.local/share/uv/tools/mitmproxy/bin/python talabat_auth.py refresh
# Explicit rotation even if still fresh; not a scheduled command:
~/.local/share/uv/tools/mitmproxy/bin/python talabat_auth.py refresh --force

# Owner-authorized maintenance only, never invoked automatically:
~/.local/share/uv/tools/mitmproxy/bin/python talabat_auth.py login --request-sms --apk-pool /path/to/13.95.0/pp.txt
~/.local/share/uv/tools/mitmproxy/bin/python talabat_auth.py login --complete
# Retry validation of retained credentials only; this never repeats a POST:
~/.local/share/uv/tools/mitmproxy/bin/python talabat_auth.py login --reconcile

~/.local/share/uv/tools/mitmproxy/bin/python talabat_http_list.py --pages 2 --limit 150
```

`status()` is local and exposes expiry/readiness, not profile details or secrets.
Its account_verified field is the persisted binding; each actual list/track read
still verifies the live profile. `refresh(force=False, rejected_token=None,
timeout=25, deadline=None)` normally rotates only within two minutes of expiry. A rejected-token
argument forces renewal only if that same token is still current; another
process's successful renewal is reused. Concurrent explicit rotations coalesce
using the operation generation observed before acquiring the flock. Credentials
are never passed in subprocess arguments.

Tracking and listing now share `read_with_renewal`: it captures the old token from
the exact read snapshot in memory and on local expiry/HTTP 401 only calls
`refresh(rejected_token=old_token, deadline=original_deadline)` once, then retries
the entire profile+read/pagination operation. Lock wait and HTTP calls share the
original budget; there is no new retry budget. **Do not add an outer renewal
retry** in dispatch. No 403, bootstrap, ambiguous-mutation or schema retries, and
no automatic SMS.
Wrapper installation, tracking/list dispatch and runtime deployment belong to
the caller; these modules do not edit those files or install global commands.

`login_request(pool, timeout=25)` refuses non-existing customers. It uses the
already verified expected identity, with native headers/device ID preserved.
`login_complete(timeout=25)` reads exactly one distinct fresh inbound Talabat code
from local Messages SQLite. The sender must equal Talabat case-insensitively;
timestamps must postdate this request, at most ten minutes old. Missing or
ambiguous codes cause no login POST; a later explicit completion can recheck the
local inbox without resending SMS. It does not read the phone or alter app state.

## Storage, concurrency and recovery

- `~/.local/state/app-api-cli/talabat-account.lock`: cross-process flock, no secrets.
- `talabat-account-maintenance` Keychain item: request state, exact base snapshot,
  operation ID, ticket and retained response/candidate. Every mutation is marked
  in-flight before transmission. Fully received mutation bytes (base64 encoding,
  not encryption) and both renewal headers are stored **inside Keychain before
  JSON parsing**, under `raw_response_retained`. They are never logged. This
  includes a complete response whose final network deadline check fails.
  A separate local-only retention phase is limited to two seconds; it does not
  extend parsing/profile validation's original deadline or initiate network work.
  Parse timeout/malformed JSON leaves those bytes available to explicit
  `login --reconcile`; reconciliation parses locally, never resends the POST.
  Successful parsing advances to `response_retained` / `candidate_retained`.
- `talabat-account`: active verified account, atomically published only after live
  profile identity validation. Original fields/native headers survive renewal.
  New fields: refresh_auth (public client secret), renewal (device token and
  refresh-token creation metadata), refreshed_at, refresh_verified, and operation ID.
  Guest `talabat` is not read or changed by maintenance.

If validation fails, the previous verified account remains active and the rotated
candidate stays in Keychain. Reconciliation validates that candidate, never the
invalidated old refresh token. Publication compares the active record with its
base both before profile validation and again immediately before writing. A
change detected during validation stops publication and preserves the candidate.
**All legitimate account writers must use the same cross-process account lock.**
Keychain provides an atomic item replacement, not an atomic compare-and-swap:
an arbitrary out-of-lock writer can still race the final comparison and write.
The recheck narrows that window; it does not promise impossible CAS protection.
Once publication succeeds,
the pending item is replaced with a credential-free completion marker.

An ambiguous POST leaves an in-flight marker and blocks all further mutation
attempts. A rejected response also blocks blind retries. No automatic rollback,
resend, logout, revoke, registration, captcha bypass or alternate grant exists.
Manual investigation is required when no retained candidate can be validated.
The CLI has no force-clear flag: do not discard pending rotated material.
If Keychain storage itself fails or exceeds the local retention allowance after
remote rotation, the CLI cannot guarantee recovery; it stops without retry.
Back up/fix Keychain access before maintenance.

Requests have hard elapsed network deadlines (including drip-fed responses),
2 MB limits, disabled proxies/redirects and sanitized errors. Caller-thread timers
must be available; no silent unbounded fallback. Network timeouts are bounded to
120 seconds, lock acquisition to five seconds. A completed mutation may spend
up to two additional local-only seconds on secure retention. Native Keychain
calls may defer Python signals until the OS call returns; this is not a hard OS
preemption guarantee. No network or validation budget is renewed by retention.

## Order listing

`list_orders(page=0, pages=1, limit=20, timeout=20)` verifies the profile before
reading. Native page size is 75; maximum five pages / 375 projected rows per call.
It includes both output truncation and native pagination in the result. A page
offset explicitly marks earlier pages omitted. Completion requires page zero,
native is_last_page, matching total count and no duplicate/changing-page evidence.
This is not a server snapshot transaction; concurrent order history changes can
still happen during pagination. No raw lazy_load_calls, encrypted IDs, payment,
address or item details are returned or followed. Delivered, Preparing and
Delivering are live-verified (the latter two on exact active order 3944138092).
Other list enums remain unknown with raw_status; list ETA/rider remain null.
The saved Home pin is only endpoint context, not account address verification.

## Verification on 8 October 2026

- Exactly one new HTTP SMS request and existing-account login completed, without
  captcha, retaining X-Device and x-refresh-token-created-at. The old active
  account remained intact until the new token's expected profile matched.
- Exactly one subsequent AAA refresh succeeded with X-Device. Rotated material
  was retained then live-profile-verified; refresh_verified is true. No OTP is
  needed for future renewal while the server continues accepting the grant.
- Following renewal, profile + tracking returned delivered for both known orders
  3943476390 and 3943292030 at 14:17 UTC.
- Default listing returned 20 of 85 with truncation disclosed. Two pages with a
  150-row output bound returned all 85, native last page true, no duplicates,
  truncated false at 14:19 UTC. 82 rows were Delivered; three stayed unknown.
- No purchase, phone/browser operation, app logout/revoke, commit or deployment.
   Active tracking was subsequently verified on exact order 3944138092; see
   TALABAT-HTTP-TRACKING.md. List projection still exposes no ETA/rider.

Focused checks (synthetic credentials only):

```sh
PYTHONDONTWRITEBYTECODE=1 ~/.local/share/uv/tools/mitmproxy/bin/python -m unittest \
  test.test_talabat_auth test.test_talabat_http_list test.test_talabat_http_orders -v
```
