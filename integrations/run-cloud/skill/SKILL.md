---
name: run-cloud
description: Use for ANY iOS simulator or Android emulator work (app dev, QA, screenshots, Expo/RN). Local sims are blocked; use Run Cloud via rcsim.
---

# Run Cloud simulators

Owner rule (2026-10-09): agents never run local iOS simulators or Android
emulators. They drain the Mac too much. Every simulator/emulator session runs on
Run Cloud (https://run.cloud, docs https://docs.run.cloud, `llms-full.txt` for
everything). Run Cloud bills per minute while a session is up, so release
sessions as soon as you're done and between runs.

Physical devices are not affected: Abdullah's Android phone stays on
`android-phone` (`ph`), iPhone installs stay on `ios-ota-tailscale`.

## What's blocked locally

| Blocked | Where | Notes |
| --- | --- | --- |
| `xcrun simctl create/clone/boot/install/launch/openurl`, `simctl runtime add/import` | `~/.local/bin/xcrun` shim | list/shutdown/delete and all other xcrun use pass through |
| `xcodebuild test` on a Simulator destination, `-downloadPlatform`, `-importPlatform` | `~/.local/bin/xcodebuild` shim | builds (`-sdk iphoneos`, `generic/platform=iOS`) pass through |
| `emulator` | `~/.local/bin/emulator` | always refuses |
| `avdmanager create`, `sdkmanager emulator / system-images;*` | `/opt/homebrew/bin/{avdmanager,sdkmanager}` re-pointed to shims | list, delete, `--uninstall` pass |
| new sim devices / AVDs | `~/Library/Developer/CoreSimulator/Devices` and `~/.android/avd` are read-only (555) | |
| Robob device hub (`device_*` tools) | `~/.robob/userdata/settings.json` `enableDeviceSupport` / `enableAgentDeviceAccess` = false | |

Shims live in `scripts/blockers/`. `RCSIM_ALLOW_LOCAL_SIM=1` bypasses them, but
only use it when Abdullah explicitly says so. Don't remove the iOS 26.1 runtime:
`ibtool` needs it to compile storyboards for local DEVICE builds (verified: with
no runtime, `-sdk iphoneos` builds fail with "iOS 26.1 Platform Not Installed").
After a `brew upgrade --cask android-commandlinetools`, re-point the two
`/opt/homebrew/bin` symlinks to `scripts/blockers/`.

## Setup (done)

