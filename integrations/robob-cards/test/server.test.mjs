import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { provision, profileName } from "../lib/provision.mjs";
import { createHandler, provisionQueue, QUICK_TUNNEL } from "../lib/server.mjs";
import { readState, writeState } from "../lib/state.mjs";

const TOKEN = "tok_abcdefghijklmnopqrstuv";
const UDID = "00008150-000828EE2E08401C";
const root = mkdtempSync(join(tmpdir(), "robob-cards-test-"));
const dir = join(root, "enroll", "moni");
const enrolled = [];
let server;
let base;

const callback = (udid, challenge = TOKEN) =>
  `junk<?xml version="1.0"?><plist><dict><key>UDID</key><string>${udid}</string><key>PRODUCT</key><string>iPhone17,1</string><key>CHALLENGE</key><string>${challenge}</string></dict></plist>junk`;

before(async () => {
  writeState(dir, { name: "moni", token: TOKEN, phase: "waiting", devices: [], publicUrl: "https://moni-test.trycloudflare.com" });
  server = createServer(createHandler({ dir, onEnrolled: (event) => enrolled.push(event) }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

test("only the token path answers", async () => {
  for (const path of ["/", "/c/wrong/", `/c/${TOKEN}x/`, "/state.json", `/c/${TOKEN}/../state.json`]) {
    const response = await fetch(`${base}${path}`, { redirect: "manual" });
    assert.equal(response.status, 404, path);
  }
  const page = await fetch(`${base}/c/${TOKEN}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Register this iPhone/);
});

test("the profile download is a profile service pointing back through the public URL", async () => {
  const response = await fetch(`${base}/c/${TOKEN}/profile.mobileconfig`);
  assert.equal(response.headers.get("content-type"), "application/x-apple-aspen-config");
  assert.match(await response.text(), /https:\/\/moni-test\.trycloudflare\.com\/c\/tok_abcdefghijklmnopqrstuv\/enrolled/);
});

test("nothing installable is served before the app is ready", async () => {
  assert.equal((await fetch(`${base}/c/${TOKEN}/manifest.plist`)).status, 404);
  assert.equal((await fetch(`${base}/c/${TOKEN}/RobobCards.ipa`)).status, 404);
});

test("a registration records the phone once and sends Safari back to the page", async () => {
  const response = await fetch(`${base}/c/${TOKEN}/enrolled`, { method: "POST", body: callback(UDID), redirect: "manual" });
  assert.equal(response.status, 301);
  assert.equal(response.headers.get("location"), `https://moni-test.trycloudflare.com/c/${TOKEN}/`);
  await fetch(`${base}/c/${TOKEN}/enrolled`, { method: "POST", body: callback(UDID.toLowerCase()), redirect: "manual" });
  const state = readState(dir);
  assert.equal(state.phase, "preparing");
  assert.equal(state.devices.length, 1);
  assert.deepEqual(enrolled.map((event) => event.known), [false, true]);
  assert.match(await (await fetch(`${base}/c/${TOKEN}/`)).text(), /Almost there/);

  const forged = await fetch(`${base}/c/${TOKEN}/enrolled`, { method: "POST", body: callback(UDID, "other"), redirect: "manual" });
  assert.equal(forged.status, 400);
});

test("once ready the page offers the install and serves the manifest and ipa", async () => {
  writeFileSync(join(dir, "RobobCards.ipa"), "ipa-bytes");
  writeState(dir, { ...readState(dir), phase: "ready", build: { bundleId: "com.abdullah.robob.cards", version: "1.0" } });
  assert.match(await (await fetch(`${base}/c/${TOKEN}/`)).text(), /itms-services/);
  const manifest = await (await fetch(`${base}/c/${TOKEN}/manifest.plist`)).text();
  assert.match(manifest, /https:\/\/moni-test\.trycloudflare\.com\/c\/tok_abcdefghijklmnopqrstuv\/RobobCards\.ipa/);
  const ipa = await fetch(`${base}/c/${TOKEN}/RobobCards.ipa`);
  assert.equal(await ipa.text(), "ipa-bytes");
  assert.equal(readState(dir).downloads, 1);
});

test("quick tunnel URLs are recognised in cloudflared output", () => {
  const line = "2026-10-22T01:00:00Z INF |  https://brave-tiger-sample-words.trycloudflare.com  |";
  assert.equal(line.match(QUICK_TUNNEL)?.[0], "https://brave-tiger-sample-words.trycloudflare.com");
  assert.equal("https://api.trycloudflare.com".match(QUICK_TUNNEL), null);
});

test("provisionQueue runs one at a time and once more for a late registration", async () => {
  const order = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let runs = 0;
  const kick = provisionQueue(async () => {
    runs += 1;
    order.push(`start${runs}`);
    if (runs === 1) await gate;
    order.push(`end${runs}`);
  });
  const first = kick();
  kick();
  kick();
  release();
  await first;
  assert.deepEqual(order, ["start1", "end1", "start2", "end2"]);
});

test("provision registers every phone, replaces the profile and records the build", async () => {
  const home = mkdtempSync(join(tmpdir(), "robob-cards-home-"));
  const env = { ROBOB_CARDS_HOME: home };
  const appDir = join(home, "build", "RobobCards.app");
  mkdirSync(appDir, { recursive: true });
  const phoneDir = join(home, "enroll", "moni");
  writeState(phoneDir, { name: "moni", token: TOKEN, phase: "preparing", devices: [{ udid: UDID, product: "iPhone17,1" }] });
  const calls = [];
  const asc = {
    ensureDevice: async (device) => (calls.push(["device", device]), { id: "D1" }),
    certificateId: async (serial) => (calls.push(["cert", serial]), "C1"),
    wildcardBundleId: async () => "B1",
    replaceAdHocProfile: async (request) => (calls.push(["profile", request]), { id: "P1", content: Buffer.from("p") }),
  };
  const certPath = new URL("./fixtures/dist.cer", import.meta.url).pathname;
  try {
    const state = await provision({
      dir: phoneDir,
      name: "moni",
      env,
      config: { signing: { certPath, keyPath: "/unused" } },
      asc,
      resign: ({ app, outDir }) => {
        assert.equal(app, appDir);
        assert.equal(outDir, phoneDir);
        return { version: "1.0", bundleId: "com.abdullah.robob.cards", profileUuid: "U1", devices: [UDID], expires: "2027-10-22" };
      },
    });
    assert.equal(state.phase, "ready");
    assert.equal(state.build.profileUuid, "U1");
    assert.deepEqual(calls[0], ["device", { udid: UDID, name: "Robob Cards moni iPhone17,1" }]);
    assert.deepEqual(calls[2][1], { name: profileName("moni"), bundleIdId: "B1", certificateId: "C1", deviceIds: ["D1"] });

    await assert.rejects(
      provision({
        dir: phoneDir,
        name: "moni",
        env,
        config: { signing: { certPath, keyPath: "/unused" } },
        asc,
        resign: () => ({ version: "1.0", bundleId: "x", profileUuid: "U2", devices: [], expires: "" }),
      }),
      /does not list/,
    );
    assert.equal(readState(phoneDir).phase, "failed");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
