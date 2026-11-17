import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Projection from "./ProjectionStore.ts";
import * as RecoverySnapshot from "../ardud/recovery/RecoverySnapshot.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessions from "./ProviderSessionManager.ts";
import * as ControlStore from "../ardud/control/ControlStore.ts";
import * as ExecutionIdentity from "../ardud/identity/ExecutionIdentity.ts";

const sqlLayer = Projection.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
const later = DateTime.makeUnsafe("2026-01-02T00:00:00Z");

const seed = Effect.fn("test.seedActiveThreadId")(function* (input: {
  id: string;
  project?: string;
  archived?: boolean;
  deleted?: boolean;
  imported?: boolean;
  updatedAt?: DateTime.Utc;
  parent?: string;
}) {
  const store = yield* Projection.ProjectionStoreV2;
  const id = ThreadId.make(input.id);
  const thread = {
    createdBy: "user" as const,
    creationSource: "web" as const,
    id,
    projectId: ProjectId.make(input.project ?? "project-a"),
    title: input.id,
    providerInstanceId: ProviderInstanceId.make("synthetic"),
    modelSelection: { instanceId: ProviderInstanceId.make("synthetic"), model: "synthetic" },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: input.parent === undefined ? null : ThreadId.make(input.parent),
      relationshipToParent: input.parent === undefined ? null : ("subagent" as const),
      rootThreadId: ThreadId.make(input.parent ?? input.id),
    },
    forkedFrom: null,
    ...(input.imported ? { historyOrigin: "v1_import" as const } : {}),
    createdAt: now,
    updatedAt: input.updatedAt ?? now,
    archivedAt: input.archived ? now : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  yield* store.apply({
    id: EventId.make(`created-${id}`),
    type: "thread.created",
    threadId: id,
    occurredAt: now,
    payload: thread,
  });
  if (input.deleted)
    yield* store.apply({
      id: EventId.make(`deleted-${id}`),
      type: "thread.deleted",
      threadId: id,
      occurredAt: now,
      payload: { ...thread, deletedAt: now },
    });
});

