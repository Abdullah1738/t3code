import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../src/router.ts";
import { OpenChamber } from "../src/openchamber.ts";
import { createApi } from "../src/api.ts";
import { Delivery } from "../src/delivery.ts";
import type { Access } from "../src/chats.ts";
import { chatKey, GROUP_APP_REFUSAL, LineError, type Line, type LineInbound, type LineOutbound } from "../src/line.ts";
import { TransportError } from "../src/photon.ts";
import { agentWakeId } from "../src/agent-bus.ts";
import { opaqueId } from "../src/remote-protocol.ts";
import { ChatRegistry, createAgentBus, createSbApi, optOutHealth, type ChatCore } from "../src/runtime.ts";
import { handleInbound, runIngress, type IngressDeps } from "../src/sb-ingress.ts";
import { Shares } from "../src/share.ts";
import { Store, type OutboxOperation } from "../src/store.ts";
import { WakeDelivery, wakeId } from "../src/wake-delivery.ts";
import type { BackendKind } from "../src/backend.ts";

const owner = "+15555550123";
const moni = "+15555550199";
let access: Access;
const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeLine(): Line & { reactions: [string, string][]; locationRequests: string[]; optOuts: [string, boolean][] } {
  const reactions: [string, string][] = [];
  const locationRequests: string[] = [];
  const optOuts: [string, boolean][] = [];
  const line: Line = {
    number: "+19362300565",
    events: async function* () {},
    backfill: async () => [],
    outbound: async () => [],
    sendText: async () => ({ handle: "out-1" }),
    upload: async () => "https://cdn.example/file.jpg",
    getMessage: async () => undefined,
    sendApp: async () => ({ handle: "app-1" }),
    react: async (handle, reaction) => { reactions.push([handle, reaction]); },
    typing: async () => {},
    read: async () => {},
    requestLocation: async chat => { locationRequests.push(chat); },
    location: async () => undefined,
    setOptOut: async (address, optedOut) => { optOuts.push([address, optedOut]); },
    download: async () => ({ data: new Uint8Array([1]), name: "a.jpg", mimeType: "image/jpeg" }),
  };
  return Object.assign(line, { reactions, locationRequests, optOuts });
}

type Parts = { api: (request: Request) => Promise<Response>; forwarded: unknown[] };

function setup(realApi = false) {
  access = {
    people: [{ name: "Moni", role: "admin", addresses: [moni, "moni@example.com"] }],
    groups: [{ id: "GRP-Allowed-123", name: "Family Trip" }],
  };
  const stateRoot = mkdtempSync(join(tmpdir(), "sb-runtime-"));
  dirs.push(stateRoot);
  const ownerStore = new Store(join(stateRoot, "state.sqlite"));
  stores.push(ownerStore);
  const line = fakeLine();
  const built: ChatCore[] = [];
  const registry = (store = ownerStore, backend?: BackendKind) => {
    const made = new ChatRegistry<Parts>({
      line, owner, ownerStore: store, stateRoot, access: () => access, backend,
      build: chat => {
        built.push(chat);
        if (chat.store !== store) stores.push(chat.store);
        // Stands in for the per-chat Photon-era API: echoes which chat received the request.
        const forwarded: unknown[] = [];
        if (realApi) return { forwarded, api: createApi({ store: chat.store, photon: { react: async () => {} },
          router: () => undefined, chatGuid: () => chat.info.key, enabled: () => true, health: () => ({}) }) };
        return { forwarded, api: async request => {
          forwarded.push(await request.json());
          return Response.json({ chat: chat.info.slug, path: new URL(request.url).pathname });
        } };
      },
    });
    made.restore();
    return made;
  };
  return { stateRoot, ownerStore, line, built, registry };
}

const message = (overrides: Partial<LineInbound>): LineInbound => ({
  handle: "h-1", chat: chatKey.dm(owner), from: owner, text: "hi", kind: "message", service: "iMessage",
  participants: [], sentAt: 1_000, ...overrides,
});

test("Sendblue wake status reads the owner store without a session or delivery readiness", async () => {
  const env = setup(true), registry = env.registry();
  let enabled = true;
  const handler = createSbApi({ registry, line: env.line, accessPath: join(env.stateRoot, "access.json"),
    enabled: () => enabled, health: () => ({}) });
  for (const state of ["queued", "sending", "ambiguous", "admitted", "failed"] as const) {
    const key = `status:${state}`, id = wakeId(key);
    const post = await handler(new Request("http://bridge/wake", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      text: "PRIVATE_EVENT", source: "watch", dedupeKey: key,
    }) }));
    expect(await post.json()).toEqual({ id, created: true, state: "queued" });
    const tracker = new WakeDelivery(registry.owner.store);
    if (state !== "queued") tracker.sending(id, "owner-thread");
    if (state === "ambiguous") tracker.ambiguous(id, new Error("network"), 60_000);
    if (state === "admitted") tracker.admitted(id);
    if (state === "failed") tracker.failed(id, "ambiguity_deadline");
    enabled = false;
    const response = await handler(new Request(`http://bridge/wake/${id}`));
    expect(response.status).toBe(200);
    const status = await response.json();
    expect(status).toMatchObject({ id, state });
    expect(JSON.stringify(status)).not.toContain("PRIVATE_EVENT");
    enabled = true;
  }
  const elsewhere = registry.open(chatKey.dm(moni));
  const otherId = wakeId("only-in-other-chat");
  elsewhere.store.acceptInbound(otherId, { text: "PRIVATE_OTHER", receivedAt: Date.now() });
  for (const id of [otherId, wakeId("missing")])
    expect((await handler(new Request(`http://bridge/wake/${id}`))).status).toBe(404);
});

const recoveryRaces = (["text", "file", "poll", "app"] as const).flatMap(kind =>
  (["fresh", "duplicate", "in-flight"] as const).map(outcome => ({ kind, outcome })));

test.each(recoveryRaces)("opt-in during retry: $kind $outcome uses actual line-dispatch recovery state", async ({ kind, outcome }) => {
  const { setSystemTime } = await import("bun:test");
  const { sbTransport } = await import("../src/sb-transport.ts");
  const start = Date.parse("2026-11-13T12:00:00Z");
  setSystemTime(start);
  try {
    const env = setup();
    const chats = env.registry();
    const dm = chats.open(chatKey.dm(moni));
    const alerts: string[] = [];
    let calls = 0;
    let releaseSend!: () => void;
    let sendStarted!: () => void;
    const sending = new Promise<void>(resolve => { sendStarted = resolve; });
    const send = async () => {
      if (++calls === 1) throw new LineError("network", "network", true, true);
      sendStarted();
      if (outcome === "in-flight") await new Promise<void>(resolve => { releaseSend = resolve; });
      return { handle: "fresh-after-history" };
    };
    env.line.sendText = send;
    env.line.sendApp = send;
    const operation: OutboxOperation = { id: "retry", kind: "conversation", text: kind === "text" ? "test" : "" };
    if (kind === "file") {
      const bytes = new Uint8Array([1, 2, 3]);
      operation.attachment = { sha256: dm.store.putBlob(bytes), name: "test.png", mimeType: "image/png", size: bytes.length };
    }
    if (kind === "poll") operation.poll = { title: "Lunch?", options: ["Pizza", "Sushi"] };
    if (kind === "app") operation.app = { url: "https://example.test/card", caption: "Card" };
    const oldCopy: LineOutbound = { handle: "old-copy", chat: dm.info.key, status: "sent", sentAt: start + 1_000,
      text: kind === "poll" ? "Lunch?\n1. Pizza\n2. Sushi" : operation.text,
      ...(kind === "file" ? { mediaUrl: "https://cdn.example/file.jpg" } : {}),
      ...(kind === "app" ? { card: { url: operation.app!.url, layout: { caption: "Card" } } } : {}),
    };
    let releaseHistory!: () => void;
    let historyStarted!: () => void;
    const entered = new Promise<void>(resolve => { historyStarted = resolve; });
    env.line.outbound = async () => {
      historyStarted();
      await new Promise<void>(resolve => { releaseHistory = resolve; });
      return outcome === "duplicate" ? [oldCopy] : [];
    };
    const delivery = new Delivery(dm.store, sbTransport(env.line, dm.info.key, dm.store), {
      projectScope: "review", chatGuid: () => dm.info.key, enabled: () => true, sleep: async () => {},
      optOut: { title: "Moni", slug: "moni", notify: async severity => { alerts.push(severity); return true; } },
    });
    dm.store.enqueue(operation);
    await delivery.tick();
    const episode = { since: start, failures: 1, alerted: true };
    dm.store.set("optedOut", episode);
    setSystemTime(start + 180_000);
    const tick = delivery.tick();
    await entered;
    if (outcome === "in-flight") {
      releaseHistory();
      await sending;
    }
    const handler = createSbApi({ registry: chats, line: env.line, accessPath: join(env.stateRoot, "access.json"),
      enabled: () => true, health: () => ({}) });
    const response = await handler(new Request("http://bridge/opt-in", { method: "POST", body: JSON.stringify({ chat: "moni" }) }));
    expect(response.status).toBe(200);
    expect(dm.store.get<unknown>("optOutAwaitingSend")).toEqual([episode]);
    if (outcome === "in-flight") releaseSend();
    else releaseHistory();
    await tick;
    expect(dm.store.getOperation("retry")?.state).toBe("sent");
    expect(calls).toBe(outcome === "duplicate" ? 1 : 2);
    expect(dm.store.get("optedOut")).toBeUndefined();
    expect({ alerts, parked: dm.store.get("optOutAwaitingSend") }).toEqual(outcome === "fresh"
      ? { alerts: ["info"], parked: undefined } : { alerts: [], parked: [episode] });
  } finally { setSystemTime(); }
});

