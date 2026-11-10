import { assert, it, vi } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  CommandId,
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderSession,
  OrchestrationV2ProviderSessionJson,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  OrchestrationV2TurnItem,
  type OrchestrationV2ThreadShellSnapshot,
  NodeId,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { liveColumns } from "../ardud/persistence/historyArchiveSql.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  buildBoundedThreadProjection,
  decodeThreadHistoryCursor,
  selectHistoryPageFromCursor,
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
} from "./threadHistoryPaging.ts";

const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const providerInstanceId = modelSelection.instanceId;
const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it("keeps native acceptance only for the same provider turn and attempt through usage and recovery updates", () => {
  const now = DateTime.makeUnsafe("2026-11-06T00:00:00Z");
  const acknowledged: OrchestrationV2ProviderTurn = {
    id: ProviderTurnId.make("turn:acknowledged"),
    providerThreadId: ProviderThreadId.make("provider-thread:acknowledged"),
    nodeId: NodeId.make("node:acknowledged"),
    runAttemptId: RunAttemptId.make("attempt:acknowledged"),
    nativeTurnRef: null,
    ordinal: 1,
    status: "running",
    startedAt: now,
    completedAt: null,
    promptAcceptedAt: now,
  };
  const { promptAcceptedAt: _acceptedAt, ...withoutMarker } = acknowledged;
  const usage = { usedTokens: 1000, maxTokens: 200_000, updatedAt: DateTime.formatIso(now) };
  const updated = ProjectionStore.upsertProviderTurn([acknowledged], {
    ...withoutMarker,
    tokenUsage: usage,
  });
  const cancelled = ProjectionStore.upsertProviderTurn(updated, {
    ...withoutMarker,
    status: "cancelled",
    completedAt: now,
  });
  assert.deepEqual(cancelled[0]?.promptAcceptedAt, now);
  assert.deepEqual(cancelled[0]?.tokenUsage, usage);
  for (const change of [
    { id: ProviderTurnId.make("turn:other") },
    { providerThreadId: ProviderThreadId.make("provider-thread:other") },
    { nodeId: NodeId.make("node:other") },
    { runAttemptId: RunAttemptId.make("attempt:other") },
    { runAttemptId: null },
  ]) {
    const next = { ...withoutMarker, ...change, tokenUsage: usage };
    assert.isUndefined(
      ProjectionStore.upsertProviderTurn([acknowledged], next).find((turn) => turn.id === next.id)
        ?.promptAcceptedAt,
    );
  }
});

const traceSqlStatements = () => {
  const statements: Array<string> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const query = span.attributes.get("db.query.text");
        if (typeof query === "string") statements.push(query);
      };
      return span;
    },
  });
  return { statements, tracer };
};

const archiveTurnItems = Effect.fn("test.archiveTurnItems")(function* (
  threadId: ThreadId,
  throughOrdinal = Number.MAX_SAFE_INTEGER,
  storage: "cold" | "base" = "cold",
) {
  const sql = yield* SqlClient.SqlClient;
  const columns = liveColumns("orchestration_v2_projection_turn_items");
  if (storage === "base") {
    yield* sql.unsafe(
      `INSERT INTO ardud_base.orchestration_v2_projection_turn_items (${columns})
        SELECT ${columns} FROM orchestration_v2_projection_turn_items WHERE thread_id = ?`,
      [threadId],
    );
  }
  yield* sql.unsafe(
    `INSERT INTO ardud_archive.ardud_turn_items (${columns})
      SELECT ${columns} FROM orchestration_v2_projection_turn_items WHERE thread_id = ?
        ${storage === "base" ? "AND ordinal % 3 = 0" : ""}`,
    [threadId],
  );
  yield* sql`DELETE FROM orchestration_v2_projection_turn_items
    WHERE thread_id = ${threadId} AND ordinal <= ${throughOrdinal}`;
  // Shadowed cold payloads must never be decoded or win a first-input lookup.
  yield* sql`UPDATE ardud_archive.ardud_turn_items SET payload_json = '{}'
    WHERE thread_id = ${threadId} AND ordinal > ${throughOrdinal}`;
  if (storage === "base") {
    yield* sql`UPDATE ardud_base.orchestration_v2_projection_turn_items AS item SET payload_json = '{}'
      WHERE item.thread_id = ${threadId} AND (
        EXISTS (SELECT 1 FROM main.orchestration_v2_projection_turn_items AS hot
          WHERE hot.turn_item_id = item.turn_item_id)
        OR EXISTS (SELECT 1 FROM ardud_archive.ardud_turn_items AS delta
          WHERE delta.turn_item_id = item.turn_item_id)
      )`;
  }
});

const assertIndexedHistoryWindow = (details: readonly string[]) => {
  for (const detail of details) {
    assert.notMatch(
      detail,
      /^SCAN (?:(?:main|ardud_base)\.orchestration_v2_projection_turn_items|cold|base|item)(?:$| )/,
      details.join("\n"),
    );
    assert.notMatch(
      detail,
      /SEARCH (?:(?:main|ardud_base)\.orchestration_v2_projection_turn_items|ardud_history_turn_items|cold|base|item|first_input) USING AUTOMATIC.*INDEX/,
      details.join("\n"),
    );
  }
};