it.effect.each([
  ["SQL", sqlLayer],
  ["memory", Projection.layerMemory],
] as const)("%s active IDs preserve the shell set and order", ([implementation, layer]) =>
  Effect.gen(function* () {
    const store = yield* Projection.ProjectionStoreV2;
    const ids = () => store.listActiveThreadIds();
    assert.deepEqual(yield* ids(), []);
    assert.deepEqual((yield* store.getShellSnapshot({ location: "active" })).threads, []);
    // Deliberately insert out of order, with both timestamp and ID ties to break.
    yield* seed({ id: "0-late", updatedAt: later });
    yield* seed({ id: "c-active", project: "project-b" });
    yield* seed({ id: "a-active" });
    yield* seed({ id: "archived", archived: true });
    yield* seed({ id: "deleted", deleted: true });
    yield* seed({ id: "archived-deleted", archived: true, deleted: true });
    yield* seed({ id: "b-imported", project: "project-legacy", imported: true });
    yield* seed({ id: "imported-archived", imported: true, archived: true });
    yield* seed({ id: "imported-deleted", imported: true, deleted: true });
    yield* seed({ id: "idle-child", parent: "a-active" });
    const expected = (
      implementation === "SQL"
        ? ["a-active", "b-imported", "c-active", "idle-child", "0-late"]
        : ["0-late", "a-active", "b-imported", "c-active", "idle-child"]
    ).map((id) => ThreadId.make(id));
    assert.deepEqual(yield* ids(), expected);
    assert.deepEqual(
      yield* ids(),
      (yield* store.getShellSnapshot({ location: "active" })).threads.map((thread) => thread.id),
    );
    if (implementation === "SQL") {
      const sql = Option.getOrThrow(yield* Effect.serviceOption(SqlClient.SqlClient));
      // Legacy payloads, rather than the optional lookup column, define shell archive status.
      yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = ${DateTime.formatIso(now)} WHERE thread_id = 'b-imported'`;
      yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = NULL WHERE thread_id = 'imported-archived'`;
      assert.deepEqual(yield* ids(), expected);
      assert.deepEqual(
        yield* ids(),
        (yield* store.getShellSnapshot({ location: "active" })).threads.map((thread) => thread.id),
      );
    }
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  ["SQL", sqlLayer],
  ["memory", Projection.layerMemory],
] as const)("%s recovery pages match the old sorted set, including non-id cursors", ([, layer]) =>
  Effect.gen(function* () {
    const store = yield* Projection.ProjectionStoreV2;
    for (let n = 0; n < 35; n++)
      yield* seed({
        id: `page-${String(n).padStart(3, "0")}`,
        archived: n % 7 === 0,
        deleted: n % 11 === 0,
      });
    yield* seed({ id: "quote'comma,?" });
    const all = [...(yield* store.listActiveThreadIds())].sort();
    for (const cursor of [null, "", "page-00", "page-004", "page-004x", "page-020", "zzz"]) {
      const remaining = all.filter((id) => cursor === null || id > cursor);
      for (const limit of [1, 5, 50, 500]) {
        const ids = yield* store.pageActiveThreadIds(cursor, limit + 1);
        const expected = remaining.slice(0, limit);
        assert.deepEqual(ids.slice(0, limit), expected);
        assert.equal(
          ids.length > limit ? ids[limit - 1] : null,
          remaining.length > limit ? expected.at(-1) : null,
        );
      }
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("SQL active IDs select only IDs and never read or decode shells", () =>
  Effect.gen(function* () {
    const store = yield* Projection.ProjectionStoreV2;
    yield* seed({ id: "active" });
    const statements: string[] = [];
    const spans: string[] = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span.name);
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
          end(endTime, exit);
          const query = span.attributes.get("db.query.text");
          if (typeof query === "string") statements.push(query);
        };
        return span;
      },
    });
    assert.deepEqual(
      yield* store.listActiveThreadIds().pipe(NodeSqliteClient.readOnly, Effect.withTracer(tracer)),
      [ThreadId.make("active")],
    );
    assert.include(spans, "ProjectionStore.listActiveThreadIds");
    assert.notInclude(spans, "ProjectionStore.readShellSnapshotRows");
    assert.notInclude(spans, "ProjectionStore.decodeShellSnapshot");
    const reads = statements.filter((query) => /SELECT/i.test(query));
    assert.lengthOf(reads, 1);
    assert.match(reads[0]!, /SELECT thread_id FROM orchestration_v2_projection_threads/);
    assert.notMatch(reads[0]!, /JOIN|projection_runs|projection_turn_items|provider/i);
  }).pipe(Effect.provide(sqlLayer)),
);

