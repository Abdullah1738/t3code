import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AnalyticsEvent,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Analytics from "../ardud/analytics/Analytics.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Registry from "./ProviderAdapterRegistry.ts";
import * as Harness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-6-astra" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Queue planning must not start a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

it.effect(
  "logs an idle held queue once per thread and reason, then again after ten minutes",
  () => {
    const rows: AnalyticsEvent[] = [];
    const database = Sqlite.layerMemory;
    const analytics = Layer.mock(Analytics.Analytics)({
      record: (row) =>
        Effect.sync(() => {
          rows.push(row);
        }),
    });
    const layer = Layer.mergeAll(
      ProjectionStore.layer.pipe(Layer.provide(database)),
      Harness.layerWithRegistry({ name: "queue-drain" }, Registry.layerFromAdapters([adapter]), {
        databaseLayer: database,
        runEffectWorker: false,
      }),
    ).pipe(Layer.provideMerge(analytics));
    return Effect.gen(function* () {
      const engine = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:queue-drain");
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:queue-drain"),
        threadId,
        projectId: ProjectId.make("project:queue-drain"),
        title: "Queue",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      for (const suffix of ["active", "queued"]) {
        yield* engine.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(suffix),
          threadId,
          messageId: MessageId.make(suffix),
          text: suffix,
          attachments: [],
          createdBy: "agent",
          creationSource: "mcp",
          dispatchMode: { type: suffix === "active" ? "defer_start" : "queue_after_active" },
        });
      }
      const before = yield* engine.getThreadProjection(threadId);
      const now = yield* DateTime.now;
      for (const run of before.runs) {
        yield* store.apply({
          id: EventId.make(`seed:${run.id}`),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload:
            run.status === "queued"
              ? { ...run, queueHeld: true, modelSelection: { instanceId, model: "retired-model" } }
              : { ...run, status: "completed", completedAt: now },
        });
      }
      yield* engine.resumeQueuedRuns;
      yield* engine.resumeQueuedRuns;
      const skipped = () => rows.filter((row) => row.kind === "orchestration.queue_drain_skipped");
      assert.lengthOf(skipped(), 1);
      assert.equal(skipped()[0]!.threadId, threadId);
      assert.deepInclude(skipped()[0]!.props, {
        reason: "no_eligible",
        queuedCount: 1,
        heldCount: 1,
        headRunId: before.runs[1]!.id,
        headOrdinal: 2,
      });
      yield* TestClock.adjust("10 minutes");
      yield* engine.resumeQueuedRuns;
      assert.lengthOf(skipped(), 2);
      assert.equal((yield* engine.getThreadProjection(threadId)).runs[1]!.status, "queued");
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each([
  ["mcp", false, true],
  ["server", false, true],
  ["provider", false, true],
  ["mcp", true, true],
  ["server", true, true],
  ["provider", true, true],
  ["mcp", false, false],
] as const)("%s queue delivery (stopped=%s, older head held=%s)", ([source, stopped, headHeld]) => {
  const database = Sqlite.layerMemory;
  const layer = Layer.mergeAll(
    ProjectionStore.layer.pipe(Layer.provide(database)),
    Harness.layerWithRegistry(
      { name: "queue-hold-inheritance" },
      Registry.layerFromAdapters([adapter]),
      {
        databaseLayer: database,
        runEffectWorker: false,
      },
    ),
  );
  return Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:queue-inheritance");
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create:queue-inheritance"),
      threadId,
      projectId: ProjectId.make("project:queue-inheritance"),
      title: "Queue",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const send = (
      id: string,
      mode: "defer_start" | "queue_after_active",
      creationSource: "mcp" | "server" | "provider" = "mcp",
    ) =>
      engine.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(id),
        threadId,
        messageId: MessageId.make(id),
        text: id,
        attachments: [],
        createdBy: creationSource === "server" ? "system" : "agent",
        creationSource,
        dispatchMode: { type: mode },
      });
    yield* send("first", "defer_start");
    yield* send("old-held", "queue_after_active");
    const before = yield* engine.getThreadProjection(threadId);
    const now = yield* DateTime.now;
    for (const run of before.runs)
      yield* store.apply({
        id: EventId.make(`seed:${run.id}`),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload:
          run.status === "queued"
            ? {
                ...run,
                queueHeld: headHeld,
                modelSelection: headHeld ? { instanceId, model: "retired-model" } : modelSelection,
              }
            : { ...run, status: "completed", completedAt: now },
      });
    yield* send("fresh-active", "defer_start");
    const active = (yield* engine.getThreadProjection(threadId)).runs.at(-1)!;
    assert.notEqual(active.status, "queued");
    if (stopped) {
      yield* engine.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("stop"),
        threadId,
        runId: active.id,
      });
      // Recreate a provider update already in flight when Stop committed.
      yield* store.apply({
        id: EventId.make("late-active"),
        type: "run.updated",
        threadId,
        runId: active.id,
        occurredAt: now,
        payload: active,
      });
    }
    yield* send("fresh-queued", "queue_after_active", source);
    let projection = yield* engine.getThreadProjection(threadId);
    const fresh = projection.runs.at(-1)!;
    assert.equal(fresh.status, "queued");
    assert.equal(fresh.queueHeld === true, stopped);
    assert.equal(projection.runs.find((run) => run.id === before.runs[1]!.id)!.queueHeld, headHeld);
    yield* store.apply({
      id: EventId.make("complete-active"),
      type: "run.updated",
      threadId,
      runId: active.id,
      occurredAt: now,
      payload: { ...active, status: "completed", completedAt: now },
    });
    yield* engine.resumeQueuedRuns;
    projection = yield* engine.getThreadProjection(threadId);
    assert.equal(
      projection.runs.find((run) => run.id === fresh.id)!.status,
      stopped || !headHeld ? "queued" : "starting",
    );
    const older = projection.runs.find((run) => run.id === before.runs[1]!.id)!;
    assert.equal(older.queueHeld, headHeld);
    assert.equal(older.status, headHeld ? "queued" : "starting");
    // A head awaiting provider admission still owns the thread on the next pass.
    yield* engine.resumeQueuedRuns;
    assert.equal(
      (yield* engine.getThreadProjection(threadId)).runs.find((run) => run.id === fresh.id)!.status,
      stopped || !headHeld ? "queued" : "starting",
    );
  }).pipe(Effect.provide(layer));
});