describe("opt-in and health", () => {
  test("only the owner or local CLI can opt a known direct chat in", async () => {
    const env = setup();
    const chats = env.registry();
    const dm = chats.open(chatKey.dm(moni));
    const group = chats.open(chatKey.group("GRP-Allowed-123"), "Family Trip");
    chats.owner.store.set("route", { id: "ses_owner", generation: 1 });
    dm.store.set("route", { id: "ses_moni", generation: 2 });
    dm.store.set("optedOut", { since: 100, failures: 2, alerted: true });
    let enabled = true;
    const handler = createSbApi({ registry: chats, line: env.line, accessPath: join(env.stateRoot, "access.json"),
      enabled: () => enabled, health: () => optOutHealth(chats.all(), true) });
    const post = async (body: Record<string, unknown>) => {
      const response = await handler(new Request("http://bridge/opt-in", { method: "POST", body: JSON.stringify(body) }));
      return { status: response.status, body: await response.json() };
    };
    const getHealth = async () => (await handler(new Request("http://bridge/health"))).json();
    expect(await getHealth()).toEqual({ status: "degraded", optedOut: ["moni"] });
    expect((await post({ chat: "moni", sessionId: "ses_moni@2" })).status).toBe(403);
    expect((await post({ chat: "moni", sessionId: "ses_owner@0" })).status).toBe(409);
    expect((await post({ chat: group.info.slug, sessionId: "ses_owner@1" }))).toEqual({ status: 422, body: { error: "Groups can't be opted in" } });
    expect((await post({ chat: "missing", sessionId: "ses_owner@1" }))).toEqual({ status: 404, body: { error: "Unknown chat" } });
    expect((await post({ chat: "moni", sessionId: null })).status).toBe(400);
    expect((await post({ chat: "moni", extra: true })).status).toBe(400);
    enabled = false;
    expect((await post({ chat: "moni" })).status).toBe(503);
    enabled = true;
    const setOptOut = env.line.setOptOut;
    env.line.setOptOut = async () => { throw new LineError("private", "http_400", false, false); };
    expect(await post({ chat: "moni", sessionId: "ses_owner@1" })).toEqual({ status: 502, body: { error: "Sendblue request failed" } });
    expect(dm.store.get("optedOut")).toBeDefined();
    env.line.setOptOut = setOptOut;
    expect(await post({ chat: "moni", sessionId: "ses_owner@1" })).toEqual({ status: 200, body: { optedIn: true } });
    expect(env.line.optOuts).toEqual([[moni, false]]);
    expect(dm.store.get("optedOut")).toBeUndefined();
    expect(dm.store.get<unknown>("optOutAwaitingSend")).toEqual([{ since: 100, failures: 2, alerted: true }]);
    expect(await getHealth()).toEqual({ status: "healthy", optedOut: [] });
    expect(optOutHealth(chats.all(), false)).toEqual({ status: "degraded", optedOut: [] });
    expect((await post({ chat: "moni" })).status).toBe(200);
    expect(env.line.optOuts).toEqual([[moni, false], [moni, false]]);
    chats.owner.store.set("optedOut", { since: 200, failures: 1 });
    expect(await getHealth()).toEqual({ status: "degraded", optedOut: ["owner"] });
    expect((await post({ chat: "owner", sessionId: "ses_owner@1" })).status).toBe(200);
    expect(env.line.optOuts.at(-1)).toEqual([owner, false]);
    expect(await getHealth()).toEqual({ status: "healthy", optedOut: [] });
  });

  test("a send failure while opt-in is pending is not erased", async () => {
    const env = setup();
    const chats = env.registry();
    const dm = chats.open(chatKey.dm(moni));
    dm.store.set("optedOut", { since: 100, failures: 1 });
    env.line.setOptOut = async () => { dm.store.set("optedOut", { since: 100, failures: 2 }); };
    const handler = createSbApi({ registry: chats, line: env.line, accessPath: join(env.stateRoot, "access.json"),
      enabled: () => true, health: () => ({}) });
    const response = await handler(new Request("http://bridge/opt-in", { method: "POST", body: JSON.stringify({ chat: "moni" }) }));
    expect(response.status).toBe(200);
    expect(dm.store.get<unknown>("optedOut")).toEqual({ since: 100, failures: 2 });
    expect(optOutHealth(chats.all(), true)).toEqual({ status: "degraded", optedOut: ["moni"] });
  });

  test("an old rejection after opt-in cannot recreate the opted-out episode", async () => {
    const env = setup();
    const chats = env.registry();
    const dm = chats.open(chatKey.dm(moni));
    dm.store.set("optedOut", { since: 100, failures: 1, alerted: true });
    let rejectSend!: (error: Error) => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const alerts: string[] = [];
    const delivery = new Delivery(dm.store, { sendText: () => {
      started();
      return new Promise((_resolve, reject) => { rejectSend = reject; });
    } }, { projectScope: "test", chatGuid: () => dm.info.key, enabled: () => true, sleep: async () => {},
      optOut: { title: "Moni", slug: "moni", notify: async severity => { alerts.push(severity); return true; } } });
    dm.store.enqueue({ id: "old-send", kind: "conversation", text: "test" });
    const tick = delivery.tick();
    await entered;
    const handler = createSbApi({ registry: chats, line: env.line, accessPath: join(env.stateRoot, "access.json"),
      enabled: () => true, health: () => optOutHealth(chats.all(), true) });
    const response = await handler(new Request("http://bridge/opt-in", { method: "POST", body: JSON.stringify({ chat: "moni" }) }));
    expect(response.status).toBe(200);
    expect(dm.store.get<number>("optInRevision")).toBe(1);
    rejectSend(new TransportError("http_400:opted_out", false, false));
    await tick;
    expect(dm.store.getOperation("old-send")?.state).toBe("failed");
    expect(dm.store.get("optedOut")).toBeUndefined();
    expect(dm.store.get<unknown>("optOutAwaitingSend")).toEqual([{ since: 100, failures: 1, alerted: true }]);
    expect(optOutHealth(chats.all(), true)).toEqual({ status: "healthy", optedOut: [] });
    expect(alerts).toEqual([]);
    const afterOptIn = new Delivery(dm.store, { sendText: async () => {
      throw new TransportError("http_400:opted_out", false, false);
    } }, { projectScope: "test", chatGuid: () => dm.info.key, enabled: () => true, sleep: async () => {} });
    dm.store.enqueue({ id: "new-send", kind: "conversation", text: "test" });
    await afterOptIn.tick();
    expect(dm.store.get<unknown>("optedOut")).toMatchObject({ failures: 1 });
    expect(optOutHealth(chats.all(), true)).toEqual({ status: "degraded", optedOut: ["moni"] });
  });

  test("failed opt-in does not fence an in-flight rejection", async () => {
    const env = setup();
    const chats = env.registry();
    const dm = chats.open(chatKey.dm(moni));
    let rejectSend!: (error: Error) => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const delivery = new Delivery(dm.store, { sendText: () => {
      started();
      return new Promise((_resolve, reject) => { rejectSend = reject; });
    } }, { projectScope: "test", chatGuid: () => dm.info.key, enabled: () => true, sleep: async () => {} });
    dm.store.enqueue({ id: "old-send", kind: "conversation", text: "test" });
    const tick = delivery.tick();
    await entered;
    env.line.setOptOut = async () => { throw new LineError("private", "http_400", false, false); };
    const handler = createSbApi({ registry: chats, line: env.line, accessPath: join(env.stateRoot, "access.json"),
      enabled: () => true, health: () => optOutHealth(chats.all(), true) });
    const response = await handler(new Request("http://bridge/opt-in", { method: "POST", body: JSON.stringify({ chat: "moni" }) }));
    expect(response.status).toBe(502);
    expect(dm.store.get("optInRevision")).toBeUndefined();
    rejectSend(new TransportError("http_400:opted_out", false, false));
    await tick;
    expect(dm.store.get<unknown>("optedOut")).toMatchObject({ failures: 1 });
    expect(optOutHealth(chats.all(), true)).toEqual({ status: "degraded", optedOut: ["moni"] });
  });

  test("overlapping opt-ins for one chat cannot complete out of order", async () => {
    const env = setup();
    const chats = env.registry();
    const dm = chats.open(chatKey.dm(moni));
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    env.line.setOptOut = async () => { calls++; started(); await new Promise<void>(resolve => { release = resolve; }); };
    const handler = createSbApi({ registry: chats, line: env.line, accessPath: join(env.stateRoot, "access.json"),
      enabled: () => true, health: () => ({}) });
    const post = () => handler(new Request("http://bridge/opt-in", { method: "POST", body: JSON.stringify({ chat: "moni" }) }));
    const first = post();
    await entered;
    const second = await post();
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "Opt-in already in progress" });
    expect(calls).toBe(1);
    release();
    expect((await first).status).toBe(200);
    expect(dm.store.get<number>("optInRevision")).toBe(1);
  });
});

