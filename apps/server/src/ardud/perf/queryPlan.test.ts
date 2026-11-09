import type * as SqlError from "effect/sql/SqlError";
import type { AuthSessionRepositoryError } from "../../persistence/Errors.ts";
import * as ShellQueries from "../../orchestration-v2/ShellQueries.ts";
import * as IdSetQueries from "../../orchestration-v2/IdSetQueries.ts";
import * as Projects from "../../orchestration-v2/ProjectStore.ts";
import * as Auth from "../../persistence/AuthSessions.ts";
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
  RunId,
  AuthSessionId,
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
  Projects.layer.pipe(Layer.provide(database)),
  Auth.layer.pipe(Layer.provide(database)),
);
it.effect(
  "interactive query registry rejects new scans, archive access and request sorts",
  () =>
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
      const ids = Array.from({ length: 40_001 }, (_, i) => ThreadId.make(`id-${i}`));
      ids.push(threadId, threadId, ThreadId.make("quote'comma,?"));
      const runIds = ids.map((id) => RunId.make(id));
      const projects = yield* Projects.ProjectStoreV2;
      const auth = yield* Auth.AuthSessionRepository;
      const registry: Array<{
        route: string;
        run: Effect.Effect<
          unknown,
          | Projection.ProjectionStoreV2Error
          | Store.KanbanStoreError
          | Projects.ProjectStoreV2Error
          | AuthSessionRepositoryError
          | SqlError.SqlError
        >;
      }> = [
        { route: "shell.runs", run: ShellQueries.selectShellRunRows(sql, ids) },
        { route: "shell.counts", run: ShellQueries.selectShellRunItemCounts(sql, ids) },
        {
          route: "shell.providers.large",
          run: ShellQueries.selectShellProviderThreadRows(sql, ids),
        },
        {
          route: "shell.providers",
          run: ShellQueries.selectShellProviderThreadRows(sql, [threadId]),
        },
        {
          route: "turn-start.scopes.singleton",
          run: IdSetQueries.checkpointScopes(sql, threadId, [threadId]),
        },
        {
          route: "pending-input.nodes.singleton",
          run: IdSetQueries.nodes(sql, threadId, [threadId], false),
        },
        {
          route: "shell.pending",
          run: ShellQueries.selectShellPendingTurnItemRows(sql, ids, runIds),
        },
        { route: "turn-start.scopes", run: IdSetQueries.checkpointScopes(sql, threadId, ids) },
        { route: "turn-start.history", run: projection.getTurnStartHistory(threadId, runIds) },
        { route: "pending-input.nodes", run: IdSetQueries.nodes(sql, threadId, ids, false) },
        { route: "rollback.nodes", run: IdSetQueries.nodes(sql, threadId, ids, true) },
        {
          route: "projects.selection",
          run: projects.list({ projectIds: ids.map((id) => ProjectId.make(id)) }),
        },
        {
          route: "auth.connected",
          run: auth.listActive({
            now,
            connectedSessionIds: ids.map((id) => AuthSessionId.make(id)),
          }),
        },
        {
          route: "shell.selection",
          run: projection.getShellSnapshot({ location: "active", limit: 500 }),
        },
        {
          // The client shell route (HTTP + WS pages) with idle subagents omitted.
          route: "shell.client-selection",
          run: projection.getShellSnapshot({
            location: "active",
            limit: 500,
            omitIdleSubagents: true,
          }),
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
      // Generate only synthetic rows in the isolated in-memory database. Cloning the
      // validated payload keeps this regression independent of evolving schemas.
      yield* sql`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, provider_instance_id,
       runtime_mode, interaction_mode, active_provider_thread_id, created_at,
       updated_at, archived_at, deleted_at, payload_json)
      SELECT 'scale-' || value, project_id, title, default_provider, provider_instance_id,
        runtime_mode, interaction_mode, active_provider_thread_id, created_at, updated_at,
        archived_at, deleted_at,
        json_set(payload_json, '$.id', 'scale-' || value, '$.lineage.rootThreadId', 'scale-' || value)
      FROM orchestration_v2_projection_threads CROSS JOIN json_each(${JSON.stringify(ids.slice(0, 40_001))})
      WHERE thread_id = ${threadId}`;
      const snapshot = yield* projection.getShellSnapshot();
      assert.equal(snapshot.threads.length, 40_002);
      const rejected: unknown[] = [];
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
          if (
            ![
              "shell.selection",
              "shell.client-selection",
              "board.thread-state",
              "boards.tallies",
              "discussion.messages",
            ].includes(entry.route)
          )
            assert.isAtMost((statement.match(/\?/g) ?? []).length, 2, `${entry.route} bind count`);
          const plan = yield* sql.unsafe<{ detail: string }>(
            `EXPLAIN QUERY PLAN ${statement}`,
            Array.from({ length: (statement.match(/\?/g) ?? []).length }, () => null),
          );
          if (entry.route.endsWith(".singleton")) {
            assert.isTrue(
              plan.some(
                (row) =>
                  /USING INDEX sqlite_autoindex_.*_1/.test(row.detail) &&
                  /(?:scope_id|node_id)=\?/.test(row.detail),
              ),
              entry.route,
            );
          }
          const findings = violations(query, plan);
          console.log(
            JSON.stringify({ route: entry.route, queryHash: hash(statement), plan, findings }),
          );
          const remaining = unreviewed(query, findings, queryPlanExceptions);
          if (remaining.length)
            rejected.push({ route: entry.route, queryHash: hash(statement), findings: remaining });
        }
      }
      assert.deepEqual(rejected, []);
    }).pipe(Effect.provide(layer)),
  { timeout: 120_000 },
);

