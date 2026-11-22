import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteBox, remoteBoxConfig, type RemoteBoxConfig } from "../src/remote-box.ts";
import { opaqueId } from "../src/remote-protocol.ts";
import { Store } from "../src/store.ts";
import { BoxRunner, type Harness } from "../../moni-box-runner/src/runner.ts";
import { claudeHarness } from "../../moni-box-runner/src/claude.ts";
import { AgentBus, agentWakeId } from "../src/agent-bus.ts";
import { ChatRegistry, createAgentBus, createSbApi } from "../src/runtime.ts";
import { chatKey, LineError, type Line } from "../src/line.ts";
import { parseCommand } from "../src/cli.ts";
import { captureLogs } from "./log-fixture.ts";
import { fenceOwnerAlert, notificationAccepted } from "../src/telegram-fallback.ts";
import { createApi as createTelegramApi } from "../../telegram-bridge/src/api.ts";
import { Store as TelegramStore } from "../../telegram-bridge/src/store.ts";
import { createToolLog, toolLog } from "../src/toollog.ts";
import { summarizeLog } from "../src/log-rollup.ts";
import { ChatMirror, type MirrorSink, type MirrorItem } from "../src/mirror.ts";
const roots: string[] = [], closes: (() => void)[] = [];
afterEach(() => { closes.splice(0).forEach(f => f()); roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
function setup(mirrorSink?: MirrorSink, harness?: (root: string) => Harness) {
  const root = mkdtempSync(join(tmpdir(), "remote-box-test-")); roots.push(root);
  const mac = join(root, "mac"), box = join(root, "box"); mkdirSync(mac); mkdirSync(box);
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const token = "a".repeat(40), callbackToken = "b".repeat(40);
  for (const [name, value] of Object.entries({ token, callbackToken, publicKey: keys.publicKey })) writeFileSync(join(mac, name), value);
  const config: RemoteBoxConfig = { kind: "remote-box", url: "http://127.0.0.1:12345", tokenFile: join(mac, "token"), callbackTokenFile: join(mac, "callbackToken"), publicKeyFile: join(mac, "publicKey"), callbackPort: 12346, epoch: "test", boxId: "bx_test" };
  const logs: string[] = [], notices: string[] = [], texts: string[] = [];
  const alerts: { text: string; key: string }[] = [], requests: { path: string; body: Record<string, unknown> }[] = [];
  let eventsFail = false, routerReady = true, callbackReady = true;
  let requestHook: ((path: string) => Promise<Response | void>) | undefined;
  let now = 1000, online = true, dropAck = false, active = true;
  let afterStatus: (()=>Promise<void>) | undefined;
  const store = new Store(join(mac, "state.sqlite")); closes.push(() => store.close());
  const runner = new BoxRunner({ root: box, boxId: config.boxId, epoch: config.epoch, token, callbackToken, privateKey: keys.privateKey, callbackUrl: "http://127.0.0.1:12346", system: "system" }, harness?.(box) ?? { run: async ({ text }) => { texts.push(text); return "NO_REPLY"; } }, { now: () => now, modelReady: async () => routerReady, callbackReady: async () => callbackReady, fetch: (async () => Response.json({ epoch: "test", accepted: true })) });
  closes.push(() => runner.db.close());
  const io = { now: () => now, active: () => active,
    mirror: mirrorSink ? new ChatMirror(store, mirrorSink, { now: () => now, timeoutMs: 20 }) : undefined,
    ownerAlert: async (_severity: "attention", text: string, key: string): Promise<boolean> => { alerts.push({ text, key }); return true; },
    log: (name: string, code?: string) => logs.push(`${name} ${code ?? ""}`), notice: async (id: string) => { notices.push(id); },
    fetch: (async (url, init) => { if (!online) throw new Error("private error should never be logged");
      const path = new URL(String(url)).pathname; requests.push({ path, body: JSON.parse(String(init?.body)) });
      const hooked = await requestHook?.(path); if (hooked) return hooked;
      if (path === "/events" && eventsFail) return Response.json({ error: "PRIVATE_EVENTS_ERROR" }, { status: 503 });
      const response = await runner.handle(new Request(String(url), init));
      if (String(url).endsWith("/delivery-status") && afterStatus) { const hook=afterStatus; afterStatus=undefined; await hook(); }
      if (String(url).endsWith("/deliver") && dropAck) { dropAck = false; throw new Error("lost ack"); } return response; }),
  } satisfies ConstructorParameters<typeof RemoteBox>[2];
  let remote = new RemoteBox(config, store, io);
  closes.push(() => remote.stop());
  const line: Line = { number: "+15550000000", events: async function* () {}, backfill: async () => [], outbound: async () => [],
    sendText: async () => ({ handle: "sent" }), upload: async () => "https://media.example/file", getMessage: async () => undefined,
    sendApp: async () => ({ handle: "sent" }), react: async () => {}, typing: async () => {}, read: async () => {},
    requestLocation: async () => {}, location: async () => undefined, setOptOut: async () => {}, download: async () => ({ data: new Uint8Array(), name: "", mimeType: "" }) };
  return { root, mac, box, get remote() { return remote; }, mirror: io.mirror, runner, store, config, logs, notices, texts, alerts, requests, line,
    failEvents: () => { eventsFail = true; },
    failReadyLog: () => { const log = io.log; io.log = (name, code) => { if (name === "moni-callback-ready") throw new Error("PRIVATE_LOG_FAILURE"); return log(name, code); }; },
    readiness: (router: boolean, callback: boolean) => { routerReady = router; callbackReady = callback; },
    ownerAlert: (alert: typeof io.ownerAlert) => { io.ownerAlert = alert; },
    requestHook: (hook: typeof requestHook) => { requestHook = hook; },
    restart: () => { remote.stop(); const reopened = new Store(join(mac, "state.sqlite")); closes.push(() => reopened.close()); remote = new RemoteBox(config, reopened, io); },
    failNotice: () => { io.notice = async id => { notices.push(id); throw new Error("ambiguous notice"); }; },
    advance: (ms = 65_000) => { now += ms; }, offline: () => { online = false; }, online: () => { online = true; }, drop: () => { dropAck = true; }, rollback: () => { active = false; },
    afterStatus: (hook: ()=>Promise<void>) => {afterStatus=hook;},
    request: (path: string, body: unknown = {}, auth = callbackToken) => new Request(`http://bridge${path}`, { method: "POST", headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify({ epoch: "test", ...body as object }) }),
  };
}
function files(root: string): string { return readdirSync(root, { withFileTypes: true }).map(e => e.isDirectory() ? files(join(root, e.name)) : readFileSync(join(root, e.name)).toString()).join(""); }

test("a single failed lease logs its cause and the recovery gap separately from the clear window, even at the cap", async () => {
  const s = setup();
  s.config.epoch = "PRIVATE_EPOCH_CANARY";
  s.remote.accept("PRIVATE_HANDLE", { text: "PRIVATE_MESSAGE_TEXT" });
  const sealed = s.store.db.query<{ sealed: string }, []>("SELECT sealed FROM remote_inbox").get()!.sealed;
  let fail = true;
  s.requestHook(async path => {
    if (path === "/lease") {
      if (fail) { fail = false; s.advance(37); return Response.json({ error: "PRIVATE_ERROR_BODY" }, { status: 502 }); }
      return Response.json({ boxId: s.config.boxId, epoch: s.config.epoch });
    }
    if (path === "/deliver") return Response.json({ id: s.requests.at(-1)!.body.id, accepted: true });
    return Response.json({ events: [] });
  });
  const rows = await captureLogs(async () => {
    await s.remote.tick();
    expect(s.store.get("remoteOutage")).toMatchObject({ downAt: 1037, failedProbes: 1, reachableSince: null });
    s.advance(1999); await s.remote.tick(); expect(s.requests).toHaveLength(1);
    s.advance(1); await s.remote.tick();
    expect(s.store.get("remoteOutage")).toMatchObject({ reachableSince: 3037 });
    s.advance(295_000); await s.remote.tick();
    s.advance(4999); await s.remote.tick();
    expect(s.store.get("remoteOutage")).not.toBeNull();
    s.advance(1); await s.remote.tick(); expect(s.store.get("remoteOutage")).toBeNull();
  });
  const detail = { step: "lease", status: 502, errorClass: "RemoteRequestError", latencyMs: 37 };
  const down = rows.filter(row => row.name === "moni-box-down"), errors = rows.filter(row => row.name === "moni-runner-error");
  const up = rows.filter(row => row.name === "moni-box-up");
  expect(down).toHaveLength(1); expect(down[0]!.kind).toBe("error"); expect(down[0]!.props).toEqual(detail);
  expect(errors).toHaveLength(1); expect(errors[0]!.props).toEqual({ code: "unreachable", ...detail, failures: 1 });
  expect(up).toHaveLength(1); expect(up[0]!.props).toEqual({ unreachableMs: 2000, failedProbes: 1, clearMs: 300_000 });
  expect(s.notices).toHaveLength(0);
  const root = join(s.root, "capped-probe"), log = createToolLog({ root, now: () => 0, capBytes: 1 });
  log.write({ component: "fixture", kind: "event", name: "fill" });
  for (const row of [...down, ...errors, ...up]) log.write(row);
  const raw = readFileSync(join(root, "1970-01-01.ndjson"), "utf8");
  const capped = raw.trim().split("\n").map(line => JSON.parse(line));
  expect(capped.some(row => row.name === "log.degraded")).toBe(true);
  for (const row of [...down, ...errors, ...up]) expect(capped.find(saved => saved.name === row.name)?.props).toEqual(row.props);
  const serialized = JSON.stringify([rows, s.logs, raw]);
  for (const secret of ["PRIVATE_", s.config.url, "http://", "https://", "a".repeat(40), "b".repeat(40), sealed, "ciphertext", "encryptedKey", "authorization"]) {
    expect(serialized).not.toContain(secret);
  }
});

test.each([
  { step: "identity", status: undefined, errorClass: "Error" },
  { step: "deliver", status: 503, errorClass: "RemoteRequestError" },
  { step: "ack", status: undefined, errorClass: "Error" },
])("probe failure at $step retains only the failing request's latency and safe metadata", async ({ step, status, errorClass }) => {
  const s = setup(); s.remote.accept("pending", { text: "PRIVATE_BODY" });
  s.requestHook(async path => {
    if (path === "/lease") {
      s.advance(11);
      if (step === "identity") return Response.json({ boxId: "PRIVATE_WRONG_BOX", epoch: "PRIVATE_WRONG_EPOCH" });
    }
    if (path === "/deliver") {
      s.advance(23);
      return step === "deliver" ? Response.json({ error: "PRIVATE_BODY" }, { status: status! }) : Response.json({ id: "PRIVATE_ACK", accepted: false });
    }
  });
  const rows = await captureLogs(() => s.remote.tick());
  const detail = { step, ...(status === undefined ? {} : { status }), errorClass, latencyMs: step === "identity" ? 11 : 23 };
  expect(rows.find(row => row.name === "moni-box-down")?.props).toEqual(detail);
  expect(rows.find(row => row.name === "moni-runner-error")?.props).toEqual({ code: "unreachable", ...detail, failures: 1 });
  expect(JSON.stringify([rows, s.logs])).not.toContain("PRIVATE_");
});

test.each(["AbortError", "TimeoutError"])("probe %s is logged as Timeout without the exception message", async name => {
  const s = setup();
  s.requestHook(async () => { s.advance(12_000); throw new DOMException("PRIVATE_TIMEOUT_URL_TOKEN", name); });
  const rows = await captureLogs(() => s.remote.tick());
  expect(rows.find(row => row.name === "moni-box-down")?.props).toEqual({ step: "lease", errorClass: "Timeout", latencyMs: 12_000 });
  expect(rows.find(row => row.name === "moni-runner-error")?.props).toEqual({ code: "unreachable", step: "lease", errorClass: "Timeout", latencyMs: 12_000, failures: 1 });
  expect(JSON.stringify([rows, s.logs])).not.toContain("PRIVATE_");
});

test.each(["lease", "deliver"])("three failed %s probes retain their count and the existing backoff through recovery", async step => {
  const s = setup(); s.config.outageClearMs = 10_000;
  s.remote.accept("pending", {});
  let fail = true;
  s.requestHook(async path => { if (fail && path === `/${step}`) return Response.json({}, { status: 502 }); });
  const rows = await captureLogs(async () => {
    await s.remote.tick();
    s.advance(2000); await s.remote.tick();
    // Successful leases keep resetting the existing backoff for delivery errors.
    s.advance(step === "lease" ? 4000 : 2000); await s.remote.tick();
    expect(s.store.get("remoteOutage")).toMatchObject({ failedProbes: 3 });
    fail = false; s.advance(step === "lease" ? 8000 : 2000); await s.remote.tick();
    s.advance(10_000); await s.remote.tick();
  });
  expect(rows.filter(row => row.name === "moni-box-down")).toHaveLength(1);
  expect(rows.filter(row => row.name === "moni-runner-error").map(row => row.props?.failures)).toEqual(step === "lease" ? [1, 2, 3] : [1, 1, 1]);
  expect(rows.filter(row => row.name === "moni-box-up").map(row => row.props)).toEqual([
    { unreachableMs: step === "lease" ? 14_000 : 6000, failedProbes: 3, clearMs: 10_000 },
  ]);
});

test("a failure during the clear window preserves one outage and restarts continuous recovery", async () => {
  const s = setup(); s.config.outageClearMs = 10_000;
  const rows = await captureLogs(async () => {
    s.offline(); await s.remote.tick(); s.online(); s.advance(2000); await s.remote.tick();
    s.offline(); s.advance(5000); await s.remote.tick();
    s.online(); s.advance(2000); await s.remote.tick();
    s.advance(5000); await s.remote.tick(); expect(s.store.get("remoteOutage")).not.toBeNull();
    s.advance(5000); await s.remote.tick();
  });
  expect(rows.filter(row => row.name === "moni-box-down")).toHaveLength(1);
  expect(rows.filter(row => row.name === "moni-box-up").map(row => row.props)).toEqual([{ unreachableMs: 9000, failedProbes: 2, clearMs: 10_000 }]);
});

test.each([false, true])("an old stored outage recovers without inventing a start time (fails again=$failsAgain)", async failsAgain => {
  const s = setup();
  s.store.set("remoteOutage", { id: "old-outage", unreachableSince: 1, reachableSince: null, noticeAttempted: true });
  s.restart();
  const rows = await captureLogs(async () => {
    if (failsAgain) { s.offline(); await s.remote.tick(); s.online(); s.advance(2000); }
    await s.remote.tick(); s.advance(300_000); await s.remote.tick();
  });
  expect(s.store.get("remoteOutage")).toBeNull();
  expect(rows.filter(row => row.name === "moni-box-down")).toHaveLength(0);
  expect(rows.find(row => row.name === "moni-box-up")?.props).toEqual({ clearMs: 300_000, ...(failsAgain ? { failedProbes: 1 } : {}) });
});

test.each(["ready", "invalid", "paused"])("a timing log failure preserves the %s readiness response", async state => {
  const s = setup(); s.failReadyLog();
  if (state === "paused") s.rollback();
  const rows = await captureLogs(async () => {
    const response = await s.remote.callback(s.request("/ready", state === "invalid" ? { epoch: "PRIVATE_EPOCH" } : {}),
      { line: s.line, chat: chatKey.dm("+15555550199"), bus: async () => { throw new Error("not called"); } });
    expect(response.status).toBe(state === "ready" ? 200 : state === "invalid" ? 403 : 503);
    expect(await response.json()).toEqual(state === "ready" ? { epoch: "test" } : { error: state === "invalid" ? "Forbidden" : "Backend paused" });
  });
  expect(JSON.stringify([rows, s.logs])).not.toContain("PRIVATE_");
});

test("authenticated readiness logs handler and event-loop timing without callback payloads", async () => {
  const s = setup();
  const rows = await captureLogs(async () => {
    for (const [body, expected] of [[{ marker: "PRIVATE_TEXT" }, 200], [{ epoch: "PRIVATE_EPOCH" }, 403]] as const) {
      const response = await s.remote.callback(s.request("/ready", body), { line: s.line, chat: chatKey.dm("+15555550199"), bus: async () => { throw new Error("not called"); } });
      expect(response.status).toBe(expected);
    }
    const denied = await s.remote.callback(s.request("/ready", {}, "PRIVATE_TOKEN"), { line: s.line, chat: chatKey.dm("+15555550199"), bus: async () => { throw new Error("not called"); } });
    expect(denied.status).toBe(403);
  });
  const timings = rows.filter(row => row.name === "moni-callback-ready");
  expect(timings).toHaveLength(2);
  expect(timings.map(row => row.props?.status)).toEqual([200, 403]);
  for (const row of timings) {
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    expect(row.props?.handlerMs).toBe(row.durationMs!);
    expect(row.props?.loopDelayMs).toBeGreaterThanOrEqual(0);
  }
  expect(s.texts).toHaveLength(0);
  const logged = JSON.stringify([rows, s.logs]);
  for (const value of ["PRIVATE_", "a".repeat(40), "b".repeat(40), "authorization"]) expect(logged).not.toContain(value);
});

test("delivered human backlog behind a fence gets one notice and one refreshed owner alert across flaps and restart", async () => {
  const s = setup(), head = opaqueId("held-message");
  s.runner.enqueue(head, { kind: "inbound", text: "PRIVATE_HEAD" });
  s.runner.db.query("UPDATE inbox SET state='interrupted',interrupted_at=1000 WHERE id=?").run(head);
  await s.remote.tick(); expect(s.alerts).toHaveLength(1);
  s.remote.accept("waiting-dm", { text: "PRIVATE_WAITING" });
  for (let n = 0; n < 10; n++) {
    s.advance(30_000); if (n % 2) s.offline(); else s.online();
    await s.remote.tick(); if (n === 4) s.restart();
  }
  expect(s.store.db.query<{ sealed: string | null; delivered_at: number }, [string]>("SELECT sealed,delivered_at FROM remote_inbox WHERE id=?").get(opaqueId("waiting-dm")))
    .toMatchObject({ sealed: null, delivered_at: 31_000 });
  expect(s.notices).toHaveLength(1);
  expect(s.alerts).toHaveLength(2);
  expect(s.alerts[1]!.key).toBe(`moni-box-fenced:${head.slice(0, 12)}:inbound:${opaqueId("waiting-dm")}`);
  expect(JSON.stringify(s.alerts)).not.toContain("PRIVATE_");
  s.online(); s.advance(65_000); await s.remote.tick();
  s.remote.accept("second-waiting-dm", { text: "PRIVATE_SECOND" });
  s.advance(65_000); await s.remote.tick(); expect(s.alerts).toHaveLength(2); expect(s.notices).toHaveLength(1);
});

test("box terminal acknowledgements retire delivered backlog without marking a NO_REPLY turn answered", async () => {
  const s = setup(); s.remote.accept("terminal", { text: "PRIVATE_TERMINAL" });
  await s.remote.tick(); await s.runner.tick();
  s.advance(5_000); await s.remote.tick();
  expect(s.store.db.query<{ finished_at: number }, []>("SELECT finished_at FROM remote_inbox").get()!.finished_at).toBe(6_000);
  expect(s.store.db.query<{ answered_at: null }, []>("SELECT answered_at FROM remote_unanswered").get()!.answered_at).toBeNull();
  s.offline(); s.advance(600_000); await s.remote.tick(); expect(s.notices).toHaveLength(0);
  await s.remote.checkUnanswered(); expect(s.alerts).toHaveLength(1);
  expect(s.alerts[0]!.key).toBe(`imessage-unanswered:${opaqueId("terminal")}`);
});

test("wake-only fences never qualify for a waiting notice", async () => {
  const s = setup(), head = opaqueId("only-wake");
  s.runner.enqueue(head, { kind: "wake", text: "PRIVATE_WAKE" });
  s.runner.db.query("UPDATE inbox SET state='interrupted',interrupted_at=1000 WHERE id=?").run(head);
  for (let n = 0; n < 8; n++) { s.advance(65_000); await s.remote.tick(); }
  expect(s.notices).toHaveLength(0);
});

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
  expect(s.notices).toHaveLength(!failed && behind === "inbound" ? 1 : 0);
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
  expect(logs.filter(l => l.name === "inbound.overdue_notice")).toHaveLength(2);
  expect(logs.find(l => l.name === "inbound.overdue_notice")?.props?.backend).toBe("remote-box");
  expect(logs.some(l => l.name === "inbound.unanswered" || l.error?.tag === "inbound.unanswered")).toBe(false);
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
    expect(s.alerts).toHaveLength(2);
    expect(s.alerts[1]!.key).toBe(`moni-box-fenced:${id.slice(0, 12)}:inbound:${opaqueId("behind")}`);
    await s.remote.resolve(id, "done"); s.advance(5_000); await s.remote.tick(); s.advance(5_000); await s.remote.tick();
    expect(s.logs.filter(l => l.startsWith("moni-box-unfenced "))).toHaveLength(1);
    // Re-fencing the same id after explicit pending resolution must not re-alert.
    s.runner.db.query("UPDATE inbox SET state='interrupted' WHERE id=?").run(id);
    s.advance(5_000); await s.remote.tick(); expect(s.alerts).toHaveLength(2);
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
  expect(s.alerts.filter(a => a.key === original.key)).toEqual([original, original, original]);
  expect(s.alerts.filter(a => a.key === `moni-box-fenced:${id.slice(0, 12)}:inbound:${opaqueId("behind")}`)).toHaveLength(1);
  expect(s.alerts).toHaveLength(4); expect(s.notices).toHaveLength(1); expect(s.texts).toHaveLength(0);
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
    expect(s.requests.filter(r => r.path === "/events" && r.body.headOnly === true)).toHaveLength(i + 2);
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
    const actionId = opaqueId("cli-backing-off");
    s.runner.db.query("INSERT INTO actions(id,path,payload,state,inbox_id,attempts,last_status,next_at) VALUES (?,'/react',?,'pending',?,2,502,99999)")
      .run(actionId, JSON.stringify({ target: "PRIVATE_ACTION_TARGET", text: "PRIVATE_ACTION_TEXT", token: "PRIVATE_ACTION_TOKEN" }), id);
    s.runner.db.query("INSERT INTO actions(id,path,payload,state) VALUES (?,'/metrics','{}','pending')").run(opaqueId("hidden-metric"));
    const actionsPage = await cli("remote-events", "--chat", "moni", "--session", "owner-thread");
    expect(actionsPage.code).toBe(0);
    expect(JSON.parse(actionsPage.stdout).actions).toEqual([{ id: actionId.slice(0, 12), path: "/react", attempts: 2, lastStatus: 502, nextAt: 99999, inboxId: id.slice(0, 12) }]);
    expect(actionsPage.stdout).not.toContain("PRIVATE_"); expect(actionsPage.stdout).not.toContain("payload");
  } finally { await server.stop(true); }
});

