# Careem 26.39 native HTTP tracking/auth contract

Current status (8 October 2026): **blocked; no CUSTOMER session**. Account
bootstrap/refresh and native Food read scaffolding are implemented, not verified
customer tracking. Guest GET userinfo and native proof-of-work returned200.
After the wire-parser correction below, one deliberate login POST returned400
with an OTP challenge and one SMS request returned202 (TTL300, four digits).
No code arrived during the60-second wait; a read-only check at97 seconds still
found no attributable incoming SMS. No resend, verification, token exchange or
account Keychain publication followed. Existing guest/phone sessions are unchanged.

Do not rerun bootstrap, delete attempt markers or request another SMS as part of
deployment. The original private scratch attempt markers remain authoritative.
Any later channel investigation must be separately scoped. The prototype auth
mutations are not hardened to Talabat's response-retention/reconciliation standard;
no automatic bootstrap/refresh is integrated into tracking. Food status mapping,
Quik/Shops and list-host binding remain pending verified customer responses.

## Historical parent execution and explicit maintenance interfaces

Deployment acceptance on 9 October: the frozen parser/auth changes and tests
are installed, with 428 Python integration tests and 14 Node transport tests
passing sequentially. This includes 18 mocked Careem auth tests, not a customer
login. No Careem network request, SMS, phone action or bootstrap was performed
for deployment. No CUSTOMER session exists; ordering and customer tracking
remain blocked. The original attempt markers are not reset by installation.

### Follow-up: first parent login400 and corrected wire parser

Parent performed one authorized login call; it returned400 with no parsed
challenge. No raw response retained, no OTP/token call/account write. Static
field annotations now prove that the original parser used the wrong enum names:

`classes.dex!ChallengeType` annotations directory0x78cbf4:
`otp`→OTP, `existing_user_confirmed`→RETURNING_USER_CONFIRMATION,
`try_another_way`→TRY_ANOTHER_WAY, plus exact lowercase password/confirm_name/
full_name/verify_name/phone_number/biometric/google.
`TryAnotherWayChallengeType` directory0x78cd1c maps lowercase
card/email/name/password/pin. The body structure was correct:
`additional_information.challenge`, `challenge_details[].challenge_name`.
The unknown400 cannot retrospectively be classified as OTP without its response.

Parser now uses only those exact wire mappings; offline tests cover them, unknown
or malformed values and safe diagnostics. The diagnostic command below documents
the interface; it is **not the next deployment step** and must not be rerun for the
already-attempted SMS flow:

```sh
~/.local/share/uv/tools/mitmproxy/bin/python -B /Volumes/ExternalSSD/t3code-fork/integrations/app-api-cli/careem_account_auth.py probe-login --execute
```

This makes exactly one login POST, returns only HTTP code, known field presence/
types and allowlisted recognized challenge names. It does not request OTP,
exchange a returned proof, publish, print raw errors, or retry—even if200. Parent
may instead call `flow.login(diagnose_only=True)` inside its existing private
scratch/marker; same behavior. No auth mutation was performed by this lane.

That earlier integration freeze had fourteen mocked tests passing. The later
offline diagnosis below changes only `careem_account_auth.py`,
`test/test_careem_account_auth.py` and this note. That research pass did not change
`careem_http_orders.py` or deploy the runtime; coordinator installation is recorded
above. Existing guest record is never
written by the bootstrap implementation.

For a future separately authorized bootstrap only, the interactive interface is:

```sh
~/.local/share/uv/tools/mitmproxy/bin/python -B /Volumes/ExternalSSD/t3code-fork/integrations/app-api-cli/careem_account_auth.py bootstrap --execute
```

Phone, SMS code and offered card-verification input use hidden prompts, never argv.
No existing account is written until token kind=CUSTOMER, token subject=profile
subject, and live userinfo phone exactly equals the entered owner phone. Published
record is `app-api-cli.native/careem-account`; pending bootstrap secrets are only
in process memory. No automatic resend or guessing of challenge answers.