const addRolledBackRecoveryCandidate = Effect.fn("addRolledBackRecoveryCandidate")(function* (
  suffix: string,
) {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:${suffix}:rolled-back`);
  const runId = RunId.make(`run:${suffix}:rolled-back`);
  const rootNodeId = NodeId.make(`node:${suffix}:rolled-back`);
  const run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message:${suffix}:rolled-back`),
    rootNodeId,
    activeAttemptId: null,
    status: "running" as const,
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };

  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:thread-created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make(`project:${suffix}`),
      title: "Rolled-back recovery candidate",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:run-created`),
    type: "run.created",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    providerInstanceId,
    occurredAt: now,
    payload: run,
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:item-running`),
    type: "turn-item.updated",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(`item:${suffix}:rolled-back`),
      threadId,
      runId,
      nodeId: rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: "abandoned command",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "command_execution",
      input: "sleep 60",
    },
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:run-rolled-back`),
    type: "run.updated",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    occurredAt: now,
    payload: { ...run, status: "rolled_back", completedAt: now },
  });

  return threadId;
});

const seededHistoryProjectionFixture = Effect.fn("seededHistoryProjectionFixture")(function* (
  mode: "claude-transcript" | "codex-inject",
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const at = DateTime.makeUnsafe("2026-11-01T12:00:00.000Z");
  const threadId = ThreadId.make(`thread:seeded-history:${mode}`);
  const sourceInstanceId = ProviderInstanceId.make("opencode");
  const sourceDriver = ProviderDriverKind.make("opencode");
  const sourceModelSelection = { instanceId: sourceInstanceId, model: "source-model" };
  const targetInstanceId = ProviderInstanceId.make(mode === "codex-inject" ? "codex" : "claude");
  const targetDriver = ProviderDriverKind.make(mode === "codex-inject" ? "codex" : "claudeAgent");
  const targetModelSelection = { instanceId: targetInstanceId, model: "target-model" };

  yield* store.apply({
    id: EventId.make(`event:seeded-history:${mode}:thread`),
    type: "thread.created",
    threadId,
    occurredAt: at,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:seeded-history"),
      title: "Seeded history",
      providerInstanceId: sourceInstanceId,
      modelSelection: sourceModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });

  const sourceRow = {
    id: ProviderThreadId.make(`provider-thread:seeded-history:${mode}:source`),
    driver: sourceDriver,
    providerInstanceId: sourceInstanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver: sourceDriver,
      nativeId: "source-session",
      strength: "strong" as const,
    },
    nativeConversationHeadRef: null,
    status: "idle" as const,
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    contextUsage: null,
    nativeMetadata: null,
    goal: null,
    createdAt: at,
    updatedAt: at,
  } satisfies OrchestrationV2ProviderThread;
  yield* store.apply({
    id: EventId.make(`event:seeded-history:${mode}:source`),
    type: "provider-thread.updated",
    threadId,
    occurredAt: at,
    payload: sourceRow,
  });
  const sourceProjection = yield* store.getThreadProjection(threadId);
  assert.equal(sourceProjection.thread.activeProviderThreadId, sourceRow.id);

  yield* store.apply({
    id: EventId.make(`event:seeded-history:${mode}:select-target`),
    type: "thread.provider-switched",
    threadId,
    occurredAt: at,
    payload: {
      ...sourceProjection.thread,
      providerInstanceId: targetInstanceId,
      modelSelection: targetModelSelection,
    },
  });
  const targetRow = {
    id: ProviderThreadId.make(`provider-thread:seeded-history:${mode}:target`),
    driver: targetDriver,
    providerInstanceId: targetInstanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef:
      mode === "codex-inject"
        ? null
        : { driver: targetDriver, nativeId: "staged-session", strength: "strong" as const },
    nativeConversationHeadRef: null,
    status: "not_loaded" as const,
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    contextUsage: null,
    nativeMetadata: {
      seededHistory: {
        source: "opencode" as const,
        sourceSessionId: "source-session",
        digest: "sha256:seeded-history",
        mode,
        ...(mode === "claude-transcript" ? { stagedPath: "/staged/transcript.jsonl" } : {}),
      },
    },
    goal: null,
    createdAt: at,
    updatedAt: at,
  } satisfies OrchestrationV2ProviderThread;
  yield* store.apply({
    id: EventId.make(`event:seeded-history:${mode}:target`),
    type: "provider-thread.updated",
    threadId,
    occurredAt: at,
    payload: targetRow,
  });

  return { store, at, threadId, sourceRow, sourceModelSelection, targetRow };
});

it.effect.each(["claude-transcript", "codex-inject"] as const)(
  "memory %s seeded history stays active on late provider updates, but allows a real switch",
  (mode) =>
    Effect.gen(function* () {
      const { store, at, threadId, sourceRow, sourceModelSelection, targetRow } =
        yield* seededHistoryProjectionFixture(mode);
      const adopted = yield* store.getThreadProjection(threadId);
      assert.equal(adopted.thread.providerInstanceId, targetRow.providerInstanceId);
      assert.equal(adopted.thread.activeProviderThreadId, targetRow.id);
      assert.deepEqual(
        adopted.providerThreads.find((row) => row.id === targetRow.id)?.nativeMetadata,
        targetRow.nativeMetadata,
      );

      const lateAt = DateTime.add(at, { seconds: 1 });
      const lateSourceRow = {
        ...sourceRow,
        status: "active" as const,
        lastRunOrdinal: 2,
        updatedAt: lateAt,
      };
      yield* store.apply({
        id: EventId.make(`event:seeded-history:${mode}:late-source`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: lateAt,
        payload: lateSourceRow,
      });
      const afterLateUpdate = yield* store.getThreadProjection(threadId);
      assert.equal(afterLateUpdate.thread.providerInstanceId, targetRow.providerInstanceId);
      assert.equal(afterLateUpdate.thread.activeProviderThreadId, targetRow.id);
      assert.deepEqual(
        afterLateUpdate.providerThreads.find((row) => row.id === sourceRow.id),
        lateSourceRow,
      );
      assert.deepEqual(
        afterLateUpdate.providerThreads.find((row) => row.id === targetRow.id),
        targetRow,
      );

      const switchedAt = DateTime.add(at, { seconds: 2 });
      yield* store.apply({
        id: EventId.make(`event:seeded-history:${mode}:switch-back`),
        type: "thread.provider-switched",
        threadId,
        occurredAt: switchedAt,
        payload: {
          ...afterLateUpdate.thread,
          providerInstanceId: sourceRow.providerInstanceId,
          modelSelection: sourceModelSelection,
          updatedAt: switchedAt,
        },
      });
      const afterSelection = yield* store.getThreadProjection(threadId);
      assert.equal(afterSelection.thread.providerInstanceId, sourceRow.providerInstanceId);
      assert.equal(afterSelection.thread.activeProviderThreadId, targetRow.id);

      const targetUpdatedAt = DateTime.add(at, { seconds: 3 });
      const updatedTargetRow = {
        ...targetRow,
        status: "idle" as const,
        updatedAt: targetUpdatedAt,
      };
      yield* store.apply({
        id: EventId.make(`event:seeded-history:${mode}:update-active-target`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: targetUpdatedAt,
        payload: updatedTargetRow,
      });
      const afterTargetUpdate = yield* store.getThreadProjection(threadId);
      assert.equal(afterTargetUpdate.thread.activeProviderThreadId, targetRow.id);
      assert.deepEqual(
        afterTargetUpdate.providerThreads.find((row) => row.id === targetRow.id),
        updatedTargetRow,
      );

      const activatedAt = DateTime.add(at, { seconds: 4 });
      const selectedSourceRow = {
        ...lateSourceRow,
        status: "idle" as const,
        lastRunOrdinal: 3,
        updatedAt: activatedAt,
      };
      yield* store.apply({
        id: EventId.make(`event:seeded-history:${mode}:activate-selected-source`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: activatedAt,
        payload: selectedSourceRow,
      });
      const afterSwitch = yield* store.getThreadProjection(threadId);
      assert.equal(afterSwitch.thread.providerInstanceId, sourceRow.providerInstanceId);
      assert.equal(afterSwitch.thread.activeProviderThreadId, sourceRow.id);
      assert.deepEqual(
        afterSwitch.providerThreads.find((row) => row.id === sourceRow.id),
        selectedSourceRow,
      );
      assert.deepEqual(
        afterSwitch.providerThreads.find((row) => row.id === targetRow.id),
        updatedTargetRow,
      );
    }).pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("memory accepts a replacement for the selected seeded provider", () =>
  Effect.gen(function* () {
    const { store, at, threadId, targetRow } =
      yield* seededHistoryProjectionFixture("codex-inject");
    const replacement = {
      ...targetRow,
      id: ProviderThreadId.make("provider-thread:seeded-history:replacement"),
      status: "idle" as const,
      nativeMetadata: null,
    };
    yield* store.apply({
      id: EventId.make("event:seeded-history:replacement"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: at,
      payload: replacement,
    });
    const projection = yield* store.getThreadProjection(threadId);
    assert.equal(projection.thread.providerInstanceId, targetRow.providerInstanceId);
    assert.equal(projection.thread.activeProviderThreadId, replacement.id);
    assert.deepEqual(
      projection.providerThreads.find((row) => row.id === replacement.id),
      replacement,
    );
    assert.deepEqual(
      projection.providerThreads.find((row) => row.id === targetRow.id),
      targetRow,
    );
  }).pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("memory keeps rollback active against a late target, and allows a later switch", () =>
  Effect.gen(function* () {
    const { store, at, threadId, sourceRow, sourceModelSelection, targetRow } =
      yield* seededHistoryProjectionFixture("claude-transcript");
    const adopted = yield* store.getThreadProjection(threadId);
    yield* store.apply({
      id: EventId.make("event:seeded-history:rollback"),
      type: "thread.provider-switched",
      threadId,
      occurredAt: at,
      payload: {
        ...adopted.thread,
        providerInstanceId: sourceRow.providerInstanceId,
        modelSelection: sourceModelSelection,
        activeProviderThreadId: sourceRow.id,
        harnessMigrationFence: true,
      },
    });
    yield* store.apply({
      id: EventId.make("event:seeded-history:rollback-source"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: at,
      payload: sourceRow,
    });
    const late = { ...targetRow, status: "idle" as const };
    yield* store.apply({
      id: EventId.make("event:seeded-history:rollback-late-target"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: at,
      payload: late,
    });
    const rolledBack = yield* store.getThreadProjection(threadId);
    assert.equal(rolledBack.thread.activeProviderThreadId, sourceRow.id);
    assert.deepEqual(
      rolledBack.providerThreads.find((row) => row.id === targetRow.id),
      late,
    );

    yield* store.apply({
      id: EventId.make("event:seeded-history:rollback-real-switch"),
      type: "thread.provider-switched",
      threadId,
      occurredAt: at,
      payload: {
        ...rolledBack.thread,
        providerInstanceId: targetRow.providerInstanceId,
        modelSelection: { instanceId: targetRow.providerInstanceId, model: "target-model" },
      },
    });
    yield* store.apply({
      id: EventId.make("event:seeded-history:rollback-switch-target"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: at,
      payload: late,
    });
    assert.equal(
      (yield* store.getThreadProjection(threadId)).thread.activeProviderThreadId,
      targetRow.id,
    );
  }).pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("memory keeps existing activation behavior when the active row is not seeded", () =>
  Effect.gen(function* () {
    const { store, at, threadId, sourceRow, targetRow } =
      yield* seededHistoryProjectionFixture("codex-inject");
    const unseededTargetRow = {
      ...targetRow,
      status: "idle" as const,
      nativeMetadata: { title: "Ordinary provider thread" },
    };
    yield* store.apply({
      id: EventId.make("event:seeded-history:remove-seed-metadata"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: at,
      payload: unseededTargetRow,
    });
    assert.equal(
      (yield* store.getThreadProjection(threadId)).thread.activeProviderThreadId,
      targetRow.id,
    );

    const updatedSourceRow = { ...sourceRow, status: "active" as const };
    yield* store.apply({
      id: EventId.make("event:seeded-history:unseeded-source-update"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: at,
      payload: updatedSourceRow,
    });
    const projection = yield* store.getThreadProjection(threadId);
    assert.equal(projection.thread.providerInstanceId, targetRow.providerInstanceId);
    assert.equal(projection.thread.activeProviderThreadId, sourceRow.id);
    assert.deepEqual(
      projection.providerThreads.find((row) => row.id === sourceRow.id),
      updatedSourceRow,
    );
    assert.deepEqual(
      projection.providerThreads.find((row) => row.id === targetRow.id),
      unseededTargetRow,
    );
  }).pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("memory activates a null-ref codex seed but not an ordinary queued placeholder", () =>
  Effect.gen(function* () {
    const { store, at, threadId, targetRow } =
      yield* seededHistoryProjectionFixture("codex-inject");
    assert.isNull(targetRow.nativeThreadRef);
    assert.equal(targetRow.status, "not_loaded");
    const seeded = yield* store.getThreadProjection(threadId);
    assert.equal(seeded.thread.activeProviderThreadId, targetRow.id);

    const placeholder = {
      ...targetRow,
      id: ProviderThreadId.make("provider-thread:seeded-history:queued-placeholder"),
      nativeMetadata: null,
    };
    yield* store.apply({
      id: EventId.make("event:seeded-history:queued-placeholder"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: at,
      payload: placeholder,
    });
    const projection = yield* store.getThreadProjection(threadId);
    assert.equal(projection.thread.activeProviderThreadId, targetRow.id);
    assert.deepEqual(
      projection.providerThreads.find((row) => row.id === placeholder.id),
      placeholder,
    );
    assert.deepEqual(
      projection.providerThreads.find((row) => row.id === targetRow.id),
      targetRow,
    );
  }).pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerTest],
] as const)("%s queue readiness skips held runs without bypassing active work", ([, layer]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("held-queue");
    const { runs } = yield* store.getThreadProjection(threadId);
    const run = runs[0]!;
    const now = yield* DateTime.now;
    const held = { ...run, status: "queued" as const, queueHeld: true };
    yield* store.apply({
      id: EventId.make("held-queue:held"),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: held,
    });
    assert.isFalse(yield* store.canStartQueuedRun(threadId));

    const wake = { ...run, id: RunId.make("held-queue:wake"), ordinal: 2 };
    for (const status of ["running", "queued", "completed"] as const) {
      yield* store.apply({
        id: EventId.make(`held-queue:wake:${status}`),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: { ...wake, status },
      });
      assert.equal(yield* store.canStartQueuedRun(threadId), status === "queued");
    }
    assert.deepEqual((yield* store.getThreadProjection(threadId)).runs[0], held);
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerTest],
] as const)("%s shells flag only an active turn blocked solely on T3 thread waits", ([, layer]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("thread-wait");
    const initial = yield* store.getThreadProjection(threadId);
    const at = initial.updatedAt;
    const previousCommand = initial.turnItems.find((item) => item.type === "command_execution")!;
    const itemBase = {
      ...previousCommand,
      providerThreadId: previousCommand.providerThreadId ?? null,
      providerTurnId: previousCommand.providerTurnId ?? null,
      nativeItemRef: previousCommand.nativeItemRef ?? null,
      parentItemId: previousCommand.parentItemId ?? null,
    };
    yield* store.apply({
      id: EventId.make("event:thread-wait:previous-completed"),
      type: "run.updated",
      threadId,
      occurredAt: at,
      payload: { ...initial.runs[0]!, status: "completed", completedAt: at },
    });
    const run = {
      ...initial.runs[0]!,
      id: RunId.make("run:thread-wait:active"),
      ordinal: 2,
      status: "running" as const,
      completedAt: null,
    };
    yield* store.apply({
      id: EventId.make("event:thread-wait:active"),
      type: "run.created",
      threadId,
      occurredAt: at,
      payload: run,
    });
    let sequence = 0;
    const updateItem = (payload: OrchestrationV2TurnItem) =>
      store.apply({
        id: EventId.make(`event:thread-wait:item:${sequence++}`),
        type: "turn-item.updated",
        threadId,
        runId: payload.runId ?? undefined,
        driver,
        occurredAt: at,
        payload,
      });
    const assertBlocked = Effect.fnUntraced(function* (expected: boolean) {
      const listed = (yield* store.getShellSnapshot()).threads.find((row) => row.id === threadId);
      for (const shell of [yield* store.getThreadShell(threadId), listed]) {
        assert.equal(shell?.activeRunId, run.id);
        assert.equal(shell?.status, "running");
        assert.equal(shell?.blockedOnThreadWait ?? false, expected);
      }
    });
    const wait = {
      ...itemBase,
      id: TurnItemId.make("item:thread-wait:active"),
      runId: run.id,
      type: "dynamic_tool" as const,
      toolName: "mcp__t3_code__t3_thread_wait",
      input: { threadId: "child-thread" },
      status: "running" as const,
    };

    yield* updateItem({
      ...wait,
      id: TurnItemId.make("item:thread-wait:stale"),
      runId: initial.runs[0]!.id,
    });
    yield* assertBlocked(false);
    const foreign = {
      ...wait,
      id: TurnItemId.make("item:thread-wait:foreign"),
      toolName: "weather.t3_thread_wait",
    };
    yield* updateItem(foreign);
    yield* assertBlocked(false);
    yield* updateItem({ ...foreign, status: "completed", completedAt: at });
    yield* updateItem({ ...wait, status: "pending", startedAt: null });
    yield* assertBlocked(false);
    yield* updateItem(wait);
    yield* assertBlocked(true);

    yield* updateItem({
      ...wait,
      id: TurnItemId.make("item:thread-wait:plan"),
      type: "todo_list",
      planId: PlanId.make("plan:thread-wait"),
      steps: [{ id: "review", text: "Review the child result", status: "running" }],
    });
    yield* assertBlocked(true);
    yield* updateItem({
      ...wait,
      id: TurnItemId.make("item:thread-wait:proposed-plan"),
      type: "proposed_plan",
      planId: PlanId.make("plan:thread-wait:proposed"),
      markdown: "Review the child result",
      streaming: true,
    });
    yield* updateItem({
      ...wait,
      id: TurnItemId.make("item:thread-wait:named-message"),
      nativeItemRef: { driver, nativeId: "named-message", strength: "weak" },
      type: "assistant_message",
      messageId: MessageId.make("message:thread-wait:named"),
      text: "Waiting for the child result",
      streaming: true,
    });
    yield* updateItem({
      ...wait,
      id: TurnItemId.make("item:thread-wait:named-thought"),
      nativeItemRef: { driver, nativeId: "named-thought", strength: "weak" },
      type: "reasoning",
      text: "I need the child result",
      streaming: true,
    });
    yield* assertBlocked(true);

    const command = {
      ...itemBase,
      id: TurnItemId.make("item:thread-wait:concurrent"),
      runId: run.id,
    };
    yield* updateItem(command);
    yield* assertBlocked(false);
    yield* updateItem({ ...wait, status: "waiting" });
    yield* assertBlocked(false);
    yield* updateItem({ ...command, status: "completed", completedAt: at });
    yield* assertBlocked(true);
    const fileChange = {
      ...command,
      id: TurnItemId.make("item:thread-wait:concurrent-edit"),
      type: "file_change" as const,
      fileName: "example.ts",
    };
    yield* updateItem(fileChange);
    yield* assertBlocked(false);
    yield* updateItem({ ...fileChange, status: "completed", completedAt: at });
    yield* assertBlocked(true);
    const compaction = {
      ...command,
      id: TurnItemId.make("item:thread-wait:compaction"),
      type: "compaction" as const,
      driver,
    };
    yield* updateItem(compaction);
    yield* assertBlocked(false);
    yield* updateItem({ ...compaction, status: "completed", completedAt: at });
    yield* assertBlocked(true);
    yield* updateItem({ ...wait, status: "completed", completedAt: at });
    yield* assertBlocked(false);

    const delegation = {
      ...wait,
      id: TurnItemId.make("item:thread-wait:delegation"),
      toolName: "t3-code-thread_opencode2-adapter_delegate_task",
      input: { task: "Review", mode: "async" },
    };
    yield* updateItem(delegation);
    yield* assertBlocked(false);
    yield* updateItem({ ...delegation, status: "completed", completedAt: at });
    const blockingDelegation = {
      ...delegation,
      id: TurnItemId.make("item:thread-wait:blocking-delegation"),
      input: { task: "Review", mode: "wait" },
    };
    yield* updateItem({
      ...command,
      id: TurnItemId.make("item:thread-wait:child"),
      type: "subagent",
      subagentId: NodeId.make("node:thread-wait:child"),
      origin: "app_owned",
      driver,
      providerInstanceId,
      childThreadId: ThreadId.make("child-thread"),
      prompt: "Review",
      result: null,
    });
    yield* updateItem(blockingDelegation);
    yield* assertBlocked(true);
    yield* updateItem({ ...blockingDelegation, status: "completed", completedAt: at });
    yield* assertBlocked(false);
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerTest],
] as const)(
  "%s shells use the latest subagent owner for duplicate provider-thread ids",
  ([, layer]) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("duplicate-provider-thread-owner");
      const initial = yield* store.getThreadProjection(threadId);
      const at = initial.updatedAt;
      const otherThreadId = yield* addRolledBackRecoveryCandidate(
        "duplicate-provider-thread-owner:other",
      );
      const other = yield* store.getThreadProjection(otherThreadId);
      const otherRun = other.runs[0]!;
      const otherInstanceId = ProviderInstanceId.make("codex-other");
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:other-completed"),
        type: "run.updated",
        threadId: otherThreadId,
        occurredAt: at,
        payload: { ...otherRun, status: "completed", completedAt: at },
      });
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:other-switched"),
        type: "thread.provider-switched",
        threadId: otherThreadId,
        occurredAt: at,
        payload: {
          ...other.thread,
          providerInstanceId: otherInstanceId,
          modelSelection: { ...modelSelection, instanceId: otherInstanceId },
        },
      });
      const providerThreadId = ProviderThreadId.make("provider-thread:duplicate-owner");
      const nativeTaskId = "native-task:duplicate-provider-thread-owner";
      // The latest upsert moves the row off the later-created thread.
      for (const [appThreadId, owner] of [
        [otherThreadId, otherInstanceId],
        [threadId, providerInstanceId],
      ] as const) {
        yield* store.apply({
          id: EventId.make(`event:duplicate-provider-thread-owner:${owner}`),
          type: "provider-thread.updated",
          threadId: appThreadId,
          occurredAt: at,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: owner,
            providerSessionId: null,
            appThreadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: at,
            updatedAt: at,
            pendingBackgroundTasks:
              owner === otherInstanceId
                ? [{ taskId: nativeTaskId, kind: "subagent", description: "Review" }]
                : [],
          },
        });
      }
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:completed"),
        type: "run.updated",
        threadId,
        occurredAt: at,
        payload: { ...initial.runs[0]!, status: "completed", completedAt: at },
      });
      const item = {
        ...initial.turnItems[0]!,
        id: TurnItemId.make("item:duplicate-provider-thread-owner"),
        providerThreadId,
        nativeItemRef: { driver, nativeId: nativeTaskId, strength: "strong" as const },
        type: "subagent" as const,
        status: "running" as const,
        subagentId: NodeId.make("node:duplicate-provider-thread-owner"),
        origin: "provider_native" as const,
        driver,
        providerInstanceId,
        childThreadId: null,
        title: "Review",
        prompt: "Review",
        result: null,
      };
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:item"),
        type: "turn-item.updated",
        threadId,
        occurredAt: at,
        payload: item,
      });
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:other-item"),
        type: "turn-item.updated",
        threadId: otherThreadId,
        occurredAt: at,
        payload: {
          ...item,
          id: TurnItemId.make("item:duplicate-provider-thread-owner:other"),
          threadId: otherThreadId,
          runId: otherRun.id,
          nodeId: otherRun.rootNodeId,
          subagentId: NodeId.make("node:duplicate-provider-thread-owner:other"),
        },
      });
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:switched"),
        type: "thread.provider-switched",
        threadId,
        occurredAt: at,
        payload: {
          ...initial.thread,
          providerInstanceId: otherInstanceId,
          modelSelection: { ...modelSelection, instanceId: otherInstanceId },
        },
      });
      // The other thread's item reads its owner from a provider thread stored on another thread.
      assert.deepEqual((yield* store.getThreadProjection(otherThreadId)).providerThreads, []);
      const assertOwners = Effect.fnUntraced(function* (
        targetThreadId: ThreadId,
        expected: ReadonlyArray<unknown>,
      ) {
        const listed = (yield* store.getShellSnapshot()).threads.find(
          (thread) => thread.id === targetThreadId,
        );
        for (const shell of [yield* store.getThreadShell(targetThreadId), listed]) {
          assert.equal(shell?.providerInstanceId, otherInstanceId);
          assert.equal(shell?.activeRunId, null);
          assert.deepEqual(
            shell?.pendingBackgroundTasks?.filter((task) => task.kind === "subagent"),
            expected,
          );
        }
      });
      const owned = [
        { taskId: nativeTaskId, description: item.title, kind: "subagent", providerInstanceId },
      ];
      yield* assertOwners(threadId, owned);
      yield* assertOwners(otherThreadId, owned);
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:stopped"),
        type: "turn-item.updated",
        threadId,
        occurredAt: at,
        payload: { ...item, status: "cancelled", completedAt: at },
      });
      yield* assertOwners(threadId, []);
      const ownerSnapshot = (yield* store.getThreadProjection(threadId)).providerThreads[0]!;
      // Rollback writes its provider snapshot before the rolled-back run events.
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:rollback-provider-thread"),
        type: "provider-thread.updated",
        threadId: otherThreadId,
        occurredAt: at,
        payload: ownerSnapshot,
      });
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:other-rolled-back"),
        type: "run.updated",
        threadId: otherThreadId,
        occurredAt: at,
        payload: { ...otherRun, status: "rolled_back", completedAt: at },
      });
      const rolledBack = yield* store.getThreadProjection(otherThreadId);
      assert.deepEqual(rolledBack.providerThreads, []);
      assert.equal(
        (yield* store.getThreadProjection(threadId)).thread.activeProviderThreadId,
        providerThreadId,
      );
      assert.deepEqual(
        ProjectionStore.threadShellFromProjection(rolledBack).pendingBackgroundTasks,
        [],
      );
    }).pipe(Effect.provide(layer)),
);

const addOrphanedRecoveryCandidate = Effect.fn("addOrphanedRecoveryCandidate")(function* (
  suffix: string,
) {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:${suffix}:orphaned`);
  const runId = RunId.make(`run:${suffix}:missing`);
  const rootNodeId = NodeId.make(`node:${suffix}:orphaned`);

  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:thread-created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make(`project:${suffix}`),
      title: "Orphaned recovery candidate",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:item-running`),
    type: "turn-item.updated",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(`item:${suffix}:orphaned`),
      threadId,
      runId,
      nodeId: rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: "orphaned command",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "command_execution",
      input: "sleep 60",
    },
  });

  return threadId;
});

it("includes imported runless history when selecting fork context through a run", () => {
  const firstRunId = RunId.make("run:projection-imported-fork:1");
  const secondRunId = RunId.make("run:projection-imported-fork:2");
  const runOrdinalById = new Map([
    [firstRunId, 1],
    [secondRunId, 2],
  ]);

  assert.isTrue(
    ProjectionStore.isTurnItemAtOrBeforeRun({
      historyOrigin: "v1_import",
      itemRunId: null,
      runOrdinalById,
      sourceRunOrdinal: 1,
    }),
  );
  assert.isFalse(
    ProjectionStore.isTurnItemAtOrBeforeRun({
      historyOrigin: undefined,
      itemRunId: null,
      runOrdinalById,
      sourceRunOrdinal: 1,
    }),
  );
  assert.isTrue(
    ProjectionStore.isTurnItemAtOrBeforeRun({
      historyOrigin: "v1_import",
      itemRunId: firstRunId,
      runOrdinalById,
      sourceRunOrdinal: 1,
    }),
  );
  assert.isFalse(
    ProjectionStore.isTurnItemAtOrBeforeRun({
      historyOrigin: "v1_import",
      itemRunId: secondRunId,
      runOrdinalById,
      sourceRunOrdinal: 1,
    }),
  );
});

const restartCancelledWorkSurvivesStaleRunUpdate = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = yield* addRolledBackRecoveryCandidate("restart-cancelled-work-stale-update");
  const run = (yield* store.getThreadProjection(threadId)).runs[0]!;
  const now = yield* DateTime.now;
  const work = [{ kind: "subagent" as const, label: "Background subagent test" }];
  yield* store.apply({
    id: EventId.make("event:restart-cancelled-work-stale-update:recorded"),
    type: "run.background-work-cancelled",
    threadId,
    runId: run.id,
    providerInstanceId,
    occurredAt: now,
    payload: { runId: run.id, restartCancelledBackgroundWork: work },
  });
  yield* store.apply({
    id: EventId.make("event:restart-cancelled-work-stale-update:completed"),
    type: "run.updated",
    threadId,
    runId: run.id,
    providerInstanceId,
    occurredAt: now,
    payload: { ...run, status: "completed", completedAt: now },
  });
  const updated = (yield* store.getThreadProjection(threadId)).runs[0];
  assert.equal(updated?.status, "completed");
  assert.deepEqual(updated?.restartCancelledBackgroundWork, work);
});

const threadWorktreePathsIncludeArchivedOnRequest = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const create = (id: string, input: { worktreePath: string | null; archived?: boolean }) => {
    const threadId = ThreadId.make(id);
    const thread = {
      createdBy: "user" as const,
      creationSource: "web" as const,
      id: threadId,
      projectId: ProjectId.make("project:worktree-paths"),
      title: id,
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: input.worktreePath === null ? null : id,
      worktreePath: input.worktreePath,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: input.archived === true ? now : null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    return store
      .apply({
        id: EventId.make(`event:${id}:created`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      })
      .pipe(Effect.as(thread));
  };
  yield* create("thread:active", { worktreePath: "/worktrees/active" });
  yield* create("thread:archived", { worktreePath: "/worktrees/archived", archived: true });
  yield* create("thread:local", { worktreePath: null });
  const deleted = yield* create("thread:deleted", { worktreePath: "/worktrees/deleted" });
  yield* store.apply({
    id: EventId.make("event:thread:deleted:deleted"),
    type: "thread.deleted",
    threadId: deleted.id,
    occurredAt: now,
    payload: { ...deleted, deletedAt: now },
  });

  assert.deepEqual(yield* store.getThreadWorktreePaths(), [
    { threadId: ThreadId.make("thread:active"), worktreePath: "/worktrees/active" },
  ]);
  assert.deepEqual(yield* store.getThreadWorktreePaths({ includeArchived: true }), [
    { threadId: ThreadId.make("thread:active"), worktreePath: "/worktrees/active" },
    { threadId: ThreadId.make("thread:archived"), worktreePath: "/worktrees/archived" },
  ]);
});

const commandReadsSkipSettledLeafNodes = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = yield* addRolledBackRecoveryCandidate("settled-leaf-nodes");
  const settledRun = (yield* store.getThreadProjection(threadId)).runs[0]!;
  const activeRun = {
    ...settledRun,
    id: RunId.make("run:settled-leaf-nodes:active"),
    ordinal: 2,
    userMessageId: MessageId.make("message:settled-leaf-nodes:active"),
    rootNodeId: NodeId.make("node:settled-leaf-nodes:active-root"),
    status: "running" as const,
    completedAt: null,
  };
  yield* store.apply({
    id: EventId.make("event:settled-leaf-nodes:active-run"),
    type: "run.created",
    threadId,
    runId: activeRun.id,
    nodeId: activeRun.rootNodeId,
    driver,
    providerInstanceId,
    occurredAt: now,
    payload: activeRun,
  });
  const nodes = [
    ["settled-root", settledRun, "root_turn", "completed"],
    ["settled-tool", settledRun, "tool_call", "completed"],
    ["settled-message", settledRun, "assistant_message", "failed"],
    ["settled-reasoning", settledRun, "reasoning", "cancelled"],
    ["settled-subagent", settledRun, "subagent", "completed"],
    ["settled-run-live-tool", settledRun, "tool_call", "running"],
    ["active-run-done-tool", activeRun, "tool_call", "completed"],
  ] as const;
  for (const [name, run, kind, status] of nodes) {
    const id = NodeId.make(`node:settled-leaf-nodes:${name}`);
    yield* store.apply({
      id: EventId.make(`event:settled-leaf-nodes:${name}`),
      type: "node.updated",
      threadId,
      runId: run.id,
      nodeId: id,
      driver,
      occurredAt: now,
      payload: {
        id,
        threadId,
        runId: run.id,
        rootNodeId: kind === "root_turn" ? id : run.rootNodeId!,
        parentNodeId: kind === "root_turn" ? null : run.rootNodeId,
        kind,
        status,
        countsForRun: kind === "root_turn",
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: status === "running" ? null : now,
      },
    });
  }
  const nodeNames = (records: { readonly nodes: ReadonlyArray<{ readonly id: string }> }) =>
    records.nodes
      .map((node) => node.id.replace("node:settled-leaf-nodes:", ""))
      .filter((name) => nodes.some(([candidate]) => candidate === name))
      .toSorted();

  assert.deepEqual(
    nodeNames(yield* store.getThreadRecords(threadId, ["nodes"], { omitSettledLeafNodes: true })),
    ["active-run-done-tool", "settled-root", "settled-run-live-tool", "settled-subagent"],
  );
  assert.deepEqual(
    nodeNames(yield* store.getThreadRecords(threadId, ["nodes"])),
    nodes.map(([name]) => name).toSorted(),
  );
});

it.effect("memory command reads skip finished leaf nodes of finished runs", () =>
  commandReadsSkipSettledLeafNodes.pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect(
  "memory worktree path lookup defaults to active threads and can include archived threads",
  () =>
    threadWorktreePathsIncludeArchivedOnRequest.pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("memory projection keeps restart-cancelled work through a stale run.updated", () =>
  restartCancelledWorkSurvivesStaleRunUpdate.pipe(Effect.provide(ProjectionStore.layerMemory)),
);

const backgroundThreadUpdatesKeepTimestamp = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const createdAt = DateTime.makeUnsafe("2026-10-06T14:00:00.000Z");
  const threadId = ThreadId.make("thread:background-updates");
  const thread = {
    createdBy: "user" as const,
    creationSource: "web" as const,
    id: threadId,
    projectId: ProjectId.make("project:background-updates"),
    title: "Background updates",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  yield* store.apply({
    id: EventId.make("event:background-updates:created"),
    type: "thread.created",
    threadId,
    occurredAt: createdAt,
    payload: thread,
  });
  const readActivity = Effect.gen(function* () {
    const projection = yield* store.getThreadProjection(threadId);
    const thread = yield* store.getThread(threadId);
    const shell = yield* store.getThreadShell(threadId);
    const listed = (yield* store.getShellSnapshot()).threads.find((entry) => entry.id === threadId);
    assert.deepEqual(projection.thread.updatedAt, createdAt);
    assert.deepEqual(thread.updatedAt, createdAt);
    assert.deepEqual(shell?.updatedAt, createdAt);
    assert.deepEqual(listed?.updatedAt, createdAt);
    return projection;
  });
  const link = {
    host: "github.com",
    repository: "owner/repository",
    number: 42,
    url: "https://github.com/owner/repository/pull/42",
    source: "manual" as const,
    linkedAt: DateTime.formatIso(createdAt),
    snapshot: null,
    stack: null,
  };
  yield* store.apply({
    id: EventId.make("event:background-updates:pull-request-synced"),
    type: "thread.pull-request-synced",
    threadId,
    occurredAt: DateTime.add(createdAt, { minutes: 45 }),
    payload: { ...thread, pullRequests: [link] },
  });
  const synced = yield* readActivity;
  assert.deepEqual(synced.updatedAt, createdAt);
  assert.equal(synced.thread.pullRequests?.[0]?.number, 42);

  const snapshot = {
    state: "open" as const,
    title: "Ship it",
    headBranch: "feature",
    baseBranch: "main",
    isDraft: false,
    updatedAt: DateTime.formatIso(DateTime.add(createdAt, { minutes: 46 })),
    syncedAt: DateTime.formatIso(DateTime.add(createdAt, { minutes: 47 })),
    closedAt: null,
    mergedAt: null,
  };
  yield* store.apply({
    id: EventId.make("event:background-updates:pull-request-link-updated"),
    type: "thread.pull-request-link-updated",
    threadId,
    occurredAt: DateTime.add(createdAt, { minutes: 48 }),
    payload: { ...link, snapshot },
  });
  const refreshed = yield* readActivity;
  assert.deepEqual(refreshed.updatedAt, createdAt);
  assert.deepEqual(refreshed.thread.pullRequests?.[0]?.snapshot, snapshot);

  yield* store.apply({
    id: EventId.make("event:background-updates:active-reordered"),
    type: "thread.active-reordered",
    threadId,
    occurredAt: DateTime.add(createdAt, { minutes: 50 }),
    payload: { ...refreshed.thread, activeOrderKey: "a" },
  });
  const reordered = yield* readActivity;
  assert.deepEqual(reordered.updatedAt, createdAt);
  assert.equal(reordered.thread.activeOrderKey, "a");

  // An already-unpinned thread keeps its activity time even when replay's envelope advances.
  yield* store.apply({
    id: EventId.make("event:background-updates:already-unpinned"),
    type: "thread.unpinned",
    threadId,
    occurredAt: DateTime.add(createdAt, { minutes: 55 }),
    payload: { ...reordered.thread, pinnedAt: null, pinOrderKey: null },
  });
  yield* readActivity;
});

it.effect("memory projection keeps background thread updates out of updatedAt", () =>
  backgroundThreadUpdatesKeepTimestamp.pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("SQL projection keeps background thread updates out of updatedAt", () =>
  backgroundThreadUpdatesKeepTimestamp.pipe(Effect.provide(layerTest)),
);

it.effect("memory recovery selection ignores unfinished items from rolled-back runs", () =>
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("memory-recovery-candidates");

    assert.notInclude(yield* projectionStore.getRecoveryThreadIds("runtime"), threadId);
  }).pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("memory recovery selection includes unfinished items from missing runs", () =>
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addOrphanedRecoveryCandidate("memory-recovery-candidates");

    assert.include(yield* projectionStore.getRecoveryThreadIds("runtime"), threadId);
  }).pipe(Effect.provide(ProjectionStore.layerMemory)),
);

const runlessNativeSubagentNeedsRecovery = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = yield* addRolledBackRecoveryCandidate("runless-native-recovery");
  const now = yield* DateTime.now;
  const id = NodeId.make("node:runless-native-recovery");
  assert.notInclude(yield* store.getRecoveryThreadIds("runtime"), threadId);
  for (const status of ["pending", "running", "waiting", "completed"] as const) {
    yield* store.apply({
      id: EventId.make(`event:runless-native-recovery:${status}`),
      type: "subagent.updated",
      threadId,
      nodeId: id,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id,
        threadId,
        runId: null,
        parentNodeId: NodeId.make("node:runless-native-parent"),
        origin: "provider_native",
        createdBy: "agent",
        driver,
        providerInstanceId,
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: { driver, nativeId: "runless-native", strength: "strong" },
        prompt: "Do the work",
        title: "Workflow member",
        model: null,
        status,
        result: null,
        startedAt: now,
        completedAt: status === "completed" ? now : null,
        updatedAt: now,
      },
    });
    assert.equal(
      (yield* store.getRecoveryThreadIds("runtime")).includes(threadId),
      status !== "completed",
    );
  }
});

it.effect("memory recovery selects unfinished runless native subagents", () =>
  runlessNativeSubagentNeedsRecovery.pipe(Effect.provide(ProjectionStore.layerMemory)),
);

for (const [name, layer] of [
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerTest],
] as const) {
  it.effect(`${name} excludes shared bindings but retains dedicated sessions for recovery`, () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("shared-session-selection");
      const now = yield* DateTime.now;
      for (const [id, shared] of [
        ["session:suffix:shared", false],
        ["session:capability", true],
        ["session:dedicated", false],
      ] as const) {
        const session = {
          id: ProviderSessionId.make(id),
          driver,
          providerInstanceId,
          status: "ready" as const,
          cwd: "/workspace",
          model: modelSelection.model,
          capabilities: {
            ...CodexProviderCapabilitiesV2,
            sessions: {
              ...CodexProviderCapabilitiesV2.sessions,
              supportsMultipleProviderThreadsPerSession: shared,
            },
          },
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        yield* store.apply({
          id: EventId.make(`event:${id}:attach`),
          type: "provider-session.attached",
          threadId,
          occurredAt: now,
          payload: session,
        });
        assert.equal(
          (yield* store.getRecoveryThreadIds("runtime")).includes(threadId),
          id === "session:dedicated",
        );
      }
      assert.deepEqual(
        (yield* store.getLiveSharedProviderSessions()).map(({ session }) => session.id).sort(),
        ["session:capability", "session:suffix:shared"],
      );
      for (const { session } of yield* store.getLiveSharedProviderSessions()) {
        yield* store.apply({
          id: EventId.make(`event:${session.id}:detach`),
          type: "provider-session.detached",
          threadId,
          occurredAt: now,
          payload: { providerSessionId: session.id, detachedAt: now },
        });
      }
      const detached = yield* store.getLiveSharedProviderSessions();
      assert.lengthOf(detached, 2);
      for (const { session } of detached) {
        yield* store.apply({
          id: EventId.make(`event:${session.id}:stop`),
          type: "provider-session.updated",
          threadId,
          occurredAt: now,
          payload: { ...session, status: "stopped" },
        });
      }
      assert.isEmpty(yield* store.getLiveSharedProviderSessions());
    }).pipe(Effect.provide(layer)),
  );
}

const assertProjectScopedShells = Effect.fn("assertProjectScopedShells")(function* (
  suffix: string,
) {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const projectId = ProjectId.make(`project:${suffix}:a`);
  const otherProjectId = ProjectId.make(`project:${suffix}:b`);
  const activeThreadId = ThreadId.make(`thread:${suffix}:a-active`);
  const archivedThreadId = ThreadId.make(`thread:${suffix}:a-archived`);
  const forkThreadId = ThreadId.make(`thread:${suffix}:a-fork`);
  const sourceThreadId = ThreadId.make(`thread:${suffix}:b-source`);
  const otherThreadId = ThreadId.make(`thread:${suffix}:b-other`);
  const sourceRunId = RunId.make(`run:${suffix}:b-source`);
  const sourceNodeId = NodeId.make(`node:${suffix}:b-source`);
  const createThread = (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly archived?: boolean;
    readonly forkedFromRunOf?: ThreadId;
  }) =>
    projectionStore.apply({
      id: EventId.make(`event:${input.threadId}:created`),
      type: "thread.created",
      threadId: input.threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: input.threadId,
        projectId: input.projectId,
        title: input.threadId,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage:
          input.forkedFromRunOf === undefined
            ? { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId }
            : {
                parentThreadId: input.forkedFromRunOf,
                relationshipToParent: "fork",
                rootThreadId: input.forkedFromRunOf,
              },
        forkedFrom:
          input.forkedFromRunOf === undefined
            ? null
            : { type: "run", threadId: input.forkedFromRunOf, runId: sourceRunId },
        createdAt: now,
        updatedAt: now,
        archivedAt: input.archived === true ? now : null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });

  yield* createThread({ threadId: sourceThreadId, projectId: otherProjectId, archived: true });
  yield* createThread({ threadId: otherThreadId, projectId: otherProjectId });
  yield* createThread({ threadId: activeThreadId, projectId });
  yield* createThread({ threadId: archivedThreadId, projectId, archived: true });
  yield* createThread({ threadId: forkThreadId, projectId, forkedFromRunOf: sourceThreadId });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:source-run`),
    type: "run.created",
    threadId: sourceThreadId,
    runId: sourceRunId,
    nodeId: sourceNodeId,
    driver,
    occurredAt: now,
    payload: {
      id: sourceRunId,
      threadId: sourceThreadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${suffix}:source-user`),
      rootNodeId: sourceNodeId,
      activeAttemptId: null,
      status: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:source-item`),
    type: "turn-item.updated",
    threadId: sourceThreadId,
    runId: sourceRunId,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(`turn-item:${suffix}:source`),
      threadId: sourceThreadId,
      runId: sourceRunId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "assistant_message",
      messageId: MessageId.make(`message:${suffix}:source-assistant`),
      text: "Source answer",
      streaming: false,
    },
  });

  const unscoped = yield* projectionStore.getShellSnapshot();
  const inProject = (thread: { readonly projectId: ProjectId }) => thread.projectId === projectId;
  const active = yield* projectionStore.getShellSnapshot({ projectId, location: "active" });
  assert.deepEqual(active.threads, unscoped.threads.filter(inProject));
  assert.deepEqual(active.archivedThreads, []);
  assert.sameMembers(
    active.threads.map((thread) => thread.id),
    [activeThreadId, forkThreadId],
  );
  const fork = active.threads.find((thread) => thread.id === forkThreadId);
  assert.isAbove(fork?.visibleItemCount ?? 0, 0);

  const all = yield* projectionStore.getShellSnapshot({ projectId });
  assert.deepEqual(all.threads, active.threads);
  assert.deepEqual(all.archivedThreads, unscoped.archivedThreads.filter(inProject));
  assert.sameMembers(
    all.archivedThreads.map((thread) => thread.id),
    [archivedThreadId],
  );
  return { projectId, activeThreadId, forkThreadId, otherThreadId };
});