describe("recipient app cards", () => {
  const card = { url: "https://ride.example.com/", caption: "Your ride", subcaption: "Driver assigned",
    trailingCaption: "Lux", trailingSubcaption: "Mercedes", summary: "Open ride" };
  function api(enabled = true) {
    const env = setup(true);
    const chats = env.registry();
    const moniChat = chats.open(chatKey.dm(moni));
    chats.owner.store.set("route", { id: "ses_owner", generation: 1 });
    moniChat.store.set("route", { id: "ses_moni", generation: 2 });
    const handler = createSbApi({ registry: chats, line: env.line, accessPath: join(env.stateRoot, "access.json"),
      enabled: () => enabled, health: () => ({}) });
    const post = async (body: Record<string, unknown>, origin?: string) => {
      const response = await handler(new Request("http://bridge/app", {
        method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body),
      }));
      return { status: response.status, body: await response.json() as { id: string; created: boolean } };
    };
    return { chats, moniChat, post };
  }

  test("the owner can queue a card in Moni's outbox without borrowing her session", async () => {
    const { chats, moniChat, post } = api();
    const body = { ...card, to: "moni", dedupeKey: "ride-1", sessionId: "ses_owner@1" };
    const first = await post(body);
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ id: expect.stringMatching(/^app:[a-f0-9]{64}$/), created: true });
    expect(chats.owner.store.pendingOutbox()).toEqual([]);
    expect(moniChat.store.pendingOutbox()).toEqual([{ id: first.body.id, kind: "conversation", text: "", app: card, state: "pending", attempts: 0 }]);
    expect(await post({ ...body, sessionId: "ses_owner" })).toEqual({ status: 200, body: { id: first.body.id, created: false } });
    expect((await post({ ...body, caption: "Changed" })).status).toBe(409);
    expect((await post({ ...body, url: "https://ride.example.com/other" })).status).toBe(409);
    // A relay remains valid when the destination rotates or has no active agent.
    moniChat.store.set("route", null);
    expect((await post(body)).status).toBe(200);
    expect((await post({ ...body, dedupeKey: "ride-2" })).status).toBe(202);
    expect(moniChat.store.pendingOutbox()).toHaveLength(2);
    expect((await post({ ...body, to: "owner" })).status).toBe(202);
    expect(chats.owner.store.pendingOutbox()[0]!.id).not.toBe(first.body.id);
  });

  test("stage continuation identity and immutable preview survive both enqueue routes", async () => {
    const { chats, post } = api();
    const updateOf = `app:${"a".repeat(64)}`;
    const app = { ...card, updateOf, previewPage: card.url + "stages/preparing/" };
    for (const to of [undefined, "owner"]) {
      const response = await post({ ...app, ...(to ? { to } : {}), dedupeKey: `stage-${to}`, sessionId: "ses_owner@1" });
      expect(response.status).toBe(202);
      expect(chats.owner.store.getOperation(response.body.id)?.app).toEqual(app);
      expect(chats.owner.store.get<string>(`app-latest:${updateOf}`)).toBe(response.body.id);
      expect((await post({ ...app, to, dedupeKey: `stage-${to}`, sessionId: "ses_owner@1" })).status).toBe(200);
      expect((await post({ ...app, to, previewPage: "https://elsewhere.example/", dedupeKey: "invalid", sessionId: "ses_owner@1" })).status).toBe(400);
    }
  });

  test("app cards are refused for group chats, with --to and without it", async () => {
    const { chats, post } = api();
    const group = chats.open(chatKey.group("GRP-Allowed-123"), "Family Trip");
    group.store.set("route", { id: "ses_group", generation: 3 });
    const refused = await post({ ...card, to: group.info.slug, dedupeKey: "ride-1", sessionId: "ses_owner@1" });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ error: GROUP_APP_REFUSAL } as never);
    expect(group.store.pendingOutbox()).toEqual([]);
    const direct = await post({ ...card, dedupeKey: "ride-2", sessionId: "ses_group@3" });
    expect(direct.status).toBe(422);
    expect(group.store.pendingOutbox()).toEqual([]);
  });

  test("without --to cards still bind to the calling chat and its generation", async () => {
    const { chats, moniChat, post } = api();
    const body = { ...card, dedupeKey: "ride-1" };
    expect((await post({ ...body, sessionId: "ses_owner@1" })).status).toBe(202);
    expect((await post({ ...body, sessionId: "ses_moni@2" })).status).toBe(202);
    expect(chats.owner.store.pendingOutbox()[0]).toMatchObject({ app: card, sessionId: "ses_owner", generation: 1 });
    expect(moniChat.store.pendingOutbox()[0]).toMatchObject({ app: card, sessionId: "ses_moni", generation: 2 });
    expect((await post({ ...body, sessionId: "ses_owner@0" })).status).toBe(409);
  });

  test("recipient routing requires the current owner session, even for admin callers", async () => {
    const { chats, moniChat, post } = api();
    const body = { ...card, to: "moni", dedupeKey: "ride-1" };
    expect((await post({ ...body, sessionId: "ses_owner" }, "https://other.example.com")).status).toBe(403);
    expect((await post(body)).status).toBe(403);
    expect((await post({ ...body, sessionId: "ses_moni@2" })).status).toBe(403);
    const person = chats.open(chatKey.dm("+15555550188"));
    person.store.set("route", { id: "ses_person", generation: 1 });
    expect((await post({ ...body, sessionId: "ses_person" })).status).toBe(403);
    expect((await post({ ...body, sessionId: "ses_unknown" })).status).toBe(409);
    expect((await post({ ...body, sessionId: "ses_owner@0" })).status).toBe(409);
    expect((await post({ ...body, sessionId: "ses_owner", to: "missing" })).status).toBe(404);
    chats.owner.store.set("route", { id: "ses_owner", generation: 2 });
    expect((await post({ ...body, sessionId: "ses_owner@1" })).status).toBe(409);
    expect(moniChat.store.pendingOutbox()).toEqual([]);
  });

  test("recipient cards keep app validation and readiness checks", async () => {
    const { moniChat, post } = api();
    const body = { ...card, to: "moni", dedupeKey: "ride-1", sessionId: "ses_owner" };
    for (const patch of [{ url: "http://ride.example.com/" }, { url: "https://user:password@ride.example.com/" },
      { caption: "" }, { subcaption: "line\nbreak" }, { trailingCaption: 123 }, { summary: "x".repeat(501) },
      { dedupeKey: "" }, { to: null }, { to: "../moni" }, { generation: 1 }, { extra: true }]) {
      expect((await post({ ...body, ...patch })).status).toBe(400);
    }
    expect(moniChat.store.pendingOutbox()).toEqual([]);
    const disabled = api(false);
    expect((await disabled.post(body)).status).toBe(503);
    expect(disabled.moniChat.store.pendingOutbox()).toEqual([]);
  });
});

