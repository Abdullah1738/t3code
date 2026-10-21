import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEAM_ID = "HVG39427R3";
export const APP_ID = "com.abdullah.robob.cards";
const EXTENSION = "PlugIns/RobobCardsMessages.appex";

// security and codesign can stall on a keychain prompt; a deadline turns that
// into an error instead of a hung enrollment.
function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"], ...options });
}

// Profiles carry <data> and <date> values, which plutil cannot turn into JSON
// as a whole, so the few fields we need are extracted one by one.
export function readProfile(path) {
  const dir = mkdtempSync(join(tmpdir(), "robob-cards-profile-"));
  try {
    const plist = join(dir, "profile.plist");
    writeFileSync(plist, run("/usr/bin/security", ["cms", "-D", "-i", path]));
    return {
      uuid: plistValue(plist, "UUID"),
      name: plistValue(plist, "Name"),
      expires: plistValue(plist, "ExpirationDate"),
      devices: JSON.parse(run("/usr/bin/plutil", ["-extract", "ProvisionedDevices", "json", "-o", "-", plist])),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function plistValue(plist, key) {
  return run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist]).trim();
}

export function entitlementsFor(bundleId) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>application-identifier</key>
  <string>${TEAM_ID}.${bundleId}</string>
  <key>com.apple.developer.team-identifier</key>
  <string>${TEAM_ID}</string>
  <key>get-task-allow</key>
  <false/>
</dict>
</plist>
`;
}

export function certificateSerial(certPath) {
  const out = run("/usr/bin/openssl", ["x509", "-inform", "DER", "-in", certPath, "-noout", "-serial", "-fingerprint", "-sha1"]);
  const serial = out.match(/serial=([0-9A-F]+)/i)?.[1];
  const sha1 = out.match(/Fingerprint=([0-9A-F:]+)/i)?.[1]?.replaceAll(":", "");
  if (!serial || !sha1) throw new Error(`cannot read the certificate at ${certPath}`);
  return { serial: serial.toUpperCase(), sha1: sha1.toUpperCase() };
}

// The distribution key lives as files, so it goes into a throwaway keychain
// that never joins the search list; nothing persists and no prompt appears.
function withSigningKeychain(signing, work, fn) {
  const password = randomBytes(24).toString("hex");
  const keychain = join(work, "signing.keychain-db");
  const pem = join(work, "dist.pem");
  const p12 = join(work, "dist.p12");
  try {
    run("/usr/bin/openssl", ["x509", "-inform", "DER", "-in", signing.certPath, "-out", pem]);
    // macOS's LibreSSL writes the older PKCS#12 ciphers `security import`
    // still expects, which OpenSSL 3 only does with -legacy.
    run("/usr/bin/openssl", ["pkcs12", "-export", "-inkey", signing.keyPath, "-in", pem, "-out", p12, "-passout", "env:P12_PASSWORD"], {
      env: { ...process.env, P12_PASSWORD: password },
    });
    run("/usr/bin/security", ["create-keychain", "-p", password, keychain]);
    run("/usr/bin/security", ["set-keychain-settings", keychain]);
    run("/usr/bin/security", ["unlock-keychain", "-p", password, keychain]);
    run("/usr/bin/security", ["import", p12, "-k", keychain, "-P", password, "-T", "/usr/bin/codesign"]);
    run("/usr/bin/security", [
      "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, keychain,
    ]);
    rmSync(p12, { force: true });
    rmSync(pem, { force: true });
    return fn(keychain);
  } finally {
    rmSync(p12, { force: true });
    rmSync(pem, { force: true });
    if (existsSync(keychain)) {
      try {
        run("/usr/bin/security", ["delete-keychain", keychain]);
      } catch {
        rmSync(keychain, { force: true });
      }
    }
  }
}

// Re-signs the development build for ad hoc distribution: same binaries, the
// ad hoc profile embedded in the app and its extension, distribution identity.
export function resignAdHoc({ app, profilePath, signing, outDir }) {
  const profile = readProfile(profilePath);
  const { sha1 } = certificateSerial(signing.certPath);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(tmpdir(), "robob-cards-sign-"));
  try {
    const staged = join(work, "Payload", "RobobCards.app");
    mkdirSync(join(work, "Payload"));
    run("/usr/bin/ditto", [app, staged]);
    const bundles = [
      { path: join(staged, EXTENSION), id: `${APP_ID}.MessagesExtension` },
      { path: staged, id: APP_ID },
    ];
    withSigningKeychain(signing, work, (keychain) => {
      // Inside out: the app's signature seals the already-signed extension.
      for (const bundle of bundles) {
        const found = plistValue(join(bundle.path, "Info.plist"), "CFBundleIdentifier");
        if (found !== bundle.id) throw new Error(`expected ${bundle.id} in ${bundle.path}, found ${found}`);
        copyFileSync(profilePath, join(bundle.path, "embedded.mobileprovision"));
        const entitlements = join(work, `${bundle.id}.entitlements`);
        writeFileSync(entitlements, entitlementsFor(bundle.id));
        run("/usr/bin/codesign", [
          "--force", "--sign", sha1, "--keychain", keychain, "--entitlements", entitlements,
          "--generate-entitlement-der", bundle.path,
        ]);
      }
    });
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged]);
    const ipa = join(outDir, "RobobCards.ipa");
    rmSync(ipa, { force: true });
    run("/usr/bin/zip", ["-qry", ipa, "Payload"], { cwd: work });
    return {
      ipa,
      bundleId: APP_ID,
      version: plistValue(join(staged, "Info.plist"), "CFBundleShortVersionString"),
      profileUuid: profile.uuid,
      devices: profile.devices,
      expires: profile.expires,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
