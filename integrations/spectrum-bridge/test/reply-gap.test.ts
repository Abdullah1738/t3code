import { afterEach, expect, mock, setSystemTime, test } from "bun:test";
import * as grpc from "@photon-ai/advanced-imessage/grpc";
import { normalizeInbound } from "../src/photon.ts";
import { Delivery } from "../src/delivery.ts";
import { ReplyGapMonitor } from "../src/reply-gap.ts";
import { Store } from "../src/store.ts";

const stores: Store[] = [];
const START = Date.parse("2026-11-11T12:59:59Z");
const HOUR = 3_600_000;
afterEach(() => { setSystemTime(); for (const store of stores.splice(0)) store.close(); });

function setup(chat = "owner") {
  setSystemTime(START);
  const store = new Store(":memory:");
  stores.push(store);
  store.set("route", { id: "session", generation: 1 });
  const notify = mock(async (_severity: "attention", _text: string, _key: string) => true);
  const log = mock((_chat: string, _gapMs: number) => {});
  const options = { chat, notify, log };
  const monitor = new ReplyGapMonitor(store, options);
  let sequence = 0;
  const enqueue = (gapMs = 60_001, extra: { inboundId?: string; source?: string; session?: boolean; receivedAt?: unknown; sentAt?: unknown } = {}) => {
    const id = `send:${++sequence}`;
    const inboundId = extra.inboundId ?? `input-${sequence}`;
    store.acceptInbound(inboundId, { id: inboundId, text: "PRIVATE BODY token=secret", source: extra.source ?? "typed", receivedAt: extra.receivedAt ?? Date.now() - gapMs });
    store.enqueue({ id, kind: "conversation", text: "PRIVATE REPLY", ...(extra.session === false ? {} : { sessionId: "session", generation: 1 }) }, { inboundId });
    return id;
  };
  const accept = (gapMs = 60_001, extra: Parameters<typeof enqueue>[1] = {}) => {
    const id = enqueue(gapMs, extra);
    store.outboxState(id, "sent");
    store.set(`sent-at:${id}`, extra.sentAt ?? Date.now());
    return id;
  };
  return { store, options, notify, log, monitor, accept, enqueue };
}

test("logs a real accepted reply gap and sends a content-free alert", async () => {
  const h = setup("moni");
  h.accept(90_000);
  await h.monitor.tick();
  expect(h.log.mock.calls).toEqual([["moni", 90_000]]);
  expect(h.notify.mock.calls).toEqual([["attention", "iMessage moni: a reply was accepted 90 s after the incoming message (over 60 s).", `reply-gap:moni:${START}`]]);
  expect(JSON.stringify([...h.log.mock.calls, ...h.notify.mock.calls])).not.toMatch(/PRIVATE|token|secret|input-/);
});

test("at most one Telegram per rolling hour per chat, including restart and wall-clock hour boundaries", async () => {
  const owner = setup();
  const moni = setup("moni");
  owner.accept(); moni.accept();
  await Promise.all([owner.monitor.tick(), moni.monitor.tick()]);
  setSystemTime(START + 30_000);
  for (let n = 0; n < 20; n++) owner.accept();
  const restarted = new ReplyGapMonitor(owner.store, owner.options);
  await restarted.tick();
  expect(owner.notify).toHaveBeenCalledTimes(1);
  expect(moni.notify).toHaveBeenCalledTimes(1);
  setSystemTime(START + HOUR - 1);
  owner.accept();
  await restarted.tick();
  expect(owner.notify).toHaveBeenCalledTimes(1);
  setSystemTime(START + HOUR + 30_000);
  owner.accept(120_000);
  await restarted.tick();
  expect(owner.notify).toHaveBeenCalledTimes(2);
  expect(owner.notify.mock.calls[0]![2]).not.toBe(owner.notify.mock.calls[1]![2]);
});