For an agent handling private input without a terminal, import Bootstrap and call
`Bootstrap(phone, mutate=True)`; `.login()`, then only the returned stage's
`.request_otp()`, `.verify_otp(code)`, `.confirm_existing_user()` or
`.answer_challenge('CARD', last_four)` when CARD was explicitly offered. Other
challenge branches stop pending; captcha is never fabricated. `.publish()` makes
the sole account write after fresh verification. Keep the same object alive;
never serialize it to a scratch file or print raw responses.

`status` reads local account metadata only. `refresh --execute` performs the exact
native renewal, preserves rotated material privately if verification is transiently
unavailable, and publishes it as usable only after live owner-profile binding.
CLI serializes bootstrap/refresh with a separate account lock. No automatic
refresh is hidden inside order reads.

`careem_http_orders.track(order, timeout=12, service='food')` is available for the
first account read after publication. It re-verifies customer/profile and exact
reference/service; raw static status names remain `status:unknown`, ETA/rider null,
until actual server stages are validated. Quik/Shops and list-host binding fail
explicitly; no UI or guest fallback. These are honest pending pieces, not a claim
that the delivery CLI is already live.

### Header/client provenance established, original-app parity not established

`classes2.dex!tr9.intercept`0x2763c4 supplies x-careem-device-id, Agent, User-Agent,
Accept-Language, X-Careem-Operating-System, Version, Provider-Access-Key,
X-Careem-Session-Id, X-Careem-Version, x-careem-userid.
`classes2.dex!tx3.intercept`0x21de94 supplies Authorization from the current auth
provider. This matches the saved `/userinfo` guest template, which successfully
replayed native GET `/identity/guard/pow` and `/userinfo` in this continuation.
Only these allowlisted header names are reused; request traces/cookies are dropped.
The Basic client ID decoded privately equals the guest JWT azp (verified boolean
only). `IdentityInitializer` installs x8m as OTP client provider;
`classes6.dex!x8m.invoke`0x3ece50..0x3ece58 resolves IdpComponent.clientConfig's same
client ID. No opaque provider/client values are stored in source or fixtures.

The OTP caller's default mask4 sets multiTimeUse=false; code uses that value.
PoW exact input is `{version}:{complexity}:{timestamp}:{seed}:{counter}` and guard
is `pow:{seed}:{counter}`. Read-only live PoW returned version1/SHA-1/complexity3;
bootstrap computes only a fresh server challenge with a bounded local deadline.
Only the login challenge and SMS acceptance described above were verified live;
code verification, token exchange and current captcha policy remain unverified.

Assets: `/private/var/folders/vt/8qndzr_j44z70bh0rn2zyfkm0000gn/T/opencode/careem-live/`
original `base.apk`, version26.39/versionCode263900, targetSDK36. Seven DEX files;
no bundled Hermes application. Offsets below are DEX byte offsets, not runtime PCs.

## Exact native existing-account flow

### 1. Phone login / challenge negotiation

POST `https://sagateway.careem-engineering.com/onboarder/login/customer/phone`.

- `classes5.dex!com.careem.identity.onboarder_api.OnboarderApi.phoneLogin`:
  Retrofit POST `login/customer/phone`, header `x-idp-client-id`, JSON body
  `PhoneLoginRequest`, response `ProofToken`.
- Base URL in `classes.dex!OnboarderEnvironment.<clinit>` at0x2e8188.
- `classes4.dex!PhoneLoginRequestJsonAdapter.<init>` at0x4c1a5c establishes fields:
  `phone_number`, `password`, `device_id`, `otp`, `name_confirmed`,
  `client_metadata`, `biometric_setup_available`, `secret_key_available`,
  `full_name`, `card_verification`, `email_verification`,
  `full_name_verification`, `pin`, `existing_user_confirmed`.
  These are the complete DTO fields, not a claim all must be populated.
