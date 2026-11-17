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
  foregroundOnly = false,
  unstartedChild,
  retryRecovery,
  rebound,
  cleanupOnly = false,
  appOwned = false,
  retrySteer = false,
  lateRoster,
  lastAttemptLoss = false,
}: {
  instance: "codex" | "codex-cu" | "opencode";
  reason: Sessions.ProviderSessionReleaseReason;
  replace?: boolean;
  promotion?: boolean;
  accepted?:
    | "before recovery"
    | "after recovery"
    | "replacement session"
    | "blocked closure"
    | "after preflight";
  faultRead?: boolean;
  activeTurnOnly?: boolean;
  delivered?: boolean;
  terminalBeforeRelease?: "completed" | "failed" | "interrupted" | "cancelled";
  markerFailure?: boolean;
  nativeThreads?: boolean;
  shared?: boolean;
  buffered?: "new turn" | "running update";
  foregroundOnly?: boolean;
  unstartedChild?: "released" | "replacement" | "restarted";
  retryRecovery?: "turn" | "root";
  rebound?: "live" | "ended";
  cleanupOnly?: boolean;
  appOwned?: boolean;
  retrySteer?: boolean;
  lateRoster?: "cleared" | "new roster";
  lastAttemptLoss?: boolean;
}) =>
  Effect.gen(function* () {
    const allAdmitted = yield* Deferred.make<void>();
    const admitted = yield* Deferred.make<void>();
    const resumeIngestion = yield* Deferred.make<void>();
    const preflight = yield* Deferred.make<void>();
    const commitSteer = yield* Deferred.make<void>();
    const finalizing = yield* Deferred.make<void>();
    const resumeFinalization = yield* Deferred.make<void>();
    const finalized = yield* Deferred.make<void>();
    const adapterEntered = yield* Deferred.make<void>();
    const failAdapter = yield* Deferred.make<void>();
    const markerEntered = yield* Deferred.make<void>();
    const allowMarker = yield* Deferred.make<void>();
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
    let adapterSteers = 0;
    const adapter = {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(capabilities),
      planSelectionTransition: () =>
        Effect.succeed({
          type: rebound ? ("restart_session" as const) : ("apply_on_next_turn" as const),
        }),
      openSession: (
        input: Parameters<ProviderAdapter.ProviderAdapterV2["Service"]["openSession"]>[0],
      ) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const runtimeSessionId = input.providerSessionId;
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(closing, undefined).pipe(Effect.andThen(Deferred.await(finishClose))),
          );
          return {
            instanceId,
            driver,
            providerSessionId: runtimeSessionId,
            providerSession: {
              id: runtimeSessionId,
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
            }: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["steerTurn"]>[0]) => {
              adapterSteers++;
              return Effect.gen(function* () {
                if (lastAttemptLoss && adapterSteers === 5) {
                  yield* Deferred.succeed(adapterEntered, undefined);
                  yield* Deferred.await(failAdapter);
                }
                return yield* new ProviderAdapter.ProviderAdapterSteerRunError({
                  driver,
                  providerThreadId: providerThread.id,
                  providerTurnId,
                  cause: "The app-server transport closed before the steer completed.",
                });
              });
            },
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
      let unstartedRootMarker = "";
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
        const toolId = NodeId.make(`foreground-tool:${threadId}`);
        if (accepted !== "after preflight")
          yield* sink.write({
            events: [
              {
                id: EventId.make(`foreground-tool-node:${threadId}`),
                type: "node.updated",
                threadId,
                occurredAt: now,
                payload: {
                  ...root,
                  id: toolId,
                  kind: "tool_call",
                  parentNodeId: root.id,
                  providerTurnId: turn.id,
                  status: "running",
                  checkpointScopeId: null,
                },
              },
              {
                id: EventId.make(`foreground-tool-item:${threadId}`),
                type: "turn-item.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make(`foreground-tool:${threadId}`),
                  threadId,
                  runId: run.id,
                  nodeId: toolId,
                  providerThreadId: providerThread.id,
                  providerTurnId: turn.id,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 2,
                  status: "running",
                  title: null,
                  startedAt: now,
                  completedAt: null,
                  updatedAt: now,
                  type: "command_execution",
                  input: "native command",
                },
              },
            ],
          });
        if (
          !foregroundOnly &&
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
      const delegation =
        appOwned || rebound !== undefined
          ? yield* Effect.gen(function* () {
              yield* engine.dispatch({
                type: "delegated_task.request",
                commandId: CommandId.make("independent-child"),
                parentThreadId: target.threadId,
                parentRunId: target.run.id,
                parentNodeId: target.root.id,
                task: "continue independently",
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                createdBy: "agent",
                creationSource: "mcp",
              });
              const parent = yield* projections.getThreadProjection(target.threadId);
              const task = parent.subagents.find((row) => row.origin === "app_owned")!;
              const childId = task.childThreadId!;
              const child = yield* projections.getThreadProjection(childId);
              const run = child.runs[0]!;
              const attempt = child.attempts[0]!;
              const binding = child.providerThreads.find((row) => row.id === run.providerThreadId)!;
              const root = child.nodes.find((row) => row.id === run.rootNodeId)!;
              const sessionId = ProviderSessionId.make("session:independent-child");
              const turnId = ProviderTurnId.make("turn:independent-child");
              const now = yield* DateTime.now;
              yield* sessions.open({
                threadId: childId,
                providerSessionId: sessionId,
                modelSelection,
                runtimePolicy: {
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  cwd: process.cwd(),
                },
              });
              yield* sink.write({
                events: [
                  {
                    id: EventId.make("independent-child:binding"),
                    type: "provider-thread.updated",
                    threadId: childId,
                    occurredAt: now,
                    payload: { ...binding, providerSessionId: sessionId, status: "active" },
                  },
                  {
                    id: EventId.make("independent-child:run"),
                    type: "run.updated",
                    threadId: childId,
                    occurredAt: now,
                    payload: { ...run, status: "running", startedAt: now },
                  },
                  {
                    id: EventId.make("independent-child:attempt"),
                    type: "run-attempt.updated",
                    threadId: childId,
                    occurredAt: now,
                    payload: { ...attempt, status: "running", providerTurnId: turnId },
                  },
                  {
                    id: EventId.make("independent-child:root"),
                    type: "node.updated",
                    threadId: childId,
                    occurredAt: now,
                    payload: { ...root, status: "running", providerTurnId: turnId },
                  },
                  {
                    id: EventId.make("independent-child:turn"),
                    type: "provider-turn.updated",
                    threadId: childId,
                    occurredAt: now,
                    payload: {
                      ...target.turn,
                      id: turnId,
                      nodeId: root.id,
                      providerThreadId: binding.id,
                      runAttemptId: attempt.id,
                    },
                  },
                ],
              });
              return {
                task,
                node: parent.nodes.find((row) => row.id === task.id),
                item: parent.turnItems.find(
                  (row) => row.type === "subagent" && row.subagentId === task.id,
                ),
                child: yield* projections.getThreadProjection(childId),
                sessionId,
              };
            })
          : undefined;
      const assertDelegation = Effect.gen(function* () {
        if (delegation === undefined) return;
        const parent = yield* projections.getThreadProjection(target.threadId);
        assert.equal(delegation.item?.providerTurnId, target.turn.id);
        assert.deepEqual(
          parent.subagents.find((row) => row.id === delegation.task.id),
          delegation.task,
        );
        assert.deepEqual(
          parent.nodes.find((row) => row.id === delegation.task.id),
          delegation.node,
        );
        assert.deepEqual(
          parent.turnItems.find((row) => row.id === delegation.item?.id),
          delegation.item,
        );
        assert.deepEqual(
          yield* projections.getThreadProjection(delegation.child.thread.id),
          delegation.child,
        );
        assert.isTrue(Option.isSome(yield* sessions.get(delegation.sessionId)));
      });
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
      const admitting =
        accepted === "after preflight"
          ? yield* Effect.gen(function* () {
              const get = sessions.get;
              let first = true;
              const spy = vi.spyOn(sessions, "get").mockImplementation((id) =>
                get(id).pipe(
                  Effect.tap(() =>
                    Effect.gen(function* () {
                      if (!first) return;
                      first = false;
                      yield* Deferred.succeed(preflight, undefined);
                      yield* Deferred.await(commitSteer);
                    }),
                  ),
                ),
              );
              yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
              const fiber = yield* engine.dispatch(acceptedCommand).pipe(Effect.forkScoped);
              yield* Deferred.await(preflight);
              return fiber;
            })
          : undefined;
      if (accepted !== undefined && admitting === undefined && !cleanupOnly)
        yield* engine.dispatch(acceptedCommand);
      if (nativeThreads) {
        const source = (yield* projections.getThreadProjection(target.threadId)).subagents.find(
          (task) => task.origin === "provider_native",
        )!;
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
          if (unstartedChild !== undefined && depth === 1) {
            unstartedRootMarker = `effect:session-ended-root:native-root:1:${DateTime.formatIso(now)}`;
            yield* sink.write({
              events: [
                {
                  id: EventId.make("unstarted-binding"),
                  type: "provider-thread.updated",
                  threadId,
                  occurredAt: now,
                  payload: providerThread,
                },
                {
                  id: EventId.make("unstarted-root"),
                  type: "node.updated",
                  threadId,
                  occurredAt: now,
                  payload: { ...root, providerTurnId: null, startedAt: now },
                },
              ],
            });
            continue;
          }
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
      if (rebound !== undefined) {
        const messageNode = {
          ...target.root,
          id: NodeId.make("foreground-message"),
          kind: "assistant_message" as const,
          parentNodeId: target.root.id,
          providerTurnId: target.turn.id,
          status: "running" as const,
          checkpointScopeId: null,
        };
        const message = {
          id: MessageId.make("foreground-message"),
          threadId: target.threadId,
          runId: target.run.id,
          nodeId: messageNode.id,
          role: "assistant" as const,
          text: "partial answer",
          phase: "unknown" as const,
          attachments: [],
          streaming: true,
          createdAt: yield* DateTime.now,
          updatedAt: yield* DateTime.now,
          createdBy: "agent" as const,
          creationSource: "provider" as const,
        };
        yield* sink.write({
          events: [
            {
              id: EventId.make("foreground-message:node"),
              type: "node.updated",
              threadId: target.threadId,
              occurredAt: message.updatedAt,
              payload: messageNode,
            },
            {
              id: EventId.make("foreground-message:message"),
              type: "message.updated",
              threadId: target.threadId,
              occurredAt: message.updatedAt,
              payload: message,
            },
          ],
        });
        const selection = { ...modelSelection, model: "replacement-model" };
        const switchCommandId = CommandId.make("restart-before-steer-delivery");
        yield* engine.dispatch({
          ...acceptedCommand,
          commandId: switchCommandId,
          messageId: MessageId.make("restart-before-steer-delivery"),
          text: "switch selection",
          modelSelection: selection,
          dispatchMode: { type: "steer_active", targetRunId: target.run.id },
        });
        const restarted = yield* projections.getThreadProjection(target.threadId);
        const binding = restarted.providerThreads.find(
          (row) => row.id === target.providerThread.id,
        )!;
        const replacementSessionId = binding.providerSessionId!;
        assert.notEqual(replacementSessionId, sessionId);
        assert.equal(restarted.runs[0]?.status, "starting");
        assert.equal(restarted.runs[0]?.providerRestartCleanup?.providerSessionId, sessionId);
        assert.equal(
          restarted.runs[0]?.providerRestartCleanup?.replacementProviderSessionId,
          replacementSessionId,
        );
        yield* sessions.open({
          threadId: target.threadId,
          providerSessionId: replacementSessionId,
          modelSelection: selection,
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
          },
        });
        const replacementRootId = NodeId.make("rebound-unrelated-root");
        const replacementTurnId = ProviderTurnId.make("rebound-unrelated-turn");
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("rebound-unrelated-root"),
              type: "node.updated",
              threadId: target.threadId,
              occurredAt: now,
              payload: {
                ...target.root,
                id: replacementRootId,
                rootNodeId: replacementRootId,
                runId: null,
                providerThreadId: binding.id,
                providerTurnId: replacementTurnId,
                status: "running",
                startedAt: now,
              },
            },
            {
              id: EventId.make("rebound-unrelated-turn"),
              type: "provider-turn.updated",
              threadId: target.threadId,
              occurredAt: now,
              payload: {
                ...target.turn,
                id: replacementTurnId,
                nodeId: replacementRootId,
                runAttemptId: null,
                ordinal: 2,
                startedAt: now,
              },
            },
            {
              id: EventId.make("replacement-message:node"),
              type: "node.updated",
              threadId: target.threadId,
              occurredAt: now,
              payload: {
                ...messageNode,
                id: NodeId.make("replacement-message"),
                providerTurnId: replacementTurnId,
              },
            },
            {
              id: EventId.make("replacement-message:message"),
              type: "message.updated",
              threadId: target.threadId,
              occurredAt: now,
              payload: {
                ...message,
                id: MessageId.make("replacement-message"),
                nodeId: NodeId.make("replacement-message"),
              },
            },
          ],
        });
        if (rebound === "ended") {
          yield* Deferred.succeed(finishClose, undefined);
          yield* sessions.release({ providerSessionId: sessionId, reason });
          assert.isTrue(Option.isNone(yield* sessions.get(sessionId)));
          for (const turnId of [target.turn.id, "native-turn:0", "native-turn:1"]) {
            const recovery = Option.getOrThrow(yield* outbox.get(`effect:session-ended:${turnId}`));
            assert.equal(recovery.request.type, "provider-session.reconcile-turn");
            yield* executor.execute(recovery);
          }
          assert.isTrue(
            Option.isNone(yield* outbox.get(`effect:session-ended:${replacementTurnId}`)),
          );
        }
        const recorded = (yield* outbox.listByCommandId(acceptedCommand.commandId)).find(
          (effect) => effect.request.type === "provider-turn.steer",
        );
        if (cleanupOnly) assert.isUndefined(recorded);
        else {
          assert.isDefined(recorded);
          const effect =
            delivered && recorded!.request.type === "provider-turn.steer"
              ? { ...recorded!, request: { ...recorded!.request, providerAccepted: true } }
              : recorded!;
          if (rebound === "live") {
            const failure = yield* executor.execute(effect).pipe(Effect.flip);
            assert.equal(failure._tag, "OrchestrationEffectExecutionError");
          } else {
            yield* executor.execute(effect);
            yield* executor.execute({ ...effect, attemptCount: 2 });
          }
        }
        const after = yield* projections.getThreadProjection(target.threadId);
        assert.deepEqual(
          after.messages.find((row) => row.id === message.id),
          {
            ...message,
            streaming: rebound === "live",
          },
        );
        assert.equal(
          after.messages.find((row) => row.id === "replacement-message")?.streaming,
          true,
        );
        assert.equal(
          after.nodes.find((row) => row.id === "replacement-message")?.status,
          "running",
        );
        yield* assertDelegation;
        const queued = after.runs.filter((run) => run.userMessageId === acceptedCommand.messageId);
        assert.lengthOf(
          queued,
          rebound === "ended" && !activeTurnOnly && !delivered && !cleanupOnly ? 1 : 0,
        );
        if (queued.length > 0) assert.equal(queued[0]?.status, "queued");
        assert.lengthOf(
          after.messages.filter((message) => message.id === acceptedCommand.messageId),
          cleanupOnly ? 0 : 1,
        );
        assert.deepEqual(
          after.runs.find((run) => run.id === target.run.id),
          restarted.runs[0],
        );
        assert.deepEqual(
          after.attempts.find((row) => row.id === restarted.runs[0]?.activeAttemptId),
          restarted.attempts.find((row) => row.id === restarted.runs[0]?.activeAttemptId),
        );
        assert.deepEqual(
          after.nodes.find((row) => row.id === restarted.runs[0]?.rootNodeId),
          restarted.nodes.find((row) => row.id === restarted.runs[0]?.rootNodeId),
        );
        assert.equal(after.nodes.find((row) => row.id === target.root.id)?.status, "interrupted");
        assert.equal(
          after.attempts.find((row) => row.id === target.attempt.id)?.status,
          "superseded",
        );
        assert.equal(
          after.providerThreads.find((row) => row.id === binding.id)?.providerSessionId,
          replacementSessionId,
        );
        assert.isTrue(Option.isSome(yield* sessions.get(replacementSessionId)));
        assert.equal(
          after.providerTurns.find((row) => row.id === replacementTurnId)?.status,
          "running",
        );
        assert.equal(after.nodes.find((row) => row.id === replacementRootId)?.status, "running");
        const oldStatus = rebound === "ended" ? "interrupted" : "running";
        assert.equal(
          after.providerTurns.find((row) => row.id === target.turn.id)?.status,
          oldStatus,
        );
        for (const id of [`foreground-tool:${target.threadId}`, `remote:${target.threadId}`]) {
          assert.equal(after.nodes.find((row) => row.id === id)?.status, oldStatus);
        }
        assert.equal(
          after.turnItems.find((row) => row.id === `foreground-tool:${target.threadId}`)?.status,
          oldStatus,
        );
        assert.equal(
          after.subagents.find((row) => row.id === `remote:${target.threadId}`)?.status,
          oldStatus,
        );
        assert.equal(
          after.turnItems.find((row) => row.id === `remote-item:${target.threadId}`)?.status,
          oldStatus,
        );
        for (let depth = 0; depth < 2; depth++) {
          const child = yield* projections.getThreadProjection(
            ThreadId.make(`native-child:${depth}`),
          );
          assert.equal(child.providerTurns[0]?.status, oldStatus);
          for (const id of [`native-root:${depth}`, `native-tool:${depth}`]) {
            assert.equal(child.nodes.find((row) => row.id === id)?.status, oldStatus);
          }
          assert.equal(
            child.turnItems.find((row) => row.id === `native-item:${depth}`)?.status,
            oldStatus,
          );
          assert.equal(
            child.messages.find((row) => row.id === `native-message:${depth}`)?.streaming,
            rebound === "live",
          );
          assert.equal(
            child.runtimeRequests.find((row) => row.id === `native-request:${depth}`)?.status,
            rebound === "ended" ? "cancelled" : "pending",
          );
          assert.isTrue(child.subagents.every((row) => row.status === oldStatus));
        }
        assert.equal(adapterSteers, 0);
        return;
      }
      if (lateRoster !== undefined) {
        const write = sink.writeIfRunCurrent;
        const spy = vi.spyOn(sink, "writeIfRunCurrent").mockImplementation((input) =>
          input.runId === target.run.id &&
          input.events.some(
            (event) => event.type === "run.updated" && event.payload.status === "failed",
          )
            ? Deferred.succeed(finalizing, undefined).pipe(
                Effect.andThen(Deferred.await(resumeFinalization)),
                Effect.andThen(write(input)),
                Effect.tap(() => Deferred.succeed(finalized, undefined)),
              )
            : write(input),
        );
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(resumeFinalization, undefined).pipe(
            Effect.andThen(Effect.sync(() => spy.mockRestore())),
          ),
        );
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
      if (lastAttemptLoss) {
        const steer = (yield* outbox.listByCommandId(acceptedCommand.commandId)).find(
          (effect) => effect.request.type === "provider-turn.steer",
        )!;
        const claim = outbox.claimNext;
        const claims = vi.spyOn(outbox, "claimNext").mockImplementation((input) =>
          claim({
            ...input,
            threadId: target.threadId,
            onlyEffectTypes: ["provider-turn.steer"],
          }),
        );
        const write = sink.writeWithEffects;
        const writes = vi
          .spyOn(sink, "writeWithEffects")
          .mockImplementation((input) =>
            input.effects.some(
              (effect) => effect.request.type === "provider-session.reconcile-turn",
            )
              ? Deferred.succeed(markerEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(allowMarker)),
                  Effect.andThen(write(input)),
                )
              : write(input),
          );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            claims.mockRestore();
            writes.mockRestore();
          }),
        );
        yield* Effect.gen(function* () {
          for (let attempt = 1; attempt <= 4; attempt++) {
            assert.isTrue(yield* worker.runControlOnce);
            const pending = Option.getOrThrow(yield* outbox.get(steer.id));
            assert.equal(pending.status, "pending");
            assert.equal(pending.attemptCount, attempt);
            yield* TestClock.adjust(
              Math.max(
                0,
                Date.parse(pending.availableAt) - DateTime.toEpochMillis(yield* DateTime.now),
              ),
            );
          }
          const sending = yield* worker.runControlOnce.pipe(Effect.forkScoped);
          yield* Deferred.await(adapterEntered);
          const releasing = yield* sessions
            .release({ providerSessionId: sessionId, reason })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(markerEntered);
          assert.isTrue(Option.isNone(yield* sessions.get(sessionId)));
          assert.isTrue(Option.isNone(yield* outbox.get(`effect:session-ended:${target.turn.id}`)));
          yield* Deferred.succeed(failAdapter, undefined);
          assert.isTrue(yield* Fiber.join(sending));
          const delivered = Option.getOrThrow(yield* outbox.get(steer.id));
          assert.equal(delivered.status, "succeeded");
          assert.equal(delivered.attemptCount, 5);
          assert.equal(adapterSteers, 5);
          const duringRelease = yield* projections.getThreadProjection(target.threadId);
          assert.lengthOf(
            duringRelease.runs.filter((run) => run.userMessageId === acceptedCommand.messageId),
            activeTurnOnly ? 0 : 1,
          );
          assert.isTrue(Option.isNone(yield* outbox.get(`effect:session-ended:${target.turn.id}`)));
          yield* Deferred.succeed(allowMarker, undefined);
          yield* Deferred.succeed(finishClose, undefined);
          yield* Fiber.join(releasing);
          claims.mockRestore();
          writes.mockRestore();
          yield* worker.drain();
          const after = yield* projections.getThreadProjection(target.threadId);
          assert.equal(after.runs.find((run) => run.id === target.run.id)?.status, "interrupted");
          assert.lengthOf(
            after.runs.filter((run) => run.userMessageId === acceptedCommand.messageId),
            activeTurnOnly ? 0 : 1,
          );
          assert.equal(Option.getOrThrow(yield* outbox.get(steer.id)).status, "succeeded");
          assert.equal(adapterSteers, 5);
        }).pipe(
          Effect.ensuring(
            Deferred.succeed(failAdapter, undefined).pipe(
              Effect.andThen(Deferred.succeed(allowMarker, undefined)),
              Effect.andThen(Deferred.succeed(finishClose, undefined)),
            ),
          ),
        );
        return;
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
        const oldTool = duringReplacement.nodes.find(
          (node) => node.id === `foreground-tool:${target.threadId}`,
        )!;
        const oldToolItem = duringReplacement.turnItems.find((item) => item.nodeId === oldTool.id)!;
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
            {
              id: EventId.make("replacement-tool-node"),
              type: "node.updated",
              threadId: target.threadId,
              occurredAt: now,
              payload: {
                ...oldTool,
                id: NodeId.make("replacement-tool"),
                providerTurnId: replacementTurn,
              },
            },
            {
              id: EventId.make("replacement-tool-item"),
              type: "turn-item.updated",
              threadId: target.threadId,
              occurredAt: now,
              payload: {
                ...oldToolItem,
                id: TurnItemId.make("replacement-tool"),
                nodeId: NodeId.make("replacement-tool"),
                providerTurnId: replacementTurn,
              },
            },
          ],
        });
      }
      if (admitting !== undefined) {
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
        assert.isEmpty(yield* outbox.listByCommandId(acceptedCommand.commandId));
        assert.isTrue(Option.isNone(yield* outbox.get(`effect:session-ended:${target.turn.id}`)));
        yield* Deferred.succeed(commitSteer, undefined);
        yield* Fiber.join(admitting);
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
      if (lateRoster !== undefined) {
        yield* Deferred.await(finalizing);
        const before = yield* projections.getThreadProjection(target.threadId);
        const current = before.providerThreads.find(
          (thread) => thread.id === target.providerThread.id,
        )!;
        const expected =
          lateRoster === "new roster" ? [{ taskId: "new-work", kind: "subagent" as const }] : [];
        if (lateRoster === "new roster") {
          yield* sink.write({
            events: [
              {
                id: EventId.make("fresh-background-roster"),
                type: "provider-thread.updated",
                threadId: target.threadId,
                occurredAt: yield* DateTime.now,
                payload: { ...current, pendingBackgroundTasks: expected },
              },
            ],
          });
        } else assert.deepEqual(current.pendingBackgroundTasks, expected);
        yield* Deferred.succeed(resumeFinalization, undefined);
        yield* Deferred.await(finalized);
        const after = yield* projections.getThreadProjection(target.threadId);
        assert.equal(after.runs.find((run) => run.id === target.run.id)?.status, "failed");
        assert.deepEqual(
          after.providerThreads.find((thread) => thread.id === current.id)?.pendingBackgroundTasks,
          expected,
        );
        yield* worker.drain();
        const recovered = yield* projections.getThreadProjection(target.threadId);
        assert.deepEqual(
          recovered.providerThreads.find((thread) => thread.id === current.id)
            ?.pendingBackgroundTasks,
          expected,
        );
        assert.notEqual(recovered.runs.find((run) => run.id === target.run.id)?.status, "running");
        assert.notEqual(
          recovered.providerTurns.find((turn) => turn.id === target.turn.id)?.status,
          "running",
        );
        return;
      }
      if (nativeThreads) {
        for (let depth = 0; depth < 2; depth++) {
          const marker = Option.getOrThrow(
            yield* outbox.get(
              unstartedChild !== undefined && depth === 1
                ? unstartedRootMarker
                : `effect:session-ended:native-turn:${depth}`,
            ),
          );
          assert.equal(marker.threadId, `native-child:${depth}`);
        }
      }
      if (unstartedChild !== undefined) {
        const threadId = ThreadId.make("native-child:1");
        const child = yield* projections.getThreadProjection(threadId);
        assert.isEmpty(child.providerTurns);
        const root = child.nodes.find((node) => node.id === "native-root:1")!;
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("unrelated-unstarted-root"),
              type: "node.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...root,
                id: NodeId.make("unrelated-native-root"),
                rootNodeId: NodeId.make("unrelated-native-root"),
              },
            },
            ...(unstartedChild === "restarted"
              ? [
                  {
                    id: EventId.make("restarted-unstarted-root"),
                    type: "node.updated" as const,
                    threadId,
                    occurredAt: now,
                    payload: { ...root, startedAt: DateTime.add(now, { milliseconds: 1 }) },
                  },
                ]
              : []),
            ...(unstartedChild === "replacement"
              ? [
                  {
                    id: EventId.make("rebound-unstarted-root"),
                    type: "node.updated" as const,
                    threadId,
                    occurredAt: now,
                    payload: { ...root, providerTurnId: ProviderTurnId.make("new-native-turn") },
                  },
                  {
                    id: EventId.make("rebound-native-turn"),
                    type: "provider-turn.updated" as const,
                    threadId,
                    occurredAt: now,
                    payload: {
                      ...target.turn,
                      id: ProviderTurnId.make("new-native-turn"),
                      providerThreadId: child.providerThreads[0]!.id,
                      runAttemptId: null,
                      nodeId: root.id,
                    },
                  },
                ]
              : []),
          ],
        });
      }
      if (retryRecovery !== undefined) {
        const threadId = ThreadId.make("native-child:1");
        const id =
          retryRecovery === "root" ? unstartedRootMarker : "effect:session-ended:native-turn:1";
        const read = projections.getThreadRecords;
        const claim = outbox.claimNext;
        const claims = vi
          .spyOn(outbox, "claimNext")
          .mockImplementation((input) => claim({ ...input, threadId }));
        let failures = 0;
        const spy = vi
          .spyOn(projections, "getThreadRecords")
          .mockImplementation((id, records, options) =>
            id === threadId && failures++ < 6
              ? Effect.fail(
                  new ProjectionStore.ProjectionStoreReadError({
                    threadId,
                    cause: "temporary storage failure",
                  }),
                )
              : read(id, records, options),
          );
        yield* Effect.gen(function* () {
          for (let attempt = 1; attempt <= 6; attempt++) {
            assert.isTrue(yield* worker.runControlOnce);
            const pending = Option.getOrThrow(yield* outbox.get(id));
            assert.equal(pending.status, "pending");
            assert.equal(pending.attemptCount, attempt);
            yield* TestClock.adjust(
              Math.max(
                0,
                Date.parse(pending.availableAt) - DateTime.toEpochMillis(yield* DateTime.now),
              ),
            );
          }
          spy.mockRestore();
          assert.isTrue(yield* worker.runControlOnce);
          assert.equal(Option.getOrThrow(yield* outbox.get(id)).status, "succeeded");
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              spy.mockRestore();
              claims.mockRestore();
            }),
          ),
        );
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
          if (admitting !== undefined && item === target) continue;
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
      if (retrySteer) {
        const read = projections.getThreadRecords;
        const claim = outbox.claimNext;
        const claims = vi.spyOn(outbox, "claimNext").mockImplementation((input) =>
          claim({
            ...input,
            threadId: target.threadId,
            onlyEffectTypes: ["provider-turn.steer"],
          }),
        );
        let failures = 0;
        const reads = vi
          .spyOn(projections, "getThreadRecords")
          .mockImplementation((id, records, options) =>
            id === target.threadId &&
            options?.messageIds?.includes(acceptedCommand.messageId) &&
            failures++ < 6
              ? Effect.fail(
                  new ProjectionStore.ProjectionStoreReadError({
                    threadId: id,
                    cause: "temporary saved-message read failure",
                  }),
                )
              : read(id, records, options),
          );
        yield* Effect.gen(function* () {
          for (let attempt = 1; attempt <= 6; attempt++) {
            assert.isTrue(yield* worker.runControlOnce);
            const pending = Option.getOrThrow(yield* outbox.get(steerEffect!.id));
            assert.equal(pending.status, "pending");
            assert.equal(pending.attemptCount, attempt);
            assert.equal(pending.request.type, "provider-turn.steer");
            if (pending.request.type === "provider-turn.steer")
              assert.isTrue(pending.request.followUpPending);
            assert.isEmpty(
              (yield* projections.getThreadProjection(target.threadId)).runs.filter(
                (run) => run.userMessageId === acceptedCommand.messageId,
              ),
            );
            yield* TestClock.adjust(
              Math.max(
                0,
                Date.parse(pending.availableAt) - DateTime.toEpochMillis(yield* DateTime.now),
              ),
            );
          }
          reads.mockRestore();
          if (accepted === "replacement session") {
            const claimed = yield* outbox.claimNext({
              workerId: "previous-process",
              threadId: target.threadId,
              onlyEffectTypes: ["provider-turn.steer"],
              leaseDurationMs: 30_000,
            });
            assert.equal(Option.getOrThrow(claimed).id, steerEffect!.id);
          }
          yield* outbox.reconcileAfterProcessLoss;
          assert.equal(Option.getOrThrow(yield* outbox.get(steerEffect!.id)).status, "pending");
          assert.isTrue(yield* worker.runControlOnce);
          assert.equal(Option.getOrThrow(yield* outbox.get(steerEffect!.id)).status, "succeeded");
          assert.equal(adapterSteers, 0);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              reads.mockRestore();
              claims.mockRestore();
            }),
          ),
        );
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
      yield* assertDelegation;
      if (appOwned) {
        const parent = yield* projections.getThreadProjection(target.threadId);
        assert.equal(
          parent.providerTurns.find((row) => row.id === target.turn.id)?.status,
          "interrupted",
        );
        assert.notEqual(parent.runs.find((row) => row.id === target.run.id)?.status, "running");
        return;
      }
      for (const [index, target] of targets.entries()) {
        const hasNativeWork =
          !foregroundOnly &&
          !(
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
          assert.equal(
            current.nodes.find((node) => node.id === "replacement-tool")?.status,
            "running",
          );
          assert.equal(
            current.turnItems.find((item) => item.id === "replacement-tool")?.status,
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
        if (instance !== "opencode" && admitting === undefined) {
          assert.equal(
            current.nodes.find((node) => node.id === `foreground-tool:${target.threadId}`)?.status,
            "interrupted",
          );
          assert.equal(
            current.turnItems.find((item) => item.id === `foreground-tool:${target.threadId}`)
              ?.status,
            "interrupted",
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
          if (unstartedChild !== undefined && depth === 1) {
            assert.equal(
              child.nodes.find((node) => node.id === "native-root:1")?.status,
              unstartedChild !== "released" ? "running" : "interrupted",
            );
            assert.equal(
              child.nodes.find((node) => node.id === "unrelated-native-root")?.status,
              "running",
            );
            if (unstartedChild === "replacement")
              assert.equal(child.providerTurns[0]?.status, "running");
            continue;
          }
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
      Effect.ensuring(Deferred.succeed(commitSteer, undefined)),
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
  { rebound: "ended", activeTurnOnly: false, delivered: false, cleanupOnly: false },
  { rebound: "live", activeTurnOnly: false, delivered: false, cleanupOnly: false },
  { rebound: "ended", activeTurnOnly: true, delivered: false, cleanupOnly: false },
  { rebound: "ended", activeTurnOnly: false, delivered: true, cleanupOnly: false },
  { rebound: "ended", activeTurnOnly: false, delivered: false, cleanupOnly: true },
] as const)(
  "handles committed session rebinding ($rebound, activeTurnOnly=$activeTurnOnly, delivered=$delivered, cleanupOnly=$cleanupOnly)",
  (options) =>
    sessionLoss({
      instance: "codex-cu",
      reason: "runtime_error",
      accepted: "before recovery",
      nativeThreads: true,
      ...options,
    }),
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

it.effect.each(["running", "failed"] as const)(
  "settles foreground tool artifacts after shared release (parent=%s)",
  (status) =>
    sessionLoss({
      instance: "codex-cu",
      reason: "runtime_error",
      foregroundOnly: true,
      ...(status === "failed" ? { terminalBeforeRelease: status } : {}),
    }),
);

it.effect.each([
  { activeTurnOnly: true, delivered: false },
  { activeTurnOnly: false, delivered: true },
])("does not requeue restricted late-committed input (%s)", (restriction) =>
  sessionLoss({
    instance: "codex-cu",
    reason: "runtime_error",
    accepted: "after preflight",
    terminalBeforeRelease: "failed",
    ...restriction,
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

it.effect.each(["completed", "failed", "interrupted", "cancelled"] as const)(
  "retains a steer committed after release and replacement (old turn=%s)",
  (terminalBeforeRelease) =>
    sessionLoss({
      instance: "codex-cu",
      reason: "runtime_error",
      accepted: "after preflight",
      terminalBeforeRelease,
    }),
);

it.effect.each(
  (["running", "completed"] as const).flatMap((parent) =>
    (["released", "replacement", "restarted"] as const).map((unstartedChild) => ({
      parent,
      unstartedChild,
    })),
  ),
)(
  "recovers a native child before its first turn ($parent, $unstartedChild)",
  ({ parent, unstartedChild }) =>
    sessionLoss({
      instance: "codex-cu",
      reason: "runtime_error",
      nativeThreads: true,
      unstartedChild,
      ...(parent === "completed" ? { terminalBeforeRelease: parent } : {}),
    }),
);

it.effect.each(["idle_timeout", "runtime_error"] as const)(
  "preserves an app-owned child's execution and item after parent session loss (%s)",
  (reason) =>
    sessionLoss({
      instance: "codex-cu",
      reason,
      appOwned: true,
      foregroundOnly: true,
      accepted: "after recovery",
    }),
);

it.effect.each(["turn", "root"] as const)(
  "recovers after six consecutive reconciliation read failures (%s)",
  (retryRecovery) =>
    sessionLoss({
      instance: "codex-cu",
      reason: "runtime_error",
      nativeThreads: true,
      terminalBeforeRelease: "completed",
      retryRecovery,
      ...(retryRecovery === "root" ? { unstartedChild: "released" as const } : {}),
    }),
);

it.effect.each(["after recovery", "replacement session"] as const)(
  "retains session-loss follow-up ownership after six storage failures (%s)",
  (accepted) =>
    sessionLoss({ instance: "codex-cu", reason: "runtime_error", accepted, retrySteer: true }),
);

it.effect.each(["cleared", "new roster"] as const)(
  "late subscriber finalization preserves the authoritative roster (%s)",
  (lateRoster) =>
    sessionLoss({
      instance: "codex-cu",
      reason: "runtime_error",
      nativeThreads: true,
      buffered: "running update",
      lateRoster,
    }),
);

it.effect.each([false, true])(
  "recovers the last in-flight steer before the release marker (activeTurnOnly=%s)",
  (activeTurnOnly) =>
    sessionLoss({
      instance: "codex-cu",
      reason: "runtime_error",
      accepted: "before recovery",
      lastAttemptLoss: true,
      activeTurnOnly,
    }),
);
