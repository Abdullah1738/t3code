import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { GrammyError } from "grammy";
import { Delivery } from "../src/delivery.ts";
import { Store, type OutboxRecord } from "../src/store.ts";
import { TransportError } from "../src/telegram.ts";

type Send = { chatId: number; text: string; replyTo?: number; keyboard?: unknown };
type Document = { chatId: number; name: string; mimeType: string; data: Uint8Array; replyTo?: number };

const now = Date.parse("2026-09-10T12:00:00Z");
const stores: Store[] = [];

function setup(behavior?: (calls: { sends: Send[]; documents: Document[] }) => void) {
  setSystemTime(now);
  const store = new Store(":memory:");
  stores.push(store);
  const calls = { sends: [] as Send[], documents: [] as Document[] };
  let nextId = 900;
  const transport = {
    async sendMessage(input: { chatId: number; text: string; replyTo?: number; keyboard?: unknown }) {
      calls.sends.push(input);
      behavior?.(calls);
      return { providerId: ++nextId };
    },
    async sendDocument(input: { chatId: number; data: Uint8Array; name: string; mimeType: string; replyTo?: number }) {
      calls.documents.push(input);
      behavior?.(calls);
      return { providerId: ++nextId };
    },
  };
  const readiness = { enabled: true, chatId: 100 as number | undefined };
  const delivery = new Delivery(store, transport, {
    chatId: () => readiness.chatId,
    enabled: () => readiness.enabled,
    sleep: async () => {},
    log: () => {},
  });
  return { store, transport, calls, readiness, delivery, nextId: () => ++nextId };
}

afterEach(() => {
  setSystemTime();
  for (const store of stores.splice(0)) store.close();
});

test("sends single messages once, records the provider id, and marks the operation sent", async () => {
  const h = setup();
  h.store.enqueue({ id: "op", kind: "notification", text: "hello" });
  await h.delivery.tick();
  expect(h.calls.sends).toEqual([{ chatId: 100, text: "hello" }]);
  expect(h.store.getOperation("op")).toMatchObject({ state: "sent", attempts: 1, providerId: 901 });
  expect(h.store.get<number>("deliveryChat:op")).toBe(100);
  expect(h.store.get<boolean>("sendAmbiguous:op")).toBe(false);
});

test("chunks long messages at 3900 characters, threads replies, and paces 800ms between sends", async () => {
  const sleeps: number[] = [];
  const h = setup();
  h.delivery = new Delivery(h.store, h.transport, {
    chatId: () => h.readiness.chatId,
    enabled: () => h.readiness.enabled,
    sleep: async ms => { sleeps.push(ms); },
    log: () => {},
  });
  const text = "x".repeat(7_800 + 5);
  h.store.enqueue({ id: "op", kind: "notification", text });
  await h.delivery.tick();
  expect(h.calls.sends).toHaveLength(3);
  expect(h.calls.sends.map(send => send.text.length)).toEqual([3_900, 3_900, 5]);
  expect(h.calls.sends[0]).toEqual({ chatId: 100, text: "x".repeat(3_900) });
  expect(h.calls.sends[1]!.replyTo).toBe(901);
  expect(h.calls.sends[2]!.replyTo).toBe(902);
  expect(h.store.getOperation("op")).toMatchObject({ state: "sent", providerId: 901 });
  expect(sleeps).toEqual([800, 800, 800]);
});

test("keyboards ride the final chunk only and reply targets survive across chunks", async () => {
  const h = setup();
  const keyboard = { rows: [[{ text: "Approve once", data: "a:tok:once" }]] };
  h.store.enqueue({ id: "op", kind: "control", text: "x".repeat(4_000), keyboard });
  await h.delivery.tick();
  expect(h.calls.sends).toHaveLength(2);
  expect(h.calls.sends[0]!.keyboard).toBeUndefined();
  expect(h.calls.sends[1]!.keyboard).toEqual(keyboard);
  expect(h.store.getOperation("op")?.state).toBe("sent");
});

