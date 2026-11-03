import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const openCodeInstance = ProviderInstanceId.make("opencode");
const claudeInstance = ProviderInstanceId.make("claudeAgent");
const codexInstance = ProviderInstanceId.make("codex-cu");
const openCodeDriver = ProviderDriverKind.make("opencode");
const claudeDriver = ProviderDriverKind.make("claudeAgent");
const codexDriver = ProviderDriverKind.make("codex");
const openCodeSelection = { instanceId: openCodeInstance, model: "openai/gpt-5" };
const claudeSelection = { instanceId: claudeInstance, model: "claude-sonnet-4-6" };
const codexSelection = { instanceId: codexInstance, model: "gpt-5.4" };

const adapter = (
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  capabilities: typeof CodexProviderCapabilitiesV2 | typeof ClaudeProviderCapabilitiesV2,
) =>
  ({
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("Adoption must not start a provider process"),
  }) as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerEventStore = EventStore.layer.pipe(Layer.provide(layerDatabase));
const layerProjectionStore = ProjectionStore.layer.pipe(Layer.provide(layerDatabase));
const layerTest = Layer.mergeAll(
  layerDatabase,
  layerEventStore,
  layerProjectionStore,
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProjectionMaintenance.layer.pipe(
    Layer.provide(Layer.mergeAll(layerDatabase, layerEventStore, layerProjectionStore)),
  ),
  ProviderReplayHarness.layerWithRegistry(
    { name: "adopt-native-history" },
    ProviderAdapterRegistry.layerFromAdapters([
      adapter(openCodeInstance, openCodeDriver, CodexProviderCapabilitiesV2),
      adapter(claudeInstance, claudeDriver, ClaudeProviderCapabilitiesV2),
      adapter(codexInstance, codexDriver, CodexProviderCapabilitiesV2),
    ]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const claudeHistory = {
  source: "opencode",
  sourceSessionId: "ses_x",
  digest: "sha256:history-x",
  mode: "claude-transcript",
  stagedPath: "/staged/claude-transcript.jsonl",
} as const;
const codexHistory = {
  source: "opencode",
  sourceSessionId: "ses_x",
  digest: "sha256:history-x",
  mode: "codex-inject",
  stagedPath: "/staged/codex-input.txt",
} as const;

type AdoptCommand = Extract<
  OrchestrationV2InternalCommand,
  { readonly type: "thread.adopt-native-history" }
>;

const claudeCommand = (threadId: ThreadId, expectedActiveProviderThreadId: ProviderThreadId) =>
  ({
    type: "thread.adopt-native-history",
    commandId: CommandId.make(`adopt:claude:${threadId}`),
    threadId,
    modelSelection: claudeSelection,
    expectedActiveProviderThreadId,
    target: {
      kind: "new",
      driver: claudeDriver,
      nativeId: "claude-session-x",
      headId: "claude-head-x",
      seededHistory: claudeHistory,
    },
  }) satisfies AdoptCommand;

const createSource = (threadId: ThreadId, nativeId = "ses_x") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:adopt-native-history"),
      title: "Existing OpenCode thread",
      modelSelection: openCodeSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      importedNativeThread: {
        ref: { driver: openCodeDriver, nativeId, strength: "strong" },
        metadata: { modelSelection: openCodeSelection, title: "Imported source" },
      },
    });
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const activeId = projection.thread.activeProviderThreadId;
    assert.isNotNull(activeId);
    const source = projection.providerThreads.find((row) => row.id === activeId);
    assert.isDefined(source);
    assert.equal(source!.nativeThreadRef?.nativeId, nativeId);
    return source!;
  });

const errorCause = (error: Orchestrator.OrchestratorV2Error) =>
  "cause" in error ? String(error.cause) : error.message;