- CLI: `~/.run-cloud/bin/runcloud` (npm 0.2.183 in
  `~/.run-cloud/lib/runcloud-0.2.183`, run by node; the old 0.2.0 Bun binary
  is kept at `~/.run-cloud/bin/runcloud-0.2.0` for rollback). Always call it through
  the wrapper `~/.local/bin/runcloud`. The wrapper unsets `BUN_INSPECT` (OpenCode
  shells inherit it and every Bun binary then dies with "Failed to start
  server. Is port 49398 in use?"), loads the API key from Keychain
  (`run-cloud-api` / `ardud`) and sets `RUN_CLOUD_API_URL`.
- Account check: `runcloud account --json` (org `e9800ca6-0b3b-4a59-bdc3-a22e651237c4`).
- Dashboard / billing / API keys: https://run.cloud/dashboard. Without a payment
  method the unpaid ceiling is $5; hitting it closes every session.
- In agent shells give the CLI `</dev/null` so it never waits on a TTY.

## rcsim: the only way to create sessions

The wrapper refuses raw `runcloud ios create`, `android create` and
`mobile launch`. Use `rcsim` (`scripts/rcsim.py`, on PATH). It tags the session
with your thread, registers it with the monitor, and sends Abdullah the label +
viewer link on Telegram.

```bash
rcsim create ios --name "crpko login flow" --purpose "QA CRP-123 login screen"
rcsim create android --name "wallet apk" --purpose "smoke test" --install app.apk
rcsim launch ios --build <xcode-build-id> --name "..." --purpose "..."
rcsim launch ios --asset <asset-id> --idempotency-key <stable-key> --name "..." --purpose "..."
rcsim heartbeat              # every <=15 min while you still need it
rcsim release <id>           # or: rcsim release --mine
rcsim list [--all]           # registered sessions, owners, last heartbeat
```

- `--hard-timeout` defaults to 45m (Run Cloud max is 75m). Pick the shortest
  that fits; for longer work release and create a new one.
- `--inactivity-timeout` defaults to none. Run Cloud only enforces it through a
  connected viewer (only touch/keyboard input in the viewer resets it, watching
  doesn't), so it doesn't protect headless agent sessions. The heartbeat
  monitor and the hard timeout do.
- `--name` is the label Abdullah sees. Make it say what it is.
- Short id prefixes work for `heartbeat/release/claim/link`.
- `rcsim whoami` shows the owner thread and manager it resolved.
- If caller resolution is refused, nothing reached Run Cloud. Do not report an
  outage or bypass ownership. Follow the diagnostic; a Claude shared-session
  refusal requires a resolved Codex/OpenCode child (`robob-dispatch`).

### Heartbeats and the monitor

LaunchAgent `com.ardud.rcsim-monitor` runs `rcsim monitor` every 60s.

- Any `runcloud ios|android <cmd> <id>` call by an agent (tap, screenshot,
  logs...) counts as a heartbeat. So does `rcsim heartbeat`. If you go 15 min
  without either, you're late.
- At 16 min without a heartbeat the monitor sends your thread an automated
  steer message: heartbeat or release. Subagents' parents get it too.
- At 25 min (with a warning sent) it deletes the session and tells Abdullah on
  Telegram.
- If the owner thread is gone or archived, it deletes the session right away
  (or hands it to a pending handoff target).
- Sessions created outside rcsim (SDK, dashboard) are adopted from their tags
  and announced on Telegram, or treated as orphans (Telegram notice with the
  link) and deleted after 15 min unless someone runs `rcsim claim <id>`.

When you get a monitor message: if you still need the sim, `rcsim heartbeat`;
if not, `rcsim release <id>`. Then carry on.

### Subagents, managers and handoffs

- A subagent's parent thread becomes its manager automatically (Robob lineage or
  OpenCode `parentID`). Override with `--manager <thread-id>` or `--manager none`.
  The monitor messages the manager directly, so a parent can clean up after a
  subagent that finished without releasing.
- Briefing a subagent to use a sim: tell it to load `run-cloud`, create its own
  with rcsim and release it before it reports back. Or create it yourself and
  pass the id; then you own the heartbeats.
- Moving work to another thread: `rcsim handoff <id> --to <thread-id> [--note ...]`
  pings the new thread to `rcsim claim <id>`. You stay responsible until it
  claims; rerun `handoff` to ping it again. A new thread picking up existing work
  can `rcsim claim <id>` on its own.

## Driving a session

Coordinates are normalized 0..1 from the top-left. Acks mean "dispatched", not
"rendered": verify with a screenshot or the accessibility tree.

```bash
runcloud ios screenshot "$ID" --output tmp/shot.png
runcloud ios accessibility-tree "$ID" --json        # check `truncated`
runcloud ios tap "$ID" 0.5 0.82
runcloud ios swipe "$ID" 0.5 0.8 0.5 0.3 --duration 300
runcloud ios type-text "$ID" "hello"
runcloud android type-text "$ID" "hello"
runcloud android set-clipboard "$ID" "text"
runcloud ios press-button "$ID" home               # android: back, menu, home
runcloud ios open-url "myapp://route" --id "$ID"
runcloud ios logs "$ID" --tail 500
runcloud ios recording start "$ID" --idempotency-key rec-1 --json
# Set RECORDING_ID to the id returned by the successful recording start.
runcloud ios recording stop "$ID" "$RECORDING_ID" --json
runcloud ios recording download "$ID" "$RECORDING_ID" --output tmp/recording.mp4
```

These forms were checked against CLI 0.2.183. `open-url` takes the session via
`--id`, unlike the coordinate commands, which take the session ID positionally.
Same commands under `runcloud android`. `unsupported_action` errors are final,
don't retry them. `simulator_capacity_unavailable` means retry later.

Scripted collectors must capture both stdout and stderr, plus the exit code:
`runcloud ... --json` prints structured failure JSON on stderr. Empty stdout
does not mean there was no error. Strip signed viewer URLs before saving either
stream.

Android typing: `completed` and `characterCount` acknowledge injection, not the
field's value. With CLI 0.2.183, a 62-character onion arrived as `vwxy` (4 chars)
in Settings search. Confirm focus before input and check the field and screen
afterward. Read non-secure fields from the accessibility tree (AX).
TorSSH captures lost `"`-bearing values, labels and `contentDescription`; the
wrapper/CLI/SDK preserve these strings. Later Settings probes preserved quotes,
so check nulls against screenshots or app code before filing an app-label defect.
For secure fields, use the app's validator or a Show password toggle (confirm
masking is off before reading AX).
Ctrl+A lost focus without selecting in Settings and reportedly dismissed TorSSH
D17. Prefer touch Select all/Paste for public text; touch Paste matched six short
Settings probes (including quotes/JSON), without proving a secure-field route.

