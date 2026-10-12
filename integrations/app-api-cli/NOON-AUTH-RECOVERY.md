# Noon auth: durable session recovery (Minutes / Main / Supermall / NowNow)

Status: implemented, unit-tested, current valid sessions live-validated. No refresh
grant has been established by the inspected endpoints or captures; recovery is
built on validated cookie rotation, same-account cross-surface adoption, and an
explicit parent-authorized capture import. Never false success.

## Model

- Keychain service `app-api-cli.native`, native captures: accounts `minutes`, `noon`,
  `nownow`. Lifecycle overlay state: accounts `noon-auth-lifecycle-<key>`.
- Session keys: `main`+`supermall` → key `noon` (shared), `minutes` → `minutes`,
  `nownow` → `nownow`. `NoonAuthLifecycle.KEY_SURFACES`.
- There is NO proven refresh endpoint and NO logout/rebind API. The server rotates
  cookies on ordinary responses; the lifecycle persists rotated cookies only after
  full identity (whoami customerCode) + Home (Banyantree Flat 2104 pin) validation.
- Overlay divergence from the native capture is a supported state: `native_digest`
  pins the capture; published overlays may drift via validated rotation. Native
  capture accounts are never written by recovery code.

## Recovery ladder (`NoonSessionRecovery.recover(service)`)

1. Preconditions (storage-only): capture present, no foreign pending material (a
   pending `cookies_retained` + HTTP 401 is *superseded* into a bounded audit list;
   any other pending requires explicit reconcile), no cookie observations, native
   capture unchanged, account bound.
2. `revalidate()` — one identity read; success publishes any rotated cookies
   (single-flight per session key, retry-once reads only) and returns.
3. Peer adoption — if the read is rejected (`AUTH_EXPIRED` /
   `NO_FRESH_AUTH_MANUAL_RECOVERY_REQUIRED`): try same-account donor surfaces
   (freshest first, ≤ 2), `adopt_peer_session()` overlays donor auth cookies onto the
   target overlay and publishes only after live exercise + account + Home validation.
4. Explicit handoff — no donors left: `action_required` with recapture steps
   (original app sign-in if necessary, then rebind/import), `automatic_otp` false.
   The recovery module never requests an OTP. The authorized operator may use the
   existing mailbox workflow to read the current login code privately; a human
   challenge still requires the owner. Never repeat OTP requests blindly.

## Public API (parent wiring)

`commerce auth noon VERTICAL --recover` already routes to
`CommerceAuth.recover(app, vertical)` — **no commerce_cli.py changes needed**.
Signatures (all return plain dicts; all secrets stay in Keychain; outputs are
sanitized — account refs are local sha256 fingerprints):

```python
# noon_session_recovery.py
class NoonSessionRecovery:
    def __init__(self, lifecycle: NoonAuthLifecycle | None = None, lock_root=None): ...
    def survey(self, *, timeout: int = 5) -> dict          # zero network, zero writes
    def recover(self, service: str, *, timeout: int = 30) -> dict   # ladder above
    def import_capture(self, service: str, headers_file: str, account_ref: str, *, timeout: int = 30) -> dict
    def verify_all(self, *, timeout: int = 30) -> dict     # one revalidate per KEY

# noon_auth_lifecycle.py (NoonAuthLifecycle)
    def key_survey(self, service: str, *, timeout: int = 5) -> dict   # storage-only
    def adopt_peer_session(self, service: str, donor_service: str, *, timeout: int = 30, deadline=None) -> dict
    def publish_capture_import(self, service: str, headers: dict[str, str], expected_account_ref: str, *, timeout: int = 30, deadline=None) -> dict
    # existing: status / diagnose_readonly / revalidate / revalidate_identity /
    # reconcile / bind_existing / rebind_existing / fresh_before_mutation /
    # read_with_recovery / retain_response_cookies
```

Standalone CLI (same source dir):

```
python3 noon_session_recovery.py survey
python3 noon_session_recovery.py status main|supermall|minutes|nownow
python3 noon_session_recovery.py recover SERVICE [--timeout N]
python3 noon_session_recovery.py adopt SERVICE --donor DONOR
python3 noon_session_recovery.py verify-all
python3 noon_session_recovery.py import-capture SERVICE --headers-file FILE --account-ref PIN
```

`import-capture` reads a JSON dict of request headers from a **0600-mode file**
(never CLI-arg secrets; ≤128KB; must contain ≥1 auth cookie after parsing).
`--account-ref` is the 64-hex pin (`fingerprint(customerCode)`). For an unbound
service the import acts as first bind; for a bound one the pin must match.

