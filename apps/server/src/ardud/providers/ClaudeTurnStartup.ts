import type { ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";
import {
  ClaudeTurnPreparationTimeoutError,
  isClaudeTurnPreparationTimeoutError,
} from "@t3tools/provider-core/server/failure";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Analytics from "../analytics/Analytics.ts";

type PreparationStage = ClaudeTurnPreparationTimeoutError["stage"];
type Stage = PreparationStage | "admission" | "sdk_accept";

export interface StartupAttempt {
  readonly stage: <A, E, R>(name: Stage, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly seal: Effect.Effect<void>;
}

// The adapter owns the control lock; delivery runs only after that lock is released.
export const prepare = Effect.fn("ClaudeTurnStartup.prepare")(function* <E, R, E2, R2>(
  input: Pick<ProviderAdapterV2TurnInput, "threadId" | "runId" | "attemptId">,
  retrySafe: boolean,
  operation: (attempt: StartupAttempt) => Effect.Effect<Effect.Effect<void, E2, R2> | void, E, R>,
  withLock: <A, E3, R3>(effect: Effect.Effect<A, E3, R3>) => Effect.Effect<A, E3, R3>,
  beforeDelivery: Effect.Effect<void> = Effect.void,
) {
  const analytics = yield* Effect.serviceOption(Analytics.Analytics);
  for (let retryCount = 0; ; retryCount++) {
    const started = yield* Clock.currentTimeMillis;
    let stage: Stage = "turn_preparation";
    let preparationStage: PreparationStage = "turn_preparation";
    let sealed = !retrySafe;
    const durations: Partial<Record<Stage, number>> = {};
    let activeMeasurement: { readonly stage: Stage; childMs: number } | undefined;
    // These observations are inside the enclosing start span, including interrupted stages.
    const measure = Effect.fnUntraced(function* <A, E3, R3>(
      name: Stage,
      effect: Effect.Effect<A, E3, R3>,
    ) {
      stage = name;
      if (name !== "admission" && name !== "sdk_accept") preparationStage = name;
      const began = yield* Clock.currentTimeMillis;
      const parent = activeMeasurement;
      const measurement = { stage: name, childMs: 0 };
      activeMeasurement = measurement;
      return yield* effect.pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const elapsed = Math.max(0, (yield* Clock.currentTimeMillis) - began);
            durations[name] = (durations[name] ?? 0) + Math.max(0, elapsed - measurement.childMs);
            if (parent !== undefined) parent.childMs += elapsed;
            activeMeasurement = parent;
            // Preserve the deepest failed stage while unwinding the timeout.
            if (Exit.isSuccess(exit)) {
              stage = parent?.stage ?? name;
              if (stage !== "admission" && stage !== "sdk_accept") preparationStage = stage;
            }
          }),
        ),
      );
    });
    const record = Effect.fnUntraced(function* (
      outcome: "success" | "timeout" | "error" | "interrupted",
    ) {
      const ended = yield* Clock.currentTimeMillis;
      const props = {
        runId: input.runId,
        attemptId: input.attemptId,
        provider: "claudeAgent",
        stage,
        outcome,
        retryCount,
        discoveryMs: durations.skill_discovery ?? null,
        attachmentsMs: durations.attachments ?? null,
        sdkOpenMs: durations.sdk_open ?? null,
        mcpRegistrationMs: durations.mcp_registration ?? null,
        sdkAcceptMs: durations.sdk_accept ?? null,
      };
      yield* Effect.logInfo("orchestration-v2.claude-turn-start-attempt", {
        threadId: input.threadId,
        ...props,
      });
      if (Option.isSome(analytics))
        yield* analytics.value.record({
          ts: DateTime.formatIso(DateTime.makeUnsafe(ended)),
          kind: "provider.turn-start-attempt",
          surface: "server",
          route: "claude-start",
          threadId: input.threadId,
          durationMs: Math.max(0, ended - started),
          props,
        });
    });
    const result = yield* operation({
      stage: measure,
      seal: Effect.sync(() => {
        sealed = true;
        stage = "admission";
      }),
    }).pipe(
      // Retain the existing budget: the sighting was unbounded discovery, not a normal cold start.
      Effect.timeout("15 seconds"),
      Effect.mapError((cause) =>
        Cause.isTimeoutError(cause) && !sealed
          ? new ClaudeTurnPreparationTimeoutError({ stage: preparationStage, cause })
          : cause,
      ),
      withLock,
      Effect.onExit((exit) =>
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
          ? record("interrupted")
          : Effect.void,
      ),
      Effect.exit,
    );
    if (Exit.isFailure(result)) {
      const timeout = isClaudeTurnPreparationTimeoutError(Cause.squash(result.cause));
      if (!Cause.hasInterruptsOnly(result.cause)) yield* record(timeout ? "timeout" : "error");
      if (timeout && retryCount === 0) {
        // Semaphore release schedules waiters; let a queued Stop acquire before retrying.
        yield* Effect.yieldNow;
        continue;
      }
      return yield* Effect.failCause(result.cause);
    }
    // Prompt delivery is deliberately outside both the deadline and the retry loop.
    return measure(
      "sdk_accept",
      beforeDelivery.pipe(Effect.andThen(result.value ?? Effect.void)),
    ).pipe(
      Effect.onExit((exit) =>
        record(
          Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupted"
              : "error",
        ),
      ),
    );
  }
});
