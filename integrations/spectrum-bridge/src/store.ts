import { deliveredReplyCoverage, humanInput, humanRow, markControlAcked, markAnswered, turnMembers, type ReplyTurn, type AnsweredInput } from "./unanswered.ts";
import { rememberHealthReceipt, type HealthSidecar } from "./health-receipts.ts";
import { toolError, toolLog } from "./toollog.ts";
import { Database } from "bun:sqlite";
import { traceLoopOperation } from "./loop-stall.ts";
import { createHash } from "node:crypto";

const steerSourceKey = (sessionId: string, generation: number, inboundId: string) =>
  `steer-reply-source:${createHash("sha256").update(JSON.stringify([sessionId, generation, inboundId])).digest("hex")}`;

export type FileAttachment = { sha256: string; name: string; mimeType: string; size: number };
export type ReplyAttribution = { inboundId?: string; covered?: string[]; attribution?: "explicit" | "active_turn" | "pending_inbound" | "none" };
export const RECENT_REPLY_TURN_MS = 5 * 60_000;
export type OutboxPoll = { title: string; options: string[] };
export type OutboxApp = {
  url: string; caption: string; subcaption?: string; trailingCaption?: string; trailingSubcaption?: string; summary?: string;
  /** Original app outbox operation in this chat; never a provider handle. */
  updateOf?: string;
  /** Immutable stage preview page; the tap-through URL remains live. */
  previewPage?: string;
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
  /** A direct command response, such as /status, can complete its own inbound row. */
  answersInbound?: true;
  text: string;
  sessionId?: string;
  generation?: number;
  replyTo?: string;
  attachment?: FileAttachment;
  healthReceipt?: HealthSidecar;
  /** SDK effect name, such as "confetti"; applies to the first text chunk only. */
  effect?: string;
  subject?: string;
  poll?: OutboxPoll;
  app?: OutboxApp;
};

export type OutboxRecord = OutboxOperation & {
  state: string;
  attempts: number;
  providerId?: string;
};

