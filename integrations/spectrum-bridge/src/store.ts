import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export type FileAttachment = { sha256: string; name: string; mimeType: string; size: number };
export type OutboxPoll = { title: string; options: string[] };
export type OutboxApp = {
  url: string; caption: string; subcaption?: string; trailingCaption?: string; trailingSubcaption?: string; summary?: string;
};
/** Registered at `poll:<pollMessageGuid>` when Photon accepts a poll operation. */
export type PollRecord = {
  operationId: string;
  title: string;
  options: { optionIdentifier: string; text: string }[];
  sessionId?: string;
  generation?: number;
  createdAt: number;
};

export type OutboxOperation = {
  id: string;
  // "notification" survives only for reference lookup of historical rows.
  kind: "notification" | "conversation" | "control";
  text: string;
  sessionId?: string;
  generation?: number;
  replyTo?: string;
  attachment?: FileAttachment;
  /** SDK effect name, such as "confetti"; applies to the first text chunk only. */
  effect?: string;
  subject?: string;
  poll?: OutboxPoll;
  app?: OutboxApp;
  /**
   * The owner decision this message asks for. Delivery records each accepted
   * guid in `notices`, which Robob reads to tie his reply to this one record.
   */
  notice?: OwnerNoticeRef;
};

/** A runtime request (approval or question) the bridge asked the owner about. */
export type OwnerNoticeRef = { kind: "runtime-request"; session: string; recordId: string };

export type OutboxRecord = OutboxOperation & {
  state: string;
  attempts: number;
  providerId?: string;
};

export type InboundRecord = { id: string; payload: unknown; state: string };

type OutboxRow = {
  payload: string;
  state: string;
  attempts: number;
  providerId: string | null;
};

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

