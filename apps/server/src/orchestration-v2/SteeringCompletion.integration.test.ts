import { standardModelSelection } from "@t3tools/contracts";
import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
  type ModelSelection,
  type AnalyticsEvent,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  CodexProviderCapabilitiesV2,
  codexBackgroundCommandDetail,
} from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { backgroundWorkNotification } from "@t3tools/provider-core/server/notification";
import * as ThreadSettlementService from "./ThreadSettlementService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { layer as providerRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import * as Analytics from "../ardud/analytics/Analytics.ts";
import * as KanbanService from "../ardud/kanban/engine/KanbanService.ts";
import * as KanbanModels from "../ardud/kanban/engine/models.ts";
import * as KanbanStore from "../ardud/kanban/store/KanbanStore.ts";
import * as KanbanThreads from "../ardud/kanban/engine/threads.ts";
import { opencodeTestProvider } from "../ardud/kanban/engine/testProviders.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

it.effect.each(
  [false, true]
    .flatMap((mailbox) =>
      (
        [
          "before delivery",
          "during delivery",
          "before dispatch",
          "after delivery",
          "without native steering",
          "with interrupting native steering",
          "settled only",
        ] as const
      ).map((timing) => ({
        mailbox,
        notification: false,
        timing,
        activeTurnOnly: false,
        maintenance: null as string | null,
        label: mailbox ? "mailbox notification" : "steering",
      })),
    )
    .concat(
      (
        [
          "before delivery",
          "during delivery",
          "before dispatch",
          "after delivery",
          "without native steering",
          "with interrupting native steering",
        ] as const
      ).map((timing) => ({
        mailbox: false,
        notification: false,
        timing,
        activeTurnOnly: true,
        maintenance: null as string | null,
        label: "active-turn-only steering",
      })),
    )
    .concat(
      ["/compact", "/logout"].flatMap((maintenance) =>
        (["before dispatch", "before delivery"] as const).map((timing) => ({
          mailbox: false,
          notification: false,
          timing,
          activeTurnOnly: true,
          maintenance,
          label: `active-turn-only ${maintenance} steering`,
        })),
      ),
    )
    .concat(
      (["before delivery", "during delivery", "before dispatch", "after delivery"] as const).map(
        (timing) => ({
          mailbox: false,
          notification: true,
          timing,
          activeTurnOnly: false,
          maintenance: null as string | null,
          label: "background notification",
        }),
      ),
    )
    .filter(
      ({ mailbox, notification, timing, activeTurnOnly }) =>
        notification ||
        activeTurnOnly ||
        mailbox ||
        (timing !== "without native steering" &&
          timing !== "with interrupting native steering" &&
          timing !== "settled only"),
    ),
)(
  "delivers $label when completion wins $timing",
  ({ mailbox, notification, timing, activeTurnOnly, maintenance }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace(
          `steering-completion-${timing.replaceAll(" ", "-")}`,
        );
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
        const steerEntered = yield* Deferred.make<void>();
        const rejectSteer = yield* Deferred.make<void>();
        let steerCalls = 0;
        const capabilities = {
          ...CodexProviderCapabilitiesV2,
          turns: {
            ...CodexProviderCapabilitiesV2.turns,
            supportsActiveSteering: timing !== "without native steering",
            activeSteeringInterruptsTools: timing === "with interrupting native steering",
          },
        };
        const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
          instanceId,
          driver,
          getCapabilities: () => Effect.succeed(capabilities),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
          openSession: (input) =>
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              return {
                instanceId,
                driver,
                providerSessionId: input.providerSessionId,
                providerSession: {
                  id: input.providerSessionId,
                  driver,
                  providerInstanceId: instanceId,
                  status: "ready",
                  cwd,
                  model: modelSelection.model,
                  capabilities,
                  createdAt: now,
                  updatedAt: now,
                  lastError: null,
                },
                events: Stream.fromQueue(events),
                ensureThread: ({ threadId }) =>
                  Effect.succeed({
                    id: ProviderThreadId.make(`provider-thread:${threadId}`),
                    driver,
                    providerInstanceId: instanceId,
                    providerSessionId: input.providerSessionId,
                    appThreadId: threadId,
                    ownerNodeId: null,
                    nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                    nativeConversationHeadRef: null,
                    status: "idle",
                    firstRunOrdinal: null,
                    lastRunOrdinal: null,
                    handoffIds: [],
                    forkedFrom: null,
                    createdAt: now,
                    updatedAt: now,
                  }),
                resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
                startTurn: (turn) =>
                  Effect.gen(function* () {
                    started.push(turn);
                    yield* Queue.offer(events, {
                      type: "provider_turn.updated",
                      driver,
                      providerTurn: {
                        id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                        providerThreadId: turn.providerThread.id,
                        nodeId: turn.rootNodeId,
                        runAttemptId: turn.attemptId,
                        nativeTurnRef: {
                          driver,
                          nativeId: `native:${turn.attemptId}`,
                          strength: "strong",
                        },
                        ordinal: turn.providerTurnOrdinal,
                        status: "running",
                        startedAt: now,
                        completedAt: null,
                      },
                    });
                  }),
                steerTurn: (turn) =>
                  Effect.gen(function* () {
                    steerCalls += 1;
                    if (timing === "after delivery") return;
                    yield* Deferred.succeed(steerEntered, undefined);
                    yield* Deferred.await(rejectSteer);
                    return yield* new ProviderAdapter.ProviderAdapterSteerRunError({
                      driver,
                      providerThreadId: turn.providerThread.id,
                      providerTurnId: turn.providerTurnId,
                      cause: "turn already completed",
                    });
                  }),
                interruptTurn: () => Effect.void,
                respondToRuntimeRequest: () => Effect.void,
                readThreadSnapshot: () => Effect.die("unused"),
                rollbackThread: () => Effect.die("unused"),
                forkThread: () => Effect.die("unused"),
              };
            }),
        };
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = ThreadId.make("thread:steering-completion");
          const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
            orchestrator.streamDomainEvents.pipe(
              Stream.filter(predicate),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId: ProjectId.make("project:steering-completion"),
            title: "Steering race",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("first"),
            threadId,
            messageId: MessageId.make("message:first"),
            text: "first",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          const running = yield* watch(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          );
          yield* worker.drain();
          yield* Fiber.join(running);
          const first = started[0]!;
          if (maintenance !== null) {
            const sink = yield* EventSink.EventSinkV2;
            const current = yield* orchestrator.getThreadProjection(threadId);
            const message = current.messages.find(
              (message) => message.id === first.message.messageId,
            )!;
            yield* sink.write({
              events: [
                {
                  id: EventId.make("maintenance-message"),
                  type: "message.updated",
                  threadId,
                  runId: first.runId,
                  occurredAt: yield* DateTime.now,
                  payload: { ...message, text: maintenance },
                },
              ],
            });
          }
          const messageId = MessageId.make("message:steering");
          const taskId = NodeId.make("task:mailbox");
          if (mailbox) {
            const sink = yield* EventSink.EventSinkV2;
            const current = yield* orchestrator.getThreadProjection(threadId);
            const parentRun = current.runs.find((run) => run.id === first.runId)!;
            const now = yield* DateTime.now;
            yield* sink.write({
              events: [
                {
                  id: EventId.make("mailbox:cohort"),
                  type: "run.updated",
                  threadId,
                  runId: first.runId,
                  occurredAt: now,
                  payload: {
                    ...parentRun,
                    delegatedCompletion: {
                      disposition: "open",
                      nextGeneration: 2,
                      delivery: { generation: 1, messageId, taskIds: [taskId] },
                    },
                  },
                },
                {
                  id: EventId.make("mailbox:task"),
                  type: "subagent.updated",
                  threadId,
                  runId: first.runId,
                  nodeId: taskId,
                  occurredAt: now,
                  payload: {
                    id: taskId,
                    threadId,
                    runId: first.runId,
                    parentNodeId: first.rootNodeId,
                    origin: "app_owned",
                    createdBy: "agent",
                    driver,
                    providerInstanceId: instanceId,
                    providerThreadId: null,
                    childThreadId: null,
                    nativeTaskRef: null,
                    prompt: "Do background work",
                    title: "Background test",
                    model: null,
                    completionWake: timing === "settled only" ? "settled_only" : "always",
                    completionDelivery: { state: "claimed", observedByRunId: null },
                    status: "completed",
                    result: "done",
                    startedAt: now,
                    completedAt: now,
                    updatedAt: now,
                  },
                },
              ],
            });
          }
          const dispatchSteer = orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("steer"),
            threadId,
            messageId,
            text: "fix the popover",
            attachments: [
              {
                type: "image",
                id: "steering-screenshot",
                name: "image.png",
                mimeType: "image/png",
                sizeBytes: 10,
              },
            ],
            dispatchMode:
              mailbox || notification
                ? { type: "queue_after_active" }
                : {
                    type: "steer_active",
                    targetRunId: first.runId,
                    ...(activeTurnOnly ? { activeTurnOnly: true } : {}),
                  },
            createdBy: mailbox || notification ? "agent" : "user",
            creationSource: mailbox || notification ? "server" : "web",
            ...(notification
              ? {
                  notification: {
                    source: { kind: "command" as const },
                    outcome: "completed" as const,
                    summary: "Background command completed",
                  },
                }
              : {}),
            ...(mailbox
              ? {
                  delegatedCompletion: {
                    parentRunId: first.runId,
                    generation: 1,
                    taskIds: [taskId],
                  },
                }
              : {}),
          });
          if (
            activeTurnOnly &&
            (timing === "without native steering" ||
              (maintenance !== null && timing !== "before dispatch"))
          ) {
            assert.isTrue(Result.isFailure(yield* Effect.result(dispatchSteer)));
            yield* worker.drain();
            assert.equal(started.length, 1);
            return;
          }
          if (timing !== "before dispatch") {
            yield* dispatchSteer;
            if (notification) yield* orchestrator.promoteQueuedMessages(threadId, "wake");
            if (mailbox && timing === "without native steering") {
              assert.equal(yield* orchestrator.promoteQueuedMessages(threadId, "wake"), 0);
              assert.equal(
                yield* orchestrator.promoteQueuedMessages(threadId, "age", { minWaitMs: -1 }),
                0,
              );
              const queued = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.find(
                (run) => run.status === "queued",
              )!;
              assert.isTrue(
                Result.isFailure(
                  yield* Effect.result(
                    orchestrator.dispatch({
                      type: "queued-message.promote-to-steer",
                      threadId,
                      commandId: CommandId.make("mailbox-manual-promotion"),
                      queuedRunId: queued.id,
                      targetRunId: first.runId,
                    }),
                  ),
                ),
              );
            }
          }
          if (timing === "after delivery") yield* worker.drain();
          const delivery =
            timing === "during delivery" ? yield* worker.runOnce.pipe(Effect.forkScoped) : null;
          if (delivery !== null) yield* Deferred.await(steerEntered);
          const completed = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === first.runId &&
              event.payload.status === "waiting",
          );
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const turn = projection.providerTurns[0]!;
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
          });
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: turn.providerThreadId,
            providerTurnId: turn.id,
            runOrdinal: first.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Fiber.join(completed);
          if (delivery !== null) {
            yield* Deferred.succeed(rejectSteer, undefined);
            yield* Fiber.join(delivery);
          }
          if (timing === "before dispatch") {
            if (activeTurnOnly)
              assert.isTrue(Result.isFailure(yield* Effect.result(dispatchSteer)));
            else yield* dispatchSteer;
          }
          yield* worker.drain();
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          if (activeTurnOnly) {
            assert.equal(started.length, 1);
            const final = yield* orchestrator.getThreadProjection(threadId);
            assert.isFalse(final.runs.some((run) => run.status === "queued"));
            assert.equal(
              steerCalls,
              timing === "during delivery" || timing === "after delivery" ? 1 : 0,
            );
            return;
          }
          if (timing === "after delivery") {
            assert.equal(steerCalls, 1);
            assert.equal(started.length, 1);
            if (mailbox) {
              const delivered = yield* orchestrator.getThreadProjection(threadId);
              assert.equal(delivered.subagents[0]?.completionDelivery?.state, "delivered");
              assert.equal(delivered.subagents[0]?.completionDelivery?.observedByRunId, null);
              assert.equal(delivered.runs[0]?.delegatedCompletion?.delivery, null);
              assert.equal(
                delivered.turnItems.filter((item) => item.type === "notification").length,
                1,
              );
              yield* orchestrator.dispatch({
                type: "notification.delivery.accept",
                commandId: CommandId.make("duplicate-acceptance"),
                threadId,
                messageId,
              });
              yield* worker.drain();
              assert.equal(steerCalls, 1);
              yield* orchestrator.dispatch({
                type: "delegated_task.completion-delivery.acknowledge",
                commandId: CommandId.make("read-result"),
                parentThreadId: threadId,
                taskId,
                observedByRunId: first.runId,
              });
              const acknowledged = yield* orchestrator.getThreadProjection(threadId);
              assert.equal(acknowledged.subagents[0]?.completionDelivery?.state, "acknowledged");
            }
            return;
          }
          assert.equal(started.length, 2);
          assert.equal(started[1]?.message.messageId, messageId);
          if (mailbox) assert.include(started[1]?.message.text ?? "", String(taskId));
          else assert.equal(started[1]?.message.text, "fix the popover");
          assert.deepEqual(started[1]?.message.attachments, [
            {
              type: "image",
              id: "steering-screenshot",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 10,
            },
          ]);
          assert.equal(steerCalls, timing === "during delivery" ? 1 : 0);
          const final = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(final.messages.filter((message) => message.id === messageId).length, 1);
          assert.equal(
            final.messages.find((message) => message.id === messageId)?.runId,
            started[1]?.runId,
          );
          assert.equal(
            final.turnItems.filter((item) =>
              mailbox || notification
                ? item.type === "notification"
                : item.type === "user_message" && item.messageId === messageId,
            ).length,
            1,
          );
          yield* worker.drain();
          assert.equal(started.length, 2);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: `steering-completion-${timing}` },
              ProviderAdapterRegistry.layerSingle(adapter),
              { runEffectWorker: false },
            ),
          ),
        );
      }),
    ),
);