- `ClientMetadataJsonAdapter` at0x4c0354 has `login_strategy`.
- `classes5.dex!cef.invokeSuspend` at0x2aa9a2..0x2aaa0e gets client id from
  ClientConfig, copies the request with generated/lowercased device ID, then calls
  phoneLogin. Preserve a consistent device identity through the flow.
- Onboarder uses `AuthorizationInterceptor`: User-Agent and
  `Authorization: Basic base64(client_id:client_secret)`
  (`classes4.dex`0x450884). Public client configuration values were not printed.
- `DeviceIdInterceptor.intercept` (`classes.dex`0x58f978) adds optional nonempty
  `Device`, `androidId`, `androidAdId`; configured shared interceptors are also
  installed. Full original gateway header composition is not yet traced.

Errors are structured `error`, `error_description`, `additional_information`.
AdditionalInfo contains `error_code`, `challenge`, `challenge_details`. Native
challenge enum includes OTP, PASSWORD, CONFIRM_NAME, FULL_NAME, VERIFY_NAME,
TRY_ANOTHER_WAY, RETURNING_USER_CONFIRMATION. A400 can be a challenge transition,
not proof login is impossible. Do not loop or bypass the returned challenge.

### 2. OTP request and verification

Production base URL is
`https://sagateway.careem-engineering.com/identity/client/`
(`classes.dex!OtpEnvironment.<clinit>`0x2e8494).

- POST `otp`: JSON GenerateOtpRequestDto fields `client_id`, `identifier`, `type`,
  `locale`, `multiTimeUse`, `guard`, `captcha`.
  Serializer `classes6.dex`0x707b88. OtpType names include SMS, VOICE, EMAIL,
  WHATSAPP; exact serializer/provider choice must be respected.
- Response fields: `retry_in`, `expires_in`, `otp_length`
  (`classes4.dex`0x4c435c).
- POST `otp/verification`: JSON `{client_id, identifier, code}`;
  serializer `classes4.dex`0x4c4800. Response `{id, provider}` at0x4c4a68.
- `LoginVerifyOtpProcessor.toMiddlewareAction`0x578680..0x5786ac consumes the
  verification result ID, not the entered SMS digits, for RequestToken.
- ReturningUserLogin.login (`classes4.dex`0x55446c) reads LoginConfig's
  verificationId and returning-user choice and calls phoneLogin again.
- VerifyCardLogin.login0x56654c uses the same phoneLogin endpoint with
  card_verification; email/name/password/pin alternatives have separate native
  handlers. Only answer the legitimate challenge actually returned.

OTP transport uses configured shared HttpClientConfig interceptors and an
additional LocationInterceptor. Historical capture reported provider-access-key,
authorization, agent/version, x-careem device/session headers; their exact required
values/precedence are not established by the Retrofit annotation alone. Do not
assume onboarder Basic credentials alone reproduce the OTP gateway request.

More precise dependency seam: `classes.dex!xpn.invoke`0x428f80 passes the existing
OkHttpClient into HttpClientConfig; constructor defaults its extra interceptor
provider (mask0x1c0). `classes6.dex!di80.<init>`0x5d8b40 wires
LocationInterceptor_Factory into OTP's NetworkModule_ProvideHttpClientFactory.
Thus remaining OTP Authorization/provider headers must be traced in the supplied
base OkHttpClient, not invented as part of OtpApi's JSON/annotations.

### 3. Optional proof-of-work / captcha inputs

GET `https://sagateway.careem-engineering.com/identity/guard/pow` is annotated in
PowApi, with base in PowEnvironment0x2ea088.
Response fields: `version`, `seed`, `timestamp`, `algorithm`, `complexity`
(`PowResponseDtoJsonAdapter`, classes4.dex0x4e30e8).
Native supported algorithm is SHA-1; PowComputationImpl constructs input using
version/complexity/timestamp/seed/counter and searches for the required zero
prefix. `ComputationResult.getOutput`0x4e224c serializes `pow:<seed>:<counter>` into
the `guard` field. The initial static-research lane did not fetch a challenge;
later parent execution verified the guest PoW flow as described above.
`is_mobile_proof_of_work_enabled` controls the branch; a separate
generateOtpWithPowWithRecaptcha branch exists. Captcha policy/current flags remain
runtime unknown. Do not invent guard/captcha values.

