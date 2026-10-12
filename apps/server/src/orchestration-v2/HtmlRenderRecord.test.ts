import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { createAttachmentId } from "../attachmentStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
// No effect worker: the run stays where the test puts it.
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "html-render-record" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const page = (threadId: ThreadId, title: string) => ({
  attachmentId: createAttachmentId(threadId, "html")!,
  title,
  height: 320,
});

/** A thread with one running turn, as a provider calling html_render has. */
const runningThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:html-render-record"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}`),
      text: "Chart this",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:running`),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "running", startedAt: now },
    });
    return run;
  });

const record = (threadId: ThreadId, runId: RunId, htmlRender: ReturnType<typeof page>) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator.dispatch({
      type: "html_render.record",
      commandId: CommandId.make(`command:html-render:${htmlRender.attachmentId}`),
      threadId,
      runId,
      htmlRender,
    }),
  );

it.effect("records published pages in the calling run, and only that thread's", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:html-render");
    const run = yield* runningThread(threadId);
    const chart = page(threadId, "Chart");
    const table = page(threadId, "Table");

    yield* record(threadId, run.id, chart);
    yield* record(threadId, run.id, table);
    // A retried publish replays its command and records nothing new.
    yield* record(threadId, run.id, chart);
    // A page another thread published never shows here.
    const foreign = yield* record(
      threadId,
      run.id,
      page(ThreadId.make("thread:other"), "Other"),
    ).pipe(Effect.flip);
    assert.include(String(foreign.cause), "belongs to another thread");

    const projection = yield* orchestrator.getThreadProjection(threadId);
    const recorded = projection.visibleTurnItems.flatMap(({ item }) =>
      item.type === "html_render" ? [item] : [],
    );
    assert.deepEqual(
      recorded.map((item) => item.htmlRender),
      [chart, table],
    );
    for (const item of recorded) {
      assert.equal(item.runId, run.id);
      assert.equal(item.nodeId, run.rootNodeId);
      assert.equal(item.status, "completed");
    }

    // Deleting the thread deletes its pages, through either store path.
    const attachmentIds = yield* projections.getThreadAttachmentIds(threadId);
    assert.sameMembers([...attachmentIds], [chart.attachmentId, table.attachmentId]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a page that lands after the thread was deleted or its run ended", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const deletedThreadId = ThreadId.make("thread:html-render-deleted");
    const deletedRun = yield* runningThread(deletedThreadId);
    // html_render read the live run, then the user deleted the thread.
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete:html-render"),
      threadId: deletedThreadId,
    });
    const late = yield* record(deletedThreadId, deletedRun.id, page(deletedThreadId, "Late")).pipe(
      Effect.flip,
    );
    assert.include(String(late.cause), "was deleted");

    const endedThreadId = ThreadId.make("thread:html-render-ended");
    const endedRun = yield* runningThread(endedThreadId);
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("event:html-render-ended:completed"),
      type: "run.updated",
      threadId: endedThreadId,
      runId: endedRun.id,
      occurredAt: now,
      payload: { ...endedRun, status: "completed", startedAt: now, completedAt: now },
    });
    const ended = yield* record(endedThreadId, endedRun.id, page(endedThreadId, "Late")).pipe(
      Effect.flip,
    );
    assert.include(String(ended.cause), "is not running");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a run that never started in the thread", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:html-render-unknown-run");
    yield* runningThread(threadId);
    const missing = yield* record(
      threadId,
      RunId.make("run:not-this-thread"),
      page(threadId, "Chart"),
    ).pipe(Effect.flip);
    assert.include(String(missing.cause), "is not running in this thread");
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${threadId} AND type = 'html_render'
    `;
    assert.equal(rows[0]?.count, 0);
  }).pipe(Effect.provide(layerTest)),
);
