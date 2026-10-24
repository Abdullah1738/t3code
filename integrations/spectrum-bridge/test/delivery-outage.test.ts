import { afterEach, expect, mock, setSystemTime, test } from "bun:test";
import * as grpc from "@photon-ai/advanced-imessage/grpc";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delivery, OUTAGE_AFTER } from "../src/delivery.ts";
import type { Photon, SendResult } from "../src/photon.ts";
import { Store, type OutboxOperation } from "../src/store.ts";
import { telegramOutlet, type Post } from "../src/telegram-fallback.ts";

const stores: Store[] = [];
const directories: string[] = [];
const chatGuid = "any;-;+15555550123";
const projectScope = "test-project-scope";
const now = Date.parse("2026-09-10T12:00:00Z");
type Input = Parameters<Photon["sendText"]>[0];
const variantId = (id: string, chunk: number, suffix = "") =>
  `bridge-${createHash("sha256").update(`${projectScope}:${id}:${chunk}${suffix}`).digest("hex")}`;
const internal = () => new grpc.IMessageError("private", { code: "internalError", grpcCode: 13, retryable: true });

function setup(extra: Partial<ConstructorParameters<typeof Delivery>[2]> = {}) {
  const store = new Store(":memory:");
  stores.push(store);
  store.set("route", { id: "session", generation: 1 });
  const calls: Input[] = [];
  const transport = {
    sendText: mock(async (input: Input): Promise<SendResult> => {
      calls.push({ ...input });
      if (input.replyTo !== undefined) throw internal();
      return { providerId: `provider-${calls.length}` };
    }),
  };
  const log = mock((_event: string, _code?: string) => {});
  const options = { projectScope, enabled: () => true, chatGuid: () => chatGuid, log, sleep: async () => {}, ...extra };
  const delivery = new Delivery(store, transport, options);
  const enqueue = (id: string, extra: Partial<OutboxOperation> = {}) =>
    store.enqueue({ id, kind: "conversation", text: "Reply text", sessionId: "session", generation: 1, ...extra });
  return { store, calls, transport, log, delivery, enqueue };
}

