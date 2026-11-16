import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import { createApi, MAX_FILE_BODY } from "../src/api.ts";
import { MAX_FILE_BYTES } from "../src/cli.ts";
import { Store } from "../src/store.ts";
import { useToolLogFixture } from "./toollog-fixture.ts";

const logs = useToolLogFixture();

const stores: Store[] = [];
const now = Date.parse("2026-09-10T00:00:00Z");
const at = "2026-09-11T09:30:00+04:00";
const snoozeAt = "2026-09-12T10:00:00Z";
const notify = { source: "tests", severity: "info", text: "hello", dedupeKey: "event-1" };
const remind = { text: "stretch", at, idempotencyKey: "reminder-1" };
const file = { base64: Buffer.from("PRIVATE_FILE_CONTENT\x00\xff").toString("base64"), name: "report.pdf",
  mimeType: "application/pdf", text: "A report", dedupeKey: "file-1" };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function setup() {
  setSystemTime(now);
  const store = new Store(":memory:");
  stores.push(store);
  const state = { enabled: true, chat: 100 as number | undefined, health: { ok: true } as Record<string, unknown> };
  const options = { store, enabled: () => state.enabled, chatId: () => state.chat, timezone: "Asia/Dubai", health: () => state.health };
  const api = createApi(options);
  const get = (path: string) => api(new Request(`http://bridge${path}`));
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => api(new Request(`http://bridge${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  }));
  return { store, state, options, api, get, post };
}

afterEach(() => {
  setSystemTime();
  for (const store of stores.splice(0)) store.close();
});

test("health projects safe fields and never exposes credentials, tokens, or chat identity", async () => {
  const h = setup();
  h.state.health = {
    ok: true, status: "healthy", uptimeSeconds: 12, lastEventAt: now, telegramConnected: true,
    lastError: "PRIVATE_ERROR", token: "PRIVATE_TOKEN", config: { secret: "PRIVATE_CONFIG" }, chatId: 123,
  };
  const response = await h.get("/health");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ ok: true, status: "healthy", telegramConnected: true,
    uptimeSeconds: 12, lastEventAt: now, enabled: true, paired: true, ready: true });
  h.state.health = { status: "PRIVATE_STATUS", uptimeSeconds: Infinity, lastEventAt: -1 };
  h.state.enabled = false;
  h.state.chat = undefined;
  expect(await (await h.get("/health")).json()).toEqual({ enabled: false, paired: false, ready: false });
  const failing = createApi({ ...h.options, health() { throw new Error("PRIVATE_HEALTH"); } });
  const failure = await failing(new Request("http://bridge/health"));
  expect(failure.status).toBe(409);
  expect(await failure.json()).toEqual({ error: "Operation could not be completed" });
  expect(logs.entries()).toMatchObject([{ tool: "watchers", kind: "error", name: "telegram.error", ok: false,
    error: { tag: "tg.api.requestFailed", message: "tg.api.requestFailed" } }]);
  expect(logs.text()).not.toContain("PRIVATE_");
});

test("health exposes only safe board counters and refresh reasons", async () => {
  const h = setup();
  const board = { boardFetches: 3, boardCacheHits: 40, boardFetchErrors: 1, boardBackoffMs: 10_000, lastFetchDurationMs: 25, lastFetchReason: "dirty",
    fetchesByReason: { cold: 1, age: 0, hard: 1, soft: 1 }, dirtyEventsByType: { "thread.updated:thread.metadata-updated": { hard: 0, soft: 3 }, constructor: { hard: 0, soft: 1 } },
    windowStartedAt: "2026-09-10T00:00:00.000Z" };
  h.state.health = { board: { ...board, title: "PRIVATE_TITLE", token: "PRIVATE_TOKEN", error: "PRIVATE_ERROR",
    fetchesByReason: { ...board.fetchesByReason, title: "PRIVATE_TITLE", token: "PRIVATE_TOKEN" },
    dirtyEventsByType: { "thread.updated:thread.metadata-updated": { hard: 0, soft: 3, threadId: "PRIVATE_ID", title: "PRIVATE_TITLE" }, constructor: { hard: 0, soft: 1 } } } };
  expect((await (await h.get("/health")).json()).board).toEqual(board);
  h.state.health = { board: { boardFetches: -1, boardCacheHits: Infinity, boardFetchErrors: "PRIVATE_VALUE", boardBackoffMs: -1,
    lastFetchDurationMs: NaN, lastFetchReason: "PRIVATE_REASON" } };
  expect((await (await h.get("/health")).json()).board).toEqual({});
  h.state.health = { board: { boardFetches: 0, boardCacheHits: 0, boardFetchErrors: 0, boardBackoffMs: 0, lastFetchDurationMs: null, lastFetchReason: null } };
  expect((await (await h.get("/health")).json()).board).toEqual(h.state.health.board);
  for (const value of [null, [], "PRIVATE_VALUE"]) {
    h.state.health = { board: value };
    expect(await (await h.get("/health")).json()).not.toHaveProperty("board");
  }
});

test("health bounds dirty event names, merges overflow and excludes malformed nested telemetry", async () => {
  const h = setup();
  h.state.health = { board: {
    fetchesByReason: { cold: -1, age: Infinity, hard: "PRIVATE_VALUE", soft: 0.5, token: "PRIVATE_TOKEN" },
    dirtyEventsByType: { other: { hard: 2, soft: 3 },
      ...Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`future.event-${index}`, { hard: 1, soft: 2, title: "PRIVATE_TITLE" }])),
      "PRIVATE_TITLE": { hard: 1, soft: 1 }, "thread:PRIVATE_ID": { hard: 1, soft: 1 },
      "thread:private-id": { hard: 1, soft: 1 }, "request.opened:private-id": { hard: 1, soft: 1 },
      "future.negative": { hard: -1, soft: 1 }, "future.infinite": { hard: 0, soft: Infinity },
      "future.fraction": { hard: 0.5, soft: 1 }, "future.string": "PRIVATE_VALUE", "future.array": [],
      "future.missing": { soft: 1 }, "future.null": null },
    windowStartedAt: "PRIVATE_TIME",
  } };
  const health = await (await h.get("/health")).json();
  expect(health.board.fetchesByReason).toEqual({});
  expect(Object.keys(health.board.dirtyEventsByType)).toHaveLength(51);
  expect(health.board.dirtyEventsByType.other).toEqual({ hard: 12, soft: 23 });
  expect(health.board).not.toHaveProperty("windowStartedAt");
  expect(JSON.stringify(health)).not.toContain("PRIVATE_");
  for (const value of [null, [], "PRIVATE_VALUE"]) {
    h.state.health = { board: { fetchesByReason: value, dirtyEventsByType: value, windowStartedAt: value } };
    expect((await (await h.get("/health")).json()).board).toEqual({});
  }
});

test("health exposes bounded status subkeys and local counts without payload identities", async () => {
  const h = setup();
  h.state.health = { board: { dirtyEventsByType: {
    ...Object.fromEntries(["same", "move", "join", "leave", "offboard"].map(kind => [`thread.status:${kind}`, { hard: 0, soft: 0, local: 2, threadId: "PRIVATE_ID", title: "PRIVATE_TITLE" }])),
    "thread.status:private-id": { hard: 1, soft: 0, local: 1 },
    "thread.status:PRIVATE_TITLE": { hard: 1, soft: 0 },
    "future.negative": { hard: 0, soft: 0, local: -1 },
    "future.fraction": { hard: 0, soft: 0, local: 0.5 },
    "future.string": { hard: 0, soft: 0, local: "PRIVATE_VALUE" },
  } } };
  const health = await (await h.get("/health")).json();
  for (const kind of ["same", "move", "join", "leave", "offboard"]) expect(health.board.dirtyEventsByType[`thread.status:${kind}`]).toEqual({ hard: 0, soft: 0, local: 2 });
  for (const kind of ["negative", "fraction", "string"]) expect(health.board.dirtyEventsByType[`future.${kind}`]).toEqual({ hard: 0, soft: 0 });
  expect(health.board.dirtyEventsByType).not.toHaveProperty("thread.status:private-id");
  expect(JSON.stringify(health)).not.toContain("PRIVATE_");
});

test("health allows only bounded single-thread read counters and reasons", async () => {
  const h = setup();
  h.state.health = { board: { threadReads: 5, threadReadErrors: 1,
    threadReadsByReason: { run: 2, state: 2, followup: 1, created: 3, threadId: "PRIVATE_ID", title: "PRIVATE_TITLE" } } };
  expect((await (await h.get("/health")).json()).board).toEqual({ threadReads: 5, threadReadErrors: 1,
    threadReadsByReason: { run: 2, state: 2, followup: 1, created: 3 } });
  h.state.health = { board: { threadReads: -1, threadReadErrors: 0.5, threadReadsByReason: { run: Infinity, state: "PRIVATE_ID", followup: -1 } } };
  expect((await (await h.get("/health")).json()).board).toEqual({ threadReadsByReason: {} });
});

test("notify queues one stable operation and never touches reminders or session notices", async () => {
  const h = setup();
  const first = await h.post("/notify", notify);
  const id = `notify:${hash(notify.dedupeKey)}`;
  expect(first.status).toBe(202);
  expect(await first.json()).toEqual({ id, created: true });
  h.store.outboxState(id, "sent", 4242);
  const replay = await h.post("/notify", notify);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ id, created: false });
  expect(h.store.getOperation(id)).toEqual({ id, kind: "notification", text: "[tests] hello", state: "sent", attempts: 0, providerId: 4242 });
  for (const changed of [{ text: "different" }, { source: "other" }, { severity: "error" }]) {
    expect((await h.post("/notify", { ...notify, ...changed })).status).toBe(409);
  }
  expect(h.store.listReminders()).toEqual([]);
  expect(h.store.pendingSessionNotices()).toEqual([]);
});

test("all severities stay one-way notifications without a session binding", async () => {
  const h = setup();
  for (const severity of ["info", "attention", "error"]) {
    expect((await h.post("/notify", { ...notify, severity, dedupeKey: severity })).status).toBe(202);
  }
  expect(h.store.pendingOutbox().map(op => [op.kind, op.replyTo, op.keyboard]))
    .toEqual([["notification", undefined, undefined], ["notification", undefined, undefined], ["notification", undefined, undefined]]);
});

test("notify strips signed links and bearer text before durable queueing", async () => {
  const h = setup();
  const text = 'https://example.test/view?token=private-value token=other-private eyJfake.payload.signature';
  const response = await h.post("/notify", { ...notify, text });
  expect(response.status).toBe(202);
  expect(h.store.pendingOutbox()[0]?.text).toBe("[tests] https://example.test/view token=[redacted] [redacted]");
  expect((await h.post("/notify", { ...notify, text })).status).toBe(200);
});

test("identical legacy retries compare redacted content and retain the original operation", async () => {
  const h = setup();
  const id = `notify:${hash(notify.dedupeKey)}`;
  const text = "https://example.test/view?token=fake-private please answer";
  h.store.enqueue({ id, kind: "notification", text: `[tests] ${text}` });
  h.store.set(`api:notification:${id}`, { severity: "info" });
  expect((await h.post("/notify", { ...notify, text })).status).toBe(200);
  expect(h.store.pendingOutbox()).toHaveLength(1);
  expect(h.store.getOperation(id)?.text).toBe(`[tests] ${text}`);
  expect((await h.post("/notify", { ...notify, text: text + " changed" })).status).toBe(409);
});

test("ask and burst policy validation rejects invalid keys without consuming the first alert", async () => {
  const h = setup();
  for (const fields of [{ askKey: "" }, { burstKey: 5 }, { askKey: "x".repeat(201) }, { askKey: "a", burstKey: "b" }]) {
    expect((await h.post("/notify", { ...notify, ...fields })).status).toBe(400);
  }
  expect((await h.post("/notify", { ...notify, askKey: "card:q1" })).status).toBe(202);
  h.store.outboxState(`notify:${hash(notify.dedupeKey)}`, "sent");
  expect((await h.post("/notify", { ...notify, dedupeKey: "repeat", askKey: "card:q1" })).status).toBe(200);
  setSystemTime(now + 24 * 3_600_000);
  expect((await h.post("/notify", { ...notify, dedupeKey: "day-later", askKey: "card:q1" })).status).toBe(202);
});

test("strict schemas reject malformed notification fields and injected properties", async () => {
  const h = setup();
  for (const changed of [
    { source: "" }, { source: " " }, { source: "s".repeat(41) }, { source: "[spoof]" }, { source: "test\n" }, { source: "test\x1b" },
    { source: "\u00e9" }, { severity: "warning" }, { severity: "" }, { severity: 1 }, { text: "" }, { text: " \n" },
    { text: "a".repeat(12_001) }, { text: {} }, { dedupeKey: "" }, { dedupeKey: "k".repeat(201) }, { dedupeKey: 1 },
    { chatId: 200 }, { replyTo: 1 }, { keyboard: {} },
  ]) {
    const response = await h.post("/notify", { ...notify, ...changed });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request" });
  }
  expect((await h.post("/notify", { source: "s".repeat(40), severity: "error", text: "a".repeat(12_000), dedupeKey: "k".repeat(200) })).status).toBe(202);
});

test("reminder creation is atomic, deterministic, and replays the original result after mutations", async () => {
  const h = setup();
  const first = await h.post("/reminders", remind);
  expect(first.status).toBe(201);
  const result = await first.json();
  expect(result).toEqual({ id: `R${hash(remind.idempotencyKey).slice(0, 12)}`, text: "stretch",
    dueAt: Date.parse(at), timezone: "Asia/Dubai", status: "scheduled", revision: 1 });
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => h.post("/reminders", remind)));
  expect(concurrent.map(response => response.status)).toEqual(Array(8).fill(200));
  expect(h.store.listReminders()).toHaveLength(1);
  const snooze = await h.post(`/reminders/${result.id}/snooze`, { at: snoozeAt });
  expect(snooze.status).toBe(200);
  expect(await snooze.json()).toMatchObject({ id: result.id, status: "scheduled", revision: 2, dueAt: Date.parse(snoozeAt) });
  expect((await h.post(`/reminders/${result.id}/cancel`, {})).status).toBe(200);
  const replay = await h.post("/reminders", remind);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(result);
  expect(h.store.listReminders()[0]).toMatchObject({ status: "cancelled", revision: 2 });
  for (const change of [{ text: "different" }, { at: snoozeAt }, { timezone: "UTC" }]) {
    expect((await h.post("/reminders", { ...remind, ...change })).status).toBe(409);
  }
  setSystemTime(Date.parse(at) + 1);
  expect((await h.post("/reminders", { ...remind, idempotencyKey: "new-key" })).status).toBe(400);
});

test("reminder ID collisions and failed kv writes leave no partial state", async () => {
  const h = setup();
  const id = `R${hash(remind.idempotencyKey).slice(0, 12)}`;
  h.store.createReminder({ id, text: "collision", dueAt: now + 1000, timezone: "UTC" });
  expect((await h.post("/reminders", remind)).status).toBe(409);
  expect(h.store.get(`api:reminder:${hash(remind.idempotencyKey)}`)).toBeUndefined();
  h.store.db.exec("CREATE TRIGGER fail_kv BEFORE INSERT ON kv BEGIN SELECT RAISE(ABORT, 'PRIVATE_DB_ERROR'); END");
  const response = await h.post("/reminders", { ...remind, idempotencyKey: "other-key" });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "Operation could not be completed" });
  expect(h.store.listReminders()).toHaveLength(1);
  expect(h.store.pendingOutbox()).toEqual([]);
});

test("cancel/snooze respect queued delivery and hide unknown-ID or ambiguous-send errors", async () => {
  const h = setup();
  const reminder = await (await h.post("/reminders", remind)).json();
  h.store.enqueueDueReminders(Date.parse(at));
  const operationId = `reminder:${reminder.id}:1`;
  h.store.outboxState(operationId, "uncertain");
  for (const [path, body] of [[`/reminders/${reminder.id}/cancel`, {}], [`/reminders/${reminder.id}/snooze`, { at }],
    ["/reminders/PRIVATE_MISSING_ID/cancel", {}], ["/reminders/PRIVATE_MISSING_ID/snooze", { at }]] as const) {
    const response = await h.post(path, body);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Operation could not be completed" });
  }
  h.store.outboxState(operationId, "pending");
  expect((await h.post(`/reminders/${reminder.id}/cancel`, {})).status).toBe(200);
  expect(h.store.getOperation(operationId)?.state).toBe("cancelled");
  expect((await h.api(new Request(`http://bridge/reminders/${reminder.id}/cancel`, { method: "POST" }))).status).toBe(200);
});

test("reminder and snooze validation rejects missing offsets, rolled dates, past dates, and extra fields", async () => {
  const h = setup();
  const reminder = await (await h.post("/reminders", remind)).json();
  for (const value of ["tomorrow", "2026-09-11", "2026-09-11T10:00:00", "2026-02-30T10:00:00Z", "2026-09-11T24:00:00Z",
    "2026-09-11T10:00:00+24:00", "1969-01-01T00:00:00Z", new Date(now).toISOString(), "", 1]) {
    expect((await h.post("/reminders", { ...remind, at: value, idempotencyKey: "invalid" })).status).toBe(400);
    expect((await h.post(`/reminders/${reminder.id}/snooze`, { at: value })).status).toBe(400);
  }
  for (const change of [{ timezone: "Not/A_Zone" }, { timezone: "+04:00" }, { timezone: null }, { timezone: "" },
    { text: "" }, { text: "x".repeat(12_001) }, { idempotencyKey: " " }, { idempotencyKey: "k".repeat(201) }, { sessionId: "other" }]) {
    expect((await h.post("/reminders", { ...remind, ...change })).status).toBe(400);
  }
  expect((await h.post("/reminders/%ZZ/cancel", {})).status).toBe(400);
  expect((await h.post(`/reminders/${reminder.id}/cancel`, { at })).status).toBe(400);
  expect((await h.post(`/reminders/${reminder.id}/snooze`, { at, timezone: "UTC" })).status).toBe(400);
  expect((await h.post("/reminders", { ...remind, text: "--text=literal", timezone: "UTC", idempotencyKey: "explicit-zone" })).status).toBe(201);
});

test("list reads are latest-first, bounded, and cap stored fields", async () => {
  const h = setup();
  for (let i = 0; i < 110; i++) {
    h.store.createReminder({ id: `R${i}`, text: `reminder-${i}`, dueAt: now + (110 - i) * 1000, timezone: "UTC" });
    h.store.enqueue({ id: `notice-${i}`, kind: "notification", text: `notice-${i}` });
    h.store.outboxState(`notice-${i}`, i % 2 ? "sent" : "pending");
    h.store.enqueue({ id: `control-${i}`, kind: "control", text: "PRIVATE_CONTROL" });
  }
  const reminders = await (await h.get("/reminders")).json();
  expect(reminders.reminders).toHaveLength(100);
  expect(reminders.reminders[0].id).toBe("R109");
  expect(reminders.truncated).toBe(true);
  const notifications = await (await h.get("/notifications")).json();
  expect(notifications.notifications).toHaveLength(50);
  expect(notifications.notifications[0].id).toBe("notice-109");
  expect(notifications.truncated).toBe(true);
  const raw = await (await h.get("/notifications")).text();
  expect(raw).not.toContain("PRIVATE_CONTROL");
  expect(raw).not.toContain('"providerId":4');
  for (const row of notifications.notifications) {
    expect(row.kind).toBe("notification");
    expect(row.id.length).toBeLessThanOrEqual(200);
    expect(row.text.length).toBeLessThanOrEqual(512);
  }
});

test("notification lookup serves exact ids, numbers as provider aliases, and nothing else", async () => {
  const h = setup();
  h.store.enqueue({ id: "notice-1", kind: "notification", text: "visible text" });
  h.store.enqueue({ id: "control-1", kind: "control", text: "PRIVATE_CONTROL" });
  h.store.outboxState("notice-1", "sent", 4242);
  expect(await (await h.get("/notifications/notice-1")).json()).toEqual({ id: "notice-1", text: "visible text" });
  expect(await (await h.get("/notifications/4242")).json()).toEqual({ id: "notice-1", text: "visible text" });
  expect((await h.get("/notifications/control-1")).status).toBe(404);
  expect((await h.get("/notifications/missing")).status).toBe(404);
  expect((await h.get("/notifications/" + encodeURIComponent("unknown id"))).status).toBe(404);
  expect((await h.get("/notifications/" + encodeURIComponent("bad\nid"))).status).toBe(400);
});

test("mutations require an enabled, paired bridge", async () => {
  const h = setup();
  for (const state of [{ enabled: false }, { chat: undefined }]) {
    Object.assign(h.state, state);
    for (const [path, body] of [["/notify", notify], ["/files", file], ["/reminders", remind],
      ["/reminders/R1/cancel", {}]] as const) {
      const response = await h.post(path, body);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Bridge is not ready" });
    }
  }
  expect(h.store.pendingOutbox()).toEqual([]);
  expect(h.store.listReminders()).toEqual([]);
});

test("Origin is rejected on every route and methods and unknown paths fail closed", async () => {
  const h = setup();
  for (const origin of ["https://untrusted.invalid", "null", ""]) {
    for (const path of ["/health", "/reminders", "/notifications", "/notifications/notice-1"]) {
      expect((await h.api(new Request(`http://bridge${path}`, { headers: { Origin: origin } }))).status).toBe(403);
    }
    expect((await h.post("/notify", notify, { Origin: origin })).status).toBe(403);
    expect((await h.post("/files", file, { Origin: origin })).status).toBe(403);
  }
  for (const [method, path] of [["GET", "/missing"], ["GET", "/notify"], ["GET", "/files"], ["PUT", "/files"],
    ["PUT", "/reminders"], ["OPTIONS", "/notify"], ["POST", "/health"], ["POST", "/notifications"]]) {
    const response = await h.api(new Request(`http://bridge${path}`, { method }));
    expect(response.status).toBe(404);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  }
  expect(h.store.pendingOutbox()).toEqual([]);
});

test("body parsing rejects malformed JSON, types, encodings, and oversize declared or streamed bytes", async () => {
  const h = setup();
  for (const body of ["{PRIVATE_JSON", "null", "[]", "true", "1", '"string"', ""]) {
    const response = await h.api(new Request("http://bridge/notify", { method: "POST", headers: { "Content-Type": "application/json" }, body }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request" });
  }
  expect((await h.post("/notify", notify, { "Content-Type": "text/plain" })).status).toBe(400);
  expect((await h.post("/notify", notify, { "Content-Length": "20481" })).status).toBe(413);
  expect((await h.post("/notify", notify, { "Content-Length": "-1" })).status).toBe(400);
  expect((await h.post("/notify", { ...notify, text: "\u4e2d".repeat(7000) })).status).toBe(413);
  const invalid = new Request("http://bridge/notify", { method: "POST", headers: { "Content-Type": "application/json" }, body: new Uint8Array([0xff]) });
  expect((await h.api(invalid)).status).toBe(400);
  let cancelled = false;
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(4096).fill(32)); },
    cancel() { cancelled = true; },
  });
  const response = await h.api(new Request("http://bridge/notify", {
    method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "1" }, body: stream,
  }));
  expect(response.status).toBe(413);
  expect(cancelled).toBe(true);
  expect(reads).toBeLessThanOrEqual(7);
  expect(h.store.pendingOutbox()).toEqual([]);
});

