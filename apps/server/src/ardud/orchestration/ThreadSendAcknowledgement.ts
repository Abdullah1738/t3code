import {
  type CommandId,
  type MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadSendResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

interface Lease {
  readonly requestId: string;
  readonly check: () => boolean;
  readonly accept: (result: OrchestratorMcpThreadSendResult) => void;
  readonly waitingOn: (wait: string) => () => void;
}

const lease = Context.Reference<Lease | undefined>("ardud/ThreadSendAcknowledgement/lease", {
  defaultValue: () => undefined,
});

// The send deadline owns the span; these labels identify its pending operation.
export const waitingOn = Effect.fnUntraced(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  wait: string,
) {
  const restore = (yield* lease)?.waitingOn(wait);
  return yield* effect.pipe(Effect.ensuring(Effect.sync(() => restore?.())));
});

interface Command {
  readonly id: CommandId;
  readonly check: () => boolean;
  readonly captureRuns: (runs: ReadonlyArray<OrchestrationV2Run>) => void;
  readonly result: (
    events: ReadonlyArray<OrchestrationV2StoredEvent>,
  ) => OrchestratorMcpThreadSendResult | undefined;
  readonly accept: (result: OrchestratorMcpThreadSendResult) => void;
}

export const command = Context.Reference<Command | undefined>(
  "ardud/ThreadSendAcknowledgement/command",
  { defaultValue: () => undefined },
);

export const check = Effect.fn("ThreadSendAcknowledgement.check")(function* (id: CommandId) {
  const observer = yield* command;
  if (observer?.id === id && !observer.check()) return yield* Effect.interrupt;
});

export const replay = Effect.fn("ThreadSendAcknowledgement.replay")(function* (
  id: CommandId,
  events: ReadonlyArray<OrchestrationV2StoredEvent>,
) {
  const observer = yield* command;
  if (observer?.id !== id) return;
  const result = observer.result(events);
  if (result !== undefined) observer.accept(result);
});

export const captureRuns = Effect.fn("ThreadSendAcknowledgement.captureRuns")(function* (
  id: CommandId,
  runs: ReadonlyArray<OrchestrationV2Run>,
) {
  const observer = yield* command;
  if (observer?.id === id) observer.captureRuns(runs);
});

export const observe = Effect.fn("ThreadSendAcknowledgement.observe")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  input: {
    readonly commandId: CommandId;
    readonly messageId: MessageId;
    readonly mode: string;
  },
) {
  const pending = yield* lease;
  if (pending === undefined) return yield* effect;
  let runs: ReadonlyArray<OrchestrationV2Run> = [];
  return yield* effect.pipe(
    Effect.provideService(command, {
      id: input.commandId,
      check: pending.check,
      captureRuns: (snapshot) => {
        runs = snapshot;
      },
      accept: pending.accept,
      result: (events) => {
        const message = events.findLast(
          ({ event }) => event.type === "message.updated" && event.payload.id === input.messageId,
        )?.event;
        if (message?.type !== "message.updated" || message.payload.runId === null) return;
        const runId = message.payload.runId;
        const updated = events.findLast(
          ({ event }) =>
            (event.type === "run.created" || event.type === "run.updated") &&
            event.payload.id === runId,
        )?.event;
        // Steers append input to the existing run without emitting another run event.
        const run =
          updated?.type === "run.created" || updated?.type === "run.updated"
            ? updated.payload
            : runs.find((candidate) => candidate.id === runId);
        if (run === undefined) return;
        const item = events.findLast(
          ({ event }) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "user_message" &&
            event.payload.messageId === input.messageId,
        )?.event;
        const intent =
          item?.type === "turn-item.updated" && item.payload.type === "user_message"
            ? item.payload.inputIntent
            : undefined;
        return {
          threadId: message.threadId,
          messageId: input.messageId,
          runId,
          ...(run.delegatedTaskId === undefined ? {} : { taskId: run.delegatedTaskId }),
          status: run.status,
          delivery:
            intent === undefined || intent === "queued_turn"
              ? "queued"
              : intent === "turn_start"
                ? "started"
                : input.mode === "restart"
                  ? "restarted"
                  : "steered",
        };
      },
    }),
  );
});

