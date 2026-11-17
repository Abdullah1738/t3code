import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type RunAttemptId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EventSink from "./EventSink.ts";
import { providerStartAccepted } from "./providerStartDeadlinePolicy.ts";
import * as ProviderStartProgress from "../ardud/orchestration/ProviderStartProgress.ts";

export class RunStartDeadline extends Context.Service<
  RunStartDeadline,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly check: () => Effect.Effect<void>;
    readonly recover: () => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/RunStartDeadline") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const progress = yield* Effect.serviceOption(ProviderStartProgress.ProviderStartProgress);
  const pending = new Map<OrchestrationV2Run["id"], OrchestrationV2Run>();
  let bootstrapping = false;
  const bootstrapTouched = new Set<OrchestrationV2Run["id"]>();
  const bootstrapAccepted = new Set<RunAttemptId>();
  // Domain events are already traced at their persistence boundary.
  const handle = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
    if (Option.isSome(progress)) yield* progress.value.handle(event);
    yield* Effect.sync(() => {
      if (event.type === "run.created" || event.type === "run.updated") {
        const run = event.payload;
        if (bootstrapping) bootstrapTouched.add(run.id);
        if (
          run.providerStartDeadlineAt !== undefined &&
          (run.status === "starting" ||
            (run.status === "running" &&
              (pending.has(run.id) ||
                // Admission can predate the subscriber. Local registration
                // during bootstrap still needs a bound until native acceptance.
                (bootstrapping &&
                  run.activeAttemptId !== null &&
                  !bootstrapAccepted.has(run.activeAttemptId)))))
        ) {
          pending.set(run.id, run);
        } else pending.delete(run.id);
      } else if (
        event.type === "provider-turn.updated" &&
        event.payload.promptAcceptedAt !== undefined
      ) {
        if (bootstrapping && event.payload.runAttemptId !== null)
          bootstrapAccepted.add(event.payload.runAttemptId);
        for (const [id, run] of pending) {
          if (
            providerStartAccepted(run, [event.payload], []) &&
            run.providerRestartCleanup?.completed !== false
          )
            pending.delete(id);
        }
      }
    });
  });
  const check = Effect.fn("RunStartDeadline.check")(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    for (const [id, run] of pending) {
      const deadline = run.providerStartDeadlineAt;
      if (deadline === undefined || now < DateTime.toEpochMillis(deadline)) continue;
      if (run.providerRestartCleanup?.completed !== false) {
        // Output may arrive without a prompt acknowledgement. Use the same
        // persisted evidence as recovery before attempting to expire the run.
        const records = yield* engine
          .getThreadRecords(run.threadId, ["providerTurns", "turnItems"], {
            turnItemRunIds: [run.id],
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Provider start deadline could not read acceptance", {
                runId: id,
                cause,
              }).pipe(Effect.as(null)),
            ),
          );
        if (records === null) continue;
        if (providerStartAccepted(run, records.providerTurns, records.turnItems)) {
          if (pending.get(id) === run) pending.delete(id);
          continue;
        }
      }
      const observed = Option.isSome(progress) ? progress.value.get(id, run.activeAttemptId) : null;
      yield* engine
        .dispatch({
          type: "run.start-expire",
          phase: run.providerRestartCleanup?.completed === false ? "restart_cleanup" : "provider",
          commandId: CommandId.make(
            `run-start-expire:${id}:${run.activeAttemptId}:${DateTime.toEpochMillis(deadline)}`,
          ),
          threadId: run.threadId,
          runId: id,
          expectedAttemptId: run.activeAttemptId,
          deadline,
          ...(observed?.nativeAcceptedAt == null
            ? {}
            : {
                nativeEvidence: {
                  runId: id,
                  attemptId: observed.attemptId,
                  nativeSessionId: observed.nativeSessionId,
                  acceptedAt: DateTime.makeUnsafe(observed.nativeAcceptedAt),
                },
              }),
        })
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (pending.get(id) === run) pending.delete(id);
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Provider start deadline could not settle run", { runId: id, cause }),
          ),
        );
    }
  });
  const recover = Effect.fn("RunStartDeadline.recover")(function* () {
    bootstrapping = true;
    yield* Effect.gen(function* () {
      // Recovery may have re-driven a run before this subscriber attached.
      const shell = yield* engine.getShellSnapshot();
      for (const thread of shell.threads) {
        if (thread.activeRunId === null) continue;
        const { runs } = yield* engine.getThreadRecords(thread.id, ["runs"], {
          runIds: [thread.activeRunId],
        });
        const run = runs[0];
        if (run?.providerStartDeadlineAt === undefined) continue;
        const records = yield* engine.getThreadRecords(thread.id, ["providerTurns", "turnItems"], {
          turnItemRunIds: [run.id],
        });
        if (
          !bootstrapTouched.has(run.id) &&
          (run.activeAttemptId === null || !bootstrapAccepted.has(run.activeAttemptId)) &&
          !pending.has(run.id) &&
          run?.providerStartDeadlineAt !== undefined &&
          (run.providerRestartCleanup?.completed === false ||
            !providerStartAccepted(run, records.providerTurns, records.turnItems))
        )
          pending.set(run.id, run);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Provider start deadline recovery failed", { cause }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          bootstrapping = false;
          bootstrapTouched.clear();
          bootstrapAccepted.clear();
        }),
      ),
    );
  });
  const start = Effect.fn("RunStartDeadline.start")(function* () {
    // Recovery and live attachment may race; replay every admission committed
    // after this cursor, including those recovery reads before they are armed.
    const afterSequence = yield* eventSink.latestSequence().pipe(Effect.orDie);
    yield* forkParked(
      eventSink.stream({ afterSequence }).pipe(Stream.runForEach((stored) => handle(stored.event))),
    );
    yield* forkParked(recover());
    yield* forkParked(Effect.forever(Effect.sleep("1 second").pipe(Effect.andThen(check))));
  });
  return RunStartDeadline.of({ start, handle, check, recover });
});
export const layer = Layer.effect(RunStartDeadline, make);
