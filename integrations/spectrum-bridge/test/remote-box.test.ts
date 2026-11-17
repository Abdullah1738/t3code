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
import { parseCommand } from "../src/cli.ts";
import { captureLogs } from "./log-fixture.ts";
import { fenceOwnerAlert, notificationAccepted } from "../src/telegram-fallback.ts";
import { createApi as createTelegramApi } from "../../telegram-bridge/src/api.ts";
import { Store as TelegramStore } from "../../telegram-bridge/src/store.ts";
import { toolLog } from "../src/toollog.ts";
import { summarizeLog } from "../src/log-rollup.ts";
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
  const alerts: { text: string; key: string }[] = [], requests: { path: string; body: Record<string, unknown> }[] = [];
  let eventsFail = false;
  let requestHook: ((path: string) => Promise<void>) | undefined;
  let now = 1000, online = true, dropAck = false, active = true;
  const store = new Store(join(mac, "state.sqlite")); closes.push(() => store.close());
  const runner = new BoxRunner({ root: box, boxId: config.boxId, epoch: config.epoch, token, callbackToken, privateKey: keys.privateKey, callbackUrl: "http://127.0.0.1:12346", system: "system" }, { run: async ({ text }) => { texts.push(text); return "NO_REPLY"; } }, { now: () => now, fetch: (async () => Response.json({ epoch: "test", accepted: true })) });
  closes.push(() => runner.db.close());
  const io = { now: () => now, active: () => active,
    ownerAlert: async (_severity: "attention", text: string, key: string): Promise<boolean> => { alerts.push({ text, key }); return true; },
    log: (name: string, code?: string) => logs.push(`${name} ${code ?? ""}`), notice: async (id: string) => { notices.push(id); },
    fetch: (async (url, init) => { if (!online) throw new Error("private error should never be logged");
      const path = new URL(String(url)).pathname; requests.push({ path, body: JSON.parse(String(init?.body)) });
      await requestHook?.(path);
      if (path === "/events" && eventsFail) return Response.json({ error: "PRIVATE_EVENTS_ERROR" }, { status: 503 });
      const response = await runner.handle(new Request(String(url), init));
      if (String(url).endsWith("/deliver") && dropAck) { dropAck = false; throw new Error("lost ack"); } return response; }),
  } satisfies ConstructorParameters<typeof RemoteBox>[2];
  let remote = new RemoteBox(config, store, io);
  const line: Line = { number: "+15550000000", events: async function* () {}, backfill: async () => [], outbound: async () => [],
    sendText: async () => ({ handle: "sent" }), upload: async () => "https://media.example/file", getMessage: async () => undefined,
    sendApp: async () => ({ handle: "sent" }), react: async () => {}, typing: async () => {}, read: async () => {},
    requestLocation: async () => {}, location: async () => undefined, setOptOut: async () => {}, download: async () => ({ data: new Uint8Array(), name: "", mimeType: "" }) };
  return { root, mac, box, get remote() { return remote; }, runner, store, config, logs, notices, texts, alerts, requests, line,
    failEvents: () => { eventsFail = true; },
    ownerAlert: (alert: typeof io.ownerAlert) => { io.ownerAlert = alert; },
    requestHook: (hook: typeof requestHook) => { requestHook = hook; },
    restart: () => { const reopened = new Store(join(mac, "state.sqlite")); closes.push(() => reopened.close()); remote = new RemoteBox(config, reopened, io); },
    failNotice: () => { io.notice = async id => { notices.push(id); throw new Error("ambiguous notice"); }; },
    advance: (ms = 65_000) => { now += ms; }, offline: () => { online = false; }, online: () => { online = true; }, drop: () => { dropAck = true; }, rollback: () => { active = false; },
    request: (path: string, body: unknown = {}, auth = callbackToken) => new Request(`http://bridge${path}`, { method: "POST", headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify({ epoch: "test", ...body as object }) }),
  };
}
function files(root: string): string { return readdirSync(root, { withFileTypes: true }).map(e => e.isDirectory() ? files(join(root, e.name)) : readFileSync(join(root, e.name)).toString()).join(""); }

test.each([
  { kind: "wake", hasSend: false, age: 600_000, behind: "inbound", failed: true },
  { kind: "wake", hasSend: false, age: 599_999, behind: "inbound", failed: false },
  { kind: "inbound", hasSend: false, age: 600_000, behind: "inbound", failed: false },
  { kind: "wake", hasSend: true, age: 600_000, behind: "inbound", failed: false },
  { kind: "wake", hasSend: false, age: 600_000, behind: "wake", failed: false },
  { kind: "wake", hasSend: false, age: 600_000, behind: undefined, failed: false },
] as const)("wake autofail matrix %j", async ({ kind, hasSend, age, behind, failed }) => {
  const s = setup(), id = opaqueId("head");
  s.runner.enqueue(id, { kind, watcher: "homevisit", text: "PRIVATE_WAKE" });
  s.runner.db.query("UPDATE inbox SET state='interrupted',interrupted_at=1000 WHERE id=?").run(id);
  if (hasSend) s.runner.db.query("INSERT INTO actions(id,path,payload,state,inbox_id) VALUES (?,'/send','{}','pending',?)").run(opaqueId("sent"), id);
  if (behind) s.remote.accept("behind", { text: "PRIVATE_DM" }, undefined, behind);
  s.advance(age);
  const logs = await captureLogs(async () => {
    await s.remote.tick();
    if (failed) { await s.runner.tick(); s.restart(); s.advance(5_000); await s.remote.tick(); }
  });
  const state = s.runner.db.query<{ state: string }, [string]>("SELECT state FROM inbox WHERE id=?").get(id)!.state;
  expect(state).toBe(failed ? "done" : "interrupted");
  expect(logs.filter(l => l.name === "moni-box-wake-autofailed")).toHaveLength(failed ? 1 : 0);
  expect(s.alerts.filter(a => a.key === `moni-box-wake-autofailed:${id.slice(0, 12)}`)).toHaveLength(failed ? 1 : 0);
  if (failed) { expect(s.alerts.at(-1)!.text).toContain("homevisit"); expect(s.texts).toEqual(["PRIVATE_DM"]); }
  expect(s.requests.filter(r => r.path === "/resolve")).toHaveLength(failed ? 1 : 0);
  expect(s.notices).toHaveLength(0);
  expect(JSON.stringify([s.alerts, s.logs, logs])).not.toContain("PRIVATE_");
});

