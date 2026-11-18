import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as EventSink from "../orchestration-v2/EventSink.ts";
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
  RunAttemptId,
  RunId,
  RuntimeRequestId,
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

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
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
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

it.effect.each([
  "silent",
  "post_tool_recovery",
  "first_event_recovery",
  "first_event_recovery_terminal_completed",
  "first_event_recovery_terminal_cancelled",
  "first_event_recovery_terminal_failed",
  "first_event_adapter_owned_claude",
  "first_event_recovery_continuation_queued",
  "first_event_recovery_continuation_preparing",
  "first_event_recovery_continuation_starting",
  "first_event_recovery_network_continuation_queued",
  "first_event_recovery_network_continuation_preparing",
  "first_event_recovery_network_continuation_starting",
  "post_tool_adapter_owned_claude",
  "post_tool_recovery_race",
  "first_event_recovery_race",
  "reasoning_no_recovery",
  "command_execution",
  "dynamic_tool",
  "file_change",
  "file_search",
  "web_search",
  "subagent",
  "compaction",
  "assistant_text",
  "finished_tool",
  "approval",
  "question",
  "resolved_request",
  "new_attempt",
  "ended_run",
  "new_current_run",
] as const)("delegated stall commit: %s", (race) => {
  const recovering =
    (race.startsWith("post_tool") || race.startsWith("first_event")) && !race.endsWith("claude");
  const interruptedStatus = race.endsWith("_completed")
    ? "completed"
    : race.endsWith("_cancelled")
      ? "cancelled"
      : race.endsWith("_failed")
        ? "failed"
        : "interrupted";
  const recoveryRace = race.includes("_race");
  const firstEvent = race.startsWith("first_event");
  const postTool = race.startsWith("post_tool");
  const codex = (recovering || race === "reasoning_no_recovery") && !race.endsWith("claude");
  const driver = ProviderDriverKind.make(codex ? "codex" : "claudeAgent");
  const instanceId = ProviderInstanceId.make(driver);
  const modelSelection = {
    instanceId,
    model: codex ? "gpt-6.1-sol" : "claude-test",
    options: codex ? [{ id: "serviceTier", value: "default" }] : [{ id: "fastMode", value: false }],
  };
  const capabilities = codex ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2;
  return Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("task-cancel-native-subagent");
      const turns: Array<{
        readonly turn: ProviderAdapter.ProviderAdapterV2TurnInput;
        readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
      }> = [];
      let interrupts = 0;
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(capabilities),
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
                  interrupts += 1;
                  const entry = turns.findLast(
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
                      status: interruptedStatus,
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
                    threadDisposition: "reusable",
                    ...(interruptedStatus === "failed"
                      ? {
                          status: "failed" as const,
                          failureItemOrdinal: 101,
                          failure: {
                            class: "provider_error" as const,
                            message: "Old attempt failed during restart",
                            code: null,
                            retryable: false,
                          },
                        }
                      : { status: interruptedStatus, failure: null }),
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
        if (!firstEvent) {
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
        }
        if (postTool || race === "reasoning_no_recovery") {
          const item = {
            ...partial,
            id: TurnItemId.make("last-model-event"),
            ...(postTool
              ? {
                  type: "dynamic_tool" as const,
                  toolName: "t3-code.list_thread_pull_requests",
                  input: {},
                  output: "[]",
                }
              : { type: "reasoning" as const, text: "Thinking" }),
          };
          const stored = yield* watch(
            (event) => event.type === "turn-item.updated" && event.payload.id === item.id,
          );
          yield* Queue.offer(
            turns.findLast((entry) => entry.turn.threadId === task.childThreadId)!.events,
            { type: "turn_item.updated", driver, turnItem: item },
          );
          yield* Fiber.join(stored);
          yield* guard.handle({
            id: EventId.make("guard-last-event"),
            type: "turn-item.updated",
            threadId: task.childThreadId!,
            runId: childRun.id,
            occurredAt: now,
            payload: item,
          });
        }
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
        assert.equal(
          before.lastProgressKind,
          firstEvent ? "run_started" : postTool ? "dynamic_tool_finished" : "assistant_text",
        );
        assert.equal(before.lastProgressAt, DateTime.formatIso(now));
        yield* TestClock.adjust("16 minutes");
        let stalledAt = now;
        if (!codex && (firstEvent || postTool)) {
          const threads = yield* ThreadManagementService.ThreadManagementService;
          const rejected = yield* threads
            .sendToThread({
              threadId: task.childThreadId!,
              projectId: ProjectId.make("project:task-cancel"),
              commandId: CommandId.make("duplicate-claude-silent-recovery"),
              messageId: MessageId.make("duplicate-claude-silent-recovery"),
              mode: "restart",
              createdBy: "system",
              creationSource: "server",
              modelSelection,
              text: "Continue",
              attachments: [],
              delegatedTaskStallRecovery: {
                phase: postTool ? "post_tool" : "first_event",
                lastProgressAt: DateTime.formatIso(now),
                attemptId: childRun.activeAttemptId,
              },
            })
            .pipe(Effect.result);
          assert.equal(rejected._tag, "Failure");
          assert.equal(interrupts, 0);
          yield* guard.check();
          yield* worker.drain();
          const current = yield* orchestrator.getThreadProjection(task.childThreadId!);
          assert.lengthOf(current.attempts, 1);
          assert.isUndefined(current.runs[0]!.delegatedTaskStallRecovery);
          assert.equal(interrupts, 1);
          return;
        }
        if (recovering && recoveryRace) {
          const sink = yield* EventSink.EventSinkV2;
          const originalCommit = sink.commitCommand;
          let injected = false;
          Object.assign(sink, {
            commitCommand: (input: Parameters<typeof originalCommit>[0]) =>
              Effect.gen(function* () {
                if (!injected && input.commandType === "message.dispatch") {
                  injected = true;
                  const at = yield* DateTime.now;
                  yield* sink.write({
                    events: [
                      {
                        id: EventId.make("racing-recovery-output"),
                        type: "turn-item.updated",
                        threadId: task.childThreadId!,
                        runId: childRun.id,
                        occurredAt: at,
                        payload: { ...partial, text: "New output before recovery", updatedAt: at },
                      },
                    ],
                  });
                }
                return yield* originalCommit(input);
              }),
          });
          yield* guard.check();
          assert.isTrue(injected);
          yield* worker.drain();
          const current = (yield* orchestrator.getThreadProjection(task.childThreadId!)).runs[0]!;
          assert.isUndefined(current.delegatedTaskStallRecovery);
          assert.isUndefined(current.delegatedTaskStall);
          assert.equal(
            turns.filter((entry) => entry.turn.threadId === task.childThreadId).length,
            1,
          );
          return;
        }
        if (recovering) {
          const networkContinuation = race.includes("_network_continuation_");
          let recovered = childRun;
          if (!networkContinuation) {
            const running = yield* turnRunning();
            yield* guard.check();
            assert.isDefined(
              (yield* orchestrator.getThreadProjection(task.childThreadId!)).runs[0]!
                .delegatedTaskStallRecovery,
            );
            yield* worker.drain();
            yield* Fiber.join(running);
            const restartedProjection = yield* orchestrator.getThreadProjection(
              task.childThreadId!,
            );
            recovered = restartedProjection.runs[0]!;
            assert.equal(recovered.status, "running");
            assert.lengthOf(restartedProjection.attempts, 2);
            assert.equal(
              restartedProjection.attempts.find(
                (attempt) => attempt.id === childRun.activeAttemptId,
              )?.status,
              "superseded",
            );
            assert.equal(
              restartedProjection.providerTurns.find(
                (turn) => turn.runAttemptId === childRun.activeAttemptId,
              )?.status,
              interruptedStatus,
            );
            assert.equal(recovered.id, childRun.id);
            assert.equal(recovered.providerThreadId, childRun.providerThreadId);
            assert.notEqual(recovered.activeAttemptId, childRun.activeAttemptId);
            assert.equal(
              recovered.delegatedTaskStallRecovery?.phase,
              postTool ? "post_tool" : "first_event",
            );
            const restarted = turns.findLast(
              (entry) => entry.turn.threadId === task.childThreadId,
            )!.turn;
            assert.deepEqual(restarted.modelSelection, childRun.modelSelection);
            assert.include(
              restarted.message.text,
              postTool ? "Write your final report now from what you have." : "Review the change",
            );
          }
          if (race.includes("_continuation_")) {
            const queued = race.endsWith("queued");
            const continuationSource: typeof recovered = networkContinuation
              ? {
                  ...recovered,
                  transientRecovery: {
                    firstError: {
                      class: "transport_error" as const,
                      category: "transient" as const,
                      code: "claude_network_error",
                      retryable: true,
                      message: "Connection dropped (ECONNRESET)",
                    },
                    since: DateTime.formatIso(yield* DateTime.now),
                  },
                }
              : recovered;
            const sink = yield* EventSink.EventSinkV2;
            const bootCommandId = CommandId.make("command:runtime-reconcile:startup:boot");
            yield* sink.writeWithEffects({
              commandId: bootCommandId,
              events: [
                {
                  id: EventId.make("boot-interrupted"),
                  type: "run.updated",
                  threadId: task.childThreadId!,
                  runId: recovered.id,
                  occurredAt: yield* DateTime.now,
                  payload: {
                    ...continuationSource,
                    status: queued ? "waiting" : "interrupted",
                    completedAt: yield* DateTime.now,
                    ...(queued
                      ? {
                          restartCancelledBackgroundWork: [{ kind: "task", label: "Pending work" }],
                        }
                      : {}),
                  },
                },
              ],
              effects: [
                {
                  id: `effect:restart-continuation:${recovered.id}`,
                  commandId: bootCommandId,
                  threadId: task.childThreadId!,
                  request: { type: "provider-runtime.continue", sourceRunId: recovered.id },
                },
              ],
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("boot-continuation"),
              threadId: task.childThreadId!,
              messageId: MessageId.make("boot-continuation"),
              restartContinuationOfRunId: recovered.id,
              text: "Continue",
              attachments: [],
              dispatchMode: {
                type: queued
                  ? "queue_after_active"
                  : race.endsWith("preparing")
                    ? "defer_start"
                    : "start_immediately",
              },
              modelSelection,
              createdBy: "agent",
              creationSource: "server",
            });
            const continuation = (yield* orchestrator.getThreadProjection(
              task.childThreadId!,
            )).runs.at(-1)!;
            assert.notEqual(continuation.id, recovered.id);
            assert.equal(
              continuation.status,
              queued ? "queued" : race.endsWith("preparing") ? "preparing" : "starting",
            );
            assert.equal(continuation.delegatedTaskId, recovered.delegatedTaskId);
            assert.deepEqual(
              continuation.delegatedTaskStallRecovery,
              continuationSource.delegatedTaskStallRecovery,
            );
            assert.deepEqual(continuation.transientRecovery, continuationSource.transientRecovery);
            return;
          }
          stalledAt = yield* DateTime.now;
          yield* guard.handle({
            id: EventId.make("guard-recovered"),
            type: "run.updated",
            threadId: task.childThreadId!,
            runId: recovered.id,
            occurredAt: stalledAt,
            payload: recovered,
          });
          yield* TestClock.adjust("16 minutes");
        }
        if (!recovering && race !== "silent" && race !== "reasoning_no_recovery") {
          const sink = yield* EventSink.EventSinkV2;
          const originalCommit = sink.commitCommand;
          let injected = false;
          let attemptedCommand: CommandId | undefined;
          Object.assign(sink, {
            commitCommand: (input: Parameters<typeof originalCommit>[0]) =>
              Effect.gen(function* () {
                if (!injected && input.commandType === "run.interrupt") {
                  injected = true;
                  attemptedCommand = input.commandId;
                  const racedAt = yield* DateTime.now;
                  const childRuntime = turns.find(
                    (entry) => entry.turn.threadId === task.childThreadId,
                  )!;
                  if (
                    race === "new_attempt" ||
                    race === "ended_run" ||
                    race === "new_current_run"
                  ) {
                    const nextRun =
                      race === "new_attempt"
                        ? { ...childRun, activeAttemptId: RunAttemptId.make("new-attempt") }
                        : race === "ended_run"
                          ? { ...childRun, status: "completed" as const, completedAt: racedAt }
                          : {
                              ...childRun,
                              id: RunId.make("new-current-run"),
                              ordinal: childRun.ordinal + 1,
                            };
                    yield* sink.write({
                      events: [
                        {
                          id: EventId.make("racing-run"),
                          type: race === "new_current_run" ? "run.created" : "run.updated",
                          threadId: task.childThreadId!,
                          runId: nextRun.id,
                          occurredAt: racedAt,
                          payload: nextRun,
                        },
                      ],
                    });
                  } else if (
                    race === "approval" ||
                    race === "question" ||
                    race === "resolved_request"
                  ) {
                    const requestId = RuntimeRequestId.make("racing-request");
                    const stored = yield* watch(
                      (event) =>
                        event.type === "runtime-request.updated" && event.payload.id === requestId,
                    );
                    yield* Queue.offer(childRuntime.events, {
                      type: "runtime_request.updated",
                      driver,
                      threadId: task.childThreadId!,
                      runtimeRequest: {
                        id: requestId,
                        nodeId: childRuntime.turn.rootNodeId,
                        providerTurnId: partial.providerTurnId,
                        nativeRequestRef: null,
                        kind: race === "approval" ? "command" : "user_input",
                        status: race === "resolved_request" ? "resolved" : "pending",
                        responseCapability: {
                          type: "live",
                          providerSessionId: childProjection.providerThreads[0]!.providerSessionId!,
                        },
                        createdAt: racedAt,
                        resolvedAt: race === "resolved_request" ? racedAt : null,
                      },
                    });
                    yield* Fiber.join(stored);
                  } else {
                    const base = {
                      ...partial,
                      id: TurnItemId.make("racing-item"),
                      status: "running" as const,
                      startedAt: racedAt,
                      completedAt: null,
                      updatedAt: racedAt,
                    };
                    const item =
                      race === "assistant_text"
                        ? {
                            ...base,
                            type: "assistant_message" as const,
                            text: "New assistant text",
                          }
                        : race === "dynamic_tool"
                          ? {
                              ...base,
                              type: "dynamic_tool" as const,
                              toolName: "long_task",
                              input: {},
                            }
                          : race === "file_change"
                            ? { ...base, type: "file_change" as const, fileName: "result.txt" }
                            : race === "file_search"
                              ? { ...base, type: "file_search" as const }
                              : race === "web_search"
                                ? { ...base, type: "web_search" as const }
                                : race === "compaction"
                                  ? { ...base, type: "compaction" as const, driver }
                                  : race === "subagent"
                                    ? {
                                        ...base,
                                        type: "subagent" as const,
                                        subagentId: childRun.delegatedTaskId!,
                                        origin: "provider_native" as const,
                                        driver,
                                        providerInstanceId: instanceId,
                                        childThreadId: null,
                                        prompt: "Long native call",
                                        result: null,
                                      }
                                    : {
                                        ...base,
                                        type: "command_execution" as const,
                                        input: "offbox run -- long-test",
                                        ...(race === "finished_tool"
                                          ? { status: "completed" as const, completedAt: racedAt }
                                          : {}),
                                      };
                    const stored = yield* watch(
                      (event) => event.type === "turn-item.updated" && event.payload.id === item.id,
                    );
                    yield* Queue.offer(childRuntime.events, {
                      type: "turn_item.updated",
                      driver,
                      turnItem: item,
                    });
                    yield* Fiber.join(stored);
                  }
                }
                return yield* originalCommit(input);
              }),
          });
          yield* guard.check();
          assert.isTrue(injected);
          const after = yield* orchestrator.getThreadProjection(task.childThreadId!);
          assert.isUndefined(after.runs.find((run) => run.id === childRun.id)!.delegatedTaskStall);
          assert.isDefined(attemptedCommand);
          const threads = yield* ThreadManagementService.ThreadManagementService;
          assert.isFalse(yield* threads.hasReceipt(attemptedCommand!));
          yield* worker.drain();
          assert.equal(interrupts, 0);
          return;
        }
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
        assert.match(after.summary!, /^stalled: no model output for 16 min/);
        assert.isTrue(after.resultLooksIncomplete);
        if (!firstEvent)
          assert.include(after.incompleteReason!, "its last text was a progress note");
        assert.include(after.summary!, DateTime.formatIso(stalledAt));
        if (!firstEvent) assert.include(after.summary!, "I checked the first file.");
        if (recovering)
          assert.equal(
            turns.filter((entry) => entry.turn.threadId === task.childThreadId).length,
            2,
          );
        const parentAfter = yield* orchestrator.getThreadProjection(parentThreadId);
        assert.include(parentAfter.subagents[0]!.result!, "stalled:");
        assert.isTrue(parentAfter.messages.some((message) => message.text.includes("stalled:")));
        const cancelled = yield* service.cancelTask(scope, {
          taskId: task.id,
          clientRequestId: "after-stall",
        });
        assert.equal(cancelled.status, "failed");
      }).pipe(Effect.provide(layerTest));
    }),
  );
});
