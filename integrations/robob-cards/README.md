# Robob Cards

Our own iMessage app, so Sendblue app cards open a Robob page right inside
Messages instead of Photon's Spectrum app (which doesn't open Sendblue cards).

- `ios/` holds the container app, the Messages extension, and a configurable
  WidgetKit extension. The Messages extension loads the tapped card's `MSMessage.url`
  in a web view: https only, compact shows the page, a tap expands it, other
  links go to the system. The widget caches its last successful response in
  its own container. Neither extension uses analytics or app-group entitlements.
- Bundle ids `com.abdullah.robob.cards` and
  `com.abdullah.robob.cards.MessagesExtension`, team `HVG39427R3`. The
  spectrum-bridge sends cards with this identity when `cardApp` in its
  config.json is
  `{"appName": "Robob Cards", "extensionBundleId": "com.abdullah.robob.cards.MessagesExtension", "teamId": "HVG39427R3"}`.
- A card only opens in the app for people who have it installed; everyone
  else sees the static card.
- On Abdullah's devices, long-press the Home Screen, tap +, and add Robob Cards.
  Long-press the widget and choose Edit Widget to select a definition from
  `https://widgets.tail`. Tailscale and the trusted .tail CA device profile are
  required; the widget can show its last cached data when offline.
- Medium and large widgets can run the actions in a definition. Each tap has a
  unique request ID; an unconfirmed or pending action can be checked using the
  Check control for that attempt, even after ten minutes. Another tap of the
  same action stays blocked until the server confirms completion. If the server
  cannot confirm the result, check the effect and tap “I checked” before starting
  again. A busy response also keeps its request ID for a manual check.
  WidgetKit chooses the actual refresh time.

## Build

`bin/robob-cards-build [--ota]` generates the Xcode project (`xcodegen`), builds
a Release device build into `~/.local/share/robob-cards/build/RobobCards.app`,
signed with the cached "Abdullah Dev Wildcard (iPhone + iPad)" development
profile, and with `--ota` publishes it to the tailnet OTA page
(`https://abdullahs-macbook-pro.tailcca332.ts.net:8460/robob-cards/`, see the
`ios-ota-tailscale` skill). Devices installing that build need Developer Mode.

## Enroll a phone outside the tailnet

`bin/robob-cards-enroll <name> [--thread ID]` gives someone whose iPhone is not
on the tailnet (Moni) one public link and prints the steps to send them. The
page runs on a Cloudflare quick tunnel for 24 hours (`--hours`) under an
unguessable `/c/<token>/` path:

1. "Register this iPhone" downloads a profile; installing it in Settings sends
   the phone's UDID back to the page.
2. The tool registers the device with the App Store Connect API, replaces the
   ad hoc profile "Robob Cards Ad Hoc - <name>" (wildcard App ID, Apple
   Distribution certificate) with one covering that person's phones, and
   re-signs the current build with it. Ad hoc builds need Developer Mode on iOS 16 and later. The first time the app is opened, iOS says "Developer Mode Required", and until it's on, every card opens blank in Messages. So the steps have the person open the app once and turn Developer Mode on if asked.
3. The same page turns into an Install page. Telegram and `--thread` hear
   about each step.

`status [name]`, `steps <name>`, `install <name> [--udid UDID]` (re-sign after a
failure or a new build) and `stop <name>` cover the rest; `--help` lists them.
State lives in `~/.local/share/robob-cards/enroll/<name>`. The App Store
Connect key and the distribution key and certificate come from
`~/.config/robob-cards/config.json` (absolute paths):

```json
{
  "asc": { "keyId": "...", "issuerId": "...", "keyPath": "/Users/ardud/.config/robob-cards/AuthKey_<id>.p8" },
  "signing": { "keyPath": "/Users/ardud/.config/robob-cards/dist.key", "certPath": "/Users/ardud/.config/robob-cards/dist.cer" }
}
```

Signing uses a throwaway keychain per run, so the login keychain and the
search list are never touched. The ad hoc re-sign removes the Widgets
extension; it is intended for Abdullah's devices only.

Apple can hold a newly registered device in `PROCESSING` for 24–72 hours.
It cannot be enabled manually or added to a profile during that hold. The
tool waits briefly with backoff, then leaves the enrollment in `preparing`
with the Apple status in `status <name>`. Re-run `install <name>` once Apple
enables it; the existing page is reused while its tunnel is still open.
Only `DISABLED` devices are re-enabled. Duplicate registration responses are
reconciled by UDID, and profile creation retries device-propagation conflicts.

Tests: `node --test test/` from this directory.
