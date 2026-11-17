import { createHash } from "node:crypto";
import type { NormalizedInbound } from "./photon.ts";
import type { Store } from "./store.ts";
import { toolLog } from "./toollog.ts";
import { controlFailureProps } from "./control-errors.ts";

export type RequeueReason = "respond_failed" | "steer_failed" | "background_no_reply" | "turn_failed" | "watchdog_overdue";

export function leaderKind(id: string | undefined): "human" | "wake" | "reset" {
  if (id?.startsWith("reset:")) return "reset";
  return id === undefined || /^(wake:|secret:)/.test(id) ? "wake" : "human";
}

/** Preserve sealed membership and uncertain POST identity; normal dispatch owns the retry. */
export function requeueHuman(store: Store, id: string, reason: RequeueReason, options: { chat?: string; completed?: boolean; failure?: unknown } = {}): void {
  if (leaderKind(id) !== "human") return;
  store.db.transaction(() => {
    const row = store.db.query<{ state: string }, [string]>("SELECT state FROM inbound WHERE id = ?").get(id);
    if (!row || row.state === "pending" && store.get(`human-own-turn:${id}`)) return;
    const members = store.get<NormalizedInbound>(`batch:${id}`)?.batchIds ?? [id];
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
    toolLog.capture(() => toolLog.write({ component: "router", kind: "event", name: "inbound.requeued",
      ids: { inboundId: id, chat: options.chat ?? "owner" }, props: { reason, ...controlFailureProps(options.failure) } }));
  }).immediate();
}
