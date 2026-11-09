import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api.ts";
import { createAppsHandler } from "../src/apps.ts";
import type { Photon } from "../src/photon.ts";
import { CARD_FIELDS, forgetSecret, normalizeValue, parseFieldSpec, putSecretRequest, readSecret, SECRET_REQUEST_TTL_MS, SECRET_VALUE_TTL_MS, type SecretField,
  sweepSecrets, tokenHash } from "../src/secrets.ts";
import { Store } from "../src/store.ts";

const FIELDS: SecretField[] = [
  { name: "email", label: "Email", type: "email" },
  { name: "password", label: "Password", type: "password" },
  { name: "otp", label: "Code", type: "otp" },
];

let base: string;
let stateRoot: string;
let appsRoot: string;
let store: Store;
let clock: number;
const now = () => clock;
const deps = () => ({ store, stateRoot, now });

beforeEach(async () => {
  base = await fs.mkdtemp(join(tmpdir(), "spectrum-secrets-test-"));
  stateRoot = join(base, "state");
  appsRoot = join(base, "apps");
  await fs.mkdir(stateRoot, { mode: 0o700 });
  await fs.mkdir(appsRoot);
  store = new Store(":memory:");
  store.set("route", { id: "current", generation: 5 });
  clock = Date.parse("2026-09-26T10:00:00Z");
});
afterEach(async () => {
  store.close();
  await fs.rm(base, { recursive: true, force: true });
});

function openRequest(token = "t".repeat(43), fields = FIELDS, purpose = "Sign in to example.com") {
  putSecretRequest(store, token, { sessionId: "current", generation: 5, purpose, fields, createdAt: clock,
    expiresAt: clock + SECRET_REQUEST_TTL_MS, state: "open" });
  return token;
}

const handler = () => createAppsHandler(appsRoot, deps());
const get = (token: string, method = "GET") => handler()(new Request(`http://127.0.0.1/_secret/${token}`, { method }));
const post = (token: string, body: string | Record<string, string>, type = "application/x-www-form-urlencoded") =>
  handler()(new Request(`http://127.0.0.1/_secret/${token}`, {
    method: "POST", headers: { "Content-Type": type },
    body: typeof body === "string" ? body : new URLSearchParams(body).toString(),
  }));
const filled = { email: "me@example.com", password: "PRIVATE-hunter2", otp: "123456" };