it.live.skipIf(process.env.T3_BENCH_ACTIVE_THREAD_IDS !== "1")(
  "benchmarks recovery threadIds(false) on 4,000 threads with run and item history",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "active-thread-ids-bench-" });
        const database = Sqlite.layerFromPath(`${directory}/synthetic.sqlite`);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const store = yield* Projection.ProjectionStoreV2;
          yield* seed({ id: "bench-seed", archived: true });
          yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode,
          interaction_mode, created_at, updated_at, archived_at, payload_json)
        SELECT value, 'project-' || (key % 10), title, default_provider, provider_instance_id,
          runtime_mode, interaction_mode, created_at, updated_at,
          CASE WHEN key < 400 THEN NULL ELSE archived_at END,
          json_set(payload_json, '$.id', value, '$.lineage.rootThreadId', value,
            '$.projectId', 'project-' || (key % 10),
            '$.archivedAt', CASE WHEN key < 400 THEN NULL ELSE archived_at END)
        FROM orchestration_v2_projection_threads CROSS JOIN json_each(${JSON.stringify(Array.from({ length: 3999 }, (_, i) => `bench-${String(i).padStart(4, "0")}`))})
        WHERE thread_id = 'bench-seed'`;
          yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
        SELECT t.thread_id || '-run-' || value, t.thread_id, value, 'synthetic', 'completed',
          '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z',
          json_object('startedAt', '2026-01-01T00:00:00Z', 'padding', printf('%01024d', 0))
        FROM orchestration_v2_projection_threads t
        CROSS JOIN json_each(${JSON.stringify(Array.from({ length: 20 }, (_, i) => i + 1))})`;
          yield* sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
        SELECT run_id || '-item-' || value, thread_id, run_id, ordinal * 2 + value,
          'tool_call', 'completed', requested_at, json_object('padding', printf('%01024d', 0))
        FROM orchestration_v2_projection_runs CROSS JOIN json_each('[0,1]')`;
          for (const [table, expected] of [
            ["orchestration_v2_projection_threads", 4000],
            ["orchestration_v2_projection_runs", 80000],
            ["orchestration_v2_projection_turn_items", 160000],
          ] as const) {
            const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM ${sql(table)}`;
            assert.strictEqual(rows[0]?.count, expected);
          }
          const oldIds = () =>
            store
              .getShellSnapshot({ location: "active" })
              .pipe(Effect.map((snapshot) => snapshot.threads.map((thread) => thread.id)));
          assert.deepEqual(yield* store.listActiveThreadIds(), yield* oldIds());
          let oldPath = false;
          const measurements: Record<"old" | "new", number[]> = { old: [], new: [] };
          const tracer = Tracer.make({
            span(options) {
              const span = new Tracer.NativeSpan(options);
              const end = span.end.bind(span);
              span.end = (endTime, exit) => {
                end(endTime, exit);
                if (span.name === "RecoverySnapshot.threadIds") {
                  measurements[oldPath ? "old" : "new"].push(
                    Number(endTime - span.startTime) / 1e6,
                  );
                }
              };
              return span;
            },
          });
          const recovery = RecoverySnapshot.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(ThreadManagement.ThreadManagementService)({
                  pageActiveThreadIds: (cursor, limit) =>
                    (oldPath ? oldIds() : store.listActiveThreadIds()).pipe(
                      Effect.map((ids) =>
                        [...ids]
                          .sort()
                          .filter((id) => cursor === null || id > cursor)
                          .slice(0, limit),
                      ),
                      Effect.orDie,
                    ),
                  listActiveThreadIds: () =>
                    (oldPath ? oldIds() : store.listActiveThreadIds()).pipe(Effect.orDie),
                  getThreadShell: () => Effect.succeed(null),
                }),
                Layer.mock(ControlStore.ControlStore)({}),
                Layer.mock(ExecutionIdentity.ExecutionIdentity)({
                  currentNative: () => Effect.succeed(new Map()),
                }),
                Layer.mock(Orchestrator.OrchestratorV2)({}),
                Layer.mock(ProviderSessions.ProviderSessionManagerV2)({}),
              ),
            ),
          );
          yield* Effect.gen(function* () {
            const snapshot = yield* RecoverySnapshot.RecoverySnapshot;
            for (let iteration = 0; iteration < 210; iteration++) {
              for (const useOld of [true, false]) {
                oldPath = useOld;
                yield* snapshot
                  .page({ active: false, cursor: null, limit: 1 })
                  .pipe(NodeSqliteClient.readOnly, Effect.withTracer(tracer));
              }
            }
          }).pipe(Effect.provide(recovery));
          const summarize = (values: number[]) => {
            const sorted = values.slice(10).sort((a, b) => a - b);
            return {
              p50: sorted[Math.ceil(sorted.length * 0.5) - 1]!,
              p99: sorted[Math.ceil(sorted.length * 0.99) - 1]!,
            };
          };
          const result = {
            threads: 4000,
            active: 400,
            runs: 80000,
            items: 160000,
            storage: "file-backed WAL",
            warmup: 10,
            samples: 200,
            oldMs: summarize(measurements.old),
            newMs: summarize(measurements.new),
          };
          yield* Console.log(JSON.stringify(result));
          assert.isBelow(result.newMs.p99, 250);
        }).pipe(Effect.provide(Projection.layer.pipe(Layer.provideMerge(database))));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  600_000,
);