test.each([
  { retryable: false, uncertain: false, status: 422 }, { retryable: true, uncertain: false, status: 502 },
  { retryable: false, uncertain: true, status: 502 }, { retryable: true, uncertain: true, status: 502 },
])("reaction LineError classification retryable=$retryable uncertain=$uncertain is private and cap-safe", async ({ retryable, uncertain, status }) => {
  const s = setup(), target = "PRIVATE_REACTION_TARGET";
  s.remote.accept(target, { text: "PRIVATE_MESSAGE_TEXT" });
  const io = { line: { ...s.line, react: async () => { throw new LineError("PRIVATE_ERROR_BODY", "http_400:invalid_number", retryable, uncertain); } },
    chat: chatKey.dm("+15555550199"), bus: async () => Response.json({}) };
  const lines = await captureLogs(async () => {
    expect((await s.remote.callback(s.request("/react", { target, kind: "like" }), io)).status).toBe(status);
    s.advance(60_000); await s.remote.tick();
  });
  const failure = lines.find(l => l.name === "moni-runner-error")!;
  expect(failure.kind).toBe("error");
  expect(failure.props).toEqual({ path: "/react", status, errorClass: "LineError", code: "http_400:invalid_number", retryable, count: 0 });
  expect(JSON.stringify(lines)).not.toContain("PRIVATE_"); expect(s.logs.join("\n")).not.toContain("PRIVATE_");
  const root = join(s.root, "capped"), log = createToolLog({ root, now: () => 0, capBytes: 1 });
  log.write({ component: "fixture", kind: "event", name: "fill" }); log.write(failure);
  const raw = readFileSync(join(root, "1970-01-01.ndjson"), "utf8");
  expect(raw).toContain('"name":"moni-runner-error"'); expect(raw).toContain('"path":"/react"'); expect(raw).not.toContain("PRIVATE_");
});

