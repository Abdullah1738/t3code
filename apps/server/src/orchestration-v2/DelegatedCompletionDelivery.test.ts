import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { continueRestartedRun } from "./RestartContinuation.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-delegated-completion-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const layerVcsDriverRegistryTest = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(layerVcsDriverRegistryTest),
);

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by delegated completion tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerTestProviderInstanceRegistry = Layer.succeed(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  {
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
    listInstances: Effect.succeed([providerInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  },
);

const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  EffectOutbox.layer,
  ProjectionStore.layer,
).pipe(
  Layer.provideMerge(RuntimeLayer.layerProjectService),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerPlatformTest),
);

const seedParentWithTerminalTask = (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly taskId: NodeId;
  readonly deliveryState: "delivered" | "claimed" | "acknowledged" | "disposed";
  readonly completionWake?: "always" | "settled_only";
  readonly deliveryTaskIds?: ReadonlyArray<NodeId>;
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const providerThreadId = ProviderThreadId.make(
      `provider-thread:${String(input.threadId).replace("thread:", "")}`,
    );

    yield* projects.create({
      commandId: CommandId.make(`command:seed-project:${input.threadId}`),
      projectId: input.projectId,
      title: "Delegated completion delivery",
      workspaceRoot: `/workspace/${input.projectId}`,
    });

    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:seed-create:${input.threadId}`),
      threadId: input.threadId,
      projectId: input.projectId,
      title: "Delegated completion delivery",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });

    yield* eventSink.write({
      commandId: CommandId.make(`command:seed-projection:${input.threadId}`),
      events: [
        {
          id: EventId.make(`event:seed-provider-thread:${input.threadId}`),
          type: "provider-thread.updated",
          threadId: input.threadId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: input.threadId,
            ownerNodeId: input.rootNodeId,
            nativeThreadRef: {
              driver,
              nativeId: `native:${input.threadId}`,
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: input.now,
            updatedAt: input.now,
          },
        },
        {
          id: EventId.make(`event:seed-run:${input.threadId}`),
          type: "run.updated",
          threadId: input.threadId,
          runId: input.runId,
          nodeId: input.rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: input.runId,
            threadId: input.threadId,
            ordinal: 1,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`message:seed-user:${input.threadId}`),
            rootNodeId: input.rootNodeId,
            activeAttemptId: null,
            status: "running",
            requestedAt: input.now,
            startedAt: input.now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
            delegatedCompletion: {
              disposition: "open",
              nextGeneration: 2,
              delivery:
                input.deliveryTaskIds === undefined
                  ? null
                  : {
                      generation: 1,
                      messageId: MessageId.make(`message:delegated-delivery:${input.threadId}`),
                      taskIds: input.deliveryTaskIds,
                    },
            },
          },
        },
        {
          id: EventId.make(`event:seed-task:${input.threadId}`),
          type: "subagent.updated",
          threadId: input.threadId,
          runId: input.runId,
          nodeId: input.taskId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: input.taskId,
            threadId: input.threadId,
            runId: input.runId,
            parentNodeId: input.rootNodeId,
            origin: "app_owned",
            createdBy: "agent",
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerThreadId: null,
            childThreadId: null,
            nativeTaskRef: null,
            prompt: "Inspect the delivered ownership edge.",
            title: null,
            model: null,
            completionWake: input.completionWake ?? "settled_only",
            completionDelivery: {
              state: input.deliveryState,
              observedByRunId: input.deliveryState === "acknowledged" ? input.runId : null,
            },
            status: "completed",
            result: "child finished",
            startedAt: input.now,
            completedAt: input.now,
            updatedAt: input.now,
          },
        },
      ],
    });
  });

it.layer(layerTest)("delegated completion delivery repairs", (it) => {
  const queuedCompletion = Effect.fn("test.queuedCompletion")(function* (
    name: string,
    delegated = false,
  ) {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make(`thread:${name}`);
    const runId = RunId.make(`run:${name}`);
    const taskId = NodeId.make(`task:${name}`);
    yield* seedParentWithTerminalTask({
      threadId,
      projectId: ProjectId.make(`project:${name}`),
      runId,
      rootNodeId: NodeId.make(`root:${name}`),
      taskId,
      deliveryState: "claimed",
      deliveryTaskIds: [taskId],
      completionWake: "always",
      now,
    });
    const parent = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    if (delegated)
      yield* sink.write({
        events: [
          {
            id: EventId.make(`event:${name}:delegated`),
            type: "run.updated",
            threadId,
            runId,
            occurredAt: now,
            payload: { ...parent, delegatedTaskId: NodeId.make(`outer-task:${name}`) },
          },
        ],
      });
    const delivery = parent.delegatedCompletion!.delivery!;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "agent",
      creationSource: "server",
      commandId: CommandId.make(`command:${name}:delivery`),
      threadId,
      messageId: delivery.messageId,
      text: "Delegated task completed",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "queue_after_active" },
      delegatedCompletion: {
        parentRunId: runId,
        generation: delivery.generation,
        taskIds: delivery.taskIds,
      },
    });
    const notification = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
      (run) => run.userMessageId === delivery.messageId,
    )!;
    assert.equal(notification.status, "queued");
    return { threadId, runId, taskId, deliveryRunId: notification.id, now };
  });

  it.effect.each(["acknowledge", "dispose"] as const)(
    "records the source when %s removes the last queued task result",
    (operation) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const { threadId, runId, taskId, deliveryRunId } = yield* queuedCompletion(
          `resolution-${operation}`,
        );
        yield* orchestrator.dispatch(
          operation === "acknowledge"
            ? {
                type: "delegated_task.completion-delivery.acknowledge",
                commandId: CommandId.make(`command:${operation}:result`),
                parentThreadId: threadId,
                taskId,
                observedByRunId: runId,
              }
            : {
                type: "delegated_task.completion-delivery.dispose",
                commandId: CommandId.make(`command:${operation}:result`),
                parentThreadId: threadId,
                taskId,
              },
        );
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const delivery = projection.runs.find((run) => run.id === deliveryRunId)!;
        assert.equal(delivery.status, "cancelled");
        assert.equal(
          delivery.cancelReason,
          operation === "acknowledge" ? "superseded" : "task_cancel",
        );
        assert.equal(projection.subagents.find((task) => task.id === taskId)?.status, "completed");
        assert.equal(
          projection.subagents.find((task) => task.id === taskId)?.result,
          "child finished",
        );
        assert.equal(projection.runs.find((run) => run.id === runId)?.status, "running");
      }),
  );

  it.effect.each(
    (
      [
        undefined,
        "user_stop",
        "task_cancel",
        "thread_reset",
        "card_stop",
        "delegated_parent_cancelled",
        "superseded",
        "task_stalled",
      ] as const
    ).flatMap((cancelReason) => [false, true].map((holdQueue) => ({ cancelReason, holdQueue }))),
  )(
    "stalled delegated cleanup preserves $cancelReason on its queued delivery (holdQueue=$holdQueue)",
    ({ cancelReason, holdQueue }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const { threadId, runId, deliveryRunId, now } = yield* queuedCompletion(
          `stall-${cancelReason ?? "inferred"}-${holdQueue}`,
          true,
        );
        yield* TestClock.adjust("1 minute");
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`command:${threadId}:stall`),
          threadId,
          runId,
          fenced: true,
          holdQueue,
          ...(cancelReason === undefined ? {} : { cancelReason }),
          delegatedTaskStall: {
            idleTimeoutMs: 60_000,
            lastProgressAt: now,
            lastProgressKind: "run_started",
          },
        });
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const delivery = projection.runs.find((run) => run.id === deliveryRunId)!;
        assert.equal(delivery.status, "cancelled");
        assert.equal(delivery.cancelReason, cancelReason ?? "task_stalled");
        assert.equal(projection.runs.find((run) => run.id === runId)?.status, "interrupted");
        assert.equal(
          projection.runs.find((run) => run.id === runId)?.cancelReason,
          cancelReason ?? "task_stalled",
        );
      }),
  );

  it.effect(
    "does not redeliver an acknowledged child after a steer and a late lifecycle write",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("steer-once-parent");
        const runId = RunId.make("steer-once-parent");
        const attemptId = RunAttemptId.make("steer-once-attempt");
        const taskId = NodeId.make("steer-once-child");
        const rootNodeId = NodeId.make("steer-once-root");
        const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
        yield* seedParentWithTerminalTask({
          threadId,
          runId,
          taskId,
          rootNodeId,
          projectId: ProjectId.make("steer-once-project"),
          deliveryState: "claimed",
          completionWake: "always",
          deliveryTaskIds: [taskId],
          now,
        });
        const seed = yield* orchestrator.getThreadProjection(threadId);
        const providerThread = seed.providerThreads[0]!;
        yield* sink.write({
          events: [
            {
              id: EventId.make("steer-once-attempt"),
              type: "run.updated",
              threadId,
              runId,
              occurredAt: now,
              payload: { ...seed.runs[0]!, activeAttemptId: attemptId },
            },
            {
              id: EventId.make("steer-once-session"),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...providerThread,
                providerSessionId: ProviderSessionId.make("steer-once-session"),
              },
            },
            {
              id: EventId.make("steer-once-turn"),
              type: "provider-turn.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: ProviderTurnId.make("steer-once-turn"),
                providerThreadId: providerThread.id,
                nodeId: rootNodeId,
                runAttemptId: attemptId,
                nativeTurnRef: null,
                ordinal: 1,
                status: "running",
                startedAt: now,
                completedAt: null,
              },
            },
          ],
        });
        const completion = {
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "server",
          commandId: CommandId.make("steer-once-queue"),
          threadId,
          messageId,
          text: "Background task finished",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
          delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
        } as const;
        yield* orchestrator.dispatch(completion);
        const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === messageId,
        )!;
        assert.equal(queued.status, "queued");
        const lookup = vi.spyOn(sessions, "get").mockReturnValue(
          Effect.succeed(
            Option.some({
              providerSession: { capabilities: CodexProviderCapabilitiesV2 },
            } as ProviderAdapter.ProviderAdapterV2SessionRuntime),
          ),
        );
        try {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("steer-once-user"),
            threadId,
            messageId: MessageId.make("steer-once-user"),
            text: "Continue with the result",
            attachments: [],
            modelSelection,
            dispatchMode: { type: "steer_active", targetRunId: runId },
          });
        } finally {
          lookup.mockRestore();
        }
        const captured = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.id === runId,
        )!;
        const acknowledgement = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("steer-once-observed"),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });
        assert.isTrue(
          acknowledgement.storedEvents.some(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === runId &&
              stored.event.payload.delegatedCompletion?.delivery === null,
          ),
        );
        assert.isTrue(
          acknowledgement.storedEvents.some(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === queued.id &&
              stored.event.payload.status === "cancelled",
          ),
        );
        const lateWrite = yield* sink.writeIfRunCurrent({
          threadId,
          runId,
          activeAttemptId: attemptId,
          expectedStatus: "running",
          events: [
            {
              id: EventId.make("steer-once-late-start"),
              type: "run.updated",
              threadId,
              runId,
              occurredAt: now,
              payload: captured,
            },
          ],
        });
        assert.isTrue(lateWrite.committed);
        yield* orchestrator.resumeQueuedRuns;
        const final = yield* orchestrator.getThreadSnapshot(threadId);
        assert.isNull(
          final.projection.runs.find((run) => run.id === runId)?.delegatedCompletion?.delivery,
        );
        assert.equal(
          final.projection.runs.find((run) => run.id === queued.id)?.status,
          "cancelled",
        );
        assert.deepEqual(final.projection.subagents[0]?.completionDelivery, {
          state: "acknowledged",
          observedByRunId: runId,
        });
        assert.equal(final.projection.subagents[0]?.result, "child finished");
        const replay = yield* orchestrator
          .dispatch({
            ...completion,
            commandId: CommandId.make("steer-once-replay"),
            messageId: MessageId.make("steer-once-replay"),
          })
          .pipe(Effect.flip);
        assert.equal(replay._tag, "OrchestratorDispatchError");
        assert.equal((yield* orchestrator.getThreadSnapshot(threadId)).projection.runs.length, 2);
      }),
  );

  it.effect(
    "interrupting a completion wake disposes both cohorts without reviving them on late results",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("stop-wake-parent");
        const originRunId = RunId.make("stop-wake-origin");
        const incomingTaskId = NodeId.make("stop-wake-incoming");
        yield* seedParentWithTerminalTask({
          threadId,
          projectId: ProjectId.make("stop-wake-project"),
          runId: originRunId,
          rootNodeId: NodeId.make("stop-wake-origin-root"),
          taskId: incomingTaskId,
          deliveryState: "claimed",
          deliveryTaskIds: [incomingTaskId],
          completionWake: "always",
          now,
        });
        const origin = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        yield* sink.write({
          events: [
            {
              ...runEvent({ threadId, runId: originRunId, ordinal: 1, status: "completed", now }),
              payload: { ...origin, status: "completed", completedAt: now },
            },
          ],
        });
        const delivery = origin.delegatedCompletion!.delivery!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "server",
          commandId: CommandId.make("stop-wake-start"),
          threadId,
          messageId: delivery.messageId,
          text: "Delegated task completed",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
          delegatedCompletion: {
            parentRunId: originRunId,
            generation: delivery.generation,
            taskIds: delivery.taskIds,
          },
        });
        yield* orchestrator.resumeQueuedRuns;
        const wake = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === delivery.messageId,
        )!;
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: CommandId.make("stop-wake-delegate"),
          parentThreadId: threadId,
          parentRunId: wake.id,
          parentNodeId: wake.rootNodeId!,
          task: "Do the next round",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
        });
        const delegated = (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
          (task) => task.runId === wake.id,
        )!;
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop-wake-interrupt"),
          threadId,
          runId: wake.id,
        });
        const stopped = yield* orchestrator.getThreadProjection(threadId);
        for (const runId of [originRunId, wake.id]) {
          const run = stopped.runs.find((row) => row.id === runId)!;
          assert.equal(run.delegatedCompletion?.disposition, "stopped");
          assert.isNull(run.delegatedCompletion?.delivery);
        }
        assert.equal(stopped.runs.find((run) => run.id === wake.id)?.status, "interrupted");
        for (const taskId of [incomingTaskId, delegated.id]) {
          assert.equal(
            stopped.subagents.find((task) => task.id === taskId)?.completionDelivery?.state,
            "disposed",
          );
        }
        assert.equal(
          stopped.subagents.find((task) => task.id === incomingTaskId)?.result,
          "child finished",
        );

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("stop-wake-newer-work"),
          threadId,
          messageId: MessageId.make("stop-wake-newer-work"),
          text: "Start unrelated work",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
        });
        yield* orchestrator.resumeQueuedRuns;
        const newer = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(newer.runs.at(-1)?.status, "starting");

        const childThreadId = delegated.childThreadId!;
        const childRun = (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]!;
        const afterSequence = yield* sink.latestSequence();
        yield* sink.write({
          events: [
            {
              ...runEvent({
                threadId: childThreadId,
                runId: childRun.id,
                ordinal: childRun.ordinal,
                status: "completed",
                now,
              }),
              payload: { ...childRun, status: "completed", completedAt: now },
            },
          ],
        });
        yield* sink.stream({ afterSequence, eventType: "subagent.updated" }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.id === delegated.id &&
              stored.event.payload.status === "completed",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        const finished = yield* orchestrator.getThreadProjection(threadId);
        const lateTask = finished.subagents.find((task) => task.id === delegated.id)!;
        assert.equal(lateTask.status, "completed");
        assert.isNotNull(lateTask.result);
        assert.equal(lateTask.completionDelivery?.state, "disposed");
        assert.deepEqual(finished.runs, newer.runs);
        assert.deepEqual(finished.messages, newer.messages);
      }),
  );

  it.effect("acceptance batches pending siblings without acknowledging their results", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("mailbox-batch");
      const runId = RunId.make("mailbox-parent");
      const taskId = NodeId.make("mailbox-first");
      const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
      yield* seedParentWithTerminalTask({
        threadId,
        runId,
        projectId: ProjectId.make("mailbox-project"),
        rootNodeId: NodeId.make("mailbox-root"),
        taskId,
        deliveryState: "claimed",
        completionWake: "always",
        deliveryTaskIds: [taskId],
        now,
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const task = projection.subagents[0]!;
      const pendingIds = [NodeId.make("mailbox-second"), NodeId.make("mailbox-third")];
      yield* sink.write({
        events: [
          {
            id: EventId.make("mailbox-message"),
            type: "message.updated",
            threadId,
            runId,
            occurredAt: now,
            payload: {
              id: messageId,
              threadId,
              runId,
              nodeId: task.parentNodeId,
              role: "user",
              text: "Background task finished",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "server",
              createdAt: now,
              updatedAt: now,
              delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
            },
          },
          ...pendingIds.map((id) => ({
            id: EventId.make(`event:${id}`),
            type: "subagent.updated" as const,
            threadId,
            runId,
            nodeId: id,
            occurredAt: now,
            payload: {
              ...task,
              id,
              completionDelivery: { state: "pending" as const, observedByRunId: null },
            },
          })),
        ],
      });
      yield* orchestrator.dispatch({
        type: "notification.delivery.accept",
        commandId: CommandId.make("accept-first"),
        threadId,
        messageId,
      });
      const accepted = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        accepted.subagents.find((row) => row.id === taskId)?.completionDelivery?.state,
        "delivered",
      );
      const cohort = accepted.runs.find((row) => row.id === runId)?.delegatedCompletion;
      assert.deepEqual(cohort?.delivery?.taskIds, pendingIds);
      assert.equal(cohort?.delivery?.generation, 2);
      for (const id of pendingIds) {
        assert.deepEqual(accepted.subagents.find((row) => row.id === id)?.completionDelivery, {
          state: "claimed",
          observedByRunId: null,
        });
      }
      yield* orchestrator.dispatch({
        type: "notification.delivery.accept",
        commandId: CommandId.make("repeat-old-acceptance"),
        threadId,
        messageId,
      });
      const duplicate = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(duplicate.runs.find((row) => row.id === runId)?.delegatedCompletion, cohort);
    }),
  );

  it.effect("acceptance batches a settled_only sibling once its spawning run ended", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("mailbox-mixed");
      const runId = RunId.make("mailbox-mixed-parent");
      const taskId = NodeId.make("mailbox-mixed-always");
      const siblingId = NodeId.make("mailbox-mixed-settled-only");
      const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
      yield* seedParentWithTerminalTask({
        threadId,
        runId,
        projectId: ProjectId.make("mailbox-mixed-project"),
        rootNodeId: NodeId.make("mailbox-mixed-root"),
        taskId,
        deliveryState: "claimed",
        completionWake: "always",
        deliveryTaskIds: [taskId],
        now,
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const task = projection.subagents[0]!;
      const spawningRun = projection.runs.find((row) => row.id === runId)!;
      yield* sink.write({
        events: [
          {
            ...runEvent({ threadId, runId, ordinal: 1, status: "cancelled", now }),
            payload: { ...spawningRun, status: "cancelled" as const, completedAt: now },
          },
          runEvent({
            threadId,
            runId: RunId.make("mailbox-mixed-continuation"),
            ordinal: 2,
            status: "running",
            now,
          }),
          {
            id: EventId.make("mailbox-mixed-message"),
            type: "message.updated",
            threadId,
            runId,
            occurredAt: now,
            payload: {
              id: messageId,
              threadId,
              runId,
              nodeId: task.parentNodeId,
              role: "user",
              text: "Background task finished",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "server",
              createdAt: now,
              updatedAt: now,
              delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
            },
          },
          {
            id: EventId.make(`event:${siblingId}`),
            type: "subagent.updated" as const,
            threadId,
            runId,
            nodeId: siblingId,
            occurredAt: now,
            payload: {
              ...task,
              id: siblingId,
              completionWake: "settled_only" as const,
              completionDelivery: { state: "pending" as const, observedByRunId: null },
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "notification.delivery.accept",
        commandId: CommandId.make("accept-mixed"),
        threadId,
        messageId,
      });
      const accepted = yield* orchestrator.getThreadProjection(threadId);
      const cohort = accepted.runs.find((row) => row.id === runId)?.delegatedCompletion;
      assert.deepEqual(cohort?.delivery?.taskIds, [siblingId]);
      assert.equal(
        accepted.subagents.find((row) => row.id === siblingId)?.completionDelivery?.state,
        "claimed",
      );
    }),
  );

  it.effect("builds completion text and metadata from the same live cohort", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:delegated-delivery-live-cohort");
      const projectId = ProjectId.make("project:delegated-delivery-live-cohort");
      const runId = RunId.make("run:delegated-delivery-live-cohort");
      const rootNodeId = NodeId.make("node:delegated-delivery-live-cohort-root");
      const firstTaskId = NodeId.make("node:delegated-delivery-live-cohort-first");
      const secondTaskId = NodeId.make("node:delegated-delivery-live-cohort-second");
      const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);

      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: firstTaskId,
        deliveryState: "claimed",
        completionWake: "always",
        deliveryTaskIds: [firstTaskId, secondTaskId],
        now,
      });

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:delegated-delivery-live-cohort"),
        threadId,
        messageId,
        text: `Delegated task ${firstTaskId} reached a terminal state.`,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
        delegatedCompletion: {
          parentRunId: runId,
          generation: 1,
          taskIds: [firstTaskId],
        },
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);
      const message = projection.messages.find((candidate) => candidate.id === messageId);
      assert.deepEqual(message?.delegatedCompletion?.taskIds, [firstTaskId, secondTaskId]);
      assert.include(message?.text ?? "", String(firstTaskId));
      assert.include(message?.text ?? "", String(secondTaskId));
      assert.include(message?.text ?? "", "task_status");
      assert.include(message?.text ?? "", "child finished");
    }),
  );

  it.effect.each([
    {
      name: "oversized UTF-8 result",
      first: "界".repeat(6_000),
      second: "small result",
      inlineFirst: false,
      inlineSecond: true,
    },
    {
      name: "combined results",
      first: "a".repeat(10_000),
      second: "b".repeat(10_000),
      inlineFirst: true,
      inlineSecond: false,
    },
  ])("uses task_status for $name beyond the inline budget", (testCase) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make(`thread:inline-budget:${testCase.name}`);
      const runId = RunId.make(`run:inline-budget:${testCase.name}`);
      const firstTaskId = NodeId.make(`node:inline-first:${testCase.name}`);
      const secondTaskId = NodeId.make(`node:inline-second:${testCase.name}`);
      const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
      yield* seedParentWithTerminalTask({
        threadId,
        projectId: ProjectId.make(`project:inline-budget:${testCase.name}`),
        runId,
        rootNodeId: NodeId.make(`node:inline-budget:${testCase.name}`),
        taskId: firstTaskId,
        deliveryState: "claimed",
        completionWake: "always",
        deliveryTaskIds: [firstTaskId, secondTaskId],
        now,
      });
      const parent = yield* orchestrator.getThreadProjection(threadId);
      const task = parent.subagents[0]!;
      yield* sink.write({
        events: [
          { id: firstTaskId, result: testCase.first, status: "failed" as const },
          { id: secondTaskId, result: testCase.second, status: "cancelled" as const },
        ].map(({ id, result, status }) => ({
          id: EventId.make(`event:inline-budget:${id}`),
          type: "subagent.updated" as const,
          threadId,
          runId,
          nodeId: id,
          occurredAt: now,
          payload: { ...task, id, result, status, title: "Inspect regression" },
        })),
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:inline-budget:${testCase.name}`),
        threadId,
        messageId,
        text: "Delegated tasks completed.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
        delegatedCompletion: {
          parentRunId: runId,
          generation: 1,
          taskIds: [firstTaskId, secondTaskId],
        },
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const message = projection.messages.find((candidate) => candidate.id === messageId)!;
      assert.equal(message.text.includes(testCase.first), testCase.inlineFirst);
      assert.equal(message.text.includes(testCase.second), testCase.inlineSecond);
      const deferredTaskId = testCase.inlineFirst ? secondTaskId : firstTaskId;
      assert.include(
        message.text,
        `Delegated task ${deferredTaskId} (Inspect regression) [${testCase.inlineFirst ? "cancelled" : "failed"}]`,
      );
      assert.include(message.text, `Use task_status with taskId ${deferredTaskId}`);
      assert.deepEqual(message.delegatedCompletion?.taskIds, [firstTaskId, secondTaskId]);
      assert.equal(
        projection.subagents.find((candidate) => candidate.id === deferredTaskId)?.result,
        testCase.inlineFirst ? testCase.second : testCase.first,
      );
    }),
  );

  it.effect("does not re-offer when wake-policy upgrades after delivered ownership settled", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:delegated-delivery-a1");
      const projectId = ProjectId.make("project:delegated-delivery-a1");
      const runId = RunId.make("run:delegated-delivery-a1");
      const rootNodeId = NodeId.make("node:delegated-delivery-a1-root");
      const taskId = NodeId.make("node:delegated-delivery-a1-task");

      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId,
        deliveryState: "delivered",
        completionWake: "settled_only",
        now,
      });

      const upgrade = yield* orchestrator.dispatch({
        type: "delegated_task.wake-policy",
        commandId: CommandId.make("command:delegated-delivery-a1:wake-policy"),
        parentThreadId: threadId,
        taskId,
        completionWake: "always",
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);
      const task = projection.subagents.find((candidate) => candidate.id === taskId);
      const parentRun = projection.runs.find((candidate) => candidate.id === runId);

      assert.equal(task?.completionWake, "always");
      assert.deepEqual(task?.completionDelivery, {
        state: "delivered",
        observedByRunId: null,
      });
      assert.deepEqual(parentRun?.delegatedCompletion, {
        disposition: "open",
        nextGeneration: 2,
        delivery: null,
      });
      assert.isFalse(
        upgrade.storedEvents.some(
          (stored) =>
            stored.event.type === "subagent.updated" &&
            stored.event.payload.id === taskId &&
            stored.event.payload.completionDelivery?.state === "claimed",
        ),
      );
      assert.isFalse(
        upgrade.storedEvents.some(
          (stored) =>
            stored.event.type === "run.updated" &&
            stored.event.payload.id === runId &&
            stored.event.payload.delegatedCompletion?.delivery !== null &&
            stored.event.payload.delegatedCompletion?.delivery !== undefined,
        ),
      );
    }),
  );

  it.effect(
    "treats repeated acknowledge and dispose with distinct command IDs as successful no-ops",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:delegated-delivery-a2");
        const projectId = ProjectId.make("project:delegated-delivery-a2");
        const runId = RunId.make("run:delegated-delivery-a2");
        const rootNodeId = NodeId.make("node:delegated-delivery-a2-root");
        const taskId = NodeId.make("node:delegated-delivery-a2-task");

        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId,
          rootNodeId,
          taskId,
          deliveryState: "delivered",
          completionWake: "always",
          now,
        });

        const firstAck = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:delegated-delivery-a2:ack-task-status"),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });
        const secondAck = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:delegated-delivery-a2:ack-thread-read"),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });

        const firstAckTask = firstAck.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        const secondAckTask = secondAck.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        assert.isDefined(firstAckTask);
        assert.isDefined(secondAckTask);
        if (
          firstAckTask?.event.type !== "subagent.updated" ||
          secondAckTask?.event.type !== "subagent.updated"
        ) {
          return yield* Effect.die(new Error("Acknowledge events missing."));
        }
        assert.equal(firstAckTask.event.payload.completionDelivery?.state, "acknowledged");
        assert.equal(secondAckTask.event.payload.completionDelivery?.state, "acknowledged");
        assert.deepEqual(
          secondAckTask.event.payload.completionDelivery,
          firstAckTask.event.payload.completionDelivery,
        );
        assert.deepEqual(
          secondAckTask.event.payload.updatedAt,
          firstAckTask.event.payload.updatedAt,
        );
        assert.equal(secondAck.storedEvents.length, 1);

        const afterAck = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterAck.subagents.find((candidate) => candidate.id === taskId)?.completionDelivery,
          {
            state: "acknowledged",
            observedByRunId: runId,
          },
        );

        const firstDispose = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.dispose",
          commandId: CommandId.make("command:delegated-delivery-a2:dispose-task-status"),
          parentThreadId: threadId,
          taskId,
        });
        const secondDispose = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.dispose",
          commandId: CommandId.make("command:delegated-delivery-a2:dispose-thread-read"),
          parentThreadId: threadId,
          taskId,
        });

        const firstDisposeTask = firstDispose.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        const secondDisposeTask = secondDispose.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        assert.isDefined(firstDisposeTask);
        assert.isDefined(secondDisposeTask);
        if (
          firstDisposeTask?.event.type !== "subagent.updated" ||
          secondDisposeTask?.event.type !== "subagent.updated"
        ) {
          return yield* Effect.die(new Error("Dispose events missing."));
        }
        assert.equal(firstDisposeTask.event.payload.completionDelivery?.state, "disposed");
        assert.equal(secondDisposeTask.event.payload.completionDelivery?.state, "disposed");
        assert.deepEqual(
          secondDisposeTask.event.payload.completionDelivery,
          firstDisposeTask.event.payload.completionDelivery,
        );
        assert.equal(secondDispose.storedEvents.length, 1);

        const afterDispose = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterDispose.subagents.find((candidate) => candidate.id === taskId)?.completionDelivery,
          {
            state: "disposed",
            observedByRunId: null,
          },
        );

        const acknowledgeAfterDispose = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:delegated-delivery-a2:ack-after-dispose"),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });
        const acknowledgedTask = acknowledgeAfterDispose.storedEvents.find(
          (stored) => stored.event.type === "subagent.updated",
        );
        if (acknowledgedTask?.event.type !== "subagent.updated") {
          return yield* Effect.die(new Error("Acknowledge-after-dispose event missing."));
        }
        assert.deepEqual(acknowledgedTask.event.payload.completionDelivery, {
          state: "disposed",
          observedByRunId: null,
        });
        assert.equal(acknowledgeAfterDispose.storedEvents.length, 1);

        const afterStaleAcknowledge = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterStaleAcknowledge.subagents.find((candidate) => candidate.id === taskId)
            ?.completionDelivery,
          {
            state: "disposed",
            observedByRunId: null,
          },
        );
      }),
  );
});

