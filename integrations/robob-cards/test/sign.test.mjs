import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { APP_ID, resignAdHoc } from "../lib/sign.mjs";

const messages = "PlugIns/RobobCardsMessages.appex";
const widgets = "PlugIns/RobobCardsWidgets.appex";
const otherExtension = "PlugIns/Another.appex";

for (const hasWidgets of [true, false]) {
  test(`ad hoc signing keeps Messages and excludes widgets${hasWidgets ? " from the staged copy" : " when already absent"}`, () => {
    const root = mkdtempSync(join(tmpdir(), "robob-cards-sign-test-"));
    const app = join(root, "original", "RobobCards.app");
    const outDir = join(root, "output");
    const profilePath = join(root, "adhoc.mobileprovision");
    let staged;
    const signed = [];
    try {
      mkdirSync(join(app, messages), { recursive: true });
      mkdirSync(join(app, otherExtension), { recursive: true });
      writeFileSync(join(app, "Info.plist"), JSON.stringify({ CFBundleIdentifier: APP_ID, CFBundleShortVersionString: "1.1" }));
      writeFileSync(join(app, messages, "Info.plist"), JSON.stringify({ CFBundleIdentifier: `${APP_ID}.MessagesExtension` }));
      writeFileSync(join(app, messages, "MessagesBinary"), "messages-binary");
      writeFileSync(join(app, otherExtension, "UnrelatedBinary"), "other-binary");
      if (hasWidgets) {
        mkdirSync(join(app, widgets), { recursive: true });
        writeFileSync(join(app, widgets, "WidgetsBinary"), "widgets-binary");
      }
      writeFileSync(profilePath, "ad-hoc-profile");

      const runCommand = (command, args, options = {}) => {
        if (command === "/usr/bin/ditto") {
          assert.equal(args[0], app);
          staged = args[1];
          cpSync(app, staged, { recursive: true });
          return "";
        }
        if (command === "/usr/bin/security" && args[0] === "cms") {
          return JSON.stringify({ UUID: "PROFILE", Name: "Ad Hoc", ExpirationDate: "2027-01-01", ProvisionedDevices: ["PHONE"] });
        }
        if (command === "/usr/bin/plutil") {
          const value = JSON.parse(readFileSync(args.at(-1), "utf8"))[args[1]];
          assert.notEqual(value, undefined, args[1]);
          return args[2] === "json" ? JSON.stringify(value) : String(value);
        }
        if (command === "/usr/bin/openssl" && args.includes("-serial")) {
          return "serial=ABCDEF\nSHA1 Fingerprint=11:22:33:44\n";
        }
        if (command === "/usr/bin/openssl" || command === "/usr/bin/security") return "";
        if (command === "/usr/bin/codesign") {
          if (args[0] === "--verify") {
            assert.equal(args.at(-1), staged);
            assert.deepEqual(signed, [join(staged, messages), staged]);
          } else {
            const target = args.at(-1);
            assert.equal(existsSync(join(staged, widgets)), false, "widget must be removed before signing");
            assert.equal(readFileSync(join(staged, messages, "MessagesBinary"), "utf8"), "messages-binary");
            assert.equal(readFileSync(join(staged, otherExtension, "UnrelatedBinary"), "utf8"), "other-binary");
            assert.equal(readFileSync(join(target, "embedded.mobileprovision"), "utf8"), "ad-hoc-profile");
            writeFileSync(join(target, "mock-signature"), "signed");
            signed.push(target);
          }
          return "";
        }
        if (command === "/usr/bin/zip") {
          return execFileSync(command, args, options);
        }
        assert.fail(`unexpected command ${command}`);
      };

      const result = resignAdHoc({ app, profilePath, signing: { certPath: "/cert", keyPath: "/key" }, outDir, runCommand });
      assert.deepEqual(signed, [join(staged, messages), staged], "Messages must be signed before its container");
      assert.deepEqual({ bundleId: result.bundleId, version: result.version, devices: result.devices }, {
        bundleId: APP_ID, version: "1.1", devices: ["PHONE"],
      });
      const entries = execFileSync("/usr/bin/unzip", ["-Z1", result.ipa], { encoding: "utf8" }).split("\n");
      assert.ok(entries.includes(`Payload/RobobCards.app/${messages}/MessagesBinary`));
      assert.ok(entries.includes(`Payload/RobobCards.app/${messages}/mock-signature`));
      assert.ok(entries.includes("Payload/RobobCards.app/mock-signature"));
      assert.ok(entries.includes(`Payload/RobobCards.app/${otherExtension}/UnrelatedBinary`));
      assert.ok(!entries.some((entry) => entry.includes("RobobCardsWidgets.appex")));
      assert.equal(execFileSync("/usr/bin/unzip", ["-p", result.ipa, `Payload/RobobCards.app/${messages}/MessagesBinary`], { encoding: "utf8" }), "messages-binary");
      assert.equal(readFileSync(join(app, messages, "MessagesBinary"), "utf8"), "messages-binary");
      assert.equal(existsSync(join(app, messages, "embedded.mobileprovision")), false, "the input app is not re-signed in place");
      if (hasWidgets) assert.equal(readFileSync(join(app, widgets, "WidgetsBinary"), "utf8"), "widgets-binary");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("an ad hoc signing failure cleans up its temporary copy without changing the input", () => {
  const root = mkdtempSync(join(tmpdir(), "robob-cards-sign-failure-test-"));
  const app = join(root, "RobobCards.app");
  const profilePath = join(root, "adhoc.mobileprovision");
  let staged;
  try {
    mkdirSync(join(app, widgets), { recursive: true });
    writeFileSync(join(app, widgets, "WidgetsBinary"), "widgets-binary");
    writeFileSync(profilePath, "ad-hoc-profile");
    assert.throws(() => resignAdHoc({
      app, profilePath, signing: { certPath: "/cert", keyPath: "/key" }, outDir: join(root, "out"),
      runCommand: (command, args) => {
        if (command === "/usr/bin/security") return JSON.stringify({ UUID: "PROFILE", Name: "Ad Hoc", ExpirationDate: "2027-01-01", ProvisionedDevices: ["PHONE"] });
        if (command === "/usr/bin/plutil") {
          const value = JSON.parse(readFileSync(args.at(-1), "utf8"))[args[1]];
          return args[2] === "json" ? JSON.stringify(value) : String(value);
        }
        if (command === "/usr/bin/openssl" && args.includes("-serial")) return "serial=ABCDEF\nSHA1 Fingerprint=11:22:33:44\n";
        if (command === "/usr/bin/ditto") {
          staged = args[1];
          cpSync(app, staged, { recursive: true });
          throw new Error("copy failed");
        }
        assert.fail(`unexpected command ${command}`);
      },
    }), /copy failed/);
    assert.ok(staged);
    assert.equal(existsSync(staged), false);
    assert.equal(readFileSync(join(app, widgets, "WidgetsBinary"), "utf8"), "widgets-binary");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