const runSelection = {
  instanceId,
  model: "test-model",
  options: [{ id: "effort", value: "xhigh" }],
};
const composerSelection = {
  ...runSelection,
  options: [...runSelection.options, { id: "fastMode", value: false }],
};

const nextTurnSelectionHarness = Effect.fn("nextTurnSelectionHarness")(function* (
  name: string,
  canRestart = false,
  runContinuationWorker = false,
  nativeAcceptance = false,
) {
  const cwd = yield* checkpointWorkspace(name);
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
  const steered: string[] = [];
  const capabilities = {
    ...CodexProviderCapabilitiesV2,
    turns: {
      ...CodexProviderCapabilitiesV2.turns,
      supportsActiveSteering: true,
      supportsSteeringByInterruptRestart: canRestart,
    },
  };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: runSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              started.push(turn);
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native:${turn.attemptId}`,
                    strength: "strong",
                  },
                  ordinal: turn.providerTurnOrdinal,
                  status: "running",
                  ...(nativeAcceptance ? { promptAcceptedAt: now } : {}),
                  startedAt: now,
                  completedAt: null,
                },
              });
            }),
          steerTurn: (turn) =>
            Effect.sync(() => {
              steered.push(turn.message.text);
            }),
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const db = Sqlite.layerMemory;
  const layer = Layer.mergeAll(
    ProviderReplayHarness.layerWithRegistry(
      { name },
      ProviderAdapterRegistry.layerSingle(adapter),
      { runEffectWorker: false, databaseLayer: db, runContinuationWorker },
    ),
    ProjectionStore.layer.pipe(Layer.provide(db)),
    CommandReceiptStore.layer.pipe(Layer.provide(db)),
    runContinuationWorker ? ProviderContinuationRequests.layer : Layer.empty,
  );
  const startFirstTurn = Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make(`project:${name}`),
      title: "Steer with changed options",
      modelSelection: runSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    const running = yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("first"),
      threadId,
      messageId: MessageId.make("message:first"),
      text: "first",
      attachments: [],
      modelSelection: runSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    yield* Fiber.join(running);
    return threadId;
  });
  return { events, started, steered, layer, db, startFirstTurn };
});

it.effect.each([{ canRestart: false }, { canRestart: true }])(
  "steers a changed turn-scoped selection into the running turn (canRestart=$canRestart)",
  ({ canRestart }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `steering-selection-change-${canRestart}`,
          canRestart,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const steer = (id: string, selection: ModelSelection) =>
            orchestrator
              .dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(id),
                threadId,
                messageId: MessageId.make(`message:${id}`),
                text: id,
                attachments: [],
                modelSelection: selection,
                dispatchMode: { type: "steer_active", targetRunId: started[0]!.runId },
                createdBy: "user",
                creationSource: "web",
              })
              .pipe(Effect.andThen(worker.drain()));

          yield* steer("steer-changed", composerSelection);
          const changed = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, ["steer-changed"]);
          assert.equal(started.length, 1);
          assert.lengthOf(changed.attempts, 1);
          assert.equal(changed.runs[0]?.status, "running");
          assert.deepEqual(changed.runs[0]?.modelSelection, runSelection);
          assert.deepEqual(changed.thread.modelSelection, composerSelection);

          yield* steer("steer-reverted", runSelection);
          const reverted = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, ["steer-changed", "steer-reverted"]);
          assert.lengthOf(reverted.attempts, 1);
          assert.deepEqual(reverted.thread.modelSelection, runSelection);

          const otherSelection = {
            instanceId: ProviderInstanceId.make("codex-work"),
            model: "other",
          };
          const sink = yield* EventSink.EventSinkV2;
          yield* sink.write({
            events: [
              {
                id: EventId.make("switched-away"),
                type: "thread.provider-switched",
                threadId,
                providerInstanceId: otherSelection.instanceId,
                occurredAt: yield* DateTime.now,
                payload: {
                  ...reverted.thread,
                  providerInstanceId: otherSelection.instanceId,
                  modelSelection: otherSelection,
                },
              },
            ],
          });
          yield* steer("steer-back", runSelection);
          const back = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, ["steer-changed", "steer-reverted", "steer-back"]);
          assert.equal(back.thread.providerInstanceId, instanceId);
          assert.deepEqual(back.thread.modelSelection, runSelection);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("starts a steer that missed the turn on the saved next-turn selection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "steering-selection-follow-up",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId: MessageId.make("message:steer"),
          text: "late steer",
          attachments: [],
          modelSelection: composerSelection,
          dispatchMode: { type: "steer_active", targetRunId: first.runId },
          createdBy: "user",
          creationSource: "web",
        });
        const settled = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === first.runId &&
              event.payload.status === "waiting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, []);
        assert.equal(started.length, 2);
        assert.equal(started[1]?.message.messageId, MessageId.make("message:steer"));
        assert.deepEqual(
          started[1]?.modelSelection,
          standardModelSelection(composerSelection, driver),
        );
        assert.deepEqual(projection.thread.modelSelection, composerSelection);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

// A draft that never reaches a paragraph boundary is held back while it
// streams. Codex only flushes it at turn end, after the final answer is written,
// so the draft must already own its place from before the steer.
it.effect("keeps a held commentary draft before the steer when turn end flushes it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("steering-held-draft");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        const now = yield* DateTime.now;
        const assistantItem = (id: string, text: string, streaming: boolean) =>
          ({
            type: "turn_item.updated",
            driver,
            turnItem: {
              id: TurnItemId.make(id),
              threadId,
              runId: first.runId,
              nodeId: first.rootNodeId,
              providerThreadId: turn.providerThreadId,
              providerTurnId: turn.id,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: streaming ? "running" : "completed",
              title: null,
              startedAt: now,
              completedAt: streaming ? null : now,
              updatedAt: now,
              type: "assistant_message",
              messageId: MessageId.make(`message:${id}`),
              text,
              streaming,
            },
          }) satisfies ProviderAdapter.ProviderAdapterV2Event;
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );

        // The cut-off draft starts first; the commentary after it is written,
        // so the draft has been seen by the time the steer arrives.
        yield* Queue.offer(events, assistantItem("draft", "Let me look at the", true));
        const commentaryWritten = yield* watch(
          (event) => event.type === "turn-item.updated" && event.payload.id === "commentary",
        );
        yield* Queue.offer(events, assistantItem("commentary", "Checking the popover.", false));
        yield* Fiber.join(commentaryWritten);

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId: MessageId.make("message:steer"),
          text: "fix the popover",
          attachments: [],
          dispatchMode: { type: "steer_active", targetRunId: first.runId },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        const settled = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === first.runId &&
            event.payload.status === "waiting",
        );
        yield* Queue.offer(events, assistantItem("answer", "All fixed.", false));
        yield* Queue.offer(events, assistantItem("draft", "Let me look at the", false));
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();

        const items = (yield* orchestrator.getThreadProjection(threadId)).turnItems
          .toSorted((left, right) => left.ordinal - right.ordinal)
          .flatMap((item) =>
            item.type === "user_message"
              ? [String(item.messageId)]
              : item.type === "assistant_message"
                ? [String(item.id)]
                : [],
          );
        assert.deepEqual(items, [
          "message:first",
          "draft",
          "commentary",
          "message:steer",
          "answer",
        ]);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect.each(["wake", "steer"] as const)(
  "#1431 %s flushes queued messages before the board text",
  (reason) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `queue-flush-${reason}`,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            threadId,
            commandId: CommandId.make("stale-nudge"),
            messageId: MessageId.make("kanban:wake:nudge:stale"),
            text: "old board snapshot",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "system",
            creationSource: "server",
          });
          for (const text of ["old notice", "new notice"]) {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              threadId,
              commandId: CommandId.make(text),
              messageId: MessageId.make(text),
              text,
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "system",
              creationSource: "server",
            });
          }
          const promotions: unknown[] = [];
          const logger = Logger.make(({ message }) => {
            const [label, fields] = Array.isArray(message) ? message : [message];
            if (label === "queued-message.promoted") promotions.push(fields);
          });
          yield* Effect.all(
            [
              orchestrator.promoteQueuedMessages(threadId, reason),
              orchestrator.promoteQueuedMessages(threadId, "age"),
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.provide(Logger.layer([logger])));
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            threadId,
            commandId: CommandId.make("board"),
            messageId: MessageId.make("board"),
            text: "board text",
            attachments: [],
            dispatchMode: { type: "steer_active", targetRunId: started[0]!.runId },
            createdBy: "system",
            creationSource: "server",
          });
          yield* worker.drain();
          assert.deepEqual(steered, ["old notice", "new notice", "board text"]);
          const records = yield* orchestrator.getThreadRecords(threadId, ["runs", "messages"]);
          assert.lengthOf(
            records.runs.filter((run) => run.status === "queued"),
            0,
          );
          assert.lengthOf(
            records.messages.filter((message) => message.text === "old notice"),
            1,
          );
          assert.deepEqual(
            promotions,
            ["old notice", "new notice"].map((text) => ({
              thread: threadId,
              queuedRunId: records.runs.find((run) => run.userMessageId === text)!.id,
              reason,
              waitedMs: 0,
            })),
          );
          yield* orchestrator.promoteQueuedMessages(threadId, reason);
          yield* worker.drain();
          assert.deepEqual(steered, ["old notice", "new notice", "board text"]);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect.each([
  { state: "running", reordered: false, held: false },
  { state: "starting", reordered: false, held: false },
  { state: "idle", reordered: false, held: false },
  { state: "running", reordered: true, held: false },
  { state: "running", reordered: false, held: true },
] as const)(
  "#1431 age bound leaves $state queues safe (reordered=$reordered, held=$held)",
  ({ state, reordered, held }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `queue-age-${state}-${reordered}-${held}`,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          for (const minutes of [31, 30, 29]) {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`queue-${minutes}`),
              threadId,
              messageId: MessageId.make(`queue-${minutes}`),
              text: `notice ${minutes}`,
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "system",
              creationSource: "server",
            });
          }
          if (reordered) {
            const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
            yield* orchestrator.dispatch({
              type: "queued-run.reorder",
              threadId,
              commandId: CommandId.make("move-young-first"),
              runId: runs.find((run) => run.userMessageId === "queue-29")!.id,
              beforeRunId: runs.find((run) => run.userMessageId === "queue-31")!.id,
            });
          }
          const records = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
          const now = yield* DateTime.now;
          const sink = yield* EventSink.EventSinkV2;
          yield* sink.write({
            events: records.runs.map((run) => ({
              id: EventId.make(`age:${run.id}`),
              type: "run.updated" as const,
              threadId,
              runId: run.id,
              occurredAt: now,
              payload:
                run.status === "queued"
                  ? {
                      ...run,
                      queueHeld: held,
                      requestedAt: DateTime.add(now, {
                        minutes: -Number(String(run.userMessageId).split("-").at(-1)),
                      }),
                    }
                  : { ...run, status: state === "idle" ? ("completed" as const) : state },
            })),
          });
          yield* ThreadSettlementService.promoteAgedQueuedMessages();
          yield* ThreadSettlementService.promoteAgedQueuedMessages();
          yield* worker.drain();
          assert.deepEqual(
            steered,
            state === "running" && !held
              ? reordered
                ? ["notice 29", "notice 31"]
                : ["notice 31"]
              : [],
          );
          const after = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
          if (state === "idle") {
            assert.isFalse(after.runs.some((run) => run.status === "cancelled"));
          } else {
            assert.lengthOf(
              after.runs.filter((run) => run.status === "queued"),
              state === "running" && !held ? (reordered ? 1 : 2) : 3,
            );
          }
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect.each(["age", "wake", "steer"] as const)(
  "#1431 concurrent %s checks promote a coalesced board wake once",
  (reason) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { steered, layer, startFirstTurn } =
          yield* nextTurnSelectionHarness("queue-coalesced");
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            threadId,
            commandId: CommandId.make("wake"),
            messageId: MessageId.make("kanban:wake:step:A:once"),
            text: "first snapshot",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "system",
            creationSource: "server",
          });
          const queued = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.find(
            (run) => run.status === "queued",
          )!;
          yield* orchestrator.dispatch({
            type: "queued-run.edit",
            threadId,
            commandId: CommandId.make("merge-wake"),
            runId: queued.id,
            text: "latest snapshot",
          });
          const now = yield* DateTime.now;
          yield* (yield* EventSink.EventSinkV2).write({
            events: [
              {
                id: EventId.make("age-merged-wake"),
                type: "run.updated",
                threadId,
                runId: queued.id,
                occurredAt: now,
                payload: { ...queued, requestedAt: DateTime.add(now, { minutes: -31 }) },
              },
            ],
          });
          yield* Effect.all(
            [
              orchestrator.promoteQueuedMessages(threadId, reason),
              orchestrator.promoteQueuedMessages(threadId, reason),
            ],
            { concurrency: "unbounded" },
          );
          yield* orchestrator.promoteQueuedMessages(threadId, "wake");
          yield* worker.drain();
          assert.deepEqual(steered, ["latest snapshot"]);
          assert.lengthOf(
            (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.filter(
              (run) => run.status === "queued",
            ),
            0,
          );
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect.each(["wake", "age"] as const)(
  "#1431 %s delivers the Codex message_text continuation with notification",
  (reason) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `codex-background-${reason}`,
          false,
          true,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const threadId = yield* startFirstTurn;
          const providerThread = (yield* orchestrator.getThreadRecords(threadId, [
            "providerThreads",
          ])).providerThreads[0]!;
          const command = "offbox logs run-1114-111918-44cf --follow";
          const detail = codexBackgroundCommandDetail({
            command,
            exitCode: 0,
            aggregatedOutput: "finished",
          });
          const notification = {
            ...backgroundWorkNotification([
              { kind: "command", label: command, outcome: "completed", exitCode: 0 },
            ]),
            detail: command,
          };
          const queued = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) => event.type === "message.updated" && event.payload.text === detail,
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          // Match CodexAdapterV2's offer: the continuation worker must choose server
          // creationSource for text that has no provider-buffered delivery.
          yield* requests.offer({
            threadId,
            providerThreadId: providerThread.id,
            driver,
            delivery: "message_text",
            detail,
            notification,
          });
          yield* Fiber.join(queued);
          const before = yield* orchestrator.getThreadRecords(threadId, ["messages", "runs"]);
          const message = before.messages.find((message) => message.text === detail)!;
          assert.equal(message.creationSource, "server");
          assert.equal(message.createdBy, "agent");
          assert.deepEqual(message.notification, notification);
          const run = before.runs.find((run) => run.id === message.runId)!;
          assert.equal(run.status, "queued");
          const now = yield* DateTime.now;
          yield* (yield* EventSink.EventSinkV2).write({
            events: [
              {
                id: EventId.make("age-codex-background"),
                type: "run.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: { ...run, requestedAt: DateTime.add(now, { minutes: -31 }) },
              },
            ],
          });
          if (reason === "age") yield* ThreadSettlementService.promoteAgedQueuedMessages();
          else yield* orchestrator.promoteQueuedMessages(threadId, reason);
          yield* worker.drain();
          yield* orchestrator.promoteQueuedMessages(threadId, "wake");
          yield* worker.drain();
          assert.deepEqual(steered, [detail]);
          const after = yield* orchestrator.getThreadRecords(threadId, ["messages", "runs"]);
          assert.lengthOf(
            after.runs.filter((run) => run.status === "queued"),
            0,
          );
          assert.lengthOf(
            after.messages.filter((row) => row.id === message.id),
            1,
          );
          assert.deepEqual(
            after.messages.find((row) => row.id === message.id)!.notification,
            notification,
          );
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect.each(
  (["command", "monitor", "background_task", "subagent"] as const).flatMap((kind) =>
    (["server", "provider"] as const).flatMap((creationSource) =>
      (["wake", "age", "manual"] as const).map((reason) => ({ kind, creationSource, reason })),
    ),
  ),
)(
  "#1431 $reason handles $kind notification text from $creationSource",
  ({ kind, creationSource, reason }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `notification-${kind}-${creationSource}-${reason}`,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const text = "Background command completed (exit 0): offbox logs --follow";
          const notification = {
            source: { kind },
            outcome: "completed" as const,
            summary: text,
            detail: "offbox logs --follow",
          };
          const messageId = MessageId.make("background-notification");
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            threadId,
            commandId: CommandId.make("background-notification"),
            messageId,
            text,
            notification,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource,
          });
          const queued = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.find(
            (run) => run.status === "queued",
          )!;
          assert.isDefined(queued);
          const now = yield* DateTime.now;
          yield* (yield* EventSink.EventSinkV2).write({
            events: [
              {
                id: EventId.make("age-background"),
                type: "run.updated",
                threadId,
                runId: queued.id,
                occurredAt: now,
                payload: { ...queued, requestedAt: DateTime.add(now, { minutes: -31 }) },
              },
            ],
          });
          if (reason === "manual") {
            const result = yield* Effect.result(
              orchestrator.dispatch({
                type: "queued-message.promote-to-steer",
                threadId,
                commandId: CommandId.make("promote-background"),
                queuedRunId: queued.id,
                targetRunId: (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.find(
                  (run) => run.status === "running",
                )!.id,
              }),
            );
            assert.equal(Result.isSuccess(result), creationSource === "server");
          } else if (reason === "age") {
            yield* ThreadSettlementService.promoteAgedQueuedMessages();
          } else {
            yield* orchestrator.promoteQueuedMessages(threadId, reason);
          }
          yield* worker.drain();
          assert.deepEqual(steered, creationSource === "server" ? [text] : []);
          const records = yield* orchestrator.getThreadRecords(threadId, [
            "runs",
            "messages",
            "turnItems",
          ]);
          assert.lengthOf(
            records.runs.filter((run) => run.status === "queued"),
            creationSource === "server" ? 0 : 1,
          );
          const message = records.messages.find((message) => message.id === messageId)!;
          assert.deepEqual(message.notification, notification);
          if (creationSource === "server") {
            assert.equal(records.runs.find((run) => run.id === message.runId)!.status, "running");
            assert.lengthOf(
              records.turnItems.filter(
                (item) => item.type === "notification" && item.summary === text,
              ),
              1,
            );
            yield* orchestrator.promoteQueuedMessages(threadId, "wake");
            yield* worker.drain();
            assert.deepEqual(steered, [text]);
          }
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect.each(
  (["wake", "steer"] as const)
    .flatMap((action) =>
      ["", " \n\t", "replacement input"].map((text) => ({
        action,
        text,
        rejected: false,
        notices: false,
      })),
    )
    .concat([{ action: "wake", text: "replacement input", rejected: true, notices: false }])
    .concat(
      (["wake", "steer"] as const).map((action) => ({
        action,
        text: "replacement input",
        rejected: false,
        notices: true,
      })),
    ),
)(
  "#1431 cardThread $action preserves merged wakes with text '$text' (rejected=$rejected, notices=$notices)",
  ({ action, text, rejected, notices }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { steered, layer, db, startFirstTurn } = yield* nextTurnSelectionHarness(
          `card-wake-${action}-${text.length}-${rejected}`,
        );
        const management = ThreadManagementService.layer.pipe(
          Layer.provideMerge(layer),
          Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(db))),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provideMerge(db),
        );
        const fallible = Layer.effect(
          ThreadManagementService.ThreadManagementService,
          Effect.map(ThreadManagementService.ThreadManagementService, (real) => ({
            ...real,
            sendToThread: (input: Parameters<typeof real.sendToThread>[0]) =>
              rejected && input.text === "replacement input"
                ? Effect.fail(
                    new Orchestrator.OrchestratorProjectionError({
                      threadId: input.threadId,
                      cause: "replacement rejected",
                    }),
                  )
                : real.sendToThread(input),
          })),
        ).pipe(Layer.provide(management));
        const lifecycle = KanbanThreads.layer.pipe(
          Layer.provide(fallible),
          Layer.provide(db),
          Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        );
        const boardLayer = KanbanService.layer.pipe(
          Layer.provideMerge(lifecycle),
          Layer.provideMerge(KanbanModels.layerTest(null)),
          Layer.provideMerge(KanbanStore.layer.pipe(Layer.provide(db))),
          Layer.provideMerge(db),
          Layer.provide(Layer.mock(TextGeneration.TextGeneration)({})),
          Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
          Layer.provide(providerRegistryLayer([opencodeTestProvider()])),
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-queue-wake-" }).pipe(
              Layer.provideMerge(NodeServices.layer),
              Layer.provideMerge(ServerSettings.layerTest()),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const threadId = yield* startFirstTurn;
          const kanban = yield* KanbanService.KanbanService;
          const store = yield* KanbanStore.KanbanStore;
          const threads = yield* KanbanThreads.KanbanThreads;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const board = yield* kanban.ensureBoard({
            slug: "queue-wake",
            name: "Queue wake",
            defaultProjectId: ProjectId.make(
              `project:card-wake-${action}-${text.length}-${rejected}`,
            ),
          });
          const card = yield* kanban.createCard(
            board.id,
            { title: "Wake queue", prompt: "Work" },
            { _tag: "owner" },
          );
          yield* store.putCard({
            ...card,
            stage: "working",
            activeRole: "work",
            activeThreadId: threadId,
            workThreadId: threadId,
            model: runSelection,
          });
          // Board sends queue/coalesce during startup, then need a flush once
          // the provider is running. A running board send normally steers.
          const active = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.find(
            (run) => run.status === "running",
          )!;
          const sink = yield* EventSink.EventSinkV2;
          const now = yield* DateTime.now;
          yield* sink.write({
            events: [
              {
                id: EventId.make("board-wake-starting"),
                type: "run.updated",
                threadId,
                runId: active.id,
                occurredAt: now,
                payload: { ...active, status: "starting" },
              },
            ],
          });
          const queuedId = yield* threads.send({
            threadId,
            text: "first snapshot",
            coalesce: "nudge",
          });
          assert.equal(
            yield* threads.send({
              threadId,
              text: "latest snapshot",
              coalesce: "nudge",
            }),
            queuedId,
          );
          yield* sink.write({
            events: [
              {
                id: EventId.make("board-wake-running"),
                type: "run.updated",
                threadId,
                runId: active.id,
                occurredAt: now,
                payload: active,
              },
            ],
          });
          assert.lengthOf(yield* threads.queuedRuns(threadId), 1);
          const queuedText = notices ? ["old notice", "new notice"] : [];
          for (const notice of queuedText)
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              threadId,
              commandId: CommandId.make(notice),
              messageId: MessageId.make(notice),
              text: notice,
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "system",
              creationSource: "server",
            });
          const before = yield* kanban.card(card.id);
          const result = yield* Effect.result(
            kanban.cardThread(card.id, action, text, { _tag: "owner" }),
          );
          const refused = rejected || !text.trim();
          assert.equal(Result.isFailure(result), refused);
          if (!text.trim()) {
            assert(Result.isFailure(result));
            assert.equal(result.failure.code, "invalid");
            assert.deepEqual(yield* kanban.card(card.id), before);
          }
          yield* worker.drain();
          assert.deepEqual(steered, refused ? [] : [...queuedText, text]);
          if (refused) {
            assert.lengthOf(yield* threads.queuedRuns(threadId), 1);
          }
          yield* orchestrator.promoteQueuedMessages(threadId, "wake");
          yield* worker.drain();
          assert.deepEqual(steered, [...queuedText, refused ? "latest snapshot" : text]);
          assert.lengthOf(yield* threads.queuedRuns(threadId), 0);
          const records = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
          assert.equal(records.runs.find((run) => run.id === queuedId)!.status, "cancelled");
        }).pipe(Effect.provide(Layer.merge(layer, boardLayer)));
      }),
    ),
);

it.effect.each(
  (["wake", "steer"] as const).flatMap((action) =>
    ["", " \n\t", "replacement input"].map((text) => ({ action, text })),
  ),
)(
  "a revoked $action cannot flush queued notices or merged wakes (text '$text')",
  ({ action, text }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { steered, layer, db, startFirstTurn } = yield* nextTurnSelectionHarness(
          `revoked-queue-${action}-${text.length}`,
        );
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let revoked = false;
        const management = ThreadManagementService.layer.pipe(
          Layer.provideMerge(layer),
          Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(db))),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provideMerge(db),
        );
        const delayed = Layer.effect(
          ThreadManagementService.ThreadManagementService,
          Effect.map(ThreadManagementService.ThreadManagementService, (real) => ({
            ...real,
            promoteQueuedMessages: (...args: Parameters<typeof real.promoteQueuedMessages>) =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(resume)),
                Effect.andThen(real.promoteQueuedMessages(...args)),
              ),
          })),
        ).pipe(Layer.provide(management));
        const lifecycle = KanbanThreads.layer.pipe(
          Layer.provide(delayed),
          Layer.provide(db),
          Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        );
        yield* Effect.gen(function* () {
          const threadId = yield* startFirstTurn;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threads = yield* KanbanThreads.KanbanThreads;
          // A real notice followed by a merged board wake must both survive a revoked flush.
          for (const [id, queuedText] of [
            ["notice", "queued notice"],
            ["kanban:wake:nudge:latest", "latest snapshot"],
          ] as const)
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              threadId,
              commandId: CommandId.make(id),
              messageId: MessageId.make(id),
              text: queuedText,
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "system",
              creationSource: "server",
            });
          const sending = yield* threads
            .send({ threadId, text, flushQueued: action, isStale: () => revoked })
            .pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          revoked = true;
          yield* Deferred.succeed(resume, undefined);
          yield* Fiber.join(sending);
          yield* worker.drain();
          assert.deepEqual(steered, []);
          assert.lengthOf(yield* threads.queuedRuns(threadId), 2);
          const afterRevocation = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
          assert.isFalse(
            afterRevocation.messages.some((message) => message.text === "replacement input"),
          );
          // A fresh Wake after Restore may flush these same inputs normally.
          yield* threads.send({ threadId, text: "", flushQueued: "wake" });
          yield* worker.drain();
          assert.deepEqual(steered, ["queued notice", "latest snapshot"]);
          assert.lengthOf(yield* threads.queuedRuns(threadId), 0);
        }).pipe(Effect.provide(Layer.merge(layer, lifecycle)));
      }),
    ),
);

it.effect.each(
  ([undefined, "steer"] as const).flatMap((mode) =>
    [false, true].map((explicitModel) => ({ mode, explicitModel })),
  ),
)(
  "revoked preflight cannot steer restored work (mode $mode, model $explicitModel)",
  ({ mode, explicitModel }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = `revoked-preflight-${mode ?? "auto"}-${explicitModel}`;
        const { events, started, steered, layer, db, startFirstTurn } =
          yield* nextTurnSelectionHarness(name);
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let hold = true;
        let revoked = false;
        const delayed = Layer.effect(
          Orchestrator.OrchestratorV2,
          Effect.map(Orchestrator.OrchestratorV2, (real) => {
            const getThreadRecords: typeof real.getThreadRecords = (id, fields, filter) =>
              Effect.gen(function* () {
                if (
                  hold &&
                  fields.length === 2 &&
                  fields[0] === "runs" &&
                  fields[1] === "providerTurns"
                ) {
                  hold = false;
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(resume);
                }
                return yield* real.getThreadRecords(id, fields, filter);
              });
            return { ...real, getThreadRecords };
          }),
        ).pipe(Layer.provideMerge(layer));
        const management = ThreadManagementService.layer.pipe(
          Layer.provideMerge(delayed),
          Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(db))),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provideMerge(db),
        );
        const lifecycle = KanbanThreads.layer.pipe(
          Layer.provide(management),
          Layer.provide(db),
          Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        );
        yield* Effect.gen(function* () {
          const threadId = yield* startFirstTurn;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threads = yield* KanbanThreads.KanbanThreads;
          const sending = yield* threads
            .send({
              threadId,
              text: "Old board post",
              key: "revoked-preflight",
              ...(mode === undefined ? {} : { mode }),
              ...(explicitModel ? { model: runSelection } : {}),
              isStale: () => revoked,
            })
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(entered);
          revoked = true;
          const settled = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) => event.type === "run.updated" && event.payload.status === "interrupted",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* threads.interrupt(threadId, "Board deleted", true);
          yield* worker.drain();
          const turn = (yield* orchestrator.getThreadRecords(threadId, ["providerTurns"]))
            .providerTurns[0]!;
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...turn, status: "interrupted", completedAt: yield* DateTime.now },
          });
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: turn.providerThreadId,
            providerTurnId: turn.id,
            runOrdinal: started[0]!.runOrdinal,
            status: "interrupted",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Fiber.join(settled);
          const running = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "provider-turn.updated" && event.payload.status === "running",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("restored-work"),
            threadId,
            messageId: MessageId.make("restored-work"),
            text: "Restored board work",
            attachments: [],
            modelSelection: runSelection,
            dispatchMode: { type: "start_immediately" },
            createdBy: "system",
            creationSource: "server",
          });
          yield* worker.drain();
          yield* Fiber.join(running);
          const restoredRun = started.at(-1)!.runId;
          assert.notEqual(restoredRun, started[0]!.runId);
          yield* Deferred.succeed(resume, undefined);
          const result = yield* Fiber.join(sending);
          assert.isTrue(Result.isFailure(result));
          if (Result.isSuccess(result)) return;
          assert.isUndefined(result.failure.sentRunId);
          assert.isUndefined(result.failure.wakeMessageId);
          yield* worker.drain();
          const records = yield* orchestrator.getThreadRecords(threadId, ["runs", "messages"]);
          assert.equal(records.runs.find((run) => run.id === restoredRun)!.status, "running");
          assert.isFalse(records.messages.some((message) => message.text === "Old board post"));
          assert.deepEqual(steered, []);
          assert.lengthOf(started, 2);
          yield* threads.send({ threadId, text: "Fresh board post" });
          yield* worker.drain();
          assert.deepEqual(steered, ["Fresh board post"]);
        }).pipe(Effect.provide(Layer.merge(layer, lifecycle)));
      }),
    ),
);

it.effect("#1431 a transient rejected promotion does not poison the next sweep", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { steered, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("queue-rejected-retry");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sink = yield* EventSink.EventSinkV2;
        const threadId = yield* startFirstTurn;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          threadId,
          commandId: CommandId.make("notice"),
          messageId: MessageId.make("notice"),
          text: "notice",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "system",
          creationSource: "server",
        });
        const turn = (yield* orchestrator.getThreadRecords(threadId, ["providerTurns"]))
          .providerTurns[0]!;
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("turn-pending"),
              type: "provider-turn.updated",
              threadId,
              occurredAt: now,
              payload: { ...turn, status: "pending" },
            },
          ],
        });
        const failed = yield* orchestrator
          .promoteQueuedMessages(threadId, "wake")
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(failed));
        assert.lengthOf(
          (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.filter(
            (run) => run.status === "queued",
          ),
          1,
        );
        yield* sink.write({
          events: [
            {
              id: EventId.make("turn-running"),
              type: "provider-turn.updated",
              threadId,
              occurredAt: now,
              payload: turn,
            },
          ],
        });
        assert.equal(yield* orchestrator.promoteQueuedMessages(threadId, "wake"), 1);
        yield* worker.drain();
        assert.deepEqual(steered, ["notice"]);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("keeps a queued message queued when promoted into a run that Stop reached", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("steering-after-stop");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("queued"),
          threadId,
          messageId: MessageId.make("message:queued"),
          text: "queued",
          attachments: [],
          modelSelection: runSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const queuedRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued",
        )!;
        // The worker has not delivered the interrupt yet, so the run still reads as running.
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId: first.runId,
          holdQueue: true,
        });

        const promoteError = yield* orchestrator
          .dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make("promote"),
            threadId,
            queuedRunId: queuedRun.id,
            targetRunId: first.runId,
          })
          .pipe(Effect.flip);
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(promoteError._tag, "OrchestratorDispatchError");
        assert.deepEqual(steered, []);
        const queued = projection.runs.find((run) => run.id === queuedRun.id);
        assert.equal(queued?.status, "queued");
        assert.isTrue(queued?.queueHeld);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect.each(
  ([undefined, "auto", "steer", "restart"] as const).flatMap((deliveryIntent) =>
    (["web", "server"] as const).map((creationSource) => ({
      deliveryIntent,
      creationSource,
      label: deliveryIntent ?? "omitted",
    })),
  ),
)(
  "keeps active-only steering fixed after Stop ($label, $creationSource)",
  ({ deliveryIntent, creationSource }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, layer, startFirstTurn } =
          yield* nextTurnSelectionHarness("active-only-after-stop");
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("queued"),
            threadId,
            messageId: MessageId.make("message:queued"),
            text: "queued",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop"),
            threadId,
            runId: started[0]!.runId,
            holdQueue: true,
          });
          const result = yield* orchestrator
            .dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("strict"),
              threadId,
              messageId: MessageId.make("message:strict"),
              text: "active turn only",
              attachments: [],
              dispatchMode: {
                type: "steer_active",
                targetRunId: started[0]!.runId,
                activeTurnOnly: true,
              },
              ...(deliveryIntent === undefined ? {} : { deliveryIntent }),
              createdBy: creationSource === "web" ? "user" : "agent",
              creationSource,
            })
            .pipe(Effect.result);
          yield* worker.drain();

          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result))
            assert.equal(result.failure._tag, "OrchestratorDispatchError");
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, []);
          assert.equal(started.length, 1);
          assert.equal(projection.runs.length, 2);
          const queued = projection.runs.find((run) => run.status === "queued");
          assert.equal(queued?.userMessageId, MessageId.make("message:queued"));
          assert.isTrue(queued?.queueHeld);
          assert.isFalse(projection.messages.some((message) => message.id === "message:strict"));
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("queues a plain send behind the stopped queue and releases its hold", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("plain-send-after-stop");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const send = (id: string, delivery: "queue" | "auto") =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId,
            messageId: MessageId.make(`message:${id}`),
            text: id,
            attachments: [],
            modelSelection: runSelection,
            ...(delivery === "queue"
              ? { dispatchMode: { type: "queue_after_active" } }
              : { dispatchMode: { type: "start_immediately" }, deliveryIntent: "auto" }),
            createdBy: "user",
            creationSource: "web",
          });
        yield* send("queued", "queue");
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId: started[0]!.runId,
          holdQueue: true,
        });
        // The provider has not stopped yet, so a plain send still resolves to a steer.
        yield* send("sent", "auto");
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, []);
        assert.equal(started.length, 1);
        const queued = projection.runs
          .filter((run) => run.status === "queued")
          .sort((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0));
        assert.deepEqual(
          queued.map(
            (run) => projection.messages.find((message) => message.id === run.userMessageId)?.text,
          ),
          ["queued", "sent"],
        );
        // The user sent it, so the queue they stopped runs again once the provider stops.
        assert.isFalse(queued.some((run) => run.queueHeld === true));
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect.each(["auto", "steer"] as const)(
  "#1574 assignment stays queued after unrelated live input ($mode)",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { steered, layer, db, startFirstTurn } = yield* nextTurnSelectionHarness(
          `assignment-${mode}`,
        );
        const management = ThreadManagementService.layer.pipe(
          Layer.provideMerge(layer),
          Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(db))),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provideMerge(db),
        );
        const lifecycle = KanbanThreads.layer.pipe(
          Layer.provide(management),
          Layer.provide(db),
          Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        );
        yield* Effect.gen(function* () {
          const threadId = yield* startFirstTurn;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threads = yield* KanbanThreads.KanbanThreads;
          const before = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs[0]!;
          const reminder = yield* threads.send({
            threadId,
            text: "Old reminder",
            coalesce: "step:other",
            mode: "queue",
          });
          const assignment = yield* threads.send({
            threadId,
            text: "New assigned card",
            key: "assignment",
            coalesce: "assignment:card",
            mode: "queue",
          });
          if (typeof assignment !== "string") return yield* Effect.die("Assignment did not queue");
          yield* threads.send({
            threadId,
            text: "Unrelated live input",
            ...(mode === "steer" ? { mode: "steer" as const } : {}),
          });
          yield* worker.drain();
          const after = yield* orchestrator.getThreadRecords(threadId, ["runs", "turnItems"]);
          assert.equal(after.runs.find((run) => run.id === assignment)?.status, "queued");
          assert.equal(after.runs.find((run) => run.id === before.id)?.status, "running");
          assert.equal(
            after.runs.find((run) => run.id === before.id)?.activeAttemptId,
            before.activeAttemptId,
          );
          assert.deepEqual(steered, ["Unrelated live input"]);
          assert.isTrue(
            after.turnItems.some(
              (item) =>
                item.type === "user_message" &&
                item.text === "Unrelated live input" &&
                item.inputIntent === "steer",
            ),
          );
          assert.equal(after.runs.find((run) => run.id === reminder)?.status, "cancelled");
          assert.isTrue(yield* threads.cancelQueued(threadId, assignment));
          assert.equal(
            (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.find(
              (run) => run.id === assignment,
            )?.status,
            "cancelled",
          );
        }).pipe(Effect.provide(Layer.merge(layer, lifecycle)));
      }),
    ),
);

it.effect("#1561 intake survives provider completion after steer acceptance", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = "kanban-intake-steer-completion";
      const { events, started, steered, layer, db, startFirstTurn } =
        yield* nextTurnSelectionHarness(name);
      const measurements: AnalyticsEvent[] = [];
      const management = ThreadManagementService.layer.pipe(
        Layer.provideMerge(layer),
        Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(db))),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provideMerge(db),
      );
      const lifecycle = KanbanThreads.layer.pipe(
        Layer.provide(management),
        Layer.provide(db),
        Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
      );
      let requestThread: ThreadId | undefined;
      let evaluatorStarts = 0;
      const existingThread = Layer.effect(
        KanbanThreads.KanbanThreads,
        Effect.map(KanbanThreads.KanbanThreads, (real) =>
          KanbanThreads.KanbanThreads.of({
            ...real,
            launch: (input) =>
              Effect.gen(function* () {
                if (!requestThread)
                  return yield* Effect.die("Initial provider turn must be running");
                const threadId = requestThread;
                evaluatorStarts += 1;
                yield* input.onStarted?.(threadId) ?? Effect.void;
                return threadId;
              }),
          }),
        ),
      ).pipe(Layer.provide(lifecycle));
      const boardLayer = KanbanService.layer.pipe(
        Layer.provideMerge(existingThread),
        Layer.provideMerge(KanbanModels.layerTest(null)),
        Layer.provideMerge(KanbanStore.layer.pipe(Layer.provide(db))),
        Layer.provideMerge(db),
        Layer.provide(Layer.mock(TextGeneration.TextGeneration)({})),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(providerRegistryLayer([opencodeTestProvider()])),
        Layer.provide(
          Layer.mock(Analytics.Analytics)({
            record: (event) =>
              Effect.sync(() => {
                measurements.push(event);
              }),
          }),
        ),
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-intake-race-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
            Layer.provideMerge(ServerSettings.layerTest()),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        requestThread = yield* startFirstTurn;
        const kanban = yield* KanbanService.KanbanService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const board = yield* kanban.ensureBoard({
          slug: "intake-race",
          name: "Intake race",
          defaultProjectId: ProjectId.make(`project:${name}`),
        });
        const options = { callerThreadId: ThreadId.make("reporter") };
        const first = yield* kanban.submitEvaluator(
          board.id,
          { kind: "request", text: "First intake request" },
          options,
        );
        const second = yield* kanban.submitEvaluator(
          board.id,
          { kind: "request", text: "Second intake request" },
          options,
        );
        assert.deepEqual(second, first);
        assert.equal(evaluatorStarts, 1);
        assert.deepEqual(
          measurements
            .filter((event) => event.kind === "kanban.evaluator")
            .map((event) => event.outcome),
          ["started", "merged"],
        );
        // Dispatch accepted the intake, but its provider effect has not executed.
        const nativeFirst = started[0]!;
        const settled = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === nativeFirst.runId &&
              event.payload.status === "waiting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const turn = (yield* orchestrator.getThreadProjection(requestThread)).providerTurns[0]!;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: nativeFirst.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        assert.deepEqual(steered, []);
        assert.equal(started.length, 2);
        assert.include(started[1]!.message.text, "Second intake request");
        assert.include(started[1]!.message.text, "t3-thread://v1/reporter");
        assert.deepEqual(started[1]!.modelSelection, nativeFirst.modelSelection);
        const projection = yield* orchestrator.getThreadProjection(requestThread);
        assert.lengthOf(
          projection.messages.filter((message) => message.text.includes("Second intake request")),
          1,
        );
        const accepted = projection.messages.find((message) =>
          message.text.includes("Second intake request"),
        )!;
        const port = yield* KanbanThreads.KanbanThreads;
        assert.equal(yield* port.acceptedSend!(accepted.id.slice("kanban:".length)), requestThread);
        assert.deepEqual(
          yield* kanban.submitEvaluator(
            board.id,
            { kind: "request", text: "Second intake request" },
            options,
          ),
          second,
        );
        yield* worker.drain();
        assert.equal(evaluatorStarts, 1);
        assert.equal(started.length, 2);
        assert.equal(
          measurements.filter((event) => event.kind === "kanban.evaluator").at(-1)!.reuseMissReason,
          "duplicate",
        );
      }).pipe(Effect.provide(Layer.merge(layer, boardLayer)));
    }),
  ),
);

it.effect.each([
  { restart: false, correction: false, acceptance: "native" },
  { restart: true, correction: false, acceptance: "native" },
  { restart: false, correction: true, acceptance: "native" },
  { restart: false, correction: false, acceptance: "deferred" },
  { restart: false, correction: false, acceptance: "wrong-node" },
  { restart: false, correction: false, acceptance: "wrong-thread" },
  { restart: false, correction: false, acceptance: "wrong-node-restart" },
  { restart: false, correction: false, acceptance: "wrong-thread-restart" },
  { restart: false, correction: false, acceptance: "retry" },
  { restart: false, correction: false, acceptance: "projection-retry" },
  { restart: false, correction: false, acceptance: "commit-exhaustion" },
  { restart: false, correction: false, acceptance: "terminal-race" },
  { restart: false, correction: false, acceptance: "unaccepted-restart" },
  { restart: false, correction: false, acceptance: "failed-start" },
  { restart: false, correction: false, acceptance: "interrupted-start" },
])(
  "#1711 accepts a wake before later siblings finish (restart=$restart correction=$correction acceptance=$acceptance)",
  ({ restart, correction, acceptance }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `notice-1711-${restart}-${correction}-${acceptance}`,
          false,
          false,
          acceptance === "native",
        );
        const rows: AnalyticsEvent[] = [];
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const sink = yield* EventSink.EventSinkV2;
          const threadId = yield* startFirstTurn;
          const initial = yield* orchestrator.getThreadProjection(threadId);
          const source = initial.runs[0]!;
          const turn = initial.providerTurns[0]!;
          const now = yield* DateTime.now;
          const terminalAt = DateTime.subtract(now, { seconds: 12 });
          const ended = yield* sink
            .stream({ afterSequence: yield* sink.latestSequence(), eventType: "run.updated" })
            .pipe(
              Stream.filter(
                (e) =>
                  e.event.type === "run.updated" &&
                  e.event.payload.id === source.id &&
                  e.event.payload.status === "waiting",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...turn, status: "completed", completedAt: now },
          });
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: turn.providerThreadId,
            providerTurnId: turn.id,
            runOrdinal: 1,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Fiber.join(ended);
          yield* worker.drain();
          const firstMessageId = MessageId.make("message:1711-baseline");
          const names = ["Baseline", "Review", "Later failure"];
          const tasks: OrchestrationV2Subagent[] = names.map((title, i) => ({
            id: NodeId.make(`node:1711-${i}`),
            threadId,
            runId: source.id,
            parentNodeId: source.rootNodeId!,
            origin: "app_owned",
            createdBy: "agent",
            driver,
            providerInstanceId: instanceId,
            providerThreadId: null,
            childThreadId: ThreadId.make(`thread:1711-child-${i}`),
            nativeTaskRef: null,
            prompt: title,
            title,
            model: null,
            completionWake: "always",
            status: i === 0 ? "completed" : "running",
            result: i === 0 ? "Baseline completed" : null,
            startedAt: terminalAt,
            completedAt: i === 0 ? terminalAt : null,
            updatedAt: terminalAt,
            completionDelivery: { state: i === 0 ? "claimed" : "pending", observedByRunId: null },
            ...(correction && i === 1
              ? {
                  status: "completed" as const,
                  result: "Previous answer",
                  lastAnnouncedStatus: "completed" as const,
                  completionDelivery: { state: "delivered" as const, observedByRunId: null },
                }
              : {}),
          }));
          const latestSource = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (r) => r.id === source.id,
          )!;
          yield* sink.write({
            events: [
              {
                id: EventId.make("event:1711-cohort"),
                type: "run.updated",
                threadId,
                runId: source.id,
                occurredAt: now,
                payload: {
                  ...latestSource,
                  delegatedCompletion: {
                    disposition: "open",
                    nextGeneration: 2,
                    delivery: { generation: 1, messageId: firstMessageId, taskIds: [tasks[0]!.id] },
                  },
                },
              },
              ...tasks.map((task) => ({
                id: EventId.make(`event:${task.id}`),
                type: "subagent.updated" as const,
                threadId,
                runId: source.id,
                nodeId: task.id,
                occurredAt: now,
                payload: task,
              })),
            ],
          });
          for (const task of tasks) {
            yield* sink.write({
              events: [
                {
                  id: EventId.make(`event:1711-child-${task.id}`),
                  type: "thread.created",
                  threadId: task.childThreadId!,
                  occurredAt: now,
                  payload: {
                    ...initial.thread,
                    id: task.childThreadId!,
                    activeProviderThreadId: null,
                    lineage: {
                      parentThreadId: threadId,
                      relationshipToParent: "subagent",
                      rootThreadId: threadId,
                    },
                    forkedFrom: { type: "node", nodeId: task.id },
                  },
                },
              ],
            });
          }
          const dispatchDelivery = Effect.fn("test.dispatchNotice1711")(function* () {
            const projection = yield* orchestrator.getThreadProjection(threadId);
            const delivery = projection.runs.find((r) => r.id === source.id)!.delegatedCompletion!
              .delivery!;
            const ack = !projection.runs.some((r) => r.status === "running")
              ? yield* sink
                  .stream({
                    afterSequence: yield* sink.latestSequence(),
                    eventType: "provider-turn.updated",
                  })
                  .pipe(
                    Stream.filter(
                      (e) =>
                        e.event.type === "provider-turn.updated" &&
                        e.event.threadId === threadId &&
                        (acceptance === "native"
                          ? e.event.payload.promptAcceptedAt !== undefined
                          : e.event.payload.status === "running"),
                    ),
                    Stream.take(1),
                    Stream.runDrain,
                    Effect.forkScoped,
                  )
              : undefined;
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`command:1711-${delivery.generation}`),
              threadId,
              messageId: delivery.messageId,
              text: "Task completed",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "agent",
              creationSource: "server",
              delegatedCompletion: {
                parentRunId: source.id,
                generation: delivery.generation,
                taskIds: delivery.taskIds,
              },
            });
            yield* worker.drain();
            if (ack !== undefined) {
              yield* Fiber.join(ack);
              yield* worker.drain();
            }
          });
          yield* dispatchDelivery();
          if (acceptance !== "native") {
            const offered = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(
              offered.subagents.find((t) => t.id === tasks[0]!.id)?.completionDelivery?.state,
              "claimed",
            );
            assert.equal(rows.filter((row) => row.kind === "delegated.notice").length, 0);
            const wake = offered.runs.find((r) => r.userMessageId === firstMessageId)!;
            const nativeTurn = offered.providerTurns.find(
              (t) => t.runAttemptId === wake.activeAttemptId,
            )!;
            if (acceptance.startsWith("wrong-node") || acceptance.startsWith("wrong-thread")) {
              const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
              yield* ingestor.ingestNormalized({
                providerSessionId: offered.providerSessions[0]!.id,
                providerInstanceId: instanceId,
                threadId,
                runId: wake.id,
                nodeId: wake.rootNodeId!,
                event: {
                  type: "provider_turn.updated",
                  driver,
                  ...(acceptance.startsWith("wrong-thread")
                    ? { threadId: tasks[1]!.childThreadId! }
                    : {}),
                  providerTurn: {
                    ...nativeTurn,
                    id: ProviderTurnId.make("turn:foreign-ack"),
                    ...(acceptance.startsWith("wrong-node") ? { nodeId: tasks[1]!.id } : {}),
                    promptAcceptedAt: now,
                  },
                },
              });
              yield* worker.drain();
              const ignored = yield* orchestrator.getThreadProjection(threadId);
              assert.equal(
                ignored.subagents.find((t) => t.id === tasks[0]!.id)?.completionDelivery?.state,
                "claimed",
              );
              assert.equal(rows.filter((row) => row.kind === "delegated.notice").length, 0);
            }
            const cancelWake = sink.write({
              events: [
                {
                  id: EventId.make("event:1711-cancel-before-bookkeeping"),
                  type: "run.updated",
                  threadId,
                  runId: wake.id,
                  occurredAt: now,
                  payload: {
                    ...wake,
                    status:
                      acceptance === "failed-start"
                        ? "failed"
                        : acceptance === "interrupted-start"
                          ? "interrupted"
                          : "cancelled",
                    completedAt: now,
                  },
                },
              ],
            });
            if (
              acceptance.endsWith("-restart") ||
              acceptance === "failed-start" ||
              acceptance === "interrupted-start"
            ) {
              yield* cancelWake;
              yield* orchestrator.recoverDelegatedTasks;
              const recovered = yield* orchestrator.getThreadProjection(threadId);
              assert.notEqual(
                recovered.subagents.find((t) => t.id === tasks[0]!.id)?.completionDelivery?.state,
                "delivered",
              );
              assert.deepEqual(
                recovered.runs.find((r) => r.id === source.id)!.delegatedCompletion!.delivery!
                  .taskIds,
                [tasks[0]!.id],
              );
              assert.equal(rows.filter((row) => row.kind === "delegated.notice").length, 0);
              return;
            }
            const outbox = yield* EffectOutbox.EffectOutboxV2;
            if (acceptance === "deferred") {
              yield* outbox.enqueue([
                {
                  id: "effect:1711-unsettled-start",
                  commandId: CommandId.make("command:1711-unsettled-start"),
                  threadId,
                  request: { type: "provider-turn.start", runId: wake.id },
                },
              ]);
              yield* outbox.claimNext({
                workerId: "test-native-start",
                leaseDurationMs: 60000,
                onlyEffectTypes: ["provider-turn.start"],
              });
            }
            const persisted = yield* sink
              .stream({
                afterSequence: yield* sink.latestSequence(),
                eventType: "provider-turn.updated",
              })
              .pipe(
                Stream.filter(
                  (e) =>
                    e.event.type === "provider-turn.updated" &&
                    e.event.payload.id === nativeTurn.id &&
                    e.event.payload.promptAcceptedAt !== undefined,
                ),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: { ...nativeTurn, promptAcceptedAt: now },
            });
            yield* Fiber.join(persisted);
            if (acceptance === "terminal-race") {
              yield* cancelWake;
              yield* orchestrator.recoverDelegatedTasks;
            }
            if (acceptance === "retry") {
              const threads = yield* ThreadManagementService.ThreadManagementService;
              const fault = vi.spyOn(threads, "dispatch").mockImplementationOnce((command) =>
                Effect.fail(
                  new Orchestrator.OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause: "acceptance persistence unavailable once",
                  }),
                ),
              );
              yield* worker.drain();
              fault.mockRestore();
              const waiting = yield* orchestrator.getThreadProjection(threadId);
              assert.equal(
                waiting.subagents.find((t) => t.id === tasks[0]!.id)?.completionDelivery?.state,
                "claimed",
              );
              assert.equal(started.length, 2);
              const effects = yield* outbox.listByCommandId(
                CommandId.make(`command:notice-native-accepted:${threadId}:${firstMessageId}`),
              );
              assert.equal(
                effects.find((e) => e.request.type === "notification.delivery.accept")?.status,
                "pending",
              );
              yield* TestClock.adjust(100);
            }
            if (acceptance === "projection-retry" || acceptance === "commit-exhaustion") {
              const projections = yield* ProjectionStore.ProjectionStoreV2;
              const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
              const getRecords = projections.getThreadRecords;
              const commit = sink.commitCommand;
              const commandId = CommandId.make(
                `command:notice-native-accepted:${threadId}:${firstMessageId}`,
              );
              const failureCount = acceptance === "projection-retry" ? 1 : 6;
              let failures = 0;
              const fault =
                acceptance === "projection-retry"
                  ? vi
                      .spyOn(projections, "getThreadRecords")
                      .mockImplementation((id, fields, filter) => {
                        if (id === threadId && filter?.omitSettledLeafNodes && failures++ === 0)
                          return Effect.fail(
                            new ProjectionStore.ProjectionStoreReadError({
                              threadId,
                              cause: new Error("Database reader retired"),
                            }),
                          );
                        return getRecords(id, fields, filter);
                      })
                  : vi.spyOn(sink, "commitCommand").mockImplementation((input) => {
                      if (
                        input.commandType === "notification.delivery.accept" &&
                        failures++ < failureCount
                      )
                        return Effect.fail(
                          new EventSink.EventSinkWriteError({
                            eventCount: input.events.length,
                            cause: new Error("acceptance transaction unavailable"),
                          }),
                        );
                      return commit(input);
                    });
              for (let attempt = 1; attempt <= failureCount; attempt++) {
                yield* worker.drain();
                const pending = yield* outbox.listByCommandId(commandId);
                assert.equal(pending[0]?.status, "pending");
                assert.equal(pending[0]?.attemptCount, attempt);
                assert.isTrue(Option.isNone(yield* receipts.getByCommandId(commandId)));
                assert.equal(started.length, 2);
                yield* TestClock.adjust(100 * 2 ** (attempt - 1));
              }
              fault.mockRestore();
            }
            yield* worker.drain();
            if (acceptance === "deferred")
              yield* outbox.succeed({
                effectId: "effect:1711-unsettled-start",
                workerId: "test-native-start",
              });
          }
          const accepted = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(
            accepted.subagents.find((t) => t.id === tasks[0]!.id)?.completionDelivery?.state,
            "delivered",
          );
          assert.isNull(
            accepted.runs.find((r) => r.id === source.id)!.delegatedCompletion!.delivery,
          );
          assert.equal(started.length, 2);
          if (acceptance === "terminal-race") {
            assert.equal(rows.filter((row) => row.kind === "delegated.notice").length, 1);
            return;
          }
          yield* orchestrator.dispatch({
            type: "notification.delivery.accept",
            commandId: CommandId.make("command:1711-repeat-accept"),
            threadId,
            messageId: firstMessageId,
          });
          const baseline = tasks[0]!;
          const baselineReconciled = yield* sink
            .stream({
              afterSequence: yield* sink.latestSequence(),
              eventType: "context-transfer.created",
            })
            .pipe(
              Stream.filter(
                (e) =>
                  e.event.type === "context-transfer.created" &&
                  e.event.payload.sourceThreadId === baseline.childThreadId,
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
          yield* sink.write({
            events: [
              {
                id: EventId.make("event:1711-baseline-child"),
                type: "run.updated",
                threadId: baseline.childThreadId!,
                occurredAt: now,
                payload: {
                  ...source,
                  id: RunId.make("run:1711-baseline"),
                  threadId: baseline.childThreadId!,
                  providerThreadId: null,
                  activeAttemptId: null,
                  delegatedTaskId: baseline.id,
                  status: "completed",
                  completedAt: terminalAt,
                },
              },
            ],
          });
          yield* Fiber.join(baselineReconciled);
          if (restart) {
            const wake = accepted.runs.find((r) => r.userMessageId === firstMessageId)!;
            yield* sink.write({
              events: [
                {
                  id: EventId.make("event:1711-restart"),
                  type: "run.updated",
                  threadId,
                  runId: wake.id,
                  occurredAt: now,
                  payload: { ...wake, status: "cancelled", completedAt: now },
                },
              ],
            });
            yield* orchestrator.recoverDelegatedTasks;
          }
          for (const task of tasks.slice(1)) {
            const finished = yield* sink
              .stream({
                afterSequence: yield* sink.latestSequence(),
                eventType: "subagent.updated",
              })
              .pipe(
                Stream.filter(
                  (e) =>
                    e.event.type === "subagent.updated" &&
                    e.event.payload.id === task.id &&
                    e.event.payload.status === "failed",
                ),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
            const childRunId = RunId.make(`run:1711-child-${task.id}`);
            yield* sink.write({
              events: [
                {
                  id: EventId.make(`event:1711-terminal-${task.id}`),
                  type: "run.updated",
                  threadId: task.childThreadId!,
                  runId: childRunId,
                  occurredAt: now,
                  payload: {
                    ...source,
                    id: childRunId,
                    threadId: task.childThreadId!,
                    providerThreadId: null,
                    activeAttemptId: null,
                    delegatedTaskId: task.id,
                    status: "failed",
                    completedAt: terminalAt,
                    delegatedTaskStall: {
                      idleTimeoutMs: 900000,
                      lastProgressAt: terminalAt,
                      lastProgressKind: "tool_call",
                    },
                  },
                },
              ],
            });
            yield* Fiber.join(finished);
            const ready = yield* orchestrator.getThreadProjection(threadId);
            assert.deepEqual(
              ready.runs.find((r) => r.id === source.id)!.delegatedCompletion!.delivery!.taskIds,
              [task.id],
            );
            yield* dispatchDelivery();
          }
          const final = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(final.subagents.find((t) => t.id === tasks[0]!.id)?.status, "completed");
          const notices = final.turnItems.filter(
            (i) => i.type === "notification" && i.source.kind === "delegated_task",
          );
          assert.equal(notices.length, 3);
          for (const [i, title] of names.entries()) {
            const notice = notices.find(
              (n) =>
                n.type === "notification" &&
                n.source.kind === "delegated_task" &&
                n.source.taskIds.includes(tasks[i]!.id),
            );
            assert.equal(
              notice?.type === "notification" ? notice.summary : null,
              `Delegated task "${title}" ${correction && i === 1 ? "previously finished, now failed: stalled" : i === 0 ? "finished" : "failed"}`,
            );
          }
          if (!restart && acceptance !== "terminal-race") assert.equal(steered.length, 2);
          const announcements = rows.filter((row) => row.kind === "delegated.notice");
          assert.equal(announcements.length, 3);
          for (const row of announcements) {
            assert.deepInclude(row, { parentThreadId: threadId, parentRunId: source.id });
            assert.equal(
              row.children?.[0]?.delayMs,
              acceptance === "commit-exhaustion"
                ? 18300
                : acceptance === "retry" || acceptance === "projection-retry"
                  ? 12100
                  : 12000,
            );
          }
          const changes = rows.filter((row) => row.kind === "delegated.terminal-status-changed");
          assert.equal(changes.length, correction ? 1 : 0);
          if (correction)
            assert.deepInclude(changes[0], {
              taskId: tasks[1]!.id,
              oldStatus: "completed",
              newStatus: "failed",
              reason: "stalled_child_terminal_reconciled",
            });
        }).pipe(
          Effect.provide(
            layer.pipe(
              Layer.provide(
                Layer.succeed(Analytics.Analytics, {
                  record: (event) =>
                    Effect.sync(() => {
                      rows.push(event);
                    }),
                  flush: Effect.void,
                  ingest: () => Effect.void,
                  read: () => Effect.die("unused"),
                }),
              ),
            ),
          ),
        );
      }),
    ),
);