describe("chat registry", () => {
  test("the owner chat uses state.sqlite; other chats are created lazily under chats/<slug>", () => {
    const { registry, ownerStore, stateRoot } = setup();
    const chats = registry();
    expect(chats.all().map(chat => chat.info.slug)).toEqual(["owner"]);
    expect(chats.owner.store).toBe(ownerStore);
    expect(chats.owner.info).toMatchObject({ key: chatKey.dm(owner), kind: "owner" });
    expect(existsSync(join(stateRoot, "chats"))).toBe(false);

    const moniChat = chats.open(chatKey.dm(moni));
    expect(moniChat.info).toMatchObject({ slug: "moni", kind: "dm", title: "Moni" });
    expect(moniChat.stateRoot).toBe(join(stateRoot, "chats", "moni"));
    expect(existsSync(join(stateRoot, "chats", "moni", "state.sqlite"))).toBe(true);

    const group = chats.open(chatKey.group("GRP-Allowed-123"), "Family Trip");
    expect(group.info.slug).toBe("group-family-trip-grp-al");
    expect(group.info).toMatchObject({ kind: "group", title: "Family Trip" });
  });

  test("a person's second address joins their chat and slugs survive a restart", () => {
    const { registry, ownerStore, built } = setup();
    const first = registry();
    const phone = first.open(chatKey.dm(moni));
    expect(first.open(chatKey.dm("moni@example.com"))).toBe(phone);
    first.open(chatKey.dm("+447000000000"));
    const madeBefore = built.length;

    // A rename in access.json must not move an existing chat to a new folder.
    access.people[0]!.name = "Monika";
    const second = registry(ownerStore);
    expect(built.length - madeBefore).toBe(3);
    expect(second.all().map(chat => chat.info.slug).sort()).toEqual(["dm-447000000000", "moni", "owner"]);
    expect(second.get(chatKey.dm("moni@example.com"))!.info.slug).toBe("moni");
  });

  test("a different person whose name slugs the same gets a numbered slug", () => {
    const { registry } = setup();
    const chats = registry();
    const first = chats.open(chatKey.dm(moni));
    access.people.push({ name: "Moni!", role: "person", addresses: ["+447000000001"] });
    const other = chats.open(chatKey.dm("+447000000001"));
    expect(other).not.toBe(first);
    expect(other.info.slug).toBe("moni-2");
  });

  test("an allowed Sendblue message lands in its own chat's store and unknown senders only produce a note", async () => {
    const { registry, ownerStore, line } = setup();
    const chats = registry();
    const notes: string[] = [];
    const deps: IngressDeps = {
      line, owner, ownerStore, access: async () => access, now: () => 5_000,
      sink: chats.sink(async (_address, text) => { notes.push(text); }),
    };
    chats.open(chatKey.dm(moni)).typing.set(moni, 4_000);
    expect(await handleInbound(deps, message({ handle: "m-1", chat: chatKey.dm(moni), from: moni, text: "hey" }))).toBe(true);
    const moniChat = chats.get(chatKey.dm(moni))!;
    expect(moniChat.store.pendingInbound().map(row => row.id)).toEqual(["m-1"]);
    // receivedAt becomes the arrival time for batching; sentAt keeps when it was sent, for the group judge.
    expect(moniChat.store.pendingInbound()[0]!.payload).toMatchObject({ text: "hey", sender: moni, sentAt: 1_000 });
    expect((moniChat.store.pendingInbound()[0]!.payload as { receivedAt: number }).receivedAt).toBeGreaterThan(1_000);
    expect(moniChat.controlsPending).toBe(true);
    expect(moniChat.typing.size).toBe(0);
    expect(chats.owner.store.pendingInbound()).toEqual([]);

    expect(await handleInbound(deps, message({ handle: "m-1", chat: chatKey.dm(moni), from: moni, text: "hey" }))).toBe(false);
    expect(await handleInbound(deps, message({ handle: "o-1", text: "owner here" }))).toBe(true);
    expect(chats.owner.store.pendingInbound().map(row => row.id)).toEqual(["o-1"]);

    expect(await handleInbound(deps, message({ handle: "x-1", chat: chatKey.dm("+447000000009"), from: "+447000000009" }))).toBe(false);
    expect(chats.get(chatKey.dm("+447000000009"))).toBeUndefined();
    expect(notes).toHaveLength(1);
  });

  test("a typing-on with no typing-off stops holding the chat after 8 s", () => {
    const { line, ownerStore, stateRoot } = setup();
    let now = 0;
    const chats = new ChatRegistry<Parts>({
      line, owner, ownerStore, stateRoot, access: () => access, now: () => now,
      build: chat => {
        if (chat.store !== ownerStore) stores.push(chat.store);
        return { forwarded: [], api: async () => Response.json({}) };
      },
    });
    chats.restore();
    const chat = chats.open(chatKey.dm(moni));
    chat.typing.set(moni, 0);
    now = 7_000;
    expect(chat.context.typing()).toBe(true);
    now = 8_500;
    expect(chat.context.typing()).toBe(false);
  });

  test("an id-only stream event pulls the full message from the message list", async () => {
    const { registry, ownerStore, line } = setup();
    const chats = registry();
    const full = message({ handle: "h-live", text: "from the list" });
    let listed = 0;
    line.backfill = async () => { listed += 1; return listed === 1 ? [] : [full]; };
    const controller = new AbortController();
    line.events = async function* () {
      // Sendblue's live stream carries only the message id for a received message.
      yield { type: "message", id: "e1", message: { ...message({ handle: "h-live" }), from: "", text: "" } };
      controller.abort();
    };
    const deps: IngressDeps = { line, owner, ownerStore, access: async () => access, now: () => 5_000, sink: chats.sink(async () => {}) };
    await runIngress(deps, controller.signal);
    expect(chats.owner.store.pendingInbound().map(row => [row.id, (row.payload as { text: string }).text])).toEqual([["h-live", "from the list"]]);
  });

  test("a disabled bridge accepts nothing", async () => {
    const { registry, ownerStore, line } = setup();
    const chats = registry();
    const deps: IngressDeps = { line, owner, ownerStore, access: async () => access, sink: chats.sink(async () => {}, () => false) };
    expect(await handleInbound(deps, message({ handle: "m-1", chat: chatKey.dm(moni), from: moni }))).toBe(false);
    expect(chats.get(chatKey.dm(moni))).toBeUndefined();
  });
});

