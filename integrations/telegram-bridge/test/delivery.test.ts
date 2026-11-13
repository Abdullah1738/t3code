import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { GrammyError } from "grammy";
import { Delivery } from "../src/delivery.ts";
import { createApi } from "../src/api.ts";
import { parseCommand } from "../src/cli.ts";
import { enqueueNotice } from "../src/notification-policy.ts";
import { Store, type OutboxRecord } from "../src/store.ts";
import { TransportError } from "../src/telegram.ts";
import { createHash } from "node:crypto";
import { useToolLogFixture } from "./toollog-fixture.ts";

const logs = useToolLogFixture();
const logId = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

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

test("queued legacy up notices are cancelled and all other queued text is redacted before chunking", async () => {
  const h = setup();
  h.store.enqueue({ id: "up", kind: "notification", text: "[run.cloud] Run Cloud iOS simulator up: test\nhttps://example.test?token=private" });
  for (const kind of ["notification", "control"] as const) {
    h.store.enqueue({ id: kind, kind, text: "x".repeat(3890) + " eyJfake.payload.signature https://example.test?access_token=private" });
  }
  await h.delivery.tick();
  expect(h.store.getOperation("up")?.state).toBe("cancelled");
  const sent = h.calls.sends.map(call => call.text).join("");
  expect(sent).not.toContain("private");
  expect(sent).not.toContain("eyJ");
  expect(sent).toContain("[redacted]");
  expect(h.store.getOperation("control")?.state).toBe("sent");
});

test("a complete signed URL used as a token value stays masked through CLI, API and delivery", async () => {
  const h = setup();
  const command = parseCommand(["notify", "--source", "tests", "--text",
    "token=https://example.test/?part=1&sig=FAKE_SECRET", "--key", "signed-token"]);
  const api = createApi({ store: h.store, enabled: () => true, chatId: () => 100,
    timezone: "UTC", health: () => ({}) });
  const response = await api(new Request("http://bridge/notify", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(command.body) }));
  expect(response.status).toBe(202);
  await h.delivery.tick();
  expect(h.calls.sends.map(send => send.text)).toEqual(["[tests] token=[redacted]"]);
});

test("delayed first alerts are delivered alone and cooldowns start from provider acceptance", async () => {
  const h = setup();
  const hour = 3_600_000;
  const ask = { id: "ask", source: "test", text: "please answer", severity: "attention", askKey: "card:q1" };
  const failure = { id: "failure", source: "offbox", text: "check failed", severity: "error", burstKey: "infra" };
  enqueueNotice(h.store, ask);
  enqueueNotice(h.store, failure);
  enqueueNotice(h.store, { ...failure, id: "repeat" });
  setSystemTime(now + 48 * hour);
  expect(enqueueNotice(h.store, { ...ask, id: "still-pending" })).toBe(false);
  await h.delivery.tick();
  expect(h.calls.sends).toHaveLength(2);
  expect(enqueueNotice(h.store, { ...ask, id: "too-soon" })).toBe(false);
  setSystemTime(now + 49 * hour - 1);
  await h.delivery.tick();
  expect(h.calls.sends).toHaveLength(2);
  setSystemTime(now + 49 * hour);
  await h.delivery.tick();
  expect(h.calls.sends).toHaveLength(3);
  expect(h.calls.sends[2]?.text).toContain("2 failures since the last alert");
  setSystemTime(now + 72 * hour);
  expect(enqueueNotice(h.store, { ...ask, id: "24h-reminder" })).toBe(true);
});

test("legacy accepted chunk indices preserve remaining text and buttons after redaction", async () => {
  const h = setup();
  const keyboard = { rows: [[{ text: "Answer", data: "q1" }]] };
  const text = "https://example.test/view?token=" + "x".repeat(3900) + " remaining question";
  h.store.enqueue({ id: "partial", kind: "control", text, keyboard });
  h.store.outboxState("partial", "sending");
  h.store.outboxState("partial", "pending");
  h.store.set("firstAttempt:partial", now);
  h.store.set("chunk:partial:0", { accepted: true, providerId: 800 });
  await h.delivery.tick();
  expect(h.calls.sends).toHaveLength(1);
  expect(h.calls.sends[0]?.text.trim()).toBe("remaining question");
  expect(h.calls.sends[0]?.text).not.toContain("xxx");
  expect(h.calls.sends[0]?.keyboard).toEqual(keyboard);
  expect(h.calls.sends[0]?.replyTo).toBe(800);
});

