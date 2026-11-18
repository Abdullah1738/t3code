import { afterEach, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { Delivery } from "../src/delivery.ts";
import { TransportError } from "../src/photon.ts";

const dirs: string[] = [];
const stores: Store[] = [];
const originalRoot = process.env.HEALTH_TOOLLOG_DIR;
afterEach(() => {
  mock.restore();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalRoot === undefined) delete process.env.HEALTH_TOOLLOG_DIR;
  else process.env.HEALTH_TOOLLOG_DIR = originalRoot;
});
function setup(mode = "invalid-upload") {
  const dir = mkdtempSync(join(tmpdir(), "health-delivery-"));
  dirs.push(dir);
  const path = join(dir, "store.sqlite");
  const store = new Store(path);
  stores.push(store);
  const bytes = Buffer.from("synthetic PNG");
  const sha256 = store.putBlob(bytes);
  const createdAt = new Date(Date.now() - 1_000).toISOString();
  const metadata = { version: 1 as const, runId: "a".repeat(32), kind: "card" as const, createdAt,
    cardId: "b".repeat(32), cardIds: ["b".repeat(32)], sha256 };
  store.enqueue({ id: "file:test", kind: "notification", text: "PrivateFoodCaptionToken",
    attachment: { sha256, name: "card.png", mimeType: "image/png", size: bytes.length }, healthReceipt: metadata });
  if (mode === "invalid-blob") store.db.query("DELETE FROM blobs").run();
  const transport = {
    sendText: mock(async () => ({ providerId: "accepted-caption" })),
    uploadAttachment: mock(async () => {
      if (mode === "upload-timeout" || mode === "retrying-upload") throw new TransportError("attachmentTimeout", mode === "retrying-upload", false);
      return { guid: mode === "invalid-upload" ? "" : "uploaded" };
    }),
    sendAttachment: mock(async () => {
      if (mode === "send-invalid") throw new TransportError("invalidAttachment", false, false);
      if (mode === "ambiguous-send") throw new TransportError("attachmentTimeout", false, true);
      return { providerId: "accepted-file" };
    }),
  };
  const options = { projectScope: "health-test", enabled: () => true, chatGuid: () => "synthetic-chat", sleep: async () => {} };
  const root = join(dir, "health");
  process.env.HEALTH_TOOLLOG_DIR = root;
  return { dir, path, store, transport, options, root, createdAt, metadata };
}
function receipts(root: string, createdAt: string) {
  const path = join(root, "receipts", `${createdAt.slice(0, 10)}.ndjson`);
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}

test.each([
  ["invalid-upload", "io_error"], ["send-invalid", "io_error"], ["invalid-blob", "io_error"],
  ["upload-timeout", "timeout"], ["unsupported", "not_authorized"],
])("actual Delivery %s keeps its mapped terminal tag %s", async (mode, tag) => {
  const h = setup(mode);
  const transport = mode === "unsupported" ? { sendText: h.transport.sendText } : h.transport;
  const delivery = new Delivery(h.store, transport, h.options);
  await delivery.tick();
  expect(h.store.getOperation("file:test")?.state).toBe("failed");
  await delivery.tick();
  const rows = receipts(h.root, h.createdAt);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ ...h.metadata, ok: false, errorTag: tag });
  expect(JSON.stringify(rows)).not.toContain("PrivateFoodCaptionToken");
});

test.each(["sent", "skip", "retry", "none"] as const)("blocked spool survives fallback=%s and process restart", async fallbackResult => {
  const h = setup();
  const blocked = join(h.dir, "blocked");
  writeFileSync(blocked, "not a directory");
  process.env.HEALTH_TOOLLOG_DIR = blocked;
  const fallback = mock(async () => fallbackResult === "none" ? "retry" as const : fallbackResult);
  const delivery = new Delivery(h.store, h.transport, { ...h.options,
    ...(fallbackResult === "none" ? {} : { fallback }) });
  await delivery.tick();
  const expectedState = fallbackResult === "sent" ? "fallback" : "failed";
  expect(h.store.getOperation("file:test")?.state).toBe(expectedState);
  expect(receipts(h.root, h.createdAt)).toHaveLength(0);
  expect(JSON.stringify(h.store.get("health-receipt-pending:file:test:failed"))).not.toContain("PrivateFoodCaptionToken");
  h.store.close();
  stores.splice(stores.indexOf(h.store), 1);
  const reopened = new Store(h.path);
  stores.push(reopened);
  process.env.HEALTH_TOOLLOG_DIR = h.root;
  const resumed = new Delivery(reopened, h.transport, { ...h.options, enabled: () => false });
  await resumed.tick();
  await resumed.tick();
  const rows = receipts(h.root, h.createdAt);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ ok: false, errorTag: "io_error", runId: h.metadata.runId });
  expect(reopened.getOperation("file:test")?.state).toBe(expectedState);
  expect(h.transport.uploadAttachment).toHaveBeenCalledTimes(1);
  expect(h.transport.sendAttachment).not.toHaveBeenCalled();
  expect(fallback).toHaveBeenCalledTimes(fallbackResult === "none" ? 0 : 1);
});

test.each(["retrying-upload", "ambiguous-send", "cancelled"])("%s is not a terminal receipt", async mode => {
  const h = setup(mode);
  const delivery = new Delivery(h.store, h.transport, { ...h.options,
    ...(mode === "cancelled" ? { beforeSend: async () => "cancel" as const } : {}) });
  await delivery.tick();
  expect(h.store.getOperation("file:test")?.state).toBe(mode === "retrying-upload" ? "pending" : mode === "ambiguous-send" ? "uncertain" : "cancelled");
  expect(receipts(h.root, h.createdAt)).toHaveLength(0);
});

test("accepted send survives blocked spool and restart without repeating provider send", async () => {
  const h = setup("success");
  const blocked = join(h.dir, "blocked");
  writeFileSync(blocked, "blocked");
  process.env.HEALTH_TOOLLOG_DIR = blocked;
  await new Delivery(h.store, h.transport, h.options).tick();
  expect(h.store.getOperation("file:test")?.state).toBe("sent");
  h.store.close();
  stores.splice(stores.indexOf(h.store), 1);
  const reopened = new Store(h.path);
  stores.push(reopened);
  process.env.HEALTH_TOOLLOG_DIR = h.root;
  const delivery = new Delivery(reopened, h.transport, h.options);
  await delivery.tick();
  await delivery.tick();
  expect(receipts(h.root, h.createdAt)).toHaveLength(1);
  expect(receipts(h.root, h.createdAt)[0]).toMatchObject({ ok: true, errorTag: "none" });
  expect(h.transport.sendAttachment).toHaveBeenCalledTimes(1);
});
