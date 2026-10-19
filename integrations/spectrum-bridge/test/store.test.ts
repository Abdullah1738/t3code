import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type OutboxOperation } from "../src/store.ts";

const stores: Store[] = [];
const directories: string[] = [];

function open(path = ":memory:"): Store {
  const store = new Store(path);
  stores.push(store);
  return store;
}

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "spectrum-store-test-"));
  directories.push(directory);
  return join(directory, "store.sqlite");
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("persists JSON, inbound state, and outbox delivery across reopen", () => {
  const path = databasePath();
  let store = open(path);
  expect(store.db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  expect(store.db.query("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
  expect(store.get("missing")).toBeUndefined();
  store.set("session", { id: "new", generation: 2 });
  store.set("nullable", null);
  store.set("disabled", false);
  store.acceptInbound("in-1", { text: "first" });
  store.updateInbound("in-1", "processing", { text: "first", operationId: "op-1" });
  store.acceptInbound("in-2", { text: "done" });
  store.updateInbound("in-2", "complete");
  store.enqueue({ id: "op-1", kind: "conversation", text: "answer", sessionId: "new", generation: 2, replyTo: "in-1" });
  store.outboxState("op-1", "sending");
  store.outboxState("op-1", "sent", "provider-1");
  store.close();

  store = open(path);
  expect(store.get<{ id: string; generation: number }>("session")).toEqual({ id: "new", generation: 2 });
  expect(store.get("nullable")).toBeNull();
  expect(store.get<boolean>("disabled")).toBe(false);
  expect(store.pendingInbound()).toEqual([
    { id: "in-1", state: "processing", payload: { text: "first", operationId: "op-1" } },
  ]);
  expect(store.acceptInbound("in-2", { text: "do not repeat" })).toBe(false);
  expect(store.pendingOutbox()).toEqual([]);
  expect(store.byProviderId("provider-1")).toEqual({
    id: "op-1", kind: "conversation", text: "answer", sessionId: "new", generation: 2,
    replyTo: "in-1", state: "sent", attempts: 1, providerId: "provider-1",
  });
});

test("inbound dedupe never replaces payload; updates preserve omitted payload and accept null", () => {
  const store = open();
  const id = "in'); DROP TABLE inbound; --";
  expect(store.acceptInbound(id, { text: "original" })).toBe(true);
  expect(store.acceptInbound(id, { text: "changed" })).toBe(false);
  store.updateInbound(id, "processing");
  expect(store.pendingInbound()).toEqual([{ id, state: "processing", payload: { text: "original" } }]);
  store.updateInbound(id, "pending", null);
  expect(store.pendingInbound()).toEqual([{ id, state: "pending", payload: null }]);
  store.updateInbound(id, "done");
  expect(store.pendingInbound()).toEqual([]);
  expect(() => store.updateInbound("missing", "processing")).toThrow("Unknown inbound");
});

test("outbox dedupes normalized content and rejects every changed operation field", () => {
  const path = databasePath();
  const store = open(path);
  const op: OutboxOperation = {
    id: "op", kind: "notification", text: "message", sessionId: "s", generation: 0, replyTo: "in",
  };
  expect(store.enqueue(op)).toBe(true);
  expect(store.enqueue({ replyTo: "in", generation: 0, sessionId: "s", text: "message", kind: "notification", id: "op" })).toBe(false);
  const changes: Partial<OutboxOperation>[] = [
    { text: "changed" }, { kind: "control" }, { sessionId: "other" },
    { generation: 1 }, { replyTo: "other" }, { generation: undefined },
    { notice: { kind: "runtime-request", session: "s", recordId: "perm-1" } },
  ];
  for (const change of changes) expect(() => store.enqueue({ ...op, ...change })).toThrow("content mismatch");
  expect(store.pendingOutbox()).toEqual([{ ...op, state: "pending", attempts: 0 }]);
  store.outboxState("op", "sent", "provider");
  store.close();
  const reopened = open(path);
  expect(reopened.enqueue(op)).toBe(false);
  expect(() => reopened.enqueue({ ...op, text: "conflict after restart" })).toThrow("content mismatch");
  expect(reopened.pendingOutbox()).toEqual([]);
});

test("findOutbox looks up operations by operation ID as well as provider ID", () => {
  const store = open();
  store.enqueue({ id: "notice", kind: "notification", text: "hello" });
  expect(store.findOutbox("notice")).toEqual(store.getOperation("notice"));
  store.outboxState("notice", "sending");
  store.outboxState("notice", "sending");
  expect(store.getOperation("notice")?.attempts).toBe(1);
  store.outboxState("notice", "sent", "provider-notice");
  store.outboxState("notice", "sent");
  expect(store.findOutbox("provider-notice")).toEqual(store.getOperation("notice"));
  expect(store.findOutbox("missing")).toBeUndefined();
  expect(store.byProviderId("missing")).toBeUndefined();
  expect(store.getOperation("missing")).toBeUndefined();
  expect(() => store.outboxState("missing", "sent")).toThrow("Unknown outbox");
});

test("session replacement leaves inbound dedupe and queued operations independent", () => {
  const path = databasePath();
  const store = open(path);
  store.set("session", { id: "old", generation: 1 });
  store.acceptInbound("old-message", { text: "remind me" });
  store.updateInbound("old-message", "complete");
  store.enqueue({ id: "notification", kind: "notification", text: "Still valid" });
  store.set("session", { id: "new", generation: 2 });
  store.close();
  const reopened = open(path);
  expect(reopened.acceptInbound("old-message", { text: "replay" })).toBe(false);
  expect(reopened.pendingOutbox().map(op => op.id)).toEqual(["notification"]);
});

test("interrupted sends become uncertain, never pending, and inbound processing stays reconcilable", () => {
  const path = databasePath();
  const store = open(path);
  store.acceptInbound("processing", { operationId: "sending" });
  store.updateInbound("processing", "processing");
  store.acceptInbound("pending", { text: "next" });
  for (const id of ["sending", "pending", "failed", "sent", "cancelled"]) {
    store.enqueue({ id, kind: "conversation", text: id });
    if (id !== "pending") store.outboxState(id, id, id === "sending" ? "maybe-delivered" : undefined);
  }
  store.close();
  const reopened = open(path);
  expect(reopened.getOperation("sending")).toMatchObject({ state: "uncertain", attempts: 1, providerId: "maybe-delivered" });
  expect(reopened.pendingOutbox().map(op => op.id)).toEqual(["pending"]);
  expect(reopened.pendingInbound().map(row => row.state)).toEqual(["processing", "pending"]);
  for (const state of ["failed", "sent", "cancelled"]) expect(reopened.getOperation(state)?.state).toBe(state);
  reopened.close();
  const again = open(path);
  expect(again.getOperation("sending")?.state).toBe("uncertain");
  expect(again.enqueue({ id: "sending", kind: "conversation", text: "sending" })).toBe(false);
  again.outboxState("sending", "sent");
  expect(again.byProviderId("maybe-delivered")?.state).toBe("sent");
});

test("provider ID conflicts roll back the delivery state change", () => {
  const store = open();
  store.enqueue({ id: "other", kind: "notification", text: "Already sent" });
  store.outboxState("other", "sent", "same-provider");
  store.enqueue({ id: "atomic", kind: "conversation", text: "In flight" });
  store.outboxState("atomic", "sending");
  expect(() => store.outboxState("atomic", "sent", "same-provider")).toThrow();
  expect(store.getOperation("atomic")?.state).toBe("sending");
});

test("invalid JSON fails without replacing durable data", () => {
  const store = open();
  store.set("value", "original");
  expect(() => store.set("value", undefined)).toThrow("JSON serializable");
  expect(store.get<string>("value")).toBe("original");
});

test("blobs are content-addressed, size-bounded, and verified on read", () => {
  const store = open();
  const data = Buffer.from("PRIVATE_ATTACHMENT");
  const sha256 = store.putBlob(data);
  expect(sha256).toHaveLength(64);
  expect(store.putBlob(data)).toBe(sha256);
  expect(Buffer.from(store.getBlob(sha256))).toEqual(data);
  expect(() => store.putBlob(Buffer.alloc(20 * 1024 * 1024 + 1))).toThrow("exceeds 20 MiB");
  expect(() => store.getBlob("f".repeat(64))).toThrow("unavailable");
  store.db.exec("UPDATE blobs SET data = x'00' WHERE sha256 = ?", [sha256]);
  expect(() => store.getBlob(sha256)).toThrow("unavailable");
});

test("kv writes are durable and atomic under conflict", () => {
  const path = databasePath();
  const store = open(path);
  store.set("counter", 1);
  store.set("counter", 2);
  store.close();
  const reopened = open(path);
  expect(reopened.get<number>("counter")).toBe(2);
  reopened.set("counter", 3);
  expect(reopened.get<number>("counter")).toBe(3);
});
