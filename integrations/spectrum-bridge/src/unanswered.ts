import type { NormalizedInbound } from "./photon.ts";
import type { InboundRecord, OutboxOperation, Store } from "./store.ts";
import { toolLog } from "./toollog.ts";

export const UNANSWERED_REQUEUE_MS = 5 * 60_000;
export const UNANSWERED_ALERT_MS = 10 * 60_000;
export const UNANSWERED_RESTART_WINDOW_MS = 30 * 60_000;

/** Remote content stays encrypted; the relay needs only receipt times and reply attribution. */
export class RemoteUnanswered {
  private checking?: Promise<void>;
  constructor(private readonly store: Store, private readonly notify?: (severity: "attention", text: string, key: string) => Promise<boolean>) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS remote_unanswered (
      id TEXT PRIMARY KEY, received_at INTEGER NOT NULL, answered_at INTEGER, alert TEXT, alerted_at INTEGER)`);
  }
  accept(id: string, at: number) {
    this.store.db.query("INSERT OR IGNORE INTO remote_unanswered(id,received_at) VALUES (?,?)").run(id, at);
  }
  answered(id: string, at: number) {
    this.store.db.query("UPDATE remote_unanswered SET answered_at=COALESCE(answered_at,?) WHERE id=?").run(at, id);
  }
  check(now: number): Promise<void> {
    return this.checking ??= this.sweep(now).finally(() => { this.checking = undefined; });
  }
  private async sweep(now: number) {
    if (!this.notify) return;
    const rows = this.store.db.query<{ id: string; received_at: number; alert: string | null }, [number]>(
      "SELECT id,received_at,alert FROM remote_unanswered WHERE answered_at IS NULL AND alerted_at IS NULL AND received_at<=? ORDER BY received_at",
    ).all(now - UNANSWERED_ALERT_MS);
    for (const row of rows) {
      const live = this.store.db.query("SELECT 1 FROM remote_unanswered WHERE id=? AND answered_at IS NULL AND alerted_at IS NULL").get(row.id);
      if (!live) continue;
      const ageMs = Math.max(0, now - row.received_at);
      const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit" }).format(row.received_at);
      // Freeze the payload before sending: Telegram rejects changed text for the same key.
      const text = row.alert ?? `Moni's iMessage from ${time} (Dubai) has had no reply for ${Math.floor(ageMs / 60_000)} min (backend: remote-box). Check her box queue.`;
      if (!row.alert) this.store.db.query("UPDATE remote_unanswered SET alert=? WHERE id=?").run(text, row.id);
      const sent = await this.notify("attention", text, `imessage-unanswered:${row.id}`).catch(() => false);
      if (sent) this.store.db.query("UPDATE remote_unanswered SET alerted_at=? WHERE id=?").run(now, row.id);
      toolLog.capture(() => toolLog.write({ component: "remote-box", kind: "error", name: "unanswered.alert",
        ids: { inboundId: row.id, chat: "moni" }, props: { backend: "remote-box", ageMs, telegram: sent ? "sent" : "failed" }, error: { tag: "inbound.unanswered" } }));
    }
  }
}
export const humanRow = (id: string) => !/^(?:wake|secret|reset):/.test(id);
export type AnsweredInput = NormalizedInbound & { answeredAt?: number; unanswered?: {
  overdueAt?: number; requeuedAt?: number; alertAttempts?: number; alertedAt?: number;
} };
export const humanInput = (input: NormalizedInbound) => input.source === "typed" || input.source === "composed" && input.isAudioMessage;
export type ReplyTurn = { id: string; generation: number; messageId: string; inboundId?: string;
  covered?: string[]; steered?: string[]; startedAt?: number; outbox?: number; earlyOutbox?: string; background?: boolean; phase: string };

function sealedBatch(store: Store, id: string): { leader: string; members: string[] } {
  const batch = store.get<NormalizedInbound>(`batch:${id}`);
  if (batch) return { leader: id, members: batch.batchIds ?? [id] };
  const parent = store.db.query<{ key: string; value: string }, [string]>(
    "SELECT kv.key, kv.value FROM kv, json_each(kv.value, '$.batchIds') member WHERE kv.key GLOB 'batch:*' AND member.value = ? LIMIT 1",
  ).get(id);
  return parent ? { leader: parent.key.slice("batch:".length), members: (JSON.parse(parent.value) as NormalizedInbound).batchIds! }
    : { leader: id, members: [id] };
}