## Error codes → recovery actions (commerce_auth_status.recovery_action)

| Code (family) | Action |
|---|---|
| `AUTH_EXPIRED`, `AUTH_EXPIRED_RENEWAL_REQUIRED` | renew_before_next_operation |
| `*_RECONCILE*`, `HTTP_EXCHANGE_FAILED_NO_RETRY`, `AUTH_READ_FAILED_NO_RETRY`, `PEER_PENDING_RECONCILE_REQUIRED` | reconcile_retained_material |
| `*SCHEMA*` (`SCHEMA_CHANGED`, `HOME_SCHEMA_UNKNOWN`, `ACCOUNT_SCHEMA_UNKNOWN`) | inspect_schema_change |
| `ACCOUNT_BINDING_REQUIRED`, `NATIVE_SESSION_CHANGED_REBIND_REQUIRED`, `PEER_SESSION_UNBOUND` | manual_account_binding |
| `PEER_ACCOUNT_MISMATCH`, `PEER_AUTH_NOT_APPLICABLE`, `PEER_SESSION_KEY_UNSUPPORTED` | manual_account_recovery |
| `AUTH_FORBIDDEN` | manual_auth_challenge |
| parts MISSING/BINDING/CAPTURE/MANUAL/IDENTITY/HOME_/REJECTED (incl. import codes) | manual_account_recovery |
| `IMPORT_HEADERS_INVALID` | inspect_local_failure |
| TIMEOUT/BUSY/RATE_LIMITED | stop_deadline_or_backoff |

Key invariants: donor state is never written during adoption; `native_digest`
never changes on adoption; supersede allowed only for 401-retained pending
(cap 8 audit entries → `SUPERSEDED_REJECTION_CAPACITY_STOP`); mutations are never
retried; candidate publication requires the live exercise to return the same
account + Home.

## Runbook (operator)

- Routine check: `commerce auth noon <vertical>` (read-only status).
- After app re-login, the CLI still needs the new session material. Use
  `rebind_existing` when the native capture has been replaced, or `import-capture`
  with private captured headers. `--recover` can reuse an existing same-account
  peer session; it cannot extract new cookies from the app by itself.
- Pending `cookies_retained` from a 200 (rotation retained): `commerce auth noon
  <vertical> --reconcile` replays the candidate safely.
- Never: logout, password change, repeated OTP requests, clearing app data,
  deleting Keychain items, "Always Allow" prompts for unknown binaries.

## Current live state (2026-10-11, read-only probe)

- All three keys bound to one account (same `account_ref`).
- `noon` (main+supermall): valid (`existing_session_valid` via live whoami +
  customer/get, account + Home verified, auth cookies stable).
- `nownow`: valid per last validation; no pending material.
- `minutes`: the observed `cookies_retained` HTTP 200 rotation was subsequently
  reconciled successfully by the coordinator; returned `validated_response_cookies`
  with no remaining maintenance state. Recheck current status before relying on
  this dated observation.

## Evidence base

- LIVE (this lane, read-only, runtime interpreter): `survey` (0 network),
  `status` ×4 (storage-only), `diagnose_readonly('main')` (2 GETs, 0 writes,
  account + Home verified). No prompts, no OTP, no logout, no writes.
- FIXTURE-TESTED ONLY: AUTH_EXPIRED handling, 401-pending supersede, peer adoption,
  capture import and verify_all. Do not invalidate a valid session just to force
  these paths. Reconcile replay also has the live Minutes observation above.
  28 new tests + 38 lifecycle
  regression + 9 auth-status + 22 main-order, all green
  (`python3 -m unittest discover -s test -p '<module>.py'`, homebrew python3 ≥3.10).
- No-refresh finding: prior lane reports `http-noon-rejected-auth-final.md`,
  `http-noon-android-network-auth.md` (scratch tmp of 2026-10-08 session).

## Environment notes

- Keychain ACLs are bound to the runtime interpreter
  (`~/.local/share/uv/tools/mitmproxy/bin/python`, the `commerce` wrapper's
  binary). Running the same code under other pythons (e.g. homebrew python3)
  triggers a Keychain password prompt — do not "Always Allow"; deny and use the
  runtime interpreter for live reads, or run tests (fixtures only, no Keychain).
- Tests are stdlib-unittest; dotted `test.X` module names collide with the stdlib
  `test` package in some runners — use `unittest discover -s test -p '<module>.py'`.
- Shared-checkout integration tests may change while other lanes are being
  implemented. Run the final full suite from the package root before deployment;
  transient failures during concurrent edits are not accepted test evidence.
