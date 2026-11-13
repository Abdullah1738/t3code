import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, callbackToken, sessionNoticeId, type OutboxOperation, type SessionNotice } from "../src/store.ts";
import { useToolLogFixture } from "./toollog-fixture.ts";

const logs = useToolLogFixture();

const stores: Store[] = [];
const directories: string[] = [];
const now = Date.parse("2026-09-10T12:00:00Z");

function open(path = ":memory:"): Store {
  const store = new Store(path);
  stores.push(store);
  return store;
}

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "telegram-store-test-"));
  directories.push(directory);
  return join(directory, "store.sqlite");
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("session notice ids are stable and callback tokens are derived from them", () => {
  const first = sessionNoticeId("/Chats", "ses_1", "question", "q_1");
  const second = sessionNoticeId("/Chats", "ses_1", "question", "q_1");
  expect(first).toBe(second);
  expect(first).toMatch(/^session-notice:[0-9a-f]{64}$/);
  expect(sessionNoticeId("/Chats", "ses_1", "approval", "q_1")).not.toBe(first);
  expect(sessionNoticeId("/Chats", "ses_2", "question", "q_1")).not.toBe(first);
  expect(callbackToken(first)).toMatch(/^[0-9a-f]{16}$/);
  expect(callbackToken(first)).toBe(callbackToken(first));
  expect(callbackToken(first)).not.toBe(callbackToken(sessionNoticeId("/Chats", "ses_1", "approval", "q_1")));
});