export const MAX_BLOB_BYTES = 20 * 1024 * 1024;

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
        CREATE TABLE IF NOT EXISTS inbound (
          id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS outbox (
          id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0, providerId TEXT UNIQUE
        );
        CREATE INDEX IF NOT EXISTS outbox_state ON outbox(state);
        CREATE TABLE IF NOT EXISTS blobs (sha256 TEXT PRIMARY KEY, data BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS session_notices (id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS session_notices_state ON session_notices(state);
        CREATE TABLE IF NOT EXISTS notices (
          guid TEXT PRIMARY KEY, operation_id TEXT NOT NULL, kind TEXT NOT NULL,
          session TEXT NOT NULL, record_id TEXT NOT NULL, sent_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS notices_sent_at ON notices(sent_at);
      `);
      // A provider may have accepted these sends before the process stopped.
      this.db.query("UPDATE outbox SET state = 'uncertain' WHERE state = 'sending'").run();
    } catch (error) {
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

  acceptInbound(id: string, payload: unknown): boolean {
    return this.db.query(`INSERT INTO inbound (id, payload, state) VALUES (?, ?, 'pending')
      ON CONFLICT(id) DO NOTHING`).run(id, json(payload)).changes === 1;
  }

  pendingInbound(): InboundRecord[] {
    return this.db.query<Omit<InboundRecord, "payload"> & { payload: string }, []>(
      "SELECT id, payload, state FROM inbound WHERE state IN ('pending', 'processing') ORDER BY rowid",
    ).all().map(row => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  updateInbound(id: string, state: string, payload?: unknown): void {
    const result = this.db.query(`UPDATE inbound SET state = ?, payload = COALESCE(?, payload)
      WHERE id = ?`).run(state, payload === undefined ? null : json(payload), id);
    if (!result.changes) throw new Error(`Unknown inbound: ${id}`);
  }

  enqueue(op: OutboxOperation): boolean {
    // Normalize property order and omit unrelated caller fields before comparing content.
    const payload = json({
      id: op.id, kind: op.kind, text: op.text, sessionId: op.sessionId,
      generation: op.generation, replyTo: op.replyTo,
      attachment: op.attachment ? { sha256: op.attachment.sha256, name: op.attachment.name,
        mimeType: op.attachment.mimeType, size: op.attachment.size } : undefined,
      effect: op.effect, subject: op.subject,
      poll: op.poll ? { title: op.poll.title, options: [...op.poll.options] } : undefined,
      app: op.app ? { url: op.app.url, caption: op.app.caption, subcaption: op.app.subcaption,
        trailingCaption: op.app.trailingCaption, trailingSubcaption: op.app.trailingSubcaption, summary: op.app.summary } : undefined,
      notice: op.notice ? { kind: op.notice.kind, session: op.notice.session, recordId: op.notice.recordId } : undefined,
    });
    return this.db.transaction(() => {
      const result = this.db.query(`INSERT INTO outbox (id, payload, state) VALUES (?, ?, 'pending')
        ON CONFLICT(id) DO NOTHING`).run(op.id, payload);
      if (result.changes) return true;
      const existing = this.db.query<{ payload: string }, [string]>(
        "SELECT payload FROM outbox WHERE id = ?",
      ).get(op.id)!;
      if (existing.payload !== payload) throw new Error(`Outbox content mismatch: ${op.id}`);
      return false;
    }).immediate();
  }

  pendingOutbox(): OutboxRecord[] {
    return this.db.query<OutboxRow, []>(
      "SELECT payload, state, attempts, providerId FROM outbox WHERE state = 'pending' ORDER BY rowid",
    ).all().map(outboxRecord);
  }

  putBlob(data: Uint8Array): string {
    if (data.byteLength > MAX_BLOB_BYTES) throw new Error("Attachment exceeds 20 MiB");
    const sha256 = createHash("sha256").update(data).digest("hex");
    this.db.query("INSERT INTO blobs (sha256, data) VALUES (?, ?) ON CONFLICT(sha256) DO NOTHING").run(sha256, data);
    return sha256;
  }

  getBlob(sha256: string): Uint8Array {
    const row = this.db.query<{ data: Uint8Array }, [string]>("SELECT data FROM blobs WHERE sha256 = ?").get(sha256);
    if (!row || createHash("sha256").update(row.data).digest("hex") !== sha256) throw new Error("Attachment blob unavailable");
    return row.data;
  }

  outboxState(id: string, state: string, providerId?: string): void {
    this.db.transaction(() => {
      const result = this.db.query(`UPDATE outbox SET
        attempts = attempts + CASE WHEN ? = 'sending' AND state != 'sending' THEN 1 ELSE 0 END,
        state = ?, providerId = COALESCE(?, providerId) WHERE id = ?`
      ).run(state, state, providerId ?? null, id);
      if (!result.changes) throw new Error(`Unknown outbox operation: ${id}`);
    }).immediate();
  }

  byProviderId(id: string): OutboxRecord | undefined {
    const operation = this.get<string>(`provider-operation:${id}`);
    if (operation) return this.getOperation(operation);
    const row = this.db.query<OutboxRow, [string]>(
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
    return this.getOperation(id) ?? this.byProviderId(id);
  }

  /**
   * Records that the owner was sent this guid about one decision. Called inside
   * delivery's acceptance transaction, so a guid exists here only once Photon
   * accepted it. A guid never moves to another record.
   */
  recordNotice(guid: string, operationId: string, notice: OwnerNoticeRef, sentAt: number): void {
    this.db.query(`INSERT INTO notices (guid, operation_id, kind, session, record_id, sent_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(guid) DO NOTHING`)
      .run(guid, operationId, notice.kind, notice.session, notice.recordId, sentAt);
  }

  notice(guid: string): (OwnerNoticeRef & { guid: string; operationId: string; sentAt: number }) | undefined {
    const row = this.db.query<{ guid: string; operationId: string; kind: "runtime-request"; session: string; recordId: string; sentAt: number }, [string]>(
      `SELECT guid, operation_id AS operationId, kind, session, record_id AS recordId, sent_at AS sentAt
       FROM notices WHERE guid = ?`,
    ).get(guid);
    return row ?? undefined;
  }
}