export type InboundRecord = { id: string; payload: unknown; state: string };
export type InboundFailure = { stage: string; message: string; threadId: string | null; at: number };

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
        -- LIKE uses NOCASE; the binary primary key cannot bound its prefix scans.
        CREATE INDEX IF NOT EXISTS kv_key_nocase ON kv(key COLLATE NOCASE);
        CREATE TABLE IF NOT EXISTS inbound (
          id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS inbound_state ON inbound(state);
        CREATE TABLE IF NOT EXISTS outbox (
          id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0, providerId TEXT UNIQUE
        );
        CREATE INDEX IF NOT EXISTS outbox_state ON outbox(state);
        CREATE INDEX IF NOT EXISTS outbox_sent_reply ON outbox(json_extract(payload, '$.replyTo')) WHERE state = 'sent';
        CREATE INDEX IF NOT EXISTS kv_sent_at ON kv(CAST(value AS INTEGER)) WHERE substr(key, 1, 8) = 'sent-at:';
        CREATE TABLE IF NOT EXISTS blobs (sha256 TEXT PRIMARY KEY, data BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS session_notices (id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS session_notices_state ON session_notices(state);
      `);
      const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(inbound)").all();
      if (!columns.some(column => column.name === "failure")) this.db.exec("ALTER TABLE inbound ADD COLUMN failure TEXT");
      this.db.exec("CREATE INDEX IF NOT EXISTS inbound_failed ON inbound(state) WHERE state = 'failed'");
      // A provider may have accepted these sends before the process stopped.
      this.db.query("UPDATE outbox SET state = 'uncertain' WHERE state = 'sending'").run();
    } catch (error) { toolError("store", "store.catch1", error);
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

  /** True when a message from one of these addresses ever arrived in this chat (group membership proof). */
  hasInboundFrom(addresses: string[]): boolean {
    const wanted = [...new Set(addresses.map(address => address.trim().toLowerCase()).filter(Boolean))];
    if (wanted.length === 0) return false;
    const marks = wanted.map(() => "?").join(", ");
    return this.db.query(`SELECT 1 FROM inbound WHERE lower(trim(json_extract(payload, '$.sender'))) IN (${marks}) LIMIT 1`)
      .get(...wanted) !== null;
  }

  groupAudience(): string[] {
    const rosters = this.db.query<{ rowid: number; participants: string }, []>(`SELECT rowid, json_extract(payload, '$.participants') AS participants
      FROM inbound WHERE json_type(payload, '$.participants') = 'array'
      AND json_array_length(payload, '$.participants') > 0 ORDER BY rowid DESC`);
    let members: string[] = [];
    let since = 0;
    // Select and normalize in JS: SQLite TRIM does not recognize all JS whitespace.
    // Exhaust the cached query before selecting a roster; Bun 1.4.1 leaves a broken-out iterator active.
    for (const roster of rosters.all()) {
      members = (JSON.parse(roster.participants) as unknown[])
        .filter((address): address is string => typeof address === "string").map(address => address.trim()).filter(Boolean);
      if (members.length) { since = roster.rowid; break; }
    }
    // Rosterless messages can reveal members added since the last reported roster.
    const observed = this.db.query<{ sender: string }, [number]>(`SELECT DISTINCT json_extract(payload, '$.sender') AS sender
      FROM inbound WHERE rowid >= ? AND json_type(payload, '$.sender') = 'text'
      ORDER BY sender`).all(since).map(row => row.sender.trim()).filter(Boolean);
    return [...new Set([...members, ...observed])];
  }

  pendingInbound(): InboundRecord[] {
    return traceLoopOperation("inbound.pending", () => this.db.query<Omit<InboundRecord, "payload"> & { payload: string }, []>(
      "SELECT id, payload, state FROM inbound WHERE state IN ('pending', 'processing') ORDER BY rowid",
    ).all().map(row => ({ ...row, payload: JSON.parse(row.payload) })));
  }

  updateInbound(id: string, state: string, payload?: unknown, failure?: InboundFailure): void {
    if (payload !== undefined) {
      const previous = this.db.query<{ payload: string }, [string]>("SELECT payload FROM inbound WHERE id = ?").get(id);
      const saved = previous ? JSON.parse(previous.payload) as AnsweredInput : undefined;
      if (saved?.answeredAt !== undefined || saved?.unanswered !== undefined) payload = { ...payload as object,
        ...(saved.answeredAt !== undefined ? { answeredAt: saved.answeredAt } : {}),
        ...(saved.unanswered ? { unanswered: { ...saved.unanswered, ...(payload as AnsweredInput).unanswered } } : {}) };
    }
    const detail = failure ?? (state === "failed" ? { stage: "state-transition", message: "No failure detail supplied", threadId: null, at: Date.now() } : undefined);
    const result = this.db.query(`UPDATE inbound SET state = ?, payload = COALESCE(?, payload), failure = COALESCE(?, failure)
      WHERE id = ?`).run(state, payload === undefined ? null : json(payload), detail ? json(detail) : null, id);
    if (!result.changes) throw new Error(`Unknown inbound: ${id}`);
  }

  inboundFailure(id: string): InboundFailure | undefined {
    const row = this.db.query<{ failure: string | null }, [string]>("SELECT failure FROM inbound WHERE id = ?").get(id);
    return row?.failure ? JSON.parse(row.failure) : undefined;
  }

  recordInboundFailure(id: string, failure: InboundFailure): void {
    this.db.query("UPDATE inbound SET failure = ? WHERE id = ?").run(json(failure), id);
  }

  failedInbound(): InboundRecord[] {
    return this.db.query<{ id: string; payload: string; state: string }, []>(
      "SELECT id, payload, state FROM inbound WHERE state = 'failed' ORDER BY rowid",
    ).all().map(row => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  replyAttribution(sessionId?: string, generation?: number): ReplyAttribution & { covered: string[] } {
    const active = this.get<ReplyTurn & { replyInboundId?: string } | null>("activeTurn");
    const recent = this.get<{ turn: ReplyTurn & { replyInboundId?: string }; at: number }>("recentReplyTurn");
    const live = active && active.id === sessionId && active.generation === generation;
    // A restart continuation may replace the failed human turn with a background turn before its CLI reply arrives.
    const turn = live && (active.inboundId || turnMembers(this, active).some(humanRow)) ? active
      : recent && recent.turn.id === sessionId && recent.turn.generation === generation
        && Date.now() >= recent.at && Date.now() - recent.at <= RECENT_REPLY_TURN_MS ? recent.turn : undefined;
    if (!turn) return { covered: [], attribution: "none" };
    const turnHumans = turnMembers(this, turn).filter(humanRow);
    // Attribution A (#111): when ALL of the turn's own human members are already answered,
    // an un-quoted send on the same chat credits pending/queued human inbound(s) and retires their turn.
    if (turnHumans.length > 0 && turnHumans.every(id => !!this.db.query(
      "SELECT 1 FROM inbound WHERE id = ? AND json_type(payload, '$.answeredAt') = 'integer'",
    ).get(id))) {
      const pendingRows = this.db.query<{ id: string; payload: string }, []>(`SELECT id, payload FROM inbound
        WHERE state IN ('pending', 'batched')
          AND json_extract(payload, '$.answeredAt') IS NULL
          AND json_extract(payload, '$.settledAt') IS NULL
        ORDER BY rowid`).all();
      const pendingCovered = pendingRows.filter(row => {
        if (!humanRow(row.id)) return false;
        const input = JSON.parse(row.payload) as AnsweredInput;
        if (!humanInput(input) && !(input.source === undefined && input.id === row.id && Array.isArray(input.attachments))) return false;
        return !/^\/(?:new|stop|reset)\b/i.test((input.text ?? "").trim());
      }).map(row => row.id);
      if (pendingCovered.length > 0) {
        return { inboundId: pendingCovered[0], covered: pendingCovered, attribution: "pending_inbound" };
      }
    }
    const covered = turnHumans.filter(id => turn === active || !!this.db.query(`SELECT 1 FROM inbound
      WHERE id = ? AND json_extract(payload, '$.answeredAt') IS NULL AND state NOT IN ('cancelled', 'observed')`).get(id));
    const source = turn.replyInboundId ?? turn.inboundId;
    return { inboundId: turn === active ? source ?? covered[0] : source && covered.includes(source) ? source : covered[0], covered,
      attribution: source || covered.length ? "active_turn" : "none" };
  }

  rememberReplyTurn(turn: ReplyTurn & { replyInboundId?: string }): void {
    if (turnMembers(this, turn).some(humanRow)) this.set("recentReplyTurn", { turn, at: Date.now() });
  }

  enqueue(op: OutboxOperation, attribution?: ReplyAttribution): boolean {
    // Normalize property order and omit unrelated caller fields before comparing content.
    const payload = json({
      id: op.id, kind: op.kind, ...(op.answersInbound ? { answersInbound: true } : {}), text: op.text, sessionId: op.sessionId,
      generation: op.generation, replyTo: op.replyTo,
      attachment: op.attachment ? { sha256: op.attachment.sha256, name: op.attachment.name,
        mimeType: op.attachment.mimeType, size: op.attachment.size } : undefined,
      ...(op.healthReceipt ? { healthReceipt: op.healthReceipt } : {}),
      effect: op.effect, subject: op.subject,
      poll: op.poll ? { title: op.poll.title, options: [...op.poll.options] } : undefined,
      app: op.app ? { url: op.app.url, caption: op.app.caption, subcaption: op.app.subcaption,
        trailingCaption: op.app.trailingCaption, trailingSubcaption: op.app.trailingSubcaption, summary: op.app.summary,
        updateOf: op.app.updateOf, previewPage: op.app.previewPage } : undefined,
    });
    return this.db.transaction(() => {
      const result = this.db.query(`INSERT INTO outbox (id, payload, state) VALUES (?, ?, 'pending')
        ON CONFLICT(id) DO NOTHING`).run(op.id, payload);
      if (result.changes) {
        const source = attribution ?? this.replyAttribution(op.sessionId, op.generation);
        this.set(`reply-covered:${op.id}`, (attribution?.covered ?? [...new Set([
          ...source.covered ?? [],
          ...(op.replyTo ? this.get<{ batchIds?: string[] }>(`batch:${op.replyTo}`)?.batchIds ?? [op.replyTo] : []),
        ])]).filter(humanRow));
        if (op.kind === "control" && !op.answersInbound) deliveredReplyCoverage(this, op);
        if (op.app?.updateOf) this.set(`app-latest:${op.app.updateOf}`, op.id);
        toolLog.capture(() => {
          this.set(`log-queued:${op.id}`, Date.now());
          // The quote may target a later batch member; correlation follows the turn that caused the send.
          let inboundId = source.inboundId ?? op.replyTo;
          this.set(`log-attribution:${op.id}`, source.inboundId ? source.attribution ?? "explicit" : op.replyTo ? "explicit" : "none");
          if (inboundId && op.sessionId && op.generation !== undefined) {
            inboundId = this.get<string>(steerSourceKey(op.sessionId, op.generation, inboundId)) ?? inboundId;
          }
          if (inboundId) this.set(`log-inbound-id:${op.id}`, inboundId);
          const row = inboundId ? this.db.query<{ payload: string }, [string]>("SELECT payload FROM inbound WHERE id = ?").get(inboundId) : undefined;
          const receivedAt = row ? (JSON.parse(row.payload) as { receivedAt?: number }).receivedAt : undefined;
          if (typeof receivedAt === "number" && Number.isFinite(receivedAt)) this.set(`log-inbound-at:${op.id}`, receivedAt);
        });
        return true;
      }
      const existing = this.db.query<{ payload: string }, [string]>(
        "SELECT payload FROM outbox WHERE id = ?",
      ).get(op.id)!;
      if (existing.payload !== payload) throw new Error(`Outbox content mismatch: ${op.id}`);
      return false;
    }).immediate();
  }

  /** A steer can commit before its HTTP response, so its already queued replies need the confirmed human source. */
  attributeSteeredReplies(inboundId: string, sessionId: string, generation: number, afterOutbox: number, rootInboundId?: string): void {
    const input = this.db.query<{ payload: string }, [string]>("SELECT payload FROM inbound WHERE id = ?").get(inboundId);
    if (!input || !rootInboundId) return;
    // An API fold may have captured the old source before confirmation and enqueue after this transaction.
    const key = steerSourceKey(sessionId, generation, rootInboundId);
    const priorSource = this.get<string>(key);
    if (this.get(key) === undefined) this.set(key, inboundId);
    const receivedAt = (JSON.parse(input.payload) as { receivedAt?: number }).receivedAt;
    const rows = this.db.query<{ id: string; state: string }, [number, string, number]>(
      "SELECT id, state FROM outbox WHERE rowid > ? AND json_extract(payload, '$.kind') = 'conversation' AND json_extract(payload, '$.sessionId') = ? AND json_extract(payload, '$.generation') = ?",
    ).all(afterOutbox, sessionId, generation);
    for (const row of rows) {
      const previous = this.get<string>(`log-inbound-id:${row.id}`);
      if (previous !== undefined && previous !== rootInboundId && previous !== priorSource) continue;
      // Outbox order cannot prove a tool send answered a steer that was not yet confirmed.
      // Its captured coverage stays authoritative even when logging gains a better source.
      this.set(`log-inbound-id:${row.id}`, inboundId);
      if (typeof receivedAt === "number" && Number.isFinite(receivedAt)) this.set(`log-inbound-at:${row.id}`, receivedAt);
      // Health may have consumed the acceptance receipt while its source was still uncertain.
      if (row.state === "sent") this.set(`reply-gap-recheck:${row.id}`, true);
    }
  }

  pendingOutbox(): OutboxRecord[] {
    return this.db.query<OutboxRow, []>(
      "SELECT payload, state, attempts, providerId FROM outbox WHERE state = 'pending' ORDER BY rowid",
    ).all().map(outboxRecord);
  }

  queuedSends(sessionId: string, generation: number, since: number): Pick<OutboxOperation, "id" | "text">[] {
    return this.db.query<{ id: string; text: string }, [string, number, number]>(`
      SELECT o.id, json_extract(o.payload, '$.text') AS text FROM outbox o
      JOIN kv ON kv.key = 'api:send:' || o.id
      WHERE o.id GLOB 'send:*' AND json_extract(o.payload, '$.sessionId') = ?
        AND json_extract(o.payload, '$.generation') = ?
        AND json_extract(kv.value, '$.queuedAt') >= ?
    `).all(sessionId, generation, since);
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
      if (state === "sent") {
        const op = this.getOperation(id)!;
        if (op.kind === "control" && !op.answersInbound) markControlAcked(this, op);
        else markAnswered(this, deliveredReplyCoverage(this, op));
      }
      rememberHealthReceipt(this, id, state);
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
}