test("a custom wake age keeps a younger wake fenced and autofails at its boundary", async () => {
  const s = setup(), id = opaqueId("head"); s.config.wakeFenceAutoFailMs = 900_000;
  s.remote.accept("head", { text: "wake" }, undefined, "wake"); await s.remote.tick();
  s.runner.db.exec("UPDATE inbox SET state='interrupted',interrupted_at=1000");
  s.remote.accept("dm", { text: "dm" }); s.advance(899_999); await s.remote.tick();
  expect(s.runner.db.query<{ state: string }, [string]>("SELECT state FROM inbox WHERE id=?").get(id)!.state).toBe("interrupted");
  s.advance(5_000); await s.remote.tick();
  expect(s.runner.db.query<{ state: string }, [string]>("SELECT state FROM inbox WHERE id=?").get(id)!.state).toBe("done");
});

test("autofail finds a DM past a page of wakes and retries a lost alert acknowledgement unchanged after restart", async () => {
  const s = setup(), id = opaqueId("head");
  s.runner.enqueue(id, { kind: "wake", text: "private" });
  s.runner.db.exec("UPDATE inbox SET state='interrupted',interrupted_at=1000");
  for (let i = 0; i < 101; i++) s.runner.enqueue(opaqueId(`wake:${i}`), { kind: "wake", text: "private" });
  s.runner.enqueue(opaqueId("dm"), { kind: "inbound", text: "private" });
  let accepted = false;
  s.ownerAlert(async (_severity, text, key) => { s.alerts.push({ text, key }); return accepted; });
  s.advance(600_000); await s.remote.tick(); const alert = s.alerts[0];
  s.restart(); s.advance(65_000); accepted = true; await s.remote.tick();
  s.restart(); s.advance(65_000); await s.remote.tick();
  expect(s.alerts).toEqual([alert, alert]);
  expect(s.requests.filter(r => r.path === "/resolve")).toHaveLength(1);
  expect(s.notices).toHaveLength(0);
});

test("remote fenced DM alerts once at ten minutes across restart, without requeue or plaintext", async () => {
  const s = setup(); s.remote.accept("head", { text: "PRIVATE_HEAD" }); await s.remote.tick();
  s.runner.db.exec("UPDATE inbox SET state='interrupted',interrupted_at=1000");
  s.remote.accept("dm", { text: "PRIVATE_DM", attachments: [{ name: "PRIVATE_FILE" }] });
  s.advance(300_000); await s.remote.checkUnanswered();
  expect(s.alerts).toHaveLength(0);
  const before = s.requests.length;
  const logs = await captureLogs(async () => {
    s.advance(300_000); await s.remote.checkUnanswered();
    s.restart(); s.advance(3_600_000); await s.remote.checkUnanswered(); await s.remote.checkUnanswered();
  });
  expect(s.alerts.filter(a => a.key === `imessage-unanswered:${opaqueId("dm")}`)).toHaveLength(1);
  expect(s.requests).toHaveLength(before);
  expect(logs.filter(l => l.name === "unanswered.alert")).toHaveLength(2);
  expect(logs.find(l => l.name === "unanswered.alert")?.props?.backend).toBe("remote-box");
  expect((await summarizeLog((async function* () { yield* logs; })())).unanswered_alerts).toBe(2);
  expect(s.store.db.query("SELECT 1 FROM inbound").get()).toBeNull();
  expect(files(s.mac)).not.toContain("PRIVATE_");
});

test("a wake that acquires send evidence during resolution keeps the fence", async () => {
  const s = setup(), id = opaqueId("wake"); s.remote.accept("wake", { text: "private" }, undefined, "wake");
  await s.remote.tick(); s.runner.db.exec("UPDATE inbox SET state='interrupted',interrupted_at=1000");
  s.remote.accept("dm", { text: "private" });
  s.requestHook(async path => {
    if (path === "/resolve") s.runner.db.query("INSERT OR IGNORE INTO actions(id,path,payload,state,inbox_id) VALUES (?,'/send','{}','pending',?)").run(opaqueId("late-send"), id);
  });
  s.advance(600_000); await s.remote.tick(); s.advance(5_000); await s.remote.tick();
  expect(s.runner.db.query<{ state: string }, [string]>("SELECT state FROM inbox WHERE id=?").get(id)!.state).toBe("interrupted");
  expect(s.alerts.map(a => a.key)).toEqual([`moni-box-fenced:${id.slice(0, 12)}`]);
  expect(s.requests.filter(r => r.path === "/resolve")).toHaveLength(1);
  expect(s.logs.some(l => l.startsWith("moni-box-wake-autofailed "))).toBe(false);
});