const traceSqlStatements = () => {
  const statements: Array<string> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const query = span.attributes.get("db.query.text");
        if (typeof query === "string") statements.push(query);
      };
      return span;
    },
  });
  return { statements, tracer };
};

const reconcileCommandId = (name: string) => CommandId.make(`command:runtime-reconcile:${name}`);

const parentProviderThreadId = (threadId: ThreadId) =>
  ProviderThreadId.make(`provider-thread:${String(threadId).replace("thread:", "")}`);

const runEvent = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly ordinal: number;
  readonly status: OrchestrationV2Run["status"];
  readonly now: DateTime.Utc;
  readonly providerThreadId?: ProviderThreadId;
  readonly userMessageId?: MessageId;
  readonly delegatedCompletion?: OrchestrationV2Run["delegatedCompletion"];
}) => ({
  id: EventId.make(`event:${input.runId}:${input.status}`),
  type: "run.updated" as const,
  threadId: input.threadId,
  runId: input.runId,
  providerInstanceId: modelSelection.instanceId,
  occurredAt: input.now,
  payload: {
    id: input.runId,
    threadId: input.threadId,
    ordinal: input.ordinal,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: input.providerThreadId ?? null,
    userMessageId: input.userMessageId ?? MessageId.make(`message:${input.runId}`),
    rootNodeId: null,
    activeAttemptId: null,
    status: input.status,
    requestedAt: input.now,
    startedAt: input.now,
    completedAt: input.status === "running" ? null : input.now,
    checkpointId: null,
    contextHandoffId: null,
    ...(input.delegatedCompletion === undefined
      ? {}
      : { delegatedCompletion: input.delegatedCompletion }),
  },
});