test("files atomically queue bytes and descriptors as one-time notifications", async () => {
  const h = setup();
  const response = await h.post("/files", file);
  const id = `file:${hash(file.dedupeKey)}`;
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ id, created: true });
  const data = Buffer.from(file.base64, "base64");
  const attachment = { sha256: createHash("sha256").update(data).digest("hex"), name: file.name, mimeType: file.mimeType, size: data.length };
  expect(h.store.getOperation(id)).toEqual({ id, kind: "notification", text: file.text, attachment, state: "pending", attempts: 0 });
  expect(Buffer.from(h.store.getBlob(attachment.sha256))).toEqual(data);
  h.store.outboxState(id, "sent", 4242);
  const replay = await h.post("/files", file);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ id, created: false });
  expect(h.store.getOperation(id)?.state).toBe("sent");
  // A changed spec under the same dedupe key is a conflict, not a mutation.
  for (const change of [{ text: "other" }, { name: "other.pdf" }, { mimeType: "text/plain" }]) {
    expect((await h.post("/files", { ...file, ...change })).status).toBe(409);
  }
});

test("files accept only strict canonical base64 and bounded metadata", async () => {
  const h = setup();
  for (const base64 of [undefined, null, 123, [], "", "YQ", "YQ=", "YQ===", "YR==", "YWJ=", "YWJj\n", " YWJj",
    "Y WJj", "-w==", "_w==", "====", "YQ==YWJj", "YQ==\x00", "data:text/plain;base64,YQ=="]) {
    expect((await h.post("/files", { ...file, base64 })).status).toBe(400);
  }
  for (const name of [undefined, null, 1, "", " ", ".", "..", "/tmp/report.pdf", "dir/report.pdf", "dir\\report.pdf",
    "report\n.pdf", "report\x00.pdf", "report\x7f.pdf", "x".repeat(256)]) {
    expect((await h.post("/files", { ...file, name })).status).toBe(400);
  }
  for (const change of [{ dedupeKey: undefined }, { dedupeKey: "" }, { dedupeKey: "k".repeat(201) },
    { text: "t".repeat(12_001) }, { file: "/PRIVATE_FILE" }, { path: "/PRIVATE_FILE" },
    { chatId: 200 }, { replyTo: 1 }, { keyboard: {} }]) {
    const response = await h.post("/files", { ...file, ...change });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request" });
  }
  expect((await h.post("/files", { ...file, base64: "/w==", name: "x".repeat(255), mimeType: "x/" + "a".repeat(98),
    text: "t".repeat(12_000), dedupeKey: "k".repeat(200) })).status).toBe(202);
  expect((await h.post("/files", { ...file, text: undefined, dedupeKey: "empty-caption" })).status).toBe(202);
});