// A steer snapshot keeps the original turn's start and outbox fence even after admission clears its attempt.
function legacyTurnRows(store: Store, turn: ReplyTurn): ReplyTurn[] {
  if (!Number.isSafeInteger(turn.startedAt) || !Number.isSafeInteger(turn.outbox)) return [];
  return store.db.query<{ value: string }, [string, number, number, number]>(`SELECT value FROM kv
    WHERE key GLOB 'failed-delivery:*' AND json_extract(value, '$.id') = ?
      AND json_extract(value, '$.generation') = ? AND json_extract(value, '$.startedAt') = ?
      AND json_extract(value, '$.outbox') = ?`).all(turn.id, turn.generation, turn.startedAt!, turn.outbox!)
    .map(row => JSON.parse(row.value) as ReplyTurn);
}

export function turnMembers(store: Store, turn: ReplyTurn): string[] {
  const legacy = turn.covered === undefined && turn.steered?.length
    ? legacyTurnRows(store, turn).filter(row => turn.steered!.includes(row.messageId))
      .flatMap(row => row.inboundId ? sealedBatch(store, row.inboundId).members : []) : [];
  return [...new Set([...(turn.inboundId ? sealedBatch(store, turn.inboundId).members : []), ...turn.covered ?? [], ...legacy])];
}

/** Capture membership at enqueue time: the turn may be gone when delivery finishes. */
export function captureReplyCoverage(store: Store, op: OutboxOperation): void {
  const turn = store.get<ReplyTurn | null>("activeTurn");
  const ids = op.sessionId && turn?.id === op.sessionId && turn.generation === op.generation ? turnMembers(store, turn) : [];
  if (op.replyTo) ids.push(...store.get<NormalizedInbound | null>(`batch:${op.replyTo}`)?.batchIds ?? [op.replyTo]);
  store.set(`reply-covered:${op.id}`, [...new Set(ids.filter(humanRow))]);
}

/** Older sends have delivery attribution, but predate the coverage snapshot. */
export function deliveredReplyCoverage(store: Store, op: OutboxOperation): string[] {
  const saved = store.get<string[]>(`reply-covered:${op.id}`);
  if (saved !== undefined) return saved;
  const sources = [store.get<string>(`log-inbound-id:${op.id}`), op.replyTo]
    .flatMap(id => id ? [sealedBatch(store, id)] : []);
  const ids = sources.flatMap(source => source.members);
  const queuedAt = store.get<number>(`log-queued:${op.id}`);
  const position = store.db.query<{ rowid: number }, [string]>("SELECT rowid FROM outbox WHERE id = ?").get(op.id)?.rowid;
  for (const { leader } of sources) {
    const turn = store.get<ReplyTurn | null>(`failed-delivery:${leader}`);
    // A late-adopted steer keeps its predecessor's fences. Only the original prompt's
    // submitting snapshot proves that a reply attributed to this row covered that cohort.
    if (!turn || turn.phase !== "submitting" || turn.id !== op.sessionId || turn.generation !== op.generation
      || !Number.isSafeInteger(queuedAt) || queuedAt! < (turn.startedAt ?? Infinity)
      || position === undefined || position <= (turn.outbox ?? Infinity)) continue;
    for (const member of legacyTurnRows(store, turn)) {
      if (!member.inboundId || store.get(`batch-phase:${member.inboundId}`) !== "accepted") continue;
      const admittedAt = store.get<number>(`inbound-delivered:${member.inboundId}`);
      if (!Number.isSafeInteger(admittedAt) || admittedAt! > queuedAt!) continue;
      // An early reply already present when this steer was posted cannot have answered it.
      const early = member.earlyOutbox && store.db.query<{ rowid: number }, [string]>("SELECT rowid FROM outbox WHERE id = ?").get(member.earlyOutbox);
      if (early && position <= early.rowid) continue;
      ids.push(...sealedBatch(store, member.inboundId).members);
    }
  }
  const covered = [...new Set(ids.filter(humanRow))];
  store.set(`reply-covered:${op.id}`, covered);
  return covered;
}

/** Reconcile upgrade history before overdue rows can be replayed. Session identity alone is not proof. */
export function reconcileLegacyReplies(store: Store, since: number, now: number): void {
  const rows = store.db.query<{ id: string }, []>(`SELECT o.id FROM outbox o
    WHERE o.state IN ('pending', 'sending', 'uncertain', 'failed', 'sent') AND NOT EXISTS (SELECT 1 FROM kv WHERE key = 'reply-covered:' || o.id)`).all()
    .map(({ id }) => {
      const sentAt = store.get<number>(`sent-at:${id}`);
      const known = Number.isSafeInteger(sentAt) && sentAt! >= 0 && sentAt! <= now;
      return { op: store.getOperation(id)!, at: known ? sentAt! : now, known };
    }).sort((a, b) => a.at - b.at);
  store.db.transaction(() => {
    for (const { op, at, known } of rows) {
      // Capture queued sends before requeueHuman clears their legacy admission evidence.
      const snapshot = deliveredReplyCoverage(store, op);
      if (op.state !== "sent") continue;
      const covered = snapshot.filter(id => {
        const row = store.db.query<{ payload: string }, [string]>("SELECT payload FROM inbound WHERE id = ?").get(id);
        const receivedAt = row ? (JSON.parse(row.payload) as AnsweredInput).receivedAt : undefined;
        return Number.isSafeInteger(receivedAt) && receivedAt! >= since && receivedAt! <= at;
      });
      markAnswered(store, covered, at, { recordLatency: known });
    }
  }).immediate();
}

