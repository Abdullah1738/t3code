import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { toolError, toolLog } from "./toollog.ts";

export type FileAttachment = { sha256: string; name: string; mimeType: string; size: number };
export type KeyboardSpec = { rows: Array<Array<{ text: string; data: string }>> } | { remove: true };

export type OutboxOperation = {
  id: string;
  kind: "notification" | "control";
  text: string;
  replyTo?: number;
  attachment?: FileAttachment;
  keyboard?: KeyboardSpec;
};

export type OutboxRecord = OutboxOperation & {
  state: string;
  attempts: number;
  providerId?: number;
};

export type SessionNotice = {
  id: string;
  kind: "question" | "approval" | "review";
  sessionId: string;
  directory: string;
  requestId?: string;
  workRevision?: number;
  firstSeen: number;
  state: "pending" | "queued" | "cancelled" | "sent" | "answered";
  signature?: string;
};

export const sessionNoticeId = (directory: string, sessionId: string, kind: SessionNotice["kind"], identity: string | number) => (
  `session-notice:${createHash("sha256").update(JSON.stringify([directory, sessionId, kind, identity])).digest("hex")}`
);

export const callbackToken = (noticeId: string) => createHash("sha256").update(`callback:${noticeId}`).digest("hex").slice(0, 16);

export type ReminderRecord = {
  id: string;
  text: string;
  dueAt: number;
  timezone: string;
  status: "scheduled" | "queued" | "sent" | "cancelled";
  revision: number;
  operationId?: number | string;
};

type OutboxRow = {
  payload: string;
  state: string;
  attempts: number;
  providerId: number | null;
};
type ReminderRow = Omit<ReminderRecord, "operationId"> & { operationId: string | null };

function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Value must be JSON serializable");
  return encoded;
}

function outboxRecord(row: OutboxRow): OutboxRecord {
  return {
    ...JSON.parse(row.payload),
    state: row.state,
    attempts: row.attempts,
    ...(row.providerId === null ? {} : { providerId: row.providerId }),
  };
}

function reminderRecord(row: ReminderRow): ReminderRecord {
  const { operationId, ...record } = row;
  return operationId === null ? record : { ...record, operationId };
}