test("100 callback failures aggregate to one summary with 99 suppressed repeats and flush without another failure", async () => {
  const s = setup(), target = "PRIVATE_TARGET"; s.remote.accept(target, {});
  const io = { line: { ...s.line, react: async () => { throw new LineError("PRIVATE_ERROR", "network", true, false); } },
    chat: chatKey.dm("+15555550199"), bus: async () => Response.json({}) };
  const lines = await captureLogs(async () => {
    for (let n = 0; n < 100; n++) {
      expect((await s.remote.callback(s.request("/react", { target, kind: "like" }), io)).status).toBe(502);
      s.advance(599);
    }
    expect(s.logs.filter(l => l.startsWith("moni-runner-error"))).toHaveLength(0);
    s.advance(100); await s.remote.tick();
    expect(s.logs.filter(l => l.startsWith("moni-runner-error"))).toHaveLength(1);
    await s.remote.callback(s.request("/react", { target, kind: "like" }), io);
    s.advance(60_000); await s.remote.tick();
  });
  expect(lines.filter(l => l.name === "moni-runner-error").map(l => l.props?.count)).toEqual([99, 0]);
  expect(JSON.stringify(lines)).not.toContain("PRIVATE_");
});

test("callback aggregation separates route and status, sanitizes unknown code/name, and catches async bus failures", async () => {
  const s = setup(); s.remote.accept("PRIVATE_TARGET", {});
  let error: unknown = new LineError("PRIVATE_ERROR", "PRIVATE_CODE", false, false);
  const io = { line: { ...s.line, react: async () => { throw error; } }, chat: chatKey.dm("+15555550199"), bus: async (): Promise<Response> => { throw error; } };
  const lines = await captureLogs(async () => {
    await s.remote.callback(s.request("/react", { target: "PRIVATE_TARGET", kind: "like" }), io);
    error = Object.assign(new Error("PRIVATE_BODY"), { name: "PRIVATE_NAME" });
    await s.remote.callback(s.request("/react", { target: "PRIVATE_TARGET", kind: "like" }), io);
    expect((await s.remote.callback(s.request("/agent-ask", { operationId: opaqueId("bus") }), io)).status).toBe(502);
    s.advance(60_000); await s.remote.tick();
  });
  const failures = lines.filter(l => l.name === "moni-runner-error"); expect(failures).toHaveLength(3);
  expect(failures.map(l => [l.props?.path, l.props?.status, l.props?.errorClass, l.props?.code])).toEqual([
    ["/react", 422, "LineError", "lineFailure"], ["/react", 502, "Error", undefined], ["/agent-ask", 502, "Error", undefined],
  ]);
  expect(JSON.stringify(lines)).not.toContain("PRIVATE_"); expect(s.logs.join("\n")).not.toContain("PRIVATE_");
});

