import type { OrchestrationV2ProviderRetry, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Analytics from "./Analytics.ts";

export const makeRecorder = Effect.fn("ProviderRetry.makeRecorder")(function* () {
  const analytics = yield* Effect.serviceOption(Analytics.Analytics);
  return Effect.fn("ProviderRetry.record")(function* (input: {
    readonly kind: "provider.retry" | "provider.guard_interrupt";
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly provider: string;
    readonly model: string;
    readonly retry?: OrchestrationV2ProviderRetry;
    readonly errorMessage: string;
    readonly lastResponseAt: DateTime.Utc;
    readonly guardFiredDuringRetry?: boolean;
  }) {
    if (Option.isNone(analytics)) return;
    const now = yield* DateTime.now;
    yield* analytics.value.record({
      ts: DateTime.formatIso(now),
      kind: input.kind,
      surface: "server",
      route: "provider",
      threadId: input.threadId,
      props: {
        runId: input.runId,
        provider: input.provider.replace(/[^a-zA-Z0-9_.:/#@%+-]/g, "_").slice(0, 160),
        model: input.model.replace(/[^a-zA-Z0-9_.:/#@%+-]/g, "_").slice(0, 160),
        attempt: input.retry?.attempt ?? null,
        maxRetries: input.retry?.maxAttempts ?? null,
        errorMessage: input.errorMessage.slice(0, 2000),
        waitSinceResponseMs: Math.max(
          0,
          DateTime.toEpochMillis(now) - DateTime.toEpochMillis(input.lastResponseAt),
        ),
        ...(input.guardFiredDuringRetry === undefined
          ? {}
          : { guardFiredDuringRetry: input.guardFiredDuringRetry }),
      },
    });
  });
});