test("unanswered retries freeze Telegram text after a lost acknowledgement and concurrent checks across restart", async () => {
  const s = setup(); let accepted = false;
  s.ownerAlert(async (_severity, text, key) => { s.alerts.push({ text, key }); return accepted; });
  s.remote.accept("dm", { text: "PRIVATE" }); s.advance(600_000);
  await Promise.all([s.remote.checkUnanswered(), s.remote.checkUnanswered()]);
  const original = s.alerts[0]; expect(s.alerts).toHaveLength(1);
  s.restart(); s.advance(600_000); accepted = true; await s.remote.checkUnanswered();
  s.restart(); s.advance(600_000); await s.remote.checkUnanswered();
  expect(s.alerts).toEqual([original, original]);
});

test("successful attributed sends and reactions answer only their own DM; uncertain sends and notices do not", async () => {
  const s = setup(), chat = chatKey.dm("+15555550199");
  for (const id of ["replied", "later", "reacted", "uncertain"]) s.remote.accept(id, { text: "PRIVATE" });
  const io = { line: s.line, chat, bus: async () => Response.json({}) };
  const body = { id: opaqueId("reply"), inboxId: opaqueId("replied"), text: "reply" };
  expect((await s.remote.callback(s.request("/send", body), io)).status).toBe(200);
  expect((await s.remote.callback(s.request("/send", body), io)).status).toBe(200);
  expect((await s.remote.callback(s.request("/react", { target: "reacted", kind: "like" }), io)).status).toBe(200);
  const broken = { ...io, line: { ...s.line, sendText: async () => { throw new Error("uncertain"); } } };
  expect((await s.remote.callback(s.request("/send", { id: opaqueId("broken"), inboxId: opaqueId("uncertain"), text: "reply" }), broken)).status).toBe(502);
  await s.remote.send(opaqueId("notice"), "offline", undefined, s.line, chat);
  s.restart(); s.advance(600_000); await s.remote.checkUnanswered();
  expect(s.alerts.map(a => a.key).sort()).toEqual(["later", "uncertain"].map(id => `imessage-unanswered:${opaqueId(id)}`).sort());
});

test("remote backend state is logged at construction and every five minutes even while inactive", async () => {
  const logs = await captureLogs(async () => {
    const s = setup(); s.rollback(); await s.remote.tick(); s.advance(299_999); await s.remote.tick();
    s.advance(1); await s.remote.tick(); s.restart();
  });
  const states = logs.filter(l => l.name === "moni-box-backend-state");
  expect(states).toHaveLength(3); expect(states.map(l => l.props?.active)).toEqual([true, false, false]);
});

test.each(["inbound", "wake"] as const)("%s fence logs and alerts once across ticks and restart; growth logs again and resolve clears once", async kind => {
  const s = setup(), id = opaqueId("fenced"), canary = "PRIVATE_FENCE_CANARY";
  s.remote.accept("fenced", { text: canary }, undefined, kind);
  const lines = await captureLogs(async () => {
    await s.remote.tick();
    // The payload kind arrived through the encrypted envelope, not a Mac-only column.
    s.runner.db.query("UPDATE inbox SET state='interrupted',interrupted_at=1000 WHERE id=?").run(id);
    for (let i = 0; i < 3; i++) { s.advance(5_000); await s.remote.tick(); }
    s.restart(); s.advance(5_000); await s.remote.tick();
    expect(s.logs.filter(l => l.startsWith("moni-box-fenced "))).toHaveLength(1);
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]!.key).toBe(`moni-box-fenced:${id.slice(0, 12)}`);
    expect(s.alerts[0]!.text).toContain(`interrupted ${kind}`);
    expect(s.alerts[0]!.text).toContain(`--id ${id} --state done|pending`);
    s.remote.accept("behind", { text: canary }); s.advance(5_000); await s.remote.tick();
    expect(s.logs.filter(l => l.startsWith("moni-box-fenced "))).toHaveLength(2);
    expect(s.alerts).toHaveLength(1);
    await s.remote.resolve(id, "done"); s.advance(5_000); await s.remote.tick(); s.advance(5_000); await s.remote.tick();
    expect(s.logs.filter(l => l.startsWith("moni-box-unfenced "))).toHaveLength(1);
    // Re-fencing the same id after explicit pending resolution must not re-alert.
    s.runner.db.query("UPDATE inbox SET state='interrupted' WHERE id=?").run(id);
    s.advance(5_000); await s.remote.tick(); expect(s.alerts).toHaveLength(1);
  });
  expect(lines.find(l => l.name === "moni-box-fenced")?.props).toEqual({ event: id.slice(0, 12), kind, ageMs: 5000, hasSend: false, queuedBehind: 0 });
  expect(lines.find(l => l.name === "moni-box-unfenced")?.props).toEqual({ event: id.slice(0, 12), fencedMs: 30000 });
  expect(JSON.stringify([s.logs, s.alerts, lines])).not.toContain(canary);
  expect(s.notices).toHaveLength(0); expect(s.texts).toHaveLength(0);
});

test("an events failure never starts an outage or sends a notice, even after grace", async () => {
  const s = setup(); s.failEvents(); s.remote.accept("waiting", { text: "PRIVATE_EVENTS_ERROR" });
  for (let i = 0; i < 4; i++) { await s.remote.tick(); s.advance(130_000); }
  expect(s.store.get("remoteOutage")).toBeUndefined(); expect(s.notices).toHaveLength(0); expect(s.alerts).toHaveLength(0);
  expect(s.logs.join()).not.toContain("moni-box-down"); expect(s.logs.join()).not.toContain("PRIVATE_EVENTS_ERROR");
});

