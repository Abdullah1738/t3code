import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChatMirror, HttpMirrorSink, MIRROR_CUTOVER, MIRROR_START_NOTE, createChatMirror, type MirrorItem, type MirrorSink } from "../src/mirror.ts";
import { ControlError } from "../src/control.ts";
import { Store } from "../src/store.ts";
import { captureLogs } from "./log-fixture.ts";
import { inboundFromLine } from "../src/sb-transport.ts";
import { LineError } from "../src/line.ts";
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));
class Sink implements MirrorSink {
  creates = 0; uploads = 0; calls = 0; online = true; lostAck = false; hang = false;
  failure?: ControlError;
  failAt?: "ensure" | "upload" | "append"; status = 0;
  items = new Map<string, MirrorItem>();
  ensure = async (_signal: AbortSignal) => { this.creates++; if (this.failAt === "ensure") throw new ControlError(this.status, "not_mirror"); if (!this.online) throw new Error("PRIVATE_OUTAGE"); return { threadId: "mirror-one" }; };
  upload = async () => { if (this.failAt === "upload") throw new ControlError(this.status, "not_mirror"); this.uploads++; return { attachmentId: `attachment-${this.uploads}` }; };
  append = async (_id: string, items: MirrorItem[], _signal: AbortSignal) => {
    this.calls++;
    if (this.failAt === "append") throw new ControlError(this.status, "not_mirror");
    if (this.hang) return new Promise<never>(() => {});
    if (this.failure) { const error = this.failure; this.failure = undefined; throw error; }
    if (!this.online) throw new Error("PRIVATE_OUTAGE");
    for (const item of items) this.items.set(item.id, item);
    if (this.lostAck) { this.lostAck = false; throw new Error("PRIVATE_ACK"); }
    return { appended: 1, skipped: 0 };
  };
}
function setup(options: ConstructorParameters<typeof ChatMirror>[2] = {}) {
  const root = mkdtempSync(join(tmpdir(), "mirror-test-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "chat.sqlite"); let store = new Store(path); cleanup.push(() => store.close());
  const sink = new Sink(); let now = MIRROR_CUTOVER + 60_000;
  const make = () => new ChatMirror(store, sink, { now: () => now, ...options }); let mirror = make();
  return { root, sink, get store() { return store; }, get mirror() { return mirror; },
    advance: () => { now += 600_000; }, restart: () => { store.close(); store = new Store(path); mirror = make(); } };
}
const inbound = (text = "PRIVATE_DM", sentAt = MIRROR_CUTOVER + 1000) => ({ text, sentAt, source: "typed", attachments: [] });

test("inbound and outbound persist once across replay and an actual store reopen", async () => {
  const s = setup(); s.mirror.inbound("sb-handle", inbound()); s.mirror.outbound("send-key", "PRIVATE_REPLY", undefined);
  s.mirror.inbound("sb-handle", inbound()); await s.mirror.tick(); await s.mirror.tick();
  s.restart(); s.mirror.inbound("sb-handle", inbound()); s.mirror.outbound("send-key", "PRIVATE_REPLY", undefined); await s.mirror.tick();
  expect([...s.sink.items.keys()]).toEqual(["sb-handle", "send:send-key"]); expect(s.sink.creates).toBe(1); expect(s.sink.calls).toBe(2);
  expect(s.sink.items.get("sb-handle")?.at).toBe(new Date(MIRROR_CUTOVER + 1000).toISOString());
});

test("outage and restart keep the queue ordered and back off the head", async () => {
  const s = setup(); s.sink.online = false;
  s.mirror.inbound("first", inbound()); s.mirror.outbound("second", "reply", undefined);
  await s.mirror.tick(); s.restart(); s.sink.online = true; await s.mirror.tick(); expect(s.sink.items.size).toBe(0);
  s.advance(); await s.mirror.tick(); await s.mirror.tick(); expect([...s.sink.items.keys()]).toEqual(["first", "send:second"]);
});

test("a lost append acknowledgement reuses both item and thread identity", async () => {
  const s = setup(); s.sink.lostAck = true; s.mirror.inbound("first", inbound()); await s.mirror.tick();
  s.restart(); s.advance(); await s.mirror.tick(); expect(s.sink.items.size).toBe(1); expect(s.sink.creates).toBe(1);
});

test.each([new ControlError(404), new ControlError(409, "not_mirror")])("stale cached mirror is recreated idempotently: %j", async failure => {
  const s = setup(); s.store.set("mirror-thread-id", "old"); s.sink.failure = failure;
  s.mirror.inbound("first", inbound()); await s.mirror.tick(); expect(s.store.get("mirror-thread-id")).toBeNull();
  s.advance(); await s.mirror.tick(); expect(s.sink.items.size).toBe(1); expect(s.sink.creates).toBe(1);
});

test("mirror off never initializes the sink or queue", () => {
  const s = setup(); let calls = 0;
  for (const enabled of [false, undefined]) expect(createChatMirror(enabled, s.store, () => { calls++; return s.sink; })).toBeUndefined();
  expect(calls).toBe(0);
});

test("hung sinks time out, do not overlap and do not run on the enqueue path", async () => {
  const s = setup({ timeoutMs: 20 }); s.sink.hang = true;
  s.mirror.inbound("first", inbound()); const running = s.mirror.tick();
  s.mirror.outbound("second", "reply", undefined); await s.mirror.tick();
  expect(s.sink.calls).toBe(1); await running;
  s.sink.hang = false; s.advance(); await s.mirror.tick(); await s.mirror.tick();
  expect([...s.sink.items.keys()]).toEqual(["first", "send:second"]);
});

test("local inbound files and remembered outbound uploads attach; missing files get placeholders", async () => {
  const s = setup(), path = join(s.root, "photo.png"); writeFileSync(path, "bytes");
  s.mirror.inbound("files", { ...inbound(), attachments: [{ path, fileName: "photo.png", mimeType: "image/png" }, { fileName: "gone.pdf", mimeType: "application/pdf" }, { fileName: "gone.png", mimeType: "image/png" }] });
  s.mirror.rememberFile("https://media.example/report.pdf", { name: "report.pdf", mimeType: "application/pdf", data: Buffer.from("pdf") });
  s.mirror.outbound("file", "report", "https://media.example/report.pdf");
  await s.mirror.tick(); await s.mirror.tick();
  expect(s.sink.uploads).toBe(2); expect(s.sink.items.get("files")).toMatchObject({ text: "PRIVATE_DM\n[file gone.pdf]\n[image]", attachments: [{ attachmentId: "attachment-1" }] });
  expect(s.sink.items.get("send:file")?.attachments).toEqual([{ attachmentId: "attachment-2" }]);
});

test("attachment upload receipts survive append failures and restart", async () => {
  const s = setup(), sha256 = s.store.putBlob(Buffer.from("file"));
  s.mirror.inbound("f", { ...inbound(), attachments: [{ sha256, fileName: "x.pdf", mimeType: "application/pdf" }] });
  s.sink.lostAck = true; await s.mirror.tick(); s.restart(); s.advance(); await s.mirror.tick(); expect(s.sink.uploads).toBe(1);
});

test("backfill only includes chat-held messages since cutover, in time order, once", async () => {
  const s = setup(); s.store.acceptInbound("before", inbound("old", MIRROR_CUTOVER - 1));
  s.store.acceptInbound("later", inbound("later", MIRROR_CUTOVER + 2000)); s.store.acceptInbound("earlier", inbound("earlier"));
  s.store.acceptInbound("wake", { text: "PRIVATE_WAKE", sentAt: MIRROR_CUTOVER + 500, source: "wake" });
  s.mirror.backfill(); s.restart(); s.mirror.backfill();
  for (let i = 0; i < 4; i++) await s.mirror.tick();
  expect([...s.sink.items.keys()]).toEqual(["mirror-start-note", "earlier", "later"]);
  expect(s.sink.items.get("mirror-start-note")?.text).toBe(MIRROR_START_NOTE);
});

test("queue overflow and exhausted retries log only reduced diagnostics", async () => {
  const s = setup({ maxQueue: 1, maxAttempts: 2 });
  const logs = await captureLogs(async () => {
    s.mirror.inbound("first", inbound()); s.mirror.inbound("dropped", inbound()); s.mirror.backfill();
    s.sink.failure = new ControlError(422); await s.mirror.tick(); s.advance(); s.sink.failure = new ControlError(422); await s.mirror.tick();
  });
  expect(logs.find(x => x.name === "mirror-fail" && x.props?.cause === "queue_full")).toBeDefined();
  expect(logs.find(x => x.name === "mirror-fail" && x.props?.cause === "retry_exhausted")?.props?.attempt).toBe(2);
  expect(logs.find(x => x.name === "mirror-append")?.props).toMatchObject({ direction: "inbound", kind: "text", latency_ms: 0 });
  expect(logs.some(x => x.name === "mirror-queue" && x.props?.depth === 0)).toBe(true);
  expect(logs.some(x => x.name === "mirror-backfill")).toBe(true);
  expect(JSON.stringify(logs)).not.toContain("PRIVATE_");
});

test("a long Robob outage keeps queued messages past the bounded retry counter", async () => {
  const s = setup({ maxAttempts: 2 }); s.sink.online = false; s.mirror.inbound("waiting", inbound());
  for (let i = 0; i < 5; i++) { await s.mirror.tick(); s.advance(); }
  s.restart(); s.sink.online = true; await s.mirror.tick(); expect([...s.sink.items.keys()]).toEqual(["waiting"]);
});

test("HTTP client uses planned read-only routes, direct response shapes and existing attachment upload", async () => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const path = new URL(request.url).pathname;
    if (path === "/upload") { expect(await request.text()).toBe("file"); return Response.json({}); }
    expect(request.headers.get("authorization")).toBe("Bearer fake");
    const body = await request.json() as Record<string, unknown>; calls.push({ path, body });
    if (path.endsWith("/mirror-threads")) return Response.json({ threadId: "t:mirror", created: true }, { status: 201 });
    if (path.endsWith("/attachments")) return Response.json({ ok: true, attachmentId: "a1", relativeUrl: "/upload" });
    return Response.json({ appended: 1, skipped: 0 });
  } }); cleanup.push(() => { void server.stop(true); });
  const sink = new HttpMirrorSink({ url: `http://127.0.0.1:${server.port}`, token: "fake" });
  const signal = new AbortController().signal, { threadId } = await sink.ensure(signal);
  const attachment = await sink.upload({ name: "f.pdf", mimeType: "application/pdf", bytes: Buffer.from("file") }, signal);
  await sink.append(threadId, [{ id: "one", role: "user", at: new Date(MIRROR_CUTOVER).toISOString(), text: "PRIVATE", attachments: [{ attachmentId: attachment.attachmentId }] }], signal);
  expect(calls.map(x => x.path)).toEqual(["/api/ardud/control/mirror-threads", "/api/ardud/control/attachments", "/api/ardud/control/threads/t%3Amirror/history"]);
  expect(calls[0]!.body).toMatchObject({ mirrorKey: "imessage:moni", title: "Moni (read-only)", source: "iMessage (Moni's box)", origin: "imessage" });
});

