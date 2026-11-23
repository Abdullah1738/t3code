import { createHash } from "node:crypto";
import { causeKey, errorDetail } from "./log-error.ts";
import type { Store } from "./store.ts";
import { toolLog } from "./toollog.ts";

export const WAKE_AMBIGUITY_MS = 30 * 60_000;
/** Queueing and pre-POST deferrals count too; a watcher needs a timely fallback receipt. */
export const WAKE_DELIVERY_MS = 30 * 60_000;
export const wakeId = (key: string) => `wake:${createHash("sha256").update(key).digest("hex")}`;
export type WakeStatus = {
  id: string; state: "queued" | "sending" | "ambiguous" | "admitted" | "failed";
  acceptedAt: number; firstSendAt?: number; admittedAt?: number; failedAt?: number;
  attempts: number; threadId?: string; runId?: string;
};
type Record = WakeStatus & { source: string; turnStarted?: boolean; waitedBehind?: string;
  waitLoggedAt?: number; legacy?: boolean; beforeSend?: Pick<WakeStatus, "state" | "attempts" | "firstSendAt"> };
const key = (id: string) => `wake-delivery:${id}`;
const terminal = (status: WakeStatus) => status.state === "admitted" || status.state === "failed";

/** Also projects legacy rows; a status read never writes or starts delivery. */
export function wakeStatus(store: Store, id: string): WakeStatus | undefined {
  if (!id.startsWith("wake:")) return;
  const row = store.db.query<{ state: string; at: number | null }, [string]>(
    "SELECT state, json_extract(payload, '$.receivedAt') AS at FROM inbound WHERE id = ?",
  ).get(id);
  if (!row) return;
  const saved = store.get<Record>(key(id));
  const admittedAt = store.get<number>(`inbound-delivered:${id}`);
  const status: WakeStatus = saved ?? { id, acceptedAt: row.at ?? Date.now(), attempts: 0,
    state: admittedAt !== undefined || ["done", "admitted"].includes(row.state) ? "admitted" : ["failed", "cancelled", "unknown"].includes(row.state) ? "failed" : "queued",
    ...(admittedAt !== undefined ? { admittedAt } : {}),
    ...(row.state === "failed" ? { failedAt: store.inboundFailure(id)?.at ?? row.at ?? Date.now() } : {}),
  };
  // Explicit projection: neither the event body nor internal metadata is returned.
  return { id, state: status.state, acceptedAt: status.acceptedAt, attempts: status.attempts,
    ...(status.firstSendAt === undefined ? {} : { firstSendAt: status.firstSendAt }),
    ...(status.admittedAt === undefined ? {} : { admittedAt: status.admittedAt }),
    ...(status.failedAt === undefined ? {} : { failedAt: status.failedAt }),
    ...(status.threadId === undefined ? {} : { threadId: status.threadId }),
    ...(status.runId === undefined ? {} : { runId: status.runId }) };
}