it.effect(
  "ID sets preserve membership, duplicates, empty lists and thread isolation above 40k",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("owner");
      const member = ThreadId.make("quote'comma,?");
      const ids = [
        ...Array.from({ length: 40_001 }, (_, i) => ThreadId.make(`absent-${i}`)),
        member,
        member,
      ];
      yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${member}, ${member}, 1, 'synthetic', 'running', '2026-01-01', '{}')`;
      yield* sql`INSERT INTO ardud_shell_item_counts (thread_id, run_key, item_count)
      VALUES (${member}, ${member}, 7)`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
      (provider_thread_id, thread_id, provider, status, updated_at, payload_json)
      VALUES (${member}, ${member}, 'synthetic', 'running', '2026-01-01', '{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_nodes
      (node_id, thread_id, root_node_id, kind, status, payload_json)
      VALUES (${member}, ${threadId}, ${member}, 'synthetic', 'running', '{}'),
        ('excluded', ${threadId}, 'excluded', 'synthetic', 'running', '{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_checkpoint_scopes
      (scope_id, thread_id, node_id, kind, ordinal_within_parent, advances_app_run_count, created_at, payload_json)
      VALUES (${member}, ${threadId}, ${member}, 'synthetic', 1, 0, '2026-01-01', '{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
      VALUES ('pending', ${member}, NULL, 1, 'command_execution', 'running', '2026-01-01', '{}'),
        ('active', ${member}, ${member}, 2, 'file_search', 'running', '2026-01-01', '{}')`;
      assert.lengthOf(yield* ShellQueries.selectShellRunRows(sql, ids), 1);
      assert.equal((yield* ShellQueries.selectShellRunItemCounts(sql, ids))[0]?.item_count, 8);
      assert.lengthOf(yield* ShellQueries.selectShellProviderThreadRows(sql, ids), 1);
      assert.lengthOf(yield* ShellQueries.selectShellPendingTurnItemRows(sql, ids, ids), 2);
      assert.lengthOf(yield* IdSetQueries.checkpointScopes(sql, threadId, ids), 1);
      for (const ordered of [false, true]) {
        assert.lengthOf(yield* IdSetQueries.nodes(sql, threadId, ids, ordered), 1);
        assert.deepEqual(yield* IdSetQueries.nodes(sql, ThreadId.make("other"), ids, ordered), []);
        assert.deepEqual(yield* IdSetQueries.nodes(sql, threadId, [], ordered), []);
      }
      assert.deepEqual(yield* ShellQueries.selectShellRunRows(sql, []), []);
      assert.deepEqual(yield* ShellQueries.selectShellProviderThreadRows(sql, []), []);
      assert.deepEqual(yield* ShellQueries.selectShellRunItemCounts(sql, []), []);
      assert.deepEqual(yield* ShellQueries.selectShellPendingTurnItemRows(sql, [], []), []);
      assert.deepEqual(yield* IdSetQueries.checkpointScopes(sql, threadId, []), []);
    }).pipe(Effect.provide(layer)),
);