describe("Sendblue socket API", () => {
  function api(enabled = true) {
    const env = setup();
    const chats = env.registry();
    const moniChat = chats.open(chatKey.dm(moni));
    chats.owner.store.set("route", { id: "ses_owner", generation: 1 });
    moniChat.store.set("route", { id: "ses_moni", generation: 2 });
    moniChat.store.acceptInbound("m-1", { id: "m-1", text: "hi", attachments: [], isAudioMessage: false, receivedAt: 1 });
    const handler = createSbApi({
      registry: chats, line: env.line, accessPath: join(env.stateRoot, "access.json"), enabled: () => enabled,
      health: () => ({ transport: "sendblue", line: env.line.number, chats: chats.all().length }),
    });
    const post = async (path: string, body: Record<string, unknown>) => {
      const response = await handler(new Request(`http://bridge${path}`, { method: "POST", body: JSON.stringify(body) }));
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    return { ...env, chats, moniChat, handler, post };
  }

  test("agent bus routes deliver requests and a single answer using current sessions", async () => {
    const { post, chats, moniChat } = api();
    const input = { sessionId: "ses_owner", to: "moni", text: "question", dedupeKey: "q" };
    const asked = await post("/agent-ask", input);
    expect(asked.status).toBe(202);
    const request = asked.body.id;
    expect(await post("/agent-ask", input)).toEqual({ status: 200, body: { id: request, created: false } });
    expect(moniChat.store.pendingInbound().filter(row => row.id.startsWith("wake:"))).toHaveLength(1);
    expect((await post("/agent-answer", { sessionId: "ses_owner", request, text: "forged" })).status).toBe(403);
    expect((await post("/agent-answer", { sessionId: "ses_moni@1", request, text: "stale" })).status).toBe(409);
    expect((await post("/agent-answer", { sessionId: "ses_moni@2", request, text: "waiting", status: "pending" })).status).toBe(202);
    expect((await post("/agent-answer", { sessionId: "ses_moni", request, text: "answer" })).status).toBe(202);
    expect((await post("/agent-answer", { sessionId: "ses_moni", request, text: "again" })).status).toBe(409);
    expect(chats.owner.store.pendingInbound()).toHaveLength(2);
    expect((await post("/agent-requests", { sessionId: "ses_moni" })).body.requests).toEqual([
      expect.objectContaining({ id: request, from: "owner", to: "moni", hop: 1, status: "done" }),
    ]);
    const stranger = chats.open(chatKey.dm("+15555550888")); stranger.store.set("route", { id: "ses_stranger", generation: 1 });
    expect((await post("/agent-requests", { sessionId: "ses_stranger" })).body.requests).toEqual([]);
  });

  test.each([false, true])("a committed answer wake repairs metadata on sweep, late = %s", async late => {
    setSystemTime(1_000);
    const { post, chats, moniChat } = api();
    const originalWake = chats.wake.bind(chats);
    try {
      const asked = await post("/agent-ask", { sessionId: "ses_moni", to: "owner", text: "q", dedupeKey: "crash" });
      const request = asked.body.id;
      if (late) setSystemTime(601_001);
      chats.wake = (chat, text, key, receipt) => {
        const result = originalWake(chat, text, key, receipt);
        if (key.endsWith(":final")) throw new Error("crash after target insert");
        return result;
      };
      expect((await post("/agent-answer", { sessionId: "ses_owner", request, text: "answer" })).status).toBe(500);
      expect(moniChat.store.pendingInbound().filter(row => row.id.startsWith("wake:"))).toHaveLength(late ? 2 : 1);
      chats.wake = originalWake;
      setSystemTime(1_201_001);
      createAgentBus(chats).sweep();
      expect((await post("/agent-requests", { sessionId: "ses_moni" })).body.requests).toEqual([
        expect.objectContaining({ id: request, status: late ? "done_late" : "done",
          answeredAt: late ? 601_001 : 1_000, timedOutAt: late ? 601_001 : null }),
      ]);
      expect((await post("/agent-answer", { sessionId: "ses_owner", request, text: "again" })).status).toBe(409);
      expect(moniChat.store.pendingInbound().filter(row => row.id.startsWith("wake:"))).toHaveLength(late ? 2 : 1);
    } finally { chats.wake = originalWake; setSystemTime(); }
  });

  test("default bus pairs are explicit; group forwarding stays audience scoped", async () => {
    const { post, chats } = api();
    const family = chats.open(chatKey.group("GRP-Allowed-123"));
    family.store.acceptInbound("written", { sender: "moni@example.com", text: "hi" });
    expect((await post("/agent-ask", { sessionId: "ses_moni", to: family.info.slug, text: "q", dedupeKey: "group" })).status).toBe(403);
    family.store.set("route", { id: "ses_group", generation: 1 });
    expect((await post("/agent-ask", { sessionId: "ses_group", to: "moni", text: "q", dedupeKey: "group" })).status).toBe(202);
    const stranger = chats.open(chatKey.dm("+15555550888"));
    stranger.store.set("route", { id: "ses_stranger", generation: 1 });
    expect((await post("/agent-ask", { sessionId: "ses_stranger", to: "owner", text: "q", dedupeKey: "guest" })).status).toBe(403);
  });

  test("notify rules require the current owner session and are visible to the next bus wake", async () => {
    const { post, chats, stateRoot } = api();
    const add = { action: "add", text: "tell me when Moni orders" };
    for (const [sessionId, status] of [[undefined, 400], ["stale", 409], ["ses_owner@0", 409], ["ses_moni", 403]] as const) {
      for (const action of [add, { action: "list" }, { action: "rm", id: 1 }]) {
        expect((await post("/notify-rule", { ...action, sessionId })).status).toBe(status);
      }
    }
    const added = await post("/notify-rule", { ...add, sessionId: "ses_owner@1" });
    expect(added.status).toBe(200);
    const rule = added.body.rule;
    expect((await post("/notify-rule", { action: "list", sessionId: "ses_owner" })).body.notify).toEqual([rule]);
    expect(JSON.parse(readFileSync(join(stateRoot, "agent-policy.json"), "utf8")).notify).toEqual([rule]);
    await post("/agent-ask", { sessionId: "ses_moni", to: "owner", text: "q", dedupeKey: "notify" });
    expect(JSON.stringify(chats.owner.store.pendingInbound())).toContain(add.text);
    expect((await post("/notify-rule", { action: "rm", id: (rule as { id: number }).id, sessionId: "ses_owner" })).status).toBe(200);
    expect((await post("/notify-rule", { action: "list", sessionId: "ses_owner" })).body.notify).toEqual([]);
    for (const bad of [{ action: "add", text: "" }, { action: "add", text: "x", id: 1 }, { action: "rm", id: "1" },
      { action: "rm", id: 0 }, { action: "list", text: "x" }, { action: "unknown" }, { action: "list", extra: true }]) {
      expect((await post("/notify-rule", { ...bad, sessionId: "ses_owner" })).status).toBe(400);
    }
  });

  test.each(["roster", "seen-senders", "blank-roster", "unknown"])("group bus audience uses %s from that group's store", async source => {
    const { post, chats, moniChat, line, ownerStore } = api();
    const key = chatKey.group("GRP-Allowed-123");
    const family = chats.open(key, "Family Trip");
    const sink = chats.sink(async () => {});
    const deps = { line, owner, ownerStore, access: async () => access, sink };
    if (source !== "unknown") {
      for (const [handle, from] of [["first", owner], ["second", "moni@example.com"], ["third", moni]] as const) {
        await handleInbound(deps, message({ handle, chat: key, from,
          participants: source === "roster" ? [owner, moni, "silent@example.com"] : source === "blank-roster" ? [" "] : [] }));
      }
    }
    const other = chats.open(chatKey.group("other"));
    other.store.acceptInbound("unrelated", { sender: "OTHER_GROUP_SECRET" });
    family.store.set("route", { id: "ses_group", generation: 1 });
    expect((await post("/agent-ask", { sessionId: "ses_group", to: "moni", text: "question", dedupeKey: "audience" })).status).toBe(202);
    const wake = moniChat.store.pendingInbound().find(row => row.id.startsWith("wake:agent-bus:"))!.payload as { text: string };
    expect(wake.text).toContain('This answer will be posted in the group "Family Trip"');
    if (source === "unknown") expect(wake.text).toContain("members: unknown");
    else {
      expect(wake.text).toContain("Abdullah");
      expect(wake.text.match(/Moni/g)).toHaveLength(1);
      expect(wake.text.includes("silent@example.com")).toBe(source === "roster");
    }
    expect(wake.text).not.toContain("OTHER_GROUP_SECRET");
  });

  const audienceUpdates = [
    { label: "omitted participants", participants: undefined, refreshed: false },
    { label: "empty participants", participants: [], refreshed: false },
    ...[0x9, 0xa, 0xb, 0xc, 0xd, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
      0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff].map(code => ({
      label: `blank participants U+${code.toString(16).toUpperCase().padStart(4, "0")}`, participants: ["", String.fromCodePoint(code)], refreshed: false,
    })),
    { label: "new roster", participants: [owner, moni, "new-silent@example.com"], refreshed: true },
  ];
  test.each(audienceUpdates)("group bus reconciles newer senders after a roster: $label", async ({ participants, refreshed }) => {
    const { post, chats, moniChat, line, ownerStore } = api();
    const key = chatKey.group("GRP-Allowed-123");
    const family = chats.open(key, "Family Trip");
    const sam = "+15555550222";
    access.people.push({ name: "Sam", role: "person", addresses: [sam] });
    const deps = { line, owner, ownerStore, access: async () => access, sink: chats.sink(async () => {}) };
    await handleInbound(deps, message({ handle: "before-roster", chat: key, from: "old@example.com" }));
    await handleInbound(deps, message({ handle: "roster", chat: key, from: owner, participants: [owner, moni, "silent@example.com"] }));
    await handleInbound(deps, message({ handle: "new-member", chat: key, from: sam, participants: [] }));
    await handleInbound(deps, message({ handle: "alias", chat: key, from: "moni@example.com", ...(participants ? { participants } : {}) }));
    family.store.acceptInbound("machine-wake", { text: "not a participant" });
    family.store.acceptInbound("blank-sender", { sender: "\t\n\u00a0" });
    const expected = refreshed ? [owner, moni, "new-silent@example.com", "moni@example.com"]
      : [owner, moni, "silent@example.com", sam, "moni@example.com"];
    for (let read = 0; read < 3; read++) expect(family.store.groupAudience().sort()).toEqual(expected.sort());
    family.store.set("route", { id: "ses_group", generation: 1 });
    for (let request = 0; request < 2; request++) {
      expect((await post("/agent-ask", { sessionId: "ses_group", to: "moni", text: "question", dedupeKey: `updated-audience-${request}` })).status).toBe(202);
      const wakes = moniChat.store.pendingInbound().filter(row => row.id.startsWith("wake:agent-bus:"));
      expect(wakes).toHaveLength(request + 1);
      const wake = wakes[request]!.payload as { text: string };
      expect(wake.text).toContain('This answer will be posted in the group "Family Trip"');
      expect(wake.text.match(/\(members: ([^)]+)\)\./)?.[1]?.split(", ").sort()).toEqual(
        (refreshed ? ["Abdullah", "Moni", "new-silent@example.com"] : ["Abdullah", "Moni", "Sam", "silent@example.com"]).sort());
      expect(wake.text).not.toContain("old@example.com");
      expect(wake.text).toContain("Share only what is fine for everyone there to read.");
    }
  });

  test("agent routes validate bodies, reject missing/stale sessions, and respect readiness", async () => {
    const { post } = api(); const disabled = api(false).post;
    const request = `areq_${"a".repeat(64)}`;
    const cases: [string, Record<string, unknown>][] = [
      ["/agent-ask", { sessionId: "ses_owner", to: "moni", text: "q", dedupeKey: "k" }],
      ["/agent-answer", { sessionId: "ses_moni", request, text: "a" }],
      ["/agent-requests", { sessionId: "ses_owner" }],
    ];
    for (const [path, body] of cases) {
      expect((await post(path, { ...body, sessionId: undefined })).status).toBe(400);
      expect((await post(path, { ...body, sessionId: "stale" })).status).toBe(409);
      expect((await post(path, { ...body, surprise: "x" })).status).toBe(400);
      expect((await disabled(path, body)).status).toBe(503);
    }
    for (const value of ["", " ", "x".repeat(12_001), 1, null]) {
      expect((await post("/agent-ask", { ...cases[0]![1], text: value })).status).toBe(400);
      expect((await post("/agent-answer", { ...cases[1]![1], text: value })).status).toBe(400);
    }
    for (const to of ["bad slug", "bad\nslug", "", 1, null]) expect((await post("/agent-ask", { ...cases[0]![1], to })).status).toBe(400);
    for (const parent of ["bad", 1, null]) expect((await post("/agent-ask", { ...cases[0]![1], parent })).status).toBe(400);
    for (const status of ["timed_out", "", null, 1]) expect((await post("/agent-answer", { ...cases[1]![1], status })).status).toBe(400);
    expect((await post("/agent-ask", { ...cases[0]![1], to: "unknown" })).status).toBe(404);
    expect((await post("/agent-ask", { ...cases[0]![1], to: "owner" })).status).toBe(400);
  });

  test("messages reads only the caller's chat or permitted cross-chat history", async () => {
    const { post, chats, moniChat } = api();
    chats.owner.store.acceptInbound("o-1", { text: "owner", receivedAt: 1 });
    expect(await post("/messages", { sessionId: "ses_owner" })).toMatchObject({ status: 200, body: { chat: "owner", messages: [{ id: "o-1", from: "Abdullah" }], more: false } });
    expect(await post("/messages", { sessionId: "ses_moni" })).toMatchObject({ status: 200, body: { chat: "moni", messages: [{ id: "m-1", from: "Someone" }] } });
    expect(await post("/messages", { sessionId: "ses_owner", chat: "moni", id: "m-1" })).toMatchObject({ status: 200, body: { chat: "moni", messages: [{ id: "m-1" }] } });
    expect(await post("/messages", { sessionId: "ses_moni", chat: "owner" })).toEqual({ status: 403, body: { error: "Only the owner's chat can do this" } });
    const family = chats.open(chatKey.group("GRP-Allowed-123"), "Family Trip");
    family.store.set("route", { id: "ses_group", generation: 1 });
    family.store.acceptInbound("g-1", { text: "group", sender: " MONI@example.com", receivedAt: 2 });
    expect((await post("/messages", { sessionId: "ses_moni", chat: family.info.slug })).status).toBe(200);
    expect((await post("/messages", { sessionId: "ses_group" })).status).toBe(200);
    expect((await post("/messages", { sessionId: "ses_group", chat: "owner" })).status).toBe(403);
    const work = chats.open(chatKey.group("GRP-Work-456"), "Work");
    expect((await post("/messages", { sessionId: "ses_moni", chat: work.info.slug })).status).toBe(403);
    const guest = chats.open(chatKey.dm("+15555550188"));
    guest.store.set("route", { id: "ses_guest", generation: 1 });
    expect((await post("/messages", { sessionId: "ses_guest", chat: "moni" })).status).toBe(403);
    expect((await post("/messages", { sessionId: "ses_guest" })).status).toBe(200);
    expect(await post("/messages", { sessionId: "ses_owner", chat: "nobody" })).toEqual({ status: 404, body: { error: "Unknown chat" } });
    expect(await post("/messages", { sessionId: "ses_gone" })).toEqual({ status: 409, body: { error: "No chat for this session" } });
    expect((await post("/messages", {})).status).toBe(400);
    for (const body of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: "5" }, { id: "x", before: "y" },
      { id: "" }, { before: "x".repeat(201) }, { id: "x\ny" }, { before: "x\x85y" }, { unknown: true }]) {
      expect((await post("/messages", { sessionId: "ses_owner", ...body })).status).toBe(400);
    }
    for (const body of [{ id: "missing" }, { before: "missing" }, { id: "m-1" }]) {
      expect(await post("/messages", { sessionId: "ses_owner", ...body })).toEqual({ status: 404, body: { error: "Unknown message" } });
    }
    expect(moniChat.store.pendingOutbox()).toEqual([]);
    access.people[0]!.role = "person";
    expect((await post("/messages", { sessionId: "ses_moni", chat: family.info.slug })).status).toBe(403);
  });

  test("session-bound requests go to the chat that owns the session", async () => {
    const { post } = api();
    expect(await post("/send", { text: "hi", dedupeKey: "k", sessionId: "ses_moni@2" })).toEqual({ status: 200, body: { chat: "moni", path: "/send" } });
    expect(await post("/app", { url: "https://x", sessionId: "ses_owner" })).toEqual({ status: 200, body: { chat: "owner", path: "/app" } });
    expect((await post("/files", { sessionId: "ses_gone" })).status).toBe(409);
    expect((await post("/wake", { text: "w", source: "watch", dedupeKey: "k" })).body).toEqual({ chat: "owner", path: "/wake" });
  });

  test("share routes work from any chat and say when sharing is off", async () => {
    const { post } = api();
    expect(await post("/shares", { sessionId: "ses_moni" })).toEqual({ status: 503, body: { error: "Sharing is unavailable" } });
    const env = setup();
    const registry = env.registry();
    const appsRoot = join(env.stateRoot, "apps");
    await Bun.write(join(appsRoot, "trip", "index.html"), "<h1>t</h1>");
    const shares = new Shares({ store: registry.owner.store, appsRoot,
      startTunnel: async () => ({ url: "https://x.trycloudflare.com", pid: 0, alive: () => true, stop: async () => {}, kill: () => {} }) });
    const handler = createSbApi({ registry, line: env.line, accessPath: join(env.stateRoot, "access.json"), enabled: () => true,
      health: () => ({}), shares });
    const call = async (path: string, body: unknown) => {
      const response = await handler(new Request(`http://bridge${path}`, { method: "POST", body: JSON.stringify(body) }));
      return { status: response.status, body: await response.json() };
    };
    try {
      expect(await call("/share", { app: "trip" })).toMatchObject({ status: 201, body: { url: "https://x.trycloudflare.com", created: true } });
      expect((await call("/shares", {})).body).toMatchObject({ shares: [{ app: "trip", live: true }] });
      expect(await call("/unshare", { app: "trip" })).toEqual({ status: 200, body: { app: "trip", removed: true } });
      expect((await call("/share", [])).status).toBe(400);
    } finally { await shares.stopAll(); }
  });

  test("health reports the transport, line and chat count", async () => {
    const { handler, line } = api();
    const health = await (await handler(new Request("http://bridge/health"))).json();
    expect(health).toEqual({ transport: "sendblue", line: line.number, chats: 2 });
  });

  test("owner-only commands are refused from other chats", async () => {
    const { post, stateRoot } = api();
    const fromMoni = { sessionId: "ses_moni" };
    expect((await post("/send", { text: "x", to: "owner", dedupeKey: "k", ...fromMoni })).status).toBe(403);
    expect((await post("/wake", { text: "x", chat: "owner", dedupeKey: "k", ...fromMoni })).status).toBe(403);
    expect((await post("/chats", fromMoni)).body).toEqual({ chats: [] });
    expect((await post("/allow", { address: "+447000000002", name: "Sam", ...fromMoni })).status).toBe(403);
    expect((await post("/allow-group", { id: "grp-1", ...fromMoni })).status).toBe(403);
    expect((await post("/send", { text: "x", to: "moni", dedupeKey: "k" })).status).toBe(403);
    expect(existsSync(join(stateRoot, "access.json"))).toBe(false);
  });

  test("third-party grant routes are owner-chat only; a grant can't come from a shell or another chat", async () => {
    const env = setup();
    const chats = env.registry();
    chats.owner.store.set("route", { id: "ses_owner", generation: 1 });
    chats.open(chatKey.dm(moni)).store.set("route", { id: "ses_moni", generation: 2 });
    const calls: string[] = [];
    const guests = {
      allow: () => { calls.push("allow"); return { status: 200, body: {} }; },
      revoke: () => { calls.push("revoke"); return { status: 200, body: {} }; },
      list: () => ({ status: 200, body: { guests: [] } }),
      send: async () => { calls.push("send"); return { status: 202, body: {} }; },
      share: async () => { calls.push("share"); return { status: 200, body: {} }; },
    } as unknown as NonNullable<Parameters<typeof createSbApi>[0]["guests"]>;
    const handler = createSbApi({ registry: chats, line: env.line, accessPath: join(env.stateRoot, "access.json"), enabled: () => true, health: () => ({}), guests });
    const post = async (path: string, body: Record<string, unknown>) =>
      (await handler(new Request(`http://bridge${path}`, { method: "POST", body: JSON.stringify(body) }))).status;
    const allow = { address: "+447000000002", name: "Sam", purpose: "book a meeting", providers: ["meeting"], facts: [], evidence: ["msgs:1"] };
    expect(await post("/guest-allow", { ...allow, sessionId: "ses_moni" })).toBe(403);
    expect(await post("/guest-allow", allow)).toBe(403);
    expect(await post("/guest-send", { address: "+447000000002", text: "hi", dedupeKey: "k", sessionId: "ses_moni" })).toBe(403);
    expect(await post("/guest-allow", { ...allow, extra: true, sessionId: "ses_owner" })).toBe(400);
    expect(calls).toEqual([]);
    expect(await post("/guest-allow", { ...allow, sessionId: "ses_owner" })).toBe(200);
    // First-version callers still send actions and a single evidence string.
    expect(await post("/guest-allow", { address: "+447000000002", name: "Sam", purpose: "x", actions: ["meeting"], evidence: "msgs:1", sessionId: "ses_owner" })).toBe(200);
    expect(await post("/guest-revoke", { address: "+447000000002" })).toBe(200);
    expect(await post("/share-contact", { chat: "moni", sessionId: "ses_owner" })).toBe(200);
    expect(calls).toEqual(["allow", "allow", "revoke", "share"]);
  });

  test("an admin's chat can post in groups the admin has written in, and nowhere else", async () => {
    const { post, chats, stateRoot } = api();
    const family = chats.open(chatKey.group("GRP-Allowed-123"), "Family Trip");
    family.store.acceptInbound("g-1", { id: "g-1", text: "hi", attachments: [], isAudioMessage: false, receivedAt: 2, sender: moni });
    const work = chats.open(chatKey.group("GRP-Work-456"), "Work");
    work.store.acceptInbound("g-2", { id: "g-2", text: "hi", attachments: [], isAudioMessage: false, receivedAt: 3, sender: "+447000000009" });
    const fromMoni = { sessionId: "ses_moni" };

    expect(await post("/chats", fromMoni)).toEqual({ status: 200, body: { chats: [
      { slug: "group-family-trip-grp-al", title: "Family Trip", kind: "group", lastActivityAt: 2 },
    ] } });
    const send = { text: "x", to: "group-family-trip-grp-al", dedupeKey: "k", ...fromMoni };
    expect((await post("/send", send)).status).toBe(202);
    expect(family.store.pendingOutbox().map(row => row.text)).toEqual(["x"]);
    expect((await post("/send", send)).status).toBe(200);
    for (const to of [work.info.slug, "owner", "moni", "missing"]) {
      expect((await post("/send", { text: "x", to, dedupeKey: "k2", ...fromMoni })).status).toBe(403);
    }
    expect(work.store.pendingOutbox()).toEqual([]);

    // Membership is case- and space-insensitive, and any of Moni's addresses counts.
    const club = chats.open(chatKey.group("GRP-Club-789"), "Club");
    club.store.acceptInbound("g-3", { id: "g-3", text: "hi", attachments: [], isAudioMessage: false, receivedAt: 4, sender: " MONI@example.com" });
    expect((await post("/send", { text: "y", to: club.info.slug, dedupeKey: "k3", ...fromMoni })).status).toBe(202);

    // A known non-admin person who also wrote in Family Trip gets nothing.
    const person = chats.open(chatKey.dm("+15555550188"));
    person.store.set("route", { id: "ses_person", generation: 1 });
    family.store.acceptInbound("g-4", { id: "g-4", text: "hi", attachments: [], isAudioMessage: false, receivedAt: 5, sender: "+15555550188" });
    expect((await post("/send", { text: "x", to: "group-family-trip-grp-al", dedupeKey: "k4", sessionId: "ses_person" })).status).toBe(403);
    expect((await post("/chats", { sessionId: "ses_person" })).status).toBe(403);

    // Demotion takes effect at once: access.json is read live.
    access.people[0]!.role = "person";
    expect((await post("/send", { text: "x", to: "group-family-trip-grp-al", dedupeKey: "k5", ...fromMoni })).status).toBe(403);
    expect(existsSync(join(stateRoot, "access.json"))).toBe(false);
  });
  test("the owner chat can list chats, message one and pass decisions on", async () => {
    const { post, moniChat, stateRoot } = api();
    const listed = await post("/chats", { sessionId: "ses_owner" });
    expect(listed.body.chats).toEqual([
      { slug: "owner", title: "Abdullah", kind: "owner" },
      { slug: "moni", title: "Moni", kind: "dm", lastActivityAt: 1 },
    ]);
    // The local shell (no session) may list chats and edit access too.
    expect((await post("/chats", {})).status).toBe(200);

    const sent = await post("/send", { text: "dinner at 8", to: "moni", dedupeKey: "k1", sessionId: "ses_owner" });
    expect(sent.status).toBe(202);
    expect(moniChat.store.pendingOutbox().map(row => row.text)).toEqual(["dinner at 8"]);
    expect((await post("/send", { text: "dinner at 8", to: "moni", dedupeKey: "k1", sessionId: "ses_owner" })).status).toBe(200);
    expect((await post("/send", { text: "x", to: "nobody", dedupeKey: "k2", sessionId: "ses_owner" })).status).toBe(404);

    const woke = await post("/wake", { text: "yes, book it", chat: "moni", dedupeKey: "d1", sessionId: "ses_owner" });
    expect(woke.status).toBe(202);
    const wake = moniChat.store.pendingInbound().find(row => row.id === woke.body.id)!;
    expect((wake.payload as { text: string }).text).toEndWith("\nyes, book it");

    expect((await post("/allow", { address: "+447000000002", name: "Sam", admin: true })).status).toBe(200);
    const saved = JSON.parse(readFileSync(join(stateRoot, "access.json"), "utf8")) as Access;
    expect(saved.people.some(person => person.name === "Sam" && person.role === "admin")).toBe(true);
  });

  test("ask-owner wakes the owner's chat with the asking chat named", async () => {
    const { post, chats } = api();
    const asked = await post("/ask-owner", { text: "Can I order sushi?", dedupeKey: "q1", sessionId: "ses_moni" });
    expect(asked.status).toBe(202);
    const rows = chats.owner.store.pendingInbound();
    expect(rows).toHaveLength(1);
    expect((rows[0]!.payload as { text: string }).text).toContain("wake --chat moni");
    expect((rows[0]!.payload as { text: string }).text).toContain("Can I order sushi?");
    expect((await post("/ask-owner", { text: "Can I order sushi?", dedupeKey: "q1", sessionId: "ses_moni" })).status).toBe(202);
    expect(chats.owner.store.pendingInbound()).toHaveLength(1);
    expect((await post("/ask-owner", { text: "?", dedupeKey: "q2", sessionId: "ses_owner" })).status).toBe(400);
  });

  test("react takes a tapback or one emoji on an inbound message of any chat", async () => {
    const { post, line } = api();
    expect((await post("/react", { target: "m-1", kind: "love" })).status).toBe(200);
    expect((await post("/react", { target: "m-1", kind: "🔥" })).status).toBe(200);
    expect((await post("/react", { target: "m-1", kind: "🔥🔥" })).status).toBe(400);
    expect((await post("/react", { target: "m-1", kind: "fire" })).status).toBe(400);
    expect((await post("/react", { target: "nope", kind: "love" })).status).toBe(403);
    expect(line.reactions).toEqual([["m-1", "love"], ["m-1", "🔥"]]);
  });

  test("location requests go to the calling 1:1 chat once per key", async () => {
    const { post, line } = api();
    expect((await post("/location-request", { dedupeKey: "l1", sessionId: "ses_moni" })).status).toBe(202);
    expect((await post("/location-request", { dedupeKey: "l1", sessionId: "ses_moni" })).status).toBe(200);
    expect(line.locationRequests).toEqual([chatKey.dm(moni)]);
    expect((await post("/location", { sessionId: "ses_moni" })).body).toEqual({ location: "none" });
    expect((await post("/location", { sessionId: "ses_gone" })).status).toBe(409);
  });

  test("the owner chat asks for its own location or, with --chat, someone else's", async () => {
    const { post, line } = api();
    expect((await post("/location-request", { dedupeKey: "o1", sessionId: "ses_owner" })).status).toBe(202);
    expect((await post("/location-request", { dedupeKey: "o2", sessionId: "ses_owner", chat: "moni" })).status).toBe(202);
    expect((await post("/location-request", { dedupeKey: "o2", sessionId: "ses_owner", chat: "moni" })).status).toBe(200);
    expect(line.locationRequests).toEqual([chatKey.dm(owner), chatKey.dm(moni)]);
    expect((await post("/location", { sessionId: "ses_owner", chat: "moni" })).body).toEqual({ location: "none" });
    expect((await post("/location", { sessionId: "ses_owner", chat: "nobody" })).status).toBe(404);
    // Only the owner's agent may look up another chat.
    expect((await post("/location", { sessionId: "ses_moni", chat: "owner" })).status).toBe(403);
    expect((await post("/location-request", { dedupeKey: "m9", sessionId: "ses_moni", chat: "owner" })).status).toBe(403);
    expect(line.locationRequests).toHaveLength(2);
  });

  test("a bridge that is not ready refuses sends but still lists chats", async () => {
    const { post } = api(false);
    expect((await post("/send", { text: "x", to: "moni", dedupeKey: "k", sessionId: "ses_owner" })).status).toBe(503);
    expect((await post("/chats", { sessionId: "ses_owner" })).status).toBe(200);
  });
});