### 4. Proof token exchange

Successful phoneLogin returns ProofToken JSON fields `token`, `user_id`,
`expired_dat`, `additional_information` (the spelling is literal from its
serializer at classes5.dex0x4f5d80).

`OnboarderServiceImpl.access$fetchAccessTokenFromIdp` (classes.dex0x590624) puts
ProofToken.token into a map under `token`, selects enum PROOF, and calls Idp.
`TokenRequestGrantType.<clinit>` (classes3.dex0xacc97e) gives exact grant string:

`urn:careem:oauth2:grant_type:proof`

POST `https://identity.careem.com/token`, form-urlencoded:

```text
grant_type=urn:careem:oauth2:grant_type:proof
token=<fresh onboarder proof>
device_id=<consistent Idp-generated device ID>
client_id=<ClientConfig value>
client_secret=<ClientConfig value>
```

Headers: User-Agent and Basic client Authorization, from ClientConfigEncoder.
`classes.dex!IdpApi.getToken` annotations and
`classes3.dex!TokenService.requestToken`0xacda20..0xacdab4 prove this map-based
branch. Optional nullable form entries may be omitted by Retrofit; this lane did
not inspect production credential values or their runtime nullability.

Legacy PHONE and MIGRATION grants also exist, but the observed current onboarder
code explicitly takes the PROOF route. Their existence does not authorize a
shortcut around OTP/returning-user challenges.

### 5. Customer renewal

Same POST `https://identity.careem.com/token`, form-urlencoded, Basic auth and
User-Agent. IdpApi.requestTokenRefresh declares fields:
`grant_type`, `response_type`, `refresh_token`, `client_id`, `client_secret`.

RefreshQueue.access$refreshToken (`classes.dex`0x57fc08) constructs:
`grant_type=refresh_token`, `response_type=token`, stored refresh_token.
`classes3.dex!tokenRefresh.a.invokeSuspend`0xacfb6c..0xacfc2e passes ClientConfig
and those fields. Preserve rotated access/refresh material atomically after
successful owner-account identity validation.

The existing careem_auth.py is intentionally **GUEST-only**. Do not reuse its
Keychain record for the customer account or invoke it to bootstrap this flow.
Use a separate future `careem-account` record; verify non-GUEST identity, exact
owner phone/customer binding, and saved Home before claiming authenticated scope.

## Exact tracking read

GET
`https://sdui-activities.core.gw.prod.careem-rh.com/v1/activity-tracker/{service}/{reference_id}`

`classes6.dex!com.careem.superapp.feature.ordertracking.api.OrderTrackingApi`
`getOrderTrackingDetails` declares path/query mapping, in parameter order:

1. Path `reference_id` (String)
2. Path `service` (String)
3. Query `military_time_format` (boolean)
4. Query `time_zone` (String)
5. Query `language` (String)
6. Query `image_scale` (String)
7. Query `provider_id` (String)
8. Query `latitude` (Double)
9. Query `longitude` (Double)

Base URL and Retrofit binding are proven together in `classes6.dex!vcq.get`
0x434a8c..0x434b0c; production URL loaded0x434ade. Caller `a8y.a`0x4c7ff0..0x4c81a6
derives 24h preference, timezone, app locale, image scale, provider and location.
Exact current query values were not read. Native food deeplink establishes
`service=food`; groceries/shops enums exist but wire spellings and provider binding
need caller/live verification before issuing requests for those verticals.

### Response identity/status seam

OrderTrackingResponseJsonAdapter (classes6.dex0x75a6d8): root
`info`, `sections`, `meta`, `navigation`, `microtracker`, `sticky_footer`,
`multiple_tracking`, `auto_actions`.

