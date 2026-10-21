import { sign } from "node:crypto";
import { readFileSync } from "node:fs";

const API = "https://api.appstoreconnect.apple.com/v1";

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
  }
}

export class Asc {
  #creds;
  #fetch;

  constructor({ keyId, issuerId, keyPath, privateKey }, fetchImpl = fetch) {
    this.#creds = { keyId, issuerId, privateKey: privateKey ?? readFileSync(keyPath, "utf8") };
    this.#fetch = fetchImpl;
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

  // Registering an already-known UDID is a 409, so look first; a device
  // someone disabled in the portal is switched back on rather than duplicated.
  async ensureDevice({ udid, name }) {
    const existing = await this.findDevice(udid);
    if (existing) {
      if (existing.attributes.status !== "ENABLED") {
        await this.request("PATCH", `/devices/${existing.id}`, {
          data: { type: "devices", id: existing.id, attributes: { status: "ENABLED" } },
        });
      }
      return { id: existing.id, created: false };
    }
    const created = await this.request("POST", "/devices", {
      data: { type: "devices", attributes: { name, udid, platform: "IOS" } },
    });
    return { id: created.data.id, created: true };
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
    const created = await this.request("POST", "/profiles", {
      data: {
        type: "profiles",
        attributes: { name, profileType: "IOS_APP_ADHOC" },
        relationships: {
          bundleId: { data: { type: "bundleIds", id: bundleIdId } },
          certificates: { data: [{ type: "certificates", id: certificateId }] },
          devices: { data: deviceIds.map((id) => ({ type: "devices", id })) },
        },
      },
    });
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