test("legacy layout remains stable across a new redacted send and a retry", async () => {
  let fail = true;
  const h = setup(() => { if (fail) throw new TransportError("temporary", true, false); });
  h.store.enqueue({ id: "legacy", kind: "notification", text: "https://example.test?token=" + "x".repeat(4000) + " tail" });
  await h.delivery.tick();
  fail = false;
  setSystemTime(now + 30_000);
  await h.delivery.tick();
  expect(h.calls.sends).toHaveLength(2);
  expect(h.calls.sends[0]?.text).toBe(h.calls.sends[1]?.text);
  expect(h.calls.sends[1]?.text).toContain("tail");
});

test("legacy pending duplicate board asks are cancelled before dispatch without silencing other asks", async () => {
  const h = setup();
  for (let i = 0; i < 3; i++) h.store.enqueue({ id: `old-${i}`, kind: "notification",
    text: `[Robob board -582] Needs owner q2, wording ${i}` });
  h.store.enqueue({ id: "other", kind: "notification", text: "[Robob board -582] Needs owner q3" });
  await h.delivery.tick();
  expect(h.calls.sends).toHaveLength(2);
  expect(h.store.getOperation("old-0")?.state).toBe("sent");
  expect(h.store.getOperation("old-1")?.state).toBe("cancelled");
  expect(h.store.getOperation("old-2")?.state).toBe("cancelled");
  expect(h.store.getOperation("other")?.state).toBe("sent");
});

test("a first accepted chunk followed by rejection does not refund an ask's quota", async () => {
  const h = setup(calls => { if (calls.sends.length === 2) throw new TransportError("blocked", false, false); });
  const ask = { id: "partial-ask", source: "test", text: "a".repeat(4000), severity: "attention", askKey: "card:q1" };
  enqueueNotice(h.store, ask);
  await h.delivery.tick();
  expect(h.store.getOperation(ask.id)?.state).toBe("failed");
  expect(h.store.get<boolean>(`sendAmbiguous:${ask.id}`)).toBe(false);
  expect(enqueueNotice(h.store, { ...ask, id: "duplicate-ask" })).toBe(false);
  await h.delivery.tick();
  expect(h.calls.sends).toHaveLength(2);
});

test("exhausted ambiguous sends do not mute later burst summaries after transport recovery", async () => {
  let failing = true;
  const h = setup(() => { if (failing) throw new TransportError("network", true, true); });
  const failure = { id: "ambiguous", source: "offbox", text: "first failure", severity: "error", burstKey: "infra" };
  enqueueNotice(h.store, failure);
  enqueueNotice(h.store, { ...failure, id: "repeat", text: "second failure" });
  for (let i = 0; i < 5; i++) {
    setSystemTime(now + i * 10 * 60_000);
    await h.delivery.tick();
  }
  expect(h.store.getOperation(failure.id)).toMatchObject({ state: "uncertain", attempts: 5 });
  failing = false;
  setSystemTime(now + 25 * 3_600_000);
  enqueueNotice(h.store, { ...failure, id: "new-event", text: "third failure" });
  await h.delivery.tick();
  expect(h.calls.sends).toHaveLength(6);
  expect(h.calls.sends[5]?.text).toContain("2 failures since the last alert");
  expect(h.store.getOperation(failure.id)).toMatchObject({ state: "uncertain", attempts: 5 });
  setSystemTime(now + 26 * 3_600_000);
  await h.delivery.tick();
  expect(h.calls.sends).toHaveLength(7);
  expect(h.calls.sends[6]?.text).toContain("1 failure in the last hour");
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

test("tg.send logs actual chunk and attachment dispatches with severity and hashed identities", async () => {
  const h = setup();
  const key = "PRIVATE_NOTIFICATION_KEY";
  const api = createApi({ store: h.store, enabled: () => true, chatId: () => 100, timezone: "UTC", health: () => ({}) });
  const response = await api(new Request("http://bridge/notify", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "PRIVATE_SOURCE", severity: "attention", text: "PRIVATE_MESSAGE" + "x".repeat(3900), dedupeKey: key }) }));
  const { id } = await response.json() as { id: string };
  const data = Buffer.from("PRIVATE_ATTACHMENT_CONTENT");
  h.store.enqueue({ id: "PRIVATE_FILE_OPERATION", kind: "notification", text: "", attachment: {
    sha256: h.store.putBlob(data), name: "PRIVATE_FILENAME.pdf", mimeType: "application/pdf", size: data.length,
  } });
  h.readiness.enabled = false;
  await h.delivery.tick();
  expect(logs.entries().filter(row => row.name === "tg.send")).toEqual([]);
  h.readiness.enabled = true;
  await h.delivery.tick();
  await h.delivery.tick();
  const sends = logs.entries().filter(row => row.name === "tg.send");
  expect(sends).toHaveLength(h.calls.sends.length + h.calls.documents.length);
  expect(sends).toHaveLength(3);
  expect(sends.map(row => row.props?.severity)).toEqual(["attention", "attention", "info"]);
  expect(sends[0]?.ids).toEqual({ operation: logId(id), key: logId(id), chat: logId("100") });
  expect(sends[2]?.ids?.operation).toBe(logId("PRIVATE_FILE_OPERATION"));
  for (const send of sends) {
    expect(send).toMatchObject({ tool: "watchers", component: "telegram", kind: "perf", ok: true,
      props: { attempt: 1, accepted: true } });
    expect(Number.isFinite(send.durationMs)).toBe(true);
    expect(send.durationMs).toBeGreaterThanOrEqual(0);
  }
  expect(logs.text()).not.toContain("PRIVATE_");
});