`info` is OrderInfo (adapter0x780140): `reference_id`, `activity_id`, `service`,
`status`, `service_specific_status`, `activity_status`, `activity_type`,
`provider`, `initial_eta`, `upfront_eta`, `current_eta`, `eta_state`, etc.
Require exact requested reference/service and owner-account evidence. Do not
persist contact/payment/address/PIN/auto-action payloads.

Status enum names found: Pending, Preparing, Coming, Arrived, Enroute, Completed,
Cancelled, Unknown (`z3y.<clinit>`0x4c578c). These are not yet live-proven JSON
values or delivery mappings. `sections[].tracking` has `stages`, `current_index`,
header; future stage labels cannot certify completion. Metadata has poll_after,
restart_polling_at, server_timestamp (adapter0x75a100).

## Legacy order-list/detail reads

`classes5.dex!com.careem.motcore.common.order.OrderApi` annotations:

- GET `v2/orders` with `limit`, `sort`, QueryMap; pagination overload accepts URL.
- GET `v2/orders/action` with dismissed_actions, tracking.
- GET `v3/orders/action` with domain, dismissed_actions, tracking.
- GET `v2/orders/{orderId}` with tracking.
- GET `v1/food/orders/{orderId}` with tracking.
- GET `v1/{domain}/orders/{orderId}` with tracking.

Food/groceries production host enums exist, but full OrderApi dependency-to-host
selection is not proven. Do not combine a route and nearby hostname by guess.
OrderTrackingApi's `/orders/{id}/status` methods are POST/PATCH mutations, **not
tracking reads**; they are excluded.

## Smallest remaining blocker / next action

The already-attempted bootstrap reached an OTP challenge and HTTP202 but produced
no observed SMS. **Do not run another bootstrap as the next action.** A CUSTOMER
session is still absent. The public DTO/route contract does not establish all
runtime prerequisites, app/session equivalence, SMS dispatch or delivery. The
owner reports that the normal app sends SMS; that comparison has not yet been
matched by app version, channel, time and client/session provenance. See the
offline diagnosis and parent-only observation plan below. No cheap test order is
useful until a legitimate customer session and historical own-order read work.

After bootstrap, use the existing own Food order as the first exact tracking
probe, then validate Quik/Shops reference/service and actual active states. Store
only sanitized structural fixtures. No automatic auth retry or guest-to-account
replacement is implemented here.

Earlier static evidence/indexer:
`/Users/ardud/.robob/scratch/2026-10-08-thread-provider-opencode-provider-instance-c7c79aae/tmp/careem-http/`.

## Offline SMS202 diagnosis — 8 October 2026

### Scope and conclusion

This pass used local source, the public original26.39 APK above, and existing
sanitized historical notes only. No website, phone, live API, Keychain read/write,
guest refresh, login/OTP/token request or order mutation was performed. The old
bootstrap script and attempt markers were not rerun, removed or modified. No
integrity, CAPTCHA, rate-limit or device-identity workaround was implemented.

**Root cause remains unproven.** HTTP202 with expiry/length metadata is request
acceptance, not evidence that Careem dispatched an SMS or the handset received
one. There is no local deterministic reproduction of the remote non-delivery;
mocked tests below prove response/state safety only. They do not prove a fix for
SMS delivery or readiness for a new live attempt.

Historical `CAREEM-NOTES.md` also records a diagnostic-clone SMS202/no-code result
on3 October. That means Python transport is not the only context in which this
symptom occurred. The stored guest template came from that separate clone, not
from the successfully logged-in original app. This provenance is relevant; it
does not establish a server rejection reason. Do not retry clone sign-in.

Existing capture helpers retained auth request method/host/redacted path,
header/body field names and response status, not auth values or response bodies.
Private templates were limited to catalog/profile GETs. Therefore old metadata
cannot reconstruct a byte-for-byte successful-original/failed-HTTP comparison,
nor verify equal device, current session or captcha state. No credentials or raw
capture data were read in this pass.

