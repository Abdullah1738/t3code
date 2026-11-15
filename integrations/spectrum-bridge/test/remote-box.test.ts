import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteBox, remoteBoxConfig, type RemoteBoxConfig } from "../src/remote-box.ts";
import { opaqueId } from "../src/remote-protocol.ts";
import { Store } from "../src/store.ts";
import { BoxRunner } from "../../moni-box-runner/src/runner.ts";
import { ChatRegistry, createAgentBus, createSbApi } from "../src/runtime.ts";
import { chatKey, type Line } from "../src/line.ts";
const roots: string[] = [], closes: (() => void)[] = [];
afterEach(() => { closes.splice(0).forEach(f => f()); roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "remote-box-test-")); roots.push(root);
  const mac = join(root, "mac"), box = join(root, "box"); mkdirSync(mac); mkdirSync(box);
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const token = "a".repeat(40), callbackToken = "b".repeat(40);
  for (const [name, value] of Object.entries({ token, callbackToken, publicKey: keys.publicKey })) writeFileSync(join(mac, name), value);
  const config: RemoteBoxConfig = { kind: "remote-box", url: "http://127.0.0.1:12345", tokenFile: join(mac, "token"), callbackTokenFile: join(mac, "callbackToken"), publicKeyFile: join(mac, "publicKey"), callbackPort: 12346, epoch: "test", boxId: "bx_test" };
  const logs: string[] = [], notices: string[] = [], texts: string[] = [];
  let now = 1000, online = true, dropAck = false, active = true;
  const store = new Store(join(mac, "state.sqlite")); closes.push(() => store.close());
  const runner = new BoxRunner({ root: box, boxId: config.boxId, epoch: config.epoch, token, callbackToken, privateKey: keys.privateKey, callbackUrl: "http://127.0.0.1:12346", system: "system" }, { run: async ({ text }) => { texts.push(text); return "NO_REPLY"; } }, { now: () => now, fetch: (async () => Response.json({ epoch: "test", accepted: true })) });
  closes.push(() => runner.db.close());
  const remote = new RemoteBox(config, store, { now: () => now, active: () => active,
    log: (name, code) => logs.push(`${name} ${code ?? ""}`), notice: async id => { if (!notices.includes(id)) notices.push(id); },
    fetch: (async (url, init) => { if (!online) throw new Error("private error should never be logged"); const response = await runner.handle(new Request(String(url), init));
      if (String(url).endsWith("/deliver") && dropAck) { dropAck = false; throw new Error("lost ack"); } return response; }),
  });
  const line: Line = { number: "+15550000000", events: async function* () {}, backfill: async () => [], outbound: async () => [],
    sendText: async () => ({ handle: "sent" }), upload: async () => "https://media.example/file", getMessage: async () => undefined,
    sendApp: async () => ({ handle: "sent" }), react: async () => {}, typing: async () => {}, read: async () => {},
    requestLocation: async () => {}, location: async () => undefined, setOptOut: async () => {}, download: async () => ({ data: new Uint8Array(), name: "", mimeType: "" }) };
  return { root, mac, box, remote, runner, store, config, logs, notices, texts, line,
    advance: () => { now += 65_000; }, offline: () => { online = false; }, online: () => { online = true; }, drop: () => { dropAck = true; }, rollback: () => { active = false; },
    request: (path: string, body: unknown = {}, auth = callbackToken) => new Request(`http://bridge${path}`, { method: "POST", headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify({ epoch: "test", ...body as object }) }),
  };
}
function files(root: string): string { return readdirSync(root, { withFileTypes: true }).map(e => e.isDirectory() ? files(join(root, e.name)) : readFileSync(join(root, e.name)).toString()).join(""); }