export const bounded = Effect.fn("ThreadSendAcknowledgement.bounded")(function* <E, R>(
  effect: (requestId: string) => Effect.Effect<OrchestratorMcpThreadSendResult, E, R>,
  serviceScope: Scope.Scope,
  clientRequestId?: string,
) {
  const current = yield* lease;
  if (current !== undefined) return yield* effect(current.requestId);
  const clock = yield* Clock.Clock;
  const started = clock.monotonicTimeNanosUnsafe();
  const crypto = yield* Crypto.Crypto;
  const requestId = clientRequestId ?? (yield* crypto.randomUUIDv4().pipe(Effect.orDie));
  const reply = yield* Deferred.make<OrchestratorMcpThreadSendResult, E | OrchestratorMcpFailure>();
  let wait = "send preflight";
  const timeout = () =>
    new OrchestratorMcpFailure({
      code: "send_timeout",
      message: `Thread send timed out waiting for ${wait}. This attempt did not save a new message. Retry with the same clientRequestId: ${requestId}. An earlier attempt with that id may already have been saved.`,
    });
  let state: "pending" | "accepted" | "expired" | "finished" = "pending";
  const pending: Lease = {
    requestId,
    waitingOn: (next) => {
      const previous = wait;
      wait = next;
      return () => {
        // Keep the expired operation if its absolute fence wins before the timer runs.
        if (clock.monotonicTimeNanosUnsafe() - started < 15_000_000_000n) wait = previous;
      };
    },
    check: () =>
      state === "pending" && clock.monotonicTimeNanosUnsafe() - started < 15_000_000_000n,
    accept: (result) => {
      if (state !== "pending") return;
      state = "accepted";
      // This is the committed route. Provider acceptance (including a priority-next
      // Claude steer waiting for a tool boundary) must never hold the MCP reply.
      Deferred.doneUnsafe(reply, Effect.succeed(result));
    },
  };
  const worker = effect(requestId).pipe(
    // Access checks and dispatch both read before COMMIT. Background sweeps must
    // not consume the send's entire commit lease while these reads wait for a slot.
    NodeSqliteClient.foregroundReads,
    Effect.provideService(lease, pending),
    Effect.onExit((exit) =>
      state === "accepted" && exit._tag === "Failure"
        ? Effect.logWarning("Thread send post-commit completion failed")
        : Effect.sync(() => {
            if (state !== "pending") return;
            // The absolute fence can expire before the timer gets scheduled.
            if (clock.monotonicTimeNanosUnsafe() - started >= 15_000_000_000n) {
              state = "expired";
              Deferred.doneUnsafe(reply, Effect.fail(timeout()));
              return;
            }
            state = "finished";
            Deferred.doneUnsafe(
              reply,
              exit._tag === "Success" ? Effect.succeed(exit.value) : Effect.failCause(exit.cause),
            );
          }),
    ),
    Effect.ignoreCause,
    Effect.forkIn(serviceScope, { uninterruptible: false }),
  );
  const abandon = (worker: Fiber.Fiber<void>) =>
    Effect.suspend(() => {
      if (state !== "pending") return Effect.void;
      state = "expired";
      // SQLite cleanup may be masked; the expired lease fences its eventual COMMIT.
      return Fiber.interrupt(worker).pipe(Effect.forkIn(serviceScope), Effect.asVoid);
    });
  // Acquisition and cleanup registration must be atomic: a caller can be
  // interrupted at the scheduler boundary immediately after forkIn returns.
  return yield* Effect.acquireUseRelease(
    worker,
    (worker) =>
      Deferred.await(reply).pipe(
        Effect.timeoutOrElse({
          duration: Duration.nanos(15_000_000_000n - (clock.monotonicTimeNanosUnsafe() - started)),
          orElse: () =>
            Effect.suspend(() => {
              if (state === "accepted" || state === "finished") return Deferred.await(reply);
              const error = timeout();
              return abandon(worker).pipe(Effect.andThen(Effect.fail(error)));
            }),
        }),
      ),
    abandon,
  );
});
