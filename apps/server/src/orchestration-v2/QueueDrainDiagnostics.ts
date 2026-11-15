import type { OrchestrationV2Run } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Analytics from "../ardud/analytics/Analytics.ts";
import { recordServerAnalytics } from "../observability/RpcInstrumentation.ts";

const WINDOW_MS = 10 * 60_000;

export const make = Effect.gen(function* () {
  const analytics = yield* Effect.serviceOption(Analytics.Analytics);
  const emitted = new Map<string, number>();
  return Effect.fn("Orchestrator.queueDrainSkipped")(function* (input: {
    readonly threadId: string;
    readonly head: Pick<OrchestrationV2Run, "id" | "ordinal"> | undefined;
    readonly queuedCount: number;
    readonly heldCount?: number;
    readonly reason: string;
  }) {
    const { threadId, reason, queuedCount, head } = input;
    yield* Effect.annotateCurrentSpan({
      "orchestration.queue_drain_skipped.reason": reason,
      "orchestration.queue_drain_skipped.thread_id": threadId,
      "orchestration.queue_drain_skipped.head_run_id": head?.id ?? "none",
      "orchestration.queue_drain_skipped.head_ordinal": head?.ordinal ?? 0,
      "orchestration.queue_drain_skipped.queued_count": queuedCount,
      "orchestration.queue_drain_skipped.held_count": input.heldCount ?? 0,
    });
    const now = yield* Clock.currentTimeMillis;
    const key = `${threadId}\n${reason}`;
    const previous = emitted.get(key);
    if (previous !== undefined && now - previous < WINDOW_MS) return;
    for (const [entry, at] of emitted) {
      if (now - at < WINDOW_MS) break;
      emitted.delete(entry);
    }
    emitted.set(key, now);
    const props = {
      reason,
      queuedCount,
      ...(input.heldCount === undefined ? {} : { heldCount: input.heldCount }),
      ...(head === undefined ? {} : { headRunId: head.id, headOrdinal: head.ordinal }),
    };
    yield* Effect.logInfo("orchestration.queue_drain_skipped", { threadId, ...props });
    if (Option.isSome(analytics)) {
      yield* recordServerAnalytics(analytics.value, {
        ts: DateTime.formatIso(DateTime.makeUnsafe(now)),
        surface: "server",
        route: "orchestration",
        kind: "orchestration.queue_drain_skipped",
        threadId,
        props,
      });
    }
  });
});