test("attachments send after all text chunks, as documents bound to the last chunk reply", async () => {
  const h = setup();
  const data = Buffer.from("PRIVATE_ATTACHMENT");
  const sha256 = h.store.putBlob(data);
  h.store.enqueue({ id: "op", kind: "notification", text: "x".repeat(4_000), attachment:
    { sha256, name: "report.pdf", mimeType: "application/pdf", size: data.length } });
  await h.delivery.tick();
  expect(h.calls.sends.map(send => send.text.length)).toEqual([3_900, 100]);
  expect(h.calls.documents.map(doc => ({ ...doc, data: Buffer.from(doc.data).toString("hex") })))
    .toEqual([{ chatId: 100, name: "report.pdf", mimeType: "application/pdf", data: data.toString("hex"), replyTo: 902 }]);
  expect(h.store.getOperation("op")).toMatchObject({ state: "sent", providerId: 901 });
});

test("empty content is rejected permanently without any transport call", async () => {
  const h = setup();
  h.store.enqueue({ id: "op", kind: "notification", text: "  " });
  await h.delivery.tick();
  expect(h.calls.sends).toEqual([]);
  expect(h.store.getOperation("op")).toMatchObject({ state: "failed", attempts: 0 });
  expect(h.delivery.status()).toEqual({ lastError: "emptyContent" });
});

test("retryable failures keep the operation pending with an exponential retry delay", async () => {
  const h = setup();
  h.store.enqueue({ id: "op", kind: "notification", text: "hello" });
  h.transport.sendMessage = async (input: Send) => {
    h.calls.sends.push(input);
    throw new TransportError("telegramNetwork", true, true);
  };
  await h.delivery.tick();
  expect(h.calls.sends).toHaveLength(1);
  expect(h.store.getOperation("op")).toMatchObject({ state: "pending", attempts: 1 });
  expect(h.store.get<boolean>("sendAmbiguous:op")).toBe(true);
  expect(h.store.get<number>("retry:op")).toBe(now + 10_000);
  // The scheduled retry is honored; advancing the clock releases it.
  await h.delivery.tick();
  expect(h.calls.sends).toHaveLength(1);
  setSystemTime(now + 10_001);
  await h.delivery.tick();
  expect(h.calls.sends).toHaveLength(2);
  expect(h.store.getOperation("op")).toMatchObject({ state: "pending", attempts: 2 });
  expect(h.store.get<number>("retry:op")).toBe(now + 10_001 + 20_000);
});

test("floodWait schedules its retry from the server-provided retry_after", async () => {
  const h = setup();
  h.store.enqueue({ id: "op", kind: "notification", text: "hello" });
  h.transport.sendMessage = async () => {
    throw new GrammyError("flood", { ok: false, error_code: 429, description: "Too Many Requests",
      parameters: { retry_after: 30 } }, "sendMessage", {});
  };
  await h.delivery.tick();
  expect(h.store.getOperation("op")).toMatchObject({ state: "pending", attempts: 1 });
  expect(h.store.get<number>("retry:op")).toBe(now + 30_500);
  expect(h.delivery.status()).toEqual({ lastError: "floodWait" });
});

test("permanent 4xx failures are terminal and never ambiguous", async () => {
  const h = setup();
  h.store.enqueue({ id: "op", kind: "notification", text: "hello" });
  h.transport.sendMessage = async () => {
    throw new GrammyError("bad", { ok: false, error_code: 400, description: "Bad Request" }, "sendMessage", {});
  };
  await h.delivery.tick();
  expect(h.store.getOperation("op")).toMatchObject({ state: "failed", attempts: 1 });
  expect(h.store.get<boolean>("sendAmbiguous:op")).toBe(false);
  expect(h.delivery.status()).toEqual({ lastError: "telegramHttp400" });
});

