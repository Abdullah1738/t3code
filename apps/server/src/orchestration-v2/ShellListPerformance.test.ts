// @effect-diagnostics globalConsole:off globalConsoleInEffect:off - Record seeded before/after timings in the offbox log.
import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import { ShellRunLookupMigration } from "../ardud/persistence/shellRunLookupMigration.ts";
import Migration0068 from "../persistence/Migrations/068_ShellRunLookupIndexes.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Projection from "./ProjectionStore.ts";

const layer = Projection.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect(
  "archive and list candidates preserve shell output without materializing run history",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projection = yield* Projection.ProjectionStoreV2;
      const lookupMigration = yield* ShellRunLookupMigration;
      const threadId = ThreadId.make("seed");
      const projectId = ProjectId.make("seed-project");
      const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
      yield* projection.apply({
        id: EventId.make("seed-created"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Seed",
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
          archivedAt: now,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const ids = Array.from({ length: 1000 }, (_, i) => `seed-${i}`);
      yield* sql`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode,
        interaction_mode, created_at, updated_at, archived_at, payload_json)
      SELECT value, project_id, title, default_provider, provider_instance_id, runtime_mode,
        interaction_mode, created_at, updated_at, CASE WHEN key < 500 THEN archived_at ELSE NULL END,
        json_set(payload_json, '$.id', value, '$.lineage.rootThreadId', value,
          '$.archivedAt', CASE WHEN key < 500 THEN archived_at ELSE NULL END)
      FROM orchestration_v2_projection_threads CROSS JOIN json_each(${JSON.stringify(ids)})
      WHERE thread_id = ${threadId}`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
      SELECT t.thread_id || '-run-' || value, t.thread_id, value, 'synthetic', 'completed',
        '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z',
        json_object('startedAt', '2026-01-01T00:00:00Z', 'padding', printf('%01024d', 0))
      FROM orchestration_v2_projection_threads t
      CROSS JOIN json_each(${JSON.stringify(Array.from({ length: 100 }, (_, i) => i + 1))})`;
      yield* sql`INSERT INTO ardud_shell_item_counts (thread_id, run_key, item_count)
      SELECT thread_id, run_id, 2 FROM orchestration_v2_projection_runs`;
      yield* sql`UPDATE orchestration_v2_projection_runs SET
      status = CASE CAST(substr(thread_id, 6) AS INTEGER) % 6
        WHEN 0 THEN 'running' WHEN 1 THEN 'waiting' WHEN 2 THEN 'queued'
        WHEN 3 THEN 'cancelled' WHEN 4 THEN 'failed' ELSE 'completed' END,
      payload_json = json_set(payload_json, '$.queueHeld', json('true'), '$.startedAt',
        CASE WHEN CAST(substr(thread_id, 6) AS INTEGER) % 6 = 3 THEN NULL
        ELSE '2026-01-01T00:00:00Z' END)
      WHERE ordinal = 100`;
      const activeBefore = yield* projection.getShellSnapshot({ location: "active" });
      const archiveBefore = yield* projection.getShellSnapshot({ location: "archive" });
      const candidatesBefore = yield* projection.getThreadListCandidates(projectId, {
        limit: 1000,
      });
      yield* sql`DROP INDEX ardud_shell_project_threads_idx`;
      yield* sql`DROP INDEX ardud_shell_activity_run_idx`;
      yield* sql`DROP INDEX ardud_shell_executed_run_idx`;
      assert.deepEqual(yield* projection.getShellSnapshot({ location: "active" }), activeBefore);
      assert.deepEqual(yield* projection.getShellSnapshot({ location: "archive" }), archiveBefore);
      assert.deepEqual(
        yield* projection.getThreadListCandidates(projectId, { limit: 1000 }),
        candidatesBefore,
      );
      yield* sql.withTransaction(Migration0068);
      yield* Deferred.succeed(lookupMigration!, undefined);
      assert.deepEqual(
        yield* projection.getThreadListCandidates(projectId, { limit: 1000 }),
        candidatesBefore,
      );
      const beforeStart = performance.now();
      const baseline = yield* projection.getShellSnapshot();
      const beforeMs = performance.now() - beforeStart;
      const statements: string[] = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (time, exit) => {
            end(time, exit);
            const query = span.attributes.get("db.query.text");
            if (typeof query === "string" && query.includes("WITH shell_runs"))
              statements.push(query);
          };
          return span;
        },
      });
      const afterStart = performance.now();
      const archive = yield* projection
        .getShellSnapshot({ location: "archive" })
        .pipe(Effect.withTracer(tracer));
      const archiveMs = performance.now() - afterStart;
      assert.deepEqual(archive.archivedThreads, baseline.archivedThreads);
      assert.lengthOf(archive.threads, 0);
      const candidatesStart = performance.now();
      const candidates = yield* projection
        .getThreadListCandidates(projectId, { limit: 1000 })
        .pipe(Effect.withTracer(tracer));
      const selected = candidates.toSorted((a, b) => b.id.localeCompare(a.id)).slice(0, 50);
      const page = yield* projection.getShellSnapshot({
        location: "active",
        threadIds: selected.map((c) => c.id),
      });
      const listMs = performance.now() - candidatesStart;
      const expectedById = new Map(baseline.threads.map((t) => [t.id, t]));
      assert.lengthOf(candidates, baseline.threads.length);
      for (const candidate of candidates) {
        const expected = expectedById.get(candidate.id)!;
        for (const key of Object.keys(candidate) as Array<keyof Projection.ThreadListCandidate>) {
          assert.deepEqual(candidate[key], expected[key], `${candidate.id}.${key}`);
        }
      }
      for (const shell of page.threads) assert.deepEqual(shell, expectedById.get(shell.id));
      assert.lengthOf(page.threads, 50);
      // One bounded candidate page; only the result page reads counts.
      assert.lengthOf(statements, 2);
      for (const candidateQuery of statements.slice(1)) {
        assert.include(candidateQuery, "INDEXED BY ardud_mcp_project_recency_idx");
        assert.include(candidateQuery, "0 AS item_count");
        assert.include(candidateQuery, "LIMIT ?");
      }
      for (const statement of statements) {
        const plan = yield* sql.unsafe<{ parent: number; detail: string }>(
          `EXPLAIN QUERY PLAN ${statement}`,
          Array.from({ length: (statement.match(/\?/g) ?? []).length }, () => null),
        );
        const details = plan.map((row) => row.detail).join("\n");
        assert.notMatch(
          details,
          /MATERIALIZE shell_runs|SCAN orchestration_v2_projection_runs/,
          details,
        );
        assert.match(details, /SEARCH .*USING INDEX ardud_shell_executed_run_idx/, details);
        assert.match(details, /SEARCH .*USING INDEX ardud_shell_activity_run_idx/, details);
        if (statement !== statements[0]) {
          assert.match(details, /SEARCH .*USING INDEX ardud_mcp_project_recency_idx/, details);
          assert.isFalse(
            plan.some((row) => row.parent === 0 && /USE TEMP B-TREE/.test(row.detail)),
            details,
          );
        }
      }
      yield* sql`UPDATE orchestration_v2_projection_threads SET title = CASE
        WHEN CAST(substr(thread_id, 6) AS INTEGER) % 2 = 0 THEN 'Case exit' ELSE 'Other' END`;
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.title', title)`;
      const boundedStatements: string[] = [];
      const boundedTracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (time, exit) => {
            end(time, exit);
            const query = span.attributes.get("db.query.text");
            if (typeof query === "string" && query.includes("WITH shell_runs"))
              boundedStatements.push(query);
          };
          return span;
        },
      });
      const bounded = yield* projection
        .getThreadListCandidates(projectId, { limit: 6, titleContains: "case EXIT" })
        .pipe(Effect.withTracer(boundedTracer));
      assert.deepEqual(
        bounded.map((t) => t.id),
        [998, 996, 994, 992, 990, 988].map((i) => `seed-${i}`),
      );
      assert.lengthOf(boundedStatements, 1);
      assert.include(boundedStatements[0]!, "instr(lower(t.title)");
      const last = bounded.at(-1)!;
      boundedStatements.length = 0;
      const second = yield* projection
        .getThreadListCandidates(projectId, {
          limit: 6,
          titleContains: "case exit",
          after: { updatedAtMs: DateTime.toEpochMillis(last.updatedAt), threadId: last.id },
        })
        .pipe(Effect.withTracer(boundedTracer));
      assert.lengthOf(boundedStatements, 1);
      const sameTimePlan = yield* sql.unsafe<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${boundedStatements[0]!}`,
        Array.from({ length: (boundedStatements[0]!.match(/\?/g) ?? []).length }, () => null),
      );
      assert.match(
        sameTimePlan.map((row) => row.detail).join("\n"),
        /ardud_mcp_project_recency_idx.*project_id=\? AND <expr>=\? AND thread_id<\?/,
      );
      assert.deepEqual(
        second.map((t) => t.id),
        [986, 984, 982, 980, 978, 976].map((i) => `seed-${i}`),
      );
      // Exercise the older-time continuation too, including equal-time ids and
      // timestamp encodings that represent the same millisecond.
      yield* sql`UPDATE orchestration_v2_projection_threads SET updated_at = CASE
        WHEN thread_id >= 'seed-900' THEN '2026-01-02T00:00:00Z' ELSE '2026-01-01T00:00:00.000Z' END,
        payload_json = json_set(payload_json, '$.updatedAt', CASE
          WHEN thread_id >= 'seed-900' THEN '2026-01-02T00:00:00Z' ELSE '2026-01-01T00:00:00.000Z' END)`;
      boundedStatements.length = 0;
      const crossing = yield* projection
        .getThreadListCandidates(projectId, {
          limit: 6,
          titleContains: "case exit",
          after: {
            updatedAtMs: DateTime.toEpochMillis(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z")),
            threadId: "seed-902",
          },
        })
        .pipe(Effect.withTracer(boundedTracer));
      assert.deepEqual(
        crossing.map((t) => t.id),
        [900, 898, 896, 894, 892, 890].map((i) => `seed-${i}`),
      );
      assert.lengthOf(boundedStatements, 2);
      const olderPlan = yield* sql.unsafe<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${boundedStatements[1]!}`,
        Array.from({ length: (boundedStatements[1]!.match(/\?/g) ?? []).length }, () => null),
      );
      assert.match(
        olderPlan.map((row) => row.detail).join("\n"),
        /ardud_mcp_project_recency_idx.*project_id=\? AND <expr><\?/,
      );
      // SQLite's ASCII lower() must not drop locale-aware matches or treat LIKE
      // metacharacters as wildcards. SQL returns Unicode candidates for JS to check.
      yield* sql`UPDATE orchestration_v2_projection_threads SET title = 'ÉTAPE 100%_done',
        payload_json = json_set(payload_json, '$.title', 'ÉTAPE 100%_done') WHERE thread_id = 'seed-998'`;
      const unicode = yield* projection.getThreadListCandidates(projectId, {
        limit: 6,
        titleContains: "étape",
      });
      assert.deepEqual(
        unicode.map((t) => t.id),
        ["seed-998"],
      );
      const literal = yield* projection.getThreadListCandidates(projectId, {
        limit: 6,
        titleContains: "100%_done",
      });
      assert.deepEqual(
        literal.map((t) => t.id),
        ["seed-998"],
      );
      const archiveQuery = statements[0]!;
      const bindings = Array.from({ length: (archiveQuery.match(/\?/g) ?? []).length }, () => null);
      const beforeSqlStart = performance.now();
      const oldRows = yield* sql.unsafe(
        archiveQuery.replace("AS NOT MATERIALIZED", "AS MATERIALIZED"),
        bindings,
      );
      const beforeSqlMs = performance.now() - beforeSqlStart;
      const afterSqlStart = performance.now();
      const newRows = yield* sql.unsafe(archiveQuery, bindings);
      const afterSqlMs = performance.now() - afterSqlStart;
      assert.deepEqual(newRows, oldRows);
      console.log(
        JSON.stringify({
          fixtureThreads: 1001,
          fixtureRuns: 100100,
          beforeMs,
          archiveMs,
          listMs,
          beforeSqlMs,
          afterSqlMs,
        }),
      );
    }).pipe(
      Effect.provide(
        Layer.unwrap(
          Effect.gen(function* () {
            const ready = yield* Deferred.make<void>();
            return layer.pipe(Layer.provideMerge(Layer.succeed(ShellRunLookupMigration, ready)));
          }),
        ),
      ),
    ),
);
