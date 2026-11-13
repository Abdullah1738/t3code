import type { AnalyticsEvent, KanbanActor, KanbanCard } from "@t3tools/contracts";

type Event = Omit<AnalyticsEvent, "ts" | "surface" | "route">;
export const label = (value: string) =>
  /^[a-zA-Z0-9_.:/#@%+\-]{1,160}$/.test(value) ? value : "other";
export const elapsed = (at: string, since: string) => {
  const value = Date.parse(at) - Date.parse(since);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
};

export function reasonClass(text: string, category?: string): string {
  if (/variant unavailable/i.test(text)) return "variant_unavailable";
  if (/provider blocked|content.filter|flagged.*cybersecurity/i.test(text))
    return "provider_blocked";
  if (/reviewer.*verdict/i.test(text)) return "no_verdict";
  if (/interrupt|stopped|cancel/i.test(text)) return "interrupted";
  if (/context|prompt is too long|too many tokens/i.test(text)) return "context_exhausted";
  if (/quota|usage.limit|rate.limit|overloaded/i.test(text)) return "provider_capacity";
  if (/auth|token.*expired/i.test(text)) return "authentication";
  if (/model.*unavailable|model.*refused|model.*version|no.route/i.test(text))
    return "model_unavailable";
  if (/timeout|timed out/i.test(text)) return "timeout";
  if (/thread start failed/i.test(text)) return "thread_start";
  if (/run failed/i.test(text)) return "run_failed";
  switch (category) {
    case "content_filter":
      return "provider_blocked";
    case "model_invalid":
      return "model_unavailable";
    case "context_exhausted":
      return "context_exhausted";
    case "auth_expired":
      return "authentication";
    case "quota":
    case "transient":
      return "provider_capacity";
    case "config":
      return "configuration";
    default:
      return "other";
  }
}

// Compare committed card snapshots so every entry point and reverse transition is covered.
export function cardEvents(
  before: KanbanCard | null,
  after: KanbanCard,
  actor: KanbanActor,
): Event[] {
  if (before === null) return [];
  const common = { boardId: after.boardId, cardId: after.id };
  const events: Event[] = [];
  if (before.stage !== after.stage || before.movedAt !== after.movedAt)
    events.push({
      ...common,
      kind: "kanban.card_move",
      props: {
        number: after.number,
        from: before.stage,
        to: after.stage,
        actor: actor._tag,
        msInPrevStage: elapsed(
          after.analyticsStageEnteredAt ?? after.updatedAt,
          before.analyticsStageEnteredAt ?? before.movedAt,
        ),
      },
    });
  if (
    before.stalled?.at !== after.stalled?.at ||
    before.stalled?.reason !== after.stalled?.reason
  ) {
    if (before.stalled)
      events.push({
        ...common,
        kind: "kanban.stall",
        props: {
          action: "clear",
          reasonClass: reasonClass(before.stalled.reason),
          ageMs: elapsed(after.updatedAt, before.stalled.at),
        },
      });
    if (after.stalled)
      events.push({
        ...common,
        kind: "kanban.stall",
        props: { action: "set", reasonClass: reasonClass(after.stalled.reason), ageMs: 0 },
      });
  }
  if (
    after.stage === "working" &&
    after.activeThreadId !== null &&
    before.workThreadId !== null &&
    (before.activeThreadId !== after.activeThreadId || before.stage !== "working")
  )
    events.push({
      ...common,
      kind: "kanban.worker_restarted",
      threadId: after.activeThreadId,
      props: {
        poolKey: after.activePool ?? "unknown",
        model: label(after.model.model),
        phase: before.workThreadId === after.workThreadId ? "resume" : "fresh",
      },
    });
  const oldAsks = new Map(before.asks.map((ask) => [ask.id, ask]));
  for (const ask of after.asks) {
    const old = oldAsks.get(ask.id);
    const props = {
      key: label(ask.id),
      kind: label(ask.kind ?? "question"),
      blocking: ask.blocking,
      createdAt: ask.at,
    };
    if (ask.closedAt === null && (!old || old.closedAt !== null))
      events.push({ ...common, kind: "kanban.ask_opened", props });
    if (
      ask.closedAt === null &&
      old?.closedAt === null &&
      (old.kind !== ask.kind || old.blocking !== ask.blocking)
    )
      events.push({ ...common, kind: "kanban.ask_updated", props });
    if (ask.closedAt !== null && old?.closedAt === null)
      events.push({
        ...common,
        kind: "kanban.ask_closed",
        durationMs: elapsed(ask.closedAt, ask.at),
        props: { ...props, phase: ask.answer === undefined ? "dropped" : "answered" },
      });
  }
  return events;
}
