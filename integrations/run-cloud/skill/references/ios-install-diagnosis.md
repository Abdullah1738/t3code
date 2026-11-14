# iOS install failures masked as provider outages

Verified 2026-11-09 for Crpko card 3263, CLI 0.2.0, Run Cloud iPhone 17e,
arm64 simulator, iOS 26.5. This is an artifact-specific diagnosis, not a claim
that Run Cloud never has outages or that every entitlement fails on every app.

## What failed

The SDK 27.2 simulator build was made with `CODE_SIGNING_ALLOWED=NO`, then the
uploaded artifact carried an ad-hoc signature with these entitlements:

- `application-identifier`
- `com.apple.developer.team-identifier`
- `com.apple.developer.associated-domains`

Creation with that app returned `502 api_origin_unavailable` with
`stage: public_api_origin`. The same failure appeared through an idempotent
mobile launch and when installing into a separately created simulator. The
mobile launch retained a failed/released session record. The service did not
return the underlying Apple install/launch error, so the internal rejection
mechanism remains unknown.

## Controlled results

| Probe | Result |
| --- | --- |
| Bare iOS session | Active in 2.8 seconds |
| Previously working prototype, same SDK and minimum OS | Installed in 9.7 seconds |
| Candidate repacked without AppleDouble/xattr metadata | Same 502 |
| Candidate re-signed with empty entitlements | Installed in 13.4 seconds; app displayed language selection |
| Original entitlements restored with the same signing procedure | Same 502 in 10.0 seconds |
| Associated-domains entitlement only | Same 502 in 9.6 seconds |
| App and team identifiers only | Same 502 in 9.3 seconds |
| Empty-entitlement variant repeated after the failing controls | Installed again in 13.4 seconds |

The metadata-only repack retained every app-file hash. The successful variant
changed only the main Mach-O's signing material and corresponding size fields;
resources, frameworks and app code were unchanged. Both XML and DER entitlement
blobs were present, so this was not simply a missing DER signature. The working
archive was still 54.3 MB. Size, SDK number, archive metadata and a general
provider outage did not explain the controlled failures.

## How to apply this finding

- Start with the artifact emitted by the simulator build, before manual signing
  or entitlement changes. Do not manually graft device
  identity or associated-domain entitlements onto an unsigned simulator build
  merely to claim universal-link coverage.
- When this failure pattern recurs, compare signing with a working simulator
  artifact. Test a separate diagnostic copy; keep the original artifact and
  record the exact change. Do not alter production/device signing settings.
- An empty-entitlement diagnostic can prove installation and basic app launch.
  Verify launch separately with a screenshot or accessibility tree.
  It cannot prove universal links, passkeys, push, or other entitlement-dependent
  behavior. Test those with an appropriate signed artifact/device and report
  any remaining QA gap explicitly.
- Deeper flows actually exercised on the diagnostic copy are evidence for
  that exact modified artifact and environment only. Name the modification;
  do not transfer the result to the original archive or untested flows.
- Do not label a successful modified artifact as runtime proof of the original
  archive. Do not treat `asset.status=ready`, a build success, or local signature
  verification as proof the app runs remotely.
- Inspect current `rcsim launch --help`, `runcloud mobile --help` and SDK docs
  before claiming installation after allocation is unsupported. The CLI and
  SDK expose different surfaces. All allocations still go through `rcsim`.

Evidence: thread `134a0dce-adb8-473c-802b-6e2b544bea09`, its
`tmp/runcloud-debug/` artifacts. Original retained Asset:
`44167c9c-ae3c-4fa5-94d0-33358667c05b`. Successful diagnostic Asset:
`6c9b04a6-f5c6-400f-b19a-d09e96337a8d`. Treat these as historical IDs, not defaults
for another task; verify availability before reuse.

Current public references:
- https://docs.run.cloud/llms-full.txt
- `@run-cloud/sdk` 0.48.0: `cloud.ios.installAsset(sessionId, assetId)`
- `runcloud mobile get <launch-id> --json` for retained launch state
