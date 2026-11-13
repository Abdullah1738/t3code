import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

// Timeout waits must not join an uninterruptible database transaction during cleanup.
export const awaitInterruptibly = Effect.fn("McpDeadline.awaitInterruptibly")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const pending = yield* Effect.forkDetach(effect);
  return yield* Fiber.join(pending).pipe(
    Effect.ensuring(Fiber.interrupt(pending).pipe(Effect.forkDetach, Effect.asVoid)),
  );
});

export const withDeadline = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  input: {
    readonly code: "caller_unresolved" | "delegation_timeout";
    readonly threadId: ThreadId | undefined;
    readonly stage: string;
    readonly requestKey?: string;
    readonly taskId?: string;
  },
) =>
  effect.pipe(
    awaitInterruptibly,
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () =>
        Effect.fail(
          new OrchestratorMcpFailure({
            code: input.code,
            message:
              `${input.code === "caller_unresolved" ? "Caller resolution" : "delegate_task"} timed out during ${input.stage} for thread ${input.threadId ?? "unknown"}.` +
              (input.stage === "dispatch" ? " Creation may still complete." : "") +
              (input.taskId === undefined
                ? ""
                : ` Task ${input.taskId} was accepted; use task_status to recover it.`) +
              (input.requestKey === undefined
                ? ""
                : ` Retry only with the same clientRequestId: ${input.requestKey}.`),
          }),
        ),
    }),
  );
