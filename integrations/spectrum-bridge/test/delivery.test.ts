import { afterEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import * as grpc from "@photon-ai/advanced-imessage/grpc";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delivery, classifySendFailure } from "../src/delivery.ts";
import { Photon, TransportError, type SendResult } from "../src/photon.ts";
import { Store, type OutboxOperation } from "../src/store.ts";

const stores: Store[] = [];
const directories: string[] = [];
const chatGuid = "any;-;+15555550123";
const projectScope = "test-project-scope";
const now = Date.parse("2026-09-10T12:00:00Z");
const day = 24 * 60 * 60 * 1_000;
type Input = Parameters<Photon["sendText"]>[0];
const stableId = (id: string, chunk: number, scope = projectScope) =>
  `bridge-${createHash("sha256").update(`${scope}:${id}:${chunk}`).digest("hex")}`;

function setup(path = ":memory:") {
  const store = new Store(path);
  stores.push(store);
  const calls: Input[] = [];
  const transport = {
    sendText: mock(async (input: Input): Promise<SendResult> => {
      calls.push({ ...input });
      return { providerId: `provider-${calls.length}` };
    }),
  };
  const readiness = { enabled: true, chatGuid: chatGuid as string | undefined };
  const log = mock((_event: string, _code?: string) => {});
  const sleep = mock(async (_ms: number) => {});
  const options = { projectScope, enabled: () => readiness.enabled, chatGuid: () => readiness.chatGuid, log, sleep };
  const delivery = new Delivery(store, transport, options);
  const enqueue = (id = "op", extra: Partial<OutboxOperation> = {}) =>
    store.enqueue({ id, kind: "notification", text: "Private message", ...extra });
  return { store, calls, transport, readiness, log, sleep, options, delivery, enqueue };
}

function setupAttachment(path = ":memory:") {
  const h = setup(path);
  const data = new Uint8Array([0, 1, 2, 255]);
  const attachment = { sha256: h.store.putBlob(data), name: "report.bin", mimeType: "application/octet-stream", size: data.byteLength };
  const transport = {
    ...h.transport,
    uploadAttachment: mock(async (_input: Parameters<Photon["uploadAttachment"]>[0]) => ({ guid: "upload-guid" })),
    sendAttachment: mock(async (_input: Parameters<Photon["sendAttachment"]>[0]): Promise<SendResult> => ({ providerId: "file-guid" })),
  };
  return { ...h, data, attachment, transport, delivery: new Delivery(h.store, transport, h.options) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "spectrum-delivery-test-"));
  directories.push(directory);
  return join(directory, "store.sqlite");
}