test("failed and uncertain Telegram attempts keep one durable key, including overlapping health checks", async () => {
  const h = setup();
  h.notify.mockImplementationOnce(async () => false);
  h.accept();
  await Promise.all([h.monitor.tick(), h.monitor.tick()]);
  setSystemTime(START + 30_000);
  h.accept(200_000);
  h.notify.mockImplementationOnce(async () => { throw new Error("offline"); });
  await expect(new ReplyGapMonitor(h.store, h.options).tick()).rejects.toThrow("offline");
  setSystemTime(START + 60_000);
  await new ReplyGapMonitor(h.store, h.options).tick();
  expect(h.notify).toHaveBeenCalledTimes(3);
  expect(new Set(h.notify.mock.calls.map(call => call[2])).size).toBe(1);
  expect(new Set(h.notify.mock.calls.map(call => call[1])).size).toBe(1);
  setSystemTime(START + 90_000);
  await h.monitor.tick();
  expect(h.notify).toHaveBeenCalledTimes(3);
});

test.each([
  ["exact threshold", 60_000, {}],
  ["under threshold", 59_999, {}],
  ["synthetic wake", 90_000, { inboundId: "wake:abc" }],
  ["secret input", 90_000, { inboundId: "secret:abc" }],
  ["reset input", 90_000, { inboundId: "reset:abc" }],
  ["composed input", 90_000, { source: "composed" }],
  ["cross-chat proactive send", 90_000, { session: false }],
  ["future inbound time", 90_000, { receivedAt: START + 1 }],
  ["malformed inbound time", 90_000, { receivedAt: "old" }],
  ["malformed sent-at", 90_000, { sentAt: "old" }],
  ["future sent-at", 90_000, { sentAt: START + 1 }],
] as const)("does not alert for %s", async (_label, gap, extra) => {
  const h = setup();
  h.accept(gap, extra);
  await h.monitor.tick();
  expect(h.notify).not.toHaveBeenCalled();
  expect(h.log).not.toHaveBeenCalled();
});

test("does not replay historical sends at installation or invent a missing causal association", async () => {
  const h = setup();
  h.accept();
  h.store.db.query("DELETE FROM kv WHERE key = 'reply-gap-cursor'").run();
  const fresh = new ReplyGapMonitor(h.store, h.options);
  await fresh.tick();
  setSystemTime(START + 30_000);
  const id = h.accept();
  h.store.db.query("DELETE FROM kv WHERE key = ?").run(`log-inbound-id:${id}`);
  await fresh.tick();
  expect(h.notify).not.toHaveBeenCalled();
});

test("groups and other person chats never alert", async () => {
  for (const chat of ["group-family-123", "person"]) {
    const h = setup(chat); h.accept(); await h.monitor.tick();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.log).not.toHaveBeenCalled();
  }
});

test("bounded batches drain without losing replies or paging once per message", async () => {
  const h = setup();
  for (let n = 0; n < 205; n++) h.accept(90_000);
  await h.monitor.tick();
  expect(h.log).toHaveBeenCalledTimes(200);
  setSystemTime(START + 30_000);
  await h.monitor.tick();
  expect(h.log).toHaveBeenCalledTimes(205);
  expect(h.notify).toHaveBeenCalledTimes(1);
});

test("actual delivery marks an attributed tool reply sent before health reports its gap", async () => {
  const h = setup();
  h.enqueue(90_000);
  const delivery = new Delivery(h.store, { sendText: async () => ({ providerId: "provider" }) }, {
    projectScope: "test", chat: "owner", enabled: () => true, chatGuid: () => "test-chat",
  });
  await h.monitor.tick();
  expect(h.notify).not.toHaveBeenCalled();
  await delivery.tick();
  setSystemTime(START + 30_000);
  await h.monitor.tick();
  expect(h.notify).toHaveBeenCalledTimes(1);
  expect(h.log.mock.calls).toEqual([["owner", 90_000]]);
});


