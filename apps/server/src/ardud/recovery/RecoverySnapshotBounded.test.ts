import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  RunId,
  RunAttemptId,
  ProviderInstanceId,
  MessageId,
  NodeId,
  OrchestrationV2RunJson,
  OrchestrationV2AppThreadJson,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { idleThreadProjection, liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as Projection from "../../orchestration-v2/ProjectionStore.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as Sessions from "../../orchestration-v2/ProviderSessionManager.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Control from "../control/ControlStore.ts";
import * as Identity from "../identity/ExecutionIdentity.ts";
import * as Snapshot from "./RecoverySnapshot.ts";

const at = DateTime.makeUnsafe("2026-11-15T00:00:00Z");
const iso = DateTime.formatIso(at);
const id = ThreadId.make("many-runs");
const encodeRun = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2RunJson));
const encodeThread = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2AppThreadJson));
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projection = yield* Projection.ProjectionStoreV2;
  const control = yield* Control.make;
  const shell = { ...liveThreadShell(id), updatedAt: at };
  yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
    thread_id: id,
    project_id: shell.projectId,
    title: id,
    default_provider: "codex",
    provider_instance_id: "codex",
    runtime_mode: "full-access",
    interaction_mode: "default",
    active_provider_thread_id: null,
    created_at: iso,
    updated_at: iso,
    archived_at: null,
    deleted_at: null,
    payload_json: yield* encodeThread(idleThreadProjection(shell).thread),
  })}`;
  const run = {
    id: RunId.make("running"),
    threadId: id,
    ordinal: 1,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: shell.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make("message"),
    rootNodeId: NodeId.make("node"),
    activeAttemptId: RunAttemptId.make("attempt-current"),
    status: "running" as const,
    queuePosition: null,
    requestedAt: at,
    startedAt: at,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const payload = yield* encodeRun(run);
  yield* sql`INSERT INTO orchestration_v2_projection_runs
    (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, payload_json)
    SELECT CASE WHEN value = 1 THEN 'running' ELSE 'terminal-' || value END, ${id}, value, 'codex', 'codex',
      CASE WHEN value = 1 THEN 'running' ELSE 'completed' END, ${iso},
      json_set(${payload}, '$.id', CASE WHEN value = 1 THEN 'running' ELSE 'terminal-' || value END,
        '$.ordinal', value, '$.status', CASE WHEN value = 1 THEN 'running' ELSE 'completed' END)
    FROM json_each(${JSON.stringify(Array.from({ length: 2001 }, (_, n) => n + 1))})`;
  yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
    (runtime_request_id, thread_id, node_id, provider_turn_id, kind, status, created_at, resolved_at, payload_json)
    VALUES ('pending', ${id}, 'node', NULL, 'user_input', 'pending', ${iso}, NULL,
      ${JSON.stringify({
        id: "pending",
        nodeId: "node",
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        createdAt: iso,
        resolvedAt: null,
        responseCapability: { type: "message" },
      })})`;
  // Invalid settled records prove recovery never decodes historical request bodies.
  yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
    (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
    SELECT 'resolved-' || value, ${id}, 'old', 'user_input', 'resolved', ${iso}, '{}'
    FROM json_each(${JSON.stringify(Array.from({ length: 2000 }, (_, n) => n))})`;
  const reads: number[] = [];
  const deps = Layer.mergeAll(
    Layer.succeed(Control.ControlStore, control),
    Layer.mock(Identity.ExecutionIdentity)({ currentNative: () => Effect.succeed(new Map()) }),
    Layer.mock(Sessions.ProviderSessionManagerV2)({}),
    Layer.mock(Threads.ThreadManagementService)({
      listActiveThreadIds: () => projection.listActiveThreadIds().pipe(Effect.orDie),
      pageActiveThreadIds: (cursor, limit) =>
        projection.pageActiveThreadIds(cursor, limit).pipe(Effect.orDie),
      getThreadShell: (tid) => projection.getThreadShell(tid).pipe(Effect.orDie),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadRecords: (tid, fields, filter) =>
        projection.getThreadRecords(tid, fields, filter).pipe(
          Effect.tap((records) =>
            Effect.sync(() => {
              if ("runs" in records) reads.push((records.runs as ReadonlyArray<unknown>).length);
            }),
          ),
          Effect.orDie,
        ),
    }),
  );
  const snapshot = yield* Snapshot.RecoverySnapshot.pipe(
    Effect.provide(Snapshot.layer.pipe(Layer.provide(deps))),
  );
  return { snapshot, sql, projection, control, reads, deps, payload };
});

it.effect(
  "selects the oldest running run ahead of 2,000 newer terminal runs and only pending requests",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture;
      const page = yield* h.snapshot.page({ active: false, cursor: null, limit: 1 });
      const entry = page.threads[0]!;
      assert.deepEqual(entry.run, {
        id: "running",
        status: "running",
        startedAt: iso,
        lastProgressAt: iso,
      });
      assert.equal(entry.attemptId, "attempt-current");
      assert.deepEqual(entry.pendingRequests, [{ id: "pending", kind: "user_input" }]);
      assert.deepEqual(h.reads, [1]);
      yield* h.sql`UPDATE orchestration_v2_projection_runs SET status = 'completed',
      payload_json = json_set(payload_json, '$.status', 'completed') WHERE run_id = 'running'`;
      const idle = yield* h.snapshot.page({ active: false, cursor: null, limit: 1 });
      assert.equal(idle.threads[0]!.run!.id, "terminal-2001");
      assert.deepEqual(h.reads, [1, 1]);
    }).pipe(
      Effect.provide(
        Projection.layer.pipe(
          Layer.provideMerge(Sqlite.layerMemory),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
);

it.effect("SQL live pages preserve union, duplicate and absent cursor semantics", () =>
  Effect.gen(function* () {
    const h = yield* fixture;
    yield* h.sql`INSERT INTO orchestration_v2_projection_runtime_requests
      (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
      SELECT 'live-' || value, value, 'node', 'user_input', 'pending', ${iso}, '{}'
      FROM json_each(${JSON.stringify(["a", "b", "many-runs", "quote'comma,?", "z"])})`;
    const old = [...new Set(yield* h.control.liveThreadIds())].sort();
    for (const cursor of [null, "", "a", "many-run", "many-runs", "x", "zz"]) {
      const remaining = old.filter((tid) => cursor === null || tid > cursor);
      for (const limit of [1, 2, 5, 50, 500]) {
        const page = yield* h.control.pageLiveThreadIds(cursor, limit + 1);
        assert.deepEqual(page, remaining.slice(0, limit + 1));
        assert.equal(
          page.length > limit ? page[limit - 1] : null,
          remaining.length > limit ? remaining[limit - 1] : null,
        );
      }
    }
  }).pipe(
    Effect.provide(
      Projection.layer.pipe(
        Layer.provideMerge(Sqlite.layerMemory),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

it.effect(
  "keeps the active provider and completed child threads while skipping unrelated records",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture;
      const provider = {
        id: "provider-active",
        driver: "codex",
        providerInstanceId: "codex",
        providerSessionId: null,
        appThreadId: id,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: iso,
        updatedAt: iso,
      };
      for (const providerId of ["provider-active", "provider-history"]) {
        yield* h.sql`INSERT INTO orchestration_v2_projection_provider_threads
        (provider_thread_id, thread_id, owner_node_id, provider, provider_session_id, status,
         first_run_ordinal, last_run_ordinal, updated_at, driver, provider_instance_id, payload_json)
        VALUES (${providerId}, ${id}, NULL, 'codex', NULL, 'idle', 1, 1, ${iso}, 'codex', 'codex',
          ${JSON.stringify({ ...provider, id: providerId })})`;
      }
      yield* h.sql`UPDATE orchestration_v2_projection_threads SET active_provider_thread_id='provider-active',
      payload_json=json_set(payload_json,'$.activeProviderThreadId','provider-active') WHERE thread_id=${id}`;
      const child = {
        id: "child-record",
        threadId: id,
        runId: "running",
        parentNodeId: "node",
        origin: "app_owned",
        createdBy: "agent",
        driver: "codex",
        providerInstanceId: "codex",
        providerThreadId: null,
        childThreadId: "finished-child",
        nativeTaskRef: null,
        prompt: "",
        title: null,
        model: null,
        status: "completed",
        result: null,
        startedAt: iso,
        completedAt: iso,
        updatedAt: iso,
      };
      yield* h.sql`INSERT INTO orchestration_v2_projection_subagents
      (subagent_id,thread_id,run_id,parent_node_id,provider,child_thread_id,origin,status,started_at,completed_at,updated_at,payload_json)
      VALUES ('child-record',${id},'running','node','codex','finished-child','app_owned','completed',${iso},${iso},${iso},${JSON.stringify(child)}),
        ('no-child',${id},'running','node','codex',NULL,'provider_native','completed',${iso},${iso},${iso},'{}')`;
      const page = yield* h.snapshot.page({ active: false, cursor: null, limit: 1 });
      assert.equal(page.threads[0]!.driver, "codex");
      assert.equal(page.threads[0]!.runtime, "absent");
      assert.deepEqual(page.threads[0]!.children, [
        { threadId: "finished-child", kind: "app_owned", status: "completed" },
      ]);
      const records = yield* h.projection.getThreadRecords(id, ["providerThreads", "subagents"], {
        providerThreadIds: ["provider-active"],
        subagentsWithChildThreadOnly: true,
      });
      assert.deepEqual(
        records.providerThreads.map((row) => row.id),
        ["provider-active"],
      );
      assert.deepEqual(
        records.subagents.map((row) => row.id),
        ["child-record"],
      );
    }).pipe(
      Effect.provide(
        Projection.layer.pipe(
          Layer.provideMerge(Sqlite.layerMemory),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
);
