#!/usr/bin/env bun
/**
 * One-time migration of alerting state from the iMessage (spectrum) bridge to
 * the telegram bridge. Copies:
 *   - scheduled/queued reminders (queued reminders whose send already completed
 *     are demoted to scheduled so telegram re-fires them at-least-once),
 *   - pending/queued session notices from the last 7 days (the telegram
 *     observer revalidates each one on its next tick),
 *   - pending/uncertain one-time notification outbox rows with their blobs,
 *   - the kv bookkeeping that keeps API replays and retry windows honest.
 *
 * Requires BOTH bridges to be stopped. Creates timestamped backups of both
 * databases before writing. Safe to re-run: every insert is idempotent.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../../telegram-bridge/src/store.ts";

const NOTICE_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

export type MigrationOptions = {
  sourcePath: string;
  targetPath: string;
  dryRun: boolean;
};

export type MigrationCounts = {
  event: string;
  reminders: number;
  demotedQueued: number;
  sessionNotices: number;
  notifications: number;
  blobs: number;
  kv: number;
  sourceBackup?: string;
  targetBackup?: string;
};

function fail(message: string): never {
  console.error(JSON.stringify({ error: message }));
  process.exit(1);
}

async function backup(path: string, name: string): Promise<string | undefined> {
  const exists = await lstat(path).catch(() => undefined);
  if (!exists) return undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${path}.bak-${stamp}`;
  await copyFile(path, target);
  for (const suffix of ["-wal", "-shm"]) {
    await copyFile(`${path}${suffix}`, `${target}${suffix}`).catch(() => {});
  }
  return target;
}

type ReminderRow = { id: string; text: string; dueAt: number; timezone: string; status: string; revision: number; operationId: string | null };
type OutboxRow = { id: string; payload: string; state: string; attempts: number; reminderId: string | null };
type NoticeRow = { id: string; payload: string };

export async function migrate(options: MigrationOptions): Promise<MigrationCounts> {
  const counts: MigrationCounts = {
    event: options.dryRun ? "migration-dry-run" : "migration-complete",
    reminders: 0, demotedQueued: 0, sessionNotices: 0, notifications: 0, blobs: 0, kv: 0,
  };

  if (!existsSync(options.sourcePath)) throw new Error(`The spectrum database does not exist: ${options.sourcePath}`);
  const source = new Database(options.sourcePath, { readonly: true, strict: true });
  let target: Store | undefined;
  try {
    // ---- Read phase: everything comes from the live spectrum schema. ----
    const reminders = source.query<ReminderRow, []>(
      "SELECT * FROM reminders WHERE status IN ('scheduled', 'queued') ORDER BY id",
    ).all();
    const operations = source.query<OutboxRow, []>(`SELECT o.id, o.payload, o.state, o.attempts, o.reminderId FROM outbox o
      WHERE json_extract(o.payload, '$.kind') = 'notification'
        AND o.state IN ('pending', 'uncertain') ORDER BY o.id`).all();
    const opById = new Map(operations.map(row => [row.id, row]));
    const notices = source.query<NoticeRow, []>(
      "SELECT id, payload FROM session_notices WHERE state IN ('pending', 'queued') ORDER BY id",
    ).all();

    // A queued reminder whose operation is not being copied (already sent, or
    // cancelled) is demoted to scheduled: telegram re-fires it at-least-once.
    const reminderCopies = reminders.map(reminder => {
      if (reminder.status !== "queued") return { ...reminder, demoted: false };
      const operation = reminder.operationId ? opById.get(reminder.operationId) : undefined;
      if (operation) return { ...reminder, demoted: false };
      return { ...reminder, status: "scheduled", operationId: null, demoted: true };
    });

    // Session notices inside the 7-day window; the telegram observer
    // revalidates every copied notice on its next tick.
    const noticeCopies: NoticeRow[] = [];
    for (const notice of notices) {
      try {
        const firstSeen = (JSON.parse(notice.payload) as { firstSeen?: unknown }).firstSeen;
        if (typeof firstSeen !== "number" || !Number.isFinite(firstSeen) || firstSeen > Date.now()
          || Date.now() - firstSeen > NOTICE_WINDOW_MS) continue;
        noticeCopies.push(notice);
      } catch { /* Skip unreadable notices; the observer regenerates live ones. */ }
    }

    // Attachment blobs referenced by copied operations.
    const blobs: Array<{ sha256: string; data: Uint8Array }> = [];
    for (const operation of operations) {
      try {
        const sha256 = (JSON.parse(operation.payload) as { attachment?: { sha256?: unknown } }).attachment?.sha256;
        if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) continue;
        const blob = source.query<{ data: Uint8Array }, [string]>("SELECT data FROM blobs WHERE sha256 = ?").get(sha256);
        if (blob) blobs.push({ sha256, data: blob.data });
      } catch { /* A malformed payload is skipped; the op keeps its raw bytes. */ }
    }

    // kv bookkeeping: API idempotency plus retry windows, keyed to copied rows.
    const kvKeys = new Map<string, string>();
    const reminderIds = new Set(reminders.map(reminder => reminder.id));
    for (const row of source.query<{ key: string; value: string }, []>("SELECT key, value FROM kv WHERE key LIKE 'api:reminder:%'").all()) {
      try {
        const result = (JSON.parse(row.value) as { result?: { id?: unknown } }).result;
        if (result && typeof result.id === "string" && reminderIds.has(result.id)) kvKeys.set(row.key, row.value);
      } catch { /* Unreadable idempotency metadata is skipped, never fatal. */ }
    }
    const operationIds = new Set(operations.map(operation => operation.id));
    for (const row of source.query<{ key: string; value: string }, []>("SELECT key, value FROM kv").all()) {
      const match = /^(api:(?:notification|file):|firstAttempt:|sendAmbiguous:|retry:|deliveryChat:|chunk:)(.*)$/.exec(row.key);
      if (!match) continue;
      const [prefix, rest] = [match[1]!, match[2]!];
      if (prefix === "chunk:") {
        const id = rest.slice(0, Math.max(0, rest.lastIndexOf(":")));
        if (operationIds.has(id)) kvKeys.set(row.key, row.value);
      } else if (operationIds.has(rest)) {
        kvKeys.set(row.key, row.value);
      }
    }

    counts.reminders = reminderCopies.length;
    counts.demotedQueued = reminderCopies.filter(copy => copy.demoted).length;
    counts.sessionNotices = noticeCopies.length;
    counts.notifications = operations.length;
    if (options.dryRun) return counts;

    // ---- Backup phase: snapshots of both databases before any write. ----
    counts.sourceBackup = await backup(options.sourcePath, "spectrum");
    if (!counts.sourceBackup) fail(`The spectrum database does not exist: ${options.sourcePath}`);
    await mkdir(dirname(options.targetPath), { recursive: true, mode: 0o700 }).catch(() => {});
    counts.targetBackup = await backup(options.targetPath, "telegram");

    // ---- Write phase: single transaction, all inserts idempotent. ----
    target = new Store(options.targetPath);
    target.db.transaction(() => {
      for (const reminder of reminderCopies) {
        target!.db.query(`INSERT INTO reminders (id, text, dueAt, timezone, status, revision, operationId)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).run(
          reminder.id, reminder.text, reminder.dueAt, reminder.timezone,
          reminder.status, reminder.revision, reminder.operationId);
      }
      for (const notice of noticeCopies) {
        target!.db.query(`INSERT INTO session_notices (id, payload, state) VALUES (?, ?, 'pending')
          ON CONFLICT(id) DO NOTHING`).run(notice.id, notice.payload);
      }
      for (const operation of operations) {
        target!.db.query(`INSERT INTO outbox (id, payload, state, attempts, providerId, reminderId)
          VALUES (?, ?, ?, ?, NULL, ?) ON CONFLICT(id) DO NOTHING`).run(
          operation.id, operation.payload, operation.state, operation.attempts, operation.reminderId);
      }
      for (const blob of blobs) {
        counts.blobs += target!.db.query(`INSERT INTO blobs (sha256, data) VALUES (?, ?)
          ON CONFLICT(sha256) DO NOTHING`).run(blob.sha256, blob.data).changes;
      }
      for (const [key, value] of kvKeys) {
        counts.kv += target!.db.query(`INSERT INTO kv (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO NOTHING`).run(key, value).changes;
      }
    }).immediate();
    // The copied notifications are now telegram's to deliver; the slimmed
    // spectrum delivery loop must never send them a second time. Bridges are
    // stopped, so a write here is safe. Crash before this point leaves both
    // copies pending, which the re-run detects and finalizes idempotently.
    if (operations.length > 0) {
      const finalize = new Database(options.sourcePath, { strict: true });
      try {
        finalize.query(`UPDATE outbox SET state = 'cancelled'
          WHERE state IN ('pending', 'uncertain') AND json_extract(payload, '$.kind') = 'notification'
          AND id IN (${operations.map(() => "?").join(", ")})`).run(...operations.map(operation => operation.id));
      } finally {
        finalize.close();
      }
    }
    return counts;
  } finally {
    source.close();
    target?.close();
  }
}

async function assertStopped(socket: string, name: string): Promise<void> {
  const info = await stat(socket).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    fail(`Could not inspect the ${name} bridge socket`);
  });
  if (info) fail(`The ${name} bridge appears to be running; stop both bridges before migrating.`);
}

if (import.meta.main) {
  const home = homedir();
  const arg = (name: string, fallback: string) =>
    process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1]! : fallback;
  const sourcePath = arg("from", join(home, ".config/spectrum-bridge/state.sqlite"));
  const targetPath = arg("to", join(home, ".config/telegram-bridge/state.sqlite"));
  const sourceSocket = arg("source-socket", join(home, ".config/spectrum-bridge/bridge.sock"));
  const targetSocket = arg("target-socket", join(home, ".config/telegram-bridge/bridge.sock"));
  const dryRun = process.argv.includes("--dry-run");
  await assertStopped(sourceSocket, "spectrum");
  await assertStopped(targetSocket, "telegram");
  console.log(JSON.stringify(await migrate({ sourcePath, targetPath, dryRun })));
}