const seedRestartCancelledChild = (input: {
  readonly parentThreadId: ThreadId;
  readonly projectId: ProjectId;
  readonly parentRunId: RunId;
  readonly rootNodeId: NodeId;
  readonly name: string;
  readonly completionWake: "always" | "settled_only";
  readonly continuationPending: boolean;
  readonly continuationCommandId?: CommandId;
  readonly runStatus?: "cancelled" | "completed" | "interrupted";
  readonly lostWork?: OrchestrationV2Run["restartCancelledBackgroundWork"];
  readonly partialResult?: string;
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const taskId = NodeId.make(`node:${input.name}`);
    const childThreadId = ThreadId.make(`thread:${input.name}`);
    const childRunId = RunId.make(`run:${input.name}:1`);
    yield* eventSink.write({
      commandId: CommandId.make(`command:seed-child:${input.name}`),
      events: [
        {
          id: EventId.make(`event:${input.name}:thread`),
          type: "thread.created",
          threadId: childThreadId,
          occurredAt: input.now,
          payload: {
            createdBy: "agent",
            creationSource: "server",
            id: childThreadId,
            projectId: input.projectId,
            title: input.name,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: input.parentThreadId,
              relationshipToParent: "subagent",
              rootThreadId: input.parentThreadId,
            },
            forkedFrom: { type: "node", nodeId: taskId },
            createdAt: input.now,
            updatedAt: input.now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        },
        {
          id: EventId.make(`event:${input.name}:task`),
          type: "subagent.updated",
          threadId: input.parentThreadId,
          runId: input.parentRunId,
          nodeId: taskId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: taskId,
            threadId: input.parentThreadId,
            runId: input.parentRunId,
            parentNodeId: input.rootNodeId,
            origin: "app_owned",
            createdBy: "agent",
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerThreadId: null,
            childThreadId,
            nativeTaskRef: null,
            prompt: `Run ${input.name}.`,
            title: null,
            model: null,
            completionWake: input.completionWake,
            status: "running",
            result: null,
            startedAt: input.now,
            completedAt: null,
            updatedAt: input.now,
          },
        },
      ],
    });
    const childRun = runEvent({
      threadId: childThreadId,
      runId: childRunId,
      ordinal: 1,
      status: input.runStatus ?? "cancelled",
      now: input.now,
    });
    yield* eventSink.writeWithEffects({
      commandId: input.continuationCommandId ?? reconcileCommandId(input.name),
      events: [
        input.lostWork === undefined
          ? childRun
          : {
              ...childRun,
              payload: { ...childRun.payload, restartCancelledBackgroundWork: input.lostWork },
            },
      ],
      effects: input.continuationPending
        ? [
            {
              id: `effect:restart-continuation:${childRunId}`,
              commandId: input.continuationCommandId ?? reconcileCommandId(input.name),
              threadId: childThreadId,
              request: { type: "provider-runtime.continue", sourceRunId: childRunId },
            },
          ]
        : [],
    });
    if (input.partialResult !== undefined) {
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`event:${input.name}:partial-result`),
            type: "message.updated",
            threadId: childThreadId,
            runId: childRunId,
            occurredAt: input.now,
            payload: {
              id: MessageId.make(`message:${input.name}:partial-result`),
              threadId: childThreadId,
              runId: childRunId,
              nodeId: null,
              role: "assistant",
              text: input.partialResult,
              createdBy: "agent",
              creationSource: "provider",
              attachments: [],
              streaming: false,
              createdAt: input.now,
              updatedAt: input.now,
            },
          },
        ],
      });
    }
    return { taskId, childThreadId, childRunId };
  });

it.layer(Layer.merge(layerTest, ProviderContinuationRequests.layer))(
  "delegated recovery deadlines",
  (it) => {
    it.effect(
      "skips only the stuck recovery item at its deadline and delivers its healthy sibling",
      () =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const store = yield* ProjectionStore.ProjectionStoreV2;
          const sink = yield* EventSink.EventSinkV2;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const now = yield* DateTime.now;
          const threadId = ThreadId.make("thread:recovery-deadline-parent");
          const projectId = ProjectId.make("project:recovery-deadline");
          const runId = RunId.make("run:recovery-deadline-parent");
          const rootNodeId = NodeId.make("node:recovery-deadline-parent");
          yield* seedParentWithTerminalTask({
            threadId,
            projectId,
            runId,
            rootNodeId,
            taskId: NodeId.make("node:recovery-deadline-seed"),
            deliveryState: "acknowledged",
            now,
          });
          const stuck = yield* seedRestartCancelledChild({
            parentThreadId: threadId,
            projectId,
            parentRunId: runId,
            rootNodeId,
            name: "recovery-deadline-stuck",
            completionWake: "always",
            continuationPending: false,
            runStatus: "completed",
            now,
          });
          const healthy = yield* seedRestartCancelledChild({
            parentThreadId: threadId,
            projectId,
            parentRunId: runId,
            rootNodeId,
            name: "recovery-deadline-healthy",
            completionWake: "always",
            continuationPending: false,
            runStatus: "completed",
            now,
          });
          const entered = yield* Deferred.make<void>();
          const read = store.getThreadShell;
          const afterSequence = yield* sink.latestSequence();
          yield* Effect.acquireUseRelease(
            Effect.sync(() =>
              vi
                .spyOn(store, "getThreadShell")
                .mockImplementation((id) =>
                  id === stuck.childThreadId
                    ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
                    : read(id),
                ),
            ),
            () =>
              Effect.gen(function* () {
                const fiber = yield* orchestrator.recoverDelegatedTasks.pipe(Effect.forkChild);
                yield* Deferred.await(entered);
                yield* sink.stream({ afterSequence, eventType: "subagent.updated" }).pipe(
                  Stream.filter(
                    (stored) =>
                      stored.event.type === "subagent.updated" &&
                      stored.event.payload.id === healthy.taskId &&
                      stored.event.payload.result !== null,
                  ),
                  Stream.take(1),
                  Stream.runDrain,
                );
                yield* TestClock.adjust("30 seconds");
                const summary = yield* Fiber.join(fiber);
                assert.equal(summary.timedOut, 1);
                assert.equal(summary.subagentResultThreads, 2);
                assert.equal(summary.slowestItemId, stuck.childThreadId);
                assert.equal(summary.slowestItemMs, 30_000);
              }),
            (spy) => Effect.sync(() => spy.mockRestore()),
          );
          const recovered = yield* orchestrator.getThreadProjection(threadId);
          assert.isNull(recovered.subagents.find((task) => task.id === stuck.taskId)!.result);
          assert.isNotNull(recovered.subagents.find((task) => task.id === healthy.taskId)!.result);
          assert.equal((yield* requests.take).delegatedCompletion?.parentRunId, runId);
        }),
    );
  },
);

