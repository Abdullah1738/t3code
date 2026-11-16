import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flushHealthReceipts, parseHealthSidecar, readHealthSidecar } from "../src/health-receipts.ts";
import { Store } from "../src/store.ts";

const dirs: string[] = [];
const stores: Store[] = [];
const oldRoot = process.env.HEALTH_TOOLLOG_DIR;
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (oldRoot === undefined) delete process.env.HEALTH_TOOLLOG_DIR;
  else process.env.HEALTH_TOOLLOG_DIR = oldRoot;
});
function root() {
  const dir = mkdtempSync(join(tmpdir(), "health-receipts-"));
  dirs.push(dir);
  process.env.HEALTH_TOOLLOG_DIR = dir;
  return dir;
}
const data = Buffer.from("synthetic png bytes");
const hash = createHash("sha256").update(data).digest("hex");
function metadata() {
  return { version: 1 as const, runId: "a".repeat(32), kind: "card" as const, createdAt: "2026-11-16T06:00:00.000Z",
    cardId: "b".repeat(32), cardIds: ["b".repeat(32)], sha256: hash };
}

test("only allowlisted metadata for the exact PNG crosses the CLI boundary", () => {
  const file = join(root(), "card.png");
  writeFileSync(file, data);
  writeFileSync(`${file}.delivery.json`, JSON.stringify(metadata()));
  expect(readHealthSidecar(file, data)).toEqual(metadata());
  expect(readHealthSidecar(file, Buffer.from("overwritten"))).toBeUndefined();
  for (const extra of [{ text: "PrivateFoodCaptionToken" }, { runId: "bad" }, { cardIds: [] },
    { cardId: "c".repeat(32) }, { createdAt: "2026-99-16T06:00:00.000Z" }, { kind: "warning" }]) {
    expect(parseHealthSidecar(JSON.stringify({ ...metadata(), ...extra }), hash)).toBeUndefined();
  }
  expect(parseHealthSidecar("{".repeat(9000), hash)).toBeUndefined();
  writeFileSync(`${file}.delivery.json`, "{");
  expect(readHealthSidecar(file, data)).toBeUndefined();
});

function fixture() {
  const store = new Store(":memory:");
  stores.push(store);
  return { db: store.db, store };
}

test("queue/upload/pending/uncertain/cancel/fallback produce no receipt; terminal accepted/failed do", () => {
  const dir = root();
  const { store } = fixture();
  const states = ["pending", "sending", "uncertain", "cancelled", "fallback", "sent", "failed"];
  for (const state of states) {
    store.enqueue({ id: state, kind: "notification", text: "PrivateFoodCaptionToken",
      attachment: { sha256: store.putBlob(data), name: "card.png", mimeType: "image/png", size: data.length },
      healthReceipt: { ...metadata(), version: 1, kind: "card" } });
    store.outboxState(state, state);
  }
  flushHealthReceipts(store);
  flushHealthReceipts(store);
  const serialized = readFileSync(join(dir, "receipts/2026-11-16.ndjson"), "utf8");
  const rows = serialized.split("\n").filter(Boolean).map(line => JSON.parse(line));
  expect(rows).toHaveLength(2);
  expect(rows.map(r => r.ok).sort()).toEqual([false, true]);
  expect(rows.find(r => !r.ok).errorTag).toBe("internal_error");
  expect(serialized).not.toContain("PrivateFoodCaptionToken");
  expect(serialized).not.toContain("attachment");
});

test("failed spool write leaves terminal state checkpoint retryable", () => {
  const dir = root();
  const { store } = fixture();
  store.enqueue({ id: "sent", kind: "notification", text: "",
    attachment: { sha256: store.putBlob(data), name: "card.png", mimeType: "image/png", size: data.length },
    healthReceipt: { ...metadata(), version: 1, kind: "card" } });
  store.outboxState("sent", "sent");
  process.env.HEALTH_TOOLLOG_DIR = join(dir, "not-a-dir");
  writeFileSync(process.env.HEALTH_TOOLLOG_DIR, "blocked");
  flushHealthReceipts(store);
  expect(store.get("health-receipt-emitted:sent:sent")).toBeUndefined();
  process.env.HEALTH_TOOLLOG_DIR = dir;
  flushHealthReceipts(store);
  expect(store.get<boolean>("health-receipt-emitted:sent:sent")).toBe(true);
});
