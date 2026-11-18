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
import { OpenCodeAdapterV2Driver } from "@t3tools/provider-opencode/server";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import { OPENCODE_PROVIDER } from "@t3tools/provider-opencode/testing";
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

function nativeEventStream() {
  const values: Array<{ value: unknown; handled: ReturnType<typeof gate<void>> }> = [];
  const waiters: Array<(value: IteratorResult<unknown>) => void> = [];
  let previous: ReturnType<typeof gate<void>> | undefined;
  let closed = false;
  return {
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined });
    },
    push(value: unknown) {
      const handled = gate<void>();
      const waiter = waiters.shift();
      if (waiter) {
        previous = handled;
        waiter({ done: false, value });
      } else values.push({ value, handled });
      return handled.promise;
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            previous?.resolve();
            if (closed) return Promise.resolve({ done: true as const, value: undefined });
            const entry = values.shift();
            if (entry) {
              previous = entry.handled;
              return Promise.resolve({ done: false as const, value: entry.value });
            }
            return new Promise<IteratorResult<unknown>>((resolve) => waiters.push(resolve));
          },
        };
      },
    },
  };
}

it.effect.each(["delivery-first", "cleanup-first", "cleanup-in-flight"] as const)(
  "keeps OpenCode 1 Stop delivery owned across native settlement (%s)",
  (scenario) =>
    Effect.gen(function* () {
      const workspace = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "opencode1-expiry-",
      });
      const instanceId = ProviderInstanceId.make("opencode1-expiry");
      const threadId = ThreadId.make("thread:opencode1-expiry");
      const nativeId = "opencode1-native-expiry";
      const modelSelection = { instanceId, model: "anthropic/claude-sonnet" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const offered = gate<void>();
      const aborted = gate<void>();
      const probed = gate<void>();
      const response = gate<void>();
      const abortResponse = gate<void>();
      const cleanupInFlight = scenario === "cleanup-in-flight";
      let abortDeliveredAt = 0;
      const events = nativeEventStream();
      let prompts = 0;
      let aborts = 0;
      let busy = true;
      const session = {
        id: nativeId,
        title: "expiry",
        directory: workspace,
        time: { created: 1, updated: 1 },
      };
      const client = {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => events.close(), { once: true });
            return { stream: events.stream };
          },
        },
        session: {
          create: async () => ({ data: session }),
          get: async () => ({ data: session }),
          update: async () => ({ data: session }),
          messages: async () => ({ data: [] }),
          children: async () => ({ data: [] }),
          promptAsync: async () => {
            prompts++;
            if (prompts === 1) {
              offered.resolve();
              await response.promise;
              throw new Error("HTTP response lost after native prompt began");
            }
            return { data: true };
          },
          abort: async () => {
            aborts++;
            aborted.resolve();
            if (cleanupInFlight) await abortResponse.promise;
            abortDeliveredAt = prompts;
            return { data: true };
          },
          status: async () => {
            probed.resolve();
            return { data: busy ? { [nativeId]: { type: "busy" } } : {} };
          },
        },
        mcp: { add: async () => ({ data: {} }) },
      };
      const registry = ProviderAdapterRegistry.layerFromDrivers({
        drivers: [
          {
            ...OpenCodeAdapterV2Driver,
            create: (input) =>
              OpenCodeAdapterV2Driver.create(input).pipe(
                Effect.map((adapter) => ({
                  ...adapter,
                  openSession: (input) =>
                    adapter.openSession(input).pipe(
                      Effect.map((runtime) => ({
                        ...runtime,
                        // Reproduce native work before initial turn ingestion reaches the server.
                        events: cleanupInFlight
                          ? runtime.events.pipe(
                              Stream.filter((event) => event.type !== "provider_turn.updated"),
                            )
                          : runtime.events,
                      })),
                    ),
                })),
              ),
          },
        ],
        configMap: {
          [instanceId]: { driver: OPENCODE_PROVIDER, config: { serverUrl: "http://test.invalid" } },
        },
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(OpenCodeRuntime.OpenCodeRuntime, {
              connectToOpenCodeServer: () =>
                Effect.succeed({ url: "http://test.invalid", external: true }),
              createOpenCodeSdkClient: () => client,
            } as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"]),
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
        const workerLayer = EffectWorker.layerWithOptions({
          workerId: "oc1-stop",
          maxAttempts: 2,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(EffectOutbox.EffectOutboxV2, outbox),
              Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, executor),
            ),
          ),
        );
        const firstWorker = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
          Effect.provide(workerLayer),
        );
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("oc1-create"),
          threadId,
          createdBy: "user",
          creationSource: "web",
          projectId: ProjectId.make("oc1-project"),
          title: "Expiry",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: workspace,
        });
        const runtime = yield* sessions.open({
          threadId,
          providerSessionId: ProviderSessionId.make("oc1-session"),
          modelSelection,
          runtimePolicy,
        });
        const thread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
        const appThread = (yield* engine.getThreadProjection(threadId)).thread;
        yield* sink.write({
          events: [
            {
              id: EventId.make("oc1-owner"),
              threadId,
              type: "provider-thread.updated",
              driver: OPENCODE_PROVIDER,
              providerInstanceId: instanceId,
              occurredAt: yield* DateTime.now,
              payload: thread,
            },
            {
              id: EventId.make("oc1-binding"),
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
            commandId: CommandId.make(`oc1-send-${ordinal}`),
            threadId,
            messageId: MessageId.make(`oc1-message-${ordinal}`),
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
        const starting = yield* Effect.gen(function* () {
          if (cleanupInFlight) {
            yield* firstWorker.runStartOnce;
            return;
          }
          yield* runtime.startTurn({
            appThread,
            threadId,
            runId: run.id,
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            attemptId: run.activeAttemptId!,
            rootNodeId: run.rootNodeId!,
            providerThread: thread,
            message: {
              messageId: MessageId.make("oc1-prompt"),
              text: "Work",
              attachments: [],
              createdBy: "user",
              creationSource: "web",
            },
            modelSelection,
            runtimePolicy,
          });
        }).pipe(Effect.exit, Effect.forkScoped);
        yield* Effect.promise(() => offered.promise);
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("oc1-deadline"),
              threadId,
              runId: run.id,
              type: "run.updated",
              occurredAt: now,
              payload: { ...run, providerStartDeadlineAt: now },
            },
          ],
        });
        const expireId = CommandId.make("oc1-expire");
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
        if (cleanupInFlight) {
          assert.equal(stop.request.type, "provider-turn.interrupt");
          assert.isTrue(
            stop.request.type === "provider-turn.interrupt" &&
              stop.request.startingRun !== undefined,
          );
          yield* Effect.promise(() => aborted.promise);
          busy = false;
          yield* Effect.promise(() =>
            events.push({ type: "session.idle", properties: { sessionID: nativeId } }),
          );
          yield* Fiber.join(localEnd);
          yield* send(2);
          const retrying = yield* firstWorker.runStartOnce.pipe(Effect.forkScoped);
          const stopping = yield* firstWorker.runControlOnce.pipe(Effect.forkScoped);
          yield* TestClock.adjust("1 second");
          assert.equal(Option.getOrThrow(yield* outbox.get(stop.id)).status, "running");
          assert.equal(prompts, 1);
          abortResponse.resolve();
          response.resolve();
          yield* Fiber.join(starting);
          yield* Fiber.join(stopping);
          yield* Fiber.join(retrying);
          yield* firstWorker.drain();
          assert.equal(Option.getOrThrow(yield* outbox.get(stop.id)).status, "succeeded");
          assert.equal(aborts, 1);
          assert.equal(abortDeliveredAt, 1);
          assert.equal(prompts, 2);
          yield* Effect.promise(() =>
            events.push({ type: "session.idle", properties: { sessionID: nativeId } }),
          );
          return;
        }
        response.resolve();
        assert.isTrue(Exit.isFailure(yield* Fiber.join(starting)));
        const terminal = Option.getOrThrow(yield* Fiber.join(localEnd));
        assert.isFalse("nativeWorkEnded" in terminal);
        assert.isTrue(yield* runtime.holdsWorkForThread!(thread));
        assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
        if (scenario === "cleanup-first")
          yield* runtime.interruptStartingRun!({
            providerThread: thread,
            runId: run.id,
            attemptId: run.activeAttemptId!,
            stopBackgroundWork: false,
          });
        yield* send(2);
        yield* Effect.gen(function* () {
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const retrying = yield* worker.runStartOnce.pipe(Effect.forkScoped);
          yield* TestClock.adjust("1 second");
          const stopping = yield* worker.runControlOnce.pipe(Effect.forkScoped);
          yield* Effect.promise(() => aborted.promise);
          yield* Effect.promise(() => probed.promise);
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
          busy = false;
          yield* Effect.promise(() =>
            events.push({ type: "session.idle", properties: { sessionID: nativeId } }),
          );
          yield* send(3);
          yield* worker.drain();
          assert.equal(prompts, 2);
          assert.equal(aborts, 1);
          assert.equal(
            (yield* engine.getThreadProjection(threadId)).runs.find((row) => row.id === run.id)
              ?.status,
            "failed",
          );
          yield* Effect.promise(() =>
            events.push({ type: "session.idle", properties: { sessionID: nativeId } }),
          );
        }).pipe(Effect.provide(workerLayer));
      }).pipe(
        Effect.provide(
          layerWithRegistry(
            { name: "opencode1-expiry", runtimePolicyOverride: { cwd: workspace } },
            registry,
            { runEffectWorker: false },
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(TestClock.layer(), NodeServices.layer))),
);