test.each([
  ["unavailable", false], ["throws", false], ["queued without acknowledgment", false], ["queued then throws", false],
  ["unavailable", true], ["throws", true], ["queued without acknowledgment", true], ["queued then throws", true],
] as const)("owner alert retries %s with identical text until acknowledged (restart=%s)", async (failure, restart) => {
  const s = setup(), id = opaqueId("fenced"), canary = "PRIVATE_ALERT_CANARY";
  const telegram = new TelegramStore(join(s.root, "telegram.sqlite")); closes.push(() => telegram.close());
  const api = createTelegramApi({ store: telegram, enabled: () => true, chatId: () => 123, timezone: "UTC", health: () => ({}) });
  const statuses: number[] = [];
  let recovered = false;
  s.ownerAlert(async (severity, text, key) => {
    s.alerts.push({ text, key });
    if (!recovered && failure === "unavailable") return false;
    if (!recovered && failure === "throws") throw new Error("PRIVATE_ALERT_ERROR");
    const response = await api(new Request("http://telegram/notify", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "iMessage bridge", severity, text, dedupeKey: key }) }));
    statuses.push(response.status);
    if (!recovered && failure === "queued then throws") throw new Error("PRIVATE_ALERT_ERROR");
    return notificationAccepted(recovered ? response.status : undefined);
  });
  s.remote.accept("fenced", { text: canary }); await s.remote.tick();
  s.runner.db.exec("UPDATE inbox SET state='interrupted',interrupted_at=1000");
  s.advance(5_000); await s.remote.tick();
  const original = s.alerts[0]!;
  expect(s.store.get<unknown>(`remoteFenceAlert:${id}`)).toEqual(original);
  s.remote.accept("behind", { text: canary }); s.advance(65_000); await s.remote.tick();
  expect(s.alerts).toEqual([original, original]);
  expect(s.store.get<unknown>(`remoteFenceAlert:${id}`)).toEqual(original);
  // Telegram can finish sending while the bridge still has no acknowledgment.
  for (const operation of telegram.pendingOutbox()) telegram.outboxState(operation.id, "sent", 456);
  if (restart) s.restart();
  recovered = true; s.advance(65_000); await s.remote.tick();
  expect(s.alerts).toEqual([original, original, original]);
  expect(s.store.get<unknown>(`remoteFenceAlert:${id}`)).toBe(true);
  expect(statuses).toEqual(failure.startsWith("queued") ? [202, 200, 200] : [202]);
  const operations = telegram.db.query<{ state: string; payload: string }, []>("SELECT state,payload FROM outbox").all();
  expect(operations).toHaveLength(1);
  expect(operations[0]!.state).toBe(failure.startsWith("queued") ? "sent" : "pending");
  s.restart(); s.advance(5_000); await s.remote.tick(); s.advance(5_000); await s.remote.tick();
  expect(s.alerts).toHaveLength(3); expect(s.notices).toHaveLength(0); expect(s.texts).toHaveLength(0);
  expect(JSON.stringify([s.logs, s.alerts, operations])).not.toContain(canary);
  expect(s.logs.join()).not.toContain("PRIVATE_ALERT_ERROR"); expect(s.store.get("remoteOutage")).toBeUndefined();
});

test("stalled owner alerts leave the box lease live and owner resolution available on every retry", async () => {
  const s = setup(), id = opaqueId("fenced"), canary = "PRIVATE_SLOW_ALERT_CANARY";
  const socket = join(s.root, "telegram.sock");
  let release!: (response: Response) => void;
  const stalled = new Promise<Response>(resolve => { release = resolve; });
  const server = Bun.serve({ unix: socket, fetch: () => stalled });
  const alert = fenceOwnerAlert(socket);
  s.ownerAlert(async (severity, text, key) => {
    s.alerts.push({ text, key });
    const started = performance.now(), accepted = await alert(severity, text, key);
    s.advance(Math.ceil(performance.now() - started));
    return accepted;
  });
  try {
    s.remote.accept("fenced", { text: canary }); await s.remote.tick();
    for (let i = 0; i < 3; i++) {
      s.runner.db.exec("UPDATE inbox SET state='interrupted',interrupted_at=1000");
      s.advance(5_000); await s.remote.tick();
      expect(s.runner.active()).toBe(true);
      expect(await s.remote.resolve(id, i === 2 ? "done" : "pending")).toEqual({ accepted: true });
      expect(s.store.get<unknown>(`remoteFenceAlert:${id}`)).toEqual(s.alerts[0]);
    }
    expect(s.alerts).toEqual([s.alerts[0], s.alerts[0], s.alerts[0]]);
    expect(s.notices).toHaveLength(0); expect(s.store.get("remoteOutage")).toBeUndefined();
    expect(JSON.stringify([s.logs, s.alerts])).not.toContain(canary);
  } finally { release(Response.json({})); await server.stop(true); }
}, 8_000);