it.layer(Layer.merge(layerTest, ProviderContinuationRequests.layer))(
  "delegated recovery without an effect worker",
  (it) => {
    it.effect(
      "recovers a pre-restart result without the effect worker or repeated parent history reads",
      () =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const store = yield* ProjectionStore.ProjectionStoreV2;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const now = yield* DateTime.now;
          const threadId = ThreadId.make("thread:bounded-recovery-parent");
          const projectId = ProjectId.make("project:bounded-recovery");
          const runId = RunId.make("run:bounded-recovery-parent");
          const rootNodeId = NodeId.make("node:bounded-recovery-parent");
          yield* seedParentWithTerminalTask({
            threadId,
            projectId,
            runId,
            rootNodeId,
            taskId: NodeId.make("node:bounded-recovery-seed"),
            deliveryState: "acknowledged",
            now,
          });
          const child = yield* seedRestartCancelledChild({
            parentThreadId: threadId,
            projectId,
            parentRunId: runId,
            rootNodeId,
            name: "bounded-recovery-child",
            completionWake: "always",
            continuationPending: false,
            runStatus: "completed",
            now,
          });
          const read = store.getThreadRecords;
          const unboundedMessages: string[] = [];
          yield* Effect.acquireUseRelease(
            Effect.sync(() =>
              vi.spyOn(store, "getThreadRecords").mockImplementation((id, sections, filter) => {
                if (
                  id === threadId &&
                  sections.includes("messages") &&
                  filter?.messageIds === undefined
                )
                  unboundedMessages.push(String(id));
                return read(id, sections, filter);
              }),
            ),
            () => orchestrator.recoverDelegatedTasks,
            (spy) => Effect.sync(() => spy.mockRestore()),
          );
          // No effect worker is started or drained: result persistence and the offer must complete on their own.
          const recovered = yield* orchestrator.getThreadProjection(threadId);
          assert.isNotNull(recovered.subagents.find((task) => task.id === child.taskId)?.result);
          assert.lengthOf(
            recovered.contextTransfers.filter(
              (transfer) => transfer.sourceThreadId === child.childThreadId,
            ),
            1,
          );
          const wake = yield* requests.take;
          const delivery = recovered.runs.find((run) => run.id === runId)!.delegatedCompletion!
            .delivery!;
          assert.equal(wake.delegatedCompletion?.messageId, delivery.messageId);
          yield* orchestrator.recoverDelegatedTasks;
          const again = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(again.subagents, recovered.subagents);
          assert.deepEqual(again.contextTransfers, recovered.contextTransfers);
          assert.isEmpty(unboundedMessages);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("command:bounded-recovery-delivery"),
            threadId,
            messageId: delivery.messageId,
            text: "Delegated task finished.",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "server",
            delegatedCompletion: {
              parentRunId: runId,
              generation: delivery.generation,
              taskIds: delivery.taskIds,
            },
          });
          const delivered = yield* orchestrator.getThreadProjection(threadId);
          assert.include(
            delivered.messages.find((message) => message.id === delivery.messageId)!.text,
            recovered.subagents.find((task) => task.id === child.taskId)!.result!,
          );
          yield* orchestrator.recoverDelegatedTasks;
          const final = yield* orchestrator.getThreadProjection(threadId);
          assert.lengthOf(
            final.messages.filter((message) => message.id === delivery.messageId),
            1,
          );
          assert.lengthOf(
            final.contextTransfers.filter(
              (transfer) => transfer.sourceThreadId === child.childThreadId,
            ),
            1,
          );
        }),
    );
  },
);

it.layer(Layer.merge(layerTest, ProviderContinuationRequests.layer))(
  "subagent follow-ups",
  (it) => {
    it.effect("keeps a checkpoint completion committed between finalize's read and write", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:completion-capture-race");
        const projectId = ProjectId.make("project:completion-capture-race");
        const runId = RunId.make("run:completion-capture-race");
        const rootNodeId = NodeId.make("node:completion-capture-race");
        const checkpointId = CheckpointId.make("checkpoint:completion-capture-race");
        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId,
          rootNodeId,
          taskId: NodeId.make("node:completion-capture-seed"),
          deliveryState: "acknowledged",
          now,
        });
        const parent = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        const waiting = { ...parent, status: "waiting" as const };
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:completion-capture-waiting"),
              type: "run.updated",
              threadId,
              runId,
              occurredAt: now,
              payload: waiting,
            },
          ],
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId: runId,
          rootNodeId,
          name: "completion-capture-child",
          completionWake: "always",
          continuationPending: false,
          runStatus: "completed",
          now,
        });
        const write = sink.writeWithEffects;
        let captured = false;
        const committedParentRuns: Array<OrchestrationV2Run> = [];
        yield* Effect.acquireUseRelease(
          Effect.sync(() =>
            vi.spyOn(sink, "writeWithEffects").mockImplementation((input) =>
              Effect.gen(function* () {
                if (
                  !captured &&
                  input.events.some(
                    (event) =>
                      event.type === "run.updated" &&
                      event.payload.id === runId &&
                      event.payload.delegatedCompletion?.delivery != null,
                  )
                ) {
                  captured = true;
                  // Commit capture after finalize planned its stale waiting snapshot.
                  const { delegatedCompletion: _cohort, ...captureRun } = waiting;
                  yield* sink.commitCommand({
                    commandId: CommandId.make("command:completion-capture-race"),
                    threadId,
                    commandType: "checkpoint.capture",
                    acceptedAt: now,
                    effects: [],
                    events: [
                      {
                        id: EventId.make("event:completion-capture-completed"),
                        type: "run.updated",
                        threadId,
                        runId,
                        occurredAt: now,
                        payload: {
                          ...captureRun,
                          status: "completed",
                          completedAt: now,
                          checkpointId,
                        },
                      },
                    ],
                  });
                }
                const stored = yield* write(input);
                for (const { event } of stored) {
                  if (event.type === "run.updated" && event.payload.id === runId) {
                    committedParentRuns.push(event.payload);
                  }
                }
                return stored;
              }),
            ),
          ),
          () => orchestrator.recoverDelegatedTasks,
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        assert.isTrue(captured);
        assert.equal(committedParentRuns.length, 1);
        const committedParentRun = committedParentRuns[0];
        assert.equal(committedParentRun?.status, "completed");
        assert.deepEqual(committedParentRun?.completedAt, now);
        assert.equal(committedParentRun?.checkpointId, checkpointId);
        assert.deepEqual(committedParentRun?.delegatedCompletion?.delivery?.taskIds, [
          child.taskId,
        ]);
        const finished = yield* orchestrator.getThreadProjection(threadId);
        const completed = finished.runs.find((run) => run.id === runId)!;
        assert.equal(completed.status, "completed");
        assert.deepEqual(completed.completedAt, now);
        assert.equal(completed.checkpointId, checkpointId);
        assert.deepEqual(completed.delegatedCompletion?.delivery?.taskIds, [child.taskId]);
        const wake = yield* requests.take;
        assert.equal(wake.delegatedCompletion?.parentRunId, runId);
        const delivery = completed.delegatedCompletion!.delivery!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "server",
          commandId: CommandId.make("command:completion-capture-delivery"),
          threadId,
          messageId: delivery.messageId,
          text: "Child finished",
          attachments: [],
          delegatedCompletion: {
            parentRunId: runId,
            generation: delivery.generation,
            taskIds: delivery.taskIds,
          },
          dispatchMode: { type: "queue_after_active" },
        });
        const delivered = yield* orchestrator.getThreadProjection(threadId);
        const deliveryRun = delivered.runs.find((run) => run.userMessageId === delivery.messageId);
        assert.isDefined(deliveryRun);
        assert.notEqual(deliveryRun?.status, "queued");
      }),
    );
    it.effect("pauses queued follow-up cards and resumes them", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const parentThreadId = ThreadId.make("thread:held-followup-parent");
        const projectId = ProjectId.make("project:held-followup");
        const parentRunId = RunId.make("run:held-followup-parent");
        const rootNodeId = NodeId.make("node:held-followup-parent");
        yield* seedParentWithTerminalTask({
          threadId: parentThreadId,
          projectId,
          runId: parentRunId,
          rootNodeId,
          taskId: NodeId.make("node:held-followup-seed"),
          deliveryState: "acknowledged",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId,
          projectId,
          parentRunId,
          rootNodeId,
          name: "held-followup-child",
          completionWake: "always",
          continuationPending: false,
          runStatus: "completed",
          now,
        });
        yield* orchestrator.recoverDelegatedTasks;
        const send = (name: string) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "agent",
            creationSource: "mcp",
            commandId: CommandId.make(`command:held-followup:${name}`),
            threadId: child.childThreadId,
            senderThreadId: parentThreadId,
            messageId: MessageId.make(`message:held-followup:${name}`),
            text: name,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
          });
        yield* send("active");
        yield* send("queued");
        const before = yield* orchestrator.getThreadProjection(child.childThreadId);
        const active = before.runs.find((run) => run.ordinal === 2)!;
        const queued = before.runs.find((run) => run.ordinal === 3)!;
        assert.equal(queued.status, "queued");
        const waitForStatus = (afterSequence: number, status: string) =>
          eventSink.stream({ afterSequence, eventType: "subagent.updated" }).pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "subagent.updated" &&
                stored.event.payload.id === queued.delegatedTaskId &&
                stored.event.payload.status === status,
            ),
            Stream.take(1),
            Stream.runHead,
          );
        const afterSequence = yield* eventSink.latestSequence();
        yield* orchestrator.dispatch({
          type: "thread.stop",
          threadId: child.childThreadId,
          commandId: CommandId.make("command:held-followup:stop"),
        });
        yield* waitForStatus(afterSequence, "idle");
        const paused = yield* orchestrator.getThreadProjection(parentThreadId);
        const task = paused.subagents.find((row) => row.id === queued.delegatedTaskId)!;
        assert.equal(task.status, "idle");
        assert.isNull(task.result);
        assert.equal(paused.nodes.find((row) => row.id === task.id)?.status, "idle");
        assert.equal(
          paused.turnItems.find((row) => row.type === "subagent" && row.subagentId === task.id)
            ?.status,
          "idle",
        );
        const endedSequence = yield* eventSink.latestSequence();
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("event:held-followup-active-ended"),
              type: "run.updated",
              threadId: child.childThreadId,
              runId: active.id,
              occurredAt: now,
              payload: { ...active, status: "interrupted", startedAt: now, completedAt: now },
            },
          ],
        });
        const activeTask = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
          (row) => row.id === active.delegatedTaskId,
        )!;
        if (activeTask.result === null) {
          yield* eventSink
            .stream({ afterSequence: endedSequence, eventType: "subagent.updated" })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "subagent.updated" &&
                  stored.event.payload.id === active.delegatedTaskId &&
                  stored.event.payload.status === "interrupted",
              ),
              Stream.take(1),
              Stream.runHead,
            );
        }
        const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (row) => row.id === parentThreadId,
        )!;
        assert.isFalse((shell.pendingBackgroundTasks ?? []).some((row) => row.taskId === task.id));
        const resumeSequence = yield* eventSink.latestSequence();
        yield* orchestrator.dispatch({
          type: "queue.resume",
          threadId: child.childThreadId,
          commandId: CommandId.make("command:held-followup:resume"),
        });
        yield* waitForStatus(resumeSequence, "running");
        const resumed = yield* orchestrator.getThreadProjection(parentThreadId);
        assert.equal(resumed.subagents.find((row) => row.id === task.id)?.status, "running");
        assert.isNull(resumed.subagents.find((row) => row.id === task.id)?.result);
      }),
    );

    const outcomes = [
      "completed",
      "failed",
      "interrupted",
      "restarted",
      "stopped",
      "overlapping",
    ] as const;
    it.effect.each(outcomes)(
      "delivers a %s follow-up independently of the original task",
      (outcome) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const now = yield* DateTime.now;
          const parentThreadId = ThreadId.make(`thread:followup-${outcome}`);
          const projectId = ProjectId.make(`project:followup-${outcome}`);
          const parentRunId = RunId.make(`run:followup-${outcome}`);
          const rootNodeId = NodeId.make(`node:followup-${outcome}`);
          yield* seedParentWithTerminalTask({
            threadId: parentThreadId,
            projectId,
            runId: parentRunId,
            rootNodeId,
            taskId: NodeId.make(`node:seed-${outcome}`),
            deliveryState: "acknowledged",
            now,
          });
          const child = yield* seedRestartCancelledChild({
            parentThreadId,
            projectId,
            parentRunId,
            rootNodeId,
            name: `followup-child-${outcome}`,
            completionWake: "always",
            continuationPending: false,
            runStatus: "completed",
            now,
          });
          yield* orchestrator.recoverDelegatedTasks;
          let firstWake = yield* requests.take;
          while (firstWake.threadId !== parentThreadId) firstWake = yield* requests.take;
          assert.equal(firstWake.delegatedCompletion?.parentRunId, parentRunId);
          yield* orchestrator.dispatch({
            type: "delegated_task.completion-delivery.acknowledge",
            commandId: CommandId.make(`command:followup-ack-${outcome}`),
            parentThreadId,
            taskId: child.taskId,
            observedByRunId: parentRunId,
          });
          const original = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
            (task) => task.id === child.taskId,
          )!;
          const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.find(
            (run) => run.id === parentRunId,
          )!;
          yield* eventSink.write({
            commandId: reconcileCommandId(`followup-parent-finished-${outcome}`),
            events: [
              {
                id: EventId.make(`event:followup-parent-finished-${outcome}`),
                type: "run.updated",
                threadId: parentThreadId,
                runId: parentRunId,
                occurredAt: now,
                payload: { ...parentRun, status: "completed", completedAt: now },
              },
            ],
          });
          const messageId = MessageId.make(`message:followup-${outcome}`);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: outcome === "failed" ? "user" : "agent",
            creationSource: outcome === "failed" ? "web" : "mcp",
            commandId: CommandId.make(`command:followup-send-${outcome}`),
            threadId: child.childThreadId,
            senderThreadId: parentThreadId,
            messageId,
            text: "Check the same work again.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          });
          const childProjection = yield* orchestrator.getThreadProjection(child.childThreadId);
          let run = childProjection.runs.find((row) => row.userMessageId === messageId)!;
          assert.isDefined(run.delegatedTaskId);
          const workingParent = yield* orchestrator.getShellSnapshot();
          const backgroundTask = workingParent.threads
            .find((thread) => thread.id === parentThreadId)
            ?.pendingBackgroundTasks?.find((task) => task.kind === "subagent");
          assert.equal(backgroundTask?.childThreadId, child.childThreadId);
          if (outcome === "overlapping") {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "mcp",
              commandId: CommandId.make("command:overlapping-followup"),
              threadId: child.childThreadId,
              senderThreadId: parentThreadId,
              messageId: MessageId.make("message:overlapping-followup"),
              text: "Keep working on another follow-up.",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
            });
          }
          if (outcome === "restarted") {
            const cut = { ...run, status: "cancelled" as const, startedAt: now, completedAt: now };
            yield* eventSink.writeWithEffects({
              commandId: reconcileCommandId("followup-restart-cut"),
              events: [
                {
                  id: EventId.make("event:followup-partial"),
                  type: "message.updated",
                  threadId: child.childThreadId,
                  runId: run.id,
                  occurredAt: now,
                  payload: {
                    id: MessageId.make("message:followup-partial"),
                    threadId: child.childThreadId,
                    runId: run.id,
                    nodeId: run.rootNodeId,
                    role: "assistant",
                    text: "Partial follow-up result",
                    createdBy: "agent",
                    creationSource: "provider",
                    attachments: [],
                    streaming: false,
                    createdAt: now,
                    updatedAt: now,
                  },
                },
                {
                  id: EventId.make("event:followup-restart-cut"),
                  type: "run.updated",
                  threadId: child.childThreadId,
                  runId: run.id,
                  occurredAt: now,
                  payload: cut,
                },
              ],
              effects: [
                {
                  id: `effect:restart-continuation:${run.id}`,
                  commandId: reconcileCommandId("followup-restart-cut"),
                  threadId: child.childThreadId,
                  request: { type: "provider-runtime.continue", sourceRunId: run.id },
                },
              ],
            });
            yield* orchestrator.recoverDelegatedTasks;
            assert.isNull(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === run.delegatedTaskId,
              )!.result,
            );
            const continuationMessageId = MessageId.make("message:followup-restart-continuation");
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "server",
              commandId: CommandId.make("command:followup-restart-continuation"),
              threadId: child.childThreadId,
              restartContinuationOfRunId: run.id,
              messageId: continuationMessageId,
              text: "Continue where you left off.",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
            });
            const continuation = (yield* orchestrator.getThreadProjection(
              child.childThreadId,
            )).runs.find((row) => row.userMessageId === continuationMessageId)!;
            assert.equal(continuation.delegatedTaskId, run.delegatedTaskId);
            run = continuation;
          }
          if (outcome === "stopped") {
            yield* orchestrator.dispatch({
              type: "thread.stop",
              threadId: parentThreadId,
              commandId: CommandId.make(`command:followup-stop-${outcome}`),
            });
          }
          yield* eventSink.write({
            commandId: reconcileCommandId(`followup-finish-${outcome}`),
            events: [
              {
                id: EventId.make(`event:followup-finish-${outcome}`),
                type: "run.updated",
                threadId: child.childThreadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  ...run,
                  status:
                    outcome === "stopped"
                      ? "interrupted"
                      : outcome === "restarted" || outcome === "overlapping"
                        ? "completed"
                        : outcome,
                  startedAt: now,
                  completedAt: now,
                },
              },
            ],
          });
          yield* orchestrator.recoverDelegatedTasks;
          const finished = yield* orchestrator.getThreadProjection(parentThreadId);
          assert.deepEqual(
            finished.subagents.find((task) => task.id === child.taskId),
            original,
          );
          const followup = finished.subagents.find((task) => task.id === run.delegatedTaskId)!;
          if (outcome === "overlapping") {
            const later = finished.subagents.find(
              (task) =>
                task.childThreadId === child.childThreadId &&
                task.id !== child.taskId &&
                task.id !== followup.id,
            )!;
            assert.equal(later.status, "pending");
            assert.isNull(later.result);
          }
          assert.equal(
            followup.status,
            outcome === "stopped"
              ? "interrupted"
              : outcome === "restarted" || outcome === "overlapping"
                ? "completed"
                : outcome,
          );
          assert.equal(
            followup.completionDelivery?.state,
            outcome === "stopped" ? "disposed" : "claimed",
          );
          if (outcome !== "stopped") {
            let wake = yield* requests.take;
            while (
              wake.threadId !== parentThreadId ||
              wake.delegatedCompletion?.messageId === firstWake.delegatedCompletion?.messageId
            ) {
              wake = yield* requests.take;
            }
            assert.equal(wake.delegatedCompletion?.parentRunId, parentRunId);
            assert.notEqual(
              wake.delegatedCompletion?.messageId,
              firstWake.delegatedCompletion?.messageId,
            );
          }
          assert.equal(
            finished.contextTransfers.filter(
              (transfer) =>
                transfer.type === "subagent_result" &&
                transfer.sourceThreadId === child.childThreadId,
            ).length,
            2,
          );
          yield* orchestrator.recoverDelegatedTasks;
          const recovered = yield* orchestrator.getThreadProjection(parentThreadId);
          assert.equal(recovered.contextTransfers.length, finished.contextTransfers.length);
          if (outcome === "completed") {
            const automaticMessageId = MessageId.make("message:followup-automatic-wake");
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "server",
              commandId: CommandId.make("command:followup-automatic-wake"),
              threadId: child.childThreadId,
              messageId: automaticMessageId,
              text: "A monitor reported new output.",
              attachments: [],
              notification: {
                source: { kind: "monitor" },
                outcome: "updated",
                summary: "Monitor updated",
              },
              dispatchMode: { type: "queue_after_active" },
            });
            const automatic = (yield* orchestrator.getThreadProjection(
              child.childThreadId,
            )).runs.find((run) => run.userMessageId === automaticMessageId)!;
            assert.isUndefined(automatic.delegatedTaskId);
            yield* eventSink.write({
              commandId: reconcileCommandId("followup-automatic-finished"),
              events: [
                {
                  id: EventId.make("event:followup-automatic-finished"),
                  type: "run.updated",
                  threadId: child.childThreadId,
                  runId: automatic.id,
                  occurredAt: now,
                  payload: { ...automatic, status: "completed", startedAt: now, completedAt: now },
                },
              ],
            });
            yield* orchestrator.recoverDelegatedTasks;
            const afterAutomatic = yield* orchestrator.getThreadProjection(parentThreadId);
            assert.deepEqual(afterAutomatic.subagents, recovered.subagents);
            assert.equal(afterAutomatic.contextTransfers.length, recovered.contextTransfers.length);
            const control = yield* seedRestartCancelledChild({
              parentThreadId,
              projectId,
              parentRunId,
              rootNodeId,
              name: "followup-control-child",
              completionWake: "always",
              continuationPending: false,
              runStatus: "completed",
              now,
            });
            yield* orchestrator.recoverDelegatedTasks;
            const afterControl = yield* orchestrator.getThreadProjection(parentThreadId);
            assert.equal(
              afterControl.subagents.find((task) => task.id === control.taskId)?.completionDelivery
                ?.state,
              "claimed",
            );
            assert.equal(
              afterControl.contextTransfers.filter(
                (transfer) =>
                  transfer.type === "subagent_result" &&
                  transfer.sourceThreadId === control.childThreadId,
              ).length,
              1,
            );
          }
        }),
    );
  },
);