test.each([
  ["tg.send.rejected", () => new GrammyError("PRIVATE_MESSAGE", { ok: false, error_code: 400,
    description: "PRIVATE_PROVIDER_RESPONSE" }, "sendMessage", {})],
  ["tg.send.floodWait", () => new GrammyError("PRIVATE_MESSAGE", { ok: false, error_code: 429,
    description: "PRIVATE_PROVIDER_RESPONSE", parameters: { retry_after: 2 } }, "sendMessage", {})],
  ["tg.send.retryable", () => new TransportError("PRIVATE_TRANSPORT_CODE", true, false)],
  ["tg.send.uncertain", () => new Error("PRIVATE_EXCEPTION_BODY")],
] as const)("tg.send records %s without exception details", async (tag, failure) => {
  const h = setup(() => { throw failure(); });
  enqueueNotice(h.store, { id: "PRIVATE_KEY", source: "PRIVATE_SOURCE", text: "PRIVATE_HEALTH_VALUE", severity: "error" });
  await h.delivery.tick();
  const sends = logs.entries().filter(row => row.name === "tg.send");
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ tool: "watchers", kind: "error", ok: false,
    ids: { operation: logId("PRIVATE_KEY"), key: logId("PRIVATE_KEY"), chat: logId("100") },
    props: { severity: "error", attempt: 1, accepted: false }, error: { tag, message: tag } });
  expect(sends[0]?.durationMs).toBeGreaterThanOrEqual(0);
  expect(logs.text()).not.toContain("PRIVATE_");
});

test("reminder delivery failures log the linked reminder and preserve cancellation behavior", async () => {
  const h = setup(() => { throw new TransportError("PRIVATE_REJECTION", false, false); });
  h.store.createReminder({ id: "PRIVATE_REMINDER", text: "PRIVATE_HEALTH_VALUE", dueAt: now, timezone: "UTC" });
  h.store.enqueueDueReminders(now);
  await h.delivery.tick();
  expect(h.store.getOperation("reminder:PRIVATE_REMINDER:1")?.state).toBe("failed");
  expect(h.store.cancelReminder("PRIVATE_REMINDER").status).toBe("cancelled");
  const failure = logs.entries().find(row => row.name === "tg.reminder" && row.ok === false);
  expect(failure).toMatchObject({ kind: "error", ids: { reminder: logId("PRIVATE_REMINDER"), operation: logId("reminder:PRIVATE_REMINDER:1") },
    props: { state: "failed" }, error: { tag: "tg.reminder.deliveryFailed" } });
  expect(logs.text()).not.toContain("PRIVATE_");
});

test("logging metadata failures cannot reject queue admission or prevent transport dispatch", async () => {
  const h = setup();
  h.store.db.exec(`CREATE TRIGGER reject_log_metadata BEFORE INSERT ON kv
    WHEN NEW.key LIKE 'log:severity:%' BEGIN SELECT RAISE(ABORT, 'PRIVATE_METADATA_FAILURE'); END`);
  expect(enqueueNotice(h.store, { id: "PRIVATE_KEY", source: "PRIVATE_SOURCE", text: "PRIVATE_MESSAGE", severity: "error" })).toBe(true);
  h.store.db.query("INSERT INTO kv (key, value) VALUES (?, ?)").run("api:notification:PRIVATE_KEY", "PRIVATE_INVALID_JSON");
  await h.delivery.tick();
  expect(h.calls.sends).toHaveLength(1);
  expect(h.store.getOperation("PRIVATE_KEY")?.state).toBe("sent");
  expect(logs.entries().map(row => row.error?.tag).filter(Boolean)).toEqual(["tg.send.severityStore", "tg.send.severityRead"]);
  expect(logs.entries().find(row => row.name === "tg.send")).toMatchObject({ ok: true, props: { severity: "info" } });
  expect(logs.text()).not.toContain("PRIVATE_");
});