test("real Photon voice normalization retains a measurable human reply gap", async () => {
  const h = setup();
  const owner = "+15555550123";
  const chatGuid = `iMessage;-;${owner}`;
  const address = { address: owner, service: "CHAT_SERVICE_TYPE_IMESSAGE" };
  const timestamp = new Date(START - 90_000).toISOString();
  const event = grpc.parseMessageChangeEvent({ chatGuid, occurredAt: timestamp, actor: address, isFromMe: false,
    messageReceived: { message: { guid: "voice-inbound", dateCreated: timestamp, sender: address,
      isFromMe: false, chatGuids: [chatGuid], itemType: "MESSAGE_ITEM_TYPE_NORMAL", isAudioMessage: true,
      content: { text: "Voice transcription", attachments: [] } } } }, 1);
  if (!event) throw new Error("Invalid voice fixture");
  const input = normalizeInbound(event, owner, chatGuid)!;
  expect(input).toMatchObject({ source: "composed", isAudioMessage: true });
  h.store.acceptInbound(input.id, { ...input, receivedAt: START - 90_000 });
  h.store.enqueue({ id: "voice-reply", kind: "conversation", text: "Here.", sessionId: "session", generation: 1 }, { inboundId: input.id });
  h.store.outboxState("voice-reply", "sent");
  h.store.set("sent-at:voice-reply", START);
  await h.monitor.tick();
  expect(h.notify).toHaveBeenCalledTimes(1);
  expect(h.log.mock.calls).toEqual([["owner", 90_000]]);
});

test("deleting transient KV rows cannot put a new acceptance receipt behind the cursor", async () => {
  const h = setup();
  await h.monitor.tick();
  h.accept(10_000);
  for (let n = 0; n < 100; n++) h.store.set(`transient:${n}`, true);
  setSystemTime(START + 30_000);
  await h.monitor.tick();
  h.store.db.query("DELETE FROM kv WHERE key GLOB 'transient:*'").run();
  h.accept(90_000);
  setSystemTime(START + 60_000);
  await h.monitor.tick();
  expect(h.notify).toHaveBeenCalledTimes(1);
});

test("a fold that captured the watcher source before confirmation still enqueues with its confirmed human source", async () => {
  const h = setup();
  const { createApi } = await import("../src/api.ts");
  h.store.acceptInbound("wake:root", { receivedAt: START - 120_000 });
  h.store.acceptInbound("human-during-fold", { text: "Are you there?", source: "typed", receivedAt: START - 90_000 });
  h.store.set("activeTurn", { id: "session", generation: 1, inboundId: "wake:root" });
  const api = createApi({ store: h.store, photon: { react: async () => {} }, router: () => undefined,
    chatGuid: () => "iMessage;-;+15555550123", enabled: () => true, health: () => ({}), foldText: async text => {
      h.store.attributeSteeredReplies("human-during-fold", "session", 1, 0, "wake:root");
      h.store.set("activeTurn", null);
      return text;
    } });
  const response = await api(new Request("http://bridge/send", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Here.", dedupeKey: "fold-reply", sessionId: "session" }) }));
  expect(response.status).toBe(202);
  const ack = await response.json() as { id: string };
  expect(h.store.get<string>(`log-inbound-id:${ack.id}`)).toBe("human-during-fold");
});

test.each([
  ["same root and route", "wake:root", "session", 1, true],
  ["another synthetic root", "wake:unrelated", "session", 1, false],
  ["another session", "wake:root", "other", 1, false],
  ["another generation", "wake:root", "session", 2, false],
  ["already human attribution", "other-human", "session", 1, false],
] as const)("steer reconciliation scopes repaired receipts: %s", async (_name, root, sessionId, generation, repaired) => {
  const h = setup();
  h.store.acceptInbound("human", { source: "typed", receivedAt: START - 90_000 });
  h.store.acceptInbound(root, { source: "typed", receivedAt: START - 90_000 });
  h.store.enqueue({ id: "scoped-reply", kind: "conversation", text: "Here.", sessionId, generation }, { inboundId: root });
  h.store.outboxState("scoped-reply", "sent");
  h.store.set("sent-at:scoped-reply", START);
  h.store.attributeSteeredReplies("human", "session", 1, 0, "wake:root");
  expect(h.store.get<string>("log-inbound-id:scoped-reply")).toBe(repaired ? "human" : root);
  await h.monitor.tick();
  // A genuine prior human anchor remains independently measurable; unrelated synthetic sources do not.
  expect(h.notify).toHaveBeenCalledTimes(repaired || root === "other-human" ? 1 : 0);
});