- Cursor editing (CLI 0.2.183, Settings search): `type-text abcdef` →
  `press-key arrowLeft` → `type-text X` left `abcdef`, with Back focused,
  including without intervening AX captures. Adding 0.5 s or 2 s after Left
  did not help. A single `X` in an empty focused field passed 5/5; re-tapping
  the field before typing appended correctly at all three tested waits.
  After navigation keys, check the intended input's focus before typing or
  Enter; re-focus and verify the value and cursor position. A tap may move
  the cursor. TorSSH key-strip/Enter recovery remains unverified (#123).

SDK paste: one unverified reporter success in TorSSH #15's app, using
`setClipboard(text)` + `pressKey('v', control)`. CLI Ctrl-V paste
(`set-clipboard` then `press-key v --control`) did not work in the 2026-11-14
Settings-search probe (CLI 0.2.183): all eight clipboard values matched, but
the field stayed empty (onion, JSON, quote, URL, mixed symbols, long JSON,
alphanumeric and email controls). Clear public probe text with `set-clipboard $ID ''`.
In Settings' password field, whole-text typing and Ctrl-V left it empty; `back`
after typing exited Add network. Per-key input reached Network name instead;
no route into masked fields was independently verified here. Don't press Back
blindly to hide the keyboard. After tapping a secure target, re-read AX and require
`focused=true` before typing; otherwise stop. Re-check focus and value afterward:
keys can reach another field or nowhere. System screens are affected too:
TorSSH #86's observed Set a PIN / screen-lock sighting had ACKed digit input,
`secure=true`, `focused=false` afterward and Next disabled (reported, not
independently verified). For a focused field, per-character `press-key` has one
reported hex-credential authentication success in TorSSH (alphanumeric only);
symbols and Shift remain unverified.
Never put real secrets on the clipboard or command lines that get logged or
echoed. Secret symbols remain unverified; prefer alphanumeric test credentials
when choosing them, and validate the result in the app.

The signed viewer `url` in create/get/list/delete JSON is a secret (anyone with
it can drive the session). Never print or paste it; strip it with
`jq 'del(.url)'`. rcsim redacts it and only sends it to Abdullah's Telegram.
`rcsim link <id>` resends it.

### `simulator_session_ended` (HTTP 410)

This error is non-retryable. First confirm the command used the current help's
argument form (especially `open-url URL --id ID`). Compare one
`runcloud ios get "$ID" --json` (or `android get`) with the failed data-plane
call. If get still says `active`, the control-plane record and simulator lease
disagree; `expiresAt` does not prove the simulator is usable. Stop retrying that
session, release it with `rcsim release "$ID"`, and create one fresh session
through rcsim within the task's approved budget. Record both IDs, UTC timestamps,
elapsed time since create, get status, exit codes and sanitized stdout/stderr.

Measured 13 Nov 2026 with CLI 0.2.183, bare headless sessions, inactivity timeout
`none` and hard timeout 7m: idle Android returned 410 at its first read after
6m15.7s. Busy Android and iOS both succeeded at 5m00s, then returned 410 at
5m30s despite accessibility reads every 30s. All three still reported `active`
from get until released. This is consistent with a short simulator-lease cutoff;
frequent API reads did not keep it alive. The provider's internal cause and
connected-viewer behavior remain unverified.

Finish data-plane work within about 5 minutes of `createdAt`; split longer work
across fresh sessions within the approved budget. Heartbeats and a future
`expiresAt` do not establish data-plane liveness.

## Building apps for a session

iOS: build remotely, no local simulator involved.

```bash
BUILD_ID=$(runcloud xcode build . --scheme App --until installable --json </dev/null | jq -r .id)
rcsim launch ios --build "$BUILD_ID" --name "App preview" --purpose "..."
```

- RN/Expo projects are detected from package.json (default Release). Use
  `--expo-app-dir` for monorepos, `--application-id` (stable per app) and
  `--idempotency-key` for retries (same key + different input = 409).
- Expo JS-only change: `runcloud xcode rebundle . --basis-build $BUILD_ID --expo-app-dir . --idempotency-key K --output app.tar.gz`
  then install it on a new session (`rcsim create ios --install app.tar.gz`).
  It fails with `compatibility` if native code changed; rebuild then.
- Source upload limit 100 MiB compressed; `.gitignore` is honored, plus
  `--ignore/--include`.
- Follow builds with `runcloud xcode logs <id> --follow` / `xcode get <id>`.
- Signed device builds can also run remotely (`--signing-method ...`), but
  Abdullah's iPhone path is still `ios-ota-tailscale` (local device build, no
  simulator needed).