test("slow events and alerts permit concurrent lease renewals and owner resolution on repeated probes", async () => {
  const s = setup(), id = opaqueId("fenced"), canary = "PRIVATE_SLOW_PROBE_CANARY";
  const gate = () => {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
  };
  s.remote.accept("fenced", { text: canary }); await s.remote.tick();
  for (let i = 0; i < 3; i++) {
    const events = gate(), eventsStarted = gate(), lease = gate(), leaseStarted = gate(), alert = gate(), alertStarted = gate();
    let leases = 0;
    s.requestHook(async path => {
      if (path === "/events") { eventsStarted.release(); await events.promise; }
      if (path === "/lease" && ++leases === 2) { leaseStarted.release(); await lease.promise; }
    });
    s.ownerAlert(async (_severity, text, key) => {
      s.alerts.push({ text, key }); alertStarted.release(); await alert.promise; return false;
    });
    s.runner.db.exec("UPDATE inbox SET state='interrupted',interrupted_at=1000");
    s.advance(5_000); const probing = s.remote.tick(); await eventsStarted.promise;
    s.advance(5_000); const renewing = s.remote.tick(); await leaseStarted.promise;
    // Events take 9.5s, the overlapping renewal 4.75s, and the owner alert another 1s.
    s.advance(4_500); events.release(); await alertStarted.promise;
    expect(s.runner.active()).toBe(true);
    s.advance(250); lease.release(); await renewing;
    s.advance(750); alert.release(); await probing;
    expect(s.requests.filter(r => r.path === "/events")).toHaveLength(i + 2);
    expect(s.runner.active()).toBe(true);
    expect(await s.remote.resolve(id, i === 2 ? "done" : "pending")).toEqual({ accepted: true });
    expect(s.store.get<unknown>(`remoteFenceAlert:${id}`)).toEqual(s.alerts[0]);
  }
  expect(s.alerts).toEqual([s.alerts[0], s.alerts[0], s.alerts[0]]);
  expect(s.notices).toHaveLength(0); expect(s.store.get("remoteOutage")).toBeUndefined();
  expect(JSON.stringify([s.logs, s.alerts])).not.toContain(canary);
});

test("remote commands require an owner session; resolve is reconciled and cannot replay completed work", async () => {
  const s = setup(), ownerStore = new Store(join(s.mac, "remote-owner.sqlite")); closes.push(() => ownerStore.close());
  const registry = new ChatRegistry({ owner: "+15555550123", ownerStore, stateRoot: s.mac, line: s.line,
    access: () => ({ people: [{ name: "Moni", role: "admin", addresses: ["+15555550199"] }], groups: [] }),
    build: chat => { if (chat.info.slug === "moni") chat.remote = s.remote; return { api: async () => Response.json({}) }; } });
  registry.restore(); const moni = registry.open(chatKey.dm("+15555550199")); closes.push(() => moni.store.close());
  ownerStore.set("route", { id: "owner-thread", generation: 1 });
  const api = createSbApi({ registry, line: s.line, accessPath: "unused", enabled: () => true, health: () => ({}) });
  const post = (path: string, body: unknown) => api(new Request(`http://bridge${path}`, { method: "POST", body: JSON.stringify(body) }));
  const id = opaqueId("blocked"); s.remote.accept("blocked", { text: "PRIVATE" }); await s.remote.tick();
  s.runner.db.exec("UPDATE inbox SET state='interrupted'");
  for (const path of ["/remote-events", "/remote-resolve"]) {
    for (const sessionId of [undefined, s.remote.sessionId, "stale"]) {
      const n = s.requests.length;
      expect((await post(path, { sessionId, chat: "moni", ...(path === "/remote-resolve" ? { id, state: "done" } : {}) })).status).toBe(sessionId === "stale" ? 409 : 403);
      expect(s.requests).toHaveLength(n);
    }
  }
  const events = parseCommand(["remote-events", "--chat", "moni", "--session", "owner-thread"]);
  expect((await post(events.path, events.body)).status).toBe(200);
  const resolve = parseCommand(["remote-resolve", "--chat", "moni", "--id", id, "--state", "done", "--session", "owner-thread"]);
  expect(await (await post(resolve.path, resolve.body)).json()).toEqual({ accepted: true });
  expect(s.requests.at(-1)).toEqual({ path: "/resolve", body: { id, state: "done", reconciled: true } });
  const conflict = await post("/remote-resolve", { ...resolve.body, state: "pending" });
  expect(conflict.status).toBe(409); expect(await conflict.json()).toEqual({ error: "Event is not interrupted/attachment-failed" });
  expect(() => parseCommand(["remote-events", "--chat", "moni"])).toThrow("--session");
  for (const [field, value] of [["chat", "owner"], ["id", id.slice(0, 12)], ["state", "running"]]) {
    expect(() => parseCommand(["remote-resolve", "--chat", field === "chat" ? value! : "moni", "--id", field === "id" ? value! : id,
      "--state", field === "state" ? value! : "done", "--session", "owner-thread"])).toThrow();
  }
  const socket = join(s.root, "cli.sock"), server = Bun.serve({ unix: socket, fetch: api });
  const cli = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname, ...args], {
      env: { ...process.env, SPECTRUM_BRIDGE_SOCKET: socket }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  };
  try {
    expect(await cli("remote-events", "--chat", "moni", "--session", "owner-thread"))
      .toEqual({ stdout: '{"events":[]}\n', stderr: "", code: 0 });
    expect(await cli("remote-resolve", "--chat", "moni", "--session", "owner-thread", "--id", id, "--state", "done"))
      .toEqual({ stdout: '{"accepted":true}\n', stderr: "", code: 0 });
    const conflict = await cli("remote-resolve", "--chat", "moni", "--session", "owner-thread", "--id", id, "--state", "pending");
    expect(conflict.code).toBe(1); expect(conflict.stdout).toBe(""); expect(conflict.stderr).toContain("not interrupted/attachment-failed");
    const refused = await cli("remote-resolve", "--chat", "moni", "--session", s.remote.sessionId, "--id", id, "--state", "done");
    expect(refused.code).toBe(1); expect(refused.stderr).toContain("Only the owner's chat");
    s.runner.db.transaction(() => { for (let i = 0; i < 1000; i++) s.runner.enqueue(opaqueId(`cli-page:${i}`), { kind: "wake", text: "PRIVATE_LARGE_QUEUE" }); })();
    const page = await cli("remote-events", "--chat", "moni", "--session", "owner-thread");
    expect(page.code).toBe(0); expect(page.stderr).toBe(""); expect(page.stdout).not.toContain("PRIVATE_LARGE_QUEUE");
    const metadata = JSON.parse(page.stdout); expect(metadata.events).toHaveLength(100); expect(metadata.remaining).toBe(900);
    const nextPage = await cli("remote-events", "--chat", "moni", "--session", "owner-thread", "--after", metadata.nextCursor);
    expect(nextPage.code).toBe(0); expect(JSON.parse(nextPage.stdout).events[0].id).toBe(opaqueId("cli-page:100"));
    expect(() => parseCommand(["remote-events", "--chat", "moni", "--session", "owner-thread", "--after", "short"])).toThrow("--after");
  } finally { await server.stop(true); }
});

