import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { Shares } from "../src/share.ts";
import { encryptForm, newFormKeys } from "../src/secret-crypto.ts";
import { forgetSecret, getSecretRequest, newToken, putSecretRequest, readSecret } from "../src/secrets.ts";
import { createApi } from "../src/api.ts";

test("public encrypted forms are single-use, isolated, bounded and never expose values", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "public-secret-"));
  const store = new Store(":memory:");
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reserve.port!; await reserve.stop(true);
  const deps = { store, stateRoot };
  const shares = new Shares({ store, appsRoot: stateRoot, origin: { url: "https://cards.example.com", port },
    startTunnel: async () => { throw Error("unused"); }, secrets: () => deps });
  const token = newToken(); const ownerToken = newToken(); const expired = newToken();
  const encryption = await newFormKeys();
  const record = { sessionId: "current", generation: 1, purpose: "Test", fields: [{ name: "password", label: "Password", type: "password" as const }],
    createdAt: Date.now(), expiresAt: Date.now() + 900000, state: "open" as const };
  putSecretRequest(store, token, { ...record, encryption });
  putSecretRequest(store, ownerToken, record);
  putSecretRequest(store, expired, { ...record, encryption, expiresAt: 0 });
  try {
    expect(shares.secretBase()).toBe("https://cards.example.com");
    const origin = `http://127.0.0.1:${port}`;
    const url = `${origin}/_secret/${token}`;
    const page = await fetch(url); const html = await page.text();
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'sha256-");
    expect(html).toContain('method="dialog"');
    expect(html).not.toContain(encryption.privateKey.d!);
    expect(html).not.toContain('og:');
    // Execute exactly the script Safari receives, including its serialized crypto function.
    let onSubmit: (event: { preventDefault(): void }) => Promise<void> = async () => {};
    let encryptedBody: URLSearchParams | undefined;
    let cleared = false;
    const form = { addEventListener: (_: string, cb: typeof onSubmit) => { onSubmit = cb; },
      querySelector: () => ({ disabled: false }), reset: { value: "shadowed" }, replaceChildren() {} };
    const document = { querySelector: (selector: string) => selector === 'form' ? form : { textContent: '' } };
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    new Function('document', 'location', 'FormData', 'fetch', 'HTMLFormElement', script)(document, { pathname: `/_secret/${token}` },
      class { *[Symbol.iterator]() { yield ['password', 'browser-dummy']; } },
      async (_: string, init: { body: URLSearchParams }) => { encryptedBody = init.body; return { ok: true }; }, { prototype: { reset() { cleared = true; } } });
    await onSubmit({ preventDefault() {} });
    expect(encryptedBody?.has('ciphertext')).toBe(true);
    expect(cleared).toBe(true);
    expect(encryptedBody?.toString()).not.toContain('browser-dummy');
    for (const path of [`/_secret/${ownerToken}`, `/_secret/${newToken()}`, "/secret-read", "/secret-request", "/config.json", `/_secret/${token}/values`])
      expect((await fetch(origin + path)).status).toBe(404);
    expect((await fetch(`${origin}/_secret/${expired}`)).status).toBe(410);
    expect((await fetch(url, { method: "POST", body: new URLSearchParams({ password: "dummy" }) })).status).toBe(400);
    const bad = await encryptForm(encryption.publicKey, "password=dummy"); bad.set("ciphertext", "AAAA");
    expect((await fetch(url, { method: "POST", body: bad })).status).toBe(400);
    expect((await fetch(url, { method: "POST", body: "x".repeat(17000) })).status).toBe(413);
    const invalid = await fetch(url, { method: "POST", body: await encryptForm(encryption.publicKey, "password=") });
    expect(invalid.status).toBe(400); expect(await invalid.text()).not.toContain("<form");
    const body = await encryptForm(encryption.publicKey, new URLSearchParams({ password: "dummy-check" }).toString());
    const submitted = await fetch(url, { method: "POST", body });
    expect(submitted.status).toBe(200); expect(await submitted.text()).not.toContain("dummy-check");
    expect(await readSecret(deps, token, "password")).toBe("dummy-check");
    expect(getSecretRequest(store, token)?.encryption).toBeUndefined();
    expect((await fetch(url, { method: "POST", body })).status).toBe(404);
    expect(await (await fetch(url)).text()).not.toContain("dummy-check");
    await forgetSecret(deps, token);
    await expect(readSecret(deps, token, "password")).rejects.toThrow();
    const fresh = newToken(); putSecretRequest(store, fresh, { ...record, encryption });
    for (let i = 0; i < 121; i++) await fetch(`${origin}/_secret/${newToken()}`);
    expect((await fetch(`${origin}/_secret/${fresh}`)).status).toBe(200);
    for (let i = 0; i < 30; i++) await fetch(`${origin}/_secret/${fresh}`);
    expect((await fetch(`${origin}/_secret/${fresh}`)).status).toBe(429);
  } finally { await shares.stopAll(); store.close(); await rm(stateRoot, { recursive: true, force: true }); }
});

test("public request queues a generic card on the public base and fails closed without it", async () => {
  const store = new Store(":memory:"); store.set("route", { id: "current", generation: 1 });
  const api = (publishApps: () => Promise<string>) => createApi({ store, photon: {} as never, router: () => undefined,
    chatGuid: () => "iMessage;-;+15555550123", enabled: () => true, health: () => ({}),
    secrets: { stateRoot: "/unused", publishApps, publicForm: true } });
  const request = () => new Request("http://localhost/secret-request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    purpose: "Login today at 9 pm", fields: [{ name: "password", label: "Password", type: "password" }], dedupeKey: "public", sessionId: "current" }) });
  try {
    expect((await api(async () => { throw Error("missing origin"); })(request())).status).toBe(502);
    const response = await api(async () => "https://cards.example.com")(request());
    expect(response.status).toBe(202);
    const result = await response.json() as { token: string; url: string };
    expect(result.url).toBe(`https://cards.example.com/_secret/${result.token}`);
    expect(getSecretRequest(store, result.token)?.encryption).toBeDefined();
    const rows = store.db.query("SELECT * FROM outbox").all();
    expect(JSON.stringify(rows)).not.toContain("Login today");
  } finally { store.close(); }
});