### Proven wire matches — leave these alone

- Production OTP host/path and request DTO match the APK. PROD is the gateway
  `identity/client/` URL; STAGING is a different careem-internal.com environment
  (`classes.dex!OtpEnvironment.<clinit>`0x2e8470, PROD0x2e8494,
  STAGING0x2e84a6). Existing code does not target staging.
- OTP channel **`SMS` is uppercase on the wire**. `classes4.dex!OtpType.<clinit>`
  at0x4c3374 constructs SMS at0x4c3388, plus VOICE/EMAIL/WHATSAPP. Unlike the
  challenge enums, it has no lowercase Moshi field aliases; the request adapter
  uses its OtpType adapter. The earlier lowercase challenge-parser correction
  must not be applied to the SMS request type. Actual normal-app selected channel
  still needs observation; an `otp` challenge alone does not prove SMS selection.
- `multiTimeUse=false` follows the default mask; the identifier is E.164, with
  locale `en` in this client. Null optional DTO fields can be omitted. No evidence
  supports fabricating app biometric/secret-key capabilities or filling every
  nullable phone-login field.
- Verification returns an ID that goes in the next phone-login `otp` field; raw
  SMS digits do not belong there. Proof exchange uses the existing proof grant.
- PKCE is present in the APK's separate SSO WebView path
  (`classes3.dex!ky3.a`0x27dd98, SingleSignOnActivity/authorize code challenge).
  It was not found in the native phone-login/OTP/proof DTO flow. No native flowID
  field is established by these DTOs either. Do not add guessed PKCE/state/flowID
  fields to the OTP request; this is not a claim the entire app lacks them.

### Proven differences and remaining unknowns

1. **Normal phone entry can execute reCAPTCHA as well as PoW.**
   `classes4.dex!sg3.invokeSuspend`0x1d631c..0x1d6346 obtains the OTP service and
   IdentityRecaptcha, supplies action `phone_entry`, and invokes
   `generateOtpWithPowAndRecaptcha$default`. OTPService's implementation at
   `classes.dex`0x593914 checks `is_mobile_proof_of_work_enabled` at0x593a02.
   In the combined branch, `ef0.invokeSuspend`0x19ad5c..0x19ae08 starts and awaits
   both tasks; `classes5.dex!zkw.invokeSuspend` calls IdentityRecaptcha.execute
   at0x33deca, while `classes6.dex!orw.invokeSuspend`0x4aef88..0x4aef98 performs
   PoW computation. Python supplies fresh PoW only. Runtime flag values, the
   reCAPTCHA result and server enforcement are unknown. This is a contract gap,
   **not proof that missing captcha caused the202/no-SMS result**. A required
   challenge must be completed through the legitimate supported flow or remain
   blocked; no fabricated/replayed captcha or proof from another session.

2. **OTP location header is absent from the custom request.**
   OTP NetworkModule.provideHttpClient (`classes.dex`0x5934b8) derives the shared
   client and installs LocationInterceptor. `classes4.dex!r4s.invokeSuspend`
   gets CurrentLocation at0x31f0de, formats it at0x31f0f2, and conditionally adds
   `x-careem-geocoordinates` at0x31f10a..0x31f10e; the null-result branch at0x31f0fa
   skips the addition. CurrentLocationImpl requests low-power location;
   CurrentLocationKt.string at0x4c28d0 uses English latitude/longitude separated
   by comma-space. Python's header allowlist excludes it. This is a difference,
   not proof of a mandatory header or rejection. Saved Home is not live device
   location; do not populate a guessed coordinate to imitate the app.