test("ambiguous failures stop retrying only at the attempt cap and record uncertainty", async () => {
  const h = setup();
  h.store.enqueue({ id: "op", kind: "notification", text: "hello" });
  h.transport.sendMessage = async () => { throw new TransportError("telegramHttp502", true, true); };
  for (let round = 0; round < 4; round++) {
    setSystemTime(now + round * 600_000);
    await h.delivery.tick();
    expect(h.store.getOperation("op")).toMatchObject({ state: "pending", attempts: round + 1 });
  }
  // The fifth attempt is terminal: the cap applies while the failure is ambiguous.
  setSystemTime(now + 4 * 600_000);
  await h.delivery.tick();
  expect(h.store.getOperation("op")).toMatchObject({ state: "uncertain", attempts: 5 });
  expect(h.delivery.status()).toEqual({ lastError: "telegramHttp502" });
});

test("the 24h retry window expires uncertain operations instead of looping forever", async () => {
  const h = setup();
  h.store.enqueue({ id: "op", kind: "notification", text: "hello" });
  h.store.set("firstAttempt:op", now - 24 * 60 * 60 * 1_000 - 1);
  await h.delivery.tick();
  expect(h.calls.sends).toEqual([]);
  expect(h.store.getOperation("op")).toMatchObject({ state: "uncertain", attempts: 0 });
  expect(h.delivery.status()).toEqual({ lastError: "retryWindowExpired" });
});

test("recover() requeues uncertain operations only inside the retry window and below the cap", () => {
  const h = setup();
  h.store.enqueue({ id: "fresh", kind: "notification", text: "a" });
  h.store.enqueue({ id: "expired", kind: "notification", text: "b" });
  h.store.enqueue({ id: "capped", kind: "notification", text: "c" });
  h.store.set("firstAttempt:fresh", now - 60_000);
  h.store.set("firstAttempt:expired", now - 24 * 60 * 60 * 1_000 - 1);
  for (const id of ["fresh", "expired", "capped"]) h.store.outboxState(id, "uncertain");
  for (let i = 0; i < 5; i++) h.store.outboxState("capped", "pending"), h.store.outboxState("capped", "sending");
  h.store.outboxState("capped", "uncertain");
  h.delivery.recover();
  expect(h.store.getOperation("fresh")?.state).toBe("pending");
  expect(h.store.getOperation("expired")?.state).toBe("uncertain");
  expect(h.store.getOperation("capped")?.state).toBe("uncertain");
});

test("checkpointed chunks skip ahead after a crash without resending or re-attempting", async () => {
  const h = setup();
  h.store.enqueue({ id: "op", kind: "notification", text: "x".repeat(7_801) });
  // Simulate a crash after the first chunk was accepted.
  h.store.outboxState("op", "sending");
  h.store.set("firstAttempt:op", now);
  h.store.set("deliveryChat:op", 100);
  h.store.set("sendAmbiguous:op", true);
  h.store.set("chunk:op:0", { accepted: true, providerId: 901 });
  h.store.outboxState("op", "uncertain");
  h.delivery.recover();
  await h.delivery.tick();
  expect(h.calls.sends.map(send => send.text.length)).toEqual([3_900, 1]);
  expect(h.calls.sends[0]!.replyTo).toBe(901);
  expect(h.store.getOperation("op")).toMatchObject({ state: "sent", attempts: 2, providerId: 901 });
});

test("a destination change after queuing freezes the operation as uncertain", async () => {
  const h = setup();
  h.store.enqueue({ id: "op", kind: "notification", text: "hello" });
  h.store.set("deliveryChat:op", 200);
  await h.delivery.tick();
  expect(h.calls.sends).toEqual([]);
  expect(h.store.getOperation("op")).toMatchObject({ state: "uncertain" });
  expect(h.delivery.status()).toEqual({ lastError: "chatChanged" });
});

test("beforeSend gates every dispatch: wait holds, cancel terminates, send proceeds", async () => {
  const h = setup();
  const decisions = ["wait", "cancel"] as const;
  let index = 0;
  const delivery = new Delivery(h.store, h.transport, {
    chatId: () => h.readiness.chatId,
    enabled: () => h.readiness.enabled,
    beforeSend: async () => decisions[index++] ?? "send",
    sleep: async () => {},
    log: () => {},
  });
  h.store.enqueue({ id: "held", kind: "notification", text: "held" });
  h.store.enqueue({ id: "cancelled", kind: "notification", text: "cancelled" });
  await delivery.tick();
  expect(h.calls.sends).toEqual([]);
  expect(h.store.getOperation("held")).toMatchObject({ state: "pending", attempts: 0 });
  expect(h.store.getOperation("cancelled")).toMatchObject({ state: "cancelled", attempts: 0 });
});