it.effect("assistant phase persists through the projection, and old rows decode as unknown", () =>
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const suffix = "assistant-phase";
    const threadId = ThreadId.make(`thread:${suffix}`);
    const runId = RunId.make(`run:${suffix}`);
    const nodeId = NodeId.make(`node:${suffix}`);
    const messageId = MessageId.make(`message:${suffix}:answer`);
    yield* projectionStore.apply({
      id: EventId.make(`event:${suffix}:thread-created`),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make(`project:${suffix}`),
        title: "Assistant phase",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    yield* projectionStore.apply({
      id: EventId.make(`event:${suffix}:run`),
      type: "run.created",
      threadId,
      runId,
      nodeId,
      driver,
      occurredAt: now,
      payload: {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make(`message:${suffix}:user`),
        rootNodeId: nodeId,
        activeAttemptId: null,
        status: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    yield* projectionStore.apply({
      id: EventId.make(`event:${suffix}:answer`),
      type: "turn-item.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(`turn-item:${suffix}:answer`),
        threadId,
        runId,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "assistant_message",
        messageId,
        text: "Done.",
        phase: "answer",
        streaming: false,
      },
    });
    const [written] = (yield* projectionStore.getThreadRecords(threadId, ["turnItems"])).turnItems;
    assert.strictEqual(written?.type, "assistant_message");
    assert.strictEqual(written?.type === "assistant_message" && written.phase, "answer");
    // A row written before `phase` existed has no such key; it must decode as unknown, never answer.
    const legacy = yield* Schema.decodeUnknownEffect(OrchestrationV2TurnItem)({
      id: "turn-item:assistant-phase:legacy",
      threadId,
      runId,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 2,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "assistant_message",
      messageId: "message:assistant-phase:legacy",
      text: "Old row.",
      streaming: false,
    });
    assert.strictEqual(legacy.type === "assistant_message" && legacy.phase, "unknown");
  }).pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("memory shell snapshots scope to one project", () =>
  assertProjectScopedShells("memory-project-shell").pipe(
    Effect.asVoid,
    Effect.provide(ProjectionStore.layerMemory),
  ),
);

it.effect("one shared session update carrier survives SQL rebuild and memory replay", () => {
  const database = SqlitePersistence.layerMemory;
  const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
    Layer.provideMerge(database),
  );
  const isolated = Layer.mergeAll(EventSink.layer, ProjectionMaintenance.layer).pipe(
    Layer.provideMerge(stores),
  );
  return Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const events = yield* EventStore.EventStoreV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const sql = yield* SqlClient.SqlClient;
    const createdAt = DateTime.makeUnsafe("2026-10-30T12:00:00.000Z");
    const updatedAt = DateTime.add(createdAt, { minutes: 1 });
    const boundThreadIds = Array.from({ length: 16 }, (_, index) =>
      ThreadId.make(`thread:session-carrier:${String(index).padStart(2, "0")}`),
    );
    const unboundThreadId = ThreadId.make("thread:session-carrier:unbound");
    const threadIds = [...boundThreadIds, unboundThreadId];
    const session: OrchestrationV2ProviderSession = {
      id: ProviderSessionId.make("session:single-carrier"),
      driver: ProviderDriverKind.make("opencode"),
      providerInstanceId: ProviderInstanceId.make("opencode"),
      status: "ready",
      cwd: "/workspace/carrier-replay",
      model: "gpt-6-astra",
      capabilities: {
        ...CodexProviderCapabilitiesV2,
        sessions: {
          ...CodexProviderCapabilitiesV2.sessions,
          supportsMultipleProviderThreadsPerSession: true,
        },
      },
      createdAt,
      updatedAt: createdAt,
      lastError: null,
    };
    for (const threadId of threadIds) {
      yield* sink.write({
        events: [
          {
            id: EventId.make(`event:${threadId}:created`),
            type: "thread.created",
            threadId,
            occurredAt: createdAt,
            payload: {
              id: threadId,
              projectId: ProjectId.make("project:session-carrier"),
              title: threadId,
              providerInstanceId: session.providerInstanceId,
              modelSelection: { instanceId: session.providerInstanceId, model: session.model! },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: null,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdBy: "user",
              creationSource: "web",
              createdAt,
              updatedAt: createdAt,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          },
        ],
      });
      if (threadId !== unboundThreadId) {
        yield* sink.write({
          events: [
            {
              id: EventId.make(`event:${threadId}:attached`),
              type: "provider-session.attached",
              threadId,
              driver: session.driver,
              providerInstanceId: session.providerInstanceId,
              occurredAt: createdAt,
              payload: session,
            },
          ],
        });
      }
    }
    const readBindings = sql<{
      readonly provider_session_id: string;
      readonly thread_id: string;
    }>`SELECT provider_session_id, thread_id
      FROM orchestration_v2_projection_provider_session_bindings
      ORDER BY thread_id, provider_session_id`;
    const bindings = yield* readBindings;
    assert.deepEqual(
      bindings,
      boundThreadIds.map((threadId) => ({
        provider_session_id: session.id,
        thread_id: threadId,
      })),
    );
    const heads = yield* Effect.forEach(threadIds, (threadId) =>
      events.latestSequence({ threadId }),
    );
    const previousHead = yield* events.latestSequence();
    const running = { ...session, status: "running" as const, updatedAt };
    const committed = yield* sink.write({
      events: [
        {
          id: EventId.make("event:session-carrier:running"),
          type: "provider-session.updated",
          threadId: boundThreadIds[0]!,
          driver: session.driver,
          providerInstanceId: session.providerInstanceId,
          occurredAt: updatedAt,
          payload: running,
        },
      ],
    });
    assert.lengthOf(committed, 1);
    const carrier = committed[0]!;
    assert.isAbove(carrier.sequence, previousHead);
    assert.equal(carrier.event.threadId, boundThreadIds[0]);
    assert.deepEqual(
      yield* events.read({ afterSequence: previousHead }).pipe(Stream.runCollect),
      committed,
    );
    for (const [index, threadId] of threadIds.entries()) {
      assert.equal(
        yield* events.latestSequence({ threadId }),
        index === 0 ? carrier.sequence : heads[index],
      );
    }

    const readBoundSessions = (projectionStore: ProjectionStore.ProjectionStoreV2Shape) =>
      Effect.forEach(threadIds, (threadId) =>
        projectionStore
          .getThreadRecords(threadId, ["providerSessions"])
          .pipe(Effect.map((records) => ({ threadId, sessions: records.providerSessions }))),
      );
    const expected = threadIds.map((threadId) => ({
      threadId,
      sessions: threadId === unboundThreadId ? [] : [running],
    }));
    const sqlSessions = yield* readBoundSessions(store);
    assert.deepEqual(sqlSessions, expected);
    assert.deepEqual(yield* readBindings, bindings);
    const decodeSession = Schema.decodeUnknownEffect(
      Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
    );
    const canonicalRows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_provider_sessions
      ORDER BY provider_session_id`;
    assert.deepEqual(
      yield* Effect.forEach(canonicalRows, (row) => decodeSession(row.payload_json)),
      [running],
    );

    const wholeLog = yield* events.read().pipe(Stream.runCollect);
    assert.lengthOf(wholeLog, boundThreadIds.length * 2 + 2);
    assert.deepEqual(
      wholeLog.filter((stored) => stored.event.type === "provider-session.updated"),
      committed,
    );
    const memorySessions = yield* Effect.gen(function* () {
      const memory = yield* ProjectionStore.ProjectionStoreV2;
      for (const stored of wholeLog) yield* memory.apply(stored.event);
      return yield* readBoundSessions(memory);
    }).pipe(Effect.provide(ProjectionStore.layerMemory));
    assert.deepEqual(memorySessions, sqlSessions);
    assert.deepEqual(
      memorySessions.flatMap(({ threadId, sessions }) =>
        sessions.map((value) => ({
          provider_session_id: value.id,
          thread_id: threadId,
        })),
      ),
      bindings,
    );

    // Remove one binding so a no-op maintenance call cannot pass as a rebuild.
    yield* sql`DELETE FROM orchestration_v2_projection_provider_session_bindings
      WHERE thread_id = ${boundThreadIds.at(-1)!}`;
    assert.lengthOf(yield* readBindings, boundThreadIds.length - 1);
    const rebuilt = yield* maintenance.rebuild;
    assert.deepEqual(rebuilt, {
      valid: true,
      schemaVersion: ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
      expectedSequence: carrier.sequence,
      projectionSequence: carrier.sequence,
      unreadableThreadIds: [],
      missingThreadIds: [],
      unexpectedThreadIds: [],
    });
    assert.deepEqual(yield* readBoundSessions(store), memorySessions);
    assert.deepEqual(yield* readBindings, bindings);
    assert.deepEqual(
      yield* sql`SELECT payload_json FROM orchestration_v2_projection_provider_sessions
        ORDER BY provider_session_id`,
      canonicalRows,
    );
    assert.deepEqual(yield* events.read().pipe(Stream.runCollect), wholeLog);
  }).pipe(Effect.provide(isolated));
});

it.layer(layerTest)("ProjectionStoreV2", (it) => {
  it.effect("returns a typed read error for malformed stored plan JSON", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = yield* addRolledBackRecoveryCandidate("corrupt-plan");
      const planId = PlanId.make("plan:corrupt");
      yield* sql`INSERT INTO orchestration_v2_projection_plans
        (plan_id, thread_id, node_id, kind, status, payload_json)
        VALUES (${planId}, ${threadId}, 'node:corrupt-plan', 'proposed_plan', 'active', '{broken')`;

      const failure = yield* store
        .getPlan(threadId, planId)
        .pipe(
          Effect.flip,
          Effect.ensuring(
            Effect.orDie(
              sql`DELETE FROM orchestration_v2_projection_plans WHERE plan_id = ${planId}`,
            ),
          ),
        );
      assert.strictEqual(failure._tag, "ProjectionStoreReadError");
    }),
  );

  it.effect(
    "SQL recovery selects unfinished runless native subagents",
    () => runlessNativeSubagentNeedsRecovery,
  );
  it.effect(
    "worktree path lookup defaults to active threads and can include archived threads",
    () => threadWorktreePathsIncludeArchivedOnRequest,
  );

  it.effect(
    "keeps restart-cancelled work through a stale run.updated",
    () => restartCancelledWorkSurvivesStaleRunUpdate,
  );
  it.effect("records restart-cancelled work without regressing a run that completed since", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("restart-cancelled-work");
      const run = (yield* store.getThreadProjection(threadId)).runs[0]!;
      const now = yield* DateTime.now;
      yield* store.apply({
        id: EventId.make("event:restart-cancelled-work:completed"),
        type: "run.updated",
        threadId,
        runId: run.id,
        providerInstanceId,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      });
      const work = [{ kind: "subagent" as const, label: "Background subagent test" }];
      yield* store.apply({
        id: EventId.make("event:restart-cancelled-work:recorded"),
        type: "run.background-work-cancelled",
        threadId,
        runId: run.id,
        providerInstanceId,
        occurredAt: now,
        payload: { runId: run.id, restartCancelledBackgroundWork: work },
      });
      const recorded = (yield* store.getThreadProjection(threadId)).runs[0];
      assert.equal(recorded?.status, "completed");
      assert.deepEqual(recorded?.restartCancelledBackgroundWork, work);
      const [recovery] = (yield* store.getThreadRecords(threadId, ["runs"], {
        runIds: [run.id],
      })).runs;
      assert.equal(recovery?.status, "completed");
      assert.deepEqual(recovery?.restartCancelledBackgroundWork, work);
    }),
  );
  it.effect(
    "command reads skip finished leaf nodes of finished runs",
    () => commandReadsSkipSettledLeafNodes,
  );
  it.effect("limits turn-start history to the requested runs, including an empty selection", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("selected-turn-start-history");
      const runId = (yield* store.getThreadProjection(threadId)).runs[0]!.id;
      const history = yield* store.getTurnStartHistory(threadId);
      assert.isNotEmpty(history);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId, [runId]), history);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId, []), []);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId, [RunId.make("run:other")]), []);
    }),
  );
  it.effect("answers empty record filters without reading the filtered tables", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("empty-record-filters");
      const runId = (yield* store.getThreadProjection(threadId)).runs[0]!.id;
      const queries: Array<string> = [];
      const recordQueries: Statement.Transformer = (statement) => {
        queries.push(statement.compile()[0]);
        return Effect.succeed(statement);
      };
      const read = (filter: ProjectionStore.ProjectionRecordFilter) =>
        store
          .getThreadRecords(threadId, ["runs", "messages", "turnItems"], filter)
          .pipe(Effect.provideService(Statement.CurrentTransformer, recordQueries));

      const emptyFilters = [
        [{ turnItemTypes: [] }, "turnItems", "turn_items"],
        [{ turnItemStatuses: [] }, "turnItems", "turn_items"],
        [{ turnItemRunIds: [] }, "turnItems", "turn_items"],
        [{ runIds: [] }, "runs", "runs"],
        [{ messageIds: [] }, "messages", "messages"],
        [{ messageRoles: [] }, "messages", "messages"],
        [{ messageRunIds: [] }, "messages", "messages"],
      ] as const;
      for (const [filter, field, table] of emptyFilters) {
        queries.length = 0;
        assert.isEmpty((yield* read(filter))[field]);
        assert.isFalse(
          queries.some((query) =>
            new RegExp(`FROM orchestration_v2_projection_${table}\\b`).test(query),
          ),
          `${JSON.stringify(filter)} read ${table}`,
        );
      }

      const selected = yield* read({ turnItemTypes: ["command_execution"], runIds: [runId] });
      assert.deepEqual(
        selected.turnItems.map((item) => item.type),
        ["command_execution"],
      );
      assert.deepEqual(
        selected.runs.map((run) => run.id),
        [runId],
      );
      assert.isEmpty((yield* read({ turnItemTypes: ["user_message"] })).turnItems);
    }),
  );
  it.effect(
    "preserves stored usage and native acceptance through markerless usage and recovery updates",
    () =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:provider-usage-reload");
        const providerThreadId = ProviderThreadId.make("provider-thread:provider-usage-reload");
        const providerTurnId = ProviderTurnId.make("provider-turn:provider-usage-reload");
        const nodeId = NodeId.make("node:provider-usage-reload");
        const initialUsage = {
          usedTokens: 12_000,
          maxTokens: 200_000,
          inputTokens: 11_000,
          outputTokens: 1_000,
          updatedAt: "2026-08-29T12:00:00.000Z",
        } as const;
        const replacementUsage = {
          usedTokens: 18_000,
          maxTokens: 200_000,
          inputTokens: 16_000,
          outputTokens: 2_000,
          updatedAt: "2026-08-29T12:00:01.000Z",
        } as const;

        yield* projectionStore.apply({
          id: EventId.make("event:provider-usage-reload:thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:provider-usage-reload"),
            title: "Provider usage reload",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });

        const providerTurn = {
          id: providerTurnId,
          providerThreadId,
          nodeId,
          runAttemptId: RunAttemptId.make("attempt:provider-usage-reload"),
          nativeTurnRef: null,
          ordinal: 1,
          status: "running" as const,
          startedAt: now,
          completedAt: null,
        };
        yield* projectionStore.apply({
          id: EventId.make("event:provider-usage-reload:running"),
          type: "provider-turn.updated",
          threadId,
          nodeId,
          driver,
          occurredAt: now,
          payload: { ...providerTurn, tokenUsage: initialUsage, promptAcceptedAt: now },
        });
        yield* projectionStore.apply({
          id: EventId.make("event:provider-usage-reload:live-usage"),
          type: "provider-turn.updated",
          threadId,
          nodeId,
          driver,
          occurredAt: now,
          payload: { ...providerTurn, tokenUsage: replacementUsage },
        });
        yield* projectionStore.apply({
          id: EventId.make("event:provider-usage-reload:completed"),
          type: "provider-turn.updated",
          threadId,
          nodeId,
          driver,
          occurredAt: now,
          payload: { ...providerTurn, status: "cancelled", completedAt: now },
        });

        const reloaded = yield* projectionStore.getThreadProjection(threadId);
        assert.deepEqual(reloaded.providerTurns[0]?.tokenUsage, replacementUsage);
        assert.strictEqual(reloaded.providerTurns[0]?.status, "cancelled");
        assert.deepEqual(reloaded.providerTurns[0]?.promptAcceptedAt, now);

        yield* projectionStore.apply({
          id: EventId.make("event:provider-usage-reload:replacement"),
          type: "provider-turn.updated",
          threadId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            ...providerTurn,
            status: "completed",
            completedAt: now,
            tokenUsage: replacementUsage,
          },
        });

        const replaced = yield* projectionStore.getThreadProjection(threadId);
        assert.deepEqual(replaced.providerTurns[0]?.tokenUsage, replacementUsage);
        assert.deepEqual(replaced.providerTurns[0]?.promptAcceptedAt, now);

        for (const tokenUsage of [undefined, replacementUsage]) {
          // Restore the acknowledged identity before proving each SQL path refuses
          // to carry its acceptance into a different attempt.
          yield* projectionStore.apply({
            id: EventId.make("event:provider-usage-reload:restore-ack"),
            type: "provider-turn.updated",
            threadId,
            nodeId,
            driver,
            occurredAt: now,
            payload: { ...providerTurn, promptAcceptedAt: now },
          });
          yield* projectionStore.apply({
            id: EventId.make("event:provider-usage-reload:different-attempt"),
            type: "provider-turn.updated",
            threadId,
            nodeId,
            driver,
            occurredAt: now,
            payload: {
              ...providerTurn,
              runAttemptId: RunAttemptId.make("attempt:replacement"),
              ...(tokenUsage === undefined ? {} : { tokenUsage }),
            },
          });
          assert.isUndefined(
            (yield* projectionStore.getThreadProjection(threadId)).providerTurns[0]
              ?.promptAcceptedAt,
          );
        }
      }),
  );

  it.effect.each([0, 1, 12])(
    "bounds a SQL thread with %i control turns and large outputs",
    (personTurns) =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const nowIso = DateTime.formatIso(now);
        const storage = `control-${personTurns}`;
        const threadId = ThreadId.make(`thread:${storage}`);
        yield* projectionStore.apply({
          id: EventId.make("event:user-turn-pages:thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:user-turn-pages"),
            title: "Bounded SQL history",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
        const ids: string[] = [];
        for (let ordinal = 1; ordinal <= 240; ordinal += 1) {
          const id = `item:${storage}:${ordinal}`;
          ids.push(id);
          const base = {
            id,
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: null,
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
          };
          const item =
            ordinal <= personTurns
              ? {
                  ...base,
                  type: "user_message",
                  createdBy: "system",
                  creationSource: "server",
                  messageId: `ardud-control:${ordinal}`,
                  inputIntent: "turn_start",
                  text: "The robob client has restarted. Please resume…",
                  attachments: [],
                }
              : {
                  ...base,
                  type: "command_execution",
                  input: "i".repeat(12_000),
                  output: "x".repeat(80_000),
                  exitCode: 0,
                };
          yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert({
            turn_item_id: id,
            thread_id: threadId,
            run_id: null,
            node_id: null,
            provider_thread_id: null,
            provider_turn_id: null,
            parent_item_id: null,
            ordinal,
            type: item.type,
            status: "completed",
            updated_at: nowIso,
            payload_json: encodeUnknownJsonString(item),
          })}`;
        }
        const full = yield* projectionStore.getThreadSnapshot(threadId);
        const initial = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
          userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
        });
        assert.isAtMost(initial.projection.turnItems.length, THREAD_HISTORY_SNAPSHOT_ROW_LIMIT);
        const bounded = buildBoundedThreadProjection(initial);
        const before = Buffer.byteLength(JSON.stringify(full.projection));
        const after = Buffer.byteLength(JSON.stringify(bounded.projection));
        assert.isAbove(before, 16 * 1024 * 1024);
        assert.isAtMost(after, THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes);
        assert.equal(bounded.projection.visibleTurnItems.at(-1)?.sourceItemId, ids.at(-1));
        const seen = bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId));
        let cursor = bounded.historyCursor;
        for (let pages = 0; cursor !== null; pages += 1) {
          assert.isBelow(pages, ids.length);
          const page = yield* projectionStore.getThreadHistoryPage(threadId, cursor);
          assert.isAtMost(page.items.length, THREAD_HISTORY_PAGE_POLICY.maxItems);
          assert.isBelow(
            Buffer.byteLength(JSON.stringify(page)),
            THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes,
          );
          seen.unshift(...page.items.map((row) => String(row.sourceItemId)));
          cursor = page.nextCursor;
        }
        assert.deepEqual(seen, ids);
      }),
  );

  it.effect.each(["hot", "cold", "base"] as const)(
    "caps %s user turns by rows and pages without gaps",
    (storage) =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const nowIso = DateTime.formatIso(now);
        const threadId = ThreadId.make(`thread:user-turn-pages:${storage}`);
        yield* projectionStore.apply({
          id: EventId.make("event:user-turn-pages:thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:user-turn-pages"),
            title: "Bounded SQL history",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });

        const allIds: string[] = [];
        let lastToolPayload = "";
        for (let turn = 1; turn <= 45; turn += 1) {
          const rows = Array.from({ length: 102 }, (_, offset) => {
            const ordinal = (turn - 1) * 102 + offset + 1;
            const id = `item:user-turn-pages:${storage}:${ordinal}`;
            allIds.push(id);
            const base = {
              id,
              threadId,
              runId: null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: null,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
            };
            const item =
              offset < 2
                ? {
                    ...base,
                    type: "user_message",
                    createdBy: "user",
                    creationSource: "web",
                    messageId: `message:${id}`,
                    inputIntent: offset === 0 ? "turn_start" : "steer",
                    text: `Turn ${turn}`,
                    attachments: [],
                  }
                : {
                    ...base,
                    type: "command_execution",
                    input: "command",
                    output: "x".repeat(2048),
                    exitCode: 0,
                  };
            const payloadJson = encodeUnknownJsonString(item);
            if (offset >= 2) lastToolPayload = payloadJson;
            return {
              turn_item_id: id,
              thread_id: threadId,
              run_id: null,
              node_id: null,
              provider_thread_id: null,
              provider_turn_id: null,
              parent_item_id: null,
              ordinal,
              type: item.type,
              status: "completed",
              updated_at: nowIso,
              payload_json: payloadJson,
            };
          });
          yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(rows)}`;
        }
        if (storage !== "hot") yield* archiveTurnItems(threadId, 40 * 102, storage);
        const { statements, tracer } = traceSqlStatements();
        const initial = yield* Effect.acquireUseRelease(
          Effect.sync(() => vi.spyOn(JSON, "parse")),
          (parse) =>
            projectionStore
              .getThreadSnapshotWindow(threadId, { rowLimit: 77, userTurnLimit: 10 })
              .pipe(
                Effect.withTracer(tracer),
                Effect.tap(() =>
                  Effect.sync(() => {
                    assert.lengthOf(
                      parse.mock.calls.filter(([input]) => input === lastToolPayload),
                      1,
                    );
                  }),
                ),
              ),
          (parse) => Effect.sync(() => parse.mockRestore()),
        );
        const windowStatement = statements.find((statement) => statement.includes("turn_anchors"));
        assert.isDefined(windowStatement);
        const windowPlan = yield* sql.unsafe<{ readonly parent: number; readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${windowStatement}`,
        );
        assert.match(
          windowPlan.map((row) => row.detail).join("\n"),
          /SEARCH (?:item|main\.orchestration_v2_projection_turn_items) USING INDEX orchestration_v2_projection_turn_items_user_message_idx \(thread_id=\? AND ordinal<\?\)/,
        );
        assertIndexedHistoryWindow(windowPlan.map((row) => row.detail));
        const topLevel = windowPlan.filter((row) => row.parent === 0).map((row) => row.detail);
        assert.lengthOf(
          windowPlan.filter(
            (row) => row.detail === "SEARCH item USING INTEGER PRIMARY KEY (rowid=?)",
          ),
          2,
        );
        assert.match(
          windowPlan.map((row) => row.detail).join("\n"),
          /SEARCH item USING INDEX sqlite_autoindex_ardud_turn_items_1 \(ardud_locator=\?\)/,
        );
        assert.notInclude(topLevel, "USE TEMP B-TREE FOR ORDER BY");
        const nodeStatement = statements.find((statement) =>
          statement.includes("WITH RECURSIVE retained"),
        );
        assert.isDefined(nodeStatement);
        const nodePlan = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${nodeStatement}`,
        );
        assert.include(
          nodePlan.map((row) => row.detail),
          "SEARCH orchestration_v2_projection_nodes USING INDEX orchestration_v2_projection_nodes_live_idx (thread_id=?)",
        );
        assert.lengthOf(initial.projection.turnItems, 77);
        const bounded = buildBoundedThreadProjection({
          projection: initial.projection,
          snapshotSequence: 0,
        });
        assert.lengthOf(bounded.projection.visibleTurnItems, 75);
        assert.strictEqual(bounded.projection.visibleTurnItems[0]?.sourceItemId, allIds.at(-75));
        const loaded = bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId));
        let cursor = bounded.historyCursor;
        for (let pages = 0; cursor !== null; pages += 1) {
          assert.isBelow(pages, 100);
          assert.isNotNull(cursor);
          const anchor = decodeThreadHistoryCursor(cursor!);
          const snapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
            rowLimit: 77,
            userTurnLimit: 20,
            anchorItemId: TurnItemId.make(anchor.si),
            anchorThreadId: ThreadId.make(anchor.st),
          });
          const page = selectHistoryPageFromCursor({
            items: snapshot.projection.visibleTurnItems,
            cursor: cursor!,
            snapshotSequence: 0,
          });
          assert.isAtMost(page.items.length, 75);
          loaded.unshift(...page.items.map((row) => String(row.sourceItemId)));
          cursor = page.nextCursor;
        }
        assert.isNull(cursor);
        assert.deepEqual(loaded, allIds);
      }),
  );

  // ardud: - a bearer's prompt is a person's turn too.
  it.effect("windows a thread of bearer prompts by its turns, not server notices", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const windowRows = (name: string, messageId: (turn: number) => string) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(`thread:${name}`);
          yield* projectionStore.apply({
            id: EventId.make(`event:${name}:thread`),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: {
              createdBy: "system",
              creationSource: "server",
              id: threadId,
              projectId: ProjectId.make(`project:${name}`),
              title: name,
              providerInstanceId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: null,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          });
          for (let turn = 1; turn <= 30; turn += 1) {
            const rows = Array.from({ length: 3 }, (_, offset) => {
              const ordinal = (turn - 1) * 3 + offset + 1;
              const id = `item:${name}:${ordinal}`;
              const base = {
                id,
                threadId,
                runId: null,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal,
                status: "completed",
                title: null,
                startedAt: nowIso,
                completedAt: nowIso,
                updatedAt: nowIso,
              };
              const item =
                offset === 0
                  ? {
                      ...base,
                      type: "user_message",
                      createdBy: "system",
                      creationSource: "server",
                      messageId: messageId(turn),
                      inputIntent: "turn_start",
                      text: `Turn ${turn}`,
                      attachments: [],
                    }
                  : { ...base, type: "command_execution", input: "c", output: "o", exitCode: 0 };
              return {
                turn_item_id: id,
                thread_id: threadId,
                run_id: null,
                node_id: null,
                provider_thread_id: null,
                provider_turn_id: null,
                parent_item_id: null,
                ordinal,
                type: item.type,
                status: "completed",
                updated_at: nowIso,
                payload_json: encodeUnknownJsonString(item),
              };
            });
            yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(rows)}`;
          }
          const snapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
            rowLimit: 77,
            userTurnLimit: 10,
          });
          return snapshot.projection.turnItems.length;
        });
      // Ten turns plus two lookahead anchors, as for the owner's own prompts.
      assert.strictEqual(
        yield* windowRows("bearer-turns", (turn) => `ardud-control:send:t:msg-${turn}`),
        12 * 3,
      );
      // Server-made prompts are not turns, so the window falls back to its row limit.
      assert.strictEqual(
        yield* windowRows("server-notices", (turn) => `usage-limit-retry:${turn}`),
        77,
      );
    }),
  );

  it.effect.each(["hot", "cold", "base"] as const)(
    "caps a %s SQL window by runs that a notification started",
    (storage) =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const nowIso = DateTime.formatIso(now);
        const threadId = ThreadId.make(`thread:notification-turn-pages:${storage}`);
        yield* projectionStore.apply({
          id: EventId.make("event:notification-turn-pages:thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:notification-turn-pages"),
            title: "Woken by notifications",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });

        const startedRuns = 412;
        const allIds: string[] = [];
        const startIds: string[] = [];
        let ordinal = 0;
        const itemRow = (runId: string, item: Record<string, unknown>) => {
          ordinal += 1;
          const id = `turn-item:notification-turn-pages:${storage}:${ordinal}`;
          allIds.push(id);
          return {
            turn_item_id: id,
            thread_id: threadId,
            run_id: runId,
            node_id: null,
            provider_thread_id: null,
            provider_turn_id: null,
            parent_item_id: null,
            ordinal,
            type: String(item.type),
            status: "completed",
            updated_at: nowIso,
            payload_json: encodeUnknownJsonString({
              id,
              threadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: null,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              ...item,
            }),
          };
        };
        const command = { type: "command_execution", input: "command", output: "x", exitCode: 0 };
        const notification = (summary: string) => ({
          type: "notification",
          source: { kind: "monitor" },
          outcome: "completed",
          summary,
        });
        for (let run = 1; run <= startedRuns + 1; run += 1) {
          const runId = `run:notification-turn-pages:${storage}:${run}`;
          const status = run > startedRuns ? "queued" : "completed";
          yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id, status,
            requested_at, completed_at, payload_json
          ) VALUES (
            ${runId}, ${threadId}, ${run}, 'codex', NULL, ${status}, ${nowIso}, ${nowIso},
            ${encodeUnknownJsonString({
              id: runId,
              threadId,
              ordinal: run,
              providerInstanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: `message:notification-turn-pages:${run}`,
              rootNodeId: `node:notification-turn-pages:${run}`,
              activeAttemptId: null,
              status,
              requestedAt: nowIso,
              startedAt: nowIso,
              completedAt: nowIso,
              checkpointId: null,
              contextHandoffId: null,
            })}
          )
        `;
          if (run > startedRuns) continue;
          const start =
            run <= 12 || run % 50 === 0
              ? {
                  type: "user_message",
                  createdBy: "user",
                  creationSource: "web",
                  messageId: `message:notification-turn-pages:${run}`,
                  inputIntent: "turn_start",
                  text: `Turn ${run}`,
                  attachments: [],
                }
              : notification(`Wake ${run}`);
          const rows = [
            itemRow(runId, command),
            itemRow(runId, start),
            itemRow(runId, command),
            itemRow(runId, notification(`Steer ${run}`)),
          ];
          startIds.push(rows[1]!.turn_item_id);
          yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(rows)}`;
        }

        if (storage !== "hot") yield* archiveTurnItems(threadId, 400 * 4, storage);
        const { statements, tracer } = traceSqlStatements();
        const initial = yield* projectionStore
          .getThreadSnapshotWindow(threadId, { rowLimit: 77, userTurnLimit: 10 })
          .pipe(Effect.withTracer(tracer));
        assert.deepEqual(
          initial.projection.turnItems.map((item) => String(item.id)),
          allIds.slice(-77),
        );
        const windowStatement = statements.find((statement) => statement.includes("run_starts"));
        assert.isDefined(windowStatement);
        const windowPlan = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${windowStatement}`,
        );
        const windowPlanDetails = windowPlan.map((row) => row.detail);
        assert.include(
          windowPlanDetails,
          "SEARCH recent_run USING INDEX orchestration_v2_projection_runs_thread_ordinal_idx (thread_id=? AND ordinal<?)",
        );
        assert.lengthOf(
          windowPlanDetails.filter(
            (detail) =>
              detail ===
              "SEARCH item USING INDEX orchestration_v2_projection_turn_items_run_ordinal_idx (run_id=?)",
          ),
          2,
        );
        assert.include(
          windowPlanDetails,
          "SEARCH item USING INDEX ardud_turn_items_run_idx (run_id=?)",
        );
        assertIndexedHistoryWindow(windowPlanDetails);
        const bounded = buildBoundedThreadProjection({
          projection: initial.projection,
          snapshotSequence: 0,
        });
        assert.strictEqual(bounded.projection.visibleTurnItems[0]?.sourceItemId, allIds.at(-75));
        const loaded = bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId));
        let cursor = bounded.historyCursor;
        for (let pages = 0; cursor !== null; pages += 1) {
          assert.isBelow(pages, 100);
          const anchor = decodeThreadHistoryCursor(cursor);
          const snapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
            rowLimit: 77,
            userTurnLimit: 20,
            anchorItemId: TurnItemId.make(anchor.si),
            anchorThreadId: ThreadId.make(anchor.st),
          });
          assert.isAtMost(snapshot.projection.turnItems.length, 77);
          const page = selectHistoryPageFromCursor({
            items: snapshot.projection.visibleTurnItems,
            cursor,
            snapshotSequence: 0,
          });
          loaded.unshift(...page.items.map((row) => String(row.sourceItemId)));
          cursor = page.nextCursor;
        }
        assert.deepEqual(loaded, allIds);
      }),
  );

  it.effect(
    "bounds completed nodes within one long run while preserving ancestry and live work",
    () =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:bounded-node-history");
        yield* projectionStore.apply({
          id: EventId.make("event:bounded-node-history:thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:bounded-node-history"),
            title: "Bounded SQL history",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
        const runId = RunId.make("run:bounded-node-history");
        const rootNodeId = NodeId.make("node:bounded-node-history:root");
        yield* projectionStore.apply({
          id: EventId.make("event:bounded-node-history:run"),
          type: "run.created",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("message:bounded-node-history"),
            rootNodeId,
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        const parentNodeId = NodeId.make("node:bounded-node-history:parent");
        const liveNodeId = NodeId.make("node:bounded-node-history:live");
        for (let index = -3; index < 1000; index++) {
          const id =
            index === -3
              ? rootNodeId
              : index === -2
                ? parentNodeId
                : index === -1
                  ? liveNodeId
                  : NodeId.make(`node:bounded-node-history:${index}`);
          yield* projectionStore.apply({
            id: EventId.make(`event:bounded-node-history:node:${index}`),
            type: "node.updated",
            threadId,
            runId,
            nodeId: id,
            driver,
            occurredAt: now,
            payload: {
              id,
              threadId,
              runId,
              rootNodeId,
              parentNodeId: index === -3 ? null : index === -2 ? rootNodeId : parentNodeId,
              kind: index === -3 ? "root_turn" : "assistant_message",
              status: index === -1 ? "running" : "completed",
              countsForRun: index === -3,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt:
                index === 998
                  ? null
                  : index === 999
                    ? DateTime.makeUnsafe("2020-01-01T00:00:00.000Z")
                    : now,
              completedAt: index === -1 ? null : now,
            },
          });
          if (index < 0) continue;
          yield* projectionStore.apply({
            id: EventId.make(`event:bounded-node-history:item:${index}`),
            type: "turn-item.updated",
            threadId,
            runId,
            nodeId: id,
            driver,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`item:bounded-node-history:${index}`),
              threadId,
              runId,
              nodeId: id,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: index,
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "command_execution",
              input: `echo ${index}`,
              output: "ok",
              exitCode: 0,
            },
          });
        }
        const requestNodeId = NodeId.make("node:bounded-node-history:0");
        yield* projectionStore.apply({
          id: EventId.make("event:bounded-node-history:request"),
          type: "runtime-request.updated",
          threadId,
          runId,
          nodeId: requestNodeId,
          driver,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make("request:bounded-node-history"),
            nodeId: requestNodeId,
            providerTurnId: ProviderTurnId.make("provider-turn:bounded-node-history"),
            nativeRequestRef: null,
            kind: "command",
            status: "pending",
            responseCapability: {
              type: "live",
              providerSessionId: ProviderSessionId.make("session:bounded-node-history"),
            },
            createdAt: now,
            resolvedAt: null,
          },
        });
        const { statements, tracer } = traceSqlStatements();
        const snapshot = yield* projectionStore
          .getThreadSnapshotWindow(threadId, { rowLimit: 75 })
          .pipe(Effect.withTracer(tracer));
        const nodeStatement = statements.find(
          (statement) =>
            statement.includes("payload_json") &&
            statement.includes("orchestration_v2_projection_nodes") &&
            !statement.includes("WITH RECURSIVE"),
        );
        assert.isDefined(nodeStatement);
        const nodePlan = yield* (yield* SqlClient.SqlClient).unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${nodeStatement}`,
        );
        const nodeLookups = nodePlan
          .map((row) => row.detail)
          .filter((detail) => detail.startsWith("SEARCH "));
        assert.deepEqual(nodeLookups, [
          "SEARCH node USING INDEX sqlite_autoindex_orchestration_v2_projection_nodes_1 (node_id=?)",
        ]);
        assert.notInclude(
          nodePlan.map((row) => row.detail),
          "USE TEMP B-TREE FOR ORDER BY",
        );
        assert.lengthOf(snapshot.projection.visibleTurnItems, 75);
        assert.lengthOf(snapshot.projection.nodes, 79);
        const retained = new Set(snapshot.projection.nodes.map((node) => node.id));
        assert.isTrue(retained.has(rootNodeId));
        assert.isTrue(retained.has(parentNodeId));
        assert.isTrue(retained.has(liveNodeId));
        assert.isTrue(retained.has(requestNodeId));
        assert.lengthOf(snapshot.projection.runtimeRequests, 1);
        assert.isFalse(retained.has(NodeId.make("node:bounded-node-history:1")));
        for (const row of snapshot.projection.visibleTurnItems)
          assert.isTrue(retained.has(row.item.nodeId!));
        const older = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: 75,
          anchorItemId: TurnItemId.make("item:bounded-node-history:925"),
        });
        assert.lengthOf(older.projection.nodes, 79);
        assert.isTrue(
          older.projection.nodes.some(
            (node) => node.id === NodeId.make("node:bounded-node-history:851"),
          ),
        );
        const full = yield* projectionStore.getThreadSnapshot(threadId);
        assert.lengthOf(full.projection.nodes, 1003);
        assert.deepEqual(
          snapshot.projection.nodes,
          full.projection.nodes.filter((node) => retained.has(node.id)),
        );
        const sql = yield* SqlClient.SqlClient;
        const duplicateItemId = TurnItemId.make("item:bounded-node-history:duplicate");
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items
          SELECT ${duplicateItemId}, thread_id, run_id, node_id, provider_thread_id,
            provider_turn_id, parent_item_id, ordinal + 1, type, status, updated_at,
            json_set(payload_json, '$.id', ${duplicateItemId}, '$.ordinal', ordinal + 1)
          FROM orchestration_v2_projection_turn_items
          WHERE turn_item_id = ${TurnItemId.make("item:bounded-node-history:999")}
        `;
        const sharedNodeSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: 76,
        });
        assert.lengthOf(sharedNodeSnapshot.projection.visibleTurnItems, 76);
        assert.deepEqual(sharedNodeSnapshot.projection.nodes, snapshot.projection.nodes);
      }),
  );

  it.effect("reads a fixed SQL turn-item window for long histories and repeated clients", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:bounded-sql-history");
      yield* projectionStore.apply({
        id: EventId.make("event:bounded-sql-history:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:bounded-sql-history"),
          title: "Bounded SQL history",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });

      for (let ordinal = 1; ordinal <= 1_000; ordinal += 1) {
        const id = `turn-item:bounded-sql-history:${ordinal}`;
        const runId = `run:bounded-sql-history:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id, status,
            requested_at, completed_at, payload_json
          ) VALUES (
            ${runId}, ${threadId}, ${ordinal}, 'codex', NULL, 'completed', ${nowIso}, ${nowIso},
            ${encodeUnknownJsonString({
              id: runId,
              threadId,
              ordinal,
              providerInstanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: `message:bounded-sql-history:${ordinal}`,
              rootNodeId: `node:bounded-sql-history:${ordinal}`,
              activeAttemptId: null,
              status: "completed",
              requestedAt: nowIso,
              startedAt: nowIso,
              completedAt: nowIso,
              checkpointId: null,
              contextHandoffId: null,
            })}
          )
        `;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, ${runId}, NULL, NULL, NULL, NULL, ${ordinal},
            'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: `command ${ordinal}`,
              input: `echo ${ordinal}`,
              output: "ok",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }

      const snapshots = yield* Effect.all(
        Array.from({ length: 4 }, () =>
          projectionStore.getThreadSnapshotWindow(threadId, { rowLimit: 76 }),
        ),
        { concurrency: 4 },
      );
      for (const snapshot of snapshots) {
        assert.lengthOf(snapshot.projection.turnItems, 76);
        assert.lengthOf(snapshot.projection.runs, 76);
        assert.lengthOf(snapshot.projection.visibleTurnItems, 76);
        assert.strictEqual(snapshot.projection.turnItems[0]?.ordinal, 925);
        assert.strictEqual(snapshot.projection.turnItems.at(-1)?.ordinal, 1_000);
      }
      const retainedRequestPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        WITH selected AS (
          SELECT run_id, type
          FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId}
          ORDER BY ordinal DESC, turn_item_id DESC
          LIMIT 77
        )
        SELECT request.payload_json
        FROM orchestration_v2_projection_turn_items AS request
        WHERE request.run_id IN (
            SELECT run_id FROM selected
            WHERE type = 'run_interrupt_result' AND run_id IS NOT NULL
          )
          AND request.type = 'run_interrupt_request'
      `;
      assert.isTrue(
        retainedRequestPlan.some((row) =>
          row.detail.includes("orchestration_v2_projection_turn_items_run_ordinal_idx"),
        ),
      );

      const older = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 76,
        anchorItemId: TurnItemId.make("turn-item:bounded-sql-history:925"),
      });
      assert.lengthOf(older.projection.turnItems, 76);
      assert.lengthOf(older.projection.runs, 76);
      assert.strictEqual(older.projection.turnItems[0]?.ordinal, 850);
      assert.strictEqual(older.projection.turnItems.at(-1)?.ordinal, 925);

      const itemId = TurnItemId.make("turn-item:bounded-sql-history:925");
      const stored = yield* projectionStore.getTurnItem({ threadId, itemId });
      assert.strictEqual(stored?.type === "command_execution" ? stored.output : undefined, "ok");
      assert.isNull(
        yield* projectionStore.getTurnItem({ threadId: ThreadId.make("thread:other"), itemId }),
      );

      const sqlPageLimit = THREAD_HISTORY_PAGE_POLICY.maxItems + 2;
      const initialSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
      });
      const initialPage = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        projection: initialSnapshot.projection,
        snapshotSequence: initialSnapshot.snapshotSequence,
      });
      const loadedIds = initialPage.projection.visibleTurnItems.map((row) =>
        String(row.sourceItemId),
      );
      let cursor = initialPage.historyCursor;
      let pageCount = 1;
      while (cursor !== null) {
        const anchorItemId = TurnItemId.make(decodeThreadHistoryCursor(cursor).si);
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: sqlPageLimit,
          anchorItemId,
        });
        const page = selectHistoryPageFromCursor({
          policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
          items: snapshot.projection.visibleTurnItems,
          cursor,
          snapshotSequence: snapshot.snapshotSequence,
        });
        loadedIds.push(...page.items.map((row) => String(row.sourceItemId)));
        pageCount += 1;
        cursor = page.nextCursor;
      }

      assert.isAtLeast(pageCount, 4);
      assert.lengthOf(loadedIds, 1_000);
      assert.strictEqual(new Set(loadedIds).size, 1_000);
      assert.deepEqual(
        loadedIds.toSorted(
          (left, right) => Number(left.split(":").at(-1)) - Number(right.split(":").at(-1)),
        ),
        Array.from({ length: 1_000 }, (_, index) => `turn-item:bounded-sql-history:${index + 1}`),
      );

      const tiedIds = [
        TurnItemId.make("turn-item:bounded-sql-history:tie:b"),
        TurnItemId.make("turn-item:bounded-sql-history:tie:a"),
      ];
      for (const id of tiedIds) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          )
          SELECT ${id}, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, 2000, type, status, updated_at,
            json_set(payload_json, '$.id', ${id}, '$.ordinal', 2000)
          FROM orchestration_v2_projection_turn_items
          WHERE turn_item_id = ${itemId}
        `;
      }
      const tied = yield* projectionStore.getThreadSnapshotWindow(threadId, { rowLimit: 3 });
      assert.deepEqual(
        tied.projection.turnItems.map((item) => item.id),
        [TurnItemId.make("turn-item:bounded-sql-history:1000"), tiedIds[1], tiedIds[0]],
      );
      yield* sql`
        DELETE FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id IN ${sql.in(tiedIds)}
      `;

      const hiddenRunId = RunId.make("run:bounded-sql-history:hidden-suffix");
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status,
          requested_at, completed_at, payload_json
        ) VALUES (
          ${hiddenRunId}, ${threadId}, 1001, 'codex', NULL, 'rolled_back', ${nowIso}, ${nowIso},
          ${encodeUnknownJsonString({
            id: hiddenRunId,
            threadId,
            ordinal: 1001,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: "message:bounded-sql-history:hidden-suffix",
            rootNodeId: "node:bounded-sql-history:hidden-suffix",
            activeAttemptId: null,
            status: "rolled_back",
            requestedAt: nowIso,
            startedAt: nowIso,
            completedAt: nowIso,
            checkpointId: null,
            contextHandoffId: null,
          })}
        )
      `;
      for (let ordinal = 1_001; ordinal <= 1_100; ordinal += 1) {
        const id = `turn-item:bounded-sql-history:hidden:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, ${hiddenRunId}, NULL, NULL, NULL, NULL, ${ordinal},
            'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId,
              runId: hiddenRunId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "rolled back",
              input: "echo hidden",
              output: "hidden",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }

      const hiddenSuffixSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
      });
      const hiddenSuffixPage = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        projection: hiddenSuffixSnapshot.projection,
        snapshotSequence: hiddenSuffixSnapshot.snapshotSequence,
      });
      assert.lengthOf(hiddenSuffixPage.projection.visibleTurnItems, 75);
      assert.strictEqual(hiddenSuffixPage.latestLocalTurnOrdinal, 1_100);
      assert.isTrue(hiddenSuffixPage.hasMoreHistory);
      assert.isFalse(
        hiddenSuffixPage.projection.visibleTurnItems.some((row) =>
          String(row.sourceItemId).includes(":hidden:"),
        ),
      );
      const hiddenSuffixCursor = hiddenSuffixPage.historyCursor;
      assert.isNotNull(hiddenSuffixCursor);
      const hiddenSuffixAnchor = TurnItemId.make(decodeThreadHistoryCursor(hiddenSuffixCursor!).si);
      const hiddenSuffixOlderSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
        anchorItemId: hiddenSuffixAnchor,
      });
      const hiddenSuffixOlderPage = selectHistoryPageFromCursor({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        items: hiddenSuffixOlderSnapshot.projection.visibleTurnItems,
        cursor: hiddenSuffixCursor!,
        snapshotSequence: hiddenSuffixOlderSnapshot.snapshotSequence,
      });
      assert.lengthOf(hiddenSuffixOlderPage.items, 75);
      assert.isTrue(hiddenSuffixOlderPage.hasMoreHistory);

      const cancelledRunId = RunId.make("run:bounded-sql-history:cancelled-suffix");
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status,
          requested_at, completed_at, payload_json
        ) VALUES (
          ${cancelledRunId}, ${threadId}, 1002, 'codex', NULL, 'cancelled', ${nowIso}, ${nowIso},
          ${encodeUnknownJsonString({
            id: cancelledRunId,
            threadId,
            ordinal: 1002,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: "message:bounded-sql-history:cancelled-suffix",
            rootNodeId: "node:bounded-sql-history:cancelled-suffix",
            activeAttemptId: null,
            status: "cancelled",
            requestedAt: nowIso,
            startedAt: nowIso,
            completedAt: nowIso,
            checkpointId: null,
            contextHandoffId: null,
          })}
        )
      `;
      for (let ordinal = 1_101; ordinal <= 1_200; ordinal += 1) {
        const id = `turn-item:bounded-sql-history:cancelled:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, ${cancelledRunId}, NULL, NULL, NULL, NULL, ${ordinal},
            'user_message', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              createdBy: "user",
              creationSource: "web",
              id,
              threadId,
              runId: cancelledRunId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "cancelled queued message",
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "user_message",
              messageId: `message:bounded-sql-history:cancelled:${ordinal}`,
              inputIntent: "queued_turn",
              text: "cancelled",
              attachments: [],
            })}
          )
        `;
      }
      const runlessQueuedId = "turn-item:bounded-sql-history:runless-queued";
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${runlessQueuedId}, ${threadId}, NULL, NULL, NULL, NULL, NULL, 1201,
          'user_message', 'completed', ${nowIso},
          ${encodeUnknownJsonString({
            createdBy: "user",
            creationSource: "web",
            id: runlessQueuedId,
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1201,
            status: "completed",
            title: "runless queued message",
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "user_message",
            messageId: "message:bounded-sql-history:runless-queued",
            inputIntent: "queued_turn",
            text: "still visible",
            attachments: [],
          })}
        )
      `;
      const laterCancelledId = "turn-item:bounded-sql-history:cancelled:1202";
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${laterCancelledId}, ${threadId}, ${cancelledRunId}, NULL, NULL, NULL, NULL, 1202,
          'user_message', 'completed', ${nowIso},
          ${encodeUnknownJsonString({
            createdBy: "user",
            creationSource: "web",
            id: laterCancelledId,
            threadId,
            runId: cancelledRunId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1202,
            status: "completed",
            title: "later cancelled queued message",
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "user_message",
            messageId: "message:bounded-sql-history:cancelled:1202",
            inputIntent: "queued_turn",
            text: "cancelled",
            attachments: [],
          })}
        )
      `;
      const cancelledSuffixSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
      });
      const cancelledSuffixPage = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        projection: cancelledSuffixSnapshot.projection,
        snapshotSequence: cancelledSuffixSnapshot.snapshotSequence,
      });
      assert.strictEqual(cancelledSuffixPage.latestLocalTurnOrdinal, 1_202);
      assert.lengthOf(cancelledSuffixPage.projection.visibleTurnItems, 75);
      assert.isFalse(
        cancelledSuffixPage.projection.visibleTurnItems.some((row) =>
          String(row.sourceItemId).includes(":cancelled:"),
        ),
      );
      assert.isTrue(
        cancelledSuffixPage.projection.visibleTurnItems.some(
          (row) => row.sourceItemId === runlessQueuedId,
        ),
      );

      const interruptRunId = RunId.make("run:bounded-sql-history:interrupt");
      const interruptNodeId = NodeId.make("node:bounded-sql-history:interrupt");
      const interruptRequestId = TurnItemId.make("turn-item:bounded-sql-history:interrupt-request");
      const interruptResultId = TurnItemId.make("turn-item:bounded-sql-history:interrupt-result");
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status,
          requested_at, completed_at, payload_json
        ) VALUES (
          ${interruptRunId}, ${threadId}, 1003, 'codex', 'provider-thread:interrupt', 'completed',
          ${nowIso}, ${nowIso},
          ${encodeUnknownJsonString({
            id: interruptRunId,
            threadId,
            ordinal: 1003,
            providerInstanceId,
            modelSelection,
            providerThreadId: "provider-thread:interrupt",
            userMessageId: "message:interrupt",
            rootNodeId: interruptNodeId,
            activeAttemptId: "attempt:bounded-sql-history:interrupt",
            status: "completed",
            requestedAt: nowIso,
            startedAt: nowIso,
            completedAt: nowIso,
            checkpointId: null,
            contextHandoffId: null,
          })}
        )
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_run_attempts (
          attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider,
          provider_instance_id, provider_thread_id, provider_turn_id, status, payload_json
        ) VALUES (
          'attempt:bounded-sql-history:interrupt', ${threadId}, ${interruptRunId}, 1,
          ${interruptNodeId}, 'codex', ${providerInstanceId}, 'provider-thread:interrupt', NULL,
          'superseded',
          ${encodeUnknownJsonString({
            id: "attempt:bounded-sql-history:interrupt",
            runId: interruptRunId,
            attemptOrdinal: 1,
            rootNodeId: interruptNodeId,
            providerInstanceId,
            providerThreadId: "provider-thread:interrupt",
            providerTurnId: null,
            reason: "initial",
            status: "superseded",
            startedAt: nowIso,
            completedAt: nowIso,
          })}
        )
      `;
      const insertInterruptItem = (input: {
        id: TurnItemId;
        ordinal: number;
        type: "run_interrupt_request" | "run_interrupt_result";
      }) => sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${input.id}, ${threadId}, ${interruptRunId}, ${interruptNodeId}, NULL, NULL, NULL,
          ${input.ordinal}, ${input.type}, 'completed', ${nowIso},
          ${encodeUnknownJsonString({
            id: input.id,
            threadId,
            runId: interruptRunId,
            nodeId: interruptNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: input.ordinal,
            status: "completed",
            title: input.type,
            message: input.type === "run_interrupt_request" ? "Stopping" : "Stopped",
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: input.type,
          })}
        )
      `;
      yield* insertInterruptItem({
        id: interruptRequestId,
        ordinal: 1_201,
        type: "run_interrupt_request",
      });
      for (let ordinal = 1_202; ordinal <= 1_281; ordinal += 1) {
        const id = `turn-item:bounded-sql-history:interrupt-filler:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, NULL, NULL, NULL, NULL, NULL, ${ordinal},
            'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId,
              runId: null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "filler",
              input: "echo filler",
              output: "ok",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }
      yield* insertInterruptItem({
        id: interruptResultId,
        ordinal: 1_282,
        type: "run_interrupt_result",
      });

      const interruptSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
      });
      assert.isTrue(
        interruptSnapshot.projection.turnItems.some((item) => item.id === interruptRequestId),
      );
      assert.isTrue(
        interruptSnapshot.projection.visibleTurnItems.some(
          (row) => row.sourceItemId === interruptResultId,
        ),
      );

      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET payload_json = json_set(payload_json, '$.createdBy', 'agent')
        WHERE thread_id = ${threadId} AND type = 'user_message'
      `;
      const agentPromptId = TurnItemId.make("turn-item:bounded-sql-history:interrupt-filler:1281");
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = 'user_message',
          payload_json = json_set(payload_json,
            '$.type', 'user_message', '$.inputIntent', 'turn_start',
            '$.createdBy', 'agent', '$.creationSource', 'provider',
            '$.messageId', 'message:bounded-sql-history:agent-prompt',
            '$.text', 'Continue the child task', '$.attachments', json('[]'))
        WHERE turn_item_id = ${agentPromptId}
      `;
      const agentWindow = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
        userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
      });
      assert.lengthOf(
        agentWindow.projection.visibleTurnItems.filter(
          (row) => row.item.type !== "run_interrupt_request",
        ),
        sqlPageLimit,
      );
      assert.isTrue(
        agentWindow.projection.visibleTurnItems.some((row) => row.sourceItemId === agentPromptId),
      );
    }),
  );

  it.effect("scopes actionable provider state to the requested bounded thread", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:bounded-provider-scope");
      const targetThreadId = ThreadId.make("thread:bounded-provider-scope:target");
      const unrelatedThreadId = ThreadId.make("thread:bounded-provider-scope:unrelated");
      const makeThread = (threadId: ThreadId) => ({
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: String(threadId),
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      });
      for (const threadId of [targetThreadId, unrelatedThreadId]) {
        yield* projectionStore.apply({
          id: EventId.make(`event:bounded-provider-scope:thread:${threadId}`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: makeThread(threadId),
        });
        const sessionId = ProviderSessionId.make(`provider-session:${threadId}`);
        const providerThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
        yield* projectionStore.apply({
          id: EventId.make(`event:bounded-provider-scope:session:${threadId}`),
          type: "provider-session.attached",
          threadId,
          driver,
          occurredAt: now,
          payload: {
            id: sessionId,
            driver,
            providerInstanceId,
            status: "running",
            cwd: "/workspace",
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:bounded-provider-scope:provider-thread:${threadId}`),
          type: "provider-thread.updated",
          threadId,
          driver,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId,
            providerSessionId: sessionId,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        });
      }

      const snapshot = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 10,
      });

      assert.deepEqual(
        snapshot.projection.providerSessions.map((session) => session.id),
        [ProviderSessionId.make(`provider-session:${targetThreadId}`)],
      );
      assert.deepEqual(
        snapshot.projection.providerThreads.map((thread) => thread.id),
        [ProviderThreadId.make(`provider-thread:${targetThreadId}`)],
      );
    }),
  );

  it.effect("projects root provider owners into the shell in first-use order", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:provider-history");
      const threadId = ThreadId.make("thread:provider-history");
      const claudeInstanceId = ProviderInstanceId.make("claude");
      const claudeDriver = ProviderDriverKind.make("claudeAgent");
      yield* projectionStore.apply({
        id: EventId.make("event:provider-history:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Provider history",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const providerThreads = [
        { suffix: "codex", instanceId: providerInstanceId, ownerNodeId: null, seconds: 0 },
        {
          suffix: "claude-subagent",
          instanceId: claudeInstanceId,
          ownerNodeId: NodeId.make("node:provider-history"),
          seconds: 1,
        },
        { suffix: "claude", instanceId: claudeInstanceId, ownerNodeId: null, seconds: 2 },
        { suffix: "codex-again", instanceId: providerInstanceId, ownerNodeId: null, seconds: 3 },
      ] as const;
      for (const providerThread of providerThreads) {
        const createdAt = DateTime.add(now, { seconds: providerThread.seconds });
        yield* projectionStore.apply({
          id: EventId.make(`event:provider-history:${providerThread.suffix}`),
          type: "provider-thread.updated",
          threadId,
          driver: providerThread.instanceId === claudeInstanceId ? claudeDriver : driver,
          occurredAt: createdAt,
          payload: {
            id: ProviderThreadId.make(`provider-thread:provider-history:${providerThread.suffix}`),
            driver: providerThread.instanceId === claudeInstanceId ? claudeDriver : driver,
            providerInstanceId: providerThread.instanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: providerThread.ownerNodeId,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt,
            updatedAt: createdAt,
          },
        });
      }

      const shell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.deepEqual(shell?.providerInstanceHistory, [providerInstanceId, claudeInstanceId]);
    }),
  );

  it.effect("shows the native goal of the active provider thread on the shell", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:provider-goal");
      yield* projectionStore.apply({
        id: EventId.make("event:provider-goal:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:provider-goal"),
          title: "Provider goal",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const applyProviderThread = (
        suffix: string,
        goal: OrchestrationV2ProviderThread["goal"],
        seconds: number,
      ) =>
        projectionStore.apply({
          id: EventId.make(`event:provider-goal:${suffix}:${seconds}`),
          type: "provider-thread.updated",
          threadId,
          driver,
          occurredAt: DateTime.add(now, { seconds }),
          payload: {
            id: ProviderThreadId.make(`provider-thread:provider-goal:${suffix}`),
            driver,
            providerInstanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            goal,
            createdAt: now,
            updatedAt: DateTime.add(now, { seconds }),
          },
        });
      const shellGoal = Effect.map(
        projectionStore.getShellSnapshot(),
        (snapshot) => snapshot.threads.find((thread) => thread.id === threadId)?.goal,
      );
      const goal = { objective: "Ship it", status: "active" as const, tokensUsed: 10 };

      yield* applyProviderThread("first", goal, 0);
      assert.deepEqual(yield* shellGoal, goal);
      yield* applyProviderThread("second", null, 1);
      assert.isNull(yield* shellGoal);
    }),
  );

  it.effect("reads the shell snapshot first and decodes it in a separate step", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const createThread = (threadId: ThreadId) =>
        projectionStore.apply({
          id: EventId.make(`event:${threadId}:created`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:shell-read"),
            title: "Shell read",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
      const readThreadId = ThreadId.make("thread:shell-read:before");
      const laterThreadId = ThreadId.make("thread:shell-read:after");
      const shellIds = (snapshot: OrchestrationV2ThreadShellSnapshot) =>
        snapshot.threads
          .map((thread) => thread.id)
          .filter((id) => id === readThreadId || id === laterThreadId);

      yield* createThread(readThreadId);
      const decode = yield* sql.withTransaction(projectionStore.readShellSnapshot());
      yield* createThread(laterThreadId);

      assert.deepEqual(shellIds(yield* decode), [readThreadId]);
      assert.sameMembers(shellIds(yield* projectionStore.getShellSnapshot()), [
        readThreadId,
        laterThreadId,
      ]);

      const [stored] = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_threads
        WHERE thread_id = ${laterThreadId}
      `;
      const setPayload = (payload: string) =>
        sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${payload}
          WHERE thread_id = ${laterThreadId}`;
      yield* setPayload("{}");
      const failure = yield* sql
        .withTransaction(projectionStore.readShellSnapshot())
        .pipe(
          Effect.flatMap(Effect.flip),
          Effect.ensuring(Effect.orDie(setPayload(stored!.payload_json))),
        );
      assert.strictEqual(failure._tag, "ProjectionStoreReadError");
    }),
  );

  it.effect("reads only the requested project's threads into a scoped shell snapshot", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const { projectId, activeThreadId, forkThreadId, otherThreadId } =
        yield* assertProjectScopedShells("sql-project-shell");

      const [stored] = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_threads
        WHERE thread_id = ${otherThreadId}
      `;
      const setPayload = (payload: string) =>
        sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${payload}
          WHERE thread_id = ${otherThreadId}`;
      yield* setPayload("{}");
      const [unscoped, scoped] = yield* Effect.all([
        projectionStore.getShellSnapshot().pipe(Effect.flip),
        projectionStore.getShellSnapshot({ projectId, location: "active" }),
      ]).pipe(Effect.ensuring(Effect.orDie(setPayload(stored!.payload_json))));
      assert.strictEqual(unscoped._tag, "ProjectionStoreReadError");
      assert.sameMembers(
        scoped.threads.map((thread) => thread.id),
        [activeThreadId, forkThreadId],
      );
    }),
  );

  it.effect("does not treat visited or marked-unread state as thread activity", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const createdAt = yield* DateTime.now;
      const visitedOccurredAt = DateTime.add(createdAt, { seconds: 1 });
      const markedUnreadOccurredAt = DateTime.add(createdAt, { seconds: 2 });
      const threadId = ThreadId.make("thread:projection-read-state");
      const projectId = ProjectId.make("project:projection-read-state");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Projection read state",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-read-state:created"),
        type: "thread.created",
        threadId,
        occurredAt: createdAt,
        payload: thread,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-read-state:visited"),
        type: "thread.visited",
        threadId,
        occurredAt: visitedOccurredAt,
        payload: { ...thread, lastVisitedAt: createdAt },
      });

      const visited = yield* projectionStore.getThreadProjection(threadId);
      assert.deepEqual(visited.thread.lastVisitedAt, createdAt);
      assert.deepEqual(visited.thread.updatedAt, createdAt);

      yield* projectionStore.apply({
        id: EventId.make("event:projection-read-state:marked-unread"),
        type: "thread.marked-unread",
        threadId,
        occurredAt: markedUnreadOccurredAt,
        payload: thread,
      });

      const markedUnread = yield* projectionStore.getThreadProjection(threadId);
      assert.isNull(markedUnread.thread.lastVisitedAt);
      assert.deepEqual(markedUnread.thread.updatedAt, createdAt);
    }),
  );

  it.effect("dates thread activity by a run event and leaves the rest of the thread alone", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const createdAt = yield* DateTime.now;
      const runOccurredAt = DateTime.add(createdAt, { seconds: 5 });
      const threadId = ThreadId.make("thread:projection-activity");
      const runId = RunId.make("run:projection-activity");
      const rootNodeId = NodeId.make("node:projection-activity");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId: ProjectId.make("project:projection-activity"),
        title: "Projection activity",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: "feature/activity",
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: createdAt,
        deletedAt: null,
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-activity:created"),
        type: "thread.created",
        threadId,
        occurredAt: createdAt,
        payload: thread,
      });
      const created = (yield* projectionStore.getThreadProjection(threadId)).thread;

      const { statements, tracer } = traceSqlStatements();
      yield* projectionStore
        .apply({
          id: EventId.make("event:projection-activity:run-created"),
          type: "run.created",
          threadId,
          runId,
          nodeId: rootNodeId,
          driver,
          providerInstanceId,
          occurredAt: runOccurredAt,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("message:projection-activity"),
            rootNodeId,
            activeAttemptId: null,
            status: "running" as const,
            requestedAt: runOccurredAt,
            startedAt: runOccurredAt,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        })
        .pipe(Effect.withTracer(tracer));
      assert.isEmpty(
        statements.filter(
          (statement) =>
            /^\s*SELECT/i.test(statement) &&
            statement.includes("orchestration_v2_projection_threads"),
        ),
      );

      const active = (yield* projectionStore.getThreadProjection(threadId)).thread;
      assert.deepEqual(active, { ...created, updatedAt: runOccurredAt });
      const shell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (candidate) => candidate.id === threadId,
      );
      assert.deepEqual(shell?.updatedAt, runOccurredAt);
    }),
  );

  it.effect("preserves delegated completion ownership across stale run and task updates", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const later = DateTime.add(now, { seconds: 1 });
      const threadId = ThreadId.make("thread:projection-delegated-completion");
      const projectId = ProjectId.make("project:projection-delegated-completion");
      const runId = RunId.make("run:projection-delegated-completion");
      const rootNodeId = NodeId.make("node:projection-delegated-completion-root");
      const taskId = NodeId.make("node:projection-delegated-completion-task");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Delegated completion projection",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:projection-delegated-completion"),
        rootNodeId,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
        delegatedCompletion: {
          disposition: "stopped" as const,
          nextGeneration: 2,
          delivery: null,
        },
      };
      const task = {
        id: taskId,
        threadId,
        runId,
        parentNodeId: rootNodeId,
        origin: "app_owned" as const,
        createdBy: "agent" as const,
        driver,
        providerInstanceId,
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: null,
        prompt: "Inspect the stop barrier.",
        title: null,
        model: null,
        completionWake: "always" as const,
        completionDelivery: {
          state: "disposed" as const,
          observedByRunId: null,
        },
        status: "running" as const,
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:run"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: run,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:task"),
        type: "subagent.updated",
        threadId,
        runId,
        nodeId: taskId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: task,
      });

      const { delegatedCompletion: _delegatedCompletion, ...staleRun } = run;
      const { completionDelivery: _completionDelivery, ...staleTask } = task;
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:stale-run"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId,
        occurredAt: later,
        payload: { ...staleRun, status: "interrupted", completedAt: later },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:stale-task"),
        type: "subagent.updated",
        threadId,
        runId,
        nodeId: taskId,
        driver,
        providerInstanceId,
        occurredAt: later,
        payload: {
          ...staleTask,
          status: "interrupted",
          completedAt: later,
          updatedAt: later,
        },
      });

      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.deepEqual(projection.runs[0]?.delegatedCompletion, run.delegatedCompletion);
      assert.deepEqual(projection.subagents[0]?.completionDelivery, task.completionDelivery);
    }),
  );

  it.effect("only exposes interruptible runs through the shell activeRunId", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:projection-shell-interruptible");
      const projectId = ProjectId.make("project:projection-shell-interruptible");
      const runId = RunId.make("run:projection-shell-interruptible");
      const rootNodeId = NodeId.make("node:projection-shell-interruptible");
      const run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:projection-shell-interruptible"),
        rootNodeId,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Interruptible shell run",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: threadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:running"),
        type: "run.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: run,
      });

      let shell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.equal(shell?.status, "running");
      assert.equal(shell?.activeRunId, runId);
      assert.equal(
        shell?.latestRunRequestedAt && DateTime.toEpochMillis(shell.latestRunRequestedAt),
        DateTime.toEpochMillis(now),
      );
      assert.equal(
        shell?.latestRunStartedAt && DateTime.toEpochMillis(shell.latestRunStartedAt),
        DateTime.toEpochMillis(now),
      );
      assert.isNull(shell?.latestRunCompletedAt);

      const requestId = RuntimeRequestId.make("request:projection-shell-question");
      for (const [responseCapability, blocking] of [
        [{ type: "message" }, false],
        [{ type: "live", providerSessionId: ProviderSessionId.make("session:question") }, true],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-shell-question:${responseCapability.type}`),
          type: "runtime-request.updated",
          threadId,
          nodeId: rootNodeId,
          driver,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId: rootNodeId,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability,
            createdAt: now,
            resolvedAt: null,
          },
        });
        const projection = yield* projectionStore.getThreadProjection(threadId);
        const sqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
          (row) => row.id === threadId,
        )!;
        for (const questionShell of [
          sqlShell,
          ProjectionStore.threadShellFromProjection(projection),
        ]) {
          assert.equal(questionShell.activeRunId, runId);
          assert.deepEqual(questionShell.pendingRuntimeRequest, {
            id: requestId,
            kind: "user_input",
            createdAt: now,
            blocking,
          });
        }
      }

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:waiting"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: { ...run, status: "waiting" },
      });

      shell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.equal(shell?.status, "waiting");
      assert.isNull(shell?.activeRunId);
      const later = DateTime.add(now, { hours: 1 });
      for (const status of ["queued", "cancelled"] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:clock:newer:${status}`),
          type: "run.updated",
          threadId,
          occurredAt: later,
          payload: {
            ...run,
            id: RunId.make("run:clock:newer"),
            ordinal: 2,
            status,
            requestedAt: later,
            startedAt: null,
            completedAt: status === "cancelled" ? later : null,
          },
        });
        for (const activityStatus of ["preparing", "running", "waiting", "completed"] as const) {
          yield* projectionStore.apply({
            id: EventId.make(`event:clock:${status}:${activityStatus}`),
            type: "run.updated",
            threadId,
            occurredAt: later,
            payload: {
              ...run,
              status: activityStatus,
              startedAt: activityStatus === "preparing" ? null : now,
              completedAt: activityStatus === "completed" ? later : null,
            },
          });
          const projection = yield* projectionStore.getThreadProjection(threadId);
          const sqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
            (row) => row.id === threadId,
          )!;
          const memoryShell = ProjectionStore.threadShellFromProjection(projection);
          const expected = activityStatus === "completed" ? null : DateTime.toEpochMillis(now);
          const timestamp = (value: DateTime.Utc | null | undefined) =>
            value == null ? null : DateTime.toEpochMillis(value);
          assert.equal(timestamp(sqlShell.activityRunStartedAt), expected);
          assert.equal(timestamp(memoryShell.activityRunStartedAt), expected);
          assert.equal(sqlShell.latestRunId, "run:clock:newer");
        }
      }

      yield* projectionStore.apply({
        id: EventId.make("event:clock:newer:held"),
        type: "run.updated",
        threadId,
        occurredAt: later,
        payload: {
          ...run,
          id: RunId.make("run:clock:newer"),
          ordinal: 2,
          status: "queued",
          queueHeld: true,
          requestedAt: later,
          startedAt: null,
          completedAt: null,
        },
      });
      const heldProjection = yield* projectionStore.getThreadProjection(threadId);
      const heldSqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (row) => row.id === threadId,
      )!;
      for (const heldShell of [
        heldSqlShell,
        ProjectionStore.threadShellFromProjection(heldProjection),
      ]) {
        assert.equal(heldShell.latestRunId, runId);
        assert.equal(heldShell.status, "completed");
      }

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:held-first"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: later,
        payload: { ...run, status: "queued", queueHeld: true, startedAt: null, completedAt: null },
      });
      const onlyHeldProjection = yield* projectionStore.getThreadProjection(threadId);
      const onlyHeldSqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (row) => row.id === threadId,
      )!;
      for (const onlyHeldShell of [
        onlyHeldSqlShell,
        ProjectionStore.threadShellFromProjection(onlyHeldProjection),
      ]) {
        assert.isNull(onlyHeldShell.latestRunId);
        assert.equal(onlyHeldShell.status, "idle");
      }

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:wake"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: later,
        payload: {
          ...run,
          status: "running",
          requestedAt: later,
          startedAt: later,
          workStartedAt: now,
        },
      });
      const wakeProjection = yield* projectionStore.getThreadProjection(threadId);
      const wakeSqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (row) => row.id === threadId,
      )!;
      for (const wakeShell of [
        wakeSqlShell,
        ProjectionStore.threadShellFromProjection(wakeProjection),
      ]) {
        assert.equal(
          wakeShell.activityRunStartedAt && DateTime.toEpochMillis(wakeShell.activityRunStartedAt),
          DateTime.toEpochMillis(now),
        );
      }
    }),
  );

  it.effect("selects only threads with runtime state that needs recovery", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const settledThreadId = ThreadId.make("thread:recovery-candidates:settled");
      const runningThreadId = ThreadId.make("thread:recovery-candidates:running");
      const memberThreadId = ThreadId.make("thread:recovery-candidates:member");
      const childThreadId = ThreadId.make("thread:recovery-candidates:child");
      const rolledBackThreadId = yield* addRolledBackRecoveryCandidate("recovery-candidates");
      const orphanedThreadId = yield* addOrphanedRecoveryCandidate("recovery-candidates");
      const projectId = ProjectId.make("project:recovery-candidates");
      const makeThread = (threadId: ThreadId) => ({
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Recovery candidate",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      });

      for (const threadId of [settledThreadId, runningThreadId, memberThreadId, childThreadId]) {
        yield* projectionStore.apply({
          id: EventId.make(`event:recovery-candidates:${threadId}:created`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: makeThread(threadId),
        });
      }

      const runId = RunId.make("run:recovery-candidates:running");
      const rootNodeId = NodeId.make("node:recovery-candidates:running");
      yield* projectionStore.apply({
        id: EventId.make("event:recovery-candidates:run-created"),
        type: "run.created",
        threadId: runningThreadId,
        runId,
        nodeId: rootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId: runningThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:recovery-candidates:running"),
          rootNodeId,
          activeAttemptId: null,
          status: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });

      const memberId = NodeId.make("node:recovery-candidates:member");
      const childRootNodeId = NodeId.make("node:recovery-candidates:child-root");
      const nativeTaskRef = { driver, nativeId: "workflow:agent:1", strength: "strong" as const };
      const memberNode = {
        id: memberId,
        threadId: memberThreadId,
        runId: null,
        parentNodeId: NodeId.make("node:recovery-candidates:coordinator-root"),
        rootNodeId: NodeId.make("node:recovery-candidates:coordinator-root"),
        kind: "subagent" as const,
        status: "running" as const,
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: nativeTaskRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:recovery-candidates:member"),
        type: "subagent.updated",
        threadId: memberThreadId,
        nodeId: memberId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: memberId,
          threadId: memberThreadId,
          runId: null,
          parentNodeId: memberNode.parentNodeId,
          origin: "provider_native",
          createdBy: "agent",
          driver,
          providerInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef,
          prompt: "Do the work",
          title: "Member",
          model: null,
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      });
      for (const [threadId, node] of [
        [memberThreadId, memberNode],
        [
          childThreadId,
          {
            ...memberNode,
            id: childRootNodeId,
            threadId: childThreadId,
            parentNodeId: null,
            rootNodeId: childRootNodeId,
            kind: "root_turn" as const,
          },
        ],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:recovery-candidates:node:${node.id}`),
          type: "node.updated",
          threadId,
          nodeId: node.id,
          driver,
          occurredAt: now,
          payload: node,
        });
      }

      const { statements, tracer } = traceSqlStatements();
      const recoveryThreadIds = yield* projectionStore
        .getRecoveryThreadIds("runtime")
        .pipe(Effect.withTracer(tracer));
      const recoveryStatement = statements.find((statement) =>
        statement.includes("WITH pending_provider_threads"),
      );
      assert.isDefined(recoveryStatement);
      const recoveryPlan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${recoveryStatement}`,
      );
      assert.include(
        recoveryPlan.map((row) => row.detail).join("\n"),
        "orchestration_v2_projection_nodes_live_idx",
      );
      assert.notMatch(recoveryPlan.map((row) => row.detail).join("\n"), /ardud_|SCAN cold/);
      assert.include(recoveryThreadIds, runningThreadId);
      assert.include(recoveryThreadIds, orphanedThreadId);
      assert.include(recoveryThreadIds, memberThreadId);
      assert.include(recoveryThreadIds, childThreadId);
      assert.notInclude(recoveryThreadIds, settledThreadId);
      assert.notInclude(recoveryThreadIds, rolledBackThreadId);
      const shellStatements = traceSqlStatements();
      yield* projectionStore.getShellSnapshot().pipe(Effect.withTracer(shellStatements.tracer));
      const pendingStatement = shellStatements.statements.find((statement) =>
        statement.includes("AS owning_provider_instance_id"),
      );
      assert.isDefined(pendingStatement);
      const pendingPlan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${pendingStatement}`,
      );
      const pendingDetails = pendingPlan.map((row) => row.detail).join("\n");
      assert.notMatch(pendingDetails, /ardud_|SCAN cold/);
      assert.include(pendingDetails, "orchestration_v2_projection_turn_items_shell_pending_idx");
      const memberRecovery = yield* projectionStore.getRuntimeRecoveryProjection(memberThreadId);
      const childRecovery = yield* projectionStore.getRuntimeRecoveryProjection(childThreadId);
      assert.deepEqual(
        memberRecovery.subagents.map((subagent) => subagent.id),
        [memberId],
      );
      assert.deepEqual(
        memberRecovery.nodes.map((node) => node.id),
        [memberId],
      );
      assert.deepEqual(
        childRecovery.nodes.map((node) => node.id),
        [childRootNodeId],
      );
      yield* projectionStore.apply({
        id: EventId.make("event:recovery-candidates:member-cancelled"),
        type: "subagent.updated",
        threadId: memberThreadId,
        nodeId: memberId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          ...memberRecovery.subagents[0]!,
          status: "cancelled",
          completedAt: now,
          updatedAt: now,
        },
      });
      assert.include(yield* projectionStore.getRecoveryThreadIds("runtime"), childThreadId);
    }),
  );

  it.effect("projects only the latest failed root turn's limit into SQL and memory shells", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("limit-shell");
      const otherThreadId = yield* addRolledBackRecoveryCandidate("other-limit-shell");
      const original = (yield* store.getThreadProjection(threadId)).runs[0]!;
      const now = yield* DateTime.now;
      const limitItem = {
        id: TurnItemId.make("limit-shell:error"),
        threadId,
        runId: original.id,
        nodeId: original.rootNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 2,
        status: "failed" as const,
        title: "Usage limit reached",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "error" as const,
        failure: {
          class: "usage_limit" as const,
          message: "Plan limit reached.",
          resetAt: "2099-01-01T00:00:00.000Z",
          code: "usageLimitExceeded",
          retryable: null,
        },
      };
      const applyRun = (status: typeof original.status, rootNodeId = original.rootNodeId) =>
        store.apply({
          id: EventId.make(`event:limit-shell:run:${status}:${rootNodeId}`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...original, rootNodeId, status },
        });
      const assertSummary = Effect.fnUntraced(function* (
        lastError: string | null,
        lastErrorClass: string | null,
      ) {
        const projection = yield* store.getThreadProjection(threadId);
        const memoryShell = ProjectionStore.threadShellFromProjection(projection);
        const shells = yield* store.getShellSnapshot();
        const sqlShell = shells.threads.find((row) => row.id === threadId)!;
        for (const shell of [memoryShell, sqlShell]) {
          assert.equal(shell.lastError, lastError);
          assert.equal(shell.lastErrorClass, lastErrorClass);
          assert.equal(
            shell.usageLimitResetAt,
            lastErrorClass === "usage_limit" ? "2099-01-01T00:00:00.000Z" : null,
          );
        }
        assert.isNull(shells.threads.find((row) => row.id === otherThreadId)!.lastErrorClass);
        const candidates = yield* store.getLimitRecoveryCandidates({
          now,
          autoResume: true,
          snooze: false,
        });
        const candidate = candidates.find((row) => row.id === threadId);
        if (lastErrorClass === "usage_limit") {
          assert.deepEqual(candidate, {
            id: sqlShell.id,
            status: sqlShell.status,
            lastErrorClass: sqlShell.lastErrorClass,
            usageLimitResetAt: sqlShell.usageLimitResetAt,
            latestRunId: sqlShell.latestRunId,
            latestRunCompletedAt: sqlShell.latestRunCompletedAt,
            updatedAt: sqlShell.updatedAt,
            archivedAt: sqlShell.archivedAt,
            settledOverride: sqlShell.settledOverride,
            pendingRuntimeRequest: null,
            limitRecovery: sqlShell.limitRecovery,
            snoozedUntil: sqlShell.snoozedUntil,
          });
        } else assert.isUndefined(candidate);
        assert.isUndefined(candidates.find((row) => row.id === otherThreadId));
      });
      yield* store.apply({
        id: EventId.make("event:limit-shell:error"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: limitItem,
      });
      yield* applyRun("failed");
      yield* assertSummary("Plan limit reached.", "usage_limit");
      const queuedRunId = RunId.make("run:limit-shell:queued");
      yield* store.apply({
        id: EventId.make("event:limit-shell:queued"),
        type: "run.created",
        threadId,
        runId: queuedRunId,
        nodeId: NodeId.make("node:limit-shell:queued"),
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          ...original,
          id: queuedRunId,
          ordinal: original.ordinal + 1,
          rootNodeId: NodeId.make("node:limit-shell:queued"),
          userMessageId: MessageId.make("message:limit-shell:queued"),
          status: "queued",
          startedAt: null,
          completedAt: null,
        },
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      const queuedProjection = yield* store.getThreadProjection(threadId);
      const queuedMemoryShell = ProjectionStore.threadShellFromProjection(queuedProjection);
      const queuedSqlShell = (yield* store.getShellSnapshot()).threads.find(
        (row) => row.id === threadId,
      )!;
      assert.equal(queuedMemoryShell.status, "failed");
      assert.equal(queuedMemoryShell.latestRunId, original.id);
      assert.equal(queuedSqlShell.status, "failed");
      assert.equal(queuedSqlShell.latestRunId, original.id);
      assert.equal(queuedProjection.runs.find((run) => run.id === queuedRunId)?.status, "queued");
      const cancelledRunId = RunId.make("run:limit-shell:cancelled-queued");
      yield* store.apply({
        id: EventId.make("event:limit-shell:cancelled-queued"),
        type: "run.created",
        threadId,
        runId: cancelledRunId,
        nodeId: NodeId.make("node:limit-shell:cancelled-queued"),
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          ...original,
          id: cancelledRunId,
          ordinal: original.ordinal + 2,
          rootNodeId: NodeId.make("node:limit-shell:cancelled-queued"),
          userMessageId: MessageId.make("message:limit-shell:cancelled-queued"),
          status: "cancelled",
          startedAt: null,
          completedAt: now,
        },
      });
      yield* store.apply({
        id: EventId.make("event:limit-shell:cancelled-queued-message"),
        type: "turn-item.updated",
        threadId,
        runId: cancelledRunId,
        nodeId: NodeId.make("node:limit-shell:cancelled-queued"),
        driver,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: TurnItemId.make("limit-shell:cancelled-queued-message"),
          threadId,
          runId: cancelledRunId,
          nodeId: NodeId.make("node:limit-shell:cancelled-queued"),
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 3,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          messageId: MessageId.make("message:limit-shell:cancelled-queued"),
          inputIntent: "turn_start",
          text: "cancelled before the provider started",
          attachments: [],
        },
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      const aheadRunId = RunId.make("run:limit-shell:ran-ahead");
      yield* store.apply({
        id: EventId.make("event:limit-shell:ran-ahead"),
        type: "run.created",
        threadId,
        runId: aheadRunId,
        nodeId: NodeId.make("node:limit-shell:ran-ahead"),
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          ...original,
          id: aheadRunId,
          ordinal: original.ordinal + 3,
          rootNodeId: NodeId.make("node:limit-shell:ran-ahead"),
          userMessageId: MessageId.make("message:limit-shell:ran-ahead"),
          status: "completed",
          startedAt: DateTime.subtract(now, { minutes: 10 }),
          completedAt: DateTime.subtract(now, { minutes: 5 }),
        },
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id = ${aheadRunId}`;
      yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id = ${queuedRunId}`;
      yield* assertSummary("Plan limit reached.", "usage_limit");
      yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id = ${cancelledRunId}`;
      const [originalRow] = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
      for (const [field, value] of [
        ["archivedAt", DateTime.formatIso(now)],
        ["settledOverride", "settled"],
      ]) {
        yield* sql`UPDATE orchestration_v2_projection_threads
          SET payload_json = json_set(payload_json, ${`$.${field}`}, ${value})
          WHERE thread_id = ${threadId}`;
        assert.isUndefined(
          (yield* store.getLimitRecoveryCandidates({ now, autoResume: true, snooze: false })).find(
            (row) => row.id === threadId,
          ),
        );
        yield* sql`UPDATE orchestration_v2_projection_threads
          SET payload_json = ${originalRow!.payload_json} WHERE thread_id = ${threadId}`;
      }
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = ${DateTime.formatIso(now)} WHERE thread_id = ${threadId}`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ now, autoResume: true, snooze: false })).find(
          (row) => row.id === threadId,
        ),
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = NULL WHERE thread_id = ${threadId}`;
      const recoveryOptions = { now, autoResume: false, snooze: false };
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates(recoveryOptions)).find(
          (row) => row.id === threadId,
        ),
      );
      const reset = DateTime.makeUnsafe(limitItem.failure.resetAt);
      const recovery = {
        runId: original.id,
        resetAt: limitItem.failure.resetAt,
        autoResume: true,
        requestId: CommandId.make("recovery:choice"),
      };
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.limitRecovery', json(${encodeUnknownJsonString(recovery)}))
        WHERE thread_id = ${threadId}`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ ...recoveryOptions, autoResume: true })).find(
          (row) => row.id === threadId,
        ),
      );
      const due = (yield* store.getLimitRecoveryCandidates({
        ...recoveryOptions,
        now: reset,
      })).find((row) => row.id === threadId)!;
      assert.deepEqual(due.limitRecovery, recovery);
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
        (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
        VALUES ('limit-shell:pending-request', ${threadId}, ${original.rootNodeId}, 'approval', 'pending', ${DateTime.formatIso(now)}, '{}')`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ ...recoveryOptions, now: reset })).find(
          (row) => row.id === threadId,
        ),
      );
      yield* sql`DELETE FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id = 'limit-shell:pending-request'`;
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.snoozedUntil', ${DateTime.formatIso(DateTime.add(reset, { minutes: 1 }))})
        WHERE thread_id = ${threadId}`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ ...recoveryOptions, now: reset })).find(
          (row) => row.id === threadId,
        ),
      );
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.snoozedUntil', NULL, '$.limitRecovery.autoResume', json('false'))
        WHERE thread_id = ${threadId}`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({
          ...recoveryOptions,
          now: reset,
          autoResume: true,
        })).find((row) => row.id === threadId),
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${originalRow!.payload_json} WHERE thread_id = ${threadId}`;
      const session = {
        id: ProviderSessionId.make("session:limit-shell:shared"),
        driver,
        providerInstanceId,
        status: "ready" as const,
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      for (const boundThreadId of [threadId, otherThreadId]) {
        yield* store.apply({
          id: EventId.make(`event:limit-shell:bind:${boundThreadId}`),
          type: "provider-session.attached",
          threadId: boundThreadId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: session,
        });
      }
      assert.notInclude(yield* store.getRecoveryThreadIds("runtime"), otherThreadId);
      assert.include(
        (yield* store.getLiveSharedProviderSessions()).map(({ session }) => session.id),
        session.id,
      );
      yield* assertSummary("Plan limit reached.", "usage_limit");
      yield* store.apply({
        id: EventId.make("event:limit-shell:session-failed"),
        type: "provider-session.updated",
        threadId,
        occurredAt: now,
        payload: { ...session, status: "error", lastError: "Provider process exited." },
      });
      yield* assertSummary("Provider process exited.", null);
      yield* store.apply({
        id: EventId.make("event:limit-shell:session-recovered"),
        type: "provider-session.updated",
        threadId,
        occurredAt: now,
        payload: session,
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      yield* store.apply({
        id: EventId.make("event:limit-shell:child-error"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...limitItem,
          id: TurnItemId.make("limit-shell:child-error"),
          nodeId: NodeId.make("child-node"),
          ordinal: 3,
          failure: { ...limitItem.failure, class: "provider_error", message: "Child failed." },
        },
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      yield* store.apply({
        id: EventId.make("event:limit-shell:replacement"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...limitItem,
          id: TurnItemId.make("limit-shell:replacement"),
          ordinal: 4,
          failure: { ...limitItem.failure, class: "provider_error", message: "Provider failed." },
        },
      });
      yield* assertSummary("Provider failed.", "provider_error");
      for (const status of [
        "running",
        "completed",
        "interrupted",
        "cancelled",
        "rolled_back",
      ] as const) {
        yield* applyRun(status);
        yield* assertSummary(null, null);
      }
      yield* applyRun("failed", NodeId.make("new-attempt-root"));
      yield* assertSummary(null, null);
    }),
  );

  it.effect("projects one shared provider session into multiple thread bindings", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:projection-shared-provider-session");
      const firstThreadId = ThreadId.make("thread:projection-shared-provider-session:first");
      const secondThreadId = ThreadId.make("thread:projection-shared-provider-session:second");
      const providerSessionId = ProviderSessionId.make(
        "provider-session:projection-shared-provider-session",
      );
      const makeThread = (threadId: ThreadId) => ({
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Shared provider session",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      });
      const session = {
        id: providerSessionId,
        driver,
        providerInstanceId,
        status: "error" as const,
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: "provider process exited",
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shared-provider-session:first-thread"),
        type: "thread.created",
        threadId: firstThreadId,
        occurredAt: now,
        payload: makeThread(firstThreadId),
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-shared-provider-session:second-thread"),
        type: "thread.created",
        threadId: secondThreadId,
        occurredAt: now,
        payload: makeThread(secondThreadId),
      });
      for (const [threadId, suffix] of [
        [firstThreadId, "first"],
        [secondThreadId, "second"],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-shared-provider-session:${suffix}-binding`),
          type: "provider-session.attached",
          threadId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: session,
        });
      }

      assert.deepEqual(
        (yield* projectionStore.getThreadProjection(firstThreadId)).providerSessions.map(
          (value) => value.id,
        ),
        [providerSessionId],
      );
      assert.deepEqual(
        (yield* projectionStore.getThreadProjection(secondThreadId)).providerSessions.map(
          (value) => value.id,
        ),
        [providerSessionId],
      );
      assert.deepEqual(
        (yield* projectionStore.getShellSnapshot()).threads
          .filter((thread) => thread.id === firstThreadId || thread.id === secondThreadId)
          .map((thread) => ({
            id: thread.id,
            lastError: thread.lastError,
          })),
        [
          { id: firstThreadId, lastError: "provider process exited" },
          { id: secondThreadId, lastError: "provider process exited" },
        ],
      );

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shared-provider-session:first-detached"),
        type: "provider-session.detached",
        threadId: firstThreadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: { providerSessionId, detachedAt: now },
      });

      assert.lengthOf(
        (yield* projectionStore.getThreadProjection(firstThreadId)).providerSessions,
        0,
      );
      assert.lengthOf(
        (yield* projectionStore.getThreadProjection(secondThreadId)).providerSessions,
        1,
      );
    }),
  );

  it.effect.each(["hot", "cold", "base"] as const)(
    "looks up a thread's last %s provider error through its own session bindings",
    (storage) =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const later = DateTime.add(now, { minutes: 1 });
        const projectId = ProjectId.make("project:projection-session-error-lookup");
        const attachErroredSession = Effect.fnUntraced(function* (
          name: string,
          lastError: string,
          updatedAt: DateTime.Utc,
        ) {
          const threadId = ThreadId.make(
            `thread:projection-session-error-lookup:${storage}:${name}`,
          );
          yield* projectionStore.apply({
            id: EventId.make(`event:projection-session-error-lookup:${name}:thread`),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: {
              createdBy: "user",
              creationSource: "web",
              id: threadId,
              projectId,
              title: name,
              providerInstanceId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: null,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          });
          yield* projectionStore.apply({
            id: EventId.make(`event:projection-session-error-lookup:${name}:session`),
            type: "provider-session.attached",
            threadId,
            driver,
            providerInstanceId,
            occurredAt: updatedAt,
            payload: {
              id: ProviderSessionId.make(
                `provider-session:projection-session-error-lookup:${storage}:${name}`,
              ),
              driver,
              providerInstanceId,
              status: "error",
              cwd: "/workspace",
              model: modelSelection.model,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: updatedAt,
              updatedAt,
              lastError,
            },
          });
          return threadId;
        });

        const failure = {
          class: "usage_limit" as const,
          message: "Plan limit reached.",
          resetAt: "2099-01-01T00:00:00.000Z",
          code: "usageLimitExceeded",
          retryable: null,
        };
        const threadId = yield* attachErroredSession("own", failure.message, now);
        const runId = RunId.make(`run:projection-session-error-lookup:${storage}:own`);
        const rootNodeId = NodeId.make(`node:projection-session-error-lookup:${storage}:own`);
        yield* projectionStore.apply({
          id: EventId.make("event:projection-session-error-lookup:own:run"),
          type: "run.created",
          threadId,
          runId,
          nodeId: rootNodeId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("message:projection-session-error-lookup:own"),
            rootNodeId,
            activeAttemptId: null,
            status: "failed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make("event:projection-session-error-lookup:own:error"),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`projection-session-error-lookup:${storage}:own:error`),
            threadId,
            runId,
            nodeId: rootNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "failed",
            title: "Usage limit reached",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "error",
            failure,
          },
        });
        for (let index = 0; index < 24; index++) {
          yield* attachErroredSession(`other-${index}`, "other session failed", later);
        }

        if (storage !== "hot") yield* archiveTurnItems(threadId, Number.MAX_SAFE_INTEGER, storage);

        const { statements, tracer } = traceSqlStatements();
        const shell = yield* projectionStore.getShellSnapshot().pipe(Effect.withTracer(tracer));
        assert.equal(
          shell.threads.find((thread) => thread.id === threadId)?.lastError,
          failure.message,
        );
        const candidates = yield* projectionStore
          .getLimitRecoveryCandidates({ now, autoResume: true, snooze: false })
          .pipe(Effect.withTracer(tracer));
        const candidate = candidates.find((row) => row.id === threadId);
        assert.isDefined(candidate);
        assert.include(candidate, {
          status: "failed",
          lastErrorClass: "usage_limit",
          usageLimitResetAt: failure.resetAt,
          latestRunId: runId,
        });

        for (const marker of ["AS blocking_failure_payload_json", "AS failure_payload_json"]) {
          const statement = statements.find((query) => query.includes(marker));
          assert.isDefined(statement, marker);
          const plan = (yield* sql.unsafe<{ readonly detail: string }>(
            `EXPLAIN QUERY PLAN ${statement}`,
          )).map((row) => row.detail);
          const bindingLookup = plan.findIndex((detail) => detail.startsWith("SEARCH binding "));
          const sessionLookup = plan.findIndex((detail) => detail.startsWith("SEARCH session "));
          assert.isAtLeast(bindingLookup, 0, marker);
          assert.include(
            plan[bindingLookup],
            "orchestration_v2_projection_provider_session_bindings_thread_idx (thread_id=?)",
          );
          assert.isAbove(sessionLookup, bindingLookup, marker);
          assert.include(plan[sessionLookup], "(provider_session_id=?)");
          const errorLookups = plan.filter(
            (detail) =>
              /^SEARCH (?:item|error) /.test(detail) && !detail.includes("(turn_item_id=?)"),
          );
          assert.lengthOf(errorLookups, marker.includes("blocking") ? 6 : 3, marker);
          for (const errorLookup of errorLookups) {
            assert.include(errorLookup, "turn_items_failed_error_idx");
            assert.include(errorLookup, "(thread_id=? AND run_id=? AND node_id=?)");
          }
          assert.notMatch(plan.join("\n"), /SEARCH (?:item|error) USING AUTOMATIC/);
          if (marker.includes("blocking")) {
            assert.isTrue(
              plan.some((detail) => detail.includes("SEARCH i USING PRIMARY KEY (thread_id=?")),
            );
            assert.notMatch(
              plan.join("\n"),
              /SCAN (?:main\.orchestration_v2_projection_turn_items|cold|base)\b/,
            );
          }
        }
      }),
  );

  it.effect(
    "reads checkpoint context without decoding transcript or checkpoint file payloads",
    () =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const memoryStore = yield* ProjectionStore.ProjectionStoreV2.pipe(
          Effect.provide(ProjectionStore.layerMemory),
        );
        const apply = (event: Parameters<typeof projectionStore.apply>[0]) =>
          Effect.all([projectionStore.apply(event), memoryStore.apply(event)]);
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:checkpoint-context");
        const runId = RunId.make("run:checkpoint-context");
        const nodeId = NodeId.make("node:checkpoint-context");
        const scopeId = CheckpointScopeId.make("scope:checkpoint-context");
        const checkpointId = CheckpointId.make("checkpoint:checkpoint-context");
        const ref = CheckpointRef.make("refs/t3/checkpoint-context/1");
        yield* apply({
          id: EventId.make("event:checkpoint-context:thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:checkpoint-context"),
            title: "Checkpoint context",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "feature",
            worktreePath: "/repo/worktree",
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
        yield* apply({
          id: EventId.make("event:checkpoint-context:run"),
          type: "run.created",
          threadId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("message:checkpoint-context"),
            rootNodeId: nodeId,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId,
            contextHandoffId: null,
          },
        });
        yield* apply({
          id: EventId.make("event:checkpoint-context:scope"),
          type: "checkpoint-scope.created",
          threadId,
          occurredAt: now,
          payload: {
            id: scopeId,
            threadId,
            runId,
            nodeId,
            parentScopeId: null,
            providerThreadId: null,
            kind: "root_run",
            ordinalWithinParent: 0,
            advancesAppRunCount: true,
            cwd: "/repo/worktree",
            createdAt: now,
          },
        });
        yield* apply({
          id: EventId.make("event:checkpoint-context:checkpoint"),
          type: "checkpoint.captured",
          threadId,
          occurredAt: now,
          payload: {
            id: checkpointId,
            threadId,
            scopeId,
            runId,
            nodeId,
            parentCheckpointId: null,
            ordinalWithinScope: 1,
            appRunOrdinal: 1,
            ref,
            status: "ready",
            files: [],
            capturedAt: now,
          },
        });
        yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          'turn-item:checkpoint-context:obsolete', ${threadId}, ${runId}, ${nodeId}, NULL, NULL,
          NULL, 1, 'assistant_message', 'completed', ${DateTime.formatIso(now)},
          ${encodeUnknownJsonString({ obsolete: "transcript shape" })}
        )
      `;
        assert.strictEqual(
          (yield* Effect.exit(projectionStore.getThreadProjection(threadId)))._tag,
          "Failure",
        );
        yield* sql`
        UPDATE orchestration_v2_projection_checkpoints
        SET payload_json = json_set(payload_json, '$.files', 'obsolete file summary')
        WHERE checkpoint_id = ${checkpointId}
      `;
        for (const store of [projectionStore, memoryStore]) {
          assert.deepEqual(yield* store.getCheckpointContext(threadId), {
            runs: [{ id: runId, ordinal: 1, status: "completed" }],
            checkpointScopes: [{ id: scopeId, runId, kind: "root_run", cwd: "/repo/worktree" }],
            checkpoints: [
              { scopeId, runId, ordinalWithinScope: 1, appRunOrdinal: 1, status: "ready", ref },
            ],
          });
          const missing = yield* store
            .getCheckpointContext(ThreadId.make("thread:checkpoint-context:missing"))
            .pipe(Effect.flip);
          assert.instanceOf(missing, ProjectionStore.ProjectionStoreThreadNotFoundError);
        }
      }),
  );

  it.effect("selects the latest waiting secret only from active runs", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const suffix = "shell-pending-secret";
      const threadId = yield* addRolledBackRecoveryCandidate(suffix);
      const runId = RunId.make(`run:${suffix}:rolled-back`);
      const nodeId = NodeId.make(`node:${suffix}:rolled-back`);
      const now = yield* DateTime.now;
      const addSecret = (id: string, ordinal: number, status: "waiting" | "completed") =>
        projectionStore.apply({
          id: EventId.make(`event:${id}`),
          type: "turn-item.updated",
          threadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(id),
            threadId,
            runId,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status,
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: DateTime.add(now, { seconds: ordinal }),
            type: "secret_request",
            label: "Test credential",
            reason: "Test pending input",
            secretStatus: status === "waiting" ? "pending" : "saved",
          },
        });
      yield* addSecret("secret:a", 2, "waiting");
      yield* addSecret("secret:b", 3, "waiting");
      yield* addSecret("secret:c", 4, "completed");

      yield* sql`
        UPDATE orchestration_v2_projection_runs
        SET status = 'running', payload_json = json_set(payload_json, '$.status', 'running')
        WHERE run_id = ${runId}
      `;
      const secretOnlyShell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      const secretOnlyProjection = yield* projectionStore.getThreadProjection(threadId);
      for (const shell of [
        secretOnlyShell,
        ProjectionStore.threadShellFromProjection(secretOnlyProjection),
      ]) {
        assert.equal(shell?.pendingRuntimeRequest?.id, "secret:b");
        assert.isTrue(shell?.pendingRuntimeRequest?.blocking);
      }

      const requestId = RuntimeRequestId.make(`request:${suffix}:async`);
      yield* projectionStore.apply({
        id: EventId.make(`event:${suffix}:async`),
        type: "runtime-request.updated",
        threadId,
        runId,
        nodeId,
        driver,
        occurredAt: now,
        payload: {
          id: requestId,
          nodeId,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: DateTime.subtract(now, { seconds: 1 }),
          resolvedAt: null,
        },
      });

      for (const status of [
        "preparing",
        "starting",
        "running",
        "waiting",
        "completed",
        "rolled_back",
      ]) {
        yield* sql`
          UPDATE orchestration_v2_projection_runs
          SET status = ${status}, payload_json = json_set(payload_json, '$.status', ${status})
          WHERE run_id = ${runId}
        `;
        const shell = yield* projectionStore.getShellSnapshot();
        const thread = shell.threads.find((candidate) => candidate.id === threadId);
        assert.isDefined(thread);
        const projection = yield* projectionStore.getThreadProjection(threadId);
        const memoryShell = ProjectionStore.threadShellFromProjection(projection);
        const terminal = status === "completed" || status === "rolled_back";
        assert.deepEqual(
          [thread?.pendingRuntimeRequest?.id, memoryShell.pendingRuntimeRequest?.id],
          terminal ? [requestId, requestId] : ["secret:b", "secret:b"],
        );
        assert.deepEqual(
          [thread?.pendingRuntimeRequest?.blocking, memoryShell.pendingRuntimeRequest?.blocking],
          terminal ? [false, false] : [true, true],
        );
      }
    }),
  );

  it.effect("builds shell snapshots without decoding full turn item payloads", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:projection-shell-stale-item");
      const projectId = ProjectId.make("project:projection-shell");

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-thread-created"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Projection shell",
          providerInstanceId,
          modelSelection: modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: threadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });

      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id,
          thread_id,
          run_id,
          node_id,
          provider_thread_id,
          provider_turn_id,
          parent_item_id,
          ordinal,
          type,
          status,
          updated_at,
          payload_json
        )
        VALUES (
          ${"turn-item:stale-user-message"},
          ${threadId},
          ${null},
          ${null},
          ${null},
          ${null},
          ${null},
          ${0},
          ${"user_message"},
          ${"completed"},
          ${nowIso},
          ${encodeUnknownJsonString({
            id: "turn-item:stale-user-message",
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
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "user_message",
            messageId: "message:stale-user-message",
            text: "stale user message",
            attachments: [],
          })}
        )
      `;

      const shell = yield* projectionStore.getShellSnapshot();
      const fullProjectionExit = yield* Effect.exit(projectionStore.getThreadProjection(threadId));

      assert.deepEqual(
        shell.threads
          .filter((thread) => thread.id === threadId)
          .map((thread) => ({
            id: thread.id,
            itemCount: thread.itemCount,
            visibleItemCount: thread.visibleItemCount,
            status: thread.status,
          })),
        [
          {
            id: threadId,
            itemCount: 1,
            visibleItemCount: 1,
            status: "idle",
          },
        ],
      );
      assert.equal(fullProjectionExit._tag, "Failure");
    }),
  );

  it.effect("counts imported runless history inherited by fork shells", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:projection-imported-fork-shell");
      const sourceThreadId = ThreadId.make("thread:projection-imported-fork-shell:source");
      const targetThreadId = ThreadId.make("thread:projection-imported-fork-shell:target");
      const sourceRunId = RunId.make("run:projection-imported-fork-shell:source");
      const rootNodeId = NodeId.make("node:projection-imported-fork-shell:source");

      yield* projectionStore.apply({
        id: EventId.make("event:projection-imported-fork-shell:source-thread"),
        type: "thread.created",
        threadId: sourceThreadId,
        occurredAt: now,
        payload: {
          createdBy: "system",
          creationSource: "server",
          id: sourceThreadId,
          projectId,
          title: "Imported fork source",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          historyOrigin: "v1_import",
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: sourceThreadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-imported-fork-shell:target-thread"),
        type: "thread.created",
        threadId: targetThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: targetThreadId,
          projectId,
          title: "Imported fork target",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: sourceThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: {
            type: "run",
            threadId: sourceThreadId,
            runId: sourceRunId,
          },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-imported-fork-shell:source-run"),
        type: "run.created",
        threadId: sourceThreadId,
        runId: sourceRunId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: sourceRunId,
          threadId: sourceThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:projection-imported-fork-shell:run"),
          rootNodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });

      const applyAssistantItem = (suffix: string, runId: RunId | null, ordinal: number) =>
        projectionStore.apply({
          id: EventId.make(`event:projection-imported-fork-shell:item:${suffix}`),
          type: "turn-item.updated",
          threadId: sourceThreadId,
          ...(runId === null ? {} : { runId }),
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`turn-item:projection-imported-fork-shell:${suffix}`),
            threadId: sourceThreadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "assistant_message",
            messageId: MessageId.make(`message:projection-imported-fork-shell:${suffix}`),
            text: suffix,
            streaming: false,
          },
        });

      yield* applyAssistantItem("imported-one", null, 1);
      yield* applyAssistantItem("imported-two", null, 2);
      yield* applyAssistantItem("native-run", sourceRunId, 3);

      const shell = yield* projectionStore.getShellSnapshot();
      const targetShell = shell.threads.find((thread) => thread.id === targetThreadId);
      const targetProjection = yield* projectionStore.getThreadProjection(targetThreadId);

      assert.isDefined(targetShell);
      assert.equal(targetShell.itemCount, 0);
      assert.equal(targetShell.visibleItemCount, 4);
      assert.equal(targetProjection.visibleTurnItems.length, 4);
    }),
  );

  it.effect("removes rolled back runs from the active visible projection", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:projection-rollback-prune");
      const projectId = ProjectId.make("project:projection-rollback-prune");
      const runId = RunId.make("run:projection-rollback-prune");
      const attemptId = RunAttemptId.make("attempt:projection-rollback-prune");
      const rootNodeId = NodeId.make("node:projection-rollback-prune:root");
      const assistantNodeId = NodeId.make("node:projection-rollback-prune:assistant");
      const providerThreadId = ProviderThreadId.make("provider-thread:projection-rollback-prune");
      const providerTurnId = ProviderTurnId.make("provider-turn:projection-rollback-prune");
      const userMessageId = MessageId.make("message:projection-rollback-prune:user");
      const assistantMessageId = MessageId.make("message:projection-rollback-prune:assistant");
      const userTurnItemId = TurnItemId.make("turn-item:projection-rollback-prune:user");
      const assistantTurnItemId = TurnItemId.make("turn-item:projection-rollback-prune:assistant");
      const backgroundTurnItemId = TurnItemId.make(
        "turn-item:projection-rollback-prune:background",
      );

      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:thread-created"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Projection rollback prune",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThreadId,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: threadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:provider-thread"),
        type: "provider-thread.updated",
        threadId,
        driver,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:run-created"),
        type: "run.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId,
          rootNodeId,
          activeAttemptId: attemptId,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:attempt-created"),
        type: "run-attempt.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId,
          providerInstanceId,
          providerThreadId,
          providerTurnId,
          reason: "initial",
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:root-node"),
        type: "node.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: rootNodeId,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "completed",
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:assistant-node"),
        type: "node.updated",
        threadId,
        runId,
        nodeId: assistantNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: assistantNodeId,
          threadId,
          runId,
          parentNodeId: rootNodeId,
          rootNodeId,
          kind: "assistant_message",
          status: "completed",
          countsForRun: false,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:provider-turn"),
        type: "provider-turn.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId: rootNodeId,
          runAttemptId: attemptId,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:user-message"),
        type: "message.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: userMessageId,
          threadId,
          runId,
          nodeId: rootNodeId,
          role: "user",
          text: "rolled back user",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:assistant-message"),
        type: "message.updated",
        threadId,
        runId,
        nodeId: assistantNodeId,
        driver,
        occurredAt: now,
        payload: {
          createdBy: "agent",
          creationSource: "provider",
          id: assistantMessageId,
          threadId,
          runId,
          nodeId: assistantNodeId,
          role: "assistant",
          text: "rolled back assistant",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:user-item"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: userTurnItemId,
          threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 100,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          messageId: userMessageId,
          inputIntent: "turn_start",
          text: "rolled back user",
          attachments: [],
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:assistant-item"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: assistantNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: assistantTurnItemId,
          threadId,
          runId,
          nodeId: assistantNodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 101,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "assistant_message",
          messageId: assistantMessageId,
          text: "rolled back assistant",
          streaming: false,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:background-item"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: backgroundTurnItemId,
          threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 300,
          status: "running",
          title: "rolled back background command",
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "command_execution",
          input: "sleep 60",
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:run-rolled-back"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId,
          rootNodeId,
          activeAttemptId: attemptId,
          status: "rolled_back",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:root-rolled-back"),
        type: "node.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: rootNodeId,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "rolled_back",
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: now,
        },
      });

      const projection = yield* projectionStore.getThreadProjection(threadId);

      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["rolled_back"],
      );
      assert.deepEqual(
        projection.nodes.map((node) => [node.id, node.status]),
        [
          [assistantNodeId, "completed"],
          [rootNodeId, "rolled_back"],
        ],
      );
      assert.lengthOf(projection.providerTurns, 1);
      assert.lengthOf(projection.messages, 2);
      assert.lengthOf(projection.turnItems, 3);
      assert.lengthOf(projection.visibleTurnItems, 0);

      const shell = yield* projectionStore.getShellSnapshot();
      const rolledBackShellThread = shell.threads.find((entry) => entry.id === threadId);
      assert.isDefined(rolledBackShellThread);
      assert.isNull(rolledBackShellThread.latestVisibleMessage);
      assert.deepEqual(rolledBackShellThread?.pendingBackgroundTasks ?? [], []);
    }),
  );

  it.effect("keeps fork visible items stable after a source run is rolled back", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:projection-fork-source-rollback");
      const sourceThreadId = ThreadId.make("thread:projection-fork-source-rollback:source");
      const targetThreadId = ThreadId.make("thread:projection-fork-source-rollback:target");
      const sourceProviderThreadId = ProviderThreadId.make(
        "provider-thread:projection-fork-source-rollback:source",
      );
      const targetProviderThreadId = ProviderThreadId.make(
        "provider-thread:projection-fork-source-rollback:target",
      );
      const sourceRun1Id = RunId.make("run:projection-fork-source-rollback:source:1");
      const sourceRun2Id = RunId.make("run:projection-fork-source-rollback:source:2");
      const sourceRun3Id = RunId.make("run:projection-fork-source-rollback:source:3");
      const sourceRun1NodeId = NodeId.make("node:projection-fork-source-rollback:source:1");
      const sourceRun2NodeId = NodeId.make("node:projection-fork-source-rollback:source:2");
      const sourceRun3NodeId = NodeId.make("node:projection-fork-source-rollback:source:3");

      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:source-thread"),
        type: "thread.created",
        threadId: sourceThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: sourceThreadId,
          projectId,
          title: "Projection fork source rollback source",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: sourceProviderThreadId,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: sourceThreadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:target-thread"),
        type: "thread.created",
        threadId: targetThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: targetThreadId,
          projectId,
          title: "Projection fork source rollback target",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: targetProviderThreadId,
          lineage: {
            parentThreadId: sourceThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: {
            type: "run",
            threadId: sourceThreadId,
            runId: sourceRun2Id,
          },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });

      for (const [ordinal, runId, nodeId, promptText, responseText] of [
        [1, sourceRun1Id, sourceRun1NodeId, "source one", "one"],
        [2, sourceRun2Id, sourceRun2NodeId, "source two", "two"],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-fork-source-rollback:run-${ordinal}`),
          type: "run.created",
          threadId: sourceThreadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            id: runId,
            threadId: sourceThreadId,
            ordinal,
            providerInstanceId,
            modelSelection,
            providerThreadId: sourceProviderThreadId,
            userMessageId: MessageId.make(
              `message:projection-fork-source-rollback:user:${ordinal}`,
            ),
            rootNodeId: nodeId,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-fork-source-rollback:user-item-${ordinal}`),
          type: "turn-item.updated",
          threadId: sourceThreadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: TurnItemId.make(`turn-item:projection-fork-source-rollback:user:${ordinal}`),
            threadId: sourceThreadId,
            runId,
            nodeId,
            providerThreadId: sourceProviderThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: ordinal * 100,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            messageId: MessageId.make(`message:projection-fork-source-rollback:user:${ordinal}`),
            inputIntent: "turn_start",
            text: promptText,
            attachments: [],
          },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-fork-source-rollback:assistant-item-${ordinal}`),
          type: "turn-item.updated",
          threadId: sourceThreadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`turn-item:projection-fork-source-rollback:assistant:${ordinal}`),
            threadId: sourceThreadId,
            runId,
            nodeId,
            providerThreadId: sourceProviderThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: ordinal * 100 + 1,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "assistant_message",
            messageId: MessageId.make(
              `message:projection-fork-source-rollback:assistant:${ordinal}`,
            ),
            text: responseText,
            streaming: false,
          },
        });
      }

      const targetBeforeRollback = yield* projectionStore.getThreadProjection(targetThreadId);
      assert.deepEqual(
        targetBeforeRollback.visibleTurnItems.map((row) => row.item.type),
        ["user_message", "assistant_message", "user_message", "assistant_message", "fork"],
      );

      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:run-2-rolled-back"),
        type: "run.updated",
        threadId: sourceThreadId,
        runId: sourceRun2Id,
        nodeId: sourceRun2NodeId,
        driver,
        occurredAt: now,
        payload: {
          id: sourceRun2Id,
          threadId: sourceThreadId,
          ordinal: 2,
          providerInstanceId,
          modelSelection,
          providerThreadId: sourceProviderThreadId,
          userMessageId: MessageId.make("message:projection-fork-source-rollback:user:2"),
          rootNodeId: sourceRun2NodeId,
          activeAttemptId: null,
          status: "rolled_back",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });

      const sourceMessages = (yield* projectionStore.getThreadRecords(sourceThreadId, ["messages"]))
        .messages;
      assert.deepEqual(
        sourceMessages,
        (yield* projectionStore.getThreadProjection(sourceThreadId)).messages,
      );
      const targetAfterRollback = yield* projectionStore.getThreadProjection(targetThreadId);
      const shellSnapshot = yield* projectionStore.getShellSnapshot();
      for (const shell of [
        yield* projectionStore.getThreadShell(sourceThreadId),
        shellSnapshot.threads.find((thread) => thread.id === sourceThreadId),
      ]) {
        assert.equal(shell?.itemCount, 2);
      }
      for (const shell of [
        yield* projectionStore.getThreadShell(targetThreadId),
        shellSnapshot.threads.find((thread) => thread.id === targetThreadId),
      ]) {
        assert.equal(shell?.visibleItemCount, targetAfterRollback.visibleTurnItems.length);
      }
      const forwardPage = yield* projectionStore.getTimelinePage(targetThreadId, {
        view: "activity",
        limit: 2,
      });
      assert.deepEqual(forwardPage.items, targetAfterRollback.visibleTurnItems.slice(0, 2));
      assert.equal(forwardPage.totalItems, targetAfterRollback.visibleTurnItems.length);
      assert.isTrue(forwardPage.hasMore);
      const followingPage = yield* projectionStore.getTimelinePage(targetThreadId, {
        view: "activity",
        limit: 10,
        afterPosition: 1,
      });
      assert.deepEqual(followingPage.items, targetAfterRollback.visibleTurnItems.slice(2));
      assert.isFalse(followingPage.hasMore);

      assert.deepEqual(
        targetAfterRollback.visibleTurnItems.map((row) => [
          row.visibility,
          row.item.type,
          row.item.type === "user_message" || row.item.type === "assistant_message"
            ? row.item.text
            : row.item.title,
        ]),
        [
          ["inherited", "user_message", "source one"],
          ["inherited", "assistant_message", "one"],
          ["inherited", "user_message", "source two"],
          ["inherited", "assistant_message", "two"],
          ["synthetic", "fork", "Forked from conversation"],
        ],
      );

      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:run-3"),
        type: "run.updated",
        threadId: sourceThreadId,
        runId: sourceRun3Id,
        nodeId: sourceRun3NodeId,
        driver,
        occurredAt: now,
        payload: {
          id: sourceRun3Id,
          threadId: sourceThreadId,
          ordinal: 4,
          providerInstanceId,
          modelSelection,
          providerThreadId: sourceProviderThreadId,
          userMessageId: MessageId.make("message:projection-fork-source-rollback:user:3"),
          rootNodeId: sourceRun3NodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const nowIso = DateTime.formatIso(now);
      for (let index = 0; index < 300; index += 1) {
        const id = `turn-item:projection-fork-source-rollback:post-fork:${index}`;
        const ordinal = index < 10 ? 190 + index : 300 + index;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${sourceThreadId}, ${sourceRun3Id}, ${sourceRun3NodeId},
            ${sourceProviderThreadId}, NULL, NULL, ${ordinal}, 'command_execution',
            'completed', ${nowIso}, ${encodeUnknownJsonString({
              id,
              threadId: sourceThreadId,
              runId: sourceRun3Id,
              nodeId: sourceRun3NodeId,
              providerThreadId: sourceProviderThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "post fork",
              input: "echo later",
              output: "later",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }

      const { statements, tracer } = traceSqlStatements();
      const boundedFork = yield* projectionStore
        .getThreadSnapshotWindow(targetThreadId, { rowLimit: 2 })
        .pipe(Effect.withTracer(tracer));
      assert.lengthOf(
        statements.filter((statement) => statement.includes("WITH RECURSIVE retained")),
        1,
      );
      assert.lengthOf(
        statements.filter((statement) => statement.includes("SELECT node.payload_json")),
        1,
      );
      assert.lengthOf(boundedFork.projection.turnItems, 0);
      assert.deepEqual(
        boundedFork.projection.visibleTurnItems.map((row) => [row.visibility, row.item.type]),
        [
          ["inherited", "user_message"],
          ["inherited", "assistant_message"],
          ["synthetic", "fork"],
        ],
      );
      const parentPage = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 2,
        anchorItemId: TurnItemId.make("turn-item:projection-fork-source-rollback:assistant:1"),
      });
      assert.deepEqual(
        parentPage.projection.visibleTurnItems.map((row) =>
          row.item.type === "user_message" || row.item.type === "assistant_message"
            ? row.item.text
            : row.item.type,
        ),
        ["source one", "one", "fork"],
      );

      const emptyBoundaryRunId = RunId.make(
        "run:projection-fork-source-rollback:source:empty-boundary",
      );
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:empty-boundary-run"),
        type: "run.updated",
        threadId: sourceThreadId,
        runId: emptyBoundaryRunId,
        nodeId: NodeId.make("node:projection-fork-source-rollback:source:empty-boundary"),
        driver,
        occurredAt: now,
        payload: {
          id: emptyBoundaryRunId,
          threadId: sourceThreadId,
          ordinal: 3,
          providerInstanceId,
          modelSelection,
          providerThreadId: sourceProviderThreadId,
          userMessageId: MessageId.make(
            "message:projection-fork-source-rollback:user:empty-boundary",
          ),
          rootNodeId: NodeId.make("node:projection-fork-source-rollback:source:empty-boundary"),
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.forkedFrom.runId', ${emptyBoundaryRunId})
        WHERE thread_id = ${targetThreadId}
      `;
      const emptyBoundaryFork = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 2,
      });
      assert.deepEqual(
        emptyBoundaryFork.projection.visibleTurnItems.map((row) =>
          row.item.type === "user_message" || row.item.type === "assistant_message"
            ? row.item.text
            : row.item.type,
        ),
        ["source two", "two", "fork"],
      );
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.forkedFrom.runId', ${sourceRun2Id})
        WHERE thread_id = ${targetThreadId}
      `;

      const targetRunId = RunId.make("run:projection-fork-source-rollback:target:1");
      const targetNodeId = NodeId.make("node:projection-fork-source-rollback:target:1");
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:target-run"),
        type: "run.updated",
        threadId: targetThreadId,
        runId: targetRunId,
        nodeId: targetNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: targetRunId,
          threadId: targetThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: targetProviderThreadId,
          userMessageId: MessageId.make("message:projection-fork-source-rollback:target:1"),
          rootNodeId: targetNodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      for (let ordinal = 1; ordinal <= 102; ordinal += 1) {
        const id = `turn-item:projection-fork-source-rollback:target:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${targetThreadId}, ${targetRunId}, ${targetNodeId}, ${targetProviderThreadId},
            NULL, NULL, ${ordinal}, 'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId: targetThreadId,
              runId: targetRunId,
              nodeId: targetNodeId,
              providerThreadId: targetProviderThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: `target ${ordinal}`,
              input: `echo target ${ordinal}`,
              output: "target",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }
      const nestedThreadId = ThreadId.make("thread:projection-fork-source-rollback:nested");
      for (const ordinal of [
        ...Array.from({ length: 99 }, (_, index) => index + 1),
        ...Array.from({ length: 99 }, (_, index) => index + 101),
      ]) {
        const runId = ordinal < 100 ? sourceRun1Id : sourceRun2Id;
        const id = `turn-item:projection-fork-source-rollback:lineage:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${sourceThreadId}, ${runId}, NULL, NULL, NULL, NULL, ${ordinal},
            'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId: sourceThreadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: `lineage ${ordinal}`,
              input: "echo lineage",
              output: "lineage",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }
      const inheritedSupersededNodeId = NodeId.make(
        "node:projection-fork-source-rollback:inherited-superseded",
      );
      yield* sql`
        INSERT INTO orchestration_v2_projection_run_attempts (
          attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider,
          provider_instance_id, provider_thread_id, provider_turn_id, status, payload_json
        ) VALUES (
          'attempt:projection-fork-source-rollback:inherited-superseded',
          ${sourceThreadId}, ${sourceRun2Id}, 2, ${inheritedSupersededNodeId}, 'codex',
          ${providerInstanceId}, ${sourceProviderThreadId}, NULL, 'superseded',
          ${encodeUnknownJsonString({
            id: "attempt:projection-fork-source-rollback:inherited-superseded",
            runId: sourceRun2Id,
            attemptOrdinal: 2,
            rootNodeId: inheritedSupersededNodeId,
            providerInstanceId,
            providerThreadId: sourceProviderThreadId,
            providerTurnId: null,
            reason: "retry",
            status: "superseded",
            startedAt: nowIso,
            completedAt: nowIso,
          })}
        )
      `;
      for (let ordinal = 201; ordinal <= 300; ordinal += 1) {
        const id = `turn-item:projection-fork-source-rollback:hidden-interrupt:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${sourceThreadId}, ${sourceRun2Id}, ${inheritedSupersededNodeId},
            ${sourceProviderThreadId}, NULL, NULL, ${ordinal}, 'run_interrupt_result',
            'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId: sourceThreadId,
              runId: sourceRun2Id,
              nodeId: inheritedSupersededNodeId,
              providerThreadId: sourceProviderThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "Stopped",
              message: "Stopped",
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "run_interrupt_result",
            })}
          )
        `;
      }
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:nested-thread"),
        type: "thread.created",
        threadId: nestedThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: nestedThreadId,
          projectId,
          title: "Nested bounded fork",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: targetThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: { type: "run", threadId: targetThreadId, runId: targetRunId },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const boundedNested = yield* projectionStore.getThreadSnapshotWindow(nestedThreadId, {
        rowLimit: 2,
      });
      assert.deepEqual(
        boundedNested.projection.visibleTurnItems.map((row) => row.item.type),
        [
          "user_message",
          "assistant_message",
          "fork",
          "command_execution",
          "command_execution",
          "fork",
        ],
      );

      const nestedInitial = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        projection: yield* projectionStore
          .getThreadSnapshotWindow(nestedThreadId, {
            rowLimit: THREAD_HISTORY_PAGE_POLICY.maxItems + 2,
          })
          .pipe(Effect.map((snapshot) => snapshot.projection)),
        snapshotSequence: 1,
      });
      const expectedNestedIds = (yield* projectionStore.getThreadProjection(
        nestedThreadId,
      )).visibleTurnItems.map((row) => String(row.sourceItemId));
      const nestedIds = nestedInitial.projection.visibleTurnItems.map((row) =>
        String(row.sourceItemId),
      );
      let nestedCursor = nestedInitial.historyCursor;
      let nestedPages = 1;
      while (nestedCursor !== null) {
        const decoded = decodeThreadHistoryCursor(nestedCursor);
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(nestedThreadId, {
          rowLimit: THREAD_HISTORY_PAGE_POLICY.maxItems + 2,
          anchorItemId: TurnItemId.make(decoded.si),
          anchorThreadId: ThreadId.make(decoded.st),
        });
        const page = selectHistoryPageFromCursor({
          policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
          items: snapshot.projection.visibleTurnItems,
          cursor: nestedCursor,
          snapshotSequence: snapshot.snapshotSequence,
        });
        nestedIds.unshift(...page.items.map((row) => String(row.sourceItemId)));
        nestedCursor = page.nextCursor;
        nestedPages += 1;
      }
      assert.isAtLeast(nestedPages, 3);
      assert.lengthOf(nestedIds, expectedNestedIds.length);
      assert.deepEqual(nestedIds, expectedNestedIds);

      const nestedTurnWindow = yield* projectionStore.getThreadSnapshotWindow(nestedThreadId, {
        rowLimit: 77,
        userTurnLimit: 10,
      });
      const nestedTurnPage = buildBoundedThreadProjection({
        projection: nestedTurnWindow.projection,
        snapshotSequence: 1,
      });
      const turnPagedIds = nestedTurnPage.projection.visibleTurnItems.map((row) =>
        String(row.sourceItemId),
      );
      let turnCursor = nestedTurnPage.historyCursor;
      while (turnCursor !== null) {
        const anchor = decodeThreadHistoryCursor(turnCursor);
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(nestedThreadId, {
          rowLimit: 77,
          userTurnLimit: 20,
          anchorItemId: TurnItemId.make(anchor.si),
          anchorThreadId: ThreadId.make(anchor.st),
        });
        const page = selectHistoryPageFromCursor({
          items: snapshot.projection.visibleTurnItems,
          cursor: turnCursor,
          snapshotSequence: 1,
        });
        turnPagedIds.unshift(...page.items.map((row) => String(row.sourceItemId)));
        turnCursor = page.nextCursor;
      }
      assert.deepEqual(turnPagedIds, expectedNestedIds);
      const fullNested = yield* projectionStore.getThreadProjection(nestedThreadId);
      const nestedForward = yield* projectionStore.getTimelinePage(nestedThreadId, {
        view: "activity",
        limit: expectedNestedIds.length + 1,
      });
      assert.deepEqual(nestedForward.items, fullNested.visibleTurnItems);
      const messagePage = yield* projectionStore.getTimelinePage(nestedThreadId, {
        view: "messages",
        limit: 2,
      });
      assert.deepEqual(
        messagePage.items,
        fullNested.visibleTurnItems
          .filter((row) =>
            ["user_message", "assistant_message", "proposed_plan"].includes(row.item.type),
          )
          .slice(0, 2),
      );

      const emptyMiddleThreadId = ThreadId.make(
        "thread:projection-fork-source-rollback:empty-middle",
      );
      const emptyMiddleRunId = RunId.make("run:projection-fork-source-rollback:empty-middle");
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:empty-middle-thread"),
        type: "thread.created",
        threadId: emptyMiddleThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: emptyMiddleThreadId,
          projectId,
          title: "Empty middle fork",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: sourceThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: { type: "run", threadId: sourceThreadId, runId: sourceRun2Id },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:empty-middle-run"),
        type: "run.updated",
        threadId: emptyMiddleThreadId,
        runId: emptyMiddleRunId,
        nodeId: NodeId.make("node:projection-fork-source-rollback:empty-middle"),
        driver,
        occurredAt: now,
        payload: {
          id: emptyMiddleRunId,
          threadId: emptyMiddleThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:projection-fork-source-rollback:empty-middle"),
          rootNodeId: NodeId.make("node:projection-fork-source-rollback:empty-middle"),
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const emptyLeafThreadId = ThreadId.make("thread:projection-fork-source-rollback:empty-leaf");
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:empty-leaf-thread"),
        type: "thread.created",
        threadId: emptyLeafThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: emptyLeafThreadId,
          projectId,
          title: "Leaf after empty fork",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: emptyMiddleThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: {
            type: "run",
            threadId: emptyMiddleThreadId,
            runId: emptyMiddleRunId,
          },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const emptyMiddleSnapshot = yield* projectionStore.getThreadSnapshotWindow(
        emptyLeafThreadId,
        { rowLimit: 2 },
      );
      assert.deepEqual(
        emptyMiddleSnapshot.projection.visibleTurnItems.map((row) => [
          row.sourceThreadId,
          row.item.type,
        ]),
        [
          [sourceThreadId, "user_message"],
          [sourceThreadId, "assistant_message"],
          [sourceThreadId, "fork"],
          [emptyMiddleThreadId, "fork"],
        ],
      );

      yield* sql`
        DELETE FROM orchestration_v2_projection_turn_items
        WHERE run_id IN (${sourceRun1Id}, ${sourceRun2Id})
      `;
      const importedItemId = "turn-item:projection-fork-source-rollback:legacy-import";
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${importedItemId}, ${sourceThreadId}, NULL, NULL, NULL, NULL, NULL, 50,
          'assistant_message', 'completed', ${nowIso}, ${encodeUnknownJsonString({
            id: importedItemId,
            threadId: sourceThreadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 50,
            status: "completed",
            title: null,
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "assistant_message",
            messageId: MessageId.make("message:projection-fork-source-rollback:legacy-import"),
            text: "legacy import before empty fork",
            streaming: false,
            historyOrigin: "v1_import",
          })}
        )
      `;
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.historyOrigin', 'v1_import')
        WHERE thread_id = ${sourceThreadId}
      `;
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.forkedFrom.runId', ${emptyBoundaryRunId})
        WHERE thread_id = ${targetThreadId}
      `;
      const importedEmptyBoundary = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 2,
      });
      assert.deepEqual(
        importedEmptyBoundary.projection.visibleTurnItems.map((row) => [
          row.visibility,
          row.sourceThreadId,
          row.item.type === "assistant_message" ? row.item.text : row.item.type,
        ]),
        [
          ["inherited", sourceThreadId, "legacy import before empty fork"],
          ["synthetic", sourceThreadId, "fork"],
          ["local", targetThreadId, "command_execution"],
          ["local", targetThreadId, "command_execution"],
        ],
      );
    }),
  );

  it.effect("skips parent bodies once a fork's own turns fill its first page", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
      const parentId = ThreadId.make("thread:filled-fork:parent");
      const forkId = ThreadId.make("thread:filled-fork:fork");
      const parentText = "parent prompt";
      const createThread = (
        threadId: ThreadId,
        forkedFrom: { readonly threadId: ThreadId; readonly runId: RunId } | null,
      ) =>
        store.apply({
          id: EventId.make(`event:${threadId}`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:filled-fork"),
            title: "Filled fork",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: forkedFrom?.threadId ?? null,
              relationshipToParent: forkedFrom === null ? null : "fork",
              rootThreadId: parentId,
            },
            forkedFrom: forkedFrom === null ? null : { type: "run", ...forkedFrom },
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
      const addTurn = Effect.fnUntraced(function* (threadId: ThreadId, turn: number, text: string) {
        const runId = RunId.make(`run:${threadId}:${turn}`);
        const nodeId = NodeId.make(`node:${threadId}:${turn}`);
        yield* store.apply({
          id: EventId.make(`event:${runId}`),
          type: "run.created",
          threadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: turn,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make(`message:${runId}`),
            rootNodeId: nodeId,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        yield* store.apply({
          id: EventId.make(`event:${runId}:prompt`),
          type: "turn-item.updated",
          threadId,
          runId,
          driver,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:${runId}`),
            threadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: turn,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            messageId: MessageId.make(`message:${runId}`),
            inputIntent: "turn_start",
            createdBy: "user",
            creationSource: "web",
            text,
            attachments: [],
          },
        });
      });
      const readFirstPage = Effect.fnUntraced(function* (
        threadId: ThreadId,
        parsesParent: boolean,
      ) {
        const full = yield* store.getThreadSnapshot(threadId);
        // Measure only the window read; the full snapshot is the pagination oracle.
        const parse = yield* Effect.acquireRelease(
          Effect.sync(() => vi.spyOn(JSON, "parse")),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        const window = yield* store.getThreadSnapshotWindow(threadId, {
          rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
          userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
        });
        assert.equal(
          parse.mock.calls.some(([text]) => text.includes(parentText)),
          parsesParent,
        );
        const page = buildBoundedThreadProjection(window);
        assert.deepEqual(page, buildBoundedThreadProjection(full));
        assert.isTrue(page.hasMoreHistory);
        assert.isNotNull(page.historyCursor);
        return page.projection.visibleTurnItems;
      }, Effect.scoped);

      yield* createThread(parentId, null);
      for (const turn of [1, 2, 3]) yield* addTurn(parentId, turn, `${parentText} ${turn}`);
      // The third parent turn is after the fork boundary and must stay excluded.
      yield* createThread(forkId, { threadId: parentId, runId: RunId.make(`run:${parentId}:2`) });
      for (let turn = 1; turn <= 9; turn += 1) yield* addTurn(forkId, turn, "fork prompt");
      const partial = yield* readFirstPage(forkId, true);
      assert.include(
        partial.map((row) => row.visibility),
        "inherited",
      );

      yield* addTurn(forkId, 10, "fork prompt");
      const filled = yield* readFirstPage(forkId, false);
      assert.notInclude(
        filled.map((row) => row.visibility),
        "inherited",
      );

      const nestedId = ThreadId.make("thread:filled-fork:nested");
      yield* createThread(nestedId, { threadId: forkId, runId: RunId.make(`run:${forkId}:10`) });
      for (let turn = 1; turn <= 10; turn += 1) yield* addTurn(nestedId, turn, "nested prompt");
      yield* readFirstPage(nestedId, true);
    }),
  );

  it.effect("a pull request watch keeps a finished thread working until it ends", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:watched-pull-request");
      const runId = RunId.make("run:watched-pull-request");
      const at = DateTime.makeUnsafe("2026-10-05T12:00:00.000Z");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId: ProjectId.make("project:watched-pull-request"),
        title: "Babysit the PR",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      yield* store.apply({
        id: EventId.make("event:watched-pull-request:thread"),
        type: "thread.created",
        threadId,
        occurredAt: at,
        payload: thread,
      });
      yield* store.apply({
        id: EventId.make("event:watched-pull-request:run"),
        type: "run.created",
        threadId,
        runId,
        driver,
        providerInstanceId,
        occurredAt: at,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:watched-pull-request"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: at,
          startedAt: at,
          completedAt: at,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const link = {
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 7,
        url: "https://github.com/pingdotgg/t3code/pull/7",
        source: "agent" as const,
        linkedAt: DateTime.formatIso(at),
        snapshot: null,
        stack: null,
      };
      const syncPullRequests = (id: string, pullRequests: ReadonlyArray<ThreadPullRequestLink>) =>
        store.apply({
          id: EventId.make(`event:watched-pull-request:${id}`),
          type: "thread.pull-request-synced",
          threadId,
          occurredAt: at,
          payload: { ...thread, pullRequests },
        });
      const project = { title: "Project" };
      const environmentId = EnvironmentId.make("environment:watched-pull-request");
      const phase = Effect.gen(function* () {
        const shell = yield* store.getThreadShell(threadId);
        const listed = (yield* store.getShellSnapshot()).threads.find(
          (candidate) => candidate.id === threadId,
        );
        assert.deepEqual(listed?.pendingBackgroundTasks, shell?.pendingBackgroundTasks);
        return shell && projectThreadAwarenessV2({ environmentId, project, thread: shell })?.phase;
      });

      yield* syncPullRequests("watched", [
        {
          ...link,
          watch: {
            startedAt: DateTime.formatIso(at),
            headSha: null,
            failedChecks: [],
            passed: false,
            passedChecks: [],
            remarksThrough: DateTime.formatIso(at),
            remarkIds: [],
            conflicting: false,
            wakes: 0,
          },
        },
      ]);
      assert.deepEqual((yield* store.getThreadShell(threadId))?.pendingBackgroundTasks, [
        {
          taskId: "pull-request-watch:github.com/pingdotgg/t3code#7",
          description: "Watching pull request #7",
          kind: "monitor",
        },
      ]);
      assert.equal(yield* phase, "running");

      yield* syncPullRequests("unwatched", [link]);
      assert.deepEqual((yield* store.getThreadShell(threadId))?.pendingBackgroundTasks, []);
      assert.equal(yield* phase, "completed");
    }),
  );

  it.effect("dates a completion released by held background work at the release", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:held-completion");
      const runId = RunId.make("run:held-completion");
      const providerThreadId = ProviderThreadId.make("provider-thread:held-completion");
      const completedAt = DateTime.makeUnsafe("2026-09-28T12:00:00.000Z");
      const releasedAt = DateTime.makeUnsafe("2026-09-28T12:05:00.000Z");
      const providerThread = {
        id: providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor" as const }],
        createdAt: completedAt,
        updatedAt: completedAt,
      };
      yield* store.apply({
        id: EventId.make("event:held-completion:thread"),
        type: "thread.created",
        threadId,
        occurredAt: completedAt,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:held-completion"),
          title: "Watch the build",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: completedAt,
          updatedAt: completedAt,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* store.apply({
        id: EventId.make("event:held-completion:run"),
        type: "run.created",
        threadId,
        runId,
        driver,
        providerInstanceId,
        occurredAt: completedAt,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make("message:held-completion"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: completedAt,
          startedAt: completedAt,
          completedAt,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* store.apply({
        id: EventId.make("event:held-completion:monitor-running"),
        type: "provider-thread.updated",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: completedAt,
        payload: providerThread,
      });
      const project = { title: "Project" };
      const environmentId = EnvironmentId.make("environment:held-completion");
      const held = yield* store.getThreadShell(threadId);
      assert.equal(
        held && projectThreadAwarenessV2({ environmentId, project, thread: held })?.phase,
        "running",
      );

      yield* store.apply({
        id: EventId.make("event:held-completion:monitor-ended"),
        type: "provider-thread.updated",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: releasedAt,
        payload: { ...providerThread, pendingBackgroundTasks: [], updatedAt: releasedAt },
      });
      const released = yield* store.getThreadShell(threadId);
      const state =
        released && projectThreadAwarenessV2({ environmentId, project, thread: released });
      assert.equal(state?.phase, "completed");
      assert.equal(state?.updatedAt, DateTime.formatIso(releasedAt));

      yield* store.apply({
        id: EventId.make("event:held-completion:monitor-restarted"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: releasedAt,
        payload: { ...providerThread, updatedAt: releasedAt },
      });
      const newerRunId = RunId.make("run:held-completion:new-provider");
      yield* store.apply({
        id: EventId.make("event:held-completion:new-provider"),
        type: "run.created",
        threadId,
        runId: newerRunId,
        occurredAt: releasedAt,
        payload: {
          ...(yield* store.getThreadProjection(threadId)).runs[0]!,
          id: newerRunId,
          ordinal: 2,
          providerThreadId: ProviderThreadId.make("provider-thread:held-completion:new-provider"),
          requestedAt: releasedAt,
          startedAt: releasedAt,
          completedAt: releasedAt,
        },
      });
      assert.deepEqual(
        (yield* store.getRuntimeRecoveryProjection(threadId)).runs.map((run) => run.id),
        [runId, newerRunId],
      );
      // ardud: run-control checks read one run row; it must agree with the full recovery read.
      for (const run of (yield* store.getThreadProjection(threadId)).runs) {
        assert.deepEqual(yield* store.getRunControlState(threadId, run.id), {
          activeAttemptId: run.activeAttemptId,
          status: run.status,
        });
      }
      assert.equal(yield* store.getRunControlState(threadId, RunId.make("run:absent")), null);
      // A run of another thread is not this thread's run.
      assert.equal(
        yield* store.getRunControlState(threadId, RunId.make("run:held-completion:elsewhere")),
        null,
      );
      const missingThread = yield* Effect.flip(
        store.getRunControlState(ThreadId.make("thread:absent"), runId),
      );
      assert.equal(missingThread._tag, "ProjectionStoreThreadNotFoundError");
    }),
  );
});

const prCandidateShellSelectionBody = (label: string, sql: SqlClient.SqlClient | null) =>
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const projectId = ProjectId.make("project:pr-candidates");
    const threadIds = {
      branchOnly: ThreadId.make("thread:pr-candidates:branch-only"),
      prOnly: ThreadId.make("thread:pr-candidates:pr-only"),
      neither: ThreadId.make("thread:pr-candidates:neither"),
      archivedBranch: ThreadId.make("thread:pr-candidates:archived-branch"),
      settledBranch: ThreadId.make("thread:pr-candidates:settled-branch"),
      forkSource: ThreadId.make("thread:pr-candidates:fork-source"),
      forkCandidate: ThreadId.make("thread:pr-candidates:fork-candidate"),
    } as const;
    const runId = RunId.make("run:pr-candidates:fork-source");
    const rootNodeId = NodeId.make("node:pr-candidates:fork-source");
    const pullRequest = {
      projectId,
      repository: "example/repo",
      number: 42,
      url: "https://github.com/example/repo/pull/42",
    };

    const created = (threadId: ThreadId, overrides: Record<string, unknown> = {}) =>
      projectionStore.apply({
        id: EventId.make(`event:pr-candidates:${label}:${threadId}`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: threadId,
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
          ...overrides,
        } as never,
      });

    yield* created(threadIds.branchOnly, { branch: "feature/a" });
    yield* created(threadIds.prOnly, { branchPullRequest: pullRequest });
    yield* created(threadIds.neither);
    yield* created(threadIds.archivedBranch, { branch: "feature/archived", archivedAt: now });
    yield* created(threadIds.settledBranch, {
      branch: "feature/settled",
      settledOverride: "settled",
      settledAt: now,
    });
    yield* created(threadIds.forkSource);
    yield* created(threadIds.forkCandidate, {
      branch: "feature/fork",
      forkedFrom: { type: "run", threadId: threadIds.forkSource, runId },
      lineage: {
        parentThreadId: threadIds.forkSource,
        relationshipToParent: "fork",
        rootThreadId: threadIds.forkSource,
      },
    });
    yield* projectionStore.apply({
      id: EventId.make(`event:pr-candidates:${label}:fork-source-run`),
      type: "run.created",
      threadId: threadIds.forkSource,
      runId,
      nodeId: rootNodeId,
      driver,
      occurredAt: now,
      payload: {
        id: runId,
        threadId: threadIds.forkSource,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make(`message:pr-candidates:${label}:fork-source`),
        rootNodeId,
        activeAttemptId: null,
        status: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      },
    } as never);
    // Inherited fork items on the source: one runless imported item and one native-run item.
    const applySourceItem = (suffix: string, itemRunId: RunId | null, ordinal: number) =>
      projectionStore.apply({
        id: EventId.make(`event:pr-candidates:${label}:item:${suffix}`),
        type: "turn-item.updated",
        threadId: threadIds.forkSource,
        ...(itemRunId === null ? {} : { runId: itemRunId }),
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`turn-item:pr-candidates:${label}:${suffix}`),
          threadId: threadIds.forkSource,
          runId: itemRunId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "assistant_message",
          messageId: MessageId.make(`message:pr-candidates:${label}:${suffix}`),
          text: suffix,
          streaming: false,
        },
      } as never);
    yield* applySourceItem("imported", null, 1);
    yield* applySourceItem("native", runId, 2);

    const ids = (threads: ReadonlyArray<{ readonly id: ThreadId }>) =>
      threads.map((thread) => thread.id).toSorted();

    const defaultSnapshot = yield* projectionStore.getShellSnapshot();
    if (sql !== null) {
      const readDefault = yield* yield* sql.withTransaction(projectionStore.readShellSnapshot());
      assert.deepEqual(ids(readDefault.threads), ids(defaultSnapshot.threads));
    }
    assert.isTrue(defaultSnapshot.threads.some((thread) => thread.id === threadIds.neither));

    for (const unsettledOnly of [false, true]) {
      const unfiltered = yield* projectionStore.getShellSnapshot({
        location: "active",
        unsettledOnly,
      });
      const filtered = yield* projectionStore.getShellSnapshot({
        location: "active",
        unsettledOnly,
        pullRequestCandidatesOnly: true,
      });
      const expected = unfiltered.threads.filter(
        (thread) => thread.branch !== null || thread.branchPullRequest != null,
      );
      assert.deepEqual(ids(filtered.threads), ids(expected));
      assert.strictEqual(filtered.snapshotSequence, unfiltered.snapshotSequence);
      for (const expectedThread of expected) {
        const retained = filtered.threads.find((thread) => thread.id === expectedThread.id);
        assert.deepEqual(retained, expectedThread);
      }
      const forkFiltered = filtered.threads.find((thread) => thread.id === threadIds.forkCandidate);
      const forkUnfiltered = unfiltered.threads.find(
        (thread) => thread.id === threadIds.forkCandidate,
      );
      assert.isDefined(forkUnfiltered);
      assert.strictEqual(forkFiltered?.itemCount, forkUnfiltered?.itemCount);
      assert.strictEqual(forkFiltered?.visibleItemCount, forkUnfiltered?.visibleItemCount);
      assert.isAbove(forkFiltered!.visibleItemCount, 0);
    }

    if (sql !== null) {
      const { statements, tracer } = traceSqlStatements();
      yield* projectionStore
        .getShellSnapshot({ location: "active", pullRequestCandidatesOnly: true })
        .pipe(Effect.withTracer(tracer));
      const outerEligibility = statements.filter(
        (statement) =>
          statement.includes("FROM orchestration_v2_projection_threads") &&
          statement.includes("'$.branchPullRequest'"),
      );
      assert.isAtLeast(outerEligibility.length, 1);
      assert.lengthOf(
        statements.filter((statement) => /WHERE t\.thread_id = \?/.test(statement)),
        0,
      );

      const unflaggedTrace = traceSqlStatements();
      yield* projectionStore
        .getShellSnapshot({ location: "active" })
        .pipe(Effect.withTracer(unflaggedTrace.tracer));
      assert.lengthOf(
        unflaggedTrace.statements.filter((statement) =>
          statement.includes("'$.branchPullRequest'"),
        ),
        0,
      );

      const [stored] = yield* sql<{ readonly payload_json: string }>`
            SELECT payload_json FROM orchestration_v2_projection_threads
            WHERE thread_id = ${threadIds.neither}
          `;
      yield* sql`UPDATE orchestration_v2_projection_threads
            SET payload_json = json_set(payload_json, '$.title', 123)
            WHERE thread_id = ${threadIds.neither}`;
      const filteredRead = yield* sql
        .withTransaction(
          projectionStore.readShellSnapshot({
            location: "active",
            pullRequestCandidatesOnly: true,
          }),
        )
        .pipe(
          Effect.flatMap((decode) => decode),
          Effect.exit,
        );
      const unfilteredRead = yield* sql
        .withTransaction(projectionStore.readShellSnapshot({ location: "active" }))
        .pipe(
          Effect.flatMap((decode) => decode),
          Effect.exit,
        );
      yield* sql`UPDATE orchestration_v2_projection_threads
            SET payload_json = ${stored!.payload_json}
            WHERE thread_id = ${threadIds.neither}`;
      assert.isTrue(filteredRead._tag === "Success");
      assert.isTrue(unfilteredRead._tag === "Failure");
    }
  });

it.effect("memory PR candidate shell selection preserves default snapshots and fork counts", () =>
  prCandidateShellSelectionBody("memory", null).pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("SQL PR candidate shell selection preserves default snapshots and fork counts", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* prCandidateShellSelectionBody("SQL", sql);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("latest authored timestamp follows message replacement and removal", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = "thread:authored-replacement";
    const oldSelect = (indexed: boolean) => `
      SELECT message.updated_at
      FROM orchestration_v2_projection_messages message${indexed ? " INDEXED BY ardud_v2_messages_latest_user_authored_idx" : ""}
      WHERE message.thread_id = ?
        AND message.role = 'user'
        AND json_extract(message.payload_json, '$.createdBy') = 'user'
      ORDER BY message.updated_at DESC, message.message_id DESC
      LIMIT 1`;
    const readBoth = Effect.gen(function* () {
      const exact = yield* sql.unsafe<{ readonly updated_at: string }>(oldSelect(false), [
        threadId,
      ]);
      const indexed = yield* sql.unsafe<{ readonly updated_at: string }>(oldSelect(true), [
        threadId,
      ]);
      assert.deepEqual(indexed, exact);
      return exact[0]?.updated_at ?? null;
    });
    const insert = (id: string, role: string, createdBy: string | null, at: string) =>
      sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
        VALUES (${id}, ${threadId}, NULL, NULL, ${role}, 0, ${at}, ${at},
          ${createdBy === null ? "{}" : JSON.stringify({ createdBy })})`;

    yield* insert("m:user-system", "user", "system", "2026-03-01T00:00:00.000Z");
    yield* insert("m:assistant-user", "assistant", "user", "2026-03-02T00:00:00.000Z");
    yield* insert("m:missing", "user", null, "2026-03-03T00:00:00.000Z");
    yield* insert("m:genuine", "user", "user", "2026-03-04T00:00:00.000Z");
    assert.equal(yield* readBoth, "2026-03-04T00:00:00.000Z");

    yield* sql`UPDATE orchestration_v2_projection_messages SET updated_at = ${"2026-03-09T00:00:00.000Z"}
      WHERE message_id = ${"m:genuine"}`;
    assert.equal(yield* readBoth, "2026-03-09T00:00:00.000Z");

    yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = ${"m:genuine"}`;
    assert.isNull(yield* readBoth);

    yield* insert("m:genuine-a", "user", "user", "2026-03-05T00:00:00.000Z");
    yield* insert("m:genuine-b", "user", "user", "2026-03-05T00:00:00.000Z");
    assert.equal(yield* readBoth, "2026-03-05T00:00:00.000Z");

    yield* sql`BEGIN`;
    yield* insert("m:speculative", "user", "user", "2026-03-20T00:00:00.000Z");
    assert.equal(yield* readBoth, "2026-03-20T00:00:00.000Z");
    yield* sql`ROLLBACK`;
    assert.equal(yield* readBoth, "2026-03-05T00:00:00.000Z");
  }).pipe(Effect.provide(layerTest)),
);

const idleSubagentShellBody = (label: string) =>
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    // Finished long ago: outside the window in which idle subagents stay in client shells.
    const old = DateTime.subtract(now, { days: 30 });
    const projectId = ProjectId.make(`project:idle-subagents:${label}`);
    const id = (name: string) => ThreadId.make(`thread:idle-subagents:${name}`);
    const created = (
      threadId: ThreadId,
      parent: ThreadId | null,
      overrides: Record<string, unknown> = {},
      at = parent === null ? now : old,
    ) =>
      projectionStore.apply({
        id: EventId.make(`event:idle-subagents:${label}:${threadId}`),
        type: "thread.created",
        threadId,
        occurredAt: at,
        payload: {
          createdBy: parent === null ? "user" : "agent",
          creationSource: parent === null ? "web" : "provider",
          id: threadId,
          projectId,
          title: threadId,
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage:
            parent === null
              ? { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId }
              : { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
          forkedFrom: null,
          createdAt: at,
          updatedAt: at,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
          ...overrides,
        } as never,
      });
    const run = (threadId: ThreadId, status: "running" | "completed", at = old) => {
      const runId = RunId.make(`run:idle-subagents:${threadId}`);
      return projectionStore
        .apply({
          id: EventId.make(`event:idle-subagents:${label}:run:${threadId}`),
          type: "run.created",
          threadId,
          runId,
          nodeId: NodeId.make(`node:idle-subagents:${threadId}`),
          driver,
          occurredAt: at,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make(`message:idle-subagents:${threadId}`),
            rootNodeId: NodeId.make(`node:idle-subagents:${threadId}`),
            activeAttemptId: null,
            status,
            requestedAt: at,
            startedAt: at,
            completedAt: status === "running" ? null : at,
            checkpointId: null,
            contextHandoffId: null,
          },
        } as never)
        .pipe(Effect.as(runId));
    };

    // Production shape: top-level threads with many finished subagents (archiving a parent
    // never archives them; the OpenCode importer creates them unarchived), a few live ones.
    const TOP_LEVEL = 20;
    const IDLE_PER_TOP = 12;
    const expected = new Set<ThreadId>();
    for (let top = 0; top < TOP_LEVEL; top++) {
      const topId = id(`top-${top}`);
      yield* created(topId, null);
      expected.add(topId);
      for (let child = 0; child < IDLE_PER_TOP; child++) {
        const childId = id(`top-${top}-idle-${child}`);
        yield* created(childId, topId);
        yield* run(childId, "completed");
      }
    }
    // A live subagent stays.
    const live = id("top-0-live");
    yield* created(live, id("top-0"));
    yield* run(live, "running");
    expected.add(live);
    // A nested request under an idle (async-delegating) subagent keeps the whole chain, so
    // pendingSubagentRequestsByThread can still carry it to the root row.
    const idleMiddle = id("top-1-middle");
    const asking = id("top-1-middle-asking");
    yield* created(idleMiddle, id("top-1"));
    yield* run(idleMiddle, "completed");
    yield* created(asking, idleMiddle);
    const askingRun = yield* run(asking, "running");
    yield* projectionStore.apply({
      id: EventId.make(`event:idle-subagents:${label}:request`),
      type: "runtime-request.updated",
      threadId: asking,
      runId: askingRun,
      nodeId: NodeId.make(`node:idle-subagents:${asking}`),
      driver,
      occurredAt: now,
      payload: {
        id: RuntimeRequestId.make(`request:idle-subagents:${label}`),
        nodeId: NodeId.make(`node:idle-subagents:${asking}`),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    } as never);
    expected.add(idleMiddle);
    expected.add(asking);
    // A subagent that finished three days ago stays: it is in the user's working set.
    const recent = id("top-3-recent");
    const threeDaysAgo = DateTime.subtract(now, { days: 3 });
    yield* created(recent, id("top-3"), {}, threeDaysAgo);
    yield* run(recent, "completed", threeDaysAgo);
    expected.add(recent);
    // An archived subagent is never in the active shell.
    yield* created(id("top-2-archived"), id("top-2"), { archivedAt: now });

    const full = yield* projectionStore.getShellSnapshot({ location: "active" });
    const client = yield* projectionStore.getShellSnapshot({
      location: "active",
      omitIdleSubagents: true,
    });
    const ids = (threads: ReadonlyArray<{ readonly id: ThreadId }>) =>
      threads.map((thread) => thread.id).toSorted();
    const fixtureRows = (threads: ReadonlyArray<{ readonly id: ThreadId }>) =>
      threads.filter((thread) => String(thread.id).startsWith("thread:idle-subagents:"));

    assert.lengthOf(fixtureRows(full.threads), TOP_LEVEL * (1 + IDLE_PER_TOP) + 4);
    assert.deepEqual(ids(fixtureRows(client.threads)), [...expected].toSorted());
    assert.lengthOf(fixtureRows(client.threads), TOP_LEVEL + 4);
    // Kept rows are unchanged, and the snapshot point is the same.
    for (const thread of client.threads) {
      assert.deepEqual(
        thread,
        full.threads.find((candidate) => candidate.id === thread.id),
      );
    }
    assert.strictEqual(client.snapshotSequence, full.snapshotSequence);
    return { full, client, expected };
  });

it.effect("memory client shell omits idle subagents but keeps live ones and their chain", () =>
  idleSubagentShellBody("memory").pipe(Effect.asVoid, Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("SQL client shell omits idle subagents but keeps live ones and their chain", () =>
  Effect.gen(function* () {
    const { expected } = yield* idleSubagentShellBody("SQL");
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    // Keyset pages over the filtered rows reach the same set without repeats.
    const paged: Array<ThreadId> = [];
    let after: string | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const page = yield* projectionStore.getShellSnapshot({
        location: "active",
        omitIdleSubagents: true,
        limit: 4,
        ...(after === undefined ? {} : { afterThreadId: after }),
      });
      paged.push(...page.threads.map((thread) => thread.id));
      if (page.threads.length < 4) break;
      after = page.threads.at(-1)!.id;
    }
    assert.deepEqual(paged, [...expected].toSorted());
  }).pipe(Effect.provide(layerTest)),
);