3. **Captured shared headers are not a current original-app session.**
   `classes2.dex!tr9.intercept`0x2763c4 obtains dynamic device/client properties;
   X-Careem-Session-Id at0x2764e4 comes from `toa0.a`
   (`classes.dex`0x3284d4), which returns its currentSessionId field. Python
   reuses a saved guest template; historical capture was26.38, while this APK is
   26.39. Guest JWT azp matching Basic client ID proves those two credentials
   agree, not that provider/device/version/session values equal the original's
   current values or that all session prerequisites are satisfied. Merely editing
   version/User-Agent, copying an app session, or randomizing identifiers would
   not establish legitimate client provenance.

4. **Onboarder device ID and shared device header are not proven interchangeable.**
   `classes5.dex!cef.invokeSuspend` calls AndroidIdGenerator.getDeviceId at
   0x2aa9b0 and lowercases with Locale.ROOT at0x2aa9c4 before the body copy at
   0x2aaa02. AndroidIdGenerator's constructor (`classes.dex`0x2c8a10) reads
   Settings.Secure.android_id at0x2c8a34..0x2c8a38 and uppercases with Locale.US
   at0x2c8a50; getDeviceId at0x57e500 returns its state flow. The lowercase body
   is intentional, not evidence all headers/token fields should be lowercased.
   Python currently derives this ID from captured x-careem-device-id. That
   shared header is `dtm.c`/field b, initialized through `kzd`/`jzd`→`wxf.a`
   (`classes2.dex`0x2e8dc8). That resolver has an async supplier and fallback
   `txf.a` (`classes6.dex`0x36d220), which also has a Settings.Secure.android_id
   branch at0x36d36e..0x36d372. Full runtime branch/equality is not established.
   No ID values were inspected or changed, and no device impersonation is a fix.

5. **OTP success response validation was weaker than the native DTO.**
   GenerateOtpResponseDtoJsonAdapter constructor (`classes4.dex`0x4c435c)
   uses integer adapters for all three fields: retry_in, expires_in, otp_length.
   fromJson at0x4c41f0 has missing-required checks at0x4c42fe,0x4c4308,0x4c4312.
   Python previously ignored retry_in and labeled202 `otp_sent`. These are proven
   local interpretation defects, not the cause of remote SMS non-delivery.

Python urllib versus OkHttp is another transport difference. Current evidence
does not identify TLS/client fingerprinting as the cause; do not introduce
fingerprint spoofing, alternate routes, proxy changes or broad retry probes.

### Ranked, falsifiable hypotheses (not findings)

| Priority | Hypothesis | Evidence that would distinguish it |
| --- | --- | --- |
| 1 | The initial OTP flow needs a runtime challenge/prerequisite not supplied by this client. | Legitimate original-app diagnostics or provider-supported integration documents show whether the combined PoW/reCAPTCHA branch actually executes and what required state is missing. Presence of the method alone is insufficient. |
| 2 | Clone-derived guest/client/device/session context is not equivalent to the successful original. | Authorized, private in-memory provenance checks or provider diagnostics establish which identifiers are expected to agree and whether this flow has valid independent client/session context. Do not copy identifiers or alter app integrity to test it. |
| 3 | The compared successful flow used a different channel, destination, app version or time window. | Parent-only read-only observation of the already-present channel label/masked destination and existing message timestamps establishes an actually comparable SMS event without requesting another code. |
| 4 | Backend anti-abuse policy, cooldown or downstream SMS delivery accepted the request but withheld/failed dispatch. | Provider-side request diagnostics/delivery receipts, or an explicitly supported error field, distinguish queued, suppressed, failed and delivered.202 plus retry_in is not a delivery receipt. No retry loop may be used to test this. |
| 5 | Optional location/context differences affect handling. | Provider requirements or legitimate original diagnostics show that location is required in this situation; the APK's optional header alone does not establish it. |

### Narrow implementation changes and offline verification

Only the auth module and its focused tests changed; no speculative request field,
header, endpoint, identifier, PoW or CAPTCHA change was made:

- `request_otp()` now returns stage `otp_request_accepted`,
  `acceptance_verified:true`, `delivery_verified:false`, HTTP status and validated
  retry_in/expires_in/otp_length. Acceptance never means SMS dispatch or delivery.
- The native three integer fields are required; booleans, floats, strings,
  missing/null fields and error/challenge envelopes fail closed. Local supported
  bounds remain TTL1..3600 seconds and length4..8; retry_in is a nonnegative
  signed32-bit integer. These are client safety bounds, not a claim of every
  backend-supported value. Additional unrelated fields are neither retained nor
  printed; error/challenge envelope rejection is a local conservative policy.
- `flow.otp_result` retains only allowlisted schema/types/recognized enums for a
  received but unverified response. A transport failure leaves
  `otp_request_outcome_unknown`, acceptance_verified false and delivery_verified
  false. False means evidence is absent, not proof the server did nothing.
  No raw errors, IDs, destination, captcha, tokens or response dumps are retained
  in this diagnostic. The CLI still emits its bounded error; an authorized caller
  can inspect this safe in-memory field when catching AccountError.
- The legacy `otp_sent` attribute remains for compatibility but means only
  **attempt consumed**. It is set before POST and never reset for failed,
  ambiguous or malformed responses. retry_in is diagnostic only: no resend
  facility is implemented. The latch is per object, not a durable global fence;
  parent must continue respecting the existing private attempt markers.
- OTP expiry starts before the POST, so response latency cannot extend validity.
- A fresh login invalidates previous challenge, token-publication and OTP-window
  state before calling transport, including failures and diagnostic-only calls.
  OTP verification also requires the current OTP challenge. Attempt latches are
  not reset. This prevents an earlier accepted challenge being reused after a
  failed or different negotiation.

Red/green verification: new regressions first failed against the old code on
`otp_sent`, missing retry_in, mixed error202, missing safe outcome, expiry gaining
request latency, and stale negotiation state. The final focused run passes
**18 auth tests +4 unchanged Careem read tests =22 distinct tests**. Test count
does not multiply parameterized cases. All socket connects, subprocess launches,
Keychain load/store and unmocked transport boundaries were denied. No full suite,
live verification, deployment, commit or push was performed in this pass.

Reproducible auth-only command (its setUp denies external boundaries):

```sh
cd /Volumes/ExternalSSD/t3code-fork/integrations/app-api-cli
PYTHONDONTWRITEBYTECODE=1 ~/.local/share/uv/tools/mitmproxy/bin/python -B -m unittest test.test_careem_account_auth -v
```

### Parent-only next observation, without sending another SMS

1. Preserve the signed-in original session. Check phone priority-hold before any
   parent phone batch; this lane does not use the phone. Do not log out, edit the
   phone number, reinstall, clone, root, change proxy or modify saved account data.
2. Establish original app version and whether the owner's successful event was
   SMS, WhatsApp, voice or another existing channel. Read only a currently visible
   channel label/masked destination and already-existing attributable message
   timestamp. Do not tap Send/Continue/Resend or read/export OTP values. If the
   login screen cannot be observed without logging out or starting a new flow,
   record that blocker rather than navigating through an auth mutation.
3. Use legitimate provider support/documentation for dispatch/challenge policy
   if these observations cannot establish the gap. No successful original HTTP
   trace is currently available; APK shape cannot substitute for it.
4. A later fresh auth attempt needs separate explicit authorization and a scoped
   supported flow with prerequisites understood. It is not authorized by this
   diagnosis or by deploying these source changes. Leave the old script/markers
   untouched. If CAPTCHA/integrity or provider restrictions cannot be satisfied
   legitimately, stop at that boundary rather than trying to make a custom client
   look like the original app.202 alone is still not successful bootstrap.

Careem remains blocked for CUSTOMER HTTP tracking and all Food/Quik/Shops HTTP
ordering. Existing guest catalog, deployed tracking fallbacks and original phone
session are unchanged. Changes in these three owned files are frozen for parent
review/integration; this lane has not deployed them.
