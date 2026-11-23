import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatContext } from "../src/chats.ts";
import { chatKey, type Line } from "../src/line.ts";
import { OpenChamber, type MessageRecord } from "../src/openchamber.ts";
import { TransportError, type NormalizedInbound } from "../src/photon.ts";
import { RemoteBox, type RemoteBoxConfig } from "../src/remote-box.ts";
import { opaqueId } from "../src/remote-protocol.ts";
import { MAX_SYNTHETIC_ATTEMPTS, OUTAGE_NOTICE_AFTER_MS, Router } from "../src/router.ts";
import { migrateOperationalNotices } from "../src/operational-notice.ts";
import { Store } from "../src/store.ts";
import { captureLogs } from "./log-fixture.ts";

const START = Date.parse("2026-11-23T08:00:00Z");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const wakeBody = (id: string, title = "Inbox triage") =>
  `[Watcher event from robob-watch inbox-triage, not typed by the owner.]\n${title} (${id})\nPRIVATE_BODY_${id}`;

type TelegramNotify = { source: string; severity: string; text: string; dedupeKey: string };

class FakeBackend extends OpenChamber {
  offline = false;
  createFails = false;
  questionsFail = false;
  records: MessageRecord[] = [];
  prompts: { session: string; id: string; text: string; system?: string }[] = [];
  pendingPerms: { id: string; sessionID: string; action: string; resources: string[]; save?: boolean; source?: string }[] = [];
  constructor() { super("http://127.0.0.1:1"); }
  override async request<T>(): Promise<T | undefined> { throw new Error("Unexpected backend access"); }
  override async createChat() {
    if (this.offline || this.createFails) throw new Error("backend down");
    return { id: "ses_1", directory: "/Chats/ses_1" };
  }
  override async isSessionAutoAccepting() { return false; }
  override async permissions() { return this.pendingPerms; }
  override async questions() {
    if (this.questionsFail) throw new Error("questions down");
    return [];
  }
  override async children() { return []; }
  override async statuses() { return {}; }
  override async getSession(id: string, directory: string) {
    return { id, directory, title: "Chat", time: { created: START, updated: START } };
  }
  override async messages() { return this.records; }
  override async promptAccepted(_session: string, _dir: string, id: string) {
    return this.records.some(r => r.id === id && r.type === "user");
  }
  override async prompt(session: string, _dir: string, id: string, text: string, system?: string) {
    this.prompts.push({ session, id, text, system });
    if (this.offline) throw new Error("backend offline");
    this.records.push({ id, type: "user", text, time: { created: Date.now() } });
  }
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) {
    try { cleanups.pop()!(); } catch { /* best effort cleanup */ }
  }
  setSystemTime();
});

function startTelegramMock() {
  const dir = mkdtempSync(join("/tmp", "opn-"));
  const socketPath = join(dir, "tg.sock");
  const received: TelegramNotify[] = [];
  const seen = new Set<string>();
  let mode: "ok" | "fail503" = "ok";
  const server = Bun.serve({
    unix: socketPath,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== "/notify") return new Response("not found", { status: 404 });
      if (mode === "fail503") return Response.json({ error: "unavailable" }, { status: 503 });
      const body = await req.json() as TelegramNotify;
      // Enforce real telegram-bridge /notify validation rules!
      if (typeof body.source !== "string" || body.source.length === 0 || body.source.length > 40 || /[^A-Za-z0-9 ._#-]/.test(body.source)) {
        return Response.json({ error: "invalid source" }, { status: 400 });
      }
      if (!["info", "attention", "error"].includes(body.severity)) {
        return Response.json({ error: "invalid severity" }, { status: 400 });
      }
      if (typeof body.dedupeKey !== "string" || body.dedupeKey.length === 0 || body.dedupeKey.length > 200) {
        return Response.json({ error: "invalid key" }, { status: 400 });
      }
      if (typeof body.text !== "string" || body.text.length === 0 || body.text.length > 12_000) {
        return Response.json({ error: "invalid text" }, { status: 400 });
      }
      const created = !seen.has(body.dedupeKey);
      seen.add(body.dedupeKey);
      received.push(body);
      return Response.json({ id: body.dedupeKey, created }, { status: created ? 202 : 200 });
    },
  });
  cleanups.push(() => { server.stop(true); rmSync(dir, { recursive: true, force: true }); });
  return {
    socketPath,
    received,
    fail: () => { mode = "fail503"; },
    recover: () => { mode = "ok"; },
  };
}

