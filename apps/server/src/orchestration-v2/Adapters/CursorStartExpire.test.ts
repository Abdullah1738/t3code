import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { CursorAdapterV2Driver } from "@t3tools/provider-cursor/server";
import * as CursorAgentSdk from "@t3tools/provider-cursor/server/CursorAgentSdk";
import { CURSOR_DRIVER_KIND } from "@t3tools/provider-cursor/testing";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../ProviderSessionManager.ts";
import { layerWithRegistry } from "../testkit/ProviderReplayHarness.ts";

function gate<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.effect.each([false, true])(
  "keeps Cursor ownership after transport loss (wait fails before Stop: %s)",
  (failureBeforeStop) =>
    Effect.gen(function* () {
      const workspace = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "cursor-expiry-",
      });
      const instanceId = ProviderInstanceId.make("cursor-expiry");
      const threadId = ThreadId.make("thread:cursor-expiry");
      const nativeId = "cursor-native-expiry";
      const modelSelection = { instanceId, model: "composer-2.5" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const offered = gate<void>();
      const aborted = gate<void>();
      const response = gate<void>();
      let prompts = 0;
      let aborts = 0;
      const registry = ProviderAdapterRegistry.layerFromDrivers({
        drivers: [CursorAdapterV2Driver],
        configMap: {
          [instanceId]: { driver: CURSOR_DRIVER_KIND, config: {} },
        },
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(CursorAgentSdk.CursorAgentSdkRunner, {
              assertComplete: Effect.void,
              open: () =>
                Effect.succeed({
                  agentId: nativeId,
                  listMessages: Effect.succeed([]),
                  close: Effect.void,
                  send: () =>
                    Effect.sync(() => {
                      prompts++;
                      offered.resolve();
                      return {
                        agentId: nativeId,
                        runId: `native-run-${prompts}`,
                        wait: Effect.tryPromise({
                          try: async () => {
                            await response.promise;
                            throw new Error("native stream lost");
                          },
                          catch: (cause) =>
                            new CursorAgentSdk.CursorAgentSdkRunnerError({
                              method: "run.wait",
                              cause,
                            }),
                        }),
                        cancel: Effect.sync(() => {
                          aborts++;
                          aborted.resolve();
                        }),
                      };
                    }),
                }),
            }),
            TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
            NodeServices.layer,
            IdAllocator.layer,
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const engine = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cursor-expiry-create"),
          threadId,
          createdBy: "user",
          creationSource: "web",
          projectId: ProjectId.make("cursor-expiry-project"),
          title: "Expiry",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: workspace,
        });
        const runtime = yield* sessions.open({
          threadId,
          providerSessionId: ProviderSessionId.make("cursor-expiry-session"),
          modelSelection,
          runtimePolicy,
        });
        const thread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
        const appThread = (yield* engine.getThreadProjection(threadId)).thread;
        yield* sink.write({
          events: [
            {
              id: EventId.make("cursor-expiry-owner"),
              threadId,
              type: "provider-thread.updated",
              driver: CURSOR_DRIVER_KIND,
              providerInstanceId: instanceId,
              occurredAt: yield* DateTime.now,
              payload: thread,
            },
            {
              id: EventId.make("cursor-expiry-binding"),
              threadId,
              type: "thread.metadata-updated",
              occurredAt: yield* DateTime.now,
              payload: { ...appThread, activeProviderThreadId: thread.id },
            },
          ],
        });
        const send = (ordinal: number) =>
          engine.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`cursor-expiry-send-${ordinal}`),
            threadId,
            messageId: MessageId.make(`cursor-expiry-message-${ordinal}`),
            text: "Work",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            modelSelection,
            dispatchMode: { type: "start_immediately" },
          });
        yield* send(1);
        const run = (yield* engine.getThreadProjection(threadId)).runs[0]!;
        const subscription = yield* runtime.subscribeEvents!;
        yield* Effect.addFinalizer(() => subscription.close);
        const localEnd = yield* subscription.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
          Effect.forkScoped,
        );
        const starting = yield* runtime
          .startTurn({
            appThread,
            threadId,
            runId: run.id,
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            attemptId: run.activeAttemptId!,
            rootNodeId: run.rootNodeId!,
            providerThread: thread,
            message: {
              messageId: MessageId.make("cursor-expiry-prompt"),
              text: "Work",
              attachments: [],
              createdBy: "user",
              creationSource: "web",
            },
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.exit, Effect.forkScoped);
        yield* Effect.promise(() => offered.promise);
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("cursor-expiry-deadline"),
              threadId,
              runId: run.id,
              type: "run.updated",
              occurredAt: now,
              payload: { ...run, providerStartDeadlineAt: now },
            },
          ],
        });
        const expireId = CommandId.make("cursor-expiry-expire");
        yield* engine.dispatch({
          type: "run.start-expire",
          commandId: expireId,
          threadId,
          runId: run.id,
          expectedAttemptId: run.activeAttemptId,
          deadline: now,
          phase: "provider",
        });
        const stop = (yield* outbox.listByCommandId(expireId)).find(
          (row) => row.request.type === "provider-turn.interrupt",
        )!;
        assert.isDefined(stop);
        assert.isTrue(Exit.isSuccess(yield* Fiber.join(starting)));
        if (failureBeforeStop) {
          response.resolve();
          const terminal = Option.getOrThrow(yield* Fiber.join(localEnd));
          assert.isFalse("nativeWorkEnded" in terminal);
        }
        yield* send(2);
        const workerLayer = EffectWorker.layerWithOptions({
          workerId: "cursor-expiry-stop",
          maxAttempts: 2,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(EffectOutbox.EffectOutboxV2, outbox),
              Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, executor),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const retrying = yield* worker.runStartOnce.pipe(Effect.forkScoped);
          yield* TestClock.adjust("1 second");
          const stopping = yield* worker.runControlOnce.pipe(Effect.forkScoped);
          yield* Effect.promise(() => aborted.promise);
          response.resolve();
          const terminal = Option.getOrThrow(yield* Fiber.join(localEnd));
          assert.isFalse("nativeWorkEnded" in terminal);
          assert.isTrue(yield* runtime.holdsWorkForThread!(thread));
          assert.equal(aborts, 1);
          assert.equal(prompts, 1);
          yield* TestClock.adjust("30 seconds");
          yield* Fiber.join(stopping);
          yield* Fiber.join(retrying);
          const blocked = yield* engine.getThreadProjection(threadId);
          const retry = blocked.runs.find((row) => row.ordinal === 2)!;
          assert.equal(retry.status, "failed");
          assert.isTrue(
            blocked.turnItems.some(
              (item) =>
                item.runId === retry.id &&
                item.type === "error" &&
                item.failure.code === "previous_turn_still_running",
            ),
          );
          const pending = Option.getOrThrow(yield* outbox.get(stop.id));
          assert.equal(pending.status, "pending");
          yield* TestClock.adjust(
            Math.max(
              0,
              DateTime.toEpochMillis(DateTime.makeUnsafe(pending.availableAt)) -
                DateTime.toEpochMillis(yield* DateTime.now),
            ),
          );
          const stoppingAgain = yield* worker.runControlOnce.pipe(Effect.forkScoped);
          yield* TestClock.adjust("30 seconds");
          yield* Fiber.join(stoppingAgain);
          assert.equal(Option.getOrThrow(yield* outbox.get(stop.id)).status, "failed");
          assert.equal(aborts, 1);
          assert.equal(prompts, 1);
          yield* worker.drain();
          assert.isTrue(yield* runtime.holdsWorkForThread!(thread));
          assert.equal(prompts, 1);
        }).pipe(Effect.provide(workerLayer));
      }).pipe(
        Effect.provide(
          layerWithRegistry(
            { name: "cursor-expiry", runtimePolicyOverride: { cwd: workspace } },
            registry,
            { runEffectWorker: false },
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(TestClock.layer(), NodeServices.layer))),
);