test("readiness loss pauses mid-chunk with a durable checkpoint and resumes in order", async () => {
  let h: ReturnType<typeof setup>;
  let tripped = false;
  h = setup(calls => { if (!tripped && calls.sends.length >= 1) { tripped = true; h.readiness.enabled = false; } });
  h.store.enqueue({ id: "op", kind: "notification", text: "x".repeat(7_801) });
  await h.delivery.tick();
  expect(h.calls.sends).toHaveLength(1);
  expect(h.store.getOperation("op")).toMatchObject({ state: "pending", attempts: 1 });
  h.readiness.enabled = true;
  await h.delivery.tick();
  expect(h.calls.sends).toHaveLength(3);
  expect(h.calls.sends[1]!.replyTo).toBe(901);
  expect(h.store.getOperation("op")).toMatchObject({ state: "sent", providerId: 901 });
});

test("at most 10 fresh operations dispatch per tick; already-sending items finish first", async () => {
  const h = setup();
  for (let i = 0; i < 12; i++) h.store.enqueue({ id: `op-${i}`, kind: "notification", text: `m${i}` });
  await h.delivery.tick();
  const sent = h.calls.sends.map(send => send.text);
  expect(sent).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"]);
  await h.delivery.tick();
  expect(h.calls.sends).toHaveLength(12);
});

test("provider alias conflicts abort the run, keep the checkpoint unset, and stay ambiguous", async () => {
  const h = setup();
  h.store.enqueue({ id: "first", kind: "notification", text: "a" });
  await h.delivery.tick();
  expect(h.store.getOperation("first")).toMatchObject({ state: "sent", providerId: 901 });
  // Force the transport to hand back an already-aliased provider id.
  let next = 901;
  h.transport.sendMessage = async (input: Send) => {
    h.calls.sends.push(input);
    return { providerId: next };
  };
  h.store.enqueue({ id: "second", kind: "notification", text: "b" });
  await expect(h.delivery.tick()).rejects.toThrow();
  expect(h.calls.sends.map(send => send.text)).toEqual(["a", "b"]);
  expect(h.store.getOperation("second")).toMatchObject({ state: "sending", attempts: 1 });
  expect(h.store.get<boolean>("sendAmbiguous:second")).toBe(true);
  expect(h.store.get("chunk:second:0")).toBeUndefined();
  expect(h.store.get<string>("provider-operation:901")).toBe("first");
  // The next startup reopens 'sending' as uncertain; recovery requeues it at-least-once.
  h.store.outboxState("second", "uncertain");
  h.delivery.recover();
  expect(h.store.getOperation("second")?.state).toBe("pending");
});

test("concurrent tick calls are coalesced into a single run", async () => {
  const h = setup();
  h.store.enqueue({ id: "op", kind: "notification", text: "hello" });
  const runs = await Promise.all([h.delivery.tick(), h.delivery.tick(), h.delivery.tick()]);
  expect(runs).toHaveLength(3);
  expect(h.calls.sends).toHaveLength(1);
  expect(h.store.getOperation("op")).toMatchObject({ state: "sent" });
});

test("operations enqueued with a providerId resume their identity instead of resending", async () => {
  const h = setup();
  const record = h.store.getOperation("op");
  void record;
  h.store.enqueue({ id: "op", kind: "notification", text: "hello" });
  const before: OutboxRecord | undefined = h.store.getOperation("op");
  expect(before).toBeDefined();
  h.readiness.chatId = undefined;
  await h.delivery.tick();
  expect(h.calls.sends).toEqual([]);
  expect(h.store.getOperation("op")).toMatchObject({ state: "pending", attempts: 0 });
  h.readiness.chatId = 100;
  await h.delivery.tick();
  expect(h.calls.sends).toHaveLength(1);
});
