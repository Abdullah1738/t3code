import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { failedPhase } from "../ardud/analytics/McpCall.ts";
import { delegationCreateFailure } from "../ardud/orchestration/delegationCreateFailure.ts";
const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);

export const OPERATION_TIMEOUT = "10 seconds";
// Loaded reads exceed the write budget; leave time to reply before clients give up.
export const READ_TIMEOUT = "45 seconds";

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

type DetachedOperation = {
  readonly onTimeout: "detach";
  readonly requestKey?: string;
  readonly taskId?: string;
};

// Timeout waits must not join an uninterruptible database transaction during cleanup.
export const awaitInterruptibly = Effect.fn("McpDeadline.awaitInterruptibly")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  detached?: DetachedOperation,
) {
  if (detached === undefined) {
    const pending = yield* Effect.forkDetach(effect);
    return yield* Fiber.join(pending).pipe(
      Effect.ensuring(Fiber.interrupt(pending).pipe(Effect.forkDetach, Effect.asVoid)),
    );
  }
  let capped = false;
  const wait = yield* Effect.serviceOption(PendingWait);
  const logOutcome = Effect.fn("McpDeadline.detachedOutcome")(
    (outcome: "committed" | "failed" | "capped", cause?: Cause.Cause<E>) =>
      Effect.logInfo("MCP detached operation finished", {
        outcome,
        requestKey: detached.requestKey ?? "unknown",
        taskId: detached.taskId ?? "unknown",
        ...(cause === undefined
          ? {}
          : {
              cause: delegationCreateFailure(cause),
              ...(Option.isSome(wait) ? { wait: wait.value.wait } : {}),
            }),
        ...(outcome === "capped"
          ? { cancellationPending: true }
          : capped
            ? { afterCap: true }
            : {}),
      }),
  );
  // A create owns its lifetime after the waiter leaves, including client disconnects.
  const pending = yield* Effect.forkDetach(
    effect.pipe(
      Effect.onExit((exit) =>
        exit._tag === "Success" ? logOutcome("committed") : logOutcome("failed", exit.cause),
      ),
    ),
  );
  yield* Fiber.await(pending).pipe(
    Effect.timeoutOption("2 minutes"),
    Effect.flatMap((exit) => {
      if (Option.isSome(exit)) return Effect.void;
      capped = true;
      // A masked commit can defer cancellation; report the cap without joining it.
      return logOutcome("capped").pipe(
        Effect.andThen(Fiber.interrupt(pending).pipe(Effect.forkDetach, Effect.asVoid)),
      );
    }),
    Effect.forkDetach,
  );
  return yield* Fiber.join(pending);
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
    readonly onTimeout?: "detach";
  },
) {
  const startedAt = yield* Clock.monotonicTimeNanos;
  const outer = yield* Effect.serviceOption(PendingWait);
  // Nested caller deadlines must report the same pending read if the outer timer wins.
  const pending =
    outer._tag === "Some" ? outer.value : { wait: input.wait ?? input.stage, since: startedAt };
  return yield* effect.pipe(
    Effect.onError(() => failedPhase(input.stage)),
    (operation) =>
      awaitInterruptibly(
        operation,
        input.onTimeout === "detach" ? { ...input, onTimeout: "detach" } : undefined,
      ),
    Effect.provideService(PendingWait, pending),
    Effect.timeoutOrElse({
      duration: OPERATION_TIMEOUT,
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
              ((input.code === "caller_unresolved" && input.stage === "caller") ||
              input.stage === "parent_records" ||
              (input.code === "delegation_timeout" &&
                input.taskId === undefined &&
                input.stage !== "dispatch")
                ? " Nothing was saved; retry the same call."
                : "") +
              (input.stage === "dispatch"
                ? input.taskId === undefined
                  ? " Creation may still complete."
                  : ` Task ${input.taskId} may still be created; use task_status to check whether it was saved.`
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
    Effect.mapError((error) => {
      // Admission can fail before the timer; keyed callers still need the same retry identity.
      const retry = `Retry only with the same clientRequestId: ${input.requestKey}.`;
      return isOrchestratorMcpFailure(error) &&
        error.code === "caller_unresolved" &&
        input.requestKey !== undefined &&
        !error.message.includes(retry)
        ? new OrchestratorMcpFailure({ code: error.code, message: `${error.message} ${retry}` })
        : error;
    }),
  );
});
