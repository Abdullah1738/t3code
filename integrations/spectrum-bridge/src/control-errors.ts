export const CONTROL_REASONS = ["no_steerable_turn", "request_resolved", "thread_archived", "attempt_changed", "run_not_interruptible", "run_not_found", "command_id_conflict", "command_rejected", "operation_conflict", "startup_unavailable", "send_timeout", "reader_unavailable"] as const;

export type ControlFailure = { reason?: string; retrySafe?: boolean; holder?: { runId?: string | null; state?: string } | null };

export function controlDisposition(error: unknown): "refused" | "same_mode" | "reconcile" | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) return;
  const { status, reason, retrySafe } = error as ControlFailure & { status: unknown };
  if (status === 409 && (!reason || reason === "no_steerable_turn" || reason === "request_resolved")) return "refused";
  if (status === 503 && retrySafe === true && (reason === "startup_unavailable" || reason === "send_timeout")) return "same_mode";
  if (status === 0 || status === 500 || typeof status === "number" && status >= 200 && status < 300
    || status === 409 || reason === "reader_unavailable") return "reconcile";
}

/** Only protocol tags and run identity survive; response messages remain private. */
export function controlFailureProps(error: unknown): Record<string, string | boolean> {
  if (!error || typeof error !== "object") return {};
  const { reason, retrySafe, holder } = error as ControlFailure;
  return {
    ...(CONTROL_REASONS.includes(reason as typeof CONTROL_REASONS[number]) ? { controlReason: reason! } : {}),
    ...(typeof retrySafe === "boolean" ? { retrySafe } : {}),
    ...(typeof holder?.runId === "string" ? { holderRunId: holder.runId } : {}),
  };
}
