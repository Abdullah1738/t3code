import type { NormalizedInbound } from "./photon.ts";
import type { InboundRecord, OutboxOperation, Store } from "./store.ts";
import { toolLog } from "./toollog.ts";

export const UNANSWERED_REQUEUE_MS = 5 * 60_000;
export const UNANSWERED_ALERT_MS = 10 * 60_000;
export const UNANSWERED_RESTART_WINDOW_MS = 30 * 60_000;
export const humanRow = (id: string) => !/^(?:wake|secret|reset):/.test(id);
export type AnsweredInput = NormalizedInbound & { answeredAt?: number; unanswered?: {
  overdueAt?: number; requeuedAt?: number; alertAttempts?: number; alertedAt?: number;
} };
export const humanInput = (input: NormalizedInbound) => input.source === "typed" || input.source === "composed" && input.isAudioMessage;
export type ReplyTurn = { id: string; generation: number; messageId: string; inboundId?: string;
  covered?: string[]; background?: boolean; phase: string };

export function turnMembers(store: Store, turn: ReplyTurn): string[] {
  return [...new Set([...(turn.inboundId
    ? store.get<NormalizedInbound | null>(`batch:${turn.inboundId}`)?.batchIds ?? [turn.inboundId] : []), ...turn.covered ?? []])];
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
  const ids = [store.get<string>(`log-inbound-id:${op.id}`), op.replyTo].flatMap(id => {
    if (!id) return [];
    let batch = store.get<NormalizedInbound>(`batch:${id}`);
    if (!batch) {
      const parent = store.db.query<{ value: string }, [string]>(
        "SELECT kv.value FROM kv, json_each(kv.value, '$.batchIds') member WHERE kv.key GLOB 'batch:*' AND member.value = ? LIMIT 1",
      ).get(id);
      if (parent) batch = JSON.parse(parent.value) as NormalizedInbound;
    }
    return batch?.batchIds ?? [id];
  });
  const covered = [...new Set(ids.filter(humanRow))];
  store.set(`reply-covered:${op.id}`, covered);
  return covered;
}

/** Reconcile upgrade history before overdue rows can be replayed. Session identity alone is not proof. */
export function reconcileLegacyReplies(store: Store, since: number, now: number): void {
  const rows = store.db.query<{ id: string }, []>(`SELECT o.id FROM outbox o
    WHERE o.state = 'sent' AND NOT EXISTS (SELECT 1 FROM kv WHERE key = 'reply-covered:' || o.id)`).all()
    .map(({ id }) => {
      const sentAt = store.get<number>(`sent-at:${id}`);
      const known = Number.isSafeInteger(sentAt) && sentAt! >= 0 && sentAt! <= now;
      return { op: store.getOperation(id)!, at: known ? sentAt! : now, known };
    }).sort((a, b) => a.at - b.at);
  store.db.transaction(() => {
    for (const { op, at, known } of rows) {
      const covered = deliveredReplyCoverage(store, op).filter(id => {
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
    for (const id of new Set(ids.filter(humanRow))) {
      const row = store.db.query<{ payload: string; state: string }, [string]>("SELECT payload, state FROM inbound WHERE id = ?").get(id);
      if (!row) continue;
      const input = JSON.parse(row.payload) as AnsweredInput;
      if (!humanInput(input) || input.answeredAt !== undefined) continue;
      store.updateInbound(id, row.state === "admitted" ? "done" : row.state, { ...input, answeredAt: now });
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