// Live ingress supplies URL guids; path and blob references cover locally held backfill files.
test.each([
  { name: "photo.png", mimeType: "image/png" }, { name: "photo.jpg", mimeType: "image/jpeg" },
  { name: "photo.heic", mimeType: "image/heic" }, { name: "report.pdf", mimeType: "application/pdf" },
  { name: "voice.m4a", mimeType: "audio/mp4" }, { name: "file", mimeType: "application/octet-stream" },
])("real ingress URL files upload in the worker and survive restart: $name", async ({ name, mimeType }) => {
  let downloads = 0;
  const url = `https://media.example/${name}?signature=PRIVATE_TOKEN`;
  const s = setup({ download: async (actual, maxBytes, timeoutMs) => {
    downloads++; expect(actual).toBe(url); expect(maxBytes).toBe(20 * 1024 * 1024); expect(timeoutMs).toBeLessThanOrEqual(5000);
    return { data: Buffer.from("file"), name, mimeType };
  } });
  const input = inboundFromLine({ handle: "real-handle", text: "caption", from: "moni", kind: "message", service: "iMessage", sentAt: MIRROR_CUTOVER + 1000, mediaUrl: url });
  s.mirror.inbound(input.id, input); expect(downloads).toBe(0); s.restart();
  const logs = await captureLogs(async () => { s.sink.lostAck = true; await s.mirror.tick(); s.restart(); s.advance(); await s.mirror.tick(); });
  expect(downloads).toBe(1); expect(s.sink.uploads).toBe(1);
  expect(s.sink.items.get("real-handle")).toMatchObject({ text: "caption", attachments: [{ attachmentId: "attachment-1" }] });
  expect(JSON.stringify(logs)).not.toContain("PRIVATE_TOKEN");
});

