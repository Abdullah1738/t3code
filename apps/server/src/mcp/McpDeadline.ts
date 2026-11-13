import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { failedPhase } from "../ardud/analytics/McpCall.ts";

class PendingWait extends Context.Service<PendingWait, { wait: string; since: bigint }>()(
  "t3/mcp/McpDeadline/PendingWait",
) {}

// The enclosing deadline owns the span; this only identifies its pending I/O.
export const waitingOn = Effect.fnUntraced(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  wait: string,
) {
  const pending = yield* Effect.serviceOption(PendingWait);
  if (pending._tag === "Some") {
    pending.value.wait = wait;
    pending.value.since = yield* Clock.monotonicTimeNanos;
  }
  return yield* effect;
});

// Timeout waits must not join an uninterruptible database transaction during cleanup.
export const awaitInterruptibly = Effect.fn("McpDeadline.awaitInterruptibly")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const pending = yield* Effect.forkDetach(effect);
  return yield* Fiber.join(pending).pipe(
    Effect.ensuring(Fiber.interrupt(pending).pipe(Effect.forkDetach, Effect.asVoid)),
  );
});

// awaitInterruptibly owns the tracing boundary for every bounded operation.
export const withDeadline = Effect.fnUntraced(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  input: {
    readonly code: "caller_unresolved" | "delegation_timeout";
    readonly threadId: ThreadId | undefined;
    readonly stage: string;
    readonly wait?: string;
    readonly requestKey?: string;
    readonly taskId?: string;
  },
) {
  const startedAt = yield* Clock.monotonicTimeNanos;
  const outer = yield* Effect.serviceOption(PendingWait);
  // Nested caller deadlines must report the same pending read if the outer timer wins.
  const pending =
    outer._tag === "Some" ? outer.value : { wait: input.wait ?? input.stage, since: startedAt };
  return yield* effect.pipe(
    Effect.onError(() => failedPhase(input.stage)),
    Effect.provideService(PendingWait, pending),
    awaitInterruptibly,
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: Effect.fn("McpDeadline.expired")(function* () {
        yield* failedPhase(input.stage);
        const now = yield* Clock.monotonicTimeNanos;
        yield* Effect.logWarning("MCP operation timed out", {
          code: input.code,
          stage: input.stage,
          threadId: input.threadId ?? "unknown",
          threadKind: input.threadId?.startsWith("thread:delegated-task:")
            ? "delegated-task"
            : input.threadId === undefined
              ? "client"
              : "thread",
          elapsedMs: Number(now - startedAt) / 1_000_000,
          wait: pending.wait,
          waitElapsedMs: Number(now - pending.since) / 1_000_000,
          ...(input.requestKey === undefined ? {} : { requestKey: input.requestKey }),
          ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        });
        return yield* Effect.fail(
          new OrchestratorMcpFailure({
            code: input.code,
            message:
              `${input.code === "caller_unresolved" ? "Caller resolution" : "delegate_task"} timed out during ${input.stage} for thread ${input.threadId ?? "unknown"}.` +
              (input.code === "caller_unresolved" && input.stage === "caller"
                ? " Nothing was saved; retry the same call."
                : "") +
              (input.stage === "dispatch"
                ? input.taskId === undefined
                  ? " Creation may still complete."
                  : ` Task ${input.taskId} may still be created; check it with task_status.`
                : input.taskId === undefined
                  ? ""
                  : ` Task ${input.taskId} was accepted; use task_status to recover it.`) +
              (input.requestKey === undefined
                ? ""
                : ` Retry only with the same clientRequestId: ${input.requestKey}.`),
          }),
        );
      }),
    }),
  );
});