test("a large fenced backlog logs its full depth even after a page of skipped attachment failures", async () => {
  const s = setup(); await s.remote.tick();
  s.runner.db.transaction(() => { for (let i = 0; i < 1200; i++) {
    const id = opaqueId(`large:${i}`); s.runner.enqueue(id, { kind: "wake", text: "PRIVATE_BIG_FENCE" });
    if (i < 150) s.runner.db.query("UPDATE inbox SET state='attachment-failed' WHERE id=?").run(id);
    if (i === 150) s.runner.db.query("UPDATE inbox SET state='interrupted' WHERE id=?").run(id);
  } })();
  s.advance(5_000); await s.remote.tick();
  const fence = JSON.parse(s.logs.find(l => l.startsWith("moni-box-fenced "))!.slice("moni-box-fenced ".length));
  expect(fence.queuedBehind).toBe(1049); expect(fence.event).toBe(opaqueId("large:150").slice(0, 12));
  expect(s.alerts[0]!.text).toContain("1049 later messages waiting"); expect(JSON.stringify([s.logs, s.alerts])).not.toContain("PRIVATE_BIG_FENCE");
  expect(s.notices).toHaveLength(0);
});

test("per-chat selection is explicit, rejects other chats, preserves Robob rollback", () => {
  const s = setup(); expect(remoteBoxConfig({ chatBackends: { moni: s.config } }, "moni")).toEqual(s.config);
  expect(remoteBoxConfig({}, "owner")).toBeUndefined(); expect(remoteBoxConfig({ chatBackends: { moni: { kind: "robob" } } }, "moni")).toBeUndefined();
  expect(() => remoteBoxConfig({ chatBackends: { owner: s.config } }, "owner")).toThrow();
});
test("offline FIFO survives lost ack without a duplicate harness run or plaintext on relay", async () => {
  const s = setup(), canary = randomUUID(); s.offline();
  s.remote.accept("one", { text: canary }); s.remote.accept("two", { text: "second" });
  await s.remote.tick(); s.advance(); await s.remote.tick(); s.advance(); await s.remote.tick(); expect(s.notices).toHaveLength(1);
  s.online(); s.drop(); s.advance(); await s.remote.tick(); s.advance(); await s.remote.tick();
  await s.runner.tick(); await s.runner.tick(); expect(s.texts).toEqual([canary, "second"]);
  s.advance(300_000); await s.remote.tick();
  expect(files(s.mac)).not.toContain(canary); expect(s.logs.join()).not.toContain(canary);
  expect(s.logs.join()).toContain("moni-box-up"); expect(s.logs.join()).toContain("moni-queue-delivered n=2");
});

test.each(["empty", "bus", "watcher"])("ten flaps and a long outage stay silent with only %s work", async kind => {
  const s = setup();
  if (kind !== "empty") s.remote.accept(`wake:${kind}`, { text: "machine work" }, undefined, "wake");
  for (let i = 0; i < 10; i++) {
    s.offline(); await s.remote.tick(); s.advance(30_000);
    s.online(); await s.remote.tick(); s.advance(30_000);
  }
  expect(s.notices).toHaveLength(0);
  if (kind !== "empty") s.remote.accept(`wake:${kind}:pending`, { text: "machine work" }, undefined, "wake");
  s.offline(); await s.remote.tick(); s.advance(130_000); await s.remote.tick();
  expect(s.notices).toHaveLength(0); expect(s.logs.join()).toContain("moni-notice-suppressed not-waiting");
});

test("waiting inbound needs continuous grace, retains one outage through ten flaps", async () => {
  const s = setup(); s.remote.accept("real-inbound", { text: "private" });
  s.offline(); await s.remote.tick();
  const outage = s.store.get<{ id: string }>("remoteOutage")!.id;
  s.advance(119_999); await s.remote.tick(); expect(s.notices).toHaveLength(0);
  s.advance(65_000); await s.remote.tick(); expect(s.notices).toHaveLength(1);
  s.advance(); await s.remote.tick(); expect(s.notices).toHaveLength(1);
  expect(s.logs.join()).toContain("moni-notice-suppressed already-sent");
  for (let i = 0; i < 10; i++) {
    s.advance(); s.online(); await s.remote.tick(); s.advance(30_000);
    s.remote.accept(`inbound-${i}`, { text: "private" }); s.offline(); await s.remote.tick();
    expect(s.store.get<{ id: string }>("remoteOutage")!.id).toBe(outage);
    s.advance(130_000); await s.remote.tick();
  }
  expect(s.notices).toHaveLength(1); expect(s.logs.join()).toContain("moni-notice-suppressed grace");
});

