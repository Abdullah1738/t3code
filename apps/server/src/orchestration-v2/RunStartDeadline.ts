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
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { providerStartAccepted } from "./providerStartDeadlinePolicy.ts";

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
  const pending = new Map<OrchestrationV2Run["id"], OrchestrationV2Run>();
  let bootstrapping = false;
  const bootstrapTouched = new Set<OrchestrationV2Run["id"]>();
  const bootstrapAccepted = new Set<RunAttemptId>();
  // Domain events are already traced at their persistence boundary.
  const handle = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
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
            run.activeAttemptId === event.payload.runAttemptId &&
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
    yield* forkParked(Stream.runForEach(engine.streamDomainEvents, handle));
    yield* forkParked(recover());
    yield* forkParked(Effect.forever(Effect.sleep("1 second").pipe(Effect.andThen(check))));
  });
  return RunStartDeadline.of({ start, handle, check, recover });
});
export const layer = Layer.effect(RunStartDeadline, make);
