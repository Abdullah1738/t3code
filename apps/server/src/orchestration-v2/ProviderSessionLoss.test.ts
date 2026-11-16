import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Sqlite from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Registry from "./ProviderAdapterRegistry.ts";
import * as Sessions from "./ProviderSessionManager.ts";
import * as Harness from "./testkit/ProviderReplayHarness.ts";
import { userFacingDispatchErrorMessage } from "./UserFacingErrors.ts";

it.effect.each([
  { instance: "codex", reason: "idle_timeout", replace: false, promotion: false },
  { instance: "codex-cu", reason: "runtime_error", replace: false, promotion: false },
  { instance: "codex-cu", reason: "manual_shutdown", replace: false, promotion: false },
  { instance: "codex-cu", reason: "runtime_error", replace: true, promotion: false },
  { instance: "opencode", reason: "runtime_error", replace: false, promotion: false },
  { instance: "codex-cu", reason: "idle_timeout", replace: false, promotion: true },
] as const)(
  "settles shared session loss ($instance, $reason, replacement=$replace, promotion=$promotion)",
  ({ instance, reason, replace, promotion }) =>
    Effect.gen(function* () {
      const closing = yield* Deferred.make<void>();
      const finishClose = yield* Deferred.make<void>();
      const instanceId = ProviderInstanceId.make(instance);
      const driver = ProviderDriverKind.make(instance === "opencode" ? "opencode" : "codex");
      const modelSelection = { instanceId, model: "test" };
      const sessionId = ProviderSessionId.make(
        `provider-session:provider-instance:${instance}:shared`,
      );
      const adapter = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
        openSession: () =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            yield* Effect.addFinalizer(() =>
              Deferred.succeed(closing, undefined).pipe(
                Effect.andThen(Deferred.await(finishClose)),
              ),
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
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.never,
              backgroundTasksEndWithProcess: instance !== "opencode",
            } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
          }),
      } as ProviderAdapter.ProviderAdapterV2["Service"];
      const database = Sqlite.layerMemory;
      const layer = Layer.mergeAll(
        ProjectionStore.layer.pipe(Layer.provide(database)),
        Harness.layerWithRegistry(
          { name: `session-loss-${instance}` },
          Registry.layerFromAdapters([adapter]),
          {
            databaseLayer: database,
            runEffectWorker: false,
          },
        ),
      );
      yield* Effect.gen(function* () {
        const engine = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const sink = yield* EventSink.EventSinkV2;
        const sessions = yield* Sessions.ProviderSessionManagerV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threads = [ThreadId.make("session-loss-a"), ThreadId.make("session-loss-b")];
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
                    instance === "opencode" ? [{ taskId: "remote-work", kind: "command" }] : [],
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
          targets.push({ threadId, run, attempt, root, providerThread, turn });
        }
        const releasing = yield* sessions
          .release({ providerSessionId: sessionId, reason })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(closing);
        assert.isTrue(Option.isNone(yield* sessions.get(sessionId)));
        const target = targets[0]!;
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
        assert.lengthOf(refused.messages, promotion ? 2 : 1);
        if (promotion)
          assert.lengthOf(
            refused.runs.filter((run) => run.status === "queued"),
            1,
          );
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
        }
        yield* Deferred.succeed(finishClose, undefined);
        yield* Fiber.join(releasing);
        yield* worker.drain();
        for (const [index, target] of targets.entries()) {
          const current = yield* projections.getThreadProjection(target.threadId);
          assert.equal(
            current.providerTurns.find((turn) => turn.id === target.turn.id)?.status,
            "interrupted",
          );
          assert.equal(
            current.runs.find((run) => run.id === target.run.id)?.status,
            replace && index === 0 ? "running" : "interrupted",
          );
          if (replace && index === 0) {
            assert.equal(
              current.providerTurns.find((turn) => turn.id === "replacement-turn")?.status,
              "running",
            );
          }
          if (instance === "opencode") {
            assert.deepEqual(
              current.providerThreads.find((thread) => thread.id === target.providerThread.id)
                ?.pendingBackgroundTasks,
              [{ taskId: "remote-work", kind: "command" }],
            );
          }
          if (!replace || index !== 0) {
            assert.equal(
              current.attempts.find((attempt) => attempt.id === target.attempt.id)?.status,
              "interrupted",
            );
            assert.equal(
              current.nodes.find((node) => node.id === target.root.id)?.status,
              "interrupted",
            );
          }
        }
        if (!replace && !promotion) {
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
      }).pipe(Effect.ensuring(Deferred.succeed(finishClose, undefined)), Effect.provide(layer));
    }),
);