test("notice cap persists across restart and a distinct outage, then expires at six hours", async () => {
  const s = setup(); s.remote.accept("first", { text: "private" }); s.offline(); await s.remote.tick();
  s.advance(120_000); await s.remote.tick(); expect(s.notices).toHaveLength(1);
  const sentAt = s.store.get<number>("remoteNoticeAt")!;
  s.restart(); s.advance(); await s.remote.tick(); expect(s.notices).toHaveLength(1);
  s.advance(120_000); await s.remote.tick(); expect(s.notices).toHaveLength(1);
  expect(s.logs.join()).toContain("moni-notice-suppressed already-sent");
  s.online(); s.advance(); await s.remote.tick(); s.advance(300_000); await s.remote.tick();
  expect(s.store.get("remoteOutage")).toBeNull();
  s.remote.accept("second", { text: "private" }); s.offline(); s.advance(); await s.remote.tick();
  s.advance(120_000); s.restart(); await s.remote.tick(); expect(s.notices).toHaveLength(1);
  s.advance(120_000); await s.remote.tick(); expect(s.notices).toHaveLength(1);
  expect(s.logs.join()).toContain("moni-notice-suppressed rate-limited");
  const elapsed = s.store.get<number>("remoteNoticeAt")! - sentAt;
  expect(elapsed).toBe(0);
  s.advance(21_600_000); await s.remote.tick(); expect(s.notices).toHaveLength(2);
});

test.each([60_000, 120_001, 21_600_001].flatMap(stoppedMs => [false, true].map(waiting => ({ stoppedMs, waiting }))))(
  "restart after $stoppedMs ms restarts continuous grace with waiting=$waiting", async ({ stoppedMs, waiting }) => {
    const s = setup();
    if (waiting) s.remote.accept("waiting", { text: "private" });
    s.offline(); await s.remote.tick();
    const id = s.store.get<{ id: string }>("remoteOutage")!.id;
    s.advance(stoppedMs); s.restart(); await s.remote.tick();
    expect(s.notices).toHaveLength(0);
    expect(s.store.get<{ id: string }>("remoteOutage")!.id).toBe(id);
    expect(s.logs.at(-2)).toBe("moni-notice-suppressed grace");
    s.advance(119_999); await s.remote.tick(); expect(s.notices).toHaveLength(0);
    s.advance(65_000); await s.remote.tick(); expect(s.notices).toHaveLength(waiting ? 1 : 0);
    expect(s.store.get<{ id: string }>("remoteOutage")!.id).toBe(id);
  });

test("restart cannot count unobserved time as sustained recovery", async () => {
  const s = setup(); s.offline(); await s.remote.tick(); s.online(); s.advance(); await s.remote.tick();
  const id = s.store.get<{ id: string }>("remoteOutage")!.id;
  s.advance(600_000); s.restart(); await s.remote.tick();
  expect(s.store.get<{ id: string }>("remoteOutage")!.id).toBe(id);
  s.advance(300_000); await s.remote.tick(); expect(s.store.get("remoteOutage")).toBeNull();
});

test("an uncertain notice reserves both caps before sending and survives restart", async () => {
  const s = setup(); s.failNotice(); s.remote.accept("waiting", { text: "private" });
  s.offline(); await s.remote.tick(); s.advance(120_000); await s.remote.tick();
  expect(s.notices).toHaveLength(1); expect(s.logs.join()).toContain("moni-notice-error");
  s.restart(); s.advance(); await s.remote.tick(); expect(s.notices).toHaveLength(1);
  s.online(); s.advance(); await s.remote.tick(); s.advance(300_000); await s.remote.tick();
  s.remote.accept("waiting-again", { text: "private" }); s.offline(); s.advance(); await s.remote.tick();
  s.advance(120_000); await s.remote.tick(); expect(s.notices).toHaveLength(1);
  expect(s.logs.join()).toContain("moni-notice-suppressed rate-limited");
});

test("legacy sends seed the cap and unclassified ciphertext cannot trigger a notice", async () => {
  const s = setup(); s.remote.accept("legacy", { text: "private" });
  s.store.db.exec("UPDATE remote_inbox SET kind='unknown'");
  s.store.db.query("INSERT INTO remote_sends VALUES (?,1000,'sent','legacy')").run(opaqueId("legacy-notice"));
  s.restart(); expect(s.store.get<number>("remoteNoticeAt")).toBe(1000);
  s.offline(); await s.remote.tick(); s.advance(130_000); await s.remote.tick();
  expect(s.notices).toHaveLength(0); expect(s.logs.join()).toContain("moni-notice-suppressed not-waiting");
  s.remote.accept("new-inbound", { text: "private" }); s.advance(); await s.remote.tick();
  expect(s.logs.join()).toContain("moni-notice-suppressed rate-limited"); expect(s.notices).toHaveLength(0);
});