test.each([
  { code: "http_404", retryable: false, retained: false },
  { code: "too_large", retryable: false, retained: false },
  { code: "http_503", retryable: true, retained: true },
  { code: "download_failed", retryable: true, retained: true },
])("media failures either retain the queue or give a placeholder: $code", async ({ code, retryable, retained }) => {
  let failed = true;
  const s = setup({ download: async () => { if (failed) throw new LineError("PRIVATE_MEDIA_ERROR", code, retryable, false); return { data: Buffer.from("image"), name: "photo.png", mimeType: "image/png" }; } });
  s.mirror.inbound("media", inboundFromLine({ handle: "media", text: "caption", from: "moni", kind: "message", service: "iMessage", sentAt: MIRROR_CUTOVER + 1000, mediaUrl: "https://media.example/photo.png" }));
  await s.mirror.tick();
  if (retained) { expect(s.sink.items.size).toBe(0); failed = false; s.advance(); await s.mirror.tick(); expect(s.sink.items.get("media")?.attachments).toHaveLength(1); }
  else { expect(s.sink.items.get("media")?.text).toBe("caption\n[image]"); expect(s.sink.uploads).toBe(0); }
});

test("a hanging media download times out without holding enqueue or allowing late writes", async () => {
  let release: ((value: { data: Uint8Array; name: string; mimeType: string }) => void) | undefined;
  const s = setup({ timeoutMs: 20, download: () => new Promise(resolve => { release = resolve; }) });
  s.mirror.inbound("media", inboundFromLine({ handle: "media", text: "caption", from: "moni", kind: "message", service: "iMessage", sentAt: MIRROR_CUTOVER + 1000, mediaUrl: "https://media.example/photo.png" }));
  const running = s.mirror.tick(); s.mirror.outbound("next", "reply", undefined); await running;
  release?.({ data: Buffer.from("late"), name: "photo.png", mimeType: "image/png" }); await Promise.resolve(); await Promise.resolve();
  expect(s.sink.items.size).toBe(0); expect(s.sink.uploads).toBe(0);
});