it.layer(layerTest)("delegated tasks across a server restart", (it) => {
  it.effect.each(["none", "answer", "error"] as const)(
    "recovers a runtime-lost marker alongside %s child output",
    (output) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const name = `runtime-lost-${output}`;
        const threadId = ThreadId.make(`thread:${name}:parent`);
        const projectId = ProjectId.make(`project:${name}`);
        const runId = RunId.make(`run:${name}:parent`);
        const rootNodeId = NodeId.make(`node:${name}:parent`);
        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId,
          rootNodeId,
          taskId: NodeId.make(`node:${name}:seed`),
          deliveryState: "delivered",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId: runId,
          rootNodeId,
          name,
          completionWake: "always",
          continuationPending: true,
          continuationCommandId: CommandId.make(`command:runtime-reconcile:startup:${name}`),
          now,
        });
        const before = yield* orchestrator.getThreadProjection(child.childThreadId);
        const source = { ...before.runs[0]!, rootNodeId: NodeId.make(`${name}:root`) };
        const marker = {
          id: TurnItemId.make(`turn-item:runtime-lost:${source.id}`),
          threadId: child.childThreadId,
          runId: source.id,
          nodeId: source.rootNodeId,
          providerThreadId: source.providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          type: "error" as const,
          title: "Provider runtime stopped",
          status: "failed" as const,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          failure: {
            class: "transport_error" as const,
            category: "unknown" as const,
            code: "provider.runtime_lost",
            message: "Server restarted",
            retryable: true,
          },
        };
        yield* sink.write({
          events: [
            {
              id: EventId.make(`${name}:source`),
              type: "run.updated",
              threadId: child.childThreadId,
              occurredAt: now,
              payload: source,
            },
            {
              id: EventId.make(`${name}:marker`),
              type: "turn-item.updated",
              threadId: child.childThreadId,
              occurredAt: now,
              payload: marker,
            },
            ...(output === "none"
              ? []
              : [
                  {
                    id: EventId.make(`${name}:output`),
                    type: "turn-item.updated" as const,
                    threadId: child.childThreadId,
                    occurredAt: now,
                    payload:
                      output === "answer"
                        ? {
                            ...marker,
                            id: TurnItemId.make(`${name}:answer`),
                            ordinal: 1,
                            type: "assistant_message" as const,
                            status: "completed" as const,
                            messageId: MessageId.make(`${name}:answer`),
                            text: "Original child answer",
                            streaming: false,
                            phase: "answer" as const,
                          }
                        : {
                            ...marker,
                            id: TurnItemId.make(`${name}:provider-error`),
                            ordinal: 1,
                            failure: {
                              class: "provider_error" as const,
                              code: null,
                              message: "Provider failed",
                              retryable: false,
                            },
                          },
                  },
                ]),
          ],
        });
        yield* orchestrator.recoverDelegatedTasks;
        const recovered = yield* orchestrator.getThreadProjection(threadId);
        const task = recovered.subagents.find((row) => row.id === child.taskId)!;
        if (output === "none") {
          assert.equal(task.status, "running");
          assert.isNull(task.result);
          assert.isEmpty(recovered.contextTransfers);
        } else if (output === "error") {
          assert.equal(task.status, "cancelled");
          assert.isNotNull(task.result);
          assert.isFalse(yield* orchestrator.delegatedTaskResultPending(child.childThreadId));
          assert.equal(
            (yield* orchestrator.getThreadProjection(child.childThreadId)).runs.length,
            1,
          );
        } else {
          // A completed provider turn declines its retained restart effect.
          const attemptId = RunAttemptId.make(`${name}:attempt`);
          yield* sink.write({
            events: [
              {
                id: EventId.make(`${name}:attempt`),
                type: "run.updated",
                threadId: child.childThreadId,
                occurredAt: now,
                payload: { ...source, activeAttemptId: attemptId },
              },
              {
                id: EventId.make(`${name}:completed`),
                type: "provider-turn.updated",
                threadId: child.childThreadId,
                occurredAt: now,
                payload: {
                  id: ProviderTurnId.make(`${name}:turn`),
                  providerThreadId: ProviderThreadId.make(`${name}:provider`),
                  nodeId: source.rootNodeId,
                  runAttemptId: attemptId,
                  nativeTurnRef: null,
                  ordinal: 1,
                  status: "completed",
                  startedAt: now,
                  completedAt: now,
                  finish: "stop",
                },
              },
            ],
          });
          yield* continueRestartedRun({
            threadId: child.childThreadId,
            sourceRunId: source.id,
          }).pipe(
            Effect.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true })),
          );
          const settled = (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
            (row) => row.id === child.taskId,
          )!;
          assert.equal(settled.status, "cancelled");
          assert.equal(settled.result, "Original child answer");
          assert.equal(
            (yield* orchestrator.getThreadProjection(child.childThreadId)).runs.length,
            1,
          );
        }
      }),
  );

  it.effect.each(["stop", "length"] as const)(
    "queues a child result with finish=%s without a provider history handoff",
    (finish) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make(`thread:result-message-parent:${finish}`);
        const projectId = ProjectId.make(`project:result-message:${finish}`);
        const runId = RunId.make(`run:result-message-parent:${finish}`);
        const rootNodeId = NodeId.make(`node:result-message-parent:${finish}`);
        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId,
          rootNodeId,
          taskId: NodeId.make(`node:result-message-seed:${finish}`),
          deliveryState: "acknowledged",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId: runId,
          rootNodeId,
          name: `result-message-child-${finish}`,
          completionWake: "always",
          continuationPending: false,
          runStatus: "completed",
          now,
        });
        const parent = yield* orchestrator.getThreadProjection(threadId);
        const childProjection = yield* orchestrator.getThreadProjection(child.childThreadId);
        const providerThreadId = ProviderThreadId.make(
          `provider-thread:result-message-child:${finish}`,
        );
        const attemptId = RunAttemptId.make(`attempt:result-message-child:${finish}`);
        const childRoot = NodeId.make(`node:result-message-child:${finish}`);
        yield* eventSink.write({
          commandId: CommandId.make(`command:result-message-child-provider:${finish}`),
          events: [
            {
              id: EventId.make(`event:result-message-child-provider:${finish}`),
              type: "provider-thread.updated",
              threadId: child.childThreadId,
              occurredAt: now,
              payload: {
                ...parent.providerThreads[0]!,
                id: providerThreadId,
                appThreadId: child.childThreadId,
              },
            },
            {
              id: EventId.make(`event:result-message-child-run:${finish}`),
              type: "run.updated",
              threadId: child.childThreadId,
              runId: child.childRunId,
              occurredAt: now,
              payload: {
                ...childProjection.runs[0]!,
                providerThreadId,
                activeAttemptId: attemptId,
                rootNodeId: childRoot,
              },
            },
            {
              id: EventId.make(`event:result-message-child-provider-turn:${finish}`),
              type: "provider-turn.updated",
              threadId: child.childThreadId,
              runId: child.childRunId,
              occurredAt: now,
              payload: {
                id: ProviderTurnId.make(`provider-turn:result-message-child:${finish}`),
                providerThreadId,
                nodeId: childRoot,
                runAttemptId: attemptId,
                nativeTurnRef: null,
                ordinal: 1,
                status: "completed",
                startedAt: now,
                completedAt: now,
                finish,
              },
            },
          ],
        });

        yield* orchestrator.recoverDelegatedTasks;
        const recovered = yield* orchestrator.getThreadProjection(threadId);
        const task = recovered.subagents.find((candidate) => candidate.id === child.taskId)!;
        assert.equal(task.status, "completed");
        assert.isNotNull(task.result);
        assert.equal(task.result!.startsWith("[Result looks incomplete:"), finish === "length");
        if (finish === "length") assert.include(task.result!, "output limit (finish=length)");
        assert.isEmpty(recovered.contextHandoffs);
        assert.equal(recovered.contextTransfers.length, 1);

        const delivery = recovered.runs.find((candidate) => candidate.id === runId)!
          .delegatedCompletion!.delivery!;
        const messageId = delivery.messageId;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`command:result-message-delivery:${finish}`),
          threadId,
          messageId,
          text: "Delegated task finished.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
          delegatedCompletion: {
            parentRunId: runId,
            generation: delivery.generation,
            taskIds: [child.taskId],
          },
        });
        const queued = yield* orchestrator.getThreadProjection(threadId);
        assert.include(
          queued.messages.find((message) => message.id === messageId)?.text ?? "",
          task.result!,
        );
      }),
  );

  it.effect("holds a modern recut continuation for its earlier partial result", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:modern-recut-parent");
      const projectId = ProjectId.make("project:modern-recut");
      const runId = RunId.make("run:modern-recut-parent");
      const rootNodeId = NodeId.make("node:modern-recut-parent");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:modern-recut-seed"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "modern-recut-child",
        completionWake: "always",
        continuationPending: false,
        partialResult: "Earlier partial result",
        now,
      });
      const original = (yield* orchestrator.getThreadProjection(child.childThreadId)).runs[0]!;
      const recutId = RunId.make("run:modern-recut-child:2");
      const commandId = reconcileCommandId("modern-recut");
      yield* sink.writeWithEffects({
        commandId,
        events: [
          {
            id: EventId.make("modern-recut:original"),
            type: "run.updated",
            threadId: child.childThreadId,
            occurredAt: now,
            payload: { ...original, delegatedTaskId: child.taskId },
          },
          {
            id: EventId.make("modern-recut:continuation"),
            type: "run.updated",
            threadId: child.childThreadId,
            occurredAt: now,
            payload: {
              ...original,
              id: recutId,
              ordinal: 2,
              startedAt: null,
              restartContinuationOfRunId: original.id,
              delegatedTaskId: child.taskId,
            },
          },
        ],
        effects: [
          {
            id: `effect:restart-continuation:${recutId}`,
            commandId,
            threadId: child.childThreadId,
            request: { type: "provider-runtime.continue", sourceRunId: recutId },
          },
        ],
      });
      yield* orchestrator.recoverDelegatedTasks;
      const task = (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
        (row) => row.id === child.taskId,
      )!;
      assert.equal(task.status, "running");
      assert.isNull(task.result);
      assert.isTrue(
        yield* orchestrator.delegatedTaskResultPending(child.childThreadId, child.taskId),
      );
    }),
  );

  it.effect.each(["absent", "pending", "running"] as const)(
    "Stop settles a restart-cancelled child with continuation %s and fences late dispatch",
    (continuationState) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const now = yield* DateTime.now;
        const continuationPending = continuationState !== "absent";
        const threadId = ThreadId.make(`thread:restart-stop-parent:${continuationState}`);
        const projectId = ProjectId.make(`project:restart-stop:${continuationState}`);
        const runId = RunId.make(`run:restart-stop-parent:${continuationState}`);
        const rootNodeId = NodeId.make(`node:restart-stop-root:${continuationState}`);
        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId,
          rootNodeId,
          taskId: NodeId.make(`node:restart-stop-seed:${continuationState}`),
          deliveryState: "acknowledged",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId: runId,
          rootNodeId,
          name: `restart-stop-child-${continuationState}`,
          completionWake: "always",
          continuationPending,
          now,
        });
        const eventSink = yield* EventSink.EventSinkV2;
        const { runs } = yield* orchestrator.getThreadRecords(child.childThreadId, ["runs"]);
        yield* eventSink.write({
          commandId: CommandId.make(`command:restart-stop-tag:${continuationState}`),
          events: [
            {
              id: EventId.make(`event:restart-stop-tag:${continuationState}`),
              type: "run.updated",
              threadId: child.childThreadId,
              runId: child.childRunId,
              occurredAt: now,
              payload: { ...runs[0]!, delegatedTaskId: child.taskId },
            },
          ],
        });
        if (continuationState === "running") {
          const claimed = yield* outbox.claimNext({
            workerId: "restart-cancel-test",
            threadId: child.childThreadId,
            leaseDurationMs: 30_000,
            onlyEffectTypes: ["provider-runtime.continue"],
          });
          assert.isTrue(Option.isSome(claimed));
        }
        const beforeStop = yield* outbox.get(`effect:restart-continuation:${child.childRunId}`);
        if (continuationPending) {
          assert.isTrue(Option.isSome(beforeStop));
          if (Option.isSome(beforeStop)) assert.equal(beforeStop.value.status, continuationState);
        }
        assert.isFalse(
          yield* orchestrator.delegatedTaskResultPending(child.childThreadId, child.taskId),
        );
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`command:restart-stop:${continuationState}`),
          threadId: child.childThreadId,
        });
        assert.isFalse(
          yield* orchestrator.delegatedTaskResultPending(child.childThreadId, child.taskId),
        );
        const parent = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          parent.subagents.find((task) => task.id === child.taskId)?.status,
          "cancelled",
        );
        const continuation = yield* outbox.get(`effect:restart-continuation:${child.childRunId}`);
        if (continuationPending) {
          assert.isTrue(Option.isSome(continuation));
          if (Option.isSome(continuation)) assert.equal(continuation.value.status, "cancelled");
        }
        // An executor may already have read its source before Stop committed.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`command:restart-stop-late:${continuationState}`),
          threadId: child.childThreadId,
          messageId: MessageId.make(`message:restart-stop-late:${continuationState}`),
          text: "Continue after restart.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "server",
          restartContinuationOfRunId: child.childRunId,
        });
        const stopped = yield* orchestrator.getThreadProjection(child.childThreadId);
        assert.equal(stopped.runs.length, 1);
        assert.equal(stopped.runs[0]?.status, "cancelled");
      }),
  );

  it.effect("holds a restart-cancelled child for its continuation's result", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-parent");
      const projectId = ProjectId.make("project:restart-parent");
      const runId = RunId.make("run:restart-parent");
      const rootNodeId = NodeId.make("node:restart-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:restart-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = (
        name: string,
        continuationPending: boolean,
        runStatus?: "cancelled" | "completed" | "interrupted",
      ) =>
        seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId: runId,
          rootNodeId,
          name,
          completionWake: "always",
          continuationPending,
          partialResult: "Partial result before restart",
          ...(runStatus === undefined ? {} : { runStatus }),
          now,
        });
      const resumed = yield* child("restart-resumed-child", true);
      const interrupted = yield* child("restart-interrupted-child", true, "interrupted");
      const stopped = yield* child("restart-stopped-child", false);
      const backgrounded = yield* child("restart-backgrounded-child", true, "completed");
      const recut = yield* child("restart-recut-child", false);
      const recutContinuationId = RunId.make("run:restart-recut-child:2");
      const recutCommandId = CommandId.make("command:restart-recut-child:reconcile");
      const recutRun = runEvent({
        threadId: recut.childThreadId,
        runId: recutContinuationId,
        ordinal: 2,
        status: "cancelled",
        now,
      });
      yield* eventSink.writeWithEffects({
        commandId: recutCommandId,
        events: [
          {
            ...recutRun,
            payload: {
              ...recutRun.payload,
              startedAt: null,
              restartContinuationOfRunId: recut.childRunId,
            },
          },
        ],
        effects: [
          {
            id: `effect:restart-continuation:${recutContinuationId}`,
            commandId: recutCommandId,
            threadId: recut.childThreadId,
            request: { type: "provider-runtime.continue", sourceRunId: recutContinuationId },
          },
        ],
      });

      yield* orchestrator.recoverDelegatedTasks;

      const recovered = yield* orchestrator.getThreadProjection(threadId);
      const task = (id: NodeId) => recovered.subagents.find((row) => row.id === id);
      assert.equal(task(stopped.taskId)?.status, "cancelled");
      assert.equal(task(stopped.taskId)?.completionDelivery?.state, "claimed");
      assert.equal(task(resumed.taskId)?.status, "running");
      assert.equal(task(interrupted.taskId)?.status, "running");
      assert.isNull(task(interrupted.taskId)?.result ?? null);
      assert.isTrue(yield* orchestrator.delegatedTaskResultPending(interrupted.childThreadId));
      assert.isNull(task(resumed.taskId)?.result ?? null);
      assert.equal(task(backgrounded.taskId)?.status, "running");
      assert.isNull(task(backgrounded.taskId)?.result ?? null);
      assert.equal(task(recut.taskId)?.status, "running");
      assert.isTrue(yield* orchestrator.delegatedTaskResultPending(recut.childThreadId));
      assert.isTrue(yield* orchestrator.delegatedTaskResultPending(resumed.childThreadId));
      assert.isFalse(yield* orchestrator.delegatedTaskResultPending(stopped.childThreadId));
      yield* orchestrator.recoverDelegatedTask(recut.childThreadId, recut.childRunId);
      const replayed = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(replayed.subagents.find((row) => row.id === recut.taskId)?.status, "running");
      yield* eventSink.write({
        commandId: CommandId.make("command:restart-stopped-child:resumed"),
        events: [
          runEvent({
            threadId: stopped.childThreadId,
            runId: RunId.make("run:restart-stopped-child:2"),
            ordinal: 2,
            status: "running",
            now,
          }),
        ],
      });
      assert.isTrue(yield* orchestrator.delegatedTaskResultPending(stopped.childThreadId));
      assert.isFalse(
        recovered.contextTransfers.some(
          (transfer) => transfer.sourceThreadId === resumed.childThreadId,
        ),
      );

      const afterSequence = yield* eventSink.latestSequence();
      const continuationRunId = RunId.make("run:restart-resumed-child:2");
      yield* eventSink.write({
        commandId: CommandId.make("command:restart-resumed-child:completed"),
        events: [
          {
            id: EventId.make("event:restart-resumed-child:result"),
            type: "message.updated",
            threadId: resumed.childThreadId,
            runId: continuationRunId,
            occurredAt: now,
            payload: {
              id: MessageId.make("message:restart-resumed-child:result"),
              threadId: resumed.childThreadId,
              runId: continuationRunId,
              nodeId: null,
              role: "assistant",
              text: "Finished after the restart.",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "server",
              createdAt: now,
              updatedAt: now,
            },
          },
          runEvent({
            threadId: resumed.childThreadId,
            runId: continuationRunId,
            ordinal: 2,
            status: "completed",
            now,
          }),
        ],
      });
      const settled = yield* eventSink
        .stream({ afterSequence, eventType: "subagent.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.id === resumed.taskId,
          ),
          Stream.take(1),
          Stream.runHead,
        );
      assert.isTrue(settled._tag === "Some");
      const finished = yield* orchestrator.getThreadProjection(threadId);
      const finishedTask = finished.subagents.find((row) => row.id === resumed.taskId);
      assert.equal(finishedTask?.status, "completed");
      assert.equal(finishedTask?.result, "Finished after the restart.");
    }),
  );

  it.effect("settles a restart-cancelled child whose continuation declines to start", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-declined-parent");
      const projectId = ProjectId.make("project:restart-declined-parent");
      const runId = RunId.make("run:restart-declined-parent");
      const rootNodeId = NodeId.make("node:restart-declined-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:restart-declined-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "restart-declined-child",
        partialResult: "Partial result before restart",
        completionWake: "always",
        continuationPending: true,
        now,
      });
      yield* orchestrator.recoverDelegatedTasks;
      const held = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(held.subagents.find((row) => row.id === child.taskId)?.status, "running");

      yield* continueRestartedRun({
        threadId: child.childThreadId,
        sourceRunId: child.childRunId,
      }).pipe(
        Effect.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false })),
      );

      const settled = yield* orchestrator.getThreadProjection(threadId);
      const task = settled.subagents.find((row) => row.id === child.taskId);
      assert.equal(task?.status, "cancelled");
      assert.equal(task?.completionDelivery?.state, "claimed");
    }),
  );

  it.effect("reports a child whose monitor the restart cut as interrupted, not completed", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-monitor-parent");
      const projectId = ProjectId.make("project:restart-monitor-parent");
      const runId = RunId.make("run:restart-monitor-parent");
      const rootNodeId = NodeId.make("node:restart-monitor-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:restart-monitor-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "restart-monitor-child",
        completionWake: "always",
        continuationPending: true,
        runStatus: "completed",
        lostWork: [{ kind: "monitor", label: "Gate attempt 9" }],
        now,
      });
      yield* orchestrator.recoverDelegatedTasks;
      const held = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(held.subagents.find((row) => row.id === child.taskId)?.status, "running");

      yield* continueRestartedRun({
        threadId: child.childThreadId,
        sourceRunId: child.childRunId,
      }).pipe(
        Effect.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false })),
      );

      const settled = yield* orchestrator.getThreadProjection(threadId);
      const task = settled.subagents.find((row) => row.id === child.taskId);
      assert.equal(task?.status, "interrupted");
      assert.equal(task?.result, "Child task ended with status interrupted.");
      assert.equal(task?.completionDelivery?.state, "claimed");
    }),
  );

  // A running provider turn does not prove the provider consumed the delivery
  // (Claude marks the turn running before it reads the prompt), so a cut
  // delivery is offered again even when a continuation resumes that turn.
  it.effect("re-offers a cut delivery even when a continuation resumes its turn", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const seed = (name: string, continuationPending: boolean) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(`thread:${name}`);
          const runId = RunId.make(`run:${name}`);
          const taskId = NodeId.make(`node:${name}-task`);
          const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
          const deliveryRunId = RunId.make(`run:${name}:delivery`);
          yield* seedParentWithTerminalTask({
            threadId,
            projectId: ProjectId.make(`project:${name}`),
            runId,
            rootNodeId: NodeId.make(`node:${name}-root`),
            taskId,
            deliveryState: "claimed",
            completionWake: "always",
            deliveryTaskIds: [taskId],
            now,
          });
          yield* eventSink.writeWithEffects({
            commandId: reconcileCommandId(name),
            events: [
              {
                id: EventId.make(`event:${name}:delivery-message`),
                type: "message.updated",
                threadId,
                runId: deliveryRunId,
                occurredAt: now,
                payload: {
                  id: messageId,
                  threadId,
                  runId: deliveryRunId,
                  nodeId: null,
                  role: "user",
                  text: `Delegated task ${taskId} reached a terminal state.`,
                  attachments: [],
                  streaming: false,
                  createdBy: "agent",
                  creationSource: "server",
                  createdAt: now,
                  updatedAt: now,
                  delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
                },
              },
              runEvent({
                threadId,
                runId: deliveryRunId,
                ordinal: 2,
                status: "cancelled",
                now,
                providerThreadId: parentProviderThreadId(threadId),
                userMessageId: messageId,
              }),
            ],
            effects: continuationPending
              ? [
                  {
                    id: `effect:restart-continuation:${deliveryRunId}`,
                    commandId: reconcileCommandId(name),
                    threadId,
                    request: { type: "provider-runtime.continue", sourceRunId: deliveryRunId },
                  },
                ]
              : [],
          });
          return { threadId, runId, taskId };
        });
      const cut = yield* seed("delivery-cut", false);
      const resumed = yield* seed("delivery-resumed", true);

      yield* orchestrator.recoverDelegatedTasks;

      for (const seeded of [cut, resumed]) {
        const projection = yield* orchestrator.getThreadProjection(seeded.threadId);
        assert.deepEqual(
          projection.subagents.find((row) => row.id === seeded.taskId)?.completionDelivery?.state,
          "claimed",
        );
        const delivery = projection.runs.find((row) => row.id === seeded.runId)?.delegatedCompletion
          ?.delivery;
        assert.equal(delivery?.generation, 2);
        assert.deepEqual(delivery?.taskIds, [seeded.taskId]);
      }
    }),
  );

  it.effect("settles only the current delivery of a parent with long delivery history", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:delivery-history");
      const runId = RunId.make("run:delivery-history");
      const taskId = NodeId.make("node:delivery-history-task");
      const currentMessageId = MessageId.make(`message:delegated-delivery:${threadId}`);
      const currentRunId = RunId.make("run:delivery-history:current");
      const HISTORY = 40;
      yield* seedParentWithTerminalTask({
        threadId,
        projectId: ProjectId.make("project:delivery-history"),
        runId,
        rootNodeId: NodeId.make("node:delivery-history-root"),
        taskId,
        deliveryState: "claimed",
        completionWake: "always",
        deliveryTaskIds: [taskId],
        now,
      });
      const deliveryMessage = (id: MessageId, deliveryRunId: RunId) => ({
        id: EventId.make(`event:${deliveryRunId}:message`),
        type: "message.updated" as const,
        threadId,
        runId: deliveryRunId,
        occurredAt: now,
        payload: {
          id,
          threadId,
          runId: deliveryRunId,
          nodeId: null,
          role: "user" as const,
          text: `Delegated task ${taskId} reached a terminal state.`,
          attachments: [],
          streaming: false,
          createdBy: "agent" as const,
          creationSource: "server" as const,
          createdAt: now,
          updatedAt: now,
          delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
        },
      });
      const history = Array.from({ length: HISTORY }, (_, index) => {
        const historyRunId = RunId.make(`run:delivery-history:${index}`);
        const messageId = MessageId.make(`message:delivery-history:${index}`);
        return [
          deliveryMessage(messageId, historyRunId),
          runEvent({
            threadId,
            runId: historyRunId,
            ordinal: index + 2,
            status: "completed",
            now,
            providerThreadId: parentProviderThreadId(threadId),
            userMessageId: messageId,
          }),
        ];
      }).flat();
      yield* eventSink.write({
        commandId: reconcileCommandId("delivery-history"),
        events: [
          ...history,
          deliveryMessage(currentMessageId, currentRunId),
          runEvent({
            threadId,
            runId: currentRunId,
            ordinal: HISTORY + 2,
            status: "completed",
            now,
            providerThreadId: parentProviderThreadId(threadId),
            userMessageId: currentMessageId,
          }),
        ],
      });

      const { statements, tracer } = traceSqlStatements();
      yield* orchestrator.recoverDelegatedTasks.pipe(Effect.withTracer(tracer));

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        projection.subagents.find((row) => row.id === taskId)?.completionDelivery?.state,
        "delivered",
      );
      assert.isNull(projection.runs.find((row) => row.id === runId)?.delegatedCompletion?.delivery);
      assert.lengthOf(
        statements.filter((statement) =>
          statement.includes("FROM orchestration_v2_projection_messages AS message"),
        ),
        1,
      );

      yield* orchestrator.recoverDelegatedTasks;
      const again = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(again.runs, projection.runs);
      assert.deepEqual(again.subagents, projection.subagents);
    }),
  );

  it.effect("settles a cancelled child whose held wakes wait behind it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:held-wake-parent");
      const projectId = ProjectId.make("project:held-wake-parent");
      const runId = RunId.make("run:held-wake-parent");
      const rootNodeId = NodeId.make("node:held-wake-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:held-wake-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "held-wake-child",
        completionWake: "always",
        continuationPending: false,
        now,
      });
      const held = runEvent({
        threadId: child.childThreadId,
        runId: RunId.make("run:held-wake-child:2"),
        ordinal: 2,
        status: "queued",
        now,
      });
      yield* eventSink.write({
        commandId: CommandId.make("command:held-wake-child:held"),
        events: [
          {
            ...held,
            payload: { ...held.payload, startedAt: null, completedAt: null, queueHeld: true },
          },
        ],
      });

      yield* orchestrator.recoverDelegatedTasks;

      const recovered = yield* orchestrator.getThreadProjection(threadId);
      const task = recovered.subagents.find((row) => row.id === child.taskId);
      assert.equal(task?.status, "cancelled");
      assert.isNotNull(task?.result ?? null);
      assert.isTrue(
        recovered.contextTransfers.some(
          (transfer) =>
            transfer.type === "subagent_result" && transfer.sourceThreadId === child.childThreadId,
        ),
      );
      assert.isFalse(yield* orchestrator.delegatedTaskResultPending(child.childThreadId));
      const childProjection = yield* orchestrator.getThreadProjection(child.childThreadId);
      assert.deepEqual(
        childProjection.runs.map((run) => [run.status, run.queueHeld ?? false]),
        [
          ["cancelled", false],
          ["queued", true],
        ],
      );
    }),
  );

  it.effect("settles a child whose provider failure holds its queued wakes", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:failed-hold-parent");
      const projectId = ProjectId.make("project:failed-hold-parent");
      const runId = RunId.make("run:failed-hold-parent");
      const rootNodeId = NodeId.make("node:failed-hold-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:failed-hold-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "failed-hold-child",
        completionWake: "always",
        continuationPending: false,
        now,
      });
      const activeRun = runEvent({
        threadId: child.childThreadId,
        runId: RunId.make("run:failed-hold-child:2"),
        ordinal: 2,
        status: "running",
        now,
      });
      const queued = runEvent({
        threadId: child.childThreadId,
        runId: RunId.make("run:failed-hold-child:3"),
        ordinal: 3,
        status: "queued",
        now,
      });
      yield* eventSink.write({
        commandId: CommandId.make("command:failed-hold-child:resumed"),
        events: [
          activeRun,
          { ...queued, payload: { ...queued.payload, startedAt: null, completedAt: null } },
        ],
      });
      const afterSequence = yield* eventSink.latestSequence();
      const errorItemId = TurnItemId.make("turn-item:failed-hold-child:error");
      yield* eventSink.write({
        commandId: CommandId.make("command:failed-hold-child:failed"),
        events: [
          {
            id: EventId.make("event:failed-hold-child:error"),
            type: "turn-item.updated",
            threadId: child.childThreadId,
            runId: activeRun.runId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: errorItemId,
              type: "error",
              threadId: child.childThreadId,
              runId: activeRun.runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "failed",
              title: "Provider failure",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure: {
                class: "provider_error",
                message: "Provider failed.",
                code: "provider_failed",
                retryable: null,
              },
            },
          },
          {
            ...activeRun,
            id: EventId.make("event:failed-hold-child:failed"),
            payload: { ...activeRun.payload, status: "failed", completedAt: now },
          },
        ],
      });

      const settled = yield* eventSink
        .stream({ afterSequence, eventType: "subagent.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" && stored.event.payload.id === child.taskId,
          ),
          Stream.take(1),
          Stream.runHead,
        );
      assert.isTrue(settled._tag === "Some");
      const recovered = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(recovered.subagents.find((row) => row.id === child.taskId)?.status, "failed");
      const childProjection = yield* orchestrator.getThreadProjection(child.childThreadId);
      assert.deepEqual(
        childProjection.runs.map((run) => [run.status, run.queueHeld ?? false]),
        [
          ["cancelled", false],
          ["failed", false],
          ["queued", true],
        ],
      );
    }),
  );

  it.effect("wakes the parent for a settled_only task once its spawning turn ended", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:settled-only-restart");
      const projectId = ProjectId.make("project:settled-only-restart");
      const runId = RunId.make("run:settled-only-restart");
      const rootNodeId = NodeId.make("node:settled-only-restart-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:settled-only-restart-settled"),
        deliveryState: "delivered",
        now,
      });
      yield* eventSink.write({
        commandId: reconcileCommandId("settled-only-restart"),
        events: [
          runEvent({
            threadId,
            runId,
            ordinal: 1,
            status: "cancelled",
            now,
            providerThreadId: parentProviderThreadId(threadId),
            userMessageId: MessageId.make(`message:seed-user:${threadId}`),
            delegatedCompletion: { disposition: "open", nextGeneration: 2, delivery: null },
          }),
          runEvent({
            threadId,
            runId: RunId.make("run:settled-only-restart:continuation"),
            ordinal: 2,
            status: "running",
            now,
            providerThreadId: parentProviderThreadId(threadId),
          }),
        ],
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "settled-only-restart-child",
        completionWake: "settled_only",
        continuationPending: false,
        now,
      });

      yield* orchestrator.recoverDelegatedTasks;

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        projection.subagents.find((row) => row.id === child.taskId)?.completionDelivery?.state,
        "claimed",
      );
      assert.deepEqual(
        projection.runs.find((row) => row.id === runId)?.delegatedCompletion?.delivery?.taskIds,
        [child.taskId],
      );
    }),
  );
});