test.each(["noticeAfterMs", "outageClearMs", "noticeMinGapMs", "wakeFenceAutoFailMs"])("%s validates duration shapes", field => {
  const s = setup();
  for (const value of [null, true, "120000", -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => remoteBoxConfig({ chatBackends: { moni: { ...s.config, [field]: value } } }, "moni")).toThrow();
  }
  expect(remoteBoxConfig({ chatBackends: { moni: { ...s.config, [field]: 0 } } }, "moni")).toBeDefined();
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
test("Moni remote-box receipt and delivered reply never wait on a local Robob outage", async () => {
  const s = setup(), ownerStore = new Store(join(s.mac, "owner.sqlite")); closes.push(() => ownerStore.close());
  const key = chatKey.dm("+15555550199");
  const registry = new ChatRegistry({ owner: "+15555550123", ownerStore, stateRoot: s.mac, line: s.line, backend: "robob",
    access: () => ({ people: [{ name: "Moni", role: "admin", addresses: ["+15555550199"] }], groups: [] }),
    build: chat => { if (chat.info.slug === "moni") chat.remote = s.remote; return {}; } });
  const moni = registry.open(key); closes.push(() => moni.store.close());
  const call = (ok: boolean) => toolLog.write({ component: "robob", kind: "perf", name: "turn.robob_call", ok, durationMs: 10,
    props: { method: "GET", route: "/threads/:id/messages", ...(ok ? {} : { linkCause: "ECONNREFUSED" }), failureFormat: "single" } });
  // A prior test can leave the process-wide logger inside an outage. Recover it outside this fixture.
  call(true); toolLog.flush(); await toolLog.settled();
  const rows = await captureLogs(async () => {
    call(true);
    for (let i = 0; i < 3; i++) call(false);
    try {
      const sink = registry.sink(async () => {}).acceptInto(key, undefined, "+15555550199");
      expect(sink.accept({ id: "remote-inbound", text: "PRIVATE_MONI_MESSAGE", attachments: [] })).toBe(true);
      expect(await s.remote.send(opaqueId("remote-reply"), "PRIVATE_MONI_REPLY", undefined, s.line, key)).toMatchObject({ handle: "sent" });
    } finally { call(true); }
  });
  expect(rows.find(row => row.name === "msg.received")?.props?.backend).toBe("remote-box");
  expect(rows.some(row => row.name === "moni-reply-sent")).toBe(true);
  expect(rows.find(row => row.name === "robob.link_up")?.link).toMatchObject({ inboundReceivedDuringOutage: 0, inboundAnsweredAfter: 0, inboundAnsweredDuringOutage: 0 });
  const rollup = await summarizeLog((async function* () { yield* rows; })());
  expect(rollup.robob_link.messagesWaiting).toBe(0);
  expect(rollup.robob_link.outages).toHaveLength(1);
  expect(rollup.robob_link.outages[0]).toMatchObject({ inboundReceivedDuringOutage: 0, inboundAnsweredAfter: 0, inboundAnsweredDuringOutage: 0 });
  expect(JSON.stringify(rows)).not.toContain("PRIVATE_MONI_");
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

test("box watcher canary stays out of Mac state, archives and logs; lease expiry pauses it", async () => {
  const { BoxWatchers } = await import("../../moni-box-runner/src/watchers.ts");
  const s = setup(), canary = randomUUID(); let checks = 0;
  const watches = new BoxWatchers(s.runner, async () => { checks++; return { code: 0, stdout: canary }; });
  watches.add({ id: "wa-existing", check: "wa new existing-cursor", interval: 5, expiresAt: 99999999, maxFires: 0, context: canary });
  await watches.tick(); expect(checks).toBe(0);
  await s.remote.tick(); await watches.tick(); await s.runner.tick();
  expect(checks).toBe(1); expect(files(s.box)).toContain(canary); expect(files(s.mac)).not.toContain(canary); expect(s.logs.join()).not.toContain(canary);
  s.rollback(); s.advance(); await watches.tick(); expect(checks).toBe(1);
});

test("delivery card owner relay to a remote Moni chat reports the exact refusal without sending", async () => {
  const s = setup(), ownerStore = new Store(join(s.mac, "delivery-owner.sqlite")); closes.push(() => ownerStore.close());
  let sends = 0;
  s.line.sendText = async () => { sends++; throw new Error("No real sends allowed"); };
  const registry = new ChatRegistry({ owner: "+15555550123", ownerStore, stateRoot: s.mac, line: s.line,
    access: () => ({ people: [{ name: "Moni", role: "admin", addresses: ["+15555550199"] }], groups: [] }),
    build: chat => { if (chat.info.slug === "moni") chat.remote = s.remote; return { api: async () => Response.json({}) }; } });
  registry.restore(); const moni = registry.open(chatKey.dm("+15555550199")); closes.push(() => moni.store.close());
  const session = "ardud-control:thread:fake-owner";
  ownerStore.set("route", { id: session, generation: 1 });
  const api = createSbApi({ registry, line: s.line, accessPath: join(s.mac, "access.json"), enabled: () => true, health: () => ({}) });
  const command = parseCommand(["send", "--to", "moni", "--text=https://cards.example.com/s/fake/", "--session", session,
    "--key", "delivery-card:order-amazon-fake"]);
  const response = await api(new Request(`http://bridge${command.path}`, { method: command.method, body: JSON.stringify(command.body) }));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "Use agent-ask to reach this chat on its box" });
  expect(sends).toBe(0);
  expect(moni.store.pendingOutbox()).toEqual([]);
  expect(s.store.db.query<{ n: number }, []>("SELECT count(*) n FROM remote_inbox").get()!.n).toBe(0);
  const relay = parseCommand(["agent-ask", "--to", "moni", "--text=Send the fake delivery card once", "--session", session,
    "--key", "delivery-card:order-amazon-fake"]);
  const ask = () => api(new Request(`http://bridge${relay.path}`, { method: relay.method, body: JSON.stringify(relay.body) }));
  const accepted = await ask();
  expect(accepted.status).toBe(202);
  const ack = await accepted.json() as { id: string; created: boolean };
  expect(ack).toEqual({ id: expect.stringMatching(/^areq_[a-f0-9]{64}$/), created: true });
  expect(await (await ask()).json()).toEqual({ id: ack.id, created: false });
  expect(s.store.db.query<{ n: number }, []>("SELECT count(*) n FROM remote_inbox").get()!.n).toBe(1);
  expect(sends).toBe(0);
  expect(moni.store.pendingOutbox()).toEqual([]);
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
  registry.wake(moni, "watcher work", "watcher-key");
  expect(s.store.db.query<{ kind: string }, []>("SELECT kind FROM remote_inbox ORDER BY seq").all()).toEqual([{ kind: "wake" }, { kind: "wake" }]);
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