test("files accept exactly 20 MiB and reject larger decoded bytes", async () => {
  const h = setup();
  const data = Buffer.alloc(MAX_FILE_BYTES, 0xff);
  expect((await h.post("/files", { ...file, base64: data.toString("base64") })).status).toBe(202);
  const operation = h.store.getOperation(`file:${hash(file.dedupeKey)}`)!;
  expect(operation.attachment?.size).toBe(MAX_FILE_BYTES);
  expect(Buffer.from(h.store.getBlob(operation.attachment!.sha256))).toEqual(data);
  for (const extra of [1, 2]) {
    expect((await h.post("/files", { ...file, base64: Buffer.alloc(MAX_FILE_BYTES + extra).toString("base64"), dedupeKey: "oversize" })).status).toBe(413);
  }
  expect(h.store.db.query("SELECT sha256 FROM blobs").all()).toHaveLength(1);
});

test("only /files has a 28 MiB JSON budget, including declared and streaming limits", async () => {
  const h = setup();
  expect((await h.post("/files", file, { "Content-Length": String(MAX_FILE_BODY) })).status).toBe(202);
  expect((await h.post("/files", { ...file, dedupeKey: "boundary" }, { "Content-Length": String(MAX_FILE_BODY + 1) })).status).toBe(413);
  expect((await h.post("/files", file, { "Content-Type": "text/plain" })).status).toBe(400);
  expect((await h.post("/files", file, { "Content-Length": "-1" })).status).toBe(400);
  for (const path of ["/notify", "/reminders", "/reminders/R1/cancel"]) {
    expect((await h.post(path, { ...notify, text: "x".repeat(20 * 1024) })).status).toBe(413);
  }
  let reads = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(1024 * 1024).fill(32)); },
    cancel() { cancelled = true; },
  });
  expect((await h.api(new Request("http://bridge/files", {
    method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "1" }, body: stream,
  }))).status).toBe(413);
  expect(cancelled).toBe(true);
  expect(reads).toBeLessThanOrEqual(30);
});