export class Store {
  public readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    try {
      this.db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reminders (
          id TEXT PRIMARY KEY, text TEXT NOT NULL, dueAt INTEGER NOT NULL,
          timezone TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL,
          operationId TEXT UNIQUE
        );
        CREATE TABLE IF NOT EXISTS outbox (
          id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0, providerId INTEGER UNIQUE,
          reminderId TEXT REFERENCES reminders(id)
        );
        CREATE INDEX IF NOT EXISTS outbox_state ON outbox(state);
        CREATE INDEX IF NOT EXISTS outbox_reminder ON outbox(reminderId);
        CREATE INDEX IF NOT EXISTS reminders_due ON reminders(status, dueAt);
        CREATE TABLE IF NOT EXISTS blobs (sha256 TEXT PRIMARY KEY, data BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS session_notices (id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS session_notices_state ON session_notices(state);
      `);
      // A provider may have accepted these sends before the process stopped.
      this.db.query("UPDATE outbox SET state = 'uncertain' WHERE state = 'sending'").run();
    } catch (error) {
      toolError("telegram", "tg.store.open", undefined, error);
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  get<T>(key: string): T | undefined {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?").get(key);
    return row ? JSON.parse(row.value) as T : undefined;
  }

  set(key: string, value: unknown): void {
    this.db.query(`INSERT INTO kv (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, json(value));
  }

  saveSessionNotice(notice: SessionNotice): void {
    this.db.query(`INSERT INTO session_notices (id, payload, state) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, state = excluded.state`).run(notice.id, json(notice), notice.state);
  }

  sessionNotice(id: string): SessionNotice | undefined {
    const row = this.db.query<{ payload: string }, [string]>("SELECT payload FROM session_notices WHERE id = ?").get(id);
    // SAFETY: session_notices is private bridge state, written only by
    // saveSessionNotice with the SessionNotice contract, never by the API.
    return row ? JSON.parse(row.payload) as SessionNotice : undefined;
  }

  pendingSessionNotices(): SessionNotice[] {
    return this.db.query<{ payload: string }, []>("SELECT payload FROM session_notices WHERE state IN ('pending', 'queued')").all()
      // SAFETY: every selected payload is serialized by saveSessionNotice.
      .map(row => JSON.parse(row.payload) as SessionNotice);
  }

  enqueueSessionNotice(notice: SessionNotice, text: string, keyboard?: KeyboardSpec): void {
    const payload = json({ id: notice.id, kind: notice.kind === "review" ? "notification" : "control", text, ...(keyboard ? { keyboard } : {}) });
    this.db.transaction(() => {
      const result = this.db.query(`INSERT INTO outbox (id, payload, state) VALUES (?, ?, 'pending')
        ON CONFLICT(id) DO NOTHING`).run(notice.id, payload);
      if (!result.changes) toolLog({ component: "telegram", kind: "event", name: "tg.dedupe", ok: true,
        ids: { operation: notice.id, key: notice.id, thread: notice.sessionId }, props: { deduped: true, action: "check" } });
      this.saveSessionNotice({ ...notice, state: "queued" });
    }).immediate();
  }

  enqueue(op: OutboxOperation): boolean {
    // Normalize property order and omit unrelated caller fields before comparing content.
    const payload = json({
      id: op.id, kind: op.kind, text: op.text, replyTo: op.replyTo,
      attachment: op.attachment ? { sha256: op.attachment.sha256, name: op.attachment.name,
        mimeType: op.attachment.mimeType, size: op.attachment.size } : undefined,
      keyboard: op.keyboard,
    });
    return this.db.transaction(() => {
      const result = this.db.query(`INSERT INTO outbox (id, payload, state) VALUES (?, ?, 'pending')
        ON CONFLICT(id) DO NOTHING`).run(op.id, payload);
      if (result.changes) return true;
      const existing = this.db.query<{ payload: string }, [string]>(
        "SELECT payload FROM outbox WHERE id = ?",
      ).get(op.id)!;
      if (existing.payload !== payload) {
        toolLog({ component: "telegram", kind: "error", name: "tg.dedupe", ok: false,
          ids: { operation: op.id, key: op.id }, props: { action: "conflict" }, error: { tag: "tg.dedupe.contentConflict" } });
        throw new Error(`Outbox content mismatch: ${op.id}`);
      }
      toolLog({ component: "telegram", kind: "event", name: "tg.dedupe", ok: true,
        ids: { operation: op.id, key: op.id }, props: { deduped: true, action: "check" } });
      return false;
    }).immediate();
  }

  pendingOutbox(): OutboxRecord[] {
    return this.db.query<OutboxRow, []>(
      "SELECT payload, state, attempts, providerId FROM outbox WHERE state = 'pending' ORDER BY rowid",
    ).all().map(outboxRecord);
  }

  putBlob(data: Uint8Array): string {
    if (data.byteLength > 20 * 1024 * 1024) throw new Error("Attachment exceeds 20 MiB");
    const sha256 = createHash("sha256").update(data).digest("hex");
    this.db.query("INSERT INTO blobs (sha256, data) VALUES (?, ?) ON CONFLICT(sha256) DO NOTHING").run(sha256, data);
    return sha256;
  }

  getBlob(sha256: string): Uint8Array {
    const row = this.db.query<{ data: Uint8Array }, [string]>("SELECT data FROM blobs WHERE sha256 = ?").get(sha256);
    if (!row || createHash("sha256").update(row.data).digest("hex") !== sha256) throw new Error("Attachment blob unavailable");
    return row.data;
  }

  outboxState(id: string, state: string, providerId?: number): void {
    this.db.transaction(() => {
      const result = this.db.query(`UPDATE outbox SET
        attempts = attempts + CASE WHEN ? = 'sending' AND state != 'sending' THEN 1 ELSE 0 END,
        state = ?, providerId = COALESCE(?, providerId) WHERE id = ?`
      ).run(state, state, providerId ?? null, id);
      if (!result.changes) throw new Error(`Unknown outbox operation: ${id}`);
      if (state === "sent") {
        this.db.query("UPDATE reminders SET status = 'sent' WHERE operationId = ?").run(id);
      }
    }).immediate();
    try {
      const reminder = this.db.query<{ reminderId: string | null }, [string]>("SELECT reminderId FROM outbox WHERE id = ?").get(id);
      if (reminder?.reminderId) toolLog({ component: "telegram", kind: state === "failed" || state === "uncertain" ? "error" : "event",
        name: "tg.reminder", ok: state !== "failed" && state !== "uncertain", ids: { reminder: reminder.reminderId, operation: id },
        props: { action: state === "sent" ? "sent" : state === "pending" ? "retry" : state === "cancelled" ? "cancel" : "send", state },
        ...(state === "failed" || state === "uncertain" ? { error: { tag: "tg.reminder.deliveryFailed" } } : {}) });
    } catch (error) { toolError("telegram", "tg.reminder.deliveryLog", { operation: id }, error); }
  }

  byProviderId(id: number): OutboxRecord | undefined {
    const operation = this.get<string>(`provider-operation:${id}`);
    if (operation) return this.getOperation(operation);
    const row = this.db.query<OutboxRow, [number]>(
      "SELECT payload, state, attempts, providerId FROM outbox WHERE providerId = ?",
    ).get(id);
    return row ? outboxRecord(row) : undefined;
  }

  getOperation(id: string): OutboxRecord | undefined {
    const row = this.db.query<OutboxRow, [string]>(
      "SELECT payload, state, attempts, providerId FROM outbox WHERE id = ?",
    ).get(id);
    return row ? outboxRecord(row) : undefined;
  }

  findOutbox(id: string): OutboxRecord | undefined {
    return this.getOperation(id) ?? (Number.isSafeInteger(Number(id)) ? this.byProviderId(Number(id)) : undefined);
  }

  createReminder(input: { id?: string; text: string; dueAt: number; timezone: string }): ReminderRecord {
    try {
      new Date(input.dueAt).toISOString();
      new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
      const id = input.id ?? `R${randomUUID()}`;
      this.db.query(`INSERT INTO reminders (id, text, dueAt, timezone, status, revision)
        VALUES (?, ?, ?, ?, 'scheduled', 1)`).run(id, input.text, input.dueAt, input.timezone);
      const reminder = this.getReminder(id);
      toolLog({ component: "telegram", kind: "event", name: "tg.reminder", ok: true,
        ids: { reminder: id }, props: { action: "create", state: reminder.status } });
      return reminder;
    } catch (error) {
      toolLog({ component: "telegram", kind: "error", name: "tg.reminder", ok: false,
        ids: { reminder: input.id }, props: { action: "create" }, error: { tag: "tg.reminder.createFailed" } });
      throw error;
    }
  }

  listReminders(): ReminderRecord[] {
    return this.db.query<ReminderRow, []>(
      "SELECT * FROM reminders ORDER BY dueAt, id",
    ).all().map(reminderRecord);
  }

  cancelReminder(id: string): ReminderRecord {
    try {
      const reminder = this.changeReminder(id);
      toolLog({ component: "telegram", kind: "event", name: "tg.reminder", ok: true,
        ids: { reminder: id }, props: { action: "cancel", state: reminder.status } });
      return reminder;
    } catch (error) {
      toolLog({ component: "telegram", kind: "error", name: "tg.reminder", ok: false,
        ids: { reminder: id }, props: { action: "cancel" }, error: { tag: "tg.reminder.cancelFailed" } });
      throw error;
    }
  }

  snoozeReminder(id: string, dueAt: number): ReminderRecord {
    try {
      new Date(dueAt).toISOString();
      const reminder = this.changeReminder(id, dueAt);
      toolLog({ component: "telegram", kind: "event", name: "tg.reminder", ok: true,
        ids: { reminder: id }, props: { action: "snooze", state: reminder.status } });
      return reminder;
    } catch (error) {
      toolLog({ component: "telegram", kind: "error", name: "tg.reminder", ok: false,
        ids: { reminder: id }, props: { action: "snooze" }, error: { tag: "tg.reminder.snoozeFailed" } });
      throw error;
    }
  }

  private getReminder(id: string): ReminderRecord {
    const row = this.db.query<ReminderRow, [string]>("SELECT * FROM reminders WHERE id = ?").get(id);
    if (!row) throw new Error(`Unknown reminder: ${id}`);
    return reminderRecord(row);
  }

  private changeReminder(id: string, dueAt?: number): ReminderRecord {
    return this.db.transaction(() => {
      this.getReminder(id);
      const ambiguous = this.db.query<{ id: string }, [string]>(`SELECT id FROM outbox
        WHERE reminderId = ? AND state IN ('sending', 'uncertain') LIMIT 1`).get(id);
      if (ambiguous) throw new Error(`Reminder ${id} has an ambiguous send: ${ambiguous.id}`);
      this.db.query("UPDATE outbox SET state = 'cancelled' WHERE reminderId = ? AND state != 'sent'").run(id);
      if (dueAt === undefined) {
        this.db.query("UPDATE reminders SET status = 'cancelled' WHERE id = ?").run(id);
      } else {
        this.db.query(`UPDATE reminders SET dueAt = ?, status = 'scheduled',
          revision = revision + 1, operationId = NULL WHERE id = ?`).run(dueAt, id);
      }
      return this.getReminder(id);
    }).immediate();
  }

  enqueueDueReminders(now: number): number {
    try {
      if (!Number.isFinite(now)) throw new Error("Invalid reminder clock");
      const queued = this.db.transaction(() => {
        const due = this.db.query<ReminderRow, [number]>(`SELECT * FROM reminders
          WHERE status = 'scheduled' AND dueAt <= ? ORDER BY dueAt, id`).all(now);
        for (const reminder of due) {
          const operationId = `reminder:${reminder.id}:${reminder.revision}`;
          const localDue = new Intl.DateTimeFormat("en-US", {
            timeZone: reminder.timezone, dateStyle: "medium", timeStyle: "long",
          }).format(reminder.dueAt);
          const text = `[Reminder ${reminder.id}] ${reminder.text}\nDue: ${localDue} (${reminder.timezone}; ${new Date(reminder.dueAt).toISOString()})${now - reminder.dueAt > 60_000 ? " [late]" : ""}`;
          if (!this.enqueue({ id: operationId, kind: "notification", text })) {
            throw new Error(`Reminder operation already exists: ${operationId}`);
          }
          this.db.query("UPDATE outbox SET reminderId = ? WHERE id = ?").run(reminder.id, operationId);
          this.db.query(`UPDATE reminders SET status = 'queued', operationId = ? WHERE id = ?`
          ).run(operationId, reminder.id);
        }
        return due;
      }).immediate();
      for (const reminder of queued) toolLog({ component: "telegram", kind: "event", name: "tg.reminder", ok: true,
        ids: { reminder: reminder.id, operation: `reminder:${reminder.id}:${reminder.revision}` }, props: { action: "queue", state: "queued" } });
      return queued.length;
    } catch (error) {
      toolLog({ component: "telegram", kind: "error", name: "tg.reminder", ok: false,
        props: { action: "queue" }, error: { tag: "tg.reminder.queueFailed" } });
      throw error;
    }
  }
}
