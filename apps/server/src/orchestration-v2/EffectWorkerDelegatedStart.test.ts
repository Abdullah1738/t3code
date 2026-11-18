import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as RestartPacing from "../ardud/restart-pacing/RestartPacing.ts";
import * as RestartPacingState from "../ardud/restart-pacing/RestartPacingState.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as Outbox from "./EffectOutbox.ts";
import * as Worker from "./EffectWorker.ts";
import * as CheckpointRollback from "./CheckpointRollbackService.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControl from "./ProviderTurnControlService.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunFinalization from "./RunFinalizationService.ts";
import * as RuntimeRequest from "./RuntimeRequestService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadTitle from "./ThreadTitleRegenerationService.ts";

const start = (id: string): Outbox.PendingOrchestrationEffectV2 => ({
  id,
  commandId: CommandId.make(`command:${id}`),
  threadId: ThreadId.make(`thread:delegated-task:${id}`),
  request: { type: "provider-turn.start", runId: RunId.make(`run:${id}`) },
});

it.effect("fresh delegated starts keep the start lane while recovery holds the pacing mutex", () =>
  Effect.gen(function* () {
    const occupied = yield* Queue.unbounded<void>();
    const earlierEntered = yield* Queue.unbounded<void>();
    const releaseGeneral = yield* Deferred.make<void>();
    const releaseEarlier = yield* Deferred.make<void>();
    const readEntered = yield* Deferred.make<void>();
    const releaseRead = yield* Deferred.make<void>();
    const providers = new Set<string>();
    let blockRead = false;
    const settings = ServerSettings.layerTest({ restartPacing: { maxActive: 4, spacingMs: 0 } });
    const pacing = RestartPacing.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          settings,
          Layer.succeed(RestartPacing.RestartLoad, () => 0),
          Layer.succeed(RestartPacingState.RestartPacingState, {
            sourceForRun: () => Effect.succeed(undefined),
            describe: () => Effect.succeed({ priority: 3, activityAt: 0 }),
            pending: () => Effect.succeed(true),
            wake: () => Effect.succeed(true),
            hasSuccessor: () => Effect.succeed(false),
            status: () => Effect.succeed(true),
            active: () =>
              Effect.suspend(() =>
                blockRead
                  ? Deferred.succeed(readEntered, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseRead)),
                      Effect.as(true),
                    )
                  : Effect.succeed(true),
              ),
          }),
        ),
      ),
    );
    const outboxLayer = Outbox.layer.pipe(Layer.provide(Sqlite.layerMemory));
    const executor = Worker.layerExecutor.pipe(
      Layer.provide(
        Layer.mergeAll(
          settings,
          Layer.mock(RunFinalization.RunFinalizationService)({}),
          Layer.mock(CheckpointRollback.CheckpointRollbackServiceV2)({
            execute: () =>
              Queue.offer(occupied, undefined).pipe(Effect.andThen(Deferred.await(releaseGeneral))),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
          Layer.mock(ProviderTurnControl.ProviderTurnControlServiceV2)({}),
          Layer.mock(ProviderTurnStart.ProviderTurnStartServiceV2)({
            start: ({ runId }) =>
              Effect.gen(function* () {
                providers.add(runId);
                if (runId.startsWith("run:earlier")) {
                  yield* Queue.offer(earlierEntered, undefined);
                  yield* Deferred.await(releaseEarlier);
                }
              }),
          }),
          Layer.mock(RuntimeRequest.RuntimeRequestServiceV2)({}),
          Layer.mock(ThreadTitle.ThreadTitleRegenerationService)({}),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({}),
          Layer.mock(EventSink.EventSinkV2)({}),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
        ),
      ),
      Layer.provideMerge(Layer.merge(pacing, outboxLayer)),
    );
    yield* Effect.gen(function* () {
      const gate = yield* RestartPacing.RestartPacing;
      const outbox = yield* Outbox.EffectOutboxV2;
      const worker = yield* Worker.OrchestrationEffectWorkerV2;
      const holder = {
        threadId: ThreadId.make("recovery:holder"),
        sourceRunId: RunId.make("recovery:holder"),
      };
      assert.equal(yield* gate.acquire(holder), 0);
      yield* gate.dispatched(holder);
      yield* TestClock.adjust("10 seconds");
      blockRead = true;
      const admission = yield* gate
        .acquire({
          threadId: ThreadId.make("recovery:waiter"),
          sourceRunId: RunId.make("recovery:waiter"),
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(readEntered);
      const slow = Array.from({ length: 4 }, (_, i): Outbox.PendingOrchestrationEffectV2 => ({
        ...start(`general:${i}`),
        request: {
          type: "provider-thread.rollback",
          providerThreadId: ProviderThreadId.make(`provider:${i}`),
          checkpointId: CheckpointId.make(`checkpoint:${i}`),
          scopeId: CheckpointScopeId.make(`scope:${i}`),
        },
      }));
      yield* outbox.enqueue(slow);
      yield* Worker.runDaemonWithOptions().pipe(Effect.forkScoped);
      for (let i = 0; i < 4; i++) yield* Queue.take(occupied);
      const earlier = Array.from({ length: 10 }, (_, i) => start(`earlier:${i}`));
      yield* outbox.enqueue(earlier);
      yield* outbox.notifyAvailable(earlier.length);
      for (let i = 0; i < 10; i++) yield* Queue.take(earlierEntered);
      // Fresh delegate_task children have exactly this one pre-start effect.
      const probes = [start("probe:claude"), start("probe:codex")];
      yield* outbox.enqueue(probes);
      yield* outbox.notifyAvailable(probes.length);
      yield* Deferred.succeed(releaseEarlier, undefined);
      yield* TestClock.adjust("0 millis");
      assert.isTrue(providers.has("run:probe:claude"));
      assert.isTrue(providers.has("run:probe:codex"));
      assert.isFalse(yield* Deferred.isDone(releaseGeneral));
      assert.isFalse(yield* Deferred.isDone(releaseRead));
      yield* Deferred.succeed(releaseRead, undefined);
      yield* Fiber.join(admission);
      yield* Deferred.succeed(releaseGeneral, undefined);
      for (const effect of [...slow, ...earlier, ...probes]) yield* outbox.awaitSettled(effect.id);
      assert.equal(yield* worker.drain(), 0);
    }).pipe(
      Effect.provide(Worker.layerWithOptions().pipe(Layer.provideMerge(executor))),
      Effect.ensuring(
        Deferred.succeed(releaseRead, undefined).pipe(
          Effect.andThen(Deferred.succeed(releaseGeneral, undefined)),
          Effect.andThen(Deferred.succeed(releaseEarlier, undefined)),
        ),
      ),
      Effect.scoped,
    );
  }).pipe(Effect.provide(TestClock.layer())),
);