function moniContext(): ChatContext {
  return {
    chat: {
      key: chatKey.dm("+15550001111"),
      slug: "moni",
      kind: "dm",
      title: "Moni",
      person: { name: "Moni", role: "admin", addresses: ["+15550001111"] },
    },
    roleOf: () => ({ name: "Moni", role: "admin" }),
    typing: () => false,
    react: async () => {},
  };
}

function setupRouter(opts: {
  context?: ChatContext;
  failureNoticeMs?: number;
  droppedBatchMs?: number;
  downloadAttachment?: () => Promise<{ data: Uint8Array; name: string; mimeType: string }>;
} = {}) {
  setSystemTime(START);
  const dir = mkdtempSync(join(tmpdir(), "opn-db-"));
  const dbPath = join(dir, "state.sqlite");
  let store = new Store(dbPath);
  const openStores = [store];
  cleanups.push(() => {
    for (const s of openStores) try { s.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  const tg = startTelegramMock();
  const backend = new FakeBackend();
  const transport = {
    read: async () => {},
    typing: async () => {},
    downloadAttachment: opts.downloadAttachment ?? (async () => { throw new TransportError("invalidAttachment", false); }),
  };
  const routerOpts: ConstructorParameters<typeof Router>[3] = {
    owner: "+15555550123",
    chatGuid: opts.context?.chat.key ?? "iMessage;-;+15555550123",
    timezone: "Asia/Dubai",
    quietMs: 0,
    skillPath: "/test/imessage/SKILL.md",
    alertSkillPath: "/test/telegram/SKILL.md",
    alertSocketPath: tg.socketPath,
    openCodeConfigRoot: "/nonexistent/config",
    medsFold: false,
    droppedBatchMs: opts.droppedBatchMs ?? 0,
    failureNoticeMs: opts.failureNoticeMs ?? 0,
    ...(opts.context ? { context: opts.context } : {}),
  };
  let router = new Router(store, backend, transport, routerOpts);
  const restart = () => {
    store.close();
    store = new Store(dbPath);
    openStores.push(store);
    router = new Router(store, backend, transport, routerOpts);
    return router;
  };
  const input = (id: string, text: string, extra: Partial<NormalizedInbound> = {}) =>
    store.acceptInbound(id, {
      id,
      text,
      source: "typed",
      attachments: [],
      isAudioMessage: false,
      receivedAt: Date.now(),
      ...extra,
    } satisfies NormalizedInbound);
  const allOutbox = () => store.db.query<{ id: string; payload: string; state: string }, []>("SELECT id, payload, state FROM outbox").all()
    .map(r => ({ ...JSON.parse(r.payload), state: r.state }));
  return {
    get store() { return store; },
    get router() { return router; },
    backend,
    tg,
    restart,
    input,
    allOutbox,
  };
}

async function exhaustWake(h: ReturnType<typeof setupRouter>, id: string) {
  h.backend.offline = true;
  h.input(id, wakeBody(id));
  for (let attempt = 1; attempt <= MAX_SYNTHETIC_ATTEMPTS; attempt++) {
    await h.router.tick();
    setSystemTime(Date.now() + 60_000); await h.router.tick();
    setSystemTime(Date.now() + 60_000); await h.router.tick();
    const retry = h.store.get<{ nextAt: number }>(`synthetic-retry:${id}`);
    if (attempt < MAX_SYNTHETIC_ATTEMPTS && retry) setSystemTime(retry.nextAt);
  }
}

test("dropped synthetic single wake goes to Telegram only, preserves #76 carry, and avoids first-person phrasing", async () => {
  const h = setupRouter();
  await exhaustWake(h, "wake:drop-1");

  expect(h.allOutbox()).toEqual([]);
  expect(h.tg.received).toHaveLength(1);
  const msg = h.tg.received[0]!;
  expect(msg.source).toBe("iMessage bridge - owner chat");
  expect(msg.severity).toBe("attention");
  expect(msg.dedupeKey).toBe("imessage:dropped:owner:wake:drop-1:undelivered");
  expect(msg.text).toContain("Owner chat:");
  expect(msg.text).not.toMatch(/I'll recheck|on my end|couldn't reach me|Mind sending/i);

  // #76 invariant: missed synthetic row is still carried into the next human turn.
  const missed = h.store.get<{ id: string }[]>("missedSynthetic") ?? [];
  expect(missed.map(m => m.id)).toEqual(["wake:drop-1"]);
  h.backend.offline = false;
  h.input("human-after-drop", "Check status");
  await h.router.tick();
  expect(h.backend.prompts.at(-1)?.system).toContain("PRIVATE_BODY_wake:drop-1");

  // Idempotent across re-tick and restart.
  await h.router.tick();
  h.restart();
  await h.router.tick();
  expect(h.tg.received).toHaveLength(1);
});

test("dropped synthetic multi-item batch goes to Telegram as one deduplicated alert with zero chat sends", async () => {
  const h = setupRouter({ droppedBatchMs: 30_000 });
  h.store.set("droppedNotices", [
    { id: "wake:b", label: "watcher: Beta", reason: "failed", text: "Owner chat: watcher: Beta hit an error.", at: START },
    { id: "wake:a", label: "watcher: Alpha", reason: "expired", text: "Owner chat: watcher: Alpha expired.", at: START + 1_000 },
  ]);
  setSystemTime(START + 35_000);
  await h.router.tick();

  expect(h.allOutbox()).toEqual([]);
  expect(h.tg.received).toHaveLength(1);
  const msg = h.tg.received[0]!;
  expect(msg.source).toBe("iMessage bridge - owner chat");
  expect(msg.dedupeKey).toMatch(/^imessage:dropped:owner:batch:[a-f0-9]+$/);
  expect(msg.text).toContain("watcher: Beta");
  expect(msg.text).toContain("watcher: Alpha");
  expect(msg.text).not.toMatch(/I'll pick it up|on my end|couldn't reach me/i);
});

test("outage notice routes to Telegram with stable episode key, never texts chat, and survives restart without double-send", async () => {
  const h = setupRouter();
  h.store.set("route", { id: "ses_1", directory: "/Chats/ses_1", generation: 1, createdAt: START });
  h.backend.offline = true;
  h.input("owner-msg-1", "Hello there");
  await h.router.tick();
  setSystemTime(START + 65_000);
  await h.router.tick();
  expect(h.allOutbox()).toEqual([]);
  expect(h.tg.received).toHaveLength(0);

  setSystemTime(START + OUTAGE_NOTICE_AFTER_MS + 1_000);
  await h.router.tick();
  expect(h.allOutbox()).toEqual([]);
  expect(h.tg.received).toHaveLength(1);
  const msg = h.tg.received[0]!;
  expect(msg.source).toBe("iMessage bridge - owner chat");
  expect(msg.dedupeKey).toBe(`imessage:outage:owner:${hash("owner-msg-1")}`);
  expect(msg.text).not.toContain("I'm having a technical problem");

  // Re-tick and restart must never re-send.
  setSystemTime(Date.now() + 60_000);
  await h.router.tick();
  h.restart();
  setSystemTime(Date.now() + 60_000);
  await h.router.tick();
  expect(h.allOutbox()).toEqual([]);
  expect(h.tg.received).toHaveLength(1);
});

test("turn failure waits for the grace period and uses the generation and message ID", async () => {
  const h = setupRouter({ failureNoticeMs: 60_000 });
  h.input("turn-fail-1", "Do work");
  await h.router.tick();
  const turn = h.store.get<{ id: string; generation: number; messageId: string }>("activeTurn")!;
  h.backend.records.push({ id: "idle_fail", type: "idle", outcome: "failed", time: { created: Date.now() } });
  await h.router.tick();
  expect(h.allOutbox()).toEqual([]);
  expect(h.tg.received).toHaveLength(0);

  // Grace expires -> Telegram gets the notice, chat gets nothing.
  setSystemTime(Date.now() + 61_000);
  await h.router.tick();
  expect(h.allOutbox()).toEqual([]);
  expect(h.tg.received).toHaveLength(1);
  expect(h.tg.received[0]!.dedupeKey).toBe(`imessage:failed:owner:${turn.generation}:${turn.messageId}`);
  expect(h.tg.received[0]!.text).not.toMatch(/on my end|Mind trying again/i);
});

test("interrupted inbound, /new failure, and attachment failure route to Telegram and never text chat", async () => {
  const h = setupRouter();
  // 1. Interrupted processing inbound row (router.ts ~L2012)
  h.input("orphan-1", "Lost message");
  h.store.updateInbound("orphan-1", "processing");
  await h.router.tick();
  expect(h.allOutbox()).toEqual([]);
  expect(h.tg.received.some(m => m.dedupeKey === `imessage:interrupted:owner:${hash("orphan-1")}`)).toBe(true);

  // 2. /new backend createChat failure (router.ts ~L3108)
  h.backend.createFails = true;
  h.input("cmd-new-fail", "/new");
  await h.router.tick();
  expect(h.allOutbox()).toEqual([]);
  expect(h.tg.received.some(m => m.dedupeKey === `imessage:command-failed:owner:${hash("cmd-new-fail")}`)).toBe(true);
  h.backend.createFails = false;

  // 3. Attachment download failure (router.ts ~L3896)
  h.input("att-fail-1", "", {
    attachments: [{ guid: "att-1", fileName: "photo.jpg", mimeType: "image/jpeg", totalBytes: 100, transferState: "finished", uti: "", isHidden: false, isOutgoing: false, isSticker: false }],
  });
  await h.router.tick();
  expect(h.allOutbox()).toEqual([]);
  expect(h.tg.received.some(m => m.dedupeKey === `imessage:attachment-failed:owner:${hash("att-fail-1")}`)).toBe(true);
});

test("Telegram failure retries with backoff from store across restart, logs notice.routed, and never falls back to chat", async () => {
  const h = setupRouter();
  h.store.set("route", { id: "ses_1", directory: "/Chats/ses_1", generation: 1, createdAt: START });
  h.tg.fail();
  h.backend.offline = true;
  h.input("retry-msg", "Need help");
  await h.router.tick();
  setSystemTime(START + 65_000);
  await h.router.tick();
  setSystemTime(START + OUTAGE_NOTICE_AFTER_MS + 1_000);

  const retryLogs = await captureLogs(async () => {
    await h.router.tick();
  });
  expect(h.allOutbox()).toEqual([]);
  expect(h.tg.received).toHaveLength(0);
  const routedRetry = retryLogs.find(l => l.name === "notice.routed");
  expect(routedRetry?.props?.telegram).toBe("retry");
  expect(routedRetry?.props?.kind).toBe("outage");
  expect(routedRetry?.props?.chat).toBe("owner");
  expect(JSON.stringify(retryLogs)).not.toContain("Need help");

  // Restart while Telegram is still down, then recover and advance past backoff.
  h.restart();
  h.tg.recover();
  setSystemTime(Date.now() + 10_000);
  const sentLogs = await captureLogs(async () => {
    await h.router.tick();
  });
  expect(h.allOutbox()).toEqual([]);
  expect(h.tg.received).toHaveLength(1);
  expect(h.tg.received[0]!.dedupeKey).toBe(`imessage:outage:owner:${hash("retry-msg")}`);
  expect(sentLogs.find(l => l.name === "notice.routed")?.props?.telegram).toBe("sent");
});

test("Moni chat via Router routes operational notices to Abdullah's Telegram with Moni tag and zero chat sends", async () => {
  const h = setupRouter({ context: moniContext() });
  h.store.set("route", { id: "ses_1", directory: "/Chats/ses_1", generation: 1, createdAt: START });
  h.backend.offline = true;
  h.input("moni-msg-1", "Hi Robob");
  await h.router.tick();
  setSystemTime(START + 65_000);
  await h.router.tick();
  setSystemTime(START + OUTAGE_NOTICE_AFTER_MS + 1_000);
  await h.router.tick();

  expect(h.allOutbox()).toEqual([]);
  expect(h.tg.received).toHaveLength(1);
  const msg = h.tg.received[0]!;
  expect(msg.source).toBe("iMessage bridge - Moni chat");
  expect(msg.dedupeKey).toBe(`imessage:outage:moni:${hash("moni-msg-1")}`);
  expect(msg.text).toContain("Moni chat:");
});

test("Moni chat via RemoteBox intercepts runner attachment-failed callback to Telegram and never texts Moni", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opn-remote-"));
  const tg = startTelegramMock();
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const tokenFile = join(dir, "token"), callbackTokenFile = join(dir, "cb"), publicKeyFile = join(dir, "pub.pem");
  writeFileSync(tokenFile, "t".repeat(40)); writeFileSync(callbackTokenFile, "c".repeat(40)); writeFileSync(publicKeyFile, keys.publicKey);
  const store = new Store(join(dir, "moni.sqlite"));
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const config: RemoteBoxConfig = {
    kind: "remote-box", url: "http://127.0.0.1:19999", tokenFile, callbackTokenFile, publicKeyFile,
    callbackPort: 19998, epoch: "test", boxId: "bx_test",
  };
  const sentToMoni: string[] = [];
  const line: Line = {
    number: "+15550000000", events: async function* () {}, backfill: async () => [], outbound: async () => [],
    sendText: async (_chat, text) => { sentToMoni.push(text); return { handle: "h1" }; },
    upload: async () => "https://example.test/f", getMessage: async () => undefined,
    sendApp: async () => ({ handle: "h1" }), react: async () => {}, typing: async () => {}, read: async () => {},
    requestLocation: async () => {}, location: async () => undefined, setOptOut: async () => {},
    download: async () => ({ data: new Uint8Array(), name: "", mimeType: "" }),
  };
  const remote = new RemoteBox(config, store, {
    active: () => true,
    log: () => {},
    alertSocketPath: tg.socketPath,
  });
  cleanups.push(() => remote.stop());

  const inboxId = opaqueId("moni-inbound-att");
  const actionId = opaqueId(`attachment-failed:${inboxId}`);
  const req = new Request("http://bridge/send", {
    method: "POST",
    headers: { authorization: `Bearer ${"c".repeat(40)}` },
    body: JSON.stringify({
      epoch: "test",
      id: actionId,
      inboxId,
      text: "I couldn’t read an attachment. Please send it again.",
    }),
  });
  const res = await remote.callback(req, { line, chat: chatKey.dm("+15550001111"), bus: async () => Response.json({}) });
  expect(res.status).toBe(200);
  expect(sentToMoni).toEqual([]);
  expect(tg.received).toHaveLength(1);
  expect(tg.received[0]!.source).toBe("iMessage bridge - Moni chat");
  expect(tg.received[0]!.dedupeKey).toBe(`imessage:attachment-failed:moni:${inboxId}`);
});

test("agent replies and interactive /status still reach iMessage chat", async () => {
  const h = setupRouter();
  // 1. /status still enqueues control with answersInbound: true
  h.input("cmd-status", "/status");
  await h.router.tick();
  expect(h.allOutbox().some(op => op.kind === "control" && op.answersInbound === true)).toBe(true);

  // 2. Normal agent reply reaches conversation outbox
  h.input("hello-1", "Hi");
  await h.router.tick();
  h.backend.records.push(
    { id: "asst_1", type: "assistant", agent: "build", model: { providerID: "test", id: "model" }, finish: "stop", content: [{ type: "text", text: "Hello back!" }], time: { created: Date.now(), completed: Date.now() } },
    { id: "idle_1", type: "idle", outcome: "succeeded", time: { created: Date.now() } },
  );
  await h.router.tick();
  expect(h.allOutbox().some(op => op.kind === "conversation" && op.text === "Hello back!")).toBe(true);
  expect(h.tg.received).toHaveLength(0);
});

test("a retry-exhausted outage row queued in the chat by an earlier build moves to Telegram under the new key", () => {
  const dir = mkdtempSync(join(tmpdir(), "opn-migrate-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "bridge.db"));
  cleanups.push(() => store.close());
  store.enqueue({ id: "failed:EX1:exhausted", kind: "control", text: "I'm having a technical problem; I'll answer this as soon as I'm back." });
  migrateOperationalNotices(store, "moni");
  migrateOperationalNotices(store, "moni");
  expect(store.getOperation("failed:EX1:exhausted")?.state).toBe("cancelled");
  expect(store.pendingOutbox()).toHaveLength(0);
  const notices = store.operationalNotices();
  // Same key the router now writes for this leader, so a restart mid-upgrade cannot double-send.
  expect(notices.map(n => n.id)).toEqual(["imessage:failed:moni:EX1:exhausted"]);
  expect(notices[0]!.text).toStartWith("Moni chat: ");
  expect(notices[0]!.text).not.toContain("technical problem");
});
