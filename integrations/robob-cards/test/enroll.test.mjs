import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";

import { Asc, ascToken } from "../lib/asc.mjs";
import { enrollPage, extractDevice, manifestPlist, profileServiceConfig, stepsText } from "../lib/enroll.mjs";
import { parseConfig } from "../lib/state.mjs";

const TOKEN = "tok_abcdefghijklmnopqrstuv";
const UDID = "00008150-000828EE2E08401C";

const signedBody = (fields) =>
  Buffer.concat([
    Buffer.from([0x30, 0x80, 0x06, 0x09, 0x2a, 0x86]),
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
${Object.entries(fields).map(([key, value]) => `<key>${key}</key>\n<string>${value}</string>`).join("\n")}
</dict></plist>`),
    Buffer.from([0x00, 0xa0, 0x82, 0x03]),
  ]);

test("extractDevice reads the device plist out of the signed callback", () => {
  const device = extractDevice(
    signedBody({ UDID, PRODUCT: "iPhone17,1", VERSION: "23B85", DEVICE_NAME: "Moni&apos;s iPhone", CHALLENGE: TOKEN }),
    TOKEN,
  );
  assert.deepEqual(device, { udid: UDID, product: "iPhone17,1", osVersion: "23B85", deviceName: "Moni's iPhone" });
});

test("extractDevice rejects a wrong challenge, a bad UDID and a body without a plist", () => {
  assert.throws(() => extractDevice(signedBody({ UDID, CHALLENGE: "someone-else" }), TOKEN), /challenge/);
  assert.throws(() => extractDevice(signedBody({ UDID: "not-a-udid", CHALLENGE: TOKEN }), TOKEN), /UDID/);
  assert.throws(() => extractDevice(Buffer.from("hello"), TOKEN), /no device plist/);
});

test("the profile service asks for the UDID and posts back to the escaped callback", () => {
  const xml = profileServiceConfig({ callbackUrl: "https://a-b.trycloudflare.com/c/x/enrolled?a=1&b=2", token: TOKEN });
  assert.match(xml, /<string>Profile Service<\/string>/);
  assert.match(xml, /<string>UDID<\/string>/);
  assert.match(xml, /enrolled\?a=1&amp;b=2/);
  assert.match(xml, new RegExp(`<key>Challenge</key>\\s*<string>${TOKEN}</string>`));
});

test("the manifest points at the ipa and the bundle", () => {
  const xml = manifestPlist({
    ipaUrl: "https://h.trycloudflare.com/c/t/RobobCards.ipa",
    iconUrl: "https://h.trycloudflare.com/c/t/icon.png",
    bundleId: "com.abdullah.robob.cards",
    version: "1.0",
    title: "Robob Cards",
  });
  assert.match(xml, /software-package<\/string>\s*<key>url<\/key>\s*<string>https:\/\/h\.trycloudflare\.com\/c\/t\/RobobCards\.ipa/);
  assert.match(xml, /<string>com\.abdullah\.robob\.cards<\/string>/);
});

test("the page walks from register to install and the install button carries the manifest", () => {
  assert.match(enrollPage({ phase: "waiting" }), /href="profile\.mobileconfig">Register this iPhone/);
  assert.match(enrollPage({ phase: "preparing" }), /http-equiv="refresh"/);
  const ready = enrollPage({ phase: "ready", manifestUrl: "https://h.trycloudflare.com/c/t/manifest.plist" });
  assert.match(ready, /itms-services:\/\/\?action=download-manifest&amp;url=https%3A%2F%2Fh\.trycloudflare\.com%2Fc%2Ft%2Fmanifest\.plist/);
  assert.match(enrollPage({ phase: "failed" }), /Something went wrong/);
});

test("the steps text carries the link and stays free of jargon", () => {
  const text = stepsText("https://h.trycloudflare.com/c/t/");
  assert.match(text, /Open this link in Safari on your iPhone: https:\/\/h\.trycloudflare\.com\/c\/t\//);
  assert.match(text, /Profile Downloaded/);
  assert.doesNotMatch(text, /UDID|provision|ad hoc|tunnel/i);
});

test("parseConfig needs App Store Connect and signing paths", () => {
  const good = {
    asc: { keyId: "K", issuerId: "I", keyPath: "/k.p8" },
    signing: { keyPath: "/dist.key", certPath: "/dist.cer" },
  };
  assert.deepEqual(parseConfig(good), good);
  assert.throws(() => parseConfig({ asc: good.asc }), /config needs/);
  assert.throws(() => parseConfig({ ...good, asc: { ...good.asc, keyId: "" } }), /config needs/);
});

test("ascToken is an ES256 JWT that verifies with the key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const token = ascToken({ keyId: "KEY", issuerId: "ISS", privateKey: pem }, 1_700_000_000_000);
  const [header, payload, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "ES256", kid: "KEY", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url")), {
    iss: "ISS",
    iat: 1_700_000_000,
    exp: 1_700_000_600,
    aud: "appstoreconnect-v1",
  });
  const ok = verify("sha256", Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
  assert.equal(ok, true);
});

function fakeAsc(routes) {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const calls = [];
  const delays = [];
  const fetchImpl = async (url, init) => {
    const path = url.replace("https://api.appstoreconnect.apple.com/v1", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, body });
    const route = routes.find(([method, match]) => method === init.method && match.test(path));
    if (!route) return new Response(JSON.stringify({ errors: [{ detail: "no route" }] }), { status: 500 });
    const [status, json] = route[2](body);
    return new Response(status === 204 ? null : JSON.stringify(json), { status });
  };
  const asc = new Asc(
    { keyId: "K", issuerId: "I", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) },
    fetchImpl,
    { retryDelays: [10, 20, 40], sleep: async (ms) => { delays.push(ms); } },
  );
  return { asc, calls, delays };
}

const phone = (id, status = "ENABLED", platform = "IOS") => ({ id, attributes: { udid: UDID, status, platform } });

test("ensureDevice reuses a registered phone, re-enables a disabled one and registers a new one", async () => {
  const enabled = fakeAsc([["GET", /^\/devices\?/, () => [200, { data: [{ ...phone("D1"), attributes: { ...phone("D1").attributes, udid: UDID.toLowerCase() } }] }]]]);
  assert.deepEqual(await enabled.asc.ensureDevice({ udid: UDID, name: "x" }), { id: "D1", created: false });
  assert.equal(enabled.calls.length, 1);

  const disabled = fakeAsc([
    ["GET", /^\/devices\?/, () => [200, { data: [phone("D2", "DISABLED")] }]],
    ["PATCH", /^\/devices\/D2$/, () => [200, { data: phone("D2") }]],
  ]);
  await disabled.asc.ensureDevice({ udid: UDID, name: "x" });
  assert.deepEqual(disabled.calls[1].body.data.attributes, { status: "ENABLED" });

  const fresh = fakeAsc([
    ["GET", /^\/devices\?/, () => [200, { data: [] }]],
    ["POST", /^\/devices$/, () => [201, { data: phone("D3") }]],
  ]);
  assert.deepEqual(await fresh.asc.ensureDevice({ udid: UDID, name: "Robob Cards moni" }), { id: "D3", created: true });
  assert.deepEqual(fresh.calls[1].body.data.attributes, { name: "Robob Cards moni", udid: UDID, platform: "IOS" });
});

test("ensureDevice waits for Apple's PROCESSING status without trying to enable it", async () => {
  let reads = 0;
  const { asc, calls, delays } = fakeAsc([
    ["GET", /^\/devices\?/, () => [200, { data: [phone("D1", ++reads < 3 ? "PROCESSING" : "ENABLED")] }]],
    ["PATCH", /^\/devices\/D1$/, () => [409, { errors: [{ detail: "A device with number 'D1' already exists on this team." }] }]],
  ]);
  assert.deepEqual(await asc.ensureDevice({ udid: UDID, name: "x" }), { id: "D1", created: false });
  assert.equal(calls.filter((call) => call.method !== "GET").length, 0);
  assert.deepEqual(delays, [10, 20]);
});

test("a newly registered PROCESSING device is not returned until Apple enables it", async () => {
  let reads = 0;
  const { asc, calls } = fakeAsc([
    ["GET", /^\/devices\?/, () => [200, { data: ++reads === 1 ? [] : [phone("D1", reads < 3 ? "PROCESSING" : "ENABLED")] }]],
    ["POST", /^\/devices$/, () => [201, { data: phone("D1", "PROCESSING") }]],
  ]);
  assert.deepEqual(await asc.ensureDevice({ udid: UDID, name: "x" }), { id: "D1", created: true });
  assert.equal(reads, 3);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
});

test("ensureDevice reconciles a duplicate registration by UDID, including delayed visibility", async () => {
  let reads = 0;
  const { asc, calls } = fakeAsc([
    ["GET", /^\/devices\?/, () => [200, { data: ++reads < 3 ? [] : [phone("D2")] }]],
    ["POST", /^\/devices$/, () => [409, { errors: [{ detail: "A device with number 'D2' already exists on this team." }] }]],
  ]);
  assert.deepEqual(await asc.ensureDevice({ udid: UDID, name: "x" }), { id: "D2", created: false });
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
});

test("a duplicate response to enabling a disabled device is reconciled, not PATCHed again", async () => {
  let reads = 0;
  const { asc, calls } = fakeAsc([
    ["GET", /^\/devices\?/, () => [200, { data: [phone("D1", ++reads === 1 ? "DISABLED" : reads === 2 ? "PROCESSING" : "ENABLED")] }]],
    ["PATCH", /^\/devices\/D1$/, () => [409, { errors: [{ detail: "A device with number 'D1' already exists on this team." }] }]],
  ]);
  assert.deepEqual(await asc.ensureDevice({ udid: UDID, name: "x" }), { id: "D1", created: false });
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
});

test("processing retries are bounded and expose Apple's pending status", async () => {
  const { asc, calls, delays } = fakeAsc([
    ["GET", /^\/devices\?/, () => [200, { data: [phone("D1", "PROCESSING")] }]],
  ]);
  await assert.rejects(asc.ensureDevice({ udid: UDID, name: "x" }), (error) => {
    assert.equal(error.name, "DevicePendingError");
    assert.equal(error.deviceId, "D1");
    assert.equal(error.deviceStatus, "PROCESSING");
    assert.match(error.message, /24.*72 hours/);
    return true;
  });
  assert.deepEqual(delays, [10, 20, 40]);
  assert.equal(calls.length, 4);
});

test("ineligible or non-iOS devices fail without mutation or retry", async () => {
  for (const device of [phone("D1", "INELIGIBLE"), phone("D1", "ENABLED", "MAC_OS")]) {
    const { asc, calls, delays } = fakeAsc([["GET", /^\/devices\?/, () => [200, { data: [device] }]]]);
    await assert.rejects(asc.ensureDevice({ udid: UDID, name: "x" }), /INELIGIBLE|MAC_OS/);
    assert.equal(calls.length, 1);
    assert.deepEqual(delays, []);
  }
});

test("unrelated device conflicts are not retried", async () => {
  const { asc, calls } = fakeAsc([
    ["GET", /^\/devices\?/, () => [200, { data: [] }]],
    ["POST", /^\/devices$/, () => [409, { errors: [{ detail: "Device limit reached" }] }]],
  ]);
  await assert.rejects(asc.ensureDevice({ udid: UDID, name: "x" }), /Device limit reached/);
  assert.equal(calls.length, 2);
});

test("replaceAdHocProfile deletes the old profile of that name before creating the new one", async () => {
  const { asc, calls } = fakeAsc([
    ["GET", /^\/profiles\?/, () => [200, { data: [{ id: "P0", attributes: { name: "Robob Cards Ad Hoc - moni" } }, { id: "PX", attributes: { name: "Robob Cards Ad Hoc - moni2" } }] }]],
    ["DELETE", /^\/profiles\/P0$/, () => [204]],
    ["POST", /^\/profiles$/, () => [201, { data: { id: "P1", attributes: { uuid: "U1", profileContent: Buffer.from("profile").toString("base64") } } }]],
  ]);
  const profile = await asc.replaceAdHocProfile({ name: "Robob Cards Ad Hoc - moni", bundleIdId: "B", certificateId: "C", deviceIds: ["D1", "D2"] });
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path.split("?")[0]}`), ["GET /profiles", "DELETE /profiles/P0", "POST /profiles"]);
  assert.equal(calls[2].body.data.attributes.profileType, "IOS_APP_ADHOC");
  assert.deepEqual(calls[2].body.data.relationships.devices.data.map((device) => device.id), ["D1", "D2"]);
  assert.equal(profile.content.toString(), "profile");
});

