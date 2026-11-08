import { hash } from "../../../../../packages/perf-harness/src/metrics.ts";
// @effect-diagnostics globalConsole:off globalConsoleInEffect:off preferSchemaOverJson:off - Preserve raw planner evidence in the offbox log.
import runtime from "../../../../../packages/perf-harness/runtime.json" with { type: "json" };
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  KanbanBoardId,
  KanbanDiscussionId,
} from "@t3tools/contracts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Projection from "../../orchestration-v2/ProjectionStore.ts";
import * as Store from "../kanban/store/KanbanStore.ts";
import { unreviewed, violations } from "../../../../../packages/perf-harness/src/queryPlan.ts";
import { queryPlanExceptions } from "./queryPlanExceptions.ts";
const database = Sqlite.layerMemory;
const layer = Layer.mergeAll(
  database,
  Projection.layer.pipe(Layer.provide(database)),
  Store.layer.pipe(Layer.provide(database)),
);
it.effect("interactive query registry rejects new scans, archive access and request sorts", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const version = yield* sql<{ version: string }>`SELECT sqlite_version() AS version`;
    assert.equal(version[0]?.version, runtime.sqlite, "Pinned SQLite planner version");
    const projection = yield* Projection.ProjectionStoreV2;
    const store = yield* Store.KanbanStore;
    const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
    const threadId = ThreadId.make("synthetic-thread");
    yield* projection.apply({
      id: EventId.make("synthetic-created"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("synthetic-project"),
        title: "Synthetic",
        providerInstanceId: ProviderInstanceId.make("synthetic"),
        modelSelection: { instanceId: ProviderInstanceId.make("synthetic"), model: "synthetic" },
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
    const registry: Array<{route:string;run:Effect.Effect<unknown,Projection.ProjectionStoreV2Error | Store.KanbanStoreError>}> = [
      {
        route: "shell.selection",
        run: projection.getShellSnapshot({ location: "active", limit: 500 }),
      },
      {
        route: "board.thread-state",
        run: projection.getThreadShell(ThreadId.make("synthetic-thread")),
      },
      { route: "boards.tallies", run: store.summaryCards(KanbanBoardId.make("synthetic-board")) },
      {
        route: "discussion.messages",
        run: store.messages(KanbanDiscussionId.make("synthetic-discussion"), { limit: 50 }),
      },
      { route: "boards.tallies", run: store.discussions(KanbanBoardId.make("synthetic-board")) },
    ];
    for (const entry of registry) {
      const statements: string[] = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (time, exit) => {
            end(time, exit);
            const q = span.attributes.get("db.query.text");
            if (typeof q === "string" && /^\s*(?:--[^\n]*\n\s*)*(?:SELECT|WITH)/i.test(q))
              statements.push(q);
          };
          return span;
        },
      });
      yield* entry.run.pipe(Effect.withTracer(tracer));
      assert.isAbove(statements.length, 0, entry.route);
      for (const statement of statements) {
        const query = { route: entry.route, sql: statement, queryHash: hash(statement) };
        const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${statement}`);
        const findings = violations(query, plan);
        console.log(
          JSON.stringify({ route: entry.route, queryHash: hash(statement), plan, findings }),
        );
        assert.deepEqual(unreviewed(query, findings, queryPlanExceptions), [], entry.route);
      }
    }
  }).pipe(Effect.provide(layer)),
);
