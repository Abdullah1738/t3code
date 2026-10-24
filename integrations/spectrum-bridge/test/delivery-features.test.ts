import { afterEach, expect, mock, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import * as grpc from "@photon-ai/advanced-imessage/grpc";
import { Delivery } from "../src/delivery.ts";
import type { Photon, PollResult, SendResult } from "../src/photon.ts";
import { Store, type OutboxOperation } from "../src/store.ts";

const stores: Store[] = [];
const chatGuid = "any;-;+15555550123";
const projectScope = "test-project-scope";
const now = Date.parse("2026-09-10T12:00:00Z");
type TextInput = Parameters<Photon["sendText"]>[0];
type PollInput = Parameters<Photon["sendPoll"]>[0];
type AppInput = Parameters<Photon["sendApp"]>[0];
const plainId = (id: string, chunk: number) =>
  `bridge-${createHash("sha256").update(`${projectScope}:${id}:${chunk}:plain`).digest("hex")}`;
const stableId = (id: string, chunk: number) =>
  `bridge-${createHash("sha256").update(`${projectScope}:${id}:${chunk}`).digest("hex")}`;

function setup() {
  setSystemTime(now);
  const store = new Store(":memory:");
  stores.push(store);
  const texts: TextInput[] = [];
  const polls: PollInput[] = [];
  const apps: AppInput[] = [];
  const transport = {
    sendText: mock(async (input: TextInput): Promise<SendResult> => {
      texts.push({ ...input });
      return { providerId: `text-${texts.length}` };
    }),
    sendPoll: mock(async (input: PollInput): Promise<PollResult> => {
      expect(Object.isFrozen(input)).toBe(true);
      polls.push({ ...input });
      return { providerId: "poll-guid", options: input.options.map((text, i) => ({ optionIdentifier: `opt-${i}`, text })) };
    }),
    sendApp: mock(async (input: AppInput): Promise<SendResult> => {
      apps.push({ ...input });
      return { providerId: "app-guid" };
    }),
  };
  const log = mock((_event: string, _code?: string) => {});
  const options = { projectScope, enabled: () => true, chatGuid: () => chatGuid, log, sleep: async () => {} };
  const delivery = new Delivery(store, transport, options);
  const enqueue = (id: string, extra: Partial<OutboxOperation>) => store.enqueue({ id, kind: "conversation", text: "", ...extra });
  return { store, texts, polls, apps, transport, log, options, delivery, enqueue };
}

afterEach(() => {
  setSystemTime();
  for (const store of stores.splice(0)) store.close();
});

test("markdown is stripped into native formatting and only a bare URL enables a preview", async () => {
  const h = setup();
  h.enqueue("md", { text: "**Done**: see https://x.test/a_b and *note*" });
  h.enqueue("plain", { text: "no markup" });
  h.enqueue("link", { text: "  https://x.test/a_b  " });
  await h.delivery.tick();
  expect(h.texts).toEqual([
    { id: stableId("md", 0), chatGuid, text: "Done: see https://x.test/a_b and note",
      formatting: [{ type: "bold", start: 0, length: 4 }, { type: "italic", start: 33, length: 4 }] },
    { id: stableId("plain", 0), chatGuid, text: "no markup" },
    { id: stableId("link", 0), chatGuid, text: "https://x.test/a_b", enableLinkPreview: true },
  ]);
});

test("a definite rejection of rich options still delivers the plain text under its own id", async () => {
  const h = setup();
  let calls = 0;
  h.transport.sendText.mockImplementation(async (input: TextInput): Promise<SendResult> => {
    calls++;
    h.texts.push({ ...input });
    if (input.formatting) throw new grpc.IMessageError("rejected", { code: "internalError", grpcCode: 3, retryable: false });
    return { providerId: "plain-guid" };
  });
  h.enqueue("rich", { text: "**Done** see the doc" });
  await h.delivery.tick();
  expect(calls).toBe(2);
  expect(h.texts[0]!.id).toBe(stableId("rich", 0));
  expect(h.texts[1]).toEqual({ id: plainId("rich", 0), retryOf: stableId("rich", 0), chatGuid, text: "Done see the doc" });
  expect(h.store.getOperation("rich")).toMatchObject({ state: "sent", providerId: "plain-guid" });
  expect(h.log).toHaveBeenCalledWith("outbound-plain-fallback", "internalError");
});

test.each([
  ["a lost response", 14],
  ["a rate limit", 8],
  ["a missing chat", 5],
])("%s on a rich send is never retried as plain text", async (_label, grpcCode) => {
  const h = setup();
  h.transport.sendText.mockImplementation(async (input: TextInput): Promise<SendResult> => {
    h.texts.push({ ...input });
    throw new grpc.IMessageError("nope", { code: "internalError", grpcCode, retryable: false });
  });
  h.enqueue("rich", { text: "**Done**" });
  await h.delivery.tick();
  expect(h.texts).toHaveLength(1);
  expect(h.log).not.toHaveBeenCalledWith("outbound-plain-fallback", expect.anything());
});

test("a plain fallback that is itself lost stays retryable and replays only the plain copy", async () => {
  const h = setup();
  let plainLost = true;
  h.transport.sendText.mockImplementation(async (input: TextInput): Promise<SendResult> => {
    h.texts.push({ ...input });
    if (input.formatting) {
      // A provider that reserved the rejected id would report the rich replay as a duplicate.
      if (!plainLost) return { duplicate: true };
      throw new grpc.IMessageError("rejected", { code: "internalError", grpcCode: 3, retryable: false });
    }
    if (plainLost) { plainLost = false; throw new grpc.IMessageError("lost", { code: "internalError", grpcCode: 14, retryable: false }); }
    return { providerId: "plain-guid" };
  });
  h.enqueue("rich", { text: "**Done**" });
  await h.delivery.tick();
  expect(h.store.getOperation("rich")).toMatchObject({ state: "pending" });
  expect(h.store.get<boolean>("sendAmbiguous:rich")).toBe(true);
  setSystemTime(now + 60_000);
  await h.delivery.tick();
  expect(h.texts.map(call => call.id)).toEqual([stableId("rich", 0), plainId("rich", 0), plainId("rich", 0)]);
  expect(h.store.getOperation("rich")).toMatchObject({ state: "sent", providerId: "plain-guid" });
});

test("a plain fallback is skipped once the reply was retired mid-send", async () => {
  const h = setup();
  h.store.set("route", { id: "ses_1", directory: "/d", generation: 1 });
  h.transport.sendText.mockImplementation(async (input: TextInput): Promise<SendResult> => {
    h.texts.push({ ...input });
    h.store.set("route", { id: "ses_2", directory: "/d", generation: 2 });
    throw new grpc.IMessageError("rejected", { code: "internalError", grpcCode: 3, retryable: false });
  });
  h.enqueue("rich", { text: "**Done**", sessionId: "ses_1", generation: 1 });
  await h.delivery.tick();
  expect(h.texts).toHaveLength(1);
});

test("chunks are split after stripping, keep stable ids, and carry clipped ranges", async () => {
  const h = setup();
  const text = "**" + "x".repeat(3_600) + "** https://x.test";
  h.enqueue("long", { text, effect: "confetti", subject: "Report", replyTo: "parent" });
  await h.delivery.tick();
  expect(h.texts.map(call => call.id)).toEqual([stableId("long", 0), stableId("long", 1)]);
  expect(h.texts.map(call => call.text).join("")).toBe("x".repeat(3_600) + " https://x.test");
  expect(Array.from(h.texts[0]!.text)).toHaveLength(3_500);
  expect(h.texts[0]).toMatchObject({ formatting: [{ type: "bold", start: 0, length: 3_500 }], effect: "confetti", subject: "Report", replyTo: "parent" });
  expect(h.texts[0]!.enableLinkPreview).toBeUndefined();
  expect(h.texts[1]).toEqual({ id: stableId("long", 1), chatGuid, replyTo: "parent", text: "x".repeat(100) + " https://x.test",
    formatting: [{ type: "bold", start: 0, length: 100 }] });
  expect(h.store.getOperation("long")).toMatchObject({ state: "sent", providerId: "text-1" });
});

test("an unknown stored effect fails the operation without sending", async () => {
  const h = setup();
  h.enqueue("bad", { text: "x", effect: "rainbow" });
  h.enqueue("mixed", { poll: { title: "t", options: ["a", "b"] }, app: { url: "https://x.test", caption: "c" } });
  await h.delivery.tick();
  expect(h.store.getOperation("bad")).toMatchObject({ state: "failed", attempts: 0 });
  expect(h.store.getOperation("mixed")).toMatchObject({ state: "failed", attempts: 0 });
  expect(h.transport.sendText).not.toHaveBeenCalled();
  expect(h.transport.sendPoll).not.toHaveBeenCalled();
  expect(h.log.mock.calls).toEqual([["outbound-failed", "invalidContent"], ["outbound-failed", "invalidContent"]]);
});

test("polls send once, register their options, and alias the poll GUID atomically", async () => {
  const h = setup();
  h.store.set("route", { id: "ses", generation: 3 });
  h.enqueue("poll-op", { poll: { title: "Lunch?", options: ["Pizza", "Sushi"] }, sessionId: "ses", generation: 3 });
  h.store.set("poll-seen:poll-guid", { options: [], at: now });
  await h.delivery.tick();
  expect(h.store.get<unknown>("poll-seen:poll-guid")).toBeUndefined();
  expect(h.polls).toEqual([{ id: stableId("poll-op", 0), chatGuid, title: "Lunch?", options: ["Pizza", "Sushi"] }]);
  expect(h.transport.sendText).not.toHaveBeenCalled();
  expect(h.store.get<unknown>("poll:poll-guid")).toEqual({ operationId: "poll-op", title: "Lunch?",
    options: [{ optionIdentifier: "opt-0", text: "Pizza" }, { optionIdentifier: "opt-1", text: "Sushi" }],
    sessionId: "ses", generation: 3, createdAt: now });
  expect(h.store.get<unknown>("provider-operation:poll-guid")).toBe("poll-op");
  expect(h.store.getOperation("poll-op")).toMatchObject({ state: "sent", providerId: "poll-guid", attempts: 1 });
  await h.delivery.tick();
  expect(h.transport.sendPoll).toHaveBeenCalledTimes(1);
});

test("a duplicate poll acceptance without a GUID registers nothing", async () => {
  const h = setup();
  h.transport.sendPoll.mockResolvedValueOnce({ duplicate: true });
  h.enqueue("poll-op", { poll: { title: "Q", options: ["a", "b"] } });
  await h.delivery.tick();
  expect(h.store.getOperation("poll-op")?.state).toBe("sent");
  expect(h.store.db.query("SELECT key FROM kv WHERE key LIKE 'poll:%'").all()).toEqual([]);
  expect(h.store.get<{ operationId: string; choices: string[] }>("poll-unmatched:poll-op")).toMatchObject({ operationId: "poll-op", title: "Q", choices: ["a", "b"] });
});

test("stale poll and app generations are cancelled before sending", async () => {
  const h = setup();
  h.store.set("route", { id: "ses", generation: 4 });
  h.enqueue("poll-old", { poll: { title: "Q", options: ["a", "b"] }, sessionId: "ses", generation: 3 });
  h.enqueue("app-old", { app: { url: "https://x.test", caption: "c" }, sessionId: "other", generation: 4 });
  await h.delivery.tick();
  expect(h.store.getOperation("poll-old")?.state).toBe("cancelled");
  expect(h.store.getOperation("app-old")?.state).toBe("cancelled");
  expect(h.transport.sendPoll).not.toHaveBeenCalled();
  expect(h.transport.sendApp).not.toHaveBeenCalled();
});

test("app cards send once with their layout; an accompanying text goes first", async () => {
  const h = setup();
  const app = { url: "https://apps.test/tracker/", caption: "Tracker", subcaption: "Today", summary: "Open" };
  h.enqueue("app-op", { text: "Here it is", app });
  await h.delivery.tick();
  expect(h.texts.map(call => call.id)).toEqual([stableId("app-op", 0)]);
  expect(h.apps).toEqual([{ id: stableId("app-op", 1), chatGuid, ...app }]);
  expect(h.store.getOperation("app-op")).toMatchObject({ state: "sent", providerId: "text-1" });
  expect(h.store.get<unknown>("provider-operation:app-guid")).toBe("app-op");
  expect(h.store.db.query("SELECT key FROM kv WHERE key LIKE 'poll:%'").all()).toEqual([]);
});

test("leaked DCP metadata is stripped from texts and app cards before sending", async () => {
  const h = setup();
  h.enqueue("reply", { text: "All set, mail me at a@b.test.\n\n@162@" });
  h.enqueue("app-op", { text: "@b7@", app: { url: "https://apps.test/x/", caption: "Tracker @b7@", summary: "@blocked@" } });
  await h.delivery.tick();
  expect(h.texts.map(call => call.text)).toEqual(["All set, mail me at a@b.test."]);
  expect(h.apps).toEqual([{ id: stableId("app-op", 0), chatGuid, url: "https://apps.test/x/", caption: "Tracker" }]);
  expect(h.store.getOperation("reply")?.state).toBe("sent");
  expect(h.store.getOperation("app-op")?.state).toBe("sent");
});

test("a message that is empty after sanitizing is skipped and logged, never sent", async () => {
  const h = setup();
  h.enqueue("ids", { text: "@162@\n\n<dcp-system-reminder>compress</dcp-system-reminder>" });
  h.enqueue("card", { app: { url: "https://apps.test/x/", caption: "@b7@" } });
  h.enqueue("real", { text: "Still here" });
  await h.delivery.tick();
  expect(h.texts.map(call => call.text)).toEqual(["Still here"]);
  expect(h.transport.sendApp).not.toHaveBeenCalled();
  expect(h.store.getOperation("ids")).toMatchObject({ state: "cancelled", attempts: 0 });
  expect(h.store.getOperation("card")).toMatchObject({ state: "cancelled", attempts: 0 });
  expect(h.log.mock.calls.filter(([event]) => event === "outbound-skipped"))
    .toEqual([["outbound-skipped", "emptyAfterSanitize"], ["outbound-skipped", "emptyAfterSanitize"]]);
});

test("missing sendPoll or sendApp fails as unsupported", async () => {
  const h = setup();
  h.enqueue("poll-op", { poll: { title: "Q", options: ["a", "b"] } });
  h.enqueue("app-op", { app: { url: "https://x.test", caption: "c" } });
  await new Delivery(h.store, { sendText: h.transport.sendText }, h.options).tick();
  expect(h.store.getOperation("poll-op")?.state).toBe("failed");
  expect(h.store.getOperation("app-op")?.state).toBe("failed");
  expect(h.log.mock.calls).toEqual([["outbound-failed", "unsupported"], ["outbound-failed", "unsupported"]]);
});

test("store normalizes and compares effect, subject, poll, and app content", () => {
  const h = setup();
  const op: OutboxOperation = { id: "op", kind: "conversation", text: "t", effect: "loud", subject: "s",
    poll: { title: "Q", options: ["a", "b"] } };
  expect(h.store.enqueue(op)).toBe(true);
  expect(h.store.enqueue({ poll: { options: ["a", "b"], title: "Q" }, subject: "s", effect: "loud", text: "t", kind: "conversation", id: "op" })).toBe(false);
  for (const change of [{ effect: "slam" }, { subject: "other" }, { effect: undefined }, { poll: { title: "Q", options: ["a", "c"] } },
    { app: { url: "https://x.test", caption: "c" } }]) {
    expect(() => h.store.enqueue({ ...op, ...change })).toThrow("content mismatch");
  }
  const app: OutboxOperation = { id: "app", kind: "conversation", text: "", app: { url: "https://x.test", caption: "c", summary: "s" } };
  expect(h.store.enqueue(app)).toBe(true);
  expect(() => h.store.enqueue({ ...app, app: { url: "https://x.test", caption: "c" } })).toThrow("content mismatch");
  expect(h.store.getOperation("app")).toMatchObject({ app: { url: "https://x.test", caption: "c", summary: "s" } });
});