Android: Run Cloud has no remote Gradle build. Build the APK through `offbox`
(`remote-compute` skill; no local emulator),
then `rcsim create android --install app/build/outputs/apk/debug/app-debug.apk`.
To reuse a build across sessions: `runcloud asset push app.apk -n name --json`
and `rcsim create android --install-asset <id>`; delete assets you no longer
need (`runcloud asset delete`).

Live reload: there is no private route from a Run Cloud sim to a local
server yet (#453, 13 Nov 2026). `runcloud ios tunnel` needs a sidecar on
127.0.0.1:4500 that no public channel ships, and both CLI channels (npm
0.2.183, standalone 0.2.0-cd7800d) fail with "This version of the CLI asked
for something the server doesn't have". Android has no CLI tunnel, and the
SDK's openMetroTunnel needs a transport we don't have. A sim can reach a
throwaway demo server through a temporary Cloudflare link (the
t3code-upstream-pr recipe, 13 Oct), only with Abdullah's OK for that run,
torn down right after; never point one at his real server. Otherwise iterate
with rebuild/rebundle + a fresh session, and test against a local server on a
real device: the USB-plugged Nothing Phone over home Wi-Fi (android-phone
skill; the server listens on the Mac's LAN address), or the iPhone/iPad over
Tailscale (ios-ota-tailscale + `vp run dev --share`).

`test-t3-mobile` saying "Agent device access is turned off for this
environment." is expected under the Run Cloud-only rule. Verify through
`rcsim` instead; never enable the device hub or local simulators. #188 tracks
Run Cloud in the Device panel.

## Cost discipline

- One session per task. Release it before you report back, when you switch to
  something else, or when you wait on a long build. A new session takes ~5-10s.
- Never leave a session up while waiting on Abdullah. Release it and create a
  new one when he answers.
- Before ending a turn: `rcsim list` and release anything you own that you
  aren't actively using.

## Troubleshooting

### Create or install failures: isolate before declaring an outage

`502 api_origin_unavailable` / `stage: public_api_origin` describes the failed
request boundary, not its root cause. It can mask an app-specific install or
launch failure. An upload marked `ready` proves storage, not installability.

1. Save the exact operation, platform, UTC time, elapsed time, CLI version,
   asset/build ID, request ID and error. Check `rcsim whoami` for local ownership
   failures. Redact signed viewer URLs and credentials.
2. Reconcile `runcloud ios|android list --json` (redact URLs) and any returned
   session/launch ID before retrying. A failed call can still allocate a session.
   Release only your sessions; use a short hard timeout for probes.
3. Try one bare create on the SAME platform and release it. If it works, compare
   one known-good app through the same install route and current device/runtime.
   Use `asset list` to find retained working artifacts before searching disk or
   rebuilding. Android success alone does not establish iOS health.
   If the bare create also fails, check account/quota/capacity errors and
   read-only API responses. Report the observed session-allocation failure.
   A broader outage claim needs corroboration, such as a provider incident or
   contemporaneous failures across independent controls; name only the scope
   supported by that evidence.
4. If only the candidate fails, compare its archive layout, executable modes,
   bundle metadata, every embedded binary's simulator platform/architecture and
   minimum OS, and code-signing entitlements. A successful compile or
   `codesign --verify` does not establish remote install/launch compatibility.
   Change one factor per diagnostic copy and retain the original.
5. Use current help/docs before declaring a workaround unavailable. `rcsim launch
   ios --asset ASSET_ID --idempotency-key KEY` needs no rebuild. Always choose
   and save an explicit key before a launch: rcsim's default changes with time
   and is not reliably printed on failure. Inspect a returned operation with
   `runcloud mobile get LAUNCH_ID --json`. A 502/timeout alone is an unknown
   outcome, not a terminal operation status. Reconcile sessions and replay the
   same launch input/key to recover it. Only a retained terminal failed status
   justifies a new operation key, with corrected input or evidence of recovery.
   The SDK also has `cloud.ios.installAsset(sessionId, assetId)` for a separately
   allocated, rcsim-owned session; CLI absence does not imply API absence.
   SDK calls do not pass through the wrapper heartbeat hook: explicitly
   `rcsim heartbeat SESSION_ID` while using them, and release when finished.
6. Do not blindly repeat a failed create-with-install. Apart from idempotent
   recovery of an unknown launch outcome, each additional request must test a
   stated hypothesis or follow evidence of recovery. Report the narrow failure
   and what remains unverified. A diagnostic entitlement change is not proof of the original
   app's universal links, passkeys, signing or other entitlement-dependent flows.

For the verified Crpko entitlement failure and controlled-probe results, read
[the iOS install diagnosis](references/ios-install-diagnosis.md). Do not turn
one app's result into a rule to strip entitlements from all builds.

### Local wrapper and monitor

- `Failed to start server. Is port ... in use?`: you called the raw binary.
  Use `~/.local/bin/runcloud`.
- Monitor log: `~/.local/share/rcsim/monitor.log`; state `~/.local/share/rcsim/rcsim.db`
  (tables `sims`, `events`); LaunchAgent logs `~/.local/share/rcsim/launchd.{out,err}.log`.
  `launchctl print gui/$(id -u)/com.ardud.rcsim-monitor`.
- `rcsim monitor --dry-run` shows what the monitor would do.
- Everything live, registered or not: `runcloud ios list --json | jq 'map(del(.url))'`
  (same for android).
- The official upstream skill (full CLI/SDK surface, media injection,
  recordings, embedding) is in `references/official-mobile-skill.md`.
