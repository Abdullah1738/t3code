import { createHash } from "node:crypto";
import type { NormalizedInbound } from "./photon.ts";
import type { Store } from "./store.ts";
import { toolLog } from "./toollog.ts";
import { controlFailureProps } from "./control-errors.ts";
import { markSettled } from "./unanswered.ts";

export type RequeueReason = "respond_failed" | "steer_failed" | "background_no_reply" | "turn_failed" | "watchdog_overdue";
export type RequeueOutcome = "requeued" | "capped" | "skipped";
export type RequeueHumanOptions = {
  chat?: string;
  completed?: boolean;
  failure?: unknown;
  attempt?: number;
  backoffMs?: number;
  threadId?: string;
  now?: number;
};

export const MAX_NO_REPLY_REQUEUES = 2;
export const MAX_NON_FAILED_REQUEUES = 3;
export const MAX_FAILED_ATTEMPTS = 5;
export const HUMAN_FAILURE_BACKOFF_MS = [0, 5_000, 15_000, 45_000] as const;

export function leaderKind(id: string | undefined): "human" | "wake" | "reset" {
  if (id?.startsWith("reset:")) return "reset";
  return id === undefined || /^(wake:|secret:)/.test(id) ? "wake" : "human";
}

/** Preserve sealed membership and uncertain POST identity; normal dispatch owns the retry. */
export function requeueHuman(store: Store, id: string, reason: RequeueReason, options: RequeueHumanOptions = {}): RequeueOutcome {
  if (leaderKind(id) !== "human") return "skipped";
  const now = options.now ?? Date.now();
  const chat = options.chat ?? "owner";
  return store.db.transaction((): RequeueOutcome => {
    const row = store.db.query<{ state: string }, [string]>("SELECT state FROM inbound WHERE id = ?").get(id);
    if (!row || row.state === "pending" && store.get(`human-own-turn:${id}`)) return "skipped";
    const members = store.get<NormalizedInbound>(`batch:${id}`)?.batchIds ?? [id];
    if (members.every(member => store.db.query("SELECT 1 FROM inbound WHERE id = ? AND json_type(payload, '$.answeredAt') = 'integer'").get(member))) {
      for (const member of members) store.updateInbound(member, "done");
      toolLog.capture(() => toolLog.write({ component: "router", kind: "event", name: "turn.retry_skipped",
        ids: { inboundId: id, chat }, props: { reason: "reply_already_sent" } }));
      return "skipped";
    }
    if (members.every(member => store.db.query("SELECT 1 FROM inbound WHERE id = ? AND json_type(payload, '$.settledAt') = 'integer'").get(member))) {
      for (const member of members) store.updateInbound(member, "done");
      return "skipped";
    }
    // #111 hard cap applies strictly to non-turn_failed requeues; #130 owns turn_failed bounds and visible failure.
    let nonFailedAttempt: number | undefined;
    if (reason !== "turn_failed") {
      const noReplyCount = store.get<number>(`human-noreply-requeues:${id}`) ?? 0;
      const nonFailedCount = store.get<number>(`human-nonfailed-requeues:${id}`) ?? 0;
      const hitNoReplyCap = reason === "background_no_reply" && noReplyCount >= MAX_NO_REPLY_REQUEUES;
      const hitNonFailedCap = nonFailedCount >= MAX_NON_FAILED_REQUEUES;
      if (hitNoReplyCap || hitNonFailedCap) {
        const count = hitNoReplyCap ? noReplyCount : nonFailedCount;
        toolLog.capture(() => toolLog.write({
          component: "router",
          kind: "event",
          name: "inbound.requeue_capped",
          ids: { inboundId: id, chat, ...(options.threadId ? { threadId: options.threadId } : {}) },
          props: { reason, count },
        }));
        if (reason === "background_no_reply") {
          markSettled(store, members, "agent_no_reply", { now, threadId: options.threadId });
        } else {
          store.set(`human-own-turn:${id}`, false);
          store.set(`human-backoff-until:${id}`, null);
          store.set(`steer-attempt:${id}`, null);
          for (const member of members) store.updateInbound(member, "failed");
        }
        return "capped";
      }
      nonFailedAttempt = nonFailedCount + 1;
      if (reason === "background_no_reply") store.set(`human-noreply-requeues:${id}`, noReplyCount + 1);
      store.set(`human-nonfailed-requeues:${id}`, nonFailedAttempt);
    }
    if (options.completed) {
      // A completed run's idempotency receipt cannot start the unanswered work again.
      const count = (store.get<number>(`human-retries:${id}`) ?? 0) + 1;
      store.set(`human-retries:${id}`, count);
      store.set(`human-retry-prompt:${id}`, `msg_${createHash("sha256").update(`${id}:unanswered:${count}`).digest("hex")}`);
      store.set(`steer-attempt:${id}`, null);
      store.set(`latency-route:${id}`, null);
      store.set(`failed-delivery:${id}`, null);
      store.set(`steer-reconciled:${id}`, false);
    }
    for (const member of members) {
      store.updateInbound(member, member === id ? "pending" : "batched");
      store.db.query("DELETE FROM kv WHERE key = ?").run(`inbound-delivered:${member}`);
    }
    store.set(`human-response-prompt:${id}`, null);
    store.set(`human-response-before:${id}`, null);
    store.set(`human-own-turn:${id}`, true);
    store.set(`batch-phase:${id}`, "queued-steer");
    store.set(`human-backoff-until:${id}`, options.backoffMs && options.backoffMs > 0 ? now + options.backoffMs : null);
    toolLog.capture(() => toolLog.write({
      component: "router",
      kind: "event",
      name: "inbound.requeued",
      ids: { inboundId: id, chat, ...(options.threadId ? { threadId: options.threadId } : {}) },
      props: {
        reason,
        ...((options.attempt ?? nonFailedAttempt) !== undefined ? { attempt: options.attempt ?? nonFailedAttempt } : {}),
        ...(options.backoffMs !== undefined ? { backoffMs: options.backoffMs } : {}),
        ...controlFailureProps(options.failure),
      },
    }));
    return "requeued";
  }).immediate();
}