describe("secure form page", () => {
  test("GET renders every field with autofill attributes and strict headers", async () => {
    const token = openRequest(undefined, [...FIELDS, { name: "user", label: "User <b>", type: "username" },
      { name: "api_key", label: "API key", type: "secret" }, { name: "note", label: "Note", type: "text" }], `Sign in to "<x>"`);
    const response = await get(token);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(html).toContain(`<input id="f0" name="email" type="email" autocomplete="username"`);
    expect(html).toContain(`name="password" type="password" autocomplete="current-password"`);
    expect(html).toContain(`name="otp" type="text" inputmode="numeric" autocomplete="one-time-code"`);
    expect(html).toContain(`name="user" type="text" autocomplete="username"`);
    expect(html).toContain(`name="api_key" type="password" autocomplete="off"`);
    expect(html).toContain(`name="note" type="text" autocomplete="off"`);
    expect(html).toContain(`<form method="post"`);
    expect(html).toContain("Sign in to &quot;&lt;x&gt;&quot;");
    expect(html).toContain("User &lt;b&gt;");
    expect(html).not.toContain("<script");
    expect(html).toContain("prefers-color-scheme:dark");
    const head = await get(token, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("POST stores values in a private file outside the apps root and wakes the agent without values", async () => {
    const token = openRequest();
    const response = await post(token, { ...filled, extra: "PRIVATE-undeclared" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Sent. You can close this.");
    const dir = join(stateRoot, "secrets");
    const file = join(dir, `${tokenHash(token)}.json`);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ values: filled });
    expect(await fs.readdir(appsRoot)).toEqual([]);
    const inbound = store.pendingInbound();
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.id).toBe(`secret:${tokenHash(token)}`);
    expect(inbound[0]!.payload).toEqual({
      id: `secret:${tokenHash(token)}`, attachments: [], isAudioMessage: false, receivedAt: clock,
      text: `Filled in the secure form "Sign in to example.com" (fields: email, password, otp). Read a value only with the bridge secret command; never print or repeat it.`,
    });
    expect(JSON.stringify(store.db.query("SELECT * FROM kv").all())).not.toContain("PRIVATE");
    expect(JSON.stringify(inbound)).not.toContain("PRIVATE");
    // Used links are gone.
    expect((await post(token, filled)).status).toBe(410);
    expect((await get(token)).status).toBe(410);
    expect(store.pendingInbound()).toHaveLength(1);
  });

  test("missing, blank, or duplicated declared fields re-render the form without storing anything", async () => {
    const token = openRequest();
    for (const body of [{ email: "a@b.c", password: "x" }, { ...filled, otp: " " }]) {
      const response = await post(token, body);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Please fill in every field.");
    }
    expect((await post(token, `email=a&email=b&password=x&otp=1`)).status).toBe(400);
    expect(await fs.readdir(join(stateRoot, "secrets")).catch(() => [])).toEqual([]);
    expect(store.pendingInbound()).toEqual([]);
    expect((await post(token, filled)).status).toBe(200);
  });

  test("card fields autofill from iCloud Keychain and are checked and normalized", async () => {
    const token = openRequest(undefined, [...CARD_FIELDS, { name: "zip", label: "Postcode", type: "postal-code" }], "Pay for the order");
    const html = await (await get(token)).text();
    expect(html).toContain(`name="card_name" type="text" autocomplete="cc-name"`);
    expect(html).toContain(`name="card_number" type="text" inputmode="numeric" autocomplete="cc-number"`);
    expect(html).toContain(`name="card_expiry" type="text" inputmode="numeric" autocomplete="cc-exp"`);
    expect(html).toContain(`name="card_cvc" type="text" inputmode="numeric" autocomplete="cc-csc"`);
    expect(html).toContain(`id="cc-number" name="card_number"`);
    expect(html).not.toContain(`type="password"`);
    expect(html).not.toContain(" autofocus");
    expect(html).toContain(`name="zip" type="text" autocomplete="postal-code"`);
    const card = { card_name: "A Person", card_number: "4242 4242 4242 4242", card_expiry: "4/2031", card_cvc: "123", zip: "00000" };
    const bad = await post(token, { ...card, card_number: "4242 4242 4242 4241" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("Please check the card number.");
    expect((await post(token, card)).status).toBe(200);
    expect(await readSecret(deps(), token, "card_number")).toBe("4242424242424242");
    expect(await readSecret(deps(), token, "card_expiry")).toBe("04/31");
  });

  test("card values normalize common shapes and reject impossible ones", () => {
    expect(["04/27", "4/27", "04/2027", "0427", "2027-04", "04 27"].map(v => normalizeValue("card-expiry", v, Date.UTC(2026, 8, 26)))).toEqual(Array(6).fill("04/27"));
    expect(["13/27", "00/27", "4/7", "april"].map(v => normalizeValue("card-expiry", v))).toEqual(Array(4).fill(undefined));
    // Checked against a fixed "today" of 2026-09-26: this month is still valid, last month and far-off years are not.
    const today = Date.UTC(2026, 8, 26, 12);
    expect(normalizeValue("card-expiry", "09/26", today)).toBe("09/26");
    expect(normalizeValue("card-expiry", "08/26", today)).toBeUndefined();
    expect(normalizeValue("card-expiry", "01/2020", today)).toBeUndefined();
    expect(normalizeValue("card-expiry", "09/2046", today)).toBe("09/46");
    expect(normalizeValue("card-expiry", "10/2046", today)).toBeUndefined();
    expect(normalizeValue("card-number", "4111-1111-1111-1111")).toBe("4111111111111111");
    expect(normalizeValue("card-number", "1234")).toBeUndefined();
    expect(normalizeValue("card-cvc", "12")).toBeUndefined();
    expect(normalizeValue("card-cvc", "1234")).toBe("1234");
    expect(normalizeValue("password", " spaced ")).toBe(" spaced ");
  });

  test("expired, unknown, and malformed tokens get a detail-free page", async () => {
    const token = openRequest();
    clock += SECRET_REQUEST_TTL_MS;
    for (const response of [await get(token), await post(token, filled)]) {
      expect(response.status).toBe(410);
      const html = await response.text();
      expect(html).not.toContain("example.com");
      expect(html).not.toContain("<form");
    }
    expect((await get("u".repeat(43))).status).toBe(404);
    expect((await get("short")).status).toBe(404);
    expect((await get("../../etc")).status).toBe(404);
    expect(store.pendingInbound()).toEqual([]);
  });

  test("oversized bodies, wrong content types, and other methods are refused", async () => {
    const token = openRequest();
    expect((await post(token, "x=" + "a".repeat(17 * 1024))).status).toBe(413);
    expect((await post(token, JSON.stringify(filled), "application/json")).status).toBe(415);
    expect((await handler()(new Request(`http://127.0.0.1/_secret/${token}`, { method: "DELETE" }))).status).toBe(405);
    expect((await handler()(new Request("http://127.0.0.1/", { method: "POST" }))).status).toBe(405);
    expect((await post(token, filled)).status).toBe(200);
  });

  test("without the secrets dependency the route is a plain 404", async () => {
    const token = openRequest();
    expect((await createAppsHandler(appsRoot)(new Request(`http://127.0.0.1/_secret/${token}`))).status).toBe(404);
  });
});

describe("reading and expiring values", () => {
  test("readSecret returns the raw value; forget deletes it", async () => {
    const token = openRequest();
    await expect(readSecret(deps(), token, "password")).rejects.toMatchObject({ status: 409 });
    await post(token, filled);
    expect(await readSecret(deps(), token, "password")).toBe("PRIVATE-hunter2");
    expect(await readSecret(deps(), token, "otp")).toBe("123456");
    await expect(readSecret(deps(), token, "nope")).rejects.toMatchObject({ status: 404 });
    await forgetSecret(deps(), token);
    await expect(fs.readdir(join(stateRoot, "secrets"))).resolves.toEqual([]);
    await expect(readSecret(deps(), token, "password")).rejects.toMatchObject({ status: 410 });
    await expect(forgetSecret(deps(), "u".repeat(43))).rejects.toMatchObject({ status: 404 });
  });

  test("values expire 30 minutes after submission, lazily and via the sweep", async () => {
    const lazy = openRequest("a".repeat(43));
    const swept = openRequest("b".repeat(43));
    const neverFilled = openRequest("c".repeat(43));
    await post(lazy, filled);
    await post(swept, filled);
    clock += SECRET_VALUE_TTL_MS - 1;
    expect(await readSecret(deps(), lazy, "email")).toBe("me@example.com");
    clock += 1;
    await expect(readSecret(deps(), lazy, "email")).rejects.toMatchObject({ status: 410 });
    await sweepSecrets(deps());
    await expect(fs.readdir(join(stateRoot, "secrets"))).resolves.toEqual([]);
    await expect(readSecret(deps(), swept, "email")).rejects.toMatchObject({ status: 410 });
    expect((await get(neverFilled)).status).toBe(410);
  });

  test("the sweep removes orphaned value files", async () => {
    await fs.mkdir(join(stateRoot, "secrets"), { mode: 0o700 });
    const orphan = join(stateRoot, "secrets", `${"0".repeat(64)}.json`);
    await fs.writeFile(orphan, "{}", { mode: 0o600 });
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(orphan, old, old);
    await sweepSecrets(deps());
    await expect(fs.readdir(join(stateRoot, "secrets"))).resolves.toEqual([]);
  });
});

test("field specs parse name, label, and optional type", () => {
  expect(parseFieldSpec("email:Email")).toEqual({ name: "email", label: "Email", type: "text" });
  expect(parseFieldSpec("otp:Code:otp")).toEqual({ name: "otp", label: "Code", type: "otp" });
  expect(parseFieldSpec("url:Server: host:port")).toEqual({ name: "url", label: "Server: host:port", type: "text" });
  expect(parseFieldSpec("key:API key:secret")).toEqual({ name: "key", label: "API key", type: "secret" });
  for (const bad of ["Email:Email", "email", "email:", "a-b:Label", `${"a".repeat(33)}:L`, "x:a\nb"]) {
    expect(() => parseFieldSpec(bad)).toThrow();
  }
});

describe("secret API routes", () => {
  const request = { purpose: "Sign in to example.com", fields: FIELDS, dedupeKey: "login-1", sessionId: "current" };
  function setup(publishApps: () => Promise<string> = async () => "https://mac.tailnet.ts.net:18400") {
    let published = 0;
    const photon: Pick<Photon, "react"> = { async react() { throw new Error("unexpected"); } };
    const api = createApi({ store, photon, router: () => undefined, chatGuid: () => "iMessage;-;+15555550123", enabled: () => true,
      health: () => ({}), secrets: { stateRoot, now, publishApps: async () => { published++; return publishApps(); } } });
    const call = (path: string, body: unknown) => api(new Request(`http://bridge${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    return { api, call, published: () => published };
  }

  test("secret-request stores an open request, queues a session-bound app card, and is idempotent", async () => {
    const h = setup();
    const first = await h.call("/secret-request", request);
    expect(first.status).toBe(202);
    const result = await first.json() as { token: string; url: string; expiresAt: number };
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.url).toBe(`https://mac.tailnet.ts.net:18400/_secret/${result.token}`);
    expect(result.expiresAt).toBe(clock + 15 * 60_000);
    expect(store.get<unknown>(`secret-request:${result.token}`)).toEqual({ sessionId: "current", generation: 5, purpose: request.purpose,
      fields: FIELDS, createdAt: clock, expiresAt: result.expiresAt, state: "open" });
    const operations = store.pendingOutbox();
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ kind: "conversation", text: "", sessionId: "current", generation: 5,
      app: { url: result.url, caption: "Secure form" } });
    const again = await h.call("/secret-request", request);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(result);
    expect(store.pendingOutbox()).toHaveLength(1);
    expect(h.published()).toBe(1);
    expect((await h.call("/secret-request", { ...request, purpose: "Other" })).status).toBe(409);
  });

  test("secret-request names the session by marker or bare id, and a key reused after /new doesn't replay the old form", async () => {
    const h = setup();
    const first = await h.call("/secret-request", { ...request, sessionId: "current@5" });
    expect(first.status).toBe(202);
    const result = await first.json();
    const bare = await h.call("/secret-request", request);
    expect(bare.status).toBe(200);
    expect(await bare.json()).toEqual(result);
    store.set("route", { id: "current", generation: 6 });
    expect((await h.call("/secret-request", { ...request, sessionId: "current@5" })).status).toBe(409);
    expect((await h.call("/secret-request", request)).status).toBe(409);
    expect(store.pendingOutbox()).toHaveLength(1);
    expect(h.published()).toBe(1);
  });

  test("secret-request refuses a form whose conversation was reset while it was publishing", async () => {
    const h = setup(async () => {
      store.set("route", { id: "current", generation: 6 });
      return "https://mac.tailnet.ts.net:18400";
    });
    expect((await h.call("/secret-request", request)).status).toBe(409);
    expect(store.pendingOutbox()).toEqual([]);
  });

  test("secret-request validates input, the route, and publishing", async () => {
    const h = setup();
    for (const body of [{ ...request, fields: [] }, { ...request, fields: Array(9).fill(FIELDS[0]) },
      { ...request, fields: [FIELDS[0], FIELDS[0]] }, { ...request, fields: [{ name: "A", label: "x", type: "text" }] },
      { ...request, fields: [{ name: "a", label: "x", type: "pin" }] }, { ...request, fields: [{ ...FIELDS[0], extra: 1 }] },
      { ...request, purpose: "" }, { ...request, purpose: "a\nb" }, { ...request, sessionId: "a b" }, { ...request, extra: 1 }]) {
      expect((await h.call("/secret-request", body)).status).toBe(400);
    }
    expect((await h.call("/secret-request", { ...request, sessionId: "other" })).status).toBe(409);
    const failing = setup(async () => { throw new Error("PRIVATE"); });
    const failed = await failing.call("/secret-request", request);
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain("PRIVATE");
    expect((await setup(async () => "http://insecure").call("/secret-request", request)).status).toBe(502);
    expect(store.pendingOutbox()).toEqual([]);
    const withoutSecrets = createApi({ store, photon: { async react() {} }, router: () => undefined,
      chatGuid: () => "iMessage;-;+15555550123", enabled: () => true, health: () => ({}) });
    const response = await withoutSecrets(new Request("http://bridge/secret-request", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) }));
    expect(response.status).toBe(503);
  });

  test("secret-read returns the value and secret-forget deletes it", async () => {
    const h = setup();
    const { token } = await (await h.call("/secret-request", request)).json() as { token: string };
    expect((await h.call("/secret-read", { token, field: "password" })).status).toBe(409);
    expect((await post(token, filled)).status).toBe(200);
    const read = await h.call("/secret-read", { token, field: "password" });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ value: "PRIVATE-hunter2" });
    expect((await h.call("/secret-read", { token, field: "missing" })).status).toBe(404);
    expect((await h.call("/secret-read", { token: "bad", field: "password" })).status).toBe(400);
    expect((await h.call("/secret-read", { token, field: "password", extra: 1 })).status).toBe(400);
    expect(await (await h.call("/secret-forget", { token })).json()).toEqual({ forgotten: true });
    const gone = await h.call("/secret-read", { token, field: "password" });
    expect(gone.status).toBe(410);
    expect(await gone.json()).toEqual({ error: "Expired" });
  });
});