afterEach(() => {
  mock.restore();
  setSystemTime();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test.each(["disabled", "unpaired"])("%s ticks do not change any stored state", async mode => {
  const h = setup();
  h.enqueue();
  h.enqueue("stale", { sessionId: "old", generation: 1 });
  h.enqueue("empty", { text: "" });
  if (mode === "disabled") h.readiness.enabled = false;
  else h.readiness.chatGuid = undefined;
  const before = h.store.pendingOutbox();
  await h.delivery.tick();
  expect(h.store.pendingOutbox()).toEqual(before);
  expect(h.store.db.query("SELECT * FROM kv").all()).toEqual([]);
  expect(h.transport.sendText).not.toHaveBeenCalled();
  expect(h.log).not.toHaveBeenCalled();
  expect(h.sleep).not.toHaveBeenCalled();
});

test.each([null, { id: "other", generation: 1 }, { id: "session", generation: 2 }])(
  "cancels stale generations before sending for route %j", async route => {
    const h = setup();
    h.store.set("route", route);
    h.enqueue("stale", { kind: "conversation", sessionId: "session", generation: 1 });
    await h.delivery.tick();
    expect(h.store.getOperation("stale")).toMatchObject({ state: "cancelled", attempts: 0 });
    expect(h.store.get("firstAttempt:stale")).toBeUndefined();
    expect(h.transport.sendText).not.toHaveBeenCalled();
  },
);

test("notifications with an old session or no session survive /new and no active route", async () => {
  const h = setup();
  h.store.set("route", { id: "new", generation: 2 });
  h.enqueue("old-session", { sessionId: "old" });
  h.enqueue("no-session");
  h.sleep.mockImplementation(async () => { h.store.set("route", null); });
  await h.delivery.tick();
  for (const id of ["old-session", "no-session"]) expect(h.store.getOperation(id)?.state).toBe("sent");
  expect(h.calls.map(call => call.id)).toEqual([stableId("old-session", 0), stableId("no-session", 0)]);
});

test("rechecks readiness after the final notification validation", async () => {
  const h = setup();
  h.enqueue();
  const delivery = new Delivery(h.store, h.transport, { ...h.options, beforeSend: async () => {
    h.readiness.enabled = false;
    return "send";
  } });
  await delivery.tick();
  expect(h.calls).toEqual([]);
  expect(h.store.getOperation("op")?.state).toBe("pending");
});

test("a deferred second chunk returns to pending and resumes from its checkpoint", async () => {
  const h = setup();
  h.enqueue("chunked-check", { text: "x".repeat(4_000) });
  let checks = 0;
  let waiting = true;
  const delivery = new Delivery(h.store, h.transport, { ...h.options, beforeSend: async () => {
    checks++;
    return checks > 1 && waiting ? "wait" : "send";
  } });
  await delivery.tick();
  expect(h.calls).toHaveLength(1);
  expect(h.store.getOperation("chunked-check")?.state).toBe("pending");
  waiting = false;
  await delivery.tick();
  expect(h.calls).toHaveLength(2);
  expect(h.calls[1]?.text.length).toBe(500);
  expect(h.store.getOperation("chunked-check")?.state).toBe("sent");
});

test.each(["", " \n\t"])("empty content %j fails without acceptance or an attempt", async text => {
  const h = setup();
  h.enqueue("empty", { text });
  await h.delivery.tick();
  expect(h.store.getOperation("empty")).toMatchObject({ state: "failed", attempts: 0 });
  expect(h.store.get("chunk:empty:0")).toBeUndefined();
  expect(h.transport.sendText).not.toHaveBeenCalled();
  expect(h.delivery.status()).toEqual({ lastError: "emptyContent" });
  expect(h.log.mock.calls).toEqual([["outbound-failed", "emptyContent"]]);
});

test("sends exactly the first ten pending operations per tick and paces each message", async () => {
  const h = setup();
  for (let index = 0; index < 12; index++) h.enqueue(`op-${index}`);
  await h.delivery.tick();
  expect(h.calls.map(call => call.id)).toEqual(Array.from({ length: 10 }, (_, i) => stableId(`op-${i}`, 0)));
  expect(h.store.pendingOutbox().map(item => item.id)).toEqual(["op-10", "op-11"]);
  expect(h.sleep.mock.calls).toEqual(Array.from({ length: 10 }, () => [800]));
  await h.delivery.tick();
  expect(h.calls).toHaveLength(12);
  expect(h.store.pendingOutbox()).toEqual([]);
});

test("retry deadlines do not let ten deferred operations starve a later notification", async () => {
  setSystemTime(now);
  const h = setup();
  for (let index = 0; index < 11; index++) h.enqueue(`op-${index}`);
  for (let index = 0; index < 10; index++) h.store.set(`retry:op-${index}`, now + 1_000);
  await h.delivery.tick();
  expect(h.calls.map(call => call.id)).toEqual([stableId("op-10", 0)]);
  expect(h.store.getOperation("op-10")?.state).toBe("sent");
  expect(h.store.pendingOutbox()).toHaveLength(10);
});

test("pending attention checks do not block unrelated notifications or spend send attempts", async () => {
  const h = setup();
  for (let index = 0; index < 12; index++) h.enqueue(`waiting-${index}`);
  for (let index = 0; index < 12; index++) h.enqueue(`ready-${index}`);
  const delivery = new Delivery(h.store, h.transport, {
    ...h.options, beforeSend: async item => item.id.startsWith("waiting-") ? "wait" : "send",
  });
  await delivery.tick();
  expect(h.calls.map(call => call.id)).toEqual(Array.from({ length: 10 }, (_, index) => stableId(`ready-${index}`, 0)));
  for (let index = 0; index < 12; index++) {
    expect(h.store.getOperation(`waiting-${index}`)).toMatchObject({ state: "pending", attempts: 0 });
    expect(h.store.get(`firstAttempt:waiting-${index}`)).toBeUndefined();
  }
  await delivery.tick();
  expect(h.calls).toHaveLength(12);
  expect(h.store.pendingOutbox().map(item => item.id)).toEqual(Array.from({ length: 12 }, (_, index) => `waiting-${index}`));
});

test("overlapping and reentrant ticks share a single run, including its pacing wait", async () => {
  const h = setup();
  h.enqueue();
  const sending = deferred<SendResult>();
  const pacing = deferred<void>();
  let reentrant: Promise<void> | undefined;
  h.transport.sendText.mockImplementation(() => {
    reentrant = h.delivery.tick();
    return sending.promise;
  });
  h.sleep.mockImplementation(() => pacing.promise);
  const first = h.delivery.tick();
  expect(h.delivery.tick()).toBe(first);
  await Promise.resolve();
  expect(reentrant).toBe(first);
  expect(h.transport.sendText).toHaveBeenCalledTimes(1);
  sending.resolve({ providerId: "provider" });
  await Promise.resolve();
  expect(h.delivery.tick()).toBe(first);
  expect(h.store.getOperation("op")?.state).toBe("sent");
  pacing.resolve();
  await first;
  await h.delivery.tick();
  expect(h.transport.sendText).toHaveBeenCalledTimes(1);
});

test("chunks at 3500 codepoints, checkpoints and aliases survive reopen, and retries keep immutable input", async () => {
  setSystemTime(now);
  const path = databasePath();
  const h = setup(path);
  const text = "x".repeat(3_499) + "\u{1F600}" + "y".repeat(3_499) + "\u{1F680}" + "last";
  h.enqueue("chunked", { text, replyTo: "inbound-parent" });
  let rejected: Input | undefined;
  h.transport.sendText.mockImplementationOnce(async input => {
    expect(Object.isFrozen(input)).toBe(true);
    expect(h.store.get<number>("firstAttempt:chunked")).toBe(now);
    h.calls.push({ ...input });
    return { providerId: "first-guid" };
  });
  h.transport.sendText.mockImplementationOnce(async input => {
    rejected = { ...input };
    throw new grpc.IMessageError("private response lost", { code: "internalError", grpcCode: 14, retryable: false });
  });
  await h.delivery.tick();
  expect(Array.from(h.calls[0]!.text)).toHaveLength(3_500);
  expect(h.calls[0]!.text).toEndWith("\u{1F600}");
  expect(Array.from(rejected!.text)).toHaveLength(3_500);
  expect(rejected!.text).toEndWith("\u{1F680}");
  expect(h.store.get<unknown>("chunk:chunked:0")).toEqual({ accepted: true, providerId: "first-guid" });
  expect(h.store.get<string>("provider-operation:first-guid")).toBe("chunked");
  expect(h.store.get("chunk:chunked:1")).toBeUndefined();
  expect(h.store.getOperation("chunked")).toMatchObject({ state: "pending", attempts: 1 });
  expect(() => h.enqueue("chunked", { text: "changed", replyTo: "inbound-parent" })).toThrow("content mismatch");
  h.store.close();
  const resumed = setup(path);
  setSystemTime(now + 10_000);
  resumed.transport.sendText.mockImplementation(async input => {
    resumed.calls.push({ ...input });
    return { providerId: resumed.calls.length === 1 ? "second-guid" : "third-guid" };
  });
  await resumed.delivery.tick();
  expect(resumed.calls[0]).toEqual(rejected!);
  expect(resumed.calls.map(call => call.id)).toEqual([stableId("chunked", 1), stableId("chunked", 2)]);
  expect(h.calls[0]!.text + resumed.calls.map(call => call.text).join("")).toBe(text);
  expect(resumed.calls.every(call => call.replyTo === "inbound-parent" && call.chatGuid === chatGuid)).toBe(true);
  expect(resumed.store.get<number>("firstAttempt:chunked")).toBe(now);
  expect(resumed.store.getOperation("chunked")).toMatchObject({ state: "sent", attempts: 2, providerId: "first-guid" });
  for (const [index, providerId] of ["first-guid", "second-guid", "third-guid"].entries()) {
    expect(resumed.store.get<unknown>(`chunk:chunked:${index}`)).toEqual({ accepted: true, providerId });
    expect(resumed.store.get<string>(`provider-operation:${providerId}`)).toBe("chunked");
  }
  expect(resumed.sleep.mock.calls).toEqual([[800], [800]]);
  expect(resumed.log.mock.calls).toEqual([["outbound-accepted"]]);
});

test("provider alias and chunk checkpoint commit atomically, and storage errors are not send failures", async () => {
  const h = setup();
  h.enqueue();
  h.store.db.exec(`CREATE TRIGGER reject_alias BEFORE INSERT ON kv
    WHEN NEW.key LIKE 'provider-operation:%' BEGIN SELECT RAISE(ABORT, 'test alias failure'); END`);
  await expect(h.delivery.tick()).rejects.toThrow("test alias failure");
  expect(h.store.get("chunk:op:0")).toBeUndefined();
  expect(h.store.get("provider-operation:provider-1")).toBeUndefined();
  expect(h.store.getOperation("op")).toMatchObject({ state: "sending", attempts: 1 });
  expect(h.store.get<boolean>("sendAmbiguous:op")).toBe(true);
  expect(h.log).not.toHaveBeenCalled();
  h.store.db.exec("DROP TRIGGER reject_alias");
  h.store.outboxState("op", "uncertain");
  h.delivery.recover();
  h.transport.sendText.mockResolvedValueOnce({ duplicate: true });
  await h.delivery.tick();
  expect(h.transport.sendText.mock.calls.map(([input]) => input.id)).toEqual([stableId("op", 0), stableId("op", 0)]);
  expect(h.store.get<unknown>("chunk:op:0")).toEqual({ accepted: true });
  expect(h.store.getOperation("op")).toMatchObject({ state: "sent", attempts: 2 });
});

test("an alias conflict never overwrites another operation's provider mapping", async () => {
  const h = setup();
  h.enqueue();
  h.store.set("provider-operation:provider-1", "other-op");
  await expect(h.delivery.tick()).rejects.toThrow("Provider alias conflict");
  expect(h.store.get<string>("provider-operation:provider-1")).toBe("other-op");
  expect(h.store.get("chunk:op:0")).toBeUndefined();
});

test("a lost gRPC response followed by a typed duplicate error is provider acceptance, not delivery", async () => {
  setSystemTime(now);
  const h = setup();
  h.enqueue();
  const sendText = mock(async (_chat: string, _text: string, _options: { clientMessageId: string }) => ({ guid: "unused" }));
  sendText.mockRejectedValueOnce(new grpc.IMessageError("private lost response", { code: "internalError", grpcCode: 14, retryable: false }));
  sendText.mockRejectedValueOnce(new grpc.IMessageError("private duplicate", { code: "duplicateMessage", grpcCode: 6, retryable: false }));
  spyOn(grpc, "createGrpcClient").mockImplementation(() => ({ messages: { sendText }, close: async () => {} }) as unknown as grpc.AdvancedIMessage);
  type Fetch = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
  const network = spyOn(globalThis as { fetch: Fetch }, "fetch").mockImplementation(() => { throw new Error("No live calls allowed"); });
  const photon = new Photon("test-project", "test-secret");
  try {
    const delivery = new Delivery(h.store, photon, h.options);
    await delivery.tick();
    expect(h.store.getOperation("op")).toMatchObject({ state: "pending", attempts: 1 });
    setSystemTime(now + 10_000);
    await delivery.tick();
    expect(sendText.mock.calls).toEqual([
      [chatGuid, "Private message", { clientMessageId: stableId("op", 0) }],
      [chatGuid, "Private message", { clientMessageId: stableId("op", 0) }],
    ]);
    expect(h.store.getOperation("op")).toMatchObject({ state: "sent", attempts: 2 });
    expect(h.store.getOperation("op")?.providerId).toBeUndefined();
    expect(h.store.get<unknown>("chunk:op:0")).toEqual({ accepted: true });
    expect(h.log.mock.calls).toEqual([["outbound-failed", "internalError"], ["outbound-accepted"]]);
    expect(network).not.toHaveBeenCalled();
  } finally { await photon.close(); }
});

test("a duplicate first chunk without a GUID uses the first known GUID as the operation provider ID", async () => {
  const h = setup();
  h.enqueue("op", { text: "x".repeat(3_501) });
  h.transport.sendText.mockResolvedValueOnce({ duplicate: true });
  h.transport.sendText.mockResolvedValueOnce({ providerId: "known-guid" });
  await h.delivery.tick();
  expect(h.store.get<unknown>("chunk:op:0")).toEqual({ accepted: true });
  expect(h.store.get<unknown>("chunk:op:1")).toEqual({ accepted: true, providerId: "known-guid" });
  expect(h.store.getOperation("op")?.providerId).toBe("known-guid");
});

test.each([1, 2, 4, 13, 14])("gRPC status %i retries at most five times despite retryable=false", async grpcCode => {
  setSystemTime(now);
  const h = setup();
  h.enqueue();
  const failure = new grpc.IMessageError("PRIVATE_ERROR", { code: "internalError", grpcCode, retryable: false });
  expect(classifySendFailure(failure)).toEqual({ retryable: true, uncertain: true, code: "internalError" });
  h.transport.sendText.mockRejectedValue(failure);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const before = Date.now();
    await h.delivery.tick();
    expect(h.store.getOperation("op")).toMatchObject({ state: attempt === 5 ? "uncertain" : "pending", attempts: attempt });
    expect(h.store.get<number>("firstAttempt:op")).toBe(now);
    if (attempt < 5) {
      const retryAt = h.store.get<number>("retry:op")!;
      expect(retryAt).toBe(before + 5_000 * 2 ** attempt);
      setSystemTime(retryAt - 1);
      await h.delivery.tick();
      expect(h.transport.sendText).toHaveBeenCalledTimes(attempt);
      setSystemTime(retryAt);
    }
  }
  h.delivery.recover();
  await h.delivery.tick();
  expect(h.transport.sendText).toHaveBeenCalledTimes(5);
  expect(h.transport.sendText.mock.calls.every(([input]) => input.id === stableId("op", 0))).toBe(true);
  expect(h.log.mock.calls).toEqual(Array.from({ length: 5 }, () => ["outbound-failed", "internalError"]));
  expect(h.delivery.status()).toEqual({ lastError: "internalError" });
});

test.each([
  new TransportError("tokenNetwork", true),
  new grpc.RateLimitError("PRIVATE_LIMIT", { code: "dailyLimitExceeded", grpcCode: 8, retryable: true }),
])("known unaccepted transient failures end failed, not uncertain %#", async failure => {
  setSystemTime(now);
  const h = setup();
  h.enqueue();
  h.transport.sendText.mockRejectedValue(failure);
  for (let attempt = 0; attempt < 5; attempt++) {
    await h.delivery.tick();
    setSystemTime(h.store.get<number>("retry:op")!);
  }
  expect(h.store.getOperation("op")).toMatchObject({ state: "failed", attempts: 5 });
  expect(h.store.get("chunk:op:0")).toBeUndefined();
});

test.each([
  new TransportError("unauthorized"),
  new grpc.IMessageError("PRIVATE_ARGUMENT", { code: "invalidArgument", grpcCode: 3, retryable: true }),
  new grpc.IMessageError("PRIVATE_AUTH", { code: "unauthenticated", grpcCode: 16, retryable: true }),
])("permanent rejections fail without retry %#", async failure => {
  const h = setup();
  h.enqueue();
  h.transport.sendText.mockRejectedValue(failure);
  await h.delivery.tick();
  await h.delivery.tick();
  expect(h.store.getOperation("op")).toMatchObject({ state: "failed", attempts: 1 });
  expect(h.store.get("retry:op")).toBeUndefined();
  expect(h.transport.sendText).toHaveBeenCalledTimes(1);
  expect(h.delivery.status().lastError).toBe(failure.code);
});

test("unknown synchronous throws are ambiguous and logs never contain exception codes or bodies", async () => {
  const h = setup();
  h.enqueue();
  h.transport.sendText.mockImplementation(() => { throw Object.assign(new Error("PRIVATE_BODY"), { code: "PRIVATE_SECRET" }); });
  await h.delivery.tick();
  expect(h.store.getOperation("op")).toMatchObject({ state: "pending", attempts: 1 });
  expect(h.log.mock.calls).toEqual([["outbound-failed", "unknownSendFailure"]]);
  expect(h.delivery.status()).toEqual({ lastError: "unknownSendFailure" });
});

test("a later pre-dispatch rejection cannot erase a prior ambiguous response", async () => {
  setSystemTime(now);
  const h = setup();
  h.enqueue();
  h.transport.sendText.mockRejectedValueOnce(new Error("response lost"));
  h.transport.sendText.mockRejectedValueOnce(new TransportError("unauthorized"));
  await h.delivery.tick();
  setSystemTime(now + 10_000);
  await h.delivery.tick();
  expect(h.store.getOperation("op")).toMatchObject({ state: "uncertain", attempts: 2 });
});

test.each(["route", "cancelled", "failed", "uncertain"])("state change %s during an accepted RPC prevents remaining chunks", async change => {
  const h = setup();
  h.store.set("route", { id: "session", generation: 1 });
  h.enqueue("op", { text: "x".repeat(3_501), sessionId: "session", generation: 1 });
  const pending = deferred<SendResult>();
  h.transport.sendText.mockImplementation(() => pending.promise);
  const tick = h.delivery.tick();
  await Promise.resolve();
  if (change === "route") h.store.set("route", { id: "new", generation: 2 });
  else h.store.outboxState("op", change);
  pending.resolve({ providerId: "accepted-before-cancel" });
  await tick;
  expect(h.transport.sendText).toHaveBeenCalledTimes(1);
  expect(h.store.getOperation("op")?.state).toBe(change === "route" ? "cancelled" : change);
  expect(h.store.get<unknown>("chunk:op:0")).toEqual({ accepted: true, providerId: "accepted-before-cancel" });
  expect(h.store.get<string>("provider-operation:accepted-before-cancel")).toBe("op");
  expect(h.log).not.toHaveBeenCalled();
});

test.each(["route", "cancelled"])("state change %s during a rejected RPC never requeues it", async change => {
  const h = setup();
  h.store.set("route", { id: "session", generation: 1 });
  h.enqueue("op", { sessionId: "session", generation: 1 });
  const pending = deferred<SendResult>();
  h.transport.sendText.mockImplementation(() => pending.promise);
  const tick = h.delivery.tick();
  await Promise.resolve();
  if (change === "route") h.store.set("route", null);
  else h.store.outboxState("op", "cancelled");
  pending.reject(new Error("response lost"));
  await tick;
  expect(h.store.getOperation("op")?.state).toBe("cancelled");
  expect(h.store.get("retry:op")).toBeUndefined();
  expect(h.log).not.toHaveBeenCalled();
});

test("cancellation during the final RPC is not overwritten with sent", async () => {
  const h = setup();
  h.enqueue();
  h.transport.sendText.mockImplementation(async () => {
    h.store.outboxState("op", "cancelled");
    return { providerId: "accepted" };
  });
  await h.delivery.tick();
  expect(h.store.getOperation("op")?.state).toBe("cancelled");
  expect(h.store.get<unknown>("chunk:op:0")).toEqual({ accepted: true, providerId: "accepted" });
  expect(h.log).not.toHaveBeenCalled();
});

test.each(["route", "cancelled"])("rechecks %s after the inter-chunk pacing await", async change => {
  const h = setup();
  h.store.set("route", { id: "session", generation: 0 });
  h.enqueue("op", { text: "x".repeat(3_501), sessionId: "session", generation: 0 });
  h.sleep.mockImplementation(async () => {
    if (change === "route") h.store.set("route", { id: "session", generation: 1 });
    else h.store.outboxState("op", "cancelled");
  });
  await h.delivery.tick();
  expect(h.calls).toHaveLength(1);
  expect(h.store.getOperation("op")?.state).toBe("cancelled");
  expect(h.store.get("chunk:op:1")).toBeUndefined();
});

test("cancelling a queued operation while another is in flight honors its fresh state", async () => {
  const h = setup();
  h.enqueue("first");
  h.enqueue("second");
  const pending = deferred<SendResult>();
  h.transport.sendText.mockImplementation(() => pending.promise);
  const tick = h.delivery.tick();
  await Promise.resolve();
  h.store.outboxState("second", "cancelled");
  pending.resolve({ providerId: "first-guid" });
  await tick;
  expect(h.transport.sendText).toHaveBeenCalledTimes(1);
  expect(h.store.getOperation("second")).toMatchObject({ state: "cancelled", attempts: 0 });
});

test.each(["disabled", "unpaired"])("readiness becoming %s after a chunk pauses without losing its checkpoint", async mode => {
  const h = setup();
  h.enqueue("op", { text: "x".repeat(3_501) });
  h.enqueue("later");
  h.sleep.mockImplementationOnce(async () => {
    if (mode === "disabled") h.readiness.enabled = false;
    else h.readiness.chatGuid = undefined;
  });
  await h.delivery.tick();
  expect(h.calls).toHaveLength(1);
  expect(h.store.getOperation("op")).toMatchObject({ state: "pending", attempts: 1 });
  expect(h.store.getOperation("later")).toMatchObject({ state: "pending", attempts: 0 });
  h.readiness.enabled = true;
  h.readiness.chatGuid = chatGuid;
  await h.delivery.tick();
  expect(h.calls.map(call => call.id)).toEqual([stableId("op", 0), stableId("op", 1), stableId("later", 0)]);
  expect(h.store.getOperation("op")?.state).toBe("sent");
});

test("a changed destination never retries a stable key with different chat content", async () => {
  setSystemTime(now);
  const h = setup();
  h.enqueue();
  h.transport.sendText.mockRejectedValueOnce(new Error("lost response"));
  await h.delivery.tick();
  h.readiness.chatGuid = "any;-;+15555550999";
  setSystemTime(now + 10_000);
  await h.delivery.tick();
  expect(h.transport.sendText).toHaveBeenCalledTimes(1);
  expect(h.store.getOperation("op")?.state).toBe("uncertain");
  expect(h.delivery.status()).toEqual({ lastError: "chatChanged" });
});

test("interrupted sends recover only with a known first attempt strictly within 24 hours and attempts below five", async () => {
  setSystemTime(now);
  const path = databasePath();
  const h = setup(path);
  for (const [id, firstAttempt, attempts] of [
    ["recent", now - day + 1, 4], ["boundary", now - day, 1], ["expired", now - day - 1, 1],
    ["missing", undefined, 1], ["future", now + 1, 1], ["exhausted", now - 1, 5],
    ["invalid", "not-a-date", 1], ["null", null, 1],
  ] as const) {
    h.enqueue(id);
    if (firstAttempt !== undefined) h.store.set(`firstAttempt:${id}`, firstAttempt);
    for (let attempt = 0; attempt < attempts; attempt++) {
      h.store.outboxState(id, "pending");
      h.store.outboxState(id, "sending");
    }
  }
  h.store.close();
  const recovered = setup(path);
  for (const id of ["recent", "boundary", "expired", "missing", "future", "exhausted", "invalid", "null"]) {
    expect(recovered.store.getOperation(id)?.state).toBe("uncertain");
  }
  recovered.delivery.recover();
  expect(recovered.store.pendingOutbox().map(item => item.id)).toEqual(["recent"]);
  expect(recovered.store.getOperation("recent")?.attempts).toBe(4);
  recovered.transport.sendText.mockResolvedValueOnce({ duplicate: true });
  await recovered.delivery.tick();
  expect(recovered.store.getOperation("recent")).toMatchObject({ state: "sent", attempts: 5 });
  expect(recovered.transport.sendText).toHaveBeenCalledTimes(1);
  for (const id of ["boundary", "expired", "missing", "future", "exhausted", "invalid", "null"]) {
    expect(recovered.store.getOperation(id)?.state).toBe("uncertain");
  }
});

test("retry-window checks apply again at dispatch, including recovered and pending operations", async () => {
  setSystemTime(now);
  const h = setup();
  h.enqueue("recovered");
  h.store.set("firstAttempt:recovered", now - day + 1);
  h.store.outboxState("recovered", "sending");
  h.store.outboxState("recovered", "uncertain");
  h.delivery.recover();
  h.enqueue("pending");
  h.transport.sendText.mockRejectedValueOnce(new Error("unknown"));
  h.store.set("retry:recovered", now + 1);
  await h.delivery.tick();
  expect(h.store.get<number>("firstAttempt:pending")).toBe(now);
  setSystemTime(now + day);
  await h.delivery.tick();
  expect(h.transport.sendText).toHaveBeenCalledTimes(1);
  expect(h.store.getOperation("recovered")?.state).toBe("uncertain");
  expect(h.store.getOperation("pending")?.state).toBe("uncertain");
});

test("the 24-hour fence is checked before every chunk, not just at tick start", async () => {
  setSystemTime(now);
  const h = setup();
  h.enqueue("op", { text: "x".repeat(3_501) });
  h.sleep.mockImplementationOnce(async () => { setSystemTime(now + day); });
  await h.delivery.tick();
  expect(h.calls).toHaveLength(1);
  expect(h.store.getOperation("op")?.state).toBe("uncertain");
  expect(h.store.get("chunk:op:1")).toBeUndefined();
});

test("old pending attempts without timestamps are never given a fresh dedupe window", async () => {
  const h = setup();
  h.enqueue();
  h.store.outboxState("op", "sending");
  h.store.outboxState("op", "pending");
  await h.delivery.tick();
  expect(h.store.getOperation("op")).toMatchObject({ state: "uncertain", attempts: 1 });
  expect(h.store.get("firstAttempt:op")).toBeUndefined();
  expect(h.transport.sendText).not.toHaveBeenCalled();
});

test("fully checkpointed operations finish without another RPC or consuming an attempt", async () => {
  const h = setup();
  h.enqueue();
  h.store.set("chunk:op:0", { accepted: true, providerId: "already-accepted" });
  h.store.set("provider-operation:already-accepted", "op");
  await h.delivery.tick();
  expect(h.store.getOperation("op")).toMatchObject({ state: "sent", attempts: 0, providerId: "already-accepted" });
  expect(h.transport.sendText).not.toHaveBeenCalled();
  expect(h.sleep).not.toHaveBeenCalled();
});

test("project scope isolates otherwise identical operation and chunk IDs", async () => {
  const h = setup();
  h.enqueue();
  await new Delivery(h.store, h.transport, { ...h.options, projectScope: "other-project" }).tick();
  expect(h.calls[0]!.id).toBe(stableId("op", 0, "other-project"));
  expect(h.calls[0]!.id).not.toBe(stableId("op", 0));
});

test.each(["", " \n\t"])("attachment without a caption %j is one final message", async text => {
  const h = setupAttachment();
  h.enqueue("file", { text, attachment: h.attachment, replyTo: "parent-guid" });
  h.transport.sendAttachment.mockImplementationOnce(async input => {
    expect(Object.isFrozen(input)).toBe(true);
    expect(h.store.get<unknown>("upload:file")).toEqual({ guid: "upload-guid", sha256: h.attachment.sha256 });
    expect(h.store.get("chunk:file:0")).toBeUndefined();
    expect(h.store.getOperation("file")?.state).toBe("sending");
    expect(h.store.get<boolean>("sendAmbiguous:file")).toBe(true);
    return { providerId: "file-guid" };
  });
  await h.delivery.tick();
  expect(h.transport.sendText).not.toHaveBeenCalled();
  expect(h.transport.uploadAttachment.mock.calls).toEqual([[{
    id: stableId("file", 0), data: h.data, name: h.attachment.name, mimeType: h.attachment.mimeType,
  }]]);
  expect(h.transport.sendAttachment.mock.calls).toEqual([[{
    id: stableId("file", 0), chatGuid, attachmentGuid: "upload-guid", replyTo: "parent-guid",
  }]]);
  expect(h.store.get<unknown>("chunk:file:0")).toEqual({ accepted: true, providerId: "file-guid" });
  expect(h.store.getOperation("file")).toMatchObject({ state: "sent", attempts: 1, providerId: "file-guid" });
  expect(h.store.byProviderId("file-guid")).toEqual(h.store.getOperation("file"));
  expect(h.store.byProviderId("upload-guid")).toBeUndefined();
  expect(h.sleep.mock.calls).toEqual([[800]]);
  expect(h.log.mock.calls).toEqual([["outbound-accepted"]]);
});

test("caption chunks retain text IDs and checkpoints, followed by one attachment step", async () => {
  const h = setupAttachment();
  const text = "x".repeat(3_499) + "\u{1F600}" + "caption tail";
  h.enqueue("file", { text, attachment: h.attachment, replyTo: "parent-guid" });
  h.transport.uploadAttachment.mockImplementationOnce(async input => {
    expect(Object.isFrozen(input)).toBe(true);
    expect(h.calls.map(call => call.id)).toEqual([stableId("file", 0), stableId("file", 1)]);
    expect(h.store.getOperation("file")?.state).toBe("sending");
    expect(h.store.get<boolean>("sendAmbiguous:file")).toBe(false);
    expect(h.store.get("chunk:file:2")).toBeUndefined();
    expect(h.log).not.toHaveBeenCalled();
    return { guid: "upload-guid" };
  });
  await h.delivery.tick();
  expect(h.calls.map(call => call.text).join("")).toBe(text);
  expect(Array.from(h.calls[0]!.text)).toHaveLength(3_500);
  expect(h.calls.every(call => call.replyTo === "parent-guid")).toBe(true);
  expect(h.transport.uploadAttachment.mock.calls[0]![0].id).toBe(stableId("file", 2));
  expect(h.transport.sendAttachment.mock.calls).toEqual([[{
    id: stableId("file", 2), chatGuid, attachmentGuid: "upload-guid", replyTo: "parent-guid",
  }]]);
  for (const [index, providerId] of ["provider-1", "provider-2", "file-guid"].entries()) {
    expect(h.store.get<unknown>(`chunk:file:${index}`)).toEqual({ accepted: true, providerId });
    expect(h.store.byProviderId(providerId)?.id).toBe("file");
  }
  expect(h.store.getOperation("file")).toMatchObject({ state: "sent", attempts: 1, providerId: "provider-1" });
  expect(h.sleep.mock.calls).toEqual([[800], [800], [800]]);
  expect(h.log.mock.calls).toEqual([["outbound-accepted"]]);
});

test.each(["uploadAttachment", "sendAttachment"] as const)("missing %s fails with a fixed unsupported code before sending a caption", async method => {
  const h = setupAttachment();
  h.enqueue("file", { attachment: h.attachment });
  await new Delivery(h.store, { ...h.transport, [method]: undefined }, h.options).tick();
  expect(h.store.getOperation("file")).toMatchObject({ state: "failed", attempts: 0 });
  expect(h.transport.sendText).not.toHaveBeenCalled();
  expect(h.transport.uploadAttachment).not.toHaveBeenCalled();
  expect(h.transport.sendAttachment).not.toHaveBeenCalled();
  expect(h.log.mock.calls).toEqual([["outbound-failed", "unsupported"]]);
});

test.each(["size", "hash", "missing"])("attachment blob %s mismatch is rejected before uploading", async mismatch => {
  const h = setupAttachment();
  if (mismatch === "size") h.attachment.size++;
  if (mismatch === "hash") spyOn(h.store, "getBlob").mockReturnValue(new Uint8Array([9, 9, 9, 9]));
  if (mismatch === "missing") spyOn(h.store, "getBlob").mockImplementation(() => { throw new Error("PRIVATE_SOURCE_PATH"); });
  h.enqueue("file", { text: "", attachment: h.attachment });
  await h.delivery.tick();
  expect(h.store.getOperation("file")).toMatchObject({ state: "failed", attempts: 0 });
  expect(h.store.get("upload:file")).toBeUndefined();
  expect(h.store.get("chunk:file:0")).toBeUndefined();
  expect(h.transport.uploadAttachment).not.toHaveBeenCalled();
  expect(h.transport.sendAttachment).not.toHaveBeenCalled();
  expect(h.log.mock.calls).toEqual([["outbound-failed", "invalidAttachment"]]);
});

test.each(["disabled", "unpaired"])("upload checkpoint survives %s readiness and restart without another upload or blob read", async mode => {
  setSystemTime(now);
  const path = databasePath();
  const h = setupAttachment(path);
  h.enqueue("file", { text: "", attachment: h.attachment });
  h.transport.uploadAttachment.mockImplementationOnce(async () => {
    if (mode === "disabled") h.readiness.enabled = false;
    else h.readiness.chatGuid = undefined;
    return { guid: "upload-guid" };
  });
  await h.delivery.tick();
  expect(h.store.getOperation("file")).toMatchObject({ state: "pending", attempts: 1 });
  expect(h.store.get<unknown>("upload:file")).toEqual({ guid: "upload-guid", sha256: h.attachment.sha256 });
  expect(h.store.get("chunk:file:0")).toBeUndefined();
  expect(h.store.get<boolean>("sendAmbiguous:file")).toBe(false);
  expect(h.transport.sendAttachment).not.toHaveBeenCalled();
  expect(h.log).not.toHaveBeenCalled();
  h.store.close();
  const resumed = setupAttachment(path);
  const blobRead = spyOn(resumed.store, "getBlob").mockImplementation(() => { throw new Error("blob no longer available"); });
  await resumed.delivery.tick();
  expect(blobRead).not.toHaveBeenCalled();
  expect(resumed.transport.uploadAttachment).not.toHaveBeenCalled();
  expect(resumed.transport.sendAttachment.mock.calls).toEqual([[{ id: stableId("file", 0), chatGuid, attachmentGuid: "upload-guid" }]]);
  expect(resumed.store.getOperation("file")).toMatchObject({ state: "sent", attempts: 2, providerId: "file-guid" });
});

test.each(["route", "cancelled", "chat", "expired"])("%s change during upload fences the final message", async change => {
  setSystemTime(now);
  const h = setupAttachment();
  h.store.set("route", { id: "session", generation: 1 });
  h.enqueue("file", { text: "", attachment: h.attachment, sessionId: "session", generation: 1 });
  const pending = deferred<{ guid: string }>();
  h.transport.uploadAttachment.mockImplementationOnce(() => pending.promise);
  const tick = h.delivery.tick();
  await Promise.resolve();
  expect(h.transport.uploadAttachment).toHaveBeenCalledTimes(1);
  if (change === "route") h.store.set("route", { id: "session", generation: 2 });
  if (change === "cancelled") h.store.outboxState("file", "cancelled");
  if (change === "chat") h.readiness.chatGuid = "any;-;+15555550999";
  if (change === "expired") setSystemTime(now + day);
  pending.resolve({ guid: "upload-guid" });
  await tick;
  expect(h.store.getOperation("file")?.state).toBe(["route", "cancelled"].includes(change) ? "cancelled" : "uncertain");
  expect(h.store.get<unknown>("upload:file")).toEqual({ guid: "upload-guid", sha256: h.attachment.sha256 });
  expect(h.store.get("chunk:file:0")).toBeUndefined();
  expect(h.store.get<boolean>("sendAmbiguous:file")).toBe(false);
  expect(h.transport.sendAttachment).not.toHaveBeenCalled();
});

test("upload failures retry the same final stage up to five times without message ambiguity or repeated captions", async () => {
  setSystemTime(now);
  const h = setupAttachment();
  h.enqueue("file", { attachment: h.attachment });
  h.transport.uploadAttachment.mockRejectedValue(Object.assign(new Error("PRIVATE_SOURCE_PATH"), { code: "PRIVATE_SECRET" }));
  for (let attempt = 1; attempt <= 5; attempt++) {
    await h.delivery.tick();
    expect(h.store.getOperation("file")).toMatchObject({ state: attempt < 5 ? "pending" : "failed", attempts: attempt });
    expect(h.store.get<boolean>("sendAmbiguous:file")).toBe(false);
    if (attempt < 5) {
      const retryAt = h.store.get<number>("retry:file")!;
      setSystemTime(retryAt - 1);
      await h.delivery.tick();
      expect(h.transport.uploadAttachment).toHaveBeenCalledTimes(attempt);
      setSystemTime(retryAt);
    }
  }
  h.delivery.recover();
  await h.delivery.tick();
  expect(h.transport.sendText).toHaveBeenCalledTimes(1);
  expect(h.transport.uploadAttachment).toHaveBeenCalledTimes(5);
  expect(h.transport.uploadAttachment.mock.calls.every(([input]) => input.id === stableId("file", 1))).toBe(true);
  expect(h.transport.sendAttachment).not.toHaveBeenCalled();
  expect(h.store.get("upload:file")).toBeUndefined();
  expect(h.store.get("chunk:file:1")).toBeUndefined();
  expect(h.log.mock.calls).toEqual(Array.from({ length: 5 }, () => ["outbound-failed", "unknownSendFailure"]));
});

test("a lost upload response can reupload, and later send rejection is not made ambiguous by the upload", async () => {
  setSystemTime(now);
  const h = setupAttachment();
  h.enqueue("file", { text: "", attachment: h.attachment });
  h.transport.uploadAttachment.mockRejectedValueOnce(new Error("lost upload response"));
  await h.delivery.tick();
  expect(h.store.get("upload:file")).toBeUndefined();
  expect(h.store.getOperation("file")?.state).toBe("pending");
  h.transport.sendAttachment.mockRejectedValueOnce(new TransportError("unauthorized"));
  setSystemTime(h.store.get<number>("retry:file")!);
  await h.delivery.tick();
  expect(h.transport.uploadAttachment).toHaveBeenCalledTimes(2);
  expect(h.transport.sendAttachment).toHaveBeenCalledTimes(1);
  expect(h.store.getOperation("file")).toMatchObject({ state: "failed", attempts: 2 });
  expect(h.store.get<unknown>("upload:file")).toEqual({ guid: "upload-guid", sha256: h.attachment.sha256 });
  expect(h.store.get("chunk:file:0")).toBeUndefined();
});

test("crash before the upload checkpoint permits reupload without a duplicate message", async () => {
  setSystemTime(now);
  const path = databasePath();
  const h = setupAttachment(path);
  h.enqueue("file", { text: "", attachment: h.attachment });
  h.store.db.exec(`CREATE TRIGGER reject_upload BEFORE INSERT ON kv
    WHEN NEW.key = 'upload:file' BEGIN SELECT RAISE(ABORT, 'test upload checkpoint crash'); END`);
  await expect(h.delivery.tick()).rejects.toThrow("test upload checkpoint crash");
  expect(h.store.getOperation("file")).toMatchObject({ state: "sending", attempts: 1 });
  expect(h.store.get<boolean>("sendAmbiguous:file")).toBe(false);
  expect(h.store.get("upload:file")).toBeUndefined();
  expect(h.transport.sendAttachment).not.toHaveBeenCalled();
  expect(h.log).not.toHaveBeenCalled();
  h.store.db.exec("DROP TRIGGER reject_upload");
  h.store.close();
  const resumed = setupAttachment(path);
  expect(resumed.store.getOperation("file")?.state).toBe("uncertain");
  resumed.delivery.recover();
  resumed.transport.uploadAttachment.mockResolvedValueOnce({ guid: "replacement-upload" });
  await resumed.delivery.tick();
  expect(resumed.transport.uploadAttachment).toHaveBeenCalledTimes(1);
  expect(resumed.transport.sendAttachment.mock.calls).toEqual([[{ id: stableId("file", 0), chatGuid, attachmentGuid: "replacement-upload" }]]);
  expect(resumed.store.getOperation("file")?.state).toBe("sent");
});

test("crash after attachment dispatch reuses the persisted upload and stable ID, accepting duplicate without a GUID", async () => {
  setSystemTime(now);
  const path = databasePath();
  const h = setupAttachment(path);
  h.enqueue("file", { text: "", attachment: h.attachment });
  h.store.db.exec(`CREATE TRIGGER reject_file_alias BEFORE INSERT ON kv
    WHEN NEW.key = 'provider-operation:file-guid' BEGIN SELECT RAISE(ABORT, 'test file checkpoint crash'); END`);
  await expect(h.delivery.tick()).rejects.toThrow("test file checkpoint crash");
  expect(h.store.get("chunk:file:0")).toBeUndefined();
  expect(h.store.byProviderId("file-guid")).toBeUndefined();
  expect(h.store.get<unknown>("upload:file")).toEqual({ guid: "upload-guid", sha256: h.attachment.sha256 });
  expect(h.store.get<boolean>("sendAmbiguous:file")).toBe(true);
  expect(h.log).not.toHaveBeenCalled();
  h.store.db.exec("DROP TRIGGER reject_file_alias");
  h.store.close();
  const resumed = setupAttachment(path);
  resumed.delivery.recover();
  resumed.transport.sendAttachment.mockResolvedValueOnce({ duplicate: true });
  await resumed.delivery.tick();
  expect(resumed.transport.uploadAttachment).not.toHaveBeenCalled();
  expect(resumed.transport.sendAttachment.mock.calls).toEqual(h.transport.sendAttachment.mock.calls);
  expect(resumed.store.get<unknown>("chunk:file:0")).toEqual({ accepted: true });
  expect(resumed.store.getOperation("file")).toMatchObject({ state: "sent", attempts: 2 });
});

test.each(["unknown", "grpc", "unaccepted"])("attachment send failure (%s) retries retain the upload GUID and stop at five attempts", async mode => {
  setSystemTime(now);
  const h = setupAttachment();
  h.enqueue("file", { text: "", attachment: h.attachment });
  const failure = mode === "unknown" ? new Error("PRIVATE_BODY") : mode === "unaccepted"
    ? new TransportError("tokenNetwork", true)
    : new grpc.IMessageError("PRIVATE_SEND_FAILURE", { code: "internalError", grpcCode: 13, retryable: false });
  h.transport.sendAttachment.mockRejectedValue(failure);
  for (let attempt = 1; attempt <= 5; attempt++) {
    await h.delivery.tick();
    expect(h.store.getOperation("file")).toMatchObject({
      state: attempt < 5 ? "pending" : mode === "unaccepted" ? "failed" : "uncertain", attempts: attempt,
    });
    if (attempt < 5) setSystemTime(h.store.get<number>("retry:file")!);
  }
  h.delivery.recover();
  await h.delivery.tick();
  expect(h.transport.uploadAttachment).toHaveBeenCalledTimes(1);
  expect(h.transport.sendAttachment.mock.calls).toEqual(Array.from({ length: 5 }, () => [{
    id: stableId("file", 0), chatGuid, attachmentGuid: "upload-guid",
  }]));
  expect(h.store.get("chunk:file:0")).toBeUndefined();
  expect(h.log.mock.calls).toEqual(Array.from({ length: 5 }, () => ["outbound-failed", classifySendFailure(failure).code]));
});

test("an upstream missing attachment after an ambiguous send never triggers reupload or clears uncertainty", async () => {
  setSystemTime(now);
  const h = setupAttachment();
  h.enqueue("file", { text: "", attachment: h.attachment });
  h.transport.sendAttachment.mockRejectedValueOnce(new Error("lost response"));
  h.transport.sendAttachment.mockRejectedValueOnce(new grpc.IMessageError("gone", { code: "attachmentNotFound", grpcCode: 5, retryable: false }));
  await h.delivery.tick();
  setSystemTime(h.store.get<number>("retry:file")!);
  await h.delivery.tick();
  expect(h.transport.uploadAttachment).toHaveBeenCalledTimes(1);
  expect(h.transport.sendAttachment.mock.calls[1]).toEqual(h.transport.sendAttachment.mock.calls[0]);
  expect(h.store.getOperation("file")).toMatchObject({ state: "uncertain", attempts: 2 });
  expect(h.store.get<unknown>("upload:file")).toEqual({ guid: "upload-guid", sha256: h.attachment.sha256 });
});

test("a fully checkpointed attachment finishes without uploading or sending again", async () => {
  const h = setupAttachment();
  h.enqueue("file", { text: "", attachment: h.attachment });
  h.store.set("chunk:file:0", { accepted: true, providerId: "file-guid" });
  h.store.set("provider-operation:file-guid", "file");
  await h.delivery.tick();
  expect(h.transport.uploadAttachment).not.toHaveBeenCalled();
  expect(h.transport.sendAttachment).not.toHaveBeenCalled();
  expect(h.store.getOperation("file")).toMatchObject({ state: "sent", attempts: 0, providerId: "file-guid" });
});

test("caption and upload checkpoints resume only the failed final send after reopening", async () => {
  setSystemTime(now);
  const path = databasePath();
  const h = setupAttachment(path);
  h.enqueue("file", { text: "x".repeat(3_501), attachment: h.attachment, replyTo: "parent-guid" });
  h.transport.sendAttachment.mockRejectedValueOnce(new Error("lost file response"));
  await h.delivery.tick();
  expect(h.store.getOperation("file")).toMatchObject({ state: "pending", attempts: 1 });
  expect(h.store.get("chunk:file:2")).toBeUndefined();
  h.store.close();
  const resumed = setupAttachment(path);
  setSystemTime(now + 10_000);
  await resumed.delivery.tick();
  expect(resumed.transport.sendText).not.toHaveBeenCalled();
  expect(resumed.transport.uploadAttachment).not.toHaveBeenCalled();
  expect(resumed.transport.sendAttachment.mock.calls).toEqual(h.transport.sendAttachment.mock.calls);
  expect(resumed.transport.sendAttachment.mock.calls[0]![0].id).toBe(stableId("file", 2));
  expect(resumed.store.getOperation("file")).toMatchObject({ state: "sent", attempts: 2, providerId: "provider-1" });
  for (const guid of ["provider-1", "provider-2", "file-guid"]) {
    expect(resumed.store.byProviderId(guid)?.id).toBe("file");
  }
});

test.each(["missing", "sha256", "guid"])("an ambiguous file send with a %s upload checkpoint never reuploads", async invalid => {
  setSystemTime(now);
  const h = setupAttachment();
  h.enqueue("file", { text: "", attachment: h.attachment });
  h.store.set("firstAttempt:file", now);
  h.store.set("sendAmbiguous:file", true);
  h.store.outboxState("file", "sending");
  h.store.outboxState("file", "uncertain");
  if (invalid !== "missing") h.store.set("upload:file", {
    guid: invalid === "guid" ? "" : "upload-guid", sha256: invalid === "sha256" ? "different-hash" : h.attachment.sha256,
  });
  const checkpoint = h.store.get<unknown>("upload:file");
  h.delivery.recover();
  await h.delivery.tick();
  expect(h.store.getOperation("file")).toMatchObject({ state: "uncertain", attempts: 1 });
  expect(h.store.get<unknown>("upload:file")).toEqual(checkpoint);
  expect(h.transport.uploadAttachment).not.toHaveBeenCalled();
  expect(h.transport.sendAttachment).not.toHaveBeenCalled();
  expect(h.log.mock.calls).toEqual([["outbound-failed", "invalidAttachment"]]);
});

test("a permanent upload rejection fails without retries or any send acceptance", async () => {
  const h = setupAttachment();
  h.enqueue("file", { text: "", attachment: h.attachment });
  h.transport.uploadAttachment.mockRejectedValueOnce(new TransportError("invalidAttachment"));
  await h.delivery.tick();
  await h.delivery.tick();
  expect(h.transport.uploadAttachment).toHaveBeenCalledTimes(1);
  expect(h.transport.sendAttachment).not.toHaveBeenCalled();
  expect(h.store.getOperation("file")).toMatchObject({ state: "failed", attempts: 1 });
  expect(h.store.get("upload:file")).toBeUndefined();
  expect(h.store.get("chunk:file:0")).toBeUndefined();
  expect(h.log.mock.calls).toEqual([["outbound-failed", "invalidAttachment"]]);
});

test.each(["upload", "send"])("cancellation during a rejected %s never requeues the file", async stage => {
  const h = setupAttachment();
  h.store.set("route", { id: "session", generation: 1 });
  h.enqueue("file", { text: "", attachment: h.attachment, sessionId: "session", generation: 1 });
  const reject = async () => {
    h.store.set("route", { id: "session", generation: 2 });
    throw new Error("PRIVATE_ERROR");
  };
  if (stage === "upload") h.transport.uploadAttachment.mockImplementationOnce(reject);
  else h.transport.sendAttachment.mockImplementationOnce(reject);
  await h.delivery.tick();
  expect(h.store.getOperation("file")?.state).toBe("cancelled");
  expect(h.store.get("chunk:file:0")).toBeUndefined();
  expect(h.store.get("retry:file")).toBeUndefined();
  expect(h.log).not.toHaveBeenCalled();
});

test("cancellation during file acceptance keeps its checkpoint and alias without marking sent", async () => {
  const h = setupAttachment();
  h.enqueue("file", { text: "", attachment: h.attachment });
  h.transport.sendAttachment.mockImplementationOnce(async () => {
    h.store.outboxState("file", "cancelled");
    return { providerId: "file-guid" };
  });
  await h.delivery.tick();
  expect(h.store.getOperation("file")?.state).toBe("cancelled");
  expect(h.store.get<unknown>("chunk:file:0")).toEqual({ accepted: true, providerId: "file-guid" });
  expect(h.store.byProviderId("file-guid")?.id).toBe("file");
  expect(h.log).not.toHaveBeenCalled();
});