test("persists JSON, outbox delivery with numeric provider ids, and reminders across reopen", () => {
  const path = databasePath();
  let store = open(path);
  expect(store.db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  expect(store.db.query("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
  store.set("chat", 12345);
  store.set("nullable", null);
  store.enqueue({ id: "op-1", kind: "notification", text: "hello" });
  store.outboxState("op-1", "sending");
  store.outboxState("op-1", "sent", 4242);
  const reminder = store.createReminder({ id: "R1", text: "Stretch", dueAt: now + 60_000, timezone: "UTC" });
  store.close();

  store = open(path);
  expect(store.get<number>("chat")).toBe(12345);
  expect(store.get("nullable")).toBeNull();
  expect(store.byProviderId(4242)).toMatchObject({ id: "op-1", state: "sent", attempts: 1, providerId: 4242 });
  expect(store.listReminders()).toEqual([reminder]);
});

test("outbox dedupes normalized content including keyboards and rejects every changed field", () => {
  const store = open();
  const keyboard = { rows: [[{ text: "Approve once", data: "a:tok:once" }, { text: "Reject", data: "a:tok:reject" }]] };
  const op: OutboxOperation = { id: "op", kind: "control", text: "prompt", replyTo: 99, keyboard };
  expect(store.enqueue(op)).toBe(true);
  expect(store.enqueue({ keyboard, replyTo: 99, text: "prompt", kind: "control", id: "op" })).toBe(false);
  const changes: Partial<OutboxOperation>[] = [
    { text: "changed" }, { kind: "notification" }, { replyTo: 1 }, { replyTo: undefined },
    { keyboard: { remove: true } }, { keyboard: undefined },
  ];
  for (const change of changes) expect(() => store.enqueue({ ...op, ...change })).toThrow("content mismatch");
  expect(store.pendingOutbox()).toEqual([{ ...op, state: "pending", attempts: 0 }]);
});

test("interrupted sends reopen as uncertain and attempts count dispatch rounds, not RPCs", () => {
  const store = open();
  store.enqueue({ id: "op", kind: "notification", text: "hello" });
  store.outboxState("op", "sending", 777);
  expect(store.getOperation("op")).toMatchObject({ state: "sending", attempts: 1, providerId: 777 });
  store.outboxState("op", "sending", 778);
  expect(store.getOperation("op")).toMatchObject({ state: "sending", attempts: 1, providerId: 778 });
  // A recovery round-trip through pending counts the next dispatch attempt.
  store.outboxState("op", "pending");
  store.outboxState("op", "sending");
  expect(store.getOperation("op")).toMatchObject({ state: "sending", attempts: 2, providerId: 778 });
  store.outboxState("op", "sent", 779);
  expect(store.getOperation("op")).toMatchObject({ state: "sent", attempts: 2, providerId: 779 });
  expect(store.findOutbox("779")).toMatchObject({ id: "op" });
  expect(store.findOutbox("not-a-number")).toBeUndefined();
  expect(() => store.outboxState("missing", "sent")).toThrow("Unknown outbox");
});

test("session notices persist states, queue control operations with keyboards, and stay deduplicated", () => {
  const store = open();
  const id = sessionNoticeId("/Chats", "ses_1", "question", "q_1");
  const notice: SessionNotice = { id, kind: "question", sessionId: "ses_1", directory: "/Chats",
    requestId: "q_1", firstSeen: now, state: "pending" };
  store.saveSessionNotice(notice);
  store.saveSessionNotice({ ...notice, state: "cancelled" });
  expect(store.sessionNotice(id)).toMatchObject({ state: "cancelled" });
  expect(store.pendingSessionNotices()).toEqual([]);
  store.saveSessionNotice({ ...notice, state: "pending" });
  store.saveSessionNotice({ ...notice, state: "queued", signature: "sig" });
  expect(store.pendingSessionNotices()).toEqual([{ ...notice, state: "queued", signature: "sig" }]);
  const keyboard = { rows: [[{ text: "Yes", data: "q:tok:0:0" }]] };
  store.enqueueSessionNotice({ ...notice, state: "queued", signature: "sig" }, "Question prompt", keyboard);
  expect(store.getOperation(id)).toMatchObject({ id, kind: "control", text: "Question prompt", state: "pending", keyboard });
  expect(store.sessionNotice(id)?.state).toBe("queued");
  // Review notices become plain notifications; interactive kinds stay control prompts.
  const reviewId = sessionNoticeId("/Chats", "ses_1", "review", 3);
  store.enqueueSessionNotice({ id: reviewId, kind: "review", sessionId: "ses_1", directory: "/Chats",
    workRevision: 3, firstSeen: now, state: "pending" }, "Ready for review");
  expect(store.getOperation(reviewId)).toMatchObject({ kind: "notification", text: "Ready for review" });
});

test("due reminders enqueue once with bounded text and follow delivery through to sent", () => {
  const path = databasePath();
  const first = open(path);
  const second = open(path);
  first.createReminder({ id: "Rdue", text: "Take a break", dueAt: now, timezone: "Asia/Dubai" });
  first.createReminder({ id: "Rfuture", text: "Tomorrow", dueAt: now + 86_400_000, timezone: "UTC" });
  expect(first.enqueueDueReminders(now - 1)).toBe(0);
  expect(first.enqueueDueReminders(now)).toBe(1);
  expect(second.enqueueDueReminders(now)).toBe(0);
  const [op] = first.pendingOutbox();
  expect(op).toMatchObject({ id: "reminder:Rdue:1", kind: "notification", state: "pending", attempts: 0 });
  expect(op?.text).toContain("[Reminder Rdue] Take a break");
  expect(op?.text).toContain("Asia/Dubai");
  expect(op?.text).toContain(new Date(now).toISOString());
  expect(op?.text).not.toContain("[late]");
  expect(first.listReminders()[0]).toMatchObject({ status: "queued", operationId: op!.id });
  first.close();
  second.close();
  const reopened = open(path);
  expect(reopened.enqueueDueReminders(now)).toBe(0);
  reopened.outboxState("reminder:Rdue:1", "sent", 505);
  expect(reopened.listReminders()[0].status).toBe("sent");
  expect(reopened.byProviderId(505)?.id).toBe("reminder:Rdue:1");
  const late = reopened.createReminder({ id: "Rlate", text: "Check", dueAt: now - 60_001, timezone: "UTC" });
  expect(reopened.enqueueDueReminders(now)).toBe(1);
  expect(reopened.getOperation(`reminder:${late.id}:1`)?.text).toContain("[late]");
  expect(() => reopened.enqueueDueReminders(NaN)).toThrow("Invalid reminder clock");
});

test("snooze cancels the previous unsent revision and ambiguous sends refuse changes", () => {
  const store = open();
  store.createReminder({ id: "Rsnooze", text: "Check again", dueAt: now, timezone: "UTC" });
  store.enqueueDueReminders(now);
  const snoozed = store.snoozeReminder("Rsnooze", now + 120_000);
  expect(snoozed).toMatchObject({ status: "scheduled", revision: 2, dueAt: now + 120_000 });
  expect(snoozed.operationId).toBeUndefined();
  expect(store.getOperation("reminder:Rsnooze:1")?.state).toBe("cancelled");
  expect(store.enqueueDueReminders(now)).toBe(0);
  expect(store.enqueueDueReminders(now + 120_000)).toBe(1);
  store.outboxState("reminder:Rsnooze:2", "sending");
  expect(() => store.cancelReminder("Rsnooze")).toThrow("ambiguous send");
  expect(() => store.snoozeReminder("Rsnooze", now + 240_000)).toThrow("ambiguous send");
  store.outboxState("reminder:Rsnooze:2", "uncertain");
  expect(() => store.cancelReminder("Rsnooze")).toThrow("ambiguous send");
  store.outboxState("reminder:Rsnooze:2", "sent", 606);
  expect(store.cancelReminder("Rsnooze").status).toBe("cancelled");
  expect(() => store.cancelReminder("missing")).toThrow("Unknown reminder");
  expect(() => store.snoozeReminder("missing", now)).toThrow("Unknown reminder");
  expect(() => store.snoozeReminder("Rsnooze", Infinity)).toThrow();
  expect(() => store.createReminder({ text: "Invalid", dueAt: NaN, timezone: "UTC" })).toThrow();
  expect(() => store.createReminder({ text: "Invalid", dueAt: now, timezone: "not/a/zone" })).toThrow();
});

test("blobs are content-addressed, size-bounded, and verified on read", () => {
  const store = open();
  const data = Buffer.from("PRIVATE_ATTACHMENT");
  const sha256 = store.putBlob(data);
  expect(store.putBlob(data)).toBe(sha256);
  expect(Buffer.from(store.getBlob(sha256))).toEqual(data);
  expect(() => store.putBlob(Buffer.alloc(20 * 1024 * 1024 + 1))).toThrow("exceeds 20 MiB");
  expect(() => store.getBlob("f".repeat(64))).toThrow("unavailable");
});

test("tg.dedupe logs normalized replays and conflicts without operation content", () => {
  const store = open();
  const op: OutboxOperation = { id: "PRIVATE_KEY", kind: "notification", text: "PRIVATE_MESSAGE" };
  expect(store.enqueue(op)).toBe(true);
  expect(store.enqueue(op)).toBe(false);
  expect(() => store.enqueue({ ...op, text: "PRIVATE_CHANGED_BODY" })).toThrow("content mismatch");
  expect(logs.entries()).toMatchObject([
    { tool: "watchers", name: "tg.dedupe", kind: "event", ok: true, props: { action: "check", deduped: true } },
    { tool: "watchers", name: "tg.dedupe", kind: "error", ok: false, props: { action: "conflict" },
      error: { tag: "tg.dedupe.contentConflict", message: "tg.dedupe.contentConflict" } },
  ]);
  for (const row of logs.entries()) {
    expect(row.ids?.key).toMatch(/^[a-f0-9]{24}$/);
    expect(row.ids?.operation).toBe(row.ids?.key);
  }
  expect(logs.text()).not.toContain("PRIVATE_");
});

test("tg.reminder records lifecycle transitions and failed mutations without reminder text or due dates", () => {
  const store = open();
  const id = "PRIVATE_REMINDER";
  store.createReminder({ id, text: "PRIVATE_HEALTH_VALUE", dueAt: now, timezone: "Asia/Dubai" });
  store.enqueueDueReminders(now);
  store.snoozeReminder(id, now + 120_000);
  store.enqueueDueReminders(now + 120_000);
  store.outboxState(`reminder:${id}:2`, "sending");
  expect(() => store.cancelReminder(id)).toThrow("ambiguous send");
  store.outboxState(`reminder:${id}:2`, "sent", 900);
  store.cancelReminder(id);
  expect(() => store.snoozeReminder("PRIVATE_MISSING", now)).toThrow("Unknown reminder");
  expect(() => store.createReminder({ id: "PRIVATE_INVALID", text: "PRIVATE_HEALTH_VALUE", dueAt: NaN, timezone: "UTC" })).toThrow();
  expect(() => store.enqueueDueReminders(NaN)).toThrow("Invalid reminder clock");
  const entries = logs.entries().filter(row => row.name === "tg.reminder");
  expect(entries.filter(row => row.ok).map(row => [row.props?.action, row.props?.state])).toEqual([
    ["create", "scheduled"], ["queue", "queued"], ["snooze", "scheduled"], ["queue", "queued"],
    ["send", "sending"], ["sent", "sent"], ["cancel", "cancelled"],
  ]);
  expect(entries.filter(row => row.ok === false).map(row => row.error?.tag)).toEqual([
    "tg.reminder.cancelFailed", "tg.reminder.snoozeFailed", "tg.reminder.createFailed", "tg.reminder.queueFailed",
  ]);
  for (const row of entries.filter(row => row.ids?.reminder)) expect(row.ids?.reminder).toMatch(/^[a-f0-9]{24}$/);
  for (const forbidden of ["PRIVATE_", "Asia/Dubai", new Date(now).toISOString()]) expect(logs.text()).not.toContain(forbidden);
});
