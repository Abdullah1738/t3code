import { assert, it } from "@effect/vitest";
import {
  CommandId,
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
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { idleBlocker } from "../ardud/archive-if-idle/idle.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const database = SqlitePersistence.layerMemory;
const stores = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  EventStore.layer.pipe(Layer.provide(database)),
  EffectOutbox.layer.pipe(Layer.provide(database)),
  IdAllocator.layer,
);
const layerTest = Layer.mergeAll(
  ProviderRuntimeRecovery.layer.pipe(
    Layer.provideMerge(EventSink.layer.pipe(Layer.provideMerge(stores))),
  ),
  ProviderReplayHarness.layerWithRegistry(
    { name: "runless-repair" },
    ProviderAdapterRegistry.layerFromAdapters([]),
    { databaseLayer: database, runEffectWorker: false },
  ),
).pipe(Layer.provideMerge(ServerSettings.layerTest()));

const threadId = ThreadId.make("thread:runless-repair");
const providerInstanceId = ProviderInstanceId.make("opencode");
const providerThreadId = ProviderThreadId.make("provider-thread:runless-repair");
const providerTurnId = ProviderTurnId.make("provider-turn:runless-repair");
const nodeId = NodeId.make("node:runless-repair");
const driver = ProviderDriverKind.make("opencode");
// Trimmed Recall #66 sample: no app runs, requests or subagents; idle native
// thread, cancelled root, and a provider turn still running since its import.
const startedAt = DateTime.makeUnsafe("2026-10-03T02:38:06.228Z");
const completedAt = DateTime.makeUnsafe("2026-10-03T02:53:13.220Z");
const seed = Effect.fn("RunlessRepairTest.seed")(function* (active: boolean) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create:runless-repair"),
    threadId,
    projectId: ProjectId.make("project:runless-repair"),
    title: "Imported native child",
    modelSelection: { instanceId: providerInstanceId, model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "agent",
    creationSource: "provider",
  });
  const sink = yield* EventSink.EventSinkV2;
  const events: OrchestrationV2DomainEvent[] = [
    {
      id: EventId.make("seed:provider-thread"),
      type: "provider-thread.updated",
      threadId,
      providerInstanceId,
      occurredAt: completedAt,
      payload: {
        id: providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "native:runless-repair", strength: "strong" },
        nativeConversationHeadRef: null,
        status: active ? "active" : "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        createdAt: startedAt,
        updatedAt: completedAt,
      },
    },
    {
      id: EventId.make("seed:node"),
      type: "node.updated",
      threadId,
      nodeId,
      providerInstanceId,
      occurredAt: completedAt,
      payload: {
        id: nodeId,
        threadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "root_turn",
        status: active ? "running" : "cancelled",
        countsForRun: false,
        providerThreadId,
        providerTurnId,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt,
        completedAt: active ? null : completedAt,
      },
    },
    {
      id: EventId.make("seed:turn"),
      type: "provider-turn.updated",
      threadId,
      nodeId,
      providerInstanceId,
      occurredAt: startedAt,
      payload: {
        id: providerTurnId,
        providerThreadId,
        nodeId,
        runAttemptId: null,
        nativeTurnRef: { driver, nativeId: "native:runless-repair:turn:1", strength: "weak" },
        ordinal: 1,
        status: "running",
        startedAt,
        completedAt: null,
      },
    },
  ];
  if (active)
    events.push({
      id: EventId.make("seed:item"),
      type: "turn-item.updated",
      threadId,
      nodeId,
      providerInstanceId,
      occurredAt: startedAt,
      payload: {
        id: TurnItemId.make("item:runless-repair"),
        threadId,
        runId: null,
        nodeId,
        providerThreadId,
        providerTurnId,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        type: "assistant_message",
        messageId: MessageId.make("message:runless-repair"),
        text: "Working",
        streaming: true,
        status: "running",
        title: null,
        startedAt,
        completedAt: null,
        updatedAt: startedAt,
      },
    });
  yield* sink.write({ events });
});
const blocker = (projection: Parameters<typeof idleBlocker>[0]["projection"]) =>
  idleBlocker({
    projection,
    now: completedAt,
    restartContinuationPending: false,
    continuationOffered: false,
    providerThreadsHoldingWork: [],
    expectedNativeSessionId: undefined,
  });
