import * as DelegatedTaskProgressGuard from "../orchestration-v2/DelegatedTaskProgressGuard.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as TestClock from "effect/testing/TestClock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-test" };

it.effect("a silent delegated child stalls, notifies its parent, and can be cancelled again", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("task-cancel-native-subagent");
      const turns: Array<{
        readonly turn: ProviderAdapter.ProviderAdapterV2TurnInput;
        readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
      }> = [];
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
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
                capabilities: ClaudeProviderCapabilitiesV2,
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
                  nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
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
                  turns.push({ turn, events });
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: null,
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                  });
                }),
              steerTurn: () => Effect.void,
              interruptTurn: ({ providerTurnId, providerThread }) =>
                Effect.gen(function* () {
                  const entry = turns.find(
                    (entry) => entry.turn.threadId === providerThread.appThreadId,
                  )!;
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: providerTurnId,
                      providerThreadId: providerThread.id,
                      nodeId: entry.turn.rootNodeId,
                      runAttemptId: entry.turn.attemptId,
                      nativeTurnRef: null,
                      ordinal: entry.turn.providerTurnOrdinal,
                      status: "interrupted",
                      startedAt: now,
                      completedAt: yield* DateTime.now,
                    },
                  });
                  yield* Queue.offer(events, {
                    type: "turn.terminal",
                    driver,
                    providerThreadId: entry.turn.providerThread.id,
                    providerTurnId,
                    runOrdinal: entry.turn.runOrdinal,
                    status: "interrupted",
                    failure: null,
                    threadDisposition: "reusable",
                  });
                }),
              respondToRuntimeRequest: () => Effect.die("unused"),
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      const layerAdapters = ProviderAdapterRegistry.layerSingle(adapter);
      const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
        { name: "task-cancel-native-subagent" },
        layerAdapters,
        { runEffectWorker: false, runContinuationWorker: true },
      );
      const layerOrchestration = Layer.merge(
        layerOrchestrator,
        ThreadManagementService.layer.pipe(
          Layer.provide(layerOrchestrator),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(
            CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          ),
        ),
      );
      const layerGuard = DelegatedTaskProgressGuard.layer.pipe(Layer.provide(layerOrchestration));
      const layerTest = layerOrchestratorService.pipe(
        Layer.provideMerge(layerGuard),
        Layer.provideMerge(layerOrchestration),
        Layer.provide(
          Layer.mergeAll(
            layerAdapters,
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            ServerSettings.layerTest(),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            NodeServices.layer,
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const parentThreadId = ThreadId.make("thread:task-cancel-parent");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        const turnRunning = () =>
          watch(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-parent"),
          threadId: parentThreadId,
          projectId: ProjectId.make("project:task-cancel"),
          title: "Parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const parentRunning = yield* turnRunning();
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start-parent"),
          threadId: parentThreadId,
          messageId: MessageId.make("message:start-parent"),
          text: "Delegate a review",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(parentRunning);

        const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
        const childRunning = yield* turnRunning();
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("delegate"),
          parentThreadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          task: "Review the change",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* worker.drain();
        yield* Fiber.join(childRunning);
        const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
        const guard = yield* DelegatedTaskProgressGuard.DelegatedTaskProgressGuard;
        const now = yield* DateTime.now;
        const childProjection = yield* orchestrator.getThreadProjection(task.childThreadId!);
        const childRun = childProjection.runs[0]!;
        yield* guard.handle({
          id: EventId.make("guard-task"),
          type: "subagent.updated",
          threadId: parentThreadId,
          occurredAt: now,
          payload: task,
        });
        yield* guard.handle({
          id: EventId.make("guard-run"),
          type: "run.updated",
          threadId: task.childThreadId!,
          runId: childRun.id,
          occurredAt: now,
          payload: childRun,
        });
        const partial = {
          id: TurnItemId.make("partial"),
          threadId: task.childThreadId!,
          runId: childRun.id,
          nodeId: childRun.rootNodeId,
          providerThreadId: childRun.providerThreadId,
          providerTurnId: childProjection.providerTurns[0]!.id,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "assistant_message",
          messageId: MessageId.make("partial"),
          text: "I checked the first file.",
          phase: "narration",
          streaming: false,
        } as const;
        const partialStored = yield* watch(
          (event) => event.type === "turn-item.updated" && event.payload.id === partial.id,
        );
        const childRuntime = turns.find((entry) => entry.turn.threadId === task.childThreadId)!;
        yield* Queue.offer(childRuntime.events, {
          type: "turn_item.updated",
          driver,
          turnItem: partial,
        });
        yield* Fiber.join(partialStored);
        yield* guard.handle({
          id: EventId.make("guard-text"),
          type: "turn-item.updated",
          threadId: task.childThreadId!,
          runId: childRun.id,
          occurredAt: now,
          payload: partial,
        });
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:task-stall"),
          requestNamespace: "provider-session:task-stall",
          thread: {
            threadId: parentThreadId,
            providerSessionId: "provider-session:task-stall",
            providerInstanceId: instanceId,
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        const before = yield* service.taskStatus(scope, task.id);
        assert.equal(before.lastProgressKind, "assistant_text");
        assert.equal(before.lastProgressAt, DateTime.formatIso(now));
        yield* TestClock.adjust("16 minutes");
        const wake = yield* watch(
          (event) =>
            event.type === "message.updated" &&
            event.payload.delegatedCompletion?.taskIds.includes(task.id) === true,
        );
        const ended = yield* watch(
          (event) =>
            event.type === "subagent.updated" &&
            event.payload.id === task.id &&
            event.payload.status === "failed",
        );
        yield* guard.check();
        assert.isDefined(
          (yield* orchestrator.getThreadProjection(task.childThreadId!)).runs[0]!
            .delegatedTaskStall,
        );
        yield* worker.drain();
        yield* Fiber.join(ended);
        yield* Fiber.join(wake);
        yield* worker.drain();
        const after = yield* service.taskStatus(scope, task.id);
        assert.equal(after.status, "failed");
        assert.equal(after.failureReason, "stalled");
        assert.match(after.summary!, /^Stalled: no tool call or text for 15 min/);
        assert.include(after.summary!, DateTime.formatIso(now));
        assert.include(after.summary!, "I checked the first file.");
        const parentAfter = yield* orchestrator.getThreadProjection(parentThreadId);
        assert.include(parentAfter.subagents[0]!.result!, "Stalled:");
        assert.isTrue(parentAfter.messages.some((message) => message.text.includes("Stalled:")));
        const cancelled = yield* service.cancelTask(scope, {
          taskId: task.id,
          clientRequestId: "after-stall",
        });
        assert.equal(cancelled.status, "failed");
      }).pipe(Effect.provide(layerTest));
    }),
  ),
);