test("per-chat selection is explicit, rejects other chats, preserves Robob rollback", () => {
  const s = setup(); expect(remoteBoxConfig({ chatBackends: { moni: s.config } }, "moni")).toEqual(s.config);
  expect(remoteBoxConfig({}, "owner")).toBeUndefined(); expect(remoteBoxConfig({ chatBackends: { moni: { kind: "robob" } } }, "moni")).toBeUndefined();
  expect(() => remoteBoxConfig({ chatBackends: { owner: s.config } }, "owner")).toThrow();
});
test("offline FIFO survives lost ack without a duplicate harness run or plaintext on relay", async () => {
  const s = setup(), canary = randomUUID(); s.offline();
  s.remote.accept("one", { text: canary }); s.remote.accept("two", { text: "second" });
  await s.remote.tick(); s.advance(); await s.remote.tick(); expect(s.notices).toHaveLength(1);
  s.online(); s.drop(); s.advance(); await s.remote.tick(); s.advance(); await s.remote.tick();
  await s.runner.tick(); await s.runner.tick(); expect(s.texts).toEqual([canary, "second"]);
  expect(files(s.mac)).not.toContain(canary); expect(s.logs.join()).not.toContain(canary);
  expect(s.logs.join()).toContain("moni-box-up"); expect(s.logs.join()).toContain("moni-queue-delivered n=2");
});
test("interrupted harness is fenced on restart and rollback expires the lease", async () => {
  const s = setup(); await s.remote.tick();
  s.runner.enqueue(opaqueId("interrupted"), { text: "do not repeat tools" });
  s.runner.db.exec("UPDATE inbox SET state='running'");
  const r = new BoxRunner(s.runner.config, { run: async () => { throw new Error("must not run"); } }, { callbackReady: async () => true }); closes.push(() => r.db.close());
  await r.handle(new Request("http://box/lease", { method: "POST", headers: { authorization: `Bearer ${"a".repeat(40)}` }, body: JSON.stringify({ boxId: "bx_test", epoch: "test" }) }));
  await r.tick(); expect(r.db.query<{ state: string }, []>("SELECT state FROM inbox").get()!.state).toBe("interrupted");
  s.rollback(); s.advance(); await s.remote.tick(); expect(s.runner.active()).toBe(false);
});
test("scoped API rejects owner routes, missing tokens, forged identities and cross-chat reactions before forwarding", async () => {
  const s = setup(); const ownerStore = new Store(join(s.mac, "owner.sqlite")); closes.push(() => ownerStore.close());
  const registry = new ChatRegistry({ owner: "+15555550123", ownerStore, stateRoot: s.mac, line: s.line,
    access: () => ({ people: [{ name: "Moni", role: "admin", addresses: ["+15555550199"] }], groups: [] }),
    build: chat => { if (chat.info.slug === "moni") chat.remote = s.remote; return { api: async () => Response.json({ unexpected: true }) }; } });
  registry.restore(); registry.open(chatKey.dm("+15555550199"));
  // The test registry's own chat store is independent of the relay queue used by this fake backend.
  registry.all().filter(c => c.store !== ownerStore).forEach(c => closes.push(() => c.store.close()));
  const api = createSbApi({ registry, line: s.line, accessPath: "unused", enabled: () => true, health: () => ({}) }, s.remote);
  for (const path of ["/router", "/health", "/wake", "/allow", "/allow-group", "/guests", "/secret-read", "/secret-request", "/app", "/location", "/messages"]) {
    expect((await api(s.request(path))).status).toBe(403);
  }
  expect((await api(s.request("/send", {}, ""))).status).toBe(403);
  expect((await api(s.request("/send", { sessionId: "owner" }))).status).toBe(403);
  expect((await api(s.request("/send", { to: "owner" }))).status).toBe(403);
  expect((await api(s.request("/react", { target: "owner-message", kind: "love" }))).status).toBe(403);
  const request = await api(s.request("/agent-ask", { to: "owner", text: "question", dedupeKey: "one", operationId: opaqueId("ask") }));
  expect(request.status).toBe(202);
});
test("callback send dedupe and ambiguous-send reconciliation store metadata only", async () => {
  const s = setup(); const secret = randomUUID(); let sends = 0;
  s.line.sendText = async () => { sends++; return { handle: "sent" }; };
  const io = { line: s.line, chat: chatKey.dm("+15555550199"), bus: async () => Response.json({}) };
  const body = { id: opaqueId("send"), text: secret };
  expect((await s.remote.callback(s.request("/send", body), io)).status).toBe(200);
  expect((await s.remote.callback(s.request("/send", body), io)).status).toBe(200); expect(sends).toBe(1);
  s.line.sendText = async () => { sends++; throw new Error(secret); };
  const uncertain = { id: opaqueId("uncertain"), text: secret };
  expect((await s.remote.callback(s.request("/send", uncertain), io)).status).toBe(502);
  expect((await s.remote.callback(s.request("/send", uncertain), io)).status).toBe(409); expect(sends).toBe(2);
  expect(files(s.mac)).not.toContain(secret);
});