it.live("repairs historical runless turns through events and is a no-op on rerun", () =>
  Effect.gen(function* () {
    yield* seed(false);
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const eventStore = yield* EventStore.EventStoreV2;
    assert.equal(
      blocker(yield* projections.getThreadProjection(threadId))?.reason,
      "background-work",
    );
    const before = yield* eventStore.latestSequence({ threadId });
    assert.deepEqual(yield* projections.getRecoveryThreadIds("runless-provider-turns"), [threadId]);
    assert.deepEqual(yield* orchestrator.repairRunlessProviderTurns, {
      candidates: 1,
      turnsEnded: 1,
    });
    yield* worker.drain();
    const projection = yield* projections.getThreadProjection(threadId);
    assert.equal(projection.providerTurns[0]?.status, "cancelled");
    assert.deepEqual(projection.providerTurns[0]?.completedAt, completedAt);
    assert.isNull(blocker(projection));
    const events = yield* eventStore
      .read({ threadId, afterSequence: before })
      .pipe(Stream.runCollect);
    assert.deepEqual(
      events.map((e) => e.event.type),
      ["provider-turn.updated"],
    );
    const sequence = yield* eventStore.latestSequence({ threadId });
    assert.deepEqual(yield* orchestrator.repairRunlessProviderTurns, {
      candidates: 0,
      turnsEnded: 0,
    });
    yield* worker.drain();
    assert.equal(yield* eventStore.latestSequence({ threadId }), sequence);
  }).pipe(Effect.provide(layerTest)),
);

it.live("startup recovery cancels a runless child's root, item and provider turn", () =>
  Effect.gen(function* () {
    yield* seed(true);
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    assert.equal(
      (yield* projections.getRuntimeRecoveryProjection(threadId)).providerTurns.length,
      1,
    );
    yield* recovery.recover;
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    const projection = yield* projections.getThreadProjection(threadId);
    assert.equal(projection.nodes[0]?.status, "cancelled");
    assert.equal(projection.turnItems[0]?.status, "cancelled");
    assert.equal(projection.providerTurns[0]?.status, "cancelled");
    assert.isNotNull(projection.providerTurns[0]?.completedAt);
  }).pipe(Effect.provide(layerTest)),
);

it.live("leaves a live native child blocked and out of the repair cohort", () =>
  Effect.gen(function* () {
    yield* seed(true);
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    assert.deepEqual(yield* orchestrator.repairRunlessProviderTurns, {
      candidates: 0,
      turnsEnded: 0,
    });
    assert.equal(
      blocker(yield* projections.getThreadProjection(threadId))?.reason,
      "background-work",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.live("finds candidates with the partial turn index and node primary key", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
    SELECT turn.thread_id FROM orchestration_v2_projection_provider_turns AS turn
      INDEXED BY ardud_runless_provider_turns_live_idx
    CROSS JOIN orchestration_v2_projection_nodes AS node ON node.node_id = turn.node_id
    WHERE turn.run_attempt_id IS NULL AND turn.status IN ('pending', 'running')
      AND node.thread_id = turn.thread_id AND node.kind = 'root_turn' AND node.run_id IS NULL
      AND node.status IN ('completed', 'failed', 'interrupted', 'cancelled')`;
    assert.isTrue(plan.some((row) => row.detail.includes("ardud_runless_provider_turns_live_idx")));
    assert.isTrue(
      plan.some((row) =>
        /SEARCH node USING INDEX sqlite_autoindex_orchestration_v2_projection_nodes/.test(
          row.detail,
        ),
      ),
    );
  }).pipe(Effect.provide(layerTest)),
);