/** Delivery receipts only; execution outcomes remain owned by the router. */
export class WakeDelivery {
  constructor(private readonly store: Store) {}
  private record(id: string): Record | undefined {
    const saved = this.store.get<Record>(key(id));
    if (saved) return saved;
    const status = wakeStatus(this.store, id);
    if (!status) return;
    const spec = this.store.get<{ spec: string }>(`api:wake:${id}`)?.spec;
    const source = spec ? (JSON.parse(spec) as { source?: string }).source : undefined;
    return { ...status, source: source ?? "bridge" };
  }
  private log(record: Record, name: string, props: { [key: string]: string | number } = {}, durationMs?: number): void {
    toolLog.capture(() => toolLog.write({ component: "router", kind: "event", name,
      ids: { inboundId: record.id, ...(record.threadId ? { threadId: record.threadId } : {}) },
      props: { source: record.source, ...props }, ...(durationMs === undefined ? {} : { durationMs }) }));
  }
  accept(id: string, source?: string, legacy = false): void {
    if (this.store.get(key(id))) return;
    const record = this.record(id);
    if (!record) return;
    if (source !== undefined) record.source = source;
    if (legacy) record.legacy = true;
    this.store.set(key(id), record);
    this.log(record, "wake.accepted");
  }
  legacy(id: string): boolean { return this.record(id)?.legacy === true; }
  waiting(id: string, run: string): void {
    this.accept(id);
    const record = this.record(id);
    if (record && !terminal(record) && !record.waitedBehind) this.store.set(key(id), { ...record, waitedBehind: run });
  }
  reportWaiting(id: string, holder: { runId: string; phase: string } | undefined,
    reason: "holder" | "link_down" | "cooldown" | "admission"): void {
    const record = this.record(id);
    if (!record || terminal(record) || record.waitLoggedAt !== undefined && Date.now() - record.waitLoggedAt < 5 * 60_000) return;
    this.store.set(key(id), { ...record, waitLoggedAt: Date.now(),
      ...(holder && !record.waitedBehind ? { waitedBehind: holder.runId } : {}) });
    this.log(record, "wake.waiting", { reason, waitMs: Math.max(0, Date.now() - record.acceptedAt),
      boundMs: WAKE_DELIVERY_MS, remainingMs: Math.max(0, record.acceptedAt + WAKE_DELIVERY_MS - Date.now()),
      ...(holder ? { holderRunId: holder.runId, holderPhase: holder.phase } : {}) });
  }
  start(id: string, threadId: string, batchSize: number): void {
    this.accept(id);
    const record = this.record(id);
    if (!record || terminal(record) || record.turnStarted) return;
    record.threadId = threadId;
    record.turnStarted = true;
    this.store.set(key(id), record);
    this.log(record, "wake.turn_start", { waitMs: Math.max(0, Date.now() - record.acceptedAt), batchSize,
      ...(record.waitedBehind ? { holderRunId: record.waitedBehind } : {}) });
  }
  sending(id: string, threadId: string): void {
    this.accept(id);
    const record = this.record(id);
    if (!record || terminal(record)) return;
    this.store.set(key(id), { ...record, state: "sending", threadId, attempts: record.attempts + 1, firstSendAt: record.firstSendAt ?? Date.now(),
      beforeSend: { state: record.state, attempts: record.attempts, ...(record.firstSendAt === undefined ? {} : { firstSendAt: record.firstSendAt }) } });
  }
  unsent(id: string): void {
    const record = this.record(id);
    if (!record || terminal(record) || !record.beforeSend) return;
    const { beforeSend, firstSendAt: _first, ...rest } = record;
    this.store.set(key(id), { ...rest, ...beforeSend });
  }
  ambiguous(id: string, error: unknown, durationMs: number): void {
    const record = this.record(id);
    if (!record || terminal(record) || record.firstSendAt === undefined) return;
    this.store.set(key(id), { ...record, state: "ambiguous", beforeSend: undefined });
    this.log(record, "wake.send_ambiguous", { route: "/threads/:id/send", causeKey: causeKey(errorDetail(error), "wake.send") }, durationMs);
  }
  retry(id: string, attempt: number, nextAt: number): void {
    const record = this.record(id);
    if (!record || terminal(record)) return;
    this.log(record, "wake.retry_scheduled", { attempt, nextAt });
  }
  admitted(id: string): void {
    const record = this.record(id);
    if (!record || terminal(record)) return;
    const thread = record.threadId;
    const prompt = this.store.get<{ messageId: string }>(`failed-delivery:${id}`)?.messageId;
    const runId = thread && prompt ? this.store.get<{ runId?: string }>(`send-run:${thread}:${prompt}`)?.runId : undefined;
    const next: Record = { ...record, state: "admitted", admittedAt: Date.now(), ...(runId ? { runId } : {}) };
    this.store.set(key(id), next);
    this.log(next, "wake.admitted", { elapsedMs: Math.max(0, Date.now() - record.acceptedAt) });
  }
  failed(id: string, reason: "ambiguity_deadline" | "delivery_deadline" | "stale" | "attempts_exhausted" | "route_retired"): void {
    const record = this.record(id);
    if (!record || terminal(record)) return;
    const next: Record = { ...record, state: "failed", failedAt: Date.now() };
    this.store.set(key(id), next);
    this.log(next, "wake.failed", { reason, ageMs: Math.max(0, Date.now() - record.acceptedAt), attempt: record.attempts,
      ...(record.waitedBehind ? { holderRunId: record.waitedBehind } : {}) });
  }
}
