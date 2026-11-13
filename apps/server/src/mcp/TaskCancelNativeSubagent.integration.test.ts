import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import { continueRestartedRun } from "../orchestration-v2/RestartContinuation.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
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

// A delegated Claude child ends its turn while a background native subagent it
// started keeps running (#17154).

it.effect.each([
  "native_background",
  "external_interrupt",
  "restart_without_result",
  "restart_legacy_without_result",
  "restart_legacy_continuation_with_result",
  "restart_disposed_queue",
  "restart_with_result",
] as const)("task status and cancellation settle %s", (scenario) =>
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
              steerTurn: () => Effect.die("unused"),
              interruptTurn: () => Effect.void,
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
        { runEffectWorker: false },
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
      const layerTest = layerOrchestratorService.pipe(
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
        const child = turns.find((entry) => entry.turn.threadId === task.childThreadId)!;
        const childTurn = (yield* orchestrator.getThreadProjection(task.childThreadId!))
          .providerTurns[0]!;

        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:task-cancel"),
          requestNamespace: "provider-session:task-cancel",
          thread: {
            threadId: parentThreadId,
            providerSessionId: "provider-session:task-cancel",
            providerInstanceId: instanceId,
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        if (scenario !== "native_background") {
          const sink = yield* EventSink.EventSinkV2;
          const before = yield* orchestrator.getThreadProjection(task.childThreadId!);
          const run = before.runs[0]!;
          const now = yield* DateTime.now;
          const hasResult =
            scenario === "restart_with_result" ||
            scenario === "restart_disposed_queue" ||
            scenario === "restart_legacy_continuation_with_result";
          if (scenario === "external_interrupt") {
            const settled = yield* watch(
              (event) =>
                event.type === "subagent.updated" &&
                event.payload.id === task.id &&
                event.payload.status === "interrupted",
            );
            yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("external-stop"),
              threadId: task.childThreadId!,
              runId: run.id,
              reason: "Stopped by server maintenance",
            });
            yield* Queue.offer(child.events, {
              type: "turn.terminal",
              driver,
              providerThreadId: childTurn.providerThreadId,
              providerTurnId: childTurn.id,
              runOrdinal: run.ordinal,
              status: "interrupted",
              failure: null,
              threadDisposition: "reusable",
            });
            yield* Fiber.join(settled);
            yield* worker.drain();
            const ended = yield* orchestrator.getThreadProjection(task.childThreadId!);
            const interrupt = ended.turnItems.find((item) => item.type === "run_interrupt_result");
            assert.equal(
              interrupt?.type === "run_interrupt_result" ? interrupt.message : null,
              "Run interrupted: Stopped by server maintenance",
            );
          } else {
            const commandId = CommandId.make("command:runtime-reconcile:shutdown:test-child");
            const cutRun = { ...run };
            if (
              scenario === "restart_legacy_without_result" ||
              scenario === "restart_legacy_continuation_with_result"
            )
              delete cutRun.delegatedTaskId;
            const resultRunId =
              scenario === "restart_legacy_continuation_with_result"
                ? RunId.make("run:legacy-continuation")
                : run.id;
            yield* sink.writeWithEffects({
              commandId,
              events: [
                {
                  id: EventId.make("restart-cancelled-turn"),
                  type: "provider-turn.updated",
                  threadId: task.childThreadId!,
                  runId: run.id,
                  occurredAt: now,
                  payload: { ...childTurn, status: "cancelled", completedAt: now },
                },
                {
                  id: EventId.make("restart-cancelled-child"),
                  type: "run.updated",
                  threadId: task.childThreadId!,
                  runId: run.id,
                  occurredAt: now,
                  payload: {
                    ...cutRun,
                    status: "cancelled",
                    completedAt: now,
                  },
                },
                ...(scenario === "restart_legacy_continuation_with_result"
                  ? [
                      {
                        id: EventId.make("legacy-continuation-cancelled"),
                        type: "run.updated" as const,
                        threadId: task.childThreadId!,
                        occurredAt: now,
                        payload: {
                          ...cutRun,
                          id: resultRunId,
                          ordinal: 2,
                          status: "cancelled" as const,
                          restartContinuationOfRunId: run.id,
                          completedAt: now,
                        },
                      },
                    ]
                  : []),
                ...(hasResult
                  ? [
                      {
                        id: EventId.make("child-result"),
                        type: "message.updated" as const,
                        threadId: task.childThreadId!,
                        runId: resultRunId,
                        occurredAt: now,
                        payload: {
                          id: MessageId.make("message:child-result"),
                          threadId: task.childThreadId!,
                          runId: resultRunId,
                          nodeId: run.rootNodeId,
                          role: "assistant" as const,
                          createdBy: "agent" as const,
                          creationSource: "provider" as const,
                          text: "Partial review before restart",
                          attachments: [],
                          streaming: false,
                          createdAt: now,
                          updatedAt: now,
                        },
                      },
                    ]
                  : []),
              ],
              effects: [
                {
                  id: `effect:restart-continuation:${resultRunId}`,
                  commandId,
                  threadId: task.childThreadId!,
                  request: { type: "provider-runtime.continue", sourceRunId: resultRunId },
                },
              ],
            });
            const firstPoll = yield* service.taskStatus(scope, task.id);
            assert.equal(firstPoll.status, hasResult ? "running" : "cancelled");
            assert.equal(firstPoll.workState, hasResult ? "working" : "result_available");
            if (!hasResult) {
              // The status was exposed before recovery published the task row.
              // A delayed restart must fence publication and decline admission.
              yield* continueRestartedRun({
                threadId: task.childThreadId!,
                sourceRunId: run.id,
              }).pipe(
                Effect.provide(
                  ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
                ),
              );
              assert.lengthOf(
                (yield* orchestrator.getThreadProjection(task.childThreadId!)).runs,
                1,
              );
            }
            if (scenario === "restart_disposed_queue") {
              yield* orchestrator.dispatch({
                type: "delegated_task.completion-delivery.dispose",
                commandId: CommandId.make("dispose-before-cancel"),
                parentThreadId,
                taskId: task.id,
              });
              yield* sink.write({
                events: [
                  {
                    id: EventId.make("held-later-run"),
                    type: "run.updated",
                    threadId: task.childThreadId!,
                    occurredAt: now,
                    payload: {
                      ...run,
                      id: RunId.make("run:held-later"),
                      ordinal: 2,
                      status: "queued",
                      queueHeld: true,
                      queuePosition: 1,
                      startedAt: null,
                      completedAt: null,
                      delegatedTaskId: NodeId.make("node:later-task"),
                    },
                  },
                ],
              });
            }
            // Recovery must settle a resultless cancellation even while its old
            // continuation effect is still pending; a real result stays held.
            yield* orchestrator.recoverDelegatedTasks;
          }
          const status = yield* service.taskStatus(scope, task.id);
          const held = hasResult;
          assert.equal(
            status.status,
            held ? "running" : scenario === "external_interrupt" ? "interrupted" : "cancelled",
          );
          assert.equal(status.workState, held ? "working" : "result_available");
          assert.isNull(status.currentRunId);
          assert.isFalse(status.hasPendingChildRuns);
          assert.equal(
            status.latestTerminalStatus,
            scenario === "external_interrupt" ? "interrupted" : "cancelled",
          );
          if (held) assert.isNull(status.summary);
          if (scenario === "restart_without_result") {
            yield* continueRestartedRun({
              threadId: task.childThreadId!,
              sourceRunId: run.id,
            }).pipe(
              Effect.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true })),
            );
            const recovered = yield* orchestrator.getThreadProjection(task.childThreadId!);
            assert.lengthOf(recovered.runs, 1);
          }
          const write = sink.writeWithEffects;
          let failedSettlement = false;
          const settlement =
            scenario === "restart_disposed_queue"
              ? vi.spyOn(sink, "writeWithEffects").mockImplementation((input) => {
                  if (
                    !failedSettlement &&
                    input.events.some(
                      (event) =>
                        event.type === "subagent.updated" &&
                        event.payload.id === task.id &&
                        event.payload.status === "cancelled",
                    )
                  ) {
                    failedSettlement = true;
                    return Effect.fail(
                      new EventSink.EventSinkWriteError({ eventCount: input.events.length }),
                    );
                  }
                  return write(input);
                })
              : undefined;
          const cancel = service.cancelTask(scope, {
            taskId: task.id,
            clientRequestId: "cancel-ended-task",
          });
          if (scenario === "restart_disposed_queue") {
            const failed = yield* cancel.pipe(
              Effect.flip,
              Effect.ensuring(Effect.sync(() => settlement?.mockRestore())),
            );
            assert.equal(failed.code, "task_not_cancellable");
            assert.isTrue(failedSettlement);
            const unsettled = (yield* orchestrator.getThreadProjection(
              parentThreadId,
            )).subagents.find((row) => row.id === task.id)!;
            assert.equal(unsettled.status, "running");
            assert.isNull(unsettled.result);
          }
          // Replaying Stop must still settle a failed result write, independently
          // of its command receipt and already-disposed completion delivery.
          const cancelled = yield* cancel.pipe(
            Effect.ensuring(Effect.sync(() => settlement?.mockRestore())),
          );
          assert.equal(
            cancelled.status,
            scenario === "external_interrupt" ? "interrupted" : "cancelled",
          );
          const parentAfter = yield* orchestrator.getThreadProjection(parentThreadId);
          const settledTask = parentAfter.subagents.find((row) => row.id === task.id)!;
          assert.equal(
            settledTask.status,
            scenario === "external_interrupt" ? "interrupted" : "cancelled",
          );
          assert.isNotNull(settledTask.result);
          assert.equal(settledTask.completionDelivery?.state, "disposed");
          return;
        }
        const now = yield* DateTime.now;
        const subagentId = NodeId.make("node:native-subagent");
        const native = {
          threadId: task.childThreadId!,
          runId: child.turn.runId,
          origin: "provider_native",
          driver,
          providerInstanceId: instanceId,
          providerThreadId: childTurn.providerThreadId,
          childThreadId: null,
          prompt: "Check the tests",
          title: null,
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        } as const;
        const waiting = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === child.turn.runId &&
            event.payload.status === "waiting",
        );
        for (const event of [
          {
            type: "node.updated",
            driver,
            node: {
              id: subagentId,
              threadId: native.threadId,
              runId: native.runId,
              parentNodeId: child.turn.rootNodeId,
              rootNodeId: child.turn.rootNodeId,
              kind: "subagent",
              status: "running",
              countsForRun: false,
              providerThreadId: childTurn.providerThreadId,
              providerTurnId: childTurn.id,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: null,
            },
          },
          {
            type: "subagent.updated",
            driver,
            subagent: {
              ...native,
              id: subagentId,
              parentNodeId: child.turn.rootNodeId,
              createdBy: "agent",
              nativeTaskRef: null,
              model: null,
            },
          },
          {
            type: "turn_item.updated",
            driver,
            turnItem: {
              ...native,
              id: TurnItemId.make("turn-item:native-subagent"),
              nodeId: subagentId,
              providerTurnId: childTurn.id,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              type: "subagent",
              subagentId,
            },
          },
          {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...childTurn, status: "completed", completedAt: now },
          },
          {
            type: "turn.terminal",
            driver,
            providerThreadId: childTurn.providerThreadId,
            providerTurnId: childTurn.id,
            runOrdinal: child.turn.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          },
        ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) {
          yield* Queue.offer(child.events, event);
        }
        yield* Fiber.join(waiting);
        yield* worker.drain();

        const before = yield* service.taskStatus(scope, task.id);
        assert.equal(before.status, "running");
        assert.equal(before.workState, "waiting_for_children");

        const cancelled = yield* service.cancelTask(scope, {
          taskId: task.id,
          clientRequestId: "cancel-task",
        });
        assert.include(["cancel_requested", "completed"], cancelled.status);
        yield* worker.drain();

        const childAfter = yield* orchestrator.getThreadProjection(task.childThreadId!);
        assert.equal(
          childAfter.subagents.find((entry) => entry.id === subagentId)?.status,
          "interrupted",
        );
        assert.equal(
          childAfter.nodes.find((entry) => entry.id === subagentId)?.status,
          "interrupted",
        );
        assert.equal(
          childAfter.turnItems.find((item) => item.type === "subagent")?.status,
          "interrupted",
        );

        const after = yield* service.taskStatus(scope, task.id);
        assert.equal(after.status, "completed");
        assert.notEqual(after.workState, "waiting_for_children");
      }).pipe(Effect.provide(layerTest));
    }),
  ),
);
