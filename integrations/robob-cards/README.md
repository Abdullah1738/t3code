# Robob Cards

Our own iMessage app, so Sendblue app cards open a Robob page right inside
Messages instead of Photon's Spectrum app (which doesn't open Sendblue cards).

- `ios/` holds the container app (one "Robob Cards is installed" screen) and
  the Messages extension. The extension loads the tapped card's `MSMessage.url`
  in a web view: https only, compact shows the page, a tap expands it, other
  links go to the system. No storage, analytics or entitlements.
- Bundle ids `com.abdullah.robob.cards` and
  `com.abdullah.robob.cards.MessagesExtension`, team `HVG39427R3`. The
  spectrum-bridge sends cards with this identity when `cardApp` in its
  config.json is
  `{"appName": "Robob Cards", "extensionBundleId": "com.abdullah.robob.cards.MessagesExtension", "teamId": "HVG39427R3"}`.
- A card only opens in the app for people who have it installed; everyone
  else sees the static card.

## Build

`bin/robob-cards-build [--ota]` generates the Xcode project (`xcodegen`), builds
a Release device build into `~/.local/share/robob-cards/build/RobobCards.app`,
signed with the cached "Abdullah Dev Wildcard (iPhone + iPad)" development
profile, and with `--ota` publishes it to the tailnet OTA page
(`https://abdullahs-macbook-pro.tailcca332.ts.net:8460/robob-cards/`, see the
`ios-ota-tailscale` skill). Devices installing that build need Developer Mode.