it.layer(layerTest)("unstarted task-owned follow-ups after restart", (it) => {
  const cases = (["cancelled", "interrupted"] as const).flatMap((status) =>
    [1, 2, 4].flatMap((ordinal) =>
      (["none", "partial", "nested", "native"] as const).flatMap((work) =>
        (["startup", "prepared", "leftover"] as const).map((source) => ({
          status,
          ordinal,
          work,
          source,
        })),
      ),
    ),
  );
  it.effect.each(cases)(
    "handles $status follow-up $ordinal with $work work from $source",
    ({ status, ordinal, work, source }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const name = `unstarted-${status}-${ordinal}-${work}-${source}`;
        const threadId = ThreadId.make(`thread:${name}:parent`);
        const projectId = ProjectId.make(`project:${name}`);
        const runId = RunId.make(`run:${name}:parent`);
        const rootNodeId = NodeId.make(`node:${name}:parent`);
        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId,
          rootNodeId,
          taskId: NodeId.make(`node:${name}:seed`),
          deliveryState: "delivered",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId: runId,
          rootNodeId,
          name,
          completionWake: "always",
          continuationPending: true,
          continuationCommandId: CommandId.make(
            source === "startup"
              ? `command:runtime-reconcile:startup:${name}`
              : source === "prepared"
                ? `command:restart-prepare:${name}`
                : `command:runtime-reconcile:shutdown:${name}`,
          ),
          runStatus: status,
          ...(work === "partial" ? { partialResult: "Pending follow-up result" } : {}),
          now,
        });
        const before = yield* orchestrator.getThreadProjection(child.childThreadId);
        const current = before.runs[0]!;
        const parent = yield* orchestrator.getThreadProjection(threadId);
        const task = parent.subagents.find((row) => row.id === child.taskId)!;
        yield* sink.write({
          events: [
            {
              id: EventId.make(`${name}:origin`),
              type: "thread.metadata-updated",
              threadId: child.childThreadId,
              occurredAt: now,
              payload: {
                ...before.thread,
                forkedFrom:
                  ordinal === 1
                    ? before.thread.forkedFrom
                    : { type: "node", nodeId: NodeId.make(`${name}:previous-task`) },
              },
            },
            {
              id: EventId.make(`${name}:followup`),
              type: "run.updated",
              threadId: child.childThreadId,
              occurredAt: now,
              payload: { ...current, ordinal, startedAt: null, delegatedTaskId: child.taskId },
            },
            ...(ordinal === 1
              ? []
              : [
                  {
                    id: EventId.make(`${name}:previous-run`),
                    type: "run.created" as const,
                    threadId: child.childThreadId,
                    occurredAt: now,
                    payload: {
                      ...current,
                      id: RunId.make(`${name}:previous-run`),
                      ordinal: 1,
                      status: "completed" as const,
                      delegatedTaskId: NodeId.make(`${name}:previous-task`),
                    },
                  },
                ]),
            ...(work === "nested"
              ? [
                  {
                    id: EventId.make(`${name}:nested`),
                    type: "subagent.updated" as const,
                    threadId: child.childThreadId,
                    occurredAt: now,
                    payload: {
                      ...task,
                      id: NodeId.make(`${name}:nested`),
                      threadId: child.childThreadId,
                      runId: current.id,
                      origin: "provider_native" as const,
                      childThreadId: null,
                      completionDelivery: undefined,
                      status: "running" as const,
                    },
                  },
                ]
              : []),
            ...(work === "native"
              ? [
                  {
                    id: EventId.make(`${name}:native`),
                    type: "provider-thread.updated" as const,
                    threadId: child.childThreadId,
                    occurredAt: now,
                    payload: {
                      ...parent.providerThreads[0]!,
                      id: ProviderThreadId.make(`${name}:native`),
                      appThreadId: child.childThreadId,
                      pendingBackgroundTasks: [
                        { taskId: `${name}:native`, kind: "command" as const },
                      ],
                    },
                  },
                ]
              : []),
          ],
        });
        const pending = yield* orchestrator.delegatedTaskResultPending(
          child.childThreadId,
          child.taskId,
        );
        const shouldResume = (ordinal === 1 && source !== "leftover") || work !== "none";
        assert.equal(pending, shouldResume);
        yield* orchestrator.recoverDelegatedTasks;
        const recovered = (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
          (row) => row.id === child.taskId,
        )!;
        assert.equal(recovered.status, shouldResume ? "running" : status);
        if (!shouldResume) assert.isNotNull(recovered.result);
        else assert.isNull(recovered.result);
      }),
  );
});

