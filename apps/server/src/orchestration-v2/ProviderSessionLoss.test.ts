import { assert, it } from "@effect/vitest";
import {
  CommandId,
  CheckpointScopeId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  ProviderThreadId,
  RunAttemptId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { vi } from "vite-plus/test";
import * as Sqlite from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Registry from "./ProviderAdapterRegistry.ts";
import * as RunExecution from "./RunExecutionService.ts";
import * as Sessions from "./ProviderSessionManager.ts";
import * as Harness from "./testkit/ProviderReplayHarness.ts";
import { userFacingDispatchErrorMessage } from "./UserFacingErrors.ts";

const sessionLoss = ({
  instance,
  reason,
  replace = false,
  promotion = false,
  accepted,
  faultRead = false,
  activeTurnOnly = false,
  delivered = false,
  terminalBeforeRelease,
  markerFailure = false,
  nativeThreads = false,
  shared = true,
  buffered,
}: {
  instance: "codex" | "codex-cu" | "opencode";
  reason: Sessions.ProviderSessionReleaseReason;
  replace?: boolean;
  promotion?: boolean;
  accepted?: "before recovery" | "after recovery" | "replacement session" | "blocked closure";
  faultRead?: boolean;
  activeTurnOnly?: boolean;
  delivered?: boolean;
  terminalBeforeRelease?: "completed" | "failed" | "interrupted" | "cancelled";
  markerFailure?: boolean;
  nativeThreads?: boolean;
  shared?: boolean;
  buffered?: "new turn" | "running update";
}) =>
  Effect.gen(function* () {
    const allAdmitted = yield* Deferred.make<void>();
    const admitted = yield* Deferred.make<void>();
    const resumeIngestion = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    const closing = yield* Deferred.make<void>();
    const finishClose = yield* Deferred.make<void>();
    const instanceId = ProviderInstanceId.make(instance);
    const driver = ProviderDriverKind.make(instance === "opencode" ? "opencode" : "codex");
    const modelSelection = { instanceId, model: "test" };
    const sessionId = ProviderSessionId.make(
      `provider-session:provider-instance:${instance}:shared`,
    );
    const capabilities = {
      ...CodexProviderCapabilitiesV2,
      sessions: {
        ...CodexProviderCapabilitiesV2.sessions,
        supportsMultipleProviderThreadsPerSession: shared,
      },
    };
    const adapter = {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(capabilities),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
      openSession: () =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(closing, undefined).pipe(Effect.andThen(Deferred.await(finishClose))),
          );
          return {
            instanceId,
            driver,
            providerSessionId: sessionId,
            providerSession: {
              id: sessionId,
              driver,
              providerInstanceId: instanceId,
              status: "ready",
              cwd: process.cwd(),
              model: "test",
              capabilities,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
            events: buffered
              ? Stream.fromQueue(events).pipe(
                  Stream.rechunk(1),
                  Stream.tap((event) =>
                    event.type === "provider_session.updated"
                      ? Deferred.succeed(allAdmitted, undefined)
                      : Effect.void,
                  ),
                )
              : Stream.never,
            startTurn: () => Effect.void,
            interruptTurn: () => Effect.void,
            awaitSessionExit: Effect.void,
            ...(instance === "opencode" ? {} : { backgroundTasksEndWithProcess: true }),
            steerTurn: ({
              providerThread,
              providerTurnId,
            }: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["steerTurn"]>[0]) =>
              Effect.fail(
                new ProviderAdapter.ProviderAdapterSteerRunError({
                  driver,
                  providerThreadId: providerThread.id,
                  providerTurnId,
                  cause: "The replacement does not own the old turn.",
                }),
              ),
          } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
        }),
    } as ProviderAdapter.ProviderAdapterV2["Service"];
    let firstIngest = true;
    const afterProviderEvent = Effect.gen(function* () {
      if (!firstIngest) return;
      firstIngest = false;
      yield* Deferred.succeed(admitted, undefined);
      yield* Deferred.await(resumeIngestion);
    });
    const database = Sqlite.layerMemory;
    const layer = Layer.mergeAll(
      ProjectionStore.layer.pipe(Layer.provide(database)),
      EffectOutbox.layer.pipe(Layer.provide(database)),
      Harness.layerWithRegistry(
        { name: `session-loss-${instance}` },
        Registry.layerFromAdapters([adapter]),
        {
          databaseLayer: database,
          runEffectWorker: false,
          ...(buffered ? { afterProviderEvent } : {}),
        },
      ),
    );
    yield* Effect.gen(function* () {
      const engine = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const sessions = yield* Sessions.ProviderSessionManagerV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threads = shared
        ? [ThreadId.make("session-loss-a"), ThreadId.make("session-loss-b")]
        : [ThreadId.make("session-loss-a")];
      const targets = [];
      for (const threadId of threads) {
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${threadId}`),
          threadId,
          projectId: ProjectId.make("project:session-loss"),
          title: "Session loss",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* engine.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`initial:${threadId}`),
          threadId,
          messageId: MessageId.make(`initial:${threadId}`),
          text: "initial",
          attachments: [],
          dispatchMode: { type: "defer_start" },
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* sessions.open({
          threadId,
          providerSessionId: sessionId,
          modelSelection,
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
          },
        });
        const before = yield* projections.getThreadProjection(threadId);
        const run = before.runs[0]!;
        const attempt = before.attempts[0]!;
        const root = before.nodes.find((node) => node.id === run.rootNodeId)!;
        const providerThread = before.providerThreads[0]!;
        const now = yield* DateTime.now;
        const turn = {
          id: ProviderTurnId.make(`turn:${threadId}`),
          providerThreadId: providerThread.id,
          nodeId: root.id,
          runAttemptId: attempt.id,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running" as const,
          startedAt: now,
          completedAt: null,
        };
        yield* sink.write({
          events: [
            {
              id: EventId.make(`bind:${threadId}`),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...providerThread,
                providerSessionId: sessionId,
                status: "active",
                lastRunOrdinal: run.ordinal,
                pendingBackgroundTasks:
                  instance === "opencode" ? [{ taskId: "remote-work", kind: "subagent" }] : [],
              },
            },
            {
              id: EventId.make(`run:${threadId}`),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...run, status: "running", startedAt: now },
            },
            {
              id: EventId.make(`attempt:${threadId}`),
              type: "run-attempt.updated",
              threadId,
              occurredAt: now,
              payload: { ...attempt, status: "running", providerTurnId: turn.id },
            },
            {
              id: EventId.make(`node:${threadId}`),
              type: "node.updated",
              threadId,
              occurredAt: now,
              payload: { ...root, status: "running", checkpointScopeId: null },
            },
            {
              id: EventId.make(`turn:${threadId}`),
              type: "provider-turn.updated",
              threadId,
              occurredAt: now,
              payload: turn,
            },
          ],
        });
        if (
          !(
            threadId === threads[0] &&
            terminalBeforeRelease !== undefined &&
            accepted !== undefined &&
            !nativeThreads
          )
        ) {
          const childId = NodeId.make(`remote:${threadId}`);
          yield* sink.write({
            events: [
              {
                id: EventId.make(`remote-node:${threadId}`),
                type: "node.updated",
                threadId,
                occurredAt: now,
                payload: {
                  ...root,
                  id: childId,
                  kind: "subagent",
                  parentNodeId: root.id,
                  providerTurnId: turn.id,
                  status: "running",
                  checkpointScopeId: null,
                },
              },
              {
                id: EventId.make(`remote-task:${threadId}`),
                type: "subagent.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: childId,
                  threadId,
                  runId: run.id,
                  parentNodeId: root.id,
                  origin: "provider_native",
                  createdBy: "agent",
                  driver,
                  providerInstanceId: instanceId,
                  providerThreadId: providerThread.id,
                  childThreadId: null,
                  nativeTaskRef: { driver, nativeId: "remote-work", strength: "strong" },
                  prompt: "remote task",
                  title: null,
                  model: null,
                  status: "running",
                  result: null,
                  startedAt: now,
                  completedAt: null,
                  updatedAt: now,
                },
              },
              {
                id: EventId.make(`remote-item:${threadId}`),
                type: "turn-item.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make(`remote-item:${threadId}`),
                  threadId,
                  runId: run.id,
                  nodeId: root.id,
                  providerThreadId: providerThread.id,
                  providerTurnId: turn.id,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 1,
                  status: "running",
                  title: null,
                  startedAt: now,
                  completedAt: null,
                  updatedAt: now,
                  type: "subagent",
                  subagentId: childId,
                  origin: "provider_native",
                  driver,
                  providerInstanceId: instanceId,
                  childThreadId: null,
                  prompt: "remote task",
                  result: null,
                },
              },
            ],
          });
        }
        targets.push({ threadId, run, attempt, root, providerThread, turn });
      }
      const target = targets[0]!;
      const acceptedCommand = {
        type: "message.dispatch" as const,
        commandId: CommandId.make("accepted-steer"),
        threadId: target.threadId,
        messageId: MessageId.make("accepted-steer"),
        text: "accepted correction",
        attachments: [],
        dispatchMode: {
          type: "steer_active" as const,
          targetRunId: target.run.id,
          ...(activeTurnOnly ? { activeTurnOnly: true } : {}),
        },
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
      };
      if (accepted !== undefined) yield* engine.dispatch(acceptedCommand);
      if (nativeThreads) {
        const source = (yield* projections.getThreadProjection(target.threadId)).subagents[0]!;
        const now = yield* DateTime.now;
        for (let depth = 0; depth < 2; depth++) {
          const threadId = ThreadId.make(`native-child:${depth}`);
          const nextThreadId = depth === 0 ? ThreadId.make("native-child:1") : null;
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`create:${threadId}`),
            threadId,
            projectId: ProjectId.make("project:session-loss"),
            title: "native child",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "agent",
            creationSource: "provider",
          });
          const providerThread = {
            ...target.providerThread,
            id: ProviderThreadId.make(`native-provider-thread:${depth}`),
            appThreadId: threadId,
            providerSessionId: sessionId,
          };
          const rootId = NodeId.make(`native-root:${depth}`);
          const turnId = ProviderTurnId.make(`native-turn:${depth}`);
          const root = {
            ...target.root,
            id: rootId,
            threadId,
            runId: null,
            rootNodeId: rootId,
            parentNodeId: null,
            kind: "root_turn" as const,
            status: "running" as const,
            checkpointScopeId: null,
            providerThreadId: providerThread.id,
            providerTurnId: turnId,
          };
          const toolId = NodeId.make(`native-tool:${depth}`);
          const taskId = NodeId.make(`native-task:${depth}`);
          const events = [
            {
              id: EventId.make(`native-thread:${depth}`),
              type: "provider-thread.updated" as const,
              threadId,
              occurredAt: now,
              payload: providerThread,
            },
            {
              id: EventId.make(`native-root:${depth}`),
              type: "node.updated" as const,
              threadId,
              occurredAt: now,
              payload: root,
            },
            {
              id: EventId.make(`native-turn:${depth}`),
              type: "provider-turn.updated" as const,
              threadId,
              occurredAt: now,
              payload: {
                ...target.turn,
                id: turnId,
                providerThreadId: providerThread.id,
                nodeId: rootId,
                runAttemptId: null,
              },
            },
            {
              id: EventId.make(`native-tool:${depth}`),
              type: "node.updated" as const,
              threadId,
              occurredAt: now,
              payload: { ...root, id: toolId, kind: "tool_call" as const, parentNodeId: rootId },
            },
            {
              id: EventId.make(`native-item:${depth}`),
              type: "turn-item.updated" as const,
              threadId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`native-item:${depth}`),
                threadId,
                runId: null,
                nodeId: toolId,
                providerThreadId: providerThread.id,
                providerTurnId: turnId,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 1,
                status: "running" as const,
                title: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
                type: "command_execution" as const,
                input: "native task",
              },
            },
          ];
          yield* sink.write({
            events:
              buffered === "new turn" && depth === 1
                ? events.filter((event) => event.type !== "provider-turn.updated")
                : events,
          });
          yield* sink.write({
            events: [
              {
                id: EventId.make(`native-message:${depth}`),
                type: "message.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: MessageId.make(`native-message:${depth}`),
                  threadId,
                  runId: null,
                  nodeId: rootId,
                  role: "assistant",
                  text: "working",
                  attachments: [],
                  streaming: true,
                  createdAt: now,
                  updatedAt: now,
                  createdBy: "agent",
                  creationSource: "provider",
                },
              },
              {
                id: EventId.make(`native-request:${depth}`),
                type: "runtime-request.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: RuntimeRequestId.make(`native-request:${depth}`),
                  nodeId: rootId,
                  providerTurnId: turnId,
                  nativeRequestRef: null,
                  kind: "user_input",
                  status: "pending",
                  responseCapability: { type: "live", providerSessionId: sessionId },
                  createdAt: now,
                  resolvedAt: null,
                },
              },
            ],
          });
          if (nextThreadId !== null)
            yield* sink.write({
              events: [
                {
                  id: EventId.make(`nested-node:${depth}`),
                  type: "node.updated",
                  threadId,
                  occurredAt: now,
                  payload: { ...root, id: taskId, kind: "subagent", parentNodeId: rootId },
                },
                {
                  id: EventId.make(`nested-task:${depth}`),
                  type: "subagent.updated",
                  threadId,
                  occurredAt: now,
                  payload: {
                    ...source,
                    id: taskId,
                    threadId,
                    runId: null,
                    parentNodeId: rootId,
                    providerThreadId: providerThread.id,
                    childThreadId: nextThreadId,
                  },
                },
              ],
            });
        }
        yield* sink.write({
          events: [
            {
              id: EventId.make("link-native-child"),
              type: "subagent.updated",
              threadId: target.threadId,
              occurredAt: now,
              payload: { ...source, childThreadId: ThreadId.make("native-child:0") },
            },
          ],
        });
      }
      if (buffered) {
        const execution = yield* RunExecution.RunExecutionServiceV2;
        const current = yield* projections.getThreadProjection(target.threadId);
        const runtime = Option.getOrThrow(yield* sessions.get(sessionId));
        yield* execution.startRootRun({
          commandId: CommandId.make("buffered-reader"),
          appThread: current.thread,
          providerSessionId: sessionId,
          session: runtime,
          run: current.runs[0]!,
          rootNode: current.nodes.find((node) => node.id === target.root.id)!,
          checkpointScope: {
            id: CheckpointScopeId.make("buffered-scope"),
            threadId: target.threadId,
            runId: target.run.id,
            nodeId: target.root.id,
            parentScopeId: null,
            providerThreadId: target.providerThread.id,
            kind: "root_run",
            ordinalWithinParent: 0,
            advancesAppRunCount: true,
            cwd: process.cwd(),
            createdAt: yield* DateTime.now,
          },
          providerThread: current.providerThreads[0]!,
          attempt: current.attempts[0]!,
          attemptId: target.attempt.id,
          providerTurnOrdinal: 1,
          relatedThreadIds: [ThreadId.make("native-child:0"), ThreadId.make("native-child:1")],
          message: {
            messageId: MessageId.make("initial:session-loss-a"),
            text: "initial",
            attachments: [],
            createdBy: "agent",
            creationSource: "mcp",
          },
          modelSelection,
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
          },
        });
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: target.turn,
        });
        yield* Deferred.await(admitted);
        // This turn does not exist in the projection until the old reader drains.
        const native = yield* projections.getThreadProjection(ThreadId.make("native-child:1"));
        const oldTurn = {
          ...target.turn,
          id: ProviderTurnId.make("native-turn:1"),
          providerThreadId: ProviderThreadId.make("native-provider-thread:1"),
          nodeId: NodeId.make("native-root:1"),
          runAttemptId: null,
        };
        const now = yield* DateTime.now;
        if (buffered === "running update")
          yield* sink.write({
            events: [
              {
                id: EventId.make("remove-buffered-native-turn"),
                type: "provider-turn.updated",
                threadId: ThreadId.make("native-child:1"),
                occurredAt: now,
                payload: { ...oldTurn, status: "interrupted", completedAt: now },
              },
            ],
          });
        // Preserve routing to both native threads before the delayed running update.
        const parent = current.subagents.find((task) => task.id === `remote:${target.threadId}`)!;
        const firstChild = yield* projections.getThreadProjection(ThreadId.make("native-child:0"));
        yield* Queue.offer(events, { type: "subagent.updated", driver, subagent: parent });
        yield* Queue.offer(events, {
          type: "subagent.updated",
          driver,
          subagent: firstChild.subagents[0]!,
        });
        yield* Queue.offer(events, {
          type: "provider_thread.updated",
          driver,
          providerThread: native.providerThreads[0]!,
        });
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: oldTurn,
          threadId: ThreadId.make("native-child:1"),
        });
        yield* Queue.offer(events, {
          type: "provider_session.updated",
          driver,
          providerSession: runtime.providerSession,
        });
        yield* Deferred.await(allAdmitted);
      }
      if (terminalBeforeRelease !== undefined) {
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("terminal-before-capture:turn"),
              type: "provider-turn.updated",
              threadId: target.threadId,
              occurredAt: now,
              payload: { ...target.turn, status: terminalBeforeRelease, completedAt: now },
            },
            {
              id: EventId.make("terminal-before-capture:run"),
              type: "run.updated",
              threadId: target.threadId,
              occurredAt: now,
              payload: {
                ...target.run,
                status: terminalBeforeRelease === "completed" ? "waiting" : terminalBeforeRelease,
              },
            },
            {
              id: EventId.make("terminal-before-capture:attempt"),
              type: "run-attempt.updated",
              threadId: target.threadId,
              occurredAt: now,
              payload: { ...target.attempt, status: terminalBeforeRelease },
            },
            {
              id: EventId.make("terminal-before-capture:root"),
              type: "node.updated",
              threadId: target.threadId,
              occurredAt: now,
              payload: { ...target.root, status: terminalBeforeRelease },
            },
          ],
        });
      }
      const markerFailed = yield* Deferred.make<void>();
      if (markerFailure) {
        const write = sink.writeWithEffects;
        let failed = false;
        const spy = vi.spyOn(sink, "writeWithEffects").mockImplementation((input) => {
          if (
            !failed &&
            input.effects.some(
              (effect) => effect.request.type === "provider-session.reconcile-turn",
            )
          ) {
            failed = true;
            return Deferred.succeed(markerFailed, undefined).pipe(
              Effect.andThen(Effect.fail(new EventSink.EventSinkWriteError({ eventCount: 0 }))),
            );
          }
          return write(input);
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
      }
      const releasing = yield* sessions
        .release({ providerSessionId: sessionId, reason })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(closing);
      if (buffered) {
        assert.isTrue(Option.isNone(yield* outbox.get("effect:session-ended:native-turn:1")));
        yield* Deferred.succeed(resumeIngestion, undefined);
      }
      assert.isTrue(Option.isNone(yield* sessions.get(sessionId)));
      const steer = {
        type: "message.dispatch" as const,
        commandId: CommandId.make("lost-session-steer"),
        threadId: target.threadId,
        messageId: MessageId.make("lost-session-steer"),
        text: "correction",
        attachments: [],
        dispatchMode: { type: "steer_active" as const, targetRunId: target.run.id },
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
      };
      const command = promotion
        ? yield* Effect.gen(function* () {
            yield* engine.dispatch({
              ...steer,
              commandId: CommandId.make("queued-correction"),
              dispatchMode: { type: "queue_after_active" },
            });
            const queued = (yield* projections.getThreadProjection(target.threadId)).runs.find(
              (run) => run.status === "queued",
            )!;
            return {
              type: "queued-message.promote-to-steer" as const,
              threadId: target.threadId,
              commandId: CommandId.make("lost-session-promotion"),
              queuedRunId: queued.id,
              targetRunId: target.run.id,
            };
          })
        : steer;
      if (terminalBeforeRelease === undefined) {
        const rejected = yield* engine.dispatch(command).pipe(Effect.flip);
        assert.equal(rejected._tag, "OrchestratorDispatchError");
        if (rejected._tag === "OrchestratorDispatchError") {
          assert.instanceOf(rejected.cause, Sessions.ProviderSessionEndedError);
        }
        assert.include(
          userFacingDispatchErrorMessage(rejected),
          promotion ? "remains queued" : "mode=queue",
        );
        assert.notInclude(userFacingDispatchErrorMessage(rejected), "is not active");
        const replayed = yield* engine.dispatch(command).pipe(Effect.flip);
        assert.equal(replayed._tag, "OrchestratorCommandPreviouslyRejectedError");
        assert.include(
          userFacingDispatchErrorMessage(replayed),
          promotion ? "remains queued" : "new clientRequestId",
        );
        const refused = yield* projections.getThreadProjection(target.threadId);
        assert.lengthOf(refused.messages, (promotion ? 2 : 1) + (accepted === undefined ? 0 : 1));
        if (promotion)
          assert.lengthOf(
            refused.runs.filter((run) => run.status === "queued"),
            1,
          );
      }
      if (nativeThreads) {
        const threadId = ThreadId.make("native-child:0");
        yield* sessions.open({
          threadId,
          providerSessionId: sessionId,
          modelSelection,
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
          },
        });
        const child = yield* projections.getThreadProjection(threadId);
        const providerThread = child.providerThreads[0]!;
        const root = child.nodes.find((node) => node.id === "native-root:0")!;
        const turn = child.providerTurns.find((turn) => turn.id === "native-turn:0")!;
        // TestClock deliberately gives the replacement the release's exact timestamp.
        const now = yield* DateTime.now;
        const rootId = NodeId.make("native-replacement-root");
        const turnId = ProviderTurnId.make("native-replacement-turn");
        yield* sink.write({
          events: [
            {
              id: EventId.make("native-replacement-root"),
              type: "node.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...root,
                id: rootId,
                rootNodeId: rootId,
                providerTurnId: turnId,
                startedAt: now,
              },
            },
            {
              id: EventId.make("native-replacement-turn"),
              type: "provider-turn.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...turn,
                id: turnId,
                providerThreadId: providerThread.id,
                nodeId: rootId,
                ordinal: 2,
                startedAt: now,
              },
            },
          ],
        });
      }
      if (replace) {
        yield* sessions.open({
          threadId: target.threadId,
          providerSessionId: sessionId,
          modelSelection,
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
          },
        });
        const now = yield* DateTime.now;
        const replacementAttempt = RunAttemptId.make("replacement-attempt");
        const replacementTurn = ProviderTurnId.make("replacement-turn");
        yield* sink.write({
          events: [
            {
              id: EventId.make("replace-run"),
              type: "run.updated",
              threadId: target.threadId,
              occurredAt: now,
              payload: { ...target.run, status: "running", activeAttemptId: replacementAttempt },
            },
            {
              id: EventId.make("replace-attempt"),
              type: "run-attempt.updated",
              threadId: target.threadId,
              occurredAt: now,
              payload: {
                ...target.attempt,
                id: replacementAttempt,
                attemptOrdinal: target.attempt.attemptOrdinal + 1,
                status: "running",
                providerTurnId: replacementTurn,
              },
            },
            {
              id: EventId.make("replace-turn"),
              type: "provider-turn.updated",
              threadId: target.threadId,
              occurredAt: now,
              payload: {
                ...target.turn,
                id: replacementTurn,
                runAttemptId: replacementAttempt,
                startedAt: now,
              },
            },
          ],
        });
        const duringReplacement = yield* projections.getThreadProjection(target.threadId);
        const child = duringReplacement.subagents[0]!;
        const childNode = duringReplacement.nodes.find((node) => node.id === child.id)!;
        const replacementChild = NodeId.make("replacement-child");
        yield* sink.write({
          events: [
            {
              id: EventId.make("replacement-child-node"),
              type: "node.updated",
              threadId: target.threadId,
              occurredAt: now,
              payload: { ...childNode, id: replacementChild, providerTurnId: replacementTurn },
            },
            {
              id: EventId.make("replacement-child-task"),
              type: "subagent.updated",
              threadId: target.threadId,
              occurredAt: now,
              payload: { ...child, id: replacementChild, startedAt: now, updatedAt: now },
            },
          ],
        });
      }
      const recordedSteerEffect =
        accepted === undefined
          ? undefined
          : (yield* outbox.listByCommandId(acceptedCommand.commandId)).find(
              (effect) => effect.request.type === "provider-turn.steer",
            )!;
      const steerEffect =
        delivered && recordedSteerEffect?.request.type === "provider-turn.steer"
          ? {
              ...recordedSteerEffect,
              request: { ...recordedSteerEffect.request, providerAccepted: true },
            }
          : recordedSteerEffect;
      if (accepted === "blocked closure") {
        const open = sessions.open({
          threadId: target.threadId,
          providerSessionId: sessionId,
          modelSelection,
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
          },
        });
        if (markerFailure) {
          yield* Deferred.await(markerFailed);
          const opened = yield* Deferred.make<void>();
          const opening = yield* open.pipe(
            Effect.andThen(Deferred.succeed(opened, undefined)),
            Effect.forkScoped,
          );
          assert.isTrue(Option.isNone(yield* outbox.get(`effect:session-ended:${target.turn.id}`)));
          assert.isFalse(yield* Deferred.isDone(opened));
          yield* TestClock.adjust("1 second");
          yield* Fiber.join(opening);
        } else yield* open;
        assert.isFalse(yield* Deferred.isDone(finishClose));
        yield* executor.execute(steerEffect!);
        const duringClose = yield* projections.getThreadProjection(target.threadId);
        assert.equal(duringClose.providerTurns[0]?.status, "running");
        assert.lengthOf(
          duringClose.runs.filter((run) => run.userMessageId === acceptedCommand.messageId),
          1,
        );
      }
      yield* Deferred.succeed(finishClose, undefined);
      yield* Fiber.join(releasing);
      if (nativeThreads) {
        for (let depth = 0; depth < 2; depth++) {
          const marker = Option.getOrThrow(
            yield* outbox.get(`effect:session-ended:native-turn:${depth}`),
          );
          assert.equal(marker.threadId, `native-child:${depth}`);
        }
      }
      if (accepted === "before recovery") yield* executor.execute(steerEffect!);
      if (faultRead) {
        const effect = Option.getOrThrow(
          yield* outbox.get(`effect:session-ended:${target.turn.id}`),
        );
        const read = vi.spyOn(projections, "getThreadRecords").mockImplementationOnce(() =>
          Effect.fail(
            new ProjectionStore.ProjectionStoreReadError({
              threadId: target.threadId,
              cause: new Error("transient read failure"),
            }),
          ),
        );
        yield* executor
          .execute({ ...effect, attemptCount: 1 })
          .pipe(Effect.flip, Effect.ensuring(Effect.sync(() => read.mockRestore())));
        assert.equal(
          (yield* projections.getThreadProjection(target.threadId)).runs[0]?.status,
          "running",
        );
        yield* executor.execute({ ...effect, attemptCount: 2 });
        yield* executor.execute({ ...effect, attemptCount: 2 });
      }
      if (accepted !== undefined || faultRead) {
        for (const item of targets) {
          const effect = Option.getOrThrow(
            yield* outbox.get(`effect:session-ended:${item.turn.id}`),
          );
          yield* executor.execute({
            ...effect,
            attemptCount: faultRead && item === target ? 2 : 1,
          });
        }
      } else yield* worker.drain();
      if (accepted === "replacement session") {
        yield* sessions.open({
          threadId: target.threadId,
          providerSessionId: sessionId,
          modelSelection,
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
          },
        });
      }
      if (accepted !== undefined) {
        yield* executor.execute({ ...steerEffect!, attemptCount: 2 });
        yield* executor.execute({ ...steerEffect!, attemptCount: 3 });
        const current = yield* projections.getThreadProjection(target.threadId);
        assert.lengthOf(
          current.messages.filter((message) => message.id === acceptedCommand.messageId),
          1,
        );
        assert.lengthOf(
          current.runs.filter((run) => run.userMessageId === acceptedCommand.messageId),
          activeTurnOnly || delivered ? 0 : 1,
        );
      }
      for (const [index, target] of targets.entries()) {
        const hasNativeWork = !(
          index === 0 &&
          terminalBeforeRelease !== undefined &&
          accepted !== undefined &&
          !nativeThreads
        );
        const current = yield* projections.getThreadProjection(target.threadId);
        const settled =
          buffered && index === 0
            ? ["failed", "interrupted"]
            : [(index === 0 ? terminalBeforeRelease : undefined) ?? "interrupted"];
        assert.equal(
          current.providerTurns.find((turn) => turn.id === target.turn.id)?.status,
          (index === 0 ? terminalBeforeRelease : undefined) ?? "interrupted",
        );
        assert.include(
          replace && index === 0
            ? ["running"]
            : index === 0 && terminalBeforeRelease === "completed"
              ? ["waiting"]
              : settled,
          current.runs.find((run) => run.id === target.run.id)?.status,
        );
        if (replace && index === 0) {
          assert.equal(
            current.providerTurns.find((turn) => turn.id === "replacement-turn")?.status,
            "running",
          );
          assert.equal(
            current.subagents.find((child) => child.id === "replacement-child")?.status,
            "running",
          );
          assert.equal(
            current.nodes.find((node) => node.id === "replacement-child")?.status,
            "running",
          );
        }
        if (hasNativeWork && instance === "opencode") {
          assert.deepEqual(
            current.providerThreads.find((thread) => thread.id === target.providerThread.id)
              ?.pendingBackgroundTasks,
            [{ taskId: "remote-work", kind: "subagent" }],
          );
          assert.equal(
            current.subagents.find((task) => task.id === `remote:${target.threadId}`)?.status,
            "running",
          );
          assert.equal(
            current.nodes.find((node) => node.id === `remote:${target.threadId}`)?.status,
            "running",
          );
        }
        if (hasNativeWork && instance !== "opencode") {
          const childSettled =
            buffered && index === 0 ? ["failed", "interrupted"] : ["interrupted"];
          assert.include(
            childSettled,
            current.subagents.find((task) => task.id === `remote:${target.threadId}`)?.status,
          );
          assert.include(
            childSettled,
            current.nodes.find((node) => node.id === `remote:${target.threadId}`)?.status,
          );
        }
        if (hasNativeWork)
          assert.equal(
            current.turnItems.find((item) => item.id === `remote-item:${target.threadId}`)?.status,
            instance === "opencode" ? "running" : "interrupted",
          );
        if (!replace || index !== 0) {
          assert.include(
            settled,
            current.attempts.find((attempt) => attempt.id === target.attempt.id)?.status,
          );
          assert.include(settled, current.nodes.find((node) => node.id === target.root.id)?.status);
        }
      }
      if (nativeThreads)
        for (let depth = 0; depth < 2; depth++) {
          const child = yield* projections.getThreadProjection(
            ThreadId.make(`native-child:${depth}`),
          );
          assert.equal(
            child.providerTurns.find((turn) => turn.id === `native-turn:${depth}`)?.status,
            "interrupted",
          );
          assert.equal(
            child.nodes.find((node) => node.id === `native-root:${depth}`)?.status,
            "interrupted",
          );
          assert.equal(
            child.nodes.find((node) => node.id === `native-tool:${depth}`)?.status,
            "interrupted",
          );
          assert.equal(
            child.turnItems.find((item) => item.id === `native-item:${depth}`)?.status,
            "interrupted",
          );
          assert.isFalse(
            child.messages.find((message) => message.id === `native-message:${depth}`)?.streaming,
          );
          assert.equal(
            child.runtimeRequests.find((request) => request.id === `native-request:${depth}`)
              ?.status,
            "cancelled",
          );
          if (depth === 0) {
            assert.equal(
              child.providerTurns.find((turn) => turn.id === "native-replacement-turn")?.status,
              "running",
            );
            assert.equal(
              child.nodes.find((node) => node.id === "native-replacement-root")?.status,
              "running",
            );
          }
        }
      if (!replace && !promotion && accepted === undefined) {
        yield* engine.dispatch({
          ...steer,
          commandId: CommandId.make("queued-correction"),
          messageId: MessageId.make("queued-correction"),
          dispatchMode: { type: "queue_after_active" },
        });
        const current = yield* projections.getThreadProjection(target.threadId);
        assert.lengthOf(
          current.messages.filter((message) => message.text === "correction"),
          1,
        );
        assert.lengthOf(current.runs, 2);
      }
    }).pipe(
      Effect.ensuring(Deferred.succeed(resumeIngestion, undefined)),
      Effect.ensuring(Deferred.succeed(finishClose, undefined)),
      Effect.provide(layer),
    );
  });

it.effect.each([
  { instance: "codex", reason: "idle_timeout", replace: false, promotion: false },
  { instance: "codex-cu", reason: "runtime_error", replace: false, promotion: false },
  { instance: "codex-cu", reason: "manual_shutdown", replace: false, promotion: false },
  { instance: "codex-cu", reason: "runtime_error", replace: true, promotion: false },
  { instance: "opencode", reason: "runtime_error", replace: false, promotion: false },
  { instance: "codex-cu", reason: "idle_timeout", replace: false, promotion: true },
] as const)(
  "settles shared session loss ($instance, $reason, replacement=$replace, promotion=$promotion)",
  sessionLoss,
);

it.effect.each([
  "before recovery",
  "after recovery",
  "replacement session",
  "blocked closure",
] as const)("queues an accepted steer after session loss (%s)", (accepted) =>
  sessionLoss({ instance: "codex-cu", reason: "runtime_error", accepted }),
);
it.effect("retries session-loss settlement after a transient planning rejection", () =>
  sessionLoss({ instance: "codex-cu", reason: "runtime_error", faultRead: true }),
);
it.effect("session loss does not turn active-turn-only input into a new run", () =>
  sessionLoss({
    instance: "codex-cu",
    reason: "runtime_error",
    accepted: "after recovery",
    activeTurnOnly: true,
  }),
);
it.effect("session loss does not requeue input already accepted by the provider", () =>
  sessionLoss({
    instance: "codex-cu",
    reason: "runtime_error",
    accepted: "after recovery",
    delivered: true,
  }),
);

it.effect.each(["completed", "failed", "interrupted", "cancelled"] as const)(
  "retains accepted steers when the old turn is already %s at release",
  (terminalBeforeRelease) =>
    sessionLoss({
      instance: "codex-cu",
      reason: "runtime_error",
      accepted: "replacement session",
      terminalBeforeRelease,
    }),
);
it.effect("persists release identity before reopening after a failed marker write", () =>
  sessionLoss({
    instance: "codex-cu",
    reason: "runtime_error",
    accepted: "blocked closure",
    markerFailure: true,
  }),
);
it.effect.each([undefined, "completed"] as const)(
  "ends runless native descendants after shared release (parent=%s)",
  (terminalBeforeRelease) =>
    sessionLoss({
      instance: "codex-cu",
      reason: "runtime_error",
      nativeThreads: true,
      ...(terminalBeforeRelease === undefined ? {} : { terminalBeforeRelease }),
    }),
);

it.effect("retains an accepted steer after exclusive-session loss and replacement", () =>
  sessionLoss({
    instance: "codex-cu",
    reason: "runtime_error",
    accepted: "replacement session",
    terminalBeforeRelease: "failed",
    shared: false,
  }),
);

it.effect.each(["new turn", "running update"] as const)(
  "drains admitted native-child writes before capturing shared session loss (%s)",
  (buffered) =>
    sessionLoss({ instance: "codex-cu", reason: "runtime_error", nativeThreads: true, buffered }),
);
