import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CONTEXT_RESET_TITLE } from "./divider.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

// A fake provider that opens a new native thread whenever T3 hands it a row
// without one, the way OpenCode creates a fresh session.
const contextResetHarness = Effect.fn("contextResetHarness")(function* (name: string) {
  const cwd = yield* checkpointWorkspace(name);
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
  const ensured: Array<OrchestrationV2ProviderThread | undefined> = [];
  let nativeThreads = 0;
  const capabilities = CodexProviderCapabilitiesV2;
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
          ensureThread: ({ threadId, existingProviderThread }) =>
            Effect.sync(() => {
              ensured.push(existingProviderThread);
              nativeThreads += 1;
              const base: OrchestrationV2ProviderThread = existingProviderThread ?? {
                id: ProviderThreadId.make(`provider-thread:${threadId}:${nativeThreads}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: null,
                nativeConversationHeadRef: null,
                status: "not_loaded",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              };
              return {
                ...base,
                providerSessionId: input.providerSessionId,
                nativeThreadRef: {
                  driver,
                  nativeId: `native-thread-${nativeThreads}`,
                  strength: "strong" as const,
                },
                status: "idle" as const,
                updatedAt: now,
              };
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
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerSingle(adapter),
    { runEffectWorker: false },
  );

  const waitForRunningTurn = Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
  });

  const startFirstTurn = Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make(`project:${name}`),
      title: "Context reset",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    const running = yield* waitForRunningTurn;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("first"),
      threadId,
      messageId: MessageId.make("message:first"),
      text: "first",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    yield* Fiber.join(running);
    return threadId;
  });

  // Completes the first run's provider turn and waits for the run to settle.
  const finishFirstTurn = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const first = started[0]!;
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
    });

  return { started, ensured, layer, startFirstTurn, finishFirstTurn, waitForRunningTurn };
});

const assertFreshSession = (
  projection: OrchestrationV2ThreadProjection,
  started: ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>,
  ensured: ReadonlyArray<OrchestrationV2ProviderThread | undefined>,
) => {
  assert.equal(started.length, 2);
  const [first, reset] = [started[0]!, started[1]!];
  assert.notEqual(reset.providerThread.id, first.providerThread.id);
  assert.notDeepEqual(reset.providerThread.nativeThreadRef, first.providerThread.nativeThreadRef);
  // Each run opened its own native thread from a row that had none.
  assert.equal(ensured.length, 2);
  assert.equal(ensured[1]?.id, reset.providerThread.id);
  assert.equal(ensured[1]?.nativeThreadRef, null);
  // The note is the only context: no handoff summary is folded in.
  assert.equal(reset.message.text, "resume note");

  const resetRun = projection.runs.find((run) => run.id === reset.runId);
  assert.equal(resetRun?.contextReset, true);
  assert.equal(resetRun?.providerThreadId, reset.providerThread.id);
  assert.equal(projection.thread.activeProviderThreadId, reset.providerThread.id);
  assert.isUndefined(projection.turnItems.find((item) => item.type === "handoff"));
  const divider = projection.turnItems.find(
    (item) => item.type === "compaction" && item.title === CONTEXT_RESET_TITLE,
  );
  assert.equal(divider?.runId, reset.runId);
  assert.equal(divider?.status, "completed");
};

it.effect("a queued context reset starts the next run on a fresh provider thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, ensured, layer, startFirstTurn, finishFirstTurn } =
        yield* contextResetHarness("context-reset-queued");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("reset"),
          threadId,
          messageId: MessageId.make("message:reset"),
          text: "resume note",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
          contextReset: true,
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* worker.drain();
        assert.equal(started.length, 1);

        yield* finishFirstTurn(threadId);
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();

        assertFreshSession(yield* orchestrator.getThreadProjection(threadId), started, ensured);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("an immediate context reset starts on a fresh provider thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, ensured, layer, startFirstTurn, finishFirstTurn, waitForRunningTurn } =
        yield* contextResetHarness("context-reset-immediate");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* finishFirstTurn(threadId);

        const running = yield* waitForRunningTurn;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("reset"),
          threadId,
          messageId: MessageId.make("message:reset"),
          text: "resume note",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          contextReset: true,
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* worker.drain();
        yield* Fiber.join(running);

        assertFreshSession(yield* orchestrator.getThreadProjection(threadId), started, ensured);
      }).pipe(Effect.provide(layer));
    }),
  ),
);