test("bus answer acknowledgement is idempotent; owner relays refuse before writing a local outbox", async () => {
  const s = setup(), ownerStore = new Store(join(s.mac, "bus-owner.sqlite")); closes.push(() => ownerStore.close());
  const registry = new ChatRegistry({ owner: "+15555550123", ownerStore, stateRoot: s.mac, line: s.line,
    access: () => ({ people: [{ name: "Moni", role: "admin", addresses: ["+15555550199"] }], groups: [] }),
    build: chat => { if (chat.info.slug === "moni") chat.remote = s.remote; return { api: async () => Response.json({}) }; } });
  registry.restore(); const moni = registry.open(chatKey.dm("+15555550199")); closes.push(() => moni.store.close());
  ownerStore.set("route", { id: "owner-thread", generation: 1 });
  const options = { registry, line: s.line, accessPath: "unused", enabled: () => true, health: () => ({}) };
  const local = createSbApi(options), scoped = createSbApi(options, s.remote);
  const post = (path: string, body: unknown) => local(new Request(`http://bridge${path}`, { method: "POST", body: JSON.stringify(body) }));
  expect((await post("/send", { sessionId: "owner-thread", to: "moni", text: "do not store", dedupeKey: "relay" })).status).toBe(403);
  expect(moni.store.db.query<{ n: number }, []>("SELECT count(*) n FROM outbox").get()!.n).toBe(0);
  const ask = await post("/agent-ask", { sessionId: "owner-thread", to: "moni", text: "question", dedupeKey: "ask" });
  const id = (await ask.json() as { id: string }).id;
  const body = { request: id, text: "answer", operationId: opaqueId("bus-answer") };
  expect((await scoped(s.request("/agent-answer", body))).status).toBe(202);
  // Simulate losing the first HTTP response after the owner transaction committed.
  expect((await scoped(s.request("/agent-answer", body))).status).toBe(202);
  expect((await scoped(s.request("/agent-answer", { ...body, text: "different" }))).status).toBe(409);
  expect(ownerStore.db.query<{ n: number }, []>("SELECT count(*) n FROM inbound").get()!.n).toBe(1);
});
test("reconciliation excludes older, failed, and already-claimed sends", async () => {
  const s = setup(); s.line.sendText = async () => { throw new Error("uncertain"); };
  const io = { line: s.line, chat: chatKey.dm("+15555550199"), bus: async () => Response.json({}) };
  const body = { id: opaqueId("new-send"), text: "Done" };
  expect((await s.remote.callback(s.request("/send", body), io)).status).toBe(502);
  for (const [sentAt, status] of [[999, "sent"], [1001, "failed"]] as const) {
    s.line.outbound = async () => [{ handle: "old", chat: io.chat, text: "Done", sentAt, status }];
    expect((await s.remote.callback(s.request("/send", body), io)).status).toBe(409);
  }
  s.line.outbound = async () => [{ handle: "claimed", chat: io.chat, text: "Done", sentAt: 1001, status: "sent" }];
  s.store.db.query("INSERT INTO remote_sends VALUES (?,1000,'sent','claimed')").run(opaqueId("other-operation"));
  expect((await s.remote.callback(s.request("/send", body), io)).status).toBe(409);
});

test("confirmed-unsent failures retry; ambiguous failures stay fenced; outage notices retry once accepted", async () => {
  const { LineError } = await import("../src/line.ts");
  for (const code of ["http_429", "http_503"]) {
    const s = setup(); let attempts = 0;
    s.line.sendText = async () => { if (++attempts === 1) throw new LineError("unsent", code, true, false); return { handle: "notice" }; };
    const id = opaqueId(`notice:${code}`);
    await expect(s.remote.send(id, "offline", undefined, s.line, chatKey.dm("+15555550199"))).rejects.toThrow();
    await s.remote.send(id, "offline", undefined, s.line, chatKey.dm("+15555550199"));
    await s.remote.send(id, "offline", undefined, s.line, chatKey.dm("+15555550199"));
    expect(attempts).toBe(2);
  }
});

test("bridge readiness gates remote lease checks and sends before side effects", async () => {
  const s = setup(), ownerStore = new Store(join(s.mac, "disabled-owner.sqlite")); closes.push(() => ownerStore.close()); let enabled = false, sends = 0;
  s.line.sendText = async () => { sends++; return { handle: "accepted" }; };
  const registry = new ChatRegistry({ owner: "+15555550123", ownerStore, stateRoot: s.mac, line: s.line,
    access: () => ({ people: [{ name: "Moni", role: "admin", addresses: ["+15555550199"] }], groups: [] }),
    build: chat => { if (chat.info.slug === "moni") chat.remote = s.remote; return { api: async () => Response.json({}) }; } });
  registry.restore(); const moni = registry.open(chatKey.dm("+15555550199")); closes.push(() => moni.store.close());
  const api = createSbApi({ registry, line: s.line, accessPath: "unused", enabled: () => enabled, health: () => ({}) }, s.remote);
  expect((await api(s.request("/ready"))).status).toBe(503);
  const body = { id: opaqueId("disabled-send"), text: "reply" };
  expect((await api(s.request("/send", body))).status).toBe(503); expect(sends).toBe(0);
  enabled = true; expect((await api(s.request("/ready"))).status).toBe(200);
  expect((await api(s.request("/send", body))).status).toBe(200); expect(sends).toBe(1);
  s.rollback(); expect((await api(s.request("/ready"))).status).toBe(503);
});