const failureMatrix = [0, 400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 503].flatMap(status =>
  (["ensure", "upload", "append"] as const).map(phase => ({ status, phase, dropped: [400, 413, 422].includes(status) })));
test.each(failureMatrix)("failure class $status during $phase retains only recoverable items", async ({ status, phase, dropped }) => {
  const s = setup({ maxAttempts: 2 }), sha256 = s.store.putBlob(Buffer.from("file"));
  s.mirror.inbound("pending", { ...inbound(), attachments: [{ sha256, fileName: "x.pdf", mimeType: "application/pdf" }] });
  s.sink.failAt = phase; s.sink.status = status;
  for (let i = 0; i < 4; i++) { await s.mirror.tick(); s.advance(); }
  s.restart(); s.sink.failAt = undefined; await s.mirror.tick();
  expect(s.sink.items.has("pending")).toBe(!dropped);
});

test("transient attempts do not consume the consecutive rejection budget", async () => {
  const s = setup({ maxAttempts: 2 }); s.mirror.inbound("pending", inbound());
  for (const status of [503, 503, 400, 401, 400]) { s.sink.failure = new ControlError(status); await s.mirror.tick(); s.advance(); }
  s.restart(); await s.mirror.tick(); expect(s.sink.items.has("pending")).toBe(true);
});
