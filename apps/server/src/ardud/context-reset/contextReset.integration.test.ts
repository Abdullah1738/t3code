import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CONTEXT_RESET_TITLE } from "./divider.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

// A second account of the same provider. "shared" accounts can resume each
// other's native threads; "separate" ones need a handoff.
const otherInstanceId = ProviderInstanceId.make("codex-other");

// A fake provider that opens a new native thread whenever T3 hands it a row
// without one, the way OpenCode creates a fresh session.
const contextResetHarness = Effect.fn("contextResetHarness")(function* (
  name: string,
  options: {
    readonly otherAccount?: "shared" | "separate";
    // Muse and ACP sessions hold a single conversation: asking the same session
    // for a thread hands back the one it already has.
    readonly oneConversationPerSession?: boolean;
  } = {},
) {
  const cwd = yield* checkpointWorkspace(name);
  // Each opened session streams its own events.
  type Events = Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
  const latestSession = new Map<ProviderInstanceId, Events>();
  const turnEvents = new Map<string, Events>();
  const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
  const ensured: Array<OrchestrationV2ProviderThread | undefined> = [];
  const opened: string[] = [];
  let nativeThreads = 0;
  const capabilities = options.oneConversationPerSession
    ? {
        ...CodexProviderCapabilitiesV2,
        sessions: {
          ...CodexProviderCapabilitiesV2.sessions,
          supportsMultipleProviderThreadsPerSession: false,
        },
      }
    : CodexProviderCapabilitiesV2;
  const makeAdapter = (
    instanceId: ProviderInstanceId,
  ): ProviderAdapter.ProviderAdapterV2["Service"] => ({
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        latestSession.set(instanceId, events);
        opened.push(input.providerSessionId);
        let conversation: string | undefined;
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
              if (conversation === undefined || options.oneConversationPerSession !== true) {
                nativeThreads += 1;
                conversation = `native-thread-${nativeThreads}`;
              }
              const base: OrchestrationV2ProviderThread = existingProviderThread ?? {
                id: ProviderThreadId.make(`provider-thread:${threadId}:${ensured.length}`),
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
                  nativeId: conversation,
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
              turnEvents.set(turn.attemptId, events);
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
  });
  const primary = makeAdapter(instanceId);
  const other = makeAdapter(otherInstanceId);
  const otherAccount = options.otherAccount;
  const registry =
    otherAccount === undefined
      ? ProviderAdapterRegistry.layerSingle(primary)
      : Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
          get: (id) => Effect.succeed(id === instanceId ? primary : other),
          list: () => Effect.succeed([instanceId, otherInstanceId]),
          getMetadata: (id) =>
            Effect.succeed({
              driver,
              continuationKey:
                otherAccount === "shared" ? "codex:home:/shared" : `codex:home:/${id}`,
              enabled: true,
              capabilities,
            }),
        });
  const layer = ProviderReplayHarness.layerWithRegistry({ name }, registry, {
    runEffectWorker: false,
  });

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

  // Ends a started run's provider turn and waits for the run to settle.
  const finishTurn = (
    threadId: ThreadId,
    options: {
      readonly index?: number;
      readonly failed?: boolean;
      readonly childTurnsContinue?: boolean;
    } = {},
  ) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const turnInput = started[options.index ?? 0]!;
      const events = turnEvents.get(turnInput.attemptId)!;
      const settled = yield* orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === turnInput.runId &&
            event.payload.status === (options.failed === true ? "failed" : "waiting"),
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );
      const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns.find(
        (candidate) => candidate.runAttemptId === turnInput.attemptId,
      )!;
      const now = yield* DateTime.now;
      yield* Queue.offer(events, {
        type: "provider_turn.updated",
        driver,
        providerTurn: {
          ...turn,
          status: options.failed === true ? "failed" : "completed",
          completedAt: now,
        },
      });
      yield* Queue.offer(
        events,
        options.failed === true
          ? {
              type: "turn.terminal",
              driver,
              providerThreadId: turn.providerThreadId,
              providerTurnId: turn.id,
              runOrdinal: turnInput.runOrdinal,
              failureItemOrdinal: 100,
              status: "failed",
              failure: {
                class: "provider_error",
                message: "Provider turn failed.",
                code: null,
                retryable: null,
              },
              threadDisposition: "reusable",
              ...(options.childTurnsContinue === true ? { childTurnsContinue: true as const } : {}),
            }
          : {
              type: "turn.terminal",
              driver,
              providerThreadId: turn.providerThreadId,
              providerTurnId: turn.id,
              runOrdinal: turnInput.runOrdinal,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            },
      );
      yield* Fiber.join(settled);
      yield* worker.drain();
    });
  const finishFirstTurn = (threadId: ThreadId) => finishTurn(threadId);
  const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
    Queue.offer(latestSession.get(instanceId)!, event);

  return {
    started,
    ensured,
    opened,
    layer,
    startFirstTurn,
    finishTurn,
    finishFirstTurn,
    waitForRunningTurn,
    emit,
  };
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