describe("delegated background results", () => {
  it.effect.each([
    "wake",
    "single",
    "cancelled_wake",
    "cancelled_queued_wake",
    "foreign_task",
    "monitor_after_wake",
  ] as const)("delivers the task-scoped terminal result exactly once ($0)", (scenario) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const now = yield* DateTime.now;
      const id = (name: string) => `${name}:${scenario}`;
      const cancelled = scenario === "cancelled_wake" || scenario === "cancelled_queued_wake";
      const threadId = ThreadId.make(id("background-result-parent"));
      const projectId = ProjectId.make(id("background-result-project"));
      const runId = RunId.make(id("background-result-parent"));
      const rootNodeId = NodeId.make(id("background-result-root"));
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make(id("background-result-seed")),
        deliveryState: "acknowledged",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: id("background-result-child"),
        completionWake: "always",
        continuationPending: false,
        runStatus: "completed",
        partialResult:
          scenario === "single" || scenario === "foreign_task"
            ? "Single-turn result"
            : "waiting for background command",
        now,
      });
      const parent = yield* orchestrator.getThreadProjection(threadId);
      const original = (yield* orchestrator.getThreadProjection(child.childThreadId)).runs[0]!;
      const providerThread = {
        ...parent.providerThreads[0]!,
        id: ProviderThreadId.make(id("background-result-provider")),
        appThreadId: child.childThreadId,
        pendingBackgroundTasks:
          scenario === "single" || scenario === "foreign_task"
            ? []
            : [{ taskId: "background-command", kind: "command" as const }],
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make(id("background-result-tag")),
            type: "run.updated",
            threadId: child.childThreadId,
            occurredAt: now,
            payload: { ...original, delegatedTaskId: child.taskId },
          },
          {
            id: EventId.make(id("background-result-pending")),
            type: "provider-thread.updated",
            threadId: child.childThreadId,
            occurredAt: now,
            payload: providerThread,
          },
        ],
      });
      const layerStatus = OrchestratorMcpService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getCallerRow: (threadId) => Effect.succeed(liveThreadShell(threadId)),
              getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
              getThreadRecords: (threadId, fields, filter) =>
                orchestrator.getThreadRecords(threadId, fields, filter),
              delegatedTaskResultPending: (threadId, taskId) =>
                orchestrator.delegatedTaskResultPending(threadId, taskId),
              dispatch: (command) => orchestrator.dispatch(command),
            }),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
            Layer.mock(GitVcsDriver.GitVcsDriver)({}),
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
              list: () => Effect.succeed([]),
            }),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            ServerSettings.layerTest(),
            NodeServices.layer,
          ),
        ),
      );
      const readStatus = Effect.fn("backgroundResultTest.readStatus")(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.taskStatus(
          {
            environmentId: EnvironmentId.make("background-result-env"),
            requestNamespace: "background-result-test",
            thread: {
              threadId,
              providerInstanceId: modelSelection.instanceId,
              providerSessionId: "background-result-session",
            },
            client: undefined,
            capabilities: new Set(["orchestration"]),
            issuedAt: 1,
          },
          child.taskId,
        );
      }, Effect.provide(layerStatus));
      if (scenario !== "single" && scenario !== "foreign_task") {
        yield* orchestrator.recoverDelegatedTasks;
        const held = yield* orchestrator.getThreadProjection(threadId);
        assert.isNull(held.subagents.find((task) => task.id === child.taskId)!.result);
        assert.isEmpty(held.contextTransfers);
        assert.isNull(held.runs[0]!.delegatedCompletion!.delivery);
        const waiting = yield* readStatus();
        assert.equal(waiting.workState, "waiting_for_children");
        assert.isNull(waiting.summary);
        const activeWake = runEvent({
          threadId: child.childThreadId,
          runId: RunId.make(id("background-result-wake")),
          ordinal: 2,
          status: scenario === "cancelled_queued_wake" ? "queued" : "running",
          now,
        });
        yield* sink.write({
          events: [
            {
              ...activeWake,
              payload: {
                ...activeWake.payload,
                startedAt: scenario === "cancelled_queued_wake" ? null : now,
                completedAt: null,
              },
            },
            ...(scenario === "cancelled_queued_wake"
              ? [
                  {
                    id: EventId.make(id("background-result-wake-notification")),
                    type: "message.updated" as const,
                    threadId: child.childThreadId,
                    runId: activeWake.runId,
                    occurredAt: now,
                    payload: {
                      id: activeWake.payload.userMessageId,
                      threadId: child.childThreadId,
                      runId: activeWake.runId,
                      nodeId: null,
                      role: "user" as const,
                      text: "Background command completed",
                      attachments: [],
                      streaming: false,
                      createdBy: "system" as const,
                      creationSource: "server" as const,
                      createdAt: now,
                      updatedAt: now,
                      notification: {
                        source: { kind: "command" as const },
                        outcome: "completed" as const,
                        summary: "Background command completed",
                      },
                    },
                  },
                ]
              : []),
          ],
        });
        yield* orchestrator.recoverDelegatedTasks;
        const active = yield* readStatus();
        assert.equal(active.workState, "working");
        assert.isNull(active.summary);
        assert.isNull(
          (yield* orchestrator.getThreadProjection(threadId)).runs[0]!.delegatedCompletion!
            .delivery,
        );
      }

      const wakeRunId = RunId.make(id("background-result-wake"));
      const finalText = cancelled
        ? "Child task ended with status cancelled."
        : scenario === "single" || scenario === "foreign_task"
          ? "Single-turn result"
          : "WATCH_DONE: exit 0, 18:48:10 / 18:51:30";
      if (scenario !== "single") {
        const wakeRun = runEvent({
          threadId: child.childThreadId,
          runId: wakeRunId,
          ordinal: 2,
          status: cancelled ? "cancelled" : "completed",
          now,
        });
        yield* sink.write({
          events: [
            {
              id: EventId.make(id("background-result-cleared")),
              type: "provider-thread.updated",
              threadId: child.childThreadId,
              occurredAt: now,
              payload: { ...providerThread, pendingBackgroundTasks: [] },
            },
            ...(scenario === "cancelled_queued_wake"
              ? []
              : [
                  {
                    ...wakeRun,
                    payload: {
                      ...wakeRun.payload,
                      ...(scenario === "foreign_task"
                        ? { delegatedTaskId: NodeId.make("different-task") }
                        : {}),
                    },
                  },
                ]),
            ...(cancelled
              ? []
              : [
                  {
                    id: EventId.make(id("background-result-answer")),
                    type: "message.updated",
                    threadId: child.childThreadId,
                    runId: wakeRunId,
                    occurredAt: now,
                    payload: {
                      id: MessageId.make(id("background-result-answer")),
                      threadId: child.childThreadId,
                      runId: wakeRunId,
                      nodeId: null,
                      role: "assistant",
                      text: scenario === "foreign_task" ? "Another task's result" : finalText,
                      attachments: [],
                      streaming: false,
                      createdBy: "agent",
                      creationSource: "provider",
                      createdAt: now,
                      updatedAt: now,
                    },
                  } as const,
                ]),
          ],
        });
        if (scenario === "cancelled_queued_wake") {
          yield* orchestrator.dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(id("background-result-cancel-wake")),
            threadId: child.childThreadId,
            runId: wakeRunId,
          });
          const cancelledRun = (yield* orchestrator.getThreadProjection(
            child.childThreadId,
          )).runs.find((run) => run.id === wakeRunId)!;
          assert.equal(cancelledRun.status, "cancelled");
          assert.isNull(cancelledRun.startedAt);
        }
      }
      yield* orchestrator.recoverDelegatedTasks;
      const completed = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(completed.subagents.find((task) => task.id === child.taskId)!.result, finalText);
      assert.lengthOf(completed.contextTransfers, 1);
      assert.equal(
        completed.contextTransfers[0]!.sourcePoint.runId,
        scenario === "single" || scenario === "foreign_task" ? original.id : wakeRunId,
      );
      const wake = yield* requests.take;
      const delivery = completed.runs[0]!.delegatedCompletion!.delivery!;
      assert.equal(wake.delegatedCompletion?.messageId, delivery.messageId);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(id("background-result-delivery")),
        threadId,
        messageId: delivery.messageId,
        text: "Delegated task completed.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
        delegatedCompletion: {
          parentRunId: runId,
          generation: delivery.generation,
          taskIds: delivery.taskIds,
        },
      });
      yield* orchestrator.recoverDelegatedTasks;
      const delivered = yield* orchestrator.getThreadProjection(threadId);
      const notices = delivered.messages.filter(
        (message) => message.delegatedCompletion !== undefined,
      );
      assert.lengthOf(notices, 1);
      assert.include(notices[0]!.text, finalText);
      assert.notInclude(notices[0]!.text, "waiting for background command");
      assert.lengthOf(delivered.contextTransfers, 1);
      if (scenario === "monitor_after_wake") {
        const monitorRunId = RunId.make(id("background-result-monitor"));
        yield* sink.write({
          events: [
            runEvent({
              threadId: child.childThreadId,
              runId: monitorRunId,
              ordinal: 3,
              status: "completed",
              now,
            }),
            {
              id: EventId.make(id("background-result-monitor-message")),
              type: "message.updated",
              threadId: child.childThreadId,
              runId: monitorRunId,
              occurredAt: now,
              payload: {
                id: MessageId.make(id("background-result-monitor-message")),
                threadId: child.childThreadId,
                runId: monitorRunId,
                nodeId: null,
                role: "user",
                text: "Check current work",
                attachments: [],
                streaming: false,
                createdBy: "system",
                creationSource: "server",
                createdAt: now,
                updatedAt: now,
                notification: {
                  source: { kind: "monitor" },
                  outcome: "updated",
                  summary: "Check work",
                },
              },
            },
          ],
        });
      }
      const status = yield* readStatus();
      assert.equal(status.status, cancelled ? "cancelled" : "completed");
      assert.equal(status.summary, finalText);
      assert.equal(
        status.latestTerminalSummary,
        scenario === "foreign_task" ? "Another task's result" : null,
      );
      assert.equal(status.resultContextTransferId, completed.contextTransfers[0]!.id);
      assert.isNull(status.latestTerminalResultContextTransferId);
      assert.equal(
        status.latestTerminalRunId,
        scenario === "foreign_task" ? wakeRunId : completed.contextTransfers[0]!.sourcePoint.runId,
      );
    }).pipe(Effect.provide(Layer.merge(layerTest, ProviderContinuationRequests.layer))),
  );
});