/** All successful text, card, file, poll and explicit reaction paths share this marker. */
export function markAnswered(store: Store, ids: string[], now = Date.now(), opts: { recordLatency?: boolean } = {}): void {
  store.db.transaction(() => {
    const covered = new Set(ids.filter(humanRow));
    const rows = [...covered].flatMap(id => {
      const row = store.db.query<{ payload: string; state: string }, [string]>("SELECT payload, state FROM inbound WHERE id = ?").get(id);
      return row ? [{ id, state: row.state, input: JSON.parse(row.payload) as AnsweredInput }] : [];
    });
    // A late delivery can win before dispatch starts the watchdog retry. Retire only whole,
    // still-pending batches; a retry already submitted to the backend keeps its lifecycle.
    const queuedRetries = new Set(rows.filter(({ id, state, input }) => state === "pending"
      && input.unanswered?.requeuedAt !== undefined && store.get(`human-own-turn:${id}`)
      && sealedBatch(store, id).members.every(member => covered.has(member))).map(row => row.id));
    for (const { id, state, input } of rows) {
      if (!humanInput(input)) continue;
      const retryAnswered = (state === "pending" || state === "batched") && queuedRetries.has(sealedBatch(store, id).leader);
      const nextState = state === "admitted" || retryAnswered ? "done" : state;
      if (input.answeredAt !== undefined) {
        if (nextState !== state) store.updateInbound(id, nextState);
        continue;
      }
      store.updateInbound(id, nextState, { ...input, answeredAt: now });
      const ageMs = Math.max(0, now - (input.receivedAt ?? now));
      const chat = store.get<string>("unanswered-chat") ?? "other";
      toolLog.capture(() => {
        if (opts.recordLatency !== false && (chat === "owner" || chat === "moni")) toolLog.write({ component: "router", kind: "perf", name: "inbound.answered",
          ids: { inboundId: id, chat }, durationMs: ageMs });
        if (input.unanswered?.overdueAt !== undefined) toolLog.write({ component: "router", kind: "event", name: "inbound.answered_late",
          ids: { inboundId: id, chat }, props: { ageMs } });
      });
    }
  }).immediate();
}

export function markReactionAnswered(store: Store, target: string): void {
  const turn = store.get<ReplyTurn | null>("activeTurn");
  // A reaction to old history must not acknowledge an unrelated current turn.
  const members = turn ? turnMembers(store, turn) : [];
  markAnswered(store, members.includes(target) ? members : [target]);
}

export type Running = { members: readonly string[]; leaderKind: "human" | "wake" | "reset" | "background" };
export function findOverdue(rows: readonly InboundRecord[], running: Running | undefined, now: number,
  opts: { startedAt: number; chat: string }) {
  if (opts.chat !== "owner" && opts.chat !== "moni") return [];
  return rows.flatMap(row => {
    const input = row.payload as AnsweredInput;
    if (!humanRow(row.id) || !humanInput(input) || input.answeredAt !== undefined
      || ["cancelled", "observed"].includes(row.state) || !Number.isSafeInteger(input.receivedAt)
      || input.receivedAt! < opts.startedAt - UNANSWERED_RESTART_WINDOW_MS) return [];
    const ageMs = now - input.receivedAt!;
    if (ageMs < UNANSWERED_REQUEUE_MS) return [];
    const inTurn = running?.leaderKind === "human" && running.members.includes(row.id);
    return [{ row, input, ageMs, action: inTurn ? "in_turn" as const : "requeued" as const,
      leaderKind: running?.leaderKind ?? "none" as const,
      requeue: !inTurn && input.unanswered?.requeuedAt === undefined,
      alert: ageMs >= UNANSWERED_ALERT_MS && input.unanswered?.alertedAt === undefined && (input.unanswered?.alertAttempts ?? 0) < 3 }];
  });
}

export function unansweredAlert(chat: string, input: AnsweredInput, state: string, ageMs: number, inTurn: boolean): string {
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit" }).format(input.receivedAt);
  return `${chat === "moni" ? "Moni's" : "Abdullah's"} iMessage from ${time} (Dubai) has had no reply for ${Math.floor(ageMs / 60_000)} min (state: ${state}, ${inTurn ? "in a running turn" : "requeued"}). The bridge is retrying.`;
}