it.effect("adopts native Claude history once, preserves the source, and can restore it", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:adopt-claude");
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const events = yield* EventStore.EventStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const sql = yield* SqlClient.SqlClient;
    const source = yield* createSource(threadId);
    const oldSqlRow =
      yield* sql`SELECT * FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ${source.id}`;
    assert.lengthOf(oldSqlRow, 1);

    const command = claudeCommand(threadId, source.id);
    const first = yield* orchestrator.dispatch(command);
    const adopted = yield* orchestrator.getThreadProjection(threadId);
    const targetId = adopted.thread.activeProviderThreadId;
    assert.isNotNull(targetId);
    assert.notEqual(targetId, source.id);
    const selectionEvent = first.storedEvents.find(
      ({ event }) => event.type === "thread.provider-switched",
    )?.event;
    assert.equal(selectionEvent?.type, "thread.provider-switched");
    if (selectionEvent?.type === "thread.provider-switched") {
      assert.equal(selectionEvent.payload.activeProviderThreadId, targetId);
    }
    assert.equal(adopted.thread.providerInstanceId, claudeInstance);
    assert.deepEqual(adopted.thread.modelSelection, claudeSelection);
    assert.lengthOf(adopted.providerThreads, 2);
    assert.deepEqual(
      adopted.providerThreads.find((row) => row.id === source.id),
      source,
    );
    const target = adopted.providerThreads.find((row) => row.id === targetId);
    assert.isDefined(target);
    assert.equal(target!.driver, claudeDriver);
    assert.equal(target!.providerInstanceId, claudeInstance);
    assert.equal(target!.appThreadId, threadId);
    assert.deepEqual(target!.nativeThreadRef, {
      driver: claudeDriver,
      nativeId: "claude-session-x",
      strength: "strong",
    });
    assert.deepEqual(target!.nativeConversationHeadRef, {
      driver: claudeDriver,
      nativeId: "claude-head-x",
      strength: "strong",
    });
    assert.deepEqual(target!.nativeMetadata?.seededHistory, claudeHistory);
    assert.deepEqual(
      yield* sql`SELECT * FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ${source.id}`,
      oldSqlRow,
    );
    const otherThreadId = ThreadId.make("thread:adopt-duplicate-owner");
    const otherSource = yield* createSource(otherThreadId, "ses_other");
    const otherBefore = yield* orchestrator.getThreadProjection(otherThreadId);
    const duplicateOwner = yield* orchestrator
      .dispatch({
        ...claudeCommand(otherThreadId, otherSource.id),
        commandId: CommandId.make("adopt:claude:duplicate-other-thread"),
      })
      .pipe(Effect.flip);
    assert.include(errorCause(duplicateOwner), "already adopted");
    assert.deepEqual(yield* orchestrator.getThreadProjection(otherThreadId), otherBefore);
    assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), adopted);
    const sqlThread = yield* sql<{ active_provider_thread_id: string }>`
      SELECT active_provider_thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
    `;
    assert.equal(sqlThread[0]?.active_provider_thread_id, targetId);

    const sequence = yield* sink.latestSequence({ threadId });
    const replayed = yield* orchestrator.dispatch(command);
    assert.deepEqual(replayed, first);
    assert.equal(yield* sink.latestSequence({ threadId }), sequence);
    assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), adopted);

    // A new command is not a receipt replay, even if it names the same native session.
    const duplicate = yield* orchestrator
      .dispatch({
        ...command,
        commandId: CommandId.make("adopt:claude:duplicate-native-id"),
        expectedActiveProviderThreadId: targetId,
      })
      .pipe(Effect.flip);
    assert.include(errorCause(duplicate), "already adopted");
    assert.equal(yield* sink.latestSequence({ threadId }), sequence);
    assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), adopted);

    // Late events still update their source row, not the active selection.
    const lateAt = DateTime.add(yield* DateTime.now, { seconds: 1 });
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:adopt:late-opencode"),
          type: "provider-thread.updated",
          threadId,
          driver: openCodeDriver,
          providerInstanceId: openCodeInstance,
          occurredAt: lateAt,
          payload: { ...source, status: "idle", updatedAt: lateAt },
        },
      ],
    });
    const afterLate = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(afterLate.thread.activeProviderThreadId, targetId);
    assert.deepEqual(afterLate.thread.modelSelection, claudeSelection);
    assert.equal(afterLate.providerThreads.find((row) => row.id === source.id)?.status, "idle");
    const lateSqlThread = yield* sql<{ active_provider_thread_id: string }>`
      SELECT active_provider_thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
    `;
    assert.equal(lateSqlThread[0]?.active_provider_thread_id, targetId);

    // Replay the persisted events through the in-memory reducer as well as SQL.
    const stored = yield* events.read({ threadId }).pipe(Stream.runCollect);
    let reduced: OrchestrationV2ThreadProjection | undefined;
    for (const { event } of stored) {
      if (event.type === "thread.created") reduced = ProjectionStore.emptyProjection(event);
      else if (reduced !== undefined) reduced = ProjectionStore.applyToProjection(reduced, event);
    }
    assert.isDefined(reduced);
    assert.equal(reduced!.thread.activeProviderThreadId, targetId);
    assert.deepEqual(reduced!.thread.modelSelection, claudeSelection);
    assert.deepEqual(
      reduced!.providerThreads.find((row) => row.id === targetId),
      afterLate.providerThreads.find((row) => row.id === targetId),
    );
    assert.isTrue((yield* maintenance.rebuild).valid);
    const rebuilt = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(rebuilt.thread.activeProviderThreadId, targetId);
    assert.deepEqual(rebuilt.thread.modelSelection, claudeSelection);
    assert.deepEqual(rebuilt.providerThreads, afterLate.providerThreads);

    yield* orchestrator.dispatch({
      type: "thread.adopt-native-history",
      commandId: CommandId.make("adopt:restore-source"),
      threadId,
      modelSelection: openCodeSelection,
      expectedActiveProviderThreadId: targetId,
      target: { kind: "existing", providerThreadId: source.id },
    });
    const restored = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(restored.thread.activeProviderThreadId, source.id);
    assert.equal(restored.thread.providerInstanceId, openCodeInstance);
    assert.deepEqual(restored.thread.modelSelection, openCodeSelection);
    assert.deepEqual(
      restored.providerThreads.find((row) => row.id === targetId),
      target,
    );
    assert.isTrue((yield* maintenance.rebuild).valid);
    const rebuiltRestore = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(rebuiltRestore.thread.activeProviderThreadId, source.id);
    assert.deepEqual(rebuiltRestore.thread.modelSelection, openCodeSelection);
    assert.deepEqual(rebuiltRestore.providerThreads, restored.providerThreads);

    // A delayed target update cannot undo the explicit rollback, but its row is retained.
    const lateTargetAt = DateTime.add(lateAt, { seconds: 1 });
    const lateTarget = { ...target!, status: "idle" as const, updatedAt: lateTargetAt };
    const event = {
      id: EventId.make("event:adopt:late-claude-after-rollback"),
      type: "provider-thread.updated" as const,
      threadId,
      driver: claudeDriver,
      providerInstanceId: claudeInstance,
      occurredAt: lateTargetAt,
      payload: lateTarget,
    };
    const memory = ProjectionStore.applyToProjection(restored, event);
    assert.equal(memory.thread.activeProviderThreadId, source.id);
    assert.deepEqual(memory.providerThreads.find((row) => row.id === targetId), lateTarget);
    yield* sink.write({ events: [event] });
    const afterRollbackLate = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(afterRollbackLate.thread.activeProviderThreadId, source.id);
    assert.equal(afterRollbackLate.thread.providerInstanceId, openCodeInstance);
    assert.deepEqual(afterRollbackLate.thread.modelSelection, openCodeSelection);
    assert.deepEqual(afterRollbackLate.providerThreads.find((row) => row.id === targetId), lateTarget);
    assert.isTrue((yield* maintenance.rebuild).valid);
    const replayedLate = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(replayedLate.thread.activeProviderThreadId, source.id);
    assert.deepEqual(replayedLate.providerThreads, afterRollbackLate.providerThreads);

    // A subsequent deliberate switch still makes the target active.
    yield* orchestrator.dispatch({
      type: "thread.adopt-native-history",
      commandId: CommandId.make("adopt:restore-target"),
      threadId,
      modelSelection: claudeSelection,
      expectedActiveProviderThreadId: source.id,
      target: { kind: "existing", providerThreadId: targetId! },
    });
    const switchedAgain = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(switchedAgain.thread.activeProviderThreadId, targetId);
    assert.deepEqual(switchedAgain.thread.modelSelection, claudeSelection);
    assert.isTrue((yield* maintenance.rebuild).valid);
    assert.equal(
      (yield* orchestrator.getThreadProjection(threadId)).thread.activeProviderThreadId,
      targetId,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects a stale expected provider thread without changing either row", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:adopt-stale");
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    yield* createSource(threadId);
    const before = yield* orchestrator.getThreadProjection(threadId);
    const sequence = yield* sink.latestSequence({ threadId });
    const error = yield* orchestrator
      .dispatch(claudeCommand(threadId, ProviderThreadId.make("provider-thread:stale")))
      .pipe(Effect.flip);
    assert.include(errorCause(error), "different active provider thread");
    assert.equal(yield* sink.latestSequence({ threadId }), sequence);
    assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), before);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects provider work that lands between planning and commit", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:adopt-late-request");
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const source = yield* createSource(threadId);
    const now = yield* DateTime.now;
    const gap = sink
      .write({
        events: [
          {
            id: EventId.make("event:adopt:late-request"),
            type: "runtime-request.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: RuntimeRequestId.make("request:adopt-late"),
              nodeId: NodeId.make("node:adopt-late"),
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "user_input",
              status: "pending",
              responseCapability: { type: "message" },
              createdAt: now,
              resolvedAt: null,
            },
          },
        ],
      })
      .pipe(Effect.asVoid, Effect.orDie);
    const command = claudeCommand(threadId, source.id);
    const error = yield* orchestrator
      .dispatch(command)
      .pipe(Effect.provideService(Orchestrator.AdoptNativeHistoryBeforeCommit, gap), Effect.flip);
    assert.include(error.message, "changed while adopting");
    const after = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(after.thread.activeProviderThreadId, source.id);
    assert.deepEqual(after.thread.modelSelection, openCodeSelection);
    assert.equal(after.runtimeRequests[0]?.status, "pending");
    assert.lengthOf(after.providerThreads, 1);
    const replay = yield* orchestrator.dispatch(command).pipe(Effect.flip);
    assert.equal(replay._tag, "OrchestratorCommandPreviouslyRejectedError");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("activates codex injection before a native session ID exists", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:adopt-codex");
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const sql = yield* SqlClient.SqlClient;
    const source = yield* createSource(threadId);
    yield* orchestrator.dispatch({
      type: "thread.adopt-native-history",
      commandId: CommandId.make("adopt:codex-inject"),
      threadId,
      modelSelection: codexSelection,
      expectedActiveProviderThreadId: source.id,
      target: {
        kind: "new",
        driver: codexDriver,
        nativeId: null,
        headId: null,
        seededHistory: codexHistory,
      },
    });
    const adopted = yield* orchestrator.getThreadProjection(threadId);
    const targetId = adopted.thread.activeProviderThreadId;
    assert.isNotNull(targetId);
    assert.notEqual(targetId, source.id);
    assert.deepEqual(adopted.thread.modelSelection, codexSelection);
    const target = adopted.providerThreads.find((row) => row.id === targetId);
    assert.isDefined(target);
    assert.equal(target!.providerInstanceId, codexInstance);
    assert.isNull(target!.nativeThreadRef);
    assert.isNull(target!.nativeConversationHeadRef);
    assert.deepEqual(target!.nativeMetadata?.seededHistory, codexHistory);
    assert.deepEqual(
      adopted.providerThreads.find((row) => row.id === source.id),
      source,
    );
    const rows = yield* sql<{ active_provider_thread_id: string }>`
      SELECT active_provider_thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
    `;
    assert.equal(rows[0]?.active_provider_thread_id, targetId);
    assert.isTrue((yield* maintenance.rebuild).valid);
    const rebuilt = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(rebuilt.thread.activeProviderThreadId, targetId);
    assert.deepEqual(
      rebuilt.providerThreads.find((row) => row.id === targetId),
      target,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("does not reissue imported context when dispatching onto an adopted Codex row", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:adopt-codex-imported");
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const source = yield* createSource(threadId);
    const before = yield* orchestrator.getThreadProjection(threadId);
    const now = yield* DateTime.now;
    yield* sink.write({ events: [{
      id: EventId.make("event:mark-imported"), type: "thread.model-selection-updated",
      threadId, providerInstanceId: openCodeInstance, occurredAt: now,
      payload: { ...before.thread, historyOrigin: "v1_import", updatedAt: now },
    }] });
    yield* orchestrator.dispatch({
      type: "thread.adopt-native-history", commandId: CommandId.make("adopt:codex-imported"),
      threadId, modelSelection: codexSelection, expectedActiveProviderThreadId: source.id,
      target: { kind: "new", driver: codexDriver, nativeId: null, headId: null, seededHistory: codexHistory },
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch", commandId: CommandId.make("send:codex-imported"), threadId,
      messageId: MessageId.make("message:codex-imported"), text: "continue", attachments: [],
      modelSelection: codexSelection, createdBy: "user", creationSource: "web",
      dispatchMode: { type: "start_immediately" },
    });
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(projection.thread.historyOrigin, "v1_import");
    assert.equal(projection.runs.at(-1)?.contextHandoffId, null);
    assert.deepEqual(projection.contextHandoffs, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["busy", "queued"] as const)(
  "refuses to adopt while the thread has %s work",
  (state) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make(`thread:adopt-${state}`);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      yield* createSource(threadId);
      const send = (suffix: string, dispatchMode: { type: "defer_start" | "queue_after_active" }) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`send:${state}:${suffix}`),
          threadId,
          messageId: MessageId.make(`message:${state}:${suffix}`),
          text: "Continue",
          attachments: [],
          dispatchMode,
          createdBy: "user",
          creationSource: "web",
        });
      yield* send("first", { type: "defer_start" });
      if (state === "queued") yield* send("second", { type: "queue_after_active" });
      const beforeUpdate = yield* orchestrator.getThreadProjection(threadId);
      const first = beforeUpdate.runs[0]!;
      const now = yield* DateTime.now;
      // Apply directly so the out-of-band fixture does not wake the queued run.
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* projections.apply({
        id: EventId.make(`event:adopt-${state}:run`),
        type: "run.updated",
        threadId,
        runId: first.id,
        occurredAt: now,
        payload:
          state === "busy"
            ? { ...first, status: "running", startedAt: now }
            : { ...first, status: "completed", completedAt: now },
      });
      const before = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        before.runs.map((run) => run.status),
        state === "busy" ? ["running"] : ["completed", "queued"],
      );
      const sequence = yield* sink.latestSequence({ threadId });
      const error = yield* orchestrator
        .dispatch(claudeCommand(threadId, before.thread.activeProviderThreadId!))
        .pipe(Effect.flip);
      assert.include(errorCause(error), "queued or active");
      assert.equal(yield* sink.latestSequence({ threadId }), sequence);
      assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), before);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a pending runtime request even with no active run", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:adopt-request");
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const source = yield* createSource(threadId);
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:adopt:pending-request"),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make("request:adopt"),
            nodeId: NodeId.make("node:adopt-request"),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        },
      ],
    });
    const before = yield* orchestrator.getThreadProjection(threadId);
    assert.lengthOf(before.runs, 0);
    assert.equal(before.runtimeRequests[0]?.status, "pending");
    const sequence = yield* sink.latestSequence({ threadId });
    const error = yield* orchestrator
      .dispatch(claudeCommand(threadId, source.id))
      .pipe(Effect.flip);
    assert.include(errorCause(error), "pending runtime request");
    assert.equal(yield* sink.latestSequence({ threadId }), sequence);
    assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), before);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects an existing row from another thread or provider instance", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:adopt-invalid-existing");
    const otherThreadId = ThreadId.make("thread:adopt-foreign-source");
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const source = yield* createSource(threadId);
    const foreign = yield* createSource(otherThreadId, "ses_other");
    const before = yield* orchestrator.getThreadProjection(threadId);
    const sequence = yield* sink.latestSequence({ threadId });
    const existing = (id: string, providerThreadId: ProviderThreadId): AdoptCommand => ({
      type: "thread.adopt-native-history",
      commandId: CommandId.make(id),
      threadId,
      modelSelection: claudeSelection,
      expectedActiveProviderThreadId: source.id,
      target: { kind: "existing", providerThreadId },
    });
    const foreignError = yield* orchestrator
      .dispatch(existing("adopt:foreign", foreign.id))
      .pipe(Effect.flip);
    assert.include(errorCause(foreignError), "does not belong");
    const instanceError = yield* orchestrator
      .dispatch(existing("adopt:wrong-instance", source.id))
      .pipe(Effect.flip);
    assert.include(errorCause(instanceError), "different instance");
    assert.equal(yield* sink.latestSequence({ threadId }), sequence);
    assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), before);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("detaches an idle source session and schedules its shutdown", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:adopt-detach");
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const source = yield* createSource(threadId);
    const sessionId = ProviderSessionId.make("provider-session:adopt-source");
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:adopt:source-session"),
          type: "provider-session.attached",
          threadId,
          driver: openCodeDriver,
          providerInstanceId: openCodeInstance,
          occurredAt: now,
          payload: {
            id: sessionId,
            driver: openCodeDriver,
            providerInstanceId: openCodeInstance,
            status: "ready",
            cwd: "/repo",
            model: openCodeSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
        },
        {
          id: EventId.make("event:adopt:bind-source"),
          type: "provider-thread.updated",
          threadId,
          driver: openCodeDriver,
          providerInstanceId: openCodeInstance,
          occurredAt: now,
          payload: { ...source, providerSessionId: sessionId, status: "idle", updatedAt: now },
        },
      ],
    });
    const before = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(before.thread.activeProviderThreadId, source.id);
    assert.isTrue(before.providerSessions.some((session) => session.id === sessionId));
    const command = claudeCommand(threadId, source.id);
    const result = yield* orchestrator.dispatch(command);
    assert.isTrue(
      result.storedEvents.some(
        ({ event }) =>
          event.type === "provider-session.detached" &&
          event.payload.providerSessionId === sessionId,
      ),
    );
    const after = yield* orchestrator.getThreadProjection(threadId);
    assert.isFalse(after.providerSessions.some((session) => session.id === sessionId));
    const effects = yield* outbox.listByCommandId(command.commandId);
    assert.isTrue(
      effects.some(
        (effect) =>
          effect.status === "pending" &&
          effect.request.type === "provider-session.detach" &&
          effect.request.providerSessionId === sessionId,
      ),
    );
  }).pipe(Effect.provide(layerTest)),
);