test("stop flushes an open aggregation window once before 60 seconds and deletes its key", async () => {
  const s = setup(); s.remote.accept("PRIVATE_TARGET", {});
  const io = { line: { ...s.line, react: async () => { throw new LineError("PRIVATE_ERROR", "network", true, false); } },
    chat: chatKey.dm("+15555550199"), bus: async () => Response.json({}) };
  const lines = await captureLogs(async () => {
    for (let n = 0; n < 100; n++) await s.remote.callback(s.request("/react", { target: "PRIVATE_TARGET", kind: "like" }), io);
    expect(s.logs.filter(l => l.startsWith("moni-runner-error"))).toHaveLength(0);
    s.remote.stop(); s.remote.stop();
    s.advance(60_000); await s.remote.tick(); s.remote.stop();
  });
  expect(lines.filter(l => l.name === "moni-runner-error").map(l => l.props?.count)).toEqual([99]);
  expect(JSON.stringify(lines)).not.toContain("PRIVATE_");
});

test.each([
  { retryable: false, uncertain: false }, { retryable: true, uncertain: false },
  { retryable: false, uncertain: true }, { retryable: true, uncertain: true }, { retryable: null, uncertain: null },
])("uncertain send history failure retryable=$retryable uncertain=$uncertain keeps the runner blocked without resending", async ({ retryable, uncertain }) => {
  const s = setup(); let sends = 0, turns = 0; const paths: string[] = [];
  const id = opaqueId("uncertain-history"), inbox = opaqueId("later-inbox");
  s.store.db.query("INSERT INTO remote_sends VALUES (?,1000,'uncertain',NULL)").run(id);
  const io = { line: { ...s.line, outbound: async (): Promise<never> => {
    throw retryable === null ? new Error("PRIVATE_HISTORY_ERROR") : new LineError("PRIVATE_HISTORY_ERROR", "http_401", retryable, uncertain!);
  }, sendText: async () => { sends++; return { handle: "unexpected" }; } }, chat: chatKey.dm("+15555550199"), bus: async () => Response.json({}) };
  const runner = new BoxRunner({ ...s.runner.config, root: join(s.root, "history-runner") }, { run: async () => { turns++; return "NO_REPLY"; } }, {
    callbackReady: async () => true, fetch: async (url, init) => { paths.push(new URL(String(url)).pathname); return s.remote.callback(new Request(url, init), io); },
  }); closes.push(() => runner.db.close());
  await runner.handle(new Request("http://box/lease", { method: "POST", headers: { authorization: `Bearer ${runner.config.token}` }, body: JSON.stringify({ boxId: runner.config.boxId, epoch: runner.config.epoch }) }));
  runner.db.query("INSERT INTO actions(id,path,payload,state) VALUES (?,'/send',?,'pending')").run(id, JSON.stringify({ text: "PRIVATE_SEND_TEXT" }));
  runner.db.query("INSERT INTO actions(id,path,payload,state) VALUES (?,'/react','{}','pending')").run(opaqueId("later-reaction"));
  runner.enqueue(inbox, {}); await runner.tick(); await runner.tick();
  expect(paths).toEqual(["/send", "/send", "/send", "/send"]);
  expect(sends).toBe(0); expect(turns).toBe(0);
  expect(runner.db.query("SELECT state,attempts FROM actions WHERE id=?").get(id)).toEqual({ state: "pending", attempts: 0 });
  expect(runner.db.query("SELECT state FROM inbox WHERE id=?").get(inbox)).toEqual({ state: "pending" });
  expect(s.store.db.query("SELECT state FROM remote_sends WHERE id=?").get(id)).toEqual({ state: "uncertain" });
});