test("recipient sends, wakes and guest sends report their own message length limit", async () => {
  const env = setup(true);
  const registry = env.registry();
  registry.open(chatKey.dm(moni));
  env.ownerStore.set("route", { id: "ses_owner", generation: 1 });
  const guests = { send: async () => { throw new Error("must not send"); } } as unknown as NonNullable<Parameters<typeof createSbApi>[0]["guests"]>;
  const handler = createSbApi({ registry, line: env.line, accessPath: join(env.stateRoot, "access.json"),
    enabled: () => true, health: () => ({}), guests });
  for (const [path, limit, extra] of [
    ["/send", 12_000, { to: "moni" }],
    ["/wake", 12_000, { chat: "moni", source: "watch" }],
    ["/guest-send", 2_000, { address: "+15555550198" }],
  ] as const) {
    const response = await handler(new Request(`http://bridge${path}`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(limit + 412), dedupeKey: "long", sessionId: "ses_owner", ...extra }) }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: `message too long: ${(limit + 412).toLocaleString("en-US")} chars, limit ${limit.toLocaleString("en-US")}; split it or send as a card` });
  }
});

test.each(["robob", "openchamber", undefined] as const)("Sendblue receipts identify backend %s for owner and Moni", async backend => {
  const { captureLogs } = await import("./log-fixture.ts");
  const logs = await captureLogs(async () => {
    const h = setup();
    const deps: IngressDeps = { line: h.line, owner, ownerStore: h.ownerStore, access: async () => access,
      sink: h.registry(h.ownerStore, backend).sink(async () => {}) };
    for (const from of [owner, moni]) for (const source of ["live", "backfill"] as const) {
      const input = message({ handle: `backend-${from === owner ? "owner" : "moni"}-${source}`, from, chat: chatKey.dm(from), text: "PRIVATE_INBOUND" });
      expect(await handleInbound(deps, input, source)).toBe(true);
      expect(await handleInbound(deps, input, source)).toBe(false);
    }
  });
  expect(logs.filter(line => line.name === "msg.received").map(line => [line.ids?.chat, line.props?.source, line.props?.backend])).toEqual([
    ["owner", "live", backend ?? "unknown"], ["owner", "backfill", backend ?? "unknown"],
    ["moni", "live", backend ?? "unknown"], ["moni", "backfill", backend ?? "unknown"],
  ]);
  expect(JSON.stringify(logs)).not.toContain("PRIVATE_INBOUND");
});

