# Verified Talabat account catalog

Implemented and deployed 2026-10-08. The installed `talabat-search menu 717327 --query pizza --require-account --json` was verified after deployment: four matching items, `native_account_api`, verified profile and saved Home, no fallback. Checkout/ordering remains separately unverified and is not implemented here.

## Public API

```python
from talabat_account_catalog import run

result = run(
    mode, query='', *, branch=None, limit=10, page=1, timeout=20,
    exact=False, open_only=False, raw=False, synonyms=False,
)
```

The notation above describes the signature; for example:

```python
result = run('menu', 'pizza', branch=717327, limit=3, timeout=25)
```

Supported modes: `menu`, `hours`, `mart`, `restaurants`. Returns catalog projections; raises `TalabatError` with a sanitized code. The caller must run on the main thread with no existing SIGALRM timer, because the existing verified auth transport uses a process alarm to bound drip-fed HTTP responses. The account search path is sequential; it never sends that transport into the guest search thread pool.

The established catalog source `/Users/ardud/.local/share/app-api-cli/talabat_native.py` now routes `run(..., require_account=True)` and its existing `--require-account` flag to this adapter. Normal calls without that flag retain the guest implementation, fallback rules, and shared cache.

`require_account` rejects `force_web=True`, injected `saved` credentials, and unsupported discovery (`groceries`, `pharmacies`, `flowers`, `menu-match`). It never downgrades to guest, web, or browser. No native grocery-store discovery coverage is claimed. Direct grocery branch `hours` can return an explicitly unknown opening status after a food-menu 404; Mart product search uses its known direct branch.

## Binding and location

One `read_with_renewal(operation, deadline)` wraps the entire profile → addresses → catalog operation. It comes from the sibling `talabat_http_orders.py` and owns the sole renewal retry. On local expiry or HTTP 401 it may renew once, then repeats profile and address verification before retrying the read. HTTP 403/429, wrong account/Home, schema errors, and timeouts do not trigger adapter retries. There is no OTP path or forced renewal.

Credentials come only from Keychain `app-api-cli.native/talabat-account`. The helper checks the stored binding and verifies the live customer profile. The account adapter then calls:

```text
GET https://userlocation.talabat.com/api/v2/user/addresses?countryId=4
```

It requires all returned address records to belong to the verified expected customer, exactly one canonical Banyantree Residences Hillside home, the expected unit, UAE country 4, area 1308, nonempty saved ID, and valid coordinates/city. It never selects the first/default record. Private address/contact/ID records are discarded after projection to an instance-local in-memory location.

The saved Talabat coordinates and area drive menu, branch, and native search requests. No module `HOME_LAT`, `HOME_LNG`, or `HOME` monkeypatch is used. The returned location reports its verified source and area but omits coordinates, unit, address ID, contact values, and customer ID.

No account cache is written or read. Account data never touches the guest `SharedState` cache. All account requests use no-proxy/no-redirect transport, an exact read-route allowlist, a shared absolute deadline, a bounded response size (4 MB), sanitized failures, and filtered native headers. No raw response or credential persistence is added.

## Supported native routes

| Method | Route | Purpose |
|---|---|---|
| GET | `userlocation.talabat.com/api/v2/user/addresses?countryId=4` | Verified Home selection |
| GET | `api.talabat.com/menubff/v4/branches/{id}/menu` | Menu/live food status, saved-home query coordinates |
| GET | `api.talabat.com/grocery/v2/TB_AE/branches/{id}` | Direct grocery branch identity and catalog fee/minimum |
| POST | `api.talabat.com/search/api/v3/vendor` | Read-only native restaurant search |
| POST | `api.talabat.com/grocery/v1/bff/ae/vendors/{uuid}/products/search` | Read-only Mart product search |

POST permissions are limited to these two search paths. Cart, checkout, payment, benefits mutations and address-write routes are denied.

Restaurant search is bounded to one requested native page and at most eight sequential live branch-status checks. Other candidates remain unverified/unknown and cannot pass `--open`; the response discloses this coverage bound. An empty native page returns `NATIVE_EMPTY_UNVERIFIED_NO_FALLBACK`, because the endpoint has a history of transient empty pages. No unsupported `is_tpro_user` entitlement assertion is sent. Mart opening status remains unknown; `--open` returns no Mart items rather than inferring opening from menu presence.

Pro entitlement, account-personalized fee semantics, and checkout totals remain unverified. Output explicitly includes `benefits_verified: false` and `checkout_quote_verified: false`. Fees are labeled `native_account_catalog_not_checkout_quote`; a returned zero is not claimed as a Pro benefit or final checkout fee. Vendor Pro flags retain vendor-specific names.