afterEach(() => {
  setSystemTime();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("a failed threaded reply is retried once without its thread target under its own id, and stays unthreaded", async () => {
  setSystemTime(now);
  const h = setup();
  h.enqueue("reply", { replyTo: "owner-message" });
  await h.delivery.tick();
  expect(h.calls).toEqual([{ id: variantId("reply", 0), chatGuid, replyTo: "owner-message", text: "Reply text" }]);
  expect(h.store.get<boolean>("unthreaded:reply")).toBe(true);
  expect(h.store.getOperation("reply")).toMatchObject({ state: "pending", attempts: 1 });
  setSystemTime(now + 5_000);
  h.transport.sendText.mockImplementationOnce(async input => {
    h.calls.push({ ...input });
    throw internal();
  });
  await h.delivery.tick();
  expect(h.calls[1]).toEqual({ id: variantId("reply", 0, ":unthreaded"), retryOf: variantId("reply", 0), chatGuid, text: "Reply text" });
  setSystemTime(now + 60_000);
  await h.delivery.tick();
  expect(h.calls[2]).toEqual(h.calls[1]!);
  expect(h.store.getOperation("reply")).toMatchObject({ state: "sent", attempts: 3 });
  expect(h.log.mock.calls.filter(([event]) => event === "outbound-unthreaded")).toHaveLength(1);
});

test("texts without a thread target never change id on retry", async () => {
  setSystemTime(now);
  const h = setup();
  h.enqueue("plain");
  h.transport.sendText.mockImplementationOnce(async input => {
    h.calls.push({ ...input });
    throw internal();
  });
  await h.delivery.tick();
  setSystemTime(now + 60_000);
  await h.delivery.tick();
  expect(h.calls.map(call => call.id)).toEqual([variantId("plain", 0), variantId("plain", 0)]);
  expect(h.store.get("unthreaded:plain")).toBeUndefined();
});

test("replies the old five-attempt cap gave up on are delivered after a restart, in order", async () => {
  setSystemTime(now);
  const h = setup();
  for (const [id, state, attempts] of [["older", "uncertain", 5], ["refused", "failed", 1], ["prompt", "failed", 1]] as const) {
    h.enqueue(id === "prompt" ? "request:prompt" : id, { replyTo: "owner-message" });
    const row = id === "prompt" ? "request:prompt" : id;
    h.store.db.query("UPDATE outbox SET state = ?, attempts = ? WHERE id = ?").run(state, attempts, row);
    h.store.set(`firstAttempt:${row}`, now - 5 * 60 * 60_000);
    h.store.set(`retry:${row}`, now - 60 * 60_000);
  }
  h.enqueue("expired", { replyTo: "owner-message" });
  h.store.db.query("UPDATE outbox SET state = 'uncertain', attempts = 5 WHERE id = 'expired'").run();
  h.store.set("firstAttempt:expired", now - 25 * 60 * 60_000);
  h.delivery.recover();
  expect(h.store.getOperation("older")?.state).toBe("pending");
  expect(h.store.getOperation("refused")?.state).toBe("pending");
  // The router re-asks failed prompts itself, and the day-long window still holds.
  expect(h.store.getOperation("request:prompt")?.state).toBe("failed");
  expect(h.store.getOperation("expired")?.state).toBe("uncertain");
  await h.delivery.tick();
  setSystemTime(now + 10_000);
  await h.delivery.tick();
  expect(h.calls.filter(call => call.replyTo === undefined).map(call => call.id))
    .toEqual([variantId("older", 0, ":unthreaded"), variantId("refused", 0, ":unthreaded")]);
  expect(h.store.getOperation("older")).toMatchObject({ state: "sent", attempts: 7 });
  expect(h.store.getOperation("refused")).toMatchObject({ state: "sent", attempts: 3 });
});

test("a lasting outage alerts once after ten minutes and says once when it is over", async () => {
  setSystemTime(now);
  const notify = mock(async (_severity: string, _text: string, _key: string) => true);
  const h = setup({ notify });
  h.transport.sendText.mockImplementation(async input => {
    h.calls.push({ ...input });
    throw internal();
  });
  h.enqueue("stuck");
  for (let at = now; at <= now + OUTAGE_AFTER + 60_000; at += 60_000) {
    setSystemTime(at);
    await h.delivery.tick();
  }
  expect(notify.mock.calls).toHaveLength(1);
  expect(notify.mock.calls[0]![0]).toBe("attention");
  expect(notify.mock.calls[0]![2]).toBe(`spectrum-delivery:${now}`);
  for (let at = now + OUTAGE_AFTER + 120_000; at <= now + 3 * OUTAGE_AFTER; at += 60_000) {
    setSystemTime(at);
    await h.delivery.tick();
  }
  expect(notify.mock.calls).toHaveLength(1);
  h.transport.sendText.mockImplementation(async () => ({ providerId: "back" }));
  setSystemTime(now + 4 * OUTAGE_AFTER);
  await h.delivery.tick();
  setSystemTime(now + 5 * OUTAGE_AFTER);
  await h.delivery.tick();
  expect(h.store.getOperation("stuck")?.state).toBe("sent");
  expect(notify.mock.calls.map(([severity, , key]) => [severity, key]))
    .toEqual([["attention", `spectrum-delivery:${now}`], ["info", `spectrum-delivery:${now}:recovered`]]);
  expect(h.store.get("deliveryHealth")).toBeUndefined();
});

test("a short blip that recovers within ten minutes never alerts", async () => {
  setSystemTime(now);
  const notify = mock(async () => true);
  const h = setup({ notify });
  h.transport.sendText.mockImplementationOnce(async () => { throw internal(); });
  h.enqueue("blip");
  await h.delivery.tick();
  setSystemTime(now + 60_000);
  await h.delivery.tick();
  setSystemTime(now + 2 * OUTAGE_AFTER);
  await h.delivery.tick();
  expect(h.store.getOperation("blip")?.state).toBe("sent");
  expect(notify).not.toHaveBeenCalled();
  expect(h.store.get("deliveryHealth")).toBeUndefined();
});

test("images iMessage refuses go to the fallback at once, ones still retrying after ten minutes, and stop retrying", async () => {
  setSystemTime(now);
  const fallback = mock(async (_item: unknown) => "sent" as const);
  const h = setup({ fallback });
  const data = new Uint8Array([1, 2, 3]);
  const attachment = { sha256: h.store.putBlob(data), name: "card.png", mimeType: "image/png", size: 3 };
  const transport = {
    ...h.transport,
    uploadAttachment: mock(async () => ({ guid: "upload-guid" })),
    sendAttachment: mock(async (): Promise<SendResult> => { throw internal(); }),
  };
  const delivery = new Delivery(h.store, transport, { projectScope, enabled: () => true, chatGuid: () => chatGuid,
    sleep: async () => {}, fallback });
  h.store.enqueue({ id: "refused", kind: "notification", text: "", attachment });
  h.store.enqueue({ id: "retrying", kind: "notification", text: "", attachment });
  await delivery.tick();
  h.store.db.query("UPDATE outbox SET state = 'failed' WHERE id = 'refused'").run();
  setSystemTime(now + 60_000);
  await delivery.tick();
  expect(fallback.mock.calls.map(([item]) => (item as { id: string }).id)).toEqual(["refused"]);
  expect(h.store.getOperation("refused")?.state).toBe("fallback");
  for (let at = now + 120_000; at <= now + OUTAGE_AFTER + 60_000; at += 60_000) {
    setSystemTime(at);
    await delivery.tick();
  }
  expect(fallback.mock.calls.map(([item]) => (item as { id: string }).id)).toEqual(["refused", "retrying"]);
  expect(h.store.getOperation("retrying")?.state).toBe("fallback");
  const sends = transport.sendAttachment.mock.calls.length;
  setSystemTime(now + 2 * OUTAGE_AFTER);
  await delivery.tick();
  expect(transport.sendAttachment.mock.calls.length).toBe(sends);
});

test("the telegram outlet sends files and cards, but never a secure form link", async () => {
  const root = mkdtempSync(join(tmpdir(), "spectrum-outlet-test-"));
  directories.push(root);
  mkdirSync(join(root, "daily"));
  writeFileSync(join(root, "daily", "index.html"), "<p>daily</p>");
  const posts: Array<[string, Record<string, string>]> = [];
  const post: Post = async (path, body) => { posts.push([path, body]); return 202; };
  const data = new Uint8Array([1, 2, 3]);
  const sha256 = createHash("sha256").update(data).digest("hex");
  const outlet = telegramOutlet({ post, appsRoot: root, appsUrl: () => "https://apps.test:18400", blob: () => data });
  const base = { kind: "notification" as const, state: "failed", attempts: 1 };
  expect(await outlet.fallback({ ...base, id: "file", text: "Morning card",
    attachment: { sha256, name: "card.png", mimeType: "image/png", size: 3 } })).toBe("sent");
  expect(await outlet.fallback({ ...base, id: "app", text: "", app: { url: "https://apps.test:18400/daily/", caption: "Daily" } })).toBe("sent");
  expect(await outlet.fallback({ ...base, id: "secret-form:x", text: "",
    app: { url: "https://apps.test:18400/_secret/token", caption: "Secure form" } })).toBe("skip");
  expect(await outlet.fallback({ ...base, id: "elsewhere", text: "", app: { url: "https://other.test/x", caption: "Link" } })).toBe("sent");
  expect(posts.map(([path, body]) => [path, body.name ?? body.severity])).toEqual([
    ["/files", "card.png"], ["/files", "daily.html"], ["/notify", "info"],
  ]);
  expect(posts[0]![1]).toMatchObject({ base64: "AQID", mimeType: "image/png" });
  expect(posts[0]![1].text).toStartWith("Morning card\n");
  expect(posts[1]![1]).toMatchObject({ mimeType: "text/html", base64: Buffer.from("<p>daily</p>").toString("base64") });
  expect(posts.every(([, body]) => !JSON.stringify(body).includes("_secret"))).toBe(true);
  expect(await outlet.notify("attention", "down", "key")).toBe(true);
  const failing = telegramOutlet({ post: async () => undefined, appsRoot: root, appsUrl: () => undefined, blob: () => data });
  expect(await failing.notify("attention", "down", "key")).toBe(false);
  expect(await failing.fallback({ ...base, id: "file", text: "", attachment: { sha256, name: "a.png", mimeType: "image/png", size: 3 } }))
    .toBe("retry");
});
