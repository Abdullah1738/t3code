import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProviderSessionId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as Analytics from "../ardud/analytics/Analytics.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Option from "effect/Option";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-6.1-sol" };

it.effect("stops a silent native turn accepted while superseding Stop was planning", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("late-provider-start");
      const threadId = ThreadId.make("thread:late-provider-start");
      const opening = yield* Deferred.make<void>();
      const allowOpen = yield* Deferred.make<void>();
      const stopPlanned = yield* Deferred.make<void>();
      const allowStopCommit = yield* Deferred.make<void>();
      const registered = yield* Deferred.make<void>();
      const terminalHandled = yield* Deferred.make<void>();
      const stopped: ProviderTurnId[] = [];
      const turnId = ProviderTurnId.make("provider-turn:late-provider-start");
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (sessionInput) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(opening, undefined);
            yield* Deferred.await(allowOpen);
            const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
            const now = yield* DateTime.now;
            let active: ProviderAdapter.ProviderAdapterV2TurnInput | undefined;
            return {
              instanceId,
              driver,
              providerSessionId: sessionInput.providerSessionId,
              providerSession: {
                id: sessionInput.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromPubSub(events),
              ensureThread: (input) =>
                Effect.succeed({
                  id: ProviderThreadId.make("provider-thread:late-provider-start"),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: sessionInput.providerSessionId,
                  appThreadId: input.threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: "late-provider-start", strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  contextUsage: null,
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (input) =>
                Effect.gen(function* () {
                  active = input;
                  yield* PubSub.publish(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: turnId,
                      providerThreadId: input.providerThread.id,
                      nodeId: input.rootNodeId,
                      runAttemptId: input.attemptId,
                      nativeTurnRef: null,
                      ordinal: input.providerTurnOrdinal,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                  });
                }),
              interruptTurn: (input) =>
                Effect.gen(function* () {
                  assert.isFalse(input.stopBackgroundWork);
                  assert.isFalse(input.requestRuntimeRestart);
                  stopped.push(input.providerTurnId);
                  assert.isDefined(active);
                  yield* PubSub.publish(events, {
                    type: "turn.terminal",
                    driver,
                    providerThreadId: input.providerThread.id,
                    providerTurnId: input.providerTurnId,
                    runOrdinal: active.runOrdinal,
                    status: "interrupted",
                    failure: null,
                    threadDisposition: "reusable",
                  });
                }),
              steerTurn: () => Effect.die("unused steer"),
              respondToRuntimeRequest: () => Effect.die("unused response"),
              readThreadSnapshot: () => Effect.die("unused snapshot"),
              rollbackThread: () => Effect.die("unused rollback"),
              forkThread: () => Effect.die("unused fork"),
            } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
          }),
      };
      const layer = ProviderReplayHarness.layerWithRegistry(
        { name: "late-provider-start" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        {
          runEffectWorker: false,
          beforeCommandCommit: (input) =>
            input.commandType === "thread.stop"
              ? Deferred.succeed(stopPlanned, undefined).pipe(
                  Effect.andThen(Deferred.await(allowStopCommit)),
                )
              : Effect.void,
        },
      ).pipe(
        Layer.provide(
          Layer.mock(Analytics.Analytics)({
            record: (row) =>
              row.kind === "orchestration.never_started_terminal_drain"
                ? Deferred.succeed(terminalHandled, undefined).pipe(Effect.asVoid)
                : Effect.void,
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const engine = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("late:create"),
          threadId,
          projectId: ProjectId.make("project:late-provider-start"),
          title: "Late provider start",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* engine.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("late:send"),
          threadId,
          messageId: MessageId.make("message:late"),
          text: "Review the board card",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "start_immediately" },
        });
        yield* engine.streamDomainEvents.pipe(
          Stream.runForEach((event) =>
            event.type === "provider-turn.updated" && event.payload.status === "running"
              ? Deferred.succeed(registered, undefined)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        const starting = yield* worker.drain().pipe(Effect.forkScoped);
        yield* Deferred.await(opening);
        const stop = yield* engine
          .dispatch({
            type: "thread.stop",
            commandId: CommandId.make("late:stop"),
            threadId,
            cancelReason: "superseded",
            reason: "Board state changed during launch",
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(stopPlanned);
        yield* Deferred.succeed(allowOpen, undefined);
        yield* Fiber.join(starting);
        yield* Deferred.await(registered);
        const before = yield* engine.getThreadProjection(threadId);
        assert.equal(before.runs[0]?.status, "running");
        assert.isEmpty(stopped);
        // Startup has succeeded; no cancellation of its worker or later native event can help.
        yield* Deferred.succeed(allowStopCommit, undefined);
        yield* Fiber.join(stop);
        yield* Deferred.await(terminalHandled);
        yield* worker.drain();
        assert.deepEqual(stopped, [turnId]);
        const after = yield* engine.getThreadProjection(threadId);
        assert.equal(after.runs[0]?.status, "interrupted");
        assert.equal(after.runs[0]?.cancelReason, "superseded");
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect.each(["interrupted", "newer-run"] as const)(
  "queues an exact interrupt for a turn first reported after ownership was lost: %s",
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make(`thread:late-event:${kind}`);
        const turnId = ProviderTurnId.make(`provider-turn:late-event:${kind}`);
        const queued = yield* Deferred.make<void>();
        const rows: Array<unknown> = [];
        const adapter = {
          instanceId,
          driver,
          getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
          openSession: () => Effect.die("Startup has already been claimed by another worker"),
        } as ProviderAdapter.ProviderAdapterV2["Service"];
        const layer = ProviderReplayHarness.layerWithRegistry(
          { name: `late-event-${kind}` },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          { runEffectWorker: false },
        ).pipe(
          Layer.provide(
            Layer.mock(Analytics.Analytics)({
              record: (row) =>
                Effect.gen(function* () {
                  rows.push(row);
                  if (row.kind === "provider_turn.late_start_interrupt_queued")
                    yield* Deferred.succeed(queued, undefined);
                }),
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const engine = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          const outbox = yield* EffectOutbox.EffectOutboxV2;
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`${kind}:create`),
            threadId,
            projectId: ProjectId.make("project:late-event"),
            title: "Late event",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
          const send = (key: string) =>
            engine.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`${kind}:send:${key}`),
              threadId,
              messageId: MessageId.make(`${kind}:${key}`),
              text: key,
              attachments: [],
              createdBy: "user",
              creationSource: "web",
              dispatchMode: { type: "start_immediately" },
            });
          yield* send("first");
          const before = yield* engine.getThreadProjection(threadId);
          const run = before.runs[0]!;
          const providerThread = before.providerThreads[0]!;
          const claimed = yield* outbox.claimNext({
            workerId: "late-start-worker",
            leaseDurationMs: 60_000,
            onlyEffectTypes: ["provider-turn.start"],
          });
          assert.isTrue(Option.isSome(claimed));
          yield* engine.dispatch({
            type: "thread.stop",
            commandId: CommandId.make(`${kind}:stop`),
            threadId,
            cancelReason: "superseded",
            reason: "Board state changed during launch",
          });
          if (kind === "newer-run") yield* send("second");
          const current = yield* engine.getThreadProjection(threadId);
          const now = yield* DateTime.now;
          yield* sink.write({
            events: [
              {
                id: EventId.make(`${kind}:attached`),
                type: "provider-thread.updated",
                threadId,
                occurredAt: now,
                payload: {
                  ...providerThread,
                  providerSessionId: ProviderSessionId.make(`${kind}:session`),
                },
              },
              {
                id: EventId.make(`${kind}:started`),
                type: "provider-turn.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  id: turnId,
                  providerThreadId: providerThread.id,
                  nodeId: run.rootNodeId!,
                  runAttemptId: run.activeAttemptId!,
                  nativeTurnRef: null,
                  ordinal: 1,
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                },
              },
            ],
          });
          yield* Deferred.await(queued);
          const effects = yield* outbox.listByCommandId(CommandId.make(`late-start:${turnId}`));
          assert.lengthOf(effects, 1);
          assert.deepEqual(effects[0]!.request, {
            type: "provider-turn.interrupt",
            stopBackgroundWork: false,
            providerSessionId: ProviderSessionId.make(`${kind}:session`),
            providerThreadId: providerThread.id,
            providerTurnId: turnId,
          });
          const after = yield* engine.getThreadProjection(threadId);
          assert.equal(after.runs.find((row) => row.id === run.id)?.status, "interrupted");
          if (kind === "newer-run") assert.deepEqual(after.runs.at(-1), current.runs.at(-1));
          assert.lengthOf(
            rows.filter(
              (row) =>
                (row as { kind: string }).kind === "provider_turn.late_start_interrupt_queued",
            ),
            1,
          );
        }).pipe(Effect.provide(layer));
      }),
    ),
);
