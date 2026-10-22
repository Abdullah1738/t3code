import { sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const API = "https://api.appstoreconnect.apple.com/v1";
const RETRY_DELAYS = [2_000, 5_000, 10_000, 20_000, 30_000];

const b64url = (value) => Buffer.from(value).toString("base64url");

export function ascToken({ keyId, issuerId, privateKey }, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss: issuerId, iat, exp: iat + 600, aud: "appstoreconnect-v1" }));
  // JWS wants the raw r||s signature, not the DER that node produces by default.
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

export class AscError extends Error {
  constructor(status, path, detail) {
    super(`App Store Connect ${status} on ${path}: ${detail}`);
    this.status = status;
    this.detail = detail;
  }
}

export class DevicePendingError extends Error {
  constructor(device) {
    super(`Apple is still processing device ${device.id}; it cannot be used in a profile yet. Processing can take 24–72 hours. Retry install after Apple enables it.`);
    this.name = "DevicePendingError";
    this.deviceId = device.id;
    this.deviceStatus = device.attributes.status;
  }
}

const duplicateDevice = (error) => error instanceof AscError && error.status === 409 && /device .*already exists on this team/i.test(error.detail);
const profileDevicesPending = (error) => error instanceof AscError && error.status === 409 && /no current ios devices .*matching the provided device IDs/i.test(error.detail);

export class Asc {
  #creds;
  #fetch;
  #retryDelays;
  #sleep;

  constructor({ keyId, issuerId, keyPath, privateKey }, fetchImpl = fetch, options = {}) {
    this.#creds = { keyId, issuerId, privateKey: privateKey ?? readFileSync(keyPath, "utf8") };
    this.#fetch = fetchImpl;
    this.#retryDelays = options.retryDelays ?? RETRY_DELAYS;
    this.#sleep = options.sleep ?? sleep;
  }

  async request(method, path, body) {
    const response = await this.#fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${ascToken(this.#creds)}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 204) return null;
    const text = await response.text();
    const json = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const detail = json?.errors?.map((error) => error.detail ?? error.title).join("; ") || text.slice(0, 300);
      throw new AscError(response.status, path, detail);
    }
    return json;
  }

  async findDevice(udid) {
    const found = await this.request("GET", `/devices?filter[udid]=${encodeURIComponent(udid)}&limit=5`);
    return found.data.find((device) => device.attributes.udid.toLowerCase() === udid.toLowerCase()) ?? null;
  }

  // PROCESSING is Apple's approval hold, not a disabled device. PATCHing it
  // returns a misleading duplicate-device 409 and cannot shorten the hold.
  async ensureDevice({ udid, name }) {
    let device = await this.findDevice(udid);
    let created = false;
    let conflict;
    if (!device) {
      try {
        const response = await this.request("POST", "/devices", {
          data: { type: "devices", attributes: { name, udid, platform: "IOS" } },
        });
        device = response.data;
        created = true;
      } catch (error) {
        if (!duplicateDevice(error)) throw error;
        conflict = error;
        device = await this.findDevice(udid);
      }
    }

    let enableAttempted = false;
    for (let attempt = 0; ; attempt += 1) {
      if (device) {
        if (device.attributes.platform !== "IOS") throw new Error(`device ${device.id} is registered for ${device.attributes.platform}, not IOS`);
        if (device.attributes.status === "ENABLED") return { id: device.id, created };
        if (device.attributes.status === "DISABLED" && !enableAttempted) {
          enableAttempted = true;
          try {
            const response = await this.request("PATCH", `/devices/${device.id}`, {
              data: { type: "devices", id: device.id, attributes: { status: "ENABLED" } },
            });
            device = response.data;
          } catch (error) {
            if (!duplicateDevice(error)) throw error;
            conflict = error;
            device = await this.findDevice(udid);
          }
          if (device?.attributes.platform === "IOS" && device.attributes.status === "ENABLED") return { id: device.id, created };
        }
        if (device && !["PROCESSING", "DISABLED"].includes(device.attributes.status)) {
          throw new Error(`device ${device.id} is ${device.attributes.status}; Apple must make it eligible before it can be provisioned`);
        }
      }
      if (attempt >= this.#retryDelays.length) {
        if (device?.attributes.status === "PROCESSING") throw new DevicePendingError(device);
        throw conflict ?? new Error(`device ${device?.id ?? udid} did not become ENABLED`);
      }
      await this.#sleep(this.#retryDelays[attempt]);
      device = await this.findDevice(udid);
    }
  }

  async certificateId(serialNumber) {
    const found = await this.request(
      "GET",
      "/certificates?filter[certificateType]=DISTRIBUTION,IOS_DISTRIBUTION&limit=50",
    );
    const match = found.data.find(
      (cert) => cert.attributes.serialNumber.toUpperCase() === serialNumber.toUpperCase(),
    );
    if (!match) throw new Error(`no distribution certificate with serial ${serialNumber} on the team`);
    return match.id;
  }

  async wildcardBundleId() {
    const found = await this.request("GET", "/bundleIds?filter[identifier]=*&limit=20");
    const match = found.data.find((bundle) => bundle.attributes.identifier === "*");
    if (!match) throw new Error("the team has no wildcard (*) App ID");
    return match.id;
  }

  // Profiles cannot gain devices after creation, so each run replaces the
  // named profile with a fresh one covering exactly these devices.
  async replaceAdHocProfile({ name, bundleIdId, certificateId, deviceIds }) {
    await this.deleteProfileNamed(name);
    const body = {
      data: {
        type: "profiles",
        attributes: { name, profileType: "IOS_APP_ADHOC" },
        relationships: {
          bundleId: { data: { type: "bundleIds", id: bundleIdId } },
          certificates: { data: [{ type: "certificates", id: certificateId }] },
          devices: { data: deviceIds.map((id) => ({ type: "devices", id })) },
        },
      },
    };
    let created;
    for (let attempt = 0; ; attempt += 1) {
      try {
        created = await this.request("POST", "/profiles", body);
        break;
      } catch (error) {
        // Even ENABLED devices can take a moment to reach the profile service.
        if (!profileDevicesPending(error) || attempt >= this.#retryDelays.length) throw error;
        await this.#sleep(this.#retryDelays[attempt]);
      }
    }
    return {
      id: created.data.id,
      uuid: created.data.attributes.uuid,
      content: Buffer.from(created.data.attributes.profileContent, "base64"),
    };
  }

  async deleteProfileNamed(name) {
    const existing = await this.request("GET", `/profiles?filter[name]=${encodeURIComponent(name)}&limit=10`);
    for (const profile of existing.data) {
      if (profile.attributes.name === name) await this.request("DELETE", `/profiles/${profile.id}`);
    }
  }
}
