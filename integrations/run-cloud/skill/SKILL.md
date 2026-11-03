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

- CLI: `~/.run-cloud/bin/runcloud` (0.2.0, Bun binary). Always call it through
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
runcloud ios screenshot $ID --output tmp/shot.png
runcloud ios accessibility-tree $ID --json        # check `truncated`
runcloud ios tap $ID 0.5 0.82
runcloud ios swipe $ID 0.5 0.8 0.5 0.3 --duration 300
runcloud ios type-text $ID "hello"
runcloud ios press-button $ID home               # android: back, menu, home
runcloud ios open-url $ID "myapp://route"
runcloud ios logs $ID --tail 500
runcloud ios recording start $ID --idempotency-key rec-1   # then stop / download
```

Same commands under `runcloud android`. `unsupported_action` errors are final,
don't retry them. `simulator_capacity_unavailable` means retry later.

The signed viewer `url` in create/get/list/delete JSON is a secret (anyone with
it can drive the session). Never print or paste it; strip it with
`jq 'del(.url)'`. rcsim redacts it and only sends it to Abdullah's Telegram.
`rcsim link <id>` resends it.

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

Android: Run Cloud has no remote Gradle build. Build the APK locally
(`./gradlew assembleDebug` or `npx expo prebuild` + gradle; no emulator needed),
then `rcsim create android --install app/build/outputs/apk/debug/app-debug.apk`.
To reuse a build across sessions: `runcloud asset push app.apk -n name --json`
and `rcsim create android --install-asset <id>`; delete assets you no longer
need (`runcloud asset delete`).

Live reload: `runcloud ios tunnel` needs the "Newly sidecar" on
127.0.0.1:4500, which isn't installed, and Android has no tunnel. Iterate with
rebuild/rebundle + a fresh session instead of local Metro.

## Cost discipline

- One session per task. Release it before you report back, when you switch to
  something else, or when you wait on a long build. A new session takes ~5-10s.
- Never leave a session up while waiting on Abdullah. Release it and create a
  new one when he answers.
- Before ending a turn: `rcsim list` and release anything you own that you
  aren't actively using.

## Troubleshooting

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