test("actual remote outage, fence, recovery and diagnostic rows survive the cap while queue depth is dropped", async () => {
  const s = setup(); const id = opaqueId("fenced-cap"); s.runner.enqueue(id, {});
  s.runner.db.query("UPDATE inbox SET state='interrupted',interrupted_at=1000 WHERE id=?").run(id);
  const lines = await captureLogs(async () => {
    await s.remote.tick(); s.offline(); s.advance(5_000); await s.remote.tick();
    s.online(); s.advance(65_000); await s.remote.tick();
    s.runner.db.exec("UPDATE inbox SET state='done'"); s.advance(300_000); await s.remote.tick();
    s.failEvents(); s.advance(5_000); await s.remote.tick();
  });
  const root = join(s.root, "capped-lifecycle"), log = createToolLog({ root, now: () => 0, capBytes: 1 });
  log.write({ component: "fixture", kind: "event", name: "fill" }); for (const line of lines) log.write(line);
  const saved = readFileSync(join(root, "1970-01-01.ndjson"), "utf8").trim().split("\n").map(raw => JSON.parse(raw));
  for (const name of ["moni-box-fenced", "moni-box-down", "moni-runner-error", "moni-box-up", "moni-box-unfenced", "moni-box-backend-state", "moni-box-events-error"]) {
    expect(saved.some(l => l.name === name)).toBe(true);
  }
  expect(saved.some(l => l.name === "moni-queue-depth")).toBe(false);
});

