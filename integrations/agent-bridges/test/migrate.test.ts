import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, rm, stat } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../scripts/migrate-imessage-alerts.ts";
import { Store } from "../../telegram-bridge/src/store.ts";
import { createHash } from "node:crypto";

const now = Date.now();
let directory: string;
const directories: string[] = [];

/** The live spectrum database still carries the pre-slim-down alerting schema. */
function spectrumFixture(): string {
  const path = join(directory, "source.sqlite");
  const db = new Database(path, { create: true, strict: true });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE inbound (id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL);
    CREATE TABLE reminders (id TEXT PRIMARY KEY, text TEXT NOT NULL, dueAt INTEGER NOT NULL,
      timezone TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, operationId TEXT UNIQUE);
    CREATE TABLE outbox (id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, providerId TEXT UNIQUE, reminderId TEXT REFERENCES reminders(id));
    CREATE TABLE blobs (sha256 TEXT PRIMARY KEY, data BLOB NOT NULL);
    CREATE TABLE session_notices (id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL);
  `);
  const notification = (id: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ id, kind: "notification", text: `text ${id}`, ...extra });
  db.query(`INSERT INTO reminders VALUES ('R1', 'stretch', ?, 'UTC', 'scheduled', 1, NULL)`).run(now + 3_600_000);
  // R2: queued with its in-flight operation; both sides must carry it across.
  db.query(`INSERT INTO reminders VALUES ('R2', 'water', ?, 'UTC', 'queued', 1, 'reminder:R2:1')`).run(now + 60_000);
  db.query(`INSERT INTO outbox (id, payload, state, attempts, reminderId) VALUES ('reminder:R2:1', ?, 'pending', 0, 'R2')`)
    .run(notification("reminder:R2:1"));
  // R3: queued but its operation already sent; demote to scheduled on the target.
  db.query(`INSERT INTO reminders VALUES ('R3', 'stale', ?, 'UTC', 'queued', 1, 'reminder:R3:1')`).run(now - 60_000);
  db.query(`INSERT INTO outbox (id, payload, state, attempts, providerId, reminderId) VALUES ('reminder:R3:1', ?, 'sent', 1, 'guid-sent', 'R3')`)
    .run(notification("reminder:R3:1"));
  // History that must stay behind.
  db.query(`INSERT INTO reminders VALUES ('R4', 'done', ?, 'UTC', 'sent', 1, 'reminder:R4:1')`).run(now - 86_400_000);
  db.query(`INSERT INTO reminders VALUES ('R5', 'cancelled', ?, 'UTC', 'cancelled', 2, NULL)`).run(now - 86_400_000);
  const sha256 = createHash("sha256").update(new Uint8Array([1, 2, 3])).digest("hex");
  db.query("INSERT INTO blobs VALUES (?, ?)").run(sha256, new Uint8Array([1, 2, 3]));
  db.query(`INSERT INTO outbox (id, payload, state, attempts) VALUES ('file-op', ?, 'pending', 0)`)
    .run(notification("file-op", { attachment: { sha256, name: "report.pdf", mimeType: "application/pdf" } }));
  db.query(`INSERT INTO outbox (id, payload, state, attempts, providerId) VALUES ('uncertain-op', ?, 'uncertain', 2, 'guid-x')`)
    .run(notification("uncertain-op"));
  db.query(`INSERT INTO outbox (id, payload, state, attempts) VALUES ('sent-op', ?, 'sent', 1)`)
    .run(notification("sent-op"));
  db.query(`INSERT INTO outbox (id, payload, state, attempts) VALUES ('control-op', ?, 'pending', 0)`)
    .run(JSON.stringify({ kind: "control", text: "ack" }));
  // Session notices: fresh pending, queued, stale, answered, and malformed rows.
  db.query(`INSERT INTO session_notices VALUES ('n1', ?, 'pending')`).run(JSON.stringify({ id: "n1", kind: "review", sessionId: "s1", directory: "/d", workRevision: 3, firstSeen: now - 3_600_000 }));
  db.query(`INSERT INTO session_notices VALUES ('n2', ?, 'queued')`).run(JSON.stringify({ id: "n2", kind: "approval", sessionId: "s2", directory: "/d", requestId: "p1", firstSeen: now - 60_000 }));
  db.query(`INSERT INTO session_notices VALUES ('n3', ?, 'pending')`).run(JSON.stringify({ id: "n3", kind: "question", sessionId: "s3", directory: "/d", firstSeen: now - 8 * 24 * 60 * 60 * 1_000 }));
  db.query(`INSERT INTO session_notices VALUES ('n4', ?, 'pending')`).run(JSON.stringify({ id: "n4", kind: "review", sessionId: "s4", directory: "/d", firstSeen: now + 3_600_000 }));
  db.query(`INSERT INTO session_notices VALUES ('n5', ?, 'pending')`).run(JSON.stringify({ id: "n5", kind: "review", sessionId: "s5", directory: "/d", state: "answered", firstSeen: now }));
  db.query(`INSERT INTO session_notices VALUES ('n6', 'not json', 'pending')`).run();
  // kv bookkeeping tied to copied rows, plus noise that must stay behind.
  db.query(`INSERT INTO kv VALUES ('api:reminder:key1', ?)`).run(JSON.stringify({ spec: "a", result: { id: "R1", text: "stretch", dueAt: now + 3_600_000, timezone: "UTC", status: "scheduled", revision: 1 } }));
  db.query(`INSERT INTO kv VALUES ('api:reminder:key5', ?)`).run(JSON.stringify({ spec: "b", result: { id: "R5" } }));
  db.query(`INSERT INTO kv VALUES ('api:notification:file-op', ?)`).run(JSON.stringify({ created: true }));
  db.query(`INSERT INTO kv VALUES ('api:notification:sent-op', ?)`).run(JSON.stringify({ created: true }));
  db.query(`INSERT INTO kv VALUES ('firstAttempt:file-op', ?)`).run(JSON.stringify(now - 1_000));
  db.query(`INSERT INTO kv VALUES ('sendAmbiguous:uncertain-op', ?)`).run(JSON.stringify(true));
  db.query(`INSERT INTO kv VALUES ('chunk:file-op:0', ?)`).run(JSON.stringify(true));
  db.query(`INSERT INTO kv VALUES ('chunk:sent-op:0', ?)`).run(JSON.stringify(true));
  db.query(`INSERT INTO kv VALUES ('callback:token1', ?)`).run(JSON.stringify("session-notice:n2"));
  db.query(`INSERT INTO kv VALUES ('identity', ?)`).run(JSON.stringify({ bridge: "spectrum" }));
  db.close();
  return path;
}

async function tempDirectory(): Promise<string> {
  directory = mkdtempSync(join(tmpdir(), "migrate-"));
  directories.push(directory);
  await mkdir(directory, { recursive: true });
  return directory;
}

afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("migrate-imessage-alerts", () => {
  test("dry run reports counts and writes nothing", async () => {
    const dir = await tempDirectory();
    const sourcePath = spectrumFixture();
    const targetPath = join(dir, "target.sqlite");
    const counts = await migrate({ sourcePath, targetPath, dryRun: true });
    expect(counts).toMatchObject({ event: "migration-dry-run", reminders: 3, demotedQueued: 1,
      sessionNotices: 3, notifications: 3 });
    expect(counts.sourceBackup).toBeUndefined();
    expect(existsSync(targetPath)).toBe(false);
    expect(existsSync(`${sourcePath}.bak-`)).toBe(false);
  });

  test("copies live alerting state and creates timestamped backups", async () => {
    const dir = await tempDirectory();
    const sourcePath = spectrumFixture();
    const targetPath = join(dir, "target.sqlite");
    const counts = await migrate({ sourcePath, targetPath, dryRun: false });
    expect(counts).toMatchObject({ event: "migration-complete", reminders: 3, demotedQueued: 1,
      sessionNotices: 3, notifications: 3, blobs: 1, kv: 5 });
    expect(typeof counts.sourceBackup).toBe("string");
    expect(existsSync(counts.sourceBackup!)).toBe(true);

    const store = new Store(targetPath);
    const sha256 = createHash("sha256").update(new Uint8Array([1, 2, 3])).digest("hex");
    try {
      // Reminders: R1 scheduled, R2 queued with its operation, R3 demoted to scheduled.
      const reminders = store.listReminders().sort((a, b) => a.id.localeCompare(b.id));
      expect(reminders.map(row => [row.id, row.status])).toEqual([["R1", "scheduled"], ["R2", "queued"], ["R3", "scheduled"]]);
      expect(reminders.find(row => row.id === "R3")?.operationId).toBeUndefined();
      // Notifications: pending/uncertain only, provider ids dropped, attempts preserved.
      const file = store.getOperation("file-op");
      expect(file).toMatchObject({ state: "pending", attempts: 0 });
      expect(file?.providerId).toBeUndefined();
      expect(file?.attachment?.sha256).toBe(sha256);
      expect(store.getBlob(sha256)).toEqual(new Uint8Array([1, 2, 3]));
      expect(store.getOperation("uncertain-op")).toMatchObject({ state: "uncertain", attempts: 2 });
      expect(store.getOperation("sent-op")).toBeUndefined();
      expect(store.getOperation("control-op")).toBeUndefined();
      expect(store.getOperation("reminder:R2:1")).toMatchObject({ state: "pending" });
      // Session notices land as pending for observer revalidation.
      expect(store.pendingSessionNotices().map(notice => notice.id).sort()).toEqual(["n1", "n2", "n5"]);
      // kv: only bookkeeping tied to copied rows.
      expect(store.get("api:reminder:key1")).toEqual(expect.objectContaining({ spec: "a" }));
      expect(store.get("api:reminder:key5")).toBeUndefined();
      expect(store.get<{ created: boolean }>("api:notification:file-op")).toEqual({ created: true });
      expect(store.get("api:notification:sent-op")).toBeUndefined();
      expect(store.get<number>("firstAttempt:file-op")).toBe(now - 1_000);
      expect(store.get<boolean>("sendAmbiguous:uncertain-op")).toBe(true);
      expect(store.get<boolean>("chunk:file-op:0")).toBe(true);
      expect(store.get("chunk:sent-op:0")).toBeUndefined();
      expect(store.get("callback:token1")).toBeUndefined();
      expect(store.get("identity")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("re-running is idempotent and reports zero new rows", async () => {
    const dir = await tempDirectory();
    const sourcePath = spectrumFixture();
    const targetPath = join(dir, "target.sqlite");
    await migrate({ sourcePath, targetPath, dryRun: false });
    const before = (await stat(targetPath)).size;
    const second = await migrate({ sourcePath, targetPath, dryRun: false });
    // The first run cancelled the copied notification rows in the source, so a
    // re-run finds nothing left to copy; nothing is duplicated on the target.
    expect(second).toMatchObject({ reminders: 3, notifications: 0, blobs: 0, kv: 0 });
    const store = new Store(targetPath);
    try {
      expect(store.listReminders()).toHaveLength(3);
      // Uncertain rows are excluded from pending; they surface through recovery instead.
      expect(store.pendingOutbox().map(op => op.id).sort()).toEqual(["file-op", "reminder:R2:1"]);
    } finally { store.close(); }
    expect((await stat(targetPath)).size).toBeGreaterThanOrEqual(before);
  });

  test("copied notifications are cancelled in the source so only telegram delivers them", async () => {
    const dir = await tempDirectory();
    const sourcePath = spectrumFixture();
    await migrate({ sourcePath, targetPath: join(dir, "target.sqlite"), dryRun: false });
    const source = new Database(sourcePath, { readonly: true, strict: true });
    try {
      const states = Object.fromEntries(source.query<{ id: string; state: string }, []>(
        "SELECT id, state FROM outbox ORDER BY id").all().map(row => [row.id, row.state]));
      expect(states).toEqual({
        "control-op": "pending",
        "file-op": "cancelled",
        "reminder:R2:1": "cancelled",
        "reminder:R3:1": "sent",
        "sent-op": "sent",
        "uncertain-op": "cancelled",
      });
    } finally { source.close(); }
  });

  test("a fresh target database is initialized with the telegram schema", async () => {
    const dir = await tempDirectory();
    const sourcePath = spectrumFixture();
    const targetPath = join(dir, "fresh", "target.sqlite");
    const counts = await migrate({ sourcePath, targetPath, dryRun: false });
    expect(counts.event).toBe("migration-complete");
    const store = new Store(targetPath);
    try { expect(store.listReminders()).toHaveLength(3); } finally { store.close(); }
    // Exactly one backup set per run lands next to the source; WAL sidecars are normal.
    const backups = readdirSync(dir).filter(name => name.startsWith("source.sqlite.bak-") && !/-(wal|shm)$/.test(name));
    expect(backups).toHaveLength(1);
  });

  test("a missing source database fails closed", async () => {
    const dir = await tempDirectory();
    await expect(migrate({ sourcePath: join(dir, "missing.sqlite"), targetPath: join(dir, "target.sqlite"), dryRun: false }))
      .rejects.toThrow("The spectrum database does not exist");
  });
});