## Source/deployment split

Owned files for this change:

1. `/Volumes/ExternalSSD/t3code-fork/integrations/app-api-cli/talabat_account_catalog.py`
2. `/Volumes/ExternalSSD/t3code-fork/integrations/app-api-cli/test/test_talabat_account_catalog.py`
3. `/Volumes/ExternalSSD/t3code-fork/integrations/app-api-cli/TALABAT-ACCOUNT-CATALOG.md`
4. `/Users/ardud/.local/share/app-api-cli/talabat_native.py` — established catalog **source**, not fork-managed.
5. `/Users/ardud/.local/share/app-api-cli/test/test_talabat_account_catalog_bridge.py`

The bridge lives in the established catalog source. The matching adapter, auth, list and tracking modules were deployed from the frozen fork snapshot on 2026-10-08 and their runtime hashes matched source. The ordinary installed Node launcher forwards `--require-account` correctly; the live invocation above succeeded without guest fallback. Missing/mismatched dependencies still fail explicitly with `ACCOUNT_CATALOG_DEPENDENCY_UNAVAILABLE`.

For source verification, use the fork before the catalog directory on `PYTHONPATH`, from the scratch directory rather than the runtime directory:

```sh
export PYTHONDONTWRITEBYTECODE=1
export PYTHONPATH=/Volumes/ExternalSSD/t3code-fork/integrations/app-api-cli:/Users/ardud/.local/share/app-api-cli:/Users/ardud/.local/share/app-api-cli/capture
PY=/Users/ardud/.local/share/uv/tools/mitmproxy/bin/python
$PY -m talabat_native menu pizza --branch 717327 --require-account --limit 3 --timeout 25
```

For an already-running Python process, import the fork adapter/auth before modules that force legacy runtime import paths, or start a clean process. Importing stale runtime auth first cannot be repaired safely by this adapter. The catalog module now preserves explicit caller path precedence across its legacy `native.py` import; it does not reload or replace modules already loaded in the process. Do not invoke the catalog by absolute script path for this source-only check: Python puts that runtime directory ahead of `PYTHONPATH` in that form.

## Verification

Live bounded read-only checks succeeded with automatic refresh patched to fail closed during verification (no refresh was needed):

- `menu` branch 717327, query `pizza`, limit 3: live profile + unique saved Home verified; 3 projected items.
- `mart` query `milk`, limit 3: live profile + unique saved Home verified; 3 projected products.
- `hours` branch 717327: profile/Home verified, open.
- `restaurants` query `ZeroFat`, raw native page, limit 3: profile/Home verified; 3 projected results. This verifies native search transport, not exhaustive discovery or the entire ranked live-check path.

All retained outputs were sanitized projections/status summaries, not raw responses. No OTP, auth-forcing, phone/browser, cart, order, payment, or address write was used.

Targeted regressions: 20 account-adapter tests + 5 bridge tests. Coverage includes exact owner/Home binding, ambiguous/wrong homes, invalid coordinates, allowlists, redirect/no-proxy transport, response cap, deadline, error redaction, branch mismatch, account product identity, profile-before-address ordering, exactly one renewal/rebinding cycle, non-auth no-renewal, no guest cache/network, sequential search, instance-local location, unsupported discovery, thread rejection, and unchanged guest selection.

All six existing catalog tests and five bridge tests passed after the obsolete
unconditional `LOGIN_REQUIRED` test was updated to assert the real invariant:
an account identity failure never falls back to guest network or credentials.

The four existing pacing tests passed with normal unittest discovery. A first combined ad-hoc import run could not pickle its synthetic `pacing` module for a spawned process; rerunning that suite with normal discovery passed all four. This was test-loader setup, not a catalog change.

```sh
$PY -m unittest discover -s /Volumes/ExternalSSD/t3code-fork/integrations/app-api-cli/test -p test_talabat_account_catalog.py -v
$PY -m unittest discover -s /Users/ardud/.local/share/app-api-cli/test -p test_talabat_account_catalog_bridge.py -v
$PY -m unittest discover -s /Users/ardud/.local/share/app-api-cli/test -p test_talabat_pacing.py -v
```

The original catalog lane did not deploy. Parent deployment and installed-wrapper verification are recorded above; no commit was made. The full integration suite passed287 tests, and the runtime catalog/bridge/pacing suites passed6+5+4. Checkout payload research remains a separate document; it is not a working HTTP ordering capability and has no proven safe place-order retry contract.