test("accepted live and backfill ingress logs canonical chat ids and failure tags", async () => {
  const { captureLogs } = await import("./log-fixture.ts");
  const logs = await captureLogs(async () => {
    const h = setup();
    const deps: IngressDeps = { line: h.line, owner, ownerStore: h.ownerStore, access: async () => access,
      sink: h.registry().sink(async () => {}, () => true) };
    const message: LineInbound = { handle: "log-live", chat: chatKey.dm(owner), from: owner, text: "PRIVATE_INBOUND", kind: "message", service: "iMessage", participants: [], sentAt: Date.now() - 100 };
    await handleInbound(deps, message);
    await handleInbound(deps, { ...message, handle: "log-backfill" }, "backfill");
    expect(await handleInbound(deps, message)).toBe(false);
    const { backfill } = await import("../src/sb-ingress.ts");
    await backfill({ ...deps, line: { ...h.line, backfill: async () => [{ ...message, handle: "failed-inbound" }] },
      sink: { ...deps.sink, acceptInto: () => { throw new Error("PRIVATE_ERROR"); } } }, Date.now);

  });
  expect(logs.filter(l => l.name === "msg.received").map(l => [l.ids?.chat, l.props?.source])).toEqual([["owner", "live"], ["owner", "backfill"]]);
  expect(logs.some(l => l.name === "bridge.catch" && l.component === "sb-ingress")).toBe(true);
  expect(JSON.stringify(logs)).not.toContain("PRIVATE_");
});

