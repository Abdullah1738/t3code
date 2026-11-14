import type { AnalyticsEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type { ChildProcessSpawner } from "effect/process";

import * as Analytics from "../ardud/analytics/Analytics.ts";
import { recordServerAnalytics, safeAnalyticsLabel } from "../observability/RpcInstrumentation.ts";

export const job = Context.Reference<
  | {
      readonly operation: string;
      readonly provider?: string | undefined;
      readonly boardId?: string | undefined;
    }
  | undefined
>("TextGenerationAnalytics.job", { defaultValue: () => undefined });

// Metadata observers share the generation span and never alter its result.
const record = Effect.fnUntraced(function* (event: AnalyticsEvent) {
  const analytics = yield* Effect.serviceOption(Analytics.Analytics);
  if (Option.isSome(analytics)) yield* recordServerAnalytics(analytics.value, event);
});

export const observeOperation = Effect.fn("TextGeneration.observeOperation")(function* <A, E, R>(
  operation: string,
  provider: string,
  boardId: string | undefined,
  effect: Effect.Effect<A, E, R>,
) {
  const start = yield* Clock.currentTimeMillis;
  return yield* effect.pipe(
    Effect.provideService(job, { operation, provider, boardId }),
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        const end = yield* Clock.currentTimeMillis;
        yield* record({
          ts: DateTime.formatIso(DateTime.makeUnsafe(start)),
          kind: "text-generation.operation",
          surface: "server",
          route: "text-generation",
          ...(boardId ? { boardId } : {}),
          durationMs: Math.max(0, end - start),
          outcome: Exit.isSuccess(exit)
            ? "ok"
            : Cause.hasInterrupts(exit.cause)
              ? "interrupted"
              : "error",
          props: {
            provider: safeAnalyticsLabel(provider, "other"),
            operation: safeAnalyticsLabel(operation, "other"),
            count: 1,
          },
        });
      }),
    ),
  );
});

export const observeChild = Effect.fn("TextGeneration.observeChild")(function* (
  child: ChildProcessSpawner.ChildProcessHandle,
  provider: string,
  fallbackOperation: string,
) {
  const metadata = yield* job;
  const start = yield* Clock.currentTimeMillis;
  let exitCode: number | undefined;
  // Registered after spawn: exactly one row per actual child, even when its scope is interrupted.
  yield* Effect.addFinalizer((exit) =>
    Effect.gen(function* () {
      const end = yield* Clock.currentTimeMillis;
      yield* record({
        ts: DateTime.formatIso(DateTime.makeUnsafe(start)),
        startedAt: DateTime.formatIso(DateTime.makeUnsafe(start)),
        kind: "text-generation.child",
        surface: "server",
        route: "text-generation",
        ...(metadata?.boardId ? { boardId: metadata.boardId } : {}),
        durationMs: Math.max(0, end - start),
        outcome:
          exitCode === undefined
            ? Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
              ? "interrupted"
              : "error"
            : exitCode === 0
              ? "ok"
              : "error",
        props: {
          provider: safeAnalyticsLabel(metadata?.provider ?? provider, "other"),
          operation: safeAnalyticsLabel(metadata?.operation ?? fallbackOperation, "other"),
          phase: fallbackOperation === "mcp-list" ? "discovery" : "inference",
          count: 1,
          ...(exitCode === undefined ? {} : { exitCode }),
        },
      });
    }),
  );
  return {
    exitCode: child.exitCode.pipe(
      Effect.tap((code) =>
        Effect.sync(() => {
          exitCode = code;
        }),
      ),
    ),
  };
});
