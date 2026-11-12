import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../bin/robob-cards-build", import.meta.url));
// Source the real script with shell-function stand-ins, without invoking Xcode or signing.
const harness = `
function /opt/homebrew/bin/xcodegen { :; }
function xcodebuild {
  local built="$ROBOB_CARDS_HOME/build/derived/Build/Products/Release-iphoneos/RobobCards.app"
  mkdir -p "$built"
  cp -R "$FIXTURE"/. "$built"/
}
function ditto { cp -R "$1" "$2"; }
function codesign { print verified > "$VERIFY_MARKER"; }
source "$BUILD_SCRIPT"
`;

for (const { name, messagesProfile, widgetsProfile, widgetsPresent = true } of [
  { name: "both profiles are present", messagesProfile: true, widgetsProfile: true },
  { name: "the Messages profile is missing", messagesProfile: false, widgetsProfile: true },
  { name: "the Widgets profile is missing", messagesProfile: true, widgetsProfile: false },
  { name: "the Widgets extension is missing", messagesProfile: true, widgetsProfile: false, widgetsPresent: false },
]) {
  test(`the build checks extension profiles before verifying when ${name}`, () => {
    const root = mkdtempSync(join(tmpdir(), "robob-cards-build-test-"));
    try {
      const fixture = join(root, "fixture");
      const marker = join(root, "verified");
      for (const [name, present] of [["RobobCardsMessages", messagesProfile], ["RobobCardsWidgets", widgetsProfile]]) {
        if (name === "RobobCardsWidgets" && !widgetsPresent) continue;
        const extension = join(fixture, "PlugIns", `${name}.appex`);
        mkdirSync(extension, { recursive: true });
        if (present) writeFileSync(join(extension, "embedded.mobileprovision"), "development-profile");
      }
      const result = spawnSync("/bin/zsh", ["-c", harness], {
        encoding: "utf8",
        env: { ...process.env, ROBOB_CARDS_HOME: join(root, "home"), FIXTURE: fixture, VERIFY_MARKER: marker, BUILD_SCRIPT: script },
      });
      assert.ifError(result.error);
      if (messagesProfile && widgetsProfile) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(existsSync(marker), true);
      } else {
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, messagesProfile ? /Widgets extension is missing its profile/ : /Messages extension is missing its profile/);
        assert.equal(existsSync(marker), false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