test.each([
  ["STOP", "sendblue.stop_opt_out"],
  ["OPTED_OUT", "sendblue.opted_out"],
])("late Sendblue failure %s retains the safe code without provider text", async (errorCode, expectedTag) => {
  const { observedLine } = await import("../src/sb-main.ts");
  const { captureLogs } = await import("./log-fixture.ts");
  const logs = await captureLogs(async () => {
    const line = fakeLine();
    line.events = async function* () {
      yield { type: "status", id: "status-failed", handle: "sent-fixture", status: "failed", errorCode, errorMessage: "PRIVATE_PROVIDER_MESSAGE", at: Date.now() };
      yield { type: "status", id: "status-delivered", handle: "sent-ok", status: "delivered", at: Date.now() };
    };
    for await (const _event of observedLine(line, { synchronized: true, lastEventAt: 0 }, () => ({ chat: "moni", operationId: "operation-fixture", inboundId: "inbound-fixture", threadId: "thread-fixture" })).events(new AbortController().signal)) { /* drain fixture */ }
  });
  expect(logs.find(l => l.name === "reply.failed")?.error?.tag).toBe(expectedTag);
  expect(logs.find(l => l.name === "reply.failed")?.ids).toMatchObject({ chat: "moni", operationId: "operation-fixture", inboundId: "inbound-fixture", threadId: "thread-fixture" });
  expect(logs.filter(l => l.name === "reply.failed")).toHaveLength(1);
  expect(JSON.stringify(logs)).not.toContain("PRIVATE_PROVIDER_MESSAGE");
});

test("send and file acknowledgements name the routed recipient for owner, Moni, groups and retries", async () => {
  const env = setup(true);
  const chats = env.registry();
  const targets = [chats.owner, chats.open(chatKey.dm(moni)), chats.open(chatKey.group("GRP-Allowed-123"), "Family Trip")];
  const handler = createSbApi({ registry: chats, line: env.line, accessPath: join(env.stateRoot, "access.json"), enabled: () => true, health: () => ({}) });
  const post = async (path: string, body: Record<string, unknown>) => {
    const response = await handler(new Request(`http://bridge${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  for (const [index, target] of targets.entries()) {
    const sessionId = `session-${index}`;
    target.store.set("route", { id: sessionId, generation: 1 });
    for (const path of ["/send", "/files"]) {
      const body = { sessionId, dedupeKey: `${path}-${index}`, text: "hello", ...(path === "/files" ? { base64: "aGk=", name: "a.txt", mimeType: "text/plain" } : {}) };
      const first = await post(path, body);
      expect(first).toMatchObject({ status: 202, body: { created: true, chat: target.info.slug } });
      expect(await post(path, body)).toEqual({ status: 200, body: { ...first.body, created: false } });
    }
  }
  for (const target of targets) {
    const first = await post("/send", { text: "relay", to: target.info.slug, sessionId: "session-0", dedupeKey: `relay-${target.info.slug}` });
    expect(first).toMatchObject({ status: 202, body: { chat: target.info.slug } });
    expect((await post("/send", { text: "relay", to: target.info.slug, sessionId: "session-0", dedupeKey: `relay-${target.info.slug}` })).body).toMatchObject({ created: false, chat: target.info.slug });
  }
});


test("bus delivery verifies the deduped local row and traces every batched member pickup", () => {
  const env = setup(); const registry = env.registry(); registry.restore();
  const moniChat = registry.open(chatKey.dm(moni));
  registry.owner.store.set("route", { id: "ses_owner", generation: 1 });
  const logs: string[] = [];
  const bus = createAgentBus(registry, (event, code) => logs.push(`${event} ${code}`), join(env.stateRoot, "policy.json"));
  const result = bus.ask({ sessionId: "ses_owner", to: "moni", text: "PRIVATE_REQUEST", dedupeKey: "one" });
  const id = (result.body as { id: string }).id;
  const row = moniChat.store.pendingInbound()[0]!;
  const at = Date.now(); moniChat.store.set(`inbound-delivered:${row.id}`, at);
  bus.sweep(); bus.sweep();
  const request = registry.owner.store.db.query<{ delivered_at: number | null }, [string]>("SELECT delivered_at FROM agent_requests WHERE id=?").get(id);
  expect(request?.delivered_at).toBe(at);
  expect(logs.filter(s => s.startsWith("agent-deliver "))).toHaveLength(1);
  expect(logs.filter(s => s.startsWith("agent-delivered "))).toHaveLength(1);
  expect(logs.join()).not.toContain("PRIVATE_REQUEST");
});


test("upgrading twice expires old local and rollback queues without sending historical requests", async () => {
  const env = setup(true), registry = env.registry(), chat = registry.open(chatKey.dm(moni));
  registry.owner.store.set("route", { id: "deadline-owner", generation: 1 });
  const bus = createAgentBus(registry, undefined, join(env.stateRoot, "policy.json"));
  const request = bus.ask({ sessionId: "deadline-owner", to: "moni", text: "PRIVATE", dedupeKey: "legacy" });
  const requestId = (request.body as {id:string}).id;
  const id = agentWakeId(`agent-ask:${requestId}`);
  registry.owner.store.db.query("UPDATE agent_requests SET created_at=? WHERE id=?").run(Date.now()-1_200_000,requestId);
  chat.store.db.query("UPDATE inbound SET payload=json_remove(payload,'$.agentExpiresAt') WHERE id=?").run(id);
  chat.store.db.exec("CREATE TABLE remote_inbox (seq INTEGER PRIMARY KEY,id TEXT UNIQUE,sealed TEXT,receipt TEXT)");
  chat.store.db.query("INSERT INTO remote_inbox(id,sealed) VALUES (?,'CIPHERTEXT')").run(opaqueId(id));
  registry.owner.store.set("agent-bus-deadlines-v1", null);
  createAgentBus(registry, undefined, join(env.stateRoot, "policy.json"));
  const local = chat.store.db.query<{expiresAt:number},[string]>("SELECT json_extract(payload,'$.agentExpiresAt') AS expiresAt FROM inbound WHERE id=?").get(id)!;
  expect(local.expiresAt).toBeLessThan(Date.now());
  expect(chat.store.db.query("SELECT sealed,expires_at FROM remote_inbox").get()).toEqual({ sealed:"CIPHERTEXT", expires_at: local.expiresAt });
  let calls=0;
  class Backend extends OpenChamber { override async request<T>():Promise<T|undefined> {calls++;throw new Error("Historical request must not reach the backend");} }
  const backend=new Backend("http://127.0.0.1:1"), transport={read:async()=>{},typing:async()=>{},downloadAttachment:async()=>{throw new Error("unexpected attachment");}};
  const options={owner,context:chat.context,chatGuid:chat.info.key,timezone:"Asia/Dubai",skillPath:"/nonexistent/imessage",alertSkillPath:"/nonexistent/telegram",alertSocketPath:"/nonexistent/socket",openCodeConfigRoot:"/nonexistent/config",quietMs:0};
  await new Router(chat.store,backend,transport,options).tick();
  createAgentBus(registry,undefined,join(env.stateRoot,"policy.json"));
  await new Router(chat.store,backend,transport,options).tick();
  expect(calls).toBe(0); expect(chat.store.pendingOutbox()).toEqual([]);
  expect(chat.store.db.query("SELECT state FROM inbound WHERE id=?").get(id)).toEqual({state:"failed"});
  expect(chat.store.db.query("SELECT sealed,expires_at FROM remote_inbox").get()).toEqual({sealed:"CIPHERTEXT",expires_at:local.expiresAt});
});