test("pending action metadata is projected explicitly and rejects private or malformed input shapes", async () => {
  const s = setup();
  const action = { id: "a".repeat(12), path: "/react", attempts: 2, lastStatus: 502, nextAt: 9000, inboxId: "b".repeat(12) };
  let rows: unknown = [{ ...action, payload: "PRIVATE_PAYLOAD", target: "PRIVATE_TARGET", token: "PRIVATE_TOKEN" }];
  const remote = new RemoteBox(s.config, s.store, { active: () => true, log: () => {}, notice: async () => {},
    fetch: async () => Response.json({ events: [], actions: rows }) });
  expect(await remote.events()).toEqual({ events: [], actions: [action] });
  for (const patch of [
    { id: "PRIVATE_ID" }, { id: "a".repeat(64) }, { path: "/react?PRIVATE_TARGET" }, { path: "/metrics" },
    { attempts: -1 }, { attempts: 1.5 }, { lastStatus: 99 }, { lastStatus: 600 },
    { nextAt: -1 }, { nextAt: "PRIVATE_NEXT_AT" }, { inboxId: "PRIVATE_ID" }, { inboxId: undefined },
  ]) {
    rows = [{ ...action, ...patch }]; await expect(remote.events()).rejects.toThrow("Invalid box action");
  }
  rows = "PRIVATE_PAYLOAD"; await expect(remote.events()).rejects.toThrow("Invalid box actions");
  rows = [{ ...action, lastStatus: null, nextAt: null, inboxId: null }];
  expect((await remote.events()).actions).toEqual([{ ...action, lastStatus: null, nextAt: null, inboxId: null }]);
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

test("waiting inbound keeps its grace and one notice through ten flaps", async () => {
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
  s.online(); s.advance(); await s.remote.tick(); await s.runner.tick();
  s.advance(5_000); await s.remote.tick(); s.advance(300_000); await s.remote.tick();
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
  "restart after $stoppedMs ms preserves message age with waiting=$waiting", async ({ stoppedMs, waiting }) => {
    const s = setup();
    if (waiting) s.remote.accept("waiting", { text: "private" });
    s.offline(); await s.remote.tick();
    const id = s.store.get<{ id: string }>("remoteOutage")!.id;
    s.advance(stoppedMs); s.restart(); await s.remote.tick();
    expect(s.notices).toHaveLength(waiting && stoppedMs >= 120_000 ? 1 : 0);
    expect(s.store.get<{ id: string }>("remoteOutage")!.id).toBe(id);
    if (!waiting) expect(s.logs).toContain("moni-notice-suppressed not-waiting");
    else if (stoppedMs < 120_000) expect(s.logs).toContain("moni-notice-suppressed grace");
    s.advance(119_999); await s.remote.tick(); expect(s.notices).toHaveLength(waiting ? 1 : 0);
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
  s.online(); s.advance(); await s.remote.tick(); await s.runner.tick();
  s.advance(5_000); await s.remote.tick(); s.advance(300_000); await s.remote.tick();
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
  s.remote.accept("new-inbound", { text: "private" }); s.advance(130_000); await s.remote.tick();
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

test.each(["before", "after"])("delivery card bus retry recovers a failure %s the durable wake without duplicating it", async failure => {
  const s = setup(), ownerStore = new Store(join(s.mac, "delivery-retry-owner.sqlite")); closes.push(() => ownerStore.close());
  let sends = 0;
  s.line.sendText = async () => { sends++; throw new Error("No real sends allowed"); };
  const registry = new ChatRegistry({ owner: "+15555550123", ownerStore, stateRoot: s.mac, line: s.line,
    access: () => ({ people: [{ name: "Moni", role: "admin", addresses: ["+15555550199"] }], groups: [] }),
    build: chat => { if (chat.info.slug === "moni") chat.remote = s.remote; return { api: async () => Response.json({}) }; } });
  registry.restore(); const moni = registry.open(chatKey.dm("+15555550199")); closes.push(() => moni.store.close());
  const session = "ardud-control:thread:fake-owner";
  ownerStore.set("route", { id: session, generation: 1 });
  const api = createSbApi({ registry, line: s.line, accessPath: join(s.mac, "access.json"), enabled: () => true, health: () => ({}) });
  const command = parseCommand(["agent-ask", "--to", "moni", "--text=Send the fake delivery card once", "--session", session,
    "--key", "delivery-card:order-amazon-failed-wake"]);
  const ask = () => api(new Request(`http://bridge${command.path}`, { method: command.method, body: JSON.stringify(command.body) }));
  const accept = s.remote.accept.bind(s.remote);
  let fail = true;
  s.remote.accept = (...args) => {
    if (fail && failure === "before") throw new Error("fixture wake unavailable");
    const created = accept(...args);
    if (fail) throw new Error("fixture acknowledgement lost");
    return created;
  };
  expect((await ask()).status).toBe(failure === "before" ? 503 : 202);
  expect(ownerStore.db.query<{ status: string }, []>("SELECT status FROM agent_requests").all()).toEqual([{ status: "undelivered" }]);
  expect(s.store.db.query<{ n: number }, []>("SELECT count(*) n FROM remote_inbox").get()!.n).toBe(failure === "before" ? 0 : 1);
  fail = false;
  const recovered = await ask();
  expect(recovered.status).toBe(200);
  const ack = await recovered.json() as { id: string; created: boolean };
  expect(ack).toEqual({ id: expect.stringMatching(/^areq_[a-f0-9]{64}$/), created: false });
  expect(await (await ask()).json()).toEqual(ack);
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

test("delivered status lookup rotates bounded pages and retires only reported terminal or replied ids", async () => {
  const s = setup(), ids = Array.from({ length: 205 }, (_, n) => opaqueId(`status:${n}`));
  for (const [n, id] of ids.entries()) {
    s.remote.accept(`status:${n}`, { text: "PRIVATE_STATUS" });
    s.runner.enqueue(id, { kind: "inbound", text: "PRIVATE_STATUS" });
  }
  s.store.db.exec("UPDATE remote_inbox SET sealed=NULL,delivered_at=1000");
  s.runner.db.query("UPDATE inbox SET state='done' WHERE id=?").run(ids[204]!);
  s.runner.db.query("INSERT INTO actions(id,path,payload,state,inbox_id) VALUES (?,'/send','{}','done',?)").run(opaqueId("committed"), ids[150]!);
  // A missing row is not proof of completion, including on a replaced runner.
  s.runner.db.query("DELETE FROM inbox WHERE id=?").run(ids[10]!);
  for (let n = 0; n < 4; n++) { await s.remote.tick(); s.advance(5_000); }
  const pages = s.requests.filter(r => r.path === "/events" && r.body.ids).map(r => r.body.ids as string[]);
  expect(pages.map(p => p.length)).toEqual([100, 100, 5, 100]);
  const finished = s.store.db.query<{ id: string }, []>("SELECT id FROM remote_inbox WHERE finished_at IS NOT NULL ORDER BY seq").all();
  expect(finished.map(r => r.id)).toEqual([ids[150]!, ids[204]!]);
  expect(JSON.stringify(pages)).not.toContain("PRIVATE_STATUS");
});

test("a refreshed fence alert retries its frozen first-DM identity after lost acknowledgement and restart", async () => {
  const s = setup(), head = opaqueId("refresh-head");
  s.runner.enqueue(head, { kind: "inbound", text: "PRIVATE_REFRESH" });
  s.runner.db.exec("UPDATE inbox SET state='interrupted',interrupted_at=1000");
  await s.remote.tick();
  let accepted = false;
  s.ownerAlert(async (_severity, text, key) => { s.alerts.push({ text, key }); return accepted; });
  s.remote.accept("refresh-first", { text: "PRIVATE_REFRESH" }); s.advance(5_000); await s.remote.tick();
  const refresh = s.alerts[1]!;
  s.remote.accept("refresh-second", { text: "PRIVATE_REFRESH" });
  s.restart(); s.advance(5_000); accepted = true; await s.remote.tick();
  s.restart(); s.advance(5_000); await s.remote.tick();
  expect(s.alerts.slice(1)).toEqual([refresh, refresh]);
  expect(refresh.key).toBe(`moni-box-fenced:${head.slice(0, 12)}:inbound:${opaqueId("refresh-first")}`);
  expect(JSON.stringify(s.alerts)).not.toContain("PRIVATE_REFRESH");
});

test("a committed callback reply retires delivered waiting metadata before the runner completes", async () => {
  const s = setup(); s.remote.accept("reply-before-done", { text: "PRIVATE_REPLY" }); await s.remote.tick();
  await s.remote.callback(s.request("/send", { id: opaqueId("early-send"), inboxId: opaqueId("reply-before-done"), text: "reply" }),
    { line: s.line, chat: chatKey.dm("+15555550199"), bus: async () => Response.json({}) });
  expect(s.store.db.query<{ finished_at: number }, []>("SELECT finished_at FROM remote_inbox").get()!.finished_at).toBe(1000);
  s.offline(); s.advance(600_000); await s.remote.tick(); await s.remote.checkUnanswered();
  expect(s.notices).toHaveLength(0); expect(s.alerts).toHaveLength(0);
});

test("one transport outage cannot send a second notice after its waiting episode clears and six hours pass", async () => {
  const s = setup(); s.remote.accept("first-episode", { text: "private" }); s.offline(); await s.remote.tick();
  s.advance(120_000); await s.remote.tick(); expect(s.notices).toHaveLength(1);
  s.store.db.exec("UPDATE remote_inbox SET finished_at=121000");
  s.advance(65_000); await s.remote.tick();
  s.remote.accept("second-episode", { text: "private" }); s.advance(21_600_000); s.restart(); await s.remote.tick();
  expect(s.notices).toHaveLength(1); expect(s.logs).toContain("moni-notice-suppressed already-sent");
});

test.each(["fence", "router", "callback", "both", "pending", "running"].flatMap(stall =>
  ["sent", "uncertain", "not-attempted"].map(notice => ({ stall, notice }))))(
  "$stall stall with $notice notice preserves the reservation when transport fails", async ({ stall, notice }) => {
    const s = setup(), head = opaqueId("transition-head");
    if (["fence", "pending", "running"].includes(stall)) {
      s.runner.enqueue(head, { kind: "inbound", text: "PRIVATE_TRANSITION_HEAD" });
      s.runner.db.query("UPDATE inbox SET state=?,interrupted_at=1000 WHERE id=?").run(stall === "fence" ? "interrupted" : stall, head);
    } else s.readiness(stall !== "router" && stall !== "both", stall !== "callback" && stall !== "both");
    if (notice === "uncertain") s.failNotice();
    s.remote.accept("transition-first", { text: "PRIVATE_TRANSITION" }); await s.remote.tick();
    s.advance(notice === "not-attempted" ? 60_000 : 120_000); await s.remote.tick();
    expect(s.notices).toHaveLength(notice === "not-attempted" ? 0 : 1);
    expect(s.store.get("remoteOutage")).toBeUndefined();

    s.offline(); s.advance(5_000); await s.remote.tick();
    const outage = s.store.get<{ id: string }>("remoteOutage")!.id;
    s.restart(); s.online(); s.readiness(true, true);
    s.runner.db.query("UPDATE inbox SET state='done' WHERE id=?").run(head);
    s.advance(65_000); await s.remote.tick(); await s.runner.tick();
    s.advance(5_000); await s.remote.tick();
    expect(s.store.get("remoteWaitingNotice")).toBeNull();
    expect(s.store.get<{ id: string }>("remoteOutage")!.id).toBe(outage);

    s.remote.accept("transition-second", { text: "PRIVATE_TRANSITION" });
    s.offline(); s.advance(21_600_000); await s.remote.tick();
    expect(s.store.get<{ id: string }>("remoteOutage")!.id).toBe(outage);
    expect(s.notices).toHaveLength(1);
    s.restart(); s.advance(65_000); await s.remote.tick();
    expect(s.notices).toHaveLength(1);
    expect(JSON.stringify([s.logs, s.alerts])).not.toContain("PRIVATE_TRANSITION");
  });


// Readiness class: either dependency (or both) can block new work, with or without human backlog.
test.each([
  { router: false, callback: true }, { router: true, callback: false }, { router: false, callback: false },
].flatMap(readiness => ["inbound", "wake"].map(kind => ({ ...readiness, kind }))))(
  "readiness router=$router callback=$callback retains authority and notices only waiting $kind", async ({ router, callback, kind }) => {
    const s = setup(); s.readiness(router, callback);
    s.remote.accept("blocked-admission", { text: "PRIVATE_READINESS" }, undefined, kind as "inbound" | "wake");
    await s.remote.tick(); await s.runner.tick(); expect(s.texts).toHaveLength(0);
    s.advance(119_999); await s.remote.tick(); expect(s.notices).toHaveLength(0);
    s.restart(); s.advance(5_000); await s.remote.tick(); await s.runner.tick();
    expect(s.runner.active()).toBe(true); expect(s.texts).toHaveLength(0);
    expect(s.notices).toHaveLength(kind === "inbound" ? 1 : 0);
    s.advance(65_000); await s.remote.tick(); expect(s.notices).toHaveLength(kind === "inbound" ? 1 : 0);
    expect(s.store.get("remoteOutage")).toBeUndefined(); expect(s.store.get("remoteFence")).toBeUndefined();
    s.readiness(true, true); s.advance(5_000); await s.remote.tick(); await s.runner.tick();
    expect(s.texts).toHaveLength(1); expect(s.runner.db.query("SELECT 1 FROM interruptions").get()).toBeNull();
    expect(JSON.stringify([s.logs, s.alerts])).not.toContain("PRIVATE_READINESS");
  });

// Retirement class: committed sends, explicit reactions, and terminal box acknowledgements all end an episode.
test.each(["send", "reaction", "terminal"])("%s retirement clears the last DM's notice reservation before the next arrival", async retirement => {
  const s = setup(), head = opaqueId("episode-head");
  s.runner.enqueue(head, { kind: "inbound", text: "PRIVATE_EPISODE" });
  s.runner.db.exec("UPDATE inbox SET state='interrupted',interrupted_at=1000");
  s.remote.accept("episode-first", { text: "PRIVATE_EPISODE" }); await s.remote.tick();
  s.advance(120_000); await s.remote.tick(); expect(s.notices).toHaveLength(1);
  const io = { line: s.line, chat: chatKey.dm("+15555550199"), bus: async () => Response.json({}) };
  if (retirement === "terminal") {
    s.runner.db.query("UPDATE inbox SET state='done' WHERE id=?").run(opaqueId("episode-first"));
    s.advance(5_000); await s.remote.tick();
  } else {
    const response = await s.remote.callback(s.request(retirement === "send" ? "/send" : "/react", retirement === "send"
      ? { id: opaqueId("episode-reply"), inboxId: opaqueId("episode-first"), text: "reply" } : { target: "episode-first", kind: "like" }), io);
    expect(response.status).toBe(200);
  }
  expect(s.store.get("remoteWaitingNotice")).toBeNull();
  // No empty-queue tick occurs between this retirement and the next DM.
  s.remote.accept("episode-second", { text: "PRIVATE_EPISODE" });
  s.advance(120_000); await s.remote.tick(); expect(s.notices).toHaveLength(1);
  expect(s.logs).toContain("moni-notice-suppressed rate-limited");
  s.restart(); s.advance(21_600_000); await s.remote.tick();
  expect(s.notices).toHaveLength(2); expect(s.notices[0]).not.toBe(s.notices[1]);
});


// Held-queue class: pending and running heads, both machine and human, with either tail kind.
test.each(["pending", "running"].flatMap(state => ["inbound", "wake"].flatMap(headKind =>
  ["inbound", "wake"].map(tailKind => ({ state, headKind, tailKind })))))(
  "$state $headKind head notices held $tailKind once without needing an interrupted fence", async ({ state, headKind, tailKind }) => {
    const s = setup(), head = opaqueId("busy-head");
    s.runner.enqueue(head, { kind: headKind, text: "PRIVATE_BUSY_HEAD" });
    s.runner.db.query("UPDATE inbox SET state=? WHERE id=?").run(state, head);
    s.remote.accept("held-tail", { text: "PRIVATE_HELD_TAIL" }, undefined, tailKind as "inbound" | "wake");
    await s.remote.tick(); s.advance(119_999); await s.remote.tick(); expect(s.notices).toHaveLength(0);
    s.restart(); s.advance(5_000); await s.remote.tick();
    expect(s.notices).toHaveLength(tailKind === "inbound" ? 1 : 0);
    s.advance(65_000); await s.remote.tick(); s.restart(); s.advance(65_000); await s.remote.tick();
    expect(s.notices).toHaveLength(tailKind === "inbound" ? 1 : 0);
    expect(s.runner.active()).toBe(true); expect(s.alerts).toHaveLength(0);
    expect(s.store.get("remoteOutage")).toBeUndefined(); expect(s.store.get("remoteFence")).toBeUndefined();
    expect(s.runner.db.query<{ state: string }, [string]>("SELECT state FROM inbox WHERE id=?").get(head)?.state).toBe(state);
    expect(JSON.stringify([s.logs, s.alerts])).not.toContain("PRIVATE_");
  });

test("mirror hooks copy accepted DMs and successful replies once, excluding wakes and failed sends", async () => {
  const items: MirrorItem[] = [];
  const s = setup({ ensure: async () => ({ threadId: "mirror" }), upload: async () => ({ attachmentId: "a" }),
    append: async (_id, next) => { items.push(...next); } });
  s.remote.accept("dm", { text: "question", sentAt: 1000 });
  s.remote.accept("dm", { text: "question", sentAt: 1000 }); s.remote.accept("wake", { text: "private wake" }, undefined, "wake");
  await s.remote.send("reply", "answer", undefined, s.line, chatKey.dm("moni"));
  await s.remote.send("reply", "answer", undefined, s.line, chatKey.dm("moni"));
  await s.remote.send("notice", "temporarily offline", undefined, s.line, chatKey.dm("moni"));
  const failing = { ...s.line, sendText: async () => { throw new LineError("failed", "http_400", false, false); } };
  await expect(s.remote.send("failed", "never sent", undefined, failing, chatKey.dm("moni"))).rejects.toThrow();
  for (let i = 0; i < 4; i++) await s.mirror!.tick();
  expect(items.map(item => item.id)).toEqual(["dm", "send:reply", "send:notice"]);
  expect(items.map(item => item.role)).toEqual(["user", "assistant", "assistant"]);
});

test("an uncertain send is mirrored only after outbound reconciliation proves success", async () => {
  const items: MirrorItem[] = [];
  const s = setup({ ensure: async () => ({ threadId: "mirror" }), upload: async () => ({ attachmentId: "a" }),
    append: async (_id, next) => { items.push(...next); } });
  const uncertain = { ...s.line, sendText: async () => { throw new LineError("lost ack", "network", true, true); } };
  await expect(s.remote.send("reconcile", "answer", undefined, uncertain, chatKey.dm("moni"))).rejects.toThrow();
  await s.mirror!.tick(); expect(items).toHaveLength(0);
  s.line.outbound = async () => [{ handle: "confirmed", chat: chatKey.dm("moni"), text: "answer", sentAt: 1000, status: "sent" }];
  await s.remote.send("reconcile", "answer", undefined, s.line, chatKey.dm("moni"));
  await s.mirror!.tick(); expect(items.map(item => item.id)).toEqual(["send:reconcile"]);
});

test("a hung mirror never holds Moni's reply or prevents the next successful send", async () => {
  let appends = 0, sends = 0;
  const s = setup({ ensure: async () => ({ threadId: "mirror" }), upload: async () => ({ attachmentId: "a" }),
    append: async () => { appends++; return new Promise<never>(() => {}); } });
  s.line.sendText = async () => ({ handle: `sent-${++sends}` });
  s.remote.accept("dm", { text: "question", sentAt: 1000 }); const running = s.mirror!.tick();
  await s.remote.send("one", "answer", undefined, s.line, chatKey.dm("moni"));
  await s.remote.send("two", "second answer", undefined, s.line, chatKey.dm("moni"));
  expect(sends).toBe(2); expect(appends).toBe(1); await running;
});

test("remote bus confirmation requires ack and reports pickup from the box without text", async () => {
  const s = setup(); const id = "wake:agent-bus:delivery-canary";
  const privateText = randomUUID();
  s.remote.accept(id, { id, text: privateText, agentExpiresAt: 9999999999999 });
  expect(s.remote.delivery(id)).toEqual({ retained: true, confirmed: false });
  s.drop(); await s.remote.tick();
  expect(s.remote.delivery(id)).toEqual({ retained: true, confirmed: false });
  s.advance(); await s.remote.tick();
  expect(s.remote.delivery(id)).toEqual({ retained: true, confirmed: true });
  await s.runner.tick(); s.advance(); await s.remote.tick();
  expect(s.remote.delivery(id).deliveredAt).toBeGreaterThan(0);
  expect(s.texts.join()).toContain(privateText);
  expect(files(s.mac)).not.toContain(privateText);
  expect(s.logs.join()).not.toContain(privateText);
});

test("an acknowledged remote bus request with a failed Claude launch never reports work started", async () => {
  const s = setup(undefined, root => {
    mkdirSync(join(root, "work"));
    const keyFile = join(root, "router-key"); writeFileSync(keyFile, "test-router-key", { mode: 0o600 });
    return claudeHarness(root, join(root, "missing-claude"), "test", { routerKeyFile: keyFile });
  });
  const owner = { slug: "owner", title: "Owner", kind: "owner" as const, key: chatKey.dm("owner") };
  const moni = { slug: "moni", title: "Moni", kind: "dm" as const, key: chatKey.dm("moni") };
  const notices = new Map<string, string>(), logs: string[] = []; let now = 1_000;
  const bus = new AgentBus({ db: s.store.db, policyPath: join(s.mac, "agent-policy.json"), now: () => now,
    forSession: id => id === "owner-session" ? owner : undefined, bySlug: slug => slug === "moni" ? moni : owner, groupMembers: () => [],
    deliver: (target, text, key, _receipt, expiresAt) => {
      const id = agentWakeId(key);
      if (target.slug === "moni") { s.remote.accept(id, { id, text, agentExpiresAt: expiresAt }); return { id, remote: true, ...s.remote.delivery(id) }; }
      notices.set(key, text); return { id, remote: false, confirmed: true };
    },
    delivery: (target, key) => target.slug === "moni" ? { id: agentWakeId(key), remote: true, ...s.remote.delivery(agentWakeId(key)) }
      : { id: agentWakeId(key), remote: false, confirmed: notices.has(key) },
    receipt: () => undefined, log: (event, detail) => logs.push(`${event} ${detail ?? ""}`),
  });
  const ask = bus.ask({ sessionId: "owner-session", to: "moni", text: "PRIVATE_BUS_TEXT", dedupeKey: "launch-failure" });
  expect(ask.status).toBe(202); const id = (ask.body as { id: string }).id;
  expect(s.store.db.query("SELECT status FROM agent_requests WHERE id=?").get(id)).toEqual({ status: "open" });
  expect(logs.filter(line => line.startsWith("agent-deliver-pending "))).toEqual([`agent-deliver-pending ${id} moni remote=1`]);
  await s.remote.tick(); bus.sweep();
  await s.runner.tick(); s.advance(); now += 65_000; await s.remote.tick(); bus.sweep();
  expect(s.remote.delivery(agentWakeId(`agent-ask:${id}`))).toEqual({ retained: true, confirmed: true });
  expect(s.store.db.query("SELECT delivered_at FROM agent_requests WHERE id=?").get(id)).toEqual({ delivered_at: null });
  expect(logs.some(line => line.startsWith("agent-deliver "))).toBe(true);
  expect(logs.some(line => line.startsWith("agent-delivered "))).toBe(false);
  expect(logs.some(line => line.startsWith("agent-deliver-failed "))).toBe(false);
  expect(notices.has(`agent-undelivered:${id}`)).toBe(false);
  expect(notices.has(`agent-progress:${id}`)).toBe(false);
  now = 601_001; bus.sweep();
  expect(notices.get(`agent-timeout:${id}`)).toContain("was not delivered to a target turn");
  expect(notices.get(`agent-timeout:${id}`)).not.toContain("no answer");
  expect(logs.join()).not.toContain("PRIVATE_BUS_TEXT");
});


test("expired acked requests do not starve later pickup receipts", async () => {
  const s = setup();
  for (let i=0; i<50; i++) s.remote.accept(`expired-${i}`, { text: "PRIVATE", agentExpiresAt: 2_000 });
  await s.remote.tick(); s.advance(); await s.remote.tick();
  for (let i=0; i<50; i++) await s.runner.tick();
  const id = "wake:agent-bus:after-expired";
  s.remote.accept(id, { text: "next", agentExpiresAt: 9999999999999 });
  s.advance(); await s.remote.tick(); await s.runner.tick(); s.advance(); await s.remote.tick();
  expect(s.remote.delivery(id).deliveredAt).toBeGreaterThan(0); expect(s.texts).toEqual(["next"]);
});

test("lost ack pickup is reconciled after expiry without resending", async () => {
  const s = setup(), id = "wake:agent-bus:lost-ack";
  s.remote.accept(id, { text: "PRIVATE", agentExpiresAt: 20_000 });
  s.drop(); await s.remote.tick(); await s.runner.tick(); expect(s.remote.delivery(id).confirmed).toBe(false);
  s.advance(); await s.remote.tick();
  expect(s.remote.delivery(id)).toMatchObject({ confirmed: true, deliveredAt: 1_000 }); expect(s.texts).toEqual(["PRIVATE"]);
});


test("a pre-expiry receipt snapshot arriving after expiry stays eligible for reconciliation", async () => {
  const s=setup(),id="wake:agent-bus:receipt-race";
  s.remote.accept(id,{text:"PRIVATE",agentExpiresAt:20_000});
  s.afterStatus(async()=>{await s.runner.tick();s.advance();}); await s.remote.tick();
  expect(s.remote.delivery(id).deliveredAt).toBeUndefined();
  s.advance(); await s.remote.tick(); expect(s.remote.delivery(id).deliveredAt).toBe(1000);
  expect(s.texts).toEqual(["PRIVATE"]);
});

test("slow pickup receipts allow concurrent lease renewal with one status probe", async () => {
  const s = setup(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  s.remote.accept("wake:agent-bus:slow-receipt", { text: "PRIVATE", agentExpiresAt: 200_000 });
  let leases = 0, probes = 0;
  s.requestHook(async path => {
    if (path === "/lease") { leases++; s.advance(8_000); }
    if (path === "/delivery-status") { probes++; entered.resolve(); await release.promise; }
  });
  const probing = s.remote.tick(); await entered.promise;
  try {
    expect(s.runner.active()).toBe(true);
    s.advance(5_000); await s.remote.tick();
    expect(leases).toBe(2); expect(probes).toBe(1);
    expect(s.runner.active()).toBe(true);
    s.advance(8_000);
    expect(s.runner.active()).toBe(true);
  } finally { release.resolve(); await probing; }
  expect(s.logs).not.toContain("moni-box-down ");
});

test("remote transfer acknowledgement and legacy migration never fabricate target pickup", async () => {
  const s = setup(); const id = "wake:agent-bus:legacy-pickup";
  s.remote.accept(id, { id, text: `[Agent request areq_${"b".repeat(64)} from Owner's assistant]PRIVATE`, receivedAt: 1_000 });
  await s.remote.tick();
  expect(s.store.db.query("SELECT delivered_at,picked_up_at FROM remote_inbox WHERE id=?").get(opaqueId(id)))
    .toEqual({ delivered_at: 1_000, picked_up_at: null });
  expect(s.remote.delivery(id)).toEqual({ retained: true, confirmed: true });
  s.store.db.query("UPDATE remote_inbox SET expires_at=200000 WHERE id=?").run(opaqueId(id));
  s.restart(); s.advance(); await s.remote.tick();
  expect(s.remote.delivery(id).deliveredAt).toBeUndefined();
  await s.runner.tick(); s.advance(); await s.remote.tick();
  expect(s.remote.delivery(id).deliveredAt).toBe(66_000);
  expect(s.texts).toHaveLength(1);
});

test.each([false, true])("legacy encrypted asks receive deadline metadata before delayed pickup, acked=%s", async acked => {
  const s = setup(); const id = "wake:agent-bus:legacy-deadline";
  s.remote.accept(id, { id, text: `[Agent request areq_${"a".repeat(64)} from Owner's assistant]PRIVATE`, receivedAt: 1_000 });
  if (acked) { await s.remote.tick(); await s.runner.tick(); expect(s.texts).toEqual([]); }
  // The bridge migration can update metadata without decrypting the retained envelope.
  s.store.db.query("UPDATE remote_inbox SET expires_at=2000 WHERE id=?").run(opaqueId(id));
  s.advance();
  // Exercise transfer just before expiry as well as an existing acknowledged box row.
  if (!acked) s.store.db.query("UPDATE remote_inbox SET expires_at=67000 WHERE id=?").run(opaqueId(id));
  await s.remote.tick(); s.advance();
  await s.remote.tick(); await s.runner.tick(); expect(s.texts).toEqual([]);
  expect(s.runner.db.query<{ expires_at: number; state: string; delivered_at: number | null }, [string]>("SELECT expires_at,state,delivered_at FROM inbox WHERE id=?").get(opaqueId(id)))
    .toEqual({ expires_at: acked ? 2000 : 67000, state: "done", delivered_at: null });
});