it.effect(
  "an immediate context reset opens a new session where a session holds one conversation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {
          started,
          ensured,
          opened,
          layer,
          startFirstTurn,
          finishFirstTurn,
          waitForRunningTurn,
        } = yield* contextResetHarness("context-reset-one-conversation", {
          oneConversationPerSession: true,
        });
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
          assert.equal(opened.length, 2);
          assert.notEqual(opened[1], opened[0]);
          assert.equal(started[1]?.providerThread.providerSessionId, opened[1]);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("an immediate context reset on an imported thread brings no old history", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, ensured, layer, startFirstTurn, finishTurn, waitForRunningTurn } =
        yield* contextResetHarness("context-reset-imported");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = yield* startFirstTurn;

        // A thread imported from V1 whose first V2 run failed, so the next
        // ordinary run would carry the imported transcript as a handoff.
        const now = yield* DateTime.now;
        const { thread } = yield* orchestrator.getThreadProjection(threadId);
        const messageId = MessageId.make("message:imported");
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("event:imported:thread"),
              type: "thread.metadata-updated",
              threadId,
              occurredAt: now,
              payload: { ...thread, historyOrigin: "v1_import" },
            },
            {
              id: EventId.make("event:imported:message"),
              type: "message.updated",
              threadId,
              occurredAt: now,
              payload: {
                createdBy: "agent",
                creationSource: "server",
                id: messageId,
                threadId,
                runId: null,
                nodeId: null,
                role: "assistant",
                text: "old v1 answer",
                attachments: [],
                streaming: false,
                createdAt: now,
                updatedAt: now,
              },
            },
            {
              id: EventId.make("event:imported:turn-item"),
              type: "turn-item.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make("turn-item:imported"),
                threadId,
                runId: null,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 0,
                status: "completed",
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "assistant_message",
                messageId,
                text: "old v1 answer",
                streaming: false,
              },
            },
          ],
        });
        yield* finishTurn(threadId, { failed: true });

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

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(projection.thread.historyOrigin, "v1_import");
        assertFreshSession(projection, started, ensured);
        assert.deepStrictEqual(projection.contextHandoffs, []);
        assert.deepStrictEqual(started[1]?.providerThread.handoffIds, []);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect.each([{ transfer: "fork" }, { transfer: "merge_back" }] as const)(
  "a context reset refuses while a $transfer transfer is pending, and leaves it pending",
  ({ transfer }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, layer, startFirstTurn, finishFirstTurn } = yield* contextResetHarness(
          `context-reset-${transfer}`,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const threadId = yield* startFirstTurn;
          const now = yield* DateTime.now;
          const transferId = ContextTransferId.make(`transfer:${transfer}`);
          const source = ThreadId.make(`thread:${transfer}-source`);
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`event:${transfer}`),
                type: "context-transfer.created",
                threadId,
                occurredAt: now,
                payload: {
                  id: transferId,
                  type: transfer,
                  sourceThreadId: source,
                  targetThreadId: threadId,
                  sourcePoint: { threadId: source },
                  basePoint: null,
                  sourceProviderInstanceId: instanceId,
                  targetProviderInstanceId: instanceId,
                  targetRunId: null,
                  status: "pending",
                  resolution: null,
                  createdBy: "user",
                  error: null,
                  createdAt: now,
                  updatedAt: now,
                  consumedAt: null,
                },
              },
            ],
          });
          const reset = (key: string, dispatchMode: "queue_after_active" | "start_immediately") =>
            orchestrator
              .dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(key),
                threadId,
                messageId: MessageId.make(`message:${key}`),
                text: "resume note",
                attachments: [],
                modelSelection,
                dispatchMode: { type: dispatchMode },
                contextReset: true,
                createdBy: "agent",
                creationSource: "mcp",
              })
              .pipe(Effect.exit);

          // Queued behind the running turn, and again once the thread is idle.
          assert.isTrue((yield* reset("reset-queued", "queue_after_active"))._tag === "Failure");
          yield* finishFirstTurn(threadId);
          assert.isTrue((yield* reset("reset-now", "start_immediately"))._tag === "Failure");

          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.strictEqual(started.length, 1);
          assert.deepStrictEqual(
            projection.contextTransfers.map((each) => [each.id, each.status]),
            [[transferId, "pending"]],
          );
          assert.isFalse(projection.runs.some((run) => run.contextReset === true));
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("a context reset queued behind a follow-up that fails still starts fresh", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, ensured, layer, startFirstTurn, finishTurn, waitForRunningTurn } =
        yield* contextResetHarness("context-reset-after-failure");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const queue = (key: string, text: string, contextReset = false) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(key),
            threadId,
            messageId: MessageId.make(`message:${key}`),
            text,
            attachments: [],
            modelSelection,
            dispatchMode: { type: "queue_after_active" },
            ...(contextReset ? { contextReset: true } : {}),
            createdBy: "agent",
            creationSource: "mcp",
          });
        // A follow-up, a message the reset note has to jump, the note, and
        // one more message.
        yield* queue("follow-up", "follow-up");
        yield* queue("before", "before the reset");
        yield* queue("reset", "resume note", true);
        yield* queue("after", "after the reset");
        yield* worker.drain();
        assert.equal(started.length, 1);

        const followUpRunning = yield* waitForRunningTurn;
        yield* finishTurn(threadId);
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        yield* Fiber.join(followUpRunning);
        assert.equal(started.length, 2);
        assert.equal(started[1]!.message.text, "follow-up");

        // The follow-up fails on a provider error. That holds the queue, but
        // the reset note still starts, on a fresh provider thread.
        const resetStarting = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.status === "starting" &&
              event.payload.contextReset === true,
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const running = yield* waitForRunningTurn;
        yield* finishTurn(threadId, { index: 1, failed: true });
        yield* Fiber.join(resetStarting);
        yield* worker.drain();
        yield* Fiber.join(running);

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(started.length, 3);
        const reset = started[2]!;
        assert.equal(reset.message.text, "resume note");
        assert.notEqual(reset.providerThread.id, started[1]!.providerThread.id);
        assert.equal(ensured.at(-1)?.nativeThreadRef, null);
        const resetRun = projection.runs.find((run) => run.id === reset.runId);
        assert.equal(resetRun?.contextReset, true);
        assert.equal(projection.thread.activeProviderThreadId, reset.providerThread.id);
        for (const key of ["before", "after"]) {
          const held = projection.runs.find(
            (run) => run.userMessageId === MessageId.make(`message:${key}`),
          );
          assert.equal(held?.status, "queued");
          assert.isTrue(held?.queueHeld);
        }
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("a context reset stays held while the failed turn's children still run", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, layer, startFirstTurn, finishTurn, waitForRunningTurn, emit } =
        yield* contextResetHarness("context-reset-live-child");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const queue = (key: string, text: string, contextReset = false) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(key),
            threadId,
            messageId: MessageId.make(`message:${key}`),
            text,
            attachments: [],
            modelSelection,
            dispatchMode: { type: "queue_after_active" },
            ...(contextReset ? { contextReset: true } : {}),
            createdBy: "agent",
            creationSource: "mcp",
          });
        yield* queue("follow-up", "follow-up");
        yield* queue("reset", "resume note", true);
        yield* worker.drain();

        const followUpRunning = yield* waitForRunningTurn;
        yield* finishTurn(threadId);
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        yield* Fiber.join(followUpRunning);
        const followUp = started[1]!;

        // The follow-up starts a native child, then fails while the child
        // keeps running and reporting to the old provider thread.
        const now = yield* DateTime.now;
        const childId = NodeId.make("node:live-child");
        const childRunning = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "subagent.updated" && event.payload.id === childId,
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* emit({
          type: "subagent.updated",
          driver,
          subagent: {
            id: childId,
            threadId,
            runId: followUp.runId,
            parentNodeId: followUp.rootNodeId,
            origin: "provider_native",
            createdBy: "agent",
            driver,
            providerInstanceId: instanceId,
            providerThreadId: null,
            childThreadId: null,
            nativeTaskRef: { driver, nativeId: "task-live-child", strength: "strong" },
            prompt: "keep working",
            title: "live child",
            model: null,
            status: "running",
            result: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
          },
        });
        yield* Fiber.join(childRunning);
        // Whichever comes first: the note held with the queue, or started.
        const resetDecided = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.userMessageId === MessageId.make("message:reset") &&
              (event.payload.queueHeld === true || event.payload.status === "starting"),
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* finishTurn(threadId, { index: 1, failed: true, childTurnsContinue: true });
        yield* Fiber.join(resetDecided);
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(started.length, 2);
        const reset = projection.runs.find(
          (run) => run.userMessageId === MessageId.make("message:reset"),
        );
        assert.equal(reset?.status, "queued");
        assert.isTrue(reset?.queueHeld);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect.each([
  { account: "shared", dispatch: "queued" },
  { account: "separate", dispatch: "queued" },
  { account: "shared", dispatch: "immediate" },
  { account: "separate", dispatch: "immediate" },
] as const)(
  "a context reset ($dispatch) on another $account account starts with only its note",
  ({ account, dispatch }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, ensured, layer, startFirstTurn, finishFirstTurn, waitForRunningTurn } =
          yield* contextResetHarness(`context-reset-${account}-${dispatch}`, {
            otherAccount: account,
          });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const resetMessage = (dispatchMode: "queue_after_active" | "start_immediately") =>
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("reset"),
              threadId,
              messageId: MessageId.make("message:reset"),
              text: "resume note",
              attachments: [],
              modelSelection: { instanceId: otherInstanceId, model: "test-model" },
              dispatchMode: { type: dispatchMode },
              contextReset: true,
              createdBy: "agent",
              creationSource: "mcp",
            });
          const running = yield* waitForRunningTurn;
          if (dispatch === "queued") {
            yield* resetMessage("queue_after_active");
            yield* worker.drain();
            yield* finishFirstTurn(threadId);
            yield* orchestrator.resumeQueuedRuns;
          } else {
            yield* finishFirstTurn(threadId);
            yield* resetMessage("start_immediately");
          }
          yield* worker.drain();
          yield* Fiber.join(running);

          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(started.length, 2);
          const reset = started[1]!;
          assert.equal(reset.message.text, "resume note");
          assert.equal(reset.providerThread.providerInstanceId, otherInstanceId);
          // A fresh native thread from a row without one, never the old
          // thread resumed on the other account.
          assert.equal(ensured.length, 2);
          assert.equal(ensured[1]?.nativeThreadRef, null);
          assert.notDeepEqual(
            reset.providerThread.nativeThreadRef,
            started[0]!.providerThread.nativeThreadRef,
          );
          assert.isEmpty(projection.contextHandoffs);
          assert.isUndefined(projection.turnItems.find((item) => item.type === "handoff"));
        }).pipe(Effect.provide(layer));
      }),
    ),
);