test("App Store Connect errors carry the status and Apple's detail", async () => {
  const { asc } = fakeAsc([["GET", /^\/certificates/, () => [401, { errors: [{ detail: "token expired" }] }]]]);
  await assert.rejects(asc.certificateId("ABC"), /401 .*token expired/);
});

test("profile creation retries only the device propagation conflict with backoff", async () => {
  let attempts = 0;
  const { asc, calls, delays } = fakeAsc([
    ["GET", /^\/profiles\?/, () => [200, { data: [] }]],
    ["POST", /^\/profiles$/, () => ++attempts < 3
      ? [409, { errors: [{ detail: "There are no current ios devices on this team matching the provided device IDs." }] }]
      : [201, { data: { id: "P1", attributes: { uuid: "U1", profileContent: Buffer.from("profile").toString("base64") } } }]],
  ]);
  const profile = await asc.replaceAdHocProfile({ name: "x", bundleIdId: "B", certificateId: "C", deviceIds: ["D1"] });
  assert.equal(profile.id, "P1");
  assert.deepEqual(delays, [10, 20]);
  assert.equal(calls.filter((call) => call.method === "GET").length, 1);
  const requests = calls.filter((call) => call.method === "POST").map((call) => call.body);
  assert.deepEqual(requests, [requests[0], requests[0], requests[0]]);
});

test("profile propagation retries are bounded and other conflicts fail immediately", async () => {
  for (const [detail, attempts] of [
    ["There are no current ios devices on this team matching the provided device IDs.", 4],
    ["The certificate is invalid", 1],
  ]) {
    const { asc, calls } = fakeAsc([
      ["GET", /^\/profiles\?/, () => [200, { data: [] }]],
      ["POST", /^\/profiles$/, () => [409, { errors: [{ detail }] }]],
    ]);
    await assert.rejects(asc.replaceAdHocProfile({ name: "x", bundleIdId: "B", certificateId: "C", deviceIds: ["D1"] }), /409/);
    assert.equal(calls.filter((call) => call.method === "POST").length, attempts);
  }
});
