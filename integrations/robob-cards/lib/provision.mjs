import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Asc, DevicePendingError } from "./asc.mjs";
import { builtApp, readState, updateState } from "./state.mjs";
import { certificateSerial, resignAdHoc } from "./sign.mjs";

export const profileName = (name) => `Robob Cards Ad Hoc - ${name}`;

function portalDeviceName(name, device) {
  const label = `Robob Cards ${name}${device.product ? ` ${device.product}` : ""}`;
  return label.slice(0, 50);
}

// The server's callback and a foreground `install` must not sign into the same
// folder at once; a lock whose owner died is taken over.
function lock(dir) {
  const path = join(dir, "provision.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = Number(readFileSync(path, "utf8"));
      let alive = false;
      try {
        process.kill(owner, 0);
        alive = true;
      } catch {}
      if (alive && owner !== process.pid) throw new Error(`another provisioning run (pid ${owner}) is already working on this phone`);
      rmSync(path, { force: true });
    }
  }
  throw new Error("could not take the provisioning lock");
}

// Registers every phone enrolled under this name, makes an ad hoc profile for
// exactly those phones, and re-signs the current build with it.
export async function provision({ dir, name, config, env = process.env, asc = new Asc(config.asc), resign = resignAdHoc }) {
  const app = builtApp(env);
  if (!existsSync(app)) throw new Error(`no build at ${app}; run bin/robob-cards-build first`);
  const unlock = lock(dir);
  try {
    const state = readState(dir);
    const devices = state?.devices ?? [];
    if (devices.length === 0) throw new Error(`no phone has registered for ${name} yet`);
    updateState(dir, { phase: "preparing", error: null, pendingDevice: null });
    const deviceIds = [];
    for (const device of devices) {
      const registered = await asc.ensureDevice({ udid: device.udid, name: portalDeviceName(name, device) });
      deviceIds.push(registered.id);
    }
    const { serial } = certificateSerial(config.signing.certPath);
    const certificateId = await asc.certificateId(serial);
    const bundleIdId = await asc.wildcardBundleId();
    const profile = await asc.replaceAdHocProfile({ name: profileName(name), bundleIdId, certificateId, deviceIds });
    const profilePath = join(dir, "adhoc.mobileprovision");
    writeFileSync(profilePath, profile.content, { mode: 0o600 });
    const built = resign({ app, profilePath, signing: config.signing, outDir: dir });
    const covered = new Set(built.devices.map((udid) => udid.toLowerCase()));
    const missing = devices.filter((device) => !covered.has(device.udid.toLowerCase()));
    if (missing.length > 0) throw new Error(`the new profile does not list ${missing.map((device) => device.udid).join(", ")}`);
    return updateState(dir, {
      phase: "ready",
      error: null,
      build: {
        version: built.version,
        bundleId: built.bundleId,
        profileId: profile.id,
        profileUuid: built.profileUuid,
        profileExpires: built.expires,
        signedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    updateState(dir, {
      phase: error instanceof DevicePendingError ? "preparing" : "failed",
      error: error.message,
      pendingDevice: error instanceof DevicePendingError ? { id: error.deviceId, status: error.deviceStatus } : null,
    });
    throw error;
  } finally {
    unlock();
  }
}
